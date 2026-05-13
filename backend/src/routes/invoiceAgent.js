const express = require('express');

const { getDb } = require('../db/schema');
const { authenticate, authorize } = require('../middleware/auth');
const {
  hasAnthropicConfig,
  manualFileIntake,
  runInvoiceAgentForIntake,
  runPendingInvoiceAgent,
} = require('../services/invoiceAgent');
const { runPortalAgentScan } = require('../services/portalAgent');

const router = express.Router();
const ADMIN_ROLES = ['super_admin', 'operations_manager', 'project_manager', 'admin_assistant'];

router.use(authenticate);
router.use(authorize(...ADMIN_ROLES));

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; }
}

function intakeSelect() {
  return `
    SELECT
      e.*,
      p.address as matched_project_address,
      p.job_name as matched_project_job_name
    FROM invoice_email_intake e
    LEFT JOIN projects p ON p.id = e.matched_project_id
  `;
}

function mapIntake(row) {
  return {
    ...row,
    attachments: parseJson(row.attachments_json, []),
    agent_result: parseJson(row.agent_result_json, null),
  };
}

router.get('/', (req, res) => {
  const db = getDb();
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '100', 10), 1), 300);
  const status = String(req.query.status || '').trim();
  const where = status ? "WHERE COALESCE(e.agent_status, 'pending') = ?" : '';
  const params = status ? [status, limit] : [limit];
  const rows = db.prepare(`
    ${intakeSelect()}
    ${where}
    ORDER BY datetime(e.received_at) DESC, datetime(e.created_at) DESC
    LIMIT ?
  `).all(...params);

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_count,
      SUM(CASE WHEN status = 'filed' THEN 1 ELSE 0 END) as filed_count,
      SUM(CASE WHEN status = 'ignored' THEN 1 ELSE 0 END) as ignored_count,
      SUM(CASE WHEN COALESCE(agent_status, 'pending') = 'pending' THEN 1 ELSE 0 END) as pending_count,
      SUM(CASE WHEN agent_status = 'matched' THEN 1 ELSE 0 END) as matched_count,
      SUM(CASE WHEN agent_status = 'needs_review' THEN 1 ELSE 0 END) as needs_review_count,
      SUM(CASE WHEN agent_status = 'error' THEN 1 ELSE 0 END) as error_count,
      SUM(CASE WHEN extracted_amount IS NOT NULL THEN extracted_amount ELSE 0 END) as extracted_total
    FROM invoice_email_intake
  `).get();

  const latestRuns = db.prepare(`
    SELECT *
    FROM invoice_agent_runs
    ORDER BY datetime(created_at) DESC
    LIMIT 20
  `).all().map(run => ({ ...run, result: parseJson(run.result_json, null) }));

  const latestPortalScan = db.prepare(`
    SELECT *
    FROM portal_agent_runs
    ORDER BY datetime(created_at) DESC
    LIMIT 1
  `).get();

  res.json({
    configured: hasAnthropicConfig(),
    model: process.env.ANTHROPIC_MODEL || null,
    auto_file: String(process.env.INVOICE_AGENT_AUTO_FILE || '').toLowerCase() === 'true',
    stats,
    items: rows.map(mapIntake),
    latest_runs: latestRuns,
    latest_portal_scan: latestPortalScan ? {
      ...latestPortalScan,
      findings: parseJson(latestPortalScan.findings_json, []),
    } : null,
  });
});

router.post('/run', async (req, res) => {
  try {
    const result = await runPendingInvoiceAgent({
      force: Boolean(req.body?.force),
      limit: req.body?.limit,
    });
    res.json(result);
  } catch (err) {
    console.error('[INVOICE AGENT] Manual batch run failed:', err);
    res.status(500).json({ error: err.message || 'Invoice agent failed' });
  }
});

router.post('/portal-scan', async (_req, res) => {
  try {
    const result = await runPortalAgentScan();
    res.json(result);
  } catch (err) {
    console.error('[PORTAL AGENT] Manual scan failed:', err);
    res.status(500).json({ error: err.message || 'Portal agent scan failed' });
  }
});

router.post('/:id/run', async (req, res) => {
  try {
    const result = await runInvoiceAgentForIntake(req.params.id, { force: true });
    res.json(result);
  } catch (err) {
    console.error('[INVOICE AGENT] Manual item run failed:', err);
    res.status(err.message === 'Inbound invoice email not found' ? 404 : 500).json({ error: err.message || 'Invoice agent failed' });
  }
});

router.put('/:id/file', (req, res) => {
  try {
    const projectId = String(req.body?.project_id || '').trim();
    if (!projectId) return res.status(400).json({ error: 'project_id is required' });
    res.json(manualFileIntake(req.params.id, projectId));
  } catch (err) {
    res.status(err.message === 'Project not found' || err.message === 'Inbound invoice email not found' ? 404 : 500)
      .json({ error: err.message || 'Failed to file invoice email' });
  }
});

module.exports = router;
