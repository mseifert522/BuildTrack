const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate, authorize, authorizeProjectAccess } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

const MANAGEMENT_ROLES = ['super_admin', 'operations_manager', 'project_manager'];
const TASK_STATUSES = new Set(['not_started', 'in_progress', 'waiting_materials', 'needs_review', 'completed']);
const VERIFICATION_STATUSES = new Set(['not_requested', 'pending_review', 'approved', 'rejected']);
const INVOICE_STATUSES = new Set(['not_received', 'received', 'approval_needed', 'approved_for_payment', 'paid']);

function isManagement(user) {
  return MANAGEMENT_ROLES.includes(user?.role);
}

function normalizeEnum(value, allowed, fallback) {
  const requested = String(value || '').trim();
  return allowed.has(requested) ? requested : fallback;
}

function accessJoin(req, projectAlias = 'p') {
  if (isManagement(req.user)) return { sql: '', params: [] };
  return {
    sql: `JOIN project_assignments fw_pa ON fw_pa.project_id = ${projectAlias}.id AND fw_pa.user_id = ?`,
    params: [req.user.id],
  };
}

function decorateTask(row) {
  const invoiceBlocksPayment = ['received', 'approval_needed'].includes(row.invoice_status)
    && row.verification_status !== 'approved';
  const dueSoon = row.target_date
    ? new Date(row.target_date).getTime() <= Date.now() + (7 * 24 * 60 * 60 * 1000)
    : false;

  let alert_level = 'normal';
  if (invoiceBlocksPayment || row.status === 'needs_review' || row.verification_status === 'rejected') {
    alert_level = 'critical';
  } else if (row.status === 'in_progress' || row.status === 'waiting_materials' || dueSoon) {
    alert_level = 'attention';
  }

  return { ...row, invoice_blocks_payment: invoiceBlocksPayment ? 1 : 0, alert_level };
}

function taskSelectSql() {
  return `
    SELECT
      cpi.*,
      p.address as project_address,
      p.job_name as project_job_name,
      p.status as project_status,
      assignee.name as assigned_to_name,
      creator.name as created_by_name,
      approver.name as approved_by_name,
      (SELECT COUNT(*) FROM photos ph WHERE ph.construction_plan_item_id = cpi.id) as photo_count,
      (SELECT COUNT(*) FROM project_notes pn WHERE pn.project_id = cpi.project_id AND pn.note_type = 'field' AND datetime(pn.created_at) > datetime('now', '-7 days')) as recent_field_note_count
    FROM construction_plan_items cpi
    JOIN projects p ON p.id = cpi.project_id
    LEFT JOIN users assignee ON assignee.id = cpi.assigned_to
    LEFT JOIN users creator ON creator.id = cpi.created_by
    LEFT JOIN users approver ON approver.id = cpi.approved_by
  `;
}

function getWatchlist(req) {
  const db = getDb();
  const access = accessJoin(req);

  const watchTasks = db.prepare(`
    ${taskSelectSql()}
    ${access.sql}
    WHERE p.status != 'archived'
      AND (
        cpi.status IN ('in_progress','waiting_materials','needs_review')
        OR (cpi.status != 'completed' AND cpi.target_date IS NOT NULL AND datetime(cpi.target_date) <= datetime('now', '+7 days'))
        OR (cpi.invoice_status IN ('received','approval_needed') AND cpi.verification_status != 'approved')
        OR cpi.verification_status IN ('pending_review','rejected')
      )
    ORDER BY
      CASE
        WHEN cpi.invoice_status IN ('received','approval_needed') AND cpi.verification_status != 'approved' THEN 0
        WHEN cpi.status = 'needs_review' OR cpi.verification_status IN ('pending_review','rejected') THEN 1
        WHEN cpi.status IN ('in_progress','waiting_materials') THEN 2
        ELSE 3
      END,
      datetime(COALESCE(cpi.target_date, cpi.updated_at, cpi.created_at)) ASC
    LIMIT 80
  `).all(...access.params).map(decorateTask);

  const fieldNotes = db.prepare(`
    SELECT
      pn.id,
      pn.project_id,
      pn.note,
      pn.created_at,
      u.name as user_name,
      p.address as project_address,
      p.job_name as project_job_name,
      (SELECT COUNT(*) FROM photos ph WHERE ph.note_id = pn.id) as photo_count
    FROM project_notes pn
    JOIN projects p ON p.id = pn.project_id
    JOIN users u ON u.id = pn.user_id
    ${access.sql}
    LEFT JOIN project_review_state prs ON prs.user_id = ? AND prs.project_id = pn.project_id
    WHERE pn.note_type = 'field'
      AND pn.user_id != ?
      AND datetime(pn.created_at) > datetime(COALESCE(prs.last_reviewed_at, '1970-01-01 00:00:00'))
      AND datetime(pn.created_at) > datetime('now', '-14 days')
    ORDER BY datetime(pn.created_at) DESC
    LIMIT 40
  `).all(...access.params, req.user.id, req.user.id);

  const fieldPhotos = db.prepare(`
    SELECT
      ph.id,
      ph.project_id,
      ph.filename,
      ph.original_name,
      ph.label,
      ph.photo_type,
      COALESCE(ph.captured_at, ph.taken_at, ph.uploaded_at, ph.created_at) as captured_at,
      u.name as user_name,
      p.address as project_address,
      p.job_name as project_job_name
    FROM photos ph
    JOIN projects p ON p.id = ph.project_id
    JOIN users u ON u.id = ph.uploaded_by
    ${access.sql}
    LEFT JOIN project_review_state prs ON prs.user_id = ? AND prs.project_id = ph.project_id
    WHERE ph.uploaded_by != ?
      AND ph.photo_type IN ('progress','construction_plan','note')
      AND datetime(COALESCE(ph.captured_at, ph.taken_at, ph.uploaded_at, ph.created_at)) > datetime(COALESCE(prs.last_reviewed_at, '1970-01-01 00:00:00'))
      AND datetime(COALESCE(ph.captured_at, ph.taken_at, ph.uploaded_at, ph.created_at)) > datetime('now', '-14 days')
    ORDER BY datetime(COALESCE(ph.captured_at, ph.taken_at, ph.uploaded_at, ph.created_at)) DESC
    LIMIT 40
  `).all(...access.params, req.user.id, req.user.id);

  const invoiceHolds = db.prepare(`
    SELECT
      i.id,
      i.invoice_number,
      i.project_id,
      i.status,
      i.total,
      i.created_at,
      p.address as project_address,
      p.job_name as project_job_name,
      u.name as contractor_name,
      (
        SELECT COUNT(*)
        FROM construction_plan_items cpi
        WHERE cpi.project_id = i.project_id
          AND cpi.invoice_status IN ('received','approval_needed')
          AND cpi.verification_status != 'approved'
      ) as blocking_item_count
    FROM invoices i
    JOIN projects p ON p.id = i.project_id
    JOIN users u ON u.id = i.contractor_id
    ${access.sql}
    WHERE i.status IN ('submitted','reviewed','approved')
      AND EXISTS (
        SELECT 1
        FROM construction_plan_items cpi
        WHERE cpi.project_id = i.project_id
          AND cpi.invoice_status IN ('received','approval_needed')
          AND cpi.verification_status != 'approved'
      )
    ORDER BY datetime(i.created_at) DESC
    LIMIT 40
  `).all(...access.params);

  return {
    counts: {
      field_notes: fieldNotes.length,
      field_photos: fieldPhotos.length,
      scheduled_tasks: watchTasks.filter(task => ['not_started', 'in_progress', 'waiting_materials'].includes(task.status)).length,
      approvals_needed: watchTasks.filter(task => task.status === 'needs_review' || ['pending_review', 'rejected'].includes(task.verification_status)).length,
      invoice_holds: invoiceHolds.length,
      total_alerts: fieldNotes.length + fieldPhotos.length + watchTasks.length + invoiceHolds.length,
    },
    tasks: watchTasks,
    field_notes: fieldNotes,
    field_photos: fieldPhotos,
    invoice_holds: invoiceHolds,
  };
}

router.get('/watchlist', (req, res) => {
  res.json(getWatchlist(req));
});

router.get('/projects/:projectId', authorizeProjectAccess, (req, res) => {
  const db = getDb();
  const projectId = req.params.projectId;

  const tasks = db.prepare(`
    ${taskSelectSql()}
    WHERE cpi.project_id = ?
    ORDER BY cpi.sort_order ASC, datetime(cpi.created_at) ASC
  `).all(projectId).map(decorateTask);

  const fieldNotes = db.prepare(`
    SELECT pn.*, u.name as user_name, u.avatar_url as user_avatar_url,
      (SELECT COUNT(*) FROM photos ph WHERE ph.note_id = pn.id) as photo_count
    FROM project_notes pn
    JOIN users u ON u.id = pn.user_id
    WHERE pn.project_id = ? AND pn.note_type = 'field'
    ORDER BY datetime(pn.created_at) DESC
    LIMIT 25
  `).all(projectId);

  const fieldPhotos = db.prepare(`
    SELECT ph.*, u.name as user_name
    FROM photos ph
    JOIN users u ON u.id = ph.uploaded_by
    WHERE ph.project_id = ?
      AND ph.photo_type IN ('progress','construction_plan','note')
    ORDER BY datetime(COALESCE(ph.captured_at, ph.taken_at, ph.uploaded_at, ph.created_at)) DESC
    LIMIT 30
  `).all(projectId);

  const invoiceHolds = db.prepare(`
    SELECT i.*, u.name as contractor_name
    FROM invoices i
    JOIN users u ON u.id = i.contractor_id
    WHERE i.project_id = ?
      AND i.status IN ('submitted','reviewed','approved')
      AND EXISTS (
        SELECT 1 FROM construction_plan_items cpi
        WHERE cpi.project_id = i.project_id
          AND cpi.invoice_status IN ('received','approval_needed')
          AND cpi.verification_status != 'approved'
      )
    ORDER BY datetime(i.created_at) DESC
  `).all(projectId);

  res.json({
    project_id: projectId,
    counts: {
      tasks: tasks.length,
      active_tasks: tasks.filter(task => task.status !== 'completed').length,
      approvals_needed: tasks.filter(task => task.status === 'needs_review' || ['pending_review', 'rejected'].includes(task.verification_status)).length,
      invoice_holds: invoiceHolds.length,
      field_notes: fieldNotes.length,
      field_photos: fieldPhotos.length,
    },
    tasks,
    field_notes: fieldNotes,
    field_photos: fieldPhotos,
    invoice_holds: invoiceHolds,
  });
});

router.post('/projects/:projectId/tasks', authorize(...MANAGEMENT_ROLES), authorizeProjectAccess, (req, res) => {
  try {
    const db = getDb();
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Task title is required' });

    const status = normalizeEnum(req.body.status, TASK_STATUSES, 'not_started');
    const invoiceStatus = normalizeEnum(req.body.invoice_status, INVOICE_STATUSES, 'not_received');
    const verificationStatus = normalizeEnum(
      req.body.verification_status,
      VERIFICATION_STATUSES,
      status === 'needs_review' ? 'pending_review' : 'not_requested'
    );
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max FROM construction_plan_items WHERE project_id = ?').get(req.params.projectId);
    const taskId = uuidv4();

    db.prepare(`
      INSERT INTO construction_plan_items (
        id, project_id, title, description, category, status, verification_status, invoice_status,
        sort_order, assigned_to, start_date, target_date, approval_notes, last_field_update_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    `).run(
      taskId,
      req.params.projectId,
      title,
      req.body.description || null,
      String(req.body.category || 'Field Work').trim() || 'Field Work',
      status,
      verificationStatus,
      invoiceStatus,
      maxOrder.max + 1,
      req.body.assigned_to || null,
      req.body.start_date || null,
      req.body.target_date || null,
      req.body.approval_notes || null,
      req.user.id
    );

    logActivity({
      userId: req.user.id,
      projectId: req.params.projectId,
      action: 'field_work_task_created',
      entityType: 'construction_plan_item',
      entityId: taskId,
      details: { title, status, verification_status: verificationStatus, invoice_status: invoiceStatus },
    });
    res.status(201).json({ id: taskId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create field work task' });
  }
});

router.put('/projects/:projectId/tasks/:itemId', authorize(...MANAGEMENT_ROLES), authorizeProjectAccess, (req, res) => {
  try {
    const db = getDb();
    const item = db.prepare('SELECT * FROM construction_plan_items WHERE id = ? AND project_id = ?').get(req.params.itemId, req.params.projectId);
    if (!item) return res.status(404).json({ error: 'Field work task not found' });

    const status = req.body.status !== undefined ? normalizeEnum(req.body.status, TASK_STATUSES, item.status) : item.status;
    const invoiceStatus = req.body.invoice_status !== undefined ? normalizeEnum(req.body.invoice_status, INVOICE_STATUSES, item.invoice_status || 'not_received') : (item.invoice_status || 'not_received');
    let verificationStatus = req.body.verification_status !== undefined
      ? normalizeEnum(req.body.verification_status, VERIFICATION_STATUSES, item.verification_status || 'not_requested')
      : (item.verification_status || 'not_requested');

    if ((status === 'needs_review' || status === 'completed') && verificationStatus === 'not_requested') {
      verificationStatus = 'pending_review';
    }
    if (invoiceStatus === 'received' && verificationStatus !== 'approved') {
      verificationStatus = verificationStatus === 'not_requested' ? 'pending_review' : verificationStatus;
    }

    const approvedAt = verificationStatus === 'approved' && item.verification_status !== 'approved'
      ? new Date().toISOString()
      : item.approved_at;
    const approvedBy = verificationStatus === 'approved' && item.verification_status !== 'approved'
      ? req.user.id
      : item.approved_by;
    const completedAt = status === 'completed' && item.status !== 'completed'
      ? new Date().toISOString()
      : (status !== 'completed' ? null : item.completed_at);

    db.prepare(`
      UPDATE construction_plan_items
      SET title = ?, description = ?, category = ?, status = ?, verification_status = ?, invoice_status = ?,
          assigned_to = ?, start_date = ?, target_date = ?, approved_by = ?, approved_at = ?,
          approval_notes = ?, last_field_update_at = datetime('now'), completed_at = ?, updated_at = datetime('now')
      WHERE id = ? AND project_id = ?
    `).run(
      req.body.title !== undefined ? String(req.body.title || '').trim() || item.title : item.title,
      req.body.description !== undefined ? req.body.description || null : item.description,
      req.body.category !== undefined ? String(req.body.category || '').trim() || 'Field Work' : item.category,
      status,
      verificationStatus,
      invoiceStatus,
      req.body.assigned_to !== undefined ? req.body.assigned_to || null : item.assigned_to,
      req.body.start_date !== undefined ? req.body.start_date || null : item.start_date,
      req.body.target_date !== undefined ? req.body.target_date || null : item.target_date,
      approvedBy,
      approvedAt,
      req.body.approval_notes !== undefined ? req.body.approval_notes || null : item.approval_notes,
      completedAt,
      req.params.itemId,
      req.params.projectId
    );

    logActivity({
      userId: req.user.id,
      projectId: req.params.projectId,
      action: 'field_work_task_updated',
      entityType: 'construction_plan_item',
      entityId: req.params.itemId,
      details: { status, verification_status: verificationStatus, invoice_status: invoiceStatus },
    });
    res.json({ message: 'Field work task updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update field work task' });
  }
});

router.post('/projects/:projectId/tasks/:itemId/approve', authorize(...MANAGEMENT_ROLES), authorizeProjectAccess, (req, res) => {
  try {
    const db = getDb();
    const item = db.prepare('SELECT * FROM construction_plan_items WHERE id = ? AND project_id = ?').get(req.params.itemId, req.params.projectId);
    if (!item) return res.status(404).json({ error: 'Field work task not found' });

    const approvedAt = new Date().toISOString();
    const nextInvoiceStatus = ['received', 'approval_needed'].includes(item.invoice_status)
      ? 'approved_for_payment'
      : (item.invoice_status || 'not_received');

    db.prepare(`
      UPDATE construction_plan_items
      SET status = 'completed',
          verification_status = 'approved',
          invoice_status = ?,
          approved_by = ?,
          approved_at = ?,
          approval_notes = ?,
          completed_at = COALESCE(completed_at, ?),
          last_field_update_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ? AND project_id = ?
    `).run(nextInvoiceStatus, req.user.id, approvedAt, req.body.approval_notes || item.approval_notes || null, approvedAt, req.params.itemId, req.params.projectId);

    logActivity({
      userId: req.user.id,
      projectId: req.params.projectId,
      action: 'field_work_task_approved',
      entityType: 'construction_plan_item',
      entityId: req.params.itemId,
      details: { title: item.title, invoice_status: nextInvoiceStatus },
    });
    res.json({ message: 'Field work task approved', approved_at: approvedAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to approve field work task' });
  }
});

module.exports = router;
