'use strict';

const { COLOR_SCHEMES } = require('../services/accountPreferences');

// Expand the existing CHECK constraint using SQLite's transactional table-rebuild
// procedure. Preserve every column, rowid, index, trigger, and reference instead
// of maintaining a second preference store or editing sqlite_schema directly.
// https://www.sqlite.org/lang_altertable.html#making_other_kinds_of_table_schema_changes
function ensureAccountColorSchemes(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  const check = /CHECK\s*\(\s*color_scheme\s+IN\s*\(([^)]*)\)\s*\)/i;
  const match = row?.sql?.match(check);
  if (!match) throw new Error('Cannot identify account color constraint; migration was not applied');
  if (COLOR_SCHEMES.every(id => match[1].includes("'" + id + "'"))) return;
  const create = row.sql.replace(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:users|"users"|\[users\]|`users`)\s*\(/i,
    'CREATE TABLE users_color_scheme_migration (');
  if (create === row.sql) throw new Error('Cannot identify users table definition; migration was not applied');
  const next = create.replace(check, "CHECK(color_scheme IN (" + COLOR_SCHEMES.map(id => "'" + id + "'").join(',') + '))');
  const quote = name => '"' + name.replace(/"/g, '""') + '"';
  const columns = ['rowid', ...db.pragma('table_xinfo(users)').filter(column => column.hidden === 0).map(column => column.name)].map(quote).join(',');
  const foreignKeys = db.pragma('foreign_keys', { simple: true });
  const legacyAlter = db.pragma('legacy_alter_table', { simple: true });
  try {
    db.pragma('foreign_keys = OFF');
    // Views referencing users remain valid after the swap; do not rewrite them
    // while the original table is temporarily absent inside this transaction.
    db.pragma('legacy_alter_table = ON');
    db.transaction(() => {
      const beforeForeignKeys = JSON.stringify(db.pragma('foreign_key_check'));
      const objects = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='users' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
      db.exec(next); // Fail closed if an unrelated table already has this name.
      db.exec(`INSERT INTO users_color_scheme_migration (${columns}) SELECT ${columns} FROM users`);
      const count = db.prepare('SELECT COUNT(*) n FROM users').get().n;
      if (db.prepare('SELECT COUNT(*) n FROM users_color_scheme_migration').get().n !== count) throw new Error('Account migration row count mismatch');
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_color_scheme_migration RENAME TO users');
      for (const object of objects) db.exec(object.sql);
      if (JSON.stringify(db.pragma('foreign_key_check')) !== beforeForeignKeys) throw new Error('Account migration changed foreign key integrity');
    }).immediate();
  } finally {
    db.pragma(`legacy_alter_table = ${legacyAlter ? 'ON' : 'OFF'}`);
    db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
}

module.exports = { ensureAccountColorSchemes };
