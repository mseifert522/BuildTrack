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
const searchRoutes = require('./src/routes/search');
const textMessageRoutes = require('./src/routes/textMessages');
const invoiceEmailIntakeRoutes = require('./src/routes/invoiceEmailIntake');
const { startGmailInvoicePoller } = require('./src/services/gmailInvoicePoller');
const documentRoutes = require('./src/routes/documents');
const contractorOnboardingRoutes = require('./src/routes/contractorOnboarding');
const quoteAnalyticsRoutes = require('./src/routes/quoteAnalytics');
const securityRoutes = require('./src/routes/security');

const app = express();
const PORT = process.env.PORT || 3001;
app.set('trust proxy', true);

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
const bodyLimit = process.env.REQUEST_BODY_LIMIT || process.env.INBOUND_EMAIL_JSON_LIMIT || '25mb';
app.use(express.json({ limit: bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: bodyLimit }));

// Serve uploaded files
app.use('/uploads', express.static(path.resolve(uploadsPath)));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);

// Friendly aliases for API clients. The web app historically keeps contractor
// directory functions under /api/users/contractors/*.
function contractorApiAlias(req, res, next) {
  const queryIndex = req.url.indexOf('?');
  const query = queryIndex >= 0 ? req.url.slice(queryIndex) : '';
  const pathOnly = queryIndex >= 0 ? req.url.slice(0, queryIndex) : req.url;

  if (!pathOnly || pathOnly === '/' || pathOnly === '/list' || pathOnly === '/directory') {
    req.url = `/contractors/directory${query}`;
  } else {
    req.url = `/contractors${req.url}`;
  }
  return userRoutes(req, res, next);
}

app.use('/api/contractor', contractorApiAlias);
app.use('/api/contractors', contractorApiAlias);
app.use('/api/v1/contractor', contractorApiAlias);
app.use('/api/v1/contractors', contractorApiAlias);

app.use('/api/projects', projectRoutes);
app.use('/api/projects/:projectId/punch-list', punchListRoutes);
app.use('/api/projects/:projectId/photos', photoRoutes);
app.use('/api/projects/:projectId/invoices', invoiceRoutes);
app.use('/api/projects/:projectId/notes', notesRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/text-messages', textMessageRoutes);
app.use('/api/inbound/invoices', invoiceEmailIntakeRoutes.publicRouter);
app.use('/api/invoices/email-intake', invoiceEmailIntakeRoutes.authenticatedRouter);
app.use('/api/documents', documentRoutes);
app.use('/api/contractor-onboarding', contractorOnboardingRoutes);
app.use('/api/quote-analytics', quoteAnalyticsRoutes.analyticsRouter);
app.use('/api/security', securityRoutes);
app.use('/api/projects/:projectId/quotes', quoteAnalyticsRoutes.projectQuotesRouter);
app.use('/api/invoice-agent', (_req, res) => {
  res.status(404).json({ error: 'Endpoint removed' });
});

// Consolidated project notes feed for the dashboard.
app.get('/api/notes/recent', authenticate, (req, res) => {
  const { getDb } = require('./src/db/schema');
  const db = getDb();
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;

  const contractorOnly = req.user.role === 'contractor';
  const assignmentJoin = contractorOnly
    ? 'JOIN project_assignments pa ON pa.project_id = n.project_id AND pa.user_id = ?'
    : '';
  const params = contractorOnly ? [req.user.id, limit] : [limit];

  const notes = db.prepare(`
    SELECT
      n.id,
      n.project_id,
      n.user_id,
      n.note,
      n.note_type,
      n.visibility,
      n.edited_at,
      n.edited_by,
      n.edit_count,
      n.created_at,
      u.name as user_name,
      u.role as user_role,
      u.avatar_url as user_avatar_url,
      (
        SELECT ph.id FROM photos ph
        WHERE ph.note_id = n.id
        ORDER BY datetime(COALESCE(ph.taken_at, ph.created_at)) DESC, ph.created_at DESC
        LIMIT 1
      ) as photo_id,
      (
        SELECT ph.filename FROM photos ph
        WHERE ph.note_id = n.id
        ORDER BY datetime(COALESCE(ph.taken_at, ph.created_at)) DESC, ph.created_at DESC
        LIMIT 1
      ) as photo_filename,
      (
        SELECT ph.original_name FROM photos ph
        WHERE ph.note_id = n.id
        ORDER BY datetime(COALESCE(ph.taken_at, ph.created_at)) DESC, ph.created_at DESC
        LIMIT 1
      ) as photo_original_name,
      (
        SELECT ph.caption FROM photos ph
        WHERE ph.note_id = n.id
        ORDER BY datetime(COALESCE(ph.taken_at, ph.created_at)) DESC, ph.created_at DESC
        LIMIT 1
      ) as photo_caption,
      p.address as project_address,
      p.job_name as project_job_name,
      p.status as project_status
    FROM project_notes n
    JOIN users u ON u.id = n.user_id
    JOIN projects p ON p.id = n.project_id
    ${assignmentJoin}
      ${contractorOnly ? "AND (n.user_id = ? OR n.visibility = 'public')" : ''}
    ORDER BY datetime(n.created_at) DESC, n.created_at DESC
    LIMIT ?
  `).all(...(contractorOnly ? [req.user.id, req.user.id, limit] : [limit]));

  res.json(notes);
});

// All invoices endpoint (for admin dashboard)
app.get('/api/invoices', authenticate, (req, res) => {
  const { getDb } = require('./src/db/schema');
  const { authorize } = require('./src/middleware/auth');
  const db = getDb();
  if (!['super_admin', 'operations_manager', 'project_manager', 'admin_assistant'].includes(req.user.role)) {
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
  if (!['super_admin', 'operations_manager', 'project_manager', 'admin_assistant'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const logs = db.prepare(`
    SELECT al.*, u.name as user_name, p.address as project_address, p.job_name as project_job_name
    FROM activity_log al
    JOIN users u ON u.id = al.user_id
    LEFT JOIN projects p ON p.id = al.project_id
    ORDER BY al.created_at DESC LIMIT 50
  `).all();
  res.json(logs);
});

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Unknown API paths should return machine-readable JSON, not the React shell.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found', path: req.originalUrl });
});

// Redirect app.newurbandev.com root to /app
app.get('/', (req, res, next) => {
  if (req.hostname === 'app.newurbandev.com') {
    return res.redirect('/app');
  }
  next();
});

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
      startGmailInvoicePoller();
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
