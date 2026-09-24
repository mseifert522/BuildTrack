import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ExternalLink, FileText, RefreshCw, TriangleAlert } from 'lucide-react';
import toast from 'react-hot-toast';

import {
  CATEGORY_KIND_LABELS,
  buildFilterQuery,
  confirmVendorCategory,
  dash,
  filtersActive,
  formatDate,
  formatDateTime,
  getCategories,
  getVendorDetail,
  humanize,
  money,
  num,
  pct,
  rate,
  reasonLabel,
  setBillCategory,
  setVendorCategory,
} from '../../lib/costAnalyzerApi';
import type {
  CategoryRow,
  CostAnalyzerFilters,
  DocumentRow,
  HourlyBlock,
  MaterialItem,
  RateLabels,
  VendorBillRow,
  VendorClassRow,
  VendorDetail,
  VendorHistoryRow,
  VendorYear,
} from '../../lib/costAnalyzerApi';
import {
  BarList,
  Chip,
  Drawer,
  InlineSpinner,
  RateCaption,
  ReasonChip,
  SectionHeading,
  SourceChip,
  StatTile,
  StatusChip,
  WARN_COLOR,
  apiError,
  inlineSelectClass,
  labelClass,
  primaryButton,
  secondaryButton,
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

// Vendor drawer (spec §7, VendorsTab bullet): one vendor's category provenance,
// the owner's implied hourly benchmarks (spec §4.2), the per-year and per-class
// breakdown, bills with per-bill category overrides, the documents read from
// QuickBooks attachments and the category history. Every rate on this panel is
// "amount billed ÷ assumed hours", so a RateCaption sits under each block that
// shows one. Totals follow the page filters; hourly denominators never do.

const UNCATEGORIZED_ID = 'uncategorized';
// Owner's definition: a full-time week is 40 h (40 h × 52 wk = 2,080 h a year).
const HOURS_PER_WEEK = 40;

export type VendorDrawerProps = {
  /** Vendor selector accepted by GET /vendors/:id (row id, `qbo:<id>`, `profile:<id>`, `key:<key>`); null keeps the drawer closed. */
  vendorId: string | null;
  onClose: () => void;
  canEdit: boolean;
  filters: CostAnalyzerFilters;
  /** Called after any change persisted from the drawer so the list can refresh its row. */
  onChanged?: () => void;
};

function isActiveCategory(row: CategoryRow): boolean {
  return row.is_active === true || Number(row.is_active) === 1;
}

function categoryNameOf(names: Map<string, string>, id: string | null | undefined): string {
  if (!id) return dash;
  return names.get(id) || humanize(id);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${num(count)} ${count === 1 ? singular : pluralForm}`;
}

export default function VendorDrawer({ vendorId, onClose, canEdit, filters, onChanged }: VendorDrawerProps) {
  const [detail, setDetail] = useState<VendorDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [savingVendor, setSavingVendor] = useState(false);
  const [busyBillId, setBusyBillId] = useState<string | null>(null);
  // Monotonic request id so a slow, superseded response never overwrites a newer one.
  const requestIdRef = useRef(0);
  // Latest filters for requests fired from handlers; the effect below keeps it current
  // before the load effect runs (effects run in declaration order).
  const filtersRef = useRef(filters);
  const filterKey = buildFilterQuery(filters);
  const filtered = filtersActive(filters);

  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  const load = useCallback(async (id: string, background: boolean) => {
    const requestId = ++requestIdRef.current;
    if (!background) {
      setDetail(null);
      setError(null);
    }
    setRefreshing(true);
    try {
      const data = await getVendorDetail(id, filtersRef.current);
      if (requestId !== requestIdRef.current) return;
      setDetail(data);
      setError(null);
    } catch (err: any) {
      if (requestId !== requestIdRef.current) return;
      setError(apiError(err));
    } finally {
      if (requestId === requestIdRef.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!vendorId) {
      requestIdRef.current += 1;
      setDetail(null);
      setError(null);
      setRefreshing(false);
      return;
    }
    void load(vendorId, false);
  }, [vendorId, filterKey, load]);

  // Taxonomy for the selects and for naming history rows; loaded once per open drawer.
  useEffect(() => {
    if (!vendorId || categories.length > 0) return;
    let cancelled = false;
    getCategories()
      .then(rows => {
        if (!cancelled) setCategories(rows);
      })
      .catch(() => {
        // Selects then fall back to the names carried by the vendor itself.
      });
    return () => {
      cancelled = true;
    };
  }, [vendorId, categories.length]);

  const activeCategories = useMemo(() => categories.filter(isActiveCategory), [categories]);

  const categoryNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const row of categories) names.set(row.id, row.name);
    if (detail) {
      names.set(detail.category.id, detail.category.name);
      if (detail.category.secondary_id && detail.category.secondary_name) names.set(detail.category.secondary_id, detail.category.secondary_name);
      for (const bill of detail.bills) names.set(bill.effective_category.id, bill.effective_category.name);
    }
    return names;
  }, [categories, detail]);

  const afterChange = useCallback(async () => {
    if (vendorId) await load(vendorId, true);
    onChanged?.();
  }, [vendorId, load, onChanged]);

  const changeVendorCategory = async (categoryId: string, secondaryId: string | null) => {
    if (!detail) return;
    setSavingVendor(true);
    try {
      const result = await setVendorCategory(detail.id, {
        category_id: categoryId,
        // The backend rejects a secondary equal to the primary; drop it rather than fail.
        secondary_category_id: secondaryId && secondaryId !== categoryId ? secondaryId : null,
      });
      toast.success(`${detail.vendor_name} → ${categoryNameOf(categoryNames, categoryId)}`);
      if (result.profile_list_mismatch) {
        toast(`${detail.vendor_name} is on the ${detail.profile?.is_supplier ? 'Suppliers' : 'Contractors'} list on the Vendors page, which disagrees with this category.`);
      }
      await afterChange();
    } catch (err: any) {
      toast.error(apiError(err));
    } finally {
      setSavingVendor(false);
    }
  };

  const confirmCategory = async () => {
    if (!detail) return;
    setSavingVendor(true);
    try {
      await confirmVendorCategory(detail.id);
      toast.success(`${detail.vendor_name} confirmed as ${detail.category.name}`);
      await afterChange();
    } catch (err: any) {
      toast.error(apiError(err));
    } finally {
      setSavingVendor(false);
    }
  };

  const changeBillCategory = async (bill: VendorBillRow, categoryId: string | null) => {
    if (!detail) return;
    setBusyBillId(bill.qbo_id);
    try {
      await setBillCategory(bill.qbo_id, categoryId);
      toast.success(
        categoryId
          ? `Bill of ${formatDate(bill.txn_date)} → ${categoryNameOf(categoryNames, categoryId)}`
          : `Bill of ${formatDate(bill.txn_date)} reset to the vendor category`,
      );
      await afterChange();
    } catch (err: any) {
      toast.error(apiError(err));
    } finally {
      setBusyBillId(null);
    }
  };

  const title = detail ? detail.vendor_name : 'Vendor';
  const description = detail
    ? `${detail.category.name} · ${CATEGORY_KIND_LABELS[detail.category.kind]}${detail.qbo_vendor_id ? ` · QuickBooks vendor ${detail.qbo_vendor_id}` : ' · not linked to a QuickBooks vendor'}`
    : undefined;

  return (
    <Drawer isOpen={vendorId !== null} onClose={onClose} title={title} description={description}>
      {detail === null ? (
        error ? (
          <div className="space-y-3 py-8 text-center">
            <p className="text-sm font-semibold text-slate-800">This vendor could not be loaded.</p>
            <p className="text-sm text-slate-500">{error}</p>
            <button
              type="button"
              className={secondaryButton}
              onClick={() => {
                if (vendorId) void load(vendorId, false);
              }}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Try again
            </button>
          </div>
        ) : (
          <div className="py-10 text-center">
            <InlineSpinner label="Loading vendor…" />
          </div>
        )
      ) : (
        <div className={`space-y-6 transition-opacity ${refreshing ? 'opacity-60' : ''}`} aria-busy={refreshing ? true : undefined}>
          <CategoryPanel
            detail={detail}
            categories={activeCategories}
            canEdit={canEdit}
            saving={savingVendor}
            onChange={changeVendorCategory}
            onConfirm={confirmCategory}
          />

          <RateTiles detail={detail} filtered={filtered} />

          <BasisExplainer years={detail.years} hourly={detail.hourly} />

          <section className="space-y-3">
            <SectionHeading title="Years" hint="Calendar years of billing. The date filter never changes these denominators." />
            <YearsTable years={detail.years} labels={detail.labels} />
            <RateCaption />
          </section>

          <section className="space-y-3">
            <SectionHeading
              title="Projects"
              hint={filtered ? 'Bills in the selected range only, allocated by QuickBooks class.' : 'Every bill, allocated by QuickBooks class.'}
            />
            <ClassesSection classes={detail.classes} labels={detail.labels} hourlyReason={detail.hourly.full_year_avg_reason} />
          </section>

          <section className="space-y-3">
            <SectionHeading
              title="Bills"
              hint={`${plural(detail.bills.length, 'bill')}${
                detail.bills_elsewhere.count > 0
                  ? ` · ${plural(detail.bills_elsewhere.count, 'bill')} counted under another category (${money(detail.bills_elsewhere.total, 0)})`
                  : ''
              }`}
            />
            <BillsTable
              bills={detail.bills}
              vendorCategoryName={detail.category.name}
              canEdit={canEdit}
              categories={activeCategories}
              busyBillId={busyBillId}
              onChange={changeBillCategory}
            />
          </section>

          <section className="space-y-3">
            <SectionHeading title="Documents" hint="QuickBooks attachments on these bills, as read by the Cost Analyzer." />
            <DocumentsList documents={detail.documents} />
          </section>

          {detail.items.length > 0 && <ItemsTable items={detail.items} />}

          <section className="space-y-3">
            <SectionHeading title="Category history" />
            <HistoryTable history={detail.history} names={categoryNames} />
          </section>

          {error && (
            <p className="text-xs text-rose-700" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Drawer>
  );
}

// ── Category header ─────────────────────────────────────────────────────────

function CategoryPanel({
  detail,
  categories,
  canEdit,
  saving,
  onChange,
  onConfirm,
}: {
  detail: VendorDetail;
  categories: CategoryRow[];
  canEdit: boolean;
  saving: boolean;
  onChange: (categoryId: string, secondaryId: string | null) => void;
  onConfirm: () => void;
}) {
  const category = detail.category;
  const profile = detail.profile;
  const showConfirm = canEdit && category.row_id !== null && category.source !== 'manual';
  const hasPrimaryOption = categories.some(row => row.id === category.id);
  const secondaryOptions = categories.filter(row => row.id !== UNCATEGORIZED_ID && row.id !== category.id);
  const provenance = [
    category.set_by_name ? `Set by ${category.set_by_name}` : category.source === 'none' ? 'No category recorded yet' : 'Set automatically',
    category.set_at ? formatDateTime(category.set_at) : null,
    category.confirmed_at ? `Confirmed${category.confirmed_by_name ? ` by ${category.confirmed_by_name}` : ''} ${formatDateTime(category.confirmed_at)}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <section className="space-y-3">
      {(category.needs_owner_input || category.needs_review) && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-slate-800" role="status">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" style={{ color: WARN_COLOR }} aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-semibold">{category.needs_owner_input ? 'Needs your input' : 'Needs review'}</p>
            <p className="mt-0.5 text-slate-700">
              {category.rationale
                || (category.id === UNCATEGORIZED_ID
                  ? 'This vendor has no cost category yet, so its bills count as uncategorized.'
                  : 'This category was guessed and nobody has confirmed it yet.')}
            </p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="neutral">{category.name}</Chip>
        {category.secondary_name && <Chip tone="neutral" title="Secondary category">+ {category.secondary_name}</Chip>}
        <SourceChip source={category.source} confidence={category.confidence} title={category.rationale || undefined} />
        <span className="text-xs text-slate-500">{provenance}</span>
      </div>

      {profile && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span>
            Vendors page: {profile.category || 'no category'}
            {profile.secondary_category ? ` / ${profile.secondary_category}` : ''} · {profile.is_supplier ? 'Suppliers list' : 'Contractors list'}
          </span>
          {profile.list_mismatch && (
            <Chip tone="warn" title={`Listed as a ${profile.is_supplier ? 'supplier' : 'contractor'} on the Vendors page, but the cost category is a ${CATEGORY_KIND_LABELS[category.kind].toLowerCase()}`}>
              List mismatch
            </Chip>
          )}
        </p>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className={`${labelClass} mb-1 block`}>Category</span>
            <select
              className={inlineSelectClass}
              value={category.id}
              disabled={saving || categories.length === 0}
              aria-label={`Cost category for ${detail.vendor_name}`}
              onChange={event => onChange(event.target.value, category.secondary_id)}
            >
              {!hasPrimaryOption && <option value={category.id}>{category.name}</option>}
              {categories.map(row => (
                <option key={row.id} value={row.id}>{row.name}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={`${labelClass} mb-1 block`}>Secondary</span>
            <select
              className={inlineSelectClass}
              value={category.secondary_id ?? ''}
              disabled={saving || categories.length === 0}
              aria-label={`Secondary cost category for ${detail.vendor_name}`}
              onChange={event => onChange(category.id, event.target.value || null)}
            >
              <option value="">None</option>
              {secondaryOptions.map(row => (
                <option key={row.id} value={row.id}>{row.name}</option>
              ))}
            </select>
          </label>
          {showConfirm && (
            <button type="button" className={primaryButton} onClick={onConfirm} disabled={saving}>
              <Check className="h-4 w-4" aria-hidden="true" />
              Confirm {category.name}
            </button>
          )}
          {saving && <InlineSpinner label="Saving…" />}
        </div>
      )}
    </section>
  );
}

// ── Stat tiles ──────────────────────────────────────────────────────────────

function RateTiles({ detail, filtered }: { detail: VendorDetail; filtered: boolean }) {
  const hourly = detail.hourly;
  const latest = hourly.latest_annualized;
  const windowRate = hourly.window;
  const range = detail.first_bill ? `${formatDate(detail.first_bill)} – ${formatDate(detail.last_bill)}` : 'No dated bills';

  const totalHint = filtered && detail.in_scope_total !== detail.total
    ? `${plural(detail.bill_count, 'bill')} in this range · ${money(detail.in_scope_total, 0)} all time`
    : `${plural(detail.bill_count, 'bill')}${detail.zero_amount_bills > 0 ? ` · ${detail.zero_amount_bills} at $0 not counted` : ''}`;

  let fullYearHint: string;
  if (hourly.full_year_avg !== null) {
    fullYearHint = `Hours-weighted over ${hourly.full_year_years.join(', ')} · ${money(hourly.full_year_total, 0)} ÷ ${num(hourly.full_year_hours)} h`;
  } else if (hourly.full_year_avg_reason === 'not_a_trade') {
    fullYearHint = 'Suppliers and services have no hourly benchmark';
  } else {
    fullYearHint = 'Needs a complete calendar year with at least 4 bills over 8 weeks';
  }

  const annualizedHint = latest
    ? `${latest.status === 'ytd' ? 'Year to date' : 'Partial year'} ${latest.year} · ${num(latest.weeks_elapsed)} weeks elapsed`
    : 'No partial year to annualize';

  let docHint: string;
  if (hourly.n_docs_with_hours > 0) {
    docHint = `Measured from ${plural(hourly.n_docs_with_hours, 'document')} listing hours (${num(hourly.doc_hourly_hours, 1)} h)`;
  } else if (hourly.n_docs_with_days > 0 && hourly.doc_daily !== null) {
    docHint = `${money(hourly.doc_daily)}/day on ${plural(hourly.n_docs_with_days, 'document')} · ${rate(hourly.doc_daily_as_hourly)} at ${hourly.hours_per_day_assumed} h/day`;
  } else {
    docHint = 'No document lists hours';
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <StatTile label="Total" value={money(detail.total, 0)} hint={totalHint} />
      <StatTile label="Bills" value={num(detail.bill_count)} hint={range} />
      <StatTile
        label={hourly.full_year_label}
        implied
        value={hourly.full_year_avg !== null ? rate(hourly.full_year_avg) : <ReasonChip reason={hourly.full_year_avg_reason} />}
        hint={fullYearHint}
      />
      <StatTile
        label={latest && latest.status === 'ytd' ? 'Annualized YTD' : 'Annualized (partial year)'}
        implied
        value={latest && latest.hourly_annualized !== null ? rate(latest.hourly_annualized) : dash}
        hint={annualizedHint}
      />
      <StatTile label={hourly.label} value={rate(hourly.doc_hourly)} hint={docHint} />
      {windowRate && (
        <StatTile
          label={windowRate.label}
          implied
          value={windowRate.hourly !== null ? rate(windowRate.hourly) : <ReasonChip reason={windowRate.reason} />}
          hint={`${formatDate(windowRate.from)} – ${formatDate(windowRate.to)} · ${plural(windowRate.weeks_in_window, 'week')} · ${money(windowRate.total, 0)}`}
        />
      )}
    </div>
  );
}

// ── Explainer ───────────────────────────────────────────────────────────────

function BasisExplainer({ years, hourly }: { years: VendorYear[]; hourly: HourlyBlock }) {
  const byStatus = (status: VendorYear['status']) => years.filter(year => year.status === status).map(year => String(year.year));
  const complete = byStatus('complete');
  const ytd = byStatus('ytd');
  const partial = byStatus('partial');
  const parts: string[] = [];
  if (complete.length) parts.push(`Complete years: ${complete.join(', ')}`);
  if (ytd.length) parts.push(`Year to date: ${ytd.join(', ')}`);
  if (partial.length) parts.push(`Partial years: ${partial.join(', ')}`);

  const laborOnly = hourly.labor_only_full_year_avg !== null
    ? `Labor-only basis: ${rate(hourly.labor_only_full_year_avg)} after removing materials itemized on documents and non-trade bills (documents cover ${pct(hourly.labor_only_coverage)} of the spend in those years).`
    : `Labor-only basis is not available: ${reasonLabel(hourly.labor_only_reason) || 'no complete qualifying year'}.`;

  return (
    <div className="space-y-1.5 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
      <p className="font-semibold text-slate-700">{parts.length ? parts.join(' · ') : 'No dated bills yet.'}</p>
      <p>
        Full-year basis divides a complete calendar year by 2,080 hours (40 h × 52 wk). Partial years are annualized over the weeks elapsed.
        Active-weeks basis divides by 40 h × the weeks between the first and last bill of that year.
      </p>
      {hourly.is_trade && <p>{laborOnly}</p>}
      <RateCaption />
    </div>
  );
}

// ── Years ───────────────────────────────────────────────────────────────────

function fullYearCell(year: VendorYear) {
  if (year.hourly_full_year !== null) return rate(year.hourly_full_year);
  if (year.status === 'complete') return <ReasonChip reason={year.reason} />;
  return <span className="text-slate-400" title="Complete calendar years only">{dash}</span>;
}

function annualizedCell(year: VendorYear) {
  if (year.hourly_annualized !== null) {
    return <span title={`${money(year.total, 0)} over ${num(year.weeks_elapsed)} weeks elapsed`}>{rate(year.hourly_annualized)}</span>;
  }
  if (year.status !== 'complete') return <ReasonChip reason={year.reason} />;
  return <span className="text-slate-400" title="Complete years use the ÷2,080 basis">{dash}</span>;
}

function laborOnlyCell(year: VendorYear) {
  if (year.labor_only_hourly !== null) return rate(year.labor_only_hourly);
  if (year.status !== 'complete') return <span className="text-slate-400">{dash}</span>;
  if (year.reason) return <ReasonChip reason={year.reason} />;
  // Qualifying complete year, but too little of its spend is backed by a read document.
  return <ReasonChip reason={`documents cover ${pct(year.labor_only_coverage, 0)} (need 50%)`} />;
}

function YearsTable({ years, labels }: { years: VendorYear[]; labels: RateLabels }) {
  if (years.length === 0) {
    return <p className="py-6 text-center text-sm text-slate-500">No dated bills for this vendor.</p>;
  }
  return (
    <div className={tableWrapClass}>
      <table className={`${tableClass} min-w-[1050px]`}>
        <thead className={theadClass}>
          <tr>
            <th scope="col" className={thClass}>Year</th>
            <th scope="col" className={thClass}>Status</th>
            <th scope="col" className={thNumClass}>Bills</th>
            <th scope="col" className={thNumClass}>Total</th>
            <th scope="col" className={thClass}>First – last</th>
            <th scope="col" className={thNumClass} title="Weeks between the first and last bill of the year">Weeks</th>
            <th scope="col" className={thNumClass}>{labels.full_year}</th>
            <th scope="col" className={thNumClass}>{labels.annualized}</th>
            <th scope="col" className={thNumClass}>{labels.active_weeks}</th>
            <th scope="col" className={thNumClass} title="÷2,080 after removing materials itemized on documents and non-trade bills; needs documents covering 50% of the year">Labor-only $/hr</th>
            <th scope="col" className={thNumClass} title="Share of the year's spend backed by a read document">Documented</th>
          </tr>
        </thead>
        <tbody className={tbodyClass}>
          {years.map(year => (
            <tr key={year.year}>
              <td className={`${tdClass} font-semibold text-slate-900`}>{year.year}</td>
              <td className={tdClass}><StatusChip status={year.status} /></td>
              <td className={tdNumClass}>{num(year.bills)}</td>
              <td className={tdNumClass}>{money(year.total, 0)}</td>
              <td className={`${tdClass} whitespace-nowrap text-slate-600`}>{formatDate(year.first)} – {formatDate(year.last)}</td>
              <td className={tdNumClass} title={`${year.weeks_with_bills} distinct weeks with a bill`}>{num(year.weeks_span)}</td>
              <td className={tdNumClass}>{fullYearCell(year)}</td>
              <td className={tdNumClass}>{annualizedCell(year)}</td>
              <td className={tdNumClass}>{year.hourly_active_weeks !== null ? rate(year.hourly_active_weeks) : <ReasonChip reason={year.reason} />}</td>
              <td className={tdNumClass}>{laborOnlyCell(year)}</td>
              <td className={tdNumClass}>{pct(year.labor_only_coverage, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Classes ─────────────────────────────────────────────────────────────────

function ClassesSection({ classes, labels, hourlyReason }: { classes: VendorClassRow[]; labels: RateLabels; hourlyReason: string | null }) {
  if (classes.length === 0) {
    return <p className="py-6 text-center text-sm text-slate-500">No bills allocated to a project in this range.</p>;
  }
  return (
    <div className="space-y-4">
      <BarList
        rows={classes.map(row => ({ key: row.class_id, label: row.class_name, value: row.total, sublabel: plural(row.bills, 'bill') }))}
        format={value => money(value, 0)}
        valueHeader="Total"
        ariaLabel="Spend by project"
      />
      <div className={tableWrapClass}>
        <table className={`${tableClass} min-w-[640px]`}>
          <thead className={theadClass}>
            <tr>
              <th scope="col" className={thClass}>Project</th>
              <th scope="col" className={thNumClass}>Bills</th>
              <th scope="col" className={thNumClass}>Total</th>
              <th scope="col" className={thNumClass}>Share</th>
              <th scope="col" className={thNumClass}>{labels.hours_share}</th>
            </tr>
          </thead>
          <tbody className={tbodyClass}>
            {classes.map(row => (
              <tr key={row.class_id}>
                <td className={`${tdClass} text-slate-900`}>{row.class_name}</td>
                <td className={tdNumClass}>{num(row.bills)}</td>
                <td className={tdNumClass}>{money(row.total, 0)}</td>
                <td className={tdNumClass}>{pct(row.share)}</td>
                <td className={tdNumClass}>
                  {row.implied_hours_share !== null
                    ? `${num(row.implied_hours_share)} h · ${num(row.implied_hours_share / HOURS_PER_WEEK, 1)} wk`
                    : <ReasonChip reason={hourlyReason} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <RateCaption />
    </div>
  );
}

// ── Bills ───────────────────────────────────────────────────────────────────

function BillsTable({
  bills,
  vendorCategoryName,
  canEdit,
  categories,
  busyBillId,
  onChange,
}: {
  bills: VendorBillRow[];
  vendorCategoryName: string;
  canEdit: boolean;
  categories: CategoryRow[];
  busyBillId: string | null;
  onChange: (bill: VendorBillRow, categoryId: string | null) => void;
}) {
  if (bills.length === 0) {
    return <p className="py-6 text-center text-sm text-slate-500">No bills in this range.</p>;
  }
  const overrideOptions = categories.filter(row => row.id !== UNCATEGORIZED_ID);
  return (
    <div className={tableWrapClass}>
      <table className={`${tableClass} min-w-[960px]`}>
        <thead className={theadClass}>
          <tr>
            <th scope="col" className={thClass}>Date</th>
            <th scope="col" className={thClass}>Project</th>
            <th scope="col" className={thClass}>Note</th>
            <th scope="col" className={thNumClass}>Amount</th>
            <th scope="col" className={thClass}>Category</th>
            {canEdit && <th scope="col" className={thClass}>Override</th>}
            <th scope="col" className={thClass}>Documents</th>
          </tr>
        </thead>
        <tbody className={tbodyClass}>
          {bills.map(bill => {
            const effective = bill.effective_category;
            const busy = busyBillId === bill.qbo_id;
            // Manual and AI categories are stored rows the reset can delete; keyword hits are computed on read.
            const overridden = effective.source === 'manual' || effective.source === 'ai';
            return (
              <tr key={bill.qbo_id}>
                <td className={`${tdClass} whitespace-nowrap`}>
                  {formatDate(bill.txn_date)}
                  <span className="block text-xs text-slate-400">Bill {bill.qbo_id}</span>
                </td>
                <td className={tdClass}>
                  <span className="block max-w-[14rem] truncate" title={bill.class_name}>{bill.class_name}</span>
                  {bill.multi_class && (
                    <Chip tone="neutral" className="mt-1" title="Lines on this bill carry different classes; each line is allocated to its own class">
                      Split across projects
                    </Chip>
                  )}
                </td>
                <td className={tdClass}>
                  {bill.private_note
                    ? <span className="block max-w-[18rem] truncate text-slate-700" title={bill.private_note}>{bill.private_note}</span>
                    : <span className="text-slate-400">{dash}</span>}
                </td>
                <td className={tdNumClass}>
                  {money(bill.total_amt)}
                  {bill.zero_amount && <span className="block text-xs text-slate-400">not counted</span>}
                  {bill.lines_mismatch && (
                    <Chip tone="warn" className="mt-1" title="The bill lines do not add up to the bill total; the difference was allocated to the bill's own class">
                      Lines ≠ total
                    </Chip>
                  )}
                </td>
                <td className={tdClass}>
                  <span className="block font-medium text-slate-800">{effective.name}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <SourceChip source={effective.source} confidence={effective.confidence} title={effective.rationale || undefined} />
                    {effective.source === 'keyword' && effective.keyword && (
                      <span className="text-xs text-slate-500">matched “{effective.keyword}”</span>
                    )}
                  </span>
                </td>
                {canEdit && (
                  <td className={tdClass}>
                    <select
                      className={inlineSelectClass}
                      value={effective.source === 'manual' ? effective.id : ''}
                      disabled={busy}
                      aria-label={`Category override for the bill dated ${formatDate(bill.txn_date)}`}
                      onChange={event => onChange(bill, event.target.value || null)}
                    >
                      <option value="">Automatic (vendor or keyword rule)</option>
                      {overrideOptions.map(row => (
                        <option key={row.id} value={row.id}>{row.name}</option>
                      ))}
                    </select>
                    <span className="mt-1 flex items-center gap-2">
                      {overridden && (
                        <button
                          type="button"
                          className="text-xs font-semibold text-amber-800 hover:text-amber-950 disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={busy}
                          onClick={() => onChange(bill, null)}
                        >
                          Reset to vendor ({vendorCategoryName})
                        </button>
                      )}
                      {busy && <InlineSpinner label="Saving" />}
                    </span>
                  </td>
                )}
                <td className={tdClass}>
                  {bill.attachments.length === 0 ? (
                    <span className="text-xs text-slate-400">None</span>
                  ) : (
                    <span className="flex flex-wrap items-center gap-2">
                      {bill.attachments.map(attachment => (
                        <span key={attachment.id} className="inline-flex items-center gap-1.5">
                          <a
                            href={attachment.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={event => { event.preventDefault(); void openAttachment(attachment.url); }}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-amber-800 hover:text-amber-950"
                            title={attachment.original_name || 'Open attachment'}
                          >
                            <FileText className="h-4 w-4" aria-hidden="true" />
                            Open
                            <span className="sr-only"> {attachment.original_name || 'attachment'} in a new tab</span>
                          </a>
                          {attachment.document_status && <StatusChip status={attachment.document_status} />}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Documents ───────────────────────────────────────────────────────────────

function TotalsChip({ doc }: { doc: DocumentRow }) {
  if (doc.totals_match === true) return <Chip tone="ok">Totals match</Chip>;
  if (doc.totals_match === false) {
    if (doc.totals_match_reason === 'partial_payment') {
      return <Chip tone="neutral" title="The bill pays part of this document">Partial payment</Chip>;
    }
    return <Chip tone="warn" title="The total printed on the document differs from the bill total">Doc ≠ bill</Chip>;
  }
  return null;
}

function DocumentsList({ documents }: { documents: DocumentRow[] }) {
  if (documents.length === 0) {
    return <p className="py-6 text-center text-sm text-slate-500">No attachment on these bills has been read yet.</p>;
  }
  return (
    <ul className="divide-y divide-slate-200 border-y border-slate-200">
      {documents.map(doc => {
        const split = doc.labor_total !== null || doc.material_total !== null;
        return (
          <li key={doc.attachment_id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:gap-4">
            <div className="flex shrink-0 flex-wrap items-center gap-2 sm:w-36 sm:flex-col sm:items-start">
              <StatusChip status={doc.status} title={doc.error || undefined} />
              <TotalsChip doc={doc} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-900">
                {doc.doc_type ? humanize(doc.doc_type) : 'Document'} · {formatDate(doc.document_date || doc.txn_date)}
                {doc.labor_performed_by ? ` · labor by ${doc.labor_performed_by}` : ''}
              </p>
              {doc.summary && <p className="mt-0.5 text-xs text-slate-600">{doc.summary}</p>}
              {split && (
                <p className="mt-0.5 text-xs text-slate-500">
                  Labor {money(doc.labor_total)} · Materials {money(doc.material_total)}
                  {doc.labor_hours !== null ? ` · ${num(doc.labor_hours, 1)} h` : ''}
                  {doc.labor_days !== null ? ` · ${num(doc.labor_days, 1)} days` : ''}
                  {doc.labor_rate !== null ? ` · ${rate(doc.labor_rate)} printed` : ''}
                </p>
              )}
              {doc.error && doc.status !== 'extracted' && <p className="mt-0.5 text-xs text-rose-700">{doc.error}</p>}
              {doc.duplicate_of && (
                <p className="mt-0.5 text-xs text-slate-500">Same file as attachment {doc.duplicate_of}; its line items are counted once.</p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-3 sm:flex-col sm:items-end sm:gap-1">
              <span className="text-sm tabular-nums text-slate-900">
                {money(doc.document_total)} <span className="text-xs text-slate-500">on document</span>
              </span>
              <span className="text-xs tabular-nums text-slate-500">{money(doc.bill_total)} on bill</span>
              {doc.attachment_url && (
                <a
                  href={doc.attachment_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={event => { event.preventDefault(); void openAttachment(doc.attachment_url); }}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-amber-800 hover:text-amber-950"
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  Open
                  <span className="sr-only"> document in a new tab</span>
                </a>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ── Line items ──────────────────────────────────────────────────────────────

function ItemsTable({ items }: { items: MaterialItem[] }) {
  return (
    <details className="rounded-md border border-slate-200 bg-white">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-800">
        Extracted line items ({num(items.length)})
      </summary>
      <div className="overflow-x-auto border-t border-slate-200">
        <table className={`${tableClass} min-w-[860px]`}>
          <thead className={theadClass}>
            <tr>
              <th scope="col" className={thClass}>Description</th>
              <th scope="col" className={thClass}>Kind</th>
              <th scope="col" className={thClass}>Material</th>
              <th scope="col" className={thNumClass}>Qty</th>
              <th scope="col" className={thNumClass}>Unit price</th>
              <th scope="col" className={thNumClass}>Line total</th>
              <th scope="col" className={thNumClass}>Hours</th>
              <th scope="col" className={thClass}>Source</th>
            </tr>
          </thead>
          <tbody className={tbodyClass}>
            {items.map(item => (
              <tr key={item.id}>
                <td className={tdClass}>
                  <span className="block max-w-[20rem] truncate" title={item.description}>{item.description}</span>
                  {item.needs_review && (
                    <Chip tone="warn" className="mt-1" title={item.review_reason || undefined}>Needs review</Chip>
                  )}
                </td>
                <td className={tdClass}>{humanize(item.item_kind)}</td>
                <td className={tdClass}>
                  {item.material_family
                    ? `${humanize(item.material_family)}${item.material_type ? ` · ${humanize(item.material_type)}` : ''}`
                    : <span className="text-slate-400">{dash}</span>}
                  {item.spec && <span className="block text-xs text-slate-500">{item.spec}</span>}
                </td>
                <td className={tdNumClass}>
                  {item.quantity !== null ? `${num(item.quantity, 2)}${item.unit ? ` ${item.unit}` : ''}` : dash}
                </td>
                <td className={tdNumClass}>{money(item.unit_price)}</td>
                <td className={tdNumClass}>{money(item.line_total)}</td>
                <td className={tdNumClass}>
                  {item.hours !== null ? num(item.hours, 1) : item.days !== null ? `${num(item.days, 1)} d` : dash}
                </td>
                <td className={tdClass}><SourceChip source={item.source} confidence={item.confidence} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ── History ─────────────────────────────────────────────────────────────────

function HistoryTable({ history, names }: { history: VendorHistoryRow[]; names: Map<string, string> }) {
  if (history.length === 0) {
    return <p className="py-6 text-center text-sm text-slate-500">No category changes recorded yet.</p>;
  }
  return (
    <div className={tableWrapClass}>
      <table className={`${tableClass} min-w-[760px]`}>
        <thead className={theadClass}>
          <tr>
            <th scope="col" className={thClass}>When</th>
            <th scope="col" className={thClass}>Who</th>
            <th scope="col" className={thClass}>Change</th>
            <th scope="col" className={thClass}>Source</th>
            <th scope="col" className={thClass}>Rationale</th>
          </tr>
        </thead>
        <tbody className={tbodyClass}>
          {history.map(row => {
            const secondaryChanged = (row.from_secondary_id || row.to_secondary_id) && row.from_secondary_id !== row.to_secondary_id;
            return (
              <tr key={row.id}>
                <td className={`${tdClass} whitespace-nowrap text-slate-600`}>{formatDateTime(row.set_at)}</td>
                <td className={tdClass}>{row.set_by_name || (row.source === 'seed' ? 'Seed' : 'System')}</td>
                <td className={tdClass}>
                  <span className="text-slate-500">{row.from_category_id ? categoryNameOf(names, row.from_category_id) : 'none'}</span>
                  <span className="mx-1 text-slate-400">→</span>
                  <span className="font-medium text-slate-900">{categoryNameOf(names, row.to_category_id)}</span>
                  {secondaryChanged && (
                    <span className="block text-xs text-slate-500">
                      Secondary: {row.from_secondary_id ? categoryNameOf(names, row.from_secondary_id) : 'none'} → {row.to_secondary_id ? categoryNameOf(names, row.to_secondary_id) : 'none'}
                    </span>
                  )}
                </td>
                <td className={tdClass}><SourceChip source={row.source} confidence={row.confidence} /></td>
                <td className={tdClass}>
                  {row.rationale
                    ? <span className="block max-w-[24rem] text-xs text-slate-600">{row.rationale}</span>
                    : <span className="text-slate-400">{dash}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
