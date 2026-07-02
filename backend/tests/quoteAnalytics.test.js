// Tests for the quote analytics router, focused on the additive bid-leveling
// /compare endpoint plus the create/list/approve/deny flows the new global Quote
// Center depends on. Uses Node's built-in assert + better-sqlite3 against a temp DB
// and mounts the real Express router (same convention as agentBridge.test.js).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildtrack-quotes-'));
process.env.DB_PATH = path.join(tempDir, 'buildtrack-test.db');
process.env.JWT_SECRET = 'quote-analytics-test-secret';

const { initializeSchema, getDb } = require('../src/db/schema');
const quoteAnalyticsRoutes = require('../src/routes/quoteAnalytics');

const ADMIN_ID = 'admin-user';
const CONTRACTOR_ID = 'contractor-user';
const PM_ID = 'pm-user';
const PROJECT_ID = 'project-bid-1';

function seed() {
  const db = initializeSchema();
  db.prepare(`INSERT INTO users (id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(ADMIN_ID, 'Admin User', 'admin@example.test', 'hash', 'super_admin');
  db.prepare(`INSERT INTO users (id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(CONTRACTOR_ID, 'Field Contractor', 'contractor@example.test', 'hash', 'contractor');
  db.prepare(`INSERT INTO users (id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(PM_ID, 'Project Manager', 'pm@example.test', 'hash', 'project_manager');
  db.prepare(`INSERT INTO projects (id, address, job_name, status, budget, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(PROJECT_ID, '123 Main Street, Detroit, MI', '123 Main Rehab', 'active_rehab', 25000, ADMIN_ID);

  // Standardized categories (INSERT OR IGNORE in case the schema already seeds them).
  for (const [name, group] of [['Electrical', 'Trade'], ['Plumbing', 'Trade'], ['Painting', 'Finishes']]) {
    db.prepare(`INSERT OR IGNORE INTO quote_categories (id, category_group, name, normalized_key, sort_order, is_active)
                VALUES (?, ?, ?, ?, 0, 1)`)
      .run(`cat-${name.toLowerCase()}`, group, name, name.toLowerCase());
  }
  return db;
}

function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/quote-analytics', quoteAnalyticsRoutes.analyticsRouter);
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}/api/quote-analytics` }));
  });
}

function tokenFor(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET);
}

async function call(baseUrl, pathName, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) { json = null; }
  return { status: res.status, json };
}

(async () => {
  const db = seed();
  const { server, baseUrl } = await startApp();
  const adminToken = tokenFor(ADMIN_ID);
  const contractorToken = tokenFor(CONTRACTOR_ID);

  try {
    // 1) Create quote A (submitted) with auto-calc line total (qty x unit price).
    let res = await call(baseUrl, '/quotes', {
      method: 'POST', token: adminToken,
      body: {
        project_id: PROJECT_ID, contractor_name: 'ABC Electric', contractor_company: 'ABC Electric LLC',
        quote_date: '2026-06-01', status: 'submitted', scope_description: 'Electrical + plumbing rough-in',
        line_items: [
          { category: 'Electrical', description: 'Panel + rough-in', quantity: 2, unit_price: 500 }, // -> 1000 auto
          { category: 'Plumbing', description: 'Supply lines', total_line_item_price: 500 },
        ],
      },
    });
    assert.equal(res.status, 201, 'create quote A should return 201');
    const quoteA = res.json.quote;
    const linesA = res.json.line_items;
    const electricalA = linesA.find(l => l.category === 'Electrical');
    assert.equal(electricalA.total_line_item_price, 1000, 'line total should auto-calc qty*unit_price');
    assert.equal(quoteA.total_quote_amount, 1500, 'quote total should sum line items');
    assert.equal(quoteA.status, 'submitted');

    // 2) Create quote B (submitted) for the same project — overlaps Electrical, adds Painting, omits Plumbing.
    res = await call(baseUrl, '/quotes', {
      method: 'POST', token: adminToken,
      body: {
        project_id: PROJECT_ID, contractor_name: 'Metro Electrical', contractor_company: 'Metro Electrical Inc',
        quote_date: '2026-06-03', status: 'submitted', scope_description: 'Electrical + paint',
        line_items: [
          { category: 'Electrical', description: 'Panel upgrade', total_line_item_price: 1200 },
          { category: 'Painting', description: 'Whole interior', total_line_item_price: 300 },
        ],
      },
    });
    assert.equal(res.status, 201, 'create quote B should return 201');
    const quoteB = res.json.quote;
    assert.equal(quoteB.total_quote_amount, 1500);

    // 3) Bid leveling /compare — normalized rows, min/max/avg, missing flags, originals preserved.
    res = await call(baseUrl, `/compare?project_id=${PROJECT_ID}`, { token: adminToken });
    assert.equal(res.status, 200, 'compare should return 200');
    const compare = res.json;
    assert.equal(compare.contractors.length, 2, 'two contractors compared');
    const electricalRow = compare.rows.find(r => r.category === 'Electrical');
    assert.ok(electricalRow, 'electrical row present');
    assert.equal(electricalRow.low, 1000, 'electrical low = 1000');
    assert.equal(electricalRow.high, 1200, 'electrical high = 1200');
    assert.equal(electricalRow.average, 1100, 'electrical avg = 1100');
    assert.equal(electricalRow.has_missing, false, 'both contractors quoted electrical');

    const plumbingRow = compare.rows.find(r => r.category === 'Plumbing');
    assert.equal(plumbingRow.has_missing, true, 'plumbing missing from one contractor');
    assert.equal(plumbingRow.missing_quote_ids.length, 1, 'exactly one contractor missing plumbing');
    assert.equal(plumbingRow.cells[quoteB.id].present, false, 'quote B has no plumbing');
    assert.equal(plumbingRow.cells[quoteA.id].present, true, 'quote A has plumbing');

    assert.equal(compare.totals.by_quote[quoteA.id], 1500);
    assert.equal(compare.totals.by_quote[quoteB.id], 1500);
    assert.equal(compare.totals.low, 1500);

    // 4) Filtering by status / quote_filter.
    res = await call(baseUrl, '/quotes?quote_filter=review', { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.json.total, 2, 'two submitted quotes in review');

    res = await call(baseUrl, '/quotes?quote_filter=approved', { token: adminToken });
    assert.equal(res.json.total, 0, 'no approved quotes yet');

    // 5) Approve quote A with an internal approved amount — original is NOT overwritten.
    res = await call(baseUrl, `/quotes/${quoteA.id}/approve`, {
      method: 'POST', token: adminToken, body: { final_approved_amount: 1400, review_note: 'Negotiated down' },
    });
    assert.equal(res.status, 200, 'approve should return 200');
    assert.equal(res.json.quote.status, 'approved');
    assert.equal(res.json.quote.final_approved_amount, 1400, 'approved amount stored');
    assert.equal(res.json.quote.total_quote_amount, 1500, 'ORIGINAL total preserved after approval');

    // Original line items unchanged in DB.
    const dbTotalA = db.prepare('SELECT total_quote_amount FROM contractor_quotes WHERE id = ?').get(quoteA.id).total_quote_amount;
    assert.equal(dbTotalA, 1500, 'original quote total unchanged in DB');

    // Audit trail written.
    const historical = db.prepare("SELECT COUNT(*) AS c FROM historical_quote_records WHERE quote_id = ? AND action = 'approved'").get(quoteA.id).c;
    assert.equal(historical, 1, 'historical approval snapshot recorded');
    const activity = db.prepare("SELECT COUNT(*) AS c FROM activity_log WHERE action = 'quote_approved' AND entity_id = ?").get(quoteA.id).c;
    assert.equal(activity, 1, 'activity log records quote approval');

    // 6) Deny quote B.
    res = await call(baseUrl, `/quotes/${quoteB.id}/deny`, { method: 'POST', token: adminToken, body: { review_note: 'Out of scope' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.quote.status, 'rejected');

    res = await call(baseUrl, '/quotes?quote_filter=approved', { token: adminToken });
    assert.equal(res.json.total, 1, 'one approved quote after approval');

    // 7) Compare is read-only — originals still intact after running it again.
    res = await call(baseUrl, `/compare?project_id=${PROJECT_ID}&include_historical=1`, { token: adminToken });
    assert.equal(res.status, 200);
    const dbTotalAAfter = db.prepare('SELECT total_quote_amount FROM contractor_quotes WHERE id = ?').get(quoteA.id).total_quote_amount;
    assert.equal(dbTotalAAfter, 1500, 'compare did not mutate original amounts');

    // 8) Permission enforcement — contractors cannot reach management quote analytics.
    res = await call(baseUrl, `/compare?project_id=${PROJECT_ID}`, { token: contractorToken });
    assert.equal(res.status, 403, 'contractor blocked from quote analytics');

    res = await call(baseUrl, '/quotes', { method: 'POST', token: contractorToken, body: { project_id: PROJECT_ID } });
    assert.equal(res.status, 403, 'contractor blocked from creating quotes');

    // 9) compare requires a project_id.
    res = await call(baseUrl, '/compare', { token: adminToken });
    assert.equal(res.status, 400, 'compare without project_id returns 400');

    // 9b) Quote-only notes: add, list (validation), delete.
    res = await call(baseUrl, `/quotes/${quoteA.id}/notes`, { method: 'POST', token: adminToken, body: { note: 'Confirm shingle color with owner' } });
    assert.equal(res.status, 201, 'add quote note');
    const noteId = res.json.id;
    res = await call(baseUrl, `/quotes/${quoteA.id}/notes`, { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.json.length, 1, 'one note listed');
    assert.equal(res.json[0].note, 'Confirm shingle color with owner');
    res = await call(baseUrl, `/quotes/${quoteA.id}/notes`, { method: 'POST', token: adminToken, body: { note: '   ' } });
    assert.equal(res.status, 400, 'blank note rejected');
    res = await call(baseUrl, `/quotes/${quoteA.id}/notes/${noteId}`, { method: 'DELETE', token: adminToken });
    assert.equal(res.status, 200, 'delete note');
    res = await call(baseUrl, `/quotes/${quoteA.id}/notes`, { token: adminToken });
    assert.equal(res.json.length, 0, 'note removed');

    // 9c) Modify (update) a quote: replace contractor + line items + total; quote number preserved.
    res = await call(baseUrl, '/quotes', { method: 'POST', token: adminToken, body: {
      project_id: PROJECT_ID, contractor_name: 'Original Co', quote_date: '2026-06-05', status: 'submitted',
      line_items: [{ category: 'Plumbing', description: 'orig', total_line_item_price: 100 }],
    } });
    assert.equal(res.status, 201, 'create quote C');
    const quoteC = res.json.quote;
    assert.equal(quoteC.total_quote_amount, 100);
    res = await call(baseUrl, `/quotes/${quoteC.id}`, { method: 'PUT', token: contractorToken, body: { contractor_name: 'X', quote_date: '2026-06-05', status: 'submitted', line_items: [{ category: 'Plumbing', description: 'x', total_line_item_price: 1 }] } });
    assert.equal(res.status, 403, 'contractor cannot modify a quote');
    res = await call(baseUrl, `/quotes/${quoteC.id}`, { method: 'PUT', token: adminToken, body: {
      contractor_name: 'Renamed Co', quote_date: '2026-06-06', status: 'submitted',
      line_items: [
        { category: 'Electrical', description: 'new panel', quantity: 2, unit_price: 600 },
        { category: 'Plumbing', description: 'lines', total_line_item_price: 400 },
      ],
    } });
    assert.equal(res.status, 200, 'modify returns 200');
    assert.equal(res.json.quote.contractor_name, 'Renamed Co', 'contractor updated');
    assert.equal(res.json.quote.total_quote_amount, 1600, 'updated total = 2*600 + 400');
    assert.equal(res.json.quote.quote_number, quoteC.quote_number, 'quote number preserved');
    assert.equal(res.json.line_items.length, 2, 'line items replaced');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM historical_quote_records WHERE quote_id = ? AND action = 'updated'").get(quoteC.id).c, 1, 'update snapshot recorded');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM activity_log WHERE action = 'quote_updated' AND entity_id = ?").get(quoteC.id).c, 1, 'update written to activity log');
    res = await call(baseUrl, '/quotes/does-not-exist', { method: 'PUT', token: adminToken, body: { contractor_name: 'x', quote_date: '2026-06-06', status: 'submitted', line_items: [{ category: 'Plumbing', description: 'x', total_line_item_price: 1 }] } });
    assert.equal(res.status, 404, 'modifying an unknown quote returns 404');

    // 10) Delete permissions: contractor blocked at router, project_manager blocked at handler,
    //     super_admin/operations_manager can delete; line items cascade; deletion is audited.
    const pmToken = tokenFor(PM_ID);
    res = await call(baseUrl, `/quotes/${quoteB.id}`, { method: 'DELETE', token: contractorToken });
    assert.equal(res.status, 403, 'contractor cannot delete quotes');
    res = await call(baseUrl, `/quotes/${quoteB.id}`, { method: 'DELETE', token: pmToken });
    assert.equal(res.status, 403, 'project_manager cannot delete quotes');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM contractor_quotes WHERE id = ?').get(quoteB.id).c, 1, 'quote still present after blocked deletes');

    // quoteB was denied above, and rejected quotes are a permanent bucket kept
    // for market/pricing analysis - deletion must be refused even for admins.
    res = await call(baseUrl, `/quotes/${quoteB.id}`, { method: 'DELETE', token: adminToken });
    assert.equal(res.status, 409, 'rejected quotes cannot be deleted');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM contractor_quotes WHERE id = ?').get(quoteB.id).c, 1, 'rejected quote preserved');

    // quoteC is still 'submitted', so the admin delete path works there.
    res = await call(baseUrl, `/quotes/${quoteC.id}`, { method: 'DELETE', token: adminToken });
    assert.equal(res.status, 200, 'super_admin can delete a non-rejected quote');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM contractor_quotes WHERE id = ?').get(quoteC.id).c, 0, 'quote removed');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM quote_line_items WHERE quote_id = ?').get(quoteC.id).c, 0, 'line items cascade-deleted');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM activity_log WHERE action = 'quote_deleted' AND entity_id = ?").get(quoteC.id).c, 1, 'deletion written to activity log');

    res = await call(baseUrl, '/quotes/does-not-exist', { method: 'DELETE', token: adminToken });
    assert.equal(res.status, 404, 'deleting an unknown quote returns 404');

    console.log('Quote analytics tests passed');
  } finally {
    server.close();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
