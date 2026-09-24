import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Hammer, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';

import {
  CATEGORY_KIND_LABELS,
  SPEND_TYPES,
  SPEND_TYPE_LABELS,
  buildFilterQuery,
  dash,
  downloadCsv,
  formatDate,
  getCategoryDetail,
  getCategoryStats,
  humanize,
  money,
  num,
  pct,
  perSqft,
  rate,
} from '../../lib/costAnalyzerApi';
import type {
  CategoryDetail,
  CategoryStatsResponse,
  CategoryStatsRow,
  CostAnalyzerFilters,
  PerSpecSummary,
} from '../../lib/costAnalyzerApi';
import {
  BarList,
  Chip,
  Drawer,
  EmptyState,
  InlineSpinner,
  RateCaption,
  ReasonChip,
  SectionHeading,
  StatTile,
  StatusChip,
  apiError,
  cardClass,
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
// The attachment route is Bearer-authenticated (no cookie, no ?token=), so a plain
// link would 401: openAttachment fetches the file with the token and opens the tab.
import { openAttachment } from './DocumentsTab';

// Categories tab (spec §7 CategoriesTab): what each trade / supplier / service
// category costs across every project. The two owner numbers are the implied
// hourly rate for trades (Σ complete qualifying vendor-years ÷ 2,080 h each,
// FTE-weighted - owner's definition: 40 h × 52 wk) and the weighted $/sq ft
// over complete projects with square footage. Both come from GET
// /categories/stats; the tab never computes money itself.

export type CategoriesTabProps = {
  filters: CostAnalyzerFilters;
  canEdit: boolean;
  onOpenVendor?: (vendorId: string) => void;
};

/** Sticky first header cell (thead background; stickyFirstColClass is white for body cells). */
const stickyHeadClass = 'sticky left-0 z-10 bg-slate-50';

function kindLabel(kind: CategoryStatsRow['kind']): string {
  return CATEGORY_KIND_LABELS[kind] || humanize(kind);
}

/** "$12.34/sq ft" cell with the class count underneath, or a dash carrying the reason. */
function PerSqftCell({ value, nClasses, reason }: { value: number | null; nClasses: number; reason: string | null }) {
  if (value === null) {
    return <span className="text-slate-400" title={reason || undefined}>{dash}</span>;
  }
  return (
    <span className="inline-flex flex-col items-end">
      <span>{perSqft(value)}</span>
      <span className="text-xs font-normal text-slate-500">{num(nClasses)} project{nClasses === 1 ? '' : 's'}</span>
    </span>
  );
}

/** Implied $/hr cell: trades only; a null rate shows the reason chip. */
function ImpliedRateCell({ row }: { row: CategoryStatsRow }) {
  if (!row.is_trade) {
    return <span className="text-slate-400" title="Implied hourly rates apply to trades only">{dash}</span>;
  }
  if (row.implied_hourly === null) {
    return <ReasonChip reason={row.implied_hourly_reason} />;
  }
  return (
    <span className="inline-flex flex-col items-end" title={`${num(row.n_vendor_years)} complete vendor-year${row.n_vendor_years === 1 ? '' : 's'} from ${num(row.n_vendors_qualifying)} vendor${row.n_vendors_qualifying === 1 ? '' : 's'}`}>
      <span>{rate(row.implied_hourly)}</span>
      <span className="text-xs font-normal text-slate-500">{num(row.n_vendors_qualifying)} vendor{row.n_vendors_qualifying === 1 ? '' : 's'}</span>
    </span>
  );
}

/** Measured "Invoice $/hr" from extracted items that list hours. */
function DocRateCell({ row }: { row: CategoryStatsRow }) {
  if (row.doc_hourly === null) {
    return <span className="text-slate-400" title="No invoice in this category lists hours">{dash}</span>;
  }
  return (
    <span className="inline-flex flex-col items-end">
      <span>{rate(row.doc_hourly)}</span>
      <span className="text-xs font-normal text-slate-500">{num(row.n_docs_with_hours)} invoice{row.n_docs_with_hours === 1 ? '' : 's'}</span>
    </span>
  );
}

/** One line summarising a weighted / avg / min / max per-spec block. */
function PerSpecLine({ label, summary, format }: { label: string; summary: PerSpecSummary; format: (value: number | null) => string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
      <span className="text-sm text-slate-700">{label}</span>
      {summary.weighted === null ? (
        <span className="text-sm text-slate-500">{summary.reason || 'not available'}</span>
      ) : (
        <span className="text-sm tabular-nums text-slate-900">
          <span className="font-semibold">{format(summary.weighted)}</span>
          <span className="text-slate-500"> weighted · avg {format(summary.avg)} · {format(summary.min)} – {format(summary.max)} · {num(summary.n_classes)} project{summary.n_classes === 1 ? '' : 's'}</span>
          {summary.n_in_progress_excluded > 0 && (
            <span className="text-slate-500"> · {num(summary.n_in_progress_excluded)} in progress excluded</span>
          )}
        </span>
      )}
    </div>
  );
}

export default function CategoriesTab({ filters, onOpenVendor }: CategoriesTabProps) {
  const [data, setData] = useState<CategoryStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false);
  // Weighted $/sq ft excludes in-progress projects by default (their spend is still growing).
  const [includeInProgress, setIncludeInProgress] = useState(false);
  const [exporting, setExporting] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CategoryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const effectiveFilters = useMemo<CostAnalyzerFilters>(
    () => ({ ...filters, include_in_progress: includeInProgress }),
    [filters, includeInProgress],
  );
  const query = useMemo(() => buildFilterQuery(effectiveFilters), [effectiveFilters]);
  const filtersRef = useRef(effectiveFilters);
  filtersRef.current = effectiveFilters;
  // Monotonic request id so a slow, superseded response never overwrites a newer one.
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setRefreshing(true);
    try {
      const result = await getCategoryStats(filtersRef.current);
      if (requestId !== requestRef.current) return;
      setData(result);
      setError(null);
    } catch (err: any) {
      if (requestId !== requestRef.current) return;
      const message = apiError(err);
      setError(message);
      toast.error(message);
    } finally {
      if (requestId === requestRef.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [query, load]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    getCategoryDetail(selectedId, filtersRef.current)
      .then(result => { if (!cancelled) setDetail(result); })
      .catch((err: unknown) => { if (!cancelled) toast.error(apiError(err)); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId, query]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadCsv('categories', filtersRef.current);
    } catch (err: any) {
      toast.error(apiError(err));
    } finally {
      setExporting(false);
    }
  };

  const rows = useMemo(() => {
    const all = data ? data.categories : [];
    // Backend order is total desc, name asc; keep it.
    return showEmpty ? all : all.filter(row => row.total > 0 || row.bill_count > 0);
  }, [data, showEmpty]);

  const bars = useMemo(() => rows
    .filter(row => row.total > 0)
    .map(row => ({
      key: row.id,
      label: row.name,
      value: row.total,
      sublabel: `${num(row.vendor_count)} vendor${row.vendor_count === 1 ? '' : 's'} · ${pct(row.share)}`,
      onClick: () => setSelectedId(row.id),
    })), [rows]);

  const selectedRow = useMemo(() => (data && selectedId ? data.categories.find(row => row.id === selectedId) ?? null : null), [data, selectedId]);

  if (data === null && error === null) {
    return (
      <div className={cardClass}>
        <InlineSpinner label="Loading categories..." />
      </div>
    );
  }

  if (data === null) {
    return (
      <div className={cardClass}>
        <p className="text-sm font-semibold text-slate-800">Categories could not be loaded.</p>
        <p className="mt-1 text-sm text-slate-500">{error}</p>
        <button type="button" className={`${secondaryButton} mt-4`} onClick={() => { void load(); }}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  }

  const labels = data.labels;
  const tradeRows = data.categories.filter(row => row.is_trade);
  const tradesWithRate = tradeRows.filter(row => row.implied_hourly !== null).length;
  const withSqft = data.categories.filter(row => row.per_sqft_weighted !== null).length;
  const activeCount = data.categories.filter(row => row.total > 0).length;

  return (
    <div className={`space-y-6 transition-opacity ${refreshing ? 'opacity-60' : ''}`} aria-busy={refreshing ? true : undefined}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Total spend" value={money(data.total, 0)} hint={`${num(activeCount)} categories with spend`} icon={Hammer} />
        <StatTile
          label="Trades with an implied rate"
          value={`${num(tradesWithRate)} / ${num(tradeRows.length)}`}
          hint="Needs a complete calendar year with 4+ bills over 8+ weeks"
          implied
        />
        <StatTile
          label="Categories with $/sq ft"
          value={`${num(withSqft)} / ${num(activeCount)}`}
          hint={withSqft === 0 ? 'Record square footage on the Projects tab' : 'Weighted over complete projects with sq ft'}
          tone={withSqft === 0 ? 'warn' : 'neutral'}
        />
        <StatTile
          label="Uncategorized spend"
          value={money(data.categories.find(row => row.id === 'uncategorized')?.total ?? 0, 0)}
          hint="Fix vendor categories on the Vendors tab"
          tone={(data.categories.find(row => row.id === 'uncategorized')?.total ?? 0) > 0 ? 'warn' : 'ok'}
        />
      </div>

      <section className="space-y-4">
        <SectionHeading
          title="Categories"
          hint="Click a category for its projects, vendors, years and materials."
          action={(
            <button type="button" className={secondaryButton} onClick={() => { void exportCsv(); }} disabled={exporting}>
              <Download className="h-4 w-4" aria-hidden="true" />
              {exporting ? 'Exporting...' : 'Export CSV'}
            </button>
          )}
        />

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-slate-700">
          <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 accent-amber-700"
              checked={includeInProgress}
              onChange={event => setIncludeInProgress(event.target.checked)}
            />
            Include in-progress projects in $/sq ft
          </label>
          <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 accent-amber-700"
              checked={showEmpty}
              onChange={event => setShowEmpty(event.target.checked)}
            />
            Show categories with no spend
          </label>
        </div>

        {rows.length === 0 ? (
          <EmptyState title="No spend in this range" message="No bills fall inside the selected dates or spend type." icon={Hammer} />
        ) : (
          <>
            <div className={`${tableWrapClass} hidden md:block`}>
              <table className={`${tableClass} min-w-[1000px]`}>
                <thead className={theadClass}>
                  <tr>
                    <th className={`${thClass} ${stickyHeadClass}`}>Category</th>
                    <th className={thClass}>Kind</th>
                    <th className={thNumClass}>Total</th>
                    <th className={thNumClass}>Share</th>
                    <th className={thNumClass}>Vendors</th>
                    <th className={thNumClass}>Bills</th>
                    <th className={thNumClass}>{labels.full_year} (FTE-weighted)</th>
                    <th className={thNumClass}>$/sq ft (weighted)</th>
                    <th className={thNumClass}>{labels.doc}</th>
                    <th className={`${thClass} w-12`}><span className="sr-only">Open</span></th>
                  </tr>
                </thead>
                <tbody className={tbodyClass}>
                  {rows.map(row => (
                    <tr
                      key={row.id}
                      className="cursor-pointer transition hover:bg-slate-50"
                      onClick={() => setSelectedId(row.id)}
                    >
                      <td className={`${tdClass} ${stickyFirstColClass}`}>
                        <button
                          type="button"
                          onClick={event => { event.stopPropagation(); setSelectedId(row.id); }}
                          className="text-left font-semibold text-slate-900 hover:underline"
                        >
                          {row.name}
                        </button>
                      </td>
                      <td className={tdClass}>
                        <Chip tone={row.id === 'uncategorized' ? 'warn' : 'neutral'}>{kindLabel(row.kind)}</Chip>
                      </td>
                      <td className={`${tdNumClass} font-semibold text-slate-900`}>{money(row.total, 0)}</td>
                      <td className={tdNumClass}>{pct(row.share)}</td>
                      <td className={tdNumClass}>{num(row.vendor_count)}</td>
                      <td className={tdNumClass}>{num(row.bill_count)}</td>
                      <td className={tdNumClass}><ImpliedRateCell row={row} /></td>
                      <td className={tdNumClass}>
                        <PerSqftCell value={row.per_sqft_weighted} nClasses={row.n_classes_with_sqft} reason={row.per_sqft_reason} />
                      </td>
                      <td className={tdNumClass}><DocRateCell row={row} /></td>
                      <td className={tdClass}>
                        <ChevronRight className="h-4 w-4 text-slate-400" aria-hidden="true" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Phone cards */}
            <div className="space-y-3 md:hidden">
              {rows.map(row => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setSelectedId(row.id)}
                  className={`${cardClass} block w-full text-left transition hover:border-slate-300 hover:bg-slate-50`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900">{row.name}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Chip tone={row.id === 'uncategorized' ? 'warn' : 'neutral'}>{kindLabel(row.kind)}</Chip>
                        <span className="text-xs text-slate-500">{num(row.vendor_count)} vendors · {num(row.bill_count)} bills</span>
                      </div>
                    </div>
                    <ChevronRight className="h-5 w-5 shrink-0 text-slate-400" aria-hidden="true" />
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-x-4 gap-y-3">
                    <div>
                      <p className={labelClass}>Total</p>
                      <p className="mt-1 text-base font-bold tabular-nums text-slate-900">{money(row.total, 0)}</p>
                      <p className="text-xs text-slate-500">{pct(row.share)}</p>
                    </div>
                    <div>
                      <p className={labelClass}>Implied $/hr</p>
                      <p className="mt-1 text-base font-bold tabular-nums text-slate-900">
                        {row.is_trade && row.implied_hourly !== null ? rate(row.implied_hourly) : dash}
                      </p>
                    </div>
                    <div>
                      <p className={labelClass}>$/sq ft</p>
                      <p className="mt-1 text-base font-bold tabular-nums text-slate-900">
                        {row.per_sqft_weighted !== null ? money(row.per_sqft_weighted) : dash}
                      </p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        <RateCaption />
        <p className="text-xs text-slate-500">
          The implied rate weights every complete, qualifying vendor-year as one 2,080-hour year (40 h × 52 wk).
          $/sq ft divides category spend on complete projects with recorded square footage by their total square feet.
        </p>
      </section>

      {bars.length > 0 && (
        <section className={`${cardClass} space-y-3`}>
          <BarList
            rows={bars}
            format={value => money(value, 0)}
            title="Spend by category"
            valueHeader="Total"
            ariaLabel="Spend by category"
          />
        </section>
      )}

      <Drawer
        isOpen={selectedId !== null}
        onClose={() => setSelectedId(null)}
        title={detail?.name ?? selectedRow?.name ?? 'Category'}
        description={(() => {
          const row = detail ?? selectedRow;
          if (!row) return undefined;
          return `${kindLabel(row.kind)} · ${money(row.total, 0)} · ${pct(row.share)} of spend in this range`;
        })()}
      >
        {selectedId && (
          <CategoryDrawerBody
            detail={detail}
            fallback={selectedRow}
            loading={detailLoading}
            onOpenVendor={onOpenVendor}
          />
        )}
      </Drawer>
    </div>
  );
}

// ── Drawer body ─────────────────────────────────────────────────────────────

function CategoryDrawerBody({
  detail,
  fallback,
  loading,
  onOpenVendor,
}: {
  detail: CategoryDetail | null;
  fallback: CategoryStatsRow | null;
  loading: boolean;
  onOpenVendor?: (vendorId: string) => void;
}) {
  const row: CategoryStatsRow | null = detail ?? fallback;
  if (!row) {
    return <InlineSpinner label="Loading category..." />;
  }

  const yearBars = row.by_year.map(entry => ({
    key: String(entry.year),
    label: String(entry.year),
    value: entry.total,
    sublabel: `${num(entry.bills)} bill${entry.bills === 1 ? '' : 's'}`,
  }));

  const vendorBars = row.vendors.slice(0, 12).map(vendor => ({
    key: vendor.id,
    label: vendor.name,
    value: vendor.total,
    sublabel: `${num(vendor.bills)} bill${vendor.bills === 1 ? '' : 's'}`,
    onClick: onOpenVendor ? () => onOpenVendor(vendor.id) : undefined,
  }));

  const families = detail ? detail.materials.families : [];
  const jobCosts = detail ? detail.materials.job_costs : [];

  return (
    <div className={`space-y-6 transition-opacity ${loading && detail ? 'opacity-60' : ''}`} aria-busy={loading ? true : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={row.id === 'uncategorized' ? 'warn' : 'neutral'}>{kindLabel(row.kind)}</Chip>
        {row.is_trade && <Chip tone="ok">Trade · implied $/hr applies</Chip>}
        {row.include_in_progress && <Chip tone="neutral">In-progress projects included in $/sq ft</Chip>}
        {loading && !detail && <InlineSpinner label="Loading details..." />}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Total spend" value={money(row.total, 0)} hint={`${num(row.bill_count)} bills · ${num(row.vendor_count)} vendors`} />
        <StatTile
          label={row.implied_hourly_label || `${row.name} implied $/hr`}
          value={row.is_trade && row.implied_hourly !== null ? rate(row.implied_hourly) : dash}
          hint={!row.is_trade
            ? 'Implied rates apply to trades only'
            : row.implied_hourly === null
              ? row.implied_hourly_reason ?? undefined
              : `${num(row.n_vendor_years)} vendor-years · simple mean ${rate(row.implied_hourly_simple_mean)}`}
          tone={row.is_trade && row.implied_hourly === null ? 'warn' : 'neutral'}
          implied={row.is_trade && row.implied_hourly !== null}
        />
        <StatTile
          label="$/sq ft (weighted)"
          value={row.per_sqft_weighted !== null ? money(row.per_sqft_weighted) : dash}
          hint={row.per_sqft_weighted !== null
            ? `${num(row.n_classes_with_sqft)} projects · avg ${money(row.per_sqft_avg)} · ${money(row.per_sqft_min)} – ${money(row.per_sqft_max)}`
            : row.per_sqft_reason ?? undefined}
          tone={row.per_sqft_weighted === null ? 'warn' : 'neutral'}
        />
        <StatTile
          label={row.label || 'Invoice $/hr'}
          value={row.doc_hourly !== null ? rate(row.doc_hourly) : dash}
          hint={row.doc_hourly !== null
            ? `${num(row.n_docs_with_hours)} invoices listing hours · ${num(row.doc_hourly_hours, 1)} h`
            : row.doc_daily !== null
              ? `${money(row.doc_daily)}/day on ${num(row.n_docs_with_days)} invoices (${rate(row.doc_daily_as_hourly)} at ${row.hours_per_day_assumed} h/day)`
              : 'No invoice in this category lists hours'}
        />
      </div>
      <RateCaption />

      <section className="space-y-3">
        <SectionHeading title="Spend by type" hint="From the QuickBooks expense account on each bill line" />
        <div className="grid grid-cols-2 gap-x-8 gap-y-4 border-b border-slate-200 pb-5 md:grid-cols-4">
          {SPEND_TYPES.map(type => {
            const summary = row.per_sqft_by_spend_type[type];
            return (
              <div key={type}>
                <p className={labelClass}>{SPEND_TYPE_LABELS[type]}</p>
                <p className="mt-1 text-xl font-bold tabular-nums text-slate-900">{money(row.by_spend_type[type], 0)}</p>
                <p className="text-xs text-slate-500" title={summary && summary.weighted === null ? summary.reason ?? undefined : undefined}>
                  {summary && summary.weighted !== null ? `${perSqft(summary.weighted)} · ${num(summary.n_classes)} projects` : dash}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeading title="By project" hint="Only complete projects with square footage and spend count toward the weighted $/sq ft" />
        {row.by_class.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">No spend in this range.</p>
        ) : (
          <div className={tableWrapClass}>
            <table className={`${tableClass} min-w-[720px]`}>
              <thead className={theadClass}>
                <tr>
                  <th className={`${thClass} ${stickyHeadClass}`}>Project</th>
                  <th className={thClass}>Status</th>
                  <th className={thNumClass}>Bills</th>
                  <th className={thNumClass}>Total</th>
                  <th className={thNumClass}>Sq ft</th>
                  <th className={thNumClass}>$/sq ft</th>
                  <th className={thClass}>In weighting</th>
                </tr>
              </thead>
              <tbody className={tbodyClass}>
                {row.by_class.map(entry => (
                  <tr key={entry.class_id}>
                    <td className={`${tdClass} ${stickyFirstColClass} font-semibold text-slate-900`}>{entry.name}</td>
                    <td className={tdClass}><StatusChip status={entry.completeness} /></td>
                    <td className={tdNumClass}>{num(entry.bills)}</td>
                    <td className={tdNumClass}>{money(entry.total, 0)}</td>
                    <td className={tdNumClass}>{entry.sqft !== null ? num(entry.sqft, 0) : <span className="text-slate-400">{dash}</span>}</td>
                    <td className={tdNumClass}>
                      {entry.per_sqft !== null ? perSqft(entry.per_sqft) : <span className="text-slate-400" title="no square footage recorded">{dash}</span>}
                    </td>
                    <td className={tdClass}>
                      {entry.in_weighting ? (
                        <Chip tone="ok">Counted</Chip>
                      ) : (
                        <span className="text-xs text-slate-500">
                          {entry.sqft === null ? 'no sq ft' : entry.completeness === 'in_progress' ? 'in progress' : entry.total <= 0 ? 'no spend' : 'excluded'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="divide-y divide-slate-200 border-y border-slate-200">
          <PerSpecLine label="Per bedroom" summary={row.per_bedroom} format={value => money(value, 0)} />
          <PerSpecLine label="Per bathroom" summary={row.per_bathroom} format={value => money(value, 0)} />
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeading title="Vendors" hint={onOpenVendor ? 'Click a vendor to open it in the Vendors tab' : undefined} />
        {row.vendors.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">No vendors in this range.</p>
        ) : (
          <>
            <BarList
              rows={vendorBars}
              format={value => money(value, 0)}
              title={row.vendors.length > 12 ? `Top 12 of ${num(row.vendors.length)} vendors` : 'Spend by vendor'}
              valueHeader="Total"
              ariaLabel="Spend by vendor"
            />
            <div className={tableWrapClass}>
              <table className={`${tableClass} min-w-[560px]`}>
                <thead className={theadClass}>
                  <tr>
                    <th className={`${thClass} ${stickyHeadClass}`}>Vendor</th>
                    <th className={thNumClass}>Bills</th>
                    <th className={thNumClass}>Total</th>
                    <th className={thNumClass}>Share</th>
                    <th className={`${thClass} w-12`}><span className="sr-only">Open</span></th>
                  </tr>
                </thead>
                <tbody className={tbodyClass}>
                  {row.vendors.map(vendor => (
                    <tr
                      key={vendor.id}
                      className={onOpenVendor ? 'cursor-pointer transition hover:bg-slate-50' : undefined}
                      onClick={onOpenVendor ? () => onOpenVendor(vendor.id) : undefined}
                    >
                      <td className={`${tdClass} ${stickyFirstColClass}`}>
                        {onOpenVendor ? (
                          <button
                            type="button"
                            onClick={event => { event.stopPropagation(); onOpenVendor(vendor.id); }}
                            className="text-left font-semibold text-slate-900 hover:underline"
                          >
                            {vendor.name}
                          </button>
                        ) : (
                          <span className="font-semibold text-slate-900">{vendor.name}</span>
                        )}
                      </td>
                      <td className={tdNumClass}>{num(vendor.bills)}</td>
                      <td className={tdNumClass}>{money(vendor.total, 0)}</td>
                      <td className={tdNumClass}>{pct(vendor.share)}</td>
                      <td className={tdClass}>
                        {onOpenVendor && <ChevronRight className="h-4 w-4 text-slate-400" aria-hidden="true" />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeading title="By year" hint="Calendar years of the bill date, inside the active range" />
        <BarList
          rows={yearBars}
          format={value => money(value, 0)}
          title="Spend by year"
          valueHeader="Total"
          ariaLabel="Spend by year"
          showShare={false}
          emptyText="No bills in this range."
        />
      </section>

      {row.is_trade && (
        <section className="space-y-3">
          <SectionHeading
            title="Vendor-years behind the implied rate"
            hint="Complete calendar years with 4+ bills over 8+ weeks; each counts as one 2,080-hour year"
          />
          {row.vendor_rates.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">
              {row.implied_hourly_reason ? humanize(row.implied_hourly_reason) : 'No vendor in this category has a complete qualifying year yet.'}
            </p>
          ) : (
            <div className={tableWrapClass}>
              <table className={`${tableClass} min-w-[600px]`}>
                <thead className={theadClass}>
                  <tr>
                    <th className={`${thClass} ${stickyHeadClass}`}>Vendor</th>
                    <th className={thNumClass}>Year</th>
                    <th className={thNumClass}>Bills</th>
                    <th className={thNumClass}>Total</th>
                    <th className={thNumClass}>{detail?.labels.full_year ?? 'Implied $/hr (÷2,080)'}</th>
                  </tr>
                </thead>
                <tbody className={tbodyClass}>
                  {row.vendor_rates.map(entry => (
                    <tr key={`${entry.group_key}:${entry.year}`}>
                      <td className={`${tdClass} ${stickyFirstColClass}`}>
                        {onOpenVendor ? (
                          <button type="button" onClick={() => onOpenVendor(entry.vendor_id)} className="text-left font-semibold text-slate-900 hover:underline">
                            {entry.vendor}
                          </button>
                        ) : (
                          <span className="font-semibold text-slate-900">{entry.vendor}</span>
                        )}
                      </td>
                      <td className={tdNumClass}>{entry.year}</td>
                      <td className={tdNumClass}>{num(entry.bills)}</td>
                      <td className={tdNumClass}>{money(entry.total, 0)}</td>
                      <td className={tdNumClass}>{rate(entry.hourly)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <RateCaption />
        </section>
      )}

      <section className="space-y-3">
        <SectionHeading title="Materials in this category" hint="Line items read off invoices whose bill falls in this category" />
        {!detail ? (
          <InlineSpinner label="Loading materials..." />
        ) : families.length === 0 && jobCosts.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            No priced line items yet. Read the invoices on the Documents tab, or add a price on the Materials tab.
          </p>
        ) : (
          <>
            {families.length > 0 && (
              <div className={tableWrapClass}>
                <table className={`${tableClass} min-w-[820px]`}>
                  <thead className={theadClass}>
                    <tr>
                      <th className={`${thClass} ${stickyHeadClass}`}>Material</th>
                      <th className={thClass}>Family</th>
                      <th className={thClass}>Unit</th>
                      <th className={thNumClass}>Lines</th>
                      <th className={thNumClass}>Avg unit price</th>
                      <th className={thNumClass}>Median</th>
                      <th className={thNumClass}>Min – max</th>
                      <th className={thNumClass}>Total</th>
                    </tr>
                  </thead>
                  <tbody className={tbodyClass}>
                    {families.flatMap(family => family.types.map(type => (
                      <tr key={`${family.family}:${type.material_type}:${type.spec ?? ''}`}>
                        <td className={`${tdClass} ${stickyFirstColClass}`}>
                          <span className="font-semibold text-slate-900">{type.material_type_label || humanize(type.material_type)}</span>
                          {type.spec && <span className="block text-xs text-slate-500">{type.spec}</span>}
                        </td>
                        <td className={tdClass}>{humanize(family.family)}</td>
                        <td className={tdClass}>{type.dominant_unit || dash}</td>
                        <td className={tdNumClass}>
                          {num(type.n_items)}
                          {type.n_manual > 0 && <span className="block text-xs text-slate-500">{num(type.n_manual)} manual</span>}
                        </td>
                        <td className={`${tdNumClass} font-semibold text-slate-900`}>{money(type.avg_unit_price)}</td>
                        <td className={tdNumClass}>{money(type.median_unit_price)}</td>
                        <td className={tdNumClass}>{money(type.min_unit_price)} – {money(type.max_unit_price)}</td>
                        <td className={tdNumClass}>{money(type.total_spend, 0)}</td>
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
            )}
            {jobCosts.length > 0 && (
              <div className={tableWrapClass}>
                <table className={`${tableClass} min-w-[760px]`}>
                  <thead className={theadClass}>
                    <tr>
                      <th className={`${thClass} ${stickyHeadClass}`}>Job cost</th>
                      <th className={thClass}>Phase</th>
                      <th className={thNumClass}>Jobs</th>
                      <th className={thNumClass}>Avg job</th>
                      <th className={thNumClass}>Median</th>
                      <th className={thNumClass}>Min – max</th>
                      <th className={thNumClass}>Total</th>
                    </tr>
                  </thead>
                  <tbody className={tbodyClass}>
                    {jobCosts.map(group => (
                      <tr key={group.group_key}>
                        <td className={`${tdClass} ${stickyFirstColClass} font-semibold text-slate-900`}>{group.label}</td>
                        <td className={tdClass}>{group.phase === 'n_a' ? dash : humanize(group.phase)}</td>
                        <td className={tdNumClass}>
                          {num(group.n_jobs)}
                          {group.n_manual > 0 && <span className="block text-xs text-slate-500">{num(group.n_manual)} manual</span>}
                        </td>
                        <td className={`${tdNumClass} font-semibold text-slate-900`}>{money(group.avg_line_total, 0)}</td>
                        <td className={tdNumClass}>{money(group.median_line_total, 0)}</td>
                        <td className={tdNumClass}>{money(group.min_line_total, 0)} – {money(group.max_line_total, 0)}</td>
                        <td className={tdNumClass}>{money(group.total, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      {detail && detail.bills.length > 0 && (
        <details className="group rounded-md border border-slate-200 bg-white">
          <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-slate-800">
            <span>Bills in this category ({num(detail.bills.length)}{detail.bills.length >= 500 ? ', newest 500' : ''})</span>
            <ChevronDown className="h-4 w-4 text-slate-400 transition group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="overflow-x-auto border-t border-slate-200">
            <table className={`${tableClass} min-w-[820px]`}>
              <thead className={theadClass}>
                <tr>
                  <th className={thClass}>Date</th>
                  <th className={thClass}>Vendor</th>
                  <th className={thClass}>Project</th>
                  <th className={thClass}>Note</th>
                  <th className={thClass}>Source</th>
                  <th className={thNumClass}>In category</th>
                  <th className={thNumClass}>Bill total</th>
                  <th className={thClass}>Invoice</th>
                </tr>
              </thead>
              <tbody className={tbodyClass}>
                {detail.bills.map(bill => (
                  <tr key={bill.qbo_id}>
                    <td className={`${tdClass} whitespace-nowrap`}>{formatDate(bill.txn_date)}</td>
                    <td className={tdClass}>
                      {onOpenVendor ? (
                        <button type="button" onClick={() => onOpenVendor(bill.vendor_id)} className="text-left text-slate-900 hover:underline">{bill.vendor_name}</button>
                      ) : bill.vendor_name}
                    </td>
                    <td className={tdClass}>{bill.class_name || dash}</td>
                    <td className={`${tdClass} max-w-[16rem] truncate text-slate-600`} title={bill.private_note ?? undefined}>{bill.private_note || dash}</td>
                    <td className={tdClass}>
                      <span className="text-xs text-slate-500" title={bill.effective_category.rationale ?? undefined}>
                        {bill.effective_category.source}
                        {bill.effective_category.keyword ? ` · "${bill.effective_category.keyword}"` : ''}
                      </span>
                    </td>
                    <td className={tdNumClass}>{money(bill.amount)}</td>
                    <td className={tdNumClass}>{money(bill.total_amt)}</td>
                    <td className={tdClass}>
                      {bill.attachments.length === 0 ? (
                        <span className="text-slate-400">{dash}</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {bill.attachments.map(attachment => (
                            <a
                              key={attachment.id}
                              href={attachment.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={event => { event.preventDefault(); void openAttachment(attachment.url); }}
                              className="text-xs text-slate-700 underline hover:text-slate-950"
                              title={attachment.original_name ?? undefined}
                            >
                              {attachment.document_status === 'extracted' ? 'Read' : 'Open'}
                            </a>
                          ))}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
