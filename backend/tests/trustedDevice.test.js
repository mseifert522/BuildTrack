const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');

// Isolated fixture database; never load a deployment .env or send real mail.
const temp = path.resolve(__dirname, '../../.test-work', `trusted-device-${crypto.randomUUID()}`);
fs.mkdirSync(temp, { recursive: true });
process.env.DB_PATH = path.join(temp, 'test.db');
process.env.JWT_SECRET = 'trusted-device-test-secret-not-for-production';
process.env.SMTP_PASS = 'test-mail-stub';
let verificationCode;
const emailPath = require.resolve('../src/utils/email');
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true,
  exports: { send2FACodeEmail: async ({ code }) => { verificationCode = code; } },
};
const { initializeSchema, getDb } = require('../src/db/schema');
const { applySessionRetentionPolicy, revokeUserAccess } = require('../src/utils/sessionPolicy');

(async () => {
  initializeSchema();
  const db = getDb();
  db.prepare('INSERT INTO users(id,name,email,password_hash,role,is_active) VALUES(?,?,?,?,?,?)')
    .run('remember-test', 'Test User', 'remember@example.invalid',
      await bcrypt.hash('test-password-only', 4), 'super_admin', 1);
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../src/routes/auth'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/auth`;
  const credentials = { email: 'remember@example.invalid', password: 'test-password-only' };
  async function post(route, body, token) {
    const response = await fetch(base + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }
  try {
    const challenge = await post('/login', { ...credentials, trust_device: true });
    assert.equal(challenge.body.requires_2fa, true);
    assert.equal(challenge.body.device_token, undefined);
    const verified = await post('/login', { ...credentials, trust_device: true, twofa_code: verificationCode });
    assert.equal(verified.status, 200);
    const device = verified.body.device_token;
    assert.ok(device);
    assert.ok(verified.body.trusted_device_expires_at);
    const approval = db.prepare('SELECT * FROM trusted_devices WHERE device_token=?').get(device);
    assert.ok(approval);

    // Signing out and session inactivity must not revoke device approval.
    assert.equal((await post('/logout', {}, verified.body.token)).status, 204);
    for (let i = 0; i < 3; i++) {
      const continued = await post('/trusted-device-login', { device_token: device });
      assert.equal(continued.status, 200);
      assert.equal(continued.body.device_token, device);
      assert.equal(continued.body.trusted_device_expires_at, approval.expires_at);
      db.prepare("UPDATE auth_sessions SET last_seen_at=datetime('now','-3 hours') WHERE id=?")
        .run(continued.body.session_id);
      applySessionRetentionPolicy(db);
      assert.ok(db.prepare('SELECT id FROM trusted_devices WHERE device_token=?').get(device));
    }
    const passwordAgain = await post('/login', { ...credentials, device_token: device });
    assert.equal(passwordAgain.status, 200);
    assert.equal(passwordAgain.body.requires_2fa, undefined);
    const quick = await post('/mobile-quick-access', { quick_access_token: verified.body.quick_access.token });
    assert.equal(quick.status, 200);
    assert.equal((await post('/mobile-quick-access', { quick_access_token: verified.body.quick_access.token })).status, 200);

    // Security logout must still revoke both ways back in.
    revokeUserAccess(db, 'remember-test', 'remember-test', 'Test security logout', new Date().toISOString());
    assert.equal((await post('/trusted-device-login', { device_token: device })).status, 401);
    assert.equal((await post('/mobile-quick-access', { quick_access_token: verified.body.quick_access.token })).status, 401);
    assert.equal((await post('/login', { ...credentials, trust_device: true })).body.requires_2fa, true);
    console.log('PASS: 2FA enrollment, repeated trusted login, logout, idle expiry, quick access and security revocation');
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
    // Only the verified per-test fixture folder can be removed.
    assert.equal(path.dirname(temp), path.resolve(__dirname, '../../.test-work'));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
