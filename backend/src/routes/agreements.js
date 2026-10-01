'use strict';
// Documents & Agreements (Mike, 2026-10-01): one place for every executed contract
// and signed agreement with a vendor or contractor, ordered by date and by the type
// of work (trade). A document cannot be saved without BOTH a vendor and a project.
//
// Private and non-public (Mike, 2026-10-01): the record lives in BuildTrack's own
// database (never exposed to the internet), and every document is ENCRYPTED at
// rest (utils/agreementFiles.js). Files are decrypted only by
// GET /api/agreements/:id/file, which requires a management login and audits every
// read. Management roles may upload and edit; only super admins and operations
// managers may delete. Contractors never see them.
//
// The AI reads every document (services/documentReview.js): on upload the form asks
// POST /read for the AI's reading (vendor, project, type of work, executed date,
// amount - one entry per separate document in the file) and pre-fills itself; after
// saving, every record is checked against what the document says.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const { getDb, QUOTE_CATEGORY_DEFINITIONS } = require('../db/schema');
const { authenticate, authorize } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { logDataAccess } = require('../utils/dataAccessAudit');
const { sniffFileType, sanitizeOriginalName } = require('../utils/vendorSetupFiles');
const {
  STORAGE_DIR, incomingDir, absolutePathFor, unlinkQuietly, removeStoredFile,
  sniffStoredUpload, sealFile, openSealedFile, sha256File, sweepIncoming,
} = require('../utils/agreementFiles');
const { findVendorByName, findVendorByEmail, assessVendorName, insertVendorProfile, staffNameKeys } = require('../utils/vendorDirectory');
const documentReview = require('../services/documentReview');

const router = express.Router();

const MANAGEMENT_ROLES = ['super_admin', 'operations_manager', 'project_manager'];
const DELETE_ROLES = ['super_admin', 'operations_manager'];
const MAX_FILE_MB = Math.max(Number.parseInt(process.env.AGREEMENT_MAX_FILE_MB || '50', 10) || 50, 1);
const MAX_READ_MB = 32;
const MAX_CONCURRENT_UPLOADS = 3;
const MAX_ENTRIES = 25;
const INLINE_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']);
const AI_READABLE_TYPES = new Set(['pdf', 'jpeg', 'png', 'webp']);

const DOCUMENT_TYPES = Object.freeze([
  { value: 'contract', label: 'Contract' },
  { value: 'subcontract', label: 'Subcontractor agreement' },
  { value: 'agreement', label: 'Signed agreement' },
  { value: 'executed_quote', label: 'Executed quote' },
  { value: 'change_order', label: 'Change order' },
  { value: 'amendment', label: 'Amendment / addendum' },
  { value: 'lien_waiver', label: 'Lien waiver' },
  { value: 'other', label: 'Other executed document' },
]);
const DOCUMENT_TYPE_LABELS = Object.fromEntries(DOCUMENT_TYPES.map(type => [type.value, type.label]));

function httpError(statusCode, message, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function sendError(res, err, fallback) {
  if (!err.statusCode || err.statusCode >= 500) console.error(`[agreements] ${fallback}:`, err);
  const body = { error: err.statusCode ? err.message : fallback };
  if (err.duplicate) body.duplicate = err.duplicate;
  res.status(err.statusCode || 500).json(body);
}

const incomingSweep = setInterval(sweepIncoming, 6 * 60 * 60 * 1000);
if (incomingSweep.unref) incomingSweep.unref();
setTimeout(sweepIncoming, 30 * 1000).unref?.();

// ── uploads ──────────────────────────────────────────────────────────────────

let uploadsInFlight = 0;
function limitConcurrency(middleware, tooBigMessage) {
  return (req, res, next) => {
    if (uploadsInFlight >= MAX_CONCURRENT_UPLOADS) {
      return res.status(429).json({ error: 'Another upload is finishing. Please try again in a moment.', retry_after_seconds: 2 });
    }
    uploadsInFlight += 1;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        uploadsInFlight -= 1;
      }
    };
    res.on('finish', release);
    res.on('close', release);
    middleware(req, res, err => {
      if (!err) return next();
      release();
      unlinkQuietly(req.file?.path);
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({ error: tooBig ? tooBigMessage : 'That upload could not be read. Please try again.' });
    });
  };
}

const acceptOneUpload = limitConcurrency(multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        fs.mkdirSync(incomingDir(), { recursive: true, mode: 0o700 });
        cb(null, incomingDir());
      } catch (err) {
        cb(err);
      }
    },
    filename: (_req, _file, cb) => cb(null, `${uuidv4()}.part`),
  }),
  limits: { files: 1, fileSize: MAX_FILE_MB * 1024 * 1024, fields: 30, fieldSize: 256 * 1024 },
}).single('file'), `The document must be ${MAX_FILE_MB} MB or smaller`);

// The AI reads from memory; nothing is written to disk for a read.
const acceptReadUpload = limitConcurrency(multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: MAX_READ_MB * 1024 * 1024, fields: 5 },
}).single('file'), `The AI can read documents up to ${MAX_READ_MB} MB - fill in the details by hand for larger files`);

// ── validation ───────────────────────────────────────────────────────────────

function easternToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

function cleanText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function parseAmount(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1e9) throw httpError(400, 'Enter the contract amount as a dollar figure, or leave it blank');
  return Math.round(parsed * 100) / 100;
}

function parseJsonField(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch (_) {
    throw httpError(400, 'The form sent data that could not be read. Refresh and try again.');
  }
}

// Vendor AND project are required on every save - Mike's rule for this page. The
// vendor is either one already in the directory or a new one the AI read from the
// document (added to Contractors / Suppliers when the agreement is saved).
function parseAgreementFields(db, body, { defaultTitle = '', label = '' } = {}) {
  const prefix = label ? `${label}: ` : '';
  const contractorId = cleanText(body.contractor_profile_id, 64);
  const newVendorRaw = parseJsonField(body.new_vendor);
  let vendor = null;
  let newVendor = null;
  if (contractorId) {
    vendor = db.prepare('SELECT id, vendor_name FROM contractor_profiles WHERE id = ?').get(contractorId);
    if (!vendor) throw httpError(400, `${prefix}That vendor is no longer in the system. Choose another vendor.`);
  } else if (newVendorRaw && cleanText(newVendorRaw.name, 150)) {
    const assessed = assessVendorName(newVendorRaw.name, { staffKeys: staffNameKeys(db) });
    if (!assessed.readable) throw httpError(400, `${prefix}${assessed.reason} Choose the vendor.`);
    newVendor = {
      name: assessed.name,
      contact: cleanText(newVendorRaw.contact, 150),
      email: cleanText(newVendorRaw.email, 150),
      phone: cleanText(newVendorRaw.phone, 40),
      address: cleanText(newVendorRaw.address, 300),
    };
  } else {
    throw httpError(400, `${prefix}Choose the vendor this agreement is with`);
  }

  const projectId = cleanText(body.project_id, 64);
  if (!projectId) throw httpError(400, `${prefix}Choose the project this agreement is for`);
  const project = db.prepare('SELECT id, address, job_name FROM projects WHERE id = ?').get(projectId);
  if (!project) throw httpError(400, `${prefix}That project could not be found. Choose another project.`);

  const trade = cleanText(body.trade, 80);
  if (!trade) throw httpError(400, `${prefix}Enter the type of work (for example Roofing)`);

  const documentType = cleanText(body.document_type, 40);
  if (!DOCUMENT_TYPE_LABELS[documentType]) throw httpError(400, `${prefix}Choose the document type`);

  const executedDate = cleanText(body.executed_date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(executedDate) || Number.isNaN(new Date(`${executedDate}T12:00:00Z`).getTime())) {
    throw httpError(400, `${prefix}Enter the date the agreement was executed`);
  }
  if (executedDate < '1990-01-01') throw httpError(400, `${prefix}Check the executed date`);
  if (executedDate > easternToday()) throw httpError(400, `${prefix}The executed date cannot be in the future`);

  const title = cleanText(body.title, 200) || cleanText(defaultTitle, 200);
  if (!title) throw httpError(400, `${prefix}Enter a title for the document`);

  const entryIndex = Number.parseInt(String(body.entry_index ?? ''), 10);
  return {
    vendor,
    newVendor,
    project,
    contractor_profile_id: vendor ? vendor.id : null,
    project_id: project.id,
    trade,
    document_type: documentType,
    executed_date: executedDate,
    title,
    contract_amount: parseAmount(body.contract_amount),
    notes: cleanText(body.notes, 2000) || null,
    entry_index: Number.isInteger(entryIndex) && entryIndex >= 0 ? entryIndex : null,
  };
}

// A new vendor from the document, unless it was added meanwhile (or is a twin).
function vendorForNew(db, newVendor) {
  const existing = findVendorByName(db, newVendor.name) || (newVendor.email ? findVendorByEmail(db, newVendor.email) : null);
  if (existing) return { id: existing.id, vendor_name: existing.vendor_name, created: false };
  const id = insertVendorProfile(db, { ...newVendor, source: 'agreement' });
  return { id, vendor_name: newVendor.name, created: true };
}

// ── shapes ───────────────────────────────────────────────────────────────────

const AGREEMENT_SELECT = `
  SELECT
    va.*,
    cp.vendor_name,
    cp.is_supplier AS vendor_is_supplier,
    p.address AS project_address,
    p.job_name AS project_job_name,
    p.status AS project_status,
    ub.name AS uploaded_by_name,
    ud.name AS updated_by_name,
    r.status AS ai_status,
    r.findings_json AS ai_findings_json,
    r.corrections_json AS ai_corrections_json,
    r.summary AS ai_summary,
    r.error AS ai_error,
    r.document_count AS ai_document_count,
    r.entry_index AS ai_entry_index,
    r.reviewed_at AS ai_reviewed_at,
    r.file_sha256 AS ai_sha
  FROM vendor_agreements va
  LEFT JOIN contractor_profiles cp ON cp.id = va.contractor_profile_id
  LEFT JOIN projects p ON p.id = va.project_id
  LEFT JOIN users ub ON ub.id = va.uploaded_by
  LEFT JOIN users ud ON ud.id = va.updated_by
  LEFT JOIN document_ai_reviews r ON r.entity_type = 'agreement' AND r.entity_id = va.id
`;

function parseList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

// The page a split document starts on, from the AI read (for opening the viewer there).
function pageStartFor(db, row, cache) {
  if (!row.ai_sha || !Number.isInteger(row.ai_entry_index)) return null;
  if (!cache.has(row.ai_sha)) {
    const hit = db.prepare('SELECT read_json FROM document_ai_reads WHERE sha256 = ? AND read_version = ?').get(row.ai_sha, documentReview.READ_VERSION);
    let read = null;
    try { read = hit ? JSON.parse(hit.read_json) : null; } catch (_) { read = null; }
    cache.set(row.ai_sha, read);
  }
  const read = cache.get(row.ai_sha);
  const page = read?.documents?.[row.ai_entry_index]?.page_start;
  return read && read.documents.length > 1 && Number.isInteger(page) ? page : null;
}

function agreementShape(row, db = null, cache = new Map()) {
  return {
    id: row.id,
    title: row.title,
    document_type: row.document_type,
    document_type_label: DOCUMENT_TYPE_LABELS[row.document_type] || 'Document',
    trade: row.trade,
    executed_date: row.executed_date,
    contract_amount: row.contract_amount === null || row.contract_amount === undefined ? null : Number(row.contract_amount),
    notes: row.notes || null,
    contractor_profile_id: row.contractor_profile_id,
    vendor_name: row.vendor_name || 'Vendor removed',
    vendor_is_supplier: Boolean(Number(row.vendor_is_supplier || 0)),
    project_id: row.project_id,
    project_address: row.project_address || null,
    project_job_name: row.project_job_name || null,
    project_status: row.project_status || null,
    original_name: row.original_name,
    mime_type: row.mime_type,
    size_bytes: Number(row.size_bytes || 0),
    inline: INLINE_MIME_TYPES.has(row.mime_type),
    file_url: `/api/agreements/${row.id}/file`,
    page_start: db ? pageStartFor(db, row, cache) : null,
    uploaded_by_name: row.uploaded_by_name || null,
    updated_by_name: row.updated_by_name || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ai: row.ai_status ? {
      status: row.ai_status,
      findings: parseList(row.ai_findings_json),
      corrections: parseList(row.ai_corrections_json).length,
      summary: row.ai_summary || null,
      error: row.ai_error || null,
      document_count: row.ai_document_count,
      reviewed_at: row.ai_reviewed_at || null,
    } : null,
  };
}

function selectAgreement(db, id) {
  const row = db.prepare(`${AGREEMENT_SELECT} WHERE va.id = ?`).get(id);
  return row ? agreementShape(row, db) : null;
}

function uniqueSorted(values) {
  const seen = new Map();
  for (const value of values) {
    const clean = cleanText(value, 80);
    if (clean && !seen.has(clean.toLowerCase())) seen.set(clean.toLowerCase(), clean);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

function parseCategories(row) {
  let stored = [];
  try {
    const parsed = JSON.parse(row.contractor_categories_json || '[]');
    if (Array.isArray(parsed)) stored = parsed;
  } catch (_) {
    stored = [];
  }
  return uniqueSorted([...stored, row.contractor_category, row.contractor_secondary_category]);
}

// ── routes ───────────────────────────────────────────────────────────────────

router.use(authenticate, authorize(...MANAGEMENT_ROLES));

// GET /api/agreements/options - vendors, projects, trade suggestions, document types
router.get('/options', (req, res) => {
  try {
    const db = getDb();
    const vendors = db.prepare(`
      SELECT id, vendor_name, email, is_supplier, contractor_status, contractor_category,
             contractor_secondary_category, contractor_categories_json
      FROM contractor_profiles
      WHERE trim(COALESCE(vendor_name, '')) <> ''
      ORDER BY lower(vendor_name)
    `).all().map(row => ({
      id: row.id,
      name: row.vendor_name,
      email: row.email || null,
      is_supplier: Boolean(Number(row.is_supplier || 0)),
      status: row.contractor_status || 'active',
      categories: parseCategories(row),
    }));
    const projects = db.prepare(`
      SELECT id, address, job_name, status FROM projects
      ORDER BY CASE WHEN status = 'archived' THEN 1 ELSE 0 END, lower(address)
    `).all();
    let contractorCategories = [];
    try {
      contractorCategories = db.prepare('SELECT name FROM contractor_categories').all().map(row => row.name);
    } catch (_) {
      contractorCategories = [];
    }
    const usedTrades = db.prepare('SELECT DISTINCT trade FROM vendor_agreements').all().map(row => row.trade);
    const trades = uniqueSorted([
      ...QUOTE_CATEGORY_DEFINITIONS.map(([, name]) => name),
      ...contractorCategories,
      ...usedTrades,
    ]);
    res.json({
      vendors,
      projects,
      trades,
      document_types: DOCUMENT_TYPES,
      max_file_mb: MAX_FILE_MB,
      max_read_mb: MAX_READ_MB,
      ai_available: documentReview.aiReadsEnabled(),
    });
  } catch (err) {
    sendError(res, err, 'Unable to load agreement options');
  }
});

// GET /api/agreements - newest executed first, then by trade
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const where = [];
    const params = [];
    if (req.query.project_id) {
      where.push('va.project_id = ?');
      params.push(String(req.query.project_id));
    }
    if (req.query.contractor_profile_id) {
      where.push('va.contractor_profile_id = ?');
      params.push(String(req.query.contractor_profile_id));
    }
    const rows = db.prepare(`
      ${AGREEMENT_SELECT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY va.executed_date DESC, lower(va.trade) ASC, datetime(va.created_at) DESC
    `).all(...params);
    const cache = new Map();
    res.json({ agreements: rows.map(row => agreementShape(row, db, cache)) });
  } catch (err) {
    sendError(res, err, 'Unable to load agreements');
  }
});

// POST /api/agreements/read - the AI reads a document BEFORE it is filed, so the
// form can fill itself in. Returns at once; the form polls GET /read/:sha256.
router.post('/read', acceptReadUpload, (req, res) => {
  try {
    const file = req.file;
    if (!file || !file.buffer?.length) throw httpError(400, 'Choose a document to read');
    const detected = sniffFileType(Buffer.concat([file.buffer.subarray(0, 256 * 1024), file.buffer.subarray(Math.max(0, file.buffer.length - 64 * 1024))]), file.originalname);
    const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
    if (!detected || !AI_READABLE_TYPES.has(detected)) {
      return res.json({ sha256, status: 'skipped', error: 'The AI reads PDFs and photos or scans - fill in the details for this file by hand.' });
    }
    const db = getDb();
    if (!documentReview.aiReadsEnabled()) {
      return res.json({ sha256, status: 'skipped', error: 'AI reading is not available right now - fill in the details by hand.' });
    }
    documentReview.startUploadRead(db, { bytes: file.buffer, sha256, fileName: sanitizeOriginalName(file.originalname) });
    res.json({ sha256, ...documentReview.uploadReadStatus(db, sha256, { lockedProjectId: cleanText(req.body?.project_id, 64) || null }) });
  } catch (err) {
    sendError(res, err, 'Unable to read the document');
  }
});

router.get('/read/:sha256', (req, res) => {
  try {
    const sha256 = String(req.params.sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw httpError(400, 'Unknown document');
    const db = getDb();
    res.json({ sha256, ...documentReview.uploadReadStatus(db, sha256, { lockedProjectId: cleanText(req.query.project_id, 64) || null }) });
  } catch (err) {
    sendError(res, err, 'Unable to read the document');
  }
});

// POST /api/agreements - multipart: file + fields, or file + entries (JSON array)
// when one file holds several separate documents (each with its own vendor).
router.post('/', acceptOneUpload, async (req, res) => {
  const upload = req.file;
  let storedAbsolute = null;
  try {
    if (!upload?.path) throw httpError(400, 'Attach the executed document');
    if (!upload.size) throw httpError(400, 'That file is empty');
    const db = getDb();
    const info = sniffStoredUpload(upload.path, upload.originalname);
    if (!info) throw httpError(415, 'Upload a PDF, a photo or scan (JPG, PNG, HEIC, TIFF), or a Word document.');
    const originalName = sanitizeOriginalName(upload.originalname, info.ext);
    const body = req.body || {};
    const rawEntries = parseJsonField(body.entries);
    let entries;
    if (Array.isArray(rawEntries)) {
      if (!rawEntries.length) throw httpError(400, 'Choose at least one document to file');
      if (rawEntries.length > MAX_ENTRIES) throw httpError(400, `File at most ${MAX_ENTRIES} documents at once`);
      entries = rawEntries.map((entry, index) => parseAgreementFields(db, { project_id: body.project_id, ...entry }, {
        defaultTitle: path.parse(originalName).name,
        label: `Document ${index + 1}`,
      }));
    } else {
      entries = [parseAgreementFields(db, body, { defaultTitle: path.parse(originalName).name })];
    }
    const sha256 = await sha256File(upload.path);

    for (const projectId of new Set(entries.map(entry => entry.project_id))) {
      const duplicate = db.prepare(`
        SELECT va.id, va.title FROM vendor_agreements va WHERE va.sha256 = ? AND va.project_id = ? LIMIT 1
      `).get(sha256, projectId);
      if (duplicate) {
        throw httpError(409, `This document is already filed for this project as "${duplicate.title}"`, {
          duplicate: { id: duplicate.id, title: duplicate.title },
        });
      }
    }

    const fileId = uuidv4();
    const year = entries[0].executed_date.slice(0, 4);
    const relPath = path.posix.join(STORAGE_DIR, year, `${fileId}.bta`);
    storedAbsolute = absolutePathFor(relPath);
    fs.mkdirSync(path.dirname(storedAbsolute), { recursive: true, mode: 0o700 });
    await sealFile(upload.path, storedAbsolute);
    unlinkQuietly(upload.path);

    const created = [];
    db.transaction(() => {
      for (const entry of entries) {
        let vendor = entry.vendor;
        let vendorCreated = false;
        if (!vendor) {
          const made = vendorForNew(db, entry.newVendor);
          vendor = { id: made.id, vendor_name: made.vendor_name };
          vendorCreated = made.created;
        }
        const id = uuidv4();
        db.prepare(`
          INSERT INTO vendor_agreements (
            id, title, document_type, trade, executed_date, contract_amount, notes,
            contractor_profile_id, project_id, original_name, mime_type, size_bytes, sha256, storage_path,
            uploaded_by, updated_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(
          id, entry.title, entry.document_type, entry.trade, entry.executed_date, entry.contract_amount, entry.notes,
          vendor.id, entry.project_id, originalName, info.mime, upload.size, sha256, relPath,
          req.user.id, req.user.id
        );
        created.push({ id, entry, vendor, vendorCreated });
      }
    })();
    storedAbsolute = null;

    for (const { id, entry, vendor, vendorCreated } of created) {
      if (vendorCreated) {
        logActivity({
          userId: req.user.id,
          action: 'agreement_vendor_created',
          entityType: 'contractor_profile',
          entityId: vendor.id,
          details: { name: vendor.vendor_name, title: entry.title },
        });
      }
      // Deliberately no projectId: project activity is readable by contractors on the
      // project, and an agreement with one vendor is nobody else's business.
      logActivity({
        userId: req.user.id,
        action: 'agreement_uploaded',
        entityType: 'vendor_agreement',
        entityId: id,
        details: {
          title: entry.title,
          name: vendor.vendor_name,
          trade: entry.trade,
          project: entry.project.address || entry.project.job_name,
          project_id: entry.project_id,
          document_type: entry.document_type,
        },
      });
      documentReview.enqueueReview('agreement', id, { mode: 'upload', entryIndex: entry.entry_index, userId: req.user.id });
    }
    const agreements = created.map(({ id }) => selectAgreement(db, id));
    res.status(201).json({ agreement: agreements[0], agreements });
  } catch (err) {
    unlinkQuietly(upload?.path);
    unlinkQuietly(storedAbsolute);
    sendError(res, err, 'Unable to save the agreement');
  }
});

// PUT /api/agreements/:id - edit the filing details (the document itself stays)
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM vendor_agreements WHERE id = ?').get(req.params.id);
    if (!existing) throw httpError(404, 'Agreement not found');
    const fields = parseAgreementFields(db, req.body || {}, { defaultTitle: existing.title });
    let vendor = fields.vendor;
    db.transaction(() => {
      if (!vendor) {
        const made = vendorForNew(db, fields.newVendor);
        vendor = { id: made.id, vendor_name: made.vendor_name };
      }
      db.prepare(`
        UPDATE vendor_agreements SET
          title = ?, document_type = ?, trade = ?, executed_date = ?, contract_amount = ?, notes = ?,
          contractor_profile_id = ?, project_id = ?, updated_by = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        fields.title, fields.document_type, fields.trade, fields.executed_date, fields.contract_amount, fields.notes,
        vendor.id, fields.project_id, req.user.id, existing.id
      );
    })();
    const after = { ...fields, contractor_profile_id: vendor.id };
    const changed = ['title', 'document_type', 'trade', 'executed_date', 'contract_amount', 'notes', 'contractor_profile_id', 'project_id']
      .filter(key => String(existing[key] ?? '') !== String(after[key] ?? ''));
    if (changed.length) {
      logActivity({
        userId: req.user.id,
        action: 'agreement_updated',
        entityType: 'vendor_agreement',
        entityId: existing.id,
        details: { title: fields.title, name: vendor.vendor_name, project: fields.project.address || fields.project.job_name, project_id: fields.project_id, changed },
      });
      // Re-check against the (cached) AI reading; a person's edit is never overridden.
      documentReview.enqueueReview('agreement', existing.id, { mode: 'upload', userId: req.user.id });
    }
    res.json({ agreement: selectAgreement(db, existing.id) });
  } catch (err) {
    sendError(res, err, 'Unable to update the agreement');
  }
});

// DELETE /api/agreements/:id - super admin / operations manager only. A file shared
// by several filings (one PDF holding several vendors' documents) is removed with
// the last of them.
router.delete('/:id', authorize(...DELETE_ROLES), (req, res) => {
  try {
    const db = getDb();
    const existing = db.prepare(`${AGREEMENT_SELECT} WHERE va.id = ?`).get(req.params.id);
    if (!existing) throw httpError(404, 'Agreement not found');
    let othersUseFile = 0;
    db.transaction(() => {
      db.prepare('DELETE FROM vendor_agreements WHERE id = ?').run(existing.id);
      db.prepare("DELETE FROM document_ai_reviews WHERE entity_type = 'agreement' AND entity_id = ?").run(existing.id);
      othersUseFile = db.prepare('SELECT COUNT(*) AS n FROM vendor_agreements WHERE storage_path = ?').get(existing.storage_path).n;
    })();
    if (!othersUseFile) removeStoredFile(existing.storage_path);
    logActivity({
      userId: req.user.id,
      action: 'agreement_deleted',
      entityType: 'vendor_agreement',
      entityId: existing.id,
      details: { title: existing.title, name: existing.vendor_name, file_name: existing.original_name, project: existing.project_address || existing.project_job_name, project_id: existing.project_id },
    });
    res.json({ message: 'Agreement deleted', file_kept_for_other_filings: othersUseFile });
  } catch (err) {
    sendError(res, err, 'Unable to delete the agreement');
  }
});

// GET /api/agreements/:id/file - the document itself (fetched as a blob by the page)
router.get('/:id/file', (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare(`${AGREEMENT_SELECT} WHERE va.id = ?`).get(req.params.id);
    if (!row) throw httpError(404, 'Agreement not found');
    let sealed;
    try {
      sealed = openSealedFile(absolutePathFor(row.storage_path));
    } catch (openErr) {
      console.error('[agreements] could not open document', row.id, openErr?.message || openErr);
      throw httpError(410, 'This document is no longer available');
    }
    logDataAccess(req, {
      action: 'vendor_agreement_viewed',
      accessType: req.query.download === '1' ? 'download' : 'view',
      entityType: 'vendor_agreement',
      entityId: row.id,
      projectId: row.project_id,
      riskLevel: 'high',
      details: { title: row.title, vendor_name: row.vendor_name, file_name: row.original_name },
    });
    const inline = req.query.download !== '1' && INLINE_MIME_TYPES.has(row.mime_type);
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', sealed.length);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.original_name)}`);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; sandbox");
    const abort = streamErr => {
      console.error('[agreements] document stream failed:', row.id, streamErr?.message || streamErr);
      sealed.source.destroy();
      res.destroy(streamErr);
    };
    sealed.source.on('error', abort);
    sealed.decipher.on('error', abort);
    sealed.source.pipe(sealed.decipher).pipe(res);
  } catch (err) {
    sendError(res, err, 'Unable to open the document');
  }
});

module.exports = router;
