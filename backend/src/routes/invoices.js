const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/schema');
const { authenticate, authorize, authorizeUpperManagement, authorizeProjectAccess } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { logDataAccess } = require('../utils/dataAccessAudit');
const { recordWorkItemEvent } = require('../utils/workItemEvents');
const { sendInvoiceEmail, sendApprovedPayNotificationEmail } = require('../utils/email');
const { generateInvoicePDF } = require('../utils/pdf');

const router = express.Router({ mergeParams: true });
router.use(authenticate);

const invoiceAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 10,
    fileSize: Math.max(Number.parseInt(process.env.MAX_FILE_SIZE_MB || '20', 10), 1) * 1024 * 1024,
  },
});

function buildDesktopInvoiceUrl(projectId, invoiceId) {
  const appUrl = (process.env.APP_URL || 'https://buildtrack.newurbandev.com').replace(/\/$/, '');
  return `${appUrl}/projects/${projectId}/invoices/${invoiceId}`;
}

function buildDesktopInvoicesUrl() {
  const appUrl = (process.env.APP_URL || 'https://buildtrack.newurbandev.com').replace(/\/$/, '');
  return `${appUrl}/invoices`;
}

function parseWorkItemIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))];
}

function sanitizeFilename(filename) {
  const base = path.basename(String(filename || 'invoice-attachment'));
  return base.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 180) || 'invoice-attachment';
}

function headerFilename(filename) {
  return sanitizeFilename(filename).replace(/["\\\r\n]/g, '_');
}

function invoiceAttachmentRoot() {
  return path.resolve(process.env.UPLOADS_PATH || './uploads', 'invoice-attachments');
}

function canAccessInvoice(invoice, user) {
  return user.role !== 'contractor' || invoice.contractor_id === user.id;
}

function isUpperManagement(user) {
  return ['super_admin', 'operations_manager'].includes(user?.role);
}

function canMutateOwnInvoice(invoice, user) {
  return isUpperManagement(user) || invoice.contractor_id === user.id;
}

function formatInvoiceAttachment(row) {
  return {
    id: row.id,
    invoice_id: row.invoice_id,
    project_id: row.project_id,
    original_name: row.original_name,
    filename: row.filename,
    mime_type: row.mime_type,
    size: row.size,
    uploaded_by: row.uploaded_by,
    uploaded_by_name: row.uploaded_by_name || null,
    created_at: row.created_at,
    url: `/api/projects/${row.project_id}/invoices/${row.invoice_id}/attachments/${row.id}`,
  };
}

function getInvoiceAttachments(db, invoiceId) {
  return db.prepare(`
    SELECT ia.*, u.name as uploaded_by_name
    FROM invoice_attachments ia
    LEFT JOIN users u ON u.id = ia.uploaded_by
    WHERE ia.invoice_id = ?
    ORDER BY datetime(ia.created_at) DESC, ia.created_at DESC
  `).all(invoiceId).map(formatInvoiceAttachment);
}

function getInvoiceWorkItems(db, invoiceId) {
  return db.prepare(`
    SELECT
      cpi.id,
      cpi.title,
      cpi.category,
      cpi.status,
      cpi.verification_status,
      cpi.invoice_status,
      cpi.target_date,
      cpi.approved_at,
      u.name as approved_by_name,
      iwi.linked_at
    FROM invoice_work_items iwi
    JOIN construction_plan_items cpi ON cpi.id = iwi.construction_plan_item_id
    LEFT JOIN users u ON u.id = cpi.approved_by
    WHERE iwi.invoice_id = ?
    ORDER BY datetime(iwi.linked_at) ASC
  `).all(invoiceId);
}

function getFieldWorkPaymentHolds(db, projectId, invoiceId = null) {
  const linkedCount = invoiceId
    ? db.prepare('SELECT COUNT(*) as count FROM invoice_work_items WHERE invoice_id = ?').get(invoiceId).count
    : 0;

  if (linkedCount > 0) {
    return db.prepare(`
      SELECT
        cpi.id,
        cpi.title,
        cpi.status,
        cpi.verification_status,
        cpi.invoice_status,
        cpi.target_date,
        1 as invoice_linked
      FROM invoice_work_items iwi
      JOIN construction_plan_items cpi ON cpi.id = iwi.construction_plan_item_id
      WHERE iwi.invoice_id = ?
        AND iwi.project_id = ?
        AND cpi.verification_status != 'approved'
      ORDER BY datetime(COALESCE(cpi.target_date, cpi.updated_at, cpi.created_at)) ASC
      LIMIT 25
    `).all(invoiceId, projectId);
  }

  return db.prepare(`
    SELECT id, title, status, verification_status, invoice_status, target_date, 0 as invoice_linked
    FROM construction_plan_items
    WHERE project_id = ?
      AND invoice_status IN ('received','approval_needed')
      AND verification_status != 'approved'
    ORDER BY datetime(COALESCE(target_date, updated_at, created_at)) ASC
    LIMIT 25
  `).all(projectId);
}

function getApprovedPaymentQueue(db) {
  return db.prepare(`
    SELECT
      i.*,
      u.name as contractor_name,
      u.email as contractor_email,
      p.address,
      p.job_name
    FROM invoices i
    JOIN users u ON u.id = i.contractor_id
    JOIN projects p ON p.id = i.project_id
    WHERE i.status = 'approved'
    ORDER BY datetime(i.updated_at) DESC, datetime(i.submitted_at) DESC
    LIMIT 75
  `).all();
}

async function notifyApprovedPaymentQueue(db, { approvedInvoice, approvedBy }) {
  try {
    await sendApprovedPayNotificationEmail({
      approvedInvoices: getApprovedPaymentQueue(db),
      approvedInvoice,
      approvedBy,
    });
  } catch (emailErr) {
    console.error('[INVOICE] Approved-to-pay notification failed:', emailErr.message);
  }
}

function syncInvoiceWorkItems(db, { invoiceId, projectId, user, workItemIds, markReceived = false }) {
  if (!Array.isArray(workItemIds)) return;
  const nextIds = parseWorkItemIds(workItemIds);
  db.prepare('DELETE FROM invoice_work_items WHERE invoice_id = ?').run(invoiceId);
  if (nextIds.length === 0) return;

  const placeholders = nextIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, status, verification_status, invoice_status
    FROM construction_plan_items
    WHERE project_id = ?
      AND id IN (${placeholders})
  `).all(projectId, ...nextIds);

  if (rows.length !== nextIds.length) {
    const found = new Set(rows.map(row => row.id));
    const missing = nextIds.filter(id => !found.has(id));
    throw Object.assign(new Error(`Invalid field work item selected: ${missing.join(', ')}`), { statusCode: 400 });
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO invoice_work_items (id, invoice_id, project_id, construction_plan_item_id, linked_by)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateReceived = db.prepare(`
    UPDATE construction_plan_items
    SET invoice_status = CASE
          WHEN verification_status = 'approved' THEN 'approved_for_payment'
          ELSE 'received'
        END,
        verification_status = CASE
          WHEN verification_status = 'approved' THEN verification_status
          WHEN verification_status = 'not_requested' THEN 'pending_review'
          ELSE verification_status
        END,
        updated_at = datetime('now')
    WHERE id = ? AND project_id = ?
  `);

  rows.forEach(row => {
    insert.run(uuidv4(), invoiceId, projectId, row.id, user.id);
    if (markReceived) {
      const after = {
        ...row,
        invoice_status: row.verification_status === 'approved' ? 'approved_for_payment' : 'received',
        verification_status: row.verification_status === 'approved'
          ? row.verification_status
          : (row.verification_status === 'not_requested' ? 'pending_review' : row.verification_status),
      };
      updateReceived.run(row.id, projectId);
      recordWorkItemEvent(db, {
        projectId,
        itemId: row.id,
        invoiceId,
        actor: user,
        eventType: 'invoice_linked',
        before: row,
        after,
        comment: 'Contractor invoice linked to field work from the mobile invoice flow.',
      });
    } else {
      recordWorkItemEvent(db, {
        projectId,
        itemId: row.id,
        invoiceId,
        actor: user,
        eventType: 'invoice_linked',
        before: row,
        after: row,
      });
    }
  });
}

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
  const invoices = db.prepare(query).all(...params).map(invoice => {
    const linkedWorkCount = db.prepare('SELECT COUNT(*) as count FROM invoice_work_items WHERE invoice_id = ?').get(invoice.id).count;
    const holds = getFieldWorkPaymentHolds(db, invoice.project_id, invoice.id);
    return { ...invoice, linked_work_count: linkedWorkCount, payment_hold_count: holds.length };
  });
  logDataAccess(req, {
    action: 'project_invoice_list_viewed',
    accessType: 'view',
    entityType: 'invoice',
    projectId: req.params.projectId,
    recordCount: invoices.length,
    riskLevel: 'high',
  });
  res.json(invoices);
});

// GET /api/invoices - all invoices (admin view)
router.get('/all', authorize('super_admin', 'operations_manager', 'project_manager', 'admin_assistant'), (req, res) => {
  const db = getDb();
  const invoices = db.prepare(`
    SELECT
      i.*,
      u.name as contractor_name,
      p.address,
      p.job_name,
      (SELECT COUNT(*) FROM invoice_work_items iwi WHERE iwi.invoice_id = i.id) as linked_work_count,
      CASE
        WHEN (SELECT COUNT(*) FROM invoice_work_items iwi WHERE iwi.invoice_id = i.id) > 0 THEN (
          SELECT COUNT(*)
          FROM invoice_work_items iwi
          JOIN construction_plan_items cpi ON cpi.id = iwi.construction_plan_item_id
          WHERE iwi.invoice_id = i.id
            AND cpi.verification_status != 'approved'
        )
        ELSE (
          SELECT COUNT(*)
          FROM construction_plan_items cpi
          WHERE cpi.project_id = i.project_id
            AND cpi.invoice_status IN ('received','approval_needed')
            AND cpi.verification_status != 'approved'
        )
      END as payment_hold_count
    FROM invoices i
    JOIN users u ON u.id = i.contractor_id
    JOIN projects p ON p.id = i.project_id
    ORDER BY i.created_at DESC
    LIMIT 100
  `).all();
  logDataAccess(req, {
    action: 'invoice_admin_list_viewed',
    accessType: 'view',
    entityType: 'invoice',
    recordCount: invoices.length,
    riskLevel: 'high',
  });
  res.json(invoices);
});

// GET /api/projects/:projectId/invoices/next-number
router.get('/next-number', authorizeProjectAccess, (req, res) => {
  const db = getDb();
  const maxNum = db.prepare("SELECT invoice_number FROM invoices ORDER BY CAST(REPLACE(invoice_number, 'NUD-', '') AS INTEGER) DESC LIMIT 1").get();
  let nextNum = 1023;
  if (maxNum && maxNum.invoice_number) {
    const num = parseInt(maxNum.invoice_number.replace('NUD-', ''));
    if (!isNaN(num) && num >= 1023) nextNum = num + 1;
  }
  res.json({ invoice_number: `NUD-${nextNum}` });
});

// POST /api/projects/:projectId/invoices/approved-pay-notification - send current approved payment queue
router.post('/approved-pay-notification', authorizeUpperManagement, async (req, res) => {
  const db = getDb();
  await notifyApprovedPaymentQueue(db, {
    approvedInvoice: null,
    approvedBy: req.user.name || req.user.email || 'BuildTrack',
  });
  res.json({ message: 'Approved payment notification sent' });
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
  const linkedWorkItems = getInvoiceWorkItems(db, req.params.id);
  const paymentHolds = getFieldWorkPaymentHolds(db, req.params.projectId, req.params.id);
  const attachments = getInvoiceAttachments(db, req.params.id);
  logDataAccess(req, {
    action: 'invoice_detail_viewed',
    accessType: 'view',
    entityType: 'invoice',
    entityId: invoice.id,
    projectId: req.params.projectId,
    riskLevel: 'high',
    details: {
      invoice_number: invoice.invoice_number,
      contractor_name: invoice.contractor_name,
      total: invoice.total,
      attachment_count: attachments.length,
    },
  });
  res.json({ ...invoice, line_items: lineItems, linked_work_items: linkedWorkItems, payment_holds: paymentHolds, attachments });
});

router.post('/:id/attachments', authorizeProjectAccess, invoiceAttachmentUpload.array('attachments', 10), (req, res) => {
  try {
    const db = getDb();
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (!canAccessInvoice(invoice, req.user)) return res.status(403).json({ error: 'Access denied' });
    if (!canMutateOwnInvoice(invoice, req.user)) return res.status(403).json({ error: 'You can only add attachments to invoices you created' });
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return res.status(400).json({ error: 'No invoice attachments uploaded' });

    const dir = path.join(invoiceAttachmentRoot(), req.params.projectId, req.params.id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const insert = db.prepare(`
      INSERT INTO invoice_attachments (id, invoice_id, project_id, filename, original_name, mime_type, size, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const saved = files.map(file => {
      const id = uuidv4();
      const originalName = sanitizeFilename(file.originalname);
      const ext = path.extname(originalName);
      const storedName = `${id}${ext || ''}`;
      fs.writeFileSync(path.join(dir, storedName), file.buffer);
      insert.run(id, req.params.id, req.params.projectId, storedName, originalName, file.mimetype || 'application/octet-stream', file.size || file.buffer.length, req.user.id);
      return {
        id,
        invoice_id: req.params.id,
        project_id: req.params.projectId,
        original_name: originalName,
        filename: storedName,
        mime_type: file.mimetype || 'application/octet-stream',
        size: file.size || file.buffer.length,
        uploaded_by: req.user.id,
        created_at: new Date().toISOString(),
        url: `/api/projects/${req.params.projectId}/invoices/${req.params.id}/attachments/${id}`,
      };
    });

    logActivity({
      userId: req.user.id,
      projectId: req.params.projectId,
      action: 'invoice_attachment_uploaded',
      entityType: 'invoice',
      entityId: req.params.id,
      details: { count: saved.length },
    });

    res.status(201).json({ attachments: saved });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload invoice attachments' });
  }
});

// POST /api/projects/:projectId/invoices - create invoice
router.post('/', authorizeProjectAccess, async (req, res) => {
  try {
    const { notes, line_items, send_email } = req.body;
    const workItemIds = req.body.work_item_ids;
    const db = getDb();

    // Generate invoice number starting at 1023
    const maxNum = db.prepare("SELECT invoice_number FROM invoices ORDER BY CAST(REPLACE(invoice_number, 'NUD-', '') AS INTEGER) DESC LIMIT 1").get();
    let nextNum = 1023;
    if (maxNum && maxNum.invoice_number) {
      const num = parseInt(maxNum.invoice_number.replace('NUD-', ''));
      if (!isNaN(num) && num >= 1023) nextNum = num + 1;
    }
    const invoiceNumber = `NUD-${nextNum}`;

    const total = (line_items || []).reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
    const id = uuidv4();

    const createInvoice = db.transaction(() => {
      db.prepare(`
        INSERT INTO invoices (id, invoice_number, project_id, contractor_id, status, notes, total)
        VALUES (?, ?, ?, ?, 'draft', ?, ?)
      `).run(id, invoiceNumber, req.params.projectId, req.user.id, notes || null, total);

      if (line_items && line_items.length > 0) {
        const insertLine = db.prepare('INSERT INTO invoice_line_items (id, invoice_id, description, amount, sort_order) VALUES (?, ?, ?, ?, ?)');
        line_items.forEach((item, idx) => {
          insertLine.run(uuidv4(), id, item.description, parseFloat(item.amount) || 0, idx);
        });
      }

      syncInvoiceWorkItems(db, {
        invoiceId: id,
        projectId: req.params.projectId,
        user: req.user,
        workItemIds,
        markReceived: Boolean(send_email),
      });

      logActivity({ userId: req.user.id, projectId: req.params.projectId, action: 'invoice_created', entityType: 'invoice', entityId: id, details: { linked_work_items: parseWorkItemIds(workItemIds).length } });
    });
    createInvoice();

    const desktopUrl = buildDesktopInvoiceUrl(req.params.projectId, id);
    const desktopInvoicesUrl = buildDesktopInvoicesUrl();

    // Auto-submit and send email if requested (mobile flow)
    if (send_email) {
      db.prepare("UPDATE invoices SET status = 'submitted', submitted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
      logActivity({ userId: req.user.id, projectId: req.params.projectId, action: 'invoice_submitted', entityType: 'invoice', entityId: id });

      // Send email to both office and contractor with a main-site BuildTrack link.
      try {
        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
        const contractor = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
        const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
        const lineItems = db.prepare('SELECT * FROM invoice_line_items WHERE invoice_id = ? ORDER BY sort_order').all(id);
        let pdfBuffer = null;

        try {
          pdfBuffer = await generateInvoicePDF({ invoice, lineItems, project, contractor });
          const pdfDir = path.join(process.env.UPLOADS_PATH || './uploads', 'invoices');
          if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
          fs.writeFileSync(path.join(pdfDir, `${invoice.invoice_number}.pdf`), pdfBuffer);
        } catch (pdfErr) {
          console.error('[INVOICE] PDF generation failed:', pdfErr.message);
        }

        await sendInvoiceEmail({
          invoice: { ...invoice, desktop_url: desktopUrl, desktop_invoices_url: desktopInvoicesUrl },
          project,
          contractor,
          pdfBuffer,
        });
        console.log('[INVOICE] Email sent for', invoiceNumber, 'to', contractor.email, 'desktopUrl=', desktopUrl);
      } catch (emailErr) {
        console.error('[INVOICE] Email failed:', emailErr.message);
      }
    }

    res.status(201).json({
      id,
      invoice_number: invoiceNumber,
      total,
      status: send_email ? 'submitted' : 'draft',
      desktop_url: desktopUrl,
      desktop_invoices_url: desktopInvoicesUrl,
    });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to create invoice' });
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
    if (req.user.role === 'project_manager') return res.status(403).json({ error: 'Project managers can create and submit invoices, but cannot edit existing invoices' });
    if (req.user.role === 'contractor' && invoice.contractor_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const { notes, line_items, send_email } = req.body;
    const workItemIds = req.body.work_item_ids;
    const total = (line_items || []).reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);

    const updateInvoice = db.transaction(() => {
      db.prepare("UPDATE invoices SET notes = ?, total = ?, updated_at = datetime('now') WHERE id = ?")
        .run(notes ?? invoice.notes, total, req.params.id);

      if (line_items !== undefined) {
        db.prepare('DELETE FROM invoice_line_items WHERE invoice_id = ?').run(req.params.id);
        const insertLine = db.prepare('INSERT INTO invoice_line_items (id, invoice_id, description, amount, sort_order) VALUES (?, ?, ?, ?, ?)');
        line_items.forEach((item, idx) => {
          insertLine.run(uuidv4(), req.params.id, item.description, parseFloat(item.amount) || 0, idx);
        });
      }

      syncInvoiceWorkItems(db, {
        invoiceId: req.params.id,
        projectId: req.params.projectId,
        user: req.user,
        workItemIds,
        markReceived: Boolean(send_email || invoice.status === 'submitted'),
      });

      logActivity({ userId: req.user.id, projectId: req.params.projectId, action: 'invoice_updated', entityType: 'invoice', entityId: req.params.id, details: { linked_work_items: Array.isArray(workItemIds) ? parseWorkItemIds(workItemIds).length : undefined } });
    });
    updateInvoice();

    res.json({ message: 'Invoice updated', total });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to update invoice' });
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
    if (!canMutateOwnInvoice(invoice, req.user)) return res.status(403).json({ error: 'Access denied' });

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

    const linkedWorkIds = db.prepare('SELECT construction_plan_item_id FROM invoice_work_items WHERE invoice_id = ?').all(req.params.id).map(row => row.construction_plan_item_id);
    const submitInvoice = db.transaction(() => {
      db.prepare("UPDATE invoices SET status = 'submitted', submitted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
        .run(req.params.id);
      syncInvoiceWorkItems(db, {
        invoiceId: req.params.id,
        projectId: req.params.projectId,
        user: req.user,
        workItemIds: linkedWorkIds,
        markReceived: true,
      });
    });
    submitInvoice();

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
router.put('/:id/status', authorizeUpperManagement, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['draft', 'submitted', 'reviewed', 'approved', 'paid'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
	  const db = getDb();
	  const invoice = db.prepare(`
      SELECT
        i.*,
        u.name as contractor_name,
        u.email as contractor_email,
        p.address,
        p.job_name
      FROM invoices i
      JOIN users u ON u.id = i.contractor_id
      JOIN projects p ON p.id = i.project_id
      WHERE i.id = ? AND i.project_id = ?
    `).get(req.params.id, req.params.projectId);
	  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
	  if (['approved', 'paid'].includes(status)) {
	    const linkedCount = db.prepare('SELECT COUNT(*) as count FROM invoice_work_items WHERE invoice_id = ?').get(req.params.id).count;
	    if (linkedCount === 0) {
	      return res.status(409).json({
	        error: 'Assign this invoice to a project scope task before approving or paying it.',
	        code: 'INVOICE_TASK_ASSIGNMENT_REQUIRED',
	      });
	    }
	    const holds = getFieldWorkPaymentHolds(db, req.params.projectId, req.params.id);
	    if (holds.length) {
	      return res.status(409).json({
        error: 'Field work must be completed and approved before this invoice can be approved for payment.',
        code: 'FIELD_WORK_APPROVAL_REQUIRED',
        holds,
      });
    }
  }
  if (status === 'paid') {
    const qboPaymentStatus = String(invoice.quickbooks_payment_status || '').toLowerCase();
    const qboBalance = Number(invoice.quickbooks_balance);
    const qboHasKnownZeroBalance = Boolean(
      invoice.quickbooks_bill_id
      && invoice.quickbooks_balance !== null
      && invoice.quickbooks_balance !== undefined
      && invoice.quickbooks_balance !== ''
      && Number.isFinite(qboBalance)
      && qboBalance <= 0
    );
    if (qboPaymentStatus !== 'paid' && !qboHasKnownZeroBalance) {
      return res.status(409).json({
        error: 'QuickBooks has not marked this bill paid yet. BuildTrack can only mark invoices paid after the QuickBooks sync reports paid or a zero open balance.',
        code: 'QUICKBOOKS_PAID_SYNC_REQUIRED',
      });
    }
  }
  const quickbooksStatus = status === 'paid' ? 'synced' : undefined;
  if (quickbooksStatus) {
    db.prepare("UPDATE invoices SET status = ?, quickbooks_status = ?, quickbooks_error = NULL, updated_at = datetime('now') WHERE id = ?").run(status, quickbooksStatus, req.params.id);
  } else {
    db.prepare("UPDATE invoices SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, req.params.id);
  }
  logActivity({ userId: req.user.id, projectId: req.params.projectId, action: 'invoice_status_updated', entityType: 'invoice', entityId: req.params.id, details: { status } });
  if (status === 'approved' && invoice.status !== 'approved' && req.body?.notify !== false) {
    await notifyApprovedPaymentQueue(db, {
      approvedInvoice: { ...invoice, status: 'approved' },
      approvedBy: req.user.name || req.user.email || 'BuildTrack',
    });
  }
  res.json({ message: 'Status updated', quickbooks_status: quickbooksStatus || undefined });
});

router.get('/:id/attachments/:attachmentId', authorizeProjectAccess, (req, res) => {
  try {
    const db = getDb();
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (!canAccessInvoice(invoice, req.user)) return res.status(403).json({ error: 'Access denied' });

    const attachment = db.prepare(`
      SELECT * FROM invoice_attachments
      WHERE id = ? AND invoice_id = ? AND project_id = ?
    `).get(req.params.attachmentId, req.params.id, req.params.projectId);
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });

    const filePath = path.join(invoiceAttachmentRoot(), req.params.projectId, req.params.id, attachment.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Attachment file missing' });

    if (String(req.query.inline || req.query.preview || '') === '1') {
      logDataAccess(req, {
        action: 'invoice_attachment_viewed',
        accessType: 'view',
        entityType: 'invoice_attachment',
        entityId: attachment.id,
        projectId: req.params.projectId,
        riskLevel: 'high',
        details: {
          invoice_id: invoice.id,
          invoice_number: invoice.invoice_number,
          original_name: attachment.original_name,
          mime_type: attachment.mime_type,
          size: attachment.size,
        },
      });
      res.setHeader('Content-Type', attachment.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${headerFilename(attachment.original_name)}"`);
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.sendFile(filePath);
    }

    logDataAccess(req, {
      action: 'invoice_attachment_downloaded',
      accessType: 'download',
      entityType: 'invoice_attachment',
      entityId: attachment.id,
      projectId: req.params.projectId,
      riskLevel: 'high',
      details: {
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        original_name: attachment.original_name,
        mime_type: attachment.mime_type,
        size: attachment.size,
      },
    });
    return res.download(filePath, attachment.original_name);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load invoice attachment' });
  }
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
    logDataAccess(req, {
      action: 'invoice_pdf_downloaded',
      accessType: 'download',
      entityType: 'invoice',
      entityId: invoice.id,
      projectId: req.params.projectId,
      riskLevel: 'high',
      details: {
        invoice_number: invoice.invoice_number,
        contractor_id: invoice.contractor_id,
        contractor_name: contractor?.name || contractor?.email || null,
        total: invoice.total,
        line_item_count: lineItems.length,
      },
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoice_number}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

module.exports = router;
