// Cost Analyzer API (spec section 6), mounted at /api/cost-analyzer by server.js.
//
// The numbers come from services/costAnalyzerStats.js, vendor category writes go
// through services/costAnalyzerCategories.js and document scans through
// services/costAnalyzerExtraction.js; this file owns HTTP concerns only: role
// gating, hand-written validation, the project-manager "add only" rule for class
// specs, audit logging and the CSV response headers.
//
// Route order matters in Express 5: every literal path is registered before the
// parameterised one that could swallow it (/categories/stats before
// /categories/:id, /vendors/auto-categorize before /vendors/:id, /documents/scan*
// before /documents/:attachmentId, /materials/items|targets before anything
// parameterised).
'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');

const { getDb } = require('../db/schema');
const {
  authenticate,
  authorize,
  authorizeUpperManagement,
  blockProjectManagerMutation,
} = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { logDataAccess } = require('../utils/dataAccessAudit');
const { resolveAnthropicApiKey } = require('../utils/anthropicKey');
const stats = require('../services/costAnalyzerStats');
const categoriesService = require('../services/costAnalyzerCategories');
const { MATERIAL_FAMILIES, PHASES, ITEM_KINDS, UNITS } = require('../data/costAnalyzerTaxonomy');
const { canonicalMaterialType, COVERAGE_TARGET_BY_ID } = require('../data/costAnalyzerMaterialTypes');

const router = express.Router();

// Owner, operations manager and project managers may read everything; the
// admin_assistant role is out of scope for the Cost Analyzer (spec 0.3).
const VIEW_ROLES = ['super_admin', 'operations_manager', 'project_manager'];
const ENTITY_TYPE = 'cost_analyzer';
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;
const PROJECT_TYPES = ['rehab', 'new_construction', 'rental_maintenance', 'wholesale', 'other'];
const TARGET_STATUSES = ['open', 'answered', 'not_applicable'];
const DOCUMENT_STATUSES = ['pending', 'running', 'extracted', 'unreadable', 'failed', 'skipped', 'duplicate'];
const SCAN_SCOPES = ['pending', 'failed', 'all', 'selected'];
const MAX_SCAN_ATTACHMENTS = 500;
const UNASSIGNED_CLASS_ID = stats.UNASSIGNED_CLASS_ID || '__unassigned__';
const AUTO_SCAN_INTERVAL_MS = 10 * 60 * 1000;
// Units that mean "priced as a job, not per unit" (mirrors the extractor's rule).
const JOB_UNITS = new Set(['lot', 'other']);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function text(value, maxLength = 500) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function hasOwn(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundCents(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
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

function parseJsonObject(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function attachmentUrl(qboBillId, attachmentId) {
  if (!qboBillId || !attachmentId) return null;
  return `/api/quickbooks/bills/${encodeURIComponent(String(qboBillId))}/attachments/${encodeURIComponent(String(attachmentId))}?inline=1`;
}

// A value that is present in the body: undefined = "not sent", null/'' = "clear".
function optionalNumber(value, field, { min = -Infinity, max = Infinity, integer = false, step = null } = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw httpError(400, `${field} must be a number`);
  if (parsed < min || parsed > max) throw httpError(400, `${field} must be between ${min} and ${max}`);
  if (integer && !Number.isInteger(parsed)) throw httpError(400, `${field} must be a whole number`);
  if (step && Math.abs(Math.round(parsed / step) * step - parsed) > 1e-9) throw httpError(400, `${field} must be a multiple of ${step}`);
  return parsed;
}

function optionalChoice(value, field, allowed) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const normalized = String(value).trim();
  if (!allowed.includes(normalized)) throw httpError(400, `${field} must be one of ${allowed.join(', ')}`);
  return normalized;
}

function optionalText(value, field, maxLength) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw httpError(400, `${field} must be text`);
  return text(value, maxLength);
}

function optionalBoolean(value, field) {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false' || value === null) return false;
  throw httpError(400, `${field} must be true or false`);
}

function intParam(value, field, { min, max, fallback }) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw httpError(400, `${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function queryString(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return text(raw, 200);
}

function sendError(res, err, fallback = 'Cost Analyzer request failed') {
  const status = Number(err && (err.statusCode || err.status));
  if (Number.isInteger(status) && status >= 400 && status < 600) {
    return res.status(status).json({ error: (err && err.message) || fallback });
  }
  console.error('[COST-ANALYZER] route error:', err && err.stack ? err.stack : err);
  return res.status(500).json({ error: fallback });
}

// Every handler runs inside this so a thrown httpError becomes { error } with its
// status and anything else becomes a logged 500 (never a hung request).
function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      sendError(res, err);
    }
  };
}

function readFilters(req) {
  const parsed = stats.parseFilters(req.query || {});
  if (!parsed.ok) throw httpError(400, parsed.error);
  return parsed.filters;
}

function auditView(req, action, { entityId = null, recordCount = null, riskLevel = 'standard', details = null } = {}) {
  logDataAccess(req, {
    action,
    accessType: 'view',
    entityType: ENTITY_TYPE,
    entityId,
    recordCount,
    riskLevel,
    details,
  });
}

function auditMutation(req, action, entityId, details = null, projectId = null) {
  logActivity({
    userId: req.user.id,
    projectId,
    action,
    entityType: ENTITY_TYPE,
    entityId,
    details,
  });
  logDataAccess(req, {
    action,
    accessType: 'modify',
    entityType: ENTITY_TYPE,
    entityId,
    riskLevel: 'high',
    details,
  });
}

// The extraction service pulls in the Anthropic SDK, sharp and pdf-lib. It is
// loaded lazily so a broken native module can never take the whole Cost
// Analyzer down: only the scan endpoints report 503 (same idea as the lazy SDK
// require in routes/quoteAnalytics.js).
let extractionModule = null;
let extractionLoadError = null;
function extractionService() {
  if (extractionModule) return extractionModule;
  if (extractionLoadError) throw extractionLoadError;
  try {
    extractionModule = require('../services/costAnalyzerExtraction');
    return extractionModule;
  } catch (err) {
    console.error('[COST-ANALYZER] extraction service unavailable:', err && err.message ? err.message : err);
    extractionLoadError = httpError(503, 'Document scanning is unavailable on this server');
    throw extractionLoadError;
  }
}

// ---------------------------------------------------------------------------
// Category lookups
// ---------------------------------------------------------------------------

function categoryRow(db, id) {
  const clean = text(id, 120);
  if (!clean) return null;
  return db.prepare('SELECT id, name, kind, sort_order, is_active FROM cost_analyzer_categories WHERE id = ?').get(clean) || null;
}

// A category id from a request body: must exist and be active (spec 6 validation).
function requireActiveCategory(db, value, field) {
  const id = text(value, 120);
  if (!id) throw httpError(400, `${field} is required`);
  const category = categoryRow(db, id);
  if (!category) throw httpError(400, `${field} is not a known cost category`);
  if (!Number(category.is_active)) throw httpError(400, `${category.name} is an inactive cost category`);
  return category;
}

// ---------------------------------------------------------------------------
// Vendor selectors (spec 6: vendor row id, qbo:<qboId>, profile:<profileId>;
// also key:<vendor_key> and a bare QuickBooks vendor id, which the stats module
// hands out too)
// ---------------------------------------------------------------------------

function identityFromRow(row) {
  return {
    qboVendorId: row.qbo_vendor_id ? String(row.qbo_vendor_id) : null,
    profileId: row.profile_id ? String(row.profile_id) : null,
    vendorName: row.vendor_name,
    row,
  };
}

function vendorFromQbo(db, qboVendorId) {
  const id = text(qboVendorId, 120);
  if (!id) return null;
  const vendor = db.prepare('SELECT qbo_id, display_name, company_name FROM quickbooks_vendors WHERE qbo_id = ?').get(id) || null;
  const profile = db.prepare(`
    SELECT id, vendor_name FROM contractor_profiles WHERE quickbooks_vendor_id = ? ORDER BY created_at LIMIT 1
  `).get(id) || null;
  const bill = db.prepare(`
    SELECT vendor_name FROM quickbooks_bills
    WHERE vendor_id = ? AND vendor_name IS NOT NULL AND trim(vendor_name) != ''
    ORDER BY txn_date DESC LIMIT 1
  `).get(id) || null;
  const vendorName = text(vendor && (vendor.display_name || vendor.company_name))
    || text(bill && bill.vendor_name)
    || text(profile && profile.vendor_name);
  if (!vendorName) return null;
  return { qboVendorId: id, profileId: profile ? String(profile.id) : null, vendorName };
}

function vendorFromProfile(db, profileId) {
  const id = text(profileId, 120);
  if (!id) return null;
  const profile = db.prepare('SELECT id, vendor_name, quickbooks_vendor_id FROM contractor_profiles WHERE id = ?').get(id) || null;
  if (!profile || !text(profile.vendor_name)) return null;
  return { qboVendorId: text(profile.quickbooks_vendor_id, 120), profileId: String(profile.id), vendorName: text(profile.vendor_name) };
}

function vendorFromKey(db, key) {
  const clean = categoriesService.vendorKey(key);
  if (!clean) return null;
  const vendor = db.prepare(`
    SELECT qbo_id, display_name FROM quickbooks_vendors WHERE lower(trim(display_name)) = ? ORDER BY active DESC, qbo_id LIMIT 1
  `).get(clean) || null;
  const profile = db.prepare(`
    SELECT id, vendor_name, quickbooks_vendor_id FROM contractor_profiles WHERE lower(trim(vendor_name)) = ? ORDER BY created_at LIMIT 1
  `).get(clean) || null;
  const bill = db.prepare(`
    SELECT vendor_id, vendor_name FROM quickbooks_bills WHERE lower(trim(vendor_name)) = ? ORDER BY txn_date DESC LIMIT 1
  `).get(clean) || null;
  const vendorName = text(vendor && vendor.display_name) || text(profile && profile.vendor_name) || text(bill && bill.vendor_name);
  if (!vendorName) return null;
  const qboVendorId = (vendor && text(vendor.qbo_id, 120))
    || (profile && text(profile.quickbooks_vendor_id, 120))
    || (bill && text(bill.vendor_id, 120))
    || null;
  return { qboVendorId, profileId: profile ? String(profile.id) : null, vendorName };
}

// Returns { qboVendorId, profileId, vendorName, row } (row null when the vendor has
// no cost_analyzer_vendor_categories row yet) or null when nothing matches.
function resolveVendorSelector(db, selector) {
  const value = text(selector, 200);
  if (!value) return null;
  const direct = categoriesService.getVendorCategoryRow(db, value);
  if (direct) return identityFromRow(direct);

  let identity = null;
  if (value.startsWith('qbo:')) identity = vendorFromQbo(db, value.slice(4));
  else if (value.startsWith('profile:')) identity = vendorFromProfile(db, value.slice(8));
  else if (value.startsWith('key:')) identity = vendorFromKey(db, value.slice(4));
  else identity = vendorFromProfile(db, value) || vendorFromQbo(db, value);
  if (!identity) return null;

  const row = categoriesService.findVendorCategoryRow(db, identity);
  return { ...identity, row: row || null };
}

// Response of a vendor mutation: the refreshed vendor entry (spec 4.2 shape) plus
// the raw row, history id and profile sync outcome.
function vendorMutationPayload(db, result, extra = {}) {
  const row = result.row;
  let vendor = null;
  try {
    vendor = stats.vendorDetail(db, row.id, {});
  } catch (err) {
    console.warn('[COST-ANALYZER] vendor detail after mutation failed:', err && err.message ? err.message : err);
  }
  const profileSync = result.profile_sync || null;
  return {
    vendor,
    row,
    changed: result.changed !== false,
    history_id: result.history_id || null,
    profile_sync: profileSync,
    profile_list_mismatch: Boolean(profileSync && profileSync.list_mismatch),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------

const BILL_CATEGORY_SELECT = `
  SELECT qbo_bill_id, category_id, source, confidence, rationale, set_by, set_at
  FROM cost_analyzer_bill_categories
  WHERE qbo_bill_id = ?
`;

// Effective category of one bill after a change, computed with the same pure rule
// the reports use (manual > ai > keyword > vendor > uncategorized).
function billEffectiveCategory(db, bill) {
  const lines = db.prepare(`
    SELECT id, line_num, description FROM quickbooks_bill_lines WHERE qbo_bill_id = ? ORDER BY line_num, id
  `).all(bill.qbo_id);
  const vendorRow = categoriesService.findVendorCategoryRow(db, {
    qboVendorId: bill.vendor_id ? String(bill.vendor_id) : null,
    vendorName: bill.vendor_name,
  });
  const override = db.prepare(BILL_CATEGORY_SELECT).get(bill.qbo_id) || null;
  const effective = stats.effectiveCategoryForBill(bill, lines, vendorRow, override);
  const category = categoryRow(db, effective.category_id);
  return {
    id: effective.category_id,
    name: category ? category.name : effective.category_id,
    kind: category ? category.kind : 'other',
    source: effective.source,
    confidence: effective.confidence,
    rationale: effective.rationale,
    keyword: effective.keyword,
    vendor_category_id: effective.vendor_category_id,
  };
}

// ---------------------------------------------------------------------------
// Class specs (spec 6: PUT /classes/:id/specs)
// ---------------------------------------------------------------------------

const PM_SPECS_MESSAGE = 'Project managers can add missing size details, but cannot change or clear values already recorded.';

function specsRow(db, classId) {
  const row = db.prepare(`
    SELECT s.qbo_class_id, s.class_name, s.project_id, s.square_feet, s.bedrooms, s.bathrooms, s.units, s.stories,
           s.year_built, s.project_type, s.notes, s.updated_by, s.updated_at, u.name AS updated_by_name
    FROM cost_analyzer_class_specs s
    LEFT JOIN users u ON u.id = s.updated_by
    WHERE s.qbo_class_id = ?
  `).get(classId) || null;
  if (!row) return null;
  return {
    square_feet: numberOrNull(row.square_feet),
    bedrooms: numberOrNull(row.bedrooms),
    bathrooms: numberOrNull(row.bathrooms),
    units: numberOrNull(row.units),
    stories: numberOrNull(row.stories),
    year_built: numberOrNull(row.year_built),
    project_type: row.project_type || null,
    notes: row.notes || null,
    project_id: row.project_id || null,
    updated_by: row.updated_by || null,
    updated_by_name: row.updated_by_name || null,
    updated_at: row.updated_at || null,
  };
}

// A class is known when bills or lines carry it, a specs row exists, or a project
// is linked to it. Returns { class_name, project } or null.
function lookupClass(db, classId) {
  const spec = db.prepare('SELECT class_name, project_id FROM cost_analyzer_class_specs WHERE qbo_class_id = ?').get(classId) || null;
  const project = db.prepare(`
    SELECT id, job_name, quickbooks_class_name FROM projects WHERE quickbooks_class_id = ? ORDER BY created_at LIMIT 1
  `).get(classId) || null;
  const line = db.prepare(`
    SELECT class_name FROM quickbooks_bill_lines WHERE class_id = ? ORDER BY class_name IS NULL, id LIMIT 1
  `).get(classId) || null;
  const bill = db.prepare(`
    SELECT qbo_class_name FROM quickbooks_bills WHERE qbo_class_id = ? ORDER BY qbo_class_name IS NULL, qbo_id LIMIT 1
  `).get(classId) || null;
  if (!spec && !project && !line && !bill) return null;
  const className = text(spec && spec.class_name, 200)
    || text(line && line.class_name, 200)
    || text(bill && bill.qbo_class_name, 200)
    || text(project && project.quickbooks_class_name, 200)
    || text(project && project.job_name, 200)
    || classId;
  return { class_name: className, project, spec };
}

// Validates the PUT body and returns only the fields that were sent (whitelisted
// literal column names; values already coerced). Throws httpError.
function parseSpecsBody(db, body) {
  const fields = {};
  const currentYear = new Date().getUTCFullYear();
  if (hasOwn(body, 'square_feet')) fields.square_feet = optionalNumber(body.square_feet, 'square_feet', { min: 100, max: 50000 });
  if (hasOwn(body, 'bedrooms')) fields.bedrooms = optionalNumber(body.bedrooms, 'bedrooms', { min: 0, max: 20, integer: true });
  if (hasOwn(body, 'bathrooms')) fields.bathrooms = optionalNumber(body.bathrooms, 'bathrooms', { min: 0, max: 20, step: 0.5 });
  if (hasOwn(body, 'units')) fields.units = optionalNumber(body.units, 'units', { min: 1, max: 50, integer: true });
  if (hasOwn(body, 'stories')) fields.stories = optionalNumber(body.stories, 'stories', { min: 0.5, max: 10, step: 0.5 });
  if (hasOwn(body, 'year_built')) fields.year_built = optionalNumber(body.year_built, 'year_built', { min: 1800, max: currentYear + 1, integer: true });
  if (hasOwn(body, 'project_type')) fields.project_type = optionalChoice(body.project_type, 'project_type', PROJECT_TYPES);
  if (hasOwn(body, 'notes')) fields.notes = optionalText(body.notes, 'notes', 2000);
  if (hasOwn(body, 'project_id')) {
    const projectId = optionalText(body.project_id, 'project_id', 120);
    if (projectId) {
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
      if (!project) throw httpError(404, 'Project not found');
    }
    fields.project_id = projectId || null;
  }
  return fields;
}

function sameSpecValue(stored, next) {
  if (stored === null || stored === undefined) return next === null || next === undefined;
  if (next === null || next === undefined) return false;
  const storedNumber = Number(stored);
  const nextNumber = Number(next);
  if (Number.isFinite(storedNumber) && Number.isFinite(nextNumber) && String(stored).trim() !== '' && String(next).trim() !== '') {
    return Math.abs(storedNumber - nextNumber) < 1e-9;
  }
  return String(stored).trim() === String(next).trim();
}

// ---------------------------------------------------------------------------
// Material items
// ---------------------------------------------------------------------------

const ITEM_SELECT = `
  SELECT i.id, i.attachment_id, i.qbo_bill_id, i.qbo_class_id, i.line_no, i.description, i.item_kind, i.material_family,
         i.material_type, i.material_type_raw, i.spec, i.phase, i.quantity, i.unit, i.unit_price, i.line_total,
         i.pricing_basis, i.hours, i.days, i.rate, i.location, i.confidence, i.needs_review, i.review_reason, i.source,
         i.note, i.set_by, i.created_at, i.updated_at,
         b.vendor_name AS bill_vendor_name, b.txn_date AS bill_txn_date
  FROM cost_analyzer_material_items i
  LEFT JOIN quickbooks_bills b ON b.qbo_id = i.qbo_bill_id
`;

// class id -> display name from specs, bill lines and bills (cheap; a few hundred rows).
function classNameMap(db) {
  const map = new Map([[UNASSIGNED_CLASS_ID, 'Unassigned']]);
  const add = (id, name) => {
    if (id && name && !map.has(String(id))) map.set(String(id), String(name));
  };
  for (const row of db.prepare('SELECT qbo_class_id AS id, class_name AS name FROM cost_analyzer_class_specs').all()) add(row.id, row.name);
  for (const row of db.prepare(`
    SELECT DISTINCT class_id AS id, class_name AS name FROM quickbooks_bill_lines WHERE class_id IS NOT NULL AND class_name IS NOT NULL
  `).all()) add(row.id, row.name);
  for (const row of db.prepare(`
    SELECT DISTINCT qbo_class_id AS id, qbo_class_name AS name FROM quickbooks_bills WHERE qbo_class_id IS NOT NULL AND qbo_class_name IS NOT NULL
  `).all()) add(row.id, row.name);
  return map;
}

function itemPayload(row, classNames) {
  const classId = row.qbo_class_id ? String(row.qbo_class_id) : null;
  return {
    id: String(row.id),
    attachment_id: row.attachment_id ? String(row.attachment_id) : null,
    qbo_bill_id: row.qbo_bill_id ? String(row.qbo_bill_id) : null,
    qbo_class_id: classId,
    class_name: classId ? (classNames.get(classId) || classId) : null,
    vendor_name: row.bill_vendor_name || null,
    txn_date: row.bill_txn_date || null,
    line_no: Number(row.line_no) || 0,
    description: row.description,
    item_kind: row.item_kind,
    material_family: row.material_family || null,
    material_type: row.material_type || null,
    material_type_raw: row.material_type_raw || null,
    spec: row.spec || null,
    phase: row.phase || null,
    quantity: numberOrNull(row.quantity),
    unit: row.unit || null,
    unit_price: numberOrNull(row.unit_price),
    line_total: numberOrNull(row.line_total),
    pricing_basis: row.pricing_basis || null,
    hours: numberOrNull(row.hours),
    days: numberOrNull(row.days),
    rate: numberOrNull(row.rate),
    location: row.location || null,
    confidence: numberOrNull(row.confidence),
    needs_review: Boolean(Number(row.needs_review)),
    review_reason: row.review_reason || null,
    source: row.source || 'ai',
    note: row.note || null,
    set_by: row.set_by || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    attachment_url: attachmentUrl(row.qbo_bill_id, row.attachment_id),
  };
}

function loadItem(db, itemId, classNames = null) {
  const row = db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(itemId) || null;
  if (!row) return null;
  return itemPayload(row, classNames || classNameMap(db));
}

// The class a manual item inherits from its bill: the one class its lines carry,
// else the bill header's class, else null (spec 5: no pro-rata guessing).
function billClassFor(db, qboBillId) {
  const classes = db.prepare(`
    SELECT DISTINCT class_id FROM quickbooks_bill_lines WHERE qbo_bill_id = ? AND class_id IS NOT NULL
  `).all(qboBillId).map(row => String(row.class_id));
  if (classes.length === 1) return classes[0];
  if (classes.length > 1) return null;
  const bill = db.prepare('SELECT qbo_class_id FROM quickbooks_bills WHERE qbo_id = ?').get(qboBillId);
  return bill && bill.qbo_class_id ? String(bill.qbo_class_id) : null;
}

// Validates an item body (create: `existing` null, every required field must be
// present; update: any subset) and returns the full set of column values to write.
function parseItemBody(db, body, existing) {
  const creating = !existing;
  const fields = {};

  if (hasOwn(body, 'description') || creating) {
    const description = optionalText(body.description, 'description', 500);
    if (!description) throw httpError(400, 'description is required');
    fields.description = description;
  }
  if (hasOwn(body, 'material_family') || creating) {
    const family = optionalChoice(body.material_family, 'material_family', MATERIAL_FAMILIES);
    if (creating && !family) throw httpError(400, 'material_family is required');
    fields.material_family = family === undefined ? null : family;
  }
  if (hasOwn(body, 'material_type') || creating) {
    const rawType = optionalText(body.material_type, 'material_type', 200);
    if (creating && !rawType) throw httpError(400, 'material_type is required');
    fields.material_type_raw = rawType === undefined ? null : rawType;
  }
  if (hasOwn(body, 'spec')) fields.spec = optionalText(body.spec, 'spec', 200);
  if (hasOwn(body, 'unit') || creating) {
    const unit = optionalChoice(body.unit, 'unit', UNITS);
    if (creating && !unit) throw httpError(400, 'unit is required');
    fields.unit = unit === undefined ? null : unit;
  }
  if (hasOwn(body, 'item_kind')) fields.item_kind = optionalChoice(body.item_kind, 'item_kind', ITEM_KINDS) || 'material';
  else if (creating) fields.item_kind = 'material';
  if (hasOwn(body, 'phase')) fields.phase = optionalChoice(body.phase, 'phase', PHASES) || 'n_a';
  else if (creating) fields.phase = 'n_a';
  if (hasOwn(body, 'quantity')) fields.quantity = optionalNumber(body.quantity, 'quantity', { min: 0 });
  if (hasOwn(body, 'unit_price')) fields.unit_price = optionalNumber(body.unit_price, 'unit_price');
  if (hasOwn(body, 'line_total')) fields.line_total = optionalNumber(body.line_total, 'line_total');
  if (hasOwn(body, 'hours')) fields.hours = optionalNumber(body.hours, 'hours', { min: 0 });
  if (hasOwn(body, 'days')) fields.days = optionalNumber(body.days, 'days', { min: 0 });
  if (hasOwn(body, 'rate')) fields.rate = optionalNumber(body.rate, 'rate', { min: 0 });
  if (hasOwn(body, 'location')) fields.location = optionalText(body.location, 'location', 200);
  if (hasOwn(body, 'note')) fields.note = optionalText(body.note, 'note', 2000);
  if (hasOwn(body, 'review_reason')) fields.review_reason = optionalText(body.review_reason, 'review_reason', 300);
  if (hasOwn(body, 'needs_review')) fields.needs_review = optionalBoolean(body.needs_review, 'needs_review');

  if (hasOwn(body, 'attachment_id')) {
    const attachmentId = optionalText(body.attachment_id, 'attachment_id', 120);
    if (attachmentId) {
      const doc = db.prepare('SELECT attachment_id, qbo_bill_id FROM cost_analyzer_documents WHERE attachment_id = ?').get(attachmentId);
      if (!doc) throw httpError(404, 'Document not found');
      fields.attachment_id = attachmentId;
      if (!hasOwn(body, 'qbo_bill_id') && creating && doc.qbo_bill_id) fields.qbo_bill_id = String(doc.qbo_bill_id);
    } else {
      fields.attachment_id = null;
    }
  }
  if (hasOwn(body, 'qbo_bill_id')) {
    const billId = optionalText(body.qbo_bill_id, 'qbo_bill_id', 120);
    if (billId) {
      const bill = db.prepare('SELECT qbo_id FROM quickbooks_bills WHERE qbo_id = ?').get(billId);
      if (!bill) throw httpError(404, 'Bill not found');
      fields.qbo_bill_id = billId;
    } else {
      fields.qbo_bill_id = null;
    }
  }
  if (hasOwn(body, 'qbo_class_id')) {
    const classId = optionalText(body.qbo_class_id, 'qbo_class_id', 120);
    if (classId && !ID_PATTERN.test(classId)) throw httpError(400, 'qbo_class_id is not a valid class id');
    fields.qbo_class_id = classId || null;
  } else if (creating && fields.qbo_bill_id) {
    fields.qbo_class_id = billClassFor(db, fields.qbo_bill_id);
  }

  const merged = { ...(existing || {}), ...fields };
  const itemKind = merged.item_kind || 'material';
  // Money is never negative except on a credit line (spec 5 clamp rule).
  for (const field of ['unit_price', 'line_total']) {
    const value = numberOrNull(merged[field]);
    if (value !== null && value < 0 && itemKind !== 'credit') throw httpError(400, `${field} cannot be negative unless item_kind is credit`);
  }
  if (creating && numberOrNull(merged.unit_price) === null && numberOrNull(merged.line_total) === null) {
    throw httpError(400, 'unit_price or line_total is required');
  }

  // Canonical type from family + raw type + spec, exactly like the extractor.
  let canonical = null;
  try {
    canonical = canonicalMaterialType(merged.material_family, merged.material_type_raw, merged.spec) || null;
  } catch (_) {
    canonical = null;
  }
  merged.material_type = canonical;

  // Price derivations: an edit to quantity/unit price re-prices the line and an
  // edit to the line total re-derives the unit price; otherwise fill whichever is
  // missing when a quantity exists.
  const quantity = numberOrNull(merged.quantity);
  const sentTotal = hasOwn(fields, 'line_total');
  const sentUnitPrice = hasOwn(fields, 'unit_price');
  const sentQuantity = hasOwn(fields, 'quantity');
  let unitPrice = numberOrNull(merged.unit_price);
  let lineTotal = numberOrNull(merged.line_total);
  if (quantity !== null && quantity > 0) {
    if (sentTotal && !sentUnitPrice && lineTotal !== null) unitPrice = roundCents(lineTotal / quantity);
    else if ((sentUnitPrice || sentQuantity) && !sentTotal && unitPrice !== null) lineTotal = roundCents(unitPrice * quantity);
    else if (lineTotal === null && unitPrice !== null) lineTotal = roundCents(unitPrice * quantity);
    else if (unitPrice === null && lineTotal !== null) unitPrice = roundCents(lineTotal / quantity);
  }
  merged.unit_price = unitPrice === null ? null : roundCents(unitPrice);
  merged.line_total = lineTotal === null ? null : roundCents(lineTotal);
  merged.pricing_basis = quantity !== null && quantity > 0 && merged.unit && !JOB_UNITS.has(merged.unit) ? 'unit' : 'job';

  // needs_review: explicit flag wins; otherwise only a missing amount needs the
  // owner's eye (spec 4.5), and supplying the amount clears an earlier flag.
  let needsReview;
  if (fields.needs_review !== undefined) needsReview = fields.needs_review ? 1 : 0;
  else if (merged.line_total === null) needsReview = 1;
  else if (existing && (sentTotal || sentUnitPrice || sentQuantity)) needsReview = 0;
  else needsReview = existing ? (Number(existing.needs_review) ? 1 : 0) : 0;
  merged.needs_review = needsReview;
  if (needsReview) {
    merged.review_reason = text(fields.review_reason, 300)
      || (merged.line_total === null ? 'no amount on document' : (existing && existing.review_reason) || 'needs review');
  } else {
    merged.review_reason = null;
  }

  return {
    attachment_id: merged.attachment_id || null,
    qbo_bill_id: merged.qbo_bill_id || null,
    qbo_class_id: merged.qbo_class_id || null,
    line_no: Number(merged.line_no) || 0,
    description: merged.description,
    item_kind: itemKind,
    material_family: merged.material_family || null,
    material_type: merged.material_type || null,
    material_type_raw: merged.material_type_raw || null,
    spec: merged.spec || null,
    phase: merged.phase || 'n_a',
    quantity,
    unit: merged.unit || null,
    unit_price: merged.unit_price,
    line_total: merged.line_total,
    pricing_basis: merged.pricing_basis,
    hours: numberOrNull(merged.hours),
    days: numberOrNull(merged.days),
    rate: numberOrNull(merged.rate),
    location: merged.location || null,
    confidence: creating ? 1 : numberOrNull(merged.confidence),
    needs_review: merged.needs_review,
    review_reason: merged.review_reason,
    note: merged.note || null,
  };
}

function updateItem(req, res) {
  const db = getDb();
  const itemId = text(req.params.itemId, 120);
  const existing = itemId ? db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(itemId) : null;
  if (!existing) throw httpError(404, 'Item not found');
  if (req.params.attachmentId !== undefined) {
    const attachmentId = text(req.params.attachmentId, 120);
    if (!attachmentId || String(existing.attachment_id || '') !== attachmentId) throw httpError(404, 'Item not found on this document');
  }
  const body = bodyOf(req);
  if (!Object.keys(body).length) throw httpError(400, 'No item fields were provided');
  const values = parseItemBody(db, body, existing);
  db.prepare(`
    UPDATE cost_analyzer_material_items
    SET attachment_id = ?, qbo_bill_id = ?, qbo_class_id = ?, description = ?, item_kind = ?, material_family = ?,
        material_type = ?, material_type_raw = ?, spec = ?, phase = ?, quantity = ?, unit = ?, unit_price = ?,
        line_total = ?, pricing_basis = ?, hours = ?, days = ?, rate = ?, location = ?, confidence = ?,
        needs_review = ?, review_reason = ?, note = ?, set_by = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    values.attachment_id, values.qbo_bill_id, values.qbo_class_id, values.description, values.item_kind,
    values.material_family, values.material_type, values.material_type_raw, values.spec, values.phase,
    values.quantity, values.unit, values.unit_price, values.line_total, values.pricing_basis, values.hours,
    values.days, values.rate, values.location, values.confidence, values.needs_review, values.review_reason,
    values.note, req.user.id, itemId,
  );
  const item = loadItem(db, itemId);
  auditMutation(req, 'cost_analyzer_material_item_updated', itemId, {
    description: item.description,
    material_family: item.material_family,
    material_type: item.material_type,
    unit_price: item.unit_price,
    line_total: item.line_total,
    source: item.source,
    fields: Object.keys(body),
  });
  res.json(item);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

const DOCUMENT_SELECT = `
  SELECT d.attachment_id, d.qbo_bill_id, d.status, d.content_hash, d.duplicate_of, d.bills_covered_json, d.claimed_by_run_id,
         d.model, d.doc_type, d.vendor_on_document, d.document_date, d.document_total, d.totals_match, d.totals_match_reason,
         d.labor_total, d.material_total, d.labor_hours, d.labor_days, d.labor_rate, d.labor_performed_by,
         d.suggested_category_id, d.suggested_category_confidence, d.summary, d.extracted_json, d.unknowns_json,
         d.confidence, d.error, d.input_tokens, d.output_tokens, d.attempts, d.started_at, d.extracted_at, d.updated_at,
         b.vendor_name AS bill_vendor_name, b.txn_date AS bill_txn_date, b.total_amt AS bill_total
  FROM cost_analyzer_documents d
  LEFT JOIN quickbooks_bills b ON b.qbo_id = d.qbo_bill_id
`;

function documentPayload(row) {
  return {
    attachment_id: String(row.attachment_id),
    qbo_bill_id: row.qbo_bill_id ? String(row.qbo_bill_id) : null,
    vendor_name: row.bill_vendor_name || row.vendor_on_document || null,
    txn_date: row.bill_txn_date || null,
    bill_total: numberOrNull(row.bill_total),
    status: row.status,
    doc_type: row.doc_type || null,
    document_date: row.document_date || null,
    document_total: numberOrNull(row.document_total),
    totals_match: row.totals_match === null || row.totals_match === undefined ? null : Boolean(Number(row.totals_match)),
    totals_match_reason: row.totals_match_reason || null,
    labor_total: numberOrNull(row.labor_total),
    material_total: numberOrNull(row.material_total),
    labor_hours: numberOrNull(row.labor_hours),
    labor_days: numberOrNull(row.labor_days),
    labor_rate: numberOrNull(row.labor_rate),
    labor_performed_by: row.labor_performed_by || null,
    suggested_category_id: row.suggested_category_id || null,
    suggested_category_confidence: numberOrNull(row.suggested_category_confidence),
    summary: row.summary || null,
    confidence: numberOrNull(row.confidence),
    error: row.error || null,
    attempts: Number(row.attempts) || 0,
    duplicate_of: row.duplicate_of || null,
    bills_covered: parseJsonArray(row.bills_covered_json).map(String),
    extracted_at: row.extracted_at || null,
    updated_at: row.updated_at || null,
    attachment_url: attachmentUrl(row.qbo_bill_id, row.attachment_id),
  };
}

// Counts in the shape the overview and the Documents tab share.
function documentCounts(db) {
  const counts = { rows: 0, extracted: 0, pending: 0, running: 0, failed: 0, unreadable: 0, skipped: 0, duplicate: 0, total: 0 };
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM cost_analyzer_documents GROUP BY status').all()) {
    const n = Number(row.n) || 0;
    if (Object.prototype.hasOwnProperty.call(counts, row.status)) counts[row.status] = n;
    counts.rows += n;
  }
  counts.total = counts.rows;
  counts.attachments = Number(db.prepare('SELECT COUNT(*) AS n FROM quickbooks_bill_attachments').get().n) || 0;
  counts.needs_review_items = Number(db.prepare('SELECT COUNT(*) AS n FROM cost_analyzer_material_items WHERE needs_review = 1').get().n) || 0;
  return counts;
}

function latestScanRun(db) {
  return db.prepare('SELECT * FROM cost_analyzer_scan_runs ORDER BY started_at DESC, rowid DESC LIMIT 1').get() || null;
}

// { run, active, counts, configured, model } — never throws, so the Documents tab
// still renders when the scanner cannot load.
function scanStatusPayload(db) {
  let configured = false;
  try {
    configured = Boolean(resolveAnthropicApiKey().apiKey);
  } catch (_) {
    configured = false;
  }
  const counts = documentCounts(db);
  try {
    const status = extractionService().getScanStatus();
    return {
      ...status,
      run: status.run || null,
      active: Boolean(status.active),
      counts: { ...counts, ...(status.counts || {}) },
      configured,
      model: status.model || null,
    };
  } catch (err) {
    return {
      run: latestScanRun(db),
      active: false,
      in_process: false,
      counts,
      configured: false,
      model: null,
      unavailable: (err && err.message) || 'Document scanning is unavailable on this server',
    };
  }
}

// ---------------------------------------------------------------------------
// Optional auto-scan (spec 5, last bullet): when COST_ANALYZER_AUTO_SCAN is
// 'true', every 10 minutes enqueue new attachments and scan the pending ones
// unless a run is active. The timer is unref'd so it never keeps the process (or
// a test) alive; quickbooks.js is not touched.
// ---------------------------------------------------------------------------

let autoScanTimer = null;

function autoScanTick() {
  try {
    const service = extractionService();
    if (service.getScanStatus().active) return;
    service.enqueueNewDocuments(getDb());
    Promise.resolve(service.startScan({ scope: 'pending', userId: null }))
      .then(result => {
        if (result && result.error && result.status !== 409) {
          console.warn(`[COST-ANALYZER] auto-scan could not start: ${result.error}`);
        }
      })
      .catch(err => console.warn('[COST-ANALYZER] auto-scan failed:', err && err.message ? err.message : err));
  } catch (err) {
    console.warn('[COST-ANALYZER] auto-scan tick skipped:', err && err.message ? err.message : err);
  }
}

function startAutoScanTimer() {
  if (String(process.env.COST_ANALYZER_AUTO_SCAN || '').trim().toLowerCase() !== 'true') return null;
  if (autoScanTimer) return autoScanTimer;
  autoScanTimer = setInterval(autoScanTick, AUTO_SCAN_INTERVAL_MS);
  if (typeof autoScanTimer.unref === 'function') autoScanTimer.unref();
  console.log('[COST-ANALYZER] auto-scan enabled: pending documents are scanned every 10 minutes');
  return autoScanTimer;
}

startAutoScanTimer();

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.use(authenticate, authorize(...VIEW_ROLES));

// ── Overview ────────────────────────────────────────────────────────────────
router.get('/overview', handle((req, res) => {
  const filters = readFilters(req);
  const data = stats.overview(getDb(), filters);
  auditView(req, 'cost_analyzer_overview_viewed', { recordCount: data.totals.bills, details: { filters } });
  res.json(data);
}));

// ── Categories (taxonomy first, stats before the parameterised detail) ──────
// Exempt from logDataAccess: the taxonomy carries no financial data.
router.get('/categories', handle((req, res) => {
  res.json(categoriesService.listCategories(getDb()));
}));

router.get('/categories/stats', handle((req, res) => {
  const filters = readFilters(req);
  const data = stats.categoryStats(getDb(), filters);
  auditView(req, 'cost_analyzer_categories_viewed', { recordCount: data.categories.length, details: { filters } });
  res.json(data);
}));

router.get('/categories/:id', handle((req, res) => {
  const filters = readFilters(req);
  const id = text(req.params.id, 120);
  const data = id ? stats.categoryDetail(getDb(), id, filters) : null;
  if (!data) throw httpError(404, 'Cost category not found');
  auditView(req, 'cost_analyzer_category_viewed', { entityId: id, recordCount: data.bill_count, details: { filters } });
  res.json(data);
}));

// ── Vendors ─────────────────────────────────────────────────────────────────
router.get('/vendors', handle((req, res) => {
  const filters = readFilters(req);
  const data = stats.vendorStats(getDb(), filters);
  auditView(req, 'cost_analyzer_vendors_viewed', { recordCount: data.vendors.length, details: { filters } });
  res.json(data);
}));

// Literal before /vendors/:id so "auto-categorize" is never read as a vendor id.
router.post('/vendors/auto-categorize', authorizeUpperManagement, handle((req, res) => {
  const db = getDb();
  const result = categoriesService.autoCategorizeVendors(db, { actorUserId: req.user.id, actorName: req.user.name || null });
  const changes = (result.changes || []).map(change => ({ ...change, vendor_id: change.row_id }));
  auditMutation(req, 'cost_analyzer_vendors_auto_categorized', null, {
    scanned: result.scanned,
    changed: changes.length,
    already_categorized: result.already_categorized,
    unmatched: result.unmatched,
  });
  res.json({ ...result, changes, changed: changes.length });
}));

router.get('/vendors/:id', handle((req, res) => {
  // The id in the path selects the vendor; a vendor_id query filter would fight it.
  const filters = readFilters(req);
  filters.vendor_id = null;
  const id = text(req.params.id, 200);
  const data = id ? stats.vendorDetail(getDb(), id, filters) : null;
  if (!data) throw httpError(404, 'Vendor not found');
  auditView(req, 'cost_analyzer_vendor_viewed', { entityId: data.id, recordCount: data.bills.length, details: { filters } });
  res.json(data);
}));

router.get('/vendors/:id/history', handle((req, res) => {
  const db = getDb();
  const identity = resolveVendorSelector(db, req.params.id);
  if (!identity) throw httpError(404, 'Vendor not found');
  const history = identity.row
    ? db.prepare(`
        SELECT h.id, h.vendor_category_id, h.vendor_name, h.from_category_id, h.to_category_id, h.from_secondary_id,
               h.to_secondary_id, h.source, h.confidence, h.rationale, h.set_by, h.set_by_name, h.set_at
        FROM cost_analyzer_vendor_category_history h
        WHERE h.vendor_category_id = ?
        ORDER BY h.set_at DESC, h.id DESC
      `).all(identity.row.id)
    : [];
  auditView(req, 'cost_analyzer_vendor_history_viewed', { entityId: identity.row ? identity.row.id : null, recordCount: history.length });
  res.json(history);
}));

router.put('/vendors/:id/category', authorizeUpperManagement, handle((req, res) => {
  const db = getDb();
  const body = bodyOf(req);
  const identity = resolveVendorSelector(db, req.params.id);
  if (!identity) throw httpError(404, 'Vendor not found');
  const category = requireActiveCategory(db, body.category_id, 'category_id');
  let secondary = null;
  if (text(body.secondary_category_id, 120)) {
    secondary = requireActiveCategory(db, body.secondary_category_id, 'secondary_category_id');
    if (secondary.id === category.id) throw httpError(400, 'Secondary category must differ from the primary category');
  }
  const previous = identity.row ? identity.row.category_id : null;
  const result = categoriesService.writeVendorCategory(db, {
    qboVendorId: identity.qboVendorId,
    profileId: identity.profileId,
    vendorName: identity.vendorName,
    categoryId: category.id,
    secondaryCategoryId: secondary ? secondary.id : null,
    source: 'manual',
    confidence: 1,
    rationale: `Set by ${req.user.name || 'a manager'} in the Cost Analyzer`,
    actorUserId: req.user.id,
    actorName: req.user.name || null,
    allowOverwriteManual: true,
  });
  auditMutation(req, 'cost_analyzer_vendor_category_set', result.row.id, {
    vendor_name: result.row.vendor_name,
    from_category_id: previous,
    to_category_id: category.id,
    to_category_name: category.name,
    secondary_category_id: secondary ? secondary.id : null,
    changed: result.changed,
    profile_updated: Boolean(result.profile_sync && result.profile_sync.updated),
    profile_list_mismatch: Boolean(result.profile_sync && result.profile_sync.list_mismatch),
  });
  res.json(vendorMutationPayload(db, result));
}));

router.post('/vendors/:id/confirm', authorizeUpperManagement, handle((req, res) => {
  const db = getDb();
  const identity = resolveVendorSelector(db, req.params.id);
  if (!identity) throw httpError(404, 'Vendor not found');
  if (!identity.row) throw httpError(404, 'This vendor has no cost category to confirm yet');
  const result = categoriesService.confirmVendorCategory(db, identity.row.id, { userId: req.user.id, name: req.user.name || null });
  auditMutation(req, 'cost_analyzer_vendor_category_confirmed', result.row.id, {
    vendor_name: result.row.vendor_name,
    category_id: result.row.category_id,
    previous_source: identity.row.source,
  });
  res.json(vendorMutationPayload(db, { row: result.row, changed: true, history_id: result.history_id, profile_sync: result.profile_sync }));
}));

// ── Bills ───────────────────────────────────────────────────────────────────
router.put('/bills/:qboBillId/category', authorizeUpperManagement, handle((req, res) => {
  const db = getDb();
  const body = bodyOf(req);
  const billId = text(req.params.qboBillId, 120);
  const bill = billId
    ? db.prepare(`
        SELECT qbo_id, vendor_id, vendor_name, txn_date, total_amt, private_note, qbo_class_id, payment_approval_status
        FROM quickbooks_bills WHERE qbo_id = ?
      `).get(billId)
    : null;
  if (!bill) throw httpError(404, 'Bill not found');
  if (!hasOwn(body, 'category_id')) throw httpError(400, 'category_id is required (null clears the override)');

  const existing = db.prepare(BILL_CATEGORY_SELECT).get(bill.qbo_id) || null;
  const categoryId = text(body.category_id, 120);
  let category = null;
  if (categoryId) {
    category = requireActiveCategory(db, categoryId, 'category_id');
    db.prepare(`
      INSERT INTO cost_analyzer_bill_categories (qbo_bill_id, category_id, source, confidence, rationale, set_by, set_at)
      VALUES (?, ?, 'manual', 1, ?, ?, datetime('now'))
      ON CONFLICT(qbo_bill_id) DO UPDATE SET
        category_id = excluded.category_id,
        source = 'manual',
        confidence = 1,
        rationale = excluded.rationale,
        set_by = excluded.set_by,
        set_at = datetime('now')
    `).run(bill.qbo_id, category.id, `Set by ${req.user.name || 'a manager'} in the Cost Analyzer`, req.user.id);
  } else {
    // Clearing removes the override row entirely; the bill falls back to the keyword
    // rule / vendor category on the next read.
    db.prepare('DELETE FROM cost_analyzer_bill_categories WHERE qbo_bill_id = ?').run(bill.qbo_id);
  }

  const effective = billEffectiveCategory(db, bill);
  auditMutation(req, 'cost_analyzer_bill_category_set', bill.qbo_id, {
    vendor_name: bill.vendor_name,
    txn_date: bill.txn_date,
    from_category_id: existing ? existing.category_id : null,
    from_source: existing ? existing.source : null,
    to_category_id: category ? category.id : null,
    effective_category_id: effective.id,
    effective_source: effective.source,
  });
  res.json({
    qbo_bill_id: bill.qbo_id,
    category_id: category ? category.id : null,
    source: category ? 'manual' : null,
    effective_category: effective,
  });
}));

// ── Classes (projects) ──────────────────────────────────────────────────────
router.get('/classes', handle((req, res) => {
  const filters = readFilters(req);
  const data = stats.classStats(getDb(), filters);
  auditView(req, 'cost_analyzer_classes_viewed', { recordCount: data.classes.length, details: { filters } });
  res.json(data);
}));

router.get('/classes/:id', handle((req, res) => {
  const filters = readFilters(req);
  const id = text(req.params.id, 120);
  const data = id ? stats.classDetail(getDb(), id, filters) : null;
  if (!data) throw httpError(404, 'Class not found');
  auditView(req, 'cost_analyzer_class_viewed', { entityId: id, recordCount: data.bill_count, details: { filters } });
  res.json(data);
}));

// Upper management may set anything. A project manager may only ADD: allowed when
// no specs row exists yet, or when every field they send is either not recorded
// yet or identical to the stored value; project_id is never theirs to set and a
// value is never theirs to clear (spec 6).
router.put('/classes/:id/specs', handle((req, res) => {
  const db = getDb();
  const classId = text(req.params.id, 120);
  if (!classId || !ID_PATTERN.test(classId)) throw httpError(400, 'Class id is not valid');
  if (classId === UNASSIGNED_CLASS_ID) throw httpError(400, 'Unassigned allocations are not a project');
  const known = lookupClass(db, classId);
  if (!known) throw httpError(404, 'Class not found');

  const fields = parseSpecsBody(db, bodyOf(req));
  const provided = Object.keys(fields);
  if (!provided.length) throw httpError(400, 'No size details were provided');

  const existing = db.prepare('SELECT * FROM cost_analyzer_class_specs WHERE qbo_class_id = ?').get(classId) || null;
  if (req.user.role === 'project_manager') {
    const violation = hasOwn(fields, 'project_id')
      || (existing && provided.some(field => existing[field] !== null && existing[field] !== undefined && !sameSpecValue(existing[field], fields[field])));
    if (violation) {
      // blockProjectManagerMutation answers 403 with the app-wide message for PMs;
      // the fallback only runs if that middleware ever lets the request through.
      return blockProjectManagerMutation(req, res, () => res.status(403).json({ error: PM_SPECS_MESSAGE }));
    }
  }

  const columns = ['qbo_class_id', 'class_name', ...provided, 'updated_by'];
  const values = [classId, known.class_name, ...provided.map(field => fields[field]), req.user.id];
  const updates = [
    ...provided.map(field => `${field} = excluded.${field}`),
    'updated_by = excluded.updated_by',
    "updated_at = datetime('now')",
  ];
  db.prepare(`
    INSERT INTO cost_analyzer_class_specs (${columns.join(', ')}, updated_at)
    VALUES (${columns.map(() => '?').join(', ')}, datetime('now'))
    ON CONFLICT(qbo_class_id) DO UPDATE SET ${updates.join(', ')}
  `).run(...values);

  const specs = specsRow(db, classId);
  // activity_log.project_id must reference a real project: the linked one when known.
  const projectId = (hasOwn(fields, 'project_id') ? fields.project_id : (existing && existing.project_id))
    || (known.project ? known.project.id : null)
    || null;
  const previous = {};
  for (const field of provided) previous[field] = existing ? existing[field] : null;
  auditMutation(req, 'cost_analyzer_class_specs_set', classId, {
    class_name: known.class_name,
    fields,
    previous,
    created: !existing,
  }, projectId);

  let detail = null;
  try {
    detail = stats.classDetail(db, classId, {});
  } catch (err) {
    console.warn('[COST-ANALYZER] class detail after specs update failed:', err && err.message ? err.message : err);
  }
  return res.json({ qbo_class_id: classId, class_name: known.class_name, specs, class: detail });
}));

// ── Materials ───────────────────────────────────────────────────────────────
router.get('/materials', handle((req, res) => {
  const filters = readFilters(req);
  const data = stats.materialStats(getDb(), filters);
  auditView(req, 'cost_analyzer_materials_viewed', { recordCount: data.totals.n_items, details: { filters } });
  res.json(data);
}));

router.get('/materials/items', handle((req, res) => {
  const db = getDb();
  const query = req.query || {};
  const where = [];
  const params = [];

  const family = queryString(query.family);
  if (family) {
    if (!MATERIAL_FAMILIES.includes(family)) throw httpError(400, `family must be one of ${MATERIAL_FAMILIES.join(', ')}`);
    where.push('i.material_family = ?');
    params.push(family);
  }
  const type = queryString(query.type);
  if (type) {
    where.push('(i.material_type = ? OR i.material_type_raw = ?)');
    params.push(type, type);
  }
  const classId = queryString(query.class_id);
  if (classId) {
    if (!ID_PATTERN.test(classId)) throw httpError(400, 'class_id is not a valid class id');
    where.push('i.qbo_class_id = ?');
    params.push(classId);
  }
  const needsReview = queryString(query.needs_review);
  if (needsReview) {
    if (['1', 'true'].includes(needsReview.toLowerCase())) where.push('i.needs_review = 1');
    else if (['0', 'false'].includes(needsReview.toLowerCase())) where.push('i.needs_review = 0');
    else throw httpError(400, 'needs_review must be 1 or 0');
  }
  const vendorSelector = queryString(query.vendor_id);
  let vendorMissing = false;
  if (vendorSelector) {
    if (!ID_PATTERN.test(vendorSelector)) throw httpError(400, 'vendor_id is not a valid vendor id');
    const identity = resolveVendorSelector(db, vendorSelector);
    if (!identity) vendorMissing = true;
    else {
      where.push('(b.vendor_id = ? OR lower(trim(b.vendor_name)) = ?)');
      params.push(identity.qboVendorId || '', categoriesService.vendorKey(identity.vendorName));
    }
  }
  const limit = intParam(query.limit, 'limit', { min: 1, max: 500, fallback: 100 });
  const offset = intParam(query.offset, 'offset', { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });

  if (vendorMissing) {
    auditView(req, 'cost_analyzer_material_items_viewed', { recordCount: 0 });
    return res.json({ items: [], total: 0, limit, offset });
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(db.prepare(`
    SELECT COUNT(*) AS n
    FROM cost_analyzer_material_items i
    LEFT JOIN quickbooks_bills b ON b.qbo_id = i.qbo_bill_id
    ${whereSql}
  `).get(...params).n) || 0;
  const rows = db.prepare(`
    ${ITEM_SELECT}
    ${whereSql}
    ORDER BY COALESCE(b.txn_date, '') DESC, i.created_at DESC, i.line_no ASC, i.id ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const classNames = classNameMap(db);
  auditView(req, 'cost_analyzer_material_items_viewed', { recordCount: rows.length, details: { family, type, class_id: classId, vendor_id: vendorSelector } });
  return res.json({ items: rows.map(row => itemPayload(row, classNames)), total, limit, offset });
}));

router.post('/materials/items', authorizeUpperManagement, handle((req, res) => {
  const db = getDb();
  const values = parseItemBody(db, bodyOf(req), null);
  const id = uuidv4();
  db.prepare(`
    INSERT INTO cost_analyzer_material_items (
      id, attachment_id, qbo_bill_id, qbo_class_id, line_no, description, item_kind, material_family, material_type,
      material_type_raw, spec, phase, quantity, unit, unit_price, line_total, pricing_basis, hours, days, rate, location,
      confidence, needs_review, review_reason, source, note, set_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)
  `).run(
    id, values.attachment_id, values.qbo_bill_id, values.qbo_class_id, values.line_no, values.description, values.item_kind,
    values.material_family, values.material_type, values.material_type_raw, values.spec, values.phase, values.quantity,
    values.unit, values.unit_price, values.line_total, values.pricing_basis, values.hours, values.days, values.rate,
    values.location, values.confidence, values.needs_review, values.review_reason, values.note, req.user.id,
  );
  const item = loadItem(db, id);
  auditMutation(req, 'cost_analyzer_material_item_created', id, {
    description: item.description,
    material_family: item.material_family,
    material_type: item.material_type,
    unit: item.unit,
    quantity: item.quantity,
    unit_price: item.unit_price,
    line_total: item.line_total,
    qbo_bill_id: item.qbo_bill_id,
    qbo_class_id: item.qbo_class_id,
  });
  res.status(201).json(item);
}));

router.put('/materials/items/:itemId', authorizeUpperManagement, handle(updateItem));

router.delete('/materials/items/:itemId', authorizeUpperManagement, handle((req, res) => {
  const db = getDb();
  const itemId = text(req.params.itemId, 120);
  const existing = itemId ? db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(itemId) : null;
  if (!existing) throw httpError(404, 'Item not found');
  // AI items belong to their document: a re-scan refreshes them, deleting one by
  // hand would silently skew the averages.
  if (existing.source !== 'manual') throw httpError(403, 'Only manually added prices can be deleted; re-scan the document to refresh AI lines');
  db.prepare('DELETE FROM cost_analyzer_material_items WHERE id = ?').run(itemId);
  auditMutation(req, 'cost_analyzer_material_item_deleted', itemId, {
    description: existing.description,
    material_family: existing.material_family,
    material_type: existing.material_type,
    line_total: numberOrNull(existing.line_total),
  });
  res.json({ ok: true, id: itemId });
}));

router.put('/materials/targets/:target', authorizeUpperManagement, handle((req, res) => {
  const db = getDb();
  const body = bodyOf(req);
  const targetId = text(req.params.target, 120);
  const target = targetId ? COVERAGE_TARGET_BY_ID[targetId] : null;
  if (!target) throw httpError(404, 'Unknown material target');
  const status = optionalChoice(body.status, 'status', TARGET_STATUSES);
  if (!status) throw httpError(400, `status must be one of ${TARGET_STATUSES.join(', ')}`);
  const answer = optionalText(body.answer, 'answer', 2000);
  const answered = status !== 'open';
  db.prepare(`
    INSERT INTO cost_analyzer_material_targets (target, status, answer, answered_by, answered_at)
    VALUES (?, ?, ?, ?, CASE WHEN ? THEN datetime('now') ELSE NULL END)
    ON CONFLICT(target) DO UPDATE SET
      status = excluded.status,
      answer = excluded.answer,
      answered_by = excluded.answered_by,
      answered_at = excluded.answered_at
  `).run(target.id, status, answer === undefined ? null : answer, answered ? req.user.id : null, answered ? 1 : 0);
  const row = db.prepare(`
    SELECT t.target, t.status, t.answer, t.answered_by, t.answered_at, u.name AS answered_by_name
    FROM cost_analyzer_material_targets t
    LEFT JOIN users u ON u.id = t.answered_by
    WHERE t.target = ?
  `).get(target.id);
  auditMutation(req, 'cost_analyzer_material_target_set', target.id, { label: target.label, status, answer: row.answer });
  res.json({
    target: row.target,
    label: target.label,
    status: row.status,
    answer: row.answer || null,
    answered_by: row.answered_by || null,
    answered_by_name: row.answered_by_name || null,
    answered_at: row.answered_at || null,
  });
}));

// ── Documents (scan routes before the parameterised document routes) ────────
router.get('/documents', handle((req, res) => {
  const db = getDb();
  const query = req.query || {};
  const status = queryString(query.status);
  if (status && !DOCUMENT_STATUSES.includes(status)) throw httpError(400, `status must be one of ${DOCUMENT_STATUSES.join(', ')}`);
  const limit = intParam(query.limit, 'limit', { min: 1, max: 500, fallback: 50 });
  const offset = intParam(query.offset, 'offset', { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
  const whereSql = status ? 'WHERE d.status = ?' : '';
  const params = status ? [status] : [];
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM cost_analyzer_documents d ${whereSql}`).get(...params).n) || 0;
  const rows = db.prepare(`
    ${DOCUMENT_SELECT}
    ${whereSql}
    ORDER BY COALESCE(b.txn_date, '') DESC, d.updated_at DESC, d.attachment_id ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  auditView(req, 'cost_analyzer_documents_viewed', { recordCount: rows.length, details: { status, limit, offset } });
  res.json({
    documents: rows.map(documentPayload),
    counts: documentCounts(db),
    scan: scanStatusPayload(db),
    total,
    limit,
    offset,
  });
}));

// Exempt from logDataAccess: polled every 3 s while a scan runs.
router.get('/documents/scan/status', handle((req, res) => {
  res.json(scanStatusPayload(getDb()));
}));

router.post('/documents/scan', authorizeUpperManagement, handle(async (req, res) => {
  const db = getDb();
  const body = bodyOf(req);
  const scope = text(body.scope, 40) || 'pending';
  if (!SCAN_SCOPES.includes(scope)) throw httpError(400, `scope must be one of ${SCAN_SCOPES.join(', ')}`);

  let attachmentIds = [];
  if (body.attachment_ids !== undefined && body.attachment_ids !== null) {
    if (!Array.isArray(body.attachment_ids)) throw httpError(400, 'attachment_ids must be a list of attachment ids');
    attachmentIds = Array.from(new Set(body.attachment_ids.map(id => text(id, 120)).filter(Boolean)));
    if (attachmentIds.length > MAX_SCAN_ATTACHMENTS) throw httpError(400, `attachment_ids may hold at most ${MAX_SCAN_ATTACHMENTS} ids`);
    if (attachmentIds.some(id => !ID_PATTERN.test(id))) throw httpError(400, 'attachment_ids contains an invalid id');
    if (attachmentIds.length) {
      const known = new Set(db.prepare(`
        SELECT id FROM quickbooks_bill_attachments WHERE id IN (${attachmentIds.map(() => '?').join(', ')})
      `).all(...attachmentIds).map(row => String(row.id)));
      const missing = attachmentIds.filter(id => !known.has(id));
      if (missing.length) throw httpError(400, `Unknown attachment id: ${missing[0]}`);
    }
  }
  if (scope === 'selected' && !attachmentIds.length) throw httpError(400, 'attachment_ids is required for a selected scan');

  const service = extractionService();
  const result = await service.startScan({ scope, attachmentIds, userId: req.user.id });
  if (result && result.error) {
    return res.status(result.status || 500).json({ error: result.error, run_id: result.run_id || null });
  }
  auditMutation(req, 'cost_analyzer_scan_started', result ? result.id : null, {
    scope,
    total: result ? result.total : null,
    selected: attachmentIds.length,
  });
  return res.json({ ...scanStatusPayload(db), run: result || null });
}));

router.post('/documents/scan/cancel', authorizeUpperManagement, handle((req, res) => {
  const db = getDb();
  const result = extractionService().cancelScan();
  if (result && result.error) return res.status(result.status || 500).json({ error: result.error });
  auditMutation(req, 'cost_analyzer_scan_cancelled', result ? result.run_id : null, { run_id: result ? result.run_id : null });
  return res.json({ ...scanStatusPayload(db), cancelling: true, run_id: result ? result.run_id : null });
}));

router.get('/documents/:attachmentId', handle((req, res) => {
  const db = getDb();
  const attachmentId = text(req.params.attachmentId, 120);
  const row = attachmentId ? db.prepare(`${DOCUMENT_SELECT} WHERE d.attachment_id = ?`).get(attachmentId) : null;
  if (!row) throw httpError(404, 'Document not found');
  const classNames = classNameMap(db);
  const items = db.prepare(`${ITEM_SELECT} WHERE i.attachment_id = ? ORDER BY i.line_no ASC, i.created_at ASC`)
    .all(attachmentId)
    .map(item => itemPayload(item, classNames));
  auditView(req, 'cost_analyzer_document_viewed', { entityId: attachmentId, recordCount: items.length });
  res.json({
    ...documentPayload(row),
    model: row.model || null,
    input_tokens: numberOrNull(row.input_tokens),
    output_tokens: numberOrNull(row.output_tokens),
    started_at: row.started_at || null,
    content_hash: row.content_hash || null,
    claimed_by_run_id: row.claimed_by_run_id || null,
    unknowns: parseJsonArray(row.unknowns_json),
    extracted: parseJsonObject(row.extracted_json),
    items,
  });
}));

// Alias of PUT /materials/items/:itemId scoped to one document (spec 6).
router.put('/documents/:attachmentId/items/:itemId', authorizeUpperManagement, handle(updateItem));

// ── CSV export ──────────────────────────────────────────────────────────────
router.get('/export.csv', handle((req, res) => {
  const filters = readFilters(req);
  const report = queryString((req.query || {}).report);
  const result = stats.csvForReport(getDb(), report, filters);
  if (!result) throw httpError(400, `report must be one of ${stats.CSV_REPORTS.join(', ')}`);
  auditView(req, 'cost_analyzer_export', { entityId: report, riskLevel: 'high', details: { report, filters } });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${result.filename}"`);
  res.set('Cache-Control', 'no-store');
  res.send(result.csv);
}));

module.exports = router;
