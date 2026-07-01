// Photo markup + note helpers shared by punch-list (FUNCTION 1) and field-update
// (FUNCTION 2) UI. The markup overlay is a SEPARATE image saved alongside the
// original; the original photo file is never modified.
import api from './api';

export type MarkupPhoto = {
  id: string;
  project_id?: string | null;
  filename?: string | null;
  original_name?: string | null;
  mime_type?: string | null;
  markup_path?: string | null;
  markup_url?: string | null;
  markup_json?: string | null;
  markup_drawn_at?: string | null;
  original_url?: string | null;
  caption?: string | null;
  individual_note?: string | null;
  note_text?: string | null;
};

function uploadsUrl(projectId: string, relativePath?: string | null): string {
  if (!relativePath) return '';
  return `/uploads/${projectId}/${relativePath}`;
}

/** The unmodified original image src. */
export function photoOriginalSrc(projectId: string, photo: MarkupPhoto): string {
  return photo.original_url || uploadsUrl(projectId, photo.filename) || '';
}

/** The marked-up overlay src, or null when the photo has no markup. */
export function photoMarkupSrc(projectId: string, photo: MarkupPhoto): string | null {
  if (photo.markup_url) return photo.markup_url;
  if (photo.markup_path) return uploadsUrl(projectId, photo.markup_path);
  return null;
}

/** What to DISPLAY: the marked-up overlay when present, otherwise the original. */
export function photoDisplaySrc(projectId: string, photo: MarkupPhoto): string {
  return photoMarkupSrc(projectId, photo) || photoOriginalSrc(projectId, photo);
}

export function hasMarkup(photo: MarkupPhoto): boolean {
  return Boolean(photo.markup_path || photo.markup_url);
}

/** Best-available note text already attached to the photo. */
export function photoNoteText(photo: MarkupPhoto): string {
  return String(photo.individual_note || photo.caption || photo.note_text || '').trim();
}

export type SaveMarkupArgs = {
  blob: Blob;
  annotations?: unknown;
  note?: string | null;
};

/**
 * Save (or replace) a photo's markup overlay + optional note.
 * Sends multipart so the flattened image bypasses the JSON body limit.
 */
export async function savePhotoMarkup(
  projectId: string,
  photoId: string,
  args: SaveMarkupArgs,
): Promise<MarkupPhoto> {
  const form = new FormData();
  const ext = args.blob.type === 'image/png' ? 'png' : 'jpg';
  form.append('markup', args.blob, `markup_${photoId}.${ext}`);
  if (args.annotations !== undefined && args.annotations !== null) {
    form.append(
      'annotations',
      typeof args.annotations === 'string' ? args.annotations : JSON.stringify(args.annotations),
    );
  }
  if (args.note !== undefined && args.note !== null) {
    form.append('note', args.note);
  }
  const res = await api.put(`/projects/${projectId}/photos/${photoId}/markup`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return (res.data?.photo ?? {}) as MarkupPhoto;
}

/** Remove a photo's markup overlay (original is kept). */
export async function deletePhotoMarkup(projectId: string, photoId: string): Promise<MarkupPhoto> {
  const res = await api.delete(`/projects/${projectId}/photos/${photoId}/markup`);
  return (res.data?.photo ?? {}) as MarkupPhoto;
}

/** Save just the note for a photo (reuses the existing photo-note endpoint). */
export async function savePhotoNote(
  projectId: string,
  photoId: string,
  note: string,
): Promise<MarkupPhoto> {
  const res = await api.put(`/projects/${projectId}/photos/${photoId}/note`, { note });
  return (res.data?.photo ?? {}) as MarkupPhoto;
}

/** Parse stored vector annotations (markup_json) for re-editing. Safe on bad data. */
export function parseAnnotations(photo: MarkupPhoto): unknown[] {
  if (!photo.markup_json) return [];
  try {
    const parsed = JSON.parse(String(photo.markup_json));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
