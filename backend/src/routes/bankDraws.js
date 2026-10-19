const express = require('express');
const { getDb } = require('../db/schema');
const { authenticate } = require('../middleware/auth');
const { logDataAccess } = require('../utils/dataAccessAudit');
const { requireFeature } = require('../utils/featureAccess');
const { isStale, projectBankDraws, syncBankDraws, syncState } = require('../services/bankDraws');

// /api/projects/:projectId/bank-draws - the project's construction-loan draws from
// QuickBooks. Super Admin, Operations Manager and users granted 'bank_draws' only;
// project managers and contractors get 403 (Mike, 2026-10-19).
const router = express.Router({ mergeParams: true });
router.use(authenticate, requireFeature('bank_draws'));

function loadProject(req, res) {
  const project = getDb().prepare(`
    SELECT id, address, job_name, quickbooks_class_id, quickbooks_class_name
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

module.exports = router;
