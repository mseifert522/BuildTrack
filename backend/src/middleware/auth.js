const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { getClientIp } = require('../utils/requestIp');
const {
  DESKTOP_SESSION_IDLE_TIMEOUT_MINUTES,
  DESKTOP_SESSION_IDLE_TIMEOUT_MS,
  parseSqliteDateTime,
  revokeSession,
  sessionExpiryPolicy,
} = require('../utils/sessionPolicy');

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

function isLegacyDesktopTokenExpired(decoded, user) {
  if (user?.role === 'contractor' || decoded?.st === 'mobile_app') return false;
  if (!decoded?.iat) return false;
  return decoded.iat * 1000 + DESKTOP_SESSION_IDLE_TIMEOUT_MS <= Date.now();
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

  recordSessionIpChange(db, userId, sessionId, session.session_type, previousCurrentIp, currentIp, req);
  return session;
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
        return res.status(401).json({ error: session.expiry_message || `Desktop session expired after ${DESKTOP_SESSION_IDLE_TIMEOUT_MINUTES} minutes of inactivity. Please log in again.` });
      }
      if (!session || session.revoked_at) {
        tokenBlacklist.add(token);
        return res.status(401).json({ error: 'Session terminated by security. Please log in again.' });
      }
    } else if (isLegacyDesktopTokenExpired(decoded, user)) {
      tokenBlacklist.add(token);
      return res.status(401).json({ error: `Desktop session expired after ${DESKTOP_SESSION_IDLE_TIMEOUT_MINUTES} minutes of inactivity. Please log in again.` });
    }
    req.user = user;
    req.token = token;
    req.auth = {
      type: 'jwt',
      session_id: decoded.sid || null,
      session_type: session?.session_type || decoded.st || null,
      issued_at: decoded.iat || null,
    };
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
