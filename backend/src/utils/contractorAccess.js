const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function generatePin(db) {
  let pin;
  let attempts = 0;
  do {
    pin = String(Math.floor(10000 + Math.random() * 90000));
    const existing = db.prepare('SELECT id FROM users WHERE pin = ?').get(pin);
    if (!existing) return pin;
    attempts++;
  } while (attempts < 100);
  throw new Error('Unable to generate unique contractor PIN');
}

function contractorDisplayName(contractor) {
  return contractor?.contact_name || contractor?.vendor_name || contractor?.name || 'Contractor';
}

function randomPasswordHash() {
  const tempPassword = crypto.randomBytes(24).toString('base64url');
  return bcrypt.hashSync(tempPassword, 12);
}

function conflict(message) {
  const err = new Error(message);
  err.statusCode = 409;
  return err;
}

function syncContractorProjectAssignments(db, contractorId, userId, assignedBy, options = {}) {
  if (!contractorId || !userId) return;
  const links = db.prepare('SELECT project_id FROM contractor_project_links WHERE contractor_id = ?').all(contractorId);

  if (options.mirror === true) {
    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    if (user?.role === 'contractor') {
      const projectIds = links.map(link => link.project_id);
      if (projectIds.length) {
        const placeholders = projectIds.map(() => '?').join(',');
        db.prepare(`
          DELETE FROM project_assignments
          WHERE user_id = ? AND project_id NOT IN (${placeholders})
        `).run(userId, ...projectIds);
      } else {
        db.prepare('DELETE FROM project_assignments WHERE user_id = ?').run(userId);
      }
    }
  }

  const insertAssignment = db.prepare(`
    INSERT OR IGNORE INTO project_assignments (id, project_id, user_id, assigned_by)
    VALUES (?, ?, ?, ?)
  `);
  for (const link of links) {
    insertAssignment.run(uuidv4(), link.project_id, userId, assignedBy || userId);
  }
}

function ensureContractorMobileAccount(db, contractorId, options = {}) {
  const contractor = db.prepare('SELECT * FROM contractor_profiles WHERE id = ?').get(contractorId);
  if (!contractor) return { contractor: null, user: null, created: false, pin: null };

  const email = normalizeEmail(options.email || contractor.email);
  if (!email) return { contractor, user: null, created: false, pin: null };

  let user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);
  let created = false;
  let pin = user?.pin || null;
  const name = contractorDisplayName({ ...contractor, contact_name: options.contact_name || contractor.contact_name });
  const phone = options.phone !== undefined ? options.phone : contractor.phone;
  const company = contractor.vendor_name || contractor.company || null;

  if (user && user.role !== 'contractor') {
    throw conflict('That email is already used by a non-contractor BuildTrack account');
  }

  if (!user) {
    const userId = uuidv4();
    pin = generatePin(db);
    db.prepare(`
      INSERT INTO users (
        id, name, email, password_hash, role, phone, company,
        contractor_category, contractor_secondary_category, force_password_reset, pin, is_active
      )
      VALUES (?, ?, ?, ?, 'contractor', ?, ?, ?, ?, 0, ?, 1)
    `).run(
      userId,
      name,
      email,
      randomPasswordHash(),
      phone || null,
      company,
      contractor.contractor_category || null,
      contractor.contractor_secondary_category || null,
      pin
    );
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    created = true;
  } else {
    if (!pin) {
      pin = generatePin(db);
    }
    db.prepare(`
      UPDATE users
      SET name = COALESCE(NULLIF(?, ''), name),
          phone = COALESCE(NULLIF(?, ''), phone),
          company = COALESCE(NULLIF(?, ''), company),
          contractor_category = ?,
          contractor_secondary_category = ?,
          pin = ?,
          is_active = 1,
          updated_at = datetime('now')
      WHERE id = ? AND role = 'contractor'
    `).run(
      name,
      phone || '',
      company || '',
      contractor.contractor_category || null,
      contractor.contractor_secondary_category || null,
      pin,
      user.id
    );
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }

  db.prepare(`
    UPDATE contractor_profiles
    SET email = ?, linked_user_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(email, user.id, contractor.id);

  syncContractorProjectAssignments(db, contractor.id, user.id, options.assignedBy || user.id);

  const updatedContractor = db.prepare('SELECT * FROM contractor_profiles WHERE id = ?').get(contractor.id);
  return { contractor: updatedContractor, user, created, pin: user.pin || pin };
}

function ensureContractorMobileAccountByEmail(db, rawEmail, options = {}) {
  const email = normalizeEmail(rawEmail);
  if (!email) return { contractor: null, user: null, created: false, pin: null };

  const contractor = db.prepare(`
    SELECT *
    FROM contractor_profiles
    WHERE lower(email) = ?
    ORDER BY linked_user_id IS NOT NULL DESC, datetime(updated_at) DESC, datetime(created_at) DESC
    LIMIT 1
  `).get(email);

  if (contractor) {
    return ensureContractorMobileAccount(db, contractor.id, { ...options, email });
  }

  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ? AND role = ? AND is_active = 1').get(email, 'contractor');
  if (user) return { contractor: null, user, created: false, pin: user.pin };

  return { contractor: null, user: null, created: false, pin: null };
}

function ensureSelfSignupContractor(db, payload) {
  const email = normalizeEmail(payload.email);
  if (!email) {
    const err = new Error('Valid email is required');
    err.statusCode = 400;
    throw err;
  }

  const name = String(payload.name || payload.company || '').trim();
  if (!name) {
    const err = new Error('Contractor name is required');
    err.statusCode = 400;
    throw err;
  }

  const phone = String(payload.phone || '').trim() || null;
  const company = String(payload.company || '').trim() || name;

  let contractor = db.prepare(`
    SELECT *
    FROM contractor_profiles
    WHERE lower(email) = ?
    ORDER BY linked_user_id IS NOT NULL DESC, datetime(updated_at) DESC, datetime(created_at) DESC
    LIMIT 1
  `).get(email);

  if (!contractor) {
    const contractorId = uuidv4();
    db.prepare(`
      INSERT INTO contractor_profiles (
        id, vendor_name, contact_name, email, phone, contractor_status, source, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'active', 'self_signup', datetime('now'), datetime('now'))
    `).run(contractorId, company, name, email, phone);
    contractor = db.prepare('SELECT * FROM contractor_profiles WHERE id = ?').get(contractorId);
  } else {
    db.prepare(`
      UPDATE contractor_profiles
      SET vendor_name = COALESCE(NULLIF(vendor_name, ''), ?),
          contact_name = COALESCE(NULLIF(contact_name, ''), ?),
          phone = COALESCE(NULLIF(phone, ''), ?),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(company, name, phone || '', contractor.id);
    contractor = db.prepare('SELECT * FROM contractor_profiles WHERE id = ?').get(contractor.id);
  }

  return ensureContractorMobileAccount(db, contractor.id, {
    email,
    contact_name: name,
    phone,
    assignedBy: undefined,
  });
}

module.exports = {
  ensureContractorMobileAccount,
  ensureContractorMobileAccountByEmail,
  ensureSelfSignupContractor,
  generatePin,
  normalizeEmail,
  syncContractorProjectAssignments,
};
