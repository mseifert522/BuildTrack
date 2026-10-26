const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
const { getDb } = require('../db/schema');
const { authenticate, authorize } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { isEmailConfigured, sendApprovedPayNotificationEmail, sendContractorInvoiceReceivedEmail } = require('../utils/email');
const { ensureBillHasInvoiceNumber, invDisplay } = require('../utils/invoiceNumbers');
const { looseVendorKey } = require('../utils/vendorDirectory');

const router = express.Router();
const MANAGEMENT_ROLES = ['super_admin', 'operations_manager', 'project_manager', 'admin_assistant'];
const QUICKBOOKS_ADMIN_ROLES = ['super_admin', 'operations_manager'];
const ACCOUNTING_SCOPE = 'com.intuit.quickbooks.accounting';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const MINOR_VERSION = '75';
// The full re-read is now only the authoritative reconcile (deletions, vendors, PDFs);
// changes arrive through the change checks below. QBO_AUTO_SYNC_INTERVAL_MS overrides.
// Hourly since 2026-10-23 (Intuit allowance, below): the 5-minute change check carries
// every edit; this only catches deletions and anything a change feed cannot report.
const AUTO_SYNC_DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_EXCLUDED_BILL_VENDORS = ['great lakes mortgage fund'];
const PAYMENT_APPROVAL_STATUS = 'approved_for_payment';
const PAYMENT_APPROVAL_DEFAULT_STATUS = 'not_approved';
const PAYMENT_APPROVAL_DELETED_STATUS = 'deleted_from_buildtrack';
const PAYMENT_APPROVAL_PAID_STATUS = 'paid_from_buildtrack';
const PAYDAY_ANCHOR_UTC_MS = Date.UTC(2026, 5, 12, 12, 0, 0);
const PAYMENT_QUEUE_NOTIFY_DEFAULT_HOUR_ET = 8;
const PAYMENT_QUEUE_NOTIFY_DEFAULT_POLL_MS = 5 * 60 * 1000;
const qboBillPdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: Math.max(Number.parseInt(process.env.MAX_FILE_SIZE_MB || '20', 10), 1) * 1024 * 1024,
  },
});
let autoSyncStarted = false;
let activeSyncPromise = null;
let activeBillPdfSyncPromise = null;
let paymentQueueSchedulerStarted = false;
let paymentQueueSchedulerRunning = false;
const qboTokenRefreshInFlight = new Map();

// ── QuickBooks request lane + fast change check (2026-10-20) ────────────────
// Every QuickBooks API call in this process (bill sync, the fast change check, queue
// re-checks, Verify, and the Finance Tracker service feeds) shares one lane per
// company. Finance Tracker used to burst 8+ requests at once against New Urban's
// company, Intuit answered 429, and a 429 on the bill sync cost that minute's whole
// sync. Requests over the limit now wait their turn, a 429 is retried after a short
// backoff, and every request has a timeout so a hung call cannot stall the sync.
const QBO_REQUEST_LANES = new Map();
const QBO_RATE_LIMIT_RETRIES = 3;
// Event-driven sync (2026-10-20, Mike: "sync immediately when something happens; don't
// burn compute checking every 15 seconds"). Intuit meters read calls per app, so
// BuildTrack asks QuickBooks one change-feed (CDC) question - "what changed since last
// time?" - only when (1) Intuit's webhook says a company changed, (2) someone opens the
// Invoice Center, or (3) a slow safety net fires. A change reaching BuildTrack also
// pings Finance Tracker, which pulls only then.
const CHANGE_CHECK_DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const FINANCE_CHANGE_CHECK_DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const FAST_CHECK_OVERLAP_MS = 2 * 60 * 1000;
const FAST_CHECK_FIRST_LOOKBACK_MS = 10 * 60 * 1000;
// Opening the Invoice Center (and its 60 s poll) asks QuickBooks at most this often;
// was 20 s, which let one open tab spend ~3 change checks a minute. QBO_VIEW_CHECK_MIN_GAP_MS.
const CHANGE_CHECK_ON_VIEW_MIN_GAP_MS = 2 * 60 * 1000;
const CHANGE_CHECK_ON_VIEW_WAIT_MS = 4 * 1000;
const WEBHOOK_CHECK_DEBOUNCE_MS = 3 * 1000;
const WEBHOOK_UNVERIFIED_MIN_GAP_MS = 30 * 1000;
const FT_NOTIFY_DEBOUNCE_MS = 15 * 1000;
const FT_NOTIFY_MAX_WAIT_MS = 60 * 1000;
// A changed attachment or bill asks for a scan at once; otherwise the full sync scans hourly.
const BILL_PDF_SCAN_DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const BILL_PDF_SCAN_DEBOUNCE_MS = 5 * 1000;
let activeFastCheckPromise = null; // New Urban's in-flight check; the full sync waits for it
const changeCheckInFlight = new Map(); // connection id -> in-flight check
const changeCheckCursors = new Map(); // connection id -> changedSince for its next check
const changeCheckStates = new Map(); // connection id -> status shown on /quickbooks/status
const changeCheckRequests = new Map(); // connection id -> { timer, lastRunAt } (webhook debounce)
const seenCdcKeys = new Map(); // connection id -> entity versions already counted as changes
let lastQuickBooksChangeAt = null;
let billPdfScanRequested = true;
let lastBillPdfScanAt = 0;
let billPdfScanTimer = null;
const handledCdcDeletes = new Set();
const fastCheckConfig = { enabled: false, interval_ms: 0, finance_interval_ms: 0 };
const webhookState = { received: 0, rejected: 0, last_received_at: null, last_verified: null, last_realms: [] };
const financeTrackerNotify = {
  timer: null, firstQueuedAt: 0, realms: new Set(), sending: false,
  sent: 0, last_at: null, last_status: null, last_error: null, last_realms: [],
};
let webhookEventsPrunedAt = 0;

// ── Intuit API allowance (2026-10-23) ───────────────────────────────────────
// Intuit's free Builder plan allows 500,000 read ("CorePlus") calls a month for the whole
// developer workspace: this app (New Urban + the three Finance-hub companies) AND the NMR
// portal's app. The month ran out on 2026-10-22 ~11:20 UTC - Finance Tracker had pulled
// every company's statements and New Urban's feeds every minute until 10-20 - and Intuit
// refused every read, for every company, until the month turns. Since then:
//  - every Intuit call is counted per UTC month, company and purpose (table
//    quickbooks_api_usage; /quickbooks/status -> api_usage);
//  - Finance Tracker, Finance-hub and Bank Draws reads are answered from a cache until a
//    change check sees that company change (or QBO_READ_CACHE_MAX_AGE_MS passes);
//  - background pulls slow down when the month runs ahead of QBO_MONTHLY_CALL_BUDGET and
//    stop for everything but bills near it;
//  - Intuit's "monthly limit" answer pauses every call except one probe every
//    QBO_MONTHLY_BLOCK_PROBE_MS, and work resumes by itself once a probe gets through.
const QBO_DEFAULT_MONTHLY_CALL_BUDGET = 300000; // of Intuit's 500,000; the NMR portal draws on the rest
const QBO_READ_CACHE_MAX_AGE_DEFAULT_MS = 2 * 60 * 60 * 1000;
const QBO_READ_CACHE_CLOSED_PERIOD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const QBO_READ_CACHE_ECONOMY_FLOOR_MS = 30 * 60 * 1000;
const QBO_READ_CACHE_MAX_CHARS = 64 * 1024 * 1024;
const QBO_MONTHLY_BLOCK_PROBE_DEFAULT_MS = 10 * 60 * 1000;
const QBO_USAGE_FLUSH_MS = 60 * 1000;
// Purposes that can wait for the cache or a slower beat; bills and the payment queue never do.
const QBO_DEFERRABLE_PURPOSES = new Set(['finance_tracker', 'bank_draws', 'finance_change_check', 'books_import']);
// How many base intervals a background beat waits at each budget level (0 = not at all).
const QBO_BUDGET_FACTORS = {
  full_sync: { normal: 1, economy: 2, reserve: 4 },
  change_check: { normal: 1, economy: 1, reserve: 3 },
  finance_change_check: { normal: 1, economy: 4, reserve: 0 },
  view: { normal: 1, economy: 2.5, reserve: 5 },
};
const qboContext = new AsyncLocalStorage(); // { purpose, cache } for calls made inside withQboPurpose
const qboUsage = { db: null, tableReady: false, month: null, used: 0, pending: new Map(), timer: null, cacheHits: {} };
const qboReadCache = new Map(); // `${realm}|${path}` -> { text, at }; Map order = least recently used first
const qboReadInFlight = new Map(); // same key -> promise of the response text
let qboReadCacheChars = 0;
const realmChangedAt = new Map(); // realm id -> ms a change check (or full sync) last saw it change
const qboBeatLastRun = new Map();
let qboMonthlyBlock = null; // { since, last_probe_at, probes } while Intuit refuses reads

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

function sanitizeFilename(filename) {
  const base = path.basename(String(filename || 'invoice.pdf'));
  return base.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 180) || 'invoice.pdf';
}

function safePathSegment(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'bill';
}

function headerFilename(filename) {
  return sanitizeFilename(filename).replace(/["\\\r\n]/g, '_');
}

function quickBooksBillAttachmentRoot() {
  return path.resolve(process.env.UPLOADS_PATH || './uploads', 'quickbooks-bill-attachments');
}

function deleteQuickBooksBillAttachmentFiles(qboId, attachments = []) {
  const root = quickBooksBillAttachmentRoot();
  const resolvedRoot = path.resolve(root);
  const dir = path.resolve(root, safePathSegment(qboId));
  if (!dir.startsWith(`${resolvedRoot}${path.sep}`)) return;

  for (const attachment of attachments) {
    const filename = String(attachment?.filename || '').trim();
    if (!filename) continue;
    const filePath = path.resolve(dir, filename);
    if (!filePath.startsWith(`${dir}${path.sep}`)) continue;
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      console.warn('[QBO] Failed to remove deleted bill PDF:', err.message);
    }
  }

  try {
    fs.rmdirSync(dir);
  } catch (_) {
    // Directory may not exist or may still contain retained files.
  }
}

function isPdfLike({ mimeType, name, buffer } = {}) {
  const type = String(mimeType || '').toLowerCase();
  const filename = String(name || '').toLowerCase();
  const header = buffer && Buffer.isBuffer(buffer) ? buffer.slice(0, 5).toString('utf8') : '';
  return type.includes('pdf') || filename.endsWith('.pdf') || header === '%PDF-';
}

function isQboInvoiceDocumentLike({ mimeType, name, buffer } = {}) {
  const type = String(mimeType || '').toLowerCase();
  const filename = String(name || '').toLowerCase();
  const hasBuffer = buffer && Buffer.isBuffer(buffer) && buffer.length > 0;
  const pdfHeader = hasBuffer ? buffer.slice(0, 5).toString('utf8') === '%PDF-' : false;
  if (pdfHeader) return true;
  const imageType = type.includes('image/jpeg') || type.includes('image/jpg') || type.includes('image/png');
  const imageName = filename.endsWith('.jpg') || filename.endsWith('.jpeg') || filename.endsWith('.png');
  const imageHeader = hasBuffer
    ? (buffer.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) || buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    : false;
  if (hasBuffer) return imageHeader;
  if (isPdfLike({ mimeType, name })) return true;
  return imageType || imageName || imageHeader;
}

function formatBytesValue(value) {
  const size = Number(value || 0);
  if (!Number.isFinite(size) || size <= 0) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatQuickBooksBillAttachment(row) {
  if (!row) return null;
  const isPdf = isPdfLike({ mimeType: row.mime_type, name: row.original_name || row.filename });
  return {
    id: row.id,
    source: 'quickbooks_bill_attachment',
    label: isPdf ? 'Vendor PDF' : 'Vendor image',
    qbo_bill_id: row.qbo_bill_id,
    qbo_attachable_id: row.qbo_attachable_id || null,
    original_name: row.original_name,
    mime_type: row.mime_type,
    size: row.size,
    size_label: formatBytesValue(row.size),
    qbo_file_access_uri: row.qbo_file_access_uri || null,
    uploaded_by: row.uploaded_by,
    uploaded_by_name: row.uploaded_by_name || null,
    created_at: row.created_at,
    url: `/api/quickbooks/bills/${encodeURIComponent(row.qbo_bill_id)}/attachments/${encodeURIComponent(row.id)}?inline=1`,
  };
}

function getQuickBooksBillAttachment(db, qboId, attachmentId = null) {
  const where = attachmentId
    ? 'qba.qbo_bill_id = ? AND qba.id = ?'
    : 'qba.qbo_bill_id = ?';
  const params = attachmentId ? [qboId, attachmentId] : [qboId];
  return db.prepare(`
    SELECT qba.*, u.name as uploaded_by_name
    FROM quickbooks_bill_attachments qba
    LEFT JOIN users u ON u.id = qba.uploaded_by
    WHERE ${where}
    ORDER BY datetime(qba.created_at) DESC, qba.created_at DESC
    LIMIT 1
  `).get(...params);
}

function getLatestQuickBooksBillPdfAttachment(db, qboId) {
  return db.prepare(`
    SELECT qba.*, u.name as uploaded_by_name
    FROM quickbooks_bill_attachments qba
    LEFT JOIN users u ON u.id = qba.uploaded_by
    WHERE qba.qbo_bill_id = ?
      AND (
        lower(COALESCE(qba.mime_type, '')) LIKE '%pdf%'
        OR lower(COALESCE(qba.mime_type, '')) IN ('image/jpeg', 'image/jpg', 'image/png')
        OR lower(COALESCE(qba.original_name, qba.filename, '')) LIKE '%.pdf'
        OR lower(COALESCE(qba.original_name, qba.filename, '')) LIKE '%.jpg'
        OR lower(COALESCE(qba.original_name, qba.filename, '')) LIKE '%.jpeg'
        OR lower(COALESCE(qba.original_name, qba.filename, '')) LIKE '%.png'
      )
    ORDER BY datetime(qba.created_at) DESC, qba.created_at DESC
    LIMIT 1
  `).get(String(qboId || ''));
}

function quickBooksBillPdfSyncMaxBytes() {
  const requested = Number.parseInt(process.env.QBO_BILL_PDF_SYNC_MAX_MB || process.env.MAX_FILE_SIZE_MB || '50', 10);
  const mb = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 100) : 50;
  return mb * 1024 * 1024;
}

function quickBooksAttachableRefs(attachable) {
  return Array.isArray(attachable?.AttachableRef) ? attachable.AttachableRef : [];
}

function quickBooksAttachableBillIds(attachable) {
  return quickBooksAttachableRefs(attachable)
    .filter(ref => String(ref?.EntityRef?.type || ref?.EntityRef?.Type || '').toLowerCase() === 'bill')
    .map(ref => String(ref?.EntityRef?.value || ref?.EntityRef?.Value || '').trim())
    .filter(Boolean);
}

function quickBooksAttachableIsPdf(attachable) {
  const contentType = String(attachable?.ContentType || '').toLowerCase();
  const filename = String(attachable?.FileName || '').toLowerCase();
  return (
    contentType.includes('pdf')
    || contentType.includes('image/jpeg')
    || contentType.includes('image/jpg')
    || contentType.includes('image/png')
    || filename.endsWith('.pdf')
    || filename.endsWith('.jpg')
    || filename.endsWith('.jpeg')
    || filename.endsWith('.png')
  );
}

function quickBooksAttachableDownloadUri(attachable) {
  return attachable?.FileAccessUri || attachable?.FileAccessURI || attachable?.TempDownloadUri || '';
}

function quickBooksAttachableFilename(qboId, attachable) {
  return sanitizeFilename(attachable?.FileName || `quickbooks-bill-${qboId}-${attachable?.Id || 'attachment'}.pdf`);
}

function quickBooksAttachmentStoredExtension(originalName, mimeType) {
  const filename = String(originalName || '').toLowerCase();
  const type = String(mimeType || '').toLowerCase();
  if (filename.endsWith('.png') || type.includes('image/png')) return '.png';
  if (filename.endsWith('.jpg') || type.includes('image/jpg')) return '.jpg';
  if (filename.endsWith('.jpeg') || type.includes('image/jpeg')) return '.jpeg';
  return '.pdf';
}

function quickBooksAttachmentFilePath(qboId, filename) {
  const root = quickBooksBillAttachmentRoot();
  const resolvedRoot = path.resolve(root);
  const dir = path.resolve(root, safePathSegment(qboId));
  if (!dir.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('Invalid QuickBooks attachment path');
  const filePath = path.resolve(dir, filename);
  if (!filePath.startsWith(`${dir}${path.sep}`)) throw new Error('Invalid QuickBooks attachment filename');
  return { dir, filePath };
}

async function qboDownloadAttachment(db, connection, uri) {
  const value = String(uri || '').trim();
  if (!value) throw new Error('QuickBooks attachment has no download URI');
  if (qboMonthlyBlockHolds()) throw qboMonthlyLimitError();
  const accessToken = await refreshAccessToken(db, connection);
  let url = value;
  if (!/^https?:\/\//i.test(url)) {
    url = `${qboApiBase(connection.environment)}${url.startsWith('/') ? '' : '/'}${url}`;
  }
  // The bill sync awaits PDF downloads, so a hung download must not hold it up.
  const response = await fetch(url, {
    headers: {
      Accept: 'application/pdf,*/*',
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(120 * 1000),
  });
  recordQboCall(db, connection, '/attachment/download', { rejected: response.status === 429 });
  if (!response.ok) {
    const err = new Error(`QuickBooks attachment download failed (${response.status})`);
    err.statusCode = response.status;
    throw err;
  }
  let buffer = Buffer.from(await response.arrayBuffer());
  let contentType = response.headers.get('content-type') || 'application/pdf';
  const textBody = buffer.toString('utf8').trim();
  if (contentType.toLowerCase().includes('text/plain') && /^https?:\/\//i.test(textBody)) {
    const fileResponse = await fetch(textBody, {
      headers: {
        Accept: 'application/pdf,image/*,*/*',
      },
      signal: AbortSignal.timeout(120 * 1000),
    });
    if (!fileResponse.ok) {
      const err = new Error(`QuickBooks attachment file download failed (${fileResponse.status})`);
      err.statusCode = fileResponse.status;
      throw err;
    }
    buffer = Buffer.from(await fileResponse.arrayBuffer());
    contentType = fileResponse.headers.get('content-type') || contentType;
  }
  return { buffer, contentType };
}

function quickBooksBillPdfTargets(db, { scope = 'open_missing', qboIds = [] } = {}) {
  const params = [];
  const where = [`COALESCE(qb.payment_approval_status, '${PAYMENT_APPROVAL_DEFAULT_STATUS}') != '${PAYMENT_APPROVAL_DELETED_STATUS}'`];
  if (qboIds.length) {
    where.push(`qb.qbo_id IN (${qboIds.map(() => '?').join(', ')})`);
    params.push(...qboIds.map(id => String(id)));
  } else if (scope === 'open' || scope === 'open_missing') {
    where.push("qb.payment_status != 'paid'");
    where.push(`COALESCE(qb.payment_approval_status, '${PAYMENT_APPROVAL_DEFAULT_STATUS}') != '${PAYMENT_APPROVAL_STATUS}'`);
  }
  if (scope === 'missing' || scope === 'open_missing') {
    where.push(`
      NOT EXISTS (
        SELECT 1 FROM quickbooks_bill_attachments qba
        WHERE qba.qbo_bill_id = qb.qbo_id
          AND (
            lower(COALESCE(qba.mime_type, '')) LIKE '%pdf%'
            OR lower(COALESCE(qba.mime_type, '')) IN ('image/jpeg', 'image/jpg', 'image/png')
            OR lower(COALESCE(qba.original_name, qba.filename, '')) LIKE '%.pdf'
            OR lower(COALESCE(qba.original_name, qba.filename, '')) LIKE '%.jpg'
            OR lower(COALESCE(qba.original_name, qba.filename, '')) LIKE '%.jpeg'
            OR lower(COALESCE(qba.original_name, qba.filename, '')) LIKE '%.png'
          )
      )
    `);
  }
  return db.prepare(`
    SELECT qb.qbo_id, qb.doc_number, qb.vendor_name, qb.matched_invoice_id, qb.project_id
    FROM quickbooks_bills qb
    WHERE ${where.join(' AND ')}
    ORDER BY date(COALESCE(qb.txn_date, qb.due_date, qb.last_seen_at)) DESC,
      lower(COALESCE(qb.vendor_name, '')) ASC,
      qb.qbo_id ASC
  `).all(...params);
}

async function fetchQuickBooksBillPdfAttachables(db, connection) {
  const attachables = await fetchAllQboEntities(db, connection, 'Attachable');
  const byBillId = new Map();
  for (const attachable of attachables) {
    if (!attachable?.Id || !quickBooksAttachableIsPdf(attachable)) continue;
    for (const billId of quickBooksAttachableBillIds(attachable)) {
      if (!byBillId.has(billId)) byBillId.set(billId, []);
      byBillId.get(billId).push(attachable);
    }
  }
  return { attachables, byBillId };
}

async function storeQuickBooksBillPdfAttachment(db, connection, bill, attachable, { force = false, userId = null } = {}) {
  const qboId = String(bill.qbo_id || '').trim();
  const attachableId = String(attachable?.Id || '').trim();
  if (!qboId || !attachableId) return { status: 'skipped', reason: 'missing_ids' };

  const existing = db.prepare(`
    SELECT *
    FROM quickbooks_bill_attachments
    WHERE qbo_bill_id = ? AND qbo_attachable_id = ?
    LIMIT 1
  `).get(qboId, attachableId);
  const id = existing?.id || uuidv4();
  const originalName = quickBooksAttachableFilename(qboId, attachable);
  const storedName = existing?.filename || `${id}${quickBooksAttachmentStoredExtension(originalName, attachable?.ContentType)}`;
  const downloadUri = quickBooksAttachableDownloadUri(attachable);
  const { dir, filePath } = quickBooksAttachmentFilePath(qboId, storedName);
  const existingFileUsable = existing?.filename && fs.existsSync(filePath) && !force;

  let size = Number(existing?.size || attachable?.Size || 0);
  let mimeType = existing?.mime_type || attachable?.ContentType || 'application/pdf';
  let downloaded = false;
  if (!existingFileUsable) {
    if (!downloadUri) return { status: 'skipped', reason: 'missing_download_uri', attachable_id: attachableId };
    const downloadedFile = await qboDownloadAttachment(db, connection, downloadUri);
    if (downloadedFile.buffer.length > quickBooksBillPdfSyncMaxBytes()) {
      return { status: 'skipped', reason: 'file_too_large', attachable_id: attachableId };
    }
    if (!isQboInvoiceDocumentLike({ mimeType: downloadedFile.contentType, name: originalName, buffer: downloadedFile.buffer })) {
      return { status: 'skipped', reason: 'not_invoice_document_content', attachable_id: attachableId };
    }
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, downloadedFile.buffer);
    size = downloadedFile.buffer.length;
    mimeType = downloadedFile.contentType || attachable?.ContentType || 'application/pdf';
    downloaded = true;
  }

  if (existing) {
    db.prepare(`
      UPDATE quickbooks_bill_attachments
      SET original_name = ?,
          mime_type = ?,
          size = ?,
          source = 'quickbooks',
          qbo_file_access_uri = ?,
          qbo_metadata_json = ?,
          uploaded_by = COALESCE(uploaded_by, ?)
      WHERE id = ?
    `).run(
      originalName,
      mimeType,
      size,
      attachable?.FileAccessUri || attachable?.TempDownloadUri || null,
      JSON.stringify(attachable || {}),
      userId,
      existing.id
    );
    return { status: downloaded ? 'redownloaded' : 'updated', attachable_id: attachableId };
  }

  db.prepare(`
    INSERT INTO quickbooks_bill_attachments (
      id, qbo_bill_id, filename, original_name, mime_type, size, uploaded_by,
      qbo_attachable_id, source, qbo_file_access_uri, qbo_metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'quickbooks', ?, ?)
  `).run(
    id,
    qboId,
    storedName,
    originalName,
    mimeType,
    size,
    userId,
    attachableId,
    attachable?.FileAccessUri || attachable?.TempDownloadUri || null,
    JSON.stringify(attachable || {})
  );
  return { status: 'downloaded', attachable_id: attachableId };
}

function getMatchedInvoicePdfSummary(db, invoiceId) {
  if (!invoiceId) return null;
  const attachment = db.prepare(`
    SELECT ia.*, u.name as uploaded_by_name
    FROM invoice_attachments ia
    LEFT JOIN users u ON u.id = ia.uploaded_by
    WHERE ia.invoice_id = ?
      AND (
        lower(COALESCE(ia.mime_type, '')) LIKE '%pdf%'
        OR lower(COALESCE(ia.original_name, ia.filename, '')) LIKE '%.pdf'
      )
    ORDER BY datetime(ia.created_at) DESC, ia.created_at DESC
    LIMIT 1
  `).get(invoiceId);
  if (attachment) {
    return {
      id: attachment.id,
      source: 'invoice_attachment',
      label: 'Invoice PDF',
      invoice_id: attachment.invoice_id,
      project_id: attachment.project_id,
      original_name: attachment.original_name,
      mime_type: attachment.mime_type,
      size: attachment.size,
      size_label: formatBytesValue(attachment.size),
      uploaded_by: attachment.uploaded_by,
      uploaded_by_name: attachment.uploaded_by_name || null,
      created_at: attachment.created_at,
      url: `/api/projects/${encodeURIComponent(attachment.project_id)}/invoices/${encodeURIComponent(attachment.invoice_id)}/attachments/${encodeURIComponent(attachment.id)}?inline=1`,
    };
  }

  const invoice = db.prepare('SELECT id, project_id, invoice_number FROM invoices WHERE id = ?').get(invoiceId);
  if (!invoice?.project_id) return null;
  return {
    id: invoice.id,
    source: 'generated_invoice_pdf',
    label: 'BuildTrack PDF',
    invoice_id: invoice.id,
    project_id: invoice.project_id,
    original_name: `invoice-${invoice.invoice_number || invoice.id}.pdf`,
    mime_type: 'application/pdf',
    size: null,
    size_label: null,
    uploaded_by: null,
    uploaded_by_name: null,
    created_at: null,
    url: `/api/projects/${encodeURIComponent(invoice.project_id)}/invoices/${encodeURIComponent(invoice.id)}/pdf`,
  };
}

function quickBooksBillPdfSummary(db, bill) {
  const manual = getLatestQuickBooksBillPdfAttachment(db, bill?.qbo_id);
  const pdf = manual ? formatQuickBooksBillAttachment(manual) : getMatchedInvoicePdfSummary(db, bill?.matched_invoice_id);
  return pdf
    ? { available: true, ...pdf }
    : { available: false, source: null, label: 'No PDF on file' };
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

function shouldRestoreDeletedQuickBooksBill(paymentApprovalStatus, paymentStatus) {
  // A bill hidden while open must reappear if QuickBooks later records it as
  // paid. Paid accounting history is authoritative and cannot remain hidden
  // behind a previous BuildTrack-only delete action.
  return paymentApprovalStatus === PAYMENT_APPROVAL_DELETED_STATUS && paymentStatus === 'paid';
}

function missingQuickBooksBillIds(localBills, quickBooksBills) {
  const liveIds = new Set((quickBooksBills || []).map(bill => String(bill?.Id || '')).filter(Boolean));
  return (localBills || [])
    .filter(bill => bill?.qbo_id && !liveIds.has(String(bill.qbo_id)))
    .map(bill => String(bill.qbo_id));
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

function readStoredConnectionTokens(db, connection) {
  return db.prepare(`
    SELECT access_token_encrypted, refresh_token_encrypted, access_token_expires_at, scope
    FROM quickbooks_connections
    WHERE id = ?
  `).get(connection.id);
}

// Decides from the STORED row, never the caller's copy. Sync passes and the Finance Tracker
// service endpoints load the connection once and make many requests with it; once any of them
// refreshes, that copy is stale, and a second refresh with its superseded refresh token fails
// with "Incorrect or invalid refresh token" after Intuit rotates it. Concurrent callers in this
// process share one in-flight refresh. The caller's object is updated with the current tokens.
async function refreshAccessToken(db, connection) {
  const stored = readStoredConnectionTokens(db, connection) || connection;
  Object.assign(connection, stored);
  const existingExpiry = stored.access_token_expires_at ? new Date(stored.access_token_expires_at).getTime() : 0;
  if (stored.access_token_encrypted && existingExpiry > Date.now() + 60000) {
    return decryptSecret(stored.access_token_encrypted);
  }

  // No await between reading the row and claiming the slot, so a second caller either sees the
  // refreshed row or joins this refresh.
  let refresh = qboTokenRefreshInFlight.get(connection.id);
  if (!refresh) {
    refresh = (async () => {
      const token = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: decryptSecret(stored.refresh_token_encrypted),
      });
      const nextRefresh = token.refresh_token || decryptSecret(stored.refresh_token_encrypted);
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
    })().finally(() => {
      qboTokenRefreshInFlight.delete(connection.id);
    });
    qboTokenRefreshInFlight.set(connection.id, refresh);
  }

  const accessToken = await refresh;
  Object.assign(connection, readStoredConnectionTokens(db, connection) || {});
  return accessToken;
}

function qboMaxConcurrentRequests() {
  const requested = Number(process.env.QBO_MAX_CONCURRENT_REQUESTS || 4);
  return Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 4;
}

function qboRequestTimeoutMs(path) {
  // Reports (balance sheet / P&L by class, general ledger) legitimately take longer.
  const isReport = /\/reports\//.test(path);
  const requested = Number(isReport ? process.env.QBO_REPORT_TIMEOUT_MS : process.env.QBO_REQUEST_TIMEOUT_MS);
  if (Number.isFinite(requested) && requested >= 5000) return requested;
  return isReport ? 180 * 1000 : 60 * 1000;
}

function qboRequestLabel(path) {
  const query = /[?&]query=([^&]+)/.exec(path);
  if (query) {
    const entity = /FROM\s+(\w+)/i.exec(decodeURIComponent(query[1]));
    return `${entity ? entity[1] : 'entity'} query`;
  }
  const report = /\/reports\/(\w+)/.exec(path);
  if (report) return `${report[1]} report`;
  if (/\/cdc\?/.test(path)) return 'change check';
  return path.split('?')[0].split('/').slice(-2).join('/');
}

async function acquireQboRequestSlot(realmId) {
  const key = String(realmId || 'default');
  let lane = QBO_REQUEST_LANES.get(key);
  if (!lane) {
    lane = { active: 0, waiting: [] };
    QBO_REQUEST_LANES.set(key, lane);
  }
  if (lane.active < qboMaxConcurrentRequests()) {
    lane.active += 1;
  } else {
    // A finishing request hands its slot straight to the next waiter (FIFO).
    await new Promise(resolve => lane.waiting.push(resolve));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = lane.waiting.shift();
    if (next) next();
    else lane.active -= 1;
  };
}

function qboRetryDelayMs(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 30 * 1000);
  return Math.min(30 * 1000, 2000 * (2 ** attempt)) + Math.floor(Math.random() * 500);
}

// ── Intuit API allowance: meter, budget, read cache, monthly-limit pause ─────
function withQboPurpose(purpose, fn, { cache = false } = {}) {
  return qboContext.run({ purpose, cache }, fn);
}

function qboPurpose() {
  return qboContext.getStore()?.purpose || 'other';
}

function qboMonthlyBudget() {
  const requested = Number(process.env.QBO_MONTHLY_CALL_BUDGET);
  return Number.isFinite(requested) && requested >= 1000 ? Math.floor(requested) : QBO_DEFAULT_MONTHLY_CALL_BUDGET;
}

// Creates the meter table on first use and loads this month's count once per month.
function qboUsageReady(db) {
  if (!db) return false;
  qboUsage.db = db;
  if (!qboUsage.tableReady) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS quickbooks_api_usage (
        month TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        purpose TEXT NOT NULL,
        label TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0,
        rejected INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (month, connection_id, purpose, label)
      )
    `);
    qboUsage.tableReady = true;
  }
  const month = new Date().toISOString().slice(0, 7);
  if (qboUsage.month !== month) {
    flushQboUsage();
    qboUsage.month = month;
    qboUsage.used = db.prepare('SELECT COALESCE(SUM(calls - rejected), 0) AS n FROM quickbooks_api_usage WHERE month = ?').get(month).n;
  }
  return true;
}

// Counts one Intuit call (rejected = Intuit refused it). Never throws: the meter must not
// break the call it measures. Counts reach the table within QBO_USAGE_FLUSH_MS.
function recordQboCall(db, connection, path, { rejected = false } = {}) {
  try {
    if (!qboUsageReady(db)) return;
    const connectionId = connection?.id || 'unknown';
    const purpose = qboPurpose();
    const label = qboRequestLabel(path);
    const key = [qboUsage.month, connectionId, purpose, label].join('|');
    const entry = qboUsage.pending.get(key) || { month: qboUsage.month, connectionId, purpose, label, calls: 0, rejected: 0 };
    entry.calls += 1;
    if (rejected) entry.rejected += 1;
    else qboUsage.used += 1;
    qboUsage.pending.set(key, entry);
    if (!qboUsage.timer) {
      qboUsage.timer = setTimeout(() => {
        qboUsage.timer = null;
        try { flushQboUsage(); } catch (err) { console.warn('[QBO] API usage meter flush failed:', err.message); }
      }, QBO_USAGE_FLUSH_MS);
      qboUsage.timer.unref?.();
    }
  } catch (err) {
    console.warn('[QBO] API usage meter failed:', err.message);
  }
}

function flushQboUsage() {
  if (!qboUsage.pending.size || !qboUsage.db) return;
  const entries = Array.from(qboUsage.pending.values());
  qboUsage.pending.clear();
  const upsert = qboUsage.db.prepare(`
    INSERT INTO quickbooks_api_usage (month, connection_id, purpose, label, calls, rejected, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(month, connection_id, purpose, label) DO UPDATE SET
      calls = calls + excluded.calls,
      rejected = rejected + excluded.rejected,
      updated_at = excluded.updated_at
  `);
  qboUsage.db.transaction(rows => {
    for (const row of rows) upsert.run(row.month, row.connectionId, row.purpose, row.label, row.calls, row.rejected);
  })(entries);
}

// normal: on pace for the month. economy: ahead of pace, so Finance Tracker / Bank Draws
// reads and the Finance-hub checks slow down. reserve: 90% of the budget is gone, so only
// bills, the payment queue and the Invoice Center still reach QuickBooks.
function qboBudgetState(db = qboUsage.db) {
  try { qboUsageReady(db); } catch (_) { /* the counts below are then this process's own */ }
  const budget = qboMonthlyBudget();
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const elapsed = Math.max((now.getTime() - monthStart) / (monthEnd - monthStart), 0.001);
  const used = qboUsage.used;
  const onPace = budget * elapsed;
  const level = used >= budget * 0.9 ? 'reserve' : used > onPace + budget * 0.02 ? 'economy' : 'normal';
  return {
    month: qboUsage.month || now.toISOString().slice(0, 7),
    budget,
    used,
    on_pace: Math.round(onPace),
    projected_month_end: Math.round(used / elapsed),
    level,
  };
}

function qboBudgetFactor(kind, level = qboBudgetState().level) {
  return QBO_BUDGET_FACTORS[kind]?.[level] ?? 1;
}

// The background timers keep their base interval; at a slower budget level a beat runs
// only every Nth tick (factor 0 = not at all). The 1 s slack only folds two timers that
// fire together into one run.
function qboBeatDue(name, baseMs, factor) {
  if (!factor) return false;
  const last = qboBeatLastRun.get(name) || 0;
  if (Date.now() - last < baseMs * (factor - 1) + 1000) return false;
  qboBeatLastRun.set(name, Date.now());
  return true;
}

function qboBudgetReservedError() {
  const err = new Error('QuickBooks report reads are paused for the rest of the month: BuildTrack has used 90% of its Intuit API budget (QBO_MONTHLY_CALL_BUDGET) and keeps the rest for bills.');
  err.statusCode = 429;
  err.code = 'QBO_BUDGET_RESERVED';
  return err;
}

function qboMonthlyBlockProbeMs() {
  return envIntervalMs(['QBO_MONTHLY_BLOCK_PROBE_MS'], QBO_MONTHLY_BLOCK_PROBE_DEFAULT_MS, 5 * 1000) || QBO_MONTHLY_BLOCK_PROBE_DEFAULT_MS;
}

// True while Intuit refuses reads and the next probe is not due yet.
function qboMonthlyBlockHolds() {
  return Boolean(qboMonthlyBlock && Date.now() - qboMonthlyBlock.last_probe_at < qboMonthlyBlockProbeMs());
}

function isQboMonthlyLimitAnswer(status, text) {
  return status === 429 && /monthly limit|Block All CorePlus/i.test(String(text || ''));
}

function qboMonthlyLimitError() {
  const err = new Error("QuickBooks is paused: Intuit's monthly API allowance for this app is used up (free Builder plan, 500,000 reads a month). BuildTrack resumes by itself as soon as Intuit lifts the block - when the allowance resets with the new month, or at once if the plan is upgraded.");
  err.statusCode = 429;
  err.code = 'QBO_MONTHLY_LIMIT';
  return err;
}

function markQboRealmChanged(realmId) {
  if (realmId) realmChangedAt.set(String(realmId), Date.now());
}

function qboReadCacheMaxAgeMs(path) {
  // A statement whose period ended before this year changes only through back-dated
  // entries, and a change check reports those too.
  const end = /[?&]end_date=(\d{4})-/.exec(path);
  if (end && Number(end[1]) < new Date().getUTCFullYear()) return QBO_READ_CACHE_CLOSED_PERIOD_MAX_AGE_MS;
  return envIntervalMs(['QBO_READ_CACHE_MAX_AGE_MS'], QBO_READ_CACHE_MAX_AGE_DEFAULT_MS, 60 * 1000) || QBO_READ_CACHE_MAX_AGE_DEFAULT_MS;
}

function readQboCache(key, realmId, path, level) {
  const entry = qboReadCache.get(key);
  if (!entry) return null;
  const age = Date.now() - entry.at;
  const changed = (realmChangedAt.get(String(realmId)) || 0) >= entry.at;
  const fresh = level === 'reserve'
    || (level === 'economy' && age < QBO_READ_CACHE_ECONOMY_FLOOR_MS)
    || (!changed && age < qboReadCacheMaxAgeMs(path) * (level === 'economy' ? 4 : 1));
  if (!fresh) return null;
  qboReadCache.delete(key);
  qboReadCache.set(key, entry);
  const purpose = qboPurpose();
  qboUsage.cacheHits[purpose] = (qboUsage.cacheHits[purpose] || 0) + 1;
  return JSON.parse(entry.text);
}

// `at` is when the request was SENT, so a change seen while it was in flight still counts.
function writeQboCache(key, text, at) {
  const old = qboReadCache.get(key);
  if (old) {
    qboReadCacheChars -= old.text.length;
    qboReadCache.delete(key);
  }
  if (text.length > QBO_READ_CACHE_MAX_CHARS / 4) return;
  qboReadCache.set(key, { text, at });
  qboReadCacheChars += text.length;
  for (const [oldestKey, oldest] of qboReadCache) {
    if (qboReadCacheChars <= QBO_READ_CACHE_MAX_CHARS) break;
    qboReadCache.delete(oldestKey);
    qboReadCacheChars -= oldest.text.length;
  }
}

function qboApiUsageSummary(db) {
  try {
    qboUsageReady(db);
    flushQboUsage();
    const state = qboBudgetState(db);
    const grouped = column => db.prepare(`
      SELECT ${column} AS name, SUM(calls) AS calls, SUM(rejected) AS rejected
      FROM quickbooks_api_usage
      WHERE month = ?
      GROUP BY ${column}
      ORDER BY calls DESC
    `).all(state.month);
    return {
      ...state,
      intuit_monthly_limit: 500000,
      by_purpose: grouped('purpose'),
      by_company: grouped('connection_id'),
      cache: { entries: qboReadCache.size, chars: qboReadCacheChars, hits: { ...qboUsage.cacheHits } },
      monthly_limit_block: qboMonthlyBlock
        ? { since: qboMonthlyBlock.since, probes: qboMonthlyBlock.probes, probe_interval_ms: qboMonthlyBlockProbeMs() }
        : null,
    };
  } catch (err) {
    return { error: err.message };
  }
}

// Every QuickBooks read goes through here. Inside withQboPurpose(..., { cache: true })
// (Finance Tracker, Finance-hub companies, Bank Draws) an answer is reused until a change
// check sees that company change, and identical reads in flight share one request.
async function qboRequest(db, connection, path) {
  const context = qboContext.getStore();
  const level = qboBudgetState(db).level;
  if (!context?.cache) {
    if (level === 'reserve' && QBO_DEFERRABLE_PURPOSES.has(context?.purpose)) throw qboBudgetReservedError();
    return qboRequestLive(db, connection, path);
  }
  const key = `${connection.realm_id}|${path}`;
  const cached = readQboCache(key, connection.realm_id, path, level);
  if (cached) return cached;
  if (!qboReadInFlight.has(key)) {
    if (level === 'reserve') throw qboBudgetReservedError();
    const sentAt = Date.now();
    const request = qboRequestLive(db, connection, path).then(payload => {
      const text = JSON.stringify(payload);
      writeQboCache(key, text, sentAt);
      return text;
    });
    qboReadInFlight.set(key, request);
    request.catch(() => null).finally(() => qboReadInFlight.delete(key));
  }
  return JSON.parse(await qboReadInFlight.get(key));
}

async function qboRequestLive(db, connection, path) {
  const separator = path.includes('?') ? '&' : '?';
  const url = `${qboApiBase(connection.environment)}${path}${separator}minorversion=${MINOR_VERSION}`;
  const timeoutMs = qboRequestTimeoutMs(path);
  for (let attempt = 0; ; attempt += 1) {
    // While Intuit refuses reads for the month, one call per probe interval tests whether
    // the block lifted; every other call fails at once instead of joining a retry storm.
    if (qboMonthlyBlock) {
      if (qboMonthlyBlockHolds()) throw qboMonthlyLimitError();
      qboMonthlyBlock.last_probe_at = Date.now();
      qboMonthlyBlock.probes += 1;
    }
    // Per attempt: a 429 backoff can outlast the token's last minute.
    const accessToken = await refreshAccessToken(db, connection);
    const release = await acquireQboRequestSlot(connection.realm_id);
    let response;
    let text = '';
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (err) {
      recordQboCall(db, connection, path); // a call that timed out may still have counted
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        const timeoutErr = new Error(`QuickBooks did not answer the ${qboRequestLabel(path)} within ${Math.round(timeoutMs / 1000)} s`);
        timeoutErr.statusCode = 504;
        throw timeoutErr;
      }
      throw err;
    } finally {
      release();
    }
    if (isQboMonthlyLimitAnswer(response.status, text)) {
      // Retrying cannot help until Intuit lifts the block.
      recordQboCall(db, connection, path, { rejected: true });
      if (!qboMonthlyBlock) {
        qboMonthlyBlock = { since: new Date().toISOString(), last_probe_at: Date.now(), probes: 0 };
        console.warn(`[QBO] Intuit's monthly API allowance is used up (Builder plan): QuickBooks calls paused, one probe every ${Math.round(qboMonthlyBlockProbeMs() / 1000)} s.`);
      }
      qboMonthlyBlock.last_probe_at = Date.now();
      throw qboMonthlyLimitError();
    }
    recordQboCall(db, connection, path, { rejected: response.status === 429 });
    if (qboMonthlyBlock && response.status !== 429) {
      console.log(`[QBO] Intuit's monthly API allowance is available again: QuickBooks calls resumed (paused since ${qboMonthlyBlock.since}).`);
      qboMonthlyBlock = null;
    }
    if (response.status === 429 && attempt < QBO_RATE_LIMIT_RETRIES) {
      const waitMs = qboRetryDelayMs(response, attempt);
      console.warn(`[QBO] QuickBooks rate limit (429) on the ${qboRequestLabel(path)}; retrying in ${Math.round(waitMs / 1000)} s`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      continue;
    }
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
}

async function qboQuery(db, connection, query) {
  return qboRequest(db, connection, `/v3/company/${encodeURIComponent(connection.realm_id)}/query?query=${encodeURIComponent(query)}`);
}

async function fetchAllQboEntitiesWhere(db, connection, entityName, whereClause = '') {
  const rows = [];
  let start = 1;
  const pageSize = 1000;
  while (start <= 10000) {
    const where = whereClause ? ` WHERE ${whereClause}` : '';
    const payload = await qboQuery(db, connection, `SELECT * FROM ${entityName}${where} STARTPOSITION ${start} MAXRESULTS ${pageSize}`);
    const page = payload?.QueryResponse?.[entityName] || [];
    rows.push(...page);
    if (page.length < pageSize) break;
    start += page.length;
  }
  return rows;
}

async function fetchAllQboEntities(db, connection, entityName) {
  return fetchAllQboEntitiesWhere(db, connection, entityName);
}

async function fetchAllQboVendors(db, connection) {
  try {
    return await fetchAllQboEntitiesWhere(db, connection, 'Vendor', 'Active IN (true, false)');
  } catch (err) {
    console.warn('[QBO] Vendor all-active-state query failed, retrying active Vendor query:', err.message);
    return fetchAllQboEntities(db, connection, 'Vendor');
  }
}

async function fetchCompanyName(db, connection) {
  try {
    const payload = await qboRequest(db, connection, `/v3/company/${encodeURIComponent(connection.realm_id)}/companyinfo/${encodeURIComponent(connection.realm_id)}`);
    return payload?.CompanyInfo?.CompanyName || payload?.CompanyInfo?.LegalName || null;
  } catch (err) {
    return null;
  }
}

function qboText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || null;
}

function qboEmail(value) {
  return qboText(value?.Address || value?.address || value);
}

function qboPhone(value) {
  return qboText(value?.FreeFormNumber || value?.freeFormNumber || value);
}

function qboWeb(value) {
  return qboText(value?.URI || value?.uri || value?.Address || value);
}

function qboBoolean(value) {
  return value === true || String(value || '').toLowerCase() === 'true' ? 1 : 0;
}

function qboTaxIdentifierLast4(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function qboAddressParts(address = {}) {
  return {
    line1: qboText(address.Line1),
    line2: qboText(address.Line2),
    line3: qboText(address.Line3),
    city: qboText(address.City),
    state: qboText(address.CountrySubDivisionCode),
    postalCode: qboText(address.PostalCode),
    country: qboText(address.Country),
  };
}

function qboAddressText(address = {}) {
  const parts = qboAddressParts(address);
  const cityStateZip = [
    parts.city,
    [parts.state, parts.postalCode].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ');
  return [parts.line1, parts.line2, parts.line3, cityStateZip, parts.country].filter(Boolean).join('\n') || null;
}

function qboPersonName(vendor = {}) {
  return [vendor.Title, vendor.GivenName, vendor.MiddleName, vendor.FamilyName, vendor.Suffix]
    .map(qboText)
    .filter(Boolean)
    .join(' ') || null;
}

function qboVendorDisplayName(vendor = {}) {
  return qboText(vendor.DisplayName)
    || qboText(vendor.CompanyName)
    || qboText(vendor.PrintOnCheckName)
    || qboPersonName(vendor)
    || (vendor.Id ? `QuickBooks Vendor ${vendor.Id}` : null);
}

function redactQuickBooksVendorForStorage(value) {
  if (Array.isArray(value)) return value.map(redactQuickBooksVendorForStorage);
  if (!value || typeof value !== 'object') return value;
  const redacted = {};
  for (const [key, child] of Object.entries(value)) {
    if (/^(taxidentifier|taxid|ssn|tin)$/i.test(key)) {
      redacted[key] = '[redacted]';
      continue;
    }
    redacted[key] = redactQuickBooksVendorForStorage(child);
  }
  return redacted;
}

function normalizeQuickBooksVendor(vendor, connection) {
  const billingParts = qboAddressParts(vendor?.BillAddr || {});
  const displayName = qboVendorDisplayName(vendor);
  const companyName = qboText(vendor?.CompanyName);
  const printOnCheckName = qboText(vendor?.PrintOnCheckName);
  const contactName = qboPersonName(vendor);
  const primaryPhone = qboPhone(vendor?.PrimaryPhone);
  const primaryEmail = qboEmail(vendor?.PrimaryEmailAddr);
  return {
    qbo_id: vendor?.Id ? String(vendor.Id) : null,
    realm_id: connection.realm_id,
    environment: connection.environment,
    sync_token: vendor?.SyncToken || null,
    display_name: displayName,
    company_name: companyName,
    print_on_check_name: printOnCheckName,
    given_name: qboText(vendor?.GivenName),
    middle_name: qboText(vendor?.MiddleName),
    family_name: qboText(vendor?.FamilyName),
    suffix: qboText(vendor?.Suffix),
    contact_name: contactName,
    primary_email: primaryEmail,
    primary_phone: primaryPhone,
    mobile_phone: qboPhone(vendor?.Mobile),
    alternate_phone: qboPhone(vendor?.AlternatePhone),
    fax: qboPhone(vendor?.Fax),
    website: qboWeb(vendor?.WebAddr),
    bill_addr_text: qboAddressText(vendor?.BillAddr || {}),
    bill_addr_line1: billingParts.line1,
    bill_addr_line2: billingParts.line2,
    bill_addr_line3: billingParts.line3,
    bill_addr_city: billingParts.city,
    bill_addr_state: billingParts.state,
    bill_addr_postal_code: billingParts.postalCode,
    bill_addr_country: billingParts.country,
    acct_num: qboText(vendor?.AcctNum),
    vendor_1099: qboBoolean(vendor?.Vendor1099),
    tax_identifier_last4: qboTaxIdentifierLast4(vendor?.TaxIdentifier || vendor?.TaxId),
    balance: normalizeMoney(vendor?.Balance),
    active: vendor?.Active === false ? 0 : 1,
    raw_json: JSON.stringify(redactQuickBooksVendorForStorage(vendor || {})),
    qbo_created_at: metadataTime(vendor, 'CreateTime'),
    qbo_updated_at: metadataTime(vendor, 'LastUpdatedTime'),
  };
}

function quickBooksVendorNameCandidates(info) {
  const names = [
    info.display_name,
    info.company_name,
    info.print_on_check_name,
    info.contact_name,
  ].map(qboText).filter(Boolean);
  return Array.from(new Map(names.map(name => [normalizeMatchText(name), name])).values());
}

function findContractorProfileForQuickBooksVendor(db, info) {
  const byQboId = db.prepare(`
    SELECT *
    FROM contractor_profiles
    WHERE quickbooks_vendor_id = ?
    LIMIT 1
  `).get(info.qbo_id);
  if (byQboId) return byQboId;

  const names = quickBooksVendorNameCandidates(info).map(name => name.toLowerCase()).filter(Boolean);
  if (!names.length) return null;
  const placeholders = names.map(() => '?').join(',');
  return db.prepare(`
    SELECT *
    FROM contractor_profiles
    WHERE lower(trim(COALESCE(vendor_name, ''))) IN (${placeholders})
       OR lower(trim(COALESCE(quickbooks_display_name, ''))) IN (${placeholders})
    ORDER BY
      CASE WHEN source = 'quickbooks_vendor' THEN 0 ELSE 1 END,
      datetime(updated_at) DESC,
      vendor_name
    LIMIT 1
  `).get(...names, ...names);
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
  const customerRef = billLineCustomerRef(line);
  const lineScopedBill = { ...bill, Line: [line] };
  const lineHasScopedMatchHint = Boolean(
    classRef?.value ||
    classRef?.name ||
    customerRef?.value ||
    customerRef?.name
  );
  const project = findProjectForBill(
    db,
    lineScopedBill,
    lineHasScopedMatchHint ? null : invoice,
    classRef
  );
  return { project, classRef, lineHasScopedMatchHint };
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
  // BuildTrack's own number (NUD-1557) is unique; a vendor's invoice number is only
  // unique per vendor (Snyders #2055 is not ELT #2055), so it must agree on the vendor.
  const ownNumber = candidates.find(row => doc && normalizeDoc(row.invoice_number) === doc);
  if (ownNumber) return ownNumber;
  const exactDoc = candidates.find(row => (
    (normalizeDoc(row.external_invoice_number) === doc || normalizeDoc(row.quickbooks_doc_number) === doc)
    && invoiceVendorAgrees(db, row, bill)
  ));
  if (exactDoc) return exactDoc;
  const sameVendor = candidates.filter(row => invoiceVendorAgrees(db, row, bill));
  return sameVendor.length === 1 && candidates.length === 1 ? sameVendor[0] : null;
}

// Does the BuildTrack invoice name the same vendor as the QuickBooks bill? Invoices
// with no vendor on them (contractor app invoices) cannot disagree.
function invoiceVendorAgrees(db, invoice, bill) {
  const billVendorId = String(bill.VendorRef?.value || '').trim();
  const billKey = looseVendorKey(bill.VendorRef?.name);
  const names = [invoice.vendor_name, invoice.quickbooks_vendor_name];
  if (invoice.quickbooks_vendor_id && billVendorId && String(invoice.quickbooks_vendor_id) === billVendorId) return true;
  if (invoice.vendor_profile_id) {
    const profile = db.prepare(`
      SELECT vendor_name, quickbooks_vendor_id, quickbooks_display_name, quickbooks_company_name, quickbooks_print_on_check_name
      FROM contractor_profiles WHERE id = ?
    `).get(invoice.vendor_profile_id);
    if (profile) {
      if (profile.quickbooks_vendor_id && billVendorId && String(profile.quickbooks_vendor_id) === billVendorId) return true;
      names.push(profile.vendor_name, profile.quickbooks_display_name, profile.quickbooks_company_name, profile.quickbooks_print_on_check_name);
    }
  }
  const keys = names.map(looseVendorKey).filter(Boolean);
  if (!keys.length || !billKey) return true;
  return keys.includes(billKey);
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

function upsertQuickBooksVendors(db, connection, vendors) {
  const upsertVendor = db.prepare(`
    INSERT INTO quickbooks_vendors (
      qbo_id, realm_id, environment, sync_token, display_name, company_name, print_on_check_name,
      given_name, middle_name, family_name, suffix, primary_email, primary_phone, mobile_phone,
      alternate_phone, fax, website, bill_addr_text, bill_addr_line1, bill_addr_line2, bill_addr_line3,
      bill_addr_city, bill_addr_state, bill_addr_postal_code, bill_addr_country, acct_num,
      vendor_1099, tax_identifier_last4, balance, active, raw_json, qbo_created_at, qbo_updated_at,
      last_seen_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(qbo_id) DO UPDATE SET
      realm_id = excluded.realm_id,
      environment = excluded.environment,
      sync_token = excluded.sync_token,
      display_name = excluded.display_name,
      company_name = excluded.company_name,
      print_on_check_name = excluded.print_on_check_name,
      given_name = excluded.given_name,
      middle_name = excluded.middle_name,
      family_name = excluded.family_name,
      suffix = excluded.suffix,
      primary_email = excluded.primary_email,
      primary_phone = excluded.primary_phone,
      mobile_phone = excluded.mobile_phone,
      alternate_phone = excluded.alternate_phone,
      fax = excluded.fax,
      website = excluded.website,
      bill_addr_text = excluded.bill_addr_text,
      bill_addr_line1 = excluded.bill_addr_line1,
      bill_addr_line2 = excluded.bill_addr_line2,
      bill_addr_line3 = excluded.bill_addr_line3,
      bill_addr_city = excluded.bill_addr_city,
      bill_addr_state = excluded.bill_addr_state,
      bill_addr_postal_code = excluded.bill_addr_postal_code,
      bill_addr_country = excluded.bill_addr_country,
      acct_num = excluded.acct_num,
      vendor_1099 = excluded.vendor_1099,
      tax_identifier_last4 = excluded.tax_identifier_last4,
      balance = excluded.balance,
      active = excluded.active,
      raw_json = excluded.raw_json,
      qbo_created_at = excluded.qbo_created_at,
      qbo_updated_at = excluded.qbo_updated_at,
      last_seen_at = datetime('now'),
      updated_at = datetime('now')
  `);
  const insertProfile = db.prepare(`
    INSERT INTO contractor_profiles (
      id, vendor_name, contact_name, email, phone, billing_address, account_number, contractor_status,
      quickbooks_vendor_id, quickbooks_display_name, quickbooks_company_name, quickbooks_print_on_check_name,
      quickbooks_primary_email, quickbooks_primary_phone, quickbooks_bill_addr, quickbooks_account_number,
      quickbooks_vendor_1099, quickbooks_tax_identifier_last4, quickbooks_balance, quickbooks_active,
      quickbooks_synced_at, source, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'quickbooks_vendor', datetime('now'), datetime('now'))
  `);
  const updateProfile = db.prepare(`
    UPDATE contractor_profiles
    SET vendor_name = CASE
          WHEN COALESCE(source, '') = 'quickbooks_vendor' OR trim(COALESCE(vendor_name, '')) = '' THEN ?
          ELSE vendor_name
        END,
        contact_name = COALESCE(NULLIF(contact_name, ''), ?),
        email = COALESCE(NULLIF(email, ''), ?),
        phone = COALESCE(NULLIF(phone, ''), ?),
        billing_address = COALESCE(NULLIF(billing_address, ''), ?),
        account_number = COALESCE(NULLIF(account_number, ''), ?),
        quickbooks_vendor_id = ?,
        quickbooks_display_name = ?,
        quickbooks_company_name = ?,
        quickbooks_print_on_check_name = ?,
        quickbooks_primary_email = ?,
        quickbooks_primary_phone = ?,
        quickbooks_bill_addr = ?,
        quickbooks_account_number = ?,
        quickbooks_vendor_1099 = ?,
        quickbooks_tax_identifier_last4 = ?,
        quickbooks_balance = ?,
        quickbooks_active = ?,
        quickbooks_synced_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `);

  const suppressionStmt = db.prepare('SELECT 1 FROM quickbooks_vendor_suppressions WHERE qbo_id = ?');
  let mirrored = 0;
  let createdProfiles = 0;
  let updatedProfiles = 0;
  let suppressedProfiles = 0;
  let skipped = 0;
  const write = db.transaction(() => {
    for (const vendor of vendors || []) {
      const info = normalizeQuickBooksVendor(vendor, connection);
      if (!info.qbo_id || !info.display_name) {
        skipped += 1;
        continue;
      }

      upsertVendor.run(
        info.qbo_id,
        info.realm_id,
        info.environment,
        info.sync_token,
        info.display_name,
        info.company_name,
        info.print_on_check_name,
        info.given_name,
        info.middle_name,
        info.family_name,
        info.suffix,
        info.primary_email,
        info.primary_phone,
        info.mobile_phone,
        info.alternate_phone,
        info.fax,
        info.website,
        info.bill_addr_text,
        info.bill_addr_line1,
        info.bill_addr_line2,
        info.bill_addr_line3,
        info.bill_addr_city,
        info.bill_addr_state,
        info.bill_addr_postal_code,
        info.bill_addr_country,
        info.acct_num,
        info.vendor_1099,
        info.tax_identifier_last4,
        info.balance,
        info.active,
        info.raw_json,
        info.qbo_created_at,
        info.qbo_updated_at
      );
      mirrored += 1;

      if (suppressionStmt.get(String(info.qbo_id))) {
        // A manager deleted this vendor from the directory. Keep the raw QBO
        // mirror row (used for bill matching) but do NOT recreate or refresh a
        // contractor profile for it - this is what makes the delete permanent.
        suppressedProfiles += 1;
        continue;
      }

      const profile = findContractorProfileForQuickBooksVendor(db, info);
      if (profile) {
        updateProfile.run(
          info.display_name,
          info.contact_name,
          info.primary_email,
          info.primary_phone,
          info.bill_addr_text,
          info.acct_num,
          info.qbo_id,
          info.display_name,
          info.company_name,
          info.print_on_check_name,
          info.primary_email,
          info.primary_phone,
          info.bill_addr_text,
          info.acct_num,
          info.vendor_1099,
          info.tax_identifier_last4,
          info.balance,
          info.active,
          profile.id
        );
        updatedProfiles += 1;
      } else {
        insertProfile.run(
          uuidv4(),
          info.display_name,
          info.contact_name,
          info.primary_email,
          info.primary_phone,
          info.bill_addr_text,
          info.acct_num,
          info.qbo_id,
          info.display_name,
          info.company_name,
          info.print_on_check_name,
          info.primary_email,
          info.primary_phone,
          info.bill_addr_text,
          info.acct_num,
          info.vendor_1099,
          info.tax_identifier_last4,
          info.balance,
          info.active
        );
        createdProfiles += 1;
      }
    }
  });

  write();
  return { mirrored, profiles_created: createdProfiles, profiles_updated: updatedProfiles, profiles_suppressed: suppressedProfiles, skipped };
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
      payment_approval_status = CASE
        WHEN quickbooks_bills.payment_approval_status = '${PAYMENT_APPROVAL_DELETED_STATUS}'
          AND excluded.payment_status = 'paid'
        THEN '${PAYMENT_APPROVAL_DEFAULT_STATUS}'
        ELSE quickbooks_bills.payment_approval_status
      END,
      payment_approved_at = CASE
        WHEN quickbooks_bills.payment_approval_status = '${PAYMENT_APPROVAL_DELETED_STATUS}'
          AND excluded.payment_status = 'paid'
        THEN NULL
        ELSE quickbooks_bills.payment_approved_at
      END,
      payment_approved_by = CASE
        WHEN quickbooks_bills.payment_approval_status = '${PAYMENT_APPROVAL_DELETED_STATUS}'
          AND excluded.payment_status = 'paid'
        THEN NULL
        ELSE quickbooks_bills.payment_approved_by
      END,
      payment_run_date = CASE
        WHEN quickbooks_bills.payment_approval_status = '${PAYMENT_APPROVAL_DELETED_STATUS}'
          AND excluded.payment_status = 'paid'
        THEN NULL
        ELSE quickbooks_bills.payment_run_date
      END,
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
    SELECT payment_approval_status, payment_status, balance, sync_token
    FROM quickbooks_bills
    WHERE qbo_id = ?
    LIMIT 1
  `);
  const getExistingPayment = db.prepare('SELECT sync_token FROM quickbooks_bill_payments WHERE qbo_id = ? LIMIT 1');
  const markBillReceiptHistorical = db.prepare(`
    UPDATE quickbooks_bills
    SET vendor_receipt_notify_status = 'historical'
    WHERE qbo_id = ? AND vendor_receipt_notify_status IS NULL
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
          WHEN status = 'paid' AND ? != 'paid' AND ? != '${PAYMENT_APPROVAL_PAID_STATUS}' THEN 'approved'
          ELSE status
        END,
        updated_at = datetime('now')
    WHERE id = ?
  `);

  let matched = 0;
  let ignored = 0;
  let markedPaidFromQueue = 0;
  // What actually differs from BuildTrack's copy (new rows, a new SyncToken, or a
  // balance/status change). Re-writing an identical bill is not a change.
  let changedBills = 0;
  let changedPayments = 0;
  let nowPaid = 0;
  const paidFromQueue = [];
  const newBills = [];
  const write = db.transaction(() => {
    if (deleteExcludedBills) deleteExcludedBills.run(...excludedVendors);

    for (const payment of payments) {
      const existingPayment = getExistingPayment.get(String(payment.Id));
      if (!existingPayment || String(existingPayment.sync_token || '') !== String(payment.SyncToken || '')) changedPayments += 1;
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
      const deletedFromBuildTrack = paymentApprovalStatusAtSync === PAYMENT_APPROVAL_DELETED_STATUS;
      const restoreDeletedPaidBill = shouldRestoreDeletedQuickBooksBill(paymentApprovalStatusAtSync, paymentStatus);
      if (
        !existingBillApproval
        || existingBillApproval.payment_status !== paymentStatus
        || normalizeMoney(existingBillApproval.balance) !== normalizeMoney(bill.Balance)
        || String(existingBillApproval.sync_token || '') !== String(bill.SyncToken || '')
      ) {
        changedBills += 1;
        if (paymentStatus === 'paid' && existingBillApproval && existingBillApproval.payment_status !== 'paid') nowPaid += 1;
      }
      const classRef = primaryBillClassRef(bill);
      const project = findProjectForBill(db, bill, invoice, classRef);
      if (project && classRef) rememberProjectClass(db, project, classRef);
      if (invoice) matched += 1;
      // A Friday-queue bill that QuickBooks now shows paid leaves the queue on this
      // write. Counted for every such bill (it used to count only the rare bills with
      // a matched BuildTrack invoice, so the sync log always said 0).
      if (
        paymentStatus === 'paid'
        && paymentApprovalStatusAtSync === PAYMENT_APPROVAL_STATUS
        && existingBillApproval?.payment_status !== 'paid'
      ) {
        markedPaidFromQueue += 1;
        paidFromQueue.push({
          qbo_id: String(bill.Id),
          vendor_name: bill.VendorRef?.name || null,
          total_amt: normalizeMoney(bill.TotalAmt),
        });
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
      ensureBillHasInvoiceNumber(db, String(bill.Id), invoice?.invoice_number || null);
      if (!existingBillApproval) {
        // A row can be absent for reasons other than "the office just entered this bill"
        // (rebuilt database, vendor removed from the exclusion list, restored backup), so
        // "new" is decided by provenance: unpaid AND recently created in QuickBooks.
        // Everything else is stamped historical so it can never be claimed for an email.
        const createdMs = Date.parse(metadataTime(bill, 'CreateTime') || '');
        const genuinelyNew = paymentStatus !== 'paid'
          && Number.isFinite(createdMs)
          && (Date.now() - createdMs) <= vendorReceiptFreshWindowMs();
        if (genuinelyNew) {
          newBills.push({ qbo_id: String(bill.Id), vendor_name: bill.VendorRef?.name || null });
        } else {
          markBillReceiptHistorical.run(String(bill.Id));
        }
      }
      if (deletedFromBuildTrack && !restoreDeletedPaidBill) {
        deleteBillLines.run(String(bill.Id));
        continue;
      }
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
          paymentApprovalStatusAtSync,
          invoice.id
        );
      }

      deleteBillLines.run(String(bill.Id));
      (bill.Line || []).forEach((line, index) => {
        const { id, qboLineId } = stableBillLineId(bill, line, index);
        const lineNum = Number(line?.LineNum || index + 1);
        const categoryRef = billLineCategoryRef(line);
        const customerRef = billLineCustomerRef(line);
        const {
          project: lineProject,
          classRef: lineClassRef,
          lineHasScopedMatchHint,
        } = findProjectForBillLine(db, bill, line, invoice);
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
          lineProject?.id || (!lineHasScopedMatchHint ? invoice?.project_id : null),
          JSON.stringify(line || {})
        );
      });
    }
  });

  write();
  if (changedBills || changedPayments) {
    lastQuickBooksChangeAt = new Date().toISOString();
    // New or edited bills may carry a new invoice PDF: look for it shortly (a full sync
    // in progress clears the request by scanning itself).
    if (changedBills) requestBillPdfScan();
  }
  return { matched, ignored, markedPaidFromQueue, paidFromQueue, newBills, changedBills, changedPayments, nowPaid };
}

function reconcileMissingQuickBooksBills(db, connection, bills) {
  // This runs only after a complete, successful QBO Bill query. Transactions
  // absent from that authoritative result were deleted/replaced in QBO. Keep
  // their rows and attachments for auditability, but remove them from active
  // BuildTrack balances and payment queues.
  const localBills = db.prepare(`
    SELECT qbo_id, vendor_name, total_amt, balance, payment_status, payment_approval_status, project_id
    FROM quickbooks_bills
    WHERE realm_id = ?
      AND environment = ?
      AND COALESCE(payment_approval_status, ?) != ?
  `).all(
    connection.realm_id,
    connection.environment,
    PAYMENT_APPROVAL_DEFAULT_STATUS,
    PAYMENT_APPROVAL_DELETED_STATUS
  );
  const missingIds = missingQuickBooksBillIds(localBills, bills);
  if (!missingIds.length) return { count: 0, bills: [] };

  const localById = new Map(localBills.map(bill => [String(bill.qbo_id), bill]));
  const updateMissing = db.prepare(`
    UPDATE quickbooks_bills
    SET payment_approval_status = ?,
        payment_approved_at = NULL,
        payment_approved_by = NULL,
        payment_run_date = NULL,
        payment_approval_notified_at = NULL,
        payment_approval_notified_by = NULL,
        updated_at = datetime('now')
    WHERE qbo_id = ?
  `);
  db.transaction(() => {
    for (const qboId of missingIds) updateMissing.run(PAYMENT_APPROVAL_DELETED_STATUS, qboId);
  })();

  return {
    count: missingIds.length,
    bills: missingIds.slice(0, 25).map(qboId => {
      const bill = localById.get(qboId) || {};
      return {
        qbo_id: qboId,
        vendor_name: bill.vendor_name || null,
        total_amt: normalizeMoney(bill.total_amt),
        balance: normalizeMoney(bill.balance),
        prior_payment_status: bill.payment_status || null,
        prior_approval_status: bill.payment_approval_status || PAYMENT_APPROVAL_DEFAULT_STATUS,
        project_id: bill.project_id || null,
      };
    }),
  };
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
  const where = [`COALESCE(qb.payment_approval_status, '${PAYMENT_APPROVAL_DEFAULT_STATUS}') != '${PAYMENT_APPROVAL_DELETED_STATUS}'`];
  if (excludedVendors.length) {
    where.push(`lower(trim(COALESCE(qb.vendor_name, ''))) NOT IN (${excludedVendorPlaceholders})`);
  }
  const billStats = db.prepare(`
    SELECT
      COUNT(*) as bill_count,
      SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) as paid_count,
      SUM(CASE
        WHEN payment_status != 'paid'
          AND COALESCE(payment_approval_status, '${PAYMENT_APPROVAL_DEFAULT_STATUS}') NOT IN ('${PAYMENT_APPROVAL_STATUS}', '${PAYMENT_APPROVAL_PAID_STATUS}')
        THEN 1 ELSE 0 END) as open_count,
      ROUND(COALESCE(SUM(CASE
        WHEN payment_status != 'paid'
          AND COALESCE(payment_approval_status, '${PAYMENT_APPROVAL_DEFAULT_STATUS}') NOT IN ('${PAYMENT_APPROVAL_STATUS}', '${PAYMENT_APPROVAL_PAID_STATUS}')
        THEN balance ELSE 0 END), 0), 2) as open_balance,
      SUM(CASE
        WHEN project_id IS NULL
          AND NOT ${splitLinesFullyMatchedSql('qb')}
          AND payment_status != 'paid'
          AND COALESCE(payment_approval_status, '${PAYMENT_APPROVAL_DEFAULT_STATUS}') NOT IN ('${PAYMENT_APPROVAL_STATUS}', '${PAYMENT_APPROVAL_PAID_STATUS}')
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
    WHERE ${where.join(' AND ')}
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
      qb.bt_invoice_number,
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
      qb.vendor_receipt_notify_status,
      qb.vendor_receipt_notified_at,
      qb.vendor_receipt_notified_email,
      qv.primary_email as vendor_email,
      qb.private_note,
      qb.matched_invoice_id,
      qb.project_id,
      qb.qbo_updated_at,
      qb.first_seen_at,
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
    LEFT JOIN quickbooks_vendors qv ON qv.qbo_id = qb.vendor_id
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
      invoice_pdf: quickBooksBillPdfSummary(db, row),
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
    invoice_number: invDisplay(row.bt_invoice_number || row.doc_number || row.qbo_id),
    external_invoice_number: invDisplay(row.bt_invoice_number || row.doc_number || row.qbo_id),
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

// ── Approval digest (2026-09-18, Mike's spec) ────────────────────────────────
// Approving a QuickBooks bill for pay used to email nobody: management only
// heard about it on the biweekly Friday 8am ET run, or when a human clicked
// "notify" on the Invoice Center. Approvals arrive in bursts (six inside
// sixteen minutes is a normal morning), so an email per approval would flood
// info@. Instead the timer restarts on every approval and fires once approving
// has been idle for QBO_APPROVAL_DIGEST_DELAY_MS, with
// QBO_APPROVAL_DIGEST_MAX_WAIT_MS capping how long a steady stream can defer
// it. One email per burst, naming every bill approved in that burst plus the
// whole approved-to-pay queue.
const APPROVAL_DIGEST_DEFAULT_DELAY_MS = 10 * 60 * 1000;
const APPROVAL_DIGEST_DEFAULT_MAX_WAIT_MS = 30 * 60 * 1000;
const APPROVAL_DIGEST_RECOVERY_WINDOW_HOURS = 2;

let approvalDigestTimer = null;
let approvalDigestFirstQueuedAt = null;
let approvalDigestSending = false;
const approvalDigestPending = new Map();

function approvalDigestEnabled() {
  // Inherits the Friday-queue kill switch on purpose: a blue-green green
  // container already sets that to stay silent during an overlap, and the
  // approval route can fire a digest even when no scheduler was started.
  if (process.env.QBO_PAYMENT_QUEUE_NOTIFY_ENABLED === 'false'
    || process.env.PAYMENT_QUEUE_NOTIFY_ENABLED === 'false') return false;
  return process.env.QBO_APPROVAL_DIGEST_ENABLED !== 'false';
}

function approvalDigestDelayMs() {
  const requested = Number(process.env.QBO_APPROVAL_DIGEST_DELAY_MS || APPROVAL_DIGEST_DEFAULT_DELAY_MS);
  if (!Number.isFinite(requested) || requested < 0) return APPROVAL_DIGEST_DEFAULT_DELAY_MS;
  return requested;
}

function approvalDigestMaxWaitMs() {
  const requested = Number(process.env.QBO_APPROVAL_DIGEST_MAX_WAIT_MS || APPROVAL_DIGEST_DEFAULT_MAX_WAIT_MS);
  const floor = approvalDigestDelayMs();
  if (!Number.isFinite(requested) || requested <= 0) return Math.max(APPROVAL_DIGEST_DEFAULT_MAX_WAIT_MS, floor);
  return Math.max(requested, floor);
}

function scheduleApprovalDigest() {
  if (approvalDigestTimer) clearTimeout(approvalDigestTimer);
  const now = Date.now();
  if (!approvalDigestFirstQueuedAt) approvalDigestFirstQueuedAt = now;
  const elapsed = now - approvalDigestFirstQueuedAt;
  const delay = Math.max(Math.min(approvalDigestDelayMs(), approvalDigestMaxWaitMs() - elapsed), 0);
  approvalDigestTimer = setTimeout(() => {
    approvalDigestTimer = null;
    flushApprovalDigest().catch(err => console.error('[QBO] Approval digest email failed:', err.message));
  }, delay);
  approvalDigestTimer.unref?.();
}

function queueApprovalDigest(bill, user) {
  if (!approvalDigestEnabled() || !bill?.qbo_id) return;
  approvalDigestPending.set(String(bill.qbo_id), {
    approver_id: user?.id || null,
    approver_name: user?.name || user?.email || 'BuildTrack',
  });
  scheduleApprovalDigest();
}

function dropApprovalDigestEntry(qboId) {
  approvalDigestPending.delete(String(qboId));
}

async function flushApprovalDigest() {
  if (approvalDigestSending) return;
  if (!approvalDigestPending.size) {
    approvalDigestFirstQueuedAt = null;
    return;
  }

  approvalDigestSending = true;
  // Claim the burst up front so approvals landing mid-send start a fresh
  // window instead of being swallowed by this one.
  const burst = new Map(approvalDigestPending);
  approvalDigestPending.clear();
  approvalDigestFirstQueuedAt = null;

  try {
    if (!isEmailConfigured()) {
      console.warn('[QBO] Approval digest skipped: email is not configured.');
      return;
    }
    const db = getDb();
    const rows = approvedPaymentQueueRows(db);
    const emailRows = paymentQueueEmailRows(rows);
    // Only announce bills still approved and unpaid at send time — an approval
    // reversed inside the debounce window must not reach management.
    const liveIds = new Set(rows.map(row => String(row.qbo_id)));
    const newlyApproved = emailRows.filter(row => burst.has(String(row.id)) && liveIds.has(String(row.id)));
    if (!newlyApproved.length) {
      console.log('[QBO] Approval digest skipped: nothing in the burst is still approved and unpaid.');
      return;
    }

    const approverNames = Array.from(new Set(
      Array.from(burst.values()).map(entry => entry.approver_name).filter(Boolean)
    ));
    const approvedBy = approverNames.length ? approverNames.join(', ') : 'BuildTrack';
    const actorId = Array.from(burst.values()).map(entry => entry.approver_id).find(Boolean)
      || paymentQueueAutomationUserId(db);

    await sendApprovedPayNotificationEmail({
      approvedInvoices: emailRows,
      newlyApproved,
      approvedBy,
    });

    markPaymentQueueRowsNotified(db, rows, actorId);
    const burstTotal = newlyApproved.reduce((sum, row) => sum + normalizeMoney(row.quickbooks_balance), 0);
    const queueTotal = paymentQueueTotal(rows);
    if (actorId) {
      logActivity({
        userId: actorId,
        action: 'quickbooks_payment_queue_approval_digest',
        entityType: 'quickbooks_payment_queue',
        entityId: new Date().toISOString().slice(0, 10),
        details: {
          approved_in_burst: newlyApproved.length,
          approved_in_burst_total: normalizeMoney(burstTotal),
          queue_bill_count: emailRows.length,
          queue_total_balance: normalizeMoney(queueTotal),
          approved_by: approvedBy,
          recipient: process.env.APPROVED_INVOICE_NOTIFY_EMAIL || 'info@newurbandev.com',
        },
      });
    }
    console.log(`[QBO] Approval digest email sent: ${newlyApproved.length} newly approved ($${normalizeMoney(burstTotal).toFixed(2)}), queue $${normalizeMoney(queueTotal).toFixed(2)}.`);
  } finally {
    approvalDigestSending = false;
    // Anything queued while the send was in flight gets its own window.
    if (approvalDigestPending.size) scheduleApprovalDigest();
  }
}

// A container restart drops the in-memory burst. Re-arm only for bills approved
// very recently and never notified, so a redeploy cannot replay weeks of
// already-handled approvals.
function recoverPendingApprovalDigest() {
  if (!approvalDigestEnabled()) return;
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT qb.qbo_id, qb.payment_approved_by, u.name AS approver_name, u.email AS approver_email
      FROM quickbooks_bills qb
      LEFT JOIN users u ON u.id = qb.payment_approved_by
      WHERE COALESCE(qb.payment_approval_status, '') = ?
        AND qb.payment_status != 'paid'
        AND qb.payment_approval_notified_at IS NULL
        AND qb.payment_approved_at IS NOT NULL
        AND julianday('now') - julianday(qb.payment_approved_at) <= ?
    `).all(PAYMENT_APPROVAL_STATUS, APPROVAL_DIGEST_RECOVERY_WINDOW_HOURS / 24);
    if (!rows.length) return;
    for (const row of rows) {
      approvalDigestPending.set(String(row.qbo_id), {
        approver_id: row.payment_approved_by || null,
        approver_name: row.approver_name || row.approver_email || 'BuildTrack',
      });
    }
    scheduleApprovalDigest();
    console.log(`[QBO] Approval digest re-armed after restart for ${rows.length} un-notified approval(s).`);
  } catch (err) {
    console.error('[QBO] Approval digest restart recovery failed:', err.message);
  }
}

function vendorReceiptEmailEnabled() {
  return process.env.QBO_VENDOR_RECEIPT_EMAIL_ENABLED !== 'false'
    && process.env.QUICKBOOKS_VENDOR_RECEIPT_EMAIL_ENABLED !== 'false';
}

function vendorReceiptEmailMaxPerSync() {
  const requested = Number.parseInt(process.env.QBO_VENDOR_RECEIPT_EMAIL_MAX_PER_SYNC || '20', 10);
  return Math.max(Number.isFinite(requested) ? requested : 20, 1);
}

function vendorReceiptFreshWindowMs() {
  const hours = Number.parseFloat(process.env.QBO_VENDOR_RECEIPT_FRESH_WINDOW_HOURS || '72');
  return Math.max(Number.isFinite(hours) ? hours : 72, 1) * 60 * 60 * 1000;
}

const VENDOR_RECEIPT_MAX_ATTEMPTS = 3;

function vendorReceiptStatusNote(status, vendorEmail) {
  switch (status) {
    case 'sent': return `contractor emailed at ${vendorEmail}`;
    case 'skipped_no_email': return 'NO VENDOR EMAIL ON FILE - add it in QuickBooks and the email sends on the next sync';
    case 'skipped_no_due_date': return 'NO DUE DATE SET - add it in QuickBooks and the email sends on the next sync';
    case 'skipped_already_paid': return 'bill already paid - pay-date email not needed';
    case 'skipped_stale': return 'due date already passed - pay-date email not sent';
    case 'failed': return 'CONTRACTOR EMAIL FAILED - retries on upcoming syncs';
    default: return 'contractor email skipped';
  }
}

let vendorReceiptNotifyRunning = false;

// Emails contractors their expected pay date (= QBO due date) for bills the office
// just entered in QuickBooks, and drops an activity row the whole team sees in the
// notification bell. The work queue is the DATABASE, not the sync pass that inserted
// the bill: every quickbooks_bills row with vendor_receipt_notify_status NULL (or a
// retryable 'failed') is a candidate, so crashes, SMTP outages, a missing vendor
// email, or the kill switch defer the email instead of silently losing it.
// Pre-launch and re-mirrored old bills are stamped 'historical' (schema backfill +
// the insert-time provenance check in upsertBillsAndPayments) and never qualify.
async function notifyNewQuickBooksBills(db, connection, { userId = null } = {}) {
  const summary = { candidates: 0, attempted: 0, sent: 0, skipped: 0, failed: 0, deferred: 0 };
  if (vendorReceiptNotifyRunning) return { ...summary, skipped_reason: 'already_running' };
  if (!vendorReceiptEmailEnabled()) return { ...summary, skipped_reason: 'disabled' };
  vendorReceiptNotifyRunning = true;
  try {
    // Re-arm data-missing skips once the office fixes the record in QuickBooks.
    // A re-armed bill gets a fresh attempt budget - skips must never burn send tries.
    db.prepare(`
      UPDATE quickbooks_bills
      SET vendor_receipt_notify_status = NULL,
          vendor_receipt_notify_error = NULL,
          vendor_receipt_notify_attempts = 0,
          updated_at = datetime('now')
      WHERE COALESCE(payment_approval_status, '') != '${PAYMENT_APPROVAL_DELETED_STATUS}'
        AND ((vendor_receipt_notify_status = 'skipped_no_email'
             AND EXISTS (
               SELECT 1 FROM quickbooks_vendors qv
               WHERE qv.qbo_id = quickbooks_bills.vendor_id
                 AND TRIM(COALESCE(qv.primary_email, '')) != ''
             ))
         OR (vendor_receipt_notify_status = 'skipped_no_due_date' AND COALESCE(due_date, '') != ''))
    `).run();

    const candidates = db.prepare(`
      SELECT
        qb.qbo_id,
        qb.doc_number,
        qb.vendor_id,
        qb.vendor_name,
        qb.txn_date,
        qb.due_date,
        qb.total_amt,
        qb.payment_status,
        qb.project_id,
        qb.vendor_receipt_notify_status AS prior_status,
        COALESCE(qb.vendor_receipt_notify_attempts, 0) AS attempts,
        qv.qbo_id AS vendor_row_id,
        qv.display_name AS vendor_display_name,
        qv.primary_email AS vendor_primary_email,
        p.address AS project_address,
        p.job_name AS project_job_name
      FROM quickbooks_bills qb
      LEFT JOIN quickbooks_vendors qv ON qv.qbo_id = qb.vendor_id
      LEFT JOIN projects p ON p.id = qb.project_id
      WHERE (qb.vendor_receipt_notify_status IS NULL
         OR (qb.vendor_receipt_notify_status = 'failed'
             AND COALESCE(qb.vendor_receipt_notify_attempts, 0) < ${VENDOR_RECEIPT_MAX_ATTEMPTS}
             AND qb.updated_at < datetime('now', '-1 hour')))
        AND COALESCE(qb.payment_approval_status, '') != '${PAYMENT_APPROVAL_DELETED_STATUS}'
        AND (qb.vendor_id IS NULL OR qv.qbo_id IS NOT NULL)
      ORDER BY datetime(qb.first_seen_at) ASC
      LIMIT 200
    `).all();
    summary.candidates = candidates.length;
    if (!candidates.length) return summary;

    const automationUserId = userId || paymentQueueAutomationUserId(db) || connection.connected_by || null;
    const claimBill = db.prepare(`
      UPDATE quickbooks_bills
      SET vendor_receipt_notify_status = 'processing',
          updated_at = datetime('now')
      WHERE qbo_id = ?
        AND (vendor_receipt_notify_status IS NULL OR vendor_receipt_notify_status = 'failed')
    `);
    // Attempts count only real send failures - data-missing skips must not burn the
    // retry budget of an email that has never actually been tried.
    const finishBill = db.prepare(`
      UPDATE quickbooks_bills
      SET vendor_receipt_notify_status = ?,
          vendor_receipt_notified_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE vendor_receipt_notified_at END,
          vendor_receipt_notify_attempts = CASE WHEN ? = 'failed' THEN COALESCE(vendor_receipt_notify_attempts, 0) + 1 ELSE vendor_receipt_notify_attempts END,
          vendor_receipt_notified_email = ?,
          vendor_receipt_notify_error = ?,
          updated_at = datetime('now')
      WHERE qbo_id = ?
        AND vendor_receipt_notify_status = 'processing'
    `);

    // Rate limit per pass instead of suppressing: the provenance check upstream
    // keeps floods of "new" bills from ever existing, so a long candidate list is
    // real work - drain it maxPerSync at a time (sync runs every minute).
    const maxPerSync = vendorReceiptEmailMaxPerSync();
    const workList = candidates.slice(0, maxPerSync);
    if (candidates.length > workList.length) {
      summary.deferred += candidates.length - workList.length;
      console.warn(`[QBO] Contractor receipt queue: processing ${workList.length} of ${candidates.length} pending bills this pass.`);
    }

    for (const bill of workList) {
      const isRetry = bill.prior_status === 'failed';
      const vendorEmail = String(bill.vendor_primary_email || '').trim();
      const vendorName = bill.vendor_display_name || bill.vendor_name || 'Contractor';
      const projectLabel = bill.project_address || bill.project_job_name || null;

      // Vendor not mirrored yet (vendor sync can fail transiently): leave the bill
      // unclaimed so the next sync retries against a fresh vendor mirror.
      if (bill.vendor_id && !bill.vendor_row_id) {
        summary.deferred += 1;
        continue;
      }

      let claimed;
      try {
        claimed = claimBill.run(bill.qbo_id);
      } catch (err) {
        console.error(`[QBO] Contractor receipt claim failed for bill ${bill.qbo_id}:`, err.message);
        continue;
      }
      if (!claimed.changes) continue;
      summary.attempted += 1;

      const dueDatePassed = bill.due_date
        ? Date.parse(`${bill.due_date}T23:59:59Z`) < Date.now()
        : false;

      let status = 'sent';
      let sendError = null;
      if (bill.payment_status === 'paid') status = 'skipped_already_paid';
      else if (!vendorEmail) status = 'skipped_no_email';
      else if (!bill.due_date) status = 'skipped_no_due_date';
      else if (dueDatePassed) status = 'skipped_stale';
      else if (!isEmailConfigured()) {
        status = 'failed';
        sendError = 'SMTP not configured - email not sent';
        console.error(`[QBO] Contractor receipt email skipped for bill ${bill.qbo_id}: SMTP not configured.`);
      } else {
        try {
          await sendContractorInvoiceReceivedEmail({
            vendorName,
            vendorEmail,
            amount: bill.total_amt,
            payDate: bill.due_date,
            receivedDate: bill.txn_date,
            invoiceNumber: bill.doc_number,
            projectLabel,
          });
        } catch (err) {
          status = 'failed';
          sendError = String(err?.message || err).slice(0, 500);
          console.error(`[QBO] Contractor receipt email failed for bill ${bill.qbo_id} (${vendorEmail}):`, sendError);
        }
      }

      try {
        finishBill.run(status, status, status, vendorEmail || null, sendError, bill.qbo_id);
      } catch (err) {
        console.error(`[QBO] Contractor receipt bookkeeping failed for bill ${bill.qbo_id}:`, err.message);
      }
      if (status === 'sent') summary.sent += 1;
      else if (status === 'failed') summary.failed += 1;
      else summary.skipped += 1;

      // One bell entry per bill on first processing; retries only add an entry when
      // they finally succeed, so a flaky SMTP night cannot flood the activity feed.
      if (automationUserId && (!isRetry || status === 'sent')) {
        const amountLabel = `$${Number(bill.total_amt || 0).toFixed(2)}`;
        logActivity({
          userId: automationUserId,
          projectId: bill.project_id || null,
          action: 'quickbooks_invoice_received',
          entityType: 'quickbooks_bill',
          entityId: bill.qbo_id,
          details: {
            title: `${vendorName} • ${amountLabel} • expected pay ${bill.due_date || 'not set'} • ${vendorReceiptStatusNote(status, vendorEmail)}`,
            vendor_name: vendorName,
            vendor_email: vendorEmail || null,
            total_amt: bill.total_amt,
            txn_date: bill.txn_date,
            due_date: bill.due_date,
            doc_number: bill.doc_number,
            project_label: projectLabel,
            contractor_email_status: status,
          },
        });
      }
    }

    return summary;
  } finally {
    vendorReceiptNotifyRunning = false;
  }
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

async function syncQuickBooksBillPdfs({ scope = 'open_missing', force = false, qboIds = [], source = 'manual', userId = null } = {}) {
  if (activeBillPdfSyncPromise) return activeBillPdfSyncPromise;

  activeBillPdfSyncPromise = withQboPurpose('bill_pdfs', async () => {
    const db = getDb();
    const config = qboConfig();
    if (!config.configured) {
      return { skipped: true, reason: `missing_credentials:${config.missing.join(',')}` };
    }
    const connection = getActiveConnection(db);
    if (!connection) return { skipped: true, reason: 'not_connected' };
    const actorUserId = userId || connection.connected_by || paymentQueueAutomationUserId(db);

    const allowedScopes = new Set(['open_missing', 'open', 'missing', 'all']);
    const syncScope = allowedScopes.has(scope) ? scope : 'open_missing';
    const targetIds = Array.isArray(qboIds)
      ? Array.from(new Set(qboIds.map(id => String(id || '').trim()).filter(Boolean)))
      : [];
    const targets = quickBooksBillPdfTargets(db, { scope: syncScope, qboIds: targetIds });
    const summary = {
      message: 'QuickBooks bill PDF sync completed',
      source,
      scope: targetIds.length ? 'selected' : syncScope,
      target_bills: targets.length,
      qbo_attachables_seen: 0,
      qbo_pdf_attachables_seen: 0,
      bills_with_qbo_pdf: 0,
      missing_in_quickbooks: 0,
      downloaded: 0,
      redownloaded: 0,
      updated: 0,
      skipped: 0,
      skipped_reasons: {},
      missing_samples: [],
    };
    if (!targets.length) return summary;

    const { attachables, byBillId } = await fetchQuickBooksBillPdfAttachables(db, connection);
    summary.qbo_attachables_seen = attachables.length;
    summary.qbo_pdf_attachables_seen = Array.from(byBillId.values()).reduce((count, items) => count + items.length, 0);

    for (const bill of targets) {
      const billAttachables = byBillId.get(String(bill.qbo_id)) || [];
      if (!billAttachables.length) {
        summary.missing_in_quickbooks += 1;
        if (summary.missing_samples.length < 10) {
          summary.missing_samples.push({
            qbo_id: bill.qbo_id,
            vendor_name: bill.vendor_name || null,
            doc_number: bill.doc_number || null,
          });
        }
        continue;
      }
      summary.bills_with_qbo_pdf += 1;
      for (const attachable of billAttachables) {
        try {
          const stored = await storeQuickBooksBillPdfAttachment(db, connection, bill, attachable, { force, userId: actorUserId });
          if (stored.status === 'downloaded') summary.downloaded += 1;
          else if (stored.status === 'redownloaded') summary.redownloaded += 1;
          else if (stored.status === 'updated') summary.updated += 1;
          else {
            summary.skipped += 1;
            summary.skipped_reasons[stored.reason || 'unknown'] = (summary.skipped_reasons[stored.reason || 'unknown'] || 0) + 1;
          }
        } catch (err) {
          summary.skipped += 1;
          summary.skipped_reasons[err.message || 'download_failed'] = (summary.skipped_reasons[err.message || 'download_failed'] || 0) + 1;
          console.warn(`[QBO] Failed to sync bill PDF ${bill.qbo_id}/${attachable?.Id || 'unknown'}:`, err.message);
        }
      }
    }

    // Automatic scans that found nothing new are not audit events (they used to add a
    // row every minute, 99% of the activity log). Manual runs are always recorded.
    const pdfSyncDidSomething = summary.downloaded + summary.redownloaded + summary.updated > 0
      || Object.keys(summary.skipped_reasons).length > 0;
    if (actorUserId && (source !== 'auto' || pdfSyncDidSomething)) {
      logActivity({
        userId: actorUserId,
        action: 'quickbooks_bill_pdf_sync_completed',
        entityType: 'quickbooks_connection',
        entityId: connection.realm_id,
        details: summary,
      });
    }
    return summary;
  });

  try {
    return await activeBillPdfSyncPromise;
  } finally {
    activeBillPdfSyncPromise = null;
  }
}

function logPaidFromQueue(paidFromQueue, source) {
  if (!paidFromQueue?.length) return;
  const names = paidFromQueue.slice(0, 10)
    .map(bill => `${bill.vendor_name || 'Vendor missing'} $${normalizeMoney(bill.total_amt).toFixed(2)}`)
    .join(', ');
  const more = paidFromQueue.length > 10 ? ` and ${paidFromQueue.length - 10} more` : '';
  console.log(`[QBO] ${paidFromQueue.length} Friday-queue bill(s) now paid in QuickBooks (${source}): ${names}${more}`);
}

// ── Friday queue re-check (2026-10-02) ───────────────────────────────────────
// A payment recorded in QuickBooks used to reach the queue only on the next full
// sync (QBO_AUTO_SYNC_INTERVAL_MS, 60 s in prod) and the Invoice Center only on
// its own 60 s poll, so a bill the office had just paid could sit in the queue
// for two minutes and look like the sync was broken. This re-reads ONLY the
// queued bills (one QBO query, plus recent bill payments when any turned up
// paid) whenever someone opens or returns to the queue. One in-flight check is
// shared by every caller and results are reused for two minutes (was 10 s; the
// Invoice Center polls every 60 s), so open tabs cannot hammer QuickBooks.
// QBO_QUEUE_RECHECK_MIN_GAP_MS overrides.
const PAYMENT_QUEUE_RECHECK_MIN_GAP_MS = 2 * 60 * 1000;
const PAYMENT_QUEUE_RECHECK_PAYMENT_LOOKBACK_DAYS = 3;
let paymentQueueRecheckPromise = null;
let paymentQueueRecheckLast = null;

function queuedUnpaidQuickBooksBillIds(db) {
  // QBO entity ids are numeric; anything else is skipped rather than quoted into a query.
  return db.prepare(`
    SELECT qbo_id
    FROM quickbooks_bills
    WHERE payment_status != 'paid'
      AND COALESCE(payment_approval_status, '${PAYMENT_APPROVAL_DEFAULT_STATUS}') = '${PAYMENT_APPROVAL_STATUS}'
    ORDER BY qbo_id
  `).all()
    .map(row => String(row.qbo_id || '').trim())
    .filter(id => /^[0-9]+$/.test(id));
}

async function recheckPaymentQueueAgainstQuickBooks() {
  if (paymentQueueRecheckPromise) return paymentQueueRecheckPromise;
  const minGapMs = envIntervalMs(['QBO_QUEUE_RECHECK_MIN_GAP_MS'], PAYMENT_QUEUE_RECHECK_MIN_GAP_MS, 5 * 1000) * qboBudgetFactor('view');
  if (paymentQueueRecheckLast && Date.now() - paymentQueueRecheckLast.at < minGapMs) {
    // Bills that check found paid were already announced to whoever triggered it.
    return { ...paymentQueueRecheckLast.result, now_paid: [], cached: true };
  }

  paymentQueueRecheckPromise = withQboPurpose('payment_queue', async () => {
    const db = getDb();
    if (!qboConfig().configured) return { skipped: true, reason: 'missing_credentials' };
    const connection = getActiveConnection(db);
    if (!connection) return { skipped: true, reason: 'not_connected' };
    // A full sync already in flight read QuickBooks before this check will. Let it
    // write first so it cannot overwrite this fresher answer with older data.
    if (activeSyncPromise) await activeSyncPromise.catch(() => null);

    const ids = queuedUnpaidQuickBooksBillIds(db);
    const checkedAt = new Date().toISOString();
    if (!ids.length) return { checked: 0, found_in_quickbooks: 0, now_paid: [], checked_at: checkedAt };

    const bills = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100).map(id => `'${id}'`).join(', ');
      const payload = await qboQuery(db, connection, `SELECT * FROM Bill WHERE Id IN (${chunk}) MAXRESULTS 1000`);
      bills.push(...(payload?.QueryResponse?.Bill || []).filter(bill => bill?.Id));
    }
    let payments = [];
    if (bills.some(bill => paymentStatusForBill(bill) === 'paid')) {
      // Take the payments too, so Paid in Full shows the pay date straight away.
      const since = new Date(Date.now() - PAYMENT_QUEUE_RECHECK_PAYMENT_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
      payments = await fetchAllQboEntitiesWhere(db, connection, 'BillPayment', `Metadata.LastUpdatedTime >= '${since}'`)
        .catch(err => {
          console.warn('[QBO] Payment queue re-check: bill payment lookup skipped:', err.message);
          return [];
        });
    }
    // Bills missing from the answer (deleted in QBO) are left to the full sync's
    // reconcileMissingQuickBooksBills, which only trusts a complete Bill query.
    const result = upsertBillsAndPayments(db, connection, bills, payments);
    logPaidFromQueue(result.paidFromQueue, 'queue re-check');
    return {
      checked: ids.length,
      found_in_quickbooks: bills.length,
      now_paid: result.paidFromQueue,
      checked_at: checkedAt,
    };
  });

  try {
    const result = await paymentQueueRecheckPromise;
    if (!result.skipped) paymentQueueRecheckLast = { at: Date.now(), result };
    return result;
  } finally {
    paymentQueueRecheckPromise = null;
  }
}

// ── Event-driven change checks (2026-10-20) ─────────────────────────────────
// One CDC request per company returns every bill, bill payment, vendor, attachment and
// accounting transaction edited since the previous check. New Urban's bills, payments
// and vendors are written through the same path as the full sync; any change at all
// (for New Urban or a Finance-hub company) pings Finance Tracker. The full sync stays
// the authoritative reconcile; a deletion seen here triggers it at once.
function backgroundQuickBooksWorkEnabled() {
  // The blue-green GREEN runs with the auto sync off: it must not check, scan or ping.
  return !(process.env.QBO_AUTO_SYNC_ENABLED === 'false' || process.env.QUICKBOOKS_AUTO_SYNC_ENABLED === 'false');
}

function envIntervalMs(names, fallback, minimumMs) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === '') continue;
    const requested = Number(raw);
    if (!Number.isFinite(requested) || requested <= 0) return 0;
    return Math.max(minimumMs, requested);
  }
  return fallback;
}

// Safety-net interval for New Urban (webhooks and the Invoice Center trigger checks at once).
function getFastCheckIntervalMs() {
  return envIntervalMs(['QBO_CHANGE_CHECK_INTERVAL_MS', 'QBO_FAST_CHECK_INTERVAL_MS'], CHANGE_CHECK_DEFAULT_INTERVAL_MS, 10 * 1000);
}

function getFinanceChangeCheckIntervalMs() {
  return envIntervalMs(['QBO_FINANCE_CHANGE_CHECK_INTERVAL_MS'], FINANCE_CHANGE_CHECK_DEFAULT_INTERVAL_MS, 60 * 1000);
}

function cdcEntities(payload, entityName) {
  const rows = [];
  for (const block of payload?.CDCResponse || []) {
    for (const queryResponse of block?.QueryResponse || []) {
      if (Array.isArray(queryResponse?.[entityName])) rows.push(...queryResponse[entityName]);
    }
  }
  return rows;
}

function isCdcDeleted(entity) {
  return String(entity?.status || '').toLowerCase() === 'deleted';
}

// FT_TXN_ENTITIES is declared further down; these run after the module has loaded.
function primaryCdcEntityNames() {
  return ['Bill', 'BillPayment', 'Vendor', 'Attachable', ...FT_TXN_ENTITIES];
}

function financeCdcEntityNames() {
  return ['Bill', 'BillPayment', ...FT_TXN_ENTITIES];
}

function loadChangeCheckConnection(db, connectionId) {
  if (connectionId === 'primary') return getActiveConnection(db);
  return db.prepare("SELECT * FROM quickbooks_connections WHERE id = ? AND id LIKE 'finance:%' AND is_active = 1").get(connectionId);
}

function changeCheckState(connectionId) {
  if (!changeCheckStates.has(connectionId)) {
    changeCheckStates.set(connectionId, {
      last_at: null, last_status: null, last_error: null, last_changes: 0, last_trigger: null, checks: 0,
    });
  }
  return changeCheckStates.get(connectionId);
}

// The 2-minute overlap returns recent rows again; count each version once so one edit
// pings Finance Tracker once.
function countUnseenChanges(connectionId, typedRows) {
  let seen = seenCdcKeys.get(connectionId);
  if (!seen) {
    seen = new Set();
    seenCdcKeys.set(connectionId, seen);
  }
  let unseen = 0;
  for (const [type, row] of typedRows) {
    const key = `${type}:${row.Id}:${row.SyncToken ?? ''}:${row.MetaData?.LastUpdatedTime ?? ''}:${row.status ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unseen += 1;
  }
  if (seen.size > 5000) seen.clear();
  return unseen;
}

async function fastCheckQuickBooksChanges(connectionId = 'primary', trigger = 'safety_net') {
  const isPrimary = connectionId === 'primary';
  if (changeCheckInFlight.has(connectionId)) return changeCheckInFlight.get(connectionId);
  // A full sync is re-reading New Urban right now; it covers this check.
  if (isPrimary && activeSyncPromise) return { skipped: true, reason: 'full_sync_running' };

  const purpose = isPrimary ? (trigger === 'on_view' ? 'invoice_center' : 'change_check') : 'finance_change_check';
  const check = withQboPurpose(purpose, async () => {
    const db = getDb();
    if (!qboConfig().configured) return { skipped: true, reason: 'missing_credentials' };
    const connection = loadChangeCheckConnection(db, connectionId);
    if (!connection) return { skipped: true, reason: 'not_connected' };

    const startedAt = Date.now();
    // Overlapping windows: anything QuickBooks stamped in the last couple of minutes is
    // read again, so clock skew or a write racing the previous check cannot slip by.
    const since = changeCheckCursors.get(connectionId) || new Date(startedAt - FAST_CHECK_FIRST_LOOKBACK_MS).toISOString();
    const entityNames = isPrimary ? primaryCdcEntityNames() : financeCdcEntityNames();
    const payload = await qboRequest(
      db,
      connection,
      `/v3/company/${encodeURIComponent(connection.realm_id)}/cdc?entities=${entityNames.join(',')}&changedSince=${encodeURIComponent(since)}`
    );
    const byType = Object.fromEntries(entityNames.map(name => [name, cdcEntities(payload, name).filter(row => row?.Id)]));
    const typedRows = entityNames.flatMap(name => byType[name].map(row => [name, row]));
    const accountingChanges = countUnseenChanges(connectionId, typedRows);

    let result = { changedBills: 0, changedPayments: 0, nowPaid: 0, paidFromQueue: [], markedPaidFromQueue: 0 };
    let vendorsChanged = 0;
    let attachablesChanged = 0;
    let newlyDeleted = [];
    if (isPrimary) {
      const bills = byType.Bill.filter(bill => !isCdcDeleted(bill));
      const payments = byType.BillPayment.filter(payment => !isCdcDeleted(payment));
      newlyDeleted = [...byType.Bill.map(row => ['Bill', row]), ...byType.BillPayment.map(row => ['BillPayment', row])]
        .filter(([, row]) => isCdcDeleted(row))
        .map(([type, row]) => `${type}:${row.Id}`)
        .filter(key => !handledCdcDeletes.has(key));
      if (handledCdcDeletes.size > 500) handledCdcDeletes.clear();
      for (const key of newlyDeleted) handledCdcDeletes.add(key);

      if (bills.length || payments.length) {
        result = upsertBillsAndPayments(db, connection, bills, payments);
        logPaidFromQueue(result.paidFromQueue, trigger === 'webhook' ? 'webhook' : 'fast check');
      }
      const vendors = byType.Vendor.filter(vendor => !isCdcDeleted(vendor));
      if (vendors.length) {
        upsertQuickBooksVendors(db, connection, vendors);
        vendorsChanged = vendors.length;
      }
      attachablesChanged = byType.Attachable.filter(attachable => !isCdcDeleted(attachable)).length;
      if (attachablesChanged) requestBillPdfScan();

      const changes = result.changedBills + result.changedPayments;
      if (changes) {
        console.log(`[QBO] Fast check: ${result.changedBills} bill(s) and ${result.changedPayments} bill payment(s) changed in QuickBooks${result.nowPaid ? `; ${result.nowPaid} bill(s) now paid` : ''} (${trigger})`);
        const actorUserId = connection.connected_by || paymentQueueAutomationUserId(db);
        if (actorUserId) {
          logActivity({
            userId: actorUserId,
            action: 'quickbooks_sync_completed',
            entityType: 'quickbooks_connection',
            entityId: connection.realm_id,
            details: {
              source: 'fast_check',
              trigger,
              changed_bills: result.changedBills,
              changed_bill_payments: result.changedPayments,
              bills_now_paid: result.nowPaid,
              marked_paid_from_friday_queue: result.markedPaidFromQueue,
              ...(result.paidFromQueue.length ? { paid_from_friday_queue: result.paidFromQueue.slice(0, 25) } : {}),
              ...(newlyDeleted.length ? { deleted_in_quickbooks: newlyDeleted.slice(0, 25) } : {}),
            },
          });
        }
      }
    }
    changeCheckCursors.set(connectionId, new Date(startedAt - FAST_CHECK_OVERLAP_MS).toISOString());
    if (accountingChanges) {
      // Before the ping, so the pull it triggers misses the stale cached reads.
      markQboRealmChanged(connection.realm_id);
      notifyFinanceTracker(connection.realm_id);
    }
    return {
      connection_id: connectionId,
      trigger,
      checked_at: new Date(startedAt).toISOString(),
      since,
      entities_returned: typedRows.length,
      accounting_changes: accountingChanges,
      bills: byType.Bill.length,
      bill_payments: byType.BillPayment.length,
      changed_bills: result.changedBills,
      changed_bill_payments: result.changedPayments,
      bills_now_paid: result.nowPaid,
      vendors_changed: vendorsChanged,
      attachables_changed: attachablesChanged,
      deleted_seen: newlyDeleted.length,
    };
  });

  changeCheckInFlight.set(connectionId, check);
  if (isPrimary) activeFastCheckPromise = check;
  const state = changeCheckState(connectionId);
  try {
    const result = await check;
    if (!result?.skipped) {
      state.last_at = result.checked_at;
      state.last_status = 'success';
      state.last_error = null;
      state.last_changes = result.accounting_changes;
      state.last_trigger = trigger;
      state.checks += 1;
    }
    return result;
  } catch (err) {
    state.last_at = new Date().toISOString();
    state.last_status = 'failed';
    state.last_error = err.message || 'QuickBooks change check failed';
    state.last_trigger = trigger;
    throw err;
  } finally {
    changeCheckInFlight.delete(connectionId);
    if (isPrimary) activeFastCheckPromise = null;
  }
}

// Webhook bursts (Intuit sends one notification per edit) collapse into one check a
// few seconds later. An event arriving while a check runs gets a fresh check after it.
function requestChangeCheck(connectionId, { trigger = 'webhook', delayMs = WEBHOOK_CHECK_DEBOUNCE_MS, minGapMs = 0 } = {}) {
  if (!backgroundQuickBooksWorkEnabled()) return false;
  let request = changeCheckRequests.get(connectionId);
  if (!request) {
    request = { timer: null, lastRunAt: 0 };
    changeCheckRequests.set(connectionId, request);
  }
  if (request.timer) return true;
  const waitMs = Math.max(delayMs, request.lastRunAt + minGapMs - Date.now());
  request.timer = setTimeout(async () => {
    request.timer = null;
    const running = changeCheckInFlight.get(connectionId);
    if (running) await running.catch(() => null);
    if (connectionId === 'primary' && activeSyncPromise) await activeSyncPromise.catch(() => null);
    request.lastRunAt = Date.now();
    try {
      const result = await fastCheckQuickBooksChanges(connectionId, trigger);
      if (connectionId === 'primary' && result?.deleted_seen) {
        // Only the full Bill query can tell which bills are gone.
        await syncQuickBooksBills({ source: 'auto' }).catch(err => console.error('[QBO] Sync after a QuickBooks deletion failed:', err.message));
      }
    } catch (err) {
      console.warn(`[QBO] Change check (${trigger}) failed for ${connectionId}:`, err.message);
    }
  }, waitMs);
  request.timer.unref?.();
  return true;
}

// Opening or refreshing the Invoice Center asks QuickBooks what changed, at most once per
// CHANGE_CHECK_ON_VIEW_MIN_GAP_MS, and waits briefly so the page shows it.
async function refreshQuickBooksBeforeView() {
  if (!backgroundQuickBooksWorkEnabled()) return;
  const lastAt = Date.parse(changeCheckStates.get('primary')?.last_at || '') || 0;
  const minGapMs = envIntervalMs(['QBO_VIEW_CHECK_MIN_GAP_MS'], CHANGE_CHECK_ON_VIEW_MIN_GAP_MS, 5 * 1000) * qboBudgetFactor('view');
  if (Date.now() - lastAt < minGapMs) return;
  const check = fastCheckQuickBooksChanges('primary', 'on_view')
    .then(async result => {
      if (result?.deleted_seen) await syncQuickBooksBills({ source: 'auto' }).catch(() => null);
      return result;
    })
    .catch(() => null);
  await Promise.race([check, new Promise(resolve => setTimeout(resolve, CHANGE_CHECK_ON_VIEW_WAIT_MS).unref?.())]);
}

function requestBillPdfScan() {
  billPdfScanRequested = true;
  if (billPdfScanTimer || !backgroundQuickBooksWorkEnabled() || process.env.QBO_BILL_PDF_SYNC_ON_BILL_SYNC === 'false') return;
  billPdfScanTimer = setTimeout(async () => {
    billPdfScanTimer = null;
    if (!billPdfScanRequested) return; // a full sync scanned meanwhile
    billPdfScanRequested = false;
    lastBillPdfScanAt = Date.now();
    try {
      await syncQuickBooksBillPdfs({ scope: process.env.QBO_BILL_PDF_SYNC_SCOPE || 'missing', source: 'auto' });
    } catch (err) {
      billPdfScanRequested = true;
      console.warn('[QBO] Bill PDF scan after a change failed:', err.message);
    }
  }, BILL_PDF_SCAN_DEBOUNCE_MS);
  billPdfScanTimer.unref?.();
}

// ── Finance Tracker ping ─────────────────────────────────────────────────────
// Finance Tracker used to pull every company's statements and New Urban's transactions
// every minute. BuildTrack now tells it when a company changed (debounced), and its own
// cron is only a slow safety net. Needs FINANCE_TRACKER_SYNC_URL + FINANCE_TRACKER_SYNC_KEY.
function financeTrackerNotifyConfig() {
  return {
    url: String(process.env.FINANCE_TRACKER_SYNC_URL || '').trim(),
    key: String(process.env.FINANCE_TRACKER_SYNC_KEY || '').trim(),
  };
}

function notifyFinanceTracker(realmId) {
  const { url, key } = financeTrackerNotifyConfig();
  if (!url || !key || !backgroundQuickBooksWorkEnabled()) return false;
  const n = financeTrackerNotify;
  n.realms.add(String(realmId));
  if (!n.firstQueuedAt) n.firstQueuedAt = Date.now();
  if (n.timer) clearTimeout(n.timer);
  const waitMs = Math.max(0, Math.min(FT_NOTIFY_DEBOUNCE_MS, n.firstQueuedAt + FT_NOTIFY_MAX_WAIT_MS - Date.now()));
  n.timer = setTimeout(() => { flushFinanceTrackerNotify().catch(() => {}); }, waitMs);
  n.timer.unref?.();
  return true;
}

async function flushFinanceTrackerNotify() {
  const n = financeTrackerNotify;
  n.timer = null;
  if (n.sending) {
    // One ping at a time; whatever queued meanwhile goes right after it.
    n.timer = setTimeout(() => { flushFinanceTrackerNotify().catch(() => {}); }, 5000);
    n.timer.unref?.();
    return;
  }
  const realms = Array.from(n.realms);
  n.realms.clear();
  n.firstQueuedAt = 0;
  if (!realms.length) return;
  const { url, key } = financeTrackerNotifyConfig();
  n.sending = true;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-key': key },
      body: JSON.stringify({ source: 'buildtrack', realms }),
      signal: AbortSignal.timeout(120 * 1000),
    });
    const text = await response.text().catch(() => '');
    n.last_status = response.ok ? 'ok' : `http_${response.status}`;
    n.last_error = response.ok ? null : text.slice(0, 200);
    if (!response.ok) console.warn(`[QBO] Finance Tracker ping answered ${response.status}`);
  } catch (err) {
    n.last_status = 'failed';
    n.last_error = err.message || 'Finance Tracker ping failed';
    console.warn('[QBO] Finance Tracker ping failed:', n.last_error);
  } finally {
    n.sent += 1;
    n.last_at = new Date().toISOString();
    n.last_realms = realms;
    n.sending = false;
  }
}

function billPdfScanIntervalMs() {
  const requested = Number(process.env.QBO_BILL_PDF_SCAN_INTERVAL_MS || BILL_PDF_SCAN_DEFAULT_INTERVAL_MS);
  return Number.isFinite(requested) && requested >= 60 * 1000 ? requested : BILL_PDF_SCAN_DEFAULT_INTERVAL_MS;
}

async function syncQuickBooksBills({ source = 'manual', userId = null } = {}) {
  if (activeSyncPromise) return activeSyncPromise;

  activeSyncPromise = withQboPurpose(source === 'manual' ? 'manual' : 'bill_sync', async () => {
    // A change check mid-flight writes first, so this sync's older read lands after it
    // and the next change check re-reads anything stamped in between.
    if (activeFastCheckPromise) await activeFastCheckPromise.catch(() => null);
    const db = getDb();
    const config = qboConfig();
    if (!config.configured) {
      return { skipped: true, reason: `missing_credentials:${config.missing.join(',')}` };
    }
    const connection = getActiveConnection(db);
    if (!connection) return { skipped: true, reason: 'not_connected' };

    try {
      const [bills, payments, vendors] = await Promise.all([
        fetchAllQboEntities(db, connection, 'Bill'),
        fetchAllQboEntities(db, connection, 'BillPayment').catch(err => {
          console.warn('[QBO] BillPayment sync skipped:', err.message);
          return [];
        }),
        fetchAllQboVendors(db, connection).catch(err => {
          console.warn('[QBO] Vendor sync skipped:', err.message);
          return [];
        }),
      ]);
      const companyName = connection.company_name || await fetchCompanyName(db, connection);
      const vendorResult = upsertQuickBooksVendors(db, connection, vendors);
      const result = upsertBillsAndPayments(db, connection, bills, payments);
      logPaidFromQueue(result.paidFromQueue, source);
      const missingBillReconciliation = reconcileMissingQuickBooksBills(db, connection, bills);
      // Contractor pay-date notifications are MANUAL-ONLY (2026-08-15, Mike's
      // directive): sync must never email a contractor on its own. The office
      // sends each one from the "Send pay date" button on a Waiting for Approval
      // row (POST /quickbooks/bills/:qboId/send-pay-date). notifyNewQuickBooksBills
      // is intentionally no longer called from the sync path.
      const vendorReceiptNotifications = { queued_new_bills: result.newBills.length, auto_send: 'disabled_manual_only' };
      let billPdfSync = null;
      // The PDF scan reads every QuickBooks attachment record; it used to run every
      // minute although the bills still missing a PDF have none in QuickBooks. It
      // runs when bills changed, on manual syncs, and otherwise every few minutes.
      const pdfScanDue = source !== 'auto'
        || billPdfScanRequested
        || Date.now() - lastBillPdfScanAt >= billPdfScanIntervalMs();
      if (process.env.QBO_BILL_PDF_SYNC_ON_BILL_SYNC !== 'false' && pdfScanDue) {
        billPdfScanRequested = false;
        lastBillPdfScanAt = Date.now();
        billPdfSync = await syncQuickBooksBillPdfs({ scope: process.env.QBO_BILL_PDF_SYNC_SCOPE || 'missing', source, userId }).catch(err => {
          billPdfScanRequested = true;
          console.warn('[QBO] Bill PDF sync skipped after bill sync:', err.message);
          return { skipped: true, reason: err.message || 'pdf_sync_failed' };
        });
      }
      const pdfChanges = billPdfSync && !billPdfSync.skipped
        ? (billPdfSync.downloaded || 0) + (billPdfSync.redownloaded || 0) + (billPdfSync.updated || 0)
        : 0;
      // The connection row's last_sync_at is the heartbeat. An automatic sync that
      // changed nothing is not an audit event (two such rows a minute used to be 99%
      // of the activity log and buried real events in the company audit trail).
      const syncChangedSomething = result.changedBills + result.changedPayments + result.markedPaidFromQueue
        + missingBillReconciliation.count + (vendorResult.profiles_created || 0) + pdfChanges > 0;
      if (syncChangedSomething) markQboRealmChanged(connection.realm_id);
      db.prepare(`
        UPDATE quickbooks_connections
        SET company_name = COALESCE(?, company_name),
            last_sync_at = datetime('now'),
            last_sync_status = ?,
            last_sync_error = NULL,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(companyName || null, source === 'webhook' ? 'webhook_success' : 'success', connection.id);
      if ((userId || connection.connected_by) && (source !== 'auto' || syncChangedSomething)) {
        logActivity({
          userId: userId || connection.connected_by,
          action: source === 'webhook' ? 'quickbooks_webhook_sync_completed' : 'quickbooks_sync_completed',
          entityType: 'quickbooks_connection',
          entityId: connection.realm_id,
          details: {
            source,
            bills: bills.length,
            bill_payments: payments.length,
            changed_bills: result.changedBills,
            changed_bill_payments: result.changedPayments,
            bills_now_paid: result.nowPaid,
            vendors: vendors.length,
            vendor_profiles_created: vendorResult.profiles_created,
            vendor_profiles_updated: vendorResult.profiles_updated,
            matched: result.matched,
            ignored_bills: result.ignored,
            marked_paid_from_friday_queue: result.markedPaidFromQueue,
            ...(result.paidFromQueue.length ? { paid_from_friday_queue: result.paidFromQueue.slice(0, 25) } : {}),
            new_bills: result.newBills.length,
            contractor_receipt_emails: vendorReceiptNotifications,
            qbo_missing_bills_hidden: missingBillReconciliation.count,
            qbo_missing_bill_samples: missingBillReconciliation.bills,
            bill_pdfs: billPdfSync,
          },
        });
      }
      return {
        message: 'QuickBooks Bills synced',
        source,
        bills: bills.length,
        bill_payments: payments.length,
        changed_bills: result.changedBills,
        changed_bill_payments: result.changedPayments,
        bills_now_paid: result.nowPaid,
        vendors: vendors.length,
        vendor_profiles_created: vendorResult.profiles_created,
        vendor_profiles_updated: vendorResult.profiles_updated,
        vendor_mirror: vendorResult,
        matched_invoices: result.matched,
        marked_paid_from_friday_queue: result.markedPaidFromQueue,
        new_bills: result.newBills.length,
        contractor_receipt_emails: vendorReceiptNotifications,
        qbo_missing_bills_hidden: missingBillReconciliation.count,
        qbo_missing_bill_samples: missingBillReconciliation.bills,
        ignored_bills: result.ignored,
        bill_pdfs: billPdfSync,
        stats: statusSummary(db),
      };
    } catch (err) {
      if (err.code === 'QBO_MONTHLY_LIMIT') console.warn('[QBO] Sync skipped:', err.message);
      else console.error('[QBO] Sync failed:', err);
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
  });

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
  const realms = new Set();
  // Intuit's CloudEvents format (mandatory from 2026-05-15) is a JSON array of events,
  // one per change, each naming its company (intuitaccountid); the legacy format is
  // { eventNotifications: [{ realmId, dataChangeEvent: { entities } }] }. Both accepted.
  const notifications = Array.isArray(payload)
    ? payload.map(event => {
      const typeParts = String(event?.type || '').split('.');
      const entityName = typeParts.length >= 3 ? typeParts[1] : '';
      return {
        realmId: event?.intuitaccountid || event?.intuitrealmid || event?.realmId || event?.data?.realmId || '',
        entities: entityName ? [{ name: entityName, id: event?.intuitentityid || event?.id || null }] : [],
        raw: event,
      };
    })
    : (Array.isArray(payload?.eventNotifications)
      ? payload.eventNotifications.map(notification => ({
        realmId: notification?.realmId || '',
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
      if (/^\d+$/.test(realmId)) realms.add(realmId);
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
  return { eventIds, entityNames: Array.from(entityNames), realms: Array.from(realms) };
}

function pruneWebhookEvents(db) {
  if (Date.now() - webhookEventsPrunedAt < 60 * 60 * 1000) return;
  webhookEventsPrunedAt = Date.now();
  db.prepare("DELETE FROM quickbooks_webhook_events WHERE julianday(received_at) < julianday('now', '-30 days')").run();
}

// POST /api/quickbooks/webhook - Intuit calls this when anything changes in a connected
// company (registered in the Intuit developer portal). It answers at once and queues a
// change check for that company; nothing in the payload is trusted beyond "this company
// changed". With QBO_WEBHOOK_VERIFIER_TOKEN set, the intuit-signature HMAC is required;
// until it is set, notifications are accepted but each company is checked at most every
// WEBHOOK_UNVERIFIED_MIN_GAP_MS, so the URL can be registered before the token arrives.
router.post('/webhook', async (req, res) => {
  let eventIds = [];
  try {
    // server.js hands this route the raw bytes (express.raw): Intuit's CloudEvents
    // notifications are application/cloudevents+json, which express.json() skips, and
    // the HMAC must be computed over the exact bytes Intuit signed.
    const raw = Buffer.isBuffer(req.body)
      ? req.body
      : (req.rawBody || Buffer.from(JSON.stringify(req.body || {})));
    req.rawBody = raw;
    let payload;
    try {
      payload = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    } catch (_) {
      return res.status(400).json({ error: 'Invalid QuickBooks webhook payload' });
    }
    const verified = qboConfig().webhookConfigured;
    if (verified && !webhookSignatureValid(req)) {
      webhookState.rejected += 1;
      return res.status(401).json({ error: 'Invalid QuickBooks webhook signature' });
    }

    const db = getDb();
    const recorded = recordWebhookEvents(db, payload);
    eventIds = recorded.eventIds;
    webhookState.received += 1;
    webhookState.last_received_at = new Date().toISOString();
    webhookState.last_verified = verified;
    webhookState.last_realms = recorded.realms;
    res.json({ ok: true, events: eventIds.length });

    const primary = getActiveConnection(db);
    const financeRows = db.prepare("SELECT id, realm_id FROM quickbooks_connections WHERE id LIKE 'finance:%' AND is_active = 1").all();
    let queued = 0;
    for (const realmId of recorded.realms) {
      const connectionId = primary && String(primary.realm_id) === realmId
        ? 'primary'
        : financeRows.find(row => String(row.realm_id) === realmId)?.id;
      if (!connectionId) continue;
      if (requestChangeCheck(connectionId, { trigger: 'webhook', minGapMs: verified ? 0 : WEBHOOK_UNVERIFIED_MIN_GAP_MS })) queued += 1;
    }
    if (!verified && !webhookState.unverified_warned) {
      webhookState.unverified_warned = true;
      console.warn('[QBO] Webhook received without QBO_WEBHOOK_VERIFIER_TOKEN set: accepted, rate-limited. Set the verifier token to require Intuit\'s signature.');
    }
    if (eventIds.length) markWebhookEvents(db, eventIds, queued ? 'queued' : 'ignored');
    pruneWebhookEvents(db);
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

  if (state.startsWith('ft1:')) return financeCompanies.complete(req, res, db, savedState);

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
    // When BuildTrack last saw a bill or bill payment change in QuickBooks, how the
    // event-driven change checks are doing (their own heartbeat; not in the audit log),
    // whether Intuit's webhook is reaching BuildTrack, and the Finance Tracker pings.
    last_change_at: lastQuickBooksChangeAt,
    fast_check: { ...fastCheckConfig, ...changeCheckState('primary') },
    change_checks: Object.fromEntries(changeCheckStates),
    webhook: {
      url: `${appBaseUrl()}/api/quickbooks/webhook`,
      verifier_configured: config.webhookConfigured,
      ...webhookState,
    },
    finance_tracker_notify: {
      configured: Boolean(financeTrackerNotifyConfig().url && financeTrackerNotifyConfig().key),
      sent: financeTrackerNotify.sent,
      last_at: financeTrackerNotify.last_at,
      last_status: financeTrackerNotify.last_status,
      last_error: financeTrackerNotify.last_error,
      last_realms: financeTrackerNotify.last_realms,
    },
    // Intuit calls this month by purpose and company, the budget pace, the read cache and
    // whether Intuit's monthly limit is blocking reads right now (2026-10-23).
    api_usage: qboApiUsageSummary(db),
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

router.post('/bills/attachments/sync', authorize(...QUICKBOOKS_ADMIN_ROLES), async (req, res) => {
  try {
    const requestedScope = String(req.body?.scope || 'open_missing').trim();
    const force = req.body?.force === true;
    const qboIds = Array.isArray(req.body?.qbo_ids) ? req.body.qbo_ids : [];
    const result = await syncQuickBooksBillPdfs({
      scope: requestedScope,
      force,
      qboIds,
      source: 'manual',
      userId: req.user.id,
    });
    if (result.skipped && result.reason === 'not_connected') {
      return res.status(409).json({ error: 'QuickBooks is not connected yet.' });
    }
    if (result.skipped) {
      return res.status(503).json({ error: `QuickBooks bill PDF sync skipped: ${result.reason}` });
    }
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'QuickBooks bill PDF sync failed' });
  }
});

router.post('/bills/:qboId/attachments', authorize(...QUICKBOOKS_ADMIN_ROLES), qboBillPdfUpload.single('invoice_pdf'), (req, res) => {
  try {
    const db = getDb();
    const qboId = String(req.params.qboId || '').trim();
    const bill = db.prepare(`
      SELECT qb.*, i.project_id as invoice_project_id
      FROM quickbooks_bills qb
      LEFT JOIN invoices i ON i.id = qb.matched_invoice_id
      WHERE qb.qbo_id = ?
    `).get(qboId);
    if (!bill) return res.status(404).json({ error: 'QuickBooks bill not found' });

    const file = req.file;
    if (!file?.buffer?.length) return res.status(400).json({ error: 'Upload a PDF invoice file.' });
    if (!isPdfLike({ mimeType: file.mimetype, name: file.originalname, buffer: file.buffer })) {
      return res.status(400).json({ error: 'Only PDF invoice files can be uploaded here.' });
    }

    const id = uuidv4();
    const originalName = sanitizeFilename(file.originalname || `quickbooks-bill-${qboId}.pdf`);
    const storedName = `${id}.pdf`;
    const dir = path.join(quickBooksBillAttachmentRoot(), safePathSegment(qboId));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, storedName), file.buffer);

    db.prepare(`
      INSERT INTO quickbooks_bill_attachments (id, qbo_bill_id, filename, original_name, mime_type, size, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      qboId,
      storedName,
      originalName,
      file.mimetype || 'application/pdf',
      file.size || file.buffer.length,
      req.user.id
    );

    logActivity({
      userId: req.user.id,
      projectId: bill.project_id || bill.invoice_project_id || null,
      action: 'quickbooks_bill_pdf_uploaded',
      entityType: 'quickbooks_bill',
      entityId: qboId,
      details: {
        doc_number: bill.doc_number || null,
        vendor_name: bill.vendor_name || null,
        original_name: originalName,
        size: file.size || file.buffer.length,
      },
    });

    res.status(201).json(getQuickBooksBillRow(db, qboId));
  } catch (err) {
    console.error('[QBO] Failed to upload bill PDF:', err);
    res.status(500).json({ error: 'Failed to upload invoice PDF' });
  }
});

router.get('/bills/:qboId/attachments/:attachmentId', authorize(...QUICKBOOKS_ADMIN_ROLES, 'project_manager'), (req, res) => {
  try {
    const db = getDb();
    const qboId = String(req.params.qboId || '').trim();
    const bill = db.prepare(`
      SELECT qb.*, i.project_id as invoice_project_id
      FROM quickbooks_bills qb
      LEFT JOIN invoices i ON i.id = qb.matched_invoice_id
      WHERE qb.qbo_id = ?
    `).get(qboId);
    if (!bill) return res.status(404).json({ error: 'QuickBooks bill not found' });

    const attachment = getQuickBooksBillAttachment(db, qboId, String(req.params.attachmentId || '').trim());
    if (!attachment) return res.status(404).json({ error: 'Invoice PDF not found' });
    const root = quickBooksBillAttachmentRoot();
    const filePath = path.resolve(root, safePathSegment(qboId), attachment.filename);
    const resolvedRoot = path.resolve(root);
    if (!filePath.startsWith(`${resolvedRoot}${path.sep}`) || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Invoice PDF file missing' });
    }

    const inline = String(req.query.inline || req.query.preview || '') === '1';
    logActivity({
      userId: req.user.id,
      projectId: bill.project_id || bill.invoice_project_id || null,
      action: inline ? 'quickbooks_bill_pdf_viewed' : 'quickbooks_bill_pdf_downloaded',
      entityType: 'quickbooks_bill_attachment',
      entityId: attachment.id,
      details: {
        qbo_bill_id: qboId,
        doc_number: bill.doc_number || null,
        vendor_name: bill.vendor_name || null,
        original_name: attachment.original_name,
        size: attachment.size,
      },
    });

    if (inline) {
      res.setHeader('Content-Type', attachment.mime_type || 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${headerFilename(attachment.original_name)}"`);
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.sendFile(filePath);
    }
    return res.download(filePath, attachment.original_name);
  } catch (err) {
    console.error('[QBO] Failed to load bill PDF:', err);
    res.status(500).json({ error: 'Failed to load invoice PDF' });
  }
});

// Read-only for project managers too — every bill mutation route keeps
// QUICKBOOKS_ADMIN_ROLES.
// Opening the Invoice Center (load, focus, its visible-tab poll) asks QuickBooks what
// changed first - at most every 20 s, waiting at most 4 s - instead of BuildTrack
// polling QuickBooks around the clock.
async function freshenBillsOnView(req, res, next) {
  try { await refreshQuickBooksBeforeView(); } catch (_) { /* the list still loads */ }
  next();
}

router.get('/bills', authorize(...QUICKBOOKS_ADMIN_ROLES, 'project_manager'), freshenBillsOnView, (req, res) => {
  const db = getDb();
  const status = String(req.query.status || '').toLowerCase();
  const unmatchedOnly = String(req.query.unmatched || '') === '1';
  const requestedLimit = Number(req.query.limit || 500);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(1000, Math.floor(requestedLimit))) : 500;
  const params = [];
  const where = [`COALESCE(qb.payment_approval_status, '${PAYMENT_APPROVAL_DEFAULT_STATUS}') != '${PAYMENT_APPROVAL_DELETED_STATUS}'`];
  const excludedVendors = excludedQuickBooksBillVendors();
  if (['paid', 'partial', 'unpaid'].includes(status)) {
    where.push('qb.payment_status = ?');
    params.push(status);
  }
  if (status === 'unpaid') {
    where.push(`COALESCE(qb.payment_approval_status, '${PAYMENT_APPROVAL_DEFAULT_STATUS}') NOT IN ('${PAYMENT_APPROVAL_STATUS}', '${PAYMENT_APPROVAL_PAID_STATUS}')`);
  }
  if (unmatchedOnly) {
    where.push(`qb.project_id IS NULL AND NOT ${splitLinesFullyMatchedSql('qb')}`);
    where.push(`COALESCE(qb.payment_approval_status, '${PAYMENT_APPROVAL_DEFAULT_STATUS}') NOT IN ('${PAYMENT_APPROVAL_STATUS}', '${PAYMENT_APPROVAL_PAID_STATUS}')`);
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

router.delete('/bills/:qboId', authorize(...QUICKBOOKS_ADMIN_ROLES), (req, res) => {
  try {
    const db = getDb();
    const qboId = String(req.params.qboId || '').trim();
    const bill = db.prepare(`
      SELECT qb.*, i.project_id as invoice_project_id
      FROM quickbooks_bills qb
      LEFT JOIN invoices i ON i.id = qb.matched_invoice_id
      WHERE qb.qbo_id = ?
    `).get(qboId);
    if (!bill) return res.status(404).json({ error: 'QuickBooks bill not found.' });

    const isPaid = String(bill.payment_status || '').toLowerCase() === 'paid' || Number(bill.balance || 0) <= 0;
    if (isPaid) {
      return res.status(409).json({ error: 'Paid QuickBooks bills cannot be deleted from Open Bills.' });
    }
    if (bill.payment_approval_status === PAYMENT_APPROVAL_STATUS) {
      return res.status(409).json({ error: 'Remove this bill from the Friday payment queue before deleting it.' });
    }
    if (bill.payment_approval_status === PAYMENT_APPROVAL_PAID_STATUS) {
      return res.status(409).json({ error: 'This bill was marked paid in BuildTrack and must stay linked to QuickBooks.' });
    }

    const retainedAttachmentCount = db.prepare('SELECT COUNT(*) AS count FROM quickbooks_bill_attachments WHERE qbo_bill_id = ?').get(qboId)?.count || 0;
    const removeBill = db.transaction(() => {
      db.prepare('DELETE FROM quickbooks_bill_lines WHERE qbo_bill_id = ?').run(qboId);
      // Preserve uploaded PDFs; the bill is soft-deleted and may reappear after a QBO resync.
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
      `).run(PAYMENT_APPROVAL_DELETED_STATUS, qboId);
    });
    removeBill();

    logActivity({
      userId: req.user.id,
      projectId: bill.project_id || bill.invoice_project_id || null,
      action: 'quickbooks_bill_deleted',
      entityType: 'quickbooks_bill',
      entityId: qboId,
      details: {
        doc_number: bill.doc_number || null,
        vendor_name: bill.vendor_name || null,
        total_amt: Number(bill.total_amt || 0),
        balance: Number(bill.balance || 0),
        attachment_count: retainedAttachmentCount,
        attachments_preserved: true,
      },
    });

    res.json({ message: 'Open bill deleted', qbo_id: qboId, stats: statusSummary(db) });
  } catch (err) {
    console.error('[QBO] Failed to delete open bill:', err);
    res.status(500).json({ error: 'Failed to delete open bill.' });
  }
});

router.put('/bills/:qboId/approve-for-pay', authorize(...QUICKBOOKS_ADMIN_ROLES), (req, res) => {
  const db = getDb();
  const bill = getQuickBooksBillRow(db, req.params.qboId);
  if (!bill) return res.status(404).json({ error: 'QuickBooks bill not found.' });
  if (bill.payment_status === 'paid') {
    return res.status(409).json({ error: 'This bill is already paid in QuickBooks.' });
  }
  if (bill.payment_approval_status === PAYMENT_APPROVAL_PAID_STATUS) {
    return res.status(409).json({ error: 'This bill is already marked paid in BuildTrack and remains linked to QuickBooks.' });
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
  // Debounced so a burst of approvals becomes one email to management.
  queueApprovalDigest(updated, req.user);
  res.json(updated);
});

router.put('/bills/:qboId/remove-from-pay', authorize(...QUICKBOOKS_ADMIN_ROLES), (req, res) => {
  const db = getDb();
  const bill = getQuickBooksBillRow(db, req.params.qboId);
  if (!bill) return res.status(404).json({ error: 'QuickBooks bill not found.' });
  if (bill.payment_status === 'paid') {
    // A card still on screen after the sync saw the payment: the bill has already
    // left the queue. Hand back the paid row so the page drops it; nothing changes.
    return res.json({ ...bill, already_paid: true });
  }
  if (bill.payment_approval_status === PAYMENT_APPROVAL_PAID_STATUS) {
    return res.status(409).json({ error: 'This bill is marked paid in BuildTrack and must stay linked to QuickBooks.' });
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
  // Un-approved inside the debounce window: never announce it.
  dropApprovalDigestEntry(updated.qbo_id);
  res.json(updated);
});

// POST /api/quickbooks/bills/:qboId/send-pay-date - manually email this bill's
// contractor their expected pay date (= the QBO due date). This button is the
// ONLY way pay-date emails go out; the sync-time auto-send was removed 2026-08-15.
router.post('/bills/:qboId/send-pay-date', authorize(...QUICKBOOKS_ADMIN_ROLES), async (req, res) => {
  const db = getDb();
  const bill = getQuickBooksBillRow(db, req.params.qboId);
  if (!bill) return res.status(404).json({ error: 'QuickBooks bill not found.' });
  if (bill.payment_approval_status === PAYMENT_APPROVAL_DELETED_STATUS) {
    return res.status(409).json({ error: 'This bill was deleted from BuildTrack.' });
  }
  if (bill.payment_status === 'paid' || bill.payment_approval_status === PAYMENT_APPROVAL_PAID_STATUS) {
    return res.status(409).json({ error: 'This bill is already paid - no pay-date email is needed.' });
  }
  const vendorEmail = String(bill.vendor_email || '').trim();
  const vendorName = bill.vendor_name || 'Contractor';
  if (!vendorEmail) {
    return res.status(409).json({ error: "This vendor has no email in QuickBooks. Add it there, run a sync, then send again." });
  }
  if (!bill.due_date) {
    return res.status(409).json({ error: "This bill has no due date (expected pay date) in QuickBooks. Set it there, run a sync, then send again." });
  }
  if (Date.parse(`${bill.due_date}T23:59:59Z`) < Date.now()) {
    return res.status(409).json({ error: 'The expected pay date has already passed. Update the due date in QuickBooks, run a sync, then send again.' });
  }
  if (!isEmailConfigured()) {
    return res.status(503).json({ error: 'Email is not configured on the server, so the pay-date email cannot be sent.' });
  }

  const projectLabel = bill.project_address || bill.project_job_name || null;
  try {
    await sendContractorInvoiceReceivedEmail({
      vendorName,
      vendorEmail,
      amount: bill.total_amt,
      payDate: bill.due_date,
      receivedDate: bill.txn_date,
      invoiceNumber: bill.doc_number,
      projectLabel,
    });
  } catch (err) {
    const sendError = String(err?.message || err).slice(0, 500);
    db.prepare(`
      UPDATE quickbooks_bills
      SET vendor_receipt_notify_status = 'failed',
          vendor_receipt_notify_attempts = COALESCE(vendor_receipt_notify_attempts, 0) + 1,
          vendor_receipt_notified_email = ?,
          vendor_receipt_notify_error = ?,
          updated_at = datetime('now')
      WHERE qbo_id = ?
    `).run(vendorEmail, sendError, bill.qbo_id);
    console.error(`[QBO] Manual pay-date email failed for bill ${bill.qbo_id} (${vendorEmail}):`, sendError);
    return res.status(502).json({ error: `The pay-date email failed to send: ${sendError}` });
  }

  db.prepare(`
    UPDATE quickbooks_bills
    SET vendor_receipt_notify_status = 'sent',
        vendor_receipt_notified_at = datetime('now'),
        vendor_receipt_notified_email = ?,
        vendor_receipt_notify_error = NULL,
        updated_at = datetime('now')
    WHERE qbo_id = ?
  `).run(vendorEmail, bill.qbo_id);

  const amountLabel = `$${Number(bill.total_amt || 0).toFixed(2)}`;
  logActivity({
    userId: req.user.id,
    projectId: bill.project_id || null,
    action: 'quickbooks_invoice_received',
    entityType: 'quickbooks_bill',
    entityId: bill.qbo_id,
    details: {
      title: `${vendorName} • ${amountLabel} • expected pay ${bill.due_date} • pay-date email sent manually`,
      vendor_name: vendorName,
      vendor_email: vendorEmail,
      total_amt: bill.total_amt,
      txn_date: bill.txn_date,
      due_date: bill.due_date,
      doc_number: bill.doc_number,
      project_label: projectLabel,
      contractor_email_status: 'sent',
      sent_manually: true,
    },
  });

  res.json(getQuickBooksBillRow(db, bill.qbo_id));
});

router.put('/bills/:qboId/mark-paid-from-queue', authorize(...QUICKBOOKS_ADMIN_ROLES), async (req, res) => {
  const db = getDb();
  const bill = getQuickBooksBillRow(db, req.params.qboId);
  if (!bill) return res.status(404).json({ error: 'QuickBooks bill not found.' });
  if (bill.payment_status === 'paid') {
    // The minute-by-minute sync usually sees the QuickBooks payment before anyone
    // clicks Verify. That is a successful verification, not an error (it used to
    // answer 409 "already paid" and show a red toast on a bill that was fine).
    if (bill.payment_approval_status === PAYMENT_APPROVAL_STATUS) {
      logActivity({
        userId: req.user.id,
        projectId: bill.project_id || undefined,
        action: 'quickbooks_bill_payment_verified',
        entityType: 'quickbooks_bill',
        entityId: bill.qbo_id,
        details: {
          vendor_name: bill.vendor_name,
          qbo_balance: bill.balance,
          qbo_payment_status: bill.payment_status,
          matched_invoice_id: bill.matched_invoice_id,
          already_synced: true,
        },
      });
    }
    return res.json({ ...bill, already_paid: true });
  }
  if (bill.payment_approval_status !== PAYMENT_APPROVAL_STATUS) {
    return res.status(409).json({ error: 'Only bills in the Friday payment queue can be marked paid from BuildTrack.' });
  }

  const connection = getActiveConnection(db);
  if (!connection) return res.status(503).json({ error: 'QuickBooks is not connected.' });

  let qboBill;
  try {
    const payload = await qboRequest(
      db,
      connection,
      `/v3/company/${encodeURIComponent(connection.realm_id)}/bill/${encodeURIComponent(bill.qbo_id)}`
    );
    qboBill = payload?.Bill;
  } catch (err) {
    const missingInQuickBooks = err.statusCode === 400 && /object not found|not found/i.test(String(err.message || ''));
    if (!missingInQuickBooks) {
      console.error('[QBO] Paid verification failed:', err);
      return res.status(err.statusCode || 502).json({ error: 'Could not verify this bill in QuickBooks. Try again.' });
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
    `).run(PAYMENT_APPROVAL_DELETED_STATUS, bill.qbo_id);
    logActivity({
      userId: req.user.id,
      projectId: bill.project_id || undefined,
      action: 'quickbooks_bill_missing_during_paid_verification',
      entityType: 'quickbooks_bill',
      entityId: bill.qbo_id,
      details: { vendor_name: bill.vendor_name, prior_balance: bill.balance, attachments_preserved: true },
    });
    return res.status(410).json({
      error: 'This bill no longer exists in QuickBooks and was removed from the active BuildTrack queue. Its audit record and PDF were preserved.',
      code: 'QUICKBOOKS_BILL_MISSING',
    });
  }

  if (!qboBill?.Id) {
    return res.status(502).json({ error: 'QuickBooks returned an invalid bill response. No BuildTrack status was changed.' });
  }

  // Refresh this one row from QBO before making the decision. The PAID action
  // is verification-only: it never creates a payment or forces a local paid
  // flag when QuickBooks still carries a balance.
  logPaidFromQueue(upsertBillsAndPayments(db, connection, [qboBill], []).paidFromQueue, 'verify');
  const refreshed = getQuickBooksBillRow(db, bill.qbo_id);
  if (refreshed.payment_status !== 'paid' && Number(refreshed.balance || 0) > 0) {
    return res.status(409).json({
      error: `QuickBooks still shows $${normalizeMoney(refreshed.balance).toFixed(2)} due. Record the payment in QuickBooks, then verify again.`,
      code: 'QUICKBOOKS_BALANCE_REMAINS',
      bill: refreshed,
    });
  }

  logActivity({
    userId: req.user.id,
    projectId: refreshed.project_id || undefined,
    action: 'quickbooks_bill_payment_verified',
    entityType: 'quickbooks_bill',
    entityId: refreshed.qbo_id,
    details: {
      vendor_name: refreshed.vendor_name,
      qbo_balance: refreshed.balance,
      qbo_payment_status: refreshed.payment_status,
      matched_invoice_id: refreshed.matched_invoice_id,
    },
  });
  res.json(refreshed);
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

// POST /api/quickbooks/payment-queue/recheck - re-read the queued bills from
// QuickBooks right now (see recheckPaymentQueueAgainstQuickBooks). It only reads
// QuickBooks; BuildTrack's mirror rows are all it changes.
router.post('/payment-queue/recheck', authorize(...QUICKBOOKS_ADMIN_ROLES), async (req, res) => {
  try {
    const result = await recheckPaymentQueueAgainstQuickBooks();
    if (result.skipped) {
      const notConnected = result.reason === 'not_connected';
      return res.status(notConnected ? 409 : 503).json({
        error: notConnected ? 'QuickBooks is not connected.' : 'QuickBooks credentials are not configured on the server.',
        ...result,
      });
    }
    res.json({ ...result, stats: statusSummary(getDb()) });
  } catch (err) {
    console.error('[QBO] Payment queue re-check failed:', err.message);
    if (err.code === 'QBO_MONTHLY_LIMIT') return res.status(429).json({ error: err.message });
    res.status(502).json({ error: 'Could not reach QuickBooks to re-check the payment queue. The change check keeps trying every few minutes.' });
  }
});

function startQuickBooksAutoSync() {
  if (autoSyncStarted) return;
  if (process.env.QBO_AUTO_SYNC_ENABLED === 'false' || process.env.QUICKBOOKS_AUTO_SYNC_ENABLED === 'false') {
    console.log('[QBO] Automatic sync disabled by environment.');
    return;
  }
  autoSyncStarted = true;
  try {
    const budget = qboBudgetState(getDb());
    console.log(`[QBO] Intuit API budget: ${budget.used} of ${budget.budget} calls used in ${budget.month} (${budget.level}).`);
  } catch (err) {
    console.warn('[QBO] Intuit API meter unavailable:', err.message);
  }
  const intervalMs = getAutoSyncIntervalMs();
  const run = async () => {
    // Ahead of the month's Intuit budget the reconcile runs every 2nd (economy) or 4th
    // (reserve) beat; the change checks below still carry every edit.
    if (!qboBeatDue('full_sync', intervalMs, qboBudgetFactor('full_sync'))) return;
    try {
      const result = await syncQuickBooksBills({ source: 'auto' });
      if (result?.skipped) {
        if (!['missing_credentials:', 'not_connected'].some(prefix => String(result.reason || '').startsWith(prefix))) {
          console.log('[QBO] Automatic sync skipped:', result.reason);
        }
        return;
      }
      console.log(`[QBO] Automatic sync completed: ${result.bills} bills, ${result.vendors || 0} vendors, ${result.matched_invoices} matched invoices, ${result.ignored_bills || 0} ignored bills`);
    } catch (err) {
      console.error('[QBO] Automatic sync failed:', err.message);
    }
  };
  setTimeout(run, Math.min(30 * 1000, intervalMs));
  setInterval(run, intervalMs);
  console.log(`[QBO] Automatic Bill sync enabled every ${Math.round(intervalMs / 1000)} seconds.`);

  // The change-check SAFETY NET (webhooks and the Invoice Center trigger checks at once).
  // Shares the auto-sync kill switch above, so a blue-green GREEN never runs it.
  const fastMs = getFastCheckIntervalMs();
  const financeMs = getFinanceChangeCheckIntervalMs();
  fastCheckConfig.enabled = fastMs > 0;
  fastCheckConfig.interval_ms = fastMs;
  fastCheckConfig.finance_interval_ms = financeMs;
  const lastErrors = new Map();
  const safetyCheck = async connectionId => {
    try {
      const result = await fastCheckQuickBooksChanges(connectionId, 'safety_net');
      if (!result?.skipped) lastErrors.delete(connectionId);
      if (connectionId === 'primary' && result?.deleted_seen) {
        // Only the full Bill query can tell which bills are gone; run it now.
        await syncQuickBooksBills({ source: 'auto' }).catch(err => {
          console.error('[QBO] Sync after a QuickBooks deletion failed:', err.message);
        });
      }
    } catch (err) {
      // Logged once per distinct error; /quickbooks/status shows the latest one.
      if (err.message !== lastErrors.get(connectionId)) console.warn(`[QBO] Fast change check failed (${connectionId}):`, err.message);
      lastErrors.set(connectionId, err.message);
    }
  };
  if (fastMs) {
    const primaryCheck = () => {
      if (qboBeatDue('change_check', fastMs, qboBudgetFactor('change_check'))) safetyCheck('primary');
    };
    setTimeout(primaryCheck, Math.min(20 * 1000, fastMs));
    setInterval(primaryCheck, fastMs);
    console.log(`[QBO] Fast change check enabled every ${Math.round(fastMs / 1000)} seconds (safety net; QuickBooks webhooks and the Invoice Center trigger it at once).`);
  } else {
    console.log('[QBO] Fast change check safety net disabled by environment.');
  }
  if (financeMs) {
    const financeChecks = async () => {
      if (!qboBeatDue('finance_change_check', financeMs, qboBudgetFactor('finance_change_check'))) return;
      const ids = getDb().prepare("SELECT id FROM quickbooks_connections WHERE id LIKE 'finance:%' AND is_active = 1 ORDER BY id").all().map(row => row.id);
      for (const id of ids) await safetyCheck(id);
    };
    setTimeout(financeChecks, Math.min(60 * 1000, financeMs)).unref?.();
    setInterval(financeChecks, financeMs).unref?.();
    console.log(`[QBO] Finance-hub company change check every ${Math.round(financeMs / 1000)} seconds (safety net).`);
  }
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
  if (approvalDigestEnabled()) {
    console.log(`[QBO] Approval digest email enabled: ${Math.round(approvalDigestDelayMs() / 1000)}s after the last approval (max ${Math.round(approvalDigestMaxWaitMs() / 1000)}s).`);
    setTimeout(recoverPendingApprovalDigest, 15 * 1000).unref?.();
  } else {
    console.log('[QBO] Approval digest email disabled by environment.');
  }
}

router.startQuickBooksAutoSync = startQuickBooksAutoSync;
router.startQuickBooksPaymentQueueScheduler = startQuickBooksPaymentQueueScheduler;
router.sendScheduledPaymentQueueEmail = sendScheduledPaymentQueueEmail;
router.syncQuickBooksBills = syncQuickBooksBills;
router.syncQuickBooksBillPdfs = syncQuickBooksBillPdfs;
router.withQboPurpose = withQboPurpose;
router.findInvoiceForBill = findInvoiceForBill;
router.__test = {
  acquireQboRequestSlot,
  cdcEntities,
  fastCheckQuickBooksChanges,
  recordWebhookEvents,
  requestChangeCheck,
  missingQuickBooksBillIds,
  paymentStatusForBill,
  queuedUnpaidQuickBooksBillIds,
  reconcileMissingQuickBooksBills,
  shouldRestoreDeletedQuickBooksBill,
  upsertBillsAndPayments,
};

module.exports = router;

// ── Finance Tracker service exports (2026-08-03) ─────────────────────────────
// Finance Tracker consumes QBO through THIS module only — one Intuit client,
// one token-refresh path. These back /api/service/finance-tracker/*.
const FT_TXN_ENTITIES = ['Purchase', 'Deposit', 'JournalEntry', 'Invoice', 'Payment', 'Transfer', 'VendorCredit', 'CreditMemo'];
// Intuit's change feed reaches back 30 days.
const FT_TXN_CDC_MAX_LOOKBACK_MS = 29 * 24 * 60 * 60 * 1000;

function ftGetConnection(db) {
  const connection = db.prepare("SELECT * FROM quickbooks_connections WHERE id = 'primary' AND is_active = 1").get();
  if (!connection) {
    const err = new Error('QuickBooks is not connected.');
    err.statusCode = 503;
    throw err;
  }
  return connection;
}

router.financeTrackerTransactionsSince = async function financeTrackerTransactionsSince(sinceIso) {
  const db = getDb();
  const connection = ftGetConnection(db);
  // One change-feed request answers what the eight per-entity queries below did
  // (2026-10-23, Intuit allowance). Its cursor moves every pull, so it is not cached.
  const sinceMs = Date.parse(sinceIso);
  if (Number.isFinite(sinceMs) && Date.now() - sinceMs < FT_TXN_CDC_MAX_LOOKBACK_MS) {
    const payload = await withQboPurpose('finance_tracker', () => qboRequest(
      db,
      connection,
      `/v3/company/${encodeURIComponent(connection.realm_id)}/cdc?entities=${FT_TXN_ENTITIES.join(',')}&changedSince=${encodeURIComponent(new Date(sinceMs).toISOString())}`
    ));
    return Object.fromEntries(FT_TXN_ENTITIES.map(entity => [
      entity,
      cdcEntities(payload, entity).filter(row => row?.Id && !isCdcDeleted(row)),
    ]));
  }
  const out = {};
  for (const entity of FT_TXN_ENTITIES) {
    const payload = await qboQuery(db, connection, `SELECT * FROM ${entity} WHERE Metadata.LastUpdatedTime >= '${sinceIso}' STARTPOSITION 1 MAXRESULTS 1000`);
    out[entity] = (payload && payload.QueryResponse && payload.QueryResponse[entity]) || [];
  }
  return out;
};

router.financeTrackerBalanceSheetByClass = async function financeTrackerBalanceSheetByClass() {
  const db = getDb();
  const connection = ftGetConnection(db);
  return qboRequest(db, connection, `/v3/company/${encodeURIComponent(connection.realm_id)}/reports/BalanceSheet?summarize_column_by=Classes&accounting_method=Accrual&date_macro=Today`);
};

router.financeTrackerProfitAndLossByClass = async function financeTrackerProfitAndLossByClass(startDate, endDate) {
  const db = getDb();
  const connection = ftGetConnection(db);
  return qboRequest(db, connection, `/v3/company/${encodeURIComponent(connection.realm_id)}/reports/ProfitAndLoss?summarize_column_by=Classes&accounting_method=Accrual&start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`);
};

// ── Card activity (2026-09-16) ───────────────────────────────────────────────
// Backs Finance Tracker's Capital page card panel. Reproduces the one-off
// 2026-08-01 load exactly (verified against all 1,087 charge rows, 181 payments
// and 6 payoffs it wrote): charges are card purchase lines by class (refunds
// negative) plus journal-entry credits to a card; paydowns are journal-entry
// debits and checks written against a card. This file has no Transfer or
// CreditCardPayment entities touching cards, so neither is read.

// A payoff is a month-end balance at or below zero after a month-end balance
// above this — smaller zero-crossings are timing noise, not a paid-off card.
const CARD_PAYOFF_MIN_PRIOR_BALANCE = 1000;

function buildCardActivity({ accounts, purchases, journals }) {
  const r2 = (n) => Math.round(n * 100) / 100;
  const cards = new Map(
    (accounts || []).filter((a) => a.AccountType === 'Credit Card').map((a) => [String(a.Id), a.Name])
  );
  const cardName = (ref) => (ref && cards.has(String(ref.value)) ? cards.get(String(ref.value)) : null);
  const charges = new Map();
  const payments = new Map();
  const movements = new Map(); // card -> month -> net change (charges positive)

  const move = (card, date, amount) => {
    const month = date.slice(0, 7);
    if (!movements.has(card)) movements.set(card, new Map());
    const byMonth = movements.get(card);
    byMonth.set(month, (byMonth.get(month) || 0) + amount);
  };
  const addCharge = (card, date, label, amount) => {
    const key = `${card}\u0000${date.slice(0, 7)}\u0000${label}`;
    const row = charges.get(key) || { card, month: date.slice(0, 7), label, amount: 0 };
    row.amount += amount;
    charges.set(key, row);
    move(card, date, amount);
  };
  const addPayment = (card, ref, date, label, amount) => {
    const key = `${card}\u0000${ref}`;
    const row = payments.get(key) || { card, ref, date, label, amount: 0 };
    row.amount += amount;
    payments.set(key, row);
    move(card, date, -amount);
  };

  for (const p of purchases || []) {
    const date = String(p.TxnDate || '');
    if (!date) continue;
    const lines = (p.Line || []).filter((l) => l.DetailType !== 'SubTotalLineDetail');
    const card = cardName(p.AccountRef);
    if (card) {
      const sign = p.Credit ? -1 : 1;
      for (const l of lines) {
        const detail = l.AccountBasedExpenseLineDetail || l.ItemBasedExpenseLineDetail || {};
        addCharge(card, date, detail.ClassRef?.name || 'Unclassed', sign * Number(l.Amount || 0));
      }
      continue;
    }
    // A bank purchase whose expense line is a card account pays that card down. These are
    // written from the operating account (QuickBooks types most of them Cash) and have
    // always been shown as checks.
    for (const l of lines) {
      const paid = cardName(l.AccountBasedExpenseLineDetail?.AccountRef);
      if (!paid) continue;
      addPayment(paid, `P${p.Id}`, date, `check — ${p.AccountRef?.name || '?'}`, Number(l.Amount || 0));
    }
  }

  for (const j of journals || []) {
    const date = String(j.TxnDate || '');
    if (!date) continue;
    for (const l of j.Line || []) {
      const detail = l.JournalEntryLineDetail;
      const card = cardName(detail?.AccountRef);
      if (!card) continue;
      if (detail.PostingType === 'Credit') addCharge(card, date, 'Journal adjustment', Number(l.Amount || 0));
      else addPayment(card, `J${j.Id}`, date, 'journal — journal entry', Number(l.Amount || 0));
    }
  }

  const payoffs = [];
  for (const [card, byMonth] of movements) {
    let balance = 0;
    let prior = 0;
    for (const [month, change] of [...byMonth.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      balance = r2(balance + change);
      if (balance <= 0.004 && prior > CARD_PAYOFF_MIN_PRIOR_BALANCE) payoffs.push({ card, month });
      prior = balance;
    }
  }

  return {
    charges: [...charges.values()]
      .map((row) => ({ ...row, amount: r2(row.amount) }))
      .filter((row) => Math.abs(row.amount) >= 0.005),
    payments: [...payments.values()].map((row) => ({ ...row, amount: r2(row.amount) })),
    payoffs,
  };
}

// Every record of an entity. The count comes first so a short read is an error
// rather than a silently truncated ledger.
async function ftQueryAll(db, connection, entity) {
  const counted = await qboQuery(db, connection, `SELECT COUNT(*) FROM ${entity}`);
  const total = Number(counted?.QueryResponse?.totalCount || 0);
  const rows = new Map();
  for (let start = 1; start <= total; start += 1000) {
    const payload = await qboQuery(db, connection, `SELECT * FROM ${entity} STARTPOSITION ${start} MAXRESULTS 1000`);
    for (const row of payload?.QueryResponse?.[entity] || []) rows.set(row.Id, row);
  }
  if (rows.size < total) {
    const err = new Error(`QuickBooks returned ${rows.size} of ${total} ${entity} records.`);
    err.statusCode = 502;
    throw err;
  }
  return [...rows.values()];
}

router.financeTrackerCardActivity = async function financeTrackerCardActivity() {
  const db = getDb();
  const connection = ftGetConnection(db);
  const accounts = await ftQueryAll(db, connection, 'Account');
  const purchases = await ftQueryAll(db, connection, 'Purchase');
  const journals = await ftQueryAll(db, connection, 'JournalEntry');
  return {
    ...buildCardActivity({ accounts, purchases, journals }),
    counts: { accounts: accounts.length, purchases: purchases.length, journals: journals.length },
  };
};


// -- Card register (2026-09-23) ----------------------------------------------
// Every line QuickBooks has ever posted to a credit-card or line-of-credit
// account, dated and attributed to a project class, all years. Built on the
// General Ledger report (which sees transfers, bank-feed payments and opening
// balances the Purchase + JournalEntry feed above cannot). The ledger's own
// card-side line carries no class, so each transaction is attributed through
// its other side: purchase expense lines, journal-entry offset lines, the bills
// a card payment settled, deposit lines. Every transaction is expanded ONCE,
// and only kept expanded when its lines add back to what the ledger posted —
// otherwise the ledger lines stand — so the register always sums to the
// QuickBooks balance. Finance Tracker's payoff-by-project view is built on
// this. Amounts are signed from the card's point of view: positive = balance
// up (a charge), negative = balance down (a payment).
const CARD_REGISTER_COLUMNS = 'tx_date,txn_type,doc_num,name,memo,klass_name,split_acc,debt_amt,credit_amt,subt_nat_amount';

// Split `amount` across `parts` ([className, weight]) in proportion to weight;
// the last share absorbs rounding so the pieces always add back up exactly.
function ftApportion(amount, parts) {
  const r2 = (n) => Math.round(n * 100) / 100;
  const total = parts.reduce((s, [, w]) => s + Math.abs(w), 0);
  if (!(total > 0)) return [['', r2(amount)]];
  const byClass = new Map();
  for (const [cls, w] of parts) byClass.set(cls || '', (byClass.get(cls || '') || 0) + Math.abs(w));
  const out = [];
  let left = r2(amount);
  const entries = [...byClass.entries()];
  entries.forEach(([cls, w], i) => {
    const share = i === entries.length - 1 ? left : r2((amount * w) / total);
    out.push([cls, share]);
    left = r2(left - share);
  });
  return out;
}

router.financeTrackerCardRegister = async function financeTrackerCardRegister(startDate = '2010-01-01') {
  const db = getDb();
  const connection = ftGetConnection(db);
  const r2 = (n) => Math.round(n * 100) / 100;
  const accounts = await ftQueryAll(db, connection, 'Account');
  const isLoc = (a) => a.AccountSubType === 'LineOfCredit' || /\bLOC\b|line of credit/i.test(String(a.Name || ''));
  const targets = accounts.filter((a) => a.AccountType === 'Credit Card' || isLoc(a));
  // One scan at a time: five parallel paginated scans on top of the app's own
  // sync is what tripped QuickBooks' concurrency limit (429) on 2026-09-23.
  const purchases = await ftQueryAll(db, connection, 'Purchase');
  const journals = await ftQueryAll(db, connection, 'JournalEntry');
  const billPayments = await ftQueryAll(db, connection, 'BillPayment');
  const bills = await ftQueryAll(db, connection, 'Bill');
  const deposits = await ftQueryAll(db, connection, 'Deposit');
  const byId = (list) => new Map(list.map((x) => [String(x.Id), x]));
  const purchaseById = byId(purchases);
  const journalById = byId(journals);
  const billPaymentById = byId(billPayments);
  const billById = byId(bills);
  const depositById = byId(deposits);
  const lineClass = (l) => {
    const d = l.AccountBasedExpenseLineDetail || l.ItemBasedExpenseLineDetail || l.JournalEntryLineDetail || l.DepositLineDetail || {};
    return d.ClassRef?.name || '';
  };
  const realm = encodeURIComponent(connection.realm_id);
  const today = new Date().toISOString().slice(0, 10);
  const rows = [];
  const unexpanded = [];
  for (const account of targets) {
    const accountId = String(account.Id);
    const report = await qboRequest(
      db,
      connection,
      `/v3/company/${realm}/reports/GeneralLedger?start_date=${startDate}&end_date=${today}&account=${encodeURIComponent(accountId)}&columns=${CARD_REGISTER_COLUMNS}&accounting_method=Accrual`
    );
    const cols = (report?.Columns?.Column || []).map(
      (c) => (c.MetaData || []).find((m) => m.Name === 'ColKey')?.Value || c.ColType || ''
    );
    // 1. Collect the ledger lines, grouped by transaction (a transaction with
    //    several lines on this account appears once per line).
    const ledger = [];
    const walk = (section) => {
      for (const r of section?.Row || []) {
        if (Array.isArray(r.ColData) && r.type === 'Data') {
          const g = {};
          r.ColData.forEach((c, i) => { g[cols[i] || `col${i}`] = c?.value ?? ''; if (cols[i] === 'txn_type' && c?.id) g.txnId = String(c.id); });
          ledger.push({
            account: account.Name, accountId, date: g.tx_date || '', type: g.txn_type || '', txnId: g.txnId || '',
            docNum: g.doc_num || '', name: g.name || '', memo: g.memo || '', split: g.split_acc || '', klass: g.klass_name || '',
            amount: r2(Number(g.credit_amt || 0) - Number(g.debt_amt || 0)),
          });
        } else if (Array.isArray(r.ColData) && /beginning balance/i.test(String(r.ColData[0]?.value || ''))) {
          const g = {}; r.ColData.forEach((c, i) => { g[cols[i] || `col${i}`] = c?.value ?? ''; });
          ledger.push({ account: account.Name, accountId, date: startDate, type: 'Beginning Balance', txnId: '', docNum: '', name: '', memo: '', split: '', klass: '', amount: r2(Number(g.subt_nat_amount || 0)) });
        }
        if (r.Rows) walk(r.Rows);
      }
    };
    walk(report?.Rows);
    const groups = new Map();
    for (const line of ledger) {
      const key = line.txnId ? `${line.type}:${line.txnId}` : `line:${groups.size}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(line);
    }
    // 2. Expand each transaction once through its other side.
    for (const lines of groups.values()) {
      const base = lines[0];
      const ledgerTotal = r2(lines.reduce((s, l) => s + l.amount, 0));
      const kindOf = (amt, up, down) => (amt < 0 ? down : up);
      const purchase = purchaseById.get(base.txnId);
      const journal = journalById.get(base.txnId);
      const billPayment = billPaymentById.get(base.txnId);
      const deposit = depositById.get(base.txnId);
      let expanded = null;
      if (purchase && String(purchase.AccountRef?.value) === accountId) {
        const sign = purchase.Credit ? -1 : 1;
        expanded = [];
        for (const l of purchase.Line || []) {
          if (l.DetailType === 'SubTotalLineDetail') continue;
          const d = l.AccountBasedExpenseLineDetail || l.ItemBasedExpenseLineDetail || {};
          // A line booked to this very card is a wash against itself.
          if (String(d.AccountRef?.value) === accountId) continue;
          expanded.push({ ...base, klass: lineClass(l), split: d.AccountRef?.name || base.split, amount: r2(sign * Number(l.Amount || 0)), kind: purchase.Credit ? 'credit' : 'charge' });
        }
      } else if (journal) {
        const mine = [];
        const others = [];
        for (const l of journal.Line || []) {
          const d = l.JournalEntryLineDetail || {};
          if (String(d.AccountRef?.value) === accountId) mine.push(l);
          else others.push([lineClass(l), Number(l.Amount || 0)]);
        }
        if (mine.length) {
          expanded = [];
          for (const l of mine) {
            const d = l.JournalEntryLineDetail || {};
            const amt = d.PostingType === 'Credit' ? Number(l.Amount || 0) : -Number(l.Amount || 0);
            const own = lineClass(l);
            const classed = others.filter(([cls]) => cls);
            const parts = own ? [[own, 1]] : classed.length ? classed : [['', 1]];
            for (const [cls, share] of ftApportion(amt, parts)) expanded.push({ ...base, klass: cls, amount: share, kind: kindOf(amt, 'journal-charge', 'journal-payment') });
          }
        }
      } else if (billPayment) {
        const parts = [];
        for (const l of billPayment.Line || []) {
          for (const ref of l.LinkedTxn || []) {
            const bill = ref.TxnType === 'Bill' ? billById.get(String(ref.TxnId)) : null;
            if (!bill) continue;
            const billTotal = (bill.Line || []).reduce((s, bl) => s + Number(bl.Amount || 0), 0) || 1;
            for (const bl of bill.Line || []) parts.push([lineClass(bl), (Number(l.Amount || 0) * Number(bl.Amount || 0)) / billTotal]);
          }
        }
        if (parts.length) expanded = ftApportion(ledgerTotal, parts).map(([cls, share]) => ({ ...base, klass: cls, amount: share, kind: kindOf(ledgerTotal, 'bill-charge', 'payment') }));
      } else if (deposit) {
        const parts = (deposit.Line || []).filter((l) => String(l.DepositLineDetail?.AccountRef?.value) === accountId).map((l) => [lineClass(l), Number(l.Amount || 0)]);
        if (parts.length) expanded = ftApportion(ledgerTotal, parts).map(([cls, share]) => ({ ...base, klass: cls, amount: share, kind: kindOf(ledgerTotal, 'draw', 'payment') }));
      }
      // 3. Keep the expansion only when it adds back to the ledger.
      const expandedTotal = expanded ? r2(expanded.reduce((s, l) => s + l.amount, 0)) : null;
      if (expanded && Math.abs(expandedTotal - ledgerTotal) < 0.01) {
        rows.push(...expanded.filter((l) => l.amount !== 0));
      } else {
        if (expanded) unexpanded.push({ account: account.Name, txnId: base.txnId, type: base.type, date: base.date, ledgerTotal, expandedTotal });
        for (const l of lines) rows.push({ ...l, kind: l.type === 'Beginning Balance' ? 'opening' : kindOf(l.amount, 'charge', 'payment') });
      }
    }
  }
  return {
    accounts: targets.map((a) => ({ id: String(a.Id), name: a.Name, type: a.AccountType, subType: a.AccountSubType, balance: a.CurrentBalance })),
    rows,
    unexpanded,
    counts: { accounts: targets.length, rows: rows.length, purchases: purchases.length, journals: journals.length, billPayments: billPayments.length, bills: bills.length, deposits: deposits.length },
  };
};

// -- Read-only ledger + query (2026-09-23) ------------------------------------
// Two audit primitives for Finance Tracker, both read-only: the General Ledger
// of any account (dated, classed lines) and a SELECT-only QuickBooks query.
// They exist so an audit can look at the book directly instead of guessing
// from aggregates: e.g. rent deposited without a class, or a card paydown
// booked as a transfer.
router.financeTrackerLedger = async function financeTrackerLedger(accountKey, startDate, endDate) {
  const db = getDb();
  const connection = ftGetConnection(db);
  const accounts = await ftQueryAll(db, connection, 'Account');
  const key = String(accountKey || '').trim().toLowerCase();
  const account = accounts.find((a) => String(a.Id) === key)
    || accounts.find((a) => String(a.Name || '').toLowerCase() === key)
    || accounts.find((a) => String(a.FullyQualifiedName || '').toLowerCase() === key)
    || accounts.find((a) => String(a.Name || '').toLowerCase().includes(key));
  if (!account) {
    const err = new Error(`No QuickBooks account matches "${accountKey}".`);
    err.statusCode = 404;
    throw err;
  }
  const realm = encodeURIComponent(connection.realm_id);
  const report = await qboRequest(
    db,
    connection,
    `/v3/company/${realm}/reports/GeneralLedger?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&account=${encodeURIComponent(account.Id)}&columns=${CARD_REGISTER_COLUMNS}&accounting_method=Accrual`
  );
  const cols = (report?.Columns?.Column || []).map(
    (c) => (c.MetaData || []).find((m) => m.Name === 'ColKey')?.Value || c.ColType || ''
  );
  const rows = [];
  const walk = (section) => {
    for (const r of section?.Row || []) {
      if (Array.isArray(r.ColData) && r.type === 'Data') {
        const g = {};
        r.ColData.forEach((c, i) => { g[cols[i] || `col${i}`] = c?.value ?? ''; if (cols[i] === 'txn_type' && c?.id) g.txnId = String(c.id); });
        rows.push(g);
      }
      if (r.Rows) walk(r.Rows);
    }
  };
  walk(report?.Rows);
  return { account: { id: String(account.Id), name: account.Name, type: account.AccountType, balance: account.CurrentBalance }, rows };
};

router.financeTrackerQuery = async function financeTrackerQuery(query) {
  const q = String(query || '').trim();
  if (!/^select\s/i.test(q) || /;/.test(q)) {
    const err = new Error('Only a single SELECT statement is allowed.');
    err.statusCode = 400;
    throw err;
  }
  const db = getDb();
  const connection = ftGetConnection(db);
  return qboQuery(db, connection, q);
};

const financeCompanies = require('../services/financeCompanies')({ getDb, qboConfig, qboEnvironment, qboApiBase, redirectUri, tokenRequest, encryptSecret, addSeconds, qboRequest, qboQuery, logActivity });
router.financeCompanies = financeCompanies;

// -- Bank Draws (2026-10-19) ---------------------------------------------------
// The project Bank Draws tab (Mike, 2026-10-19): QuickBooks account 1130 (Funds in
// Escrow / Holdbacks) allocated by class - the draws - plus the project's Balance
// Sheet and life-to-date Profit & Loss for its class. Read-only: the Account and
// Class lists, one General Ledger report per account, and the two statements
// summarized by class (each column carries the class id as its ColKey).
// Classification and statement parsing live in services/bankDraws.js.
const BANK_DRAW_LEDGER_COLUMNS = 'tx_date,txn_type,doc_num,name,memo,klass_name,split_acc,debt_amt,credit_amt';

// Bank Draws and Consolidated Finances re-read these whenever a page finds its copy older
// than a few minutes; the read cache answers until New Urban changes (2026-10-23).
router.projectFinanceReports = (accountNumbers, startDate) => withQboPurpose(
  'bank_draws',
  () => projectFinanceReportsLive(accountNumbers, startDate),
  { cache: true }
);

async function projectFinanceReportsLive(accountNumbers, startDate = '2015-01-01') {
  const db = getDb();
  const connection = ftGetConnection(db);
  const realm = encodeURIComponent(connection.realm_id);
  const accounts = await ftQueryAll(db, connection, 'Account');
  const classPayload = await qboQuery(db, connection, 'SELECT * FROM Class WHERE Active IN (true, false) MAXRESULTS 1000');
  const classes = (classPayload?.QueryResponse?.Class || []).map(c => ({
    id: String(c.Id),
    name: c.Name || '',
    fullName: c.FullyQualifiedName || c.Name || '',
    parentId: c.ParentRef?.value ? String(c.ParentRef.value) : null,
    active: c.Active !== false,
  }));
  const endDate = new Date().toISOString().slice(0, 10);
  const ledgers = [];
  for (const number of accountNumbers) {
    const account = accounts.find(a => String(a.AcctNum || '') === String(number));
    if (!account) continue;
    const report = await qboRequest(
      db,
      connection,
      `/v3/company/${realm}/reports/GeneralLedger?start_date=${encodeURIComponent(startDate)}&end_date=${endDate}&account=${encodeURIComponent(account.Id)}&columns=${BANK_DRAW_LEDGER_COLUMNS}&accounting_method=Accrual`
    );
    const cols = (report?.Columns?.Column || []).map(
      (c) => (c.MetaData || []).find((m) => m.Name === 'ColKey')?.Value || c.ColType || ''
    );
    const rows = [];
    const walk = (section) => {
      for (const r of section?.Row || []) {
        if (Array.isArray(r.ColData) && r.type === 'Data') {
          const g = {};
          r.ColData.forEach((c, i) => { g[cols[i] || `col${i}`] = c?.value ?? ''; if (cols[i] === 'txn_type' && c?.id) g.txnId = String(c.id); });
          rows.push(g);
        }
        if (r.Rows) walk(r.Rows);
      }
    };
    walk(report?.Rows);
    ledgers.push({ number: String(number), id: String(account.Id), name: account.Name, type: account.AccountType, rows });
  }
  const bankAccountNames = accounts
    .filter(a => a.AccountType === 'Bank')
    .map(a => [a.AcctNum ? `${a.AcctNum} ${a.Name}` : '', a.Name, a.FullyQualifiedName].filter(Boolean))
    .flat();
  const balanceSheet = await qboRequest(db, connection, `/v3/company/${realm}/reports/BalanceSheet?summarize_column_by=Classes&accounting_method=Accrual&date_macro=Today`);
  const profitLoss = await qboRequest(db, connection, `/v3/company/${realm}/reports/ProfitAndLoss?summarize_column_by=Classes&accounting_method=Accrual&start_date=${encodeURIComponent(startDate)}&end_date=${endDate}`);
  // The last 12 months by class, for the monthly rent / interest / expenses on rentals
  // (Consolidated Finances, Mike 2026-10-19).
  const ttmStartDate = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 12, new Date().getUTCDate() + 1)).toISOString().slice(0, 10);
  const profitLossTtm = await qboRequest(db, connection, `/v3/company/${realm}/reports/ProfitAndLoss?summarize_column_by=Classes&accounting_method=Accrual&start_date=${ttmStartDate}&end_date=${endDate}`);
  return {
    realmId: String(connection.realm_id),
    classes,
    ledgers,
    bankAccountNames,
    balanceSheet,
    profitLoss,
    profitLossTtm,
    period: { start: startDate, end: endDate, ttm_start: ttmStartDate },
  };
}

// -- Seifert Books import (2026-10-23) ---------------------------------------------------
// Seifert Books (books.seifertcapital.com) copies every QuickBooks company this app is
// connected to. These back /api/service/finance-tracker/companies/:tenant/{query,report,
// companyinfo,cdc}: one SELECT, one whitelisted report, CompanyInfo + Preferences, or the
// change feed - reads only, and the tokens never leave BuildTrack. Tenant 'primary' is New
// Urban; any other is a Finance-hub tenant id. Metered as 'books_import' and never cached
// (one full copy, then change feeds); it yields to bills when the month's budget runs low.
const BOOKS_PURPOSE = 'books_import';
const BOOKS_REPORTS = new Set(['TrialBalance', 'BalanceSheet', 'ProfitAndLoss', 'GeneralLedger', 'AgedReceivables', 'AgedPayables']);

function booksError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function booksConnection(db, tenant) {
  const key = String(tenant || '');
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key)) throw booksError(400, 'Invalid company.');
  const connection = key === 'primary'
    ? db.prepare("SELECT * FROM quickbooks_connections WHERE id = 'primary' AND is_active = 1").get()
    : db.prepare('SELECT * FROM quickbooks_connections WHERE id = ? AND is_active = 1').get(`finance:${key}`);
  if (!connection) throw booksError(404, 'No connected QuickBooks company by that name.');
  return connection;
}

router.booksQuery = (tenant, query) => withQboPurpose(BOOKS_PURPOSE, async () => {
  const q = String(query || '').trim();
  if (!/^select\s/i.test(q) || /;/.test(q)) throw booksError(400, 'Only a single SELECT statement is allowed.');
  const db = getDb();
  return qboQuery(db, booksConnection(db, tenant), q);
});

router.booksReport = (tenant, name, params = {}) => withQboPurpose(BOOKS_PURPOSE, async () => {
  if (!BOOKS_REPORTS.has(String(name))) throw booksError(400, `Report must be one of: ${Array.from(BOOKS_REPORTS).join(', ')}.`);
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    // minorversion is BuildTrack's to set; anything not a plain name=value pair is dropped.
    if (!/^[a-z_]{1,40}$/i.test(key) || key.toLowerCase() === 'minorversion' || typeof value !== 'string' || value.length > 500) continue;
    search.append(key, value);
  }
  const db = getDb();
  const connection = booksConnection(db, tenant);
  const qs = search.toString();
  return qboRequest(db, connection, `/v3/company/${encodeURIComponent(connection.realm_id)}/reports/${name}${qs ? `?${qs}` : ''}`);
});

router.booksCompanyInfo = tenant => withQboPurpose(BOOKS_PURPOSE, async () => {
  const db = getDb();
  const connection = booksConnection(db, tenant);
  const realm = encodeURIComponent(connection.realm_id);
  const info = await qboRequest(db, connection, `/v3/company/${realm}/companyinfo/${realm}`);
  const preferences = await qboRequest(db, connection, `/v3/company/${realm}/preferences`);
  return {
    realmId: String(connection.realm_id),
    companyName: connection.company_name,
    CompanyInfo: info?.CompanyInfo || null,
    Preferences: preferences?.Preferences || null,
  };
});

router.booksChangeFeed = (tenant, entities, since) => withQboPurpose(BOOKS_PURPOSE, async () => {
  const names = String(entities || '').split(',').map(name => name.trim()).filter(Boolean);
  if (!names.length || names.length > 30 || names.some(name => !/^[A-Za-z]{2,40}$/.test(name))) {
    throw booksError(400, 'entities must be a comma-separated list of QuickBooks entity names.');
  }
  const sinceMs = Date.parse(String(since || ''));
  if (!Number.isFinite(sinceMs) || Date.now() - sinceMs > FT_TXN_CDC_MAX_LOOKBACK_MS || sinceMs > Date.now() + 60 * 1000) {
    throw booksError(400, 'since must be an ISO time within the last 29 days.');
  }
  const db = getDb();
  const connection = booksConnection(db, tenant);
  return qboRequest(db, connection, `/v3/company/${encodeURIComponent(connection.realm_id)}/cdc?entities=${names.join(',')}&changedSince=${encodeURIComponent(new Date(sinceMs).toISOString())}`);
});
