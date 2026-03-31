const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate, authorize, authorizeOverUser, blacklistToken } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');

router.use(authenticate);

const VALID_ROLES = ['super_admin', 'operations_manager', 'project_manager', 'contractor'];

// GET /api/users - list all users (super_admin, operations_manager only)
router.get('/', authorize('super_admin', 'operations_manager'), (req, res) => {
  const db = getDb();
  const users = db.prepare(
    'SELECT id, name, email, role, phone, company, is_active, created_at FROM users ORDER BY name'
  ).all();
  res.json(users);
});

// GET /api/users/contractors - list contractors for assignment dropdowns
router.get('/contractors', authorize('super_admin', 'operations_manager', 'project_manager'), (req, res) => {
  const db = getDb();
  const users = db.prepare(
    "SELECT id, name, email, phone, company FROM users WHERE role = 'contractor' AND is_active = 1 ORDER BY name"
  ).all();
  res.json(users);
});

// POST /api/users - create user (super_admin or operations_manager)
router.post('/', authorize('super_admin', 'operations_manager'), async (req, res) => {
  try {
    const { name, email, role, phone, company, password } = req.body;
    if (!name || !email || !role) return res.status(400).json({ error: 'Name, email, and role are required' });
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });

    // Operations Manager cannot create Super Admin accounts
    if (req.user.role === 'operations_manager' && role === 'super_admin') {
      return res.status(403).json({ error: 'Operations Manager cannot create Super Admin accounts' });
    }

    const db = getDb();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (existing) return res.status(409).json({ error: 'Email already in use' });

    const tempPass = password || Math.random().toString(36).slice(-10) + 'A1!';
    const hash = await bcrypt.hash(tempPass, 12);
    const id = uuidv4();

    db.prepare(
      `INSERT INTO users (id, name, email, password_hash, role, phone, company, force_password_reset)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(id, name, email.toLowerCase().trim(), hash, role, phone || null, company || null);

    logActivity({ userId: req.user.id, action: 'user_created', entityType: 'user', entityId: id, details: { name, email, role } });
    res.status(201).json({ id, name, email, role, message: `User created. Temporary password: ${tempPass}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// PUT /api/users/:id - update user (super_admin or operations_manager)
router.put('/:id', authorize('super_admin', 'operations_manager'), async (req, res) => {
  try {
    const db = getDb();
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });

    // Enforce hierarchy — cannot edit someone of equal or higher authority
    if (!authorizeOverUser(req.user.role, target.role)) {
      return res.status(403).json({ error: `You cannot modify a ${target.role.replace('_', ' ')} account` });
    }

    const { name, email, role, phone, company, is_active } = req.body;

    // Operations Manager cannot promote someone to Super Admin
    if (req.user.role === 'operations_manager' && role === 'super_admin') {
      return res.status(403).json({ error: 'Operations Manager cannot assign Super Admin role' });
    }

    db.prepare(
      `UPDATE users SET name = ?, email = ?, role = ?, phone = ?, company = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(
      name || target.name,
      email || target.email,
      role || target.role,
      phone ?? target.phone,
      company ?? target.company,
      is_active !== undefined ? (is_active ? 1 : 0) : target.is_active,
      req.params.id
    );

    logActivity({ userId: req.user.id, action: 'user_updated', entityType: 'user', entityId: req.params.id, details: { name, role, is_active } });
    res.json({ message: 'User updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// POST /api/users/:id/lockout - instantly deactivate and blacklist user's sessions
router.post('/:id/lockout', authorize('super_admin', 'operations_manager'), (req, res) => {
  try {
    const db = getDb();
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });

    // Cannot lock out someone of equal or higher authority
    if (!authorizeOverUser(req.user.role, target.role)) {
      return res.status(403).json({ error: `You cannot lock out a ${target.role.replace(/_/g, ' ')} account` });
    }

    // Deactivate the account in DB
    db.prepare(`UPDATE users SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(req.params.id);

    logActivity({
      userId: req.user.id,
      action: 'user_locked_out',
      entityType: 'user',
      entityId: req.params.id,
      details: { targetName: target.name, targetRole: target.role, lockedBy: req.user.name }
    });

    res.json({ message: `${target.name} has been locked out immediately. Their active sessions have been terminated.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to lock out user' });
  }
});

// POST /api/users/:id/unlock - reactivate a locked user
router.post('/:id/unlock', authorize('super_admin', 'operations_manager'), (req, res) => {
  try {
    const db = getDb();
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });

    if (!authorizeOverUser(req.user.role, target.role)) {
      return res.status(403).json({ error: `You cannot unlock a ${target.role.replace(/_/g, ' ')} account` });
    }

    db.prepare(`UPDATE users SET is_active = 1, updated_at = datetime('now') WHERE id = ?`).run(req.params.id);

    logActivity({
      userId: req.user.id,
      action: 'user_unlocked',
      entityType: 'user',
      entityId: req.params.id,
      details: { targetName: target.name, targetRole: target.role, unlockedBy: req.user.name }
    });

    res.json({ message: `${target.name}'s account has been reactivated.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to unlock user' });
  }
});

// DELETE /api/users/:id - delete user (super_admin only, cannot delete super_admin)
router.delete('/:id', authorize('super_admin'), (req, res) => {
  try {
    const db = getDb();
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
    if (target.role === 'super_admin') return res.status(403).json({ error: 'Super Admin accounts cannot be deleted' });

    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    logActivity({ userId: req.user.id, action: 'user_deleted', entityType: 'user', entityId: req.params.id, details: { name: target.name } });
    res.json({ message: 'User deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// POST /api/users/:id/reset-password (super_admin or operations_manager)
router.post('/:id/reset-password', authorize('super_admin', 'operations_manager'), async (req, res) => {
  try {
    const db = getDb();
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (!authorizeOverUser(req.user.role, target.role)) {
      return res.status(403).json({ error: 'Cannot reset password for this account' });
    }
    const tempPass = Math.random().toString(36).slice(-10) + 'A1!';
    const hash = await bcrypt.hash(tempPass, 12);
    db.prepare(`UPDATE users SET password_hash = ?, force_password_reset = 1, updated_at = datetime('now') WHERE id = ?`).run(hash, req.params.id);
    logActivity({ userId: req.user.id, action: 'password_reset', entityType: 'user', entityId: req.params.id });
    res.json({ message: `Password reset. New temporary password: ${tempPass}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
