import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ClipboardList, Scale, CheckCircle2, Paperclip, History, Plus, Search, Download,
  Check, X, ChevronRight, ChevronDown, RefreshCw, FileText, Trash2, Wand2, Ban, RotateCcw,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { PageHeader, Loading, Empty, Modal } from '../components/ui';
import api from '../lib/api';
import { useAuthStore } from '../store/authStore';
import {
  fetchQuoteOptions, fetchQuoteSummary, fetchQuotes, fetchBidComparison,
  fetchQuoteActivity, approveQuote, denyQuote, restoreQuote, deleteQuote, createQuote, updateQuote, uploadQuote, extractQuote,
  fetchQuoteNotes, addQuoteNote, deleteQuoteNote,
  type ContractorQuote, type QuoteOptions, type QuoteListParams,
  type CompareResponse, type ActivityRow, type QuoteNote,
} from '../lib/quotesApi';
import { formatEasternDateTime } from '../lib/time';
import '../styles/quotes.css';

const PAGE_SIZE = 50;

type TabKey = 'all' | 'compare' | 'approved' | 'rejected' | 'attachments' | 'audit';

const TABS: Array<{ key: TabKey; label: string; icon: typeof ClipboardList }> = [
  { key: 'all', label: 'All Quotes', icon: FileText },
  { key: 'compare', label: 'Compare Bids', icon: Scale },
  { key: 'approved', label: 'Approved Quotes', icon: CheckCircle2 },
  { key: 'rejected', label: 'Rejected Quotes', icon: Ban },
  { key: 'attachments', label: 'Attachments', icon: Paperclip },
  { key: 'audit', label: 'Audit Log', icon: History },
];

const APPROVED_STATUSES = new Set(['approved', 'paid', 'completed']);

interface ProjectBudget {
  id: string;
  budget: number | null;
}

interface QuoteFilters {
  project_id: string;
  contractor: string;
  category: string;
  status: string;
  start_date: string;
  end_date: string;
  search: string;
}

const blankFilters = (): QuoteFilters => ({
  project_id: '', contractor: '', category: '', status: '', start_date: '', end_date: '', search: '',
});

interface QuoteLineForm {
  category: string;
  description: string;
  quantity: string;
  unit: string;
  unit_price: string;
  total_line_item_price: string;
}

interface QuoteForm {
  project_id: string;
  contractor_name: string;
  contractor_company: string;
  contractor_email: string;
  contractor_phone: string;
  quote_date: string;
  status: string;
  scope_description: string;
  notes: string;
}

function todayIso(): string {
  // Avoid Date.now-free constraints in app code (browser context is fine).
  return new Date().toISOString().slice(0, 10);
}

const blankQuoteForm = (): QuoteForm => ({
  project_id: '', contractor_name: '', contractor_company: '', contractor_email: '',
  contractor_phone: '', quote_date: todayIso(), status: 'submitted', scope_description: '', notes: '',
});

const blankLine = (category = ''): QuoteLineForm => ({
  category, description: '', quantity: '1', unit: '', unit_price: '', total_line_item_price: '',
});

function num(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: number | string | null | undefined): string {
  return num(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

// Lump-sum / AI-extracted line items store the whole amount in total_line_item_price
// and leave unit_price at 0, which used to render a misleading "$0.00" unit cost.
// Derive an effective per-unit figure from total/qty, and tag single-line lump sums.
function unitCostCell(item: { unit_price?: number | string | null; quantity?: number | string | null; total_line_item_price?: number | string | null }): { text: string; lump: boolean } {
  const unit = num(item.unit_price);
  if (unit > 0) return { text: money(unit), lump: false };
  const qty = num(item.quantity);
  const total = num(item.total_line_item_price);
  if (total > 0 && qty > 0) return { text: money(total / qty), lump: qty === 1 };
  return { text: money(0), lump: false };
}

function shortDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Source-file upload helpers ───────────────────────────────────────────────
const MAX_UPLOAD_MB = 20; // matches backend MAX_FILE_SIZE_MB default
const ACCEPTED_UPLOAD = '.pdf,.png,.jpg,.jpeg,.webp,.gif,.csv,.txt,.xls,.xlsx,application/pdf,image/*';

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function isImageFile(file: File): boolean {
  return /^image\//i.test(file.type) || /\.(png|jpe?g|webp|gif|heic|heif)$/i.test(file.name);
}

function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

function isAcceptedUpload(file: File): boolean {
  return isPdfFile(file) || isImageFile(file)
    || /\.(csv|txt|xls|xlsx)$/i.test(file.name)
    || /(csv|excel|spreadsheet|text\/plain)/i.test(file.type);
}

// The AI extractor (backend) only accepts PDFs and images.
function isAiReadable(file: File): boolean {
  return isPdfFile(file) || isImageFile(file);
}

function validateUpload(file: File): string | null {
  if (!isAcceptedUpload(file)) return 'Unsupported file type. Use PDF, image, CSV, TXT, or Excel.';
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return `That file is too large (max ${MAX_UPLOAD_MB} MB).`;
  return null;
}

const STATUS_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  draft: { bg: 'rgba(148,163,184,0.20)', color: '#CBD5E1', label: 'Draft' },
  submitted: { bg: 'rgba(59,130,246,0.22)', color: '#93C5FD', label: 'For Review' },
  approved: { bg: 'rgba(34,197,94,0.22)', color: '#6EE7A0', label: 'Approved' },
  rejected: { bg: 'rgba(239,68,68,0.22)', color: '#FCA5A5', label: 'Rejected' },
  paid: { bg: 'rgba(16,185,129,0.22)', color: '#6EE7B7', label: 'Paid' },
  completed: { bg: 'rgba(129,140,248,0.24)', color: '#BFC6FF', label: 'Completed' },
  historical: { bg: 'rgba(148,163,184,0.18)', color: '#AEBBD2', label: 'In Database' },
};

function StatusPill({ status }: { status: string }) {
  const style = STATUS_STYLES[status] || { bg: '#F3F4F6', color: '#4B5563', label: status.replace(/_/g, ' ') };
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ background: style.bg, color: style.color }}>
      {style.label}
    </span>
  );
}

function SummaryCard({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-3.5 py-3 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      <p className={`mt-1 text-lg font-bold leading-tight ${accent ? '' : 'text-gray-900'}`} style={accent ? { color: accent } : undefined}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-gray-400">{hint}</p>}
    </div>
  );
}

function primaryCategory(quote: ContractorQuote): string {
  const items = quote.line_items || [];
  if (items.length === 0) return '—';
  const categories = Array.from(new Set(items.map(item => item.category).filter(Boolean) as string[]));
  if (categories.length === 0) return '—';
  return categories.length === 1 ? categories[0] : `${categories[0]} +${categories.length - 1}`;
}

function quoteTitle(quote: ContractorQuote): string {
  const scope = String(quote.scope_description || '').split(/\n+/).map(s => s.trim()).find(Boolean);
  if (scope) return scope;
  const first = (quote.line_items || [])[0];
  return first?.description || first?.category || 'Untitled quote';
}

// Collapse whitespace and cap at n chars (full text shown when the row is expanded).
function clipText(text: string, n = 50): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n).trimEnd()}…` : t;
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  // Neutralize spreadsheet formula injection from contractor-supplied fields.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export default function Quotes() {
  const [options, setOptions] = useState<QuoteOptions | null>(null);
  const [budgets, setBudgets] = useState<Record<string, number | null>>({});
  const [tab, setTab] = useState<TabKey>('all');
  const [filters, setFilters] = useState<QuoteFilters>(blankFilters);

  const [quotes, setQuotes] = useState<ContractorQuote[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [summary, setSummary] = useState<any>(null);
  const [approvedAgg, setApprovedAgg] = useState<{ count: number; total: number }>({ count: 0, total: 0 });
  const [pendingCount, setPendingCount] = useState(0);
  const [catRange, setCatRange] = useState<{ low: number; high: number }>({ low: 0, high: 0 });

  const [sortKey, setSortKey] = useState<'date' | 'total'>('date');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const [compare, setCompare] = useState<CompareResponse | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareCandidates, setCompareCandidates] = useState<Array<{ id: string; label: string }>>([]);

  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  const [showAdd, setShowAdd] = useState(false);
  const [editQuote, setEditQuote] = useState<ContractorQuote | null>(null);

  const role = useAuthStore(s => s.user?.role);
  const canDelete = role === 'super_admin' || role === 'operations_manager';
  const canExportCsv = role === 'super_admin' || role === 'operations_manager';

  // ── Bootstrap: options + project budgets ──────────────────────────────────
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const opts = await fetchQuoteOptions();
        if (active) setOptions(opts);
      } catch {
        if (active) toast.error('Failed to load quote options');
      }
      try {
        const res = await api.get('/projects');
        if (active && Array.isArray(res.data)) {
          const map: Record<string, number | null> = {};
          for (const project of res.data as Array<ProjectBudget & Record<string, unknown>>) {
            map[project.id] = project.budget === null || project.budget === undefined ? null : Number(project.budget);
          }
          setBudgets(map);
        }
      } catch {
        /* budgets are optional */
      }
    })();
    return () => { active = false; };
  }, []);

  const listParams = useCallback((): QuoteListParams => {
    const params: QuoteListParams = { limit: 500, page: 1 };
    if (filters.project_id) params.project_id = filters.project_id;
    if (filters.contractor.trim()) params.contractor = filters.contractor.trim();
    if (filters.category) params.category = filters.category;
    if (filters.start_date) params.start_date = filters.start_date;
    if (filters.end_date) params.end_date = filters.end_date;
    if (filters.status) {
      params.status = filters.status;
    } else if (tab === 'approved') {
      params.quote_filter = 'approved';
    } else if (tab === 'rejected') {
      params.quote_filter = 'rejected';
    } else {
      params.quote_filter = 'database';
    }
    return params;
  }, [filters, tab]);

  // ── Load the quote list for grid-style tabs ────────────────────────────────
  const loadList = useCallback(async () => {
    if (tab === 'compare' || tab === 'audit') return;
    setListLoading(true);
    try {
      const res = await fetchQuotes(listParams());
      setQuotes(res.quotes || []);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to load quotes');
      setQuotes([]);
    } finally {
      setListLoading(false);
    }
  }, [tab, listParams]);

  useEffect(() => { setPage(1); }, [tab, filters]);
  useEffect(() => { void loadList(); }, [loadList]);

  // ── Summary metrics (respect project filter) ───────────────────────────────
  const loadSummary = useCallback(async () => {
    const params: Record<string, string> = {};
    if (filters.project_id) params.project_id = filters.project_id;
    try {
      const data = await fetchQuoteSummary(params);
      setSummary(data);
      const statusCounts: Array<{ key: string; count: number }> = data?.status_counts || [];
      setPendingCount(statusCounts.find(s => s.key === 'submitted')?.count || 0);
    } catch {
      setSummary(null);
    }
    try {
      const approved = await fetchQuotes({ ...(filters.project_id ? { project_id: filters.project_id } : {}), quote_filter: 'approved', limit: 500 });
      const total = (approved.quotes || []).reduce(
        (sum, q) => sum + num(q.final_approved_amount ?? q.total_quote_amount), 0,
      );
      setApprovedAgg({ count: approved.total ?? (approved.quotes || []).length, total });
    } catch {
      setApprovedAgg({ count: 0, total: 0 });
    }
    // Lowest / highest contractor BID for the selected trade category (per-quote
    // category totals across all quotes). Shows 0/0 when no category is selected.
    if (filters.category) {
      try {
        const catRes = await fetchQuotes({
          category: filters.category,
          quote_filter: 'database',
          limit: 500,
          ...(filters.project_id ? { project_id: filters.project_id } : {}),
        });
        // Each quote's full bid (its quote total) among quotes that include this category.
        const bids = (catRes.quotes || [])
          .map(q => num(q.total_quote_amount))
          .filter(v => v > 0);
        setCatRange({ low: bids.length ? Math.min(...bids) : 0, high: bids.length ? Math.max(...bids) : 0 });
      } catch {
        setCatRange({ low: 0, high: 0 });
      }
    } else {
      setCatRange({ low: 0, high: 0 });
    }
  }, [filters.project_id, filters.category]);

  useEffect(() => { void loadSummary(); }, [loadSummary]);

  // ── Compare tab ────────────────────────────────────────────────────────────
  const loadCompare = useCallback(async () => {
    if (tab !== 'compare' || !filters.project_id) { setCompare(null); return; }
    setCompareLoading(true);
    try {
      const data = await fetchBidComparison({
        project_id: filters.project_id,
        ...(filters.category ? { category: filters.category } : {}),
      });
      setCompare(data);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to load bid comparison');
      setCompare(null);
    } finally {
      setCompareLoading(false);
    }
  }, [tab, filters.project_id, filters.category]);

  useEffect(() => { void loadCompare(); }, [loadCompare]);

  // When Compare is open with no project chosen, find the projects that actually
  // have quotes: auto-select if there's only one, otherwise offer them as quick picks.
  useEffect(() => {
    if (tab !== 'compare' || filters.project_id) { setCompareCandidates([]); return; }
    let active = true;
    fetchQuotes({ quote_filter: 'database', limit: 500, ...(filters.category ? { category: filters.category } : {}) })
      .then(res => {
        if (!active) return;
        const map = new Map<string, string>();
        for (const q of res.quotes || []) {
          if (!map.has(q.project_id)) map.set(q.project_id, q.property_address || q.project_name || q.project_id);
        }
        const list = Array.from(map.entries()).map(([id, label]) => ({ id, label }));
        if (list.length === 1) {
          setFilters(f => ({ ...f, project_id: list[0].id })); // only one project with quotes → just show it
        } else {
          setCompareCandidates(list);
        }
      })
      .catch(() => { if (active) setCompareCandidates([]); });
    return () => { active = false; };
  }, [tab, filters.project_id, filters.category]);

  // ── Audit tab ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (tab !== 'audit') return;
    let active = true;
    setActivityLoading(true);
    (async () => {
      try {
        const rows = await fetchQuoteActivity();
        if (active) setActivity(rows.filter(r => String(r.action || '').startsWith('quote')));
      } catch {
        if (active) setActivity([]);
      } finally {
        if (active) setActivityLoading(false);
      }
    })();
    return () => { active = false; };
  }, [tab]);

  const reloadAll = useCallback(() => {
    void loadList();
    void loadSummary();
    void loadCompare();
  }, [loadList, loadSummary, loadCompare]);

  // ── Client-side search + sort + pagination over the loaded set ─────────────
  const filteredSorted = useMemo(() => {
    const term = filters.search.trim().toLowerCase();
    let rows = quotes;
    if (term) {
      rows = rows.filter(q =>
        [q.contractor_name, q.contractor_company, q.quote_number, q.property_address, q.project_name, quoteTitle(q)]
          .some(v => String(v || '').toLowerCase().includes(term)));
    }
    const sorted = [...rows].sort((a, b) => {
      if (sortKey === 'total') return num(a.total_quote_amount) - num(b.total_quote_amount);
      return new Date(a.quote_date).getTime() - new Date(b.quote_date).getTime();
    });
    if (sortDir === 'desc') sorted.reverse();
    return sorted;
  }, [quotes, filters.search, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filteredSorted.length / PAGE_SIZE));
  const pageRows = useMemo(
    () => filteredSorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filteredSorted, page],
  );

  const attachmentRows = useMemo(() => filteredSorted.filter(q => q.document_download_url), [filteredSorted]);

  const toggleSort = (key: 'date' | 'total') => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('desc'); }
  };

  const handleApprove = async (quote: ContractorQuote) => {
    setBusyId(quote.id);
    try {
      await approveQuote(quote.id, {});
      toast.success(`Approved ${quote.quote_number}`);
      reloadAll();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to approve quote');
    } finally { setBusyId(null); }
  };

  const handleDeny = async (quote: ContractorQuote) => {
    setBusyId(quote.id);
    try {
      await denyQuote(quote.id, {});
      toast.success(`Denied ${quote.quote_number}`);
      reloadAll();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to deny quote');
    } finally { setBusyId(null); }
  };

  const handleRestore = async (quote: ContractorQuote) => {
    setBusyId(quote.id);
    try {
      await restoreQuote(quote.id, {});
      toast.success(`Restored ${quote.quote_number} to review`);
      reloadAll();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to restore quote');
    } finally { setBusyId(null); }
  };

  const handleModify = (quote: ContractorQuote) => setEditQuote(quote);

  const handleDelete = async (quote: ContractorQuote) => {
    if (!window.confirm(`Permanently delete quote ${quote.quote_number} from ${quote.contractor_company || quote.contractor_name}? This cannot be undone.`)) return;
    setBusyId(quote.id);
    try {
      await deleteQuote(quote.id);
      toast.success(`Deleted ${quote.quote_number}`);
      reloadAll();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to delete quote');
    } finally { setBusyId(null); }
  };

  const exportCsv = () => {
    const header = ['Quote #', 'Project', 'Contractor', 'Company', 'Categories', 'Title', 'Line Items', 'Total', 'Approved Amount', 'Status', 'Quote Date', 'Source File'];
    const lines = filteredSorted.map(q => [
      q.quote_number, q.property_address || q.project_name || '', q.contractor_name,
      q.contractor_company || '', primaryCategory(q), quoteTitle(q), (q.line_items || []).length,
      num(q.total_quote_amount).toFixed(2),
      q.final_approved_amount === null || q.final_approved_amount === undefined ? '' : num(q.final_approved_amount).toFixed(2),
      q.status, q.quote_date, q.document_original_name || q.source_file_name || '',
    ].map(csvCell).join(','));
    const blob = new Blob([[header.map(csvCell).join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `quotes-${tab}-${todayIso()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const selectedBudget = filters.project_id ? budgets[filters.project_id] ?? null : null;

  return (
    <div className="bt-quotes-dark min-h-full px-4 py-6 md:px-6">
      <PageHeader
        title="Quotes"
        subtitle="Company-wide contractor quote intake, bid leveling & approvals"
        actions={
          <>
            <button
              onClick={reloadAll}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
              title="Refresh"
            >
              <RefreshCw className="h-4 w-4" /> Refresh
            </button>
            <button
              onClick={() => setShowAdd(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 px-3 py-2 text-sm font-semibold text-slate-100 transition-colors hover:border-cyan-300 hover:text-white"
              style={{ background: 'linear-gradient(135deg, #334155, #0f172a)' }}
            >
              <Plus className="h-4 w-4" /> Add Quote
            </button>
          </>
        }
      />

      {/* Summary cards */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <SummaryCard label="Total Approved" value={money(approvedAgg.total)} hint={`${approvedAgg.count} approved`} accent="#34D399" />
        <SummaryCard label="Contractors" value={String(summary?.metrics?.contractors_count ?? 0)} hint="quoting" />
        <SummaryCard label="Pending Review" value={String(pendingCount)} hint="awaiting decision" accent="#60A5FA" />
        <SummaryCard
          label="Lowest / Highest Bid"
          value={
            filters.category
              ? `${money(catRange.low)} / ${money(catRange.high)}`
              : (num(summary?.metrics?.lowest_quote) > 0 || num(summary?.metrics?.highest_quote) > 0)
                ? `${money(summary?.metrics?.lowest_quote)} / ${money(summary?.metrics?.highest_quote)}`
                : '—'
          }
          hint={filters.category ? `${filters.category} category` : 'all quotes · pick a category to narrow'}
        />
        <SummaryCard
          label="Budget Variance"
          value={selectedBudget ? money(approvedAgg.total - selectedBudget) : '—'}
          hint={selectedBudget ? `Budget ${money(selectedBudget)}` : 'Select a project'}
          accent={selectedBudget && approvedAgg.total - selectedBudget > 0 ? '#F87171' : '#34D399'}
        />
      </div>

      {/* Tabs */}
      <div className="mb-4 flex flex-wrap gap-1 border-b border-gray-200">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors"
            style={{
              borderColor: tab === key ? '#22D3EE' : 'transparent',
              color: tab === key ? '#67E8F9' : '#94A3B8',
            }}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
          <input
            value={filters.search}
            onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
            placeholder="Search contractor, quote #, scope…"
            className="w-64 rounded-lg border border-gray-200 py-2 pl-8 pr-3 text-sm focus:border-amber-400 focus:outline-none"
          />
        </div>
        <select value={filters.project_id} onChange={e => setFilters(f => ({ ...f, project_id: e.target.value }))}
          className="rounded-lg border border-gray-200 px-2 py-2 text-sm focus:border-amber-400 focus:outline-none">
          <option value="">All projects</option>
          {options?.projects?.map(p => <option key={p.id} value={p.id}>{p.address}</option>)}
        </select>
        <select value={filters.category} onChange={e => setFilters(f => ({ ...f, category: e.target.value }))}
          className="rounded-lg border border-gray-200 px-2 py-2 text-sm focus:border-amber-400 focus:outline-none">
          <option value="">All categories</option>
          {options?.categories?.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        <select value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}
          className="rounded-lg border border-gray-200 px-2 py-2 text-sm focus:border-amber-400 focus:outline-none">
          <option value="">{tab === 'approved' ? 'Approved (default)' : tab === 'rejected' ? 'Rejected (default)' : 'Any status'}</option>
          {(options?.statuses || []).map(s => <option key={s} value={s}>{STATUS_STYLES[s]?.label || s}</option>)}
        </select>
        <input type="date" value={filters.start_date} onChange={e => setFilters(f => ({ ...f, start_date: e.target.value }))}
          className="rounded-lg border border-gray-200 px-2 py-2 text-sm focus:border-amber-400 focus:outline-none" title="From date" />
        <input type="date" value={filters.end_date} onChange={e => setFilters(f => ({ ...f, end_date: e.target.value }))}
          className="rounded-lg border border-gray-200 px-2 py-2 text-sm focus:border-amber-400 focus:outline-none" title="To date" />
        <input value={filters.contractor} onChange={e => setFilters(f => ({ ...f, contractor: e.target.value }))}
          placeholder="Contractor" className="w-36 rounded-lg border border-gray-200 px-2 py-2 text-sm focus:border-amber-400 focus:outline-none" />
        {(filters.project_id || filters.category || filters.status || filters.contractor || filters.start_date || filters.end_date || filters.search) && (
          <button onClick={() => setFilters(blankFilters())} className="text-sm font-medium text-gray-500 hover:text-gray-700">Clear</button>
        )}
        {tab !== 'compare' && tab !== 'audit' && canExportCsv && (
          <button onClick={exportCsv} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
            <Download className="h-4 w-4" /> Export CSV
          </button>
        )}
      </div>

      {tab === 'rejected' && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-xs font-medium text-red-800">
          <Ban className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>Rejected quotes are preserved here permanently for market &amp; pricing analysis (vendor, contractor, category, price). They can never be deleted.</span>
        </div>
      )}

      {/* Body */}
      {tab === 'compare' ? (
        <BidLeveling
          compare={compare}
          loading={compareLoading}
          hasProject={Boolean(filters.project_id)}
          candidates={compareCandidates}
          onPickProject={(id: string) => setFilters(f => ({ ...f, project_id: id }))}
          categoryLabel={filters.category}
          onApprove={handleApprove}
          busyId={busyId}
        />
      ) : tab === 'audit' ? (
        <AuditLog rows={activity} loading={activityLoading} />
      ) : tab === 'attachments' ? (
        <AttachmentsTable rows={attachmentRows} loading={listLoading} />
      ) : (
        <QuoteGrid
          rows={pageRows}
          loading={listLoading}
          tab={tab}
          expanded={expanded}
          setExpanded={setExpanded}
          onApprove={handleApprove}
          onDeny={handleDeny}
          onRestore={handleRestore}
          onDelete={handleDelete}
          onModify={handleModify}
          canDelete={canDelete}
          busyId={busyId}
          sortKey={sortKey}
          sortDir={sortDir}
          toggleSort={toggleSort}
          page={page}
          setPage={setPage}
          totalPages={totalPages}
          totalRows={filteredSorted.length}
        />
      )}

      {(showAdd || editQuote) && options && (
        <AddQuoteModal
          options={options}
          editQuote={editQuote}
          defaultProjectId={editQuote ? editQuote.project_id : filters.project_id}
          onClose={() => { setShowAdd(false); setEditQuote(null); }}
          onSaved={() => { setShowAdd(false); setEditQuote(null); reloadAll(); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Quote grid (All Quotes / Approved / Rejected)
// ─────────────────────────────────────────────────────────────────────────────
function QuoteGrid(props: {
  rows: ContractorQuote[];
  loading: boolean;
  tab: TabKey;
  expanded: Record<string, boolean>;
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onApprove: (q: ContractorQuote) => void;
  onDeny: (q: ContractorQuote) => void;
  onRestore: (q: ContractorQuote) => void;
  onDelete: (q: ContractorQuote) => void;
  onModify: (q: ContractorQuote) => void;
  canDelete: boolean;
  busyId: string | null;
  sortKey: 'date' | 'total';
  sortDir: 'asc' | 'desc';
  toggleSort: (key: 'date' | 'total') => void;
  page: number;
  setPage: React.Dispatch<React.SetStateAction<number>>;
  totalPages: number;
  totalRows: number;
}) {
  const { rows, loading, tab, expanded, setExpanded, onApprove, onDeny, onRestore, onDelete, onModify, canDelete, busyId, sortKey, sortDir, toggleSort, page, setPage, totalPages, totalRows } = props;
  if (loading) return <Loading message="Loading quotes…" />;
  if (totalRows === 0) {
    return <Empty message={tab === 'approved' ? 'No approved quotes yet.' : tab === 'rejected' ? 'No rejected quotes yet.' : 'No quotes found.'} icon={<ClipboardList className="h-8 w-8" />} />;
  }
  const arrow = (key: 'date' | 'total') => (sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '');
  const locked = tab === 'approved';
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="max-h-[62vh] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            <tr>
              <th className="w-8 px-2 py-2"></th>
              <th className="px-2 py-2">Project</th>
              <th className="px-2 py-2">Contractor</th>
              <th className="px-2 py-2">Category</th>
              <th className="px-2 py-2">Title</th>
              <th className="px-2 py-2 text-center">Items</th>
              <th className="cursor-pointer px-2 py-2 text-right" onClick={() => toggleSort('total')}>Total{arrow('total')}</th>
              {locked && <th className="px-2 py-2 text-right">Approved</th>}
              <th className="px-2 py-2">Status</th>
              <th className="cursor-pointer px-2 py-2" onClick={() => toggleSort('date')}>Received{arrow('date')}</th>
              <th className="px-2 py-2">Source</th>
              <th className="px-2 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(q => {
              const open = expanded[q.id];
              return (
                <Fragment key={q.id}>
                  <tr className="border-t border-gray-100 hover:bg-amber-50/40">
                    <td className="px-2 py-1.5 align-top">
                      <button onClick={() => setExpanded(s => ({ ...s, [q.id]: !s[q.id] }))} className="text-gray-400 hover:text-gray-700" aria-label="Toggle line items">
                        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </button>
                    </td>
                    <td className="max-w-[180px] truncate px-2 py-1.5 align-top text-gray-700" title={q.property_address || q.project_name}>{q.property_address || q.project_name || '—'}</td>
                    <td className="px-2 py-1.5 align-top">
                      <div className="max-w-[170px] truncate font-medium text-gray-900" title={q.contractor_company || q.contractor_name}>{q.contractor_company || q.contractor_name}</div>
                      {q.contractor_company && q.contractor_name && q.contractor_name !== q.contractor_company && (
                        <div className="max-w-[170px] truncate text-[11px] text-gray-400" title={q.contractor_name}>{q.contractor_name}</div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 align-top">
                      <span className="inline-block rounded bg-gray-50 px-1.5 py-0.5 text-[11px] font-medium text-gray-600">{primaryCategory(q)}</span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 align-top text-gray-700" title={quoteTitle(q)}>{clipText(quoteTitle(q), 50)}</td>
                    <td className="px-2 py-1.5 text-center align-top text-gray-500">{(q.line_items || []).length}</td>
                    <td className="px-2 py-1.5 text-right align-top font-semibold text-gray-900">{money(q.total_quote_amount)}</td>
                    {locked && <td className="px-2 py-1.5 text-right align-top font-semibold text-green-700">{q.final_approved_amount === null || q.final_approved_amount === undefined ? '—' : money(q.final_approved_amount)}</td>}
                    <td className="px-2 py-1.5 align-top"><StatusPill status={q.status} /></td>
                    <td className="px-2 py-1.5 align-top text-gray-500">{shortDate(q.quote_date)}</td>
                    <td className="px-2 py-1.5 align-top">
                      {q.document_download_url
                        ? <a href={`/api${q.document_download_url.replace(/^\/api/, '')}`} className="inline-flex items-center gap-1 text-blue-600 hover:underline" target="_blank" rel="noopener noreferrer"><FileText className="h-3.5 w-3.5" /> File</a>
                        : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right align-top">
                      <div className="flex justify-end gap-1">
                        {!locked && q.status !== 'rejected' && (
                          <>
                            <button disabled={busyId === q.id} onClick={() => onApprove(q)} title="Approve quote" className="rounded-md border border-green-200 bg-green-50 p-1 text-green-700 hover:bg-green-100 disabled:opacity-50"><Check className="h-3.5 w-3.5" /></button>
                            <button disabled={busyId === q.id} onClick={() => onDeny(q)} title="Deny (mark rejected)" className="rounded-md border border-amber-200 bg-amber-50 p-1 text-amber-700 hover:bg-amber-100 disabled:opacity-50"><X className="h-3.5 w-3.5" /></button>
                          </>
                        )}
                        {q.status === 'rejected' && (
                          <button disabled={busyId === q.id} onClick={() => onRestore(q)} title="Restore this quote to pending review" className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-1.5 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50"><RotateCcw className="h-3.5 w-3.5" /> Restore</button>
                        )}
                        {canDelete && q.status !== 'rejected' ? (
                          <button disabled={busyId === q.id} onClick={() => onDelete(q)} title="Delete quote permanently" className="rounded-md border border-red-200 bg-red-50 p-1 text-red-700 hover:bg-red-100 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" /></button>
                        ) : q.status === 'rejected' ? (
                          <span title="Rejected quotes are preserved for market analysis and cannot be deleted" className="text-[11px] font-medium text-gray-400">Kept</span>
                        ) : locked ? (
                          <span className="text-[11px] font-medium text-gray-400">Locked</span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  {open && (
                    <tr className="bg-gray-50/60">
                      <td></td>
                      <td colSpan={locked ? 11 : 10} className="px-3 py-2">
                        <div className="mb-2 flex items-start justify-between gap-3">
                          <p className="text-sm text-gray-700"><span className="font-semibold text-gray-900">Scope / title:</span> {quoteTitle(q)}</p>
                          <button
                            type="button"
                            onClick={() => onModify(q)}
                            title="Modify this quote's details and line items"
                            className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide"
                            style={{ borderColor: 'rgba(217,157,38,0.55)', background: 'rgba(217,157,38,0.16)', color: '#FBBF24' }}
                          >
                            Modify Quote
                          </button>
                        </div>
                        <LineItemsTable quote={q} />
                        <QuoteNotes quoteId={q.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {totalRows > PAGE_SIZE && (
        <div className="flex items-center justify-between border-t border-gray-100 px-3 py-2 text-sm text-gray-500">
          <span>Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalRows)} of {totalRows} ({PAGE_SIZE}/page)</span>
          <div className="flex items-center gap-2">
            <button disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))} className="rounded border border-gray-200 px-2 py-1 disabled:opacity-40">Prev</button>
            <span>Page {page} / {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))} className="rounded border border-gray-200 px-2 py-1 disabled:opacity-40">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

function LineItemsTable({ quote }: { quote: ContractorQuote }) {
  const items = quote.line_items || [];
  if (items.length === 0) return <p className="text-xs text-gray-400">No itemized line items. Total: {money(quote.total_quote_amount)}</p>;
  return (
    <table className="w-full text-xs">
      <thead className="text-left text-[10px] uppercase tracking-wide text-gray-400">
        <tr>
          <th className="py-1 pr-3">Category</th>
          <th className="py-1 pr-3">Description</th>
          <th className="py-1 pr-3 text-right">Qty</th>
          <th className="py-1 pr-3">Unit</th>
          <th className="py-1 pr-3 text-right">Unit Cost</th>
          <th className="py-1 pr-3 text-right">Line Total</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, idx) => {
          const unit = unitCostCell(item);
          return (
          <tr key={item.id || idx} className="border-t border-gray-100">
            <td className="py-1 pr-3 text-gray-600">{item.category || '—'}{item.subcategory ? ` · ${item.subcategory}` : ''}</td>
            <td className="py-1 pr-3 text-gray-700">{item.description || '—'}</td>
            <td className="py-1 pr-3 text-right text-gray-600">{num(item.quantity)}</td>
            <td className="py-1 pr-3 text-gray-500">{item.unit || '—'}</td>
            <td className="py-1 pr-3 text-right text-gray-600">{unit.text}{unit.lump && <span className="ml-1 rounded bg-gray-100 px-1 text-[9px] font-semibold uppercase tracking-wide text-gray-400">lump</span>}</td>
            <td className="py-1 pr-3 text-right font-medium text-gray-900">{money(item.total_line_item_price)}</td>
          </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Quote-only notes (per quote, not linked to anything else in the system)
// ─────────────────────────────────────────────────────────────────────────────
function QuoteNotes({ quoteId }: { quoteId: string }) {
  const [notes, setNotes] = useState<QuoteNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const role = useAuthStore(s => s.user?.role);
  const myId = useAuthStore(s => s.user?.id);
  const canDeleteAny = role === 'super_admin' || role === 'operations_manager';

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchQuoteNotes(quoteId)
      .then(rows => { if (active) setNotes(rows); })
      .catch(() => { if (active) setNotes([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [quoteId]);

  const add = async () => {
    const note = text.trim();
    if (!note) return;
    setSaving(true);
    try {
      const created = await addQuoteNote(quoteId, note);
      setNotes(current => [...current, created]);
      setText('');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to add note');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (noteId: string) => {
    try {
      await deleteQuoteNote(quoteId, noteId);
      setNotes(current => current.filter(n => n.id !== noteId));
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to delete note');
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        <ClipboardList className="h-3.5 w-3.5" /> Quote notes
        <span className="font-normal normal-case text-gray-400">— internal, for quoting only</span>
      </div>
      {loading ? (
        <p className="text-xs text-gray-400">Loading notes…</p>
      ) : notes.length > 0 ? (
        <ul className="mb-2 space-y-1.5">
          {notes.map(n => (
            <li key={n.id} className="flex items-start justify-between gap-2 rounded-md bg-white px-2 py-1.5">
              <div className="min-w-0">
                <p className="whitespace-pre-wrap break-words text-xs text-gray-700">{n.note}</p>
                <p className="mt-0.5 text-[10px] text-gray-400">{n.user_name || 'User'} · {formatEasternDateTime(n.created_at, { year: 'numeric' })} ET</p>
              </div>
              {(canDeleteAny || n.user_id === myId) && (
                <button type="button" onClick={() => remove(n.id)} title="Delete note" className="flex-shrink-0 text-gray-300 hover:text-red-500">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-2 text-xs text-gray-400">No notes yet.</p>
      )}
      <div className="flex items-center gap-2">
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }}
          placeholder="Add a quoting note…"
          className="flex-1 rounded-md border border-gray-200 px-2 py-1.5 text-xs focus:border-amber-400 focus:outline-none"
        />
        <button
          type="button"
          onClick={add}
          disabled={saving || !text.trim()}
          className="rounded-md px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          style={{ background: 'linear-gradient(135deg,#D99D26,#C4891F)' }}
        >
          {saving ? 'Adding…' : 'Add note'}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bid leveling
// ─────────────────────────────────────────────────────────────────────────────
function BidLeveling(props: {
  compare: CompareResponse | null;
  loading: boolean;
  hasProject: boolean;
  candidates: Array<{ id: string; label: string }>;
  onPickProject: (id: string) => void;
  categoryLabel: string;
  onApprove: (q: ContractorQuote) => void;
  busyId: string | null;
}) {
  const { compare, loading, hasProject, candidates, onPickProject, categoryLabel, onApprove, busyId } = props;
  const [viewing, setViewing] = useState<{ quoteId: string; title: string } | null>(null);
  const [expandedQuote, setExpandedQuote] = useState<string | null>(null);

  if (!hasProject) {
    return (
      <div className="flex flex-col items-center justify-center px-4 py-14 text-center">
        <Scale className="mb-3 h-8 w-8 text-gray-400" />
        <p className="text-sm text-gray-400">
          {candidates.length > 0 ? 'Pick a project to compare contractor bids side by side:' : 'Add quotes to a project, then compare bids here.'}
        </p>
        {candidates.length > 0 && (
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {candidates.map(c => (
              <button
                key={c.id}
                type="button"
                onClick={() => onPickProject(c.id)}
                className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (loading) return <Loading message="Leveling bids…" />;
  if (!compare || compare.contractors.length === 0) return <Empty message="No quotes to compare for this project yet." icon={<Scale className="h-8 w-8" />} />;

  const { contractors, rows, project } = compare;
  type CompareContractorRow = CompareResponse['contractors'][number];
  type CompareCategoryRow = CompareResponse['rows'][number];

  const expandedContractor = expandedQuote ? contractors.find(c => c.quote_id === expandedQuote) || null : null;
  const expandedLineItems = expandedQuote ? rows.flatMap(r => r.cells[expandedQuote]?.line_items || []) : [];
  const isCategoryFocused = Boolean(categoryLabel);
  const matrixMinWidth = Math.max(980, 590 + rows.length * 170);

  const contractorLabel = (contractor: CompareContractorRow) =>
    contractor.contractor_company || contractor.contractor_name || 'Unnamed provider';

  const categoryCell = (row: CompareCategoryRow, contractor: CompareContractorRow) => row.cells[contractor.quote_id];

  const amountForRow = (row: CompareCategoryRow, contractor: CompareContractorRow) => {
    const cell = categoryCell(row, contractor);
    return cell?.present ? num(cell.amount) : 0;
  };

  const quoteCategoryTotal = (contractor: CompareContractorRow) =>
    rows.reduce((sum, row) => sum + amountForRow(row, contractor), 0);

  const quoteTotal = (contractor: CompareContractorRow) =>
    num((compare.totals.by_quote[contractor.quote_id] ?? quoteCategoryTotal(contractor)) || contractor.total_quote_amount);

  const quotedCategoryCount = (contractor: CompareContractorRow) =>
    rows.reduce((count, row) => count + (categoryCell(row, contractor)?.present ? 1 : 0), 0);

  const rankMetaForCategory = (row: CompareCategoryRow, amount: number, present: boolean) => {
    const isComparable = present && row.present_count > 1;
    return {
      isLow: isComparable && amount === row.low,
      isHigh: isComparable && row.high !== row.low && amount === row.high,
    };
  };

  const focusedAmounts = contractors.map(contractor => {
    const present = rows.some(row => Boolean(categoryCell(row, contractor)?.present));
    return { contractor, present, amount: quoteCategoryTotal(contractor) };
  });
  const focusedPresentAmounts = focusedAmounts.filter(item => item.present).map(item => item.amount);
  const focusedLow = focusedPresentAmounts.length ? Math.min(...focusedPresentAmounts) : 0;
  const focusedHigh = focusedPresentAmounts.length ? Math.max(...focusedPresentAmounts) : 0;
  const focusedAverage = focusedPresentAmounts.length
    ? focusedPresentAmounts.reduce((sum, value) => sum + value, 0) / focusedPresentAmounts.length
    : 0;
  const focusedSpread = focusedHigh && focusedLow ? focusedHigh - focusedLow : 0;
  const focusedContractors = [...contractors].sort((a, b) => {
    const aPresent = rows.some(row => Boolean(categoryCell(row, a)?.present));
    const bPresent = rows.some(row => Boolean(categoryCell(row, b)?.present));
    if (aPresent !== bPresent) return aPresent ? -1 : 1;
    const diff = quoteCategoryTotal(a) - quoteCategoryTotal(b);
    return diff || contractorLabel(a).localeCompare(contractorLabel(b));
  });

  const amountBadge = (label: 'Low' | 'High') => (
    <span
      className={`rounded px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide ${
        label === 'Low' ? 'bg-emerald-500/20 text-emerald-200' : 'bg-amber-500/20 text-amber-200'
      }`}
    >
      {label}
    </span>
  );

  const amountCell = (row: CompareCategoryRow, contractor: CompareContractorRow) => {
    const cell = categoryCell(row, contractor);
    if (!cell?.present) {
      return <span className="text-xs font-semibold text-gray-400">No bid</span>;
    }
    const amount = num(cell.amount);
    const { isLow, isHigh } = rankMetaForCategory(row, amount, true);
    return (
      <span className="inline-flex items-center justify-end gap-1.5 tabular-nums text-gray-900">
        {isLow ? amountBadge('Low') : null}
        {isHigh ? amountBadge('High') : null}
        <span className="font-bold">{money(amount)}</span>
      </span>
    );
  };

  const renderQuoteActions = (contractor: CompareContractorRow) => (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <button
        type="button"
        onClick={() => setExpandedQuote(prev => (prev === contractor.quote_id ? null : contractor.quote_id))}
        className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] font-semibold text-gray-700 hover:bg-gray-50"
        title="Show quote line items"
      >
        {expandedQuote === contractor.quote_id ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Details
      </button>
      {contractor.has_document && (
        <button
          type="button"
          onClick={() => setViewing({ quoteId: contractor.quote_id, title: `${contractorLabel(contractor)} · ${contractor.quote_number}` })}
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] font-semibold text-gray-700 hover:bg-gray-50"
          title="View the original quote document"
        >
          <FileText className="h-3 w-3" /> View quote
        </button>
      )}
      {APPROVED_STATUSES.has(contractor.status)
        ? <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-green-700"><CheckCircle2 className="h-3.5 w-3.5" /> Approved</span>
        : <button disabled={busyId === contractor.quote_id} onClick={() => onApprove({ id: contractor.quote_id, quote_number: contractor.quote_number } as ContractorQuote)} className="rounded-md border border-green-200 bg-green-50 px-2 py-1 text-[11px] font-semibold text-green-700 hover:bg-green-100 disabled:opacity-50">Approve</button>}
    </div>
  );

  const expandedDetails = expandedQuote && expandedContractor ? (
    <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-3 shadow-sm">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-gray-900">
          {contractorLabel(expandedContractor)}
        </p>
        <span className="rounded-full border border-gray-200 px-2 py-0.5 text-[11px] font-semibold text-gray-500">
          {expandedContractor.quote_number}
        </span>
        <span className="ml-auto text-sm font-bold text-gray-900">
          {money(quoteTotal(expandedContractor))}
        </span>
      </div>
      <LineItemsTable quote={{ line_items: expandedLineItems } as ContractorQuote} />
    </div>
  ) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-gray-700">Bid comparison — {project.address}</span>
        <span className="ml-auto rounded-full border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-500">
          {categoryLabel ? `${categoryLabel} only` : 'All categories'} <span className="text-gray-400">· change in the filter bar</span>
        </span>
      </div>

      {isCategoryFocused ? (
        <>
          <div className="grid gap-2 sm:grid-cols-4">
            <SummaryCard label="Low bid" value={money(focusedLow)} accent="#6EE7A0" />
            <SummaryCard label="High bid" value={money(focusedHigh)} accent="#FDBA74" />
            <SummaryCard label="Average" value={money(focusedAverage)} />
            <SummaryCard label="Spread" value={money(focusedSpread)} hint={`${focusedPresentAmounts.length} quote${focusedPresentAmounts.length === 1 ? '' : 's'}`} />
          </div>
          <div className="overflow-auto rounded-xl border border-gray-200 bg-white shadow-sm">
            <table className="w-full min-w-[880px] border-collapse text-sm">
              <thead className="bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2">Service provider</th>
                  <th className="px-3 py-2 text-right">{categoryLabel}</th>
                  <th className="px-3 py-2 text-right">Difference from low</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Decision</th>
                </tr>
              </thead>
              <tbody>
                {focusedContractors.map(contractor => {
                  const present = rows.some(row => Boolean(categoryCell(row, contractor)?.present));
                  const amount = quoteCategoryTotal(contractor);
                  const isLow = present && focusedPresentAmounts.length > 1 && amount === focusedLow;
                  const isHigh = present && focusedPresentAmounts.length > 1 && focusedHigh !== focusedLow && amount === focusedHigh;
                  const difference = present ? amount - focusedLow : 0;
                  return (
                    <tr key={contractor.quote_id} className="border-t border-gray-100">
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => setExpandedQuote(prev => (prev === contractor.quote_id ? null : contractor.quote_id))}
                          className="flex min-w-0 flex-col text-left hover:opacity-85"
                        >
                          <span className="flex items-center gap-1 font-semibold text-gray-900">
                            {expandedQuote === contractor.quote_id ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                            {contractorLabel(contractor)}
                          </span>
                          <span className="text-xs text-gray-400">{contractor.quote_number}</span>
                        </button>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {present ? (
                          <span className="inline-flex items-center justify-end gap-1.5 tabular-nums text-gray-900">
                            {isLow ? amountBadge('Low') : null}
                            {isHigh ? amountBadge('High') : null}
                            <span className="font-bold">{money(amount)}</span>
                          </span>
                        ) : (
                          <span className="text-xs font-semibold text-gray-400">No bid</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {present ? (
                          <span className={`text-xs font-semibold tabular-nums ${difference === 0 ? 'text-green-700' : 'text-gray-500'}`}>
                            {difference === 0 ? 'Lowest' : `+${money(difference)}`}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2"><StatusPill status={contractor.status} /></td>
                      <td className="px-3 py-2 text-right">{renderQuoteActions(contractor)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="overflow-auto rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="w-full border-collapse text-sm" style={{ minWidth: `${matrixMinWidth}px` }}>
            <thead className="bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="sticky left-0 z-10 bg-gray-50 px-3 py-2">Service provider</th>
                {rows.map(row => (
                  <th key={row.category} className="border-l border-white/10 px-3 py-2 text-right">
                    <span className="block text-gray-700">{row.category}</span>
                    <span className="block text-[10px] font-medium normal-case text-gray-400">
                      {row.present_count}/{contractors.length} quoted
                    </span>
                  </th>
                ))}
                <th className="border-l-2 border-white/20 px-3 py-2 text-right">Total bid</th>
                <th className="px-3 py-2 text-center">Coverage</th>
                <th className="px-3 py-2 text-right">Decision</th>
              </tr>
            </thead>
            <tbody>
              {contractors.map(contractor => {
                const presentCount = quotedCategoryCount(contractor);
                const missingCount = Math.max(rows.length - presentCount, 0);
                return (
                  <tr key={contractor.quote_id} className="border-t border-gray-100">
                    <td className="sticky left-0 z-10 bg-white px-3 py-2">
                      <button
                        type="button"
                        onClick={() => setExpandedQuote(prev => (prev === contractor.quote_id ? null : contractor.quote_id))}
                        className="flex min-w-0 flex-col text-left hover:opacity-85"
                      >
                        <span className="flex items-center gap-1 font-semibold text-gray-900">
                          {expandedQuote === contractor.quote_id ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          {contractorLabel(contractor)}
                        </span>
                        <span className="text-xs text-gray-400">{contractor.quote_number}</span>
                      </button>
                    </td>
                    {rows.map(row => (
                      <td key={`${contractor.quote_id}-${row.category}`} className="border-l border-white/10 px-3 py-2 text-right">
                        {amountCell(row, contractor)}
                      </td>
                    ))}
                    <td className="border-l-2 border-white/20 px-3 py-2 text-right">
                      <span className="block font-bold tabular-nums text-gray-900">{money(quoteTotal(contractor))}</span>
                      {missingCount > 0 ? (
                        <span className="text-[11px] font-semibold text-amber-700">
                          missing {missingCount}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${
                        missingCount ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-green-200 bg-green-50 text-green-700'
                      }`}>
                        {presentCount}/{rows.length}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">{renderQuoteActions(contractor)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {expandedDetails}

      {viewing && (
        <QuotePdfModal quoteId={viewing.quoteId} title={viewing.title} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}

// In-app document reader: streams the quote's source file (with auth) and shows it inline.
function QuotePdfModal({ quoteId, title, onClose }: { quoteId: string; title: string; onClose: () => void }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let created = '';
    setLoading(true);
    setError('');
    api.get(`/quote-analytics/quotes/${quoteId}/download`, { responseType: 'blob' })
      .then(res => { if (!active) return; created = URL.createObjectURL(res.data as Blob); setBlobUrl(created); })
      .catch(() => { if (active) setError('Could not load this document.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; if (created) URL.revokeObjectURL(created); };
  }, [quoteId]);
  return (
    <Modal isOpen onClose={onClose} title={title} size="xl" description="Original quote document">
      <div className="h-[72vh] w-full">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-gray-400">Loading quote…</div>
        ) : error ? (
          <div className="flex h-full items-center justify-center text-sm text-gray-400">{error}</div>
        ) : blobUrl ? (
          <iframe title="Quote document" src={blobUrl} className="h-full w-full rounded-lg border-0 bg-white" />
        ) : null}
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Attachments + Audit
// ─────────────────────────────────────────────────────────────────────────────
function AttachmentsTable({ rows, loading }: { rows: ContractorQuote[]; loading: boolean }) {
  if (loading) return <Loading message="Loading attachments…" />;
  if (rows.length === 0) return <Empty message="No source files attached to quotes in this view." icon={<Paperclip className="h-8 w-8" />} />;
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          <tr><th className="px-3 py-2">Project</th><th className="px-3 py-2">Contractor</th><th className="px-3 py-2">Quote #</th><th className="px-3 py-2">File</th><th className="px-3 py-2">Received</th><th className="px-3 py-2 text-right">Download</th></tr>
        </thead>
        <tbody>
          {rows.map(q => (
            <tr key={q.id} className="border-t border-gray-100 hover:bg-gray-50">
              <td className="px-3 py-1.5 text-gray-700">{q.property_address || q.project_name || '—'}</td>
              <td className="px-3 py-1.5 text-gray-900">{q.contractor_company || q.contractor_name}</td>
              <td className="px-3 py-1.5 text-gray-500">{q.quote_number}</td>
              <td className="px-3 py-1.5 text-gray-600">{q.document_original_name || q.source_file_name || 'Source file'}</td>
              <td className="px-3 py-1.5 text-gray-500">{shortDate(q.quote_date)}</td>
              <td className="px-3 py-1.5 text-right">
                <a href={`/api${(q.document_download_url || '').replace(/^\/api/, '')}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline"><Download className="h-3.5 w-3.5" /> Open</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuditLog({ rows, loading }: { rows: ActivityRow[]; loading: boolean }) {
  if (loading) return <Loading message="Loading audit log…" />;
  if (rows.length === 0) return <Empty message="No quote activity recorded yet." icon={<History className="h-8 w-8" />} />;
  const label = (action: string) => ({ quote_created: 'created a quote', quote_approved: 'approved a quote', quote_rejected: 'denied a quote' } as Record<string, string>)[action] || action.replace(/_/g, ' ');
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          <tr><th className="px-3 py-2">When</th><th className="px-3 py-2">User</th><th className="px-3 py-2">Action</th><th className="px-3 py-2">Project</th></tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} className="border-t border-gray-100">
              <td className="px-3 py-1.5 text-gray-500">{shortDate(r.created_at)}</td>
              <td className="px-3 py-1.5 font-medium text-gray-800">{r.user_name}</td>
              <td className="px-3 py-1.5 text-gray-600">{label(r.action)}</td>
              <td className="px-3 py-1.5 text-gray-500">{r.project_address || r.project_job_name || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-gray-100 px-3 py-2 text-[11px] text-gray-400">Showing the most recent quote activity. Each quote also keeps an append-only history snapshot in the database.</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Add Quote modal (reuses existing create / upload / extract endpoints)
// ─────────────────────────────────────────────────────────────────────────────
function AddQuoteModal({ options, defaultProjectId, editQuote, onClose, onSaved }: {
  options: QuoteOptions;
  defaultProjectId: string;
  editQuote?: ContractorQuote | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!editQuote;
  const [form, setForm] = useState<QuoteForm>(() => editQuote ? {
    project_id: editQuote.project_id,
    contractor_name: editQuote.contractor_name || '',
    contractor_company: editQuote.contractor_company || '',
    contractor_email: editQuote.contractor_email || '',
    contractor_phone: editQuote.contractor_phone || '',
    quote_date: String(editQuote.quote_date || todayIso()).slice(0, 10),
    status: editQuote.status || 'submitted',
    scope_description: editQuote.scope_description || '',
    notes: editQuote.notes || '',
  } : { ...blankQuoteForm(), project_id: defaultProjectId });
  const [lines, setLines] = useState<QuoteLineForm[]>(() => {
    const items = editQuote?.line_items;
    if (items && items.length) {
      return items.map(li => ({
        category: li.category || (options.categories[0]?.name || ''),
        description: li.description || '',
        quantity: li.quantity != null ? String(li.quantity) : '1',
        unit: li.unit || '',
        unit_price: li.unit_price != null ? String(li.unit_price) : '',
        total_line_item_price: li.total_line_item_price != null ? String(li.total_line_item_price) : '',
      }));
    }
    return [blankLine(options.categories[0]?.name || '')];
  });
  // A single category for the WHOLE quote (applied to every line item). When editing,
  // default to the quote's most common existing category.
  const initialQuoteCategory = (() => {
    const items = editQuote?.line_items;
    if (items && items.length) {
      const counts = new Map<string, number>();
      for (const li of items) { if (li.category) counts.set(li.category, (counts.get(li.category) || 0) + 1); }
      let best = '', bestN = 0;
      for (const [c, n] of counts) { if (n > bestN) { best = c; bestN = n; } }
      if (best) return best;
    }
    return options.categories[0]?.name || '';
  })();
  const [quoteCategory, setQuoteCategory] = useState<string>(initialQuoteCategory);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Revoke the object URL when the preview changes or the modal unmounts.
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const categoryNames = options.categories.map(c => c.name);
  const lineTotal = (line: QuoteLineForm) => {
    const explicit = Number(line.total_line_item_price);
    if (line.total_line_item_price !== '' && Number.isFinite(explicit)) return explicit;
    return num(line.quantity) * num(line.unit_price);
  };
  const grandTotal = lines.reduce((sum, line) => sum + lineTotal(line), 0);

  const setLine = (idx: number, patch: Partial<QuoteLineForm>) =>
    setLines(current => current.map((line, i) => (i === idx ? { ...line, ...patch } : line)));

  // Reads the attached PDF/image with AI and pre-fills the form. Runs automatically
  // on upload (see chooseFile) and can be re-run manually.
  const runExtract = async (targetFile: File | null = file) => {
    if (!targetFile || !isAiReadable(targetFile)) return;
    setExtracting(true);
    try {
      const fd = new FormData();
      fd.append('quote_file', targetFile);
      const res = await extractQuote(fd);
      const q = res?.quote;
      if (q) {
        setForm(f => ({
          ...f,
          contractor_name: q.contractor_name || f.contractor_name,
          contractor_company: q.contractor_company || f.contractor_company,
          contractor_email: q.contractor_email || f.contractor_email,
          contractor_phone: q.contractor_phone || f.contractor_phone,
          scope_description: q.scope_description || f.scope_description,
          quote_date: q.quote_date || f.quote_date,
        }));
        if (Array.isArray(q.line_items) && q.line_items.length) {
          // One general category for the whole quote = the most common category the AI found.
          const counts = new Map<string, number>();
          for (const li of q.line_items) {
            const c = categoryNames.includes(li.category) ? li.category : '';
            if (c) counts.set(c, (counts.get(c) || 0) + 1);
          }
          let best = '', bestN = 0;
          for (const [c, n] of counts) { if (n > bestN) { best = c; bestN = n; } }
          if (best) setQuoteCategory(best);
          setLines(q.line_items.map((li: any) => ({
            category: '',
            description: li.description || '',
            quantity: '1',
            unit: '',
            unit_price: '',
            total_line_item_price: li.total_line_item_price != null ? String(li.total_line_item_price) : '',
          })));
        }
        toast.success('Document read — please review the auto-filled details before saving.');
      }
    } catch (err: any) {
      toast.error(err?.response?.data?.error || "We couldn't read that document automatically — please enter the details manually.");
    } finally {
      setExtracting(false);
    }
  };

  // Validate, preview, and (for PDFs/photos) kick off AI auto-read immediately.
  const chooseFile = (f: File | null) => {
    if (!f) return;
    const problem = validateUpload(f);
    if (problem) { toast.error(problem); return; }
    setPreviewUrl(isImageFile(f) ? URL.createObjectURL(f) : null);
    setFile(f);
    if (isAiReadable(f)) void runExtract(f);
  };

  const clearFile = () => {
    setPreviewUrl(null);
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const submit = async () => {
    if (!form.project_id) { toast.error('Project is required'); return; }
    if (!form.contractor_name.trim() && !form.contractor_company.trim()) { toast.error('Contractor name or company is required'); return; }
    if (!quoteCategory) { toast.error('Select a category for the quote'); return; }
    const cleanLines = lines.filter(l => l.description.trim() || lineTotal(l) > 0);
    if (cleanLines.length === 0) { toast.error('Add at least one line item'); return; }
    const payloadLines = cleanLines.map((l, idx) => ({
      category: quoteCategory,
      subcategory: '',
      description: l.description.trim() || quoteCategory,
      quantity: num(l.quantity) || 1,
      unit: l.unit.trim(),
      unit_price: num(l.unit_price),
      total_line_item_price: lineTotal(l),
      sort_order: idx,
    }));
    setSaving(true);
    try {
      if (isEdit && editQuote) {
        await updateQuote(editQuote.id, {
          contractor_name: form.contractor_name,
          contractor_company: form.contractor_company,
          contractor_email: form.contractor_email,
          contractor_phone: form.contractor_phone,
          quote_date: form.quote_date,
          status: form.status,
          scope_description: form.scope_description,
          notes: form.notes,
          total_quote_amount: grandTotal,
          line_items: payloadLines,
        });
      } else if (file) {
        const fd = new FormData();
        fd.append('project_id', form.project_id);
        fd.append('contractor_name', form.contractor_name);
        fd.append('contractor_company', form.contractor_company);
        fd.append('contractor_email', form.contractor_email);
        fd.append('contractor_phone', form.contractor_phone);
        fd.append('quote_date', form.quote_date);
        fd.append('status', form.status);
        fd.append('scope_description', form.scope_description);
        fd.append('notes', form.notes);
        fd.append('total_quote_amount', String(grandTotal));
        fd.append('line_items', JSON.stringify(payloadLines));
        fd.append('quote_file', file);
        await uploadQuote(fd);
      } else {
        await createQuote({
          project_id: form.project_id,
          contractor_name: form.contractor_name,
          contractor_company: form.contractor_company,
          contractor_email: form.contractor_email,
          contractor_phone: form.contractor_phone,
          quote_date: form.quote_date,
          status: form.status,
          scope_description: form.scope_description,
          notes: form.notes,
          total_quote_amount: grandTotal,
          line_items: payloadLines,
        });
      }
      toast.success(isEdit ? 'Quote updated' : 'Quote saved');
      onSaved();
    } catch (err: any) {
      const errs = err?.response?.data?.errors;
      toast.error(Array.isArray(errs) ? errs[0] : (err?.response?.data?.error || 'Failed to save quote'));
    } finally { setSaving(false); }
  };

  const field = 'w-full rounded-lg border border-gray-200 px-2.5 py-2 text-sm focus:border-amber-400 focus:outline-none';

  return (
    <Modal isOpen onClose={onClose} title={isEdit ? 'Modify Quote' : 'Add Contractor Quote'} size="xl" description={isEdit ? "Update this quote's details and line items." : 'Enter a quote line by line, or attach a PDF/image and auto-read it.'}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block font-medium text-gray-600">Project / property *</span>
            <select className={field} value={form.project_id} disabled={isEdit} onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))}>
              <option value="">Select a project…</option>
              {options.projects.map(p => <option key={p.id} value={p.id}>{p.address}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium text-gray-600">Quote date</span>
            <input type="date" className={field} value={form.quote_date} onChange={e => setForm(f => ({ ...f, quote_date: e.target.value }))} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium text-gray-600">Contractor company</span>
            <input className={field} value={form.contractor_company} onChange={e => setForm(f => ({ ...f, contractor_company: e.target.value }))} placeholder="ABC Electric" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium text-gray-600">Contact name</span>
            <input className={field} value={form.contractor_name} onChange={e => setForm(f => ({ ...f, contractor_name: e.target.value }))} placeholder="Jane Doe" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium text-gray-600">Email</span>
            <input className={field} value={form.contractor_email} onChange={e => setForm(f => ({ ...f, contractor_email: e.target.value }))} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium text-gray-600">Phone</span>
            <input className={field} value={form.contractor_phone} onChange={e => setForm(f => ({ ...f, contractor_phone: e.target.value }))} />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block font-medium text-gray-600">Quote title / scope summary</span>
            <input className={field} value={form.scope_description} onChange={e => setForm(f => ({ ...f, scope_description: e.target.value }))} placeholder="Full electrical rough-in & panel upgrade" />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block font-medium text-gray-600">Category <span className="font-normal text-gray-400">— applies to the entire quote</span> *</span>
            <select className={field} value={quoteCategory} onChange={e => setQuoteCategory(e.target.value)}>
              <option value="">Select a category…</option>
              {options.categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </label>
        </div>

        {/* Source document upload + automatic AI auto-read (creation only) */}
        {!isEdit && (
        <div>
          <span className="mb-1 block text-sm font-medium text-gray-600">
            Source document <span className="font-normal text-gray-400">(optional — attach the contractor's quote)</span>
          </span>

          {!file ? (
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
              onDragEnter={e => { e.preventDefault(); setDragging(true); }}
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={e => { e.preventDefault(); setDragging(false); }}
              onDrop={e => { e.preventDefault(); setDragging(false); chooseFile(e.dataTransfer.files?.[0] || null); }}
              className="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors focus:outline-none"
              style={{ borderColor: dragging ? '#D99D26' : 'rgba(148,163,184,0.4)', background: dragging ? 'rgba(217,157,38,0.14)' : 'rgba(255,255,255,0.03)' }}
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-full" style={{ background: 'rgba(217,157,38,0.12)' }}>
                <Paperclip className="h-5 w-5" style={{ color: '#C4891F' }} />
              </div>
              <p className="text-sm font-medium text-gray-700"><span style={{ color: '#C4891F' }}>Click to upload</span> or drag &amp; drop</p>
              <p className="text-xs text-gray-400">PDF, JPG, PNG, CSV, or Excel · up to {MAX_UPLOAD_MB} MB</p>
              <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium" style={{ color: '#93C5FD' }}>
                <Wand2 className="h-3 w-3" /> PDFs &amp; photos are read automatically by AI
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-3 py-2.5 shadow-sm">
              {previewUrl ? (
                <img src={previewUrl} alt={file.name} className="h-11 w-11 flex-shrink-0 rounded-lg object-cover" />
              ) : (
                <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg" style={{ background: isPdfFile(file) ? 'rgba(239,68,68,0.20)' : 'rgba(129,140,248,0.22)' }}>
                  <FileText className="h-5 w-5" style={{ color: isPdfFile(file) ? '#FCA5A5' : '#BFC6FF' }} />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-800">{file.name}</p>
                <p className="text-xs text-gray-400">{formatBytes(file.size)}</p>
              </div>
              {!extracting && isAiReadable(file) && (
                <button
                  type="button"
                  onClick={() => runExtract(file)}
                  title="Re-read this document with AI"
                  className="inline-flex flex-shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-semibold"
                  style={{ borderColor: 'rgba(59,130,246,0.4)', background: 'rgba(59,130,246,0.16)', color: '#93C5FD' }}
                >
                  <Wand2 className="h-3 w-3" /> Re-read
                </button>
              )}
              <button
                type="button"
                onClick={clearFile}
                disabled={extracting}
                title="Remove file"
                className="flex-shrink-0 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          <input ref={fileInputRef} type="file" accept={ACCEPTED_UPLOAD} className="hidden" onChange={e => chooseFile(e.target.files?.[0] || null)} />

          {extracting && (
            <div className="mt-2 flex items-start gap-2.5 rounded-xl border px-3 py-2.5" style={{ borderColor: 'rgba(59,130,246,0.4)', background: 'rgba(59,130,246,0.12)' }}>
              <span className="mt-0.5 inline-block h-4 w-4 flex-shrink-0 animate-spin rounded-full border-2 border-blue-300 border-t-transparent" />
              <div>
                <p className="text-sm font-semibold" style={{ color: '#93C5FD' }}>Analyzing your document with AI…</p>
                <p className="text-xs" style={{ color: 'rgba(191,219,254,0.85)' }}>
                  Please keep this window open. The contractor details and line items below will be filled in automatically once the analysis is complete.
                </p>
              </div>
            </div>
          )}

          {file && !extracting && !isAiReadable(file) && (
            <p className="mt-1.5 text-xs text-gray-400">This file type can't be auto-read — please enter the quote details manually below.</p>
          )}
        </div>
        )}

        {/* Line items */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-700">Line items</span>
            <button type="button" onClick={() => setLines(c => [...c, blankLine(options.categories[0]?.name || '')])} className="inline-flex items-center gap-1 text-sm font-medium text-amber-700 hover:text-amber-800"><Plus className="h-3.5 w-3.5" /> Add row</button>
          </div>
          <div className="overflow-auto rounded-lg border border-gray-200">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-left text-[10px] uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-2 py-1.5">Description</th>
                  <th className="px-2 py-1.5 text-right">Qty</th>
                  <th className="px-2 py-1.5">Unit</th>
                  <th className="px-2 py-1.5 text-right">Unit Cost</th>
                  <th className="px-2 py-1.5 text-right">Total</th>
                  <th className="px-2 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => (
                  <tr key={idx} className="border-t border-gray-100">
                    <td className="px-2 py-1"><input value={line.description} onChange={e => setLine(idx, { description: e.target.value })} className="w-full min-w-[200px] rounded border border-gray-200 px-1.5 py-1" placeholder="Line item description" /></td>
                    <td className="px-2 py-1"><input type="number" value={line.quantity} onChange={e => setLine(idx, { quantity: e.target.value })} className="w-16 rounded border border-gray-200 px-1.5 py-1 text-right" /></td>
                    <td className="px-2 py-1"><input value={line.unit} onChange={e => setLine(idx, { unit: e.target.value })} className="w-16 rounded border border-gray-200 px-1.5 py-1" placeholder="ea" /></td>
                    <td className="px-2 py-1"><input type="number" value={line.unit_price} onChange={e => setLine(idx, { unit_price: e.target.value })} className="w-24 rounded border border-gray-200 px-1.5 py-1 text-right" /></td>
                    <td className="px-2 py-1"><input type="number" value={line.total_line_item_price} onChange={e => setLine(idx, { total_line_item_price: e.target.value })} placeholder={lineTotal(line).toFixed(2)} className="w-24 rounded border border-gray-200 px-1.5 py-1 text-right" /></td>
                    <td className="px-2 py-1 text-right">
                      <button type="button" onClick={() => setLines(c => (c.length > 1 ? c.filter((_, i) => i !== idx) : c))} className="text-gray-300 hover:text-red-500" title="Remove row"><Trash2 className="h-3.5 w-3.5" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-gray-200 bg-gray-50 font-semibold">
                  <td className="px-2 py-1.5 text-gray-600" colSpan={4}>Total</td>
                  <td className="px-2 py-1.5 text-right text-gray-900">{money(grandTotal)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-600">Internal notes</span>
          <textarea className={field} rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
        </label>

        <div className="flex items-center justify-end gap-2 border-t border-gray-100 pt-3">
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</button>
          <button type="button" disabled={saving} onClick={submit} className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" style={{ background: 'linear-gradient(135deg,#D99D26,#C4891F)' }}>
            {saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Save quote')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
