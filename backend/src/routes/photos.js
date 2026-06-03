const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate, authorizeProjectAccess } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { convertHeicUploadToJpeg } = require('../utils/mediaConversion');

const router = express.Router({ mergeParams: true });
router.use(authenticate);
router.use(authorizeProjectAccess);

const PHOTO_TYPES = new Set(['general', 'progress', 'note', 'construction_plan', 'material']);
const CAPTURE_SOURCES = new Set(['batch_camera', 'device_camera', 'library', 'desktop', 'unknown']);
const PHOTO_LABELS = new Set([
  'Before',
  'During',
  'After',
  'Issue',
  'Damage',
  'Inspection',
  'Materials',
  'Progress',
  'Completed Work',
  'Change Order',
  'Safety Concern',
  'Other',
]);
const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.dib',
  '.gif',
  '.heic',
  '.heif',
  '.jpeg',
  '.jpg',
  '.jpe',
  '.jfif',
  '.pjpeg',
  '.pjp',
  '.png',
  '.tif',
  '.tiff',
  '.webp',
  '.dng',
]);
const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.qt',
  '.m4v',
  '.webm',
  '.avi',
  '.mkv',
  '.mpeg',
  '.mpg',
  '.3gp',
  '.3g2',
  '.hevc',
  '.mts',
  '.m2ts',
]);
const configuredMediaMaxMb = Number.parseInt(process.env.PROJECT_MEDIA_MAX_MB || '500', 10);
const MEDIA_FILE_SIZE_LIMIT = (Number.isFinite(configuredMediaMaxMb) ? configuredMediaMaxMb : 500) * 1024 * 1024;
const MAX_PROGRESS_UPLOAD_FILES = 100;

function sanitizePathSegment(value, fallback) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
  return cleaned || fallback;
}

function uploadRoot() {
  return process.env.UPLOADS_PATH || './uploads';
}

function getBatchContext(req) {
  if (req._photoBatchContext) return req._photoBatchContext;
  const now = new Date();
  const batchId = sanitizePathSegment(req.body?.batch_id || req.body?.upload_session_id || uuidv4(), uuidv4());
  req._photoBatchContext = {
    batchId,
    uploadedAt: now.toISOString(),
    year: String(now.getUTCFullYear()),
    month: String(now.getUTCMonth() + 1).padStart(2, '0'),
    stamp: now.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-'),
    sequence: 0,
  };
  return req._photoBatchContext;
}

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

function parseNumberValues(rawValue) {
  if (!rawValue) return [];
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeNumber);
  } catch {
    return [];
  }
}

function normalizeLabel(value) {
  const requested = String(value || '').trim();
  return PHOTO_LABELS.has(requested) ? requested : null;
}

function normalizeCaptureSource(value) {
  const requested = String(value || 'unknown').trim();
  return CAPTURE_SOURCES.has(requested) ? requested : 'unknown';
}

function normalizeTimezone(value) {
  const timezone = String(value || 'UTC').trim().slice(0, 80);
  return timezone || 'UTC';
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
    const batch = getBatchContext(req);
    const uploadDir = path.join(uploadRoot(), req.params.projectId, 'photos', batch.year, batch.month, batch.batchId);
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const batch = getBatchContext(req);
    batch.sequence += 1;
    const requestedSequence = Number.parseInt(req.body?.batch_sequence, 10);
    const sequence = Number.isFinite(requestedSequence) && requestedSequence > 0 ? requestedSequence : batch.sequence;
    const sequenceLabel = String(sequence).padStart(3, '0');
    const projectId = sanitizePathSegment(req.params.projectId, 'project');
    const userId = sanitizePathSegment(req.user?.id || 'user', 'user');
    cb(null, `BuildTrack_Project-${projectId}_User-${userId}_${batch.stamp}_Sequence-${sequenceLabel}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const mime = String(file.mimetype || '').toLowerCase();
  const hasAllowedMediaExtension = IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext);
  const isImage = IMAGE_EXTENSIONS.has(ext) || mime.startsWith('image/') || mime === 'image/heic' || mime === 'image/heif';
  const isVideo = VIDEO_EXTENSIONS.has(ext)
    || mime.startsWith('video/')
    || mime === 'application/mp4'
    || mime === 'application/quicktime'
    || mime === 'application/x-mpegurl'
    || (mime === 'application/octet-stream' && hasAllowedMediaExtension);
  if (isImage || isVideo) cb(null, true);
  else cb(new Error('Only image or video files are allowed'));
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MEDIA_FILE_SIZE_LIMIT,
    files: MAX_PROGRESS_UPLOAD_FILES,
  },
});

function uploadProjectPhotos(req, res, next) {
  upload.array('photos', MAX_PROGRESS_UPLOAD_FILES)(req, res, err => {
    if (!err) return next();
    cleanupUploadedFiles(req.files);
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    let message = err.message || 'Upload rejected';
    if (err.code === 'LIMIT_FILE_SIZE') message = `Each file must be ${configuredMediaMaxMb}MB or less`;
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      message = `Upload up to ${MAX_PROGRESS_UPLOAD_FILES} files at once`;
    }
    return res.status(status).json({ error: message });
  });
}

function cleanupUploadedFiles(files = []) {
  for (const file of files) {
    try {
      if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch (err) {
      console.warn('Failed to clean up rejected upload file:', err.message || err);
    }
  }
}

async function normalizeUploadedMediaFiles(files = []) {
  for (const file of files) {
    try {
      await convertHeicUploadToJpeg(file);
    } catch (err) {
      console.warn(`Failed to convert HEIC upload ${file?.originalname || file?.filename || ''}:`, err.message || err);
    }
  }
}

// GET /api/projects/:projectId/photos
router.get('/', (req, res) => {
  const db = getDb();
  const {
    category_id,
    punch_list_item_id,
    note_id,
    construction_plan_item_id,
    material_id,
    type,
    photo_type,
    label,
    uploaded_by,
    date_from,
    date_to,
    sort,
  } = req.query;
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
  if (label) { query += ' AND ph.label = ?'; params.push(String(label)); }
  if (uploaded_by) { query += ' AND ph.uploaded_by = ?'; params.push(String(uploaded_by)); }
  if (date_from) {
    query += " AND datetime(COALESCE(ph.captured_at, ph.taken_at, ph.uploaded_at, ph.created_at)) >= datetime(?)";
    params.push(String(date_from));
  }
  if (date_to) {
    query += " AND datetime(COALESCE(ph.captured_at, ph.taken_at, ph.uploaded_at, ph.created_at)) <= datetime(?)";
    params.push(String(date_to));
  }
  const sortDirection = String(sort || 'newest') === 'oldest' ? 'ASC' : 'DESC';
  query += ` ORDER BY datetime(COALESCE(ph.captured_at, ph.taken_at, ph.uploaded_at, ph.created_at)) ${sortDirection}, ph.created_at ${sortDirection}`;
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
    ORDER BY datetime(COALESCE(ph.captured_at, ph.taken_at, ph.uploaded_at, ph.created_at)) DESC, ph.created_at DESC
  `).all(req.params.projectId);
  res.json(photos);
});

// POST /api/projects/:projectId/photos - upload project media
router.post('/', uploadProjectPhotos, async (req, res) => {
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
      batch_id,
      batch_note,
      individual_note,
      individual_note_values,
      label,
      label_values,
      timezone,
      captured_at,
      captured_at_values,
      gps_latitude,
      gps_longitude,
      gps_accuracy,
      gps_latitude_values,
      gps_longitude_values,
      gps_accuracy_values,
      batch_sequence,
    } = req.body;
    const photoType = construction_plan_item_id ? 'construction_plan'
      : material_id ? 'material'
      : normalizePhotoType(req.query.type || photo_type || (note_id ? 'note' : 'general'));
    const fallbackTakenAt = normalizeTakenAt(taken_at) || new Date().toISOString();
    const perFileTakenAt = parseTakenAtValues(taken_at_values);
    const perFileCapturedAt = parseTakenAtValues(captured_at_values);
    const perFileCaptureSource = parseStringValues(capture_source_values);
    const perFileNotes = parseStringValues(individual_note_values);
    const perFileLabels = parseStringValues(label_values);
    const perFileGpsLatitudes = parseNumberValues(gps_latitude_values);
    const perFileGpsLongitudes = parseNumberValues(gps_longitude_values);
    const perFileGpsAccuracies = parseNumberValues(gps_accuracy_values);
    const uploadIpAddress = getClientIp(req);
    const uploadUserAgent = String(req.headers['user-agent'] || '').slice(0, 500);
    const latitude = normalizeNumber(gps_latitude ?? capture_latitude);
    const longitude = normalizeNumber(gps_longitude ?? capture_longitude);
    const accuracy = normalizeNumber(gps_accuracy ?? capture_accuracy);
    const recordedAt = normalizeTakenAt(capture_recorded_at) || new Date().toISOString();
    const batch = getBatchContext(req);
    const batchId = batch.batchId;
    const sessionId = String(upload_session_id || batchId).slice(0, 120);
    const uploadTimezone = normalizeTimezone(timezone);
    const uploadedAt = new Date().toISOString();
    const sharedBatchNote = String(batch_note || '').trim().slice(0, 2000) || null;
    const sharedLabel = normalizeLabel(label);
    const projectRoot = path.resolve(uploadRoot(), req.params.projectId);
    const inserted = [];

    if (note_id) {
      const note = db.prepare('SELECT id FROM project_notes WHERE id = ? AND project_id = ?').get(note_id, req.params.projectId);
      if (!note) {
        cleanupUploadedFiles(req.files);
        return res.status(400).json({ error: 'Note not found for this project' });
      }
    }
    if (construction_plan_item_id) {
      const item = db.prepare('SELECT id FROM construction_plan_items WHERE id = ? AND project_id = ?').get(construction_plan_item_id, req.params.projectId);
      if (!item) {
        cleanupUploadedFiles(req.files);
        return res.status(400).json({ error: 'Construction plan item not found for this project' });
      }
    }
    if (material_id) {
      const material = db.prepare('SELECT id FROM construction_materials WHERE id = ? AND project_id = ?').get(material_id, req.params.projectId);
      if (!material) {
        cleanupUploadedFiles(req.files);
        return res.status(400).json({ error: 'Material not found for this project' });
      }
    }

    await normalizeUploadedMediaFiles(req.files);

    for (const [index, file] of req.files.entries()) {
      const id = uuidv4();
      const storedFilename = path.relative(projectRoot, file.path).replace(/\\/g, '/');
      const capturedAt = perFileCapturedAt[index] || normalizeTakenAt(captured_at) || perFileTakenAt[index] || fallbackTakenAt;
      const takenAt = perFileTakenAt[index] || capturedAt || fallbackTakenAt;
      const source = normalizeCaptureSource(perFileCaptureSource[index] || capture_source);
      const photoLabel = normalizeLabel(perFileLabels[index]) || sharedLabel;
      const note = (perFileNotes[index] || individual_note || '').trim().slice(0, 2000) || null;
      const gpsLatitude = perFileGpsLatitudes[index] ?? latitude;
      const gpsLongitude = perFileGpsLongitudes[index] ?? longitude;
      const gpsAccuracy = perFileGpsAccuracies[index] ?? accuracy;
      const sequence = Number.isFinite(Number(batch_sequence)) && req.files.length === 1
        ? Number(batch_sequence)
        : index + 1;
      db.prepare(`
        INSERT INTO photos (
          id, project_id, category_id, punch_list_item_id, note_id, construction_plan_item_id, material_id,
          filename, original_name, mime_type, size, caption, uploaded_by, photo_type, taken_at,
          upload_ip_address, upload_user_agent, capture_latitude, capture_longitude, capture_accuracy,
          capture_recorded_at, capture_source, upload_session_id, batch_id, batch_sequence,
          stored_file_name, storage_path, thumbnail_path, captured_at, uploaded_at, timezone,
          label, batch_note, individual_note, gps_latitude, gps_longitude, gps_accuracy,
          upload_status, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, req.params.projectId, category_id || null, punch_list_item_id || null, note_id || null, construction_plan_item_id || null, material_id || null,
        storedFilename, file.originalname, file.mimetype, file.size, note || sharedBatchNote || caption || null, req.user.id, photoType, takenAt,
        uploadIpAddress, uploadUserAgent, gpsLatitude, gpsLongitude, gpsAccuracy, recordedAt, source, sessionId, batchId, sequence,
        file.filename, storedFilename, null, capturedAt, uploadedAt, uploadTimezone,
        photoLabel, sharedBatchNote, note, gpsLatitude, gpsLongitude, gpsAccuracy,
        'uploaded', uploadedAt
      );
      inserted.push({
        id,
        filename: storedFilename,
        original_name: file.originalname,
        stored_file_name: file.filename,
        storage_path: storedFilename,
        thumbnail_path: null,
        taken_at: takenAt,
        captured_at: capturedAt,
        uploaded_at: uploadedAt,
        timezone: uploadTimezone,
        note_id: note_id || null,
        label: photoLabel,
        batch_id: batchId,
        batch_note: sharedBatchNote,
        individual_note: note,
        upload_status: 'uploaded',
        capture_source: source,
      });
    }

    if (construction_plan_item_id) {
      db.prepare(`
        UPDATE construction_plan_items
        SET last_field_update_at = datetime('now'),
            verification_status = CASE
              WHEN verification_status = 'approved' THEN verification_status
              ELSE 'pending_review'
            END,
            status = CASE
              WHEN status = 'not_started' THEN 'in_progress'
              ELSE status
            END,
            updated_at = datetime('now')
        WHERE id = ? AND project_id = ?
      `).run(construction_plan_item_id, req.params.projectId);
      logActivity({
        userId: req.user.id,
        projectId: req.params.projectId,
        action: 'field_work_evidence_uploaded',
        entityType: 'construction_plan_item',
        entityId: construction_plan_item_id,
        details: { photo_count: inserted.length },
      });
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
        batch_id: batchId,
        label: sharedLabel,
      },
    });
    res.status(201).json({ uploaded: inserted.length, batch_id: batchId, photos: inserted });
  } catch (err) {
    cleanupUploadedFiles(req.files);
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
