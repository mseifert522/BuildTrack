const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { sendPasswordResetEmail, send2FACodeEmail } = require('../utils/email');

const router = express.Router();
const MANAGEMENT_ROLES = ['super_admin', 'operations_manager', 'project_manager'];
const TRUSTED_DEVICE_DAYS = 60;

function generate2FACode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function markUserOnline(db, userId, includeLogin = false) {
  db.prepare(`
    UPDATE users
    SET last_seen_at = datetime('now')${includeLogin ? ", last_login_at = datetime('now')" : ''},
        updated_at = datetime('now')
    WHERE id = ?
  `).run(userId);
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

function issueSession(db, user, details) {
  const token = jwt.sign(
    { userId: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '45m' }
  );
  markUserOnline(db, user.id, true);
  logActivity({
    userId: user.id,
    action: 'user_login',
    entityType: 'user',
    entityId: user.id,
    details,
  });
  return { token, user: publicUser(user) };
}

function isDeviceTrusted(db, userId, deviceToken) {
  if (!deviceToken) return false;
  const device = db.prepare(
    "SELECT id FROM trusted_devices WHERE user_id = ? AND device_token = ? AND expires_at > datetime('now')"
  ).get(userId, deviceToken);
  return !!device;
}

// POST /api/auth/login - management users receive an email 2FA code unless this device is trusted.
router.post('/login', async (req, res) => {
  try {
    const { email, password, twofa_code, device_token, trust_device } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email.toLowerCase().trim());
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    if (!MANAGEMENT_ROLES.includes(user.role)) {
      return res.json(issueSession(db, user, { two_factor: 'not_required' }));
    }

    if (isDeviceTrusted(db, user.id, device_token)) {
      return res.json(issueSession(db, user, { trusted_device: true }));
    }

    if (twofa_code) {
      const codeRow = db.prepare(`
        SELECT * FROM two_factor_codes
        WHERE user_id = ? AND code = ? AND used = 0 AND expires_at > datetime('now')
        ORDER BY created_at DESC LIMIT 1
      `).get(user.id, twofa_code);

      if (!codeRow) {
        return res.status(401).json({ error: 'Invalid or expired verification code', requires_2fa: true });
      }

      db.prepare('UPDATE two_factor_codes SET used = 1 WHERE id = ?').run(codeRow.id);
      const payload = issueSession(db, user, { two_factor: true, trusted_device: !!trust_device });

      if (trust_device) {
        const newDeviceToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_DAYS * 24 * 60 * 60 * 1000).toISOString();
        db.prepare(`
          INSERT INTO trusted_devices (id, user_id, device_token, user_agent, ip_address, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(uuidv4(), user.id, newDeviceToken, req.headers['user-agent'] || '', req.ip || '', expiresAt);
        payload.device_token = newDeviceToken;
        payload.trusted_device_expires_at = expiresAt;
      }

      return res.json(payload);
    }

    if (!process.env.SMTP_PASS || process.env.SMTP_PASS === 'REPLACE_WITH_RESEND_API_KEY') {
      return res.json(issueSession(db, user, { two_factor: 'skipped_no_smtp' }));
    }

    db.prepare('UPDATE two_factor_codes SET used = 1 WHERE user_id = ? AND used = 0').run(user.id);

    const code = generate2FACode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
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

// POST /api/auth/pin-login - contractor quick login via 5-digit PIN
router.post('/pin-login', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || !/^\d{5}$/.test(pin)) {
      return res.status(400).json({ error: 'Please enter a valid 5-digit PIN' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE pin = ? AND is_active = 1').get(pin);
    if (!user) return res.status(401).json({ error: 'Invalid PIN' });

    let projects;
    if (MANAGEMENT_ROLES.includes(user.role)) {
      projects = db.prepare(`
        SELECT p.id, p.address, p.job_name, p.status, p.budget
        FROM projects p
        WHERE p.status != 'archived'
        ORDER BY p.updated_at DESC
      `).all();
    } else {
      projects = db.prepare(`
        SELECT p.id, p.address, p.job_name, p.status, p.budget
        FROM projects p
        JOIN project_assignments pa ON pa.project_id = p.id AND pa.user_id = ?
        WHERE p.status != 'archived'
        ORDER BY p.updated_at DESC
      `).all(user.id);
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '45m' }
    );

    logActivity({ userId: user.id, action: 'pin_login', entityType: 'user', entityId: user.id });
    markUserOnline(db, user.id, true);

    res.json({ token, user: publicUser(user), projects });
  } catch (err) {
    console.error('PIN login error:', err);
    res.status(500).json({ error: 'Login failed' });
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
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
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
      "SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > datetime('now')"
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

// POST /api/auth/heartbeat - update live presence while the app is open
router.post('/heartbeat', authenticate, (req, res) => {
  try {
    const db = getDb();
    markUserOnline(db, req.user.id, false);
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
