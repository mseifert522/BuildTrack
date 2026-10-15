const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureAccountColorSchemes } = require('../src/db/accountColorMigration');

const db = new Database(':memory:');
try {
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, extra_field TEXT,
      color_scheme TEXT NOT NULL DEFAULT '07' CHECK(color_scheme IN ('01','07','08','02')));
    CREATE TABLE notes (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE audit (user_id TEXT, color_scheme TEXT);
    CREATE INDEX users_extra_field ON users(extra_field);
    CREATE TRIGGER users_color_audit AFTER UPDATE OF color_scheme ON users BEGIN
      INSERT INTO audit VALUES(NEW.id,NEW.color_scheme);
    END;
    CREATE VIEW user_colors AS SELECT id,color_scheme FROM users;
    INSERT INTO users VALUES ('one','one@example.invalid','preserve custom data','02');
    INSERT INTO notes VALUES ('note','one');
  `);
  const before = db.prepare('SELECT rowid,* FROM users').all();
  ensureAccountColorSchemes(db);
  ensureAccountColorSchemes(db);
  assert.deepEqual(db.prepare('SELECT rowid,* FROM users').all(), before);
  assert.equal(db.prepare('SELECT count(*) n FROM notes').get().n, 1);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.pragma('legacy_alter_table', { simple: true }), 0);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='users_extra_field'").get().n, 1);
  db.prepare('UPDATE users SET color_scheme=? WHERE id=?').run('dark-knight', 'one');
  assert.equal(db.prepare('SELECT color_scheme FROM user_colors').get().color_scheme, 'dark-knight');
  assert.equal(db.prepare('SELECT color_scheme FROM audit').get().color_scheme, 'dark-knight');
  assert.throws(() => db.prepare('UPDATE users SET color_scheme=?').run('invalid'), /CHECK constraint/);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');

  const blocked = new Database(':memory:');
  try {
    blocked.pragma('foreign_keys = ON');
    blocked.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, color_scheme TEXT CHECK(color_scheme IN ('01','07','08','02')));
      INSERT INTO users VALUES ('one','07');
      CREATE TABLE users_color_scheme_migration (keep_me TEXT);
      INSERT INTO users_color_scheme_migration VALUES ('existing data');`);
    assert.throws(() => ensureAccountColorSchemes(blocked), /already exists/);
    assert.equal(blocked.prepare('SELECT color_scheme FROM users').get().color_scheme, '07');
    assert.equal(blocked.prepare('SELECT keep_me FROM users_color_scheme_migration').get().keep_me, 'existing data');
    assert.equal(blocked.pragma('foreign_keys', { simple: true }), 1);
  } finally { blocked.close(); }
  console.log('PASS: legacy palette migration, idempotence, row preservation, references, index, trigger, view, constraint and failed-migration rollback');
} finally { db.close(); }
