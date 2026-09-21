const SESSION_IDLE_TIMEOUT_MINUTES = 120;
const SESSION_IDLE_TIMEOUT_MS = SESSION_IDLE_TIMEOUT_MINUTES * 60 * 1000;
const DESKTOP_SESSION_IDLE_TIMEOUT_MINUTES = SESSION_IDLE_TIMEOUT_MINUTES;
const DESKTOP_SESSION_IDLE_TIMEOUT_MS = SESSION_IDLE_TIMEOUT_MS;
const MOBILE_SESSION_IDLE_TIMEOUT_MINUTES = SESSION_IDLE_TIMEOUT_MINUTES;
const MOBILE_SESSION_IDLE_TIMEOUT_MS = SESSION_IDLE_TIMEOUT_MS;
const SESSION_ARCHIVE_AFTER_DAYS = 14;

function parseSqliteDateTime(value) {
  if (!value) return 0;
  const normalized = String(value).includes('T') ? String(value) : `${String(value).replace(' ', 'T')}Z`;
  const timestamp = new Date(normalized).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isMobileSessionType(sessionType) {
  return String(sessionType || '').toLowerCase() === 'mobile_app';
}

function sessionLastActivityMs(session) {
  return parseSqliteDateTime(session?.last_seen_at) || parseSqliteDateTime(session?.issued_at) || parseSqliteDateTime(session?.created_at);
}

function sessionExpiryPolicy(session, nowMs = Date.now()) {
  if (!session || session.revoked_at) return null;
  const lastActivityMs = sessionLastActivityMs(session);
  if (lastActivityMs > 0 && lastActivityMs + SESSION_IDLE_TIMEOUT_MS <= nowMs) {
    return {
      reason: 'Session expired after 2 hours of inactivity',
      message: 'Session expired after 2 hours of inactivity. Please log in again.',
    };
  }

  return null;
}

function revokeSession(db, sessionId, userId, reason, revokedBy = null) {
  db.prepare(`
    UPDATE auth_sessions
    SET revoked_at = COALESCE(revoked_at, datetime('now')),
        revoke_reason = COALESCE(revoke_reason, ?),
        revoked_by = COALESCE(revoked_by, ?),
        updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `).run(reason, revokedBy, sessionId, userId);
}

// Ends every way back in for one user: existing JWTs and /uploads cookies (any iat at
// or before session_revoked_at is rejected on every container), their auth_sessions
// rows, trusted-device 2FA skips and mobile quick-access tokens. Used by the Security
// page logouts and by the Users lockout.
function revokeUserAccess(db, userId, actorId, reason, revokedAt) {
  db.prepare(`
    UPDATE users
    SET session_revoked_at = ?,
        last_seen_at = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(revokedAt, userId);

  db.prepare(`
    UPDATE auth_sessions
    SET revoked_at = ?,
        revoke_reason = ?,
        revoked_by = ?,
        updated_at = datetime('now')
    WHERE user_id = ? AND revoked_at IS NULL
  `).run(revokedAt, reason, actorId, userId);

  db.prepare('DELETE FROM trusted_devices WHERE user_id = ?').run(userId);
  db.prepare(`
    UPDATE mobile_quick_access_tokens
    SET revoked_at = ?
    WHERE user_id = ? AND revoked_at IS NULL
  `).run(revokedAt, userId);
}

function applySessionRetentionPolicy(db) {
  const desktopResult = db.prepare(`
    UPDATE auth_sessions
    SET revoked_at = COALESCE(revoked_at, datetime('now')),
        revoke_reason = COALESCE(revoke_reason, 'Session expired after 2 hours of inactivity'),
        updated_at = datetime('now')
    WHERE revoked_at IS NULL
      AND COALESCE(session_type, 'desktop') != 'mobile_app'
      AND datetime(COALESCE(last_seen_at, issued_at, created_at)) <= datetime('now', '-120 minutes')
  `).run();

  const mobileResult = db.prepare(`
    UPDATE auth_sessions
    SET revoked_at = COALESCE(revoked_at, datetime('now')),
        revoke_reason = COALESCE(revoke_reason, 'Session expired after 2 hours of inactivity'),
        updated_at = datetime('now')
    WHERE revoked_at IS NULL
      AND COALESCE(session_type, 'desktop') = 'mobile_app'
      AND datetime(COALESCE(last_seen_at, issued_at, created_at)) <= datetime('now', '-120 minutes')
  `).run();

  const archiveResult = db.prepare(`
    UPDATE auth_sessions
    SET revoked_at = COALESCE(revoked_at, datetime('now')),
        revoke_reason = COALESCE(revoke_reason, 'Archived after 14 days'),
        updated_at = datetime('now')
    WHERE revoked_at IS NULL
      AND datetime(COALESCE(last_seen_at, issued_at, created_at)) <= datetime('now', '-14 days')
  `).run();

  return {
    desktop_expired: desktopResult.changes || 0,
    mobile_expired: mobileResult.changes || 0,
    archived: archiveResult.changes || 0,
  };
}

module.exports = {
  SESSION_IDLE_TIMEOUT_MINUTES,
  SESSION_IDLE_TIMEOUT_MS,
  DESKTOP_SESSION_IDLE_TIMEOUT_MINUTES,
  DESKTOP_SESSION_IDLE_TIMEOUT_MS,
  MOBILE_SESSION_IDLE_TIMEOUT_MINUTES,
  MOBILE_SESSION_IDLE_TIMEOUT_MS,
  SESSION_ARCHIVE_AFTER_DAYS,
  parseSqliteDateTime,
  isMobileSessionType,
  sessionExpiryPolicy,
  revokeSession,
  revokeUserAccess,
  applySessionRetentionPolicy,
};
