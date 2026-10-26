require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { initializeSchema } = require('./src/db/schema');
const { seedDatabase } = require('./src/db/seed');
const { authenticate, rejectTokenInUrl } = require('./src/middleware/auth');

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
const { startActivityRetentionScheduler } = require('./src/services/activityRetentionScheduler');
const videoNormalization = require('./src/services/videoNormalization');
const { createUploadsGate, isInlineSafeUpload } = require('./src/middleware/uploadsGate');
const documentRoutes = require('./src/routes/documents');
const contractorOnboardingRoutes = require('./src/routes/contractorOnboarding');
const vendorSetupRoutes = require('./src/routes/vendorSetup');
const quoteAnalyticsRoutes = require('./src/routes/quoteAnalytics');
const vendorQuoteRequestRoutes = require('./src/routes/vendorQuoteRequests');
const agentBridgeRoutes = require('./src/routes/agentBridge');
const securityRoutes = require('./src/routes/security');
const quickBooksRoutes = require('./src/routes/quickbooks');
const humanResourcesRoutes = require('./src/routes/humanResources');
const financeTrackerRoutes = require('./src/routes/financeTracker');
const costAnalyzerRoutes = require('./src/routes/costAnalyzer');
const agreementRoutes = require('./src/routes/agreements');
const documentReviewRoutes = require('./src/routes/documentReviews');
const scopeDocumentRoutes = require('./src/routes/scopeDocuments');
const bankDrawRoutes = require('./src/routes/bankDraws');
const featureAccessRoutes = require('./src/routes/featureAccess');
const financeConsolidatedRoutes = require('./src/routes/financeConsolidated');
const documentReviewService = require('./src/services/documentReview');
const invoiceEmailIntake = require('./src/routes/invoiceEmailIntake');
const invoiceInboxAgent = require('./src/services/invoiceInboxAgent');

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
// CORS allowlist: the web + mobile apps are served same-origin (each host
// reverse-proxies to this container), so browser XHR to /api never triggers a
// cross-origin preflight. Reflecting an arbitrary Origin with credentials:true
// is unsafe-by-default, so we bound it to the known BuildTrack hosts.
const allowedOrigins = new Set([
  process.env.FRONTEND_URL || 'http://localhost:5173',
  'http://localhost:3001',
  'https://buildtrack.newurbandev.com',
  'https://mobile.buildtrack.newurbandev.com',
  'https://m.buildtrack.newurbandev.com',
  'https://invoices.newurbandev.com',
  'https://app.newurbandev.com',
  MOBILE_APP_ORIGIN,
  ...String(process.env.EXTRA_CORS_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean),
]);
app.use(cors({
  // Allow same-origin/no-origin (mobile webviews, curl, server-to-server) and
  // any explicitly allowlisted browser origin; reject everything else.
  origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)),
  credentials: true,
}));
const bodyLimit = process.env.REQUEST_BODY_LIMIT || process.env.INBOUND_EMAIL_JSON_LIMIT || '25mb';
// QuickBooks webhooks get the exact bytes, whatever the content type: Intuit's CloudEvents
// notifications are application/cloudevents+json (express.json() would skip them and
// leave an empty body) and the intuit-signature HMAC covers the raw body.
app.use('/api/quickbooks/webhook', express.raw({ type: () => true, limit: '2mb' }));
app.use(express.json({
  limit: bodyLimit,
  verify: (req, _res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith('/api/quickbooks/webhook')) {
      req.rawBody = Buffer.from(buf);
    }
  },
}));
app.use(express.urlencoded({ extended: true, limit: bodyLimit }));

// Serve uploaded files behind a login gate (src/middleware/uploadsGate.js). It accepts
// a signed link, the Max AI API key, a Bearer token, or the httpOnly __Host-bt_files
// cookie; the API itself stays Bearer-only. UPLOADS_AUTH_MODE=report serves every file
// and only logs what WOULD be refused (the rollout soak); any other value enforces.
// In-flight chunked-upload pieces live under uploads/chunk-tmp and are never served
// (the gate also catches the //chunk-tmp, %2Fchunk-tmp and /./chunk-tmp spellings).
app.use('/uploads/chunk-tmp', (req, res) => res.status(404).json({ error: 'Not found' }));
// Vendor setup documents (W-9s, voided checks) are encrypted at rest and only ever
// read through /api/vendor-setup/files/:id, which decrypts and audits each read.
app.use('/uploads/vendor-setup', (req, res) => res.status(404).json({ error: 'Not found' }));
// Executed agreements are only ever read through /api/agreements/:id/file (audited).
app.use('/uploads/agreements', (req, res) => res.status(404).json({ error: 'Not found' }));
// Scope of Work PDFs are only ever read through /api/projects/:id/scope-document (audited).
app.use('/uploads/scope-documents', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use('/uploads', createUploadsGate(uploadsPath), express.static(path.resolve(uploadsPath), {
  index: false,
  setHeaders: (res, filePath) => {
    // Every upload is private: no shared cache (Cloudflare included) may hold a file
    // that now needs a login.
    if (filePath.includes(`${path.sep}avatars${path.sep}`)) {
      res.setHeader('Cache-Control', 'private, no-cache, max-age=0, must-revalidate');
    } else if (filePath.includes(`${path.sep}project-main${path.sep}`)) {
      res.setHeader('Cache-Control', 'private, max-age=2592000, immutable');
    } else {
      res.setHeader('Cache-Control', res.locals.uploadsCacheControl || 'private, no-cache');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    // Only images, video and PDF render inline. Anything else downloads inside a CSP
    // sandbox, so an uploaded .html/.svg can never run as a same-origin page and read
    // the session token out of localStorage.
    if (!isInlineSafeUpload(filePath)) {
      res.setHeader('Content-Disposition', 'attachment');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
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

// Old builds put the session JWT in the live-notes stream URL; see rejectTokenInUrl.
app.get('/api/projects/:projectId/notes/stream', rejectTokenInUrl);
app.use('/api/projects', projectRoutes);
app.use('/api/projects/:projectId/punch-list', punchListRoutes);
app.use('/api/projects/:projectId/photos', photoRoutes);
app.use('/api/projects/:projectId/invoices', invoiceRoutes);
app.use('/api/projects/:projectId/notes', notesRoutes);
app.use('/api/projects/:projectId/scope-document', scopeDocumentRoutes);
app.use('/api/projects/:projectId/bank-draws', bankDrawRoutes);
app.use('/api/feature-access', featureAccessRoutes);
app.use('/api/finance/consolidated', financeConsolidatedRoutes);
app.use('/api/field-work', fieldWorkRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/text-messages', textMessageRoutes);
app.use('/api/inbound/invoices', (_req, res) => {
  res.status(410).json({ error: 'Email invoice intake has been removed. Use mobile app invoices or QuickBooks bills.' });
});
// invoices@ is read by the invoice inbox agent; this is the office review queue.
app.use('/api/invoices/email-intake', invoiceEmailIntake.authenticatedRouter);
app.use('/api/documents', documentRoutes);
app.use('/api/contractor-onboarding', contractorOnboardingRoutes);
app.use('/api/vendor-setup', vendorSetupRoutes);
app.use('/api/vendor-quote-requests', vendorQuoteRequestRoutes);
app.use('/api/agent-bridge', agentBridgeRoutes);
app.use('/api/quote-analytics', quoteAnalyticsRoutes.analyticsRouter);
app.use('/api/security', securityRoutes);
app.use('/api/quickbooks', quickBooksRoutes);
app.use('/api/human-resources', humanResourcesRoutes);
app.use('/api/cost-analyzer', costAnalyzerRoutes);
app.use('/api/agreements', agreementRoutes);
app.use('/api/document-reviews', documentReviewRoutes);
app.use('/api/service/finance-tracker', financeTrackerRoutes);
app.use('/api/projects/:projectId/quotes', quoteAnalyticsRoutes.projectQuotesRouter);
app.use('/api/invoice-agent', (_req, res) => {
  res.status(404).json({ error: 'Endpoint removed' });
});

app.get('/api/notes/stream', rejectTokenInUrl, authenticate, notesRoutes.streamAllNotes);
app.use('/api', require('./src/routes/noteFeeds'));

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

function isHashedBuildAsset(fileName) {
  return /-[A-Za-z0-9_-]{6,}\.(js|mjs|css)$/i.test(fileName)
    || /\.[a-f0-9]{8,}\.(js|mjs|css|woff2?)$/i.test(fileName);
}

function setFrontendStaticHeaders(res, filePath) {
  const normalized = String(filePath || '');
  const baseName = path.basename(normalized);
  if (normalized.endsWith(`${path.sep}index.html`)) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    return;
  }
  if (normalized.includes(`${path.sep}assets${path.sep}`)) {
    if (isHashedBuildAsset(baseName)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
    return;
  }
  if (/\.(svg|png|ico|webp|woff2?)$/i.test(baseName)) {
    res.setHeader('Cache-Control', 'public, max-age=604800, must-revalidate');
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
}

const frontendDist = path.resolve(__dirname, '../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist, {
    setHeaders: setFrontendStaticHeaders,
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
      startActivityRetentionScheduler();
      // The AI reads every agreement and quote document and checks how it is filed.
      documentReviewService.start();
      // Straightens and re-encodes uploaded videos so they play upright everywhere.
      videoNormalization.start();
      // Reads every email to invoices@, adds vendors, files invoices to their project.
      invoiceInboxAgent.start();
      if (typeof quickBooksRoutes.startQuickBooksAutoSync === 'function') {
        quickBooksRoutes.startQuickBooksAutoSync();
      }
      if (typeof quickBooksRoutes.startQuickBooksPaymentQueueScheduler === 'function') {
        quickBooksRoutes.startQuickBooksPaymentQueueScheduler();
      }
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
