const { getDb } = require('../db/schema');
const { isStale, saleProjection, syncState } = require('./bankDraws');

// Consolidated Finances (Mike, 2026-10-19): "the combined amount of money outstanding,
// combined amount of loans, combined profit potential and combined money that should be
// coming back into the company upon the sale of the property, including equity" -
// every New Urban Development project and rental (171 Davis: equity, loans, monthly
// interest) from QuickBooks. The QuickBooks side comes from the last Finance sync
// (finance_consolidated_snapshot); each project's potential sale is applied live, so a
// price edited on a Finance tab shows here at once.

const r2 = n => Math.round(Number(n || 0) * 100) / 100;
const sum = (rows, pick) => r2(rows.reduce((total, row) => total + Number(pick(row) || 0), 0));

function rowFor(group, input) {
  const projection = saleProjection(group.project_id ? input : null, group.summary, { rental: group.type === 'rental' });
  const priced = projection.potential_sale_price !== null && projection.projected_profit !== null;
  const summary = group.summary || null;
  return {
    key: group.key,
    project_id: group.project_id,
    name: group.name,
    address: group.address,
    status: group.status,
    type: group.type,
    in_buildtrack: group.in_buildtrack,
    class_names: group.class_names || [],
    match_status: group.match_status,
    sold: Boolean(group.sold),
    invested: summary ? summary.invested : null,
    loans_owed: summary ? summary.total_liabilities : null,
    escrow: summary ? summary.escrow_balance : null,
    net_debt: summary ? summary.net_debt_after_escrow : null,
    equity: summary ? summary.owner_equity : null,
    cash_in: group.cash_in,
    carried_interest: group.carried_interest || 0,
    loans: group.loans || [],
    monthly: group.monthly || null,
    potential_sale_price: projection.potential_sale_price,
    selling_costs: projection.selling_costs,
    projected_profit: priced ? projection.projected_profit : null,
    funds_returned: priced ? projection.cash_back : null,
    sale_profit: priced ? projection.sale_profit : null,
    rental_income: projection.rental_income,
    rental_expenses: projection.rental_expenses,
    rental_net: projection.rental_net,
    total_cash_in: projection.total_cash_in,
    // What comes back when it sells: the cash back at sale where a price is entered; the
    // equity (cash in) otherwise. A rental's past rent and expenses are already banked.
    coming_back: priced ? projection.cash_back : group.cash_in,
    priced,
  };
}

function totalsFor(rows) {
  const withMonthly = rows.filter(r => r.monthly);
  return {
    count: rows.length,
    invested: sum(rows, r => r.invested),
    loans_owed: sum(rows, r => r.loans_owed),
    escrow: sum(rows, r => r.escrow),
    cash_in: sum(rows, r => r.cash_in),
    equity: sum(rows, r => r.equity),
    projected_profit: sum(rows, r => r.projected_profit),
    sale_profit: sum(rows, r => r.sale_profit),
    rental_income: sum(rows, r => r.rental_income),
    rental_expenses: sum(rows, r => r.rental_expenses),
    rental_net: sum(rows, r => r.rental_net),
    coming_back: sum(rows, r => r.coming_back),
    carried_interest: sum(rows, r => r.carried_interest),
    priced_count: rows.filter(r => r.priced).length,
    unpriced: rows.filter(r => !r.priced).map(r => ({ name: r.name, project_id: r.project_id })),
    monthly: withMonthly.length ? {
      income: sum(withMonthly, r => r.monthly.income),
      expenses: sum(withMonthly, r => r.monthly.expenses),
      interest: sum(withMonthly, r => r.monthly.interest),
      net: sum(withMonthly, r => r.monthly.net),
    } : null,
  };
}

function consolidatedFinances(db = getDb()) {
  const snapshot = db.prepare("SELECT payload_json, synced_at FROM finance_consolidated_snapshot WHERE id = 'primary'").get();
  const state = syncState(db);
  const connected = Boolean(db.prepare("SELECT 1 FROM quickbooks_connections WHERE id = 'primary' AND is_active = 1").get());
  let payload = { groups: [], period: null };
  try { if (snapshot) payload = JSON.parse(snapshot.payload_json); } catch (_) { /* rebuilt on the next sync */ }
  const inputs = new Map(db.prepare('SELECT project_id, potential_sale_price, commission_pct, closing_costs_amount FROM project_finance_inputs').all().map(r => [r.project_id, r]));
  const rows = (payload.groups || []).map(g => rowFor(g, inputs.get(g.project_id)));
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'en', { numeric: true });
  const active = rows.filter(r => !r.sold && r.invested !== null).sort(byName);
  const projects = active.filter(r => r.type !== 'rental');
  const rentals = active.filter(r => r.type === 'rental');
  const loansByAccount = new Map();
  for (const row of active) {
    for (const loan of row.loans) {
      const entry = loansByAccount.get(loan.account) || { account: loan.account, amount: 0, properties: [] };
      entry.amount = r2(entry.amount + loan.amount);
      entry.properties.push({ name: row.name, amount: loan.amount });
      loansByAccount.set(loan.account, entry);
    }
  }
  return {
    quickbooks: {
      connected,
      last_synced_at: state?.last_synced_at || snapshot?.synced_at || null,
      status: state?.last_status || 'never',
      error: state?.last_status === 'error' ? state.last_error : null,
      stale: isStale(state),
      has_snapshot: Boolean(snapshot),
    },
    period: payload.period || null,
    totals: totalsFor(active),
    projects: { totals: totalsFor(projects), rows: projects },
    rentals: { totals: totalsFor(rentals), rows: rentals },
    loans_by_account: [...loansByAccount.values()].sort((a, b) => b.amount - a.amount),
    sold: rows.filter(r => r.sold).sort(byName),
    not_in_buildtrack: active.filter(r => !r.in_buildtrack).map(r => r.name),
  };
}

module.exports = { consolidatedFinances, rowFor, totalsFor };
