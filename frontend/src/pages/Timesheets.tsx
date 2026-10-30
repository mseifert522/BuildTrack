import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Link2,
  Mail,
  MessageSquare,
  Pencil,
  Plus,
  Settings2,
  Trash2,
  Undo2,
  Wallet,
} from 'lucide-react';
import toast from 'react-hot-toast';

import api from '../lib/api';
import { Loading, Modal, PageHeader } from '../components/ui';
import { useAuthStore } from '../store/authStore';
import { formatEasternDateTime, formatEasternRelative } from '../lib/time';
import {
  BREAK_OPTIONS,
  PAY_FREQUENCY_LABELS,
  PAY_METHOD_LABELS,
  STATUS_LABELS,
  addonsPayload,
  breakText,
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
import type {
  AddonType,
  DraftAddon,
  PayFrequency,
  PayMethod,
  TimesheetDay,
  TimesheetPay,
  TimesheetPeriod,
  TimesheetTotals,
} from '../lib/timesheets';

// HR > Timesheets. Managers set up field workers (rate, pay method, pay period), copy /
// text / email each worker's private timesheet link, review the days the worker enters
// from their phone, and approve or mark a pay period paid. Project managers can view.

interface WorkerLink {
  active: boolean;
  created_at: string | null;
  last_opened_at: string | null;
  last_sent_at: string | null;
  last_sent_via: string | null;
}

interface Worker {
  id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  job_title: string | null;
  employment_status: string;
  pay_type: string;
  hourly_rate_cents: number;
  pay_frequency: PayFrequency;
  pay_method: PayMethod;
  period_anchor_date: string;
  overtime_enabled: boolean;
  mileage_rate_cents: number;
  link: WorkerLink;
  current_period?: TimesheetTotals & { start: string; end: string };
}

interface WorkersResponse {
  workers: Worker[];
  other_employees: Array<{ id: string; name: string; job_title: string | null; pay_type: string; hourly_rate_cents: number }>;
  today: string;
  can_manage_links: boolean;
  texting_configured: boolean;
  email_configured: boolean;
  addon_types: AddonType[];
}

interface TimesheetEvent {
  id: string;
  action: string;
  actor_type: 'link' | 'user';
  user_name: string | null;
  user_agent: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

interface PeriodResponse {
  period: TimesheetPeriod;
  days: TimesheetDay[];
  totals: TimesheetTotals;
  pay: TimesheetPay;
  today: string;
  worker: Worker;
  events: TimesheetEvent[];
  addon_types: AddonType[];
  changed?: number;
}

const fieldClass =
  'h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-amber-600 focus:ring-2 focus:ring-amber-100';
const textAreaClass =
  'min-h-20 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-amber-600 focus:ring-2 focus:ring-amber-100';
const primaryButton =
  'inline-flex h-10 items-center justify-center gap-2 rounded-md bg-slate-900 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButton =
  'inline-flex h-10 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
const iconButton =
  'inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 transition hover:bg-slate-50 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-40';

const EVENT_LABELS: Record<string, string> = {
  worker_added: 'Set up for timesheets',
  settings_updated: 'Pay settings changed',
  link_created: 'Link created',
  link_replaced: 'New link made (old link stopped working)',
  link_turned_off: 'Link turned off',
  link_sent_sms: 'Link texted',
  link_sent_email: 'Link emailed',
  link_opened: 'Opened the timesheet link',
  day_added: 'Added a day',
  day_updated: 'Changed a day',
  day_removed: 'Removed a day',
  period_approve: 'Approved the pay period',
  period_paid: 'Marked the pay period paid',
  period_reopen: 'Reopened the pay period',
  period_unpay: 'Undid paid',
};

const STATUS_PILL: Record<string, string> = {
  submitted: 'bg-amber-50 text-amber-800 ring-amber-200',
  approved: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  paid: 'bg-slate-100 text-slate-700 ring-slate-200',
};

function errorMessage(error: unknown, fallback: string) {
  return (error as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  }
}

function linkMessage(worker: Worker, url: string) {
  return `New Urban Development: Hi ${worker.preferred_name || worker.first_name}, here is your personal timesheet link. Open it to enter the days and hours you work: ${url} This link is only for you, please don't share it.`;
}

function digitsOnly(value: string) {
  return value.replace(/\D/g, '');
}

function mondayOf(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function Field({ labelText, children, className = '', hint }: { labelText: string; children: ReactNode; className?: string; hint?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-xs font-semibold uppercase text-slate-500">{labelText}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${STATUS_PILL[status] || STATUS_PILL.paid}`}>
      {STATUS_LABELS[status as keyof typeof STATUS_LABELS] || status}
    </span>
  );
}

function MethodPill({ method }: { method: PayMethod }) {
  const tone = method === 'payroll' ? 'bg-amber-50 text-amber-800 ring-amber-200' : method === 'other' ? 'bg-slate-100 text-slate-700 ring-slate-200' : 'bg-emerald-50 text-emerald-700 ring-emerald-200';
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${tone}`}>{PAY_METHOD_LABELS[method]}</span>;
}

export default function Timesheets() {
  const { user } = useAuthStore();
  const canEdit = user?.role !== 'project_manager';
  const [list, setList] = useState<WorkersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PeriodResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [modal, setModal] = useState<null | 'add' | 'settings' | 'text' | 'email' | 'day'>(null);
  const [editingDay, setEditingDay] = useState<TimesheetDay | null>(null);
  const [busy, setBusy] = useState(false);

  const canManageLinks = Boolean(list?.can_manage_links);

  const loadWorkers = useCallback(async (selectId?: string) => {
    try {
      const response = await api.get<WorkersResponse>('/human-resources/timesheets/workers');
      setList(response.data);
      setSelectedId(current => selectId || (current && response.data.workers.some(worker => worker.id === current) ? current : response.data.workers[0]?.id || null));
    } catch (error) {
      toast.error(errorMessage(error, 'Could not load timesheets'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (workerId: string, start?: string) => {
    setDetailLoading(true);
    try {
      const response = await api.get<PeriodResponse>(`/human-resources/timesheets/workers/${workerId}/period`, { params: start ? { start } : {} });
      setDetail(response.data);
    } catch (error) {
      toast.error(errorMessage(error, 'Could not load this timesheet'));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const loadLink = useCallback(async (workerId: string) => {
    try {
      const response = await api.get<{ url: string | null }>(`/human-resources/timesheets/workers/${workerId}/link`);
      setLinkUrl(response.data.url);
    } catch {
      setLinkUrl(null);
    }
  }, []);

  useEffect(() => {
    void loadWorkers();
  }, [loadWorkers]);

  useEffect(() => {
    setLinkUrl(null);
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedId);
    if (canManageLinks) void loadLink(selectedId);
  }, [selectedId, canManageLinks, loadDetail, loadLink]);

  const worker = detail?.worker && detail.worker.id === selectedId ? detail.worker : list?.workers.find(item => item.id === selectedId) || null;

  const refreshAfterChange = async (payload?: PeriodResponse) => {
    if (payload) setDetail(payload);
    await loadWorkers(selectedId || undefined);
  };

  const copyLink = async () => {
    if (!worker) return;
    let url = linkUrl;
    if (!url) {
      try {
        const response = await api.post<{ url: string }>(`/human-resources/timesheets/workers/${worker.id}/link`, {});
        url = response.data.url;
        setLinkUrl(url);
        void loadWorkers(worker.id);
      } catch (error) {
        toast.error(errorMessage(error, 'Could not make the link'));
        return;
      }
    }
    if (await copyText(url)) toast.success(`${worker.first_name}'s timesheet link copied`);
    else toast.error('Copy did not work. Select the link and copy it by hand.');
  };

  const setPeriodStatus = async (action: 'approve' | 'paid' | 'reopen' | 'unpay') => {
    if (!worker || !detail) return;
    setBusy(true);
    try {
      const response = await api.post<PeriodResponse>(`/human-resources/timesheets/workers/${worker.id}/period/status`, {
        start: detail.period.start,
        end: detail.period.end,
        action,
      });
      const changed = response.data.changed || 0;
      const verb = { approve: 'approved', paid: 'marked paid', reopen: 'reopened', unpay: 'set back to approved' }[action];
      toast.success(changed ? `${changed} day${changed === 1 ? '' : 's'} ${verb}` : 'Nothing to change');
      await refreshAfterChange(response.data);
    } catch (error) {
      toast.error(errorMessage(error, 'Could not update the pay period'));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="bt-desktop-page mx-auto max-w-[1500px] p-4 md:p-6"><Loading message="Loading timesheets..." /></div>;
  }

  return (
    <div className="bt-desktop-page mx-auto max-w-[1500px] space-y-5 p-4 md:p-6">
      <div>
        <Link to="/human-resources" className="mb-2 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-slate-800">
          <ArrowLeft className="h-4 w-4" />
          Human Resources
        </Link>
        <PageHeader
          title="Timesheets"
          subtitle="Field workers enter their days and hours from their phone. Each worker has a private link."
          actions={canEdit ? (
            <button type="button" className={primaryButton} onClick={() => setModal('add')}>
              <Plus className="h-4 w-4" />
              Add worker
            </button>
          ) : undefined}
        />
      </div>

      {!list?.workers.length ? (
        <div className="rounded-md border border-slate-200 bg-white px-6 py-14 text-center">
          <Clock3 className="mx-auto h-8 w-8 text-amber-700" />
          <p className="mt-3 text-base font-semibold text-slate-950">No workers on timesheets yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
            Add a worker with their hourly rate and how they are paid. BuildTrack makes a private link you can copy, text or email to them.
          </p>
          {canEdit && (
            <button type="button" className={`${primaryButton} mt-5`} onClick={() => setModal('add')}>
              <Plus className="h-4 w-4" />
              Add worker
            </button>
          )}
        </div>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="space-y-2" aria-label="Workers">
            {list.workers.map(item => {
              const selected = item.id === selectedId;
              const current = item.current_period;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  aria-pressed={selected}
                  className={`w-full rounded-md border p-3 text-left transition ${selected ? 'border-amber-600 bg-white ring-2 ring-amber-600/40' : 'border-slate-200 bg-white hover:border-slate-300'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate font-semibold text-slate-950">{item.name}</p>
                    <MethodPill method={item.pay_method} />
                  </div>
                  <p className="mt-0.5 text-sm text-slate-500">
                    {item.pay_type === 'hourly' ? `${money(item.hourly_rate_cents)}/hr` : 'Salaried'} · {PAY_FREQUENCY_LABELS[item.pay_frequency]}
                  </p>
                  {current && (
                    <p className="mt-2 text-sm text-slate-700">
                      This period: <strong className="text-slate-950">{hoursText(current.hours)} hrs</strong> · <strong className="text-slate-950">{money(current.gross_cents)}</strong>
                    </p>
                  )}
                  {current && current.open_days > 0 && (
                    <p className="mt-1 text-xs font-semibold text-amber-700">{current.open_days} day{current.open_days === 1 ? '' : 's'} waiting for approval</p>
                  )}
                  <p className="mt-1 text-xs text-slate-500">
                    {!item.link.active
                      ? 'No active link'
                      : item.link.last_opened_at
                        ? `Link opened ${formatEasternRelative(item.link.last_opened_at)}`
                        : item.link.last_sent_at
                          ? `Link sent ${formatEasternRelative(item.link.last_sent_at)}, not opened yet`
                          : 'Link not sent yet'}
                  </p>
                </button>
              );
            })}
          </aside>

          {worker && (
            <section className="min-w-0 space-y-5" aria-label={`${worker.name} timesheet`}>
              <div className="rounded-md border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-lg font-bold text-slate-950">{worker.name}</h2>
                    <p className="mt-0.5 text-sm text-slate-500">
                      {worker.pay_type === 'hourly' ? `${money(worker.hourly_rate_cents)} per hour` : 'Salaried (hours only)'}
                      {' · '}Paid {PAY_METHOD_LABELS[worker.pay_method].toLowerCase()}
                      {' · '}{PAY_FREQUENCY_LABELS[worker.pay_frequency]}
                      {worker.overtime_enabled && worker.pay_type === 'hourly' ? ' · Overtime 1.5x after 40 hrs/week' : ' · No overtime'}
                    </p>
                    {(worker.phone || worker.email) && (
                      <p className="mt-0.5 text-sm text-slate-500">{[worker.phone, worker.email].filter(Boolean).join(' · ')}</p>
                    )}
                  </div>
                  {canEdit && (
                    <button type="button" className={secondaryButton} onClick={() => setModal('settings')}>
                      <Settings2 className="h-4 w-4" />
                      Worker &amp; pay settings
                    </button>
                  )}
                </div>

                <div className="mt-4 border-t border-slate-200 pt-4">
                  <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-slate-500">
                    <Link2 className="h-4 w-4 text-amber-700" />
                    {worker.first_name}'s private timesheet link
                  </p>
                  {canManageLinks ? (
                    <>
                      <div className="flex flex-col gap-2 lg:flex-row">
                        <input
                          readOnly
                          value={linkUrl || (worker.link.active ? 'Loading link...' : 'No active link. Copy, text or email makes a new one.')}
                          onFocus={event => event.currentTarget.select()}
                          className={`${fieldClass} font-mono text-xs lg:flex-1`}
                          aria-label={`${worker.first_name}'s timesheet link`}
                        />
                        <div className="flex flex-wrap gap-2">
                          <button type="button" className={primaryButton} onClick={copyLink}>
                            <Copy className="h-4 w-4" />
                            Copy link
                          </button>
                          <button type="button" className={secondaryButton} onClick={() => setModal('text')}>
                            <MessageSquare className="h-4 w-4" />
                            Text
                          </button>
                          <button type="button" className={secondaryButton} onClick={() => setModal('email')}>
                            <Mail className="h-4 w-4" />
                            Email
                          </button>
                        </div>
                      </div>
                      <p className="mt-2 text-xs text-slate-500">
                        The link opens only {worker.first_name}'s own timesheet: no other workers, no BuildTrack login.
                        {worker.link.last_sent_at && ` Last sent by ${worker.link.last_sent_via === 'sms' ? 'text' : 'email'} ${formatEasternRelative(worker.link.last_sent_at)}.`}
                        {worker.link.last_opened_at && ` Last opened ${formatEasternRelative(worker.link.last_opened_at)}.`}
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-slate-500">Operations managers and super admins can copy, text or email this link.</p>
                  )}
                </div>
              </div>

              {detail && detail.worker.id === worker.id ? (
                <PeriodPanel
                  detail={detail}
                  busy={busy || detailLoading}
                  canEdit={canEdit}
                  onNavigate={start => loadDetail(worker.id, start)}
                  onEditDay={day => {
                    setEditingDay(day);
                    setModal('day');
                  }}
                  onStatus={setPeriodStatus}
                />
              ) : (
                <Loading message="Loading timesheet..." />
              )}
            </section>
          )}
        </div>
      )}

      {modal === 'add' && list && (
        <AddWorkerModal
          list={list}
          onClose={() => setModal(null)}
          onCreated={async (created, url) => {
            if (url) setLinkUrl(url);
            await loadWorkers(created.id);
          }}
        />
      )}
      {modal === 'settings' && worker && (
        <SettingsModal
          worker={worker}
          canManageLinks={canManageLinks}
          onClose={() => setModal(null)}
          onSaved={async () => {
            await loadWorkers(worker.id);
            await loadDetail(worker.id, detail?.period.start);
          }}
          onLinkChanged={url => {
            setLinkUrl(url);
            void loadWorkers(worker.id);
          }}
        />
      )}
      {(modal === 'text' || modal === 'email') && worker && list && (
        <SendLinkModal
          channel={modal === 'text' ? 'sms' : 'email'}
          worker={worker}
          linkUrl={linkUrl}
          configured={modal === 'text' ? list.texting_configured : list.email_configured}
          onClose={() => setModal(null)}
          onSent={url => {
            setLinkUrl(url);
            void loadWorkers(worker.id);
          }}
          onCopy={copyLink}
        />
      )}
      {modal === 'day' && editingDay && detail && worker && (
        <DayModal
          key={editingDay.date}
          day={editingDay}
          detail={detail}
          workerId={worker.id}
          onClose={() => {
            setModal(null);
            setEditingDay(null);
          }}
          onSaved={async payload => {
            setModal(null);
            setEditingDay(null);
            await refreshAfterChange(payload);
          }}
        />
      )}
    </div>
  );
}

function PeriodPanel({
  detail,
  busy,
  canEdit,
  onNavigate,
  onEditDay,
  onStatus,
}: {
  detail: PeriodResponse;
  busy: boolean;
  canEdit: boolean;
  onNavigate: (start: string) => void;
  onEditDay: (day: TimesheetDay) => void;
  onStatus: (action: 'approve' | 'paid' | 'reopen' | 'unpay') => void;
}) {
  const { period, totals, pay, days, today } = detail;
  const notice = payNotice(pay.pay_method, 'manager');
  const isCurrent = period.start <= today && today <= period.end;
  const noticeClass = notice.tone === 'payroll'
    ? 'border-amber-200 bg-amber-50 text-amber-800'
    : notice.tone === 'cash'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : 'border-slate-200 bg-slate-50 text-slate-700';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button type="button" className={iconButton} onClick={() => period.prev_start && onNavigate(period.prev_start)} disabled={busy || !period.prev_start} aria-label="Previous pay period">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="min-w-[13rem] text-center">
            <p className="text-xs font-semibold uppercase text-slate-500">{isCurrent ? 'Current pay period' : 'Pay period'}</p>
            <p className="font-bold text-slate-950">{formatPeriod(period.start, period.end)}</p>
          </div>
          <button type="button" className={iconButton} onClick={() => period.next_start && onNavigate(period.next_start)} disabled={busy || !period.next_start} aria-label="Next pay period">
            <ChevronRight className="h-4 w-4" />
          </button>
          {!isCurrent && (
            <button type="button" className={secondaryButton} onClick={() => onNavigate(today)} disabled={busy}>Current period</button>
          )}
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            {totals.open_days > 0 && (
              <button type="button" className={secondaryButton} onClick={() => onStatus('approve')} disabled={busy}>
                <Check className="h-4 w-4" />
                Approve period
              </button>
            )}
            {totals.open_days + totals.approved_days > 0 && (
              <button type="button" className={primaryButton} onClick={() => onStatus('paid')} disabled={busy}>
                <Wallet className="h-4 w-4" />
                Mark paid ({PAY_METHOD_LABELS[pay.pay_method]})
              </button>
            )}
            {totals.approved_days > 0 && (
              <button type="button" className={secondaryButton} onClick={() => onStatus('reopen')} disabled={busy} title="Let the worker change approved days again">
                <Undo2 className="h-4 w-4" />
                Reopen
              </button>
            )}
            {totals.paid_days > 0 && (
              <button type="button" className={secondaryButton} onClick={() => onStatus('unpay')} disabled={busy} title="Set paid days back to approved">
                <Undo2 className="h-4 w-4" />
                Undo paid
              </button>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          { title: 'Total hours', value: hoursText(totals.hours), sub: `${totals.days_worked} day${totals.days_worked === 1 ? '' : 's'} worked` },
          { title: 'Regular / overtime', value: `${hoursText(totals.regular_hours)} / ${hoursText(totals.overtime_hours)}`, sub: pay.overtime_enabled ? 'Overtime after 40 hrs/week' : 'No overtime' },
          { title: 'Hours pay', value: pay.hourly ? money(totals.wages_cents) : '-', sub: pay.hourly ? `${money(pay.hourly_rate_cents)}/hr` : 'Salaried' },
          { title: 'Extras', value: money(totals.addons_cents), sub: (totals.addons_by_type || []).map(addon => addon.label).join(', ') || 'None' },
          { title: 'Gross pay', value: money(totals.gross_cents), sub: pay.pay_method === 'payroll' ? 'Before payroll taxes' : `Paid ${PAY_METHOD_LABELS[pay.pay_method].toLowerCase()}` },
        ].map(card => (
          <div key={card.title} className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase text-slate-500">{card.title}</p>
            <p className="mt-2 text-2xl font-bold text-slate-950">{card.value}</p>
            <p className="mt-1 truncate text-xs text-slate-500" title={card.sub}>{card.sub}</p>
          </div>
        ))}
      </div>

      <div className={`rounded-md border px-4 py-3 text-sm ${noticeClass}`}>
        <strong className="font-semibold">{notice.title}.</strong> {notice.body}
      </div>

      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">Day</th>
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3">Hours</th>
              <th className="px-4 py-3">Job site</th>
              <th className="px-4 py-3">Extras</th>
              <th className="px-4 py-3 text-right">Day gross</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 bg-white">
            {days.map(day => {
              const entry = day.entry;
              const future = day.date > today;
              return (
                <tr key={day.date} className={entry ? '' : 'text-slate-500'}>
                  <td className="whitespace-nowrap px-4 py-3">
                    <span className="font-semibold text-slate-950">{formatWeekday(day.date)}</span> {formatMonthDay(day.date)}
                    {day.date === today && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-inset ring-amber-200">Today</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {entry ? (entry.start_time ? `${time12(entry.start_time)} - ${time12(entry.end_time)}` : 'Hours only') : '-'}
                    {entry?.start_time && <span className="block text-xs text-slate-500">{breakText(entry.break_minutes)}</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {entry ? (
                      <>
                        <span className="font-semibold text-slate-950">{hoursText(entry.hours)}</span>
                        {entry.overtime_hours > 0 && <span className="block text-xs text-amber-700">{hoursText(entry.overtime_hours)} overtime</span>}
                      </>
                    ) : '-'}
                  </td>
                  <td className="max-w-48 truncate px-4 py-3" title={entry?.job_site || ''}>{entry?.job_site || '-'}</td>
                  <td className="px-4 py-3">
                    {entry?.addons.length ? entry.addons.map((addon, index) => (
                      <span key={index} className="block whitespace-nowrap text-xs">
                        {addon.label}{addon.quantity ? ` (${hoursText(addon.quantity)} mi)` : ''}: <strong className="text-slate-950">{money(addon.amount_cents)}</strong>
                        {addon.note ? <span className="text-slate-500"> - {addon.note}</span> : null}
                      </span>
                    )) : '-'}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-semibold text-slate-950">{entry ? money(entry.gross_cents) : '-'}</td>
                  <td className="px-4 py-3">
                    {entry ? (
                      <>
                        <StatusPill status={entry.status} />
                        <span className="mt-1 block text-xs text-slate-500">{entry.updated_via === 'manager' ? 'Office' : 'From link'}</span>
                      </>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    {canEdit && !future && (entry ? entry.status !== 'paid' : true) && (
                      <button type="button" className={iconButton} onClick={() => onEditDay(day)} aria-label={entry ? `Edit ${formatDayLong(day.date)}` : `Add hours for ${formatDayLong(day.date)}`} title={entry ? 'Edit day' : 'Add hours'}>
                        {entry ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-slate-50 text-sm">
            <tr>
              <td className="px-4 py-3 font-semibold text-slate-950" colSpan={2}>Pay period total</td>
              <td className="px-4 py-3 font-semibold text-slate-950">{hoursText(totals.hours)}</td>
              <td className="px-4 py-3" />
              <td className="px-4 py-3 font-semibold text-slate-950">{money(totals.addons_cents)}</td>
              <td className="px-4 py-3 text-right text-base font-bold text-slate-950">{money(totals.gross_cents)}</td>
              <td className="px-4 py-3" colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>

      {detail.events.length > 0 && (
        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-bold uppercase text-slate-700">Activity</h3>
          <ul className="space-y-2 text-sm">
            {detail.events.slice(0, 12).map(event => {
              const workDate = typeof event.details?.work_date === 'string' ? event.details.work_date : null;
              return (
                <li key={event.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 pb-2 last:border-0 last:pb-0">
                  <span className="text-slate-700">
                    <strong className="text-slate-950">{event.actor_type === 'link' ? `${detail.worker.first_name} (link)` : event.user_name || 'Office'}</strong>
                    {' '}{EVENT_LABELS[event.action] || event.action}
                    {workDate ? ` - ${formatDayLong(workDate)}` : ''}
                    {typeof event.details?.to === 'string' ? ` to ${event.details.to}` : ''}
                  </span>
                  <span className="text-xs text-slate-500" title={event.user_agent || undefined}>{formatEasternDateTime(event.created_at)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function AddWorkerModal({
  list,
  onClose,
  onCreated,
}: {
  list: WorkersResponse;
  onClose: () => void;
  onCreated: (worker: Worker, url: string | null) => Promise<void>;
}) {
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [form, setForm] = useState({
    employee_id: '',
    first_name: '',
    last_name: '',
    phone: '',
    email: '',
    hourly_rate: '',
    pay_method: 'cash' as PayMethod,
    pay_frequency: 'weekly' as PayFrequency,
    period_anchor_date: mondayOf(list.today),
    overtime_enabled: true,
    mileage_rate: '0.70',
  });
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<{ worker: Worker; url: string | null } | null>(null);
  const set = (patch: Partial<typeof form>) => setForm(current => ({ ...current, ...patch }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const body = {
        ...(mode === 'existing'
          ? { employee_id: form.employee_id }
          : { first_name: form.first_name, last_name: form.last_name, phone: form.phone, email: form.email }),
        hourly_rate: form.hourly_rate,
        pay_method: form.pay_method,
        pay_frequency: form.pay_frequency,
        period_anchor_date: form.period_anchor_date,
        overtime_enabled: form.overtime_enabled,
        mileage_rate: form.mileage_rate,
      };
      const response = await api.post<{ worker: Worker; link_url: string | null }>('/human-resources/timesheets/workers', body);
      setCreated({ worker: response.data.worker, url: response.data.link_url });
      await onCreated(response.data.worker, response.data.link_url);
      toast.success(`${response.data.worker.first_name} is set up for timesheets`);
    } catch (error) {
      toast.error(errorMessage(error, 'Could not add the worker'));
    } finally {
      setSaving(false);
    }
  };

  if (created) {
    return (
      <Modal isOpen onClose={onClose} title={`${created.worker.first_name} is ready`} size="lg">
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            Send {created.worker.first_name} this link. It opens their own timesheet on any iPhone or Android phone, where they enter the days and hours they work.
          </p>
          {created.url ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <input readOnly value={created.url} onFocus={event => event.currentTarget.select()} className={`${fieldClass} font-mono text-xs`} aria-label="Timesheet link" />
              <button
                type="button"
                className={primaryButton}
                onClick={async () => {
                  if (await copyText(created.url || '')) toast.success('Link copied');
                }}
              >
                <Copy className="h-4 w-4" />
                Copy link
              </button>
            </div>
          ) : (
            <p className="text-sm text-slate-500">An operations manager or super admin can copy and send the link.</p>
          )}
          <p className="text-xs text-slate-500">You can copy, text or email the link any time from this page.</p>
          <div className="flex justify-end border-t border-slate-200 pt-4">
            <button type="button" className={primaryButton} onClick={onClose}>Done</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen onClose={onClose} title="Add a worker to timesheets" size="lg">
      <form onSubmit={submit} className="space-y-5">
        {list.other_employees.length > 0 && (
          <div className="inline-flex rounded-md border border-slate-300 p-1">
            {(['new', 'existing'] as const).map(option => (
              <button
                key={option}
                type="button"
                onClick={() => setMode(option)}
                className={`h-8 rounded px-3 text-sm font-semibold ${mode === option ? 'bg-slate-900 text-white' : 'text-slate-600'}`}
              >
                {option === 'new' ? 'New worker' : 'Existing HR employee'}
              </button>
            ))}
          </div>
        )}

        {mode === 'existing' ? (
          <Field labelText="Employee">
            <select
              required
              className={fieldClass}
              value={form.employee_id}
              onChange={event => {
                const picked = list.other_employees.find(employee => employee.id === event.target.value);
                set({
                  employee_id: event.target.value,
                  hourly_rate: picked && picked.pay_type === 'hourly' && picked.hourly_rate_cents ? (picked.hourly_rate_cents / 100).toFixed(2) : form.hourly_rate,
                });
              }}
            >
              <option value="">Select employee</option>
              {list.other_employees.map(employee => (
                <option key={employee.id} value={employee.id}>{employee.name}{employee.job_title ? ` - ${employee.job_title}` : ''}</option>
              ))}
            </select>
          </Field>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field labelText="First name"><input required className={fieldClass} value={form.first_name} onChange={event => set({ first_name: event.target.value })} autoComplete="off" /></Field>
            <Field labelText="Last name (optional)"><input className={fieldClass} value={form.last_name} onChange={event => set({ last_name: event.target.value })} autoComplete="off" /></Field>
            <Field labelText="Mobile phone" hint="For texting the link"><input className={fieldClass} inputMode="tel" value={form.phone} onChange={event => set({ phone: event.target.value })} placeholder="(248) 555-0100" autoComplete="off" /></Field>
            <Field labelText="Email (optional)"><input type="email" className={fieldClass} value={form.email} onChange={event => set({ email: event.target.value })} autoComplete="off" /></Field>
          </div>
        )}

        <PayFields form={form} set={set} />

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <button type="button" className={secondaryButton} onClick={onClose}>Cancel</button>
          <button type="submit" className={primaryButton} disabled={saving}>{saving ? 'Saving...' : 'Add worker'}</button>
        </div>
      </form>
    </Modal>
  );
}

interface PayForm {
  hourly_rate: string;
  pay_method: PayMethod;
  pay_frequency: PayFrequency;
  period_anchor_date: string;
  overtime_enabled: boolean;
  mileage_rate: string;
}

function PayFields<T extends PayForm>({ form, set }: { form: T; set: (patch: Partial<T>) => void }) {
  const notice = payNotice(form.pay_method, 'manager');
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field labelText="Hourly rate">
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">$</span>
            <input required type="number" min="0.01" max="1000" step="0.01" className={`${fieldClass} pl-7`} value={form.hourly_rate} onChange={event => set({ hourly_rate: event.target.value } as Partial<T>)} placeholder="25.00" />
          </div>
        </Field>
        <Field labelText="Paid by">
          <select className={fieldClass} value={form.pay_method} onChange={event => set({ pay_method: event.target.value as PayMethod } as Partial<T>)}>
            {(Object.keys(PAY_METHOD_LABELS) as PayMethod[]).map(method => <option key={method} value={method}>{PAY_METHOD_LABELS[method]}</option>)}
          </select>
        </Field>
        <Field labelText="Pay period">
          <select className={fieldClass} value={form.pay_frequency} onChange={event => set({ pay_frequency: event.target.value as PayFrequency } as Partial<T>)}>
            {(Object.keys(PAY_FREQUENCY_LABELS) as PayFrequency[]).map(frequency => <option key={frequency} value={frequency}>{PAY_FREQUENCY_LABELS[frequency]}</option>)}
          </select>
        </Field>
        {form.pay_frequency === 'weekly' || form.pay_frequency === 'biweekly' ? (
          <Field labelText="First day of a pay period" hint={`Periods repeat every ${form.pay_frequency === 'weekly' ? 'week' : '2 weeks'} from this day.`}>
            <input required type="date" className={fieldClass} value={form.period_anchor_date} onChange={event => set({ period_anchor_date: event.target.value } as Partial<T>)} />
          </Field>
        ) : (
          <div className="self-end pb-2 text-xs text-slate-500">
            {form.pay_frequency === 'semimonthly' ? 'Periods run the 1st-15th and the 16th to the end of the month.' : 'Periods run the whole calendar month.'}
          </div>
        )}
        <Field labelText="Mileage rate (per mile)">
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">$</span>
            <input type="number" min="0" max="10" step="0.01" className={`${fieldClass} pl-7`} value={form.mileage_rate} onChange={event => set({ mileage_rate: event.target.value } as Partial<T>)} />
          </div>
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-700">
          <input type="checkbox" className="h-4 w-4" checked={form.overtime_enabled} onChange={event => set({ overtime_enabled: event.target.checked } as Partial<T>)} />
          Overtime at 1.5x after 40 hours in a week
        </label>
      </div>
      <p className={`rounded-md border px-3 py-2 text-xs ${notice.tone === 'payroll' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
        <strong>{notice.title}.</strong> {payNotice(form.pay_method, 'worker').body} (This is what the worker sees on their timesheet.)
      </p>
    </div>
  );
}

function SettingsModal({
  worker,
  canManageLinks,
  onClose,
  onSaved,
  onLinkChanged,
}: {
  worker: Worker;
  canManageLinks: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onLinkChanged: (url: string | null) => void;
}) {
  const [form, setForm] = useState({
    first_name: worker.first_name,
    last_name: worker.last_name || '',
    phone: worker.phone || '',
    email: worker.email || '',
    hourly_rate: (worker.hourly_rate_cents / 100).toFixed(2),
    pay_method: worker.pay_method,
    pay_frequency: worker.pay_frequency,
    period_anchor_date: worker.period_anchor_date,
    overtime_enabled: worker.overtime_enabled,
    mileage_rate: (worker.mileage_rate_cents / 100).toFixed(2),
  });
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<null | 'rotate' | 'off'>(null);
  const set = (patch: Partial<typeof form>) => setForm(current => ({ ...current, ...patch }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api.patch(`/human-resources/timesheets/workers/${worker.id}`, form);
      toast.success('Saved');
      await onSaved();
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, 'Could not save'));
    } finally {
      setSaving(false);
    }
  };

  const changeLink = async (action: 'rotate' | 'off') => {
    if (confirm !== action) {
      setConfirm(action);
      return;
    }
    setSaving(true);
    try {
      if (action === 'rotate') {
        const response = await api.post<{ url: string }>(`/human-resources/timesheets/workers/${worker.id}/link`, { rotate: true });
        onLinkChanged(response.data.url);
        toast.success('New link made. Send it to the worker: the old one no longer works.');
      } else {
        await api.delete(`/human-resources/timesheets/workers/${worker.id}/link`);
        onLinkChanged(null);
        toast.success('Link turned off');
      }
      setConfirm(null);
    } catch (error) {
      toast.error(errorMessage(error, 'Could not change the link'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`${worker.name}: worker & pay settings`} size="lg">
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field labelText="First name"><input required className={fieldClass} value={form.first_name} onChange={event => set({ first_name: event.target.value })} /></Field>
          <Field labelText="Last name"><input className={fieldClass} value={form.last_name} onChange={event => set({ last_name: event.target.value })} /></Field>
          <Field labelText="Mobile phone"><input className={fieldClass} inputMode="tel" value={form.phone} onChange={event => set({ phone: event.target.value })} /></Field>
          <Field labelText="Email"><input type="email" className={fieldClass} value={form.email} onChange={event => set({ email: event.target.value })} /></Field>
        </div>
        <PayFields form={form} set={set} />
        <p className="text-xs text-slate-500">
          Days that are not approved yet use these settings right away. Approved and paid days keep the rate and pay method they were approved with.
        </p>

        {canManageLinks && (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase text-slate-500">Timesheet link</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className={secondaryButton} onClick={() => changeLink('rotate')} disabled={saving}>
                <Link2 className="h-4 w-4" />
                {confirm === 'rotate' ? 'Click again: old link stops working' : 'Make a new link'}
              </button>
              {worker.link.active && (
                <button type="button" className={secondaryButton} onClick={() => changeLink('off')} disabled={saving}>
                  <Trash2 className="h-4 w-4" />
                  {confirm === 'off' ? 'Click again to turn it off' : 'Turn link off'}
                </button>
              )}
            </div>
            <p className="mt-2 text-xs text-slate-500">Use these if a link was shared with the wrong person or the worker no longer works for you. Their saved days stay.</p>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <button type="button" className={secondaryButton} onClick={onClose}>Cancel</button>
          <button type="submit" className={primaryButton} disabled={saving}>{saving ? 'Saving...' : 'Save settings'}</button>
        </div>
      </form>
    </Modal>
  );
}

function SendLinkModal({
  channel,
  worker,
  linkUrl,
  configured,
  onClose,
  onSent,
  onCopy,
}: {
  channel: 'sms' | 'email';
  worker: Worker;
  linkUrl: string | null;
  configured: boolean;
  onClose: () => void;
  onSent: (url: string) => void;
  onCopy: () => Promise<void>;
}) {
  const [to, setTo] = useState(channel === 'sms' ? worker.phone || '' : worker.email || '');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const message = linkUrl ? linkMessage(worker, linkUrl) : '';
  const phoneDigits = digitsOnly(to);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    setSending(true);
    setResult(null);
    try {
      const response = await api.post<{ to: string; url: string }>(`/human-resources/timesheets/workers/${worker.id}/link/send`, { channel, to });
      onSent(response.data.url);
      const done = `${channel === 'sms' ? 'Text' : 'Email'} sent to ${response.data.to}`;
      setResult(done);
      toast.success(done);
    } catch (error) {
      toast.error(errorMessage(error, channel === 'sms' ? 'The text was not sent' : 'The email was not sent'));
    } finally {
      setSending(false);
    }
  };

  const fallbackHref = channel === 'sms'
    ? (phoneDigits.length >= 10 && message ? `sms:${phoneDigits}?&body=${encodeURIComponent(message)}` : null)
    : (to && message ? `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent('Your New Urban Development timesheet link')}&body=${encodeURIComponent(message)}` : null);

  return (
    <Modal isOpen onClose={onClose} title={channel === 'sms' ? `Text the link to ${worker.first_name}` : `Email the link to ${worker.first_name}`} size="md">
      <form onSubmit={send} className="space-y-4">
        <Field labelText={channel === 'sms' ? 'Mobile number' : 'Email address'}>
          <input
            required
            type={channel === 'sms' ? 'tel' : 'email'}
            inputMode={channel === 'sms' ? 'tel' : 'email'}
            className={fieldClass}
            value={to}
            onChange={event => setTo(event.target.value)}
            placeholder={channel === 'sms' ? '(248) 555-0100' : 'name@example.com'}
          />
        </Field>
        {message && (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
            <p className="mb-1 text-xs font-semibold uppercase text-slate-500">{channel === 'sms' ? 'Text message' : 'The email says'}</p>
            {channel === 'sms'
              ? message
              : `Hi ${worker.first_name}, use this link to enter the days and hours you work, plus gas money, lunch and other expenses: ${linkUrl}`}
          </div>
        )}
        {!configured && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {channel === 'sms' ? 'Texting from BuildTrack is not switched on yet.' : 'Email is not set up on BuildTrack.'} Use the buttons below to send it yourself.
          </p>
        )}
        {result && <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{result}</p>}
        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-4">
          <button type="button" className={secondaryButton} onClick={onCopy}>
            <Copy className="h-4 w-4" />
            Copy link
          </button>
          {fallbackHref && (
            <a className={secondaryButton} href={fallbackHref}>
              {channel === 'sms' ? <MessageSquare className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
              {channel === 'sms' ? 'Open my texting app' : 'Open my email app'}
            </a>
          )}
          <button type="submit" className={primaryButton} disabled={sending || !configured}>
            {channel === 'sms' ? <MessageSquare className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
            {sending ? 'Sending...' : channel === 'sms' ? 'Send text' : 'Send email'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DayModal({
  day,
  detail,
  workerId,
  onClose,
  onSaved,
}: {
  day: TimesheetDay;
  detail: PeriodResponse;
  workerId: string;
  onClose: () => void;
  onSaved: (payload: PeriodResponse) => Promise<void>;
}) {
  const entry = day.entry;
  const types = detail.addon_types;
  const { pay } = detail;
  const [mode, setMode] = useState<'times' | 'hours'>(entry && !entry.start_time ? 'hours' : 'times');
  const [start, setStart] = useState(entry?.start_time || '');
  const [end, setEnd] = useState(entry?.end_time || '');
  const [breakMinutes, setBreakMinutes] = useState(entry?.break_minutes ?? 0);
  const [hours, setHours] = useState(entry && !entry.start_time ? String(entry.hours) : '');
  const [jobSite, setJobSite] = useState(entry?.job_site || '');
  const [notes, setNotes] = useState(entry?.notes || '');
  const [addons, setAddons] = useState<DraftAddon[]>(entry ? draftFromAddons(entry.addons) : []);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const timeResult = mode === 'times' ? hoursFromTimes(start, end, breakMinutes) : null;
  const dayHours = mode === 'times' ? (timeResult?.hours ?? 0) : Math.max(0, Math.min(24, Number(hours) || 0));
  const extrasCents = addons.reduce((sum, addon) => sum + draftAddonCents(addon, types, pay.mileage_rate_cents), 0);
  const rateCents = entry && entry.status !== 'submitted' ? entry.hourly_rate_cents : (pay.hourly_rate_cents ?? 0);
  const preview = previewDay({ hours: dayHours, pay, rateCents, hoursBeforeInWeek: day.hours_before_in_week, addonsCents: extrasCents });
  const updateAddon = (key: string, patch: Partial<DraftAddon>) => setAddons(current => current.map(addon => (addon.key === key ? { ...addon, ...patch } : addon)));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === 'times' && timeResult?.error) {
      toast.error(timeResult.error);
      return;
    }
    setSaving(true);
    try {
      const body = {
        ...(mode === 'times' ? { start_time: start, end_time: end, break_minutes: breakMinutes } : { hours: hours || 0 }),
        job_site: jobSite,
        notes,
        addons: addonsPayload(addons, types),
      };
      const response = await api.put<PeriodResponse>(`/human-resources/timesheets/workers/${workerId}/days/${day.date}`, body);
      toast.success(`Saved ${formatDayLong(day.date)}`);
      await onSaved(response.data);
    } catch (error) {
      toast.error(errorMessage(error, 'Could not save the day'));
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
    try {
      const response = await api.delete<PeriodResponse>(`/human-resources/timesheets/workers/${workerId}/days/${day.date}`);
      toast.success(`Removed ${formatDayLong(day.date)}`);
      await onSaved(response.data);
    } catch (error) {
      toast.error(errorMessage(error, 'Could not remove the day'));
      setConfirmRemove(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`${detail.worker.first_name}: ${formatDayLong(day.date)}`} size="lg">
      <form onSubmit={submit} className="space-y-5">
        <div className="inline-flex rounded-md border border-slate-300 p-1">
          {(['times', 'hours'] as const).map(option => (
            <button key={option} type="button" onClick={() => setMode(option)} className={`h-8 rounded px-3 text-sm font-semibold ${mode === option ? 'bg-slate-900 text-white' : 'text-slate-600'}`}>
              {option === 'times' ? 'Start & end time' : 'Total hours'}
            </button>
          ))}
        </div>

        {mode === 'times' ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field labelText="Start time"><input required type="time" className={fieldClass} value={start} onChange={event => setStart(event.target.value)} /></Field>
            <Field labelText="End time"><input required type="time" className={fieldClass} value={end} onChange={event => setEnd(event.target.value)} /></Field>
            <Field labelText="Lunch break (unpaid)">
              <select className={fieldClass} value={breakMinutes} onChange={event => setBreakMinutes(Number(event.target.value))}>
                {BREAK_OPTIONS.map(option => <option key={option.minutes} value={option.minutes}>{option.label}</option>)}
                {!BREAK_OPTIONS.some(option => option.minutes === breakMinutes) && <option value={breakMinutes}>{breakMinutes} minutes</option>}
              </select>
            </Field>
          </div>
        ) : (
          <Field labelText="Hours worked" className="max-w-xs">
            <input type="number" min="0" max="24" step="0.25" className={fieldClass} value={hours} onChange={event => setHours(event.target.value)} />
          </Field>
        )}
        {timeResult?.error && <p className="text-sm text-rose-700">{timeResult.error}</p>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field labelText="Job site (optional)"><input className={fieldClass} value={jobSite} onChange={event => setJobSite(event.target.value)} maxLength={200} /></Field>
          <Field labelText="Notes (optional)"><input className={fieldClass} value={notes} onChange={event => setNotes(event.target.value)} maxLength={1000} /></Field>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase text-slate-500">Extras on top of hours</p>
          {addons.map(addon => {
            const definition = types.find(type => type.type === addon.type);
            return (
              <div key={addon.key} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)_2.25rem]">
                <select required className={fieldClass} value={addon.type} onChange={event => updateAddon(addon.key, { type: event.target.value })} aria-label="Extra type">
                  <option value="" disabled>Choose...</option>
                  {types.map(type => <option key={type.type} value={type.type}>{type.label}{type.manager_only ? ' (office only)' : ''}</option>)}
                </select>
                {definition?.per_mile ? (
                  <input type="number" min="0" step="0.1" className={fieldClass} placeholder="Miles" aria-label="Miles" value={addon.quantity} onChange={event => updateAddon(addon.key, { quantity: event.target.value })} />
                ) : (
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">$</span>
                    <input type="number" min="0" step="0.01" className={`${fieldClass} pl-7`} placeholder="0.00" aria-label="Amount" value={addon.amount} onChange={event => updateAddon(addon.key, { amount: event.target.value })} />
                  </div>
                )}
                <input className={fieldClass} placeholder="Note (optional)" aria-label="Note" value={addon.note} onChange={event => updateAddon(addon.key, { note: event.target.value })} />
                <button type="button" className={iconButton} onClick={() => setAddons(current => current.filter(item => item.key !== addon.key))} aria-label="Remove extra">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            );
          })}
          <button type="button" className={secondaryButton} onClick={() => setAddons(current => [...current, newDraftAddon()])} disabled={addons.length >= 12}>
            <Plus className="h-4 w-4" />
            Add extra
          </button>
        </div>

        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          <div className="flex justify-between gap-3"><span className="text-slate-500">Hours pay {pay.hourly ? `(${hoursText(preview.regular)} x ${money(rateCents)})` : ''}</span><strong className="text-slate-950">{money(preview.regularCents)}</strong></div>
          {preview.overtime > 0 && (
            <div className="flex justify-between gap-3"><span className="text-slate-500">Overtime ({hoursText(preview.overtime)} x {money(Math.round(rateCents * pay.overtime_multiplier))})</span><strong className="text-slate-950">{money(preview.overtimeCents)}</strong></div>
          )}
          <div className="flex justify-between gap-3"><span className="text-slate-500">Extras</span><strong className="text-slate-950">{money(preview.addonsCents)}</strong></div>
          <div className="mt-2 flex justify-between gap-3 border-t border-slate-200 pt-2"><span className="font-semibold text-slate-950">Day gross ({hoursText(dayHours)} hrs)</span><strong className="text-base text-slate-950">{money(preview.grossCents)}</strong></div>
        </div>

        <div className="flex flex-wrap justify-between gap-2 border-t border-slate-200 pt-4">
          <div>
            {entry && (
              <button type="button" className={secondaryButton} onClick={remove} disabled={saving}>
                <Trash2 className="h-4 w-4" />
                {confirmRemove ? 'Click again to remove' : 'Remove day'}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" className={secondaryButton} onClick={onClose}>Cancel</button>
            <button type="submit" className={primaryButton} disabled={saving}>{saving ? 'Saving...' : 'Save day'}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
