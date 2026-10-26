// Invoice monitor (2026-10-26): emailed invoices vs QuickBooks, the issues that need a
// person, and the feed of everything the inbox and QuickBooks did.
// GET / (office roles), POST /run and POST /issues/:id/dismiss (super admin / OM).
const express = require('express');

const { getDb } = require('../db/schema');
const { authenticate, authorize } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const monitor = require('../services/invoiceReconciliation');

const router = express.Router();
const VIEW_ROLES = ['super_admin', 'operations_manager', 'project_manager', 'admin_assistant'];
const MANAGE_ROLES = ['super_admin', 'operations_manager'];

router.use(authenticate);
router.use(authorize(...VIEW_ROLES));

router.get('/', (_req, res) => {
  const db = getDb();
  const counts = db.prepare('SELECT status, COUNT(*) AS n FROM invoice_reconciliation GROUP BY status').all()
    .reduce((acc, row) => ({ ...acc, [row.status]: row.n }), {});
  const issues = db.prepare(`
    SELECT m.*, i.invoice_number, p.address AS project_address
    FROM invoice_monitor_issues m
    LEFT JOIN invoices i ON i.id = m.invoice_id
    LEFT JOIN projects p ON p.id = COALESCE(m.project_id, i.project_id)
    WHERE m.status = 'open'
    ORDER BY CASE m.severity WHEN 'alert' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, datetime(m.first_seen_at) DESC
    LIMIT 200
  `).all();
  const invoices = db.prepare(`
    SELECT i.id, i.invoice_number, i.vendor_name, i.external_invoice_number, i.total, i.status, i.category, i.project_id,
           i.created_at, i.ai_filed, p.address AS project_address,
           r.status AS reconciliation_status, r.quickbooks_total, r.paid_amount, r.bill_count, r.summary, r.changed_at
    FROM invoices i
    LEFT JOIN projects p ON p.id = i.project_id
    LEFT JOIN invoice_reconciliation r ON r.invoice_id = i.id
    WHERE i.source = 'email' AND i.total > 0
    ORDER BY datetime(i.created_at) DESC
    LIMIT 100
  `).all();
  const links = invoices.length ? db.prepare(`
    SELECT l.invoice_id, l.qbo_bill_id, l.amount, l.part, l.method,
           b.txn_date, b.total_amt, b.balance, b.payment_status, b.payment_approval_status, b.private_note, b.qbo_class_name
    FROM invoice_qbo_links l
    LEFT JOIN quickbooks_bills b ON b.qbo_id = l.qbo_bill_id
    WHERE l.invoice_id IN (${invoices.map(() => '?').join(',')})
    ORDER BY b.txn_date, l.qbo_bill_id
  `).all(...invoices.map(invoice => invoice.id)) : [];
  const linksByInvoice = new Map();
  links.forEach(link => {
    const list = linksByInvoice.get(link.invoice_id) || [];
    list.push(link);
    linksByInvoice.set(link.invoice_id, list);
  });
  const events = db.prepare(`
    SELECT id, created_at, source, kind, severity, invoice_id, qbo_bill_id, intake_id, project_id, message
    FROM invoice_monitor_events
    ORDER BY datetime(created_at) DESC, rowid DESC
    LIMIT 150
  `).all();
  res.json({
    status: monitor.statusSummary(),
    status_labels: monitor.STATUS_LABELS,
    part_labels: monitor.PART_LABELS,
    counts,
    issues,
    invoices: invoices.map(invoice => ({ ...invoice, quickbooks_entries: linksByInvoice.get(invoice.id) || [] })),
    events,
  });
});

router.post('/run', authorize(...MANAGE_ROLES), async (req, res) => {
  const result = await monitor.runOnce({ notify: false });
  if (result.error) return res.status(500).json({ error: 'The invoice monitor could not run', detail: result.error });
  res.json({ message: 'Checked', result });
});

router.post('/issues/:id/dismiss', authorize(...MANAGE_ROLES), (req, res) => {
  const db = getDb();
  const issue = db.prepare('SELECT * FROM invoice_monitor_issues WHERE id = ?').get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });
  db.prepare("UPDATE invoice_monitor_issues SET status = 'dismissed', dismissed_by = ?, resolved_at = datetime('now') WHERE id = ?")
    .run(req.user.id, issue.id);
  monitor.logEvent(db, {
    source: 'buildtrack', kind: 'issue_dismissed', invoiceId: issue.invoice_id, qboBillId: issue.qbo_bill_id, projectId: issue.project_id,
    message: `${req.user.name || 'Someone'} marked as OK: ${issue.message}`,
  });
  logActivity({
    userId: req.user.id,
    projectId: issue.project_id || null,
    action: 'invoice_monitor_issue_dismissed',
    entityType: 'invoice_monitor_issue',
    entityId: issue.id,
    details: { kind: issue.kind },
  });
  res.json({ message: 'Dismissed' });
});

module.exports = router;
