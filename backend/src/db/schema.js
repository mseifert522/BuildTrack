const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db;

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
];

const DEFAULT_SUPPLIER_CATEGORIES = [
  'Landscaping Materials',
  'Drywall',
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

function uniqueSupplierCategories(values) {
  const valid = new Map(DEFAULT_SUPPLIER_CATEGORIES.map(category => [category.toLowerCase(), category]));
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const raw = String(value || '').trim().replace(/\s+/g, ' ');
    if (!raw) continue;
    const aliased = SUPPLIER_CATEGORY_ALIASES[raw.toLowerCase()] ?? raw;
    const category = valid.get(String(aliased).toLowerCase()) || aliased;
    if (!category || !valid.has(category.toLowerCase())) continue;
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

function parseSupplierCategoriesForBackfill(row) {
  let stored = [];
  try {
    const parsed = JSON.parse(row.contractor_categories_json || '[]');
    if (Array.isArray(parsed)) stored = parsed;
  } catch (_) {
    stored = [];
  }
  return uniqueSupplierCategories([
    ...stored,
    row.contractor_category,
    row.contractor_secondary_category,
  ]);
}

const QUOTE_CATEGORY_DEFINITIONS = [
  ['General', 'Demolition'],
  ['General', 'Site work'],
  ['General', 'Excavation'],
  ['General', 'Grading'],
  ['General', 'Concrete'],
  ['General', 'Masonry'],
  ['General', 'Structural steel'],
  ['General', 'Framing'],
  ['General', 'Rough carpentry'],
  ['General', 'Finish carpentry'],
  ['Exterior', 'Roofing'],
  ['Exterior', 'Siding'],
  ['Exterior', 'Gutters'],
  ['Exterior', 'Windows'],
  ['Exterior', 'Doors'],
  ['Exterior', 'Exterior paint'],
  ['Exterior', 'Decks'],
  ['Exterior', 'Balconies'],
  ['Exterior', 'Landscaping'],
  ['Exterior', 'Irrigation'],
  ['Exterior', 'Fencing'],
  ['Exterior', 'Asphalt / paving'],
  ['Interior', 'Drywall'],
  ['Interior', 'Insulation'],
  ['Interior', 'Interior paint'],
  ['Interior', 'Flooring'],
  ['Interior', 'Tile'],
  ['Interior', 'Cabinets'],
  ['Interior', 'Countertops'],
  ['Interior', 'Trim'],
  ['Interior', 'Hardware'],
  ['Interior', 'Appliances'],
  ['Interior', 'Fixtures'],
  ['MEP', 'Plumbing'],
  ['MEP', 'Electrical'],
  ['MEP', 'HVAC'],
  ['MEP', 'Fire protection'],
  ['MEP', 'Low voltage'],
  ['MEP', 'Security systems'],
  ['MEP', 'Data/communications'],
  ['Project Operations', 'Permits'],
  ['Project Operations', 'Cleanup'],
  ['Project Operations', 'Hauling'],
  ['Project Operations', 'General labor'],
  ['Project Operations', 'Supervision'],
  ['Project Operations', 'Project management'],
  ['Project Operations', 'Temporary utilities'],
  ['Project Operations', 'Safety compliance'],
  ['Project Operations', 'Miscellaneous'],
];

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function ensureProjectStatusConstraintSupportsCurrentStatuses(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get();
  const requiredStatuses = ["'not_started'", "'active_rehab'", "'rehab_completed'", "'long_term_holding'", "'commercial'", "'archived'"];
  if (!row?.sql || requiredStatuses.every(status => row.sql.includes(status))) return;

  const columns = `
    id, address, job_name, status, start_date, target_completion, scope_of_work, budget,
    project_stage, office_notes, field_notes, lifecycle_status, is_occupied, construction_start_date,
    acquisition_date, sold_date, occupant_vacate_date, sale_price, purchase_price, arv, closing_costs,
    main_photo_url, lockbox_code, created_by, created_at, updated_at
  `;
  const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true });

  try {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS projects_status_migration');
      db.exec(`
        CREATE TABLE projects_status_migration (
          id TEXT PRIMARY KEY,
          address TEXT NOT NULL,
          job_name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','active_rehab','rehab_completed','long_term_holding','commercial','archived')),
          start_date TEXT,
          target_completion TEXT,
          scope_of_work TEXT,
          budget REAL,
          project_stage TEXT,
          office_notes TEXT,
          field_notes TEXT,
          lifecycle_status TEXT DEFAULT 'pre_construction',
          is_occupied INTEGER DEFAULT 0,
          construction_start_date TEXT,
          acquisition_date TEXT,
          sold_date TEXT,
          occupant_vacate_date TEXT,
          sale_price REAL,
          purchase_price REAL,
          arv REAL,
          closing_costs REAL,
          main_photo_url TEXT,
          lockbox_code TEXT,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (created_by) REFERENCES users(id)
        )
      `);
      db.exec(`
        INSERT INTO projects_status_migration (${columns})
        SELECT
          id, address, job_name,
          CASE
            WHEN status IN ('not_started','active_rehab','rehab_completed','long_term_holding','commercial','archived') THEN status
            WHEN status IN ('completed','closed_sold') THEN 'rehab_completed'
            ELSE 'active_rehab'
          END,
          start_date, target_completion, scope_of_work, budget,
          project_stage, office_notes, field_notes, lifecycle_status, is_occupied, construction_start_date,
          acquisition_date, sold_date, occupant_vacate_date, sale_price, purchase_price, arv, closing_costs,
          main_photo_url, lockbox_code, created_by, created_at, updated_at
        FROM projects
      `);
      db.exec('DROP TABLE projects');
      db.exec('ALTER TABLE projects_status_migration RENAME TO projects');
    })();
    console.log('[MIGRATION] Updated projects status constraint to include current status buckets');
  } finally {
    db.pragma(`foreign_keys = ${foreignKeysEnabled ? 'ON' : 'OFF'}`);
  }
}

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
      contractor_category TEXT,
      contractor_secondary_category TEXT,
      avatar_url TEXT,
      last_login_at TEXT,
      last_seen_at TEXT,
      session_revoked_at TEXT,
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
      status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','active_rehab','rehab_completed','long_term_holding','commercial','archived')),
      start_date TEXT,
      target_completion TEXT,
      scope_of_work TEXT,
      budget REAL,
      project_stage TEXT,
      office_notes TEXT,
      field_notes TEXT,
      lifecycle_status TEXT DEFAULT 'pre_construction',
      is_occupied INTEGER DEFAULT 0,
      construction_start_date TEXT,
      acquisition_date TEXT,
      sold_date TEXT,
      occupant_vacate_date TEXT,
      sale_price REAL,
      purchase_price REAL,
      main_photo_url TEXT,
      lockbox_code TEXT,
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

    -- Ordered construction plan items for project rehabilitation
    CREATE TABLE IF NOT EXISTS construction_plan_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL DEFAULT 'General',
      status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','in_progress','waiting_materials','needs_review','completed')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      assigned_to TEXT,
      start_date TEXT,
      target_date TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_to) REFERENCES users(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_construction_plan_project_order
      ON construction_plan_items(project_id, sort_order);

    -- Multiple central scope-of-work sections per project.
    CREATE TABLE IF NOT EXISTS project_scopes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      section_name TEXT NOT NULL DEFAULT 'General',
      scope_title TEXT NOT NULL,
      scope_of_work TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','on_hold','completed')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_project_scopes_project_order
      ON project_scopes(project_id, sort_order);

    -- Supplies and materials tied to project construction plan timing
    CREATE TABLE IF NOT EXISTS construction_materials (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      plan_item_id TEXT,
      material_name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      quantity REAL,
      unit TEXT,
      estimated_cost REAL,
      actual_cost REAL,
      supplier TEXT,
      order_status TEXT NOT NULL DEFAULT 'planned' CHECK(order_status IN ('planned','quote_requested','ordered','waiting','delivered','installed','cancelled')),
      needed_by TEXT,
      expected_delivery TEXT,
      delivered_at TEXT,
      notes TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (plan_item_id) REFERENCES construction_plan_items(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_construction_materials_project_status
      ON construction_materials(project_id, order_status, expected_delivery);

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
      note_id TEXT,
      construction_plan_item_id TEXT,
      material_id TEXT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      caption TEXT,
      photo_type TEXT DEFAULT 'general',
      taken_at TEXT,
      upload_ip_address TEXT,
      upload_user_agent TEXT,
      capture_latitude REAL,
      capture_longitude REAL,
      capture_accuracy REAL,
      capture_recorded_at TEXT,
      capture_source TEXT,
      upload_session_id TEXT,
      batch_id TEXT,
      batch_sequence INTEGER,
      stored_file_name TEXT,
      storage_path TEXT,
      thumbnail_path TEXT,
      captured_at TEXT,
      uploaded_at TEXT,
      timezone TEXT,
      label TEXT,
      batch_note TEXT,
      individual_note TEXT,
      gps_latitude REAL,
      gps_longitude REAL,
      gps_accuracy REAL,
      upload_status TEXT NOT NULL DEFAULT 'uploaded',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      uploaded_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES photo_categories(id) ON DELETE SET NULL,
      FOREIGN KEY (punch_list_item_id) REFERENCES punch_list_items(id) ON DELETE SET NULL,
      FOREIGN KEY (note_id) REFERENCES project_notes(id) ON DELETE SET NULL,
      FOREIGN KEY (construction_plan_item_id) REFERENCES construction_plan_items(id) ON DELETE SET NULL,
      FOREIGN KEY (material_id) REFERENCES construction_materials(id) ON DELETE SET NULL,
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

    -- Emailed invoice intake. These records are intentionally separate from
    -- project-bound invoices until office staff files them to the right job.
    CREATE TABLE IF NOT EXISTS invoice_email_intake (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'webhook',
      provider_message_id TEXT,
      message_hash TEXT UNIQUE NOT NULL,
      from_email TEXT,
      from_name TEXT,
      to_email TEXT,
      cc_email TEXT,
      subject TEXT,
      text_body TEXT,
      html_body TEXT,
      attachment_count INTEGER NOT NULL DEFAULT 0,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','filed','ignored')),
      extracted_vendor TEXT,
      extracted_invoice_number TEXT,
      extracted_amount REAL,
      extracted_invoice_date TEXT,
      extracted_service_address TEXT,
      extracted_summary TEXT,
      matched_project_id TEXT,
      match_confidence REAL,
      agent_status TEXT NOT NULL DEFAULT 'pending' CHECK(agent_status IN ('pending','matched','needs_review','filed','ignored','error')),
      agent_notes TEXT,
      agent_model TEXT,
      agent_result_json TEXT,
      agent_last_run_at TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (matched_project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_invoice_email_intake_status_received
      ON invoice_email_intake(status, received_at);

    CREATE TABLE IF NOT EXISTS invoice_agent_runs (
      id TEXT PRIMARY KEY,
      intake_id TEXT,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT,
      input_summary TEXT,
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (intake_id) REFERENCES invoice_email_intake(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_invoice_agent_runs_intake_created
      ON invoice_agent_runs(intake_id, created_at);

    CREATE TABLE IF NOT EXISTS portal_agent_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      model TEXT,
      score INTEGER,
      scan_summary TEXT,
      findings_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_portal_agent_runs_created
      ON portal_agent_runs(created_at);

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

    -- Auth sessions and security control history
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_type TEXT NOT NULL DEFAULT 'desktop',
      user_agent TEXT,
      ip_address TEXT,
      issued_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT,
      revoked_at TEXT,
      revoke_reason TEXT,
      revoked_by TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (revoked_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active
      ON auth_sessions(user_id, revoked_at, last_seen_at);

    CREATE INDEX IF NOT EXISTS idx_auth_sessions_last_seen
      ON auth_sessions(last_seen_at);

    CREATE TABLE IF NOT EXISTS security_events (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL,
      target_user_id TEXT,
      action TEXT NOT NULL,
      reason TEXT,
      ip_address TEXT,
      user_agent TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (actor_user_id) REFERENCES users(id),
      FOREIGN KEY (target_user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_security_events_created
      ON security_events(created_at);

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


    -- Password reset tokens
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 2FA email codes
    CREATE TABLE IF NOT EXISTS two_factor_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Trusted devices (remember browser for 60 days)
    CREATE TABLE IF NOT EXISTS trusted_devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_token TEXT UNIQUE NOT NULL,
      user_agent TEXT,
      ip_address TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Mobile one-touch app access. Stores token hashes only and expires hard after 7 days.
    CREATE TABLE IF NOT EXISTS mobile_quick_access_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      user_agent TEXT,
      ip_address TEXT,
      expires_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_mobile_quick_access_tokens_user_expires
      ON mobile_quick_access_tokens(user_id, expires_at);

    CREATE INDEX IF NOT EXISTS idx_mobile_quick_access_tokens_hash
      ON mobile_quick_access_tokens(token_hash);

    -- Project notes
    CREATE TABLE IF NOT EXISTS project_notes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      note TEXT NOT NULL,
      note_type TEXT DEFAULT 'general' CHECK(note_type IN ('general','office','field')),
      visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','public')),
      edited_at TEXT,
      edited_by TEXT,
      edit_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (edited_by) REFERENCES users(id)
    );

    -- Contractor/vendor directory. These records are not necessarily login users.
    CREATE TABLE IF NOT EXISTS contractor_profiles (
      id TEXT PRIMARY KEY,
      vendor_name TEXT NOT NULL,
      contact_name TEXT,
      email TEXT,
      phone TEXT,
      billing_address TEXT,
      account_number TEXT,
      contractor_status TEXT NOT NULL DEFAULT 'active' CHECK(contractor_status IN ('active','terminated','will_use_again')),
      contractor_category TEXT,
      contractor_secondary_category TEXT,
      contractor_categories_json TEXT,
      is_supplier INTEGER NOT NULL DEFAULT 0,
      supplier_marked_at TEXT,
      supplier_marked_by TEXT,
      linked_user_id TEXT,
      source TEXT,
      source_row INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (linked_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_contractor_profiles_vendor_source
      ON contractor_profiles(vendor_name, source);

    CREATE INDEX IF NOT EXISTS idx_contractor_profiles_linked_user
      ON contractor_profiles(linked_user_id);

    CREATE TABLE IF NOT EXISTS contractor_onboarding_requests (
      id TEXT PRIMARY KEY,
      contractor_id TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent',
      expires_at TEXT NOT NULL,
      last_sent_at TEXT,
      verified_at TEXT,
      submitted_at TEXT,
      requested_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (contractor_id) REFERENCES contractor_profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (requested_by) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_contractor_onboarding_requests_contractor
      ON contractor_onboarding_requests(contractor_id, status, expires_at);

    CREATE INDEX IF NOT EXISTS idx_contractor_onboarding_requests_token
      ON contractor_onboarding_requests(token_hash);

    CREATE TABLE IF NOT EXISTS contractor_onboarding_codes (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (request_id) REFERENCES contractor_onboarding_requests(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_contractor_onboarding_codes_request
      ON contractor_onboarding_codes(request_id, used, expires_at);

    CREATE TABLE IF NOT EXISTS contractor_onboarding_drafts (
      request_id TEXT PRIMARY KEY,
      contractor_id TEXT NOT NULL,
      data_encrypted TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (request_id) REFERENCES contractor_onboarding_requests(id) ON DELETE CASCADE,
      FOREIGN KEY (contractor_id) REFERENCES contractor_profiles(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_contractor_onboarding_drafts_contractor
      ON contractor_onboarding_drafts(contractor_id, updated_at);

    CREATE TABLE IF NOT EXISTS contractor_compliance_profiles (
      contractor_id TEXT PRIMARY KEY,
      legal_name TEXT NOT NULL,
      business_name TEXT,
      tax_classification TEXT,
      tax_id_type TEXT,
      tax_id_last4 TEXT,
      address_line1 TEXT,
      address_line2 TEXT,
      city TEXT,
      state TEXT,
      postal_code TEXT,
      country TEXT NOT NULL DEFAULT 'US',
      phone TEXT,
      email TEXT,
      bank_name TEXT,
      bank_account_last4 TEXT,
      routing_last4 TEXT,
      payment_method TEXT NOT NULL DEFAULT 'ach',
      insurance_provider TEXT,
      insurance_policy_number TEXT,
      insurance_expires_at TEXT,
      license_number TEXT,
      license_state TEXT,
      w9_certified INTEGER NOT NULL DEFAULT 0,
      ach_authorized INTEGER NOT NULL DEFAULT 0,
      data_encrypted TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (contractor_id) REFERENCES contractor_profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS contractor_categories (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS contractor_profile_notes (
      id TEXT PRIMARY KEY,
      contractor_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (contractor_id) REFERENCES contractor_profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_contractor_profile_notes_contractor_created
      ON contractor_profile_notes(contractor_id, created_at);

    CREATE TABLE IF NOT EXISTS contractor_project_links (
      id TEXT PRIMARY KEY,
      contractor_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(contractor_id, project_id),
      FOREIGN KEY (contractor_id) REFERENCES contractor_profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_contractor_project_links_contractor
      ON contractor_project_links(contractor_id);

    CREATE INDEX IF NOT EXISTS idx_contractor_project_links_project
      ON contractor_project_links(project_id);

    CREATE TABLE IF NOT EXISTS contractor_text_messages (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      contractor_id TEXT NOT NULL,
      contractor_name TEXT NOT NULL,
      contractor_phone TEXT NOT NULL,
      sent_by_user_id TEXT NOT NULL,
      sent_by_name TEXT,
      direction TEXT NOT NULL DEFAULT 'outbound',
      message_body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'provider_not_configured',
      provider TEXT NOT NULL DEFAULT 'tbd',
      provider_message_id TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
      FOREIGN KEY (contractor_id) REFERENCES contractor_profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (sent_by_user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_contractor_text_messages_project_created
      ON contractor_text_messages(project_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_contractor_text_messages_contractor_created
      ON contractor_text_messages(contractor_id, created_at);

    -- Contractor notes, kept separate from project notes
    CREATE TABLE IF NOT EXISTS contractor_notes (
      id TEXT PRIMARY KEY,
      contractor_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (contractor_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_contractor_notes_contractor_created
      ON contractor_notes(contractor_id, created_at);

    -- Per-user project review state for management change summaries
    CREATE TABLE IF NOT EXISTS project_review_state (
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      last_reviewed_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, project_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_project_review_state_user
      ON project_review_state(user_id, last_reviewed_at);

    CREATE INDEX IF NOT EXISTS idx_activity_log_project_created
      ON activity_log(project_id, created_at);

    CREATE TABLE IF NOT EXISTS project_documents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      document_type TEXT,
      uploaded_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_project_documents_project_created
      ON project_documents(project_id, created_at);

    -- Standardized quote categories used for company-wide pricing intelligence.
    CREATE TABLE IF NOT EXISTS quote_categories (
      id TEXT PRIMARY KEY,
      category_group TEXT NOT NULL,
      name TEXT UNIQUE NOT NULL,
      normalized_key TEXT UNIQUE NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Master contractor quote database. Every active property quote is stored here
    -- with project/property snapshots so historical analysis stays stable even if a
    -- property record changes later.
    CREATE TABLE IF NOT EXISTS contractor_quotes (
      id TEXT PRIMARY KEY,
      quote_number TEXT UNIQUE NOT NULL,
      project_id TEXT NOT NULL,
      property_address TEXT NOT NULL,
      project_name TEXT NOT NULL,
      contractor_id TEXT,
      contractor_profile_id TEXT,
      contractor_name TEXT NOT NULL,
      contractor_company TEXT,
      contractor_email TEXT,
      contractor_phone TEXT,
      contractor_address TEXT,
      quote_date TEXT NOT NULL,
      quote_year INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected','paid','completed','historical')),
      scope_description TEXT NOT NULL DEFAULT '',
      notes TEXT,
      total_quote_amount REAL NOT NULL DEFAULT 0,
      labor_cost REAL NOT NULL DEFAULT 0,
      material_cost REAL NOT NULL DEFAULT 0,
      permit_costs REAL NOT NULL DEFAULT 0,
      equipment_costs REAL NOT NULL DEFAULT 0,
      disposal_cleanup_costs REAL NOT NULL DEFAULT 0,
      tax REAL NOT NULL DEFAULT 0,
      insurance REAL NOT NULL DEFAULT 0,
      overhead REAL NOT NULL DEFAULT 0,
      profit_margin REAL,
      contingency REAL NOT NULL DEFAULT 0,
      final_approved_amount REAL,
      source_document_id TEXT,
      source_file_name TEXT,
      source_file_path TEXT,
      source_file_mime_type TEXT,
      source_file_size INTEGER,
      source_file_hash TEXT,
      imported_from TEXT NOT NULL DEFAULT 'manual',
      data_quality_flags TEXT NOT NULL DEFAULT '[]',
      uploaded_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      superseded_by_quote_id TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (contractor_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (contractor_profile_id) REFERENCES contractor_profiles(id) ON DELETE SET NULL,
      FOREIGN KEY (source_document_id) REFERENCES project_documents(id) ON DELETE SET NULL,
      FOREIGN KEY (uploaded_by) REFERENCES users(id),
      FOREIGN KEY (superseded_by_quote_id) REFERENCES contractor_quotes(id) ON DELETE SET NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_contractor_quotes_project_file_hash
      ON contractor_quotes(project_id, source_file_hash)
      WHERE source_file_hash IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_contractor_quotes_year_status
      ON contractor_quotes(quote_year, status);

    CREATE INDEX IF NOT EXISTS idx_contractor_quotes_project_year
      ON contractor_quotes(project_id, quote_year);

    CREATE INDEX IF NOT EXISTS idx_contractor_quotes_contractor_year
      ON contractor_quotes(contractor_name, contractor_company, quote_year);

    CREATE INDEX IF NOT EXISTS idx_contractor_quotes_created
      ON contractor_quotes(created_at);

    CREATE TABLE IF NOT EXISTS quote_line_items (
      id TEXT PRIMARY KEY,
      quote_id TEXT NOT NULL,
      category_id TEXT,
      category_group TEXT NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT,
      description TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 1,
      unit TEXT,
      unit_price REAL NOT NULL DEFAULT 0,
      total_line_item_price REAL NOT NULL DEFAULT 0,
      labor_amount REAL NOT NULL DEFAULT 0,
      material_amount REAL NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (quote_id) REFERENCES contractor_quotes(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES quote_categories(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_quote_line_items_quote
      ON quote_line_items(quote_id, sort_order);

    CREATE INDEX IF NOT EXISTS idx_quote_line_items_category
      ON quote_line_items(category, category_group);

    -- Append-only historical snapshots for quote creation/update events.
    CREATE TABLE IF NOT EXISTS historical_quote_records (
      id TEXT PRIMARY KEY,
      quote_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      quote_year INTEGER NOT NULL,
      action TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (quote_id) REFERENCES contractor_quotes(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (actor_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_historical_quote_records_quote
      ON historical_quote_records(quote_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_historical_quote_records_year
      ON historical_quote_records(quote_year, created_at);

    -- Cached analytics snapshots can be populated by future scheduled jobs.
    CREATE TABLE IF NOT EXISTS quote_trend_snapshots (
      id TEXT PRIMARY KEY,
      snapshot_key TEXT UNIQUE NOT NULL,
      filter_json TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ── Runtime migrations (safe to run on every startup) ──
  try { db.exec(`ALTER TABLE users ADD COLUMN avatar_url TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE users ADD COLUMN last_login_at TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE users ADD COLUMN last_seen_at TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE users ADD COLUMN session_revoked_at TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE auth_sessions ADD COLUMN details TEXT`); } catch (_) { /* already exists */ }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_type TEXT NOT NULL DEFAULT 'desktop',
        user_agent TEXT,
        ip_address TEXT,
        issued_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT,
        revoked_at TEXT,
        revoke_reason TEXT,
        revoked_by TEXT,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (revoked_by) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active
        ON auth_sessions(user_id, revoked_at, last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_last_seen
        ON auth_sessions(last_seen_at);
      CREATE TABLE IF NOT EXISTS security_events (
        id TEXT PRIMARY KEY,
        actor_user_id TEXT NOT NULL,
        target_user_id TEXT,
        action TEXT NOT NULL,
        reason TEXT,
        ip_address TEXT,
        user_agent TEXT,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (actor_user_id) REFERENCES users(id),
        FOREIGN KEY (target_user_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_security_events_created
        ON security_events(created_at);
    `);
  } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE projects ADD COLUMN arv REAL`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE projects ADD COLUMN closing_costs REAL`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE projects ADD COLUMN main_photo_url TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE projects ADD COLUMN lockbox_code TEXT`); } catch (_) { /* already exists */ }
  try { ensureProjectStatusConstraintSupportsCurrentStatuses(db); } catch (err) { console.error('[MIGRATION] Failed to update project status constraint:', err.message); }
  try { db.exec(`ALTER TABLE project_notes ADD COLUMN edited_at TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE project_notes ADD COLUMN edited_by TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE project_notes ADD COLUMN edit_count INTEGER NOT NULL DEFAULT 0`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE project_notes ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`); } catch (_) { /* already exists */ }
  try { db.exec(`UPDATE project_notes SET visibility = 'private' WHERE visibility IS NULL OR visibility NOT IN ('private','public')`); } catch (_) { /* best-effort */ }
  try { db.exec(`ALTER TABLE contractor_quotes ADD COLUMN contractor_address TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN photo_type TEXT DEFAULT 'general'`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN taken_at TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN note_id TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN construction_plan_item_id TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN material_id TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN upload_ip_address TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN upload_user_agent TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN capture_latitude REAL`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN capture_longitude REAL`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN capture_accuracy REAL`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN capture_recorded_at TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN capture_source TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN upload_session_id TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN batch_id TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN batch_sequence INTEGER`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN stored_file_name TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN storage_path TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN thumbnail_path TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN captured_at TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN uploaded_at TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN timezone TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN label TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN batch_note TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN individual_note TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN gps_latitude REAL`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN gps_longitude REAL`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN gps_accuracy REAL`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN upload_status TEXT NOT NULL DEFAULT 'uploaded'`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE photos ADD COLUMN updated_at TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`UPDATE photos SET updated_at = COALESCE(updated_at, created_at, datetime('now')) WHERE updated_at IS NULL`); } catch (_) { /* best-effort */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_photos_project_type_taken ON photos(project_id, photo_type, taken_at, created_at)`); } catch (_) { /* best-effort */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_photos_note_taken ON photos(note_id, taken_at, created_at)`); } catch (_) { /* best-effort */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_photos_project_batch ON photos(project_id, batch_id, batch_sequence)`); } catch (_) { /* best-effort */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_photos_project_label_uploaded ON photos(project_id, label, uploaded_at)`); } catch (_) { /* best-effort */ }
  try { db.exec(`ALTER TABLE users ADD COLUMN pin TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE users ADD COLUMN contractor_category TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE users ADD COLUMN contractor_secondary_category TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE contractor_profiles ADD COLUMN contractor_secondary_category TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE contractor_profiles ADD COLUMN contractor_status TEXT NOT NULL DEFAULT 'active'`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE contractor_profiles ADD COLUMN contractor_categories_json TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE contractor_profiles ADD COLUMN is_supplier INTEGER NOT NULL DEFAULT 0`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE contractor_profiles ADD COLUMN supplier_marked_at TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE contractor_profiles ADD COLUMN supplier_marked_by TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_contractor_profiles_supplier ON contractor_profiles(is_supplier, supplier_marked_at)`); } catch (_) { /* best-effort */ }
  try { db.exec(`UPDATE contractor_profiles SET contractor_status = 'active' WHERE contractor_status IS NULL OR contractor_status NOT IN ('active','terminated','will_use_again')`); } catch (_) { /* best-effort */ }
  try {
    const rows = db.prepare(`
      SELECT id, contractor_category, contractor_secondary_category, contractor_categories_json
      FROM contractor_profiles
    `).all();
    const updateCategories = db.prepare('UPDATE contractor_profiles SET contractor_categories_json = ? WHERE id = ?');
    for (const row of rows) {
      let existing = [];
      try {
        const parsed = JSON.parse(row.contractor_categories_json || '[]');
        if (Array.isArray(parsed)) existing = parsed.map(value => String(value || '').trim()).filter(Boolean);
      } catch (_) {
        existing = [];
      }
      if (existing.length > 0) continue;
      const categories = [row.contractor_category, row.contractor_secondary_category]
        .map(value => String(value || '').trim())
        .filter(Boolean);
      updateCategories.run(JSON.stringify([...new Set(categories)]), row.id);
    }
  } catch (_) { /* category backfill best-effort */ }
  try { db.exec(`ALTER TABLE invoice_email_intake ADD COLUMN extracted_vendor TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE invoice_email_intake ADD COLUMN extracted_invoice_number TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE invoice_email_intake ADD COLUMN extracted_amount REAL`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE invoice_email_intake ADD COLUMN extracted_invoice_date TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE invoice_email_intake ADD COLUMN extracted_service_address TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE invoice_email_intake ADD COLUMN extracted_summary TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE invoice_email_intake ADD COLUMN matched_project_id TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE invoice_email_intake ADD COLUMN match_confidence REAL`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE invoice_email_intake ADD COLUMN agent_status TEXT NOT NULL DEFAULT 'pending'`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE invoice_email_intake ADD COLUMN agent_notes TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE invoice_email_intake ADD COLUMN agent_model TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE invoice_email_intake ADD COLUMN agent_result_json TEXT`); } catch (_) { /* already exists */ }
  try { db.exec(`ALTER TABLE invoice_email_intake ADD COLUMN agent_last_run_at TEXT`); } catch (_) { /* already exists */ }

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_invoice_email_intake_agent_status
        ON invoice_email_intake(agent_status, received_at);

      CREATE TABLE IF NOT EXISTS invoice_agent_runs (
        id TEXT PRIMARY KEY,
        intake_id TEXT,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT,
        input_summary TEXT,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (intake_id) REFERENCES invoice_email_intake(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_invoice_agent_runs_intake_created
        ON invoice_agent_runs(intake_id, created_at);

      CREATE TABLE IF NOT EXISTS portal_agent_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        model TEXT,
        score INTEGER,
        scan_summary TEXT,
        findings_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_portal_agent_runs_created
        ON portal_agent_runs(created_at);
    `);
  } catch (_) { /* agent tables already exist */ }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS contractor_project_links (
        id TEXT PRIMARY KEY,
        contractor_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(contractor_id, project_id),
        FOREIGN KEY (contractor_id) REFERENCES contractor_profiles(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id)
      );

      CREATE INDEX IF NOT EXISTS idx_contractor_project_links_contractor
        ON contractor_project_links(contractor_id);

      CREATE INDEX IF NOT EXISTS idx_contractor_project_links_project
        ON contractor_project_links(project_id);

      CREATE TABLE IF NOT EXISTS contractor_text_messages (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        contractor_id TEXT NOT NULL,
        contractor_name TEXT NOT NULL,
        contractor_phone TEXT NOT NULL,
        sent_by_user_id TEXT NOT NULL,
        sent_by_name TEXT,
        direction TEXT NOT NULL DEFAULT 'outbound',
        message_body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'provider_not_configured',
        provider TEXT NOT NULL DEFAULT 'tbd',
        provider_message_id TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        sent_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
        FOREIGN KEY (contractor_id) REFERENCES contractor_profiles(id) ON DELETE CASCADE,
        FOREIGN KEY (sent_by_user_id) REFERENCES users(id)
      );

      CREATE INDEX IF NOT EXISTS idx_contractor_text_messages_project_created
        ON contractor_text_messages(project_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_contractor_text_messages_contractor_created
        ON contractor_text_messages(contractor_id, created_at);
    `);
  } catch (_) { /* link table already exists */ }

  try {
    db.exec(`
      INSERT OR IGNORE INTO contractor_profiles (
        id, vendor_name, contact_name, email, phone, contractor_category, contractor_secondary_category, linked_user_id, source, created_at, updated_at
      )
      SELECT
        id,
        COALESCE(NULLIF(company, ''), name),
        name,
        email,
        phone,
        contractor_category,
        contractor_secondary_category,
        id,
        'user',
        datetime('now'),
        datetime('now')
      FROM users
      WHERE role = 'contractor'
    `);
  } catch (_) { /* profile backfill best-effort */ }

	  try {
	    const insertCategory = db.prepare(`
	      INSERT OR IGNORE INTO contractor_categories (id, name, created_by, created_at)
      VALUES (?, ?, NULL, datetime('now'))
    `);
    for (const category of [...DEFAULT_CONTRACTOR_CATEGORIES, ...DEFAULT_SUPPLIER_CATEGORIES]) {
      const id = category.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      insertCategory.run(id, category);
    }
    db.exec(`
      INSERT OR IGNORE INTO contractor_categories (id, name, created_by, created_at)
      SELECT lower(replace(replace(contractor_category, ' ', '-'), '/', '-')), contractor_category, NULL, datetime('now')
      FROM users
      WHERE contractor_category IS NOT NULL AND trim(contractor_category) != ''
    `);
    db.exec(`
      INSERT OR IGNORE INTO contractor_categories (id, name, created_by, created_at)
      SELECT lower(replace(replace(contractor_category, ' ', '-'), '/', '-')), contractor_category, NULL, datetime('now')
      FROM contractor_profiles
      WHERE contractor_category IS NOT NULL AND trim(contractor_category) != ''
    `);
	  } catch (_) { /* category bootstrap best-effort */ }

  try {
    const supplierRows = db.prepare(`
      SELECT id, vendor_name, contractor_category, contractor_secondary_category, contractor_categories_json
      FROM contractor_profiles
      WHERE COALESCE(is_supplier, 0) = 1
    `).all();
    const updateSupplierCategories = db.prepare(`
      UPDATE contractor_profiles
      SET contractor_category = ?,
          contractor_secondary_category = ?,
          contractor_categories_json = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `);
    for (const row of supplierRows) {
      const existing = parseSupplierCategoriesForBackfill(row);
      const categories = existing.length ? existing : inferSupplierCategoriesFromName(row.vendor_name);
      if (categories.length === 0) continue;
      const stored = JSON.stringify(categories);
      if (
        row.contractor_category === categories[0]
        && (row.contractor_secondary_category || null) === (categories[1] || null)
        && row.contractor_categories_json === stored
      ) {
        continue;
      }
      updateSupplierCategories.run(categories[0], categories[1] || null, stored, row.id);
    }
  } catch (_) { /* supplier category backfill best-effort */ }

  try {
    const insertQuoteCategory = db.prepare(`
      INSERT OR IGNORE INTO quote_categories (id, category_group, name, normalized_key, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `);
    QUOTE_CATEGORY_DEFINITIONS.forEach(([categoryGroup, name], index) => {
      const normalizedKey = slugify(name);
      insertQuoteCategory.run(normalizedKey, categoryGroup, name, normalizedKey, index + 1);
    });
  } catch (_) { /* quote category bootstrap best-effort */ }

  // Auto-assign PINs to existing users without one
  const usersWithoutPin = db.prepare("SELECT id FROM users WHERE pin IS NULL").all();
  if (usersWithoutPin.length > 0) {
    const existingPins = new Set(db.prepare("SELECT pin FROM users WHERE pin IS NOT NULL").all().map(r => r.pin));
    for (const u of usersWithoutPin) {
      let pin;
      do { pin = String(Math.floor(10000 + Math.random() * 90000)); } while (existingPins.has(pin));
      existingPins.add(pin);
      db.prepare("UPDATE users SET pin = ? WHERE id = ?").run(pin, u.id);
    }
    console.log(`[MIGRATION] Assigned PINs to ${usersWithoutPin.length} existing users`);
  }

  // Migrate old project statuses to new ones
  try {
    db.exec(`UPDATE projects SET status = 'active_rehab' WHERE status IN ('active', 'in_progress', 'on_market', 'on_hold')`);
    db.exec(`UPDATE projects SET status = 'rehab_completed' WHERE status IN ('completed', 'closed_sold')`);
  } catch (_) { /* migration already ran or no matching rows */ }

  try {
    db.exec(`
      UPDATE projects
      SET lifecycle_status = CASE status
        WHEN 'not_started' THEN 'pre_construction'
        WHEN 'active_rehab' THEN 'under_construction'
        WHEN 'rehab_completed' THEN 'completed'
        ELSE 'under_construction'
      END
      WHERE lifecycle_status IS NULL OR lifecycle_status = 'acquired'
    `);
  } catch (_) { /* lifecycle normalization best-effort */ }

  return db;
}

module.exports = { getDb, initializeSchema, QUOTE_CATEGORY_DEFINITIONS };
