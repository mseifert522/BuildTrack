const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { getClientIp } = require('./requestIp');

const DETAIL_LIMIT = 8000;

function safeDetails(details) {
  if (!details) return null;
  try {
    const serialized = JSON.stringify(details);
    return serialized.length > DETAIL_LIMIT ? serialized.slice(0, DETAIL_LIMIT) : serialized;
  } catch (_) {
    return null;
  }
}

function logDataAccess(req, {
  action,
  accessType = 'view',
  entityType,
  entityId = null,
  projectId = null,
  recordCount = null,
  riskLevel = 'standard',
  route = null,
  method = null,
  details = null,
} = {}) {
  if (!req?.user?.id || !action || !entityType) return;

  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO data_access_events (
        id, user_id, action, access_type, entity_type, entity_id, project_id,
        record_count, risk_level, route, method, ip_address, user_agent, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      req.user.id,
      String(action).slice(0, 120),
      String(accessType || 'view').slice(0, 40),
      String(entityType).slice(0, 80),
      entityId ? String(entityId).slice(0, 120) : null,
      projectId ? String(projectId).slice(0, 120) : null,
      Number.isFinite(Number(recordCount)) ? Number(recordCount) : null,
      String(riskLevel || 'standard').slice(0, 40),
      String(route || req.originalUrl || req.url || '').slice(0, 500),
      String(method || req.method || '').slice(0, 12),
      getClientIp(req).slice(0, 80),
      String(req.headers['user-agent'] || '').slice(0, 1000),
      safeDetails(details)
    );
  } catch (err) {
    console.error('[DATA_ACCESS_AUDIT] Failed to record access event:', err?.message || err);
  }
}

module.exports = { getClientIp, logDataAccess };
