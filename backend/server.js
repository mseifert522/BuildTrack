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
const { createUploadsGate, isInlineSafeUpload, MANAGEMENT_ONLY_DIRS } = require('./src/middleware/uploadsGate');
const { createImageVariants } = require('./src/middleware/imageVariants');
const documentRoutes = require('./src/routes/documents');
const contractorOnboardingRoutes = require('./src/routes/contractorOnboarding');
const vendorSetupRoutes = require('./src/routes/vendorSetup');
const quoteAnalyticsRoutes = require('./src/routes/quoteAnalytics');
const vendorQuoteRequestRoutes = require('./src/routes/vendorQuoteRequests');
const agentBridgeRoutes = require('./src/routes/agentBridge');
const securityRoutes = require('./src/routes/security');
const quickBooksRoutes = require('./src/routes/quickbooks');
const humanResourcesRoutes = require('./src/routes/humanResources');
const { publicRouter: timesheetLinkRoutes } = require('./src/routes/hrTimesheets');
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
const invoiceMonitorRoutes = require('./src/routes/invoiceMonitor');
const invoiceMonitor = require('./src/services/invoiceReconciliation');

// libvips defaults to one thread per HOST core, not the container's 1.5-CPU quota, so
// thumbnail renders (2 at a time) and HEIC encodes could throttle the whole container,
// API included. One thread per render; a small operation cache under the 768 MB cap.
try {
  const sharp = require('sharp');
  sharp.concurrency(1);
  sharp.cache({ memory: 32 });
} catch (err) {
  console.warn('sharp is unavailable; image thumbnails will not render:', err.message || err);
}

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
// The timesheet page carries the worker's link token in its URL: never send it on as a
// Referer, and keep the page out of search engines.
app.use('/timesheet', (_req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

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
// The WebP thumbnail/poster cache (src/middleware/imageVariants.js) lives in
// uploads/.variants and is only ever served through ?w= on the original's URL.
app.use('/uploads/.variants', (req, res) => res.status(404).json({ error: 'Not found' }));
// `?w=160|480|1280` on an image answers with a small WebP copy (grids and tiles), and
// `?w=160|480&poster=1` on a video with a WebP poster frame; see
// src/middleware/imageVariants.js. Runs after the gate, so the same rules apply.
// app.locals.uploadVariants.warm() pre-renders them (photos.js after an upload, boot warm-up).
const uploadsRoot = path.resolve(uploadsPath);
const uploadVariants = createImageVariants(uploadsPath);
app.locals.uploadVariants = uploadVariants;
app.use('/uploads', createUploadsGate(uploadsPath), uploadVariants, express.static(uploadsRoot, {
  index: false,
  setHeaders: (res, filePath) => {
    // Every upload is private: no shared cache (Cloudflare included) may hold a file
    // that now needs a login.
    const segments = path.relative(uploadsRoot, filePath).split(path.sep);
    const top = segments[0];
    if (filePath.includes(`${path.sep}project-main${path.sep}`)) {
      res.setHeader('Cache-Control', 'private, max-age=2592000, immutable');
    } else if (res.locals.uploadsCacheControl) {
      // Signed links (uploadsGate.js) keep their own lifetime.
      res.setHeader('Cache-Control', res.locals.uploadsCacheControl);
    } else if (isInlineSafeUpload(filePath)
      && (top === 'avatars' || (segments.length > 1 && !MANAGEMENT_ONLY_DIRS.has(top)))) {
      // 2026-10-28: photos, videos and PDFs in project folders, and avatars, never change
      // behind a URL (every write gets a new name: batch stamp + sequence, markup_<id>_<time>,
      // avatar-<user>-<time>, -web-r<deg>.mp4), so a day in the browser's private cache
      // saves a gate check and a 304 round trip on every view. Documents, invoices and
      // quote uploads are not proven immutable and stay on no-cache.
      res.setHeader('Cache-Control', 'private, max-age=86400');
    } else if (top === 'avatars') {
      res.setHeader('Cache-Control', 'private, no-cache, max-age=0, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'private, no-cache');
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
// Emailed invoices vs QuickBooks: what matches, what needs a person, and the feed.
app.use('/api/invoices/monitor', invoiceMonitorRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/contractor-onboarding', contractorOnboardingRoutes);
app.use('/api/vendor-setup', vendorSetupRoutes);
app.use('/api/vendor-quote-requests', vendorQuoteRequestRoutes);
app.use('/api/agent-bridge', agentBridgeRoutes);
app.use('/api/quote-analytics', quoteAnalyticsRoutes.analyticsRouter);
app.use('/api/security', securityRoutes);
app.use('/api/quickbooks', quickBooksRoutes);
app.use('/api/human-resources', humanResourcesRoutes);
// A field worker's private timesheet link (no login; the token is the credential).
app.use('/api/timesheet-link', timesheetLinkRoutes);
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

// Renders the thumbnails pages ask for most, in the background, once after boot:
// photos at 480 (video posters at 480) and project main photos at 1280. One file at a
// time at warm priority, only what is missing from uploads/.variants, so after the first
// run a deploy only checks file dates. UPLOAD_VARIANT_WARMUP_ENABLED=false turns it off.
const UPLOAD_VARIANT_WARMUP_DELAY_MS = 90 * 1000;
function startUploadVariantWarmup(variants) {
  if (process.env.UPLOAD_VARIANT_WARMUP_ENABLED === 'false') return;
  if (!variants || typeof variants.warm !== 'function') return;
  const timer = setTimeout(async () => {
    const startedAt = Date.now();
    let checked = 0;
    let rendered = 0;
    try {
      const { getDb } = require('./src/db/schema');
      const db = getDb();
      // .all(), not .iterate(): an open iterator would make this connection busy for
      // every request while the walk awaits renders.
      const mainPhotos = db.prepare(`
        SELECT main_photo_url FROM projects WHERE main_photo_url LIKE '/uploads/project-main/%'
      `).all();
      const photos = db.prepare(`
        SELECT project_id, filename FROM photos
        WHERE filename IS NOT NULL
          AND COALESCE(upload_status, 'uploaded') != 'correction_deleted'
          AND correction_deleted_at IS NULL
        ORDER BY created_at DESC
      `).all();
      for (const row of mainPhotos) {
        checked += 1;
        rendered += await variants.warm(String(row.main_photo_url).split(/[?#]/)[0].slice('/uploads/'.length), [1280]);
      }
      for (const row of photos) {
        checked += 1;
        rendered += await variants.warm(`${row.project_id}/${row.filename}`, [480]);
      }
      console.log(`[uploads] thumbnail warm-up: checked ${checked}, rendered ${rendered} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
    } catch (err) {
      console.warn(`[uploads] thumbnail warm-up stopped after ${checked} files:`, err.message || err);
    }
  }, UPLOAD_VARIANT_WARMUP_DELAY_MS);
  if (timer.unref) timer.unref();
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
      // Checks every emailed invoice against what the office enters in QuickBooks.
      invoiceMonitor.start();
      // Pre-renders missing grid thumbnails and video posters in the background.
      startUploadVariantWarmup(uploadVariants);
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
