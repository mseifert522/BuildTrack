const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const AGENT_SCOPES = [
  'property:read',
  'scope_of_work:write',
  'punch_list:write',
  'agent_logs:read',
  'admin:manage_agents',
];

const SCOPE_ITEM_STATUSES = ['not_started', 'in_progress', 'waiting_materials', 'needs_review', 'completed'];
const PUNCH_ITEM_STATUSES = ['not_started', 'in_progress', 'waiting_materials', 'needs_review', 'completed'];
const PUNCH_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

const STREET_SUFFIXES = {
  st: 'street',
  street: 'street',
  rd: 'road',
  road: 'road',
  ave: 'avenue',
  av: 'avenue',
  avenue: 'avenue',
  blvd: 'boulevard',
  boulevard: 'boulevard',
  dr: 'drive',
  drive: 'drive',
  ct: 'court',
  court: 'court',
  ln: 'lane',
  lane: 'lane',
};

function safeJsonParse(value, fallback) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function uniqueScopes(values) {
  const scopes = Array.isArray(values) ? values : [];
  return [...new Set(scopes.map(value => String(value || '').trim()).filter(value => AGENT_SCOPES.includes(value)))];
}

function hashAgentKey(key) {
  const secret = process.env.AGENT_BRIDGE_KEY_PEPPER || process.env.JWT_SECRET || 'buildtrack-agent-bridge';
  return crypto.createHmac('sha256', secret).update(String(key || '')).digest('hex');
}

function generateAgentKey() {
  return `bt_agent_${crypto.randomBytes(32).toString('base64url')}`;
}

function timingSafeEqualHex(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
  } catch (_) {
    return false;
  }
}

function sanitizeText(value, maxLength = 2000) {
  const text = String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, maxLength);
}

function normalizeStatus(value, allowed, fallback) {
  const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (normalized === 'open') return fallback;
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizePunchPriority(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'normal') return 'medium';
  if (normalized === 'critical') return 'urgent';
  return PUNCH_PRIORITIES.includes(normalized) ? normalized : 'medium';
}

function normalizeScopePriority(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['low', 'normal', 'high', 'critical', 'urgent'].includes(normalized) ? normalized : 'normal';
}

function toMoney(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function cleanItem(raw, type) {
  const description = sanitizeText(raw?.description || raw?.title || '', 1000);
  if (!description) return null;
  if (type === 'punch_list') {
    return {
      description,
      location: sanitizeText(raw?.location || '', 200) || null,
      trade: sanitizeText(raw?.trade || '', 200) || null,
      priority: normalizePunchPriority(raw?.priority),
      assignedTo: sanitizeText(raw?.assignedTo || raw?.assigned_to || '', 200) || null,
      dueDate: sanitizeText(raw?.dueDate || raw?.due_date || '', 40) || null,
      status: normalizeStatus(raw?.status, PUNCH_ITEM_STATUSES, 'not_started'),
      notes: sanitizeText(raw?.notes || '', 2000) || null,
    };
  }

  return {
    description,
    category: sanitizeText(raw?.category || 'General', 200) || 'General',
    trade: sanitizeText(raw?.trade || '', 200) || null,
    location: sanitizeText(raw?.location || '', 200) || null,
    priority: normalizeScopePriority(raw?.priority),
    estimatedCost: toMoney(raw?.estimatedCost ?? raw?.estimated_cost),
    laborCost: toMoney(raw?.laborCost ?? raw?.labor_cost),
    materialCost: toMoney(raw?.materialCost ?? raw?.material_cost),
    assignedTo: sanitizeText(raw?.assignedTo || raw?.assigned_to || '', 200) || null,
    dueDate: sanitizeText(raw?.dueDate || raw?.due_date || '', 40) || null,
    status: normalizeStatus(raw?.status, SCOPE_ITEM_STATUSES, 'not_started'),
    notes: sanitizeText(raw?.notes || '', 2000) || null,
  };
}

function fallbackParseItems(rawTranscript) {
  const text = String(rawTranscript || '').trim();
  if (!text) return [];
  const afterColon = text.includes(':') ? text.slice(text.indexOf(':') + 1) : text;
  return afterColon
    .replace(/\r/g, '\n')
    .split(/\n+|(?:^|\s)(?:\d+[\.)]\s+)|[;\u2022]+|,(?=\s*[a-zA-Z])/g)
    .map(part => sanitizeText(part, 1000))
    .filter(Boolean)
    .filter(part => !/^(scope of work|punch list|create|new scope|sow)\b/i.test(part))
    .map(description => ({ description }));
}

function normalizeBridgePayload(payload, expectedIntent) {
  const intent = sanitizeText(payload?.intent || expectedIntent, 80).toLowerCase();
  if (expectedIntent && intent !== expectedIntent) {
    const err = new Error(`Intent must be ${expectedIntent}`);
    err.code = 'INVALID_INTENT';
    err.statusCode = 400;
    throw err;
  }

  const rawItems = Array.isArray(payload?.items) && payload.items.length
    ? payload.items
    : fallbackParseItems(payload?.rawTranscript);
  const items = rawItems.map(item => cleanItem(item, intent)).filter(Boolean);

  return {
    requestId: sanitizeText(payload?.requestId, 180),
    agentName: sanitizeText(payload?.agentName, 120),
    source: sanitizeText(payload?.source || 'telegram', 80) || 'telegram',
    intent,
    propertyId: sanitizeText(payload?.propertyId, 180) || null,
    propertyAddress: sanitizeText(payload?.propertyAddress, 500) || null,
    rawTranscript: sanitizeText(payload?.rawTranscript, 6000) || null,
    title: sanitizeText(payload?.title, 300) || (intent === 'punch_list' ? 'AI Generated Punch List' : 'AI Generated Scope of Work'),
    items,
  };
}

function tokenizeAddress(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map(token => STREET_SUFFIXES[token] || token)
    .filter(Boolean)
    .filter(token => !['usa', 'us'].includes(token));
}

function normalizedAddress(value, options = {}) {
  const tokens = tokenizeAddress(value)
    .filter(token => !(options.dropZip && /^\d{5}(?:\d{4})?$/.test(token)));
  return tokens.join(' ');
}

function cityToken(value) {
  const parts = String(value || '').split(',').map(part => normalizedAddress(part, { dropZip: true })).filter(Boolean);
  return parts.length >= 2 ? parts[1] : '';
}

function streetOnlyCandidate(value) {
  if (String(value || '').includes(',')) return '';
  const tokens = tokenizeAddress(value).filter(token => !/^\d{5}(?:\d{4})?$/.test(token));
  if (tokens.length < 2 || tokens.length > 5) return '';
  return tokens.join(' ');
}

function similarityScore(left, right) {
  const leftTokens = new Set(tokenizeAddress(left));
  const rightTokens = new Set(tokenizeAddress(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  leftTokens.forEach(token => {
    if (rightTokens.has(token)) overlap += 1;
  });
  return (2 * overlap) / (leftTokens.size + rightTokens.size);
}

function formatProjectMatch(project) {
  return {
    propertyId: project.id,
    address: project.address,
    jobName: project.job_name || null,
  };
}

function resolveProperty(db, { propertyId, propertyAddress }) {
  if (propertyId) {
    const project = db.prepare('SELECT id, address, job_name FROM projects WHERE id = ? AND status != ?').get(propertyId, 'archived');
    if (!project) {
      const err = new Error('Property ID does not exist in BuildTrack.');
      err.code = 'PROPERTY_NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }
    return { project, matches: [formatProjectMatch(project)] };
  }

  if (!propertyAddress) {
    const err = new Error('Property address is required before BuildTrack can create this record.');
    err.code = 'MISSING_PROPERTY_ADDRESS';
    err.statusCode = 400;
    throw err;
  }

  const projects = db.prepare(`
    SELECT id, address, job_name
    FROM projects
    WHERE status != 'archived'
    ORDER BY updated_at DESC
  `).all();
  const inputFull = normalizedAddress(propertyAddress);
  const inputNoZip = normalizedAddress(propertyAddress, { dropZip: true });
  const inputCity = cityToken(propertyAddress);
  const streetOnly = streetOnlyCandidate(propertyAddress);

  const exact = projects.filter(project => (
    normalizedAddress(project.address) === inputFull
    || normalizedAddress(project.address, { dropZip: true }) === inputNoZip
  ));
  if (exact.length === 1) return { project: exact[0], matches: exact.map(formatProjectMatch) };
  if (exact.length > 1) {
    const err = new Error('Multiple BuildTrack properties match this address. Please clarify.');
    err.code = 'AMBIGUOUS_PROPERTY_MATCH';
    err.statusCode = 409;
    err.matches = exact.map(formatProjectMatch);
    throw err;
  }

  if (streetOnly) {
    const streetMatches = projects.filter(project => normalizedAddress(project.address, { dropZip: true }).startsWith(streetOnly));
    if (streetMatches.length === 1) return { project: streetMatches[0], matches: streetMatches.map(formatProjectMatch) };
    if (streetMatches.length > 1) {
      const err = new Error('Multiple BuildTrack properties match this address. Please clarify.');
      err.code = 'AMBIGUOUS_PROPERTY_MATCH';
      err.statusCode = 409;
      err.matches = streetMatches.slice(0, 5).map(formatProjectMatch);
      throw err;
    }
  }

  if (inputCity) {
    const cityMatches = projects.filter(project => {
      const projectNoZip = normalizedAddress(project.address, { dropZip: true });
      return projectNoZip.includes(inputNoZip.split(' ').slice(0, 4).join(' ')) && projectNoZip.includes(inputCity);
    });
    if (cityMatches.length === 1) return { project: cityMatches[0], matches: cityMatches.map(formatProjectMatch) };
    if (cityMatches.length > 1) {
      const err = new Error('Multiple BuildTrack properties match this address. Please clarify.');
      err.code = 'AMBIGUOUS_PROPERTY_MATCH';
      err.statusCode = 409;
      err.matches = cityMatches.map(formatProjectMatch);
      throw err;
    }
  }

  const fuzzy = projects
    .map(project => ({ project, score: similarityScore(inputNoZip, normalizedAddress(project.address, { dropZip: true })) }))
    .filter(row => row.score >= 0.82)
    .sort((a, b) => b.score - a.score);

  if (fuzzy.length === 1 || (fuzzy.length > 1 && fuzzy[0].score - fuzzy[1].score >= 0.08)) {
    return { project: fuzzy[0].project, matches: [formatProjectMatch(fuzzy[0].project)] };
  }
  if (fuzzy.length > 1) {
    const err = new Error('Multiple BuildTrack properties match this address. Please clarify.');
    err.code = 'AMBIGUOUS_PROPERTY_MATCH';
    err.statusCode = 409;
    err.matches = fuzzy.slice(0, 5).map(row => formatProjectMatch(row.project));
    throw err;
  }

  const err = new Error('Property does not exist in BuildTrack.');
  err.code = 'PROPERTY_NOT_FOUND';
  err.statusCode = 404;
  throw err;
}

function resolveAgentActorUserId(db, agent) {
  const preferred = agent?.created_by_user_id || process.env.AGENT_BRIDGE_SYSTEM_USER_ID;
  if (preferred) {
    const user = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(preferred);
    if (user) return user.id;
  }
  const fallback = db.prepare(`
    SELECT id
    FROM users
    WHERE is_active = 1 AND role IN ('super_admin','operations_manager')
    ORDER BY role = 'super_admin' DESC, created_at ASC
    LIMIT 1
  `).get();
  if (fallback) return fallback.id;
  const err = new Error('No active BuildTrack management user is available for agent-created records.');
  err.code = 'AGENT_ACTOR_UNAVAILABLE';
  err.statusCode = 503;
  throw err;
}

function publicAgent(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentName: row.agent_name,
    enabled: Boolean(row.enabled),
    allowedScopes: uniqueScopes(safeJsonParse(row.allowed_scopes, [])),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    createdByUserId: row.created_by_user_id || null,
    notes: row.notes || '',
  };
}

module.exports = {
  AGENT_SCOPES,
  fallbackParseItems,
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
};
