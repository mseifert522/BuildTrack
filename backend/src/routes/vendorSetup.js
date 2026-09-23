// "Set Up New Vendor" on the Contractors / Suppliers page.
//
// Staff enter a company name + email; BuildTrack emails the vendor a secure link
// (copy to info@newurbandev.com). The vendor verifies with an emailed code, then
// sends a W-9 (typed online or uploaded), a certificate of insurance, and ACH
// details with a deposit authorization. On submit BuildTrack creates the vendor
// (or fills in the existing one it matches) and stores the tax/bank data in
// contractor_compliance_profiles, the same place the older contractor setup uses,
// so the page's "Show Full Details" reveal works unchanged.
//
// Roles (Mike, 2026-09-23): super admins, operations managers and project managers
// may send and resend setup requests; only super admins and operations managers
// may delete. Full W-9 / bank documents follow the 1099 reveal rule (SA/OM).
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const { getDb } = require('../db/schema');
const { authenticate, authorize } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { logDataAccess, getClientIp } = require('../utils/dataAccessAudit');
const { encryptJson, decryptJson } = require('../utils/secureFields');
const { normalizeEmail } = require('../utils/contractorAccess');
const { NUD_COMPANY, PAYMENT_POLICY } = require('../utils/companyInfo');
const {
  isEmailConfigured,
  sendVendorSetupInviteEmail,
  sendVendorSetupCodeEmail,
  sendVendorSetupSubmittedEmail,
  sendVendorSetupConfirmationEmail,
} = require('../utils/email');
const {
  sniffFileType,
  typeInfo,
  sanitizeOriginalName,
  writeSealedFile,
  readSealedFile,
  removeSealedFile,
} = require('../utils/vendorSetupFiles');

const router = express.Router();

const MANAGEMENT_ROLES = ['super_admin', 'operations_manager', 'project_manager'];
const DELETE_ROLES = ['super_admin', 'operations_manager'];
const SENSITIVE_ROLES = ['super_admin', 'operations_manager'];
const SENSITIVE_KINDS = new Set(['w9', 'bank']);
const FILE_KINDS = ['w9', 'insurance', 'bank'];
const KIND_LABELS = { w9: 'W-9', insurance: 'Certificate of insurance', bank: 'Bank document' };
// Browsers render these in the staff viewer; everything else downloads.
const INLINE_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']);

const INVITE_DAYS = 14;
const CODE_MINUTES = 10;
const CODE_MAX_ATTEMPTS = 5;
const CODE_RESEND_WINDOW_MINUTES = 5;
const CODE_RESEND_LIMIT = 2;
const CODE_DAILY_LIMIT = 10;
const SESSION_MINUTES = 60;
const SESSION_REFRESH_AFTER_MINUTES = 10;
const SESSION_MAX_HOURS = 8;
const MAX_FILE_MB = 20;
const MAX_FILES_PER_KIND = 10;
const MAX_CONCURRENT_UPLOADS = 3;
const ABANDONED_PURGE_DAYS = 30;

const TAX_CLASSIFICATIONS = {
  individual: 'Individual / sole proprietor or single-member LLC',
  c_corporation: 'C corporation',
  s_corporation: 'S corporation',
  partnership: 'Partnership',
  trust_estate: 'Trust / estate',
  llc: 'Limited liability company (LLC)',
  other: 'Other',
};
const LLC_TAX_CLASSES = { C: 'C corporation', S: 'S corporation', P: 'Partnership' };
const EIN_REQUIRED = new Set(['c_corporation', 's_corporation', 'partnership', 'trust_estate', 'llc']);

// ── small helpers ────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function httpError(statusCode, message, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function sendError(res, err, fallback) {
  if (!err.statusCode || err.statusCode >= 500) console.error(`[vendor-setup] ${fallback}:`, err);
  const body = { error: err.statusCode ? err.message : fallback };
  if (err.details) body.details = err.details;
  if (err.fields) body.fields = err.fields;
  if (err.retry_after_seconds) body.retry_after_seconds = err.retry_after_seconds;
  res.status(err.statusCode || 500).json(body);
}

function cleanString(value, max = 200) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function cleanDigits(value, max = 32) {
  return String(value ?? '').replace(/\D/g, '').slice(0, max);
}

function isTrue(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function codeHash(inviteId, code) {
  return crypto.createHash('sha256').update(`${inviteId}:${code}`).digest('hex');
}

function baseUrl() {
  return (process.env.APP_URL || process.env.FRONTEND_URL || 'https://buildtrack.newurbandev.com').replace(/\/+$/, '');
}

function officeEmail() {
  return process.env.VENDOR_SETUP_OFFICE_EMAIL || NUD_COMPANY.email;
}

function emailHint(email) {
  const [local, domain] = String(email || '').split('@');
  if (!local || !domain) return '';
  return `${local.slice(0, 2)}***@${domain}`;
}

function isExpired(invite) {
  return invite.status !== 'submitted' && Date.parse(invite.expires_at) <= Date.now();
}

function effectiveStatus(invite) {
  if (invite.status === 'submitted') return 'submitted';
  if (isExpired(invite)) return 'expired';
  return invite.status;
}

function normalizeVendorName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function formatAddress(p) {
  return [
    p.address_line1,
    p.address_line2,
    [p.city, [p.state, p.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', '),
  ].filter(Boolean).join('\n');
}

// In-process attempt counters (single container; same pattern as routes/auth.js).
const attemptBuckets = new Map();
function tooMany(key, max, windowMs) {
  const now = Date.now();
  const rec = attemptBuckets.get(key);
  if (!rec || now - rec.first > windowMs) {
    attemptBuckets.set(key, { count: 1, first: now });
    return false;
  }
  rec.count += 1;
  return rec.count > max;
}
const attemptSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of attemptBuckets) {
    if (now - rec.first > 2 * 60 * 60 * 1000) attemptBuckets.delete(key);
  }
}, 10 * 60 * 1000);
if (attemptSweep.unref) attemptSweep.unref();

function limitByIp(name, max, windowMs, message = 'Too many requests. Please wait a few minutes and try again.') {
  return (req, res, next) => {
    if (tooMany(`${name}:${getClientIp(req) || 'unknown'}`, max, windowMs)) {
      return res.status(429).json({ error: message });
    }
    next();
  };
}

// ── vendor matching ──────────────────────────────────────────────────────────

// An email match on the profile or its QuickBooks record is decisive; otherwise an
// exact (letters + digits) name match, which is the same identity the directory
// already merges rows on. Linked-to-QuickBooks profiles win ties.
function findMatchingVendor(db, { email, companyName }) {
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail) {
    const byEmail = db.prepare(`
      SELECT id, vendor_name, quickbooks_vendor_id
      FROM contractor_profiles
      WHERE lower(trim(COALESCE(email, ''))) = ? OR lower(trim(COALESCE(quickbooks_primary_email, ''))) = ?
      ORDER BY quickbooks_vendor_id IS NOT NULL DESC, julianday(updated_at) DESC
      LIMIT 1
    `).get(normalizedEmail, normalizedEmail);
    if (byEmail) return { ...byEmail, match_kind: 'email' };
  }
  const key = normalizeVendorName(companyName);
  if (key.length < 3) return null;
  const candidates = db.prepare(`
    SELECT id, vendor_name, quickbooks_display_name, quickbooks_company_name, quickbooks_vendor_id, updated_at
    FROM contractor_profiles
  `).all().filter(row => [row.vendor_name, row.quickbooks_display_name, row.quickbooks_company_name]
    .some(name => name && normalizeVendorName(name) === key));
  if (!candidates.length) return null;
  candidates.sort((a, b) => Number(Boolean(b.quickbooks_vendor_id)) - Number(Boolean(a.quickbooks_vendor_id))
    || String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const best = candidates[0];
  return { id: best.id, vendor_name: best.vendor_name, quickbooks_vendor_id: best.quickbooks_vendor_id, match_kind: 'name' };
}

// ── invite shapes ────────────────────────────────────────────────────────────

const INVITE_SELECT = `
  SELECT
    vsi.*,
    u.name AS requested_by_name,
    cp.vendor_name AS contractor_name,
    (SELECT COUNT(*) FROM vendor_setup_files f WHERE f.invite_id = vsi.id AND f.kind = 'w9') AS w9_file_count,
    (SELECT COUNT(*) FROM vendor_setup_files f WHERE f.invite_id = vsi.id AND f.kind = 'insurance') AS insurance_file_count,
    (SELECT COUNT(*) FROM vendor_setup_files f WHERE f.invite_id = vsi.id AND f.kind = 'bank') AS bank_file_count
  FROM vendor_setup_invites vsi
  LEFT JOIN users u ON u.id = vsi.requested_by
  LEFT JOIN contractor_profiles cp ON cp.id = vsi.contractor_id
`;

function inviteShape(row, user) {
  return {
    id: row.id,
    company_name: row.company_name,
    email: row.email,
    vendor_type: row.vendor_type,
    status: effectiveStatus(row),
    created_at: row.created_at,
    last_sent_at: row.last_sent_at,
    send_count: Number(row.send_count || 0),
    opened_at: row.opened_at,
    verified_at: row.verified_at,
    submitted_at: row.submitted_at,
    expires_at: row.expires_at,
    requested_by_name: row.requested_by_name || null,
    contractor_id: row.contractor_id || null,
    contractor_name: row.contractor_name || null,
    match_kind: row.match_kind || null,
    w9_method: row.w9_method || null,
    file_counts: {
      w9: Number(row.w9_file_count || 0),
      insurance: Number(row.insurance_file_count || 0),
      bank: Number(row.bank_file_count || 0),
    },
    can_delete: Boolean(user && DELETE_ROLES.includes(user.role)),
  };
}

function loadInvite(db, id) {
  return db.prepare(`${INVITE_SELECT} WHERE vsi.id = ?`).get(id);
}

function fileShape(row, user) {
  return {
    id: row.id,
    kind: row.kind,
    kind_label: KIND_LABELS[row.kind] || row.kind,
    original_name: row.original_name,
    mime_type: row.mime_type,
    size_bytes: Number(row.size_bytes || 0),
    uploaded_at: row.uploaded_at,
    can_view: !user || !SENSITIVE_KINDS.has(row.kind) || SENSITIVE_ROLES.includes(user.role),
    inline: INLINE_MIME_TYPES.has(row.mime_type),
  };
}

function removeFilesWhere(db, whereSql, params) {
  const rows = db.prepare(`SELECT id, storage_path FROM vendor_setup_files WHERE ${whereSql}`).all(...params);
  if (!rows.length) return 0;
  db.prepare(`DELETE FROM vendor_setup_files WHERE ${whereSql}`).run(...params);
  rows.forEach(row => removeSealedFile(row.storage_path));
  return rows.length;
}

// Abandoned links: drop drafts and unsubmitted uploads (W-9s carry SSNs) 30 days
// after the link expired. Opportunistic, at most hourly; no scheduler needed.
let lastAbandonedPurgeAt = 0;
function purgeAbandonedUploads(db) {
  if (Date.now() - lastAbandonedPurgeAt < 60 * 60 * 1000) return;
  lastAbandonedPurgeAt = Date.now();
  try {
    const cutoff = new Date(Date.now() - ABANDONED_PURGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const stale = db.prepare(`
      SELECT id FROM vendor_setup_invites
      WHERE status != 'submitted' AND julianday(expires_at) < julianday(?)
    `).all(cutoff);
    for (const invite of stale) {
      db.prepare('DELETE FROM vendor_setup_drafts WHERE invite_id = ?').run(invite.id);
      removeFilesWhere(db, "invite_id = ? AND status = 'pending'", [invite.id]);
    }
    // Uploads orphaned by a deleted invite that were never submitted.
    removeFilesWhere(db, "invite_id IS NULL AND contractor_id IS NULL AND status = 'pending'", []);
  } catch (err) {
    console.error('[vendor-setup] abandoned-upload purge failed:', err?.message || err);
  }
}

// ── management: invites ──────────────────────────────────────────────────────

router.get('/invites', authenticate, authorize(...MANAGEMENT_ROLES), (req, res) => {
  try {
    const db = getDb();
    purgeAbandonedUploads(db);
    // Waiting / expired requests, plus completed ones for 60 days.
    const rows = db.prepare(`${INVITE_SELECT}
      WHERE vsi.status != 'submitted' OR julianday(vsi.submitted_at) > julianday('now', '-60 days')
      ORDER BY julianday(COALESCE(vsi.submitted_at, vsi.last_sent_at, vsi.created_at)) DESC
      LIMIT 200
    `).all();
    res.json({ invites: rows.map(row => inviteShape(row, req.user)) });
  } catch (err) {
    sendError(res, err, 'Unable to load vendor setup requests');
  }
});

async function sendInviteEmailOrThrow(invite, rawToken) {
  const setupUrl = `${baseUrl()}/vendor-setup/${rawToken}`;
  await sendVendorSetupInviteEmail({
    companyName: invite.company_name,
    email: invite.email,
    ccEmail: officeEmail(),
    setupUrl,
    expiresAt: invite.expires_at,
  });
  return setupUrl;
}

router.post('/invites', authenticate, authorize(...MANAGEMENT_ROLES), async (req, res) => {
  const db = getDb();
  let inviteId = null;
  try {
    const companyName = cleanString(req.body?.company_name, 150);
    const email = normalizeEmail(req.body?.email);
    const vendorType = req.body?.vendor_type === 'supplier' ? 'supplier' : 'contractor';
    if (!companyName) throw httpError(400, 'Enter the company name');
    if (!email) throw httpError(400, 'Enter a valid company email address');
    if (!isEmailConfigured()) throw httpError(503, 'Email is not configured on this server, so the setup request cannot be sent');

    const open = db.prepare(`
      SELECT id, created_at, last_sent_at, expires_at, status FROM vendor_setup_invites
      WHERE email = ? AND status IN ('sent', 'verified')
      ORDER BY julianday(created_at) DESC
    `).all(email).find(row => Date.parse(row.expires_at) > Date.now());
    if (open) {
      throw httpError(409, `A setup request is already waiting on ${email}. Use Resend on that request instead of sending a second one.`, { invite_id: open.id });
    }

    const match = findMatchingVendor(db, { email, companyName });
    const rawToken = crypto.randomBytes(32).toString('hex');
    const now = nowIso();
    inviteId = uuidv4();
    const invite = {
      id: inviteId,
      company_name: companyName,
      email,
      vendor_type: vendorType,
      expires_at: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    };
    db.prepare(`
      INSERT INTO vendor_setup_invites (
        id, company_name, email, vendor_type, token_hash, status, expires_at, send_count, last_sent_at,
        contractor_id, match_kind, requested_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'sent', ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      inviteId, companyName, email, vendorType, tokenHash(rawToken), invite.expires_at, now,
      match?.id || null, match?.match_kind || null, req.user.id, now, now
    );

    let setupUrl;
    try {
      setupUrl = await sendInviteEmailOrThrow(invite, rawToken);
    } catch (mailErr) {
      db.prepare('DELETE FROM vendor_setup_invites WHERE id = ?').run(inviteId);
      console.error('[vendor-setup] invite email failed:', mailErr?.message || mailErr);
      throw httpError(502, 'The setup email could not be sent. Check the email address and try again.');
    }

    logActivity({
      userId: req.user.id,
      action: 'vendor_setup_requested',
      entityType: 'vendor_setup_invite',
      entityId: inviteId,
      details: {
        company_name: companyName,
        email,
        vendor_type: vendorType,
        matched_vendor: match ? match.vendor_name : null,
        match_kind: match?.match_kind || null,
      },
    });

    res.status(201).json({
      invite: inviteShape(loadInvite(db, inviteId), req.user),
      setup_url: setupUrl,
      sent_to: email,
      cc: officeEmail(),
      matched_vendor: match ? { id: match.id, name: match.vendor_name, match_kind: match.match_kind } : null,
    });
  } catch (err) {
    sendError(res, err, 'Unable to send the vendor setup request');
  }
});

// A vendor who already started keeps what they typed, but fields that still hold
// only our prefill follow a correction made on resend - otherwise their saved draft
// would put the old company name / email straight back on the form.
function syncDraftPrefill(db, inviteId, changes) {
  const row = db.prepare('SELECT data_encrypted FROM vendor_setup_drafts WHERE invite_id = ?').get(inviteId);
  if (!row) return;
  try {
    const draft = decryptJson(row.data_encrypted) || {};
    let touched = false;
    for (const [field, [from, to]] of Object.entries(changes)) {
      if (from === to) continue;
      const current = String(draft[field] ?? '').trim();
      if (!current || current.toLowerCase() === String(from || '').trim().toLowerCase()) {
        draft[field] = to;
        touched = true;
      }
    }
    if (touched) {
      db.prepare('UPDATE vendor_setup_drafts SET data_encrypted = ?, updated_at = ? WHERE invite_id = ?')
        .run(encryptJson(draft), nowIso(), inviteId);
    }
  } catch (err) {
    console.error('[vendor-setup] draft prefill sync failed:', err?.message || err);
  }
}

router.post('/invites/:id/resend', authenticate, authorize(...MANAGEMENT_ROLES), async (req, res) => {
  try {
    const db = getDb();
    const invite = db.prepare('SELECT * FROM vendor_setup_invites WHERE id = ?').get(req.params.id);
    if (!invite) throw httpError(404, 'Setup request not found');
    if (invite.status === 'submitted') throw httpError(409, 'This vendor already completed their setup');
    if (!isEmailConfigured()) throw httpError(503, 'Email is not configured on this server, so the setup request cannot be sent');

    const nextEmail = req.body?.email !== undefined ? normalizeEmail(req.body.email) : invite.email;
    if (!nextEmail) throw httpError(400, 'Enter a valid company email address');
    // The resend dialog shows both for confirmation and lets staff correct either.
    const nextCompany = req.body?.company_name !== undefined ? cleanString(req.body.company_name, 150) : invite.company_name;
    if (!nextCompany) throw httpError(400, 'Enter the company name');
    if (nextEmail !== invite.email) {
      const other = db.prepare(`
        SELECT id, expires_at FROM vendor_setup_invites
        WHERE email = ? AND id != ? AND status IN ('sent', 'verified')
      `).all(nextEmail, invite.id).find(row => Date.parse(row.expires_at) > Date.now());
      if (other) throw httpError(409, `Another setup request is already waiting on ${nextEmail}`);
    }

    // A new link replaces the old one (only its hash is stored, so the old link
    // cannot be re-sent). A vendor already verified keeps working in their session.
    const rawToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const previous = {
      token_hash: invite.token_hash,
      expires_at: invite.expires_at,
      email: invite.email,
      company_name: invite.company_name,
      last_sent_at: invite.last_sent_at,
      contractor_id: invite.contractor_id,
      match_kind: invite.match_kind,
    };
    // A corrected name or email can point at a different existing vendor (or none),
    // so the match made when the request was created is redone.
    const identityChanged = nextEmail !== invite.email || nextCompany !== invite.company_name;
    const match = identityChanged ? findMatchingVendor(db, { email: nextEmail, companyName: nextCompany }) : null;
    const nextContractorId = identityChanged ? (match?.id || null) : invite.contractor_id;
    const nextMatchKind = identityChanged ? (match?.match_kind || null) : invite.match_kind;
    const now = nowIso();
    db.prepare(`
      UPDATE vendor_setup_invites
      SET token_hash = ?, expires_at = ?, email = ?, company_name = ?, contractor_id = ?, match_kind = ?,
          send_count = send_count + 1, last_sent_at = ?, updated_at = ?
      WHERE id = ?
    `).run(tokenHash(rawToken), expiresAt, nextEmail, nextCompany, nextContractorId, nextMatchKind, now, now, invite.id);

    let setupUrl;
    try {
      setupUrl = await sendInviteEmailOrThrow({ ...invite, email: nextEmail, company_name: nextCompany, expires_at: expiresAt }, rawToken);
    } catch (mailErr) {
      // Only undo our own update: if an already-verified vendor submitted while the
      // email was in flight, their submission (and its contractor_id) must stand.
      db.prepare(`
        UPDATE vendor_setup_invites
        SET token_hash = ?, expires_at = ?, email = ?, company_name = ?, contractor_id = ?, match_kind = ?,
            send_count = send_count - 1, last_sent_at = ?, updated_at = ?
        WHERE id = ? AND token_hash = ? AND status != 'submitted'
      `).run(previous.token_hash, previous.expires_at, previous.email, previous.company_name, previous.contractor_id, previous.match_kind, previous.last_sent_at, nowIso(), invite.id, tokenHash(rawToken));
      console.error('[vendor-setup] resend email failed:', mailErr?.message || mailErr);
      throw httpError(502, 'The setup email could not be sent. Check the email address and try again.');
    }

    syncDraftPrefill(db, invite.id, {
      company_name: [invite.company_name, nextCompany],
      account_holder_name: [invite.company_name, nextCompany],
      email: [invite.email, nextEmail],
    });

    logActivity({
      userId: req.user.id,
      action: 'vendor_setup_resent',
      entityType: 'vendor_setup_invite',
      entityId: invite.id,
      details: {
        company_name: nextCompany,
        email: nextEmail,
        email_changed: nextEmail !== invite.email,
        company_name_changed: nextCompany !== invite.company_name,
        previous_company_name: nextCompany !== invite.company_name ? invite.company_name : undefined,
        matched_vendor: identityChanged ? (match?.vendor_name || null) : undefined,
      },
    });

    res.json({
      invite: inviteShape(loadInvite(db, invite.id), req.user),
      setup_url: setupUrl,
      sent_to: nextEmail,
      cc: officeEmail(),
      matched_vendor: match ? { id: match.id, name: match.vendor_name, match_kind: match.match_kind } : null,
    });
  } catch (err) {
    sendError(res, err, 'Unable to resend the vendor setup request');
  }
});

router.delete('/invites/:id', authenticate, authorize(...DELETE_ROLES), (req, res) => {
  try {
    const db = getDb();
    const invite = db.prepare('SELECT * FROM vendor_setup_invites WHERE id = ?').get(req.params.id);
    if (!invite) throw httpError(404, 'Setup request not found');

    // Unsubmitted uploads go with the request. Submitted documents belong to the
    // vendor record now and stay (delete the vendor to remove them).
    let removedFiles = 0;
    db.transaction(() => {
      removedFiles = removeFilesWhere(db, "invite_id = ? AND status = 'pending'", [invite.id]);
      db.prepare('DELETE FROM vendor_setup_invites WHERE id = ?').run(invite.id);
    })();

    logActivity({
      userId: req.user.id,
      action: 'vendor_setup_deleted',
      entityType: 'vendor_setup_invite',
      entityId: invite.id,
      details: { company_name: invite.company_name, email: invite.email, status: effectiveStatus(invite), removed_uploads: removedFiles },
    });
    res.json({ message: invite.status === 'submitted' ? 'Setup request removed from the list' : 'Setup request cancelled' });
  } catch (err) {
    sendError(res, err, 'Unable to delete the vendor setup request');
  }
});

// ── management: a vendor's setup documents ───────────────────────────────────

router.get('/vendors/:contractorId/documents', authenticate, authorize(...MANAGEMENT_ROLES), (req, res) => {
  try {
    const db = getDb();
    const contractor = db.prepare('SELECT id, vendor_name FROM contractor_profiles WHERE id = ?').get(req.params.contractorId);
    if (!contractor) throw httpError(404, 'Vendor not found');
    const files = db.prepare(`
      SELECT * FROM vendor_setup_files
      WHERE contractor_id = ? AND status = 'submitted'
      ORDER BY CASE kind WHEN 'w9' THEN 0 WHEN 'insurance' THEN 1 ELSE 2 END, julianday(uploaded_at)
    `).all(contractor.id);
    const setup = db.prepare(`${INVITE_SELECT}
      WHERE vsi.contractor_id = ? AND vsi.status = 'submitted'
      ORDER BY julianday(vsi.submitted_at) DESC LIMIT 1
    `).get(contractor.id);
    res.json({
      documents: files.map(row => fileShape(row, req.user)),
      setup: setup ? inviteShape(setup, req.user) : null,
      can_view_sensitive: SENSITIVE_ROLES.includes(req.user.role),
      can_delete: DELETE_ROLES.includes(req.user.role),
    });
  } catch (err) {
    sendError(res, err, 'Unable to load vendor documents');
  }
});

router.get('/files/:fileId', authenticate, authorize(...MANAGEMENT_ROLES), (req, res) => {
  try {
    const db = getDb();
    const file = db.prepare(`
      SELECT f.*, cp.vendor_name FROM vendor_setup_files f
      LEFT JOIN contractor_profiles cp ON cp.id = f.contractor_id
      WHERE f.id = ? AND f.status = 'submitted'
    `).get(req.params.fileId);
    if (!file) throw httpError(404, 'Document not found');
    const sensitive = SENSITIVE_KINDS.has(file.kind);
    if (sensitive && !SENSITIVE_ROLES.includes(req.user.role)) {
      throw httpError(403, 'Only super admins and operations managers can open W-9 and bank documents');
    }

    let content;
    try {
      content = readSealedFile(file.storage_path);
    } catch (readErr) {
      console.error('[vendor-setup] could not read document', file.id, readErr?.message || readErr);
      throw httpError(410, 'This document is no longer available');
    }

    const details = { vendor_name: file.vendor_name, kind: file.kind, file_name: file.original_name };
    logDataAccess(req, {
      action: 'vendor_setup_document_viewed',
      accessType: sensitive ? 'sensitive_view' : 'view',
      entityType: 'vendor_setup_file',
      entityId: file.id,
      riskLevel: sensitive ? 'critical' : 'high',
      details,
    });
    if (sensitive) {
      logActivity({
        userId: req.user.id,
        action: 'vendor_setup_document_viewed',
        entityType: 'contractor_profile',
        entityId: file.contractor_id,
        details,
      });
    }

    const inline = req.query.download !== '1' && fileShape(file).inline;
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', content.length);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; sandbox");
    res.end(content);
  } catch (err) {
    sendError(res, err, 'Unable to open the document');
  }
});

router.delete('/files/:fileId', authenticate, authorize(...DELETE_ROLES), (req, res) => {
  try {
    const db = getDb();
    const file = db.prepare('SELECT * FROM vendor_setup_files WHERE id = ?').get(req.params.fileId);
    if (!file) throw httpError(404, 'Document not found');
    removeFilesWhere(db, 'id = ?', [file.id]);
    logActivity({
      userId: req.user.id,
      action: 'vendor_setup_document_deleted',
      entityType: 'contractor_profile',
      entityId: file.contractor_id,
      details: { kind: file.kind, file_name: file.original_name },
    });
    res.json({ message: 'Document deleted' });
  } catch (err) {
    sendError(res, err, 'Unable to delete the document');
  }
});

// ── public: the vendor's link ────────────────────────────────────────────────

function inviteByToken(db, token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;
  return db.prepare('SELECT * FROM vendor_setup_invites WHERE token_hash = ?').get(tokenHash(token));
}

function publicShape(invite) {
  return {
    company_name: invite.company_name,
    vendor_type: invite.vendor_type,
    email_hint: emailHint(invite.email),
    expires_at: invite.expires_at,
    status: effectiveStatus(invite),
    submitted_at: invite.submitted_at || null,
    company: NUD_COMPANY,
    payment_policy: PAYMENT_POLICY,
    limits: { max_file_mb: MAX_FILE_MB, max_files_per_kind: MAX_FILES_PER_KIND },
  };
}

// Anyone holding the link sees only the company name and a masked email; every
// field the vendor typed is released only after the emailed code is verified.
function requireOpenInvite(db, token) {
  const invite = inviteByToken(db, token);
  if (!invite) throw httpError(404, 'This vendor setup link is not valid. Please use the newest link New Urban Development emailed you.');
  if (invite.status === 'submitted') throw httpError(409, 'This vendor setup has already been submitted. Thank you!');
  if (isExpired(invite)) throw httpError(410, 'This vendor setup link has expired. Please contact New Urban Development for a new link.');
  return invite;
}

router.get('/public/:token', limitByIp('vs-lookup', 60, 60 * 1000), (req, res) => {
  try {
    const db = getDb();
    const invite = inviteByToken(db, req.params.token);
    if (!invite) throw httpError(404, 'This vendor setup link is not valid. Please use the newest link New Urban Development emailed you.');
    if (!invite.opened_at && invite.status !== 'submitted') {
      db.prepare('UPDATE vendor_setup_invites SET opened_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), invite.id);
    }
    res.json(publicShape(invite));
  } catch (err) {
    sendError(res, err, 'Unable to open this setup link');
  }
});

router.post('/public/:token/send-code', limitByIp('vs-code', 20, 60 * 60 * 1000), async (req, res) => {
  try {
    const db = getDb();
    const invite = requireOpenInvite(db, req.params.token);
    const recent = db.prepare(`
      SELECT created_at FROM vendor_setup_codes
      WHERE invite_id = ? AND julianday(created_at) > julianday('now', ?)
      ORDER BY julianday(created_at) DESC
    `).all(invite.id, `-${CODE_RESEND_WINDOW_MINUTES} minutes`);
    if (recent.length >= CODE_RESEND_LIMIT) {
      const oldest = Date.parse(recent[recent.length - 1].created_at);
      const retryAfter = Math.max(1, Math.ceil((oldest + CODE_RESEND_WINDOW_MINUTES * 60 * 1000 - Date.now()) / 1000));
      throw httpError(429, 'Two codes were already sent. Use the newest code in your inbox, or wait a few minutes before requesting another.', { retry_after_seconds: retryAfter });
    }
    const today = db.prepare(`
      SELECT COUNT(*) AS n FROM vendor_setup_codes WHERE invite_id = ? AND julianday(created_at) > julianday('now', '-1 day')
    `).get(invite.id).n;
    if (today >= CODE_DAILY_LIMIT) {
      throw httpError(429, 'Too many codes were requested today. Please contact New Urban Development for help.');
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const codeId = uuidv4();
    db.transaction(() => {
      db.prepare('UPDATE vendor_setup_codes SET used = 1 WHERE invite_id = ? AND used = 0').run(invite.id);
      db.prepare(`
        INSERT INTO vendor_setup_codes (id, invite_id, code_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(codeId, invite.id, codeHash(invite.id, code), new Date(Date.now() + CODE_MINUTES * 60 * 1000).toISOString(), nowIso());
    })();
    try {
      await sendVendorSetupCodeEmail({ companyName: invite.company_name, email: invite.email, code });
    } catch (mailErr) {
      db.prepare('DELETE FROM vendor_setup_codes WHERE id = ?').run(codeId);
      throw mailErr;
    }
    res.json({ message: 'Verification code sent', email_hint: emailHint(invite.email) });
  } catch (err) {
    sendError(res, err, 'Unable to send the verification code');
  }
});

// ── public: the verified session ─────────────────────────────────────────────

// Signed with a key DERIVED from JWT_SECRET, so a vendor session can never pass
// authenticate() and a staff session can never pass requireSetupSession().
function sessionKey() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set');
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update('buildtrack:vendor-setup-session:v1').digest();
}

function issueSession(inviteId, verifiedAtMs) {
  return jwt.sign({ typ: 'vendor_setup', iid: inviteId, vat: Math.floor(verifiedAtMs / 1000) }, sessionKey(), {
    algorithm: 'HS256',
    expiresIn: `${SESSION_MINUTES}m`,
  });
}

function requireSetupSession(req, res, next) {
  try {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw httpError(401, 'Your secure session has ended. Please verify your email again.');
    let claims;
    try {
      claims = jwt.verify(token, sessionKey(), { algorithms: ['HS256'] });
    } catch (_) {
      throw httpError(401, 'Your secure session has ended. Please verify your email again.');
    }
    if (claims.typ !== 'vendor_setup' || !claims.iid || !claims.vat) throw httpError(401, 'Your secure session has ended. Please verify your email again.');
    if (Date.now() - claims.vat * 1000 > SESSION_MAX_HOURS * 60 * 60 * 1000) {
      throw httpError(401, 'Your secure session has ended. Please verify your email again.');
    }
    const invite = getDb().prepare('SELECT * FROM vendor_setup_invites WHERE id = ?').get(claims.iid);
    if (!invite) throw httpError(410, 'This vendor setup request was cancelled. Please contact New Urban Development.');
    if (invite.status === 'submitted') throw httpError(409, 'This vendor setup has already been submitted. Thank you!');
    req.vendorInvite = invite;
    // Sliding renewal: a fresh token rides along once this one is 10 minutes old,
    // capped by the 8-hour limit from verification (vat).
    if (Date.now() - claims.iat * 1000 > SESSION_REFRESH_AFTER_MINUTES * 60 * 1000) {
      res.locals.renewedSession = issueSession(invite.id, claims.vat * 1000);
    }
    next();
  } catch (err) {
    sendError(res, err, 'Unable to verify your session');
  }
}

function withSession(res, body) {
  return res.locals.renewedSession ? { ...body, setup_session: res.locals.renewedSession } : body;
}

// Every value is capped; the draft is encrypted before it touches the database.
const TEXT_FIELDS = {
  company_name: 150, contact_name: 120, phone: 40, email: 160,
  address_line1: 160, address_line2: 160, city: 80, state: 2, postal_code: 10,
  legal_name: 150, business_name: 150, tax_classification: 30, llc_tax_class: 1, other_classification: 80,
  exempt_payee_code: 4, fatca_code: 4, tax_id_type: 3, tax_id: 11, w9_signature_name: 120,
  insurance_provider: 120, insurance_policy_number: 60, insurance_expires_at: 10,
  bank_name: 120, account_holder_name: 150, account_type: 8, routing_number: 9, account_number: 17, account_number_confirm: 17,
};
const BOOLEAN_FIELDS = ['w9_certified', 'foreign_partners', 'backup_withholding', 'ach_authorized', 'payment_policy_accepted'];

function draftFromBody(body = {}) {
  const draft = { w9_method: body.w9_method === 'upload' ? 'upload' : 'online' };
  for (const [field, max] of Object.entries(TEXT_FIELDS)) {
    if (body[field] !== undefined && body[field] !== null) draft[field] = String(body[field]).slice(0, max);
  }
  for (const field of BOOLEAN_FIELDS) draft[field] = isTrue(body[field]);
  return draft;
}

function pendingFiles(db, inviteId, user = null) {
  return db.prepare(`
    SELECT * FROM vendor_setup_files WHERE invite_id = ? AND status = 'pending' ORDER BY julianday(uploaded_at)
  `).all(inviteId).map(row => fileShape(row, user));
}

router.post('/public/:token/verify', limitByIp('vs-verify', 30, 15 * 60 * 1000, 'Too many verification attempts. Please wait a few minutes.'), (req, res) => {
  try {
    const db = getDb();
    const invite = requireOpenInvite(db, req.params.token);
    const code = cleanDigits(req.body?.code, 6);
    const row = db.prepare(`
      SELECT * FROM vendor_setup_codes WHERE invite_id = ? AND used = 0
      ORDER BY julianday(created_at) DESC LIMIT 1
    `).get(invite.id);
    if (!row || Date.parse(row.expires_at) <= Date.now()) {
      throw httpError(401, 'That code has expired. Please request a new code.');
    }
    if (row.attempts >= CODE_MAX_ATTEMPTS) {
      throw httpError(429, 'Too many incorrect codes. Please request a new code.');
    }
    const expected = Buffer.from(row.code_hash, 'hex');
    const given = Buffer.from(codeHash(invite.id, code), 'hex');
    if (code.length !== 6 || !crypto.timingSafeEqual(expected, given)) {
      db.prepare('UPDATE vendor_setup_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
      const left = CODE_MAX_ATTEMPTS - row.attempts - 1;
      throw httpError(401, left > 0
        ? `That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.`
        : 'That code is not correct. Please request a new code.');
    }

    const now = nowIso();
    db.transaction(() => {
      db.prepare('UPDATE vendor_setup_codes SET used = 1 WHERE id = ?').run(row.id);
      db.prepare(`
        UPDATE vendor_setup_invites
        SET status = 'verified', verified_at = COALESCE(verified_at, ?), updated_at = ?
        WHERE id = ? AND status != 'submitted'
      `).run(now, now, invite.id);
    })();

    let draft = null;
    const draftRow = db.prepare('SELECT data_encrypted, updated_at FROM vendor_setup_drafts WHERE invite_id = ?').get(invite.id);
    if (draftRow) {
      try {
        draft = { form: decryptJson(draftRow.data_encrypted), updated_at: draftRow.updated_at };
      } catch (decryptErr) {
        console.error('[vendor-setup] draft could not be decrypted:', decryptErr?.message || decryptErr);
      }
    }

    res.json({
      setup_session: issueSession(invite.id, Date.now()),
      session_minutes: SESSION_MINUTES,
      invite: publicShape({ ...invite, status: 'verified' }),
      prefill: { company_name: invite.company_name, email: invite.email },
      draft,
      files: pendingFiles(db, invite.id),
    });
  } catch (err) {
    sendError(res, err, 'Unable to verify the code');
  }
});

router.post('/session/autosave', requireSetupSession, (req, res) => {
  try {
    const db = getDb();
    const now = nowIso();
    db.prepare(`
      INSERT INTO vendor_setup_drafts (invite_id, data_encrypted, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(invite_id) DO UPDATE SET data_encrypted = excluded.data_encrypted, updated_at = excluded.updated_at
    `).run(req.vendorInvite.id, encryptJson(draftFromBody(req.body || {})), now);
    res.json(withSession(res, { updated_at: now }));
  } catch (err) {
    sendError(res, err, 'Unable to save your progress');
  }
});

let uploadsInFlight = 0;
const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: MAX_FILE_MB * 1024 * 1024, fields: 5 },
}).single('file');

function acceptOneUpload(req, res, next) {
  if (uploadsInFlight >= MAX_CONCURRENT_UPLOADS) {
    return res.status(429).json({ error: 'Another upload is finishing. Please try again in a moment.', retry_after_seconds: 2 });
  }
  uploadsInFlight += 1;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      uploadsInFlight -= 1;
    }
  };
  res.on('finish', release);
  res.on('close', release);
  memoryUpload(req, res, err => {
    if (!err) return next();
    release();
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `Each file must be ${MAX_FILE_MB} MB or smaller`
      : 'That upload could not be read. Please try again.';
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
  });
}

router.post('/session/files', requireSetupSession, acceptOneUpload, (req, res) => {
  try {
    const db = getDb();
    const invite = req.vendorInvite;
    const kind = String(req.body?.kind || req.query.kind || '');
    if (!FILE_KINDS.includes(kind)) throw httpError(400, 'Unknown document type');
    const file = req.file;
    if (!file || !file.buffer?.length) throw httpError(400, 'Choose a file to upload');

    const count = db.prepare(`
      SELECT COUNT(*) AS n FROM vendor_setup_files WHERE invite_id = ? AND kind = ? AND status = 'pending'
    `).get(invite.id, kind).n;
    if (count >= MAX_FILES_PER_KIND) throw httpError(400, `You can upload up to ${MAX_FILES_PER_KIND} files here`);

    const detected = sniffFileType(file.buffer, file.originalname);
    const info = detected ? typeInfo(detected) : null;
    if (!info) {
      throw httpError(415, 'Please upload a PDF, a photo (JPG, PNG, HEIC), or a Word document.');
    }

    const fileId = uuidv4();
    const storagePath = writeSealedFile(invite.id, fileId, file.buffer);
    const originalName = sanitizeOriginalName(file.originalname, info.ext);
    const now = nowIso();
    try {
      db.prepare(`
        INSERT INTO vendor_setup_files (
          id, invite_id, contractor_id, kind, status, original_name, mime_type, size_bytes, sha256, storage_path, uploaded_at
        ) VALUES (?, ?, NULL, ?, 'pending', ?, ?, ?, ?, ?, ?)
      `).run(
        fileId, invite.id, kind, originalName, info.mime, file.buffer.length,
        crypto.createHash('sha256').update(file.buffer).digest('hex'), storagePath, now
      );
    } catch (insertErr) {
      removeSealedFile(storagePath);
      throw insertErr;
    }
    const row = db.prepare('SELECT * FROM vendor_setup_files WHERE id = ?').get(fileId);
    res.status(201).json(withSession(res, { file: fileShape(row) }));
  } catch (err) {
    sendError(res, err, 'Unable to upload the file');
  }
});

router.delete('/session/files/:fileId', requireSetupSession, (req, res) => {
  try {
    const db = getDb();
    const removed = removeFilesWhere(db, "id = ? AND invite_id = ? AND status = 'pending'", [req.params.fileId, req.vendorInvite.id]);
    if (!removed) throw httpError(404, 'File not found');
    res.json(withSession(res, { message: 'File removed' }));
  } catch (err) {
    sendError(res, err, 'Unable to remove the file');
  }
});

// ── public: submit ───────────────────────────────────────────────────────────

function validSsn(digits) {
  return /^\d{9}$/.test(digits)
    && !/^(000|666)/.test(digits)
    && digits.slice(3, 5) !== '00'
    && digits.slice(5) !== '0000';
}

const INVALID_EIN_PREFIXES = new Set(['00', '07', '08', '09', '17', '18', '19', '28', '29', '49', '69', '70', '78', '79', '89', '96', '97']);
function validEin(digits) {
  return /^\d{9}$/.test(digits) && !INVALID_EIN_PREFIXES.has(digits.slice(0, 2)) && !/^(\d)\1{8}$/.test(digits);
}

function validRoutingNumber(digits) {
  if (!/^\d{9}$/.test(digits) || /^0{9}$/.test(digits)) return false;
  const d = digits.split('').map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function formatTaxId(digits, type) {
  return type === 'ssn'
    ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`
    : `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

function validateSubmission(body, fileCounts) {
  const fields = {};
  const fail = (field, message) => { if (!fields[field]) fields[field] = message; };
  const w9Method = body.w9_method === 'upload' ? 'upload' : 'online';
  const p = {
    w9_method: w9Method,
    company_name: cleanString(body.company_name, 150),
    contact_name: cleanString(body.contact_name, 120),
    phone: cleanDigits(body.phone, 15).replace(/^1(?=d{10}$)/, ''),
    email: normalizeEmail(body.email),
    address_line1: cleanString(body.address_line1, 160),
    address_line2: cleanString(body.address_line2, 160),
    city: cleanString(body.city, 80),
    state: cleanString(body.state, 2).toUpperCase(),
    postal_code: cleanString(body.postal_code, 10),
    insurance_provider: cleanString(body.insurance_provider, 120),
    insurance_policy_number: cleanString(body.insurance_policy_number, 60),
    insurance_expires_at: cleanString(body.insurance_expires_at, 10),
    bank_name: cleanString(body.bank_name, 120),
    account_holder_name: cleanString(body.account_holder_name, 150),
    account_type: body.account_type === 'savings' ? 'savings' : 'checking',
    routing_number: cleanDigits(body.routing_number, 12),
    account_number: cleanDigits(body.account_number, 20),
    account_number_confirm: cleanDigits(body.account_number_confirm, 20),
    ach_authorized: isTrue(body.ach_authorized),
    payment_policy_accepted: isTrue(body.payment_policy_accepted),
  };

  if (!p.company_name) fail('company_name', 'Enter your company name');
  if (!p.contact_name) fail('contact_name', 'Enter a contact name');
  if (p.phone.length < 10) fail('phone', 'Enter a 10-digit phone number');
  else if (p.phone.length === 10) p.phone = `(${p.phone.slice(0, 3)}) ${p.phone.slice(3, 6)}-${p.phone.slice(6)}`;
  if (!p.email) fail('email', 'Enter a valid email address');
  if (!p.address_line1) fail('address_line1', 'Enter your mailing address');
  if (!p.city) fail('city', 'Enter the city');
  if (!/^[A-Z]{2}$/.test(p.state)) fail('state', 'Enter the 2-letter state');
  if (!/^\d{5}(-?\d{4})?$/.test(p.postal_code)) fail('postal_code', 'Enter a 5-digit ZIP code');

  if (w9Method === 'online') {
    p.legal_name = cleanString(body.legal_name, 150);
    p.business_name = cleanString(body.business_name, 150);
    p.tax_classification = Object.prototype.hasOwnProperty.call(TAX_CLASSIFICATIONS, body.tax_classification) ? body.tax_classification : '';
    p.llc_tax_class = String(body.llc_tax_class || '').toUpperCase();
    p.other_classification = cleanString(body.other_classification, 80);
    p.foreign_partners = isTrue(body.foreign_partners);
    // Checked = the IRS told them they are subject to backup withholding (W-9 item 2 struck).
    p.backup_withholding = isTrue(body.backup_withholding);
    p.exempt_payee_code = cleanString(body.exempt_payee_code, 4);
    p.fatca_code = cleanString(body.fatca_code, 4);
    p.tax_id_type = body.tax_id_type === 'ein' ? 'ein' : 'ssn';
    p.tax_id = cleanDigits(body.tax_id, 9);
    p.w9_certified = isTrue(body.w9_certified);
    p.w9_signature_name = cleanString(body.w9_signature_name, 120);

    if (!p.legal_name) fail('legal_name', 'Enter the name shown on your income tax return');
    if (!p.tax_classification) fail('tax_classification', 'Choose a federal tax classification');
    if (p.tax_classification === 'llc' && !LLC_TAX_CLASSES[p.llc_tax_class]) fail('llc_tax_class', 'Choose how the LLC is taxed (C, S or P)');
    if (p.tax_classification === 'other' && !p.other_classification) fail('other_classification', 'Describe the tax classification');
    if (EIN_REQUIRED.has(p.tax_classification) && p.tax_id_type !== 'ein') fail('tax_id_type', 'This classification uses an Employer Identification Number (EIN)');
    if (p.tax_id_type === 'ssn' && !validSsn(p.tax_id)) fail('tax_id', 'Enter a valid 9-digit Social Security Number (123-45-6789)');
    if (p.tax_id_type === 'ein' && !validEin(p.tax_id)) fail('tax_id', 'Enter a valid 9-digit EIN (12-3456789)');
    if (!p.w9_certified) fail('w9_certified', 'Check the W-9 certification box');
    if (p.w9_signature_name.length < 3) fail('w9_signature_name', 'Type your full name as your signature');
  } else if (!fileCounts.w9) {
    fail('w9_files', 'Upload your signed W-9, or choose "Fill out online"');
  }

  if (!fileCounts.insurance) fail('insurance_files', 'Upload your certificate of insurance');
  if (p.insurance_expires_at && !validDate(p.insurance_expires_at)) fail('insurance_expires_at', 'Enter a valid expiration date');

  if (!p.bank_name) fail('bank_name', 'Enter your bank name');
  if (!p.account_holder_name) fail('account_holder_name', 'Enter the name on the bank account');
  if (!validRoutingNumber(p.routing_number)) fail('routing_number', 'Enter a valid 9-digit routing number');
  if (!/^\d{4,17}$/.test(p.account_number)) fail('account_number', 'Enter your account number (4 to 17 digits)');
  if (p.account_number && p.account_number !== p.account_number_confirm) fail('account_number_confirm', 'The account numbers do not match');
  if (!p.ach_authorized) fail('ach_authorized', 'Check the box to authorize direct deposit');
  if (!p.payment_policy_accepted) fail('payment_policy_accepted', 'Please review and accept our payment policy');

  const messages = Object.values(fields);
  if (messages.length) throw httpError(400, messages[0], { details: messages, fields });
  delete p.account_number_confirm;
  return p;
}

function classificationLabel(p) {
  if (p.w9_method !== 'online') return 'See uploaded W-9';
  if (p.tax_classification === 'llc') return `LLC taxed as ${LLC_TAX_CLASSES[p.llc_tax_class]}`;
  if (p.tax_classification === 'other') return `Other: ${p.other_classification}`;
  return TAX_CLASSIFICATIONS[p.tax_classification];
}

router.post('/session/submit', requireSetupSession, async (req, res) => {
  const db = getDb();
  const invite = req.vendorInvite;
  try {
    const files = db.prepare(`
      SELECT * FROM vendor_setup_files WHERE invite_id = ? AND status = 'pending'
    `).all(invite.id);
    const fileCounts = files.reduce((acc, row) => ({ ...acc, [row.kind]: (acc[row.kind] || 0) + 1 }), {});
    const p = validateSubmission(req.body || {}, fileCounts);
    const submittedAt = nowIso();
    const mailingAddress = formatAddress(p);
    const isSupplier = invite.vendor_type === 'supplier';

    let contractorId = null;
    let created = false;
    let matchKind = invite.match_kind || null;
    db.transaction(() => {
      // Re-read inside the write transaction: a double-click must not create twice.
      const fresh = db.prepare('SELECT status, contractor_id FROM vendor_setup_invites WHERE id = ?').get(invite.id);
      if (!fresh || fresh.status === 'submitted') throw httpError(409, 'This vendor setup has already been submitted. Thank you!');

      if (fresh.contractor_id && db.prepare('SELECT 1 FROM contractor_profiles WHERE id = ?').get(fresh.contractor_id)) {
        contractorId = fresh.contractor_id;
      } else {
        const match = findMatchingVendor(db, { email: p.email, companyName: p.company_name })
          || findMatchingVendor(db, { email: invite.email, companyName: invite.company_name });
        if (match) {
          contractorId = match.id;
          matchKind = match.match_kind;
        }
      }

      if (contractorId) {
        db.prepare(`
          UPDATE contractor_profiles SET
            contact_name = COALESCE(NULLIF(trim(contact_name), ''), ?),
            email = COALESCE(NULLIF(trim(email), ''), ?),
            phone = COALESCE(NULLIF(trim(phone), ''), ?),
            billing_address = COALESCE(NULLIF(trim(billing_address), ''), ?),
            is_supplier = CASE WHEN ? = 1 THEN 1 ELSE is_supplier END,
            supplier_marked_at = CASE WHEN ? = 1 AND COALESCE(is_supplier, 0) = 0 THEN ? ELSE supplier_marked_at END,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(p.contact_name, p.email, p.phone, mailingAddress, isSupplier ? 1 : 0, isSupplier ? 1 : 0, submittedAt, contractorId);
      } else {
        contractorId = uuidv4();
        created = true;
        matchKind = null;
        db.prepare(`
          INSERT INTO contractor_profiles (
            id, vendor_name, contact_name, email, phone, billing_address, contractor_status,
            is_supplier, supplier_marked_at, supplier_marked_by, source, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 'vendor_setup', datetime('now'), datetime('now'))
        `).run(
          contractorId, p.company_name, p.contact_name, p.email, p.phone, mailingAddress,
          isSupplier ? 1 : 0, isSupplier ? submittedAt : null, isSupplier ? invite.requested_by : null
        );
      }

      const online = p.w9_method === 'online';
      const payload = {
        ...p,
        tax_classification_label: classificationLabel(p),
        tax_id_formatted: online ? formatTaxId(p.tax_id, p.tax_id_type) : null,
        country: 'US',
        w9_signed_at: online ? submittedAt : null,
        payment_policy_accepted_at: submittedAt,
        payment_policy_text: PAYMENT_POLICY.paragraphs.join('\n\n'),
        vendor_setup_invite_id: invite.id,
        vendor_type: invite.vendor_type,
        document_ids: files.map(row => row.id),
        submitted_at: submittedAt,
        ip_address: getClientIp(req) || '',
        user_agent: String(req.headers['user-agent'] || '').slice(0, 400),
      };

      db.prepare(`
        INSERT INTO contractor_compliance_profiles (
          contractor_id, legal_name, business_name, tax_classification, tax_id_type, tax_id_last4,
          address_line1, address_line2, city, state, postal_code, country, phone, email,
          bank_name, bank_account_last4, routing_last4, payment_method,
          insurance_provider, insurance_policy_number, insurance_expires_at,
          w9_certified, ach_authorized, data_encrypted, created_at, updated_at, submitted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'US', ?, ?, ?, ?, ?, 'ach', ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'), ?)
        ON CONFLICT(contractor_id) DO UPDATE SET
          legal_name = excluded.legal_name,
          business_name = excluded.business_name,
          tax_classification = excluded.tax_classification,
          tax_id_type = excluded.tax_id_type,
          tax_id_last4 = excluded.tax_id_last4,
          address_line1 = excluded.address_line1,
          address_line2 = excluded.address_line2,
          city = excluded.city,
          state = excluded.state,
          postal_code = excluded.postal_code,
          country = excluded.country,
          phone = excluded.phone,
          email = excluded.email,
          bank_name = excluded.bank_name,
          bank_account_last4 = excluded.bank_account_last4,
          routing_last4 = excluded.routing_last4,
          payment_method = excluded.payment_method,
          insurance_provider = excluded.insurance_provider,
          insurance_policy_number = excluded.insurance_policy_number,
          insurance_expires_at = excluded.insurance_expires_at,
          w9_certified = excluded.w9_certified,
          ach_authorized = excluded.ach_authorized,
          data_encrypted = excluded.data_encrypted,
          updated_at = datetime('now'),
          submitted_at = excluded.submitted_at
      `).run(
        contractorId,
        online ? p.legal_name : p.company_name,
        online ? (p.business_name || (p.company_name !== p.legal_name ? p.company_name : null)) : p.company_name,
        classificationLabel(p),
        online ? p.tax_id_type : null,
        online ? p.tax_id.slice(-4) : null,
        p.address_line1,
        p.address_line2 || null,
        p.city,
        p.state,
        p.postal_code,
        p.phone,
        p.email,
        p.bank_name,
        p.account_number.slice(-4),
        p.routing_number.slice(-4),
        p.insurance_provider || null,
        p.insurance_policy_number || null,
        p.insurance_expires_at || null,
        online ? 1 : 0,
        encryptJson(payload),
        submittedAt
      );

      db.prepare(`
        UPDATE vendor_setup_files SET status = 'submitted', contractor_id = ? WHERE invite_id = ? AND status = 'pending'
      `).run(contractorId, invite.id);
      db.prepare(`
        UPDATE vendor_setup_invites
        SET status = 'submitted', submitted_at = ?, contractor_id = ?, match_kind = ?, w9_method = ?, updated_at = ?
        WHERE id = ?
      `).run(submittedAt, contractorId, created ? null : matchKind, p.w9_method, submittedAt, invite.id);
      db.prepare('DELETE FROM vendor_setup_drafts WHERE invite_id = ?').run(invite.id);
      db.prepare('UPDATE vendor_setup_codes SET used = 1 WHERE invite_id = ?').run(invite.id);
    })();

    const vendorName = db.prepare('SELECT vendor_name FROM contractor_profiles WHERE id = ?').get(contractorId)?.vendor_name || p.company_name;
    logActivity({
      userId: invite.requested_by,
      action: 'vendor_setup_submitted',
      entityType: 'contractor_profile',
      entityId: contractorId,
      details: {
        company_name: p.company_name,
        vendor_name: vendorName,
        vendor_created: created,
        match_kind: created ? null : matchKind,
        w9_method: p.w9_method,
        document_count: files.length,
      },
    });

    // Mail is sent after the commit and never undoes a saved submission.
    let officeEmailSent = false;
    let confirmationSent = false;
    const insuranceFiles = files.filter(row => row.kind === 'insurance');
    const attachments = [];
    let attachedBytes = 0;
    for (const row of insuranceFiles) {
      if (attachedBytes + row.size_bytes > 15 * 1024 * 1024) break;
      try {
        attachments.push({ filename: row.original_name, content: readSealedFile(row.storage_path), contentType: row.mime_type });
        attachedBytes += row.size_bytes;
      } catch (readErr) {
        console.error('[vendor-setup] could not attach insurance certificate:', readErr?.message || readErr);
      }
    }
    try {
      await sendVendorSetupSubmittedEmail({
        to: officeEmail(),
        companyName: vendorName,
        vendorType: invite.vendor_type,
        contactName: p.contact_name,
        vendorEmail: p.email,
        phone: p.phone,
        mailingAddress,
        w9Summary: p.w9_method === 'online'
          ? `Completed online and signed by ${p.w9_signature_name} - ${classificationLabel(p)}, ${p.tax_id_type.toUpperCase()} ending ${p.tax_id.slice(-4)}${p.backup_withholding ? '. SUBJECT TO BACKUP WITHHOLDING (IRS notice)' : ''}`
          : `Uploaded as a document (${fileCounts.w9} file${fileCounts.w9 === 1 ? '' : 's'})`,
        insuranceSummary: [
          p.insurance_provider,
          p.insurance_policy_number ? `policy ${p.insurance_policy_number}` : '',
          p.insurance_expires_at ? `expires ${p.insurance_expires_at}` : '',
          `${fileCounts.insurance} certificate file${fileCounts.insurance === 1 ? '' : 's'}`,
        ].filter(Boolean).join(', '),
        bankSummary: `${p.bank_name} ${p.account_type} account ending ${p.account_number.slice(-4)} (routing ending ${p.routing_number.slice(-4)}), name on account ${p.account_holder_name}. ACH deposits authorized.`,
        documentCounts: fileCounts,
        vendorRecordNote: created
          ? `BuildTrack added them to Contractors / Suppliers as a new ${isSupplier ? 'supplier' : 'contractor'}.`
          : `BuildTrack matched them to the existing vendor "${vendorName}" and attached the information there.`,
        paymentPolicyAcceptedAt: submittedAt,
        submittedAt,
        buildTrackUrl: `${baseUrl()}/contractors?search=${encodeURIComponent(vendorName)}`,
        attachments,
      });
      officeEmailSent = true;
    } catch (mailErr) {
      console.error('[vendor-setup] office notification failed:', mailErr?.message || mailErr);
    }
    try {
      await sendVendorSetupConfirmationEmail({ companyName: p.company_name, email: p.email || invite.email });
      confirmationSent = true;
    } catch (mailErr) {
      console.error('[vendor-setup] vendor confirmation failed:', mailErr?.message || mailErr);
    }

    res.json({
      message: 'Your vendor setup was submitted to New Urban Development.',
      office_email_sent: officeEmailSent,
      confirmation_email_sent: confirmationSent,
    });
  } catch (err) {
    sendError(res, err, 'Unable to submit your information');
  }
});

module.exports = router;
