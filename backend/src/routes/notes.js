const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate, authorizeProjectAccess } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');

const router = express.Router({ mergeParams: true });
router.use(authenticate);
router.use(authorizeProjectAccess);
const MANAGEMENT_ROLES = ['super_admin', 'operations_manager', 'project_manager'];

// In-memory SSE client registry: { projectId: [{ res, userId }] }
const sseClients = {};

function broadcastToProject(projectId, data) {
  const clients = sseClients[projectId] || [];
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(({ res }) => {
    try { res.write(payload); } catch (e) { /* client disconnected */ }
  });
}

// GET /api/projects/:projectId/notes — fetch all notes for a project
router.get('/', (req, res) => {
  const db = getDb();
  const notes = db.prepare(`
    SELECT
      n.*,
      u.name as user_name,
      u.role as user_role,
      u.avatar_url as user_avatar_url,
      eu.name as edited_by_name,
      ph.id as photo_id,
      ph.filename as photo_filename,
      ph.original_name as photo_original_name,
      ph.caption as photo_caption
    FROM project_notes n
    JOIN users u ON u.id = n.user_id
    LEFT JOIN users eu ON eu.id = n.edited_by
    LEFT JOIN photos ph ON ph.note_id = n.id
    WHERE n.project_id = ?
      AND (
        ? != 'contractor'
        OR n.user_id = ?
        OR n.visibility = 'public'
      )
    ORDER BY n.created_at ASC
  `).all(req.params.projectId, req.user.role, req.user.id);
  res.json(notes);
});

// GET /api/projects/:projectId/notes/stream — SSE real-time stream
router.get('/stream', (req, res) => {
  const projectId = req.params.projectId;

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send a heartbeat immediately so the connection is confirmed
  res.write(': heartbeat\n\n');

  // Register this client
  if (!sseClients[projectId]) sseClients[projectId] = [];
  const client = { res, userId: req.user.id };
  sseClients[projectId].push(client);

  // Send a heartbeat every 25s to keep connection alive
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (e) { clearInterval(heartbeat); }
  }, 25000);

  // Clean up on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    if (sseClients[projectId]) {
      sseClients[projectId] = sseClients[projectId].filter(c => c !== client);
    }
  });
});

// POST /api/projects/:projectId/notes — create a note
router.post('/', (req, res) => {
  const { note, note_type, visibility } = req.body;
  if (!note || !note.trim()) return res.status(400).json({ error: 'Note text is required' });

  const db = getDb();
  const id = uuidv4();
  const createdAt = new Date().toISOString();
  const noteVisibility = req.user.role === 'contractor'
    ? 'private'
    : (visibility === 'public' ? 'public' : 'private');

  db.prepare(`
    INSERT INTO project_notes (id, project_id, user_id, note, note_type, visibility, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.projectId, req.user.id, note.trim(), note_type || 'general', noteVisibility, createdAt);

  const newNote = {
    id,
    project_id: req.params.projectId,
    user_id: req.user.id,
    user_name: req.user.name,
    user_role: req.user.role,
    user_avatar_url: req.user.avatar_url || null,
    note: note.trim(),
    note_type: note_type || 'general',
    visibility: noteVisibility,
    edit_count: 0,
    edited_at: null,
    edited_by: null,
    edited_by_name: null,
    photo_id: null,
    photo_filename: null,
    photo_original_name: null,
    photo_caption: null,
    created_at: createdAt,
  };

  // Broadcast to all SSE clients watching this project
  broadcastToProject(req.params.projectId, { type: 'new_note', note: newNote });

  logActivity({
    userId: req.user.id,
    projectId: req.params.projectId,
    action: 'note_added',
    entityType: 'note',
    entityId: id,
  });

  res.status(201).json(newNote);
});

// DELETE /api/projects/:projectId/notes/:id — delete a note (own notes or admin)
router.put('/:id', (req, res) => {
  const { note, note_type, visibility } = req.body;
  if (!note || !note.trim()) return res.status(400).json({ error: 'Note text is required' });

  const db = getDb();
  const existing = db.prepare('SELECT * FROM project_notes WHERE id = ? AND project_id = ?')
    .get(req.params.id, req.params.projectId);
  if (!existing) return res.status(404).json({ error: 'Note not found' });
  const isOwner = existing.user_id === req.user.id;
  if (!isOwner) {
    return res.status(403).json({ error: 'You can only edit your own notes' });
  }
  if (Number(existing.edit_count || 0) >= 1) return res.status(403).json({ error: 'This note has already been edited once' });

  const editedAt = new Date().toISOString();
  const nextVisibility = req.user.role === 'contractor'
    ? 'private'
    : (visibility === 'public' ? 'public' : visibility === 'private' ? 'private' : existing.visibility || 'private');
  db.prepare(`
    UPDATE project_notes
    SET note = ?, note_type = ?, visibility = ?, edited_at = ?, edited_by = ?, edit_count = edit_count + 1
    WHERE id = ? AND project_id = ?
  `).run(note.trim(), note_type || existing.note_type || 'general', nextVisibility, editedAt, req.user.id, req.params.id, req.params.projectId);

  const updated = db.prepare(`
    SELECT
      n.*,
      u.name as user_name,
      u.role as user_role,
      u.avatar_url as user_avatar_url,
      eu.name as edited_by_name,
      ph.id as photo_id,
      ph.filename as photo_filename,
      ph.original_name as photo_original_name,
      ph.caption as photo_caption
    FROM project_notes n
    JOIN users u ON u.id = n.user_id
    LEFT JOIN users eu ON eu.id = n.edited_by
    LEFT JOIN photos ph ON ph.note_id = n.id
    WHERE n.id = ? AND n.project_id = ?
  `).get(req.params.id, req.params.projectId);

  broadcastToProject(req.params.projectId, { type: 'update_note', note: updated });
  logActivity({ userId: req.user.id, projectId: req.params.projectId, action: 'note_updated', entityType: 'note', entityId: req.params.id });
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  res.status(405).json({ error: 'Notes cannot be deleted' });
});

module.exports = router;
