const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate, authorize } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { getClientIp } = require('../utils/requestIp');
const {
  DESKTOP_SESSION_IDLE_TIMEOUT_MINUTES,
  MOBILE_SESSION_MAX_AGE_HOURS,
  SESSION_ARCHIVE_AFTER_DAYS,
  applySessionRetentionPolicy,
} = require('../utils/sessionPolicy');

const router = express.Router();

router.use(authenticate);
router.use(authorize('super_admin', 'operations_manager'));

function nowIso() {
  return new Date().toISOString();
}

function requestMeta(req) {
  return {
    ip_address: getClientIp(req),
    user_agent: req.headers['user-agent'] || '',
  };
}

function parseJsonObject(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function sessionStatus(lastSeenAt) {
  if (!lastSeenAt) return 'signed_in';
  const parsed = new Date(String(lastSeenAt).includes('T') ? lastSeenAt : `${String(lastSeenAt).replace(' ', 'T')}Z`);
  if (!Number.isFinite(parsed.getTime())) return 'signed_in';
  const ageMs = Date.now() - parsed.getTime();
  if (ageMs <= 2 * 60 * 1000) return 'online';
  if (ageMs <= 15 * 60 * 1000) return 'recently_active';
  return 'signed_in';
}

function parseUserAgent(userAgent = '', sessionType = '') {
  const ua = String(userAgent || '');
  const lower = ua.toLowerCase();
  const isTablet = /ipad|tablet|kindle|silk/.test(lower);
  const isMobile = isTablet || /android|iphone|ipod|mobile|webos|blackberry|windows phone/.test(lower);
  const deviceType = isTablet ? 'tablet' : isMobile ? 'mobile' : 'desktop';
  const clientType = sessionType === 'mobile_app' || isMobile ? 'mobile_app' : 'desktop';

  let osLabel = 'Unknown OS';
  if (/iphone|ipad|ipod/i.test(ua)) osLabel = 'iOS';
  else if (/android/i.test(ua)) osLabel = 'Android';
  else if (/windows/i.test(ua)) osLabel = 'Windows';
  else if (/mac os x|macintosh/i.test(ua)) osLabel = 'macOS';
  else if (/linux/i.test(ua)) osLabel = 'Linux';

  let browserLabel = 'Unknown browser';
  if (/edg\//i.test(ua)) browserLabel = 'Microsoft Edge';
  else if (/crios/i.test(ua)) browserLabel = 'Chrome iOS';
  else if (/chrome|chromium/i.test(ua) && !/edg\//i.test(ua)) browserLabel = 'Chrome';
  else if (/firefox|fxios/i.test(ua)) browserLabel = 'Firefox';
  else if (/safari/i.test(ua) && !/chrome|chromium|crios|fxios|edg\//i.test(ua)) browserLabel = 'Safari';

  const clientLabel = clientType === 'mobile_app' ? (isTablet ? 'Tablet / mobile app' : 'Mobile app') : 'Desktop browser';
  const deviceLabel = [osLabel, browserLabel].filter(value => !value.startsWith('Unknown')).join(' / ') || 'Unknown device';
  return { client_type: clientType, client_label: clientLabel, device_type: deviceType, os_label: osLabel, browser_label: browserLabel, device_label: deviceLabel };
}

function formatSession(row, currentSessionId = null) {
  const parsed = parseUserAgent(row.user_agent, row.session_type);
  const loginIp = row.ip_address || '';
  const currentIp = row.current_ip_address || loginIp;
  return {
    id: row.id,
    user_id: row.user_id,
    session_type: row.session_type || 'desktop',
    ip_address: currentIp,
    login_ip_address: loginIp,
    current_ip_address: currentIp,
    ip_address_updated_at: row.ip_address_updated_at || null,
    user_agent: row.user_agent || '',
    issued_at: row.issued_at || null,
    last_seen_at: row.last_seen_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    details: parseJsonObject(row.details),
    revoked_at: row.revoked_at || null,
    revoke_reason: row.revoke_reason || null,
    revoked_by: row.revoked_by || null,
    revoked_by_name: row.revoked_by_name || null,
    archived_reason: row.archived_reason || row.revoke_reason || null,
    security_status: sessionStatus(row.last_seen_at),
    is_current_session: currentSessionId && row.id === currentSessionId,
    ...parsed,
  };
}

function writeSecurityEvent(db, req, { action, targetUserId = null, reason = null, details = null }) {
  const meta = requestMeta(req);
  db.prepare(`
    INSERT INTO security_events (
      id, actor_user_id, target_user_id, action, reason, ip_address, user_agent, details
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(),
    req.user.id,
    targetUserId,
    action,
    reason,
    meta.ip_address,
    meta.user_agent,
    details ? JSON.stringify(details) : null
  );

  logActivity({
    userId: req.user.id,
    action,
    entityType: 'security',
    entityId: targetUserId,
    details,
  });
}

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

router.get('/sessions', (req, res) => {
  try {
    const db = getDb();
    const cleanup = applySessionRetentionPolicy(db);
    const activeLimit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 10, 1), 50);
    const archiveLimit = Math.min(Math.max(Number.parseInt(req.query.archive_limit, 10) || 40, 1), 200);
    const users = db.prepare(`
      WITH session_summary AS (
        SELECT
          user_id,
          COUNT(*) AS active_session_count,
          MAX(last_seen_at) AS session_last_seen_at,
          MAX(issued_at) AS latest_session_issued_at,
          GROUP_CONCAT(DISTINCT session_type) AS session_types
        FROM auth_sessions
        WHERE revoked_at IS NULL
        GROUP BY user_id
      ),
      trusted_summary AS (
        SELECT user_id, COUNT(*) AS trusted_device_count
        FROM trusted_devices
        WHERE datetime(expires_at) > datetime('now')
        GROUP BY user_id
      ),
      quick_summary AS (
        SELECT user_id, COUNT(*) AS quick_access_count
        FROM mobile_quick_access_tokens
        WHERE revoked_at IS NULL AND datetime(expires_at) > datetime('now')
        GROUP BY user_id
      )
      SELECT
        u.id,
        u.name,
        u.email,
        u.role,
        u.phone,
        u.company,
        u.avatar_url,
        u.is_active,
        u.last_login_at,
        u.last_seen_at,
        u.session_revoked_at,
        COALESCE(ss.active_session_count, 0) AS active_session_count,
        ss.session_last_seen_at,
        ss.latest_session_issued_at,
        COALESCE(ss.session_types, '') AS session_types,
        COALESCE(ts.trusted_device_count, 0) AS trusted_device_count,
        COALESCE(qs.quick_access_count, 0) AS quick_access_count,
        CASE
          WHEN datetime(COALESCE(ss.session_last_seen_at, u.last_seen_at)) >= datetime('now', '-2 minutes') THEN 'online'
          WHEN datetime(COALESCE(ss.session_last_seen_at, u.last_seen_at)) >= datetime('now', '-15 minutes') THEN 'recently_active'
          WHEN COALESCE(ss.active_session_count, 0) > 0 THEN 'signed_in'
          ELSE 'offline'
        END AS security_status
      FROM users u
      LEFT JOIN session_summary ss ON ss.user_id = u.id
      LEFT JOIN trusted_summary ts ON ts.user_id = u.id
      LEFT JOIN quick_summary qs ON qs.user_id = u.id
      WHERE u.is_active = 1
        AND (
          u.last_login_at IS NOT NULL
          OR COALESCE(ss.active_session_count, 0) > 0
          OR COALESCE(ts.trusted_device_count, 0) > 0
          OR COALESCE(qs.quick_access_count, 0) > 0
        )
      ORDER BY
        CASE security_status
          WHEN 'online' THEN 1
          WHEN 'recently_active' THEN 2
          WHEN 'signed_in' THEN 3
          ELSE 4
        END,
        datetime(COALESCE(ss.session_last_seen_at, u.last_seen_at, u.last_login_at, u.created_at)) DESC,
        lower(u.name)
    `).all();

    const sessions = db.prepare(`
      SELECT
        s.id,
        s.user_id,
        s.session_type,
        s.user_agent,
        s.ip_address,
        s.current_ip_address,
        s.ip_address_updated_at,
        s.issued_at,
        s.last_seen_at,
        s.revoked_at,
        s.revoke_reason,
        s.revoked_by,
        s.details,
        s.created_at,
        s.updated_at
      FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.revoked_at IS NULL
        AND u.is_active = 1
      ORDER BY
        datetime(COALESCE(s.last_seen_at, s.issued_at, s.created_at)) DESC,
        s.created_at DESC
      LIMIT ?
    `).all(activeLimit).map(row => formatSession(row, req.auth?.session_id || null));

    const archivedSessions = db.prepare(`
      SELECT
        s.id,
        s.user_id,
        s.session_type,
        s.user_agent,
        s.ip_address,
        s.current_ip_address,
        s.ip_address_updated_at,
        s.issued_at,
        s.last_seen_at,
        s.revoked_at,
        s.revoke_reason,
        s.revoked_by,
        s.details,
        s.created_at,
        s.updated_at,
        u.name as user_name,
        u.email as user_email,
        u.role as user_role,
        actor.name as revoked_by_name,
        CASE
          WHEN s.revoked_at IS NULL THEN 'Archived after 14 days'
          WHEN s.revoke_reason IS NOT NULL THEN s.revoke_reason
          ELSE 'Past session'
        END as archived_reason
      FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN users actor ON actor.id = s.revoked_by
      WHERE (
          s.revoked_at IS NOT NULL
          OR datetime(COALESCE(s.last_seen_at, s.issued_at, s.created_at)) <= datetime('now', '-14 days')
        )
      ORDER BY
        datetime(COALESCE(s.revoked_at, s.last_seen_at, s.issued_at, s.created_at)) DESC,
        s.created_at DESC
      LIMIT ?
    `).all(archiveLimit).map(row => ({
      ...formatSession(row, req.auth?.session_id || null),
      user_name: row.user_name,
      user_email: row.user_email,
      user_role: row.user_role,
    }));

    const sessionsByUser = sessions.reduce((acc, session) => {
      if (!acc.has(session.user_id)) acc.set(session.user_id, []);
      acc.get(session.user_id).push(session);
      return acc;
    }, new Map());

    const usersWithSessions = users.map(row => ({
      ...row,
      sessions: sessionsByUser.get(row.id) || [],
    }));

    const counts = usersWithSessions.reduce((acc, row) => {
      acc.total += 1;
      acc[row.security_status] = (acc[row.security_status] || 0) + 1;
      return acc;
    }, { total: 0, online: 0, recently_active: 0, signed_in: 0, offline: 0 });
    counts.session_records = sessions.length;
    counts.total_active_session_records = db.prepare(`
      SELECT COUNT(*) as count
      FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.revoked_at IS NULL AND u.is_active = 1
    `).get().count || 0;
    counts.archived_session_records = db.prepare(`
      SELECT COUNT(*) as count
      FROM auth_sessions
      WHERE revoked_at IS NOT NULL
        OR datetime(COALESCE(last_seen_at, issued_at, created_at)) <= datetime('now', '-14 days')
    `).get().count || 0;
    counts.online_sessions = sessions.filter(row => row.security_status === 'online').length;
    counts.recent_sessions = sessions.filter(row => ['online', 'recently_active'].includes(row.security_status)).length;
    counts.active_session_display_limit = activeLimit;
    counts.archive_display_limit = archiveLimit;
    counts.desktop_idle_timeout_minutes = DESKTOP_SESSION_IDLE_TIMEOUT_MINUTES;
    counts.mobile_session_max_age_hours = MOBILE_SESSION_MAX_AGE_HOURS;
    counts.session_archive_after_days = SESSION_ARCHIVE_AFTER_DAYS;
    counts.cleanup = cleanup;

    res.json({ users: usersWithSessions, sessions, archived_sessions: archivedSessions, counts });
  } catch (err) {
    console.error('Security sessions error:', err);
    res.status(500).json({ error: 'Failed to load security sessions' });
  }
});

router.get('/events', (req, res) => {
  try {
    const db = getDb();
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
    const events = db.prepare(`
      SELECT
        se.*,
        actor.name AS actor_name,
        actor.email AS actor_email,
        target.name AS target_name,
        target.email AS target_email
      FROM security_events se
      JOIN users actor ON actor.id = se.actor_user_id
      LEFT JOIN users target ON target.id = se.target_user_id
      ORDER BY datetime(se.created_at) DESC
      LIMIT ?
    `).all(limit);
    res.json({ events });
  } catch (err) {
    console.error('Security events error:', err);
    res.status(500).json({ error: 'Failed to load security history' });
  }
});

router.get('/data-access', (req, res) => {
  try {
    const db = getDb();
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
    const accessType = String(req.query.access_type || '').trim();
    const entityType = String(req.query.entity_type || '').trim();
    const userId = String(req.query.user_id || '').trim();
    const q = String(req.query.q || '').trim();

    const where = [];
    const params = [];

    if (accessType) {
      where.push('dae.access_type = ?');
      params.push(accessType);
    }

    if (entityType) {
      where.push('dae.entity_type = ?');
      params.push(entityType);
    }

    if (userId) {
      where.push('dae.user_id = ?');
      params.push(userId);
    }

    if (q) {
      const like = `%${q}%`;
      where.push(`(
        u.name LIKE ?
        OR u.email LIKE ?
        OR dae.action LIKE ?
        OR dae.entity_type LIKE ?
        OR COALESCE(dae.route, '') LIKE ?
        OR COALESCE(dae.details, '') LIKE ?
        OR COALESCE(p.address, '') LIKE ?
        OR COALESCE(p.job_name, '') LIKE ?
      )`);
      params.push(like, like, like, like, like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const events = db.prepare(`
      SELECT
        dae.*,
        u.name AS user_name,
        u.email AS user_email,
        u.role AS user_role,
        p.address AS project_address,
        p.job_name AS project_job_name
      FROM data_access_events dae
      JOIN users u ON u.id = dae.user_id
      LEFT JOIN projects p ON p.id = dae.project_id
      ${whereSql}
      ORDER BY datetime(dae.created_at) DESC, dae.created_at DESC
      LIMIT ?
    `).all(...params, limit).map(row => ({
      ...row,
      details: parseJsonObject(row.details),
    }));

    const counts = db.prepare(`
      SELECT
        COUNT(*) AS total_24h,
        COALESCE(SUM(CASE WHEN access_type = 'download' THEN 1 ELSE 0 END), 0) AS downloads_24h,
        COALESCE(SUM(CASE WHEN access_type = 'sensitive_view' THEN 1 ELSE 0 END), 0) AS sensitive_views_24h,
        COALESCE(SUM(CASE WHEN entity_type = 'project' THEN 1 ELSE 0 END), 0) AS project_access_24h,
        COALESCE(SUM(CASE WHEN entity_type IN ('contractor', 'contractor_profile', 'supplier') THEN 1 ELSE 0 END), 0) AS vendor_supplier_access_24h
      FROM data_access_events
      WHERE datetime(created_at) >= datetime('now', '-24 hours')
    `).get();

    res.json({
      events,
      counts: {
        total_24h: Number(counts?.total_24h || 0),
        downloads_24h: Number(counts?.downloads_24h || 0),
        sensitive_views_24h: Number(counts?.sensitive_views_24h || 0),
        project_access_24h: Number(counts?.project_access_24h || 0),
        vendor_supplier_access_24h: Number(counts?.vendor_supplier_access_24h || 0),
      },
    });
  } catch (err) {
    console.error('Data access audit error:', err);
    res.status(500).json({ error: 'Failed to load data access audit' });
  }
});

router.post('/logout-all', (req, res) => {
  try {
    const db = getDb();
    const revokedAt = nowIso();
    const reason = String(req.body?.reason || 'Security logout all users').trim().slice(0, 240);
    const activeUsers = db.prepare('SELECT id FROM users WHERE is_active = 1').all();

    const revokeAll = db.transaction(() => {
      for (const row of activeUsers) {
        revokeUserAccess(db, row.id, req.user.id, reason, revokedAt);
      }
      writeSecurityEvent(db, req, {
        action: 'security_logout_all_users',
        reason,
        details: { affected_user_count: activeUsers.length },
      });
    });

    revokeAll();
    res.json({ message: 'All active users have been logged out and must sign in again.', affected_user_count: activeUsers.length });
  } catch (err) {
    console.error('Security logout all error:', err);
    res.status(500).json({ error: 'Failed to log out all users' });
  }
});

router.post('/sessions/:sessionId/logout', (req, res) => {
  try {
    const db = getDb();
    const target = db.prepare(`
      SELECT
        s.id,
        s.user_id,
        s.session_type,
        s.ip_address,
        s.current_ip_address,
        s.ip_address_updated_at,
        s.user_agent,
        s.last_seen_at,
        u.name,
        u.email
      FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.id = ?
        AND s.revoked_at IS NULL
        AND u.is_active = 1
      LIMIT 1
    `).get(req.params.sessionId);
    if (!target) return res.status(404).json({ error: 'Active session not found' });

    const revokedAt = nowIso();
    const reason = String(req.body?.reason || `Security logout session: ${target.name}`).trim().slice(0, 240);

    const revokeOneSession = db.transaction(() => {
      db.prepare(`
        UPDATE auth_sessions
        SET revoked_at = ?,
            revoke_reason = ?,
            revoked_by = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(revokedAt, reason, req.user.id, target.id);

      writeSecurityEvent(db, req, {
        action: 'security_logout_session',
        targetUserId: target.user_id,
        reason,
        details: {
          target_name: target.name,
          target_email: target.email,
          session_id: target.id,
          session_type: target.session_type,
          ip_address: target.current_ip_address || target.ip_address,
          login_ip_address: target.ip_address,
          current_ip_address: target.current_ip_address || target.ip_address,
          user_agent: target.user_agent,
        },
      });
    });

    revokeOneSession();
    res.json({
      message: `${target.name}'s selected session has been logged out.`,
      target_user_id: target.user_id,
      session_id: target.id,
    });
  } catch (err) {
    console.error('Security session logout error:', err);
    res.status(500).json({ error: 'Failed to log out session' });
  }
});

router.post('/users/:userId/logout', (req, res) => {
  try {
    const db = getDb();
    const target = db.prepare('SELECT id, name, email FROM users WHERE id = ? AND is_active = 1').get(req.params.userId);
    if (!target) return res.status(404).json({ error: 'User not found or inactive' });

    const revokedAt = nowIso();
    const reason = String(req.body?.reason || 'Security logout user').trim().slice(0, 240);

    const revokeOne = db.transaction(() => {
      revokeUserAccess(db, target.id, req.user.id, reason, revokedAt);
      writeSecurityEvent(db, req, {
        action: 'security_logout_user',
        targetUserId: target.id,
        reason,
        details: { target_name: target.name, target_email: target.email },
      });
    });

    revokeOne();
    res.json({ message: `${target.name} has been logged out and must sign in again.`, target_user_id: target.id });
  } catch (err) {
    console.error('Security user logout error:', err);
    res.status(500).json({ error: 'Failed to log out user' });
  }
});

module.exports = router;
