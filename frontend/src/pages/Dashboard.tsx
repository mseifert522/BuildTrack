import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore, isAdminRole, roleLabels } from '../store/authStore';
import api from '../lib/api';
import { Loading, Modal } from '../components/ui';
import Avatar from '../components/Avatar';
import {
  Activity,
  Plus, MapPin, CalendarDays,
  Mail, Send, Edit2, ChevronLeft, ChevronRight, ChevronDown
} from 'lucide-react';
import toast from 'react-hot-toast';
import { EASTERN_TIME_ZONE, formatEasternDate, formatEasternDateTime, formatEasternRelative, formatEasternTime, parseBuildTrackTimestamp } from '../lib/time';
import VoiceTextarea from '../components/VoiceTextarea';
import AddToCalendarButton from '../components/AddToCalendarButton';

const calendarBadgeMonthFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: EASTERN_TIME_ZONE,
  month: 'short',
});

const calendarBadgeDayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: EASTERN_TIME_ZONE,
  day: 'numeric',
});

const calendarBadgeLabelFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: EASTERN_TIME_ZONE,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const calendarWeekRangeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: EASTERN_TIME_ZONE,
  month: 'short',
  day: 'numeric',
});

const calendarMonthLabelFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: EASTERN_TIME_ZONE,
  month: 'long',
  year: 'numeric',
});

const calendarWeekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CALENDAR_SCHEDULE_START_HOUR = 7;
const CALENDAR_SCHEDULE_END_HOUR = 19;
const calendarScheduleHours = Array.from(
  { length: CALENDAR_SCHEDULE_END_HOUR - CALENDAR_SCHEDULE_START_HOUR + 1 },
  (_, index) => CALENDAR_SCHEDULE_START_HOUR + index
);

const formatCalendarHourLabel = (hour: number) => {
  const normalized = hour % 24;
  const hour12 = normalized % 12 || 12;
  const suffix = normalized >= 12 ? 'PM' : 'AM';
  return `${hour12} ${suffix}`;
};

const parseCalendarDueTimeMinutes = (value?: string | null) => {
  if (!value) return null;
  const match = String(value).match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
};

const formatCalendarDueTimeLabel = (value?: string | null) => {
  const minutes = parseCalendarDueTimeMinutes(value);
  if (minutes === null) return 'No time set';
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const hour12 = hour % 12 || 12;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
};

function formatCalendarBadgeDate(value?: string | null) {
  const parsed = parseBuildTrackTimestamp(value ? `${value}T12:00:00` : null);
  if (!parsed) {
    return {
      month: '--',
      day: '--',
      label: 'Date unavailable',
    };
  }

  return {
    month: calendarBadgeMonthFormatter.format(parsed).toUpperCase(),
    day: calendarBadgeDayFormatter.format(parsed),
    label: calendarBadgeLabelFormatter.format(parsed),
  };
}

interface DashboardActivityFeedItem {
  id: string;
  feed_type: 'note' | 'activity';
  project_id?: string | null;
  user_id: string;
  user_name: string;
  user_role?: string | null;
  user_avatar_url?: string | null;
  note?: string | null;
  note_type?: string | null;
  action?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  details?: Record<string, any> | null;
  created_at: string;
  project_address?: string | null;
  project_job_name?: string | null;
  project_status?: string | null;
}

interface OperationsCalendarEvent {
  id: string;
  source: string;
  source_id: string;
  event_type: string;
  title: string;
  description?: string;
  scheduled_for: string;
  due_time?: string | null;
  status: string;
  priority: string;
  amount?: number;
  vendor_name?: string | null;
  project_id?: string | null;
  project_address?: string | null;
  project_job_name?: string | null;
  email_reminder_count?: number;
  next_email_reminder_at?: string | null;
  completion_note?: string | null;
  completed_at?: string | null;
}

type CalendarQueueFilter = 'upcoming' | 'completed';
type CalendarViewMode = 'today' | 'week' | 'month';

type CalendarEditForm = {
  title: string;
  description: string;
  scheduled_for: string;
  due_time: string;
  event_type: string;
  priority: string;
  status: string;
  completion_note: string;
};

const blankCalendarEditForm: CalendarEditForm = {
  title: '',
  description: '',
  scheduled_for: '',
  due_time: '',
  event_type: 'other',
  priority: 'normal',
  status: 'scheduled',
  completion_note: '',
};

const editableCalendarStatus = (status?: string | null) => {
  if (status === 'completed') return 'completed';
  if (status === 'in_progress') return 'in_progress';
  if (status === 'cancelled') return 'cancelled';
  return 'scheduled';
};

type CalendarWeekDayCell = {
  key: string;
  date: Date;
  dayNumber: number;
  isToday: boolean;
  isCurrentMonth?: boolean;
  label: string;
  weekday: string;
};

type CalendarScheduleDayBucket = {
  untimed: OperationsCalendarEvent[];
  byHour: Record<number, OperationsCalendarEvent[]>;
};

const calendarHourForEvent = (event: OperationsCalendarEvent) => {
  const minutes = parseCalendarDueTimeMinutes(event.due_time);
  if (minutes === null) return null;
  return Math.min(
    Math.max(Math.floor(minutes / 60), CALENDAR_SCHEDULE_START_HOUR),
    CALENDAR_SCHEDULE_END_HOUR
  );
};

const buildCalendarDayScheduleBucket = (events: OperationsCalendarEvent[]): CalendarScheduleDayBucket => {
  const byHour = calendarScheduleHours.reduce<Record<number, OperationsCalendarEvent[]>>((groups, hour) => {
    groups[hour] = [];
    return groups;
  }, {});
  const untimed: OperationsCalendarEvent[] = [];

  sortCalendarEventsForDay(events).forEach(event => {
    const hour = calendarHourForEvent(event);
    if (hour === null) {
      untimed.push(event);
      return;
    }
    byHour[hour].push(event);
  });

  return { untimed, byHour };
};

const greeting = () => {
  const h = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TIME_ZONE,
    hour: 'numeric',
    hour12: false,
  }).format(new Date()));
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
};

const noteTypeStyles: Record<string, { label: string; bg: string; color: string; border: string; accent: string }> = {
  general: { label: 'General note', bg: '#EFF6FF', color: '#1D4ED8', border: '#BFDBFE', accent: '#3B82F6' },
  office: { label: 'Office note', bg: '#FEF3C7', color: '#92400E', border: '#FDE68A', accent: '#D97706' },
  field: { label: 'Field note', bg: '#ECFDF5', color: '#047857', border: '#A7F3D0', accent: '#10B981' },
};

const projectStatusStyles: Record<string, { label: string; bg: string; color: string; border: string }> = {
  active_rehab: { label: 'Active Rehab', bg: 'rgba(16,185,129,0.12)', color: '#A7F3D0', border: 'rgba(16,185,129,0.35)' },
  not_started: { label: 'Not Started', bg: 'rgba(148,163,184,0.14)', color: '#CBD5E1', border: 'rgba(148,163,184,0.30)' },
  rehab_completed: { label: 'Completed', bg: 'rgba(59,130,246,0.14)', color: '#BFDBFE', border: 'rgba(59,130,246,0.35)' },
  long_term_holding: { label: 'Long-Term Holding', bg: 'rgba(217,119,6,0.14)', color: '#FCD34D', border: 'rgba(217,119,6,0.35)' },
  commercial: { label: 'Commercial', bg: 'rgba(14,116,144,0.14)', color: '#67E8F9', border: 'rgba(14,116,144,0.35)' },
  completed: { label: 'Completed', bg: 'rgba(59,130,246,0.14)', color: '#BFDBFE', border: 'rgba(59,130,246,0.35)' },
};

const getNoteTypeStyle = (type?: string) => noteTypeStyles[type || 'general'] || noteTypeStyles.general;
const getProjectStatusStyle = (status?: string) => (
  projectStatusStyles[status || ''] || { label: 'Project', bg: 'rgba(217,157,38,0.12)', color: '#FDE68A', border: 'rgba(217,157,38,0.35)' }
);

const formatCompactLabel = (value?: string | null) =>
  (value || 'not set')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());

const activityTypeStyles: Record<string, { label: string; bg: string; color: string; border: string; accent: string }> = {
  invoice: { label: 'Invoice', bg: 'rgba(245,158,11,0.14)', color: '#FDE68A', border: 'rgba(245,158,11,0.40)', accent: '#F59E0B' },
  calendar: { label: 'Calendar', bg: 'rgba(167,139,250,0.14)', color: '#DDD6FE', border: 'rgba(167,139,250,0.40)', accent: '#A78BFA' },
  photo: { label: 'Photo', bg: 'rgba(34,211,238,0.13)', color: '#A5F3FC', border: 'rgba(34,211,238,0.38)', accent: '#22D3EE' },
  user: { label: 'User', bg: 'rgba(16,185,129,0.13)', color: '#A7F3D0', border: 'rgba(16,185,129,0.36)', accent: '#10B981' },
  project: { label: 'Project', bg: 'rgba(96,165,250,0.14)', color: '#BFDBFE', border: 'rgba(96,165,250,0.40)', accent: '#60A5FA' },
  activity: { label: 'Activity', bg: 'rgba(148,163,184,0.14)', color: '#E2E8F0', border: 'rgba(148,163,184,0.34)', accent: '#94A3B8' },
};

const activityActionLabels: Record<string, string> = {
  calendar_event_created: 'Created calendar item',
  calendar_event_updated: 'Updated calendar item',
  calendar_event_completed: 'Completed calendar item',
  invoice_submitted: 'Submitted invoice',
  invoice_approved: 'Approved invoice',
  invoice_rejected: 'Rejected invoice',
  invoice_paid: 'Invoice marked paid',
  quickbooks_bill_approved_for_pay: 'Approved bill for payment',
  quickbooks_payment_queue_notified: 'Sent payment queue email',
  photo_uploaded: 'Uploaded progress photo',
  project_media_uploaded: 'Uploaded project media',
  progress_picture_group_note_saved: 'Saved progress picture note',
  photo_correction_deleted: 'Removed correction photo',
  project_created: 'Created project',
  project_updated: 'Updated project',
  project_status_updated: 'Updated project status',
  project_scope_created: 'Created project scope',
  contractor_note_added: 'Added contractor note',
  user_assigned: 'Assigned user',
  user_unassigned: 'Removed user assignment',
};

const getActivityTypeStyle = (item: DashboardActivityFeedItem) => {
  if (item.feed_type === 'note') return getNoteTypeStyle(item.note_type || 'general');
  const key = `${item.action || ''} ${item.entity_type || ''}`.toLowerCase();
  if (key.includes('invoice')) return activityTypeStyles.invoice;
  if (key.includes('calendar')) return activityTypeStyles.calendar;
  if (key.includes('photo')) return activityTypeStyles.photo;
  if (key.includes('user')) return activityTypeStyles.user;
  if (key.includes('project')) return activityTypeStyles.project;
  return activityTypeStyles.activity;
};

const getActivityVerb = (item: DashboardActivityFeedItem) => {
  if (item.feed_type === 'note') return 'added a note';
  return 'recorded activity';
};

const getActivitySummary = (item: DashboardActivityFeedItem) => {
  if (item.feed_type === 'note') return item.note || '';
  const action = item.action || item.entity_type || 'activity';
  const label = activityActionLabels[action] || formatCompactLabel(action);
  const details = item.details || {};
  const detailTitle = [details.title, details.address, details.vendor_name, details.status]
    .map(value => (typeof value === 'string' ? value.trim() : ''))
    .find(Boolean);
  return detailTitle ? `${label} - ${detailTitle}` : label;
};

const collapsedMediaActivityActions = new Set([
  'photo_uploaded',
  'project_media_uploaded',
  'progress_picture_group_note_saved',
]);

const activityMinuteBucket = (value?: string | null) =>
  String(value || '').replace('T', ' ').slice(0, 16);

const getActivityFeedDedupeKey = (item: DashboardActivityFeedItem) => {
  if (item.feed_type !== 'activity' || !collapsedMediaActivityActions.has(item.action || '')) {
    return `${item.feed_type}:${item.id}`;
  }

  const details = item.details || {};
  const mediaType = typeof details.type === 'string' ? details.type : '';
  const contexts = Array.isArray(details.contexts) ? details.contexts.join(',') : '';
  return [
    'media-batch',
    item.user_id,
    item.project_id || '',
    item.action || '',
    mediaType,
    contexts,
    activityMinuteBucket(item.created_at),
  ].join('|');
};

const dedupeActivityFeedItems = (items: DashboardActivityFeedItem[]) => {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = getActivityFeedDedupeKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const formatLocalDateInput = (date = new Date()) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

const localDateInputToNoonDate = (value: string) =>
  parseBuildTrackTimestamp(value ? `${value}T12:00:00` : null) || new Date(`${value}T12:00:00`);

const addCalendarDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const calendarRangeFromWeekStartKey = (weekStartKey: string) => {
  const startDate = localDateInputToNoonDate(weekStartKey);
  return {
    start: formatLocalDateInput(startDate),
    end: formatLocalDateInput(addCalendarDays(startDate, 6)),
  };
};

const startOfCalendarWeek = (anchorDate: Date) => {
  const date = new Date(anchorDate);
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - date.getDay());
  return date;
};

const startOfCalendarMonth = (anchorDate: Date) => {
  const date = new Date(anchorDate);
  date.setHours(12, 0, 0, 0);
  date.setDate(1);
  return date;
};

const endOfCalendarMonth = (anchorDate: Date) => {
  const date = startOfCalendarMonth(anchorDate);
  date.setMonth(date.getMonth() + 1, 0);
  return date;
};

const addCalendarMonths = (date: Date, months: number) => {
  const next = new Date(date);
  next.setDate(1);
  next.setMonth(next.getMonth() + months);
  next.setHours(12, 0, 0, 0);
  return next;
};

const calendarRangeForView = (viewMode: CalendarViewMode, anchorDateKey: string) => {
  const anchorDate = localDateInputToNoonDate(anchorDateKey);

  if (viewMode === 'today') {
    const key = formatLocalDateInput(anchorDate);
    return { start: key, end: key };
  }

  if (viewMode === 'week') {
    return calendarRangeFromWeekStartKey(formatLocalDateInput(startOfCalendarWeek(anchorDate)));
  }

  const monthStart = startOfCalendarMonth(anchorDate);
  const monthEnd = endOfCalendarMonth(anchorDate);
  const visibleStart = startOfCalendarWeek(monthStart);
  const visibleEnd = addCalendarDays(startOfCalendarWeek(monthEnd), 6);
  return {
    start: formatLocalDateInput(visibleStart),
    end: formatLocalDateInput(visibleEnd),
  };
};

const buildCalendarWeekDays = (weekStartDate: Date, todayKey: string): CalendarWeekDayCell[] =>
  Array.from({ length: 7 }, (_, index) => {
    const date = addCalendarDays(weekStartDate, index);
    const key = formatLocalDateInput(date);
    return {
      key,
      date,
      dayNumber: date.getDate(),
      isToday: key === todayKey,
      label: formatCalendarBadgeDate(key).label,
      weekday: calendarWeekdayLabels[index],
    };
  });

const buildCalendarMonthDays = (anchorDate: Date, todayKey: string): CalendarWeekDayCell[] => {
  const monthStart = startOfCalendarMonth(anchorDate);
  const visibleStart = startOfCalendarWeek(monthStart);
  const activeMonth = monthStart.getMonth();

  return Array.from({ length: 42 }, (_, index) => {
    const date = addCalendarDays(visibleStart, index);
    const key = formatLocalDateInput(date);
    return {
      key,
      date,
      dayNumber: date.getDate(),
      isToday: key === todayKey,
      isCurrentMonth: date.getMonth() === activeMonth,
      label: formatCalendarBadgeDate(key).label,
      weekday: calendarWeekdayLabels[date.getDay()],
    };
  });
};

const formatCalendarWeekRange = (weekStartDate: Date, weekEndDate: Date) =>
  `${calendarWeekRangeFormatter.format(weekStartDate)} - ${calendarWeekRangeFormatter.format(weekEndDate)}`;

const calendarDateKeyForEvent = (event: OperationsCalendarEvent) =>
  event.scheduled_for || (event.completed_at ? String(event.completed_at).slice(0, 10) : '');

const sortCalendarEventsForDay = (events: OperationsCalendarEvent[]) =>
  [...events].sort((a, b) => {
    const timeCompare = String(a.due_time || '99:99').localeCompare(String(b.due_time || '99:99'));
    if (timeCompare !== 0) return timeCompare;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });

const sortCalendarEventsForRange = (events: OperationsCalendarEvent[]) =>
  [...events].sort((a, b) => {
    const dateCompare = String(calendarDateKeyForEvent(a) || '').localeCompare(String(calendarDateKeyForEvent(b) || ''));
    if (dateCompare !== 0) return dateCompare;
    const timeCompare = String(a.due_time || '99:99').localeCompare(String(b.due_time || '99:99'));
    if (timeCompare !== 0) return timeCompare;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });

const getCalendarProjectLabel = (event: OperationsCalendarEvent) =>
  event.project_address || event.project_job_name || event.project_id || 'BuildTrack';

const defaultReminderTime = () => {
  const date = new Date(Date.now() + 30 * 60 * 1000);
  const roundedMinutes = Math.ceil(date.getMinutes() / 15) * 15;
  if (roundedMinutes >= 60) {
    date.setHours(date.getHours() + 1);
    date.setMinutes(0, 0, 0);
  } else {
    date.setMinutes(roundedMinutes, 0, 0);
  }
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

const splitReminderEmails = (value: string) =>
  value
    .split(/[\s,;]+/)
    .map(item => item.trim())
    .filter(Boolean);

const localDateTimeToIso = (date: string, time: string) => new Date(`${date}T${time || '09:00'}`).toISOString();


export default function Dashboard() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [activityFeed, setActivityFeed] = useState<DashboardActivityFeedItem[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<OperationsCalendarEvent[]>([]);
  const [showCalendarReminderComposer, setShowCalendarReminderComposer] = useState(false);
  const [reminderTitle, setReminderTitle] = useState('');
  const [reminderRecipients, setReminderRecipients] = useState('');
  const [reminderMessage, setReminderMessage] = useState('');
  const [reminderScheduleType, setReminderScheduleType] = useState<'now' | 'once' | 'weekly' | 'monthly'>('once');
  const [reminderDate, setReminderDate] = useState(formatLocalDateInput());
  const [reminderTime, setReminderTime] = useState(defaultReminderTime());
  const [reminderEventType, setReminderEventType] = useState('other');
  const [reminderPriority, setReminderPriority] = useState('normal');
  const [savingCalendarReminder, setSavingCalendarReminder] = useState(false);
  const [calendarCompletionNotes, setCalendarCompletionNotes] = useState<Record<string, string>>({});
  const [savingCalendarEventId, setSavingCalendarEventId] = useState('');
  const [expandedCalendarNoteId, setExpandedCalendarNoteId] = useState<string | null>(null);
  const [calendarQueueFilter, setCalendarQueueFilter] = useState<CalendarQueueFilter>('upcoming');
  const [calendarViewMode, setCalendarViewMode] = useState<CalendarViewMode>('today');
  const [calendarAnchorDateKey, setCalendarAnchorDateKey] = useState(() => formatLocalDateInput());
  const [calendarExpanded, setCalendarExpanded] = useState(false);
  const [editingCalendarEvent, setEditingCalendarEvent] = useState<OperationsCalendarEvent | null>(null);
  const [calendarEditForm, setCalendarEditForm] = useState<CalendarEditForm>(blankCalendarEditForm);
  const [savingCalendarEdit, setSavingCalendarEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const calendarQueryRange = calendarRangeForView(calendarViewMode, calendarAnchorDateKey);

  useEffect(() => {
    const load = async () => {
      try {
        const [feedRes, calendarRes] = await Promise.all([
          api.get('/dashboard/activity-feed?limit=25').catch(() => ({ data: { items: [] } })),
          api.get(`/calendar/events?start=${encodeURIComponent(calendarQueryRange.start)}&end=${encodeURIComponent(calendarQueryRange.end)}`).catch(() => ({ data: { events: [] } })),
        ]);
        const feedItems = Array.isArray(feedRes.data?.items)
          ? feedRes.data.items
          : Array.isArray(feedRes.data)
            ? feedRes.data
            : [];
        setActivityFeed(dedupeActivityFeedItems(feedItems).slice(0, 25));
        setCalendarEvents(Array.isArray(calendarRes.data?.events) ? calendarRes.data.events : []);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [user?.id, user?.role, calendarQueryRange.start, calendarQueryRange.end]);

  if (loading) return <Loading />;

  const firstName = user?.name?.split(' ')[0] || 'there';
  const now = new Date();

  const openCalendarReminderComposer = () => {
    setReminderTitle('BuildTrack reminder');
    setReminderRecipients('');
    setReminderMessage('');
    setReminderScheduleType('once');
    setReminderDate(formatLocalDateInput());
    setReminderTime(defaultReminderTime());
    setReminderEventType('other');
    setReminderPriority('normal');
    setShowCalendarReminderComposer(true);
  };

  const refreshCalendarEvents = async (anchorDateKey = calendarAnchorDateKey, viewMode = calendarViewMode) => {
    const range = calendarRangeForView(viewMode, anchorDateKey);
    const res = await api.get(`/calendar/events?start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}`);
    setCalendarEvents(Array.isArray(res.data?.events) ? res.data.events : []);
  };

  const calendarNoteDraft = (event: OperationsCalendarEvent) =>
    calendarCompletionNotes[event.id] ?? event.completion_note ?? '';

  const updateCalendarCompletionNote = (eventId: string, value: string) => {
    setCalendarCompletionNotes(current => ({ ...current, [eventId]: value }));
  };

  const updateCalendarEditField = (field: keyof CalendarEditForm, value: string) => {
    setCalendarEditForm(current => ({ ...current, [field]: value }));
  };

  const openCalendarEntryEditor = (event: OperationsCalendarEvent) => {
    setEditingCalendarEvent(event);
    setCalendarEditForm({
      title: event.title || '',
      description: event.description || '',
      scheduled_for: event.scheduled_for || formatLocalDateInput(),
      due_time: event.due_time || '',
      event_type: event.event_type || 'other',
      priority: event.priority || 'normal',
      status: editableCalendarStatus(event.status),
      completion_note: calendarNoteDraft(event),
    });
  };

  const closeCalendarEntryEditor = () => {
    if (savingCalendarEdit) return;
    setEditingCalendarEvent(null);
    setCalendarEditForm(blankCalendarEditForm);
  };

  const saveCalendarEntryEdit = async () => {
    if (!editingCalendarEvent) return;
    if (!calendarEditForm.title.trim()) {
      toast.error('Calendar title is required');
      return;
    }
    if (!calendarEditForm.scheduled_for) {
      toast.error('Calendar date is required');
      return;
    }

    setSavingCalendarEdit(true);
    setSavingCalendarEventId(editingCalendarEvent.id);
    try {
      const payload: Record<string, any> = {
        title: calendarEditForm.title.trim(),
        description: calendarEditForm.description.trim() || null,
        scheduled_for: calendarEditForm.scheduled_for,
        completion_note: calendarEditForm.completion_note,
      };
      if (editingCalendarEvent.source === 'construction_task') {
        if (calendarEditForm.status !== editableCalendarStatus(editingCalendarEvent.status)) {
          payload.status = calendarEditForm.status;
        }
      } else {
        payload.due_time = calendarEditForm.due_time || null;
        payload.event_type = calendarEditForm.event_type;
        payload.priority = calendarEditForm.priority;
        payload.status = calendarEditForm.status;
      }
      await api.put(`/calendar/events/${editingCalendarEvent.id}`, payload);
      setCalendarCompletionNotes(current => ({
        ...current,
        [editingCalendarEvent.id]: calendarEditForm.completion_note,
      }));
      setEditingCalendarEvent(null);
      setCalendarEditForm(blankCalendarEditForm);
      setCalendarAnchorDateKey(calendarEditForm.scheduled_for);
      await refreshCalendarEvents(calendarEditForm.scheduled_for, calendarViewMode);
      toast.success('Calendar entry updated');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update calendar entry');
    } finally {
      setSavingCalendarEdit(false);
      setSavingCalendarEventId('');
    }
  };

  const saveCalendarEventUpdate = async (event: OperationsCalendarEvent, patch: Record<string, any>) => {
    setSavingCalendarEventId(event.id);
    try {
      const payload = {
        status: patch.status ?? event.status,
        completion_note: patch.completion_note !== undefined ? patch.completion_note : calendarNoteDraft(event),
      };
      await api.put(`/calendar/events/${event.id}`, payload);
      await refreshCalendarEvents();
      if (patch.completion_note !== undefined) setExpandedCalendarNoteId(null);
      toast.success(payload.status === 'completed' ? 'Calendar task marked complete' : 'Calendar task updated');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update calendar task');
    } finally {
      setSavingCalendarEventId('');
    }
  };

  const saveCalendarEmailReminder = async () => {
    const recipients = splitReminderEmails(reminderRecipients);
    if (!reminderTitle.trim()) {
      toast.error('Reminder title is required');
      return;
    }
    if (!recipients.length) {
      toast.error('Enter at least one reminder email');
      return;
    }
    if (reminderScheduleType !== 'now' && (!reminderDate || !reminderTime)) {
      toast.error('Choose the reminder date and time');
      return;
    }

    setSavingCalendarReminder(true);
    try {
      const scheduledFor = reminderDate || formatLocalDateInput();
      const sendAt = reminderScheduleType === 'now' ? new Date().toISOString() : localDateTimeToIso(reminderDate, reminderTime);
      const res = await api.post('/calendar/events', {
        title: reminderTitle.trim(),
        description: reminderMessage.trim() || null,
        event_type: reminderEventType,
        scheduled_for: scheduledFor,
        due_time: reminderTime || null,
        priority: reminderPriority,
        source_type: 'manual',
        email_reminder: {
          enabled: true,
          recipients,
          subject: reminderTitle.trim(),
          message: reminderMessage.trim() || reminderTitle.trim(),
          schedule_type: reminderScheduleType,
          send_at: sendAt,
        },
      });
      if (res.data?.warning) {
        toast.error(res.data.warning);
      } else {
        toast.success(reminderScheduleType === 'now' ? 'Reminder email sent' : 'Email reminder scheduled');
      }
      setShowCalendarReminderComposer(false);
      setCalendarAnchorDateKey(scheduledFor);
      await refreshCalendarEvents(scheduledFor, calendarViewMode);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to save email reminder');
    } finally {
      setSavingCalendarReminder(false);
    }
  };

  const todayKey = formatLocalDateInput(now);
  const calendarAnchorDate = localDateInputToNoonDate(calendarAnchorDateKey);
  const currentWeekStartDate = startOfCalendarWeek(calendarAnchorDate);
  const currentWeekEndDate = addCalendarDays(currentWeekStartDate, 6);
  const calendarMonthStartDate = startOfCalendarMonth(calendarAnchorDate);
  const calendarVisibleWeekDays = buildCalendarWeekDays(currentWeekStartDate, todayKey);
  const calendarVisibleMonthDays = buildCalendarMonthDays(calendarAnchorDate, todayKey);
  const calendarViewRangeStartKey = calendarQueryRange.start;
  const calendarViewRangeEndKey = calendarQueryRange.end;
  const calendarViewTitle = calendarViewMode === 'today'
    ? formatEasternDate(`${calendarAnchorDateKey}T12:00:00`, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : calendarViewMode === 'week'
      ? `Week of ${formatCalendarWeekRange(currentWeekStartDate, currentWeekEndDate)}`
      : calendarMonthLabelFormatter.format(calendarMonthStartDate);
  const calendarViewKicker = calendarViewMode === 'today'
    ? (calendarAnchorDateKey === todayKey ? "Today's schedule" : 'Daily schedule')
    : calendarViewMode === 'week'
      ? 'Weekly schedule'
      : 'Monthly schedule';
  const jumpToCalendarDate = (dateKey: string) => {
    if (!dateKey) return;
    setCalendarAnchorDateKey(dateKey);
    setExpandedCalendarNoteId(null);
  };
  const changeCalendarViewMode = (viewMode: CalendarViewMode) => {
    setCalendarViewMode(viewMode);
    if (viewMode === 'today') setCalendarAnchorDateKey(todayKey);
    setExpandedCalendarNoteId(null);
  };
  const moveCalendarPeriod = (offset: number) => {
    setCalendarAnchorDateKey(current => {
      const anchor = localDateInputToNoonDate(current);
      if (calendarViewMode === 'today') return formatLocalDateInput(addCalendarDays(anchor, offset));
      if (calendarViewMode === 'week') return formatLocalDateInput(addCalendarDays(anchor, offset * 7));
      return formatLocalDateInput(addCalendarMonths(anchor, offset));
    });
    setExpandedCalendarNoteId(null);
  };
  const jumpToTodayCalendarView = () => {
    setCalendarViewMode('today');
    setCalendarAnchorDateKey(todayKey);
    setExpandedCalendarNoteId(null);
  };
  const isCurrentViewEvent = (event: OperationsCalendarEvent) => {
    const eventDateKey = calendarDateKeyForEvent(event);
    return Boolean(eventDateKey && eventDateKey >= calendarViewRangeStartKey && eventDateKey <= calendarViewRangeEndKey);
  };
  const upcomingCalendarEvents = calendarEvents.filter(event =>
    event.status !== 'completed' && isCurrentViewEvent(event)
  );
  const completedCalendarEvents = calendarEvents.filter(event => event.status === 'completed' && isCurrentViewEvent(event));
  const displayedCalendarEvents = calendarQueueFilter === 'completed' ? completedCalendarEvents : upcomingCalendarEvents;
  const calendarViewEventCount = displayedCalendarEvents.length;
  const canCreateCalendarReminders = Boolean(user && isAdminRole(user.role));
  const calendarTypeLabel = (type?: string) => {
    const labels: Record<string, string> = {
      task: 'Task',
      maintenance: 'Maintenance',
      inspection: 'Inspection',
      note: 'Note',
      other: 'Calendar',
    };
    return labels[type || 'other'] || 'Calendar';
  };
  const calendarEventTone = (event: OperationsCalendarEvent) => {
    if (event.status === 'completed') {
      return {
        card: 'border-emerald-300/35 bg-emerald-950/35 hover:border-emerald-200/60',
        rail: 'bg-emerald-400',
        chip: 'border-emerald-300/50 bg-emerald-400/20 text-emerald-50',
        time: 'bg-emerald-400/20 text-emerald-50 ring-emerald-300/40',
      };
    }

    if (event.priority === 'critical' || event.priority === 'high') {
      return {
        card: 'border-rose-300/40 bg-rose-950/30 hover:border-rose-200/60',
        rail: 'bg-rose-400',
        chip: 'border-rose-300/50 bg-rose-400/20 text-rose-50',
        time: 'bg-rose-400/20 text-rose-50 ring-rose-300/40',
      };
    }

    const tones: Record<string, { card: string; rail: string; chip: string; time: string }> = {
      task: {
        card: 'border-sky-300/40 bg-sky-950/30 hover:border-sky-200/60',
        rail: 'bg-sky-400',
        chip: 'border-sky-300/50 bg-sky-400/20 text-sky-50',
        time: 'bg-sky-400/20 text-sky-50 ring-sky-300/40',
      },
      maintenance: {
        card: 'border-amber-300/40 bg-amber-950/30 hover:border-amber-200/60',
        rail: 'bg-amber-400',
        chip: 'border-amber-300/50 bg-amber-400/20 text-amber-50',
        time: 'bg-amber-400/20 text-amber-50 ring-amber-300/40',
      },
      inspection: {
        card: 'border-violet-300/40 bg-violet-950/30 hover:border-violet-200/60',
        rail: 'bg-violet-400',
        chip: 'border-violet-300/50 bg-violet-400/20 text-violet-50',
        time: 'bg-violet-400/20 text-violet-50 ring-violet-300/40',
      },
      note: {
        card: 'border-cyan-300/40 bg-cyan-950/30 hover:border-cyan-200/60',
        rail: 'bg-cyan-300',
        chip: 'border-cyan-300/50 bg-cyan-400/20 text-cyan-50',
        time: 'bg-cyan-400/20 text-cyan-50 ring-cyan-300/40',
      },
      other: {
        card: 'border-slate-500/50 bg-slate-900/75 hover:border-blue-300/50',
        rail: 'bg-blue-400',
        chip: 'border-blue-300/40 bg-blue-400/20 text-blue-50',
        time: 'bg-blue-400/20 text-blue-50 ring-blue-300/40',
      },
    };

    return tones[event.event_type || 'other'] || tones.other;
  };
  const calendarEventsByDate = displayedCalendarEvents.reduce<Record<string, OperationsCalendarEvent[]>>((groups, event) => {
    const dateKey = calendarDateKeyForEvent(event) || todayKey;
    if (!groups[dateKey]) groups[dateKey] = [];
    groups[dateKey].push(event);
    return groups;
  }, {});
  const renderCalendarDayTask = (event: OperationsCalendarEvent) => {
    const complete = event.status === 'completed';
    const noteDraft = calendarNoteDraft(event);
    const noteExpanded = expandedCalendarNoteId === event.id;
    const projectLabel = getCalendarProjectLabel(event);
    const saving = savingCalendarEventId === event.id;
    const tone = calendarEventTone(event);

    return (
      <article
        key={event.id}
        className={`group relative overflow-hidden rounded-lg border px-3 py-3 text-left shadow-[0_10px_22px_rgba(2,6,23,0.24)] transition-colors ${
          complete
            ? tone.card
            : noteExpanded
              ? 'border-white/40 bg-slate-950/90'
              : tone.card
        }`}
      >
        <span className={`absolute bottom-3 left-0 top-3 w-1 rounded-r-full ${tone.rail}`} />
        <div className="flex items-start gap-2 pl-1.5">
          <input
            type="checkbox"
            checked={complete}
            disabled={saving}
            onChange={inputEvent => {
              void saveCalendarEventUpdate(event, {
                status: inputEvent.currentTarget.checked ? 'completed' : 'scheduled',
                completion_note: noteDraft,
              });
            }}
            className="mt-1 h-4 w-4 flex-shrink-0 rounded border-slate-500 bg-slate-950 accent-emerald-500"
            aria-label={`${complete ? 'Mark incomplete' : 'Mark complete'}: ${projectLabel} - ${event.title}`}
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-start justify-between gap-2">
              <button
                type="button"
                onClick={() => setExpandedCalendarNoteId(noteExpanded ? null : event.id)}
                className="min-w-0 flex-1 rounded-md text-left focus:outline-none focus:ring-2 focus:ring-cyan-300/50"
                aria-expanded={noteExpanded}
              >
                <p className={`whitespace-normal break-words text-sm font-black leading-5 ${complete ? 'text-emerald-100 line-through decoration-emerald-200/70' : 'text-slate-50'}`} title={event.title}>
                  {event.title}
                </p>
              </button>
              <button
                type="button"
                onClick={() => openCalendarEntryEditor(event)}
                disabled={saving}
                className="inline-flex h-8 flex-shrink-0 items-center gap-1 rounded-md border border-slate-600 bg-slate-950/90 px-2 text-[10px] font-black uppercase tracking-wide text-slate-100 transition hover:border-cyan-300 hover:bg-cyan-500/15 hover:text-cyan-100 disabled:opacity-60"
                title="Edit calendar entry"
                aria-label={`Edit calendar entry: ${projectLabel} - ${event.title}`}
              >
                <Edit2 className="h-3 w-3" />
                Edit
              </button>
            </div>
            <p className="mt-1 whitespace-normal break-words text-[12px] font-bold leading-4 text-slate-200" title={projectLabel}>
              {projectLabel}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {event.due_time ? (
                <span className={`flex-shrink-0 rounded-md px-2 py-1 text-[10px] font-black leading-none ring-1 ${tone.time}`}>
                  {event.due_time}
                </span>
              ) : (
                <span className="flex-shrink-0 rounded-md bg-slate-950/60 px-2 py-1 text-[10px] font-black leading-none text-slate-300 ring-1 ring-slate-600/60">
                  Anytime
                </span>
              )}
              <span className={`rounded-md border px-2 py-1 text-[10px] font-black uppercase leading-none ${tone.chip}`}>
                {calendarTypeLabel(event.event_type)}
              </span>
              {Number(event.email_reminder_count || 0) > 0 ? (
                <span className="rounded-md border border-blue-300/40 bg-blue-400/15 px-2 py-1 text-[10px] font-black uppercase leading-none text-blue-50">
                  Email
                </span>
              ) : null}
            </div>
          </div>
        </div>
        {noteExpanded && (
          <div className="mt-3 grid gap-2 border-t border-slate-800 pt-3">
            {event.description ? (
              <p className="whitespace-pre-wrap rounded-md border border-slate-700/70 bg-slate-950/55 px-3 py-2 text-[12px] font-semibold leading-5 text-slate-300">
                {event.description}
              </p>
            ) : null}
            {event.vendor_name ? (
              <p className="break-words text-[12px] font-semibold leading-4 text-slate-400">
                Vendor: {event.vendor_name}
              </p>
            ) : null}
            <VoiceTextarea
              value={noteDraft}
              onChange={inputEvent => updateCalendarCompletionNote(event.id, inputEvent.target.value)}
              rows={2}
              className="w-full resize-y rounded-md border border-slate-600 bg-slate-950 px-3 py-2 text-sm font-semibold leading-5 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-400"
              placeholder="Add note..."
            />
            <span className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setExpandedCalendarNoteId(null)}
                className="rounded border border-slate-600 bg-slate-900 px-2 py-1 text-[10px] font-black text-slate-200 hover:bg-slate-800"
              >
                Close
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void saveCalendarEventUpdate(event, { status: complete ? 'completed' : event.status, completion_note: noteDraft })}
                className="rounded border border-emerald-300/40 bg-emerald-500/15 px-2 py-1 text-[10px] font-black text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-60"
              >
                {saving ? 'Saving' : 'Save'}
              </button>
            </span>
          </div>
        )}
      </article>
    );
  };

  const renderCalendarMonthEventPill = (event: OperationsCalendarEvent) => {
    const complete = event.status === 'completed';
    const noteDraft = calendarNoteDraft(event);
    const projectLabel = getCalendarProjectLabel(event);
    const saving = savingCalendarEventId === event.id;
    const tone = calendarEventTone(event);

    return (
      <div
        key={event.id}
        className={`group relative flex min-w-0 items-start gap-1.5 overflow-hidden rounded-md border px-1.5 py-1.5 shadow-[0_6px_14px_rgba(2,6,23,0.18)] ${tone.card}`}
      >
        <span className={`absolute bottom-1.5 left-0 top-1.5 w-0.5 rounded-r-full ${tone.rail}`} />
        <input
          type="checkbox"
          checked={complete}
          disabled={saving}
          onChange={inputEvent => {
            void saveCalendarEventUpdate(event, {
              status: inputEvent.currentTarget.checked ? 'completed' : 'scheduled',
              completion_note: noteDraft,
            });
          }}
          className="ml-1 mt-0.5 h-3.5 w-3.5 flex-shrink-0 rounded border-slate-500 bg-slate-950 accent-emerald-500"
          aria-label={`${complete ? 'Mark incomplete' : 'Mark complete'}: ${projectLabel} - ${event.title}`}
        />
        <button
          type="button"
          onClick={() => openCalendarEntryEditor(event)}
          className="min-w-0 flex-1 rounded text-left focus:outline-none focus:ring-2 focus:ring-cyan-300/50"
          title={`${formatCalendarDueTimeLabel(event.due_time)} - ${event.title}`}
        >
          <span className={`block text-[10px] font-black leading-3 ${complete ? 'text-emerald-100 line-through decoration-emerald-200/70' : 'text-slate-50'}`}>
            {event.title}
          </span>
          <span className="mt-0.5 block truncate text-[9px] font-bold text-slate-300">
            {formatCalendarDueTimeLabel(event.due_time)}
          </span>
        </button>
        <button
          type="button"
          onClick={() => openCalendarEntryEditor(event)}
          disabled={saving}
          className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border border-slate-600 bg-slate-950/80 text-slate-300 opacity-0 transition hover:border-cyan-300 hover:text-cyan-100 group-hover:opacity-100 group-focus-within:opacity-100 disabled:opacity-50"
          aria-label={`Edit calendar entry: ${projectLabel} - ${event.title}`}
          title="Edit"
        >
          <Edit2 className="h-3 w-3" />
        </button>
      </div>
    );
  };

  const renderCalendarEmptyState = (dateKey: string, label: string) => (
    <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/45 px-4 py-6 text-center">
      <CalendarDays className="mx-auto h-7 w-7 text-slate-500" />
      <p className="mt-2 text-sm font-black text-slate-200">No calendar items scheduled</p>
      <p className="mt-1 text-xs font-semibold text-slate-500">{label}</p>
      <div className="mt-4 flex justify-center">
        <AddToCalendarButton
          label="Add calendar item"
          ariaLabel={`Add task or event on ${label}`}
          icon="plus"
          defaultTitle="BuildTrack task"
          defaultDescription={`Created directly from the ${label} calendar space.`}
          defaultDate={dateKey}
          defaultEventType="task"
          sourceType="dashboard_day"
          contextLabel={`Calendar space: ${label}`}
          modalTitle={`Add Item - ${label}`}
          buttonClassName="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border border-cyan-300/50 bg-cyan-500/15 px-3 text-xs font-black text-cyan-50 transition hover:border-cyan-200 hover:bg-cyan-500/25 focus:outline-none focus:ring-2 focus:ring-cyan-300/50"
          onSaved={() => refreshCalendarEvents(calendarAnchorDateKey, calendarViewMode)}
        />
      </div>
    </div>
  );

  const renderCalendarTodayView = () => {
    const todayEvents = sortCalendarEventsForDay(calendarEventsByDate[calendarAnchorDateKey] || []);
    const schedule = buildCalendarDayScheduleBucket(todayEvents);

    return (
      <div className="grid gap-4 p-4 xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="rounded-2xl border border-slate-700/70 bg-slate-950/70 p-4 shadow-[0_16px_34px_rgba(2,6,23,0.24)]">
          <p className="text-[11px] font-black uppercase tracking-wide text-cyan-200">Selected day</p>
          <h3 className="mt-2 text-3xl font-black leading-none text-white">
            {formatCalendarBadgeDate(calendarAnchorDateKey).day}
          </h3>
          <p className="mt-2 text-sm font-black text-slate-200">
            {formatEasternDate(`${calendarAnchorDateKey}T12:00:00`, { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-sky-300/20 bg-sky-500/10 px-3 py-2">
              <p className="text-[10px] font-black uppercase tracking-wide text-sky-200">Items</p>
              <p className="mt-1 text-xl font-black text-white">{todayEvents.length}</p>
            </div>
            <div className="rounded-xl border border-emerald-300/20 bg-emerald-500/10 px-3 py-2">
              <p className="text-[10px] font-black uppercase tracking-wide text-emerald-200">Done</p>
              <p className="mt-1 text-xl font-black text-white">{todayEvents.filter(event => event.status === 'completed').length}</p>
            </div>
          </div>
          <div className="mt-4">
            <AddToCalendarButton
              label="Add item today"
              ariaLabel={`Add task or event on ${formatCalendarBadgeDate(calendarAnchorDateKey).label}`}
              icon="plus"
              defaultTitle="BuildTrack task"
              defaultDescription={`Created directly from the ${formatCalendarBadgeDate(calendarAnchorDateKey).label} calendar space.`}
              defaultDate={calendarAnchorDateKey}
              defaultEventType="task"
              sourceType="dashboard_day"
              contextLabel={`Calendar space: ${formatCalendarBadgeDate(calendarAnchorDateKey).label}`}
              modalTitle={`Add Item - ${formatCalendarBadgeDate(calendarAnchorDateKey).label}`}
              buttonClassName="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-cyan-300/50 bg-gradient-to-r from-cyan-500/22 via-blue-500/18 to-orange-500/18 px-3 text-sm font-black text-white transition hover:border-cyan-200 hover:from-cyan-400/28 hover:via-blue-500/22 hover:to-orange-400/22 focus:outline-none focus:ring-2 focus:ring-cyan-300/50"
              onSaved={() => refreshCalendarEvents(calendarAnchorDateKey, calendarViewMode)}
            />
          </div>
        </aside>

        <div className="min-w-0 rounded-2xl border border-slate-700/70 bg-slate-950/45">
          {todayEvents.length === 0 ? (
            <div className="p-4">{renderCalendarEmptyState(calendarAnchorDateKey, formatCalendarBadgeDate(calendarAnchorDateKey).label)}</div>
          ) : (
            <div>
              {schedule.untimed.length > 0 ? (
                <div className="grid grid-cols-[90px_minmax(0,1fr)] border-b border-slate-800/90">
                  <div className="border-r border-slate-800/90 px-3 py-3 text-right text-[11px] font-black uppercase tracking-wide text-slate-500">
                    No time
                  </div>
                  <div className="space-y-2 p-3">
                    {schedule.untimed.map(renderCalendarDayTask)}
                  </div>
                </div>
              ) : null}
              {calendarScheduleHours.map(hour => {
                const hourEvents = schedule.byHour[hour] || [];
                return (
                  <div key={hour} className="grid min-h-[72px] grid-cols-[90px_minmax(0,1fr)] border-b border-slate-800/80 last:border-b-0">
                    <div className="border-r border-slate-800/90 bg-slate-950/40 px-3 py-3 text-right text-[11px] font-black text-slate-400">
                      {formatCalendarHourLabel(hour)}
                    </div>
                    <div className={`space-y-2 p-3 ${hourEvents.length ? 'bg-slate-900/25' : 'bg-slate-950/20'}`}>
                      {hourEvents.length ? (
                        hourEvents.map(renderCalendarDayTask)
                      ) : (
                        <div className="h-full min-h-[44px] rounded-lg border border-dashed border-slate-800/80 bg-slate-950/25" />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderCalendarWeekView = () => (
    <div className="overflow-x-auto bg-[#060A14]">
      <div className="grid min-w-[1180px] grid-cols-7 items-start gap-3 p-4">
        {calendarVisibleWeekDays.map(day => {
          const dayEvents = sortCalendarEventsForDay(calendarEventsByDate[day.key] || []);
          const badgeDate = formatCalendarBadgeDate(day.key);
          const dayYear = day.key.slice(0, 4);

          return (
            <section key={day.key} className={`min-w-0 overflow-hidden rounded-2xl border shadow-[0_14px_30px_rgba(2,6,23,0.28)] ${day.isToday ? 'border-cyan-300/70 bg-[#0B213B] ring-1 ring-cyan-300/25' : 'border-slate-700/80 bg-[#111827]'}`}>
              <header className={`border-b px-3 py-3 ${day.isToday ? 'border-cyan-300/40 bg-cyan-500/10' : 'border-slate-700/70 bg-[#182235]'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className={`text-[10px] font-black uppercase tracking-[0.16em] ${day.isToday ? 'text-cyan-100' : 'text-slate-400'}`}>
                      {day.weekday}
                    </p>
                    <p className="mt-1 text-2xl font-black leading-none text-white">
                      {day.dayNumber}
                    </p>
                    <p className="mt-1 text-[9px] font-bold uppercase tracking-wide text-slate-500">
                      {badgeDate.month} {dayYear}
                    </p>
                  </div>
                  <div className="flex items-start gap-1.5">
                    <span className={`rounded-full px-2 py-1 text-[10px] font-black leading-none ${day.isToday ? 'bg-cyan-100 text-slate-950' : dayEvents.length > 0 ? 'bg-sky-400/20 text-sky-100 ring-1 ring-sky-300/35' : 'bg-slate-950/70 text-slate-300 ring-1 ring-slate-600/60'}`}>
                      {dayEvents.length}
                    </span>
                    <AddToCalendarButton
                      label={`Add calendar item on ${badgeDate.label}`}
                      ariaLabel={`Add task or event on ${badgeDate.label}`}
                      icon="plus"
                      iconOnly
                      defaultTitle="BuildTrack task"
                      defaultDescription={`Created directly from the ${badgeDate.label} calendar space.`}
                      defaultDate={day.key}
                      defaultEventType="task"
                      sourceType="dashboard_day"
                      contextLabel={`Calendar space: ${badgeDate.label}`}
                      modalTitle={`Add Item - ${badgeDate.label}`}
                      buttonClassName={`inline-flex h-7 w-7 min-w-7 items-center justify-center rounded-md border text-xs font-black transition focus:outline-none focus:ring-2 focus:ring-cyan-300/50 ${day.isToday ? 'border-cyan-100/70 bg-cyan-200/20 text-cyan-50 hover:bg-cyan-200/30 hover:border-cyan-50' : 'border-slate-600 bg-slate-950/70 text-slate-300 hover:border-cyan-300 hover:bg-cyan-500/20 hover:text-cyan-50'}`}
                      onSaved={() => refreshCalendarEvents(calendarAnchorDateKey, calendarViewMode)}
                    />
                  </div>
                </div>
              </header>
              <div className="space-y-2.5 p-3">
                {dayEvents.length ? dayEvents.map(renderCalendarDayTask) : renderCalendarEmptyState(day.key, badgeDate.label)}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );

  const renderCalendarMonthView = () => (
    <div className="overflow-x-auto bg-[#060A14]">
      <div className="min-w-[1180px] p-4">
        <div className="grid grid-cols-7 overflow-hidden rounded-t-2xl border border-b-0 border-slate-700/80 bg-[#182235]">
          {calendarWeekdayLabels.map(dayLabel => (
            <div key={dayLabel} className="border-r border-slate-700/70 px-3 py-2 text-[10px] font-black uppercase tracking-[0.18em] text-slate-300 last:border-r-0">
              {dayLabel}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 overflow-hidden rounded-b-2xl border border-slate-700/80">
          {calendarVisibleMonthDays.map(day => {
            const dayEvents = sortCalendarEventsForDay(calendarEventsByDate[day.key] || []);
            const badgeDate = formatCalendarBadgeDate(day.key);
            const visibleEvents = dayEvents.slice(0, 3);
            const hiddenCount = Math.max(dayEvents.length - visibleEvents.length, 0);

            return (
              <section
                key={day.key}
                className={`min-h-[154px] border-r border-b border-slate-800/85 p-2 last:border-r-0 ${day.isToday ? 'bg-cyan-950/35 ring-1 ring-inset ring-cyan-300/55' : day.isCurrentMonth ? 'bg-[#0D1424]' : 'bg-slate-950/55'}`}
              >
                <header className="mb-2 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setCalendarViewMode('today');
                      setCalendarAnchorDateKey(day.key);
                      setExpandedCalendarNoteId(null);
                    }}
                    className={`rounded-lg px-2 py-1 text-left text-xs font-black transition focus:outline-none focus:ring-2 focus:ring-cyan-300/50 ${day.isCurrentMonth ? 'text-slate-100 hover:bg-slate-800/80' : 'text-slate-500 hover:bg-slate-900/80'}`}
                    title={`Open daily schedule for ${badgeDate.label}`}
                  >
                    {day.dayNumber}
                  </button>
                  <div className="flex items-center gap-1">
                    {dayEvents.length ? (
                      <span className="rounded-full bg-sky-400/20 px-1.5 py-0.5 text-[9px] font-black text-sky-100 ring-1 ring-sky-300/30">
                        {dayEvents.length}
                      </span>
                    ) : null}
                    <AddToCalendarButton
                      label={`Add calendar item on ${badgeDate.label}`}
                      ariaLabel={`Add task or event on ${badgeDate.label}`}
                      icon="plus"
                      iconOnly
                      defaultTitle="BuildTrack task"
                      defaultDescription={`Created directly from the ${badgeDate.label} calendar space.`}
                      defaultDate={day.key}
                      defaultEventType="task"
                      sourceType="dashboard_day"
                      contextLabel={`Calendar space: ${badgeDate.label}`}
                      modalTitle={`Add Item - ${badgeDate.label}`}
                      buttonClassName="inline-flex h-6 w-6 min-w-6 items-center justify-center rounded-md border border-slate-700 bg-slate-950/70 text-[10px] font-black text-slate-400 transition hover:border-cyan-300 hover:bg-cyan-500/20 hover:text-cyan-50 focus:outline-none focus:ring-2 focus:ring-cyan-300/50"
                      onSaved={() => refreshCalendarEvents(calendarAnchorDateKey, calendarViewMode)}
                    />
                  </div>
                </header>
                <div className="space-y-1.5">
                  {visibleEvents.map(renderCalendarMonthEventPill)}
                  {hiddenCount > 0 ? (
                    <button
                      type="button"
                      onClick={() => {
                        setCalendarViewMode('today');
                        setCalendarAnchorDateKey(day.key);
                        setExpandedCalendarNoteId(null);
                      }}
                      className="w-full rounded-md border border-slate-700/80 bg-slate-950/60 px-2 py-1 text-left text-[10px] font-black text-slate-300 transition hover:border-cyan-300/50 hover:text-cyan-100 focus:outline-none focus:ring-2 focus:ring-cyan-300/50"
                    >
                      + {hiddenCount} more
                    </button>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );

  const renderCollapsedCalendarPreview = () => {
    const previewEvents = sortCalendarEventsForRange(displayedCalendarEvents).slice(0, 4);
    const hiddenCount = Math.max(displayedCalendarEvents.length - previewEvents.length, 0);
    const selectedLabel = calendarViewMode === 'today'
      ? formatCalendarBadgeDate(calendarAnchorDateKey).label
      : calendarViewTitle;

    return (
      <div className="border-t border-slate-800/80 bg-[#060A14] p-4">
        <div className="grid gap-3 xl:grid-cols-[220px_minmax(0,1fr)_auto] xl:items-stretch">
          <div className="rounded-2xl border border-slate-700/70 bg-slate-950/70 p-4">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-cyan-200">Compact schedule</p>
            <h4 className="mt-2 text-2xl font-black text-white">{calendarViewEventCount}</h4>
            <p className="mt-1 text-xs font-bold text-slate-300">{calendarViewEventCount === 1 ? 'calendar item' : 'calendar items'}</p>
            <p className="mt-3 text-xs font-semibold leading-5 text-slate-400">{selectedLabel}</p>
          </div>

          <div className="min-w-0 rounded-2xl border border-slate-700/70 bg-slate-950/45 p-3">
            {previewEvents.length ? (
              <div className="grid gap-2 xl:grid-cols-2">
                {previewEvents.map(event => {
                  const complete = event.status === 'completed';
                  const projectLabel = getCalendarProjectLabel(event);
                  const dateKey = calendarDateKeyForEvent(event) || calendarAnchorDateKey;
                  const badgeDate = formatCalendarBadgeDate(dateKey);
                  const tone = calendarEventTone(event);

                  return (
                    <button
                      key={event.id}
                      type="button"
                      onClick={() => {
                        setCalendarAnchorDateKey(dateKey);
                        setCalendarViewMode('today');
                        setCalendarExpanded(true);
                        openCalendarEntryEditor(event);
                      }}
                      className={`group relative min-w-0 overflow-hidden rounded-xl border px-3 py-2.5 text-left shadow-[0_10px_24px_rgba(2,6,23,0.22)] transition focus:outline-none focus:ring-2 focus:ring-cyan-300/50 ${tone.card}`}
                    >
                      <span className={`absolute bottom-2 left-0 top-2 w-1 rounded-r-full ${tone.rail}`} />
                      <span className="block pl-2">
                        <span className="flex items-center justify-between gap-2">
                          <span className={`min-w-0 truncate text-sm font-black leading-5 ${complete ? 'text-emerald-100 line-through decoration-emerald-200/70' : 'text-slate-50'}`}>
                            {event.title}
                          </span>
                          <span className={`flex-shrink-0 rounded-md px-2 py-1 text-[10px] font-black leading-none ring-1 ${tone.time}`}>
                            {formatCalendarDueTimeLabel(event.due_time)}
                          </span>
                        </span>
                        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className="truncate text-[11px] font-bold text-slate-300">{projectLabel}</span>
                          <span className={`rounded-md border px-1.5 py-0.5 text-[9px] font-black uppercase leading-none ${tone.chip}`}>
                            {calendarTypeLabel(event.event_type)}
                          </span>
                          {calendarViewMode !== 'today' ? (
                            <span className="rounded-md bg-slate-950/65 px-1.5 py-0.5 text-[9px] font-black uppercase text-slate-300 ring-1 ring-slate-600/60">
                              {badgeDate.month} {badgeDate.day}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              renderCalendarEmptyState(calendarAnchorDateKey, selectedLabel)
            )}
            {hiddenCount > 0 ? (
              <button
                type="button"
                onClick={() => setCalendarExpanded(true)}
                className="mt-3 inline-flex min-h-9 items-center rounded-lg border border-sky-300/40 bg-sky-500/15 px-3 text-xs font-black text-sky-50 transition hover:border-sky-200 hover:bg-sky-500/25 focus:outline-none focus:ring-2 focus:ring-cyan-300/50"
              >
                View {hiddenCount} more
              </button>
            ) : null}
          </div>

          <div className="flex min-w-[170px] flex-col justify-between gap-2 rounded-2xl border border-slate-700/70 bg-slate-950/70 p-3">
            <button
              type="button"
              onClick={() => setCalendarExpanded(true)}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-cyan-300/50 bg-cyan-500/15 px-3 text-sm font-black text-cyan-50 transition hover:border-cyan-200 hover:bg-cyan-500/25 focus:outline-none focus:ring-2 focus:ring-cyan-300/50"
              aria-expanded={calendarExpanded}
            >
              Expand calendar
              <ChevronDown className="h-4 w-4 rotate-180" />
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderSelectedCalendarView = () => {
    if (calendarViewMode === 'today') return renderCalendarTodayView();
    if (calendarViewMode === 'week') return renderCalendarWeekView();
    return renderCalendarMonthView();
  };

  const renderActivityFeedPanel = () => (
    <div
      id="recent-activity"
      className="bt-dashboard-notes-panel bt-dashboard-activity-panel relative overflow-hidden rounded-2xl border border-slate-700/70 shadow-[0_16px_40px_rgba(2,6,23,0.24)]"
      style={{
        background: 'linear-gradient(180deg, rgba(17,31,52,0.92), rgba(12,22,38,0.92))',
      }}
    >
      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-blue-500 via-cyan-300 to-amber-300" />
      <div
        className="bt-dashboard-notes-panel-header relative flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3"
        style={{
          background: 'linear-gradient(90deg, rgba(30,64,175,0.20) 0%, rgba(14,165,233,0.10) 52%, rgba(245,158,11,0.08) 100%)',
        }}
      >
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-lg border shadow-[0_0_16px_rgba(96,165,250,0.14)]"
            style={{ background: 'rgba(37,99,235,0.16)', borderColor: 'rgba(147,197,253,0.46)' }}
          >
            <Activity className="h-4 w-4" style={{ color: '#BFDBFE' }} />
          </div>
          <div>
            <p className="bt-section-kicker">Latest company notes</p>
            <h2 className="text-lg font-black text-white">Latest Field & Office Notes</h2>
            <p className="text-xs font-semibold text-slate-300">{activityFeed.length} recent notes across all projects</p>
          </div>
        </div>
        <span className="hidden rounded-full border border-cyan-300/30 bg-cyan-500/10 px-3 py-1 text-[10px] font-black uppercase tracking-wide text-cyan-100 sm:inline-flex">
          25 latest notes
        </span>
      </div>

      {activityFeed.length === 0 ? (
        <div className="relative flex min-h-[96px] flex-col items-center justify-center px-4 py-6">
          <p className="text-sm font-bold text-white">No notes yet</p>
          <p className="mt-1 text-xs text-blue-100">Recent field and office notes will appear here.</p>
        </div>
      ) : (
        <div className="relative grid grid-cols-1 gap-2 p-3">
          {activityFeed.map((item) => {
            const activityStyle = getActivityTypeStyle(item);
            const statusStyle = getProjectStatusStyle(item.project_status || undefined);
            const summary = getActivitySummary(item);
            const projectTarget = item.project_id ? `/projects/${item.project_id}` : '';
            const projectLabel = item.project_address || item.project_job_name || 'BuildTrack';
            return (
              <div
                key={`${item.feed_type}-${item.id}`}
                role={projectTarget ? 'link' : undefined}
                tabIndex={projectTarget ? 0 : -1}
                onClick={() => {
                  if (projectTarget) navigate(projectTarget);
                }}
                onKeyDown={event => {
                  if (projectTarget && event.key === 'Enter') navigate(projectTarget);
                }}
                className={`group relative flex items-start gap-3 rounded-lg border border-white/10 p-3 transition-all hover:border-cyan-300/55 ${projectTarget ? 'cursor-pointer' : 'cursor-default'}`}
                style={{
                  background: 'linear-gradient(135deg, rgba(15,23,42,0.88) 0%, rgba(30,41,59,0.76) 58%, rgba(8,47,73,0.42) 100%)',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
                }}
              >
                <span
                  className="absolute bottom-2 left-0 top-2 w-1 rounded-r-full"
                  style={{ background: activityStyle.accent }}
                />
                <div className="relative mt-0.5 flex-shrink-0 pl-1">
                  <Avatar
                    src={item.user_avatar_url}
                    name={item.user_name}
                    size={46}
                    className="border-2"
                    style={{ borderColor: 'rgba(191,219,254,0.72)' }}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                    <span className="truncate text-sm font-black text-white">{item.user_name}</span>
                    <span className="text-[11px] font-semibold text-slate-300">
                      {formatEasternDateTime(item.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                    <span
                      className="inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-black uppercase"
                      style={{ background: activityStyle.bg, color: activityStyle.color, borderColor: activityStyle.border }}
                    >
                      {activityStyle.label}
                    </span>
                    <span
                      className="inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-black"
                      style={{ background: statusStyle.bg, color: statusStyle.color, borderColor: statusStyle.border }}
                    >
                      {statusStyle.label}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-1 whitespace-pre-wrap text-xs font-medium leading-5 text-slate-100">
                    {summary}
                  </p>
                  {projectLabel && (
                    <div className="mt-1 flex items-center gap-1.5">
                      <MapPin className="h-3 w-3 flex-shrink-0 text-cyan-200" />
                      <p className="truncate text-[10px] font-bold text-slate-200">{projectLabel}</p>
                    </div>
                  )}
                </div>
                <div className="flex flex-shrink-0 flex-col items-end gap-1 text-right">
                  <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-black text-blue-100 ring-1 ring-blue-300/25">
                    {formatEasternRelative(item.created_at)}
                  </span>
                  {projectTarget ? (
                    <span className="hidden rounded-md border border-slate-600/70 bg-slate-900/80 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-slate-200 transition group-hover:border-cyan-300/60 group-hover:text-cyan-100 sm:inline">
                      Open
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div className="bt-desktop-page bt-dashboard-page" style={{ minHeight: '100%' }}>
      {/* Hero header bar */}
      <div
        className="bt-dashboard-hero border-b px-4 py-4 md:px-6"
      >
        <div className="relative z-10 mx-auto grid max-w-none gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-3">
              <span
                className="inline-flex items-center gap-1.5 rounded-full border border-orange-300/45 bg-orange-500/10 px-3 py-1 text-[10px] font-black uppercase tracking-wide text-orange-200"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-current" />
                Operations Dashboard
              </span>
            </div>
            <h1 className="text-2xl font-black tracking-tight text-slate-50">
              {greeting()}, {firstName}
            </h1>
            <p className="mt-1 text-sm font-semibold text-slate-300">
              {formatEasternDate(now.toISOString(), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} - {roleLabels[user?.role || '']}
            </p>
          </div>
          <div className="hidden items-center gap-3 md:flex">
            <div className="grid grid-cols-3 gap-2">
              <div className="bt-dashboard-command-chip">
                <span>Schedule</span>
                <strong>{calendarViewEventCount}</strong>
              </div>
              <div className="bt-dashboard-command-chip">
                <span>Upcoming</span>
                <strong>{upcomingCalendarEvents.length}</strong>
              </div>
              <div className="bt-dashboard-command-chip">
                <span>Notes</span>
                <strong>{activityFeed.length}</strong>
              </div>
            </div>
            <Link
              to="/projects"
              className="bt-btn bt-btn-primary"
            >
              <Plus className="w-4 h-4" />
              New Project
            </Link>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-none space-y-5 px-4 py-4 md:px-6">
        {/* Operations schedule */}
        <section
          className="bt-dashboard-ops-panel relative overflow-hidden"
          aria-label="Operations schedule"
        >
          <div className="bt-dashboard-ops-strip absolute inset-x-0 top-0 h-1" />
          <div className="bt-dashboard-ops-header relative grid min-h-8 gap-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end">
            <div className="min-w-0">
              <p className="bt-section-kicker">Operations schedule</p>
              <h2 className="truncate text-2xl font-black tracking-tight" style={{ color: 'var(--bt-text)' }}>Jobsite Operations Calendar</h2>
              <p className="mt-1 text-sm font-semibold text-slate-300">
                Weekly field schedule, task completion, and operational reminders.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <AddToCalendarButton
                label="Add to Calendar"
                defaultTitle="BuildTrack operations reminder"
                defaultDescription="Created from the dashboard."
                sourceType="dashboard"
                contextLabel="Dashboard operations calendar"
                onSaved={refreshCalendarEvents}
              />
              {canCreateCalendarReminders && (
                <button
                  type="button"
                  onClick={openCalendarReminderComposer}
                  className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-600/80 bg-slate-900/80 px-3 py-2 text-sm font-black text-slate-100 transition-colors hover:border-cyan-300/70 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-300/50"
                >
                  <Mail className="h-3.5 w-3.5" />
                  Email Reminder
                </button>
              )}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {([
              { key: 'upcoming', label: 'Upcoming', count: upcomingCalendarEvents.length },
              { key: 'completed', label: 'Completed', count: completedCalendarEvents.length },
            ] as const).map(filter => {
              const active = calendarQueueFilter === filter.key;
              return (
                <button
                  key={filter.key}
                  type="button"
                  onClick={() => {
                    setCalendarQueueFilter(filter.key);
                    setExpandedCalendarNoteId(null);
                  }}
                    className="inline-flex min-h-10 items-center gap-2 rounded-full border px-4 py-2 text-sm font-black shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-300/60"
                    style={{
                    background: active ? 'linear-gradient(135deg, #1D4ED8, #0E7490)' : 'rgba(30,41,59,0.92)',
                    borderColor: active ? 'rgba(191,219,254,0.82)' : 'rgba(100,116,139,0.70)',
                    color: active ? '#FFFFFF' : '#E5E7EB',
                  }}
                  aria-pressed={active}
                >
                  {filter.label}
                  <span
                    className="rounded-full px-2 py-0.5 text-[11px] font-black"
                    style={{
                      background: active ? '#F8FAFC' : 'rgba(226,232,240,0.16)',
                      color: active ? '#0F172A' : '#F8FAFC',
                    }}
                  >
                    {filter.count}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-4 overflow-hidden rounded-[18px] border border-slate-700/70 bg-[#070B16] shadow-[0_24px_60px_rgba(2,6,23,0.38)]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-700/70 px-4 py-3" style={{ background: 'linear-gradient(90deg, rgba(15,23,42,0.98), rgba(17,24,39,0.98) 55%, rgba(12,74,110,0.24))' }}>
              <div className="min-w-0">
                <p className="text-[11px] font-black uppercase tracking-wide text-sky-200">{calendarViewKicker}</p>
                <h3 className="mt-0.5 text-lg font-black text-slate-50">{calendarViewTitle}</h3>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <div className="mr-1 inline-flex rounded-xl border border-slate-700 bg-slate-950/80 p-1">
                  {([
                    { key: 'today', label: 'Today' },
                    { key: 'week', label: 'Week' },
                    { key: 'month', label: 'Month' },
                  ] as const).map(view => {
                    const active = calendarViewMode === view.key;
                    return (
                      <button
                        key={view.key}
                        type="button"
                        onClick={() => changeCalendarViewMode(view.key)}
                        className={`min-h-8 rounded-lg px-3 text-xs font-black transition focus:outline-none focus:ring-2 focus:ring-cyan-300/50 ${active ? 'bg-sky-500/25 text-white ring-1 ring-sky-300/45' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'}`}
                        aria-pressed={active}
                      >
                        {view.label}
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={() => moveCalendarPeriod(-1)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-600 bg-slate-800/90 text-slate-100 transition hover:border-sky-300 hover:bg-slate-700"
                  title={`Previous ${calendarViewMode}`}
                  aria-label={`Previous ${calendarViewMode}`}
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={jumpToTodayCalendarView}
                  className="inline-flex min-h-8 items-center rounded-lg border border-sky-300/40 bg-sky-500/20 px-2.5 text-xs font-black text-sky-50 transition hover:border-sky-200 hover:bg-sky-500/30"
                >
                  Today
                </button>
                <label className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-800/90 px-2 text-xs font-black text-slate-100">
                  <span>Date</span>
                  <input
                    type="date"
                    value={calendarAnchorDateKey}
                    onChange={event => jumpToCalendarDate(event.target.value)}
                    className="h-6 rounded-md border border-slate-600 bg-slate-950 px-1.5 text-xs font-bold text-slate-100 outline-none focus:border-sky-300"
                    aria-label="Choose calendar date"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => moveCalendarPeriod(1)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-600 bg-slate-800/90 text-slate-100 transition hover:border-sky-300 hover:bg-slate-700"
                  title={`Next ${calendarViewMode}`}
                  aria-label={`Next ${calendarViewMode}`}
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
                <span className="rounded-lg border border-sky-300/40 bg-sky-500/20 px-2.5 py-1 text-xs font-black text-sky-50">
                  {calendarViewEventCount} {calendarViewEventCount === 1 ? 'item' : 'items'}
                </span>
                <button
                  type="button"
                  onClick={() => setCalendarExpanded(current => !current)}
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-cyan-300/40 bg-cyan-500/15 px-2.5 text-xs font-black text-cyan-50 transition hover:border-cyan-200 hover:bg-cyan-500/25 focus:outline-none focus:ring-2 focus:ring-cyan-300/50"
                  aria-expanded={calendarExpanded}
                  aria-controls="jobsite-operations-calendar-body"
                >
                  {calendarExpanded ? 'Collapse' : 'Expand'}
                  <ChevronDown className={`h-4 w-4 transition-transform ${calendarExpanded ? '' : 'rotate-180'}`} />
                </button>
              </div>
            </div>
            <div id="jobsite-operations-calendar-body">
              {calendarExpanded ? renderSelectedCalendarView() : renderCollapsedCalendarPreview()}
            </div>
          </div>
        </section>

        {renderActivityFeedPanel()}

        {/* Footer */}
        <div className="flex items-center justify-between py-2">
          <p className="text-xs text-gray-400">© 2026 New Urban Development · BuildTrack Platform</p>
          <p className="text-xs text-gray-400">Last updated: {formatEasternTime(now.toISOString())} New York time</p>
        </div>
      </div>

      <Modal
        isOpen={!!editingCalendarEvent}
        onClose={closeCalendarEntryEditor}
        title="Edit Calendar Entry"
        size="lg"
      >
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px]">
            <label className="block">
              <span className="text-xs font-black uppercase tracking-wide text-slate-600">Title</span>
              <input
                value={calendarEditForm.title}
                onChange={event => updateCalendarEditField('title', event.target.value)}
                className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-950 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
                placeholder="Calendar title"
              />
            </label>
            <label className="block">
              <span className="text-xs font-black uppercase tracking-wide text-slate-600">Status</span>
              <select
                value={calendarEditForm.status}
                onChange={event => updateCalendarEditField('status', event.target.value)}
                className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-950 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
              >
                <option value="scheduled">Scheduled</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
                {editingCalendarEvent?.source !== 'construction_task' && <option value="cancelled">Cancelled</option>}
              </select>
            </label>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="text-xs font-black uppercase tracking-wide text-slate-600">Date</span>
              <input
                type="date"
                value={calendarEditForm.scheduled_for}
                onChange={event => updateCalendarEditField('scheduled_for', event.target.value)}
                className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-950 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
              />
            </label>
            {editingCalendarEvent?.source !== 'construction_task' && (
              <label className="block">
                <span className="text-xs font-black uppercase tracking-wide text-slate-600">Time</span>
                <input
                  type="time"
                  value={calendarEditForm.due_time}
                  onChange={event => updateCalendarEditField('due_time', event.target.value)}
                  className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-950 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
                />
              </label>
            )}
          </div>

          {editingCalendarEvent?.source !== 'construction_task' && (
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block">
                <span className="text-xs font-black uppercase tracking-wide text-slate-600">Type</span>
                <select
                  value={calendarEditForm.event_type}
                  onChange={event => updateCalendarEditField('event_type', event.target.value)}
                  className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-950 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
                >
                  <option value="task">Task</option>
                  <option value="maintenance">Maintenance</option>
                  <option value="inspection">Inspection</option>
                  <option value="note">Note</option>
                  <option value="other">Calendar</option>
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-black uppercase tracking-wide text-slate-600">Priority</span>
                <select
                  value={calendarEditForm.priority}
                  onChange={event => updateCalendarEditField('priority', event.target.value)}
                  className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-950 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </label>
            </div>
          )}

          <label className="block">
            <span className="text-xs font-black uppercase tracking-wide text-slate-600">Description</span>
            <VoiceTextarea
              value={calendarEditForm.description}
              onChange={event => updateCalendarEditField('description', event.target.value)}
              rows={3}
              className="mt-1 w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold leading-5 text-slate-950 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
              placeholder="Calendar details"
            />
          </label>

          <label className="block">
            <span className="text-xs font-black uppercase tracking-wide text-slate-600">Completion Note</span>
            <VoiceTextarea
              value={calendarEditForm.completion_note}
              onChange={event => updateCalendarEditField('completion_note', event.target.value)}
              rows={3}
              className="mt-1 w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold leading-5 text-slate-950 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
              placeholder="Completion note"
            />
          </label>

          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-3">
            <button
              type="button"
              onClick={closeCalendarEntryEditor}
              disabled={savingCalendarEdit}
              className="min-h-10 rounded-xl border border-slate-300 bg-white px-4 text-sm font-black text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveCalendarEntryEdit}
              disabled={savingCalendarEdit}
              className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-blue-300 bg-blue-600 px-4 text-sm font-black text-white transition hover:bg-blue-500 disabled:opacity-60"
            >
              <Edit2 className="h-4 w-4" />
              {savingCalendarEdit ? 'Saving' : 'Save Entry'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showCalendarReminderComposer}
        onClose={() => setShowCalendarReminderComposer(false)}
        title="Calendar Email Reminder"
        description="Send from info@newurbandev.com now or schedule a one-time, weekly, or monthly reminder."
        size="xl"
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-xs font-black uppercase tracking-wide text-amber-800">Sender</p>
            <p className="mt-1 text-sm font-bold text-amber-900">info@newurbandev.com</p>
          </div>

          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
            <label className="block">
              <span className="text-xs font-black uppercase tracking-wide text-slate-600">Reminder title</span>
              <input
                value={reminderTitle}
                onChange={event => setReminderTitle(event.target.value)}
                className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-950 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
                placeholder="Reminder title"
              />
            </label>
            <label className="block">
              <span className="text-xs font-black uppercase tracking-wide text-slate-600">Calendar type</span>
              <select
                value={reminderEventType}
                onChange={event => setReminderEventType(event.target.value)}
                className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-950 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
              >
                <option value="other">Calendar</option>
                <option value="task">Task</option>
                <option value="inspection">Inspection</option>
                <option value="maintenance">Maintenance</option>
                <option value="note">Note</option>
              </select>
            </label>
          </div>

          <label className="block">
            <span className="text-xs font-black uppercase tracking-wide text-slate-600">Recipients</span>
            <textarea
              value={reminderRecipients}
              onChange={event => setReminderRecipients(event.target.value)}
              rows={3}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-950 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
              placeholder="contractor@email.com, team@company.com"
            />
            <span className="mt-1 block text-xs font-semibold text-slate-500">Enter any email address. Separate multiple recipients with commas, spaces, or new lines.</span>
          </label>

          <label className="block">
            <span className="text-xs font-black uppercase tracking-wide text-slate-600">Reminder message</span>
            <VoiceTextarea
              value={reminderMessage}
              onChange={event => setReminderMessage(event.target.value)}
              rows={4}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-950 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
              placeholder="Write the reminder message that should be emailed."
            />
          </label>

          <div className="grid gap-3 md:grid-cols-4">
            <label className="block">
              <span className="text-xs font-black uppercase tracking-wide text-slate-600">Send schedule</span>
              <select
                value={reminderScheduleType}
                onChange={event => setReminderScheduleType(event.target.value as 'now' | 'once' | 'weekly' | 'monthly')}
                className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-950 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
              >
                <option value="now">Send now</option>
                <option value="once">One time</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-black uppercase tracking-wide text-slate-600">Date</span>
              <input
                type="date"
                value={reminderDate}
                onChange={event => setReminderDate(event.target.value)}
                disabled={reminderScheduleType === 'now'}
                className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-950 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
              />
            </label>
            <label className="block">
              <span className="text-xs font-black uppercase tracking-wide text-slate-600">Time</span>
              <input
                type="time"
                value={reminderTime}
                onChange={event => setReminderTime(event.target.value)}
                disabled={reminderScheduleType === 'now'}
                className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-950 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
              />
            </label>
            <label className="block">
              <span className="text-xs font-black uppercase tracking-wide text-slate-600">Priority</span>
              <select
                value={reminderPriority}
                onChange={event => setReminderPriority(event.target.value)}
                className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-950 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
              >
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
                <option value="low">Low</option>
              </select>
            </label>
          </div>

          <div className="flex flex-col gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => setShowCalendarReminderComposer(false)}
              className="bt-btn bt-btn-secondary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveCalendarEmailReminder}
              disabled={savingCalendarReminder}
              className="bt-btn bt-btn-primary"
            >
              {reminderScheduleType === 'now' ? <Send className="h-4 w-4" /> : <CalendarDays className="h-4 w-4" />}
              {savingCalendarReminder ? 'Saving' : reminderScheduleType === 'now' ? 'Send Now' : 'Schedule Reminder'}
            </button>
          </div>
        </div>
      </Modal>

    </div>
  );
}
