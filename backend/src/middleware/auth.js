const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { getClientIp } = require('../utils/requestIp');
const {
  SESSION_IDLE_TIMEOUT_MINUTES,
  SESSION_IDLE_TIMEOUT_MS,
  parseSqliteDateTime,
  revokeSession,
  sessionExpiryPolicy,
} = require('../utils/sessionPolicy');
const { ensureUploadsCookie } = require('../utils/uploadsAccess');

// ── Role hierarchy (higher index = more authority) ──────────────────────────
const ROLE_HIERARCHY = {
  contractor: 0,
  project_manager: 1,
  operations_manager: 2,
  super_admin: 3,
};

const PROJECT_MANAGE_ROLES = ['super_admin', 'operations_manager', 'project_manager'];
const UPPER_MANAGEMENT_ROLES = ['super_admin', 'operations_manager'];
const USER_MANAGE_ROLES = ['super_admin', 'operations_manager'];
// In-memory JWT blacklist for instant lockout
const tokenBlacklist = new Set();
const CLIENT_ACTIVITY_GRACE_MS = 2 * 60 * 1000;
const PASSIVE_SESSION_PATHS = new Set([
  '/api/auth/heartbeat',
  '/api/auth/refresh',
  '/api/auth/me',
]);

function blacklistToken(token) {
  tokenBlacklist.add(token);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function timingSafeEqualHex(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
  } catch (_) {
    return false;
  }
}

function recordSessionIpChange(db, userId, sessionId, sessionType, previousIp, currentIp, req) {
  if (!previousIp || !currentIp || previousIp === currentIp) return;
  try {
    db.prepare(`
      INSERT INTO security_events (
        id, actor_user_id, target_user_id, action, reason, ip_address, user_agent, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      userId,
      userId,
      'session_ip_changed',
      'Session network IP changed',
      currentIp,
      req?.headers?.['user-agent'] || '',
      JSON.stringify({
        session_id: sessionId,
        session_type: sessionType,
        previous_ip: previousIp,
        current_ip: currentIp,
      })
    );
  } catch (err) {
    console.error('Failed to record session IP change:', err.message);
  }
}

function extractBearerToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return '';
  return authHeader.slice('Bearer '.length).trim();
}

function extractApiKey(req, bearerToken) {
  const headerKey = req.headers['x-api-key'] || req.headers['x-buildtrack-api-key'];
  if (Array.isArray(headerKey)) return headerKey[0] || '';
  return String(headerKey || bearerToken || '').trim();
}

function isTokenRevokedForUser(decoded, user) {
  const revokedAt = parseSqliteDateTime(user.session_revoked_at);
  if (!revokedAt || !decoded?.iat) return false;
  return decoded.iat * 1000 <= revokedAt;
}

function isLegacyTokenExpired(decoded) {
  if (!decoded?.iat) return false;
  return decoded.iat * 1000 + SESSION_IDLE_TIMEOUT_MS <= Date.now();
}

function hasRecentClientActivity(req, nowMs = Date.now()) {
  const rawValue = Array.isArray(req.headers['x-buildtrack-last-activity'])
    ? req.headers['x-buildtrack-last-activity'][0]
    : req.headers['x-buildtrack-last-activity'];
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;

  const activityMs = Number(rawValue);
  if (!Number.isFinite(activityMs)) return false;
  return activityMs <= nowMs + 60 * 1000 && activityMs >= nowMs - CLIENT_ACTIVITY_GRACE_MS;
}

function requestRepresentsUserActivity(req) {
  const clientActivity = hasRecentClientActivity(req);
  if (clientActivity !== null) return clientActivity;

  const path = String(req.originalUrl || req.url || '').split('?')[0];
  return !PASSIVE_SESSION_PATHS.has(path);
}

function touchSession(db, sessionId, userId, req) {
  if (!sessionId) return null;
  const session = db.prepare(`
    SELECT id, session_type, issued_at, last_seen_at, created_at, revoked_at, ip_address, current_ip_address
    FROM auth_sessions
    WHERE id = ? AND user_id = ?
    LIMIT 1
  `).get(sessionId, userId);
  if (!session || session.revoked_at) return session || { revoked_at: true };
  const expiry = sessionExpiryPolicy(session);
  if (expiry) {
    revokeSession(db, sessionId, userId, expiry.reason);
    return { ...session, revoked_at: true, expired_by_timeout: true, expiry_message: expiry.message };
  }
  if (!requestRepresentsUserActivity(req)) {
    return { ...session, activity_touched: false };
  }

  const currentIp = getClientIp(req);
  const previousCurrentIp = session.current_ip_address || session.ip_address || '';

  db.prepare(`
    UPDATE auth_sessions
    SET last_seen_at = datetime('now'),
        updated_at = datetime('now'),
        current_ip_address = CASE
          WHEN ? != '' THEN ?
          ELSE COALESCE(current_ip_address, ip_address)
        END,
        ip_address_updated_at = CASE
          WHEN ? != '' AND ? != COALESCE(current_ip_address, ip_address, '') THEN datetime('now')
          WHEN ip_address_updated_at IS NULL THEN datetime('now')
          ELSE ip_address_updated_at
        END
    WHERE id = ?
  `).run(currentIp, currentIp, currentIp, currentIp, sessionId);
  db.prepare(`
    UPDATE users
    SET last_seen_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(userId);

  recordSessionIpChange(db, userId, sessionId, session.session_type, previousCurrentIp, currentIp, req);
  return { ...session, activity_touched: true };
}

function authenticateApiKey(req, key) {
  const expectedHash = process.env.MAX_AI_API_KEY_HASH || '';
  if (!expectedHash || !key) return false;

  const providedHash = sha256(key);
  if (!timingSafeEqualHex(providedHash, expectedHash.trim())) return false;

  const db = getDb();
  const userId = process.env.MAX_AI_API_USER_ID || 'max-ai-executive-assistant';
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(userId);
  if (!user) {
    const err = new Error('Max AI API user is not active or does not exist');
    err.statusCode = 503;
    throw err;
  }

  req.user = user;
  req.token = null;
  req.auth = {
    type: 'api_key',
    key_id: process.env.MAX_AI_API_KEY_ID || 'max-ai-executive-assistant',
  };
  return true;
}

// Read-only twin of authenticate()'s JWT checks, for the /uploads gate. Same rules
// (active user, security logout, session row, idle expiry) but it never touches
// last_seen_at or writes rows: an <img> load is not user activity, and a page of
// thumbnails must not cost a write per image or keep an idle session alive.
function resolveSessionPrincipal({ userId, sid, iat }, { sessionToken = null } = {}) {
  if (!userId || !iat) return null;
  if (sessionToken && tokenBlacklist.has(sessionToken)) return null;
  const db = getDb();
  const user = db.prepare('SELECT id, role, is_active, session_revoked_at FROM users WHERE id = ? AND is_active = 1').get(userId);
  if (!user) return null;
  if (isTokenRevokedForUser({ iat }, user)) return null;
  if (sid) {
    const session = db.prepare(`
      SELECT id, session_type, issued_at, last_seen_at, created_at, revoked_at
      FROM auth_sessions WHERE id = ? AND user_id = ? LIMIT 1
    `).get(sid, user.id);
    if (!session || session.revoked_at || sessionExpiryPolicy(session)) return null;
  } else if (isLegacyTokenExpired({ iat })) {
    return null;
  }
  return { user, sessionId: sid || null };
}

function authenticate(req, res, next) {
  const bearerToken = extractBearerToken(req);
  const apiKey = extractApiKey(req, bearerToken);

  try {
    if (authenticateApiKey(req, apiKey)) return next();
  } catch (err) {
    return res.status(err.statusCode || 401).json({ error: err.message || 'Invalid API key' });
  }

  if (!bearerToken) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = bearerToken;

  if (tokenBlacklist.has(token)) {
    return res.status(401).json({ error: 'Session terminated. Please log in again.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(decoded.userId);
    if (!user) {
      tokenBlacklist.add(token);
      return res.status(401).json({ error: 'Account has been deactivated. Contact your administrator.' });
    }
    if (isTokenRevokedForUser(decoded, user)) {
      tokenBlacklist.add(token);
      return res.status(401).json({ error: 'Session terminated by security. Please log in again.' });
    }
    let session = null;
    if (decoded.sid) {
      session = touchSession(db, decoded.sid, user.id, req);
      if (session?.expired_by_timeout) {
        tokenBlacklist.add(token);
        return res.status(401).json({ error: session.expiry_message || `Session expired after ${SESSION_IDLE_TIMEOUT_MINUTES} minutes of inactivity. Please log in again.` });
      }
      if (!session || session.revoked_at) {
        tokenBlacklist.add(token);
        return res.status(401).json({ error: 'Session terminated by security. Please log in again.' });
      }
    } else if (isLegacyTokenExpired(decoded)) {
      tokenBlacklist.add(token);
      return res.status(401).json({ error: `Session expired after ${SESSION_IDLE_TIMEOUT_MINUTES} minutes of inactivity. Please log in again.` });
    }
    req.user = user;
    req.token = token;
    req.auth = {
      type: 'jwt',
      session_id: decoded.sid || null,
      session_type: session?.session_type || decoded.st || null,
      issued_at: decoded.iat || null,
      activity_touched: session?.activity_touched === true,
    };
    // Give the browser the httpOnly /uploads cookie (a separate, narrow token, not
    // this JWT). Issued only when missing or stale, and it never throws, so it
    // cannot fail the API call. Not on the API-key path above.
    ensureUploadsCookie(req, res, decoded);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions for this action' });
    }
    next();
  };
}

function authorizeUpperManagement(req, res, next) {
  if (!UPPER_MANAGEMENT_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Only operations managers and super admins can perform this action' });
  }
  next();
}

function blockProjectManagerMutation(req, res, next) {
  if (req.user?.role === 'project_manager') {
    return res.status(403).json({
      error: 'Project managers can add field information, but cannot change or delete existing BuildTrack records.',
    });
  }
  next();
}

function authorizeOverUser(actorRole, targetRole) {
  const actorLevel = ROLE_HIERARCHY[actorRole] ?? -1;
  const targetLevel = ROLE_HIERARCHY[targetRole] ?? -1;
  return actorLevel > targetLevel;
}

function authorizeProjectAccess(req, res, next) {
  const db = getDb();
  const projectId = req.params.projectId || req.params.id;
  const user = req.user;

  if (PROJECT_MANAGE_ROLES.includes(user.role)) return next();

  if (user.role === 'contractor') {
    const assignment = db.prepare(
      'SELECT id FROM project_assignments WHERE project_id = ? AND user_id = ?'
    ).get(projectId, user.id);
    if (!assignment) {
      return res.status(403).json({ error: 'Access denied: you are not assigned to this project' });
    }
  }
  next();
}

module.exports = {
  authenticate,
  // used by the /uploads gate (middleware/uploadsGate.js)
  extractBearerToken,
  extractApiKey,
  authenticateApiKey,
  resolveSessionPrincipal,
  authorize,
  authorizeUpperManagement,
  blockProjectManagerMutation,
  authorizeOverUser,
  authorizeProjectAccess,
  blacklistToken,
  ROLE_HIERARCHY,
  PROJECT_MANAGE_ROLES,
  UPPER_MANAGEMENT_ROLES,
  USER_MANAGE_ROLES,
};
