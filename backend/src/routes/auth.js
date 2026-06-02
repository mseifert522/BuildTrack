const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { sendPasswordResetEmail, send2FACodeEmail, sendContractorPinEmail } = require('../utils/email');
const { ensureContractorMobileAccountByEmail, normalizeEmail } = require('../utils/contractorAccess');

const router = express.Router();
const MANAGEMENT_ROLES = ['super_admin', 'operations_manager', 'project_manager'];
const TRUSTED_DEVICE_DAYS = 60;
const MOBILE_QUICK_ACCESS_DAYS = 7;
const SESSION_EXPIRES_IN = '45m';
const CONTRACTOR_EMAIL_LOGIN_MESSAGE = 'If that contractor email is on file, BuildTrack will send login instructions.';

function sqliteDateTime(date) {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function minutesFromNow(minutes) {
  return sqliteDateTime(new Date(Date.now() + minutes * 60 * 1000));
}

function daysFromNow(days) {
  return sqliteDateTime(new Date(Date.now() + days * 24 * 60 * 60 * 1000));
}

function generate2FACode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function shouldTrustDevice(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function markUserOnline(db, userId, includeLogin = false, sessionId = null) {
  db.prepare(`
    UPDATE users
    SET last_seen_at = datetime('now')${includeLogin ? ", last_login_at = datetime('now')" : ''},
        updated_at = datetime('now')
    WHERE id = ?
  `).run(userId);

  if (sessionId) {
    db.prepare(`
      UPDATE auth_sessions
      SET last_seen_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL
    `).run(sessionId, userId);
  }
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    phone: user.phone,
    company: user.company,
    contractor_category: user.contractor_category || null,
    contractor_secondary_category: user.contractor_secondary_category || null,
    avatar_url: user.avatar_url || null,
    force_password_reset: user.force_password_reset === 1,
  };
}

function createSessionToken(user, sessionId = null) {
  return jwt.sign(
    { userId: user.id, role: user.role, sid: sessionId || undefined },
    process.env.JWT_SECRET,
    { expiresIn: SESSION_EXPIRES_IN }
  );
}

function createAuthSession(db, user, req, details = null, sessionType = null) {
  const sessionId = uuidv4();
  const resolvedSessionType = sessionType || (user.role === 'contractor' ? 'mobile_app' : 'desktop');
  db.prepare(`
    INSERT INTO auth_sessions (
      id, user_id, session_type, user_agent, ip_address, issued_at, last_seen_at, details
    ) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)
  `).run(
    sessionId,
    user.id,
    resolvedSessionType,
    req?.headers?.['user-agent'] || '',
    req?.ip || '',
    details ? JSON.stringify({ issued_via: details }) : null,
  );

  return sessionId;
}

function issueSession(db, user, details, req = null, sessionType = null) {
  const sessionId = createAuthSession(db, user, req, details, sessionType);
  const token = createSessionToken(user, sessionId);
  markUserOnline(db, user.id, true, sessionId);
  logActivity({
    userId: user.id,
    action: 'user_login',
    entityType: 'user',
    entityId: user.id,
    details,
  });
  return { token, user: publicUser(user), session_id: sessionId };
}

function issueTrustedDevice(db, user, req, previousDeviceToken) {
  const deviceToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = daysFromNow(TRUSTED_DEVICE_DAYS);

  db.prepare("DELETE FROM trusted_devices WHERE datetime(expires_at) <= datetime('now')").run();
  if (previousDeviceToken) {
    db.prepare('DELETE FROM trusted_devices WHERE user_id = ? AND device_token = ?').run(user.id, previousDeviceToken);
  }

  db.prepare(`
    INSERT INTO trusted_devices (id, user_id, device_token, user_agent, ip_address, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), user.id, deviceToken, req.headers['user-agent'] || '', req.ip || '', expiresAt);

  return {
    device_token: deviceToken,
    trusted_device_expires_at: expiresAt,
  };
}

function hashMobileQuickAccessToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function issueMobileQuickAccess(db, user, req) {
  const quickAccessToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = daysFromNow(MOBILE_QUICK_ACCESS_DAYS);

  db.prepare(`
    DELETE FROM mobile_quick_access_tokens
    WHERE datetime(expires_at) <= datetime('now')
      OR revoked_at IS NOT NULL
  `).run();

  db.prepare(`
    INSERT INTO mobile_quick_access_tokens (
      id, user_id, token_hash, user_agent, ip_address, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(),
    user.id,
    hashMobileQuickAccessToken(quickAccessToken),
    req.headers['user-agent'] || '',
    req.ip || '',
    expiresAt
  );

  return {
    quick_access: {
      token: quickAccessToken,
      expires_at: expiresAt,
      expires_in_days: MOBILE_QUICK_ACCESS_DAYS,
    },
  };
}

function addMobileQuickAccess(payload, db, user, req) {
  Object.assign(payload, issueMobileQuickAccess(db, user, req));
  return payload;
}

function isDeviceTrusted(db, userId, deviceToken) {
  if (!deviceToken) return false;
  const device = db.prepare(
    "SELECT id FROM trusted_devices WHERE user_id = ? AND device_token = ? AND datetime(expires_at) > datetime('now')"
  ).get(userId, deviceToken);
  return !!device;
}

function getLoginProjects(db, user) {
  if (MANAGEMENT_ROLES.includes(user.role)) {
    return db.prepare(`
      SELECT p.id, p.address, p.job_name, p.status, p.budget
      FROM projects p
      WHERE p.status != 'archived'
      ORDER BY p.updated_at DESC
    `).all();
  }

  return db.prepare(`
    SELECT p.id, p.address, p.job_name, p.status, p.budget
    FROM projects p
    JOIN project_assignments pa ON pa.project_id = p.id AND pa.user_id = ?
    WHERE p.status != 'archived'
    ORDER BY p.updated_at DESC
  `).all(user.id);
}

// POST /api/auth/login - management users receive an email 2FA code unless this device is trusted.
router.post('/login', async (req, res) => {
  try {
    const { email, password, twofa_code, device_token, trust_device } = req.body;
    const trustDevice = shouldTrustDevice(trust_device);
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email.toLowerCase().trim());
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    if (!MANAGEMENT_ROLES.includes(user.role)) {
      const payload = issueSession(db, user, { two_factor: 'not_required', trusted_device: trustDevice }, req);
      if (trustDevice) Object.assign(payload, issueTrustedDevice(db, user, req, device_token));
      return res.json(addMobileQuickAccess(payload, db, user, req));
    }

    if (isDeviceTrusted(db, user.id, device_token)) {
      const payload = issueSession(db, user, { trusted_device: true }, req);
      return res.json(addMobileQuickAccess(payload, db, user, req));
    }

    if (twofa_code) {
      const codeRow = db.prepare(`
        SELECT * FROM two_factor_codes
        WHERE user_id = ? AND code = ? AND used = 0 AND datetime(expires_at) > datetime('now')
        ORDER BY created_at DESC LIMIT 1
      `).get(user.id, twofa_code);

      if (!codeRow) {
        return res.status(401).json({ error: 'Invalid or expired verification code', requires_2fa: true });
      }

      db.prepare('UPDATE two_factor_codes SET used = 1 WHERE id = ?').run(codeRow.id);
      const payload = issueSession(db, user, { two_factor: true, trusted_device: trustDevice }, req);

      if (trustDevice) {
        Object.assign(payload, issueTrustedDevice(db, user, req, device_token));
      }

      return res.json(addMobileQuickAccess(payload, db, user, req));
    }

    if (!process.env.SMTP_PASS || process.env.SMTP_PASS === 'REPLACE_WITH_RESEND_API_KEY') {
      const payload = issueSession(db, user, { two_factor: 'skipped_no_smtp' }, req);
      return res.json(addMobileQuickAccess(payload, db, user, req));
    }

    db.prepare('UPDATE two_factor_codes SET used = 1 WHERE user_id = ? AND used = 0').run(user.id);

    const code = generate2FACode();
    const expiresAt = minutesFromNow(10);
    db.prepare(
      'INSERT INTO two_factor_codes (id, user_id, code, expires_at) VALUES (?, ?, ?, ?)'
    ).run(uuidv4(), user.id, code, expiresAt);

    try {
      await send2FACodeEmail({ name: user.name, email: user.email, code });
    } catch (emailErr) {
      console.error('Failed to send 2FA email:', emailErr);
      return res.status(500).json({ error: 'Unable to send verification code. Please try again.' });
    }

    return res.json({
      requires_2fa: true,
      message: 'Verification code sent to your email',
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/mobile-quick-access - one-touch app access for 7 days after full login.
router.post('/mobile-quick-access', async (req, res) => {
  try {
    const quickAccessToken = req.body?.quick_access_token || req.body?.token;
    if (!quickAccessToken || typeof quickAccessToken !== 'string') {
      return res.status(400).json({ error: 'Quick access token is required', reset_quick_access: true });
    }

    const db = getDb();
    const user = db.prepare(`
      SELECT mqat.expires_at as quick_access_expires_at, u.*
      FROM mobile_quick_access_tokens mqat
      JOIN users u ON u.id = mqat.user_id
      WHERE mqat.token_hash = ?
        AND mqat.revoked_at IS NULL
        AND datetime(mqat.expires_at) > datetime('now')
        AND u.is_active = 1
      LIMIT 1
    `).get(hashMobileQuickAccessToken(quickAccessToken));

    if (!user) {
      return res.status(401).json({
        error: 'Quick access has expired. Please sign in with your password or PIN again.',
        reset_quick_access: true,
      });
    }

    db.prepare(`
      UPDATE mobile_quick_access_tokens
      SET last_used_at = datetime('now')
      WHERE token_hash = ?
    `).run(hashMobileQuickAccessToken(quickAccessToken));

    const payload = issueSession(db, user, { mobile_quick_access: true }, req);
    payload.quick_access = {
      expires_at: user.quick_access_expires_at,
      expires_in_days: MOBILE_QUICK_ACCESS_DAYS,
    };
    if (user.role === 'contractor') payload.projects = getLoginProjects(db, user);

    return res.json(payload);
  } catch (err) {
    console.error('Mobile quick access login error:', err);
    res.status(500).json({ error: 'Quick access login failed' });
  }
});

// POST /api/auth/trusted-device-login - continue from a browser previously approved by 2FA.
router.post('/trusted-device-login', async (req, res) => {
  try {
    const { device_token } = req.body;
    if (!device_token) return res.status(400).json({ error: 'Trusted device approval is required' });

    const db = getDb();
    const user = db.prepare(`
      SELECT td.expires_at as trusted_device_expires_at, u.*
      FROM trusted_devices td
      JOIN users u ON u.id = td.user_id
      WHERE td.device_token = ?
        AND datetime(td.expires_at) > datetime('now')
        AND u.is_active = 1
      ORDER BY datetime(td.expires_at) DESC
      LIMIT 1
    `).get(device_token);

    if (!user) {
      return res.status(401).json({ error: 'This trusted device approval has expired. Please sign in again.' });
    }

    const payload = issueSession(db, user, { trusted_device_quick_login: true }, req);
    payload.device_token = device_token;
    payload.trusted_device_expires_at = user.trusted_device_expires_at;
    if (user.role === 'contractor') payload.projects = getLoginProjects(db, user);

    return res.json(payload);
  } catch (err) {
    console.error('Trusted device login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/pin-login - contractor quick login via 5-digit PIN
router.post('/pin-login', async (req, res) => {
  try {
    const { pin, device_token, trust_device } = req.body;
    const trustDevice = shouldTrustDevice(trust_device);
    if (!pin || !/^\d{5}$/.test(pin)) {
      return res.status(400).json({ error: 'Please enter a valid 5-digit PIN' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE pin = ? AND is_active = 1').get(pin);
    if (!user) return res.status(401).json({ error: 'Invalid PIN' });
    if (user.role !== 'contractor') {
      return res.status(403).json({ error: 'PIN login is only available for contractor accounts' });
    }

    const projects = getLoginProjects(db, user);

    logActivity({ userId: user.id, action: 'pin_login', entityType: 'user', entityId: user.id });
    const payload = issueSession(db, user, { pin_login: true, trusted_device: trustDevice }, req, 'mobile_app');
    payload.projects = projects;
    if (trustDevice) Object.assign(payload, issueTrustedDevice(db, user, req, device_token));

    res.json(addMobileQuickAccess(payload, db, user, req));
  } catch (err) {
    console.error('PIN login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/contractor/forgot-pin - email a contractor their mobile PIN.
router.post('/contractor/forgot-pin', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'Valid contractor email is required' });

    const db = getDb();
    const account = ensureContractorMobileAccountByEmail(db, email);
    if (account.user?.role === 'contractor' && account.user.pin) {
      await sendContractorPinEmail({
        name: account.user.name,
        email: account.user.email,
        pin: account.user.pin,
      });
      logActivity({
        userId: account.user.id,
        action: 'contractor_pin_recovery_requested',
        entityType: 'user',
        entityId: account.user.id,
      });
    }

    res.json({ message: CONTRACTOR_EMAIL_LOGIN_MESSAGE });
  } catch (err) {
    console.error('Contractor PIN recovery error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Unable to send contractor login instructions' });
  }
});

// POST /api/auth/contractor/email-login/request - send a 2FA code for contractor mobile login.
router.post('/contractor/email-login/request', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'Valid contractor email is required' });

    const db = getDb();
    const account = ensureContractorMobileAccountByEmail(db, email);
    if (account.user?.role === 'contractor') {
      db.prepare('UPDATE two_factor_codes SET used = 1 WHERE user_id = ? AND used = 0').run(account.user.id);
      const code = generate2FACode();
      const expiresAt = minutesFromNow(10);
      db.prepare(
        'INSERT INTO two_factor_codes (id, user_id, code, expires_at) VALUES (?, ?, ?, ?)'
      ).run(uuidv4(), account.user.id, code, expiresAt);
      await send2FACodeEmail({ name: account.user.name, email: account.user.email, code });
      logActivity({
        userId: account.user.id,
        action: 'contractor_email_login_code_requested',
        entityType: 'user',
        entityId: account.user.id,
      });
    }

    res.json({ message: CONTRACTOR_EMAIL_LOGIN_MESSAGE });
  } catch (err) {
    console.error('Contractor email login request error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Unable to send contractor login code' });
  }
});

// POST /api/auth/contractor/email-login/verify - verify 2FA code and open the mobile app.
router.post('/contractor/email-login/verify', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || '').replace(/\D/g, '').slice(0, 6);
    const deviceToken = req.body?.device_token;
    const trustDevice = shouldTrustDevice(req.body?.trust_device);
    if (!email || code.length !== 6) {
      return res.status(400).json({ error: 'Valid contractor email and 6-digit code are required' });
    }

    const db = getDb();
    const account = ensureContractorMobileAccountByEmail(db, email);
    const user = account.user;
    if (!user || user.role !== 'contractor') return res.status(401).json({ error: 'Invalid or expired verification code' });

    const codeRow = db.prepare(`
      SELECT * FROM two_factor_codes
      WHERE user_id = ? AND code = ? AND used = 0 AND datetime(expires_at) > datetime('now')
      ORDER BY created_at DESC LIMIT 1
    `).get(user.id, code);

    if (!codeRow) return res.status(401).json({ error: 'Invalid or expired verification code' });

    db.prepare('UPDATE two_factor_codes SET used = 1 WHERE id = ?').run(codeRow.id);
    const payload = issueSession(db, user, { contractor_email_2fa: true, trusted_device: trustDevice }, req, 'mobile_app');
    payload.projects = getLoginProjects(db, user);
    if (trustDevice) Object.assign(payload, issueTrustedDevice(db, user, req, deviceToken));

    res.json(addMobileQuickAccess(payload, db, user, req));
  } catch (err) {
    console.error('Contractor email login verify error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Login failed' });
  }
});

// POST /api/auth/forgot-password - send reset link
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email.toLowerCase().trim());
    if (!user) return res.json({ message: 'If that email exists, a reset link has been sent.' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = minutesFromNow(60);
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ?').run(user.id);
    db.prepare(
      'INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)'
    ).run(uuidv4(), user.id, token, expiresAt);

    const appUrl = process.env.APP_URL || 'https://buildtrack.newurbandev.com';
    const resetUrl = `${appUrl}/reset-password?token=${token}`;

    try {
      await sendPasswordResetEmail({ name: user.name, email: user.email, resetUrl });
    } catch (emailErr) {
      console.error('Failed to send reset email:', emailErr);
    }

    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// POST /api/auth/reset-password - use token to set new password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, new_password } = req.body;
    if (!token || !new_password) return res.status(400).json({ error: 'Token and new password are required' });
    if (new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const db = getDb();
    const resetToken = db.prepare(
      "SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND datetime(expires_at) > datetime('now')"
    ).get(token);
    if (!resetToken) return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });

    const hash = await bcrypt.hash(new_password, 12);
    db.prepare("UPDATE users SET password_hash = ?, force_password_reset = 0, updated_at = datetime('now') WHERE id = ?").run(hash, resetToken.user_id);
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(resetToken.id);

    logActivity({ userId: resetToken.user_id, action: 'password_reset_completed', entityType: 'user', entityId: resetToken.user_id });
    res.json({ message: 'Password has been reset. You can now sign in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => {
  const u = req.user;
  res.json({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    phone: u.phone,
    company: u.company,
    contractor_category: u.contractor_category || null,
    contractor_secondary_category: u.contractor_secondary_category || null,
    avatar_url: u.avatar_url || null,
    last_login_at: u.last_login_at || null,
    last_seen_at: u.last_seen_at || null,
    force_password_reset: u.force_password_reset === 1,
  });
});

// POST /api/auth/refresh - extend the current token while the client is active.
router.post('/refresh', authenticate, (req, res) => {
  try {
    const db = getDb();
    const sessionId = req.auth?.session_id || createAuthSession(db, req.user, req, { refresh_from_legacy_token: true });
    markUserOnline(db, req.user.id, false, sessionId);
    res.json({ token: createSessionToken(req.user, sessionId), user: publicUser(req.user) });
  } catch (err) {
    console.error('Token refresh error:', err);
    res.status(500).json({ error: 'Failed to refresh session' });
  }
});

// POST /api/auth/heartbeat - update live presence while the app is open
router.post('/heartbeat', authenticate, (req, res) => {
  try {
    const db = getDb();
    markUserOnline(db, req.user.id, false, req.auth?.session_id || null);
    res.json({ ok: true, last_seen_at: new Date().toISOString() });
  } catch (err) {
    console.error('Heartbeat error:', err);
    res.status(500).json({ error: 'Failed to update presence' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user.force_password_reset) {
      if (!current_password) return res.status(400).json({ error: 'Current password required' });
      const valid = await bcrypt.compare(current_password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(new_password, 12);
    db.prepare("UPDATE users SET password_hash = ?, force_password_reset = 0, updated_at = datetime('now') WHERE id = ?")
      .run(hash, req.user.id);

    logActivity({ userId: req.user.id, action: 'password_changed', entityType: 'user', entityId: req.user.id });
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// PUT /api/auth/profile
router.put('/profile', authenticate, async (req, res) => {
  try {
    const { name, phone, company } = req.body;
    const db = getDb();
    db.prepare("UPDATE users SET name = ?, phone = ?, company = ?, updated_at = datetime('now') WHERE id = ?")
      .run(name || req.user.name, phone || null, company || null, req.user.id);
    const updated = db.prepare('SELECT id, name, email, role, phone, company, force_password_reset FROM users WHERE id = ?').get(req.user.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;
