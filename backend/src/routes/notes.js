const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate, authorizeProjectAccess } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');

const router = express.Router({ mergeParams: true });
router.use(authenticate);
router.use(authorizeProjectAccess);

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
    SELECT n.*, u.name as user_name, u.role as user_role
    FROM project_notes n
    JOIN users u ON u.id = n.user_id
    WHERE n.project_id = ?
    ORDER BY n.created_at ASC
  `).all(req.params.projectId);
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
  const { note, note_type } = req.body;
  if (!note || !note.trim()) return res.status(400).json({ error: 'Note text is required' });

  const db = getDb();
  const id = uuidv4();
  const createdAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO project_notes (id, project_id, user_id, note, note_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, req.params.projectId, req.user.id, note.trim(), note_type || 'general', createdAt);

  const newNote = {
    id,
    project_id: req.params.projectId,
    user_id: req.user.id,
    user_name: req.user.name,
    user_role: req.user.role,
    note: note.trim(),
    note_type: note_type || 'general',
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
router.delete('/:id', (req, res) => {
  const db = getDb();
  const note = db.prepare('SELECT * FROM project_notes WHERE id = ? AND project_id = ?')
    .get(req.params.id, req.params.projectId);
  if (!note) return res.status(404).json({ error: 'Note not found' });

  const canDelete =
    note.user_id === req.user.id ||
    ['super_admin', 'operations_manager'].includes(req.user.role);

  if (!canDelete) return res.status(403).json({ error: 'Cannot delete this note' });

  db.prepare('DELETE FROM project_notes WHERE id = ?').run(req.params.id);

  // Broadcast deletion
  broadcastToProject(req.params.projectId, { type: 'delete_note', noteId: req.params.id });

  res.json({ message: 'Note deleted' });
});

module.exports = router;
