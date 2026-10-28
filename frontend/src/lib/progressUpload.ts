import exifr from 'exifr';

export const MAX_PROGRESS_UPLOAD_BATCH_FILES = 100;

export const PROGRESS_IMAGE_EXTENSIONS = [
  '.avif',
  '.bmp',
  '.dib',
  '.gif',
  '.heic',
  '.heif',
  '.jpeg',
  '.jpg',
  '.jpe',
  '.jfif',
  '.pjpeg',
  '.pjp',
  '.png',
  '.tif',
  '.tiff',
  '.webp',
  '.dng',
];

export const PROGRESS_VIDEO_EXTENSIONS = [
  '.mp4',
  '.mov',
  '.qt',
  '.m4v',
  '.webm',
  '.avi',
  '.mkv',
  '.mpeg',
  '.mpg',
  '.3gp',
  '.3g2',
  '.hevc',
  '.mts',
  '.m2ts',
];

export const PROGRESS_MEDIA_EXTENSIONS = [
  ...PROGRESS_IMAGE_EXTENSIONS,
  ...PROGRESS_VIDEO_EXTENSIONS,
];

export const PROGRESS_MEDIA_ACCEPT = [
  'image/*',
  'video/*',
  ...PROGRESS_MEDIA_EXTENSIONS,
].join(',');

export type ProgressCaptureSource = 'batch_camera' | 'device_camera' | 'library' | 'desktop' | 'unknown';

const GEOLOCATION_TIMEOUT_MS = 6500;
// 2026-10-28: one shared fix per burst of uploads. Before this every file
// waited up to 6.5 s on its own GPS request (and a failure was never
// remembered), so 60 library photos indoors sat idle for about two minutes.
const UPLOAD_POSITION_SUCCESS_TTL_MS = 120 * 1000;
const UPLOAD_POSITION_FAILURE_TTL_MS = 45 * 1000;
// Desktop browsers often hand .heic (and some .dng/.tif) files over with an
// empty MIME type; exifr reads them fine, so fall back to the extension.
const EXIF_IMAGE_EXTENSION = /\.(jpe?g|heic|heif|tiff?|png|webp|avif|dng)$/i;
const PROGRESS_MEDIA_EXTENSION_SET = new Set(PROGRESS_MEDIA_EXTENSIONS);

export function isSupportedProgressMediaFile(file: File) {
  const mime = String(file.type || '').toLowerCase();
  const name = String(file.name || '').toLowerCase();
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  if (mime.startsWith('image/') || mime.startsWith('video/')) return true;
  if (PROGRESS_MEDIA_EXTENSION_SET.has(extension)) return true;
  return ['application/mp4', 'application/quicktime', 'application/octet-stream'].includes(mime)
    && PROGRESS_MEDIA_EXTENSION_SET.has(extension);
}

export interface ProgressUploadAuditOptions {
  batchId?: string;
  batchNote?: string;
  labels?: string[];
  individualNotes?: string[];
  timezone?: string;
  batchSequenceStart?: number;
  location?: ProgressUploadLocation | null;
  skipDeviceLocation?: boolean;
  projectId?: string;
}

export interface ProgressUploadLocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

interface ImageMetadata {
  capturedAt?: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
}

function isValidGpsPair(latitude: unknown, longitude: unknown) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  return !(Math.abs(lat) < 0.00001 && Math.abs(lng) < 0.00001);
}

function normalizeUploadLocation(value?: Partial<ProgressUploadLocation> | null): ProgressUploadLocation | null {
  if (!value || !isValidGpsPair(value.latitude, value.longitude)) return null;
  const accuracy = Number(value.accuracy);
  return {
    latitude: Number(value.latitude),
    longitude: Number(value.longitude),
    ...(Number.isFinite(accuracy) && accuracy >= 0 ? { accuracy } : {}),
  };
}

let uploadPositionInFlight: Promise<GeolocationPosition | null> | null = null;
let uploadPositionCache: { at: number; position: GeolocationPosition | null } | null = null;

function requestUploadPosition(): Promise<GeolocationPosition | null> {
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      position => resolve(position),
      () => resolve(null),
      {
        enableHighAccuracy: true,
        maximumAge: 2 * 60 * 1000,
        timeout: GEOLOCATION_TIMEOUT_MS,
      }
    );
  });
}

// Every concurrent upload shares one in-flight request; a fix is reused for
// 120 s and a failure/timeout for 45 s so a dead GPS costs one wait, not one
// per file.
function getUploadPosition(): Promise<GeolocationPosition | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
  const cached = uploadPositionCache;
  if (cached) {
    const ttl = cached.position ? UPLOAD_POSITION_SUCCESS_TTL_MS : UPLOAD_POSITION_FAILURE_TTL_MS;
    if (Date.now() - cached.at < ttl) return Promise.resolve(cached.position);
  }
  if (uploadPositionInFlight) return uploadPositionInFlight;
  const request = requestUploadPosition()
    .catch(() => null)
    .then(position => {
      uploadPositionCache = { at: Date.now(), position };
      return position;
    })
    .finally(() => {
      if (uploadPositionInFlight === request) uploadPositionInFlight = null;
    });
  uploadPositionInFlight = request;
  return request;
}

function normalizeExifDate(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getFallbackCapturedAt(file: File, now: Date) {
  return new Date(file.lastModified || now.getTime()).toISOString();
}

async function readImageMetadata(file: File): Promise<ImageMetadata> {
  if (!file.type.startsWith('image/') && !EXIF_IMAGE_EXTENSION.test(file.name)) return {};
  try {
    const metadata = await exifr.parse(file, {
      pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'GPSLatitude', 'GPSLongitude'],
      reviveValues: true,
      translateValues: false,
    });
    if (!metadata) return {};
    const latitude = typeof metadata.GPSLatitude === 'number' ? metadata.GPSLatitude : undefined;
    const longitude = typeof metadata.GPSLongitude === 'number' ? metadata.GPSLongitude : undefined;
    const exifLocation = normalizeUploadLocation({ latitude, longitude });
    return {
      capturedAt: normalizeExifDate(metadata.DateTimeOriginal || metadata.CreateDate || metadata.ModifyDate) || undefined,
      latitude: exifLocation?.latitude,
      longitude: exifLocation?.longitude,
      accuracy: exifLocation?.accuracy,
    };
  } catch {
    return {};
  }
}

// 2026-10-28: uploads keep the original file. This used to shrink photos to
// 2200 px, re-save them as JPEG 0.86 and turn PNGs into JPEGs, which broke the
// owner's no-quality-loss rule and stripped EXIF. Grids already load the
// server's small WebP variants, so display speed does not depend on it.
export async function prepareProgressUploadFile(file: File): Promise<File> {
  return file;
}

export async function appendProgressUploadAudit(
  formData: FormData,
  files: File[],
  sources: ProgressCaptureSource[] = [],
  options: ProgressUploadAuditOptions = {}
) {
  const now = new Date();
  const projectId = String(options.projectId || '').trim();
  if (projectId) {
    formData.set('capture_project_id', projectId);
    formData.set('client_project_id', projectId);
  }
  const metadata = await Promise.all(files.map(readImageMetadata));
  const capturedValues = files.map((file, index) => metadata[index]?.capturedAt || getFallbackCapturedAt(file, now));
  const metadataLocations = metadata.map(item => normalizeUploadLocation(item));
  // Only wait on the phone's GPS when some file has no EXIF location of its own.
  const needsLiveDeviceLocation = sources.some(source => source === 'device_camera' || source === 'batch_camera' || source === 'library')
    && metadataLocations.some(location => !location);
  const optionLocation = normalizeUploadLocation(options.location);
  const position = optionLocation || options.skipDeviceLocation || !needsLiveDeviceLocation ? null : await getUploadPosition();
  const liveLocation = optionLocation || normalizeUploadLocation(position?.coords);
  const latitudes = metadataLocations.map(item => item?.latitude ?? liveLocation?.latitude ?? null);
  const longitudes = metadataLocations.map(item => item?.longitude ?? liveLocation?.longitude ?? null);
  const accuracies = metadataLocations.map(item => item?.accuracy ?? liveLocation?.accuracy ?? null);

  formData.append('taken_at_values', JSON.stringify(capturedValues));
  formData.append('captured_at_values', JSON.stringify(capturedValues));
  formData.append('capture_recorded_at', now.toISOString());
  formData.append('capture_source_values', JSON.stringify(
    files.map((_, index) => sources[index] || 'unknown')
  ));
  formData.append('upload_session_id', options.batchId || `${now.getTime()}-${Math.random().toString(36).slice(2, 10)}`);
  formData.append('batch_id', options.batchId || formData.get('upload_session_id') as string);
  formData.append('timezone', options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  if (options.batchNote) formData.append('batch_note', options.batchNote);
  if (options.labels) formData.append('label_values', JSON.stringify(options.labels));
  if (options.individualNotes) formData.append('individual_note_values', JSON.stringify(options.individualNotes));
  if (options.batchSequenceStart) formData.append('batch_sequence', String(options.batchSequenceStart));
  if (latitudes.some(value => value !== null)) formData.append('gps_latitude_values', JSON.stringify(latitudes));
  if (longitudes.some(value => value !== null)) formData.append('gps_longitude_values', JSON.stringify(longitudes));
  if (accuracies.some(value => value !== null)) formData.append('gps_accuracy_values', JSON.stringify(accuracies));

  const firstLocation = metadataLocations[0] || liveLocation;
  if (!firstLocation) return;

  formData.append('capture_latitude', String(firstLocation.latitude));
  formData.append('capture_longitude', String(firstLocation.longitude));
  if (firstLocation.accuracy !== undefined) formData.append('capture_accuracy', String(firstLocation.accuracy));
  formData.append('gps_latitude', String(firstLocation.latitude));
  formData.append('gps_longitude', String(firstLocation.longitude));
  if (firstLocation.accuracy !== undefined) formData.append('gps_accuracy', String(firstLocation.accuracy));
}
