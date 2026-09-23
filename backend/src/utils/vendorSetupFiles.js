'use strict';
// Storage for documents vendors upload through the public vendor setup portal
// (W-9, certificate of insurance, voided check / bank letter). Files are sealed
// with encryptBuffer() and live under uploads/vendor-setup/, which server.js and
// the uploads gate never serve: staff read them only through the authenticated
// /api/vendor-setup/files/:id route, which decrypts and audits every read.
const fs = require('fs');
const path = require('path');
const { encryptBuffer, decryptBuffer } = require('./secureFields');

const STORAGE_DIR = 'vendor-setup';

function uploadsRoot() {
  return path.resolve(process.env.UPLOADS_PATH || './uploads');
}

function storageRoot() {
  return path.join(uploadsRoot(), STORAGE_DIR);
}

// The type is decided by the file's CONTENT, never by the name or the browser's
// MIME claim. Anything that is not a PDF, an image or a Word/OpenDocument/RTF
// document is refused.
const TYPES = {
  pdf: { mime: 'application/pdf', ext: '.pdf', inline: true },
  jpeg: { mime: 'image/jpeg', ext: '.jpg', inline: true },
  png: { mime: 'image/png', ext: '.png', inline: true },
  gif: { mime: 'image/gif', ext: '.gif', inline: true },
  webp: { mime: 'image/webp', ext: '.webp', inline: true },
  heic: { mime: 'image/heic', ext: '.heic', inline: false },
  tiff: { mime: 'image/tiff', ext: '.tif', inline: false },
  bmp: { mime: 'image/bmp', ext: '.bmp', inline: true },
  doc: { mime: 'application/msword', ext: '.doc', inline: false },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx', inline: false },
  odt: { mime: 'application/vnd.oasis.opendocument.text', ext: '.odt', inline: false },
  rtf: { mime: 'application/rtf', ext: '.rtf', inline: false },
};

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif']);

function startsWith(buffer, bytes, offset = 0) {
  if (buffer.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buffer[offset + i] !== bytes[i]) return false;
  }
  return true;
}

function sniffFileType(buffer, originalName = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
  const head = buffer.subarray(0, 1024).toString('latin1');
  const pdfAt = head.indexOf('%PDF-');
  if (pdfAt >= 0 && pdfAt < 1024) return 'pdf';
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
  if (head.slice(4, 8) === 'ftyp' && HEIF_BRANDS.has(head.slice(8, 12))) return 'heic';
  if (startsWith(buffer, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buffer, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff';
  if (head.startsWith('BM') && buffer.length > 54) return 'bmp';
  if (head.startsWith('{\\rtf')) return 'rtf';
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    // OLE2 is shared by .doc/.xls/.ppt; only a .doc name is accepted.
    return /\.doc$/i.test(originalName) ? 'doc' : null;
  }
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) {
    // A zip: accept only a Word .docx or an OpenDocument text. Entry names sit in
    // the local headers (start) and the central directory (end).
    const sample = buffer.subarray(0, Math.min(buffer.length, 256 * 1024)).toString('latin1')
      + buffer.subarray(Math.max(0, buffer.length - 64 * 1024)).toString('latin1');
    if (sample.includes('mimetypeapplication/vnd.oasis.opendocument.text')) return 'odt';
    if (sample.includes('[Content_Types].xml') && sample.includes('word/document')) return 'docx';
    return null;
  }
  return null;
}

function typeInfo(type) {
  return TYPES[type] || null;
}

function sanitizeOriginalName(name, fallbackExt = '') {
  const base = path.basename(String(name || '').replace(/\\/g, '/')).normalize('NFC');
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150);
  return cleaned || `document${fallbackExt}`;
}

function relativePathFor(inviteId, fileId) {
  return path.posix.join(STORAGE_DIR, String(inviteId), `${fileId}.bin`);
}

function absolutePathFor(relPath) {
  const root = storageRoot();
  const absolute = path.resolve(uploadsRoot(), String(relPath || ''));
  if (!absolute.startsWith(root + path.sep)) throw new Error('Refusing a path outside vendor-setup storage');
  return absolute;
}

function writeSealedFile(inviteId, fileId, plaintext) {
  const relPath = relativePathFor(inviteId, fileId);
  const absolute = absolutePathFor(relPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  fs.writeFileSync(absolute, encryptBuffer(plaintext), { flag: 'wx', mode: 0o600 });
  return relPath;
}

function readSealedFile(relPath) {
  return decryptBuffer(fs.readFileSync(absolutePathFor(relPath)));
}

function removeSealedFile(relPath) {
  try {
    const absolute = absolutePathFor(relPath);
    if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
    const dir = path.dirname(absolute);
    if (dir !== storageRoot() && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch (err) {
    console.error('[vendor-setup] could not remove stored file:', err?.message || err);
  }
}

module.exports = {
  STORAGE_DIR,
  sniffFileType,
  typeInfo,
  sanitizeOriginalName,
  writeSealedFile,
  readSealedFile,
  removeSealedFile,
};
