const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const { getDb } = require('../db/schema');
const { authenticate, authorize } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { recordWorkItemEvent } = require('../utils/workItemEvents');

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

function headerFilename(filename) {
  return sanitizeFilename(filename).replace(/["\\\r\n]/g, '_');
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

function parseStoredAttachments(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function attachmentDisplayName(attachment) {
  return String(attachment?.original_name || attachment?.filename || 'Email attachment').trim();
}

function markAttachmentFiled(attachments, attachmentId, filed) {
  let found = false;
  const next = attachments.map(item => {
    if (item.id !== attachmentId) return item;
    found = true;
    return {
      ...item,
      filed_invoice_id: filed.invoiceId,
      filed_invoice_number: filed.invoiceNumber,
      filed_project_id: filed.projectId,
      filed_project_address: filed.projectAddress,
      filed_at: new Date().toISOString(),
    };
  });
  return { attachments: next, found };
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

function stripHtml(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMoneyValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number.parseFloat(String(value).replace(/[$,]/g, '').trim());
  return Number.isFinite(num) ? Math.max(num, 0) : null;
}

function extractAmount(text) {
  const raw = String(text || '');
  const dollarMatches = [...raw.matchAll(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+(?:\.[0-9]{2}))/g)];
  const labeledMatches = [...raw.matchAll(/\b(?:total|amount due|balance due|invoice amount|amount)\b[^0-9$]{0,30}\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+(?:\.[0-9]{2}))/gi)];
  const matches = [...dollarMatches, ...labeledMatches]
    .map(match => parseMoneyValue(match[1]))
    .filter(value => value !== null && value > 0);
  if (matches.length === 0) return null;
  return Math.max(...matches);
}

function extractInvoiceNumber(text) {
  const match = String(text || '').match(/\b(?:invoice|inv|bill)\s*(?:#|no\.?|number|num)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9._-]{2,40})\b/i);
  if (!match) return null;
  return match[1].replace(/[.,;:]+$/, '').slice(0, 60);
}

function bodyText(payload) {
  return [
    payload.subject,
    payload.textBody,
    stripHtml(payload.htmlBody),
  ].filter(Boolean).join(' ');
}

function inferInvoiceFields(payload) {
  const text = bodyText(payload);
  return {
    vendor: firstValue(payload.fromName, payload.fromEmail),
    invoiceNumber: extractInvoiceNumber(text),
    amount: extractAmount(text),
    summary: String(firstValue(payload.subject, text, 'Invoice received by email')).slice(0, 500),
  };
}

function normalizeMatchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function streetNeedle(address) {
  const normalized = normalizeMatchText(address)
    .replace(/\b(usa|united states|mi|michigan)\b/g, ' ')
    .replace(/\b(ave|avenue|st|street|rd|road|dr|drive|ln|lane|ct|court|blvd|boulevard)\b/g, match => match)
    .replace(/\s+/g, ' ')
    .trim();
  const parts = normalized.split(' ');
  return parts.slice(0, Math.min(parts.length, 3)).join(' ');
}

function matchProjectFromEmail(db, payload, fields) {
  const haystack = normalizeMatchText([
    payload.subject,
    payload.textBody,
    stripHtml(payload.htmlBody),
    fields.summary,
  ].join(' '));
  if (!haystack) return null;

  const projects = db.prepare(`
    SELECT id, address, job_name
    FROM projects
    WHERE status != 'archived'
  `).all();

  let best = null;
  for (const project of projects) {
    const address = normalizeMatchText(project.address);
    const jobName = normalizeMatchText(project.job_name);
    const street = streetNeedle(project.address);
    let score = 0;
    if (address && haystack.includes(address)) score = Math.max(score, 0.98);
    if (street && street.length >= 5 && haystack.includes(street)) score = Math.max(score, 0.82);
    if (jobName && jobName.length >= 5 && haystack.includes(jobName)) score = Math.max(score, 0.7);
    if (!best || score > best.score) best = { projectId: project.id, confidence: score };
  }

  return best && best.confidence > 0 ? best : null;
}

function nextInvoiceNumber(db) {
  const rows = db.prepare("SELECT invoice_number FROM invoices WHERE invoice_number LIKE 'NUD-%'").all();
  const max = rows.reduce((current, row) => {
    const num = Number.parseInt(String(row.invoice_number || '').replace('NUD-', ''), 10);
    return Number.isFinite(num) ? Math.max(current, num) : current;
  }, 1022);
  return `NUD-${max + 1}`;
}

function parseWorkItemIds(value) {
  const raw = Array.isArray(value) ? value : (value ? [value] : []);
  return [...new Set(raw.map(item => String(item || '').trim()).filter(Boolean))];
}

function loadAssignmentOptions(db, projectId) {
  const scopes = db.prepare(`
    SELECT id, section_name, scope_title, status, sort_order
    FROM project_scopes
    WHERE project_id = ?
    ORDER BY sort_order ASC, datetime(created_at) ASC
  `).all(projectId);
  const tasks = db.prepare(`
    SELECT id, title, category, status, verification_status, invoice_status, project_scope_id, sort_order
    FROM construction_plan_items
    WHERE project_id = ?
    ORDER BY sort_order ASC, datetime(created_at) ASC
  `).all(projectId);
  return { scopes, tasks };
}

function createInvoiceTask(db, { projectId, scopeId, title, description, user }) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) {
    throw Object.assign(new Error('Select an existing task or enter a new task name for this invoice.'), { statusCode: 400 });
  }

  let scope = null;
  if (scopeId) {
    scope = db.prepare('SELECT id, section_name, scope_title FROM project_scopes WHERE id = ? AND project_id = ?')
      .get(scopeId, projectId);
    if (!scope) throw Object.assign(new Error('Selected scope does not belong to this project.'), { statusCode: 400 });
  }

  const id = uuidv4();
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max FROM construction_plan_items WHERE project_id = ?').get(projectId);
  db.prepare(`
    INSERT INTO construction_plan_items (
      id, project_id, project_scope_id, title, description, category, status,
      verification_status, invoice_status, sort_order, created_by
    )
    VALUES (?, ?, ?, ?, ?, ?, 'needs_review', 'pending_review', 'received', ?, ?)
  `).run(
    id,
    projectId,
    scope?.id || null,
    cleanTitle,
    description || null,
    scope?.section_name || 'Invoice Review',
    Number(maxOrder?.max || 0) + 1,
    user.id
  );
  return id;
}

function syncInvoiceWorkItems(db, { invoiceId, projectId, user, workItemIds }) {
  const nextIds = parseWorkItemIds(workItemIds);
  if (nextIds.length === 0) {
    throw Object.assign(new Error('Each invoice must be assigned to at least one project scope task.'), { statusCode: 400 });
  }

  const placeholders = nextIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, status, verification_status, invoice_status
    FROM construction_plan_items
    WHERE project_id = ?
      AND id IN (${placeholders})
  `).all(projectId, ...nextIds);

  if (rows.length !== nextIds.length) {
    const found = new Set(rows.map(row => row.id));
    const missing = nextIds.filter(id => !found.has(id));
    throw Object.assign(new Error(`Invalid project task selected: ${missing.join(', ')}`), { statusCode: 400 });
  }

  db.prepare('DELETE FROM invoice_work_items WHERE invoice_id = ?').run(invoiceId);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO invoice_work_items (id, invoice_id, project_id, construction_plan_item_id, linked_by)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateTask = db.prepare(`
    UPDATE construction_plan_items
    SET invoice_status = CASE
          WHEN verification_status = 'approved' THEN 'approved_for_payment'
          ELSE 'received'
        END,
        verification_status = CASE
          WHEN verification_status = 'approved' THEN verification_status
          WHEN verification_status = 'not_requested' THEN 'pending_review'
          ELSE verification_status
        END,
        updated_at = datetime('now')
    WHERE id = ? AND project_id = ?
  `);

  rows.forEach(row => {
    const after = {
      ...row,
      invoice_status: row.verification_status === 'approved' ? 'approved_for_payment' : 'received',
      verification_status: row.verification_status === 'approved'
        ? row.verification_status
        : (row.verification_status === 'not_requested' ? 'pending_review' : row.verification_status),
    };
    insert.run(uuidv4(), invoiceId, projectId, row.id, user.id);
    updateTask.run(row.id, projectId);
    recordWorkItemEvent(db, {
      projectId,
      itemId: row.id,
      invoiceId,
      actor: user,
      eventType: 'invoice_linked',
      before: row,
      after,
      comment: 'Invoice assigned to project scope task from the invoice review screen.',
    });
  });
}

function assignmentTaskIds(db, req, projectId, fallbackTitle) {
  const ids = parseWorkItemIds(req.body?.work_item_ids || req.body?.work_item_id || req.body?.task_id);
  const newTaskTitle = String(req.body?.new_task_title || '').trim();
  if (newTaskTitle) {
    ids.push(createInvoiceTask(db, {
      projectId,
      scopeId: String(req.body?.project_scope_id || '').trim() || null,
      title: newTaskTitle,
      description: fallbackTitle,
      user: req.user,
    }));
  }
  return [...new Set(ids)];
}

function fallbackContractorId(db, intake, user) {
  if (intake?.from_email) {
    const match = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(intake.from_email);
    if (match) return match.id;
  }
  return user.id;
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
  const inferred = inferInvoiceFields(payload);
  const projectMatch = matchProjectFromEmail(db, payload, inferred);

  db.prepare(`
    INSERT INTO invoice_email_intake (
      id, provider, provider_message_id, message_hash, from_email, from_name, to_email, cc_email,
      subject, text_body, html_body, attachment_count, attachments_json, status,
      extracted_vendor, extracted_invoice_number, extracted_amount, extracted_summary,
      matched_project_id, match_confidence, agent_status, agent_notes, received_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    inferred.vendor || null,
    inferred.invoiceNumber || null,
    inferred.amount,
    inferred.summary || null,
    projectMatch?.projectId || null,
    projectMatch?.confidence || null,
    projectMatch ? 'matched' : 'pending',
    projectMatch ? 'Auto-matched by address/job text; office assignment still required.' : null,
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

  res.json(rows.map(row => {
    const attachments = parseStoredAttachments(row.attachments_json);
    const filedAttachments = attachments.filter(item => item.filed_invoice_id);
    return {
      ...row,
      body_preview: stripHtml(row.text_body || row.html_body || row.extracted_summary || '').slice(0, 3000),
      attachments,
      filed_attachment_count: filedAttachments.length,
      unfiled_attachment_count: Math.max(attachments.length - filedAttachments.length, 0),
    };
  }));
});

authenticatedRouter.get('/assignment-options', (req, res) => {
  const projectId = String(req.query.project_id || '').trim();
  if (!projectId) return res.status(400).json({ error: 'project_id is required' });

  const db = getDb();
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(loadAssignmentOptions(db, projectId));
});

authenticatedRouter.post('/:id/file', (req, res) => {
  try {
    const db = getDb();
    const intake = db.prepare('SELECT * FROM invoice_email_intake WHERE id = ?').get(req.params.id);
    if (!intake) return res.status(404).json({ error: 'Inbound invoice email not found' });
    if (intake.status === 'ignored') return res.status(400).json({ error: 'Ignored invoice emails cannot be filed until reopened.' });
    const attachmentId = String(req.body?.attachment_id || '').trim();
    const storedAttachments = parseStoredAttachments(intake.attachments_json);
    const selectedAttachment = attachmentId ? storedAttachments.find(item => item.id === attachmentId) : null;
    if (attachmentId && !selectedAttachment) return res.status(404).json({ error: 'Email attachment not found' });
    const selectedAttachmentName = selectedAttachment ? attachmentDisplayName(selectedAttachment) : '';

    const projectId = String(req.body?.project_id || intake.matched_project_id || '').trim();
    if (!projectId) return res.status(400).json({ error: 'Select a project before filing this invoice.' });
    const project = db.prepare('SELECT id, address, job_name FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const vendorName = String(firstValue(req.body?.vendor_name, intake.extracted_vendor, intake.from_name, intake.from_email, 'Email Vendor')).trim();
    const vendorEmail = String(firstValue(req.body?.vendor_email, intake.from_email)).trim();
    const externalInvoiceNumber = String(firstValue(req.body?.external_invoice_number, intake.extracted_invoice_number)).trim();
    const total = parseMoneyValue(firstValue(req.body?.total, intake.extracted_amount)) || 0;
    const taskDescription = [
      `Filed from invoice email: ${intake.subject || '(no subject)'}`,
      selectedAttachmentName ? `Attachment: ${selectedAttachmentName}` : '',
      intake.extracted_summary || '',
      vendorName ? `Vendor: ${vendorName}` : '',
      externalInvoiceNumber ? `Vendor invoice: ${externalInvoiceNumber}` : '',
    ].filter(Boolean).join('\n');

    let invoiceRecord;
    const fileInvoice = db.transaction(() => {
      const taskIds = assignmentTaskIds(db, req, projectId, intake.subject || vendorName || 'Invoice review');
      if (taskIds.length === 0) {
        throw Object.assign(new Error('Select or create a scope task before filing this invoice.'), { statusCode: 400 });
      }

      const existingInvoice = attachmentId
        ? db.prepare('SELECT * FROM invoices WHERE source_intake_id = ? AND source_attachment_id = ?').get(intake.id, attachmentId)
        : db.prepare("SELECT * FROM invoices WHERE source_intake_id = ? AND (source_attachment_id IS NULL OR source_attachment_id = '')").get(intake.id);
      const contractorId = fallbackContractorId(db, intake, req.user);
      const invoiceId = existingInvoice?.id || uuidv4();
      const invoiceNumber = existingInvoice?.invoice_number || nextInvoiceNumber(db);
      const notes = [
        intake.extracted_summary || intake.subject || 'Invoice received by email.',
        selectedAttachmentName ? `Email attachment: ${selectedAttachmentName}` : '',
        intake.from_email ? `Email from: ${intake.from_email}` : '',
      ].filter(Boolean).join('\n');

      if (existingInvoice) {
        db.prepare(`
          UPDATE invoices
          SET project_id = ?, status = CASE WHEN status = 'draft' THEN 'submitted' ELSE status END,
              total = ?, notes = COALESCE(NULLIF(?, ''), notes), source = 'email',
              vendor_name = ?, vendor_email = ?, external_invoice_number = ?,
              source_attachment_id = ?, source_attachment_name = ?,
              submitted_at = COALESCE(submitted_at, datetime('now')), updated_at = datetime('now')
          WHERE id = ?
        `).run(
          projectId,
          total,
          notes,
          vendorName || null,
          vendorEmail || null,
          externalInvoiceNumber || null,
          attachmentId || null,
          selectedAttachmentName || null,
          invoiceId
        );
      } else {
        db.prepare(`
          INSERT INTO invoices (
            id, invoice_number, project_id, contractor_id, status, notes, total, source,
            source_intake_id, source_attachment_id, source_attachment_name,
            vendor_name, vendor_email, external_invoice_number, submitted_at
          )
          VALUES (?, ?, ?, ?, 'submitted', ?, ?, 'email', ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          invoiceId,
          invoiceNumber,
          projectId,
          contractorId,
          notes,
          total,
          intake.id,
          attachmentId || null,
          selectedAttachmentName || null,
          vendorName || null,
          vendorEmail || null,
          externalInvoiceNumber || null
        );
      }

      db.prepare('DELETE FROM invoice_line_items WHERE invoice_id = ?').run(invoiceId);
      db.prepare('INSERT INTO invoice_line_items (id, invoice_id, description, amount, sort_order) VALUES (?, ?, ?, ?, 0)')
        .run(
          uuidv4(),
          invoiceId,
          selectedAttachmentName
            ? `Email attachment ${selectedAttachmentName}`
            : externalInvoiceNumber
              ? `Vendor invoice ${externalInvoiceNumber}`
              : (intake.subject || 'Email invoice'),
          total
        );

      syncInvoiceWorkItems(db, { invoiceId, projectId, user: req.user, workItemIds: taskIds });

      const attachmentUpdate = attachmentId
        ? markAttachmentFiled(storedAttachments, attachmentId, {
          invoiceId,
          invoiceNumber,
          projectId,
          projectAddress: project.address,
        })
        : { attachments: storedAttachments, found: false };
      const updatedAttachments = attachmentUpdate.attachments;
      const allAttachmentsFiled = updatedAttachments.length > 0 && updatedAttachments.every(item => item.filed_invoice_id);
      const nextEmailStatus = attachmentId && !allAttachmentsFiled ? 'new' : 'filed';
      const nextAgentStatus = attachmentId && !allAttachmentsFiled ? 'needs_review' : 'filed';

      db.prepare(`
        UPDATE invoice_email_intake
        SET status = ?, agent_status = ?, matched_project_id = ?,
            attachments_json = ?,
            extracted_vendor = COALESCE(NULLIF(?, ''), extracted_vendor),
            extracted_invoice_number = COALESCE(NULLIF(?, ''), extracted_invoice_number),
            extracted_amount = ?,
            agent_notes = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(
        nextEmailStatus,
        nextAgentStatus,
        projectId,
        JSON.stringify(updatedAttachments),
        vendorName,
        externalInvoiceNumber,
        total,
        attachmentId
          ? `Attachment filed into BuildTrack invoice and linked to project scope task. ${updatedAttachments.filter(item => item.filed_invoice_id).length}/${updatedAttachments.length} attachment(s) assigned.`
          : 'Filed into BuildTrack invoice and linked to project scope task.',
        intake.id
      );

      logActivity({
        userId: req.user.id,
        projectId,
        action: existingInvoice ? 'invoice_email_refiled' : 'invoice_email_filed',
        entityType: 'invoice',
        entityId: invoiceId,
        details: {
          intake_id: intake.id,
          attachment_id: attachmentId || null,
          attachment_name: selectedAttachmentName || null,
          linked_work_items: taskIds.length,
        },
      });

      invoiceRecord = db.prepare(`
        SELECT i.*, p.address, p.job_name, u.name as contractor_name,
          (SELECT COUNT(*) FROM invoice_work_items iwi WHERE iwi.invoice_id = i.id) as linked_work_count
        FROM invoices i
        JOIN projects p ON p.id = i.project_id
        JOIN users u ON u.id = i.contractor_id
        WHERE i.id = ?
      `).get(invoiceId);
    });

    fileInvoice();
    res.status(201).json({ message: 'Invoice filed to project and task', invoice: invoiceRecord });
  } catch (err) {
    console.error('[INBOUND INVOICE] Failed to file email invoice:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to file invoice email' });
  }
});

authenticatedRouter.put('/invoice-records/:invoiceId/assignment', (req, res) => {
  try {
    const db = getDb();
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.invoiceId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status === 'paid') return res.status(400).json({ error: 'Paid invoices cannot be reassigned.' });

    const projectId = String(req.body?.project_id || invoice.project_id || '').trim();
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let updated;
    const updateAssignment = db.transaction(() => {
      const taskIds = assignmentTaskIds(db, req, projectId, invoice.external_invoice_number || invoice.invoice_number);
      if (taskIds.length === 0) {
        throw Object.assign(new Error('Select or create a scope task before saving invoice assignment.'), { statusCode: 400 });
      }

      db.prepare("UPDATE invoices SET project_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(projectId, invoice.id);
      syncInvoiceWorkItems(db, { invoiceId: invoice.id, projectId, user: req.user, workItemIds: taskIds });

      logActivity({
        userId: req.user.id,
        projectId,
        action: 'invoice_assignment_updated',
        entityType: 'invoice',
        entityId: invoice.id,
        details: { linked_work_items: taskIds.length },
      });

      updated = db.prepare(`
        SELECT i.*, p.address, p.job_name, u.name as contractor_name,
          (SELECT COUNT(*) FROM invoice_work_items iwi WHERE iwi.invoice_id = i.id) as linked_work_count
        FROM invoices i
        JOIN projects p ON p.id = i.project_id
        JOIN users u ON u.id = i.contractor_id
        WHERE i.id = ?
      `).get(invoice.id);
    });

    updateAssignment();
    res.json({ message: 'Invoice assignment updated', invoice: updated });
  } catch (err) {
    console.error('[INVOICE] Failed to update invoice assignment:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to update invoice assignment' });
  }
});

authenticatedRouter.put('/:id/status', (req, res) => {
  const status = String(req.body?.status || '');
  if (!['new', 'filed', 'ignored'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const db = getDb();
  const existing = db.prepare('SELECT id, status, subject, from_email FROM invoice_email_intake WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Inbound invoice email not found' });

  const agentStatus = status === 'ignored' ? 'ignored' : status === 'filed' ? 'filed' : 'pending';
  const result = db.prepare("UPDATE invoice_email_intake SET status = ?, agent_status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, agentStatus, req.params.id);
  if (result.changes > 0) {
    logActivity({
      userId: req.user.id,
      action: status === 'ignored' ? 'invoice_email_marked_not_invoice' : 'invoice_email_status_updated',
      entityType: 'invoice_email_intake',
      entityId: req.params.id,
      details: {
        previous_status: existing.status,
        next_status: status,
        subject: existing.subject || null,
        from_email: existing.from_email || null,
        reason: status === 'ignored' ? 'not_an_invoice' : null,
      },
    });
  }
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

  if (String(req.query.inline || req.query.preview || '') === '1') {
    res.setHeader('Content-Type', attachment.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${headerFilename(attachment.original_name)}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.sendFile(filePath);
  }

  res.download(filePath, attachment.original_name);
});

module.exports = { publicRouter, authenticatedRouter, storeInboundInvoice };
