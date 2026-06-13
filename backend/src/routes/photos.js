const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate, authorizeProjectAccess } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { recordWorkItemEvent } = require('../utils/workItemEvents');
const { convertHeicUploadToJpeg } = require('../utils/mediaConversion');
const { getClientIp } = require('../utils/requestIp');

const router = express.Router({ mergeParams: true });
router.use(authenticate);
router.use(authorizeProjectAccess);

const PHOTO_TYPES = new Set(['general', 'progress', 'scope', 'note', 'construction_plan', 'material']);
const CAPTURE_SOURCES = new Set(['batch_camera', 'device_camera', 'library', 'desktop', 'unknown']);
const PHOTO_ASSIGNMENT_TARGETS = new Set(['project_scope', 'punch_list_item', 'construction_plan_item', 'material', 'project_note']);
const PHOTO_OVERRIDE_DELETE_ROLES = new Set(['super_admin', 'operations_manager']);
const SELF_CORRECTION_DELETE_PHOTO_TYPES = new Set(['progress', 'scope', 'note', 'construction_plan']);
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

function activePhotoSql(alias = 'ph') {
  return `COALESCE(${alias}.upload_status, 'uploaded') != 'correction_deleted' AND ${alias}.correction_deleted_at IS NULL`;
}

function canUseCorrectionDelete(photo, user) {
  if (!photo || !user) return false;
  if (photo.uploaded_by !== user.id) return false;
  if (!SELF_CORRECTION_DELETE_PHOTO_TYPES.has(String(photo.photo_type || 'general'))) return false;
  if (photo.correction_deleted_at || String(photo.upload_status || 'uploaded') === 'correction_deleted') return false;
  return Number(photo.correction_delete_count || 0) < 1;
}

function withCorrectionDeletePermission(photo, user) {
  return {
    ...photo,
    can_delete_correction: canUseCorrectionDelete(photo, user),
    correction_locked: Number(photo.correction_delete_count || 0) >= 1 || Boolean(photo.correction_deleted_at),
  };
}

function getPhotoWithNote(db, projectId, photoId, user) {
  const photo = db.prepare(`
    SELECT
      ph.*,
      u.name as uploader_name,
      u.avatar_url as uploader_avatar_url,
      pc.name as category_name,
      n.note as note_text,
      n.note_type as note_type,
      n.created_at as note_created_at,
      nu.name as note_user_name,
      nu.avatar_url as note_user_avatar_url
    FROM photos ph
    LEFT JOIN users u ON u.id = ph.uploaded_by
    LEFT JOIN photo_categories pc ON pc.id = ph.category_id
    LEFT JOIN project_notes n ON n.id = ph.note_id
    LEFT JOIN users nu ON nu.id = n.user_id
    WHERE ph.id = ?
      AND ph.project_id = ?
      AND ${activePhotoSql('ph')}
  `).get(photoId, projectId);
  return photo ? withCorrectionDeletePermission(photo, user) : null;
}

function removeStoredPhotoFiles(photo, projectId) {
  const root = path.resolve(uploadRoot(), projectId);
  const candidates = [
    photo.filename,
    photo.storage_path,
    photo.stored_file_name,
    photo.thumbnail_path,
  ].filter(Boolean);

  for (const candidate of new Set(candidates)) {
    const filePath = path.resolve(root, String(candidate));
    if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== root) continue;
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      console.warn('Failed to remove corrected photo file:', err.message || err);
    }
  }
}

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

function parsePhotoContexts(value, fallbackType = 'general') {
  const contexts = new Set(['general']);
  const addContext = raw => {
    const context = String(raw || '').trim().toLowerCase();
    if (context === 'progress') contexts.add('progress');
    if (context === 'scope' || context === 'scope_of_work') contexts.add('scope');
    if (context === 'general') contexts.add('general');
  };

  if (Array.isArray(value)) {
    value.forEach(addContext);
  } else if (value) {
    try {
      const parsed = JSON.parse(String(value));
      if (Array.isArray(parsed)) parsed.forEach(addContext);
      else addContext(parsed);
    } catch {
      String(value).split(',').forEach(addContext);
    }
  }

  const type = normalizePhotoType(fallbackType);
  if (type === 'progress' || type === 'note') contexts.add('progress');
  if (type === 'scope' || type === 'construction_plan') contexts.add('scope');
  return {
    showInGeneral: 1,
    showInProgress: contexts.has('progress') ? 1 : 0,
    showInScope: contexts.has('scope') ? 1 : 0,
    contexts: Array.from(contexts),
  };
}

function appendPhotoTypeFilter(query, params, requestedType) {
  const type = normalizePhotoType(requestedType);
  if (type === 'progress') {
    return `${query} AND COALESCE(ph.show_in_progress, 0) = 1`;
  }
  if (type === 'scope') {
    return `${query} AND COALESCE(ph.show_in_scope, 0) = 1`;
  }
  if (type === 'general') {
    return `${query} AND COALESCE(ph.show_in_general, 1) = 1`;
  }
  params.push(type);
  return `${query} AND ph.photo_type = ?`;
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

function normalizeAssignmentTargetType(value) {
  const requested = String(value || '').trim();
  return PHOTO_ASSIGNMENT_TARGETS.has(requested) ? requested : null;
}

function normalizePhotoIds(value) {
  const raw = Array.isArray(value) ? value : [value];
  return Array.from(new Set(raw.map(id => String(id || '').trim()).filter(Boolean))).slice(0, 100);
}

function assertAssignmentTarget(db, projectId, targetType, targetId) {
  const id = String(targetId || '').trim();
  if (!targetType || !id) {
    const err = new Error('Photo assignment target is required');
    err.statusCode = 400;
    throw err;
  }

  const targetQueries = {
    project_scope: ['SELECT id, scope_title as title FROM project_scopes WHERE id = ? AND project_id = ?', 'Scope of work not found for this project'],
    punch_list_item: ['SELECT id, title FROM punch_list_items WHERE id = ? AND project_id = ?', 'Punch list item not found for this project'],
    construction_plan_item: ['SELECT id, title FROM construction_plan_items WHERE id = ? AND project_id = ?', 'Scope execution line not found for this project'],
    material: ['SELECT id, material_name as title FROM construction_materials WHERE id = ? AND project_id = ?', 'Material not found for this project'],
    project_note: ['SELECT id, note as title FROM project_notes WHERE id = ? AND project_id = ?', 'Project note not found for this project'],
  };
  const [query, message] = targetQueries[targetType] || [];
  if (!query) {
    const err = new Error('Unsupported photo assignment target');
    err.statusCode = 400;
    throw err;
  }

  const target = db.prepare(query).get(id, projectId);
  if (!target) {
    const err = new Error(message);
    err.statusCode = 404;
    throw err;
  }
  return target;
}

function assignedPhotoSelectSql() {
  return `
    SELECT
      pa.id as assignment_id,
      pa.target_type,
      pa.target_id,
      pa.note as assignment_note,
      pa.created_at as assigned_at,
      au.name as assigned_by_name,
      ph.*,
      u.name as uploader_name,
      u.avatar_url as uploader_avatar_url,
      pc.name as category_name,
      n.note as note_text,
      n.note_type as note_type,
      n.created_at as note_created_at,
      nu.name as note_user_name,
      nu.avatar_url as note_user_avatar_url
    FROM photo_assignments pa
    JOIN photos ph ON ph.id = pa.photo_id
    LEFT JOIN users au ON au.id = pa.created_by
    LEFT JOIN users u ON u.id = ph.uploaded_by
    LEFT JOIN photo_categories pc ON pc.id = ph.category_id
    LEFT JOIN project_notes n ON n.id = ph.note_id
    LEFT JOIN users nu ON nu.id = n.user_id
    WHERE pa.project_id = ?
      AND pa.target_type = ?
      AND pa.target_id = ?
      AND ph.project_id = pa.project_id
      AND ${activePhotoSql('ph')}
    ORDER BY datetime(pa.created_at) DESC, datetime(COALESCE(ph.captured_at, ph.taken_at, ph.uploaded_at, ph.created_at)) DESC
  `;
}

function getPhotoAssignments(db, projectId, targetType, targetId, user) {
  return db.prepare(assignedPhotoSelectSql())
    .all(projectId, targetType, targetId)
    .map(photo => withCorrectionDeletePermission(photo, user));
}

function createPhotoAssignments(db, { projectId, targetType, targetId, photoIds, note, user }) {
  const target = assertAssignmentTarget(db, projectId, targetType, targetId);
  const ids = normalizePhotoIds(photoIds);
  if (!ids.length) {
    const err = new Error('Select at least one photo');
    err.statusCode = 400;
    throw err;
  }

  const placeholders = ids.map(() => '?').join(',');
  const validPhotos = db.prepare(`
    SELECT id
    FROM photos ph
    WHERE ph.project_id = ?
      AND ph.id IN (${placeholders})
      AND ${activePhotoSql('ph')}
  `).all(projectId, ...ids);
  if (validPhotos.length !== ids.length) {
    const err = new Error('One or more selected photos are not in this project');
    err.statusCode = 400;
    throw err;
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO photo_assignments (
      id, project_id, photo_id, target_type, target_id, note, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const cleanNote = String(note || '').trim().slice(0, 1000) || null;
  const inserted = [];
  const tx = db.transaction(() => {
    for (const photoId of ids) {
      const assignmentId = uuidv4();
      const result = insert.run(assignmentId, projectId, photoId, targetType, targetId, cleanNote, user.id);
      if (result.changes > 0) inserted.push(assignmentId);
    }
  });
  tx();
  return { target, inserted };
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
      u.avatar_url as uploader_avatar_url,
      pc.name as category_name,
      n.note as note_text,
      n.note_type as note_type,
      n.created_at as note_created_at,
      nu.name as note_user_name,
      nu.avatar_url as note_user_avatar_url
    FROM photos ph
    LEFT JOIN users u ON u.id = ph.uploaded_by
    LEFT JOIN photo_categories pc ON pc.id = ph.category_id
    LEFT JOIN project_notes n ON n.id = ph.note_id
    LEFT JOIN users nu ON nu.id = n.user_id
    WHERE ph.project_id = ?
      AND ${activePhotoSql('ph')}
  `;
  const params = [req.params.projectId];
  if (category_id) { query += ' AND ph.category_id = ?'; params.push(category_id); }
  if (punch_list_item_id) { query += ' AND ph.punch_list_item_id = ?'; params.push(punch_list_item_id); }
  if (note_id) { query += ' AND ph.note_id = ?'; params.push(note_id); }
  if (construction_plan_item_id) { query += ' AND ph.construction_plan_item_id = ?'; params.push(construction_plan_item_id); }
  if (material_id) { query += ' AND ph.material_id = ?'; params.push(material_id); }
  if (type || photo_type) query = appendPhotoTypeFilter(query, params, type || photo_type);
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
  res.json(db.prepare(query).all(...params).map(photo => withCorrectionDeletePermission(photo, req.user)));
});

// GET /api/projects/:projectId/photos/categories
router.get('/categories', (req, res) => {
  const db = getDb();
  const cats = db.prepare('SELECT * FROM photo_categories WHERE project_id = ? ORDER BY name').all(req.params.projectId);
  const enriched = cats.map(c => {
    const cnt = db.prepare(`SELECT COUNT(*) as cnt FROM photos WHERE category_id = ? AND ${activePhotoSql('photos')}`).get(c.id);
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

// GET /api/projects/:projectId/photos/assignments?target_type=project_scope&target_id=...
router.get('/assignments', (req, res) => {
  try {
    const db = getDb();
    const targetType = normalizeAssignmentTargetType(req.query.target_type);
    const targetId = String(req.query.target_id || '').trim();
    assertAssignmentTarget(db, req.params.projectId, targetType, targetId);
    res.json({
      photos: getPhotoAssignments(db, req.params.projectId, targetType, targetId, req.user),
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to load assigned photos' });
  }
});

// POST /api/projects/:projectId/photos/assignments - reuse existing bucket photos on a project record
router.post('/assignments', (req, res) => {
  try {
    const db = getDb();
    const targetType = normalizeAssignmentTargetType(req.body?.target_type);
    const targetId = String(req.body?.target_id || '').trim();
    const result = createPhotoAssignments(db, {
      projectId: req.params.projectId,
      targetType,
      targetId,
      photoIds: req.body?.photo_ids,
      note: req.body?.note,
      user: req.user,
    });

    logActivity({
      userId: req.user.id,
      projectId: req.params.projectId,
      action: 'photo_assigned',
      entityType: targetType,
      entityId: targetId,
      details: {
        target_title: result.target.title || null,
        added_count: result.inserted.length,
        selected_count: normalizePhotoIds(req.body?.photo_ids).length,
      },
    });

    res.status(201).json({
      added: result.inserted.length,
      photos: getPhotoAssignments(db, req.params.projectId, targetType, targetId, req.user),
    });
  } catch (err) {
    console.error('Failed to assign photos:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to assign photos' });
  }
});

// DELETE /api/projects/:projectId/photos/assignments/:assignmentId
router.delete('/assignments/:assignmentId', (req, res) => {
  try {
    const db = getDb();
    const assignment = db.prepare(`
      SELECT *
      FROM photo_assignments
      WHERE id = ? AND project_id = ?
    `).get(req.params.assignmentId, req.params.projectId);
    if (!assignment) return res.status(404).json({ error: 'Photo assignment not found' });

    db.prepare('DELETE FROM photo_assignments WHERE id = ? AND project_id = ?').run(req.params.assignmentId, req.params.projectId);
    logActivity({
      userId: req.user.id,
      projectId: req.params.projectId,
      action: 'photo_assignment_removed',
      entityType: assignment.target_type,
      entityId: assignment.target_id,
      details: { photo_id: assignment.photo_id },
    });
    res.json({ message: 'Photo removed from this item' });
  } catch (err) {
    console.error('Failed to remove assigned photo:', err);
    res.status(500).json({ error: 'Failed to remove assigned photo' });
  }
});

// GET /api/projects/:projectId/photos/progress — progress photos only
router.get('/progress', (req, res) => {
  const db = getDb();
  const photos = db.prepare(`
    SELECT
      ph.*,
      u.name as uploader_name,
      u.avatar_url as uploader_avatar_url,
      n.note as note_text,
      n.note_type as note_type,
      n.created_at as note_created_at,
      nu.name as note_user_name,
      nu.avatar_url as note_user_avatar_url
    FROM photos ph
    LEFT JOIN users u ON u.id = ph.uploaded_by
    LEFT JOIN project_notes n ON n.id = ph.note_id
    LEFT JOIN users nu ON nu.id = n.user_id
    WHERE ph.project_id = ? AND COALESCE(ph.show_in_progress, 0) = 1
      AND ${activePhotoSql('ph')}
    ORDER BY datetime(COALESCE(ph.captured_at, ph.taken_at, ph.uploaded_at, ph.created_at)) DESC, ph.created_at DESC
  `).all(req.params.projectId).map(photo => withCorrectionDeletePermission(photo, req.user));
  res.json(photos);
});

// POST /api/projects/:projectId/photos - upload project media
router.post('/', uploadProjectPhotos, async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
    const db = getDb();
    const {
      punch_list_item_id,
      note_id,
      construction_plan_item_id,
      material_id,
      caption,
      capture_project_id,
      client_project_id,
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
	      photo_contexts,
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
	    const usage = parsePhotoContexts(photo_contexts, photoType);
	    const projectRoot = path.resolve(uploadRoot(), req.params.projectId);
    const inserted = [];
    const requestedProjectContext = String(capture_project_id || client_project_id || '').trim();

    if (requestedProjectContext && requestedProjectContext !== String(req.params.projectId)) {
      cleanupUploadedFiles(req.files);
      return res.status(409).json({ error: 'Photo project context changed. Reopen this project and try again.' });
    }

    if (note_id) {
      const note = db.prepare('SELECT id FROM project_notes WHERE id = ? AND project_id = ?').get(note_id, req.params.projectId);
      if (!note) {
        cleanupUploadedFiles(req.files);
        return res.status(400).json({ error: 'Note not found for this project' });
      }
    }
    if (punch_list_item_id) {
      const punchItem = db.prepare('SELECT id FROM punch_list_items WHERE id = ? AND project_id = ?').get(punch_list_item_id, req.params.projectId);
      if (!punchItem) {
        cleanupUploadedFiles(req.files);
        return res.status(400).json({ error: 'Punch list item not found for this project' });
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
	          filename, original_name, mime_type, size, caption, uploaded_by, photo_type,
	          show_in_general, show_in_progress, show_in_scope, taken_at,
	          upload_ip_address, upload_user_agent, capture_latitude, capture_longitude, capture_accuracy,
          capture_recorded_at, capture_source, upload_session_id, batch_id, batch_sequence,
          stored_file_name, storage_path, thumbnail_path, captured_at, uploaded_at, timezone,
          label, batch_note, individual_note, gps_latitude, gps_longitude, gps_accuracy,
          upload_status, updated_at
        )
	        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	      `).run(
	        id, req.params.projectId, null, punch_list_item_id || null, note_id || null, construction_plan_item_id || null, material_id || null,
	        storedFilename, file.originalname, file.mimetype, file.size, note || sharedBatchNote || caption || null, req.user.id, photoType,
	        usage.showInGeneral, usage.showInProgress, usage.showInScope, takenAt,
	        uploadIpAddress, uploadUserAgent, gpsLatitude, gpsLongitude, gpsAccuracy, recordedAt, source, sessionId, batchId, sequence,
        file.filename, storedFilename, null, capturedAt, uploadedAt, uploadTimezone,
        photoLabel, sharedBatchNote, note, gpsLatitude, gpsLongitude, gpsAccuracy,
        'uploaded', uploadedAt
      );
      inserted.push({
        id,
        project_id: req.params.projectId,
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
        upload_ip_address: uploadIpAddress,
        upload_user_agent: uploadUserAgent,
        capture_latitude: gpsLatitude,
        capture_longitude: gpsLongitude,
        capture_accuracy: gpsAccuracy,
        capture_recorded_at: recordedAt,
        gps_latitude: gpsLatitude,
        gps_longitude: gpsLongitude,
        gps_accuracy: gpsAccuracy,
        upload_status: 'uploaded',
        capture_source: source,
        photo_type: photoType,
        show_in_general: usage.showInGeneral,
        show_in_progress: usage.showInProgress,
        show_in_scope: usage.showInScope,
      });
    }

    const uploadedPhotoIds = inserted.map(photo => photo.id);
    if (punch_list_item_id) {
      createPhotoAssignments(db, {
        projectId: req.params.projectId,
        targetType: 'punch_list_item',
        targetId: punch_list_item_id,
        photoIds: uploadedPhotoIds,
        note: sharedBatchNote || caption || null,
        user: req.user,
      });
    }
    if (construction_plan_item_id) {
      createPhotoAssignments(db, {
        projectId: req.params.projectId,
        targetType: 'construction_plan_item',
        targetId: construction_plan_item_id,
        photoIds: uploadedPhotoIds,
        note: sharedBatchNote || caption || null,
        user: req.user,
      });
    }
    if (material_id) {
      createPhotoAssignments(db, {
        projectId: req.params.projectId,
        targetType: 'material',
        targetId: material_id,
        photoIds: uploadedPhotoIds,
        note: sharedBatchNote || caption || null,
        user: req.user,
      });
    }

    if (construction_plan_item_id) {
      const beforeItem = db.prepare('SELECT * FROM construction_plan_items WHERE id = ? AND project_id = ?').get(construction_plan_item_id, req.params.projectId);
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
      const afterItem = db.prepare('SELECT * FROM construction_plan_items WHERE id = ? AND project_id = ?').get(construction_plan_item_id, req.params.projectId);
      if (beforeItem && afterItem) {
        recordWorkItemEvent(db, {
          projectId: req.params.projectId,
          itemId: construction_plan_item_id,
          actor: req.user,
          eventType: 'evidence_uploaded',
          before: beforeItem,
          after: afterItem,
          comment: sharedBatchNote || inserted.find(photo => photo.individual_note)?.individual_note || caption || null,
          evidenceSummary: {
            photo_count: inserted.length,
            photo_ids: inserted.map(photo => photo.id),
          },
        });
      }
      logActivity({
        userId: req.user.id,
        projectId: req.params.projectId,
        action: 'field_work_evidence_uploaded',
        entityType: 'construction_plan_item',
        entityId: construction_plan_item_id,
        details: {
          photo_count: inserted.length,
          note: sharedBatchNote || inserted.find(photo => photo.individual_note)?.individual_note || caption || null,
        },
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
	        contexts: usage.contexts,
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

// PUT /api/projects/:projectId/photos/batch-note - update the note shown above a mobile media batch
router.put('/batch-note', (req, res) => {
  const db = getDb();
  const rawIds = Array.isArray(req.body?.photo_ids) ? req.body.photo_ids : [];
  const photoIds = Array.from(new Set(rawIds.map(id => String(id || '').trim()).filter(Boolean)));
  if (!photoIds.length) return res.status(400).json({ error: 'Select at least one project picture' });
  if (photoIds.length > MAX_PROGRESS_UPLOAD_FILES) return res.status(400).json({ error: 'Too many project pictures selected' });

  const noteText = String(req.body?.note || '').trim().slice(0, 2000);
  const now = new Date().toISOString();

  try {
    const placeholders = photoIds.map(() => '?').join(',');
    const photos = db.prepare(`
      SELECT id
      FROM photos
      WHERE project_id = ?
        AND id IN (${placeholders})
        AND ${activePhotoSql('photos')}
    `).all(req.params.projectId, ...photoIds);
    if (photos.length !== photoIds.length) return res.status(400).json({ error: 'One or more project pictures are invalid' });

    db.prepare(`
      UPDATE photos
      SET batch_note = ?,
          updated_at = ?
      WHERE project_id = ?
        AND id IN (${placeholders})
        AND ${activePhotoSql('photos')}
    `).run(noteText || null, now, req.params.projectId, ...photoIds);

    logActivity({
      userId: req.user.id,
      projectId: req.params.projectId,
      action: noteText ? 'project_media_batch_note_saved' : 'project_media_batch_note_cleared',
      entityType: 'photo',
      details: {
        photo_count: photoIds.length,
        has_note: Boolean(noteText),
      },
    });

    const updatedPhotos = db.prepare(`
      SELECT id, batch_note, updated_at
      FROM photos
      WHERE project_id = ?
        AND id IN (${placeholders})
        AND ${activePhotoSql('photos')}
      ORDER BY datetime(COALESCE(captured_at, taken_at, uploaded_at, created_at)) DESC, created_at DESC
    `).all(req.params.projectId, ...photoIds);

    res.json({ photos: updatedPhotos, note: noteText });
  } catch (err) {
    console.error('Failed to save progress picture group note:', err);
    res.status(500).json({ error: 'Failed to save progress picture group note' });
  }
});

// PUT /api/projects/:projectId/photos/:id/contexts - reuse one uploaded photo in progress/scope views
router.put('/:id/contexts', (req, res) => {
  const db = getDb();
  const photo = db.prepare(`
    SELECT *
    FROM photos
    WHERE id = ? AND project_id = ? AND ${activePhotoSql('photos')}
  `).get(req.params.id, req.params.projectId);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });

  const requestedContexts = req.body?.photo_contexts ?? req.body?.contexts ?? [];
  const explicitProgress = req.body?.show_in_progress;
  const explicitScope = req.body?.show_in_scope;
  const hasRequestedContexts = Array.isArray(requestedContexts)
    ? requestedContexts.length > 0
    : String(requestedContexts || '').trim().length > 0;
  const usage = parsePhotoContexts(requestedContexts, hasRequestedContexts ? 'general' : (photo.photo_type || 'general'));
  const showInProgress = explicitProgress === undefined ? usage.showInProgress : (explicitProgress ? 1 : 0);
  const showInScope = explicitScope === undefined ? usage.showInScope : (explicitScope ? 1 : 0);

  try {
    db.prepare(`
      UPDATE photos
      SET show_in_general = 1,
          show_in_progress = ?,
          show_in_scope = ?,
          updated_at = datetime('now')
      WHERE id = ? AND project_id = ?
    `).run(showInProgress, showInScope, req.params.id, req.params.projectId);

    logActivity({
      userId: req.user.id,
      projectId: req.params.projectId,
      action: 'photo_contexts_updated',
      entityType: 'photo',
      entityId: req.params.id,
      details: {
        show_in_progress: Boolean(showInProgress),
        show_in_scope: Boolean(showInScope),
      },
    });

    const updatedPhoto = getPhotoWithNote(db, req.params.projectId, req.params.id, req.user);
    res.json({ photo: updatedPhoto });
  } catch (err) {
    console.error('Failed to update photo contexts:', err);
    res.status(500).json({ error: 'Failed to update photo usage' });
  }
});

// PUT /api/projects/:projectId/photos/:id/note - save the photo-only description text
router.put('/:id/note', (req, res) => {
  const db = getDb();
  const photo = db.prepare(`
    SELECT *
    FROM photos
    WHERE id = ? AND project_id = ? AND ${activePhotoSql('photos')}
  `).get(req.params.id, req.params.projectId);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });

  const noteText = String(req.body?.note || '').trim().slice(0, 2000);
  const now = new Date().toISOString();

  try {
    db.prepare(`
      UPDATE photos
      SET caption = ?,
          individual_note = ?,
          batch_note = NULL,
          updated_at = ?
      WHERE id = ? AND project_id = ?
    `).run(noteText || null, noteText || null, now, req.params.id, req.params.projectId);

    logActivity({
      userId: req.user.id,
      projectId: req.params.projectId,
      action: noteText ? 'photo_description_saved' : 'photo_description_cleared',
      entityType: 'photo',
      entityId: req.params.id,
      details: {
        has_description: Boolean(noteText),
      },
    });

    const updatedPhoto = getPhotoWithNote(db, req.params.projectId, req.params.id, req.user);
    res.json({ photo: updatedPhoto });
  } catch (err) {
    console.error('Failed to save photo description:', err);
    res.status(500).json({ error: 'Failed to save photo description' });
  }
});

// DELETE /api/projects/:projectId/photos/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const photo = db.prepare(`
    SELECT *
    FROM photos
    WHERE id = ? AND project_id = ? AND ${activePhotoSql('photos')}
  `).get(req.params.id, req.params.projectId);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });

  const selfCorrectionAllowed = canUseCorrectionDelete(photo, req.user);
  const managementOverrideAllowed = PHOTO_OVERRIDE_DELETE_ROLES.has(req.user.role) && photo.uploaded_by !== req.user.id;
  if (!selfCorrectionAllowed && !managementOverrideAllowed) {
    if (photo.uploaded_by === req.user.id && Number(photo.correction_delete_count || 0) >= 1) {
      return res.status(403).json({ error: 'This progress picture is locked because the one correction has already been used.' });
    }
    return res.status(403).json({ error: 'You can only delete your own uploaded progress pictures once as a correction.' });
  }

  removeStoredPhotoFiles(photo, req.params.projectId);

  db.prepare(`
    UPDATE photos
    SET upload_status = 'correction_deleted',
        correction_delete_count = COALESCE(correction_delete_count, 0) + 1,
        correction_deleted_at = datetime('now'),
        correction_deleted_by = ?,
        correction_delete_reason = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    req.user.id,
    selfCorrectionAllowed ? 'user_one_correction' : 'management_override',
    req.params.id
  );
  logActivity({
    userId: req.user.id,
    projectId: req.params.projectId,
    action: selfCorrectionAllowed ? 'photo_correction_deleted' : 'photo_deleted',
    entityType: 'photo',
    entityId: req.params.id,
    details: {
      original_name: photo.original_name,
      uploaded_by: photo.uploaded_by,
      correction_locked: true,
      reason: selfCorrectionAllowed ? 'user_one_correction' : 'management_override',
    },
  });
  res.json({
    message: selfCorrectionAllowed ? 'Progress picture removed. This correction is now locked.' : 'Photo removed by management.',
    correction_locked: true,
  });
});

module.exports = router;
