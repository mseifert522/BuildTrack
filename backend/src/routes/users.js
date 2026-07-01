const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/schema');
const { authenticate, authorize, blockProjectManagerMutation, authorizeOverUser, blacklistToken } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { logDataAccess } = require('../utils/dataAccessAudit');
const { sendInviteEmail, sendPasswordResetEmail } = require('../utils/email');
const { decryptJson } = require('../utils/secureFields');
const { ensureContractorMobileAccount, generatePin, syncContractorProjectAssignments } = require('../utils/contractorAccess');

router.use(authenticate);

const avatarUploadBase = () => path.resolve(process.env.UPLOADS_PATH || './uploads');
const avatarUploadDir = () => path.join(avatarUploadBase(), 'avatars');
const avatarPublicUrl = filename => `/uploads/avatars/${filename}`;
const avatarFileName = (userId, originalName) => {
  const safeUserId = String(userId || 'user').replace(/[^a-zA-Z0-9_-]/g, '');
  const ext = path.extname(originalName || '').toLowerCase() || '.jpg';
  return `avatar-${safeUserId}-${Date.now()}${ext}`;
};
const avatarPathFromUrl = avatarUrl => {
  const cleanPath = String(avatarUrl || '').split('?')[0];
  if (!cleanPath.startsWith('/uploads/avatars/')) return null;
  return path.join(avatarUploadDir(), path.basename(cleanPath));
};
const unlinkAvatarFile = avatarUrl => {
  const filePath = avatarPathFromUrl(avatarUrl);
  if (!filePath || !fs.existsSync(filePath)) return;
  fs.unlinkSync(filePath);
};

// Multer config for avatar uploads
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = avatarUploadDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, avatarFileName(req.user.id, file.originalname));
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
const USER_SETUP_LINK_TTL_MINUTES = Number(process.env.USER_SETUP_LINK_TTL_MINUTES || 7 * 24 * 60);
const OWNER_EMAILS = new Set(
  String(process.env.BUILDTRACK_OWNER_EMAILS || 'mike@seifertcapital.com')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean)
);
const PROTECTED_USER_EMAILS = new Set(
  String(process.env.BUILDTRACK_PROTECTED_USER_EMAILS || 'jeanettemfallon@gmail.com')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean)
);
const DEFAULT_CONTRACTOR_CATEGORIES = [
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
  'Landscaping Materials',
  'General Building Materials',
  'Portable Toilets',
  'Tool Rentals',
  'Appliances',
  'Fixtures',
  'Building Materials',
  'Lumber',
  'Roofing Materials',
  'Siding Materials',
  'Electrical Supplies',
  'Plumbing Supplies',
  'HVAC Supplies',
  'Flooring Materials',
  'Paint',
  'Concrete and Masonry',
  'Windows and Doors',
  'Cabinets and Countertops',
  'Countertops and Stone',
  'Tile and Stone',
  'Tools and Hardware',
  'Welding Supplies',
  'Industrial Supplies',
  'Equipment Rentals',
  'Truck and Trailer Rentals',
  'Steel and Metal',
  'Fixtures and Furnishings',
  'Dumpster and Hauling',
  'Cleaning Supplies',
];

function normalizeEmailAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function sqliteDateTime(date) {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function minutesFromNow(minutes) {
  return sqliteDateTime(new Date(Date.now() + minutes * 60 * 1000));
}

function setupUrlForToken(token) {
  const appUrl = (process.env.APP_URL || 'https://buildtrack.newurbandev.com').replace(/\/+$/, '');
  return `${appUrl}/reset-password?token=${encodeURIComponent(token)}`;
}

function createPasswordSetupToken(db, userId, ttlMinutes = USER_SETUP_LINK_TTL_MINUTES) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = minutesFromNow(ttlMinutes);
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0').run(userId);
  db.prepare(
    'INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)'
  ).run(uuidv4(), userId, token, expiresAt);
  return { token, setupUrl: setupUrlForToken(token), expiresAt };
}

function ensureUserPin(db, user) {
  if (user?.pin && /^\d{5}$/.test(String(user.pin))) return user.pin;
  const pin = generatePin(db);
  db.prepare("UPDATE users SET pin = ?, updated_at = datetime('now') WHERE id = ?").run(pin, user.id);
  return pin;
}

function isOwnerUser(user) {
  return OWNER_EMAILS.has(normalizeEmailAddress(user?.email));
}

function isProtectedUser(user) {
  const email = normalizeEmailAddress(user?.email);
  return PROTECTED_USER_EMAILS.has(email) || (email.includes('fallon') && String(user?.name || '').toLowerCase().includes('jeanette'));
}

function canManageTargetUser(actor, target) {
  if (!actor || !target || actor.id === target.id) return false;
  if (isOwnerUser(actor)) return true;
  return authorizeOverUser(actor.role, target.role);
}

function canDeleteTargetUser(actor, target) {
  if (!canManageTargetUser(actor, target)) return false;
  if (isProtectedUser(target) && !isOwnerUser(actor)) return false;
  return true;
}

function deletedEmailForUser(user) {
  const idPart = String(user.id || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || Date.now();
  return `deleted+${idPart}@buildtrack.local`;
}

const SUPPLIER_CATEGORY_RULES = [
  { includes: ['landscape', 'landscaping', 'sod'], categories: ['Landscaping Materials'] },
  { includes: ['wimsatt', 'abc supply', 'gulfeagle'], categories: ['Roofing Materials', 'Siding Materials'] },
  { includes: ['siding'], categories: ['Siding Materials'] },
  { includes: ['lumber', 'churchs'], categories: ['Lumber', 'General Building Materials'] },
  { includes: ['home depot', 'lowes', 'menard'], categories: ['General Building Materials'] },
  { includes: ['ace hardware', 'hardware', 'harbor freight', 'tractor supply', 'colony hardware'], categories: ['Tools and Hardware'] },
  { includes: ['sunbelt', 'rent all', 'rental'], categories: ['Equipment Rentals', 'Tool Rentals'] },
  { includes: ['u-haul', 'trailer'], categories: ['Truck and Trailer Rentals'] },
  { includes: ['appliance'], categories: ['Appliances'] },
  { includes: ['wayfair', 'nikos'], categories: ['Fixtures and Furnishings'] },
  { includes: ['floor'], categories: ['Flooring Materials'] },
  { includes: ['tile'], categories: ['Tile and Stone'] },
  { includes: ['granite', 'stone'], categories: ['Countertops and Stone'] },
  { includes: ['window'], categories: ['Windows and Doors'] },
  { includes: ['gas', 'welding'], categories: ['Welding Supplies'] },
  { includes: ['grainger'], categories: ['Industrial Supplies', 'Tools and Hardware'] },
  { includes: ['steel'], categories: ['Steel and Metal'] },
  { includes: ['tee pee'], categories: ['Portable Toilets'] },
  { includes: ['kaltz'], categories: ['Plumbing Supplies'] },
];

const SUPPLIER_CATEGORY_ALIASES = {
  floor: 'Flooring Materials',
  roof: 'Roofing Materials',
  roofing: 'Roofing Materials',
  electrical: 'Electrical Supplies',
  plumbing: 'Plumbing Supplies',
  painting: 'Paint',
  concrete: 'Concrete and Masonry',
  cleaning: 'Cleaning Supplies',
  'window install': 'Windows and Doors',
  landscaping: 'Landscaping Materials',
  supplier: '',
};

function normalizeCategory(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function categorySlug(value) {
  return normalizeCategory(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function getContractorCategories(db) {
  try {
    const rows = db.prepare('SELECT name FROM contractor_categories ORDER BY lower(name)').all();
    if (rows.length > 0) return rows.map(row => row.name);
  } catch (_) {
    // Table may not exist until schema migration runs.
  }
  return DEFAULT_CONTRACTOR_CATEGORIES;
}

function cleanDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function formatTaxIdForDisplay(value, type) {
  const digits = cleanDigits(value).slice(0, 9);
  if (digits.length !== 9) return value || null;
  return type === 'ein' ? `${digits.slice(0, 2)}-${digits.slice(2)}` : `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

function complianceMailingAddress(payload, row) {
  const cityLine = [
    payload.city || row.city,
    payload.state || row.state,
    payload.postal_code || row.postal_code,
  ].filter(Boolean).join(', ');
  return [
    payload.address_line1 || row.address_line1,
    payload.address_line2 || row.address_line2,
    cityLine,
    payload.country || row.country,
  ].filter(Boolean).join('\n');
}

function booleanLabel(value) {
  return value ? 'Yes' : 'No';
}

function resolveCategory(db, value) {
  const name = normalizeCategory(value);
  if (!name) return null;
  const categories = getContractorCategories(db);
  return categories.find(category => category.toLowerCase() === name.toLowerCase()) || null;
}

function validateCategory(db, value, label = 'contractor category') {
  const name = normalizeCategory(value);
  if (!name) return null;
  const resolved = resolveCategory(db, name);
  if (resolved) return resolved;
  const err = new Error(`Invalid ${label}`);
  err.statusCode = 400;
  throw err;
}

function uniqueCategories(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const name = normalizeCategory(value);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

function validateContractorCategories(db, categories, primaryCategory, secondaryCategory) {
  const requested = Array.isArray(categories)
    ? categories
    : [primaryCategory, secondaryCategory];
  return uniqueCategories(requested).map(category => validateCategory(db, category, 'contractor category')).filter(Boolean);
}

function parseStoredContractorCategories(contractor) {
  let stored = [];
  try {
    const parsed = JSON.parse(contractor.contractor_categories_json || '[]');
    if (Array.isArray(parsed)) stored = parsed;
  } catch (_) {
    stored = [];
  }
  return uniqueCategories([
    ...stored,
    contractor.contractor_category,
    contractor.contractor_secondary_category,
  ]);
}

function normalizeSupplierCategoryName(value) {
  const raw = normalizeCategory(value);
  if (!raw) return '';
  const aliased = SUPPLIER_CATEGORY_ALIASES[raw.toLowerCase()] ?? raw;
  if (!aliased) return '';
  return DEFAULT_CONTRACTOR_CATEGORIES.find(category => category.toLowerCase() === String(aliased).toLowerCase()) || aliased;
}

function uniqueSupplierCategories(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const category = normalizeSupplierCategoryName(value);
    if (!category) continue;
    const key = category.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(category);
  }
  return result;
}

function inferSupplierCategoriesFromName(name) {
  const normalized = String(name || '').toLowerCase();
  const matched = [];
  for (const rule of SUPPLIER_CATEGORY_RULES) {
    if (rule.includes.some(term => normalized.includes(term))) {
      matched.push(...rule.categories);
    }
  }
  return uniqueSupplierCategories(matched.length ? matched : ['General Building Materials']);
}

function validateContractorStatus(value) {
  const status = String(value || 'active').trim().toLowerCase();
  if (['active', 'terminated', 'will_use_again'].includes(status)) return status;
  const err = new Error('Invalid contractor status');
  err.statusCode = 400;
  throw err;
}

function createContractorCategory(db, rawName, userId) {
  const name = normalizeCategory(rawName);
  if (!name) {
    const err = new Error('Category name is required');
    err.statusCode = 400;
    throw err;
  }
  if (name.length > 80) {
    const err = new Error('Category name must be 80 characters or less');
    err.statusCode = 400;
    throw err;
  }

  const existing = resolveCategory(db, name);
  if (existing) return existing;
  const id = categorySlug(name) || uuidv4();
  db.prepare(`
    INSERT OR IGNORE INTO contractor_categories (id, name, created_by, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(id, name, userId);
  return resolveCategory(db, name) || name;
}

function categoryError(res, err) {
  if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message });
  console.error(err);
  return res.status(500).json({ error: 'Failed to save contractor category' });
}

function formatSupplierProfile(supplier) {
  const storedCategories = uniqueSupplierCategories(parseStoredContractorCategories(supplier));
  const categories = storedCategories.length ? storedCategories : inferSupplierCategoriesFromName(supplier.vendor_name);
  return {
    id: supplier.id,
    name: supplier.vendor_name,
    contact: supplier.contact_name,
    email: supplier.email,
    phone: supplier.phone,
    billing_address: supplier.billing_address,
    account_number: supplier.account_number,
    categories,
    category: categories.join(' / ') || 'Supplier',
    category_inferred: storedCategories.length === 0,
    supplier_marked_at: supplier.supplier_marked_at,
    created_at: supplier.created_at,
    updated_at: supplier.updated_at,
  };
}

function supplierPayload(req) {
  const db = getDb();
  const nextName = String(req.body?.vendor_name || req.body?.name || '').trim();
  if (!nextName) {
    const err = new Error('Supplier name is required');
    err.statusCode = 400;
    throw err;
  }

  const nextEmail = req.body?.email ? String(req.body.email).trim().toLowerCase() : null;
  if (nextEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
    const err = new Error('Valid supplier email is required');
    err.statusCode = 400;
    throw err;
  }

  const categories = validateContractorCategories(
    db,
    req.body?.categories || req.body?.contractor_categories,
    req.body?.category || req.body?.contractor_category,
    req.body?.contractor_secondary_category
  );
  if (categories.length === 0) {
    const err = new Error('Supplier category is required');
    err.statusCode = 400;
    throw err;
  }

  return {
    db,
    name: nextName,
    contact: req.body?.contact || req.body?.contact_name ? String(req.body.contact || req.body.contact_name).trim() : null,
    email: nextEmail,
    phone: req.body?.phone ? String(req.body.phone).trim() : null,
    billingAddress: req.body?.billing_address ? String(req.body.billing_address).trim() : null,
    accountNumber: req.body?.account_number ? String(req.body.account_number).trim() : null,
    categories,
    primaryCategory: categories[0] || null,
    secondaryCategory: categories[1] || null,
  };
}

// GET /api/users/me - get current user profile (any authenticated user)
router.get('/me', (req, res) => {
  const db = getDb();
  const user = db.prepare(`
    SELECT
      id, name, email, role, phone, company, contractor_category, contractor_secondary_category, avatar_url,
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
    const avatarUrl = avatarPublicUrl(req.file.filename);
    const db = getDb();
    const previous = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.user.id);
    db.prepare(`UPDATE users SET avatar_url = ?, updated_at = datetime('now') WHERE id = ?`).run(avatarUrl, req.user.id);
    if (previous?.avatar_url && previous.avatar_url !== avatarUrl) unlinkAvatarFile(previous.avatar_url);
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
    if (user?.avatar_url) unlinkAvatarFile(user.avatar_url);
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
      id, name, email, role, phone, company, contractor_category, contractor_secondary_category, avatar_url,
      is_active, pin, created_at, last_login_at, last_seen_at,
      CASE WHEN last_seen_at IS NOT NULL AND datetime(last_seen_at) >= datetime('now', '-2 minutes') THEN 1 ELSE 0 END as is_online
     FROM users
     WHERE deleted_at IS NULL
     ORDER BY is_online DESC, name`
  ).all();
  logDataAccess(req, {
    action: 'user_directory_viewed',
    accessType: 'view',
    entityType: 'user',
    recordCount: users.length,
    riskLevel: 'high',
  });
  res.json(users);
});

// GET /api/users/contractors - list contractors for assignment dropdowns
router.get('/contractors', authorize('super_admin', 'operations_manager', 'project_manager'), (req, res) => {
  const db = getDb();
  const users = db.prepare(
    "SELECT id, name, email, phone, company, contractor_category, contractor_secondary_category, last_seen_at, CASE WHEN last_seen_at IS NOT NULL AND datetime(last_seen_at) >= datetime('now', '-2 minutes') THEN 1 ELSE 0 END as is_online FROM users WHERE role = 'contractor' AND is_active = 1 AND deleted_at IS NULL ORDER BY name"
  ).all();
  logDataAccess(req, {
    action: 'contractor_user_list_viewed',
    accessType: 'view',
    entityType: 'contractor',
    recordCount: users.length,
    riskLevel: 'high',
  });
  res.json(users);
});

// GET /api/users/contractor-categories - list contractor categories for dropdowns
router.get('/contractor-categories', authorize('super_admin', 'operations_manager', 'project_manager'), (req, res) => {
  const db = getDb();
  res.json({ categories: getContractorCategories(db) });
});

// POST /api/users/contractor-categories - super admin and operations manager can add categories
router.post('/contractor-categories', authorize('super_admin', 'operations_manager'), (req, res) => {
  try {
    const db = getDb();
    const category = createContractorCategory(db, req.body?.name, req.user.id);
    logActivity({
      userId: req.user.id,
      action: 'contractor_category_created',
      entityType: 'contractor_category',
      details: { name: category },
    });
    res.status(201).json({ category, categories: getContractorCategories(db) });
  } catch (err) {
    categoryError(res, err);
  }
});

// GET /api/users/suppliers - contractors temporarily marked for the Suppliers tab
router.get('/suppliers', authorize('super_admin', 'operations_manager', 'project_manager'), (req, res) => {
  const db = getDb();
  const suppliers = db.prepare(`
    SELECT
      id,
      vendor_name,
      contact_name,
      email,
      phone,
      billing_address,
      account_number,
      contractor_category,
      contractor_secondary_category,
      contractor_categories_json,
      supplier_marked_at,
      created_at,
      updated_at
    FROM contractor_profiles
    WHERE COALESCE(is_supplier, 0) = 1
    ORDER BY datetime(COALESCE(supplier_marked_at, created_at)) DESC, vendor_name
  `).all();

  const response = suppliers.map(formatSupplierProfile);
  logDataAccess(req, {
    action: 'supplier_list_viewed',
    accessType: 'view',
    entityType: 'supplier',
    recordCount: response.length,
    riskLevel: 'high',
  });
  res.json(response);
});

// POST /api/users/suppliers - add a supplier record with supply categories
router.post('/suppliers', authorize('super_admin', 'operations_manager', 'project_manager'), (req, res) => {
  try {
    const payload = supplierPayload(req);
    const supplierId = uuidv4();
    const markedAt = new Date().toISOString();

    payload.db.prepare(`
      INSERT INTO contractor_profiles (
        id, vendor_name, contact_name, email, phone, billing_address, account_number,
        contractor_status, contractor_category, contractor_secondary_category, contractor_categories_json,
        is_supplier, supplier_marked_at, supplier_marked_by, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 1, ?, ?, 'manual_supplier', datetime('now'), datetime('now'))
    `).run(
      supplierId,
      payload.name,
      payload.contact,
      payload.email,
      payload.phone,
      payload.billingAddress,
      payload.accountNumber,
      payload.primaryCategory,
      payload.secondaryCategory,
      JSON.stringify(payload.categories),
      markedAt,
      req.user.id
    );

    logActivity({
      userId: req.user.id,
      action: 'supplier_profile_created',
      entityType: 'contractor_profile',
      entityId: supplierId,
      details: { supplier_name: payload.name, supplier_categories: payload.categories },
    });

    const supplier = payload.db.prepare('SELECT * FROM contractor_profiles WHERE id = ?').get(supplierId);
    res.status(201).json({ supplier: formatSupplierProfile(supplier), message: 'Supplier added' });
  } catch (err) {
    if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message });
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A supplier with this name already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to add supplier' });
  }
});

// PUT /api/users/suppliers/:id - edit supplier details and categories
router.put('/suppliers/:id', authorize('super_admin', 'operations_manager', 'project_manager'), blockProjectManagerMutation, (req, res) => {
  try {
    const payload = supplierPayload(req);
    const existing = payload.db.prepare('SELECT * FROM contractor_profiles WHERE id = ? AND COALESCE(is_supplier, 0) = 1').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Supplier not found' });

    payload.db.prepare(`
      UPDATE contractor_profiles SET
        vendor_name = ?,
        contact_name = ?,
        email = ?,
        phone = ?,
        billing_address = ?,
        account_number = ?,
        contractor_category = ?,
        contractor_secondary_category = ?,
        contractor_categories_json = ?,
        updated_at = datetime('now')
      WHERE id = ? AND COALESCE(is_supplier, 0) = 1
    `).run(
      payload.name,
      payload.contact,
      payload.email,
      payload.phone,
      payload.billingAddress,
      payload.accountNumber,
      payload.primaryCategory,
      payload.secondaryCategory,
      JSON.stringify(payload.categories),
      req.params.id
    );

    logActivity({
      userId: req.user.id,
      action: 'supplier_profile_updated',
      entityType: 'contractor_profile',
      entityId: req.params.id,
      details: { supplier_name: payload.name, supplier_categories: payload.categories },
    });

    const supplier = payload.db.prepare('SELECT * FROM contractor_profiles WHERE id = ?').get(req.params.id);
    res.json({ supplier: formatSupplierProfile(supplier), message: 'Supplier updated' });
  } catch (err) {
    if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to update supplier' });
  }
});

// GET /api/users/contractors/directory - contractor table with project and payment context
router.get('/contractors/directory', authorize('super_admin', 'operations_manager', 'project_manager'), (req, res) => {
  const db = getDb();
  const contractors = db.prepare(`
    SELECT
      cp.id,
      cp.vendor_name,
      COALESCE(NULLIF(cp.contact_name, ''), ccp.legal_name) as contact_name,
      COALESCE(NULLIF(cp.email, ''), ccp.email) as email,
      COALESCE(NULLIF(cp.phone, ''), ccp.phone) as phone,
      COALESCE(
        NULLIF(cp.billing_address, ''),
        NULLIF(trim(
          COALESCE(ccp.address_line1, '') ||
          CASE WHEN trim(COALESCE(ccp.address_line2, '')) <> '' THEN char(10) || ccp.address_line2 ELSE '' END ||
          CASE WHEN trim(COALESCE(ccp.city, '') || COALESCE(ccp.state, '') || COALESCE(ccp.postal_code, '')) <> ''
            THEN char(10) || trim(COALESCE(ccp.city, '') || CASE WHEN trim(COALESCE(ccp.state, '')) <> '' THEN ', ' || ccp.state ELSE '' END || CASE WHEN trim(COALESCE(ccp.postal_code, '')) <> '' THEN ' ' || ccp.postal_code ELSE '' END)
            ELSE ''
          END ||
          CASE WHEN trim(COALESCE(ccp.country, '')) <> '' THEN char(10) || ccp.country ELSE '' END
        ), '')
      ) as billing_address,
      cp.account_number,
      cp.quickbooks_vendor_id,
      cp.quickbooks_display_name,
      cp.quickbooks_company_name,
      cp.quickbooks_print_on_check_name,
      cp.quickbooks_primary_email,
      cp.quickbooks_primary_phone,
      cp.quickbooks_bill_addr,
      cp.quickbooks_account_number,
      cp.quickbooks_vendor_1099,
      cp.quickbooks_tax_identifier_last4,
      cp.quickbooks_balance,
      cp.quickbooks_active,
      cp.quickbooks_synced_at,
      cp.contractor_status,
      cp.contractor_category,
      cp.contractor_secondary_category,
      cp.contractor_categories_json,
      cp.is_supplier,
      cp.supplier_marked_at,
      cp.supplier_marked_by,
      cp.linked_user_id,
      cp.source,
      cp.created_at,
      cp.updated_at,
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
       WHERE cn.contractor_id = cp.id) as latest_note_at,
      (SELECT cor.status
       FROM contractor_onboarding_requests cor
       WHERE cor.contractor_id = cp.id
       ORDER BY datetime(cor.created_at) DESC, cor.created_at DESC
       LIMIT 1) as onboarding_status,
      (SELECT cor.last_sent_at
       FROM contractor_onboarding_requests cor
       WHERE cor.contractor_id = cp.id
       ORDER BY datetime(cor.created_at) DESC, cor.created_at DESC
       LIMIT 1) as onboarding_last_sent_at,
      (SELECT cor.expires_at
       FROM contractor_onboarding_requests cor
       WHERE cor.contractor_id = cp.id
       ORDER BY datetime(cor.created_at) DESC, cor.created_at DESC
       LIMIT 1) as onboarding_expires_at,
      COALESCE(
        (SELECT cor.submitted_at
         FROM contractor_onboarding_requests cor
         WHERE cor.contractor_id = cp.id AND cor.submitted_at IS NOT NULL
         ORDER BY datetime(cor.submitted_at) DESC, cor.submitted_at DESC
         LIMIT 1),
        (SELECT ccp.submitted_at
         FROM contractor_compliance_profiles ccp
         WHERE ccp.contractor_id = cp.id
         LIMIT 1)
      ) as onboarding_submitted_at,
      (SELECT ccp.tax_id_last4
       FROM contractor_compliance_profiles ccp
       WHERE ccp.contractor_id = cp.id
       LIMIT 1) as tax_id_last4,
      (SELECT ccp.bank_account_last4
       FROM contractor_compliance_profiles ccp
       WHERE ccp.contractor_id = cp.id
       LIMIT 1) as bank_account_last4,
      (SELECT ccp.routing_last4
       FROM contractor_compliance_profiles ccp
       WHERE ccp.contractor_id = cp.id
       LIMIT 1) as routing_last4,
      (SELECT ccp.bank_name
       FROM contractor_compliance_profiles ccp
       WHERE ccp.contractor_id = cp.id
       LIMIT 1) as bank_name
    FROM contractor_profiles cp
    LEFT JOIN users u ON u.id = cp.linked_user_id
    LEFT JOIN contractor_compliance_profiles ccp ON ccp.contractor_id = cp.id
    WHERE COALESCE(u.is_active, 1) = 1
    ORDER BY datetime(cp.created_at) DESC, cp.vendor_name
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

  const contractorIds = contractors.map(contractor => contractor.id);
  const notesByContractor = new Map();
  if (contractorIds.length > 0) {
    const placeholders = contractorIds.map(() => '?').join(',');
    const noteRows = db.prepare(`
      SELECT id, contractor_id, note, created_at, user_name, user_avatar_url
      FROM (
        SELECT
          cn.id,
          cn.contractor_id,
          cn.note,
          cn.created_at,
          u.name as user_name,
          u.avatar_url as user_avatar_url,
          ROW_NUMBER() OVER (
            PARTITION BY cn.contractor_id
            ORDER BY datetime(cn.created_at) DESC, cn.created_at DESC
          ) as rn
        FROM contractor_profile_notes cn
        JOIN users u ON u.id = cn.user_id
        WHERE cn.contractor_id IN (${placeholders})
      )
      WHERE rn <= 2
      ORDER BY contractor_id, datetime(created_at) DESC, created_at DESC
    `).all(...contractorIds);
    for (const row of noteRows) {
      const notes = notesByContractor.get(row.contractor_id) || [];
      notes.push({ id: row.id, note: row.note, created_at: row.created_at, user_name: row.user_name, user_avatar_url: row.user_avatar_url });
      notesByContractor.set(row.contractor_id, notes);
    }
  }

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
    const contractorCategories = parseStoredContractorCategories(contractor);
    const quickBooksVendor = contractor.quickbooks_vendor_id ? {
      id: contractor.quickbooks_vendor_id,
      display_name: contractor.quickbooks_display_name,
      company_name: contractor.quickbooks_company_name,
      print_on_check_name: contractor.quickbooks_print_on_check_name,
      primary_email: contractor.quickbooks_primary_email,
      primary_phone: contractor.quickbooks_primary_phone,
      billing_address: contractor.quickbooks_bill_addr,
      account_number: contractor.quickbooks_account_number,
      vendor_1099: Boolean(Number(contractor.quickbooks_vendor_1099 || 0)),
      tax_identifier_last4: contractor.quickbooks_tax_identifier_last4,
      balance: Number(contractor.quickbooks_balance || 0),
      active: contractor.quickbooks_active === null || contractor.quickbooks_active === undefined
        ? true
        : Boolean(Number(contractor.quickbooks_active)),
      synced_at: contractor.quickbooks_synced_at,
    } : null;

    return {
      ...contractor,
      name: contractor.vendor_name,
      company: contractor.quickbooks_company_name || contractor.vendor_name,
      quickbooks_vendor: quickBooksVendor,
      contractor_categories: contractorCategories,
      connected_projects: connectedProjects,
      project_addresses: projectAddresses,
      connected_project_count: projectAddresses.length,
      last_paid_invoice: paid,
      last_invoice: invoice,
      total_paid: Number(contractor.total_paid || 0),
      latest_notes: notesByContractor.get(contractor.id) || [],
    };
  });

  logDataAccess(req, {
    action: 'contractor_directory_viewed',
    accessType: 'view',
    entityType: 'contractor_profile',
    recordCount: result.length,
    riskLevel: 'high',
  });

  res.json({ categories: getContractorCategories(db), contractors: result });
});

// GET /api/users/contractors/:id/1099 - explicitly reveal full encrypted 1099/ACH details
router.get('/contractors/:id/1099', authorize('super_admin', 'operations_manager'), (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      ccp.*,
      cp.vendor_name,
      cp.contact_name,
      cp.email as profile_email,
      cp.phone as profile_phone
    FROM contractor_compliance_profiles ccp
    JOIN contractor_profiles cp ON cp.id = ccp.contractor_id
    WHERE ccp.contractor_id = ?
    LIMIT 1
  `).get(req.params.id);

  if (!row) {
    return res.status(404).json({ error: '1099 information has not been submitted for this contractor' });
  }

  let payload = {};
  try {
    payload = decryptJson(row.data_encrypted) || {};
  } catch (err) {
    console.error('Unable to decrypt contractor 1099 details:', err?.message || err);
    return res.status(500).json({ error: 'Unable to decrypt contractor 1099 details' });
  }

  const taxIdType = payload.tax_id_type || row.tax_id_type || '';
  const response = {
    contractor_id: row.contractor_id,
    contractor_name: row.vendor_name,
    submitted_at: row.submitted_at,
    updated_at: row.updated_at,
    legal_name: payload.legal_name || row.legal_name,
    business_name: payload.business_name || row.business_name,
    tax_classification: payload.tax_classification || row.tax_classification,
    tax_id_type: taxIdType,
    tax_id: payload.tax_id_formatted || formatTaxIdForDisplay(payload.tax_id, taxIdType),
    mailing_address: complianceMailingAddress(payload, row),
    phone: payload.phone || row.phone || row.profile_phone,
    email: payload.email || row.email || row.profile_email,
    bank_name: payload.bank_name || row.bank_name,
    account_type: payload.account_type || null,
    account_number: payload.account_number || null,
    routing_number: payload.routing_number || null,
    payment_method: row.payment_method || 'ach',
    insurance_provider: payload.insurance_provider || row.insurance_provider,
    insurance_policy_number: payload.insurance_policy_number || row.insurance_policy_number,
    insurance_expires_at: payload.insurance_expires_at || row.insurance_expires_at,
    license_number: payload.license_number || row.license_number,
    license_state: payload.license_state || row.license_state,
    w9_certified: booleanLabel(payload.w9_certified || row.w9_certified),
    ach_authorized: booleanLabel(payload.ach_authorized || row.ach_authorized),
    redacted_summary: {
      tax_id_last4: row.tax_id_last4,
      bank_account_last4: row.bank_account_last4,
      routing_last4: row.routing_last4,
    },
  };

  logActivity({
    userId: req.user.id,
    action: 'contractor_1099_sensitive_viewed',
    entityType: 'contractor_profile',
    entityId: row.contractor_id,
    details: {
      contractor_name: row.vendor_name,
      viewed_fields: ['tax_id', 'account_number', 'routing_number'],
    },
  });

  logDataAccess(req, {
    action: 'contractor_1099_sensitive_viewed',
    accessType: 'sensitive_view',
    entityType: 'contractor_profile',
    entityId: row.contractor_id,
    riskLevel: 'critical',
    details: {
      contractor_name: row.vendor_name,
      viewed_fields: ['tax_id', 'account_number', 'routing_number'],
    },
  });

  res.json(response);
});

function requireContractor(db, contractorId) {
  return db.prepare("SELECT *, vendor_name as name FROM contractor_profiles WHERE id = ?").get(contractorId);
}

// POST /api/users/contractors/profile - add a contractor directory record
router.post('/contractors/profile', authorize('super_admin', 'operations_manager', 'project_manager'), (req, res) => {
  try {
    const db = getDb();
    const {
      vendor_name,
      contact_name,
      email,
      phone,
      billing_address,
      account_number,
      contractor_status,
      contractor_category,
      contractor_secondary_category,
      contractor_categories,
      project_ids,
    } = req.body;

    const nextName = String(vendor_name || '').trim();
    if (!nextName) return res.status(400).json({ error: 'Contractor name is required' });
    const nextEmail = email ? String(email).trim().toLowerCase() : null;
    if (nextEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
      return res.status(400).json({ error: 'Valid contractor email is required' });
    }

    const contractorCategories = validateContractorCategories(db, contractor_categories, contractor_category, contractor_secondary_category);
    const primaryCategory = contractorCategories[0] || null;
    const secondaryCategory = contractorCategories[1] || null;
    const nextStatus = validateContractorStatus(contractor_status);
    const contractorId = uuidv4();
    const rawProjectIds = Array.isArray(project_ids) ? project_ids : [];
    const projectIds = [...new Set(rawProjectIds.map(id => String(id || '').trim()).filter(Boolean))];

    if (projectIds.length > 0) {
      const placeholders = projectIds.map(() => '?').join(',');
      const found = db.prepare(`SELECT id FROM projects WHERE id IN (${placeholders})`).all(...projectIds);
      if (found.length !== projectIds.length) {
        return res.status(400).json({ error: 'One or more selected projects could not be found' });
      }
    }

    const createProfile = db.transaction(() => {
      db.prepare(`
        INSERT INTO contractor_profiles (
          id, vendor_name, contact_name, email, phone, billing_address, account_number,
          contractor_status, contractor_category, contractor_secondary_category, contractor_categories_json, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', datetime('now'), datetime('now'))
      `).run(
        contractorId,
        nextName,
        contact_name ? String(contact_name).trim() : null,
        nextEmail,
        phone ? String(phone).trim() : null,
        billing_address ? String(billing_address).trim() : null,
        account_number ? String(account_number).trim() : null,
        nextStatus,
        primaryCategory,
        secondaryCategory,
        JSON.stringify(contractorCategories)
      );

      const insertLink = db.prepare(`
        INSERT OR IGNORE INTO contractor_project_links (id, contractor_id, project_id, created_by, created_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `);
      for (const projectId of projectIds) {
        insertLink.run(uuidv4(), contractorId, projectId, req.user.id);
      }
      if (nextEmail) {
        ensureContractorMobileAccount(db, contractorId, { email: nextEmail, assignedBy: req.user.id });
      }
    });

    createProfile();

    logActivity({
      userId: req.user.id,
      action: 'contractor_profile_created',
      entityType: 'contractor_profile',
      entityId: contractorId,
      details: { contractor_name: nextName, contractor_status: nextStatus, contractor_categories: contractorCategories, project_count: projectIds.length },
    });

    const contractor = db.prepare('SELECT * FROM contractor_profiles WHERE id = ?').get(contractorId);
    res.status(201).json({ contractor, message: 'Contractor added' });
  } catch (err) {
    if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message });
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A manually added contractor with this name already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to add contractor' });
  }
});

// PUT /api/users/contractors/:id/profile - edit imported/vendor contractor details
router.put('/contractors/:id/profile', authorize('super_admin', 'operations_manager', 'project_manager'), blockProjectManagerMutation, (req, res) => {
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
      contractor_status,
      contractor_category,
      contractor_secondary_category,
      contractor_categories,
    } = req.body;

    const nextName = String(vendor_name || '').trim();
    if (!nextName) return res.status(400).json({ error: 'Contractor name is required' });
    const nextEmail = email ? String(email).trim().toLowerCase() : null;
    if (nextEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
      return res.status(400).json({ error: 'Valid contractor email is required' });
    }
    const contractorCategories = validateContractorCategories(db, contractor_categories, contractor_category, contractor_secondary_category);
    const primaryCategory = contractorCategories[0] || null;
    const secondaryCategory = contractorCategories[1] || null;
    const nextStatus = validateContractorStatus(contractor_status);

    db.prepare(`
      UPDATE contractor_profiles SET
        vendor_name = ?,
        contact_name = ?,
        email = ?,
        phone = ?,
        billing_address = ?,
        account_number = ?,
        contractor_status = ?,
        contractor_category = ?,
        contractor_secondary_category = ?,
        contractor_categories_json = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      nextName,
      contact_name ? String(contact_name).trim() : null,
      nextEmail,
      phone ? String(phone).trim() : null,
      billing_address ? String(billing_address).trim() : null,
      account_number ? String(account_number).trim() : null,
      nextStatus,
      primaryCategory,
      secondaryCategory,
      JSON.stringify(contractorCategories),
      req.params.id
    );

    let updatedProfile = db.prepare('SELECT * FROM contractor_profiles WHERE id = ?').get(req.params.id);
    if (nextEmail) {
      const account = ensureContractorMobileAccount(db, req.params.id, { email: nextEmail, assignedBy: req.user.id });
      updatedProfile = account.contractor || updatedProfile;
    } else if (updatedProfile?.linked_user_id) {
      db.prepare(`
        UPDATE users
        SET contractor_category = ?, contractor_secondary_category = ?, updated_at = datetime('now')
        WHERE id = ? AND role = 'contractor'
      `).run(primaryCategory, secondaryCategory, updatedProfile.linked_user_id);
    }

    logActivity({
      userId: req.user.id,
      action: 'contractor_profile_updated',
      entityType: 'contractor_profile',
      entityId: req.params.id,
      details: { contractor_name: nextName, contractor_status: nextStatus, contractor_categories: contractorCategories },
    });

    const updated = db.prepare('SELECT * FROM contractor_profiles WHERE id = ?').get(req.params.id);
    res.json({ contractor: updated, message: 'Contractor updated' });
  } catch (err) {
    if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to update contractor' });
  }
});

// PUT /api/users/contractors/:id/supplier - temporary supplier transfer checkbox
router.put('/contractors/:id/supplier', authorize('super_admin', 'operations_manager', 'project_manager'), blockProjectManagerMutation, (req, res) => {
  try {
    const db = getDb();
    const contractor = requireContractor(db, req.params.id);
    if (!contractor) return res.status(404).json({ error: 'Contractor not found' });

    const isSupplier = req.body?.is_supplier ? 1 : 0;
    const markedAt = isSupplier ? new Date().toISOString() : null;
    const markedBy = isSupplier ? req.user.id : null;

    db.prepare(`
      UPDATE contractor_profiles
      SET is_supplier = ?,
          supplier_marked_at = ?,
          supplier_marked_by = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(isSupplier, markedAt, markedBy, req.params.id);

    logActivity({
      userId: req.user.id,
      action: isSupplier ? 'contractor_marked_supplier' : 'contractor_unmarked_supplier',
      entityType: 'contractor_profile',
      entityId: req.params.id,
      details: { contractor_name: contractor.name, is_supplier: Boolean(isSupplier) },
    });

    res.json({
      id: req.params.id,
      is_supplier: Boolean(isSupplier),
      supplier_marked_at: markedAt,
      message: isSupplier ? 'Contractor added to suppliers' : 'Contractor removed from suppliers',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update supplier status' });
  }
});

// PUT /api/users/contractors/:id/projects - replace explicit project links for a contractor
router.put('/contractors/:id/projects', authorize('super_admin', 'operations_manager', 'project_manager'), blockProjectManagerMutation, (req, res) => {
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
    const updatedContractor = db.prepare('SELECT linked_user_id FROM contractor_profiles WHERE id = ?').get(req.params.id);
    if (updatedContractor?.linked_user_id) {
      syncContractorProjectAssignments(db, req.params.id, updatedContractor.linked_user_id, req.user.id, { mirror: true });
    }

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

// Cascade-delete one contractor_profiles row and tombstone its QuickBooks vendor
// (if any) so the periodic QBO auto-sync will NOT re-create the profile - this is
// what makes a delete actually stick for QuickBooks-linked vendors. When bulk
// deleting, the caller wraps repeated invocations in a single db.transaction().
function deleteContractorProfileCascade(db, contractor, userId) {
  db.prepare('DELETE FROM contractor_onboarding_requests WHERE contractor_id = ?').run(contractor.id);
  db.prepare('DELETE FROM contractor_compliance_profiles WHERE contractor_id = ?').run(contractor.id);
  db.prepare('DELETE FROM contractor_project_links WHERE contractor_id = ?').run(contractor.id);
  db.prepare('DELETE FROM contractor_profile_notes WHERE contractor_id = ?').run(contractor.id);
  db.prepare('DELETE FROM contractor_profiles WHERE id = ?').run(contractor.id);

  if (contractor.quickbooks_vendor_id) {
    db.prepare(`
      INSERT INTO quickbooks_vendor_suppressions (qbo_id, vendor_name, suppressed_by)
      VALUES (?, ?, ?)
      ON CONFLICT(qbo_id) DO UPDATE SET
        vendor_name = excluded.vendor_name,
        suppressed_by = excluded.suppressed_by,
        suppressed_at = datetime('now')
    `).run(String(contractor.quickbooks_vendor_id), contractor.vendor_name || null, userId || null);
  }

  if (contractor.linked_user_id) {
    db.prepare(`
      UPDATE users
      SET is_active = 0, updated_at = datetime('now')
      WHERE id = ? AND role = 'contractor'
    `).run(contractor.linked_user_id);
  }
}

// DELETE /api/users/contractors/:id/profile - remove a contractor directory record
router.delete('/contractors/:id/profile', authorize('super_admin', 'operations_manager'), (req, res) => {
  try {
    const db = getDb();
    const contractor = db.prepare('SELECT * FROM contractor_profiles WHERE id = ?').get(req.params.id);
    if (!contractor) return res.status(404).json({ error: 'Contractor not found' });

    const removeContractor = db.transaction(() => {
      deleteContractorProfileCascade(db, contractor, req.user.id);
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

// POST /api/users/contractors/bulk-delete - remove many directory records at once
// Accepts { ids: [...] }. Runs the same cascade + QuickBooks suppression per row
// inside a single transaction, so partial failures roll back cleanly.
router.post('/contractors/bulk-delete', authorize('super_admin', 'operations_manager'), (req, res) => {
  try {
    const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = [...new Set(rawIds.map((id) => String(id || '').trim()).filter(Boolean))];
    if (ids.length === 0) return res.status(400).json({ error: 'No records selected' });
    if (ids.length > 1000) return res.status(400).json({ error: 'Too many records selected (max 1000 at a time)' });

    const db = getDb();
    const selectStmt = db.prepare('SELECT * FROM contractor_profiles WHERE id = ?');
    const deleted = [];
    const missing = [];

    const removeMany = db.transaction(() => {
      for (const id of ids) {
        const contractor = selectStmt.get(id);
        if (!contractor) { missing.push(id); continue; }
        deleteContractorProfileCascade(db, contractor, req.user.id);
        deleted.push({ id, name: contractor.vendor_name || null });
      }
    });
    removeMany();

    logActivity({
      userId: req.user.id,
      action: 'contractors_bulk_deleted',
      entityType: 'contractor_profile',
      details: {
        requested: ids.length,
        deleted_count: deleted.length,
        missing_count: missing.length,
        deleted_ids: deleted.map((d) => d.id),
        deleted_names: deleted.map((d) => d.name),
      },
    });

    res.json({
      message: `Deleted ${deleted.length} record${deleted.length === 1 ? '' : 's'}`,
      deleted_ids: deleted.map((d) => d.id),
      deleted_count: deleted.length,
      missing_ids: missing,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete records' });
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

  logDataAccess(req, {
    action: 'contractor_notes_viewed',
    accessType: 'view',
    entityType: 'contractor_profile_note',
    entityId: req.params.id,
    recordCount: notes.length,
    riskLevel: 'high',
    details: { contractor_name: contractor.name },
  });

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
router.delete('/contractors/:id/notes/:noteId', authorize('super_admin', 'operations_manager'), (req, res) => {
  const db = getDb();
  const note = db.prepare('SELECT * FROM contractor_profile_notes WHERE id = ? AND contractor_id = ?').get(req.params.noteId, req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });

  const canDelete = note.user_id === req.user.id || ['super_admin', 'operations_manager'].includes(req.user.role);
  if (!canDelete) return res.status(403).json({ error: 'Cannot delete this note' });

  db.prepare('DELETE FROM contractor_profile_notes WHERE id = ?').run(req.params.noteId);
  logActivity({
    userId: req.user.id,
    action: 'contractor_note_deleted',
    entityType: 'contractor_note',
    entityId: req.params.noteId,
    details: { contractor_id: req.params.id },
  });
  res.json({ message: 'Note deleted' });
});

// POST /api/users - create user (super_admin or operations_manager)
router.post('/', authorize('super_admin', 'operations_manager'), async (req, res) => {
  try {
    const { name, email, role, phone, company, contractor_category, contractor_secondary_category } = req.body;
    if (!name || !email || !role) return res.status(400).json({ error: 'Name, email, and role are required' });
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });

    // Operations Manager cannot create Super Admin accounts
    if (req.user.role === 'operations_manager' && role === 'super_admin') {
      return res.status(403).json({ error: 'Operations Manager cannot create Super Admin accounts' });
    }

    const db = getDb();
    const primaryCategory = role === 'contractor' ? validateCategory(db, contractor_category, 'contractor category') : null;
    const secondaryCategory = role === 'contractor' ? validateCategory(db, contractor_secondary_category, 'secondary contractor category') : null;
    const normalizedEmail = normalizeEmailAddress(email);
    const existing = db.prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL').get(normalizedEmail);
    if (existing) return res.status(409).json({ error: 'Email already in use' });

    const initialSecret = `${crypto.randomBytes(24).toString('base64url')}A1!`;
    const hash = await bcrypt.hash(initialSecret, 12);
    const id = uuidv4();

    const pin = generatePin(db);

    db.prepare(
      `INSERT INTO users (id, name, email, password_hash, role, phone, company, contractor_category, contractor_secondary_category, force_password_reset, pin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(id, name, normalizedEmail, hash, role, phone || null, company || null, primaryCategory, secondaryCategory, pin);

    if (role === 'contractor') {
      db.prepare(`
        INSERT OR IGNORE INTO contractor_profiles (
          id, vendor_name, contact_name, email, phone, contractor_category, contractor_secondary_category, linked_user_id, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user', datetime('now'), datetime('now'))
      `).run(id, company || name, name, normalizedEmail, phone || null, primaryCategory, secondaryCategory, id);
    }

    const setup = createPasswordSetupToken(db, id);

    logActivity({ userId: req.user.id, action: 'user_created', entityType: 'user', entityId: id, details: { name, email: normalizedEmail, role, contractor_category: primaryCategory, contractor_secondary_category: secondaryCategory } });

    // Send invite email
    try {
      await sendInviteEmail({ name, email: normalizedEmail, setupUrl: setup.setupUrl, role, invitedBy: req.user.name, pin });
    } catch (emailErr) {
      console.error('Failed to send invite email:', emailErr);
    }

    res.status(201).json({ id, name, email: normalizedEmail, role, pin, message: `User created. Personal PIN: ${pin}. Welcome email sent to ${normalizedEmail}.` });
  } catch (err) {
    if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message });
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
    if (target.deleted_at) return res.status(404).json({ error: 'User not found' });

    if (!canManageTargetUser(req.user, target)) {
      return res.status(403).json({ error: `You cannot modify a ${target.role.replace('_', ' ')} account` });
    }

    const { name, email, role, phone, company, contractor_category, contractor_secondary_category, is_active } = req.body;
    const nextRole = role || target.role;
    if (!VALID_ROLES.includes(nextRole)) return res.status(400).json({ error: 'Invalid role' });

    if (req.user.role === 'operations_manager' && ['super_admin', 'operations_manager'].includes(nextRole)) {
      return res.status(403).json({ error: 'Operations Manager cannot assign management owner roles' });
    }
    const normalizedEmail = email !== undefined ? normalizeEmailAddress(email) : target.email;
    if (!normalizedEmail) return res.status(400).json({ error: 'Email is required' });
    const existingEmail = db.prepare('SELECT id FROM users WHERE email = ? AND id != ? AND deleted_at IS NULL').get(normalizedEmail, req.params.id);
    if (existingEmail) return res.status(409).json({ error: 'Email already in use' });

    const primaryCategory = nextRole === 'contractor'
      ? (contractor_category !== undefined ? validateCategory(db, contractor_category, 'contractor category') : target.contractor_category)
      : null;
    const secondaryCategory = nextRole === 'contractor'
      ? (contractor_secondary_category !== undefined ? validateCategory(db, contractor_secondary_category, 'secondary contractor category') : target.contractor_secondary_category)
      : null;

    db.prepare(
      `UPDATE users SET name = ?, email = ?, role = ?, phone = ?, company = ?, contractor_category = ?, contractor_secondary_category = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(
      name || target.name,
      normalizedEmail,
      nextRole,
      phone ?? target.phone,
      company ?? target.company,
      primaryCategory,
      secondaryCategory,
      is_active !== undefined ? (is_active ? 1 : 0) : target.is_active,
      req.params.id
    );

    if (nextRole === 'contractor') {
      db.prepare(`
        INSERT INTO contractor_profiles (
          id, vendor_name, contact_name, email, phone, contractor_category, contractor_secondary_category, linked_user_id, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user', datetime('now'), datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          vendor_name = excluded.vendor_name,
          contact_name = excluded.contact_name,
          email = excluded.email,
          phone = excluded.phone,
          contractor_category = excluded.contractor_category,
          contractor_secondary_category = excluded.contractor_secondary_category,
          linked_user_id = excluded.linked_user_id,
          updated_at = datetime('now')
      `).run(
        req.params.id,
        (company ?? target.company) || name || target.name,
        name || target.name,
        normalizedEmail,
        phone ?? target.phone,
        primaryCategory,
        secondaryCategory,
        req.params.id
      );
    }

    logActivity({ userId: req.user.id, action: 'user_updated', entityType: 'user', entityId: req.params.id, details: { name, email: normalizedEmail, role: nextRole, contractor_category: primaryCategory, contractor_secondary_category: secondaryCategory, is_active } });
    res.json({ message: 'User updated successfully' });
  } catch (err) {
    if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message });
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
    if (target.deleted_at) return res.status(404).json({ error: 'User not found' });

    if (!canManageTargetUser(req.user, target)) {
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
    if (target.deleted_at) return res.status(404).json({ error: 'User not found' });

    if (!canManageTargetUser(req.user, target)) {
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
      const dir = avatarUploadDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (r, file, cb) => {
      cb(null, avatarFileName(targetId, file.originalname));
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
    try {
      const avatarUrl = avatarPublicUrl(req.file.filename);
      const db = getDb();
      const previous = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
      if (!previous || previous.deleted_at) {
        unlinkAvatarFile(avatarUrl);
        return res.status(404).json({ error: 'User not found' });
      }
      if (!canManageTargetUser(req.user, previous)) {
        unlinkAvatarFile(avatarUrl);
        return res.status(403).json({ error: 'Cannot update this user photo' });
      }
      db.prepare(`UPDATE users SET avatar_url = ?, updated_at = datetime('now') WHERE id = ?`).run(avatarUrl, targetId);
      if (previous?.avatar_url && previous.avatar_url !== avatarUrl) unlinkAvatarFile(previous.avatar_url);
      logActivity({ userId: req.user.id, action: 'avatar_updated', entityType: 'user', entityId: targetId });
      res.json({ avatar_url: avatarUrl, message: 'Avatar updated' });
    } catch (uploadErr) {
      console.error(uploadErr);
      res.status(500).json({ error: 'Failed to upload avatar' });
    }
  });
});

// PUT /api/users/:id/pin - update PIN (admin only)
router.put('/:id/pin', authorize('super_admin', 'operations_manager'), (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || !/^\d{5}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 5 digits' });
    const db = getDb();
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!target || target.deleted_at) return res.status(404).json({ error: 'User not found' });
    if (!canManageTargetUser(req.user, target)) return res.status(403).json({ error: 'Cannot update this user PIN' });
    const existing = db.prepare('SELECT id FROM users WHERE pin = ? AND id != ?').get(pin, req.params.id);
    if (existing) return res.status(409).json({ error: 'PIN already in use by another user' });
    db.prepare("UPDATE users SET pin = ?, updated_at = datetime('now') WHERE id = ?").run(pin, req.params.id);
    logActivity({ userId: req.user.id, action: 'pin_updated', entityType: 'user', entityId: req.params.id });
    res.json({ message: 'PIN updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update PIN' });
  }
});

// DELETE /api/users/:id - remove a user from active management while preserving project history.
router.delete('/:id', authorize('super_admin', 'operations_manager'), (req, res) => {
  try {
    const db = getDb();
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.deleted_at) return res.status(404).json({ error: 'User not found' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
    if (!canDeleteTargetUser(req.user, target)) {
      if (isProtectedUser(target)) {
        return res.status(403).json({ error: 'Only Mike Seifert can delete this protected super admin account' });
      }
      return res.status(403).json({ error: `You cannot delete a ${target.role.replace(/_/g, ' ')} account` });
    }

    db.prepare(`
      UPDATE users
      SET is_active = 0,
          session_revoked_at = datetime('now'),
          deleted_at = datetime('now'),
          deleted_by = ?,
          deleted_email = COALESCE(deleted_email, email),
          email = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(req.user.id, deletedEmailForUser(target), req.params.id);
    db.prepare("UPDATE auth_sessions SET revoked_at = datetime('now'), revoke_reason = 'user_deleted', updated_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL").run(req.params.id);
    logActivity({ userId: req.user.id, action: 'user_deleted', entityType: 'user', entityId: req.params.id, details: { name: target.name, email: target.email, role: target.role, deletedBy: req.user.name } });
    res.json({ message: 'User deleted from active BuildTrack access. Historical project and audit records were preserved.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// POST /api/users/:id/reinvite - send a fresh welcome/setup link and PIN.
router.post('/:id/reinvite', authorize('super_admin', 'operations_manager'), async (req, res) => {
  try {
    const db = getDb();
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.deleted_at) return res.status(404).json({ error: 'User not found' });
    if (!canManageTargetUser(req.user, target)) {
      return res.status(403).json({ error: 'Cannot re-invite this account' });
    }
    const pin = ensureUserPin(db, target);
    const setup = createPasswordSetupToken(db, target.id);
    db.prepare("UPDATE users SET is_active = 1, force_password_reset = 1, updated_at = datetime('now') WHERE id = ?").run(target.id);
    await sendInviteEmail({ name: target.name, email: target.email, setupUrl: setup.setupUrl, role: target.role, invitedBy: req.user.name, pin, isReinvite: true });
    logActivity({ userId: req.user.id, action: 'user_reinvited', entityType: 'user', entityId: req.params.id, details: { email: target.email, role: target.role } });
    res.json({ message: `Welcome email re-sent to ${target.email}. Personal PIN: ${pin}.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to re-invite user' });
  }
});

// POST /api/users/:id/reset-password (super_admin or operations_manager)
router.post('/:id/reset-password', authorize('super_admin', 'operations_manager'), async (req, res) => {
  try {
    const db = getDb();
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.deleted_at) return res.status(404).json({ error: 'User not found' });
    if (!canManageTargetUser(req.user, target)) {
      return res.status(403).json({ error: 'Cannot reset password for this account' });
    }
    const setup = createPasswordSetupToken(db, target.id, 60);
    db.prepare(`UPDATE users SET force_password_reset = 1, updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
    await sendPasswordResetEmail({ name: target.name, email: target.email, resetUrl: setup.setupUrl });
    logActivity({ userId: req.user.id, action: 'password_reset_link_sent', entityType: 'user', entityId: req.params.id });
    res.json({ message: `Password setup link sent to ${target.email}.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send password setup link' });
  }
});

module.exports = router;
