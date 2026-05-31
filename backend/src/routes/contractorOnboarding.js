const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate, authorize } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { sendContractorSetupEmail, sendContractorSetupCodeEmail, sendContractorSubmissionPdfEmail } = require('../utils/email');
const { encryptJson, decryptJson } = require('../utils/secureFields');
const { ensureContractorMobileAccount, ensureSelfSignupContractor } = require('../utils/contractorAccess');

const router = express.Router();
const MANAGEMENT_ROLES = ['super_admin', 'operations_manager', 'project_manager'];
const REQUEST_DAYS = 14;
const CODE_MINUTES = 10;
const SESSION_MINUTES = 30;
const CODE_RESEND_WINDOW_MINUTES = 5;
const CODE_RESEND_LIMIT = 2;

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanDigits(value) {
  return cleanString(value).replace(/\D/g, '');
}

function formatTaxIdForDisplay(digits, type) {
  const value = cleanDigits(digits).slice(0, 9);
  if (type === 'ssn') return `${value.slice(0, 3)}-${value.slice(3, 5)}-${value.slice(5)}`;
  return `${value.slice(0, 2)}-${value.slice(2)}`;
}

function isTrue(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function baseUrl() {
  return (process.env.APP_URL || process.env.FRONTEND_URL || 'https://buildtrack.newurbandev.com').replace(/\/+$/, '');
}

function emailHint(email) {
  const [local, domain] = String(email || '').split('@');
  if (!local || !domain) return '';
  return `${local.slice(0, 2)}***@${domain}`;
}

function assertRequestOpen(db, request) {
  if (!request) {
    const err = new Error('Setup link is invalid');
    err.statusCode = 404;
    throw err;
  }
  if (request.status === 'revoked') {
    const err = new Error('Setup link is no longer active');
    err.statusCode = 410;
    throw err;
  }
  if (Date.parse(request.expires_at) <= Date.now()) {
    db.prepare(`
      UPDATE contractor_onboarding_requests
      SET status = 'expired', updated_at = datetime('now')
      WHERE id = ? AND status != 'submitted'
    `).run(request.id);
    const err = new Error('Setup link has expired');
    err.statusCode = 410;
    throw err;
  }
}

function getRequestByToken(db, token) {
  if (!token || String(token).length < 32) return null;
  return db.prepare(`
    SELECT
      cor.*,
      cp.vendor_name,
      cp.contact_name,
      cp.email as contractor_email,
      cp.phone as contractor_phone,
      ccp.submitted_at as compliance_submitted_at
    FROM contractor_onboarding_requests cor
    JOIN contractor_profiles cp ON cp.id = cor.contractor_id
    LEFT JOIN contractor_compliance_profiles ccp ON ccp.contractor_id = cp.id
    WHERE cor.token_hash = ?
    LIMIT 1
  `).get(tokenHash(token));
}

function publicRequestPayload(request) {
  return {
    contractor_name: request.vendor_name,
    contact_name: request.contact_name,
    email_hint: emailHint(request.email || request.contractor_email),
    expires_at: request.expires_at,
    status: request.status,
    submitted_at: request.submitted_at || request.compliance_submitted_at || null,
    requires_verification: request.status !== 'submitted',
  };
}

function validateRoutingNumber(routingNumber) {
  return /^\d{9}$/.test(routingNumber);
}

function draftPayload(body) {
  const taxIdType = cleanString(body.tax_id_type).toLowerCase() === 'ein' ? 'ein' : 'ssn';
  const taxDigits = cleanDigits(body.tax_id);
  return {
    legal_name: cleanString(body.legal_name),
    business_name: cleanString(body.business_name),
    tax_classification: cleanString(body.tax_classification),
    tax_id_type: taxIdType,
    tax_id: taxDigits ? formatTaxIdForDisplay(taxDigits, taxIdType) : '',
    address_line1: cleanString(body.address_line1),
    address_line2: cleanString(body.address_line2),
    city: cleanString(body.city),
    state: cleanString(body.state).toUpperCase().slice(0, 2),
    postal_code: cleanString(body.postal_code),
    country: cleanString(body.country).toUpperCase().slice(0, 2) || 'US',
    phone: cleanString(body.phone),
    email: cleanString(body.email).toLowerCase(),
    bank_name: cleanString(body.bank_name),
    routing_number: cleanDigits(body.routing_number).slice(0, 9),
    account_number: cleanDigits(body.account_number).slice(0, 17),
    account_type: cleanString(body.account_type).toLowerCase() === 'savings' ? 'savings' : 'checking',
    insurance_provider: cleanString(body.insurance_provider),
    insurance_policy_number: cleanString(body.insurance_policy_number),
    insurance_expires_at: cleanString(body.insurance_expires_at),
    license_number: cleanString(body.license_number),
    license_state: cleanString(body.license_state).toUpperCase().slice(0, 2),
    w9_certified: isTrue(body.w9_certified),
    ach_authorized: isTrue(body.ach_authorized),
  };
}

function getDraft(db, requestId) {
  const row = db.prepare(`
    SELECT data_encrypted, updated_at
    FROM contractor_onboarding_drafts
    WHERE request_id = ?
  `).get(requestId);
  if (!row) return null;

  try {
    const draft = decryptJson(row.data_encrypted);
    const { request_id, contractor_id, autosaved_at, ip_address, user_agent, ...form } = draft || {};
    return {
      form,
      updated_at: row.updated_at || autosaved_at || null,
    };
  } catch (err) {
    console.error('Contractor setup draft restore failed:', err?.message || err);
    return null;
  }
}

function validateSubmission(body) {
  const rawTaxId = cleanString(body.tax_id);
  const payload = {
    legal_name: cleanString(body.legal_name),
    business_name: cleanString(body.business_name),
    tax_classification: cleanString(body.tax_classification),
    tax_id_type: cleanString(body.tax_id_type).toLowerCase(),
    tax_id: cleanDigits(body.tax_id),
    address_line1: cleanString(body.address_line1),
    address_line2: cleanString(body.address_line2),
    city: cleanString(body.city),
    state: cleanString(body.state).toUpperCase(),
    postal_code: cleanString(body.postal_code),
    country: cleanString(body.country) || 'US',
    phone: cleanString(body.phone),
    email: cleanString(body.email).toLowerCase(),
    bank_name: cleanString(body.bank_name),
    routing_number: cleanDigits(body.routing_number),
    account_number: cleanDigits(body.account_number),
    account_type: cleanString(body.account_type).toLowerCase(),
    insurance_provider: cleanString(body.insurance_provider),
    insurance_policy_number: cleanString(body.insurance_policy_number),
    insurance_expires_at: cleanString(body.insurance_expires_at),
    license_number: cleanString(body.license_number),
    license_state: cleanString(body.license_state).toUpperCase(),
    w9_certified: isTrue(body.w9_certified),
    ach_authorized: isTrue(body.ach_authorized),
  };

  const errors = [];
  const einRequiredClasses = new Set(['single_member_llc', 'llc', 'c_corporation', 's_corporation', 'partnership']);
  if (!payload.legal_name) errors.push('Legal name is required');
  if (!['ssn', 'ein'].includes(payload.tax_id_type)) errors.push('Tax ID type must be SSN or EIN');
  if (einRequiredClasses.has(payload.tax_classification) && payload.tax_id_type !== 'ein') {
    errors.push('LLC, corporation, and partnership classifications must use EIN / Tax ID format 12-3456789');
  }
  if (payload.tax_id_type === 'ssn' && !/^\d{3}-\d{2}-\d{4}$/.test(rawTaxId)) errors.push('SSN must use format 123-12-1234');
  if (payload.tax_id_type === 'ein' && !/^\d{2}-\d{7}$/.test(rawTaxId)) errors.push('Tax ID / EIN must use format 12-3456789');
  if (payload.tax_id_type === 'ssn' && payload.tax_id.length !== 9) errors.push('SSN must be 9 digits');
  if (payload.tax_id_type === 'ein' && payload.tax_id.length !== 9) errors.push('Tax ID must be 9 digits');
  if (!payload.tax_classification) errors.push('Tax classification is required');
  if (!payload.address_line1 || !payload.city || !payload.state || !payload.postal_code) errors.push('Full mailing address is required');
  if (!payload.phone) errors.push('Phone number is required');
  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) errors.push('Valid email address is required');
  if (!payload.bank_name) errors.push('Bank name is required');
  if (!validateRoutingNumber(payload.routing_number)) errors.push('Valid 9-digit routing number is required');
  if (payload.account_number.length < 4) errors.push('Bank account number is required');
  if (!['checking', 'savings'].includes(payload.account_type)) errors.push('Account type must be checking or savings');
  if (!payload.w9_certified) errors.push('W-9 certification is required');
  if (!payload.ach_authorized) errors.push('ACH authorization is required');

  if (errors.length) {
    const err = new Error(errors[0]);
    err.statusCode = 400;
    err.details = errors;
    throw err;
  }

  payload.tax_id_formatted = formatTaxIdForDisplay(payload.tax_id, payload.tax_id_type);
  return payload;
}

function verifySetupSession(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    const err = new Error('Verification session required');
    err.statusCode = 401;
    throw err;
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded?.type !== 'contractor_onboarding' || !decoded.requestId) {
      throw new Error('Invalid setup session');
    }
    return decoded;
  } catch (_) {
    const err = new Error('Verification session expired');
    err.statusCode = 401;
    throw err;
  }
}

// Public action: contractor starts their own secure setup from the login screen.
router.post('/self-signup', async (req, res) => {
  const db = getDb();
  let requestId;
  try {
    const account = db.transaction(() => ensureSelfSignupContractor(db, {
      name: req.body?.name,
      company: req.body?.company,
      email: req.body?.email,
      phone: req.body?.phone,
    }))();

    const contractor = account.contractor;
    const user = account.user;
    if (!contractor || !user) return res.status(400).json({ error: 'Valid contractor information is required' });

    const rawToken = crypto.randomBytes(32).toString('hex');
    requestId = uuidv4();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + REQUEST_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const email = user.email.toLowerCase().trim();
    const setupUrl = `${baseUrl()}/contractor-setup?token=${rawToken}`;

    db.transaction(() => {
      db.prepare(`
        UPDATE contractor_onboarding_requests
        SET status = 'revoked', updated_at = datetime('now')
        WHERE contractor_id = ? AND status IN ('sent', 'verified')
      `).run(contractor.id);
      db.prepare(`
        INSERT INTO contractor_onboarding_requests (
          id, contractor_id, token_hash, email, status, expires_at, last_sent_at, requested_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?)
      `).run(requestId, contractor.id, tokenHash(rawToken), email, expiresAt, now, user.id, now, now);
    })();

    await sendContractorSetupEmail({
      contractorName: contractor.vendor_name,
      contactName: contractor.contact_name,
      email,
      setupUrl,
      expiresAt,
      requestedBy: 'Contractor self signup',
    });

    logActivity({
      userId: user.id,
      action: 'contractor_self_signup_requested',
      entityType: 'contractor_profile',
      entityId: contractor.id,
      details: { contractor_name: contractor.vendor_name, email, expires_at: expiresAt },
    });

    res.status(201).json({
      message: 'Check your email for the secure contractor setup link.',
      status: 'sent',
      expires_at: expiresAt,
    });
  } catch (err) {
    if (requestId) {
      try {
        db.prepare(`
          UPDATE contractor_onboarding_requests
          SET status = 'revoked', updated_at = datetime('now')
          WHERE id = ?
        `).run(requestId);
      } catch (_) {}
    }
    if (!err.statusCode || err.statusCode >= 500) {
      console.error('Contractor self signup failed:', err);
    }
    res.status(err.statusCode || 500).json({ error: err.message || 'Unable to start contractor signup' });
  }
});

// Management action: send a secure setup email to a contractor.
router.post('/contractors/:id/request', authenticate, authorize(...MANAGEMENT_ROLES), async (req, res) => {
  const db = getDb();
  const contractor = db.prepare('SELECT * FROM contractor_profiles WHERE id = ?').get(req.params.id);
  if (!contractor) return res.status(404).json({ error: 'Contractor not found' });
  if (!contractor.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contractor.email)) {
    return res.status(400).json({ error: 'Contractor must have a valid email address before setup can be sent' });
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const requestId = uuidv4();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + REQUEST_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const email = contractor.email.toLowerCase().trim();
  const setupUrl = `${baseUrl()}/contractor-setup?token=${rawToken}`;

  try {
    const createRequest = db.transaction(() => {
      ensureContractorMobileAccount(db, contractor.id, { email, assignedBy: req.user.id });
      db.prepare(`
        UPDATE contractor_onboarding_requests
        SET status = 'revoked', updated_at = datetime('now')
        WHERE contractor_id = ? AND status IN ('sent', 'verified')
      `).run(contractor.id);
      db.prepare(`
        INSERT INTO contractor_onboarding_requests (
          id, contractor_id, token_hash, email, status, expires_at, last_sent_at, requested_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?)
      `).run(requestId, contractor.id, tokenHash(rawToken), email, expiresAt, now, req.user.id, now, now);
    });
    createRequest();

    await sendContractorSetupEmail({
      contractorName: contractor.vendor_name,
      contactName: contractor.contact_name,
      email,
      setupUrl,
      expiresAt,
      requestedBy: req.user.name,
    });

    logActivity({
      userId: req.user.id,
      action: 'contractor_onboarding_requested',
      entityType: 'contractor_profile',
      entityId: contractor.id,
      details: { contractor_name: contractor.vendor_name, email, expires_at: expiresAt },
    });

    res.status(201).json({
      message: 'Contractor setup email sent',
      status: 'sent',
      expires_at: expiresAt,
      setup_url: setupUrl,
    });
  } catch (err) {
    db.prepare(`
      UPDATE contractor_onboarding_requests
      SET status = 'revoked', updated_at = datetime('now')
      WHERE id = ?
    `).run(requestId);
    console.error('Contractor setup request failed:', err);
    res.status(500).json({ error: 'Unable to send contractor setup email. Please try again.' });
  }
});

// Public link lookup. This never exposes the raw token hash or sensitive submitted data.
router.get('/lookup', (req, res) => {
  try {
    const db = getDb();
    const request = getRequestByToken(db, req.query.token);
    assertRequestOpen(db, request);
    res.json(publicRequestPayload(request));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'Unable to load setup link' });
  }
});

router.post('/send-code', async (req, res) => {
  try {
    const db = getDb();
    const request = getRequestByToken(db, req.body?.token);
    assertRequestOpen(db, request);
    if (request.status === 'submitted') {
      return res.status(409).json({ error: 'Contractor setup has already been submitted' });
    }

    const recentCodes = db.prepare(`
      SELECT created_at FROM contractor_onboarding_codes
      WHERE request_id = ?
        AND datetime(created_at) > datetime('now', ?)
      ORDER BY datetime(created_at) DESC, created_at DESC
    `).all(request.id, `-${CODE_RESEND_WINDOW_MINUTES} minutes`);

    if (recentCodes.length >= CODE_RESEND_LIMIT) {
      const oldestRecent = recentCodes[recentCodes.length - 1];
      const oldestMs = Date.parse(`${String(oldestRecent.created_at).replace(' ', 'T')}Z`);
      const canResendAtMs = Number.isFinite(oldestMs)
        ? oldestMs + CODE_RESEND_WINDOW_MINUTES * 60 * 1000
        : Date.now() + CODE_RESEND_WINDOW_MINUTES * 60 * 1000;
      const retryAfterSeconds = Math.max(1, Math.ceil((canResendAtMs - Date.now()) / 1000));
      return res.status(429).json({
        error: 'Two verification codes were already sent. Please wait five minutes before requesting another code.',
        retry_after_seconds: retryAfterSeconds,
        can_resend_at: new Date(Date.now() + retryAfterSeconds * 1000).toISOString(),
      });
    }

    const code = generateCode();
    const codeId = uuidv4();
    const expiresAt = new Date(Date.now() + CODE_MINUTES * 60 * 1000).toISOString();
    const createCode = db.transaction(() => {
      db.prepare('UPDATE contractor_onboarding_codes SET used = 1 WHERE request_id = ? AND used = 0').run(request.id);
      db.prepare(`
        INSERT INTO contractor_onboarding_codes (id, request_id, code, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(codeId, request.id, code, expiresAt);
      if (request.status === 'verified') {
        db.prepare(`
          UPDATE contractor_onboarding_requests
          SET status = 'sent', verified_at = NULL, updated_at = datetime('now')
          WHERE id = ?
        `).run(request.id);
      }
    });
    createCode();

    try {
      await sendContractorSetupCodeEmail({
        name: request.contact_name || request.vendor_name,
        email: request.email,
        code,
      });
    } catch (emailErr) {
      db.prepare('DELETE FROM contractor_onboarding_codes WHERE id = ?').run(codeId);
      throw emailErr;
    }

    res.json({
      message: 'A 2FA verification code was sent to the contractor email inbox.',
      codes_sent_in_window: recentCodes.length + 1,
      next_limited_after: CODE_RESEND_LIMIT,
      cooldown_minutes: CODE_RESEND_WINDOW_MINUTES,
    });
  } catch (err) {
    console.error('Contractor setup code failed:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Unable to send verification code' });
  }
});

router.post('/verify-code', (req, res) => {
  try {
    const db = getDb();
    const request = getRequestByToken(db, req.body?.token);
    assertRequestOpen(db, request);
    if (request.status === 'submitted') {
      return res.status(409).json({ error: 'Contractor setup has already been submitted' });
    }

    const code = cleanDigits(req.body?.code);
    const codeRow = db.prepare(`
      SELECT * FROM contractor_onboarding_codes
      WHERE request_id = ? AND code = ? AND used = 0 AND expires_at > datetime('now')
      ORDER BY datetime(created_at) DESC, created_at DESC
      LIMIT 1
    `).get(request.id, code);

    if (!codeRow || Date.parse(codeRow.expires_at) <= Date.now()) {
      return res.status(401).json({ error: 'Invalid or expired verification code' });
    }

    db.prepare('UPDATE contractor_onboarding_codes SET used = 1 WHERE id = ?').run(codeRow.id);
    db.prepare(`
      UPDATE contractor_onboarding_requests
      SET status = 'verified', verified_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'sent'
    `).run(request.id);

    const setupSession = jwt.sign(
      { type: 'contractor_onboarding', requestId: request.id, contractorId: request.contractor_id },
      process.env.JWT_SECRET,
      { expiresIn: `${SESSION_MINUTES}m` }
    );

    res.json({
      message: 'Verification complete',
      setup_session: setupSession,
      expires_in_minutes: SESSION_MINUTES,
      contractor: publicRequestPayload({ ...request, status: 'verified' }),
      draft: getDraft(db, request.id),
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'Unable to verify code' });
  }
});

router.post('/autosave', (req, res) => {
  try {
    const session = verifySetupSession(req);
    const db = getDb();
    const request = db.prepare(`
      SELECT cor.*, cp.vendor_name, cp.contact_name
      FROM contractor_onboarding_requests cor
      JOIN contractor_profiles cp ON cp.id = cor.contractor_id
      WHERE cor.id = ?
    `).get(session.requestId);
    assertRequestOpen(db, request);
    if (request.status === 'submitted') {
      return res.status(409).json({ error: 'Contractor setup has already been submitted' });
    }

    const payload = draftPayload(req.body || {});
    const encrypted = encryptJson({
      ...payload,
      request_id: request.id,
      contractor_id: request.contractor_id,
      autosaved_at: new Date().toISOString(),
      ip_address: req.ip || '',
      user_agent: req.headers['user-agent'] || '',
    });

    db.prepare(`
      INSERT INTO contractor_onboarding_drafts (request_id, contractor_id, data_encrypted, created_at, updated_at)
      VALUES (?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(request_id) DO UPDATE SET
        data_encrypted = excluded.data_encrypted,
        updated_at = datetime('now')
    `).run(request.id, request.contractor_id, encrypted);

    const row = db.prepare('SELECT updated_at FROM contractor_onboarding_drafts WHERE request_id = ?').get(request.id);
    res.json({ message: 'Draft autosaved', updated_at: row?.updated_at || new Date().toISOString() });
  } catch (err) {
    console.error('Contractor setup autosave failed:', err?.message || err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Unable to autosave contractor setup' });
  }
});

router.post('/submit', async (req, res) => {
  try {
    const session = verifySetupSession(req);
    const db = getDb();
    const request = db.prepare(`
      SELECT cor.*, cp.vendor_name, cp.contact_name
      FROM contractor_onboarding_requests cor
      JOIN contractor_profiles cp ON cp.id = cor.contractor_id
      WHERE cor.id = ?
    `).get(session.requestId);
    assertRequestOpen(db, request);
    if (request.status === 'submitted') {
      return res.status(409).json({ error: 'Contractor setup has already been submitted' });
    }

    const payload = validateSubmission(req.body || {});
    const submittedAt = new Date().toISOString();
    const safeAddress = [
      payload.address_line1,
      payload.address_line2,
      [payload.city, payload.state, payload.postal_code].filter(Boolean).join(', '),
      payload.country,
    ].filter(Boolean).join('\n');
    const encrypted = encryptJson({
      ...payload,
      request_id: request.id,
      contractor_id: request.contractor_id,
      submitted_at: submittedAt,
      ip_address: req.ip || '',
      user_agent: req.headers['user-agent'] || '',
    });

    const saveSubmission = db.transaction(() => {
      db.prepare(`
        INSERT INTO contractor_compliance_profiles (
          contractor_id, legal_name, business_name, tax_classification, tax_id_type, tax_id_last4,
          address_line1, address_line2, city, state, postal_code, country, phone, email,
          bank_name, bank_account_last4, routing_last4, payment_method,
          insurance_provider, insurance_policy_number, insurance_expires_at,
          license_number, license_state, w9_certified, ach_authorized,
          data_encrypted, created_at, updated_at, submitted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ach', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)
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
          license_number = excluded.license_number,
          license_state = excluded.license_state,
          w9_certified = excluded.w9_certified,
          ach_authorized = excluded.ach_authorized,
          data_encrypted = excluded.data_encrypted,
          updated_at = datetime('now'),
          submitted_at = excluded.submitted_at
      `).run(
        request.contractor_id,
        payload.legal_name,
        payload.business_name || null,
        payload.tax_classification,
        payload.tax_id_type,
        payload.tax_id.slice(-4),
        payload.address_line1,
        payload.address_line2 || null,
        payload.city,
        payload.state,
        payload.postal_code,
        payload.country,
        payload.phone,
        payload.email || request.email,
        payload.bank_name,
        payload.account_number.slice(-4),
        payload.routing_number.slice(-4),
        payload.insurance_provider || null,
        payload.insurance_policy_number || null,
        payload.insurance_expires_at || null,
        payload.license_number || null,
        payload.license_state || null,
        payload.w9_certified ? 1 : 0,
        payload.ach_authorized ? 1 : 0,
        encrypted,
        submittedAt
      );

      db.prepare(`
        UPDATE contractor_profiles
        SET
          contact_name = COALESCE(NULLIF(contact_name, ''), ?),
          email = COALESCE(NULLIF(?, ''), email),
          phone = COALESCE(NULLIF(?, ''), phone),
          billing_address = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(payload.legal_name, payload.email, payload.phone, safeAddress, request.contractor_id);

      ensureContractorMobileAccount(db, request.contractor_id, {
        email: payload.email || request.email,
        contact_name: payload.legal_name,
        phone: payload.phone,
        assignedBy: request.requested_by,
      });

      db.prepare(`
        UPDATE contractor_onboarding_requests
        SET status = 'submitted', submitted_at = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(submittedAt, request.id);

      db.prepare('DELETE FROM contractor_onboarding_drafts WHERE request_id = ?').run(request.id);
    });

    saveSubmission();

    let operationsEmailSent = false;
    try {
      await sendContractorSubmissionPdfEmail({
        contractorName: request.vendor_name,
        contactName: request.contact_name || payload.legal_name,
        contractorEmail: request.email,
        payload,
        submittedAt,
        requestId: request.id,
      });
      operationsEmailSent = true;
    } catch (emailErr) {
      console.error('Contractor setup operations PDF email failed:', emailErr?.message || emailErr);
    }

    logActivity({
      userId: request.requested_by,
      action: 'contractor_onboarding_submitted',
      entityType: 'contractor_profile',
      entityId: request.contractor_id,
      details: {
        contractor_name: request.vendor_name,
        submitted_by_email: request.email,
        tax_id_last4: payload.tax_id.slice(-4),
        bank_account_last4: payload.account_number.slice(-4),
      },
    });

    res.json({ message: 'Contractor setup submitted successfully', operations_email_sent: operationsEmailSent });
  } catch (err) {
    console.error('Contractor setup submit failed:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Unable to submit contractor setup', details: err.details });
  }
});

module.exports = router;
