const express = require('express');
const { authenticate } = require('../middleware/auth');
const { logDataAccess } = require('../utils/dataAccessAudit');
const { requireFeature } = require('../utils/featureAccess');
const { syncBankDraws } = require('../services/bankDraws');
const { consolidatedFinances } = require('../services/consolidatedFinance');

// /api/finance/consolidated - the Consolidated Finances tab (Mike, 2026-10-19). Same
// access as the project Finance tab: Super Admin, or users a Super Admin granted.
const router = express.Router();
router.use(authenticate, requireFeature('bank_draws'));

router.get('/', (req, res) => {
  const body = consolidatedFinances();
  logDataAccess(req, {
    action: 'consolidated_finances_viewed',
    accessType: 'view',
    entityType: 'consolidated_finances',
    recordCount: body.totals.count,
    riskLevel: 'high',
  });
  res.set('Cache-Control', 'no-store');
  res.json(body);
});

// POST /sync - re-read QuickBooks (the same one-at-a-time sync the Finance tabs use).
router.post('/sync', async (req, res) => {
  try {
    await syncBankDraws({ source: 'consolidated finances', userId: req.user.id });
  } catch (_) {
    res.set('Cache-Control', 'no-store');
    return res.status(502).json({ ...consolidatedFinances(), error: 'QuickBooks did not answer. Showing the last copy BuildTrack saved.' });
  }
  res.set('Cache-Control', 'no-store');
  res.json(consolidatedFinances());
});

module.exports = router;
