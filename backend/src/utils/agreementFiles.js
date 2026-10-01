'use strict';
// Storage for Documents & Agreements files: encrypted at rest under
// uploads/agreements/, which server.js and the uploads gate never serve. Shared by
// routes/agreements.js (upload, view, delete) and services/documentReview.js (the
// AI reads the decrypted bytes in memory only).
//
// Layout: 'BTA1' | 12-byte IV | AES-256-GCM ciphertext | 16-byte tag. Streaming
// both ways, so a 50 MB scan never sits whole in memory for upload or viewing.
// The key is derived from CONTRACTOR_ONBOARDING_ENCRYPTION_KEY (the secret that
// also seals vendor W-9s) - rotating it makes every stored agreement unreadable.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { deriveFileKey } = require('./secureFields');
const { sniffFileType, typeInfo } = require('./vendorSetupFiles');

const STORAGE_DIR = 'agreements';
const SEALED_MAGIC = Buffer.from('BTA1', 'ascii');

function uploadsRoot() {
  return path.resolve(process.env.UPLOADS_PATH || './uploads');
}

function storageRoot() {
  return path.join(uploadsRoot(), STORAGE_DIR);
}

function incomingDir() {
  return path.join(storageRoot(), '.incoming');
}

function absolutePathFor(relPath) {
  const root = storageRoot();
  const absolute = path.resolve(uploadsRoot(), String(relPath || ''));
  if (!absolute.startsWith(root + path.sep)) throw new Error('Refusing a path outside agreements storage');
  return absolute;
}

function unlinkQuietly(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error('[agreements] could not remove file:', err?.message || err);
  }
}

function removeStoredFile(relPath) {
  try {
    unlinkQuietly(absolutePathFor(relPath));
  } catch (err) {
    console.error('[agreements] could not remove stored file:', err?.message || err);
  }
}

// The file type is decided by CONTENT (vendorSetupFiles.sniffFileType), never by
// its name. The sniffer needs the head (magic bytes, zip local headers) and the
// tail (zip central directory) of the file, not all of it.
function sniffStoredUpload(filePath, originalName) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const headLength = Math.min(size, 256 * 1024);
    const head = Buffer.alloc(headLength);
    fs.readSync(fd, head, 0, headLength, 0);
    let sample = head;
    if (size > headLength) {
      const tailLength = Math.min(size - headLength, 64 * 1024);
      const tail = Buffer.alloc(tailLength);
      fs.readSync(fd, tail, 0, tailLength, size - tailLength);
      sample = Buffer.concat([head, tail]);
    }
    const detected = sniffFileType(sample, originalName);
    return detected ? typeInfo(detected) : null;
  } finally {
    fs.closeSync(fd);
  }
}

function agreementFileKey() {
  return deriveFileKey('buildtrack:agreement-files:v1');
}

function sealFile(sourcePath, destPath) {
  return new Promise((resolve, reject) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', agreementFileKey(), iv);
    const input = fs.createReadStream(sourcePath);
    const output = fs.createWriteStream(destPath, { flags: 'wx', mode: 0o600 });
    let failed = false;
    const fail = err => {
      if (failed) return;
      failed = true;
      input.destroy();
      cipher.destroy();
      output.destroy();
      reject(err);
    };
    input.on('error', fail);
    cipher.on('error', fail);
    output.on('error', fail);
    output.on('finish', () => { if (!failed) resolve(); });
    output.write(Buffer.concat([SEALED_MAGIC, iv]));
    cipher.on('end', () => output.end(cipher.getAuthTag()));
    input.pipe(cipher).pipe(output, { end: false });
  });
}

// Returns the decrypting stream for a sealed file and the plaintext length. GCM
// verifies the tag at the end; a tampered file errors the stream (the response is
// then cut off, never completed).
function openSealedFile(absolute) {
  const fd = fs.openSync(absolute, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    if (size <= 32) throw new Error('Invalid encrypted file');
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    if (!head.subarray(0, 4).equals(SEALED_MAGIC)) throw new Error('Invalid encrypted file');
    const tag = Buffer.alloc(16);
    fs.readSync(fd, tag, 0, 16, size - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', agreementFileKey(), head.subarray(4, 16));
    decipher.setAuthTag(tag);
    const source = fs.createReadStream(absolute, { start: 16, end: size - 17 });
    return { source, decipher, length: size - 32 };
  } finally {
    fs.closeSync(fd);
  }
}

// Whole plaintext in memory - only for the AI reader, which needs the bytes
// anyway (it sends them base64). Rejects if the tag does not verify.
function readSealedToBuffer(relPath) {
  return new Promise((resolve, reject) => {
    let sealed;
    try {
      sealed = openSealedFile(absolutePathFor(relPath));
    } catch (err) {
      reject(err);
      return;
    }
    const chunks = [];
    sealed.source.on('error', reject);
    sealed.decipher.on('error', reject);
    sealed.decipher.on('data', chunk => chunks.push(chunk));
    sealed.decipher.on('end', () => resolve(Buffer.concat(chunks)));
    sealed.source.pipe(sealed.decipher);
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// An upload interrupted by a restart leaves its .part behind; sweep the day-old ones.
function sweepIncoming() {
  try {
    const dir = incomingDir();
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name.endsWith('.part') && fs.statSync(full).mtimeMs < cutoff) unlinkQuietly(full);
    }
  } catch (err) {
    console.error('[agreements] incoming sweep failed:', err?.message || err);
  }
}

module.exports = {
  STORAGE_DIR,
  uploadsRoot,
  storageRoot,
  incomingDir,
  absolutePathFor,
  unlinkQuietly,
  removeStoredFile,
  sniffStoredUpload,
  sealFile,
  openSealedFile,
  readSealedToBuffer,
  sha256File,
  sweepIncoming,
};
