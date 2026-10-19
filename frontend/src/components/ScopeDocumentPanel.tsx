import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { ChevronDown, Download, ExternalLink, FileText, History, Loader2, Trash2, UploadCloud } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { downloadAuthedFile, openAuthedFile } from '../lib/authFiles';
import { formatEasternDateTime } from '../lib/time';
import DocumentReaderModal, { type ReaderDoc } from './DocumentReaderModal';
import ConfirmDialog from './ConfirmDialog';
import '../styles/project-documents.css';

// Scope of Work PDF at the top of every project's Scope of Work tab (Mike, 2026-10-19):
// "a PDF in the middle of the screen so that the user can click on it and the scope of
// work would immediately pull up on a PDF reader ... or the PDF can be downloaded",
// plus a PDF that can be uploaded manually. The uploaded PDF is the one shown; until
// there is one, BuildTrack shows a PDF generated from the scope entered below.

type ScopeDocVersion = {
  id: string;
  original_name: string;
  size_bytes: number;
  created_at: string;
  uploaded_by_name?: string | null;
  url: string;
};

type ScopeDocPayload = {
  current: ScopeDocVersion | null;
  versions: ScopeDocVersion[];
  generated: { url: string; file_name: string; scope_count: number; line_count: number; has_content: boolean };
  permissions: { can_upload: boolean; can_delete: boolean };
  max_mb: number;
};

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function apiPath(url: string) {
  return url.replace(/^\/api/, '');
}

// Desktop browsers render PDFs inline; most phones (Android Chrome) cannot, so there
// the page shows a document card and "Open" hands the file to the phone's viewer.
const canPreviewPdf = (() => {
  try {
    return typeof navigator !== 'undefined' && Boolean((navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled);
  } catch {
    return false;
  }
})();

export default function ScopeDocumentPanel({ projectId, projectLabel, refreshKey }: {
  projectId: string;
  projectLabel: string;
  refreshKey?: string;
}) {
  const [data, setData] = useState<ScopeDocPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [reader, setReader] = useState<string | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ScopeDocVersion | null>(null);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const load = useCallback(async () => {
    try {
      const res = await api.get<ScopeDocPayload>(`/projects/${projectId}/scope-document`);
      setData(res.data);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  // The document on screen: the newest upload, else the generated scope.
  const shown = data?.current
    ? { key: `upload:${data.current.id}`, url: data.current.url, name: data.current.original_name, generated: false }
    : data ? { key: 'generated', url: data.generated.url, name: data.generated.file_name, generated: true } : null;
  const previewSource = shown ? `${shown.url}|${shown.generated ? refreshKey || '' : ''}` : '';

  useEffect(() => {
    if (!shown || !canPreviewPdf) { setPreviewUrl(null); return; }
    let cancelled = false;
    let created = '';
    setPreviewError(false);
    api.get(apiPath(shown.url), { responseType: 'blob' })
      .then(res => {
        if (cancelled) return;
        const blob = new Blob([res.data as Blob], { type: 'application/pdf' });
        created = URL.createObjectURL(blob);
        setPreviewUrl(created);
      })
      .catch(() => { if (!cancelled) { setPreviewUrl(null); setPreviewError(true); } });
    return () => { cancelled = true; if (created) URL.revokeObjectURL(created); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewSource]);

  const readerDocs: ReaderDoc[] = data ? [
    ...(data.current ? [{ key: `upload:${data.current.id}`, label: 'Uploaded scope of work', url: data.current.url, fileName: data.current.original_name, mime: 'application/pdf' }] : []),
    { key: 'generated', label: 'Scope entered in BuildTrack', url: data.generated.url, fileName: data.generated.file_name, mime: 'application/pdf' },
    ...data.versions.slice(1).map((v, i) => ({ key: `upload:${v.id}`, label: `Earlier version ${data.versions.length - 1 - i}`, url: v.url, fileName: v.original_name, mime: 'application/pdf' })),
  ] : [];

  const openDoc = (key: string, url: string) => {
    if (canPreviewPdf) setReader(key);
    else void openAuthedFile(url, { mime: 'application/pdf' });
  };

  const upload = async (file: File | null | undefined) => {
    if (!file || !data?.permissions.can_upload) return;
    const looksPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!looksPdf) { toast.error('Upload the scope of work as a PDF file.'); return; }
    if (file.size > data.max_mb * 1024 * 1024) { toast.error(`That PDF is larger than ${data.max_mb} MB.`); return; }
    const form = new FormData();
    form.append('file', file);
    setUploadProgress(0);
    try {
      const res = await api.post<ScopeDocPayload>(`/projects/${projectId}/scope-document`, form, {
        onUploadProgress: event => {
          if (event.total) setUploadProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
        },
      });
      setData(res.data);
      toast.success('Scope of work PDF uploaded');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'The scope of work PDF could not be uploaded.');
    } finally {
      setUploadProgress(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const res = await api.delete<ScopeDocPayload>(`/projects/${projectId}/scope-document/${pendingDelete.id}`);
      setData(res.data);
      toast.success('PDF removed');
      setPendingDelete(null);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'The PDF could not be removed.');
    } finally {
      setDeleting(false);
    }
  };

  const canUpload = Boolean(data?.permissions.can_upload);
  const dropHandlers = canUpload ? {
    onDragEnter: (event: DragEvent) => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragActive(true);
    },
    onDragOver: (event: DragEvent) => {
      if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragActive(false);
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragActive(false);
      void upload(event.dataTransfer?.files?.[0]);
    },
  } : {};

  if (loading) {
    return (
      <section className="bt-sowdoc" aria-busy="true">
        <div className="bt-sowdoc__loading"><Loader2 className="h-5 w-5 animate-spin" /> Loading the scope of work PDF…</div>
      </section>
    );
  }
  if (!data || !shown) {
    return (
      <section className="bt-sowdoc">
        <p className="bt-sowdoc__muted">The scope of work PDF could not be loaded. Refresh the page to try again.</p>
      </section>
    );
  }

  const current = data.current;
  const earlier = data.versions.slice(1);
  const uploading = uploadProgress !== null;
  const emptyGenerated = !current && !data.generated.has_content;

  return (
    <section className={`bt-sowdoc${dragActive ? ' is-dragging' : ''}`} aria-labelledby="bt-sowdoc-title" {...dropHandlers}>
      <div className="bt-sowdoc__top">
        <div className="min-w-0">
          <p className="bt-sowdoc__eyebrow"><FileText className="h-3.5 w-3.5" /> Scope of Work PDF</p>
          <h3 id="bt-sowdoc-title" className="bt-sowdoc__title">{projectLabel}</h3>
          <p className="bt-sowdoc__muted">
            {current
              ? 'The scope of work uploaded for this project. Click the page to read it, or download it.'
              : emptyGenerated
                ? 'No scope of work yet. Upload the scope of work PDF, or enter the scope below and BuildTrack will build the PDF.'
                : 'Built automatically from the scope entered below. Upload the signed scope of work PDF to show it here instead.'}
          </p>
        </div>
        {canUpload && (
          <div className="bt-sowdoc__actions">
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="sr-only"
              aria-label="Choose a scope of work PDF to upload"
              onChange={event => void upload(event.currentTarget.files?.[0])}
            />
            <button type="button" className="bt-sowdoc__btn bt-sowdoc__btn--primary" onClick={() => inputRef.current?.click()} disabled={uploading}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
              {uploading ? `Uploading ${uploadProgress}%` : current ? 'Upload new version' : 'Upload scope of work PDF'}
            </button>
          </div>
        )}
      </div>

      <div className="bt-sowdoc__stage">
        <div className="bt-sowdoc__paper">
          {previewUrl ? (
            <iframe
              title={`${shown.name} preview`}
              src={`${previewUrl}#page=1&toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
              className="bt-sowdoc__frame"
              tabIndex={-1}
              aria-hidden="true"
            />
          ) : (
            <span className="bt-sowdoc__placeholder" aria-hidden="true">
              <span className="bt-sowdoc__placeholder-badge">PDF</span>
              <span className="bt-sowdoc__placeholder-line is-title" />
              <span className="bt-sowdoc__placeholder-line" />
              <span className="bt-sowdoc__placeholder-line is-short" />
              <span className="bt-sowdoc__placeholder-line" />
              <span className="bt-sowdoc__placeholder-line" />
              <span className="bt-sowdoc__placeholder-line is-short" />
              {previewError && <span className="bt-sowdoc__placeholder-note">Preview unavailable — click to open</span>}
            </span>
          )}
          {/* The page itself is the click target; the preview frame never takes the click. */}
          <button
            type="button"
            className="bt-sowdoc__paper-hit"
            onClick={() => openDoc(shown.key, shown.url)}
            aria-label={`Open ${shown.name}`}
            title="Open the scope of work"
          >
            <span className="bt-sowdoc__open-hint"><ExternalLink className="h-4 w-4" /> Open scope of work</span>
          </button>
        </div>

        <div className="bt-sowdoc__caption">
          <p className="bt-sowdoc__filename" title={shown.name}>{shown.name}</p>
          <p className="bt-sowdoc__meta">
            {current
              ? [
                  current.uploaded_by_name ? `Uploaded by ${current.uploaded_by_name}` : 'Uploaded',
                  formatEasternDateTime(current.created_at, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
                  formatBytes(current.size_bytes),
                ].filter(Boolean).join(' · ')
              : `Generated from BuildTrack · ${data.generated.scope_count} scope${data.generated.scope_count === 1 ? '' : 's'} · ${data.generated.line_count} line item${data.generated.line_count === 1 ? '' : 's'}`}
          </p>
          <div className="bt-sowdoc__buttons">
            <button type="button" className="bt-sowdoc__btn bt-sowdoc__btn--primary" onClick={() => openDoc(shown.key, shown.url)}>
              <ExternalLink className="h-4 w-4" /> Open PDF
            </button>
            <button type="button" className="bt-sowdoc__btn" onClick={() => void downloadAuthedFile(shown.url, shown.name)}>
              <Download className="h-4 w-4" /> Download
            </button>
          </div>
        </div>
      </div>

      {(current || earlier.length > 0) && (
        <div className="bt-sowdoc__foot">
          {current && (
            <div className="bt-sowdoc__row">
              <FileText className="h-4 w-4 flex-shrink-0" />
              <span className="bt-sowdoc__row-text">
                <strong>Scope entered in BuildTrack</strong>
                <span>{data.generated.scope_count} scope{data.generated.scope_count === 1 ? '' : 's'} · {data.generated.line_count} line item{data.generated.line_count === 1 ? '' : 's'} · always current</span>
              </span>
              <button type="button" className="bt-sowdoc__link" onClick={() => openDoc('generated', data.generated.url)}>Open</button>
              <button type="button" className="bt-sowdoc__link" onClick={() => void downloadAuthedFile(data.generated.url, data.generated.file_name)}>Download</button>
            </div>
          )}
          {current && data.permissions.can_delete && (
            <div className="bt-sowdoc__row">
              <UploadCloud className="h-4 w-4 flex-shrink-0" />
              <span className="bt-sowdoc__row-text">
                <strong>Current upload</strong>
                <span>Remove it to show {earlier.length ? 'the previous version' : 'the scope entered in BuildTrack'} instead.</span>
              </span>
              <button type="button" className="bt-sowdoc__link is-danger" onClick={() => setPendingDelete(current)}>
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </button>
            </div>
          )}
          {earlier.length > 0 && (
            <>
              <button type="button" className="bt-sowdoc__versions-toggle" aria-expanded={showVersions} onClick={() => setShowVersions(open => !open)}>
                <History className="h-4 w-4" /> Earlier versions ({earlier.length})
                <ChevronDown className={`h-4 w-4 transition-transform ${showVersions ? 'rotate-180' : ''}`} />
              </button>
              {showVersions && (
                <ul className="bt-sowdoc__versions">
                  {earlier.map(version => (
                    <li key={version.id} className="bt-sowdoc__row">
                      <FileText className="h-4 w-4 flex-shrink-0" />
                      <span className="bt-sowdoc__row-text">
                        <strong title={version.original_name}>{version.original_name}</strong>
                        <span>{[
                          version.uploaded_by_name,
                          formatEasternDateTime(version.created_at, { month: 'short', day: 'numeric', year: 'numeric' }),
                          formatBytes(version.size_bytes),
                        ].filter(Boolean).join(' · ')}</span>
                      </span>
                      <button type="button" className="bt-sowdoc__link" onClick={() => openDoc(`upload:${version.id}`, version.url)}>Open</button>
                      <button type="button" className="bt-sowdoc__link" onClick={() => void downloadAuthedFile(version.url, version.original_name)}>Download</button>
                      {data.permissions.can_delete && (
                        <button type="button" className="bt-sowdoc__link is-danger" onClick={() => setPendingDelete(version)} aria-label={`Delete ${version.original_name}`}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {dragActive && (
        <div className="bt-sowdoc__drop" aria-hidden="true">
          <UploadCloud className="h-8 w-8" />
          <span>Drop the scope of work PDF to upload it</span>
        </div>
      )}

      {reader && (
        <DocumentReaderModal
          title="Scope of Work"
          subtitle={projectLabel}
          docs={readerDocs}
          initialKey={reader}
          onClose={() => setReader(null)}
          defaultDescription="Scope of work"
          emptyText="No scope of work PDF yet."
          fallbackFileName="scope-of-work.pdf"
        />
      )}

      <ConfirmDialog
        isOpen={Boolean(pendingDelete)}
        title="Remove this PDF?"
        description={pendingDelete ? `${pendingDelete.original_name} will be removed from this project.` : undefined}
        confirmLabel="Remove PDF"
        busyLabel="Removing..."
        tone="danger"
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => { if (!deleting) setPendingDelete(null); }}
      />
    </section>
  );
}
