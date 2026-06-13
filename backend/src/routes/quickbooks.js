const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate, authorize } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { sendApprovedPayNotificationEmail } = require('../utils/email');

const router = express.Router();
const MANAGEMENT_ROLES = ['super_admin', 'operations_manager', 'project_manager', 'admin_assistant'];
const QUICKBOOKS_ADMIN_ROLES = ['super_admin', 'operations_manager'];
const ACCOUNTING_SCOPE = 'com.intuit.quickbooks.accounting';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const MINOR_VERSION = '75';
const AUTO_SYNC_DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_EXCLUDED_BILL_VENDORS = ['great lakes mortgage fund'];
const PAYMENT_APPROVAL_STATUS = 'approved_for_payment';
const PAYMENT_APPROVAL_DEFAULT_STATUS = 'not_approved';
const PAYDAY_ANCHOR_UTC_MS = Date.UTC(2026, 5, 12, 12, 0, 0);
const PAYMENT_QUEUE_NOTIFY_DEFAULT_HOUR_ET = 8;
const PAYMENT_QUEUE_NOTIFY_DEFAULT_POLL_MS = 5 * 60 * 1000;
let autoSyncStarted = false;
let activeSyncPromise = null;
let paymentQueueSchedulerStarted = false;
let paymentQueueSchedulerRunning = false;

function qboEnvironment() {
  return String(process.env.QBO_ENVIRONMENT || process.env.QUICKBOOKS_ENVIRONMENT || 'production').toLowerCase() === 'sandbox'
    ? 'sandbox'
    : 'production';
}

function qboApiBase(environment = qboEnvironment()) {
  return environment === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
}

function appBaseUrl() {
  return String(process.env.APP_URL || 'https://buildtrack.newurbandev.com').replace(/\/$/, '');
}

function redirectUri() {
  return process.env.QBO_REDIRECT_URI || process.env.QUICKBOOKS_REDIRECT_URI || `${appBaseUrl()}/api/quickbooks/oauth/callback`;
}

function qboConfig() {
  const clientId = process.env.QBO_CLIENT_ID || process.env.QUICKBOOKS_CLIENT_ID || '';
  const clientSecret = process.env.QBO_CLIENT_SECRET || process.env.QUICKBOOKS_CLIENT_SECRET || '';
  const appId = process.env.QBO_APP_ID || process.env.QUICKBOOKS_APP_ID || '';
  const webhookVerifierToken = process.env.QBO_WEBHOOK_VERIFIER_TOKEN || process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN || '';
  return {
    appId,
    clientId,
    clientSecret,
    webhookVerifierToken,
    redirectUri: redirectUri(),
    environment: qboEnvironment(),
    scope: ACCOUNTING_SCOPE,
    configured: Boolean(clientId && clientSecret),
    webhookConfigured: Boolean(webhookVerifierToken),
    missing: [
      clientId ? null : 'QBO_CLIENT_ID',
      clientSecret ? null : 'QBO_CLIENT_SECRET',
    ].filter(Boolean),
  };
}

function encryptionKey() {
  const secret = process.env.QBO_TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) throw new Error('QBO_TOKEN_ENCRYPTION_KEY or JWT_SECRET is required to store QuickBooks tokens');
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encryptSecret(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

function decryptSecret(value) {
  if (!value) return '';
  const [version, iv, tag, encrypted] = String(value).split(':');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Invalid encrypted QuickBooks token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function addSeconds(seconds) {
  return new Date(Date.now() + (Number(seconds || 0) * 1000)).toISOString();
}

function normalizeMoney(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function excludedQuickBooksBillVendors() {
  const configured = String(process.env.QBO_EXCLUDED_BILL_VENDOR_NAMES || process.env.QUICKBOOKS_EXCLUDED_BILL_VENDOR_NAMES || '')
    .split(/[,\n|]/)
    .map(value => normalizeMatchText(value))
    .filter(Boolean);
  return Array.from(new Set([...DEFAULT_EXCLUDED_BILL_VENDORS, ...configured]));
}

function isExcludedQuickBooksBill(bill) {
  const vendor = normalizeMatchText(bill?.VendorRef?.name);
  return Boolean(vendor && excludedQuickBooksBillVendors().includes(vendor));
}

function paymentStatusForBill(bill) {
  const total = normalizeMoney(bill.TotalAmt);
  const balance = normalizeMoney(bill.Balance);
  if (balance <= 0) return 'paid';
  if (total > 0 && balance < total) return 'partial';
  return 'unpaid';
}

function metadataTime(entity, key) {
  return entity?.MetaData?.[key] || null;
}

function nextPaymentRunDate(value = new Date()) {
  const reference = value instanceof Date ? value : new Date(value || Date.now());
  const start = Number.isFinite(reference.getTime()) ? reference : new Date();
  const candidate = new Date(start);
  candidate.setUTCHours(12, 0, 0, 0);
  const daysUntilFriday = (5 - candidate.getUTCDay() + 7) % 7;
  candidate.setUTCDate(candidate.getUTCDate() + daysUntilFriday);
  if (candidate.getTime() < start.getTime()) candidate.setUTCDate(candidate.getUTCDate() + 7);
  while (Math.round((candidate.getTime() - PAYDAY_ANCHOR_UTC_MS) / 86400000) % 14 !== 0) {
    candidate.setUTCDate(candidate.getUTCDate() + 7);
  }
  return candidate.toISOString().slice(0, 10);
}

function easternDateParts(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(Number.isFinite(date.getTime()) ? date : new Date());
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    isoDate: `${byType.year}-${byType.month}-${byType.day}`,
    weekday: byType.weekday,
    hour: Number(byType.hour === '24' ? 0 : byType.hour),
  };
}

function getPaymentQueueNotifyHourEt() {
  const requested = Number(process.env.QBO_PAYMENT_QUEUE_NOTIFY_HOUR_ET || process.env.PAYMENT_QUEUE_NOTIFY_HOUR_ET || PAYMENT_QUEUE_NOTIFY_DEFAULT_HOUR_ET);
  if (!Number.isFinite(requested)) return PAYMENT_QUEUE_NOTIFY_DEFAULT_HOUR_ET;
  return Math.max(0, Math.min(23, Math.floor(requested)));
}

function getPaymentQueueNotifyPollMs() {
  const requested = Number(process.env.QBO_PAYMENT_QUEUE_NOTIFY_POLL_MS || process.env.PAYMENT_QUEUE_NOTIFY_POLL_MS || PAYMENT_QUEUE_NOTIFY_DEFAULT_POLL_MS);
  if (!Number.isFinite(requested) || requested <= 0) return PAYMENT_QUEUE_NOTIFY_DEFAULT_POLL_MS;
  return Math.max(60 * 1000, Math.floor(requested));
}

function isBiweeklyPaymentQueueDate(isoDate) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return false;
  const diffDays = Math.round((date.getTime() - PAYDAY_ANCHOR_UTC_MS) / 86400000);
  return diffDays >= 0 && diffDays % 14 === 0;
}

function scheduledPaymentQueueRunDate(value = new Date()) {
  const parts = easternDateParts(value);
  if (parts.weekday !== 'Fri') return null;
  if (parts.hour < getPaymentQueueNotifyHourEt()) return null;
  if (!isBiweeklyPaymentQueueDate(parts.isoDate)) return null;
  return parts.isoDate;
}

function getActiveConnection(db) {
  return db.prepare(`
    SELECT *
    FROM quickbooks_connections
    WHERE id = 'primary' AND is_active = 1
    LIMIT 1
  `).get();
}

function basicAuthHeader(config) {
  return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
}

function timingSafeEqualBase64(left, right) {
  const a = Buffer.from(String(left || ''), 'base64');
  const b = Buffer.from(String(right || ''), 'base64');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function webhookSignatureValid(req) {
  const config = qboConfig();
  if (!config.webhookVerifierToken) {
    const err = new Error('QuickBooks webhook verifier token is not configured.');
    err.statusCode = 503;
    throw err;
  }
  const signature = req.get('intuit-signature') || req.get('x-intuit-signature') || '';
  if (!signature) return false;
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const digest = crypto
    .createHmac('sha256', config.webhookVerifierToken)
    .update(rawBody)
    .digest('base64');
  return timingSafeEqualBase64(signature, digest);
}

async function tokenRequest(params) {
  const config = qboConfig();
  if (!config.configured) {
    const err = new Error(`QuickBooks credentials are not configured: ${config.missing.join(', ')}`);
    err.statusCode = 503;
    throw err;
  }
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: basicAuthHeader(config),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = { raw: text }; }
  if (!response.ok) {
    const err = new Error(payload.error_description || payload.error || `QuickBooks token request failed (${response.status})`);
    err.statusCode = response.status;
    err.details = payload;
    throw err;
  }
  return payload;
}

async function refreshAccessToken(db, connection) {
  const existingExpiry = connection.access_token_expires_at ? new Date(connection.access_token_expires_at).getTime() : 0;
  if (connection.access_token_encrypted && existingExpiry > Date.now() + 60000) {
    return decryptSecret(connection.access_token_encrypted);
  }

  const token = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: decryptSecret(connection.refresh_token_encrypted),
  });
  const nextRefresh = token.refresh_token || decryptSecret(connection.refresh_token_encrypted);
  db.prepare(`
    UPDATE quickbooks_connections
    SET access_token_encrypted = ?,
        refresh_token_encrypted = ?,
        access_token_expires_at = ?,
        scope = COALESCE(?, scope),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    encryptSecret(token.access_token),
    encryptSecret(nextRefresh),
    addSeconds(token.expires_in || 3600),
    token.scope || null,
    connection.id
  );
  return token.access_token;
}

async function qboRequest(db, connection, path) {
  const accessToken = await refreshAccessToken(db, connection);
  const separator = path.includes('?') ? '&' : '?';
  const url = `${qboApiBase(connection.environment)}${path}${separator}minorversion=${MINOR_VERSION}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = { raw: text }; }
  if (!response.ok) {
    const fault = payload?.Fault?.Error?.[0];
    const err = new Error(fault?.Message || fault?.Detail || `QuickBooks API request failed (${response.status})`);
    err.statusCode = response.status;
    err.details = payload;
    throw err;
  }
  return payload;
}

async function qboQuery(db, connection, query) {
  return qboRequest(db, connection, `/v3/company/${encodeURIComponent(connection.realm_id)}/query?query=${encodeURIComponent(query)}`);
}

async function fetchAllQboEntities(db, connection, entityName) {
  const rows = [];
  let start = 1;
  const pageSize = 1000;
  while (start <= 10000) {
    const payload = await qboQuery(db, connection, `SELECT * FROM ${entityName} STARTPOSITION ${start} MAXRESULTS ${pageSize}`);
    const page = payload?.QueryResponse?.[entityName] || [];
    rows.push(...page);
    if (page.length < pageSize) break;
    start += page.length;
  }
  return rows;
}

async function fetchCompanyName(db, connection) {
  try {
    const payload = await qboRequest(db, connection, `/v3/company/${encodeURIComponent(connection.realm_id)}/companyinfo/${encodeURIComponent(connection.realm_id)}`);
    return payload?.CompanyInfo?.CompanyName || payload?.CompanyInfo?.LegalName || null;
  } catch (err) {
    return null;
  }
}

function normalizeDoc(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeMatchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function projectAddressKey(value) {
  const normalized = normalizeMatchText(value);
  const match = normalized.match(/^(\d+)\s+([a-z0-9]+)/);
  return match ? `${match[1]} ${match[2]}` : normalized;
}

function addClassRef(refs, ref) {
  const value = String(ref?.value || '').trim();
  const name = String(ref?.name || '').trim();
  if (!value && !name) return;
  refs.push({ value: value || null, name: name || null });
}

function billClassRefs(bill) {
  const refs = [];
  addClassRef(refs, bill?.ClassRef);
  for (const line of bill?.Line || []) {
    addClassRef(refs, line?.ClassRef);
    addClassRef(refs, line?.AccountBasedExpenseLineDetail?.ClassRef);
    addClassRef(refs, line?.ItemBasedExpenseLineDetail?.ClassRef);
  }
  const unique = new Map();
  refs.forEach(ref => {
    const key = `${ref.value || ''}|${normalizeMatchText(ref.name)}`;
    if (!unique.has(key)) unique.set(key, ref);
  });
  return Array.from(unique.values());
}

function primaryBillClassRef(bill) {
  const refs = billClassRefs(bill);
  if (!refs.length) return null;
  const ids = Array.from(new Set(refs.map(ref => ref.value).filter(Boolean)));
  if (ids.length === 1) return refs.find(ref => ref.value === ids[0]) || null;
  if (ids.length > 1) return null;
  const names = Array.from(new Set(refs.map(ref => normalizeMatchText(ref.name)).filter(Boolean)));
  return names.length === 1 ? refs[0] : null;
}

function lineExpenseDetail(line) {
  return line?.AccountBasedExpenseLineDetail || line?.ItemBasedExpenseLineDetail || {};
}

function billLineClassRef(line) {
  const detail = lineExpenseDetail(line);
  return line?.ClassRef || detail?.ClassRef || null;
}

function billLineCategoryRef(line) {
  const detail = lineExpenseDetail(line);
  return detail?.AccountRef || detail?.ItemRef || null;
}

function billLineCustomerRef(line) {
  const detail = lineExpenseDetail(line);
  return detail?.CustomerRef || null;
}

function stableBillLineId(bill, line, index) {
  const billId = String(bill?.Id || '').trim();
  const lineId = String(line?.Id || line?.LineNum || index + 1).trim();
  return {
    id: `${billId}:${lineId || index + 1}`,
    qboLineId: lineId || String(index + 1),
  };
}

function findProjectForBillLine(db, bill, line, invoice = null) {
  const classRef = billLineClassRef(line);
  const lineScopedBill = { ...bill, Line: [line] };
  const project = findProjectForBill(db, lineScopedBill, invoice, classRef);
  return { project, classRef };
}

function billMatchText(bill, classRef) {
  return normalizeMatchText([
    classRef?.name,
    bill?.PrivateNote,
    bill?.DocNumber,
    bill?.VendorRef?.name,
    ...(bill?.Line || []).map(line => line?.Description),
  ].filter(Boolean).join(' '));
}

function rankedProjectMatches(projects, classRef, bill) {
  const className = normalizeMatchText(classRef?.name);
  const searchText = billMatchText(bill, classRef);
  const scored = [];
  for (const project of projects) {
    const jobName = normalizeMatchText(project.job_name);
    const address = normalizeMatchText(project.address);
    const addressKey = projectAddressKey(project.address);
    const jobKey = projectAddressKey(project.job_name);
    let score = 0;

    if (className) {
      if (className === jobName || className === addressKey || className === jobKey) score = Math.max(score, 100);
      if (address && address.includes(className) && /\d/.test(className)) score = Math.max(score, 90);
      if (jobName && jobName.includes(className) && /\d/.test(className)) score = Math.max(score, 90);
    }
    if (searchText) {
      if (addressKey && searchText.includes(addressKey)) score = Math.max(score, 82);
      if (jobKey && searchText.includes(jobKey)) score = Math.max(score, 82);
      if (jobName && jobName.length >= 6 && searchText.includes(jobName)) score = Math.max(score, 74);
    }

    if (score > 0) scored.push({ project, score });
  }

  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].score === scored[1].score) return null;
  return scored[0].project;
}

function findProjectForBill(db, bill, invoice = null, classRef = null) {
  if (invoice?.project_id) {
    return db.prepare('SELECT * FROM projects WHERE id = ? LIMIT 1').get(invoice.project_id) || null;
  }

  if (classRef?.value) {
    const byClassId = db.prepare('SELECT * FROM projects WHERE quickbooks_class_id = ? LIMIT 2').all(classRef.value);
    if (byClassId.length === 1) return byClassId[0];
  }

  const projects = db.prepare(`
    SELECT id, address, job_name, quickbooks_class_id, quickbooks_class_name
    FROM projects
  `).all();

  if (classRef?.name) {
    const className = normalizeMatchText(classRef.name);
    const bySavedClassName = projects.filter(project => normalizeMatchText(project.quickbooks_class_name) === className);
    if (bySavedClassName.length === 1) return bySavedClassName[0];
  }

  return rankedProjectMatches(projects, classRef, bill);
}

function rememberProjectClass(db, project, classRef) {
  if (!project?.id || !classRef || (!classRef.value && !classRef.name)) return;
  const current = db.prepare('SELECT quickbooks_class_id, quickbooks_class_name FROM projects WHERE id = ? LIMIT 1').get(project.id);
  if (!current) return;
  const currentId = String(current.quickbooks_class_id || '').trim();
  const currentName = String(current.quickbooks_class_name || '').trim();
  if (currentId && classRef.value && currentId !== classRef.value) return;
  db.prepare(`
    UPDATE projects
    SET quickbooks_class_id = COALESCE(NULLIF(quickbooks_class_id, ''), ?),
        quickbooks_class_name = CASE
          WHEN quickbooks_class_name IS NULL OR quickbooks_class_name = '' OR quickbooks_class_id = ? THEN COALESCE(?, quickbooks_class_name)
          ELSE quickbooks_class_name
        END
    WHERE id = ?
  `).run(classRef.value || null, classRef.value || null, classRef.name || currentName || null, project.id);
}

function findInvoiceForBill(db, bill) {
  const qboId = String(bill.Id || '').trim();
  if (!qboId) return null;
  const existing = db.prepare('SELECT * FROM invoices WHERE quickbooks_bill_id = ? LIMIT 1').get(qboId);
  if (existing) return existing;

  const doc = normalizeDoc(bill.DocNumber);
  const total = normalizeMoney(bill.TotalAmt);
  const vendor = normalizeDoc(bill.VendorRef?.name);
  if (!doc && (total <= 0 || !vendor)) return null;

  const candidates = db.prepare(`
    SELECT *
    FROM invoices
    WHERE (? != '' AND (
        lower(COALESCE(external_invoice_number, '')) = ?
        OR lower(COALESCE(invoice_number, '')) = ?
        OR lower(COALESCE(quickbooks_doc_number, '')) = ?
      ))
      OR (? > 0 AND ? != '' AND ABS(COALESCE(total, 0) - ?) < 0.01 AND lower(COALESCE(vendor_name, '')) = ?)
    ORDER BY
      CASE
        WHEN ? != '' AND lower(COALESCE(external_invoice_number, '')) = ? THEN 0
        WHEN ? != '' AND lower(COALESCE(invoice_number, '')) = ? THEN 1
        WHEN ? > 0 AND ABS(COALESCE(total, 0) - ?) < 0.01 AND ? != '' AND lower(COALESCE(vendor_name, '')) = ? THEN 2
        ELSE 4
      END,
      datetime(COALESCE(updated_at, created_at)) DESC
    LIMIT 5
  `).all(
    doc, doc, doc, doc,
    total, vendor, total, vendor,
    doc, doc,
    doc, doc,
    total, total, vendor, vendor
  );

  if (!candidates.length) return null;
  const exactDoc = candidates.find(row => (
    normalizeDoc(row.external_invoice_number) === doc
    || normalizeDoc(row.invoice_number) === doc
    || normalizeDoc(row.quickbooks_doc_number) === doc
  ));
  if (exactDoc) return exactDoc;
  return candidates.length === 1 ? candidates[0] : null;
}

function billLinkedTxnJson(bill) {
  const linked = [];
  for (const line of bill.Line || []) {
    for (const txn of line.LinkedTxn || []) {
      linked.push(txn);
    }
  }
  return JSON.stringify(linked);
}

function linkedBillIdsFromPayment(payment) {
  const ids = new Set();
  for (const line of payment.Line || []) {
    for (const txn of line.LinkedTxn || []) {
      if (String(txn.TxnType || '').toLowerCase() === 'bill' && txn.TxnId) ids.add(String(txn.TxnId));
    }
  }
  return Array.from(ids);
}

function upsertBillsAndPayments(db, connection, bills, payments) {
  const excludedVendors = excludedQuickBooksBillVendors();
  const excludedVendorPlaceholders = excludedVendors.map(() => '?').join(', ');
  const deleteExcludedBills = excludedVendors.length
    ? db.prepare(`DELETE FROM quickbooks_bills WHERE lower(trim(COALESCE(vendor_name, ''))) IN (${excludedVendorPlaceholders})`)
    : null;
  const upsertBill = db.prepare(`
    INSERT INTO quickbooks_bills (
      qbo_id, realm_id, environment, sync_token, doc_number, vendor_id, vendor_name,
      txn_date, due_date, total_amt, balance, payment_status, private_note,
      qbo_class_id, qbo_class_name, matched_invoice_id, project_id, line_json, linked_txn_json, raw_json,
      qbo_created_at, qbo_updated_at, last_seen_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(qbo_id) DO UPDATE SET
      sync_token = excluded.sync_token,
      doc_number = excluded.doc_number,
      vendor_id = excluded.vendor_id,
      vendor_name = excluded.vendor_name,
      txn_date = excluded.txn_date,
      due_date = excluded.due_date,
      total_amt = excluded.total_amt,
      balance = excluded.balance,
      payment_status = excluded.payment_status,
      private_note = excluded.private_note,
      qbo_class_id = excluded.qbo_class_id,
      qbo_class_name = excluded.qbo_class_name,
      matched_invoice_id = excluded.matched_invoice_id,
      project_id = COALESCE(excluded.project_id, quickbooks_bills.project_id),
      line_json = excluded.line_json,
      linked_txn_json = excluded.linked_txn_json,
      raw_json = excluded.raw_json,
      qbo_created_at = excluded.qbo_created_at,
      qbo_updated_at = excluded.qbo_updated_at,
      last_seen_at = datetime('now'),
      updated_at = datetime('now')
  `);
  const upsertPayment = db.prepare(`
    INSERT INTO quickbooks_bill_payments (
      qbo_id, realm_id, environment, sync_token, vendor_id, vendor_name, txn_date,
      total_amt, linked_bill_ids_json, raw_json, qbo_created_at, qbo_updated_at,
      last_seen_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(qbo_id) DO UPDATE SET
      sync_token = excluded.sync_token,
      vendor_id = excluded.vendor_id,
      vendor_name = excluded.vendor_name,
      txn_date = excluded.txn_date,
      total_amt = excluded.total_amt,
      linked_bill_ids_json = excluded.linked_bill_ids_json,
      raw_json = excluded.raw_json,
      qbo_created_at = excluded.qbo_created_at,
      qbo_updated_at = excluded.qbo_updated_at,
      last_seen_at = datetime('now'),
      updated_at = datetime('now')
  `);
  const deleteBillLines = db.prepare('DELETE FROM quickbooks_bill_lines WHERE qbo_bill_id = ?');
  const insertBillLine = db.prepare(`
    INSERT INTO quickbooks_bill_lines (
      id, qbo_bill_id, realm_id, environment, qbo_line_id, line_num, description, amount,
      detail_type, category_id, category_name, class_id, class_name, customer_id, customer_name,
      project_id, raw_json, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const getExistingBillApproval = db.prepare(`
    SELECT payment_approval_status
    FROM quickbooks_bills
    WHERE qbo_id = ?
    LIMIT 1
  `);
  const updateInvoice = db.prepare(`
    UPDATE invoices
    SET quickbooks_status = 'synced',
        quickbooks_bill_id = ?,
        quickbooks_error = NULL,
        quickbooks_synced_at = datetime('now'),
        quickbooks_balance = ?,
        quickbooks_payment_status = ?,
        quickbooks_vendor_id = ?,
        quickbooks_vendor_name = ?,
        quickbooks_doc_number = ?,
        quickbooks_txn_date = ?,
        quickbooks_due_date = ?,
        quickbooks_last_seen_at = datetime('now'),
        external_invoice_number = COALESCE(NULLIF(external_invoice_number, ''), ?),
        vendor_name = COALESCE(NULLIF(vendor_name, ''), ?),
        status = CASE
          WHEN ? = 'paid' AND ? = '${PAYMENT_APPROVAL_STATUS}' THEN 'paid'
          WHEN status = 'paid' AND ? != 'paid' THEN 'approved'
          ELSE status
        END,
        updated_at = datetime('now')
    WHERE id = ?
  `);

  let matched = 0;
  let ignored = 0;
  let markedPaidFromQueue = 0;
  const write = db.transaction(() => {
    if (deleteExcludedBills) deleteExcludedBills.run(...excludedVendors);

    for (const payment of payments) {
      upsertPayment.run(
        String(payment.Id),
        connection.realm_id,
        connection.environment,
        payment.SyncToken || null,
        payment.VendorRef?.value || null,
        payment.VendorRef?.name || null,
        payment.TxnDate || null,
        normalizeMoney(payment.TotalAmt),
        JSON.stringify(linkedBillIdsFromPayment(payment)),
        JSON.stringify(payment),
        metadataTime(payment, 'CreateTime'),
        metadataTime(payment, 'LastUpdatedTime')
      );
    }

    for (const bill of bills) {
      if (isExcludedQuickBooksBill(bill)) {
        ignored += 1;
        continue;
      }
      const paymentStatus = paymentStatusForBill(bill);
      const invoice = findInvoiceForBill(db, bill);
      const existingBillApproval = getExistingBillApproval.get(String(bill.Id));
      const paymentApprovalStatusAtSync = existingBillApproval?.payment_approval_status || PAYMENT_APPROVAL_DEFAULT_STATUS;
      const classRef = primaryBillClassRef(bill);
      const project = findProjectForBill(db, bill, invoice, classRef);
      if (project && classRef) rememberProjectClass(db, project, classRef);
      if (invoice) matched += 1;
      if (invoice && paymentStatus === 'paid' && paymentApprovalStatusAtSync === PAYMENT_APPROVAL_STATUS && invoice.status !== 'paid') {
        markedPaidFromQueue += 1;
      }
      upsertBill.run(
        String(bill.Id),
        connection.realm_id,
        connection.environment,
        bill.SyncToken || null,
        bill.DocNumber || null,
        bill.VendorRef?.value || null,
        bill.VendorRef?.name || null,
        bill.TxnDate || null,
        bill.DueDate || null,
        normalizeMoney(bill.TotalAmt),
        normalizeMoney(bill.Balance),
        paymentStatus,
        bill.PrivateNote || null,
        classRef?.value || null,
        classRef?.name || null,
        invoice?.id || null,
        project?.id || invoice?.project_id || null,
        JSON.stringify(bill.Line || []),
        billLinkedTxnJson(bill),
        JSON.stringify(bill),
        metadataTime(bill, 'CreateTime'),
        metadataTime(bill, 'LastUpdatedTime')
      );
      if (invoice) {
        updateInvoice.run(
          String(bill.Id),
          normalizeMoney(bill.Balance),
          paymentStatus,
          bill.VendorRef?.value || null,
          bill.VendorRef?.name || null,
          bill.DocNumber || null,
          bill.TxnDate || null,
          bill.DueDate || null,
          bill.DocNumber || null,
          bill.VendorRef?.name || null,
          paymentStatus,
          paymentApprovalStatusAtSync,
          paymentStatus,
          invoice.id
        );
      }

      deleteBillLines.run(String(bill.Id));
      (bill.Line || []).forEach((line, index) => {
        const { id, qboLineId } = stableBillLineId(bill, line, index);
        const lineNum = Number(line?.LineNum || index + 1);
        const categoryRef = billLineCategoryRef(line);
        const customerRef = billLineCustomerRef(line);
        const { project: lineProject, classRef: lineClassRef } = findProjectForBillLine(db, bill, line, invoice);
        if (lineProject && lineClassRef) rememberProjectClass(db, lineProject, lineClassRef);
        insertBillLine.run(
          id,
          String(bill.Id),
          connection.realm_id,
          connection.environment,
          qboLineId,
          Number.isFinite(lineNum) ? lineNum : index + 1,
          line?.Description || null,
          normalizeMoney(line?.Amount),
          line?.DetailType || null,
          categoryRef?.value || null,
          categoryRef?.name || null,
          lineClassRef?.value || null,
          lineClassRef?.name || null,
          customerRef?.value || null,
          customerRef?.name || null,
          lineProject?.id || invoice?.project_id || null,
          JSON.stringify(line || {})
        );
      });
    }
  });

  write();
  return { matched, ignored, markedPaidFromQueue };
}

function splitLinesFullyMatchedSql(billAlias = 'qb') {
  return `
    EXISTS (
      SELECT 1
      FROM quickbooks_bill_lines qbl_match
      WHERE qbl_match.qbo_bill_id = ${billAlias}.qbo_id
      GROUP BY qbl_match.qbo_bill_id
      HAVING COUNT(*) > 0
        AND SUM(CASE WHEN qbl_match.project_id IS NULL THEN 1 ELSE 0 END) = 0
    )
  `;
}

function statusSummary(db) {
  const excludedVendors = excludedQuickBooksBillVendors();
  const excludedVendorPlaceholders = excludedVendors.map(() => '?').join(', ');
  const excludedVendorWhere = excludedVendors.length
    ? `WHERE lower(trim(COALESCE(qb.vendor_name, ''))) NOT IN (${excludedVendorPlaceholders})`
    : '';
  const billStats = db.prepare(`
    SELECT
      COUNT(*) as bill_count,
      SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) as paid_count,
      SUM(CASE
        WHEN payment_status != 'paid'
          AND COALESCE(payment_approval_status, '${PAYMENT_APPROVAL_DEFAULT_STATUS}') != '${PAYMENT_APPROVAL_STATUS}'
        THEN 1 ELSE 0 END) as open_count,
      ROUND(COALESCE(SUM(CASE
        WHEN payment_status != 'paid'
          AND COALESCE(payment_approval_status, '${PAYMENT_APPROVAL_DEFAULT_STATUS}') != '${PAYMENT_APPROVAL_STATUS}'
        THEN balance ELSE 0 END), 0), 2) as open_balance,
      SUM(CASE
        WHEN project_id IS NULL
          AND NOT ${splitLinesFullyMatchedSql('qb')}
          AND payment_status != 'paid'
          AND COALESCE(payment_approval_status, '${PAYMENT_APPROVAL_DEFAULT_STATUS}') != '${PAYMENT_APPROVAL_STATUS}'
        THEN 1 ELSE 0 END) as unmatched_count,
      SUM(CASE
        WHEN payment_status != 'paid'
          AND COALESCE(payment_approval_status, '${PAYMENT_APPROVAL_DEFAULT_STATUS}') = '${PAYMENT_APPROVAL_STATUS}'
        THEN 1 ELSE 0 END) as approved_payment_count,
      ROUND(COALESCE(SUM(CASE
        WHEN payment_status != 'paid'
          AND COALESCE(payment_approval_status, '${PAYMENT_APPROVAL_DEFAULT_STATUS}') = '${PAYMENT_APPROVAL_STATUS}'
        THEN balance ELSE 0 END), 0), 2) as approved_payment_balance
    FROM quickbooks_bills qb
    ${excludedVendorWhere}
  `).get(...excludedVendors);
  return {
    bill_count: Number(billStats?.bill_count || 0),
    paid_count: Number(billStats?.paid_count || 0),
    open_count: Number(billStats?.open_count || 0),
    open_balance: Number(billStats?.open_balance || 0),
    unmatched_count: Number(billStats?.unmatched_count || 0),
    approved_payment_count: Number(billStats?.approved_payment_count || 0),
    approved_payment_balance: Number(billStats?.approved_payment_balance || 0),
  };
}

function quickBooksBillSelectSql() {
  return `
      qb.qbo_id,
      qb.doc_number,
      qb.vendor_id,
      qb.vendor_name,
      qb.qbo_class_id,
      qb.qbo_class_name,
      qb.txn_date,
      qb.due_date,
      qb.total_amt,
      qb.balance,
      qb.payment_status,
      qb.payment_approval_status,
      qb.payment_approved_at,
      qb.payment_approved_by,
      qb.payment_run_date,
      qb.payment_approval_notified_at,
      qb.payment_approval_notified_by,
      approved_user.name as payment_approved_by_name,
      notified_user.name as payment_approval_notified_by_name,
      qb.private_note,
      qb.matched_invoice_id,
      qb.project_id,
      qb.qbo_updated_at,
      qb.last_seen_at,
      i.invoice_number,
      i.external_invoice_number,
      i.status as buildtrack_status,
      p.address as project_address,
      p.job_name as project_job_name
  `;
}

function quickBooksBillJoinsSql() {
  return `
    FROM quickbooks_bills qb
    LEFT JOIN invoices i ON i.id = qb.matched_invoice_id
    LEFT JOIN projects p ON p.id = COALESCE(qb.project_id, i.project_id)
    LEFT JOIN users approved_user ON approved_user.id = qb.payment_approved_by
    LEFT JOIN users notified_user ON notified_user.id = qb.payment_approval_notified_by
  `;
}

function getQuickBooksBillLines(db, qboIds) {
  const ids = [...new Set((Array.isArray(qboIds) ? qboIds : [qboIds]).map(id => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT
      qbl.*,
      p.address as project_address,
      p.job_name as project_job_name
    FROM quickbooks_bill_lines qbl
    LEFT JOIN projects p ON p.id = qbl.project_id
    WHERE qbl.qbo_bill_id IN (${placeholders})
    ORDER BY qbl.qbo_bill_id ASC, CAST(COALESCE(qbl.line_num, 999999) AS INTEGER) ASC, qbl.id ASC
  `).all(...ids);
}

function attachQuickBooksBillLines(db, rows) {
  const list = Array.isArray(rows) ? rows : [rows].filter(Boolean);
  if (!list.length) return rows;
  const lines = getQuickBooksBillLines(db, list.map(row => row.qbo_id));
  const byBill = new Map();
  for (const line of lines) {
    if (!byBill.has(line.qbo_bill_id)) byBill.set(line.qbo_bill_id, []);
    byBill.get(line.qbo_bill_id).push(line);
  }
  const withLines = list.map(row => {
    const splitLines = byBill.get(row.qbo_id) || [];
    const matched = splitLines.filter(line => line.project_id).length;
    return {
      ...row,
      split_lines: splitLines,
      split_line_count: splitLines.length,
      matched_split_line_count: matched,
      unmatched_split_line_count: splitLines.length - matched,
    };
  });
  return Array.isArray(rows) ? withLines : withLines[0];
}

function parseQuickBooksPaymentBillIds(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(id => String(id || '').trim()).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function paymentDateRank(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function attachQuickBooksBillPaymentDates(db, rows) {
  const list = Array.isArray(rows) ? rows : [rows].filter(Boolean);
  if (!list.length) return rows;
  const wantedIds = new Set(list.map(row => String(row.qbo_id || '').trim()).filter(Boolean));
  const latestByBillId = new Map();
  const payments = db.prepare(`
    SELECT qbo_id, txn_date, qbo_updated_at, last_seen_at, linked_bill_ids_json
    FROM quickbooks_bill_payments
  `).all();

  for (const payment of payments) {
    const linkedBillIds = parseQuickBooksPaymentBillIds(payment.linked_bill_ids_json);
    if (!linkedBillIds.length) continue;
    const paidAt = payment.txn_date || payment.qbo_updated_at || payment.last_seen_at || '';
    const observedAt = payment.qbo_updated_at || payment.last_seen_at || payment.txn_date || '';
    const paidRank = paymentDateRank(paidAt);
    const observedRank = paymentDateRank(observedAt);

    for (const billId of linkedBillIds) {
      if (!wantedIds.has(billId)) continue;
      const current = latestByBillId.get(billId);
      if (
        !current
        || paidRank > current.paidRank
        || (paidRank === current.paidRank && observedRank > current.observedRank)
      ) {
        latestByBillId.set(billId, {
          last_paid_at: paidAt || null,
          last_paid_seen_at: observedAt || null,
          last_paid_payment_id: payment.qbo_id || null,
          paidRank,
          observedRank,
        });
      }
    }
  }

  const withPaymentDates = list.map(row => {
    const payment = latestByBillId.get(String(row.qbo_id || '').trim());
    return payment ? {
      ...row,
      last_paid_at: payment.last_paid_at,
      last_paid_seen_at: payment.last_paid_seen_at,
      last_paid_payment_id: payment.last_paid_payment_id,
    } : row;
  });
  return Array.isArray(rows) ? withPaymentDates : withPaymentDates[0];
}

function quickBooksBillLineSummary(db, qboId) {
  return db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN project_id IS NOT NULL THEN 1 ELSE 0 END) as matched,
      SUM(CASE WHEN project_id IS NULL THEN 1 ELSE 0 END) as unmatched
    FROM quickbooks_bill_lines
    WHERE qbo_bill_id = ?
  `).get(String(qboId || '')) || { total: 0, matched: 0, unmatched: 0 };
}

function quickBooksBillHasApprovalMatch(db, bill) {
  if (bill?.project_id) return true;
  const summary = quickBooksBillLineSummary(db, bill?.qbo_id);
  return Number(summary.total || 0) > 0 && Number(summary.unmatched || 0) === 0;
}

function getQuickBooksBillRow(db, qboId) {
  const row = db.prepare(`
    SELECT
      ${quickBooksBillSelectSql()}
    ${quickBooksBillJoinsSql()}
    WHERE qb.qbo_id = ?
    LIMIT 1
  `).get(String(qboId || ''));
  return attachQuickBooksBillLines(db, attachQuickBooksBillPaymentDates(db, row));
}

function approvedPaymentQueueRows(db, paymentRunDate = null) {
  const params = [];
  const where = [
    "qb.payment_status != 'paid'",
    `COALESCE(qb.payment_approval_status, '${PAYMENT_APPROVAL_DEFAULT_STATUS}') = '${PAYMENT_APPROVAL_STATUS}'`,
  ];
  if (paymentRunDate) {
    where.push('qb.payment_run_date = ?');
    params.push(paymentRunDate);
  }
  const rows = db.prepare(`
    SELECT
      ${quickBooksBillSelectSql()}
    ${quickBooksBillJoinsSql()}
    WHERE ${where.join(' AND ')}
    ORDER BY date(COALESCE(qb.payment_run_date, qb.due_date, qb.txn_date)) ASC,
      lower(COALESCE(qb.vendor_name, '')) ASC,
      CAST(qb.balance AS REAL) DESC
  `).all(...params);
  return attachQuickBooksBillLines(db, rows);
}

function paymentQueueEmailRows(rows) {
  return rows.map(row => ({
    id: row.qbo_id,
    invoice_number: row.doc_number ? `QBO #${row.doc_number}` : `QBO #${row.qbo_id}`,
    external_invoice_number: row.doc_number ? `QBO #${row.doc_number}` : `QBO #${row.qbo_id}`,
    vendor_name: row.vendor_name || 'Vendor missing',
    contractor_name: row.vendor_name || 'Vendor missing',
    address: row.project_address || row.project_job_name || (
      row.split_line_count > 0 && row.unmatched_split_line_count === 0 ? 'Split by QuickBooks class' : 'Project not listed'
    ),
    job_name: row.project_job_name || row.project_address || '',
    total: normalizeMoney(row.total_amt),
    quickbooks_balance: normalizeMoney(row.balance),
  }));
}

function paymentQueueTotal(rows) {
  return rows.reduce((sum, row) => sum + normalizeMoney(row.balance), 0);
}

function paymentQueueAutomationUserId(db) {
  const row = db.prepare(`
    SELECT id
    FROM users
    WHERE role IN ('super_admin', 'operations_manager')
    ORDER BY CASE role WHEN 'super_admin' THEN 0 WHEN 'operations_manager' THEN 1 ELSE 2 END,
      datetime(created_at) ASC
    LIMIT 1
  `).get();
  return row?.id || null;
}

function paymentQueueAutoEmailAlreadySent(db, paymentRunDate) {
  const row = db.prepare(`
    SELECT id
    FROM activity_log
    WHERE action = 'quickbooks_payment_queue_auto_notified'
      AND entity_type = 'quickbooks_payment_queue'
      AND entity_id = ?
    LIMIT 1
  `).get(paymentRunDate);
  return Boolean(row);
}

function recordPaymentQueueAutoEmail(db, { paymentRunDate, rows, total, userId }) {
  if (!userId) return;
  db.prepare(`
    INSERT INTO activity_log (id, project_id, user_id, action, entity_type, entity_id, details)
    VALUES (?, NULL, ?, 'quickbooks_payment_queue_auto_notified', 'quickbooks_payment_queue', ?, ?)
  `).run(
    uuidv4(),
    userId,
    paymentRunDate,
    JSON.stringify({
      bill_count: rows.length,
      total_balance: normalizeMoney(total),
      payment_run_date: paymentRunDate,
      recipient: process.env.APPROVED_INVOICE_NOTIFY_EMAIL || 'info@newurbandev.com',
      schedule: 'biweekly_friday_morning',
      anchor_date: '2026-06-12',
    })
  );
}

function markPaymentQueueRowsNotified(db, rows, userId) {
  if (!rows.length) return;
  const updateNotified = db.prepare(`
    UPDATE quickbooks_bills
    SET payment_approval_notified_at = datetime('now'),
        payment_approval_notified_by = ?,
        updated_at = datetime('now')
    WHERE qbo_id = ?
  `);
  const write = db.transaction(() => {
    for (const row of rows) updateNotified.run(userId || null, row.qbo_id);
  });
  write();
}

async function sendScheduledPaymentQueueEmail(now = new Date()) {
  if (paymentQueueSchedulerRunning) return { skipped: true, reason: 'already_running' };
  const paymentRunDate = scheduledPaymentQueueRunDate(now);
  if (!paymentRunDate) return { skipped: true, reason: 'not_payday_window' };

  paymentQueueSchedulerRunning = true;
  try {
    const db = getDb();
    if (paymentQueueAutoEmailAlreadySent(db, paymentRunDate)) {
      return { skipped: true, reason: 'already_sent', payment_run_date: paymentRunDate };
    }

    const rows = approvedPaymentQueueRows(db, paymentRunDate);
    const total = paymentQueueTotal(rows);
    const automationUserId = paymentQueueAutomationUserId(db);
    await sendApprovedPayNotificationEmail({
      approvedInvoices: paymentQueueEmailRows(rows),
      approvedBy: 'BuildTrack automatic Friday payment queue',
    });

    markPaymentQueueRowsNotified(db, rows, automationUserId);
    recordPaymentQueueAutoEmail(db, {
      paymentRunDate,
      rows,
      total,
      userId: automationUserId,
    });
    console.log(`[QBO] Scheduled Friday payment queue email sent for ${paymentRunDate}: ${rows.length} bills, $${normalizeMoney(total).toFixed(2)}.`);
    return {
      ok: true,
      payment_run_date: paymentRunDate,
      bill_count: rows.length,
      total_balance: normalizeMoney(total),
    };
  } finally {
    paymentQueueSchedulerRunning = false;
  }
}

function getAutoSyncIntervalMs() {
  const requested = Number(process.env.QBO_AUTO_SYNC_INTERVAL_MS || process.env.QUICKBOOKS_AUTO_SYNC_INTERVAL_MS || AUTO_SYNC_DEFAULT_INTERVAL_MS);
  if (!Number.isFinite(requested) || requested <= 0) return AUTO_SYNC_DEFAULT_INTERVAL_MS;
  return Math.max(60 * 1000, requested);
}

async function syncQuickBooksBills({ source = 'manual', userId = null } = {}) {
  if (activeSyncPromise) return activeSyncPromise;

  activeSyncPromise = (async () => {
    const db = getDb();
    const config = qboConfig();
    if (!config.configured) {
      return { skipped: true, reason: `missing_credentials:${config.missing.join(',')}` };
    }
    const connection = getActiveConnection(db);
    if (!connection) return { skipped: true, reason: 'not_connected' };

    try {
      const [bills, payments] = await Promise.all([
        fetchAllQboEntities(db, connection, 'Bill'),
        fetchAllQboEntities(db, connection, 'BillPayment').catch(err => {
          console.warn('[QBO] BillPayment sync skipped:', err.message);
          return [];
        }),
      ]);
      const companyName = connection.company_name || await fetchCompanyName(db, connection);
      const result = upsertBillsAndPayments(db, connection, bills, payments);
      db.prepare(`
        UPDATE quickbooks_connections
        SET company_name = COALESCE(?, company_name),
            last_sync_at = datetime('now'),
            last_sync_status = ?,
            last_sync_error = NULL,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(companyName || null, source === 'webhook' ? 'webhook_success' : 'success', connection.id);
      if (userId || connection.connected_by) {
        logActivity({
          userId: userId || connection.connected_by,
          action: source === 'webhook' ? 'quickbooks_webhook_sync_completed' : 'quickbooks_sync_completed',
          entityType: 'quickbooks_connection',
          entityId: connection.realm_id,
          details: {
            source,
            bills: bills.length,
            bill_payments: payments.length,
            matched: result.matched,
            ignored_bills: result.ignored,
            marked_paid_from_friday_queue: result.markedPaidFromQueue,
          },
        });
      }
      return {
        message: 'QuickBooks Bills synced',
        source,
        bills: bills.length,
        bill_payments: payments.length,
        matched_invoices: result.matched,
        marked_paid_from_friday_queue: result.markedPaidFromQueue,
        ignored_bills: result.ignored,
        stats: statusSummary(db),
      };
    } catch (err) {
      console.error('[QBO] Sync failed:', err);
      db.prepare(`
        UPDATE quickbooks_connections
        SET last_sync_at = datetime('now'),
            last_sync_status = 'failed',
            last_sync_error = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(err.message || 'QuickBooks sync failed', connection.id);
      throw err;
    }
  })();

  try {
    return await activeSyncPromise;
  } finally {
    activeSyncPromise = null;
  }
}

function markWebhookEvents(db, eventIds, status, error = null) {
  if (!eventIds.length) return;
  const update = db.prepare(`
    UPDATE quickbooks_webhook_events
    SET process_status = ?,
        processed_at = datetime('now'),
        error = ?
    WHERE id = ?
  `);
  const write = db.transaction(() => {
    eventIds.forEach(id => update.run(status, error, id));
  });
  write();
}

function recordWebhookEvents(db, payload) {
  const eventIds = [];
  const entityNames = new Set();
  const notifications = Array.isArray(payload)
    ? payload.map(event => {
      const typeParts = String(event.type || '').split('.');
      const entityName = typeParts.length >= 3 ? typeParts[1] : '';
      return {
        realmId: event.intuitaccountid || event.realmId || '',
        entities: entityName ? [{ name: entityName, id: event.intuitentityid || event.id || null }] : [],
        raw: event,
      };
    })
    : (Array.isArray(payload?.eventNotifications)
      ? payload.eventNotifications.map(notification => ({
        realmId: notification.realmId || '',
        entities: notification?.dataChangeEvent?.entities || [],
        raw: notification,
      }))
      : []);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO quickbooks_webhook_events (
      id, realm_id, event_hash, entity_names, payload_json
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const write = db.transaction(() => {
    for (const notification of notifications) {
      const realmId = String(notification.realmId || '');
      const entities = notification.entities || [];
      entities.forEach(entity => entity?.name && entityNames.add(String(entity.name)));
      const eventPayload = JSON.stringify(notification.raw || notification);
      const hash = crypto.createHash('sha256').update(eventPayload).digest('hex');
      const id = uuidv4();
      const result = insert.run(id, realmId || null, hash, entities.map(entity => entity.name).filter(Boolean).join(','), eventPayload);
      if (result.changes > 0) eventIds.push(id);
    }
  });
  write();
  return { eventIds, entityNames: Array.from(entityNames) };
}

router.post('/webhook', async (req, res) => {
  let eventIds = [];
  try {
    if (!webhookSignatureValid(req)) {
      return res.status(401).json({ error: 'Invalid QuickBooks webhook signature' });
    }

    const db = getDb();
    const recorded = recordWebhookEvents(db, req.body || {});
    eventIds = recorded.eventIds;
    const shouldSync = recorded.entityNames.some(name => ['bill', 'billpayment'].includes(String(name).toLowerCase()));
    res.json({ ok: true, queued: shouldSync, events: eventIds.length });

    if (shouldSync) {
      setImmediate(async () => {
        try {
          await syncQuickBooksBills({ source: 'webhook' });
          markWebhookEvents(getDb(), eventIds, 'processed');
        } catch (err) {
          markWebhookEvents(getDb(), eventIds, 'failed', err.message || 'QuickBooks webhook sync failed');
        }
      });
    } else if (eventIds.length) {
      markWebhookEvents(db, eventIds, 'ignored');
    }
  } catch (err) {
    console.error('[QBO] Webhook failed:', err);
    if (eventIds.length) markWebhookEvents(getDb(), eventIds, 'failed', err.message || 'Webhook failed');
    if (!res.headersSent) {
      res.status(err.statusCode || 500).json({ error: err.message || 'QuickBooks webhook failed' });
    }
  }
});

router.get('/oauth/callback', async (req, res) => {
  const db = getDb();
  const state = String(req.query.state || '');
  const code = String(req.query.code || '');
  const realmId = String(req.query.realmId || '');
  if (!state || !code || !realmId) {
    return res.status(400).send('Missing QuickBooks authorization response fields.');
  }

  const savedState = db.prepare(`
    SELECT *
    FROM quickbooks_oauth_states
    WHERE state = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')
  `).get(state);
  if (!savedState) return res.status(400).send('QuickBooks authorization state expired or invalid.');

  try {
    const token = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
    });

    const connection = {
      id: 'primary',
      realm_id: realmId,
      environment: qboEnvironment(),
      access_token_encrypted: encryptSecret(token.access_token),
      refresh_token_encrypted: encryptSecret(token.refresh_token),
      access_token_expires_at: addSeconds(token.expires_in || 3600),
      scope: token.scope || ACCOUNTING_SCOPE,
    };
    const companyName = await fetchCompanyName(db, connection);

    db.prepare(`
      INSERT INTO quickbooks_connections (
        id, realm_id, environment, company_name, scope, access_token_encrypted,
        refresh_token_encrypted, access_token_expires_at, connected_by, is_active,
        connected_at, updated_at, last_sync_status, last_sync_error
      )
      VALUES ('primary', ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'), 'connected', NULL)
      ON CONFLICT(id) DO UPDATE SET
        realm_id = excluded.realm_id,
        environment = excluded.environment,
        company_name = excluded.company_name,
        scope = excluded.scope,
        access_token_encrypted = excluded.access_token_encrypted,
        refresh_token_encrypted = excluded.refresh_token_encrypted,
        access_token_expires_at = excluded.access_token_expires_at,
        connected_by = excluded.connected_by,
        is_active = 1,
        updated_at = datetime('now'),
        last_sync_status = 'connected',
        last_sync_error = NULL
    `).run(
      realmId,
      qboEnvironment(),
      companyName,
      token.scope || ACCOUNTING_SCOPE,
      connection.access_token_encrypted,
      connection.refresh_token_encrypted,
      connection.access_token_expires_at,
      savedState.user_id
    );
    db.prepare("UPDATE quickbooks_oauth_states SET used_at = datetime('now') WHERE state = ?").run(state);
    logActivity({
      userId: savedState.user_id,
      action: 'quickbooks_connected',
      entityType: 'quickbooks_connection',
      entityId: realmId,
      details: { environment: qboEnvironment(), company_name: companyName || null },
    });

    res.type('html').send(`
      <!doctype html>
      <html>
        <head><title>QuickBooks Connected</title></head>
        <body style="font-family: Arial, sans-serif; padding: 32px; background: #0b1117; color: #f8fafc;">
          <h1>QuickBooks connected</h1>
          <p>${companyName ? `${companyName} is` : 'The company is'} now connected to BuildTrack.</p>
          <p><a style="color:#93c5fd" href="/invoices">Return to BuildTrack invoices</a></p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[QBO] OAuth callback failed:', err);
    res.status(err.statusCode || 500).send('QuickBooks connection failed. Return to BuildTrack and try again.');
  }
});

router.use(authenticate);

router.get('/status', authorize(...MANAGEMENT_ROLES), (req, res) => {
  const db = getDb();
  const config = qboConfig();
  const connection = getActiveConnection(db);
  res.json({
    configured: config.configured,
    missing: config.missing,
    environment: config.environment,
    app_id_configured: Boolean(config.appId),
    webhook_configured: config.webhookConfigured,
    webhook_url: `${appBaseUrl()}/api/quickbooks/webhook`,
    redirect_uri: config.redirectUri,
    scope: config.scope,
    connected: Boolean(connection),
    connection: connection ? {
      realm_id: connection.realm_id,
      company_name: connection.company_name,
      environment: connection.environment,
      connected_at: connection.connected_at,
      updated_at: connection.updated_at,
      last_sync_at: connection.last_sync_at,
      last_sync_status: connection.last_sync_status,
      last_sync_error: connection.last_sync_error,
    } : null,
    stats: statusSummary(db),
  });
});

router.get('/connect-url', authorize(...QUICKBOOKS_ADMIN_ROLES), (req, res) => {
  const config = qboConfig();
  if (!config.configured) {
    return res.status(503).json({ error: `QuickBooks credentials are not configured: ${config.missing.join(', ')}`, missing: config.missing });
  }
  const db = getDb();
  const state = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO quickbooks_oauth_states (state, user_id, expires_at) VALUES (?, ?, ?)')
    .run(state, req.user.id, expiresAt);
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: ACCOUNTING_SCOPE,
    state,
  });
  res.json({
    auth_url: `${AUTH_URL}?${params.toString()}`,
    redirect_uri: config.redirectUri,
    expires_at: expiresAt,
  });
});

router.post('/sync', authorize(...QUICKBOOKS_ADMIN_ROLES), async (req, res) => {
  try {
    const result = await syncQuickBooksBills({ source: 'manual', userId: req.user.id });
    if (result.skipped && result.reason === 'not_connected') {
      return res.status(409).json({ error: 'QuickBooks is not connected yet.' });
    }
    if (result.skipped) {
      return res.status(503).json({ error: `QuickBooks sync skipped: ${result.reason}` });
    }
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'QuickBooks sync failed' });
  }
});

router.get('/bills', authorize(...QUICKBOOKS_ADMIN_ROLES), (req, res) => {
  const db = getDb();
  const status = String(req.query.status || '').toLowerCase();
  const unmatchedOnly = String(req.query.unmatched || '') === '1';
  const requestedLimit = Number(req.query.limit || 500);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(1000, Math.floor(requestedLimit))) : 500;
  const params = [];
  const where = [];
  const excludedVendors = excludedQuickBooksBillVendors();
  if (['paid', 'partial', 'unpaid'].includes(status)) {
    where.push('qb.payment_status = ?');
    params.push(status);
  }
  if (status === 'unpaid') {
    where.push(`COALESCE(qb.payment_approval_status, '${PAYMENT_APPROVAL_DEFAULT_STATUS}') != '${PAYMENT_APPROVAL_STATUS}'`);
  }
  if (unmatchedOnly) {
    where.push(`qb.project_id IS NULL AND NOT ${splitLinesFullyMatchedSql('qb')}`);
    where.push(`COALESCE(qb.payment_approval_status, '${PAYMENT_APPROVAL_DEFAULT_STATUS}') != '${PAYMENT_APPROVAL_STATUS}'`);
  }
  if (excludedVendors.length) {
    where.push(`lower(trim(COALESCE(qb.vendor_name, ''))) NOT IN (${excludedVendors.map(() => '?').join(', ')})`);
    params.push(...excludedVendors);
  }
  const rows = db.prepare(`
    SELECT
      ${quickBooksBillSelectSql()}
    ${quickBooksBillJoinsSql()}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY
      CASE qb.payment_status WHEN 'unpaid' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END,
      date(COALESCE(qb.txn_date, qb.due_date, qb.qbo_updated_at, qb.last_seen_at)) ASC,
      lower(COALESCE(qb.vendor_name, '')) ASC,
      CAST(COALESCE(qb.doc_number, qb.qbo_id) AS TEXT) ASC
    LIMIT ?
  `).all(...params, limit);
  res.json(attachQuickBooksBillLines(db, attachQuickBooksBillPaymentDates(db, rows)));
});

router.put('/bills/:qboId/approve-for-pay', authorize(...QUICKBOOKS_ADMIN_ROLES), (req, res) => {
  const db = getDb();
  const bill = getQuickBooksBillRow(db, req.params.qboId);
  if (!bill) return res.status(404).json({ error: 'QuickBooks bill not found.' });
  if (bill.payment_status === 'paid') {
    return res.status(409).json({ error: 'This bill is already paid in QuickBooks.' });
  }
  if (!quickBooksBillHasApprovalMatch(db, bill)) {
    return res.status(409).json({ error: 'Match this bill or every QuickBooks class split to a BuildTrack project before approving for pay.' });
  }

  const paymentRunDate = nextPaymentRunDate(req.body?.payment_run_date || new Date());
  db.prepare(`
    UPDATE quickbooks_bills
    SET payment_approval_status = ?,
        payment_approved_at = COALESCE(payment_approved_at, datetime('now')),
        payment_approved_by = COALESCE(payment_approved_by, ?),
        payment_run_date = ?,
        updated_at = datetime('now')
    WHERE qbo_id = ?
  `).run(PAYMENT_APPROVAL_STATUS, req.user.id, paymentRunDate, bill.qbo_id);

  const updated = getQuickBooksBillRow(db, bill.qbo_id);
  logActivity({
    userId: req.user.id,
    projectId: updated.project_id || undefined,
    action: 'quickbooks_bill_approved_for_pay',
    entityType: 'quickbooks_bill',
    entityId: updated.qbo_id,
    details: {
      vendor_name: updated.vendor_name,
      balance: updated.balance,
      payment_run_date: updated.payment_run_date,
    },
  });
  res.json(updated);
});

router.put('/bills/:qboId/remove-from-pay', authorize(...QUICKBOOKS_ADMIN_ROLES), (req, res) => {
  const db = getDb();
  const bill = getQuickBooksBillRow(db, req.params.qboId);
  if (!bill) return res.status(404).json({ error: 'QuickBooks bill not found.' });
  if (bill.payment_status === 'paid') {
    return res.status(409).json({ error: 'This bill is already paid in QuickBooks.' });
  }

  db.prepare(`
    UPDATE quickbooks_bills
    SET payment_approval_status = ?,
        payment_approved_at = NULL,
        payment_approved_by = NULL,
        payment_run_date = NULL,
        payment_approval_notified_at = NULL,
        payment_approval_notified_by = NULL,
        updated_at = datetime('now')
    WHERE qbo_id = ?
  `).run(PAYMENT_APPROVAL_DEFAULT_STATUS, bill.qbo_id);

  const updated = getQuickBooksBillRow(db, bill.qbo_id);
  logActivity({
    userId: req.user.id,
    projectId: updated.project_id || undefined,
    action: 'quickbooks_bill_removed_from_pay_queue',
    entityType: 'quickbooks_bill',
    entityId: updated.qbo_id,
    details: { vendor_name: updated.vendor_name, balance: updated.balance },
  });
  res.json(updated);
});

router.post('/payment-queue/notify', authorize(...QUICKBOOKS_ADMIN_ROLES), async (req, res) => {
  try {
    const db = getDb();
    const requestedRunDate = req.body?.payment_run_date ? String(req.body.payment_run_date).slice(0, 10) : null;
    const rows = approvedPaymentQueueRows(db, requestedRunDate);
    if (!rows.length) {
      return res.status(409).json({ error: 'No QuickBooks bills are approved for the Friday payment queue.' });
    }

    await sendApprovedPayNotificationEmail({
      approvedInvoices: paymentQueueEmailRows(rows),
      approvedBy: req.user.name || req.user.email || 'BuildTrack',
    });

    const updateNotified = db.prepare(`
      UPDATE quickbooks_bills
      SET payment_approval_notified_at = datetime('now'),
          payment_approval_notified_by = ?,
          updated_at = datetime('now')
      WHERE qbo_id = ?
    `);
    const write = db.transaction(() => {
      for (const row of rows) updateNotified.run(req.user.id, row.qbo_id);
    });
    write();

    const updatedRows = requestedRunDate ? approvedPaymentQueueRows(db, requestedRunDate) : approvedPaymentQueueRows(db);
    const total = paymentQueueTotal(rows);
    logActivity({
      userId: req.user.id,
      action: 'quickbooks_payment_queue_notified',
      entityType: 'quickbooks_payment_queue',
      entityId: requestedRunDate || 'all',
      details: {
        bill_count: rows.length,
        total_balance: normalizeMoney(total),
        payment_run_date: requestedRunDate,
        recipient: process.env.APPROVED_INVOICE_NOTIFY_EMAIL || 'info@newurbandev.com',
      },
    });

    res.json({
      message: 'Management notified about the approved Friday payment queue.',
      bill_count: rows.length,
      total_balance: normalizeMoney(total),
      rows: updatedRows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to email the approved payment queue.' });
  }
});

function startQuickBooksAutoSync() {
  if (autoSyncStarted) return;
  if (process.env.QBO_AUTO_SYNC_ENABLED === 'false' || process.env.QUICKBOOKS_AUTO_SYNC_ENABLED === 'false') {
    console.log('[QBO] Automatic sync disabled by environment.');
    return;
  }
  autoSyncStarted = true;
  const intervalMs = getAutoSyncIntervalMs();
  const run = async () => {
    try {
      const result = await syncQuickBooksBills({ source: 'auto' });
      if (result?.skipped) {
        if (!['missing_credentials:', 'not_connected'].some(prefix => String(result.reason || '').startsWith(prefix))) {
          console.log('[QBO] Automatic sync skipped:', result.reason);
        }
        return;
      }
      console.log(`[QBO] Automatic sync completed: ${result.bills} bills, ${result.matched_invoices} matched invoices, ${result.ignored_bills || 0} ignored bills`);
    } catch (err) {
      console.error('[QBO] Automatic sync failed:', err.message);
    }
  };
  setTimeout(run, Math.min(30 * 1000, intervalMs));
  setInterval(run, intervalMs);
  console.log(`[QBO] Automatic Bill sync enabled every ${Math.round(intervalMs / 1000)} seconds.`);
}

function startQuickBooksPaymentQueueScheduler() {
  if (paymentQueueSchedulerStarted) return;
  if (process.env.QBO_PAYMENT_QUEUE_NOTIFY_ENABLED === 'false' || process.env.PAYMENT_QUEUE_NOTIFY_ENABLED === 'false') {
    console.log('[QBO] Friday payment queue email scheduler disabled by environment.');
    return;
  }
  paymentQueueSchedulerStarted = true;
  const intervalMs = getPaymentQueueNotifyPollMs();
  const run = async () => {
    try {
      const result = await sendScheduledPaymentQueueEmail();
      if (result?.ok) return;
      if (result?.reason && !['not_payday_window', 'already_sent', 'already_running'].includes(result.reason)) {
        console.log('[QBO] Friday payment queue email skipped:', result.reason);
      }
    } catch (err) {
      console.error('[QBO] Friday payment queue email failed:', err.message);
    }
  };
  setTimeout(run, 10 * 1000).unref?.();
  setInterval(run, intervalMs).unref?.();
  console.log(`[QBO] Friday payment queue email scheduler enabled: every other Friday from 2026-06-12 after ${getPaymentQueueNotifyHourEt()}:00 ET.`);
}

router.startQuickBooksAutoSync = startQuickBooksAutoSync;
router.startQuickBooksPaymentQueueScheduler = startQuickBooksPaymentQueueScheduler;
router.sendScheduledPaymentQueueEmail = sendScheduledPaymentQueueEmail;

module.exports = router;
