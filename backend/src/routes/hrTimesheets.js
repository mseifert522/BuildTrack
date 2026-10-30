/**
 * HR > Timesheets. Field workers enter the days and hours they work through a private
 * link that a manager copies, texts or emails from BuildTrack. The manager sets up the
 * worker, hourly rate, pay method (cash / payroll / check / other) and pay period; this
 * module computes hours pay, weekly overtime, extras (gas money, lunch, ...) and gross
 * for both screens so the phone and the office always show the same numbers.
 *
 * createManagerRouter() is mounted inside routes/humanResources.js, so it inherits the
 * HR login, roles and the project-manager read-only rule. publicRouter is the link's API
 * and needs no login: the link token is the only credential, and it only ever reaches
 * that one worker's own timesheet.
 */
const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const { getDb } = require('../db/schema');
const { UPPER_MANAGEMENT_ROLES } = require('../middleware/auth');
const { getClientIp, logDataAccess } = require('../utils/dataAccessAudit');
const { encryptJson, decryptJson } = require('../utils/secureFields');
const { isEmailConfigured, sendTimesheetLinkEmail } = require('../utils/email');
const { NUD_COMPANY } = require('../utils/companyInfo');

const TIME_ZONE = 'America/Detroit';
const PAY_METHODS = new Set(['cash', 'payroll', 'check', 'other']);
const PAY_FREQUENCIES = new Set(['weekly', 'biweekly', 'semimonthly', 'monthly']);
const EMPLOYMENT_TYPES = new Set(['full_time', 'part_time', 'seasonal', 'temporary', 'contractor']);
// Pay on top of hours. managerOnly types never come from the link.
const ADDON_TYPES = {
  gas: { label: 'Gas money' },
  mileage: { label: 'Mileage', perMile: true },
  lunch: { label: 'Lunch / meals' },
  per_diem: { label: 'Per diem' },
  tools: { label: 'Tools / equipment' },
  materials: { label: 'Materials / supplies' },
  parking_tolls: { label: 'Parking / tolls' },
  phone: { label: 'Phone / data' },
  bonus: { label: 'Bonus', managerOnly: true },
  other: { label: 'Other' },
};
const OVERTIME_AFTER_WEEKLY_HOURS = 40;
const OVERTIME_MULTIPLIER = 1.5;
const MAX_ADDONS_PER_DAY = 12;
const MAX_ADDON_CENTS = 500000;
const MAX_MILES_PER_DAY = 2000;
const MAX_STATUS_RANGE_DAYS = 62;
// How far back the link can look. It can only change the current and previous period.
const LINK_HISTORY_DAYS = 400;
const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function text(value, maxLength) {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function numberIn(value, field, min, max) {
  if (value === '' || value === null || value === undefined) throw httpError(400, `Enter the ${field}.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw httpError(400, `Invalid ${field}.`);
  return parsed;
}

const round2 = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// ── dates (plain YYYY-MM-DD strings; noon UTC keeps DST out of the arithmetic) ──

function parseDay(value) {
  return new Date(`${value}T12:00:00Z`);
}

function formatDay(date) {
  return date.toISOString().slice(0, 10);
}

function isDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parseDay(value).getTime()) && formatDay(parseDay(value)) === value;
}

function dayValue(value, field) {
  const normalized = String(value ?? '').trim();
  if (!isDay(normalized)) throw httpError(400, `Invalid ${field}.`);
  return normalized;
}

function addDays(value, days) {
  const date = parseDay(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDay(date);
}

function daysBetween(from, to) {
  return Math.round((parseDay(to) - parseDay(from)) / 86400000);
}

function weekdayOf(value) {
  return parseDay(value).getUTCDay();
}

function todayEastern() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function mondayOf(value) {
  return addDays(value, -((weekdayOf(value) + 6) % 7));
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The pay period containing `date`. Weekly and biweekly periods line up with the anchor date. */
function payPeriodFor(frequency, anchor, date) {
  if (frequency === 'semimonthly' || frequency === 'monthly') {
    const [year, month, day] = date.split('-').map(Number);
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    const last = `${prefix}-${String(lastDayOfMonth(year, month)).padStart(2, '0')}`;
    if (frequency === 'monthly') return { start: `${prefix}-01`, end: last };
    return day <= 15 ? { start: `${prefix}-01`, end: `${prefix}-15` } : { start: `${prefix}-16`, end: last };
  }
  const length = frequency === 'biweekly' ? 14 : 7;
  const index = Math.floor(daysBetween(anchor, date) / length);
  const start = addDays(anchor, index * length);
  return { start, end: addDays(start, length - 1) };
}

/** Overtime is counted per workweek: it starts on the anchor's weekday for weekly/biweekly pay, else Monday. */
function workweekStartDay(frequency, anchor) {
  return frequency === 'weekly' || frequency === 'biweekly' ? weekdayOf(anchor) : 1;
}

function workweekStartFor(frequency, anchor, date) {
  const back = (weekdayOf(date) - workweekStartDay(frequency, anchor) + 7) % 7;
  return addDays(date, -back);
}

// ── day input ────────────────────────────────────────────────────────────────

function timeValue(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(normalized);
  if (!match) throw httpError(400, `Invalid ${field}.`);
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function minutesOf(hhmm) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Extras for one day. From the link, manager-only types (bonus) are dropped here and the
 * day's existing ones are carried over by saveDay, so a worker can never add or remove them.
 */
function normalizeAddons(value, { manager, mileageRateCents }) {
  if (value === null || value === undefined || value === '') return [];
  if (!Array.isArray(value)) throw httpError(400, 'Invalid extras.');
  if (value.length > MAX_ADDONS_PER_DAY) throw httpError(400, `You can add up to ${MAX_ADDONS_PER_DAY} extras per day.`);
  const addons = [];
  for (const item of value) {
    const type = String(item?.type ?? '').trim();
    const definition = ADDON_TYPES[type];
    if (!definition) throw httpError(400, 'Choose what each extra is for.');
    if (definition.managerOnly && !manager) continue;
    let quantity = null;
    let amountCents;
    if (definition.perMile) {
      quantity = round2(numberIn(item.quantity, 'miles driven', 0.01, MAX_MILES_PER_DAY));
      amountCents = Math.round(quantity * mileageRateCents);
    } else {
      amountCents = Math.round(numberIn(item.amount, `${definition.label.toLowerCase()} amount`, 0.01, MAX_ADDON_CENTS / 100) * 100);
    }
    if (amountCents > MAX_ADDON_CENTS) throw httpError(400, `${definition.label} cannot be more than $${MAX_ADDON_CENTS / 100}.`);
    addons.push({ addon_type: type, quantity, amount_cents: amountCents, note: text(item.note, 200) });
  }
  return addons;
}

/** Hours come from start/end minus the lunch break, or are entered directly. */
function normalizeDay(body, { manager, mileageRateCents }) {
  const startTime = timeValue(body?.start_time, 'start time');
  const endTime = timeValue(body?.end_time, 'end time');
  let breakMinutes = 0;
  let hours;
  if (startTime || endTime) {
    if (!startTime || !endTime) throw httpError(400, 'Enter both a start time and an end time, or just the total hours.');
    breakMinutes = Math.round(numberIn(body.break_minutes ?? 0, 'lunch break', 0, 720));
    let span = minutesOf(endTime) - minutesOf(startTime);
    if (span === 0) throw httpError(400, 'The end time must be after the start time.');
    if (span < 0) span += 24 * 60; // the shift ran past midnight
    if (breakMinutes >= span) throw httpError(400, 'The lunch break is longer than the time worked.');
    hours = round2((span - breakMinutes) / 60);
  } else {
    hours = round2(numberIn(body?.hours ?? 0, 'hours worked', 0, 24));
  }
  const addons = normalizeAddons(body?.addons, { manager, mileageRateCents });
  if (hours <= 0 && !addons.length) throw httpError(400, 'Enter the hours you worked.');
  return {
    start_time: startTime,
    end_time: endTime,
    break_minutes: breakMinutes,
    hours,
    job_site: text(body?.job_site, 200),
    notes: text(body?.notes, 1000),
    addons,
  };
}

// ── pay math ─────────────────────────────────────────────────────────────────

function serializeAddon(row) {
  return {
    type: row.addon_type,
    label: ADDON_TYPES[row.addon_type]?.label || 'Other',
    quantity: row.quantity,
    amount_cents: row.amount_cents,
    note: row.note,
  };
}

/**
 * One pay period, every day listed (worked or not). Entries from earlier in the first
 * workweek are read too, so weekly overtime is right when a period starts mid-week.
 * Open days use the worker's current rate and pay method; approved/paid days are frozen.
 */
function buildPeriod(db, employee, settings, start, end) {
  const frequency = employee.pay_frequency;
  const anchor = settings.period_anchor_date;
  const contextStart = workweekStartFor(frequency, anchor, start);
  const rows = db.prepare(`
    SELECT * FROM hr_timesheet_entries
    WHERE employee_id = ? AND work_date BETWEEN ? AND ?
    ORDER BY work_date
  `).all(employee.id, contextStart, end);
  const periodIds = rows.filter(row => row.work_date >= start).map(row => row.id);
  const addonsByEntry = new Map();
  if (periodIds.length) {
    const addonRows = db.prepare(`
      SELECT * FROM hr_timesheet_addons
      WHERE entry_id IN (${periodIds.map(() => '?').join(',')})
      ORDER BY rowid
    `).all(...periodIds);
    for (const addon of addonRows) {
      if (!addonsByEntry.has(addon.entry_id)) addonsByEntry.set(addon.entry_id, []);
      addonsByEntry.get(addon.entry_id).push(serializeAddon(addon));
    }
  }

  const hourly = employee.pay_type === 'hourly';
  const overtimeOn = hourly && Boolean(settings.overtime_enabled);
  const weekStartDay = workweekStartDay(frequency, anchor);
  const rowByDate = new Map(rows.map(row => [row.work_date, row]));
  const totals = {
    days_worked: 0,
    hours: 0,
    regular_hours: 0,
    overtime_hours: 0,
    regular_cents: 0,
    overtime_cents: 0,
    wages_cents: 0,
    addons_cents: 0,
    gross_cents: 0,
    open_days: 0,
    approved_days: 0,
    paid_days: 0,
  };
  const addonTotals = new Map();
  const days = [];
  let weekHours = 0;
  for (let date = contextStart; date <= end; date = addDays(date, 1)) {
    if (weekdayOf(date) === weekStartDay) weekHours = 0;
    const row = rowByDate.get(date);
    const before = weekHours;
    weekHours = round2(weekHours + (row ? row.hours : 0));
    if (date < start) continue;
    if (!row) {
      days.push({ date, hours_before_in_week: before, entry: null });
      continue;
    }
    const regular = overtimeOn ? round2(Math.min(row.hours, Math.max(0, OVERTIME_AFTER_WEEKLY_HOURS - before))) : row.hours;
    const overtime = round2(row.hours - regular);
    const rate = row.hourly_rate_cents ?? (hourly ? employee.pay_rate_cents : 0);
    const regularCents = Math.round(regular * rate);
    const overtimeCents = Math.round(overtime * rate * OVERTIME_MULTIPLIER);
    const addons = addonsByEntry.get(row.id) || [];
    const addonsCents = addons.reduce((sum, addon) => sum + addon.amount_cents, 0);
    const entry = {
      id: row.id,
      work_date: row.work_date,
      start_time: row.start_time,
      end_time: row.end_time,
      break_minutes: row.break_minutes,
      hours: row.hours,
      job_site: row.job_site,
      notes: row.notes,
      status: row.status,
      regular_hours: regular,
      overtime_hours: overtime,
      hourly_rate_cents: rate,
      regular_cents: regularCents,
      overtime_cents: overtimeCents,
      wages_cents: regularCents + overtimeCents,
      addons,
      addons_cents: addonsCents,
      gross_cents: regularCents + overtimeCents + addonsCents,
      pay_method: row.pay_method || settings.pay_method,
      entered_via: row.entered_via,
      updated_via: row.updated_via,
      created_at: row.created_at,
      updated_at: row.updated_at,
      approved_at: row.approved_at,
      paid_at: row.paid_at,
    };
    days.push({ date, hours_before_in_week: before, entry });
    totals.days_worked += row.hours > 0 ? 1 : 0;
    totals.hours = round2(totals.hours + row.hours);
    totals.regular_hours = round2(totals.regular_hours + regular);
    totals.overtime_hours = round2(totals.overtime_hours + overtime);
    totals.regular_cents += regularCents;
    totals.overtime_cents += overtimeCents;
    totals.wages_cents += entry.wages_cents;
    totals.addons_cents += addonsCents;
    totals.gross_cents += entry.gross_cents;
    if (row.status === 'submitted') totals.open_days += 1;
    if (row.status === 'approved') totals.approved_days += 1;
    if (row.status === 'paid') totals.paid_days += 1;
    for (const addon of addons) {
      const current = addonTotals.get(addon.type) || { type: addon.type, label: addon.label, amount_cents: 0, quantity: 0 };
      current.amount_cents += addon.amount_cents;
      current.quantity = round2(current.quantity + (addon.quantity || 0));
      addonTotals.set(addon.type, current);
    }
  }

  return {
    period: {
      start,
      end,
      frequency,
      prev_start: payPeriodFor(frequency, anchor, addDays(start, -1)).start,
      next_start: payPeriodFor(frequency, anchor, addDays(end, 1)).start,
    },
    days,
    totals: { ...totals, addons_by_type: [...addonTotals.values()] },
    pay: {
      hourly,
      hourly_rate_cents: hourly ? employee.pay_rate_cents : null,
      pay_method: settings.pay_method,
      pay_frequency: frequency,
      overtime_enabled: overtimeOn,
      overtime_after_hours: OVERTIME_AFTER_WEEKLY_HOURS,
      overtime_multiplier: OVERTIME_MULTIPLIER,
      mileage_rate_cents: settings.mileage_rate_cents,
    },
  };
}

// ── storage ──────────────────────────────────────────────────────────────────

function recordEvent(db, req, { employeeId, entryId = null, action, actor, details = null }) {
  try {
    db.prepare(`
      INSERT INTO hr_timesheet_events (
        id, employee_id, entry_id, action, actor_type, user_id, ip_address, user_agent, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      employeeId,
      entryId,
      action,
      actor.type === 'link' ? 'link' : 'user',
      actor.userId || null,
      String(getClientIp(req) || '').slice(0, 80),
      String(req.headers['user-agent'] || '').slice(0, 300),
      details ? JSON.stringify(details) : null,
    );
  } catch (error) {
    console.error('[TIMESHEETS] Failed to record event:', error.message);
  }
}

function saveDay(db, req, { employee, date, input, actor }) {
  const existing = db.prepare('SELECT * FROM hr_timesheet_entries WHERE employee_id = ? AND work_date = ?').get(employee.id, date);
  if (existing?.status === 'paid') throw httpError(409, 'This day has been paid and can no longer be changed.');
  if (actor.type === 'link' && existing && existing.status !== 'submitted') {
    throw httpError(409, 'The office has already approved this day. Call the office if something needs to change.');
  }
  const via = actor.type === 'link' ? 'link' : 'manager';
  let addons = input.addons;
  if (actor.type === 'link' && existing) {
    const kept = db.prepare('SELECT * FROM hr_timesheet_addons WHERE entry_id = ? ORDER BY rowid').all(existing.id)
      .filter(addon => ADDON_TYPES[addon.addon_type]?.managerOnly);
    addons = [...addons, ...kept.map(addon => ({ addon_type: addon.addon_type, quantity: addon.quantity, amount_cents: addon.amount_cents, note: addon.note }))];
  }
  const entryId = existing?.id || uuidv4();
  db.transaction(() => {
    if (existing) {
      db.prepare(`
        UPDATE hr_timesheet_entries
        SET start_time = ?, end_time = ?, break_minutes = ?, hours = ?, job_site = ?, notes = ?,
            updated_via = ?, updated_by = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(input.start_time, input.end_time, input.break_minutes, input.hours, input.job_site, input.notes, via, actor.userId || null, entryId);
    } else {
      db.prepare(`
        INSERT INTO hr_timesheet_entries (
          id, employee_id, work_date, start_time, end_time, break_minutes, hours, job_site, notes,
          status, entered_via, updated_via, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?)
      `).run(
        entryId, employee.id, date, input.start_time, input.end_time, input.break_minutes, input.hours,
        input.job_site, input.notes, via, via, actor.userId || null, actor.userId || null,
      );
    }
    db.prepare('DELETE FROM hr_timesheet_addons WHERE entry_id = ?').run(entryId);
    const insertAddon = db.prepare(`
      INSERT INTO hr_timesheet_addons (id, entry_id, addon_type, quantity, amount_cents, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const addon of addons) {
      insertAddon.run(uuidv4(), entryId, addon.addon_type, addon.quantity, addon.amount_cents, addon.note);
    }
  })();
  recordEvent(db, req, {
    employeeId: employee.id,
    entryId,
    action: existing ? 'day_updated' : 'day_added',
    actor,
    details: { work_date: date, hours: input.hours, extras_cents: addons.reduce((sum, addon) => sum + addon.amount_cents, 0) },
  });
  return entryId;
}

function deleteDay(db, req, { employee, date, actor }) {
  const existing = db.prepare('SELECT * FROM hr_timesheet_entries WHERE employee_id = ? AND work_date = ?').get(employee.id, date);
  if (!existing) throw httpError(404, 'There are no hours saved for that day.');
  if (existing.status === 'paid') throw httpError(409, 'This day has been paid and can no longer be changed.');
  if (actor.type === 'link' && existing.status !== 'submitted') {
    throw httpError(409, 'The office has already approved this day. Call the office if something needs to change.');
  }
  db.prepare('DELETE FROM hr_timesheet_entries WHERE id = ?').run(existing.id);
  recordEvent(db, req, {
    employeeId: employee.id,
    entryId: existing.id,
    action: 'day_removed',
    actor,
    details: { work_date: date, hours: existing.hours },
  });
}

// ── the private link ─────────────────────────────────────────────────────────

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function appBaseUrl() {
  return String(process.env.APP_URL || 'https://buildtrack.newurbandev.com').replace(/\/+$/, '');
}

function linkUrl(token) {
  return `${appBaseUrl()}/timesheet/${token}`;
}

function issueLink(db, employeeId, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(`
    UPDATE hr_timesheet_workers
    SET link_token_hash = ?, link_token_enc = ?, link_created_at = datetime('now'), link_created_by = ?,
        link_last_opened_at = NULL, updated_at = datetime('now')
    WHERE employee_id = ?
  `).run(hashToken(token), encryptJson({ token }), userId, employeeId);
  return token;
}

/** The current link's token, or null when there is none (or it was sealed with an older key). */
function revealLink(settings) {
  if (!settings?.link_token_hash || !settings.link_token_enc) return null;
  try {
    const { token } = decryptJson(settings.link_token_enc);
    return hashToken(token) === settings.link_token_hash ? token : null;
  } catch (_) {
    return null;
  }
}

function normalizeUsPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function displayPhone(e164) {
  const digits = String(e164 || '').replace(/\D/g, '').slice(-10);
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : String(e164 || '');
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200 ? email : null;
}

function textingConfigured() {
  return Boolean(String(process.env.SCP_SMS_URL || '').trim() && String(process.env.SCP_SMS_TOKEN || '').trim());
}

/** Sends through the SCP SMS Gateway (sms.seifertcapital.com), BuildTrack's own number. */
async function sendTextThroughGateway(to, body) {
  if (!textingConfigured()) {
    throw httpError(503, 'Texting is not set up on BuildTrack yet. Copy the link and text it from your phone instead.');
  }
  const base = String(process.env.SCP_SMS_URL).trim().replace(/\/+$/, '');
  let response;
  let payload = {};
  try {
    response = await fetch(`${base}/v1/messages/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${String(process.env.SCP_SMS_TOKEN).trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, text: body }),
      signal: AbortSignal.timeout(15000),
    });
    payload = await response.json().catch(() => ({}));
  } catch (error) {
    console.error('[TIMESHEETS] Text gateway unreachable:', error.message);
    throw httpError(502, 'The texting service did not answer. Copy the link and text it from your phone instead.');
  }
  if (!response.ok) {
    const code = payload?.error?.code || '';
    console.error('[TIMESHEETS] Text gateway refused the message:', response.status, code);
    // Never pass a 401 through: the BuildTrack app treats any 401 as "signed out".
    if (code === 'invalid_to' || code === 'invalid_phone') throw httpError(400, 'That phone number was not accepted. Check it and try again.');
    if (code === 'recipient_opted_out') {
      throw httpError(409, 'That phone has opted out of texts from our number (they replied STOP). They can text START to our number, or email the link instead.');
    }
    throw httpError(502, `The text was not sent (${code || `error ${response.status}`}). Copy the link and text it from your phone instead.`);
  }
  return { message_id: payload.message_id || null, status: payload.status || 'accepted' };
}

// ── shapes ───────────────────────────────────────────────────────────────────

function managerWorker(employee, settings) {
  return {
    id: employee.id,
    first_name: employee.first_name,
    last_name: employee.last_name,
    preferred_name: employee.preferred_name,
    name: [employee.first_name, employee.last_name].filter(Boolean).join(' '),
    phone: employee.phone,
    email: employee.work_email || employee.personal_email,
    job_title: employee.job_title,
    employment_status: employee.employment_status,
    classification: employee.classification,
    pay_type: employee.pay_type,
    hourly_rate_cents: employee.pay_rate_cents,
    pay_frequency: employee.pay_frequency,
    pay_method: settings.pay_method,
    period_anchor_date: settings.period_anchor_date,
    overtime_enabled: Boolean(settings.overtime_enabled),
    mileage_rate_cents: settings.mileage_rate_cents,
    link: {
      active: Boolean(settings.link_token_hash),
      created_at: settings.link_created_at,
      last_opened_at: settings.link_last_opened_at,
      last_sent_at: settings.link_last_sent_at,
      last_sent_via: settings.link_last_sent_via,
    },
  };
}

function addonTypeList({ manager }) {
  return Object.entries(ADDON_TYPES)
    .filter(([, definition]) => manager || !definition.managerOnly)
    .map(([type, definition]) => ({ type, label: definition.label, per_mile: Boolean(definition.perMile), manager_only: Boolean(definition.managerOnly) }));
}

function loadWorker(db, employeeId) {
  const employee = db.prepare('SELECT * FROM hr_employees WHERE id = ?').get(String(employeeId || ''));
  if (!employee) throw httpError(404, 'Employee not found.');
  const settings = db.prepare('SELECT * FROM hr_timesheet_workers WHERE employee_id = ?').get(employee.id);
  if (!settings) throw httpError(404, 'This employee is not set up for timesheets yet.');
  return { employee, settings };
}

function requireLinkManager(req, _res, next) {
  if (!UPPER_MANAGEMENT_ROLES.includes(req.user?.role)) {
    return next(httpError(403, 'Only operations managers and super admins can copy or send timesheet links.'));
  }
  return next();
}

function timesheetErrorHandler(label) {
  // eslint-disable-next-line no-unused-vars
  return (error, _req, res, _next) => {
    const status = error.statusCode || 500;
    if (!error.statusCode) console.error(`[TIMESHEETS] ${label} request failed:`, error);
    res.status(status).json({ error: error.statusCode ? error.message : 'Something went wrong. Please try again.' });
  };
}

// ── manager API (/api/human-resources/timesheets) ────────────────────────────

function createManagerRouter({ seedComplianceTasks, auditMutation }) {
  const router = express.Router();

  function audit(req, action, employeeId, details) {
    auditMutation(req, action, 'hr_timesheet', employeeId, details);
  }

  function periodResponse(db, employee, settings, start) {
    const today = todayEastern();
    const period = payPeriodFor(employee.pay_frequency, settings.period_anchor_date, start || today);
    const data = buildPeriod(db, employee, settings, period.start, period.end);
    const events = db.prepare(`
      SELECT ev.id, ev.action, ev.actor_type, ev.ip_address, ev.user_agent, ev.details, ev.created_at, u.name AS user_name
      FROM hr_timesheet_events ev
      LEFT JOIN users u ON u.id = ev.user_id
      WHERE ev.employee_id = ?
      ORDER BY datetime(ev.created_at) DESC, ev.rowid DESC
      LIMIT 25
    `).all(employee.id).map(event => {
      let details = null;
      try { details = event.details ? JSON.parse(event.details) : null; } catch (_) { details = null; }
      return { ...event, details };
    });
    return {
      ...data,
      today,
      worker: managerWorker(employee, settings),
      events,
      addon_types: addonTypeList({ manager: true }),
    };
  }

  router.get('/workers', (req, res, next) => {
    try {
      const db = getDb();
      const today = todayEastern();
      const rows = db.prepare(`
        SELECT e.*, w.employee_id AS ts_employee_id
        FROM hr_employees e
        LEFT JOIN hr_timesheet_workers w ON w.employee_id = e.id
        WHERE e.employment_status != 'terminated' OR w.employee_id IS NOT NULL
        ORDER BY lower(e.first_name), lower(e.last_name)
      `).all();
      const workers = [];
      const otherEmployees = [];
      for (const employee of rows) {
        if (!employee.ts_employee_id) {
          otherEmployees.push({
            id: employee.id,
            name: [employee.first_name, employee.last_name].filter(Boolean).join(' '),
            job_title: employee.job_title,
            pay_type: employee.pay_type,
            hourly_rate_cents: employee.pay_rate_cents,
          });
          continue;
        }
        const settings = db.prepare('SELECT * FROM hr_timesheet_workers WHERE employee_id = ?').get(employee.id);
        const period = payPeriodFor(employee.pay_frequency, settings.period_anchor_date, today);
        const { totals } = buildPeriod(db, employee, settings, period.start, period.end);
        workers.push({
          ...managerWorker(employee, settings),
          current_period: { start: period.start, end: period.end, ...totals },
        });
      }
      logDataAccess(req, {
        action: 'hr_timesheet_workers_viewed',
        accessType: 'view',
        entityType: 'hr_timesheet',
        recordCount: workers.length,
        riskLevel: 'high',
      });
      res.json({
        workers,
        other_employees: otherEmployees,
        today,
        can_manage_links: UPPER_MANAGEMENT_ROLES.includes(req.user.role),
        texting_configured: textingConfigured(),
        email_configured: isEmailConfigured(),
        addon_types: addonTypeList({ manager: true }),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/workers', (req, res, next) => {
    try {
      const db = getDb();
      const body = req.body || {};
      const rateCents = Math.round(numberIn(body.hourly_rate, 'hourly rate', 0.01, 1000) * 100);
      const payMethod = PAY_METHODS.has(body.pay_method) ? body.pay_method : 'payroll';
      const payFrequency = PAY_FREQUENCIES.has(body.pay_frequency) ? body.pay_frequency : 'weekly';
      const anchor = body.period_anchor_date ? dayValue(body.period_anchor_date, 'pay period start') : mondayOf(todayEastern());
      const mileageCents = body.mileage_rate === undefined || body.mileage_rate === ''
        ? 70
        : Math.round(numberIn(body.mileage_rate, 'mileage rate', 0, 10) * 100);
      const phone = body.phone ? normalizeUsPhone(body.phone) : null;
      if (body.phone && !phone) throw httpError(400, 'Enter a 10-digit phone number.');
      const email = body.email ? normalizeEmail(body.email) : null;
      if (body.email && !email) throw httpError(400, 'Enter a valid email address.');

      let employeeId = text(body.employee_id, 80);
      let token;
      db.transaction(() => {
        if (employeeId) {
          const employee = db.prepare('SELECT * FROM hr_employees WHERE id = ?').get(employeeId);
          if (!employee) throw httpError(404, 'Employee not found.');
          if (db.prepare('SELECT 1 FROM hr_timesheet_workers WHERE employee_id = ?').get(employeeId)) {
            throw httpError(409, `${employee.first_name} is already on timesheets.`);
          }
          db.prepare(`
            UPDATE hr_employees
            SET pay_type = 'hourly', pay_rate_cents = ?, pay_frequency = ?,
                phone = COALESCE(?, phone), personal_email = COALESCE(personal_email, ?),
                updated_at = datetime('now')
            WHERE id = ?
          `).run(rateCents, payFrequency, phone ? displayPhone(phone) : null, email, employeeId);
        } else {
          const firstName = text(body.first_name, 100);
          if (!firstName) throw httpError(400, 'Enter the worker\'s first name.');
          employeeId = uuidv4();
          db.prepare(`
            INSERT INTO hr_employees (
              id, first_name, last_name, personal_email, phone, job_title, employment_status,
              employment_type, pay_type, pay_rate_cents, pay_frequency, created_by
            ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 'hourly', ?, ?, ?)
          `).run(
            employeeId,
            firstName,
            text(body.last_name, 100) || '',
            email,
            phone ? displayPhone(phone) : null,
            text(body.job_title, 160),
            EMPLOYMENT_TYPES.has(body.employment_type) ? body.employment_type : 'full_time',
            rateCents,
            payFrequency,
            req.user.id,
          );
          seedComplianceTasks(db, employeeId, null, req.user.id);
        }
        db.prepare(`
          INSERT INTO hr_timesheet_workers (
            employee_id, pay_method, period_anchor_date, overtime_enabled, mileage_rate_cents, created_by
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(employeeId, payMethod, anchor, body.overtime_enabled === false ? 0 : 1, mileageCents, req.user.id);
        token = issueLink(db, employeeId, req.user.id);
      })();

      const { employee, settings } = loadWorker(db, employeeId);
      recordEvent(db, req, { employeeId, action: 'worker_added', actor: { type: 'user', userId: req.user.id }, details: { pay_method: payMethod, hourly_rate_cents: rateCents } });
      audit(req, body.employee_id ? 'hr_timesheet_worker_added' : 'hr_timesheet_worker_created', employeeId, { pay_method: payMethod, pay_frequency: payFrequency });
      res.status(201).json({
        worker: managerWorker(employee, settings),
        link_url: UPPER_MANAGEMENT_ROLES.includes(req.user.role) ? linkUrl(token) : null,
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/workers/:employeeId', (req, res, next) => {
    try {
      const db = getDb();
      const { employee } = loadWorker(db, req.params.employeeId);
      const body = req.body || {};
      const employeeUpdates = [];
      const employeeParams = [];
      const settingsUpdates = [];
      const settingsParams = [];
      const has = key => Object.prototype.hasOwnProperty.call(body, key);

      if (has('first_name')) {
        const firstName = text(body.first_name, 100);
        if (!firstName) throw httpError(400, 'Enter the worker\'s first name.');
        employeeUpdates.push('first_name = ?'); employeeParams.push(firstName);
      }
      if (has('last_name')) { employeeUpdates.push('last_name = ?'); employeeParams.push(text(body.last_name, 100) || ''); }
      if (has('phone')) {
        const phone = body.phone ? normalizeUsPhone(body.phone) : null;
        if (body.phone && !phone) throw httpError(400, 'Enter a 10-digit phone number.');
        employeeUpdates.push('phone = ?'); employeeParams.push(phone ? displayPhone(phone) : null);
      }
      if (has('email')) {
        const email = body.email ? normalizeEmail(body.email) : null;
        if (body.email && !email) throw httpError(400, 'Enter a valid email address.');
        employeeUpdates.push(employee.work_email ? 'work_email = ?' : 'personal_email = ?'); employeeParams.push(email);
      }
      if (has('hourly_rate')) {
        employeeUpdates.push("pay_type = 'hourly'", 'pay_rate_cents = ?');
        employeeParams.push(Math.round(numberIn(body.hourly_rate, 'hourly rate', 0.01, 1000) * 100));
      }
      if (has('pay_frequency')) {
        if (!PAY_FREQUENCIES.has(body.pay_frequency)) throw httpError(400, 'Invalid pay period.');
        employeeUpdates.push('pay_frequency = ?'); employeeParams.push(body.pay_frequency);
      }
      if (has('pay_method')) {
        if (!PAY_METHODS.has(body.pay_method)) throw httpError(400, 'Invalid pay method.');
        settingsUpdates.push('pay_method = ?'); settingsParams.push(body.pay_method);
      }
      if (has('period_anchor_date')) { settingsUpdates.push('period_anchor_date = ?'); settingsParams.push(dayValue(body.period_anchor_date, 'pay period start')); }
      if (has('overtime_enabled')) { settingsUpdates.push('overtime_enabled = ?'); settingsParams.push(body.overtime_enabled ? 1 : 0); }
      if (has('mileage_rate')) {
        settingsUpdates.push('mileage_rate_cents = ?');
        settingsParams.push(Math.round(numberIn(body.mileage_rate, 'mileage rate', 0, 10) * 100));
      }

      db.transaction(() => {
        if (employeeUpdates.length) {
          db.prepare(`UPDATE hr_employees SET ${employeeUpdates.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...employeeParams, employee.id);
        }
        if (settingsUpdates.length) {
          db.prepare(`UPDATE hr_timesheet_workers SET ${settingsUpdates.join(', ')}, updated_at = datetime('now') WHERE employee_id = ?`).run(...settingsParams, employee.id);
        }
      })();
      const changed = Object.keys(body).filter(key => [
        'first_name', 'last_name', 'phone', 'email', 'hourly_rate', 'pay_frequency', 'pay_method',
        'period_anchor_date', 'overtime_enabled', 'mileage_rate',
      ].includes(key));
      recordEvent(db, req, { employeeId: employee.id, action: 'settings_updated', actor: { type: 'user', userId: req.user.id }, details: { changed } });
      audit(req, 'hr_timesheet_settings_updated', employee.id, { changed });
      const fresh = loadWorker(db, employee.id);
      res.json({ worker: managerWorker(fresh.employee, fresh.settings) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/workers/:employeeId/period', (req, res, next) => {
    try {
      const db = getDb();
      const { employee, settings } = loadWorker(db, req.params.employeeId);
      const start = req.query.start ? dayValue(req.query.start, 'pay period') : null;
      const payload = periodResponse(db, employee, settings, start);
      logDataAccess(req, {
        action: 'hr_timesheet_viewed',
        accessType: 'view',
        entityType: 'hr_timesheet',
        entityId: employee.id,
        recordCount: payload.days.filter(day => day.entry).length,
        riskLevel: 'high',
        details: { start: payload.period.start, end: payload.period.end },
      });
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.put('/workers/:employeeId/days/:date', (req, res, next) => {
    try {
      const db = getDb();
      const { employee, settings } = loadWorker(db, req.params.employeeId);
      const date = dayValue(req.params.date, 'date');
      if (date > todayEastern()) throw httpError(400, 'Hours cannot be entered for a future day.');
      const input = normalizeDay(req.body, { manager: true, mileageRateCents: settings.mileage_rate_cents });
      saveDay(db, req, { employee, date, input, actor: { type: 'manager', userId: req.user.id } });
      audit(req, 'hr_timesheet_day_saved', employee.id, { work_date: date, hours: input.hours });
      res.json(periodResponse(db, employee, settings, date));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/workers/:employeeId/days/:date', (req, res, next) => {
    try {
      const db = getDb();
      const { employee, settings } = loadWorker(db, req.params.employeeId);
      const date = dayValue(req.params.date, 'date');
      deleteDay(db, req, { employee, date, actor: { type: 'manager', userId: req.user.id } });
      audit(req, 'hr_timesheet_day_removed', employee.id, { work_date: date });
      res.json(periodResponse(db, employee, settings, date));
    } catch (error) {
      next(error);
    }
  });

  // Approve a period (freezes rate + pay method), mark it paid, or undo either.
  router.post('/workers/:employeeId/period/status', (req, res, next) => {
    try {
      const db = getDb();
      const { employee, settings } = loadWorker(db, req.params.employeeId);
      const start = dayValue(req.body?.start, 'start date');
      const end = dayValue(req.body?.end, 'end date');
      if (end < start || daysBetween(start, end) > MAX_STATUS_RANGE_DAYS) throw httpError(400, 'Invalid pay period.');
      const action = String(req.body?.action || '');
      const rate = employee.pay_type === 'hourly' ? employee.pay_rate_cents : 0;
      const range = [employee.id, start, end];
      let result;
      if (action === 'approve') {
        result = db.prepare(`
          UPDATE hr_timesheet_entries
          SET status = 'approved', hourly_rate_cents = COALESCE(hourly_rate_cents, ?), pay_method = COALESCE(pay_method, ?),
              approved_at = datetime('now'), approved_by = ?, updated_at = datetime('now')
          WHERE employee_id = ? AND work_date BETWEEN ? AND ? AND status = 'submitted'
        `).run(rate, settings.pay_method, req.user.id, ...range);
      } else if (action === 'paid') {
        result = db.prepare(`
          UPDATE hr_timesheet_entries
          SET status = 'paid', hourly_rate_cents = COALESCE(hourly_rate_cents, ?), pay_method = COALESCE(pay_method, ?),
              approved_at = COALESCE(approved_at, datetime('now')), approved_by = COALESCE(approved_by, ?),
              paid_at = datetime('now'), paid_by = ?, updated_at = datetime('now')
          WHERE employee_id = ? AND work_date BETWEEN ? AND ? AND status IN ('submitted', 'approved')
        `).run(rate, settings.pay_method, req.user.id, req.user.id, ...range);
      } else if (action === 'reopen') {
        result = db.prepare(`
          UPDATE hr_timesheet_entries
          SET status = 'submitted', hourly_rate_cents = NULL, pay_method = NULL, approved_at = NULL, approved_by = NULL,
              updated_at = datetime('now')
          WHERE employee_id = ? AND work_date BETWEEN ? AND ? AND status = 'approved'
        `).run(...range);
      } else if (action === 'unpay') {
        result = db.prepare(`
          UPDATE hr_timesheet_entries
          SET status = 'approved', paid_at = NULL, paid_by = NULL, updated_at = datetime('now')
          WHERE employee_id = ? AND work_date BETWEEN ? AND ? AND status = 'paid'
        `).run(...range);
      } else {
        throw httpError(400, 'Invalid action.');
      }
      recordEvent(db, req, { employeeId: employee.id, action: `period_${action}`, actor: { type: 'user', userId: req.user.id }, details: { start, end, days: result.changes } });
      audit(req, `hr_timesheet_period_${action}`, employee.id, { start, end, days: result.changes });
      res.json({ changed: result.changes, ...periodResponse(db, employee, settings, start) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/workers/:employeeId/link', requireLinkManager, (req, res, next) => {
    try {
      const db = getDb();
      const { employee, settings } = loadWorker(db, req.params.employeeId);
      const token = revealLink(settings);
      logDataAccess(req, {
        action: 'hr_timesheet_link_viewed',
        accessType: 'view',
        entityType: 'hr_timesheet',
        entityId: employee.id,
        recordCount: token ? 1 : 0,
        riskLevel: 'high',
      });
      res.json({ url: token ? linkUrl(token) : null, link: managerWorker(employee, settings).link });
    } catch (error) {
      next(error);
    }
  });

  // Creates the link, or replaces it with { rotate: true } (the old link stops working).
  router.post('/workers/:employeeId/link', requireLinkManager, (req, res, next) => {
    try {
      const db = getDb();
      const { employee, settings } = loadWorker(db, req.params.employeeId);
      let token = req.body?.rotate ? null : revealLink(settings);
      const created = !token;
      if (created) token = issueLink(db, employee.id, req.user.id);
      if (created) {
        recordEvent(db, req, { employeeId: employee.id, action: settings.link_token_hash ? 'link_replaced' : 'link_created', actor: { type: 'user', userId: req.user.id } });
        audit(req, settings.link_token_hash ? 'hr_timesheet_link_replaced' : 'hr_timesheet_link_created', employee.id);
      }
      const fresh = loadWorker(db, employee.id);
      res.json({ url: linkUrl(token), created, link: managerWorker(fresh.employee, fresh.settings).link });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/workers/:employeeId/link', requireLinkManager, (req, res, next) => {
    try {
      const db = getDb();
      const { employee } = loadWorker(db, req.params.employeeId);
      db.prepare(`
        UPDATE hr_timesheet_workers
        SET link_token_hash = NULL, link_token_enc = NULL, updated_at = datetime('now')
        WHERE employee_id = ?
      `).run(employee.id);
      recordEvent(db, req, { employeeId: employee.id, action: 'link_turned_off', actor: { type: 'user', userId: req.user.id } });
      audit(req, 'hr_timesheet_link_turned_off', employee.id);
      const fresh = loadWorker(db, employee.id);
      res.json({ link: managerWorker(fresh.employee, fresh.settings).link });
    } catch (error) {
      next(error);
    }
  });

  router.post('/workers/:employeeId/link/send', requireLinkManager, async (req, res, next) => {
    try {
      const db = getDb();
      const { employee, settings } = loadWorker(db, req.params.employeeId);
      if (employee.employment_status === 'terminated') throw httpError(409, 'This employee is marked terminated, so the link is off.');
      const channel = req.body?.channel === 'email' ? 'email' : req.body?.channel === 'sms' ? 'sms' : null;
      if (!channel) throw httpError(400, 'Choose text or email.');
      let token = revealLink(settings);
      if (!token) {
        token = issueLink(db, employee.id, req.user.id);
        recordEvent(db, req, { employeeId: employee.id, action: settings.link_token_hash ? 'link_replaced' : 'link_created', actor: { type: 'user', userId: req.user.id } });
      }
      const url = linkUrl(token);
      const firstName = employee.preferred_name || employee.first_name;
      let sentTo;
      let delivery = {};
      if (channel === 'sms') {
        const phone = normalizeUsPhone(req.body?.to || employee.phone);
        if (!phone) throw httpError(400, 'Enter a 10-digit mobile number to text the link to.');
        const message = `New Urban Development: Hi ${firstName}, here is your personal timesheet link. Open it to enter the days and hours you work: ${url} This link is only for you, please don't share it.`;
        delivery = await sendTextThroughGateway(phone, message);
        sentTo = displayPhone(phone);
        db.prepare("UPDATE hr_employees SET phone = COALESCE(NULLIF(phone, ''), ?), updated_at = datetime('now') WHERE id = ?").run(sentTo, employee.id);
      } else {
        const email = normalizeEmail(req.body?.to || employee.work_email || employee.personal_email);
        if (!email) throw httpError(400, 'Enter an email address to send the link to.');
        // The mock transporter "succeeds" when SMTP is not configured, so check first.
        if (!isEmailConfigured()) throw httpError(503, 'Email is not set up on BuildTrack. Copy the link and send it yourself instead.');
        try {
          await sendTimesheetLinkEmail({ name: firstName, email, timesheetUrl: url });
        } catch (error) {
          console.error('[TIMESHEETS] Link email failed:', error.message);
          throw httpError(502, 'The email did not go out. Copy the link and send it yourself instead.');
        }
        sentTo = email;
        if (!employee.work_email) {
          db.prepare("UPDATE hr_employees SET personal_email = COALESCE(NULLIF(personal_email, ''), ?), updated_at = datetime('now') WHERE id = ?").run(email, employee.id);
        }
      }
      db.prepare(`
        UPDATE hr_timesheet_workers
        SET link_last_sent_at = datetime('now'), link_last_sent_via = ?, updated_at = datetime('now')
        WHERE employee_id = ?
      `).run(channel, employee.id);
      recordEvent(db, req, { employeeId: employee.id, action: `link_sent_${channel}`, actor: { type: 'user', userId: req.user.id }, details: { to: sentTo, ...delivery } });
      audit(req, `hr_timesheet_link_sent_${channel}`, employee.id, { to: sentTo });
      const fresh = loadWorker(db, employee.id);
      res.json({ sent: true, channel, to: sentTo, delivery, url, worker: managerWorker(fresh.employee, fresh.settings) });
    } catch (error) {
      next(error);
    }
  });

  router.use(timesheetErrorHandler('Manager'));
  return router;
}

// ── public link API (/api/timesheet-link/:token) ─────────────────────────────

// In-process attempt counters (single container; same pattern as routes/vendorSetup.js).
const attemptBuckets = new Map();
function countHit(key, windowMs) {
  const now = Date.now();
  const record = attemptBuckets.get(key);
  if (!record || now - record.first > windowMs) {
    attemptBuckets.set(key, { count: 1, first: now });
    return 1;
  }
  record.count += 1;
  return record.count;
}
function currentCount(key, windowMs) {
  const record = attemptBuckets.get(key);
  return record && Date.now() - record.first <= windowMs ? record.count : 0;
}
const attemptSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, record] of attemptBuckets) {
    if (now - record.first > 2 * 60 * 60 * 1000) attemptBuckets.delete(key);
  }
}, 10 * 60 * 1000);
if (attemptSweep.unref) attemptSweep.unref();

const MISS_WINDOW_MS = 10 * 60 * 1000;
const MAX_MISSES = 20;

function limitByIp(name, max, windowMs) {
  return (req, res, next) => {
    const ip = getClientIp(req) || 'unknown';
    if (currentCount(`ts-miss:${ip}`, MISS_WINDOW_MS) >= MAX_MISSES || countHit(`${name}:${ip}`, windowMs) > max) {
      return res.status(429).json({ error: 'Too many tries. Please wait a few minutes and try again.' });
    }
    return next();
  };
}

function workerFromLink(req) {
  const token = String(req.params.token || '');
  const db = getDb();
  const settings = LINK_TOKEN_PATTERN.test(token)
    ? db.prepare('SELECT * FROM hr_timesheet_workers WHERE link_token_hash = ?').get(hashToken(token))
    : null;
  const employee = settings ? db.prepare('SELECT * FROM hr_employees WHERE id = ?').get(settings.employee_id) : null;
  if (!settings || !employee || employee.employment_status === 'terminated') {
    countHit(`ts-miss:${getClientIp(req) || 'unknown'}`, MISS_WINDOW_MS);
    throw httpError(404, 'This timesheet link is not active. Please ask the office for a new link.');
  }
  return { db, employee, settings };
}

/** The current period and the one before it are open to the worker; older ones are view-only. */
function linkWindow(employee, settings) {
  const today = todayEastern();
  const current = payPeriodFor(employee.pay_frequency, settings.period_anchor_date, today);
  const editableFrom = payPeriodFor(employee.pay_frequency, settings.period_anchor_date, addDays(current.start, -1)).start;
  return { today, current, editableFrom, oldestDay: addDays(today, -LINK_HISTORY_DAYS) };
}

/** Only this worker's own name, pay settings and days. Nothing about anyone else. */
function linkPayload(db, employee, settings, start) {
  const window = linkWindow(employee, settings);
  const data = buildPeriod(db, employee, settings, start, payPeriodFor(employee.pay_frequency, settings.period_anchor_date, start).end);
  return {
    company: NUD_COMPANY.name,
    office: { phone: NUD_COMPANY.phone, phone_href: NUD_COMPANY.phoneHref },
    worker: { first_name: employee.preferred_name || employee.first_name },
    today: window.today,
    editable_from: window.editableFrom,
    period: {
      start: data.period.start,
      end: data.period.end,
      frequency: data.period.frequency,
      is_current: data.period.start === window.current.start,
      prev_start: data.period.prev_start >= payPeriodFor(employee.pay_frequency, settings.period_anchor_date, window.oldestDay).start ? data.period.prev_start : null,
      next_start: data.period.start < window.current.start ? data.period.next_start : null,
    },
    pay: data.pay,
    totals: data.totals,
    days: data.days.map(day => ({
      date: day.date,
      hours_before_in_week: day.hours_before_in_week,
      editable: day.date >= window.editableFrom && day.date <= window.today && (!day.entry || day.entry.status === 'submitted'),
      entry: day.entry && {
        work_date: day.entry.work_date,
        start_time: day.entry.start_time,
        end_time: day.entry.end_time,
        break_minutes: day.entry.break_minutes,
        hours: day.entry.hours,
        job_site: day.entry.job_site,
        notes: day.entry.notes,
        status: day.entry.status,
        regular_hours: day.entry.regular_hours,
        overtime_hours: day.entry.overtime_hours,
        hourly_rate_cents: day.entry.hourly_rate_cents,
        wages_cents: day.entry.wages_cents,
        addons: day.entry.addons,
        addons_cents: day.entry.addons_cents,
        gross_cents: day.entry.gross_cents,
        pay_method: day.entry.pay_method,
        entered_by_office: day.entry.entered_via === 'manager',
      },
    })),
    addon_types: addonTypeList({ manager: false }),
  };
}

function editableDate(employee, settings, date) {
  const window = linkWindow(employee, settings);
  if (date > window.today) throw httpError(400, 'You can\'t enter hours for a day that hasn\'t happened yet.');
  if (date < window.editableFrom) throw httpError(400, 'That pay period is closed. Call the office if something needs to change.');
}

const publicRouter = express.Router();

publicRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

publicRouter.get('/:token', limitByIp('ts-view', 120, 60 * 1000), (req, res, next) => {
  try {
    const { db, employee, settings } = workerFromLink(req);
    const window = linkWindow(employee, settings);
    let start = window.current.start;
    if (req.query.start) {
      const period = payPeriodFor(employee.pay_frequency, settings.period_anchor_date, dayValue(req.query.start, 'pay period'));
      if (period.start > window.current.start || period.end < window.oldestDay) throw httpError(400, 'That pay period is not available.');
      start = period.start;
    }
    const opened = db.prepare(`
      UPDATE hr_timesheet_workers
      SET link_last_opened_at = datetime('now')
      WHERE employee_id = ? AND (link_last_opened_at IS NULL OR link_last_opened_at < datetime('now', '-30 minutes'))
    `).run(employee.id);
    if (opened.changes) recordEvent(db, req, { employeeId: employee.id, action: 'link_opened', actor: { type: 'link' } });
    res.json(linkPayload(db, employee, settings, start));
  } catch (error) {
    next(error);
  }
});

publicRouter.put('/:token/days/:date', limitByIp('ts-write', 60, 10 * 60 * 1000), (req, res, next) => {
  try {
    const { db, employee, settings } = workerFromLink(req);
    const date = dayValue(req.params.date, 'date');
    editableDate(employee, settings, date);
    const input = normalizeDay(req.body, { manager: false, mileageRateCents: settings.mileage_rate_cents });
    saveDay(db, req, { employee, date, input, actor: { type: 'link' } });
    res.json(linkPayload(db, employee, settings, payPeriodFor(employee.pay_frequency, settings.period_anchor_date, date).start));
  } catch (error) {
    next(error);
  }
});

publicRouter.delete('/:token/days/:date', limitByIp('ts-write', 60, 10 * 60 * 1000), (req, res, next) => {
  try {
    const { db, employee, settings } = workerFromLink(req);
    const date = dayValue(req.params.date, 'date');
    editableDate(employee, settings, date);
    deleteDay(db, req, { employee, date, actor: { type: 'link' } });
    res.json(linkPayload(db, employee, settings, payPeriodFor(employee.pay_frequency, settings.period_anchor_date, date).start));
  } catch (error) {
    next(error);
  }
});

publicRouter.use(timesheetErrorHandler('Link'));

module.exports = {
  createManagerRouter,
  publicRouter,
  // exported for tests
  _internals: { payPeriodFor, workweekStartFor, normalizeDay, buildPeriod, hashToken, normalizeUsPhone },
};
