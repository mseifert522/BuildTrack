// Small WebP copies of uploaded photos for grids and tiles (performance, 2026-10-28).
// Phones upload 1-8 MB originals and every grid used to download them at full size:
// one project page pulled 20-30 MB. `/uploads/<path>.jpg?w=480` now answers with a
// WebP whose longest side is at most 480 px; the original URL is unchanged and is
// what the lightbox, downloads and markup editor keep using.
//
// `/uploads/<path>.mp4?w=160|480&poster=1` answers with a WebP poster frame of the
// video, so grid tiles show an <img> instead of opening a range request into a
// 70 MB clip and decoding a 4K frame to paint a 100 px square.
//
// Mounted AFTER createUploadsGate, so a variant is only ever served to someone who may
// read the original. Copies are cached in <uploads>/.variants (2026-10-28: was the
// container's tmpdir, so every deploy threw the cache away and the first visitors paid
// for a re-render storm). That folder is never served directly: uploadsGate classifies
// it as blocked and server.js 404s /uploads/.variants. Losing the cache only costs time.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const VARIANT_WIDTHS = new Set([160, 480, 1280]);
const VARIANT_SOURCE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.webp']);
const POSTER_WIDTHS = new Set([160, 480]);
const POSTER_SOURCE_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.qt', '.3gp']);
const MAX_PARALLEL_RENDERS = 2;
// Warm jobs never take the second slot, so a grid request always finds one free.
const MAX_BACKGROUND_RENDERS = 1;
const VARIANT_CACHE_DIR = '.variants';
const FFMPEG_TIMEOUT_MS = 20 * 1000;
// Every grab is pre-scaled to at most 960 px (POSTER_PRESCALE), so a frame is ~2.8 MB
// of uncompressed PNG; anything much larger is not a frame we asked for.
const MAX_POSTER_FRAME_BYTES = 8 * 1024 * 1024;
const FAILURE_RETRY_MS = 10 * 60 * 1000;
// Shrink inside ffmpeg before any pixel-format or float work (2026-10-28): a 4K HDR frame
// in gbrpf32le is ~100 MB and the tone-map chain holds several, so two posters at once
// could push the 768 MB container into the OOM killer. 960 is twice the largest poster
// width, so the final sharp resize loses nothing; min() never enlarges a small clip.
// Autorotate runs before -vf, so portrait clips stay upright.
const POSTER_PRESCALE = "scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease:flags=lanczos";
// The poster path hands the decoded frame back to the requester, so ffmpeg may only read
// the uploaded file itself as a plain container: an HLS/concat playlist saved as
// "clip.mp4" must not open other local files or URLs (2026-10-28).
const SOURCE_INPUT_GUARDS = [
  '-protocol_whitelist', 'file',
  '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm',
];
// iPhone HDR (HLG / Dolby Vision, 10-bit BT.2020) grabbed without tone mapping comes
// out flat and grey; map it to SDR BT.709 the way a player would.
const HDR_TONEMAP_FILTER = [
  POSTER_PRESCALE,
  'zscale=t=linear:npl=100',
  'format=gbrpf32le',
  'zscale=p=bt709',
  'tonemap=tonemap=hable:desat=0',
  'zscale=t=bt709:m=bt709:r=pc',
  'format=rgb24',
].join(',');

// 1280 px is the main view in the single-photo modals and the project hero, so it keeps
// near-original quality; grid tiles stay small (2026-10-28).
function webpQualityFor(width) {
  return width >= 1280 ? 85 : 72;
}

function runTool(cmd, args, { timeoutMs, maxBytes, background }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // nice: warm jobs share the container's CPU quota with the API and must yield.
      child = background
        ? spawn('nice', ['-n', '15', cmd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    let bytes = 0;
    let overflow = false;
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => {
      if (overflow) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !overflow) {
        resolve(Buffer.concat(out));
        return;
      }
      const why = overflow ? 'output too large' : signal ? `killed (${signal})` : `exited ${code}`;
      reject(new Error(`${cmd} ${why}: ${stderr.trim().split('\n').slice(-2).join(' | ')}`));
    });
  });
}

async function isHdrVideo(source, background) {
  const out = await runTool('ffprobe', [
    '-v', 'error', ...SOURCE_INPUT_GUARDS, '-select_streams', 'v:0', '-show_entries', 'stream=color_transfer',
    '-of', 'default=noprint_wrappers=1:nokey=1', source,
  ], { timeoutMs: FFMPEG_TIMEOUT_MS, maxBytes: 64 * 1024, background });
  return /smpte2084|arib-std-b67/i.test(out.toString());
}

// One frame as PNG on stdout. ffmpeg's autorotate applies the phone's rotation tag, so
// the frame is already upright. -threads 1: one frame does not need the whole quota.
function grabFrame(source, seconds, filter, background) {
  return runTool('ffmpeg', [
    '-nostdin', '-v', 'error', '-threads', '1',
    ...SOURCE_INPUT_GUARDS,
    ...(seconds > 0 ? ['-ss', String(seconds)] : []),
    '-i', source,
    '-map', '0:v:0', '-frames:v', '1', '-an',
    '-vf', filter || POSTER_PRESCALE,
    '-pix_fmt', 'rgb24', '-f', 'image2pipe', '-vcodec', 'png', '-compression_level', '0', 'pipe:1',
  ], { timeoutMs: FFMPEG_TIMEOUT_MS, maxBytes: MAX_POSTER_FRAME_BYTES, background });
}

async function extractPosterFrame(source, background) {
  const hdr = await isHdrVideo(source, background).catch(() => false);
  let tonemapUsable = hdr;
  let lastError = null;
  // ~0.5 s skips a black first frame; clips shorter than that only have frame 0.
  for (const seconds of [0.5, 0]) {
    if (tonemapUsable) {
      try {
        const frame = await grabFrame(source, seconds, HDR_TONEMAP_FILTER, background);
        if (frame.length) return frame;
      } catch (err) {
        // ffmpeg built without zscale, or the clip lacks colour tags: plain grab.
        tonemapUsable = false;
        lastError = err;
      }
    }
    try {
      const frame = await grabFrame(source, seconds, null, background);
      if (frame.length) return frame;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('no video frame');
}

// The instance server.js mounts, so services without req.app (video normalization) can warm.
let mountedInstance = null;

function createImageVariants(uploadsRoot, deps = {}) {
  const root = path.resolve(uploadsRoot);
  const cacheRoot = path.resolve(deps.cacheRoot
    || process.env.UPLOAD_VARIANTS_PATH
    || path.join(root, VARIANT_CACHE_DIR));
  if (cacheRoot.startsWith(root + path.sep) && cacheRoot !== path.join(root, VARIANT_CACHE_DIR)) {
    console.warn(`[uploads] UPLOAD_VARIANTS_PATH is inside the uploads tree but not ${VARIANT_CACHE_DIR}; only ${VARIANT_CACHE_DIR} is blocked from direct serving`);
  }
  const sharp = deps.sharp || require('sharp');
  const extractFrame = deps.extractPosterFrame || extractPosterFrame;
  const inFlight = new Map();
  const failures = new Map();
  const queues = { interactive: [], background: [] };
  let running = 0;
  let runningBackground = 0;

  // libvips renders off the event loop; this only caps how many run at once so a
  // first visit to a 200-photo grid cannot starve API requests of CPU. Requests go
  // first; warm jobs (after an upload, after boot) only fill what requests leave.
  function schedule(job, priority) {
    const entry = { job, priority, started: false };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    queues[priority].push(entry);
    pump();
    return entry;
  }
  // A request for a variant a warm job has queued must not wait behind the warm queue.
  function promote(entry) {
    if (entry.started || entry.priority === 'interactive') return;
    const index = queues.background.indexOf(entry);
    if (index >= 0) queues.background.splice(index, 1);
    entry.priority = 'interactive';
    queues.interactive.push(entry);
    pump();
  }
  function pump() {
    while (running < MAX_PARALLEL_RENDERS) {
      let entry = queues.interactive.shift();
      if (!entry && runningBackground < MAX_BACKGROUND_RENDERS) entry = queues.background.shift();
      if (!entry) return;
      const background = entry.priority === 'background';
      entry.started = true;
      running += 1;
      if (background) runningBackground += 1;
      Promise.resolve()
        .then(() => entry.job(background))
        .then(entry.resolve, entry.reject)
        .finally(() => {
          running -= 1;
          if (background) runningBackground -= 1;
          pump();
        });
    }
  }

  async function writeVariant(pipeline, target) {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    // blue and green share this folder during a deploy; never write a name the other could.
    const partial = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.part`;
    try {
      await pipeline.toFile(partial);
      await fs.promises.rename(partial, target);
    } catch (err) {
      fs.promises.unlink(partial).catch(() => {});
      throw err;
    }
  }

  function resized(input, width) {
    return input
      .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: webpQualityFor(width) });
  }

  async function renderImages(source, items) {
    for (const { width, target } of items) {
      await writeVariant(resized(sharp(source, { failOn: 'none' }).rotate(), width), target);
    }
  }

  // One ffmpeg run feeds every missing width of the same clip.
  async function renderPosters(source, items, background) {
    const frame = await extractFrame(source, background);
    for (const { width, target } of items) {
      await writeVariant(resized(sharp(frame, { failOn: 'none' }).rotate(), width), target);
    }
  }

  function targetFor(kind, rel, width) {
    return path.join(cacheRoot, String(width), kind === 'poster' ? `${rel}.poster.webp` : `${rel}.webp`);
  }

  // A file sharp/ffmpeg cannot read is not retried on every request.
  function recentlyFailed(kind, rel, sourceStat) {
    const failure = failures.get(`${kind}:${rel}`);
    if (!failure) return false;
    if (failure.mtimeMs === sourceStat.mtimeMs && Date.now() - failure.at < FAILURE_RETRY_MS) return true;
    failures.delete(`${kind}:${rel}`);
    return false;
  }
  function rememberFailure(kind, rel, sourceStat) {
    if (failures.size > 5000) failures.clear();
    failures.set(`${kind}:${rel}`, { mtimeMs: sourceStat.mtimeMs, at: Date.now() });
  }

  // Resolves to { files: {width: path}, rendered } once every requested width exists,
  // or null when there is no such source file.
  async function ensureVariants(rel, kind, widths, priority) {
    const source = path.resolve(root, rel);
    if (!source.startsWith(root + path.sep) || source.startsWith(cacheRoot + path.sep)) return null;
    const sourceStat = await fs.promises.stat(source).catch(() => null);
    if (!sourceStat || !sourceStat.isFile()) return null;

    const files = {};
    const stale = [];
    for (const width of widths) {
      const target = targetFor(kind, rel, width);
      files[width] = target;
      const cached = await fs.promises.stat(target).catch(() => null);
      if (!cached || cached.mtimeMs < sourceStat.mtimeMs) stale.push(width);
    }
    // From here to inFlight.set there is no await, so two requests for the same width
    // cannot both find it missing and render it twice. A recent failure only stops a new
    // render; widths already in the cache are always served.
    const waits = [];
    const missing = [];
    for (const width of stale) {
      const pending = inFlight.get(`${kind}:${width}:${rel}`);
      if (pending) {
        if (priority === 'interactive') promote(pending);
        waits.push(pending.promise);
      } else {
        missing.push(width);
      }
    }
    if (missing.length && recentlyFailed(kind, rel, sourceStat)) throw new Error('recently failed, not retried yet');
    if (missing.length) {
      const items = missing.map(width => ({ width, target: files[width] }));
      const entry = schedule(background => (kind === 'poster'
        ? renderPosters(source, items, background)
        : renderImages(source, items)), priority);
      const keys = missing.map(width => `${kind}:${width}:${rel}`);
      for (const key of keys) inFlight.set(key, entry);
      const release = () => {
        for (const key of keys) if (inFlight.get(key) === entry) inFlight.delete(key);
      };
      entry.promise.then(release, release);
      waits.push(entry.promise);
    }
    try {
      await Promise.all(waits);
    } catch (err) {
      rememberFailure(kind, rel, sourceStat);
      throw err;
    }
    return { files, rendered: missing.length };
  }

  function sourceKind(rel) {
    const ext = path.extname(rel).toLowerCase();
    if (VARIANT_SOURCE_EXTENSIONS.has(ext)) return 'image';
    if (POSTER_SOURCE_EXTENSIONS.has(ext)) return 'poster';
    return null;
  }

  // Background render of the missing variants of one upload (rel = path under uploads/,
  // e.g. "<projectId>/photos/.../x.jpg"). Images get `widths`; videos get poster frames
  // at the poster widths among them. Never rejects; resolves to the number rendered.
  async function warm(rel, widths = [480, 160]) {
    let clean = '';
    try {
      clean = path.normalize(String(rel || '').replace(/^\/+/, ''));
      if (!clean || clean.includes('\0') || clean.startsWith('..') || path.isAbsolute(clean)) return 0;
      const kind = sourceKind(clean);
      if (!kind) return 0;
      const allowed = kind === 'poster' ? POSTER_WIDTHS : VARIANT_WIDTHS;
      const list = [...new Set((Array.isArray(widths) ? widths : [widths]).map(Number))].filter(w => allowed.has(w));
      if (!list.length) return 0;
      const result = await ensureVariants(clean, kind, list, 'background');
      return result ? result.rendered : 0;
    } catch (err) {
      if (!/recently failed/.test(err.message || '')) console.warn(`[uploads] variant warm failed for ${clean}: ${err.message}`);
      return 0;
    }
  }

  async function imageVariants(req, res, next) {
    if (req.query.w === undefined) return next();
    const width = Number(req.query.w);
    let rel;
    try { rel = decodeURIComponent(req.path).replace(/^\/+/, ''); } catch (_) { return next(); }
    if (!rel || rel.includes('\0')) return next();
    const kind = sourceKind(rel);
    if (kind === 'image' ? !VARIANT_WIDTHS.has(width)
      : kind === 'poster' ? (req.query.poster !== '1' || !POSTER_WIDTHS.has(width))
        : true) return next();
    // A poster is asked for by an <img>: falling through would send the whole clip as
    // the image body just to fire onError. The gate has already allowed this request.
    const noPoster = () => {
      res.set('Cache-Control', 'no-store');
      return res.status(404).type('text/plain').send('No poster');
    };
    try {
      const result = await ensureVariants(path.normalize(rel), kind, [width], 'interactive');
      const file = result && result.files[width];
      if (!file) return kind === 'poster' ? noPoster() : next();
      res.setHeader('Cache-Control', 'private, max-age=604800');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
      res.type('image/webp');
      return res.sendFile(file, { dotfiles: 'allow' });
    } catch (err) {
      if (!/recently failed/.test(err.message || '')) {
        console.warn(`[uploads] ${kind === 'poster' ? 'poster' : 'variant'} w=${width} failed for ${rel}: ${err.message}`);
      }
      // An image sharp cannot read still opens as the original; a video never does.
      return kind === 'poster' ? noPoster() : next();
    }
  }
  imageVariants.warm = warm;
  if (!deps.sharp) mountedInstance = imageVariants;
  return imageVariants;
}

// Same as <middleware>.warm on the mounted instance; a no-op (0) before server.js mounts it.
function warmUpload(rel, widths) {
  return mountedInstance ? mountedInstance.warm(rel, widths) : Promise.resolve(0);
}

module.exports = {
  createImageVariants,
  warmUpload,
  VARIANT_WIDTHS,
  POSTER_WIDTHS,
  POSTER_SOURCE_EXTENSIONS,
  VARIANT_CACHE_DIR,
};
