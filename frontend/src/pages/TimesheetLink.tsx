import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, SelectHTMLAttributes } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleAlert, Clock, LoaderCircle, LogIn, LogOut, Plus, Trash2, X } from 'lucide-react';
import toast from 'react-hot-toast';

import '../styles/timesheet-link.css';
import { BUILDTRACK_TRUTH_ICON_SRC } from '../lib/branding';
import {
  BREAK_OPTIONS,
  PAY_FREQUENCY_LABELS,
  PAY_METHOD_LABELS,
  STATUS_LABELS,
  addonsPayload,
  draftAddonCents,
  draftFromAddons,
  formatDayLong,
  formatMonthDay,
  formatPeriod,
  formatWeekday,
  hoursFromTimes,
  hoursText,
  money,
  newDraftAddon,
  payNotice,
  previewDay,
  time12,
} from '../lib/timesheets';
import type { AddonType, DraftAddon, TimesheetDay, TimesheetPay, TimesheetPeriod, TimesheetTotals } from '../lib/timesheets';

// A field worker's private timesheet (/timesheet/:token). No BuildTrack login: the token
// in the link is the only credential, so this page talks to /api/timesheet-link with plain
// fetch (never the app's api client, which would attach a staff session and bounce 401s
// to /login) and shows nothing but this one worker's own days and pay.

interface LinkPayload {
  company: string;
  office: { phone: string; phone_href: string };
  worker: { first_name: string };
  usual: { start_time: string; end_time: string; break_minutes: number };
  today: string;
  editable_from: string;
  period: TimesheetPeriod;
  pay: TimesheetPay;
  totals: TimesheetTotals;
  submission: { submitted_at: string; hours: number; gross_cents: number; changed_since: boolean } | null;
  can_submit: boolean;
  punch: {
    open: { date: string; start_time: string; job_site: string | null; minutes: number; too_long: boolean } | null;
    can_punch_in: boolean;
    last_project: string | null;
  };
  days: TimesheetDay[];
  addon_types: AddonType[];
}

interface PunchResult {
  kind: 'in' | 'out';
  time: string | null;
  project: string | null;
  hours: number | null;
}

/** The time right now on the office's clock, which is the one punches are saved with. */
function nowEastern() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/Detroit', hour: 'numeric', minute: '2-digit' });
}

function elapsedText(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} hr ${rest} min` : `${rest} min`;
}

/** Every punch and saved day goes to the office as it happens, so an open day reads "Sent". */
function dayStatusLabel(entry: { status: keyof typeof STATUS_LABELS }) {
  return { label: entry.status === 'submitted' ? 'Sent' : STATUS_LABELS[entry.status], tone: entry.status };
}

const SHORT_FREQUENCY: Record<string, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  semimonthly: 'Twice a month',
  monthly: 'Monthly',
};

function Dropdown({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="tsl-select">
      <select {...props}>{children}</select>
      <ChevronDown size={20} className="tsl-select-icon" aria-hidden="true" />
    </span>
  );
}

async function callLink(token: string, path: string, init?: { method: string; body?: unknown }): Promise<LinkPayload> {
  const response = await fetch(`/api/timesheet-link/${encodeURIComponent(token)}${path}`, {
    method: init?.method || 'GET',
    headers: init?.body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || 'Something went wrong. Please try again.') as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return payload as LinkPayload;
}

export default function TimesheetLink() {
  const { token = '' } = useParams();
  const [data, setData] = useState<LinkPayload | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [loadingPeriod, setLoadingPeriod] = useState(false);
  const [editing, setEditing] = useState<TimesheetDay | null>(null);
  const [totalsOpen, setTotalsOpen] = useState(false);
  const [punched, setPunched] = useState<PunchResult | null>(null);

  // The token is in the URL: send no Referer anywhere, and give the tab a plain title.
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    const previousTitle = document.title;
    document.title = 'My Timesheet - New Urban Development';
    return () => {
      meta.remove();
      document.title = previousTitle;
    };
  }, []);

  const load = useCallback(async (start?: string) => {
    setLoadingPeriod(true);
    try {
      const payload = await callLink(token, start ? `?start=${encodeURIComponent(start)}` : '');
      setData(payload);
      setFatal(null);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (!start || status === 404) setFatal((error as Error).message);
      else toast.error((error as Error).message);
    } finally {
      setLoadingPeriod(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // A tab left open since the morning shows what is saved now when the worker comes back to it
  // (to punch out, say). The current week reloads as "this week", so a new day rolls over too.
  const shownPeriod = useRef<{ start: string; isCurrent: boolean } | null>(null);
  useEffect(() => {
    if (data) shownPeriod.current = { start: data.period.start, isCurrent: Boolean(data.period.is_current) };
  }, [data]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !shownPeriod.current) return;
      const { start, isCurrent } = shownPeriod.current;
      callLink(token, isCurrent ? '' : `?start=${encodeURIComponent(start)}`).then(setData).catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [token]);

  // The punch confirmation closes itself after a few seconds.
  useEffect(() => {
    if (!punched) return undefined;
    const timer = window.setTimeout(() => setPunched(null), 3500);
    return () => window.clearTimeout(timer);
  }, [punched]);

  const openDay = async (date: string) => {
    if (!data) return;
    let day = data.days.find(item => item.date === date);
    if (!day) {
      try {
        const payload = await callLink(token, `?start=${encodeURIComponent(date)}`);
        setData(payload);
        day = payload.days.find(item => item.date === date);
      } catch (error) {
        toast.error((error as Error).message);
        return;
      }
    }
    if (day) setEditing(day);
  };

  if (fatal) {
    return (
      <div className="tsl-root">
        <div className="tsl-center">
          <CircleAlert size={40} color="#b91c1c" aria-hidden="true" />
          <h1>This link isn't working</h1>
          <p>{fatal}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="tsl-root">
        <div className="tsl-center" aria-live="polite">
          <LoaderCircle size={32} className="tsl-spin" aria-hidden="true" />
          <p>Loading your timesheet...</p>
        </div>
      </div>
    );
  }

  const { pay, totals, period } = data;
  const notice = payNotice(pay.pay_method);
  const overtimeRate = pay.hourly_rate_cents != null ? Math.round(pay.hourly_rate_cents * pay.overtime_multiplier) : null;

  return (
    <div className="tsl-root">
      <div className="tsl-shell">
        <header className="tsl-header">
          {/* The same logo as the top-left of BuildTrack (Mike, 2026-10-30). */}
          <span className="tsl-logo">
            <img src={BUILDTRACK_TRUTH_ICON_SRC} alt="BuildTrack" />
          </span>
          <div className="min-w-0">
            <p className="tsl-company">{data.company}</p>
            <h1 className="tsl-title">{data.worker.first_name}'s timesheet</h1>
          </div>
        </header>

        <div className="tsl-chips">
          {pay.hourly && pay.hourly_rate_cents != null && <span className="tsl-chip">{money(pay.hourly_rate_cents)}/hr</span>}
          <span className={`tsl-chip tsl-chip--${notice.tone}`}>{PAY_METHOD_LABELS[pay.pay_method]}</span>
          <span className="tsl-chip">{SHORT_FREQUENCY[pay.pay_frequency] || PAY_FREQUENCY_LABELS[pay.pay_frequency]}</span>
          <span className="tsl-chip">Payday {formatWeekday(pay.payday)} {formatMonthDay(pay.payday)}</span>
        </div>

        <nav className="tsl-period" aria-label="Pay period">
          <button
            type="button"
            className="tsl-icon-btn"
            onClick={() => period.prev_start && load(period.prev_start)}
            disabled={!period.prev_start || loadingPeriod}
            aria-label="Previous pay period"
          >
            <ChevronLeft size={24} />
          </button>
          <div className="tsl-period-label" aria-live="polite">
            <span>{period.is_current ? 'This pay period' : 'Past pay period'}</span>
            <strong>{formatPeriod(period.start, period.end)}</strong>
          </div>
          <button
            type="button"
            className="tsl-icon-btn"
            onClick={() => period.next_start && load(period.next_start)}
            disabled={!period.next_start || loadingPeriod}
            aria-label="Next pay period"
          >
            <ChevronRight size={24} />
          </button>
        </nav>

        <ol className="tsl-days" aria-label="Days in this pay period">
          {data.days.map(day => {
            const entry = day.entry;
            const isToday = day.date === data.today;
            const clickable = Boolean(entry) || Boolean(day.editable);
            return (
              <li key={day.date}>
                <button
                  type="button"
                  className={`tsl-day ${entry ? 'has-entry' : ''} ${isToday ? 'is-today' : ''}`}
                  disabled={!clickable}
                  onClick={() => setEditing(day)}
                  aria-label={`${formatDayLong(day.date)}${entry?.open_shift
                    ? `, punched in at ${time12(entry.start_time)}`
                    : entry ? `, ${hoursText(entry.hours)} hours, ${money(entry.gross_cents)}` : day.editable ? ', add hours' : ''}`}
                >
                  <span className="tsl-day-date" aria-hidden="true">
                    <span>{formatWeekday(day.date)}</span>
                    <strong>{Number(day.date.slice(8))}</strong>
                  </span>
                  <span className="tsl-day-body">
                    {entry?.open_shift ? (
                      <>
                        <span className="tsl-day-hours">
                          On the clock
                          <span className="tsl-day-time">in {time12(entry.start_time)}</span>
                        </span>
                        {entry.job_site && <span className="tsl-day-project">{entry.job_site}</span>}
                      </>
                    ) : entry ? (
                      <>
                        <span className="tsl-day-hours">
                          {hoursText(entry.hours)} hrs
                          {entry.overtime_hours > 0 ? ` (${hoursText(entry.overtime_hours)} overtime)` : ''}
                          {entry.start_time && <span className="tsl-day-time">{time12(entry.start_time)} - {time12(entry.end_time)}</span>}
                        </span>
                        {(entry.job_site || entry.addons.length > 0) && (
                          <span className="tsl-day-sub">
                            {entry.job_site && <span className="tsl-day-project">{entry.job_site}</span>}
                            {entry.addons.length > 0 && <span className="tsl-day-extras">+ {money(entry.addons_cents)} extras</span>}
                          </span>
                        )}
                      </>
                    ) : day.editable ? (
                      <span className="tsl-day-empty">
                        <Plus size={18} aria-hidden="true" />
                        {isToday ? 'Add today\'s hours' : 'Add hours'}
                      </span>
                    ) : (
                      <span className="tsl-day-off">{day.date > data.today ? 'Coming up' : 'No hours'}</span>
                    )}
                  </span>
                  {entry?.open_shift ? (
                    <span className="tsl-day-right">
                      <span className="tsl-status tsl-status--open">Punched in</span>
                    </span>
                  ) : entry && (
                    <span className="tsl-day-right">
                      <strong>{money(entry.gross_cents)}</strong>
                      <span className={`tsl-status tsl-status--${dayStatusLabel(entry).tone}`}>{dayStatusLabel(entry).label}</span>
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>

        <section className={`tsl-notice tsl-notice--${notice.tone}`}>
          <strong>{notice.title}</strong>
          <p>{notice.body}</p>
        </section>

        <p className="tsl-fineprint">
          Open this link when you start work and tap Punch in, then open it again when you finish and tap Punch out.
          Each punch is submitted to the office right away. Forgot to punch? Tap the day to enter the hours yourself.
          The link is only for you.
          Tip: save it to your home screen so it's one tap away. Questions? Call the office at{' '}
          <a href={data.office.phone_href}>{data.office.phone}</a>.
        </p>
      </div>

      <footer className="tsl-totalbar">
        <div className="tsl-totalbar-inner">
          {totalsOpen && (
            <div className="tsl-breakdown" id="tsl-breakdown">
              <div className="tsl-breakdown-row"><span>Days worked</span><strong>{totals.days_worked}</strong></div>
              {pay.hourly && pay.hourly_rate_cents != null ? (
                <>
                  <div className="tsl-breakdown-row">
                    <span>{pay.overtime_enabled ? 'Regular ' : ''}{hoursText(totals.regular_hours)} hrs x {money(pay.hourly_rate_cents)}</span>
                    <strong>{money(totals.regular_cents)}</strong>
                  </div>
                  {totals.overtime_hours > 0 && (
                    <div className="tsl-breakdown-row">
                      <span>Overtime {hoursText(totals.overtime_hours)} hrs x {money(overtimeRate)}</span>
                      <strong>{money(totals.overtime_cents)}</strong>
                    </div>
                  )}
                </>
              ) : (
                <div className="tsl-breakdown-row"><span>Hours</span><strong>{hoursText(totals.hours)}</strong></div>
              )}
              {(totals.addons_by_type || []).map(addon => (
                <div key={addon.type} className="tsl-breakdown-row">
                  <span>{addon.label}{addon.quantity ? ` (${hoursText(addon.quantity)} mi)` : ''}</span>
                  <strong>{money(addon.amount_cents)}</strong>
                </div>
              ))}
              <div className="tsl-breakdown-row tsl-breakdown-row--total"><span>Gross pay</span><strong>{money(totals.gross_cents)}</strong></div>
              {pay.pay_method === 'payroll' && <p className="tsl-breakdown-note">Before federal and state income tax and FICA are taken out by payroll.</p>}
            </div>
          )}
          <button
            type="button"
            className="tsl-totalbar-main"
            onClick={() => setTotalsOpen(open => !open)}
            aria-expanded={totalsOpen}
            aria-controls="tsl-breakdown"
          >
            <span className="tsl-total-block">
              <span>Total hours</span>
              <strong>{hoursText(totals.hours)}</strong>
            </span>
            <span className="tsl-total-block tsl-total-block--gross">
              <span>{pay.pay_method === 'payroll' ? 'Gross pay (before taxes)' : 'Gross pay'}</span>
              <strong>{money(totals.gross_cents)}</strong>
            </span>
            <ChevronUp size={24} className={`tsl-chevron ${totalsOpen ? 'is-open' : ''}`} aria-hidden="true" />
            <span className="tsl-sr-only">{totalsOpen ? 'Hide the breakdown' : 'Show the breakdown'}</span>
          </button>
          <PunchBar
            data={data}
            token={token}
            onPunched={(payload, result) => {
              setData(payload);
              setPunched(result);
            }}
            onOpenDay={openDay}
          />
        </div>
      </footer>

      {punched && (
        <div className="tsl-popup-backdrop" role="presentation" onClick={() => setPunched(null)}>
          <div className="tsl-popup" role="alertdialog" aria-modal="true" aria-labelledby="tsl-punch-title" onClick={event => event.stopPropagation()}>
            <CheckCircle2 size={56} className={`tsl-popup-icon ${punched.kind === 'out' ? 'is-out' : ''}`} aria-hidden="true" />
            <h2 id="tsl-punch-title">{punched.kind === 'in' ? 'You are punched in' : 'You are punched out'}</h2>
            <p>
              <strong className="tsl-popup-time">{time12(punched.time)}</strong>
              {punched.kind === 'in'
                ? punched.project && <><br />{punched.project}</>
                : punched.hours != null && <><br />{hoursText(punched.hours)} hours for the day</>}
              <br />
              Submitted to the office.
            </p>
            <button type="button" className="tsl-primary" onClick={() => setPunched(null)} autoFocus>OK</button>
          </div>
        </div>
      )}

      {editing && (
        <DayEditor
          key={editing.date}
          day={editing}
          data={data}
          token={token}
          onClose={() => setEditing(null)}
          onSaved={(payload, message) => {
            setData(payload);
            setEditing(null);
            toast.success(message);
          }}
        />
      )}
    </div>
  );
}

/**
 * The punch clock in the bottom bar: one button, green Punch in (with the project) when the day
 * starts, red Punch out (with the lunch break) when it ends, and a status line under it saying
 * the time went to the office. The server stamps the time; the phone's clock is never used.
 */
function PunchBar({
  data,
  token,
  onPunched,
  onOpenDay,
}: {
  data: LinkPayload;
  token: string;
  onPunched: (payload: LinkPayload, result: PunchResult) => void;
  onOpenDay: (date: string) => void;
}) {
  const { open, can_punch_in: canPunchIn, last_project: lastProject } = data.punch;
  const [project, setProject] = useState(lastProject || '');
  const [breakMinutes, setBreakMinutes] = useState(data.usual.break_minutes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setLoadedAt(Date.now());
    setNow(Date.now());
  }, [data]);

  // The "on the clock" time and the clock shown above Punch in keep moving while the page is open.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, []);

  const projects = [...new Set([lastProject, ...data.days.map(day => day.entry?.job_site)].filter((value): value is string => Boolean(value)))];
  const today = data.days.find(day => day.date === data.today)?.entry;

  const punchIn = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (!project.trim()) {
      setError('Enter the project first: the house number and street, like 123 Smith St.');
      return;
    }
    setBusy(true);
    try {
      const payload = await callLink(token, '/punch-in', { method: 'POST', body: { job_site: project } });
      const shift = payload.punch.open;
      onPunched(payload, { kind: 'in', time: shift?.start_time ?? null, project: shift?.job_site ?? project, hours: null });
    } catch (punchError) {
      setError((punchError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const punchOut = async () => {
    if (busy || !open) return;
    setError(null);
    setBusy(true);
    try {
      const payload = await callLink(token, '/punch-out', { method: 'POST', body: { break_minutes: breakMinutes } });
      const entry = payload.days.find(day => day.date === open.date)?.entry;
      onPunched(payload, { kind: 'out', time: entry?.end_time ?? null, project: entry?.job_site ?? null, hours: entry?.hours ?? null });
    } catch (punchError) {
      setError((punchError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const errorLine = error && <p className="tsl-punch-error" role="alert">{error}</p>;

  if (open?.too_long) {
    return (
      <section className="tsl-punch" aria-label="Punch clock">
        <button type="button" className="tsl-punch-btn tsl-punch-btn--fix" onClick={() => onOpenDay(open.date)}>
          Enter the time you finished
        </button>
        <p className="tsl-punch-status tsl-punch-status--warn" role="status">
          <CircleAlert size={18} aria-hidden="true" />
          <span>You did not punch out on {formatDayLong(open.date)}.</span>
        </p>
      </section>
    );
  }

  if (open) {
    const minutes = open.minutes + Math.max(0, Math.floor((now - loadedAt) / 60000));
    return (
      <section className="tsl-punch" aria-label="Punch clock">
        <div className="tsl-punch-row">
          <Dropdown value={breakMinutes} onChange={event => setBreakMinutes(Number(event.target.value))} aria-label="Lunch break (unpaid)" disabled={busy}>
            {BREAK_OPTIONS.map(option => <option key={option.minutes} value={option.minutes}>{option.minutes ? `Lunch ${option.label}` : option.label}</option>)}
            {!BREAK_OPTIONS.some(option => option.minutes === breakMinutes) && <option value={breakMinutes}>Lunch {breakMinutes} minutes</option>}
          </Dropdown>
          <button type="button" className="tsl-punch-btn tsl-punch-btn--out" onClick={punchOut} disabled={busy}>
            <LogOut size={20} aria-hidden="true" />
            {busy ? 'Sending...' : 'Punch out'}
          </button>
        </div>
        {errorLine}
        <p className="tsl-punch-status tsl-punch-status--on" role="status">
          <span className="tsl-punch-dot" aria-hidden="true" />
          <span>
            Punched in at {time12(open.start_time)}{open.date !== data.today ? ` ${formatWeekday(open.date)}` : ''}. Submitted to the office.
          </span>
          <span className="tsl-punch-elapsed">{elapsedText(minutes)}</span>
        </p>
      </section>
    );
  }

  if (canPunchIn) {
    return (
      <form className="tsl-punch" aria-label="Punch clock" onSubmit={punchIn} noValidate>
        <div className="tsl-punch-row">
          <input
            className="tsl-input"
            type="text"
            name="punch-project"
            list="tsl-punch-projects"
            value={project}
            onChange={event => setProject(event.target.value)}
            placeholder="Project: 123 Smith St"
            aria-label="Project (house number and street)"
            maxLength={200}
            autoComplete="off"
          />
          <button type="submit" className="tsl-punch-btn tsl-punch-btn--in" disabled={busy}>
            <LogIn size={20} aria-hidden="true" />
            {busy ? 'Sending...' : 'Punch in'}
          </button>
        </div>
        <datalist id="tsl-punch-projects">
          {projects.map(item => <option key={item} value={item} />)}
        </datalist>
        {errorLine}
        <p className="tsl-punch-status" role="status">
          <Clock size={18} aria-hidden="true" />
          <span>It's {nowEastern()}. Enter the project and tap Punch in when you start work.</span>
        </p>
      </form>
    );
  }

  return (
    <section className="tsl-punch" aria-label="Punch clock">
      <p className="tsl-punch-status tsl-punch-status--done" role="status">
        <CheckCircle2 size={18} aria-hidden="true" />
        <span>
          {today?.start_time ? `Today ${time12(today.start_time)} - ${time12(today.end_time)}. ` : today ? `Today ${hoursText(today.hours)} hrs. ` : ''}
          Your hours have been submitted to the office.
        </span>
      </p>
    </section>
  );
}

function DayEditor({
  day,
  data,
  token,
  onClose,
  onSaved,
}: {
  day: TimesheetDay;
  data: LinkPayload;
  token: string;
  onClose: () => void;
  onSaved: (payload: LinkPayload, message: string) => void;
}) {
  const titleId = useId();
  const entry = day.entry;
  const readOnly = !day.editable;
  const types = data.addon_types;
  const isWorkerType = (type: string) => types.some(option => option.type === type);
  // Extras the office added (a bonus) are shown but cannot be changed from the link.
  const officeAddons = entry ? entry.addons.filter(addon => !isWorkerType(addon.type)) : [];
  // A new day starts from the worker's usual hours (8 to 5 unless the office set others).
  const prefilled = !entry && !readOnly;
  const [mode, setMode] = useState<'times' | 'hours'>(entry && !entry.start_time ? 'hours' : 'times');
  const [start, setStart] = useState(entry ? entry.start_time || '' : data.usual.start_time);
  const [end, setEnd] = useState(entry ? entry.end_time || '' : data.usual.end_time);
  const [breakMinutes, setBreakMinutes] = useState(entry ? entry.break_minutes : data.usual.break_minutes);
  const [hours, setHours] = useState(entry && !entry.start_time ? String(entry.hours) : '');
  const [jobSite, setJobSite] = useState(entry?.job_site || '');
  const [notes, setNotes] = useState(entry?.notes || '');
  const [addons, setAddons] = useState<DraftAddon[]>(entry ? draftFromAddons(entry.addons.filter(addon => isWorkerType(addon.type))) : []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const timeResult = mode === 'times' ? hoursFromTimes(start, end, breakMinutes) : null;
  const dayHours = mode === 'times' ? (timeResult?.hours ?? 0) : Math.max(0, Math.min(24, Number(hours) || 0));
  const extrasCents = addons.reduce((sum, addon) => sum + draftAddonCents(addon, types, data.pay.mileage_rate_cents), 0)
    + officeAddons.reduce((sum, addon) => sum + addon.amount_cents, 0);
  const rateCents = entry && entry.status !== 'submitted' ? entry.hourly_rate_cents : (data.pay.hourly_rate_cents ?? 0);
  const preview = previewDay({ hours: dayHours, pay: data.pay, rateCents, hoursBeforeInWeek: day.hours_before_in_week, addonsCents: extrasCents });

  const updateAddon = (key: string, patch: Partial<DraftAddon>) => {
    setAddons(current => current.map(addon => (addon.key === key ? { ...addon, ...patch } : addon)));
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (readOnly || saving) return;
    setError(null);
    if (mode === 'times') {
      if (!start || !end) return setError('Enter the time you started and the time you finished.');
      if (timeResult?.error) return setError(timeResult.error);
    } else if (!(Number(hours) > 0) && !addons.length) {
      return setError('Enter the hours you worked.');
    }
    if (!jobSite.trim()) return setError('Enter the project: the house number and street, like 123 Smith St.');
    if (addons.some(addon => !addon.type)) return setError('Choose what each extra is for, or remove it.');
    setSaving(true);
    try {
      const body = {
        ...(mode === 'times' ? { start_time: start, end_time: end, break_minutes: breakMinutes } : { hours: hours || 0 }),
        job_site: jobSite,
        notes,
        addons: addonsPayload(addons, types),
      };
      const payload = await callLink(token, `/days/${day.date}`, { method: 'PUT', body });
      onSaved(payload, `${formatDayLong(day.date)} submitted to the office`);
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = await callLink(token, `/days/${day.date}`, { method: 'DELETE' });
      onSaved(payload, `Removed ${formatDayLong(day.date)}`);
    } catch (removeError) {
      setError((removeError as Error).message);
      setConfirmRemove(false);
    } finally {
      setSaving(false);
    }
  };

  const readOnlyMessage = entry?.status === 'paid'
    ? 'This day has been paid. Call the office if something is wrong.'
    : entry?.status === 'approved'
      ? 'The office has approved this day. Call the office if something needs to change.'
      : 'This pay period is closed. Call the office if something needs to change.';

  return (
    <div className="tsl-sheet-backdrop" onClick={onClose} role="presentation">
      <form
        className="tsl-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={save}
        onClick={event => event.stopPropagation()}
        noValidate
      >
        <header className="tsl-sheet-header">
          <button type="button" className="tsl-icon-btn" onClick={onClose} aria-label="Close">
            <X size={24} />
          </button>
          <div>
            <h2 id={titleId}>{formatDayLong(day.date)}</h2>
          </div>
          {entry && <span className={`tsl-status tsl-status--${dayStatusLabel(entry).tone}`} style={{ marginLeft: 'auto' }}>{dayStatusLabel(entry).label}</span>}
        </header>

        <div className="tsl-sheet-body">
          {readOnly && <p className="tsl-banner">{readOnlyMessage}</p>}

          {!readOnly && (
            <div className="tsl-seg" role="group" aria-label="How to enter your time">
              <button type="button" className={mode === 'times' ? 'is-on' : ''} aria-pressed={mode === 'times'} onClick={() => setMode('times')}>
                Start &amp; end time
              </button>
              <button type="button" className={mode === 'hours' ? 'is-on' : ''} aria-pressed={mode === 'hours'} onClick={() => setMode('hours')}>
                Total hours
              </button>
            </div>
          )}

          {mode === 'times' ? (
            <>
              <div className="tsl-grid2">
                <label className="tsl-field">
                  <span>Start time</span>
                  <input type="time" value={start} onChange={event => setStart(event.target.value)} disabled={readOnly} />
                </label>
                <label className="tsl-field">
                  <span>End time</span>
                  <input type="time" value={end} onChange={event => setEnd(event.target.value)} disabled={readOnly} />
                </label>
              </div>
              <label className="tsl-field">
                <span>Lunch break <em>(unpaid)</em></span>
                <Dropdown value={breakMinutes} onChange={event => setBreakMinutes(Number(event.target.value))} disabled={readOnly}>
                  {BREAK_OPTIONS.map(option => <option key={option.minutes} value={option.minutes}>{option.label}</option>)}
                  {!BREAK_OPTIONS.some(option => option.minutes === breakMinutes) && <option value={breakMinutes}>{breakMinutes} minutes</option>}
                </Dropdown>
              </label>
              {timeResult?.error && <p className="tsl-hint" style={{ color: '#b91c1c' }}>{timeResult.error}</p>}
              {prefilled && !timeResult?.error && <p className="tsl-hint">Your usual hours are filled in. Change them if this day was different.</p>}
              {entry?.open_shift && !readOnly && (
                <p className="tsl-hint">You are still punched in. Tap Punch out at the bottom of the screen, or enter the time you finished here.</p>
              )}
            </>
          ) : (
            <label className="tsl-field">
              <span>Hours worked</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                max="24"
                step="0.25"
                placeholder="8"
                value={hours}
                onChange={event => setHours(event.target.value)}
                disabled={readOnly}
              />
            </label>
          )}

          <label className="tsl-field">
            <span>Project <em className="tsl-required">(required)</em></span>
            <input
              type="text"
              name="project"
              list="tsl-projects"
              value={jobSite}
              onChange={event => setJobSite(event.target.value)}
              placeholder="123 Smith St"
              maxLength={200}
              disabled={readOnly}
              autoComplete="off"
              aria-describedby="tsl-project-hint"
            />
            <small id="tsl-project-hint" className="tsl-field-hint">
              The project is the property address: house number and street, like 123 Smith St. No city or ZIP needed.
            </small>
            <datalist id="tsl-projects">
              {[...new Set(data.days.map(item => item.entry?.job_site).filter((value): value is string => Boolean(value)))].map(project => (
                <option key={project} value={project} />
              ))}
            </datalist>
          </label>

          <section className="tsl-extras" aria-label="Extras">
            <div className="tsl-extras-head">
              <h3>Extras</h3>
              <p>Gas money, lunch, mileage and other pay on top of your hours.</p>
            </div>
            {addons.map(addon => {
              const definition = types.find(type => type.type === addon.type);
              return (
                <div key={addon.key} className="tsl-addon">
                  <Dropdown
                    value={addon.type}
                    onChange={event => updateAddon(addon.key, { type: event.target.value })}
                    aria-label="What is this extra for?"
                    disabled={readOnly}
                  >
                    <option value="" disabled>Choose...</option>
                    {types.map(type => <option key={type.type} value={type.type}>{type.label}</option>)}
                  </Dropdown>
                  <label className="tsl-addon-amount">
                    {definition?.per_mile ? (
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.1"
                        placeholder="Miles"
                        aria-label="Miles driven"
                        value={addon.quantity}
                        onChange={event => updateAddon(addon.key, { quantity: event.target.value })}
                        disabled={readOnly}
                      />
                    ) : (
                      <>
                        <span className="tsl-prefix" aria-hidden="true">$</span>
                        <input
                          className="has-prefix"
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="0.01"
                          placeholder="0.00"
                          aria-label="Amount in dollars"
                          value={addon.amount}
                          onChange={event => updateAddon(addon.key, { amount: event.target.value })}
                          disabled={readOnly}
                        />
                      </>
                    )}
                  </label>
                  {!readOnly ? (
                    <button type="button" className="tsl-addon-remove" onClick={() => setAddons(current => current.filter(item => item.key !== addon.key))} aria-label="Remove this extra">
                      <Trash2 size={20} />
                    </button>
                  ) : <span />}
                  {definition?.per_mile && (
                    <p className="tsl-addon-sub">
                      {hoursText(Number(addon.quantity) || 0)} miles x {money(data.pay.mileage_rate_cents)} = {money(draftAddonCents(addon, types, data.pay.mileage_rate_cents))}
                    </p>
                  )}
                  <input
                    className="tsl-addon-note"
                    type="text"
                    placeholder="Note (optional)"
                    aria-label="Note for this extra"
                    maxLength={200}
                    value={addon.note}
                    onChange={event => updateAddon(addon.key, { note: event.target.value })}
                    disabled={readOnly}
                  />
                </div>
              );
            })}
            {officeAddons.map((addon, index) => (
              <div key={`office-${index}`} className="tsl-addon--locked">
                <span>{addon.label} <em style={{ color: '#5b6472', fontStyle: 'normal' }}>(added by the office)</em></span>
                <strong>{money(addon.amount_cents)}</strong>
              </div>
            ))}
            {!readOnly && addons.length < 12 && (
              <button type="button" className="tsl-add-extra" onClick={() => setAddons(current => [...current, newDraftAddon()])}>
                <Plus size={20} aria-hidden="true" />
                Add gas money, lunch or other
              </button>
            )}
            {readOnly && !addons.length && !officeAddons.length && <p className="tsl-hint" style={{ margin: 0 }}>No extras.</p>}
          </section>

          <label className="tsl-field">
            <span>Notes <em>(optional)</em></span>
            <textarea rows={2} value={notes} onChange={event => setNotes(event.target.value)} maxLength={1000} disabled={readOnly} />
          </label>

          <section className="tsl-calc" aria-live="polite" aria-label="Day calculator">
            <h3>Day calculator</h3>
            {data.pay.hourly ? (
              <>
                <div className="tsl-calc-row">
                  <span>{hoursText(preview.regular)} hrs x {money(rateCents)}</span>
                  <strong>{money(preview.regularCents)}</strong>
                </div>
                {preview.overtime > 0 && (
                  <div className="tsl-calc-row">
                    <span>Overtime {hoursText(preview.overtime)} hrs x {money(Math.round(rateCents * data.pay.overtime_multiplier))}</span>
                    <strong>{money(preview.overtimeCents)}</strong>
                  </div>
                )}
              </>
            ) : (
              <div className="tsl-calc-row"><span>Hours</span><strong>{hoursText(dayHours)}</strong></div>
            )}
            <div className="tsl-calc-row">
              <span>Extras</span>
              <strong>{money(preview.addonsCents)}</strong>
            </div>
            <div className="tsl-calc-total">
              <span>Day gross</span>
              <strong>{money(preview.grossCents)}</strong>
            </div>
            {data.pay.pay_method === 'payroll' && <p className="tsl-calc-note">Before federal and state income tax and FICA are taken out by payroll.</p>}
          </section>

          {error && <p className="tsl-error" role="alert">{error}</p>}
        </div>

        {readOnly ? (
          <footer className="tsl-sheet-footer">
            <button type="button" className="tsl-primary" onClick={onClose}>Close</button>
          </footer>
        ) : (
          <footer className="tsl-sheet-footer">
            {entry && (
              <button type="button" className={`tsl-danger ${confirmRemove ? 'is-confirming' : ''}`} onClick={remove} disabled={saving}>
                <Trash2 size={18} aria-hidden="true" />
                {confirmRemove ? 'Tap to confirm' : 'Remove'}
              </button>
            )}
            <button type="submit" className="tsl-primary" disabled={saving}>
              {saving ? 'Saving...' : entry ? 'Save changes' : 'Save day'}
            </button>
          </footer>
        )}
      </form>
    </div>
  );
}
