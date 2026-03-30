const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate, authorizeProjectAccess } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');

const router = express.Router({ mergeParams: true });
router.use(authenticate);
router.use(authorizeProjectAccess);

// Configure multer storage — photos go into uploads/{projectId}/progress/
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Determine subfolder: 'progress' for progress photos, projectId root for punch list photos
    const subFolder = req.query.type === 'progress' ? 'progress' : '';
    const uploadDir = subFolder
      ? path.join(process.env.UPLOADS_PATH || './uploads', req.params.projectId, subFolder)
      : path.join(process.env.UPLOADS_PATH || './uploads', req.params.projectId);
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    // Embed timestamp in filename for easy sorting
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, `${ts}_${uuidv4()}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = /jpeg|jpg|png|gif|webp|heic|heif/;
  const ext = allowed.test(path.extname(file.originalname).toLowerCase());
  const mime = allowed.test(file.mimetype) || file.mimetype === 'image/heic' || file.mimetype === 'image/heif';
  if (ext || mime) cb(null, true);
  else cb(new Error('Only image files are allowed'));
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB

// GET /api/projects/:projectId/photos
router.get('/', (req, res) => {
  const db = getDb();
  const { category_id, punch_list_item_id } = req.query;
  let query = `
    SELECT ph.*, u.name as uploader_name, pc.name as category_name
    FROM photos ph
    LEFT JOIN users u ON u.id = ph.uploaded_by
    LEFT JOIN photo_categories pc ON pc.id = ph.category_id
    WHERE ph.project_id = ?
  `;
  const params = [req.params.projectId];
  if (category_id) { query += ' AND ph.category_id = ?'; params.push(category_id); }
  if (punch_list_item_id) { query += ' AND ph.punch_list_item_id = ?'; params.push(punch_list_item_id); }
  query += ' ORDER BY ph.created_at DESC';
  res.json(db.prepare(query).all(...params));
});

// GET /api/projects/:projectId/photos/categories
router.get('/categories', (req, res) => {
  const db = getDb();
  const cats = db.prepare('SELECT * FROM photo_categories WHERE project_id = ? ORDER BY name').all(req.params.projectId);
  const enriched = cats.map(c => {
    const cnt = db.prepare('SELECT COUNT(*) as cnt FROM photos WHERE category_id = ?').get(c.id);
    return { ...c, photo_count: cnt.cnt };
  });
  res.json(enriched);
});

// POST /api/projects/:projectId/photos/categories
router.post('/categories', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Category name required' });
  const db = getDb();
  const id = uuidv4();
  db.prepare('INSERT INTO photo_categories (id, project_id, name, created_by) VALUES (?, ?, ?, ?)').run(id, req.params.projectId, name, req.user.id);
  res.status(201).json({ id, name });
});

// GET /api/projects/:projectId/photos/progress — progress photos only
router.get('/progress', (req, res) => {
  const db = getDb();
  const photos = db.prepare(`
    SELECT ph.*, u.name as uploader_name
    FROM photos ph
    LEFT JOIN users u ON u.id = ph.uploaded_by
    WHERE ph.project_id = ? AND ph.photo_type = 'progress'
    ORDER BY ph.taken_at DESC, ph.created_at DESC
  `).all(req.params.projectId);
  res.json(photos);
});

// POST /api/projects/:projectId/photos - upload photos
router.post('/', upload.array('photos', 20), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
    const db = getDb();
    const { category_id, punch_list_item_id, caption } = req.body;
    const photoType = req.query.type === 'progress' ? 'progress' : 'general';
    const takenAt = new Date().toISOString(); // server-side timestamp
    const inserted = [];

    // Determine the file path prefix based on type
    const subFolder = photoType === 'progress' ? 'progress' : '';

    for (const file of req.files) {
      const id = uuidv4();
      // Store relative path including subfolder so we can serve it correctly
      const storedFilename = subFolder ? `progress/${file.filename}` : file.filename;
      db.prepare(`
        INSERT INTO photos (id, project_id, category_id, punch_list_item_id, filename, original_name, mime_type, size, caption, uploaded_by, photo_type, taken_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, req.params.projectId, category_id || null, punch_list_item_id || null, storedFilename, file.originalname, file.mimetype, file.size, caption || null, req.user.id, photoType, takenAt);
      inserted.push({ id, filename: storedFilename, original_name: file.originalname, taken_at: takenAt });
    }

    logActivity({ userId: req.user.id, projectId: req.params.projectId, action: 'photos_uploaded', entityType: 'photo', details: { count: req.files.length, type: photoType } });
    res.status(201).json({ uploaded: inserted.length, photos: inserted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// DELETE /api/projects/:projectId/photos/:id
router.delete('/:id', (req, res) => {
  if (!['super_admin', 'operations_manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const db = getDb();
  const photo = db.prepare('SELECT * FROM photos WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });

  // Delete file from disk
  const filePath = path.join(process.env.UPLOADS_PATH || './uploads', req.params.projectId, photo.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  db.prepare('DELETE FROM photos WHERE id = ?').run(req.params.id);
  logActivity({ userId: req.user.id, projectId: req.params.projectId, action: 'photo_deleted', entityType: 'photo', entityId: req.params.id });
  res.json({ message: 'Photo deleted' });
});

module.exports = router;
