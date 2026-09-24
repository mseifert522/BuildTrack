// Tests for the Cost Analyzer document extraction service (spec section 5, test
// list in section 8). Node's built-in assert against a temp DB, same convention
// as quoteAnalytics.test.js. The Anthropic client is replaced through
// setAnthropicFactoryForTests with a fake that records every request and
// answers from a queue of canned messages / thrown SDK errors, so no network
// call is ever made and the real model is never billed.
//
// Files under test live in a temp UPLOADS_PATH: a real single-page PDF built
// with pdf-lib, a real tiny JPEG built with sharp, and a text/plain Intuit
// download-link stub that must be skipped without ever being read or sent.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildtrack-cost-extraction-'));
process.env.DB_PATH = path.join(tempDir, 'buildtrack-test.db');
process.env.JWT_SECRET = 'cost-analyzer-extraction-test-secret';
process.env.UPLOADS_PATH = path.join(tempDir, 'uploads');
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key-with-enough-characters';
// Transient retries would otherwise sleep 5 s / 15 s / 45 s (read at module load).
process.env.COST_ANALYZER_BACKOFF_MS = '0,0,0';
delete process.env.COST_ANALYZER_SCAN_CONCURRENCY;
delete process.env.COST_ANALYZER_AUTO_SCAN;

const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const AnthropicModule = require('@anthropic-ai/sdk');
// Same interop rule as the service: the CommonJS export is the client class
// (typed errors hang off it as static properties), some builds wrap it in .default.
const Anthropic = AnthropicModule.default || AnthropicModule;

const { initializeSchema } = require('../src/db/schema');
const extractionService = require('../src/services/costAnalyzerExtraction');
const {
  startScan,
  cancelScan,
  getScanStatus,
  extractOne,
  enqueueNewDocuments,
  setAnthropicFactoryForTests,
  __resetForTests,
  __setBackoffForTests,
  extractionSchema,
  getRuntimeFlags,
  detectFileType,
  computeTotalsMatch,
  matchClassForLocation,
  normalizeExtraction,
  DEFAULT_MODEL,
  FALLBACK_MODEL,
} = extractionService;

const ADMIN_ID = 'cost-extraction-admin';
const REALM_ID = 'realm-test';
const VENDOR_ID = 'V-DRYWALL-TEST';
const VENDOR_NAME = 'Zed Drywall Testing LLC';
const VENDOR_CATEGORY_ROW_ID = 'vc-zed-drywall-test';
const CLASS_ID = 'CLASS-123-MAIN';
const CLASS_NAME = '123 Main St';
const FALLBACK_BETA = 'server-side-fallback-2026-06-01';
const FAKE_MODEL = 'claude-opus-5-fake-20260101';
// What a real Intuit download-link stub looks like: a URL carrying a credential.
// The extractor must never read past the magic bytes, so this string must never
// appear in a request, an error column or a log.
const SECRET_MARKER = 'SECRET-TOKEN-MUST-NEVER-LEAK';
const TEXT_STUB = `https://c1.qbo.intuit.com/v3/company/123456/download/999?token=${SECRET_MARKER}\n`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function seedBase(db) {
  db.prepare(`INSERT INTO users (id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(ADMIN_ID, 'Cost Admin', 'cost-admin@example.test', 'hash', 'super_admin');
  db.prepare(`INSERT INTO quickbooks_vendors (qbo_id, realm_id, display_name, active) VALUES (?, ?, ?, 1)`)
    .run(VENDOR_ID, REALM_ID, VENDOR_NAME);
  // The taxonomy upsert on startup normally creates these; INSERT OR IGNORE keeps
  // the test meaningful even if that startup step failed.
  const insertCategory = db.prepare(`INSERT OR IGNORE INTO cost_analyzer_categories (id, name, kind, sort_order) VALUES (?, ?, ?, 0)`);
  for (const [id, name, kind] of [['drywall', 'Drywall', 'trade'], ['painting', 'Painting', 'trade'], ['roofing', 'Roof', 'trade']]) {
    insertCategory.run(id, name, kind);
  }
  // The vendor's current category: 'drywall'. The AI bill-category rule only
  // writes a suggestion that differs from this.
  db.prepare(`
    INSERT INTO cost_analyzer_vendor_categories (id, vendor_key, qbo_vendor_id, vendor_name, category_id, source, confidence)
    VALUES (?, ?, ?, ?, 'drywall', 'seed', 0.9)
  `).run(VENDOR_CATEGORY_ROW_ID, VENDOR_NAME.trim().toLowerCase(), VENDOR_ID, VENDOR_NAME);
}

function addBill(db, { id, total, note = null, classId = CLASS_ID, className = CLASS_NAME, status = 'not_approved', lines = null }) {
  db.prepare(`
    INSERT INTO quickbooks_bills (qbo_id, realm_id, vendor_id, vendor_name, txn_date, total_amt, private_note, qbo_class_id, qbo_class_name, payment_approval_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, REALM_ID, VENDOR_ID, VENDOR_NAME, '2026-03-10', total, note, classId, className, status);
  const rows = lines || [{ description: 'Drywall work', amount: total }];
  const insertLine = db.prepare(`
    INSERT INTO quickbooks_bill_lines (id, qbo_bill_id, realm_id, qbo_line_id, line_num, description, amount, category_name, class_id, class_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  rows.forEach((line, index) => {
    insertLine.run(
      `${id}:${index + 1}`, id, REALM_ID, String(index + 1), index + 1, line.description, line.amount,
      '1240 Projects:Capital Improvements',
      line.class_id !== undefined ? line.class_id : classId,
      line.class_name !== undefined ? line.class_name : className,
    );
  });
}

// Writes the file exactly where routes/quickbooks.js would store it
// (<UPLOADS_PATH>/quickbooks-bill-attachments/<qbo_bill_id>/<filename>; the
// bill ids used here are already "safe" path segments) and inserts the row.
function addAttachment(db, { id, billId, bytes, mime, filename, skipFile = false }) {
  if (!skipFile) {
    const dir = path.join(process.env.UPLOADS_PATH, 'quickbooks-bill-attachments', billId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), bytes);
  }
  db.prepare(`
    INSERT INTO quickbooks_bill_attachments (id, qbo_bill_id, qbo_attachable_id, source, filename, original_name, mime_type, size, uploaded_by)
    VALUES (?, ?, NULL, 'qbo', ?, ?, ?, ?, ?)
  `).run(id, billId, filename, filename, mime, bytes.length, ADMIN_ID);
  return { id, qbo_bill_id: billId, filename, original_name: filename, mime_type: mime, size: bytes.length, qbo_attachable_id: null };
}

let pdfSeed = 0;
// A real, loadable single-page PDF; each call differs in page size so no two
// files share a content hash unless a test reuses the same buffer on purpose.
async function makePdf() {
  pdfSeed += 1;
  const pdf = await PDFDocument.create();
  pdf.addPage([200 + pdfSeed, 200]);
  return Buffer.from(await pdf.save());
}

let jpegSeed = 0;
async function makeJpeg() {
  jpegSeed += 1;
  return sharp({ create: { width: 4 + jpegSeed, height: 4, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function docRow(db, attachmentId) {
  return db.prepare('SELECT * FROM cost_analyzer_documents WHERE attachment_id = ?').get(attachmentId) || null;
}

function itemsFor(db, attachmentId) {
  return db.prepare('SELECT * FROM cost_analyzer_material_items WHERE attachment_id = ? ORDER BY line_no').all(attachmentId);
}

function billCategory(db, billId) {
  return db.prepare('SELECT * FROM cost_analyzer_bill_categories WHERE qbo_bill_id = ?').get(billId) || null;
}

function runRow(db, runId) {
  return db.prepare('SELECT * FROM cost_analyzer_scan_runs WHERE id = ?').get(runId) || null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Polls getScanStatus() (the same call the Documents tab makes) until the run
// row leaves 'running' and the in-process run is cleared.
async function waitForRun(db, runId, timeoutMs = 15000) {
  const startedAt = Date.now();
  for (;;) {
    const status = getScanStatus();
    const row = runRow(db, runId);
    if (row && row.status !== 'running' && !status.in_process) return row;
    assert.ok(Date.now() - startedAt < timeoutMs, `scan ${runId} did not finish within ${timeoutMs} ms`);
    await sleep(25);
  }
}

// ---------------------------------------------------------------------------
// Fake Anthropic client
// ---------------------------------------------------------------------------

const allClients = [];

// handlers: an array (one handler per call, in order) or a single function
// (answers every call). A handler receives the request and returns a message
// or throws (typed SDK errors included). Exposes beta.messages.stream() ->
// { finalMessage() } as the service uses, plus messages.create() for parity.
function fakeClient(handlers) {
  const queue = Array.isArray(handlers) ? handlers.slice() : null;
  const client = { requests: [] };
  const respond = async request => {
    client.requests.push(request);
    const handler = queue ? queue.shift() : handlers;
    if (typeof handler !== 'function') throw new Error('fake Anthropic client: no canned response left');
    return handler(request);
  };
  client.beta = { messages: { stream: request => ({ finalMessage: () => respond(request) }) } };
  client.messages = { create: request => respond(request) };
  setAnthropicFactoryForTests(() => client);
  allClients.push(client);
  return client;
}

// Typed SDK errors exactly as spec section 8 constructs them:
// new Anthropic.RateLimitError(429, { type: 'error', error: {...} }, 'x', new Headers())
function sdkError(name, status, errorType, message) {
  const Ctor = Anthropic[name];
  assert.equal(typeof Ctor, 'function', `SDK exposes ${name}`);
  return new Ctor(status, { type: 'error', error: { type: errorType, message } }, message, new Headers());
}

function lineItem(overrides = {}) {
  return {
    description: 'line',
    item_kind: 'material',
    material_family: 'other',
    // Text fields use "" for "not printed" (the API caps nullable fields at 16,
    // so only the number fields are nullable); the service maps "" to null.
    material_type: '',
    spec: '',
    phase: 'n_a',
    quantity: null,
    unit: 'other',
    unit_price: null,
    line_total: null,
    hours: null,
    days: null,
    rate: null,
    location: '',
    confidence: 0.9,
    ...overrides,
  };
}

// The canned model output. Every key the schema requires is present; the
// object is checked against extractionSchema() before it is used.
function cannedExtraction(overrides = {}) {
  return {
    doc_type: 'invoice',
    vendor_on_document: VENDOR_NAME,
    document_date: '2026-03-10',
    document_total: 1500,
    labor_total: 500,
    material_total: 1000,
    labor_hours: null,
    labor_days: null,
    labor_rate: null,
    labor_performed_by: '',
    project_address: '',
    suggested_category: 'painting',
    suggested_category_confidence: 0.9,
    summary: 'Drywall sheets, a laminate top and hang/tape/finish labor.',
    confidence: 0.88,
    line_items: [
      // unit price missing -> derived 600 / 40 = 15; raw type -> drywall_sheet
      lineItem({ description: '5/8 in drywall sheets', material_family: 'drywall', material_type: 'sheetrock 5/8', spec: '5/8 in', quantity: 40, unit: 'sheet', line_total: 600 }),
      // Formica -> laminate_countertop
      lineItem({ description: 'Formica countertop', material_family: 'countertops', material_type: 'Formica top', spec: 'laminate', quantity: 1, unit: 'each', unit_price: 400, line_total: 400 }),
      // lump-sum labor -> job basis, no review flag
      lineItem({ description: 'Hang tape and finish', item_kind: 'labor', material_family: 'drywall', material_type: 'hang tape finish', phase: 'install', unit: 'lot', line_total: 500 }),
      // no amount on the page -> needs_review
      lineItem({ description: 'drywall on rooms', item_kind: 'labor', material_family: 'drywall' }),
      // negative amount -> credit whatever the model called it
      lineItem({ description: 'Discount', line_total: -50 }),
    ],
    unknowns: ['no amount for "drywall on rooms"'],
    ...overrides,
  };
}

function messageFor(extractionObject, extra = {}) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: FAKE_MODEL,
    stop_reason: 'end_turn',
    stop_details: null,
    usage: { input_tokens: 1200, output_tokens: 300 },
    content: [{ type: 'text', text: JSON.stringify(extractionObject) }],
    ...extra,
  };
}

// Minimal JSON-schema check (types, enums, required, no extra properties) so
// the canned output is guaranteed to be something the API could have returned
// under the module's own output_config schema.
function assertMatchesSchema(value, schema, where = '$') {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = value === null ? 'null' : (Array.isArray(value) ? 'array' : typeof value);
  assert.ok(types.includes(actual), `${where}: type ${actual} not allowed (${types.join('|')})`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${where}: ${JSON.stringify(value)} not in enum`);
  if (actual === 'object') {
    assert.strictEqual(schema.additionalProperties, false, `${where}: schema must forbid extra properties`);
    for (const key of schema.required || []) {
      assert.ok(Object.prototype.hasOwnProperty.call(value, key), `${where}.${key} is required`);
    }
    for (const key of Object.keys(value)) {
      assert.ok(schema.properties && schema.properties[key], `${where}.${key} is not in the schema`);
      assertMatchesSchema(value[key], schema.properties[key], `${where}.${key}`);
    }
  }
  if (actual === 'array' && schema.items) {
    value.forEach((entry, index) => assertMatchesSchema(entry, schema.items, `${where}[${index}]`));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

(async () => {
  const db = initializeSchema();
  seedBase(db);

  try {
    // 0) The schema itself follows the spec rules, and the canned object fits it.
    const schema = extractionSchema();
    assert.strictEqual(schema.additionalProperties, false);
    assert.deepStrictEqual(Object.keys(schema.properties).sort(), schema.required.slice().sort(), 'every top-level property is required');
    const lineSchema = schema.properties.line_items.items;
    assert.deepStrictEqual(Object.keys(lineSchema.properties).sort(), lineSchema.required.slice().sort(), 'every line property is required');
    const forbidden = /"(minimum|maximum|minLength|pattern)"/;
    assert.ok(!forbidden.test(JSON.stringify(schema)), 'schema carries no numeric/string bounds');
    assertMatchesSchema(cannedExtraction(), schema);

    // 1) PDF extraction: request shape, persistence, totals_match, unit_price
    //    derivation, canonical types, needs_review rule, AI bill category rule.
    __resetForTests();
    const client1 = fakeClient([() => messageFor(cannedExtraction())]);
    addBill(db, { id: 'BILL-1', total: 1500 });
    const pdf1 = await makePdf();
    const att1 = addAttachment(db, { id: 'ATT-1', billId: 'BILL-1', bytes: pdf1, mime: 'application/pdf', filename: 'invoice.pdf' });

    const r1 = await extractOne(db, att1, { userId: ADMIN_ID });
    assert.equal(r1.status, 'extracted', `ATT-1 extracted (${r1.error})`);
    assert.equal(r1.attachment_id, 'ATT-1');
    assert.equal(r1.items, 5);
    assert.equal(r1.totals_match, 1);
    assert.equal(r1.totals_match_reason, null);
    assert.equal(r1.ai_bill_category, 'painting');
    assert.equal(r1.input_tokens, 1200);
    assert.equal(r1.output_tokens, 300);

    assert.equal(client1.requests.length, 1, 'one API call for a clean extraction');
    const req1 = client1.requests[0];
    assert.equal(req1.model, DEFAULT_MODEL);
    assert.equal(req1.max_tokens, 16000);
    assert.deepStrictEqual(req1.betas, [FALLBACK_BETA]);
    assert.deepStrictEqual(req1.fallbacks, [{ model: FALLBACK_MODEL }]);
    assert.equal(req1.output_config.effort, 'high');
    assert.equal(req1.output_config.format.type, 'json_schema');
    assert.deepStrictEqual(req1.output_config.format.schema, schema);
    assert.strictEqual(req1.thinking, undefined, 'thinking is not sent (adaptive default)');
    assert.strictEqual(req1.temperature, undefined, 'temperature is not sent');
    assert.ok(/untrusted/i.test(req1.system), 'system prompt carries the untrusted-data clause');
    assert.equal(req1.messages.length, 1);
    assert.equal(req1.messages[0].role, 'user');
    const content1 = req1.messages[0].content;
    assert.equal(content1[0].type, 'document');
    assert.equal(content1[0].source.type, 'base64');
    assert.equal(content1[0].source.media_type, 'application/pdf');
    assert.ok(!/\n/.test(content1[0].source.data), 'base64 has no newlines');
    assert.ok(Buffer.from(content1[0].source.data, 'base64').equals(pdf1), 'PDF bytes sent as-is');
    assert.equal(content1[1].type, 'text');
    assert.ok(content1[1].text.includes('BILL-1'), 'bill context names the bill');
    assert.ok(content1[1].text.includes(VENDOR_NAME), 'bill context names the vendor');
    assert.ok(content1[1].text.includes('Drywall (drywall)'), 'bill context carries the vendor category');

    const doc1 = docRow(db, 'ATT-1');
    assert.ok(doc1, 'documents row written');
    assert.equal(doc1.status, 'extracted');
    assert.equal(doc1.qbo_bill_id, 'BILL-1');
    assert.equal(doc1.content_hash, sha256(pdf1));
    assert.equal(doc1.duplicate_of, null);
    assert.deepStrictEqual(JSON.parse(doc1.bills_covered_json), ['BILL-1']);
    assert.equal(doc1.model, FAKE_MODEL);
    assert.equal(doc1.doc_type, 'invoice');
    assert.equal(doc1.vendor_on_document, VENDOR_NAME);
    assert.equal(doc1.document_date, '2026-03-10');
    assert.equal(doc1.document_total, 1500);
    assert.equal(doc1.totals_match, 1);
    assert.equal(doc1.totals_match_reason, null);
    assert.equal(doc1.labor_total, 500);
    assert.equal(doc1.material_total, 1000);
    assert.equal(doc1.suggested_category_id, 'painting');
    assert.equal(doc1.suggested_category_confidence, 0.9);
    assert.equal(doc1.confidence, 0.88);
    assert.equal(doc1.input_tokens, 1200);
    assert.equal(doc1.output_tokens, 300);
    assert.equal(doc1.attempts, 1, 'one attempt for a clean extraction');
    assert.equal(doc1.error, null);
    assert.ok(doc1.extracted_at, 'extracted_at set');
    assert.equal(doc1.claimed_by_run_id, null, 'direct call has no run');
    const unknowns1 = JSON.parse(doc1.unknowns_json);
    assert.ok(unknowns1.some(entry => entry.includes('drywall on rooms')), 'model unknowns persisted');
    assert.equal(JSON.parse(doc1.extracted_json).line_items.length, 5);

    const items1 = itemsFor(db, 'ATT-1');
    assert.equal(items1.length, 5);
    for (const item of items1) {
      assert.equal(item.source, 'ai');
      assert.equal(item.qbo_bill_id, 'BILL-1');
      assert.equal(item.qbo_class_id, CLASS_ID, 'single covering bill -> its class');
    }
    assert.equal(items1[0].item_kind, 'material');
    assert.equal(items1[0].material_family, 'drywall');
    assert.equal(items1[0].material_type, 'drywall_sheet', 'sheetrock -> canonical drywall_sheet');
    assert.equal(items1[0].material_type_raw, 'sheetrock 5/8');
    assert.equal(items1[0].spec, '5/8 in');
    assert.equal(items1[0].quantity, 40);
    assert.equal(items1[0].unit, 'sheet');
    assert.equal(items1[0].unit_price, 15, 'unit price derived from line_total / quantity');
    assert.equal(items1[0].line_total, 600);
    assert.equal(items1[0].pricing_basis, 'unit');
    assert.equal(items1[0].needs_review, 0);
    assert.equal(items1[1].material_type, 'laminate_countertop', 'Formica -> laminate_countertop');
    assert.equal(items1[1].unit_price, 400);
    assert.equal(items1[1].pricing_basis, 'unit');
    assert.equal(items1[2].item_kind, 'labor');
    assert.equal(items1[2].material_type, 'drywall_finish');
    assert.equal(items1[2].phase, 'install');
    assert.equal(items1[2].unit, 'lot');
    assert.equal(items1[2].unit_price, null);
    assert.equal(items1[2].pricing_basis, 'job', 'lot lines are job-priced');
    assert.equal(items1[2].needs_review, 0, 'a lump sum with an amount needs no review');
    assert.equal(items1[3].line_total, null);
    assert.equal(items1[3].unit, null, '"other" with no quantity means nothing was printed');
    assert.equal(items1[3].pricing_basis, 'job');
    assert.equal(items1[3].needs_review, 1, 'a line without an amount needs review');
    assert.equal(items1[3].review_reason, 'no amount on document');
    assert.equal(items1[4].item_kind, 'credit', 'negative amount re-labelled as credit');
    assert.equal(items1[4].line_total, -50, 'credit amount kept, not clamped');
    assert.equal(items1[4].needs_review, 0);

    const cat1 = billCategory(db, 'BILL-1');
    assert.ok(cat1, 'AI bill category written (confidence 0.9, invoice, differs from vendor category)');
    assert.equal(cat1.category_id, 'painting');
    assert.equal(cat1.source, 'ai');
    assert.equal(cat1.confidence, 0.9);
    assert.ok(String(cat1.rationale).startsWith('Read from attached invoice'), 'rationale names the document');

    // 2) JPEG extraction: image block, totals mismatch with a half-payment note ->
    //    partial_payment; low-confidence suggestion writes no bill category.
    const client2 = fakeClient([() => messageFor(cannedExtraction({
      document_total: 1600,
      suggested_category_confidence: 0.5,
      line_items: [lineItem({ description: 'Drywall - half payment', item_kind: 'labor', material_family: 'drywall', unit: 'lot', line_total: 1600 })],
      unknowns: [],
    }))]);
    addBill(db, { id: 'BILL-2', total: 800, note: 'half payment for drywall' });
    const jpeg1 = await makeJpeg();
    const att2 = addAttachment(db, { id: 'ATT-2', billId: 'BILL-2', bytes: jpeg1, mime: 'image/jpeg', filename: 'photo.jpg' });

    const r2 = await extractOne(db, att2, { userId: ADMIN_ID });
    assert.equal(r2.status, 'extracted', `ATT-2 extracted (${r2.error})`);
    assert.equal(r2.totals_match, 0);
    assert.equal(r2.totals_match_reason, 'partial_payment');
    assert.equal(r2.ai_bill_category, null, 'confidence 0.5 is below the 0.7 rule');
    assert.equal(client2.requests.length, 1);
    const content2 = client2.requests[0].messages[0].content;
    assert.equal(content2[0].type, 'image');
    assert.equal(content2[0].source.media_type, 'image/jpeg');
    assert.ok(content2[0].source.data.length > 0);
    assert.ok(content2[1].text.includes('half payment for drywall'), 'private note in the bill context');
    const doc2 = docRow(db, 'ATT-2');
    assert.equal(doc2.status, 'extracted');
    assert.equal(doc2.content_hash, sha256(jpeg1));
    assert.equal(doc2.document_total, 1600);
    assert.equal(doc2.totals_match, 0);
    assert.equal(doc2.totals_match_reason, 'partial_payment');
    assert.equal(itemsFor(db, 'ATT-2').length, 1);
    assert.equal(billCategory(db, 'BILL-2'), null, 'no AI bill category below the confidence rule');

    // 3) Same bytes on another bill -> duplicate, no items, no API call.
    addBill(db, { id: 'BILL-3', total: 800, note: 'half payment 2 of 2' });
    const att3 = addAttachment(db, { id: 'ATT-3', billId: 'BILL-3', bytes: jpeg1, mime: 'image/jpeg', filename: 'photo.jpg' });
    const r3 = await extractOne(db, att3, { userId: ADMIN_ID });
    assert.equal(r3.status, 'duplicate', `ATT-3 duplicate (${r3.error})`);
    assert.equal(client2.requests.length, 1, 'a duplicate is never sent to the model');
    const doc3 = docRow(db, 'ATT-3');
    assert.equal(doc3.status, 'duplicate');
    assert.equal(doc3.duplicate_of, 'ATT-2');
    assert.equal(doc3.content_hash, sha256(jpeg1));
    assert.deepStrictEqual(JSON.parse(doc3.bills_covered_json).sort(), ['BILL-2', 'BILL-3'], 'both bills sharing the file are recorded');
    assert.equal(itemsFor(db, 'ATT-3').length, 0, 'duplicates hold no items');

    // 4) text/plain Intuit stub -> skipped by magic bytes, never read, never sent.
    addBill(db, { id: 'BILL-4', total: 250 });
    const stubBytes = Buffer.from(TEXT_STUB, 'utf8');
    const att4 = addAttachment(db, { id: 'ATT-4', billId: 'BILL-4', bytes: stubBytes, mime: 'text/plain', filename: 'download.pdf' });
    const r4 = await extractOne(db, att4, { userId: ADMIN_ID });
    assert.equal(r4.status, 'skipped');
    assert.ok(r4.error.includes('not a PDF or image (stored mime text/plain)'), `stub skip reason: ${r4.error}`);
    assert.ok(r4.error.includes('re-download from QuickBooks'));
    assert.ok(!r4.error.includes(SECRET_MARKER), 'stub contents never reach the error');
    assert.equal(client2.requests.length, 1, 'a text stub is never sent to the model');
    const doc4 = docRow(db, 'ATT-4');
    assert.equal(doc4.status, 'skipped');
    assert.equal(doc4.content_hash, null, 'stub bytes were never hashed (never read past the magic bytes)');
    assert.ok(!String(doc4.error).includes(SECRET_MARKER));
    assert.equal(itemsFor(db, 'ATT-4').length, 0);

    // 5) A bill outside the section 4.1 scope is skipped before any file access.
    addBill(db, { id: 'BILL-5', total: 900, status: 'deleted_from_buildtrack' });
    const att5 = addAttachment(db, { id: 'ATT-5', billId: 'BILL-5', bytes: await makePdf(), mime: 'application/pdf', filename: 'invoice.pdf' });
    const r5 = await extractOne(db, att5, { userId: ADMIN_ID });
    assert.equal(r5.status, 'skipped');
    assert.equal(r5.error, 'bill deleted or excluded');
    assert.equal(docRow(db, 'ATT-5').status, 'skipped');
    assert.equal(client2.requests.length, 1);

    // 6) 400 naming the fallback beta -> retry once without betas/fallbacks and
    //    remember it for the process; same-as-vendor suggestion writes no category.
    __resetForTests();
    assert.equal(getRuntimeFlags().fallbacksDisabled, false);
    const client6 = fakeClient([
      () => { throw sdkError('BadRequestError', 400, 'invalid_request_error', 'Unexpected value(s) for the anthropic-beta header: server-side-fallback-2026-06-01 (fallbacks)'); },
      () => messageFor(cannedExtraction({ suggested_category: 'drywall', suggested_category_confidence: 0.95 })),
    ]);
    addBill(db, { id: 'BILL-6', total: 1500 });
    const att6 = addAttachment(db, { id: 'ATT-6', billId: 'BILL-6', bytes: await makePdf(), mime: 'application/pdf', filename: 'invoice.pdf' });
    const r6 = await extractOne(db, att6, { userId: ADMIN_ID });
    assert.equal(r6.status, 'extracted', `ATT-6 extracted after fallback retry (${r6.error})`);
    assert.equal(getRuntimeFlags().fallbacksDisabled, true, 'fallbacksDisabled flag set');
    assert.equal(client6.requests.length, 2);
    assert.deepStrictEqual(client6.requests[0].betas, [FALLBACK_BETA]);
    assert.strictEqual(client6.requests[1].betas, undefined, 'retry sends no betas');
    assert.strictEqual(client6.requests[1].fallbacks, undefined, 'retry sends no fallbacks');
    assert.equal(docRow(db, 'ATT-6').attempts, 2, 'claim + one retry');
    assert.equal(billCategory(db, 'BILL-6'), null, 'suggestion equal to the vendor category is not written');

    // 7) 400 naming effort -> retry once without output_config.effort.
    __resetForTests();
    const client7 = fakeClient([
      () => { throw sdkError('BadRequestError', 400, 'invalid_request_error', 'effort: Extra inputs are not permitted'); },
      () => messageFor(cannedExtraction({ doc_type: 'estimate' })),
    ]);
    addBill(db, { id: 'BILL-7', total: 1500 });
    const att7 = addAttachment(db, { id: 'ATT-7', billId: 'BILL-7', bytes: await makePdf(), mime: 'application/pdf', filename: 'estimate.pdf' });
    const r7 = await extractOne(db, att7, { userId: ADMIN_ID });
    assert.equal(r7.status, 'extracted', `ATT-7 extracted after effort retry (${r7.error})`);
    assert.equal(getRuntimeFlags().effortDisabled, true);
    assert.equal(client7.requests.length, 2);
    assert.equal(client7.requests[0].output_config.effort, 'high');
    assert.strictEqual(client7.requests[1].output_config.effort, undefined, 'retry sends no effort');
    assert.equal(client7.requests[1].output_config.format.type, 'json_schema', 'schema still sent');
    assert.equal(billCategory(db, 'BILL-7'), null, 'an estimate never writes an AI bill category');

    // 8) 400 rejecting the schema itself -> failed and the run must abort.
    __resetForTests();
    const client8 = fakeClient([
      () => { throw sdkError('BadRequestError', 400, 'invalid_request_error', 'output_config.format: json_schema is not supported for this model'); },
    ]);
    addBill(db, { id: 'BILL-8', total: 1500 });
    const att8 = addAttachment(db, { id: 'ATT-8', billId: 'BILL-8', bytes: await makePdf(), mime: 'application/pdf', filename: 'invoice.pdf' });
    const r8 = await extractOne(db, att8, { userId: ADMIN_ID });
    assert.equal(r8.status, 'failed');
    assert.equal(r8.abort_run, true, 'schema rejection aborts the run');
    assert.ok(String(r8.error).startsWith('schema rejected:'), `error: ${r8.error}`);
    assert.equal(client8.requests.length, 1, 'no retry on a schema rejection');
    const doc8 = docRow(db, 'ATT-8');
    assert.equal(doc8.status, 'failed');
    assert.ok(String(doc8.error).startsWith('schema rejected:'));

    // 9) RateLimitError once, then success -> attempts 2, extracted.
    __resetForTests();
    __setBackoffForTests([0, 0, 0]);
    const client9 = fakeClient([
      () => { throw sdkError('RateLimitError', 429, 'rate_limit_error', 'x'); },
      () => messageFor(cannedExtraction()),
    ]);
    addBill(db, { id: 'BILL-9', total: 1500 });
    const att9 = addAttachment(db, { id: 'ATT-9', billId: 'BILL-9', bytes: await makePdf(), mime: 'application/pdf', filename: 'invoice.pdf' });
    const r9 = await extractOne(db, att9, { userId: ADMIN_ID });
    assert.equal(r9.status, 'extracted', `ATT-9 extracted after rate limit (${r9.error})`);
    assert.equal(client9.requests.length, 2);
    const doc9 = docRow(db, 'ATT-9');
    assert.equal(doc9.status, 'extracted');
    assert.equal(doc9.attempts, 2, 'rate-limited attempt counted');
    assert.equal(doc9.input_tokens, 1200, 'only the successful attempt carried usage');
    assert.equal(itemsFor(db, 'ATT-9').length, 5);

    // 10) 404 for the model -> switch this process to the fallback model, retry once.
    __resetForTests();
    const client10 = fakeClient([
      () => { throw sdkError('NotFoundError', 404, 'not_found_error', `model: ${DEFAULT_MODEL} not found`); },
      () => messageFor(cannedExtraction()),
    ]);
    addBill(db, { id: 'BILL-10', total: 1500 });
    const att10 = addAttachment(db, { id: 'ATT-10', billId: 'BILL-10', bytes: await makePdf(), mime: 'application/pdf', filename: 'invoice.pdf' });
    const r10 = await extractOne(db, att10, { userId: ADMIN_ID });
    assert.equal(r10.status, 'extracted', `ATT-10 extracted on the fallback model (${r10.error})`);
    assert.equal(getRuntimeFlags().activeModel, FALLBACK_MODEL);
    assert.equal(client10.requests.length, 2);
    assert.equal(client10.requests[1].model, FALLBACK_MODEL);
    assert.strictEqual(client10.requests[1].betas, undefined, 'no server-side fallback when already on the fallback model');
    assert.equal(docRow(db, 'ATT-10').attempts, 2);
    __resetForTests();
    assert.equal(getRuntimeFlags().activeModel, DEFAULT_MODEL, '__resetForTests restores the primary model');

    // 11) stop_reason max_tokens -> retry once with max_tokens 32000.
    const client11 = fakeClient([
      () => messageFor(cannedExtraction(), { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"doc_type":"invoice"' }] }),
      () => messageFor(cannedExtraction()),
    ]);
    addBill(db, { id: 'BILL-11', total: 1500 });
    const att11 = addAttachment(db, { id: 'ATT-11', billId: 'BILL-11', bytes: await makePdf(), mime: 'application/pdf', filename: 'invoice.pdf' });
    const r11 = await extractOne(db, att11, { userId: ADMIN_ID });
    assert.equal(r11.status, 'extracted', `ATT-11 extracted after max_tokens retry (${r11.error})`);
    assert.equal(client11.requests.length, 2);
    assert.equal(client11.requests[0].max_tokens, 16000);
    assert.equal(client11.requests[1].max_tokens, 32000);
    const doc11 = docRow(db, 'ATT-11');
    assert.equal(doc11.attempts, 2);
    assert.equal(doc11.input_tokens, 2400, 'token usage is summed over both attempts');

    // 12) stop_reason refusal -> unreadable with the stop_details, tokens recorded.
    __resetForTests();
    const client12 = fakeClient([
      () => messageFor(cannedExtraction(), { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'unsafe_content', explanation: 'cannot read this' }, content: [] }),
    ]);
    addBill(db, { id: 'BILL-12', total: 1500 });
    const att12 = addAttachment(db, { id: 'ATT-12', billId: 'BILL-12', bytes: await makePdf(), mime: 'application/pdf', filename: 'invoice.pdf' });
    const r12 = await extractOne(db, att12, { userId: ADMIN_ID });
    assert.equal(r12.status, 'unreadable');
    assert.ok(/declined/.test(r12.error), `refusal error: ${r12.error}`);
    assert.ok(r12.error.includes('unsafe_content'), 'stop_details category surfaced');
    assert.equal(client12.requests.length, 1, 'no retry on a refusal');
    const doc12 = docRow(db, 'ATT-12');
    assert.equal(doc12.status, 'unreadable');
    assert.equal(doc12.model, FAKE_MODEL);
    assert.equal(doc12.input_tokens, 1200);
    assert.equal(itemsFor(db, 'ATT-12').length, 0);

    // 13) Output that is not a JSON object twice -> failed after one retry with
    //     the "Return only the JSON object." system line.
    __resetForTests();
    const client13 = fakeClient([
      () => messageFor(cannedExtraction(), { content: [{ type: 'text', text: 'Sure! Here is the data you asked for.' }] }),
      () => messageFor(cannedExtraction(), { content: [{ type: 'text', text: 'still not json' }] }),
    ]);
    addBill(db, { id: 'BILL-13', total: 1500 });
    const att13 = addAttachment(db, { id: 'ATT-13', billId: 'BILL-13', bytes: await makePdf(), mime: 'application/pdf', filename: 'invoice.pdf' });
    const r13 = await extractOne(db, att13, { userId: ADMIN_ID });
    assert.equal(r13.status, 'failed');
    assert.equal(r13.abort_run, false);
    assert.equal(r13.error, 'model returned invalid JSON', 'model output is never echoed into the error');
    assert.equal(client13.requests.length, 2);
    assert.ok(client13.requests[1].system.endsWith('Return only the JSON object.'), 'parse retry adds the extra system line');
    assert.ok(!client13.requests[0].system.includes('Return only the JSON object.'));
    assert.equal(docRow(db, 'ATT-13').attempts, 2);
    assert.equal(docRow(db, 'ATT-13').status, 'failed');

    // 14) Pure building blocks.
    assert.deepStrictEqual(detectFileType(Buffer.from('%PDF-1.4\n%abc', 'latin1')), { kind: 'pdf', mediaType: 'application/pdf' });
    assert.deepStrictEqual(detectFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])), { kind: 'image', mediaType: 'image/jpeg' });
    assert.deepStrictEqual(detectFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), { kind: 'image', mediaType: 'image/png' });
    assert.deepStrictEqual(detectFileType(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1')), { kind: 'image', mediaType: 'image/webp' });
    assert.strictEqual(detectFileType(Buffer.from(TEXT_STUB, 'utf8').subarray(0, 12)), null, 'an https:// stub is not a document');
    assert.strictEqual(detectFileType(Buffer.alloc(0)), null);

    assert.deepStrictEqual(computeTotalsMatch(1500, [{ total_amt: 1500, private_note: null }]), { totals_match: 1, totals_match_reason: null });
    assert.deepStrictEqual(computeTotalsMatch(1500.75, [{ total_amt: 1500, private_note: null }]), { totals_match: 1, totals_match_reason: null }, 'within $1 counts as a match');
    assert.deepStrictEqual(computeTotalsMatch(1600, [{ total_amt: 800, private_note: 'deposit' }]), { totals_match: 0, totals_match_reason: 'partial_payment' });
    assert.deepStrictEqual(computeTotalsMatch(1600, [{ total_amt: 800, private_note: 'materials' }]), { totals_match: 0, totals_match_reason: null }, 'no partial-payment wording -> plain mismatch');
    assert.deepStrictEqual(computeTotalsMatch(500, [{ total_amt: 800, private_note: 'deposit' }]), { totals_match: 0, totals_match_reason: null }, 'partial_payment needs document total > bill total');
    assert.deepStrictEqual(computeTotalsMatch(null, [{ total_amt: 800, private_note: null }]), { totals_match: null, totals_match_reason: null });

    const classes = [{ id: 'C-MAIN', name: '123 Main St' }, { id: 'C-OAK', name: '456 Oak Ave' }];
    assert.equal(matchClassForLocation(classes, 'kitchen at 456 Oak').id, 'C-OAK');
    assert.equal(matchClassForLocation(classes, 'basement', '123 Main').id, 'C-MAIN');
    assert.strictEqual(matchClassForLocation(classes, '123 Main and 456 Oak'), null, 'a tie resolves to no class');
    assert.strictEqual(matchClassForLocation(classes, 'no address here'), null);
    assert.strictEqual(matchClassForLocation(classes, null, undefined), null);

    const normalized = normalizeExtraction({
      doc_type: 'bogus', document_total: -20, confidence: 7, suggested_category: 'painting', suggested_category_confidence: -1,
      line_items: [{ description: 'x', item_kind: 'nope', material_family: 'nope', unit: 'nope', quantity: 2, line_total: 30, confidence: 4 }],
      unknowns: ['  needs   trimming  ', ''],
    });
    assert.equal(normalized.doc_type, 'other', 'unknown doc_type falls back to other');
    assert.strictEqual(normalized.document_total, null, 'negative money stored as null');
    assert.ok(normalized.unknowns.some(entry => entry.startsWith('negative document total')), 'negative money reported as an unknown');
    assert.ok(normalized.unknowns.includes('needs trimming'), 'unknown text is cleaned');
    assert.equal(normalized.confidence, 1, 'confidence clamped to 1');
    assert.equal(normalized.suggested_category_confidence, 0, 'confidence clamped to 0');
    assert.equal(normalized.suggested_category_id, 'painting');
    assert.equal(normalized.line_items[0].item_kind, 'other');
    assert.strictEqual(normalized.line_items[0].material_family, null);
    assert.strictEqual(normalized.line_items[0].unit, null);
    assert.equal(normalized.line_items[0].pricing_basis, 'job', 'no valid unit -> job basis');
    assert.equal(normalized.line_items[0].unit_price, 15, 'unit price still derived from the quantity');
    assert.equal(normalized.line_items[0].confidence, 1);

    // 15) Scan run bookkeeping: startScan(scope pending) over freshly enqueued
    //     rows, polled through getScanStatus(); done/failed/skipped counts.
    __resetForTests();
    const scanClient = fakeClient(() => messageFor(cannedExtraction()));
    addBill(db, { id: 'BILL-20', total: 1500 });
    // A manual override already on the bill: the AI suggestion must not replace it.
    db.prepare(`INSERT INTO cost_analyzer_bill_categories (qbo_bill_id, category_id, source, set_by) VALUES ('BILL-20', 'roofing', 'manual', ?)`).run(ADMIN_ID);
    addBill(db, { id: 'BILL-21', total: 1500 });
    addBill(db, { id: 'BILL-22', total: 300 });
    addBill(db, { id: 'BILL-23', total: 300 });
    addAttachment(db, { id: 'ATT-20', billId: 'BILL-20', bytes: await makePdf(), mime: 'application/pdf', filename: 'invoice.pdf' });
    addAttachment(db, { id: 'ATT-21', billId: 'BILL-21', bytes: await makeJpeg(), mime: 'image/jpeg', filename: 'photo.jpeg' });
    addAttachment(db, { id: 'ATT-22', billId: 'BILL-22', bytes: stubBytes, mime: 'text/plain', filename: 'download.jpeg' });
    addAttachment(db, { id: 'ATT-23', billId: 'BILL-23', bytes: Buffer.from('%PDF-1.4 never written', 'latin1'), mime: 'application/pdf', filename: 'missing.pdf', skipFile: true });

    assert.equal(enqueueNewDocuments(db).inserted, 4, 'four attachments had no documents row');
    assert.equal(enqueueNewDocuments(db).inserted, 0, 'enqueue is idempotent');
    assert.equal(getScanStatus().counts.pending, 4);
    assert.equal(getScanStatus().active, false);

    const badScope = await startScan({ scope: 'everything', userId: ADMIN_ID });
    assert.equal(badScope.status, 400, 'unknown scope rejected');
    assert.ok(badScope.error);

    const run1 = await startScan({ scope: 'pending', userId: ADMIN_ID, concurrency: 2 });
    assert.ok(run1 && run1.id && !run1.error, `scan started (${run1 && run1.error})`);
    assert.equal(run1.status, 'running');
    assert.equal(run1.scope, 'pending');
    assert.equal(run1.total, 4);
    assert.equal(run1.started_by, ADMIN_ID);
    assert.ok(run1.heartbeat_at, 'heartbeat written at start');
    const live = getScanStatus();
    assert.equal(live.active, true);
    assert.equal(live.in_process, true);
    assert.equal(live.run.id, run1.id);

    const second = await startScan({ scope: 'pending', userId: ADMIN_ID });
    assert.equal(second.status, 409, 'a second scan while one runs is refused');
    assert.equal(second.run_id, run1.id);

    const finished1 = await waitForRun(db, run1.id);
    assert.equal(finished1.status, 'completed', `run error: ${finished1.error}`);
    assert.equal(finished1.total, 4);
    assert.equal(finished1.done, 2, 'two documents extracted');
    assert.equal(finished1.failed, 0);
    assert.equal(finished1.skipped, 2, 'text stub + missing file skipped');
    assert.equal(finished1.input_tokens, 2400);
    assert.equal(finished1.output_tokens, 600);
    assert.equal(finished1.error, null);
    assert.ok(finished1.finished_at, 'finished_at set');
    assert.equal(scanClient.requests.length, 2, 'only the two real documents were sent');

    assert.equal(docRow(db, 'ATT-20').status, 'extracted');
    assert.equal(docRow(db, 'ATT-20').claimed_by_run_id, run1.id, 'document remembers its run');
    assert.equal(docRow(db, 'ATT-21').status, 'extracted');
    assert.equal(docRow(db, 'ATT-22').status, 'skipped');
    assert.ok(docRow(db, 'ATT-22').error.includes('not a PDF or image (stored mime text/plain)'));
    assert.equal(docRow(db, 'ATT-23').status, 'skipped');
    assert.equal(docRow(db, 'ATT-23').error, 'file missing');
    assert.equal(itemsFor(db, 'ATT-20').length, 5);
    assert.equal(itemsFor(db, 'ATT-21').length, 5);
    const manual20 = billCategory(db, 'BILL-20');
    assert.equal(manual20.category_id, 'roofing', 'manual bill category survives the AI suggestion');
    assert.equal(manual20.source, 'manual');
    const ai21 = billCategory(db, 'BILL-21');
    assert.ok(ai21 && ai21.source === 'ai' && ai21.category_id === 'painting', 'AI bill category written during the scan');

    const afterScan = getScanStatus();
    assert.equal(afterScan.active, false);
    assert.equal(afterScan.in_process, false);
    assert.equal(afterScan.run.id, run1.id, 'most recent run reported once finished');
    assert.equal(afterScan.run.status, 'completed');
    const statusCounts = db.prepare('SELECT status, COUNT(*) AS n FROM cost_analyzer_documents GROUP BY status').all();
    const totalDocs = statusCounts.reduce((sum, row) => sum + row.n, 0);
    assert.equal(afterScan.counts.total, totalDocs);
    for (const row of statusCounts) {
      assert.equal(afterScan.counts[row.status], row.n, `count for ${row.status}`);
    }
    assert.equal(afterScan.counts.pending, 0);
    assert.equal(afterScan.counts.running, 0);

    // Nothing pending -> a completed run with total 0, no API call.
    const emptyRun = await startScan({ scope: 'pending', userId: ADMIN_ID });
    assert.ok(emptyRun && !emptyRun.error, 'empty scan is not an error');
    assert.equal(emptyRun.status, 'completed');
    assert.equal(emptyRun.total, 0);
    assert.equal(scanClient.requests.length, 2);

    // 16) Scope 'failed' re-runs failed documents only (ATT-8 schema-rejected,
    //     ATT-13 invalid JSON); ATT-12 (unreadable) is left alone.
    const failedBefore = db.prepare("SELECT attachment_id FROM cost_analyzer_documents WHERE status = 'failed' ORDER BY attachment_id").all().map(row => row.attachment_id);
    assert.deepStrictEqual(failedBefore, ['ATT-13', 'ATT-8']);
    const runFailed = await startScan({ scope: 'failed', userId: ADMIN_ID, concurrency: 1 });
    assert.ok(runFailed && !runFailed.error, `failed-scope scan started (${runFailed && runFailed.error})`);
    assert.equal(runFailed.total, 2);
    const finishedFailed = await waitForRun(db, runFailed.id);
    assert.equal(finishedFailed.status, 'completed');
    assert.equal(finishedFailed.done, 2);
    assert.equal(finishedFailed.failed, 0);
    assert.equal(docRow(db, 'ATT-8').status, 'extracted');
    assert.equal(docRow(db, 'ATT-13').status, 'extracted');
    assert.equal(docRow(db, 'ATT-12').status, 'unreadable', 'unreadable is not retried by the failed scope');
    assert.equal(docRow(db, 'ATT-8').attempts, 2, 'attempts keep counting across runs');

    // 17) Scope 'selected' re-reads the named documents (unknown ids ignored)
    //     and replaces the previous AI items.
    const runSelected = await startScan({ scope: 'selected', attachmentIds: ['ATT-1', 'does-not-exist'], userId: ADMIN_ID });
    assert.ok(runSelected && !runSelected.error, `selected scan started (${runSelected && runSelected.error})`);
    assert.equal(runSelected.total, 1, 'only existing ids are selected');
    const finishedSelected = await waitForRun(db, runSelected.id);
    assert.equal(finishedSelected.status, 'completed');
    assert.equal(finishedSelected.done, 1);
    assert.equal(docRow(db, 'ATT-1').status, 'extracted');
    assert.equal(docRow(db, 'ATT-1').claimed_by_run_id, runSelected.id);
    assert.equal(itemsFor(db, 'ATT-1').length, 5, 'items replaced, not duplicated');

    // 18) cancelScan(): the in-flight document finishes, nothing new is claimed.
    let release = null;
    const gate = new Promise(resolve => { release = resolve; });
    const slowClient = fakeClient(async () => { await gate; return messageFor(cannedExtraction()); });
    addBill(db, { id: 'BILL-24', total: 1500 });
    addAttachment(db, { id: 'ATT-24', billId: 'BILL-24', bytes: await makePdf(), mime: 'application/pdf', filename: 'invoice.pdf' });
    const run3 = await startScan({ scope: 'pending', userId: ADMIN_ID, concurrency: 1 });
    assert.ok(run3 && !run3.error, `cancel-test scan started (${run3 && run3.error})`);
    assert.equal(run3.status, 'running');
    assert.equal(run3.total, 1);
    const cancel = cancelScan();
    assert.equal(cancel.ok, true);
    assert.equal(cancel.run_id, run3.id);
    assert.equal(cancel.cancelling, true);
    release();
    const finished3 = await waitForRun(db, run3.id);
    assert.equal(finished3.status, 'cancelled');
    assert.equal(finished3.done, 1, 'the in-flight document still finished');
    assert.equal(docRow(db, 'ATT-24').status, 'extracted');
    assert.equal(slowClient.requests.length, 1);
    const noRun = cancelScan();
    assert.equal(noRun.status, 404, 'cancel with no live run is a 404-style error');
    assert.ok(noRun.error);

    // 19) The stub credential never reached any request sent to the fake model.
    for (const client of allClients) {
      assert.ok(!JSON.stringify(client.requests).includes(SECRET_MARKER), 'stub contents never reach a model request');
    }
    const leakedRows = db.prepare('SELECT COUNT(*) AS c FROM cost_analyzer_documents WHERE error LIKE ? OR extracted_json LIKE ? OR unknowns_json LIKE ?')
      .get(`%${SECRET_MARKER}%`, `%${SECRET_MARKER}%`, `%${SECRET_MARKER}%`).c;
    assert.equal(leakedRows, 0, 'stub contents never reach the documents table');

    console.log('Cost Analyzer extraction tests passed');
  } finally {
    __resetForTests();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
