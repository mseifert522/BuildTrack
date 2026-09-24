// Cost Analyzer vendor category service: the only code that writes
// cost_analyzer_vendor_categories, its history table and the mirrored category on
// contractor_profiles. Every function takes the better-sqlite3 `db` handle as its
// first argument and this module never requires ../db/schema: schema.js requires
// THIS module lazily inside initializeSchema() (taxonomy upsert + vendor seed), so a
// top-level require in the other direction would be circular.
'use strict';

const crypto = require('crypto');
const {
  CATEGORIES,
  CATEGORY_BY_ID,
  UNCATEGORIZED_ID,
  keywordMatchFor,
} = require('../data/costAnalyzerTaxonomy');

/** Allowed values of cost_analyzer_vendor_categories.source (matches the CHECK). */
const VENDOR_SOURCES = new Set(['seed', 'ai', 'keyword', 'manual']);
/** Category kinds whose names are mirrored into the Vendors page picker list. */
const MIRRORED_KINDS = new Set(['trade', 'supplier', 'service']);
/** cost_analyzer_settings key holding the applied vendor seed version. */
const VENDOR_SEED_VERSION_KEY = 'vendor_seed_version';
/**
 * Owner's history: 153 of 211 contractor profiles were bulk-imported from this
 * spreadsheet with the placeholder category below, so that pair is treated as
 * "no category yet" by the profile sync rule (spec 3).
 */
const BULK_IMPORT_SOURCE = 'New Urban Development_Vendor Contact List.xlsx';
const BULK_IMPORT_PLACEHOLDER_CATEGORY = 'General Building Materials';
/** Vendor-name words that mark a store/distributor rather than a crew. */
const SUPPLIER_NAME_PATTERN = /\b(?:supply|supplies|supplier|suppliers|hardware|lumber|building materials|depot|store|stores|wholesale|distributors?|appliances?|wayfair|amazon|menards?|lowe'?s|home depot|sherwin|wimsatt|abc supply|gulfeagle|harbor freight|tractor supply|grainger)\b/i;

const VENDOR_CATEGORY_COLUMNS = `
  id, vendor_key, qbo_vendor_id, profile_id, vendor_name, category_id, secondary_category_id,
  source, confidence, rationale, needs_owner_input, confirmed_by, confirmed_at,
  previous_profile_category, profile_synced_at, set_by, set_at, updated_at
`;

const PROFILE_COLUMNS = `
  id, vendor_name, contractor_category, contractor_secondary_category, contractor_categories_json,
  COALESCE(is_supplier, 0) AS is_supplier, supplier_marked_by, quickbooks_vendor_id, source
`;

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function text(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function clampConfidence(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(1, Math.max(0, parsed));
}

/** SQLite's own clock, so timestamps match the tables' datetime('now') defaults. */
function sqlNow(db) {
  return db.prepare("SELECT datetime('now') AS now").get().now;
}

/**
 * contractor_categories.id for a category name - the same slug the rest of
 * schema.js uses for that table (lower case, runs of non-alphanumerics -> '-').
 * @param {string} name
 * @returns {string}
 */
function slugCategoryName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The vendor identity key: lower(trim(vendor_name)), exactly what SQLite's
 * lower(trim(...)) yields for ASCII names, so JS and SQL lookups agree.
 * @param {string|null|undefined} name
 * @returns {string} '' when the name is blank
 */
function vendorKey(name) {
  return String(name ?? '').trim().toLowerCase();
}

function getCategory(db, categoryId) {
  const id = text(categoryId);
  if (!id) return null;
  return db.prepare('SELECT id, name, kind, sort_order, is_active FROM cost_analyzer_categories WHERE id = ?').get(id) || null;
}

/**
 * One cost_analyzer_vendor_categories row by its id.
 * @param {import('better-sqlite3').Database} db
 * @param {string} rowId
 * @returns {object|null}
 */
function getVendorCategoryRow(db, rowId) {
  const id = text(rowId);
  if (!id) return null;
  return db.prepare(`SELECT ${VENDOR_CATEGORY_COLUMNS} FROM cost_analyzer_vendor_categories WHERE id = ?`).get(id) || null;
}

/**
 * Resolve the vendor category row for a vendor: by qbo_vendor_id, else profile_id,
 * else vendor_key (spec 3 resolution order).
 * @param {import('better-sqlite3').Database} db
 * @param {{ qboVendorId?: string|null, profileId?: string|null, vendorName?: string|null }} ids
 * @returns {object|null}
 */
function findVendorCategoryRow(db, { qboVendorId = null, profileId = null, vendorName = null } = {}) {
  const qbo = text(qboVendorId);
  if (qbo) {
    const row = db.prepare(`SELECT ${VENDOR_CATEGORY_COLUMNS} FROM cost_analyzer_vendor_categories WHERE qbo_vendor_id = ?`).get(qbo);
    if (row) return row;
  }
  const profile = text(profileId);
  if (profile) {
    const row = db.prepare(`SELECT ${VENDOR_CATEGORY_COLUMNS} FROM cost_analyzer_vendor_categories WHERE profile_id = ?`).get(profile);
    if (row) return row;
  }
  const key = vendorKey(vendorName);
  if (key) {
    const row = db.prepare(`SELECT ${VENDOR_CATEGORY_COLUMNS} FROM cost_analyzer_vendor_categories WHERE vendor_key = ?`).get(key);
    if (row) return row;
  }
  return null;
}

function profileExists(db, profileId) {
  const id = text(profileId);
  if (!id) return null;
  const row = db.prepare('SELECT id FROM contractor_profiles WHERE id = ?').get(id);
  return row ? row.id : null;
}

/**
 * The contractor profile a vendor category row mirrors to: profile_id, else the
 * profile linked to the same QuickBooks vendor, else the same lower(trim(name)).
 */
function findProfileForVendor(db, row) {
  if (row.profile_id) {
    const byId = db.prepare(`SELECT ${PROFILE_COLUMNS} FROM contractor_profiles WHERE id = ?`).get(row.profile_id);
    if (byId) return byId;
  }
  if (row.qbo_vendor_id) {
    const byQbo = db.prepare(`SELECT ${PROFILE_COLUMNS} FROM contractor_profiles WHERE quickbooks_vendor_id = ? ORDER BY created_at LIMIT 1`).get(row.qbo_vendor_id);
    if (byQbo) return byQbo;
  }
  if (row.vendor_key) {
    const byKey = db.prepare(`SELECT ${PROFILE_COLUMNS} FROM contractor_profiles WHERE lower(trim(vendor_name)) = ? ORDER BY created_at LIMIT 1`).get(row.vendor_key);
    if (byKey) return byKey;
  }
  return null;
}

function insertContractorCategoryName(db, name) {
  const clean = text(name);
  if (!clean || clean === 'Uncategorized') return;
  db.prepare(`
    INSERT OR IGNORE INTO contractor_categories (id, name, created_by, created_at)
    VALUES (?, ?, NULL, datetime('now'))
  `).run(slugCategoryName(clean), clean);
}

/**
 * Mirror a vendor's Cost Analyzer category onto its contractor profile (spec 3
 * "profile sync rule").
 *
 * The profile's contractor_category / contractor_secondary_category /
 * contractor_categories_json are set to category NAMES (primary = the seed's
 * profile_category_suggestion when given, else the Cost Analyzer name) only when
 * `force` (manual writes), or the profile has no category, or it still carries the
 * bulk-import placeholder ('General Building Materials' from the vendor contact
 * spreadsheet). The pre-sync value is kept in previous_profile_category (first sync
 * only) and profile_synced_at is stamped.
 *
 * is_supplier follows the category kind (supplier -> 1, trade -> 0, service/other
 * unchanged) only while nobody has marked the list by hand (supplier_marked_by IS
 * NULL); otherwise it is left alone and `list_mismatch` reports a disagreement.
 * Uncategorized never syncs.
 * @param {import('better-sqlite3').Database} db
 * @param {object} row - a cost_analyzer_vendor_categories row
 * @param {{ actorUserId?: string|null, force?: boolean, profileCategorySuggestion?: string|null }} [options]
 * @returns {{ updated: boolean, profile_id: string|null, list_mismatch: boolean, previous: string|null, reason?: string }}
 */
function syncProfileCategory(db, row, { actorUserId = null, force = false, profileCategorySuggestion = null } = {}) {
  void actorUserId; // contractor_profiles has no updated_by column; kept for the call signature
  const base = { updated: false, profile_id: (row && row.profile_id) || null, list_mismatch: false, previous: null };
  if (!row || !row.id) return { ...base, reason: 'no_row' };
  if (row.category_id === UNCATEGORIZED_ID) return { ...base, reason: 'uncategorized' };

  const category = getCategory(db, row.category_id);
  if (!category) return { ...base, reason: 'unknown_category' };
  const secondary = row.secondary_category_id && row.secondary_category_id !== UNCATEGORIZED_ID
    ? getCategory(db, row.secondary_category_id)
    : null;

  const profile = findProfileForVendor(db, row);
  if (!profile) return { ...base, profile_id: null, reason: 'no_profile' };

  const kind = category.kind;
  let isSupplier = Number(profile.is_supplier) === 1 ? 1 : 0;
  let listMismatch = false;
  if (profile.supplier_marked_by) {
    // A person sorted this vendor into the Contractors/Suppliers lists: never move it.
    if (kind === 'supplier' && isSupplier !== 1) listMismatch = true;
    if (kind === 'trade' && isSupplier === 1) listMismatch = true;
  } else if (kind === 'supplier') {
    isSupplier = 1;
  } else if (kind === 'trade') {
    isSupplier = 0;
  }

  const currentCategory = text(profile.contractor_category);
  const isBulkPlaceholder = currentCategory === BULK_IMPORT_PLACEHOLDER_CATEGORY && profile.source === BULK_IMPORT_SOURCE;
  const eligible = Boolean(force) || !currentCategory || isBulkPlaceholder;
  if (!eligible) {
    if (!row.profile_id) {
      db.prepare("UPDATE cost_analyzer_vendor_categories SET profile_id = ?, updated_at = datetime('now') WHERE id = ?").run(profile.id, row.id);
    }
    return { ...base, profile_id: profile.id, list_mismatch: listMismatch, previous: currentCategory, reason: 'profile_category_set_by_user' };
  }

  const primaryName = text(profileCategorySuggestion) || category.name;
  const names = [primaryName];
  if (secondary && secondary.name !== primaryName) names.push(secondary.name);

  db.transaction(() => {
    for (const name of names) insertContractorCategoryName(db, name);
    db.prepare(`
      UPDATE contractor_profiles
      SET contractor_category = ?,
          contractor_secondary_category = ?,
          contractor_categories_json = ?,
          is_supplier = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(names[0], names[1] || null, JSON.stringify(names), isSupplier, profile.id);
    db.prepare(`
      UPDATE cost_analyzer_vendor_categories
      SET profile_id = ?,
          previous_profile_category = CASE WHEN profile_synced_at IS NULL THEN ? ELSE previous_profile_category END,
          profile_synced_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(profile.id, currentCategory, row.id);
  })();

  return {
    updated: true,
    profile_id: profile.id,
    list_mismatch: listMismatch,
    previous: currentCategory,
    category: names[0],
    secondary: names[1] || null,
    is_supplier: isSupplier,
  };
}

/**
 * Create or update a vendor's Cost Analyzer category, append a history row and
 * mirror the change onto the contractor profile.
 *
 * Rules: a row whose source is 'manual' is never overwritten by seed/keyword/ai
 * writes unless `allowOverwriteManual` (returns `{ changed: false, skipped:
 * 'manual' }`); a write that changes nothing (same category, secondary and source)
 * only fills in missing qbo_vendor_id / profile_id links and appends no history;
 * every real write appends one cost_analyzer_vendor_category_history row (seed
 * rows: set_by NULL, set_by_name 'Seed <version>'). Manual writes also stamp
 * confirmed_by/confirmed_at and clear needs_owner_input. vendor_key is fixed at
 * insert time and never changes on update.
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   qboVendorId?: string|null, profileId?: string|null, vendorName?: string|null,
 *   categoryId: string, secondaryCategoryId?: string|null,
 *   source: 'seed'|'ai'|'keyword'|'manual', confidence?: number|null, rationale?: string|null,
 *   needsOwnerInput?: boolean, profileCategorySuggestion?: string|null,
 *   actorUserId?: string|null, actorName?: string|null, allowOverwriteManual?: boolean
 * }} options
 * @returns {{ row: object, changed: boolean, history_id: string|null, skipped?: string, profile_sync: object|null }}
 */
function writeVendorCategory(db, options = {}) {
  const {
    qboVendorId = null,
    profileId = null,
    vendorName = null,
    categoryId,
    secondaryCategoryId = null,
    source,
    confidence = null,
    rationale = null,
    needsOwnerInput = false,
    profileCategorySuggestion = null,
    actorUserId = null,
    actorName = null,
    allowOverwriteManual = false,
  } = options;

  if (!VENDOR_SOURCES.has(source)) throw httpError(400, 'Invalid vendor category source');
  const category = getCategory(db, categoryId);
  if (!category) throw httpError(400, 'Unknown cost category');
  if (!category.is_active && source === 'manual') throw httpError(400, 'That cost category is inactive');
  let secondary = null;
  if (text(secondaryCategoryId)) {
    secondary = getCategory(db, secondaryCategoryId);
    if (!secondary) throw httpError(400, 'Unknown secondary cost category');
    if (secondary.id === category.id) throw httpError(400, 'Secondary category must differ from the primary category');
  }

  const existing = findVendorCategoryRow(db, { qboVendorId, profileId, vendorName });
  if (existing && existing.source === 'manual' && source !== 'manual' && !allowOverwriteManual) {
    return { row: existing, changed: false, history_id: null, skipped: 'manual', profile_sync: null };
  }

  const name = text(vendorName) || (existing ? existing.vendor_name : null);
  if (!name) throw httpError(400, 'Vendor name is required');
  const confidenceValue = clampConfidence(confidence);
  const rationaleValue = text(rationale);
  const needsInput = source === 'manual' ? 0 : (needsOwnerInput ? 1 : 0);
  const setByName = text(actorName) || (source === 'seed' ? seedActorName() : null);
  const resolvedProfileId = profileExists(db, profileId);
  const resolvedQboId = text(qboVendorId);

  const write = db.transaction(() => {
    const now = sqlNow(db);
    let rowId;
    let fromCategory = null;
    let fromSecondary = null;

    if (existing) {
      rowId = existing.id;
      fromCategory = existing.category_id;
      fromSecondary = existing.secondary_category_id || null;
      const nextQbo = existing.qbo_vendor_id || resolvedQboId || null;
      const nextProfile = existing.profile_id || resolvedProfileId || null;
      const identical = existing.category_id === category.id
        && fromSecondary === (secondary ? secondary.id : null)
        && existing.source === source;
      if (identical) {
        if (nextQbo !== existing.qbo_vendor_id || nextProfile !== existing.profile_id) {
          db.prepare(`
            UPDATE cost_analyzer_vendor_categories
            SET qbo_vendor_id = ?, profile_id = ?, updated_at = ?
            WHERE id = ?
          `).run(nextQbo, nextProfile, now, rowId);
        }
        return { rowId, changed: false, historyId: null };
      }
      db.prepare(`
        UPDATE cost_analyzer_vendor_categories
        SET qbo_vendor_id = ?,
            profile_id = ?,
            vendor_name = ?,
            category_id = ?,
            secondary_category_id = ?,
            source = ?,
            confidence = ?,
            rationale = ?,
            needs_owner_input = ?,
            confirmed_by = ?,
            confirmed_at = ?,
            set_by = ?,
            set_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        nextQbo,
        nextProfile,
        name,
        category.id,
        secondary ? secondary.id : null,
        source,
        confidenceValue,
        rationaleValue,
        needsInput,
        source === 'manual' ? actorUserId : existing.confirmed_by,
        source === 'manual' ? now : existing.confirmed_at,
        actorUserId,
        now,
        now,
        rowId,
      );
    } else {
      rowId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO cost_analyzer_vendor_categories (
          id, vendor_key, qbo_vendor_id, profile_id, vendor_name, category_id, secondary_category_id,
          source, confidence, rationale, needs_owner_input, confirmed_by, confirmed_at, set_by, set_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        rowId,
        vendorKey(name),
        resolvedQboId,
        resolvedProfileId,
        name,
        category.id,
        secondary ? secondary.id : null,
        source,
        confidenceValue,
        rationaleValue,
        needsInput,
        source === 'manual' ? actorUserId : null,
        source === 'manual' ? now : null,
        actorUserId,
        now,
        now,
      );
    }

    const historyId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO cost_analyzer_vendor_category_history (
        id, vendor_category_id, vendor_name, from_category_id, to_category_id, from_secondary_id, to_secondary_id,
        source, confidence, rationale, set_by, set_by_name, set_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      historyId,
      rowId,
      name,
      fromCategory,
      category.id,
      fromSecondary,
      secondary ? secondary.id : null,
      source,
      confidenceValue,
      rationaleValue,
      actorUserId,
      setByName,
      now,
    );
    return { rowId, changed: true, historyId };
  });

  const result = write();
  let profileSync = null;
  if (result.changed || source === 'manual') {
    try {
      profileSync = syncProfileCategory(db, getVendorCategoryRow(db, result.rowId), {
        actorUserId,
        force: source === 'manual',
        profileCategorySuggestion,
      });
    } catch (err) {
      // The category write already committed; a profile mirror failure must not undo it.
      profileSync = { updated: false, profile_id: null, list_mismatch: false, previous: null, error: err.message };
    }
  }
  return {
    row: getVendorCategoryRow(db, result.rowId),
    changed: result.changed,
    history_id: result.historyId,
    profile_sync: profileSync,
  };
}

function seedActorName() {
  const { SEED_VERSION } = require('../data/costAnalyzerVendorSeed');
  return `Seed ${SEED_VERSION}`;
}

/**
 * Owner/manager confirms a guessed category as-is: keeps the category, sets
 * source='manual', confirmed_by/confirmed_at, needs_owner_input=0 and appends a
 * history row. The profile is re-synced without force (only empty / bulk-import
 * placeholder profile categories are touched).
 * @param {import('better-sqlite3').Database} db
 * @param {string} rowId - cost_analyzer_vendor_categories.id
 * @param {{ userId?: string|null, name?: string|null }} [actor]
 * @returns {{ row: object, history_id: string, profile_sync: object|null }}
 */
function confirmVendorCategory(db, rowId, actor = {}) {
  const row = getVendorCategoryRow(db, rowId);
  if (!row) throw httpError(404, 'Vendor category not found');
  const userId = text(actor.userId);
  const actorName = text(actor.name);

  const confirm = db.transaction(() => {
    const now = sqlNow(db);
    db.prepare(`
      UPDATE cost_analyzer_vendor_categories
      SET source = 'manual',
          confirmed_by = ?,
          confirmed_at = ?,
          needs_owner_input = 0,
          set_by = ?,
          set_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(userId, now, userId, now, now, row.id);
    const historyId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO cost_analyzer_vendor_category_history (
        id, vendor_category_id, vendor_name, from_category_id, to_category_id, from_secondary_id, to_secondary_id,
        source, confidence, rationale, set_by, set_by_name, set_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?)
    `).run(
      historyId,
      row.id,
      row.vendor_name,
      row.category_id,
      row.category_id,
      row.secondary_category_id || null,
      row.secondary_category_id || null,
      row.confidence,
      `Confirmed ${row.source} category as-is`,
      userId,
      actorName,
      now,
    );
    return historyId;
  });

  const historyId = confirm();
  let profileSync = null;
  try {
    profileSync = syncProfileCategory(db, getVendorCategoryRow(db, row.id), { actorUserId: userId, force: false });
  } catch (err) {
    profileSync = { updated: false, profile_id: null, list_mismatch: false, previous: null, error: err.message };
  }
  return { row: getVendorCategoryRow(db, row.id), history_id: historyId, profile_sync: profileSync };
}

/**
 * Apply data/costAnalyzerVendorSeed.js once per SEED_VERSION (spec 3 "Seed
 * application"). For each seed row the QuickBooks vendor id and contractor profile
 * are resolved (given ids, else lower(trim(name)) lookups, else the profile's
 * quickbooks_vendor_id); rows whose vendor already has a category row (any source)
 * are skipped; the rest are inserted with source='seed', get a history row and a
 * profile sync. Afterwards the version marker is stored in cost_analyzer_settings
 * and ONE activity_log row 'cost_analyzer_vendor_seed_applied' is written on behalf
 * of the first active super_admin / operations_manager (activity_log.user_id is NOT
 * NULL, so logging is skipped when no such user exists).
 * Idempotent: does nothing when seed rows exist and the stored version matches.
 * @param {import('better-sqlite3').Database} db
 * @returns {{ applied: boolean, seed_version: string, inserted: number, profiles_updated: number, skipped: number, errors: string[] }}
 */
function applyCostAnalyzerVendorSeed(db) {
  const { SEED_VERSION, VENDOR_CATEGORY_SEED } = require('../data/costAnalyzerVendorSeed');
  db.exec('CREATE TABLE IF NOT EXISTS cost_analyzer_settings (key TEXT PRIMARY KEY, value TEXT)');

  const stored = db.prepare('SELECT value FROM cost_analyzer_settings WHERE key = ?').get(VENDOR_SEED_VERSION_KEY);
  const hasSeedRows = Boolean(db.prepare("SELECT 1 AS present FROM cost_analyzer_vendor_categories WHERE source = 'seed' LIMIT 1").get());
  if (hasSeedRows && stored && stored.value === SEED_VERSION) {
    return { applied: false, seed_version: SEED_VERSION, inserted: 0, profiles_updated: 0, skipped: 0, errors: [] };
  }

  const findVendorByKey = db.prepare(`
    SELECT qbo_id FROM quickbooks_vendors
    WHERE lower(trim(display_name)) = ?
    ORDER BY active DESC, qbo_id
    LIMIT 1
  `);
  const findProfileById = db.prepare('SELECT id, quickbooks_vendor_id FROM contractor_profiles WHERE id = ?');
  const findProfileByKey = db.prepare(`
    SELECT id, quickbooks_vendor_id FROM contractor_profiles
    WHERE lower(trim(vendor_name)) = ?
    ORDER BY created_at
    LIMIT 1
  `);

  let inserted = 0;
  let profilesUpdated = 0;
  let skipped = 0;
  const errors = [];

  for (const seed of VENDOR_CATEGORY_SEED) {
    try {
      const key = vendorKey(seed.vendor_name);
      let profile = seed.profile_id ? findProfileById.get(seed.profile_id) || null : null;
      if (!profile && key) profile = findProfileByKey.get(key) || null;

      let qboVendorId = text(seed.qbo_vendor_id);
      if (!qboVendorId && key) {
        const vendor = findVendorByKey.get(key);
        if (vendor) qboVendorId = vendor.qbo_id;
      }
      if (!qboVendorId && profile && profile.quickbooks_vendor_id) qboVendorId = profile.quickbooks_vendor_id;
      const profileId = profile ? profile.id : null;

      if (findVendorCategoryRow(db, { qboVendorId, profileId, vendorName: seed.vendor_name })) {
        skipped += 1;
        continue;
      }

      const result = writeVendorCategory(db, {
        qboVendorId,
        profileId,
        vendorName: seed.vendor_name,
        categoryId: seed.category_id,
        secondaryCategoryId: seed.secondary_category_id || null,
        source: 'seed',
        confidence: seed.confidence,
        rationale: seed.rationale,
        needsOwnerInput: Boolean(seed.needs_owner_input),
        profileCategorySuggestion: seed.profile_category_suggestion || null,
        actorUserId: null,
        actorName: `Seed ${SEED_VERSION}`,
      });
      if (result.changed) inserted += 1;
      else skipped += 1;
      if (result.profile_sync && result.profile_sync.updated) profilesUpdated += 1;
    } catch (err) {
      skipped += 1;
      errors.push(`${seed.vendor_name}: ${err.message}`);
    }
  }

  db.prepare(`
    INSERT INTO cost_analyzer_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(VENDOR_SEED_VERSION_KEY, SEED_VERSION);

  // Attribute the startup seed to the first active owner/ops manager, the same idea
  // as paymentQueueAutomationUserId: activity_log.user_id must be a real user.
  const actor = db.prepare(`
    SELECT id FROM users
    WHERE role IN ('super_admin','operations_manager') AND is_active = 1
    ORDER BY role DESC, created_at
    LIMIT 1
  `).get();
  if (actor) {
    try {
      db.prepare(`
        INSERT INTO activity_log (id, project_id, user_id, action, entity_type, entity_id, details)
        VALUES (?, NULL, ?, 'cost_analyzer_vendor_seed_applied', 'cost_analyzer', NULL, ?)
      `).run(
        crypto.randomUUID(),
        actor.id,
        JSON.stringify({ seed_version: SEED_VERSION, inserted, profiles_updated: profilesUpdated, skipped }),
      );
    } catch (err) {
      console.error('[COST-ANALYZER] could not log vendor seed application:', err.message);
    }
  }

  if (errors.length) {
    console.warn(`[COST-ANALYZER] vendor seed ${SEED_VERSION}: ${errors.length} row(s) failed:`, errors.slice(0, 10).join(' | '));
  }
  console.log(`[COST-ANALYZER] vendor seed ${SEED_VERSION}: inserted ${inserted}, profiles updated ${profilesUpdated}, skipped ${skipped}`);
  return { applied: true, seed_version: SEED_VERSION, inserted, profiles_updated: profilesUpdated, skipped, errors };
}

/**
 * Keyword classifier for vendors that have no Cost Analyzer category row yet
 * (QuickBooks vendors not suppressed + contractor profiles). The vendor name is
 * tried first (store/distributor words switch to the supplier-side rules), then the
 * vendor's QuickBooks bill memos and line descriptions. Matches are written with
 * source='keyword' and a modest confidence so the Vendors tab lists them under
 * "Needs review"; vendors with no keyword hit are left without a row. Existing
 * rows (manual or otherwise) are never touched.
 * @param {import('better-sqlite3').Database} db
 * @param {{ actorUserId?: string|null, actorName?: string|null }} [options]
 * @returns {{ scanned: number, already_categorized: number, unmatched: number, changes: Array<{ row_id: string, vendor_name: string, qbo_vendor_id: string|null, profile_id: string|null, category_id: string, category_name: string, confidence: number, rationale: string }> }}
 */
function autoCategorizeVendors(db, { actorUserId = null, actorName = null } = {}) {
  const vendors = db.prepare(`
    SELECT qbo_id, display_name, company_name, website
    FROM quickbooks_vendors
    WHERE qbo_id NOT IN (SELECT qbo_id FROM quickbooks_vendor_suppressions)
    ORDER BY display_name
  `).all();
  const profiles = db.prepare(`
    SELECT id, vendor_name, quickbooks_vendor_id
    FROM contractor_profiles
    ORDER BY created_at
  `).all();
  const notesForVendor = db.prepare(`
    SELECT private_note AS note FROM quickbooks_bills
    WHERE vendor_id = ? AND payment_approval_status != 'deleted_from_buildtrack' AND private_note IS NOT NULL
  `);
  const linesForVendor = db.prepare(`
    SELECT l.description AS note
    FROM quickbooks_bill_lines l
    JOIN quickbooks_bills b ON b.qbo_id = l.qbo_bill_id
    WHERE b.vendor_id = ? AND b.payment_approval_status != 'deleted_from_buildtrack' AND l.description IS NOT NULL
  `);

  // One candidate per vendor identity: QBO vendors first, profiles attach to them by
  // quickbooks_vendor_id or by name, and profile-only vendors get their own entry.
  const candidates = [];
  const byQbo = new Map();
  const byKey = new Map();
  for (const vendor of vendors) {
    const name = text(vendor.display_name) || text(vendor.company_name);
    if (!name) continue;
    const candidate = {
      qboVendorId: vendor.qbo_id,
      profileId: null,
      vendorName: name,
      nameText: [vendor.display_name, vendor.company_name, vendor.website].filter(Boolean).join(' '),
    };
    candidates.push(candidate);
    byQbo.set(String(vendor.qbo_id), candidate);
    const key = vendorKey(name);
    if (!byKey.has(key)) byKey.set(key, candidate);
  }
  for (const profile of profiles) {
    const name = text(profile.vendor_name);
    if (!name) continue;
    const linked = profile.quickbooks_vendor_id ? byQbo.get(String(profile.quickbooks_vendor_id)) : null;
    const key = vendorKey(name);
    const match = linked || byKey.get(key) || null;
    if (match) {
      if (!match.profileId) match.profileId = profile.id;
      continue;
    }
    const candidate = {
      qboVendorId: text(profile.quickbooks_vendor_id),
      profileId: profile.id,
      vendorName: name,
      nameText: name,
    };
    candidates.push(candidate);
    byKey.set(key, candidate);
  }

  const changes = [];
  let alreadyCategorized = 0;
  let unmatched = 0;
  for (const candidate of candidates) {
    if (findVendorCategoryRow(db, candidate)) {
      alreadyCategorized += 1;
      continue;
    }

    let categoryId = null;
    let confidence = null;
    let rationale = null;
    const laborMatch = keywordMatchFor(candidate.nameText, UNCATEGORIZED_ID);
    const supplierWord = SUPPLIER_NAME_PATTERN.exec(candidate.nameText);
    if (laborMatch && !supplierWord) {
      categoryId = laborMatch.category_id;
      confidence = 0.65;
      rationale = `Keyword "${laborMatch.matched}" in the vendor name.`;
    } else if (supplierWord) {
      // Store/distributor: only supplier categories are allowed (spec 4.1).
      const supplierMatch = keywordMatchFor(candidate.nameText, 'building-materials');
      if (supplierMatch) {
        categoryId = supplierMatch.category_id;
        rationale = `Keyword "${supplierMatch.matched}" in a supplier's name.`;
      } else if (laborMatch && CATEGORY_BY_ID[laborMatch.category_id] && CATEGORY_BY_ID[laborMatch.category_id].kind === 'service') {
        categoryId = laborMatch.category_id;
        rationale = `Keyword "${laborMatch.matched}" in the vendor name.`;
      } else {
        categoryId = 'building-materials';
        rationale = `Vendor name reads as a supplier ("${supplierWord[0]}").`;
      }
      confidence = 0.6;
    } else if (candidate.qboVendorId) {
      const notes = [
        ...notesForVendor.all(candidate.qboVendorId).map(row => row.note),
        ...linesForVendor.all(candidate.qboVendorId).map(row => row.note),
      ].filter(Boolean).join('\n');
      const noteMatch = notes ? keywordMatchFor(notes, UNCATEGORIZED_ID) : null;
      if (noteMatch) {
        categoryId = noteMatch.category_id;
        confidence = 0.5;
        rationale = `Keyword "${noteMatch.matched}" in this vendor's QuickBooks bill memos / line descriptions.`;
      }
    }

    if (!categoryId || categoryId === UNCATEGORIZED_ID) {
      unmatched += 1;
      continue;
    }

    try {
      const result = writeVendorCategory(db, {
        qboVendorId: candidate.qboVendorId,
        profileId: candidate.profileId,
        vendorName: candidate.vendorName,
        categoryId,
        secondaryCategoryId: null,
        source: 'keyword',
        confidence,
        rationale,
        needsOwnerInput: confidence < 0.6,
        actorUserId,
        actorName,
      });
      if (!result.changed) {
        alreadyCategorized += 1;
        continue;
      }
      changes.push({
        row_id: result.row.id,
        vendor_name: result.row.vendor_name,
        qbo_vendor_id: result.row.qbo_vendor_id,
        profile_id: result.row.profile_id,
        category_id: result.row.category_id,
        category_name: CATEGORY_BY_ID[result.row.category_id] ? CATEGORY_BY_ID[result.row.category_id].name : result.row.category_id,
        confidence,
        rationale,
      });
    } catch (err) {
      unmatched += 1;
      console.warn(`[COST-ANALYZER] auto-categorize skipped "${candidate.vendorName}": ${err.message}`);
    }
  }

  return { scanned: candidates.length, already_categorized: alreadyCategorized, unmatched, changes };
}

/**
 * The cost categories as stored (taxonomy order), including inactive ones.
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{ id: string, name: string, kind: string, sort_order: number, is_active: number }>}
 */
function listCategories(db) {
  return db.prepare(`
    SELECT id, name, kind, sort_order, is_active
    FROM cost_analyzer_categories
    ORDER BY sort_order, name
  `).all();
}

/**
 * Upsert the taxonomy into cost_analyzer_categories (name/kind/sort_order follow the
 * code; a user's is_active choice is kept) and INSERT OR IGNORE the names of kind
 * trade/supplier/service into contractor_categories (id = slug of the name) so the
 * Vendors page pickers can offer them. 'Uncategorized' is never inserted there.
 * @param {import('better-sqlite3').Database} db
 * @returns {{ upserted: number, contractor_categories_added: number }}
 */
function ensureTaxonomy(db) {
  const upsert = db.prepare(`
    INSERT INTO cost_analyzer_categories (id, name, kind, sort_order, is_active)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      kind = excluded.kind,
      sort_order = excluded.sort_order,
      updated_at = datetime('now')
  `);
  const insertName = db.prepare(`
    INSERT OR IGNORE INTO contractor_categories (id, name, created_by, created_at)
    VALUES (?, ?, NULL, datetime('now'))
  `);
  let upserted = 0;
  let added = 0;
  db.transaction(() => {
    for (const category of CATEGORIES) {
      upsert.run(category.id, category.name, category.kind, category.sort_order);
      upserted += 1;
      if (category.id === UNCATEGORIZED_ID || !MIRRORED_KINDS.has(category.kind)) continue;
      added += insertName.run(slugCategoryName(category.name), category.name).changes;
    }
  })();
  return { upserted, contractor_categories_added: added };
}

module.exports = {
  vendorKey,
  slugCategoryName,
  getVendorCategoryRow,
  findVendorCategoryRow,
  writeVendorCategory,
  syncProfileCategory,
  confirmVendorCategory,
  applyCostAnalyzerVendorSeed,
  autoCategorizeVendors,
  listCategories,
  ensureTaxonomy,
  VENDOR_SEED_VERSION_KEY,
  BULK_IMPORT_SOURCE,
  BULK_IMPORT_PLACEHOLDER_CATEGORY,
};
