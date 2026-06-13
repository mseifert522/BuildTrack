const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { getDb } = require('../db/schema');
const { authenticate, authorize, authorizeProjectAccess } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { sendVendorQuoteRequestEmail } = require('../utils/email');
const { cleanPhone, sendContractorText } = require('../utils/textMessaging');

const router = express.Router();
const MANAGEMENT_ROLES = ['super_admin', 'operations_manager', 'project_manager'];
const QUOTE_EXPIRATION_BUSINESS_DAYS = 7;
const PDF_MAX_FILE_SIZE_MB = Math.max(Number.parseInt(process.env.VENDOR_QUOTE_PDF_MAX_MB || process.env.MAX_FILE_SIZE_MB || '20', 10) || 20, 1);

function uploadBase() {
  return process.env.UPLOADS_PATH || './uploads';
}

function quoteDocumentRoot(projectId) {
  return path.join(uploadBase(), 'documents', projectId);
}

function quotePdfTmpRoot() {
  return path.join(uploadBase(), 'vendor-quote-uploads', 'tmp');
}

function sanitizeFilename(filename) {
  const base = path.basename(String(filename || 'vendor-quote.pdf'));
  return base.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 180) || 'vendor-quote.pdf';
}

function removeUploadedFile(file) {
  if (!file?.path) return;
  try {
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
  } catch (_) {
    // Best-effort cleanup only.
  }
}

const quotePdfUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = quotePdfTmpRoot();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      cb(null, `${new Date().toISOString().replace(/[:.]/g, '-')}_${uuidv4()}${path.extname(file.originalname || '.pdf') || '.pdf'}`);
    },
  }),
  limits: {
    files: 1,
    fileSize: PDF_MAX_FILE_SIZE_MB * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const originalName = String(file.originalname || '').toLowerCase();
    const mimeType = String(file.mimetype || '').toLowerCase();
    if (mimeType === 'application/pdf' || originalName.endsWith('.pdf')) return cb(null, true);
    return cb(new Error('Only PDF quote uploads are allowed'));
  },
});

function quotePdfUploadMiddleware(req, res, next) {
  quotePdfUpload.fields([
    { name: 'quote_pdf', maxCount: 1 },
    { name: 'quote_file', maxCount: 1 },
  ])(req, res, err => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `PDF quote must be ${PDF_MAX_FILE_SIZE_MB}MB or smaller`
      : err.message || 'Invalid PDF quote upload';
    return res.status(400).json({ error: message });
  });
}

function requestQuotePdf(req) {
  return req.files?.quote_pdf?.[0] || req.files?.quote_file?.[0] || null;
}

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function persistVendorQuotePdf(projectId, file) {
  if (!file) return null;
  const dir = quoteDocumentRoot(projectId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}_${uuidv4()}.pdf`;
  const destination = path.join(dir, filename);
  fs.renameSync(file.path, destination);
  return {
    filename,
    originalName: sanitizeFilename(file.originalname),
    relativePath: path.join('documents', projectId, filename).replace(/\\/g, '/'),
    fullPath: destination,
  };
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEmail(value) {
  return cleanString(value).toLowerCase();
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function numberValue(value, fallback = 0) {
  if (value === '' || value === null || value === undefined) return fallback;
  const parsed = Number(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function baseUrl() {
  return (process.env.APP_URL || process.env.FRONTEND_URL || 'https://buildtrack.newurbandev.com').replace(/\/+$/, '');
}

function cityFromProjectAddress(address) {
  const parts = cleanString(address).split(',').map(part => part.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[1].replace(/\s+\d{5}(?:-\d{4})?\b.*$/, '').trim();
  return '';
}

function publicProjectLabel(project) {
  return cityFromProjectAddress(project?.address) || 'BuildTrack project';
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactProjectAddress(value, project) {
  let result = cleanString(value);
  if (!result) return '';
  const replacement = publicProjectLabel(project);
  const address = cleanString(project?.address);
  const streetLine = address.includes(',') ? address.split(',')[0].trim() : '';
  const jobName = /\d/.test(cleanString(project?.job_name)) ? cleanString(project?.job_name) : '';
  for (const candidate of [address, streetLine, jobName]) {
    if (!candidate || candidate.length < 5) continue;
    result = result.replace(new RegExp(escapeRegExp(candidate), 'gi'), replacement);
  }
  return result;
}

function addBusinessDays(days) {
  const date = new Date();
  let remaining = Math.max(Number.parseInt(days, 10) || 0, 0);
  while (remaining > 0) {
    date.setDate(date.getDate() + 1);
    const day = date.getDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return date.toISOString();
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function validateDate(value) {
  if (!value) return todayIsoDate();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return todayIsoDate();
  return parsed.toISOString().slice(0, 10);
}

function loadQuoteCategories(db) {
  return db.prepare(`
    SELECT id, category_group, name, normalized_key
    FROM quote_categories
    WHERE is_active = 1
    ORDER BY sort_order ASC, name ASC
  `).all();
}

function quoteCategoryMap(categories) {
  const byKey = new Map();
  for (const category of categories) {
    byKey.set(normalizeKey(category.name), category);
    byKey.set(normalizeKey(category.normalized_key), category);
  }
  return byKey;
}

function fallbackCategory(categories) {
  return categories.find(category => normalizeKey(category.name) === 'miscellaneous')
    || categories.find(category => normalizeKey(category.name) === 'general-labor')
    || categories[0]
    || { id: null, category_group: 'Project Operations', name: 'Miscellaneous' };
}

function inferCategoryForScope(categories, scope) {
  const text = normalizeKey([
    scope?.section_name,
    scope?.scope_title,
    scope?.scope_of_work,
  ].filter(Boolean).join(' '));
  const match = categories.find(category => {
    const key = normalizeKey(category.name);
    return key && text.includes(key);
  });
  return match || fallbackCategory(categories);
}

function resolveCategory(categories, requestedCategory, scope) {
  const byKey = quoteCategoryMap(categories);
  const category = byKey.get(normalizeKey(requestedCategory));
  return category || inferCategoryForScope(categories, scope);
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

function getRequestByToken(db, token) {
  if (!token || String(token).length < 32) return null;
  return db.prepare(`
    SELECT
      vqr.*,
      p.address,
      p.job_name,
      p.status as project_status,
      cp.vendor_name as profile_vendor_name,
      cp.contact_name as profile_contact_name,
      cp.email as profile_email,
      cp.phone as profile_phone,
      u.name as requested_by_name
    FROM vendor_quote_requests vqr
    JOIN projects p ON p.id = vqr.project_id
    LEFT JOIN contractor_profiles cp ON cp.id = vqr.contractor_profile_id
    LEFT JOIN users u ON u.id = vqr.created_by
    WHERE vqr.token_hash = ?
    LIMIT 1
  `).get(tokenHash(token));
}

function assertRequestVisible(db, request) {
  if (!request) {
    const err = new Error('Quote link is invalid');
    err.statusCode = 404;
    throw err;
  }
  if (request.status === 'revoked') {
    const err = new Error('Quote link is no longer active');
    err.statusCode = 410;
    throw err;
  }
  if (request.status !== 'submitted' && Date.parse(request.expires_at) <= Date.now()) {
    db.prepare(`
      UPDATE vendor_quote_requests
      SET status = 'expired', updated_at = datetime('now')
      WHERE id = ? AND status NOT IN ('submitted', 'revoked')
    `).run(request.id);
    const err = new Error('Quote link has expired');
    err.statusCode = 410;
    throw err;
  }
}

function selectedScopes(db, request, includePhotos = true) {
  const scopes = db.prepare(`
    SELECT ps.*, vqrs.sort_order as request_sort_order
    FROM vendor_quote_request_scopes vqrs
    JOIN project_scopes ps ON ps.id = vqrs.scope_id
    WHERE vqrs.request_id = ?
      AND vqrs.project_id = ?
    ORDER BY vqrs.sort_order ASC, ps.sort_order ASC
  `).all(request.id, request.project_id);

  if (!scopes.length) return scopes;
  const scopeIds = scopes.map(scope => scope.id);
  const placeholders = scopeIds.map(() => '?').join(',');

  const planRows = db.prepare(`
    SELECT id, project_scope_id, title, description, category, status, sort_order
    FROM construction_plan_items
    WHERE project_id = ?
      AND project_scope_id IN (${placeholders})
    ORDER BY sort_order ASC, datetime(created_at) ASC
  `).all(request.project_id, ...scopeIds);

  const planByScope = new Map();
  for (const item of planRows) {
    const list = planByScope.get(item.project_scope_id) || [];
    list.push(item);
    planByScope.set(item.project_scope_id, list);
  }

  const photosByScope = new Map();
  if (includePhotos && Number(request.include_photos) === 1) {
    const photos = db.prepare(`
      SELECT
        pa.target_id as scope_id,
        ph.id,
        ph.filename,
        ph.original_name,
        ph.mime_type,
        ph.caption,
        ph.taken_at,
        ph.captured_at,
        ph.created_at,
        ph.individual_note,
        ph.batch_note
      FROM photo_assignments pa
      JOIN photos ph ON ph.id = pa.photo_id
      WHERE pa.project_id = ?
        AND pa.target_type = 'project_scope'
        AND pa.target_id IN (${placeholders})
        AND ph.project_id = pa.project_id
        AND COALESCE(ph.upload_status, 'uploaded') != 'correction_deleted'
        AND ph.correction_deleted_at IS NULL
      ORDER BY datetime(pa.created_at) DESC, datetime(COALESCE(ph.captured_at, ph.taken_at, ph.created_at)) DESC
    `).all(request.project_id, ...scopeIds);

    for (const photo of photos) {
      const list = photosByScope.get(photo.scope_id) || [];
      list.push({
        ...photo,
        url: `/uploads/${request.project_id}/${photo.filename}`,
      });
      photosByScope.set(photo.scope_id, list);
    }
  }

  return scopes.map(scope => ({
    ...scope,
    execution_items: planByScope.get(scope.id) || [],
    photos: photosByScope.get(scope.id) || [],
  }));
}

function publicPayload(db, request) {
  const categories = loadQuoteCategories(db);
  const scopes = selectedScopes(db, request, true).map(scope => {
    const suggested = inferCategoryForScope(categories, scope);
    return {
      id: scope.id,
      section_name: redactProjectAddress(scope.section_name, request),
      scope_title: redactProjectAddress(scope.scope_title, request),
      scope_of_work: redactProjectAddress(scope.scope_of_work, request),
      status: scope.status,
      sort_order: scope.sort_order,
      execution_items: scope.execution_items || [],
      photos: scope.photos || [],
      suggested_category: suggested.name,
    };
  });

  return {
    request: {
      vendor_name: request.vendor_name,
      vendor_email: request.vendor_email,
      vendor_phone: request.vendor_phone || '',
      message: redactProjectAddress(request.message || '', request),
      include_photos: Number(request.include_photos) === 1,
      status: request.status,
      expires_at: request.expires_at,
      submitted_at: request.submitted_at || null,
    },
    project: {
      id: request.project_id,
      city: cityFromProjectAddress(request.address),
      label: publicProjectLabel(request),
    },
    scopes,
    categories: categories.map(category => ({
      id: category.id,
      group: category.category_group,
      name: category.name,
    })),
  };
}

function scopeDescription(scopes) {
  return scopes.map((scope, index) => {
    const heading = `${index + 1}. ${scope.scope_title || 'Scope item'}${scope.section_name ? ` (${scope.section_name})` : ''}`;
    return [heading, normalizeScopeLineItems(scope.scope_of_work).join('\n') || cleanString(scope.scope_of_work)].filter(Boolean).join('\n');
  }).join('\n\n');
}

function normalizeScopeLineItems(value) {
  const items = cleanString(value)
    .replace(/\r/g, '\n')
    .replace(/[•·]/g, '\n')
    .replace(/(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/g, '\n')
    .replace(/([.!?])\s+(?=[A-Z0-9])/g, '$1\n')
    .split(/\n+/)
    .map(item => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return items;
}

function buildQuoteLineItems(categories, scopes, body) {
  const scopeById = new Map(scopes.map(scope => [String(scope.id), scope]));
  const rawItems = arrayValue(body.line_items);
  const lineItems = [];

  for (const raw of rawItems) {
    const scope = scopeById.get(String(raw?.scope_id || ''));
    const total = numberValue(raw?.total_line_item_price ?? raw?.amount, 0);
    if (!scope || total <= 0) continue;
    const quantity = Math.max(numberValue(raw?.quantity, 1), 1);
    const category = resolveCategory(categories, raw?.category, scope);
    lineItems.push({
      category_id: category.id || null,
      category_group: category.category_group || 'Project Operations',
      category: category.name || 'Miscellaneous',
      subcategory: cleanString(raw?.subcategory) || null,
      description: cleanString(raw?.description) || scope.scope_title || category.name || 'Scope quote',
      quantity,
      unit: cleanString(raw?.unit) || 'scope',
      unit_price: numberValue(raw?.unit_price, total / quantity),
      total_line_item_price: total,
      labor_amount: numberValue(raw?.labor_amount, 0),
      material_amount: numberValue(raw?.material_amount, 0),
      sort_order: lineItems.length,
    });
  }

  const submittedTotal = numberValue(body.total_quote_amount, 0);
  if (!lineItems.length && submittedTotal > 0) {
    const category = fallbackCategory(categories);
    lineItems.push({
      category_id: category.id || null,
      category_group: category.category_group || 'Project Operations',
      category: category.name || 'Miscellaneous',
      subcategory: null,
      description: 'Selected scope of work',
      quantity: 1,
      unit: 'scope',
      unit_price: submittedTotal,
      total_line_item_price: submittedTotal,
      labor_amount: numberValue(body.labor_cost, 0),
      material_amount: numberValue(body.material_cost, 0),
      sort_order: 0,
    });
  }

  return lineItems;
}

function createSubmittedQuote(db, request, body, file = null) {
  if (request.status === 'submitted') {
    const err = new Error('This quote request has already been submitted');
    err.statusCode = 409;
    throw err;
  }

  const scopes = selectedScopes(db, request, false);
  if (!scopes.length) {
    const err = new Error('No scope items are available for this quote request');
    err.statusCode = 400;
    throw err;
  }

  const categories = loadQuoteCategories(db);
  const lineItems = buildQuoteLineItems(categories, scopes, body || {});
  const lineTotal = lineItems.reduce((sum, item) => sum + item.total_line_item_price, 0);
  const totalQuoteAmount = Math.max(numberValue(body.total_quote_amount, lineTotal) || lineTotal, 0);
  if ((!totalQuoteAmount || totalQuoteAmount <= 0 || !lineItems.length) && !file) {
    const err = new Error('Quote pricing is required');
    err.statusCode = 400;
    throw err;
  }

  let uploadedFileHash = null;
  if (file) {
    uploadedFileHash = fileHash(file.path);
    const duplicate = db.prepare('SELECT quote_number FROM contractor_quotes WHERE project_id = ? AND source_file_hash = ?').get(request.project_id, uploadedFileHash);
    if (duplicate) {
      const err = new Error(`Duplicate quote PDF detected for ${duplicate.quote_number}`);
      err.statusCode = 409;
      throw err;
    }
  }

  const quoteDate = validateDate(body.quote_date);
  const quoteYear = new Date(`${quoteDate}T00:00:00Z`).getUTCFullYear();
  const contractorName = cleanString(body.contractor_name) || request.profile_contact_name || request.vendor_name;
  const contractorCompany = cleanString(body.contractor_company) || request.profile_vendor_name || request.vendor_name;
  const contractorEmail = normalizeEmail(body.contractor_email) || request.vendor_email || request.profile_email || '';
  const contractorPhone = cleanString(body.contractor_phone) || request.vendor_phone || request.profile_phone || '';

  const quoteId = uuidv4();
  const quoteNumber = nextQuoteNumber(db, quoteYear);
  const now = new Date().toISOString();
  const notes = cleanString(body.notes);
  const dataQualityFlags = ['vendor_quote_link'];
  if (!contractorEmail && !contractorPhone) dataQualityFlags.push('missing_contractor_contact');
  if (file) dataQualityFlags.push('vendor_pdf_quote');
  if (file && !lineItems.length) dataQualityFlags.push('pdf_only_quote');
  let storedPdf = null;

  let created;
  try {
    created = db.transaction(() => {
      let sourceDocumentId = null;
      let sourceFileName = null;
      let sourceFilePath = null;
      let sourceFileMimeType = null;
      let sourceFileSize = null;

      if (file) {
        storedPdf = persistVendorQuotePdf(request.project_id, file);
        sourceDocumentId = uuidv4();
        sourceFileName = storedPdf.originalName;
        sourceFilePath = storedPdf.relativePath;
        sourceFileMimeType = 'application/pdf';
        sourceFileSize = file.size;
        db.prepare(`
          INSERT INTO project_documents (id, project_id, filename, original_name, mime_type, size, document_type, uploaded_by)
          VALUES (?, ?, ?, ?, ?, ?, 'quotes', ?)
        `).run(sourceDocumentId, request.project_id, storedPdf.filename, storedPdf.originalName, 'application/pdf', file.size, request.created_by);
      }

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
        ?, ?, 'submitted', ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        'vendor_link', ?, ?
      )
    `).run(
      quoteId,
      quoteNumber,
      request.project_id,
      request.address || request.job_name || 'Project',
      request.job_name || request.address || 'Project',
      null,
      request.contractor_profile_id || null,
      contractorName || contractorCompany,
      contractorCompany || contractorName,
      contractorEmail || null,
      contractorPhone || null,
      cleanString(body.contractor_address) || null,
      quoteDate,
      quoteYear,
      scopeDescription(scopes),
      notes || null,
      totalQuoteAmount,
      numberValue(body.labor_cost, 0),
      numberValue(body.material_cost, 0),
      numberValue(body.permit_costs, 0),
      numberValue(body.equipment_costs, 0),
      numberValue(body.disposal_cleanup_costs, 0),
      numberValue(body.tax, 0),
      numberValue(body.insurance, 0),
      numberValue(body.overhead, 0),
      numberValue(body.profit_margin, null),
      numberValue(body.contingency, 0),
      numberValue(body.final_approved_amount, null),
      sourceDocumentId,
      sourceFileName,
      sourceFilePath,
      sourceFileMimeType,
      sourceFileSize,
      uploadedFileHash,
      JSON.stringify(dataQualityFlags),
      request.created_by
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
          item.subcategory,
          item.description,
          item.quantity,
          item.unit,
          item.unit_price,
          item.total_line_item_price,
          item.labor_amount,
          item.material_amount,
          item.sort_order
        );
      }

      const snapshot = {
        quote: db.prepare('SELECT * FROM contractor_quotes WHERE id = ?').get(quoteId),
        line_items: db.prepare('SELECT * FROM quote_line_items WHERE quote_id = ? ORDER BY sort_order ASC').all(quoteId),
      };
      db.prepare(`
      INSERT INTO historical_quote_records (id, quote_id, project_id, quote_year, action, snapshot_json, actor_id)
      VALUES (?, ?, ?, ?, 'vendor_submitted', ?, ?)
    `).run(uuidv4(), quoteId, request.project_id, quoteYear, JSON.stringify(snapshot), request.created_by);

      db.prepare(`
      UPDATE vendor_quote_requests
      SET status = 'submitted', submitted_at = ?, submitted_quote_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(now, quoteId, request.id);

      return snapshot;
    })();
  } catch (err) {
    if (storedPdf?.fullPath) removeUploadedFile({ path: storedPdf.fullPath });
    throw err;
  }

  logActivity({
    userId: request.created_by,
    projectId: request.project_id,
    action: 'vendor_quote_submitted',
    entityType: 'contractor_quote',
    entityId: quoteId,
    details: { request_id: request.id, quote_number: quoteNumber, vendor_email: contractorEmail || request.vendor_email, total: totalQuoteAmount },
  });

  return created;
}

router.get('/public/:token', (req, res) => {
  const db = getDb();
  try {
    const request = getRequestByToken(db, req.params.token);
    assertRequestVisible(db, request);
    if (request.status === 'sent') {
      db.prepare(`
        UPDATE vendor_quote_requests
        SET status = 'opened', opened_at = COALESCE(opened_at, ?), updated_at = datetime('now')
        WHERE id = ? AND status = 'sent'
      `).run(new Date().toISOString(), request.id);
      request.status = 'opened';
    }
    res.json(publicPayload(db, request));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to load quote request' });
  }
});

router.post('/public/:token/submit', quotePdfUploadMiddleware, (req, res) => {
  const db = getDb();
  const quotePdf = requestQuotePdf(req);
  try {
    const request = getRequestByToken(db, req.params.token);
    assertRequestVisible(db, request);
    const created = createSubmittedQuote(db, request, req.body || {}, quotePdf);
    res.status(201).json({
      message: 'Quote submitted',
      quote: {
        id: created.quote.id,
        quote_number: created.quote.quote_number,
        total_quote_amount: created.quote.total_quote_amount,
        source_file_name: created.quote.source_file_name || null,
      },
    });
  } catch (err) {
    removeUploadedFile(quotePdf);
    console.error('[VENDOR_QUOTE] submit failed:', err);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to submit quote' });
  }
});

router.use(authenticate);

router.get('/projects/:projectId', authorize(...MANAGEMENT_ROLES), authorizeProjectAccess, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      vqr.id,
      vqr.vendor_name,
      vqr.vendor_email,
      vqr.vendor_phone,
      vqr.status,
      vqr.include_photos,
      vqr.expires_at,
      vqr.sent_at,
      vqr.opened_at,
      vqr.submitted_at,
      vqr.submitted_quote_id,
      vqr.created_at,
      u.name as created_by_name,
      cq.quote_number,
      cq.total_quote_amount
    FROM vendor_quote_requests vqr
    LEFT JOIN users u ON u.id = vqr.created_by
    LEFT JOIN contractor_quotes cq ON cq.id = vqr.submitted_quote_id
    WHERE vqr.project_id = ?
    ORDER BY datetime(vqr.created_at) DESC
    LIMIT 50
  `).all(req.params.projectId);
  res.json({ requests: rows });
});

router.post('/projects/:projectId', authorize(...MANAGEMENT_ROLES), authorizeProjectAccess, async (req, res) => {
  const db = getDb();
  try {
    const project = db.prepare('SELECT id, address, job_name FROM projects WHERE id = ?').get(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const sendEmail = booleanValue(req.body?.send_email, true);
    const sendText = booleanValue(req.body?.send_text, false);
    if (!sendEmail && !sendText) {
      return res.status(400).json({ error: 'Choose email, text, or both before sending the quote request' });
    }

    const requestedContractorIds = Array.isArray(req.body?.contractor_profile_ids)
      ? Array.from(new Set(req.body.contractor_profile_ids.map(value => String(value || '').trim()).filter(Boolean)))
      : [];
    const singleContractorProfileId = cleanString(req.body?.contractor_profile_id);
    const contractorProfileIds = requestedContractorIds.length
      ? requestedContractorIds
      : (singleContractorProfileId ? [singleContractorProfileId] : []);
    if (contractorProfileIds.length > 50) return res.status(400).json({ error: 'Quote requests are limited to 50 contractors at once' });

    const contractorProfiles = contractorProfileIds.length
      ? db.prepare(`
          SELECT id, vendor_name, contact_name, email, phone
          FROM contractor_profiles
          WHERE id IN (${contractorProfileIds.map(() => '?').join(',')})
        `).all(...contractorProfileIds)
      : [];
    if (contractorProfileIds.length && contractorProfiles.length !== contractorProfileIds.length) {
      return res.status(400).json({ error: 'One or more selected contractors were not found' });
    }
    const contractorById = new Map(contractorProfiles.map(profile => [String(profile.id), profile]));
    const recipients = contractorProfileIds.length
      ? contractorProfileIds.map(contractorProfileId => {
          const contractorProfile = contractorById.get(contractorProfileId);
          return {
            contractorProfileId,
            contractorProfile,
            vendorName: cleanString(contractorProfile?.vendor_name || contractorProfile?.contact_name),
            vendorEmail: normalizeEmail(contractorProfile?.email),
            vendorPhone: cleanString(contractorProfile?.phone),
          };
        })
      : [{
          contractorProfileId: null,
          contractorProfile: null,
          vendorName: cleanString(req.body?.vendor_name),
          vendorEmail: normalizeEmail(req.body?.vendor_email),
          vendorPhone: cleanString(req.body?.vendor_phone),
        }];

    if (!recipients.length) return res.status(400).json({ error: 'Select at least one contractor' });
    const missingName = recipients.find(recipient => !recipient.vendorName);
    if (missingName) return res.status(400).json({ error: 'Every selected contractor needs a vendor name' });
    const missingEmail = recipients.find(recipient => !isEmail(recipient.vendorEmail));
    if (missingEmail) return res.status(400).json({ error: 'Every selected contractor needs a valid email address' });
    if (sendText) {
      const missingTextProfile = recipients.find(recipient => !recipient.contractorProfileId);
      if (missingTextProfile) return res.status(400).json({ error: 'Select contractors from the contractor list before texting quote links' });
      const missingPhone = recipients.find(recipient => !cleanPhone(recipient.vendorPhone));
      if (missingPhone) return res.status(400).json({ error: 'Every selected contractor needs a usable phone number for text delivery' });
    }

    const requestedScopeIds = Array.isArray(req.body?.scope_ids)
      ? Array.from(new Set(req.body.scope_ids.map(value => String(value || '').trim()).filter(Boolean)))
      : [];
    if (!requestedScopeIds.length) return res.status(400).json({ error: 'Select at least one scope section' });
    if (requestedScopeIds.length > 100) return res.status(400).json({ error: 'Quote requests are limited to 100 scope sections' });

    const placeholders = requestedScopeIds.map(() => '?').join(',');
    const scopes = db.prepare(`
      SELECT id, section_name, scope_title, scope_of_work, sort_order
      FROM project_scopes
      WHERE project_id = ?
        AND id IN (${placeholders})
      ORDER BY sort_order ASC, datetime(created_at) ASC
    `).all(req.params.projectId, ...requestedScopeIds);
    if (scopes.length !== requestedScopeIds.length) return res.status(400).json({ error: 'One or more scope sections were not found' });

    const expiresAt = addBusinessDays(QUOTE_EXPIRATION_BUSINESS_DAYS);
    const includePhotos = req.body?.include_photos === false ? 0 : 1;
    const now = new Date().toISOString();
    const message = redactProjectAddress(req.body?.message, project);

    const createdRequests = [];
    for (const recipient of recipients) {
      const token = crypto.randomBytes(32).toString('base64url');
      const requestId = uuidv4();

      db.transaction(() => {
        db.prepare(`
          INSERT INTO vendor_quote_requests (
            id, project_id, contractor_profile_id, vendor_name, vendor_email, vendor_phone,
            token_hash, message, include_photos, status, expires_at, sent_at, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?)
        `).run(
          requestId,
          project.id,
          recipient.contractorProfileId,
          recipient.vendorName,
          recipient.vendorEmail,
          recipient.vendorPhone || null,
          tokenHash(token),
          message || null,
          includePhotos,
          expiresAt,
          now,
          req.user.id
        );

        const insertScope = db.prepare(`
          INSERT INTO vendor_quote_request_scopes (id, request_id, project_id, scope_id, sort_order)
          VALUES (?, ?, ?, ?, ?)
        `);
        scopes.forEach((scope, index) => {
          insertScope.run(uuidv4(), requestId, project.id, scope.id, index + 1);
        });
      })();

      const requestUrl = `${baseUrl()}/vendor-quote/${token}`;
      const emailScopes = selectedScopes(db, {
        id: requestId,
        project_id: project.id,
        include_photos: includePhotos,
      }, true).map(scope => ({
        ...scope,
        section_name: redactProjectAddress(scope.section_name, project),
        scope_title: redactProjectAddress(scope.scope_title, project),
        scope_of_work: normalizeScopeLineItems(redactProjectAddress(scope.scope_of_work, project)).join('\n'),
        photos: (Array.isArray(scope.photos) ? scope.photos : []).map(photo => ({
          ...photo,
          url: `${baseUrl()}${String(photo.url || '').startsWith('/') ? '' : '/'}${photo.url || ''}`,
        })),
      }));

      let emailSent = false;
      if (sendEmail) {
        await sendVendorQuoteRequestEmail({
          vendorName: recipient.vendorName,
          vendorEmail: recipient.vendorEmail,
          project: { ...project, public_label: publicProjectLabel(project), city: cityFromProjectAddress(project.address) },
          requestUrl,
          expiresAt,
          message,
          scopes: emailScopes,
          includePhotos: Boolean(includePhotos),
          requestedBy: req.user.name,
        });
        emailSent = true;
      }

      let textDelivery = null;
      if (sendText && recipient.contractorProfile) {
        const textBody = [
          `BuildTrack quote requested for ${publicProjectLabel(project)}.`,
          message ? `Message: ${message}` : '',
          `Open secure quote link: ${requestUrl}`,
          `Expires: ${new Date(expiresAt).toLocaleDateString('en-US')}`,
        ].filter(Boolean).join('\n');
        textDelivery = await sendContractorText({
          to: recipient.vendorPhone,
          body: textBody,
          metadata: {
            project_id: project.id,
            project_label: publicProjectLabel(project),
            contractor_id: recipient.contractorProfile.id,
            contractor_name: recipient.vendorName,
            quote_request_id: requestId,
            sent_by_user_id: req.user.id,
            sent_by_name: req.user.name,
          },
        });

        const messageId = uuidv4();
        const sentAt = ['sent', 'delivered'].includes(textDelivery.status) ? new Date().toISOString() : null;
        db.prepare(`
          INSERT INTO contractor_text_messages (
            id, project_id, contractor_id, contractor_name, contractor_phone,
            sent_by_user_id, sent_by_name, direction, message_body, status, provider,
            provider_message_id, error_message, created_at, sent_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          messageId,
          project.id,
          recipient.contractorProfile.id,
          recipient.vendorName,
          cleanPhone(recipient.vendorPhone),
          req.user.id,
          req.user.name,
          textBody,
          textDelivery.status,
          textDelivery.provider,
          textDelivery.providerMessageId,
          textDelivery.errorMessage,
          now,
          sentAt,
          now
        );
      }

      logActivity({
        userId: req.user.id,
        projectId: project.id,
        action: 'vendor_quote_request_sent',
        entityType: 'vendor_quote_request',
        entityId: requestId,
        details: {
          contractor_profile_id: recipient.contractorProfileId,
          vendor_email: recipient.vendorEmail,
          vendor_phone: recipient.vendorPhone || null,
          scope_count: scopes.length,
          expires_at: expiresAt,
          include_photos: Boolean(includePhotos),
          send_email: sendEmail,
          send_text: sendText,
          email_sent: emailSent,
          text_status: textDelivery?.status || null,
          batch_recipient_count: recipients.length,
        },
      });

      createdRequests.push({
        request: {
          id: requestId,
          vendor_name: recipient.vendorName,
          vendor_email: recipient.vendorEmail,
          vendor_phone: recipient.vendorPhone || null,
          status: 'sent',
          expires_at: expiresAt,
          scope_count: scopes.length,
        },
        link: requestUrl,
        delivery: {
          email_sent: emailSent,
          text_status: textDelivery?.status || null,
          text_provider: textDelivery?.provider || null,
          text_error: textDelivery?.errorMessage || null,
        },
      });
    }

    res.status(201).json({
      request: createdRequests[0]?.request || null,
      requests: createdRequests.map(item => item.request),
      link: createdRequests[0]?.link || null,
      delivery: {
        email_sent: createdRequests.some(item => item.delivery.email_sent),
        email_count: createdRequests.filter(item => item.delivery.email_sent).length,
        text_status: createdRequests.find(item => item.delivery.text_status)?.delivery.text_status || null,
        text_count: createdRequests.filter(item => item.delivery.text_status).length,
        text_errors: createdRequests.map(item => item.delivery.text_error).filter(Boolean),
      },
    });
  } catch (err) {
    console.error('[VENDOR_QUOTE] request failed:', err);
    res.status(500).json({ error: 'Failed to send vendor quote request' });
  }
});

module.exports = router;
