'use strict';
// Documents & Agreements (Mike, 2026-10-01): one place for every executed contract
// and signed agreement with a vendor or contractor, ordered by date and by the type
// of work (trade). A document cannot be saved without BOTH a vendor and a project.
//
// Private and non-public (Mike, 2026-10-01): the record lives in BuildTrack's own
// database (never exposed to the internet), and every document is ENCRYPTED at
// rest (AES-256-GCM, streaming, key derived from CONTRACTOR_ONBOARDING_ENCRYPTION_KEY
// - the same secret that seals vendor W-9s; rotating it makes these unreadable).
// Files live in uploads/agreements/, which server.js and the uploads gate never
// serve: they are decrypted only by GET /api/agreements/:id/file, which requires a
// management login and audits every read. Management roles may upload and edit;
// only super admins and operations managers may delete. Contractors never see them.
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
const { sniffFileType, typeInfo, sanitizeOriginalName } = require('../utils/vendorSetupFiles');
const { deriveFileKey } = require('../utils/secureFields');

const router = express.Router();

const MANAGEMENT_ROLES = ['super_admin', 'operations_manager', 'project_manager'];
const DELETE_ROLES = ['super_admin', 'operations_manager'];
const STORAGE_DIR = 'agreements';
const MAX_FILE_MB = Math.max(Number.parseInt(process.env.AGREEMENT_MAX_FILE_MB || '50', 10) || 50, 1);
const MAX_CONCURRENT_UPLOADS = 3;
const INLINE_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']);

const DOCUMENT_TYPES = Object.freeze([
  { value: 'contract', label: 'Contract' },
  { value: 'subcontract', label: 'Subcontractor agreement' },
  { value: 'agreement', label: 'Signed agreement' },
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

// ── storage ──────────────────────────────────────────────────────────────────

function uploadsRoot() {
  return path.resolve(process.env.UPLOADS_PATH || './uploads');
}

function storageRoot() {
  return path.join(uploadsRoot(), STORAGE_DIR);
}

function incomingDir() {
  return path.join(storageRoot(), '.incoming');
}

function absolutePathFor(relPath) {
  const root = storageRoot();
  const absolute = path.resolve(uploadsRoot(), String(relPath || ''));
  if (!absolute.startsWith(root + path.sep)) throw new Error('Refusing a path outside agreements storage');
  return absolute;
}

function unlinkQuietly(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error('[agreements] could not remove file:', err?.message || err);
  }
}

function removeStoredFile(relPath) {
  try {
    unlinkQuietly(absolutePathFor(relPath));
  } catch (err) {
    console.error('[agreements] could not remove stored file:', err?.message || err);
  }
}

// The file type is decided by CONTENT (vendorSetupFiles.sniffFileType), never by
// its name. The sniffer needs the head (magic bytes, zip local headers) and the
// tail (zip central directory) of the file, not all of it.
function sniffStoredUpload(filePath, originalName) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const headLength = Math.min(size, 256 * 1024);
    const head = Buffer.alloc(headLength);
    fs.readSync(fd, head, 0, headLength, 0);
    let sample = head;
    if (size > headLength) {
      const tailLength = Math.min(size - headLength, 64 * 1024);
      const tail = Buffer.alloc(tailLength);
      fs.readSync(fd, tail, 0, tailLength, size - tailLength);
      sample = Buffer.concat([head, tail]);
    }
    const detected = sniffFileType(sample, originalName);
    return detected ? typeInfo(detected) : null;
  } finally {
    fs.closeSync(fd);
  }
}

// ── encryption at rest ───────────────────────────────────────────────────────
// Layout: 'BTA1' | 12-byte IV | ciphertext | 16-byte GCM tag. Streaming both ways,
// so a 50 MB scan never sits whole in memory. The plaintext upload is deleted as
// soon as it is sealed; the stored name carries no extension.
const SEALED_MAGIC = Buffer.from('BTA1', 'ascii');

function agreementFileKey() {
  return deriveFileKey('buildtrack:agreement-files:v1');
}

function sealFile(sourcePath, destPath) {
  return new Promise((resolve, reject) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', agreementFileKey(), iv);
    const input = fs.createReadStream(sourcePath);
    const output = fs.createWriteStream(destPath, { flags: 'wx', mode: 0o600 });
    let failed = false;
    const fail = err => {
      if (failed) return;
      failed = true;
      input.destroy();
      cipher.destroy();
      output.destroy();
      reject(err);
    };
    input.on('error', fail);
    cipher.on('error', fail);
    output.on('error', fail);
    output.on('finish', () => { if (!failed) resolve(); });
    output.write(Buffer.concat([SEALED_MAGIC, iv]));
    cipher.on('end', () => output.end(cipher.getAuthTag()));
    input.pipe(cipher).pipe(output, { end: false });
  });
}

// Returns the decrypting stream for a sealed file and the plaintext length. GCM
// verifies the tag at the end; a tampered file errors the stream (the response is
// then cut off, never completed).
function openSealedFile(absolute) {
  const fd = fs.openSync(absolute, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    if (size <= 32) throw new Error('Invalid encrypted file');
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    if (!head.subarray(0, 4).equals(SEALED_MAGIC)) throw new Error('Invalid encrypted file');
    const tag = Buffer.alloc(16);
    fs.readSync(fd, tag, 0, 16, size - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', agreementFileKey(), head.subarray(4, 16));
    decipher.setAuthTag(tag);
    const source = fs.createReadStream(absolute, { start: 16, end: size - 17 });
    return { source, decipher, length: size - 32 };
  } finally {
    fs.closeSync(fd);
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// An upload interrupted by a restart leaves its .part behind; sweep the day-old ones.
function sweepIncoming() {
  try {
    const dir = incomingDir();
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name.endsWith('.part') && fs.statSync(full).mtimeMs < cutoff) unlinkQuietly(full);
    }
  } catch (err) {
    console.error('[agreements] incoming sweep failed:', err?.message || err);
  }
}
const incomingSweep = setInterval(sweepIncoming, 6 * 60 * 60 * 1000);
if (incomingSweep.unref) incomingSweep.unref();
setTimeout(sweepIncoming, 30 * 1000).unref?.();

let uploadsInFlight = 0;
const diskUpload = multer({
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
  limits: { files: 1, fileSize: MAX_FILE_MB * 1024 * 1024, fields: 20, fieldSize: 64 * 1024 },
}).single('file');

function acceptOneUpload(req, res, next) {
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
  diskUpload(req, res, err => {
    if (!err) return next();
    release();
    unlinkQuietly(req.file?.path);
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({
      error: tooBig ? `The document must be ${MAX_FILE_MB} MB or smaller` : 'That upload could not be read. Please try again.',
    });
  });
}

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

// Vendor AND project are required on every save - Mike's rule for this page.
function parseAgreementFields(db, body, { defaultTitle = '' } = {}) {
  const contractorId = cleanText(body.contractor_profile_id, 64);
  if (!contractorId) throw httpError(400, 'Choose the vendor this agreement is with');
  const vendor = db.prepare('SELECT id, vendor_name FROM contractor_profiles WHERE id = ?').get(contractorId);
  if (!vendor) throw httpError(400, 'That vendor is no longer in the system. Choose another vendor.');

  const projectId = cleanText(body.project_id, 64);
  if (!projectId) throw httpError(400, 'Choose the project this agreement is for');
  const project = db.prepare('SELECT id, address, job_name FROM projects WHERE id = ?').get(projectId);
  if (!project) throw httpError(400, 'That project could not be found. Choose another project.');

  const trade = cleanText(body.trade, 80);
  if (!trade) throw httpError(400, 'Enter the type of work (for example Roofing)');

  const documentType = cleanText(body.document_type, 40);
  if (!DOCUMENT_TYPE_LABELS[documentType]) throw httpError(400, 'Choose the document type');

  const executedDate = cleanText(body.executed_date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(executedDate) || Number.isNaN(new Date(`${executedDate}T12:00:00Z`).getTime())) {
    throw httpError(400, 'Enter the date the agreement was executed');
  }
  if (executedDate < '1990-01-01') throw httpError(400, 'Check the executed date');
  if (executedDate > easternToday()) throw httpError(400, 'The executed date cannot be in the future');

  const title = cleanText(body.title, 200) || cleanText(defaultTitle, 200);
  if (!title) throw httpError(400, 'Enter a title for the document');

  return {
    vendor,
    project,
    contractor_profile_id: vendor.id,
    project_id: project.id,
    trade,
    document_type: documentType,
    executed_date: executedDate,
    title,
    contract_amount: parseAmount(body.contract_amount),
    notes: cleanText(body.notes, 2000) || null,
  };
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
    ud.name AS updated_by_name
  FROM vendor_agreements va
  LEFT JOIN contractor_profiles cp ON cp.id = va.contractor_profile_id
  LEFT JOIN projects p ON p.id = va.project_id
  LEFT JOIN users ub ON ub.id = va.uploaded_by
  LEFT JOIN users ud ON ud.id = va.updated_by
`;

function agreementShape(row) {
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
    uploaded_by_name: row.uploaded_by_name || null,
    updated_by_name: row.updated_by_name || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function selectAgreement(db, id) {
  const row = db.prepare(`${AGREEMENT_SELECT} WHERE va.id = ?`).get(id);
  return row ? agreementShape(row) : null;
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
    res.json({ vendors, projects, trades, document_types: DOCUMENT_TYPES, max_file_mb: MAX_FILE_MB });
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
    res.json({ agreements: rows.map(agreementShape) });
  } catch (err) {
    sendError(res, err, 'Unable to load agreements');
  }
});

// POST /api/agreements - multipart: file + fields
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
    const fields = parseAgreementFields(db, req.body || {}, { defaultTitle: path.parse(originalName).name });
    const sha256 = await sha256File(upload.path);

    const duplicate = db.prepare(`
      SELECT va.id, va.title, va.executed_date FROM vendor_agreements va
      WHERE va.sha256 = ? AND va.project_id = ?
      LIMIT 1
    `).get(sha256, fields.project_id);
    if (duplicate) {
      throw httpError(409, `This document is already filed for this project as "${duplicate.title}"`, {
        duplicate: { id: duplicate.id, title: duplicate.title },
      });
    }

    const id = uuidv4();
    const year = fields.executed_date.slice(0, 4);
    const relPath = path.posix.join(STORAGE_DIR, year, `${id}.bta`);
    storedAbsolute = absolutePathFor(relPath);
    fs.mkdirSync(path.dirname(storedAbsolute), { recursive: true, mode: 0o700 });
    await sealFile(upload.path, storedAbsolute);
    unlinkQuietly(upload.path);

    db.prepare(`
      INSERT INTO vendor_agreements (
        id, title, document_type, trade, executed_date, contract_amount, notes,
        contractor_profile_id, project_id, original_name, mime_type, size_bytes, sha256, storage_path,
        uploaded_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      id, fields.title, fields.document_type, fields.trade, fields.executed_date, fields.contract_amount, fields.notes,
      fields.contractor_profile_id, fields.project_id, originalName, info.mime, upload.size, sha256, relPath,
      req.user.id, req.user.id
    );
    storedAbsolute = null;

    // Deliberately no projectId: project activity is readable by contractors on the
    // project, and an agreement with one vendor is nobody else's business.
    logActivity({
      userId: req.user.id,
      action: 'agreement_uploaded',
      entityType: 'vendor_agreement',
      entityId: id,
      details: {
        title: fields.title,
        name: fields.vendor.vendor_name,
        trade: fields.trade,
        project: fields.project.address || fields.project.job_name,
        project_id: fields.project_id,
        document_type: fields.document_type,
      },
    });
    res.status(201).json({ agreement: selectAgreement(db, id) });
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
    db.prepare(`
      UPDATE vendor_agreements SET
        title = ?, document_type = ?, trade = ?, executed_date = ?, contract_amount = ?, notes = ?,
        contractor_profile_id = ?, project_id = ?, updated_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      fields.title, fields.document_type, fields.trade, fields.executed_date, fields.contract_amount, fields.notes,
      fields.contractor_profile_id, fields.project_id, req.user.id, existing.id
    );
    const changed = ['title', 'document_type', 'trade', 'executed_date', 'contract_amount', 'notes', 'contractor_profile_id', 'project_id']
      .filter(key => String(existing[key] ?? '') !== String(fields[key] ?? ''));
    if (changed.length) {
      logActivity({
        userId: req.user.id,
        action: 'agreement_updated',
        entityType: 'vendor_agreement',
        entityId: existing.id,
        details: { title: fields.title, name: fields.vendor.vendor_name, project: fields.project.address || fields.project.job_name, project_id: fields.project_id, changed },
      });
    }
    res.json({ agreement: selectAgreement(db, existing.id) });
  } catch (err) {
    sendError(res, err, 'Unable to update the agreement');
  }
});

// DELETE /api/agreements/:id - super admin / operations manager only
router.delete('/:id', authorize(...DELETE_ROLES), (req, res) => {
  try {
    const db = getDb();
    const existing = db.prepare(`${AGREEMENT_SELECT} WHERE va.id = ?`).get(req.params.id);
    if (!existing) throw httpError(404, 'Agreement not found');
    db.prepare('DELETE FROM vendor_agreements WHERE id = ?').run(existing.id);
    removeStoredFile(existing.storage_path);
    logActivity({
      userId: req.user.id,
      action: 'agreement_deleted',
      entityType: 'vendor_agreement',
      entityId: existing.id,
      details: { title: existing.title, name: existing.vendor_name, file_name: existing.original_name, project: existing.project_address || existing.project_job_name, project_id: existing.project_id },
    });
    res.json({ message: 'Agreement deleted' });
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
