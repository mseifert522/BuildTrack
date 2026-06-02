const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const convertHeic = require('heic-convert');

const HEIC_EXTENSIONS = new Set(['.heic', '.heif']);
const HEIC_MIME_TYPES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

function mediaExt(value) {
  return path.extname(String(value || '')).toLowerCase();
}

function isHeicMediaName(value) {
  return HEIC_EXTENSIONS.has(mediaExt(value));
}

function isHeicMedia({ filename, originalname, original_name, mimetype, mime_type } = {}) {
  const mime = String(mimetype || mime_type || '').toLowerCase();
  return HEIC_MIME_TYPES.has(mime)
    || isHeicMediaName(filename)
    || isHeicMediaName(originalname)
    || isHeicMediaName(original_name);
}

function replaceExtension(value, nextExtension) {
  const extension = path.extname(value);
  if (!extension) return `${value}${nextExtension}`;
  return `${value.slice(0, -extension.length)}${nextExtension}`;
}

async function getAvailablePath(preferredPath) {
  if (!fs.existsSync(preferredPath)) return preferredPath;
  const dir = path.dirname(preferredPath);
  const ext = path.extname(preferredPath);
  const base = path.basename(preferredPath, ext);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(dir, `${base}-${index}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

async function convertHeicFileToJpeg(sourcePath, preferredTargetPath) {
  const targetPath = await getAvailablePath(preferredTargetPath);
  const input = await fsp.readFile(sourcePath);
  const output = await convertHeic({
    buffer: input,
    format: 'JPEG',
    quality: 0.9,
  });
  const outputBuffer = Buffer.from(output);
  await fsp.writeFile(targetPath, outputBuffer);
  const stat = await fsp.stat(targetPath);
  return { targetPath, size: stat.size };
}

async function convertHeicUploadToJpeg(file) {
  if (!file?.path || !isHeicMedia(file)) return file;

  const originalPath = file.path;
  const nextFilename = replaceExtension(file.filename || path.basename(originalPath), '.jpg');
  const preferredTargetPath = path.join(path.dirname(originalPath), nextFilename);
  const { targetPath, size } = await convertHeicFileToJpeg(originalPath, preferredTargetPath);

  try {
    await fsp.unlink(originalPath);
  } catch (err) {
    console.warn('Failed to remove original HEIC upload after conversion:', err.message || err);
  }

  file.path = targetPath;
  file.filename = path.basename(targetPath);
  file.mimetype = 'image/jpeg';
  file.size = size;
  file.converted_from = 'heic';
  return file;
}

module.exports = {
  convertHeicFileToJpeg,
  convertHeicUploadToJpeg,
  isHeicMedia,
  isHeicMediaName,
  replaceExtension,
};
