const express = require('express');
const { getDb } = require('../db/schema');
const { authenticate } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { logDataAccess } = require('../utils/dataAccessAudit');
const { requireFeature } = require('../utils/featureAccess');
const { DEFAULT_CLOSING_COST_PCT, isStale, projectBankDraws, syncBankDraws, syncState } = require('../services/bankDraws');

// /api/projects/:projectId/bank-draws - the project's Finance tab (named "Bank Draws"
// until 2026-10-19): construction-loan draws from QuickBooks, the class's statements,
// and the manually entered potential sale. Super Admin, Operations Manager and users
// granted 'bank_draws' only; project managers and contractors get 403 (Mike, 2026-10-19).
const router = express.Router({ mergeParams: true });
router.use(authenticate, requireFeature('bank_draws'));

const MAX_SALE_PRICE = 100000000;
const MAX_CLOSING_COST_PCT = 20;

function loadProject(req, res) {
  const project = getDb().prepare(`
    SELECT id, address, job_name, quickbooks_class_id, quickbooks_class_name, arv
    FROM projects WHERE id = ?
  `).get(req.params.projectId);
  if (!project) res.status(404).json({ error: 'Project not found' });
  return project || null;
}

function payload(project) {
  const db = getDb();
  const state = syncState(db);
  const connected = Boolean(db.prepare("SELECT 1 FROM quickbooks_connections WHERE id = 'primary' AND is_active = 1").get());
  return {
    project,
    linked: Boolean(project.quickbooks_class_id),
    quickbooks: {
      connected,
      last_synced_at: state?.last_synced_at || null,
      last_attempt_at: state?.last_attempt_at || null,
      status: state?.last_status || 'never',
      error: state?.last_status === 'error' ? state.last_error : null,
      stale: isStale(state),
    },
    default_closing_cost_pct: DEFAULT_CLOSING_COST_PCT,
    ...projectBankDraws(project.id, db),
  };
}

router.get('/', (req, res) => {
  const project = loadProject(req, res);
  if (!project) return;
  const body = payload(project);
  logDataAccess(req, {
    action: 'project_bank_draws_viewed',
    accessType: 'view',
    entityType: 'project_bank_draws',
    projectId: project.id,
    recordCount: body.register.length,
    riskLevel: 'high',
  });
  res.set('Cache-Control', 'no-store');
  res.json(body);
});

// POST /sync - pull the ledgers from QuickBooks now (one sync at a time app-wide).
router.post('/sync', async (req, res) => {
  const project = loadProject(req, res);
  if (!project) return;
  try {
    await syncBankDraws({ source: `project ${project.id}`, userId: req.user.id });
  } catch (err) {
    res.set('Cache-Control', 'no-store');
    return res.status(502).json({
      ...payload(project),
      error: 'QuickBooks did not answer. Showing the last copy BuildTrack saved.',
    });
  }
  res.set('Cache-Control', 'no-store');
  res.json(payload(project));
});

function parseMoney(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

// PUT /projection - the potential sales price (blank clears it) and the closing-cost %.
router.put('/projection', (req, res) => {
  const project = loadProject(req, res);
  if (!project) return;
  const price = parseMoney(req.body?.potential_sale_price);
  if (Number.isNaN(price) || (price !== null && (price < 0 || price > MAX_SALE_PRICE))) {
    return res.status(400).json({ error: 'Enter the potential sales price as a dollar amount.' });
  }
  const rawPct = req.body?.closing_cost_pct;
  const pct = rawPct === null || rawPct === undefined || String(rawPct).trim() === '' ? DEFAULT_CLOSING_COST_PCT : Number(rawPct);
  if (!Number.isFinite(pct) || pct < 0 || pct > MAX_CLOSING_COST_PCT) {
    return res.status(400).json({ error: `Closing costs must be between 0% and ${MAX_CLOSING_COST_PCT}%.` });
  }
  const db = getDb();
  const before = db.prepare('SELECT potential_sale_price, closing_cost_pct FROM project_finance_inputs WHERE project_id = ?').get(project.id);
  const savedPrice = price === null ? null : Math.round(price * 100) / 100;
  const savedPct = Math.round(pct * 100) / 100;
  db.prepare(`
    INSERT INTO project_finance_inputs (project_id, potential_sale_price, closing_cost_pct, updated_by, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project_id) DO UPDATE SET
      potential_sale_price = excluded.potential_sale_price,
      closing_cost_pct = excluded.closing_cost_pct,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `).run(project.id, savedPrice, savedPct, req.user.id);
  const changed = [];
  if ((before?.potential_sale_price ?? null) !== savedPrice) changed.push('potential_sale_price');
  if ((before?.closing_cost_pct ?? DEFAULT_CLOSING_COST_PCT) !== savedPct) changed.push('closing_cost_pct');
  if (changed.length) {
    // No amounts and no project_id: the activity log is readable by project managers
    // (Security audit trail), and Finance figures must not reach them.
    logActivity({
      userId: req.user.id,
      action: 'finance_projection_updated',
      entityType: 'project',
      entityId: project.id,
      details: { fields: changed, cleared: savedPrice === null },
    });
  }
  res.set('Cache-Control', 'no-store');
  res.json(payload(project));
});

module.exports = router;
