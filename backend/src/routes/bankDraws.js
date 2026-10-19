const express = require('express');
const { getDb } = require('../db/schema');
const { authenticate, authorize } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { logDataAccess } = require('../utils/dataAccessAudit');
const { GRANT_MANAGER_ROLES, requireFeature } = require('../utils/featureAccess');
const { DEFAULT_COMMISSION_PCT, normalizeClassName, isStale, projectBankDraws, syncBankDraws, syncState } = require('../services/bankDraws');

// /api/projects/:projectId/bank-draws - the project's Finance tab (named "Bank Draws"
// until 2026-10-19): construction-loan draws from QuickBooks, the class's statements,
// and the manually entered potential sale. Super Admin, Operations Manager and users
// granted 'bank_draws' only (Super Admin by default; Operations Managers and others only
// when a Super Admin grants it); everyone else gets 403 (Mike, 2026-10-19).
const router = express.Router({ mergeParams: true });
router.use(authenticate, requireFeature('bank_draws'));

const MAX_SALE_PRICE = 100000000;
const MAX_COMMISSION_PCT = 10;
const MAX_CLOSING_COSTS = 10000000;

function loadProject(req, res) {
  const project = getDb().prepare(`
    SELECT id, address, job_name, status, quickbooks_class_id, quickbooks_class_name, arv
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
    default_commission_pct: DEFAULT_COMMISSION_PCT,
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

// PUT /projection - the potential sales price (blank clears it), the realtor commission
// % (3% standard) and the closing costs in dollars (blank = none).
router.put('/projection', (req, res) => {
  const project = loadProject(req, res);
  if (!project) return;
  const price = parseMoney(req.body?.potential_sale_price);
  if (Number.isNaN(price) || (price !== null && (price < 0 || price > MAX_SALE_PRICE))) {
    return res.status(400).json({ error: 'Enter the potential sales price as a dollar amount.' });
  }
  const rawPct = req.body?.commission_pct;
  const pct = rawPct === null || rawPct === undefined || String(rawPct).trim() === '' ? DEFAULT_COMMISSION_PCT : Number(rawPct);
  if (!Number.isFinite(pct) || pct < 0 || pct > MAX_COMMISSION_PCT) {
    return res.status(400).json({ error: `The realtor commission must be between 0% and ${MAX_COMMISSION_PCT}%.` });
  }
  const closing = parseMoney(req.body?.closing_costs);
  if (Number.isNaN(closing) || (closing !== null && (closing < 0 || closing > MAX_CLOSING_COSTS))) {
    return res.status(400).json({ error: 'Enter the closing costs as a dollar amount.' });
  }
  const db = getDb();
  const before = db.prepare('SELECT potential_sale_price, commission_pct, closing_costs_amount FROM project_finance_inputs WHERE project_id = ?').get(project.id);
  const cents = value => (value === null ? null : Math.round(value * 100) / 100);
  const saved = { price: cents(price), pct: Math.round(pct * 100) / 100, closing: cents(closing) };
  db.prepare(`
    INSERT INTO project_finance_inputs (project_id, potential_sale_price, commission_pct, closing_costs_amount, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project_id) DO UPDATE SET
      potential_sale_price = excluded.potential_sale_price,
      commission_pct = excluded.commission_pct,
      closing_costs_amount = excluded.closing_costs_amount,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `).run(project.id, saved.price, saved.pct, saved.closing, req.user.id);
  const changed = [];
  if ((before?.potential_sale_price ?? null) !== saved.price) changed.push('potential_sale_price');
  if ((before?.commission_pct ?? DEFAULT_COMMISSION_PCT) !== saved.pct) changed.push('commission_pct');
  if ((before?.closing_costs_amount ?? null) !== saved.closing) changed.push('closing_costs');
  if (changed.length) {
    // No amounts and no project_id: the activity log is readable by project managers
    // (Security audit trail), and Finance figures must not reach them.
    logActivity({
      userId: req.user.id,
      action: 'finance_projection_updated',
      entityType: 'project',
      entityId: project.id,
      details: { fields: changed, cleared: saved.price === null },
    });
  }
  res.set('Cache-Control', 'no-store');
  res.json(payload(project));
});

// POST /class-alias - confirm that the project's QuickBooks class, whose name does not
// match the address (e.g. "1253 Milverton" for 2153 Milverton), is this property; any
// class carrying that name then counts here. DELETE undoes it. Super Admin only; the
// Finance figures are re-read from QuickBooks right away.
async function resync(req, project, res) {
  try {
    await syncBankDraws({ source: `class alias ${project.id}`, userId: req.user.id, force: true });
  } catch (_) {
    res.set('Cache-Control', 'no-store');
    return res.status(502).json({ ...payload(project), error: 'Saved. QuickBooks did not answer, so the figures update on the next refresh.' });
  }
  res.set('Cache-Control', 'no-store');
  return res.json(payload(project));
}

router.post('/class-alias', authorize(...GRANT_MANAGER_ROLES), async (req, res) => {
  const project = loadProject(req, res);
  if (!project) return;
  const label = String(req.body?.class_name || project.quickbooks_class_name || '').trim().slice(0, 120);
  const key = normalizeClassName(label);
  if (!key) return res.status(400).json({ error: 'This project is not linked to a QuickBooks class yet.' });
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO project_class_aliases (project_id, alias_key, label, confirmed_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, alias_key) DO NOTHING
  `).run(project.id, key, label, req.user.id);
  if (result.changes) {
    logActivity({
      userId: req.user.id,
      action: 'quickbooks_class_confirmed',
      entityType: 'project',
      entityId: project.id,
      details: { class_name: label, project: project.job_name || project.address },
    });
  }
  return resync(req, project, res);
});

router.delete('/class-alias', authorize(...GRANT_MANAGER_ROLES), async (req, res) => {
  const project = loadProject(req, res);
  if (!project) return;
  const label = String(req.body?.class_name || req.query?.class_name || project.quickbooks_class_name || '').trim();
  const key = normalizeClassName(label);
  const result = getDb().prepare('DELETE FROM project_class_aliases WHERE project_id = ? AND alias_key = ?').run(project.id, key);
  if (result.changes) {
    logActivity({
      userId: req.user.id,
      action: 'quickbooks_class_unconfirmed',
      entityType: 'project',
      entityId: project.id,
      details: { class_name: label, project: project.job_name || project.address },
    });
  }
  return resync(req, project, res);
});

module.exports = router;
