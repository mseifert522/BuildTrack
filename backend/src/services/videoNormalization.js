// Makes every uploaded project video play upright, with a seekable timeline, in any
// browser (per Mike 2026-10-26: "automatically turn the video right side up").
//
// Phones store video sideways and add a rotation tag that players are meant to apply.
// That tag is sometimes WRONG: IMG_7793.MOV (2026-10-26) has upright landscape pixels
// tagged "rotate -90", so every browser showed it on its side. So the tag is only a
// first guess - Claude looks at two frames and picks which of four rotations is
// upright. Without an API key, or when the two frames disagree, the phone's tag is
// trusted.
//
// Output is always an MP4 with the moov atom first (+faststart), so the player can seek
// a 500 MB clip without downloading it. H.264 clips are stream-copied with a corrected
// rotation tag (seconds, lossless). Anything else - iPhone HEVC, which Chrome on Windows
// often can't decode at all - is re-encoded to H.264/AAC, longest side <= 1920, with
// the rotation baked into the pixels.
//
// The upload is never destroyed: the photo row is pointed at the new file and the
// original's path is kept in video_original_path (removed with the photo). A manual
// re-rotation re-encodes from that original.
//
// The photos table is the queue (video_status queued -> processing -> ready|failed),
// claimed with an atomic UPDATE, so a restart resumes and a blue-green overlap can't
// process one clip twice. Env: VIDEO_NORMALIZE_ENABLED (default true - set false on a
// green container), VIDEO_ORIENTATION_AI_ENABLED (default true), VIDEO_ORIENTATION_MODEL.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const AnthropicModule = require('@anthropic-ai/sdk');
const sharp = require('sharp');
const { getDb } = require('../db/schema');
const { resolveAnthropicApiKey } = require('../utils/anthropicKey');

const AnthropicClass = AnthropicModule.default || AnthropicModule;
const TAG = '[VIDEO]';
const MAX_EDGE = 1920;
const POLL_MS = 60 * 1000;
const ORIENTATION_MODEL = process.env.VIDEO_ORIENTATION_MODEL || 'claude-opus-5-5';
const VIDEO_EXTENSIONS = /\.(mp4|mov|qt|m4v|webm|avi|mkv|mpeg|mpg|3gp|3g2|hevc|mts|m2ts)$/i;
const ROTATIONS = [0, 90, 180, 270];

function enabled() {
  return String(process.env.VIDEO_NORMALIZE_ENABLED || 'true').toLowerCase() !== 'false';
}

function aiEnabled() {
  return String(process.env.VIDEO_ORIENTATION_AI_ENABLED || 'true').toLowerCase() !== 'false';
}

function uploadRoot() {
  return process.env.UPLOADS_PATH || './uploads';
}

function isVideoRow(row) {
  const mime = String(row?.mime_type || '').toLowerCase();
  return mime.startsWith('video/') || VIDEO_EXTENSIONS.test(String(row?.filename || ''));
}

function normalizeRotation(value) {
  const n = Math.round(Number(value) / 90) * 90;
  return Number.isFinite(n) ? ((n % 360) + 360) % 360 : 0;
}

// Resolve a stored relative path inside the project's upload folder, refusing escapes.
function projectFile(projectId, relPath) {
  const root = path.resolve(uploadRoot(), String(projectId));
  const filePath = path.resolve(root, String(relPath || ''));
  if (!relPath || !filePath.startsWith(`${root}${path.sep}`)) return null;
  return { root, filePath };
}

function run(cmd, args, { timeoutMs = 0, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    // nice: the API shares this container's CPU quota; transcoding must yield to it.
    const child = spawn('nice', ['-n', '15', cmd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    let timer = null;
    if (timeoutMs) timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => { err = (err + chunk.toString()).slice(-4000); });
    child.on('error', reject);
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(out);
      if (code === 0) resolve(binary ? stdout : stdout.toString());
      else reject(new Error(`${cmd} exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

// The rotation a player applies, in degrees clockwise (0/90/180/270).
function displayRotation(stream) {
  const fromSideData = (stream?.side_data_list || []).find(item => item.rotation !== undefined);
  // ffprobe reports the display matrix as counter-clockwise degrees ("-90" = turn right).
  if (fromSideData) return normalizeRotation(-Number(fromSideData.rotation));
  if (stream?.tags?.rotate !== undefined) return normalizeRotation(stream.tags.rotate);
  return 0;
}

async function probe(filePath) {
  const json = JSON.parse(await run('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath,
  ], { timeoutMs: 60 * 1000 }));
  const video = (json.streams || []).find(s => s.codec_type === 'video');
  const audio = (json.streams || []).find(s => s.codec_type === 'audio');
  if (!video) throw new Error('No video stream');
  const rotation = displayRotation(video);
  const width = Number(video.width) || 0;
  const height = Number(video.height) || 0;
  const swap = rotation === 90 || rotation === 270;
  return {
    codec: video.codec_name,
    pixFmt: video.pix_fmt,
    width,
    height,
    rotation,
    shownWidth: swap ? height : width,
    shownHeight: swap ? width : height,
    duration: Number(json.format?.duration) || Number(video.duration) || 0,
    audioCodec: audio?.codec_name || null,
    formatName: String(json.format?.format_name || ''),
  };
}

// One frame as the browser would show it (rotation tag applied), longest side 512.
async function grabFrame(filePath, seconds) {
  return run('ffmpeg', [
    '-v', 'error', '-ss', String(Math.max(0, seconds)), '-i', filePath, '-frames:v', '1',
    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
  ], { timeoutMs: 60 * 1000, binary: true });
}

const ORIENTATION_SCHEMA = {
  type: 'object',
  properties: {
    frames: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          upright: { type: 'string', enum: ['A', 'B', 'C', 'D'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['upright', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['frames'],
  additionalProperties: false,
};

// Returns the extra clockwise turn (0/90/180/270) to apply on top of the phone's tag,
// or null when the AI can't say with confidence (caller then trusts the tag).
async function detectCorrection(filePath, info) {
  if (!aiEnabled()) return null;
  const { apiKey } = resolveAnthropicApiKey();
  if (!apiKey) return null;

  const times = info.duration > 4 ? [info.duration * 0.25, info.duration * 0.6] : [0];
  const content = [];
  for (const [frameIndex, seconds] of times.entries()) {
    const frame = await grabFrame(filePath, seconds);
    content.push({ type: 'text', text: `Frame ${frameIndex + 1} - the same picture turned four ways:` });
    for (const [i, degrees] of ROTATIONS.entries()) {
      const jpeg = await sharp(frame).rotate(degrees).jpeg({ quality: 80 }).toBuffer();
      content.push({ type: 'text', text: `${'ABCD'[i]}:` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } });
    }
  }
  content.push({
    type: 'text',
    text: 'These frames come from a phone video of a construction or renovation job site. '
      + 'For each frame, which version (A, B, C or D) is upright, the way a person standing '
      + 'there would see it: sky or ceiling at the top, ground or floor at the bottom, walls, '
      + 'doors and posts vertical, any text readable. Use "low" confidence if you cannot tell.',
  });

  const client = new AnthropicClass({ apiKey });
  const response = await client.beta.messages.create({
    model: ORIENTATION_MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: ORIENTATION_SCHEMA } },
    messages: [{ role: 'user', content }],
  });
  if (response.stop_reason === 'refusal') return null;
  const text = (response.content || []).find(block => block.type === 'text')?.text;
  const answers = JSON.parse(text || '{}').frames || [];
  if (answers.length !== times.length) return null;
  const picks = new Set(answers.map(answer => answer.upright));
  if (picks.size !== 1 || answers.some(answer => answer.confidence === 'low')) return null;
  return ROTATIONS['ABCD'.indexOf(answers[0].upright)];
}

function rotationFilter(degrees) {
  if (degrees === 90) return 'transpose=clock';
  if (degrees === 180) return 'hflip,vflip';
  if (degrees === 270) return 'transpose=cclock';
  return null;
}

// H.264 plays in every browser, so those clips are never re-encoded: the stream is
// copied into an MP4 with the index first and the rotation tag REWRITTEN to the right
// value (browsers obey the tag - that's how the bad one turned clips sideways). Takes
// seconds and loses nothing; re-encoding the 543 MB IMG_7793.MOV took ~16 min here.
function canRemux(info) {
  return info.codec === 'h264' && info.pixFmt === 'yuv420p' && (!info.audioCodec || info.audioCodec === 'aac');
}

// The rotation tag the output will carry (clockwise degrees).
function outputTag(info, correction) {
  return canRemux(info) ? normalizeRotation(info.rotation + correction) : 0;
}

async function encode(source, target, info, correction) {
  // One thread throughout: the container's CPU quota is shared with the API, and nice
  // doesn't help inside one quota - at 2 threads ffmpeg took all 1.5 CPUs (tested).
  const common = ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-threads', '1', '-i', source, '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '0'];
  if (canRemux(info)) {
    await run('ffmpeg', [
      ...common, '-c', 'copy', '-metadata:s:v:0', `rotate=${outputTag(info, correction)}`,
      '-movflags', '+faststart', '-f', 'mp4', target,
    ], { timeoutMs: 15 * 60 * 1000 });
    return 'remux';
  }
  // HEVC, 10-bit and the rest: re-encode. ffmpeg's autorotate applies the phone's tag
  // (and drops it from the output); the AI's correction is a further turn on top.
  const filters = [
    rotationFilter(correction),
    `scale=w='min(${MAX_EDGE},iw)':h='min(${MAX_EDGE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
    'format=yuv420p',
  ].filter(Boolean).join(',');
  const timeoutMs = Math.max(60 * 60 * 1000, info.duration * 30 * 1000);
  await run('ffmpeg', [
    ...common, '-filter_threads', '1', '-vf', filters,
    '-c:v', 'libx264', '-preset', 'superfast', '-crf', '23', '-maxrate', '6M', '-bufsize', '12M', '-threads', '1', '-x264-params', 'rc-lookahead=20',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart', '-f', 'mp4', target,
  ], { timeoutMs });
  return 'transcode';
}

// Never swap a clip in unless the output is complete, tagged as planned and shows turned
// as intended.
async function verifyOutput(target, info, correction) {
  const out = await probe(target);
  const tag = outputTag(info, correction);
  if (out.rotation !== tag) throw new Error(`output carries a ${out.rotation} degree tag, expected ${tag}`);
  const tolerance = Math.max(1.5, info.duration * 0.02);
  if (info.duration && Math.abs(out.duration - info.duration) > tolerance) {
    throw new Error(`output is ${out.duration.toFixed(1)}s, source ${info.duration.toFixed(1)}s`);
  }
  const swap = correction === 90 || correction === 270;
  const wantPortrait = swap ? info.shownWidth > info.shownHeight : info.shownHeight > info.shownWidth;
  if (info.shownWidth !== info.shownHeight && (out.shownHeight > out.shownWidth) !== wantPortrait) {
    throw new Error(`output shows ${out.shownWidth}x${out.shownHeight}, expected ${wantPortrait ? 'portrait' : 'landscape'}`);
  }
  return out;
}

function markFailed(db, id, message) {
  db.prepare(`UPDATE photos SET video_status = 'failed', video_error = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(String(message || 'failed').slice(0, 500), id);
}

async function processRow(row) {
  const db = getDb();
  const sourceRel = row.video_original_path || row.filename;
  const located = projectFile(row.project_id, sourceRel);
  if (!located || !fs.existsSync(located.filePath)) return markFailed(db, row.id, 'file missing');

  const info = await probe(located.filePath);
  let correction = 0;
  let source = 'metadata';
  if (row.video_orientation_source === 'manual') {
    correction = normalizeRotation(row.video_rotation);
    source = 'manual';
  } else {
    try {
      const detected = await detectCorrection(located.filePath, info);
      if (detected !== null) { correction = detected; source = 'ai'; }
    } catch (err) {
      console.warn(`${TAG} orientation check failed for ${row.id}, trusting the phone's tag:`, err?.message || err);
    }
  }
  console.log(`${TAG} ${row.id} ${info.codec} ${info.width}x${info.height} tag ${info.rotation}, ${info.duration.toFixed(0)}s: turn ${correction} (${source})`);

  const base = sourceRel.replace(/\.[^./]+$/, '');
  const targetRel = `${base}-web-r${correction}.mp4`;
  const target = projectFile(row.project_id, targetRel).filePath;
  const partial = `${target}.part`;
  try {
    const mode = await encode(located.filePath, partial, info, correction);
    const out = await verifyOutput(partial, info, correction);
    await fsp.rename(partial, target);
    const size = (await fsp.stat(target)).size;

    const previousRel = row.filename;
    const swapped = db.transaction(() => {
      const current = db.prepare('SELECT filename, video_status, correction_deleted_at FROM photos WHERE id = ?').get(row.id);
      // Deleted (or re-queued for a manual turn) while encoding: discard this output.
      if (!current || current.correction_deleted_at || current.video_status !== 'processing') return false;
      db.prepare(`
        UPDATE photos
        SET filename = ?, storage_path = ?, stored_file_name = ?, mime_type = 'video/mp4', size = ?,
            video_original_path = COALESCE(video_original_path, ?),
            video_rotation = ?, video_orientation_source = ?, video_status = 'ready', video_error = NULL,
            video_processed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(targetRel, targetRel, path.basename(targetRel), size, sourceRel, correction, source, row.id);
      return true;
    })();
    if (!swapped) {
      await fsp.unlink(target).catch(() => {});
      return;
    }
    // A previous normalized copy (manual re-turn) is superseded; the original stays.
    if (previousRel && previousRel !== sourceRel && previousRel !== targetRel) {
      const old = projectFile(row.project_id, previousRel);
      if (old) await fsp.unlink(old.filePath).catch(() => {});
    }
    console.log(`${TAG} ${row.id} ready: ${mode}, tag ${info.rotation}, turn ${correction} (${source}), ${out.width}x${out.height}, ${(size / 1048576).toFixed(1)} MB`);
  } catch (err) {
    await fsp.unlink(partial).catch(() => {});
    throw err;
  }
}

function claimNext(db) {
  return db.prepare(`
    UPDATE photos SET video_status = 'processing', updated_at = datetime('now')
    WHERE id = (SELECT id FROM photos WHERE video_status = 'queued' AND correction_deleted_at IS NULL ORDER BY created_at DESC LIMIT 1)
      AND video_status = 'queued'
    RETURNING *
  `).get();
}

let working = false;

async function drain() {
  if (working || !enabled()) return;
  working = true;
  try {
    const db = getDb();
    let row;
    while ((row = claimNext(db))) {
      try {
        await processRow(row);
      } catch (err) {
        console.error(`${TAG} ${row.id} failed:`, err?.message || err);
        markFailed(db, row.id, err?.message || err);
      }
    }
  } catch (err) {
    console.error(`${TAG} queue error:`, err?.message || err);
  } finally {
    working = false;
  }
}

// Called right after an upload is stored; returns immediately.
function enqueueVideos(photoIds = []) {
  if (!photoIds.length) return;
  const db = getDb();
  const mark = db.prepare(`UPDATE photos SET video_status = 'queued', video_error = NULL WHERE id = ? AND video_status IS NULL`);
  const rows = photoIds.map(id => db.prepare('SELECT id, mime_type, filename FROM photos WHERE id = ?').get(id)).filter(isVideoRow);
  for (const row of rows) mark.run(row.id);
  if (rows.length) setImmediate(drain);
}

// Manual fallback: turn a clip a further `degrees` clockwise from how it shows now.
function requestRotation(photoId, degrees) {
  const db = getDb();
  const row = db.prepare('SELECT id, mime_type, filename, video_rotation, video_status FROM photos WHERE id = ?').get(photoId);
  if (!row || !isVideoRow(row)) return null;
  const next = normalizeRotation((Number(row.video_rotation) || 0) + normalizeRotation(degrees));
  db.prepare(`
    UPDATE photos SET video_rotation = ?, video_orientation_source = 'manual', video_status = 'queued',
      video_error = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(next, photoId);
  setImmediate(drain);
  return next;
}

function start() {
  if (!enabled()) {
    console.log(`${TAG} normalizer disabled (VIDEO_NORMALIZE_ENABLED=false)`);
    return;
  }
  const db = getDb();
  // A restart mid-encode leaves 'processing' rows and .part files behind.
  db.prepare(`UPDATE photos SET video_status = 'queued' WHERE video_status = 'processing'`).run();
  // Backfill every video uploaded before this existed.
  const legacy = db.prepare(`SELECT id, mime_type, filename FROM photos WHERE video_status IS NULL AND correction_deleted_at IS NULL`).all().filter(isVideoRow);
  const mark = db.prepare(`UPDATE photos SET video_status = 'queued' WHERE id = ? AND video_status IS NULL`);
  for (const row of legacy) mark.run(row.id);
  if (legacy.length) console.log(`${TAG} queued ${legacy.length} existing video(s)`);
  setTimeout(drain, 30 * 1000);
  setInterval(drain, POLL_MS).unref();
}

module.exports = { start, enqueueVideos, requestRotation, isVideoRow, displayRotation, normalizeRotation };
