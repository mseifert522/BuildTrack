const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate, authorizeProjectAccess } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');

const router = express.Router({ mergeParams: true });
router.use(authenticate);
router.use(authorizeProjectAccess);

// GET /api/projects/:projectId/punch-list
router.get('/', (req, res) => {
  const db = getDb();
  const { status, priority, assigned_to, search } = req.query;
  let query = `
    SELECT pli.*, u.name as assigned_to_name, cb.name as created_by_name
    FROM punch_list_items pli
    LEFT JOIN users u ON u.id = pli.assigned_to
    LEFT JOIN users cb ON cb.id = pli.created_by
    WHERE pli.project_id = ?
  `;
  const params = [req.params.projectId];

  if (status) { query += ' AND pli.status = ?'; params.push(status); }
  if (priority) { query += ' AND pli.priority = ?'; params.push(priority); }
  if (assigned_to) { query += ' AND pli.assigned_to = ?'; params.push(assigned_to); }
  if (search) { query += ' AND (pli.title LIKE ? OR pli.description LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

  query += ' ORDER BY pli.sort_order ASC, pli.created_at DESC';
  const items = db.prepare(query).all(...params);

  // Attach photo counts
  const enriched = items.map(item => {
    const photoCount = db.prepare('SELECT COUNT(*) as cnt FROM photos WHERE punch_list_item_id = ?').get(item.id);
    const commentCount = db.prepare('SELECT COUNT(*) as cnt FROM punch_list_comments WHERE item_id = ?').get(item.id);
    return { ...item, photo_count: photoCount.cnt, comment_count: commentCount.cnt };
  });

  res.json(enriched);
});

// POST /api/projects/:projectId/punch-list
router.post('/', (req, res) => {
  try {
    const { title, description, status, priority, assigned_to, due_date, notes } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const db = getDb();
    const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM punch_list_items WHERE project_id = ?').get(req.params.projectId);
    const id = uuidv4();
    db.prepare(`
      INSERT INTO punch_list_items (id, project_id, title, description, status, priority, assigned_to, due_date, notes, sort_order, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.params.projectId, title, description || null, status || 'not_started', priority || 'medium', assigned_to || null, due_date || null, notes || null, (maxOrder.max || 0) + 1, req.user.id);

    logActivity({ userId: req.user.id, projectId: req.params.projectId, action: 'punch_item_created', entityType: 'punch_list_item', entityId: id, details: { title } });
    res.status(201).json({ id, title });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create punch list item' });
  }
});

// PUT /api/projects/:projectId/punch-list/:id
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const item = db.prepare('SELECT * FROM punch_list_items WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    // Contractors can only update items assigned to them
    if (req.user.role === 'contractor' && item.assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'You can only update items assigned to you' });
    }

    const { title, description, status, priority, assigned_to, due_date, notes } = req.body;
    const completedAt = status === 'completed' && item.status !== 'completed' ? "datetime('now')" : item.completed_at ? `'${item.completed_at}'` : 'NULL';

    db.prepare(`
      UPDATE punch_list_items SET title = ?, description = ?, status = ?, priority = ?, assigned_to = ?,
      due_date = ?, notes = ?, completed_at = ${completedAt}, updated_at = datetime('now') WHERE id = ?
    `).run(
      title ?? item.title, description ?? item.description, status ?? item.status,
      priority ?? item.priority, assigned_to !== undefined ? assigned_to : item.assigned_to,
      due_date ?? item.due_date, notes ?? item.notes, req.params.id
    );

    logActivity({ userId: req.user.id, projectId: req.params.projectId, action: 'punch_item_updated', entityType: 'punch_list_item', entityId: req.params.id, details: { status } });
    res.json({ message: 'Item updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// DELETE /api/projects/:projectId/punch-list/:id
router.delete('/:id', (req, res) => {
  if (!['super_admin', 'operations_manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const db = getDb();
  db.prepare('DELETE FROM punch_list_items WHERE id = ? AND project_id = ?').run(req.params.id, req.params.projectId);
  logActivity({ userId: req.user.id, projectId: req.params.projectId, action: 'punch_item_deleted', entityType: 'punch_list_item', entityId: req.params.id });
  res.json({ message: 'Item deleted' });
});

// GET /api/projects/:projectId/punch-list/:id/comments
router.get('/:id/comments', (req, res) => {
  const db = getDb();
  const comments = db.prepare(`
    SELECT plc.*, u.name as user_name
    FROM punch_list_comments plc JOIN users u ON u.id = plc.user_id
    WHERE plc.item_id = ? ORDER BY plc.created_at ASC
  `).all(req.params.id);
  res.json(comments);
});

// POST /api/projects/:projectId/punch-list/:id/comments
router.post('/:id/comments', (req, res) => {
  const { comment } = req.body;
  if (!comment) return res.status(400).json({ error: 'Comment required' });
  const db = getDb();
  const id = uuidv4();
  db.prepare('INSERT INTO punch_list_comments (id, item_id, user_id, comment) VALUES (?, ?, ?, ?)')
    .run(id, req.params.id, req.user.id, comment);
  res.status(201).json({ id, comment });
});

module.exports = router;
