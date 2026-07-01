const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const { getDb } = require('../db/schema');
const { authenticate, authorizeProjectAccess, PROJECT_MANAGE_ROLES, UPPER_MANAGEMENT_ROLES } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');

const QUOTE_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'paid', 'completed', 'historical'];
const QUOTE_FILTER_STATUSES = {
  review: ['submitted'],
  approved: ['approved', 'paid', 'completed'],
  rejected: ['rejected'],
  database: QUOTE_STATUSES,
};
const FINANCIAL_FIELDS = [
  'total_quote_amount',
  'labor_cost',
  'material_cost',
  'permit_costs',
  'equipment_costs',
  'disposal_cleanup_costs',
  'tax',
  'insurance',
  'overhead',
  'profit_margin',
  'contingency',
  'final_approved_amount',
];
const SUMMARY_CACHE_MS = 60 * 1000;
const summaryCache = new Map();

function uploadBase() {
  return process.env.UPLOADS_PATH || './uploads';
}

function documentRoot(projectId) {
  return path.join(uploadBase(), 'documents', projectId);
}

function tmpUploadRoot() {
  return path.join(uploadBase(), 'quote-uploads', 'tmp');
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = tmpUploadRoot();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${new Date().toISOString().replace(/[:.]/g, '-')}_${uuidv4()}${ext}`);
    },
  }),
  limits: { fileSize: Math.max(Number.parseInt(process.env.MAX_FILE_SIZE_MB || '20', 10), 1) * 1024 * 1024 },
});

// In-memory upload for AI extraction — the buffer is base64'd and sent to Claude; nothing is persisted here.
const extractUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.max(Number.parseInt(process.env.MAX_FILE_SIZE_MB || '20', 10), 1) * 1024 * 1024 },
});

const QUOTE_EXTRACT_MODEL = process.env.QUOTE_EXTRACT_MODEL || 'claude-opus-4-8';

function requireManagement(req, res, next) {
  if (!PROJECT_MANAGE_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Only management can access quote analytics' });
  }
  next();
}

function clearSummaryCache() {
  summaryCache.clear();
}

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function numberValue(value, fallback = 0) {
  if (value === '' || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJson(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function parseLineItems(body) {
  const parsed = parseJson(body.line_items, []);
  return Array.isArray(parsed) ? parsed : [];
}

function loadCategoryMap(db) {
  const categories = db.prepare(`
    SELECT id, category_group, name, normalized_key
    FROM quote_categories
    WHERE is_active = 1
    ORDER BY sort_order ASC, name ASC
  `).all();
  const byName = new Map();
  for (const category of categories) {
    byName.set(normalizeKey(category.name), category);
    byName.set(normalizeKey(category.normalized_key), category);
  }
  return { categories, byName };
}

function validateDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function removeUploadedFile(file) {
  if (!file?.path) return;
  try {
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
  } catch (_) {
    // Best-effort cleanup only.
  }
}

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function persistUploadedFile(projectId, file) {
  if (!file) return null;
  const dir = documentRoot(projectId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const destination = path.join(dir, path.basename(file.filename));
  fs.renameSync(file.path, destination);
  return {
    filename: path.basename(file.filename),
    relativePath: path.join('documents', projectId, path.basename(file.filename)).replace(/\\/g, '/'),
    fullPath: destination,
  };
}

function nextQuoteNumber(db, quoteYear) {
  const prefix = `Q-${quoteYear}-`;
  const row = db.prepare(`
    SELECT quote_number
    FROM contractor_quotes
    WHERE quote_number LIKE ?
    ORDER BY quote_number DESC
    LIMIT 1
  `).get(`${prefix}%`);
  const current = row?.quote_number ? Number.parseInt(row.quote_number.replace(prefix, ''), 10) : 0;
  return `${prefix}${String((Number.isFinite(current) ? current : 0) + 1).padStart(5, '0')}`;
}

function getProjectOrThrow(db, projectId) {
  return db.prepare('SELECT id, address, job_name, status, budget FROM projects WHERE id = ?').get(projectId);
}

function resolveContractor(db, body) {
  let contractor = {
    contractor_id: body.contractor_id || null,
    contractor_profile_id: body.contractor_profile_id || null,
    contractor_name: String(body.contractor_name || '').trim(),
    contractor_company: String(body.contractor_company || '').trim(),
    contractor_email: String(body.contractor_email || '').trim(),
    contractor_phone: String(body.contractor_phone || '').trim(),
    contractor_address: String(body.contractor_address || '').trim(),
  };

  if (contractor.contractor_profile_id) {
    const profile = db.prepare(`
      SELECT id, vendor_name, contact_name, email, phone, billing_address
      FROM contractor_profiles
      WHERE id = ?
    `).get(contractor.contractor_profile_id);
    if (profile) {
      contractor.contractor_company = contractor.contractor_company || profile.vendor_name || '';
      contractor.contractor_name = contractor.contractor_name || profile.contact_name || profile.vendor_name || '';
      contractor.contractor_email = contractor.contractor_email || profile.email || '';
      contractor.contractor_phone = contractor.contractor_phone || profile.phone || '';
      contractor.contractor_address = contractor.contractor_address || profile.billing_address || '';
    }
  }

  if (contractor.contractor_id) {
    const user = db.prepare('SELECT id, name, email, phone, company FROM users WHERE id = ?').get(contractor.contractor_id);
    if (user) {
      contractor.contractor_name = contractor.contractor_name || user.name || '';
      contractor.contractor_company = contractor.contractor_company || user.company || '';
      contractor.contractor_email = contractor.contractor_email || user.email || '';
      contractor.contractor_phone = contractor.contractor_phone || user.phone || '';
    }
  }

  return contractor;
}

function validateQuoteInput(db, body, projectIdFromRoute, file) {
  const errors = [];
  const projectId = projectIdFromRoute || String(body.project_id || '').trim();
  const project = projectId ? getProjectOrThrow(db, projectId) : null;
  if (!project) errors.push('Valid property/project is required');

  const quoteDate = validateDate(body.quote_date);
  if (!quoteDate) errors.push('Valid quote date is required');
  const quoteYear = quoteDate ? new Date(`${quoteDate}T00:00:00Z`).getUTCFullYear() : null;

  const status = String(body.status || 'draft').toLowerCase();
  if (!QUOTE_STATUSES.includes(status)) errors.push('Invalid quote status');

  const contractor = resolveContractor(db, body);
  if (!contractor.contractor_name && !contractor.contractor_company) {
    errors.push('Contractor name or company is required');
  }

  const { byName } = loadCategoryMap(db);
  const rawLineItems = parseLineItems(body);
  if (rawLineItems.length === 0) errors.push('At least one quote line item is required');

  const lineItems = rawLineItems.map((item, index) => {
    const categoryValue = String(item.category || '').trim();
    const category = byName.get(normalizeKey(categoryValue));
    if (!categoryValue) errors.push(`Line ${index + 1}: category is required`);
    if (categoryValue && !category) errors.push(`Line ${index + 1}: category must use the standardized category list`);

    const quantity = numberValue(item.quantity, 1);
    const unitPrice = numberValue(item.unit_price, 0);
    const explicitTotal = item.total_line_item_price ?? item.total ?? item.amount;
    const totalLineItemPrice = explicitTotal === undefined || explicitTotal === ''
      ? quantity * unitPrice
      : numberValue(explicitTotal, 0);
    const laborAmount = numberValue(item.labor_amount, 0);
    const materialAmount = numberValue(item.material_amount, 0);

    for (const [label, value] of [
      ['quantity', quantity],
      ['unit price', unitPrice],
      ['line total', totalLineItemPrice],
      ['labor amount', laborAmount],
      ['material amount', materialAmount],
    ]) {
      if (value < 0) errors.push(`Line ${index + 1}: ${label} cannot be negative`);
    }

    return {
      category_id: category?.id || null,
      category_group: category?.category_group || '',
      category: category?.name || categoryValue,
      subcategory: String(item.subcategory || '').trim(),
      description: String(item.description || item.scope || categoryValue || 'Quote line item').trim(),
      quantity,
      unit: String(item.unit || '').trim(),
      unit_price: unitPrice,
      total_line_item_price: totalLineItemPrice,
      labor_amount: laborAmount,
      material_amount: materialAmount,
      sort_order: index,
    };
  });

  const lineItemTotal = lineItems.reduce((sum, item) => sum + item.total_line_item_price, 0);
  const financial = {};
  for (const field of FINANCIAL_FIELDS) {
    const value = numberValue(body[field], field === 'profit_margin' || field === 'final_approved_amount' ? null : 0);
    if (value !== null && value < 0) errors.push(`${field.replace(/_/g, ' ')} cannot be negative`);
    financial[field] = value;
  }
  if (!financial.total_quote_amount || financial.total_quote_amount <= 0) {
    financial.total_quote_amount = lineItemTotal;
  }
  if (!financial.total_quote_amount || financial.total_quote_amount <= 0) {
    errors.push('Quote pricing is required');
  }

  if (file) {
    const hash = fileHash(file.path);
    const duplicate = project
      ? db.prepare('SELECT id, quote_number FROM contractor_quotes WHERE project_id = ? AND source_file_hash = ?').get(project.id, hash)
      : null;
    if (duplicate) {
      errors.push(`Duplicate quote upload detected for ${duplicate.quote_number}`);
    }
    return { errors, project, quoteDate, quoteYear, status, contractor, financial, lineItems, fileHash: hash };
  }

  return { errors, project, quoteDate, quoteYear, status, contractor, financial, lineItems, fileHash: null };
}

function quoteSnapshot(db, quoteId) {
  const quote = db.prepare(`
    SELECT q.*, u.name as uploaded_by_name
    FROM contractor_quotes q
    LEFT JOIN users u ON u.id = q.uploaded_by
    WHERE q.id = ?
  `).get(quoteId);
  const lineItems = db.prepare('SELECT * FROM quote_line_items WHERE quote_id = ? ORDER BY sort_order ASC').all(quoteId);
  return { quote, line_items: lineItems };
}

function insertHistoricalRecord(db, quoteId, projectId, quoteYear, actorId, action) {
  const snapshot = quoteSnapshot(db, quoteId);
  db.prepare(`
    INSERT INTO historical_quote_records (id, quote_id, project_id, quote_year, action, snapshot_json, actor_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), quoteId, projectId, quoteYear, action, JSON.stringify(snapshot), actorId);
}

function createQuote(req, res, projectIdFromRoute = null) {
  const db = getDb();
  const file = req.file || null;
  const validation = validateQuoteInput(db, req.body || {}, projectIdFromRoute, file);
  if (validation.errors.length > 0) {
    removeUploadedFile(file);
    return res.status(validation.errors.some(error => error.startsWith('Duplicate')) ? 409 : 400).json({ errors: validation.errors });
  }

  const {
    project,
    quoteDate,
    quoteYear,
    status,
    contractor,
    financial,
    lineItems,
    fileHash: uploadedFileHash,
  } = validation;

  try {
    const created = db.transaction(() => {
      let sourceDocumentId = null;
      let sourceFileName = null;
      let sourceFilePath = null;
      let sourceFileMimeType = null;
      let sourceFileSize = null;

      if (file) {
        const stored = persistUploadedFile(project.id, file);
        sourceFileName = file.originalname;
        sourceFilePath = stored.relativePath;
        sourceFileMimeType = file.mimetype;
        sourceFileSize = file.size;
        sourceDocumentId = uuidv4();
        db.prepare(`
          INSERT INTO project_documents (id, project_id, filename, original_name, mime_type, size, document_type, uploaded_by)
          VALUES (?, ?, ?, ?, ?, ?, 'quotes', ?)
        `).run(sourceDocumentId, project.id, stored.filename, file.originalname, file.mimetype, file.size, req.user.id);
      }

      const quoteId = uuidv4();
      const quoteNumber = nextQuoteNumber(db, quoteYear);
      const dataQualityFlags = [];
      if (!contractor.contractor_email && !contractor.contractor_phone) dataQualityFlags.push('missing_contractor_contact');
      if (lineItems.some(item => !item.subcategory)) dataQualityFlags.push('missing_subcategory');

      db.prepare(`
        INSERT INTO contractor_quotes (
          id, quote_number, project_id, property_address, project_name,
          contractor_id, contractor_profile_id, contractor_name, contractor_company, contractor_email, contractor_phone, contractor_address,
          quote_date, quote_year, status, scope_description, notes,
          total_quote_amount, labor_cost, material_cost, permit_costs, equipment_costs, disposal_cleanup_costs,
          tax, insurance, overhead, profit_margin, contingency, final_approved_amount,
          source_document_id, source_file_name, source_file_path, source_file_mime_type, source_file_size, source_file_hash,
          imported_from, data_quality_flags, uploaded_by
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?
        )
      `).run(
        quoteId,
        quoteNumber,
        project.id,
        project.address,
        project.job_name,
        contractor.contractor_id,
        contractor.contractor_profile_id,
        contractor.contractor_name || contractor.contractor_company,
        contractor.contractor_company || contractor.contractor_name,
        contractor.contractor_email || null,
        contractor.contractor_phone || null,
        contractor.contractor_address || null,
        quoteDate,
        quoteYear,
        status,
        String(req.body.scope_description || '').trim(),
        String(req.body.notes || '').trim() || null,
        financial.total_quote_amount,
        financial.labor_cost,
        financial.material_cost,
        financial.permit_costs,
        financial.equipment_costs,
        financial.disposal_cleanup_costs,
        financial.tax,
        financial.insurance,
        financial.overhead,
        financial.profit_margin,
        financial.contingency,
        financial.final_approved_amount,
        sourceDocumentId,
        sourceFileName,
        sourceFilePath,
        sourceFileMimeType,
        sourceFileSize,
        uploadedFileHash,
        file ? 'upload' : 'manual',
        JSON.stringify(dataQualityFlags),
        req.user.id
      );

      const insertLine = db.prepare(`
        INSERT INTO quote_line_items (
          id, quote_id, category_id, category_group, category, subcategory, description,
          quantity, unit, unit_price, total_line_item_price, labor_amount, material_amount, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of lineItems) {
        insertLine.run(
          uuidv4(),
          quoteId,
          item.category_id,
          item.category_group,
          item.category,
          item.subcategory || null,
          item.description,
          item.quantity,
          item.unit || null,
          item.unit_price,
          item.total_line_item_price,
          item.labor_amount,
          item.material_amount,
          item.sort_order
        );
      }

      insertHistoricalRecord(db, quoteId, project.id, quoteYear, req.user.id, 'created');
      return quoteSnapshot(db, quoteId);
    })();

    clearSummaryCache();
    logActivity({
      userId: req.user.id,
      projectId: project.id,
      action: 'quote_created',
      entityType: 'contractor_quote',
      entityId: created.quote.id,
      details: { quote_number: created.quote.quote_number, total: created.quote.total_quote_amount },
    });

    return res.status(201).json(created);
  } catch (err) {
    removeUploadedFile(file);
    console.error('[QUOTE_ANALYTICS] create failed:', err);
    return res.status(500).json({ error: 'Failed to create quote' });
  }
}

// Modify an existing quote (header fields + line items). The quote number, project,
// source document, cost breakdown, and final approved amount are preserved; the editable
// fields and the line items are replaced. Writes a historical 'updated' snapshot + activity.
function updateQuote(req, res, forcedProjectId = null) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM contractor_quotes WHERE id = ?').get(req.params.id);
  if (!existing || (forcedProjectId && existing.project_id !== forcedProjectId)) {
    return res.status(404).json({ error: 'Quote not found' });
  }
  // The project cannot change on edit — validate against the quote's existing project.
  const validation = validateQuoteInput(db, req.body || {}, existing.project_id, null);
  if (validation.errors.length > 0) {
    return res.status(400).json({ errors: validation.errors });
  }
  const { quoteDate, quoteYear, status, contractor, financial, lineItems } = validation;

  try {
    const updated = db.transaction(() => {
      db.prepare(`
        UPDATE contractor_quotes SET
          contractor_id = ?, contractor_profile_id = ?, contractor_name = ?, contractor_company = ?,
          contractor_email = ?, contractor_phone = ?, contractor_address = ?,
          quote_date = ?, quote_year = ?, status = ?, scope_description = ?, notes = ?,
          total_quote_amount = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        contractor.contractor_id,
        contractor.contractor_profile_id,
        contractor.contractor_name || contractor.contractor_company,
        contractor.contractor_company || contractor.contractor_name,
        contractor.contractor_email || null,
        contractor.contractor_phone || null,
        contractor.contractor_address || null,
        quoteDate,
        quoteYear,
        status,
        String(req.body.scope_description || '').trim(),
        String(req.body.notes || '').trim() || null,
        financial.total_quote_amount,
        existing.id
      );

      db.prepare('DELETE FROM quote_line_items WHERE quote_id = ?').run(existing.id);
      const insertLine = db.prepare(`
        INSERT INTO quote_line_items (
          id, quote_id, category_id, category_group, category, subcategory, description,
          quantity, unit, unit_price, total_line_item_price, labor_amount, material_amount, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of lineItems) {
        insertLine.run(
          uuidv4(), existing.id, item.category_id, item.category_group, item.category,
          item.subcategory || null, item.description, item.quantity, item.unit || null,
          item.unit_price, item.total_line_item_price, item.labor_amount, item.material_amount, item.sort_order
        );
      }

      insertHistoricalRecord(db, existing.id, existing.project_id, quoteYear, req.user.id, 'updated');
      return quoteSnapshot(db, existing.id);
    })();

    clearSummaryCache();
    logActivity({
      userId: req.user.id,
      projectId: existing.project_id,
      action: 'quote_updated',
      entityType: 'contractor_quote',
      entityId: existing.id,
      details: { quote_number: existing.quote_number, total: updated.quote.total_quote_amount },
    });

    return res.json(updated);
  } catch (err) {
    console.error('[QUOTE_ANALYTICS] update failed:', err);
    return res.status(500).json({ error: 'Failed to update quote' });
  }
}

function updateQuoteReviewStatus(req, res, forcedProjectId = null, nextStatus) {
  if (!['approved', 'rejected', 'submitted'].includes(nextStatus)) {
    return res.status(400).json({ error: 'Unsupported quote review action' });
  }

  const db = getDb();
  const quote = db.prepare('SELECT * FROM contractor_quotes WHERE id = ?').get(req.params.id);
  if (!quote || (forcedProjectId && quote.project_id !== forcedProjectId)) {
    return res.status(404).json({ error: 'Quote not found' });
  }
  // Restore-to-review (submitted) is only valid for a quote that was rejected by
  // mistake - it moves the quote back into the Intake Bin / pending-review queue.
  if (nextStatus === 'submitted' && String(quote.status || '').toLowerCase() !== 'rejected') {
    return res.status(400).json({ error: 'Only rejected quotes can be restored to pending review.' });
  }

  const previousStatus = quote.status;
  const action = nextStatus === 'approved' ? 'approved' : nextStatus === 'submitted' ? 'restored' : 'rejected';
  const reviewNote = String(req.body?.review_note || req.body?.note || '').trim();
  const approvedAmount = nextStatus === 'approved'
    ? numberValue(req.body?.final_approved_amount, numberValue(quote.final_approved_amount, numberValue(quote.total_quote_amount)))
    : quote.final_approved_amount;

  try {
    const updated = db.transaction(() => {
      db.prepare(`
        UPDATE contractor_quotes
        SET status = ?,
            final_approved_amount = CASE WHEN ? = 'approved' THEN ? ELSE final_approved_amount END,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(nextStatus, nextStatus, approvedAmount, quote.id);

      insertHistoricalRecord(db, quote.id, quote.project_id, quote.quote_year, req.user.id, action);
      return quoteSnapshot(db, quote.id);
    })();

    clearSummaryCache();
    logActivity({
      userId: req.user.id,
      projectId: quote.project_id,
      action: nextStatus === 'approved' ? 'quote_approved' : nextStatus === 'submitted' ? 'quote_restored' : 'quote_rejected',
      entityType: 'contractor_quote',
      entityId: quote.id,
      details: {
        quote_number: quote.quote_number,
        previous_status: previousStatus,
        new_status: nextStatus,
        review_note: reviewNote || null,
      },
    });

    return res.json(updated);
  } catch (err) {
    console.error('[QUOTE_ANALYTICS] review status update failed:', err);
    return res.status(500).json({ error: 'Failed to update quote review status' });
  }
}

// Permanently delete a quote. Restricted to super_admin + operations_manager
// (the router already requires management; this narrows to upper management).
// Line items + historical records cascade via FK; the source document + file are
// cleaned up best-effort. A quote_deleted entry is written to the activity log.
function deleteQuote(req, res, forcedProjectId = null) {
  if (!UPPER_MANAGEMENT_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Only super admins and operations managers can delete quotes' });
  }
  const db = getDb();
  const quote = db.prepare('SELECT * FROM contractor_quotes WHERE id = ?').get(req.params.id);
  if (!quote || (forcedProjectId && quote.project_id !== forcedProjectId)) {
    return res.status(404).json({ error: 'Quote not found' });
  }
  // Rejected quotes are a permanent bucket kept for long-term market/pricing
  // analysis (vendor, contractor, category, price). They are never deleted.
  if (String(quote.status || '').toLowerCase() === 'rejected') {
    return res.status(409).json({ error: 'Rejected quotes are preserved for market analysis and cannot be deleted.' });
  }

  try {
    db.transaction(() => {
      const doc = quote.source_document_id
        ? db.prepare('SELECT * FROM project_documents WHERE id = ?').get(quote.source_document_id)
        : null;
      db.prepare('DELETE FROM contractor_quotes WHERE id = ?').run(quote.id);
      if (doc) {
        db.prepare('DELETE FROM project_documents WHERE id = ?').run(doc.id);
        try {
          const root = path.resolve(documentRoot(quote.project_id));
          const filePath = path.resolve(root, doc.filename);
          if (filePath.startsWith(root) && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (_) { /* best-effort file cleanup */ }
      }
    })();

    clearSummaryCache();
    logActivity({
      userId: req.user.id,
      projectId: quote.project_id,
      action: 'quote_deleted',
      entityType: 'contractor_quote',
      entityId: quote.id,
      details: { quote_number: quote.quote_number, total: quote.total_quote_amount, contractor: quote.contractor_company || quote.contractor_name },
    });

    return res.json({ message: 'Quote deleted', id: quote.id });
  } catch (err) {
    console.error('[QUOTE_ANALYTICS] delete failed:', err);
    return res.status(500).json({ error: 'Failed to delete quote' });
  }
}

// ── Quote-only notes ─────────────────────────────────────────────────────────
// Lightweight notes scoped to a single quote. Intentionally NOT linked to project
// notes, the activity feed, or anything else — purely for quoting context. The
// table is created idempotently so no shared schema migration is required.
let quoteNotesReady = false;
function ensureQuoteNotes(db) {
  if (quoteNotesReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS quote_notes (
      id TEXT PRIMARY KEY,
      quote_id TEXT NOT NULL,
      project_id TEXT,
      user_id TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (quote_id) REFERENCES contractor_quotes(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_quote_notes_quote ON quote_notes(quote_id, created_at);
  `);
  quoteNotesReady = true;
}

function listQuoteNotes(req, res, forcedProjectId = null) {
  const db = getDb();
  ensureQuoteNotes(db);
  const quote = db.prepare('SELECT id FROM contractor_quotes WHERE id = ?' + (forcedProjectId ? ' AND project_id = ?' : ''))
    .get(...(forcedProjectId ? [req.params.id, forcedProjectId] : [req.params.id]));
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  const notes = db.prepare(`
    SELECT n.id, n.note, n.user_id, n.created_at,
           u.name as user_name, u.role as user_role, u.avatar_url as user_avatar_url
    FROM quote_notes n
    JOIN users u ON u.id = n.user_id
    WHERE n.quote_id = ?
    ORDER BY datetime(n.created_at) ASC, n.created_at ASC
  `).all(req.params.id);
  return res.json(notes);
}

function addQuoteNote(req, res, forcedProjectId = null) {
  const note = String(req.body?.note || '').trim();
  if (!note) return res.status(400).json({ error: 'Note text is required' });
  const db = getDb();
  ensureQuoteNotes(db);
  const quote = db.prepare('SELECT id, project_id FROM contractor_quotes WHERE id = ?').get(req.params.id);
  if (!quote || (forcedProjectId && quote.project_id !== forcedProjectId)) {
    return res.status(404).json({ error: 'Quote not found' });
  }
  const id = uuidv4();
  const createdAt = new Date().toISOString();
  db.prepare('INSERT INTO quote_notes (id, quote_id, project_id, user_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.params.id, quote.project_id, req.user.id, note, createdAt);
  return res.status(201).json({
    id, note, user_id: req.user.id, user_name: req.user.name,
    user_role: req.user.role, user_avatar_url: req.user.avatar_url || null, created_at: createdAt,
  });
}

function deleteQuoteNote(req, res) {
  const db = getDb();
  ensureQuoteNotes(db);
  const row = db.prepare('SELECT * FROM quote_notes WHERE id = ? AND quote_id = ?').get(req.params.noteId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Note not found' });
  const canDelete = row.user_id === req.user.id || UPPER_MANAGEMENT_ROLES.includes(req.user.role);
  if (!canDelete) return res.status(403).json({ error: 'Cannot delete this note' });
  db.prepare('DELETE FROM quote_notes WHERE id = ?').run(req.params.noteId);
  return res.json({ message: 'Note deleted', id: req.params.noteId });
}

function filterWhere(query, forcedProjectId = null) {
  const where = [];
  const params = [];

  if (forcedProjectId) {
    where.push('q.project_id = ?');
    params.push(forcedProjectId);
  } else if (query.project_id) {
    where.push('q.project_id = ?');
    params.push(String(query.project_id));
  }
  if (query.year) {
    where.push('q.quote_year = ?');
    params.push(Number.parseInt(query.year, 10));
  }
  if (query.status) {
    where.push('q.status = ?');
    params.push(String(query.status).toLowerCase());
  } else if (query.quote_filter) {
    const filterKey = String(query.quote_filter || '').toLowerCase();
    const statuses = QUOTE_FILTER_STATUSES[filterKey];
    if (statuses && filterKey !== 'database') {
      where.push(`q.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
  }
  if (query.contractor) {
    where.push('(q.contractor_name LIKE ? OR q.contractor_company LIKE ?)');
    params.push(`%${query.contractor}%`, `%${query.contractor}%`);
  }
  if (query.start_date) {
    where.push('date(q.quote_date) >= date(?)');
    params.push(String(query.start_date));
  }
  if (query.end_date) {
    where.push('date(q.quote_date) <= date(?)');
    params.push(String(query.end_date));
  }
  if (query.min_cost) {
    where.push('q.total_quote_amount >= ?');
    params.push(numberValue(query.min_cost));
  }
  if (query.max_cost) {
    where.push('q.total_quote_amount <= ?');
    params.push(numberValue(query.max_cost));
  }
  if (query.category) {
    where.push(`EXISTS (
      SELECT 1 FROM quote_line_items li
      WHERE li.quote_id = q.id AND li.category = ?
    )`);
    params.push(String(query.category));
  }

  return {
    sql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params,
  };
}

function listQuotes(req, res, forcedProjectId = null) {
  const db = getDb();
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '100', 10) || 100, 1), 500);
  const page = Math.max(Number.parseInt(req.query.page || '1', 10) || 1, 1);
  const offset = (page - 1) * limit;
  const where = filterWhere(req.query, forcedProjectId);

  const total = db.prepare(`
    SELECT COUNT(*) as count
    FROM contractor_quotes q
    ${where.sql}
  `).get(...where.params).count;

  const rows = db.prepare(`
    SELECT
      q.*,
      u.name as uploaded_by_name,
      pd.id as document_id,
      pd.original_name as document_original_name,
      vqr.id as vendor_quote_request_id,
      vqr.sent_at as quote_request_sent_at,
      vqr.opened_at as quote_request_opened_at,
      vqr.submitted_at as quote_returned_at,
      vqr.status as quote_request_status
    FROM contractor_quotes q
    LEFT JOIN users u ON u.id = q.uploaded_by
    LEFT JOIN project_documents pd ON pd.id = q.source_document_id
    LEFT JOIN vendor_quote_requests vqr ON vqr.submitted_quote_id = q.id
    ${where.sql}
    ORDER BY date(q.quote_date) DESC, datetime(q.created_at) DESC
    LIMIT ? OFFSET ?
  `).all(...where.params, limit, offset);

  const ids = rows.map(row => row.id);
  const lineItemsByQuote = new Map();
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const lineItems = db.prepare(`
      SELECT *
      FROM quote_line_items
      WHERE quote_id IN (${placeholders})
      ORDER BY sort_order ASC
    `).all(...ids);
    for (const lineItem of lineItems) {
      const list = lineItemsByQuote.get(lineItem.quote_id) || [];
      list.push(lineItem);
      lineItemsByQuote.set(lineItem.quote_id, list);
    }
  }

  res.json({
    page,
    limit,
    total,
    quotes: rows.map(row => ({
      ...row,
      line_items: lineItemsByQuote.get(row.id) || [],
      document_download_url: row.source_document_id ? `/api/quote-analytics/quotes/${row.id}/download` : null,
    })),
  });
}

function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function summarizeGroup(rows, keyFn) {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return Array.from(grouped.entries()).map(([key, group]) => {
    const totals = group.map(row => numberValue(row.total_quote_amount));
    const sum = totals.reduce((acc, value) => acc + value, 0);
    return {
      key,
      count: group.length,
      total: sum,
      average: group.length ? sum / group.length : 0,
      median: median(totals),
      low: totals.length ? Math.min(...totals) : 0,
      high: totals.length ? Math.max(...totals) : 0,
    };
  });
}

function getFilteredQuoteRows(db, query, forcedProjectId = null) {
  const where = filterWhere(query, forcedProjectId);
  const quotes = db.prepare(`
    SELECT q.*
    FROM contractor_quotes q
    ${where.sql}
    ORDER BY q.quote_year ASC, date(q.quote_date) ASC
  `).all(...where.params);
  if (quotes.length === 0) return { quotes, lineItems: [] };
  const placeholders = quotes.map(() => '?').join(',');
  const lineItems = db.prepare(`
    SELECT li.*, q.quote_year, q.project_id, q.contractor_name, q.contractor_company, q.total_quote_amount
    FROM quote_line_items li
    JOIN contractor_quotes q ON q.id = li.quote_id
    WHERE li.quote_id IN (${placeholders})
  `).all(...quotes.map(quote => quote.id));
  return { quotes, lineItems };
}

function quoteSummary(req, res, forcedProjectId = null) {
  const cacheKey = `${forcedProjectId || 'all'}:${JSON.stringify(req.query || {})}`;
  const cached = summaryCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < SUMMARY_CACHE_MS) return res.json(cached.data);

  const db = getDb();
  const { quotes, lineItems } = getFilteredQuoteRows(db, req.query, forcedProjectId);
  const quoteAmounts = quotes.map(row => numberValue(row.total_quote_amount));
  const totalQuotedValue = quoteAmounts.reduce((sum, value) => sum + value, 0);
  const contractorKeys = new Set(quotes.map(row => `${row.contractor_company || ''}|${row.contractor_name || ''}`));
  const propertyIds = new Set(quotes.map(row => row.project_id));
  const historicalRecordsCount = db.prepare('SELECT COUNT(*) as count FROM historical_quote_records').get().count;
  const activeProjects = db.prepare("SELECT COUNT(*) as count FROM projects WHERE status = 'active_rehab'").get().count;

  const byYear = summarizeGroup(quotes, row => String(row.quote_year)).sort((a, b) => Number(a.key) - Number(b.key));
  for (let i = 0; i < byYear.length; i += 1) {
    const prev = byYear[i - 1];
    byYear[i].yoy_change_percent = prev && prev.average
      ? ((byYear[i].average - prev.average) / prev.average) * 100
      : 0;
  }

  const byContractor = summarizeGroup(quotes, row => row.contractor_company || row.contractor_name || 'Unknown contractor')
    .map(row => {
      const contractorQuotes = quotes.filter(quote => (quote.contractor_company || quote.contractor_name || 'Unknown contractor') === row.key);
      const awarded = contractorQuotes.filter(quote => ['approved', 'paid', 'completed'].includes(quote.status)).length;
      return { ...row, award_rate: contractorQuotes.length ? Math.round((awarded / contractorQuotes.length) * 100) : 0 };
    })
    .sort((a, b) => b.total - a.total);

  const byProperty = summarizeGroup(quotes, row => `${row.project_id}|${row.property_address}|${row.project_name}`)
    .map(row => {
      const [project_id, property_address, project_name] = row.key.split('|');
      return { ...row, project_id, property_address, project_name };
    })
    .sort((a, b) => b.total - a.total);

  const lineTotals = lineItems.map(row => numberValue(row.total_line_item_price));
  const byCategory = summarizeGroup(lineItems.map(row => ({
    ...row,
    total_quote_amount: numberValue(row.total_line_item_price),
  })), row => row.category)
    .sort((a, b) => b.total - a.total);

  const categoryByYearMap = new Map();
  for (const item of lineItems) {
    const key = `${item.category}|${item.quote_year}`;
    const current = categoryByYearMap.get(key) || { category: item.category, year: item.quote_year, count: 0, total: 0 };
    current.count += 1;
    current.total += numberValue(item.total_line_item_price);
    categoryByYearMap.set(key, current);
  }
  const categoryByYear = Array.from(categoryByYearMap.values())
    .map(row => ({ ...row, average: row.count ? row.total / row.count : 0 }))
    .sort((a, b) => Number(a.year) - Number(b.year) || b.total - a.total);

  const categoryCostChanges = byCategory.map(category => {
    const rows = categoryByYear.filter(row => row.category === category.key).sort((a, b) => Number(a.year) - Number(b.year));
    const last = rows[rows.length - 1];
    const prev = rows[rows.length - 2];
    return {
      category: category.key,
      latest_year: last?.year || null,
      latest_average: last?.average || 0,
      previous_average: prev?.average || 0,
      change_percent: prev?.average ? ((last.average - prev.average) / prev.average) * 100 : 0,
      total: category.total,
      count: category.count,
    };
  }).sort((a, b) => Math.abs(b.change_percent) - Math.abs(a.change_percent));

  const statusCounts = summarizeGroup(quotes, row => row.status).sort((a, b) => b.count - a.count);
  const laborTotal = quotes.reduce((sum, row) => sum + numberValue(row.labor_cost), 0) + lineItems.reduce((sum, row) => sum + numberValue(row.labor_amount), 0);
  const materialTotal = quotes.reduce((sum, row) => sum + numberValue(row.material_cost), 0) + lineItems.reduce((sum, row) => sum + numberValue(row.material_amount), 0);
  const otherTotal = Math.max(totalQuotedValue - laborTotal - materialTotal, 0);

  const data = {
    metrics: {
      total_quotes_uploaded: quotes.length,
      total_quoted_value: totalQuotedValue,
      contractors_count: contractorKeys.size,
      properties_count: propertyIds.size,
      average_quote_amount: quoteAmounts.length ? totalQuotedValue / quoteAmounts.length : 0,
      median_quote_amount: median(quoteAmounts),
      lowest_quote: quoteAmounts.length ? Math.min(...quoteAmounts) : 0,
      highest_quote: quoteAmounts.length ? Math.max(...quoteAmounts) : 0,
      active_projects: activeProjects,
      historical_records_count: historicalRecordsCount,
      line_item_records: lineItems.length,
      average_line_item_amount: lineTotals.length ? lineTotals.reduce((sum, value) => sum + value, 0) / lineTotals.length : 0,
      labor_material_ratio: materialTotal ? laborTotal / materialTotal : 0,
    },
    by_year: byYear,
    by_contractor: byContractor.slice(0, 30),
    by_property: byProperty.slice(0, 30),
    by_category: byCategory.slice(0, 40),
    category_by_year: categoryByYear.slice(0, 120),
    category_cost_changes: categoryCostChanges.slice(0, 40),
    quote_volume_by_year: byYear.map(row => ({ year: row.key, count: row.count })),
    labor_material_breakdown: [
      { key: 'Labor', total: laborTotal },
      { key: 'Material', total: materialTotal },
      { key: 'Other', total: otherTotal },
    ],
    status_counts: statusCounts,
  };

  summaryCache.set(cacheKey, { createdAt: Date.now(), data });
  return res.json(data);
}

function options(req, res) {
  const db = getDb();
  const categories = db.prepare(`
    SELECT id, category_group, name, normalized_key
    FROM quote_categories
    WHERE is_active = 1
    ORDER BY sort_order ASC, name ASC
  `).all();
  const projects = db.prepare(`
    SELECT id, address, job_name, status
    FROM projects
    WHERE status != 'archived'
    ORDER BY address ASC
  `).all();
  const contractors = db.prepare(`
    SELECT id, vendor_name, contact_name, email, phone, billing_address, contractor_category, is_supplier, 'profile' as source
    FROM contractor_profiles
    WHERE is_supplier = 0
    ORDER BY vendor_name ASC
    LIMIT 500
  `).all();
  const years = db.prepare(`
    SELECT DISTINCT quote_year as year
    FROM contractor_quotes
    ORDER BY quote_year DESC
  `).all().map(row => row.year);
  res.json({ categories, projects, contractors, years, statuses: QUOTE_STATUSES });
}

function downloadQuoteDocument(req, res, forcedProjectId = null) {
  const db = getDb();
  const quote = db.prepare('SELECT * FROM contractor_quotes WHERE id = ?').get(req.params.id);
  if (!quote || (forcedProjectId && quote.project_id !== forcedProjectId)) {
    return res.status(404).json({ error: 'Quote not found' });
  }
  const doc = quote.source_document_id
    ? db.prepare('SELECT * FROM project_documents WHERE id = ? AND project_id = ?').get(quote.source_document_id, quote.project_id)
    : null;
  if (!doc) return res.status(404).json({ error: 'Quote document not found' });

  const root = path.resolve(documentRoot(quote.project_id));
  const filePath = path.resolve(root, doc.filename);
  if (!filePath.startsWith(root) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Quote file not found' });
  }
  return res.download(filePath, doc.original_name);
}

// AI quote reader: send the uploaded PDF/image to Claude and return structured quote data
// (contractor, line items mapped to real categories, totals) for the front-end to pre-fill.
async function extractQuoteFromPdf(req, res, _projectIdFromRoute = null) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI extraction is not configured on the server (missing ANTHROPIC_API_KEY).' });
    }
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ error: 'Attach a quote PDF or image to auto-read.' });
    }
    const mime = String(req.file.mimetype || '').toLowerCase();
    const isPdf = mime.includes('pdf') || /\.pdf$/i.test(req.file.originalname || '');
    const isImage = mime.startsWith('image/');
    if (!isPdf && !isImage) {
      return res.status(400).json({ error: 'Only a PDF or an image of a quote can be auto-read.' });
    }

    let Anthropic;
    try {
      Anthropic = require('@anthropic-ai/sdk');
    } catch (_e) {
      return res.status(503).json({ error: 'AI SDK is not installed on the server.' });
    }
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const categoryNames = loadCategoryMap(getDb()).categories.map((c) => c.name).filter(Boolean);
    const b64 = req.file.buffer.toString('base64');
    const docBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
      : { type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data: b64 } };

    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['contractor_name', 'line_items', 'total_quote_amount'],
      properties: {
        contractor_name: { type: 'string' },
        contractor_company: { type: 'string' },
        contractor_email: { type: 'string' },
        contractor_phone: { type: 'string' },
        scope_description: { type: 'string' },
        quote_date: { type: 'string' },
        labor_cost: { type: 'number' },
        material_cost: { type: 'number' },
        total_quote_amount: { type: 'number' },
        line_items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['category', 'description', 'total_line_item_price'],
            properties: {
              category: categoryNames.length ? { type: 'string', enum: categoryNames } : { type: 'string' },
              description: { type: 'string' },
              total_line_item_price: { type: 'number' },
            },
          },
        },
      },
    };

    const prompt =
      "You are reading a contractor's quote/estimate for a residential rehab project. Extract the structured data exactly as it appears.\n" +
      '- Money fields are plain numbers (no $, no commas).\n' +
      '- For each line item pick the single closest "category" from the allowed list; if nothing fits well use "General labor".\n' +
      '- If the quote is one lump sum with no itemization, return a single line item using the best overall category with the total as its price.\n' +
      '- Use an empty string or 0 for anything not present in the document. Do not invent values.\n' +
      '- total_quote_amount is the grand total the contractor is charging.';

    const message = await client.messages.create({
      model: QUOTE_EXTRACT_MODEL,
      max_tokens: 4096,
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: [docBlock, { type: 'text', text: prompt }] }],
    });

    const textBlock = (message.content || []).find((b) => b.type === 'text');
    if (!textBlock || !textBlock.text) {
      return res.status(502).json({ error: 'The AI did not return readable data from this file.' });
    }
    let quote;
    try {
      quote = JSON.parse(textBlock.text);
    } catch (_e) {
      return res.status(502).json({ error: 'The AI returned data that could not be parsed.' });
    }

    return res.json({
      ok: true,
      model: QUOTE_EXTRACT_MODEL,
      tokens: message.usage ? { input: message.usage.input_tokens, output: message.usage.output_tokens } : null,
      quote,
    });
  } catch (err) {
    const status = err && Number.isInteger(err.status) ? err.status : 500;
    console.error('[quote-extract] failed:', err && err.message ? err.message : err);
    return res
      .status(status >= 400 && status < 600 ? status : 500)
      .json({ error: err && err.message ? `AI extraction failed: ${err.message}` : 'AI extraction failed.' });
  }
}

// Bid leveling / side-by-side comparison for one project. Read-only aggregation over
// existing contractor_quotes + quote_line_items. Original contractor amounts are returned
// verbatim and never mutated here; any leveling "adjustments" live only in the client.
function compareQuotes(req, res, forcedProjectId = null) {
  const db = getDb();
  const projectId = forcedProjectId || String(req.query.project_id || '').trim();
  if (!projectId) {
    return res.status(400).json({ error: 'project_id is required for bid comparison' });
  }
  const project = getProjectOrThrow(db, projectId);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const categoryFilter = String(req.query.category || '').trim();
  const includeHistorical = String(req.query.include_historical || '') === '1';

  const quoteRows = db.prepare(`
    SELECT id, quote_number, contractor_name, contractor_company, contractor_email,
           status, quote_date, total_quote_amount, final_approved_amount, data_quality_flags, created_at,
           source_document_id, source_file_name, source_file_mime_type
    FROM contractor_quotes
    WHERE project_id = ?
    ${includeHistorical ? '' : "AND status != 'historical'"}
    ORDER BY date(quote_date) DESC, datetime(created_at) DESC
  `).all(projectId);

  const quoteIds = quoteRows.map(row => row.id);
  const lineItemsByQuote = new Map();
  if (quoteIds.length > 0) {
    const placeholders = quoteIds.map(() => '?').join(',');
    const lineItems = db.prepare(`
      SELECT quote_id, category, category_group, subcategory, description,
             quantity, unit, unit_price, total_line_item_price
      FROM quote_line_items
      WHERE quote_id IN (${placeholders})
      ORDER BY sort_order ASC
    `).all(...quoteIds);
    for (const item of lineItems) {
      const list = lineItemsByQuote.get(item.quote_id) || [];
      list.push(item);
      lineItemsByQuote.set(item.quote_id, list);
    }
  }

  const contractors = quoteRows.map(row => ({
    quote_id: row.id,
    quote_number: row.quote_number,
    contractor_name: row.contractor_name,
    contractor_company: row.contractor_company,
    contractor_email: row.contractor_email,
    status: row.status,
    quote_date: row.quote_date,
    total_quote_amount: numberValue(row.total_quote_amount),
    final_approved_amount: row.final_approved_amount === null || row.final_approved_amount === undefined
      ? null
      : numberValue(row.final_approved_amount),
    data_quality_flags: parseJson(row.data_quality_flags, []),
    line_item_count: (lineItemsByQuote.get(row.id) || []).length,
    has_document: !!row.source_document_id,
    source_file_name: row.source_file_name || null,
    source_file_mime_type: row.source_file_mime_type || null,
  }));

  // category -> quote_id -> { amount, line_items }
  const categoryOrder = [];
  const categorySeen = new Set();
  const cellMap = new Map();
  for (const row of quoteRows) {
    for (const item of (lineItemsByQuote.get(row.id) || [])) {
      const category = item.category || 'Uncategorized';
      if (categoryFilter && category !== categoryFilter) continue;
      if (!categorySeen.has(category)) {
        categorySeen.add(category);
        categoryOrder.push({ category, category_group: item.category_group || '' });
      }
      if (!cellMap.has(category)) cellMap.set(category, new Map());
      const byQuote = cellMap.get(category);
      const current = byQuote.get(row.id) || { amount: 0, line_items: [] };
      current.amount += numberValue(item.total_line_item_price);
      current.line_items.push(item);
      byQuote.set(row.id, current);
    }
  }

  const rows = categoryOrder
    .sort((a, b) => a.category.localeCompare(b.category))
    .map(({ category, category_group }) => {
      const byQuote = cellMap.get(category) || new Map();
      const cells = {};
      const presentValues = [];
      const missingQuoteIds = [];
      for (const row of quoteRows) {
        const cell = byQuote.get(row.id);
        if (cell) {
          cells[row.id] = { amount: cell.amount, present: true, line_items: cell.line_items };
          presentValues.push(cell.amount);
        } else {
          cells[row.id] = { amount: null, present: false, line_items: [] };
          missingQuoteIds.push(row.id);
        }
      }
      const low = presentValues.length ? Math.min(...presentValues) : 0;
      const high = presentValues.length ? Math.max(...presentValues) : 0;
      const average = presentValues.length
        ? presentValues.reduce((sum, value) => sum + value, 0) / presentValues.length
        : 0;
      return {
        category,
        category_group,
        cells,
        present_count: presentValues.length,
        missing_quote_ids: missingQuoteIds,
        has_missing: missingQuoteIds.length > 0 && quoteRows.length > 1,
        low,
        high,
        average,
        spread: high - low,
      };
    });

  const totals = quoteRows.map(row => numberValue(row.total_quote_amount));
  const squareFootage = project.square_footage === undefined || project.square_footage === null
    ? null
    : numberValue(project.square_footage);

  return res.json({
    project: {
      id: project.id,
      address: project.address,
      job_name: project.job_name,
      budget: project.budget === null || project.budget === undefined ? null : numberValue(project.budget),
      square_footage: squareFootage,
    },
    category_filter: categoryFilter || null,
    contractors,
    rows,
    totals: {
      by_quote: Object.fromEntries(quoteRows.map(row => [row.id, numberValue(row.total_quote_amount)])),
      low: totals.length ? Math.min(...totals) : 0,
      high: totals.length ? Math.max(...totals) : 0,
      average: totals.length ? totals.reduce((sum, value) => sum + value, 0) / totals.length : 0,
      price_per_sqft_by_quote: squareFootage
        ? Object.fromEntries(quoteRows.map(row => [row.id, numberValue(row.total_quote_amount) / squareFootage]))
        : null,
    },
  });
}

const analyticsRouter = express.Router();
analyticsRouter.use(authenticate, requireManagement);
analyticsRouter.get('/options', options);
analyticsRouter.get('/categories', (req, res) => res.json(loadCategoryMap(getDb()).categories));
analyticsRouter.get('/summary', (req, res) => quoteSummary(req, res));
analyticsRouter.get('/compare', (req, res) => compareQuotes(req, res));
analyticsRouter.get('/quotes', (req, res) => listQuotes(req, res));
analyticsRouter.post('/quotes', (req, res) => createQuote(req, res));
analyticsRouter.post('/quotes/upload', upload.single('quote_file'), (req, res) => createQuote(req, res));
analyticsRouter.put('/quotes/:id', (req, res) => updateQuote(req, res));
analyticsRouter.post('/quotes/:id/approve', (req, res) => updateQuoteReviewStatus(req, res, null, 'approved'));
analyticsRouter.post('/quotes/:id/deny', (req, res) => updateQuoteReviewStatus(req, res, null, 'rejected'));
analyticsRouter.post('/quotes/:id/restore', (req, res) => updateQuoteReviewStatus(req, res, null, 'submitted'));
analyticsRouter.delete('/quotes/:id', (req, res) => deleteQuote(req, res));
analyticsRouter.get('/quotes/:id/notes', (req, res) => listQuoteNotes(req, res));
analyticsRouter.post('/quotes/:id/notes', (req, res) => addQuoteNote(req, res));
analyticsRouter.delete('/quotes/:id/notes/:noteId', (req, res) => deleteQuoteNote(req, res));
analyticsRouter.get('/quotes/:id/download', (req, res) => downloadQuoteDocument(req, res));
// Project-agnostic AI read so the global Quote Center can auto-extract on upload
// before a project is chosen. extractQuoteFromPdf does not use the project; it only
// reads the uploaded file and returns structured fields (nothing is persisted).
analyticsRouter.post('/extract', extractUpload.single('quote_file'), (req, res) => extractQuoteFromPdf(req, res));

const projectQuotesRouter = express.Router({ mergeParams: true });
projectQuotesRouter.use(authenticate, requireManagement, authorizeProjectAccess);
projectQuotesRouter.get('/', (req, res) => listQuotes(req, res, req.params.projectId));
projectQuotesRouter.get('/summary', (req, res) => quoteSummary(req, res, req.params.projectId));
projectQuotesRouter.get('/compare', (req, res) => compareQuotes(req, res, req.params.projectId));
projectQuotesRouter.post('/', (req, res) => createQuote(req, res, req.params.projectId));
projectQuotesRouter.post('/upload', upload.single('quote_file'), (req, res) => createQuote(req, res, req.params.projectId));
projectQuotesRouter.put('/:id', (req, res) => updateQuote(req, res, req.params.projectId));
projectQuotesRouter.post('/extract', extractUpload.single('quote_file'), (req, res) => extractQuoteFromPdf(req, res, req.params.projectId));
projectQuotesRouter.post('/:id/approve', (req, res) => updateQuoteReviewStatus(req, res, req.params.projectId, 'approved'));
projectQuotesRouter.post('/:id/deny', (req, res) => updateQuoteReviewStatus(req, res, req.params.projectId, 'rejected'));
projectQuotesRouter.post('/:id/restore', (req, res) => updateQuoteReviewStatus(req, res, req.params.projectId, 'submitted'));
projectQuotesRouter.delete('/:id', (req, res) => deleteQuote(req, res, req.params.projectId));
projectQuotesRouter.get('/:id/notes', (req, res) => listQuoteNotes(req, res, req.params.projectId));
projectQuotesRouter.post('/:id/notes', (req, res) => addQuoteNote(req, res, req.params.projectId));
projectQuotesRouter.delete('/:id/notes/:noteId', (req, res) => deleteQuoteNote(req, res));
projectQuotesRouter.get('/:id/download', (req, res) => downloadQuoteDocument(req, res, req.params.projectId));

module.exports = {
  analyticsRouter,
  projectQuotesRouter,
};
