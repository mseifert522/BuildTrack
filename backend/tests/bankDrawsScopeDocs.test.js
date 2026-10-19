// Bank Draws + Scope of Work PDF (2026-10-19). Fresh database, real routes, QuickBooks
// stubbed (this test never talks to Intuit).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-bankdraws-test-'));
process.env.DB_PATH = path.join(temp, 'test.db');
process.env.UPLOADS_PATH = path.join(temp, 'uploads');
process.env.JWT_SECRET = 'test-bankdraws-secret-not-for-production';
const { initializeSchema, getDb } = require('../src/db/schema');
const bankDraws = require('../src/services/bankDraws');
const quickBooks = require('../src/routes/quickbooks');
const { classifyUploadPath } = require('../src/middleware/uploadsGate');

// ---------------------------------------------------------------------------
// Fixture shaped like QuickBooks (values from the real 2026-10-19 ledger).
const CLASSES = [
  { id: '5', name: '2811 Wisconsin', fullName: '2811 Wisconsin', parentId: null, active: true },
  { id: '2', name: '1253 Milverton', fullName: '1253 Milverton', parentId: null, active: true },
  { id: '7', name: '171 Davis', fullName: '171 Davis', parentId: null, active: true },
  { id: '71', name: '171 Davis Unit A', fullName: '171 Davis Unit A', parentId: null, active: true },
  { id: '9', name: '1132 N Blair', fullName: '1132 N Blair', parentId: null, active: true },
  { id: '45', name: '3690 Oakshire', fullName: '3690 Oakshire', parentId: null, active: true },
];
const gl = (date, type, id, cls, memo, debit, credit, name = '', split = '1010 Operating PNC  #4358') => ({
  tx_date: date, txn_type: type, txnId: id, doc_num: '', name, memo, klass_name: cls, split_acc: split,
  debt_amt: debit ? String(debit) : '', credit_amt: credit ? String(credit) : '',
});
const LEDGER_ROWS = [
  gl('2026-08-27', 'Journal Entry', '901', '2811 Wisconsin', '2811 Wisconsin', 41400, 0, '', '-Split-'),
  gl('2026-08-28', 'Deposit', '902', '2811 Wisconsin', '2811 Wisconsin construction draw', 0, 12420),
  gl('2026-09-23', 'Deposit', '903', '2811 Wisconsin', 'construction draw 2', 0, 12125, 'Tier1 Funding'),
  gl('2026-09-24', 'Journal Entry', '904', '2811 Wisconsin', 'Inspection fee', 0, 100, 'Lender', '-Split-'),
  gl('2025-10-17', 'Deposit', '905', '3690 Oakshire', 'Oakshire draw', 0, 43875),
];
const column = (title, key) => ({ ColTitle: title, ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: key }] });
const cols = values => [{ value: values[0] }, ...values.slice(1).map(v => ({ value: v }))];
const BALANCE_SHEET = {
  Columns: { Column: [{ ColTitle: '', ColType: 'Account', MetaData: [{ Name: 'ColKey', Value: 'account' }] }, column('2811 Wisconsin', '5'), column('171 Davis', '7'), column('171 Davis Unit A', '71'), column('TOTAL', 'total')] },
  Rows: { Row: [
    { type: 'Section', group: 'TotalAssets', Header: { ColData: cols(['ASSETS', '', '', '', '']) }, Rows: { Row: [
      { type: 'Section', group: 'CurrentAssets', Header: { ColData: cols(['Current Assets', '', '', '', '']) }, Rows: { Row: [
        { type: 'Data', ColData: [{ value: '1130 Construction Loans - Funds in Escrow / Holdbacks', id: '85' }, { value: '16755.00' }, { value: '' }, { value: '' }, { value: '16755.00' }] },
      ] }, Summary: { ColData: cols(['Total Current Assets', '16755.00', '0.00', '0.00', '16755.00']) } },
      { type: 'Section', group: 'FixedAssets', Header: { ColData: cols(['Fixed Assets', '', '', '', '']) }, Rows: { Row: [
        { type: 'Data', ColData: [{ value: '1210 Land - LTP', id: '56' }, { value: '28000.00' }, { value: '32000.00' }, { value: '' }, { value: '60000.00' }] },
        { type: 'Section', Header: { ColData: [{ value: '1270 Carried Utilities', id: '70' }, { value: '63.99' }, { value: '' }, { value: '' }, { value: '63.99' }] }, Rows: { Row: [
          { type: 'Data', ColData: [{ value: '1271 Carrying Costs | Gas', id: '71' }, { value: '57.80' }, { value: '' }, { value: '' }, { value: '57.80' }] },
        ] }, Summary: { ColData: cols(['Total 1270 Carried Utilities', '121.79', '0.00', '0.00', '121.79']) } },
        { type: 'Section', Header: { ColData: cols(['1280 Vehicles', '', '', '', '']) }, Rows: { Row: [] }, Summary: { ColData: cols(['Total 1280 Vehicles', '0.00', '0.00', '0.00', '0.00']) } },
      ] }, Summary: { ColData: cols(['Total Fixed Assets', '28121.79', '32000.00', '0.00', '60121.79']) } },
    ] }, Summary: { ColData: cols(['TOTAL ASSETS', '44876.79', '32000.00', '0.00', '76876.79']) } },
    { type: 'Section', group: 'TotalLiabilitiesAndEquity', Header: { ColData: cols(['LIABILITIES AND EQUITY', '', '', '', '']) }, Rows: { Row: [
      { type: 'Section', group: 'Liabilities', Header: { ColData: cols(['Liabilities', '', '', '', '']) }, Rows: { Row: [
        { type: 'Data', ColData: [{ value: '2020 Bridge Loans Due <12 Months', id: '80' }, { value: '30000.00' }, { value: '' }, { value: '' }, { value: '30000.00' }] },
        { type: 'Data', ColData: [{ value: '2080 Tenant Security Deposits', id: '81' }, { value: '' }, { value: '1000.00' }, { value: '575.00' }, { value: '1575.00' }] },
      ] }, Summary: { ColData: cols(['Total Liabilities', '30000.00', '1000.00', '575.00', '31575.00']) } },
    ] }, Summary: { ColData: cols(['TOTAL LIABILITIES AND EQUITY', '30000.00', '1000.00', '575.00', '31575.00']) } },
  ] },
};
const PROFIT_LOSS = {
  Columns: { Column: [{ ColTitle: '', ColType: 'Account', MetaData: [{ Name: 'ColKey', Value: 'account' }] }, column('171 Davis', '7'), column('171 Davis Unit A', '71'), column('TOTAL', 'total')] },
  Rows: { Row: [
    { type: 'Section', group: 'Income', Header: { ColData: cols(['Income', '', '', '']) }, Rows: { Row: [
      { type: 'Data', ColData: [{ value: '4000 Rent Income', id: '5' }, { value: '1000.00' }, { value: '250.00' }, { value: '1250.00' }] },
    ] }, Summary: { ColData: cols(['Total Income', '1000.00', '250.00', '1250.00']) } },
    { type: 'Section', group: 'GrossProfit', Summary: { ColData: cols(['Gross Profit', '1000.00', '250.00', '1250.00']) } },
    { type: 'Section', group: 'Expenses', Header: { ColData: cols(['Expenses', '', '', '']) }, Rows: { Row: [
      { type: 'Data', ColData: [{ value: '6200 Real Estate Taxes', id: '43' }, { value: '400.00' }, { value: '' }, { value: '400.00' }] },
    ] }, Summary: { ColData: cols(['Total Expenses', '400.00', '0.00', '400.00']) } },
    { type: 'Section', group: 'NetOtherIncome', Summary: { ColData: cols(['Net Other Income', '0.00', '0.00', '0.00']) } },
    { type: 'Section', group: 'NetIncome', Summary: { ColData: cols(['Net Income', '600.00', '250.00', '850.00']) } },
  ] },
};
const REPORTS = {
  classes: CLASSES,
  ledgers: [{ number: '1130', id: '85', name: 'Construction Loans - Funds in Escrow / Holdbacks', rows: LEDGER_ROWS }],
  bankAccountNames: ['1010 Operating PNC  #4358', 'Operating PNC  #4358'],
  balanceSheet: BALANCE_SHEET,
  profitLoss: PROFIT_LOSS,
  period: { start: '2015-01-01', end: '2026-10-19' },
};

(async () => {
  // ---- pure functions -------------------------------------------------------
  assert.deepEqual(bankDraws.addressKey('1132 N Blair Ave, Royal Oak, MI'), { number: '1132', street: 'blair' });
  assert.equal(bankDraws.addressKey('Accounting Fees'), null);
  const projectsFixture = [
    { id: 'p-wis', address: '2811 Wisconsin Rd, Troy, MI 48083, USA', job_name: '2811 Wisconsin', quickbooks_class_id: '5' },
    { id: 'p-mil', address: '2153 Milverton Rd, Troy, MI 48083, USA', job_name: '2153 Milverton', quickbooks_class_id: '2' },
    { id: 'p-dav', address: '171 Davis St, Wyandotte, MI', job_name: '171 Davis', quickbooks_class_id: null },
    { id: 'p-bla', address: '1132 N Blair Ave, Royal Oak, MI', job_name: '1132 Blair ', quickbooks_class_id: null },
    { id: 'p-new', address: '99 Nowhere St', job_name: '99 Nowhere', quickbooks_class_id: null },
  ];
  const matches = bankDraws.matchProjectClasses(projectsFixture, CLASSES);
  const byProject = Object.fromEntries(matches.map(m => [m.projectId, m]));
  assert.equal(byProject['p-wis'].status, 'exact');
  assert.equal(byProject['p-mil'].status, 'number_differs', 'QuickBooks spells 2153 Milverton as 1253');
  // Confirmed alias + a correctly named twin class: both count toward the one project.
  const withTwin = [...CLASSES, { id: '23', name: '2153 Milverton', fullName: '2153 Milverton', parentId: null, active: true }];
  const aliasMatches = bankDraws.matchProjectClasses(projectsFixture, withTwin, new Map([['p-mil', new Set(['1253 milverton'])]]));
  const mil = aliasMatches.find(m => m.projectId === 'p-mil');
  assert.equal(mil.status, 'confirmed_alias');
  assert.equal(mil.classId, '2', 'the existing link is kept');
  assert.deepEqual(mil.relatedIds, ['23'], 'the correctly named class is taken in too');
  assert.equal(bankDraws.matchProjectClasses(projectsFixture, withTwin).find(m => m.projectId === 'p-mil').relatedIds.includes('23'), true, 'a class named for the address counts even before confirming');
  assert.equal(byProject['p-dav'].status, 'auto_linked');
  assert.equal(byProject['p-dav'].classId, '7', 'the property class wins over its unit class');
  assert.deepEqual(byProject['p-dav'].relatedIds, ['71']);
  assert.equal(byProject['p-bla'].status, 'auto_linked', 'a direction word is skipped');
  assert.equal(byProject['p-new'].status, 'unlinked');

  const { lines, unmatched } = bankDraws.buildDrawLines(REPORTS, matches, 'now');
  assert.equal(unmatched, 1, 'Oakshire has no BuildTrack project');
  const wis = lines.filter(l => l.project_id === 'p-wis');
  assert.deepEqual(wis.map(l => l.kind), ['holdback_funded', 'draw', 'draw', 'escrow_adjustment']);
  assert.deepEqual(wis.map(l => l.amount), [41400, -12420, -12125, -100]);

  const bs = bankDraws.statementFor(BALANCE_SHEET, ['7', '71']);
  assert.equal(bs.found, true);
  assert.equal(bs.totals.Liabilities, 1575, 'unit class columns are added in');
  const wisBs = bankDraws.statementFor(BALANCE_SHEET, ['5']);
  const fixed = wisBs.sections[0].children.find(n => n.title === 'Fixed Assets');
  assert.equal(fixed.children.some(n => n.title === '1280 Vehicles'), false, 'empty sections are dropped');
  const utilities = fixed.children.find(n => n.title === '1270 Carried Utilities');
  assert.equal(utilities.children[0].account, '1270 Carried Utilities', "a parent account's own balance is kept");
  assert.equal(utilities.children[0].amount, 63.99);
  const wisSummary = bankDraws.financeSummary(wisBs, bankDraws.statementFor(PROFIT_LOSS, ['5']));
  assert.equal(wisSummary.escrow_balance, 16755);
  assert.equal(wisSummary.owner_equity, 14876.79);
  assert.equal(wisSummary.net_income, null, 'no P&L column for an active rehab');
  const davisPl = bankDraws.statementFor(PROFIT_LOSS, ['7', '71']);
  assert.equal(davisPl.totals.NetIncome, 850);
  assert.equal(davisPl.sections.some(n => n.kind === 'total' && n.group === 'NetOtherIncome'), false, 'zero subtotals are hidden');
  assert.equal(davisPl.sections.some(n => n.kind === 'total' && n.group === 'NetIncome'), true);

  assert.deepEqual(classifyUploadPath(path.resolve(process.env.UPLOADS_PATH), '/scope-documents/p-wis/x.pdf')?.kind, 'blocked');

  // ---- routes ---------------------------------------------------------------
  initializeSchema();
  initializeSchema(); // Additive migration is idempotent.
  const db = getDb();
  const insertUser = db.prepare('INSERT INTO users(id,name,email,password_hash,role,is_active) VALUES(?,?,?,?,?,?)');
  insertUser.run('sa', 'Super', 'sa@test.invalid', 'hash', 'super_admin', 1);
  insertUser.run('om', 'Ops', 'om@test.invalid', 'hash', 'operations_manager', 1);
  insertUser.run('pm', 'Project', 'pm@test.invalid', 'hash', 'project_manager', 1);
  insertUser.run('pm2', 'Project Two', 'pm2@test.invalid', 'hash', 'project_manager', 1);
  insertUser.run('ct', 'Contractor', 'ct@test.invalid', 'hash', 'contractor', 1);
  const insertProject = db.prepare("INSERT INTO projects(id,address,job_name,status,created_by,quickbooks_class_id,quickbooks_class_name) VALUES(?,?,?,'active_rehab','sa',?,?)");
  for (const p of projectsFixture) insertProject.run(p.id, p.address, p.job_name, p.quickbooks_class_id, p.quickbooks_class_id ? CLASSES.find(c => c.id === p.quickbooks_class_id).name : null);
  db.prepare("INSERT INTO project_scopes(id,project_id,section_name,scope_title,scope_of_work,created_by,created_by_agent,source) VALUES('s1','p-wis','Kitchen','Scope of Work - 2811 Wisconsin Road','1. Install header — remove wall\n2. New cabinets “shaker”','sa','Benito','telegram')").run();
  db.prepare("INSERT INTO construction_plan_items(id,project_id,project_scope_id,title,category,created_by) VALUES('i1','p-wis','s1','Install header and remove wall between kitchen and living room','Framing','sa')").run();
  db.prepare("INSERT INTO quickbooks_connections(id,realm_id,environment,company_name,access_token_encrypted,refresh_token_encrypted,access_token_expires_at,is_active) VALUES('primary','1','production','Test','x','y',datetime('now','+1 hour'),1)").run();

  const app = express();
  app.use(express.json());
  app.use('/api/projects/:projectId/scope-document', require('../src/routes/scopeDocuments'));
  app.use('/api/projects/:projectId/bank-draws', require('../src/routes/bankDraws'));
  app.use('/api/feature-access', require('../src/routes/featureAccess'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = user => (user ? { Authorization: `Bearer ${jwt.sign({ userId: user }, process.env.JWT_SECRET, { expiresIn: '5m' })}` } : {});
  async function call(route, method = 'GET', user = 'sa', body) {
    const isForm = body instanceof FormData;
    const response = await fetch(base + route, {
      method,
      headers: { ...auth(user), ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, headers: response.headers, body: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  }

  const realReports = quickBooks.projectFinanceReports;
  try {
    // Who may see Bank Draws
    assert.equal((await call('/api/feature-access/me', 'GET', 'sa')).body.access.bank_draws, true);
    assert.equal((await call('/api/feature-access/me', 'GET', 'om')).body.access.bank_draws, true);
    assert.equal((await call('/api/feature-access/me', 'GET', 'pm')).body.access.bank_draws, false, 'project managers do not get Bank Draws by role');
    assert.equal((await call('/api/projects/p-wis/bank-draws', 'GET', 'pm')).status, 403);
    assert.equal((await call('/api/projects/p-wis/bank-draws', 'GET', 'ct')).status, 403);
    assert.equal((await call('/api/projects/p-wis/bank-draws', 'GET', null)).status, 401);
    assert.equal((await call('/api/projects/p-wis/bank-draws/sync', 'POST', 'pm')).status, 403);
    assert.equal((await call('/api/feature-access/bank_draws', 'GET', 'pm')).status, 403, 'only SA/OM manage access');
    assert.equal((await call('/api/feature-access/bank_draws/pm2', 'PUT', 'pm')).status, 403);
    assert.equal((await call('/api/feature-access/bank_draws/ct', 'PUT', 'om')).status, 400, 'contractors can never be given access');
    assert.equal((await call('/api/feature-access/bank_draws/sa', 'PUT', 'om')).status, 400);
    const granted = await call('/api/feature-access/bank_draws/pm', 'PUT', 'om');
    assert.equal(granted.status, 200);
    assert.equal(granted.body.users.find(u => u.user_id === 'pm').granted, true);
    assert.equal((await call('/api/feature-access/me', 'GET', 'pm')).body.access.bank_draws, true);
    assert.equal((await call('/api/projects/p-wis/bank-draws', 'GET', 'pm')).status, 200, 'an assigned user sees the tab');
    assert.equal((await call('/api/projects/p-wis/bank-draws', 'GET', 'pm2')).status, 403);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action='feature_access_granted'").get().n, 1);

    // Before any sync
    let res = await call('/api/projects/p-wis/bank-draws');
    assert.equal(res.status, 200);
    assert.equal(res.body.quickbooks.stale, true);
    assert.deepEqual(res.body.register, []);

    // Sync (QuickBooks stubbed)
    quickBooks.projectFinanceReports = async () => REPORTS;
    res = await call('/api/projects/p-wis/bank-draws/sync', 'POST', 'sa');
    assert.equal(res.status, 200);
    assert.equal(res.body.summary.holdback_funded, 41400);
    assert.equal(res.body.summary.drawn, 24545);
    assert.equal(res.body.summary.holdback_remaining, 16755);
    assert.equal(res.body.summary.draw_count, 2);
    assert.equal(res.body.summary.last_draw_date, '2026-09-23');
    assert.deepEqual(res.body.register.map(r => r.balance), [41400, 28980, 16855, 16755], 'running balance like the QuickBooks register');
    assert.deepEqual(res.body.register.map(r => r.draw_number), [null, 1, 2, null]);
    assert.equal(res.body.register[1].qbo_url, 'https://app.qbo.intuit.com/app/deposit?txnId=902');
    assert.equal(res.body.finance.match.status, 'exact');
    assert.equal(res.body.finance.summary.owner_equity, 14876.79);
    assert.equal(res.body.quickbooks.stale, false);

    const davis = await call('/api/projects/p-dav/bank-draws', 'GET', 'pm');
    assert.equal(davis.body.finance.match.status, 'auto_linked');
    assert.deepEqual(davis.body.finance.class_names, ['171 Davis', '171 Davis Unit A']);
    assert.equal(davis.body.finance.summary.net_income, 850);
    assert.equal(db.prepare("SELECT quickbooks_class_id FROM projects WHERE id='p-dav'").get().quickbooks_class_id, '7', 'linked by address');
    assert.equal(db.prepare("SELECT quickbooks_class_id FROM projects WHERE id='p-mil'").get().quickbooks_class_id, '2', 'an existing link is never changed');
    assert.equal((await call('/api/projects/p-mil/bank-draws')).body.finance.match.status, 'number_differs');
    // Confirm "1253 Milverton" as 2153 Milverton (SA/OM only), then undo.
    assert.equal((await call('/api/projects/p-mil/bank-draws/class-alias', 'POST', 'pm')).status, 403, 'an assigned user cannot change class matching');
    res = await call('/api/projects/p-mil/bank-draws/class-alias', 'POST', 'om');
    assert.equal(res.status, 200);
    assert.equal(res.body.finance.match.status, 'confirmed_alias');
    assert.deepEqual(res.body.finance.match.aliases, ['1253 milverton']);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action = 'quickbooks_class_confirmed'").get().n, 1);
    res = await call('/api/projects/p-mil/bank-draws/class-alias', 'POST', 'sa');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM project_class_aliases WHERE project_id = 'p-mil'").get().n, 1, 'confirming twice is harmless');
    res = await call('/api/projects/p-mil/bank-draws/class-alias', 'DELETE', 'sa');
    assert.equal(res.body.finance.match.status, 'number_differs');
    res = await call('/api/projects/p-mil/bank-draws/class-alias', 'POST', 'sa');
    assert.equal(res.body.finance.match.status, 'confirmed_alias');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action='quickbooks_class_matched'").get().n, 2);

    // QuickBooks failure keeps the last copy
    quickBooks.projectFinanceReports = async () => { throw new Error('QuickBooks is down'); };
    db.prepare("UPDATE bank_draw_sync_state SET last_synced_at = datetime('now','-1 hour')").run();
    res = await call('/api/projects/p-wis/bank-draws/sync', 'POST', 'om');
    assert.equal(res.status, 502);
    assert.equal(res.body.summary.drawn, 24545, 'the saved draws are still returned');
    assert.equal(res.body.quickbooks.error, 'QuickBooks is down');

    // Potential sale (manual, Finance tab): price - realtor commission (3% standard) - closing costs ($)
    res = await call('/api/projects/p-wis/bank-draws', 'GET', 'sa');
    assert.equal(res.body.projection.potential_sale_price, null);
    assert.equal(res.body.projection.commission_pct, 3, 'realtor commission defaults to 3%');
    assert.equal(res.body.projection.closing_costs, 0);
    assert.equal(res.body.default_commission_pct, 3);
    const put = (user, body) => call('/api/projects/p-wis/bank-draws/projection', 'PUT', user, body);
    assert.equal((await put('ct', { potential_sale_price: 1 })).status, 403);
    assert.equal((await put('pm2', { potential_sale_price: 1 })).status, 403);
    assert.equal((await put('sa', { potential_sale_price: 'abc' })).status, 400);
    assert.equal((await put('sa', { potential_sale_price: -5 })).status, 400);
    assert.equal((await put('sa', { potential_sale_price: 1000, commission_pct: 11 })).status, 400);
    assert.equal((await put('sa', { potential_sale_price: 1000, closing_costs: 'lots' })).status, 400);
    res = await put('pm', { potential_sale_price: '$300,000' });
    assert.equal(res.status, 200, 'a user assigned to the tab can enter it');
    let pr = res.body.projection;
    assert.equal(pr.potential_sale_price, 300000);
    assert.equal(pr.commission_pct, 3);
    assert.equal(pr.commission, 9000);
    assert.equal(pr.closing_costs, 0);
    assert.equal(pr.selling_costs, 9000);
    assert.equal(pr.net_proceeds, 291000);
    assert.equal(pr.loan_payoff, 13245, 'owed 30,000 less 16,755 still in escrow');
    assert.equal(pr.cash_back, 277755);
    assert.equal(pr.invested, 28121.79);
    assert.equal(pr.projected_profit, 262878.21);
    assert.equal(pr.cash_in, 14876.79, "invested 28,121.79 less 13,245 paid off");
    assert.equal(Math.round((pr.cash_in + pr.projected_profit) * 100) / 100, pr.cash_back, "funds returned = cash in + profit");
    assert.equal(pr.updated_by_name, 'Project');
    const logged = db.prepare("SELECT project_id, details FROM activity_log WHERE action = 'finance_projection_updated' ORDER BY created_at DESC LIMIT 1").get();
    assert.equal(logged.project_id, null, 'not in the contractor-readable project activity');
    assert.equal(/300000|9000/.test(logged.details), false, 'no amounts in the audit trail');
    pr = (await put('sa', { potential_sale_price: 300000, commission_pct: 2.5, closing_costs: '$4,000' })).body.projection;
    assert.equal(pr.commission, 7500);
    assert.equal(pr.closing_costs, 4000);
    assert.equal(pr.selling_costs, 11500);
    assert.equal(pr.net_proceeds, 288500);
    pr = (await put('sa', { potential_sale_price: '' })).body.projection;
    assert.equal(pr.potential_sale_price, null, 'blank clears it');
    assert.equal(pr.cash_in, 14876.79, 'cash in shows without a sales price');
    assert.equal(pr.commission_pct, 3);
    assert.equal(pr.net_proceeds, null);
    const unsynced = (await call('/api/projects/p-new/bank-draws/projection', 'PUT', 'sa', { potential_sale_price: 100000, closing_costs: 1500 })).body.projection;
    assert.equal(unsynced.net_proceeds, 95500);
    assert.equal(unsynced.cash_back, null, 'no balance sheet, no payoff figure');
    // A row saved by the first version (single 3.5% figure) migrates to the 3% commission.
    db.prepare("INSERT INTO project_finance_inputs (project_id, potential_sale_price, closing_cost_pct) VALUES ('p-bla', 200000, 3.5)").run();
    initializeSchema();
    assert.equal(db.prepare("SELECT commission_pct FROM project_finance_inputs WHERE project_id = 'p-bla'").get().commission_pct, 3);

    // Revoke
    assert.equal((await call('/api/feature-access/bank_draws/pm', 'DELETE', 'sa')).status, 200);
    assert.equal((await call('/api/projects/p-wis/bank-draws', 'GET', 'pm')).status, 403);

    // ---- Scope of Work PDF ----------------------------------------------------
    res = await call('/api/projects/p-wis/scope-document', 'GET', 'pm');
    assert.equal(res.status, 200);
    assert.equal(res.body.current, null);
    assert.equal(res.body.generated.has_content, true);
    assert.equal(res.body.permissions.can_upload, true);
    assert.equal(res.body.permissions.can_delete, false);
    assert.equal((await call('/api/projects/p-wis/scope-document', 'GET', 'ct')).status, 403, 'unassigned contractor');

    const generated = await call('/api/projects/p-wis/scope-document/generated.pdf', 'GET', 'pm');
    assert.equal(generated.status, 200);
    assert.equal(generated.headers.get('content-type'), 'application/pdf');
    assert.equal(generated.body.subarray(0, 5).toString(), '%PDF-');
    assert.ok(generated.body.length > 1500);

    const notPdf = new FormData();
    notPdf.append('file', new Blob(['hello'], { type: 'application/pdf' }), 'fake.pdf');
    assert.equal((await call('/api/projects/p-wis/scope-document', 'POST', 'pm', notPdf)).status, 400, 'content, not the name, decides');

    const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
    const upload = name => { const form = new FormData(); form.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), name); return form; };
    assert.equal((await call('/api/projects/p-wis/scope-document', 'POST', 'ct', upload('x.pdf'))).status, 403);
    res = await call('/api/projects/p-wis/scope-document', 'POST', 'pm', upload('Wisconsin scope.pdf'));
    assert.equal(res.status, 201);
    assert.equal(res.body.current.original_name, 'Wisconsin scope.pdf');
    const first = res.body.current;
    res = await call('/api/projects/p-wis/scope-document', 'POST', 'sa', upload('Wisconsin scope v2'));
    assert.equal(res.body.current.original_name, 'Wisconsin scope v2.pdf', 'newest upload is the one shown');
    assert.equal(res.body.versions.length, 2);

    const file = await call(first.url, 'GET', 'pm');
    assert.equal(file.status, 200);
    assert.equal(file.body.toString(), pdfBytes.toString());
    assert.match(file.headers.get('content-disposition'), /^inline;/);
    assert.equal((await call(`/api/projects/p-mil/scope-document/${first.id}/file`, 'GET', 'pm')).status, 404, 'a document is only readable through its own project');

    assert.equal((await call(`/api/projects/p-wis/scope-document/${first.id}`, 'DELETE', 'pm')).status, 403);
    res = await call(`/api/projects/p-wis/scope-document/${first.id}`, 'DELETE', 'om');
    assert.equal(res.status, 200);
    assert.equal(res.body.versions.length, 1);
    const storedFiles = fs.readdirSync(path.join(process.env.UPLOADS_PATH, 'scope-documents', 'p-wis'));
    assert.equal(storedFiles.length, 1, 'the deleted version file is removed');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action LIKE 'scope_document_%'").get().n, 3);

    console.log('bankDrawsScopeDocs tests passed');
  } finally {
    quickBooks.projectFinanceReports = realReports;
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
