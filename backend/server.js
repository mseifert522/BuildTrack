require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { initializeSchema } = require('./src/db/schema');
const { seedDatabase } = require('./src/db/seed');
const { authenticate } = require('./src/middleware/auth');

const authRoutes = require('./src/routes/auth');
const userRoutes = require('./src/routes/users');
const projectRoutes = require('./src/routes/projects');
const punchListRoutes = require('./src/routes/punchlist');
const photoRoutes = require('./src/routes/photos');
const invoiceRoutes = require('./src/routes/invoices');
const notesRoutes = require('./src/routes/notes');

const app = express();
const PORT = process.env.PORT || 3001;

// Ensure uploads directory exists
const uploadsPath = process.env.UPLOADS_PATH || './uploads';
if (!fs.existsSync(uploadsPath)) fs.mkdirSync(uploadsPath, { recursive: true });

// Middleware
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:5173',
  'http://localhost:3001',
];
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve uploaded files
app.use('/uploads', express.static(path.resolve(uploadsPath)));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/projects/:projectId/punch-list', punchListRoutes);
app.use('/api/projects/:projectId/photos', photoRoutes);
app.use('/api/projects/:projectId/invoices', invoiceRoutes);
app.use('/api/projects/:projectId/notes', notesRoutes);

// All invoices endpoint (for admin dashboard)
app.get('/api/invoices', authenticate, (req, res) => {
  const { getDb } = require('./src/db/schema');
  const { authorize } = require('./src/middleware/auth');
  const db = getDb();
  if (!['super_admin', 'operations_manager', 'admin_assistant'].includes(req.user.role)) {
    // Contractors see their own
    const invoices = db.prepare(`
      SELECT i.*, u.name as contractor_name, p.address, p.job_name
      FROM invoices i JOIN users u ON u.id = i.contractor_id JOIN projects p ON p.id = i.project_id
      WHERE i.contractor_id = ? ORDER BY i.created_at DESC
    `).all(req.user.id);
    return res.json(invoices);
  }
  const invoices = db.prepare(`
    SELECT i.*, u.name as contractor_name, p.address, p.job_name
    FROM invoices i JOIN users u ON u.id = i.contractor_id JOIN projects p ON p.id = i.project_id
    ORDER BY i.created_at DESC LIMIT 200
  `).all();
  res.json(invoices);
});

// Activity log endpoint
app.get('/api/activity', authenticate, (req, res) => {
  const { getDb } = require('./src/db/schema');
  const db = getDb();
  if (!['super_admin', 'operations_manager', 'admin_assistant'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const logs = db.prepare(`
    SELECT al.*, u.name as user_name
    FROM activity_log al JOIN users u ON u.id = al.user_id
    ORDER BY al.created_at DESC LIMIT 100
  `).all();
  res.json(logs);
});

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Serve React frontend in production
const frontendDist = path.resolve(__dirname, '../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  // SPA fallback — serve index.html for all non-API routes
  app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

// Initialize DB and start server
async function start() {
  try {
    initializeSchema();
    await seedDatabase();
    app.listen(PORT, () => {
      console.log('');
      console.log('╔══════════════════════════════════════════════════╗');
      console.log('║   New Urban Development Field App - Backend       ║');
      console.log('╠══════════════════════════════════════════════════╣');
      console.log(`║   Server running at: http://localhost:${PORT}        ║`);
      console.log('║   Database: SQLite (data/buildtrack.db)            ║');
      console.log('╚══════════════════════════════════════════════════╝');
      console.log('');
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
