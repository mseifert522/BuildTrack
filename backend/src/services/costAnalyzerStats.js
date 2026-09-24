'use strict';

// Cost Analyzer analytics (spec §4). Every number on the Cost Analyzer page comes
// from this module: a handful of plain SELECTs load the QuickBooks bills, their
// lines and the cost-analyzer tables, then everything is joined and aggregated in
// plain JS over Maps so the functions are fast (~500 bills) and unit-testable.
//
// Conventions:
// - Every exported stats function is synchronous and takes (db, filters) where
//   `filters` is the object returned by parseFilters() (or {}).
// - Dates are compared as 'YYYY-MM-DD' strings. `filters.today` overrides the
//   current date so tests are deterministic.
// - Money is rounded to cents wherever it is summed. Ratios go through ratio()
//   and are null (never NaN/Infinity) when the denominator is missing; where the
//   spec asks for it a sibling `*_reason` string explains the null.
// - Owner's definition of the "implied hourly rate": amount billed divided by an
//   assumed 40-hour week, i.e. a complete calendar year is 40 h x 52 wk = 2,080 h.
//   It is a cost benchmark, not the contractor's wage.

const {
  CATEGORIES,
  CATEGORY_BY_ID,
  UNCATEGORIZED_ID,
  SPEND_TYPES,
  spendTypeForAccount,
  KEYWORD_RULES,
} = require('../data/costAnalyzerTaxonomy');
const {
  COVERAGE_TARGETS,
  MATERIAL_TYPES,
  itemMatchesTarget: matchesCoverageTarget,
} = require('../data/costAnalyzerMaterialTypes');

// ── Constants (spec §4 header) ──────────────────────────────────────────────
const HOURS_PER_WEEK = 40;          // owner's definition: a 40-hour work week
const HOURS_PER_YEAR = 2080;        // owner's definition: 40 h x 52 wk
const MIN_BILLS_FOR_HOURLY = 4;     // fewer bills in a year is not a work pattern
const MIN_WEEKS_FOR_HOURLY = 8;     // a vendor seen for < 8 weeks has no annual pace
const HOURS_PER_DAY = 8;            // day rates on invoices are shown as 8 h days
const UNASSIGNED_CLASS_ID = '__unassigned__';
const UNASSIGNED_CLASS_NAME = 'Unassigned';
const EXCLUDED_VENDOR_NAMES = ['great lakes mortgage fund']; // lender draws are not vendor cost
const IN_PROGRESS_RECENT_DAYS = 60; // a class billed in the last 60 days is still in progress
const LABOR_ONLY_MIN_COVERAGE = 0.5; // labor-only rate needs documents behind half the spend
const REVIEW_CONFIDENCE = 0.8;      // vendor guesses below this need the owner's eye
const DAY_MS = 24 * 60 * 60 * 1000;
const SAMPLE_LIMIT = 5;
const TOP_VENDORS_LIMIT = 10;

// Vendors whose own category is one of these are "open": any keyword may re-file a bill.
const OPEN_VENDOR_CATEGORIES = new Set([UNCATEGORIZED_ID, 'general-contractor']);
// Spec §4.1 (b): keywords that name a trade different from the vendor's own may move a
// bill even for a categorized vendor. Listed with their supplier twins so a supplier's
// "paint" bill can land on paint-supplies (same kind), never on a trade.
const KEYWORD_TRADE_SWITCH = new Set([
  'siding', 'roofing', 'drywall', 'hvac', 'plumbing', 'electrical', 'concrete-and-masonry',
  'painting', 'paint-supplies', 'cleaning', 'dumpster-and-hauling', 'demolition', 'insulation',
  'gutters', 'flooring', 'tile-and-stone', 'windows-and-doors',
]);
const RATE_LABELS = {
  full_year: 'Implied $/hr (÷2,080)',
  annualized: 'Annualized $/hr (partial year)',
  active_weeks: 'Implied $/hr (active weeks)',
  window: 'Implied $/hr (this window)',
  doc: 'Invoice $/hr',
  hours_share: 'share of 40-hr weeks (implied, not measured)',
};

// ── Small helpers ───────────────────────────────────────────────────────────
function ratio(n, d) {
  const num = Number(n);
  const den = Number(d);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
  const value = num / den;
  return Number.isFinite(value) ? value : null;
}

function round(value, places = 2) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const factor = 10 ** places;
  return Math.round((num + Number.EPSILON) * factor) / factor;
}

function cents(value) {
  const rounded = round(value, 2);
  return rounded === null ? 0 : rounded;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function mean(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  return nums.length ? nums.reduce((acc, v) => acc + v, 0) / nums.length : null;
}

function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function minOf(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  return nums.length ? Math.min(...nums) : null;
}

function maxOf(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  return nums.length ? Math.max(...nums) : null;
}

function sumBy(rows, fn) {
  let total = 0;
  for (const row of rows) total += Number(fn(row)) || 0;
  return cents(total);
}

function pushInto(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function vendorKeyOf(name) {
  return String(name || '').trim().toLowerCase();
}

function textOf(value) {
  return value === null || value === undefined ? '' : String(value);
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

// ── Date helpers (all UTC, all 'YYYY-MM-DD') ────────────────────────────────
function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  return new Date(ms).toISOString().slice(0, 10) === value;
}

function toIsoDate(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().slice(0, 10);
  return isIsoDate(text) ? text : null;
}

function dateMs(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function daysInclusive(fromIso, toIso) {
  return Math.round((dateMs(toIso) - dateMs(fromIso)) / DAY_MS) + 1;
}

function yearOf(iso) {
  return iso ? Number(iso.slice(0, 4)) : null;
}

// ISO-8601 week key ('2024-W05'): weeks start on Monday, week 1 holds the year's
// first Thursday. Used for the informational weeks_with_bills count.
function isoWeekKey(iso) {
  const date = new Date(dateMs(iso));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Owner's definition: weeks between the first and last bill, inclusive, at least 1.
function weeksSpanOf(firstIso, lastIso) {
  return Math.max(1, Math.ceil(daysInclusive(firstIso, lastIso) / 7));
}

function todayOf(filters) {
  const override = filters && toIsoDate(filters.today);
  return override || new Date().toISOString().slice(0, 10);
}

// ── Filters (spec §4.1) ─────────────────────────────────────────────────────
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;

function firstValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function cleanString(value) {
  const raw = firstValue(value);
  if (raw === undefined || raw === null) return '';
  return String(raw).trim();
}

// Returns { ok: true, filters } or { ok: false, error }. Never throws.
function parseFilters(query) {
  const q = query && typeof query === 'object' ? query : {};
  const filters = {
    from: null,
    to: null,
    spend_type: null,
    class_id: null,
    category_id: null,
    vendor_id: null,
    include: 'bills',
    include_in_progress: false,
    today: null,
  };
  const bad = error => ({ ok: false, error });

  const from = cleanString(q.from);
  if (from) {
    if (!isIsoDate(from)) return bad('from must be a date formatted YYYY-MM-DD');
    filters.from = from;
  }
  const to = cleanString(q.to);
  if (to) {
    if (!isIsoDate(to)) return bad('to must be a date formatted YYYY-MM-DD');
    filters.to = to;
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    return bad('from must be on or before to');
  }

  const spendType = cleanString(q.spend_type);
  if (spendType) {
    if (!SPEND_TYPES.includes(spendType)) return bad(`spend_type must be one of ${SPEND_TYPES.join(', ')}`);
    filters.spend_type = spendType;
  }

  const classId = cleanString(q.class_id);
  if (classId) {
    if (!ID_PATTERN.test(classId)) return bad('class_id is not a valid class id');
    filters.class_id = classId;
  }

  const categoryId = cleanString(q.category_id);
  if (categoryId) {
    if (!taxonomyCategory(categoryId)) return bad('category_id is not a known cost category');
    filters.category_id = categoryId;
  }

  const vendorId = cleanString(q.vendor_id);
  if (vendorId) {
    if (!ID_PATTERN.test(vendorId)) return bad('vendor_id is not a valid vendor id');
    filters.vendor_id = vendorId;
  }

  const include = cleanString(q.include).toLowerCase();
  if (include) {
    if (!['all', 'bills'].includes(include)) return bad('include must be all or bills');
    filters.include = include;
  }

  const includeInProgress = cleanString(q.include_in_progress).toLowerCase();
  if (includeInProgress) {
    if (!['0', '1', 'true', 'false'].includes(includeInProgress)) return bad('include_in_progress must be 1 or 0');
    filters.include_in_progress = includeInProgress === '1' || includeInProgress === 'true';
  }

  // Test aid: freezes "today" so year status / weeks elapsed are deterministic.
  const today = cleanString(q.today);
  if (today) {
    if (!isIsoDate(today)) return bad('today must be a date formatted YYYY-MM-DD');
    filters.today = today;
  }

  return { ok: true, filters };
}

function normalizeFilters(filters) {
  const source = filters && typeof filters === 'object' ? filters : {};
  return {
    from: toIsoDate(source.from),
    to: toIsoDate(source.to),
    spend_type: SPEND_TYPES.includes(source.spend_type) ? source.spend_type : null,
    class_id: source.class_id ? String(source.class_id) : null,
    category_id: source.category_id ? String(source.category_id) : null,
    vendor_id: source.vendor_id ? String(source.vendor_id) : null,
    include: source.include === 'all' ? 'all' : 'bills',
    include_in_progress: source.include_in_progress === true || source.include_in_progress === 1 || source.include_in_progress === '1',
    today: todayOf(source),
  };
}

// ── Taxonomy helpers ────────────────────────────────────────────────────────
// Taxonomy lookup tolerant of CATEGORY_BY_ID being a plain object or a Map, with a
// scan of CATEGORIES as the last resort.
function taxonomyCategory(id) {
  if (!id) return null;
  let category = null;
  if (CATEGORY_BY_ID instanceof Map) category = CATEGORY_BY_ID.get(id) || null;
  else if (CATEGORY_BY_ID && typeof CATEGORY_BY_ID === 'object') category = CATEGORY_BY_ID[id] || null;
  if (!category && Array.isArray(CATEGORIES)) category = CATEGORIES.find(entry => entry && entry.id === id) || null;
  if (category) return { id: category.id, name: category.name, kind: category.kind };
  return null;
}

// Category lookup: DB row (cost_analyzer_categories) first, taxonomy second, then a
// placeholder so an unknown id never crashes a report.
function categoryInfo(ctx, id) {
  const wanted = id || UNCATEGORIZED_ID;
  const fromDb = ctx && ctx.categoriesById ? ctx.categoriesById.get(wanted) : null;
  if (fromDb) return { id: fromDb.id, name: fromDb.name, kind: fromDb.kind };
  return taxonomyCategory(wanted) || { id: wanted, name: wanted, kind: 'other' };
}

function kindOf(categoryId) {
  const category = taxonomyCategory(categoryId);
  return category ? category.kind : 'other';
}

// General Contractor is a trade for the hourly benchmark (spec §4.2) even if a
// future taxonomy edit re-kinds it.
function isTradeCategory(categoryId, kind) {
  return kind === 'trade' || categoryId === 'general-contractor';
}

function spendTypeOf(accountName) {
  let value = null;
  try {
    value = typeof spendTypeForAccount === 'function' ? spendTypeForAccount(accountName) : null;
  } catch (_) {
    value = null;
  }
  return SPEND_TYPES.includes(value) ? value : 'other';
}

// Keyword rules are compiled once. A rule's pattern may arrive as a RegExp or a
// regex source string; the 'g' flag is dropped so .test() never carries lastIndex.
let compiledKeywordRules = null;
function keywordRules() {
  if (compiledKeywordRules) return compiledKeywordRules;
  compiledKeywordRules = [];
  for (const rule of Array.isArray(KEYWORD_RULES) ? KEYWORD_RULES : []) {
    if (!rule || !rule.category_id || !rule.pattern) continue;
    let pattern = null;
    try {
      if (rule.pattern instanceof RegExp) {
        const flags = rule.pattern.flags.replace('g', '');
        pattern = new RegExp(rule.pattern.source, flags.includes('i') ? flags : `${flags}i`);
      } else {
        pattern = new RegExp(String(rule.pattern), 'i');
      }
    } catch (_) {
      pattern = null;
    }
    if (!pattern) continue;
    compiledKeywordRules.push({
      pattern,
      category_id: String(rule.category_id),
      kinds: Array.isArray(rule.kinds) ? rule.kinds.map(String) : [],
    });
  }
  return compiledKeywordRules;
}

// Spec §4.1 keyword rule, computed on read (never persisted). Returns the winning
// rule or null. Rules apply only when the vendor is "open" (uncategorized /
// general-contractor) or the keyword names a different trade, and may only move a
// bill to a category of the vendor's own kind (a supplier's "paint" bill goes to
// paint-supplies, never to the Painting trade). There is deliberately no
// "management fee" rule: a carpenter's management fee stays carpentry.
function keywordMatch(text, vendorCategoryId) {
  if (!text) return null;
  const vendorCat = vendorCategoryId || UNCATEGORIZED_ID;
  const vendorKind = kindOf(vendorCat);
  const open = OPEN_VENDOR_CATEGORIES.has(vendorCat);
  const uncategorized = vendorCat === UNCATEGORIZED_ID;
  const candidates = [];
  for (const rule of keywordRules()) {
    if (rule.category_id === vendorCat || rule.category_id === UNCATEGORIZED_ID) continue;
    if (!taxonomyCategory(rule.category_id)) continue;
    if (!rule.pattern.test(text)) continue;
    const targetKind = kindOf(rule.category_id);
    if (uncategorized) {
      candidates.push({ rule, targetKind });
      continue;
    }
    if (rule.kinds.length && !rule.kinds.includes(vendorKind)) continue;
    if (targetKind !== vendorKind) continue;
    if (!open && !KEYWORD_TRADE_SWITCH.has(rule.category_id)) continue;
    candidates.push({ rule, targetKind });
  }
  if (!candidates.length) return null;
  // An uncategorized vendor with an ambiguous keyword ("paint": trade or supplier)
  // is filed as the trade — the bills in this ledger are overwhelmingly labor.
  const preferred = candidates.find(c => c.targetKind === 'trade') || candidates[0];
  return preferred.rule;
}

// Effective category of one bill (spec §4.1): manual override > AI suggestion >
// keyword rule > vendor category > uncategorized. Pure: no DB access.
function effectiveCategoryForBill(bill, lines, vendorRow, overrideRow) {
  const vendorCategoryId = vendorRow && vendorRow.category_id ? String(vendorRow.category_id) : UNCATEGORIZED_ID;
  const base = { vendor_category_id: vendorCategoryId, keyword: null, rationale: null, confidence: null };

  if (overrideRow && overrideRow.category_id) {
    const source = overrideRow.source === 'manual' ? 'manual' : 'ai';
    return {
      ...base,
      category_id: String(overrideRow.category_id),
      source,
      confidence: source === 'manual' ? 1 : numberOrNull(overrideRow.confidence),
      rationale: overrideRow.rationale || null,
    };
  }

  const text = [textOf(bill && bill.private_note), ...(Array.isArray(lines) ? lines : []).map(line => textOf(line && line.description))]
    .filter(Boolean)
    .join(' \n ');
  const rule = keywordMatch(text, vendorCategoryId);
  if (rule) {
    return {
      ...base,
      category_id: rule.category_id,
      source: 'keyword',
      confidence: null,
      keyword: rule.pattern.source,
      rationale: `bill text matches /${rule.pattern.source}/`,
    };
  }

  if (vendorCategoryId !== UNCATEGORIZED_ID) {
    return {
      ...base,
      category_id: vendorCategoryId,
      source: 'vendor',
      confidence: vendorRow ? numberOrNull(vendorRow.confidence) : null,
      rationale: vendorRow ? vendorRow.rationale || null : null,
    };
  }
  return { ...base, category_id: UNCATEGORIZED_ID, source: 'uncategorized' };
}

// ── Scope and allocation (spec §4.1) ────────────────────────────────────────
function billInScope(bill, suppressedVendorIds) {
  if (!bill) return false;
  if (String(bill.payment_approval_status || 'not_approved') === 'deleted_from_buildtrack') return false;
  if (bill.vendor_id !== null && bill.vendor_id !== undefined && suppressedVendorIds.has(String(bill.vendor_id))) return false;
  if (EXCLUDED_VENDOR_NAMES.includes(vendorKeyOf(bill.vendor_name))) return false;
  return true;
}

function resolveVendorRow(vendorRowByQboId, vendorRowByKey, qboVendorId, vendorKey) {
  if (qboVendorId && vendorRowByQboId.has(qboVendorId)) return vendorRowByQboId.get(qboVendorId);
  if (vendorKey && vendorRowByKey.has(vendorKey)) return vendorRowByKey.get(vendorKey);
  return null;
}

// Pure allocation builder: one row per bill line (bills without lines get one row for
// the bill total), residual rows when lines do not add up, credit warnings, and the
// effective category of every bill. `bill.qbo_class_id` is display-only; every
// aggregate reads the rows returned here.
function buildAllocations(bills, lines, options = {}) {
  const suppressedVendorIds = options.suppressedVendorIds || new Set();
  const vendorRowByQboId = options.vendorRowByQboId || new Map();
  const vendorRowByKey = options.vendorRowByKey || new Map();
  const overrideByBill = options.overrideByBill || new Map();
  const documentedBillIds = options.documentedBillIds || new Set();
  const warnings = [];
  const allocations = [];
  const billMeta = new Map();
  const classNames = new Map([[UNASSIGNED_CLASS_ID, UNASSIGNED_CLASS_NAME]]);

  const linesByBill = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    if (!line || line.qbo_bill_id === null || line.qbo_bill_id === undefined) continue;
    pushInto(linesByBill, String(line.qbo_bill_id), line);
  }

  const rememberClass = (id, name) => {
    if (id && name && !classNames.has(id)) classNames.set(id, String(name));
  };

  for (const bill of Array.isArray(bills) ? bills : []) {
    if (!billInScope(bill, suppressedVendorIds)) continue;
    const billId = String(bill.qbo_id);
    const qboVendorId = bill.vendor_id === null || bill.vendor_id === undefined ? null : String(bill.vendor_id);
    const vendorKey = vendorKeyOf(bill.vendor_name);
    const vendorRow = resolveVendorRow(vendorRowByQboId, vendorRowByKey, qboVendorId, vendorKey);
    const billLines = (linesByBill.get(billId) || [])
      .slice()
      .sort((a, b) => (Number(a.line_num) || 0) - (Number(b.line_num) || 0));
    const effective = effectiveCategoryForBill(bill, billLines, vendorRow, overrideByBill.get(billId) || null);
    const total = cents(bill.total_amt);
    const zeroAmount = total === 0;
    const txnDate = toIsoDate(bill.txn_date);
    const billClassId = bill.qbo_class_id ? String(bill.qbo_class_id) : null;
    rememberClass(billClassId, bill.qbo_class_name);
    const hasDocument = documentedBillIds.has(billId);

    const baseRow = {
      qbo_bill_id: billId,
      vendor_id: qboVendorId,
      vendor_key: vendorKey,
      vendor_name: textOf(bill.vendor_name).trim(),
      txn_date: txnDate,
      year: yearOf(txnDate),
      effective_category_id: effective.category_id,
      category_source: effective.source,
      bill_total: total,
      bill_note: bill.private_note || null,
      has_document: hasDocument,
      zero_amount: zeroAmount,
    };

    const rows = [];
    const classIds = new Set();
    let linesMismatch = false;
    if (billLines.length === 0) {
      const classId = billClassId || UNASSIGNED_CLASS_ID;
      classIds.add(classId);
      rows.push({
        ...baseRow,
        line_id: null,
        class_id: classId,
        class_name: classNames.get(classId) || classId,
        amount: total,
        spend_type: spendTypeOf(null),
        account_name: null,
        is_residual: false,
        is_credit: total < 0,
        from_line_allocation: false,
      });
    } else {
      let lineSum = 0;
      for (const line of billLines) {
        const amount = cents(line.amount);
        const classId = line.class_id ? String(line.class_id) : (billClassId || UNASSIGNED_CLASS_ID);
        if (line.class_id) rememberClass(classId, line.class_name);
        classIds.add(classId);
        lineSum += amount;
        rows.push({
          ...baseRow,
          line_id: line.id || null,
          class_id: classId,
          class_name: classNames.get(classId) || classId,
          amount,
          spend_type: spendTypeOf(line.category_name),
          account_name: line.category_name || null,
          is_residual: false,
          is_credit: amount < 0,
          from_line_allocation: false,
        });
        if (amount < 0) {
          warnings.push({
            kind: 'credit_line',
            qbo_bill_id: billId,
            vendor_name: baseRow.vendor_name,
            line_id: line.id || null,
            amount,
            message: `credit line on bill ${billId} (${baseRow.vendor_name}): ${textOf(line.description).trim() || 'no description'} ${amount}`,
          });
        }
      }
      const residual = cents(total - cents(lineSum));
      if (Math.abs(residual) > 0.01) {
        linesMismatch = true;
        const classId = billClassId || UNASSIGNED_CLASS_ID;
        classIds.add(classId);
        rows.push({
          ...baseRow,
          line_id: null,
          class_id: classId,
          class_name: classNames.get(classId) || classId,
          amount: residual,
          spend_type: rows[0].spend_type,
          account_name: rows[0].account_name,
          is_residual: true,
          is_credit: residual < 0,
          from_line_allocation: false,
        });
        warnings.push({
          kind: 'lines_mismatch',
          qbo_bill_id: billId,
          vendor_name: baseRow.vendor_name,
          amount: residual,
          message: `bill ${billId} (${baseRow.vendor_name}): lines add up to ${cents(lineSum)} but the bill total is ${total}; residual ${residual} allocated to ${classNames.get(classId) || classId}`,
        });
      }
    }

    const multiClass = classIds.size > 1;
    if (multiClass) for (const row of rows) row.from_line_allocation = true;

    const spendByType = {};
    for (const row of rows) spendByType[row.spend_type] = (spendByType[row.spend_type] || 0) + row.amount;
    const dominantSpendType = Object.entries(spendByType).sort((a, b) => b[1] - a[1])[0];

    billMeta.set(billId, {
      qbo_id: billId,
      vendor_id: qboVendorId,
      vendor_key: vendorKey,
      vendor_name: baseRow.vendor_name,
      txn_date: txnDate,
      year: baseRow.year,
      total_amt: total,
      private_note: bill.private_note || null,
      qbo_class_id: billClassId,
      qbo_class_name: bill.qbo_class_name || null,
      project_id: bill.project_id || null,
      payment_approval_status: bill.payment_approval_status || 'not_approved',
      zero_amount: zeroAmount,
      lines_mismatch: linesMismatch,
      multi_class: multiClass,
      line_count: billLines.length,
      class_ids: Array.from(classIds),
      spend_type: dominantSpendType ? dominantSpendType[0] : 'other',
      effective_category_id: effective.category_id,
      category_source: effective.source,
      category_confidence: effective.confidence,
      category_rationale: effective.rationale,
      category_keyword: effective.keyword,
      vendor_category_id: effective.vendor_category_id,
      has_document: hasDocument,
      allocations: rows,
    });
    allocations.push(...rows);
  }

  // Class names are only known once every line has been read: backfill rows that
  // were created before a later line named the class.
  for (const row of allocations) {
    const known = classNames.get(row.class_id);
    if (known && row.class_name !== known) row.class_name = known;
  }

  return { allocations, bills: billMeta, warnings, classNames };
}

// ── Loading (a few plain SELECTs; joins happen in JS) ───────────────────────
// Cost-analyzer tables are created by initializeSchema(); during a blue/green
// deploy the old container may briefly query before green's schema pass ran, so a
// missing table degrades to "no rows" with a warning instead of a 500.
function tryAll(db, sql, warnings, label) {
  try {
    return db.prepare(sql).all();
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) {
      warnings.push({ kind: 'missing_table', message: `${label} is not available yet` });
      return [];
    }
    throw err;
  }
}

function loadRows(db) {
  const warnings = [];
  const bills = db.prepare(`
    SELECT qbo_id, vendor_id, vendor_name, txn_date, total_amt, balance, private_note, project_id,
           qbo_class_id, qbo_class_name, payment_approval_status
    FROM quickbooks_bills
    WHERE COALESCE(payment_approval_status, 'not_approved') != 'deleted_from_buildtrack'
  `).all();
  const lines = db.prepare(`
    SELECT id, qbo_bill_id, line_num, description, amount, category_name, class_id, class_name, project_id
    FROM quickbooks_bill_lines
    ORDER BY qbo_bill_id ASC, line_num ASC
  `).all();
  const suppressions = db.prepare('SELECT qbo_id FROM quickbooks_vendor_suppressions').all();
  const qboVendors = db.prepare('SELECT qbo_id, display_name, company_name, active FROM quickbooks_vendors').all();
  const attachments = db.prepare('SELECT id, qbo_bill_id, mime_type, original_name, size FROM quickbooks_bill_attachments').all();
  const profiles = db.prepare(`
    SELECT id, vendor_name, contractor_category, contractor_secondary_category, is_supplier,
           supplier_marked_by, quickbooks_vendor_id, source
    FROM contractor_profiles
  `).all();
  const projects = db.prepare(`
    SELECT id, job_name, address, status, lifecycle_status, budget, sold_date, quickbooks_class_id, quickbooks_class_name
    FROM projects
  `).all();
  const users = db.prepare('SELECT id, name FROM users').all();
  const categories = tryAll(db, `
    SELECT id, name, kind, sort_order, is_active FROM cost_analyzer_categories ORDER BY sort_order ASC, name ASC
  `, warnings, 'cost_analyzer_categories');
  const vendorRows = tryAll(db, `
    SELECT id, vendor_key, qbo_vendor_id, profile_id, vendor_name, category_id, secondary_category_id, source,
           confidence, rationale, needs_owner_input, confirmed_by, confirmed_at, previous_profile_category,
           profile_synced_at, set_by, set_at, updated_at
    FROM cost_analyzer_vendor_categories
  `, warnings, 'cost_analyzer_vendor_categories');
  const overrides = tryAll(db, `
    SELECT qbo_bill_id, category_id, source, confidence, rationale, set_by, set_at FROM cost_analyzer_bill_categories
  `, warnings, 'cost_analyzer_bill_categories');
  const classSpecs = tryAll(db, `
    SELECT qbo_class_id, class_name, project_id, square_feet, bedrooms, bathrooms, units, stories, year_built,
           project_type, notes, updated_by, updated_at
    FROM cost_analyzer_class_specs
  `, warnings, 'cost_analyzer_class_specs');
  const documents = tryAll(db, `
    SELECT attachment_id, qbo_bill_id, status, content_hash, duplicate_of, bills_covered_json, model, doc_type,
           vendor_on_document, document_date, document_total, totals_match, totals_match_reason, labor_total,
           material_total, labor_hours, labor_days, labor_rate, labor_performed_by, suggested_category_id,
           suggested_category_confidence, summary, unknowns_json, confidence, error, input_tokens, output_tokens,
           attempts, started_at, extracted_at, updated_at
    FROM cost_analyzer_documents
  `, warnings, 'cost_analyzer_documents');
  const items = tryAll(db, `
    SELECT id, attachment_id, qbo_bill_id, qbo_class_id, line_no, description, item_kind, material_family,
           material_type, material_type_raw, spec, phase, quantity, unit, unit_price, line_total, pricing_basis,
           hours, days, rate, location, confidence, needs_review, review_reason, source, note, set_by,
           created_at, updated_at
    FROM cost_analyzer_material_items
  `, warnings, 'cost_analyzer_material_items');
  const targets = tryAll(db, `
    SELECT target, status, answer, answered_by, answered_at FROM cost_analyzer_material_targets
  `, warnings, 'cost_analyzer_material_targets');
  const scanRuns = tryAll(db, `
    SELECT id, started_by, started_at, finished_at, heartbeat_at, status, scope, total, done, failed, skipped,
           input_tokens, output_tokens, error
    FROM cost_analyzer_scan_runs
    ORDER BY started_at DESC
    LIMIT 1
  `, warnings, 'cost_analyzer_scan_runs');

  return {
    warnings, bills, lines, suppressions, qboVendors, attachments, profiles, projects, users,
    categories, vendorRows, overrides, classSpecs, documents, items, targets, scanRuns,
  };
}

// Which bills have a readable, extracted document behind them: the document's own
// bill, every bill it covers (bills_covered_json), and bills whose attachment was a
// byte-identical duplicate of an extracted file.
function documentedBillIds(documents) {
  const ids = new Set();
  const byAttachment = new Map(documents.map(doc => [String(doc.attachment_id), doc]));
  for (const doc of documents) {
    if (doc.status === 'extracted') {
      if (doc.qbo_bill_id) ids.add(String(doc.qbo_bill_id));
      for (const covered of parseJsonArray(doc.bills_covered_json)) ids.add(String(covered));
    }
  }
  for (const doc of documents) {
    if (doc.status !== 'duplicate' || !doc.duplicate_of) continue;
    const original = byAttachment.get(String(doc.duplicate_of));
    if (original && original.status === 'extracted' && doc.qbo_bill_id) ids.add(String(doc.qbo_bill_id));
  }
  return ids;
}

// Items count once per content hash (spec §4.5): when two extracted documents share
// a hash only the earliest extraction's items are used. Manual items always count.
function dedupeItems(items, documents) {
  const docByAttachment = new Map(documents.map(doc => [String(doc.attachment_id), doc]));
  const ownerByHash = new Map();
  const extracted = documents
    .filter(doc => doc.status === 'extracted' && doc.content_hash)
    .sort((a, b) => textOf(a.extracted_at).localeCompare(textOf(b.extracted_at)));
  for (const doc of extracted) {
    if (!ownerByHash.has(doc.content_hash)) ownerByHash.set(doc.content_hash, String(doc.attachment_id));
  }
  const kept = [];
  for (const item of items) {
    if (!item.attachment_id) {
      kept.push(item);
      continue;
    }
    const doc = docByAttachment.get(String(item.attachment_id));
    if (!doc) {
      kept.push(item);
      continue;
    }
    if (doc.status !== 'extracted') continue;
    if (doc.content_hash && ownerByHash.get(doc.content_hash) !== String(doc.attachment_id)) continue;
    kept.push(item);
  }
  return kept;
}

function buildContext(db, rawFilters) {
  const filters = normalizeFilters(rawFilters);
  const raw = loadRows(db);
  const suppressedVendorIds = new Set(raw.suppressions.map(row => String(row.qbo_id)));

  const vendorRowByQboId = new Map();
  const vendorRowByKey = new Map();
  const vendorRowById = new Map();
  const vendorRowByProfileId = new Map();
  for (const row of raw.vendorRows) {
    vendorRowById.set(String(row.id), row);
    if (row.qbo_vendor_id) vendorRowByQboId.set(String(row.qbo_vendor_id), row);
    if (row.vendor_key) vendorRowByKey.set(String(row.vendor_key), row);
    if (row.profile_id) vendorRowByProfileId.set(String(row.profile_id), row);
  }
  const overrideByBill = new Map(raw.overrides.map(row => [String(row.qbo_bill_id), row]));
  const documented = documentedBillIds(raw.documents);

  const built = buildAllocations(raw.bills, raw.lines, {
    suppressedVendorIds, vendorRowByQboId, vendorRowByKey, overrideByBill, documentedBillIds: documented,
  });

  const profileByQboId = new Map();
  const profileByKey = new Map();
  const profileById = new Map();
  for (const profile of raw.profiles) {
    profileById.set(String(profile.id), profile);
    if (profile.quickbooks_vendor_id) profileByQboId.set(String(profile.quickbooks_vendor_id), profile);
    const key = vendorKeyOf(profile.vendor_name);
    if (key && !profileByKey.has(key)) profileByKey.set(key, profile);
  }
  const qboVendorById = new Map();
  const qboVendorByKey = new Map();
  for (const vendor of raw.qboVendors) {
    qboVendorById.set(String(vendor.qbo_id), vendor);
    const key = vendorKeyOf(vendor.display_name);
    if (key && !qboVendorByKey.has(key)) qboVendorByKey.set(key, vendor);
  }

  const categoriesById = new Map();
  for (const category of raw.categories) categoriesById.set(String(category.id), category);
  if (!categoriesById.size) for (const category of CATEGORIES) categoriesById.set(category.id, { ...category, is_active: 1 });

  const projectByClassId = new Map();
  const projectById = new Map();
  for (const project of raw.projects) {
    projectById.set(String(project.id), project);
    if (project.quickbooks_class_id) projectByClassId.set(String(project.quickbooks_class_id), project);
  }
  const specByClassId = new Map(raw.classSpecs.map(spec => [String(spec.qbo_class_id), spec]));
  const userNameById = new Map(raw.users.map(user => [String(user.id), user.name]));
  const documentByAttachment = new Map(raw.documents.map(doc => [String(doc.attachment_id), doc]));
  const documentsByBill = new Map();
  for (const doc of raw.documents) if (doc.qbo_bill_id) pushInto(documentsByBill, String(doc.qbo_bill_id), doc);
  const attachmentsByBill = new Map();
  const attachmentById = new Map();
  for (const attachment of raw.attachments) {
    attachmentById.set(String(attachment.id), attachment);
    pushInto(attachmentsByBill, String(attachment.qbo_bill_id), attachment);
  }
  const targetByKey = new Map(raw.targets.map(row => [String(row.target), row]));

  const items = dedupeItems(raw.items, raw.documents).map(item => {
    const doc = item.attachment_id ? documentByAttachment.get(String(item.attachment_id)) : null;
    const billId = item.qbo_bill_id ? String(item.qbo_bill_id) : (doc && doc.qbo_bill_id ? String(doc.qbo_bill_id) : null);
    const bill = billId ? built.bills.get(billId) || null : null;
    // Items carry the class the extractor could pin down; a single-class bill is a safe fallback.
    const classId = item.qbo_class_id ? String(item.qbo_class_id) : (bill && bill.class_ids.length === 1 ? bill.class_ids[0] : null);
    return { ...item, bill_id: billId, bill, class_id: classId, document: doc || null };
  });

  const ctx = {
    filters,
    today: filters.today,
    currentYear: yearOf(filters.today),
    warnings: raw.warnings.concat(built.warnings),
    allocations: built.allocations,
    bills: built.bills,
    classNames: built.classNames,
    suppressedVendorIds,
    vendorRows: raw.vendorRows,
    vendorRowByQboId, vendorRowByKey, vendorRowById, vendorRowByProfileId,
    profiles: raw.profiles, profileByQboId, profileByKey, profileById,
    qboVendorById, qboVendorByKey,
    categories: Array.from(categoriesById.values()),
    categoriesById,
    projects: raw.projects, projectByClassId, projectById,
    classSpecs: raw.classSpecs, specByClassId,
    userNameById,
    documents: raw.documents, documentByAttachment, documentsByBill,
    attachments: raw.attachments, attachmentsByBill, attachmentById,
    items,
    targets: raw.targets, targetByKey,
    lastScan: raw.scanRuns[0] || null,
  };
  ctx.vendorMatch = vendorSelectorMatcher(ctx, filters.vendor_id);
  ctx.filtered = applyFilters(ctx.allocations, filters, ctx.vendorMatch);
  ctx.filterActive = Boolean(filters.from || filters.to || filters.spend_type || filters.class_id || filters.category_id || filters.vendor_id);
  return ctx;
}

// A vendor selector is any id the API hands out: a cost_analyzer_vendor_categories
// row id, 'qbo:<qboId>', 'profile:<profileId>', a bare QuickBooks vendor id, or a
// vendor_key. Returns a predicate over allocation rows / bill metas, or null.
function vendorSelectorMatcher(ctx, selector) {
  if (!selector) return null;
  const qboIds = new Set();
  const keys = new Set();
  const addRow = row => {
    if (!row) return;
    if (row.qbo_vendor_id) qboIds.add(String(row.qbo_vendor_id));
    if (row.vendor_key) keys.add(String(row.vendor_key));
  };
  const addProfile = profile => {
    if (!profile) return;
    if (profile.quickbooks_vendor_id) qboIds.add(String(profile.quickbooks_vendor_id));
    keys.add(vendorKeyOf(profile.vendor_name));
    addRow(ctx.vendorRowByProfileId.get(String(profile.id)));
  };
  const value = String(selector);
  if (value.startsWith('qbo:')) {
    qboIds.add(value.slice(4));
  } else if (value.startsWith('profile:')) {
    addProfile(ctx.profileById.get(value.slice(8)));
  } else if (value.startsWith('key:')) {
    keys.add(value.slice(4));
  } else if (ctx.vendorRowById.has(value)) {
    addRow(ctx.vendorRowById.get(value));
  } else if (ctx.profileById.has(value)) {
    addProfile(ctx.profileById.get(value));
  } else {
    qboIds.add(value);
    keys.add(vendorKeyOf(value));
  }
  for (const id of Array.from(qboIds)) addRow(ctx.vendorRowByQboId.get(id));
  for (const key of Array.from(keys)) addRow(ctx.vendorRowByKey.get(key));
  if (!qboIds.size && !keys.size) return () => false;
  return row => (row.vendor_id && qboIds.has(String(row.vendor_id))) || (row.vendor_key && keys.has(row.vendor_key));
}

// Filters select rows for totals and shares (spec §4.1). The implied-hourly
// denominators are computed elsewhere from unfiltered rows.
function applyFilters(rows, filters, vendorMatch) {
  return rows.filter(row => {
    if (filters.from && (!row.txn_date || row.txn_date < filters.from)) return false;
    if (filters.to && (!row.txn_date || row.txn_date > filters.to)) return false;
    if (filters.spend_type && row.spend_type !== filters.spend_type) return false;
    if (filters.class_id && row.class_id !== filters.class_id) return false;
    if (filters.category_id && row.effective_category_id !== filters.category_id) return false;
    if (vendorMatch && !vendorMatch(row)) return false;
    return true;
  });
}

// Items are filtered through their bill (date, vendor, spend type, category) and
// their own class. Items with no bill link pass only when no bill-based filter is on.
function filterItems(ctx) {
  const { filters, vendorMatch } = ctx;
  return ctx.items.filter(item => {
    if (filters.class_id && item.class_id !== filters.class_id) return false;
    const bill = item.bill;
    if (!bill) return !(filters.from || filters.to || filters.spend_type || filters.category_id || vendorMatch);
    if (filters.from && (!bill.txn_date || bill.txn_date < filters.from)) return false;
    if (filters.to && (!bill.txn_date || bill.txn_date > filters.to)) return false;
    if (filters.spend_type && bill.spend_type !== filters.spend_type) return false;
    if (filters.category_id && bill.effective_category_id !== filters.category_id) return false;
    if (vendorMatch && !vendorMatch(bill)) return false;
    return true;
  });
}

function distinctBills(rows, { nonZeroOnly = true } = {}) {
  const ids = new Set();
  for (const row of rows) if (!nonZeroOnly || !row.zero_amount) ids.add(row.qbo_bill_id);
  return ids;
}

function loadAllocations(db, filters) {
  const ctx = buildContext(db, filters);
  return {
    allocations: ctx.filtered,
    all_allocations: ctx.allocations,
    bills: ctx.bills,
    class_names: ctx.classNames,
    warnings: ctx.warnings,
    filters: ctx.filters,
  };
}

// ── Vendor stats (spec §4.2) ────────────────────────────────────────────────
function groupKeyOf(meta) {
  return meta.vendor_id ? `qbo:${meta.vendor_id}` : `key:${meta.vendor_key}`;
}

// Everything known about one vendor across QuickBooks, the cost-analyzer row and
// the contractor profile. `id` is what the API hands out (spec §4.2 / §6).
function vendorIdentity(ctx, qboVendorId, vendorKey, vendorName) {
  const vendorRow = resolveVendorRow(ctx.vendorRowByQboId, ctx.vendorRowByKey, qboVendorId, vendorKey);
  const profile = (qboVendorId && ctx.profileByQboId.get(qboVendorId))
    || (vendorRow && vendorRow.profile_id && ctx.profileById.get(String(vendorRow.profile_id)))
    || (vendorKey && ctx.profileByKey.get(vendorKey))
    || null;
  const qboVendor = (qboVendorId && ctx.qboVendorById.get(qboVendorId)) || (vendorKey && ctx.qboVendorByKey.get(vendorKey)) || null;
  const qboId = qboVendorId
    || (vendorRow && vendorRow.qbo_vendor_id ? String(vendorRow.qbo_vendor_id) : null)
    || (profile && profile.quickbooks_vendor_id ? String(profile.quickbooks_vendor_id) : null)
    || (qboVendor ? String(qboVendor.qbo_id) : null);
  const key = vendorKey || (vendorRow && vendorRow.vendor_key) || (profile ? vendorKeyOf(profile.vendor_name) : '') || (qboVendor ? vendorKeyOf(qboVendor.display_name) : '');
  const name = textOf(vendorName).trim()
    || (vendorRow && vendorRow.vendor_name)
    || (profile && profile.vendor_name)
    || (qboVendor && qboVendor.display_name)
    || key;
  let id;
  if (vendorRow) id = String(vendorRow.id);
  else if (qboId) id = `qbo:${qboId}`;
  else if (profile) id = `profile:${profile.id}`;
  else id = `key:${key}`;
  return { id, qbo_vendor_id: qboId, vendor_key: key, vendor_name: name, vendorRow, profile, group_key: qboId ? `qbo:${qboId}` : `key:${key}` };
}

function vendorCategoryInfo(ctx, vendorRow) {
  const primary = categoryInfo(ctx, vendorRow && vendorRow.category_id ? String(vendorRow.category_id) : UNCATEGORIZED_ID);
  const secondary = vendorRow && vendorRow.secondary_category_id ? categoryInfo(ctx, String(vendorRow.secondary_category_id)) : null;
  const source = vendorRow ? String(vendorRow.source || 'seed') : 'none';
  const confidence = vendorRow ? numberOrNull(vendorRow.confidence) : null;
  const needsOwnerInput = Boolean(vendorRow && Number(vendorRow.needs_owner_input));
  let setByName = null;
  if (vendorRow) {
    if (vendorRow.set_by) setByName = ctx.userNameById.get(String(vendorRow.set_by)) || null;
    else if (source === 'seed') setByName = 'Seed';
  }
  // "Needs review" = not confirmed by a person and either a weak guess, flagged for
  // the owner, or still uncategorized. Mirrors the Vendors tab chip.
  const needsReview = source !== 'manual'
    && (primary.id === UNCATEGORIZED_ID || needsOwnerInput || confidence === null || confidence < REVIEW_CONFIDENCE);
  return {
    id: primary.id,
    name: primary.name,
    kind: primary.kind,
    secondary_id: secondary ? secondary.id : null,
    secondary_name: secondary ? secondary.name : null,
    source,
    confidence,
    rationale: vendorRow ? vendorRow.rationale || null : null,
    needs_owner_input: needsOwnerInput,
    confirmed_at: vendorRow ? vendorRow.confirmed_at || null : null,
    confirmed_by_name: vendorRow && vendorRow.confirmed_by ? ctx.userNameById.get(String(vendorRow.confirmed_by)) || null : null,
    set_by_name: setByName,
    set_at: vendorRow ? vendorRow.set_at || null : null,
    row_id: vendorRow ? String(vendorRow.id) : null,
    needs_review: needsReview,
  };
}

function vendorProfileInfo(profile, categoryKind) {
  if (!profile) return null;
  const isSupplier = Boolean(Number(profile.is_supplier));
  const mismatch = (categoryKind === 'supplier' && !isSupplier) || (categoryKind === 'trade' && isSupplier);
  return {
    id: String(profile.id),
    category: profile.contractor_category || null,
    secondary_category: profile.contractor_secondary_category || null,
    is_supplier: isSupplier,
    supplier_marked_by: profile.supplier_marked_by || null,
    list_mismatch: mismatch,
  };
}

// Σ document material_total per bill, counted once per content hash.
function materialTotalsByBill(ctx) {
  if (ctx._materialByBill) return ctx._materialByBill;
  const map = new Map();
  const seenHashes = new Set();
  const docs = ctx.documents
    .filter(doc => doc.status === 'extracted')
    .sort((a, b) => textOf(a.extracted_at).localeCompare(textOf(b.extracted_at)));
  for (const doc of docs) {
    if (doc.content_hash) {
      if (seenHashes.has(doc.content_hash)) continue;
      seenHashes.add(doc.content_hash);
    }
    const material = numberOrNull(doc.material_total);
    if (material === null || !doc.qbo_bill_id) continue;
    const billId = String(doc.qbo_bill_id);
    map.set(billId, cents((map.get(billId) || 0) + material));
  }
  ctx._materialByBill = map;
  return map;
}

function itemsByVendorGroup(ctx) {
  if (ctx._itemsByVendor) return ctx._itemsByVendor;
  const map = new Map();
  for (const item of ctx.items) if (item.bill) pushInto(map, groupKeyOf(item.bill), item);
  ctx._itemsByVendor = map;
  return map;
}

// Measured "Invoice $/hr" from extracted line items that list hours (or days).
function docHourlyFromItems(items) {
  let hourTotal = 0;
  let hourAmount = 0;
  let dayTotal = 0;
  let dayAmount = 0;
  const docsWithHours = new Set();
  const docsWithDays = new Set();
  for (const item of items) {
    const amount = numberOrNull(item.line_total);
    if (amount === null) continue;
    const hours = numberOrNull(item.hours);
    const days = numberOrNull(item.days);
    const docKey = item.attachment_id ? String(item.attachment_id) : `item:${item.id}`;
    if (hours !== null && hours > 0) {
      hourTotal += hours;
      hourAmount += amount;
      docsWithHours.add(docKey);
    } else if (days !== null && days > 0) {
      dayTotal += days;
      dayAmount += amount;
      docsWithDays.add(docKey);
    }
  }
  const docDaily = ratio(dayAmount, dayTotal);
  return {
    doc_hourly: round(ratio(hourAmount, hourTotal)),
    doc_hourly_hours: round(hourTotal, 2),
    doc_hourly_total: cents(hourAmount),
    doc_daily: round(docDaily),
    doc_daily_days: round(dayTotal, 2),
    doc_daily_total: cents(dayAmount),
    doc_daily_as_hourly: round(ratio(docDaily, HOURS_PER_DAY)),
    hours_per_day_assumed: HOURS_PER_DAY,
    n_docs_with_hours: docsWithHours.size,
    n_docs_with_days: docsWithDays.size,
    label: RATE_LABELS.doc,
  };
}

// Per vendor-year implied hourly figures (owner's definition). `metas` are the
// vendor's in-scope bills regardless of filters: denominators never move with them.
function vendorYearStats(ctx, metas, categoryId, categoryKind) {
  const dated = metas.filter(meta => meta.txn_date && !meta.zero_amount);
  const byYear = new Map();
  for (const meta of dated) pushInto(byYear, meta.year, meta);
  const yearsList = Array.from(byYear.keys()).sort((a, b) => a - b);
  const firstEver = dated.length ? dated.map(meta => meta.txn_date).sort()[0] : null;
  const trade = isTradeCategory(categoryId, categoryKind);
  const materialByBill = materialTotalsByBill(ctx);

  return yearsList.map(year => {
    const rows = byYear.get(year);
    const dates = rows.map(meta => meta.txn_date).sort();
    const first = dates[0];
    const last = dates[dates.length - 1];
    const total = sumBy(rows, meta => meta.total_amt);
    const bills = rows.length;
    const weeksSpan = weeksSpanOf(first, last);
    const weeksWithBills = new Set(dates.map(isoWeekKey)).size;

    let status;
    if (year === ctx.currentYear) status = 'ytd';
    else if (year > ctx.currentYear) status = 'partial';
    else {
      // Complete = the vendor was already active before this year (or by Jan 31) and
      // still active after it (or through Dec) — a whole working year, not a stub.
      const activeBefore = yearsList.some(y => y < year) || first <= `${year}-01-31`;
      const activeAfter = yearsList.some(y => y > year) || last >= `${year}-12-01`;
      status = activeBefore && activeAfter ? 'complete' : 'partial';
    }

    let reason = null;
    if (!trade) reason = 'not_a_trade';
    else if (bills < MIN_BILLS_FOR_HOURLY) reason = 'too_few_bills';
    else if (weeksSpan < MIN_WEEKS_FOR_HOURLY) reason = 'span_too_short';
    const qualifies = reason === null;

    // Annualized basis: weeks from max(Jan 1, first-ever bill) to min(Dec 31, today).
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const elapsedStart = firstEver && firstEver > yearStart ? firstEver : yearStart;
    const elapsedEnd = ctx.today < yearEnd ? ctx.today : yearEnd;
    const weeksElapsed = elapsedEnd >= elapsedStart ? Math.max(1, Math.ceil(daysInclusive(elapsedStart, elapsedEnd) / 7)) : 1;

    const documentedTotal = sumBy(rows.filter(meta => meta.has_document), meta => meta.total_amt);
    const materialTotal = sumBy(rows, meta => materialByBill.get(meta.qbo_id) || 0);
    const nonTradeTotal = sumBy(
      rows.filter(meta => !isTradeCategory(meta.effective_category_id, categoryInfo(ctx, meta.effective_category_id).kind)),
      meta => meta.total_amt
    );
    const laborOnlyTotal = cents(total - materialTotal - nonTradeTotal);
    const laborOnlyCoverage = ratio(documentedTotal, total);

    return {
      year,
      status,
      bills,
      total,
      first,
      last,
      weeks_span: weeksSpan,
      weeks_with_bills: weeksWithBills,
      weeks_elapsed: status === 'complete' ? null : weeksElapsed,
      qualifies,
      reason,
      hourly_full_year: qualifies && status === 'complete' ? round(total / HOURS_PER_YEAR) : null,
      hourly_annualized: qualifies && status !== 'complete' ? round(total / (HOURS_PER_WEEK * weeksElapsed)) : null,
      hourly_active_weeks: qualifies ? round(total / (HOURS_PER_WEEK * weeksSpan)) : null,
      documented_total: documentedTotal,
      material_total_from_documents: materialTotal,
      non_trade_total: nonTradeTotal,
      labor_only_total: laborOnlyTotal,
      labor_only_coverage: round(laborOnlyCoverage, 4),
      labor_only_hourly: qualifies && status === 'complete' && laborOnlyCoverage !== null && laborOnlyCoverage >= LABOR_ONLY_MIN_COVERAGE
        ? round(laborOnlyTotal / HOURS_PER_YEAR)
        : null,
    };
  });
}

function vendorHourly(ctx, identity, years, filteredRows, categoryId, categoryKind) {
  const trade = isTradeCategory(categoryId, categoryKind);
  const completeQualifying = years.filter(y => y.status === 'complete' && y.qualifies);
  const completeTotal = sumBy(completeQualifying, y => y.total);
  const completeHours = HOURS_PER_YEAR * completeQualifying.length;

  let fullYearReason = null;
  if (!trade) fullYearReason = 'not_a_trade';
  else if (!completeQualifying.length) {
    const complete = years.filter(y => y.status === 'complete');
    fullYearReason = complete.length ? complete[complete.length - 1].reason : 'no complete calendar year yet';
  }

  const laborOnlyTotal = sumBy(completeQualifying, y => y.labor_only_total);
  const laborDocumented = sumBy(completeQualifying, y => y.documented_total);
  const laborCoverage = ratio(laborDocumented, completeTotal);
  let laborOnlyReason = fullYearReason;
  if (!laborOnlyReason && (laborCoverage === null || laborCoverage < LABOR_ONLY_MIN_COVERAGE)) {
    laborOnlyReason = `documents cover ${Math.round((laborCoverage || 0) * 100)}% of spend (need ${LABOR_ONLY_MIN_COVERAGE * 100}%)`;
  }

  const annualizedYears = years.filter(y => y.hourly_annualized !== null);
  const latestAnnualized = annualizedYears.length ? annualizedYears[annualizedYears.length - 1] : null;

  let window = null;
  if (ctx.filters.from || ctx.filters.to) {
    const firstEver = years.length ? years[0].first : null;
    const from = ctx.filters.from || firstEver || ctx.today;
    const to = ctx.filters.to || ctx.today;
    const weeks = to >= from ? Math.max(1, Math.ceil(daysInclusive(from, to) / 7)) : 1;
    const total = sumBy(filteredRows, row => row.amount);
    window = {
      from,
      to,
      weeks_in_window: weeks,
      total,
      bills: distinctBills(filteredRows).size,
      hourly: trade ? round(total / (HOURS_PER_WEEK * weeks)) : null,
      reason: trade ? null : 'not_a_trade',
      label: RATE_LABELS.window,
    };
  }

  const items = itemsByVendorGroup(ctx).get(identity.group_key) || [];

  return {
    is_trade: trade,
    full_year_avg: completeQualifying.length ? round(completeTotal / completeHours) : null,
    full_year_avg_reason: fullYearReason,
    full_year_years: completeQualifying.map(y => y.year),
    full_year_total: completeTotal,
    full_year_hours: completeHours,
    full_year_label: RATE_LABELS.full_year,
    latest_annualized: latestAnnualized
      ? { year: latestAnnualized.year, status: latestAnnualized.status, hourly_annualized: latestAnnualized.hourly_annualized, weeks_elapsed: latestAnnualized.weeks_elapsed, label: RATE_LABELS.annualized }
      : null,
    labor_only_full_year_avg: !laborOnlyReason ? round(laborOnlyTotal / completeHours) : null,
    labor_only_coverage: round(laborCoverage, 4),
    labor_only_reason: laborOnlyReason,
    window,
    ...docHourlyFromItems(items),
    labels: RATE_LABELS,
  };
}

function vendorClasses(ctx, filteredRows, vendorTotal, completeQualifyingYears) {
  const byClass = new Map();
  for (const row of filteredRows) pushInto(byClass, row.class_id, row);
  return Array.from(byClass.entries()).map(([classId, rows]) => {
    const total = sumBy(rows, row => row.amount);
    const share = ratio(total, vendorTotal);
    return {
      class_id: classId,
      class_name: ctx.classNames.get(classId) || classId,
      total,
      bills: distinctBills(rows).size,
      share: round(share, 4),
      // Owner's framing: "how many of his 40-hour weeks went to this house" — implied
      // from spend share, never measured.
      implied_hours_share: completeQualifyingYears > 0 && share !== null ? round(share * HOURS_PER_YEAR * completeQualifyingYears, 1) : null,
      implied_hours_share_label: RATE_LABELS.hours_share,
    };
  }).sort((a, b) => b.total - a.total || a.class_name.localeCompare(b.class_name));
}

function buildVendorEntry(ctx, identity, allMetas, filteredRows) {
  const category = vendorCategoryInfo(ctx, identity.vendorRow);
  const profile = vendorProfileInfo(identity.profile, category.kind);
  const years = cachedVendorYears(ctx, identity.group_key, allMetas, category);
  const total = sumBy(filteredRows, row => row.amount);
  const billIds = distinctBills(filteredRows);
  const zeroBills = new Set(filteredRows.filter(row => row.zero_amount).map(row => row.qbo_bill_id));
  const dates = filteredRows.map(row => row.txn_date).filter(Boolean).sort();
  const elsewhereRows = filteredRows.filter(row => row.effective_category_id !== category.id && !row.zero_amount);
  const documentedTotal = sumBy(filteredRows.filter(row => row.has_document), row => row.amount);
  const hourly = vendorHourly(ctx, identity, years, filteredRows, category.id, category.kind);
  const completeQualifying = years.filter(y => y.status === 'complete' && y.qualifies).length;

  return {
    id: identity.id,
    qbo_vendor_id: identity.qbo_vendor_id,
    vendor_key: identity.vendor_key,
    vendor_name: identity.vendor_name,
    group_key: identity.group_key,
    category,
    profile,
    needs_review: category.needs_review,
    total,
    bill_count: billIds.size,
    zero_amount_bills: zeroBills.size,
    first_bill: dates[0] || null,
    last_bill: dates.length ? dates[dates.length - 1] : null,
    in_scope_bill_count: allMetas.filter(meta => !meta.zero_amount).length,
    in_scope_total: sumBy(allMetas, meta => meta.total_amt),
    bills_elsewhere: { count: distinctBills(elsewhereRows).size, total: sumBy(elsewhereRows, row => row.amount) },
    has_documents_share: round(ratio(documentedTotal, total), 4),
    documented_total: documentedTotal,
    headline_hourly: hourly.full_year_avg,
    headline_hourly_reason: hourly.full_year_avg_reason,
    years,
    classes: vendorClasses(ctx, filteredRows, total, completeQualifying),
    hourly,
  };
}

// All vendor entries: vendors with bills in the filtered window (include=bills) plus,
// with include=all, every categorized vendor / contractor profile with zero totals.
function computeVendors(ctx) {
  if (ctx._vendors) return ctx._vendors;
  const metasByGroup = new Map();
  for (const meta of ctx.bills.values()) pushInto(metasByGroup, groupKeyOf(meta), meta);
  const rowsByGroup = new Map();
  for (const row of ctx.filtered) pushInto(rowsByGroup, groupKeyOf(row), row);

  const entries = new Map();
  const groupsToShow = ctx.filters.include === 'all' ? Array.from(metasByGroup.keys()) : Array.from(rowsByGroup.keys());
  for (const groupKey of groupsToShow) {
    const metas = metasByGroup.get(groupKey) || [];
    const latest = metas.slice().sort((a, b) => textOf(b.txn_date).localeCompare(textOf(a.txn_date)))[0];
    const identity = vendorIdentity(ctx, latest.vendor_id, latest.vendor_key, latest.vendor_name);
    entries.set(groupKey, buildVendorEntry(ctx, identity, metas, rowsByGroup.get(groupKey) || []));
  }

  if (ctx.filters.include === 'all') {
    const extras = [];
    for (const row of ctx.vendorRows) extras.push(vendorIdentity(ctx, row.qbo_vendor_id ? String(row.qbo_vendor_id) : null, row.vendor_key, row.vendor_name));
    for (const profile of ctx.profiles) {
      extras.push(vendorIdentity(ctx, profile.quickbooks_vendor_id ? String(profile.quickbooks_vendor_id) : null, vendorKeyOf(profile.vendor_name), profile.vendor_name));
    }
    for (const identity of extras) {
      if (identity.qbo_vendor_id && ctx.suppressedVendorIds.has(identity.qbo_vendor_id)) continue;
      if (entries.has(identity.group_key)) continue;
      entries.set(identity.group_key, buildVendorEntry(ctx, identity, [], []));
    }
  }

  const vendors = Array.from(entries.values())
    .sort((a, b) => b.total - a.total || b.in_scope_total - a.in_scope_total || a.vendor_name.localeCompare(b.vendor_name));
  ctx._vendors = vendors;
  return vendors;
}

function vendorStats(db, filters) {
  const ctx = buildContext(db, filters);
  const vendors = computeVendors(ctx);
  return {
    vendors,
    needs_review_count: vendors.filter(vendor => vendor.needs_review).length,
    labels: RATE_LABELS,
    warnings: ctx.warnings,
    filters: ctx.filters,
  };
}

function identityForGroup(ctx, meta) {
  if (!ctx._identityByGroup) ctx._identityByGroup = new Map();
  const key = groupKeyOf(meta);
  let identity = ctx._identityByGroup.get(key);
  if (!identity) {
    identity = vendorIdentity(ctx, meta.vendor_id, meta.vendor_key, meta.vendor_name);
    ctx._identityByGroup.set(key, identity);
  }
  return identity;
}

function effectiveCategoryOf(ctx, meta) {
  const info = categoryInfo(ctx, meta.effective_category_id);
  return {
    id: info.id,
    name: info.name,
    kind: info.kind,
    source: meta.category_source,
    confidence: meta.category_confidence,
    rationale: meta.category_rationale,
    keyword: meta.category_keyword,
    vendor_category_id: meta.vendor_category_id,
  };
}

function attachmentLinks(ctx, billId) {
  return (ctx.attachmentsByBill.get(billId) || []).map(attachment => ({
    id: String(attachment.id),
    original_name: attachment.original_name || null,
    mime_type: attachment.mime_type || null,
    url: `/api/quickbooks/bills/${encodeURIComponent(billId)}/attachments/${encodeURIComponent(String(attachment.id))}?inline=1`,
    document_status: (ctx.documentByAttachment.get(String(attachment.id)) || {}).status || null,
  }));
}

function documentSummary(ctx, doc) {
  const bill = doc.qbo_bill_id ? ctx.bills.get(String(doc.qbo_bill_id)) || null : null;
  return {
    attachment_id: String(doc.attachment_id),
    qbo_bill_id: doc.qbo_bill_id ? String(doc.qbo_bill_id) : null,
    vendor_name: bill ? bill.vendor_name : doc.vendor_on_document || null,
    txn_date: bill ? bill.txn_date : null,
    bill_total: bill ? bill.total_amt : null,
    status: doc.status,
    doc_type: doc.doc_type || null,
    document_date: doc.document_date || null,
    document_total: numberOrNull(doc.document_total),
    totals_match: doc.totals_match === null || doc.totals_match === undefined ? null : Boolean(Number(doc.totals_match)),
    totals_match_reason: doc.totals_match_reason || null,
    labor_total: numberOrNull(doc.labor_total),
    material_total: numberOrNull(doc.material_total),
    labor_hours: numberOrNull(doc.labor_hours),
    labor_days: numberOrNull(doc.labor_days),
    labor_rate: numberOrNull(doc.labor_rate),
    labor_performed_by: doc.labor_performed_by || null,
    suggested_category_id: doc.suggested_category_id || null,
    suggested_category_confidence: numberOrNull(doc.suggested_category_confidence),
    summary: doc.summary || null,
    confidence: numberOrNull(doc.confidence),
    error: doc.error || null,
    attempts: Number(doc.attempts) || 0,
    duplicate_of: doc.duplicate_of || null,
    bills_covered: parseJsonArray(doc.bills_covered_json).map(String),
    extracted_at: doc.extracted_at || null,
    updated_at: doc.updated_at || null,
    attachment_url: doc.qbo_bill_id
      ? `/api/quickbooks/bills/${encodeURIComponent(String(doc.qbo_bill_id))}/attachments/${encodeURIComponent(String(doc.attachment_id))}?inline=1`
      : null,
  };
}

function itemSummary(ctx, item) {
  return {
    id: String(item.id),
    attachment_id: item.attachment_id ? String(item.attachment_id) : null,
    qbo_bill_id: item.bill_id,
    qbo_class_id: item.class_id,
    class_name: item.class_id ? ctx.classNames.get(item.class_id) || item.class_id : null,
    vendor_name: item.bill ? item.bill.vendor_name : null,
    txn_date: item.bill ? item.bill.txn_date : null,
    line_no: Number(item.line_no) || 0,
    description: item.description,
    item_kind: item.item_kind,
    material_family: item.material_family || null,
    material_type: item.material_type || null,
    material_type_raw: item.material_type_raw || null,
    spec: item.spec || null,
    phase: item.phase || null,
    quantity: numberOrNull(item.quantity),
    unit: item.unit || null,
    unit_price: numberOrNull(item.unit_price),
    line_total: numberOrNull(item.line_total),
    pricing_basis: item.pricing_basis || null,
    hours: numberOrNull(item.hours),
    days: numberOrNull(item.days),
    rate: numberOrNull(item.rate),
    location: item.location || null,
    confidence: numberOrNull(item.confidence),
    needs_review: Boolean(Number(item.needs_review)),
    review_reason: item.review_reason || null,
    source: item.source || 'ai',
    note: item.note || null,
    attachment_url: item.attachment_id && item.bill_id
      ? `/api/quickbooks/bills/${encodeURIComponent(item.bill_id)}/attachments/${encodeURIComponent(String(item.attachment_id))}?inline=1`
      : null,
  };
}

function identityFromSelector(ctx, selector) {
  const value = String(selector || '');
  if (!value) return null;
  if (value.startsWith('qbo:')) {
    const id = value.slice(4);
    const vendor = ctx.qboVendorById.get(id);
    const row = ctx.vendorRowByQboId.get(id);
    const profile = ctx.profileByQboId.get(id);
    if (!vendor && !row && !profile) return null;
    return vendorIdentity(ctx, id, vendorKeyOf((row && row.vendor_name) || (vendor && vendor.display_name) || (profile && profile.vendor_name)), null);
  }
  if (value.startsWith('profile:')) {
    const profile = ctx.profileById.get(value.slice(8));
    if (!profile) return null;
    return vendorIdentity(ctx, profile.quickbooks_vendor_id ? String(profile.quickbooks_vendor_id) : null, vendorKeyOf(profile.vendor_name), profile.vendor_name);
  }
  if (value.startsWith('key:')) {
    const key = value.slice(4);
    return vendorIdentity(ctx, null, key, null);
  }
  const row = ctx.vendorRowById.get(value);
  if (row) return vendorIdentity(ctx, row.qbo_vendor_id ? String(row.qbo_vendor_id) : null, row.vendor_key, row.vendor_name);
  const profile = ctx.profileById.get(value);
  if (profile) return vendorIdentity(ctx, profile.quickbooks_vendor_id ? String(profile.quickbooks_vendor_id) : null, vendorKeyOf(profile.vendor_name), profile.vendor_name);
  if (ctx.qboVendorById.has(value) || ctx.vendorRowByQboId.has(value) || ctx.profileByQboId.has(value)) {
    return vendorIdentity(ctx, value, null, null);
  }
  return null;
}

function loadVendorHistory(db, vendorRowId) {
  if (!vendorRowId) return [];
  try {
    return db.prepare(`
      SELECT id, vendor_category_id, vendor_name, from_category_id, to_category_id, from_secondary_id, to_secondary_id,
             source, confidence, rationale, set_by, set_by_name, set_at
      FROM cost_analyzer_vendor_category_history
      WHERE vendor_category_id = ?
      ORDER BY set_at DESC, id DESC
    `).all(vendorRowId);
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) return [];
    throw err;
  }
}

// Vendor drawer payload. Returns null when the id matches nothing (route → 404).
function vendorDetail(db, vendorId, filters) {
  const ctx = buildContext(db, filters);
  const matcher = vendorSelectorMatcher(ctx, vendorId);
  const metas = matcher ? Array.from(ctx.bills.values()).filter(matcher) : [];
  let identity = null;
  if (metas.length) {
    const latest = metas.slice().sort((a, b) => textOf(b.txn_date).localeCompare(textOf(a.txn_date)))[0];
    identity = vendorIdentity(ctx, latest.vendor_id, latest.vendor_key, latest.vendor_name);
  } else {
    identity = identityFromSelector(ctx, vendorId);
  }
  if (!identity) return null;

  const filteredRows = matcher ? ctx.filtered.filter(matcher) : [];
  const entry = buildVendorEntry(ctx, identity, metas, filteredRows);
  const billIds = Array.from(new Set(filteredRows.map(row => row.qbo_bill_id)));
  const bills = billIds
    .map(billId => ctx.bills.get(billId))
    .filter(Boolean)
    .sort((a, b) => textOf(b.txn_date).localeCompare(textOf(a.txn_date)) || b.qbo_id.localeCompare(a.qbo_id))
    .map(meta => ({
      qbo_id: meta.qbo_id,
      txn_date: meta.txn_date,
      total_amt: meta.total_amt,
      qbo_class_id: meta.qbo_class_id,
      class_name: meta.multi_class
        ? meta.class_ids.map(id => ctx.classNames.get(id) || id).join(' / ')
        : (meta.qbo_class_name || ctx.classNames.get(meta.class_ids[0]) || (meta.class_ids[0] === UNASSIGNED_CLASS_ID ? UNASSIGNED_CLASS_NAME : meta.class_ids[0])),
      class_ids: meta.class_ids,
      multi_class: meta.multi_class,
      private_note: meta.private_note,
      spend_type: meta.spend_type,
      payment_approval_status: meta.payment_approval_status,
      zero_amount: meta.zero_amount,
      lines_mismatch: meta.lines_mismatch,
      has_document: meta.has_document,
      effective_category: effectiveCategoryOf(ctx, meta),
      attachments: attachmentLinks(ctx, meta.qbo_id),
    }));
  const billIdSet = new Set(billIds);
  const documents = ctx.documents
    .filter(doc => doc.qbo_bill_id && billIdSet.has(String(doc.qbo_bill_id)))
    .map(doc => documentSummary(ctx, doc))
    .sort((a, b) => textOf(b.txn_date).localeCompare(textOf(a.txn_date)));
  const items = ctx.items
    .filter(item => item.bill_id && billIdSet.has(item.bill_id))
    .map(item => itemSummary(ctx, item));

  return {
    ...entry,
    bills,
    documents,
    items,
    history: loadVendorHistory(db, identity.vendorRow ? String(identity.vendorRow.id) : null),
    labels: RATE_LABELS,
    warnings: ctx.warnings,
    filters: ctx.filters,
  };
}

// ── Class (project) stats (spec §4.3) ───────────────────────────────────────
const PROJECT_TYPE_BY_SPEND = {
  rehab: 'rehab',
  new_construction: 'new_construction',
  maintenance: 'rental_maintenance',
  other: 'other',
};

function classCompleteness(ctx, project, lastBill) {
  const recentlyBilled = Boolean(lastBill) && (lastBill > ctx.today || daysInclusive(lastBill, ctx.today) - 1 <= IN_PROGRESS_RECENT_DAYS);
  if (project) {
    const lifecycle = String(project.lifecycle_status || '').toLowerCase();
    const finished = lifecycle === 'completed' || lifecycle === 'sold' || Boolean(project.sold_date);
    if (!finished) return 'in_progress';
  }
  return recentlyBilled ? 'in_progress' : 'complete';
}

function specsInfo(ctx, spec) {
  if (!spec) return null;
  return {
    square_feet: numberOrNull(spec.square_feet),
    bedrooms: numberOrNull(spec.bedrooms),
    bathrooms: numberOrNull(spec.bathrooms),
    units: numberOrNull(spec.units),
    stories: numberOrNull(spec.stories),
    year_built: numberOrNull(spec.year_built),
    project_type: spec.project_type || null,
    notes: spec.notes || null,
    project_id: spec.project_id || null,
    updated_by: spec.updated_by || null,
    updated_by_name: spec.updated_by ? ctx.userNameById.get(String(spec.updated_by)) || null : null,
    updated_at: spec.updated_at || null,
  };
}

function perSpecRatio(amount, divisor, missingReason) {
  const value = ratio(amount, divisor);
  return { value: round(value), reason: value === null ? missingReason : null };
}

function buildClassEntry(ctx, classId, rows) {
  const spec = ctx.specByClassId.get(classId) || null;
  const project = ctx.projectByClassId.get(classId) || (spec && spec.project_id ? ctx.projectById.get(String(spec.project_id)) : null) || null;
  const className = ctx.classNames.get(classId) || (spec && spec.class_name) || (project && project.quickbooks_class_name) || classId;
  const nonZero = rows.filter(row => !row.zero_amount);
  const total = sumBy(rows, row => row.amount);
  const dates = nonZero.map(row => row.txn_date).filter(Boolean).sort();
  const first = dates[0] || null;
  const last = dates.length ? dates[dates.length - 1] : null;
  const yearsSpanned = first && last ? daysInclusive(first, last) / 365.25 : 0;
  const completeness = classCompleteness(ctx, project, last);

  const spendByType = {};
  for (const type of SPEND_TYPES) spendByType[type] = 0;
  for (const row of rows) spendByType[row.spend_type] = cents((spendByType[row.spend_type] || 0) + row.amount);
  const allocatedTotal = sumBy(rows.filter(row => row.from_line_allocation), row => row.amount);
  const documentedTotal = sumBy(rows.filter(row => row.has_document), row => row.amount);

  const sqft = spec ? numberOrNull(spec.square_feet) : null;
  const bedrooms = spec ? numberOrNull(spec.bedrooms) : null;
  const bathrooms = spec ? numberOrNull(spec.bathrooms) : null;
  const units = spec ? numberOrNull(spec.units) : null;
  const NO_SQFT = 'no square footage recorded';

  const byCategoryMap = new Map();
  for (const row of rows) pushInto(byCategoryMap, row.effective_category_id, row);
  const byCategory = Array.from(byCategoryMap.entries()).map(([categoryId, categoryRows]) => {
    const info = categoryInfo(ctx, categoryId);
    const categoryTotal = sumBy(categoryRows, row => row.amount);
    const vendorMap = new Map();
    for (const row of categoryRows) pushInto(vendorMap, groupKeyOf(row), row);
    const vendors = Array.from(vendorMap.values()).map(vendorRows => {
      const identity = identityForGroup(ctx, vendorRows[0]);
      return { vendor_id: identity.id, qbo_vendor_id: identity.qbo_vendor_id, name: identity.vendor_name, total: sumBy(vendorRows, row => row.amount) };
    }).sort((a, b) => b.total - a.total);
    return {
      id: info.id,
      name: info.name,
      kind: info.kind,
      total: categoryTotal,
      share: round(ratio(categoryTotal, total), 4),
      bills: distinctBills(categoryRows).size,
      per_sqft: round(ratio(categoryTotal, sqft)),
      vendors,
    };
  }).sort((a, b) => b.total - a.total);

  const vendorGroups = new Set(nonZero.map(groupKeyOf));
  // A bill with no usable txn_date still allocates money but has no month.
  const months = new Set(nonZero.filter(row => row.txn_date).map(row => row.txn_date.slice(0, 7)));

  const classItems = ctx.items.filter(item => item.class_id === classId);
  const itemTotal = kind => sumBy(classItems.filter(item => item.item_kind === kind), item => numberOrNull(item.line_total) || 0);
  const itemsMaterial = itemTotal('material');
  const itemsLabor = itemTotal('labor');
  const itemsLaborAndMaterial = itemTotal('labor_and_material');

  const dominantSpend = Object.entries(spendByType).sort((a, b) => b[1] - a[1])[0];
  const storedType = spec && spec.project_type ? spec.project_type : null;
  const perSqft = perSpecRatio(cents(spendByType.rehab + spendByType.new_construction), sqft, NO_SQFT);
  const perBedroom = perSpecRatio(total, bedrooms, 'no bedrooms recorded');
  const perBathroom = perSpecRatio(total, bathrooms, 'no bathrooms recorded');
  const perUnit = perSpecRatio(total, units, 'no unit count recorded');
  const perSqftByType = {};
  for (const type of SPEND_TYPES) perSqftByType[type] = round(ratio(spendByType[type], sqft));

  return {
    qbo_class_id: classId,
    class_name: className,
    linked_project: project ? {
      id: String(project.id),
      job_name: project.job_name,
      address: project.address || null,
      status: project.status || null,
      lifecycle_status: project.lifecycle_status || null,
      budget: numberOrNull(project.budget),
    } : null,
    specs: specsInfo(ctx, spec),
    project_type: storedType || (total > 0 && dominantSpend ? PROJECT_TYPE_BY_SPEND[dominantSpend[0]] || 'other' : null),
    project_type_source: storedType ? 'stored' : (total > 0 ? 'inferred' : null),
    total,
    bill_count: distinctBills(rows).size,
    vendor_count: vendorGroups.size,
    first_bill: first,
    last_bill: last,
    months_active: months.size,
    years_spanned: round(yearsSpanned, 2),
    completeness,
    spend_by_type: spendByType,
    allocated_share: round(ratio(allocatedTotal, total), 4),
    allocated_total: allocatedTotal,
    by_category: byCategory,
    documents_coverage: round(ratio(documentedTotal, total), 4),
    documented_total: documentedTotal,
    per_sqft: perSqft.value,
    per_sqft_reason: perSqft.reason,
    per_sqft_by_type: perSqftByType,
    maintenance_per_sqft_per_year: round(ratio(spendByType.maintenance, sqft === null ? null : sqft * Math.max(yearsSpanned, 1))),
    per_bedroom: perBedroom.value,
    per_bedroom_reason: perBedroom.reason,
    per_bathroom: perBathroom.value,
    per_bathroom_reason: perBathroom.reason,
    per_unit: perUnit.value,
    per_unit_reason: perUnit.reason,
    material_per_sqft: round(ratio(itemsMaterial, sqft)),
    labor_per_sqft: round(ratio(itemsLabor, sqft)),
    labor_and_material_per_sqft: round(ratio(itemsLaborAndMaterial, sqft)),
    items_material_total: itemsMaterial,
    items_labor_total: itemsLabor,
    items_labor_and_material_total: itemsLaborAndMaterial,
    items_coverage: round(ratio(documentedTotal, total), 4),
    items_coverage_reason: sqft === null ? NO_SQFT : (classItems.length ? null : 'no extracted line items on this class'),
    n_items: classItems.length,
  };
}

// Every class that has bills in scope or a specs row, with totals from the filtered
// rows (a class with no bills in the window shows $0 rather than disappearing, so
// the Projects tab is always the full list the owner fills sqft/beds/baths into).
function computeClasses(ctx) {
  if (ctx._classes) return ctx._classes;
  const rowsByClass = new Map();
  for (const row of ctx.filtered) pushInto(rowsByClass, row.class_id, row);
  const classIds = new Set();
  for (const row of ctx.allocations) classIds.add(row.class_id);
  for (const spec of ctx.classSpecs) classIds.add(String(spec.qbo_class_id));
  if (ctx.filters.class_id) {
    classIds.clear();
    classIds.add(ctx.filters.class_id);
  }
  const classes = Array.from(classIds)
    .map(classId => buildClassEntry(ctx, classId, rowsByClass.get(classId) || []))
    .sort((a, b) => b.total - a.total || a.class_name.localeCompare(b.class_name));
  ctx._classes = classes;
  return classes;
}

function classStats(db, filters) {
  const ctx = buildContext(db, filters);
  const classes = computeClasses(ctx);
  return {
    classes,
    classes_with_sqft: classes.filter(entry => entry.specs && entry.specs.square_feet).length,
    warnings: ctx.warnings,
    filters: ctx.filters,
  };
}

// Project drawer payload. Returns null for an unknown class (route → 404).
function classDetail(db, classId, filters) {
  const ctx = buildContext(db, filters);
  const id = String(classId || '');
  const known = ctx.allocations.some(row => row.class_id === id) || ctx.specByClassId.has(id) || ctx.projectByClassId.has(id);
  if (!known) return null;
  const rows = ctx.filtered.filter(row => row.class_id === id);
  const entry = buildClassEntry(ctx, id, rows);

  const vendorMap = new Map();
  for (const row of rows) pushInto(vendorMap, groupKeyOf(row), row);
  const vendors = Array.from(vendorMap.values()).map(vendorRows => {
    const identity = identityForGroup(ctx, vendorRows[0]);
    const category = vendorCategoryInfo(ctx, identity.vendorRow);
    const total = sumBy(vendorRows, row => row.amount);
    return {
      vendor_id: identity.id,
      qbo_vendor_id: identity.qbo_vendor_id,
      name: identity.vendor_name,
      category: { id: category.id, name: category.name, kind: category.kind },
      total,
      bills: distinctBills(vendorRows).size,
      share: round(ratio(total, entry.total), 4),
    };
  }).sort((a, b) => b.total - a.total);

  const billMap = new Map();
  for (const row of rows) pushInto(billMap, row.qbo_bill_id, row);
  const bills = Array.from(billMap.entries()).map(([billId, billRows]) => {
    const meta = ctx.bills.get(billId);
    return {
      qbo_id: billId,
      txn_date: meta.txn_date,
      vendor_id: identityForGroup(ctx, meta).id,
      vendor_name: meta.vendor_name,
      amount: sumBy(billRows, row => row.amount),
      total_amt: meta.total_amt,
      private_note: meta.private_note,
      spend_type: meta.spend_type,
      multi_class: meta.multi_class,
      lines_mismatch: meta.lines_mismatch,
      has_document: meta.has_document,
      effective_category: effectiveCategoryOf(ctx, meta),
      attachments: attachmentLinks(ctx, billId),
    };
  }).sort((a, b) => textOf(b.txn_date).localeCompare(textOf(a.txn_date)));

  const classItems = ctx.items.filter(item => item.class_id === id);
  const familyMap = new Map();
  for (const item of classItems) pushInto(familyMap, item.material_family || 'other', item);
  const sqft = entry.specs ? entry.specs.square_feet : null;
  const materials = Array.from(familyMap.entries()).map(([family, familyItems]) => {
    const total = sumBy(familyItems, item => numberOrNull(item.line_total) || 0);
    return { family, n_items: familyItems.length, total, per_sqft: round(ratio(total, sqft)) };
  }).sort((a, b) => b.total - a.total);

  return {
    ...entry,
    vendors,
    bills,
    materials,
    items: classItems.map(item => itemSummary(ctx, item)),
    warnings: ctx.warnings,
    filters: ctx.filters,
  };
}

// Vendor-year figures are per vendor and independent of filters, so they are
// computed once per vendor group and shared by the vendor and category reports.
function cachedVendorYears(ctx, groupKey, metas, category) {
  if (!ctx._yearsByGroup) ctx._yearsByGroup = new Map();
  const cacheKey = `${groupKey}|${category.id}`;
  let years = ctx._yearsByGroup.get(cacheKey);
  if (!years) {
    years = vendorYearStats(ctx, metas, category.id, category.kind);
    ctx._yearsByGroup.set(cacheKey, years);
  }
  return years;
}

// Every vendor group with in-scope bills: identity, vendor category and year rows.
function vendorYearIndex(ctx) {
  if (ctx._yearIndex) return ctx._yearIndex;
  const metasByGroup = new Map();
  for (const meta of ctx.bills.values()) pushInto(metasByGroup, groupKeyOf(meta), meta);
  const index = new Map();
  for (const [groupKey, metas] of metasByGroup.entries()) {
    const identity = identityForGroup(ctx, metas[0]);
    const category = vendorCategoryInfo(ctx, identity.vendorRow);
    index.set(groupKey, { identity, category, years: cachedVendorYears(ctx, groupKey, metas, category) });
  }
  ctx._yearIndex = index;
  return index;
}

// ── Category stats (spec §4.4) ──────────────────────────────────────────────
// Weighted per-spec figure over classes: Σ category spend / Σ sqft (or beds/baths)
// across complete classes that recorded the spec and had spend in this category.
function perSpecSummary(classRows, classById, specKey, includeInProgress, missingReason) {
  let numerator = 0;
  let denominator = 0;
  const perClass = [];
  let excluded = 0;
  for (const row of classRows) {
    const entry = classById.get(row.class_id);
    const divisor = entry && entry.specs ? entry.specs[specKey] : null;
    if (!divisor || divisor <= 0 || row.total <= 0) continue;
    if (!includeInProgress && entry.completeness === 'in_progress') {
      excluded += 1;
      continue;
    }
    numerator += row.total;
    denominator += divisor;
    perClass.push(row.total / divisor);
  }
  const weighted = ratio(numerator, denominator);
  return {
    weighted: round(weighted),
    avg: round(mean(perClass)),
    min: round(minOf(perClass)),
    max: round(maxOf(perClass)),
    n_classes: perClass.length,
    n_in_progress_excluded: excluded,
    reason: weighted === null ? (excluded ? `${missingReason}; ${excluded} in-progress class(es) excluded` : missingReason) : null,
  };
}

function buildCategoryEntry(ctx, info, rows, grandTotal, classById) {
  const total = sumBy(rows, row => row.amount);
  const nonZero = rows.filter(row => !row.zero_amount);

  const vendorMap = new Map();
  for (const row of rows) pushInto(vendorMap, groupKeyOf(row), row);
  const vendors = Array.from(vendorMap.values()).map(vendorRows => {
    const identity = identityForGroup(ctx, vendorRows[0]);
    const vendorTotal = sumBy(vendorRows, row => row.amount);
    return {
      id: identity.id,
      qbo_vendor_id: identity.qbo_vendor_id,
      name: identity.vendor_name,
      total: vendorTotal,
      share: round(ratio(vendorTotal, total), 4),
      bills: distinctBills(vendorRows).size,
    };
  }).sort((a, b) => b.total - a.total);

  const yearMap = new Map();
  for (const row of nonZero) if (row.year) pushInto(yearMap, row.year, row);
  const byYear = Array.from(yearMap.entries())
    .map(([year, yearRows]) => ({ year, total: sumBy(yearRows, row => row.amount), bills: distinctBills(yearRows).size }))
    .sort((a, b) => a.year - b.year);

  const bySpendType = {};
  for (const type of SPEND_TYPES) bySpendType[type] = 0;
  for (const row of rows) bySpendType[row.spend_type] = cents((bySpendType[row.spend_type] || 0) + row.amount);

  const classMap = new Map();
  for (const row of rows) pushInto(classMap, row.class_id, row);
  const classRows = Array.from(classMap.entries()).map(([classId, classRowsList]) => {
    const byType = {};
    for (const type of SPEND_TYPES) byType[type] = 0;
    for (const row of classRowsList) byType[row.spend_type] = cents((byType[row.spend_type] || 0) + row.amount);
    return { class_id: classId, total: sumBy(classRowsList, row => row.amount), by_type: byType, bills: distinctBills(classRowsList).size };
  });
  const includeInProgress = ctx.filters.include_in_progress;
  const byClass = classRows.map(row => {
    const entry = classById.get(row.class_id);
    const sqft = entry && entry.specs ? entry.specs.square_feet : null;
    const completeness = entry ? entry.completeness : 'complete';
    return {
      class_id: row.class_id,
      name: entry ? entry.class_name : ctx.classNames.get(row.class_id) || row.class_id,
      total: row.total,
      bills: row.bills,
      sqft,
      per_sqft: round(ratio(row.total, sqft)),
      completeness,
      in_weighting: Boolean(sqft && sqft > 0 && row.total > 0 && (includeInProgress || completeness !== 'in_progress')),
    };
  }).sort((a, b) => b.total - a.total);

  const NO_SQFT = 'no complete class with square footage and spend in this category';
  const perSqft = perSpecSummary(classRows, classById, 'square_feet', includeInProgress, NO_SQFT);
  const perSqftBySpendType = {};
  for (const type of SPEND_TYPES) {
    const typed = classRows.map(row => ({ class_id: row.class_id, total: row.by_type[type] }));
    perSqftBySpendType[type] = perSpecSummary(typed, classById, 'square_feet', includeInProgress, NO_SQFT);
  }
  const perBedroom = perSpecSummary(classRows, classById, 'bedrooms', includeInProgress, 'no complete class with bedrooms recorded and spend in this category');
  const perBathroom = perSpecSummary(classRows, classById, 'bathrooms', includeInProgress, 'no complete class with bathrooms recorded and spend in this category');

  // FTE-weighted implied hourly: every qualifying complete vendor-year of vendors
  // filed under this category counts as one 2,080-hour year (owner's definition).
  const trade = isTradeCategory(info.id, info.kind);
  const vendorRates = [];
  const qualifyingVendors = new Set();
  if (trade) {
    for (const [groupKey, indexed] of vendorYearIndex(ctx).entries()) {
      if (indexed.category.id !== info.id) continue;
      for (const year of indexed.years) {
        if (year.status !== 'complete' || !year.qualifies) continue;
        vendorRates.push({
          vendor_id: indexed.identity.id,
          vendor: indexed.identity.vendor_name,
          group_key: groupKey,
          year: year.year,
          total: year.total,
          bills: year.bills,
          hourly: year.hourly_full_year,
        });
        qualifyingVendors.add(groupKey);
      }
    }
  }
  vendorRates.sort((a, b) => b.year - a.year || b.total - a.total);
  const rateTotal = sumBy(vendorRates, rate => rate.total);
  const impliedHourly = vendorRates.length ? round(rateTotal / (HOURS_PER_YEAR * vendorRates.length)) : null;
  let impliedReason = null;
  if (!trade) impliedReason = 'not_a_trade';
  else if (!vendorRates.length) impliedReason = 'no vendor in this category has a complete qualifying year yet';

  const categoryItems = ctx.items.filter(item => item.bill && item.bill.effective_category_id === info.id);

  return {
    id: info.id,
    name: info.name,
    kind: info.kind,
    is_trade: trade,
    total,
    share: round(ratio(total, grandTotal), 4),
    bill_count: distinctBills(rows).size,
    vendor_count: vendorMap.size,
    vendors,
    by_year: byYear,
    by_spend_type: bySpendType,
    by_class: byClass,
    implied_hourly: impliedHourly,
    implied_hourly_reason: impliedReason,
    implied_hourly_simple_mean: round(mean(vendorRates.map(rate => rate.hourly))),
    implied_hourly_label: `${RATE_LABELS.full_year} (FTE-weighted)`,
    vendor_rates: vendorRates,
    n_vendor_years: vendorRates.length,
    n_vendors_qualifying: qualifyingVendors.size,
    ...docHourlyFromItems(categoryItems),
    n_items: categoryItems.length,
    per_sqft_weighted: perSqft.weighted,
    per_sqft_avg: perSqft.avg,
    per_sqft_min: perSqft.min,
    per_sqft_max: perSqft.max,
    n_classes_with_sqft: perSqft.n_classes,
    n_in_progress_excluded: perSqft.n_in_progress_excluded,
    per_sqft_reason: perSqft.reason,
    per_sqft_by_spend_type: perSqftBySpendType,
    per_bedroom: perBedroom,
    per_bathroom: perBathroom,
    include_in_progress: includeInProgress,
  };
}

function computeCategories(ctx) {
  if (ctx._categories) return ctx._categories;
  const classById = new Map(computeClasses(ctx).map(entry => [entry.qbo_class_id, entry]));
  const rowsByCategory = new Map();
  for (const row of ctx.filtered) pushInto(rowsByCategory, row.effective_category_id, row);
  const grandTotal = sumBy(ctx.filtered, row => row.amount);

  const ids = [];
  const seen = new Set();
  for (const category of ctx.categories) {
    if (category.is_active !== undefined && category.is_active !== null && !Number(category.is_active)) continue;
    if (!seen.has(String(category.id))) { seen.add(String(category.id)); ids.push(String(category.id)); }
  }
  for (const id of rowsByCategory.keys()) if (!seen.has(id)) { seen.add(id); ids.push(id); }
  if (!seen.has(UNCATEGORIZED_ID)) ids.push(UNCATEGORIZED_ID);

  const categories = ids
    .map(id => buildCategoryEntry(ctx, categoryInfo(ctx, id), rowsByCategory.get(id) || [], grandTotal, classById))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  ctx._categories = categories;
  return categories;
}

function categoryStats(db, filters) {
  const ctx = buildContext(db, filters);
  const categories = computeCategories(ctx);
  return {
    categories,
    total: sumBy(ctx.filtered, row => row.amount),
    labels: RATE_LABELS,
    warnings: ctx.warnings,
    filters: ctx.filters,
  };
}

// Category drawer payload. Returns null for an unknown category id (route → 404).
function categoryDetail(db, categoryId, filters) {
  const ctx = buildContext(db, filters);
  const id = String(categoryId || '');
  if (!ctx.categoriesById.has(id) && !taxonomyCategory(id)) return null;
  const entry = computeCategories(ctx).find(category => category.id === id)
    || buildCategoryEntry(ctx, categoryInfo(ctx, id), [], sumBy(ctx.filtered, row => row.amount), new Map(computeClasses(ctx).map(c => [c.qbo_class_id, c])));

  const rows = ctx.filtered.filter(row => row.effective_category_id === id);
  const billMap = new Map();
  for (const row of rows) pushInto(billMap, row.qbo_bill_id, row);
  const bills = Array.from(billMap.entries()).map(([billId, billRows]) => {
    const meta = ctx.bills.get(billId);
    return {
      qbo_id: billId,
      txn_date: meta.txn_date,
      vendor_id: identityForGroup(ctx, meta).id,
      vendor_name: meta.vendor_name,
      amount: sumBy(billRows, row => row.amount),
      total_amt: meta.total_amt,
      class_name: meta.class_ids.map(classId => ctx.classNames.get(classId) || classId).join(' / '),
      private_note: meta.private_note,
      spend_type: meta.spend_type,
      effective_category: effectiveCategoryOf(ctx, meta),
      attachments: attachmentLinks(ctx, billId),
    };
  }).sort((a, b) => textOf(b.txn_date).localeCompare(textOf(a.txn_date))).slice(0, 500);

  const items = filterItems(ctx).filter(item => item.bill && item.bill.effective_category_id === id);
  const classById = new Map(computeClasses(ctx).map(c => [c.qbo_class_id, c]));
  return {
    ...entry,
    bills,
    materials: {
      families: unitPriceGroups(ctx, items),
      job_costs: jobCostGroups(ctx, items, classById),
    },
    labels: RATE_LABELS,
    warnings: ctx.warnings,
    filters: ctx.filters,
  };
}

// ── Material and job-cost stats (spec §4.5) ─────────────────────────────────
let materialLabelById = null;
function materialTypeLabel(typeId) {
  if (!materialLabelById) {
    materialLabelById = new Map();
    for (const type of Array.isArray(MATERIAL_TYPES) ? MATERIAL_TYPES : []) {
      if (type && type.id) materialLabelById.set(String(type.id), type.label || String(type.id));
    }
  }
  return typeId ? materialLabelById.get(String(typeId)) || null : null;
}

function isUnitPriced(item) {
  const quantity = numberOrNull(item.quantity);
  return item.pricing_basis === 'unit' && quantity !== null && quantity > 0 && item.unit !== 'lot';
}

function itemSample(ctx, item) {
  return {
    vendor: item.bill ? item.bill.vendor_name : null,
    date: item.bill ? item.bill.txn_date : null,
    class: item.class_id ? ctx.classNames.get(item.class_id) || item.class_id : null,
    description: item.description,
    quantity: numberOrNull(item.quantity),
    unit: item.unit || null,
    unit_price: numberOrNull(item.unit_price),
    line_total: numberOrNull(item.line_total),
    attachment_id: item.attachment_id ? String(item.attachment_id) : null,
    qbo_bill_id: item.bill_id,
    item_id: String(item.id),
    source: item.source || 'ai',
    attachment_url: item.attachment_id && item.bill_id
      ? `/api/quickbooks/bills/${encodeURIComponent(item.bill_id)}/attachments/${encodeURIComponent(String(item.attachment_id))}?inline=1`
      : null,
  };
}

function countDistinct(items, fn) {
  const set = new Set();
  for (const item of items) {
    const value = fn(item);
    if (value !== null && value !== undefined && value !== '') set.add(value);
  }
  return set.size;
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) if (value) counts.set(value, (counts.get(value) || 0) + 1);
  let best = null;
  for (const [value, count] of counts.entries()) if (!best || count > best.count) best = { value, count };
  return best ? best.value : null;
}

// Unit-priced groups: family → canonical type (+ spec) with price statistics.
function unitPriceGroups(ctx, items) {
  const unitItems = items.filter(item => isUnitPriced(item) && numberOrNull(item.line_total) !== null);
  const familyMap = new Map();
  for (const item of unitItems) pushInto(familyMap, item.material_family || 'other', item);
  return Array.from(familyMap.entries()).map(([family, familyItems]) => {
    const typeMap = new Map();
    for (const item of familyItems) {
      const typeId = item.material_type || item.material_type_raw || 'other';
      const spec = textOf(item.spec).trim();
      pushInto(typeMap, `${typeId}|${spec.toLowerCase()}`, item);
    }
    const types = Array.from(typeMap.values()).map(typeItems => {
      const firstItem = typeItems[0];
      const typeId = firstItem.material_type || firstItem.material_type_raw || 'other';
      const spec = textOf(firstItem.spec).trim() || null;
      const dominantUnit = mostCommon(typeItems.map(item => item.unit || null));
      const priced = typeItems.filter(item => (item.unit || null) === dominantUnit && numberOrNull(item.unit_price) !== null);
      const prices = priced.map(item => numberOrNull(item.unit_price));
      return {
        family,
        material_type: typeId,
        material_type_label: materialTypeLabel(typeId) || typeId,
        spec,
        n_items: typeItems.length,
        n_documents: countDistinct(typeItems, item => item.attachment_id ? String(item.attachment_id) : null),
        n_vendors: countDistinct(typeItems, item => (item.bill ? groupKeyOf(item.bill) : null)),
        n_manual: typeItems.filter(item => item.source === 'manual').length,
        dominant_unit: dominantUnit,
        n_in_dominant_unit: priced.length,
        avg_unit_price: round(mean(prices)),
        median_unit_price: round(median(prices)),
        min_unit_price: round(minOf(prices)),
        max_unit_price: round(maxOf(prices)),
        total_spend: sumBy(typeItems, item => numberOrNull(item.line_total) || 0),
        raw_types_seen: Array.from(new Set(typeItems.map(item => textOf(item.material_type_raw).trim()).filter(Boolean))).sort(),
        samples: typeItems
          .slice()
          .sort((a, b) => textOf(b.bill && b.bill.txn_date).localeCompare(textOf(a.bill && a.bill.txn_date)))
          .slice(0, SAMPLE_LIMIT)
          .map(item => itemSample(ctx, item)),
      };
    }).sort((a, b) => b.total_spend - a.total_spend || a.material_type_label.localeCompare(b.material_type_label));
    return {
      family,
      n_items: familyItems.length,
      n_types: types.length,
      total_spend: sumBy(familyItems, item => numberOrNull(item.line_total) || 0),
      types,
    };
  }).sort((a, b) => b.total_spend - a.total_spend || a.family.localeCompare(b.family));
}

// Job-cost groups: lump-sum lines (the norm for roofing, painting, HVAC, rough/final
// electrical and plumbing, drywall) grouped by family-or-category × phase.
function jobCostGroups(ctx, items, classById) {
  const jobItems = items.filter(item => !isUnitPriced(item) && numberOrNull(item.line_total) !== null);
  const groupMap = new Map();
  for (const item of jobItems) {
    const family = item.material_family || null;
    const categoryId = family ? null : (item.bill ? item.bill.effective_category_id : UNCATEGORIZED_ID);
    const phase = item.phase || 'n_a';
    pushInto(groupMap, `${family || `category:${categoryId}`}|${phase}`, { item, family, categoryId, phase });
  }
  return Array.from(groupMap.values()).map(entries => {
    const { family, categoryId, phase } = entries[0];
    const groupItems = entries.map(entry => entry.item);
    const totals = groupItems.map(item => numberOrNull(item.line_total));
    const classMap = new Map();
    for (const item of groupItems) pushInto(classMap, item.class_id || UNASSIGNED_CLASS_ID, item);
    const perClass = Array.from(classMap.entries()).map(([classId, classItems]) => {
      const entry = classById ? classById.get(classId) : null;
      const sqft = entry && entry.specs ? entry.specs.square_feet : null;
      const total = sumBy(classItems, item => numberOrNull(item.line_total) || 0);
      return {
        class_id: classId,
        class_name: ctx.classNames.get(classId) || (entry ? entry.class_name : classId),
        n: classItems.length,
        total,
        sqft,
        per_sqft: round(ratio(total, sqft)),
        completeness: entry ? entry.completeness : null,
      };
    }).sort((a, b) => b.total - a.total);
    const categoryLabel = categoryId ? categoryInfo(ctx, categoryId).name : null;
    return {
      group_key: `${family || `category:${categoryId}`}|${phase}`,
      family,
      category_id: categoryId,
      label: `${family ? family.replace(/_/g, ' ') : categoryLabel} — ${phase === 'n_a' ? 'no phase' : phase.replace(/_/g, ' ')}`,
      phase,
      n_jobs: groupItems.length,
      n_documents: countDistinct(groupItems, item => item.attachment_id ? String(item.attachment_id) : null),
      n_vendors: countDistinct(groupItems, item => (item.bill ? groupKeyOf(item.bill) : null)),
      n_manual: groupItems.filter(item => item.source === 'manual').length,
      avg_line_total: round(mean(totals)),
      median_line_total: round(median(totals)),
      min_line_total: round(minOf(totals)),
      max_line_total: round(maxOf(totals)),
      total: sumBy(groupItems, item => numberOrNull(item.line_total) || 0),
      per_class: perClass,
      samples: groupItems
        .slice()
        .sort((a, b) => textOf(b.bill && b.bill.txn_date).localeCompare(textOf(a.bill && a.bill.txn_date)))
        .slice(0, SAMPLE_LIMIT)
        .map(item => itemSample(ctx, item)),
    };
  }).sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

function asList(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

// Owner target matcher — tolerant of the shapes the material-types module may use
// ({ family, phase?, types?, spec_regex?, kinds? }, each a scalar or a list).
function itemMatchesTarget(item, match) {
  if (!match) return false;
  const families = asList(match.family || match.families);
  if (families.length && !families.includes(String(item.material_family || ''))) return false;
  const phases = asList(match.phase || match.phases);
  if (phases.length && !phases.includes(String(item.phase || ''))) return false;
  const types = asList(match.types || match.material_types || match.type);
  if (types.length && !types.includes(String(item.material_type || ''))) return false;
  const kinds = asList(match.kinds || match.item_kinds);
  if (kinds.length && !kinds.includes(String(item.item_kind || ''))) return false;
  if (match.spec_regex) {
    let pattern = null;
    try {
      pattern = match.spec_regex instanceof RegExp ? new RegExp(match.spec_regex.source, match.spec_regex.flags.replace('g', '')) : new RegExp(String(match.spec_regex), 'i');
    } catch (_) {
      pattern = null;
    }
    if (pattern && !pattern.test(`${textOf(item.spec)} ${textOf(item.material_type_raw)} ${textOf(item.description)}`)) return false;
  }
  return true;
}

function targetStatus(ctx, targetId) {
  const row = ctx.targetByKey.get(String(targetId)) || null;
  return {
    status: row ? row.status || 'open' : 'open',
    answer: row ? row.answer || null : null,
    answered_by: row ? row.answered_by || null : null,
    answered_by_name: row && row.answered_by ? ctx.userNameById.get(String(row.answered_by)) || null : null,
    answered_at: row ? row.answered_at || null : null,
  };
}

// Owner-target membership is defined by the material-types module (family must
// match, then canonical type in `types` OR phase equal; neither given = the whole
// family), so the same rule counts items here and in the extractor. The tolerant
// local matcher above is only the fallback for a data module without the export.
function targetMatches(item, target) {
  if (typeof matchesCoverageTarget === 'function') return matchesCoverageTarget(item, target);
  return itemMatchesTarget(item, target && target.match);
}

function coverageForTargets(ctx, items) {
  return (Array.isArray(COVERAGE_TARGETS) ? COVERAGE_TARGETS : []).map(target => {
    const matched = items.filter(item => targetMatches(item, target));
    const unitItems = matched.filter(isUnitPriced);
    const nUnit = unitItems.length;
    const nJob = matched.length - nUnit;
    const total = nUnit + nJob;
    return {
      id: String(target.id),
      label: target.label || String(target.id),
      n_unit_items: nUnit,
      n_job_items: nJob,
      n_items: total,
      status: total >= 3 ? 'ok' : (total > 0 ? 'thin' : 'none'),
      avg_unit_price: round(mean(unitItems.map(item => numberOrNull(item.unit_price)).filter(v => v !== null))),
      avg_job_cost: round(mean(matched.filter(item => !isUnitPriced(item)).map(item => numberOrNull(item.line_total)).filter(v => v !== null))),
      target: targetStatus(ctx, target.id),
    };
  });
}

function isTextStub(attachment) {
  return String(attachment.mime_type || '').toLowerCase().startsWith('text/');
}

// The "tell me and I will help" list. Never includes document text or the contents
// of the text-stub attachments — only ids, names and the extractor's short reason.
function buildUnknowns(ctx, items, coverage) {
  const unknowns = [];
  const resolved = [];
  const stubAttachmentIds = new Set();

  for (const attachment of ctx.attachments) {
    if (!isTextStub(attachment)) continue;
    const billId = String(attachment.qbo_bill_id);
    if (!ctx.bills.has(billId)) continue;
    stubAttachmentIds.add(String(attachment.id));
    const bill = ctx.bills.get(billId);
    unknowns.push({
      kind: 'text_stub',
      attachment_id: String(attachment.id),
      qbo_bill_id: billId,
      vendor_name: bill.vendor_name,
      txn_date: bill.txn_date,
      message: `attachment is not a PDF/image — re-run the QuickBooks PDF sync with force for bill ${billId}`,
      reason: 'text stub instead of a document',
    });
  }

  for (const doc of ctx.documents) {
    const attachmentId = String(doc.attachment_id);
    if (stubAttachmentIds.has(attachmentId)) continue;
    const billId = doc.qbo_bill_id ? String(doc.qbo_bill_id) : null;
    const bill = billId ? ctx.bills.get(billId) || null : null;
    const label = `${bill ? bill.vendor_name : 'unknown vendor'}${bill && bill.txn_date ? ` ${bill.txn_date}` : ''}`;
    if (['unreadable', 'failed', 'skipped'].includes(doc.status)) {
      unknowns.push({
        kind: `document_${doc.status}`,
        attachment_id: attachmentId,
        qbo_bill_id: billId,
        vendor_name: bill ? bill.vendor_name : null,
        txn_date: bill ? bill.txn_date : null,
        bill_total: bill ? bill.total_amt : null,
        message: `${label}: document ${doc.status}${doc.error ? ` — ${doc.error}` : ''}`,
        reason: doc.error || doc.status,
        attempts: Number(doc.attempts) || 0,
      });
    } else if (doc.status === 'extracted' && doc.totals_match !== null && doc.totals_match !== undefined
      && !Number(doc.totals_match) && !doc.totals_match_reason) {
      unknowns.push({
        kind: 'totals_mismatch',
        attachment_id: attachmentId,
        qbo_bill_id: billId,
        vendor_name: bill ? bill.vendor_name : null,
        txn_date: bill ? bill.txn_date : null,
        bill_total: bill ? bill.total_amt : null,
        document_total: numberOrNull(doc.document_total),
        message: `${label}: document total ${numberOrNull(doc.document_total)} does not match the bill total ${bill ? bill.total_amt : 'unknown'}`,
        reason: 'document total differs from the QuickBooks bill',
      });
    }
  }

  for (const item of items) {
    if (!Number(item.needs_review)) continue;
    unknowns.push({
      kind: 'item_needs_review',
      item_id: String(item.id),
      attachment_id: item.attachment_id ? String(item.attachment_id) : null,
      qbo_bill_id: item.bill_id,
      vendor_name: item.bill ? item.bill.vendor_name : null,
      txn_date: item.bill ? item.bill.txn_date : null,
      description: item.description,
      message: `${item.bill ? item.bill.vendor_name : 'manual item'}: "${item.description}" — ${item.review_reason || 'needs review'}`,
      reason: item.review_reason || 'needs review',
    });
  }

  for (const warning of ctx.warnings) {
    if (warning.kind === 'credit_line' || warning.kind === 'lines_mismatch') {
      unknowns.push({ ...warning, reason: warning.kind === 'credit_line' ? 'credit line' : 'bill lines do not add up' });
    }
  }

  for (const row of coverage) {
    const entry = {
      kind: 'target_empty',
      target: row.id,
      label: row.label,
      message: `no priced line for "${row.label}" in any document yet`,
      reason: 'no document mentions it',
      target_status: row.target,
    };
    if (row.status === 'none' && row.target.status === 'open') unknowns.push(entry);
    else if (row.target.status !== 'open') resolved.push({ ...entry, kind: 'target_' + row.target.status, message: `"${row.label}": ${row.target.status === 'answered' ? `answered — ${row.target.answer || ''}` : 'not applicable'}` });
  }

  return { unknowns, resolved };
}

function documentCounts(ctx) {
  const counts = { rows: ctx.documents.length, extracted: 0, pending: 0, running: 0, failed: 0, unreadable: 0, skipped: 0, duplicate: 0 };
  for (const doc of ctx.documents) if (counts[doc.status] !== undefined) counts[doc.status] += 1;
  counts.attachments = ctx.attachments.length;
  counts.needs_review_items = ctx.items.filter(item => Number(item.needs_review)).length;
  return counts;
}

function computeMaterials(ctx) {
  if (ctx._materials) return ctx._materials;
  const items = filterItems(ctx);
  const classById = new Map(computeClasses(ctx).map(entry => [entry.qbo_class_id, entry]));
  const coverage = coverageForTargets(ctx, items);
  const { unknowns, resolved } = buildUnknowns(ctx, items, coverage);
  const targetIds = new Set(coverage.map(row => row.id));
  const targets = coverage.map(row => ({ target: row.id, label: row.label, ...row.target }));
  for (const row of ctx.targets) {
    if (!targetIds.has(String(row.target))) targets.push({ target: String(row.target), label: String(row.target), ...targetStatus(ctx, row.target) });
  }
  const result = {
    families: unitPriceGroups(ctx, items),
    job_costs: jobCostGroups(ctx, items, classById),
    unknowns,
    resolved,
    coverage,
    targets,
    totals: {
      n_items: items.length,
      n_unit_items: items.filter(isUnitPriced).length,
      n_job_items: items.filter(item => !isUnitPriced(item)).length,
      n_manual_items: items.filter(item => item.source === 'manual').length,
      n_items_without_amount: items.filter(item => numberOrNull(item.line_total) === null).length,
    },
    documents: documentCounts(ctx),
  };
  ctx._materials = result;
  return result;
}

function materialStats(db, filters) {
  const ctx = buildContext(db, filters);
  return { ...computeMaterials(ctx), warnings: ctx.warnings, filters: ctx.filters };
}

// ── Overview (spec §6 GET /overview) ────────────────────────────────────────
const RATE_CAPTION = 'Implied rate = amount billed ÷ assumed hours (40 h/wk). It is a cost benchmark, not the contractor\'s wage.';

function overview(db, filters) {
  const ctx = buildContext(db, filters);
  const vendors = computeVendors(ctx);
  const classes = computeClasses(ctx);
  const categories = computeCategories(ctx);
  const spend = sumBy(ctx.filtered, row => row.amount);
  const spendByType = {};
  for (const type of SPEND_TYPES) spendByType[type] = 0;
  for (const row of ctx.filtered) spendByType[row.spend_type] = cents((spendByType[row.spend_type] || 0) + row.amount);
  const yearsAvailable = Array.from(new Set(ctx.allocations.map(row => row.year).filter(Boolean))).sort((a, b) => a - b);

  return {
    totals: {
      spend,
      bills: distinctBills(ctx.filtered).size,
      vendors: vendors.length,
      vendors_categorized: vendors.filter(vendor => vendor.category.id !== UNCATEGORIZED_ID).length,
      vendors_needing_review: vendors.filter(vendor => vendor.needs_review).length,
      classes: classes.filter(entry => entry.bill_count > 0).length,
      classes_with_sqft: classes.filter(entry => entry.specs && entry.specs.square_feet).length,
    },
    spend_by_type: spendByType,
    years_available: yearsAvailable,
    categories: categories
      .filter(category => category.total !== 0)
      .map(category => ({ id: category.id, name: category.name, kind: category.kind, total: category.total, share: category.share, vendor_count: category.vendor_count })),
    top_vendors: vendors.slice(0, TOP_VENDORS_LIMIT).map(vendor => ({
      id: vendor.id,
      qbo_vendor_id: vendor.qbo_vendor_id,
      vendor_name: vendor.vendor_name,
      category: { id: vendor.category.id, name: vendor.category.name, kind: vendor.category.kind },
      total: vendor.total,
      bill_count: vendor.bill_count,
      headline_hourly: vendor.headline_hourly,
      headline_hourly_reason: vendor.headline_hourly_reason,
      latest_annualized: vendor.hourly.latest_annualized,
      needs_review: vendor.needs_review,
    })),
    documents: documentCounts(ctx),
    last_scan: ctx.lastScan ? { ...ctx.lastScan, error: ctx.lastScan.error ? String(ctx.lastScan.error).slice(0, 300) : null } : null,
    rate_caption: RATE_CAPTION,
    labels: RATE_LABELS,
    warnings: ctx.warnings,
    filters: ctx.filters,
  };
}

// ── CSV export (spec §6 GET /export.csv) ────────────────────────────────────
// Every text cell is double-quoted with quotes doubled; text starting with a formula
// trigger (= + - @ tab CR) gets a leading apostrophe so a spreadsheet never executes
// a vendor name; numbers stay bare; rows end in CRLF.
function csvCell(value) {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '""';
  if (typeof value === 'boolean') return value ? '"yes"' : '"no"';
  let text = Array.isArray(value) ? value.join('; ') : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function csvLine(cells) {
  return cells.map(csvCell).join(',');
}

function toCsv(header, rows) {
  return [csvLine(header), ...rows.map(csvLine)].join('\r\n') + '\r\n';
}

const CSV_REPORTS = ['vendors', 'classes', 'categories', 'materials'];

function vendorsCsv(ctx) {
  const header = [
    'Vendor', 'QuickBooks vendor id', 'Category', 'Kind', 'Category source', 'Confidence', 'Needs review',
    'Bills', 'Total', 'First bill', 'Last bill', RATE_LABELS.full_year, 'Full-year basis years',
    RATE_LABELS.annualized, 'Annualized year', RATE_LABELS.active_weeks + ' (latest year)', RATE_LABELS.doc,
    'Bills elsewhere', 'Bills elsewhere total', 'Documents share', 'Profile list mismatch', 'Rate note',
  ];
  const rows = computeVendors(ctx).map(vendor => {
    const latestYear = vendor.years.length ? vendor.years[vendor.years.length - 1] : null;
    return [
      vendor.vendor_name, vendor.qbo_vendor_id, vendor.category.name, vendor.category.kind, vendor.category.source,
      vendor.category.confidence, vendor.needs_review, vendor.bill_count, vendor.total, vendor.first_bill, vendor.last_bill,
      vendor.hourly.full_year_avg, vendor.hourly.full_year_years.join(' '),
      vendor.hourly.latest_annualized ? vendor.hourly.latest_annualized.hourly_annualized : null,
      vendor.hourly.latest_annualized ? vendor.hourly.latest_annualized.year : null,
      latestYear ? latestYear.hourly_active_weeks : null,
      vendor.hourly.doc_hourly, vendor.bills_elsewhere.count, vendor.bills_elsewhere.total, vendor.has_documents_share,
      vendor.profile ? vendor.profile.list_mismatch : null, vendor.hourly.full_year_avg_reason,
    ];
  });
  return toCsv(header, rows);
}

function classesCsv(ctx) {
  const header = [
    'Class', 'Class id', 'Linked project', 'Project type', 'Type source', 'Status', 'Total', 'Bills', 'Vendors',
    'First bill', 'Last bill', 'Sq ft', 'Bedrooms', 'Bathrooms', 'Units', '$/sq ft (rehab + new)', '$/bedroom',
    '$/bathroom', '$/unit', 'Rehab', 'New construction', 'Maintenance', 'Other', 'Maintenance $/sq ft/yr',
    'Documents coverage', 'Allocated share', 'Note',
  ];
  const rows = computeClasses(ctx).map(entry => [
    entry.class_name, entry.qbo_class_id, entry.linked_project ? entry.linked_project.job_name : null,
    entry.project_type, entry.project_type_source, entry.completeness, entry.total, entry.bill_count, entry.vendor_count,
    entry.first_bill, entry.last_bill,
    entry.specs ? entry.specs.square_feet : null, entry.specs ? entry.specs.bedrooms : null,
    entry.specs ? entry.specs.bathrooms : null, entry.specs ? entry.specs.units : null,
    entry.per_sqft, entry.per_bedroom, entry.per_bathroom, entry.per_unit,
    entry.spend_by_type.rehab, entry.spend_by_type.new_construction, entry.spend_by_type.maintenance, entry.spend_by_type.other,
    entry.maintenance_per_sqft_per_year, entry.documents_coverage, entry.allocated_share, entry.per_sqft_reason,
  ]);
  return toCsv(header, rows);
}

function categoriesCsv(ctx) {
  const header = [
    'Category', 'Id', 'Kind', 'Total', 'Share', 'Bills', 'Vendors', `${RATE_LABELS.full_year} FTE-weighted`, 'Vendor-years',
    'Simple mean $/hr', RATE_LABELS.doc, '$/sq ft (weighted)', '$/sq ft avg', '$/sq ft min', '$/sq ft max',
    'Classes with sq ft', 'In-progress classes excluded', '$/bedroom (weighted)', '$/bathroom (weighted)', 'Rate note',
  ];
  const rows = computeCategories(ctx).map(category => [
    category.name, category.id, category.kind, category.total, category.share, category.bill_count, category.vendor_count,
    category.implied_hourly, category.n_vendor_years, category.implied_hourly_simple_mean, category.doc_hourly,
    category.per_sqft_weighted, category.per_sqft_avg, category.per_sqft_min, category.per_sqft_max,
    category.n_classes_with_sqft, category.n_in_progress_excluded, category.per_bedroom.weighted, category.per_bathroom.weighted,
    category.implied_hourly_reason,
  ]);
  return toCsv(header, rows);
}

function materialsCsv(ctx) {
  const header = [
    'Basis', 'Family', 'Type', 'Spec / phase', 'Unit', 'Items', 'Documents', 'Vendors', 'Manual items',
    'Average', 'Median', 'Min', 'Max', 'Total spend', 'Raw types seen',
  ];
  const materials = computeMaterials(ctx);
  const rows = [];
  for (const family of materials.families) {
    for (const type of family.types) {
      rows.push([
        'unit price', family.family, type.material_type_label, type.spec, type.dominant_unit, type.n_items, type.n_documents,
        type.n_vendors, type.n_manual, type.avg_unit_price, type.median_unit_price, type.min_unit_price, type.max_unit_price,
        type.total_spend, type.raw_types_seen.join('; '),
      ]);
    }
  }
  for (const group of materials.job_costs) {
    rows.push([
      'job cost', group.family || `category: ${group.category_id}`, group.label, group.phase, 'job', group.n_jobs, group.n_documents,
      group.n_vendors, group.n_manual, group.avg_line_total, group.median_line_total, group.min_line_total, group.max_line_total,
      group.total, null,
    ]);
  }
  return toCsv(header, rows);
}

// Returns { filename, csv } or null for an unknown report name (route → 400).
function csvForReport(db, report, filters) {
  const name = String(report || '').toLowerCase();
  if (!CSV_REPORTS.includes(name)) return null;
  const ctx = buildContext(db, filters);
  let csv;
  if (name === 'vendors') csv = vendorsCsv(ctx);
  else if (name === 'classes') csv = classesCsv(ctx);
  else if (name === 'categories') csv = categoriesCsv(ctx);
  else csv = materialsCsv(ctx);
  const from = ctx.filters.from || 'all';
  const to = ctx.filters.to || 'all';
  return { filename: `cost-analyzer-${name}-${from}_${to}.csv`, csv };
}

module.exports = {
  // constants
  HOURS_PER_WEEK,
  HOURS_PER_YEAR,
  MIN_BILLS_FOR_HOURLY,
  MIN_WEEKS_FOR_HOURLY,
  HOURS_PER_DAY,
  UNASSIGNED_CLASS_ID,
  EXCLUDED_VENDOR_NAMES,
  IN_PROGRESS_RECENT_DAYS,
  LABOR_ONLY_MIN_COVERAGE,
  REVIEW_CONFIDENCE,
  RATE_LABELS,
  RATE_CAPTION,
  CSV_REPORTS,
  // helpers
  ratio,
  round,
  cents,
  isIsoDate,
  daysInclusive,
  isoWeekKey,
  weeksSpanOf,
  parseFilters,
  normalizeFilters,
  // pure building blocks
  effectiveCategoryForBill,
  keywordMatch,
  billInScope,
  buildAllocations,
  buildContext,
  // reports
  loadAllocations,
  vendorStats,
  vendorDetail,
  classStats,
  classDetail,
  categoryStats,
  categoryDetail,
  materialStats,
  overview,
  csvForReport,
  csvCell,
};
