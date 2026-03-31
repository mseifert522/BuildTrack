const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db;

function getDb() {
  if (!db) {
    const dbPath = process.env.DB_PATH || './data/buildtrack.db';
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initializeSchema() {
  const db = getDb();

  db.exec(`
    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('super_admin','operations_manager','project_manager','contractor')),
      phone TEXT,
      company TEXT,
      avatar_url TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      force_password_reset INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Projects table
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      job_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','in_progress','on_hold','completed','archived')),
      start_date TEXT,
      target_completion TEXT,
      scope_of_work TEXT,
      budget REAL,
      project_stage TEXT,
      office_notes TEXT,
      field_notes TEXT,
      lifecycle_status TEXT DEFAULT 'acquired',
      is_occupied INTEGER DEFAULT 0,
      construction_start_date TEXT,
      acquisition_date TEXT,
      sold_date TEXT,
      occupant_vacate_date TEXT,
      sale_price REAL,
      purchase_price REAL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    -- Project assignments (many-to-many users <-> projects)
    CREATE TABLE IF NOT EXISTS project_assignments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      assigned_by TEXT NOT NULL,
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, user_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_by) REFERENCES users(id)
    );

    -- Punch list items
    CREATE TABLE IF NOT EXISTS punch_list_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','in_progress','waiting_materials','needs_review','completed')),
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
      assigned_to TEXT,
      due_date TEXT,
      notes TEXT,
      sort_order INTEGER DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_to) REFERENCES users(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    -- Punch list comments
    CREATE TABLE IF NOT EXISTS punch_list_comments (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      comment TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (item_id) REFERENCES punch_list_items(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- Photo categories
    CREATE TABLE IF NOT EXISTS photo_categories (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    -- Photos/files
    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      category_id TEXT,
      punch_list_item_id TEXT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      caption TEXT,
      uploaded_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES photo_categories(id) ON DELETE SET NULL,
      FOREIGN KEY (punch_list_item_id) REFERENCES punch_list_items(id) ON DELETE SET NULL,
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    );

    -- Invoices
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      invoice_number TEXT UNIQUE NOT NULL,
      project_id TEXT NOT NULL,
      contractor_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','reviewed','approved','paid')),
      notes TEXT,
      total REAL NOT NULL DEFAULT 0,
      submitted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (contractor_id) REFERENCES users(id)
    );

    -- Invoice line items
    CREATE TABLE IF NOT EXISTS invoice_line_items (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );

    -- Activity / audit log
    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- Notifications
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT DEFAULT 'info',
      is_read INTEGER NOT NULL DEFAULT 0,
      related_entity_type TEXT,
      related_entity_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Project notes
    CREATE TABLE IF NOT EXISTS project_notes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      note TEXT NOT NULL,
      note_type TEXT DEFAULT 'general' CHECK(note_type IN ('general','office','field')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // ── Runtime migrations (safe to run on every startup) ──
  try { db.exec(`ALTER TABLE users ADD COLUMN avatar_url TEXT`); } catch (_) { /* already exists */ }

  return db;
}

module.exports = { getDb, initializeSchema };
