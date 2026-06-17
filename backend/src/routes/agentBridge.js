const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate, authorizeUpperManagement } = require('../middleware/auth');
const { getClientIp } = require('../utils/requestIp');
const {
  AGENT_SCOPES,
  formatProjectMatch,
  generateAgentKey,
  hashAgentKey,
  normalizeBridgePayload,
  publicAgent,
  resolveAgentActorUserId,
  resolveProperty,
  safeJsonParse,
  sanitizeText,
  timingSafeEqualHex,
  uniqueScopes,
} = require('../services/agentBridgeService');

const router = express.Router();
const rateBuckets = new Map();

function agentError(code, message, statusCode = 400, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function extractAgentKey(req) {
  const headerKey = req.headers['x-buildtrack-agent-key'];
  if (Array.isArray(headerKey) && headerKey[0]) return String(headerKey[0]).trim();
  if (headerKey) return String(headerKey).trim();
  const auth = String(req.headers.authorization || '');
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice('bearer '.length).trim() : '';
}

function requireAgentHeaders(req) {
  const agentName = sanitizeText(req.headers['x-buildtrack-agent-name'], 120);
  const requestId = sanitizeText(req.headers['x-request-id'] || req.body?.requestId || req.query?.requestId, 180);
  if (!agentName) throw agentError('MISSING_AGENT_NAME', 'X-BuildTrack-Agent-Name is required.', 400);
  if (!requestId) throw agentError('MISSING_REQUEST_ID', 'X-Request-Id is required.', 400);
  return { agentName, requestId };
}

function agentScopes(agent) {
  return uniqueScopes(safeJsonParse(agent.allowed_scopes, []));
}

function authenticateAgent(req) {
  const { agentName, requestId } = requireAgentHeaders(req);
  const rawKey = extractAgentKey(req);
  if (!rawKey) throw agentError('MISSING_AGENT_KEY', 'Agent API key is required.', 401);

  const db = getDb();
  const agent = db.prepare('SELECT * FROM agent_bridge_agents WHERE lower(agent_name) = lower(?) LIMIT 1').get(agentName);
  if (!agent || !timingSafeEqualHex(hashAgentKey(rawKey), agent.api_key_hash)) {
    throw agentError('INVALID_AGENT_KEY', 'Invalid agent API key.', 401);
  }
  if (!agent.enabled) throw agentError('AGENT_DISABLED', 'This AI agent is disabled.', 403);
  return { agent, requestId, scopes: agentScopes(agent) };
}

function requireScope(context, scope) {
  if (!context.scopes.includes(scope)) {
    throw agentError('AGENT_SCOPE_DENIED', `Agent does not have ${scope} permission.`, 403);
  }
}

function checkRateLimit(req, agent) {
  const max = Number.parseInt(process.env.AGENT_BRIDGE_RATE_LIMIT_MAX || '60', 10);
  const windowMs = Number.parseInt(process.env.AGENT_BRIDGE_RATE_LIMIT_WINDOW_MS || '60000', 10);
  if (!Number.isFinite(max) || max <= 0) return;
  const now = Date.now();
  const key = `${agent.id}:${getClientIp(req) || 'unknown'}`;
  const bucket = rateBuckets.get(key) || [];
  const fresh = bucket.filter(ts => now - ts < windowMs);
  if (fresh.length >= max) throw agentError('RATE_LIMITED', 'Agent bridge rate limit exceeded.', 429);
  fresh.push(now);
  rateBuckets.set(key, fresh);
}

function writeInitialLog({ req, context, endpoint, intent, payload }) {
  const db = getDb();
  const id = uuidv4();
  try {
    db.prepare(`
      INSERT INTO agent_bridge_request_logs (
        id, request_id, agent_id, agent_name, source, intent, property_id, property_address,
        endpoint, status, success, raw_transcript, sanitized_payload, ip_address, user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', 0, ?, ?, ?, ?)
    `).run(
      id,
      context.requestId,
      context.agent.id,
      context.agent.agent_name,
      payload?.source || 'telegram',
      intent || payload?.intent || null,
      payload?.propertyId || null,
      payload?.propertyAddress || null,
      endpoint,
      payload?.rawTranscript || null,
      JSON.stringify(payload || {}),
      getClientIp(req),
      req.headers['user-agent'] || ''
    );
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      throw agentError('DUPLICATE_REQUEST_ID', 'Duplicate requestId rejected. This request was already processed or logged.', 409);
    }
    throw err;
  }
  return id;
}

function completeLog(logId, { success, status, errorCode = null, errorMessage = null, createdRecords = [] }) {
  const db = getDb();
  db.prepare(`
    UPDATE agent_bridge_request_logs
    SET status = ?, success = ?, error_code = ?, error_message = ?, completed_at = datetime('now')
    WHERE id = ?
  `).run(status, success ? 1 : 0, errorCode, errorMessage, logId);

  if (createdRecords.length) {
    const insert = db.prepare(`
      INSERT INTO agent_bridge_created_records (id, request_log_id, project_id, record_type, record_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    createdRecords.forEach(record => insert.run(uuidv4(), logId, record.projectId || null, record.recordType, record.recordId));
  }
}

function agentResponseError(res, err, logId = null) {
  const statusCode = err.statusCode || 500;
  if (logId) {
    try {
      completeLog(logId, {
        success: false,
        status: 'failed',
        errorCode: err.code || 'AGENT_BRIDGE_ERROR',
        errorMessage: err.message || 'Agent bridge request failed',
      });
    } catch (logErr) {
      console.error('Failed to update agent bridge log:', logErr.message);
    }
  }
  return res.status(statusCode).json({
    success: false,
    error: err.code || 'AGENT_BRIDGE_ERROR',
    message: err.message || 'Agent bridge request failed',
    ...(err.matches ? { matches: err.matches } : {}),
  });
}

function createPropertyActivity(db, { projectId, actorUserId, agentName, itemCount, intent, requestId, source }) {
  const action = intent === 'punch_list' ? 'agent_bridge_punch_list_created' : 'agent_bridge_scope_of_work_created';
  const entityType = intent === 'punch_list' ? 'punch_list_item' : 'project_scope';
  const noun = intent === 'punch_list' ? 'Punch List' : 'Scope of Work';
  db.prepare(`
    INSERT INTO activity_log (id, project_id, user_id, action, entity_type, entity_id, details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(),
    projectId,
    actorUserId,
    action,
    entityType,
    requestId,
    JSON.stringify({
      agent_name: agentName,
      source,
      request_id: requestId,
      count: itemCount,
      summary: `${agentName} created ${itemCount} ${noun} item${itemCount === 1 ? '' : 's'} from ${source}.`,
    })
  );
}

function createScopeOfWork(db, { payload, context, logId }) {
  if (!payload.propertyId && !payload.propertyAddress) {
    throw agentError('MISSING_PROPERTY_ADDRESS', 'Property address is required before BuildTrack can create this record.', 400);
  }
  if (!payload.items.length) throw agentError('MISSING_ITEMS', 'No scope or punch-list items were provided.', 400);

  const { project } = resolveProperty(db, payload);
  const actorUserId = resolveAgentActorUserId(db, context.agent);
  const createdRecords = [];

  const createRows = db.transaction(() => {
    const maxScopeOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max FROM project_scopes WHERE project_id = ?').get(project.id);
    const scopeId = uuidv4();
    const scopeBody = payload.items.map((item, index) => `${index + 1}. ${item.description}`).join('\n');
    db.prepare(`
      INSERT INTO project_scopes (
        id, project_id, section_name, scope_title, scope_of_work, status, sort_order, created_by,
        created_by_agent, source, raw_transcript, agent_request_id
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
    `).run(
      scopeId,
      project.id,
      'AI Agent',
      payload.title || 'AI Generated Scope of Work',
      scopeBody,
      maxScopeOrder.max + 1,
      actorUserId,
      context.agent.agent_name,
      payload.source,
      payload.rawTranscript,
      context.requestId
    );
    createdRecords.push({ projectId: project.id, recordType: 'project_scope', recordId: scopeId });

    const maxPlanOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max FROM construction_plan_items WHERE project_id = ?').get(project.id);
    const insertItem = db.prepare(`
      INSERT INTO construction_plan_items (
        id, project_id, title, description, category, status, verification_status, invoice_status, project_scope_id,
        sort_order, assigned_to, target_date, created_by, trade, location, priority, estimated_cost, labor_cost,
        material_cost, notes, created_by_agent, source, raw_transcript, agent_request_id
      ) VALUES (?, ?, ?, ?, ?, ?, 'not_requested', 'not_received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    payload.items.forEach((item, index) => {
      const itemId = uuidv4();
      insertItem.run(
        itemId,
        project.id,
        item.description,
        item.notes || null,
        item.category || 'General',
        item.status || 'not_started',
        scopeId,
        maxPlanOrder.max + index + 1,
        item.assignedTo,
        item.dueDate,
        actorUserId,
        item.trade,
        item.location,
        item.priority || 'normal',
        item.estimatedCost,
        item.laborCost,
        item.materialCost,
        item.notes,
        context.agent.agent_name,
        payload.source,
        payload.rawTranscript,
        context.requestId
      );
      createdRecords.push({ projectId: project.id, recordType: 'construction_plan_item', recordId: itemId });
    });

    db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(project.id);
    createPropertyActivity(db, {
      projectId: project.id,
      actorUserId,
      agentName: context.agent.agent_name,
      itemCount: payload.items.length,
      intent: 'scope_of_work',
      requestId: context.requestId,
      source: payload.source,
    });
  });

  createRows();
  completeLog(logId, { success: true, status: 'completed', createdRecords });
  return {
    success: true,
    requestId: context.requestId,
    property: formatProjectMatch(project),
    created: {
      scopeCount: 1,
      scopeItemCount: payload.items.length,
      records: createdRecords,
    },
  };
}

function createPunchList(db, { payload, context, logId }) {
  if (!payload.propertyId && !payload.propertyAddress) {
    throw agentError('MISSING_PROPERTY_ADDRESS', 'Property address is required before BuildTrack can create this record.', 400);
  }
  if (!payload.items.length) throw agentError('MISSING_ITEMS', 'No scope or punch-list items were provided.', 400);

  const { project } = resolveProperty(db, payload);
  const actorUserId = resolveAgentActorUserId(db, context.agent);
  const createdRecords = [];

  const createRows = db.transaction(() => {
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max FROM punch_list_items WHERE project_id = ?').get(project.id);
    const insert = db.prepare(`
      INSERT INTO punch_list_items (
        id, project_id, title, description, status, priority, assigned_to, due_date, notes, sort_order, created_by,
        trade, location, created_by_agent, source, raw_transcript, agent_request_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    payload.items.forEach((item, index) => {
      const itemId = uuidv4();
      insert.run(
        itemId,
        project.id,
        item.description,
        item.notes || null,
        item.status || 'not_started',
        item.priority || 'medium',
        item.assignedTo,
        item.dueDate,
        item.notes,
        maxOrder.max + index + 1,
        actorUserId,
        item.trade,
        item.location,
        context.agent.agent_name,
        payload.source,
        payload.rawTranscript,
        context.requestId
      );
      createdRecords.push({ projectId: project.id, recordType: 'punch_list_item', recordId: itemId });
    });
    db.prepare("UPDATE projects SET punchlist_stage = 1, updated_at = datetime('now') WHERE id = ?").run(project.id);
    createPropertyActivity(db, {
      projectId: project.id,
      actorUserId,
      agentName: context.agent.agent_name,
      itemCount: payload.items.length,
      intent: 'punch_list',
      requestId: context.requestId,
      source: payload.source,
    });
  });

  createRows();
  completeLog(logId, { success: true, status: 'completed', createdRecords });
  return {
    success: true,
    requestId: context.requestId,
    property: formatProjectMatch(project),
    created: {
      punchItemCount: payload.items.length,
      records: createdRecords,
    },
  };
}

function agentEndpoint(scope, intent, handler) {
  return (req, res) => {
    let context;
    let logId = null;
    try {
      context = authenticateAgent(req);
      requireScope(context, scope);
      checkRateLimit(req, context.agent);
      const payload = normalizeBridgePayload({ ...req.body, requestId: context.requestId, agentName: context.agent.agent_name }, intent);
      logId = writeInitialLog({ req, context, endpoint: req.originalUrl, intent, payload });
      const db = getDb();
      db.prepare("UPDATE agent_bridge_agents SET last_used_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(context.agent.id);
      return res.status(201).json(handler(db, { payload, context, logId }));
    } catch (err) {
      return agentResponseError(res, err, logId);
    }
  };
}

router.get('/property-lookup', (req, res) => {
  let context;
  let logId = null;
  try {
    context = authenticateAgent(req);
    requireScope(context, 'property:read');
    checkRateLimit(req, context.agent);
    const payload = {
      requestId: context.requestId,
      source: sanitizeText(req.query.source || 'telegram', 80),
      intent: 'property_lookup',
      propertyAddress: sanitizeText(req.query.address, 500),
      propertyId: sanitizeText(req.query.propertyId, 180) || null,
    };
    logId = writeInitialLog({ req, context, endpoint: req.originalUrl, intent: 'property_lookup', payload });
    const db = getDb();
    const { project, matches } = resolveProperty(db, payload);
    db.prepare("UPDATE agent_bridge_agents SET last_used_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(context.agent.id);
    completeLog(logId, { success: true, status: 'completed' });
    return res.json({ success: true, requestId: context.requestId, property: formatProjectMatch(project), matches });
  } catch (err) {
    return agentResponseError(res, err, logId);
  }
});

router.post('/scope-of-work', agentEndpoint('scope_of_work:write', 'scope_of_work', createScopeOfWork));
router.post('/punch-list', agentEndpoint('punch_list:write', 'punch_list', createPunchList));
router.post('/intake', (req, res) => {
  const intent = String(req.body?.intent || '').trim();
  if (intent === 'scope_of_work') return agentEndpoint('scope_of_work:write', 'scope_of_work', createScopeOfWork)(req, res);
  if (intent === 'punch_list') return agentEndpoint('punch_list:write', 'punch_list', createPunchList)(req, res);
  return res.status(400).json({ success: false, error: 'INVALID_INTENT', message: 'intent must be scope_of_work or punch_list.' });
});

router.use('/admin', authenticate, authorizeUpperManagement);

router.get('/admin/agents', (req, res) => {
  const db = getDb();
  const agents = db.prepare(`
    SELECT *
    FROM agent_bridge_agents
    ORDER BY enabled DESC, lower(agent_name) ASC
  `).all().map(publicAgent);
  res.json({ agents, availableScopes: AGENT_SCOPES });
});

router.post('/admin/agents', (req, res) => {
  const agentName = sanitizeText(req.body?.agentName || req.body?.agent_name, 120);
  if (!agentName) return res.status(400).json({ error: 'Agent name is required' });
  const apiKey = generateAgentKey();
  const id = uuidv4();
  const allowedScopes = uniqueScopes(req.body?.allowedScopes || req.body?.allowed_scopes || ['property:read']);
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO agent_bridge_agents (id, agent_name, api_key_hash, enabled, allowed_scopes, created_by_user_id, notes)
      VALUES (?, ?, ?, 1, ?, ?, ?)
    `).run(id, agentName, hashAgentKey(apiKey), JSON.stringify(allowedScopes), req.user.id, sanitizeText(req.body?.notes, 2000) || null);
    const agent = db.prepare('SELECT * FROM agent_bridge_agents WHERE id = ?').get(id);
    res.status(201).json({ agent: publicAgent(agent), apiKey });
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) return res.status(409).json({ error: 'Agent name already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create agent' });
  }
});

router.put('/admin/agents/:id', (req, res) => {
  const db = getDb();
  const agent = db.prepare('SELECT * FROM agent_bridge_agents WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const enabled = req.body?.enabled === undefined ? agent.enabled : (req.body.enabled ? 1 : 0);
  const allowedScopes = req.body?.allowedScopes || req.body?.allowed_scopes
    ? uniqueScopes(req.body.allowedScopes || req.body.allowed_scopes)
    : agentScopes(agent);
  db.prepare(`
    UPDATE agent_bridge_agents
    SET agent_name = ?, enabled = ?, allowed_scopes = ?, notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    sanitizeText(req.body?.agentName || req.body?.agent_name || agent.agent_name, 120),
    enabled,
    JSON.stringify(allowedScopes),
    sanitizeText(req.body?.notes ?? agent.notes, 2000) || null,
    req.params.id
  );
  res.json({ agent: publicAgent(db.prepare('SELECT * FROM agent_bridge_agents WHERE id = ?').get(req.params.id)) });
});

router.post('/admin/agents/:id/rotate-key', (req, res) => {
  const db = getDb();
  const agent = db.prepare('SELECT * FROM agent_bridge_agents WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const apiKey = generateAgentKey();
  db.prepare("UPDATE agent_bridge_agents SET api_key_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hashAgentKey(apiKey), req.params.id);
  res.json({ agent: publicAgent(db.prepare('SELECT * FROM agent_bridge_agents WHERE id = ?').get(req.params.id)), apiKey });
});

router.get('/admin/logs', (req, res) => {
  const db = getDb();
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '100', 10) || 100, 1), 500);
  const logs = db.prepare(`
    SELECT l.*, a.enabled as agent_enabled
    FROM agent_bridge_request_logs l
    LEFT JOIN agent_bridge_agents a ON a.id = l.agent_id
    ORDER BY datetime(l.created_at) DESC, l.created_at DESC
    LIMIT ?
  `).all(limit).map(row => ({
    id: row.id,
    requestId: row.request_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    source: row.source,
    intent: row.intent,
    propertyId: row.property_id,
    propertyAddress: row.property_address,
    endpoint: row.endpoint,
    status: row.status,
    success: Boolean(row.success),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
  }));
  res.json({ logs });
});

router.get('/admin/openapi.json', (_req, res) => {
  res.json(require(path.resolve(__dirname, '../../../docs/buildtrack-agent-bridge.openapi.json')));
});

module.exports = router;
