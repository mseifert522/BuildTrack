const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { sendCalendarReminderEmail } = require('../utils/email');

const REMINDER_TYPES = new Set(['now', 'once', 'weekly', 'monthly']);
const ACTIVE_STATUS = 'active';
let schedulerStarted = false;
let schedulerRunning = false;

function toSqlDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function parseSqlDateTime(value) {
  if (!value) return null;
  const normalized = String(value).includes('T') ? String(value) : `${String(value).replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date : null;
}

function addInterval(value, scheduleType) {
  const date = parseSqlDateTime(value) || new Date();
  if (scheduleType === 'weekly') {
    date.setUTCDate(date.getUTCDate() + 7);
  } else if (scheduleType === 'monthly') {
    date.setUTCMonth(date.getUTCMonth() + 1);
  }
  return toSqlDateTime(date);
}

function normalizeRecipients(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value || '');
  const seen = new Set();
  const recipients = raw
    .split(/[\s,;]+/)
    .map(item => item.trim().toLowerCase())
    .filter(Boolean)
    .filter(email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    .filter(email => {
      if (seen.has(email)) return false;
      seen.add(email);
      return true;
    });
  return recipients.slice(0, 40);
}

function scheduleLabel(reminder) {
  if (reminder.schedule_type === 'now') return 'Sent now';
  if (reminder.schedule_type === 'once') return `One-time reminder at ${reminder.next_send_at}`;
  if (reminder.schedule_type === 'weekly') return `Weekly reminder, next send ${reminder.next_send_at}`;
  if (reminder.schedule_type === 'monthly') return `Monthly reminder, next send ${reminder.next_send_at}`;
  return 'Calendar reminder';
}

function getReminderContext(db, reminderId) {
  return db.prepare(`
    SELECT
      cer.*,
      oce.title as event_title,
      oce.description as event_description,
      oce.event_type,
      oce.scheduled_for,
      oce.due_time,
      oce.priority,
      oce.project_id,
      p.address as project_address,
      p.job_name as project_job_name,
      u.name as created_by_name
    FROM calendar_email_reminders cer
    JOIN operations_calendar_events oce ON oce.id = cer.event_id
    LEFT JOIN projects p ON p.id = oce.project_id
    LEFT JOIN users u ON u.id = cer.created_by
    WHERE cer.id = ?
  `).get(reminderId);
}

async function sendCalendarReminderNow(reminderId) {
  const db = getDb();
  const reminder = getReminderContext(db, reminderId);
  if (!reminder) {
    return { ok: false, error: 'Calendar reminder not found' };
  }
  if (!['active', 'failed'].includes(reminder.status)) {
    return { ok: false, error: `Calendar reminder is ${reminder.status}` };
  }

  let recipients = [];
  try {
    recipients = JSON.parse(reminder.recipients_json || '[]');
  } catch (_) {
    recipients = [];
  }
  recipients = normalizeRecipients(recipients);
  if (!recipients.length) {
    const error = 'Calendar reminder has no valid recipients';
    db.prepare(`
      UPDATE calendar_email_reminders
      SET status = 'failed', last_error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(error, reminder.id);
    return { ok: false, error };
  }

  try {
    await sendCalendarReminderEmail({
      recipients,
      subject: reminder.subject,
      message: reminder.message,
      event: {
        id: reminder.event_id,
        title: reminder.event_title,
        description: reminder.event_description,
        event_type: reminder.event_type,
        scheduled_for: reminder.scheduled_for,
        due_time: reminder.due_time,
        priority: reminder.priority,
        project_id: reminder.project_id,
        project_address: reminder.project_address,
      },
      project: {
        id: reminder.project_id,
        address: reminder.project_address,
        job_name: reminder.project_job_name,
      },
      createdBy: reminder.created_by_name,
      scheduleLabel: scheduleLabel(reminder),
    });

    const recurring = reminder.schedule_type === 'weekly' || reminder.schedule_type === 'monthly';
    const nextSendAt = recurring ? addInterval(reminder.next_send_at || new Date(), reminder.schedule_type) : null;
    db.prepare(`
      UPDATE calendar_email_reminders
      SET
        status = ?,
        sent_count = COALESCE(sent_count, 0) + 1,
        last_sent_at = datetime('now'),
        next_send_at = ?,
        last_error = NULL,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(recurring ? ACTIVE_STATUS : 'sent', nextSendAt, reminder.id);
    return { ok: true, next_send_at: nextSendAt };
  } catch (err) {
    const message = err.message || 'Failed to send calendar reminder';
    db.prepare(`
      UPDATE calendar_email_reminders
      SET status = 'failed', last_error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(message.slice(0, 1000), reminder.id);
    console.error('[CALENDAR REMINDER] Send failed:', message);
    return { ok: false, error: message };
  }
}

async function processDueCalendarReminders() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const db = getDb();
    const due = db.prepare(`
      SELECT id
      FROM calendar_email_reminders
      WHERE status = 'active'
        AND next_send_at IS NOT NULL
        AND datetime(next_send_at) <= datetime('now')
      ORDER BY datetime(next_send_at) ASC, created_at ASC
      LIMIT 20
    `).all();
    for (const row of due) {
      await sendCalendarReminderNow(row.id);
    }
  } finally {
    schedulerRunning = false;
  }
}

function createCalendarReminder(db, { eventId, projectId, userId, reminder, eventTitle, eventDescription }) {
  const scheduleType = REMINDER_TYPES.has(String(reminder?.schedule_type)) ? String(reminder.schedule_type) : 'once';
  const recipients = normalizeRecipients(reminder?.recipients);
  if (!recipients.length) {
    const err = new Error('Enter at least one valid reminder email address');
    err.statusCode = 400;
    throw err;
  }

  const now = new Date();
  const requestedSendAt = scheduleType === 'now' ? now : new Date(String(reminder?.send_at || ''));
  if (!Number.isFinite(requestedSendAt.getTime())) {
    const err = new Error('Reminder send date and time are required');
    err.statusCode = 400;
    throw err;
  }

  const id = uuidv4();
  const nextSendAt = toSqlDateTime(requestedSendAt);
  const subject = String(reminder?.subject || eventTitle || 'BuildTrack calendar reminder').trim().slice(0, 180);
  const message = String(reminder?.message || eventDescription || eventTitle || 'BuildTrack calendar reminder').trim().slice(0, 4000);

  db.prepare(`
    INSERT INTO calendar_email_reminders (
      id, event_id, project_id, recipients_json, subject, message, schedule_type,
      next_send_at, status, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(
    id,
    eventId,
    projectId || null,
    JSON.stringify(recipients),
    subject,
    message,
    scheduleType,
    nextSendAt,
    userId
  );

  return {
    id,
    recipients,
    subject,
    message,
    schedule_type: scheduleType,
    next_send_at: nextSendAt,
    status: ACTIVE_STATUS,
  };
}

function startCalendarReminderScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const intervalMs = Number.parseInt(process.env.CALENDAR_REMINDER_POLL_MS || '60000', 10);
  setTimeout(() => processDueCalendarReminders().catch(err => console.error('[CALENDAR REMINDER] Poll failed:', err)), 5000).unref?.();
  setInterval(() => {
    processDueCalendarReminders().catch(err => console.error('[CALENDAR REMINDER] Poll failed:', err));
  }, Number.isFinite(intervalMs) && intervalMs >= 10000 ? intervalMs : 60000).unref?.();
  console.log('[CALENDAR REMINDER] Scheduler started');
}

module.exports = {
  createCalendarReminder,
  sendCalendarReminderNow,
  processDueCalendarReminders,
  startCalendarReminderScheduler,
  normalizeRecipients,
  toSqlDateTime,
};
