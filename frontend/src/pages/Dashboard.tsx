import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore, isAdminRole, roleLabels } from '../store/authStore';
import api from '../lib/api';
import { Loading, Modal } from '../components/ui';
import Avatar from '../components/Avatar';
import {
  Activity,
  Plus, MapPin, CalendarDays,
  Mail, Edit2, ChevronLeft, ChevronRight, Trash2, CheckCircle2, Clock, ListFilter,
  Maximize2, Minimize2
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
type CalendarViewMode = 'today' | 'week' | 'month' | 'list';

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
    return calendarRangeFromWeekStartKey(formatLocalDateInput(anchorDate));
  }

  if (viewMode === 'list') {
    return {
      start: formatLocalDateInput(anchorDate),
      end: formatLocalDateInput(addCalendarDays(anchorDate, 13)),
    };
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
      weekday: calendarWeekdayLabels[date.getDay()],
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

const calendarPreference = {
  get(key: string, fallback: boolean) {
    if (typeof window === 'undefined') return fallback;
    return window.localStorage.getItem(key) === null
      ? fallback
      : window.localStorage.getItem(key) === 'true';
  },
  set(key: string, value: boolean) {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(key, String(value));
  },
};

interface DashboardProps {
  calendarOnly?: boolean;
}

export default function Dashboard({ calendarOnly = false }: DashboardProps) {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [activityFeed, setActivityFeed] = useState<DashboardActivityFeedItem[]>([]);
  const [deletingActivityNoteId, setDeletingActivityNoteId] = useState<string | null>(null);
  const [calendarEvents, setCalendarEvents] = useState<OperationsCalendarEvent[]>([]);
  const [calendarCompletionNotes, setCalendarCompletionNotes] = useState<Record<string, string>>({});
  const [savingCalendarEventId, setSavingCalendarEventId] = useState('');
  const [expandedCalendarNoteId, setExpandedCalendarNoteId] = useState<string | null>(null);
  const [calendarQueueFilter, setCalendarQueueFilter] = useState<CalendarQueueFilter>('upcoming');
  const [calendarViewMode, setCalendarViewMode] = useState<CalendarViewMode>(calendarOnly ? 'month' : 'week');
  const [calendarAnchorDateKey, setCalendarAnchorDateKey] = useState(() => formatLocalDateInput());
  const [calendarExpanded, setCalendarExpanded] = useState(() => (
    calendarOnly ? true : calendarPreference.get('bt.operationsCalendar.v2.expanded', true)
  ));
  const [calendarFiltersExpanded, setCalendarFiltersExpanded] = useState(false);
  const [calendarSearch, setCalendarSearch] = useState('');
  const [calendarPriorityFilter, setCalendarPriorityFilter] = useState('all');
  const [calendarStatusFilter, setCalendarStatusFilter] = useState('all');
  const [calendarReminderFilter, setCalendarReminderFilter] = useState('all');
  const [editingCalendarEvent, setEditingCalendarEvent] = useState<OperationsCalendarEvent | null>(null);
  const [calendarEditForm, setCalendarEditForm] = useState<CalendarEditForm>(blankCalendarEditForm);
  const [savingCalendarEdit, setSavingCalendarEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [liveNow, setLiveNow] = useState(() => new Date());
  const liveTodayKey = formatLocalDateInput(liveNow);
  const [lastCalendarTodayKey, setLastCalendarTodayKey] = useState(() => liveTodayKey);
  const calendarQueryRange = calendarRangeForView(calendarViewMode, calendarAnchorDateKey);
  const canAccessOperationsCalendar = Boolean(calendarOnly && user && ['super_admin', 'operations_manager', 'project_manager'].includes(user.role));
  const canDeleteProjectNotes = Boolean(user && ['super_admin', 'operations_manager'].includes(user.role));

  useEffect(() => {
    const timer = window.setInterval(() => setLiveNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    calendarPreference.set('bt.operationsCalendar.v2.expanded', calendarExpanded);
  }, [calendarExpanded]);

  useEffect(() => {
    if (liveTodayKey === lastCalendarTodayKey) return;
    setCalendarAnchorDateKey(current => current === lastCalendarTodayKey ? liveTodayKey : current);
    setLastCalendarTodayKey(liveTodayKey);
  }, [lastCalendarTodayKey, liveTodayKey]);

  useEffect(() => {
    const load = async () => {
      try {
        const [feedRes, calendarRes] = await Promise.all([
          calendarOnly
            ? Promise.resolve({ data: { items: [] } })
            : api.get('/dashboard/activity-feed?limit=25').catch(() => ({ data: { items: [] } })),
          canAccessOperationsCalendar
            ? api.get(`/calendar/events?start=${encodeURIComponent(calendarQueryRange.start)}&end=${encodeURIComponent(calendarQueryRange.end)}`).catch(() => ({ data: { events: [] } }))
            : Promise.resolve({ data: { events: [] } }),
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
  }, [user?.id, user?.role, calendarOnly, canAccessOperationsCalendar, calendarQueryRange.start, calendarQueryRange.end]);

  if (loading) return <Loading />;

  const firstName = user?.name?.split(' ')[0] || 'there';
  const now = liveNow;
  const liveNowIso = now.toISOString();
  const liveEasternTimeLabel = `${formatEasternTime(liveNowIso)
    .replace(/\sAM$/, ' A.M.')
    .replace(/\sPM$/, ' P.M.')} Eastern Time`;

  const refreshCalendarEvents = async (anchorDateKey = calendarAnchorDateKey, viewMode = calendarViewMode) => {
    const range = calendarRangeForView(viewMode, anchorDateKey);
    const res = await api.get(`/calendar/events?start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}`);
    setCalendarEvents(Array.isArray(res.data?.events) ? res.data.events : []);
  };

  const deleteDashboardNote = async (item: DashboardActivityFeedItem) => {
    if (!item.project_id || item.feed_type !== 'note' || !canDeleteProjectNotes || deletingActivityNoteId) return;
    if (!window.confirm('Delete this note? Attached photos will stay in the project photo history.')) return;
    setDeletingActivityNoteId(item.id);
    try {
      await api.delete(`/projects/${item.project_id}/notes/${item.id}`);
      setActivityFeed(current => current.filter(feedItem => !(feedItem.feed_type === 'note' && feedItem.id === item.id)));
      toast.success('Note deleted');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to delete note');
    } finally {
      setDeletingActivityNoteId(null);
    }
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

  const deleteCalendarEntry = async () => {
    if (!editingCalendarEvent) return;
    if (editingCalendarEvent.source === 'construction_task') {
      toast.error('Construction tasks cannot be deleted from the calendar. Mark them complete or edit the task instead.');
      return;
    }
    const confirmed = window.confirm(`Delete "${editingCalendarEvent.title || 'this calendar event'}"? This cannot be undone.`);
    if (!confirmed) return;

    setSavingCalendarEdit(true);
    setSavingCalendarEventId(editingCalendarEvent.id);
    try {
      await api.delete(`/calendar/events/${editingCalendarEvent.id}`);
      setEditingCalendarEvent(null);
      setCalendarEditForm(blankCalendarEditForm);
      await refreshCalendarEvents(calendarAnchorDateKey, calendarViewMode);
      toast.success('Calendar event deleted');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to delete calendar event');
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

  const todayKey = liveTodayKey;
  const calendarAnchorDate = localDateInputToNoonDate(calendarAnchorDateKey);
  const currentWeekStartDate = calendarAnchorDate;
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
      : calendarViewMode === 'list'
        ? `${formatCalendarBadgeDate(calendarQueryRange.start).label} - ${formatCalendarBadgeDate(calendarQueryRange.end).label}`
        : calendarMonthLabelFormatter.format(calendarMonthStartDate);
  const calendarViewKicker = calendarViewMode === 'today'
    ? (calendarAnchorDateKey === todayKey ? "Today's schedule" : 'Daily schedule')
    : calendarViewMode === 'week'
      ? 'Weekly schedule'
      : calendarViewMode === 'list'
        ? 'Agenda list'
        : 'Monthly schedule';
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
      if (calendarViewMode === 'list') return formatLocalDateInput(addCalendarDays(anchor, offset * 14));
      return formatLocalDateInput(addCalendarMonths(anchor, offset));
    });
    setExpandedCalendarNoteId(null);
  };
  const jumpToTodayCalendarView = () => {
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
  const baseDisplayedCalendarEvents = calendarQueueFilter === 'completed' ? completedCalendarEvents : upcomingCalendarEvents;
  const normalizedCalendarSearch = calendarSearch.trim().toLowerCase();
  const displayedCalendarEvents = baseDisplayedCalendarEvents.filter(event => {
    if (calendarPriorityFilter !== 'all' && event.priority !== calendarPriorityFilter) return false;
    if (calendarStatusFilter !== 'all' && editableCalendarStatus(event.status) !== calendarStatusFilter) return false;
    if (calendarReminderFilter === 'enabled' && Number(event.email_reminder_count || 0) === 0) return false;
    if (calendarReminderFilter === 'disabled' && Number(event.email_reminder_count || 0) > 0) return false;
    if (!normalizedCalendarSearch) return true;
    const haystack = [
      event.title,
      event.description,
      event.project_address,
      event.project_job_name,
      event.vendor_name,
      event.event_type,
      event.status,
      event.priority,
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(normalizedCalendarSearch);
  });
  const calendarViewEventCount = displayedCalendarEvents.length;
  const todayOpenCalendarEvents = calendarEvents.filter(event =>
    event.status !== 'completed' && calendarDateKeyForEvent(event) === todayKey
  );
  const thisWeekEndKey = formatLocalDateInput(addCalendarDays(localDateInputToNoonDate(todayKey), 6));
  const thisWeekCalendarEvents = calendarEvents.filter(event => {
    const dateKey = calendarDateKeyForEvent(event);
    return event.status !== 'completed' && Boolean(dateKey && dateKey >= todayKey && dateKey <= thisWeekEndKey);
  });
  const overdueCalendarEvents = calendarEvents.filter(event => {
    const dateKey = calendarDateKeyForEvent(event);
    return event.status !== 'completed' && event.status !== 'cancelled' && Boolean(dateKey && dateKey < todayKey);
  });
  const highPriorityCalendarEvents = displayedCalendarEvents.filter(event =>
    event.priority === 'critical' || event.priority === 'high'
  );
  const completedInViewCalendarEvents = completedCalendarEvents.filter(event => isCurrentViewEvent(event));
  const activeCalendarFiltersCount = [
    normalizedCalendarSearch,
    calendarPriorityFilter !== 'all',
    calendarStatusFilter !== 'all',
    calendarReminderFilter !== 'all',
  ].filter(Boolean).length;
  const calendarSummaryCards = [
    { label: 'Today', value: todayOpenCalendarEvents.length, detail: 'Open items today', tone: 'bt-calendar-summary-chip--blue' },
    { label: 'This Week', value: thisWeekCalendarEvents.length, detail: `${todayKey} to ${thisWeekEndKey}`, tone: 'bt-calendar-summary-chip--cyan' },
    { label: 'High Priority', value: highPriorityCalendarEvents.length, detail: 'Critical or high in view', tone: 'bt-calendar-summary-chip--red' },
    { label: 'Overdue', value: overdueCalendarEvents.length, detail: 'Past due in loaded range', tone: 'bt-calendar-summary-chip--amber' },
    { label: 'Completed', value: completedInViewCalendarEvents.length, detail: 'Completed in view', tone: 'bt-calendar-summary-chip--green' },
  ];
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
        card: 'bt-calendar-event-card bt-calendar-event-card--completed',
        rail: 'bt-calendar-event-rail bt-calendar-event-rail--completed',
        chip: 'bt-calendar-badge bt-calendar-badge--completed',
        time: 'bt-calendar-time-badge',
      };
    }

    if (event.priority === 'critical' || event.priority === 'high') {
      return {
        card: 'bt-calendar-event-card bt-calendar-event-card--priority',
        rail: 'bt-calendar-event-rail bt-calendar-event-rail--priority',
        chip: 'bt-calendar-badge bt-calendar-badge--priority',
        time: 'bt-calendar-time-badge',
      };
    }

    const tones: Record<string, { card: string; rail: string; chip: string; time: string }> = {
      task: {
        card: 'bt-calendar-event-card bt-calendar-event-card--task',
        rail: 'bt-calendar-event-rail bt-calendar-event-rail--task',
        chip: 'bt-calendar-badge bt-calendar-badge--task',
        time: 'bt-calendar-time-badge',
      },
      maintenance: {
        card: 'bt-calendar-event-card bt-calendar-event-card--maintenance',
        rail: 'bt-calendar-event-rail bt-calendar-event-rail--maintenance',
        chip: 'bt-calendar-badge bt-calendar-badge--maintenance',
        time: 'bt-calendar-time-badge',
      },
      inspection: {
        card: 'bt-calendar-event-card bt-calendar-event-card--inspection',
        rail: 'bt-calendar-event-rail bt-calendar-event-rail--inspection',
        chip: 'bt-calendar-badge bt-calendar-badge--inspection',
        time: 'bt-calendar-time-badge',
      },
      note: {
        card: 'bt-calendar-event-card bt-calendar-event-card--note',
        rail: 'bt-calendar-event-rail bt-calendar-event-rail--note',
        chip: 'bt-calendar-badge bt-calendar-badge--note',
        time: 'bt-calendar-time-badge',
      },
      other: {
        card: 'bt-calendar-event-card bt-calendar-event-card--other',
        rail: 'bt-calendar-event-rail bt-calendar-event-rail--other',
        chip: 'bt-calendar-badge bt-calendar-badge--other',
        time: 'bt-calendar-time-badge',
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
    const timeLabel = formatCalendarDueTimeLabel(event.due_time);
    const statusLabel = formatCompactLabel(editableCalendarStatus(event.status));
    const priorityLabel = formatCompactLabel(event.priority || 'normal');

    return (
      <article
        key={event.id}
        className={`bt-calendar-task-card group relative overflow-hidden rounded-xl border px-3 py-3 text-left transition ${tone.card} ${noteExpanded ? 'bt-calendar-event-card--open' : ''}`}
      >
        <span className={`absolute bottom-3 left-0 top-3 w-1 rounded-r-full ${tone.rail}`} />
        <div className="space-y-2 pl-2">
          <div className="flex min-w-0 items-start gap-2">
            <button
              type="button"
              onClick={() => setExpandedCalendarNoteId(noteExpanded ? null : event.id)}
              className="min-w-0 flex-1 rounded-md text-left focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-expanded={noteExpanded}
            >
              <p className={`truncate text-sm font-black leading-5 ${complete ? 'text-slate-500 line-through decoration-slate-400' : 'text-slate-950'}`} title={event.title}>
                {event.title || 'Untitled calendar item'}
              </p>
              <p className="mt-0.5 truncate text-xs font-semibold leading-4 text-slate-600" title={projectLabel}>
                {projectLabel}
              </p>
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void saveCalendarEventUpdate(event, {
                status: complete ? 'scheduled' : 'completed',
                completion_note: noteDraft,
              })}
              className={`inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border transition focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-50 ${complete ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-300 bg-white text-slate-500 hover:border-emerald-300 hover:text-emerald-700'}`}
              aria-label={`${complete ? 'Mark scheduled' : 'Mark complete'}: ${projectLabel} - ${event.title}`}
              title={complete ? 'Mark scheduled' : 'Mark complete'}
            >
              <CheckCircle2 className="h-4 w-4" />
            </button>
          </div>

          {calendarOnly ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <div className="bt-calendar-meta-line min-w-0 flex-1">
                <span>{timeLabel}</span>
                <span>{calendarTypeLabel(event.event_type)}</span>
                {(event.priority === 'critical' || event.priority === 'high') ? (
                  <span className="text-amber-800">{priorityLabel} priority</span>
                ) : null}
                {complete ? <span className="text-emerald-700">Completed</span> : (
                  <span>{statusLabel}</span>
                )}
                {Number(event.email_reminder_count || 0) > 0 ? <span>Email reminder</span> : null}
              </div>
              <button
                type="button"
                onClick={() => setExpandedCalendarNoteId(noteExpanded ? null : event.id)}
                className="inline-flex min-h-8 items-center rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                aria-expanded={noteExpanded}
              >
                {noteExpanded ? 'Close' : 'Details'}
              </button>
            </div>
          ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className={`inline-flex min-h-6 items-center gap-1 rounded-full px-2 text-[11px] font-black leading-none ${tone.time}`}>
              <Clock className="h-3 w-3" />
              {timeLabel}
            </span>
            <span className={`rounded-full px-2 py-1 text-[10px] font-black uppercase leading-none ${tone.chip}`}>
              {calendarTypeLabel(event.event_type)}
            </span>
            <span className={`rounded-full px-2 py-1 text-[10px] font-black uppercase leading-none ${event.priority === 'critical' || event.priority === 'high' ? 'bt-calendar-badge bt-calendar-badge--priority' : 'bt-calendar-badge bt-calendar-badge--neutral'}`}>
              {priorityLabel}
            </span>
            <span className={`rounded-full px-2 py-1 text-[10px] font-black uppercase leading-none ${complete ? 'bt-calendar-badge bt-calendar-badge--completed' : 'bt-calendar-badge bt-calendar-badge--neutral'}`}>
              {statusLabel}
            </span>
            {Number(event.email_reminder_count || 0) > 0 ? (
              <span className="bt-calendar-badge bt-calendar-badge--reminder inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-black uppercase leading-none">
                <Mail className="h-3 w-3" />
                Reminder
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => setExpandedCalendarNoteId(noteExpanded ? null : event.id)}
              className="ml-auto inline-flex min-h-7 items-center rounded-lg border border-slate-300 bg-white px-2 text-[10px] font-black uppercase tracking-wide text-slate-700 transition hover:bg-slate-50"
              aria-expanded={noteExpanded}
            >
              {noteExpanded ? 'Hide' : 'Details'}
            </button>
          </div>
          )}
        </div>
        {noteExpanded && (
          <div className="mt-3 grid gap-2 border-t border-slate-200 pt-3">
            {event.description ? (
              <p className="whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold leading-5 text-slate-700">
                {event.description}
              </p>
            ) : null}
            {event.vendor_name ? (
              <p className="break-words text-sm font-semibold leading-5 text-slate-600">
                Vendor: {event.vendor_name}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-500">
                Created for {projectLabel}
              </span>
              <button
                type="button"
                onClick={() => openCalendarEntryEditor(event)}
                disabled={saving}
                className="inline-flex h-8 flex-shrink-0 items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-2 text-[10px] font-black uppercase tracking-wide text-blue-700 transition hover:bg-blue-100 disabled:opacity-50"
                title="Edit calendar entry"
                aria-label={`Edit calendar entry: ${projectLabel} - ${event.title}`}
              >
                <Edit2 className="h-3 w-3" />
                Edit
              </button>
            </div>
            <VoiceTextarea
              value={noteDraft}
              onChange={inputEvent => updateCalendarCompletionNote(event.id, inputEvent.target.value)}
              rows={2}
              className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold leading-5 text-slate-950 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Add note..."
            />
            <span className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setExpandedCalendarNoteId(null)}
                className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[10px] font-black text-slate-700 hover:bg-slate-50"
              >
                Close
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void saveCalendarEventUpdate(event, { status: complete ? 'completed' : event.status, completion_note: noteDraft })}
                className="rounded-lg border border-emerald-600 bg-emerald-600 px-2 py-1 text-[10px] font-black text-white shadow-sm hover:bg-emerald-500 disabled:opacity-60"
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
        className={`bt-calendar-month-pill group relative flex min-w-0 items-start gap-1.5 overflow-hidden rounded-lg border px-2 py-2 ${tone.card}`}
      >
        <span className={`absolute bottom-2 left-0 top-2 w-0.5 rounded-r-full ${tone.rail}`} />
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
          className="ml-1 mt-0.5 h-3.5 w-3.5 flex-shrink-0 rounded border-slate-300 bg-white accent-emerald-600 shadow-sm"
          aria-label={`${complete ? 'Mark incomplete' : 'Mark complete'}: ${projectLabel} - ${event.title}`}
        />
        <button
          type="button"
          onClick={() => openCalendarEntryEditor(event)}
          className="min-w-0 flex-1 rounded text-left focus:outline-none focus:ring-2 focus:ring-blue-500"
          title={`${formatCalendarDueTimeLabel(event.due_time)} - ${event.title}`}
        >
          <span className={`block text-[11px] font-black leading-4 ${complete ? 'text-slate-500 line-through decoration-slate-400' : 'text-slate-950'}`}>
            {event.title}
          </span>
          <span className="mt-0.5 block truncate text-[10px] font-bold text-slate-600">
            {formatCalendarDueTimeLabel(event.due_time)}
          </span>
        </button>
        <button
          type="button"
          onClick={() => openCalendarEntryEditor(event)}
          disabled={saving}
          className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded border border-slate-300 bg-white text-slate-600 opacity-0 shadow-sm transition hover:bg-slate-50 group-hover:opacity-100 group-focus-within:opacity-100 disabled:opacity-50"
          aria-label={`Edit calendar entry: ${projectLabel} - ${event.title}`}
          title="Edit"
        >
          <Edit2 className="h-3 w-3" />
        </button>
      </div>
    );
  };

  const renderCalendarEmptyState = (_dateKey: string, label: string) => (
    <div className="bt-calendar-empty-state rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-center">
      <CalendarDays className="mx-auto h-6 w-6 text-slate-400" />
      <p className="mt-2 text-sm font-black text-slate-700">No scheduled items for this period</p>
      <p className="mt-1 text-xs font-semibold text-slate-500">{label}</p>
    </div>
  );

  const renderCalendarTodayView = () => {
    const todayEvents = sortCalendarEventsForDay(calendarEventsByDate[calendarAnchorDateKey] || []);
    const schedule = buildCalendarDayScheduleBucket(todayEvents);

    return (
      <div className="grid gap-4 bg-slate-50 p-4 xl:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-black uppercase tracking-wide text-blue-700">Selected day</p>
          <h3 className="mt-2 text-4xl font-black leading-none text-slate-950">
            {formatCalendarBadgeDate(calendarAnchorDateKey).day}
          </h3>
          <p className="mt-2 text-sm font-black text-slate-700">
            {formatEasternDate(`${calendarAnchorDateKey}T12:00:00`, { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2">
              <p className="text-[10px] font-black uppercase tracking-wide text-blue-700">Items</p>
              <p className="mt-1 text-xl font-black text-slate-950">{todayEvents.length}</p>
            </div>
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2">
              <p className="text-[10px] font-black uppercase tracking-wide text-emerald-700">Done</p>
              <p className="mt-1 text-xl font-black text-slate-950">{todayEvents.filter(event => event.status === 'completed').length}</p>
            </div>
          </div>
        </aside>

        <div className="bt-calendar-day-agenda min-w-0 rounded-2xl border border-slate-200 bg-white shadow-sm">
          {todayEvents.length === 0 ? (
            <div className="p-4">{renderCalendarEmptyState(calendarAnchorDateKey, formatCalendarBadgeDate(calendarAnchorDateKey).label)}</div>
          ) : (
            <div className="space-y-3 p-4">
              {schedule.untimed.length > 0 ? (
                <div className="bt-calendar-agenda-group grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 md:grid-cols-[96px_minmax(0,1fr)]">
                  <div className="px-1 text-left text-xs font-black uppercase tracking-wide text-slate-500 md:text-right">
                    No time
                  </div>
                  <div className="space-y-2">
                    {schedule.untimed.map(renderCalendarDayTask)}
                  </div>
                </div>
              ) : null}
              {calendarScheduleHours.map(hour => {
                const hourEvents = schedule.byHour[hour] || [];
                if (!hourEvents.length) return null;
                return (
                  <div key={hour} className="bt-calendar-agenda-group grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 md:grid-cols-[96px_minmax(0,1fr)]">
                    <div className="px-1 text-left text-xs font-black text-slate-500 md:text-right">
                      {formatCalendarHourLabel(hour)}
                    </div>
                    <div className="space-y-2">
                      {hourEvents.map(renderCalendarDayTask)}
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

  const renderCalendarWeekView = () => {
    const daySchedules = calendarVisibleWeekDays.map(day => ({
      day,
      events: sortCalendarEventsForDay(calendarEventsByDate[day.key] || []),
      schedule: buildCalendarDayScheduleBucket(calendarEventsByDate[day.key] || []),
    }));
    const hasEvents = daySchedules.some(day => day.events.length > 0);

    if (!hasEvents) {
      return <div className="bg-slate-50 p-4">{renderCalendarEmptyState(calendarAnchorDateKey, calendarViewTitle)}</div>;
    }

    return (
      <div className="overflow-x-auto bg-slate-50">
        <div className="min-w-[980px] p-4">
          <div className="grid grid-cols-[92px_repeat(7,minmax(118px,1fr))] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-r border-slate-200 bg-slate-100 px-3 py-3 text-xs font-black uppercase tracking-wide text-slate-500">
              Time
            </div>
            {daySchedules.map(({ day, events }) => {
              const badgeDate = formatCalendarBadgeDate(day.key);
              return (
                <div key={day.key} className={`border-b border-r border-slate-200 px-3 py-3 last:border-r-0 ${day.isToday ? 'bg-blue-50' : 'bg-white'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setCalendarViewMode('today');
                        setCalendarAnchorDateKey(day.key);
                        setExpandedCalendarNoteId(null);
                      }}
                      className="rounded-lg text-left focus:outline-none focus:ring-2 focus:ring-blue-500"
                      title={`Open daily schedule for ${badgeDate.label}`}
                    >
                      <span className="block text-xs font-black uppercase tracking-wide text-slate-500">{day.weekday}</span>
                      <span className="mt-0.5 block text-2xl font-black text-slate-950">{day.dayNumber}</span>
                    </button>
                    <span className={`rounded-full px-2 py-1 text-[10px] font-black ${events.length ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
                      {events.length}
                    </span>
                  </div>
                </div>
              );
            })}

            <div className="border-r border-slate-200 bg-slate-50 px-3 py-3 text-xs font-black uppercase tracking-wide text-slate-500">
              All day
            </div>
            {daySchedules.map(({ day, schedule }) => (
              <div key={`${day.key}-untimed`} className="min-h-[68px] border-r border-slate-200 p-2 last:border-r-0">
                {schedule.untimed.map(renderCalendarMonthEventPill)}
              </div>
            ))}

            {calendarScheduleHours.map(hour => (
              <div key={`${hour}-row`} className="contents">
                <div key={`${hour}-label`} className="border-t border-r border-slate-200 bg-slate-50 px-3 py-3 text-xs font-black text-slate-500">
                  {formatCalendarHourLabel(hour)}
                </div>
                {daySchedules.map(({ day, schedule }) => {
                  const hourEvents = schedule.byHour[hour] || [];
                  return (
                    <div key={`${day.key}-${hour}`} className="min-h-[76px] border-t border-r border-slate-200 p-2 last:border-r-0">
                      <div className="space-y-1.5">
                        {hourEvents.map(renderCalendarMonthEventPill)}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const renderCalendarMonthView = () => (
    <div className="overflow-x-auto bg-slate-50">
      <div className="min-w-[820px] p-4">
        <div className="grid grid-cols-7 overflow-hidden rounded-t-2xl border border-b-0 border-slate-200 bg-slate-100">
          {calendarWeekdayLabels.map(dayLabel => (
            <div key={dayLabel} className="border-r border-slate-200 px-3 py-2 text-[11px] font-black uppercase tracking-wide text-slate-600 last:border-r-0">
              {dayLabel}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 overflow-hidden rounded-b-2xl border border-slate-200 bg-white shadow-sm">
          {calendarVisibleMonthDays.map(day => {
            const dayEvents = sortCalendarEventsForDay(calendarEventsByDate[day.key] || []);
            const badgeDate = formatCalendarBadgeDate(day.key);
            return (
              <section
                key={day.key}
                className={`min-h-[142px] border-r border-b border-slate-200 p-2 last:border-r-0 ${day.isToday ? 'bg-blue-50 ring-1 ring-inset ring-blue-300' : day.isCurrentMonth ? 'bg-white' : 'bg-slate-50'}`}
              >
                <header className="mb-2 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setCalendarViewMode('today');
                      setCalendarAnchorDateKey(day.key);
                      setExpandedCalendarNoteId(null);
                    }}
                    className={`rounded-lg px-2 py-1 text-left text-sm font-black transition focus:outline-none focus:ring-2 focus:ring-blue-500 ${day.isCurrentMonth ? 'text-slate-950 hover:bg-slate-100' : 'text-slate-400 hover:bg-slate-100'}`}
                    title={`Open daily schedule for ${badgeDate.label}`}
                  >
                    {day.dayNumber}
                  </button>
                  <div className="flex items-center gap-1">
                    {dayEvents.length ? (
                      <span className="rounded-full bg-blue-600 px-1.5 py-0.5 text-[9px] font-black text-white shadow-sm">
                        {dayEvents.length}
                      </span>
                    ) : null}
                  </div>
                </header>
                <div className="space-y-1.5">
                  {dayEvents.map(renderCalendarMonthEventPill)}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );

  const renderCollapsedCalendarPreview = () => {
    const nextSevenEndKey = formatLocalDateInput(addCalendarDays(localDateInputToNoonDate(todayKey), 6));
    const todayAgenda = sortCalendarEventsForDay(displayedCalendarEvents.filter(event => calendarDateKeyForEvent(event) === todayKey));
    const upcomingAgenda = sortCalendarEventsForRange(displayedCalendarEvents.filter(event => {
      const dateKey = calendarDateKeyForEvent(event);
      return Boolean(dateKey && dateKey > todayKey && dateKey <= nextSevenEndKey);
    })).slice(0, 8);
    const hiddenCount = Math.max(displayedCalendarEvents.length - todayAgenda.length - upcomingAgenda.length, 0);
    const renderCompactAgendaItem = (event: OperationsCalendarEvent) => {
      const dateKey = calendarDateKeyForEvent(event) || todayKey;
      const badgeDate = formatCalendarBadgeDate(dateKey);
      const projectLabel = getCalendarProjectLabel(event);
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
          className={`bt-calendar-preview-task group relative min-w-0 overflow-hidden rounded-xl border px-3 py-2.5 text-left transition focus:outline-none focus:ring-2 focus:ring-blue-500 ${tone.card}`}
        >
          <span className={`absolute bottom-3 left-0 top-3 w-1 rounded-r-full ${tone.rail}`} />
          <span className="block pl-2">
            <span className="flex min-w-0 items-center justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-black text-slate-950">{event.title || 'Untitled calendar item'}</span>
              <span className={`flex-shrink-0 rounded-full px-2 py-1 text-[10px] font-black ${tone.time}`}>
                {formatCalendarDueTimeLabel(event.due_time)}
              </span>
            </span>
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="truncate text-xs font-semibold text-slate-600">{projectLabel}</span>
              <span className={`rounded-full px-2 py-1 text-[10px] font-black uppercase leading-none ${tone.chip}`}>
                {calendarTypeLabel(event.event_type)}
              </span>
              <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-black uppercase text-slate-600">
                {badgeDate.month} {badgeDate.day}
              </span>
            </span>
          </span>
        </button>
      );
    };

    return (
      <div className="bt-calendar-preview bg-slate-50 p-4">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] xl:items-stretch">
          <div className="bt-calendar-preview-list rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-black uppercase tracking-wide text-blue-700">Today's agenda</p>
                <h4 className="mt-1 text-xl font-black text-slate-950">{formatCalendarBadgeDate(todayKey).label}</h4>
              </div>
              <span className="rounded-full bg-blue-600 px-2.5 py-1 text-xs font-black text-white">{todayAgenda.length}</span>
            </div>
            <div className="grid gap-2">
              {todayAgenda.length ? todayAgenda.map(renderCompactAgendaItem) : renderCalendarEmptyState(todayKey, 'Today')}
            </div>
          </div>

          <div className="bt-calendar-preview-list min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-black uppercase tracking-wide text-slate-500">Upcoming 7 days</p>
                <h4 className="mt-1 text-xl font-black text-slate-950">{formatCalendarBadgeDate(todayKey).label} - {formatCalendarBadgeDate(nextSevenEndKey).label}</h4>
              </div>
              <span className="rounded-full bg-slate-900 px-2.5 py-1 text-xs font-black text-white">{upcomingAgenda.length}</span>
            </div>
            {upcomingAgenda.length ? (
              <div className="grid gap-2 lg:grid-cols-2">
                {upcomingAgenda.map(renderCompactAgendaItem)}
              </div>
            ) : renderCalendarEmptyState(todayKey, 'Upcoming 7 days')}
            {hiddenCount > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setCalendarExpanded(true);
                }}
                className="mt-3 inline-flex min-h-9 items-center rounded-lg border border-blue-600 bg-blue-600 px-3 text-xs font-black text-white shadow-sm transition hover:bg-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              >
                View {hiddenCount} more
              </button>
            ) : null}
          </div>

        </div>
      </div>
    );
  };

  const renderCalendarListView = () => {
    const grouped = sortCalendarEventsForRange(displayedCalendarEvents).reduce<Record<string, OperationsCalendarEvent[]>>((groups, event) => {
      const dateKey = calendarDateKeyForEvent(event) || calendarAnchorDateKey;
      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push(event);
      return groups;
    }, {});
    const dateKeys = Object.keys(grouped).sort();

    return (
      <div className="bg-slate-50 p-4">
        {dateKeys.length === 0 ? (
          renderCalendarEmptyState(calendarAnchorDateKey, calendarViewTitle)
        ) : (
          <div className="space-y-4">
            {dateKeys.map(dateKey => {
              const badgeDate = formatCalendarBadgeDate(dateKey);
              const dateEvents = grouped[dateKey] || [];
              return (
                <section key={dateKey} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                  <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
                    <div>
                      <p className="text-xs font-black uppercase tracking-wide text-slate-500">
                        {formatEasternDate(`${dateKey}T12:00:00`, { weekday: 'long' })}
                      </p>
                      <h4 className="text-lg font-black text-slate-950">{badgeDate.label}</h4>
                    </div>
                    <span className="rounded-full bg-slate-900 px-2.5 py-1 text-xs font-black text-white">
                      {dateEvents.length} {dateEvents.length === 1 ? 'item' : 'items'}
                    </span>
                  </header>
                  <div className="grid gap-2 p-4 md:grid-cols-2">
                    {dateEvents.map(renderCalendarDayTask)}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const renderSelectedCalendarView = () => {
    if (calendarViewMode === 'today') return renderCalendarTodayView();
    if (calendarViewMode === 'week') return renderCalendarWeekView();
    if (calendarViewMode === 'list') return renderCalendarListView();
    return renderCalendarMonthView();
  };

  const renderActivityFeedPanel = () => (
    <div
      id="recent-activity"
      className="bt-dashboard-notes-panel bt-dashboard-activity-panel relative overflow-hidden rounded-2xl border border-slate-700/70 shadow-[0_16px_40px_rgba(2,6,23,0.24)]"
      style={{
        background: 'linear-gradient(180deg, rgba(20,35,31,0.92), rgba(13,22,23,0.92))',
      }}
    >
      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-emerald-400 via-lime-300 to-amber-300" />
      <div
        className="bt-dashboard-notes-panel-header relative flex items-center justify-between gap-4 border-b border-white/10 px-5 py-4"
        style={{
          background: 'linear-gradient(90deg, rgba(22,101,52,0.22) 0%, rgba(132,204,22,0.10) 52%, rgba(245,158,11,0.08) 100%)',
        }}
      >
        <div className="flex items-center gap-3.5">
          <div
            className="flex h-11 w-11 items-center justify-center rounded-xl border shadow-[0_0_16px_rgba(34,197,94,0.14)]"
            style={{ background: 'rgba(34,197,94,0.16)', borderColor: 'rgba(134,239,172,0.46)' }}
          >
            <Activity className="h-5 w-5" style={{ color: '#BBF7D0' }} />
          </div>
          <div>
            <p className="bt-section-kicker text-[12px]">Latest company notes</p>
            <h2 className="text-xl font-black text-white">Latest Field & Office Notes</h2>
            <p className="text-sm font-semibold text-slate-300">{activityFeed.length} recent notes across all projects</p>
          </div>
        </div>
        <span className="hidden rounded-full border border-lime-300/30 bg-emerald-500/10 px-4 py-1.5 text-xs font-black uppercase tracking-wide text-lime-100 sm:inline-flex">
          25 latest notes
        </span>
      </div>

      {activityFeed.length === 0 ? (
        <div className="relative flex min-h-[96px] flex-col items-center justify-center px-4 py-6">
          <p className="text-sm font-bold text-white">No notes yet</p>
          <p className="mt-1 text-xs text-emerald-100">Recent field and office notes will appear here.</p>
        </div>
      ) : (
        <div className="relative grid grid-cols-1 gap-3 p-4">
          {activityFeed.map((item) => {
            const activityStyle = getActivityTypeStyle(item);
            const statusStyle = getProjectStatusStyle(item.project_status || undefined);
            const summary = getActivitySummary(item);
            const projectTarget = item.project_id ? `/projects/${item.project_id}` : '';
            const projectLabel = item.project_address || item.project_job_name || '';
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
                className={`group relative flex min-h-[112px] items-start gap-4 rounded-xl border border-white/10 p-4 transition-all hover:border-cyan-300/55 sm:p-5 ${projectTarget ? 'cursor-pointer' : 'cursor-default'}`}
                style={{
                  background: 'linear-gradient(135deg, rgba(15,23,42,0.88) 0%, rgba(30,41,59,0.76) 58%, rgba(8,47,73,0.42) 100%)',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
                }}
              >
                <span
                  className="absolute bottom-3 left-0 top-3 w-1.5 rounded-r-full"
                  style={{ background: activityStyle.accent }}
                />
                <div className="relative flex-shrink-0 pl-1">
                  <Avatar
                    src={item.user_avatar_url}
                    name={item.user_name}
                    size={60}
                    className="border-2"
                    style={{ borderColor: 'rgba(191,219,254,0.72)' }}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
                    <span className="truncate text-base font-black text-white">{item.user_name}</span>
                    <span className="text-xs font-semibold text-slate-300">
                      {formatEasternDateTime(item.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                    <span
                      className="inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-black uppercase"
                      style={{ background: activityStyle.bg, color: activityStyle.color, borderColor: activityStyle.border }}
                    >
                      {activityStyle.label}
                    </span>
                    <span
                      className="inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-black"
                      style={{ background: statusStyle.bg, color: statusStyle.color, borderColor: statusStyle.border }}
                    >
                      {statusStyle.label}
                    </span>
                    {projectLabel && (
                      <span
                        className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-black text-cyan-50 sm:max-w-[360px]"
                        style={{ background: 'rgba(8, 145, 178, 0.14)', borderColor: 'rgba(103, 232, 249, 0.32)' }}
                        title={projectLabel}
                      >
                        <MapPin className="h-3.5 w-3.5 flex-shrink-0 text-cyan-200" />
                        <span className="truncate">{projectLabel}</span>
                      </span>
                    )}
                  </div>
                  <p className="mt-4 whitespace-pre-wrap break-words rounded-lg border border-cyan-300/10 bg-slate-950/25 px-3 py-3 text-sm font-black leading-7 text-white shadow-inner sm:text-[15px]">
                    {summary}
                  </p>
                </div>
                <div className="flex flex-shrink-0 flex-col items-end gap-2 text-right">
                  <span className="rounded-full bg-blue-500/15 px-2.5 py-1 text-[11px] font-black text-blue-100 ring-1 ring-blue-300/25">
                    {formatEasternRelative(item.created_at)}
                  </span>
                  {projectTarget ? (
                    <span className="hidden rounded-md border border-slate-600/70 bg-slate-900/80 px-3 py-1.5 text-[11px] font-black uppercase tracking-wide text-slate-200 transition group-hover:border-cyan-300/60 group-hover:text-cyan-100 sm:inline">
                      Open
                    </span>
                  ) : null}
                  {canDeleteProjectNotes && item.feed_type === 'note' && item.project_id ? (
                    <button
                      type="button"
                      onClick={event => {
                        event.stopPropagation();
                        void deleteDashboardNote(item);
                      }}
                      disabled={deletingActivityNoteId === item.id}
                      className="inline-flex items-center gap-1 rounded-md border border-red-300/40 bg-red-500/15 px-3 py-1.5 text-[11px] font-black uppercase tracking-wide text-red-100 transition hover:border-red-200 hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                      title="Delete note"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {deletingActivityNoteId === item.id ? 'Deleting' : 'Delete'}
                    </button>
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
    <div className={`bt-desktop-page ${calendarOnly ? 'bt-calendar-route-page' : 'bt-dashboard-page'}`} style={{ minHeight: '100%' }}>
      {/* Hero header bar */}
      {!calendarOnly && (
      <div
        className="bt-dashboard-hero border-b px-4 py-4 md:px-6"
      >
        <div className="bt-dashboard-hero-content relative z-10 mx-auto grid max-w-none gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-3">
              <span
                className="bt-dashboard-hero-kicker inline-flex items-center gap-1.5 rounded-full border border-orange-300/45 bg-orange-500/10 px-3 py-1 text-[10px] font-black uppercase tracking-wide text-orange-200"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-current" />
                Operations Dashboard
              </span>
            </div>
            <h1 className="text-2xl font-black tracking-tight text-slate-50">
              {greeting()}, {firstName}
            </h1>
            <p className="mt-1 text-sm font-semibold text-slate-300">
              {formatEasternDate(liveNowIso, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              {' - '}
              {liveEasternTimeLabel}
              {' - '}
              {roleLabels[user?.role || '']}
            </p>
          </div>
          <div className="bt-dashboard-hero-actions hidden items-center gap-3 md:flex">
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
      )}

      <div className={`mx-auto ${calendarOnly ? 'max-w-none p-0' : 'max-w-[1720px] space-y-5 px-4 py-4 md:px-6'}`}>
        {/* Operations schedule */}
        {canAccessOperationsCalendar && (
        calendarOnly ? (
        <section className="bt-ops-calendar-pro" aria-label="Operations calendar">
          <div className="bt-ops-calendar-pro__header">
            <div className="min-w-0">
              <h1 className="bt-ops-calendar-pro__title">Operations Calendar</h1>
              <p className="bt-ops-calendar-pro__subtitle">
                Plan field work, inspections, deliveries, and reminders across all active jobsites.
              </p>
            </div>
            <AddToCalendarButton
              label="Add event"
              defaultTitle="BuildTrack operations reminder"
              defaultDescription="Created from the operations calendar."
              defaultDate={calendarAnchorDateKey}
              sourceType="dashboard"
              contextLabel="Operations calendar"
              allowEmailReminder={canCreateCalendarReminders}
              modalTitle="Add calendar event"
              buttonClassName="bt-ops-action-button bt-ops-action-button--primary"
              onSaved={refreshCalendarEvents}
            />
          </div>
          <div className="bt-ops-calendar-pro__stats">
            <div className="bt-ops-calendar-pro__stat"><span>Today</span><strong>{todayOpenCalendarEvents.length}</strong></div>
            <div className="bt-ops-calendar-pro__stat"><span>This week</span><strong>{thisWeekCalendarEvents.length}</strong></div>
            <div className={`bt-ops-calendar-pro__stat${overdueCalendarEvents.length ? ' bt-ops-calendar-pro__stat--alert' : ''}`}>
              <span>Overdue</span><strong>{overdueCalendarEvents.length}</strong>
            </div>
            <div className="bt-ops-calendar-pro__stat"><span>In view</span><strong>{calendarViewEventCount}</strong></div>
          </div>
          <div className="bt-ops-calendar-pro__controls">
            <label className="bt-ops-calendar-pro__search">
              <span className="sr-only">Search calendar</span>
              <input
                value={calendarSearch}
                onChange={event => setCalendarSearch(event.target.value)}
                placeholder="Search title, jobsite, or notes..."
              />
            </label>
            <div className="bt-ops-calendar-pro__queue" role="group" aria-label="Calendar queue">
              {([
                { key: 'upcoming', label: 'Upcoming', count: upcomingCalendarEvents.length },
                { key: 'completed', label: 'Completed', count: completedCalendarEvents.length },
              ] as const).map(filter => (
                <button
                  key={filter.key}
                  type="button"
                  onClick={() => {
                    setCalendarQueueFilter(filter.key);
                    setExpandedCalendarNoteId(null);
                  }}
                  aria-pressed={calendarQueueFilter === filter.key}
                >
                  {filter.label} ({filter.count})
                </button>
              ))}
            </div>
            <button
              type="button"
              className="bt-ops-calendar-pro__filters-toggle"
              onClick={() => setCalendarFiltersExpanded(current => !current)}
              aria-expanded={calendarFiltersExpanded}
            >
              Filters{activeCalendarFiltersCount ? ` (${activeCalendarFiltersCount})` : ''}
            </button>
          </div>
          {calendarFiltersExpanded ? (
            <div className="bt-ops-calendar-pro__filters-panel">
              <div className="bt-ops-calendar-pro__filter-grid">
                <label>
                  <span className="mb-1 block text-xs font-medium text-slate-600">Priority</span>
                  <select value={calendarPriorityFilter} onChange={event => setCalendarPriorityFilter(event.target.value)}>
                    <option value="all">All priorities</option>
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="normal">Normal</option>
                    <option value="low">Low</option>
                  </select>
                </label>
                <label>
                  <span className="mb-1 block text-xs font-medium text-slate-600">Status</span>
                  <select value={calendarStatusFilter} onChange={event => setCalendarStatusFilter(event.target.value)}>
                    <option value="all">All statuses</option>
                    <option value="scheduled">Scheduled</option>
                    <option value="in_progress">In progress</option>
                    <option value="completed">Completed</option>
                    <option value="cancelled">Canceled</option>
                  </select>
                </label>
                <label>
                  <span className="mb-1 block text-xs font-medium text-slate-600">Reminders</span>
                  <select value={calendarReminderFilter} onChange={event => setCalendarReminderFilter(event.target.value)}>
                    <option value="all">All reminder states</option>
                    <option value="enabled">Email enabled</option>
                    <option value="disabled">No email reminder</option>
                  </select>
                </label>
                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={() => {
                      setCalendarSearch('');
                      setCalendarPriorityFilter('all');
                      setCalendarStatusFilter('all');
                      setCalendarReminderFilter('all');
                    }}
                    disabled={activeCalendarFiltersCount === 0}
                    className="bt-ops-calendar-pro__clear-filters"
                  >
                    Clear filters
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          <div className="bt-ops-calendar-pro__shell">
            <div className="bt-ops-calendar-pro__toolbar">
              <div className="min-w-0">
                <h3>{calendarViewTitle}</h3>
                <p>{calendarViewEventCount} {calendarViewEventCount === 1 ? 'event' : 'events'} · {calendarViewKicker}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="bt-ops-calendar-pro__view-switch" role="group" aria-label="Calendar view">
                  {([
                    { key: 'today', label: 'Day' },
                    { key: 'week', label: 'Week' },
                    { key: 'month', label: 'Month' },
                    { key: 'list', label: 'List' },
                  ] as const).map(view => (
                    <button
                      key={view.key}
                      type="button"
                      onClick={() => changeCalendarViewMode(view.key)}
                      aria-pressed={calendarViewMode === view.key}
                    >
                      {view.label}
                    </button>
                  ))}
                </div>
                <div className="bt-ops-calendar-pro__nav flex items-center gap-1.5">
                  <button type="button" onClick={() => moveCalendarPeriod(-1)} aria-label={`Previous ${calendarViewMode}`}>
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button type="button" className="bt-ops-calendar-pro__today" onClick={jumpToTodayCalendarView}>
                    Today
                  </button>
                  <button type="button" onClick={() => moveCalendarPeriod(1)} aria-label={`Next ${calendarViewMode}`}>
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
            <div id="jobsite-operations-calendar-body" className="bt-ops-calendar-pro__body">
              {renderSelectedCalendarView()}
            </div>
          </div>
        </section>
        ) : (
        <section
          className="bt-dashboard-ops-panel relative overflow-hidden"
          aria-label="Operations schedule"
        >
          <div className="bt-dashboard-ops-strip absolute inset-x-0 top-0 h-1" />
          <div className="bt-dashboard-ops-header relative grid min-h-8 gap-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end">
            <div className="min-w-0">
              <p className="bt-section-kicker">Operations schedule</p>
              <h2 className="truncate text-2xl font-black tracking-tight text-slate-950">Operations Calendar</h2>
              <p className="mt-1 text-sm font-semibold text-slate-700">
                Schedule jobsites, field visits, tasks, inspections, material deliveries, and reminders.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <AddToCalendarButton
                label="Add Event"
                defaultTitle="BuildTrack operations reminder"
                defaultDescription="Created from the dashboard."
                defaultDate={calendarAnchorDateKey}
                sourceType="dashboard"
                contextLabel="Dashboard operations calendar"
                allowEmailReminder={canCreateCalendarReminders}
                modalTitle="Add Event"
                buttonClassName="bt-ops-action-button bt-ops-action-button--primary"
                onSaved={refreshCalendarEvents}
              />
            </div>
          </div>
          <div className="bt-calendar-filter-row mt-2 flex flex-wrap items-center gap-2">
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
                  className={`inline-flex min-h-10 items-center gap-2 rounded-full border px-4 py-2 text-sm font-black shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-blue-300/60 ${active ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white text-slate-800 hover:border-blue-300 hover:bg-blue-50'}`}
                  aria-pressed={active}
                >
                  {filter.label}
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-black ${active ? 'bg-white text-slate-950' : 'bg-slate-100 text-slate-700'}`}>
                    {filter.count}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-3 grid gap-2 grid-cols-2 lg:grid-cols-5">
            {calendarSummaryCards.map(card => (
              <div
                key={card.label}
                className={`bt-calendar-summary-chip rounded-xl border px-3 py-2.5 ${card.tone}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[10px] font-black uppercase tracking-wide">{card.label}</p>
                    <p className="mt-1 truncate text-[11px] font-bold opacity-75">{card.detail}</p>
                  </div>
                  <p className="text-2xl font-black">{card.value}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="bt-calendar-filter-panel mt-3 grid gap-2 rounded-2xl border border-slate-200 bg-white/85 p-3 shadow-sm lg:grid-cols-[minmax(220px,1fr)_160px_160px_180px_auto]">
            <label className="block min-w-0">
              <span className="mb-1 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wide text-slate-700">
                <ListFilter className="h-3.5 w-3.5" />
                Search
              </span>
              <input
                value={calendarSearch}
                onChange={event => setCalendarSearch(event.target.value)}
                className="min-h-10 w-full rounded-lg border border-slate-600 bg-white px-3 text-sm font-semibold text-slate-950 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-300"
                placeholder="Title, jobsite, notes..."
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-black uppercase tracking-wide text-slate-700">Priority</span>
              <select
                value={calendarPriorityFilter}
                onChange={event => setCalendarPriorityFilter(event.target.value)}
                className="min-h-10 w-full rounded-lg border border-slate-600 bg-white px-3 text-sm font-bold text-slate-950 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-300"
              >
                <option value="all">All priorities</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-black uppercase tracking-wide text-slate-700">Status</span>
              <select
                value={calendarStatusFilter}
                onChange={event => setCalendarStatusFilter(event.target.value)}
                className="min-h-10 w-full rounded-lg border border-slate-600 bg-white px-3 text-sm font-bold text-slate-950 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-300"
              >
                <option value="all">All statuses</option>
                <option value="scheduled">Scheduled</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Canceled</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-black uppercase tracking-wide text-slate-700">Reminders</span>
              <select
                value={calendarReminderFilter}
                onChange={event => setCalendarReminderFilter(event.target.value)}
                className="min-h-10 w-full rounded-lg border border-slate-600 bg-white px-3 text-sm font-bold text-slate-950 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-300"
              >
                <option value="all">All reminder states</option>
                <option value="enabled">Email enabled</option>
                <option value="disabled">No email reminder</option>
              </select>
            </label>
            <div className="flex items-end">
              <button
                type="button"
                onClick={() => {
                  setCalendarSearch('');
                  setCalendarPriorityFilter('all');
                  setCalendarStatusFilter('all');
                  setCalendarReminderFilter('all');
                }}
                disabled={activeCalendarFiltersCount === 0}
                className="min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-xs font-black uppercase tracking-wide text-slate-800 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Clear Filters
              </button>
            </div>
          </div>
          <div className="bt-calendar-shell mt-4 overflow-hidden rounded-[18px] border border-slate-200 bg-white shadow-xl shadow-slate-950/20">
            <div className="bt-calendar-toolbar sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
              <div className="min-w-0">
                <p className="text-[11px] font-black uppercase tracking-wide text-blue-700">{calendarViewKicker}</p>
                <h3 className="mt-0.5 text-lg font-black text-slate-950">{calendarViewTitle}</h3>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <div className="mr-1 inline-flex rounded-xl border border-slate-200 bg-slate-100 p-1 shadow-inner">
                  {([
                    { key: 'today', label: 'Day' },
                    { key: 'week', label: 'Week' },
                    { key: 'month', label: 'Month' },
                  ] as const).map(view => {
                    const active = calendarViewMode === view.key;
                    return (
                      <button
                        key={view.key}
                        type="button"
                        onClick={() => changeCalendarViewMode(view.key)}
                        className={`min-h-8 rounded-lg px-3 text-xs font-black transition focus:outline-none focus:ring-2 focus:ring-blue-500 ${active ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-600 hover:bg-white hover:text-slate-950'}`}
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
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 shadow-sm transition hover:bg-slate-50"
                  title={`Previous ${calendarViewMode}`}
                  aria-label={`Previous ${calendarViewMode}`}
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={jumpToTodayCalendarView}
                  className="inline-flex min-h-8 items-center rounded-lg border border-blue-600 bg-blue-600 px-2.5 text-xs font-black text-white shadow-sm transition hover:bg-blue-500"
                >
                  Today
                </button>
                <button
                  type="button"
                  onClick={() => moveCalendarPeriod(1)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 shadow-sm transition hover:bg-slate-50"
                  title={`Next ${calendarViewMode}`}
                  aria-label={`Next ${calendarViewMode}`}
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
                <span className="rounded-lg border border-slate-300 bg-slate-50 px-2.5 py-1 text-xs font-black text-slate-700 shadow-sm">
                  {calendarViewEventCount} {calendarViewEventCount === 1 ? 'item' : 'items'}
                </span>
                <button
                  type="button"
                  onClick={() => setCalendarExpanded(current => !current)}
                  className="bt-calendar-toggle-button inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 text-xs font-black text-slate-700 shadow-sm transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  aria-expanded={calendarExpanded}
                  aria-controls="jobsite-operations-calendar-body"
                >
                  {calendarExpanded ? 'Hide Calendar' : 'Expand Calendar'}
                  {calendarExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div id="jobsite-operations-calendar-body">
              {calendarExpanded ? renderSelectedCalendarView() : renderCollapsedCalendarPreview()}
            </div>
          </div>
        </section>
        ))}

        {calendarOnly && !canAccessOperationsCalendar && (
          <section
            className="bt-dashboard-ops-panel relative overflow-hidden"
            aria-label="Operations calendar access"
          >
            <div className="bt-dashboard-ops-strip absolute inset-x-0 top-0 h-1" />
            <div className="relative flex min-h-[360px] flex-col items-center justify-center gap-3 px-6 py-12 text-center">
              <CalendarDays className="h-10 w-10 text-slate-400" />
              <div>
                <p className="bt-section-kicker">Operations calendar</p>
                <h2 className="mt-1 text-2xl font-black text-slate-950">Calendar access required</h2>
                <p className="mt-2 max-w-xl text-sm font-semibold text-slate-700">
                  This calendar is available to Super Admin, Operations Manager, and Project Manager users.
                </p>
              </div>
            </div>
          </section>
        )}

        {!calendarOnly && renderActivityFeedPanel()}

        {/* Footer */}
        {!calendarOnly && (
        <div className="flex items-center justify-between py-2">
          <p className="text-xs text-gray-400">© 2026 New Urban Development · BuildTrack Platform</p>
          <p className="text-xs text-gray-400">Live time: {liveEasternTimeLabel}</p>
        </div>
        )}
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

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3">
            <div>
              {editingCalendarEvent?.source !== 'construction_task' && (
                <button
                  type="button"
                  onClick={deleteCalendarEntry}
                  disabled={savingCalendarEdit}
                  className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 text-sm font-black text-red-700 transition hover:bg-red-100 disabled:opacity-60"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete Event
                </button>
              )}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
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
        </div>
      </Modal>

    </div>
  );
}
