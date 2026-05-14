const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getDb } = require('../db/schema');

// ── Role hierarchy (higher index = more authority) ──────────────────────────
const ROLE_HIERARCHY = {
  contractor: 0,
  project_manager: 1,
  operations_manager: 2,
  super_admin: 3,
};

const PROJECT_MANAGE_ROLES = ['super_admin', 'operations_manager', 'project_manager'];
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
    req.user = user;
    req.token = token;
    req.auth = { type: 'jwt' };
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
  authorizeOverUser,
  authorizeProjectAccess,
  blacklistToken,
  ROLE_HIERARCHY,
  PROJECT_MANAGE_ROLES,
  USER_MANAGE_ROLES,
};
