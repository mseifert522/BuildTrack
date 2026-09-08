const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate, authorizeUpperManagement, blockProjectManagerMutation, authorizeProjectAccess } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');

const router = express.Router({ mergeParams: true });
router.use(authenticate);
router.use(authorizeProjectAccess);

function activePhotoSql(alias = 'ph') {
  return `COALESCE(${alias}.upload_status, 'uploaded') != 'correction_deleted' AND ${alias}.correction_deleted_at IS NULL`;
}

const PUNCH_STATUSES = new Set(['not_started', 'in_progress', 'waiting_materials', 'needs_review', 'completed']);
const PUNCH_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);
const MAX_BULK_ITEMS = 200;

function cleanText(value, max) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

function normalizeDueDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return Number.isNaN(new Date(text).getTime()) ? null : text.slice(0, 40);
}

// One line of the Bulk Add form -> a validated punch list row (null = skip the line).
function normalizeBulkRow(row, db) {
  if (!row || typeof row !== 'object') return null;
  const title = cleanText(row.title, 500);
  if (!title) return null;
  const assignedTo = cleanText(row.assigned_to, 120);
  return {
    client_key: cleanText(row.client_key, 120),
    title,
    description: cleanText(row.description, 4000),
    status: PUNCH_STATUSES.has(row.status) ? row.status : 'not_started',
    priority: PUNCH_PRIORITIES.has(row.priority) ? row.priority : 'medium',
    assigned_to: assignedTo && db.prepare('SELECT id FROM users WHERE id = ?').get(assignedTo) ? assignedTo : null,
    due_date: normalizeDueDate(row.due_date),
    notes: cleanText(row.notes, 4000),
  };
}

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
    const directPhotos = db.prepare(`
      SELECT
        NULL as assignment_id,
        ph.id,
        ph.filename,
        ph.original_name,
        ph.mime_type,
        ph.caption,
        ph.taken_at,
        ph.captured_at,
        ph.created_at,
        ph.markup_path,
        ph.individual_note,
        ph.batch_note,
        u.name as uploader_name
      FROM photos ph
      LEFT JOIN users u ON u.id = ph.uploaded_by
      WHERE ph.punch_list_item_id = ?
        AND ph.project_id = ?
        AND ${activePhotoSql('ph')}
      ORDER BY datetime(COALESCE(ph.captured_at, ph.taken_at, ph.uploaded_at, ph.created_at)) DESC
    `).all(item.id, req.params.projectId);
    const assignedPhotos = db.prepare(`
      SELECT
        pa.id as assignment_id,
        ph.id,
        ph.filename,
        ph.original_name,
        ph.mime_type,
        ph.caption,
        ph.taken_at,
        ph.captured_at,
        ph.created_at,
        ph.markup_path,
        ph.individual_note,
        ph.batch_note,
        u.name as uploader_name
      FROM photo_assignments pa
      JOIN photos ph ON ph.id = pa.photo_id
      LEFT JOIN users u ON u.id = ph.uploaded_by
      WHERE pa.project_id = ?
        AND pa.target_type = 'punch_list_item'
        AND pa.target_id = ?
        AND ph.project_id = pa.project_id
        AND ${activePhotoSql('ph')}
      ORDER BY datetime(pa.created_at) DESC, datetime(COALESCE(ph.captured_at, ph.taken_at, ph.uploaded_at, ph.created_at)) DESC
    `).all(req.params.projectId, item.id);
    const photosById = new Map();
    [...assignedPhotos, ...directPhotos].forEach(photo => {
      if (!photosById.has(photo.id)) photosById.set(photo.id, photo);
    });
    const photos = Array.from(photosById.values());
    const commentCount = db.prepare('SELECT COUNT(*) as cnt FROM punch_list_comments WHERE item_id = ?').get(item.id);
    return { ...item, photo_count: photos.length, photos, assigned_photos: photos, comment_count: commentCount.cnt };
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

// POST /api/projects/:projectId/punch-list/bulk
// Line-by-line insert from the desktop Bulk Add form: every row becomes its
// own punch list item, written in ONE transaction so a bad line never leaves
// half a list behind. Same role rules as the single-item POST above.
router.post('/bulk', (req, res) => {
  try {
    const rawRows = Array.isArray(req.body?.items) ? req.body.items : [];
    if (rawRows.length > MAX_BULK_ITEMS) {
      return res.status(400).json({ error: `Add up to ${MAX_BULK_ITEMS} punch list items at a time` });
    }
    const db = getDb();
    const rows = rawRows.map(row => normalizeBulkRow(row, db)).filter(Boolean);
    if (!rows.length) return res.status(400).json({ error: 'Add at least one punch list item with a title' });

    const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM punch_list_items WHERE project_id = ?').get(req.params.projectId);
    let nextOrder = Number(maxOrder?.max || 0);
    const insert = db.prepare(`
      INSERT INTO punch_list_items (id, project_id, title, description, status, priority, assigned_to, due_date, notes, sort_order, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const created = [];
    db.transaction(() => {
      for (const row of rows) {
        const id = uuidv4();
        nextOrder += 1;
        insert.run(id, req.params.projectId, row.title, row.description, row.status, row.priority, row.assigned_to, row.due_date, row.notes, nextOrder, req.user.id);
        created.push({ id, title: row.title, client_key: row.client_key, sort_order: nextOrder });
      }
    })();

    logActivity({
      userId: req.user.id,
      projectId: req.params.projectId,
      action: 'punch_items_bulk_created',
      entityType: 'punch_list_item',
      entityId: created[0].id,
      details: { count: created.length, titles: created.slice(0, 5).map(item => item.title) },
    });
    res.status(201).json({ created: created.length, items: created });
  } catch (err) {
    console.error('Failed to bulk-create punch list items:', err);
    res.status(500).json({ error: 'Failed to create punch list items' });
  }
});

// PUT /api/projects/:projectId/punch-list/:id
router.put('/:id', blockProjectManagerMutation, (req, res) => {
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
router.delete('/:id', authorizeUpperManagement, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM punch_list_items WHERE id = ? AND project_id = ?').run(req.params.id, req.params.projectId);
  logActivity({ userId: req.user.id, projectId: req.params.projectId, action: 'punch_item_deleted', entityType: 'punch_list_item', entityId: req.params.id });
  res.json({ message: 'Item deleted' });
});

// PUT /api/projects/:projectId/punch-list/:id/photos/:photoId
// Attach a project photo to THIS punch item, moving it off any other punch
// item it was matched to (a bulk upload dropped on the wrong line, or a photo
// dragged between rows). The photo file and its bucket entry are untouched;
// only the punch-item link changes. Same role rules as updating the item.
router.put('/:id/photos/:photoId', blockProjectManagerMutation, (req, res) => {
  try {
    const db = getDb();
    const projectId = req.params.projectId;
    const item = db.prepare('SELECT id, title, assigned_to FROM punch_list_items WHERE id = ? AND project_id = ?').get(req.params.id, projectId);
    if (!item) return res.status(404).json({ error: 'Punch list item not found' });

    const photo = db.prepare(`
      SELECT ph.id, ph.punch_list_item_id
      FROM photos ph
      WHERE ph.id = ? AND ph.project_id = ? AND ${activePhotoSql('ph')}
    `).get(req.params.photoId, projectId);
    if (!photo) return res.status(404).json({ error: 'Photo not found in this project' });

    const previousLinks = db.prepare(`
      SELECT target_id FROM photo_assignments
      WHERE project_id = ? AND photo_id = ? AND target_type = 'punch_list_item' AND target_id != ?
    `).all(projectId, photo.id, item.id).map(row => row.target_id);
    if (photo.punch_list_item_id && photo.punch_list_item_id !== item.id) previousLinks.push(photo.punch_list_item_id);
    const movedFrom = Array.from(new Set(previousLinks));

    // Contractors may only touch items assigned to them: the destination AND
    // every item the photo is being moved away from.
    if (req.user.role === 'contractor') {
      const touched = [item.id, ...movedFrom];
      const placeholders = touched.map(() => '?').join(',');
      const foreign = db.prepare(`
        SELECT COUNT(*) as cnt FROM punch_list_items
        WHERE id IN (${placeholders}) AND (assigned_to IS NULL OR assigned_to != ?)
      `).get(...touched, req.user.id);
      if (foreign.cnt > 0) return res.status(403).json({ error: 'You can only move photos between items assigned to you' });
    }

    db.transaction(() => {
      db.prepare(`UPDATE photos SET punch_list_item_id = ?, updated_at = datetime('now') WHERE id = ? AND project_id = ?`).run(item.id, photo.id, projectId);
      db.prepare(`DELETE FROM photo_assignments WHERE project_id = ? AND photo_id = ? AND target_type = 'punch_list_item' AND target_id != ?`).run(projectId, photo.id, item.id);
      db.prepare(`
        INSERT OR IGNORE INTO photo_assignments (id, project_id, photo_id, target_type, target_id, note, created_by)
        VALUES (?, ?, ?, 'punch_list_item', ?, NULL, ?)
      `).run(uuidv4(), projectId, photo.id, item.id, req.user.id);
    })();

    logActivity({
      userId: req.user.id,
      projectId,
      action: 'punch_photo_moved',
      entityType: 'punch_list_item',
      entityId: item.id,
      details: { photo_id: photo.id, title: item.title, moved_from: movedFrom, moved: movedFrom.length > 0 },
    });
    res.json({
      message: movedFrom.length ? 'Photo moved' : 'Photo attached',
      photo_id: photo.id,
      punch_list_item_id: item.id,
      moved_from: movedFrom,
    });
  } catch (err) {
    console.error('Failed to move punch list photo:', err);
    res.status(500).json({ error: 'Failed to move photo' });
  }
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
