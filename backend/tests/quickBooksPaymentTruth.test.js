const assert = require('assert');

const quickBooksRoutes = require('../src/routes/quickbooks');

const {
  missingQuickBooksBillIds,
  paymentStatusForBill,
  reconcileMissingQuickBooksBills,
  shouldRestoreDeletedQuickBooksBill,
} = quickBooksRoutes.__test;

assert.equal(paymentStatusForBill({ TotalAmt: 150, Balance: 0 }), 'paid');
assert.equal(paymentStatusForBill({ TotalAmt: 150, Balance: 25 }), 'partial');
assert.equal(paymentStatusForBill({ TotalAmt: 150, Balance: 150 }), 'unpaid');

assert.equal(shouldRestoreDeletedQuickBooksBill('deleted_from_buildtrack', 'paid'), true);
assert.equal(shouldRestoreDeletedQuickBooksBill('deleted_from_buildtrack', 'unpaid'), false);
assert.equal(shouldRestoreDeletedQuickBooksBill('paid_from_buildtrack', 'paid'), false);

assert.deepEqual(
  missingQuickBooksBillIds(
    [{ qbo_id: '10925' }, { qbo_id: '10954' }],
    [{ Id: '10954' }]
  ),
  ['10925']
);

const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE quickbooks_bills (
    qbo_id TEXT PRIMARY KEY,
    realm_id TEXT,
    environment TEXT,
    vendor_name TEXT,
    total_amt REAL,
    balance REAL,
    payment_status TEXT,
    payment_approval_status TEXT,
    project_id TEXT,
    payment_approved_at TEXT,
    payment_approved_by TEXT,
    payment_run_date TEXT,
    payment_approval_notified_at TEXT,
    payment_approval_notified_by TEXT,
    updated_at TEXT
  );
  INSERT INTO quickbooks_bills (
    qbo_id, realm_id, environment, vendor_name, total_amt, balance,
    payment_status, payment_approval_status, project_id
  ) VALUES
    ('10925', 'realm', 'production', 'Snyders Services LLC', 150, 150, 'unpaid', 'paid_from_buildtrack', 'project'),
    ('10954', 'realm', 'production', 'Snyders Services LLC', 150, 0, 'paid', 'not_approved', 'project');
`);

const reconciliation = reconcileMissingQuickBooksBills(
  db,
  { realm_id: 'realm', environment: 'production' },
  [{ Id: '10954' }]
);
assert.equal(reconciliation.count, 1);
assert.equal(reconciliation.bills[0].qbo_id, '10925');
assert.equal(db.prepare("SELECT payment_approval_status FROM quickbooks_bills WHERE qbo_id='10925'").get().payment_approval_status, 'deleted_from_buildtrack');
assert.equal(db.prepare("SELECT payment_approval_status FROM quickbooks_bills WHERE qbo_id='10954'").get().payment_approval_status, 'not_approved');
db.close();

console.log('QuickBooks payment truth tests passed');
