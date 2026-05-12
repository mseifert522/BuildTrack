const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/schema');
const { authenticate, authorize, authorizeOverUser, blacklistToken } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { sendInviteEmail } = require('../utils/email');

// Generate unique 5-digit PIN
function generatePin(db) {
  let pin;
  let attempts = 0;
  do {
    pin = String(Math.floor(10000 + Math.random() * 90000));
    const existing = db.prepare('SELECT id FROM users WHERE pin = ?').get(pin);
    if (!existing) return pin;
    attempts++;
  } while (attempts < 100);
  return pin;
}

router.use(authenticate);

// Multer config for avatar uploads
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../uploads/avatars');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `avatar-${req.user.id}${ext}`);
  },
});
const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files allowed'));
    cb(null, true);
  },
});

const VALID_ROLES = ['super_admin', 'operations_manager', 'project_manager', 'contractor'];
const CONTRACTOR_CATEGORIES = [
  'Floor',
  'Roof',
  'Electrical',
  'Plumbing',
  'Handymen',
  'Painting',
  'Drywall',
  'Concrete',
  'Cleaning',
  'Window Install',
  'Carpenter',
  'Carpet Installer',
  'Foundations',
  'Excavators',
  'Framing',
];

// GET /api/users/me - get current user profile (any authenticated user)
router.get('/me', (req, res) => {
  const db = getDb();
  const user = db.prepare(`
    SELECT
      id, name, email, role, phone, company, contractor_category, avatar_url,
      is_active, last_login_at, last_seen_at,
      CASE WHEN last_seen_at IS NOT NULL AND datetime(last_seen_at) >= datetime('now', '-2 minutes') THEN 1 ELSE 0 END as is_online
    FROM users
    WHERE id = ?
  `).get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// POST /api/users/me/avatar - upload avatar for current user
router.post('/me/avatar', avatarUpload.single('avatar'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    const db = getDb();
    db.prepare(`UPDATE users SET avatar_url = ?, updated_at = datetime('now') WHERE id = ?`).run(avatarUrl, req.user.id);
    logActivity({ userId: req.user.id, action: 'avatar_updated', entityType: 'user', entityId: req.user.id });
    res.json({ avatar_url: avatarUrl, message: 'Avatar updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload avatar' });
  }
});

// DELETE /api/users/me/avatar - remove avatar
router.delete('/me/avatar', (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.user.id);
    if (user?.avatar_url) {
      const filePath = path.join(__dirname, '../../', user.avatar_url);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    db.prepare(`UPDATE users SET avatar_url = NULL, updated_at = datetime('now') WHERE id = ?`).run(req.user.id);
    res.json({ message: 'Avatar removed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove avatar' });
  }
});

// GET /api/users - list all users (super_admin, operations_manager only)
router.get('/', authorize('super_admin', 'operations_manager'), (req, res) => {
  const db = getDb();
  const users = db.prepare(
    `SELECT
      id, name, email, role, phone, company, contractor_category, avatar_url,
      is_active, pin, created_at, last_login_at, last_seen_at,
      CASE WHEN last_seen_at IS NOT NULL AND datetime(last_seen_at) >= datetime('now', '-2 minutes') THEN 1 ELSE 0 END as is_online
     FROM users
     ORDER BY is_online DESC, name`
  ).all();
  res.json(users);
});

// GET /api/users/presence - show online/offline status in the header for management
router.get('/presence', authorize('super_admin', 'operations_manager', 'project_manager'), (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT
      id, name, email, role, avatar_url, last_login_at, last_seen_at,
      CASE WHEN last_seen_at IS NOT NULL AND datetime(last_seen_at) >= datetime('now', '-2 minutes') THEN 1 ELSE 0 END as is_online
    FROM users
    WHERE is_active = 1 AND role != 'contractor'
    ORDER BY is_online DESC, datetime(COALESCE(last_seen_at, last_login_at, created_at)) DESC, name
  `).all();
  res.json(users);
});

// GET /api/users/contractors - list contractors for assignment dropdowns
router.get('/contractors', authorize('super_admin', 'operations_manager', 'project_manager'), (req, res) => {
  const db = getDb();
  const users = db.prepare(
    "SELECT id, name, email, phone, company, contractor_category, last_seen_at, CASE WHEN last_seen_at IS NOT NULL AND datetime(last_seen_at) >= datetime('now', '-2 minutes') THEN 1 ELSE 0 END as is_online FROM users WHERE role = 'contractor' AND is_active = 1 ORDER BY name"
  ).all();
  res.json(users);
});

// GET /api/users/contractors/directory - contractor table with project and payment context
router.get('/contractors/directory', authorize('super_admin', 'operations_manager', 'project_manager'), (req, res) => {
  const db = getDb();
  const contractors = db.prepare(`
    SELECT
      cp.id,
      cp.vendor_name,
      cp.contact_name,
      cp.email,
      cp.phone,
      cp.billing_address,
      cp.account_number,
      cp.contractor_category,
      cp.linked_user_id,
      cp.source,
      u.name as linked_user_name,
      u.avatar_url,
      COALESCE(u.is_active, 1) as is_active,
      (SELECT COUNT(DISTINCT pa.project_id)
       FROM project_assignments pa
       WHERE cp.linked_user_id IS NOT NULL AND pa.user_id = cp.linked_user_id) as assigned_project_count,
      (SELECT GROUP_CONCAT(DISTINCT p.address)
       FROM project_assignments pa
       JOIN projects p ON p.id = pa.project_id
       WHERE cp.linked_user_id IS NOT NULL AND pa.user_id = cp.linked_user_id) as assigned_addresses,
      (SELECT COUNT(*)
       FROM invoices i
       WHERE cp.linked_user_id IS NOT NULL AND i.contractor_id = cp.linked_user_id) as invoice_count,
      (SELECT COALESCE(SUM(i.total), 0)
       FROM invoices i
       WHERE cp.linked_user_id IS NOT NULL AND i.contractor_id = cp.linked_user_id AND i.status = 'paid') as total_paid,
      (SELECT MAX(datetime(i.updated_at))
       FROM invoices i
       WHERE cp.linked_user_id IS NOT NULL AND i.contractor_id = cp.linked_user_id AND i.status = 'paid') as last_paid_at,
      (SELECT COUNT(*)
       FROM contractor_profile_notes cn
       WHERE cn.contractor_id = cp.id) as note_count,
      (SELECT MAX(datetime(cn.created_at))
       FROM contractor_profile_notes cn
       WHERE cn.contractor_id = cp.id) as latest_note_at
    FROM contractor_profiles cp
    LEFT JOIN users u ON u.id = cp.linked_user_id
    WHERE COALESCE(u.is_active, 1) = 1
    ORDER BY cp.vendor_name
  `).all();

  const lastPaid = db.prepare(`
    SELECT i.id, i.invoice_number, i.contractor_id, i.project_id, i.total, i.status, i.updated_at, p.address, p.job_name
    FROM invoices i
    JOIN projects p ON p.id = i.project_id
    WHERE i.contractor_id = ? AND i.status = 'paid'
    ORDER BY datetime(i.updated_at) DESC, datetime(i.created_at) DESC
    LIMIT 1
  `);

  const lastInvoice = db.prepare(`
    SELECT i.id, i.invoice_number, i.contractor_id, i.project_id, i.total, i.status, i.updated_at, i.created_at, p.address, p.job_name
    FROM invoices i
    JOIN projects p ON p.id = i.project_id
    WHERE i.contractor_id = ?
    ORDER BY datetime(i.updated_at) DESC, datetime(i.created_at) DESC
    LIMIT 1
  `);

  const invoiceAddresses = db.prepare(`
    SELECT DISTINCT p.id, p.address, p.job_name, p.status
    FROM invoices i
    JOIN projects p ON p.id = i.project_id
    WHERE i.contractor_id = ?
    ORDER BY p.address
  `);

  const linkedProjects = db.prepare(`
    SELECT DISTINCT p.id, p.address, p.job_name, p.status
    FROM contractor_project_links cpl
    JOIN projects p ON p.id = cpl.project_id
    WHERE cpl.contractor_id = ?
    ORDER BY p.address
  `);

  const result = contractors.map((contractor) => {
    const linkedUserId = contractor.linked_user_id;
    const paid = linkedUserId ? (lastPaid.get(linkedUserId) || null) : null;
    const invoice = linkedUserId ? (lastInvoice.get(linkedUserId) || null) : null;
    const assignedAddresses = contractor.assigned_addresses
      ? contractor.assigned_addresses.split(',').filter(Boolean)
      : [];
    const manualProjects = linkedProjects.all(contractor.id);
    const paidProjects = linkedUserId ? invoiceAddresses.all(linkedUserId) : [];
    const connectedProjectMap = new Map();

    for (const project of manualProjects) {
      connectedProjectMap.set(project.id, project);
    }
    for (const project of paidProjects) {
      if (project.id) connectedProjectMap.set(project.id, project);
    }
    for (const address of assignedAddresses) {
      if (!Array.from(connectedProjectMap.values()).some(project => project.address === address)) {
        connectedProjectMap.set(`address:${address}`, { id: null, address, job_name: null, status: null });
      }
    }

    const connectedProjects = Array.from(connectedProjectMap.values());
    const projectAddresses = connectedProjects.map(project => project.address).filter(Boolean);

    return {
      ...contractor,
      name: contractor.vendor_name,
      company: contractor.vendor_name,
      connected_projects: connectedProjects,
      project_addresses: projectAddresses,
      connected_project_count: projectAddresses.length,
      last_paid_invoice: paid,
      last_invoice: invoice,
      total_paid: Number(contractor.total_paid || 0),
    };
  });

  res.json({ categories: CONTRACTOR_CATEGORIES, contractors: result });
});

function requireContractor(db, contractorId) {
  return db.prepare("SELECT id, vendor_name as name FROM contractor_profiles WHERE id = ?").get(contractorId);
}

// PUT /api/users/contractors/:id/profile - edit imported/vendor contractor details
router.put('/contractors/:id/profile', authorize('super_admin', 'operations_manager', 'project_manager'), (req, res) => {
  try {
    const db = getDb();
    const contractor = requireContractor(db, req.params.id);
    if (!contractor) return res.status(404).json({ error: 'Contractor not found' });

    const {
      vendor_name,
      contact_name,
      email,
      phone,
      billing_address,
      account_number,
      contractor_category,
    } = req.body;

    const nextName = String(vendor_name || '').trim();
    if (!nextName) return res.status(400).json({ error: 'Contractor name is required' });
    if (contractor_category && !CONTRACTOR_CATEGORIES.includes(contractor_category)) {
      return res.status(400).json({ error: 'Invalid contractor category' });
    }

    db.prepare(`
      UPDATE contractor_profiles SET
        vendor_name = ?,
        contact_name = ?,
        email = ?,
        phone = ?,
        billing_address = ?,
        account_number = ?,
        contractor_category = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      nextName,
      contact_name ? String(contact_name).trim() : null,
      email ? String(email).trim().toLowerCase() : null,
      phone ? String(phone).trim() : null,
      billing_address ? String(billing_address).trim() : null,
      account_number ? String(account_number).trim() : null,
      contractor_category || null,
      req.params.id
    );

    logActivity({
      userId: req.user.id,
      action: 'contractor_profile_updated',
      entityType: 'contractor_profile',
      entityId: req.params.id,
      details: { contractor_name: nextName, contractor_category: contractor_category || null },
    });

    const updated = db.prepare('SELECT * FROM contractor_profiles WHERE id = ?').get(req.params.id);
    res.json({ contractor: updated, message: 'Contractor updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update contractor' });
  }
});

// PUT /api/users/contractors/:id/projects - replace explicit project links for a contractor
router.put('/contractors/:id/projects', authorize('super_admin', 'operations_manager', 'project_manager'), (req, res) => {
  try {
    const db = getDb();
    const contractor = requireContractor(db, req.params.id);
    if (!contractor) return res.status(404).json({ error: 'Contractor not found' });

    const rawIds = Array.isArray(req.body.project_ids) ? req.body.project_ids : [];
    const projectIds = Array.from(new Set(rawIds.map(id => String(id || '').trim()).filter(Boolean)));
    if (projectIds.length > 200) return res.status(400).json({ error: 'Too many projects selected' });

    if (projectIds.length > 0) {
      const placeholders = projectIds.map(() => '?').join(',');
      const found = db.prepare(`SELECT id FROM projects WHERE id IN (${placeholders})`).all(...projectIds);
      if (found.length !== projectIds.length) return res.status(400).json({ error: 'One or more selected projects are invalid' });
    }

    const replaceLinks = db.transaction(() => {
      db.prepare('DELETE FROM contractor_project_links WHERE contractor_id = ?').run(req.params.id);
      const insert = db.prepare(`
        INSERT INTO contractor_project_links (id, contractor_id, project_id, created_by, created_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `);
      for (const projectId of projectIds) {
        insert.run(uuidv4(), req.params.id, projectId, req.user.id);
      }
    });
    replaceLinks();

    logActivity({
      userId: req.user.id,
      action: 'contractor_projects_updated',
      entityType: 'contractor_profile',
      entityId: req.params.id,
      details: { contractor_name: contractor.name, project_count: projectIds.length },
    });

    const projects = projectIds.length
      ? db.prepare(`SELECT id, address, job_name, status FROM projects WHERE id IN (${projectIds.map(() => '?').join(',')}) ORDER BY address`).all(...projectIds)
      : [];
    res.json({ projects, message: 'Contractor projects updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update contractor projects' });
  }
});

// DELETE /api/users/contractors/:id/profile - remove a contractor directory record
router.delete('/contractors/:id/profile', authorize('super_admin', 'operations_manager'), (req, res) => {
  try {
    const db = getDb();
    const contractor = db.prepare('SELECT * FROM contractor_profiles WHERE id = ?').get(req.params.id);
    if (!contractor) return res.status(404).json({ error: 'Contractor not found' });

    const removeContractor = db.transaction(() => {
      db.prepare('DELETE FROM contractor_project_links WHERE contractor_id = ?').run(req.params.id);
      db.prepare('DELETE FROM contractor_profile_notes WHERE contractor_id = ?').run(req.params.id);
      db.prepare('DELETE FROM contractor_profiles WHERE id = ?').run(req.params.id);

      if (contractor.linked_user_id) {
        db.prepare(`
          UPDATE users
          SET is_active = 0, updated_at = datetime('now')
          WHERE id = ? AND role = 'contractor'
        `).run(contractor.linked_user_id);
      }
    });
    removeContractor();

    logActivity({
      userId: req.user.id,
      action: 'contractor_deleted',
      entityType: 'contractor_profile',
      entityId: req.params.id,
      details: {
        contractor_name: contractor.vendor_name,
        linked_user_deactivated: contractor.linked_user_id ? true : false,
      },
    });

    res.json({ message: 'Contractor deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete contractor' });
  }
});

// GET /api/users/contractors/:id/notes - management-only contractor notes
router.get('/contractors/:id/notes', authorize('super_admin', 'operations_manager', 'project_manager'), (req, res) => {
  const db = getDb();
  const contractor = requireContractor(db, req.params.id);
  if (!contractor) return res.status(404).json({ error: 'Contractor not found' });

  const notes = db.prepare(`
    SELECT cn.*, u.name as user_name, u.role as user_role, u.avatar_url as user_avatar_url
    FROM contractor_profile_notes cn
    JOIN users u ON u.id = cn.user_id
    WHERE cn.contractor_id = ?
    ORDER BY datetime(cn.created_at) DESC, cn.created_at DESC
  `).all(req.params.id);

  res.json(notes);
});

// POST /api/users/contractors/:id/notes - add note to contractor record
router.post('/contractors/:id/notes', authorize('super_admin', 'operations_manager', 'project_manager'), (req, res) => {
  const { note } = req.body;
  if (!note || !note.trim()) return res.status(400).json({ error: 'Note text is required' });

  const db = getDb();
  const contractor = requireContractor(db, req.params.id);
  if (!contractor) return res.status(404).json({ error: 'Contractor not found' });

  const id = uuidv4();
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO contractor_profile_notes (id, contractor_id, user_id, note, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, req.params.id, req.user.id, note.trim(), createdAt);

  logActivity({
    userId: req.user.id,
    action: 'contractor_note_added',
    entityType: 'contractor_note',
    entityId: id,
    details: { contractor_id: req.params.id, contractor_name: contractor.name },
  });

  res.status(201).json({
    id,
    contractor_id: req.params.id,
    user_id: req.user.id,
    user_name: req.user.name,
    user_role: req.user.role,
    user_avatar_url: req.user.avatar_url || null,
    note: note.trim(),
    created_at: createdAt,
  });
});

// DELETE /api/users/contractors/:id/notes/:noteId - delete own note or admin note
router.delete('/contractors/:id/notes/:noteId', authorize('super_admin', 'operations_manager', 'project_manager'), (req, res) => {
  const db = getDb();
  const note = db.prepare('SELECT * FROM contractor_profile_notes WHERE id = ? AND contractor_id = ?').get(req.params.noteId, req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });

  const canDelete = note.user_id === req.user.id || ['super_admin', 'operations_manager'].includes(req.user.role);
  if (!canDelete) return res.status(403).json({ error: 'Cannot delete this note' });

  db.prepare('DELETE FROM contractor_profile_notes WHERE id = ?').run(req.params.noteId);
  res.json({ message: 'Note deleted' });
});

// POST /api/users - create user (super_admin or operations_manager)
router.post('/', authorize('super_admin', 'operations_manager'), async (req, res) => {
  try {
    const { name, email, role, phone, company, contractor_category, password } = req.body;
    if (!name || !email || !role) return res.status(400).json({ error: 'Name, email, and role are required' });
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (role === 'contractor' && contractor_category && !CONTRACTOR_CATEGORIES.includes(contractor_category)) {
      return res.status(400).json({ error: 'Invalid contractor category' });
    }

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

    // Auto-generate PIN for contractors
    const pin = generatePin(db);

    db.prepare(
      `INSERT INTO users (id, name, email, password_hash, role, phone, company, contractor_category, force_password_reset, pin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(id, name, email.toLowerCase().trim(), hash, role, phone || null, company || null, role === 'contractor' ? (contractor_category || null) : null, pin);

    if (role === 'contractor') {
      db.prepare(`
        INSERT OR IGNORE INTO contractor_profiles (
          id, vendor_name, contact_name, email, phone, contractor_category, linked_user_id, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'user', datetime('now'), datetime('now'))
      `).run(id, company || name, name, email.toLowerCase().trim(), phone || null, contractor_category || null, id);
    }

    logActivity({ userId: req.user.id, action: 'user_created', entityType: 'user', entityId: id, details: { name, email, role, contractor_category } });

    // Send invite email
    try {
      await sendInviteEmail({ name, email: email.toLowerCase().trim(), tempPassword: tempPass, role, invitedBy: req.user.name, pin });
    } catch (emailErr) {
      console.error('Failed to send invite email:', emailErr);
    }

    res.status(201).json({ id, name, email, role, pin, message: pin ? `User created. PIN: ${pin}. Invite sent to ${email}.` : `User created. Invite sent to ${email}.` });
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

    const { name, email, role, phone, company, contractor_category, is_active } = req.body;

    // Operations Manager cannot promote someone to Super Admin
    if (req.user.role === 'operations_manager' && role === 'super_admin') {
      return res.status(403).json({ error: 'Operations Manager cannot assign Super Admin role' });
    }
    const nextRole = role || target.role;
    if (nextRole === 'contractor' && contractor_category && !CONTRACTOR_CATEGORIES.includes(contractor_category)) {
      return res.status(400).json({ error: 'Invalid contractor category' });
    }

    db.prepare(
      `UPDATE users SET name = ?, email = ?, role = ?, phone = ?, company = ?, contractor_category = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(
      name || target.name,
      email || target.email,
      nextRole,
      phone ?? target.phone,
      company ?? target.company,
      nextRole === 'contractor' ? (contractor_category ?? target.contractor_category) : null,
      is_active !== undefined ? (is_active ? 1 : 0) : target.is_active,
      req.params.id
    );

    if (nextRole === 'contractor') {
      db.prepare(`
        INSERT INTO contractor_profiles (
          id, vendor_name, contact_name, email, phone, contractor_category, linked_user_id, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'user', datetime('now'), datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          vendor_name = excluded.vendor_name,
          contact_name = excluded.contact_name,
          email = excluded.email,
          phone = excluded.phone,
          contractor_category = excluded.contractor_category,
          linked_user_id = excluded.linked_user_id,
          updated_at = datetime('now')
      `).run(
        req.params.id,
        (company ?? target.company) || name || target.name,
        name || target.name,
        email || target.email,
        phone ?? target.phone,
        contractor_category ?? target.contractor_category,
        req.params.id
      );
    }

    logActivity({ userId: req.user.id, action: 'user_updated', entityType: 'user', entityId: req.params.id, details: { name, role: nextRole, contractor_category, is_active } });
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

// POST /api/users/:id/avatar - upload avatar for any user (admin only)
router.post('/:id/avatar', authorize('super_admin', 'operations_manager'), (req, res, next) => {
  // Override multer filename to use target user's ID
  const targetId = req.params.id;
  const storage = require('multer').diskStorage({
    destination: (r, file, cb) => {
      const dir = require('path').join(__dirname, '../../uploads/avatars');
      if (!require('fs').existsSync(dir)) require('fs').mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (r, file, cb) => {
      const ext = require('path').extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `avatar-${targetId}${ext}`);
    },
  });
  const upload = require('multer')({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (r, file, cb) => {
      if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files allowed'));
      cb(null, true);
    },
  }).single('avatar');

  upload(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    const db = getDb();
    db.prepare(`UPDATE users SET avatar_url = ?, updated_at = datetime('now') WHERE id = ?`).run(avatarUrl, targetId);
    logActivity({ userId: req.user.id, action: 'avatar_updated', entityType: 'user', entityId: targetId });
    res.json({ avatar_url: avatarUrl, message: 'Avatar updated' });
  });
});

// PUT /api/users/:id/pin - update PIN (admin only)
router.put('/:id/pin', authorize('super_admin', 'operations_manager'), (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || !/^\d{5}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 5 digits' });
    const db = getDb();
    const existing = db.prepare('SELECT id FROM users WHERE pin = ? AND id != ?').get(pin, req.params.id);
    if (existing) return res.status(409).json({ error: 'PIN already in use by another user' });
    db.prepare("UPDATE users SET pin = ?, updated_at = datetime('now') WHERE id = ?").run(pin, req.params.id);
    logActivity({ userId: req.user.id, action: 'pin_updated', entityType: 'user', entityId: req.params.id });
    res.json({ message: 'PIN updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update PIN' });
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
