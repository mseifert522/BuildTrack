const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
const MANAGEMENT_ROLES = ['super_admin', 'operations_manager', 'project_manager'];

router.use(authenticate);
router.use(authorize(...MANAGEMENT_ROLES));

function cleanMessage(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// GET /api/chat/users - active management recipients for direct messages
router.get('/users', (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT
      id, name, email, role, avatar_url, last_seen_at,
      CASE WHEN last_seen_at IS NOT NULL AND datetime(last_seen_at) >= datetime('now', '-2 minutes') THEN 1 ELSE 0 END as is_online
    FROM users
    WHERE is_active = 1 AND role IN ('super_admin', 'operations_manager', 'project_manager')
    ORDER BY is_online DESC, name
  `).all();
  res.json(users);
});

// GET /api/chat/messages - shared management room plus direct messages involving current user
router.get('/messages', (req, res) => {
  const db = getDb();
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100;
  const since = String(req.query.since || '').trim();
  const sinceWhere = since ? 'AND datetime(cm.created_at) > datetime(?)' : '';
  const params = since ? [req.user.id, req.user.id, since, limit] : [req.user.id, req.user.id, limit];

  const messages = db.prepare(`
    SELECT
      cm.id,
      cm.sender_id,
      cm.recipient_id,
      cm.message,
      cm.created_at,
      sender.name as sender_name,
      sender.role as sender_role,
      sender.avatar_url as sender_avatar_url,
      recipient.name as recipient_name
    FROM chat_messages cm
    JOIN users sender ON sender.id = cm.sender_id
    LEFT JOIN users recipient ON recipient.id = cm.recipient_id
    WHERE (cm.recipient_id IS NULL OR cm.sender_id = ? OR cm.recipient_id = ?)
      ${sinceWhere}
    ORDER BY datetime(cm.created_at) DESC, cm.created_at DESC
    LIMIT ?
  `).all(...params).reverse();

  res.json(messages);
});

// POST /api/chat/messages - send to everyone or direct to a management user
router.post('/messages', (req, res) => {
  const message = cleanMessage(req.body.message);
  const recipientId = req.body.recipient_id ? String(req.body.recipient_id) : null;
  if (!message) return res.status(400).json({ error: 'Message is required' });
  if (message.length > 1000) return res.status(400).json({ error: 'Message is too long' });

  const db = getDb();
  let recipient = null;
  if (recipientId) {
    recipient = db.prepare(`
      SELECT id, name, role
      FROM users
      WHERE id = ? AND is_active = 1 AND role IN ('super_admin', 'operations_manager', 'project_manager')
    `).get(recipientId);
    if (!recipient) return res.status(400).json({ error: 'Recipient is not available for chat' });
  }

  const id = uuidv4();
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO chat_messages (id, sender_id, recipient_id, message, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, req.user.id, recipientId, message, createdAt);

  res.status(201).json({
    id,
    sender_id: req.user.id,
    recipient_id: recipientId,
    message,
    created_at: createdAt,
    sender_name: req.user.name,
    sender_role: req.user.role,
    sender_avatar_url: req.user.avatar_url || null,
    recipient_name: recipient?.name || null,
  });
});

module.exports = router;
