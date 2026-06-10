const DESKTOP_SESSION_IDLE_TIMEOUT_MINUTES = 70;
const DESKTOP_SESSION_IDLE_TIMEOUT_MS = DESKTOP_SESSION_IDLE_TIMEOUT_MINUTES * 60 * 1000;
const MOBILE_SESSION_MAX_AGE_HOURS = 48;
const MOBILE_SESSION_MAX_AGE_MS = MOBILE_SESSION_MAX_AGE_HOURS * 60 * 60 * 1000;
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

function sessionIssuedMs(session) {
  return parseSqliteDateTime(session?.issued_at) || parseSqliteDateTime(session?.created_at) || sessionLastActivityMs(session);
}

function sessionExpiryPolicy(session, nowMs = Date.now()) {
  if (!session || session.revoked_at) return null;
  const mobile = isMobileSessionType(session.session_type);
  if (mobile) {
    const issuedMs = sessionIssuedMs(session);
    if (issuedMs > 0 && issuedMs + MOBILE_SESSION_MAX_AGE_MS <= nowMs) {
      return {
        reason: 'Mobile session expired after 48 hours',
        message: 'Mobile session expired after 48 hours. Please log in again with your PIN or email and password.',
      };
    }
    return null;
  }

  const lastActivityMs = sessionLastActivityMs(session);
  if (lastActivityMs > 0 && lastActivityMs + DESKTOP_SESSION_IDLE_TIMEOUT_MS <= nowMs) {
    return {
      reason: 'Desktop session expired after 70 minutes of inactivity',
      message: 'Desktop session expired after 70 minutes of inactivity. Please log in again.',
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

function applySessionRetentionPolicy(db) {
  const desktopResult = db.prepare(`
    UPDATE auth_sessions
    SET revoked_at = COALESCE(revoked_at, datetime('now')),
        revoke_reason = COALESCE(revoke_reason, 'Desktop session expired after 70 minutes of inactivity'),
        updated_at = datetime('now')
    WHERE revoked_at IS NULL
      AND COALESCE(session_type, 'desktop') != 'mobile_app'
      AND datetime(COALESCE(last_seen_at, issued_at, created_at)) <= datetime('now', '-70 minutes')
  `).run();

  const mobileResult = db.prepare(`
    UPDATE auth_sessions
    SET revoked_at = COALESCE(revoked_at, datetime('now')),
        revoke_reason = COALESCE(revoke_reason, 'Mobile session expired after 48 hours'),
        updated_at = datetime('now')
    WHERE revoked_at IS NULL
      AND COALESCE(session_type, 'desktop') = 'mobile_app'
      AND datetime(COALESCE(issued_at, created_at)) <= datetime('now', '-48 hours')
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
  DESKTOP_SESSION_IDLE_TIMEOUT_MINUTES,
  DESKTOP_SESSION_IDLE_TIMEOUT_MS,
  MOBILE_SESSION_MAX_AGE_HOURS,
  MOBILE_SESSION_MAX_AGE_MS,
  SESSION_ARCHIVE_AFTER_DAYS,
  parseSqliteDateTime,
  isMobileSessionType,
  sessionExpiryPolicy,
  revokeSession,
  applySessionRetentionPolicy,
};
