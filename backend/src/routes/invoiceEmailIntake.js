const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const { getDb } = require('../db/schema');
const { authenticate, authorize } = require('../middleware/auth');

const publicRouter = express.Router();
const authenticatedRouter = express.Router();

const ADMIN_ROLES = ['super_admin', 'operations_manager', 'project_manager', 'admin_assistant'];
const MAX_FILE_SIZE_MB = Number.parseInt(process.env.MAX_FILE_SIZE_MB || '20', 10);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 20,
    fileSize: Math.max(MAX_FILE_SIZE_MB, 1) * 1024 * 1024,
  },
});

function safeCompare(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireInboundToken(req, res, next) {
  const expected = process.env.INBOUND_INVOICE_TOKEN;
  if (!expected || expected === 'replace_with_random_shared_secret') {
    return res.status(503).json({ error: 'Inbound invoice intake is not configured' });
  }

  const auth = req.get('authorization') || '';
  const supplied =
    req.get('x-inbound-invoice-token') ||
    req.get('x-buildtrack-inbound-token') ||
    (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '');

  if (!safeCompare(supplied, expected)) {
    return res.status(401).json({ error: 'Invalid inbound invoice token' });
  }

  next();
}

function firstValue(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length > 0) return value[0];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function parseAddress(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(.*?)<([^>]+)>$/);
  if (match) {
    return {
      name: match[1].trim().replace(/^"|"$/g, ''),
      email: match[2].trim().toLowerCase(),
    };
  }
  return { name: '', email: raw.toLowerCase() };
}

function sanitizeFilename(filename) {
  const base = path.basename(String(filename || 'invoice-attachment'));
  return base.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 180) || 'invoice-attachment';
}

function uploadRoot() {
  return path.resolve(
    process.env.INBOUND_INVOICE_UPLOADS_PATH ||
    path.join(process.env.UPLOADS_PATH || './uploads', 'inbound-invoices')
  );
}

function saveAttachment(intakeId, attachment) {
  const id = uuidv4();
  const originalName = sanitizeFilename(attachment.originalname || attachment.filename || attachment.name);
  const ext = path.extname(originalName);
  const storedName = `${id}${ext || ''}`;
  const dir = path.join(uploadRoot(), intakeId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const buffer = attachment.buffer || Buffer.from(attachment.dataBase64 || attachment.content || '', 'base64');
  fs.writeFileSync(path.join(dir, storedName), buffer);

  return {
    id,
    original_name: originalName,
    filename: storedName,
    mime_type: attachment.mimetype || attachment.mimeType || attachment.contentType || 'application/octet-stream',
    size: buffer.length,
  };
}

function jsonAttachments(body) {
  const attachments = body.attachments || body.Attachments || [];
  if (!Array.isArray(attachments)) return [];

  return attachments
    .filter(item => item && (item.dataBase64 || item.content))
    .map(item => ({
      originalname: item.filename || item.name || item.original_name,
      mimetype: item.mimeType || item.contentType || item.mime_type,
      dataBase64: item.dataBase64 || item.content,
    }));
}

function normalizePayload(req) {
  const body = req.body || {};
  const fromRaw = firstValue(body.from, body.From, body.sender, body.Sender, body.FromFull?.Email);
  const from = parseAddress(fromRaw);
  const providerMessageId = firstValue(
    body.messageId,
    body.message_id,
    body.MessageID,
    body['Message-Id'],
    body['message-id']
  );

  const receivedAtRaw = firstValue(body.receivedAt, body.received_at, body.Date, new Date().toISOString());
  const receivedAtDate = new Date(receivedAtRaw);

  return {
    provider: firstValue(body.provider, body.Provider, req.get('x-email-provider'), 'webhook'),
    providerMessageId,
    fromName: firstValue(body.fromName, body.from_name, body.FromFull?.Name, from.name),
    fromEmail: firstValue(body.fromEmail, body.from_email, from.email),
    toEmail: firstValue(body.to, body.To, body.recipient, body.Recipient),
    ccEmail: firstValue(body.cc, body.Cc),
    subject: firstValue(body.subject, body.Subject, '(no subject)'),
    textBody: firstValue(body.text, body.TextBody, body['body-plain'], body.bodyPlain, body.strippedText),
    htmlBody: firstValue(body.html, body.HtmlBody, body['body-html'], body.bodyHtml, body.strippedHtml),
    receivedAt: Number.isNaN(receivedAtDate.getTime()) ? new Date().toISOString() : receivedAtDate.toISOString(),
    attachments: [...(req.files || []), ...jsonAttachments(body)],
  };
}

function createMessageHash(payload) {
  const stable = [
    payload.provider,
    payload.providerMessageId,
    payload.fromEmail,
    payload.toEmail,
    payload.subject,
    payload.receivedAt,
    String(payload.textBody || '').slice(0, 500),
  ].join('|');
  return crypto.createHash('sha256').update(stable).digest('hex');
}

function storeInboundInvoice(payload) {
  const db = getDb();
  const messageHash = createMessageHash(payload);
  const existing = db.prepare('SELECT id FROM invoice_email_intake WHERE message_hash = ?').get(messageHash);
  if (existing) {
    return { ok: true, duplicate: true, id: existing.id, attachment_count: 0 };
  }

  const id = uuidv4();
  const attachments = (payload.attachments || []).map(attachment => saveAttachment(id, attachment));

  db.prepare(`
    INSERT INTO invoice_email_intake (
      id, provider, provider_message_id, message_hash, from_email, from_name, to_email, cc_email,
      subject, text_body, html_body, attachment_count, attachments_json, status, received_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
  `).run(
    id,
    payload.provider,
    payload.providerMessageId || null,
    messageHash,
    payload.fromEmail || null,
    payload.fromName || null,
    payload.toEmail || null,
    payload.ccEmail || null,
    payload.subject || '(no subject)',
    payload.textBody ? String(payload.textBody).slice(0, 20000) : null,
    payload.htmlBody ? String(payload.htmlBody).slice(0, 50000) : null,
    attachments.length,
    JSON.stringify(attachments),
    payload.receivedAt
  );

  return { ok: true, id, duplicate: false, attachment_count: attachments.length };
}

publicRouter.get('/health', (_req, res) => {
  res.json({ ok: true, configured: Boolean(process.env.INBOUND_INVOICE_TOKEN) });
});

function handleInboundInvoice(req, res) {
  try {
    const payload = normalizePayload(req);
    const result = storeInboundInvoice(payload);
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (err) {
    console.error('[INBOUND INVOICE] Failed to store email:', err);
    res.status(500).json({ error: 'Failed to store inbound invoice email' });
  }
}

publicRouter.post('/', requireInboundToken, upload.any(), handleInboundInvoice);

publicRouter.post('/google-workspace', requireInboundToken, upload.any(), (req, res) => {
  req.body = { ...(req.body || {}), provider: req.body?.provider || 'google-workspace' };
  handleInboundInvoice(req, res);
});

authenticatedRouter.use(authenticate);
authenticatedRouter.use(authorize(...ADMIN_ROLES));

authenticatedRouter.get('/', (req, res) => {
  const db = getDb();
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 50;
  const status = String(req.query.status || '').trim();

  const where = status ? 'WHERE e.status = ?' : '';
  const params = status ? [status, limit] : [limit];
  const rows = db.prepare(`
    SELECT e.*, p.address as matched_project_address, p.job_name as matched_project_job_name
    FROM invoice_email_intake e
    LEFT JOIN projects p ON p.id = e.matched_project_id
    ${where}
    ORDER BY datetime(e.received_at) DESC, datetime(e.created_at) DESC
    LIMIT ?
  `).all(...params);

  res.json(rows.map(row => ({
    ...row,
    attachments: JSON.parse(row.attachments_json || '[]'),
  })));
});

authenticatedRouter.put('/:id/status', (req, res) => {
  const status = String(req.body?.status || '');
  if (!['new', 'filed', 'ignored'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const db = getDb();
  const agentStatus = status === 'ignored' ? 'ignored' : status === 'filed' ? 'filed' : 'pending';
  const result = db.prepare("UPDATE invoice_email_intake SET status = ?, agent_status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, agentStatus, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Inbound invoice email not found' });
  res.json({ message: 'Status updated' });
});

authenticatedRouter.get('/:id/attachments/:attachmentId', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT attachments_json FROM invoice_email_intake WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Inbound invoice email not found' });

  const attachment = JSON.parse(row.attachments_json || '[]').find(item => item.id === req.params.attachmentId);
  if (!attachment) return res.status(404).json({ error: 'Attachment not found' });

  const root = uploadRoot();
  const filePath = path.resolve(root, req.params.id, attachment.filename);
  if (!filePath.startsWith(root) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Attachment file not found' });
  }

  res.download(filePath, attachment.original_name);
});

module.exports = { publicRouter, authenticatedRouter, storeInboundInvoice };
