const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./schema');

function seedTempPassword() {
  const value = String(process.env.BUILDTRACK_SEED_TEMP_PASSWORD || '').trim();
  if (value.length < 12) {
    throw new Error('BUILDTRACK_SEED_TEMP_PASSWORD must be set to a temporary password of at least 12 characters before seeding initial users.');
  }
  return value;
}

async function seedDatabase() {
  const db = getDb();

  // Check if already seeded
  const existingUsers = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (existingUsers.count > 0) {
    console.log('Database already seeded, skipping...');
    return;
  }

  console.log('Seeding database with initial users...');

  const tempPassword = seedTempPassword();
  const hash = await bcrypt.hash(tempPassword, 12);

  const users = [
    {
      id: uuidv4(),
      name: 'Mike Seifert',
      email: 'mike@seifertcapital.com',
      password_hash: hash,
      role: 'super_admin',
      force_password_reset: 1,
    },
    {
      id: uuidv4(),
      name: 'Heather Fallon',
      email: 'heather@seifertcapital.com',
      password_hash: hash,
      role: 'operations_manager',
      force_password_reset: 1,
    },
    {
      id: uuidv4(),
      name: 'Admin Assistant',
      email: 'admin@newurbandev.com',
      password_hash: hash,
      role: 'admin_assistant',
      force_password_reset: 1,
    },
    {
      id: uuidv4(),
      name: 'Demo Contractor',
      email: 'contractor@newurbandev.com',
      password_hash: hash,
      role: 'contractor',
      force_password_reset: 1,
    },
  ];

  const insertUser = db.prepare(`
    INSERT INTO users (id, name, email, password_hash, role, force_password_reset)
    VALUES (@id, @name, @email, @password_hash, @role, @force_password_reset)
  `);

  const insertMany = db.transaction((users) => {
    for (const user of users) insertUser.run(user);
  });

  insertMany(users);

  console.log('');
  console.log('=== INITIAL ACCOUNTS CREATED ===');
  console.log('All accounts use the temporary password supplied in BUILDTRACK_SEED_TEMP_PASSWORD.');
  console.log('Users will be prompted to change password on first login.');
  console.log('');
  users.forEach(u => {
    console.log(`  ${u.role.toUpperCase()}: ${u.email}`);
  });
  console.log('================================');
  console.log('');
}

module.exports = { seedDatabase };
