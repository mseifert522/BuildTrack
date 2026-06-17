const express = require('express');
const { v4: uuidv4 } = require('uuid');

const { getDb } = require('../db/schema');
const { authenticate } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const { createCalendarReminder, sendCalendarReminderNow } = require('../services/calendarReminderScheduler');

const router = express.Router();

const MANAGEMENT_ROLES = ['super_admin', 'operations_manager', 'project_manager'];
const EVENT_TYPES = new Set(['task', 'maintenance', 'inspection', 'note', 'other']);
const PRIORITIES = new Set(['low', 'normal', 'high', 'critical']);
const STATUSES = new Set(['scheduled', 'in_progress', 'completed', 'cancelled']);

router.use(authenticate);

function isManagement(user) {
  return MANAGEMENT_ROLES.includes(user?.role);
}

router.use((req, res, next) => {
  if (!isManagement(req.user)) {
    return res.status(403).json({ error: 'Only management users can access the operations calendar' });
  }
  next();
});

function normalizeDate(value, fallback = null) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const date = new Date(raw.length === 10 ? `${raw}T12:00:00` : raw);
  if (Number.isNaN(date.getTime())) return fallback;
  return raw.length === 10 ? raw : date.toISOString().slice(0, 10);
}

function rangeFromQuery(req) {
  const today = new Date();
  const start = normalizeDate(req.query.start, today.toISOString().slice(0, 10));
  const defaultEnd = new Date(`${start}T12:00:00`);
  defaultEnd.setDate(defaultEnd.getDate() + 14);
  const end = normalizeDate(req.query.end, defaultEnd.toISOString().slice(0, 10));
  return { start, end };
}

function projectAccessClause(user, alias = 'p') {
  if (isManagement(user)) return { sql: '', params: [] };
  return {
    sql: ` AND EXISTS (
      SELECT 1 FROM project_assignments pa
      WHERE pa.project_id = ${alias}.id AND pa.user_id = ?
    )`,
    params: [user.id],
  };
}

function assertProjectAccess(db, user, projectId) {
  if (!projectId) return null;
  const project = db.prepare('SELECT id, address, job_name FROM projects WHERE id = ?').get(projectId);
  if (!project) {
    const err = new Error('Project not found');
    err.statusCode = 404;
    throw err;
  }
  if (!isManagement(user)) {
    const assignment = db.prepare('SELECT 1 FROM project_assignments WHERE project_id = ? AND user_id = ?').get(projectId, user.id);
    if (!assignment) {
      const err = new Error('You do not have access to this project');
      err.statusCode = 403;
      throw err;
    }
  }
  return project;
}

function normalizeExplicitEvent(row) {
  return {
    id: row.id,
    source: row.source_type || 'manual',
    source_id: row.source_id || row.id,
    event_type: row.event_type || 'other',
    title: row.title,
    description: row.description || '',
    scheduled_for: row.scheduled_for,
    due_time: row.due_time || null,
    status: row.status || 'scheduled',
    priority: row.priority || 'normal',
    amount: Number(row.amount || 0),
    vendor_name: row.vendor_name || null,
    project_id: row.project_id || null,
    project_address: row.project_address || null,
    project_job_name: row.project_job_name || null,
    created_by_name: row.created_by_name || null,
    created_at: row.created_at,
    email_reminder_count: Number(row.email_reminder_count || 0),
    next_email_reminder_at: row.next_email_reminder_at || null,
    completion_note: row.completion_note || '',
    completed_at: row.completed_at || null,
  };
}

router.get('/events', (req, res) => {
  try {
    const db = getDb();
    const { start, end } = rangeFromQuery(req);
    const explicitAccess = projectAccessClause(req.user, 'p');
    const explicitEvents = db.prepare(`
      SELECT
        oce.*,
        p.address as project_address,
        p.job_name as project_job_name,
        u.name as created_by_name,
        (
          SELECT COUNT(*)
          FROM calendar_email_reminders cer
          WHERE cer.event_id = oce.id AND cer.status IN ('active','sent','failed')
        ) as email_reminder_count,
        (
          SELECT MIN(cer.next_send_at)
          FROM calendar_email_reminders cer
          WHERE cer.event_id = oce.id AND cer.status = 'active'
        ) as next_email_reminder_at
      FROM operations_calendar_events oce
      LEFT JOIN projects p ON p.id = oce.project_id
      LEFT JOIN users u ON u.id = oce.created_by
      WHERE date(oce.scheduled_for) BETWEEN date(?) AND date(?)
        AND oce.status IN ('scheduled','in_progress','completed')
        AND lower(COALESCE(oce.event_type, '')) NOT IN ('invoice','payment')
        AND lower(COALESCE(oce.source_type, '')) NOT IN ('invoice','payment','quickbooks','bill')
        AND (oce.project_id IS NULL OR p.id IS NOT NULL)
        ${explicitAccess.sql}
      ORDER BY date(oce.scheduled_for), oce.due_time, datetime(oce.created_at) DESC
      LIMIT 160
    `).all(start, end, ...explicitAccess.params).map(normalizeExplicitEvent);

    const projectAccess = projectAccessClause(req.user, 'p');
    const taskEvents = db.prepare(`
      SELECT
        cpi.id, cpi.project_id, cpi.title, cpi.description, cpi.category, cpi.status, cpi.verification_status,
        cpi.invoice_status, cpi.target_date, cpi.approval_notes, cpi.completed_at,
        p.address as project_address, p.job_name as project_job_name
      FROM construction_plan_items cpi
      JOIN projects p ON p.id = cpi.project_id
      WHERE cpi.target_date IS NOT NULL
        AND cpi.target_date != ''
        AND date(cpi.target_date) BETWEEN date(?) AND date(?)
        ${projectAccess.sql}
      ORDER BY date(cpi.target_date)
      LIMIT 120
    `).all(start, end, ...projectAccess.params).map(row => ({
      id: `task-${row.id}`,
      source: 'construction_task',
      source_id: row.id,
      event_type: 'task',
      title: row.title,
      description: row.description || row.category || '',
      scheduled_for: row.target_date,
      due_time: null,
      status: row.status || 'scheduled',
      priority: row.verification_status === 'pending_review' || row.invoice_status === 'approval_needed' ? 'high' : 'normal',
      amount: 0,
      vendor_name: null,
      project_id: row.project_id,
      project_address: row.project_address,
      project_job_name: row.project_job_name,
      created_by_name: null,
      created_at: row.target_date,
      completion_note: row.approval_notes || '',
      completed_at: row.completed_at || null,
    }));

    const events = [...explicitEvents, ...taskEvents]
      .sort((left, right) => {
        const leftKey = `${left.scheduled_for || '9999-12-31'} ${left.due_time || '23:59'} ${left.created_at || ''}`;
        const rightKey = `${right.scheduled_for || '9999-12-31'} ${right.due_time || '23:59'} ${right.created_at || ''}`;
        return leftKey.localeCompare(rightKey);
      })
      .slice(0, 120);

    res.json({ start, end, events });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load operations calendar' });
  }
});

router.post('/events', async (req, res) => {
  try {
    const db = getDb();
    const title = String(req.body.title || '').trim();
    const scheduledFor = normalizeDate(req.body.scheduled_for || req.body.date);
    if (!title) return res.status(400).json({ error: 'Calendar title is required' });
    if (!scheduledFor) return res.status(400).json({ error: 'Calendar date is required' });

    const projectId = req.body.project_id ? String(req.body.project_id) : null;
    const project = assertProjectAccess(db, req.user, projectId);
    const eventType = EVENT_TYPES.has(String(req.body.event_type)) ? String(req.body.event_type) : 'other';
    const priority = PRIORITIES.has(String(req.body.priority)) ? String(req.body.priority) : 'normal';
    const status = STATUSES.has(String(req.body.status)) ? String(req.body.status) : 'scheduled';
    const amount = Number.parseFloat(String(req.body.amount || '0').replace(/[$,]/g, ''));
    const id = uuidv4();

    const description = req.body.description ? String(req.body.description).slice(0, 1000) : null;
    const reminderRequest = req.body.email_reminder && req.body.email_reminder.enabled !== false
      ? req.body.email_reminder
      : null;
    if (reminderRequest && !isManagement(req.user)) {
      return res.status(403).json({ error: 'Only management users can send calendar email reminders' });
    }

    db.prepare(`
      INSERT INTO operations_calendar_events (
        id, project_id, source_type, source_id, title, description, event_type, scheduled_for,
        due_time, status, priority, amount, vendor_name, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      projectId,
      String(req.body.source_type || 'manual').slice(0, 40),
      req.body.source_id ? String(req.body.source_id).slice(0, 80) : null,
      title.slice(0, 180),
      description,
      eventType,
      scheduledFor,
      req.body.due_time ? String(req.body.due_time).slice(0, 20) : null,
      status,
      priority,
      Number.isFinite(amount) ? Math.max(amount, 0) : 0,
      req.body.vendor_name ? String(req.body.vendor_name).slice(0, 160) : null,
      req.user.id
    );

    logActivity({
      userId: req.user.id,
      projectId,
      action: 'calendar_event_created',
      entityType: 'operations_calendar_event',
      entityId: id,
      details: { title, scheduled_for: scheduledFor, event_type: eventType },
    });

    let emailReminder = null;
    let emailWarning = null;
    if (reminderRequest) {
      emailReminder = createCalendarReminder(db, {
        eventId: id,
        projectId,
        userId: req.user.id,
        reminder: reminderRequest,
        eventTitle: title,
        eventDescription: description,
      });
      logActivity({
        userId: req.user.id,
        projectId,
        action: 'calendar_email_reminder_created',
        entityType: 'calendar_email_reminder',
        entityId: emailReminder.id,
        details: {
          title,
          schedule_type: emailReminder.schedule_type,
          next_send_at: emailReminder.next_send_at,
          recipient_count: emailReminder.recipients.length,
        },
      });
      if (emailReminder.schedule_type === 'now') {
        const sendResult = await sendCalendarReminderNow(emailReminder.id);
        emailReminder.status = sendResult.ok ? 'sent' : 'failed';
        emailReminder.next_send_at = sendResult.next_send_at || null;
        if (!sendResult.ok) emailWarning = sendResult.error || 'Calendar item saved, but email reminder failed to send';
      }
    }

    res.status(201).json({
      id,
      project_id: projectId,
      project_address: project?.address || null,
      project_job_name: project?.job_name || null,
      title,
      scheduled_for: scheduledFor,
      event_type: eventType,
      priority,
      status,
      email_reminder: emailReminder,
      warning: emailWarning,
    });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to create calendar event' });
  }
});

router.post('/events/:id/email-reminders', async (req, res) => {
  try {
    if (!isManagement(req.user)) {
      return res.status(403).json({ error: 'Only management users can send calendar email reminders' });
    }
    const db = getDb();
    const event = db.prepare('SELECT * FROM operations_calendar_events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Calendar event not found' });
    assertProjectAccess(db, req.user, event.project_id);

    const emailReminder = createCalendarReminder(db, {
      eventId: event.id,
      projectId: event.project_id,
      userId: req.user.id,
      reminder: req.body,
      eventTitle: event.title,
      eventDescription: event.description,
    });

    let warning = null;
    if (emailReminder.schedule_type === 'now') {
      const sendResult = await sendCalendarReminderNow(emailReminder.id);
      emailReminder.status = sendResult.ok ? 'sent' : 'failed';
      emailReminder.next_send_at = sendResult.next_send_at || null;
      if (!sendResult.ok) warning = sendResult.error || 'Email reminder failed to send';
    }

    logActivity({
      userId: req.user.id,
      projectId: event.project_id,
      action: 'calendar_email_reminder_created',
      entityType: 'calendar_email_reminder',
      entityId: emailReminder.id,
      details: {
        title: event.title,
        schedule_type: emailReminder.schedule_type,
        next_send_at: emailReminder.next_send_at,
        recipient_count: emailReminder.recipients.length,
      },
    });

    res.status(201).json({ reminder: emailReminder, warning });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to create email reminder' });
  }
});

router.put('/events/:id', (req, res) => {
  try {
    const db = getDb();
    const event = db.prepare('SELECT * FROM operations_calendar_events WHERE id = ?').get(req.params.id);
    if (!event && String(req.params.id || '').startsWith('task-')) {
      const itemId = String(req.params.id).replace(/^task-/, '');
      const item = db.prepare('SELECT * FROM construction_plan_items WHERE id = ?').get(itemId);
      if (!item) return res.status(404).json({ error: 'Calendar event not found' });
      assertProjectAccess(db, req.user, item.project_id);
      const title = req.body.title !== undefined ? String(req.body.title || '').trim().slice(0, 180) : item.title;
      if (!title) return res.status(400).json({ error: 'Calendar title is required' });
      const description = req.body.description !== undefined
        ? String(req.body.description || '').slice(0, 1000)
        : item.description;
      const scheduledFor = req.body.scheduled_for !== undefined
        ? normalizeDate(req.body.scheduled_for, item.target_date)
        : item.target_date;
      const requestedStatus = req.body.status !== undefined ? String(req.body.status) : null;
      const status = requestedStatus === null
        ? item.status
        : requestedStatus === 'completed'
          ? 'completed'
          : requestedStatus === 'in_progress'
            ? 'in_progress'
            : requestedStatus === 'scheduled'
              ? 'not_started'
              : item.status;
      const completionNote = req.body.completion_note !== undefined
        ? String(req.body.completion_note || '').slice(0, 2000)
        : item.approval_notes;
      db.prepare(`
        UPDATE construction_plan_items
        SET title = ?,
            description = ?,
            target_date = ?,
            status = ?,
            approval_notes = ?,
            completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, datetime('now')) ELSE completed_at END,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(title, description || null, scheduledFor || null, status, completionNote || null, status, itemId);
      logActivity({
        userId: req.user.id,
        projectId: item.project_id,
        action: status === 'completed' ? 'calendar_task_completed' : 'calendar_task_updated',
        entityType: 'construction_plan_item',
        entityId: itemId,
        details: { title, scheduled_for: scheduledFor, status, completion_note_added: Boolean(completionNote) },
      });
      return res.json({ message: 'Calendar task updated' });
    }
    if (!event) return res.status(404).json({ error: 'Calendar event not found' });
    const nextProjectId = req.body.project_id !== undefined
      ? (req.body.project_id ? String(req.body.project_id) : null)
      : event.project_id;
    assertProjectAccess(db, req.user, nextProjectId);

    const status = req.body.status !== undefined && STATUSES.has(String(req.body.status)) ? String(req.body.status) : event.status;
    const scheduledFor = req.body.scheduled_for !== undefined ? normalizeDate(req.body.scheduled_for, event.scheduled_for) : event.scheduled_for;
    const title = req.body.title !== undefined ? String(req.body.title || '').trim().slice(0, 180) : event.title;
    if (!title) return res.status(400).json({ error: 'Calendar title is required' });
    const eventType = req.body.event_type !== undefined && EVENT_TYPES.has(String(req.body.event_type))
      ? String(req.body.event_type)
      : event.event_type;

    const completionNote = req.body.completion_note !== undefined
      ? String(req.body.completion_note || '').slice(0, 2000)
      : event.completion_note;
    const vendorName = req.body.vendor_name !== undefined
      ? (String(req.body.vendor_name || '').trim().slice(0, 160) || null)
      : event.vendor_name;
    db.prepare(`
      UPDATE operations_calendar_events
      SET project_id = ?, title = ?, description = ?, event_type = ?, scheduled_for = ?, due_time = ?, status = ?, priority = ?,
          vendor_name = ?,
          completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, datetime('now')) ELSE completed_at END,
          completion_note = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      nextProjectId,
      title,
      req.body.description !== undefined ? String(req.body.description || '').slice(0, 1000) : event.description,
      eventType,
      scheduledFor,
      req.body.due_time !== undefined ? String(req.body.due_time || '').slice(0, 20) || null : event.due_time,
      status,
      req.body.priority !== undefined && PRIORITIES.has(String(req.body.priority)) ? String(req.body.priority) : event.priority,
      vendorName,
      status,
      completionNote || null,
      req.params.id
    );

    logActivity({
      userId: req.user.id,
      projectId: nextProjectId,
      action: status === 'completed' ? 'calendar_event_completed' : 'calendar_event_updated',
      entityType: 'operations_calendar_event',
      entityId: req.params.id,
      details: { title, status, completion_note_added: Boolean(completionNote) },
    });

    res.json({ message: 'Calendar event updated' });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to update calendar event' });
  }
});

router.delete('/events/:id', (req, res) => {
  try {
    const db = getDb();
    if (String(req.params.id || '').startsWith('task-')) {
      return res.status(400).json({ error: 'Construction tasks cannot be deleted from the operations calendar' });
    }

    const event = db.prepare('SELECT * FROM operations_calendar_events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Calendar event not found' });
    assertProjectAccess(db, req.user, event.project_id);

    const deleteCalendarEvent = db.transaction(() => {
      db.prepare('DELETE FROM calendar_email_reminders WHERE event_id = ?').run(event.id);
      db.prepare('DELETE FROM operations_calendar_events WHERE id = ?').run(event.id);
    });
    deleteCalendarEvent();

    logActivity({
      userId: req.user.id,
      projectId: event.project_id,
      action: 'calendar_event_deleted',
      entityType: 'operations_calendar_event',
      entityId: event.id,
      details: { title: event.title, scheduled_for: event.scheduled_for, event_type: event.event_type },
    });

    res.json({ message: 'Calendar event deleted' });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to delete calendar event' });
  }
});

module.exports = router;
