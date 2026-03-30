const jwt = require('jsonwebtoken');
const { getDb } = require('../db/schema');

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found or inactive' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

function authorizeProjectAccess(req, res, next) {
  const db = getDb();
  const projectId = req.params.projectId || req.params.id;
  const user = req.user;

  // Super admin, operations manager, admin assistant can access all projects
  if (['super_admin', 'operations_manager', 'admin_assistant'].includes(user.role)) {
    return next();
  }

  // Contractors can only access assigned projects
  if (user.role === 'contractor') {
    const assignment = db.prepare(
      'SELECT id FROM project_assignments WHERE project_id = ? AND user_id = ?'
    ).get(projectId, user.id);
    if (!assignment) {
      return res.status(403).json({ error: 'Access denied to this project' });
    }
  }

  next();
}

module.exports = { authenticate, authorize, authorizeProjectAccess };
