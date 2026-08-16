'use strict';

function parseInvoiceSeq(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = text.match(/(?:NUD-|Inv#\s*)(\d+)/i) || text.match(/^(\d+)$/);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function formatInvLabel(num) {
  return `Inv# ${Number(num)}`;
}

function currentMaxInvoiceSeq(db) {
  let max = 1022;
  const invoiceRows = db.prepare(`SELECT invoice_number AS n FROM invoices`).all();
  const billRows = db.prepare(`
    SELECT bt_invoice_number AS n FROM quickbooks_bills
    WHERE bt_invoice_number IS NOT NULL AND bt_invoice_number != ''
  `).all();
  for (const row of [...invoiceRows, ...billRows]) {
    const num = parseInvoiceSeq(row.n);
    if (num && num > max) max = num;
  }
  return max;
}

function nextInvoiceSeq(db) {
  return currentMaxInvoiceSeq(db) + 1;
}

function ensureBtInvoiceNumberColumn(db) {
  try {
    db.exec(`ALTER TABLE quickbooks_bills ADD COLUMN bt_invoice_number TEXT`);
  } catch (_) {
    /* already exists */
  }
}

function assignMissingBtInvoiceNumbers(db) {
  ensureBtInvoiceNumberColumn(db);
  const missing = db.prepare(`
    SELECT qb.qbo_id, i.invoice_number AS matched_invoice_number
    FROM quickbooks_bills qb
    LEFT JOIN invoices i ON i.id = qb.matched_invoice_id
    WHERE qb.bt_invoice_number IS NULL OR qb.bt_invoice_number = ''
    ORDER BY datetime(COALESCE(qb.first_seen_at, qb.txn_date, '1970-01-01')),
      CAST(qb.qbo_id AS INTEGER)
  `).all();
  if (!missing.length) return 0;
  const update = db.prepare(`UPDATE quickbooks_bills SET bt_invoice_number = ? WHERE qbo_id = ?`);
  const assign = db.transaction((rows) => {
    let next = nextInvoiceSeq(db);
    for (const row of rows) {
      const matched = parseInvoiceSeq(row.matched_invoice_number);
      const num = matched || next++;
      update.run(String(num), row.qbo_id);
    }
  });
  assign(missing);
  return missing.length;
}

function ensureBillHasInvoiceNumber(db, qboId, matchedInvoiceNumber = null) {
  ensureBtInvoiceNumberColumn(db);
  const existing = db.prepare(`SELECT bt_invoice_number FROM quickbooks_bills WHERE qbo_id = ?`).get(String(qboId));
  if (existing?.bt_invoice_number) return existing.bt_invoice_number;
  const matched = parseInvoiceSeq(matchedInvoiceNumber);
  const num = matched || nextInvoiceSeq(db);
  db.prepare(`UPDATE quickbooks_bills SET bt_invoice_number = ? WHERE qbo_id = ?`).run(String(num), String(qboId));
  return String(num);
}

function invDisplay(value) {
  const num = parseInvoiceSeq(value);
  return num ? formatInvLabel(num) : (value ? `Inv# ${value}` : null);
}

module.exports = {
  parseInvoiceSeq,
  formatInvLabel,
  currentMaxInvoiceSeq,
  nextInvoiceSeq,
  ensureBtInvoiceNumberColumn,
  assignMissingBtInvoiceNumbers,
  ensureBillHasInvoiceNumber,
  invDisplay,
};
