const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate, authorizeUpperManagement, blockProjectManagerMutation, authorizeProjectAccess } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { isEmailConfigured, sendPunchListEmail } = require('../utils/email');
const { signedUploadUrl } = require('../utils/uploadsAccess');

// Photo links in a punch-list email go to vendors with no BuildTrack login, so each
// is a signed, expiring link to that one file (the /uploads gate honors it).
const PUNCH_PHOTO_LINK_TTL_S = (Number(process.env.PUNCH_EMAIL_PHOTO_LINK_DAYS) || 30) * 24 * 60 * 60;

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

function normalizeEmail(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text.slice(0, 254) : null;
}

// The address we would email a contractor at: profile email, else the
// QuickBooks vendor email, else the linked BuildTrack user's email.
function contractorEmailSql(alias = 'cp', userAlias = 'cu') {
  return `COALESCE(NULLIF(${alias}.email, ''), NULLIF(${alias}.quickbooks_primary_email, ''), NULLIF(${userAlias}.email, ''))`;
}

function resolveContractorId(db, value) {
  const id = cleanText(value, 120);
  if (!id) return null;
  return db.prepare('SELECT id FROM contractor_profiles WHERE id = ?').get(id) ? id : null;
}

function punchListCcEmail() {
  return process.env.PUNCH_LIST_CC_EMAIL || process.env.QUOTE_APPROVED_CC_EMAIL || 'info@newurbandev.com';
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
    assigned_contractor_id: resolveContractorId(db, row.assigned_contractor_id),
    due_date: normalizeDueDate(row.due_date),
    notes: cleanText(row.notes, 4000),
  };
}

// GET /api/projects/:projectId/punch-list
router.get('/', (req, res) => {
  const db = getDb();
  const { status, priority, assigned_to, contractor_id, search } = req.query;
  let query = `
    SELECT pli.*, u.name as assigned_to_name, cb.name as created_by_name,
      cp.vendor_name as assigned_contractor_name,
      cp.contact_name as assigned_contractor_contact,
      ${contractorEmailSql()} as assigned_contractor_email
    FROM punch_list_items pli
    LEFT JOIN users u ON u.id = pli.assigned_to
    LEFT JOIN users cb ON cb.id = pli.created_by
    LEFT JOIN contractor_profiles cp ON cp.id = pli.assigned_contractor_id
    LEFT JOIN users cu ON cu.id = cp.linked_user_id
    WHERE pli.project_id = ?
  `;
  const params = [req.params.projectId];

  if (status) { query += ' AND pli.status = ?'; params.push(status); }
  if (priority) { query += ' AND pli.priority = ?'; params.push(priority); }
  if (assigned_to) { query += ' AND pli.assigned_to = ?'; params.push(assigned_to); }
  if (contractor_id) { query += ' AND pli.assigned_contractor_id = ?'; params.push(contractor_id); }
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
    const { title, description, status, priority, assigned_to, due_date, notes, assigned_contractor_id } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const db = getDb();
    const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM punch_list_items WHERE project_id = ?').get(req.params.projectId);
    const id = uuidv4();
    db.prepare(`
      INSERT INTO punch_list_items (id, project_id, title, description, status, priority, assigned_to, due_date, notes, sort_order, created_by, assigned_contractor_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.params.projectId, title, description || null, status || 'not_started', priority || 'medium', assigned_to || null, due_date || null, notes || null, (maxOrder.max || 0) + 1, req.user.id, resolveContractorId(db, assigned_contractor_id));

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
      INSERT INTO punch_list_items (id, project_id, title, description, status, priority, assigned_to, due_date, notes, sort_order, created_by, assigned_contractor_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const created = [];
    db.transaction(() => {
      for (const row of rows) {
        const id = uuidv4();
        nextOrder += 1;
        insert.run(id, req.params.projectId, row.title, row.description, row.status, row.priority, row.assigned_to, row.due_date, row.notes, nextOrder, req.user.id, row.assigned_contractor_id);
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

// --- contractors on the punch list ------------------------------------------
const PUNCH_SEND_ROLES = new Set(['super_admin', 'operations_manager', 'project_manager']);

function loadPunchContractor(db, contractorId) {
  return db.prepare(`
    SELECT cp.id, cp.vendor_name, cp.contact_name, cp.phone, cp.contractor_category, cp.contractor_status,
      ${contractorEmailSql()} as email
    FROM contractor_profiles cp
    LEFT JOIN users cu ON cu.id = cp.linked_user_id
    WHERE cp.id = ?
  `).get(contractorId);
}

// Up to a dozen photo links per item for the email. /uploads needs a login now, so
// each link is signed for that one file and expires after PUNCH_PHOTO_LINK_TTL_S.
function punchItemPhotoLinks(db, projectId, itemId, appUrl) {
  const rows = db.prepare(`
    SELECT ph.id, ph.filename, ph.markup_path
    FROM photos ph
    LEFT JOIN photo_assignments pa ON pa.photo_id = ph.id AND pa.target_type = 'punch_list_item' AND pa.target_id = ?
    WHERE ph.project_id = ? AND (ph.punch_list_item_id = ? OR pa.id IS NOT NULL) AND ${activePhotoSql('ph')}
    GROUP BY ph.id
    ORDER BY datetime(COALESCE(ph.captured_at, ph.taken_at, ph.uploaded_at, ph.created_at)) ASC
    LIMIT 12
  `).all(itemId, projectId, itemId);
  return rows
    .map(row => ({
      id: row.id,
      url: signedUploadUrl(`${projectId}/${row.markup_path || row.filename}`, { ttlSeconds: PUNCH_PHOTO_LINK_TTL_S, baseUrl: appUrl }),
    }))
    .filter(link => link.url);
}

// GET /api/projects/:projectId/punch-list/contractors
// Contractors connected to this project (Assigned Contractors tab) plus any
// vendor already assigned to a punch item, each with the email we would send
// to; and the active directory for adding someone else.
router.get('/contractors', (req, res) => {
  if (req.user.role === 'contractor') return res.status(403).json({ error: 'Not available to contractors' });
  try {
    const db = getDb();
    const projectId = req.params.projectId;
    const contractors = db.prepare(`
      SELECT cp.id, cp.vendor_name, cp.contact_name, cp.phone, cp.contractor_category, cp.contractor_status,
        ${contractorEmailSql()} as email,
        CASE WHEN cpl.id IS NULL THEN 0 ELSE 1 END as linked_to_project,
        (SELECT COUNT(*) FROM punch_list_items pli WHERE pli.project_id = ? AND pli.assigned_contractor_id = cp.id) as assigned_item_count,
        (SELECT COUNT(*) FROM punch_list_items pli WHERE pli.project_id = ? AND pli.assigned_contractor_id = cp.id AND pli.status != 'completed') as open_item_count,
        (SELECT MAX(s.sent_at) FROM punch_list_sends s WHERE s.project_id = ? AND s.contractor_id = cp.id AND s.status = 'sent') as last_sent_at
      FROM contractor_profiles cp
      LEFT JOIN users cu ON cu.id = cp.linked_user_id
      LEFT JOIN contractor_project_links cpl ON cpl.contractor_id = cp.id AND cpl.project_id = ?
      WHERE cpl.id IS NOT NULL
         OR cp.id IN (SELECT assigned_contractor_id FROM punch_list_items WHERE project_id = ? AND assigned_contractor_id IS NOT NULL)
      ORDER BY cp.vendor_name COLLATE NOCASE
    `).all(projectId, projectId, projectId, projectId, projectId);
    const directory = db.prepare(`
      SELECT cp.id, cp.vendor_name, cp.contact_name, cp.contractor_category, ${contractorEmailSql()} as email
      FROM contractor_profiles cp
      LEFT JOIN users cu ON cu.id = cp.linked_user_id
      WHERE COALESCE(cp.contractor_status, 'active') != 'terminated'
      ORDER BY cp.vendor_name COLLATE NOCASE
    `).all();
    res.json({ contractors, directory, cc_email: punchListCcEmail(), email_configured: isEmailConfigured() });
  } catch (err) {
    console.error('Failed to load punch list contractors:', err);
    res.status(500).json({ error: 'Failed to load contractors' });
  }
});

// PUT /api/projects/:projectId/punch-list/assignments
// Assign (or clear) the contractor on many items at once. Declared before
// PUT /:id so "assignments" is never taken for an item id.
router.put('/assignments', blockProjectManagerMutation, (req, res) => {
  try {
    if (req.user.role === 'contractor') return res.status(403).json({ error: 'Contractors cannot reassign punch list items' });
    const raw = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
    if (!raw.length) return res.status(400).json({ error: 'Nothing to assign' });
    if (raw.length > 500) return res.status(400).json({ error: 'Too many assignments at once' });
    const db = getDb();
    const projectId = req.params.projectId;
    const updates = [];
    for (const entry of raw) {
      const itemId = cleanText(entry?.item_id, 120);
      if (!itemId) continue;
      const item = db.prepare('SELECT id, title FROM punch_list_items WHERE id = ? AND project_id = ?').get(itemId, projectId);
      if (!item) return res.status(404).json({ error: 'Punch list item not found' });
      const wanted = cleanText(entry?.contractor_id, 120);
      const contractorId = wanted ? resolveContractorId(db, wanted) : null;
      if (wanted && !contractorId) return res.status(404).json({ error: 'Contractor not found' });
      updates.push({ item, contractorId });
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to assign' });
    const update = db.prepare(`UPDATE punch_list_items SET assigned_contractor_id = ?, updated_at = datetime('now') WHERE id = ? AND project_id = ?`);
    db.transaction(() => {
      updates.forEach(entry => update.run(entry.contractorId, entry.item.id, projectId));
    })();
    logActivity({
      userId: req.user.id,
      projectId,
      action: 'punch_contractor_assigned',
      entityType: 'punch_list_item',
      entityId: updates[0].item.id,
      details: { count: updates.length, cleared: updates.filter(entry => !entry.contractorId).length },
    });
    res.json({ updated: updates.length });
  } catch (err) {
    console.error('Failed to assign punch list contractors:', err);
    res.status(500).json({ error: 'Failed to assign contractors' });
  }
});

// POST /api/projects/:projectId/punch-list/send
// Email / Send Punch List: one email per selected contractor with the items
// chosen for them (their assigned items by default). Each recipient reports
// truthfully whether an email went out; one failure never blocks the others.
router.post('/send', async (req, res) => {
  try {
    if (!PUNCH_SEND_ROLES.has(req.user.role)) return res.status(403).json({ error: 'Only management can send the punch list' });
    const db = getDb();
    const projectId = req.params.projectId;
    const project = db.prepare('SELECT id, address, job_name FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const recipientsRaw = Array.isArray(req.body?.recipients) ? req.body.recipients : [];
    if (!recipientsRaw.length) return res.status(400).json({ error: 'Pick at least one contractor' });
    if (recipientsRaw.length > 50) return res.status(400).json({ error: 'Send to up to 50 contractors at a time' });
    const message = cleanText(req.body?.message, 4000);
    const includeCompleted = Boolean(req.body?.include_completed);
    const ccEmail = req.body?.cc === false ? null : punchListCcEmail();
    const appUrl = (process.env.APP_URL || 'https://buildtrack.newurbandev.com').replace(/\/+$/, '');
    const emailConfigured = isEmailConfigured();
    const sentByName = req.user.name;

    const results = [];
    for (const raw of recipientsRaw) {
      const contractorId = cleanText(raw?.contractor_id, 120);
      const contractor = contractorId ? loadPunchContractor(db, contractorId) : null;
      const base = { contractor_id: contractorId, contractor: contractor?.vendor_name || 'Unknown contractor', email: null, sent: false, reason: null, item_count: 0 };
      if (!contractor) { results.push({ ...base, reason: 'contractor_not_found' }); continue; }
      const override = normalizeEmail(raw?.email);
      const email = override || normalizeEmail(contractor.email);
      base.email = email;
      if (override && raw?.save_email) {
        db.prepare(`UPDATE contractor_profiles SET email = ?, updated_at = datetime('now') WHERE id = ?`).run(override, contractor.id);
      }

      // Which items: an explicit list, everything assigned to them, or every item.
      const explicitIds = normalizePhotoIdList(raw?.item_ids);
      const scope = explicitIds.length ? 'explicit' : (String(raw?.scope || 'assigned') === 'all' ? 'all' : 'assigned');
      let items;
      if (scope === 'explicit') {
        const placeholders = explicitIds.map(() => '?').join(',');
        items = db.prepare(`SELECT * FROM punch_list_items WHERE project_id = ? AND id IN (${placeholders}) ORDER BY sort_order ASC, created_at ASC`).all(projectId, ...explicitIds);
      } else if (scope === 'all') {
        items = db.prepare('SELECT * FROM punch_list_items WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC').all(projectId);
      } else {
        items = db.prepare('SELECT * FROM punch_list_items WHERE project_id = ? AND assigned_contractor_id = ? ORDER BY sort_order ASC, created_at ASC').all(projectId, contractor.id);
      }
      if (!includeCompleted) items = items.filter(item => item.status !== 'completed');
      base.item_count = items.length;
      if (!items.length) { results.push({ ...base, reason: 'no_items' }); continue; }
      if (!email) { results.push({ ...base, reason: 'no_email_on_file' }); continue; }
      if (!emailConfigured) { results.push({ ...base, reason: 'email_not_configured' }); continue; }

      const itemsForEmail = items.map(item => ({ ...item, photos: punchItemPhotoLinks(db, projectId, item.id, appUrl) }));
      const now = new Date().toISOString();
      try {
        await sendPunchListEmail({
          contractorName: contractor.vendor_name,
          contactName: contractor.contact_name,
          email,
          ccEmail,
          project,
          items: itemsForEmail,
          message,
          sentByName,
        });
      } catch (err) {
        console.error('Punch list email failed:', err?.message || err);
        db.prepare(`
          INSERT INTO punch_list_sends (id, project_id, contractor_id, contractor_name, email, cc_email, item_count, item_ids_json, message, status, error, sent_by, sent_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?)
        `).run(uuidv4(), projectId, contractor.id, contractor.vendor_name, email, ccEmail, items.length, JSON.stringify(items.map(item => item.id)), message, String(err?.message || err).slice(0, 500), req.user.id, now);
        results.push({ ...base, reason: 'send_failed' });
        continue;
      }

      const stamp = db.prepare(`UPDATE punch_list_items SET last_sent_at = ?, last_sent_to = ? WHERE id = ? AND project_id = ?`);
      db.transaction(() => {
        items.forEach(item => stamp.run(now, contractor.vendor_name, item.id, projectId));
        db.prepare(`
          INSERT INTO punch_list_sends (id, project_id, contractor_id, contractor_name, email, cc_email, item_count, item_ids_json, message, status, sent_by, sent_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?)
        `).run(uuidv4(), projectId, contractor.id, contractor.vendor_name, email, ccEmail, items.length, JSON.stringify(items.map(item => item.id)), message, req.user.id, now);
      })();
      // Project activity is contractor-readable: name + count, never the raw address.
      logActivity({
        userId: req.user.id,
        projectId,
        action: 'punch_list_sent',
        entityType: 'contractor_profile',
        entityId: contractor.id,
        details: { contractor: contractor.vendor_name, item_count: items.length, cc: Boolean(ccEmail) },
      });
      results.push({ ...base, sent: true, reason: 'sent', sent_at: now });
    }

    res.json({ sent_count: results.filter(result => result.sent).length, results, cc: ccEmail });
  } catch (err) {
    console.error('Failed to send punch list:', err);
    res.status(500).json({ error: 'Failed to send punch list' });
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

    const { title, description, status, priority, assigned_to, due_date, notes, assigned_contractor_id } = req.body;
    const completedAt = status === 'completed' && item.status !== 'completed' ? "datetime('now')" : item.completed_at ? `'${item.completed_at}'` : 'NULL';
    // Contractors may update status/notes on their items but not hand them to someone else.
    const nextContractorId = assigned_contractor_id !== undefined && req.user.role !== 'contractor'
      ? resolveContractorId(db, assigned_contractor_id)
      : item.assigned_contractor_id;

    db.prepare(`
      UPDATE punch_list_items SET title = ?, description = ?, status = ?, priority = ?, assigned_to = ?,
      due_date = ?, notes = ?, assigned_contractor_id = ?, completed_at = ${completedAt}, updated_at = datetime('now') WHERE id = ?
    `).run(
      title ?? item.title, description ?? item.description, status ?? item.status,
      priority ?? item.priority, assigned_to !== undefined ? assigned_to : item.assigned_to,
      due_date ?? item.due_date, notes ?? item.notes, nextContractorId, req.params.id
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

// --- attaching / moving project photos onto punch items ----------------------
// A photo's punch-item link lives in two places (photos.punch_list_item_id and
// photo_assignments); these helpers keep both in step. The photo file and its
// bucket entry are never touched — only the punch-item link changes.
function collectPunchPhotoLinks(db, projectId, photoId, itemId) {
  const photo = db.prepare(`
    SELECT ph.id, ph.punch_list_item_id
    FROM photos ph
    WHERE ph.id = ? AND ph.project_id = ? AND ${activePhotoSql('ph')}
  `).get(photoId, projectId);
  if (!photo) {
    const err = new Error('Photo not found in this project');
    err.statusCode = 404;
    throw err;
  }
  const previous = db.prepare(`
    SELECT target_id FROM photo_assignments
    WHERE project_id = ? AND photo_id = ? AND target_type = 'punch_list_item' AND target_id != ?
  `).all(projectId, photo.id, itemId).map(row => row.target_id);
  if (photo.punch_list_item_id && photo.punch_list_item_id !== itemId) previous.push(photo.punch_list_item_id);
  return { photoId: photo.id, movedFrom: Array.from(new Set(previous)) };
}

function applyPunchPhotoLink(db, projectId, photoId, itemId, userId) {
  db.prepare(`UPDATE photos SET punch_list_item_id = ?, updated_at = datetime('now') WHERE id = ? AND project_id = ?`).run(itemId, photoId, projectId);
  db.prepare(`DELETE FROM photo_assignments WHERE project_id = ? AND photo_id = ? AND target_type = 'punch_list_item' AND target_id != ?`).run(projectId, photoId, itemId);
  db.prepare(`
    INSERT OR IGNORE INTO photo_assignments (id, project_id, photo_id, target_type, target_id, note, created_by)
    VALUES (?, ?, ?, 'punch_list_item', ?, NULL, ?)
  `).run(uuidv4(), projectId, photoId, itemId, userId);
}

// Contractors may only touch items assigned to them: the destination AND every
// item a photo is being moved away from.
function assertContractorOwnsItems(db, user, itemIds) {
  if (user.role !== 'contractor' || !itemIds.length) return;
  const placeholders = itemIds.map(() => '?').join(',');
  const foreign = db.prepare(`
    SELECT COUNT(*) as cnt FROM punch_list_items
    WHERE id IN (${placeholders}) AND (assigned_to IS NULL OR assigned_to != ?)
  `).get(...itemIds, user.id);
  if (foreign.cnt > 0) {
    const err = new Error('You can only move photos between items assigned to you');
    err.statusCode = 403;
    throw err;
  }
}

// Shared by the single PUT and the batch POST below. Validates everything
// first, then writes all links in one transaction (all or nothing).
function attachPhotosToItem(db, { projectId, itemId, photoIds, user }) {
  const item = db.prepare('SELECT id, title, assigned_to FROM punch_list_items WHERE id = ? AND project_id = ?').get(itemId, projectId);
  if (!item) {
    const err = new Error('Punch list item not found');
    err.statusCode = 404;
    throw err;
  }
  const links = photoIds.map(photoId => collectPunchPhotoLinks(db, projectId, photoId, item.id));
  assertContractorOwnsItems(db, user, Array.from(new Set([item.id, ...links.flatMap(link => link.movedFrom)])));
  db.transaction(() => {
    links.forEach(link => applyPunchPhotoLink(db, projectId, link.photoId, item.id, user.id));
  })();
  return { item, results: links.map(link => ({ photo_id: link.photoId, moved_from: link.movedFrom })) };
}

function normalizePhotoIdList(value) {
  const raw = Array.isArray(value) ? value : [];
  return Array.from(new Set(raw.map(id => String(id || '').trim()).filter(Boolean)));
}

// PUT /api/projects/:projectId/punch-list/:id/photos/:photoId
// Attach a project photo to THIS punch item, moving it off any other punch
// item it was matched to (a bulk upload dropped on the wrong line, or a photo
// dragged between rows). Same role rules as updating the item.
router.put('/:id/photos/:photoId', blockProjectManagerMutation, (req, res) => {
  try {
    const db = getDb();
    const { item, results } = attachPhotosToItem(db, {
      projectId: req.params.projectId,
      itemId: req.params.id,
      photoIds: [String(req.params.photoId || '').trim()],
      user: req.user,
    });
    const [result] = results;
    logActivity({
      userId: req.user.id,
      projectId: req.params.projectId,
      action: 'punch_photo_moved',
      entityType: 'punch_list_item',
      entityId: item.id,
      details: { photo_id: result.photo_id, title: item.title, moved_from: result.moved_from, moved: result.moved_from.length > 0 },
    });
    res.json({
      message: result.moved_from.length ? 'Photo moved' : 'Photo attached',
      photo_id: result.photo_id,
      punch_list_item_id: item.id,
      moved_from: result.moved_from,
    });
  } catch (err) {
    if (!err.statusCode) console.error('Failed to move punch list photo:', err);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to move photo' });
  }
});

// POST /api/projects/:projectId/punch-list/:id/photos   { photo_ids: [...] }
// Batch form of the PUT above: the picture tray drops several pictures on one
// card at once. All-or-nothing — an unknown photo id attaches nothing.
router.post('/:id/photos', blockProjectManagerMutation, (req, res) => {
  try {
    const photoIds = normalizePhotoIdList(req.body?.photo_ids);
    if (!photoIds.length) return res.status(400).json({ error: 'Select at least one photo' });
    if (photoIds.length > 100) return res.status(400).json({ error: 'Attach up to 100 photos at a time' });
    const db = getDb();
    const { item, results } = attachPhotosToItem(db, {
      projectId: req.params.projectId,
      itemId: req.params.id,
      photoIds,
      user: req.user,
    });
    const movedCount = results.filter(result => result.moved_from.length > 0).length;
    logActivity({
      userId: req.user.id,
      projectId: req.params.projectId,
      action: 'punch_photos_attached',
      entityType: 'punch_list_item',
      entityId: item.id,
      details: { count: results.length, moved_count: movedCount, title: item.title },
    });
    res.json({ attached: results.length, moved: movedCount, punch_list_item_id: item.id, results });
  } catch (err) {
    if (!err.statusCode) console.error('Failed to attach punch list photos:', err);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to attach photos' });
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
