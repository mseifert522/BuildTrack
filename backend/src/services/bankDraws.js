const { getDb } = require('../db/schema');
const { logActivity } = require('../utils/audit');

// Bank Draws (Mike, 2026-10-19): each project's own construction-loan draws, straight
// from QuickBooks, plus the project's full financing picture for its class.
//   Mike: "the bank feed will come from QuickBooks account 1130 and is allocated by
//   the class" ... "each classification is the address of the project".
//
// How New Urban Development books a construction loan (verified in the ledger
// 2026-10-19 against Mike's register paste, e.g. 2811 Wisconsin):
//   closing  Journal Entry: credit 2020 Bridge Loans (the loan), debit 1130 Funds in
//            Escrow / Holdbacks (the construction holdback the lender keeps back).
//   draw     Deposit into the operating bank account, credited to 1130, class = the
//            property. Each one is a draw.
// 1130 amounts are signed from 1130's side: positive = holdback up (set aside),
// negative = holdback down (drawn into the bank) - QuickBooks' Increase / Decrease.

const HOLDBACK_ACCOUNT = '1130';
// Far enough back for all of New Urban Development's QuickBooks history (Mike: rental
// income "going all the way back as far as QuickBooks is on record").
const LEDGER_START = '2005-01-01';
const DEFAULT_MAX_AGE_MS = 3 * 60 * 1000;
const MIN_RESYNC_MS = 20 * 1000;
const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'north', 'south', 'east', 'west', 'ne', 'nw', 'se', 'sw']);

let inFlight = null;

const r2 = n => Math.round(Number(n || 0) * 100) / 100;
const money = value => {
  const n = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const normalize = value => String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

function maxAgeMs() {
  const value = Number.parseInt(process.env.BANK_DRAW_SYNC_MAX_AGE_MS || '', 10);
  return Number.isFinite(value) && value >= 30000 ? value : DEFAULT_MAX_AGE_MS;
}

function syncState(db = getDb()) {
  return db.prepare("SELECT * FROM bank_draw_sync_state WHERE id = 'primary'").get() || null;
}

function isStale(state) {
  if (!state?.last_synced_at) return true;
  return Date.now() - Date.parse(state.last_synced_at) > maxAgeMs();
}

// ---------------------------------------------------------------------------
// Matching a project to its QuickBooks class. Every property class is named for the
// address ("2811 Wisconsin"), so the key is the house number plus the first street
// word, skipping a direction ("1132 N Blair" -> 1132 blair).
function addressKey(value) {
  const tokens = normalize(value).split(' ').filter(Boolean);
  if (!tokens.length || !/^\d+$/.test(tokens[0])) return null;
  const street = tokens.slice(1).find(token => !DIRECTIONS.has(token));
  return street ? { number: tokens[0], street } : null;
}

function projectKeys(project) {
  return [addressKey(project.address), addressKey(project.job_name)].filter(Boolean);
}

function compareKeys(projectKeyList, classKey) {
  if (!classKey) return 'mismatch';
  if (projectKeyList.some(k => k.number === classKey.number && k.street === classKey.street)) return 'exact';
  if (projectKeyList.some(k => k.street === classKey.street)) return 'number_differs';
  return 'mismatch';
}

// Every class for the same address is one property for finances (Mike, 2026-10-20: "do
// not separate by A, B, or C ... even if QuickBooks is showing separate classes,
// consolidate it because it is one class"): unit classes ("171 Davis Unit A", "171 Davis
// - Unit C", "171 Davis Apt 2", "171 Davis St Upper"...), any other class with the same
// house number and street, and true sub-classes all count toward the property - classes
// QuickBooks shows as "(deleted)" too, since entries can still sit on them.
function relatedClassIds(cls, classes) {
  const base = normalize(cls.name);
  const key = addressKey(cls.name);
  const sameAddress = c => {
    const other = key ? addressKey(c.name) : null;
    return Boolean(other && other.number === key.number && other.street === key.street);
  };
  return classes
    .filter(c => c.id !== cls.id && (c.parentId === cls.id || (base && normalize(c.name).startsWith(`${base} unit `)) || sameAddress(c)))
    .map(c => c.id);
}

// Of several classes for one address, the property's class is the shortest name
// ("171 Davis" over "171 Davis Unit A"); ties go to the lower id. The rest fold into it.
const classLeadOrder = (a, b) => normalize(a.name).length - normalize(b.name).length || String(a.id).localeCompare(String(b.id));

// Pure: decide each project's class (link, verify, or auto-match by address).
// aliasesByProject: projectId -> Set of normalized class names confirmed as the same
// property (project_class_aliases). A linked project also takes in, besides its unit
// classes, any other class named for its own address (a correctly named twin, e.g.
// "2153 Milverton" next to the mistyped "1253 Milverton") and any confirmed alias -
// so entries under either name count toward the one project.
function matchProjectClasses(projects, classes, aliasesByProject = new Map()) {
  const byId = new Map(classes.map(c => [c.id, c]));
  const isDeleted = c => /\(deleted/i.test(c.name);
  const propertyClasses = classes.filter(c => c.active && !isDeleted(c) && addressKey(c.name));
  const claimed = new Set(projects.map(p => String(p.quickbooks_class_id || '').trim()).filter(Boolean));
  return projects.map(project => {
    const keys = projectKeys(project);
    const aliases = aliasesByProject.get(project.id) || new Set();
    const linkedId = String(project.quickbooks_class_id || '').trim();
    if (linkedId) {
      const cls = byId.get(linkedId);
      if (!cls) return { projectId: project.id, classId: linkedId, status: 'class_missing', className: project.quickbooks_class_name || null };
      let status = compareKeys(keys, addressKey(cls.name));
      if (status !== 'exact' && aliases.has(normalize(cls.name))) status = 'confirmed_alias';
      const extras = classes.filter(c => c.id !== cls.id && !claimed.has(c.id) && c.active !== false && !isDeleted(c)
        && (compareKeys(keys, addressKey(c.name)) === 'exact' || aliases.has(normalize(c.name))));
      const relatedIds = [...new Set([
        ...relatedClassIds(cls, classes),
        ...extras.flatMap(c => [c.id, ...relatedClassIds(c, classes)]),
      ])].filter(id => id !== cls.id);
      return { projectId: project.id, classId: cls.id, className: cls.name, status, relatedIds, aliasNames: [...aliases] };
    }
    const exact = propertyClasses.filter(c => !claimed.has(c.id) && compareKeys(keys, addressKey(c.name)) === 'exact');
    // "171 Davis Unit A" belongs to "171 Davis": keep the property class, not its units
    // (every class for the address is one property; the shortest name leads).
    const candidates = exact.filter(c => !exact.some(other => other.id !== c.id
      && relatedClassIds(other, classes).includes(c.id) && classLeadOrder(other, c) < 0));
    if (candidates.length === 1) {
      const cls = candidates[0];
      claimed.add(cls.id);
      return { projectId: project.id, classId: cls.id, className: cls.name, status: 'auto_linked', relatedIds: relatedClassIds(cls, classes) };
    }
    const nearby = propertyClasses.filter(c => compareKeys(keys, addressKey(c.name)) !== 'mismatch').slice(0, 5).map(c => c.name);
    return { projectId: project.id, classId: null, className: null, status: candidates.length > 1 ? 'ambiguous' : 'unlinked', candidates: nearby };
  });
}

// ---------------------------------------------------------------------------
// 1130 register lines.
// draw              money released from escrow into a bank account (a Deposit, or any
//                   credit whose other side is a bank account)
// holdback_funded   the holdback set aside at closing (journal entry debit)
// escrow_adjustment anything else on 1130: lender fees, corrections, payoff at sale
function classifyLine(row, isBankSplit) {
  const debit = money(row.debt_amt);
  const credit = money(row.credit_amt);
  const type = String(row.txn_type || '');
  const amount = r2(debit - credit);
  if (credit > 0 && (type === 'Deposit' || isBankSplit(row.split_acc))) return { kind: 'draw', amount };
  if (debit > 0 && type === 'Journal Entry') return { kind: 'holdback_funded', amount };
  return { kind: 'escrow_adjustment', amount };
}

function qboTransactionUrl(type, id) {
  if (!id) return null;
  const page = {
    Deposit: 'deposit',
    'Journal Entry': 'journal',
    Transfer: 'transfer',
    Check: 'check',
    Expense: 'expense',
    Payment: 'recvpayment',
    'Bill Payment (Check)': 'billpayment',
  }[type];
  return page ? `https://app.qbo.intuit.com/app/${page}?txnId=${encodeURIComponent(id)}` : null;
}

// classId -> [projectId], including each project's unit classes.
function projectsByClassId(matches) {
  const map = new Map();
  const add = (classId, projectId) => {
    if (!classId) return;
    if (!map.has(classId)) map.set(classId, []);
    if (!map.get(classId).includes(projectId)) map.get(classId).push(projectId);
  };
  for (const m of matches) {
    if (!m.classId || m.status === 'class_missing') continue;
    add(m.classId, m.projectId);
    for (const id of m.relatedIds || []) add(id, m.projectId);
  }
  return map;
}

// Pure: ledgers + classes + matches -> mirror rows. Exported for tests.
function buildDrawLines({ classes, ledgers, bankAccountNames }, matches, syncedAt) {
  // Ledger rows carry the class NAME; map it to the id. A shared name never matches.
  const classIdByName = new Map();
  const ambiguous = new Set();
  for (const c of classes || []) {
    for (const key of new Set([normalize(c.fullName), normalize(c.name)])) {
      if (!key) continue;
      if (classIdByName.has(key) && classIdByName.get(key) !== c.id) ambiguous.add(key);
      else classIdByName.set(key, c.id);
    }
  }
  const byClass = projectsByClassId(matches);
  const banks = (bankAccountNames || []).map(normalize).filter(Boolean);
  const isBankSplit = split => {
    const key = normalize(split);
    return Boolean(key) && banks.some(bank => key === bank || key.endsWith(` ${bank}`));
  };

  const lines = [];
  let unmatched = 0;
  let sortIndex = 0;
  for (const ledger of ledgers || []) {
    const perTxn = new Map();
    for (const row of ledger.rows || []) {
      sortIndex += 1;
      const klass = normalize(row.klass_name);
      const classId = klass && !ambiguous.has(klass) ? classIdByName.get(klass) : null;
      const projectIds = classId ? byClass.get(classId) : null;
      if (!projectIds?.length) { unmatched += 1; continue; }
      const { kind, amount } = classifyLine(row, isBankSplit);
      if (!amount) continue;
      const txnKey = `${ledger.number}:${row.txn_type || ''}:${row.txnId || ''}`;
      const n = (perTxn.get(txnKey) || 0) + 1;
      perTxn.set(txnKey, n);
      for (const projectId of projectIds) {
        lines.push({
          id: `${txnKey}:${n}:${projectId}`,
          project_id: projectId,
          qbo_class_id: classId,
          account_number: ledger.number,
          account_name: ledger.name,
          kind,
          txn_date: row.tx_date || null,
          txn_type: row.txn_type || null,
          txn_id: row.txnId || null,
          doc_number: row.doc_num || null,
          payee: row.name || null,
          memo: row.memo || null,
          split_account: row.split_acc || null,
          amount,
          sort_index: sortIndex,
          synced_at: syncedAt,
        });
      }
    }
  }
  return { lines, unmatched };
}

// ---------------------------------------------------------------------------
// Statements. A report summarized by class has one money column per class (ColKey =
// class id). One project's statement = the sum of its class columns, row by row,
// with empty sections dropped.
const KEEP_ZERO_TOTALS = new Set(['GrossProfit', 'NetIncome']);

function statementFor(report, classIds) {
  const columns = (report?.Columns?.Column || []).map(c => (c.MetaData || []).find(m => m.Name === 'ColKey')?.Value || '');
  const indexes = columns.map((key, i) => (classIds.includes(String(key)) ? i : -1)).filter(i => i > 0);
  if (!indexes.length) return { found: false, sections: [], totals: {} };
  const totals = {};
  const sumCols = colData => r2(indexes.reduce((s, i) => s + money(colData?.[i]?.value), 0));
  const walk = rows => {
    const out = [];
    for (const row of rows || []) {
      if (row.Header || row.Rows || row.Summary) {
        const total = row.Summary ? sumCols(row.Summary.ColData) : null;
        if (row.group && total !== null) totals[row.group] = total;
        if (!row.Header) {
          // A summary-only row: Gross Profit, Net Operating Income, Net Income...
          if (total || KEEP_ZERO_TOTALS.has(row.group)) out.push({ kind: 'total', title: row.Summary.ColData?.[0]?.value || '', amount: total, group: row.group || null });
          continue;
        }
        const title = row.Header.ColData?.[0]?.value || '';
        const children = walk(row.Rows?.Row);
        // A parent account can carry a balance of its own on its header row.
        const own = sumCols(row.Header.ColData);
        if (own) children.unshift({ kind: 'line', account: title, accountId: row.Header.ColData?.[0]?.id || null, amount: own });
        if (!children.length && !total) continue;
        out.push({ kind: 'section', title, group: row.group || null, total, totalLabel: row.Summary?.ColData?.[0]?.value || `Total ${title}`, children });
      } else if (row.ColData) {
        const amount = sumCols(row.ColData);
        if (amount) out.push({ kind: 'line', account: row.ColData[0]?.value || '', accountId: row.ColData[0]?.id || null, amount });
      }
    }
    return out;
  };
  return { found: true, sections: walk(report?.Rows?.Row), totals };
}

function findLine(sections, predicate) {
  for (const node of sections || []) {
    if (node.kind === 'line' && predicate(node)) return node;
    if (node.kind === 'section') {
      const hit = findLine(node.children, predicate);
      if (hit) return hit;
    }
  }
  return null;
}

// Pure: one project's financing figures from its two statements.
function financeSummary(balanceSheet, profitLoss) {
  const t = balanceSheet.totals || {};
  const p = profitLoss.totals || {};
  const escrow = findLine(balanceSheet.sections, line => String(line.account).startsWith(`${HOLDBACK_ACCOUNT} `));
  const totalAssets = r2(t.TotalAssets || 0);
  const totalLiabilities = r2(t.Liabilities || 0);
  return {
    total_assets: totalAssets,
    invested: r2(t.FixedAssets || 0),
    current_assets: r2(t.CurrentAssets || 0),
    escrow_balance: r2(escrow?.amount || 0),
    total_liabilities: totalLiabilities,
    net_debt_after_escrow: r2(totalLiabilities - (escrow?.amount || 0)),
    owner_equity: r2(totalAssets - totalLiabilities),
    income: profitLoss.found ? r2(p.Income || 0) : null,
    cost_of_goods_sold: profitLoss.found ? r2(p.COGS || 0) : null,
    gross_profit: profitLoss.found ? r2(p.GrossProfit || 0) : null,
    expenses: profitLoss.found ? r2(p.Expenses || 0) : null,
    net_income: profitLoss.found ? r2(p.NetIncome || 0) : null,
  };
}

// ---------------------------------------------------------------------------
async function runSync(source, userId) {
  const db = getDb();
  const attemptAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO bank_draw_sync_state (id, last_attempt_at, last_status) VALUES ('primary', ?, 'syncing')
    ON CONFLICT(id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_status = 'syncing'
  `).run(attemptAt);
  try {
    // Required lazily: routes/quickbooks.js is the one Intuit client in this app.
    const quickBooks = require('../routes/quickbooks');
    const data = await quickBooks.projectFinanceReports([HOLDBACK_ACCOUNT], LEDGER_START);
    if (!data.ledgers.some(l => l.number === HOLDBACK_ACCOUNT)) {
      throw new Error(`QuickBooks account ${HOLDBACK_ACCOUNT} (Funds in Escrow / Holdbacks) was not found.`);
    }
    const projects = db.prepare('SELECT id, address, job_name, status, quickbooks_class_id, quickbooks_class_name FROM projects').all();
    const aliasesByProject = new Map();
    for (const row of db.prepare('SELECT project_id, alias_key FROM project_class_aliases').all()) {
      if (!aliasesByProject.has(row.project_id)) aliasesByProject.set(row.project_id, new Set());
      aliasesByProject.get(row.project_id).add(row.alias_key);
    }
    const matches = matchProjectClasses(projects, data.classes, aliasesByProject);
    const syncedAt = new Date().toISOString();
    const { lines, unmatched } = buildDrawLines(data, matches, syncedAt);
    const consolidated = buildConsolidatedGroups(data, matches, projects);
    const classNameById = new Map(data.classes.map(c => [c.id, c.name]));
    const snapshots = matches.map(m => {
      const classIds = m.classId && m.status !== 'class_missing' ? [m.classId, ...(m.relatedIds || [])] : [];
      const balanceSheet = classIds.length ? statementFor(data.balanceSheet, classIds) : { found: false, sections: [], totals: {} };
      const profitLoss = classIds.length ? statementFor(data.profitLoss, classIds) : { found: false, sections: [], totals: {} };
      return {
        project_id: m.projectId,
        class_id: m.classId,
        class_names: JSON.stringify(classIds.map(id => classNameById.get(id) || id)),
        match_json: JSON.stringify({ status: m.status, class_name: m.className || null, candidates: m.candidates || [], aliases: m.aliasNames || [] }),
        balance_sheet_json: JSON.stringify({ sections: balanceSheet.sections, found: balanceSheet.found }),
        profit_loss_json: JSON.stringify({ sections: profitLoss.sections, found: profitLoss.found }),
        summary_json: JSON.stringify(balanceSheet.found ? financeSummary(balanceSheet, profitLoss) : null),
        period_start: data.period.start,
        period_end: data.period.end,
        synced_at: syncedAt,
      };
    });
    const insertLine = db.prepare(`
      INSERT INTO project_bank_draw_lines (
        id, project_id, qbo_class_id, account_number, account_name, kind, txn_date, txn_type,
        txn_id, doc_number, payee, memo, split_account, amount, sort_index, synced_at
      ) VALUES (
        @id, @project_id, @qbo_class_id, @account_number, @account_name, @kind, @txn_date, @txn_type,
        @txn_id, @doc_number, @payee, @memo, @split_account, @amount, @sort_index, @synced_at
      )
    `);
    const insertSnapshot = db.prepare(`
      INSERT INTO project_finance_snapshots (
        project_id, class_id, class_names, match_json, balance_sheet_json, profit_loss_json,
        summary_json, period_start, period_end, synced_at
      ) VALUES (
        @project_id, @class_id, @class_names, @match_json, @balance_sheet_json, @profit_loss_json,
        @summary_json, @period_start, @period_end, @synced_at
      )
    `);
    // Link projects that had no class to the one class that matches their address.
    const linkClass = db.prepare(`
      UPDATE projects SET quickbooks_class_id = ?, quickbooks_class_name = ?
      WHERE id = ? AND (quickbooks_class_id IS NULL OR quickbooks_class_id = '')
    `);
    const autoLinked = [];
    db.transaction(() => {
      for (const m of matches) {
        if (m.status === 'auto_linked' && linkClass.run(m.classId, m.className, m.projectId).changes) autoLinked.push(m);
      }
      db.prepare('DELETE FROM project_bank_draw_lines').run();
      for (const line of lines) insertLine.run(line);
      db.prepare('DELETE FROM project_finance_snapshots').run();
      for (const snapshot of snapshots) insertSnapshot.run(snapshot);
      db.prepare(`
        INSERT INTO finance_consolidated_snapshot (id, payload_json, synced_at) VALUES ('primary', ?, ?)
        ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, synced_at = excluded.synced_at
      `).run(JSON.stringify({ groups: consolidated, period: data.period }), syncedAt);
      db.prepare(`
        UPDATE bank_draw_sync_state
        SET last_synced_at = ?, last_status = 'ok', last_error = NULL, line_count = ?, unmatched_count = ?
        WHERE id = 'primary'
      `).run(syncedAt, lines.length, unmatched);
    })();
    for (const m of userId ? autoLinked : []) {
      logActivity({
        userId,
        action: 'quickbooks_class_matched',
        entityType: 'project',
        entityId: m.projectId,
        details: { class_id: m.classId, class_name: m.className, source: 'bank_draws_address_match' },
      });
    }
    console.log(`[BankDraws] Synced ${lines.length} draw lines and ${snapshots.length} project statements from QuickBooks (${source}); ${unmatched} lines on classes with no BuildTrack project; ${autoLinked.length} projects linked by address.`);
    return syncState(db);
  } catch (err) {
    const message = String(err?.message || 'QuickBooks sync failed').slice(0, 300);
    db.prepare("UPDATE bank_draw_sync_state SET last_status = 'error', last_error = ? WHERE id = 'primary'").run(message);
    console.error('[BankDraws] Sync failed:', message);
    throw err;
  }
}

// One sync at a time; callers arriving meanwhile share it. A sync that finished in
// the last few seconds is reused instead of asking QuickBooks again.
function syncBankDraws({ source = 'manual', userId = null, force = false } = {}) {
  if (inFlight) return inFlight;
  const state = syncState();
  if (!force && state?.last_status === 'ok' && state.last_synced_at && Date.now() - Date.parse(state.last_synced_at) < MIN_RESYNC_MS) {
    return Promise.resolve(state);
  }
  inFlight = runSync(source, userId).finally(() => { inFlight = null; });
  return inFlight;
}

const parseJson = (value, fallback) => {
  try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; }
};

// The project's slice of the 1130 register, oldest first, in QuickBooks' own line
// order, with the running balance QuickBooks shows (Mike's register paste,
// 2026-10-19: Decrease = draw, Increase = holdback set aside).
function projectBankDraws(projectId, db = getDb()) {
  const rows = db.prepare(`
    SELECT * FROM project_bank_draw_lines
    WHERE project_id = ?
    ORDER BY txn_date ASC, sort_index ASC
  `).all(projectId);
  let balance = 0;
  let drawNumber = 0;
  const register = rows.map(row => {
    const amount = Number(row.amount || 0);
    balance = r2(balance + amount);
    return {
      id: row.id,
      kind: row.kind,
      draw_number: row.kind === 'draw' ? (drawNumber += 1) : null,
      date: row.txn_date,
      type: row.txn_type,
      ref_no: row.doc_number,
      payee: row.payee,
      memo: row.memo,
      account: row.split_account,
      decrease: amount < 0 ? r2(-amount) : null,
      increase: amount > 0 ? r2(amount) : null,
      balance,
      qbo_url: qboTransactionUrl(row.txn_type, row.txn_id),
    };
  });
  const sum = (filter) => r2(rows.filter(filter).reduce((total, row) => total + Number(row.amount || 0), 0));
  const draws = register.filter(row => row.kind === 'draw');
  const holdbackFunded = sum(row => row.kind === 'holdback_funded');
  const drawn = r2(-sum(row => row.kind === 'draw'));
  const snapshot = db.prepare('SELECT * FROM project_finance_snapshots WHERE project_id = ?').get(projectId);
  const financeSummaryJson = snapshot ? parseJson(snapshot.summary_json, null) : null;
  const input = db.prepare(`
    SELECT i.potential_sale_price, i.commission_pct, i.closing_costs_amount, i.updated_at, u.name AS updated_by_name
    FROM project_finance_inputs i LEFT JOIN users u ON u.id = i.updated_by
    WHERE i.project_id = ?
  `).get(projectId);
  const projectStatus = db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId)?.status || null;
  const rental = isLongTermHolding(projectStatus);
  const finance = snapshot ? {
    class_id: snapshot.class_id,
    class_names: parseJson(snapshot.class_names, []),
    match: parseJson(snapshot.match_json, { status: 'unlinked' }),
    summary: financeSummaryJson,
    balance_sheet: parseJson(snapshot.balance_sheet_json, { sections: [], found: false }),
    profit_loss: parseJson(snapshot.profit_loss_json, { sections: [], found: false }),
    period: { start: snapshot.period_start, end: snapshot.period_end },
    synced_at: snapshot.synced_at,
  } : null;
  return {
    rental,
    projection: {
      ...saleProjection(input, financeSummaryJson, { rental }),
      updated_at: input?.updated_at || null,
      updated_by_name: input?.updated_by_name || null,
    },
    summary: rental ? { ...EMPTY_DRAW_SUMMARY } : {
      holdback_funded: holdbackFunded,
      drawn,
      escrow_adjustments: sum(row => row.kind === 'escrow_adjustment'),
      holdback_remaining: balance,
      draw_count: draws.length,
      last_draw_date: draws.length ? draws[draws.length - 1].date : null,
      last_draw_amount: draws.length ? draws[draws.length - 1].decrease : null,
      percent_drawn: holdbackFunded > 0 ? Math.min(1, Math.max(0, drawn / holdbackFunded)) : null,
    },
    register: rental ? [] : register,
    finance: rental ? rentalFinanceView(finance) : finance,
  };
}

// ---------------------------------------------------------------------------
// Consolidated Finances (Mike, 2026-10-19): every New Urban Development property in
// QuickBooks - BuildTrack projects (with their unit / alias / twin classes) and any
// other address-named class that still carries a balance - as one group each. Sold
// properties (a 4200 sale line in the life-to-date P&L) are flagged so their leftover
// balances stay out of the totals. Pure; exported for tests.
const lineNodes = nodes => (nodes || []).flatMap(n => (n.kind === 'line' ? [n] : n.kind === 'section' ? lineNodes(n.children) : []));
const findSection = (nodes, predicate) => {
  for (const n of nodes || []) {
    if (n.kind !== 'section') continue;
    if (predicate(n)) return n;
    const hit = findSection(n.children, predicate);
    if (hit) return hit;
  }
  return null;
};
const sumLines = (lines, predicate) => r2(lines.filter(predicate).reduce((s, l) => s + Number(l.amount || 0), 0));

function groupFigures(reports, classIds) {
  const bs = statementFor(reports.balanceSheet, classIds);
  const pl = statementFor(reports.profitLoss, classIds);
  const ttm = reports.profitLossTtm ? statementFor(reports.profitLossTtm, classIds) : { found: false, sections: [], totals: {} };
  const summary = bs.found ? financeSummary(bs, pl) : null;
  const liabilitiesSection = findSection(bs.sections, n => n.group === 'Liabilities' || /^liabilities$/i.test(n.title));
  const loans = lineNodes(liabilitiesSection?.children).map(l => ({ account: l.account, amount: r2(l.amount) })).filter(l => l.amount);
  const assetLines = lineNodes(bs.sections);
  const plLines = lineNodes(pl.sections);
  const expenseSections = ttm.sections.filter(n => n.kind === 'section' && !/^income$|^other income$/i.test(n.title));
  const ttmExpenseLines = lineNodes(expenseSections);
  const monthly = ttm.found ? {
    income: r2((ttm.totals.Income || 0) / 12),
    expenses: r2(((ttm.totals.COGS || 0) + (ttm.totals.Expenses || 0) + (ttm.totals.OtherExpenses || 0)) / 12),
    interest: r2(sumLines(ttmExpenseLines, l => /interest/i.test(l.account)) / 12),
    net: r2((ttm.totals.NetIncome || 0) / 12),
  } : null;
  return {
    found: bs.found,
    summary,
    cash_in: summary ? r2(summary.invested - summary.net_debt_after_escrow) : null,
    loans,
    carried_interest: sumLines(assetLines, l => String(l.account).startsWith('1235 ')),
    sold: plLines.some(l => String(l.account).startsWith('4200')),
    has_balance: Boolean(summary) && (Math.abs(summary.total_assets) >= 0.01 || Math.abs(summary.total_liabilities) >= 0.01),
    monthly,
  };
}

function buildConsolidatedGroups(reports, matches, projects) {
  const classes = reports.classes || [];
  const byId = new Map(classes.map(c => [c.id, c]));
  const projectById = new Map(projects.map(p => [p.id, p]));
  const groups = [];
  const claimed = new Set();
  for (const m of matches) {
    const project = projectById.get(m.projectId);
    if (!project || !m.classId || m.status === 'class_missing') continue;
    const classIds = [m.classId, ...(m.relatedIds || [])];
    classIds.forEach(id => claimed.add(id));
    const figures = groupFigures(reports, classIds);
    groups.push({
      key: `project:${project.id}`,
      project_id: project.id,
      name: (project.job_name || project.address || '').trim(),
      address: project.address || null,
      status: project.status || null,
      in_buildtrack: true,
      type: project.status === 'long_term_holding' ? 'rental' : 'project',
      class_names: classIds.map(id => byId.get(id)?.name || id),
      match_status: m.status,
      ...figures,
    });
  }
  // Address-named classes with a balance that no BuildTrack project claims.
  const isDeleted = c => /\(deleted/i.test(c.name);
  // One group per address: the shortest class name leads and every other class for the
  // address (units, twins) folds in, so a property never shows up split.
  const candidates = classes.filter(c => !claimed.has(c.id) && !isDeleted(c) && addressKey(c.name)).sort(classLeadOrder);
  for (const cls of candidates) {
    if (claimed.has(cls.id)) continue;
    const classIds = [cls.id, ...relatedClassIds(cls, classes).filter(id => !claimed.has(id))];
    classIds.forEach(id => claimed.add(id));
    const figures = groupFigures(reports, classIds);
    if (!figures.has_balance) continue;
    groups.push({
      key: `class:${cls.id}`,
      project_id: null,
      name: cls.name,
      address: null,
      status: null,
      in_buildtrack: false,
      type: !figures.sold && (figures.monthly?.income || 0) > 0 ? 'rental' : 'project',
      class_names: classIds.map(id => byId.get(id)?.name || id),
      match_status: null,
      ...figures,
    });
  }
  return groups;
}

// Potential sale (Mike, 2026-10-19): a manually entered "what the house could sell
// for", less the realtor commission (3% standard, adjustable per property) and the
// closing costs entered in dollars. Against the class's balance sheet: paying off what
// is owed (net of the holdback the lender still holds) leaves the cash back at sale;
// the net proceeds over what is invested in the property is the projected profit.
// "Approximate funds to be returned" (Mike, 2026-10-19) = cash in the project
// (invested minus what the loans take back at payoff) + projected profit, which is the
// same number as the cash back at sale.
// Rentals - long-term holdings, BuildTrack status Long Term Holding, e.g. 171 Davis
// (Mike, 2026-10-20, replacing the 10-19 rent-and-expenses version): a rental has no
// projected profit. It shows only the potential sale less the commission and selling
// (closing) costs, less what is currently owed, and that is its "equity / cash return in
// total" - the cash expected back to the company after the sale. Profit and loss (rent,
// expenses), invested and cash-in figures are kept out of a rental's numbers entirely.
// Pure; exported for tests.
const DEFAULT_COMMISSION_PCT = 3;

const isLongTermHolding = status => status === 'long_term_holding';

function saleProjection(input, summary, { rental = false } = {}) {
  const num = value => (value === null || value === undefined || value === '' ? null : Number(value));
  const price = input ? num(input.potential_sale_price) : null;
  const commissionPct = input && Number.isFinite(num(input.commission_pct)) ? num(input.commission_pct) : DEFAULT_COMMISSION_PCT;
  const closingCosts = input && Number.isFinite(num(input.closing_costs_amount)) ? r2(num(input.closing_costs_amount)) : 0;
  // What is currently owed: every liability on the class, net of any holdback the lender
  // still holds (it comes off the payoff).
  const loanPayoff = summary ? r2(summary.net_debt_after_escrow) : null;
  // A rental carries no invested / cash-in / profit figures (see above).
  const invested = summary && !rental ? r2(summary.invested) : null;
  // Cash in the project needs only the balance sheet, so it shows before a price is entered.
  const cashIn = loanPayoff === null || invested === null ? null : r2(invested - loanPayoff);
  const pnlFree = { rental_income: null, rental_expenses: null, rental_net: null, total_cash_in: null };
  const empty = {
    is_rental: Boolean(rental),
    potential_sale_price: null, commission_pct: commissionPct, commission: null, closing_costs: closingCosts,
    selling_costs: null, net_proceeds: null, loan_payoff: loanPayoff, cash_back: null, invested, cash_in: cashIn,
    sale_profit: null, projected_profit: null, equity_cash_return: null, ...pnlFree,
  };
  if (price === null || !Number.isFinite(price)) return empty;
  const commission = r2(price * commissionPct / 100);
  const sellingCosts = r2(commission + closingCosts);
  const netProceeds = r2(price - sellingCosts);
  const cashBack = loanPayoff === null ? null : r2(netProceeds - loanPayoff);
  const saleProfit = invested === null ? null : r2(netProceeds - invested);
  return {
    ...empty,
    potential_sale_price: r2(price),
    commission,
    selling_costs: sellingCosts,
    net_proceeds: netProceeds,
    cash_back: cashBack,
    sale_profit: rental ? null : saleProfit,
    projected_profit: rental ? null : saleProfit,
    // A rental's bottom line: the total cash expected back after the sale.
    equity_cash_return: rental ? cashBack : null,
  };
}

// Rentals show no construction draws (Mike, 2026-10-20: "there are no more draws coming
// from any banks" - 171 Davis's 2025 holdback was set aside 07-29 and drawn in full
// 08-19 on a bridge loan since paid off) and no profit and loss; their balance sheet is
// cut to what is owed. The 1130 lines stay in QuickBooks and in the synced table; they are
// simply not part of a rental's Finance tab.
function rentalFinanceView(finance) {
  if (!finance) return finance;
  const liabilities = findSection(finance.balance_sheet?.sections, n => n.group === 'Liabilities' || /^liabilities$/i.test(n.title));
  const summary = finance.summary || null;
  return {
    ...finance,
    summary: summary ? {
      total_liabilities: summary.total_liabilities,
      escrow_balance: summary.escrow_balance,
      net_debt_after_escrow: summary.net_debt_after_escrow,
    } : null,
    balance_sheet: { found: Boolean(liabilities), sections: liabilities ? [liabilities] : [] },
    profit_loss: { found: false, sections: [] },
  };
}

const EMPTY_DRAW_SUMMARY = {
  holdback_funded: 0, drawn: 0, escrow_adjustments: 0, holdback_remaining: 0,
  draw_count: 0, last_draw_date: null, last_draw_amount: null, percent_drawn: null,
};

module.exports = {
  isLongTermHolding,
  buildConsolidatedGroups,
  relatedClassIds,
  normalizeClassName: normalize,
  DEFAULT_COMMISSION_PCT,
  HOLDBACK_ACCOUNT,
  addressKey,
  saleProjection,
  buildDrawLines,
  classifyLine,
  financeSummary,
  isStale,
  matchProjectClasses,
  projectBankDraws,
  statementFor,
  syncBankDraws,
  syncState,
};
