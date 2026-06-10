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
const fieldWorkRoutes = require('./src/routes/fieldWork');
const calendarRoutes = require('./src/routes/calendar');
const { startCalendarReminderScheduler } = require('./src/services/calendarReminderScheduler');
const documentRoutes = require('./src/routes/documents');
const contractorOnboardingRoutes = require('./src/routes/contractorOnboarding');
const quoteAnalyticsRoutes = require('./src/routes/quoteAnalytics');
const securityRoutes = require('./src/routes/security');
const quickBooksRoutes = require('./src/routes/quickbooks');

const app = express();
const PORT = process.env.PORT || 3001;
app.set('trust proxy', true);

const MOBILE_APP_HOSTS = new Set(
  (process.env.MOBILE_APP_HOSTS || 'mobile.buildtrack.newurbandev.com,m.buildtrack.newurbandev.com')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean)
);
const MOBILE_APP_ORIGIN = process.env.MOBILE_APP_ORIGIN || 'https://mobile.buildtrack.newurbandev.com';
const REDIRECT_LEGACY_MOBILE_TO_HOST = process.env.REDIRECT_LEGACY_MOBILE_TO_HOST === 'true';

function isMobileAppRequest(req) {
  return MOBILE_APP_HOSTS.has(String(req.hostname || '').toLowerCase());
}

function mobileHostRedirectPath(originalUrl) {
  const [rawPath, suffix = ''] = originalUrl.split(/(?=[?#])/, 2);
  if (rawPath === '/mobile') return `/${suffix}`;
  if (rawPath.startsWith('/mobile/')) return `${rawPath.slice('/mobile'.length)}${suffix}`;
  if (rawPath === '/app' || rawPath === '/app/home') return `/login${suffix}`;
  if (rawPath === '/app/projects') return `/projects${suffix}`;
  if (rawPath.startsWith('/app/project/')) return `${rawPath.replace('/app/project', '/project')}${suffix}`;
  return null;
}

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
app.use(express.json({
  limit: bodyLimit,
  verify: (req, _res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith('/api/quickbooks/webhook')) {
      req.rawBody = Buffer.from(buf);
    }
  },
}));
app.use(express.urlencoded({ extended: true, limit: bodyLimit }));

// Serve uploaded files
app.use('/uploads', express.static(path.resolve(uploadsPath), {
  setHeaders: (res, filePath) => {
    if (filePath.includes(`${path.sep}avatars${path.sep}`)) {
      res.setHeader('Cache-Control', 'private, no-cache, max-age=0, must-revalidate');
    }
  },
}));

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
app.use('/api/field-work', fieldWorkRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/text-messages', textMessageRoutes);
app.use('/api/inbound/invoices', (_req, res) => {
  res.status(410).json({ error: 'Email invoice intake has been removed. Use mobile app invoices or QuickBooks bills.' });
});
app.use('/api/invoices/email-intake', (_req, res) => {
  res.status(410).json({ error: 'Email invoice intake has been removed. Use mobile app invoices or QuickBooks bills.' });
});
app.use('/api/documents', documentRoutes);
app.use('/api/contractor-onboarding', contractorOnboardingRoutes);
app.use('/api/quote-analytics', quoteAnalyticsRoutes.analyticsRouter);
app.use('/api/security', securityRoutes);
app.use('/api/quickbooks', quickBooksRoutes);
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

function parseActivityDetails(details) {
  if (!details) return null;
  try {
    return JSON.parse(details);
  } catch (_) {
    return null;
  }
}

// Dashboard feed: latest human-entered project notes only, newest first.
app.get('/api/dashboard/activity-feed', authenticate, (req, res) => {
  const { getDb } = require('./src/db/schema');
  const { logDataAccess } = require('./src/utils/dataAccessAudit');
  const db = getDb();
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 10), 100) : 25;
  const contractorOnly = req.user.role === 'contractor';

  const noteAssignmentJoin = contractorOnly
    ? 'JOIN project_assignments pa ON pa.project_id = n.project_id AND pa.user_id = ?'
    : '';
  const noteVisibilityWhere = contractorOnly
    ? "(n.user_id = ? OR n.visibility = 'public')"
    : '1 = 1';

  const rows = db.prepare(`
    SELECT
      'note' as feed_type,
      n.id,
      n.project_id,
      n.user_id,
      u.name as user_name,
      u.role as user_role,
      u.avatar_url as user_avatar_url,
      n.created_at,
      p.address as project_address,
      p.job_name as project_job_name,
      p.status as project_status,
      n.note,
      n.note_type,
      n.visibility,
      n.edited_at,
      n.edit_count,
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
      NULL as action,
      NULL as entity_type,
      NULL as entity_id,
      NULL as details
    FROM project_notes n
    JOIN users u ON u.id = n.user_id
    JOIN projects p ON p.id = n.project_id
    ${noteAssignmentJoin}
    WHERE ${noteVisibilityWhere}
    ORDER BY datetime(n.created_at) DESC, n.created_at DESC
    LIMIT ?
  `).all(...(contractorOnly
    ? [req.user.id, req.user.id, limit]
    : [limit]
  ));

  const items = rows.map(row => ({
    ...row,
    details: parseActivityDetails(row.details),
  }));

  logDataAccess(req, {
    action: 'dashboard_activity_feed_viewed',
    accessType: 'view',
    entityType: 'dashboard_activity_feed',
    recordCount: items.length,
    details: { limit, contractor_only: contractorOnly, feed_scope: 'project_notes_only' },
  });

  res.json({ items });
});

// All invoices endpoint (for admin dashboard)
app.get('/api/invoices', authenticate, (req, res) => {
  const { getDb } = require('./src/db/schema');
  const { authorize } = require('./src/middleware/auth');
  const db = getDb();
  if (!['super_admin', 'operations_manager', 'project_manager', 'admin_assistant'].includes(req.user.role)) {
    // Contractors see their own
    const invoices = db.prepare(`
      SELECT
        i.*,
        u.name as contractor_name,
        p.address,
        p.job_name,
        (SELECT COUNT(*) FROM invoice_work_items iwi WHERE iwi.invoice_id = i.id) as linked_work_count,
        CASE
          WHEN (SELECT COUNT(*) FROM invoice_work_items iwi WHERE iwi.invoice_id = i.id) > 0 THEN (
            SELECT COUNT(*)
            FROM invoice_work_items iwi
            JOIN construction_plan_items cpi ON cpi.id = iwi.construction_plan_item_id
            WHERE iwi.invoice_id = i.id
              AND cpi.verification_status != 'approved'
          )
          ELSE (
            SELECT COUNT(*)
            FROM construction_plan_items cpi
            WHERE cpi.project_id = i.project_id
              AND cpi.invoice_status IN ('received','approval_needed')
              AND cpi.verification_status != 'approved'
          )
        END as payment_hold_count
      FROM invoices i JOIN users u ON u.id = i.contractor_id JOIN projects p ON p.id = i.project_id
      WHERE i.contractor_id = ? ORDER BY i.created_at DESC
    `).all(req.user.id);
    return res.json(invoices);
  }
  const invoices = db.prepare(`
    SELECT
      i.*,
      u.name as contractor_name,
      p.address,
      p.job_name,
      (SELECT COUNT(*) FROM invoice_work_items iwi WHERE iwi.invoice_id = i.id) as linked_work_count,
      CASE
        WHEN (SELECT COUNT(*) FROM invoice_work_items iwi WHERE iwi.invoice_id = i.id) > 0 THEN (
          SELECT COUNT(*)
          FROM invoice_work_items iwi
          JOIN construction_plan_items cpi ON cpi.id = iwi.construction_plan_item_id
          WHERE iwi.invoice_id = i.id
            AND cpi.verification_status != 'approved'
        )
        ELSE (
          SELECT COUNT(*)
          FROM construction_plan_items cpi
          WHERE cpi.project_id = i.project_id
            AND cpi.invoice_status IN ('received','approval_needed')
            AND cpi.verification_status != 'approved'
        )
      END as payment_hold_count
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
    SELECT
      al.*,
      u.name as user_name,
      u.avatar_url as user_avatar_url,
      p.address as project_address,
      p.job_name as project_job_name
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

// The dedicated mobile host uses root-level mobile routes. Legacy /mobile and
// /app paths remain supported, but are normalized before the SPA loads.
app.use((req, res, next) => {
  const redirectPath = mobileHostRedirectPath(req.originalUrl);
  if (REDIRECT_LEGACY_MOBILE_TO_HOST && !isMobileAppRequest(req) && redirectPath) {
    return res.redirect(308, `${MOBILE_APP_ORIGIN}${redirectPath}`);
  }
  if (!isMobileAppRequest(req)) return next();
  if (!redirectPath) return next();
  return res.redirect(308, redirectPath);
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
  app.use(express.static(frontendDist, {
    setHeaders: (res, filePath) => {
      const normalized = String(filePath || '');
      if (normalized.endsWith(`${path.sep}index.html`)) {
        res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
        return;
      }
      if (normalized.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        return;
      }
      res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    },
  }));
  app.get('/assets/{*assetPath}', (req, res, next) => {
    const requested = String(req.params?.assetPath || req.path || '');
    if (!/\.(js|mjs)$/.test(requested)) {
      if (/\.css$/.test(requested)) {
        res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
        res.type('text/css').send('');
        return;
      }
      return next();
    }

    res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    res.type('application/javascript').send(`
const key = 'bt_missing_asset_reload_attempted_at';
const now = Date.now();
const last = Number(sessionStorage.getItem(key) || 0);
if (now - last > 30000) {
  sessionStorage.setItem(key, String(now));
  window.location.reload();
}
export default function BuildTrackAssetRefresh() { return null; }
`);
  });
  // SPA fallback — serve index.html for all non-API routes
  app.get('/{*path}', (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
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
      startCalendarReminderScheduler();
      if (typeof quickBooksRoutes.startQuickBooksAutoSync === 'function') {
        quickBooksRoutes.startQuickBooksAutoSync();
      }
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
