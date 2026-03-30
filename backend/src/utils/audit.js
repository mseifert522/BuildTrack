const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');

function logActivity({ userId, projectId = null, action, entityType = null, entityId = null, details = null }) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO activity_log (id, project_id, user_id, action, entity_type, entity_id, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), projectId, userId, action, entityType, entityId, details ? JSON.stringify(details) : null);
  } catch (err) {
    console.error('Failed to log activity:', err.message);
  }
}

module.exports = { logActivity };
