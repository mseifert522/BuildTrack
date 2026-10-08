'use strict';
// AI agent principal for the regular /api routes.
//
// An agent registered in agent_bridge_agents with the `admin:read` scope and an
// `acts_as_user_id` can call the same API the BuildTrack UI uses, as that linked
// user, so it sees exactly what that user sees. It never gets a session: every
// request carries X-BuildTrack-Agent-Key + X-BuildTrack-Agent-Name, the key is
// checked against its HMAC hash, and the request is written to
// agent_bridge_request_logs.
//
// The agent is read-only except for ALLOWED_WRITES, each behind its own scope.
// The linked user is created inactive, so it can never sign in by password, PIN
// or reset link: is_active = 1 is required by every interactive login path.
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { getClientIp } = require('../utils/requestIp');
const {
  hashAgentKey,
  safeJsonParse,
  sanitizeText,
  timingSafeEqualHex,
  uniqueScopes,
} = require('../services/agentBridgeService');

const AGENT_KEY_HEADER = 'x-buildtrack-agent-key';
const READ_METHODS = new Set(['GET', 'HEAD']);

// Reads an agent must not make even with admin:read: sign-in/session endpoints,
// credentials (a user's login PIN, the HR AI provider key settings), managing
// agents (its own key and scopes), the long-lived notes stream, and the
// QuickBooks OAuth handshake, whose GETs start or finish a connection.
const DENIED_PATHS = [
  /^\/api\/auth(\/|$)/,
  /^\/api\/users\/[^/]+\/pin\/?$/,
  /^\/api\/human-resources\/ai-settings(\/|$)/,
  /^\/api\/agent-bridge\/admin(\/|$)/,
  /^\/api\/projects\/[^/]+\/notes\/stream\/?$/,
  /^\/api\/quickbooks\/connect-url\/?$/,
  /^\/api\/quickbooks\/oauth(\/|$)/,
];

const ALLOWED_WRITES = [
  { method: 'POST', pattern: /^\/api\/projects\/[^/]+\/notes\/?$/, scope: 'notes:write', intent: 'note_create' },
];

const rateBuckets = new Map();

function agentError(code, message, statusCode) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

function headerValue(req, name) {
  const value = req.headers[name];
  return String((Array.isArray(value) ? value[0] : value) || '').trim();
}

function hasAgentKey(req) {
  return Boolean(headerValue(req, AGENT_KEY_HEADER));
}

function requestPath(req) {
  return String(req.originalUrl || req.url || '').split('?')[0];
}

// Authenticates the agent and loads its linked user. No logging, no rate limit,
// no route policy: callers that serve data (authenticateAgentRequest, the
// /uploads gate) add those themselves. Throws an agentError on any failure.
function resolveAgentPrincipal(req) {
  const rawKey = headerValue(req, AGENT_KEY_HEADER);
  if (!rawKey) throw agentError('MISSING_AGENT_KEY', 'Agent API key is required.', 401);
  const agentName = sanitizeText(headerValue(req, 'x-buildtrack-agent-name'), 120);
  if (!agentName) throw agentError('MISSING_AGENT_NAME', 'X-BuildTrack-Agent-Name is required.', 400);

  const db = getDb();
  const agent = db.prepare('SELECT * FROM agent_bridge_agents WHERE lower(agent_name) = lower(?) LIMIT 1').get(agentName);
  if (!agent || !timingSafeEqualHex(hashAgentKey(rawKey), agent.api_key_hash)) {
    throw agentError('INVALID_AGENT_KEY', 'Invalid agent API key.', 401);
  }
  if (!agent.enabled) throw agentError('AGENT_DISABLED', 'This AI agent is disabled.', 403);

  const scopes = uniqueScopes(safeJsonParse(agent.allowed_scopes, []));
  if (!scopes.includes('admin:read')) {
    throw agentError('AGENT_SCOPE_DENIED', 'Agent does not have admin:read permission.', 403);
  }
  if (!agent.acts_as_user_id) {
    throw agentError('AGENT_USER_NOT_LINKED', 'This AI agent is not linked to a BuildTrack user.', 503);
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(agent.acts_as_user_id);
  if (!user) throw agentError('AGENT_USER_MISSING', 'The BuildTrack user linked to this AI agent no longer exists.', 503);

  return { agent, scopes, user };
}

function routePolicy(req, scopes) {
  const pathName = requestPath(req);
  if (DENIED_PATHS.some(pattern => pattern.test(pathName))) {
    throw agentError('AGENT_PATH_DENIED', 'AI agents cannot use this endpoint.', 403);
  }
  if (READ_METHODS.has(req.method)) return { intent: 'api_read', write: false };
  const write = ALLOWED_WRITES.find(rule => rule.method === req.method && rule.pattern.test(pathName));
  if (!write) throw agentError('AGENT_READ_ONLY', 'AI agents can read BuildTrack but cannot make this change.', 403);
  if (!scopes.includes(write.scope)) {
    throw agentError('AGENT_SCOPE_DENIED', `Agent does not have ${write.scope} permission.`, 403);
  }
  return { intent: write.intent, write: true };
}

function checkRateLimit(req, agent) {
  const max = Number.parseInt(process.env.AGENT_API_RATE_LIMIT_MAX || '120', 10);
  const windowMs = Number.parseInt(process.env.AGENT_API_RATE_LIMIT_WINDOW_MS || '60000', 10);
  if (!Number.isFinite(max) || max <= 0) return;
  const now = Date.now();
  const key = `${agent.id}:${getClientIp(req) || 'unknown'}`;
  const fresh = (rateBuckets.get(key) || []).filter(ts => now - ts < windowMs);
  if (fresh.length >= max) throw agentError('RATE_LIMITED', 'Agent API rate limit exceeded.', 429);
  fresh.push(now);
  rateBuckets.set(key, fresh);
}

// Writes keep the caller's X-Request-Id so a retried note is refused as a
// duplicate (UNIQUE(agent_id, request_id)) instead of posted twice. Reads get a
// suffix: the same id may legitimately be reused across several reads.
function logRequest(req, res, { agent, policy }) {
  const db = getDb();
  const provided = sanitizeText(headerValue(req, 'x-request-id'), 160);
  if (policy.write && !provided) {
    throw agentError('MISSING_REQUEST_ID', 'X-Request-Id is required for changes.', 400);
  }
  const requestId = policy.write ? provided : `${provided || 'read'}:${uuidv4()}`;
  const logId = uuidv4();
  const pathName = requestPath(req);
  const projectMatch = pathName.match(/^\/api\/projects\/([^/]+)/);
  const payload = policy.write ? { body: req.body || null } : { query: req.query || null };
  try {
    db.prepare(`
      INSERT INTO agent_bridge_request_logs (
        id, request_id, agent_id, agent_name, source, intent, property_id,
        endpoint, status, success, sanitized_payload, ip_address, user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processing', 0, ?, ?, ?)
    `).run(
      logId,
      requestId,
      agent.id,
      agent.agent_name,
      sanitizeText(headerValue(req, 'x-buildtrack-agent-source'), 80) || 'agent_api',
      policy.intent,
      null,
      `${req.method} ${String(req.originalUrl || '').slice(0, 900)}`,
      JSON.stringify(payload).slice(0, 8000),
      getClientIp(req),
      headerValue(req, 'user-agent').slice(0, 300)
    );
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      throw agentError('DUPLICATE_REQUEST_ID', 'Duplicate requestId rejected. This change was already made.', 409);
    }
    throw err;
  }
  // property_id has a foreign key to projects; set it only for a real project so
  // a mistyped id in the URL cannot fail the audit insert.
  if (projectMatch) {
    try {
      db.prepare(`
        UPDATE agent_bridge_request_logs SET property_id = ?
        WHERE id = ? AND EXISTS (SELECT 1 FROM projects WHERE id = ?)
      `).run(projectMatch[1], logId, projectMatch[1]);
    } catch (_) { /* audit detail only */ }
  }
  db.prepare("UPDATE agent_bridge_agents SET last_used_at = datetime('now') WHERE id = ?").run(agent.id);

  res.on('finish', () => {
    try {
      const ok = res.statusCode < 400;
      getDb().prepare(`
        UPDATE agent_bridge_request_logs
        SET status = ?, success = ?, error_code = ?, completed_at = datetime('now')
        WHERE id = ?
      `).run(ok ? 'completed' : 'failed', ok ? 1 : 0, ok ? null : `HTTP_${res.statusCode}`, logId);
    } catch (_) { /* audit completion is best effort */ }
  });
  return requestId;
}

// A refused change or denied endpoint is recorded too, so the agent log shows
// what an agent tried as well as what it did.
function logDenied(req, agent, err) {
  try {
    getDb().prepare(`
      INSERT INTO agent_bridge_request_logs (
        id, request_id, agent_id, agent_name, source, intent, endpoint, status, success,
        error_code, error_message, ip_address, user_agent, completed_at
      ) VALUES (?, ?, ?, ?, ?, 'denied', ?, 'failed', 0, ?, ?, ?, ?, datetime('now'))
    `).run(
      uuidv4(),
      `denied:${uuidv4()}`,
      agent.id,
      agent.agent_name,
      sanitizeText(headerValue(req, 'x-buildtrack-agent-source'), 80) || 'agent_api',
      `${req.method} ${String(req.originalUrl || '').slice(0, 900)}`,
      err.code || 'AGENT_DENIED',
      err.message || null,
      getClientIp(req),
      headerValue(req, 'user-agent').slice(0, 300)
    );
  } catch (_) { /* the refusal stands even if the audit row fails */ }
}

// Called first by authenticate(). Returns false when the request carries no agent
// key (normal session auth continues). Otherwise either sets req.user and returns
// true, or throws an agentError: an agent request never falls through to other auth.
function authenticateAgentRequest(req, res) {
  if (!hasAgentKey(req)) return false;
  // Nested routers (e.g. /api/projects then /api/projects/:id/notes) each run
  // authenticate(); the first pass already authorized and logged this request.
  if (req.auth?.type === 'agent') return true;

  const { agent, scopes, user } = resolveAgentPrincipal(req);
  let policy;
  try {
    policy = routePolicy(req, scopes);
  } catch (err) {
    logDenied(req, agent, err);
    throw err;
  }
  checkRateLimit(req, agent);
  const requestId = logRequest(req, res, { agent, policy });

  req.user = user;
  req.token = null;
  req.auth = {
    type: 'agent',
    agent_id: agent.id,
    agent_name: agent.agent_name,
    scopes,
    request_id: requestId,
  };
  return true;
}

module.exports = {
  AGENT_KEY_HEADER,
  authenticateAgentRequest,
  hasAgentKey,
  resolveAgentPrincipal,
  // exported for tests
  _rateBuckets: rateBuckets,
};
