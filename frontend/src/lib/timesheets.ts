// HR > Timesheets: shared shapes, labels and the live calculator used by the manager
// page (pages/Timesheets.tsx) and the worker's phone link (pages/TimesheetLink.tsx).
// The server (backend/src/routes/hrTimesheets.js) is the source of truth for every
// saved number; previewDay() mirrors its math so the calculator updates while typing.

export type PayMethod = 'cash' | 'payroll' | 'check' | 'other';
export type PayFrequency = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
export type EntryStatus = 'submitted' | 'approved' | 'paid';

export interface AddonType {
  type: string;
  label: string;
  per_mile: boolean;
  manager_only?: boolean;
}

export interface TimesheetAddon {
  type: string;
  label: string;
  quantity: number | null;
  amount_cents: number;
  note: string | null;
}

export interface TimesheetEntry {
  id?: string;
  work_date: string;
  start_time: string | null;
  end_time: string | null;
  break_minutes: number;
  hours: number;
  job_site: string | null;
  notes: string | null;
  status: EntryStatus;
  regular_hours: number;
  overtime_hours: number;
  hourly_rate_cents: number;
  wages_cents: number;
  addons: TimesheetAddon[];
  addons_cents: number;
  gross_cents: number;
  pay_method: PayMethod;
  entered_via?: 'link' | 'manager';
  updated_via?: 'link' | 'manager';
  entered_by_office?: boolean;
  updated_at?: string;
}

export interface TimesheetDay {
  date: string;
  hours_before_in_week: number;
  editable?: boolean;
  entry: TimesheetEntry | null;
}

export interface TimesheetTotals {
  days_worked: number;
  hours: number;
  regular_hours: number;
  overtime_hours: number;
  regular_cents: number;
  overtime_cents: number;
  wages_cents: number;
  addons_cents: number;
  gross_cents: number;
  open_days: number;
  approved_days: number;
  paid_days: number;
  addons_by_type?: Array<{ type: string; label: string; amount_cents: number; quantity: number }>;
}

export interface TimesheetPay {
  hourly: boolean;
  hourly_rate_cents: number | null;
  pay_method: PayMethod;
  pay_frequency: PayFrequency;
  overtime_enabled: boolean;
  overtime_after_hours: number;
  overtime_multiplier: number;
  mileage_rate_cents: number;
}

export interface TimesheetPeriod {
  start: string;
  end: string;
  frequency: PayFrequency;
  prev_start: string | null;
  next_start: string | null;
  is_current?: boolean;
}

export const PAY_METHOD_LABELS: Record<PayMethod, string> = {
  cash: 'Cash',
  payroll: 'Payroll',
  check: 'Check',
  other: 'Other',
};

export const PAY_FREQUENCY_LABELS: Record<PayFrequency, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  semimonthly: 'Twice a month (1st-15th, 16th-end)',
  monthly: 'Monthly',
};

export const STATUS_LABELS: Record<EntryStatus, string> = {
  submitted: 'Submitted',
  approved: 'Approved',
  paid: 'Paid',
};

export const BREAK_OPTIONS = [
  { minutes: 0, label: 'No lunch break' },
  { minutes: 15, label: '15 minutes' },
  { minutes: 30, label: '30 minutes' },
  { minutes: 45, label: '45 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 90, label: '1 hour 30 minutes' },
];

/**
 * What the gross means for this pay method. Cash and check: the gross is what the worker
 * is paid. Payroll: taxes are not taken out here, so the paycheck will be less.
 */
export function payNotice(method: PayMethod, audience: 'worker' | 'manager' = 'worker') {
  if (method === 'payroll') {
    return {
      tone: 'payroll' as const,
      title: 'Payroll: taxes are not taken out yet',
      body: audience === 'worker'
        ? 'This gross pay does not include payroll taxes. Federal and state income tax and FICA (Social Security and Medicare) will be taken out through payroll, so your paycheck will be less than this amount.'
        : 'Enter these hours in the payroll system. The gross shown does not include federal and state income tax or FICA (Social Security and Medicare) withholding.',
    };
  }
  if (method === 'cash' || method === 'check') {
    const how = method === 'cash' ? 'in cash' : 'by check';
    return {
      tone: 'cash' as const,
      title: `Paid ${how}: no taxes taken out`,
      body: audience === 'worker'
        ? `You are paid ${how}. Nothing is taken out, so the gross pay shown is the amount you will be paid.`
        : 'The gross shown is the amount to pay.',
    };
  }
  return {
    tone: 'neutral' as const,
    title: 'Gross pay',
    body: 'This is the gross pay before any deductions.',
  };
}

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function money(cents: number | null | undefined) {
  return currency.format((Number(cents) || 0) / 100);
}

export function hoursText(hours: number | null | undefined) {
  const value = Math.round((Number(hours) || 0) * 100) / 100;
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, '');
}

function dayDate(value: string) {
  return new Date(`${value}T12:00:00`);
}

export function formatDayLong(value: string) {
  return dayDate(value).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

export function formatWeekday(value: string) {
  return dayDate(value).toLocaleDateString('en-US', { weekday: 'short' });
}

export function formatMonthDay(value: string) {
  return dayDate(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatPeriod(start: string, end: string) {
  const startDate = dayDate(start);
  const endDate = dayDate(end);
  const sameYear = startDate.getFullYear() === endDate.getFullYear();
  const startText = startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  const endText = endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${startText} - ${endText}`;
}

export function time12(hhmm: string | null | undefined) {
  if (!hhmm) return '';
  const [hours, minutes] = hhmm.split(':').map(Number);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

export function breakText(minutes: number) {
  if (!minutes) return 'no lunch break';
  if (minutes < 60) return `${minutes} min lunch`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hr${rest ? ` ${rest} min` : ''} lunch`;
}

/** Hours from start/end minus the lunch break; a shift that ends before it starts ran past midnight. */
export function hoursFromTimes(start: string, end: string, breakMinutes: number): { hours: number | null; error: string | null } {
  if (!start || !end) return { hours: null, error: null };
  const toMinutes = (value: string) => {
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
  };
  let span = toMinutes(end) - toMinutes(start);
  if (span === 0) return { hours: null, error: 'The end time must be after the start time.' };
  if (span < 0) span += 24 * 60;
  if (breakMinutes >= span) return { hours: null, error: 'The lunch break is longer than the time worked.' };
  return { hours: Math.round(((span - breakMinutes) / 60) * 100) / 100, error: null };
}

export interface DraftAddon {
  key: string;
  type: string;
  amount: string;
  quantity: string;
  note: string;
}

export function draftAddonCents(addon: DraftAddon, types: AddonType[], mileageRateCents: number) {
  const definition = types.find(type => type.type === addon.type);
  if (!definition) return 0;
  if (definition.per_mile) return Math.round((Number(addon.quantity) || 0) * mileageRateCents);
  return Math.round((Number(addon.amount) || 0) * 100);
}

/** The day's pay, the same way the server works it out (weekly overtime counts earlier days first). */
export function previewDay({
  hours,
  pay,
  rateCents,
  hoursBeforeInWeek,
  addonsCents,
}: {
  hours: number;
  pay: TimesheetPay;
  rateCents: number;
  hoursBeforeInWeek: number;
  addonsCents: number;
}) {
  const overtimeOn = pay.hourly && pay.overtime_enabled;
  const regular = overtimeOn
    ? Math.round(Math.min(hours, Math.max(0, pay.overtime_after_hours - hoursBeforeInWeek)) * 100) / 100
    : hours;
  const overtime = Math.round((hours - regular) * 100) / 100;
  const regularCents = Math.round(regular * rateCents);
  const overtimeCents = Math.round(overtime * rateCents * pay.overtime_multiplier);
  return {
    regular,
    overtime,
    regularCents,
    overtimeCents,
    wagesCents: regularCents + overtimeCents,
    addonsCents,
    grossCents: regularCents + overtimeCents + addonsCents,
  };
}

export function draftFromAddons(addons: TimesheetAddon[]): DraftAddon[] {
  return addons.map((addon, index) => ({
    key: `saved-${index}-${addon.type}`,
    type: addon.type,
    amount: addon.quantity ? '' : (addon.amount_cents / 100).toFixed(2),
    quantity: addon.quantity ? String(addon.quantity) : '',
    note: addon.note || '',
  }));
}

export function addonsPayload(drafts: DraftAddon[], types: AddonType[]) {
  return drafts
    .filter(draft => draft.type)
    .map(draft => {
      const definition = types.find(type => type.type === draft.type);
      return definition?.per_mile
        ? { type: draft.type, quantity: draft.quantity, note: draft.note }
        : { type: draft.type, amount: draft.amount, note: draft.note };
    });
}

let draftCounter = 0;
export function newDraftAddon(type = ''): DraftAddon {
  draftCounter += 1;
  return { key: `new-${Date.now()}-${draftCounter}`, type, amount: '', quantity: '', note: '' };
}
