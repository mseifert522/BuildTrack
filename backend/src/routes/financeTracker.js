const crypto = require('crypto');
const express = require('express');
const { getDb } = require('../db/schema');
const quickBooksRoutes = require('./quickbooks');

const router = express.Router();

function suppliedKey(req) {
  const authorization = String(req.get('authorization') || '');
  return String(req.get('x-finance-tracker-key') || (authorization.startsWith('Bearer ') ? authorization.slice(7) : '')).trim();
}

function keysMatch(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function authorizeFinanceTracker(req, res, next) {
  const expected = String(process.env.FINANCE_TRACKER_SERVICE_KEY || '').trim();
  if (!expected) return res.status(503).json({ error: 'Finance Tracker service access is not configured.' });
  if (!keysMatch(suppliedKey(req), expected)) return res.status(401).json({ error: 'Unauthorized' });
  res.setHeader('Cache-Control', 'no-store');
  return next();
}

router.use(authorizeFinanceTracker);

router.get('/projects', (_req, res) => {
  const db = getDb();
  const projects = db.prepare(`
    SELECT
      id,
      address,
      job_name,
      status,
      lifecycle_status,
      budget,
      purchase_price,
      closing_costs,
      arv,
      sale_price,
      acquisition_date,
      construction_start_date,
      target_completion,
      sold_date,
      quickbooks_class_id,
      quickbooks_class_name,
      updated_at
    FROM projects
    WHERE status != 'archived'
    ORDER BY updated_at DESC
  `).all();
  res.json({ projects, exportedAt: new Date().toISOString() });
});

router.get('/bills', (_req, res) => {
  const db = getDb();
  const bills = db.prepare(`
    SELECT
      qbo_id,
      doc_number,
      vendor_name,
      txn_date,
      total_amt,
      balance,
      payment_status,
      project_id,
      qbo_class_id,
      qbo_class_name,
      private_note,
      qbo_updated_at
    FROM quickbooks_bills
    WHERE COALESCE(payment_approval_status, 'not_approved') != 'deleted'
    ORDER BY date(COALESCE(txn_date, qbo_updated_at)) DESC, qbo_id DESC
  `).all();
  res.json({ bills, exportedAt: new Date().toISOString() });
});

// Full transaction feed beyond bills (purchases, deposits, journal entries,
// invoices paid or open, payments, transfers, credits) — Finance Tracker polls
// this every cycle so every class-tagged QuickBooks entry lands there.
const ISO_SINCE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

router.get('/transactions', async (req, res) => {
  try {
    const since = String(req.query.since || '').trim();
    if (!ISO_SINCE.test(since)) {
      return res.status(400).json({ error: 'since must be ISO-8601 (YYYY-MM-DD or full timestamp).' });
    }
    const transactions = await quickBooksRoutes.financeTrackerTransactionsSince(since);
    res.json({ transactions, exportedAt: new Date().toISOString() });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to export QuickBooks transactions.' });
  }
});

// Balance sheet summarized by class — drives live Total In / Loan Owed / Cash
// In per property in Finance Tracker.
router.get('/balance-sheet-by-class', async (_req, res) => {
  try {
    const report = await quickBooksRoutes.financeTrackerBalanceSheetByClass();
    res.json({ report, exportedAt: new Date().toISOString() });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to export the class balance sheet.' });
  }
});

// P&L summarized by class — drives sold-project auto-transfer and the
// per-asset Details statement in Finance Tracker.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/profit-and-loss-by-class', async (req, res) => {
  try {
    const start = String(req.query.start || '2015-01-01').trim();
    const end = String(req.query.end || '').trim();
    if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) {
      return res.status(400).json({ error: 'start and end must be YYYY-MM-DD.' });
    }
    const report = await quickBooksRoutes.financeTrackerProfitAndLossByClass(start, end);
    res.json({ report, exportedAt: new Date().toISOString() });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to export the class P&L.' });
  }
});

// Card charges by class and month, paydowns and payoff months — drives the card
// activity panel on Finance Tracker's Capital page. Rebuilt from every purchase
// and journal entry on each call, so Finance Tracker pulls it hourly.
router.get('/card-activity', async (_req, res) => {
  try {
    const activity = await quickBooksRoutes.financeTrackerCardActivity();
    res.json({ ...activity, exportedAt: new Date().toISOString() });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to export card activity.' });
  }
});

// Every ledger line on every card and line-of-credit account (all years, dated,
// classed) for Finance Tracker's payoff-by-project view. Read-only.
router.get('/card-register', async (_req, res) => {
  try {
    const register = await quickBooksRoutes.financeTrackerCardRegister();
    res.json({ ...register, exportedAt: new Date().toISOString() });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to export the card register.' });
  }
});

module.exports = router;
