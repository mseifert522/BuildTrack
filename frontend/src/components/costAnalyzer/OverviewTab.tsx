import { useMemo } from 'react';
import { BarChart3, Building2, Calculator, ChevronRight, FileText, ScanLine, Users } from 'lucide-react';

import {
  SPEND_TYPES,
  SPEND_TYPE_LABELS,
  dash,
  filtersActive,
  formatDateTime,
  money,
  num,
  pct,
  rate,
} from '../../lib/costAnalyzerApi';
import type { CostAnalyzerFilters, OverviewCategory, OverviewResponse, RateLabels, TopVendorRow } from '../../lib/costAnalyzerApi';
import {
  BarList,
  Chip,
  EmptyState,
  RateCaption,
  ReasonChip,
  SectionHeading,
  StatTile,
  StatusChip,
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
import type { BarRow, CostAnalyzerTab } from './shared';

// Overview tab (spec §7): KPI tiles, spend by category (top 12 + Other), spend by
// type, top vendors with the owner's implied $/hr, and the documents strip. The
// page owns the /overview request; this component only renders it.

type OverviewTabProps = {
  filters: CostAnalyzerFilters;
  canEdit: boolean;
  onOpenVendor?: (vendorId: string) => void;
  overview: OverviewResponse | null;
  onGoToTab: (tab: CostAnalyzerTab) => void;
};

// Categorical hues are never cycled: past 12 rows the tail folds into "Other".
const TOP_CATEGORIES = 12;

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function categoryBarRows(categories: OverviewCategory[], onClick: () => void): BarRow[] {
  const sorted = [...categories].sort((a, b) => b.total - a.total);
  const top = sorted.slice(0, TOP_CATEGORIES);
  const rest = sorted.slice(TOP_CATEGORIES);
  const rows: BarRow[] = top.map(category => ({
    key: category.id,
    label: category.name,
    value: category.total,
    sublabel: `${num(category.vendor_count)} ${category.vendor_count === 1 ? 'vendor' : 'vendors'}${category.share !== null ? ` · ${pct(category.share)}` : ''}`,
    onClick,
  }));
  if (rest.length > 0) {
    rows.push({
      key: '__other__',
      label: 'Other',
      value: roundCents(rest.reduce((acc, category) => acc + category.total, 0)),
      sublabel: `${rest.length} more ${rest.length === 1 ? 'category' : 'categories'}`,
      onClick,
    });
  }
  return rows;
}

/**
 * Headline rate cell: the ÷2,080 figure when a complete year exists, else the
 * latest annualized rate clearly labelled, else a dash with the reason.
 */
function HeadlineRate({ vendor, labels }: { vendor: TopVendorRow; labels: RateLabels }) {
  if (vendor.headline_hourly !== null) {
    return (
      <span title={labels.full_year}>
        {rate(vendor.headline_hourly)}
        <span className="ml-1 text-xs font-normal text-slate-400">implied</span>
      </span>
    );
  }
  const fallback = vendor.latest_annualized;
  if (fallback && fallback.hourly_annualized !== null) {
    return (
      <span className="inline-flex flex-col items-end gap-0.5">
        <span title={fallback.label || labels.annualized}>{rate(fallback.hourly_annualized)}</span>
        <Chip tone="neutral" title={fallback.label || labels.annualized}>
          {fallback.status === 'ytd' ? 'annualized YTD' : `annualized ${fallback.year}`}
        </Chip>
      </span>
    );
  }
  return <ReasonChip reason={vendor.headline_hourly_reason} />;
}

export default function OverviewTab({ filters, canEdit, onOpenVendor, overview, onGoToTab }: OverviewTabProps) {
  const categoryRows = useMemo(
    () => categoryBarRows(overview?.categories ?? [], () => onGoToTab('categories')),
    [overview, onGoToTab],
  );

  if (!overview) {
    return (
      <EmptyState
        title="Nothing loaded yet"
        message="The overview has not loaded. Use Refresh to try again."
        icon={BarChart3}
      />
    );
  }

  const { totals, documents, spend_by_type: spendByType, top_vendors: topVendors, last_scan: lastScan, labels } = overview;
  const scoped = filtersActive(filters);
  const scopeHint = scoped ? 'in the selected range' : 'all time';
  const classesMissingSqft = Math.max(0, totals.classes - totals.classes_with_sqft);
  const documentsUnread = documents.pending + documents.running;
  const documentsProblem = documents.failed + documents.unreadable + documents.skipped;

  const openVendor = (vendor: TopVendorRow) => {
    if (onOpenVendor) onOpenVendor(vendor.id);
    else onGoToTab('vendors');
  };

  return (
    <div className="space-y-6">
      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile
          label="Total spend"
          value={money(totals.spend, 0)}
          hint={`${num(totals.bills)} ${totals.bills === 1 ? 'bill' : 'bills'} · ${scopeHint}`}
          icon={Calculator}
        />
        <StatTile
          label="Bills"
          value={num(totals.bills)}
          hint={`${num(totals.vendors)} ${totals.vendors === 1 ? 'vendor' : 'vendors'} billed`}
          icon={FileText}
        />
        <StatTile
          label="Vendors categorized"
          value={`${num(totals.vendors_categorized)} / ${num(totals.vendors)}`}
          hint={totals.vendors_needing_review > 0 ? `${num(totals.vendors_needing_review)} need review` : totals.vendors > 0 ? 'All reviewed' : 'No vendors in range'}
          tone={totals.vendors_needing_review > 0 ? 'warn' : totals.vendors > 0 ? 'ok' : 'neutral'}
          icon={Users}
          onClick={() => onGoToTab('vendors')}
        />
        <StatTile
          label="Projects with sq ft"
          value={`${num(totals.classes_with_sqft)} / ${num(totals.classes)}`}
          hint={classesMissingSqft > 0 ? `${num(classesMissingSqft)} missing square footage` : totals.classes > 0 ? 'Square footage recorded' : 'No projects in range'}
          tone={classesMissingSqft > 0 ? 'warn' : totals.classes > 0 ? 'ok' : 'neutral'}
          icon={Building2}
          onClick={() => onGoToTab('projects')}
        />
        <StatTile
          label="Documents read"
          value={`${num(documents.extracted)} / ${num(documents.attachments)}`}
          hint={
            documentsProblem > 0
              ? `${num(documentsProblem)} need attention · ${num(documentsUnread)} unread`
              : documentsUnread > 0
                ? `${num(documentsUnread)} unread`
                : documents.attachments > 0 ? 'All attachments processed' : 'No attachments yet'
          }
          tone={documentsProblem > 0 ? 'warn' : documentsUnread > 0 ? 'neutral' : documents.attachments > 0 ? 'ok' : 'neutral'}
          icon={ScanLine}
          onClick={() => onGoToTab('documents')}
        />
      </div>

      {/* Spend by category + spend by type */}
      <div className="grid gap-4 lg:grid-cols-3">
        <section className={`${cardClass} space-y-4 lg:col-span-2`}>
          <SectionHeading
            title="Spend by category"
            hint="Effective bill categories (manual > AI > keyword > vendor)."
            action={
              <button type="button" className="inline-flex items-center gap-1 text-sm font-semibold text-slate-700 hover:text-slate-950 hover:underline" onClick={() => onGoToTab('categories')}>
                All categories
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            }
          />
          <BarList
            rows={categoryRows}
            format={value => money(value, 0)}
            valueHeader="Total"
            ariaLabel="Spend by category"
            emptyText="No bills in this range."
          />
        </section>

        <section className={`${cardClass} space-y-4`}>
          <SectionHeading title="Spend by type" hint="From the QuickBooks expense account on each bill line." />
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-1">
            {SPEND_TYPES.map(type => {
              const value = spendByType[type] ?? 0;
              return (
                <div key={type}>
                  <dt className={labelClass}>{SPEND_TYPE_LABELS[type]}</dt>
                  <dd className="mt-1 flex flex-wrap items-baseline gap-x-2">
                    <span className="text-xl font-bold proportional-nums text-slate-900">{money(value, 0)}</span>
                    <span className="text-xs text-slate-500">{totals.spend > 0 ? pct(value / totals.spend) : dash}</span>
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      </div>

      {/* Top vendors */}
      <section className="space-y-3">
        <SectionHeading
          title="Top vendors"
          hint="By total billed in the selected range. Rates use every bill of the vendor, whatever the range."
          action={
            <button type="button" className="inline-flex items-center gap-1 text-sm font-semibold text-slate-700 hover:text-slate-950 hover:underline" onClick={() => onGoToTab('vendors')}>
              All vendors
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          }
        />
        {topVendors.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">No vendor bills in this range.</p>
        ) : (
          <div className={tableWrapClass}>
            <table className={`${tableClass} min-w-[760px]`}>
              <thead className={theadClass}>
                <tr>
                  <th className={`${thClass} sticky left-0 z-10 bg-slate-50`}>Vendor</th>
                  <th className={thClass}>Category</th>
                  <th className={thNumClass}>Bills</th>
                  <th className={thNumClass}>Total</th>
                  <th className={thNumClass}>{labels.full_year}</th>
                  <th className={thClass}>Review</th>
                </tr>
              </thead>
              <tbody className={tbodyClass}>
                {topVendors.map(vendor => (
                  <tr key={vendor.id} className="hover:bg-slate-50">
                    <td className={`${tdClass} ${stickyFirstColClass}`}>
                      <button
                        type="button"
                        className="text-left font-semibold text-slate-900 hover:underline"
                        onClick={() => openVendor(vendor)}
                      >
                        {vendor.vendor_name}
                      </button>
                    </td>
                    <td className={tdClass}>
                      <span className="text-slate-800">{vendor.category.name}</span>
                      <span className="block text-xs text-slate-500">{vendor.category.kind}</span>
                    </td>
                    <td className={tdNumClass}>{num(vendor.bill_count)}</td>
                    <td className={tdNumClass}>{money(vendor.total, 0)}</td>
                    <td className={tdNumClass}><HeadlineRate vendor={vendor} labels={labels} /></td>
                    <td className={tdClass}>
                      {vendor.needs_review ? <Chip tone="warn">Needs review</Chip> : <span className="text-slate-400">{dash}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <RateCaption />
      </section>

      {/* Documents strip */}
      <section className={`${cardClass} space-y-3`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <h2 className="text-sm font-bold uppercase text-slate-700">Documents</h2>
            {documents.extracted === 0 ? (
              <p className="text-sm text-slate-700">
                No invoices have been read yet.{' '}
                {canEdit ? 'Run a scan from the Documents tab to start pricing materials.' : 'Ask an operations manager to run the scan.'}
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                <Chip tone="ok">{num(documents.extracted)} extracted</Chip>
                {documents.pending > 0 && <Chip tone="neutral">{num(documents.pending)} pending</Chip>}
                {documents.running > 0 && <Chip tone="ai">{num(documents.running)} running</Chip>}
                {documents.failed > 0 && <Chip tone="error">{num(documents.failed)} failed</Chip>}
                {documents.unreadable > 0 && <Chip tone="warn">{num(documents.unreadable)} unreadable</Chip>}
                {documents.skipped > 0 && <Chip tone="warn">{num(documents.skipped)} skipped</Chip>}
                {documents.duplicate > 0 && <Chip tone="neutral">{num(documents.duplicate)} duplicate</Chip>}
                {documents.needs_review_items > 0 && <Chip tone="warn">{num(documents.needs_review_items)} items need a price</Chip>}
              </div>
            )}
            <p className="text-xs text-slate-500">
              {num(documents.attachments)} attachments on QuickBooks bills · {num(documents.rows)} queued for reading · documents are not filtered by date.
            </p>
            {lastScan && (
              <p className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span>Last scan</span>
                <StatusChip status={lastScan.status} />
                <span>{num(lastScan.done)} / {num(lastScan.total)} documents · started {formatDateTime(lastScan.started_at)}</span>
                {lastScan.error && <span className="text-rose-700">{lastScan.error}</span>}
              </p>
            )}
          </div>
          <button type="button" className={secondaryButton} onClick={() => onGoToTab('documents')}>
            Open Documents
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </section>

      {overview.warnings.length > 0 && (
        <details className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm">
          <summary className="cursor-pointer font-semibold text-slate-700">
            {num(overview.warnings.length)} data {overview.warnings.length === 1 ? 'warning' : 'warnings'}
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-600">
            {overview.warnings.slice(0, 20).map((warning, index) => (
              <li key={`${warning.kind}-${warning.qbo_bill_id ?? ''}-${warning.line_id ?? ''}-${index}`}>{warning.message}</li>
            ))}
            {overview.warnings.length > 20 && <li>{num(overview.warnings.length - 20)} more…</li>}
          </ul>
        </details>
      )}
    </div>
  );
}
