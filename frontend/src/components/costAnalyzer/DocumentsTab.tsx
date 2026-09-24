import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { ExternalLink, FileText, Play, RefreshCw, ScanLine, Square } from 'lucide-react';
import toast from 'react-hot-toast';

import api from '../../lib/api';
import {
  DOCUMENT_STATUSES,
  cancelScan,
  dash,
  documentUnknownText,
  formatDate,
  formatDateTime,
  getDocument,
  getDocuments,
  getScanStatus,
  humanize,
  money,
  num,
  pct,
  startScan,
} from '../../lib/costAnalyzerApi';
import type {
  CostAnalyzerFilters,
  DocumentCounts,
  DocumentDetail,
  DocumentRow,
  DocumentStatus,
  DocumentsResponse,
  MaterialItem,
  ScanScope,
  ScanStatus,
} from '../../lib/costAnalyzerApi';
import {
  BAR_COLOR,
  Chip,
  Drawer,
  EmptyState,
  InlineSpinner,
  StatusChip,
  apiError,
  cardClass,
  fieldClass,
  iconButton,
  labelClass,
  primaryButton,
  secondaryButton,
  stickyFirstColClass,
  tableClass,
  tableWrapClass,
  tbodyClass,
  tdClass,
  tdNumClass,
  thClass,
  thNumClass,
  theadClass,
} from './shared';

// Documents tab (spec §7): scan controls, live progress, counts by status,
// the document table and a drawer with the extraction details. Documents are
// never filtered by date (the page shell shows that caption), so `filters` is
// accepted for the common tab contract but not used here.

/** Rows per page (spec: pagination, limit 100). */
const PAGE_SIZE = 100;
/** Poll /documents/scan/status this often while a run is active (spec: 3 s). */
const POLL_MS = 3000;

export type DocumentsTabProps = {
  filters: CostAnalyzerFilters;
  canEdit: boolean;
  onOpenVendor?: (vendorId: string) => void;
};

// ── Opening a document in a new tab ─────────────────────────────────────────

// attachment_url is site-relative ('/api/quickbooks/...'); the axios instance
// already carries the '/api' base, so strip it before the authenticated fetch.
function apiPath(url: string): string {
  return url.startsWith('/api/') ? url.slice('/api'.length) : url;
}

/**
 * Opens a bill attachment in a new tab. The tab is opened synchronously (so
 * pop-up blockers allow it) and filled once the authenticated fetch completes:
 * a plain link would not carry the Bearer token the API expects.
 */
export async function openAttachment(url: string | null | undefined): Promise<void> {
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
    const response = await api.get<Blob>(apiPath(url), { responseType: 'blob' });
    const objectUrl = URL.createObjectURL(response.data);
    popup.location.href = objectUrl;
    // Give the tab a minute to load before releasing the blob.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch (err) {
    popup.close();
    toast.error(apiError(err));
  }
}

/** Icon link that opens the attachment; stops the row click behind it. */
export function OpenDocumentLink({ url, label = 'Open document', className }: { url: string | null | undefined; label?: string; className?: string }) {
  if (!url) return <span className="text-slate-400">{dash}</span>;
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void openAttachment(url);
  };
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" onClick={onClick} className={className || iconButton} aria-label={label} title={label}>
      <ExternalLink className="h-4 w-4" aria-hidden="true" />
    </a>
  );
}

// ── Small presentational helpers ────────────────────────────────────────────

/** Matches-bill / partial-payment / mismatch chip for a document total. */
function TotalsChip({ doc }: { doc: Pick<DocumentRow, 'totals_match' | 'totals_match_reason' | 'document_total'> }) {
  if (doc.totals_match === null) return null;
  if (doc.totals_match) return <Chip tone="ok" title="Document total matches the QuickBooks bill">Matches bill</Chip>;
  if (doc.totals_match_reason === 'partial_payment') {
    return <Chip tone="neutral" title="The bill is a partial payment of this document">Partial payment</Chip>;
  }
  return <Chip tone="warn" title="Document total differs from the QuickBooks bill">Mismatch</Chip>;
}

function SuggestedCategory({ doc }: { doc: Pick<DocumentRow, 'suggested_category_id' | 'suggested_category_confidence'> }) {
  if (!doc.suggested_category_id) return <span className="text-slate-400">{dash}</span>;
  const conf = typeof doc.suggested_category_confidence === 'number' ? ` ${doc.suggested_category_confidence.toFixed(2)}` : '';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{humanize(doc.suggested_category_id.replace(/-/g, ' '))}</span>
      {conf && <Chip tone="ai" title="Extractor confidence in the suggested category">AI{conf}</Chip>}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className={labelClass}>{label}</p>
      <div className="mt-0.5 text-sm text-slate-900">{children}</div>
    </div>
  );
}

function tokens(input: number | null | undefined, output: number | null | undefined): string {
  if (input === null || input === undefined) return dash;
  return `${num(input)} in / ${num(output ?? 0)} out`;
}

// ── Scan progress ───────────────────────────────────────────────────────────

function ScanProgress({ scan, active }: { scan: ScanStatus | null; active: boolean }) {
  const run = scan?.run ?? null;
  if (!run) return <p className="mt-3 text-sm text-slate-500">No scan has run yet.</p>;
  const processed = run.done + run.failed + run.skipped;
  const fraction = run.total > 0 ? Math.min(1, processed / run.total) : 0;
  const percent = Math.round(fraction * 100);
  if (active) {
    return (
      <div className="mt-3 space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-700">
          <span className="inline-flex items-center gap-2">
            <InlineSpinner />
            Scanning {humanize(run.scope)} documents: {num(processed)} of {num(run.total)} ({percent}%)
          </span>
          <span className="text-xs text-slate-500">
            {num(run.done)} read · {num(run.failed)} failed · {num(run.skipped)} skipped · tokens {tokens(run.input_tokens, run.output_tokens)}
          </span>
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={run.total || 100}
          aria-valuenow={processed}
          aria-label="Scan progress"
          className="h-2 w-full overflow-hidden rounded bg-slate-200"
        >
          <div className="h-full rounded transition-[width]" style={{ width: `${percent}%`, backgroundColor: BAR_COLOR }} />
        </div>
        <p className="text-xs text-slate-500">Started {formatDateTime(run.started_at)}. The page checks progress every 3 seconds.</p>
      </div>
    );
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-700">
      <span className={labelClass}>Last scan</span>
      <StatusChip status={run.status} />
      <span>{humanize(run.scope)} · {num(run.done)} read · {num(run.failed)} failed · {num(run.skipped)} skipped of {num(run.total)}</span>
      <span className="text-xs text-slate-500">
        {run.finished_at ? `finished ${formatDateTime(run.finished_at)}` : `started ${formatDateTime(run.started_at)}`} · tokens {tokens(run.input_tokens, run.output_tokens)}
      </span>
      {run.error && <span className="basis-full text-xs text-rose-700">{run.error}</span>}
    </div>
  );
}

// ── Counts strip ────────────────────────────────────────────────────────────

function CountsStrip({ counts, status, onPick }: { counts: DocumentCounts; status: DocumentStatus | ''; onPick: (next: DocumentStatus | '') => void }) {
  const entries: Array<{ id: DocumentStatus | ''; label: string; value: number }> = [
    { id: '', label: 'All rows', value: counts.rows },
    ...DOCUMENT_STATUSES.map(id => ({ id, label: humanize(id), value: counts[id] })),
  ];
  const missing = Math.max(0, counts.attachments - counts.rows);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter documents by status">
        {entries.map(entry => {
          const pressed = status === entry.id;
          return (
            <button
              key={entry.id || 'all'}
              type="button"
              aria-pressed={pressed}
              onClick={() => onPick(entry.id)}
              className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm transition ${
                pressed ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <span>{entry.label}</span>
              <span className={`tabular-nums text-xs font-semibold ${pressed ? 'text-slate-200' : 'text-slate-500'}`}>{num(entry.value)}</span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-slate-500">
        {num(counts.attachments)} attachments on QuickBooks bills · {num(counts.rows)} with a document row
        {missing > 0 ? ` · ${num(missing)} not queued yet (a pending scan queues them)` : ''}
        {counts.needs_review_items > 0 ? ` · ${num(counts.needs_review_items)} extracted lines need review` : ''}
      </p>
    </div>
  );
}

// ── Items table (inside the drawer) ─────────────────────────────────────────

function ItemsTable({ items }: { items: MaterialItem[] }) {
  if (items.length === 0) return <p className="py-4 text-sm text-slate-500">No priced lines were extracted from this document.</p>;
  return (
    <div className={tableWrapClass}>
      <table className={`${tableClass} min-w-[960px]`}>
        <thead className={theadClass}>
          <tr>
            <th className={thNumClass}>#</th>
            <th className={thClass}>Description</th>
            <th className={thClass}>Kind</th>
            <th className={thClass}>Family / type</th>
            <th className={thClass}>Phase</th>
            <th className={thNumClass}>Qty</th>
            <th className={thClass}>Unit</th>
            <th className={thNumClass}>Unit price</th>
            <th className={thNumClass}>Line total</th>
            <th className={thNumClass}>Hours</th>
            <th className={thClass}>Review</th>
          </tr>
        </thead>
        <tbody className={tbodyClass}>
          {items.map(item => (
            <tr key={item.id}>
              <td className={tdNumClass}>{item.line_no}</td>
              <td className={tdClass}>
                <span className="text-slate-900">{item.description}</span>
                {item.location && <span className="block text-xs text-slate-500">{item.location}</span>}
                {item.note && <span className="block text-xs text-slate-500">{item.note}</span>}
                {item.source === 'manual' && <Chip tone="manual" className="mt-1">Entered by hand</Chip>}
              </td>
              <td className={tdClass}>{humanize(item.item_kind)}</td>
              <td className={tdClass}>
                <span>{item.material_family ? humanize(item.material_family) : dash}</span>
                <span className="block text-xs text-slate-500">
                  {item.material_type ? humanize(item.material_type) : item.material_type_raw || dash}
                  {item.spec ? ` · ${item.spec}` : ''}
                </span>
              </td>
              <td className={tdClass}>{item.phase && item.phase !== 'n_a' ? humanize(item.phase) : dash}</td>
              <td className={tdNumClass}>{num(item.quantity, 2)}</td>
              <td className={tdClass}>{item.unit || dash}</td>
              <td className={tdNumClass}>{money(item.unit_price)}</td>
              <td className={tdNumClass}>{money(item.line_total)}</td>
              <td className={tdNumClass}>
                {num(item.hours, 2)}
                {item.days !== null ? <span className="block text-xs text-slate-500">{num(item.days, 2)} days</span> : null}
              </td>
              <td className={tdClass}>
                {item.needs_review ? <Chip tone="warn" title={item.review_reason || undefined}>{item.review_reason || 'Needs review'}</Chip> : <span className="text-slate-400">{dash}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Document drawer ─────────────────────────────────────────────────────────

function DocumentDrawerBody({
  detail,
  canEdit,
  rescanning,
  onRescan,
}: {
  detail: DocumentDetail;
  canEdit: boolean;
  rescanning: boolean;
  onRescan: (attachmentId: string) => void;
}) {
  const unknowns = Array.isArray(detail.unknowns) ? detail.unknowns.map(documentUnknownText).filter(Boolean) : [];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={detail.status} />
        {detail.doc_type && <Chip>{humanize(detail.doc_type)}</Chip>}
        <TotalsChip doc={detail} />
        {detail.duplicate_of && <Chip tone="neutral" title={`Same file as attachment ${detail.duplicate_of}`}>Duplicate of {detail.duplicate_of}</Chip>}
        <span className="ml-auto flex items-center gap-2">
          {canEdit && detail.status !== 'running' && (
            <button type="button" className={secondaryButton} disabled={rescanning} onClick={() => onRescan(detail.attachment_id)}>
              <RefreshCw className={`h-4 w-4 ${rescanning ? 'animate-spin' : ''}`} aria-hidden="true" />
              Rescan this document
            </button>
          )}
          {detail.attachment_url && (
            <a
              href={detail.attachment_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={event => { event.preventDefault(); void openAttachment(detail.attachment_url); }}
              className={secondaryButton}
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Open document
            </a>
          )}
        </span>
      </div>

      {detail.error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-slate-800" role="alert">
          <span className="font-semibold">Extractor message: </span>{detail.error}
        </div>
      )}

      {detail.summary && <p className="text-sm text-slate-800">{detail.summary}</p>}

      <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
        <Fact label="Document date">{formatDate(detail.document_date)}</Fact>
        <Fact label="Document total">{money(detail.document_total)}</Fact>
        <Fact label="Bill total">{money(detail.bill_total)}</Fact>
        <Fact label="Bill">{detail.qbo_bill_id ? `#${detail.qbo_bill_id}` : dash}{detail.txn_date ? ` · ${formatDate(detail.txn_date)}` : ''}</Fact>
        <Fact label="Labor total">{money(detail.labor_total)}</Fact>
        <Fact label="Material total">{money(detail.material_total)}</Fact>
        <Fact label="Labor hours / days">
          {num(detail.labor_hours, 2)}{detail.labor_days !== null ? ` / ${num(detail.labor_days, 2)} d` : ''}
        </Fact>
        <Fact label="Labor rate on document">{detail.labor_rate !== null ? `${money(detail.labor_rate)}/hr` : dash}</Fact>
        <Fact label="Labor performed by">{detail.labor_performed_by || dash}</Fact>
        <Fact label="Vendor on document">{detail.vendor_name || dash}</Fact>
        <Fact label="Suggested category"><SuggestedCategory doc={detail} /></Fact>
        <Fact label="Overall confidence">{detail.confidence !== null ? pct(detail.confidence, 0) : dash}</Fact>
        <Fact label="Bills covered">{detail.bills_covered.length ? detail.bills_covered.map(id => `#${id}`).join(', ') : dash}</Fact>
        <Fact label="Model">{detail.model || dash}</Fact>
        <Fact label="Tokens">{tokens(detail.input_tokens, detail.output_tokens)}</Fact>
        <Fact label="Attempts">{num(detail.attempts)}</Fact>
        <Fact label="Started">{formatDateTime(detail.started_at)}</Fact>
        <Fact label="Extracted">{formatDateTime(detail.extracted_at)}</Fact>
      </div>

      <section className="space-y-2">
        <h4 className="text-sm font-bold uppercase text-slate-700">Unknowns on this document</h4>
        {unknowns.length === 0 ? (
          <p className="text-sm text-slate-500">The extractor did not report anything missing.</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-800">
            {unknowns.map((text, index) => <li key={`${index}-${text.slice(0, 24)}`}>{text}</li>)}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-bold uppercase text-slate-700">Priced lines ({detail.items.length})</h4>
        <ItemsTable items={detail.items} />
      </section>
    </div>
  );
}

// ── Tab ─────────────────────────────────────────────────────────────────────

export default function DocumentsTab({ canEdit }: DocumentsTabProps) {
  const [data, setData] = useState<DocumentsResponse | null>(null);
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<DocumentStatus | ''>('');
  const [offset, setOffset] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<'start' | 'cancel' | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const requestedRef = useRef<string | null>(null);

  const refetch = useCallback(() => setReloadKey(key => key + 1), []);

  useEffect(() => {
    let cancelled = false;
    setRefreshing(true);
    setError(null);
    getDocuments({ status: status || null, limit: PAGE_SIZE, offset })
      .then(res => {
        if (cancelled) return;
        setData(res);
        setScan(res.scan);
      })
      .catch(err => {
        if (!cancelled) setError(apiError(err));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [status, offset, reloadKey]);

  // Poll the scan status every 3 s only while a run is active; the interval is
  // cleared when the run ends, when the filters change and on unmount.
  const active = Boolean(scan?.active);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await getScanStatus();
        if (cancelled) return;
        setScan(next);
        if (!next.active) refetch();
      } catch {
        // Transient poll failure: keep the interval and try again in 3 s.
      }
    };
    const timer = window.setInterval(() => { void tick(); }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, refetch]);

  const runScan = async (scope: ScanScope, attachmentIds?: string[]) => {
    setBusy('start');
    try {
      const next = await startScan(attachmentIds ? { scope, attachment_ids: attachmentIds } : { scope });
      setScan(next);
      toast.success(scope === 'selected' ? 'Rescan queued' : `Scan started (${humanize(scope)})`);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(null);
    }
  };

  const stopScan = async () => {
    setBusy('cancel');
    try {
      const next = await cancelScan();
      setScan(next);
      toast.success('Cancelling. Documents already in flight will finish.');
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(null);
    }
  };

  const openDocument = useCallback(async (attachmentId: string) => {
    requestedRef.current = attachmentId;
    setSelectedId(attachmentId);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const row = await getDocument(attachmentId);
      if (requestedRef.current !== attachmentId) return;
      setDetail(row);
    } catch (err) {
      if (requestedRef.current !== attachmentId) return;
      setDetailError(apiError(err));
    } finally {
      if (requestedRef.current === attachmentId) setDetailLoading(false);
    }
  }, []);

  const closeDrawer = () => {
    requestedRef.current = null;
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
  };

  const pickStatus = (next: DocumentStatus | '') => {
    setStatus(next);
    setOffset(0);
  };

  const counts: DocumentCounts | null = scan?.counts ?? data?.counts ?? null;
  const queued = counts ? counts.pending + Math.max(0, counts.attachments - counts.rows) : 0;
  const documents = data?.documents ?? [];
  const total = data?.total ?? 0;
  const pageEnd = Math.min(total, offset + documents.length);

  if (loading) {
    return (
      <div className={cardClass}>
        <InlineSpinner label="Loading documents…" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <EmptyState
        title="Documents could not be loaded"
        message={error}
        icon={FileText}
        action={<button type="button" className={secondaryButton} onClick={refetch}>Try again</button>}
      />
    );
  }

  const selectedRow = selectedId ? documents.find(doc => doc.attachment_id === selectedId) ?? null : null;
  const drawerTitle = detail?.vendor_name || selectedRow?.vendor_name || 'Document';
  const drawerDate = detail?.txn_date || selectedRow?.txn_date || null;

  return (
    <div className={`space-y-5 transition-opacity ${refreshing ? 'opacity-60' : ''}`}>
      <div className={cardClass}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 max-w-2xl">
            <p className={labelClass}>Document scan</p>
            <p className="mt-1 text-sm text-slate-600">
              Reads every PDF and image attached to a QuickBooks bill and pulls out the priced lines. A number that is not on the page is reported as unknown, never guessed.
            </p>
            {scan?.model && <p className="mt-1 text-xs text-slate-500">Model: {scan.model}</p>}
            {scan?.configured === false && (
              <p className="mt-1 text-xs text-slate-700">
                <Chip tone="warn">No Anthropic API key</Chip>
                <span className="ml-1.5">Add one under Human Resources › AI settings before scanning.</span>
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {canEdit ? (
              active ? (
                <button type="button" className={primaryButton} disabled={busy !== null} onClick={() => { void stopScan(); }}>
                  <Square className="h-4 w-4" aria-hidden="true" />
                  {busy === 'cancel' ? 'Cancelling…' : 'Cancel scan'}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className={primaryButton}
                    disabled={busy !== null || scan?.configured === false}
                    onClick={() => { void runScan('pending'); }}
                  >
                    <Play className="h-4 w-4" aria-hidden="true" />
                    {busy === 'start' ? 'Starting…' : `Scan pending${counts ? ` (${num(queued)})` : ''}`}
                  </button>
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={busy !== null || scan?.configured === false || (counts !== null && counts.failed === 0)}
                    onClick={() => { void runScan('failed'); }}
                  >
                    <ScanLine className="h-4 w-4" aria-hidden="true" />
                    Rescan failed{counts ? ` (${num(counts.failed)})` : ''}
                  </button>
                </>
              )
            ) : (
              <p className="self-center text-xs text-slate-500">Ask an operations manager to run a scan.</p>
            )}
            <button type="button" className={secondaryButton} onClick={refetch} disabled={refreshing} aria-label="Refresh documents">
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
              Refresh
            </button>
          </div>
        </div>
        <ScanProgress scan={scan} active={active} />
      </div>

      {counts && <CountsStrip counts={counts} status={status} onPick={pickStatus} />}

      {error && data && (
        <p className="text-sm text-rose-700" role="alert">{error}</p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <span className={labelClass}>Status</span>
          <select className={`${fieldClass} w-48`} value={status} onChange={event => pickStatus(event.target.value as DocumentStatus | '')}>
            <option value="">All statuses</option>
            {DOCUMENT_STATUSES.map(value => <option key={value} value={value}>{humanize(value)}</option>)}
          </select>
        </label>
        <p className="text-sm text-slate-500">
          {total === 0 ? 'No documents' : `Showing ${num(offset + 1)}–${num(pageEnd)} of ${num(total)}`}
        </p>
      </div>

      {documents.length === 0 ? (
        <EmptyState
          title={status ? `No ${humanize(status).toLowerCase()} documents` : 'No documents yet'}
          message={status ? 'Pick another status or clear the filter.' : canEdit ? 'Start a pending scan to read the attachments on QuickBooks bills.' : 'Ask an operations manager to run the scan.'}
          icon={FileText}
        />
      ) : (
        <div className={tableWrapClass}>
          <table className={`${tableClass} min-w-[1100px]`}>
            <thead className={theadClass}>
              <tr>
                <th className={`${thClass} sticky left-0 z-10 bg-slate-50`}>Vendor</th>
                <th className={thClass}>Bill date</th>
                <th className={thNumClass}>Bill total</th>
                <th className={thNumClass}>Document total</th>
                <th className={thClass}>Type</th>
                <th className={thClass}>Suggested category</th>
                <th className={thClass}>Status</th>
                <th className={thNumClass}>Attempts</th>
                <th className={`${thClass} w-16`}><span className="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody className={tbodyClass}>
              {documents.map(doc => (
                <tr key={doc.attachment_id} onClick={() => { void openDocument(doc.attachment_id); }} className="cursor-pointer hover:bg-slate-50">
                  <td className={`${tdClass} ${stickyFirstColClass}`}>
                    <button type="button" className="text-left font-semibold text-slate-900 hover:underline" onClick={event => { event.stopPropagation(); void openDocument(doc.attachment_id); }}>
                      {doc.vendor_name || 'Unknown vendor'}
                    </button>
                    <span className="block text-xs text-slate-500">
                      {doc.qbo_bill_id ? `Bill #${doc.qbo_bill_id}` : 'No bill'}
                      {doc.bills_covered.length > 1 ? ` · covers ${doc.bills_covered.length} bills` : ''}
                    </span>
                  </td>
                  <td className={`${tdClass} whitespace-nowrap`}>{formatDate(doc.txn_date)}</td>
                  <td className={tdNumClass}>{money(doc.bill_total)}</td>
                  <td className={tdNumClass}>
                    <span>{money(doc.document_total)}</span>
                    <span className="mt-1 block"><TotalsChip doc={doc} /></span>
                  </td>
                  <td className={tdClass}>{doc.doc_type ? humanize(doc.doc_type) : dash}</td>
                  <td className={tdClass}><SuggestedCategory doc={doc} /></td>
                  <td className={tdClass}>
                    <StatusChip status={doc.status} title={doc.error || undefined} />
                    {doc.error && <span className="mt-1 block max-w-xs truncate text-xs text-slate-500" title={doc.error}>{doc.error}</span>}
                  </td>
                  <td className={tdNumClass}>{doc.attempts}</td>
                  <td className={tdClass}><OpenDocumentLink url={doc.attachment_url} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-3">
          <button type="button" className={secondaryButton} disabled={offset === 0 || refreshing} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            Previous
          </button>
          <span className="text-sm text-slate-500">Page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}</span>
          <button type="button" className={secondaryButton} disabled={pageEnd >= total || refreshing} onClick={() => setOffset(offset + PAGE_SIZE)}>
            Next
          </button>
        </div>
      )}

      <Drawer
        isOpen={selectedId !== null}
        onClose={closeDrawer}
        title={drawerTitle}
        description={drawerDate ? `Bill dated ${formatDate(drawerDate)} · attachment ${selectedId ?? ''}` : `Attachment ${selectedId ?? ''}`}
      >
        {detailLoading && <InlineSpinner label="Loading extraction…" />}
        {detailError && <p className="text-sm text-rose-700" role="alert">{detailError}</p>}
        {detail && (
          <DocumentDrawerBody
            detail={detail}
            canEdit={canEdit}
            rescanning={busy === 'start'}
            onRescan={id => { void runScan('selected', [id]); }}
          />
        )}
      </Drawer>
    </div>
  );
}
