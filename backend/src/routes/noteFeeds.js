const express = require('express');
const { authenticate } = require('../middleware/auth');
const { attachRepliesToNotes } = require('../services/noteReplies');
const router = express.Router();

// Consolidated project notes feed for the dashboard.
router.get('/notes/recent', authenticate, (req, res) => {
  const { getDb } = require('../db/schema');
  const db = getDb();
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;

  const contractorOnly = req.user.role === 'contractor';
  const assignmentJoin = contractorOnly
    ? 'JOIN project_assignments pa ON pa.project_id = n.project_id AND pa.user_id = ?'
    : '';
  const params = contractorOnly ? [req.user.id, limit] : [limit];

  const notes = db.prepare(`
    SELECT
      n.id,
      n.project_id,
      n.user_id,
      n.note,
      n.note_type,
      n.visibility,
      n.edited_at,
      n.edited_by,
      n.edit_count,
      n.created_at,
      COALESCE((SELECT MAX(r.created_at) FROM project_note_replies r WHERE r.note_id = n.id), n.created_at) AS last_activity_at,
      u.name as user_name,
      u.role as user_role,
      u.avatar_url as user_avatar_url,
      photo.id as photo_id,
      photo.filename as photo_filename,
      photo.original_name as photo_original_name,
      photo.caption as photo_caption,
      p.address as project_address,
      p.job_name as project_job_name,
      p.status as project_status
    FROM project_notes n
    JOIN users u ON u.id = n.user_id
    JOIN projects p ON p.id = n.project_id
    LEFT JOIN photos photo ON photo.id = (
      SELECT p2.id
      FROM photos p2
      WHERE p2.note_id = n.id
      ORDER BY datetime(COALESCE(p2.taken_at, p2.created_at)) DESC, p2.created_at DESC
      LIMIT 1
    )
    ${assignmentJoin}
      ${contractorOnly ? "AND (n.user_id = ? OR n.visibility = 'public')" : ''}
    ORDER BY datetime(last_activity_at) DESC, last_activity_at DESC, n.id DESC
    LIMIT ?
  `).all(...(contractorOnly ? [req.user.id, req.user.id, limit] : [limit]));

  res.json(attachRepliesToNotes(db, notes));
});

function parseActivityDetails(details) {
  if (!details) return null;
  try {
    return JSON.parse(details);
  } catch (_) {
    return null;
  }
}

// Dashboard feed: latest human-entered project notes only, newest first.
router.get('/dashboard/activity-feed', authenticate, (req, res) => {
  const { getDb } = require('../db/schema');
  const { logDataAccess } = require('../utils/dataAccessAudit');
  const db = getDb();
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 10), 100) : 25;
  const contractorOnly = req.user.role === 'contractor';

  const noteAssignmentJoin = contractorOnly
    ? 'JOIN project_assignments pa ON pa.project_id = n.project_id AND pa.user_id = ?'
    : '';
  const noteVisibilityWhere = contractorOnly
    ? "(n.user_id = ? OR n.visibility = 'public')"
    : '1 = 1';

  const rows = db.prepare(`
    SELECT
      'note' as feed_type,
      n.id,
      n.project_id,
      n.user_id,
      u.name as user_name,
      u.role as user_role,
      u.avatar_url as user_avatar_url,
      n.created_at,
      COALESCE((SELECT MAX(r.created_at) FROM project_note_replies r WHERE r.note_id = n.id), n.created_at) AS last_activity_at,
      p.address as project_address,
      p.job_name as project_job_name,
      p.status as project_status,
      n.note,
      n.note_type,
      n.visibility,
      n.edited_at,
      n.edit_count,
      photo.id as photo_id,
      photo.filename as photo_filename,
      photo.original_name as photo_original_name,
      photo.caption as photo_caption,
      NULL as action,
      NULL as entity_type,
      NULL as entity_id,
      NULL as details
    FROM project_notes n
    JOIN users u ON u.id = n.user_id
    JOIN projects p ON p.id = n.project_id
    LEFT JOIN photos photo ON photo.id = (
      SELECT p2.id
      FROM photos p2
      WHERE p2.note_id = n.id
      ORDER BY datetime(COALESCE(p2.taken_at, p2.created_at)) DESC, p2.created_at DESC
      LIMIT 1
    )
    ${noteAssignmentJoin}
    WHERE ${noteVisibilityWhere}
      AND p.status != 'archived'
    ORDER BY datetime(last_activity_at) DESC, last_activity_at DESC, n.id DESC
    LIMIT ?
  `).all(...(contractorOnly
    ? [req.user.id, req.user.id, limit]
    : [limit]
  ));

  const items = attachRepliesToNotes(db, rows).map(row => ({
    ...row,
    details: parseActivityDetails(row.details),
  }));

  logDataAccess(req, {
    action: 'dashboard_activity_feed_viewed',
    accessType: 'view',
    entityType: 'dashboard_activity_feed',
    recordCount: items.length,
    details: { limit, contractor_only: contractorOnly, feed_scope: 'project_notes_only' },
  });

  res.json({ items });
});

module.exports = router;
