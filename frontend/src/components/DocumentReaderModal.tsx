import { useEffect, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import api from '../lib/api';
import { Modal } from './ui';

// One viewable file: a quote document, a quote section, a Scope of Work PDF...
export interface ReaderDoc {
  key: string;
  label: string;
  url: string;                 // server path as the API returns it, e.g. /api/quote-analytics/…
  fileName?: string | null;
  mime?: string | null;
}

// Fallback when the server sends a generic content-type: a blob: URL is rendered
// purely on the Blob's own type, so an untyped PDF would show an empty frame.
export function guessMimeFromName(fileName?: string | null): string {
  const ext = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  return '';
}

// In-app document reader (moved out of Quotes.tsx 2026-10-19 so the Scope of Work PDF
// shares it - never fork it). Streams the files (with auth) and shows them inline.
// A quote can carry several documents — the full quote plus one per section — so
// this keeps a switcher and fetches only the one on screen.
// The file MUST be fetched as a blob: these routes are Bearer-authenticated, so a
// plain <a href> or <iframe src> pointed at them is an unauthenticated 401.
export default function DocumentReaderModal({
  title,
  subtitle,
  docs,
  initialKey,
  onClose,
  defaultDescription = 'Document',
  emptyText = 'No document is attached.',
  fallbackFileName = 'document',
}: {
  title: string;
  subtitle?: string;
  docs: ReaderDoc[];
  initialKey?: string;
  onClose: () => void;
  defaultDescription?: string;
  emptyText?: string;
  fallbackFileName?: string;
}) {
  const [activeKey, setActiveKey] = useState(
    () => (initialKey && docs.some(d => d.key === initialKey) ? initialKey : docs[0]?.key || '')
  );
  const active = docs.find(d => d.key === activeKey) || docs[0] || null;
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [kind, setKind] = useState<'pdf' | 'image' | 'other'>('pdf');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const activeUrl = active?.url || '';
  const activeMime = active?.mime || '';
  const activeName = active?.fileName || '';
  useEffect(() => {
    if (!activeUrl) { setLoading(false); return; }
    let cancelled = false;
    let created = '';
    setLoading(true);
    setError('');
    setBlobUrl(null);
    // The stored URLs are absolute API paths; the axios client is already based at /api.
    api.get(activeUrl.replace(/^\/api/, ''), { responseType: 'blob' })
      .then(res => {
        if (cancelled) return;
        const raw = res.data as Blob;
        const type = raw.type && raw.type !== 'application/octet-stream'
          ? raw.type
          : (activeMime || guessMimeFromName(activeName) || raw.type);
        const typed = type && type !== raw.type ? new Blob([raw], { type }) : raw;
        setKind(type.startsWith('image/') ? 'image' : type === 'application/pdf' ? 'pdf' : 'other');
        created = URL.createObjectURL(typed);
        setBlobUrl(created);
      })
      .catch(() => { if (!cancelled) setError('Could not load this document.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; if (created) URL.revokeObjectURL(created); };
  }, [activeUrl, activeMime, activeName]);

  return (
    // The panel gets a fixed height and the body becomes a flex column, so the document
    // takes whatever space the header, switcher and footer leave. A fixed-height frame
    // inside the default scrolling body overflowed the 90vh panel.
    <Modal
      isOpen
      onClose={onClose}
      title={title}
      size="2xl"
      description={subtitle || defaultDescription}
      panelClassName="h-[92dvh] sm:h-[90vh]"
      bodyClassName="flex min-h-0 flex-1 flex-col p-4"
    >
      {docs.length > 1 && (
        <div className="mb-2 flex flex-shrink-0 flex-wrap items-center gap-1.5">
          {docs.map(doc => (
            <button
              key={doc.key}
              type="button"
              onClick={() => setActiveKey(doc.key)}
              title={doc.fileName || doc.label}
              className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold ${
                doc.key === active?.key
                  ? 'border-amber-300 bg-amber-50 text-amber-800'
                  : 'border-gray-200 text-gray-500 hover:bg-gray-50'
              }`}
            >
              {doc.label}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 w-full flex-1">
        {!active ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-sm text-gray-400">
            <FileText className="h-6 w-6 text-gray-300" />
            <p>{emptyText}</p>
          </div>
        ) : loading ? (
          <div className="flex h-full items-center justify-center text-sm text-gray-400">Loading document…</div>
        ) : error ? (
          <div className="flex h-full items-center justify-center text-sm text-gray-400">{error}</div>
        ) : blobUrl ? (
          kind === 'image' ? (
            // Inline style, not bg-white: quotes.css rethemes .bg-white with !important.
            <div className="flex h-full w-full items-center justify-center overflow-auto rounded-lg" style={{ background: '#ffffff' }}>
              <img src={blobUrl} alt={active.fileName || active.label} className="max-h-full max-w-full object-contain" />
            </div>
          ) : kind === 'pdf' ? (
            <iframe title={active.label} src={blobUrl} className="h-full w-full rounded-lg border-0" style={{ background: '#ffffff' }} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-gray-400">
              <FileText className="h-6 w-6 text-gray-300" />
              <p>This file type can’t be previewed here.</p>
              <a href={blobUrl} download={active.fileName || fallbackFileName} className="inline-flex items-center gap-1 font-semibold text-blue-600 hover:underline">
                <Download className="h-3.5 w-3.5" /> Download {active.fileName || 'file'}
              </a>
            </div>
          )
        ) : null}
      </div>
      {active && blobUrl && (
        <div className="mt-2 flex flex-shrink-0 items-center justify-between gap-3 text-[11px] text-gray-400">
          <span className="truncate" title={active.fileName || active.label}>{active.fileName || active.label}</span>
          <a href={blobUrl} download={active.fileName || fallbackFileName} className="inline-flex flex-shrink-0 items-center gap-1 font-semibold text-blue-600 hover:underline">
            <Download className="h-3.5 w-3.5" /> Download
          </a>
        </div>
      )}
    </Modal>
  );
}
