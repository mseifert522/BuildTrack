const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/schema');
const { authenticate, authorize, authorizeProjectAccess } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { sendInvoiceEmail } = require('../utils/email');
const { generateInvoicePDF } = require('../utils/pdf');

const router = express.Router({ mergeParams: true });
router.use(authenticate);

// GET /api/projects/:projectId/invoices
router.get('/', authorizeProjectAccess, (req, res) => {
  const db = getDb();
  let query = `
    SELECT i.*, u.name as contractor_name, u.email as contractor_email
    FROM invoices i JOIN users u ON u.id = i.contractor_id
    WHERE i.project_id = ?
  `;
  const params = [req.params.projectId];

  // Contractors only see their own invoices
  if (req.user.role === 'contractor') {
    query += ' AND i.contractor_id = ?';
    params.push(req.user.id);
  }

  query += ' ORDER BY i.created_at DESC';
  res.json(db.prepare(query).all(...params));
});

// GET /api/invoices - all invoices (admin view)
router.get('/all', authorize('super_admin', 'operations_manager', 'admin_assistant'), (req, res) => {
  const db = getDb();
  const invoices = db.prepare(`
    SELECT i.*, u.name as contractor_name, p.address, p.job_name
    FROM invoices i
    JOIN users u ON u.id = i.contractor_id
    JOIN projects p ON p.id = i.project_id
    ORDER BY i.created_at DESC
    LIMIT 100
  `).all();
  res.json(invoices);
});

// GET /api/projects/:projectId/invoices/:id
router.get('/:id', authorizeProjectAccess, (req, res) => {
  const db = getDb();
  const invoice = db.prepare(`
    SELECT i.*, u.name as contractor_name, u.email as contractor_email, u.phone as contractor_phone, u.company as contractor_company
    FROM invoices i JOIN users u ON u.id = i.contractor_id
    WHERE i.id = ? AND i.project_id = ?
  `).get(req.params.id, req.params.projectId);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

  // Contractors can only view their own invoices
  if (req.user.role === 'contractor' && invoice.contractor_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const lineItems = db.prepare('SELECT * FROM invoice_line_items WHERE invoice_id = ? ORDER BY sort_order').all(req.params.id);
  res.json({ ...invoice, line_items: lineItems });
});

// POST /api/projects/:projectId/invoices - create invoice
router.post('/', authorizeProjectAccess, (req, res) => {
  try {
    const { notes, line_items } = req.body;
    const db = getDb();

    // Generate invoice number
    const count = db.prepare('SELECT COUNT(*) as cnt FROM invoices').get();
    const invoiceNumber = `INV-${String(count.cnt + 1).padStart(5, '0')}`;

    const total = (line_items || []).reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
    const id = uuidv4();

    db.prepare(`
      INSERT INTO invoices (id, invoice_number, project_id, contractor_id, status, notes, total)
      VALUES (?, ?, ?, ?, 'draft', ?, ?)
    `).run(id, invoiceNumber, req.params.projectId, req.user.id, notes || null, total);

    // Insert line items
    if (line_items && line_items.length > 0) {
      const insertLine = db.prepare('INSERT INTO invoice_line_items (id, invoice_id, description, amount, sort_order) VALUES (?, ?, ?, ?, ?)');
      line_items.forEach((item, idx) => {
        insertLine.run(uuidv4(), id, item.description, parseFloat(item.amount) || 0, idx);
      });
    }

    logActivity({ userId: req.user.id, projectId: req.params.projectId, action: 'invoice_created', entityType: 'invoice', entityId: id });
    res.status(201).json({ id, invoice_number: invoiceNumber, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

// PUT /api/projects/:projectId/invoices/:id - update invoice (draft only)
router.put('/:id', authorizeProjectAccess, (req, res) => {
  try {
    const db = getDb();
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Allow editing draft or submitted invoices from mobile
    if (!['draft', 'submitted'].includes(invoice.status)) return res.status(400).json({ error: 'Only draft or submitted invoices can be edited' });
    if (req.user.role === 'contractor' && invoice.contractor_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const { notes, line_items } = req.body;
    const total = (line_items || []).reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);

    db.prepare("UPDATE invoices SET notes = ?, total = ?, updated_at = datetime('now') WHERE id = ?")
      .run(notes ?? invoice.notes, total, req.params.id);

    // Replace line items
    if (line_items !== undefined) {
      db.prepare('DELETE FROM invoice_line_items WHERE invoice_id = ?').run(req.params.id);
      const insertLine = db.prepare('INSERT INTO invoice_line_items (id, invoice_id, description, amount, sort_order) VALUES (?, ?, ?, ?, ?)');
      line_items.forEach((item, idx) => {
        insertLine.run(uuidv4(), req.params.id, item.description, parseFloat(item.amount) || 0, idx);
      });
    }

    res.json({ message: 'Invoice updated', total });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

// POST /api/projects/:projectId/invoices/:id/submit - submit invoice
router.post('/:id/submit', authorizeProjectAccess, async (req, res) => {
  try {
    const db = getDb();
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Allow re-submission from draft or submitted (mobile saves then immediately submits)
    if (!['draft', 'submitted'].includes(invoice.status)) return res.status(400).json({ error: 'Invoice cannot be re-submitted in its current status' });
    if (req.user.role === 'contractor' && invoice.contractor_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
    const contractor = db.prepare('SELECT * FROM users WHERE id = ?').get(invoice.contractor_id);
    const lineItems = db.prepare('SELECT * FROM invoice_line_items WHERE invoice_id = ? ORDER BY sort_order').all(req.params.id);

    // Generate PDF
    let pdfBuffer = null;
    try {
      pdfBuffer = await generateInvoicePDF({ invoice, lineItems, project, contractor });
      // Save PDF to disk
      const pdfDir = path.join(process.env.UPLOADS_PATH || './uploads', 'invoices');
      if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
      fs.writeFileSync(path.join(pdfDir, `${invoice.invoice_number}.pdf`), pdfBuffer);
    } catch (pdfErr) {
      console.error('PDF generation error:', pdfErr.message);
    }

    // Update status
    db.prepare("UPDATE invoices SET status = 'submitted', submitted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(req.params.id);

    // Send email
    try {
      await sendInvoiceEmail({ invoice: { ...invoice, status: 'submitted' }, project, contractor, pdfBuffer });
    } catch (emailErr) {
      console.error('Email send error:', emailErr.message);
    }

    logActivity({ userId: req.user.id, projectId: req.params.projectId, action: 'invoice_submitted', entityType: 'invoice', entityId: req.params.id });
    res.json({ message: 'Invoice submitted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit invoice' });
  }
});

// PUT /api/projects/:projectId/invoices/:id/status - update invoice status (admin)
router.put('/:id/status', authorize('super_admin', 'operations_manager', 'admin_assistant'), (req, res) => {
  const { status } = req.body;
  const validStatuses = ['draft', 'submitted', 'reviewed', 'approved', 'paid'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const db = getDb();
  db.prepare("UPDATE invoices SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, req.params.id);
  logActivity({ userId: req.user.id, projectId: req.params.projectId, action: 'invoice_status_updated', entityType: 'invoice', entityId: req.params.id, details: { status } });
  res.json({ message: 'Status updated' });
});

// GET /api/projects/:projectId/invoices/:id/pdf - download PDF
router.get('/:id/pdf', authorizeProjectAccess, async (req, res) => {
  try {
    const db = getDb();
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (req.user.role === 'contractor' && invoice.contractor_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
    const contractor = db.prepare('SELECT * FROM users WHERE id = ?').get(invoice.contractor_id);
    const lineItems = db.prepare('SELECT * FROM invoice_line_items WHERE invoice_id = ? ORDER BY sort_order').all(req.params.id);

    const pdfBuffer = await generateInvoicePDF({ invoice, lineItems, project, contractor });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoice_number}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

module.exports = router;
