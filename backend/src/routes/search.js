const express = require('express');
const { getDb } = require('../db/schema');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const MANAGEMENT_ROLES = ['super_admin', 'operations_manager', 'project_manager'];
const USER_MANAGE_ROLES = ['super_admin', 'operations_manager'];

function asLikeTerm(value) {
  return `%${String(value || '').trim()}%`;
}

function capLimit(value, fallback = 8) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 25);
}

function projectScope(req, alias = 'p') {
  if (req.user.role !== 'contractor') return { join: '', where: '', params: [] };
  return {
    join: `JOIN project_assignments search_pa ON search_pa.project_id = ${alias}.id AND search_pa.user_id = ?`,
    where: '',
    params: [req.user.id],
  };
}

router.get('/', (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query.length < 2) return res.json({ query, results: [] });

  const db = getDb();
  const limit = capLimit(req.query.limit);
  const like = asLikeTerm(query);
  const isManagement = MANAGEMENT_ROLES.includes(req.user.role);
  const canSearchUsers = USER_MANAGE_ROLES.includes(req.user.role);
  const results = [];

  const projectAccess = projectScope(req, 'p');
  const projects = db.prepare(`
    SELECT p.id, p.address, p.job_name, p.status, p.updated_at
    FROM projects p
    ${projectAccess.join}
    WHERE p.status != 'archived'
      AND (p.address LIKE ? OR p.job_name LIKE ? OR p.scope_of_work LIKE ? OR p.office_notes LIKE ? OR p.field_notes LIKE ?)
    ORDER BY datetime(p.updated_at) DESC
    LIMIT ?
  `).all(...projectAccess.params, like, like, like, like, like, limit);

  for (const project of projects) {
    results.push({
      type: 'Project',
      title: project.address,
      subtitle: project.job_name || project.status,
      url: `/projects/${project.id}`,
      meta: project.status,
    });
  }

  const invoiceProjectAccess = projectScope(req, 'p');
  const invoiceRoleWhere = req.user.role === 'contractor' ? 'AND i.contractor_id = ?' : '';
  const invoiceRoleParams = req.user.role === 'contractor' ? [req.user.id] : [];
  const invoices = db.prepare(`
    SELECT i.id, i.invoice_number, i.project_id, i.total, i.status, i.updated_at, p.address, p.job_name, u.name as contractor_name
    FROM invoices i
    JOIN projects p ON p.id = i.project_id
    JOIN users u ON u.id = i.contractor_id
    ${invoiceProjectAccess.join}
    WHERE (i.invoice_number LIKE ? OR p.address LIKE ? OR p.job_name LIKE ? OR u.name LIKE ? OR CAST(i.total AS TEXT) LIKE ? OR i.status LIKE ?)
      ${invoiceRoleWhere}
    ORDER BY datetime(i.updated_at) DESC, datetime(i.created_at) DESC
    LIMIT ?
  `).all(...invoiceProjectAccess.params, like, like, like, like, like, like, ...invoiceRoleParams, limit);

  for (const invoice of invoices) {
    results.push({
      type: 'Invoice',
      title: invoice.invoice_number || `Invoice ${invoice.id}`,
      subtitle: `${invoice.contractor_name || 'Contractor'} - ${invoice.address || invoice.job_name || ''}`,
      url: `/projects/${invoice.project_id}/invoices/${invoice.id}`,
      meta: `$${Number(invoice.total || 0).toLocaleString()} ${invoice.status || ''}`.trim(),
    });
  }

  const noteProjectAccess = projectScope(req, 'p');
  const notes = db.prepare(`
    SELECT n.id, n.project_id, n.note, n.created_at, p.address, u.name as user_name
    FROM project_notes n
    JOIN projects p ON p.id = n.project_id
    JOIN users u ON u.id = n.user_id
    ${noteProjectAccess.join}
    WHERE n.note LIKE ? OR p.address LIKE ? OR u.name LIKE ?
    ORDER BY datetime(n.created_at) DESC
    LIMIT ?
  `).all(...noteProjectAccess.params, like, like, like, limit);

  for (const note of notes) {
    results.push({
      type: 'Note',
      title: note.note.length > 80 ? `${note.note.slice(0, 80)}...` : note.note,
      subtitle: `${note.user_name} - ${note.address}`,
      url: `/projects/${note.project_id}`,
      meta: 'Project note',
    });
  }

  const punchProjectAccess = projectScope(req, 'p');
  const punchItems = db.prepare(`
    SELECT pli.id, pli.project_id, pli.title, pli.status, pli.priority, p.address
    FROM punch_list_items pli
    JOIN projects p ON p.id = pli.project_id
    ${punchProjectAccess.join}
    WHERE pli.title LIKE ? OR pli.description LIKE ? OR pli.notes LIKE ? OR p.address LIKE ?
    ORDER BY datetime(pli.updated_at) DESC, datetime(pli.created_at) DESC
    LIMIT ?
  `).all(...punchProjectAccess.params, like, like, like, like, limit);

  for (const item of punchItems) {
    results.push({
      type: 'Punch List',
      title: item.title,
      subtitle: item.address,
      url: `/projects/${item.project_id}`,
      meta: `${String(item.status || '').replace(/_/g, ' ')} - ${item.priority || 'priority'}`,
    });
  }

  if (isManagement) {
    const contractors = db.prepare(`
      SELECT id, vendor_name, contact_name, email, phone, billing_address, contractor_category
      FROM contractor_profiles
      WHERE vendor_name LIKE ? OR contact_name LIKE ? OR email LIKE ? OR phone LIKE ? OR billing_address LIKE ? OR contractor_category LIKE ?
      ORDER BY vendor_name
      LIMIT ?
    `).all(like, like, like, like, like, like, limit);

    for (const contractor of contractors) {
      results.push({
        type: 'Contractor',
        title: contractor.vendor_name,
        subtitle: contractor.contact_name || contractor.email || contractor.phone || contractor.billing_address || 'Contractor profile',
        url: '/contractors',
        meta: contractor.contractor_category || 'Contractor',
      });
    }
  }

  if (canSearchUsers) {
    const users = db.prepare(`
      SELECT id, name, email, role, phone, company
      FROM users
      WHERE name LIKE ? OR email LIKE ? OR role LIKE ? OR phone LIKE ? OR company LIKE ?
      ORDER BY name
      LIMIT ?
    `).all(like, like, like, like, like, limit);

    for (const user of users) {
      results.push({
        type: 'User',
        title: user.name,
        subtitle: user.email,
        url: '/users',
        meta: String(user.role || '').replace(/_/g, ' '),
      });
    }
  }

  res.json({ query, results: results.slice(0, 40) });
});

module.exports = router;
