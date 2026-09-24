import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, Dispatch, FormEvent, ReactNode, SetStateAction } from 'react';
import { ChevronDown, ChevronRight, Copy, ExternalLink, Package, Plus, RefreshCw, ScanLine } from 'lucide-react';
import toast from 'react-hot-toast';

import { Modal } from '../ui';
import {
  ITEM_KINDS,
  MATERIAL_FAMILIES,
  PHASES,
  UNITS,
  buildFilterQuery,
  createMaterialItem,
  dash,
  formatDate,
  formatDateTime,
  getMaterials,
  humanize,
  money,
  num,
  perSqft,
  setMaterialTarget,
  startScan,
} from '../../lib/costAnalyzerApi';
import type {
  CostAnalyzerFilters,
  CoverageTarget,
  ItemKind,
  ItemSample,
  JobCostGroup,
  MaterialFamilyGroup,
  MaterialItemInput,
  MaterialTypeGroup,
  MaterialsResponse,
  Phase,
  TargetStatusValue,
  UnknownItem,
} from '../../lib/costAnalyzerApi';
import {
  Chip,
  EmptyState,
  InlineSpinner,
  SectionHeading,
  StatusChip,
  apiError,
  cardClass,
  fieldClass,
  labelClass,
  primaryButton,
  secondaryButton,
  stickyFirstColClass,
  tableClass,
  tableWrapClass,
  tbodyClass,
  tdClass,
  tdNumClass,
  textAreaClass,
  thClass,
  thNumClass,
  theadClass,
} from './shared';
import { openAttachment } from './DocumentsTab';

// Materials tab (spec §7 / §4.5): the owner's 12 cost targets, unit prices by
// material family and type, lump-sum job costs, and the "Unknown - needs your
// input" list. Every number here comes from a line on an invoice (or one the
// owner typed in); nothing is estimated.

export type MaterialsTabProps = {
  filters: CostAnalyzerFilters;
  canEdit: boolean;
  onOpenVendor?: (vendorId: string) => void;
};

// ── Static lookups ──────────────────────────────────────────────────────────

/** Canonical material type ids (spec §2.2) offered as suggestions in the Add price form. */
const MATERIAL_TYPE_IDS = [
  'interior_door', 'exterior_door', 'garage_door', 'window',
  'laminate_countertop', 'quartz_countertop', 'granite_countertop', 'butcher_block_countertop', 'cabinet',
  'lvp_flooring', 'carpet', 'hardwood_flooring', 'tile_flooring', 'floor_coating',
  'drywall_sheet', 'drywall_finish', 'batt_insulation', 'blown_insulation', 'spray_foam',
  'shingle_roof', 'metal_roof', 'roof_tear_off', 'siding_vinyl', 'siding_other', 'gutters',
  'interior_paint', 'exterior_paint', 'primer',
  'electrical_rough', 'electrical_final', 'electrical_panel', 'electrical_fixture',
  'plumbing_rough', 'plumbing_final', 'water_heater', 'plumbing_fixture', 'sewer_line',
  'furnace', 'ac_condenser', 'ductwork', 'hvac_full_system',
  'concrete_flatwork', 'driveway', 'foundation', 'demolition_job', 'dumpster',
  'lumber', 'trim_and_millwork', 'appliance', 'other',
];

/** Form defaults when the owner adds a price for one of the 12 targets (mirrors COVERAGE_TARGETS.match). */
const TARGET_DEFAULTS: Record<string, { family: string; type: string; phase: string; unit: string }> = {
  doors: { family: 'doors', type: 'interior_door', phase: 'n_a', unit: 'each' },
  countertops_laminate: { family: 'countertops', type: 'laminate_countertop', phase: 'n_a', unit: 'sqft' },
  countertops_quartz: { family: 'countertops', type: 'quartz_countertop', phase: 'n_a', unit: 'sqft' },
  flooring: { family: 'flooring', type: 'lvp_flooring', phase: 'n_a', unit: 'sqft' },
  drywall: { family: 'drywall', type: 'drywall_sheet', phase: 'n_a', unit: 'sheet' },
  roofing: { family: 'roofing', type: 'shingle_roof', phase: 'n_a', unit: 'lot' },
  painting: { family: 'paint', type: 'interior_paint', phase: 'n_a', unit: 'lot' },
  electrical_rough: { family: 'electrical', type: 'electrical_rough', phase: 'rough', unit: 'lot' },
  electrical_final: { family: 'electrical', type: 'electrical_final', phase: 'final', unit: 'lot' },
  plumbing_rough: { family: 'plumbing', type: 'plumbing_rough', phase: 'rough', unit: 'lot' },
  plumbing_final: { family: 'plumbing', type: 'plumbing_final', phase: 'final', unit: 'lot' },
  hvac: { family: 'hvac', type: 'hvac_full_system', phase: 'install', unit: 'lot' },
};

const UNIT_LABELS: Record<string, string> = {
  each: 'each', sqft: 'sq ft', lf: 'lin ft', sheet: 'sheet', gal: 'gal', hr: 'hour', day: 'day', week: 'week', lot: 'lot', ton: 'ton', yard: 'yard', other: 'unit',
};

/** Groups of the unknowns panel, in display order; kinds not listed fall into "Other". */
const UNKNOWN_GROUPS: Array<{ id: string; title: string; kinds: string[] }> = [
  { id: 'documents', title: 'Documents that could not be read', kinds: ['text_stub', 'document_unreadable', 'document_failed', 'document_skipped'] },
  { id: 'items', title: 'Lines without an amount', kinds: ['item_needs_review'] },
  { id: 'totals', title: 'Document totals that do not match the bill', kinds: ['totals_mismatch'] },
  { id: 'targets', title: 'Owner targets with no price yet', kinds: ['target_empty'] },
  { id: 'ledger', title: 'Bill lines to check in QuickBooks', kinds: ['credit_line', 'lines_mismatch'] },
];

type UnknownGroup = { id: string; title: string; entries: UnknownItem[] };

function groupUnknowns(unknowns: UnknownItem[]): UnknownGroup[] {
  const known = new Set(UNKNOWN_GROUPS.flatMap(group => group.kinds));
  const groups: UnknownGroup[] = UNKNOWN_GROUPS.map(group => ({
    id: group.id,
    title: group.title,
    entries: unknowns.filter(entry => group.kinds.includes(entry.kind)),
  }));
  groups.push({ id: 'other', title: 'Other', entries: unknowns.filter(entry => !known.has(entry.kind)) });
  return groups.filter(group => group.entries.length > 0);
}

// ── Formatting helpers ──────────────────────────────────────────────────────

function unitLabel(unit: string | null | undefined): string {
  if (!unit) return dash;
  return UNIT_LABELS[unit] || unit;
}

function phaseLabel(phase: string | null | undefined): string {
  if (!phase || phase === 'n_a') return 'No phase';
  return humanize(phase);
}

function range(min: number | null, max: number | null, digits: 0 | 2 = 2): string {
  if (min === null && max === null) return dash;
  if (min !== null && max !== null && min === max) return money(min, digits);
  return `${money(min, digits)} – ${money(max, digits)}`;
}

function attachmentUrlFor(entry: UnknownItem): string | null {
  // Text stubs are download-link files, not documents: never offer to open them.
  if (entry.kind === 'text_stub' || !entry.attachment_id || !entry.qbo_bill_id) return null;
  return `/api/quickbooks/bills/${encodeURIComponent(entry.qbo_bill_id)}/attachments/${encodeURIComponent(entry.attachment_id)}?inline=1`;
}

/** Plain-text list the owner can paste back with answers. */
function summaryLine(entry: UnknownItem): string {
  if (entry.kind === 'target_empty') return `${entry.label || entry.target || 'target'}: ${entry.message}. Typical cost (with unit): ____`;
  if (entry.kind === 'item_needs_review') return `${entry.message}. Amount: $____`;
  return entry.message;
}

function summaryFor(unknowns: UnknownItem[]): string {
  const lines: string[] = [`Cost Analyzer - unknowns needing input (${new Date().toLocaleDateString()})`, ''];
  for (const group of groupUnknowns(unknowns)) {
    lines.push(`${group.title} (${group.entries.length})`);
    for (const entry of group.entries) lines.push(`- ${summaryLine(entry)}`);
    lines.push('');
  }
  if (lines.length === 2) lines.push('Nothing is waiting on your input.');
  return `${lines.join('\n').trimEnd()}\n`;
}

function parseOptionalNumber(text: string): number | null | undefined {
  const cleaned = text.replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

function toggleIn(setter: Dispatch<SetStateAction<Set<string>>>, key: string) {
  setter(previous => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
}

// ── Sample chips ────────────────────────────────────────────────────────────

const sampleChipBase = 'inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset';
const sampleChipLink = `${sampleChipBase} bg-slate-100 text-slate-700 ring-slate-200 hover:bg-slate-200 hover:text-slate-950`;
const sampleChipStatic = `${sampleChipBase} bg-white text-slate-600 ring-slate-200`;

function sampleTitle(sample: ItemSample): string {
  return [
    sample.description,
    sample.class ? `Class: ${sample.class}` : null,
    sample.quantity !== null ? `${num(sample.quantity, 2)} ${unitLabel(sample.unit)}` : null,
    sample.unit_price !== null ? `@ ${money(sample.unit_price)}` : null,
    sample.line_total !== null ? `= ${money(sample.line_total)}` : null,
    sample.qbo_bill_id ? `Bill #${sample.qbo_bill_id}` : null,
  ].filter(Boolean).join(' · ');
}

/** Up to five source lines; chips with a document open it in a new tab. */
function SampleChips({ samples }: { samples: ItemSample[] }) {
  if (samples.length === 0) return <span className="text-slate-400">{dash}</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {samples.map(sample => {
        const label = `${sample.vendor || (sample.source === 'manual' ? 'Entered by hand' : 'Unknown vendor')}${sample.date ? ` · ${formatDate(sample.date)}` : ''}`;
        const title = sampleTitle(sample);
        if (sample.attachment_url) {
          const url = sample.attachment_url;
          return (
            <a
              key={sample.item_id}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              title={`${title} — opens the source document`}
              onClick={event => { event.preventDefault(); event.stopPropagation(); void openAttachment(url); }}
              className={sampleChipLink}
            >
              <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{label}</span>
            </a>
          );
        }
        return (
          <span key={sample.item_id} title={title} className={sampleChipStatic}>
            <span className="truncate">{label}</span>
          </span>
        );
      })}
    </div>
  );
}

// ── Coverage strip ──────────────────────────────────────────────────────────

function CoverageTile({ row, canEdit, onNote }: { row: CoverageTarget; canEdit: boolean; onNote: (row: CoverageTarget) => void }) {
  const answered = row.target.status !== 'open';
  return (
    <div className={`${cardClass} flex flex-col gap-2`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-slate-900">{row.label}</p>
        <StatusChip status={row.status} title={`${row.n_items} priced line${row.n_items === 1 ? '' : 's'} (ok = 3 or more, thin = 1–2)`} />
      </div>
      <p className="text-xs text-slate-500">{row.n_unit_items} unit-priced · {row.n_job_items} job-cost</p>
      <dl className="grid grid-cols-2 gap-2 text-sm tabular-nums text-slate-900">
        <div>
          <dt className={labelClass}>Avg unit price</dt>
          <dd>{money(row.avg_unit_price)}</dd>
        </div>
        <div>
          <dt className={labelClass}>Avg job cost</dt>
          <dd>{money(row.avg_job_cost, 0)}</dd>
        </div>
      </dl>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        {answered && <StatusChip status={row.target.status} title={row.target.answer || undefined} />}
        {answered && row.target.answer && (
          <span className="min-w-0 flex-1 truncate text-xs text-slate-600" title={row.target.answer}>{row.target.answer}</span>
        )}
        {canEdit && (
          <button type="button" className="ml-auto text-xs font-semibold text-amber-800 hover:underline" onClick={() => onNote(row)}>
            {answered ? 'Edit note' : 'Add note'}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Unit-price families ─────────────────────────────────────────────────────

function TypeRow({ row }: { row: MaterialTypeGroup }) {
  const rawSeen = Array.isArray(row.raw_types_seen) ? row.raw_types_seen : [];
  return (
    <tr>
      <td className={`${tdClass} ${stickyFirstColClass} min-w-[14rem]`}>
        <span className="font-semibold text-slate-900">{row.material_type_label || humanize(row.material_type)}</span>
        {row.spec && <Chip className="ml-1.5" title="Spec / grade as written on the invoice">{row.spec}</Chip>}
        {rawSeen.length > 0 && (
          <span className="block max-w-xs truncate text-xs text-slate-500" title={rawSeen.join(', ')}>
            as written: {rawSeen.slice(0, 3).join(', ')}{rawSeen.length > 3 ? '…' : ''}
          </span>
        )}
        {row.n_manual > 0 && <span className="block text-xs text-slate-500">{row.n_manual} entered by hand</span>}
      </td>
      <td className={tdClass}>{unitLabel(row.dominant_unit)}</td>
      <td className={tdNumClass}><span className="font-semibold text-slate-950">{money(row.avg_unit_price)}</span></td>
      <td className={tdNumClass}>{money(row.median_unit_price)}</td>
      <td className={tdNumClass}>{range(row.min_unit_price, row.max_unit_price)}</td>
      <td className={tdNumClass}>
        {num(row.n_items)}
        {row.n_in_dominant_unit !== row.n_items && (
          <span className="block text-xs text-slate-500">{num(row.n_in_dominant_unit)} in {unitLabel(row.dominant_unit)}</span>
        )}
      </td>
      <td className={tdNumClass}>{num(row.n_documents)}</td>
      <td className={tdNumClass}>{num(row.n_vendors)}</td>
      <td className={tdNumClass}>{money(row.total_spend, 0)}</td>
      <td className={`${tdClass} min-w-[16rem]`}><SampleChips samples={row.samples} /></td>
    </tr>
  );
}

function FamilyAccordion({ family, open, onToggle }: { family: MaterialFamilyGroup; open: boolean; onToggle: () => void }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="rounded-md border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-slate-50"
      >
        <Chevron className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-900">{humanize(family.family)}</span>
          <span className="block text-xs text-slate-500">
            {num(family.n_types)} type{family.n_types === 1 ? '' : 's'} · {num(family.n_items)} priced line{family.n_items === 1 ? '' : 's'}
          </span>
        </span>
        <span className="text-sm tabular-nums text-slate-900">{money(family.total_spend, 0)}</span>
      </button>
      {open && (
        <div className={`${tableWrapClass} border-b-0`}>
          <table className={`${tableClass} min-w-[1100px]`}>
            <thead className={theadClass}>
              <tr>
                <th className={`${thClass} sticky left-0 z-10 bg-slate-50`}>Type</th>
                <th className={thClass}>Unit</th>
                <th className={thNumClass}>Avg unit price</th>
                <th className={thNumClass}>Median</th>
                <th className={thNumClass}>Min – max</th>
                <th className={thNumClass}>Lines</th>
                <th className={thNumClass}>Docs</th>
                <th className={thNumClass}>Vendors</th>
                <th className={thNumClass}>Spend</th>
                <th className={thClass}>Sources</th>
              </tr>
            </thead>
            <tbody className={tbodyClass}>
              {family.types.map(row => <TypeRow key={`${row.material_type}::${row.spec || ''}`} row={row} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Job costs ───────────────────────────────────────────────────────────────

function JobCostRows({ group, open, onToggle }: { group: JobCostGroup; open: boolean; onToggle: () => void }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer hover:bg-slate-50">
        <td className={`${tdClass} ${stickyFirstColClass} min-w-[14rem]`}>
          <button type="button" aria-expanded={open} className="flex items-center gap-1.5 text-left font-semibold text-slate-900">
            <Chevron className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
            {group.label}
          </button>
          <span className="ml-5 block text-xs text-slate-500">
            {phaseLabel(group.phase)} · {num(group.n_vendors)} vendor{group.n_vendors === 1 ? '' : 's'}{group.n_manual > 0 ? ` · ${num(group.n_manual)} by hand` : ''}
          </span>
        </td>
        <td className={tdNumClass}>{num(group.n_jobs)}</td>
        <td className={tdNumClass}><span className="font-semibold text-slate-950">{money(group.avg_line_total, 0)}</span></td>
        <td className={tdNumClass}>{money(group.median_line_total, 0)}</td>
        <td className={tdNumClass}>{range(group.min_line_total, group.max_line_total, 0)}</td>
        <td className={tdNumClass}>{money(group.total, 0)}</td>
        <td className={tdNumClass}>{num(group.n_documents)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} className="bg-slate-50 px-4 py-3">
            <div className="grid gap-4 lg:grid-cols-[1fr_minmax(0,20rem)]">
              <div>
                <p className={labelClass}>By project</p>
                {group.per_class.length === 0 ? (
                  <p className="mt-1 text-sm text-slate-500">No project could be matched to these lines.</p>
                ) : (
                  <table className={`${tableClass} mt-1`}>
                    <thead className="text-xs uppercase text-slate-500">
                      <tr>
                        <th className="py-1.5 pr-3 font-semibold">Project</th>
                        <th className="py-1.5 pr-3 text-right font-semibold">Jobs</th>
                        <th className="py-1.5 pr-3 text-right font-semibold">Total</th>
                        <th className="py-1.5 pr-3 text-right font-semibold">Sq ft</th>
                        <th className="py-1.5 pr-3 text-right font-semibold">$/sq ft</th>
                        <th className="py-1.5 font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {group.per_class.map(row => (
                        <tr key={row.class_id}>
                          <td className="py-1.5 pr-3 text-slate-800">{row.class_name}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{num(row.n)}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{money(row.total, 0)}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{num(row.sqft)}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{perSqft(row.per_sqft)}</td>
                          <td className="py-1.5"><StatusChip status={row.completeness} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div>
                <p className={labelClass}>Sources</p>
                <div className="mt-1"><SampleChips samples={group.samples} /></div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Unknowns panel ──────────────────────────────────────────────────────────

function unknownMeta(entry: UnknownItem): string {
  return [
    entry.vendor_name || null,
    entry.txn_date ? formatDate(entry.txn_date) : null,
    entry.qbo_bill_id ? `Bill #${entry.qbo_bill_id}` : null,
    typeof entry.bill_total === 'number' ? `bill ${money(entry.bill_total)}` : null,
    typeof entry.document_total === 'number' ? `document ${money(entry.document_total)}` : null,
    typeof entry.amount === 'number' ? `amount ${money(entry.amount)}` : null,
    typeof entry.attempts === 'number' && entry.attempts > 0 ? `${entry.attempts} attempt${entry.attempts === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
}

function unknownKey(entry: UnknownItem, index: number): string {
  return [entry.kind, entry.attachment_id, entry.item_id, entry.target, entry.line_id, entry.qbo_bill_id, index].filter(value => value !== undefined && value !== null).join(':');
}

const smallButton = 'inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';

function UnknownsPanel({
  unknowns,
  canEdit,
  rescanId,
  onCopy,
  onAddPrice,
  onTarget,
  onRescan,
}: {
  unknowns: UnknownItem[];
  canEdit: boolean;
  rescanId: string | null;
  onCopy: () => void;
  onAddPrice: (entry: UnknownItem) => void;
  onTarget: (entry: UnknownItem, status: 'answered' | 'not_applicable') => void;
  onRescan: (attachmentId: string) => void;
}) {
  const groups = useMemo(() => groupUnknowns(unknowns), [unknowns]);

  const actionsFor = (entry: UnknownItem): ReactNode[] => {
    const buttons: ReactNode[] = [];
    const url = attachmentUrlFor(entry);
    if (url) {
      buttons.push(
        <a
          key="open"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={event => { event.preventDefault(); void openAttachment(url); }}
          className={smallButton}
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          Open
        </a>,
      );
    }
    if (!canEdit) return buttons;
    if (entry.kind === 'item_needs_review' || entry.kind === 'target_empty') {
      buttons.push(
        <button key="price" type="button" className={smallButton} onClick={() => onAddPrice(entry)}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add price
        </button>,
      );
    }
    if (entry.kind === 'target_empty') {
      buttons.push(
        <button key="answered" type="button" className={smallButton} onClick={() => onTarget(entry, 'answered')}>Mark answered</button>,
        <button key="na" type="button" className={smallButton} onClick={() => onTarget(entry, 'not_applicable')}>Not applicable</button>,
      );
    }
    if ((entry.kind === 'document_failed' || entry.kind === 'document_unreadable' || entry.kind === 'document_skipped') && entry.attachment_id) {
      const id = entry.attachment_id;
      buttons.push(
        <button key="rescan" type="button" className={smallButton} disabled={rescanId !== null} onClick={() => onRescan(id)}>
          <RefreshCw className={`h-3.5 w-3.5 ${rescanId === id ? 'animate-spin' : ''}`} aria-hidden="true" />
          Rescan
        </button>,
      );
    }
    return buttons;
  };

  return (
    <section className={`${cardClass} space-y-4`}>
      <SectionHeading
        title="Unknown — needs your input"
        hint="Numbers that were not on any page. Tell us and the averages update; nothing here is estimated."
        action={
          <div className="flex items-center gap-2">
            <Chip tone={unknowns.length ? 'warn' : 'ok'}>{unknowns.length ? `${num(unknowns.length)} open` : 'All clear'}</Chip>
            <button type="button" className={secondaryButton} onClick={onCopy}>
              <Copy className="h-4 w-4" aria-hidden="true" />
              Copy summary
            </button>
          </div>
        }
      />
      {groups.length === 0 ? (
        <p className="py-4 text-sm text-slate-500">Nothing is waiting on your input.</p>
      ) : (
        groups.map(group => (
          <div key={group.id}>
            <h3 className={labelClass}>{group.title} · {num(group.entries.length)}</h3>
            <ul className="mt-1 divide-y divide-slate-200 border-y border-slate-200">
              {group.entries.map((entry, index) => {
                const meta = unknownMeta(entry);
                return (
                  <li key={unknownKey(entry, index)} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm text-slate-800">{entry.message}</p>
                      {meta && <p className="mt-0.5 text-xs text-slate-500">{meta}</p>}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">{actionsFor(entry)}</div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

function ResolvedDisclosure({
  resolved,
  canEdit,
  reopening,
  onReopen,
}: {
  resolved: UnknownItem[];
  canEdit: boolean;
  reopening: string | null;
  onReopen: (target: string) => void;
}) {
  if (resolved.length === 0) return null;
  return (
    <details className="rounded-md border border-slate-200 bg-white shadow-sm">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-700">
        Resolved ({num(resolved.length)})
      </summary>
      <ul className="divide-y divide-slate-200 border-t border-slate-200">
        {resolved.map((entry, index) => {
          const status = entry.target_status;
          return (
            <li key={unknownKey(entry, index)} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm text-slate-800">
                  <StatusChip status={status?.status || entry.kind.replace('target_', '')} />
                  <span>{entry.label || entry.message}</span>
                </p>
                {status?.answer && <p className="mt-0.5 text-sm text-slate-700">{status.answer}</p>}
                {status && (status.answered_by_name || status.answered_at) && (
                  <p className="mt-0.5 text-xs text-slate-500">
                    {status.answered_by_name || 'Someone'} · {formatDateTime(status.answered_at)}
                  </p>
                )}
              </div>
              {canEdit && entry.target && (
                <button type="button" className={smallButton} disabled={reopening !== null} onClick={() => onReopen(entry.target as string)}>
                  {reopening === entry.target ? 'Reopening…' : 'Reopen'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

// ── Add price form ──────────────────────────────────────────────────────────

type PriceSeed = {
  title: string;
  description: string;
  material_family: string;
  material_type: string;
  phase: string;
  unit: string;
  qbo_bill_id: string;
  attachment_id: string;
};

type PriceForm = {
  description: string;
  material_family: string;
  material_type: string;
  spec: string;
  unit: string;
  quantity: string;
  unit_price: string;
  line_total: string;
  item_kind: string;
  phase: string;
  qbo_bill_id: string;
  attachment_id: string;
  note: string;
};

function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-xs font-semibold uppercase text-slate-600">{label}</span>
      {children}
    </label>
  );
}

function AddPriceModal({ seed, onClose, onSaved }: { seed: PriceSeed; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<PriceForm>({
    description: seed.description,
    material_family: seed.material_family || 'other',
    material_type: seed.material_type,
    spec: '',
    unit: seed.unit || 'each',
    quantity: '',
    unit_price: '',
    line_total: '',
    item_kind: 'material',
    phase: seed.phase || 'n_a',
    qbo_bill_id: seed.qbo_bill_id,
    attachment_id: seed.attachment_id,
    note: '',
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const set = (key: keyof PriceForm) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const value = event.target.value;
    setForm(previous => ({ ...previous, [key]: value }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const description = form.description.trim();
    const materialType = form.material_type.trim();
    if (!description) { setFormError('Describe the line (what was bought or done).'); return; }
    if (!form.material_family) { setFormError('Pick a material family.'); return; }
    if (!materialType) { setFormError('Enter the material type.'); return; }
    if (!form.unit) { setFormError('Pick a unit (use "lot" for a lump-sum job).'); return; }
    const quantity = parseOptionalNumber(form.quantity);
    const unitPrice = parseOptionalNumber(form.unit_price);
    const lineTotal = parseOptionalNumber(form.line_total);
    if (quantity === undefined || unitPrice === undefined || lineTotal === undefined) { setFormError('Quantity and prices must be numbers.'); return; }
    if (unitPrice === null && lineTotal === null) { setFormError('Enter a unit price or a line total.'); return; }
    if (quantity !== null && quantity < 0) { setFormError('Quantity cannot be negative.'); return; }
    if (form.item_kind !== 'credit' && ((unitPrice !== null && unitPrice < 0) || (lineTotal !== null && lineTotal < 0))) {
      setFormError('Prices cannot be negative unless the line is a credit.');
      return;
    }

    const body: MaterialItemInput = {
      description,
      material_family: form.material_family,
      material_type: materialType,
      spec: form.spec.trim() || null,
      unit: form.unit,
      quantity,
      unit_price: unitPrice,
      line_total: lineTotal,
      item_kind: form.item_kind as ItemKind,
      phase: form.phase as Phase,
      note: form.note.trim() || null,
    };
    const billId = form.qbo_bill_id.trim();
    if (billId) body.qbo_bill_id = billId;
    const attachmentId = form.attachment_id.trim();
    if (attachmentId) body.attachment_id = attachmentId;

    setSaving(true);
    setFormError(null);
    try {
      await createMaterialItem(body);
      toast.success('Price saved');
      onSaved();
    } catch (err) {
      setFormError(apiError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Add a price" description={seed.title} size="lg">
      <form onSubmit={event => { void submit(event); }} className="space-y-4" noValidate>
        <Field label="Description">
          <input className={fieldClass} value={form.description} onChange={set('description')} placeholder="e.g. 6-panel interior door, hollow core" required />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Material family">
            <select className={fieldClass} value={form.material_family} onChange={set('material_family')}>
              {MATERIAL_FAMILIES.map(family => <option key={family} value={family}>{humanize(family)}</option>)}
            </select>
          </Field>
          <Field label="Material type">
            <input className={fieldClass} value={form.material_type} onChange={set('material_type')} list="cost-analyzer-material-types" placeholder="e.g. interior_door or Formica" required />
            <datalist id="cost-analyzer-material-types">
              {MATERIAL_TYPE_IDS.map(id => <option key={id} value={id}>{humanize(id)}</option>)}
            </datalist>
          </Field>
          <Field label="Spec / grade (optional)">
            <input className={fieldClass} value={form.spec} onChange={set('spec')} placeholder="e.g. quartz, 5/8 in, R-21" />
          </Field>
          <Field label="Phase">
            <select className={fieldClass} value={form.phase} onChange={set('phase')}>
              {PHASES.map(phase => <option key={phase} value={phase}>{phaseLabel(phase)}</option>)}
            </select>
          </Field>
          <Field label="Unit">
            <select className={fieldClass} value={form.unit} onChange={set('unit')}>
              {UNITS.map(unit => <option key={unit} value={unit}>{unitLabel(unit)}{unit === 'lot' ? ' (lump-sum job)' : ''}</option>)}
            </select>
          </Field>
          <Field label="Kind">
            <select className={fieldClass} value={form.item_kind} onChange={set('item_kind')}>
              {ITEM_KINDS.map(kind => <option key={kind} value={kind}>{humanize(kind)}</option>)}
            </select>
          </Field>
          <Field label="Quantity (optional)">
            <input className={fieldClass} inputMode="decimal" value={form.quantity} onChange={set('quantity')} placeholder="e.g. 12" />
          </Field>
          <Field label="Unit price">
            <input className={fieldClass} inputMode="decimal" value={form.unit_price} onChange={set('unit_price')} placeholder="$ per unit" />
          </Field>
          <Field label="Line total">
            <input className={fieldClass} inputMode="decimal" value={form.line_total} onChange={set('line_total')} placeholder="$ total (derived from quantity × unit price when blank)" />
          </Field>
          <Field label="QuickBooks bill id (optional)">
            <input className={fieldClass} value={form.qbo_bill_id} onChange={set('qbo_bill_id')} placeholder="Links the price to a bill and its project" />
          </Field>
        </div>
        <Field label="Note (optional)">
          <textarea className={textAreaClass} value={form.note} onChange={set('note')} placeholder="Where the number comes from (quote, receipt, memory)" />
        </Field>
        {form.attachment_id && <p className="text-xs text-slate-500">Linked to document {form.attachment_id}.</p>}
        {formError && <p className="text-sm text-rose-700" role="alert">{formError}</p>}
        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <button type="button" className={secondaryButton} onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className={primaryButton} disabled={saving}>{saving ? 'Saving…' : 'Save price'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ── Target answer form ──────────────────────────────────────────────────────

type TargetSeed = { target: string; label: string; status: 'answered' | 'not_applicable'; answer: string };

function TargetModal({ seed, onClose, onSaved }: { seed: TargetSeed; onClose: () => void; onSaved: () => void }) {
  const [status, setStatus] = useState<'answered' | 'not_applicable'>(seed.status);
  const [answer, setAnswer] = useState(seed.answer);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = answer.trim();
    if (status === 'answered' && !text) { setFormError('Write the answer (a typical cost, or where to find it).'); return; }
    setSaving(true);
    setFormError(null);
    try {
      const body: { status: TargetStatusValue; answer: string | null } = { status, answer: text || null };
      await setMaterialTarget(seed.target, body);
      toast.success(status === 'answered' ? 'Marked answered' : 'Marked not applicable');
      onSaved();
    } catch (err) {
      setFormError(apiError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={seed.label} description="Owner target" size="md">
      <form onSubmit={event => { void submit(event); }} className="space-y-4" noValidate>
        <Field label="Status">
          <select className={fieldClass} value={status} onChange={event => setStatus(event.target.value as 'answered' | 'not_applicable')}>
            <option value="answered">Answered</option>
            <option value="not_applicable">Not applicable</option>
          </select>
        </Field>
        <Field label={status === 'answered' ? 'Answer' : 'Note (optional)'}>
          <textarea
            className={textAreaClass}
            value={answer}
            onChange={event => setAnswer(event.target.value)}
            placeholder={status === 'answered' ? 'e.g. Interior doors run about $185 each installed (2025 quotes)' : 'Why this target does not apply'}
          />
        </Field>
        <p className="text-xs text-slate-500">A note is a reminder for the owner; it does not enter the averages. Use "Add price" for a number that should.</p>
        {formError && <p className="text-sm text-rose-700" role="alert">{formError}</p>}
        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <button type="button" className={secondaryButton} onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className={primaryButton} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ── Tab ─────────────────────────────────────────────────────────────────────

export default function MaterialsTab({ filters, canEdit }: MaterialsTabProps) {
  const query = buildFilterQuery(filters);
  // The parent may hand us a new filters object every render; refetch only when
  // the query string actually changes and read the latest object through a ref.
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  const [data, setData] = useState<MaterialsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [openFamilies, setOpenFamilies] = useState<Set<string>>(() => new Set());
  const [openJobs, setOpenJobs] = useState<Set<string>>(() => new Set());
  const [priceSeed, setPriceSeed] = useState<PriceSeed | null>(null);
  const [targetSeed, setTargetSeed] = useState<TargetSeed | null>(null);
  const [summaryText, setSummaryText] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [rescanId, setRescanId] = useState<string | null>(null);
  const [reopening, setReopening] = useState<string | null>(null);

  const refetch = useCallback(() => setReloadKey(key => key + 1), []);

  useEffect(() => {
    let cancelled = false;
    setRefreshing(true);
    setError(null);
    getMaterials(filtersRef.current)
      .then(res => {
        if (!cancelled) setData(res);
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
  }, [query, reloadKey]);

  const runScan = async () => {
    setScanBusy(true);
    try {
      await startScan({ scope: 'pending' });
      toast.success('Scan started. Progress is on the Documents tab.');
      refetch();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setScanBusy(false);
    }
  };

  const rescanDocument = async (attachmentId: string) => {
    setRescanId(attachmentId);
    try {
      await startScan({ scope: 'selected', attachment_ids: [attachmentId] });
      toast.success('Rescan queued. Progress is on the Documents tab.');
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setRescanId(null);
    }
  };

  const reopenTarget = async (target: string) => {
    setReopening(target);
    try {
      await setMaterialTarget(target, { status: 'open', answer: null });
      toast.success('Reopened');
      refetch();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setReopening(null);
    }
  };

  const copySummary = async () => {
    if (!data) return;
    const text = summaryFor(data.unknowns);
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Summary copied');
    } catch {
      setSummaryText(text);
      toast.error('Clipboard access was refused. Copy the text from the box.');
    }
  };

  const addPriceFor = (entry: UnknownItem) => {
    if (entry.kind === 'target_empty') {
      const defaults = (entry.target && TARGET_DEFAULTS[entry.target]) || { family: 'other', type: '', phase: 'n_a', unit: 'each' };
      setPriceSeed({
        title: `Owner target: ${entry.label || entry.target || ''}`,
        description: '',
        material_family: defaults.family,
        material_type: defaults.type,
        phase: defaults.phase,
        unit: defaults.unit,
        qbo_bill_id: '',
        attachment_id: '',
      });
      return;
    }
    setPriceSeed({
      title: entry.vendor_name ? `${entry.vendor_name}${entry.txn_date ? ` · ${formatDate(entry.txn_date)}` : ''}` : 'Line without an amount',
      description: entry.description || '',
      material_family: 'other',
      material_type: '',
      phase: 'n_a',
      unit: 'each',
      qbo_bill_id: entry.qbo_bill_id || '',
      attachment_id: entry.attachment_id || '',
    });
  };

  const targetActionFor = (entry: UnknownItem, status: 'answered' | 'not_applicable') => {
    if (!entry.target) return;
    setTargetSeed({ target: entry.target, label: entry.label || entry.target, status, answer: entry.target_status?.answer || '' });
  };

  const noteForTile = (row: CoverageTarget) => {
    const current = row.target.status === 'not_applicable' ? 'not_applicable' : 'answered';
    setTargetSeed({ target: row.id, label: row.label, status: current, answer: row.target.answer || '' });
  };

  if (loading) {
    return (
      <div className={cardClass}>
        <InlineSpinner label="Loading materials…" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <EmptyState
        title="Materials could not be loaded"
        message={error}
        icon={Package}
        action={<button type="button" className={secondaryButton} onClick={refetch}>Try again</button>}
      />
    );
  }

  if (!data) return null;

  const extracted = data.documents.extracted;
  const scanning = data.documents.running > 0;
  const hasItems = data.totals.n_items > 0;

  const firstRun = extracted === 0 && (
    <EmptyState
      icon={ScanLine}
      title="No invoices have been read yet"
      message={
        scanning
          ? `A scan is running: ${num(data.documents.running)} document${data.documents.running === 1 ? '' : 's'} in progress, ${num(data.documents.pending)} pending. Refresh in a minute.`
          : `${num(data.documents.attachments)} PDF and image attachments are waiting on QuickBooks bills. Reading them fills in unit prices, job costs and the owner's 12 targets.`
      }
      action={
        canEdit ? (
          <div className="flex flex-wrap justify-center gap-2">
            <button type="button" className={primaryButton} disabled={scanBusy || scanning} onClick={() => { void runScan(); }}>
              <ScanLine className="h-4 w-4" aria-hidden="true" />
              {scanBusy ? 'Starting…' : scanning ? 'Scan running' : 'Scan the attachments'}
            </button>
            <button type="button" className={secondaryButton} onClick={refetch} disabled={refreshing}>
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
              Refresh
            </button>
          </div>
        ) : (
          <p className="text-sm text-slate-500">Ask an operations manager to run the scan.</p>
        )
      }
    />
  );

  if (extracted === 0 && !hasItems) {
    return <div className="space-y-5">{firstRun}</div>;
  }

  return (
    <div className={`space-y-6 transition-opacity ${refreshing ? 'opacity-60' : ''}`}>
      {firstRun}

      {error && <p className="text-sm text-rose-700" role="alert">{error}</p>}

      <section className="space-y-3">
        <SectionHeading
          title="Owner targets"
          hint={`The 12 costs the owner asked for. ${num(data.totals.n_items)} priced lines from ${num(extracted)} documents${data.totals.n_manual_items ? ` plus ${num(data.totals.n_manual_items)} entered by hand` : ''}.`}
          action={
            <button type="button" className={secondaryButton} onClick={refetch} disabled={refreshing}>
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
              Refresh
            </button>
          }
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {data.coverage.map(row => <CoverageTile key={row.id} row={row} canEdit={canEdit} onNote={noteForTile} />)}
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeading
          title="Unit prices by material"
          hint="Lines with a quantity and a unit. Averages use the family's dominant unit; the sources open the invoice."
        />
        {data.families.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">No unit-priced lines for this selection.</p>
        ) : (
          <div className="space-y-2">
            {data.families.map(family => (
              <FamilyAccordion
                key={family.family}
                family={family}
                open={openFamilies.has(family.family)}
                onToggle={() => toggleIn(setOpenFamilies, family.family)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeading
          title="Job costs"
          hint="Lump-sum lines (roofs, painting, HVAC, rough-ins) grouped by family or trade and phase. Open a row for the per-project $/sq ft."
        />
        {data.job_costs.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">No lump-sum lines for this selection.</p>
        ) : (
          <div className={tableWrapClass}>
            <table className={`${tableClass} min-w-[900px]`}>
              <thead className={theadClass}>
                <tr>
                  <th className={`${thClass} sticky left-0 z-10 bg-slate-50`}>Job</th>
                  <th className={thNumClass}>Jobs</th>
                  <th className={thNumClass}>Avg job cost</th>
                  <th className={thNumClass}>Median</th>
                  <th className={thNumClass}>Min – max</th>
                  <th className={thNumClass}>Total</th>
                  <th className={thNumClass}>Docs</th>
                </tr>
              </thead>
              <tbody className={tbodyClass}>
                {data.job_costs.map(group => (
                  <JobCostRows
                    key={group.group_key}
                    group={group}
                    open={openJobs.has(group.group_key)}
                    onToggle={() => toggleIn(setOpenJobs, group.group_key)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <UnknownsPanel
        unknowns={data.unknowns}
        canEdit={canEdit}
        rescanId={rescanId}
        onCopy={() => { void copySummary(); }}
        onAddPrice={addPriceFor}
        onTarget={targetActionFor}
        onRescan={id => { void rescanDocument(id); }}
      />

      <ResolvedDisclosure resolved={data.resolved} canEdit={canEdit} reopening={reopening} onReopen={id => { void reopenTarget(id); }} />

      {priceSeed && (
        <AddPriceModal
          seed={priceSeed}
          onClose={() => setPriceSeed(null)}
          onSaved={() => {
            setPriceSeed(null);
            refetch();
          }}
        />
      )}

      {targetSeed && (
        <TargetModal
          seed={targetSeed}
          onClose={() => setTargetSeed(null)}
          onSaved={() => {
            setTargetSeed(null);
            refetch();
          }}
        />
      )}

      {summaryText !== null && (
        <Modal isOpen onClose={() => setSummaryText(null)} title="Unknowns summary" description="Select all and copy" size="lg">
          <textarea className={`${textAreaClass} min-h-[16rem] font-mono text-xs`} readOnly value={summaryText} onFocus={event => event.target.select()} />
        </Modal>
      )}
    </div>
  );
}
