const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate, authorize } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { cleanPhone, sendContractorText } = require('../utils/textMessaging');

const router = express.Router();
router.use(authenticate);

const OFFICE_ROLES = ['super_admin', 'operations_manager', 'project_manager'];
const MAX_MESSAGE_LENGTH = 2000;

function messageSelect(whereSql = '1=1') {
  return `
    SELECT
      ctm.*,
      cp.vendor_name,
      cp.contact_name,
      cp.email as contractor_email,
      p.address as project_address,
      p.job_name as project_job_name,
      u.name as current_sender_name
    FROM contractor_text_messages ctm
    JOIN contractor_profiles cp ON cp.id = ctm.contractor_id
    LEFT JOIN projects p ON p.id = ctm.project_id
    LEFT JOIN users u ON u.id = ctm.sent_by_user_id
    WHERE ${whereSql}
    ORDER BY datetime(ctm.created_at) DESC, ctm.created_at DESC
  `;
}

function formatMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id || null,
    project_address: row.project_address || null,
    project_job_name: row.project_job_name || null,
    contractor_id: row.contractor_id,
    contractor_name: row.contractor_name || row.vendor_name,
    contractor_contact_name: row.contact_name || null,
    contractor_phone: row.contractor_phone,
    contractor_email: row.contractor_email || null,
    sent_by_user_id: row.sent_by_user_id,
    sent_by_name: row.sent_by_name || row.current_sender_name || 'Office',
    direction: row.direction || 'outbound',
    message_body: row.message_body,
    status: row.status,
    provider: row.provider,
    provider_message_id: row.provider_message_id || null,
    error_message: row.error_message || null,
    created_at: row.created_at,
    sent_at: row.sent_at || null,
    updated_at: row.updated_at,
  };
}

function requireContractor(db, contractorId) {
  return db.prepare(`
    SELECT id, vendor_name, contact_name, email, phone
    FROM contractor_profiles
    WHERE id = ?
  `).get(contractorId);
}

function requireProject(db, projectId) {
  if (!projectId) return null;
  return db.prepare('SELECT id, address, job_name FROM projects WHERE id = ?').get(projectId);
}

router.get('/', authorize(...OFFICE_ROLES), (req, res) => {
  const db = getDb();
  const projectId = String(req.query.project_id || '').trim();
  const contractorId = String(req.query.contractor_id || '').trim();
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100;
  const clauses = [];
  const params = [];

  if (projectId) {
    clauses.push('ctm.project_id = ?');
    params.push(projectId);
  }
  if (contractorId) {
    clauses.push('ctm.contractor_id = ?');
    params.push(contractorId);
  }

  const whereSql = clauses.length ? clauses.join(' AND ') : '1=1';
  const rows = db.prepare(`${messageSelect(whereSql)} LIMIT ?`).all(...params, limit);
  res.json({ messages: rows.map(formatMessage) });
});

router.post('/', authorize(...OFFICE_ROLES), async (req, res) => {
  try {
    const db = getDb();
    const contractorId = String(req.body.contractor_id || '').trim();
    const projectId = String(req.body.project_id || '').trim();
    const body = String(req.body.message || req.body.body || '').trim();

    if (!contractorId) return res.status(400).json({ error: 'Contractor is required' });
    if (!body) return res.status(400).json({ error: 'Message text is required' });
    if (body.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer` });
    }

    const contractor = requireContractor(db, contractorId);
    if (!contractor) return res.status(404).json({ error: 'Contractor not found' });

    const phone = cleanPhone(contractor.phone);
    if (!phone) return res.status(400).json({ error: 'Contractor does not have a usable phone number on file' });

    const project = requireProject(db, projectId);
    if (projectId && !project) return res.status(404).json({ error: 'Project not found' });

    const delivery = await sendContractorText({
      to: phone,
      body,
      metadata: {
        project_id: project?.id || null,
        project_address: project?.address || null,
        contractor_id: contractor.id,
        contractor_name: contractor.vendor_name,
        sent_by_user_id: req.user.id,
        sent_by_name: req.user.name,
      },
    });

    const id = uuidv4();
    const now = new Date().toISOString();
    const sentAt = delivery.status === 'sent' || delivery.status === 'delivered' ? now : null;

    db.prepare(`
      INSERT INTO contractor_text_messages (
        id, project_id, contractor_id, contractor_name, contractor_phone,
        sent_by_user_id, sent_by_name, direction, message_body, status, provider,
        provider_message_id, error_message, created_at, sent_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      project?.id || null,
      contractor.id,
      contractor.vendor_name,
      phone,
      req.user.id,
      req.user.name,
      body,
      delivery.status,
      delivery.provider,
      delivery.providerMessageId,
      delivery.errorMessage,
      now,
      sentAt,
      now
    );

    if (project?.id) {
      logActivity({
        userId: req.user.id,
        projectId: project.id,
        action: 'contractor_text_message_recorded',
        entityType: 'contractor_text_message',
        entityId: id,
        details: {
          contractor_id: contractor.id,
          contractor_name: contractor.vendor_name,
          contractor_phone: phone,
          status: delivery.status,
          provider: delivery.provider,
        },
      });
    }

    const row = db.prepare(messageSelect('ctm.id = ?')).get(id);
    res.status(201).json({ message: formatMessage(row) });
  } catch (err) {
    console.error('Failed to record contractor text message:', err);
    res.status(500).json({ error: 'Failed to record contractor text message' });
  }
});

module.exports = router;
