import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Download, Eye, FileSignature, FileText, Loader2, Lock, Pencil, Plus, RefreshCw, Search, Trash2, Upload, UserPlus, X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { Modal, PageHeader } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';
import AddVendorModal from '../components/AddVendorModal';
import { useAuthStore } from '../store/authStore';
import { fileDropHandlers } from '../lib/fileDrop';
import { formatDateOnly, formatEasternDateTime } from '../lib/time';
import { onVendorAdded, type AddedVendor } from '../lib/vendors';

// Documents & Agreements (Mike, 2026-10-01): every executed contract and signed
// agreement with a vendor or contractor, ordered by date and by the type of work.
// A document can never be saved without a vendor AND a project (enforced again by
// the server in routes/agreements.js).

interface Agreement {
  id: string;
  title: string;
  document_type: string;
  document_type_label: string;
  trade: string;
  executed_date: string;
  contract_amount: number | null;
  notes: string | null;
  contractor_profile_id: string;
  vendor_name: string;
  vendor_is_supplier: boolean;
  project_id: string;
  project_address: string | null;
  project_job_name: string | null;
  project_status: string | null;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  inline: boolean;
  file_url: string;
  uploaded_by_name: string | null;
  updated_by_name: string | null;
  created_at: string;
  updated_at: string;
}

interface VendorOption {
  id: string;
  name: string;
  email: string | null;
  is_supplier: boolean;
  status: string;
  categories: string[];
}

interface ProjectOption {
  id: string;
  address: string;
  job_name: string | null;
  status: string | null;
}

interface AgreementOptions {
  vendors: VendorOption[];
  projects: ProjectOption[];
  trades: string[];
  document_types: Array<{ value: string; label: string }>;
  max_file_mb: number;
}

type SortMode = 'date_desc' | 'date_asc' | 'trade';

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.gif,.webp,.heic,.heif,.tif,.tiff,.bmp,.doc,.docx,.odt,.rtf,application/pdf,image/*';

// Buttons use the app's .bt-vs-btn family (index.css): the dark Quiet Carbon theme
// repaints bg-white / bg-slate-* but not their hover: variants, so plain utility
// hovers would flash white. Fields and cards follow the Cost Analyzer / HR pages.
const primaryButton = 'bt-vs-btn bt-vs-btn--primary';
const secondaryButton = 'bt-vs-btn';
const iconButton = 'bt-vs-btn bt-vs-btn--icon';
const fieldClass =
  'h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-amber-600 focus:ring-2 focus:ring-amber-100';
const labelClass = 'mb-1 block text-xs font-semibold uppercase text-slate-500';
const cardClass = 'rounded-md border border-slate-200 bg-white shadow-sm';

const money = (value: number | null) => (value === null || value === undefined
  ? '—'
  : `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

const fileSize = (bytes: number) => {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(Math.round(bytes / 1024), 1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

function easternToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function projectLabel(row: { project_address?: string | null; project_job_name?: string | null; address?: string | null; job_name?: string | null }) {
  return row.project_address || row.address || row.project_job_name || row.job_name || 'Project';
}

function errorMessage(err: any, fallback: string) {
  return err?.response?.data?.error || fallback;
}

// The all-projects register (/agreements). Each project page shows the same
// workspace for its own project under its Documents & Agreements tab.
export default function Agreements() {
  return (
    <div className="bt-desktop-page bt-agreements-page mx-auto max-w-[1500px] space-y-4 p-4 md:p-6">
      <PageHeader
        title="Documents & Agreements"
        subtitle="Every executed contract and signed agreement with our vendors and contractors, across all projects."
      />
      <AgreementsWorkspace />
    </div>
  );
}

// `projectId` set = one project's tab: only its documents, and every upload is
// filed to it. Unset = every project, with a project filter and URL filters.
export function AgreementsWorkspace({ projectId = '', projectAddress = '' }: { projectId?: string; projectAddress?: string }) {
  const role = useAuthStore(state => state.user?.role);
  const canDelete = role === 'super_admin' || role === 'operations_manager';
  const projectMode = Boolean(projectId);
  const [searchParams, setSearchParams] = useSearchParams();

  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [options, setOptions] = useState<AgreementOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [query, setQuery] = useState(() => (projectMode ? '' : searchParams.get('search') || ''));
  const [projectFilter, setProjectFilter] = useState(() => (projectMode ? projectId : searchParams.get('project') || ''));
  const [vendorFilter, setVendorFilter] = useState(() => (projectMode ? '' : searchParams.get('vendor') || ''));
  const [tradeFilter, setTradeFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [sort, setSort] = useState<SortMode>('date_desc');

  const [formState, setFormState] = useState<{ mode: 'create' } | { mode: 'edit'; agreement: Agreement } | null>(null);
  const [viewing, setViewing] = useState<Agreement | null>(null);
  const [deleting, setDeleting] = useState<Agreement | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const loadOptions = useCallback(async () => {
    const res = await api.get<AgreementOptions>('/agreements/options');
    setOptions(res.data);
    return res.data;
  }, []);

  const loadAgreements = useCallback(async () => {
    const res = await api.get<{ agreements: Agreement[] }>('/agreements', { params: projectId ? { project_id: projectId } : undefined });
    setAgreements(Array.isArray(res.data?.agreements) ? res.data.agreements : []);
  }, [projectId]);

  const reload = useCallback(async () => {
    setLoadError('');
    try {
      await Promise.all([loadAgreements(), loadOptions()]);
    } catch (err) {
      setLoadError(errorMessage(err, 'Documents & Agreements could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, [loadAgreements, loadOptions]);

  useEffect(() => { void reload(); }, [reload]);

  // A vendor added from the top bar while this page is open shows up in the pickers.
  useEffect(() => onVendorAdded(() => { void loadOptions().catch(() => undefined); }), [loadOptions]);

  // Keep the shareable filters in the URL (?search=&project=&vendor=) - on the
  // all-projects page only; a project page keeps its own URL.
  useEffect(() => {
    if (projectMode) return;
    const next = new URLSearchParams();
    if (query.trim()) next.set('search', query.trim());
    if (projectFilter) next.set('project', projectFilter);
    if (vendorFilter) next.set('vendor', vendorFilter);
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, projectFilter, vendorFilter]);

  const tradeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of agreements) counts.set(row.trade, (counts.get(row.trade) || 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [agreements]);

  const vendorsOnFile = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of agreements) map.set(row.contractor_profile_id, row.vendor_name);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [agreements]);

  const projectsOnFile = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of agreements) map.set(row.project_id, projectLabel(row));
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [agreements]);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    const rows = agreements.filter(row => {
      if (projectFilter && row.project_id !== projectFilter) return false;
      if (vendorFilter && row.contractor_profile_id !== vendorFilter) return false;
      if (tradeFilter && row.trade !== tradeFilter) return false;
      if (typeFilter && row.document_type !== typeFilter) return false;
      if (!term) return true;
      return [row.title, row.vendor_name, row.trade, row.document_type_label, row.project_address, row.project_job_name, row.original_name, row.notes]
        .some(value => String(value || '').toLowerCase().includes(term));
    });
    const byDate = (a: Agreement, b: Agreement) => a.executed_date.localeCompare(b.executed_date)
      || String(a.created_at).localeCompare(String(b.created_at));
    if (sort === 'date_asc') return rows.sort(byDate);
    if (sort === 'trade') return rows.sort((a, b) => a.trade.localeCompare(b.trade) || byDate(b, a));
    return rows.sort((a, b) => byDate(b, a));
  }, [agreements, query, projectFilter, vendorFilter, tradeFilter, typeFilter, sort]);

  // Group headings only when ordered by type of work.
  const groups = useMemo(() => {
    if (sort !== 'trade') return [{ key: 'all', label: '', rows: visible }];
    const list: Array<{ key: string; label: string; rows: Agreement[] }> = [];
    for (const row of visible) {
      const last = list[list.length - 1];
      if (last && last.key === row.trade) last.rows.push(row);
      else list.push({ key: row.trade, label: row.trade, rows: [row] });
    }
    return list;
  }, [visible, sort]);

  const filtersActive = Boolean(query.trim() || (!projectMode && projectFilter) || vendorFilter || tradeFilter || typeFilter);
  const clearFilters = () => {
    setQuery('');
    if (!projectMode) setProjectFilter('');
    setVendorFilter('');
    setTradeFilter('');
    setTypeFilter('');
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await api.delete(`/agreements/${deleting.id}`);
      setAgreements(current => current.filter(row => row.id !== deleting.id));
      toast.success('Agreement deleted');
      setDeleting(null);
    } catch (err) {
      setDeleteError(errorMessage(err, 'The agreement could not be deleted.'));
    } finally {
      setDeleteBusy(false);
    }
  };

  const onSaved = (saved: Agreement, mode: 'create' | 'edit') => {
    setAgreements(current => (mode === 'create'
      ? [saved, ...current]
      : current.map(row => (row.id === saved.id ? saved : row))));
    void loadOptions().catch(() => undefined);
  };

  return (
    <div className="bt-agreements-workspace space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {projectMode ? (
            <h2 className="text-base font-bold text-slate-900">Documents &amp; Agreements</h2>
          ) : null}
          <p className="bt-agreements-secure mt-0.5 inline-flex items-center gap-1.5 text-xs text-slate-500">
            <Lock className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            Private: stored encrypted, opened only by signed-in management, every view logged. Never public, never shown to contractors.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {projectMode ? (
            <Link to="/agreements" className={secondaryButton} title="Every project's executed agreements in one list">
              All projects
            </Link>
          ) : null}
          <button type="button" className={primaryButton} onClick={() => setFormState({ mode: 'create' })}>
            <Upload className="h-4 w-4" aria-hidden="true" />
            Upload Agreement
          </button>
        </div>
      </div>

      <div className={`${cardClass} p-3`}>
        <div className={`grid gap-2 ${projectMode ? 'md:grid-cols-[minmax(14rem,2fr)_repeat(3,minmax(9rem,1fr))_auto]' : 'md:grid-cols-[minmax(14rem,2fr)_repeat(4,minmax(9rem,1fr))_auto]'}`}>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search title, vendor, project, type of work"
              aria-label="Search documents and agreements"
              className={`${fieldClass} pl-9`}
            />
          </div>
          {!projectMode ? (
            <select aria-label="Filter by project" value={projectFilter} onChange={event => setProjectFilter(event.target.value)} className={fieldClass}>
              <option value="">All projects</option>
              {projectsOnFile.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          ) : null}
          <select aria-label="Filter by vendor" value={vendorFilter} onChange={event => setVendorFilter(event.target.value)} className={fieldClass}>
            <option value="">All vendors</option>
            {vendorsOnFile.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <select aria-label="Filter by document type" value={typeFilter} onChange={event => setTypeFilter(event.target.value)} className={fieldClass}>
            <option value="">All document types</option>
            {(options?.document_types || []).map(type => <option key={type.value} value={type.value}>{type.label}</option>)}
          </select>
          <select aria-label="Sort" value={sort} onChange={event => setSort(event.target.value as SortMode)} className={fieldClass}>
            <option value="date_desc">Newest executed first</option>
            <option value="date_asc">Oldest executed first</option>
            <option value="trade">By type of work</option>
          </select>
          <button type="button" className={secondaryButton} onClick={() => { setLoading(true); void reload(); }} title="Reload">
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            <span className="md:sr-only xl:not-sr-only">Refresh</span>
          </button>
        </div>
        {tradeCounts.length ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by type of work">
            <span className="mr-1 text-[11px] font-semibold uppercase text-slate-500">Type of work</span>
            <button type="button" aria-pressed={!tradeFilter} onClick={() => setTradeFilter('')} className={`bt-chip-toggle ${!tradeFilter ? 'is-selected' : ''}`}>
              All <span className="bt-chip-count">{agreements.length}</span>
            </button>
            {tradeCounts.map(([trade, count]) => (
              <button
                key={trade}
                type="button"
                aria-pressed={tradeFilter === trade}
                onClick={() => setTradeFilter(current => (current === trade ? '' : trade))}
                className={`bt-chip-toggle ${tradeFilter === trade ? 'is-selected' : ''}`}
              >
                {trade} <span className="bt-chip-count">{count}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {loadError ? (
        <div className={`${cardClass} p-4`}>
          <p className="text-sm font-semibold text-slate-800">{loadError}</p>
          <button type="button" className={`${secondaryButton} mt-3`} onClick={() => { setLoading(true); void reload(); }}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again
          </button>
        </div>
      ) : loading ? (
        <div className={`${cardClass} flex items-center gap-2 p-6 text-sm font-semibold text-slate-500`}>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading documents…
        </div>
      ) : agreements.length === 0 ? (
        <div className={`${cardClass} flex flex-col items-center gap-3 px-6 py-12 text-center`}>
          <FileSignature className="h-9 w-9 text-slate-300" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-slate-800">{projectMode ? 'No executed agreements for this project yet' : 'No executed agreements on file yet'}</p>
            <p className="mt-1 text-sm text-slate-500">
              {projectMode
                ? 'Upload each signed contract or agreement and choose the vendor it is with.'
                : 'Upload a signed contract or agreement and file it to its vendor and project.'}
            </p>
          </div>
          <button type="button" className={primaryButton} onClick={() => setFormState({ mode: 'create' })}>
            <Upload className="h-4 w-4" aria-hidden="true" /> Upload Agreement
          </button>
        </div>
      ) : (
        <div className={`${cardClass} overflow-hidden`}>
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
            <p className="text-xs font-semibold text-slate-500">
              {visible.length === agreements.length ? `${agreements.length} document${agreements.length === 1 ? '' : 's'}` : `${visible.length} of ${agreements.length} documents`}
            </p>
            {filtersActive ? (
              <button type="button" onClick={clearFilters} className="inline-flex items-center gap-1 text-xs font-semibold text-amber-500 hover:underline">
                <X className="h-3.5 w-3.5" aria-hidden="true" /> Clear filters
              </button>
            ) : null}
          </div>
          {visible.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-slate-500">No documents match these filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={`bt-agreements-table w-full text-left text-sm ${projectMode ? 'min-w-[820px]' : 'min-w-[980px]'}`}>
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 font-semibold">Executed</th>
                    <th scope="col" className="px-4 py-2.5 font-semibold">Type of work</th>
                    <th scope="col" className="px-4 py-2.5 font-semibold">Document</th>
                    <th scope="col" className="px-4 py-2.5 font-semibold">Vendor</th>
                    {!projectMode ? <th scope="col" className="px-4 py-2.5 font-semibold">Project</th> : null}
                    <th scope="col" className="px-4 py-2.5 text-right font-semibold">Amount</th>
                    <th scope="col" className="px-4 py-2.5 font-semibold"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                {groups.map(group => (
                  <tbody key={group.key} className="divide-y divide-slate-200 bg-white">
                    {group.label ? (
                      <tr className="bt-agreements-group">
                        <th scope="rowgroup" colSpan={projectMode ? 6 : 7} className="bg-slate-50 px-4 py-2 text-xs font-semibold uppercase text-slate-600">
                          {group.label} <span className="font-normal text-slate-400">· {group.rows.length}</span>
                        </th>
                      </tr>
                    ) : null}
                    {group.rows.map(row => (
                      <tr
                        key={row.id}
                        className="bt-agreements-row cursor-pointer"
                        onClick={event => {
                          if ((event.target as HTMLElement).closest('button, a, input, select, textarea, label')) return;
                          if ((window.getSelection()?.toString() || '').length > 0) return;
                          setViewing(row);
                        }}
                      >
                        <td className="whitespace-nowrap px-4 py-2.5 align-top font-semibold text-slate-900">{formatDateOnly(row.executed_date)}</td>
                        <td className="px-4 py-2.5 align-top">
                          <span className="bt-agreements-trade">{row.trade}</span>
                        </td>
                        <td className="max-w-[22rem] px-4 py-2.5 align-top">
                          <button type="button" onClick={() => setViewing(row)} className="block max-w-full truncate text-left font-semibold text-slate-900 hover:text-amber-400 hover:underline" title={`Open ${row.title}`}>
                            {row.title}
                          </button>
                          <p className="mt-0.5 truncate text-xs text-slate-500" title={row.original_name}>
                            {row.document_type_label} · {row.original_name}
                          </p>
                        </td>
                        <td className="max-w-[14rem] px-4 py-2.5 align-top">
                          <p className="truncate font-medium text-slate-800" title={row.vendor_name}>{row.vendor_name}</p>
                          <p className="text-xs text-slate-500">{row.vendor_is_supplier ? 'Supplier' : 'Contractor'}</p>
                        </td>
                        {!projectMode ? (
                          <td className="max-w-[16rem] px-4 py-2.5 align-top">
                            <p className="truncate text-slate-800" title={projectLabel(row)}>{projectLabel(row)}</p>
                            {row.project_status === 'archived' ? <p className="text-xs text-slate-500">Archived</p> : null}
                          </td>
                        ) : null}
                        <td className="whitespace-nowrap px-4 py-2.5 text-right align-top tabular-nums text-slate-800">{money(row.contract_amount)}</td>
                        <td className="whitespace-nowrap px-4 py-2.5 align-top">
                          <div className="flex justify-end gap-1.5">
                            <button type="button" className={iconButton} onClick={() => setViewing(row)} title="View document" aria-label={`View ${row.title}`}>
                              <Eye className="h-4 w-4" />
                            </button>
                            <button type="button" className={iconButton} onClick={() => setFormState({ mode: 'edit', agreement: row })} title="Edit filing details" aria-label={`Edit ${row.title}`}>
                              <Pencil className="h-4 w-4" />
                            </button>
                            {canDelete ? (
                              <button type="button" className={`${iconButton} bt-vs-btn--danger`} onClick={() => { setDeleteError(''); setDeleting(row); }} title="Delete" aria-label={`Delete ${row.title}`}>
                                <Trash2 className="h-4 w-4" />
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          )}
        </div>
      )}

      {formState && options ? (
        <AgreementFormModal
          key={formState.mode === 'edit' ? formState.agreement.id : 'create'}
          mode={formState.mode}
          agreement={formState.mode === 'edit' ? formState.agreement : null}
          options={options}
          defaultProjectId={projectFilter}
          lockedProject={projectMode ? { id: projectId, address: projectAddress } : null}
          onClose={() => setFormState(null)}
          onSaved={onSaved}
          onOptionsChanged={() => loadOptions()}
        />
      ) : null}

      {viewing ? <AgreementViewer agreement={viewing} onClose={() => setViewing(null)} /> : null}

      <ConfirmDialog
        isOpen={Boolean(deleting)}
        title="Delete this agreement?"
        description={deleting ? `"${deleting.title}" with ${deleting.vendor_name} for ${projectLabel(deleting)} will be removed, including the stored document. This cannot be undone.` : undefined}
        confirmLabel="Delete agreement"
        busyLabel="Deleting…"
        tone="danger"
        busy={deleteBusy}
        error={deleteError}
        onConfirm={() => { void confirmDelete(); }}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

// ── Vendor picker: type to filter ~250 vendors, or add a new one ──────────────

function VendorPicker({ vendors, value, onChange, onAddNew, invalid }: {
  vendors: VendorOption[];
  value: string;
  onChange: (vendor: VendorOption | null) => void;
  onAddNew: (typedName: string) => void;
  invalid: boolean;
}) {
  const selected = vendors.find(vendor => vendor.id === value) || null;
  const [text, setText] = useState(selected?.name || '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setText(selected?.name || ''); }, [selected?.id, selected?.name]);

  const matches = useMemo(() => {
    const term = text.trim().toLowerCase();
    if (selected && text === selected.name) return vendors.slice(0, 50);
    return vendors.filter(vendor => !term || vendor.name.toLowerCase().includes(term)
      || vendor.categories.some(category => category.toLowerCase().includes(term))).slice(0, 50);
  }, [vendors, text, selected]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const choose = (vendor: VendorOption) => {
    onChange(vendor);
    setText(vendor.name);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive(index => Math.min(index + 1, matches.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(index => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && open && matches[active]) {
      event.preventDefault();
      choose(matches[active]);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex gap-2">
        <input
          id="agreement-vendor"
          role="combobox"
          aria-expanded={open}
          aria-controls="agreement-vendor-list"
          aria-autocomplete="list"
          aria-invalid={invalid}
          value={text}
          onChange={event => {
            setText(event.target.value);
            setOpen(true);
            setActive(0);
            if (selected && event.target.value !== selected.name) onChange(null);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Type to find the vendor"
          autoComplete="off"
          className={`${fieldClass} ${invalid ? 'border-red-400' : ''}`}
        />
        <button type="button" className={`${secondaryButton} flex-shrink-0`} onClick={() => onAddNew(selected ? '' : text.trim())} title="Add a vendor that is not in the system yet">
          <UserPlus className="h-4 w-4" aria-hidden="true" />
          New
        </button>
      </div>
      {open ? (
        <ul id="agreement-vendor-list" role="listbox" className="bt-agreements-vendor-list absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-md border border-slate-300 bg-white py-1 shadow-lg">
          {matches.map((vendor, index) => (
            <li
              key={vendor.id}
              role="option"
              aria-selected={vendor.id === value}
              onMouseDown={event => { event.preventDefault(); choose(vendor); }}
              onMouseEnter={() => setActive(index)}
              className={`cursor-pointer px-3 py-1.5 text-sm ${index === active ? 'is-active' : ''}`}
            >
              <span className="font-semibold text-slate-900">{vendor.name}</span>
              <span className="ml-2 text-xs text-slate-500">
                {vendor.is_supplier ? 'Supplier' : 'Contractor'}{vendor.categories.length ? ` · ${vendor.categories.slice(0, 2).join(', ')}` : ''}
              </span>
            </li>
          ))}
          {!matches.length ? (
            <li className="px-3 py-2 text-sm text-slate-500">
              No vendor matches “{text.trim()}”.{' '}
              <button type="button" onMouseDown={event => { event.preventDefault(); onAddNew(text.trim()); }} className="font-semibold text-amber-500 hover:underline">
                Add it as a new vendor
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

// ── Upload / edit form ────────────────────────────────────────────────────────

function AgreementFormModal({ mode, agreement, options, defaultProjectId, lockedProject, onClose, onSaved, onOptionsChanged }: {
  mode: 'create' | 'edit';
  agreement: Agreement | null;
  options: AgreementOptions;
  defaultProjectId: string;
  /** On a project's tab the document is always filed to that project. */
  lockedProject: { id: string; address: string } | null;
  onClose: () => void;
  onSaved: (agreement: Agreement, mode: 'create' | 'edit') => void;
  onOptionsChanged: () => Promise<AgreementOptions>;
}) {
  const isEdit = mode === 'edit' && Boolean(agreement);
  const [vendors, setVendors] = useState<VendorOption[]>(options.vendors);
  const [file, setFile] = useState<File | null>(null);
  const [form, setForm] = useState(() => ({
    contractor_profile_id: agreement?.contractor_profile_id || '',
    project_id: lockedProject?.id || agreement?.project_id || defaultProjectId || '',
    trade: agreement?.trade || '',
    document_type: agreement?.document_type || 'contract',
    executed_date: agreement?.executed_date || easternToday(),
    title: agreement?.title || '',
    contract_amount: agreement?.contract_amount === null || agreement?.contract_amount === undefined ? '' : String(agreement.contract_amount),
    notes: agreement?.notes || '',
  }));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [addVendorName, setAddVendorName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const titleEdited = useRef(Boolean(agreement?.title));
  const tradeEdited = useRef(Boolean(agreement?.trade));

  useEffect(() => { setVendors(options.vendors); }, [options.vendors]);

  const missing = {
    file: !isEdit && !file,
    vendor: !form.contractor_profile_id,
    project: !form.project_id,
    trade: !form.trade.trim(),
    date: !form.executed_date,
  };
  const canSave = !Object.values(missing).some(Boolean) && !saving;

  const set = (patch: Partial<typeof form>) => setForm(current => ({ ...current, ...patch }));

  const pickFile = (next: File | null) => {
    if (!next) return;
    const maxBytes = (options.max_file_mb || 50) * 1024 * 1024;
    if (next.size > maxBytes) {
      setError(`The document must be ${options.max_file_mb || 50} MB or smaller`);
      return;
    }
    setError('');
    setFile(next);
    if (!titleEdited.current) set({ title: next.name.replace(/\.[^.]+$/, '') });
  };

  const pickVendor = (vendor: VendorOption | null) => {
    set({ contractor_profile_id: vendor?.id || '' });
    if (vendor && !tradeEdited.current && vendor.categories.length) set({ trade: vendor.categories[0] });
  };

  const submit = async (event: FormEvent, again = false) => {
    event.preventDefault();
    setTouched(true);
    if (!canSave) {
      setError(missing.file ? 'Attach the executed document'
        : missing.vendor ? 'Choose the vendor this agreement is with - it cannot be saved without one'
          : missing.project ? 'Choose the project this agreement is for - it cannot be saved without one'
            : missing.trade ? 'Enter the type of work (for example Roofing)'
              : 'Enter the date the agreement was executed');
      return;
    }
    setSaving(true);
    setError('');
    try {
      let saved: Agreement;
      if (isEdit && agreement) {
        const res = await api.put<{ agreement: Agreement }>(`/agreements/${agreement.id}`, form);
        saved = res.data.agreement;
      } else {
        const body = new FormData();
        Object.entries(form).forEach(([key, value]) => body.append(key, String(value ?? '')));
        if (file) body.append('file', file);
        const res = await api.post<{ agreement: Agreement }>('/agreements', body, { headers: { 'Content-Type': 'multipart/form-data' } });
        saved = res.data.agreement;
      }
      onSaved(saved, isEdit ? 'edit' : 'create');
      toast.success(isEdit ? 'Agreement updated' : `Filed: ${saved.title}`);
      if (again) {
        // Keep the vendor and project; the next document is usually for the same job.
        setFile(null);
        titleEdited.current = false;
        set({ title: '', contract_amount: '', notes: '' });
        setTouched(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      } else {
        onClose();
      }
    } catch (err) {
      setError(errorMessage(err, 'The agreement could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  const vendorAdded = async (vendor: AddedVendor) => {
    try {
      const fresh = await onOptionsChanged();
      setVendors(fresh.vendors);
    } catch {
      setVendors(current => (current.some(row => row.id === vendor.id)
        ? current
        : [...current, { id: vendor.id, name: vendor.name, email: null, is_supplier: vendor.type === 'supplier', status: 'active', categories: [] }]));
    }
    set({ contractor_profile_id: vendor.id });
  };

  const showError = (flag: boolean) => touched && flag;

  return (
    <Modal
      isOpen
      onClose={() => { if (!saving) onClose(); }}
      title={isEdit ? 'Edit agreement' : 'Upload executed agreement'}
      description={isEdit ? 'Change how this document is filed. The document itself stays the same.' : 'Every document must be filed to a vendor and a project.'}
      size="lg"
    >
      <form onSubmit={event => { void submit(event); }} noValidate className="space-y-4">
        {!isEdit ? (
          <div>
            <span className={labelClass}>Executed document *</span>
            <div
              className={`bt-agreements-drop ${showError(missing.file) ? 'is-invalid' : ''}`}
              {...fileDropHandlers(files => pickFile(files[0] || null), { multiple: false, disabled: saving })}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPT}
                className="sr-only"
                id="agreement-file"
                onChange={event => pickFile(event.target.files?.[0] || null)}
              />
              {file ? (
                <div className="flex min-w-0 items-center gap-3">
                  <FileText className="h-5 w-5 flex-shrink-0 text-amber-500" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-900">{file.name}</p>
                    <p className="text-xs text-slate-500">{fileSize(file.size)}</p>
                  </div>
                  <label htmlFor="agreement-file" className={`${secondaryButton} cursor-pointer`}>Change</label>
                </div>
              ) : (
                <label htmlFor="agreement-file" className="flex cursor-pointer flex-col items-center gap-1 py-2 text-center">
                  <Upload className="h-5 w-5 text-slate-400" aria-hidden="true" />
                  <span className="text-sm font-semibold text-slate-800">Drop the signed document here, or click to choose</span>
                  <span className="text-xs text-slate-500">PDF, photo or scan, or Word document · up to {options.max_file_mb || 50} MB</span>
                </label>
              )}
            </div>
          </div>
        ) : (
          <p className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <FileText className="h-4 w-4 flex-shrink-0 text-slate-400" aria-hidden="true" />
            <span className="truncate">{agreement?.original_name} · {fileSize(agreement?.size_bytes || 0)}</span>
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="agreement-vendor" className={labelClass}>Vendor *</label>
            <VendorPicker
              vendors={vendors}
              value={form.contractor_profile_id}
              onChange={pickVendor}
              onAddNew={name => setAddVendorName(name)}
              invalid={showError(missing.vendor)}
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="agreement-project" className={labelClass}>Project *</label>
            <select
              id="agreement-project"
              value={form.project_id}
              disabled={Boolean(lockedProject)}
              title={lockedProject ? 'Filed to this project' : undefined}
              onChange={event => set({ project_id: event.target.value })}
              aria-invalid={showError(missing.project)}
              className={`${fieldClass} ${showError(missing.project) ? 'border-red-400' : ''}`}
            >
              <option value="">Choose the project…</option>
              {options.projects.map(project => (
                <option key={project.id} value={project.id}>
                  {project.address}{project.status === 'archived' ? ' (archived)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="agreement-trade" className={labelClass}>Type of work *</label>
            <input
              id="agreement-trade"
              list="agreement-trade-options"
              value={form.trade}
              onChange={event => { tradeEdited.current = true; set({ trade: event.target.value }); }}
              placeholder="Roofing"
              maxLength={80}
              aria-invalid={showError(missing.trade)}
              className={`${fieldClass} ${showError(missing.trade) ? 'border-red-400' : ''}`}
            />
            <datalist id="agreement-trade-options">
              {options.trades.map(trade => <option key={trade} value={trade} />)}
            </datalist>
          </div>
          <div>
            <label htmlFor="agreement-type" className={labelClass}>Document type *</label>
            <select id="agreement-type" value={form.document_type} onChange={event => set({ document_type: event.target.value })} className={fieldClass}>
              {options.document_types.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="agreement-date" className={labelClass}>Date executed *</label>
            <input
              id="agreement-date"
              type="date"
              value={form.executed_date}
              max={easternToday()}
              onChange={event => set({ executed_date: event.target.value })}
              aria-invalid={showError(missing.date)}
              className={`${fieldClass} ${showError(missing.date) ? 'border-red-400' : ''}`}
            />
          </div>
          <div>
            <label htmlFor="agreement-amount" className={labelClass}>Contract amount</label>
            <input
              id="agreement-amount"
              inputMode="decimal"
              value={form.contract_amount}
              onChange={event => set({ contract_amount: event.target.value })}
              placeholder="Optional"
              className={fieldClass}
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="agreement-title" className={labelClass}>Title</label>
            <input
              id="agreement-title"
              value={form.title}
              onChange={event => { titleEdited.current = true; set({ title: event.target.value }); }}
              maxLength={200}
              placeholder="Taken from the file name if left blank"
              className={fieldClass}
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="agreement-notes" className={labelClass}>Notes</label>
            <textarea
              id="agreement-notes"
              value={form.notes}
              onChange={event => set({ notes: event.target.value })}
              maxLength={2000}
              rows={2}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-amber-600 focus:ring-2 focus:ring-amber-100"
            />
          </div>
        </div>

        {error ? (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</div>
        ) : !canSave && !saving && (missing.vendor || missing.project) ? (
          <p className="text-xs font-semibold text-slate-500">A vendor and a project are required before this document can be saved.</p>
        ) : null}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className={secondaryButton} onClick={onClose} disabled={saving}>Cancel</button>
          {!isEdit ? (
            <button type="button" className={secondaryButton} disabled={!canSave} aria-disabled={!canSave} onClick={event => { void submit(event as unknown as FormEvent, true); }}>
              <Plus className="h-4 w-4" aria-hidden="true" /> Save &amp; add another
            </button>
          ) : null}
          <button type="submit" className={primaryButton} disabled={!canSave} aria-disabled={!canSave}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Save agreement'}
          </button>
        </div>
      </form>

      <AddVendorModal
        isOpen={addVendorName !== null}
        onClose={() => setAddVendorName(null)}
        initialName={addVendorName || ''}
        defaultProjectId={form.project_id || null}
        onAdded={vendor => { void vendorAdded(vendor); }}
      />
    </Modal>
  );
}

// ── Viewer: the document is fetched as a blob (the API is Bearer-only, so an
// <a href> to /api would open a 401 page) and re-typed from its stored MIME type.

function AgreementViewer({ agreement, onClose }: { agreement: Agreement; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    setUrl(null);
    setError('');
    if (!agreement.inline) return undefined;
    api.get(agreement.file_url.replace(/^\/api/, ''), { responseType: 'blob' })
      .then(res => {
        if (!active) return;
        const blob = new Blob([res.data], { type: agreement.mime_type });
        urlRef.current = URL.createObjectURL(blob);
        setUrl(urlRef.current);
      })
      .catch(err => {
        if (active) setError(err?.response?.status === 410 ? 'This document is no longer available.' : 'The document could not be opened.');
      });
    return () => {
      active = false;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [agreement.id, agreement.file_url, agreement.inline, agreement.mime_type]);

  const download = async () => {
    try {
      const res = await api.get(agreement.file_url.replace(/^\/api/, ''), { params: { download: 1 }, responseType: 'blob' });
      const blobUrl = URL.createObjectURL(new Blob([res.data], { type: agreement.mime_type }));
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = agreement.original_name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
    } catch {
      toast.error('The document could not be downloaded');
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={agreement.title}
      description={`${agreement.document_type_label} · ${agreement.vendor_name} · ${projectLabel(agreement)}`}
      size="2xl"
      panelClassName="h-[90vh]"
      bodyClassName="flex min-h-0 flex-1 flex-col gap-3 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
        <p>
          Executed <strong className="text-slate-900">{formatDateOnly(agreement.executed_date)}</strong>
          {' · '}{agreement.trade}
          {agreement.contract_amount !== null ? <> · {money(agreement.contract_amount)}</> : null}
          {agreement.uploaded_by_name ? <> · filed by {agreement.uploaded_by_name} {formatEasternDateTime(agreement.created_at, { month: 'short', day: 'numeric', year: 'numeric' })}</> : null}
        </p>
        <button type="button" className={secondaryButton} onClick={() => { void download(); }}>
          <Download className="h-4 w-4" aria-hidden="true" /> Download
        </button>
      </div>
      {agreement.notes ? <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">{agreement.notes}</p> : null}
      <div className="bt-agreements-frame min-h-0 flex-1 overflow-hidden rounded-md border border-slate-200" style={{ background: '#f8fafc' }}>
        {!agreement.inline ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <FileText className="h-10 w-10 text-slate-300" aria-hidden="true" />
            <p className="text-sm text-slate-600">This file type cannot be previewed in the browser.</p>
            <button type="button" className={primaryButton} onClick={() => { void download(); }}>
              <Download className="h-4 w-4" aria-hidden="true" /> Download {agreement.original_name}
            </button>
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center p-6 text-sm font-semibold text-red-700">{error}</div>
        ) : !url ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Opening…
          </div>
        ) : agreement.mime_type === 'application/pdf' ? (
          <iframe src={url} title={agreement.title} className="h-full w-full" style={{ background: '#ffffff' }} />
        ) : (
          <div className="flex h-full items-center justify-center overflow-auto p-2">
            <img src={url} alt={agreement.title} data-no-image-lightbox="true" className="max-h-full max-w-full object-contain" />
          </div>
        )}
      </div>
    </Modal>
  );
}
