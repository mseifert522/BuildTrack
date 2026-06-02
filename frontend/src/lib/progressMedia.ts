export type ProgressMediaItem = {
  filename?: string | null;
  original_name?: string | null;
  mime_type?: string | null;
  type?: string | null;
  name?: string | null;
};

export type ProgressMediaKind = 'image' | 'video' | 'file';

const VIDEO_EXTENSIONS = /\.(mp4|mov|qt|m4v|webm|avi|mkv|mpe?g|3gp|3g2|hevc|mts|m2ts)$/i;
const BROWSER_IMAGE_EXTENSIONS = /\.(avif|bmp|gif|jpe?g|jfif|pjpeg|pjp|png|webp)$/i;
const UNSUPPORTED_IMAGE_EXTENSIONS = /\.(dib|dng|heic|heif|tiff?)$/i;
const BROWSER_IMAGE_MIME_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

function mediaName(item: ProgressMediaItem) {
  return String(item.filename || item.name || item.original_name || '');
}

function mediaMime(item: ProgressMediaItem) {
  return String(item.mime_type || item.type || '').toLowerCase();
}

export function isVideoMedia(item: ProgressMediaItem) {
  const mime = mediaMime(item);
  return mime.startsWith('video/') || VIDEO_EXTENSIONS.test(mediaName(item));
}

export function isBrowserImageMedia(item: ProgressMediaItem) {
  const mime = mediaMime(item);
  const name = mediaName(item);
  if (mime && BROWSER_IMAGE_MIME_TYPES.has(mime)) return true;
  if (UNSUPPORTED_IMAGE_EXTENSIONS.test(name)) return false;
  return BROWSER_IMAGE_EXTENSIONS.test(name);
}

export function getProgressMediaKind(item: ProgressMediaItem): ProgressMediaKind {
  if (isVideoMedia(item)) return 'video';
  if (isBrowserImageMedia(item)) return 'image';
  return 'file';
}
