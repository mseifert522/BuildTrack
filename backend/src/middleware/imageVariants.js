// Small WebP copies of uploaded photos for grids and tiles (performance, 2026-10-28).
// Phones upload 1-8 MB originals and every grid used to download them at full size:
// one project page pulled 20-30 MB. `/uploads/<path>.jpg?w=480` now answers with a
// WebP whose longest side is at most 480 px; the original URL is unchanged and is
// what the lightbox, downloads and markup editor keep using.
//
// Mounted AFTER createUploadsGate, so a variant is only ever served to someone who may
// read the original. Copies are cached outside the uploads tree (never reachable by
// express.static) and rebuilt on demand, so losing the cache only costs time.
const fs = require('fs');
const os = require('os');
const path = require('path');

const VARIANT_WIDTHS = new Set([160, 480, 1280]);
const VARIANT_SOURCE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.webp']);
const MAX_PARALLEL_RENDERS = 2;

function createImageVariants(uploadsRoot, deps = {}) {
  const root = path.resolve(uploadsRoot);
  const cacheRoot = path.resolve(deps.cacheRoot
    || process.env.UPLOAD_VARIANTS_PATH
    || path.join(os.tmpdir(), 'buildtrack-upload-variants'));
  const sharp = deps.sharp || require('sharp');
  const inFlight = new Map();
  const waiting = [];
  let running = 0;

  // libvips renders off the event loop; this only caps how many run at once so a
  // first visit to a 200-photo grid cannot starve API requests of CPU.
  function schedule(job) {
    return new Promise((resolve, reject) => {
      waiting.push({ job, resolve, reject });
      pump();
    });
  }
  function pump() {
    while (running < MAX_PARALLEL_RENDERS && waiting.length) {
      const { job, resolve, reject } = waiting.shift();
      running += 1;
      job().then(resolve, reject).finally(() => { running -= 1; pump(); });
    }
  }

  async function render(source, target, width) {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const partial = `${target}.${process.pid}.${Date.now()}.part`;
    try {
      await sharp(source, { failOn: 'none' })
        .rotate()
        .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 72 })
        .toFile(partial);
      await fs.promises.rename(partial, target);
    } catch (err) {
      fs.promises.unlink(partial).catch(() => {});
      throw err;
    }
  }

  async function variantFor(rel, width) {
    const source = path.resolve(root, rel);
    if (!source.startsWith(root + path.sep)) return null;
    const sourceStat = await fs.promises.stat(source).catch(() => null);
    if (!sourceStat || !sourceStat.isFile()) return null;
    const target = path.join(cacheRoot, String(width), `${rel}.webp`);
    const cached = await fs.promises.stat(target).catch(() => null);
    if (cached && cached.mtimeMs >= sourceStat.mtimeMs) return target;
    const key = `${width}:${rel}`;
    if (!inFlight.has(key)) {
      inFlight.set(key, schedule(() => render(source, target, width)).finally(() => inFlight.delete(key)));
    }
    await inFlight.get(key);
    return target;
  }

  return async function imageVariants(req, res, next) {
    const width = Number(req.query.w);
    if (req.query.w === undefined || !VARIANT_WIDTHS.has(width)) return next();
    let rel;
    try { rel = decodeURIComponent(req.path).replace(/^\/+/, ''); } catch (_) { return next(); }
    if (!rel || rel.includes('\0') || !VARIANT_SOURCE_EXTENSIONS.has(path.extname(rel).toLowerCase())) return next();
    try {
      const file = await variantFor(path.normalize(rel), width);
      if (!file) return next();
      res.setHeader('Cache-Control', 'private, max-age=604800');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
      res.type('image/webp');
      return res.sendFile(file, { dotfiles: 'allow' });
    } catch (err) {
      // A file sharp cannot read still opens as the original.
      console.warn(`[uploads] variant w=${width} failed for ${rel}: ${err.message}`);
      return next();
    }
  };
}

module.exports = { createImageVariants, VARIANT_WIDTHS };
