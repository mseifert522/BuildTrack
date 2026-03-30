const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate, authorize } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

// GET /api/users - list all users (admin roles only)
router.get('/', authorize('super_admin', 'operations_manager', 'admin_assistant'), (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, name, email, role, phone, company, is_active, created_at FROM users ORDER BY name').all();
  res.json(users);
});

// GET /api/users/contractors - list contractors (for assignment dropdowns)
router.get('/contractors', authorize('super_admin', 'operations_manager', 'admin_assistant'), (req, res) => {
  const db = getDb();
  const users = db.prepare("SELECT id, name, email, phone, company FROM users WHERE role = 'contractor' AND is_active = 1 ORDER BY name").all();
  res.json(users);
});

// POST /api/users - create user (super admin only)
router.post('/', authorize('super_admin'), async (req, res) => {
  try {
    const { name, email, role, phone, company, password } = req.body;
    if (!name || !email || !role) return res.status(400).json({ error: 'Name, email, and role are required' });
    const validRoles = ['super_admin', 'operations_manager', 'admin_assistant', 'contractor'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const db = getDb();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (existing) return res.status(409).json({ error: 'Email already in use' });

    const tempPass = password || 'TempPass2026!';
    const hash = await bcrypt.hash(tempPass, 12);
    const id = uuidv4();

    db.prepare(`INSERT INTO users (id, name, email, password_hash, role, phone, company, force_password_reset)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(id, name, email.toLowerCase().trim(), hash, role, phone || null, company || null);

    logActivity({ userId: req.user.id, action: 'user_created', entityType: 'user', entityId: id, details: { name, email, role } });

    res.status(201).json({ id, name, email, role, message: `User created. Temporary password: ${tempPass}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// PUT /api/users/:id - update user
router.put('/:id', authorize('super_admin'), async (req, res) => {
  try {
    const { name, email, role, phone, company, is_active } = req.body;
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    db.prepare(`UPDATE users SET name = ?, email = ?, role = ?, phone = ?, company = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(name || user.name, email || user.email, role || user.role, phone ?? user.phone, company ?? user.company, is_active !== undefined ? (is_active ? 1 : 0) : user.is_active, req.params.id);

    logActivity({ userId: req.user.id, action: 'user_updated', entityType: 'user', entityId: req.params.id });
    res.json({ message: 'User updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// POST /api/users/:id/reset-password - force password reset
router.post('/:id/reset-password', authorize('super_admin'), async (req, res) => {
  try {
    const { new_password } = req.body;
    const tempPass = new_password || 'TempPass2026!';
    const hash = await bcrypt.hash(tempPass, 12);
    const db = getDb();
    db.prepare("UPDATE users SET password_hash = ?, force_password_reset = 1, updated_at = datetime('now') WHERE id = ?")
      .run(hash, req.params.id);
    logActivity({ userId: req.user.id, action: 'password_reset', entityType: 'user', entityId: req.params.id });
    res.json({ message: `Password reset. New temporary password: ${tempPass}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
