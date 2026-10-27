'use strict';
// Invoice <-> QuickBooks monitor (Mike, 2026-10-26): every invoice that comes in by
// email must match what the operations manager enters in QuickBooks - including an
// invoice entered as two bills ("First Half" / "Second Half"), in parts, or as one bill
// whose class lines split it across projects - and one monitor watches everything
// that moves through the email box, the BuildTrack invoices and QuickBooks.
//
// It reads only BuildTrack's QuickBooks mirror (quickbooks_bills / _lines /
// _attachments + the Cost Analyzer's read of each attachment), which the QuickBooks
// sync keeps current from Intuit's change feed - it never calls the Intuit API itself
// and never writes to QuickBooks. Each run (every few minutes, and shortly after any
// QuickBooks or inbox change):
//   * links each emailed BuildTrack invoice to the bill(s) entered for it
//     (invoice_qbo_links): the same attached document, the full amount, two halves,
//     parts adding up to it, or one bill split across projects - same vendor only;
//   * files an emailed invoice the AI could not place under the project the office
//     chose in QuickBooks (one BuildTrack invoice per project when the bill splits it);
//   * QuickBooks is the source of truth (Mike, 2026-10-27): a linked invoice follows its
//     bill(s) - an edited bill amount, the class (project) the office entered it under,
//     and the total;
//   * keeps one reconciliation row per emailed invoice and raises issues for what does
//     not match and cannot follow on its own: not entered after a few days, partly
//     entered, more entered than invoiced, a project it cannot move to, a linked bill
//     deleted in QuickBooks;
//   * checks every recent QuickBooks bill: possible double entry, a bill for a document
//     the AI read as an estimate, an attached document whose total differs;
//   * records everything in invoice_monitor_events (shared with the inbox agent) and
//     emails the office once per new issue.
// Env: INVOICE_MONITOR_ENABLED (false on a blue-green "green"), INVOICE_MONITOR_SINCE
// (bills checked from this date, default 2026-08-01), INVOICE_MONITOR_GRACE_DAYS (3),
// INVOICE_MONITOR_INTERVAL_MS (300000).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { getDb } = require('../db/schema');
const { logActivity } = require('../utils/audit');
const { looseVendorKey } = require('../utils/vendorDirectory');

const DELETED_STATUS = 'deleted_from_buildtrack';
const ADJUSTMENT_LINE = 'Adjustment to match QuickBooks';
// How far back a vendor's QuickBooks classes are offered as the likely project.
const SUGGEST_DAYS = 120;
const CENT = 0.015;
const HALF_TOLERANCE = 0.02;
// A bill for an invoice is dated on/after the invoice date (slack for typos); without a
// printed date, up to this many days before the email; and never long after.
const INVOICE_DATE_SLACK_DAYS = 3;
const WINDOW_BEFORE_DAYS = 21;
const WINDOW_AFTER_DAYS = 120;
// The office may enter a bill from a paper copy before the email arrives - not weeks before.
const ENTERED_BEFORE_EMAIL_DAYS = 21;
// Same vendor, amount and description this close together looks like a double entry;
// further apart it is usually a recurring service.
const DOUBLE_ENTRY_DAYS = 10;
const ESTIMATE_DAYS = 60;
const MAX_PARTS = 4;
const KICK_DELAY_MS = 5000;
const NOTIFY_EVERY_MS = 10 * 60 * 1000;
const MATCHED_STATUSES = new Set(['matched', 'matched_split']);
const STATUS_LABELS = {
  matched: 'Matches QuickBooks',
  matched_split: 'Matches QuickBooks (split)',
  partially_entered: 'Partly in QuickBooks',
  waiting_for_quickbooks: 'Waiting for QuickBooks',
  not_in_quickbooks: 'Not in QuickBooks',
  amount_mismatch: 'Amount differs from QuickBooks',
  over_entered: 'More in QuickBooks than invoiced',
};
const PART_LABELS = {
  full: 'full invoice',
  first_half: 'first half',
  second_half: 'second half',
  part: 'part',
  project_share: 'project share',
};

const state = {
  timer: null,
  kickTimer: null,
  running: false,
  rerun: false,
  lastRunAt: null,
  lastError: null,
  lastResult: null,
  lastNotifyAt: 0,
};

function log(message) { console.log(`[INVOICE-MONITOR] ${message}`); }
function warn(message) { console.warn(`[INVOICE-MONITOR] ${message}`); }

function enabled() {
  return String(process.env.INVOICE_MONITOR_ENABLED || 'true').trim().toLowerCase() !== 'false';
}

function sinceDate() {
  const raw = String(process.env.INVOICE_MONITOR_SINCE || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '2026-08-01';
}

function graceDays() {
  const n = Number.parseInt(process.env.INVOICE_MONITOR_GRACE_DAYS || '3', 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

const round2 = n => Math.round(Number(n || 0) * 100) / 100;
const near = (a, b, tolerance = CENT) => Math.abs(Number(a) - Number(b)) < tolerance;

function money(n) {
  return `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function text(value, max = 300) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// SQLite datetime('now') strings are UTC without a zone.
function toMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return Date.parse(`${raw}T12:00:00Z`);
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  return Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`);
}

function dayGap(a, b) {
  const ma = toMs(a);
  const mb = toMs(b);
  return Number.isFinite(ma) && Number.isFinite(mb) ? (mb - ma) / 86400000 : null;
}

function chunks(list, size = 400) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// ── the feed ─────────────────────────────────────────────────────────────────

function logEvent(db, event) {
  try {
    db.prepare(`
      INSERT INTO invoice_monitor_events (id, source, kind, severity, invoice_id, qbo_bill_id, intake_id, project_id, message, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(), event.source, event.kind, event.severity || 'info', event.invoiceId || null, event.qboBillId || null,
      event.intakeId || null, event.projectId || null, text(event.message, 600),
      event.details ? JSON.stringify(event.details) : null
    );
  } catch (err) {
    warn(`could not record an event: ${err.message}`);
  }
}

// ── QuickBooks side ──────────────────────────────────────────────────────────

const HALF_PATTERNS = [
  [/\bfirst\s+half\b|\b1st\s+half\b/i, 'first_half'],
  [/\bsecond\s+half\b|\b2nd\s+half\b/i, 'second_half'],
];

function halfOf(note) {
  for (const [pattern, part] of HALF_PATTERNS) if (pattern.test(note)) return part;
  return /\bhalf\b|\b1\/2\b/i.test(note) ? 'half' : null;
}

function attachmentSha(db, attachment) {
  if (attachment.content_hash) return attachment.content_hash;
  const cached = db.prepare('SELECT sha256 FROM qbo_attachment_hashes WHERE attachment_id = ?').get(attachment.id);
  if (cached) return cached.sha256;
  let sha = null;
  try {
    const file = require('./costAnalyzerExtraction').resolveAttachmentPath(attachment);
    if (file && fs.existsSync(file)) sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch (_) {
    sha = null;
  }
  db.prepare('INSERT OR REPLACE INTO qbo_attachment_hashes (attachment_id, sha256, checked_at) VALUES (?, ?, datetime(\'now\'))').run(attachment.id, sha);
  return sha;
}

// Every QuickBooks bill from INVOICE_MONITOR_SINCE on, with its lines and documents.
function loadBills(db) {
  const rows = db.prepare(`
    SELECT qbo_id, vendor_id, vendor_name, doc_number, txn_date, total_amt, balance, payment_status,
           payment_approval_status, private_note, project_id, matched_invoice_id, sync_token, first_seen_at, qbo_created_at
    FROM quickbooks_bills
    WHERE COALESCE(txn_date, substr(first_seen_at, 1, 10)) >= ?
       OR qbo_id IN (SELECT qbo_bill_id FROM invoice_qbo_links)
  `).all(sinceDate());
  const ids = rows.map(row => String(row.qbo_id));
  const linesByBill = new Map();
  const docsByBill = new Map();
  for (const part of chunks(ids)) {
    const marks = part.map(() => '?').join(',');
    db.prepare(`
      SELECT qbo_bill_id, project_id, amount, class_name, description
      FROM quickbooks_bill_lines WHERE qbo_bill_id IN (${marks}) ORDER BY line_num
    `).all(...part).forEach(line => {
      const list = linesByBill.get(String(line.qbo_bill_id)) || [];
      list.push(line);
      linesByBill.set(String(line.qbo_bill_id), list);
    });
    db.prepare(`
      SELECT a.id, a.qbo_bill_id, a.filename, d.content_hash, d.document_total, d.totals_match, d.totals_match_reason, d.status AS read_status
      FROM quickbooks_bill_attachments a
      LEFT JOIN cost_analyzer_documents d ON d.attachment_id = a.id
      WHERE a.qbo_bill_id IN (${marks})
    `).all(...part).forEach(doc => {
      const list = docsByBill.get(String(doc.qbo_bill_id)) || [];
      list.push(doc);
      docsByBill.set(String(doc.qbo_bill_id), list);
    });
  }
  return rows.map(row => {
    const id = String(row.qbo_id);
    const lines = linesByBill.get(id) || [];
    const note = [row.private_note, ...lines.map(line => line.description)].filter(Boolean).join(' ');
    const shares = new Map();
    for (const line of lines) {
      if (!line.project_id) continue;
      shares.set(line.project_id, round2((shares.get(line.project_id) || 0) + Number(line.amount || 0)));
    }
    if (!shares.size && row.project_id) shares.set(row.project_id, round2(row.total_amt));
    return {
      id,
      row,
      vendorId: row.vendor_id ? String(row.vendor_id) : '',
      vendorKey: looseVendorKey(row.vendor_name),
      vendorName: row.vendor_name || 'Unknown vendor',
      total: round2(row.total_amt),
      balance: round2(row.balance),
      paid: row.payment_status === 'paid' || Number(row.balance || 0) <= 0,
      date: row.txn_date || String(row.first_seen_at || '').slice(0, 10),
      note: text(note, 500),
      noteKey: text(row.private_note || lines.map(line => line.description).join(' '), 300).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
      half: halfOf(note),
      deleted: row.payment_approval_status === DELETED_STATUS,
      shares,
      docs: docsByBill.get(id) || [],
      classNames: [...new Set(lines.map(line => line.class_name).filter(Boolean))],
    };
  });
}

function billLabel(bill) {
  return `QuickBooks bill ${bill.id} (${bill.vendorName} ${money(bill.total)}${bill.note ? `, "${text(bill.note, 80)}"` : ''})`;
}

// ── who is the vendor, which documents ───────────────────────────────────────

function vendorIdentity(db, { vendorName, vendorProfileId, quickbooksVendorId, quickbooksVendorName }) {
  const names = [vendorName, quickbooksVendorName];
  const ids = [quickbooksVendorId];
  if (vendorProfileId) {
    const profile = db.prepare(`
      SELECT vendor_name, quickbooks_vendor_id, quickbooks_display_name, quickbooks_company_name, quickbooks_print_on_check_name
      FROM contractor_profiles WHERE id = ?
    `).get(vendorProfileId);
    if (profile) {
      names.push(profile.vendor_name, profile.quickbooks_display_name, profile.quickbooks_company_name, profile.quickbooks_print_on_check_name);
      ids.push(profile.quickbooks_vendor_id);
    }
  }
  return {
    keys: new Set(names.map(looseVendorKey).filter(Boolean)),
    ids: new Set(ids.filter(Boolean).map(String)),
  };
}

function sameVendor(identity, bill) {
  return Boolean((bill.vendorId && identity.ids.has(bill.vendorId)) || (bill.vendorKey && identity.keys.has(bill.vendorKey)));
}

function numberKey(value) {
  const key = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return key.length >= 3 ? key : '';
}

// Does the bill's text carry this invoice number as whole word(s)? ("1858" is in
// "Oak #1858 roof" and "INV-2026-09-001" in "inv 2026 09 001", but "100" is not in "1004".)
function noteHasNumber(noteKey, key) {
  if (!key || !noteKey) return false;
  const tokens = noteKey.split(' ').filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    let joined = '';
    for (let j = i; j < tokens.length && joined.length < key.length; j += 1) {
      joined += tokens[j];
      if (joined === key) return true;
    }
  }
  return false;
}

// ── choosing the bills an invoice was entered as ─────────────────────────────

function pairHalves(list) {
  const firsts = list.filter(bill => bill.half === 'first_half');
  const seconds = list.filter(bill => bill.half === 'second_half');
  for (const first of firsts) {
    const second = seconds.find(bill => bill !== first && near(bill.total, first.total, HALF_TOLERANCE));
    if (second) return [first, second];
  }
  return list.length >= 2 ? [list[0], list[1]] : null;
}

function subsetSummingTo(pool, total) {
  const best = [];
  const walk = (start, picked, sum) => {
    if (best.length) return;
    if (picked.length >= 2 && near(sum, total, HALF_TOLERANCE)) { best.push(...picked); return; }
    if (picked.length >= MAX_PARTS || sum > total + HALF_TOLERANCE) return;
    for (let i = start; i < pool.length; i += 1) walk(i + 1, [...picked, pool[i]], sum + pool[i].total);
  };
  walk(0, [], 0);
  return best.length ? best : null;
}

// -> { bills, method, partial } or null. `candidates` are same-vendor, unlinked bills.
function chooseBills(candidates, { total, projectId, docHashes, invoiceNumber, refDate }) {
  if (!candidates.length || !(total > 0)) return null;
  const byFit = list => [...list].sort((a, b) => {
    const pa = projectId && a.shares.has(projectId) ? 0 : 1;
    const pb = projectId && b.shares.has(projectId) ? 0 : 1;
    return pa - pb || Math.abs(dayGap(refDate, a.date) || 0) - Math.abs(dayGap(refDate, b.date) || 0);
  });
  const key = numberKey(invoiceNumber);
  const strong = candidates.filter(bill => carriesDocument(bill, docHashes) || noteHasNumber(bill.noteKey, key));
  if (strong.length) {
    let chosen = byFit(strong).slice(0, MAX_PARTS);
    if (chosen.length === 1 && chosen[0].half) {
      const partner = candidates.find(bill => bill !== chosen[0] && bill.half && bill.half !== chosen[0].half
        && near(bill.total, chosen[0].total, HALF_TOLERANCE));
      if (partner) chosen = [chosen[0], partner];
    }
    const sum = round2(chosen.reduce((acc, bill) => acc + bill.total, 0));
    return { bills: chosen, method: 'document', partial: sum < total - HALF_TOLERANCE };
  }
  const pool = byFit(candidates);
  // Amount-only matches must be unambiguous: a vendor that bills the same amount every
  // week (junk removal, lawn care) leaves it to the office instead of a coin-flip.
  const inProject = list => (projectId ? list.filter(bill => bill.shares.has(projectId)) : []);
  const fulls = pool.filter(bill => near(bill.total, total));
  const full = fulls.length === 1 ? fulls[0] : (inProject(fulls).length === 1 ? inProject(fulls)[0] : null);
  if (full) return { bills: [full], method: 'amount', partial: false };
  if (fulls.length > 1) return null;
  const halves = pool.filter(bill => near(bill.total, total / 2, HALF_TOLERANCE));
  const firsts = halves.filter(bill => bill.half === 'first_half');
  const seconds = halves.filter(bill => bill.half === 'second_half');
  if (firsts.length === 1 && seconds.length === 1) return { bills: [firsts[0], seconds[0]], method: 'halves', partial: false };
  if (halves.length === 2 && firsts.length <= 1 && seconds.length <= 1) return { bills: pairHalves(halves), method: 'halves', partial: false };
  if (halves.length === 1 && halves[0].half) return { bills: [halves[0]], method: 'halves', partial: true };
  if (halves.length > 1) return null;
  const partPool = pool.filter(bill => bill.total < total && (bill.half || /\b(part|deposit|progress|balance|final|draw)\b/i.test(bill.note)));
  const parts = subsetSummingTo(partPool.slice(0, 10), total);
  if (parts) return { bills: parts, method: 'parts', partial: false };
  return null;
}

function partFor(bill, count) {
  if (bill.half === 'first_half' || bill.half === 'second_half') return bill.half;
  return count === 1 ? 'full' : 'part';
}

// ── reconciling one emailed invoice ──────────────────────────────────────────

function docHashesForInvoice(db, invoiceId) {
  return new Set(db.prepare('SELECT document_sha256 FROM invoice_inbox_items WHERE invoice_id = ? AND document_sha256 IS NOT NULL')
    .all(invoiceId).map(row => row.document_sha256));
}

// The office attached the very document that was emailed to this bill in QuickBooks -
// the same invoice even when the vendor is spelled differently there.
function carriesDocument(bill, docHashes) {
  return bill.docs.some(doc => doc.sha && docHashes.has(doc.sha));
}

function linkBills(db, invoice, chosen, billsById) {
  const insert = db.prepare(`
    INSERT INTO invoice_qbo_links (id, invoice_id, qbo_bill_id, amount, part, method)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(invoice_id, qbo_bill_id) DO UPDATE SET amount = excluded.amount, part = excluded.part, updated_at = datetime('now')
  `);
  for (const bill of chosen.bills) {
    const part = chosen.part || partFor(bill, chosen.bills.length);
    const amount = chosen.amountFor ? chosen.amountFor(bill) : bill.total;
    insert.run(uuidv4(), invoice.id, bill.id, amount, part, chosen.method);
    db.prepare('UPDATE quickbooks_bills SET matched_invoice_id = ? WHERE qbo_id = ?').run(invoice.id, bill.id);
    billsById.get(bill.id).linkedTo = invoice.id;
    logEvent(db, {
      source: 'monitor',
      kind: 'linked',
      invoiceId: invoice.id,
      qboBillId: bill.id,
      projectId: invoice.project_id,
      message: `${invoice.invoice_number} (${invoice.vendor_name} ${money(invoice.total)}) matched to ${billLabel(bill)} as the ${PART_LABELS[part]}.`,
    });
  }
}

// Issues for one invoice, from its links and the bills behind them.
function invoiceStatus(invoice, links, billsById, now) {
  const total = round2(invoice.total);
  const bills = links.map(link => ({ link, bill: billsById.get(String(link.qbo_bill_id)) || null }));
  const live = bills.filter(entry => entry.bill && !entry.bill.deleted);
  const quickbooksTotal = round2(live.reduce((acc, entry) => acc + Number(entry.link.amount || 0), 0));
  const paidAmount = round2(live.reduce((acc, entry) => acc + (entry.bill.paid ? Number(entry.link.amount || 0) : 0), 0));
  const age = dayGap(invoice.created_at, now) || 0;
  const issues = [];
  let status;
  if (!live.length) {
    status = age > graceDays() ? 'not_in_quickbooks' : 'waiting_for_quickbooks';
    // Emailed invoices from before the monitor's window are shown, never chased.
    if (status === 'not_in_quickbooks' && String(invoice.created_at || '').slice(0, 10) >= sinceDate()) {
      issues.push({
        key: `not_in_qb:${invoice.id}`, kind: 'not_in_quickbooks', severity: 'warning',
        message: `${invoice.invoice_number} - ${invoice.vendor_name} ${money(total)} came in by email ${Math.floor(age)} days ago and is not in QuickBooks yet.`,
      });
    }
  } else if (near(quickbooksTotal, total)) {
    status = live.length === 1 && live[0].link.part === 'full' ? 'matched' : 'matched_split';
  } else if (quickbooksTotal < total) {
    const halves = live.some(entry => entry.link.part !== 'full');
    status = halves ? 'partially_entered' : 'amount_mismatch';
    if (!halves) {
      issues.push({
        key: `amount:${invoice.id}`, kind: 'amount_mismatch', severity: 'alert',
        message: `${invoice.invoice_number} - ${invoice.vendor_name}: the invoice is ${money(total)} but QuickBooks has ${money(quickbooksTotal)} (${live.map(entry => `bill ${entry.bill.id}`).join(', ')}).`,
      });
    } else if (age > graceDays()) {
      issues.push({
        key: `partial:${invoice.id}`, kind: 'partially_entered', severity: 'warning',
        message: `${invoice.invoice_number} - ${invoice.vendor_name} ${money(total)}: only ${money(quickbooksTotal)} is in QuickBooks (${live.map(entry => `${PART_LABELS[entry.link.part]} bill ${entry.bill.id}`).join(', ')}); ${money(total - quickbooksTotal)} is not entered yet.`,
      });
    }
  } else {
    status = 'over_entered';
    issues.push({
      key: `over:${invoice.id}`, kind: 'over_entered', severity: 'alert',
      message: `${invoice.invoice_number} - ${invoice.vendor_name}: the invoice is ${money(total)} but QuickBooks has ${money(quickbooksTotal)} entered for it (${live.map(entry => `bill ${entry.bill.id}`).join(', ')}) - possible double entry.`,
    });
  }
  const billProjects = new Set();
  for (const entry of live) for (const projectId of entry.bill.shares.keys()) billProjects.add(projectId);
  // Only what could not follow QuickBooks on its own (see followQuickBooks).
  if (invoice.project_id && billProjects.size && !billProjects.has(invoice.project_id)) {
    const classes = [...new Set(live.flatMap(entry => entry.bill.classNames))].join(', ') || 'another project';
    const why = {
      scope_tasks: ' It is tied to scope tasks on its BuildTrack project, so move it by hand.',
      split: ' QuickBooks splits it across several classes.',
    }[invoice.moveBlocked] || '';
    issues.push({
      key: `project:${invoice.id}`, kind: 'project_mismatch', severity: 'alert',
      message: `${invoice.invoice_number} - ${invoice.vendor_name} ${money(total)} is filed to ${invoice.project_address || 'its project'}, but QuickBooks has it under ${classes}.${why}`,
    });
  }
  for (const entry of bills) {
    if (entry.bill && !entry.bill.deleted) continue;
    issues.push({
      key: `deleted:${invoice.id}:${entry.link.qbo_bill_id}`, kind: 'quickbooks_deleted', severity: 'alert',
      message: `QuickBooks bill ${entry.link.qbo_bill_id} that ${invoice.invoice_number} (${invoice.vendor_name}) was entered as is no longer in QuickBooks.`,
    });
  }
  return { status, quickbooksTotal, paidAmount, billCount: live.length, issues };
}

function reconcileInvoices(db, bills, billsById, now, fileMoves = []) {
  const invoices = db.prepare(`
    SELECT i.*, p.address AS project_address
    FROM invoices i
    LEFT JOIN projects p ON p.id = i.project_id
    WHERE i.source = 'email'
    ORDER BY datetime(i.created_at) ASC
  `).all();
  const linksFor = db.prepare('SELECT * FROM invoice_qbo_links WHERE invoice_id = ? ORDER BY created_at');
  // When each emailed invoice actually arrived (the inbox's email), for the date window.
  const receivedAtFor = new Map(db.prepare(`
    SELECT a.invoice_id, MIN(e.received_at) AS received_at
    FROM invoice_inbox_items a JOIN invoice_email_intake e ON e.id = a.intake_id
    WHERE a.invoice_id IS NOT NULL GROUP BY a.invoice_id
  `).all().map(row => [row.invoice_id, row]));
  const issues = [];
  let linked = 0;
  let changed = 0;
  let followed = 0;
  for (const invoice of invoices) {
    let links = linksFor.all(invoice.id);
    // Nothing to match: $0 records, and old emailed invoices from before the window.
    if (!(Number(invoice.total) > 0) || (!links.length && String(invoice.created_at || '').slice(0, 10) < sinceDate())) {
      db.prepare('DELETE FROM invoice_reconciliation WHERE invoice_id = ?').run(invoice.id);
      continue;
    }
    const receivedAt = receivedAtFor.get(invoice.id)?.received_at || invoice.created_at;
    const window = { invoiceDate: invoice.vendor_invoice_date || null, receivedAt };
    // A full-amount bill the QuickBooks sync already matched: adopt it - only when it is
    // dated for this invoice (the sync once matched an August $250 bill to an October one).
    if (!links.length && invoice.quickbooks_bill_id && billsById.has(String(invoice.quickbooks_bill_id))) {
      const bill = billsById.get(String(invoice.quickbooks_bill_id));
      if ((!bill.linkedTo || bill.linkedTo === invoice.id) && billFits(bill, window)) {
        linkBills(db, invoice, { bills: [bill], method: 'quickbooks_sync' }, billsById);
        links = linksFor.all(invoice.id);
        linked += 1;
      }
    }
    // Only bills still in QuickBooks count; a deleted one may have been re-entered.
    const isLive = link => {
      const bill = billsById.get(String(link.qbo_bill_id));
      return Boolean(bill && !bill.deleted);
    };
    const liveCovered = () => round2(links.filter(isLive).reduce((acc, link) => acc + Number(link.amount || 0), 0));
    const covered = liveCovered();
    if (covered < round2(invoice.total) - HALF_TOLERANCE) {
      const identity = vendorIdentity(db, {
        vendorName: invoice.vendor_name,
        vendorProfileId: invoice.vendor_profile_id,
        quickbooksVendorId: invoice.quickbooks_vendor_id,
        quickbooksVendorName: invoice.quickbooks_vendor_name,
      });
      const refDate = window.invoiceDate || receivedAt;
      const docHashes = docHashesForInvoice(db, invoice.id);
      const candidates = bills.filter(bill => !bill.deleted && !bill.linkedTo && billFits(bill, window)
        && (sameVendor(identity, bill) || carriesDocument(bill, docHashes)));
      const remaining = round2(invoice.total - covered);
      const chosen = chooseBills(candidates, {
        total: covered > 0 ? remaining : round2(invoice.total),
        projectId: invoice.project_id,
        docHashes,
        invoiceNumber: invoice.external_invoice_number,
        refDate,
      });
      if (chosen) {
        linkBills(db, invoice, chosen, billsById);
        links = linksFor.all(invoice.id);
        linked += chosen.bills.length;
      }
      // Re-entered in full: the links to bills deleted in QuickBooks are history now.
      const dead = links.filter(link => !isLive(link));
      if (dead.length && near(liveCovered(), invoice.total, HALF_TOLERANCE)) {
        for (const link of dead) {
          db.prepare('DELETE FROM invoice_qbo_links WHERE id = ?').run(link.id);
          logEvent(db, {
            source: 'monitor', kind: 'replaced', invoiceId: invoice.id, qboBillId: link.qbo_bill_id, projectId: invoice.project_id,
            message: `${invoice.invoice_number}: QuickBooks bill ${link.qbo_bill_id} was deleted and the invoice is entered again - link moved.`,
          });
        }
        links = linksFor.all(invoice.id);
      }
    }
    if (links.length && followQuickBooks(db, invoice, links, billsById, fileMoves)) {
      followed += 1;
      links = linksFor.all(invoice.id);
    }
    const result = invoiceStatus(invoice, links, billsById, now);
    issues.push(...result.issues.map(issue => ({ ...issue, invoiceId: invoice.id, projectId: invoice.project_id })));
    if (saveReconciliation(db, invoice, links, result)) changed += 1;
    mirrorPayment(db, invoice, result);
  }
  return { invoices: invoices.length, linked, changed, followed, issues };
}

// ── QuickBooks is the source of truth ────────────────────────────────────────

// Mike, 2026-10-27: whatever the office has in QuickBooks, the BuildTrack invoice must
// match. Once an emailed invoice is linked to its bill(s):
//   * a bill edited in QuickBooks - the link carries the bill's current amount;
//   * the whole invoice entered under one class - the invoice moves to that project
//     (with its documents), unless scope tasks of its old project are tied to it;
//   * the invoice entered in full (one bill, or both halves, or its project share) for
//     another amount - the BuildTrack total becomes the QuickBooks amount.
// Partly entered invoices and more entered than invoiced (a possible double entry) stay
// issues for a person. Returns true when anything changed.
function followQuickBooks(db, invoice, links, billsById, fileMoves) {
  const live = links
    .map(link => ({ link, bill: billsById.get(String(link.qbo_bill_id)) }))
    .filter(entry => entry.bill && !entry.bill.deleted);
  if (!live.length) return false;
  let changed = false;
  const shares = live.every(entry => entry.link.part === 'project_share');

  for (const entry of live) {
    const amount = entry.link.part === 'project_share' ? entry.bill.shares.get(invoice.project_id) : entry.bill.total;
    if (amount === undefined || near(amount, entry.link.amount)) continue;
    db.prepare("UPDATE invoice_qbo_links SET amount = ?, updated_at = datetime('now') WHERE id = ?").run(round2(amount), entry.link.id);
    logEvent(db, {
      source: 'quickbooks', kind: 'link_amount_updated', invoiceId: invoice.id, qboBillId: entry.bill.id, projectId: invoice.project_id,
      message: `${invoice.invoice_number}: QuickBooks bill ${entry.bill.id} is now ${money(amount)} (was ${money(entry.link.amount)}).`,
    });
    entry.link.amount = round2(amount);
    changed = true;
  }

  if (!shares) {
    const projects = new Set();
    for (const entry of live) for (const projectId of entry.bill.shares.keys()) projects.add(projectId);
    if (projects.size > 1 && !projects.has(invoice.project_id)) invoice.moveBlocked = 'split';
    if (projects.size === 1 && !projects.has(invoice.project_id)) {
      const classes = [...new Set(live.flatMap(entry => entry.bill.classNames))].join(', ');
      if (moveToQuickBooksProject(db, invoice, [...projects][0], classes, fileMoves)) changed = true;
    }
  }

  const parts = live.map(entry => entry.link.part);
  const complete = shares
    || (live.length === 1 && parts[0] === 'full')
    || (live.length === 2 && parts.includes('first_half') && parts.includes('second_half'));
  const quickbooksTotal = round2(live.reduce((acc, entry) => acc + Number(entry.link.amount || 0), 0));
  if (complete && quickbooksTotal > 0 && !near(quickbooksTotal, invoice.total)) {
    setTotalFromQuickBooks(db, invoice, quickbooksTotal, live);
    changed = true;
  }
  return changed;
}

function invoiceAttachmentRoot() {
  return path.resolve(process.env.UPLOADS_PATH || './uploads', 'invoice-attachments');
}

// Documents are stored under <project>/<invoice>: they are COPIED to the new project
// inside the run's transaction and the old folder is removed only after it commits
// (fileMoves, see runOnce), so a rolled-back run leaves the invoice readable.
function moveToQuickBooksProject(db, invoice, projectId, classes, fileMoves) {
  const target = db.prepare('SELECT id, address FROM projects WHERE id = ?').get(projectId);
  if (!target) return false;
  if (db.prepare('SELECT COUNT(*) AS n FROM invoice_work_items WHERE invoice_id = ?').get(invoice.id).n) {
    invoice.moveBlocked = 'scope_tasks';
    return false;
  }
  const from = { id: invoice.project_id, address: invoice.project_address };
  const fromDir = path.join(invoiceAttachmentRoot(), String(from.id), invoice.id);
  const toDir = path.join(invoiceAttachmentRoot(), target.id, invoice.id);
  if (fs.existsSync(fromDir)) {
    fs.mkdirSync(path.dirname(toDir), { recursive: true });
    fs.cpSync(fromDir, toDir, { recursive: true });
    fileMoves.push({ from: fromDir, to: toDir });
  }
  const note = `Moved from ${from.address || 'its project'} to ${target.address} to match QuickBooks${classes ? ` (class ${classes})` : ''}.`;
  db.prepare(`
    UPDATE invoices SET project_id = ?, notes = trim(COALESCE(notes, '') || char(10) || ?), updated_at = datetime('now') WHERE id = ?
  `).run(target.id, note, invoice.id);
  db.prepare('UPDATE invoice_attachments SET project_id = ? WHERE invoice_id = ?').run(target.id, invoice.id);
  db.prepare("UPDATE invoice_inbox_items SET project_id = ?, updated_at = datetime('now') WHERE invoice_id = ?").run(target.id, invoice.id);
  logEvent(db, {
    source: 'quickbooks', kind: 'moved_to_quickbooks_project', invoiceId: invoice.id, projectId: target.id,
    message: `${invoice.invoice_number} - ${invoice.vendor_name} ${money(invoice.total)}: ${note}`,
  });
  try {
    logActivity({
      userId: require('./invoiceInboxAgent').systemUserId(db),
      projectId: target.id,
      action: 'invoice_moved_to_match_quickbooks',
      entityType: 'invoice',
      entityId: invoice.id,
      details: { from_project_id: from.id, to_project_id: target.id, classes: classes || null },
    });
  } catch (err) {
    warn(`could not record the move of ${invoice.invoice_number}: ${err.message}`);
  }
  invoice.project_id = target.id;
  invoice.project_address = target.address;
  return true;
}

// The line items still add up: a single line takes the new amount; otherwise one
// "Adjustment to match QuickBooks" line carries the difference.
function setTotalFromQuickBooks(db, invoice, total, live) {
  const before = round2(invoice.total);
  const lines = db.prepare('SELECT id, description, amount, sort_order FROM invoice_line_items WHERE invoice_id = ? ORDER BY sort_order').all(invoice.id);
  const adjustment = lines.find(line => line.description === ADJUSTMENT_LINE);
  const others = lines.filter(line => line !== adjustment);
  if (others.length === 1 && !adjustment) {
    db.prepare('UPDATE invoice_line_items SET amount = ? WHERE id = ?').run(total, others[0].id);
  } else if (others.length) {
    const difference = round2(total - others.reduce((acc, line) => acc + Number(line.amount || 0), 0));
    if (adjustment && near(difference, 0)) {
      db.prepare('DELETE FROM invoice_line_items WHERE id = ?').run(adjustment.id);
    } else if (adjustment) {
      db.prepare('UPDATE invoice_line_items SET amount = ? WHERE id = ?').run(difference, adjustment.id);
    } else if (!near(difference, 0)) {
      const order = Math.max(...others.map(line => Number(line.sort_order) || 0)) + 1;
      db.prepare('INSERT INTO invoice_line_items (id, invoice_id, description, amount, sort_order) VALUES (?, ?, ?, ?, ?)')
        .run(uuidv4(), invoice.id, ADJUSTMENT_LINE, difference, order);
    }
  }
  const bills = live.map(entry => `bill ${entry.bill.id}`).join(', ');
  const note = `Amount changed from ${money(before)} to ${money(total)} to match QuickBooks (${bills}).`;
  db.prepare(`
    UPDATE invoices SET total = ?, notes = trim(COALESCE(notes, '') || char(10) || ?), updated_at = datetime('now') WHERE id = ?
  `).run(total, note, invoice.id);
  logEvent(db, {
    source: 'quickbooks', kind: 'amount_from_quickbooks', invoiceId: invoice.id, projectId: invoice.project_id,
    message: `${invoice.invoice_number} - ${invoice.vendor_name}: ${note}`,
  });
  invoice.total = total;
}

// Could this bill have been entered for an invoice dated `invoiceDate` that arrived by
// email at `receivedAt`? Not dated before the invoice (a few days' slack), not entered
// in QuickBooks weeks before the email came in, not months after.
function billFits(bill, { invoiceDate, receivedAt }) {
  const ref = invoiceDate || receivedAt;
  const floorGap = invoiceDate ? -INVOICE_DATE_SLACK_DAYS : -WINDOW_BEFORE_DAYS;
  const gap = dayGap(ref, bill.date);
  if (gap !== null && (gap < floorGap || gap > WINDOW_AFTER_DAYS)) return false;
  const entered = toMs(bill.row.qbo_created_at || bill.row.first_seen_at);
  const arrived = toMs(receivedAt);
  if (Number.isFinite(entered) && Number.isFinite(arrived) && entered < arrived - ENTERED_BEFORE_EMAIL_DAYS * 86400000) return false;
  return true;
}

// The same test for the QuickBooks sync's own matcher (routes/quickbooks.js
// findInvoiceForBill), which sees Intuit's raw bill: could `qboBill` be the bill entered
// for BuildTrack `invoice`? An amount alone is not enough - Snyders bills $250 every week.
function billCouldBeFor(invoice, qboBill) {
  const bill = {
    date: qboBill?.TxnDate || '',
    row: { qbo_created_at: qboBill?.MetaData?.CreateTime || null, first_seen_at: null },
  };
  return billFits(bill, {
    invoiceDate: invoice?.vendor_invoice_date || null,
    receivedAt: invoice?.submitted_at || invoice?.created_at || null,
  });
}

function saveReconciliation(db, invoice, links, result) {
  const summary = links.length
    ? `${STATUS_LABELS[result.status]}: ${links.map(link => `${PART_LABELS[link.part]} bill ${link.qbo_bill_id} ${money(link.amount)}`).join(', ')}; ${money(result.paidAmount)} paid.`
    : STATUS_LABELS[result.status];
  const signature = JSON.stringify([result.status, links.map(link => `${link.qbo_bill_id}:${link.amount}:${link.part}`), result.paidAmount]);
  const existing = db.prepare('SELECT status, signature FROM invoice_reconciliation WHERE invoice_id = ?').get(invoice.id);
  db.prepare(`
    INSERT INTO invoice_reconciliation (invoice_id, status, invoice_total, quickbooks_total, paid_amount, bill_count, summary, signature, checked_at, changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(invoice_id) DO UPDATE SET status = excluded.status, invoice_total = excluded.invoice_total,
      quickbooks_total = excluded.quickbooks_total, paid_amount = excluded.paid_amount, bill_count = excluded.bill_count,
      summary = excluded.summary, signature = excluded.signature, checked_at = excluded.checked_at,
      changed_at = CASE WHEN invoice_reconciliation.signature = excluded.signature THEN invoice_reconciliation.changed_at ELSE excluded.changed_at END
  `).run(invoice.id, result.status, round2(invoice.total), result.quickbooksTotal, result.paidAmount, result.billCount, summary, signature);
  if (existing && existing.signature === signature) return false;
  if (existing || links.length) {
    logEvent(db, {
      source: 'monitor',
      kind: 'reconciliation',
      severity: MATCHED_STATUSES.has(result.status) ? 'info' : 'warning',
      invoiceId: invoice.id,
      projectId: invoice.project_id,
      message: `${invoice.invoice_number} - ${invoice.vendor_name} ${money(invoice.total)}: ${summary}`,
    });
  }
  return true;
}

// Every part paid in QuickBooks -> the BuildTrack invoice shows paid too.
function mirrorPayment(db, invoice, result) {
  if (!MATCHED_STATUSES.has(result.status) || !near(result.paidAmount, invoice.total)) return;
  if (!['submitted', 'reviewed', 'approved'].includes(invoice.status)) return;
  db.prepare("UPDATE invoices SET status = 'paid', updated_at = datetime('now') WHERE id = ?").run(invoice.id);
  logEvent(db, {
    source: 'quickbooks',
    kind: 'invoice_paid',
    invoiceId: invoice.id,
    projectId: invoice.project_id,
    message: `${invoice.invoice_number} - ${invoice.vendor_name} ${money(invoice.total)} is paid in QuickBooks; marked paid in BuildTrack.`,
  });
}

// ── emailed invoices the AI could not place: QuickBooks has the office's answer ──

function resolveFromQuickBooks(db, bills, billsById) {
  const items = db.prepare(`
    SELECT a.*, e.subject, e.from_email, e.received_at, e.attachments_json, e.extracted_summary
    FROM invoice_inbox_items a
    JOIN invoice_email_intake e ON e.id = a.intake_id
    WHERE a.status = 'needs_project' AND a.invoice_id IS NULL AND a.total IS NOT NULL AND a.total > 0
      AND trim(COALESCE(a.vendor_name, '')) <> ''
    ORDER BY datetime(a.created_at) ASC
  `).all();
  let filed = 0;
  for (const item of items) {
    const identity = vendorIdentity(db, { vendorName: item.vendor_name, vendorProfileId: item.vendor_profile_id });
    const window = { invoiceDate: item.invoice_date || null, receivedAt: item.received_at };
    const refDate = window.invoiceDate || item.received_at;
    const docHashes = new Set(item.document_sha256 ? [item.document_sha256] : []);
    const candidates = bills.filter(bill => !bill.deleted && !bill.linkedTo && billFits(bill, window) && bill.shares.size
      && (sameVendor(identity, bill) || carriesDocument(bill, docHashes)));
    const chosen = chooseBills(candidates, {
      total: round2(item.total),
      projectId: null,
      docHashes,
      invoiceNumber: item.invoice_number,
      refDate,
    });
    if (!chosen) continue;
    // Project shares across the chosen bills (one bill may split the invoice across classes).
    const shares = new Map();
    for (const bill of chosen.bills) {
      for (const [projectId, amount] of bill.shares) shares.set(projectId, round2((shares.get(projectId) || 0) + amount));
    }
    const enteredTotal = round2([...shares.values()].reduce((acc, amount) => acc + amount, 0));
    // Several projects: only when QuickBooks has the whole invoice (the split must add up).
    if (shares.size > 1 && !near(enteredTotal, item.total, HALF_TOLERANCE)) continue;
    try {
      db.transaction(() => fileFromQuickBooks(db, item, chosen, shares, billsById))();
      filed += 1;
    } catch (err) {
      warn(`could not file inbox item ${item.id} from QuickBooks: ${err.message}`);
    }
  }
  return filed;
}

function fileFromQuickBooks(db, item, chosen, shares, billsById) {
  const agent = require('./invoiceInboxAgent');
  const intake = db.prepare('SELECT * FROM invoice_email_intake WHERE id = ?').get(item.intake_id);
  let entry = {};
  try { entry = JSON.parse(item.read_json || '{}'); } catch (_) { entry = {}; }
  entry = {
    line_items: [], tax: null, amount_due: null, billing_stage: 'unclear', vendor: {},
    category: item.category || 'Miscellaneous', invoice_type: item.invoice_type || 'other',
    ...entry,
  };
  const vendor = { id: item.vendor_profile_id || null, name: item.vendor_name, created: false };
  const actorId = agent.systemUserId(db);
  const classNames = [...new Set(chosen.bills.flatMap(bill => bill.classNames))].join(', ');
  const projectRows = new Map(db.prepare(`SELECT id, address FROM projects WHERE id IN (${[...shares.keys()].map(() => '?').join(',')})`)
    .all(...shares.keys()).map(row => [row.id, row]));
  const multi = shares.size > 1;
  const created = [];
  for (const [projectId, share] of shares) {
    const project = projectRows.get(projectId);
    if (!project) continue;
    const total = multi ? share : round2(item.total);
    const note = multi
      ? `Project taken from QuickBooks: the office split this ${money(item.total)} invoice across ${shares.size} projects (${classNames}); this is the ${money(share)} share for ${project.address}.`
      : `Project taken from QuickBooks: the office entered it under ${classNames || project.address}.`;
    const invoice = agent.fileInvoice(db, {
      intake, entry: multi ? { ...entry, line_items: [] } : entry, vendor, project, total, actorId,
      emailSummary: item.extracted_summary, note,
    });
    const row = db.prepare('SELECT i.*, p.address AS project_address FROM invoices i LEFT JOIN projects p ON p.id = i.project_id WHERE i.id = ?').get(invoice.invoiceId);
    linkBills(db, row, {
      bills: multi ? chosen.bills.filter(bill => bill.shares.has(projectId)) : chosen.bills,
      method: chosen.method,
      part: multi ? 'project_share' : null,
      amountFor: multi ? bill => bill.shares.get(projectId) || 0 : null,
    }, billsById);
    // A bill shared by several of these invoices stays "linked" for every one of them.
    if (multi) for (const bill of chosen.bills) billsById.get(bill.id).linkedTo = 'shared';
    created.push({ invoiceId: invoice.invoiceId, invoiceNumber: invoice.invoiceNumber, project });
  }
  if (!created.length) throw new Error('no project from QuickBooks is in BuildTrack');
  db.prepare(`
    UPDATE invoice_inbox_items
    SET status = 'filed', invoice_id = ?, project_id = ?, reason = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    created[0].invoiceId, created[0].project.id,
    `Filed from QuickBooks: the office entered it under ${created.map(c => c.project.address).join(', ')} (${created.map(c => c.invoiceNumber).join(', ')}).`,
    item.id
  );
  const open = db.prepare("SELECT COUNT(*) AS n FROM invoice_inbox_items WHERE intake_id = ? AND status IN ('needs_project','needs_review')").get(item.intake_id).n;
  db.prepare(`
    UPDATE invoice_email_intake
    SET status = CASE WHEN ? = 0 THEN 'filed' ELSE status END,
        agent_status = CASE WHEN ? = 0 THEN 'filed' ELSE agent_status END,
        agent_notes = trim(COALESCE(agent_notes, '') || ' ' || ?),
        matched_project_id = COALESCE(matched_project_id, ?),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(open, open, `Later filed from QuickBooks as ${created.map(c => c.invoiceNumber).join(', ')}.`, created[0].project.id, item.intake_id);
  logEvent(db, {
    source: 'monitor',
    kind: 'filed_from_quickbooks',
    invoiceId: created[0].invoiceId,
    intakeId: item.intake_id,
    projectId: created[0].project.id,
    message: `${item.vendor_name} ${money(item.total)}${item.invoice_number ? ` #${item.invoice_number}` : ''}: the job was not on the invoice; the office entered it in QuickBooks under ${created.map(c => c.project.address).join(', ')} - filed as ${created.map(c => c.invoiceNumber).join(', ')}.`,
  });
}

// ── checks on every recent QuickBooks bill ───────────────────────────────────

function quickBooksIssues(db, bills) {
  const issues = [];
  const live = bills.filter(bill => !bill.deleted);
  // Same vendor, same amount and the same description (or both blank on the same day).
  const groups = new Map();
  for (const bill of live) {
    const key = `${bill.vendorId || bill.vendorKey}|${bill.total.toFixed(2)}`;
    const list = groups.get(key) || [];
    list.push(bill);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id.localeCompare(b.id));
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        const gap = Math.abs(dayGap(a.date, b.date) || 0);
        if (gap > DOUBLE_ENTRY_DAYS) continue;
        const sameText = a.noteKey && a.noteKey === b.noteKey;
        const bothBlank = !a.noteKey && !b.noteKey && a.date === b.date;
        if (!sameText && !bothBlank) continue;
        if (a.linkedTo && b.linkedTo && a.linkedTo !== b.linkedTo && a.linkedTo !== 'shared') continue;
        issues.push({
          key: `double:${a.id}:${b.id}`, kind: 'possible_double_entry', severity: 'alert', qboBillId: b.id,
          projectId: [...b.shares.keys()][0] || null,
          message: `Possible double entry in QuickBooks: bills ${a.id} (${a.date}) and ${b.id} (${b.date}) are both ${a.vendorName} ${money(a.total)}${a.noteKey ? ` "${text(a.note, 80)}"` : ''}.`,
        });
      }
    }
  }
  // A bill for a document the AI read as an estimate / quote.
  const estimates = db.prepare(`
    SELECT a.*, e.received_at FROM invoice_inbox_items a JOIN invoice_email_intake e ON e.id = a.intake_id
    WHERE a.status = 'not_invoice' AND a.document_kind = 'estimate_or_quote' AND a.total > 0
  `).all();
  for (const estimate of estimates) {
    const identity = vendorIdentity(db, { vendorName: estimate.vendor_name, vendorProfileId: estimate.vendor_profile_id });
    for (const bill of live) {
      if (bill.linkedTo || !sameVendor(identity, bill) || !near(bill.total, estimate.total, 1)) continue;
      const gap = dayGap(estimate.received_at, bill.date);
      if (gap === null || gap < -7 || gap > ESTIMATE_DAYS) continue;
      issues.push({
        key: `estimate_billed:${bill.id}`, kind: 'estimate_billed', severity: 'alert', qboBillId: bill.id, intakeId: estimate.intake_id,
        projectId: [...bill.shares.keys()][0] || null,
        message: `${billLabel(bill)} matches a document the AI read as an ESTIMATE / QUOTE, not an invoice (email of ${String(estimate.received_at).slice(0, 10)}). Check it is meant to be paid.`,
      });
    }
  }
  // The document attached in QuickBooks totals something else (Cost Analyzer's read).
  for (const bill of live) {
    const doc = bill.docs.find(d => d.read_status === 'extracted' && d.totals_match === 0 && d.document_total !== null);
    if (!doc) continue;
    issues.push({
      key: `doc_total:${bill.id}`, kind: 'document_total_differs', severity: 'info', qboBillId: bill.id,
      projectId: [...bill.shares.keys()][0] || null,
      message: `${billLabel(bill)}: the document attached in QuickBooks totals ${money(doc.document_total)}${doc.totals_match_reason ? ` (${text(doc.totals_match_reason, 160)})` : ''}.`,
    });
  }
  return issues;
}

// QuickBooks entries that are new, changed, paid or gone since the last run.
function trackBillChanges(db, bills, firstRun) {
  const seen = new Map(db.prepare('SELECT * FROM qbo_bill_monitor').all().map(row => [String(row.qbo_bill_id), row]));
  const upsert = db.prepare(`
    INSERT INTO qbo_bill_monitor (qbo_bill_id, sync_token, total, balance, payment_status, deleted, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(qbo_bill_id) DO UPDATE SET sync_token = excluded.sync_token, total = excluded.total, balance = excluded.balance,
      payment_status = excluded.payment_status, deleted = excluded.deleted, checked_at = excluded.checked_at
  `);
  let events = 0;
  for (const bill of bills) {
    const before = seen.get(bill.id);
    const status = bill.paid ? 'paid' : (bill.row.payment_status || 'unpaid');
    upsert.run(bill.id, bill.row.sync_token || null, bill.total, bill.balance, status, bill.deleted ? 1 : 0);
    if (firstRun) continue;
    const base = { source: 'quickbooks', qboBillId: bill.id, invoiceId: bill.row.matched_invoice_id || null, projectId: [...bill.shares.keys()][0] || null };
    if (!before) {
      if (!bill.deleted) { logEvent(db, { ...base, kind: 'bill_entered', message: `New in QuickBooks: ${billLabel(bill)}${bill.classNames.length ? ` under ${bill.classNames.join(', ')}` : ''}.` }); events += 1; }
      continue;
    }
    if (bill.deleted && !before.deleted) {
      logEvent(db, { ...base, kind: 'bill_deleted', severity: 'warning', message: `Gone from QuickBooks: ${billLabel(bill)}.` }); events += 1;
    } else if (!near(before.total, bill.total)) {
      logEvent(db, { ...base, kind: 'bill_changed', severity: 'warning', message: `Changed in QuickBooks: bill ${bill.id} (${bill.vendorName}) was ${money(before.total)}, now ${money(bill.total)}.` }); events += 1;
    } else if (status === 'paid' && before.payment_status !== 'paid') {
      logEvent(db, { ...base, kind: 'bill_paid', message: `Paid in QuickBooks: ${billLabel(bill)}.` }); events += 1;
    } else if (String(before.sync_token || '') !== String(bill.row.sync_token || '')) {
      logEvent(db, { ...base, kind: 'bill_edited', message: `Edited in QuickBooks: ${billLabel(bill)}.` }); events += 1;
    }
  }
  return events;
}

// ── issues: open / resolved, and the office email ────────────────────────────

function saveIssues(db, issues) {
  const now = new Set(issues.map(issue => issue.key));
  const existing = new Map(db.prepare("SELECT * FROM invoice_monitor_issues WHERE status IN ('open','dismissed')").all().map(row => [row.issue_key, row]));
  let opened = 0;
  for (const issue of issues) {
    const row = existing.get(issue.key);
    if (row) {
      db.prepare("UPDATE invoice_monitor_issues SET message = ?, severity = ?, last_seen_at = datetime('now') WHERE id = ?")
        .run(text(issue.message, 600), issue.severity, row.id);
      continue;
    }
    const previous = db.prepare('SELECT id FROM invoice_monitor_issues WHERE issue_key = ?').get(issue.key);
    if (previous) {
      db.prepare(`
        UPDATE invoice_monitor_issues SET status = 'open', message = ?, severity = ?, resolved_at = NULL, notified_at = NULL,
          first_seen_at = datetime('now'), last_seen_at = datetime('now') WHERE id = ?
      `).run(text(issue.message, 600), issue.severity, previous.id);
    } else {
      db.prepare(`
        INSERT INTO invoice_monitor_issues (id, issue_key, kind, severity, invoice_id, qbo_bill_id, intake_id, project_id, message, notified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), issue.key, issue.kind, issue.severity, issue.invoiceId || null, issue.qboBillId || null,
        issue.intakeId || null, issue.projectId || null, text(issue.message, 600), null);
    }
    opened += 1;
    logEvent(db, {
      source: 'monitor', kind: `issue_${issue.kind}`, severity: issue.severity, invoiceId: issue.invoiceId, qboBillId: issue.qboBillId,
      intakeId: issue.intakeId, projectId: issue.projectId, message: issue.message,
    });
  }
  let resolved = 0;
  for (const [key, row] of existing) {
    if (now.has(key) || row.status !== 'open') continue;
    db.prepare("UPDATE invoice_monitor_issues SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?").run(row.id);
    logEvent(db, { source: 'monitor', kind: 'issue_resolved', invoiceId: row.invoice_id, qboBillId: row.qbo_bill_id, projectId: row.project_id, message: `Resolved: ${row.message}` });
    resolved += 1;
  }
  return { opened, resolved };
}

async function notifyOffice(db, { force = false } = {}) {
  if (!force && Date.now() - state.lastNotifyAt < NOTIFY_EVERY_MS) return 0;
  const { sendInvoiceMonitorAlertEmail, isEmailConfigured } = require('../utils/email');
  if (!isEmailConfigured()) return 0;
  const issues = db.prepare(`
    SELECT * FROM invoice_monitor_issues
    WHERE status = 'open' AND notified_at IS NULL AND severity IN ('alert','warning')
    ORDER BY CASE severity WHEN 'alert' THEN 0 ELSE 1 END, first_seen_at
  `).all();
  if (!issues.length) return 0;
  state.lastNotifyAt = Date.now();
  try {
    await sendInvoiceMonitorAlertEmail({ issues: issues.slice(0, 40), more: Math.max(issues.length - 40, 0), link: '/invoices#invoice-monitor' });
    const marks = issues.map(() => '?').join(',');
    db.prepare(`UPDATE invoice_monitor_issues SET notified_at = datetime('now') WHERE id IN (${marks})`).run(...issues.map(issue => issue.id));
    logEvent(db, { source: 'monitor', kind: 'office_emailed', message: `Emailed the office about ${issues.length} item(s) that need attention.` });
    return issues.length;
  } catch (err) {
    warn(`office email failed: ${err.message}`);
    return 0;
  }
}

// ── one run ──────────────────────────────────────────────────────────────────

async function runOnce({ notify = true } = {}) {
  if (state.running) {
    state.rerun = true;
    return { skipped: true };
  }
  state.running = true;
  const db = getDb();
  // Invoice documents copied to a new project folder during this run (followQuickBooks).
  const fileMoves = [];
  let committed = false;
  try {
    const firstRun = !db.prepare('SELECT 1 FROM qbo_bill_monitor LIMIT 1').get();
    const bills = loadBills(db);
    const billsById = new Map(bills.map(bill => [bill.id, bill]));
    for (const bill of bills) for (const doc of bill.docs) doc.sha = attachmentSha(db, doc);
    const linkedRows = db.prepare('SELECT qbo_bill_id, invoice_id FROM invoice_qbo_links').all();
    for (const row of linkedRows) {
      const bill = billsById.get(String(row.qbo_bill_id));
      if (bill) bill.linkedTo = bill.linkedTo && bill.linkedTo !== row.invoice_id ? 'shared' : row.invoice_id;
    }
    const now = new Date().toISOString();
    let result;
    db.transaction(() => {
      const billEvents = trackBillChanges(db, bills, firstRun);
      const filedFromQuickBooks = resolveFromQuickBooks(db, bills, billsById);
      const invoiceResult = reconcileInvoices(db, bills, billsById, now, fileMoves);
      const issues = [...invoiceResult.issues, ...quickBooksIssues(db, bills)];
      const issueResult = saveIssues(db, issues);
      if (firstRun) {
        logEvent(db, { source: 'monitor', kind: 'started', message: `Invoice monitor started: watching ${bills.length} QuickBooks bill(s) since ${sinceDate()} and ${invoiceResult.invoices} emailed invoice(s); ${issues.length} item(s) need attention.` });
      }
      result = {
        bills: bills.length,
        bill_events: billEvents,
        filed_from_quickbooks: filedFromQuickBooks,
        invoices: invoiceResult.invoices,
        linked: invoiceResult.linked,
        followed_quickbooks: invoiceResult.followed,
        reconciliations_changed: invoiceResult.changed,
        open_issues: issues.length,
        issues_opened: issueResult.opened,
        issues_resolved: issueResult.resolved,
      };
    })();
    committed = true;
    // Committed: the documents now live only in their new project folder.
    for (const move of fileMoves) {
      try { fs.rmSync(move.from, { recursive: true, force: true }); } catch (err) { warn(`could not remove ${move.from}: ${err.message}`); }
    }
    result.office_emailed = notify ? await notifyOffice(db, { force: firstRun }) : 0;
    state.lastRunAt = now;
    state.lastError = null;
    state.lastResult = result;
    if (result.linked || result.followed_quickbooks || result.filed_from_quickbooks || result.issues_opened || result.issues_resolved || result.bill_events) {
      log(`run: ${result.bills} bills, ${result.linked} linked, ${result.followed_quickbooks} updated from QuickBooks, ${result.filed_from_quickbooks} filed from QuickBooks, ${result.issues_opened} new / ${result.issues_resolved} resolved issue(s), ${result.office_emailed} emailed`);
    }
    return result;
  } catch (err) {
    // Rolled back: drop the copies, the old folders are untouched.
    if (!committed) {
      for (const move of fileMoves) {
        try { fs.rmSync(move.to, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
      }
    }
    state.lastError = err.message;
    warn(`run failed: ${err.message}`);
    return { error: err.message };
  } finally {
    state.running = false;
    if (state.rerun) {
      state.rerun = false;
      kick('rerun');
    }
  }
}

// Something changed (QuickBooks sync, inbox): run soon, once.
function kick(_reason) {
  if (!enabled() || !state.timer) return;
  if (state.kickTimer) return;
  state.kickTimer = setTimeout(() => {
    state.kickTimer = null;
    runOnce().catch(() => {});
  }, KICK_DELAY_MS);
}

// ── for the project invoice list ─────────────────────────────────────────────

// invoiceId -> { covered, parts } for emailed invoices entered in QuickBooks.
function quickBooksCoverage(db, invoiceIds) {
  const out = new Map();
  if (!invoiceIds.length) return out;
  try {
    for (const part of chunks(invoiceIds)) {
      db.prepare(`
        SELECT l.invoice_id, l.qbo_bill_id, l.amount, l.part
        FROM invoice_qbo_links l
        JOIN quickbooks_bills b ON b.qbo_id = l.qbo_bill_id
        WHERE l.invoice_id IN (${part.map(() => '?').join(',')}) AND COALESCE(b.payment_approval_status, '') <> ?
      `).all(...part, DELETED_STATUS).forEach(link => {
        const entry = out.get(link.invoice_id) || { covered: 0, parts: [] };
        entry.covered = round2(entry.covered + Number(link.amount || 0));
        entry.parts.push(link);
        out.set(link.invoice_id, entry);
      });
    }
  } catch (_) {
    return new Map();
  }
  return out;
}

// qboBillId -> the emailed invoice it belongs to (number, category, part).
function emailInvoicesForBills(db, billIds) {
  const out = new Map();
  if (!billIds.length) return out;
  try {
    for (const part of chunks(billIds)) {
      db.prepare(`
        SELECT l.qbo_bill_id, l.part, i.id AS invoice_id, i.invoice_number, i.category, i.external_invoice_number
        FROM invoice_qbo_links l JOIN invoices i ON i.id = l.invoice_id
        WHERE l.qbo_bill_id IN (${part.map(() => '?').join(',')})
      `).all(...part).forEach(row => { if (!out.has(String(row.qbo_bill_id))) out.set(String(row.qbo_bill_id), row); });
    }
  } catch (_) {
    return new Map();
  }
  return out;
}

// ── for the review queue ─────────────────────────────────────────────────────

// itemId -> projects to offer first when a person assigns an emailed invoice, from what
// the office does in QuickBooks: a bill already entered for this very invoice (same
// vendor, its amount or half of it, dated for it, not linked to anything) - more than
// one means the monitor could not choose - then the vendor's recent classes.
// `items`: { id, vendor_name, vendor_profile_id, total, invoice_date, received_at }.
function projectSuggestions(db, items) {
  const out = new Map();
  const open = items.filter(item => String(item.vendor_name || '').trim() || item.vendor_profile_id);
  if (!open.length) return out;
  const projects = new Map(db.prepare('SELECT id, address, quickbooks_class_name FROM projects').all().map(row => [row.id, row]));
  const linked = new Set(db.prepare('SELECT DISTINCT qbo_bill_id FROM invoice_qbo_links').all().map(row => String(row.qbo_bill_id)));
  const bills = loadBills(db).filter(bill => !bill.deleted && bill.shares.size);
  const today = new Date().toISOString().slice(0, 10);
  for (const item of open) {
    const identity = vendorIdentity(db, { vendorName: item.vendor_name, vendorProfileId: item.vendor_profile_id });
    const mine = bills.filter(bill => sameVendor(identity, bill))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const list = [];
    const add = (projectId, extra) => {
      const project = projects.get(projectId);
      if (!project || list.some(entry => entry.project_id === projectId)) return;
      list.push({ project_id: projectId, address: project.address, class_name: project.quickbooks_class_name || null, ...extra });
    };
    const total = Number(item.total || 0);
    const window = { invoiceDate: item.invoice_date || null, receivedAt: item.received_at };
    for (const bill of mine) {
      if (!(total > 0) || linked.has(bill.id) || !billFits(bill, window)) continue;
      if (!near(bill.total, total) && !(bill.half && near(bill.total, total / 2, HALF_TOLERANCE))) continue;
      for (const projectId of bill.shares.keys()) add(projectId, { source: 'quickbooks_bill', qbo_bill_id: bill.id, bill_date: bill.date, amount: bill.total });
    }
    for (const bill of mine) {
      const age = dayGap(bill.date, today);
      if (age === null || age > SUGGEST_DAYS) continue;
      for (const projectId of bill.shares.keys()) add(projectId, { source: 'vendor_history', bill_date: bill.date });
    }
    out.set(item.id, list.slice(0, 4));
  }
  return out;
}

function statusSummary() {
  return {
    enabled: enabled(),
    since: sinceDate(),
    grace_days: graceDays(),
    last_run_at: state.lastRunAt,
    last_error: state.lastError,
    last_result: state.lastResult,
  };
}

function start() {
  if (!enabled()) {
    log('monitor disabled by environment');
    return;
  }
  const intervalMs = Math.max(Number.parseInt(process.env.INVOICE_MONITOR_INTERVAL_MS || '300000', 10) || 300000, 60000);
  state.timer = setInterval(() => { runOnce().catch(() => {}); }, intervalMs);
  setTimeout(() => { runOnce().catch(() => {}); }, 30000);
  log(`watching emailed invoices and QuickBooks bills since ${sinceDate()} every ${Math.round(intervalMs / 1000)} s`);
}

function stop() {
  if (state.timer) clearInterval(state.timer);
  if (state.kickTimer) clearTimeout(state.kickTimer);
  state.timer = null;
  state.kickTimer = null;
}

module.exports = {
  start,
  stop,
  runOnce,
  kick,
  logEvent,
  statusSummary,
  quickBooksCoverage,
  emailInvoicesForBills,
  projectSuggestions,
  billCouldBeFor,
  STATUS_LABELS,
  PART_LABELS,
  // exposed for tests
  chooseBills,
  halfOf,
};
