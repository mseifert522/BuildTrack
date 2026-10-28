import api from './api';

// Cloudflare fronts the public BuildTrack hostnames and rejects request bodies
// over ~100MB. Any single file over the threshold below is sent through the
// chunked endpoints (each piece fits through the proxy) and reassembled
// server-side; a batch whose TOTAL exceeds the multipart limit is split into
// one request per file for the same reason. Small batches keep using the
// original single multipart POST.
export const CHUNKED_UPLOAD_THRESHOLD_BYTES = 45 * 1024 * 1024;
export const MULTIPART_TOTAL_LIMIT_BYTES = 80 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 15 * 1024 * 1024;
// Matches the backend's CHUNKED_MEDIA_MAX_MB default (8192 MB).
export const MAX_MEDIA_FILE_MB = 8192;
export const MAX_MEDIA_FILE_BYTES = MAX_MEDIA_FILE_MB * 1024 * 1024;

export type UploadProgressEvent = { loaded: number; total: number };

export type UploadProjectMediaOptions = {
  /** Query string to append to the photos endpoint, e.g. "?type=progress" */
  query?: string;
  onUploadProgress?: (event: UploadProgressEvent) => void;
};

export type UploadProjectMediaResult = {
  data: { uploaded: number; batch_id: string | null; photos: any[] };
};

// Fields the photos endpoint parses as per-file JSON arrays. When one browser
// batch is split across multiple requests these MUST be sliced so each request
// stays index-aligned with the file it carries.
const PER_FILE_ARRAY_FIELDS = new Set([
  'taken_at_values',
  'captured_at_values',
  'capture_source_values',
  'individual_note_values',
  'label_values',
  'gps_latitude_values',
  'gps_longitude_values',
  'gps_accuracy_values',
]);

type UploadPlan = {
  files: File[];
  scalarFields: Array<[string, string]>;
  arrayFields: Map<string, unknown[]>;
  batchSequenceStart: number | null;
  splittable: boolean;
};

function buildUploadPlan(formData: FormData): UploadPlan {
  const files: File[] = [];
  const scalarFields: Array<[string, string]> = [];
  const arrayFields = new Map<string, unknown[]>();
  let batchSequenceStart: number | null = null;
  let splittable = true;

  formData.forEach((value, key) => {
    if (value instanceof File) {
      if (key === 'photos') files.push(value);
      else splittable = false; // unknown file field — never split this request
      return;
    }
    if (key === 'batch_sequence') {
      const parsed = Number.parseInt(String(value), 10);
      if (Number.isFinite(parsed) && parsed > 0) batchSequenceStart = parsed;
      scalarFields.push([key, String(value)]);
      return;
    }
    if (PER_FILE_ARRAY_FIELDS.has(key)) {
      try {
        const parsed = JSON.parse(String(value));
        if (Array.isArray(parsed)) {
          arrayFields.set(key, parsed);
          return;
        }
      } catch { /* treat as scalar below */ }
    }
    scalarFields.push([key, String(value)]);
  });

  return { files, scalarFields, arrayFields, batchSequenceStart, splittable };
}

function sumBytes(files: File[]) {
  return files.reduce((total, file) => total + file.size, 0);
}

function newBatchId() {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `split-${rand}`;
}

// --- Chunked pieces -----------------------------------------------------------
// 2026-10-28: pieces of one file go up through a small worker pool, but every
// upload in this tab shares MAX_INFLIGHT_CHUNK_PUTS slots. The server still
// buffers each piece in RAM (express.raw, up to 33 MB) inside a 768 MB
// container, so MobilePhotos' 3 parallel files must not multiply that.
const CHUNK_PIECE_CONCURRENCY = 3;
const MAX_INFLIGHT_CHUNK_PUTS = 2;
// A PUT that makes no upload progress for this long is aborted and retried.
// It is a stall watchdog, not an overall timeout, so honest slow links finish.
const CHUNK_STALL_TIMEOUT_MS = 60 * 1000;
const CHUNK_MAX_ATTEMPTS = 6;
const CHUNK_RETRY_BASE_MS = 1000;
const CHUNK_RETRY_MAX_MS = 30 * 1000;
const OFFLINE_WAIT_CAP_MS = 2 * 60 * 1000;
const INIT_MAX_ATTEMPTS = 3;
// Server sessions live 24 h from the last piece; stay safely inside that.
const RESUME_MAX_AGE_MS = 20 * 60 * 60 * 1000;
const RESUME_STORAGE_PREFIX = 'buildtrack-chunked-upload:';
// 2026-10-28: records are shared by every tab on this origin, and a live upload
// rewrites its record after every piece (and before every complete attempt).
// Only a record untouched this long may be freed on another upload's behalf.
const RESUME_IDLE_MS = 10 * 60 * 1000;
// Each kept session holds its pieces on the server (up to 10 per user); keep
// at most this many per browser, dropping the oldest idle ones first.
const RESUME_MAX_REMEMBERED = 3;
// Audit fields that legitimately change between two attempts of the same
// file; everything else (note, label, purpose, project) must match to resume,
// because a resumed session is finished with the fields it was started with.
const RESUME_VOLATILE_FIELDS = new Set([
  'batch_id',
  'upload_session_id',
  'batch_sequence',
  'capture_recorded_at',
  'capture_latitude',
  'capture_longitude',
  'capture_accuracy',
  'gps_latitude',
  'gps_longitude',
  'gps_accuracy',
  'gps_latitude_values',
  'gps_longitude_values',
  'gps_accuracy_values',
]);

let inflightChunkPuts = 0;
const chunkPutWaiters: Array<() => void> = [];
// Files this tab is uploading right now; a second concurrent upload of the
// same file never shares (or overwrites) the first one's resume record.
const activeResumeKeys = new Set<string>();

function acquireChunkPutSlot(): Promise<void> {
  if (inflightChunkPuts < MAX_INFLIGHT_CHUNK_PUTS) {
    inflightChunkPuts += 1;
    return Promise.resolve();
  }
  return new Promise(resolve => chunkPutWaiters.push(resolve));
}

function releaseChunkPutSlot() {
  const next = chunkPutWaiters.shift();
  // Hand the slot straight to the next waiter; the in-flight count is unchanged.
  if (next) next();
  else inflightChunkPuts = Math.max(0, inflightChunkPuts - 1);
}

type ChunkResumeRecord = {
  uploadId: string;
  projectId: string;
  chunkSize: number;
  totalChunks: number;
  fingerprint: string;
  done: number[];
  savedAt: number;
  // Set before the first complete POST: the server may already have saved the
  // file, so a later "session gone" must not start the upload over.
  completing?: boolean;
};

type ChunkResumeHandle = { key: string; fingerprint: string };

// Thrown inside a session that cannot be finished (gone on the server, or
// complete reports missing pieces); the caller starts one fresh session.
class ChunkSessionRestart extends Error {
  readonly original: unknown;
  constructor(original: unknown) {
    super('The upload session must be started again');
    this.original = original;
  }
}

function errorStatus(err: unknown): number | undefined {
  const status = (err as any)?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

function isRetryableStatus(status: number | undefined) {
  return status === undefined || status >= 500 || status === 408 || status === 429;
}

// 401 is left alone: the api interceptor sends the user to log in, and the
// session should still be there to resume afterwards.
function isRejectedForGood(status: number | undefined) {
  return status !== undefined && status !== 401 && !isRetryableStatus(status);
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

function waitForOnline(): Promise<void> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || navigator.onLine !== false) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener('online', done);
      resolve();
    };
    timer = setTimeout(done, OFFLINE_WAIT_CAP_MS);
    window.addEventListener('online', done);
  });
}

// Exponential backoff with jitter (1, 2, 4, 8, 16 s, never more than 30 s),
// then wait (capped) for the connection to come back if the phone is offline.
async function waitBeforeRetry(retryNumber: number) {
  const base = Math.min(CHUNK_RETRY_MAX_MS, CHUNK_RETRY_BASE_MS * 2 ** Math.max(0, retryNumber - 1));
  await sleep(Math.round(base * (0.8 + Math.random() * 0.4)));
  await waitForOnline();
}

function resumeKeyFor(projectId: string, file: File) {
  return `${RESUME_STORAGE_PREFIX}${projectId}|${file.name}|${file.size}|${file.lastModified}`;
}

function resumeFingerprint(file: File, fields: Record<string, string>, query: string) {
  const stable = Object.keys(fields)
    .filter(key => !RESUME_VOLATILE_FIELDS.has(key))
    .sort()
    .map(key => [key, fields[key]]);
  return JSON.stringify([file.type || '', query, stable]);
}

function readResumeRecord(key: string): ChunkResumeRecord | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const valid = Boolean(parsed)
      && typeof parsed.uploadId === 'string' && parsed.uploadId.length > 0
      && typeof parsed.projectId === 'string'
      && Number.isInteger(parsed.chunkSize) && parsed.chunkSize > 0
      && Number.isInteger(parsed.totalChunks) && parsed.totalChunks > 0
      && typeof parsed.fingerprint === 'string'
      && Array.isArray(parsed.done)
      && typeof parsed.savedAt === 'number';
    if (!valid || Date.now() - parsed.savedAt > RESUME_MAX_AGE_MS) {
      window.localStorage.removeItem(key);
      // Free the server session too, so it does not count against the cap.
      if (parsed && typeof parsed.uploadId === 'string' && parsed.uploadId && typeof parsed.projectId === 'string' && parsed.projectId) {
        void deleteChunkSession(parsed.projectId, parsed.uploadId);
      }
      return null;
    }
    const totalChunks: number = parsed.totalChunks;
    const done = (parsed.done as unknown[]).filter(
      (index): index is number => Number.isInteger(index) && (index as number) >= 0 && (index as number) < totalChunks
    );
    return {
      uploadId: parsed.uploadId,
      projectId: parsed.projectId,
      chunkSize: parsed.chunkSize,
      totalChunks,
      fingerprint: parsed.fingerprint,
      done,
      savedAt: parsed.savedAt,
      completing: parsed.completing === true,
    };
  } catch {
    return null;
  }
}

function writeResumeRecord(key: string, record: ChunkResumeRecord) {
  try {
    window.localStorage.setItem(key, JSON.stringify({ ...record, savedAt: Date.now() }));
  } catch { /* storage full or blocked: the upload still works, it just cannot resume */ }
}

function clearResumeRecord(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch { /* best-effort */ }
}

function listResumeKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && key.startsWith(RESUME_STORAGE_PREFIX)) keys.push(key);
    }
  } catch { /* storage blocked */ }
  return keys;
}

function deleteChunkSession(projectId: string, uploadId: string): Promise<void> {
  return api.delete(`/projects/${projectId}/photos/chunked/${uploadId}`)
    .then(() => undefined, () => undefined); // best-effort
}

function isIdleResumeRecord(record: ChunkResumeRecord) {
  return Date.now() - record.savedAt >= RESUME_IDLE_MS;
}

// The server allows 10 open sessions per user. Sessions kept for resume count
// against that, so when init says "too many", give up the idle ones (not in
// use by this tab, and not touched lately by any other tab) and try once more.
async function releaseIdleResumeSessions() {
  let released = 0;
  await Promise.all(listResumeKeys().filter(key => !activeResumeKeys.has(key)).map(async key => {
    const record = readResumeRecord(key);
    if (!record || !isIdleResumeRecord(record)) return;
    clearResumeRecord(key);
    released += 1;
    await deleteChunkSession(record.projectId, record.uploadId);
  }));
  return released;
}

// Before a new session is remembered, make room under RESUME_MAX_REMEMBERED
// by dropping the oldest idle records (and their server sessions).
function pruneRememberedSessions() {
  const records = listResumeKeys()
    .filter(key => !activeResumeKeys.has(key))
    .map(key => ({ key, record: readResumeRecord(key) }))
    .filter((entry): entry is { key: string; record: ChunkResumeRecord } => entry.record !== null);
  const excess = records.length - (RESUME_MAX_REMEMBERED - 1);
  if (excess <= 0) return;
  records
    .filter(entry => isIdleResumeRecord(entry.record))
    .sort((a, b) => a.record.savedAt - b.record.savedAt)
    .slice(0, excess)
    .forEach(entry => {
      clearResumeRecord(entry.key);
      void deleteChunkSession(entry.record.projectId, entry.record.uploadId);
    });
}

/**
 * Explicit cancel: forget a remembered (resumable) chunked upload of this file
 * and delete its server session. A no-op for files that never used one or are
 * uploading right now.
 */
export function discardChunkedUploadResume(projectId: string, file: File) {
  const key = resumeKeyFor(projectId, file);
  if (activeResumeKeys.has(key)) return;
  const record = readResumeRecord(key);
  clearResumeRecord(key);
  if (record) void deleteChunkSession(record.projectId, record.uploadId);
}

async function putChunkWithWatchdog(url: string, piece: Blob, onLoaded: (loaded: number) => void) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), CHUNK_STALL_TIMEOUT_MS);
  };
  arm();
  try {
    await api.put(url, piece, {
      headers: { 'Content-Type': 'application/octet-stream' },
      signal: controller.signal,
      onUploadProgress: event => {
        arm();
        onLoaded(Math.min(event.loaded, piece.size));
      },
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function initChunkSession(
  projectId: string,
  file: File,
  fields: Record<string, string>,
  chunkSize: number,
  totalChunks: number
): Promise<string> {
  let freedSessions = false;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const init = await api.post(`/projects/${projectId}/photos/chunked/init`, {
        file_name: file.name,
        file_size: file.size,
        mime_type: file.type || '',
        chunk_size: chunkSize,
        total_chunks: totalChunks,
        fields,
      });
      const uploadId = String(init.data?.upload_id || '');
      if (!uploadId) throw new Error('The server did not start the upload session');
      return uploadId;
    } catch (err) {
      const status = errorStatus(err);
      if (status === 429 && !freedSessions) {
        freedSessions = true;
        if (await releaseIdleResumeSessions()) continue;
      }
      if (status === 429 || !isRetryableStatus(status) || attempt >= INIT_MAX_ATTEMPTS) throw err;
      await waitBeforeRetry(attempt);
    }
  }
}

async function runChunkedSession(
  projectId: string,
  file: File,
  fields: Record<string, string>,
  query: string,
  resume: ChunkResumeHandle | null,
  onProgress?: (loadedBytesOfFile: number) => void
) {
  // Reuse the session remembered for this exact file (and the same note,
  // label and purpose), skipping the pieces the server already has.
  const remembered = resume ? readResumeRecord(resume.key) : null;
  const reusable = remembered
    && resume
    && remembered.projectId === projectId
    && remembered.fingerprint === resume.fingerprint
    && remembered.totalChunks === Math.max(1, Math.ceil(file.size / remembered.chunkSize))
    ? remembered
    : null;
  if (resume && remembered && !reusable) {
    // The note, label or purpose changed: nothing can resume that session any
    // more, so free its pieces on the server instead of orphaning them.
    clearResumeRecord(resume.key);
    void deleteChunkSession(remembered.projectId, remembered.uploadId);
  }
  if (resume && !reusable) pruneRememberedSessions();

  const chunkSize = reusable ? reusable.chunkSize : UPLOAD_CHUNK_BYTES;
  const totalChunks = reusable ? reusable.totalChunks : Math.max(1, Math.ceil(file.size / chunkSize));
  const uploadId = reusable ? reusable.uploadId : await initChunkSession(projectId, file, fields, chunkSize, totalChunks);
  const done = new Set<number>(reusable ? reusable.done : []);
  const record: ChunkResumeRecord = {
    uploadId,
    projectId,
    chunkSize,
    totalChunks,
    fingerprint: resume ? resume.fingerprint : '',
    done: [...done],
    savedAt: Date.now(),
  };
  const remember = () => {
    if (resume) writeResumeRecord(resume.key, { ...record, done: [...done] });
  };
  const forget = () => {
    if (resume) clearResumeRecord(resume.key);
  };
  const discardSession = () => {
    forget();
    void deleteChunkSession(projectId, uploadId);
  };
  remember();

  // Progress is the sum of bytes sent per piece; finished pieces count in full.
  const pieceSize = (index: number) => Math.min(chunkSize, file.size - index * chunkSize);
  const loadedByIndex: number[] = Array.from({ length: totalChunks }, (_, index) => (done.has(index) ? pieceSize(index) : 0));
  let reportedLoaded = 0;
  const report = () => {
    const loaded = loadedByIndex.reduce((total, value) => total + value, 0);
    reportedLoaded = Math.max(reportedLoaded, Math.min(file.size, loaded));
    onProgress?.(reportedLoaded);
  };
  if (done.size) report();

  const pending = Array.from({ length: totalChunks }, (_, index) => index).filter(index => !done.has(index));
  // Written by the workers; typed via `as` so control-flow analysis does not
  // narrow it to `null` after the awaited pool.
  let firstError = null as unknown;
  let cursor = 0;

  const sendPiece = async (index: number) => {
    const start = index * chunkSize;
    const piece = file.slice(start, start + pieceSize(index));
    const url = `/projects/${projectId}/photos/chunked/${uploadId}/${index}`;
    let lastError: unknown = new Error('Upload stopped');
    for (let attempt = 1; attempt <= CHUNK_MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await waitBeforeRetry(attempt - 1);
      // Another piece already failed for good: stop spending time on this file.
      if (firstError) throw lastError;
      await acquireChunkPutSlot();
      try {
        await putChunkWithWatchdog(url, piece, loaded => {
          loadedByIndex[index] = loaded;
          report();
        });
        loadedByIndex[index] = piece.size;
        report();
        done.add(index);
        remember();
        return;
      } catch (err) {
        lastError = err;
        const status = errorStatus(err);
        if (status === 404 || status === 410) throw new ChunkSessionRestart(err);
        if (!isRetryableStatus(status)) throw err;
        loadedByIndex[index] = 0;
      } finally {
        releaseChunkPutSlot();
      }
    }
    throw lastError;
  };

  const worker = async () => {
    while (!firstError && cursor < pending.length) {
      const index = pending[cursor];
      cursor += 1;
      try {
        await sendPiece(index);
      } catch (err) {
        if (!firstError) firstError = err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHUNK_PIECE_CONCURRENCY, pending.length) }, () => worker()));

  if (firstError) {
    if (firstError instanceof ChunkSessionRestart) forget();
    // A rejected piece (wrong size, bad index, forbidden) will never succeed:
    // drop the session. Transient failures keep it so Retry resumes.
    else if (isRejectedForGood(errorStatus(firstError))) discardSession();
    throw firstError;
  }

  // Completion (reassembly + DB insert) is retryable server-side: the pieces
  // survive a failed attempt, so retry before giving up on the whole file.
  // A record left mid-complete by an earlier run counts as ambiguous too.
  let ambiguousAttempt = Boolean(reusable?.completing);
  for (let attempt = 1; ; attempt += 1) {
    // Also refreshes savedAt, so another tab never frees a session mid-complete.
    if (resume) writeResumeRecord(resume.key, { ...record, done: [...done], completing: true });
    try {
      const response = await api.post(`/projects/${projectId}/photos/chunked/${uploadId}/complete${query}`, {});
      forget();
      return response.data;
    } catch (err: any) {
      const status = errorStatus(err);
      if (status === 404 || status === 410) {
        forget();
        // An earlier attempt may have finished on the server after its
        // response was lost; starting over could store the file twice.
        if (ambiguousAttempt) {
          const unsure: any = new Error('The upload may already be saved. Refresh the photos before trying again.');
          unsure.response = { status, data: { error: unsure.message } };
          throw unsure;
        }
        throw new ChunkSessionRestart(err);
      }
      if (status === 409 && /already being finished/i.test(String(err?.response?.data?.error || ''))) {
        ambiguousAttempt = true;
        if (attempt >= CHUNK_MAX_ATTEMPTS) throw err;
        await waitBeforeRetry(attempt);
        continue;
      }
      if (status === 409) {
        // Missing pieces or a size mismatch: this session cannot be finished.
        discardSession();
        throw new ChunkSessionRestart(err);
      }
      // 2026-10-28: a network error, timeout or any 5xx (Cloudflare 524 while a
      // multi-GB join runs past 100 s, a 502 during the blue-green switch) may
      // have reached the server, which then consumes the session. A 404 after
      // that means "probably saved", never "start over". Our own 500 restores
      // the manifest, so it never leads to a 404.
      if (isRetryableStatus(status)) ambiguousAttempt = true;
      if (!isRetryableStatus(status) || attempt >= CHUNK_MAX_ATTEMPTS) {
        if (isRejectedForGood(status)) discardSession();
        throw err;
      }
      await waitBeforeRetry(attempt);
    }
  }
}

async function uploadFileChunked(
  projectId: string,
  file: File,
  fields: Record<string, string>,
  query: string,
  onProgress?: (loadedBytesOfFile: number) => void
) {
  const key = resumeKeyFor(projectId, file);
  const ownsResume = !activeResumeKeys.has(key);
  if (ownsResume) activeResumeKeys.add(key);
  const resume: ChunkResumeHandle | null = ownsResume
    ? { key, fingerprint: resumeFingerprint(file, fields, query) }
    : null;
  try {
    let restarted = false;
    for (;;) {
      try {
        return await runChunkedSession(projectId, file, fields, query, resume, onProgress);
      } catch (err) {
        if (!(err instanceof ChunkSessionRestart)) throw err;
        // One fresh session, sent from piece 0; a second failure is real.
        if (restarted) throw err.original;
        restarted = true;
      }
    }
  } finally {
    if (ownsResume) activeResumeKeys.delete(key);
  }
}

/**
 * Drop-in replacement for `api.post('/projects/{id}/photos{query}', formData)`.
 * Oversized files (or oversized batches) are split into one request per file —
 * chunked when the file itself is too big — with per-file audit fields sliced
 * correctly and every response merged into the standard
 * `{ uploaded, batch_id, photos }` shape in the original file order.
 * On a mid-batch failure the thrown error carries `partialUpload` with what
 * had already been committed.
 */
export async function uploadProjectMedia(
  projectId: string,
  formData: FormData,
  options: UploadProjectMediaOptions = {}
): Promise<UploadProjectMediaResult> {
  const query = options.query || '';
  const url = `/projects/${projectId}/photos${query}`;
  const plan = buildUploadPlan(formData);
  const totalBytes = Math.max(1, sumBytes(plan.files));
  const needsSplit = plan.splittable && plan.files.length > 0 && (
    plan.files.some(file => file.size > CHUNKED_UPLOAD_THRESHOLD_BYTES)
    || (plan.files.length > 1 && totalBytes > MULTIPART_TOTAL_LIMIT_BYTES)
  );

  // Progress must never move backwards, even when a failed piece is retried
  // from zero.
  let maxReportedLoaded = 0;
  const emitProgress = (loaded: number) => {
    maxReportedLoaded = Math.max(maxReportedLoaded, Math.min(totalBytes, loaded));
    options.onUploadProgress?.({ loaded: maxReportedLoaded, total: totalBytes });
  };

  if (!needsSplit) {
    const response = await api.post(url, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: event => emitProgress(Math.min(event.loaded, totalBytes)),
    });
    return { data: response.data };
  }

  // Every split request must share one batch id so all the files land in the
  // same upload batch (and storage folder) like the unsplit request would.
  const scalarFields = new Map(plan.scalarFields);
  scalarFields.delete('batch_sequence');
  if (!scalarFields.get('batch_id') && !scalarFields.get('upload_session_id')) {
    const batchId = newBatchId();
    scalarFields.set('batch_id', batchId);
    scalarFields.set('upload_session_id', batchId);
  }

  const merged: UploadProjectMediaResult['data'] = { uploaded: 0, batch_id: null, photos: [] };
  const absorb = (data: any) => {
    merged.uploaded += Number(data?.uploaded || 0);
    if (!merged.batch_id && data?.batch_id) merged.batch_id = String(data.batch_id);
    if (Array.isArray(data?.photos)) merged.photos.push(...data.photos);
  };

  const fieldsForIndex = (index: number) => {
    const fields: Record<string, string> = {};
    scalarFields.forEach((value, key) => { fields[key] = value; });
    plan.arrayFields.forEach((values, key) => {
      fields[key] = JSON.stringify([values[index] ?? null]);
    });
    // Explicit unique sequence per file — this is what keeps generated
    // filenames from colliding across the split requests.
    fields.batch_sequence = String((plan.batchSequenceStart ?? 1) + index);
    return fields;
  };

  let uploadedBase = 0;
  try {
    for (let index = 0; index < plan.files.length; index += 1) {
      const file = plan.files[index];
      const fields = fieldsForIndex(index);

      if (file.size > CHUNKED_UPLOAD_THRESHOLD_BYTES) {
        const data = await uploadFileChunked(projectId, file, fields, query, loaded => emitProgress(uploadedBase + loaded));
        absorb(data);
      } else {
        const fd = new FormData();
        for (const [key, value] of Object.entries(fields)) fd.append(key, value);
        fd.append('photos', file);
        const response = await api.post(url, fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
          onUploadProgress: event => emitProgress(uploadedBase + Math.min(event.loaded, file.size)),
        });
        absorb(response.data);
      }

      uploadedBase += file.size;
      emitProgress(uploadedBase);
    }
  } catch (err: any) {
    // Surface what already landed so callers can report partial success.
    if (err && typeof err === 'object') err.partialUpload = { ...merged, photos: [...merged.photos] };
    throw err;
  }

  return { data: merged };
}
