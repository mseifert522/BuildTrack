require('dotenv').config();

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { getDb } = require('../src/db/schema');
const {
  convertHeicFileToJpeg,
  isHeicMedia,
  replaceExtension,
} = require('../src/utils/mediaConversion');

const dryRun = process.argv.includes('--dry-run');
const uploadsRoot = process.env.UPLOADS_PATH || './uploads';

function safeResolve(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath || '');
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) return null;
  return resolved;
}

function getSourcePath(projectRoot, photo) {
  const candidates = [photo.filename, photo.storage_path, photo.stored_file_name].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = safeResolve(projectRoot, candidate);
    if (resolved && fs.existsSync(resolved)) return resolved;
  }
  return safeResolve(projectRoot, photo.filename || photo.storage_path || photo.stored_file_name || '');
}

async function main() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, project_id, filename, original_name, stored_file_name, storage_path, mime_type, size
    FROM photos
    WHERE lower(COALESCE(filename, '')) LIKE '%.heic'
       OR lower(COALESCE(filename, '')) LIKE '%.heif'
       OR lower(COALESCE(storage_path, '')) LIKE '%.heic'
       OR lower(COALESCE(storage_path, '')) LIKE '%.heif'
       OR lower(COALESCE(stored_file_name, '')) LIKE '%.heic'
       OR lower(COALESCE(stored_file_name, '')) LIKE '%.heif'
       OR lower(COALESCE(mime_type, '')) IN ('image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence')
  `).all();

  let converted = 0;
  let skipped = 0;
  let missing = 0;
  let failed = 0;

  console.log(`${dryRun ? 'Dry run: ' : ''}found ${rows.length} HEIC/HEIF photo record(s)`);

  for (const photo of rows) {
    if (!isHeicMedia(photo)) {
      skipped += 1;
      continue;
    }

    const projectRoot = path.resolve(uploadsRoot, String(photo.project_id));
    const sourcePath = getSourcePath(projectRoot, photo);
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      missing += 1;
      console.warn(`missing file for photo ${photo.id}: ${photo.filename || photo.storage_path || photo.stored_file_name}`);
      continue;
    }

    try {
      const targetPath = path.join(path.dirname(sourcePath), replaceExtension(path.basename(sourcePath), '.jpg'));
      if (dryRun) {
        console.log(`[dry-run] ${sourcePath} -> ${targetPath}`);
        converted += 1;
        continue;
      }

      const result = await convertHeicFileToJpeg(sourcePath, targetPath);
      const nextFilename = path.relative(projectRoot, result.targetPath).replace(/\\/g, '/');
      const updatedAt = new Date().toISOString();

      db.prepare(`
        UPDATE photos
        SET filename = ?,
            stored_file_name = ?,
            storage_path = ?,
            mime_type = ?,
            size = ?,
            updated_at = ?
        WHERE id = ?
      `).run(nextFilename, path.basename(result.targetPath), nextFilename, 'image/jpeg', result.size, updatedAt, photo.id);

      try {
        await fsp.unlink(sourcePath);
      } catch (err) {
        console.warn(`converted photo ${photo.id}, but could not remove original HEIC file:`, err.message || err);
      }

      converted += 1;
      console.log(`converted photo ${photo.id}: ${photo.filename} -> ${nextFilename}`);
    } catch (err) {
      failed += 1;
      console.error(`failed to convert photo ${photo.id}:`, err.message || err);
    }
  }

  console.log(JSON.stringify({ converted, skipped, missing, failed, total: rows.length, dryRun }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
