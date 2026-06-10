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
export const MAX_PROGRESS_IMAGE_DIMENSION = 2200;
export const PROGRESS_IMAGE_QUALITY = 0.86;

export type ProgressCaptureSource = 'batch_camera' | 'device_camera' | 'library' | 'desktop' | 'unknown';

const GEOLOCATION_TIMEOUT_MS = 1400;
const IMAGE_TYPES_TO_RESIZE = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
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

function getUploadPosition(): Promise<GeolocationPosition | null> {
  if (!navigator.geolocation) return Promise.resolve(null);

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

function normalizeExifDate(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getFallbackCapturedAt(file: File, now: Date) {
  return new Date(file.lastModified || now.getTime()).toISOString();
}

async function readImageMetadata(file: File): Promise<ImageMetadata> {
  if (!file.type.startsWith('image/')) return {};
  try {
    const metadata = await exifr.parse(file, {
      pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'GPSLatitude', 'GPSLongitude'],
      reviveValues: true,
      translateValues: false,
    });
    if (!metadata) return {};
    return {
      capturedAt: normalizeExifDate(metadata.DateTimeOriginal || metadata.CreateDate || metadata.ModifyDate) || undefined,
      latitude: typeof metadata.GPSLatitude === 'number' ? metadata.GPSLatitude : undefined,
      longitude: typeof metadata.GPSLongitude === 'number' ? metadata.GPSLongitude : undefined,
    };
  } catch {
    return {};
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

async function resizeImage(file: File): Promise<File> {
  if (!IMAGE_TYPES_TO_RESIZE.has(file.type) || file.size < 450 * 1024) return file;

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;

  const longestSide = Math.max(bitmap.width, bitmap.height);
  if (longestSide <= MAX_PROGRESS_IMAGE_DIMENSION) {
    bitmap.close();
    return file;
  }

  const scale = MAX_PROGRESS_IMAGE_DIMENSION / longestSide;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    return file;
  }

  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const outputType = file.type === 'image/png' ? 'image/jpeg' : file.type;
  const blob = await canvasToBlob(canvas, outputType, PROGRESS_IMAGE_QUALITY);
  if (!blob || blob.size >= file.size) return file;

  const nextName = outputType === file.type
    ? file.name
    : file.name.replace(/\.[^.]+$/, '') + '.jpg';
  return new File([blob], nextName, { type: outputType, lastModified: file.lastModified });
}

export async function prepareProgressUploadFile(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  return resizeImage(file).catch(() => file);
}

export async function appendProgressUploadAudit(
  formData: FormData,
  files: File[],
  sources: ProgressCaptureSource[] = [],
  options: ProgressUploadAuditOptions = {}
) {
  const now = new Date();
  const metadata = await Promise.all(files.map(readImageMetadata));
  const capturedValues = files.map((file, index) => metadata[index]?.capturedAt || getFallbackCapturedAt(file, now));
  const latitudes = metadata.map(item => item.latitude ?? null);
  const longitudes = metadata.map(item => item.longitude ?? null);
  const accuracies = metadata.map(item => item.accuracy ?? null);

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

  const position = options.location || options.skipDeviceLocation ? null : await getUploadPosition();
  const firstMetadata = metadata[0];
  const latitude = firstMetadata?.latitude ?? options.location?.latitude ?? position?.coords.latitude;
  const longitude = firstMetadata?.longitude ?? options.location?.longitude ?? position?.coords.longitude;
  const accuracy = firstMetadata?.accuracy ?? options.location?.accuracy ?? position?.coords.accuracy;
  if (latitude === undefined || longitude === undefined) return;

  formData.append('capture_latitude', String(latitude));
  formData.append('capture_longitude', String(longitude));
  if (accuracy !== undefined) formData.append('capture_accuracy', String(accuracy));
  formData.append('gps_latitude', String(latitude));
  formData.append('gps_longitude', String(longitude));
  if (accuracy !== undefined) formData.append('gps_accuracy', String(accuracy));
}
