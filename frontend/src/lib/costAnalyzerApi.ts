import api from './api';

// Cost Analyzer API client (spec §6 / §7). Every response type mirrors what
// backend/src/services/costAnalyzerStats.js returns field by field; nullable
// numbers are `number | null` and every null ratio has a sibling `*_reason`.
// All fetchers go through the shared axios instance (`/api` base, Bearer token).

const BASE = '/cost-analyzer';

// ── Enums (spec §2, §2.1, §3) ───────────────────────────────────────────────

/** QBO expense-account bucket a bill line falls into. */
export type SpendType = 'rehab' | 'new_construction' | 'maintenance' | 'other';
/** Spend types in display order. */
export const SPEND_TYPES: SpendType[] = ['rehab', 'new_construction', 'maintenance', 'other'];
/** Human labels for spend types. */
export const SPEND_TYPE_LABELS: Record<SpendType, string> = {
  rehab: 'Rehab',
  new_construction: 'New construction',
  maintenance: 'Maintenance',
  other: 'Other',
};
/** Totals keyed by spend type (always all four keys). */
export type SpendByType = Record<SpendType, number>;

/** Cost Analyzer category kind. */
export type CategoryKind = 'trade' | 'supplier' | 'service' | 'other';
/** Human labels for category kinds. */
export const CATEGORY_KIND_LABELS: Record<CategoryKind, string> = {
  trade: 'Trade',
  supplier: 'Supplier',
  service: 'Service',
  other: 'Other',
};
/** Where a vendor's category came from ('none' = no row yet). */
export type VendorCategorySource = 'seed' | 'ai' | 'keyword' | 'manual' | 'none';
/** Where a bill's effective category came from (spec §4.1 precedence). */
export type BillCategorySource = 'manual' | 'ai' | 'keyword' | 'vendor' | 'uncategorized';
/** Vendor-year status (spec §4.2). */
export type YearStatus = 'complete' | 'ytd' | 'partial';
/** Class completeness (spec §4.3). */
export type Completeness = 'complete' | 'in_progress';
/** Stored project type (cost_analyzer_class_specs CHECK list). */
export type ProjectType = 'rehab' | 'new_construction' | 'rental_maintenance' | 'wholesale' | 'other';
/** Project types in display order. */
export const PROJECT_TYPES: ProjectType[] = ['rehab', 'new_construction', 'rental_maintenance', 'wholesale', 'other'];
/** Human labels for project types. */
export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  rehab: 'Rehab',
  new_construction: 'New construction',
  rental_maintenance: 'Rental maintenance',
  wholesale: 'Wholesale',
  other: 'Other',
};
/** cost_analyzer_documents.status. */
export type DocumentStatus = 'pending' | 'running' | 'extracted' | 'unreadable' | 'failed' | 'skipped' | 'duplicate';
/** Document statuses in display order. */
export const DOCUMENT_STATUSES: DocumentStatus[] = ['pending', 'running', 'extracted', 'unreadable', 'failed', 'skipped', 'duplicate'];
/** Document type the extractor recognised. */
export type DocType = 'invoice' | 'receipt' | 'estimate' | 'statement' | 'work_completion_form' | 'other';
/** Material family enum (spec §2.1). */
export type MaterialFamily =
  | 'doors' | 'windows' | 'countertops' | 'cabinets' | 'flooring' | 'tile' | 'drywall' | 'insulation'
  | 'roofing' | 'siding' | 'gutters' | 'paint' | 'lumber_and_framing' | 'electrical' | 'plumbing' | 'hvac'
  | 'appliances' | 'hardware_and_fasteners' | 'concrete_and_masonry' | 'landscaping' | 'fixtures_and_lighting'
  | 'cleaning_and_consumables' | 'demolition' | 'other';
/** Material families in display order (spec §2.1). */
export const MATERIAL_FAMILIES: MaterialFamily[] = [
  'doors', 'windows', 'countertops', 'cabinets', 'flooring', 'tile', 'drywall', 'insulation',
  'roofing', 'siding', 'gutters', 'paint', 'lumber_and_framing', 'electrical', 'plumbing', 'hvac',
  'appliances', 'hardware_and_fasteners', 'concrete_and_masonry', 'landscaping', 'fixtures_and_lighting',
  'cleaning_and_consumables', 'demolition', 'other',
];
/** Phase enum (spec §2.1). */
export type Phase = 'rough' | 'final' | 'service_call' | 'repair' | 'install' | 'n_a';
/** Phases in display order. */
export const PHASES: Phase[] = ['rough', 'final', 'service_call', 'repair', 'install', 'n_a'];
/** Item kind enum (spec §2.1). */
export type ItemKind = 'labor' | 'material' | 'labor_and_material' | 'fee' | 'credit' | 'other';
/** Item kinds in display order. */
export const ITEM_KINDS: ItemKind[] = ['labor', 'material', 'labor_and_material', 'fee', 'credit', 'other'];
/** Unit enum (spec §2.1). */
export type Unit = 'each' | 'sqft' | 'lf' | 'sheet' | 'gal' | 'hr' | 'day' | 'week' | 'lot' | 'ton' | 'yard' | 'other';
/** Units in display order. */
export const UNITS: Unit[] = ['each', 'sqft', 'lf', 'sheet', 'gal', 'hr', 'day', 'week', 'lot', 'ton', 'yard', 'other'];
/** Whether an item's price is per unit or a lump-sum job. */
export type PricingBasis = 'unit' | 'job';
/** Who created a material item. */
export type ItemSource = 'ai' | 'manual';
/** cost_analyzer_material_targets.status. */
export type TargetStatusValue = 'open' | 'answered' | 'not_applicable';
/** Coverage bucket for an owner target: ok >= 3 items, thin 1-2, none 0. */
export type CoverageStatus = 'ok' | 'thin' | 'none';
/** cost_analyzer_scan_runs.status. */
export type ScanRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
/** Scan scope accepted by POST /documents/scan. */
export type ScanScope = 'pending' | 'failed' | 'all' | 'selected';
/** CSV report names accepted by GET /export.csv. */
export type ExportReport = 'vendors' | 'classes' | 'categories' | 'materials';
/** Export reports in display order. */
export const EXPORT_REPORTS: ExportReport[] = ['vendors', 'classes', 'categories', 'materials'];

// ── Filters (spec §4.1) ─────────────────────────────────────────────────────

/** Query filters every report accepts. Empty / null values are omitted from the request. */
export type CostAnalyzerFilters = {
  from?: string | null;
  to?: string | null;
  spend_type?: SpendType | '' | null;
  class_id?: string | null;
  category_id?: string | null;
  vendor_id?: string | null;
  include?: 'all' | 'bills' | null;
  include_in_progress?: boolean | null;
};

/** The normalised filters the backend echoes back on every report. */
export type FilterEcho = {
  from: string | null;
  to: string | null;
  spend_type: SpendType | null;
  class_id: string | null;
  category_id: string | null;
  vendor_id: string | null;
  include: 'all' | 'bills';
  include_in_progress: boolean;
  today: string;
};

/** Data-quality warning attached to every report (credit lines, line mismatches, missing tables). */
export type Warning = {
  kind: string;
  message: string;
  qbo_bill_id?: string | null;
  vendor_name?: string | null;
  line_id?: string | null;
  amount?: number | null;
};

/** Rate labels the backend uses; UI copy should reuse these strings. */
export type RateLabels = {
  full_year: string;
  annualized: string;
  active_weeks: string;
  window: string;
  doc: string;
  hours_share: string;
};

/** Fields shared by every report payload. */
export type ReportEnvelope = {
  warnings: Warning[];
  filters: FilterEcho;
};

/** Turns filters into the axios `params` object (only set values, booleans as '1'). */
export function buildFilterParams(filters?: CostAnalyzerFilters | null): Record<string, string> {
  const params: Record<string, string> = {};
  if (!filters) return params;
  if (filters.from) params.from = filters.from;
  if (filters.to) params.to = filters.to;
  if (filters.spend_type) params.spend_type = filters.spend_type;
  if (filters.class_id) params.class_id = filters.class_id;
  if (filters.category_id) params.category_id = filters.category_id;
  if (filters.vendor_id) params.vendor_id = filters.vendor_id;
  if (filters.include) params.include = filters.include;
  if (filters.include_in_progress) params.include_in_progress = '1';
  return params;
}

/** Turns filters (+ optional extra keys) into a query string without the leading '?'. */
export function buildFilterQuery(
  filters?: CostAnalyzerFilters | null,
  extra?: Record<string, string | number | boolean | null | undefined>,
): string {
  const search = new URLSearchParams(buildFilterParams(filters));
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined || value === null || value === '') continue;
      search.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
    }
  }
  return search.toString();
}

/** True when any filter narrows the data. */
export function filtersActive(filters?: CostAnalyzerFilters | null): boolean {
  return Object.keys(buildFilterParams(filters)).length > 0;
}

// ── Shared fragments ────────────────────────────────────────────────────────

/** Minimal category reference. */
export type CategoryRef = { id: string; name: string; kind: CategoryKind };

/** Taxonomy row from GET /categories (cost_analyzer_categories). */
export type CategoryRow = CategoryRef & {
  sort_order: number;
  is_active: number | boolean;
};

/** A bill's effective category and how it was decided (spec §4.1). */
export type EffectiveCategory = CategoryRef & {
  source: BillCategorySource;
  confidence: number | null;
  rationale: string | null;
  keyword: string | null;
  vendor_category_id: string;
};

/** Attachment on a bill, with the inline viewer URL (relative to the site root). */
export type AttachmentLink = {
  id: string;
  original_name: string | null;
  mime_type: string | null;
  url: string;
  document_status: DocumentStatus | null;
};

/** Measured "Invoice $/hr" from extracted line items that list hours or days. */
export type DocHourlyBlock = {
  doc_hourly: number | null;
  doc_hourly_hours: number | null;
  doc_hourly_total: number;
  doc_daily: number | null;
  doc_daily_days: number | null;
  doc_daily_total: number;
  doc_daily_as_hourly: number | null;
  hours_per_day_assumed: number;
  n_docs_with_hours: number;
  n_docs_with_days: number;
  label: string;
};

/** Latest partial/ytd year rate, used as the fallback when no complete year exists. */
export type LatestAnnualized = {
  year: number;
  status: YearStatus;
  hourly_annualized: number | null;
  weeks_elapsed: number | null;
  label: string;
};

/** Implied rate over an active from/to filter window. */
export type HourlyWindow = {
  from: string;
  to: string;
  weeks_in_window: number;
  total: number;
  bills: number;
  hourly: number | null;
  reason: string | null;
  label: string;
};

/** A vendor's implied-hourly block (owner's 40 h/wk definition, spec §4.2). */
export type HourlyBlock = DocHourlyBlock & {
  is_trade: boolean;
  full_year_avg: number | null;
  full_year_avg_reason: string | null;
  full_year_years: number[];
  full_year_total: number;
  full_year_hours: number;
  full_year_label: string;
  latest_annualized: LatestAnnualized | null;
  labor_only_full_year_avg: number | null;
  labor_only_coverage: number | null;
  labor_only_reason: string | null;
  window: HourlyWindow | null;
  labels: RateLabels;
};

// ── Vendors (spec §4.2, §6) ─────────────────────────────────────────────────

/** One calendar year of a vendor's billing with every implied-rate basis. */
export type VendorYear = {
  year: number;
  status: YearStatus;
  bills: number;
  total: number;
  first: string;
  last: string;
  weeks_span: number;
  weeks_with_bills: number;
  weeks_elapsed: number | null;
  qualifies: boolean;
  reason: string | null;
  hourly_full_year: number | null;
  hourly_annualized: number | null;
  hourly_active_weeks: number | null;
  documented_total: number;
  material_total_from_documents: number;
  non_trade_total: number;
  labor_only_total: number;
  labor_only_coverage: number | null;
  labor_only_hourly: number | null;
};

/** Vendor spend on one class (project). */
export type VendorClassRow = {
  class_id: string;
  class_name: string;
  total: number;
  bills: number;
  share: number | null;
  implied_hours_share: number | null;
  implied_hours_share_label: string;
};

/** The vendor's Cost Analyzer category and provenance. */
export type VendorCategoryInfo = CategoryRef & {
  secondary_id: string | null;
  secondary_name: string | null;
  source: VendorCategorySource;
  confidence: number | null;
  rationale: string | null;
  needs_owner_input: boolean;
  confirmed_at: string | null;
  confirmed_by_name: string | null;
  set_by_name: string | null;
  set_at: string | null;
  row_id: string | null;
  needs_review: boolean;
};

/** The matching contractor_profiles row (Vendors page list). */
export type VendorProfileInfo = {
  id: string;
  category: string | null;
  secondary_category: string | null;
  is_supplier: boolean;
  supplier_marked_by: string | null;
  list_mismatch: boolean;
};

/** One vendor in GET /vendors. `id` is what every vendor endpoint accepts. */
export type VendorRow = {
  id: string;
  qbo_vendor_id: string | null;
  vendor_key: string;
  vendor_name: string;
  group_key: string;
  category: VendorCategoryInfo;
  profile: VendorProfileInfo | null;
  needs_review: boolean;
  total: number;
  bill_count: number;
  zero_amount_bills: number;
  first_bill: string | null;
  last_bill: string | null;
  in_scope_bill_count: number;
  in_scope_total: number;
  bills_elsewhere: { count: number; total: number };
  has_documents_share: number | null;
  documented_total: number;
  headline_hourly: number | null;
  headline_hourly_reason: string | null;
  years: VendorYear[];
  classes: VendorClassRow[];
  hourly: HourlyBlock;
};

/** A bill row inside the vendor drawer. */
export type VendorBillRow = {
  qbo_id: string;
  txn_date: string | null;
  total_amt: number;
  qbo_class_id: string | null;
  class_name: string;
  class_ids: string[];
  multi_class: boolean;
  private_note: string | null;
  spend_type: SpendType;
  payment_approval_status: string;
  zero_amount: boolean;
  lines_mismatch: boolean;
  has_document: boolean;
  effective_category: EffectiveCategory;
  attachments: AttachmentLink[];
};

/** cost_analyzer_vendor_category_history row. */
export type VendorHistoryRow = {
  id: string;
  vendor_category_id: string;
  vendor_name: string;
  from_category_id: string | null;
  to_category_id: string;
  from_secondary_id: string | null;
  to_secondary_id: string | null;
  source: string;
  confidence: number | null;
  rationale: string | null;
  set_by: string | null;
  set_by_name: string | null;
  set_at: string;
};

/** GET /vendors. */
export type VendorsResponse = ReportEnvelope & {
  vendors: VendorRow[];
  needs_review_count: number;
  labels: RateLabels;
};

/** GET /vendors/:id. */
export type VendorDetail = VendorRow & ReportEnvelope & {
  bills: VendorBillRow[];
  documents: DocumentRow[];
  items: MaterialItem[];
  history: VendorHistoryRow[];
  labels: RateLabels;
};

/** PUT /vendors/:id/category body. */
export type VendorCategoryInput = {
  category_id: string;
  secondary_category_id?: string | null;
};

/** One vendor changed by POST /vendors/auto-categorize (`vendor_id` = the new row id). */
export type AutoCategorizeChange = {
  vendor_name: string;
  vendor_id?: string | null;
  row_id?: string | null;
  qbo_vendor_id?: string | null;
  profile_id?: string | null;
  category_id: string;
  category_name?: string | null;
  confidence?: number | null;
  keyword?: string | null;
  rationale?: string | null;
};

/** POST /vendors/auto-categorize. */
export type AutoCategorizeResponse = {
  changes: AutoCategorizeChange[];
  scanned?: number;
  changed?: number;
  already_categorized?: number;
  unmatched?: number;
};

/**
 * Response of a vendor mutation (PUT category / POST confirm). `vendor` is the
 * refreshed detail entry, or null when the route could not rebuild it; tabs
 * should refetch the list after a mutation rather than rely on it.
 */
export type VendorMutationResponse = {
  vendor?: VendorDetail | null;
  changed?: boolean;
  history_id?: string | null;
  profile_list_mismatch?: boolean;
  history?: VendorHistoryRow[];
  [key: string]: unknown;
};

/** PUT /bills/:qboBillId/category response. */
export type BillCategoryResponse = {
  qbo_bill_id: string;
  category_id: string | null;
  source?: 'manual' | null;
  effective_category?: EffectiveCategory;
  [key: string]: unknown;
};

// ── Classes / projects (spec §4.3, §6) ──────────────────────────────────────

/** cost_analyzer_class_specs as returned (null when no row exists yet). */
export type ClassSpecs = {
  square_feet: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  units: number | null;
  stories: number | null;
  year_built: number | null;
  project_type: ProjectType | null;
  notes: string | null;
  project_id: string | null;
  updated_by: string | null;
  updated_by_name: string | null;
  updated_at: string | null;
};

/** PUT /classes/:id/specs body (send only the fields being changed). */
export type ClassSpecsInput = Partial<{
  square_feet: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  units: number | null;
  stories: number | null;
  year_built: number | null;
  project_type: ProjectType | null;
  notes: string | null;
  project_id: string | null;
}>;

/** Linked BuildTrack project (by quickbooks_class_id or specs.project_id). */
export type LinkedProject = {
  id: string;
  job_name: string;
  address: string | null;
  status: string | null;
  lifecycle_status: string | null;
  budget: number | null;
};

/** Vendor inside a class's category breakdown. */
export type ClassCategoryVendor = {
  vendor_id: string;
  qbo_vendor_id: string | null;
  name: string;
  total: number;
};

/** One category's slice of a class. */
export type ClassCategoryRow = CategoryRef & {
  total: number;
  share: number | null;
  bills: number;
  per_sqft: number | null;
  vendors: ClassCategoryVendor[];
};

/** One class (QBO class = property/project) in GET /classes. */
export type ClassRow = {
  qbo_class_id: string;
  class_name: string;
  linked_project: LinkedProject | null;
  specs: ClassSpecs | null;
  project_type: ProjectType | null;
  project_type_source: 'stored' | 'inferred' | null;
  total: number;
  bill_count: number;
  vendor_count: number;
  first_bill: string | null;
  last_bill: string | null;
  months_active: number;
  years_spanned: number | null;
  completeness: Completeness;
  spend_by_type: SpendByType;
  allocated_share: number | null;
  allocated_total: number;
  by_category: ClassCategoryRow[];
  documents_coverage: number | null;
  documented_total: number;
  per_sqft: number | null;
  per_sqft_reason: string | null;
  per_sqft_by_type: Record<SpendType, number | null>;
  maintenance_per_sqft_per_year: number | null;
  per_bedroom: number | null;
  per_bedroom_reason: string | null;
  per_bathroom: number | null;
  per_bathroom_reason: string | null;
  per_unit: number | null;
  per_unit_reason: string | null;
  material_per_sqft: number | null;
  labor_per_sqft: number | null;
  labor_and_material_per_sqft: number | null;
  items_material_total: number;
  items_labor_total: number;
  items_labor_and_material_total: number;
  items_coverage: number | null;
  items_coverage_reason: string | null;
  n_items: number;
};

/** Vendor row inside the class drawer. */
export type ClassVendorRow = {
  vendor_id: string;
  qbo_vendor_id: string | null;
  name: string;
  category: CategoryRef;
  total: number;
  bills: number;
  share: number | null;
};

/** Bill row inside the class drawer (`amount` = the part allocated to this class). */
export type ClassBillRow = {
  qbo_id: string;
  txn_date: string | null;
  vendor_id: string;
  vendor_name: string;
  amount: number;
  total_amt: number;
  private_note: string | null;
  spend_type: SpendType;
  multi_class: boolean;
  lines_mismatch: boolean;
  has_document: boolean;
  effective_category: EffectiveCategory;
  attachments: AttachmentLink[];
};

/** Material family totals on one class. */
export type ClassMaterialFamilyRow = {
  family: string;
  n_items: number;
  total: number;
  per_sqft: number | null;
};

/** GET /classes. */
export type ClassesResponse = ReportEnvelope & {
  classes: ClassRow[];
  classes_with_sqft: number;
};

/** GET /classes/:id. */
export type ClassDetail = ClassRow & ReportEnvelope & {
  vendors: ClassVendorRow[];
  bills: ClassBillRow[];
  materials: ClassMaterialFamilyRow[];
  items: MaterialItem[];
};

/** PUT /classes/:id/specs response; `class` is the refreshed detail or null. Tabs should refetch after saving. */
export type ClassSpecsSaveResponse = {
  qbo_class_id?: string;
  class_name?: string;
  specs?: ClassSpecs | null;
  class?: ClassDetail | null;
  [key: string]: unknown;
};

// ── Categories (spec §4.4, §6) ──────────────────────────────────────────────

/** Weighted per-sqft / per-bed / per-bath summary over complete classes. */
export type PerSpecSummary = {
  weighted: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  n_classes: number;
  n_in_progress_excluded: number;
  reason: string | null;
};

/** Vendor inside a category. */
export type CategoryVendorRow = {
  id: string;
  qbo_vendor_id: string | null;
  name: string;
  total: number;
  share: number | null;
  bills: number;
};

/** Category spend in one calendar year. */
export type CategoryYearRow = { year: number; total: number; bills: number };

/** Category spend on one class. */
export type CategoryClassRow = {
  class_id: string;
  name: string;
  total: number;
  bills: number;
  sqft: number | null;
  per_sqft: number | null;
  completeness: Completeness;
  in_weighting: boolean;
};

/** One qualifying complete vendor-year behind a category's FTE-weighted rate. */
export type VendorRateRow = {
  vendor_id: string;
  vendor: string;
  group_key: string;
  year: number;
  total: number;
  bills: number;
  hourly: number | null;
};

/** One category in GET /categories/stats. */
export type CategoryStatsRow = CategoryRef & DocHourlyBlock & {
  is_trade: boolean;
  total: number;
  share: number | null;
  bill_count: number;
  vendor_count: number;
  vendors: CategoryVendorRow[];
  by_year: CategoryYearRow[];
  by_spend_type: SpendByType;
  by_class: CategoryClassRow[];
  implied_hourly: number | null;
  implied_hourly_reason: string | null;
  implied_hourly_simple_mean: number | null;
  implied_hourly_label: string;
  vendor_rates: VendorRateRow[];
  n_vendor_years: number;
  n_vendors_qualifying: number;
  n_items: number;
  per_sqft_weighted: number | null;
  per_sqft_avg: number | null;
  per_sqft_min: number | null;
  per_sqft_max: number | null;
  n_classes_with_sqft: number;
  n_in_progress_excluded: number;
  per_sqft_reason: string | null;
  per_sqft_by_spend_type: Record<SpendType, PerSpecSummary>;
  per_bedroom: PerSpecSummary;
  per_bathroom: PerSpecSummary;
  include_in_progress: boolean;
};

/** Bill row inside the category drawer. */
export type CategoryBillRow = {
  qbo_id: string;
  txn_date: string | null;
  vendor_id: string;
  vendor_name: string;
  amount: number;
  total_amt: number;
  class_name: string;
  private_note: string | null;
  spend_type: SpendType;
  effective_category: EffectiveCategory;
  attachments: AttachmentLink[];
};

/** GET /categories/stats. */
export type CategoryStatsResponse = ReportEnvelope & {
  categories: CategoryStatsRow[];
  total: number;
  labels: RateLabels;
};

/** GET /categories/:id. */
export type CategoryDetail = CategoryStatsRow & ReportEnvelope & {
  bills: CategoryBillRow[];
  materials: { families: MaterialFamilyGroup[]; job_costs: JobCostGroup[] };
  labels: RateLabels;
};

// ── Materials (spec §4.5, §6) ───────────────────────────────────────────────

/** A sample line behind a material/job group (opens the source document via attachment_url). */
export type ItemSample = {
  vendor: string | null;
  date: string | null;
  class: string | null;
  description: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  line_total: number | null;
  attachment_id: string | null;
  qbo_bill_id: string | null;
  item_id: string;
  source: ItemSource;
  attachment_url: string | null;
};

/** Unit-priced group: family -> canonical type (+ spec). */
export type MaterialTypeGroup = {
  family: string;
  material_type: string;
  material_type_label: string;
  spec: string | null;
  n_items: number;
  n_documents: number;
  n_vendors: number;
  n_manual: number;
  dominant_unit: string | null;
  n_in_dominant_unit: number;
  avg_unit_price: number | null;
  median_unit_price: number | null;
  min_unit_price: number | null;
  max_unit_price: number | null;
  total_spend: number;
  raw_types_seen: string[];
  samples: ItemSample[];
};

/** Unit-priced family accordion. */
export type MaterialFamilyGroup = {
  family: string;
  n_items: number;
  n_types: number;
  total_spend: number;
  types: MaterialTypeGroup[];
};

/** Per-class row inside a job-cost group. */
export type JobCostClassRow = {
  class_id: string;
  class_name: string;
  n: number;
  total: number;
  sqft: number | null;
  per_sqft: number | null;
  completeness: Completeness | null;
};

/** Job-cost group (family-or-category x phase). */
export type JobCostGroup = {
  group_key: string;
  family: string | null;
  category_id: string | null;
  label: string;
  phase: string;
  n_jobs: number;
  n_documents: number;
  n_vendors: number;
  n_manual: number;
  avg_line_total: number | null;
  median_line_total: number | null;
  min_line_total: number | null;
  max_line_total: number | null;
  total: number;
  per_class: JobCostClassRow[];
  samples: ItemSample[];
};

/** Owner's answer state for a coverage target. */
export type TargetStatus = {
  status: TargetStatusValue;
  answer: string | null;
  answered_by: string | null;
  answered_by_name: string | null;
  answered_at: string | null;
};

/** One of the 12 owner targets with how many priced lines back it. */
export type CoverageTarget = {
  id: string;
  label: string;
  n_unit_items: number;
  n_job_items: number;
  n_items: number;
  status: CoverageStatus;
  avg_unit_price: number | null;
  avg_job_cost: number | null;
  target: TargetStatus;
};

/** Flat target list (`targets`), including rows not in the 12 defaults. */
export type MaterialTargetRow = TargetStatus & { target: string; label: string };

/**
 * One entry of the "Unknown - needs your input" list. `kind` is one of
 * text_stub | document_unreadable | document_failed | document_skipped |
 * totals_mismatch | item_needs_review | credit_line | lines_mismatch | target_empty
 * (resolved list: target_answered | target_not_applicable).
 */
export type UnknownItem = {
  kind: string;
  message: string;
  reason: string;
  attachment_id?: string | null;
  qbo_bill_id?: string | null;
  vendor_name?: string | null;
  txn_date?: string | null;
  bill_total?: number | null;
  document_total?: number | null;
  attempts?: number;
  item_id?: string;
  description?: string;
  line_id?: string | null;
  amount?: number;
  target?: string;
  label?: string;
  target_status?: TargetStatus;
};

/** Counts of cost_analyzer_documents by status (+ attachments on disk rows and items needing review). */
export type DocumentCounts = {
  rows: number;
  extracted: number;
  pending: number;
  running: number;
  failed: number;
  unreadable: number;
  skipped: number;
  duplicate: number;
  attachments: number;
  needs_review_items: number;
};

/** GET /materials. */
export type MaterialsResponse = ReportEnvelope & {
  families: MaterialFamilyGroup[];
  job_costs: JobCostGroup[];
  unknowns: UnknownItem[];
  resolved: UnknownItem[];
  coverage: CoverageTarget[];
  targets: MaterialTargetRow[];
  totals: {
    n_items: number;
    n_unit_items: number;
    n_job_items: number;
    n_manual_items: number;
    n_items_without_amount: number;
  };
  documents: DocumentCounts;
};

/** One extracted or manual line item (cost_analyzer_material_items). */
export type MaterialItem = {
  id: string;
  attachment_id: string | null;
  qbo_bill_id: string | null;
  qbo_class_id: string | null;
  class_name: string | null;
  vendor_name: string | null;
  txn_date: string | null;
  line_no: number;
  description: string;
  item_kind: ItemKind;
  material_family: string | null;
  material_type: string | null;
  material_type_raw: string | null;
  spec: string | null;
  phase: string | null;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  line_total: number | null;
  pricing_basis: PricingBasis | null;
  hours: number | null;
  days: number | null;
  rate: number | null;
  location: string | null;
  confidence: number | null;
  needs_review: boolean;
  review_reason: string | null;
  source: ItemSource;
  note: string | null;
  attachment_url: string | null;
};

/** GET /materials/items query. */
export type MaterialItemsQuery = {
  family?: string | null;
  type?: string | null;
  vendor_id?: string | null;
  class_id?: string | null;
  needs_review?: boolean | null;
  limit?: number | null;
  offset?: number | null;
};

/** GET /materials/items. */
export type MaterialItemsResponse = {
  items: MaterialItem[];
  total: number;
  limit: number;
  offset: number;
};

/** POST /materials/items body (manual price). */
export type MaterialItemInput = {
  description: string;
  material_family: MaterialFamily | string;
  material_type: string;
  spec?: string | null;
  unit: Unit | string;
  quantity?: number | null;
  unit_price: number | null;
  line_total?: number | null;
  item_kind?: ItemKind;
  phase?: Phase | null;
  qbo_bill_id?: string | null;
  attachment_id?: string | null;
  qbo_class_id?: string | null;
  note?: string | null;
};

/** PUT /materials/items/:itemId body (any subset). */
export type MaterialItemUpdate = Partial<MaterialItemInput> & {
  hours?: number | null;
  days?: number | null;
  rate?: number | null;
  location?: string | null;
  needs_review?: boolean;
  review_reason?: string | null;
};

/** PUT /materials/targets/:target body. */
export type MaterialTargetInput = {
  status: TargetStatusValue;
  answer?: string | null;
};

// ── Documents / scans (spec §5, §6) ─────────────────────────────────────────

/** cost_analyzer_scan_runs row. */
export type ScanRun = {
  id: string;
  started_by: string | null;
  started_by_name?: string | null;
  started_at: string;
  finished_at: string | null;
  heartbeat_at: string | null;
  status: ScanRunStatus;
  scope: string;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  input_tokens: number;
  output_tokens: number;
  error: string | null;
};

/** GET /documents/scan/status: the live run (or the most recent one) plus counts by status. */
export type ScanStatus = {
  run: ScanRun | null;
  active: boolean;
  counts: DocumentCounts;
  configured?: boolean;
  model?: string | null;
};

/** POST /documents/scan body. */
export type StartScanInput = {
  scope: ScanScope;
  attachment_ids?: string[];
};

/** One document row (cost_analyzer_documents joined to its bill). */
export type DocumentRow = {
  attachment_id: string;
  qbo_bill_id: string | null;
  vendor_name: string | null;
  txn_date: string | null;
  bill_total: number | null;
  status: DocumentStatus;
  doc_type: DocType | string | null;
  document_date: string | null;
  document_total: number | null;
  totals_match: boolean | null;
  totals_match_reason: string | null;
  labor_total: number | null;
  material_total: number | null;
  labor_hours: number | null;
  labor_days: number | null;
  labor_rate: number | null;
  labor_performed_by: string | null;
  suggested_category_id: string | null;
  suggested_category_confidence: number | null;
  summary: string | null;
  confidence: number | null;
  error: string | null;
  attempts: number;
  duplicate_of: string | null;
  bills_covered: string[];
  extracted_at: string | null;
  updated_at: string | null;
  attachment_url: string | null;
};

/** GET /documents. */
export type DocumentsResponse = {
  documents: DocumentRow[];
  counts: DocumentCounts;
  scan: ScanStatus;
  total: number;
  limit: number;
  offset: number;
};

/** GET /documents query. */
export type DocumentsQuery = {
  status?: DocumentStatus | '' | null;
  limit?: number | null;
  offset?: number | null;
};

/** An "unknown" the extractor reported for a document (plain text or a small object). */
export type DocumentUnknown = string | { message?: string; description?: string; field?: string; reason?: string };

/** GET /documents/:attachmentId: the row plus extraction details and its items. */
export type DocumentDetail = DocumentRow & {
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  started_at: string | null;
  content_hash?: string | null;
  unknowns: DocumentUnknown[];
  extracted: Record<string, unknown> | null;
  items: MaterialItem[];
};

/** Text of a document unknown regardless of its shape. */
export function documentUnknownText(entry: DocumentUnknown): string {
  if (typeof entry === 'string') return entry;
  if (!entry) return '';
  return entry.message || entry.description || entry.reason || entry.field || '';
}

// ── Overview (spec §6) ──────────────────────────────────────────────────────

/** Category slice on the overview. */
export type OverviewCategory = CategoryRef & {
  total: number;
  share: number | null;
  vendor_count: number;
};

/** Top vendor on the overview. */
export type TopVendorRow = {
  id: string;
  qbo_vendor_id: string | null;
  vendor_name: string;
  category: CategoryRef;
  total: number;
  bill_count: number;
  headline_hourly: number | null;
  headline_hourly_reason: string | null;
  latest_annualized: LatestAnnualized | null;
  needs_review: boolean;
};

/** GET /overview. */
export type OverviewResponse = ReportEnvelope & {
  totals: {
    spend: number;
    bills: number;
    vendors: number;
    vendors_categorized: number;
    vendors_needing_review: number;
    classes: number;
    classes_with_sqft: number;
  };
  spend_by_type: SpendByType;
  years_available: number[];
  categories: OverviewCategory[];
  top_vendors: TopVendorRow[];
  documents: DocumentCounts;
  last_scan: ScanRun | null;
  rate_caption: string;
  labels: RateLabels;
};

// ── Fetchers ────────────────────────────────────────────────────────────────

function enc(value: string): string {
  return encodeURIComponent(String(value));
}

/** GET /overview (also the source of `years_available` for the date presets). */
export async function getOverview(filters?: CostAnalyzerFilters | null): Promise<OverviewResponse> {
  const { data } = await api.get<OverviewResponse>(`${BASE}/overview`, { params: buildFilterParams(filters) });
  return data;
}

/** GET /categories: the taxonomy (accepts a bare array or `{ categories }`). */
export async function getCategories(): Promise<CategoryRow[]> {
  const { data } = await api.get<CategoryRow[] | { categories: CategoryRow[] }>(`${BASE}/categories`);
  if (Array.isArray(data)) return data;
  return data && Array.isArray(data.categories) ? data.categories : [];
}

/** GET /categories/stats. */
export async function getCategoryStats(filters?: CostAnalyzerFilters | null): Promise<CategoryStatsResponse> {
  const { data } = await api.get<CategoryStatsResponse>(`${BASE}/categories/stats`, { params: buildFilterParams(filters) });
  return data;
}

/** GET /categories/:id. */
export async function getCategoryDetail(categoryId: string, filters?: CostAnalyzerFilters | null): Promise<CategoryDetail> {
  const { data } = await api.get<CategoryDetail>(`${BASE}/categories/${enc(categoryId)}`, { params: buildFilterParams(filters) });
  return data;
}

/** GET /vendors (`include: 'all'` adds profile-only vendors with zero totals). */
export async function getVendors(filters?: CostAnalyzerFilters | null): Promise<VendorsResponse> {
  const { data } = await api.get<VendorsResponse>(`${BASE}/vendors`, { params: buildFilterParams(filters) });
  return data;
}

/** GET /vendors/:id (id = vendor row id, `qbo:<qboId>` or `profile:<profileId>`). */
export async function getVendorDetail(vendorId: string, filters?: CostAnalyzerFilters | null): Promise<VendorDetail> {
  const { data } = await api.get<VendorDetail>(`${BASE}/vendors/${enc(vendorId)}`, { params: buildFilterParams(filters) });
  return data;
}

/** GET /vendors/:id/history (accepts a bare array or `{ history }`). */
export async function getVendorHistory(vendorId: string): Promise<VendorHistoryRow[]> {
  const { data } = await api.get<VendorHistoryRow[] | { history: VendorHistoryRow[] }>(`${BASE}/vendors/${enc(vendorId)}/history`);
  if (Array.isArray(data)) return data;
  return data && Array.isArray(data.history) ? data.history : [];
}

/** PUT /vendors/:id/category: manual category (+ optional secondary), syncs the profile. */
export async function setVendorCategory(vendorId: string, body: VendorCategoryInput): Promise<VendorMutationResponse> {
  const { data } = await api.put<VendorMutationResponse>(`${BASE}/vendors/${enc(vendorId)}/category`, body);
  return data;
}

/** POST /vendors/:id/confirm: keeps the category, marks it manual/confirmed. */
export async function confirmVendorCategory(vendorId: string): Promise<VendorMutationResponse> {
  const { data } = await api.post<VendorMutationResponse>(`${BASE}/vendors/${enc(vendorId)}/confirm`, {});
  return data;
}

/** POST /vendors/auto-categorize: keyword classifier over vendors with no row. */
export async function autoCategorize(): Promise<AutoCategorizeResponse> {
  const { data } = await api.post<AutoCategorizeResponse>(`${BASE}/vendors/auto-categorize`, {});
  return data;
}

/** PUT /bills/:qboBillId/category: manual override (`null` clears it back to the vendor category). */
export async function setBillCategory(qboBillId: string, categoryId: string | null): Promise<BillCategoryResponse> {
  const { data } = await api.put<BillCategoryResponse>(`${BASE}/bills/${enc(qboBillId)}/category`, { category_id: categoryId });
  return data;
}

/** GET /classes. */
export async function getClasses(filters?: CostAnalyzerFilters | null): Promise<ClassesResponse> {
  const { data } = await api.get<ClassesResponse>(`${BASE}/classes`, { params: buildFilterParams(filters) });
  return data;
}

/** GET /classes/:id. */
export async function getClassDetail(classId: string, filters?: CostAnalyzerFilters | null): Promise<ClassDetail> {
  const { data } = await api.get<ClassDetail>(`${BASE}/classes/${enc(classId)}`, { params: buildFilterParams(filters) });
  return data;
}

/** PUT /classes/:id/specs (project managers may only fill empty fields; 403 otherwise). */
export async function saveClassSpecs(classId: string, body: ClassSpecsInput): Promise<ClassSpecsSaveResponse> {
  const { data } = await api.put<ClassSpecsSaveResponse>(`${BASE}/classes/${enc(classId)}/specs`, body);
  return data;
}

/** GET /materials. */
export async function getMaterials(filters?: CostAnalyzerFilters | null): Promise<MaterialsResponse> {
  const { data } = await api.get<MaterialsResponse>(`${BASE}/materials`, { params: buildFilterParams(filters) });
  return data;
}

/** GET /materials/items with paging (accepts a bare array or the paged object). */
export async function getMaterialItems(query?: MaterialItemsQuery | null): Promise<MaterialItemsResponse> {
  const params: Record<string, string> = {};
  if (query) {
    if (query.family) params.family = query.family;
    if (query.type) params.type = query.type;
    if (query.vendor_id) params.vendor_id = query.vendor_id;
    if (query.class_id) params.class_id = query.class_id;
    if (query.needs_review) params.needs_review = '1';
    if (typeof query.limit === 'number') params.limit = String(query.limit);
    if (typeof query.offset === 'number') params.offset = String(query.offset);
  }
  const { data } = await api.get<MaterialItemsResponse | MaterialItem[]>(`${BASE}/materials/items`, { params });
  if (Array.isArray(data)) {
    return { items: data, total: data.length, limit: data.length, offset: Number(params.offset) || 0 };
  }
  return data;
}

/** POST /materials/items: a manual price the owner supplies. */
export async function createMaterialItem(body: MaterialItemInput): Promise<MaterialItem> {
  const { data } = await api.post<MaterialItem | { item: MaterialItem }>(`${BASE}/materials/items`, body);
  return 'item' in data ? data.item : data;
}

/** PUT /materials/items/:itemId. */
export async function updateMaterialItem(itemId: string, body: MaterialItemUpdate): Promise<MaterialItem> {
  const { data } = await api.put<MaterialItem | { item: MaterialItem }>(`${BASE}/materials/items/${enc(itemId)}`, body);
  return 'item' in data ? data.item : data;
}

/** DELETE /materials/items/:itemId (manual items only). */
export async function deleteMaterialItem(itemId: string): Promise<void> {
  await api.delete(`${BASE}/materials/items/${enc(itemId)}`);
}

/** PUT /materials/targets/:target: answered / not applicable / open, with a note. */
export async function setMaterialTarget(target: string, body: MaterialTargetInput): Promise<MaterialTargetRow> {
  const { data } = await api.put<MaterialTargetRow | { target: MaterialTargetRow }>(`${BASE}/materials/targets/${enc(target)}`, body);
  // A bare row carries `status`; the wrapped form is `{ target: row }`.
  return 'status' in data ? data : data.target;
}

/** GET /documents?status=&limit=&offset= (documents are never filtered by date). */
export async function getDocuments(query?: DocumentsQuery | null): Promise<DocumentsResponse> {
  const params: Record<string, string> = {};
  if (query) {
    if (query.status) params.status = query.status;
    if (typeof query.limit === 'number') params.limit = String(query.limit);
    if (typeof query.offset === 'number') params.offset = String(query.offset);
  }
  const { data } = await api.get<DocumentsResponse>(`${BASE}/documents`, { params });
  return data;
}

/** GET /documents/:attachmentId. */
export async function getDocument(attachmentId: string): Promise<DocumentDetail> {
  const { data } = await api.get<DocumentDetail>(`${BASE}/documents/${enc(attachmentId)}`);
  return data;
}

/** GET /documents/scan/status (poll every 3 s while `active`). */
export async function getScanStatus(): Promise<ScanStatus> {
  const { data } = await api.get<ScanStatus>(`${BASE}/documents/scan/status`);
  return data;
}

/** POST /documents/scan (409 `{ error }` when a run is already active). */
export async function startScan(body: StartScanInput): Promise<ScanStatus> {
  const { data } = await api.post<ScanStatus>(`${BASE}/documents/scan`, body);
  return data;
}

/** POST /documents/scan/cancel: stops claiming; in-flight documents finish. */
export async function cancelScan(): Promise<ScanStatus> {
  const { data } = await api.post<ScanStatus>(`${BASE}/documents/scan/cancel`, {});
  return data;
}

/**
 * URL of the CSV export (site-relative, `/api/...`). The endpoint needs the Bearer
 * token, which a plain link does not carry - use downloadCsv() for the click.
 */
export function exportCsvUrl(report: ExportReport, filters?: CostAnalyzerFilters | null): string {
  return `/api${BASE}/export.csv?${buildFilterQuery(filters, { report })}`;
}

/** Fetches the CSV with auth and triggers a browser download. */
export async function downloadCsv(report: ExportReport, filters?: CostAnalyzerFilters | null): Promise<void> {
  const response = await api.get<Blob>(`${BASE}/export.csv`, {
    params: { ...buildFilterParams(filters), report },
    responseType: 'blob',
  });
  const disposition = String(response.headers['content-disposition'] || '');
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match ? match[1] : `cost-analyzer-${report}.csv`;
  const url = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// ── Formatters ──────────────────────────────────────────────────────────────

/** Placeholder for a missing number. */
export const dash = '—';

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const usdWhole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usdCents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$1,234.56" (or "$1,235" with digits 0); dash for null. */
export function money(value: number | null | undefined, digits: 0 | 2 = 2): string {
  if (!finite(value)) return dash;
  return (digits === 0 ? usdWhole : usdCents).format(value);
}

/** "$850" / "$1.2K" / "$4.2M"; dash for null. */
export function moneyCompact(value: number | null | undefined): string {
  if (!finite(value)) return dash;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const trim = (text: string) => text.replace(/\.0$/, '');
  if (abs >= 1_000_000) return `${sign}$${trim((abs / 1_000_000).toFixed(1))}M`;
  if (abs >= 1_000) return `${sign}$${trim((abs / 1_000).toFixed(1))}K`;
  return `${sign}$${Math.round(abs).toLocaleString('en-US')}`;
}

/** "$12.34/sq ft"; dash for null. */
export function perSqft(value: number | null | undefined): string {
  return finite(value) ? `${money(value)}/sq ft` : dash;
}

/** "$72.62/hr"; dash for null. */
export function rate(value: number | null | undefined): string {
  return finite(value) ? `${money(value)}/hr` : dash;
}

/** Fraction 0..1 -> "12.3%"; dash for null. */
export function pct(value: number | null | undefined, digits = 1): string {
  return finite(value) ? `${(value * 100).toFixed(digits)}%` : dash;
}

/** "1,234" (with up to `digits` decimals); dash for null. */
export function num(value: number | null | undefined, digits = 0): string {
  if (!finite(value)) return dash;
  return value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

/** "Mar 4, 2025" from 'YYYY-MM-DD' or an ISO datetime; dash for null. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return dash;
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Mar 4, 2025, 3:07 PM"; dash for null. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return dash;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Turns snake_case ids into "Sentence case" text. */
export function humanize(value: string | null | undefined): string {
  if (!value) return dash;
  const text = String(value).replace(/_/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Short owner-facing text for a null-rate reason code (spec §4.2 / §4.4). */
export const REASON_LABELS: Record<string, string> = {
  not_a_trade: 'not a trade',
  too_few_bills: 'fewer than 4 bills',
  span_too_short: 'active under 8 weeks',
  'no complete calendar year yet': 'no complete year yet',
};

/** Human label for a reason code; falls back to the raw reason text. */
export function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return '';
  return REASON_LABELS[reason] || reason;
}
