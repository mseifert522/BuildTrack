'use strict';
// HEIC -> JPEG without blocking the server (2026-10-28).
// heic-convert decodes (libheif WASM) and encodes (pure-JS jpeg-js) on the main event
// loop, so while a batch of iPhone photos converted, nothing else was served: logins,
// grids, chunk PUTs, QuickBooks webhooks. Here the decode runs in a worker_threads
// Worker and the JPEG encode runs in libvips (sharp) on the libuv threadpool.
//
// Quality is not lowered: JPEG quality 90 (heic-convert used 0.9) with 4:4:4 chroma,
// so colour edges are never subsampled more than before.
//
// Memory: the pixel count is read from the HEIF header BEFORE any pixels are decoded;
// past HEIC_WORKER_MAX_PIXELS the caller keeps today's path. WASM memory never shrinks
// (and resourceLimits does not cap it), so the worker is terminated after every job,
// which hands its heap back to the OS. Jobs run one at a time across the process.
//
// This file is both the main-side API and the worker script (see the bottom).
const fs = require('fs');
const fsp = require('fs/promises');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const HEIC_WORKER_MAX_PIXELS = 50e6;
const HEIC_WORKER_TIMEOUT_MS = 2 * 60 * 1000;
const JPEG_OPTIONS = { quality: 90, chromaSubsampling: '4:4:4' };

let queue = Promise.resolve();

function decodeInWorker(sourcePath) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: { heicWorker: true, sourcePath, maxPixels: HEIC_WORKER_MAX_PIXELS },
    });
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('HEIC decode timed out')), HEIC_WORKER_TIMEOUT_MS);
    worker.once('message', message => {
      if (!message || message.error) return finish(new Error(message?.error || 'HEIC worker sent nothing'));
      return finish(null, message);
    });
    worker.once('error', err => finish(err));
    worker.once('exit', code => finish(new Error(`HEIC worker exited with code ${code}`)));
  });
}

async function convertOne(sourcePath, targetPath) {
  const decoded = await decodeInWorker(sourcePath);
  if (decoded.tooLarge) return null;
  const { width, height, data } = decoded;
  if (!(width > 0) || !(height > 0) || !data || data.byteLength !== width * height * 4) {
    throw new Error('HEIC worker returned malformed pixels');
  }
  const sharp = require('sharp');
  const pixels = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const partial = `${targetPath}.${process.pid}.${Date.now()}.part`;
  try {
    // HEIC photos are opaque; the alpha channel libheif hands back is all 255.
    await sharp(pixels, { raw: { width, height, channels: 4 } })
      .removeAlpha()
      .jpeg(JPEG_OPTIONS)
      .toFile(partial);
    await fsp.rename(partial, targetPath);
  } catch (err) {
    await fsp.unlink(partial).catch(() => {});
    throw err;
  }
  const stat = await fsp.stat(targetPath);
  return { targetPath, size: stat.size };
}

// Resolves to { targetPath, size }, or null when the image is over the pixel gate (or
// its size cannot be read) and the caller should use its existing path. Rejects on
// any failure; callers fall back to heic-convert so no upload is lost.
function convertHeicFileToJpegOffThread(sourcePath, targetPath) {
  const job = queue.then(() => convertOne(sourcePath, targetPath));
  queue = job.catch(() => {});
  return job;
}

// ---- worker side -------------------------------------------------------------------
async function runWorkerJob() {
  const decode = require('heic-decode');
  const buffer = fs.readFileSync(workerData.sourcePath);
  const images = await decode.all({ buffer });
  try {
    const first = images && images[0];
    if (!first) throw new Error('HEIF image not found');
    const width = Number(first.width);
    const height = Number(first.height);
    if (!(width > 0) || !(height > 0) || width * height > workerData.maxPixels) {
      parentPort.postMessage({ tooLarge: true, width, height });
      return;
    }
    const image = await first.decode();
    const data = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
    try {
      // Hand the pixel buffer over instead of copying ~4 bytes per pixel.
      parentPort.postMessage({ width: image.width, height: image.height, data }, [data.buffer]);
    } catch (_) {
      parentPort.postMessage({ width: image.width, height: image.height, data });
    }
  } finally {
    if (images && typeof images.dispose === 'function') images.dispose();
  }
}

if (!isMainThread && workerData && workerData.heicWorker) {
  runWorkerJob().catch(err => {
    parentPort.postMessage({ error: String((err && err.message) || err) });
  });
}

module.exports = { convertHeicFileToJpegOffThread, HEIC_WORKER_MAX_PIXELS };
