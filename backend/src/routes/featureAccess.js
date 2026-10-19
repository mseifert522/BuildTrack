const express = require('express');
const { getDb } = require('../db/schema');
const { authenticate, authorize } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { FEATURES, GRANT_MANAGER_ROLES, featureDefinition, hasFeatureAccess } = require('../utils/featureAccess');

// /api/feature-access - who may open the restricted (financial) tabs. Grants are
// managed from the tab itself, by Super Admins only.
const router = express.Router();
router.use(authenticate);

// GET /api/feature-access/me - what the signed-in user may open.
router.get('/me', (req, res) => {
  const db = getDb();
  const access = {};
  for (const key of Object.keys(FEATURES)) access[key] = hasFeatureAccess(req.user, key, db);
  res.set('Cache-Control', 'no-store');
  res.json({ access, can_manage: GRANT_MANAGER_ROLES.includes(req.user.role) });
});

function grantRows(db, feature) {
  const definition = featureDefinition(feature);
  // Everyone who could hold a grant: active staff whose role does not already include it.
  const placeholders = definition.roles.map(() => '?').join(',');
  return db.prepare(`
    SELECT u.id, u.name, u.email, u.role,
           a.granted_at, g.name AS granted_by_name
    FROM users u
    LEFT JOIN user_feature_access a ON a.user_id = u.id AND a.feature = ?
    LEFT JOIN users g ON g.id = a.granted_by
    WHERE u.is_active = 1 AND u.role != 'contractor' AND u.role NOT IN (${placeholders})
    ORDER BY u.name COLLATE NOCASE
  `).all(feature, ...definition.roles).map(row => ({
    user_id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    granted: Boolean(row.granted_at),
    granted_at: row.granted_at || null,
    granted_by_name: row.granted_by_name || null,
  }));
}

function loadFeature(req, res) {
  const definition = featureDefinition(req.params.feature);
  if (!definition) {
    res.status(404).json({ error: 'Unknown feature' });
    return null;
  }
  return definition;
}

// GET /api/feature-access/:feature - the roles that always have it and every grant.
router.get('/:feature', authorize(...GRANT_MANAGER_ROLES), (req, res) => {
  const definition = loadFeature(req, res);
  if (!definition) return;
  const db = getDb();
  const roleHolders = db.prepare(`
    SELECT id, name, role FROM users
    WHERE is_active = 1 AND role IN (${definition.roles.map(() => '?').join(',')})
    ORDER BY name COLLATE NOCASE
  `).all(...definition.roles);
  res.set('Cache-Control', 'no-store');
  res.json({
    feature: definition.key,
    label: definition.label,
    roles: definition.roles,
    role_holders: roleHolders.map(u => ({ user_id: u.id, name: u.name, role: u.role })),
    users: grantRows(db, definition.key),
  });
});

function grantTarget(db, userId) {
  return db.prepare('SELECT id, name, role, is_active FROM users WHERE id = ?').get(userId);
}

// PUT /api/feature-access/:feature/:userId - grant.
router.put('/:feature/:userId', authorize(...GRANT_MANAGER_ROLES), (req, res) => {
  const definition = loadFeature(req, res);
  if (!definition) return;
  const db = getDb();
  const target = grantTarget(db, req.params.userId);
  if (!target || !target.is_active) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'contractor') return res.status(400).json({ error: `Contractors cannot be given ${definition.label}.` });
  if (definition.roles.includes(target.role)) return res.status(400).json({ error: `${target.name} already has ${definition.label} through their role.` });
  const result = db.prepare(`
    INSERT INTO user_feature_access (user_id, feature, granted_by) VALUES (?, ?, ?)
    ON CONFLICT(user_id, feature) DO NOTHING
  `).run(target.id, definition.key, req.user.id);
  if (result.changes) {
    logActivity({
      userId: req.user.id,
      action: 'feature_access_granted',
      entityType: 'user',
      entityId: target.id,
      details: { feature: definition.key, user_name: target.name, user_role: target.role },
    });
  }
  res.json({ users: grantRows(db, definition.key) });
});

// DELETE /api/feature-access/:feature/:userId - revoke.
router.delete('/:feature/:userId', authorize(...GRANT_MANAGER_ROLES), (req, res) => {
  const definition = loadFeature(req, res);
  if (!definition) return;
  const db = getDb();
  const target = grantTarget(db, req.params.userId);
  const result = db.prepare('DELETE FROM user_feature_access WHERE user_id = ? AND feature = ?').run(req.params.userId, definition.key);
  if (result.changes) {
    logActivity({
      userId: req.user.id,
      action: 'feature_access_revoked',
      entityType: 'user',
      entityId: req.params.userId,
      details: { feature: definition.key, user_name: target?.name || null, user_role: target?.role || null },
    });
  }
  res.json({ users: grantRows(db, definition.key) });
});

module.exports = router;
