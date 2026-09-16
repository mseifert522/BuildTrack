// Tests buildCardActivity() (the Finance Tracker card panel feed) without QuickBooks or the database:
// the function is extracted from quickbooks.js and run on hand-built QBO-shaped records.
// usage: node tests/cardActivity.test.js [path/to/quickbooks.js]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = process.argv[2] || path.join(__dirname, '..', 'src', 'routes', 'quickbooks.js');
const src = fs.readFileSync(file, 'utf8');
const start = src.indexOf('const CARD_PAYOFF_MIN_PRIOR_BALANCE');
const end = src.indexOf('// Every record of an entity.');
if (start < 0 || end <= start) throw new Error(`could not locate buildCardActivity in ${file}`);
const ctx = {};
vm.createContext(ctx);
vm.runInContext(`${src.slice(start, end)}\nthis.buildCardActivity = buildCardActivity;`, ctx);
const build = ctx.buildCardActivity;

const accounts = [
  { Id: '10', Name: 'Chase #9500 Parent', AccountType: 'Credit Card' },
  { Id: '11', Name: "Mark's Card #2541 (9500)", AccountType: 'Credit Card' },
  { Id: '20', Name: 'Operating PNC  #4358', AccountType: 'Bank' },
  { Id: '30', Name: 'Repairs', AccountType: 'Expense' },
];
const ref = (id, name) => ({ value: id, name });
const expenseLine = (amount, cls, account = ref('30', 'Repairs')) => ({
  Amount: amount,
  DetailType: 'AccountBasedExpenseLineDetail',
  AccountBasedExpenseLineDetail: { AccountRef: account, ClassRef: cls ? ref(`c-${cls}`, cls) : undefined },
});
const cardPurchase = (id, date, card, lines, extra = {}) => ({ Id: id, TxnDate: date, PaymentType: 'CreditCard', AccountRef: card, Line: lines, ...extra });
const journal = (id, date, lines) => ({
  Id: id,
  TxnDate: date,
  Line: lines.map(([posting, account, amount]) => ({ Amount: amount, JournalEntryLineDetail: { PostingType: posting, AccountRef: account } })),
});
const PARENT = ref('10', 'Chase #9500 Parent');
const MARK = ref('11', "Mark's Card #2541 (9500)");
const BANK = ref('20', 'Operating PNC  #4358');

const results = [];
function check(name, fn) {
  try { fn(); results.push([true, name]); } catch (e) { results.push([false, `${name} -> ${e.message}`]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const charge = (out, card, month, label) => out.charges.find((c) => c.card === card && c.month === month && c.label === label);

check('card purchase lines are charged by class, unclassed lines grouped, refunds negative', () => {
  const out = build({
    accounts,
    purchases: [
      cardPurchase('1', '2026-05-03', PARENT, [expenseLine(100.1, '171 Davis'), expenseLine(20, null), { Amount: 120.1, DetailType: 'SubTotalLineDetail' }]),
      cardPurchase('2', '2026-05-20', PARENT, [expenseLine(30.05, '171 Davis')]),
      cardPurchase('3', '2026-05-21', PARENT, [expenseLine(10, '171 Davis')], { Credit: true }),
    ],
    journals: [],
  });
  assert(charge(out, 'Chase #9500 Parent', '2026-05', '171 Davis').amount === 120.15, JSON.stringify(out.charges));
  assert(charge(out, 'Chase #9500 Parent', '2026-05', 'Unclassed').amount === 20, 'unclassed bucket');
  assert(out.charges.length === 2, 'subtotal line must not count');
});

check('journal credits to a card are "Journal adjustment" charges, debits are payments keyed J<id>', () => {
  const out = build({ accounts, purchases: [], journals: [journal('77', '2026-06-30', [['Credit', PARENT, 500], ['Debit', MARK, 500]])] });
  assert(charge(out, 'Chase #9500 Parent', '2026-06', 'Journal adjustment').amount === 500, 'adjustment');
  const p = out.payments.find((x) => x.ref === 'J77');
  assert(p && p.card === "Mark's Card #2541 (9500)" && p.amount === 500 && p.label === 'journal — journal entry' && p.date === '2026-06-30', JSON.stringify(out.payments));
});

check('a bank purchase with a card expense line is a check payment keyed P<id>', () => {
  const out = build({
    accounts,
    purchases: [{ Id: '9', TxnDate: '2026-03-20', PaymentType: 'Cash', AccountRef: BANK, Line: [expenseLine(40, null, PARENT)] }],
    journals: [],
  });
  assert(out.charges.length === 0, 'must not be a charge');
  assert(out.payments.length === 1 && out.payments[0].ref === 'P9' && out.payments[0].label === 'check — Operating PNC  #4358' && out.payments[0].amount === 40, JSON.stringify(out.payments));
});

check('month-end payoff needs a prior month-end balance above $1,000', () => {
  const out = build({
    accounts,
    purchases: [
      cardPurchase('1', '2026-01-10', MARK, [expenseLine(1500, 'A')]),
      cardPurchase('2', '2026-03-10', MARK, [expenseLine(400, 'A')]),
    ],
    journals: [
      journal('1', '2026-02-05', [['Debit', MARK, 1500]]), // 1,500 -> 0: payoff
      journal('2', '2026-04-05', [['Debit', MARK, 400]]), // 400 -> 0: too small to count
    ],
  });
  assert(out.payoffs.length === 1 && out.payoffs[0].month === '2026-02' && out.payoffs[0].card === "Mark's Card #2541 (9500)", JSON.stringify(out.payoffs));
});

check('an overpayment below zero still counts as paid off; netting to zero drops the charge row', () => {
  const out = build({
    accounts,
    purchases: [
      cardPurchase('1', '2026-01-10', MARK, [expenseLine(2000, 'A')]),
      cardPurchase('2', '2026-01-11', MARK, [expenseLine(50, 'B')]),
      cardPurchase('3', '2026-01-12', MARK, [expenseLine(50, 'B')], { Credit: true }),
    ],
    journals: [journal('1', '2026-02-05', [['Debit', MARK, 2100]])],
  });
  assert(out.payoffs.length === 1 && out.payoffs[0].month === '2026-02', JSON.stringify(out.payoffs));
  assert(!charge(out, "Mark's Card #2541 (9500)", '2026-01', 'B'), 'zero-sum row must be dropped');
});

check('non-card accounts and records without a date are ignored', () => {
  const out = build({
    accounts,
    purchases: [{ Id: '5', TxnDate: '2026-01-01', PaymentType: 'Cash', AccountRef: BANK, Line: [expenseLine(99, 'A')] }, cardPurchase('6', '', PARENT, [expenseLine(5, 'A')])],
    journals: [journal('8', '2026-01-02', [['Debit', ref('30', 'Repairs'), 12]])],
  });
  assert(out.charges.length === 0 && out.payments.length === 0 && out.payoffs.length === 0, JSON.stringify(out));
});

const failed = results.filter(([ok]) => !ok).length;
for (const [ok, name] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(`${results.length - failed}/${results.length} passed  (${file})`);
process.exit(failed ? 1 : 0);
