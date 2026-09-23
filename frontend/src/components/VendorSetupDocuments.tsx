import { useCallback, useEffect, useState } from 'react';
import { Download, Eye, FileText, Lock, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { Modal } from './ui';
import ConfirmDialog from './ConfirmDialog';
import { formatEasternDate } from '../lib/time';
import { formatFileSize, type VendorSetupDocument, type VendorSetupInvite } from '../lib/vendorSetup';

interface DocumentsPayload {
  documents: VendorSetupDocument[];
  setup: VendorSetupInvite | null;
  can_view_sensitive: boolean;
  can_delete: boolean;
}

// Documents a vendor sent through "Set Up New Vendor". They are encrypted on the
// server and only ever fetched through the authenticated API as a blob (never an
// <a href> to /api - auth is Bearer-only, so a plain link is always a 401).
export default function VendorSetupDocuments({ contractorId }: { contractorId: string }) {
  const [data, setData] = useState<DocumentsPayload | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ doc: VendorSetupDocument; url: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VendorSetupDocument | null>(null);
  const [deleteError, setDeleteError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.get<DocumentsPayload>(`/vendor-setup/vendors/${contractorId}/documents`);
      setData(res.data);
    } catch {
      setData(null);
    }
  }, [contractorId]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  useEffect(() => () => {
    if (viewer?.url) URL.revokeObjectURL(viewer.url);
  }, [viewer]);

  const fetchBlob = async (doc: VendorSetupDocument, download: boolean) => {
    const res = await api.get(`/vendor-setup/files/${doc.id}${download ? '?download=1' : ''}`, { responseType: 'blob' });
    // A blob: URL renders purely on the Blob's own type, so re-type it.
    return new Blob([res.data], { type: doc.mime_type || 'application/octet-stream' });
  };

  const readError = async (err: any, fallback: string) => {
    const payload = err?.response?.data;
    if (payload instanceof Blob) {
      try {
        return JSON.parse(await payload.text())?.error || fallback;
      } catch {
        return fallback;
      }
    }
    return payload?.error || fallback;
  };

  const view = async (doc: VendorSetupDocument) => {
    setBusyId(doc.id);
    try {
      const blob = await fetchBlob(doc, false);
      setViewer({ doc, url: URL.createObjectURL(blob) });
    } catch (err) {
      toast.error(await readError(err, 'Could not open the document'));
    } finally {
      setBusyId(null);
    }
  };

  const download = async (doc: VendorSetupDocument) => {
    setBusyId(doc.id);
    try {
      const blob = await fetchBlob(doc, true);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = doc.original_name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      toast.error(await readError(err, 'Could not download the document'));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async () => {
    const doc = deleteTarget;
    if (!doc) return;
    setBusyId(doc.id);
    setDeleteError('');
    try {
      await api.delete(`/vendor-setup/files/${doc.id}`);
      toast.success('Document deleted');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setDeleteError(await readError(err, 'Could not delete the document'));
    } finally {
      setBusyId(null);
    }
  };

  if (!data || (!data.documents.length && !data.setup)) return null;

  const setup = data.setup;
  return (
    <div className="bt-vendor-setup-documents rounded-2xl border border-gray-200 bg-gray-50 p-4">
      <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-gray-400" />
          <h3 className="text-sm font-black text-gray-900">Vendor Setup Documents</h3>
        </div>
        {setup ? (
          <p className="text-xs font-semibold text-gray-500">
            Submitted {formatEasternDate(setup.submitted_at)} through Set Up New Vendor
            {setup.w9_method ? ` · W-9 ${setup.w9_method === 'online' ? 'filled out online' : 'uploaded'}` : ''}
          </p>
        ) : null}
      </div>
      {data.documents.length ? (
        <div className="space-y-2">
          {data.documents.map(doc => (
            <div key={doc.id} className="flex flex-col gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-[11px] font-black uppercase tracking-wide text-amber-700">{doc.kind_label}</p>
                <p className="truncate text-sm font-bold text-gray-900" title={doc.original_name}>{doc.original_name}</p>
                <p className="text-[11px] font-semibold text-gray-400">{formatFileSize(doc.size_bytes)} · {formatEasternDate(doc.uploaded_at)}</p>
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                {doc.can_view ? (
                  <>
                    {doc.inline ? (
                      <button
                        type="button"
                        onClick={() => view(doc)}
                        disabled={busyId === doc.id}
                        className="bt-vs-btn"
                        title={`Open ${doc.original_name}`}
                      >
                        <Eye className="h-3.5 w-3.5" />
                        View
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => download(doc)}
                      disabled={busyId === doc.id}
                      className="bt-vs-btn"
                      title={`Download ${doc.original_name}`}
                    >
                      <Download className="h-3.5 w-3.5" />
                      Download
                    </button>
                  </>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-black text-gray-500" title="W-9 and bank documents open for super admins and operations managers">
                    <Lock className="h-3.5 w-3.5" />
                    Super admin / operations manager only
                  </span>
                )}
                {data.can_delete ? (
                  <button
                    type="button"
                    onClick={() => { setDeleteError(''); setDeleteTarget(doc); }}
                    disabled={busyId === doc.id}
                    className="bt-vs-btn bt-vs-btn--danger bt-vs-btn--icon"
                    title="Delete document"
                    aria-label={`Delete ${doc.original_name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-gray-100 bg-white p-4 text-sm font-semibold text-gray-400">No documents on file.</p>
      )}

      <Modal
        isOpen={Boolean(viewer)}
        onClose={() => setViewer(null)}
        title={viewer ? `${viewer.doc.kind_label}: ${viewer.doc.original_name}` : ''}
        size="2xl"
        panelClassName="h-[90vh]"
        bodyClassName="flex min-h-0 flex-1 flex-col gap-3 p-4"
      >
        {viewer ? (
          <>
            {viewer.doc.mime_type === 'application/pdf' ? (
              <iframe title={viewer.doc.original_name} src={viewer.url} className="min-h-0 w-full flex-1 rounded-lg border border-gray-200" style={{ background: '#FFFFFF' }} />
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg border border-gray-200" style={{ background: '#F8FAFC' }}>
                <img src={viewer.url} alt={viewer.doc.original_name} className="max-h-full max-w-full object-contain" />
              </div>
            )}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => download(viewer.doc)}
                className="bt-vs-btn"
              >
                <Download className="h-3.5 w-3.5" />
                Download
              </button>
            </div>
          </>
        ) : null}
      </Modal>

      <ConfirmDialog
        isOpen={Boolean(deleteTarget)}
        title="Delete this document?"
        confirmLabel="Yes, delete document"
        cancelLabel="Keep it"
        busyLabel="Deleting..."
        tone="danger"
        busy={Boolean(deleteTarget && busyId === deleteTarget.id)}
        error={deleteError}
        onConfirm={remove}
        onCancel={() => setDeleteTarget(null)}
      >
        {deleteTarget ? (
          <div className="space-y-3 text-sm leading-6 text-gray-700">
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-3.5">
              <p className="text-[11px] font-black uppercase tracking-wide text-amber-700">{deleteTarget.kind_label}</p>
              <p className="break-all font-black text-gray-900">{deleteTarget.original_name}</p>
            </div>
            <p>The file is permanently erased from BuildTrack. This cannot be undone.</p>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
