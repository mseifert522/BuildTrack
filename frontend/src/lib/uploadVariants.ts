// Small WebP copies of uploaded photos (server: backend/src/middleware/imageVariants.js).
// Grids, tiles and banners show a `?w=` copy; the lightbox, downloads and the markup
// editor keep the original file. Anything that is not an uploaded image passes through.
export type UploadVariantWidth = 160 | 480 | 1280;

const VARIANT_SOURCE = /\/uploads\/[^?#]+\.(jpe?g|jpe|jfif|png|webp)(?=$|[?#])/i;
const VARIANT_PARAM = /([?&])w=(160|480|1280)(?=&|#|$)/;

export function uploadThumbSrc(src?: string | null, width: UploadVariantWidth = 480): string {
  const value = String(src || '');
  if (!VARIANT_SOURCE.test(value) || VARIANT_PARAM.test(value)) return value;
  const hashAt = value.indexOf('#');
  const base = hashAt === -1 ? value : value.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : value.slice(hashAt);
  return `${base}${base.includes('?') ? '&' : '?'}w=${width}${hash}`;
}

/** The original file behind a `?w=` copy (what the lightbox opens). */
export function uploadOriginalSrc(src?: string | null): string {
  const value = String(src || '');
  if (!VARIANT_PARAM.test(value)) return value;
  return value
    .replace(VARIANT_PARAM, (_match, separator: string) => (separator === '?' ? '?' : ''))
    .replace('?&', '?')
    .replace(/\?(?=#|$)/, '');
}
