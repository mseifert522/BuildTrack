const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { getDb } = require('../db/schema');
const { authenticate, PROJECT_MANAGE_ROLES, UPPER_MANAGEMENT_ROLES } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { logDataAccess } = require('../utils/dataAccessAudit');

const router = express.Router();
router.use(authenticate);
const DOCUMENT_TYPES = new Set(['invoices', 'quotes', 'other_documents', 'insurance_documents']);

function canAccessProject(db, user, projectId) {
  if (PROJECT_MANAGE_ROLES.includes(user.role)) return true;
  if (user.role !== 'contractor') return false;
  const assignment = db.prepare('SELECT id FROM project_assignments WHERE project_id = ? AND user_id = ?').get(projectId, user.id);
  return !!assignment;
}

function requireProject(req, res) {
  const db = getDb();
  const project = db.prepare('SELECT id, address, job_name, status FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  if (!canAccessProject(db, req.user, project.id)) {
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  return project;
}

function uploadRoot(projectId) {
  return path.join(process.env.UPLOADS_PATH || './uploads', 'documents', projectId);
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const uploadDir = uploadRoot(req.params.projectId);
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, `${ts}_${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: Math.max(Number.parseInt(process.env.MAX_FILE_SIZE_MB || '20', 10), 1) * 1024 * 1024 },
});

router.get('/', (req, res) => {
  const db = getDb();
  const projectRows = PROJECT_MANAGE_ROLES.includes(req.user.role)
    ? db.prepare(`
        SELECT id, address, job_name, status
        FROM projects
        WHERE status != 'archived'
        ORDER BY address
      `).all()
    : db.prepare(`
        SELECT p.id, p.address, p.job_name, p.status
        FROM projects p
        JOIN project_assignments pa ON pa.project_id = p.id AND pa.user_id = ?
        WHERE p.status != 'archived'
        ORDER BY p.address
      `).all(req.user.id);

  const projectIds = projectRows.map(project => project.id);
  const docsByProject = new Map();
  if (projectIds.length > 0) {
    const placeholders = projectIds.map(() => '?').join(',');
    const docs = db.prepare(`
      SELECT d.*, u.name as uploaded_by_name
      FROM project_documents d
      LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.project_id IN (${placeholders})
      ORDER BY datetime(d.created_at) DESC, d.created_at DESC
    `).all(...projectIds);
    for (const doc of docs) {
      const rows = docsByProject.get(doc.project_id) || [];
      rows.push(doc);
      docsByProject.set(doc.project_id, rows);
    }
  }

  const documentCount = Array.from(docsByProject.values()).reduce((sum, docs) => sum + docs.length, 0);
  logDataAccess(req, {
    action: 'documents_index_viewed',
    accessType: 'view',
    entityType: 'project_document',
    recordCount: documentCount,
    riskLevel: 'high',
    details: { project_count: projectRows.length },
  });

  res.json({
    projects: projectRows.map(project => ({
      ...project,
      documents: docsByProject.get(project.id) || [],
    })),
  });
});

router.get('/:projectId', (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const db = getDb();
  const docs = db.prepare(`
    SELECT d.*, u.name as uploaded_by_name
    FROM project_documents d
    LEFT JOIN users u ON u.id = d.uploaded_by
    WHERE d.project_id = ?
    ORDER BY datetime(d.created_at) DESC, d.created_at DESC
  `).all(project.id);
  logDataAccess(req, {
    action: 'project_documents_viewed',
    accessType: 'view',
    entityType: 'project_document',
    projectId: project.id,
    recordCount: docs.length,
    riskLevel: 'high',
    details: { address: project.address, job_name: project.job_name },
  });
  res.json({ project, documents: docs });
});

router.post('/:projectId', (req, res, next) => {
  const project = requireProject(req, res);
  if (!project) return;
  if (!PROJECT_MANAGE_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Only management can upload documents' });
  }
  req.project = project;
  next();
}, upload.array('documents', 20), (req, res) => {
  const project = req.project;
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  const db = getDb();
  const requestedDocumentType = String(req.body.document_type || '').trim();
  const documentType = DOCUMENT_TYPES.has(requestedDocumentType) ? requestedDocumentType : 'other_documents';
  const inserted = [];
  for (const file of req.files) {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO project_documents (id, project_id, filename, original_name, mime_type, size, document_type, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, project.id, file.filename, file.originalname, file.mimetype, file.size, documentType, req.user.id);
    inserted.push({ id, project_id: project.id, filename: file.filename, original_name: file.originalname, mime_type: file.mimetype, size: file.size, document_type: documentType });
  }

  logActivity({
    userId: req.user.id,
    projectId: project.id,
    action: 'documents_uploaded',
    entityType: 'project_document',
    details: { count: inserted.length },
  });
  res.status(201).json({ uploaded: inserted.length, documents: inserted });
});

router.get('/:projectId/:documentId/download', (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const db = getDb();
  const doc = db.prepare('SELECT * FROM project_documents WHERE id = ? AND project_id = ?').get(req.params.documentId, project.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const root = path.resolve(uploadRoot(project.id));
  const filePath = path.resolve(root, doc.filename);
  if (!filePath.startsWith(root) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Document file not found' });
  }
  logDataAccess(req, {
    action: 'project_document_downloaded',
    accessType: 'download',
    entityType: 'project_document',
    entityId: doc.id,
    projectId: project.id,
    riskLevel: 'high',
    details: {
      original_name: doc.original_name,
      document_type: doc.document_type,
      mime_type: doc.mime_type,
      size: doc.size,
      address: project.address,
      job_name: project.job_name,
    },
  });
  res.download(filePath, doc.original_name);
});

router.delete('/:projectId/:documentId', (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  if (!UPPER_MANAGEMENT_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Only operations managers and super admins can delete documents' });
  }

  const db = getDb();
  const doc = db.prepare('SELECT * FROM project_documents WHERE id = ? AND project_id = ?').get(req.params.documentId, project.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const filePath = path.join(uploadRoot(project.id), doc.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  db.prepare('DELETE FROM project_documents WHERE id = ?').run(doc.id);
  logActivity({ userId: req.user.id, projectId: project.id, action: 'document_deleted', entityType: 'project_document', entityId: doc.id });
  res.json({ message: 'Document deleted' });
});

module.exports = router;
