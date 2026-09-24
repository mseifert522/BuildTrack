import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, ChevronDown, ChevronRight, Download, RefreshCw, Search, Users } from 'lucide-react';
import toast from 'react-hot-toast';

import { Loading } from '../ui';
import {
  CATEGORY_KIND_LABELS,
  autoCategorize,
  buildFilterQuery,
  confirmVendorCategory,
  dash,
  downloadCsv,
  formatDate,
  formatDateTime,
  getCategories,
  getVendorDetail,
  getVendors,
  money,
  num,
  rate,
  setVendorCategory,
} from '../../lib/costAnalyzerApi';
import type { CategoryRef, CategoryRow, CostAnalyzerFilters, RateLabels, VendorRow } from '../../lib/costAnalyzerApi';
import {
  Chip,
  EmptyState,
  InlineSpinner,
  RateCaption,
  ReasonChip,
  SourceChip,
  apiError,
  cardClass,
  fieldClass,
  inlineSelectClass,
  labelClass,
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
import VendorDrawer from './VendorDrawer';

// Vendors tab (spec §7): every vendor with bills in the selected range (or every
// known vendor with "Include vendors without bills"), its cost category with
// provenance, the owner's implied $/hr benchmark and the review workflow
// (needs review -> pick / confirm a category). Editors change categories inline;
// each change is saved at once and the row is refetched so totals, "bills
// elsewhere" and the Vendors-page list chip stay truthful. The drawer opens
// through the `vendor` URL param so the Overview / Categories tabs can deep-link
// to a vendor and the open drawer survives a reload.

export type VendorsTabProps = {
  filters: CostAnalyzerFilters;
  canEdit: boolean;
  /** Accepted for parity with the other tabs; this tab opens its own drawer through `?vendor=`. */
  onOpenVendor?: (vendorId: string) => void;
};

type ReviewFilter = 'needs_review' | 'manual' | 'all';
type SortKey = 'vendor' | 'bills' | 'total' | 'last' | 'hourly' | 'elsewhere';
type SortState = { key: SortKey; dir: 'asc' | 'desc' };
type CategoryOption = CategoryRef & { is_active: boolean };
type VendorGroup = { key: string; name: string; vendors: VendorRow[]; total: number };

const UNCATEGORIZED_ID = 'uncategorized';
const DEFAULT_SORT: SortState = { key: 'total', dir: 'desc' };
const REVIEW_OPTIONS: Array<{ id: ReviewFilter; label: string }> = [
  { id: 'needs_review', label: 'Needs review' },
  { id: 'manual', label: 'Manual' },
  { id: 'all', label: 'All' },
];
// Same strings as the backend RATE_LABELS (spec §4.2); used until the first response arrives.
const FALLBACK_LABELS: RateLabels = {
  full_year: 'Implied $/hr (÷2,080)',
  annualized: 'Annualized $/hr (partial year)',
  active_weeks: 'Implied $/hr (active weeks)',
  window: 'Implied $/hr (this window)',
  doc: 'Invoice $/hr',
  hours_share: 'share of 40-hr weeks (implied, not measured)',
};

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${num(count)} ${count === 1 ? singular : pluralForm}`;
}

function dateRange(first: string | null, last: string | null): string {
  if (!first && !last) return dash;
  if (!first || !last || first === last) return formatDate(first || last);
  return `${formatDate(first)} – ${formatDate(last)}`;
}

function sortValue(vendor: VendorRow, key: SortKey): string | number | null {
  switch (key) {
    case 'vendor': return vendor.vendor_name.toLowerCase();
    case 'bills': return vendor.bill_count;
    case 'total': return vendor.total;
    case 'last': return vendor.last_bill;
    case 'hourly': return vendor.headline_hourly;
    case 'elsewhere': return vendor.bills_elsewhere.total;
    default: return null;
  }
}

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/** Stable sort with nulls last whatever the direction, ties broken by name. */
function sortVendors(list: VendorRow[], sort: SortState): VendorRow[] {
  const direction = sort.dir === 'asc' ? 1 : -1;
  return list.slice().sort((a, b) => {
    const av = sortValue(a, sort.key);
    const bv = sortValue(b, sort.key);
    if (av === null && bv === null) return a.vendor_name.localeCompare(b.vendor_name);
    if (av === null) return 1;
    if (bv === null) return -1;
    const order = compareValues(av, bv) * direction;
    return order !== 0 ? order : a.vendor_name.localeCompare(b.vendor_name);
  });
}

const toggleButtonClass = (on: boolean) =>
  `inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-xs font-semibold transition ${
    on ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
  }`;

export default function VendorsTab({ filters, canEdit }: VendorsTabProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const openVendorId = searchParams.get('vendor');

  const [vendors, setVendors] = useState<VendorRow[] | null>(null);
  const [labels, setLabels] = useState<RateLabels>(FALLBACK_LABELS);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [review, setReview] = useState<ReviewFilter>('all');
  const [grouped, setGrouped] = useState(false);
  const [includeAll, setIncludeAll] = useState(false);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [autoRunning, setAutoRunning] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Latest filters for requests fired from handlers; this effect is declared before
  // the load effect so the ref is current when a filter change triggers a reload.
  const filtersRef = useRef(filters);
  const filterKey = buildFilterQuery(filters);
  // Monotonic request id so a slow, superseded response never overwrites a newer one.
  const requestIdRef = useRef(0);

  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setRefreshing(true);
    try {
      const result = await getVendors({ ...filtersRef.current, include: includeAll ? 'all' : 'bills' });
      if (requestId !== requestIdRef.current) return;
      setVendors(result.vendors);
      if (result.labels) setLabels(result.labels);
      setError(null);
    } catch (err: any) {
      if (requestId !== requestIdRef.current) return;
      const message = apiError(err);
      setError(message);
      toast.error(message);
    } finally {
      if (requestId === requestIdRef.current) setRefreshing(false);
    }
  }, [includeAll]);

  useEffect(() => {
    void load();
  }, [load, filterKey]);

  // Taxonomy for the selects and the category filter; loaded once.
  useEffect(() => {
    let cancelled = false;
    getCategories()
      .then(rows => {
        if (!cancelled) setCategories(rows);
      })
      .catch(() => {
        // The selects then fall back to the categories seen on the vendors themselves.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setBusy = useCallback((id: string, busy: boolean) => {
    setBusyIds(previous => (busy ? (previous.includes(id) ? previous : [...previous, id]) : previous.filter(entry => entry !== id)));
  }, []);

  // After a category change the row is refetched under the current filters, so
  // totals, the source chip, "bills elsewhere" and the profile chip all update.
  // Rows are matched by group_key because a first-time category write turns a
  // `qbo:<id>` vendor id into the new row's id.
  const refreshRow = useCallback(async (vendorId: string) => {
    try {
      const detail = await getVendorDetail(vendorId, filtersRef.current);
      setVendors(previous => {
        if (!previous) return previous;
        const index = previous.findIndex(vendor => vendor.group_key === detail.group_key || vendor.id === vendorId);
        if (index === -1) return previous;
        const next = previous.slice();
        next[index] = detail;
        return next;
      });
    } catch {
      // The change itself was saved; only the refreshed row failed, so reload the list.
      void load();
    }
  }, [load]);

  const openVendor = useCallback((vendorId: string) => {
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      next.set('vendor', vendorId);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const closeVendor = useCallback(() => {
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      next.delete('vendor');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  // Taxonomy order first; any category a vendor carries that the taxonomy request
  // did not return (request failed, or an inactive id) is appended so its select
  // still shows the stored value.
  const categoryOptions = useMemo<CategoryOption[]>(() => {
    const list: CategoryOption[] = categories.map(row => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      is_active: row.is_active === true || Number(row.is_active) === 1,
    }));
    const seen = new Set(list.map(option => option.id));
    for (const vendor of vendors || []) {
      if (seen.has(vendor.category.id)) continue;
      seen.add(vendor.category.id);
      list.push({ id: vendor.category.id, name: vendor.category.name, kind: vendor.category.kind, is_active: true });
    }
    return list;
  }, [categories, vendors]);

  const selectOptions = useMemo<CategoryOption[]>(() => {
    const active = categoryOptions.filter(option => option.is_active && option.id !== UNCATEGORIZED_ID);
    return [...active, { id: UNCATEGORIZED_ID, name: 'Uncategorized', kind: 'other', is_active: true }];
  }, [categoryOptions]);

  const countByCategory = useMemo(() => {
    const counts = new Map<string, number>();
    for (const vendor of vendors || []) counts.set(vendor.category.id, (counts.get(vendor.category.id) || 0) + 1);
    return counts;
  }, [vendors]);

  const categoryLabel = useCallback(
    (id: string) => categoryOptions.find(option => option.id === id)?.name || (id === UNCATEGORIZED_ID ? 'Uncategorized' : id),
    [categoryOptions],
  );

  const changeCategory = async (vendor: VendorRow, categoryId: string) => {
    if (categoryId === vendor.category.id) return;
    setBusy(vendor.id, true);
    try {
      const secondary = vendor.category.secondary_id && vendor.category.secondary_id !== categoryId ? vendor.category.secondary_id : null;
      const result = await setVendorCategory(vendor.id, { category_id: categoryId, secondary_category_id: secondary });
      toast.success(`${vendor.vendor_name} → ${categoryLabel(categoryId)}`);
      if (result.profile_list_mismatch) {
        toast(`${vendor.vendor_name} is on the ${vendor.profile?.is_supplier ? 'Suppliers' : 'Contractors'} list on the Vendors page, which disagrees with this category.`);
      }
      await refreshRow(vendor.id);
    } catch (err: any) {
      toast.error(apiError(err));
    } finally {
      setBusy(vendor.id, false);
    }
  };

  const confirmCategory = async (vendor: VendorRow) => {
    setBusy(vendor.id, true);
    try {
      await confirmVendorCategory(vendor.id);
      toast.success(`${vendor.vendor_name} confirmed as ${vendor.category.name}`);
      await refreshRow(vendor.id);
    } catch (err: any) {
      toast.error(apiError(err));
    } finally {
      setBusy(vendor.id, false);
    }
  };

  const runAutoCategorize = async () => {
    setAutoRunning(true);
    try {
      const result = await autoCategorize();
      const changed = (result.changes || []).length;
      if (changed > 0) {
        toast.success(`${plural(changed, 'vendor')} categorized by keyword. They are listed under "Needs review" until confirmed.`);
        setReview('needs_review');
      } else {
        toast.success('No uncategorized vendor matched a keyword rule.');
      }
      await load();
    } catch (err: any) {
      toast.error(apiError(err));
    } finally {
      setAutoRunning(false);
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadCsv('vendors', filtersRef.current);
    } catch (err: any) {
      toast.error(apiError(err));
    } finally {
      setExporting(false);
    }
  };

  const onSort = (key: SortKey) => {
    setSort(previous => (
      previous.key === key
        ? { key, dir: previous.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'vendor' ? 'asc' : 'desc' }
    ));
  };

  const visible = useMemo<VendorRow[]>(() => {
    if (!vendors) return [];
    const needle = search.trim().toLowerCase();
    const matches = vendors.filter(vendor => {
      if (categoryFilter && vendor.category.id !== categoryFilter) return false;
      if (review === 'needs_review' && !vendor.needs_review) return false;
      if (review === 'manual' && vendor.category.source !== 'manual') return false;
      if (needle) {
        const haystack = `${vendor.vendor_name} ${vendor.category.name} ${vendor.profile?.category || ''}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
    return sortVendors(matches, sort);
  }, [vendors, search, categoryFilter, review, sort]);

  const groups = useMemo<VendorGroup[]>(() => {
    if (!grouped) return [{ key: 'all', name: '', vendors: visible, total: 0 }];
    const order = new Map<string, number>();
    categoryOptions.forEach((option, index) => order.set(option.id, index));
    const byCategory = new Map<string, VendorRow[]>();
    for (const vendor of visible) {
      const list = byCategory.get(vendor.category.id);
      if (list) list.push(vendor);
      else byCategory.set(vendor.category.id, [vendor]);
    }
    const rank = (key: string) => (key === UNCATEGORIZED_ID ? Number.MAX_SAFE_INTEGER : order.get(key) ?? 9999);
    return Array.from(byCategory.entries())
      .map(([key, list]) => ({
        key,
        name: list[0]?.category.name ?? key,
        vendors: list,
        total: list.reduce((sum, vendor) => sum + vendor.total, 0),
      }))
      .sort((a, b) => rank(a.key) - rank(b.key) || a.name.localeCompare(b.name));
  }, [grouped, visible, categoryOptions]);

  if (vendors === null) {
    if (error === null) return <Loading message="Loading vendors..." />;
    return (
      <div className={cardClass}>
        <p className="text-sm font-semibold text-slate-800">Vendors could not be loaded.</p>
        <p className="mt-1 text-sm text-slate-500">{error}</p>
        <button type="button" className={`${secondaryButton} mt-4`} onClick={() => { void load(); }}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  }

  const needsReviewCount = vendors.filter(vendor => vendor.needs_review).length;
  const manualCount = vendors.filter(vendor => vendor.category.source === 'manual').length;
  const reviewCount = (id: ReviewFilter) => (id === 'needs_review' ? needsReviewCount : id === 'manual' ? manualCount : vendors.length);
  const colCount = canEdit ? 10 : 9;

  const emptyTitle = review === 'needs_review'
    ? 'Nothing needs review'
    : vendors.length === 0
      ? 'No vendors with bills in this range'
      : 'No vendors match';
  const emptyMessage = review === 'needs_review'
    ? 'Every vendor category in this list has been confirmed or set by hand.'
    : vendors.length === 0
      ? 'Widen the date range, or include vendors without bills to review their categories.'
      : 'Try a different search, category or review filter.';

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <label className="relative flex-1">
          <span className="sr-only">Search vendors</span>
          <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" aria-hidden="true" />
          <input
            type="text"
            className={`${fieldClass} pl-9`}
            placeholder="Search vendors"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
        </label>
        <select
          className={`${fieldClass} lg:w-64`}
          aria-label="Category filter"
          value={categoryFilter}
          onChange={event => setCategoryFilter(event.target.value)}
        >
          <option value="">All categories</option>
          {categoryOptions.filter(option => option.id !== UNCATEGORIZED_ID).map(option => (
            <option key={option.id} value={option.id}>
              {option.name}{countByCategory.get(option.id) ? ` (${countByCategory.get(option.id)})` : ''}
            </option>
          ))}
          <option value={UNCATEGORIZED_ID}>
            Uncategorized{countByCategory.get(UNCATEGORIZED_ID) ? ` (${countByCategory.get(UNCATEGORIZED_ID)})` : ''}
          </option>
        </select>
        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <button
              type="button"
              className={secondaryButton}
              onClick={() => { void runAutoCategorize(); }}
              disabled={autoRunning}
              title="Give vendors that have no cost category yet a keyword-based guess"
            >
              <RefreshCw className={`h-4 w-4 ${autoRunning ? 'animate-spin' : ''}`} aria-hidden="true" />
              Auto-categorize
            </button>
          )}
          <button type="button" className={secondaryButton} onClick={() => { void exportCsv(); }} disabled={exporting} title="Download this report as CSV">
            <Download className="h-4 w-4" aria-hidden="true" />
            CSV
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border border-slate-300 bg-white" role="group" aria-label="Review filter">
          {REVIEW_OPTIONS.map((option, index) => {
            const active = review === option.id;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={active}
                onClick={() => setReview(option.id)}
                className={`inline-flex h-9 items-center gap-1.5 px-3 text-xs font-semibold transition ${index === 0 ? 'rounded-l-md' : ''} ${
                  index === REVIEW_OPTIONS.length - 1 ? 'rounded-r-md' : ''
                } ${active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
              >
                {option.label}
                <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${active ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600'}`}>
                  {num(reviewCount(option.id))}
                </span>
              </button>
            );
          })}
        </div>
        <button type="button" aria-pressed={grouped} onClick={() => setGrouped(value => !value)} className={toggleButtonClass(grouped)}>
          Group by category
        </button>
        <label className="inline-flex h-9 items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 accent-slate-900"
            checked={includeAll}
            onChange={event => setIncludeAll(event.target.checked)}
          />
          Include vendors without bills
        </label>
        <span className="ml-auto inline-flex items-center gap-2 text-xs text-slate-500">
          {refreshing && <InlineSpinner label="Updating" />}
          {visible.length === vendors.length ? plural(vendors.length, 'vendor') : `${num(visible.length)} of ${plural(vendors.length, 'vendor')}`}
        </span>
      </div>

      {error && (
        <p className="text-xs text-rose-700" role="alert">
          {error}
        </p>
      )}

      {/* Hold the previous render at reduced opacity while the list refetches - no skeleton flash. */}
      <div className={`transition-opacity ${refreshing ? 'opacity-60' : ''}`} aria-busy={refreshing ? true : undefined}>
        {visible.length === 0 ? (
          <EmptyState icon={Users} title={emptyTitle} message={emptyMessage} />
        ) : (
          <>
            <div className={`${tableWrapClass} hidden md:block`}>
              <table className={`${tableClass} min-w-[1100px]`}>
                <thead className={theadClass}>
                  <tr>
                    <SortHeader label="Vendor" sortKey="vendor" sort={sort} onSort={onSort} className={`${thClass} sticky left-0 z-10 bg-slate-50`} />
                    <th scope="col" className={thClass}>Category</th>
                    {canEdit && (
                      <th scope="col" className={thClass}>
                        <span className="sr-only">Confirm</span>
                      </th>
                    )}
                    <SortHeader label="Bills" sortKey="bills" sort={sort} onSort={onSort} numeric />
                    <SortHeader label="Total" sortKey="total" sort={sort} onSort={onSort} numeric />
                    <SortHeader label="First – last" sortKey="last" sort={sort} onSort={onSort} />
                    <SortHeader
                      label={labels.full_year}
                      sortKey="hourly"
                      sort={sort}
                      onSort={onSort}
                      numeric
                      title="Hours-weighted average over complete calendar years: amount billed ÷ 2,080 h"
                    />
                    <SortHeader
                      label="Bills elsewhere"
                      sortKey="elsewhere"
                      sort={sort}
                      onSort={onSort}
                      numeric
                      title="Bills counted under a category other than the vendor's (manual override, AI suggestion or keyword rule)"
                    />
                    <th scope="col" className={thClass} title="Which list the vendor sits on in the Vendors page">Vendors page</th>
                    <th scope="col" className={`${thClass} w-10`}>
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                {groups.map(group => (
                  <tbody key={group.key} className={`${tbodyClass} border-t border-slate-200`}>
                    {grouped && (
                      <tr className="bg-slate-50">
                        <th scope="rowgroup" colSpan={colCount} className="px-4 py-2 text-left text-xs font-bold uppercase text-slate-700">
                          {group.name}
                          <span className="ml-2 font-normal normal-case text-slate-500">
                            {plural(group.vendors.length, 'vendor')} · {money(group.total, 0)}
                          </span>
                        </th>
                      </tr>
                    )}
                    {group.vendors.map(vendor => (
                      <VendorTableRow
                        key={vendor.id}
                        vendor={vendor}
                        canEdit={canEdit}
                        busy={busyIds.includes(vendor.id)}
                        options={selectOptions}
                        onOpen={openVendor}
                        onChangeCategory={changeCategory}
                        onConfirm={confirmCategory}
                      />
                    ))}
                  </tbody>
                ))}
              </table>
            </div>

            <div className="space-y-4 md:hidden">
              {groups.map(group => (
                <section key={group.key} className="space-y-2">
                  {grouped && (
                    <h3 className="text-xs font-bold uppercase text-slate-700">
                      {group.name}
                      <span className="ml-2 font-normal normal-case text-slate-500">
                        {plural(group.vendors.length, 'vendor')} · {money(group.total, 0)}
                      </span>
                    </h3>
                  )}
                  <ul className="space-y-2">
                    {group.vendors.map(vendor => (
                      <VendorCard
                        key={vendor.id}
                        vendor={vendor}
                        canEdit={canEdit}
                        busy={busyIds.includes(vendor.id)}
                        options={selectOptions}
                        labels={labels}
                        onOpen={openVendor}
                        onChangeCategory={changeCategory}
                        onConfirm={confirmCategory}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>

            <RateCaption className="mt-3" />
          </>
        )}
      </div>

      <VendorDrawer
        vendorId={openVendorId}
        onClose={closeVendor}
        canEdit={canEdit}
        filters={filters}
        onChanged={() => {
          if (openVendorId) void refreshRow(openVendorId);
        }}
      />
    </div>
  );
}

// ── Table pieces ────────────────────────────────────────────────────────────

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  numeric = false,
  className,
  title,
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  numeric?: boolean;
  className?: string;
  title?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      scope="col"
      className={className || (numeric ? thNumClass : thClass)}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
      title={title}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 uppercase transition hover:text-slate-900 ${active ? 'text-slate-900' : ''}`}
      >
        {label}
        <ChevronDown
          className={`h-3 w-3 transition ${active ? '' : 'opacity-0'} ${active && sort.dir === 'asc' ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>
    </th>
  );
}

function CategorySelect({
  vendor,
  options,
  busy,
  onChange,
  className = '',
}: {
  vendor: VendorRow;
  options: CategoryOption[];
  busy: boolean;
  onChange: (vendor: VendorRow, categoryId: string) => void;
  className?: string;
}) {
  const hasCurrent = options.some(option => option.id === vendor.category.id);
  return (
    <select
      className={`${inlineSelectClass} ${className}`}
      value={vendor.category.id}
      disabled={busy}
      aria-label={`Cost category for ${vendor.vendor_name}`}
      onClick={event => event.stopPropagation()}
      onChange={event => onChange(vendor, event.target.value)}
    >
      {!hasCurrent && <option value={vendor.category.id}>{vendor.category.name}</option>}
      {options.map(option => (
        <option key={option.id} value={option.id}>{option.name}</option>
      ))}
    </select>
  );
}

function ConfirmButton({ vendor, busy, onConfirm }: { vendor: VendorRow; busy: boolean; onConfirm: (vendor: VendorRow) => void }) {
  const category = vendor.category;
  if (category.source === 'manual') {
    if (!category.confirmed_at) return null;
    return (
      <span
        className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-emerald-700"
        title={`Confirmed ${formatDateTime(category.confirmed_at)}${category.confirmed_by_name ? ` by ${category.confirmed_by_name}` : ''}`}
      >
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
        Confirmed
      </span>
    );
  }
  // Nothing to confirm until a category row exists (the select creates one).
  if (!category.row_id) return null;
  return (
    <button
      type="button"
      className={`${secondaryButton} h-9 px-3`}
      disabled={busy}
      aria-label={`Confirm ${category.name} for ${vendor.vendor_name}`}
      onClick={event => {
        event.stopPropagation();
        onConfirm(vendor);
      }}
    >
      <Check className="h-4 w-4" aria-hidden="true" />
      Confirm
    </button>
  );
}

/** Headline implied rate; when no complete year qualifies, the latest annualized rate is shown underneath, clearly labelled. */
function HourlyCell({ vendor, align = 'right' }: { vendor: VendorRow; align?: 'left' | 'right' }) {
  const latest = vendor.hourly.latest_annualized;
  if (vendor.headline_hourly !== null) {
    return <span title={`Hours-weighted over ${vendor.hourly.full_year_years.join(', ')}`}>{rate(vendor.headline_hourly)}</span>;
  }
  return (
    <span className={`inline-flex flex-col gap-0.5 ${align === 'right' ? 'items-end' : 'items-start'}`}>
      <ReasonChip reason={vendor.headline_hourly_reason} />
      {latest && latest.hourly_annualized !== null && (
        <span className="text-xs font-normal text-slate-500" title={latest.label}>
          {rate(latest.hourly_annualized)} annualized {latest.year}{latest.status === 'ytd' ? ' YTD' : ''}
        </span>
      )}
    </span>
  );
}

function ProfileListChip({ vendor }: { vendor: VendorRow }) {
  const profile = vendor.profile;
  if (!profile) {
    return (
      <span className="text-xs text-slate-400" title="No contractor profile on the Vendors page">No profile</span>
    );
  }
  const list = profile.is_supplier ? 'Suppliers list' : 'Contractors list';
  if (profile.list_mismatch) {
    return (
      <Chip
        tone="warn"
        title={`On the ${list} in the Vendors page, but the cost category is a ${CATEGORY_KIND_LABELS[vendor.category.kind].toLowerCase()}`}
      >
        {list}
      </Chip>
    );
  }
  return (
    <Chip tone="neutral" title={profile.category ? `Vendors page category: ${profile.category}` : undefined}>
      {list}
    </Chip>
  );
}

function BillsElsewhereCell({ vendor }: { vendor: VendorRow }) {
  const elsewhere = vendor.bills_elsewhere;
  if (elsewhere.count === 0) return <span className="text-slate-400">{dash}</span>;
  return (
    <span title={`${plural(elsewhere.count, 'bill')} counted under a category other than ${vendor.category.name}`}>
      {num(elsewhere.count)} · {money(elsewhere.total, 0)}
    </span>
  );
}

type RowProps = {
  vendor: VendorRow;
  canEdit: boolean;
  busy: boolean;
  options: CategoryOption[];
  onOpen: (vendorId: string) => void;
  onChangeCategory: (vendor: VendorRow, categoryId: string) => void;
  onConfirm: (vendor: VendorRow) => void;
};

function VendorTableRow({ vendor, canEdit, busy, options, onOpen, onChangeCategory, onConfirm }: RowProps) {
  const category = vendor.category;
  const profileCategory = vendor.profile?.category || null;
  const subline = [
    category.secondary_name ? `Also ${category.secondary_name}` : null,
    profileCategory ? `Vendors page: ${profileCategory}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <tr
      className="cursor-pointer outline-none transition hover:bg-slate-50 focus-visible:bg-slate-50"
      tabIndex={0}
      aria-label={`Open ${vendor.vendor_name}`}
      onClick={() => onOpen(vendor.id)}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        onOpen(vendor.id);
      }}
    >
      <td className={`${tdClass} ${stickyFirstColClass}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-slate-950">{vendor.vendor_name}</span>
          {vendor.needs_review && (
            <Chip tone="warn" title={category.rationale || 'Guessed category, not yet confirmed'}>Needs review</Chip>
          )}
        </div>
        {subline && <p className="text-xs text-slate-500">{subline}</p>}
      </td>
      <td className={tdClass}>
        {canEdit
          ? <CategorySelect vendor={vendor} options={options} busy={busy} onChange={onChangeCategory} />
          : <span className="font-medium text-slate-800">{category.name}</span>}
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <SourceChip source={category.source} confidence={category.confidence} title={category.rationale || undefined} />
          {busy && <InlineSpinner label="Saving" />}
        </div>
      </td>
      {canEdit && (
        <td className={tdClass}>
          <ConfirmButton vendor={vendor} busy={busy} onConfirm={onConfirm} />
        </td>
      )}
      <td className={tdNumClass}>
        {num(vendor.bill_count)}
        {vendor.zero_amount_bills > 0 && <span className="block text-xs text-slate-400">+{vendor.zero_amount_bills} at $0</span>}
      </td>
      <td className={`${tdNumClass} font-semibold text-slate-900`}>{money(vendor.total, 0)}</td>
      <td className={`${tdClass} whitespace-nowrap text-slate-600`}>{dateRange(vendor.first_bill, vendor.last_bill)}</td>
      <td className={tdNumClass}><HourlyCell vendor={vendor} /></td>
      <td className={tdNumClass}><BillsElsewhereCell vendor={vendor} /></td>
      <td className={tdClass}><ProfileListChip vendor={vendor} /></td>
      <td className={`${tdClass} w-10`}>
        <ChevronRight className="h-4 w-4 text-slate-400" aria-hidden="true" />
      </td>
    </tr>
  );
}

function VendorCard({ vendor, canEdit, busy, options, labels, onOpen, onChangeCategory, onConfirm }: RowProps & { labels: RateLabels }) {
  const category = vendor.category;
  return (
    <li className={cardClass}>
      <div className="flex items-start justify-between gap-3">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(vendor.id)} aria-label={`Open ${vendor.vendor_name}`}>
          <span className="block truncate font-semibold text-slate-950">{vendor.vendor_name}</span>
          <span className="block text-xs text-slate-500">
            {plural(vendor.bill_count, 'bill')} · {dateRange(vendor.first_bill, vendor.last_bill)}
          </span>
        </button>
        <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <p className={labelClass}>Total</p>
          <p className="mt-1 text-lg font-bold tabular-nums text-slate-950">{money(vendor.total, 0)}</p>
        </div>
        <div>
          <p className={labelClass}>{labels.full_year}</p>
          <p className="mt-1 text-lg font-bold tabular-nums text-slate-950">
            <HourlyCell vendor={vendor} align="left" />
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canEdit
          ? <CategorySelect vendor={vendor} options={options} busy={busy} onChange={onChangeCategory} className="w-full sm:w-auto" />
          : <span className="font-medium text-slate-800">{category.name}</span>}
        <SourceChip source={category.source} confidence={category.confidence} title={category.rationale || undefined} />
        {vendor.needs_review && <Chip tone="warn">Needs review</Chip>}
        <ProfileListChip vendor={vendor} />
        {vendor.bills_elsewhere.count > 0 && (
          <span className="text-xs text-slate-500">
            Elsewhere: <BillsElsewhereCell vendor={vendor} />
          </span>
        )}
        {canEdit && <ConfirmButton vendor={vendor} busy={busy} onConfirm={onConfirm} />}
        {busy && <InlineSpinner label="Saving" />}
      </div>
    </li>
  );
}
