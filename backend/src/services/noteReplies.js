const { v4: uuidv4 } = require('uuid');

function canReadNote(user, note) {
  return Boolean(user && note && (user.role !== 'contractor' || note.user_id === user.id || note.visibility === 'public'));
}

function attachRepliesToNotes(db, notes) {
  if (!notes.length) return notes;
  const repliesByNote = new Map();
  // Bound query parameters even when a project has years of notes.
  for (let offset = 0; offset < notes.length; offset += 400) {
    const ids = notes.slice(offset, offset + 400).map(note => note.id);
    const replies = db.prepare(`
      SELECT r.id, r.note_id, r.user_id, r.note, r.created_at,
             u.name AS user_name, u.role AS user_role, u.avatar_url AS user_avatar_url
      FROM project_note_replies r JOIN users u ON u.id = r.user_id
      WHERE r.note_id IN (${ids.map(() => '?').join(',')})
      ORDER BY r.created_at ASC, r.id ASC
    `).all(...ids);
    for (const reply of replies) {
      const bucket = repliesByNote.get(reply.note_id) || [];
      bucket.push(reply);
      repliesByNote.set(reply.note_id, bucket);
    }
  }
  return notes.map(note => {
    const replies = repliesByNote.get(note.id) || [];
    return { ...note, replies, can_reply: true, last_activity_at: replies.at(-1)?.created_at || note.created_at };
  });
}

function createNoteReply(db, { projectId, noteId, user, text, clientId }) {
  const fail = (status, error) => ({ status, error });
  if (typeof text !== 'string' || !text.trim()) return fail(400, 'Reply text is required');
  if (text.length > 10000) return fail(400, 'Replies must be 10,000 characters or fewer');
  if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(clientId)) return fail(400, 'A valid reply request ID is required');

  return db.transaction(() => {
    const parent = db.prepare('SELECT * FROM project_notes WHERE id = ? AND project_id = ?').get(noteId, projectId);
    if (!parent || !canReadNote(user, parent)) return fail(404, 'Note not found');
    const prior = db.prepare('SELECT id, note FROM project_note_replies WHERE note_id = ? AND user_id = ? AND client_id = ?')
      .get(noteId, user.id, clientId);
    if (prior && prior.note !== text.trim()) return fail(409, 'This request was already used for a different reply');
    const id = prior?.id || uuidv4();
    if (!prior) {
      db.prepare('INSERT INTO project_note_replies (id, note_id, user_id, note, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, noteId, user.id, text.trim(), clientId, new Date().toISOString());
      // Reply creation and its audit record succeed or roll back together.
      db.prepare('INSERT INTO activity_log (id, project_id, user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(uuidv4(), projectId, user.id, 'note_reply_added', 'note_reply', id, JSON.stringify({ note_id: noteId }));
    }
    const note = attachRepliesToNotes(db, [parent])[0];
    return { status: prior ? 200 : 201, reply: note.replies.find(reply => reply.id === id), note, created: !prior };
  })();
}

module.exports = { canReadNote, attachRepliesToNotes, createNoteReply };
