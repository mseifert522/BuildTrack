const fs = require('fs');
const crypto = require('crypto');

const { getDb } = require('../db/schema');
const { storeInboundInvoice } = require('../routes/invoiceEmailIntake');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const DEFAULT_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const DEFAULT_LABEL = 'BuildTrackImported';
const DEFAULT_QUERY = 'to:invoices@newurbandev.com newer_than:30d';

let timer = null;
let running = false;

function enabled() {
  return String(process.env.GMAIL_INVOICE_ENABLED || '').toLowerCase() === 'true';
}

function b64urlBytes(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlJson(value) {
  return b64urlBytes(Buffer.from(JSON.stringify(value), 'utf8'));
}

function decodeBase64Url(value) {
  const input = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = input.padEnd(Math.ceil(input.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

function loadServiceAccountKey() {
  if (process.env.GMAIL_INVOICE_SERVICE_ACCOUNT_KEY) {
    return JSON.parse(process.env.GMAIL_INVOICE_SERVICE_ACCOUNT_KEY);
  }

  const keyPath = process.env.GMAIL_INVOICE_SERVICE_ACCOUNT_KEY_PATH;
  if (!keyPath) {
    throw new Error('GMAIL_INVOICE_SERVICE_ACCOUNT_KEY_PATH is required when Gmail invoice intake is enabled');
  }

  return JSON.parse(fs.readFileSync(keyPath, 'utf8'));
}

async function getAccessToken(key, subject) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: key.private_key_id };
  const claim = {
    iss: key.client_email,
    scope: process.env.GMAIL_INVOICE_SCOPE || DEFAULT_SCOPE,
    aud: TOKEN_URL,
    sub: subject,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64urlJson(header)}.${b64urlJson(claim)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned, 'utf8'), key.private_key);
  const assertion = `${unsigned}.${b64urlBytes(signature)}`;

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Google OAuth failed: ${response.status} ${body.error || ''} ${body.error_description || ''}`.trim());
  }
  return body.access_token;
}

async function gmailFetch(token, path, options = {}) {
  const response = await fetch(`${GMAIL_API}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Gmail API failed: ${response.status} ${JSON.stringify(body.error || body)}`);
  }
  return body;
}

function headerValue(message, name) {
  const headers = message.payload?.headers || [];
  const match = headers.find(header => String(header.name || '').toLowerCase() === name.toLowerCase());
  return match?.value || '';
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

async function getAttachment(token, user, messageId, part) {
  const attachmentId = part.body?.attachmentId;
  let data = part.body?.data || '';
  if (attachmentId) {
    const attachment = await gmailFetch(
      token,
      `/users/${encodeURIComponent(user)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
    );
    data = attachment.data || '';
  }

  const buffer = decodeBase64Url(data);
  const maxBytes = Math.max(Number.parseInt(process.env.MAX_FILE_SIZE_MB || '20', 10), 1) * 1024 * 1024;
  if (buffer.length > maxBytes) {
    console.warn(`[GMAIL INVOICE] Skipping oversized attachment ${part.filename || 'unnamed'} (${buffer.length} bytes)`);
    return null;
  }

  return {
    originalname: part.filename || 'gmail-attachment',
    mimetype: part.mimeType || 'application/octet-stream',
    buffer,
  };
}

async function extractContent(token, user, message) {
  const textParts = [];
  const htmlParts = [];
  const attachments = [];

  async function walk(part) {
    if (!part) return;
    const filename = String(part.filename || '').trim();
    const mimeType = String(part.mimeType || '').toLowerCase();

    if (part.parts) {
      for (const child of part.parts) {
        await walk(child);
      }
    }

    if (filename) {
      const attachment = await getAttachment(token, user, message.id, part);
      if (attachment) attachments.push(attachment);
      return;
    }

    if (!part.body?.data) return;
    const body = decodeBase64Url(part.body.data).toString('utf8');
    if (mimeType === 'text/plain') textParts.push(body);
    if (mimeType === 'text/html') htmlParts.push(body);
  }

  await walk(message.payload);
  return {
    textBody: textParts.join('\n\n').trim(),
    htmlBody: htmlParts.join('\n\n').trim(),
    attachments,
  };
}

async function ensureLabel(token, user, labelName) {
  if (!labelName) return null;
  const labels = await gmailFetch(token, `/users/${encodeURIComponent(user)}/labels`);
  const existing = (labels.labels || []).find(label => label.name === labelName);
  if (existing) return existing.id;

  const created = await gmailFetch(token, `/users/${encodeURIComponent(user)}/labels`, {
    method: 'POST',
    body: JSON.stringify({
      name: labelName,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    }),
  });
  return created.id;
}

async function labelMessage(token, user, messageId, labelId) {
  if (!labelId) return;
  await gmailFetch(token, `/users/${encodeURIComponent(user)}/messages/${encodeURIComponent(messageId)}/modify`, {
    method: 'POST',
    body: JSON.stringify({ addLabelIds: [labelId] }),
  });
}

async function pollGmailInvoices() {
  if (running) return { ok: true, skipped: true };
  running = true;
  try {
    const user = process.env.GMAIL_INVOICE_USER || 'invoices@newurbandev.com';
    const labelName = process.env.GMAIL_INVOICE_IMPORTED_LABEL || DEFAULT_LABEL;
    const query = process.env.GMAIL_INVOICE_QUERY || DEFAULT_QUERY;
    const maxResults = Math.min(Math.max(Number.parseInt(process.env.GMAIL_INVOICE_MAX_RESULTS || '20', 10), 1), 100);
    const key = loadServiceAccountKey();
    const token = await getAccessToken(key, user);
    const labelId = await ensureLabel(token, user, labelName);
    const params = new URLSearchParams({ maxResults: String(maxResults), q: query });
    const list = await gmailFetch(token, `/users/${encodeURIComponent(user)}/messages?${params}`);
    const messages = list.messages || [];
    let imported = 0;
    let duplicates = 0;

    for (const summary of messages) {
      const existing = getDb()
        .prepare("SELECT id FROM invoice_email_intake WHERE provider = 'gmail' AND provider_message_id = ?")
        .get(summary.id);
      if (existing) {
        duplicates += 1;
        await labelMessage(token, user, summary.id, labelId);
        continue;
      }

      const message = await gmailFetch(
        token,
        `/users/${encodeURIComponent(user)}/messages/${encodeURIComponent(summary.id)}?format=full`
      );
      const from = parseAddress(headerValue(message, 'From'));
      const content = await extractContent(token, user, message);
      const result = storeInboundInvoice({
        provider: 'gmail',
        providerMessageId: message.id,
        fromName: from.name,
        fromEmail: from.email,
        toEmail: headerValue(message, 'To'),
        ccEmail: headerValue(message, 'Cc'),
        subject: headerValue(message, 'Subject') || '(no subject)',
        textBody: content.textBody || message.snippet || '',
        htmlBody: content.htmlBody || '',
        receivedAt: new Date(Number.parseInt(message.internalDate || Date.now(), 10)).toISOString(),
        attachments: content.attachments,
      });

      if (result.duplicate) duplicates += 1;
      else imported += 1;
      await labelMessage(token, user, message.id, labelId);
    }

    if (messages.length > 0) {
      console.log(`[GMAIL INVOICE] Processed ${messages.length} message(s): ${imported} imported, ${duplicates} duplicate(s)`);
    }
    return { ok: true, processed: messages.length, imported, duplicates };
  } finally {
    running = false;
  }
}

function startGmailInvoicePoller() {
  if (!enabled()) return;
  const intervalMs = Math.max(Number.parseInt(process.env.GMAIL_INVOICE_POLL_INTERVAL_MS || '300000', 10), 60000);
  const run = () => {
    pollGmailInvoices().catch(err => {
      console.error('[GMAIL INVOICE] Poll failed:', err);
    });
  };

  const startupDelayMs = Math.max(Number.parseInt(process.env.GMAIL_INVOICE_STARTUP_DELAY_MS || '10000', 10), 1000);
  setTimeout(run, startupDelayMs);
  timer = setInterval(run, intervalMs);
  console.log(`[GMAIL INVOICE] Poller enabled for ${process.env.GMAIL_INVOICE_USER || 'invoices@newurbandev.com'}`);
}

function stopGmailInvoicePoller() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { pollGmailInvoices, startGmailInvoicePoller, stopGmailInvoicePoller };
