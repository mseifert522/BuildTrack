import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, MouseEvent, ReactNode } from 'react';
import { Building2, ChevronDown, ChevronRight, Download, RefreshCw, Search } from 'lucide-react';
import toast from 'react-hot-toast';

import { useAuthStore } from '../../store/authStore';
import {
  PROJECT_TYPES,
  PROJECT_TYPE_LABELS,
  SPEND_TYPES,
  SPEND_TYPE_LABELS,
  buildFilterQuery,
  dash,
  downloadCsv,
  formatDate,
  formatDateTime,
  getClassDetail,
  getClasses,
  money,
  num,
  pct,
  perSqft,
  saveClassSpecs,
} from '../../lib/costAnalyzerApi';
import type {
  ClassDetail,
  ClassRow,
  ClassSpecsInput,
  ClassesResponse,
  CostAnalyzerFilters,
  ProjectType,
} from '../../lib/costAnalyzerApi';
import {
  BarList,
  Chip,
  Drawer,
  EmptyState,
  InlineNumber,
  InlineSpinner,
  SectionHeading,
  StatTile,
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
// The attachment route is Bearer-authenticated (no cookie, no ?token=), so a plain
// link would 401: openAttachment fetches the file with the token and opens the tab.
import { openAttachment } from './DocumentsTab';

// Projects tab (spec §7 ProjectsTab): one row per QBO class (property/project)
// with the size details the owner asked for (sq ft, beds, baths, units) as
// editable cells, and the per-square-foot figures that only exist once those
// details are filled in. Every number comes from GET /classes (the allocation
// table, spec §4.3); the tab never computes money itself.
//
// Roles: upper management (`canEdit`) may set or change anything. Project
// managers may only ADD missing size details (the backend answers 403 when they
// try to change a recorded value), so their cells are enabled only while empty.

export type ProjectsTabProps = {
  filters: CostAnalyzerFilters;
  canEdit: boolean;
  onOpenVendor?: (vendorId: string) => void;
};

/** Reserved class id for allocations with no class (spec §1); it is not a project and has no specs. */
const UNASSIGNED_CLASS_ID = '__unassigned__';

/** Sticky first header cell (thead background, unlike stickyFirstColClass which is white for body cells). */
const stickyHeadClass = 'sticky left-0 z-10 bg-slate-50';

type SpecField = 'square_feet' | 'bedrooms' | 'bathrooms' | 'units';

type SpecFieldDef = {
  key: SpecField;
  label: string;
  short: string;
  min: number;
  max: number;
  step: number;
  /** Extra rule the backend enforces (spec §6) so the cell explains it before a round trip. */
  validate: (value: number) => string | null;
  format: (value: number | null) => string;
};

// Limits mirror the route validation (spec §6): sqft 100–50,000, bedrooms 0–20
// whole, bathrooms 0–20 in halves, units 1–50.
const SPEC_FIELDS: SpecFieldDef[] = [
  {
    key: 'square_feet',
    label: 'Square feet',
    short: 'Sq ft',
    min: 100,
    max: 50000,
    step: 1,
    validate: () => null,
    format: value => num(value, 0),
  },
  {
    key: 'bedrooms',
    label: 'Bedrooms',
    short: 'Beds',
    min: 0,
    max: 20,
    step: 1,
    validate: value => (Number.isInteger(value) ? null : 'Bedrooms must be a whole number'),
    format: value => num(value, 0),
  },
  {
    key: 'bathrooms',
    label: 'Bathrooms',
    short: 'Baths',
    min: 0,
    max: 20,
    step: 0.5,
    validate: value => (Number.isInteger(value * 2) ? null : 'Bathrooms go in halves (e.g. 1.5)'),
    format: value => num(value, 1),
  },
  {
    key: 'units',
    label: 'Units',
    short: 'Units',
    min: 1,
    max: 50,
    step: 1,
    validate: value => (Number.isInteger(value) ? null : 'Units must be a whole number'),
    format: value => num(value, 0),
  },
];

type SortKey = 'total' | 'name' | 'bills' | 'vendors' | 'sqft' | 'per_sqft' | 'last_bill';
type SortDir = 'asc' | 'desc';

function sortValue(row: ClassRow, key: SortKey): number | string | null {
  switch (key) {
    case 'name':
      return row.class_name.toLowerCase();
    case 'bills':
      return row.bill_count;
    case 'vendors':
      return row.vendor_count;
    case 'sqft':
      return row.specs ? row.specs.square_feet : null;
    case 'per_sqft':
      return row.per_sqft;
    case 'last_bill':
      return row.last_bill;
    case 'total':
    default:
      return row.total;
  }
}

/** Sorts a copy of the rows; nulls always sink to the bottom whatever the direction. */
function sortRows(rows: ClassRow[], key: SortKey, dir: SortDir): ClassRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va === null && vb === null) return a.class_name.localeCompare(b.class_name);
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === 'string' && typeof vb === 'string') return sign * va.localeCompare(vb);
    if (typeof va === 'number' && typeof vb === 'number') return sign * (va - vb);
    return sign * String(va).localeCompare(String(vb));
  });
}

function specValue(row: ClassRow, key: SpecField): number | null {
  return row.specs ? row.specs[key] : null;
}

function projectTypeLabel(type: ProjectType | null): string {
  return type ? PROJECT_TYPE_LABELS[type] : dash;
}

/** Ratio cell: the figure, or a dash carrying the backend's reason as a tooltip. */
function RatioCell({ value, reason, format }: { value: number | null; reason?: string | null; format: (value: number) => string }) {
  if (value === null) {
    return <span className="text-slate-400" title={reason || undefined}>{dash}</span>;
  }
  return <>{format(value)}</>;
}

function LinkedProjectChip({ row }: { row: ClassRow }) {
  if (row.qbo_class_id === UNASSIGNED_CLASS_ID) {
    return <Chip tone="warn" title="Bill lines that carry no QuickBooks class">No class</Chip>;
  }
  if (row.linked_project) {
    return (
      <Chip tone="ok" title={`BuildTrack project: ${row.linked_project.job_name}${row.linked_project.address ? ` · ${row.linked_project.address}` : ''}`}>
        BuildTrack
      </Chip>
    );
  }
  return <span className="text-xs text-slate-500">Not a BuildTrack project</span>;
}

function TypeCell({ row }: { row: ClassRow }) {
  if (!row.project_type) return <span className="text-slate-400">{dash}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="text-slate-800">{projectTypeLabel(row.project_type)}</span>
      {row.project_type_source && (
        <StatusChip
          status={row.project_type_source}
          title={row.project_type_source === 'inferred' ? 'Inferred from the dominant spend type; record the type in the drawer to fix it' : 'Recorded in the project details'}
        />
      )}
    </span>
  );
}

function SortHeader({
  label,
  sortKey,
  current,
  dir,
  onSort,
  numeric = false,
  className = '',
}: {
  label: string;
  sortKey: SortKey;
  current: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  numeric?: boolean;
  className?: string;
}) {
  const active = current === sortKey;
  return (
    <th className={`${numeric ? thNumClass : thClass} ${className}`} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 uppercase hover:text-slate-800 ${active ? 'text-slate-900' : ''}`}
      >
        {label}
        {active && <ChevronDown className={`h-3 w-3 ${dir === 'asc' ? 'rotate-180' : ''}`} aria-hidden="true" />}
      </button>
    </th>
  );
}

// ── Project details editor (drawer) ─────────────────────────────────────────

const CURRENT_YEAR = new Date().getFullYear();

function textOrEmpty(value: number | string | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Type / stories / year built / notes form. Upper management edits everything;
 * a project manager may only fill fields that are still empty (the same rule the
 * route enforces), so recorded fields are disabled for them.
 */
function SpecsEditor({
  row,
  canEdit,
  isProjectManager,
  onSave,
}: {
  row: ClassRow;
  canEdit: boolean;
  isProjectManager: boolean;
  onSave: (body: ClassSpecsInput) => Promise<void>;
}) {
  const specs = row.specs;
  const [projectType, setProjectType] = useState<string>(specs?.project_type ?? '');
  const [stories, setStories] = useState<string>(textOrEmpty(specs?.stories));
  const [yearBuilt, setYearBuilt] = useState<string>(textOrEmpty(specs?.year_built));
  const [notes, setNotes] = useState<string>(specs?.notes ?? '');
  const [saving, setSaving] = useState(false);

  const locked = (stored: number | string | null | undefined) =>
    isProjectManager && !canEdit && stored !== null && stored !== undefined && stored !== '';

  const parseOptional = (text: string): number | null | undefined => {
    const cleaned = text.replace(/[,\s]/g, '');
    if (cleaned === '') return null;
    const value = Number(cleaned);
    return Number.isFinite(value) ? value : undefined;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body: ClassSpecsInput = {};
    const storedType = specs?.project_type ?? '';
    if (projectType !== storedType) body.project_type = projectType ? (projectType as ProjectType) : null;

    const storiesValue = parseOptional(stories);
    if (storiesValue === undefined) { toast.error('Stories must be a number'); return; }
    if (storiesValue !== null && (storiesValue < 0.5 || storiesValue > 10 || !Number.isInteger(storiesValue * 2))) {
      toast.error('Stories must be between 0.5 and 10, in halves');
      return;
    }
    if (storiesValue !== (specs?.stories ?? null)) body.stories = storiesValue;

    const yearValue = parseOptional(yearBuilt);
    if (yearValue === undefined) { toast.error('Year built must be a number'); return; }
    if (yearValue !== null && (!Number.isInteger(yearValue) || yearValue < 1800 || yearValue > CURRENT_YEAR + 1)) {
      toast.error(`Year built must be a whole year between 1800 and ${CURRENT_YEAR + 1}`);
      return;
    }
    if (yearValue !== (specs?.year_built ?? null)) body.year_built = yearValue;

    const notesValue = notes.trim() ? notes.trim() : null;
    if (notesValue !== (specs?.notes ?? null)) body.notes = notesValue;

    if (Object.keys(body).length === 0) {
      toast('Nothing changed');
      return;
    }
    setSaving(true);
    try {
      await onSave(body);
      toast.success('Project details saved');
    } catch (err: any) {
      toast.error(apiError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase text-slate-600">Project type</span>
          <select
            className={fieldClass}
            value={projectType}
            disabled={saving || locked(specs?.project_type)}
            onChange={event => setProjectType(event.target.value)}
          >
            <option value="">Not recorded{row.project_type_source === 'inferred' && row.project_type ? ` (inferred: ${projectTypeLabel(row.project_type)})` : ''}</option>
            {PROJECT_TYPES.map(type => (
              <option key={type} value={type}>{PROJECT_TYPE_LABELS[type]}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase text-slate-600">Stories</span>
          <input
            type="text"
            inputMode="decimal"
            className={fieldClass}
            value={stories}
            placeholder="e.g. 2"
            disabled={saving || locked(specs?.stories)}
            onChange={event => setStories(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase text-slate-600">Year built</span>
          <input
            type="text"
            inputMode="numeric"
            className={fieldClass}
            value={yearBuilt}
            placeholder="e.g. 1952"
            disabled={saving || locked(specs?.year_built)}
            onChange={event => setYearBuilt(event.target.value)}
          />
        </label>
      </div>
      <label className="block">
        <span className="mb-1.5 block text-xs font-semibold uppercase text-slate-600">Notes</span>
        <textarea
          className={textAreaClass}
          value={notes}
          placeholder="Scope, condition, anything that explains the cost"
          disabled={saving || locked(specs?.notes)}
          onChange={event => setNotes(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          {specs?.updated_at
            ? `Last updated ${formatDateTime(specs.updated_at)}${specs.updated_by_name ? ` by ${specs.updated_by_name}` : ''}`
            : 'No details recorded yet'}
          {isProjectManager && !canEdit && ' · Project managers can add missing details but not change recorded ones.'}
        </p>
        <button type="submit" className={primaryButton} disabled={saving}>
          {saving ? 'Saving...' : 'Save details'}
        </button>
      </div>
    </form>
  );
}

// ── Tab ─────────────────────────────────────────────────────────────────────

export default function ProjectsTab({ filters, canEdit, onOpenVendor }: ProjectsTabProps) {
  const user = useAuthStore(state => state.user);
  const isProjectManager = user?.role === 'project_manager';
  // Project managers may fill empty cells (field information); everything else needs canEdit.
  const canFill = canEdit || isProjectManager;

  const [data, setData] = useState<ClassesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('total');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [exporting, setExporting] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ClassDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // Bumped after a save so the open drawer refetches its detail.
  const [detailVersion, setDetailVersion] = useState(0);

  const query = useMemo(() => buildFilterQuery(filters), [filters]);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  // Monotonic request id so a slow, superseded list response never overwrites a newer one.
  const requestRef = useRef(0);

  const load = useCallback(async (silent: boolean) => {
    const requestId = ++requestRef.current;
    if (!silent) setRefreshing(true);
    try {
      const result = await getClasses(filtersRef.current);
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
    void load(false);
  }, [query, load]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    getClassDetail(selectedId, filtersRef.current)
      .then(result => { if (!cancelled) setDetail(result); })
      .catch((err: unknown) => { if (!cancelled) toast.error(apiError(err)); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId, query, detailVersion]);

  /** Saves a partial specs body, patches the row locally, then refetches so per-sqft figures update. */
  const saveSpecs = useCallback(async (classId: string, body: ClassSpecsInput) => {
    const response = await saveClassSpecs(classId, body);
    if (response.specs !== undefined) {
      const nextSpecs = response.specs;
      setData(previous => previous
        ? { ...previous, classes: previous.classes.map(row => (row.qbo_class_id === classId ? { ...row, specs: nextSpecs } : row)) }
        : previous);
      setDetail(previous => (previous && previous.qbo_class_id === classId ? { ...previous, specs: nextSpecs } : previous));
    }
    void load(true);
    setDetailVersion(version => version + 1);
  }, [load]);

  const canEditCell = useCallback((row: ClassRow, key: SpecField): boolean => {
    if (row.qbo_class_id === UNASSIGNED_CLASS_ID || !canFill) return false;
    if (canEdit) return true;
    // Project manager: add-only, so a recorded value is read-only for them.
    return specValue(row, key) === null;
  }, [canEdit, canFill]);

  const saveSpecField = useCallback(async (row: ClassRow, field: SpecFieldDef, next: number | null) => {
    if (next !== null) {
      const problem = field.validate(next);
      if (problem) throw new Error(problem);
    }
    if (next === null && isProjectManager && !canEdit) throw new Error('Project managers cannot clear a recorded value');
    const body: ClassSpecsInput = {};
    body[field.key] = next;
    await saveSpecs(row.qbo_class_id, body);
    toast.success(`${field.label} saved for ${row.class_name}`);
  }, [saveSpecs, isProjectManager, canEdit]);

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(direction => (direction === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDir(key === 'name' ? 'asc' : 'desc');
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadCsv('classes', filtersRef.current);
    } catch (err: any) {
      toast.error(apiError(err));
    } finally {
      setExporting(false);
    }
  };

  const rows = useMemo(() => {
    const all = data ? data.classes : [];
    const needle = search.trim().toLowerCase();
    const filtered = needle
      ? all.filter(row => row.class_name.toLowerCase().includes(needle)
        || (row.linked_project ? row.linked_project.job_name.toLowerCase().includes(needle) : false)
        || (row.linked_project && row.linked_project.address ? row.linked_project.address.toLowerCase().includes(needle) : false))
      : all;
    return sortRows(filtered, sortKey, sortDir);
  }, [data, search, sortKey, sortDir]);

  // Per-sqft / per-bed / per-bath columns only appear once at least one project has that detail.
  const anySqft = useMemo(() => (data ? data.classes.some(row => specValue(row, 'square_feet') !== null) : false), [data]);
  const anyBeds = useMemo(() => (data ? data.classes.some(row => specValue(row, 'bedrooms') !== null) : false), [data]);
  const anyBaths = useMemo(() => (data ? data.classes.some(row => specValue(row, 'bathrooms') !== null) : false), [data]);

  const selectedRow = useMemo(() => (data && selectedId ? data.classes.find(row => row.qbo_class_id === selectedId) ?? null : null), [data, selectedId]);

  const stopRowClick = (event: MouseEvent<HTMLElement>) => event.stopPropagation();

  const renderSpecCell = (row: ClassRow, field: SpecFieldDef, className = '') => (
    <InlineNumber
      value={specValue(row, field.key)}
      disabled={!canEditCell(row, field.key)}
      ariaLabel={`${field.label} for ${row.class_name}`}
      min={field.min}
      max={field.max}
      step={field.step}
      format={field.format}
      onSave={next => saveSpecField(row, field, next)}
      className={className}
    />
  );

  if (data === null && error === null) {
    return (
      <div className={cardClass}>
        <InlineSpinner label="Loading projects..." />
      </div>
    );
  }

  if (data === null) {
    return (
      <div className={cardClass}>
        <p className="text-sm font-semibold text-slate-800">Projects could not be loaded.</p>
        <p className="mt-1 text-sm text-slate-500">{error}</p>
        <button type="button" className={`${secondaryButton} mt-4`} onClick={() => { void load(false); }}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  }

  const totalSpend = data.classes.reduce((acc, row) => acc + row.total, 0);
  const completeCount = data.classes.filter(row => row.completeness === 'complete').length;
  const projectCount = data.classes.filter(row => row.qbo_class_id !== UNASSIGNED_CLASS_ID).length;

  return (
    <div className={`space-y-6 transition-opacity ${refreshing ? 'opacity-60' : ''}`} aria-busy={refreshing ? true : undefined}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Projects" value={num(projectCount)} hint="QuickBooks classes with bills" icon={Building2} />
        <StatTile
          label="With square footage"
          value={`${num(data.classes_with_sqft)} / ${num(projectCount)}`}
          hint={data.classes_with_sqft < projectCount ? 'Add sq ft to unlock $/sq ft' : 'Every project has square footage'}
          tone={data.classes_with_sqft < projectCount ? 'warn' : 'ok'}
        />
        <StatTile label="Total spend" value={money(totalSpend, 0)} hint="Allocated by bill line class" />
        <StatTile label="Complete projects" value={num(completeCount)} hint="Not billed in 60 days and not in progress" />
      </div>

      <section className="space-y-4">
        <SectionHeading
          title="Projects"
          hint="Click a project for its breakdown. Size details save as you type them in."
          action={(
            <button type="button" className={secondaryButton} onClick={() => { void exportCsv(); }} disabled={exporting}>
              <Download className="h-4 w-4" aria-hidden="true" />
              {exporting ? 'Exporting...' : 'Export CSV'}
            </button>
          )}
        />

        <div className="flex flex-col gap-3 sm:flex-row">
          <label className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" aria-hidden="true" />
            <input
              className={`${fieldClass} pl-9`}
              placeholder="Search projects"
              aria-label="Search projects"
              value={search}
              onChange={event => setSearch(event.target.value)}
            />
          </label>
          <select
            className={`${fieldClass} sm:w-56`}
            aria-label="Sort projects"
            value={`${sortKey}:${sortDir}`}
            onChange={event => {
              const [key, dir] = event.target.value.split(':');
              setSortKey(key as SortKey);
              setSortDir(dir === 'asc' ? 'asc' : 'desc');
            }}
          >
            <option value="total:desc">Highest spend first</option>
            <option value="total:asc">Lowest spend first</option>
            <option value="name:asc">Name A–Z</option>
            <option value="last_bill:desc">Most recently billed</option>
            <option value="per_sqft:desc">Highest $/sq ft</option>
            <option value="sqft:desc">Largest first</option>
          </select>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            title={search ? 'No projects match that search' : 'No projects in this range'}
            message={search ? 'Try a different name or address.' : 'No bills fall inside the selected dates or spend type.'}
            icon={Building2}
          />
        ) : (
          <>
            {/* Desktop table */}
            <div className={`${tableWrapClass} hidden md:block`}>
              <table className={`${tableClass} min-w-[1100px]`}>
                <thead className={theadClass}>
                  <tr>
                    <SortHeader label="Project" sortKey="name" current={sortKey} dir={sortDir} onSort={onSort} className={stickyHeadClass} />
                    <th className={thClass}>Type</th>
                    <th className={thClass}>Status</th>
                    <SortHeader label="Total" sortKey="total" current={sortKey} dir={sortDir} onSort={onSort} numeric />
                    <SortHeader label="Bills" sortKey="bills" current={sortKey} dir={sortDir} onSort={onSort} numeric />
                    <SortHeader label="Vendors" sortKey="vendors" current={sortKey} dir={sortDir} onSort={onSort} numeric />
                    <SortHeader label="Sq ft" sortKey="sqft" current={sortKey} dir={sortDir} onSort={onSort} numeric />
                    <th className={thNumClass}>Beds</th>
                    <th className={thNumClass}>Baths</th>
                    <th className={thNumClass}>Units</th>
                    {anySqft && <SortHeader label="$/sq ft (rehab + new)" sortKey="per_sqft" current={sortKey} dir={sortDir} onSort={onSort} numeric />}
                    {anyBeds && <th className={thNumClass}>$/bed</th>}
                    {anyBaths && <th className={thNumClass}>$/bath</th>}
                    <th className={`${thClass} w-12`}><span className="sr-only">Open</span></th>
                  </tr>
                </thead>
                <tbody className={tbodyClass}>
                  {rows.map(row => (
                    <tr
                      key={row.qbo_class_id}
                      className="cursor-pointer transition hover:bg-slate-50"
                      onClick={() => setSelectedId(row.qbo_class_id)}
                    >
                      <td className={`${tdClass} ${stickyFirstColClass}`}>
                        <button
                          type="button"
                          onClick={event => { event.stopPropagation(); setSelectedId(row.qbo_class_id); }}
                          className="text-left font-semibold text-slate-900 hover:underline"
                        >
                          {row.class_name}
                        </button>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <LinkedProjectChip row={row} />
                          {row.linked_project && row.linked_project.address && (
                            <span className="truncate text-xs text-slate-500" title={row.linked_project.address}>{row.linked_project.address}</span>
                          )}
                        </div>
                      </td>
                      <td className={tdClass}><TypeCell row={row} /></td>
                      <td className={tdClass}>
                        <StatusChip status={row.completeness} title={row.last_bill ? `Last bill ${formatDate(row.last_bill)}` : undefined} />
                      </td>
                      <td className={`${tdNumClass} font-semibold text-slate-900`}>{money(row.total, 0)}</td>
                      <td className={tdNumClass}>{num(row.bill_count)}</td>
                      <td className={tdNumClass}>{num(row.vendor_count)}</td>
                      {SPEC_FIELDS.map(field => (
                        <td key={field.key} className={`${tdNumClass} py-1`} onClick={stopRowClick}>
                          {renderSpecCell(row, field)}
                        </td>
                      ))}
                      {anySqft && (
                        <td className={tdNumClass}>
                          <RatioCell value={row.per_sqft} reason={row.per_sqft_reason} format={value => perSqft(value)} />
                        </td>
                      )}
                      {anyBeds && (
                        <td className={tdNumClass}>
                          <RatioCell value={row.per_bedroom} reason={row.per_bedroom_reason} format={value => money(value, 0)} />
                        </td>
                      )}
                      {anyBaths && (
                        <td className={tdNumClass}>
                          <RatioCell value={row.per_bathroom} reason={row.per_bathroom_reason} format={value => money(value, 0)} />
                        </td>
                      )}
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
                <div key={row.qbo_class_id} className={cardClass}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <button
                        type="button"
                        onClick={() => setSelectedId(row.qbo_class_id)}
                        className="text-left text-sm font-semibold text-slate-900 hover:underline"
                      >
                        {row.class_name}
                      </button>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <LinkedProjectChip row={row} />
                        <StatusChip status={row.completeness} />
                        {row.project_type_source && row.project_type && (
                          <span className="text-xs text-slate-500">{projectTypeLabel(row.project_type)}{row.project_type_source === 'inferred' ? ' (inferred)' : ''}</span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedId(row.qbo_class_id)}
                      className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                      aria-label={`Open ${row.class_name}`}
                    >
                      <ChevronRight className="h-5 w-5" aria-hidden="true" />
                    </button>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-x-4 gap-y-3">
                    <div>
                      <p className={labelClass}>Total</p>
                      <p className="mt-1 text-base font-bold tabular-nums text-slate-900">{money(row.total, 0)}</p>
                    </div>
                    <div>
                      <p className={labelClass}>Bills</p>
                      <p className="mt-1 text-base font-bold tabular-nums text-slate-900">{num(row.bill_count)}</p>
                    </div>
                    <div>
                      <p className={labelClass}>$/sq ft</p>
                      <p className="mt-1 text-base font-bold tabular-nums text-slate-900">
                        <RatioCell value={row.per_sqft} reason={row.per_sqft_reason} format={value => money(value)} />
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-slate-200 pt-3 sm:grid-cols-4">
                    {SPEC_FIELDS.map(field => (
                      <div key={field.key} className="flex items-center justify-between gap-2">
                        <span className={labelClass}>{field.short}</span>
                        {renderSpecCell(row, field, 'w-auto')}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <p className="text-xs text-slate-500">
          $/sq ft divides rehab and new-construction spend by square feet; maintenance is shown per year in the project drawer.
          {isProjectManager && !canEdit && ' Project managers can add missing size details; recorded values stay locked.'}
        </p>
      </section>

      <Drawer
        isOpen={selectedId !== null}
        onClose={() => setSelectedId(null)}
        title={detail?.class_name ?? selectedRow?.class_name ?? 'Project'}
        description={(() => {
          const row = detail ?? selectedRow;
          if (!row) return undefined;
          if (row.qbo_class_id === UNASSIGNED_CLASS_ID) return 'Bill lines with no QuickBooks class';
          if (row.linked_project) return `${row.linked_project.job_name}${row.linked_project.address ? ` · ${row.linked_project.address}` : ''}`;
          return 'Not a BuildTrack project';
        })()}
      >
        {selectedId && (
          <ProjectDrawerBody
            detail={detail}
            fallback={selectedRow}
            loading={detailLoading}
            canEdit={canEdit}
            isProjectManager={isProjectManager}
            canEditCell={canEditCell}
            renderSpecCell={renderSpecCell}
            onSaveSpecs={body => saveSpecs(selectedId, body)}
            onOpenVendor={onOpenVendor}
          />
        )}
      </Drawer>
    </div>
  );
}

// ── Drawer body ─────────────────────────────────────────────────────────────

function ProjectDrawerBody({
  detail,
  fallback,
  loading,
  canEdit,
  isProjectManager,
  canEditCell,
  renderSpecCell,
  onSaveSpecs,
  onOpenVendor,
}: {
  detail: ClassDetail | null;
  fallback: ClassRow | null;
  loading: boolean;
  canEdit: boolean;
  isProjectManager: boolean;
  canEditCell: (row: ClassRow, key: SpecField) => boolean;
  renderSpecCell: (row: ClassRow, field: SpecFieldDef, className?: string) => ReactNode;
  onSaveSpecs: (body: ClassSpecsInput) => Promise<void>;
  onOpenVendor?: (vendorId: string) => void;
}) {
  const row: ClassRow | null = detail ?? fallback;
  if (!row) {
    return <InlineSpinner label="Loading project..." />;
  }
  const isUnassigned = row.qbo_class_id === UNASSIGNED_CLASS_ID;
  const specs = row.specs;
  const sqft = specs ? specs.square_feet : null;
  const showEditor = !isUnassigned && (canEdit || isProjectManager);
  const anyCellEditable = !isUnassigned && SPEC_FIELDS.some(field => canEditCell(row, field.key));

  const categoryBars = row.by_category.map(category => ({
    key: category.id,
    label: category.name,
    value: category.total,
    sublabel: `${num(category.bills)} bill${category.bills === 1 ? '' : 's'}${category.per_sqft !== null ? ` · ${perSqft(category.per_sqft)}` : ''}`,
  }));

  return (
    <div className={`space-y-6 transition-opacity ${loading && detail ? 'opacity-60' : ''}`} aria-busy={loading ? true : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <LinkedProjectChip row={row} />
        <StatusChip status={row.completeness} />
        {row.project_type && (
          <Chip tone="neutral" title={row.project_type_source === 'inferred' ? 'Inferred from the dominant spend type' : 'Recorded'}>
            {projectTypeLabel(row.project_type)}{row.project_type_source === 'inferred' ? ' (inferred)' : ''}
          </Chip>
        )}
        {row.first_bill && (
          <span className="text-xs text-slate-500">
            Bills {formatDate(row.first_bill)} – {formatDate(row.last_bill)} · {num(row.months_active)} active month{row.months_active === 1 ? '' : 's'}
          </span>
        )}
        {loading && !detail && <InlineSpinner label="Loading details..." />}
      </div>

      {!isUnassigned && (
        <section className="space-y-3">
          <SectionHeading
            title="Size details"
            hint={anyCellEditable ? 'Click a value to edit; Enter saves, Esc cancels.' : undefined}
          />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {SPEC_FIELDS.map(field => (
              <div key={field.key} className={cardClass}>
                <p className={labelClass}>{field.label}</p>
                <div className="mt-1 text-lg font-bold text-slate-950">{renderSpecCell(row, field)}</div>
              </div>
            ))}
          </div>
          {specs?.updated_at && (
            <p className="text-xs text-slate-500">
              Updated {formatDateTime(specs.updated_at)}{specs.updated_by_name ? ` by ${specs.updated_by_name}` : ''}
              {specs.stories !== null ? ` · ${num(specs.stories, 1)} stories` : ''}
              {specs.year_built !== null ? ` · built ${specs.year_built}` : ''}
            </p>
          )}
        </section>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Total spend" value={money(row.total, 0)} hint={`${num(row.bill_count)} bills · ${num(row.vendor_count)} vendors`} />
        <StatTile
          label="$/sq ft (rehab + new)"
          value={row.per_sqft !== null ? money(row.per_sqft) : dash}
          hint={row.per_sqft !== null ? `${num(sqft, 0)} sq ft` : row.per_sqft_reason ?? undefined}
          tone={row.per_sqft === null ? 'warn' : 'neutral'}
        />
        <StatTile
          label="$/bedroom"
          value={row.per_bedroom !== null ? money(row.per_bedroom, 0) : dash}
          hint={row.per_bedroom !== null ? `${num(specs ? specs.bedrooms : null, 0)} bedrooms · all spend` : row.per_bedroom_reason ?? undefined}
        />
        <StatTile
          label="$/bathroom"
          value={row.per_bathroom !== null ? money(row.per_bathroom, 0) : dash}
          hint={row.per_bathroom !== null ? `${num(specs ? specs.bathrooms : null, 1)} bathrooms · all spend` : row.per_bathroom_reason ?? undefined}
        />
        <StatTile
          label="$/unit"
          value={row.per_unit !== null ? money(row.per_unit, 0) : dash}
          hint={row.per_unit !== null ? `${num(specs ? specs.units : null, 0)} units` : row.per_unit_reason ?? undefined}
        />
        <StatTile
          label="Documents read"
          value={pct(row.documents_coverage)}
          hint={`${money(row.documented_total, 0)} of spend has an extracted invoice`}
        />
        <StatTile
          label="Maintenance $/sq ft/yr"
          value={row.maintenance_per_sqft_per_year !== null ? money(row.maintenance_per_sqft_per_year) : dash}
          hint={row.years_spanned !== null && row.years_spanned > 0 ? `over ${num(row.years_spanned, 1)} years` : 'needs sq ft and maintenance spend'}
        />
        <StatTile
          label="Budget"
          value={row.linked_project && row.linked_project.budget !== null ? money(row.linked_project.budget, 0) : dash}
          hint={row.linked_project ? `BuildTrack status: ${row.linked_project.lifecycle_status || row.linked_project.status || dash}` : 'Not a BuildTrack project'}
        />
      </div>

      <section className="space-y-3">
        <SectionHeading title="Spend by type" hint="From the QuickBooks expense account on each bill line" />
        <div className="grid grid-cols-2 gap-x-8 gap-y-4 border-b border-slate-200 pb-5 md:grid-cols-4">
          {SPEND_TYPES.map(type => (
            <div key={type}>
              <p className={labelClass}>{SPEND_TYPE_LABELS[type]}</p>
              <p className="mt-1 text-xl font-bold tabular-nums text-slate-900">{money(row.spend_by_type[type], 0)}</p>
              <p className="text-xs text-slate-500">
                {row.per_sqft_by_type[type] !== null ? perSqft(row.per_sqft_by_type[type]) : (sqft ? dash : 'no sq ft')}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeading title="By category" hint="Effective bill category (manual > AI > keyword > vendor)" />
        {row.by_category.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">No spend in this range.</p>
        ) : (
          <>
            <BarList
              rows={categoryBars}
              format={value => money(value, 0)}
              title="Spend by category"
              valueHeader="Total"
              ariaLabel="Spend by category"
            />
            <div className={tableWrapClass}>
              <table className={`${tableClass} min-w-[720px]`}>
                <thead className={theadClass}>
                  <tr>
                    <th className={`${thClass} ${stickyHeadClass}`}>Category</th>
                    <th className={thClass}>Kind</th>
                    <th className={thNumClass}>Bills</th>
                    <th className={thNumClass}>Total</th>
                    <th className={thNumClass}>Share</th>
                    <th className={thNumClass}>$/sq ft</th>
                    <th className={thClass}>Top vendors</th>
                  </tr>
                </thead>
                <tbody className={tbodyClass}>
                  {row.by_category.map(category => (
                    <tr key={category.id}>
                      <td className={`${tdClass} ${stickyFirstColClass} font-semibold text-slate-900`}>{category.name}</td>
                      <td className={tdClass}><span className="text-xs uppercase text-slate-500">{category.kind}</span></td>
                      <td className={tdNumClass}>{num(category.bills)}</td>
                      <td className={tdNumClass}>{money(category.total, 0)}</td>
                      <td className={tdNumClass}>{pct(category.share)}</td>
                      <td className={tdNumClass}>
                        <RatioCell value={category.per_sqft} reason={row.per_sqft_reason ?? 'no square footage recorded'} format={value => money(value)} />
                      </td>
                      <td className={tdClass}>
                        <span className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-slate-600">
                          {category.vendors.slice(0, 3).map(vendor => (
                            onOpenVendor ? (
                              <button
                                key={vendor.vendor_id}
                                type="button"
                                onClick={() => onOpenVendor(vendor.vendor_id)}
                                className="text-left hover:text-slate-950 hover:underline"
                                title={money(vendor.total, 0)}
                              >
                                {vendor.name}
                              </button>
                            ) : (
                              <span key={vendor.vendor_id} title={money(vendor.total, 0)}>{vendor.name}</span>
                            )
                          ))}
                          {category.vendors.length > 3 && <span className="text-slate-400">+{category.vendors.length - 3} more</span>}
                        </span>
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
        <SectionHeading title="Vendors" hint={onOpenVendor ? 'Click a vendor to open it in the Vendors tab' : undefined} />
        {!detail ? (
          <InlineSpinner label="Loading vendors..." />
        ) : detail.vendors.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">No vendors in this range.</p>
        ) : (
          <div className={tableWrapClass}>
            <table className={`${tableClass} min-w-[640px]`}>
              <thead className={theadClass}>
                <tr>
                  <th className={`${thClass} ${stickyHeadClass}`}>Vendor</th>
                  <th className={thClass}>Category</th>
                  <th className={thNumClass}>Bills</th>
                  <th className={thNumClass}>Total</th>
                  <th className={thNumClass}>Share</th>
                </tr>
              </thead>
              <tbody className={tbodyClass}>
                {detail.vendors.map(vendor => (
                  <tr key={vendor.vendor_id}>
                    <td className={`${tdClass} ${stickyFirstColClass}`}>
                      {onOpenVendor ? (
                        <button type="button" onClick={() => onOpenVendor(vendor.vendor_id)} className="text-left font-semibold text-slate-900 hover:underline">
                          {vendor.name}
                        </button>
                      ) : (
                        <span className="font-semibold text-slate-900">{vendor.name}</span>
                      )}
                    </td>
                    <td className={tdClass}>{vendor.category.name}</td>
                    <td className={tdNumClass}>{num(vendor.bills)}</td>
                    <td className={tdNumClass}>{money(vendor.total, 0)}</td>
                    <td className={tdNumClass}>{pct(vendor.share)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeading title="Materials and labor per sq ft" hint="From line items read off the invoices attached to this project's bills" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Material $/sq ft"
            value={row.material_per_sqft !== null ? money(row.material_per_sqft) : dash}
            hint={`${money(row.items_material_total, 0)} in material lines`}
          />
          <StatTile
            label="Labor $/sq ft"
            value={row.labor_per_sqft !== null ? money(row.labor_per_sqft) : dash}
            hint={`${money(row.items_labor_total, 0)} in labor lines`}
          />
          <StatTile
            label="Labor + material $/sq ft"
            value={row.labor_and_material_per_sqft !== null ? money(row.labor_and_material_per_sqft) : dash}
            hint={`${money(row.items_labor_and_material_total, 0)} in combined lines`}
          />
          <StatTile
            label="Coverage"
            value={pct(row.items_coverage)}
            hint={row.items_coverage_reason ?? `${num(row.n_items)} line items read`}
            tone={row.items_coverage !== null && row.items_coverage >= 0.5 ? 'ok' : 'warn'}
          />
        </div>
        {detail && detail.materials.length > 0 && (
          <div className={tableWrapClass}>
            <table className={`${tableClass} min-w-[520px]`}>
              <thead className={theadClass}>
                <tr>
                  <th className={thClass}>Family</th>
                  <th className={thNumClass}>Lines</th>
                  <th className={thNumClass}>Total</th>
                  <th className={thNumClass}>$/sq ft</th>
                </tr>
              </thead>
              <tbody className={tbodyClass}>
                {detail.materials.map(family => (
                  <tr key={family.family}>
                    <td className={`${tdClass} text-slate-900`}>{family.family.replace(/_/g, ' ')}</td>
                    <td className={tdNumClass}>{num(family.n_items)}</td>
                    <td className={tdNumClass}>{money(family.total, 0)}</td>
                    <td className={tdNumClass}>
                      <RatioCell value={family.per_sqft} reason="no square footage recorded" format={value => money(value)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-slate-500">
          Coverage is the share of this project's spend whose invoice has been read; below 50% the per-sq-ft split is indicative only.
        </p>
      </section>

      {detail && detail.bills.length > 0 && (
        <details className="group rounded-md border border-slate-200 bg-white">
          <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-slate-800">
            <span>Bills on this project ({num(detail.bills.length)})</span>
            <ChevronDown className="h-4 w-4 text-slate-400 transition group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="overflow-x-auto border-t border-slate-200">
            <table className={`${tableClass} min-w-[760px]`}>
              <thead className={theadClass}>
                <tr>
                  <th className={thClass}>Date</th>
                  <th className={thClass}>Vendor</th>
                  <th className={thClass}>Category</th>
                  <th className={thClass}>Note</th>
                  <th className={thNumClass}>On this project</th>
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
                    <td className={tdClass}>
                      <span className="inline-flex flex-wrap items-center gap-1">
                        {bill.effective_category.name}
                        {bill.effective_category.source !== 'vendor' && (
                          <span className="text-xs text-slate-500">({bill.effective_category.source})</span>
                        )}
                      </span>
                    </td>
                    <td className={`${tdClass} max-w-[16rem] truncate text-slate-600`} title={bill.private_note ?? undefined}>{bill.private_note || dash}</td>
                    <td className={tdNumClass}>
                      {money(bill.amount)}
                      {bill.multi_class && <span className="block text-xs text-slate-500">multi-class</span>}
                    </td>
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

      {showEditor && (
        <section className="space-y-3">
          <SectionHeading title="Project details" hint="Type, stories, year built and notes" />
          <SpecsEditor
            key={`${row.qbo_class_id}:${specs?.updated_at ?? 'new'}`}
            row={row}
            canEdit={canEdit}
            isProjectManager={isProjectManager}
            onSave={onSaveSpecs}
          />
        </section>
      )}

      {row.allocated_total > 0 && (
        <p className="border-t border-slate-200 pt-3 text-xs text-slate-500">
          {pct(row.allocated_share)} of this total ({money(row.allocated_total, 0)}) comes from bill lines whose class differs from
          the bill's own class; each line is counted on the class it carries.
        </p>
      )}
    </div>
  );
}
