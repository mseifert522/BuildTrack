const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getDb } = require('../db/schema');
const { authenticate, PROJECT_MANAGE_ROLES, UPPER_MANAGEMENT_ROLES } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { logDataAccess } = require('../utils/dataAccessAudit');
const { generateScopeOfWorkPDF } = require('../utils/scopePdf');

// /api/projects/:projectId/scope-document - the Scope of Work PDF at the top of every
// project's Scope of Work tab (Mike, 2026-10-19). Management uploads the official PDF
// (newest = the one shown; older uploads stay as versions); until one is uploaded the
// tab shows a PDF generated from the scope entered in BuildTrack. Files are read only
// through this router - uploads/scope-documents is never served statically.
const router = express.Router({ mergeParams: true });
router.use(authenticate);

const MAX_MB = Math.max(Number.parseInt(process.env.SCOPE_DOCUMENT_MAX_MB || '50', 10) || 50, 1);
const STORAGE_DIR = 'scope-documents';

function uploadsRoot() {
  return path.resolve(process.env.UPLOADS_PATH || './uploads');
}

function projectDir(projectId) {
  return path.join(uploadsRoot(), STORAGE_DIR, projectId);
}

function canViewProject(db, user, projectId) {
  if (PROJECT_MANAGE_ROLES.includes(user.role)) return true;
  if (user.role !== 'contractor') return false;
  return Boolean(db.prepare('SELECT 1 FROM project_assignments WHERE project_id = ? AND user_id = ?').get(projectId, user.id));
}

function loadProject(req, res) {
  const db = getDb();
  const project = db.prepare('SELECT id, address, job_name, scope_of_work FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  if (!canViewProject(db, req.user, project.id)) {
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  return project;
}

function displayName(value) {
  const base = path.basename(String(value || '')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const name = base || 'Scope of Work.pdf';
  return (/\.pdf$/i.test(name) ? name : `${name}.pdf`).slice(-200);
}

function contentDisposition(type, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function scopeCounts(db, projectId) {
  const scopes = db.prepare('SELECT COUNT(*) AS n FROM project_scopes WHERE project_id = ?').get(projectId).n;
  const lines = db.prepare('SELECT COUNT(*) AS n FROM construction_plan_items WHERE project_id = ?').get(projectId).n;
  return { scopes, lines };
}

function listPayload(db, req, project) {
  const versions = db.prepare(`
    SELECT d.id, d.original_name, d.size_bytes, d.created_at, u.name AS uploaded_by_name
    FROM project_scope_pdfs d
    LEFT JOIN users u ON u.id = d.uploaded_by
    WHERE d.project_id = ?
    ORDER BY datetime(d.created_at) DESC, d.rowid DESC
  `).all(project.id).map(row => ({
    ...row,
    url: `/api/projects/${project.id}/scope-document/${row.id}/file`,
  }));
  const counts = scopeCounts(db, project.id);
  return {
    current: versions[0] || null,
    versions,
    generated: {
      url: `/api/projects/${project.id}/scope-document/generated.pdf`,
      file_name: displayName(`Scope of Work - ${project.job_name || project.address || 'Project'}`),
      scope_count: counts.scopes,
      line_count: counts.lines,
      has_content: counts.scopes > 0 || counts.lines > 0 || Boolean(String(project.scope_of_work || '').trim()),
    },
    permissions: {
      can_upload: PROJECT_MANAGE_ROLES.includes(req.user.role),
      can_delete: UPPER_MANAGEMENT_ROLES.includes(req.user.role),
    },
    max_mb: MAX_MB,
  };
}

router.get('/', (req, res) => {
  const project = loadProject(req, res);
  if (!project) return;
  res.set('Cache-Control', 'no-store');
  res.json(listPayload(getDb(), req, project));
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = projectDir(req.params.projectId);
      fs.mkdir(dir, { recursive: true }, err => cb(err, dir));
    },
    filename: (_req, _file, cb) => cb(null, `${Date.now()}-${crypto.randomUUID()}.pdf`),
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
});

function acceptOnePdf(req, res, next) {
  upload.single('file')(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `The PDF is larger than ${MAX_MB} MB.` });
    return res.status(400).json({ error: 'The file could not be uploaded.' });
  });
}

function readHead(filePath, bytes) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

// POST / - upload a new Scope of Work PDF (it becomes the one shown).
router.post('/', (req, res, next) => {
  const project = loadProject(req, res);
  if (!project) return;
  if (!PROJECT_MANAGE_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Only management can upload the scope of work' });
  req.scopeProject = project;
  next();
}, acceptOnePdf, async (req, res) => {
  const project = req.scopeProject;
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Choose a PDF to upload.' });
  const removeUpload = () => fs.rm(file.path, { force: true }, () => {});
  try {
    // The PDF header may sit anywhere in the first 1 KB (PDF 1.7, 7.5.2).
    if (!readHead(file.path, 1024).includes(Buffer.from('%PDF-'))) {
      removeUpload();
      return res.status(400).json({ error: 'That file is not a PDF. Upload the scope of work as a PDF.' });
    }
    const sha256 = await sha256File(file.path);
    const db = getDb();
    const id = crypto.randomUUID();
    const originalName = displayName(file.originalname);
    const storagePath = path.posix.join(STORAGE_DIR, project.id, path.basename(file.path));
    db.prepare(`
      INSERT INTO project_scope_pdfs (id, project_id, original_name, size_bytes, sha256, storage_path, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, project.id, originalName, file.size, sha256, storagePath, req.user.id);
    logActivity({
      userId: req.user.id,
      projectId: project.id,
      action: 'scope_document_uploaded',
      entityType: 'project_scope_document',
      entityId: id,
      details: { original_name: originalName, size_bytes: file.size },
    });
    res.status(201).json(listPayload(db, req, project));
  } catch (err) {
    removeUpload();
    console.error('[ScopeDocument] Upload failed:', err.message);
    res.status(500).json({ error: 'The scope of work could not be saved. Please try again.' });
  }
});

// GET /generated.pdf - the scope entered in BuildTrack, rendered as a PDF right now.
router.get('/generated.pdf', async (req, res) => {
  const project = loadProject(req, res);
  if (!project) return;
  try {
    const db = getDb();
    const scopes = db.prepare(`
      SELECT id, section_name, scope_title, scope_of_work, status, timeline_start, timeline_end, created_by_agent, source, created_at
      FROM project_scopes WHERE project_id = ?
      ORDER BY sort_order ASC, datetime(created_at) ASC
    `).all(project.id);
    const items = db.prepare(`
      SELECT id, project_scope_id, title, description, category, location, status, sort_order
      FROM construction_plan_items WHERE project_id = ?
      ORDER BY sort_order ASC, datetime(created_at) ASC
    `).all(project.id);
    const pdf = await generateScopeOfWorkPDF({ project, scopes, items, generatedAt: new Date() });
    logDataAccess(req, {
      action: 'scope_document_generated',
      accessType: 'view',
      entityType: 'project_scope_document',
      projectId: project.id,
      recordCount: scopes.length,
    });
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdf.length),
      'Content-Disposition': contentDisposition('inline', displayName(`Scope of Work - ${project.job_name || project.address || 'Project'}`)),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(pdf);
  } catch (err) {
    console.error('[ScopeDocument] PDF generation failed:', err.message);
    res.status(500).json({ error: 'The scope of work PDF could not be created.' });
  }
});

function loadDocument(db, project, documentId) {
  return db.prepare('SELECT * FROM project_scope_pdfs WHERE id = ? AND project_id = ?').get(documentId, project.id);
}

function documentPath(doc) {
  const root = uploadsRoot();
  const filePath = path.resolve(root, doc.storage_path);
  return filePath.startsWith(path.join(root, STORAGE_DIR) + path.sep) ? filePath : null;
}

// GET /:documentId/file - stream one uploaded version.
router.get('/:documentId/file', (req, res) => {
  const project = loadProject(req, res);
  if (!project) return;
  const db = getDb();
  const doc = loadDocument(db, project, req.params.documentId);
  const filePath = doc ? documentPath(doc) : null;
  if (!doc || !filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Scope of work file not found' });
  logDataAccess(req, {
    action: 'scope_document_viewed',
    accessType: 'download',
    entityType: 'project_scope_document',
    entityId: doc.id,
    projectId: project.id,
    details: { original_name: doc.original_name, size_bytes: doc.size_bytes },
  });
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': contentDisposition('inline', doc.original_name),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
});

// DELETE /:documentId - remove one uploaded version (upper management).
router.delete('/:documentId', (req, res) => {
  const project = loadProject(req, res);
  if (!project) return;
  if (!UPPER_MANAGEMENT_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Only operations managers and super admins can delete a scope of work PDF' });
  }
  const db = getDb();
  const doc = loadDocument(db, project, req.params.documentId);
  if (!doc) return res.status(404).json({ error: 'Scope of work file not found' });
  db.prepare('DELETE FROM project_scope_pdfs WHERE id = ?').run(doc.id);
  const filePath = documentPath(doc);
  try {
    if (filePath) fs.rmSync(filePath, { force: true });
  } catch (err) {
    console.error('[ScopeDocument] Could not remove file:', err.message);
  }
  logActivity({
    userId: req.user.id,
    projectId: project.id,
    action: 'scope_document_deleted',
    entityType: 'project_scope_document',
    entityId: doc.id,
    details: { original_name: doc.original_name },
  });
  res.json(listPayload(db, req, project));
});

module.exports = router;
