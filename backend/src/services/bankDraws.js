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
const LEDGER_START = '2015-01-01';
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

// Unit classes kept beside a property ("171 Davis Unit A") and true sub-classes
// belong to the property's statements too.
function relatedClassIds(cls, classes) {
  const base = normalize(cls.name);
  return classes
    .filter(c => c.id !== cls.id && (c.parentId === cls.id || (base && normalize(c.name).startsWith(`${base} unit `))))
    .map(c => c.id);
}

// Pure: decide each project's class (link, verify, or auto-match by address).
function matchProjectClasses(projects, classes) {
  const byId = new Map(classes.map(c => [c.id, c]));
  const propertyClasses = classes.filter(c => c.active && !/\(deleted/i.test(c.name) && addressKey(c.name));
  const claimed = new Set(projects.map(p => String(p.quickbooks_class_id || '').trim()).filter(Boolean));
  return projects.map(project => {
    const keys = projectKeys(project);
    const linkedId = String(project.quickbooks_class_id || '').trim();
    if (linkedId) {
      const cls = byId.get(linkedId);
      if (!cls) return { projectId: project.id, classId: linkedId, status: 'class_missing', className: project.quickbooks_class_name || null };
      return { projectId: project.id, classId: cls.id, className: cls.name, status: compareKeys(keys, addressKey(cls.name)), relatedIds: relatedClassIds(cls, classes) };
    }
    const exact = propertyClasses.filter(c => !claimed.has(c.id) && compareKeys(keys, addressKey(c.name)) === 'exact');
    // "171 Davis Unit A" belongs to "171 Davis": keep the property class, not its units.
    const candidates = exact.filter(c => !exact.some(other => other.id !== c.id && relatedClassIds(other, classes).includes(c.id)));
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
    const projects = db.prepare('SELECT id, address, job_name, quickbooks_class_id, quickbooks_class_name FROM projects').all();
    const matches = matchProjectClasses(projects, data.classes);
    const syncedAt = new Date().toISOString();
    const { lines, unmatched } = buildDrawLines(data, matches, syncedAt);
    const classNameById = new Map(data.classes.map(c => [c.id, c.name]));
    const snapshots = matches.map(m => {
      const classIds = m.classId && m.status !== 'class_missing' ? [m.classId, ...(m.relatedIds || [])] : [];
      const balanceSheet = classIds.length ? statementFor(data.balanceSheet, classIds) : { found: false, sections: [], totals: {} };
      const profitLoss = classIds.length ? statementFor(data.profitLoss, classIds) : { found: false, sections: [], totals: {} };
      return {
        project_id: m.projectId,
        class_id: m.classId,
        class_names: JSON.stringify(classIds.map(id => classNameById.get(id) || id)),
        match_json: JSON.stringify({ status: m.status, class_name: m.className || null, candidates: m.candidates || [] }),
        balance_sheet_json: JSON.stringify({ sections: balanceSheet.sections, found: balanceSheet.found }),
        profit_loss_json: JSON.stringify({ sections: profitLoss.sections, found: profitLoss.found }),
        summary_json: JSON.stringify(financeSummary(balanceSheet, profitLoss)),
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
  return {
    summary: {
      holdback_funded: holdbackFunded,
      drawn,
      escrow_adjustments: sum(row => row.kind === 'escrow_adjustment'),
      holdback_remaining: balance,
      draw_count: draws.length,
      last_draw_date: draws.length ? draws[draws.length - 1].date : null,
      last_draw_amount: draws.length ? draws[draws.length - 1].decrease : null,
      percent_drawn: holdbackFunded > 0 ? Math.min(1, Math.max(0, drawn / holdbackFunded)) : null,
    },
    register,
    finance: snapshot ? {
      class_id: snapshot.class_id,
      class_names: parseJson(snapshot.class_names, []),
      match: parseJson(snapshot.match_json, { status: 'unlinked' }),
      summary: parseJson(snapshot.summary_json, null),
      balance_sheet: parseJson(snapshot.balance_sheet_json, { sections: [], found: false }),
      profit_loss: parseJson(snapshot.profit_loss_json, { sections: [], found: false }),
      period: { start: snapshot.period_start, end: snapshot.period_end },
      synced_at: snapshot.synced_at,
    } : null,
  };
}

module.exports = {
  HOLDBACK_ACCOUNT,
  addressKey,
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
