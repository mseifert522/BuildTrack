const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate, authorize, authorizeProjectAccess } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

const MANAGEMENT_ROLES = ['super_admin', 'operations_manager', 'project_manager'];
const NOTE_ADMIN_ROLES = ['super_admin', 'operations_manager'];

function canOverrideNoteEdit(req) {
  return NOTE_ADMIN_ROLES.includes(req.user.role);
}
const PROJECT_STATUSES = ['active_rehab', 'rehab_completed'];

function getConstructionPlan(db, projectId) {
  const items = db.prepare(`
    SELECT cpi.*, u.name as assigned_to_name, cb.name as created_by_name
    FROM construction_plan_items cpi
    LEFT JOIN users u ON u.id = cpi.assigned_to
    LEFT JOIN users cb ON cb.id = cpi.created_by
    WHERE cpi.project_id = ?
    ORDER BY cpi.sort_order ASC, datetime(cpi.created_at) ASC
  `).all(projectId);

  return items.map(item => {
    const photos = db.prepare(`
      SELECT id, filename, original_name, caption, created_at
      FROM photos
      WHERE construction_plan_item_id = ?
      ORDER BY datetime(created_at) DESC
    `).all(item.id);
    const materials = db.prepare(`
      SELECT *
      FROM construction_materials
      WHERE plan_item_id = ?
      ORDER BY COALESCE(expected_delivery, needed_by, created_at) ASC
    `).all(item.id);
    return { ...item, photos, materials };
  });
}

function getProjectScopes(db, projectId) {
  return db.prepare(`
    SELECT ps.*, u.name as created_by_name
    FROM project_scopes ps
    LEFT JOIN users u ON u.id = ps.created_by
    WHERE ps.project_id = ?
    ORDER BY ps.sort_order ASC, datetime(ps.created_at) ASC
  `).all(projectId);
}

function lifecycleFromStatus(status, fallback = 'under_construction') {
  switch (status) {
    case 'active_rehab':
      return 'under_construction';
    case 'rehab_completed':
      return 'completed';
    default:
      return fallback && fallback !== 'acquired' ? fallback : 'under_construction';
  }
}

const mainPhotoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../uploads/project-main');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `project-main-${req.params.id}-${Date.now()}${ext}`);
  },
});

const mainPhotoUpload = multer({
  storage: mainPhotoStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files allowed'));
    cb(null, true);
  },
});

function removeOldMainPhoto(url) {
  if (!url || !url.startsWith('/uploads/project-main/')) return;
  const fileName = path.basename(url);
  const filePath = path.join(__dirname, '../../uploads/project-main', fileName);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {
    // Best-effort cleanup; do not block saving the new project photo.
  }
}

const REVIEW_ACTIONS = [
  'project_created',
  'project_updated',
  'project_archived',
  'note_added',
  'note_updated',
  'photos_uploaded',
  'photo_deleted',
  'construction_plan_item_created',
  'construction_plan_item_updated',
  'construction_plan_item_deleted',
  'project_scope_created',
  'project_scope_updated',
  'project_scope_deleted',
  'material_created',
  'material_updated',
  'material_deleted',
  'punch_item_created',
  'punch_item_updated',
  'punch_item_deleted',
  'invoice_created',
  'invoice_submitted',
  'invoice_status_updated',
  'user_assigned',
  'user_unassigned',
];

function parseDetails(details) {
  if (!details) return {};
  try { return JSON.parse(details); } catch (_) { return {}; }
}

function summarizeActivity(row) {
  const details = parseDetails(row.details);
  const notePreview = row.note_text ? `: ${row.note_text}` : '';
  const punchTitle = details.title || row.punch_title;

  switch (row.action) {
    case 'project_created':
      return 'Created the project';
    case 'project_updated':
      return 'Updated project details';
    case 'project_archived':
      return 'Archived the project';
    case 'note_added':
      return `Added a note${notePreview}`;
    case 'note_updated':
      return `Edited a note${notePreview}`;
    case 'photos_uploaded':
      return `Uploaded ${details.count || 1} photo${Number(details.count) === 1 ? '' : 's'}`;
    case 'photo_deleted':
      return 'Deleted a photo';
    case 'construction_plan_item_created':
      return `Added construction plan step${details.title ? `: ${details.title}` : ''}`;
    case 'construction_plan_item_updated':
      return `Updated construction plan step${details.status ? ` to ${String(details.status).replace(/_/g, ' ')}` : ''}`;
    case 'construction_plan_item_deleted':
      return 'Deleted a construction plan step';
    case 'project_scope_created':
      return `Added scope of work${details.scope_title ? `: ${details.scope_title}` : ''}`;
    case 'project_scope_updated':
      return `Updated scope of work${details.scope_title ? `: ${details.scope_title}` : ''}`;
    case 'project_scope_deleted':
      return 'Deleted scope of work';
    case 'material_created':
      return `Added material${details.material_name ? `: ${details.material_name}` : ''}`;
    case 'material_updated':
      return `Updated material${details.order_status ? ` to ${String(details.order_status).replace(/_/g, ' ')}` : ''}`;
    case 'material_deleted':
      return 'Deleted a material';
    case 'punch_item_created':
      return `Added punch list item${punchTitle ? `: ${punchTitle}` : ''}`;
    case 'punch_item_updated':
      return `Updated punch list item${details.status ? ` to ${String(details.status).replace(/_/g, ' ')}` : ''}`;
    case 'punch_item_deleted':
      return 'Deleted a punch list item';
    case 'invoice_created':
      return 'Created an invoice';
    case 'invoice_submitted':
      return 'Submitted an invoice';
    case 'invoice_status_updated':
      return `Updated invoice status${details.status ? ` to ${String(details.status).replace(/_/g, ' ')}` : ''}`;
    case 'user_assigned':
      return 'Assigned a user to the project';
    case 'user_unassigned':
      return 'Removed a user from the project';
    default:
      return row.action.replace(/_/g, ' ');
  }
}

function getUnreviewedProjectSummaries(db, userId, options = {}) {
  const placeholders = REVIEW_ACTIONS.map(() => '?').join(',');
  const recentScope = options.scope === 'recent' ? 1 : 0;
  const rows = db.prepare(`
    SELECT
      al.id,
      al.project_id,
      al.user_id,
      al.action,
      al.entity_type,
      al.entity_id,
      al.details,
      al.created_at,
      u.name as user_name,
      p.address as project_address,
      p.job_name as project_job_name,
      p.status as project_status,
      pn.note as note_text,
      pli.title as punch_title
    FROM activity_log al
    JOIN users u ON u.id = al.user_id
    JOIN projects p ON p.id = al.project_id
    LEFT JOIN project_review_state prs
      ON prs.user_id = ? AND prs.project_id = al.project_id
    LEFT JOIN project_notes pn
      ON pn.id = al.entity_id AND al.entity_type = 'note'
    LEFT JOIN punch_list_items pli
      ON pli.id = al.entity_id AND al.entity_type = 'punch_list_item'
    WHERE al.project_id IS NOT NULL
      AND al.user_id != ?
      AND al.action IN (${placeholders})
      AND (? = 1 OR datetime(al.created_at) > datetime(COALESCE(prs.last_reviewed_at, '1970-01-01 00:00:00')))
      AND (? = 0 OR datetime(al.created_at) > datetime('now', '-30 days'))
    ORDER BY datetime(al.created_at) DESC, al.created_at DESC
    LIMIT 500
  `).all(userId, userId, ...REVIEW_ACTIONS, recentScope, recentScope);

  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.project_id)) {
      grouped.set(row.project_id, {
        project_id: row.project_id,
        project_address: row.project_address,
        project_job_name: row.project_job_name,
        project_status: row.project_status,
        change_count: 0,
        latest_at: row.created_at,
        latest_by: row.user_name,
        changes: [],
      });
    }

    const project = grouped.get(row.project_id);
    project.change_count += 1;
    if (project.changes.length < 6) {
      project.changes.push({
        id: row.id,
        action: row.action,
        user_name: row.user_name,
        created_at: row.created_at,
        summary: summarizeActivity(row),
      });
    }
  }

  return Array.from(grouped.values());
}

// GET /api/projects - list projects (filtered by role)
router.get('/', (req, res) => {
  const db = getDb();
  const { status, search } = req.query;
  let projects;

  if (req.user.role === 'contractor') {
    let query = `
      SELECT p.*, u.name as created_by_name
      FROM projects p
      JOIN project_assignments pa ON pa.project_id = p.id AND pa.user_id = ?
      LEFT JOIN users u ON u.id = p.created_by
      WHERE 1=1
    `;
    const params = [req.user.id];
    if (status) { query += ' AND p.status = ?'; params.push(status); }
    if (search) { query += ' AND (p.address LIKE ? OR p.job_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    query += ' ORDER BY p.updated_at DESC';
    projects = db.prepare(query).all(...params);
  } else {
    let query = `
      SELECT p.*, u.name as created_by_name
      FROM projects p
      LEFT JOIN users u ON u.id = p.created_by
      WHERE 1=1
    `;
    const params = [];
    if (status) { query += ' AND p.status = ?'; params.push(status); }
    if (search) { query += ' AND (p.address LIKE ? OR p.job_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    query += ' ORDER BY p.updated_at DESC';
    projects = db.prepare(query).all(...params);
  }

  // Attach assigned users count
  const enriched = projects.map(p => {
    const assignedCount = db.prepare('SELECT COUNT(*) as cnt FROM project_assignments WHERE project_id = ?').get(p.id);
    const openItems = db.prepare("SELECT COUNT(*) as cnt FROM punch_list_items WHERE project_id = ? AND status != 'completed'").get(p.id);
    return { ...p, assigned_count: assignedCount.cnt, open_punch_items: openItems.cnt };
  });

  res.json(enriched);
});

// GET /api/projects/stats - dashboard stats
router.get('/stats', authorize('super_admin', 'operations_manager', 'project_manager'), (req, res) => {
  const db = getDb();

  // Project status is the operational source of truth for dashboard cards.
  const totalProjects    = db.prepare("SELECT COUNT(*) as cnt FROM projects WHERE status != 'archived'").get();
  const underConstruction = db.prepare("SELECT COUNT(*) as cnt FROM projects WHERE status = 'active_rehab'").get();
  const preConstruction  = db.prepare("SELECT COUNT(*) as cnt FROM projects WHERE status = 'not_started' OR lifecycle_status = 'pre_construction'").get();
  const completed        = db.prepare("SELECT COUNT(*) as cnt FROM projects WHERE status = 'rehab_completed'").get();
  const sold             = { cnt: 0 };
  const occupied         = db.prepare('SELECT COUNT(*) as cnt FROM projects WHERE is_occupied = 1').get();

  // Operational stats
  const openPunch        = db.prepare("SELECT COUNT(*) as cnt FROM punch_list_items WHERE status != 'completed'").get();
  const pendingInvoices  = db.prepare("SELECT COUNT(*) as cnt FROM invoices WHERE status = 'submitted'").get();
  const recentPhotos     = db.prepare("SELECT COUNT(*) as cnt FROM photos WHERE created_at > datetime('now', '-7 days')").get();

  // Total invoice value this month
  const invoiceValue     = db.prepare("SELECT COALESCE(SUM(total),0) as total FROM invoices WHERE status IN ('submitted','approved') AND created_at > datetime('now', 'start of month')").get();

  // Recent projects (last 5)
  const recentProjects   = db.prepare(`
    SELECT p.id, p.address, p.job_name, p.lifecycle_status, p.project_stage, p.updated_at,
           (SELECT COUNT(*) FROM punch_list_items WHERE project_id = p.id AND status != 'completed') as open_punch
    FROM projects p WHERE p.status != 'archived'
    ORDER BY p.updated_at DESC LIMIT 5
  `).all();

  res.json({
    // Lifecycle KPIs
    total_acquisitions: totalProjects.cnt,
    under_construction: underConstruction.cnt,
    pre_construction: preConstruction.cnt,
    completed_projects: completed.cnt,
    sold_projects: sold.cnt,
    occupied_properties: occupied.cnt,
    // Operational
    open_punch_items: openPunch.cnt,
    pending_invoices: pendingInvoices.cnt,
    recent_photos: recentPhotos.cnt,
    monthly_invoice_value: invoiceValue.total,
    recent_projects: recentProjects,
    // Legacy fields for backward compat
    total_projects: totalProjects.cnt,
    active_projects: underConstruction.cnt,
    in_progress_projects: preConstruction.cnt,
  });
});

// GET /api/projects/unreviewed-summary - management-only project changes since each user's last review
router.get('/unreviewed-summary', authorize(...MANAGEMENT_ROLES), (req, res) => {
  const db = getDb();
  res.json({ projects: getUnreviewedProjectSummaries(db, req.user.id, { scope: req.query.scope }) });
});

// GET /api/projects/:id - single project
router.get('/:id', authorizeProjectAccess, (req, res) => {
  const db = getDb();
  const project = db.prepare(`
    SELECT p.*, u.name as created_by_name
    FROM projects p LEFT JOIN users u ON u.id = p.created_by
    WHERE p.id = ?
  `).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const assignments = db.prepare(`
    SELECT pa.*, u.name, u.email, u.role, u.phone
    FROM project_assignments pa JOIN users u ON u.id = pa.user_id
    WHERE pa.project_id = ?
  `).all(req.params.id);

  const punchStats = db.prepare(`
    SELECT status, COUNT(*) as cnt FROM punch_list_items WHERE project_id = ? GROUP BY status
  `).all(req.params.id);

  const recentPhotos = db.prepare(`
    SELECT ph.*, u.name as uploader_name, pc.name as category_name
    FROM photos ph
    LEFT JOIN users u ON u.id = ph.uploaded_by
    LEFT JOIN photo_categories pc ON pc.id = ph.category_id
    WHERE ph.project_id = ?
    ORDER BY ph.created_at DESC LIMIT 6
  `).all(req.params.id);

  const recentInvoices = db.prepare(`
    SELECT i.*, u.name as contractor_name
    FROM invoices i JOIN users u ON u.id = i.contractor_id
    WHERE i.project_id = ?
    ORDER BY i.created_at DESC LIMIT 5
  `).all(req.params.id);

  res.json({ ...project, assignments, punch_stats: punchStats, recent_photos: recentPhotos, recent_invoices: recentInvoices });
});

const PROJECT_SCOPE_STATUSES = ['draft', 'active', 'on_hold', 'completed'];

// GET /api/projects/:id/scopes - multiple scope-of-work sections for the project
router.get('/:id/scopes', authorizeProjectAccess, (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT id, scope_of_work FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({
    scopes: getProjectScopes(db, req.params.id),
    legacy_scope_of_work: project.scope_of_work || '',
  });
});

// POST /api/projects/:id/scopes
router.post('/:id/scopes', authorize(...MANAGEMENT_ROLES), authorizeProjectAccess, (req, res) => {
  try {
    const { section_name, scope_title, scope_of_work, status } = req.body;
    const title = String(scope_title || '').trim();
    const body = String(scope_of_work || '').trim();
    const scopeStatus = PROJECT_SCOPE_STATUSES.includes(String(status || 'active')) ? String(status || 'active') : 'active';
    if (!title) return res.status(400).json({ error: 'Scope title is required' });
    if (!body) return res.status(400).json({ error: 'Scope of work is required' });

    const db = getDb();
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max FROM project_scopes WHERE project_id = ?').get(req.params.id);
    const scopeId = uuidv4();
    db.prepare(`
      INSERT INTO project_scopes (id, project_id, section_name, scope_title, scope_of_work, status, sort_order, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scopeId,
      req.params.id,
      String(section_name || 'General').trim() || 'General',
      title,
      body,
      scopeStatus,
      maxOrder.max + 1,
      req.user.id
    );
    db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(req.params.id);
    logActivity({ userId: req.user.id, projectId: req.params.id, action: 'project_scope_created', entityType: 'project_scope', entityId: scopeId, details: { scope_title: title, section_name } });
    res.status(201).json({ id: scopeId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create scope of work' });
  }
});

// PUT /api/projects/:id/scopes/:scopeId
router.put('/:id/scopes/:scopeId', authorize(...MANAGEMENT_ROLES), authorizeProjectAccess, (req, res) => {
  try {
    const db = getDb();
    const scope = db.prepare('SELECT * FROM project_scopes WHERE id = ? AND project_id = ?').get(req.params.scopeId, req.params.id);
    if (!scope) return res.status(404).json({ error: 'Scope of work not found' });

    const nextStatus = req.body.status !== undefined && PROJECT_SCOPE_STATUSES.includes(String(req.body.status))
      ? String(req.body.status)
      : scope.status;
    const nextTitle = req.body.scope_title !== undefined ? String(req.body.scope_title || '').trim() : scope.scope_title;
    const nextScope = req.body.scope_of_work !== undefined ? String(req.body.scope_of_work || '').trim() : scope.scope_of_work;
    if (!nextTitle) return res.status(400).json({ error: 'Scope title is required' });
    if (!nextScope) return res.status(400).json({ error: 'Scope of work is required' });

    db.prepare(`
      UPDATE project_scopes
      SET section_name = ?, scope_title = ?, scope_of_work = ?, status = ?, updated_at = datetime('now')
      WHERE id = ? AND project_id = ?
    `).run(
      req.body.section_name !== undefined ? (String(req.body.section_name || '').trim() || 'General') : scope.section_name,
      nextTitle,
      nextScope,
      nextStatus,
      req.params.scopeId,
      req.params.id
    );
    db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(req.params.id);
    logActivity({ userId: req.user.id, projectId: req.params.id, action: 'project_scope_updated', entityType: 'project_scope', entityId: req.params.scopeId, details: { scope_title: nextTitle, status: nextStatus } });
    res.json({ message: 'Scope of work updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update scope of work' });
  }
});

// POST /api/projects/:id/scopes/:scopeId/move
router.post('/:id/scopes/:scopeId/move', authorize(...MANAGEMENT_ROLES), authorizeProjectAccess, (req, res) => {
  try {
    const { direction } = req.body;
    if (!['up', 'down'].includes(direction)) return res.status(400).json({ error: 'Direction must be up or down' });

    const db = getDb();
    const scope = db.prepare('SELECT * FROM project_scopes WHERE id = ? AND project_id = ?').get(req.params.scopeId, req.params.id);
    if (!scope) return res.status(404).json({ error: 'Scope of work not found' });

    const neighbor = direction === 'up'
      ? db.prepare('SELECT * FROM project_scopes WHERE project_id = ? AND sort_order < ? ORDER BY sort_order DESC LIMIT 1').get(req.params.id, scope.sort_order)
      : db.prepare('SELECT * FROM project_scopes WHERE project_id = ? AND sort_order > ? ORDER BY sort_order ASC LIMIT 1').get(req.params.id, scope.sort_order);
    if (!neighbor) return res.json({ message: 'Scope is already at boundary' });

    const update = db.prepare("UPDATE project_scopes SET sort_order = ?, updated_at = datetime('now') WHERE id = ?");
    update.run(neighbor.sort_order, scope.id);
    update.run(scope.sort_order, neighbor.id);
    db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(req.params.id);
    res.json({ message: 'Scope order updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reorder scope of work' });
  }
});

// DELETE /api/projects/:id/scopes/:scopeId
router.delete('/:id/scopes/:scopeId', authorize(...MANAGEMENT_ROLES), authorizeProjectAccess, (req, res) => {
  const db = getDb();
  const scope = db.prepare('SELECT * FROM project_scopes WHERE id = ? AND project_id = ?').get(req.params.scopeId, req.params.id);
  if (!scope) return res.status(404).json({ error: 'Scope of work not found' });
  db.prepare('DELETE FROM project_scopes WHERE id = ? AND project_id = ?').run(req.params.scopeId, req.params.id);
  db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  logActivity({ userId: req.user.id, projectId: req.params.id, action: 'project_scope_deleted', entityType: 'project_scope', entityId: req.params.scopeId, details: { scope_title: scope.scope_title } });
  res.json({ message: 'Scope of work deleted' });
});

// GET /api/projects/:id/construction-plan - ordered rehab plan with linked supplies
router.get('/:id/construction-plan', authorizeProjectAccess, (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT id, created_by FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({ items: getConstructionPlan(db, req.params.id) });
});

// POST /api/projects/:id/construction-plan
router.post('/:id/construction-plan', authorize(...MANAGEMENT_ROLES), authorizeProjectAccess, (req, res) => {
  try {
    const { title, description, category, status, assigned_to, start_date, target_date } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });

    const db = getDb();
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max FROM construction_plan_items WHERE project_id = ?').get(req.params.id);
    const itemId = uuidv4();
    db.prepare(`
      INSERT INTO construction_plan_items (id, project_id, title, description, category, status, sort_order, assigned_to, start_date, target_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      itemId,
      req.params.id,
      title.trim(),
      description || null,
      category ? String(category).trim() : '',
      status || 'not_started',
      maxOrder.max + 1,
      assigned_to || null,
      start_date || null,
      target_date || null,
      req.user.id
    );

    logActivity({ userId: req.user.id, projectId: req.params.id, action: 'construction_plan_item_created', entityType: 'construction_plan_item', entityId: itemId, details: { title: title.trim() } });
    res.status(201).json({ id: itemId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create construction plan item' });
  }
});

// PUT /api/projects/:id/construction-plan/:itemId
router.put('/:id/construction-plan/:itemId', authorize(...MANAGEMENT_ROLES), authorizeProjectAccess, (req, res) => {
  try {
    const db = getDb();
    const item = db.prepare('SELECT * FROM construction_plan_items WHERE id = ? AND project_id = ?').get(req.params.itemId, req.params.id);
    if (!item) return res.status(404).json({ error: 'Construction plan item not found' });

    const { title, description, category, status, assigned_to, start_date, target_date } = req.body;
    const completedAt = status === 'completed' && item.status !== 'completed'
      ? new Date().toISOString()
      : (status && status !== 'completed' ? null : item.completed_at);

    db.prepare(`
      UPDATE construction_plan_items
      SET title = ?, description = ?, category = ?, status = ?, assigned_to = ?, start_date = ?, target_date = ?, completed_at = ?, updated_at = datetime('now')
      WHERE id = ? AND project_id = ?
    `).run(
      title ?? item.title,
      description !== undefined ? description : item.description,
      category !== undefined ? String(category || '').trim() : item.category,
      status ?? item.status,
      assigned_to !== undefined ? assigned_to : item.assigned_to,
      start_date !== undefined ? start_date : item.start_date,
      target_date !== undefined ? target_date : item.target_date,
      completedAt,
      req.params.itemId,
      req.params.id
    );

    logActivity({ userId: req.user.id, projectId: req.params.id, action: 'construction_plan_item_updated', entityType: 'construction_plan_item', entityId: req.params.itemId, details: { status } });
    res.json({ message: 'Construction plan item updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update construction plan item' });
  }
});

// POST /api/projects/:id/construction-plan/:itemId/move
router.post('/:id/construction-plan/:itemId/move', authorize(...MANAGEMENT_ROLES), authorizeProjectAccess, (req, res) => {
  try {
    const { direction } = req.body;
    if (!['up', 'down'].includes(direction)) return res.status(400).json({ error: 'Direction must be up or down' });

    const db = getDb();
    const item = db.prepare('SELECT * FROM construction_plan_items WHERE id = ? AND project_id = ?').get(req.params.itemId, req.params.id);
    if (!item) return res.status(404).json({ error: 'Construction plan item not found' });

    const neighbor = direction === 'up'
      ? db.prepare('SELECT * FROM construction_plan_items WHERE project_id = ? AND sort_order < ? ORDER BY sort_order DESC LIMIT 1').get(req.params.id, item.sort_order)
      : db.prepare('SELECT * FROM construction_plan_items WHERE project_id = ? AND sort_order > ? ORDER BY sort_order ASC LIMIT 1').get(req.params.id, item.sort_order);

    if (!neighbor) return res.json({ message: 'Item already at boundary' });

    const update = db.prepare('UPDATE construction_plan_items SET sort_order = ?, updated_at = datetime(\'now\') WHERE id = ?');
    update.run(neighbor.sort_order, item.id);
    update.run(item.sort_order, neighbor.id);
    res.json({ message: 'Construction plan order updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reorder construction plan item' });
  }
});

// DELETE /api/projects/:id/construction-plan/:itemId
router.delete('/:id/construction-plan/:itemId', authorize(...MANAGEMENT_ROLES), authorizeProjectAccess, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM construction_plan_items WHERE id = ? AND project_id = ?').run(req.params.itemId, req.params.id);
  logActivity({ userId: req.user.id, projectId: req.params.id, action: 'construction_plan_item_deleted', entityType: 'construction_plan_item', entityId: req.params.itemId });
  res.json({ message: 'Construction plan item deleted' });
});

// GET /api/projects/:id/materials
router.get('/:id/materials', authorizeProjectAccess, (req, res) => {
  const db = getDb();
  const materials = db.prepare(`
    SELECT cm.*, cpi.title as plan_item_title
    FROM construction_materials cm
    LEFT JOIN construction_plan_items cpi ON cpi.id = cm.plan_item_id
    WHERE cm.project_id = ?
    ORDER BY COALESCE(cm.expected_delivery, cm.needed_by, cm.created_at) ASC
  `).all(req.params.id);
  res.json(materials);
});

// POST /api/projects/:id/materials
router.post('/:id/materials', authorize(...MANAGEMENT_ROLES), authorizeProjectAccess, (req, res) => {
  try {
    const {
      plan_item_id, material_name, category, quantity, unit, estimated_cost, actual_cost,
      supplier, order_status, needed_by, expected_delivery, delivered_at, notes
    } = req.body;
    if (!material_name || !material_name.trim()) return res.status(400).json({ error: 'Material name is required' });

    const db = getDb();
    const materialId = uuidv4();
    db.prepare(`
      INSERT INTO construction_materials (
        id, project_id, plan_item_id, material_name, category, quantity, unit, estimated_cost, actual_cost,
        supplier, order_status, needed_by, expected_delivery, delivered_at, notes, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      materialId,
      req.params.id,
      plan_item_id || null,
      material_name.trim(),
      category ? String(category).trim() : '',
      quantity || null,
      unit || null,
      estimated_cost || null,
      actual_cost || null,
      supplier || null,
      order_status || 'planned',
      needed_by || null,
      expected_delivery || null,
      delivered_at || null,
      notes || null,
      req.user.id
    );
    logActivity({ userId: req.user.id, projectId: req.params.id, action: 'material_created', entityType: 'construction_material', entityId: materialId, details: { material_name: material_name.trim() } });
    res.status(201).json({ id: materialId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create material' });
  }
});

// PUT /api/projects/:id/materials/:materialId
router.put('/:id/materials/:materialId', authorize(...MANAGEMENT_ROLES), authorizeProjectAccess, (req, res) => {
  try {
    const db = getDb();
    const material = db.prepare('SELECT * FROM construction_materials WHERE id = ? AND project_id = ?').get(req.params.materialId, req.params.id);
    if (!material) return res.status(404).json({ error: 'Material not found' });

    const fields = [
      'plan_item_id', 'material_name', 'category', 'quantity', 'unit', 'estimated_cost', 'actual_cost',
      'supplier', 'order_status', 'needed_by', 'expected_delivery', 'delivered_at', 'notes'
    ];
    const next = {};
    for (const field of fields) next[field] = req.body[field] !== undefined ? req.body[field] : material[field];

    db.prepare(`
      UPDATE construction_materials
      SET plan_item_id = ?, material_name = ?, category = ?, quantity = ?, unit = ?, estimated_cost = ?, actual_cost = ?,
          supplier = ?, order_status = ?, needed_by = ?, expected_delivery = ?, delivered_at = ?, notes = ?, updated_at = datetime('now')
      WHERE id = ? AND project_id = ?
    `).run(
      next.plan_item_id || null,
      next.material_name,
      next.category ? String(next.category).trim() : '',
      next.quantity || null,
      next.unit || null,
      next.estimated_cost || null,
      next.actual_cost || null,
      next.supplier || null,
      next.order_status || 'planned',
      next.needed_by || null,
      next.expected_delivery || null,
      next.delivered_at || null,
      next.notes || null,
      req.params.materialId,
      req.params.id
    );
    logActivity({ userId: req.user.id, projectId: req.params.id, action: 'material_updated', entityType: 'construction_material', entityId: req.params.materialId, details: { order_status: next.order_status } });
    res.json({ message: 'Material updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update material' });
  }
});

router.delete('/:id/materials/:materialId', authorize(...MANAGEMENT_ROLES), authorizeProjectAccess, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM construction_materials WHERE id = ? AND project_id = ?').run(req.params.materialId, req.params.id);
  logActivity({ userId: req.user.id, projectId: req.params.id, action: 'material_deleted', entityType: 'construction_material', entityId: req.params.materialId });
  res.json({ message: 'Material deleted' });
});

// POST /api/projects/:id/main-photo - upload one primary house photo for project cards
router.post('/:id/main-photo', authorize(...MANAGEMENT_ROLES), authorizeProjectAccess, (req, res) => {
  mainPhotoUpload.single('photo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

    try {
      const db = getDb();
      const project = db.prepare('SELECT id, main_photo_url FROM projects WHERE id = ?').get(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const mainPhotoUrl = `/uploads/project-main/${req.file.filename}`;
      db.prepare("UPDATE projects SET main_photo_url = ?, updated_at = datetime('now') WHERE id = ?").run(mainPhotoUrl, req.params.id);
      removeOldMainPhoto(project.main_photo_url);
      logActivity({
        userId: req.user.id,
        projectId: req.params.id,
        action: 'project_updated',
        entityType: 'project',
        entityId: req.params.id,
        details: { main_photo_updated: true },
      });
      res.json({ main_photo_url: mainPhotoUrl, message: 'Project photo updated' });
    } catch (saveErr) {
      console.error(saveErr);
      res.status(500).json({ error: 'Failed to save project photo' });
    }
  });
});

// POST /api/projects/:id/reviewed - mark current project changes reviewed for this user
router.post('/:id/reviewed', authorize(...MANAGEMENT_ROLES), authorizeProjectAccess, (req, res) => {
  const db = getDb();
  const reviewedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO project_review_state (user_id, project_id, last_reviewed_at, created_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(user_id, project_id) DO UPDATE SET
      last_reviewed_at = excluded.last_reviewed_at,
      updated_at = datetime('now')
  `).run(req.user.id, req.params.id, reviewedAt);
  res.json({ project_id: req.params.id, last_reviewed_at: reviewedAt });
});

// POST /api/projects - create project
router.post('/', authorize('super_admin', 'operations_manager', 'project_manager'), (req, res) => {
  try {
    const {
      address, job_name, status, start_date, target_completion, scope_of_work, budget,
      project_stage, office_notes, field_notes,
      lifecycle_status, is_occupied, construction_start_date, acquisition_date,
      sold_date, occupant_vacate_date, sale_price, purchase_price, arv, closing_costs, lockbox_code
    } = req.body;
    if (!address || !job_name) return res.status(400).json({ error: 'Address and job name are required' });

    const db = getDb();
    const id = uuidv4();
    const projectStatus = status || 'active_rehab';
    if (!PROJECT_STATUSES.includes(projectStatus)) {
      return res.status(400).json({ error: 'Invalid project status' });
    }
    const projectLifecycle = lifecycle_status && lifecycle_status !== 'acquired'
      ? lifecycle_status
      : lifecycleFromStatus(projectStatus);
    db.prepare(`
      INSERT INTO projects (
        id, address, job_name, status, start_date, target_completion, scope_of_work, budget,
        project_stage, office_notes, field_notes, created_by,
        lifecycle_status, is_occupied, construction_start_date, acquisition_date,
        sold_date, occupant_vacate_date, sale_price, purchase_price, arv, closing_costs, lockbox_code,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      id, address, job_name, projectStatus,
      start_date || null, target_completion || null, scope_of_work || null, budget || null,
      project_stage || null, office_notes || null, field_notes || null, req.user.id,
      projectLifecycle, is_occupied ? 1 : 0,
      construction_start_date || null, acquisition_date || null,
      sold_date || null, occupant_vacate_date || null,
      sale_price || null, purchase_price || null, arv || null, closing_costs || null, lockbox_code || null
    );

    // Create default photo categories
    const defaultCategories = ['Demo', 'Framing', 'Electrical', 'Plumbing', 'Drywall', 'Flooring', 'Painting', 'Exterior', 'Final'];
    const insertCat = db.prepare('INSERT INTO photo_categories (id, project_id, name, created_by) VALUES (?, ?, ?, ?)');
    for (const cat of defaultCategories) {
      insertCat.run(uuidv4(), id, cat, req.user.id);
    }

    if (scope_of_work && String(scope_of_work).trim()) {
      db.prepare(`
        INSERT INTO project_scopes (id, project_id, section_name, scope_title, scope_of_work, status, sort_order, created_by)
        VALUES (?, ?, 'General', 'Initial Scope of Work', ?, 'active', 1, ?)
      `).run(uuidv4(), id, String(scope_of_work).trim(), req.user.id);
    }

    logActivity({ userId: req.user.id, projectId: id, action: 'project_created', entityType: 'project', entityId: id, details: { address, job_name, status: projectStatus, lifecycle_status: projectLifecycle } });

    res.status(201).json({ id, address, job_name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// PUT /api/projects/:id - update project
router.put('/:id', authorize('super_admin', 'operations_manager', 'project_manager'), authorizeProjectAccess, (req, res) => {
  try {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const {
      address, job_name, status, start_date, target_completion, scope_of_work, budget,
      project_stage, office_notes, field_notes,
      lifecycle_status, is_occupied, construction_start_date, acquisition_date,
      sold_date, occupant_vacate_date, sale_price, purchase_price, arv, closing_costs, lockbox_code
    } = req.body;

    // Log lifecycle status change
    const prevLifecycle = project.lifecycle_status;
    const nextStatus = status ?? project.status;
    if (!PROJECT_STATUSES.includes(nextStatus)) {
      return res.status(400).json({ error: 'Invalid project status' });
    }
    const newLifecycle = lifecycle_status && lifecycle_status !== 'acquired'
      ? lifecycle_status
      : lifecycleFromStatus(nextStatus, project.lifecycle_status);

    db.prepare(`
      UPDATE projects SET
        address = ?, job_name = ?, status = ?, start_date = ?, target_completion = ?,
        scope_of_work = ?, budget = ?, project_stage = ?, office_notes = ?, field_notes = ?,
        lifecycle_status = ?, is_occupied = ?, construction_start_date = ?, acquisition_date = ?,
        sold_date = ?, occupant_vacate_date = ?, sale_price = ?, purchase_price = ?, arv = ?, closing_costs = ?, lockbox_code = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      address ?? project.address, job_name ?? project.job_name, nextStatus,
      start_date ?? project.start_date, target_completion ?? project.target_completion,
      scope_of_work ?? project.scope_of_work, budget ?? project.budget, project_stage ?? project.project_stage,
      office_notes ?? project.office_notes, field_notes ?? project.field_notes,
      newLifecycle,
      is_occupied !== undefined ? (is_occupied ? 1 : 0) : project.is_occupied,
      construction_start_date !== undefined ? construction_start_date : project.construction_start_date,
      acquisition_date !== undefined ? acquisition_date : project.acquisition_date,
      sold_date !== undefined ? sold_date : project.sold_date,
      occupant_vacate_date !== undefined ? occupant_vacate_date : project.occupant_vacate_date,
      sale_price !== undefined ? sale_price : project.sale_price,
      purchase_price !== undefined ? purchase_price : project.purchase_price,
      arv !== undefined ? arv : project.arv,
      closing_costs !== undefined ? closing_costs : project.closing_costs,
      lockbox_code !== undefined ? lockbox_code : project.lockbox_code,
      req.params.id
    );

    if (scope_of_work !== undefined && String(scope_of_work || '').trim()) {
      const scopeCount = db.prepare('SELECT COUNT(*) as count FROM project_scopes WHERE project_id = ?').get(req.params.id).count;
      if (scopeCount === 0) {
        db.prepare(`
          INSERT INTO project_scopes (id, project_id, section_name, scope_title, scope_of_work, status, sort_order, created_by)
          VALUES (?, ?, 'General', 'Project Scope of Work', ?, 'active', 1, ?)
        `).run(uuidv4(), req.params.id, String(scope_of_work).trim(), req.user.id);
      }
    }

    const details = { status: nextStatus, lifecycle_status: newLifecycle };
    if (prevLifecycle !== newLifecycle) details.previous_lifecycle = prevLifecycle;
    logActivity({ userId: req.user.id, projectId: req.params.id, action: 'project_updated', entityType: 'project', entityId: req.params.id, details });
    res.json({ message: 'Project updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update project' });
  }
});

// DELETE /api/projects/:id - archive project
router.delete('/:id', authorize('super_admin'), (req, res) => {
  const db = getDb();
  db.prepare("UPDATE projects SET status = 'archived', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  logActivity({ userId: req.user.id, projectId: req.params.id, action: 'project_archived', entityType: 'project', entityId: req.params.id });
  res.json({ message: 'Project archived' });
});

// POST /api/projects/:id/assign - assign user to project
router.post('/:id/assign', authorize('super_admin', 'operations_manager', 'project_manager'), (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    const db = getDb();
    const existing = db.prepare('SELECT id FROM project_assignments WHERE project_id = ? AND user_id = ?').get(req.params.id, user_id);
    if (existing) return res.status(409).json({ error: 'User already assigned' });
    db.prepare('INSERT INTO project_assignments (id, project_id, user_id, assigned_by) VALUES (?, ?, ?, ?)')
      .run(uuidv4(), req.params.id, user_id, req.user.id);
    logActivity({ userId: req.user.id, projectId: req.params.id, action: 'user_assigned', entityType: 'project', entityId: req.params.id, details: { user_id } });
    res.status(201).json({ message: 'User assigned' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to assign user' });
  }
});

// DELETE /api/projects/:id/assign/:userId - remove assignment
router.delete('/:id/assign/:userId', authorize('super_admin', 'operations_manager', 'project_manager'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM project_assignments WHERE project_id = ? AND user_id = ?').run(req.params.id, req.params.userId);
  logActivity({ userId: req.user.id, projectId: req.params.id, action: 'user_unassigned', entityType: 'project', entityId: req.params.id });
  res.json({ message: 'User removed from project' });
});

// GET /api/projects/:id/activity - activity log for project
router.get('/:id/activity', authorizeProjectAccess, (req, res) => {
  const db = getDb();
  const logs = db.prepare(`
    SELECT al.*, u.name as user_name
    FROM activity_log al JOIN users u ON u.id = al.user_id
    WHERE al.project_id = ?
    ORDER BY al.created_at DESC LIMIT 50
  `).all(req.params.id);
  res.json(logs);
});

// GET /api/projects/:id/notes - get project notes
router.get('/:id/notes', authorizeProjectAccess, (req, res) => {
  const db = getDb();
  const notes = db.prepare(`
    SELECT
      pn.*,
      u.name as user_name,
      u.role as user_role,
      u.avatar_url as user_avatar_url,
      eu.name as edited_by_name,
      ph.id as photo_id,
      ph.filename as photo_filename,
      ph.original_name as photo_original_name,
      ph.caption as photo_caption
    FROM project_notes pn
    JOIN users u ON u.id = pn.user_id
    LEFT JOIN users eu ON eu.id = pn.edited_by
    LEFT JOIN photos ph ON ph.note_id = pn.id
    WHERE pn.project_id = ?
      AND (
        ? != 'contractor'
        OR pn.user_id = ?
        OR pn.visibility = 'public'
      )
    ORDER BY datetime(pn.created_at) DESC, pn.created_at DESC
  `).all(req.params.id, req.user.role, req.user.id);
  res.json(notes);
});

// POST /api/projects/:id/notes - add note
router.post('/:id/notes', authorizeProjectAccess, (req, res) => {
  const { note, note_type, visibility } = req.body;
  if (!note) return res.status(400).json({ error: 'Note content required' });
  const db = getDb();
  const id = uuidv4();
  const noteVisibility = req.user.role === 'contractor'
    ? 'private'
    : (visibility === 'public' ? 'public' : 'private');
  db.prepare('INSERT INTO project_notes (id, project_id, user_id, note, note_type, visibility) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.params.id, req.user.id, note, note_type || 'general', noteVisibility);
  logActivity({ userId: req.user.id, projectId: req.params.id, action: 'note_added', entityType: 'note', entityId: id });
  res.status(201).json({
    id,
    project_id: req.params.id,
    user_id: req.user.id,
    user_name: req.user.name,
    user_role: req.user.role,
    user_avatar_url: req.user.avatar_url || null,
    note,
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
    created_at: new Date().toISOString(),
  });
});

// PUT /api/projects/:id/notes/:noteId - users may edit their own note one time; admins can correct notes.
router.put('/:id/notes/:noteId', authorizeProjectAccess, (req, res) => {
  const { note, note_type, visibility } = req.body;
  if (!note || !note.trim()) return res.status(400).json({ error: 'Note content required' });

  const db = getDb();
  const existing = db.prepare('SELECT * FROM project_notes WHERE id = ? AND project_id = ?').get(req.params.noteId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Note not found' });
  const isOwner = existing.user_id === req.user.id;
  const canOverride = canOverrideNoteEdit(req);
  if (!isOwner && !canOverride) {
    return res.status(403).json({ error: 'You can only edit your own notes' });
  }
  if (!canOverride && Number(existing.edit_count || 0) >= 1) {
    return res.status(403).json({ error: 'This note has already been edited once' });
  }

  const editedAt = new Date().toISOString();
  const nextVisibility = req.user.role === 'contractor'
    ? 'private'
    : (visibility === 'public' ? 'public' : visibility === 'private' ? 'private' : existing.visibility || 'private');
  db.prepare(`
    UPDATE project_notes
    SET note = ?, note_type = ?, visibility = ?, edited_at = ?, edited_by = ?, edit_count = edit_count + 1
    WHERE id = ? AND project_id = ?
  `).run(note.trim(), note_type || existing.note_type || 'general', nextVisibility, editedAt, req.user.id, req.params.noteId, req.params.id);

  logActivity({ userId: req.user.id, projectId: req.params.id, action: 'note_updated', entityType: 'note', entityId: req.params.noteId });

  const updated = db.prepare(`
    SELECT
      pn.*,
      u.name as user_name,
      u.role as user_role,
      u.avatar_url as user_avatar_url,
      eu.name as edited_by_name,
      ph.id as photo_id,
      ph.filename as photo_filename,
      ph.original_name as photo_original_name,
      ph.caption as photo_caption
    FROM project_notes pn
    JOIN users u ON u.id = pn.user_id
    LEFT JOIN users eu ON eu.id = pn.edited_by
    LEFT JOIN photos ph ON ph.note_id = pn.id
    WHERE pn.id = ? AND pn.project_id = ?
  `).get(req.params.noteId, req.params.id);

  res.json(updated);
});

module.exports = router;
