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

const PHOTO_TYPES = new Set(['general', 'progress', 'note', 'construction_plan', 'material']);
const CAPTURE_SOURCES = new Set(['batch_camera', 'device_camera', 'library', 'desktop', 'unknown']);
const IMAGE_EXTENSIONS = new Set(['.jpeg', '.jpg', '.png', '.gif', '.webp', '.heic', '.heif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv', '.mpeg', '.mpg', '.3gp']);
const configuredMediaMaxMb = Number.parseInt(process.env.PROJECT_MEDIA_MAX_MB || '500', 10);
const MEDIA_FILE_SIZE_LIMIT = (Number.isFinite(configuredMediaMaxMb) ? configuredMediaMaxMb : 500) * 1024 * 1024;

function normalizePhotoType(value) {
  const requested = String(value || 'general').trim();
  return PHOTO_TYPES.has(requested) ? requested : 'general';
}

function normalizeTakenAt(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parseTakenAtValues(rawValue) {
  if (!rawValue) return [];
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeTakenAt);
  } catch {
    return [];
  }
}

function parseStringValues(rawValue) {
  if (!rawValue) return [];
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(value => String(value || '').trim());
  } catch {
    return [];
  }
}

function normalizeCaptureSource(value) {
  const requested = String(value || 'unknown').trim();
  return CAPTURE_SOURCES.has(requested) ? requested : 'unknown';
}

function normalizeNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getClientIp(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return forwardedFor[0]
    || String(req.headers['x-real-ip'] || '').trim()
    || req.ip
    || req.socket?.remoteAddress
    || '';
}

// Configure multer storage — photos go into uploads/{projectId}/progress/
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Determine subfolder: 'progress' for progress photos, projectId root for punch list photos
    const subFolder = normalizePhotoType(req.query.type) === 'progress' ? 'progress' : '';
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
  const ext = path.extname(file.originalname).toLowerCase();
  const mime = String(file.mimetype || '').toLowerCase();
  const isImage = IMAGE_EXTENSIONS.has(ext) || mime.startsWith('image/') || mime === 'image/heic' || mime === 'image/heif';
  const isVideo = VIDEO_EXTENSIONS.has(ext) || mime.startsWith('video/') || mime === 'application/mp4' || mime === 'application/quicktime';
  if (isImage || isVideo) cb(null, true);
  else cb(new Error('Only image or video files are allowed'));
};

const upload = multer({ storage, fileFilter, limits: { fileSize: MEDIA_FILE_SIZE_LIMIT, files: 20 } });

// GET /api/projects/:projectId/photos
router.get('/', (req, res) => {
  const db = getDb();
  const { category_id, punch_list_item_id, note_id, construction_plan_item_id, material_id, type, photo_type } = req.query;
  let query = `
    SELECT
      ph.*,
      u.name as uploader_name,
      pc.name as category_name,
      n.note as note_text,
      n.note_type as note_type,
      n.created_at as note_created_at,
      nu.name as note_user_name
    FROM photos ph
    LEFT JOIN users u ON u.id = ph.uploaded_by
    LEFT JOIN photo_categories pc ON pc.id = ph.category_id
    LEFT JOIN project_notes n ON n.id = ph.note_id
    LEFT JOIN users nu ON nu.id = n.user_id
    WHERE ph.project_id = ?
  `;
  const params = [req.params.projectId];
  if (category_id) { query += ' AND ph.category_id = ?'; params.push(category_id); }
  if (punch_list_item_id) { query += ' AND ph.punch_list_item_id = ?'; params.push(punch_list_item_id); }
  if (note_id) { query += ' AND ph.note_id = ?'; params.push(note_id); }
  if (construction_plan_item_id) { query += ' AND ph.construction_plan_item_id = ?'; params.push(construction_plan_item_id); }
  if (material_id) { query += ' AND ph.material_id = ?'; params.push(material_id); }
  if (type || photo_type) { query += ' AND ph.photo_type = ?'; params.push(normalizePhotoType(type || photo_type)); }
  query += ' ORDER BY datetime(COALESCE(ph.taken_at, ph.created_at)) DESC, ph.created_at DESC';
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
    SELECT
      ph.*,
      u.name as uploader_name,
      n.note as note_text,
      n.note_type as note_type,
      n.created_at as note_created_at,
      nu.name as note_user_name
    FROM photos ph
    LEFT JOIN users u ON u.id = ph.uploaded_by
    LEFT JOIN project_notes n ON n.id = ph.note_id
    LEFT JOIN users nu ON nu.id = n.user_id
    WHERE ph.project_id = ? AND ph.photo_type = 'progress'
    ORDER BY ph.taken_at DESC, ph.created_at DESC
  `).all(req.params.projectId);
  res.json(photos);
});

// POST /api/projects/:projectId/photos - upload project media
router.post('/', upload.array('photos', 20), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
    const db = getDb();
    const {
      category_id,
      punch_list_item_id,
      note_id,
      construction_plan_item_id,
      material_id,
      caption,
      photo_type,
      taken_at,
      taken_at_values,
      capture_latitude,
      capture_longitude,
      capture_accuracy,
      capture_recorded_at,
      capture_source,
      capture_source_values,
      upload_session_id,
    } = req.body;
    const photoType = construction_plan_item_id ? 'construction_plan'
      : material_id ? 'material'
      : normalizePhotoType(req.query.type || photo_type || (note_id ? 'note' : 'general'));
    const fallbackTakenAt = normalizeTakenAt(taken_at) || new Date().toISOString();
    const perFileTakenAt = parseTakenAtValues(taken_at_values);
    const perFileCaptureSource = parseStringValues(capture_source_values);
    const uploadIpAddress = getClientIp(req);
    const uploadUserAgent = String(req.headers['user-agent'] || '').slice(0, 500);
    const latitude = normalizeNumber(capture_latitude);
    const longitude = normalizeNumber(capture_longitude);
    const accuracy = normalizeNumber(capture_accuracy);
    const recordedAt = normalizeTakenAt(capture_recorded_at) || new Date().toISOString();
    const sessionId = String(upload_session_id || uuidv4()).slice(0, 120);
    const inserted = [];

    if (note_id) {
      const note = db.prepare('SELECT id FROM project_notes WHERE id = ? AND project_id = ?').get(note_id, req.params.projectId);
      if (!note) return res.status(400).json({ error: 'Note not found for this project' });
    }
    if (construction_plan_item_id) {
      const item = db.prepare('SELECT id FROM construction_plan_items WHERE id = ? AND project_id = ?').get(construction_plan_item_id, req.params.projectId);
      if (!item) return res.status(400).json({ error: 'Construction plan item not found for this project' });
    }
    if (material_id) {
      const material = db.prepare('SELECT id FROM construction_materials WHERE id = ? AND project_id = ?').get(material_id, req.params.projectId);
      if (!material) return res.status(400).json({ error: 'Material not found for this project' });
    }

    // Determine the file path prefix based on type
    const subFolder = photoType === 'progress' ? 'progress' : '';

    for (const [index, file] of req.files.entries()) {
      const id = uuidv4();
      // Store relative path including subfolder so we can serve it correctly
      const storedFilename = subFolder ? `progress/${file.filename}` : file.filename;
      const takenAt = perFileTakenAt[index] || fallbackTakenAt;
      const source = normalizeCaptureSource(perFileCaptureSource[index] || capture_source);
      db.prepare(`
        INSERT INTO photos (
          id, project_id, category_id, punch_list_item_id, note_id, construction_plan_item_id, material_id,
          filename, original_name, mime_type, size, caption, uploaded_by, photo_type, taken_at,
          upload_ip_address, upload_user_agent, capture_latitude, capture_longitude, capture_accuracy,
          capture_recorded_at, capture_source, upload_session_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, req.params.projectId, category_id || null, punch_list_item_id || null, note_id || null, construction_plan_item_id || null, material_id || null,
        storedFilename, file.originalname, file.mimetype, file.size, caption || null, req.user.id, photoType, takenAt,
        uploadIpAddress, uploadUserAgent, latitude, longitude, accuracy, recordedAt, source, sessionId
      );
      inserted.push({ id, filename: storedFilename, original_name: file.originalname, taken_at: takenAt, note_id: note_id || null, capture_source: source });
    }

    logActivity({
      userId: req.user.id,
      projectId: req.params.projectId,
      action: 'project_media_uploaded',
      entityType: 'photo',
      details: {
        count: req.files.length,
        type: photoType,
        note_id: note_id || null,
        upload_ip_address: uploadIpAddress,
        has_capture_location: latitude !== null && longitude !== null,
        upload_session_id: sessionId,
      },
    });
    res.status(201).json({ uploaded: inserted.length, photos: inserted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// DELETE /api/projects/:projectId/photos/:id
router.delete('/:id', (req, res) => {
  if (!['super_admin', 'operations_manager', 'project_manager'].includes(req.user.role)) {
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
