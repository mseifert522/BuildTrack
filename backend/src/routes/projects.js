const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate, authorize, authorizeProjectAccess } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

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

  // Lifecycle KPI counts
  const totalAcquired    = db.prepare("SELECT COUNT(*) as cnt FROM projects WHERE lifecycle_status != 'archived'").get();
  const underConstruction = db.prepare("SELECT COUNT(*) as cnt FROM projects WHERE lifecycle_status = 'under_construction'").get();
  const preConstruction  = db.prepare("SELECT COUNT(*) as cnt FROM projects WHERE lifecycle_status = 'pre_construction'").get();
  const completed        = db.prepare("SELECT COUNT(*) as cnt FROM projects WHERE lifecycle_status = 'completed'").get();
  const sold             = db.prepare("SELECT COUNT(*) as cnt FROM projects WHERE lifecycle_status = 'sold'").get();
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
    FROM projects p WHERE p.lifecycle_status != 'archived'
    ORDER BY p.updated_at DESC LIMIT 5
  `).all();

  res.json({
    // Lifecycle KPIs
    total_acquisitions: totalAcquired.cnt,
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
    total_projects: totalAcquired.cnt,
    active_projects: underConstruction.cnt,
    in_progress_projects: preConstruction.cnt,
  });
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

// POST /api/projects - create project
router.post('/', authorize('super_admin', 'operations_manager', 'project_manager'), (req, res) => {
  try {
    const {
      address, job_name, status, start_date, target_completion, scope_of_work, budget,
      project_stage, office_notes, field_notes,
      lifecycle_status, is_occupied, construction_start_date, acquisition_date,
      sold_date, occupant_vacate_date, sale_price, purchase_price
    } = req.body;
    if (!address || !job_name) return res.status(400).json({ error: 'Address and job name are required' });

    const db = getDb();
    const id = uuidv4();
    db.prepare(`
      INSERT INTO projects (
        id, address, job_name, status, start_date, target_completion, scope_of_work, budget,
        project_stage, office_notes, field_notes, created_by,
        lifecycle_status, is_occupied, construction_start_date, acquisition_date,
        sold_date, occupant_vacate_date, sale_price, purchase_price
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, address, job_name, status || 'active',
      start_date || null, target_completion || null, scope_of_work || null, budget || null,
      project_stage || null, office_notes || null, field_notes || null, req.user.id,
      lifecycle_status || 'acquired', is_occupied ? 1 : 0,
      construction_start_date || null, acquisition_date || null,
      sold_date || null, occupant_vacate_date || null,
      sale_price || null, purchase_price || null
    );

    // Create default photo categories
    const defaultCategories = ['Demo', 'Framing', 'Electrical', 'Plumbing', 'Drywall', 'Flooring', 'Painting', 'Exterior', 'Final'];
    const insertCat = db.prepare('INSERT INTO photo_categories (id, project_id, name, created_by) VALUES (?, ?, ?, ?)');
    for (const cat of defaultCategories) {
      insertCat.run(uuidv4(), id, cat, req.user.id);
    }

    logActivity({ userId: req.user.id, projectId: id, action: 'project_created', entityType: 'project', entityId: id, details: { address, job_name, lifecycle_status: lifecycle_status || 'acquired' } });

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
      sold_date, occupant_vacate_date, sale_price, purchase_price
    } = req.body;

    // Log lifecycle status change
    const prevLifecycle = project.lifecycle_status;
    const newLifecycle = lifecycle_status ?? project.lifecycle_status;

    db.prepare(`
      UPDATE projects SET
        address = ?, job_name = ?, status = ?, start_date = ?, target_completion = ?,
        scope_of_work = ?, budget = ?, project_stage = ?, office_notes = ?, field_notes = ?,
        lifecycle_status = ?, is_occupied = ?, construction_start_date = ?, acquisition_date = ?,
        sold_date = ?, occupant_vacate_date = ?, sale_price = ?, purchase_price = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      address ?? project.address, job_name ?? project.job_name, status ?? project.status,
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
      req.params.id
    );

    const details = { lifecycle_status: newLifecycle };
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
    SELECT pn.*, u.name as user_name
    FROM project_notes pn JOIN users u ON u.id = pn.user_id
    WHERE pn.project_id = ?
    ORDER BY pn.created_at DESC
  `).all(req.params.id);
  res.json(notes);
});

// POST /api/projects/:id/notes - add note
router.post('/:id/notes', authorizeProjectAccess, (req, res) => {
  const { note, note_type } = req.body;
  if (!note) return res.status(400).json({ error: 'Note content required' });
  const db = getDb();
  const id = uuidv4();
  db.prepare('INSERT INTO project_notes (id, project_id, user_id, note, note_type) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.params.id, req.user.id, note, note_type || 'general');
  logActivity({ userId: req.user.id, projectId: req.params.id, action: 'note_added', entityType: 'note', entityId: id });
  res.status(201).json({ id, note, note_type: note_type || 'general' });
});

module.exports = router;
