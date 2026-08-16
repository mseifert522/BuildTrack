const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { getDb } = require('../db/schema');
const { authenticate, authorize, UPPER_MANAGEMENT_ROLES } = require('../middleware/auth');
const {
  anthropicStatus,
  clearManagedAnthropicKey,
  queueResumeBatch,
  retryResumeBatch,
  saveAnthropicKey,
} = require('../services/hrResumeIntake');
const { logActivity } = require('../utils/audit');
const { logDataAccess } = require('../utils/dataAccessAudit');

const router = express.Router();
const HR_ROLES = ['super_admin', 'operations_manager', 'project_manager'];
const CANDIDATE_STATUSES = new Set(['new', 'contacted', 'screening', 'interview', 'offer', 'hired', 'not_selected', 'on_hold']);
const CONTACT_TYPES = new Set(['call', 'email', 'voicemail', 'text', 'interview', 'note']);
const EMPLOYMENT_STATUSES = new Set(['active', 'leave', 'terminated']);
const EMPLOYMENT_TYPES = new Set(['full_time', 'part_time', 'seasonal', 'temporary', 'contractor']);
const CLASSIFICATIONS = new Set(['non_exempt', 'exempt', 'independent_contractor']);
const PAY_TYPES = new Set(['hourly', 'salary']);
const PAY_FREQUENCIES = new Set(['weekly', 'biweekly', 'semimonthly', 'monthly']);
const LEAVE_TYPES = new Set(['pto', 'sick', 'vacation', 'fmla', 'unpaid', 'bereavement', 'other']);
const LEAVE_STATUSES = new Set(['requested', 'approved', 'denied', 'cancelled']);
const BENEFIT_TYPES = new Set(['health', 'dental', 'vision', 'life', 'disability', 'retirement', 'other']);
const BENEFIT_STATUSES = new Set(['offered', 'waived', 'enrolled', 'ended']);
const COMPLIANCE_STATUSES = new Set(['pending', 'complete', 'not_applicable']);
const ALLOWED_FILE_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.png', '.jpg', '.jpeg']);
const MAX_RESUME_BATCH_FILES = 20;

router.use(authenticate, authorize(...HR_ROLES));

function text(value, maxLength = 500) {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function requiredText(value, field, maxLength = 500) {
  const normalized = text(value, maxLength);
  if (!normalized) {
    const error = new Error(`${field} is required`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function choice(value, allowed, fallback, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return fallback;
  if (!allowed.has(normalized)) {
    const error = new Error(`Invalid ${field}`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function dateValue(value, field) {
  const normalized = text(value, 10);
  if (!normalized) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || Number.isNaN(Date.parse(`${normalized}T00:00:00Z`))) {
    const error = new Error(`Invalid ${field}`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function dateTimeValue(value, field) {
  const normalized = text(value, 40);
  if (!normalized) return null;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`Invalid ${field}`);
    error.statusCode = 400;
    throw error;
  }
  return parsed.toISOString();
}

function numberValue(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = 0 } = {}) {
  if (value === '' || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    const error = new Error(`Invalid ${field}`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function integerValue(value, field, options = {}) {
  return Math.round(numberValue(value, field, options));
}

function getRecord(table, id, label) {
  const row = getDb().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) {
    const error = new Error(`${label} not found`);
    error.statusCode = 404;
    throw error;
  }
  return row;
}

function updateRecord(table, id, body, fieldWriters, label) {
  const updates = [];
  const params = [];
  for (const [field, writer] of Object.entries(fieldWriters)) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    updates.push(`${field} = ?`);
    params.push(writer(body[field]));
  }
  if (!updates.length) return getRecord(table, id, label);
  updates.push("updated_at = datetime('now')");
  const result = getDb().prepare(`UPDATE ${table} SET ${updates.join(', ')} WHERE id = ?`).run(...params, id);
  if (!result.changes) {
    const error = new Error(`${label} not found`);
    error.statusCode = 404;
    throw error;
  }
  return getRecord(table, id, label);
}

function auditMutation(req, action, entityType, entityId, details = null) {
  logActivity({
    userId: req.user.id,
    action,
    entityType,
    entityId,
    details,
  });
  logDataAccess(req, {
    action,
    accessType: 'modify',
    entityType,
    entityId,
    riskLevel: 'high',
    details,
  });
}

function addDays(date, days) {
  if (!date) return null;
  const result = new Date(`${date}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

function addBusinessDays(date, days) {
  if (!date) return null;
  const result = new Date(`${date}T12:00:00Z`);
  let remaining = days;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    const weekday = result.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return result.toISOString().slice(0, 10);
}

function seedComplianceTasks(db, employeeId, hireDate, actorId) {
  const tasks = [
    ['work_authorization', 'Complete Form I-9 verification', addBusinessDays(hireDate, 3)],
    ['payroll', 'Complete federal and Michigan withholding setup', hireDate],
    ['new_hire_reporting', 'Submit Michigan new-hire report', addDays(hireDate, 20)],
    ['policy', 'Provide Michigan earned sick time notice', hireDate],
    ['payroll', 'Complete payroll and direct-deposit setup', hireDate],
    ['policy', 'Obtain employee handbook acknowledgment', addDays(hireDate, 7)],
    ['safety', 'Complete safety and injury-reporting orientation', hireDate],
    ['benefits', 'Record benefits offer, enrollment, or waiver', addDays(hireDate, 30)],
  ];
  const insert = db.prepare(`
    INSERT INTO hr_compliance_tasks (
      id, employee_id, category, task_name, due_date, status, created_by
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `);
  for (const [category, taskName, dueDate] of tasks) {
    insert.run(uuidv4(), employeeId, category, taskName, dueDate, actorId);
  }
}

function currentWeekRange() {
  const today = new Date();
  const day = today.getUTCDay();
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - ((day + 6) % 7));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return [monday.toISOString().slice(0, 10), sunday.toISOString().slice(0, 10)];
}

function privateStorageRoot() {
  const dbPath = process.env.DB_PATH || './data/buildtrack.db';
  const root = path.resolve(process.env.HR_PRIVATE_STORAGE_PATH || path.join(path.dirname(dbPath), 'hr-private'));
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(root, 0o700); } catch (_) { /* best effort on mounted volumes */ }
  return root;
}

const documentStorage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, privateStorageRoot()),
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, `${uuidv4()}${extension}`);
  },
});

const uploadDocument = multer({
  storage: documentStorage,
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_FILE_EXTENSIONS.has(extension)) {
      const error = new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'resume');
      error.message = 'Only PDF, Word, PNG, and JPEG files are allowed';
      return callback(error);
    }
    return callback(null, true);
  },
});

const uploadResumeBatch = multer({
  storage: documentStorage,
  limits: { fileSize: 10 * 1024 * 1024, files: MAX_RESUME_BATCH_FILES },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (extension !== '.pdf') {
      const error = new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'resumes');
      error.message = 'AI resume intake accepts PDF files only';
      return callback(error);
    }
    return callback(null, true);
  },
});

function removeUploadedFiles(files) {
  for (const file of files || []) {
    if (file?.path && fs.existsSync(file.path)) {
      try { fs.unlinkSync(file.path); } catch (_) { /* best effort cleanup */ }
    }
  }
}

function hasValidFileSignature(filePath, originalName) {
  const extension = path.extname(originalName).toLowerCase();
  const handle = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(12);
  try {
    fs.readSync(handle, buffer, 0, buffer.length, 0);
  } finally {
    fs.closeSync(handle);
  }
  if (extension === '.pdf') return buffer.subarray(0, 5).toString() === '%PDF-';
  if (extension === '.docx') return buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (extension === '.doc') return buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if (extension === '.png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (extension === '.jpg' || extension === '.jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  return false;
}

router.get('/overview', (req, res) => {
  const db = getDb();
  const [weekStart, weekEnd] = currentWeekRange();
  const stats = {
    active_employees: db.prepare("SELECT COUNT(*) AS count FROM hr_employees WHERE employment_status = 'active'").get().count,
    open_candidates: db.prepare("SELECT COUNT(*) AS count FROM hr_candidates WHERE status NOT IN ('hired', 'not_selected')").get().count,
    resumes: db.prepare("SELECT COUNT(*) AS count FROM hr_documents WHERE document_type = 'resume'").get().count,
    pending_compliance: db.prepare("SELECT COUNT(*) AS count FROM hr_compliance_tasks WHERE status = 'pending'").get().count,
    pending_leave: db.prepare("SELECT COUNT(*) AS count FROM hr_leave_requests WHERE status = 'requested'").get().count,
  };
  const hours = db.prepare(`
    SELECT
      COALESCE(SUM(regular_hours), 0) AS regular_hours,
      COALESCE(SUM(overtime_hours), 0) AS overtime_hours,
      COALESCE(SUM(pto_hours), 0) AS pto_hours,
      COALESCE(SUM(sick_hours), 0) AS sick_hours
    FROM hr_time_entries
    WHERE work_date BETWEEN ? AND ?
  `).get(weekStart, weekEnd);
  const tasks = db.prepare(`
    SELECT t.*, e.first_name, e.last_name
    FROM hr_compliance_tasks t
    JOIN hr_employees e ON e.id = t.employee_id
    WHERE t.status = 'pending'
    ORDER BY
      CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END,
      date(t.due_date),
      datetime(t.created_at)
    LIMIT 8
  `).all();
  logDataAccess(req, {
    action: 'hr_overview_viewed',
    accessType: 'view',
    entityType: 'hr_overview',
    recordCount: stats.active_employees + stats.open_candidates,
    riskLevel: 'high',
  });
  res.json({ stats, hours, week_start: weekStart, week_end: weekEnd, tasks });
});

router.get('/ai-settings/anthropic', authorize('super_admin'), (req, res, next) => {
  try {
    const settings = anthropicStatus();
    logDataAccess(req, {
      action: 'hr_ai_settings_viewed',
      accessType: 'view',
      entityType: 'hr_ai_settings',
      recordCount: settings.configured ? 1 : 0,
      riskLevel: 'restricted',
    });
    res.json({ settings });
  } catch (error) {
    next(error);
  }
});

router.put('/ai-settings/anthropic', authorize('super_admin'), async (req, res, next) => {
  try {
    const settings = await saveAnthropicKey(req.body.api_key, req.user.id);
    auditMutation(req, 'hr_anthropic_key_updated', 'hr_ai_settings', 'anthropic', {
      configured: settings.configured,
      last_four: settings.last_four,
      source: settings.source,
    });
    res.json({ settings });
  } catch (error) {
    next(error);
  }
});

router.delete('/ai-settings/anthropic', authorize('super_admin'), (req, res, next) => {
  try {
    const settings = clearManagedAnthropicKey();
    auditMutation(req, 'hr_anthropic_key_override_removed', 'hr_ai_settings', 'anthropic', {
      fallback_configured: settings.configured,
      fallback_source: settings.source,
    });
    res.json({ settings });
  } catch (error) {
    next(error);
  }
});

function serializeResumeImportItem(row) {
  let extracted = null;
  try {
    extracted = row.extracted_json ? JSON.parse(row.extracted_json) : null;
    if (extracted?.source_packet) {
      const { stored_name: _storedName, ...publicSourcePacket } = extracted.source_packet;
      extracted = { ...extracted, source_packet: publicSourcePacket };
    }
  } catch (_) {
    extracted = null;
  }
  return {
    id: row.id,
    batch_id: row.batch_id,
    status: row.status,
    original_name: row.original_name,
    size: row.size,
    candidate_id: row.candidate_id,
    matched_candidate_id: row.matched_candidate_id,
    document_id: row.document_id,
    review_required: Boolean(row.review_required),
    error_message: row.error_message,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    extracted,
  };
}

function resumeImportDetail(batchId) {
  const db = getDb();
  const batch = db.prepare(`
    SELECT b.*, u.name AS created_by_name
    FROM hr_resume_import_batches b
    LEFT JOIN users u ON u.id = b.created_by
    WHERE b.id = ?
  `).get(batchId);
  if (!batch) {
    const error = new Error('Resume import batch not found');
    error.statusCode = 404;
    throw error;
  }
  const items = db.prepare(`
    SELECT *
    FROM hr_resume_import_items
    WHERE batch_id = ?
    ORDER BY datetime(created_at), id
  `).all(batch.id).map(serializeResumeImportItem);
  return { batch, items };
}

router.get('/resume-imports', (req, res) => {
  const limit = integerValue(req.query.limit, 'limit', { min: 1, max: 20, fallback: 5 });
  const batches = getDb().prepare(`
    SELECT b.*, u.name AS created_by_name
    FROM hr_resume_import_batches b
    LEFT JOIN users u ON u.id = b.created_by
    ORDER BY datetime(b.created_at) DESC
    LIMIT ?
  `).all(limit);
  logDataAccess(req, {
    action: 'hr_resume_imports_viewed',
    accessType: 'view',
    entityType: 'hr_resume_import_batch',
    recordCount: batches.length,
    riskLevel: 'high',
  });
  res.json({ batches });
});

router.get('/resume-imports/:id', (req, res, next) => {
  try {
    const detail = resumeImportDetail(req.params.id);
    logDataAccess(req, {
      action: 'hr_resume_import_viewed',
      accessType: 'view',
      entityType: 'hr_resume_import_batch',
      entityId: req.params.id,
      recordCount: detail.items.length,
      riskLevel: 'high',
    });
    res.json(detail);
  } catch (error) {
    next(error);
  }
});

router.post('/resume-imports', (req, res, next) => {
  uploadResumeBatch.array('resumes', MAX_RESUME_BATCH_FILES)(req, res, error => {
    if (error) {
      removeUploadedFiles(req.files);
      return next(error);
    }

    const files = Array.isArray(req.files) ? req.files : [];
    let persisted = false;
    try {
      if (!files.length) {
        const missing = new Error('Select at least one PDF resume');
        missing.statusCode = 400;
        throw missing;
      }
      for (const file of files) {
        if (!hasValidFileSignature(file.path, file.originalname)) {
          const invalid = new Error(`${path.basename(file.originalname)} is not a valid PDF`);
          invalid.statusCode = 400;
          throw invalid;
        }
      }

      const settings = anthropicStatus();
      if (!settings.configured) {
        const notConfigured = new Error('Claude is not configured for Human Resources');
        notConfigured.statusCode = 503;
        throw notConfigured;
      }

      const batch = {
        id: uuidv4(),
        status: 'queued',
        total_files: files.length,
        model: settings.model,
        created_by: req.user.id,
      };
      const db = getDb();
      db.transaction(() => {
        db.prepare(`
          INSERT INTO hr_resume_import_batches (
            id, status, total_files, model, created_by
          ) VALUES (@id, @status, @total_files, @model, @created_by)
        `).run(batch);
        const insertItem = db.prepare(`
          INSERT INTO hr_resume_import_items (
            id, batch_id, status, original_name, stored_name, mime_type, size
          ) VALUES (?, ?, 'queued', ?, ?, 'application/pdf', ?)
        `);
        for (const file of files) {
          insertItem.run(
            uuidv4(),
            batch.id,
            path.basename(file.originalname).slice(0, 255),
            file.filename,
            file.size,
          );
        }
      })();
      persisted = true;

      auditMutation(req, 'hr_ai_resume_batch_created', 'hr_resume_import_batch', batch.id, {
        total_files: files.length,
        model: batch.model,
      });
      queueResumeBatch(batch.id, privateStorageRoot());
      res.status(202).json(resumeImportDetail(batch.id));
    } catch (uploadError) {
      if (!persisted) removeUploadedFiles(files);
      next(uploadError);
    }
  });
});

router.post('/resume-imports/:id/retry', (req, res, next) => {
  try {
    retryResumeBatch(req.params.id, privateStorageRoot());
    auditMutation(req, 'hr_ai_resume_batch_retried', 'hr_resume_import_batch', req.params.id);
    res.status(202).json(resumeImportDetail(req.params.id));
  } catch (error) {
    next(error);
  }
});

router.get('/candidates', (req, res) => {
  const db = getDb();
  const search = text(req.query.search, 120);
  const requestedStatus = text(req.query.status, 30);
  const params = [];
  const where = [];
  if (search) {
    where.push("(lower(c.first_name || ' ' || c.last_name) LIKE ? OR lower(COALESCE(c.email, '')) LIKE ? OR lower(COALESCE(c.position, '')) LIKE ?)");
    const term = `%${search.toLowerCase()}%`;
    params.push(term, term, term);
  }
  if (requestedStatus && CANDIDATE_STATUSES.has(requestedStatus)) {
    where.push('c.status = ?');
    params.push(requestedStatus);
  }
  const candidates = db.prepare(`
    SELECT
      c.*,
      (SELECT COUNT(*) FROM hr_candidate_activities a WHERE a.candidate_id = c.id) AS activity_count,
      (SELECT COUNT(*) FROM hr_documents d WHERE d.owner_type = 'candidate' AND d.owner_id = c.id AND d.document_type = 'resume') AS resume_count,
      (SELECT d.id FROM hr_documents d WHERE d.owner_type = 'candidate' AND d.owner_id = c.id AND d.document_type = 'resume' ORDER BY datetime(d.created_at) DESC LIMIT 1) AS latest_resume_id,
      (SELECT d.original_name FROM hr_documents d WHERE d.owner_type = 'candidate' AND d.owner_id = c.id AND d.document_type = 'resume' ORDER BY datetime(d.created_at) DESC LIMIT 1) AS latest_resume_name,
      COALESCE((
        SELECT MAX(i.review_required)
        FROM hr_resume_import_items i
        WHERE i.candidate_id = c.id OR i.matched_candidate_id = c.id
      ), 0) AS ai_review_required
    FROM hr_candidates c
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY
      CASE c.status
        WHEN 'offer' THEN 1 WHEN 'interview' THEN 2 WHEN 'screening' THEN 3
        WHEN 'contacted' THEN 4 WHEN 'new' THEN 5 WHEN 'on_hold' THEN 6
        WHEN 'hired' THEN 7 ELSE 8
      END,
      datetime(c.updated_at) DESC
  `).all(...params);
  logDataAccess(req, {
    action: 'hr_candidates_viewed',
    accessType: 'view',
    entityType: 'hr_candidate',
    recordCount: candidates.length,
    riskLevel: 'high',
  });
  res.json({ candidates });
});

router.post('/candidates', (req, res, next) => {
  try {
    const candidate = {
      id: uuidv4(),
      first_name: requiredText(req.body.first_name, 'First name', 100),
      last_name: requiredText(req.body.last_name, 'Last name', 100),
      email: text(req.body.email, 200),
      phone: text(req.body.phone, 50),
      position: text(req.body.position, 160),
      source: text(req.body.source, 120),
      status: choice(req.body.status, CANDIDATE_STATUSES, 'new', 'candidate status'),
      next_follow_up_at: dateTimeValue(req.body.next_follow_up_at, 'next follow-up date'),
      notes: text(req.body.notes, 5000),
      created_by: req.user.id,
    };
    getDb().prepare(`
      INSERT INTO hr_candidates (
        id, first_name, last_name, email, phone, position, source, status,
        next_follow_up_at, notes, created_by
      ) VALUES (
        @id, @first_name, @last_name, @email, @phone, @position, @source, @status,
        @next_follow_up_at, @notes, @created_by
      )
    `).run(candidate);
    auditMutation(req, 'hr_candidate_created', 'hr_candidate', candidate.id);
    res.status(201).json({ candidate: getRecord('hr_candidates', candidate.id, 'Candidate') });
  } catch (error) {
    next(error);
  }
});

router.get('/candidates/:id', (req, res, next) => {
  try {
    const candidate = getRecord('hr_candidates', req.params.id, 'Candidate');
    const db = getDb();
    candidate.ai_review_required = Number(db.prepare(`
      SELECT COALESCE(MAX(review_required), 0) AS required
      FROM hr_resume_import_items
      WHERE candidate_id = ? OR matched_candidate_id = ?
    `).get(candidate.id, candidate.id).required || 0);
    const activities = db.prepare(`
      SELECT a.*, u.name AS created_by_name
      FROM hr_candidate_activities a
      LEFT JOIN users u ON u.id = a.created_by
      WHERE a.candidate_id = ?
      ORDER BY datetime(a.contacted_at) DESC, datetime(a.created_at) DESC
    `).all(candidate.id);
    const documents = db.prepare(`
      SELECT d.id, d.document_type, d.original_name, d.mime_type, d.size, d.created_at, u.name AS uploaded_by_name
      FROM hr_documents d
      LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.owner_type = 'candidate' AND d.owner_id = ?
      ORDER BY datetime(d.created_at) DESC
    `).all(candidate.id);
    logDataAccess(req, {
      action: 'hr_candidate_viewed',
      accessType: 'view',
      entityType: 'hr_candidate',
      entityId: candidate.id,
      recordCount: 1,
      riskLevel: 'high',
    });
    res.json({ candidate, activities, documents });
  } catch (error) {
    next(error);
  }
});

router.patch('/candidates/:id', (req, res, next) => {
  try {
    const candidate = updateRecord('hr_candidates', req.params.id, req.body, {
      first_name: value => requiredText(value, 'First name', 100),
      last_name: value => requiredText(value, 'Last name', 100),
      email: value => text(value, 200),
      phone: value => text(value, 50),
      position: value => text(value, 160),
      source: value => text(value, 120),
      status: value => choice(value, CANDIDATE_STATUSES, 'new', 'candidate status'),
      next_follow_up_at: value => dateTimeValue(value, 'next follow-up date'),
      notes: value => text(value, 5000),
    }, 'Candidate');
    auditMutation(req, 'hr_candidate_updated', 'hr_candidate', candidate.id);
    res.json({ candidate });
  } catch (error) {
    next(error);
  }
});

router.patch('/candidates/:id/ai-review', (req, res, next) => {
  try {
    const candidate = getRecord('hr_candidates', req.params.id, 'Candidate');
    const reviewed = req.body.reviewed !== false;
    const result = getDb().prepare(`
      UPDATE hr_resume_import_items
      SET review_required = ?
      WHERE candidate_id = ? OR matched_candidate_id = ?
    `).run(reviewed ? 0 : 1, candidate.id, candidate.id);
    auditMutation(req, reviewed ? 'hr_ai_applicant_reviewed' : 'hr_ai_applicant_review_reopened', 'hr_candidate', candidate.id, {
      import_items_updated: result.changes,
    });
    res.json({ candidate_id: candidate.id, ai_review_required: reviewed ? 0 : 1 });
  } catch (error) {
    next(error);
  }
});

router.post('/candidates/:id/activities', (req, res, next) => {
  try {
    const candidate = getRecord('hr_candidates', req.params.id, 'Candidate');
    const contactType = choice(req.body.contact_type, CONTACT_TYPES, 'note', 'contact type');
    const contactedAt = dateTimeValue(req.body.contacted_at, 'contact date') || new Date().toISOString();
    const activity = {
      id: uuidv4(),
      candidate_id: candidate.id,
      contact_type: contactType,
      direction: text(req.body.direction, 20) || (contactType === 'note' ? 'internal' : 'outbound'),
      outcome: text(req.body.outcome, 200),
      notes: text(req.body.notes, 5000),
      contacted_at: contactedAt,
      created_by: req.user.id,
    };
    const db = getDb();
    db.prepare(`
      INSERT INTO hr_candidate_activities (
        id, candidate_id, contact_type, direction, outcome, notes, contacted_at, created_by
      ) VALUES (
        @id, @candidate_id, @contact_type, @direction, @outcome, @notes, @contacted_at, @created_by
      )
    `).run(activity);
    db.prepare(`
      UPDATE hr_candidates
      SET last_contacted_at = ?,
          status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(contactedAt, candidate.id);
    auditMutation(req, `hr_candidate_${contactType}_logged`, 'hr_candidate_activity', activity.id, {
      candidate_id: candidate.id,
      contact_type: contactType,
    });
    res.status(201).json({ activity });
  } catch (error) {
    next(error);
  }
});

router.post('/candidates/:id/resume', (req, res, next) => {
  try {
    getRecord('hr_candidates', req.params.id, 'Candidate');
  } catch (error) {
    return next(error);
  }
  uploadDocument.single('resume')(req, res, error => {
    if (error) return next(error);
    try {
      if (!req.file) {
        const missing = new Error('Resume file is required');
        missing.statusCode = 400;
        throw missing;
      }
      if (!hasValidFileSignature(req.file.path, req.file.originalname)) {
        const invalidFile = new Error('The uploaded file contents do not match its file type');
        invalidFile.statusCode = 400;
        throw invalidFile;
      }
      const document = {
        id: uuidv4(),
        owner_type: 'candidate',
        owner_id: req.params.id,
        document_type: 'resume',
        stored_name: req.file.filename,
        original_name: path.basename(req.file.originalname).slice(0, 255),
        mime_type: text(req.file.mimetype, 120) || 'application/octet-stream',
        size: req.file.size,
        uploaded_by: req.user.id,
      };
      getDb().prepare(`
        INSERT INTO hr_documents (
          id, owner_type, owner_id, document_type, stored_name, original_name, mime_type, size, uploaded_by
        ) VALUES (
          @id, @owner_type, @owner_id, @document_type, @stored_name, @original_name, @mime_type, @size, @uploaded_by
        )
      `).run(document);
      auditMutation(req, 'hr_resume_uploaded', 'hr_document', document.id, {
        candidate_id: req.params.id,
        size: document.size,
        mime_type: document.mime_type,
      });
      res.status(201).json({
        document: {
          id: document.id,
          document_type: document.document_type,
          original_name: document.original_name,
          mime_type: document.mime_type,
          size: document.size,
        },
      });
    } catch (uploadError) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      next(uploadError);
    }
  });
});

router.get('/employees', (req, res) => {
  const employees = getDb().prepare(`
    SELECT
      e.*,
      (SELECT COUNT(*) FROM hr_benefit_enrollments b WHERE b.employee_id = e.id AND b.status = 'enrolled') AS enrolled_benefit_count,
      (SELECT COUNT(*) FROM hr_compliance_tasks t WHERE t.employee_id = e.id AND t.status = 'pending') AS pending_task_count
    FROM hr_employees e
    ORDER BY
      CASE e.employment_status WHEN 'active' THEN 1 WHEN 'leave' THEN 2 ELSE 3 END,
      lower(e.last_name),
      lower(e.first_name)
  `).all();
  logDataAccess(req, {
    action: 'hr_employees_viewed',
    accessType: 'view',
    entityType: 'hr_employee',
    recordCount: employees.length,
    riskLevel: 'high',
  });
  res.json({ employees });
});

router.post('/employees', (req, res, next) => {
  try {
    const employee = {
      id: uuidv4(),
      source_candidate_id: text(req.body.source_candidate_id, 80),
      linked_user_id: text(req.body.linked_user_id, 80),
      first_name: requiredText(req.body.first_name, 'First name', 100),
      last_name: requiredText(req.body.last_name, 'Last name', 100),
      preferred_name: text(req.body.preferred_name, 100),
      personal_email: text(req.body.personal_email, 200),
      work_email: text(req.body.work_email, 200),
      phone: text(req.body.phone, 50),
      mailing_address: text(req.body.mailing_address, 300),
      city: text(req.body.city, 100),
      state: text(req.body.state, 30),
      postal_code: text(req.body.postal_code, 20),
      job_title: text(req.body.job_title, 160),
      department: text(req.body.department, 120),
      manager_name: text(req.body.manager_name, 160),
      work_location: text(req.body.work_location, 200),
      employment_status: choice(req.body.employment_status, EMPLOYMENT_STATUSES, 'active', 'employment status'),
      employment_type: choice(req.body.employment_type, EMPLOYMENT_TYPES, 'full_time', 'employment type'),
      classification: choice(req.body.classification, CLASSIFICATIONS, 'non_exempt', 'classification'),
      hire_date: dateValue(req.body.hire_date, 'hire date'),
      termination_date: dateValue(req.body.termination_date, 'termination date'),
      pay_type: choice(req.body.pay_type, PAY_TYPES, 'hourly', 'pay type'),
      pay_rate_cents: integerValue(req.body.pay_rate_cents, 'pay rate', { min: 0, max: 100000000 }),
      pay_frequency: choice(req.body.pay_frequency, PAY_FREQUENCIES, 'biweekly', 'pay frequency'),
      standard_weekly_hours: numberValue(req.body.standard_weekly_hours, 'standard weekly hours', { min: 0, max: 168, fallback: 40 }),
      benefit_eligible: req.body.benefit_eligible ? 1 : 0,
      benefit_eligibility_date: dateValue(req.body.benefit_eligibility_date, 'benefit eligibility date'),
      emergency_contact_name: text(req.body.emergency_contact_name, 160),
      emergency_contact_relationship: text(req.body.emergency_contact_relationship, 80),
      emergency_contact_phone: text(req.body.emergency_contact_phone, 50),
      notes: text(req.body.notes, 5000),
      created_by: req.user.id,
    };
    const db = getDb();
    if (employee.source_candidate_id) getRecord('hr_candidates', employee.source_candidate_id, 'Candidate');
    db.prepare(`
      INSERT INTO hr_employees (
        id, source_candidate_id, linked_user_id, first_name, last_name, preferred_name,
        personal_email, work_email, phone, mailing_address, city, state, postal_code,
        job_title, department, manager_name, work_location, employment_status,
        employment_type, classification, hire_date, termination_date, pay_type,
        pay_rate_cents, pay_frequency, standard_weekly_hours, benefit_eligible,
        benefit_eligibility_date, emergency_contact_name, emergency_contact_relationship,
        emergency_contact_phone, notes, created_by
      ) VALUES (
        @id, @source_candidate_id, @linked_user_id, @first_name, @last_name, @preferred_name,
        @personal_email, @work_email, @phone, @mailing_address, @city, @state, @postal_code,
        @job_title, @department, @manager_name, @work_location, @employment_status,
        @employment_type, @classification, @hire_date, @termination_date, @pay_type,
        @pay_rate_cents, @pay_frequency, @standard_weekly_hours, @benefit_eligible,
        @benefit_eligibility_date, @emergency_contact_name, @emergency_contact_relationship,
        @emergency_contact_phone, @notes, @created_by
      )
    `).run(employee);
    seedComplianceTasks(db, employee.id, employee.hire_date, req.user.id);
    if (employee.source_candidate_id) {
      db.prepare("UPDATE hr_candidates SET status = 'hired', updated_at = datetime('now') WHERE id = ?").run(employee.source_candidate_id);
    }
    auditMutation(req, 'hr_employee_created', 'hr_employee', employee.id);
    res.status(201).json({ employee: getRecord('hr_employees', employee.id, 'Employee') });
  } catch (error) {
    next(error);
  }
});

router.get('/employees/:id', (req, res, next) => {
  try {
    const employee = getRecord('hr_employees', req.params.id, 'Employee');
    const db = getDb();
    const benefits = db.prepare('SELECT * FROM hr_benefit_enrollments WHERE employee_id = ? ORDER BY benefit_type, effective_date DESC').all(employee.id);
    const leave_balances = db.prepare('SELECT * FROM hr_leave_balances WHERE employee_id = ? ORDER BY benefit_year DESC, leave_type').all(employee.id);
    const compliance_tasks = db.prepare(`
      SELECT t.*, u.name AS completed_by_name
      FROM hr_compliance_tasks t
      LEFT JOIN users u ON u.id = t.completed_by
      WHERE t.employee_id = ?
      ORDER BY CASE t.status WHEN 'pending' THEN 1 ELSE 2 END, date(t.due_date), datetime(t.created_at)
    `).all(employee.id);
    logDataAccess(req, {
      action: 'hr_employee_viewed',
      accessType: 'view',
      entityType: 'hr_employee',
      entityId: employee.id,
      recordCount: 1,
      riskLevel: 'high',
    });
    res.json({ employee, benefits, leave_balances, compliance_tasks });
  } catch (error) {
    next(error);
  }
});

router.patch('/employees/:id', (req, res, next) => {
  try {
    const employee = updateRecord('hr_employees', req.params.id, req.body, {
      first_name: value => requiredText(value, 'First name', 100),
      last_name: value => requiredText(value, 'Last name', 100),
      preferred_name: value => text(value, 100),
      personal_email: value => text(value, 200),
      work_email: value => text(value, 200),
      phone: value => text(value, 50),
      mailing_address: value => text(value, 300),
      city: value => text(value, 100),
      state: value => text(value, 30),
      postal_code: value => text(value, 20),
      job_title: value => text(value, 160),
      department: value => text(value, 120),
      manager_name: value => text(value, 160),
      work_location: value => text(value, 200),
      employment_status: value => choice(value, EMPLOYMENT_STATUSES, 'active', 'employment status'),
      employment_type: value => choice(value, EMPLOYMENT_TYPES, 'full_time', 'employment type'),
      classification: value => choice(value, CLASSIFICATIONS, 'non_exempt', 'classification'),
      hire_date: value => dateValue(value, 'hire date'),
      termination_date: value => dateValue(value, 'termination date'),
      pay_type: value => choice(value, PAY_TYPES, 'hourly', 'pay type'),
      pay_rate_cents: value => integerValue(value, 'pay rate', { min: 0, max: 100000000 }),
      pay_frequency: value => choice(value, PAY_FREQUENCIES, 'biweekly', 'pay frequency'),
      standard_weekly_hours: value => numberValue(value, 'standard weekly hours', { min: 0, max: 168, fallback: 40 }),
      benefit_eligible: value => value ? 1 : 0,
      benefit_eligibility_date: value => dateValue(value, 'benefit eligibility date'),
      emergency_contact_name: value => text(value, 160),
      emergency_contact_relationship: value => text(value, 80),
      emergency_contact_phone: value => text(value, 50),
      notes: value => text(value, 5000),
    }, 'Employee');
    auditMutation(req, 'hr_employee_updated', 'hr_employee', employee.id);
    res.json({ employee });
  } catch (error) {
    next(error);
  }
});

router.get('/time-entries', (req, res, next) => {
  try {
    const [defaultFrom, defaultTo] = currentWeekRange();
    const from = dateValue(req.query.from, 'from date') || defaultFrom;
    const to = dateValue(req.query.to, 'to date') || defaultTo;
    const employeeId = text(req.query.employee_id, 80);
    const params = [from, to];
    let employeeFilter = '';
    if (employeeId) {
      employeeFilter = 'AND t.employee_id = ?';
      params.push(employeeId);
    }
    const entries = getDb().prepare(`
      SELECT t.*, e.first_name, e.last_name, e.job_title
      FROM hr_time_entries t
      JOIN hr_employees e ON e.id = t.employee_id
      WHERE t.work_date BETWEEN ? AND ?
        ${employeeFilter}
      ORDER BY date(t.work_date) DESC, lower(e.last_name), lower(e.first_name)
    `).all(...params);
    logDataAccess(req, {
      action: 'hr_time_entries_viewed',
      accessType: 'view',
      entityType: 'hr_time_entry',
      recordCount: entries.length,
      riskLevel: 'high',
      details: { from, to },
    });
    res.json({ entries, from, to });
  } catch (error) {
    next(error);
  }
});

router.post('/time-entries', (req, res, next) => {
  try {
    const employee = getRecord('hr_employees', requiredText(req.body.employee_id, 'Employee', 80), 'Employee');
    const entry = {
      id: uuidv4(),
      employee_id: employee.id,
      work_date: dateValue(req.body.work_date, 'work date'),
      regular_hours: numberValue(req.body.regular_hours, 'regular hours', { min: 0, max: 24 }),
      overtime_hours: numberValue(req.body.overtime_hours, 'overtime hours', { min: 0, max: 24 }),
      pto_hours: numberValue(req.body.pto_hours, 'PTO hours', { min: 0, max: 24 }),
      sick_hours: numberValue(req.body.sick_hours, 'sick hours', { min: 0, max: 24 }),
      unpaid_hours: numberValue(req.body.unpaid_hours, 'unpaid hours', { min: 0, max: 24 }),
      notes: text(req.body.notes, 1000),
      created_by: req.user.id,
    };
    if (!entry.work_date) {
      const error = new Error('Work date is required');
      error.statusCode = 400;
      throw error;
    }
    const total = entry.regular_hours + entry.overtime_hours + entry.pto_hours + entry.sick_hours + entry.unpaid_hours;
    if (total > 24) {
      const error = new Error('Total daily hours cannot exceed 24');
      error.statusCode = 400;
      throw error;
    }
    getDb().prepare(`
      INSERT INTO hr_time_entries (
        id, employee_id, work_date, regular_hours, overtime_hours, pto_hours,
        sick_hours, unpaid_hours, notes, created_by
      ) VALUES (
        @id, @employee_id, @work_date, @regular_hours, @overtime_hours, @pto_hours,
        @sick_hours, @unpaid_hours, @notes, @created_by
      )
      ON CONFLICT(employee_id, work_date) DO UPDATE SET
        regular_hours = excluded.regular_hours,
        overtime_hours = excluded.overtime_hours,
        pto_hours = excluded.pto_hours,
        sick_hours = excluded.sick_hours,
        unpaid_hours = excluded.unpaid_hours,
        notes = excluded.notes,
        updated_at = datetime('now')
    `).run(entry);
    const saved = getDb().prepare('SELECT * FROM hr_time_entries WHERE employee_id = ? AND work_date = ?').get(entry.employee_id, entry.work_date);
    auditMutation(req, 'hr_time_entry_saved', 'hr_time_entry', saved.id, {
      employee_id: employee.id,
      work_date: entry.work_date,
    });
    res.status(201).json({ entry: saved });
  } catch (error) {
    next(error);
  }
});

router.get('/leave-requests', (req, res) => {
  const requests = getDb().prepare(`
    SELECT r.*, e.first_name, e.last_name, reviewer.name AS reviewed_by_name
    FROM hr_leave_requests r
    JOIN hr_employees e ON e.id = r.employee_id
    LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by
    ORDER BY
      CASE r.status WHEN 'requested' THEN 1 ELSE 2 END,
      date(r.start_date) DESC,
      datetime(r.created_at) DESC
  `).all();
  logDataAccess(req, {
    action: 'hr_leave_requests_viewed',
    accessType: 'view',
    entityType: 'hr_leave_request',
    recordCount: requests.length,
    riskLevel: 'high',
  });
  res.json({ requests });
});

router.post('/leave-requests', (req, res, next) => {
  try {
    const employee = getRecord('hr_employees', requiredText(req.body.employee_id, 'Employee', 80), 'Employee');
    const request = {
      id: uuidv4(),
      employee_id: employee.id,
      leave_type: choice(req.body.leave_type, LEAVE_TYPES, 'pto', 'leave type'),
      start_date: dateValue(req.body.start_date, 'start date'),
      end_date: dateValue(req.body.end_date, 'end date'),
      hours: numberValue(req.body.hours, 'leave hours', { min: 0, max: 1000 }),
      status: choice(req.body.status, LEAVE_STATUSES, 'requested', 'leave status'),
      notes: text(req.body.notes, 2000),
      created_by: req.user.id,
    };
    if (!request.start_date || !request.end_date) {
      const error = new Error('Start and end dates are required');
      error.statusCode = 400;
      throw error;
    }
    getDb().prepare(`
      INSERT INTO hr_leave_requests (
        id, employee_id, leave_type, start_date, end_date, hours, status, notes, created_by
      ) VALUES (
        @id, @employee_id, @leave_type, @start_date, @end_date, @hours, @status, @notes, @created_by
      )
    `).run(request);
    auditMutation(req, 'hr_leave_request_created', 'hr_leave_request', request.id, {
      employee_id: employee.id,
      leave_type: request.leave_type,
    });
    res.status(201).json({ request: getRecord('hr_leave_requests', request.id, 'Leave request') });
  } catch (error) {
    next(error);
  }
});

router.patch('/leave-requests/:id', (req, res, next) => {
  try {
    const status = choice(req.body.status, LEAVE_STATUSES, 'requested', 'leave status');
    const db = getDb();
    const result = db.prepare(`
      UPDATE hr_leave_requests
      SET status = ?,
          reviewed_by = ?,
          reviewed_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(status, req.user.id, req.params.id);
    if (!result.changes) {
      const error = new Error('Leave request not found');
      error.statusCode = 404;
      throw error;
    }
    auditMutation(req, 'hr_leave_request_reviewed', 'hr_leave_request', req.params.id, { status });
    res.json({ request: getRecord('hr_leave_requests', req.params.id, 'Leave request') });
  } catch (error) {
    next(error);
  }
});

router.put('/employees/:id/leave-balances/:leaveType', (req, res, next) => {
  try {
    const employee = getRecord('hr_employees', req.params.id, 'Employee');
    const leaveType = choice(req.params.leaveType, LEAVE_TYPES, null, 'leave type');
    const balance = {
      id: uuidv4(),
      employee_id: employee.id,
      leave_type: leaveType,
      benefit_year: integerValue(req.body.benefit_year, 'benefit year', { min: 2000, max: 2200, fallback: new Date().getFullYear() }),
      opening_hours: numberValue(req.body.opening_hours, 'opening hours', { min: 0, max: 10000 }),
      accrued_hours: numberValue(req.body.accrued_hours, 'accrued hours', { min: 0, max: 10000 }),
      used_hours: numberValue(req.body.used_hours, 'used hours', { min: 0, max: 10000 }),
      annual_use_limit_hours: req.body.annual_use_limit_hours === '' || req.body.annual_use_limit_hours == null
        ? null
        : numberValue(req.body.annual_use_limit_hours, 'annual use limit', { min: 0, max: 10000 }),
      updated_by: req.user.id,
    };
    getDb().prepare(`
      INSERT INTO hr_leave_balances (
        id, employee_id, leave_type, benefit_year, opening_hours, accrued_hours,
        used_hours, annual_use_limit_hours, updated_by
      ) VALUES (
        @id, @employee_id, @leave_type, @benefit_year, @opening_hours, @accrued_hours,
        @used_hours, @annual_use_limit_hours, @updated_by
      )
      ON CONFLICT(employee_id, leave_type, benefit_year) DO UPDATE SET
        opening_hours = excluded.opening_hours,
        accrued_hours = excluded.accrued_hours,
        used_hours = excluded.used_hours,
        annual_use_limit_hours = excluded.annual_use_limit_hours,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')
    `).run(balance);
    const saved = getDb().prepare(`
      SELECT * FROM hr_leave_balances WHERE employee_id = ? AND leave_type = ? AND benefit_year = ?
    `).get(employee.id, leaveType, balance.benefit_year);
    auditMutation(req, 'hr_leave_balance_saved', 'hr_leave_balance', saved.id, {
      employee_id: employee.id,
      leave_type: leaveType,
    });
    res.json({ balance: saved });
  } catch (error) {
    next(error);
  }
});

router.get('/benefits', (req, res) => {
  const benefits = getDb().prepare(`
    SELECT b.*, e.first_name, e.last_name
    FROM hr_benefit_enrollments b
    JOIN hr_employees e ON e.id = b.employee_id
    ORDER BY lower(e.last_name), lower(e.first_name), b.benefit_type, date(b.effective_date) DESC
  `).all();
  logDataAccess(req, {
    action: 'hr_benefits_viewed',
    accessType: 'view',
    entityType: 'hr_benefit_enrollment',
    recordCount: benefits.length,
    riskLevel: 'high',
  });
  res.json({ benefits });
});

router.post('/benefits', (req, res, next) => {
  try {
    const employee = getRecord('hr_employees', requiredText(req.body.employee_id, 'Employee', 80), 'Employee');
    const benefit = {
      id: uuidv4(),
      employee_id: employee.id,
      benefit_type: choice(req.body.benefit_type, BENEFIT_TYPES, 'health', 'benefit type'),
      plan_name: requiredText(req.body.plan_name, 'Plan name', 200),
      coverage_level: text(req.body.coverage_level, 100),
      status: choice(req.body.status, BENEFIT_STATUSES, 'offered', 'benefit status'),
      effective_date: dateValue(req.body.effective_date, 'effective date'),
      end_date: dateValue(req.body.end_date, 'end date'),
      employee_monthly_cents: integerValue(req.body.employee_monthly_cents, 'employee monthly contribution', { min: 0, max: 100000000 }),
      employer_monthly_cents: integerValue(req.body.employer_monthly_cents, 'employer monthly contribution', { min: 0, max: 100000000 }),
      notes: text(req.body.notes, 2000),
      created_by: req.user.id,
    };
    getDb().prepare(`
      INSERT INTO hr_benefit_enrollments (
        id, employee_id, benefit_type, plan_name, coverage_level, status,
        effective_date, end_date, employee_monthly_cents, employer_monthly_cents,
        notes, created_by
      ) VALUES (
        @id, @employee_id, @benefit_type, @plan_name, @coverage_level, @status,
        @effective_date, @end_date, @employee_monthly_cents, @employer_monthly_cents,
        @notes, @created_by
      )
    `).run(benefit);
    auditMutation(req, 'hr_benefit_created', 'hr_benefit_enrollment', benefit.id, {
      employee_id: employee.id,
      benefit_type: benefit.benefit_type,
    });
    res.status(201).json({ benefit: getRecord('hr_benefit_enrollments', benefit.id, 'Benefit') });
  } catch (error) {
    next(error);
  }
});

router.get('/compliance', (req, res) => {
  const tasks = getDb().prepare(`
    SELECT t.*, e.first_name, e.last_name, e.job_title, u.name AS completed_by_name
    FROM hr_compliance_tasks t
    JOIN hr_employees e ON e.id = t.employee_id
    LEFT JOIN users u ON u.id = t.completed_by
    ORDER BY
      CASE t.status WHEN 'pending' THEN 1 WHEN 'complete' THEN 2 ELSE 3 END,
      CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END,
      date(t.due_date),
      lower(e.last_name),
      lower(e.first_name)
  `).all();
  logDataAccess(req, {
    action: 'hr_compliance_viewed',
    accessType: 'view',
    entityType: 'hr_compliance_task',
    recordCount: tasks.length,
    riskLevel: 'high',
  });
  res.json({ tasks });
});

router.post('/compliance', (req, res, next) => {
  try {
    const employee = getRecord('hr_employees', requiredText(req.body.employee_id, 'Employee', 80), 'Employee');
    const task = {
      id: uuidv4(),
      employee_id: employee.id,
      category: text(req.body.category, 80) || 'other',
      task_name: requiredText(req.body.task_name, 'Task name', 240),
      due_date: dateValue(req.body.due_date, 'due date'),
      status: choice(req.body.status, COMPLIANCE_STATUSES, 'pending', 'compliance status'),
      notes: text(req.body.notes, 2000),
      created_by: req.user.id,
    };
    getDb().prepare(`
      INSERT INTO hr_compliance_tasks (
        id, employee_id, category, task_name, due_date, status, notes, created_by
      ) VALUES (
        @id, @employee_id, @category, @task_name, @due_date, @status, @notes, @created_by
      )
    `).run(task);
    auditMutation(req, 'hr_compliance_task_created', 'hr_compliance_task', task.id, { employee_id: employee.id });
    res.status(201).json({ task: getRecord('hr_compliance_tasks', task.id, 'Compliance task') });
  } catch (error) {
    next(error);
  }
});

router.patch('/compliance/:id', (req, res, next) => {
  try {
    const status = choice(req.body.status, COMPLIANCE_STATUSES, 'pending', 'compliance status');
    const db = getDb();
    const result = db.prepare(`
      UPDATE hr_compliance_tasks
      SET status = ?,
          completed_at = CASE WHEN ? = 'complete' THEN datetime('now') ELSE NULL END,
          completed_by = CASE WHEN ? = 'complete' THEN ? ELSE NULL END,
          notes = COALESCE(?, notes),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(status, status, status, req.user.id, text(req.body.notes, 2000), req.params.id);
    if (!result.changes) {
      const error = new Error('Compliance task not found');
      error.statusCode = 404;
      throw error;
    }
    auditMutation(req, 'hr_compliance_task_updated', 'hr_compliance_task', req.params.id, { status });
    res.json({ task: getRecord('hr_compliance_tasks', req.params.id, 'Compliance task') });
  } catch (error) {
    next(error);
  }
});

router.get('/documents/:id/download', (req, res, next) => {
  try {
    const document = getRecord('hr_documents', req.params.id, 'Document');
    const root = privateStorageRoot();
    const filePath = path.resolve(root, document.stored_name);
    if (!filePath.startsWith(`${root}${path.sep}`) || !fs.existsSync(filePath)) {
      const error = new Error('Document file not found');
      error.statusCode = 404;
      throw error;
    }
    logDataAccess(req, {
      action: 'hr_document_downloaded',
      accessType: 'download',
      entityType: 'hr_document',
      entityId: document.id,
      recordCount: 1,
      riskLevel: 'restricted',
      details: {
        owner_type: document.owner_type,
        document_type: document.document_type,
        size: document.size,
      },
    });
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.download(filePath, document.original_name);
  } catch (error) {
    next(error);
  }
});

router.delete('/documents/:id', (req, res, next) => {
  try {
    if (!UPPER_MANAGEMENT_ROLES.includes(req.user.role)) {
      const error = new Error('Only operations managers and super admins can delete HR documents');
      error.statusCode = 403;
      throw error;
    }
    const document = getRecord('hr_documents', req.params.id, 'Document');
    const filePath = path.resolve(privateStorageRoot(), document.stored_name);
    if (filePath.startsWith(`${privateStorageRoot()}${path.sep}`) && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    getDb().prepare('DELETE FROM hr_documents WHERE id = ?').run(document.id);
    auditMutation(req, 'hr_document_deleted', 'hr_document', document.id, {
      owner_type: document.owner_type,
      document_type: document.document_type,
    });
    res.json({ message: 'Document deleted' });
  } catch (error) {
    next(error);
  }
});

router.use((error, _req, res, _next) => {
  const status = error.statusCode || (error instanceof multer.MulterError ? 400 : 500);
  if (status >= 500) console.error('[HR] Request failed:', error);
  res.status(status).json({ error: status >= 500 ? 'Human Resources request failed' : error.message });
});

module.exports = router;
