import toast from 'react-hot-toast';
import api from './api';

// Files behind /api need the Bearer token, which a plain <a href> or <img src>
// never sends - they open as {"error":"Authentication required"} (Mike's 2026-10-01
// screenshot of a quote PDF). Always fetch through api as a blob instead.

function apiPath(url: string) {
  return url.startsWith('/api/') ? url.slice('/api'.length) : url;
}

function errorText(err: any) {
  const status = err?.response?.status;
  if (status === 404 || status === 410) return 'That document is no longer available.';
  if (status === 403) return 'You do not have access to that document.';
  return 'The document could not be opened. Please try again.';
}

async function fetchBlob(url: string, mime?: string | null) {
  const response = await api.get<Blob>(apiPath(url), { responseType: 'blob' });
  // A blob: URL renders by the Blob's own type - re-type it when we know better.
  return mime ? new Blob([response.data], { type: mime }) : response.data;
}

/** Open a protected file in a new tab (opened synchronously so pop-up blockers allow it). */
export async function openAuthedFile(url: string | null | undefined, { mime }: { mime?: string | null } = {}) {
  if (!url) return;
  const popup = window.open('about:blank', '_blank');
  if (!popup) {
    toast.error('Pop-up blocked. Allow pop-ups for this site to open documents.');
    return;
  }
  try {
    popup.opener = null;
  } catch {
    // Some browsers freeze `opener`; the tab still cannot reach this page's data.
  }
  try {
    const objectUrl = URL.createObjectURL(await fetchBlob(url, mime));
    popup.location.href = objectUrl;
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch (err) {
    popup.close();
    toast.error(errorText(err));
  }
}

/** Save a protected file to the computer under its original name. */
export async function downloadAuthedFile(url: string | null | undefined, filename?: string | null) {
  if (!url) return;
  try {
    const objectUrl = URL.createObjectURL(await fetchBlob(url));
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename || 'document';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  } catch (err) {
    toast.error(errorText(err));
  }
}

/** A blob: URL for a protected image (thumbnails). Caller revokes it. */
export async function authedObjectUrl(url: string, mime?: string | null) {
  return URL.createObjectURL(await fetchBlob(url, mime));
}
