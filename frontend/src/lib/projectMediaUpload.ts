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

async function uploadFileChunked(
  projectId: string,
  file: File,
  fields: Record<string, string>,
  query: string,
  onProgress?: (loadedBytesOfFile: number) => void
) {
  const totalChunks = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK_BYTES));
  const init = await api.post(`/projects/${projectId}/photos/chunked/init`, {
    file_name: file.name,
    file_size: file.size,
    mime_type: file.type || '',
    chunk_size: UPLOAD_CHUNK_BYTES,
    total_chunks: totalChunks,
    fields,
  });
  const uploadId = String(init.data?.upload_id || '');
  if (!uploadId) throw new Error('The server did not start the upload session');

  try {
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * UPLOAD_CHUNK_BYTES;
      const piece = file.slice(start, Math.min(start + UPLOAD_CHUNK_BYTES, file.size));
      let attempt = 0;
      // Retry transient failures — a single piece is cheap to resend, and this
      // is what keeps multi-GB uploads from dying on one network blip.
      for (;;) {
        try {
          await api.put(`/projects/${projectId}/photos/chunked/${uploadId}/${index}`, piece, {
            headers: { 'Content-Type': 'application/octet-stream' },
            onUploadProgress: event => onProgress?.(start + Math.min(event.loaded, piece.size)),
          });
          break;
        } catch (err: any) {
          const status = err?.response?.status;
          const retryable = !status || status >= 500 || status === 408 || status === 429;
          if (!retryable || attempt >= 2) throw err;
          attempt += 1;
          await new Promise(resolve => setTimeout(resolve, 1200 * attempt));
        }
      }
      onProgress?.(start + piece.size);
    }

    // Completion (reassembly + DB insert) is retryable server-side: the pieces
    // survive a failed attempt, so retry before giving up on the whole file.
    let completeAttempt = 0;
    for (;;) {
      try {
        const done = await api.post(`/projects/${projectId}/photos/chunked/${uploadId}/complete${query}`, {});
        return done.data;
      } catch (err: any) {
        const status = err?.response?.status;
        const retryable = !status || status >= 500;
        if (!retryable || completeAttempt >= 2) throw err;
        completeAttempt += 1;
        await new Promise(resolve => setTimeout(resolve, 1500 * completeAttempt));
      }
    }
  } catch (err) {
    api.delete(`/projects/${projectId}/photos/chunked/${uploadId}`).catch(() => { /* best-effort */ });
    throw err;
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
