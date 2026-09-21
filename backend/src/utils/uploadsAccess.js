'use strict';
// Access tokens for /uploads. Nothing in here is accepted by authenticate():
// both keys are DERIVED from JWT_SECRET, so a session JWT is not a valid uploads
// token and an uploads token is not a valid session JWT. Same JWT_SECRET on blue
// and green => same derived keys => a cookie minted by one container is honored
// by the other during a blue-green overlap.
const crypto = require('crypto');
const path = require('path');
const jwt = require('jsonwebtoken');

// Local http:// development only. Production leaves this unset.
const INSECURE_DEV_COOKIE = process.env.UPLOADS_COOKIE_INSECURE === 'true';
// __Host- makes the browser enforce Secure + Path=/ + no Domain attribute, so no
// sibling *.newurbandev.com host (incl. the marketing site) can set/overwrite it.
const UPLOADS_COOKIE_NAME = INSECURE_DEV_COOKIE ? 'bt_files' : '__Host-bt_files';
const UPLOADS_TOKEN_TYPE = 'bt_uploads';
const SIGNED_URL_MAX_TTL_SECONDS = 45 * 24 * 60 * 60;

let derivedKeys = null;
function keys() {
  if (!derivedKeys) {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is not set');
    const derive = label => crypto.createHmac('sha256', secret).update(`buildtrack:${label}:v1`).digest();
    derivedKeys = { cookie: derive('uploads-cookie'), url: derive('uploads-url') };
  }
  return derivedKeys;
}

function cookieOptions() {
  return { httpOnly: true, secure: !INSECURE_DEV_COOKIE, sameSite: 'lax', path: '/' };
}

function readCookieValues(req, name = UPLOADS_COOKIE_NAME) {
  const header = req.headers?.cookie;
  if (!header) return [];
  const values = [];
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try { values.push(decodeURIComponent(value)); } catch (_) { /* malformed: ignore */ }
  }
  return values;
}

function verifyUploadsToken(value) {
  const claims = jwt.verify(value, keys().cookie, { algorithms: ['HS256'] });
  if (claims.typ !== UPLOADS_TOKEN_TYPE || !claims.uid || !claims.siat || !claims.exp) {
    throw new Error('Not an uploads token');
  }
  return claims;
}

// sessionClaims = the decoded, ALREADY-VALIDATED session JWT ({ userId, sid, iat, exp }).
// Re-issues only when missing, for another user/session, or older than the
// bearer (i.e. after /auth/refresh) => roughly one Set-Cookie per 10 minutes.
function ensureUploadsCookie(req, res, sessionClaims) {
  try {
    if (!sessionClaims?.userId || !sessionClaims?.iat || !sessionClaims?.exp) return;
    if (res.headersSent) return;
    // authenticate() can run twice per request (nested routers): issue once per
    // bearer. A NEWER bearer in the same response (/auth/refresh) re-issues, and
    // browsers apply Set-Cookie headers in order, so the newest wins.
    if (res.locals && res.locals.uploadsCookieExp >= sessionClaims.exp) return;
    const expMs = sessionClaims.exp * 1000;
    if (expMs <= Date.now()) return;
    for (const value of readCookieValues(req)) {
      try {
        const c = verifyUploadsToken(value);
        if (c.uid === sessionClaims.userId
          && (c.sid || null) === (sessionClaims.sid || null)
          && c.exp >= sessionClaims.exp) return; // already current
      } catch (_) { /* stale/foreign value: overwrite */ }
    }
    const token = jwt.sign({
      typ: UPLOADS_TOKEN_TYPE,
      uid: sessionClaims.userId,
      sid: sessionClaims.sid || null,
      siat: sessionClaims.iat,     // revocation checks compare THIS to users.session_revoked_at
      exp: sessionClaims.exp,      // never outlives the Bearer it was derived from
    }, keys().cookie, { algorithm: 'HS256' });
    res.cookie(UPLOADS_COOKIE_NAME, token, { ...cookieOptions(), maxAge: expMs - Date.now() });
    if (res.locals) res.locals.uploadsCookieExp = sessionClaims.exp;
  } catch (err) {
    // Never let cookie issuance fail an API request.
    console.warn('[uploads] cookie not issued:', err.message);
  }
}

function ensureUploadsCookieForSessionToken(req, res, sessionToken) {
  try {
    ensureUploadsCookie(req, res, jwt.verify(sessionToken, process.env.JWT_SECRET));
  } catch (_) { /* not a session JWT (or already expired): nothing to do */ }
}

function clearUploadsCookie(res) {
  // Must repeat Secure + Path=/ or the browser ignores a __Host- deletion.
  res.clearCookie(UPLOADS_COOKIE_NAME, cookieOptions());
}

// ---- Signed, expiring links for people WITHOUT a BuildTrack login ----------
// (punch-list emails to vendors, public vendor-quote page). Bound to one file.
function normalizeUploadRelPath(relPath) {
  const raw = String(relPath || '').replace(/\\/g, '/');
  if (raw.includes('\0')) return null;
  const normalized = path.posix.normalize(`/${raw}`).replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized.split('/').includes('..')) return null;
  return normalized;
}

function urlSignature(rel, exp) {
  return crypto.createHmac('sha256', keys().url).update(`${exp}\n${rel}`).digest('base64url');
}

function signedUploadUrl(relPath, { ttlSeconds, baseUrl = '' } = {}) {
  const rel = normalizeUploadRelPath(relPath);
  if (!rel) return null;
  const ttl = Math.max(60, Math.min(Number(ttlSeconds) || 0, SIGNED_URL_MAX_TTL_SECONDS));
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const encodedPath = rel.split('/').map(encodeURIComponent).join('/');
  return `${baseUrl}/uploads/${encodedPath}?exp=${exp}&sig=${urlSignature(rel, exp)}`;
}

function verifySignedUpload(rel, query) {
  const exp = Number.parseInt(String(query?.exp ?? ''), 10);
  const sig = String(query?.sig ?? '');
  if (!rel || !sig || !Number.isFinite(exp) || exp * 1000 <= Date.now()) return false;
  const expected = Buffer.from(urlSignature(rel, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = {
  UPLOADS_COOKIE_NAME,
  readCookieValues,
  verifyUploadsToken,
  ensureUploadsCookie,
  ensureUploadsCookieForSessionToken,
  clearUploadsCookie,
  signedUploadUrl,
  verifySignedUpload,
};
