// Tests for the Cost Analyzer router (spec section 8, everything except the
// extraction-specific cases, which live in costAnalyzerExtraction.test.js).
// Node's built-in assert + better-sqlite3 against a temp DB, real Express router
// mounted at /api/cost-analyzer, JWT tokens via jsonwebtoken, fetch (same
// convention as quoteAnalytics.test.js).
//
// The seeded ledger is small and hand-computed so every implied-hourly figure
// lands on a round number (owner's definition: 40 h x 52 wk = 2,080 h per
// complete calendar year). "Today" is frozen at 2026-09-23 through the `today`
// query parameter the stats module accepts.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildtrack-cost-analyzer-'));
process.env.DB_PATH = path.join(tempDir, 'buildtrack-test.db');
process.env.JWT_SECRET = 'cost-analyzer-test-secret';
process.env.UPLOADS_PATH = path.join(tempDir, 'uploads');
// A scan must never reach the real API from a test: no key -> 503.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.COST_ANALYZER_AUTO_SCAN;

const { initializeSchema, getDb } = require('../src/db/schema');
const costAnalyzerRoutes = require('../src/routes/costAnalyzer');
const categoriesService = require('../src/services/costAnalyzerCategories');
const { SEED_VERSION } = require('../src/data/costAnalyzerVendorSeed');
const { canonicalMaterialType } = require('../src/data/costAnalyzerMaterialTypes');

const TODAY = '2026-09-23';
const ADMIN_ID = 'ca-admin';
const OPS_ID = 'ca-ops';
const PM_ID = 'ca-pm';
const ASSISTANT_ID = 'ca-assistant';
const CONTRACTOR_ID = 'ca-contractor';

const CLASS_NAMES = { 'cls-a': '100 Alpha St', 'cls-b': '200 Beta Ave', 'cls-c': '300 Gamma Rd', 'cls-d': '400 Delta Ct' };
const ACCOUNT_REHAB = '1240 Projects:Capital Improvements';
const ACCOUNT_COGS = '5730 Cost of Goods Sold (projects):ST - Rehab Costs';
const ACCOUNT_MAINT = '6150 Repairs - Maintenance - HOA fees';

const CREW = { id: 'tv-carp', name: 'Test Carpentry Crew' };
const SUPPLY = { id: 'tv-supply', name: 'Test Building Supply' };
const UNCAT = { id: 'tv-uncat', name: 'Test Unknown Vendor' };
const GC = { id: 'tv-gc', name: 'Test General Builders' };
const ROOF1 = { id: 'tv-roof1', name: 'Test One Bill Roofer' };
const CSV_VENDOR = { id: 'tv-csv', name: '=1+1' };
const AUTO = { id: 'tv-auto', name: 'Test Roofing Pros' };
const FATMIR = { id: '51', name: 'Fatmir Pashaj' };     // seeded as carpentry by the vendor seed
const SHERWIN = { id: '32', name: 'Sherwin Williams' }; // seeded as paint-supplies (supplier)

function near(actual, expected, message, epsilon = 0.011) {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= epsilon, `${message}: expected ~${expected}, got ${actual}`);
}

function q(params = {}) {
  const search = new URLSearchParams({ today: TODAY, ...params });
  return `?${search.toString()}`;
}

function tokenFor(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET);
}

async function call(baseUrl, pathName, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/cost-analyzer', costAnalyzerRoutes);
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}/api/cost-analyzer` }));
  });
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

function seedUsersAndProjects(db) {
  const insertUser = db.prepare('INSERT INTO users (id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)');
  insertUser.run(ADMIN_ID, 'Owner Admin', 'owner@example.test', 'hash', 'super_admin');
  insertUser.run(OPS_ID, 'Ops Manager', 'ops@example.test', 'hash', 'operations_manager');
  insertUser.run(PM_ID, 'Project Manager', 'pm@example.test', 'hash', 'project_manager');
  insertUser.run(ASSISTANT_ID, 'Admin Assistant', 'assistant@example.test', 'hash', 'admin_assistant');
  insertUser.run(CONTRACTOR_ID, 'Field Contractor', 'contractor@example.test', 'hash', 'contractor');

  const insertProject = db.prepare(`
    INSERT INTO projects (id, address, job_name, status, lifecycle_status, budget, created_by, quickbooks_class_id, quickbooks_class_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertProject.run('proj-a', '100 Alpha St, Detroit, MI', '100 Alpha', 'rehab_completed', 'completed', 250000, ADMIN_ID, 'cls-a', CLASS_NAMES['cls-a']);
  insertProject.run('proj-b', '200 Beta Ave, Detroit, MI', '200 Beta', 'active_rehab', 'under_construction', 60000, ADMIN_ID, 'cls-b', CLASS_NAMES['cls-b']);
}

function seedVendorsAndProfiles(db) {
  const insertVendor = db.prepare(`
    INSERT INTO quickbooks_vendors (qbo_id, realm_id, display_name, company_name, active) VALUES (?, 'test-realm', ?, ?, 1)
  `);
  for (const vendor of [CREW, SUPPLY, UNCAT, GC, ROOF1, CSV_VENDOR, AUTO, FATMIR, SHERWIN]) {
    insertVendor.run(vendor.id, vendor.name, vendor.name);
  }
  const insertProfile = db.prepare(`
    INSERT INTO contractor_profiles (id, vendor_name, contractor_category, is_supplier, source, quickbooks_vendor_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  // Bulk-imported placeholder category: the seed's profile sync must replace it.
  insertProfile.run('prof-fatmir', FATMIR.name, 'General Building Materials', 0, 'New Urban Development_Vendor Contact List.xlsx', null);
  // Empty category: the seed must fill it and flip is_supplier for a supplier.
  insertProfile.run('prof-sw', SHERWIN.name, null, 0, 'test', null);
  // Profile-only vendor (no QuickBooks bills): only listed with include=all.
  insertProfile.run('prof-only', 'Test Profile Only Vendor', 'Carpenter', 0, 'test', null);
}

function seedBills(db) {
  const insertBill = db.prepare(`
    INSERT INTO quickbooks_bills (qbo_id, realm_id, vendor_id, vendor_name, txn_date, total_amt, balance, private_note, qbo_class_id, qbo_class_name, payment_approval_status)
    VALUES (?, 'test-realm', ?, ?, ?, ?, 0, ?, ?, ?, 'not_approved')
  `);
  const insertLine = db.prepare(`
    INSERT INTO quickbooks_bill_lines (id, qbo_bill_id, realm_id, qbo_line_id, line_num, description, amount, category_name, class_id, class_name)
    VALUES (?, ?, 'test-realm', ?, ?, ?, ?, ?, ?, ?)
  `);
  // lines: undefined = one line for the whole total on classId; [] = no lines;
  // otherwise explicit [{ amount, classId, account?, description? }].
  const addBill = ({ id, vendor, date, total, note = null, classId = null, lines, account = ACCOUNT_REHAB }) => {
    insertBill.run(id, vendor.id, vendor.name, date, total, note, classId, classId ? CLASS_NAMES[classId] : null);
    const rows = lines === undefined ? [{ amount: total, classId, account, description: note }] : lines;
    rows.forEach((line, index) => {
      const lineClass = line.classId || null;
      insertLine.run(
        `${id}:${index + 1}`, id, String(index + 1), index + 1, line.description || note || null, line.amount,
        line.account || account, lineClass, lineClass ? CLASS_NAMES[lineClass] : null,
      );
    });
  };

  // Carpentry crew: 2024 complete (8 bills, $104,000 -> $50/h), 2025 complete
  // (4 bills, $83,200 -> $40/h), 2026 year-to-date (4 bills, $76,000 over 38 weeks
  // -> $50/h annualized), plus one $0 bill with no class.
  addBill({ id: 'b-c-2401', vendor: CREW, date: '2024-01-15', total: 13000, classId: 'cls-a' });
  addBill({ id: 'b-c-2402', vendor: CREW, date: '2024-02-15', total: 13000, classId: 'cls-a' });
  // Multi-class bill: the sync leaves qbo_class_id NULL and the lines carry the classes.
  addBill({ id: 'b-c-2403', vendor: CREW, date: '2024-03-15', total: 13000, classId: null, lines: [
    { amount: 8000, classId: 'cls-a', description: 'Framing 100 Alpha' },
    { amount: 5000, classId: 'cls-b', description: 'Framing 200 Beta' },
  ] });
  // Lines add up to $12,900 on a $13,000 bill: $100 residual on the bill's class.
  addBill({ id: 'b-c-2405', vendor: CREW, date: '2024-05-15', total: 13000, classId: 'cls-a', lines: [{ amount: 12900, classId: 'cls-a' }] });
  addBill({ id: 'b-c-2407', vendor: CREW, date: '2024-07-15', total: 13000, classId: 'cls-a' });
  addBill({ id: 'b-c-2409', vendor: CREW, date: '2024-09-15', total: 13000, classId: 'cls-a' });
  addBill({ id: 'b-c-2411', vendor: CREW, date: '2024-11-15', total: 13000, classId: 'cls-a' });
  addBill({ id: 'b-c-2412', vendor: CREW, date: '2024-12-10', total: 13000, classId: 'cls-a' });
  addBill({ id: 'b-c-2502', vendor: CREW, date: '2025-02-01', total: 20800, classId: 'cls-a' });
  addBill({ id: 'b-c-2504', vendor: CREW, date: '2025-04-01', total: 20800, classId: 'cls-a' });
  addBill({ id: 'b-c-2506', vendor: CREW, date: '2025-06-01', total: 20800, classId: 'cls-a' });
  addBill({ id: 'b-c-2508', vendor: CREW, date: '2025-08-01', total: 20800, classId: 'cls-a' });
  addBill({ id: 'b-c-2601', vendor: CREW, date: '2026-01-10', total: 19000, classId: 'cls-a' });
  addBill({ id: 'b-c-2603', vendor: CREW, date: '2026-03-10', total: 19000, classId: 'cls-a' });
  addBill({ id: 'b-c-2605', vendor: CREW, date: '2026-05-10', total: 19000, classId: 'cls-a' });
  addBill({ id: 'b-c-2606', vendor: CREW, date: '2026-06-10', total: 19000, classId: 'cls-a' });
  addBill({ id: 'b-c-zero', vendor: CREW, date: '2026-03-01', total: 0, classId: null, lines: [] });

  // Supplier: five 2024 bills ($20,000); "roof shingles" must NOT move a supplier's bill to a trade.
  addBill({ id: 'b-s-1', vendor: SUPPLY, date: '2024-01-20', total: 4000, classId: 'cls-b', note: 'roof shingles and nails', account: ACCOUNT_COGS });
  addBill({ id: 'b-s-2', vendor: SUPPLY, date: '2024-03-20', total: 4000, classId: 'cls-b', account: ACCOUNT_COGS });
  addBill({ id: 'b-s-3', vendor: SUPPLY, date: '2024-06-20', total: 4000, classId: 'cls-b', account: ACCOUNT_COGS });
  addBill({ id: 'b-s-4', vendor: SUPPLY, date: '2024-09-20', total: 4000, classId: 'cls-b', account: ACCOUNT_COGS });
  addBill({ id: 'b-s-5', vendor: SUPPLY, date: '2024-12-20', total: 4000, classId: 'cls-b', account: ACCOUNT_COGS });

  // Uncategorized vendor: keyword rule files the drywall bill, the other stays uncategorized.
  addBill({ id: 'b-u-1', vendor: UNCAT, date: '2025-05-05', total: 3000, classId: 'cls-b', note: 'Drywall hang and tape', account: ACCOUNT_MAINT });
  addBill({ id: 'b-u-2', vendor: UNCAT, date: '2025-06-05', total: 1000, classId: 'cls-b', note: 'misc work', account: ACCOUNT_MAINT });

  // General contractor: an HVAC keyword re-files the bill (open vendor category).
  addBill({ id: 'b-g-1', vendor: GC, date: '2025-07-07', total: 9000, classId: 'cls-b', note: 'HVAC install 2 furnaces', lines: [
    { amount: 9000, classId: 'cls-b', description: 'Furnace install' },
  ] });

  // One-bill roofer: too few bills for an hourly figure.
  addBill({ id: 'b-r-1', vendor: ROOF1, date: '2024-06-01', total: 5000, classId: 'cls-b' });

  // Vendor named like a spreadsheet formula (CSV injection guard). Its class has no
  // carpentry spend, so the project-manager specs test below cannot disturb the
  // carpentry $/sq ft figures.
  addBill({ id: 'b-x-1', vendor: CSV_VENDOR, date: '2025-09-09', total: 500, classId: 'cls-d' });

  // Owner's rule: a carpenter's "Management Fee" bill stays carpentry (no management-fee keyword).
  addBill({ id: 'b-f-1', vendor: FATMIR, date: '2025-03-01', total: 2000, classId: 'cls-c', note: 'Management Fee' });

  // Vendor without a category row; auto-categorize should read "Roofing" off the name.
  addBill({ id: 'b-a-1', vendor: AUTO, date: '2025-10-10', total: 1500, classId: 'cls-c' });
}

function seedDocumentsAndItems(db) {
  const insertAttachment = db.prepare(`
    INSERT INTO quickbooks_bill_attachments (id, qbo_bill_id, qbo_attachable_id, source, filename, original_name, mime_type, size, uploaded_by)
    VALUES (?, ?, ?, 'quickbooks', ?, ?, ?, ?, ?)
  `);
  const insertDocument = db.prepare(`
    INSERT INTO cost_analyzer_documents (
      attachment_id, qbo_bill_id, status, content_hash, bills_covered_json, model, doc_type, document_total, totals_match,
      material_total, summary, extracted_json, unknowns_json, confidence, extracted_at
    ) VALUES (?, ?, 'extracted', ?, ?, 'test-model', 'invoice', ?, 1, ?, ?, '{}', '["no hours listed for trim work"]', 0.9, ?)
  `);
  const docs = [
    ['att-1', 'b-c-2401'], ['att-2', 'b-c-2402'], ['att-3', 'b-c-2407'], ['att-4', 'b-c-2409'], ['att-5', 'b-c-2411'],
  ];
  docs.forEach(([attachmentId, billId], index) => {
    insertAttachment.run(attachmentId, billId, `attachable-${index + 1}`, `${attachmentId}.pdf`, `${attachmentId}.pdf`, 'application/pdf', 1000, ADMIN_ID);
    insertDocument.run(attachmentId, billId, `hash-${index + 1}`, JSON.stringify([billId]), 13000, 1000, `Invoice ${index + 1}`, `2026-09-0${index + 1} 10:00:00`);
  });
  // A text/plain Intuit download stub stored as an attachment: must surface as an unknown, never be read.
  insertAttachment.run('att-stub', 'b-c-2412', 'attachable-stub', 'stub.pdf', 'stub.pdf', 'text/plain', 200, ADMIN_ID);

  const insertItem = db.prepare(`
    INSERT INTO cost_analyzer_material_items (
      id, attachment_id, qbo_bill_id, qbo_class_id, line_no, description, item_kind, material_family, material_type,
      material_type_raw, spec, phase, quantity, unit, unit_price, line_total, pricing_basis, hours, needs_review, review_reason, source
    ) VALUES (?, 'att-1', 'b-c-2401', 'cls-a', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai')
  `);
  const doorType = canonicalMaterialType('doors', 'interior prehung door', null);
  assert.equal(doorType, 'interior_door', 'canonical type for "interior prehung door"');
  assert.equal(canonicalMaterialType('countertops', 'Formica top', null), 'laminate_countertop', 'Formica -> laminate countertop');
  assert.equal(canonicalMaterialType('flooring', 'luxury vinyl plank', '12 mil'), 'lvp_flooring', 'luxury vinyl plank -> LVP');
  assert.equal(canonicalMaterialType('countertops', 'quartz countertop', null), 'quartz_countertop');

  // line_no, description, kind, family, type, raw, spec, phase, qty, unit, unit_price, line_total, basis, hours, needs_review, reason
  insertItem.run('item-door-1', 1, 'Interior prehung door 30in', 'material', 'doors', doorType, 'interior prehung door', null, 'install', 2, 'each', 150, 300, 'unit', null, 0, null);
  insertItem.run('item-door-2', 2, 'Interior prehung door 32in', 'material', 'doors', doorType, 'interior prehung door', null, 'install', 1, 'each', 160, 160, 'unit', null, 0, null);
  insertItem.run('item-door-3', 3, 'Interior prehung door 28in', 'material', 'doors', doorType, 'interior prehung door', null, 'install', 2, 'each', 155, 310, 'unit', null, 0, null);
  insertItem.run('item-roof', 4, 'Tear off and re-shingle roof', 'labor_and_material', 'roofing', 'shingle_roof', 'shingle roof', null, 'n_a', null, 'lot', null, 8000, 'job', null, 0, null);
  insertItem.run('item-drywall', 5, 'Drywall on rooms', 'labor', 'drywall', 'drywall_finish', 'hang tape finish', null, 'n_a', null, null, null, null, 'job', null, 1, 'no amount on document');
  insertItem.run('item-quartz', 6, 'Quartz countertop', 'material', 'countertops', 'quartz_countertop', 'quartz countertop', 'quartz', 'install', 40, 'sqft', 60, 2400, 'unit', null, 0, null);
  insertItem.run('item-labor', 7, 'Carpentry labor', 'labor', null, null, null, null, 'n_a', null, null, null, 1200, 'job', 20, 0, null);
}

function seedVendorCategories(db) {
  const write = (vendor, categoryId) => categoriesService.writeVendorCategory(db, {
    qboVendorId: vendor.id,
    vendorName: vendor.name,
    categoryId,
    source: 'ai',
    confidence: 0.9,
    rationale: 'test seed',
  });
  write(CREW, 'carpentry');
  write(SUPPLY, 'building-materials');
  write(GC, 'general-contractor');
  write(ROOF1, 'roofing');
  write(CSV_VENDOR, 'painting');
}

// ── Test blocks ──────────────────────────────────────────────────────────────

function testSeedApplication(db) {
  // initializeSchema() already applied the seed to an empty vendor table. Rewind it
  // now that QuickBooks vendors, contractor profiles and users exist, and apply again.
  db.prepare('DELETE FROM cost_analyzer_vendor_categories').run();
  db.prepare('DELETE FROM cost_analyzer_vendor_category_history').run();
  db.prepare("DELETE FROM cost_analyzer_settings WHERE key = 'vendor_seed_version'").run();
  db.prepare("DELETE FROM activity_log WHERE action = 'cost_analyzer_vendor_seed_applied'").run();

  const first = categoriesService.applyCostAnalyzerVendorSeed(db);
  assert.equal(first.applied, true, 'seed applies when rows and marker are missing');
  assert.equal(first.seed_version, SEED_VERSION);
  assert.ok(first.inserted >= 200, `seed inserted ${first.inserted} rows`);
  assert.equal(first.errors.length, 0, `seed rows apply without errors: ${first.errors.join(' | ')}`);

  const fatmirRow = db.prepare('SELECT * FROM cost_analyzer_vendor_categories WHERE qbo_vendor_id = ?').get(FATMIR.id);
  assert.ok(fatmirRow, 'Fatmir Pashaj has a seed row');
  assert.equal(fatmirRow.source, 'seed');
  assert.equal(fatmirRow.category_id, 'carpentry');
  assert.equal(fatmirRow.profile_id, 'prof-fatmir', 'seed row linked to the contractor profile by name');
  assert.equal(fatmirRow.previous_profile_category, 'General Building Materials', 'pre-seed profile category is kept');
  assert.ok(fatmirRow.profile_synced_at, 'profile_synced_at stamped');
  const fatmirHistory = db.prepare('SELECT * FROM cost_analyzer_vendor_category_history WHERE vendor_category_id = ?').all(fatmirRow.id);
  assert.equal(fatmirHistory.length, 1, 'one history row per seed write');
  assert.equal(fatmirHistory[0].set_by, null);
  assert.equal(fatmirHistory[0].set_by_name, `Seed ${SEED_VERSION}`);
  assert.equal(fatmirHistory[0].to_category_id, 'carpentry');

  const fatmirProfile = db.prepare('SELECT * FROM contractor_profiles WHERE id = ?').get('prof-fatmir');
  assert.equal(fatmirProfile.contractor_category, 'Carpenter', 'bulk-import placeholder replaced by the seed suggestion');
  assert.equal(fatmirProfile.is_supplier, 0, 'a trade is not a supplier');
  const sherwinProfile = db.prepare('SELECT * FROM contractor_profiles WHERE id = ?').get('prof-sw');
  assert.equal(sherwinProfile.contractor_category, 'Paint', 'empty profile category filled by the seed');
  assert.equal(sherwinProfile.is_supplier, 1, 'supplier kind flips is_supplier when nobody marked the list');
  assert.ok(db.prepare("SELECT 1 AS present FROM contractor_categories WHERE name = 'Carpenter'").get(), 'category name mirrored into contractor_categories');

  const seedLog = db.prepare("SELECT * FROM activity_log WHERE action = 'cost_analyzer_vendor_seed_applied'").all();
  assert.equal(seedLog.length, 1, 'one activity_log row for the seed');
  assert.equal(seedLog[0].user_id, ADMIN_ID, 'attributed to the first active super_admin');
  assert.equal(seedLog[0].entity_type, 'cost_analyzer');

  const historyBefore = db.prepare('SELECT COUNT(*) AS n FROM cost_analyzer_vendor_category_history').get().n;
  const second = categoriesService.applyCostAnalyzerVendorSeed(db);
  assert.equal(second.applied, false, 'seed is skipped on rerun with the same version');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cost_analyzer_vendor_category_history').get().n, historyBefore, 'rerun writes no history');
}

async function testRoleGating(baseUrl, tokens) {
  let res = await call(baseUrl, `/overview${q()}`, { token: tokens.contractor });
  assert.equal(res.status, 403, 'contractor cannot read the Cost Analyzer');
  res = await call(baseUrl, `/overview${q()}`, { token: tokens.assistant });
  assert.equal(res.status, 403, 'admin_assistant is out of scope');
  res = await call(baseUrl, `/overview${q()}`, { token: tokens.pm });
  assert.equal(res.status, 200, 'project manager can read');
  res = await call(baseUrl, `/vendors/qbo:${CREW.id}/category`, { method: 'PUT', token: tokens.pm, body: { category_id: 'drywall' } });
  assert.equal(res.status, 403, 'PM cannot set a vendor category');
  res = await call(baseUrl, '/materials/items', { method: 'POST', token: tokens.pm, body: { description: 'x' } });
  assert.equal(res.status, 403, 'PM cannot add prices');
  res = await call(baseUrl, '/materials/targets/hvac', { method: 'PUT', token: tokens.pm, body: { status: 'answered' } });
  assert.equal(res.status, 403, 'PM cannot answer targets');
  res = await call(baseUrl, '/documents/scan', { method: 'POST', token: tokens.pm, body: { scope: 'pending' } });
  assert.equal(res.status, 403, 'PM cannot start a scan');
  res = await call(baseUrl, '/bills/b-g-1/category', { method: 'PUT', token: tokens.pm, body: { category_id: 'hvac' } });
  assert.equal(res.status, 403, 'PM cannot override a bill category');
  res = await call(baseUrl, `/overview${q()}`, { token: 'not-a-token' });
  assert.equal(res.status, 401, 'bad token rejected');
}

async function testFilterValidation(baseUrl, token) {
  let res = await call(baseUrl, '/overview?from=2025-13-01', { token });
  assert.equal(res.status, 400, 'bad from date');
  assert.ok(res.json && res.json.error, 'error shape { error }');
  res = await call(baseUrl, '/overview?from=2025-06-01&to=2025-01-01', { token });
  assert.equal(res.status, 400, 'from after to');
  res = await call(baseUrl, '/overview?spend_type=bogus', { token });
  assert.equal(res.status, 400, 'unknown spend type');
  res = await call(baseUrl, '/overview?category_id=bogus', { token });
  assert.equal(res.status, 400, 'unknown category filter');
  res = await call(baseUrl, '/vendors?include=bogus', { token });
  assert.equal(res.status, 400, 'bad include');
}

async function testOverview(baseUrl, token) {
  const res = await call(baseUrl, `/overview${q()}`, { token });
  assert.equal(res.status, 200);
  const data = res.json;
  near(data.totals.spend, 305200, 'overview spend');
  assert.equal(data.totals.bills, 28, 'zero-amount bill excluded from the bill count');
  assert.deepEqual(data.years_available, [2024, 2025, 2026]);
  assert.ok(typeof data.rate_caption === 'string' && data.rate_caption.includes('40 h/wk'), 'rate caption present');
  assert.equal(data.documents.extracted, 5);
  assert.ok(Array.isArray(data.top_vendors) && data.top_vendors[0].vendor_name === CREW.name, 'top vendor is the crew');
  assert.equal(data.top_vendors[0].headline_hourly, 45, 'headline implied $/hr in the overview');
  assert.ok(data.categories.some(category => category.id === 'carpentry'), 'category totals present');
}

async function testVendorsAndHourly(baseUrl, token) {
  let res = await call(baseUrl, `/vendors${q()}`, { token });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.vendors), 'vendors list');
  assert.equal(typeof res.json.needs_review_count, 'number');
  const crew = res.json.vendors.find(vendor => vendor.vendor_name === CREW.name);
  assert.ok(crew, 'crew listed');
  assert.equal(crew.category.id, 'carpentry');
  assert.equal(crew.category.source, 'ai');
  assert.equal(crew.bill_count, 16, 'sixteen non-zero bills');
  assert.equal(crew.zero_amount_bills, 1, 'the $0 bill is flagged, not counted');
  near(crew.total, 263200, 'crew total');
  assert.ok(!res.json.vendors.some(vendor => vendor.vendor_name === 'Test Profile Only Vendor'), 'profile-only vendor hidden by default');

  // Allocation from lines: multi-class bill lands on two classes, __unassigned__ is $0.
  const classA = crew.classes.find(entry => entry.class_id === 'cls-a');
  const classB = crew.classes.find(entry => entry.class_id === 'cls-b');
  const unassigned = crew.classes.find(entry => entry.class_id === '__unassigned__');
  near(classA.total, 258200, 'class A share of the crew');
  near(classB.total, 5000, 'class B gets the multi-class line');
  assert.equal(classA.class_name, CLASS_NAMES['cls-a']);
  assert.ok(unassigned && unassigned.total === 0, '__unassigned__ carries $0');
  assert.ok(classA.implied_hours_share > 0, 'implied hours share only when the vendor qualifies');

  // Vendor-year figures (owner's definition: 2,080 h per complete year).
  const y2024 = crew.years.find(year => year.year === 2024);
  const y2025 = crew.years.find(year => year.year === 2025);
  const y2026 = crew.years.find(year => year.year === 2026);
  assert.equal(y2024.status, 'complete');
  assert.equal(y2024.bills, 8);
  assert.equal(y2024.weeks_span, 48);
  assert.equal(y2024.qualifies, true);
  assert.equal(y2024.hourly_full_year, 50, '104,000 / 2,080');
  near(y2024.hourly_active_weeks, 54.17, '104,000 / (40 x 48)');
  assert.equal(y2024.hourly_annualized, null, 'complete years are never annualized');
  assert.equal(y2025.status, 'complete');
  assert.equal(y2025.weeks_span, 26);
  assert.equal(y2025.hourly_full_year, 40, '83,200 / 2,080');
  assert.equal(y2025.hourly_active_weeks, 80, '83,200 / (40 x 26)');
  assert.equal(y2026.status, 'ytd');
  assert.equal(y2026.weeks_elapsed, 38, 'weeks from Jan 1 to 2026-09-23');
  assert.equal(y2026.hourly_full_year, null, 'a year-to-date year has no full-year rate');
  assert.equal(y2026.hourly_annualized, 50, '76,000 / (40 x 38)');
  assert.equal(crew.hourly.full_year_avg, 45, 'hours-weighted: (104,000 + 83,200) / (2 x 2,080)');
  assert.deepEqual(crew.hourly.full_year_years, [2024, 2025]);
  assert.equal(crew.headline_hourly, 45);
  assert.equal(crew.hourly.latest_annualized.year, 2026);
  assert.equal(crew.hourly.latest_annualized.hourly_annualized, 50);
  assert.equal(crew.hourly.window, null, 'no window rate without a date filter');
  assert.equal(crew.hourly.doc_hourly, 60, 'Invoice $/hr from a line with hours: 1,200 / 20');
  assert.equal(crew.hourly.n_docs_with_hours, 1);

  // Labor-only: 2024 has documents behind 5 of 8 bills (62.5%), so the year rate exists;
  // over both complete years coverage is 65,000 / 187,200 (35%), so the headline is withheld.
  near(y2024.labor_only_coverage, 0.625, '2024 document coverage');
  near(y2024.material_total_from_documents, 5000, 'material total read off documents');
  near(y2024.labor_only_hourly, 47.6, '(104,000 - 5,000) / 2,080');
  assert.equal(y2025.labor_only_hourly, null, 'no documents in 2025');
  assert.equal(crew.hourly.labor_only_full_year_avg, null, 'labor-only headline needs 50% coverage');
  near(crew.hourly.labor_only_coverage, 0.3472, 'labor-only coverage across complete years');
  assert.ok(String(crew.hourly.labor_only_reason).includes('documents cover'), 'coverage reason spelled out');
  near(crew.has_documents_share, 0.247, 'share of spend with a document');

  // Qualification reasons: a one-bill vendor and a supplier.
  const roofer = res.json.vendors.find(vendor => vendor.vendor_name === ROOF1.name);
  assert.equal(roofer.years[0].qualifies, false);
  assert.equal(roofer.years[0].reason, 'too_few_bills');
  assert.equal(roofer.years[0].hourly_full_year, null);
  const supplier = res.json.vendors.find(vendor => vendor.vendor_name === SUPPLY.name);
  assert.equal(supplier.category.kind, 'supplier');
  assert.equal(supplier.years[0].status, 'complete');
  assert.equal(supplier.years[0].reason, 'not_a_trade');
  assert.equal(supplier.hourly.full_year_avg, null);
  assert.equal(supplier.hourly.full_year_avg_reason, 'not_a_trade');
  const uncategorized = res.json.vendors.find(vendor => vendor.vendor_name === UNCAT.name);
  assert.equal(uncategorized.category.id, 'uncategorized');
  assert.equal(uncategorized.category.source, 'none');
  assert.equal(uncategorized.needs_review, true, 'an uncategorized vendor needs review');

  // Window rate under a date filter: 2025 only, 53 weeks in the window.
  res = await call(baseUrl, `/vendors/qbo:${CREW.id}${q({ from: '2025-01-01', to: '2025-12-31' })}`, { token });
  assert.equal(res.status, 200);
  const windowed = res.json;
  near(windowed.total, 83200, 'filtered total');
  assert.equal(windowed.bill_count, 4);
  assert.equal(windowed.years.length, 3, 'year rows ignore the filter');
  assert.equal(windowed.hourly.full_year_avg, 45, 'filters never touch the implied-hourly denominators');
  assert.equal(windowed.hourly.window.weeks_in_window, 53);
  near(windowed.hourly.window.total, 83200, 'window total');
  near(windowed.hourly.window.hourly, 39.25, '83,200 / (40 x 53)');
  assert.equal(windowed.bills.length, 4, 'detail bills follow the filter');

  // Vendor detail: allocation flags, effective categories, documents, history.
  res = await call(baseUrl, `/vendors/qbo:${CREW.id}${q()}`, { token });
  assert.equal(res.status, 200);
  const detail = res.json;
  assert.equal(detail.bills.length, 17, 'all bills incl. the $0 one');
  const multi = detail.bills.find(bill => bill.qbo_id === 'b-c-2403');
  assert.equal(multi.multi_class, true);
  assert.deepEqual(multi.class_ids.slice().sort(), ['cls-a', 'cls-b']);
  const mismatch = detail.bills.find(bill => bill.qbo_id === 'b-c-2405');
  assert.equal(mismatch.lines_mismatch, true, 'residual flagged');
  assert.ok(detail.warnings.some(warning => warning.kind === 'lines_mismatch' && warning.qbo_bill_id === 'b-c-2405'), 'mismatch warning');
  const zero = detail.bills.find(bill => bill.qbo_id === 'b-c-zero');
  assert.equal(zero.zero_amount, true);
  const documented = detail.bills.find(bill => bill.qbo_id === 'b-c-2401');
  assert.equal(documented.has_document, true);
  assert.equal(documented.attachments.length, 1);
  assert.ok(documented.attachments[0].url.includes('/api/quickbooks/bills/b-c-2401/attachments/att-1'), 'attachment link');
  assert.equal(documented.effective_category.id, 'carpentry');
  assert.equal(documented.effective_category.source, 'vendor');
  assert.equal(detail.documents.length, 5);
  assert.equal(detail.items.length, 7);
  assert.ok(Array.isArray(detail.history) && detail.history.length === 1, 'history from the ai write');

  // Effective category precedence: keyword rules.
  res = await call(baseUrl, `/vendors/qbo:${UNCAT.id}${q()}`, { token });
  assert.equal(res.status, 200);
  const drywallBill = res.json.bills.find(bill => bill.qbo_id === 'b-u-1');
  assert.equal(drywallBill.effective_category.id, 'drywall', 'keyword files an uncategorized vendor bill');
  assert.equal(drywallBill.effective_category.source, 'keyword');
  const miscBill = res.json.bills.find(bill => bill.qbo_id === 'b-u-2');
  assert.equal(miscBill.effective_category.id, 'uncategorized');
  assert.equal(miscBill.effective_category.source, 'uncategorized');
  assert.equal(res.json.bills_elsewhere.count, 1, 'the drywall bill is filed elsewhere');

  res = await call(baseUrl, `/vendors/qbo:${GC.id}${q()}`, { token });
  const hvacBill = res.json.bills.find(bill => bill.qbo_id === 'b-g-1');
  assert.equal(hvacBill.effective_category.id, 'hvac', 'a general contractor bill follows the trade keyword');
  assert.equal(hvacBill.effective_category.source, 'keyword');

  res = await call(baseUrl, `/vendors/qbo:${SUPPLY.id}${q()}`, { token });
  const shingleBill = res.json.bills.find(bill => bill.qbo_id === 'b-s-1');
  assert.equal(shingleBill.effective_category.id, 'building-materials', 'keyword never moves a supplier bill to a trade');
  assert.equal(shingleBill.effective_category.source, 'vendor');

  res = await call(baseUrl, `/vendors/qbo:${FATMIR.id}${q()}`, { token });
  assert.equal(res.status, 200);
  assert.equal(res.json.category.id, 'carpentry');
  assert.equal(res.json.category.source, 'seed');
  const feeBill = res.json.bills.find(bill => bill.qbo_id === 'b-f-1');
  assert.equal(feeBill.effective_category.id, 'carpentry', 'a "Management Fee" bill stays carpentry (no management-fee rule)');
  assert.equal(feeBill.effective_category.source, 'vendor');

  res = await call(baseUrl, `/vendors/qbo:nope${q()}`, { token });
  assert.equal(res.status, 404, 'unknown vendor');

  // Spend type filter selects rows for totals.
  res = await call(baseUrl, `/vendors${q({ spend_type: 'maintenance' })}`, { token });
  assert.equal(res.status, 200);
  assert.equal(res.json.vendors.length, 1, 'only the maintenance-account vendor');
  assert.equal(res.json.vendors[0].vendor_name, UNCAT.name);
  near(res.json.vendors[0].total, 4000, 'maintenance total');

  // include=all adds profile-only vendors with zero totals.
  res = await call(baseUrl, `/vendors${q({ include: 'all' })}`, { token });
  assert.equal(res.status, 200);
  const profileOnly = res.json.vendors.find(vendor => vendor.vendor_name === 'Test Profile Only Vendor');
  assert.ok(profileOnly, 'profile-only vendor listed with include=all');
  assert.equal(profileOnly.total, 0);
  assert.equal(profileOnly.id, 'profile:prof-only');
}

async function testBillOverrides(baseUrl, token, db) {
  // AI suggestion beats the keyword rule.
  db.prepare(`
    INSERT INTO cost_analyzer_bill_categories (qbo_bill_id, category_id, source, confidence, rationale)
    VALUES ('b-g-1', 'electrical', 'ai', 0.9, 'test suggestion')
  `).run();
  let res = await call(baseUrl, `/vendors/qbo:${GC.id}${q()}`, { token });
  let bill = res.json.bills.find(entry => entry.qbo_id === 'b-g-1');
  assert.equal(bill.effective_category.id, 'electrical', 'ai suggestion > keyword');
  assert.equal(bill.effective_category.source, 'ai');
  near(bill.effective_category.confidence, 0.9, 'ai confidence surfaced');

  // Manual override beats the AI suggestion.
  res = await call(baseUrl, '/bills/b-g-1/category', { method: 'PUT', token, body: { category_id: 'plumbing' } });
  assert.equal(res.status, 200, 'manual bill override');
  assert.equal(res.json.qbo_bill_id, 'b-g-1');
  assert.equal(res.json.category_id, 'plumbing');
  assert.equal(res.json.source, 'manual');
  assert.equal(res.json.effective_category.id, 'plumbing');
  assert.equal(res.json.effective_category.source, 'manual');
  assert.equal(res.json.effective_category.name, 'Plumbing');
  const stored = db.prepare('SELECT * FROM cost_analyzer_bill_categories WHERE qbo_bill_id = ?').get('b-g-1');
  assert.equal(stored.source, 'manual');
  assert.equal(stored.set_by, OPS_ID, 'operations manager wrote the override');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'cost_analyzer_bill_category_set'").get().n, 1, 'bill override audited');
  res = await call(baseUrl, `/categories/plumbing${q()}`, { token });
  assert.equal(res.status, 200);
  assert.ok(res.json.bills.some(entry => entry.qbo_id === 'b-g-1'), 'category detail reflects the override');

  // Clearing removes the override; the keyword rule applies again.
  res = await call(baseUrl, '/bills/b-g-1/category', { method: 'PUT', token, body: { category_id: null } });
  assert.equal(res.status, 200, 'clear override');
  assert.equal(res.json.category_id, null);
  assert.equal(res.json.effective_category.id, 'hvac');
  assert.equal(res.json.effective_category.source, 'keyword');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cost_analyzer_bill_categories WHERE qbo_bill_id = ?').get('b-g-1').n, 0);

  res = await call(baseUrl, '/bills/b-g-1/category', { method: 'PUT', token, body: {} });
  assert.equal(res.status, 400, 'category_id key required');
  res = await call(baseUrl, '/bills/b-g-1/category', { method: 'PUT', token, body: { category_id: 'bogus' } });
  assert.equal(res.status, 400, 'unknown category');
  res = await call(baseUrl, '/bills/nope/category', { method: 'PUT', token, body: { category_id: 'hvac' } });
  assert.equal(res.status, 404, 'unknown bill');
}

async function testVendorCategoryWrites(baseUrl, token, db) {
  // Manual category for a vendor that has no row yet (selector qbo:<id>).
  let res = await call(baseUrl, `/vendors/qbo:${UNCAT.id}/category`, { method: 'PUT', token, body: { category_id: 'drywall' } });
  assert.equal(res.status, 200, 'set vendor category');
  assert.equal(res.json.row.source, 'manual');
  assert.equal(res.json.row.category_id, 'drywall');
  assert.equal(res.json.row.vendor_key, 'test unknown vendor');
  assert.ok(res.json.history_id, 'history row written');
  assert.ok(res.json.vendor && res.json.vendor.category.id === 'drywall', 'refreshed vendor entry');
  assert.equal(res.json.vendor.category.source, 'manual');
  assert.equal(res.json.vendor.needs_review, false, 'manual rows never need review');
  const uncatRowId = res.json.row.id;
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'cost_analyzer_vendor_category_set'").get().n, 1, 'vendor category change audited');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cost_analyzer_vendor_category_history WHERE vendor_category_id = ?').get(uncatRowId).n, 1);

  // With the vendor now a drywall trade, the drywall bill is the vendor's own work.
  res = await call(baseUrl, `/vendors/${uncatRowId}${q()}`, { token });
  assert.equal(res.status, 200, 'vendor row id selector');
  const drywallBill = res.json.bills.find(bill => bill.qbo_id === 'b-u-1');
  assert.equal(drywallBill.effective_category.id, 'drywall');
  assert.equal(drywallBill.effective_category.source, 'vendor', 'a keyword naming the vendor\'s own trade does not override');
  assert.equal(res.json.bills_elsewhere.count, 0);

  // Same category again: no change, no extra history.
  res = await call(baseUrl, `/vendors/${uncatRowId}/category`, { method: 'PUT', token, body: { category_id: 'drywall' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.changed, false, 'identical write is a no-op');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cost_analyzer_vendor_category_history WHERE vendor_category_id = ?').get(uncatRowId).n, 1);

  // Validation.
  res = await call(baseUrl, `/vendors/${uncatRowId}/category`, { method: 'PUT', token, body: { category_id: 'drywall', secondary_category_id: 'drywall' } });
  assert.equal(res.status, 400, 'secondary must differ');
  res = await call(baseUrl, `/vendors/${uncatRowId}/category`, { method: 'PUT', token, body: { category_id: 'bogus' } });
  assert.equal(res.status, 400, 'unknown category');
  res = await call(baseUrl, `/vendors/${uncatRowId}/category`, { method: 'PUT', token, body: {} });
  assert.equal(res.status, 400, 'category required');
  db.prepare("UPDATE cost_analyzer_categories SET is_active = 0 WHERE id = 'fencing'").run();
  res = await call(baseUrl, `/vendors/${uncatRowId}/category`, { method: 'PUT', token, body: { category_id: 'fencing' } });
  assert.equal(res.status, 400, 'inactive category rejected');
  db.prepare("UPDATE cost_analyzer_categories SET is_active = 1 WHERE id = 'fencing'").run();
  res = await call(baseUrl, '/vendors/qbo:nope/category', { method: 'PUT', token, body: { category_id: 'drywall' } });
  assert.equal(res.status, 404, 'unknown vendor');

  // Secondary category + profile sync with force for a vendor with a profile.
  res = await call(baseUrl, `/vendors/qbo:${FATMIR.id}/category`, { method: 'PUT', token, body: { category_id: 'carpentry', secondary_category_id: 'handyman' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.row.secondary_category_id, 'handyman');
  assert.equal(res.json.row.source, 'manual');
  assert.equal(res.json.profile_sync.updated, true, 'manual writes force the profile sync');
  const fatmirProfile = db.prepare('SELECT contractor_category, contractor_secondary_category FROM contractor_profiles WHERE id = ?').get('prof-fatmir');
  assert.equal(fatmirProfile.contractor_category, 'Carpenter');
  assert.equal(fatmirProfile.contractor_secondary_category, 'Handymen');

  // Confirm keeps the guessed category and marks it manual.
  res = await call(baseUrl, `/vendors${q()}`, { token });
  const crew = res.json.vendors.find(vendor => vendor.vendor_name === CREW.name);
  const crewRowId = crew.category.row_id;
  assert.ok(crewRowId, 'crew row id');
  assert.equal(crew.id, crewRowId, 'vendor id is the row id when a row exists');
  res = await call(baseUrl, `/vendors/${crewRowId}/confirm`, { method: 'POST', token, body: {} });
  assert.equal(res.status, 200, 'confirm');
  assert.equal(res.json.row.source, 'manual');
  assert.equal(res.json.row.category_id, 'carpentry');
  assert.equal(res.json.row.confirmed_by, ADMIN_ID);
  assert.ok(res.json.row.confirmed_at, 'confirmed_at set');
  assert.equal(res.json.row.needs_owner_input, 0);
  res = await call(baseUrl, `/vendors/${crewRowId}/history`, { token });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json) && res.json.length === 2, 'ai write + confirmation in history');
  assert.ok(res.json.some(row => row.source === 'manual') && res.json.some(row => row.source === 'ai'), 'both writes in history');
  res = await call(baseUrl, `/vendors/qbo:${AUTO.id}/confirm`, { method: 'POST', token, body: {} });
  assert.equal(res.status, 404, 'nothing to confirm without a row');
  res = await call(baseUrl, `/vendors/qbo:${AUTO.id}/history`, { token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, [], 'empty history without a row');
}

async function testClassesAndSpecs(baseUrl, tokens, db) {
  let res = await call(baseUrl, `/classes${q()}`, { token: tokens.admin });
  assert.equal(res.status, 200);
  let classA = res.json.classes.find(entry => entry.qbo_class_id === 'cls-a');
  const classB = res.json.classes.find(entry => entry.qbo_class_id === 'cls-b');
  const unassigned = res.json.classes.find(entry => entry.qbo_class_id === '__unassigned__');
  assert.ok(classA && classB, 'classes listed');
  near(classA.total, 258200, 'class A total from line allocation');
  assert.equal(classA.bill_count, 16);
  assert.equal(classA.vendor_count, 1);
  near(classA.allocated_total, 8000, 'multi-class share on A');
  near(classB.allocated_total, 5000, 'multi-class share on B');
  near(classA.spend_by_type.rehab, 258200, 'Capital Improvements -> rehab');
  near(classB.spend_by_type.maintenance, 4000, 'Repairs - Maintenance -> maintenance');
  assert.equal(classA.completeness, 'complete', 'completed project, last bill > 60 days ago');
  assert.equal(classB.completeness, 'in_progress', 'project still under construction');
  assert.equal(classA.linked_project.id, 'proj-a');
  assert.equal(classA.specs, null, 'no specs yet');
  assert.equal(classA.per_sqft, null);
  assert.equal(classA.per_sqft_reason, 'no square footage recorded');
  assert.equal(classA.project_type, 'rehab');
  assert.equal(classA.project_type_source, 'inferred');
  assert.ok(unassigned && unassigned.total === 0, '__unassigned__ class is $0');
  assert.equal(res.json.classes_with_sqft, 0);

  // Upper management sets everything.
  res = await call(baseUrl, '/classes/cls-a/specs', { method: 'PUT', token: tokens.admin, body: { square_feet: 2000, bedrooms: 3, bathrooms: 1.5, project_type: 'rehab' } });
  assert.equal(res.status, 200, 'admin sets specs');
  assert.equal(res.json.qbo_class_id, 'cls-a');
  assert.equal(res.json.specs.square_feet, 2000);
  assert.equal(res.json.specs.bedrooms, 3);
  assert.equal(res.json.specs.bathrooms, 1.5);
  assert.equal(res.json.specs.project_type, 'rehab');
  assert.equal(res.json.specs.updated_by, ADMIN_ID);
  assert.equal(res.json.specs.updated_by_name, 'Owner Admin');
  near(res.json.class.per_sqft, 129.1, '(rehab + new) / sqft = 258,200 / 2,000');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'cost_analyzer_class_specs_set'").get().n, 1, 'specs change audited');
  res = await call(baseUrl, '/classes/cls-b/specs', { method: 'PUT', token: tokens.admin, body: { square_feet: 1000 } });
  assert.equal(res.status, 200);

  // Validation (hand-written ranges).
  const bad = [
    [{ square_feet: 50 }, 'sqft below 100'],
    [{ square_feet: 60000 }, 'sqft above 50,000'],
    [{ bedrooms: 2.5 }, 'bedrooms must be whole'],
    [{ bathrooms: 1.3 }, 'bathrooms step 0.5'],
    [{ units: 0 }, 'units >= 1'],
    [{ stories: 0.7 }, 'stories step 0.5'],
    [{ year_built: 1700 }, 'year_built >= 1800'],
    [{ project_type: 'bogus' }, 'project_type in list'],
    [{ square_feet: 'abc' }, 'not a number'],
    [{}, 'empty body'],
  ];
  for (const [body, label] of bad) {
    res = await call(baseUrl, '/classes/cls-a/specs', { method: 'PUT', token: tokens.admin, body });
    assert.equal(res.status, 400, `400 for ${label}`);
  }
  res = await call(baseUrl, '/classes/cls-a/specs', { method: 'PUT', token: tokens.admin, body: { project_id: 'nope' } });
  assert.equal(res.status, 404, 'unknown project');
  res = await call(baseUrl, '/classes/nope-class/specs', { method: 'PUT', token: tokens.admin, body: { square_feet: 1000 } });
  assert.equal(res.status, 404, 'unknown class');
  res = await call(baseUrl, '/classes/__unassigned__/specs', { method: 'PUT', token: tokens.admin, body: { square_feet: 1000 } });
  assert.equal(res.status, 400, 'unassigned is not a project');

  // Project manager: add only (on a class that is not a BuildTrack project).
  res = await call(baseUrl, '/classes/cls-d/specs', { method: 'PUT', token: tokens.pm, body: { square_feet: 1200 } });
  assert.equal(res.status, 200, 'PM first insert');
  assert.equal(res.json.specs.square_feet, 1200);
  assert.equal(res.json.class_name, CLASS_NAMES['cls-d'], 'class name taken from the bill lines');
  res = await call(baseUrl, '/classes/cls-d/specs', { method: 'PUT', token: tokens.pm, body: { square_feet: 1300 } });
  assert.equal(res.status, 403, 'PM cannot overwrite a recorded value');
  assert.ok(String(res.json.error).includes('Project managers'), 'blockProjectManagerMutation message');
  res = await call(baseUrl, '/classes/cls-d/specs', { method: 'PUT', token: tokens.pm, body: { bedrooms: 2 } });
  assert.equal(res.status, 200, 'PM fills an empty field');
  res = await call(baseUrl, '/classes/cls-d/specs', { method: 'PUT', token: tokens.pm, body: { square_feet: 1200, bathrooms: 1 } });
  assert.equal(res.status, 200, 'identical value plus a new field is allowed');
  res = await call(baseUrl, '/classes/cls-d/specs', { method: 'PUT', token: tokens.pm, body: { square_feet: null } });
  assert.equal(res.status, 403, 'PM cannot clear a value');
  res = await call(baseUrl, '/classes/cls-d/specs', { method: 'PUT', token: tokens.pm, body: { project_id: 'proj-a' } });
  assert.equal(res.status, 403, 'PM cannot link a project');
  res = await call(baseUrl, '/classes/cls-d/specs', { method: 'PUT', token: tokens.pm, body: { notes: 'garage converted' } });
  assert.equal(res.status, 200, 'PM adds notes');
  const specsD = db.prepare('SELECT * FROM cost_analyzer_class_specs WHERE qbo_class_id = ?').get('cls-d');
  assert.equal(specsD.square_feet, 1200);
  assert.equal(specsD.bedrooms, 2);
  assert.equal(specsD.bathrooms, 1);
  assert.equal(specsD.notes, 'garage converted');
  assert.equal(specsD.updated_by, PM_ID);
  assert.equal(specsD.project_id, null);

  // Class detail + per-sqft after specs.
  res = await call(baseUrl, `/classes/cls-a${q()}`, { token: tokens.pm });
  assert.equal(res.status, 200);
  classA = res.json;
  assert.equal(classA.specs.square_feet, 2000);
  near(classA.per_sqft, 129.1, 'class detail $/sq ft');
  near(classA.per_bedroom, 86066.67, '$/bedroom');
  assert.equal(classA.project_type_source, 'stored');
  assert.ok(classA.vendors.length === 1 && classA.vendors[0].name === CREW.name, 'class vendors');
  assert.ok(classA.by_category.some(category => category.id === 'carpentry' && category.per_sqft !== null), 'category per sqft on the class');
  assert.equal(classA.items.length, 7, 'items on the class');
  assert.ok(classA.materials.some(family => family.family === 'doors'), 'materials by family on the class');
  res = await call(baseUrl, `/classes/nope${q()}`, { token: tokens.pm });
  assert.equal(res.status, 404, 'unknown class detail');
}

async function testCategories(baseUrl, token) {
  let res = await call(baseUrl, '/categories', { token });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json) && res.json.length >= 34, 'taxonomy list');
  assert.ok(res.json.some(category => category.id === 'carpentry' && category.name === 'Carpenter' && category.kind === 'trade'));

  // /categories/stats must not be swallowed by /categories/:id.
  res = await call(baseUrl, `/categories/stats${q()}`, { token });
  assert.equal(res.status, 200, 'stats route not shadowed');
  assert.ok(Array.isArray(res.json.categories), 'stats payload');
  const carpentry = res.json.categories.find(category => category.id === 'carpentry');
  near(carpentry.total, 265200, 'carpentry total incl. the Fatmir bill');
  assert.equal(carpentry.vendor_count, 2);
  assert.equal(carpentry.implied_hourly, 45, 'FTE-weighted: 187,200 / (2,080 x 2 vendor-years)');
  assert.equal(carpentry.n_vendor_years, 2);
  assert.equal(carpentry.n_vendors_qualifying, 1);
  assert.equal(carpentry.vendor_rates.length, 2);
  assert.ok(carpentry.vendor_rates.every(rate => rate.vendor === CREW.name), 'only the crew has qualifying complete years');
  assert.equal(carpentry.doc_hourly, 60, 'Invoice $/hr on the category');
  near(carpentry.per_sqft_weighted, 129.1, 'weighted $/sq ft over complete classes with sqft');
  assert.equal(carpentry.n_classes_with_sqft, 1);
  assert.equal(carpentry.n_in_progress_excluded, 1, 'class B is in progress');
  const classRowB = carpentry.by_class.find(row => row.class_id === 'cls-b');
  assert.equal(classRowB.completeness, 'in_progress');
  assert.equal(classRowB.in_weighting, false);
  const supplierCategory = res.json.categories.find(category => category.id === 'building-materials');
  near(supplierCategory.total, 20000, 'supplier category total');
  assert.equal(supplierCategory.implied_hourly, null);
  assert.equal(supplierCategory.implied_hourly_reason, 'not_a_trade');
  const hvac = res.json.categories.find(category => category.id === 'hvac');
  near(hvac.total, 9000, 'keyword-filed bill counts for hvac');
  const roofing = res.json.categories.find(category => category.id === 'roofing');
  near(roofing.total, 5000, 'one-bill roofer total');
  assert.equal(roofing.implied_hourly, null);
  assert.ok(roofing.implied_hourly_reason, 'reason when nothing qualifies');

  res = await call(baseUrl, `/categories/stats${q({ include_in_progress: '1' })}`, { token });
  assert.equal(res.status, 200);
  const withProgress = res.json.categories.find(category => category.id === 'carpentry');
  near(withProgress.per_sqft_weighted, 87.73, '(258,200 + 5,000) / 3,000 with in-progress classes');
  assert.equal(withProgress.n_classes_with_sqft, 2);
  assert.equal(withProgress.n_in_progress_excluded, 0);

  res = await call(baseUrl, `/categories/carpentry${q()}`, { token });
  assert.equal(res.status, 200, 'category detail');
  assert.equal(res.json.id, 'carpentry');
  assert.ok(Array.isArray(res.json.bills) && res.json.bills.length === 18, 'category bills: 17 crew bills (incl. the $0 one) + Fatmir');
  assert.ok(res.json.materials && Array.isArray(res.json.materials.families), 'materials in the category');
  res = await call(baseUrl, `/categories/nope${q()}`, { token });
  assert.equal(res.status, 404, 'unknown category');
}

async function testMaterials(baseUrl, tokens, db) {
  const token = tokens.admin;
  let res = await call(baseUrl, `/materials${q()}`, { token });
  assert.equal(res.status, 200);
  let materials = res.json;
  assert.equal(materials.totals.n_items, 7);
  assert.equal(materials.totals.n_unit_items, 4, 'unit basis: quantity > 0 and unit not lot');
  assert.equal(materials.totals.n_job_items, 3);
  assert.equal(materials.totals.n_items_without_amount, 1);

  const doors = materials.families.find(family => family.family === 'doors');
  assert.ok(doors, 'doors family');
  const interiorDoor = doors.types.find(type => type.material_type === 'interior_door');
  assert.equal(interiorDoor.n_items, 3, 'grouped on the canonical type');
  assert.equal(interiorDoor.dominant_unit, 'each');
  assert.equal(interiorDoor.avg_unit_price, 155);
  assert.equal(interiorDoor.median_unit_price, 155);
  assert.equal(interiorDoor.min_unit_price, 150);
  assert.equal(interiorDoor.max_unit_price, 160);
  near(interiorDoor.total_spend, 770, 'door spend');
  assert.deepEqual(interiorDoor.raw_types_seen, ['interior prehung door']);
  assert.ok(interiorDoor.samples.length === 3 && interiorDoor.samples[0].attachment_url.includes('att-1'), 'samples link to the document');
  assert.ok(!materials.families.some(family => family.family === 'roofing'), 'job-priced roofing is not a unit group');
  const roofJob = materials.job_costs.find(group => group.family === 'roofing');
  assert.ok(roofJob, 'roofing job-cost group');
  assert.equal(roofJob.n_jobs, 1);
  assert.equal(roofJob.avg_line_total, 8000);
  assert.equal(roofJob.phase, 'n_a');
  assert.ok(roofJob.per_class.some(row => row.class_id === 'cls-a' && row.per_sqft === 4), 'job cost per sqft: 8,000 / 2,000');
  const laborJob = materials.job_costs.find(group => group.category_id === 'carpentry');
  assert.ok(laborJob, 'lines without a family group under the bill category');

  const coverageById = Object.fromEntries(materials.coverage.map(row => [row.id, row]));
  assert.equal(materials.coverage.length, 12, 'twelve owner targets');
  assert.equal(coverageById.doors.status, 'ok', 'three door items');
  assert.equal(coverageById.doors.n_unit_items, 3);
  assert.equal(coverageById.countertops_quartz.status, 'thin');
  assert.equal(coverageById.roofing.status, 'thin');
  assert.equal(coverageById.roofing.n_job_items, 1);
  assert.equal(coverageById.drywall.status, 'thin', 'a needs-review line still counts as seen');
  assert.equal(coverageById.flooring.status, 'none');
  assert.equal(coverageById.hvac.status, 'none');
  assert.equal(coverageById.hvac.target.status, 'open', 'missing target row reads as open');

  const kinds = new Set(materials.unknowns.map(entry => entry.kind));
  assert.ok(kinds.has('text_stub'), 'text stub attachment listed');
  const stub = materials.unknowns.find(entry => entry.kind === 'text_stub');
  assert.equal(stub.attachment_id, 'att-stub');
  assert.ok(stub.message.includes('re-run the QuickBooks PDF sync with force for bill b-c-2412'));
  assert.ok(kinds.has('item_needs_review'), 'item without an amount listed');
  assert.ok(materials.unknowns.some(entry => entry.kind === 'item_needs_review' && entry.item_id === 'item-drywall' && entry.reason === 'no amount on document'));
  assert.ok(kinds.has('lines_mismatch'), 'bill lines that do not add up listed');
  assert.ok(materials.unknowns.some(entry => entry.kind === 'target_empty' && entry.target === 'hvac'), 'empty open target listed');
  assert.ok(!kinds.has('totals_mismatch'), 'documents match their bills');
  assert.equal(materials.documents.extracted, 5);
  assert.equal(materials.documents.needs_review_items, 1);

  // Items list with filters and paging.
  res = await call(baseUrl, '/materials/items?family=doors', { token });
  assert.equal(res.status, 200);
  assert.equal(res.json.total, 3);
  assert.equal(res.json.items.length, 3);
  assert.equal(res.json.items[0].class_name, CLASS_NAMES['cls-a']);
  assert.equal(res.json.items[0].vendor_name, CREW.name);
  res = await call(baseUrl, '/materials/items?needs_review=1', { token });
  assert.equal(res.json.total, 1);
  assert.equal(res.json.items[0].id, 'item-drywall');
  assert.equal(res.json.items[0].needs_review, true);
  res = await call(baseUrl, `/materials/items?vendor_id=qbo:${CREW.id}&limit=2&offset=0`, { token });
  assert.equal(res.json.total, 7);
  assert.equal(res.json.items.length, 2);
  assert.equal(res.json.limit, 2);
  res = await call(baseUrl, '/materials/items?limit=0', { token });
  assert.equal(res.status, 400, 'limit below 1');
  res = await call(baseUrl, '/materials/items?limit=501', { token });
  assert.equal(res.status, 400, 'limit above 500');
  res = await call(baseUrl, '/materials/items?offset=-1', { token });
  assert.equal(res.status, 400, 'negative offset');
  res = await call(baseUrl, '/materials/items?family=bogus', { token });
  assert.equal(res.status, 400, 'unknown family');

  // Manual price: canonical type, derived line total, no review flag when an amount exists.
  res = await call(baseUrl, '/materials/items', { method: 'POST', token, body: {
    description: 'LVP flooring 12 mil', material_family: 'flooring', material_type: 'luxury vinyl plank', spec: '12 mil',
    unit: 'sqft', quantity: 500, unit_price: 2.5, qbo_bill_id: 'b-c-2402',
  } });
  assert.equal(res.status, 201, 'manual item created');
  const manualItem = res.json;
  assert.equal(manualItem.source, 'manual');
  assert.equal(manualItem.material_type, 'lvp_flooring');
  assert.equal(manualItem.material_type_raw, 'luxury vinyl plank');
  assert.equal(manualItem.line_total, 1250, 'line total derived from quantity x unit price');
  assert.equal(manualItem.pricing_basis, 'unit');
  assert.equal(manualItem.needs_review, false);
  assert.equal(manualItem.qbo_class_id, 'cls-a', 'class inherited from the single-class bill');
  assert.equal(manualItem.vendor_name, CREW.name);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'cost_analyzer_material_item_created'").get().n, 1);
  res = await call(baseUrl, '/materials/items', { method: 'POST', token, body: { description: 'no family', material_type: 'x', unit: 'each', unit_price: 1 } });
  assert.equal(res.status, 400, 'material_family required');
  res = await call(baseUrl, '/materials/items', { method: 'POST', token, body: { description: 'bad unit', material_family: 'doors', material_type: 'door', unit: 'bogus', unit_price: 1 } });
  assert.equal(res.status, 400, 'unit enum');
  res = await call(baseUrl, '/materials/items', { method: 'POST', token, body: { description: 'negative', material_family: 'doors', material_type: 'door', unit: 'each', unit_price: -5 } });
  assert.equal(res.status, 400, 'negative price on a non-credit line');
  res = await call(baseUrl, '/materials/items', { method: 'POST', token, body: { description: 'credit', material_family: 'doors', material_type: 'door', unit: 'each', unit_price: -5, item_kind: 'credit' } });
  assert.equal(res.status, 201, 'credit may be negative');
  const creditId = res.json.id;
  res = await call(baseUrl, '/materials/items', { method: 'POST', token, body: { description: 'no bill', material_family: 'doors', material_type: 'door', unit: 'each', unit_price: 1, qbo_bill_id: 'nope' } });
  assert.equal(res.status, 404, 'unknown bill on an item');
  res = await call(baseUrl, '/materials/items', { method: 'POST', token, body: { description: 'no price', material_family: 'doors', material_type: 'door', unit: 'each' } });
  assert.equal(res.status, 400, 'a price is required');

  // Edit: unit price change re-prices the line; the document alias route works too.
  res = await call(baseUrl, `/materials/items/${manualItem.id}`, { method: 'PUT', token, body: { unit_price: 3 } });
  assert.equal(res.status, 200, 'item updated');
  assert.equal(res.json.unit_price, 3);
  assert.equal(res.json.line_total, 1500, 'line total re-derived');
  res = await call(baseUrl, '/documents/att-1/items/item-drywall', { method: 'PUT', token, body: { line_total: 950 } });
  assert.equal(res.status, 200, 'alias route edits a document item');
  assert.equal(res.json.line_total, 950);
  assert.equal(res.json.needs_review, false, 'supplying the amount clears the review flag');
  assert.equal(res.json.source, 'ai', 'source is kept on edit');
  res = await call(baseUrl, '/documents/att-2/items/item-drywall', { method: 'PUT', token, body: { line_total: 950 } });
  assert.equal(res.status, 404, 'item must belong to the document in the path');
  res = await call(baseUrl, '/materials/items/nope', { method: 'PUT', token, body: { line_total: 1 } });
  assert.equal(res.status, 404, 'unknown item');
  res = await call(baseUrl, `/materials/items/${manualItem.id}`, { method: 'PUT', token, body: {} });
  assert.equal(res.status, 400, 'empty update');

  // Delete: manual only.
  res = await call(baseUrl, '/materials/items/item-door-1', { method: 'DELETE', token });
  assert.equal(res.status, 403, 'AI items cannot be deleted');
  res = await call(baseUrl, `/materials/items/${creditId}`, { method: 'DELETE', token });
  assert.equal(res.status, 200, 'manual item deleted');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cost_analyzer_material_items WHERE id = ?').get(creditId).n, 0);
  res = await call(baseUrl, `/materials/items/${creditId}`, { method: 'DELETE', token });
  assert.equal(res.status, 404, 'already gone');
  res = await call(baseUrl, `/materials/items/${manualItem.id}`, { method: 'DELETE', token: tokens.pm });
  assert.equal(res.status, 403, 'PM cannot delete');

  // Targets.
  res = await call(baseUrl, '/materials/targets/hvac', { method: 'PUT', token, body: { status: 'not_applicable', answer: 'No HVAC work was billed through vendors' } });
  assert.equal(res.status, 200, 'target answered');
  assert.equal(res.json.target, 'hvac');
  assert.equal(res.json.status, 'not_applicable');
  assert.equal(res.json.answered_by, ADMIN_ID);
  assert.equal(res.json.answered_by_name, 'Owner Admin');
  assert.ok(res.json.answered_at, 'answered_at set');
  assert.ok(res.json.label, 'label from the target list');
  res = await call(baseUrl, '/materials/targets/bogus', { method: 'PUT', token, body: { status: 'answered' } });
  assert.equal(res.status, 404, 'unknown target');
  res = await call(baseUrl, '/materials/targets/hvac', { method: 'PUT', token, body: { status: 'bogus' } });
  assert.equal(res.status, 400, 'bad target status');

  res = await call(baseUrl, `/materials${q()}`, { token });
  materials = res.json;
  const hvacTarget = materials.targets.find(row => row.target === 'hvac');
  assert.equal(hvacTarget.status, 'not_applicable');
  assert.equal(materials.coverage.find(row => row.id === 'hvac').target.status, 'not_applicable');
  assert.ok(!materials.unknowns.some(entry => entry.kind === 'target_empty' && entry.target === 'hvac'), 'answered target leaves the unknowns');
  assert.ok(materials.resolved.some(entry => entry.kind === 'target_not_applicable' && entry.target === 'hvac'), 'answered target listed under resolved');
  assert.equal(materials.coverage.find(row => row.id === 'flooring').status, 'thin', 'manual LVP item counts toward flooring');
  assert.equal(materials.totals.n_manual_items, 1);
  assert.equal(materials.totals.n_items_without_amount, 0, 'drywall amount was supplied');
  assert.ok(!materials.unknowns.some(entry => entry.kind === 'item_needs_review'), 'no review items left');
  res = await call(baseUrl, '/materials/targets/hvac', { method: 'PUT', token, body: { status: 'open' } });
  assert.equal(res.status, 200, 'target reopened');
  assert.equal(res.json.answered_by, null);
}

async function testDocuments(baseUrl, token) {
  let res = await call(baseUrl, '/documents', { token });
  assert.equal(res.status, 200);
  assert.equal(res.json.total, 5);
  assert.equal(res.json.documents.length, 5);
  assert.equal(res.json.limit, 50);
  assert.equal(res.json.offset, 0);
  const first = res.json.documents.find(doc => doc.attachment_id === 'att-1');
  assert.equal(first.status, 'extracted');
  assert.equal(first.vendor_name, CREW.name);
  assert.equal(first.txn_date, '2024-01-15');
  assert.equal(first.bill_total, 13000);
  assert.equal(first.document_total, 13000);
  assert.equal(first.totals_match, true);
  assert.deepEqual(first.bills_covered, ['b-c-2401']);
  assert.ok(first.attachment_url.includes('/api/quickbooks/bills/b-c-2401/attachments/att-1?inline=1'));
  assert.equal(res.json.counts.extracted, 5);
  assert.equal(res.json.counts.attachments, 6);
  assert.equal(res.json.scan.active, false);
  assert.equal(res.json.scan.configured, false, 'no API key in tests');
  res = await call(baseUrl, '/documents?status=pending', { token });
  assert.equal(res.json.total, 0);
  res = await call(baseUrl, '/documents?status=bogus', { token });
  assert.equal(res.status, 400, 'bad status filter');
  res = await call(baseUrl, '/documents?limit=2&offset=4', { token });
  assert.equal(res.json.documents.length, 1, 'paging');

  res = await call(baseUrl, '/documents/att-1', { token });
  assert.equal(res.status, 200);
  assert.equal(res.json.attachment_id, 'att-1');
  assert.equal(res.json.model, 'test-model');
  assert.equal(res.json.items.length, 7);
  assert.deepEqual(res.json.unknowns, ['no hours listed for trim work']);
  assert.ok(res.json.extracted && typeof res.json.extracted === 'object', 'parsed extracted_json');
  res = await call(baseUrl, '/documents/nope', { token });
  assert.equal(res.status, 404, 'unknown document');

  res = await call(baseUrl, '/documents/scan/status', { token });
  assert.equal(res.status, 200, 'scan status route not shadowed by /documents/:attachmentId');
  assert.equal(res.json.active, false);
  assert.equal(res.json.counts.total, 5);
  assert.equal(res.json.counts.extracted, 5);
  assert.equal(res.json.run, null, 'no scan yet');

  res = await call(baseUrl, '/documents/scan', { method: 'POST', token, body: { scope: 'bogus' } });
  assert.equal(res.status, 400, 'bad scope');
  res = await call(baseUrl, '/documents/scan', { method: 'POST', token, body: { scope: 'selected', attachment_ids: ['nope'] } });
  assert.equal(res.status, 400, 'unknown attachment id');
  res = await call(baseUrl, '/documents/scan', { method: 'POST', token, body: { scope: 'selected', attachment_ids: [] } });
  assert.equal(res.status, 400, 'selected scan needs ids');
  res = await call(baseUrl, '/documents/scan', { method: 'POST', token, body: { scope: 'pending', attachment_ids: Array.from({ length: 501 }, (_, i) => `a${i}`) } });
  assert.equal(res.status, 400, 'at most 500 ids');
  res = await call(baseUrl, '/documents/scan', { method: 'POST', token, body: { scope: 'pending' } });
  assert.equal(res.status, 503, 'no Anthropic key configured');
  assert.ok(res.json && res.json.error, 'error shape');
  res = await call(baseUrl, '/documents/scan/cancel', { method: 'POST', token, body: {} });
  assert.equal(res.status, 404, 'nothing to cancel');
}

async function testCsvExport(baseUrl, tokens) {
  let res = await call(baseUrl, `/export.csv${q({ report: 'vendors' })}`, { token: tokens.admin });
  assert.equal(res.status, 200, 'vendors csv');
  assert.ok(String(res.headers.get('content-type')).startsWith('text/csv'), 'csv content type');
  assert.ok(String(res.headers.get('content-disposition')).includes('cost-analyzer-vendors-all_all.csv'), 'filename');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok(res.text.includes('"\'=1+1"'), 'formula-looking vendor name is neutralised');
  assert.ok(res.text.includes('\r\n'), 'CRLF line endings');
  assert.ok(res.text.startsWith('"Vendor",'), 'quoted header');
  assert.ok(res.text.includes(`"${CREW.name}"`), 'crew row present');
  res = await call(baseUrl, `/export.csv${q({ report: 'classes', from: '2025-01-01', to: '2025-12-31' })}`, { token: tokens.pm });
  assert.equal(res.status, 200, 'PM may export');
  assert.ok(String(res.headers.get('content-disposition')).includes('cost-analyzer-classes-2025-01-01_2025-12-31.csv'));
  assert.ok(res.text.includes(`"${CLASS_NAMES['cls-a']}"`));
  for (const report of ['categories', 'materials']) {
    res = await call(baseUrl, `/export.csv${q({ report })}`, { token: tokens.admin });
    assert.equal(res.status, 200, `${report} csv`);
  }
  res = await call(baseUrl, `/export.csv${q({ report: 'bogus' })}`, { token: tokens.admin });
  assert.equal(res.status, 400, 'unknown report');
  res = await call(baseUrl, `/export.csv${q()}`, { token: tokens.admin });
  assert.equal(res.status, 400, 'report required');
  res = await call(baseUrl, `/export.csv${q({ report: 'vendors' })}`, { token: tokens.contractor });
  assert.equal(res.status, 403, 'contractor cannot export');
}

async function testAutoCategorize(baseUrl, token, db) {
  const res = await call(baseUrl, '/vendors/auto-categorize', { method: 'POST', token, body: {} });
  assert.equal(res.status, 200, 'auto-categorize route not shadowed by /vendors/:id');
  assert.ok(Array.isArray(res.json.changes), 'changes list');
  assert.equal(res.json.changed, res.json.changes.length);
  const change = res.json.changes.find(entry => entry.vendor_name === AUTO.name);
  assert.ok(change, 'the roofing vendor was classified from its name');
  assert.equal(change.category_id, 'roofing');
  assert.equal(change.vendor_id, change.row_id);
  const row = db.prepare('SELECT * FROM cost_analyzer_vendor_categories WHERE qbo_vendor_id = ?').get(AUTO.id);
  assert.equal(row.source, 'keyword');
  assert.equal(row.category_id, 'roofing');
  const manual = db.prepare('SELECT source, category_id FROM cost_analyzer_vendor_categories WHERE qbo_vendor_id = ?').get(UNCAT.id);
  assert.equal(manual.source, 'manual', 'manual rows are never touched');
  assert.equal(manual.category_id, 'drywall');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'cost_analyzer_vendors_auto_categorized'").get().n, 1);
}

function testStartupRecovery(db) {
  db.prepare(`
    INSERT INTO cost_analyzer_scan_runs (id, started_by, status, scope, total, heartbeat_at, started_at)
    VALUES ('run-stale', ?, 'running', 'pending', 3, datetime('now', '-10 minutes'), datetime('now', '-15 minutes'))
  `).run(ADMIN_ID);
  db.prepare("UPDATE cost_analyzer_documents SET status = 'running', claimed_by_run_id = 'run-stale' WHERE attachment_id = 'att-2'").run();

  initializeSchema();

  const run = db.prepare('SELECT * FROM cost_analyzer_scan_runs WHERE id = ?').get('run-stale');
  assert.equal(run.status, 'failed', 'stale running run is failed on startup');
  assert.equal(run.error, 'interrupted by restart');
  assert.ok(run.finished_at, 'finished_at stamped');
  const doc = db.prepare('SELECT status, claimed_by_run_id FROM cost_analyzer_documents WHERE attachment_id = ?').get('att-2');
  assert.equal(doc.status, 'pending', 'document claimed by the dead run goes back to pending');
  assert.equal(doc.claimed_by_run_id, null);
  assert.equal(db.prepare("SELECT value FROM cost_analyzer_settings WHERE key = 'vendor_seed_version'").get().value, SEED_VERSION, 'seed marker intact');
}

// ── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  const db = initializeSchema();
  seedUsersAndProjects(db);
  seedVendorsAndProfiles(db);
  testSeedApplication(db);
  seedBills(db);
  seedDocumentsAndItems(db);
  seedVendorCategories(db);
  assert.strictEqual(getDb(), db, 'router and test share one DB handle');

  const { server, baseUrl } = await startApp();
  const tokens = {
    admin: tokenFor(ADMIN_ID),
    ops: tokenFor(OPS_ID),
    pm: tokenFor(PM_ID),
    assistant: tokenFor(ASSISTANT_ID),
    contractor: tokenFor(CONTRACTOR_ID),
  };

  try {
    await testRoleGating(baseUrl, tokens);
    await testFilterValidation(baseUrl, tokens.admin);
    await testOverview(baseUrl, tokens.admin);
    await testVendorsAndHourly(baseUrl, tokens.admin);
    await testBillOverrides(baseUrl, tokens.ops, db);
    await testVendorCategoryWrites(baseUrl, tokens.admin, db);
    await testClassesAndSpecs(baseUrl, tokens, db);
    await testCategories(baseUrl, tokens.admin);
    await testMaterials(baseUrl, tokens, db);
    await testDocuments(baseUrl, tokens.admin);
    await testCsvExport(baseUrl, tokens);
    await testAutoCategorize(baseUrl, tokens.admin, db);
    testStartupRecovery(db);

    // Every financial GET leaves a data-access trail; the taxonomy and scan status do not.
    const accessActions = new Set(db.prepare("SELECT DISTINCT action FROM data_access_events WHERE entity_type = 'cost_analyzer'").all().map(row => row.action));
    for (const action of ['cost_analyzer_overview_viewed', 'cost_analyzer_vendors_viewed', 'cost_analyzer_vendor_viewed', 'cost_analyzer_classes_viewed',
      'cost_analyzer_class_viewed', 'cost_analyzer_categories_viewed', 'cost_analyzer_category_viewed', 'cost_analyzer_materials_viewed',
      'cost_analyzer_material_items_viewed', 'cost_analyzer_documents_viewed', 'cost_analyzer_document_viewed', 'cost_analyzer_export']) {
      assert.ok(accessActions.has(action), `data access logged for ${action}`);
    }

    console.log('Cost Analyzer tests passed');
  } finally {
    server.close();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
