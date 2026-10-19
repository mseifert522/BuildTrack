const { getDb } = require('../db/schema');

// Restricted tabs (Mike, 2026-10-19). The listed roles always have access; anyone else
// needs a user_feature_access row granted by a Super Admin or Operations Manager.
// Contractors never do. Project managers do NOT get Finance from their role.
// 'bank_draws' is the project Finance tab (renamed from "Bank Draws" the same day;
// the key stays so grants keep working).
const FEATURES = Object.freeze({
  bank_draws: Object.freeze({
    key: 'bank_draws',
    label: 'Finance',
    roles: Object.freeze(['super_admin', 'operations_manager']),
  }),
});

const GRANT_MANAGER_ROLES = Object.freeze(['super_admin', 'operations_manager']);

function featureDefinition(feature) {
  return Object.prototype.hasOwnProperty.call(FEATURES, feature) ? FEATURES[feature] : null;
}

function hasFeatureAccess(user, feature, db = getDb()) {
  const definition = featureDefinition(feature);
  if (!definition || !user?.id || user.role === 'contractor') return false;
  if (definition.roles.includes(user.role)) return true;
  const row = db.prepare(`
    SELECT 1
    FROM user_feature_access a
    JOIN users u ON u.id = a.user_id
    WHERE a.user_id = ? AND a.feature = ? AND u.is_active = 1 AND u.role != 'contractor'
  `).get(user.id, feature);
  return Boolean(row);
}

function requireFeature(feature) {
  return (req, res, next) => {
    if (hasFeatureAccess(req.user, feature)) return next();
    return res.status(403).json({ error: `You do not have access to ${featureDefinition(feature)?.label || 'this feature'}.` });
  };
}

module.exports = { FEATURES, GRANT_MANAGER_ROLES, featureDefinition, hasFeatureAccess, requireFeature };
