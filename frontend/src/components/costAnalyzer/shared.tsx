import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, KeyboardEvent, ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  BarChart3,
  Check,
  CheckCircle2,
  CircleAlert,
  Info,
  LoaderCircle,
  Table2,
  TriangleAlert,
} from 'lucide-react';

import { Modal } from '../ui';
import { SPEND_TYPES, buildFilterParams, buildFilterQuery, dash, num, pct, reasonLabel } from '../../lib/costAnalyzerApi';
import type { CostAnalyzerFilters, SpendType } from '../../lib/costAnalyzerApi';

// Shared building blocks for the Cost Analyzer tabs (spec §7). Visual
// conventions follow pages/HumanResources.tsx: white cards, uppercase muted
// labels, slate tables, amber-700 accents. Every rate figure shown on the page
// is the owner's *implied* benchmark (amount billed ÷ 40 h/wk), so rate tables
// must always sit next to <RateCaption />.

// ── Class strings (copied from HumanResources.tsx) ──────────────────────────

/** Dark primary action button. */
export const primaryButton =
  'inline-flex h-10 items-center justify-center gap-2 rounded-md bg-slate-900 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50';
/** Outlined secondary button. */
export const secondaryButton =
  'inline-flex h-10 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
/** Square icon-only button (36px). */
export const iconButton =
  'inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 transition hover:bg-slate-50 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-40';
/** Text input / select (40px tall). */
export const fieldClass =
  'h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-amber-600 focus:ring-2 focus:ring-amber-100';
/** Compact select for inline table cells (36px tall). */
export const inlineSelectClass =
  'h-9 max-w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-900 outline-none transition focus:border-amber-600 focus:ring-2 focus:ring-amber-100 disabled:cursor-not-allowed disabled:opacity-60';
/** Textarea. */
export const textAreaClass =
  'min-h-24 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-amber-600 focus:ring-2 focus:ring-amber-100';
/** White card. */
export const cardClass = 'rounded-md border border-slate-200 bg-white p-4 shadow-sm';
/** Uppercase muted label. */
export const labelClass = 'text-xs font-semibold uppercase text-slate-500';
/** Scroll wrapper around a table. */
export const tableWrapClass = 'overflow-x-auto border-y border-slate-200';
/** Table element. */
export const tableClass = 'w-full text-left text-sm';
/** Table head. */
export const theadClass = 'bg-slate-50 text-xs uppercase text-slate-500';
/** Header cell. */
export const thClass = 'px-4 py-3 font-semibold';
/** Numeric header cell (right-aligned). */
export const thNumClass = 'px-4 py-3 text-right font-semibold';
/** Body cell. */
export const tdClass = 'px-4 py-3 align-top';
/** Numeric body cell (right-aligned, tabular figures). */
export const tdNumClass = 'px-4 py-3 text-right tabular-nums align-top whitespace-nowrap';
/** First column pinned while the table scrolls sideways. */
export const stickyFirstColClass = 'sticky left-0 z-10 bg-white';
/** Table body. */
export const tbodyClass = 'divide-y divide-slate-200 bg-white';
/** Single-hue bar color for BarList (sequential magnitude). */
export const BAR_COLOR = '#2a78d6';
/** Warning status color (used on the icon, never on text). */
export const WARN_COLOR = '#fab219';
/** Error status color (used on the icon, never on text). */
export const ERROR_COLOR = '#d03b3b';

/** Owner-facing caption every rate table must show. */
export const RATE_CAPTION =
  "Implied rate = amount billed ÷ assumed hours (40 h/wk). It is a cost benchmark, not the contractor's wage.";

type IconComponent = ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;

/** Error text from an axios failure (`err.response.data.error`), else the message. */
export function apiError(error: unknown): string {
  const candidate = error as { response?: { data?: { error?: string } }; message?: string } | null;
  return candidate?.response?.data?.error || candidate?.message || 'Request failed';
}

// ── Layout pieces ───────────────────────────────────────────────────────────

/** Section title bar with an optional right-hand action (HR style). */
export function SectionHeading({ title, action, hint }: { title: string; action?: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
      <div className="min-w-0">
        <h2 className="text-sm font-bold uppercase text-slate-700">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

/** Tone for tiles, chips and captions. */
export type Tone = 'neutral' | 'warn' | 'error' | 'ok';

/**
 * KPI tile: sentence-case label, big proportional figure, optional hint line.
 * `implied` adds a muted "implied" suffix so a benchmark never reads as a measurement.
 */
export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
  implied = false,
  icon: Icon,
  onClick,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  implied?: boolean;
  icon?: IconComponent;
  onClick?: () => void;
}) {
  const ToneIcon = tone === 'warn' ? TriangleAlert : tone === 'error' ? CircleAlert : tone === 'ok' ? CheckCircle2 : null;
  const toneIconStyle = tone === 'warn' ? { color: WARN_COLOR } : tone === 'error' ? { color: ERROR_COLOR } : undefined;
  const toneIconClass = tone === 'ok' ? 'text-emerald-600' : '';
  const body = (
    <>
      <div className="flex items-center justify-between gap-3">
        <span className={labelClass}>{label}</span>
        {Icon && <Icon className="h-4 w-4 text-amber-700" aria-hidden="true" />}
      </div>
      <p className="mt-3 text-2xl font-bold proportional-nums text-slate-950">
        {value}
        {implied && <span className="ml-1.5 text-xs font-normal text-slate-400">implied</span>}
      </p>
      {hint && (
        <p className="mt-1 flex items-start gap-1 text-xs text-slate-500">
          {ToneIcon && <ToneIcon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${toneIconClass}`} style={toneIconStyle} aria-hidden="true" />}
          <span>{hint}</span>
        </p>
      )}
    </>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`${cardClass} block w-full text-left transition hover:border-slate-300 hover:bg-slate-50`}>
        {body}
      </button>
    );
  }
  return <div className={cardClass}>{body}</div>;
}

/** Sits under every table or tile that shows an implied rate. */
export function RateCaption({ className = '' }: { className?: string }) {
  return (
    <p className={`flex items-start gap-1.5 text-xs text-slate-500 ${className}`}>
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{RATE_CAPTION}</span>
    </p>
  );
}

/** Empty / first-run card. */
export function EmptyState({
  title,
  message,
  icon: Icon,
  action,
}: {
  title: string;
  message?: ReactNode;
  icon?: IconComponent;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-slate-300 bg-white px-4 py-12 text-center">
      {Icon && <Icon className="mb-3 h-8 w-8 text-slate-300" aria-hidden="true" />}
      <p className="text-sm font-semibold text-slate-800">{title}</p>
      {message && <p className="mt-1 max-w-md text-sm text-slate-500">{message}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Inline spinner with an optional label. */
export function InlineSpinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500" role="status">
      <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      {label}
    </span>
  );
}

/** Wide dialog for row details: Modal 2xl with a scrolling 80vh body. */
export function Drawer({
  isOpen,
  onClose,
  title,
  description,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} description={description} size="2xl" bodyClassName="max-h-[80vh] overflow-y-auto p-5">
      {children}
    </Modal>
  );
}

// ── Chips ───────────────────────────────────────────────────────────────────

/** Chip tones: provenance (ai/manual/keyword/seed) and status (warn/error/ok). */
export type ChipTone = 'neutral' | 'ai' | 'manual' | 'keyword' | 'seed' | 'warn' | 'error' | 'ok';

const CHIP_CLASSES: Record<ChipTone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  ai: 'bg-violet-50 text-violet-800 ring-violet-200',
  manual: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  keyword: 'bg-sky-50 text-sky-800 ring-sky-200',
  seed: 'bg-amber-50 text-amber-900 ring-amber-200',
  warn: 'bg-amber-50 text-slate-800 ring-[#fab219]',
  error: 'bg-rose-50 text-slate-800 ring-[#d03b3b]',
  ok: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
};

/** Small pill. Warn and error tones always carry an icon so state is never color alone. */
export function Chip({
  tone = 'neutral',
  children,
  title,
  className = '',
}: {
  tone?: ChipTone;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${CHIP_CLASSES[tone]} ${className}`}
    >
      {tone === 'warn' && <TriangleAlert className="h-3 w-3 shrink-0" style={{ color: WARN_COLOR }} aria-hidden="true" />}
      {tone === 'error' && <CircleAlert className="h-3 w-3 shrink-0" style={{ color: ERROR_COLOR }} aria-hidden="true" />}
      {tone === 'ok' && <Check className="h-3 w-3 shrink-0 text-emerald-600" aria-hidden="true" />}
      {children}
    </span>
  );
}

/** Chip tone for a vendor / bill category source. */
export function sourceTone(source: string | null | undefined): ChipTone {
  switch (source) {
    case 'manual': return 'manual';
    case 'ai': return 'ai';
    case 'keyword': return 'keyword';
    case 'seed': return 'seed';
    case 'uncategorized':
    case 'none': return 'warn';
    default: return 'neutral';
  }
}

/** Provenance chip: "AI guess 0.82", "Seed 0.95", "Manual", "Keyword", "Vendor", "Uncategorized". */
export function SourceChip({ source, confidence, title }: { source: string | null | undefined; confidence?: number | null; title?: string }) {
  const conf = typeof confidence === 'number' && Number.isFinite(confidence) ? ` ${confidence.toFixed(2)}` : '';
  let text: string;
  switch (source) {
    case 'manual': text = 'Manual'; break;
    case 'ai': text = `AI guess${conf}`; break;
    case 'keyword': text = 'Keyword'; break;
    case 'seed': text = `Seed${conf}`; break;
    case 'vendor': text = 'Vendor'; break;
    case 'uncategorized': text = 'Uncategorized'; break;
    case 'none': text = 'No category'; break;
    default: text = source ? source : 'Unknown';
  }
  return <Chip tone={sourceTone(source)} title={title}>{text}</Chip>;
}

const STATUS_CHIPS: Record<string, { tone: ChipTone; label: string }> = {
  // documents
  pending: { tone: 'neutral', label: 'Pending' },
  running: { tone: 'ai', label: 'Running' },
  extracted: { tone: 'ok', label: 'Extracted' },
  unreadable: { tone: 'warn', label: 'Unreadable' },
  failed: { tone: 'error', label: 'Failed' },
  skipped: { tone: 'warn', label: 'Skipped' },
  duplicate: { tone: 'neutral', label: 'Duplicate' },
  // classes
  complete: { tone: 'ok', label: 'Complete' },
  in_progress: { tone: 'neutral', label: 'In progress' },
  // vendor years
  ytd: { tone: 'neutral', label: 'Year to date' },
  partial: { tone: 'warn', label: 'Partial year' },
  // coverage
  ok: { tone: 'ok', label: 'OK' },
  thin: { tone: 'warn', label: 'Thin' },
  none: { tone: 'error', label: 'None' },
  // targets
  open: { tone: 'neutral', label: 'Open' },
  answered: { tone: 'ok', label: 'Answered' },
  not_applicable: { tone: 'neutral', label: 'Not applicable' },
  // scan runs
  completed: { tone: 'ok', label: 'Completed' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  // project type source
  stored: { tone: 'manual', label: 'Recorded' },
  inferred: { tone: 'neutral', label: 'Inferred' },
};

/** Status chip for document / class / year / coverage / target / scan statuses. */
export function StatusChip({ status, title }: { status: string | null | undefined; title?: string }) {
  if (!status) return <span className="text-slate-400">{dash}</span>;
  const entry = STATUS_CHIPS[status] || { tone: 'neutral' as ChipTone, label: status.replace(/_/g, ' ') };
  return <Chip tone={entry.tone} title={title}>{entry.label}</Chip>;
}

/** "dash + reason" cell for a null rate (spec §4.2 reasons). Renders the value when present. */
export function ReasonChip({ reason, tone = 'neutral' }: { reason: string | null | undefined; tone?: ChipTone }) {
  if (!reason) return <span className="text-slate-400">{dash}</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-slate-400">{dash}</span>
      <Chip tone={tone} title={reason}>{reasonLabel(reason)}</Chip>
    </span>
  );
}

// ── BarList ─────────────────────────────────────────────────────────────────

/** One row of a BarList. `value` null renders an empty bar with a dash. */
export type BarRow = {
  key?: string;
  label: string;
  value: number | null;
  sublabel?: string;
  onClick?: () => void;
};

/**
 * Horizontal single-hue bar list (one series, so no legend). Bars are decorative
 * (`aria-hidden`); the value is printed at the tip and the label stays in text ink.
 * The toggle shows the same rows as a table for screen readers and copy/paste.
 */
export function BarList({
  rows,
  max,
  format,
  title,
  valueHeader = 'Value',
  ariaLabel,
  initialView = 'bars',
  showShare = true,
  emptyText = 'Nothing to show for this selection.',
}: {
  rows: BarRow[];
  max?: number;
  format: (value: number | null) => string;
  title?: string;
  valueHeader?: string;
  ariaLabel?: string;
  initialView?: 'bars' | 'table';
  showShare?: boolean;
  emptyText?: string;
}) {
  const [view, setView] = useState<'bars' | 'table'>(initialView);
  const numeric = rows.map(row => (typeof row.value === 'number' && Number.isFinite(row.value) ? row.value : 0));
  const scale = max && max > 0 ? max : numeric.reduce((acc, value) => Math.max(acc, value), 0);
  const total = numeric.reduce((acc, value) => acc + value, 0);
  const listLabel = ariaLabel || title || 'Values';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        {title ? <p className={labelClass}>{title}</p> : <span />}
        <div className="inline-flex rounded-md border border-slate-300 bg-white" role="group" aria-label="Chart view">
          <button
            type="button"
            aria-pressed={view === 'bars'}
            onClick={() => setView('bars')}
            className={`inline-flex h-8 items-center gap-1 rounded-l-md px-2 text-xs font-semibold ${view === 'bars' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
          >
            <BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />
            Bars
          </button>
          <button
            type="button"
            aria-pressed={view === 'table'}
            onClick={() => setView('table')}
            className={`inline-flex h-8 items-center gap-1 rounded-r-md px-2 text-xs font-semibold ${view === 'table' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
          >
            <Table2 className="h-3.5 w-3.5" aria-hidden="true" />
            Table view
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">{emptyText}</p>
      ) : view === 'bars' ? (
        <ul className="space-y-0.5" aria-label={listLabel}>
          {rows.map((row, index) => {
            const value = numeric[index];
            const fraction = scale > 0 ? Math.max(0, Math.min(1, value / scale)) : 0;
            const text = format(row.value);
            const labelNode = (
              <>
                <span className="block truncate">{row.label}</span>
                {row.sublabel && <span className="block truncate text-xs text-slate-500">{row.sublabel}</span>}
              </>
            );
            return (
              <li
                key={row.key || `${row.label}-${index}`}
                className="grid grid-cols-[minmax(0,9rem)_1fr] items-center gap-3 py-0.5 sm:grid-cols-[minmax(0,14rem)_1fr]"
                title={`${row.label}: ${text}`}
              >
                {row.onClick ? (
                  <button type="button" onClick={row.onClick} className="min-w-0 text-left text-sm text-slate-700 hover:text-slate-950 hover:underline">
                    {labelNode}
                  </button>
                ) : (
                  <span className="min-w-0 text-sm text-slate-700">{labelNode}</span>
                )}
                <div className="flex min-w-0 items-center">
                  <div className="h-5 shrink-0" style={{ width: `calc((100% - 5.5rem) * ${fraction})` }} aria-hidden="true">
                    {value > 0 && <div className="h-full w-full rounded-r" style={{ backgroundColor: BAR_COLOR, minWidth: 2 }} />}
                  </div>
                  <span className="ml-2 whitespace-nowrap text-sm tabular-nums text-slate-900">{text}</span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className={tableWrapClass}>
          <table className={tableClass} aria-label={listLabel}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>Label</th>
                <th className={thNumClass}>{valueHeader}</th>
                {showShare && <th className={thNumClass}>Share</th>}
              </tr>
            </thead>
            <tbody className={tbodyClass}>
              {rows.map((row, index) => (
                <tr key={row.key || `${row.label}-${index}`}>
                  <td className={tdClass}>
                    {row.onClick ? (
                      <button type="button" onClick={row.onClick} className="text-left text-slate-800 hover:underline">{row.label}</button>
                    ) : (
                      <span className="text-slate-800">{row.label}</span>
                    )}
                    {row.sublabel && <span className="block text-xs text-slate-500">{row.sublabel}</span>}
                  </td>
                  <td className={tdNumClass}>{format(row.value)}</td>
                  {showShare && <td className={tdNumClass}>{total > 0 ? pct(numeric[index] / total) : dash}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── InlineNumber ────────────────────────────────────────────────────────────

function parseNumber(text: string): number | null | undefined {
  const cleaned = text.replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Editable numeric cell (>= 44px tall). Saves on blur or Enter, Esc cancels,
 * shows a spinner while saving and the error text when the save fails. When
 * `disabled`, renders the formatted value only. Empty input saves `null` when
 * `allowClear` is set, otherwise it reverts.
 */
export function InlineNumber({
  value,
  onSave,
  disabled = false,
  ariaLabel,
  placeholder = 'Add',
  format = next => num(next, 2),
  step,
  min,
  max,
  allowClear = false,
  className = '',
}: {
  value: number | null;
  onSave: (next: number | null) => Promise<void> | void;
  disabled?: boolean;
  ariaLabel: string;
  placeholder?: string;
  format?: (value: number | null) => string;
  step?: number | string;
  min?: number;
  max?: number;
  allowClear?: boolean;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // committingRef: one save at a time (Enter then blur must not save twice).
  // activeRef: a blur fired while the input unmounts after Enter/Esc must not save.
  const committingRef = useRef(false);
  const activeRef = useRef(false);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const begin = () => {
    if (disabled) return;
    setDraft(value === null ? '' : String(value));
    setError(null);
    activeRef.current = true;
    setEditing(true);
  };

  const cancel = () => {
    activeRef.current = false;
    committingRef.current = false;
    setEditing(false);
    setError(null);
  };

  const commit = async () => {
    if (committingRef.current || !activeRef.current) return;
    const parsed = parseNumber(draft);
    if (parsed === undefined) {
      setError('Enter a number');
      return;
    }
    if (parsed === null && !allowClear) {
      cancel();
      return;
    }
    if (parsed !== null && typeof min === 'number' && parsed < min) {
      setError(`Must be at least ${min}`);
      return;
    }
    if (parsed !== null && typeof max === 'number' && parsed > max) {
      setError(`Must be at most ${max}`);
      return;
    }
    if (parsed === value) {
      cancel();
      return;
    }
    committingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSave(parsed);
      activeRef.current = false;
      setEditing(false);
    } catch (err: any) {
      setError(apiError(err));
      // Keep the draft so the person can fix it; re-focus for a second try.
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } finally {
      setSaving(false);
      committingRef.current = false;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  };

  if (!editing) {
    if (disabled) {
      return (
        <span className={`inline-flex min-h-[44px] items-center tabular-nums text-slate-900 ${className}`}>
          {value === null ? <span className="text-slate-400">{dash}</span> : format(value)}
        </span>
      );
    }
    const empty = value === null;
    return (
      <button
        type="button"
        onClick={begin}
        aria-label={`${ariaLabel}: ${empty ? 'not set, click to add' : `${format(value)}, click to edit`}`}
        className={`inline-flex min-h-[44px] w-full min-w-[5rem] items-center justify-end rounded-md border border-transparent px-2 text-right tabular-nums transition hover:border-slate-300 hover:bg-slate-50 ${empty ? 'text-amber-800' : 'text-slate-900'} ${className}`}
      >
        {empty ? <span className="text-xs font-semibold uppercase">{placeholder}</span> : format(value)}
      </button>
    );
  }

  return (
    <span className={`inline-flex w-full flex-col items-end ${className}`}>
      <span className="relative flex w-full items-center">
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          aria-label={ariaLabel}
          aria-invalid={error ? true : undefined}
          value={draft}
          disabled={saving}
          step={step}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => { void commit(); }}
          className="h-11 w-full min-w-[6rem] rounded-md border border-slate-300 bg-white px-2 pr-7 text-right text-sm tabular-nums text-slate-900 outline-none transition focus:border-amber-600 focus:ring-2 focus:ring-amber-100 disabled:opacity-60"
        />
        {saving && <LoaderCircle className="pointer-events-none absolute right-2 h-4 w-4 animate-spin text-slate-500" aria-hidden="true" />}
      </span>
      {error && (
        <span className="mt-1 inline-flex items-center gap-1 text-xs text-rose-700" role="alert">
          <CircleAlert className="h-3 w-3" style={{ color: ERROR_COLOR }} aria-hidden="true" />
          {error}
        </span>
      )}
      {saving && <span className="sr-only" role="status">Saving</span>}
    </span>
  );
}

// ── URL-backed filters ──────────────────────────────────────────────────────

/** Tabs of the Cost Analyzer page. */
export type CostAnalyzerTab = 'overview' | 'vendors' | 'projects' | 'categories' | 'materials' | 'documents';
/** Tab ids in display order. */
export const COST_ANALYZER_TABS: CostAnalyzerTab[] = ['overview', 'vendors', 'projects', 'categories', 'materials', 'documents'];

/** Date preset ids; `year:<n>` is one option per `years_available` entry. */
export type DatePreset = 'all' | 'this_year' | 'last_12_months' | 'custom' | `year:${number}`;

/** A preset option for the filter row's `<select>`. */
export type DatePresetOption = { id: DatePreset; label: string };

function isTab(value: string | null): value is CostAnalyzerTab {
  return value !== null && (COST_ANALYZER_TABS as string[]).includes(value);
}

function isSpendType(value: string | null): value is SpendType {
  return value !== null && (SPEND_TYPES as string[]).includes(value);
}

function cleanDate(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/** Local calendar date as 'YYYY-MM-DD'. */
export function localIsoDate(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Date range of a preset (`custom` returns nulls; the caller keeps its own dates). */
export function presetRange(preset: DatePreset, now: Date = new Date()): { from: string | null; to: string | null } {
  if (preset === 'all' || preset === 'custom') return { from: null, to: null };
  if (preset === 'this_year') {
    const year = now.getFullYear();
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }
  if (preset === 'last_12_months') {
    const start = new Date(now);
    start.setFullYear(start.getFullYear() - 1);
    start.setDate(start.getDate() + 1);
    return { from: localIsoDate(start), to: localIsoDate(now) };
  }
  const year = Number(preset.slice('year:'.length));
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/** Which preset a from/to pair corresponds to (else `custom`). */
export function detectPreset(from: string | null, to: string | null, now: Date = new Date()): DatePreset {
  if (!from && !to) return 'all';
  const thisYear = presetRange('this_year', now);
  if (from === thisYear.from && to === thisYear.to) return 'this_year';
  const last12 = presetRange('last_12_months', now);
  if (from === last12.from && to === last12.to) return 'last_12_months';
  const match = from && to ? /^(\d{4})-01-01$/.exec(from) : null;
  if (match && to === `${match[1]}-12-31`) return `year:${Number(match[1])}`;
  return 'custom';
}

/** Preset options for the filter row, one per year in `years_available` (newest first). */
export function presetOptions(yearsAvailable: number[] = [], now: Date = new Date()): DatePresetOption[] {
  const thisYear = now.getFullYear();
  const options: DatePresetOption[] = [
    { id: 'all', label: 'All time' },
    { id: 'this_year', label: `This year (${thisYear})` },
    { id: 'last_12_months', label: 'Last 12 months' },
  ];
  const years = Array.from(new Set(yearsAvailable.filter(year => Number.isFinite(year) && year !== thisYear))).sort((a, b) => b - a);
  for (const year of years) options.push({ id: `year:${year}`, label: String(year) });
  options.push({ id: 'custom', label: 'Custom range' });
  return options;
}

/** What useCostAnalyzerFilters returns. */
export type CostAnalyzerFilterState = {
  tab: CostAnalyzerTab;
  setTab: (tab: CostAnalyzerTab) => void;
  /** from / to / spend_type only - pass straight to the fetchers. */
  filters: CostAnalyzerFilters;
  /** Same as filters, as the axios `params` object. */
  params: Record<string, string>;
  /** Same as filters, as a query string (no leading '?'); handy as an effect dependency. */
  query: string;
  isActive: boolean;
  preset: DatePreset;
  setPreset: (preset: DatePreset) => void;
  setRange: (from: string | null, to: string | null) => void;
  spendType: SpendType | null;
  setSpendType: (spendType: SpendType | null) => void;
  reset: () => void;
  /** "All time" / "Jan 1, 2025 - Dec 31, 2025" style text for captions. */
  rangeLabel: string;
};

/**
 * Reads and writes `?tab=&from=&to=&spend_type=` in the URL so a filtered view
 * is shareable and survives reloads. Writes replace history (no back-button spam).
 */
export function useCostAnalyzerFilters(): CostAnalyzerFilterState {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: CostAnalyzerTab = isTab(tabParam) ? tabParam : 'overview';
  const from = cleanDate(searchParams.get('from'));
  const to = cleanDate(searchParams.get('to'));
  const spendParam = searchParams.get('spend_type');
  const spendType: SpendType | null = isSpendType(spendParam) ? spendParam : null;

  const update = useCallback((patch: Record<string, string | null>) => {
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const setTab = useCallback((next: CostAnalyzerTab) => update({ tab: next }), [update]);
  const setRange = useCallback((nextFrom: string | null, nextTo: string | null) => {
    let f = cleanDate(nextFrom);
    let t = cleanDate(nextTo);
    if (f && t && f > t) [f, t] = [t, f];
    update({ from: f, to: t });
  }, [update]);
  const setPreset = useCallback((preset: DatePreset) => {
    if (preset === 'custom') return; // keep the current dates; the inputs take over
    const range = presetRange(preset);
    update({ from: range.from, to: range.to });
  }, [update]);
  const setSpendType = useCallback((next: SpendType | null) => update({ spend_type: next }), [update]);
  const reset = useCallback(() => update({ from: null, to: null, spend_type: null }), [update]);

  return useMemo(() => {
    const filters: CostAnalyzerFilters = { from, to, spend_type: spendType };
    const params = buildFilterParams(filters);
    const query = buildFilterQuery(filters);
    const preset = detectPreset(from, to);
    let rangeLabel = 'All time';
    if (from || to) {
      const fmt = (value: string | null) => (value ? new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'start');
      rangeLabel = `${fmt(from)} – ${to ? fmt(to) : 'today'}`;
    }
    return {
      tab, setTab, filters, params, query, isActive: query.length > 0, preset, setPreset, setRange,
      spendType, setSpendType, reset, rangeLabel,
    };
  }, [tab, setTab, from, to, spendType, setPreset, setRange, setSpendType, reset]);
}
