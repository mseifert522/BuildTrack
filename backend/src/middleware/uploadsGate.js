'use strict';
// Auth gate for /uploads. Accepts, in order: a signed link (?exp=&sig=) for that
// exact file, the Max AI API key, a Bearer session JWT, or the httpOnly
// __Host-bt_files cookie. The cookie is honored ONLY here and ONLY for GET/HEAD;
// /api keeps requiring the Bearer header, so the cookie adds no CSRF surface.
const path = require('path');
const jwt = require('jsonwebtoken');
const {
  UPLOADS_COOKIE_NAME,
  readCookieValues,
  verifyUploadsToken,
  verifySignedUpload,
} = require('../utils/uploadsAccess');

// Top-level dirs every signed-in user may read (the SPA shows them on any page).
const SHARED_DIRS = new Set(['avatars', 'project-main']);
// Not project-scoped by their first segment; the UI never links them directly
// (it goes through /api download routes), so contractors never need them here.
const MANAGEMENT_ONLY_DIRS = new Set([
  'documents', 'invoices', 'invoice-attachments', 'inbound-invoices',
  'quickbooks-bill-attachments', 'quote-uploads', 'vendor-quote-uploads',
]);
// Rendered inline. Anything else is served as a download inside a CSP sandbox so
// an uploaded .html/.svg can never run as a same-origin page (localStorage token).
const INLINE_SAFE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.jpe', '.jfif', '.pjpeg', '.pjp', '.png', '.gif', '.webp', '.avif',
  '.bmp', '.dib', '.tif', '.tiff', '.heic', '.heif', '.dng',
  '.mp4', '.mov', '.qt', '.m4v', '.webm', '.avi', '.mkv', '.mpeg', '.mpg', '.3gp', '.3g2',
  '.hevc', '.mts', '.m2ts', '.pdf',
]);

function isInlineSafeUpload(filePath) {
  return INLINE_SAFE_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

// Classify by the RESOLVED filesystem target, exactly as express.static/send will
// resolve it (one percent-decode, dot segments, duplicate slashes). String-prefix
// checks are bypassable: /uploads//chunk-tmp/... and /uploads/%2Fchunk-tmp/...
// both reach uploads/chunk-tmp today.
function classifyUploadPath(root, reqPath) {
  let decoded;
  try { decoded = decodeURIComponent(String(reqPath || '')); } catch (_) { return null; }
  if (decoded.includes('\0')) return null;
  const absolute = path.resolve(root, `.${decoded.startsWith('/') ? '' : '/'}${decoded}`);
  if (!absolute.startsWith(root + path.sep)) return null;
  const rel = path.relative(root, absolute).split(path.sep).join('/');
  const [first, ...rest] = rel.split('/');
  if (first === 'chunk-tmp') return { kind: 'blocked', rel };
  if (!rest.length || MANAGEMENT_ONLY_DIRS.has(first)) return { kind: 'management', rel };
  if (SHARED_DIRS.has(first)) return { kind: 'shared', rel };
  return { kind: 'project', projectId: first, rel }; // uploads/<projectId>/...
}

function createUploadsGate(uploadsRoot, deps = {}) {
  const root = path.resolve(uploadsRoot);
  const auth = deps.auth || require('./auth');
  const getDb = deps.getDb || require('../db/schema').getDb;
  const mode = () => (String(process.env.UPLOADS_AUTH_MODE || 'enforce').toLowerCase() === 'report' ? 'report' : 'enforce');

  function principalFor(req) {
    const bearer = auth.extractBearerToken(req);
    // 1) Max AI API key - same check authenticate() runs first.
    try {
      if (auth.authenticateApiKey(req, auth.extractApiKey(req, bearer))) return { via: 'api_key', user: req.user };
    } catch (_) { return null; }
    // 2) Bearer session JWT (scripts, fetch() with a header).
    if (bearer) {
      try {
        const d = jwt.verify(bearer, process.env.JWT_SECRET);
        const p = auth.resolveSessionPrincipal({ userId: d.userId, sid: d.sid, iat: d.iat }, { sessionToken: bearer });
        if (p) return { via: 'bearer', user: p.user };
      } catch (_) { /* fall through to the cookie */ }
    }
    // 3) httpOnly cookie (every <img>/<video>/window.open in the SPA). Not for a
    // credentialed cross-origin fetch(): server.js CORS allows credentials for
    // other *.newurbandev.com origins, and SameSite=Lax still sends the cookie
    // to same-site hosts, so such a page could otherwise READ files with it.
    const secFetchSite = req.get('sec-fetch-site');
    if (req.get('sec-fetch-mode') === 'cors' && secFetchSite && secFetchSite !== 'same-origin') return null;
    for (const value of readCookieValues(req, UPLOADS_COOKIE_NAME)) {
      try {
        const c = verifyUploadsToken(value);
        const p = auth.resolveSessionPrincipal({ userId: c.uid, sid: c.sid, iat: c.siat });
        if (p) return { via: 'cookie', user: p.user };
      } catch (_) { /* expired / tampered / wrong type */ }
    }
    return null;
  }

  // Mirrors authorizeProjectAccess(): only role === 'contractor' is restricted.
  function mayRead(user, target) {
    if (user.role !== 'contractor') return true;
    if (target.kind === 'shared') return true;
    if (target.kind === 'project') {
      return Boolean(getDb().prepare(
        'SELECT 1 FROM project_assignments WHERE project_id = ? AND user_id = ? LIMIT 1'
      ).get(target.projectId, user.id));
    }
    return false;
  }

  function deny(res, status) {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    const body = status === 404 ? 'Not found'
      : status === 401 ? 'Sign in to BuildTrack to view this file.'
        : status === 405 ? 'Method not allowed'
          : 'You do not have access to this file.';
    return res.status(status).type('text/plain').send(body);
  }

  return function uploadsGate(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.set('Allow', 'GET, HEAD');
      return deny(res, 405);
    }
    const target = classifyUploadPath(root, req.path);
    if (!target || target.kind === 'blocked') return deny(res, 404);

    if (req.query.sig !== undefined && verifySignedUpload(target.rel, req.query)) {
      res.locals.uploadsCacheControl = 'private, max-age=3600';
      return next();
    }

    let status = 0;
    try {
      const principal = principalFor(req);
      if (!principal) status = 401;
      else if (!mayRead(principal.user, target)) status = 403;
    } catch (err) {
      console.error('[uploads] gate error:', err.message);
      status = 503;
    }
    if (!status) return next();
    if (mode() === 'report') {
      reportWouldDeny(req, target, status);
      return next();
    }
    return deny(res, status);
  };
}

// ---- report mode: aggregated "would deny" counters, flushed every 5 min -------
const reportCounts = new Map();
function reportWouldDeny(req, target, status) {
  let refererHost = '-';
  try { refererHost = new URL(req.get('referer') || '').host || '-'; } catch (_) { /* none */ }
  const ua = String(req.get('user-agent') || '');
  const uaFamily = /iPhone|iPad|iPod/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android'
    : /bot|crawl|spider|preview|curl|wget|python|node/i.test(ua) ? 'bot/cli' : 'desktop';
  const key = [
    status, target.kind,
    readCookieValues(req).length ? 'had-cookie' : 'no-cookie',
    `ref=${refererHost}`, `dest=${req.get('sec-fetch-dest') || '-'}`, uaFamily,
    path.extname(target.rel).toLowerCase() || '(none)',
  ].join(' ');
  reportCounts.set(key, (reportCounts.get(key) || 0) + 1);
}
const reportFlush = setInterval(() => {
  if (!reportCounts.size) return;
  for (const [key, count] of reportCounts) console.warn(`[uploads-gate] REPORT would-deny x${count}: ${key}`);
  reportCounts.clear();
}, 5 * 60 * 1000);
if (reportFlush.unref) reportFlush.unref();

module.exports = { createUploadsGate, classifyUploadPath, isInlineSafeUpload, _reportCounts: reportCounts };
