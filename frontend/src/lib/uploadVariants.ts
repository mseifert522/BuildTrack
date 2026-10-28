// Small WebP copies of uploaded photos (server: backend/src/middleware/imageVariants.js).
// Grids, tiles and banners show a `?w=` copy; the lightbox, downloads and the markup
// editor keep the original file. Anything that is not an uploaded image passes through.
export type UploadVariantWidth = 160 | 480 | 1280;
export type UploadPosterWidth = 160 | 480;

const VARIANT_SOURCE = /\/uploads\/[^?#]+\.(jpe?g|jpe|jfif|png|webp)(?=$|[?#])/i;
const VARIANT_PARAM = /([?&])w=(160|480|1280)(?=&|#|$)/;
// 2026-10-28: video tiles show a WebP poster frame instead of opening a range
// request into a 70 MB original just to paint a 100 px square.
const POSTER_SOURCE = /\/uploads\/[^?#]+\.(mp4|mov|m4v|webm|qt|3gp)(?=$|[?#])/i;
const POSTER_PARAM = /([?&])poster=1(?=&|#|$)/;

function appendQuery(value: string, query: string) {
  const hashAt = value.indexOf('#');
  const base = hashAt === -1 ? value : value.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : value.slice(hashAt);
  return `${base}${base.includes('?') ? '&' : '?'}${query}${hash}`;
}

function stripParam(value: string, param: RegExp) {
  return value
    .replace(param, (_match, separator: string) => (separator === '?' ? '?' : ''))
    .replace('?&', '?')
    .replace(/\?(?=#|$)/, '');
}

export function uploadThumbSrc(src?: string | null, width: UploadVariantWidth = 480): string {
  const value = String(src || '');
  if (!VARIANT_SOURCE.test(value) || VARIANT_PARAM.test(value)) return value;
  return appendQuery(value, `w=${width}`);
}

/** `srcSet` for a small tile: the browser picks 160 or 480 by its rendered width and DPR. */
export function uploadThumbSrcSet(src?: string | null): string | undefined {
  const value = String(src || '');
  if (!VARIANT_SOURCE.test(value) || VARIANT_PARAM.test(value)) return undefined;
  return `${uploadThumbSrc(value, 160)} 160w, ${uploadThumbSrc(value, 480)} 480w`;
}

/** `srcSet` for a panel-sized picture (up to a phone's width): 480w or 1280w. */
export function uploadLargeSrcSet(src?: string | null): string | undefined {
  const value = String(src || '');
  if (!VARIANT_SOURCE.test(value) || VARIANT_PARAM.test(value)) return undefined;
  return `${uploadThumbSrc(value, 480)} 480w, ${uploadThumbSrc(value, 1280)} 1280w`;
}

/** True when the URL is an uploaded video the server can make a poster frame for. */
export function hasUploadPoster(src?: string | null): boolean {
  return POSTER_SOURCE.test(String(src || ''));
}

/**
 * WebP poster frame for an uploaded video (`?w=160|480&poster=1`, same login
 * gate and caching as the photo variants). Returns '' for anything else, so
 * callers can fall back to a plain dark tile.
 */
export function uploadPosterSrc(src?: string | null, width: UploadPosterWidth = 480): string {
  const value = String(src || '');
  if (!POSTER_SOURCE.test(value)) return '';
  return appendQuery(stripParam(stripParam(value, VARIANT_PARAM), POSTER_PARAM), `w=${width}&poster=1`);
}

/** `srcSet` for a small video tile's poster (160w/480w). */
export function uploadPosterSrcSet(src?: string | null): string | undefined {
  if (!POSTER_SOURCE.test(String(src || ''))) return undefined;
  return `${uploadPosterSrc(src, 160)} 160w, ${uploadPosterSrc(src, 480)} 480w`;
}

/** The original file behind a `?w=` copy or a `&poster=1` frame (what the lightbox opens). */
export function uploadOriginalSrc(src?: string | null): string {
  const value = String(src || '');
  if (!VARIANT_PARAM.test(value) && !POSTER_PARAM.test(value)) return value;
  return stripParam(stripParam(value, POSTER_PARAM), VARIANT_PARAM);
}
