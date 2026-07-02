import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  addDays,
  addMonths,
  addWeeks,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  parseISO,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import {
  CalendarDays,
  CalendarPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Filter,
  Loader2,
  MapPin,
  Pencil,
  Search,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';

type CalendarView = 'day' | 'week' | 'month';
type CalendarKind = 'event' | 'task';
type CalendarStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
type CalendarPriority = 'low' | 'normal' | 'high' | 'critical';
type BackendEventType = 'task' | 'maintenance' | 'inspection' | 'note' | 'other';
type CategoryId = 'inspection' | 'site_visit' | 'delivery' | 'crew_schedule' | 'internal_task' | 'maintenance' | 'other';

interface CalendarEvent {
  id: string;
  source: string;
  source_id: string;
  event_type: BackendEventType;
  title: string;
  description?: string | null;
  scheduled_for: string;
  due_time?: string | null;
  status: CalendarStatus;
  priority: CalendarPriority;
  vendor_name?: string | null;
  project_id?: string | null;
  project_address?: string | null;
  project_job_name?: string | null;
  created_by_name?: string | null;
  created_at?: string | null;
  email_reminder_count?: number;
  next_email_reminder_at?: string | null;
  completion_note?: string | null;
  completed_at?: string | null;
}

interface ProjectOption {
  id: string;
  address?: string | null;
  job_name?: string | null;
  status?: string | null;
}

interface EventFormState {
  id: string | null;
  kind: CalendarKind;
  title: string;
  scheduled_for: string;
  all_day: boolean;
  start_time: string;
  end_time: string;
  category: CategoryId;
  assignee: string;
  project_id: string;
  location: string;
  notes: string;
  priority: CalendarPriority;
  status: CalendarStatus;
}

interface ParsedDetails {
  category?: CategoryId;
  assignee?: string;
  location?: string;
  end_time?: string;
  all_day?: boolean;
  notes: string;
}

interface CategoryOption {
  id: CategoryId;
  label: string;
  backendType: BackendEventType;
  color: string;
  text: string;
}

const CATEGORY_OPTIONS: CategoryOption[] = [
  { id: 'inspection', label: 'Inspection', backendType: 'inspection', color: '#A8553A', text: '#FFFFFF' },
  { id: 'site_visit', label: 'Site Visit', backendType: 'maintenance', color: '#7E8C72', text: '#FFFFFF' },
  { id: 'delivery', label: 'Delivery', backendType: 'maintenance', color: '#C2773F', text: '#FFFFFF' },
  { id: 'crew_schedule', label: 'Crew Schedule', backendType: 'task', color: '#2E3338', text: '#FFFFFF' },
  { id: 'internal_task', label: 'Task', backendType: 'task', color: '#E7E0D4', text: '#2E3338' },
  { id: 'maintenance', label: 'Maintenance', backendType: 'maintenance', color: '#B88A5B', text: '#FFFFFF' },
  { id: 'other', label: 'Other', backendType: 'other', color: '#6F767D', text: '#FFFFFF' },
];

const STATUS_OPTIONS: { value: CalendarStatus; label: string }[] = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const PRIORITY_OPTIONS: { value: CalendarPriority; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

const START_HOUR = 6;
const END_HOUR = 20;
const HOUR_HEIGHT = 68;
const HOURS = Array.from({ length: END_HOUR - START_HOUR }, (_, index) => START_HOUR + index);
const ALL_CATEGORIES = CATEGORY_OPTIONS.map(option => option.id);
const ROUTE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function safeRouteDateKey(value?: string | null) {
  return value && ROUTE_DATE_PATTERN.test(value) ? value : '';
}

function dateKey(date: Date) {
  return format(date, 'yyyy-MM-dd');
}

function parseDate(value?: string | null) {
  if (!value) return new Date();
  const normalized = value.length === 10 ? `${value}T12:00:00` : value;
  const date = parseISO(normalized);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function timeLabel(hour: number) {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  return format(date, 'h a');
}

function eventTimeLabel(event: CalendarEvent) {
  if (!event.due_time) return 'All day';
  const [hourRaw, minuteRaw] = event.due_time.split(':');
  const date = new Date();
  date.setHours(Number(hourRaw || 0), Number(minuteRaw || 0), 0, 0);
  return format(date, 'h:mm a');
}

function addOneHour(time: string) {
  const [hourRaw, minuteRaw] = time.split(':');
  const hour = Math.min(23, Number(hourRaw || 8) + 1);
  const minute = Number(minuteRaw || 0);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function categoryById(id?: string | null) {
  return CATEGORY_OPTIONS.find(option => option.id === id) || CATEGORY_OPTIONS[CATEGORY_OPTIONS.length - 1];
}

function projectLabel(project?: ProjectOption | null) {
  if (!project) return '';
  return project.job_name || project.address || 'Project site';
}

function eventProjectLabel(event: CalendarEvent) {
  return event.project_job_name || event.project_address || '';
}

function eventMetaLabel(event: CalendarEvent) {
  return [eventTimeLabel(event), eventProjectLabel(event)].filter(Boolean).join(' - ');
}

function eventChipPrefix(event: CalendarEvent, category: CategoryOption) {
  if (event.due_time) return eventTimeLabel(event);
  return category.id === 'internal_task' ? '' : category.label;
}

function categoryFromBackend(event: CalendarEvent): CategoryId {
  const parsed = parseDetails(event.description);
  if (parsed.category) return parsed.category;
  if (event.event_type === 'inspection') return 'inspection';
  if (event.event_type === 'maintenance') return 'maintenance';
  if (event.event_type === 'task') return event.source === 'construction_task' ? 'crew_schedule' : 'internal_task';
  if (event.event_type === 'note') return 'internal_task';
  return 'other';
}

function backendTypeFor(category: CategoryId, kind: CalendarKind): BackendEventType {
  if (kind === 'task') return 'task';
  return categoryById(category).backendType;
}

function parseDetails(description?: string | null): ParsedDetails {
  const raw = String(description || '').trim();
  if (!raw) return { notes: '' };

  const details: ParsedDetails = { notes: '' };
  const noteLines: string[] = [];
  let notesStarted = false;

  raw.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) {
      if (notesStarted || noteLines.length > 0) noteLines.push('');
      return;
    }
    if (/^notes:?$/i.test(trimmed)) {
      notesStarted = true;
      return;
    }
    if (!notesStarted) {
      const [key, ...rest] = trimmed.split(':');
      const value = rest.join(':').trim();
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === 'category') {
        const normalizedValue = value.toLowerCase();
        const legacyCategory = normalizedValue === 'internal task' ? 'internal_task' : null;
        const match = CATEGORY_OPTIONS.find(option =>
          option.label.toLowerCase() === normalizedValue || option.id === value || option.id === legacyCategory
        );
        if (match) details.category = match.id;
        return;
      }
      if (normalizedKey === 'assignee/crew' || normalizedKey === 'assignee' || normalizedKey === 'crew') {
        details.assignee = value;
        return;
      }
      if (normalizedKey === 'location') {
        details.location = value;
        return;
      }
      if (normalizedKey === 'end time') {
        details.end_time = value.slice(0, 5);
        return;
      }
      if (normalizedKey === 'all-day' || normalizedKey === 'all day') {
        details.all_day = /^yes|true$/i.test(value);
        return;
      }
    }
    noteLines.push(line);
  });

  details.notes = noteLines.join('\n').trim();
  return details;
}

function buildDescription(form: EventFormState) {
  const category = categoryById(form.category);
  const lines = [
    `Category: ${category.label}`,
    form.assignee.trim() ? `Assignee/Crew: ${form.assignee.trim()}` : '',
    form.location.trim() ? `Location: ${form.location.trim()}` : '',
    form.all_day ? 'All-day: Yes' : '',
    !form.all_day && form.end_time ? `End Time: ${form.end_time}` : '',
  ].filter(Boolean);

  const notes = form.notes.trim();
  return notes ? `${lines.join('\n')}\n\nNotes:\n${notes}` : lines.join('\n');
}

function emptyForm(date: Date): EventFormState {
  return {
    id: null,
    kind: 'event',
    title: '',
    scheduled_for: dateKey(date),
    all_day: false,
    start_time: '08:00',
    end_time: '09:00',
    category: 'site_visit',
    assignee: '',
    project_id: '',
    location: '',
    notes: '',
    priority: 'normal',
    status: 'scheduled',
  };
}

function formFromEvent(event: CalendarEvent): EventFormState {
  const details = parseDetails(event.description);
  const startTime = event.due_time?.slice(0, 5) || '08:00';
  return {
    id: event.id,
    kind: event.event_type === 'task' ? 'task' : 'event',
    title: event.title || '',
    scheduled_for: dateKey(parseDate(event.scheduled_for)),
    all_day: details.all_day ?? !event.due_time,
    start_time: startTime,
    end_time: details.end_time || addOneHour(startTime),
    category: details.category || categoryFromBackend(event),
    assignee: event.vendor_name || details.assignee || '',
    project_id: event.project_id || '',
    location: details.location || '',
    notes: details.notes,
    priority: event.priority || 'normal',
    status: event.status || 'scheduled',
  };
}

function eventSort(left: CalendarEvent, right: CalendarEvent) {
  const leftTime = left.due_time || '00:00';
  const rightTime = right.due_time || '00:00';
  return `${left.scheduled_for} ${leftTime} ${left.title}`.localeCompare(`${right.scheduled_for} ${rightTime} ${right.title}`);
}

function positionFor(event: CalendarEvent) {
  if (!event.due_time) return { top: 0, height: HOUR_HEIGHT };
  const [hourRaw, minuteRaw] = event.due_time.split(':');
  const hour = Number(hourRaw || START_HOUR);
  const minute = Number(minuteRaw || 0);
  const startMinutes = Math.max(0, ((hour - START_HOUR) * 60) + minute);
  const details = parseDetails(event.description);
  let duration = 60;
  if (details.end_time) {
    const [endHourRaw, endMinuteRaw] = details.end_time.split(':');
    const endMinutes = ((Number(endHourRaw || hour) - hour) * 60) + (Number(endMinuteRaw || 0) - minute);
    duration = Math.max(30, endMinutes);
  }
  return {
    top: (startMinutes / 60) * HOUR_HEIGHT,
    height: Math.max(34, (duration / 60) * HOUR_HEIGHT),
  };
}

export default function OperationsCalendar() {
  const [searchParams] = useSearchParams();
  const routeDateKey = safeRouteDateKey(searchParams.get('date'));
  const routeEventId = searchParams.get('event') || '';
  const handledRouteEventRef = useRef('');
  const [view, setView] = useState<CalendarView>('month');
  const [selectedDate, setSelectedDate] = useState(() => routeDateKey ? parseDate(routeDateKey) : new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('all');
  const [categoryFilters, setCategoryFilters] = useState<Set<CategoryId>>(() => new Set(ALL_CATEGORIES));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<EventFormState>(() => emptyForm(new Date()));

  const range = useMemo(() => {
    if (view === 'month') {
      const monthStart = startOfMonth(selectedDate);
      const monthEnd = endOfMonth(selectedDate);
      return {
        start: startOfWeek(monthStart, { weekStartsOn: 0 }),
        end: endOfWeek(monthEnd, { weekStartsOn: 0 }),
      };
    }
    if (view === 'week') {
      return {
        start: startOfWeek(selectedDate, { weekStartsOn: 0 }),
        end: endOfWeek(selectedDate, { weekStartsOn: 0 }),
      };
    }
    return { start: selectedDate, end: selectedDate };
  }, [selectedDate, view]);

  const rangeDays = useMemo(() => eachDayOfInterval(range), [range]);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get('/calendar/events', {
        params: {
          start: dateKey(range.start),
          end: dateKey(range.end),
        },
      });
      const loaded = Array.isArray(response.data?.events) ? response.data.events : [];
      setEvents(loaded.sort(eventSort));
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to load calendar');
    } finally {
      setLoading(false);
    }
  }, [range.end, range.start]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    if (!routeDateKey) return;
    setView('month');
    setSelectedDate(parseDate(routeDateKey));
  }, [routeDateKey]);

  useEffect(() => {
    let mounted = true;
    api.get('/projects')
      .then(response => {
        const data = response.data;
        const loaded = Array.isArray(data) ? data : (Array.isArray(data?.projects) ? data.projects : []);
        if (mounted) setProjects(loaded);
      })
      .catch(() => {
        if (mounted) setProjects([]);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!routeEventId) return;

    const launchKey = `${routeDateKey || ''}:${routeEventId}`;
    if (handledRouteEventRef.current === launchKey) return;

    const routeEvent = events.find(event => event.id === routeEventId);
    if (!routeEvent) return;

    setView('month');
    setSelectedDate(parseDate(routeEvent.scheduled_for));
    setSearch('');
    setAssigneeFilter('all');
    setCategoryFilters(new Set(ALL_CATEGORIES));
    setForm(formFromEvent(routeEvent));
    setModalOpen(true);
    handledRouteEventRef.current = launchKey;
  }, [events, routeDateKey, routeEventId]);

  const filteredEvents = useMemo(() => {
    const query = search.trim().toLowerCase();
    return events.filter(event => {
      const category = categoryFromBackend(event);
      if (!categoryFilters.has(category)) return false;
      const assignee = event.vendor_name || parseDetails(event.description).assignee || event.created_by_name || '';
      if (assigneeFilter !== 'all' && assignee !== assigneeFilter) return false;
      if (!query) return true;
      const haystack = [
        event.title,
        event.description,
        event.project_address,
        event.project_job_name,
        event.vendor_name,
        event.created_by_name,
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    }).sort(eventSort);
  }, [assigneeFilter, categoryFilters, events, search]);

  const eventsByDay = useMemo(() => {
    const grouped = new Map<string, CalendarEvent[]>();
    filteredEvents.forEach(event => {
      const key = dateKey(parseDate(event.scheduled_for));
      grouped.set(key, [...(grouped.get(key) || []), event]);
    });
    grouped.forEach(dayEvents => dayEvents.sort(eventSort));
    return grouped;
  }, [filteredEvents]);

  const assigneeOptions = useMemo(() => {
    const values = new Set<string>();
    events.forEach(event => {
      const parsed = parseDetails(event.description);
      const value = event.vendor_name || parsed.assignee || event.created_by_name || '';
      if (value.trim()) values.add(value.trim());
    });
    return Array.from(values).sort((left, right) => left.localeCompare(right));
  }, [events]);

  const periodTitle = useMemo(() => {
    if (view === 'day') return format(selectedDate, 'EEEE, MMMM d');
    if (view === 'week') {
      const start = startOfWeek(selectedDate, { weekStartsOn: 0 });
      const end = endOfWeek(selectedDate, { weekStartsOn: 0 });
      return `${format(start, 'MMM d')} - ${format(end, 'MMM d, yyyy')}`;
    }
    return format(selectedDate, 'MMMM yyyy');
  }, [selectedDate, view]);

  const openCreate = (date = selectedDate, hour = 8) => {
    const next = emptyForm(date);
    next.start_time = `${String(hour).padStart(2, '0')}:00`;
    next.end_time = addOneHour(next.start_time);
    setForm(next);
    setModalOpen(true);
  };

  const openEdit = (event: CalendarEvent) => {
    setForm(formFromEvent(event));
    setModalOpen(true);
  };

  const shiftPeriod = (direction: -1 | 1) => {
    setSelectedDate(current => {
      if (view === 'day') return addDays(current, direction);
      if (view === 'week') return addWeeks(current, direction);
      return addMonths(current, direction);
    });
  };

  const toggleCategory = (category: CategoryId) => {
    setCategoryFilters(current => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next.size ? next : new Set([category]);
    });
  };

  const submitForm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = form.title.trim();
    if (!title) {
      toast.error('Title is required');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        title,
        scheduled_for: form.scheduled_for,
        due_time: form.all_day ? null : form.start_time,
        event_type: backendTypeFor(form.category, form.kind),
        priority: form.priority,
        status: form.status,
        description: buildDescription(form),
        vendor_name: form.assignee.trim() || null,
        project_id: form.project_id || null,
      };
      if (form.id) {
        await api.put(`/calendar/events/${form.id}`, payload);
        toast.success('Calendar item updated');
      } else {
        await api.post('/calendar/events', payload);
        toast.success('Calendar item added');
      }
      setModalOpen(false);
      await loadEvents();
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to save calendar item');
    } finally {
      setSaving(false);
    }
  };

  const deleteEvent = async () => {
    if (!form.id) return;
    if (form.id.startsWith('task-')) {
      toast.error('Construction tasks cannot be deleted from the calendar');
      return;
    }
    setSaving(true);
    try {
      await api.delete(`/calendar/events/${form.id}`);
      toast.success('Calendar item deleted');
      setModalOpen(false);
      await loadEvents();
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to delete calendar item');
    } finally {
      setSaving(false);
    }
  };

  const updateEventDateTime = async (item: CalendarEvent, scheduledFor: string, dueTime: string | null) => {
    try {
      await api.put(`/calendar/events/${item.id}`, {
        scheduled_for: scheduledFor,
        due_time: dueTime,
      });
      setEvents(current => current.map(event =>
        event.id === item.id ? { ...event, scheduled_for: scheduledFor, due_time: dueTime } : event
      ));
      toast.success('Calendar item rescheduled');
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Could not reschedule item');
      loadEvents();
    }
  };

  const onDragStart = (event: DragEvent<HTMLElement>, item: CalendarEvent) => {
    event.dataTransfer.setData('text/plain', item.id);
    event.dataTransfer.effectAllowed = 'move';
  };

  const onDropToSlot = (event: DragEvent<HTMLElement>, day: Date, hour: number | null) => {
    event.preventDefault();
    const id = event.dataTransfer.getData('text/plain');
    const item = events.find(calendarEvent => calendarEvent.id === id);
    if (!item) return;
    updateEventDateTime(item, dateKey(day), hour === null ? null : `${String(hour).padStart(2, '0')}:00`);
  };

  return (
    <div className="bt-calendar-route-page">
      <section className="ops-calendar" aria-label="Operations calendar">
        <ControlBar
          periodTitle={periodTitle}
          view={view}
          onViewChange={setView}
          onPrevious={() => shiftPeriod(-1)}
          onNext={() => shiftPeriod(1)}
          onToday={() => setSelectedDate(new Date())}
          onAdd={() => openCreate(selectedDate)}
        />

        <div className="ops-calendar__filters" aria-label="Calendar filters">
          <label className="ops-search">
            <Search size={18} aria-hidden="true" />
            <span className="sr-only">Search calendar</span>
            <input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Search events"
            />
          </label>
          <button
            type="button"
            className="ops-depth-button ops-filter-toggle"
            onClick={() => setFiltersOpen(open => !open)}
            aria-expanded={filtersOpen}
          >
            <Filter size={17} aria-hidden="true" />
            Filters
            <ChevronDown size={16} aria-hidden="true" />
          </button>
          <label className="ops-assignee-select">
            <span>Assignee</span>
            <select value={assigneeFilter} onChange={event => setAssigneeFilter(event.target.value)}>
              <option value="all">All crews</option>
              {assigneeOptions.map(option => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
        </div>

        {filtersOpen && (
          <div className="ops-category-filter" aria-label="Category filters">
            {CATEGORY_OPTIONS.map(category => (
              <button
                key={category.id}
                type="button"
                className={`ops-category-filter__button ${categoryFilters.has(category.id) ? 'is-active' : ''}`}
                onClick={() => toggleCategory(category.id)}
              >
                <span style={{ backgroundColor: category.color }} />
                {category.label}
              </button>
            ))}
            <button
              type="button"
              className="ops-category-filter__reset"
              onClick={() => setCategoryFilters(new Set(ALL_CATEGORIES))}
            >
              Show all
            </button>
          </div>
        )}

        <div className="ops-calendar__body" aria-busy={loading}>
          {loading ? (
            <div className="ops-loading" role="status">
              <Loader2 className="ops-spin" size={22} aria-hidden="true" />
              Loading calendar
            </div>
          ) : view === 'month' ? (
            <MonthView
              days={rangeDays}
              selectedDate={selectedDate}
              eventsByDay={eventsByDay}
              onSelectDay={day => setSelectedDate(day)}
              onOpenDay={day => {
                setSelectedDate(day);
                setView('day');
              }}
              onCreate={openCreate}
              onEdit={openEdit}
            />
          ) : view === 'week' ? (
            <WeekView
              days={rangeDays}
              eventsByDay={eventsByDay}
              onCreate={openCreate}
              onEdit={openEdit}
              onDragStart={onDragStart}
              onDropToSlot={onDropToSlot}
            />
          ) : (
            <DayView
              day={selectedDate}
              events={eventsByDay.get(dateKey(selectedDate)) || []}
              onCreate={openCreate}
              onEdit={openEdit}
              onDragStart={onDragStart}
              onDropToSlot={onDropToSlot}
            />
          )}
        </div>
      </section>

      {modalOpen && (
        <EventModal
          form={form}
          projects={projects}
          saving={saving}
          onClose={() => setModalOpen(false)}
          onDelete={deleteEvent}
          onSubmit={submitForm}
          onChange={setForm}
        />
      )}
    </div>
  );
}

function ControlBar({
  periodTitle,
  view,
  onViewChange,
  onPrevious,
  onNext,
  onToday,
  onAdd,
}: {
  periodTitle: string;
  view: CalendarView;
  onViewChange: (view: CalendarView) => void;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  onAdd: () => void;
}) {
  return (
    <div className="ops-control-bar">
      <div className="ops-period-control">
        <button type="button" className="ops-icon-button" onClick={onPrevious} aria-label="Previous period" title="Previous">
          <ChevronLeft size={20} aria-hidden="true" />
        </button>
        <div className="ops-period-control__title">
          <CalendarDays size={20} aria-hidden="true" />
          <h1>{periodTitle}</h1>
        </div>
        <button type="button" className="ops-icon-button" onClick={onNext} aria-label="Next period" title="Next">
          <ChevronRight size={20} aria-hidden="true" />
        </button>
        <button type="button" className="ops-depth-button ops-today-button" onClick={onToday}>
          Today
        </button>
      </div>

      <div className="ops-view-toggle" role="group" aria-label="Calendar view">
        {(['day', 'week', 'month'] as CalendarView[]).map(option => (
          <button
            key={option}
            type="button"
            className={view === option ? 'is-active' : ''}
            onClick={() => onViewChange(option)}
            aria-pressed={view === option}
          >
            {option[0].toUpperCase()}{option.slice(1)}
          </button>
        ))}
      </div>

      <button type="button" className="ops-add-button" onClick={onAdd}>
        <CalendarPlus size={19} aria-hidden="true" />
        Add Event
      </button>
    </div>
  );
}

function MonthView({
  days,
  selectedDate,
  eventsByDay,
  onSelectDay,
  onOpenDay,
  onCreate,
  onEdit,
}: {
  days: Date[];
  selectedDate: Date;
  eventsByDay: Map<string, CalendarEvent[]>;
  onSelectDay: (day: Date) => void;
  onOpenDay: (day: Date) => void;
  onCreate: (day: Date) => void;
  onEdit: (event: CalendarEvent) => void;
}) {
  return (
    <div className="ops-month">
      <div className="ops-month__weekdays">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
          <div key={day}>{day}</div>
        ))}
      </div>
      <div className="ops-month__grid">
        {days.map(day => {
          const key = dateKey(day);
          const dayEvents = eventsByDay.get(key) || [];
          const visible = dayEvents.slice(0, 3);
          const overflow = dayEvents.length - visible.length;
          return (
            <div
              key={key}
              className={`ops-month-day ${isSameMonth(day, selectedDate) ? '' : 'is-muted'} ${isToday(day) ? 'is-today' : ''}`}
              onClick={() => onSelectDay(day)}
            >
              <div className="ops-month-day__top">
                <button type="button" className="ops-month-day__number" onClick={() => onOpenDay(day)}>
                  {format(day, 'd')}
                </button>
                <button type="button" className="ops-month-day__add" onClick={() => onCreate(day)} aria-label={`Add event on ${format(day, 'MMMM d')}`}>
                  +
                </button>
              </div>
              <div className="ops-month-day__events">
                {visible.map(event => (
                  <EventChip key={event.id} event={event} compact onClick={() => onEdit(event)} />
                ))}
                {overflow > 0 && (
                  <button type="button" className="ops-more-button" onClick={() => onOpenDay(day)}>
                    +{overflow} more
                  </button>
                )}
                {dayEvents.length === 0 && isSameDay(day, selectedDate) && (
                  <button type="button" className="ops-empty-day" onClick={() => onCreate(day)}>
                    No events - add one
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekView({
  days,
  eventsByDay,
  onCreate,
  onEdit,
  onDragStart,
  onDropToSlot,
}: {
  days: Date[];
  eventsByDay: Map<string, CalendarEvent[]>;
  onCreate: (day: Date, hour?: number) => void;
  onEdit: (event: CalendarEvent) => void;
  onDragStart: (event: DragEvent<HTMLElement>, item: CalendarEvent) => void;
  onDropToSlot: (event: DragEvent<HTMLElement>, day: Date, hour: number | null) => void;
}) {
  return (
    <div className="ops-week">
      <div className="ops-week__header">
        <div className="ops-week__time-gutter" />
        {days.map(day => (
          <div key={dateKey(day)} className={`ops-week__day-heading ${isToday(day) ? 'is-today' : ''}`}>
            <span>{format(day, 'EEE')}</span>
            <strong>{format(day, 'd')}</strong>
          </div>
        ))}
      </div>
      <div className="ops-week__all-day">
        <div className="ops-week__time-gutter">All day</div>
        {days.map(day => {
          const allDayEvents = (eventsByDay.get(dateKey(day)) || []).filter(event => !event.due_time);
          return (
            <div
              key={dateKey(day)}
              className="ops-week__all-day-cell"
              onDragOver={event => event.preventDefault()}
              onDrop={event => onDropToSlot(event, day, null)}
            >
              {allDayEvents.map(event => (
                <EventChip key={event.id} event={event} onClick={() => onEdit(event)} draggable onDragStart={dragEvent => onDragStart(dragEvent, event)} />
              ))}
            </div>
          );
        })}
      </div>
      <div className="ops-time-grid" style={{ minHeight: (END_HOUR - START_HOUR) * HOUR_HEIGHT }}>
        <div className="ops-time-axis">
          {HOURS.map(hour => (
            <div key={hour} style={{ height: HOUR_HEIGHT }}>{timeLabel(hour)}</div>
          ))}
        </div>
        <div className="ops-week__columns">
          {days.map(day => (
            <TimedDayColumn
              key={dateKey(day)}
              day={day}
              events={(eventsByDay.get(dateKey(day)) || []).filter(event => event.due_time)}
              onCreate={onCreate}
              onEdit={onEdit}
              onDragStart={onDragStart}
              onDropToSlot={onDropToSlot}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DayView({
  day,
  events,
  onCreate,
  onEdit,
  onDragStart,
  onDropToSlot,
}: {
  day: Date;
  events: CalendarEvent[];
  onCreate: (day: Date, hour?: number) => void;
  onEdit: (event: CalendarEvent) => void;
  onDragStart: (event: DragEvent<HTMLElement>, item: CalendarEvent) => void;
  onDropToSlot: (event: DragEvent<HTMLElement>, day: Date, hour: number | null) => void;
}) {
  const allDayEvents = events.filter(event => !event.due_time);
  const timedEvents = events.filter(event => event.due_time);
  return (
    <div className="ops-day">
      <div className="ops-day__rail">
        <div className="ops-day__date">
          <span>{format(day, 'EEEE')}</span>
          <strong>{format(day, 'MMMM d')}</strong>
        </div>
        <div
          className="ops-day__all-day"
          onDragOver={event => event.preventDefault()}
          onDrop={event => onDropToSlot(event, day, null)}
        >
          {allDayEvents.length ? allDayEvents.map(event => (
            <EventChip key={event.id} event={event} onClick={() => onEdit(event)} draggable onDragStart={dragEvent => onDragStart(dragEvent, event)} />
          )) : (
            <button type="button" className="ops-empty-day" onClick={() => onCreate(day)}>
              No all-day items
            </button>
          )}
        </div>
      </div>
      <div className="ops-time-grid ops-time-grid--day" style={{ minHeight: (END_HOUR - START_HOUR) * HOUR_HEIGHT }}>
        <div className="ops-time-axis">
          {HOURS.map(hour => (
            <div key={hour} style={{ height: HOUR_HEIGHT }}>{timeLabel(hour)}</div>
          ))}
        </div>
        <TimedDayColumn
          day={day}
          events={timedEvents}
          onCreate={onCreate}
          onEdit={onEdit}
          onDragStart={onDragStart}
          onDropToSlot={onDropToSlot}
          wide
        />
      </div>
    </div>
  );
}

function TimedDayColumn({
  day,
  events,
  onCreate,
  onEdit,
  onDragStart,
  onDropToSlot,
  wide = false,
}: {
  day: Date;
  events: CalendarEvent[];
  onCreate: (day: Date, hour?: number) => void;
  onEdit: (event: CalendarEvent) => void;
  onDragStart: (event: DragEvent<HTMLElement>, item: CalendarEvent) => void;
  onDropToSlot: (event: DragEvent<HTMLElement>, day: Date, hour: number | null) => void;
  wide?: boolean;
}) {
  return (
    <div className={`ops-timed-column ${wide ? 'ops-timed-column--wide' : ''}`}>
      {HOURS.map(hour => (
        <button
          key={hour}
          type="button"
          className="ops-hour-slot"
          style={{ height: HOUR_HEIGHT }}
          onClick={() => onCreate(day, hour)}
          onDragOver={event => event.preventDefault()}
          onDrop={event => onDropToSlot(event, day, hour)}
          aria-label={`Add event on ${format(day, 'MMMM d')} at ${timeLabel(hour)}`}
        />
      ))}
      {events.map(event => {
        const position = positionFor(event);
        const category = categoryById(categoryFromBackend(event));
        return (
          <button
            key={event.id}
            type="button"
            draggable
            className="ops-time-event"
            title={`${event.title} - ${eventMetaLabel(event)}`}
            style={{
              top: position.top,
              minHeight: position.height,
              borderColor: category.color,
            }}
            onClick={() => onEdit(event)}
            onDragStart={dragEvent => onDragStart(dragEvent, event)}
          >
            <span className="ops-time-event__bar" style={{ backgroundColor: category.color }} />
            <span className="ops-time-event__title">{event.title}</span>
            <span className="ops-time-event__meta">{eventMetaLabel(event)}</span>
          </button>
        );
      })}
    </div>
  );
}

function EventChip({
  event,
  compact = false,
  draggable = false,
  onClick,
  onDragStart,
}: {
  event: CalendarEvent;
  compact?: boolean;
  draggable?: boolean;
  onClick: () => void;
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
}) {
  const category = categoryById(categoryFromBackend(event));
  const prefix = eventChipPrefix(event, category);
  return (
    <button
      type="button"
      className={`ops-event-chip ${compact ? 'ops-event-chip--compact' : ''}`}
      style={{ backgroundColor: category.color, color: category.text }}
      onClick={onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      title={`${event.title} - ${eventTimeLabel(event)}`}
    >
      {prefix && <span>{prefix}</span>}
      <strong>{event.title}</strong>
    </button>
  );
}

function EventModal({
  form,
  projects,
  saving,
  onClose,
  onDelete,
  onSubmit,
  onChange,
}: {
  form: EventFormState;
  projects: ProjectOption[];
  saving: boolean;
  onClose: () => void;
  onDelete: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onChange: (form: EventFormState) => void;
}) {
  const setValue = <K extends keyof EventFormState>(key: K, value: EventFormState[K]) => {
    onChange({ ...form, [key]: value });
  };

  return (
    <div className="ops-modal" role="presentation">
      <button type="button" className="ops-modal__scrim" onClick={onClose} aria-label="Close calendar dialog" />
      <form className="ops-modal__panel" onSubmit={onSubmit} role="dialog" aria-modal="true" aria-labelledby="ops-modal-title">
        <div className="ops-modal__header">
          <div>
            <p>{form.id ? 'Edit' : 'Create'}</p>
            <h2 id="ops-modal-title">{form.kind === 'task' ? 'Task' : 'Event'}</h2>
          </div>
          <button type="button" className="ops-icon-button" onClick={onClose} aria-label="Close">
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="ops-type-toggle" role="group" aria-label="Calendar item type">
          <button
            type="button"
            className={form.kind === 'event' ? 'is-active' : ''}
            onClick={() => setValue('kind', 'event')}
          >
            Event
          </button>
          <button
            type="button"
            className={form.kind === 'task' ? 'is-active' : ''}
            onClick={() => setValue('kind', 'task')}
          >
            Task
          </button>
        </div>

        <div className="ops-form-grid">
          <label className="ops-field ops-field--wide">
            <span>Title</span>
            <input value={form.title} onChange={event => setValue('title', event.target.value)} required maxLength={180} />
          </label>

          <label className="ops-field">
            <span>Date</span>
            <input type="date" value={form.scheduled_for} onChange={event => setValue('scheduled_for', event.target.value)} required />
          </label>

          <label className="ops-checkbox">
            <input type="checkbox" checked={form.all_day} onChange={event => setValue('all_day', event.target.checked)} />
            <span>All day</span>
          </label>

          {!form.all_day && (
            <>
              <label className="ops-field">
                <span>Start</span>
                <input type="time" value={form.start_time} onChange={event => setValue('start_time', event.target.value)} />
              </label>
              <label className="ops-field">
                <span>End</span>
                <input type="time" value={form.end_time} onChange={event => setValue('end_time', event.target.value)} />
              </label>
            </>
          )}

          <label className="ops-field">
            <span>Category</span>
            <select value={form.category} onChange={event => setValue('category', event.target.value as CategoryId)}>
              {CATEGORY_OPTIONS.map(category => (
                <option key={category.id} value={category.id}>{category.label}</option>
              ))}
            </select>
          </label>

          <label className="ops-field">
            <span>Assignee/Crew</span>
            <input value={form.assignee} onChange={event => setValue('assignee', event.target.value)} maxLength={160} />
          </label>

          <label className="ops-field ops-field--wide">
            <span>Job/Site</span>
            <select value={form.project_id} onChange={event => setValue('project_id', event.target.value)}>
              <option value="">No project selected</option>
              {projects.map(project => (
                <option key={project.id} value={project.id}>{projectLabel(project)}</option>
              ))}
            </select>
          </label>

          <label className="ops-field ops-field--wide">
            <span>Location</span>
            <input value={form.location} onChange={event => setValue('location', event.target.value)} maxLength={160} />
          </label>

          <label className="ops-field">
            <span>Priority</span>
            <select value={form.priority} onChange={event => setValue('priority', event.target.value as CalendarPriority)}>
              {PRIORITY_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <label className="ops-field">
            <span>Status</span>
            <select value={form.status} onChange={event => setValue('status', event.target.value as CalendarStatus)}>
              {STATUS_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <label className="ops-field ops-field--wide">
            <span>Notes</span>
            <textarea value={form.notes} onChange={event => setValue('notes', event.target.value)} rows={4} maxLength={1000} />
          </label>
        </div>

        <div className="ops-modal__actions">
          {form.id && !form.id.startsWith('task-') ? (
            <button type="button" className="ops-delete-button" onClick={onDelete} disabled={saving}>
              <Trash2 size={17} aria-hidden="true" />
              Delete
            </button>
          ) : <span />}
          <div>
            <button type="button" className="ops-secondary-button" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="ops-add-button" disabled={saving}>
              {saving ? <Loader2 className="ops-spin" size={17} aria-hidden="true" /> : <Pencil size={17} aria-hidden="true" />}
              Save
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
