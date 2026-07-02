import { type ChangeEvent, type Dispatch, type DragEvent, type KeyboardEvent, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore, canChangeProjectStatus, canManageProjects, isAdminRole } from '../store/authStore';
import api from '../lib/api';
import { Loading, StatusBadge, Modal, statusLabels } from '../components/ui';
import Avatar from '../components/Avatar';
import VoiceTextarea from '../components/VoiceTextarea';
import { ArrowLeft, MapPin, Edit2, Users, Plus, Trash2, Camera, FileImage, FileText, ClipboardList, MessageSquare, UserPlus, Mic, Square, Package, ArrowUp, ArrowDown, ImagePlus, PlayCircle, Send, Phone, Mail, Building2, AlertTriangle, Check, Paperclip, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, CalendarDays, Search, GripVertical, CheckCircle2, XCircle, Database, ListFilter, Bot } from 'lucide-react';
import toast from 'react-hot-toast';
import { useForm } from 'react-hook-form';
import { format } from 'date-fns';
import GooglePlacesInput from '../components/GooglePlacesInput';
import CurrencyInput from '../components/CurrencyInput';
import { formatEasternDate, formatEasternDateTime } from '../lib/time';
import AddToCalendarButton from '../components/AddToCalendarButton';
import { fileDropHandlers } from '../lib/fileDrop';
import {
  appendProgressUploadAudit,
  isSupportedProgressMediaFile,
  MAX_PROGRESS_UPLOAD_BATCH_FILES,
  PROGRESS_MEDIA_ACCEPT,
  type ProgressCaptureSource,
} from '../lib/progressUpload';
import { getProgressMediaKind, isVideoMedia } from '../lib/progressMedia';
import PhotoMarkupModal from '../components/PhotoMarkupModal';

type Tab = 'overview' | 'details' | 'progress-history' | 'construction-plan' | 'project-timeline' | 'quotes' | 'punch-list' | 'photos' | 'invoices' | 'notes' | 'team' | 'texts';

type ProjectCalendarEvent = {
  id: string;
  source?: string | null;
  source_id?: string | null;
  event_type?: string | null;
  title?: string | null;
  description?: string | null;
  scheduled_for?: string | null;
  due_time?: string | null;
  status?: string | null;
  priority?: string | null;
  completed_at?: string | null;
  completion_note?: string | null;
  created_by_name?: string | null;
  created_at?: string | null;
};

type ProjectCalendarDayCell = {
  key: string;
  date: Date;
  dayNumber: number;
  isToday: boolean;
  isCurrentMonth: boolean;
  events: ProjectCalendarEvent[];
};

type ProgressLightboxItem = {
  id: string;
  src: string;
  isVideo: boolean;
  name?: string;
  meta?: string;
  noteText?: string;
};

type ProgressLightboxState = {
  items: ProgressLightboxItem[];
  index: number;
};

function aiAgentMeta(record: any) {
  const agentName = String(record?.created_by_agent || '').trim();
  if (!agentName) return null;
  return {
    agentName,
    source: String(record?.source || '').trim() || 'AI bridge',
    rawTranscript: String(record?.raw_transcript || '').trim(),
    requestId: String(record?.agent_request_id || '').trim(),
  };
}

function scopeTextLines(value: any) {
  return String(value || '')
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*\d+[\.)-]?\s*/, '').trim())
    .filter(Boolean);
}

type ContractorDirectoryProject = {
  id?: string | null;
  address?: string | null;
  job_name?: string | null;
  status?: string | null;
};

type ContractorDirectoryRow = {
  id: string;
  name?: string;
  vendor_name?: string;
  contact_name?: string | null;
  phone?: string | null;
  email?: string | null;
  billing_address?: string | null;
  contractor_category?: string | null;
  contractor_secondary_category?: string | null;
  contractor_categories?: string[] | null;
  connected_projects?: ContractorDirectoryProject[];
};

type ContractorTextMessage = {
  id: string;
  project_id?: string | null;
  contractor_id: string;
  contractor_name: string;
  contractor_contact_name?: string | null;
  contractor_phone: string;
  sent_by_name: string;
  message_body: string;
  status: string;
  provider: string;
  error_message?: string | null;
  created_at: string;
  sent_at?: string | null;
};

type DictationStatus = 'idle' | 'starting' | 'listening';
const PROJECT_BUDGET_ROLES = new Set(['super_admin', 'operations_manager', 'project_manager']);
const PROJECT_CALENDAR_ROLES = new Set(['super_admin', 'operations_manager', 'project_manager']);
const PROJECT_CALENDAR_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const PROJECT_CALENDAR_EVENT_TONES: Record<string, string> = {
  task: 'border-blue-300/60 bg-blue-500/20 text-blue-50',
  maintenance: 'border-amber-300/70 bg-amber-500/20 text-amber-50',
  inspection: 'border-cyan-300/70 bg-cyan-500/20 text-cyan-50',
  note: 'border-violet-300/70 bg-violet-500/20 text-violet-50',
  other: 'border-slate-300/60 bg-slate-500/20 text-slate-50',
};

function canViewProjectBudget(role?: string | null) {
  return PROJECT_BUDGET_ROLES.has(String(role || ''));
}

function canViewProjectCalendar(role?: string | null) {
  return PROJECT_CALENDAR_ROLES.has(String(role || ''));
}

function appendDictationText(base: string, spokenText: string) {
  const cleanSpoken = spokenText.replace(/\s+/g, ' ').trim();
  if (!cleanSpoken) return base;
  if (!base.trim()) return cleanSpoken;
  return `${base}${/\s$/.test(base) ? '' : ' '}${cleanSpoken}`;
}

function scopeLineItemText(value: string) {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/[•·]/g, '\n')
    .replace(/(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/g, '\n')
    .replace(/([.!?])\s+(?=[A-Z0-9])/g, '$1\n')
    .split(/\n+/)
    .map(item => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function cityFromProjectAddress(address?: string | null) {
  const parts = String(address || '').split(',').map(part => part.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[1].replace(/\s+\d{5}(?:-\d{4})?\b.*$/, '').trim();
  return '';
}

function formatProjectAddressLabel(address?: string | null) {
  return String(address || '').replace(/,\s*USA\s*$/i, '').trim();
}

function getRecognitionTranscript(results: any) {
  const finalParts: string[] = [];
  const interimParts: string[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const transcript = String(result?.[0]?.transcript || '').trim();
    if (!transcript) continue;
    if (result.isFinal) {
      finalParts.push(transcript);
    } else {
      interimParts.push(transcript);
    }
  }
  return [...finalParts, ...interimParts].join(' ').trim();
}

const PROJECT_STATUS_OPTIONS = [
  { value: 'not_started', label: 'Not Started' },
  { value: 'active_rehab', label: 'Active Rehabs' },
  { value: 'rehab_completed', label: 'Completed Projects' },
  { value: 'long_term_holding', label: 'Long-Term Holdings' },
  { value: 'commercial', label: 'Commercial' },
  { value: 'wholesale', label: 'Wholesale' },
];

function isPunchlistStageEnabled(value: any) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  return false;
}

const getNotePhotos = (note: any) => {
  if (Array.isArray(note.photos) && note.photos.length) return note.photos;
  if (!note.photo_filename) return [];
  return [{
    id: note.photo_id || note.photo_filename,
    filename: note.photo_filename,
    original_name: note.photo_original_name || 'Progress picture',
    caption: note.photo_caption || null,
    mime_type: null,
    taken_at: note.created_at,
    created_at: note.created_at,
  }];
};

const groupMediaByDay = (photos: any[]) =>
  photos.reduce<{ date: string; photos: any[] }[]>((groups, photo) => {
    const date = formatEasternDate(photo.taken_at || photo.created_at, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
    const last = groups[groups.length - 1];
    if (last && last.date === date) last.photos.push(photo);
    else groups.push({ date, photos: [photo] });
    return groups;
  }, []);

const getProgressTimestamp = (item: any) =>
  item?.captured_at || item?.taken_at || item?.uploaded_at || item?.created_at;

const progressPhotoKey = (photo: any) => String(photo?.id || photo?.filename || '');

const progressPhotoSrc = (projectId: string, photo: any) => {
  // Prefer the marked-up overlay when present; the original is preserved and
  // un-marked photos display exactly as before.
  if (photo?.markup_url) return photo.markup_url;
  if (photo?.markup_path) return `/uploads/${projectId}/${photo.markup_path}`;
  return `/uploads/${projectId}/${photo.filename}`;
};

const getProgressPhotoNoteText = (photo: any) =>
  String(photo?.individual_note || photo?.caption || photo?.note_text || '').trim();

const getProgressPhotoGroupNoteText = (photo: any) =>
  String(photo?.batch_note || '').trim();

const buildProgressLightboxItems = (projectId: string, photos: any[]): ProgressLightboxItem[] =>
  photos
    .filter(photo => getProgressMediaKind(photo) !== 'file')
    .map(photo => ({
      id: progressPhotoKey(photo),
      src: progressPhotoSrc(projectId, photo),
      isVideo: getProgressMediaKind(photo) === 'video',
      name: photo.original_name || photo.filename || 'Progress picture',
      meta: [
        photo.uploader_name || null,
        getProgressTimestamp(photo)
          ? formatEasternDateTime(getProgressTimestamp(photo), { hour: 'numeric', minute: '2-digit' })
          : null,
      ].filter(Boolean).join(' - '),
      noteText: getProgressPhotoNoteText(photo),
    }));

const scopePhotoLightboxKey = (photo: any) => String(photo?.assignment_id || progressPhotoKey(photo));

const buildScopePhotoLightboxItems = (projectId: string, photos: any[]): ProgressLightboxItem[] =>
  photos
    .filter(photo => getProgressMediaKind(photo) !== 'file')
    .map(photo => ({
      id: scopePhotoLightboxKey(photo),
      src: progressPhotoSrc(projectId, photo),
      isVideo: getProgressMediaKind(photo) === 'video',
      name: photo.original_name || photo.filename || 'Scope photo',
      meta: [
        photo.uploader_name || null,
        getProgressTimestamp(photo)
          ? formatEasternDateTime(getProgressTimestamp(photo), { hour: 'numeric', minute: '2-digit' })
          : null,
      ].filter(Boolean).join(' - '),
      noteText: getProgressPhotoNoteText(photo),
    }));

const projectPhotoRecordLabel = (project: any, projectId: string) =>
  project?.job_name || project?.address || `Project ${projectId}`;

const photoBelongsToProject = (photo: any, projectId: string) =>
  String(photo?.project_id || '') === String(projectId || '');

const filterPhotosForProject = (photos: any[], projectId: string) =>
  photos.filter(photo => photoBelongsToProject(photo, projectId));

const sortProjectPhotosNewestFirst = (photos: any[]) =>
  [...photos].sort((left, right) => {
    const leftTime = Date.parse(getProgressTimestamp(left) || '');
    const rightTime = Date.parse(getProgressTimestamp(right) || '');
    const safeLeft = Number.isFinite(leftTime) ? leftTime : 0;
    const safeRight = Number.isFinite(rightTime) ? rightTime : 0;
    return safeRight - safeLeft;
  });

const filterScopesForProjectPhotos = (scopes: any[], projectId: string) =>
  scopes.map(scope => ({
    ...scope,
    photos: Array.isArray(scope.photos)
      ? filterPhotosForProject(scope.photos, projectId)
      : [],
  }));

const formatProjectPhotoTimestamp = (photo: any) => {
  const timestamp = getProgressTimestamp(photo);
  if (!timestamp) return 'Time not recorded';
  return formatEasternDateTime(timestamp, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const formatProjectPhotoGps = (photo: any) => {
  const latitude = Number(photo?.gps_latitude ?? photo?.capture_latitude);
  const longitude = Number(photo?.gps_longitude ?? photo?.capture_longitude);
  const hasValidCoordinates = Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && Math.abs(latitude) <= 90
    && Math.abs(longitude) <= 180
    && !(Math.abs(latitude) < 0.00001 && Math.abs(longitude) < 0.00001);
  if (!hasValidCoordinates) return 'GPS not verified';
  const accuracy = Number(photo?.gps_accuracy ?? photo?.capture_accuracy);
  const accuracyLabel = Number.isFinite(accuracy) ? ` +/- ${Math.round(accuracy)}m` : '';
  return `GPS verified: ${latitude.toFixed(5)}, ${longitude.toFixed(5)}${accuracyLabel}`;
};

const formatProjectPhotoIp = (photo: any) => {
  const ipAddress = String(photo?.upload_ip_address || '').trim();
  return ipAddress ? `IP: ${ipAddress}` : 'IP not recorded';
};

const groupProgressRecordsByDay = (records: any[]) =>
  records.reduce<{ date: string; records: any[] }[]>((groups, record) => {
    const date = formatEasternDate(record.timestamp, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
    const last = groups[groups.length - 1];
    if (last && last.date === date) last.records.push(record);
    else groups.push({ date, records: [record] });
    return groups;
  }, []);

const groupStandaloneProgressMedia = (photos: any[], maxPerCard = 20) => {
  const ordered = photos
    .filter(photo => getProgressTimestamp(photo))
    .sort((a, b) => new Date(getProgressTimestamp(b)).getTime() - new Date(getProgressTimestamp(a)).getTime());
  const buckets = new Map<string, any[]>();

  ordered.forEach(photo => {
    const timestamp = getProgressTimestamp(photo);
    const dayKey = formatEasternDate(timestamp, { year: 'numeric', month: '2-digit', day: '2-digit' });
    const current = buckets.get(dayKey) || [];
    current.push(photo);
    buckets.set(dayKey, current);
  });

  return Array.from(buckets.entries()).flatMap(([dayKey, bucket]) => {
    const chunks: any[][] = [];
    for (let index = 0; index < bucket.length; index += maxPerCard) {
      chunks.push(bucket.slice(index, index + maxPerCard));
    }

    return chunks.map((chunk, chunkIndex) => {
      const uploaderNames = [...new Set(chunk.map(photo => photo.uploader_name || 'Unknown user'))];
      const uploaderAvatars = [...new Set(chunk.map(photo => photo.uploader_avatar_url).filter(Boolean).map(String))];
      const mediaTypes = new Set(chunk.map(photo => (isVideoMedia(photo) ? 'video' : 'picture')));
      const groupNotes = [...new Set(chunk
        .map(photo => getProgressPhotoGroupNoteText(photo))
        .filter(Boolean)
        .map(String))];

      return {
        id: `media-group-${dayKey}-${chunkIndex}`,
        kind: 'media',
        timestamp: getProgressTimestamp(chunk[0]),
        userName: uploaderNames.length === 1 ? uploaderNames[0] : `${uploaderNames.length} users`,
        userAvatarUrl: uploaderNames.length === 1 && uploaderAvatars.length === 1 ? uploaderAvatars[0] : null,
        mediaType: mediaTypes.has('video') && mediaTypes.size === 1 ? 'video' : mediaTypes.has('video') ? 'mixed' : 'picture',
        noteText: groupNotes.length === 1 ? groupNotes[0] : null,
        photos: chunk,
      };
    });
  });
};

function isMobileCaptureContext() {
  if (typeof window === 'undefined') return false;
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return Boolean(window.matchMedia?.('(max-width: 767px)').matches) || /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
}

const formatLocalDateInput = (date = new Date()) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

function parseProjectCalendarDateKey(value?: string | null) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    const fallback = new Date();
    fallback.setHours(12, 0, 0, 0);
    return fallback;
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
}

function addProjectCalendarDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addProjectCalendarMonths(date: Date, months: number) {
  const next = new Date(date);
  next.setDate(1);
  next.setMonth(next.getMonth() + months);
  next.setHours(12, 0, 0, 0);
  return next;
}

function startOfProjectCalendarWeek(date: Date) {
  const start = new Date(date);
  start.setHours(12, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function projectCalendarMonthRange(anchorDateKey: string) {
  const monthStart = parseProjectCalendarDateKey(anchorDateKey);
  monthStart.setDate(1);
  const monthEnd = new Date(monthStart);
  monthEnd.setMonth(monthEnd.getMonth() + 1, 0);
  const visibleStart = startOfProjectCalendarWeek(monthStart);
  const visibleEnd = addProjectCalendarDays(startOfProjectCalendarWeek(monthEnd), 6);
  return {
    start: formatLocalDateInput(visibleStart),
    end: formatLocalDateInput(visibleEnd),
  };
}

function projectCalendarEventDateKey(event: ProjectCalendarEvent) {
  return event.scheduled_for || (event.completed_at ? String(event.completed_at).slice(0, 10) : '');
}

function sortProjectCalendarEvents(events: ProjectCalendarEvent[]) {
  return [...events].sort((left, right) => {
    const dateCompare = String(projectCalendarEventDateKey(left)).localeCompare(String(projectCalendarEventDateKey(right)));
    if (dateCompare !== 0) return dateCompare;
    const timeCompare = String(left.due_time || '99:99').localeCompare(String(right.due_time || '99:99'));
    if (timeCompare !== 0) return timeCompare;
    return String(left.title || '').localeCompare(String(right.title || ''));
  });
}

function formatProjectCalendarTime(value?: string | null) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  if (!match) return 'All day';
  const hour = Number(match[1]);
  const minute = match[2];
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 || 12;
  return `${hour12}:${minute} ${suffix}`;
}

function projectCalendarEventTone(event: ProjectCalendarEvent) {
  if (event.status === 'completed') return 'border-emerald-300/70 bg-emerald-500/20 text-emerald-50';
  if (event.priority === 'critical' || event.priority === 'high') return 'border-rose-300/70 bg-rose-500/20 text-rose-50';
  return PROJECT_CALENDAR_EVENT_TONES[String(event.event_type || 'other')] || PROJECT_CALENDAR_EVENT_TONES.other;
}

function projectCalendarValueLabel(value?: string | null, fallback = 'Not set') {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text
    .replace(/_/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function projectCalendarEventKindLabel(event: ProjectCalendarEvent) {
  if (event.source === 'construction_task') return 'Task';
  return projectCalendarValueLabel(event.event_type, 'Event');
}

function projectCalendarEventDateLabel(event: ProjectCalendarEvent) {
  const dateKey = projectCalendarEventDateKey(event);
  if (!dateKey) return 'Date not set';
  return format(parseProjectCalendarDateKey(dateKey), 'MMM d, yyyy');
}

function buildProjectCalendarDays(anchorDateKey: string, events: ProjectCalendarEvent[]): ProjectCalendarDayCell[] {
  const todayKey = formatLocalDateInput();
  const anchor = parseProjectCalendarDateKey(anchorDateKey);
  const monthStart = new Date(anchor);
  monthStart.setDate(1);
  const activeMonth = monthStart.getMonth();
  const visibleStart = startOfProjectCalendarWeek(monthStart);
  const grouped = new Map<string, ProjectCalendarEvent[]>();

  events.forEach(event => {
    const key = projectCalendarEventDateKey(event);
    if (!key) return;
    const current = grouped.get(key) || [];
    current.push(event);
    grouped.set(key, current);
  });

  return Array.from({ length: 42 }, (_, index) => {
    const date = addProjectCalendarDays(visibleStart, index);
    const key = formatLocalDateInput(date);
    return {
      key,
      date,
      dayNumber: date.getDate(),
      isToday: key === todayKey,
      isCurrentMonth: date.getMonth() === activeMonth,
      events: sortProjectCalendarEvents(grouped.get(key) || []),
    };
  });
}

function ProjectMiniCalendarCard({
  events,
  loading,
  anchorDateKey,
  onAnchorDateChange,
}: {
  events: ProjectCalendarEvent[];
  loading: boolean;
  anchorDateKey: string;
  onAnchorDateChange: (dateKey: string) => void;
}) {
  const anchorDate = parseProjectCalendarDateKey(anchorDateKey);
  const days = useMemo(() => buildProjectCalendarDays(anchorDateKey, events), [anchorDateKey, events]);
  const [selectedEvent, setSelectedEvent] = useState<ProjectCalendarEvent | null>(null);
  const todayKey = formatLocalDateInput();
  const upcoming = useMemo(
    () => sortProjectCalendarEvents(events.filter(event => String(projectCalendarEventDateKey(event) || '') >= todayKey)).slice(0, 4),
    [events, todayKey],
  );
  const moveMonth = (offset: number) => onAnchorDateChange(formatLocalDateInput(addProjectCalendarMonths(anchorDate, offset)));
  const selectedEventDescription = String(selectedEvent?.description || '').trim();
  const selectedCompletionNote = String(selectedEvent?.completion_note || '').trim();

  useEffect(() => {
    if (selectedEvent && !events.some(event => event.id === selectedEvent.id)) setSelectedEvent(null);
  }, [events, selectedEvent]);

  return (
    <>
      <section className="rounded-xl border border-blue-900/40 bg-gradient-to-br from-slate-950 via-blue-950 to-slate-900 p-4 text-white shadow-[0_18px_42px_rgba(15,23,42,0.28)]">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-black text-white">Project Calendar</h3>
            <p className="mt-0.5 text-xs font-semibold text-cyan-100">{events.length} {events.length === 1 ? 'project item' : 'project items'}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => moveMonth(-1)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/15 bg-white/10 text-cyan-50 hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-cyan-300"
              aria-label="Previous month"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => onAnchorDateChange(formatLocalDateInput())}
              className="inline-flex h-8 items-center justify-center rounded-lg border border-cyan-300/30 bg-cyan-400/10 px-2.5 text-xs font-black text-cyan-50 hover:bg-cyan-400/20 focus:outline-none focus:ring-2 focus:ring-cyan-300"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => moveMonth(1)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/15 bg-white/10 text-cyan-50 hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-cyan-300"
              aria-label="Next month"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-base font-black text-cyan-50">{format(anchorDate, 'MMMM yyyy')}</p>
          {loading && <span className="text-xs font-bold text-cyan-200">Loading</span>}
        </div>

        <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-black uppercase text-cyan-200/90">
          {PROJECT_CALENDAR_WEEKDAYS.map(day => <div key={day}>{day}</div>)}
        </div>
        <div className="mt-1 grid grid-cols-7 gap-1">
          {days.map(day => (
            <div
              key={day.key}
              className={`min-h-[58px] rounded-lg border p-1.5 ${day.isToday ? 'border-amber-300 bg-amber-400/20 shadow-[inset_0_0_0_1px_rgba(251,191,36,0.25)]' : 'border-white/10 bg-white/[0.045]'} ${day.isCurrentMonth ? 'text-white' : 'text-slate-500'}`}
            >
              <div className="flex items-center justify-between">
                <span className={`text-xs font-black ${day.isToday ? 'text-amber-100' : ''}`}>{day.dayNumber}</span>
                {day.events.length > 0 && <span className="rounded-full bg-cyan-300 px-1.5 text-[9px] font-black text-slate-950">{day.events.length}</span>}
              </div>
              <div className="mt-1 space-y-1">
                {day.events.slice(0, 2).map(event => (
                  <button
                    key={`${day.key}-${event.id}`}
                    type="button"
                    onClick={() => setSelectedEvent(event)}
                    className={`block w-full cursor-pointer truncate rounded border px-1 py-0.5 text-left text-[9px] font-black leading-tight hover:ring-1 hover:ring-cyan-100 focus:outline-none focus:ring-2 focus:ring-cyan-200 ${projectCalendarEventTone(event)}`}
                    title={event.title || 'Calendar item'}
                    aria-label={`View ${event.title || 'calendar item'} on ${projectCalendarEventDateLabel(event)}`}
                  >
                    {event.title || 'Calendar item'}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-black uppercase tracking-wide text-cyan-100">Upcoming</p>
            <CalendarDays className="h-4 w-4 text-cyan-200" />
          </div>
          {upcoming.length > 0 ? (
            <div className="space-y-2">
              {upcoming.map(event => (
                <button
                  key={`upcoming-${event.id}`}
                  type="button"
                  onClick={() => setSelectedEvent(event)}
                  className="flex w-full cursor-pointer items-start gap-2 rounded-lg border border-white/10 bg-white/[0.055] p-2 text-left hover:border-cyan-200/50 hover:bg-white/[0.09] focus:outline-none focus:ring-2 focus:ring-cyan-200"
                  aria-label={`View ${event.title || 'calendar item'} on ${projectCalendarEventDateLabel(event)}`}
                >
                  <span className={`mt-1 h-2.5 w-2.5 flex-shrink-0 rounded-full ${event.status === 'completed' ? 'bg-emerald-300' : event.priority === 'critical' || event.priority === 'high' ? 'bg-rose-300' : 'bg-cyan-300'}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-black text-white">{event.title || 'Calendar item'}</span>
                    <span className="mt-0.5 block text-[11px] font-semibold text-cyan-100">
                      {format(parseProjectCalendarDateKey(projectCalendarEventDateKey(event)), 'MMM d')} · {formatProjectCalendarTime(event.due_time)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="py-3 text-center text-xs font-bold text-slate-300">No upcoming project calendar items</p>
          )}
        </div>
      </section>

      <Modal
        isOpen={Boolean(selectedEvent)}
        onClose={() => setSelectedEvent(null)}
        title={selectedEvent?.title || 'Calendar item'}
        description="Project calendar item details"
        size="md"
      >
        {selectedEvent && (
          <div className="space-y-4">
            <div className="rounded-xl border border-cyan-200 bg-gradient-to-br from-cyan-50 to-blue-50 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-slate-950 px-3 py-1 text-xs font-black uppercase tracking-wide text-white">
                  {projectCalendarEventKindLabel(selectedEvent)}
                </span>
                <span className="rounded-full bg-white px-3 py-1 text-xs font-black text-slate-700 ring-1 ring-cyan-200">
                  {projectCalendarEventDateLabel(selectedEvent)}
                </span>
                <span className="rounded-full bg-white px-3 py-1 text-xs font-black text-slate-700 ring-1 ring-cyan-200">
                  {formatProjectCalendarTime(selectedEvent.due_time)}
                </span>
              </div>
              <p className="mt-3 text-lg font-black leading-snug text-slate-950">{selectedEvent.title || 'Calendar item'}</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {[
                { label: 'Status', value: projectCalendarValueLabel(selectedEvent.status, 'Scheduled') },
                { label: 'Priority', value: projectCalendarValueLabel(selectedEvent.priority, 'Normal') },
                { label: 'Source', value: selectedEvent.source === 'construction_task' ? 'Construction task' : projectCalendarValueLabel(selectedEvent.source, 'Calendar event') },
                { label: 'Created by', value: selectedEvent.created_by_name || 'BuildTrack' },
              ].map(item => (
                <div key={item.label} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-[11px] font-black uppercase tracking-wide text-slate-500">{item.label}</p>
                  <p className="mt-1 text-sm font-black text-slate-950">{item.value}</p>
                </div>
              ))}
            </div>

            {selectedEventDescription && (
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-3">
                <p className="text-[11px] font-black uppercase tracking-wide text-slate-500">Notes</p>
                <p className="mt-2 whitespace-pre-wrap text-sm font-semibold leading-6 text-slate-800">{selectedEventDescription}</p>
              </div>
            )}

            {selectedCompletionNote && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3">
                <p className="text-[11px] font-black uppercase tracking-wide text-emerald-700">Completion note</p>
                <p className="mt-2 whitespace-pre-wrap text-sm font-semibold leading-6 text-emerald-950">{selectedCompletionNote}</p>
              </div>
            )}

            <div className="flex justify-end border-t border-slate-200 pt-4">
              <button
                type="button"
                onClick={() => setSelectedEvent(null)}
                className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-slate-950 px-4 py-2 text-sm font-black text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-400"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

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

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [project, setProject] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const h = window.location.hash.replace('#', '') as Tab;
      const valid: Tab[] = ['overview', 'details', 'progress-history', 'construction-plan', 'project-timeline', 'quotes', 'punch-list', 'photos', 'invoices', 'notes', 'team', 'texts'];
      return valid.includes(h) ? h : 'notes';
    } catch {
      return 'notes';
    }
  });
  const [showEdit, setShowEdit] = useState(false);
  const [showAssign, setShowAssign] = useState(false);
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [notes, setNotes] = useState<any[]>([]);
  const [newNote, setNewNote] = useState('');
  const [noteType, setNoteType] = useState('general');
  const [noteVisibility, setNoteVisibility] = useState<'private' | 'public'>('private');
  const [showCalendarComposer, setShowCalendarComposer] = useState(false);
  const [calendarTitle, setCalendarTitle] = useState('');
  const [calendarDate, setCalendarDate] = useState(new Date().toISOString().slice(0, 10));
  const [calendarEventType, setCalendarEventType] = useState('task');
  const [calendarPriority, setCalendarPriority] = useState('normal');
  const [calendarDetails, setCalendarDetails] = useState('');
  const [calendarReminderEnabled, setCalendarReminderEnabled] = useState(false);
  const [calendarReminderRecipients, setCalendarReminderRecipients] = useState('');
  const [calendarReminderMessage, setCalendarReminderMessage] = useState('');
  const [calendarReminderScheduleType, setCalendarReminderScheduleType] = useState<'now' | 'once' | 'weekly' | 'monthly'>('once');
  const [calendarReminderDate, setCalendarReminderDate] = useState(formatLocalDateInput());
  const [calendarReminderTime, setCalendarReminderTime] = useState(defaultReminderTime());
  const [savingCalendarEvent, setSavingCalendarEvent] = useState(false);
  const [projectCalendarAnchorDateKey, setProjectCalendarAnchorDateKey] = useState(formatLocalDateInput());
  const [projectCalendarEvents, setProjectCalendarEvents] = useState<ProjectCalendarEvent[]>([]);
  const [loadingProjectCalendar, setLoadingProjectCalendar] = useState(false);
  const [noteDictationStatus, setNoteDictationStatus] = useState<DictationStatus>('idle');
  const [notePhotoFiles, setNotePhotoFiles] = useState<File[]>([]);
  const [notePhotoSource, setNotePhotoSource] = useState<ProgressCaptureSource>('desktop');
  const [attachNoteId, setAttachNoteId] = useState<string | null>(null);
  const [attachingNoteId, setAttachingNoteId] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = useState('');
  const [editingNoteType, setEditingNoteType] = useState('general');
  const [editingNoteVisibility, setEditingNoteVisibility] = useState<'private' | 'public'>('private');
  const [deletingNoteId, setDeletingNoteId] = useState<string | null>(null);
  const [uploadingMainPhoto, setUploadingMainPhoto] = useState(false);
  const [activatingPunchList, setActivatingPunchList] = useState(false);
  const [editAddress, setEditAddress] = useState('');
  const [editBudget, setEditBudget] = useState('');
  const [editPurchasePrice, setEditPurchasePrice] = useState('');
  const [editArv, setEditArv] = useState('');
  const [editClosingCosts, setEditClosingCosts] = useState('');
  const { register, handleSubmit, reset, setValue, formState: { isSubmitting } } = useForm();
  const noteRecognitionRef = useRef<any>(null);
  const noteDictationBaseRef = useRef('');
  const attachExistingNoteInputRef = useRef<HTMLInputElement>(null);
  const noteMediaInputRef = useRef<HTMLInputElement>(null);
  const noteCameraInputRef = useRef<HTMLInputElement>(null);
  const listeningNote = noteDictationStatus !== 'idle';

  const load = useCallback(async () => {
    try {
      const [projectRes, fieldWorkRes] = await Promise.all([
        api.get(`/projects/${id}`),
        api.get(`/field-work/projects/${id}`).catch(() => ({ data: null })),
      ]);
      setProject({ ...projectRes.data, field_work: fieldWorkRes.data });
    } catch (err) {
      toast.error('Failed to load project');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (tab !== 'overview') return;
    const interval = window.setInterval(load, 30000);
    return () => window.clearInterval(interval);
  }, [load, tab]);

  useEffect(() => {
      const hashTabMap: Record<string, Tab> = {
        '#progress-history': 'photos',
        '#construction-plan': 'construction-plan',
        '#project-timeline': 'project-timeline',
        '#quotes': 'quotes',
        '#punch-list': 'punch-list',
        '#assigned-contractors': 'team',
        '#notes': 'notes',
    };
    if (hashTabMap[location.hash]) setTab(hashTabMap[location.hash]);
  }, [location.hash]);

  useEffect(() => {
    if (!id || !user || !isAdminRole(user.role)) return;
    api.post(`/projects/${id}/reviewed`).catch(() => {});
  }, [id, user?.id, user?.role]);

  useEffect(() => {
    if (tab === 'overview' || tab === 'notes') loadNotes();
  }, [tab, id]);

  // Keep the URL hash in sync with the active tab so a refresh stays on the same tab.
  useEffect(() => {
    try {
      if (window.location.hash.replace('#', '') !== tab) {
        window.history.replaceState(null, '', `#${tab}`);
      }
    } catch {
      /* no-op */
    }
  }, [tab]);

  useEffect(() => {
    return () => {
      noteRecognitionRef.current?.stop?.();
      noteRecognitionRef.current = null;
    };
  }, []);

  const loadNotes = async () => {
    const res = await api.get(`/projects/${id}/notes`);
    setNotes(res.data);
  };

  const loadProjectCalendar = useCallback(async () => {
    if (!id || !canViewProjectCalendar(user?.role)) {
      setProjectCalendarEvents([]);
      setLoadingProjectCalendar(false);
      return;
    }

    const range = projectCalendarMonthRange(projectCalendarAnchorDateKey);
    setLoadingProjectCalendar(true);
    try {
      const res = await api.get(`/calendar/events?start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}&project_id=${encodeURIComponent(id)}`);
      setProjectCalendarEvents(Array.isArray(res.data?.events) ? res.data.events : []);
    } catch (err) {
      console.error(err);
      setProjectCalendarEvents([]);
    } finally {
      setLoadingProjectCalendar(false);
    }
  }, [id, projectCalendarAnchorDateKey, user?.role]);

  useEffect(() => {
    if (tab === 'overview' || tab === 'notes') loadProjectCalendar();
  }, [tab, loadProjectCalendar]);

  const loadUsers = async () => {
    if (user && isAdminRole(user.role)) {
      const res = await api.get('/users');
      setAllUsers(res.data);
    }
  };

  const handleAssign = async (userId: string) => {
    try {
      await api.post(`/projects/${id}/assign`, { user_id: userId });
      toast.success('User assigned');
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to assign user');
    }
  };

  const handleUnassign = async (userId: string) => {
    try {
      await api.delete(`/projects/${id}/assign/${userId}`);
      toast.success('User removed');
      load();
    } catch (err) {
      toast.error('Failed to remove user');
    }
  };

  const canChangeStatus = user && canChangeProjectStatus(user.role);
  const canDeleteProjectNotes = Boolean(user && ['super_admin', 'operations_manager'].includes(user.role));

  const onEditProject = async (data: any) => {
    try {
      const projectFields = { ...data };
      delete projectFields.scope_of_work;
      delete projectFields.office_notes;
      delete projectFields.field_notes;
      delete projectFields.budget;
      const payload = {
        ...projectFields,
        address: editAddress || data.address,
        ...(canViewProjectBudget(user?.role) ? { budget: editBudget ? parseFloat(editBudget) : null } : {}),
        purchase_price: editPurchasePrice ? parseFloat(editPurchasePrice) : null,
        arv: editArv ? parseFloat(editArv) : null,
        closing_costs: editClosingCosts ? parseFloat(editClosingCosts) : null,
        punchlist_stage: data.punchlist_stage ? 1 : 0,
      };
      if (!canChangeStatus) delete payload.status;
      if (!canChangeStatus) delete payload.punchlist_stage;
      await api.put(`/projects/${id}`, payload);
      toast.success('Project updated');
      setShowEdit(false);
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update project');
    }
  };

  const handleMainPhotoUpload = async (file?: File) => {
    if (!file || !id) return;
    setUploadingMainPhoto(true);
    try {
      const formData = new FormData();
      formData.append('photo', file);
      const res = await api.post(`/projects/${id}/main-photo`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setProject((current: any) => ({ ...current, main_photo_url: res.data.main_photo_url }));
      toast.success('Project house photo updated');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to upload project photo');
    } finally {
      setUploadingMainPhoto(false);
    }
  };

  const activatePunchList = async () => {
    if (!id || !canChangeStatus || activatingPunchList) return;
    setActivatingPunchList(true);
    try {
      await api.put(`/projects/${id}`, { punchlist_stage: 1 });
      toast.success('Punch list activated');
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to activate punch list');
    } finally {
      setActivatingPunchList(false);
    }
  };

  const uploadProgressPicturesToNote = async (noteId: string, files: File[], source: ProgressCaptureSource = 'desktop') => {
    if (!files.length) return;
    const formData = new FormData();
    files.forEach(file => formData.append('photos', file));
    formData.append('note_id', noteId);
    formData.append('photo_type', 'progress');
    formData.append('caption', 'Photos attached to project note');
    await appendProgressUploadAudit(formData, files, files.map(() => source), { projectId: id });
    await api.post(`/projects/${id}/photos?type=progress`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  };

  const attachProgressPicturesToExistingNote = async (files?: FileList | File[] | null, explicitNoteId?: string) => {
    const selectedFiles = Array.from(files || []);
    const targetNoteId = explicitNoteId || attachNoteId;
    if (!targetNoteId || selectedFiles.length === 0) return;
    setAttachingNoteId(targetNoteId);
    try {
      await uploadProgressPicturesToNote(targetNoteId, selectedFiles, isMobileCaptureContext() ? 'device_camera' : 'desktop');
      toast.success(`${selectedFiles.length} progress picture${selectedFiles.length === 1 ? '' : 's'} attached`);
      await loadNotes();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to attach photos');
    } finally {
      setAttachNoteId(null);
      setAttachingNoteId(null);
      if (attachExistingNoteInputRef.current) attachExistingNoteInputRef.current.value = '';
    }
  };

  const chooseNoteProgressPictures = () => {
    if (isMobileCaptureContext()) {
      noteCameraInputRef.current?.click();
      return;
    }
    noteMediaInputRef.current?.click();
  };

  const addNote = async () => {
    if (!newNote.trim()) return;
    try {
      const noteRes = await api.post(`/projects/${id}/notes`, { note: newNote, note_type: noteType, visibility: noteVisibility });
      if (notePhotoFiles.length) {
        await uploadProgressPicturesToNote(noteRes.data.id, notePhotoFiles, notePhotoSource);
      }
      setNewNote('');
      setNotePhotoFiles([]);
      setNotePhotoSource('desktop');
      loadNotes();
    } catch (err) {
      toast.error('Failed to add note');
    }
  };

  const openCalendarComposer = () => {
    const defaultTitle = newNote.trim()
      ? newNote.trim().replace(/\s+/g, ' ').slice(0, 120)
      : `Follow up: ${project?.job_name || project?.address || 'project'}`;
    setCalendarTitle(defaultTitle);
    setCalendarDate(new Date().toISOString().slice(0, 10));
    setCalendarReminderEnabled(false);
    setCalendarReminderRecipients('');
    setCalendarReminderMessage(newNote.trim() || defaultTitle);
    setCalendarReminderScheduleType('once');
    setCalendarReminderDate(formatLocalDateInput());
    setCalendarReminderTime(defaultReminderTime());
    setShowCalendarComposer(true);
  };

  const addCalendarEvent = async () => {
    if (!calendarTitle.trim()) {
      toast.error('Calendar title is required');
      return;
    }
    if (!calendarDate) {
      toast.error('Calendar date is required');
      return;
    }
    const reminderRecipients = splitReminderEmails(calendarReminderRecipients);
    if (calendarReminderEnabled && !reminderRecipients.length) {
      toast.error('Enter at least one reminder email');
      return;
    }
    if (calendarReminderEnabled && calendarReminderScheduleType !== 'now' && (!calendarReminderDate || !calendarReminderTime)) {
      toast.error('Choose the reminder date and time');
      return;
    }
    setSavingCalendarEvent(true);
    try {
      const payload: any = {
        project_id: id,
        title: calendarTitle.trim(),
        description: calendarDetails.trim() || newNote.trim() || null,
        event_type: calendarEventType,
        scheduled_for: calendarDate,
        priority: calendarPriority,
        source_type: 'project_note',
      };
      if (calendarReminderEnabled && isAdminRole(user?.role || '')) {
        payload.email_reminder = {
          enabled: true,
          recipients: reminderRecipients,
          subject: calendarTitle.trim(),
          message: calendarReminderMessage.trim() || newNote.trim() || calendarTitle.trim(),
          schedule_type: calendarReminderScheduleType,
          send_at: calendarReminderScheduleType === 'now' ? new Date().toISOString() : localDateTimeToIso(calendarReminderDate, calendarReminderTime),
        };
      }
      const res = await api.post('/calendar/events', payload);
      if (res.data?.warning) {
        // The event WAS created; a warning is not a failure. Show it as a
        // neutral success so users don't re-submit and create duplicates.
        toast.success(`Added to operations calendar. ${res.data.warning}`);
      } else {
        toast.success(calendarReminderEnabled ? 'Added to calendar with email reminder' : 'Added to operations calendar');
      }
      setShowCalendarComposer(false);
      setCalendarTitle('');
      setCalendarDetails('');
      setCalendarPriority('normal');
      setCalendarEventType('task');
      setCalendarReminderEnabled(false);
      setCalendarReminderRecipients('');
      setCalendarReminderMessage('');
      await loadProjectCalendar();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to add calendar item');
    } finally {
      setSavingCalendarEvent(false);
    }
  };

  const saveNoteEdit = async (noteId: string) => {
    if (!editingNoteText.trim()) return;
    try {
      await api.put(`/projects/${id}/notes/${noteId}`, { note: editingNoteText, note_type: editingNoteType, visibility: editingNoteVisibility });
      toast.success('Note updated');
      setEditingNoteId(null);
      setEditingNoteText('');
      loadNotes();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update note');
    }
  };

  const deleteProjectNote = async (noteId: string) => {
    if (!id || !canDeleteProjectNotes || deletingNoteId) return;
    if (!window.confirm('Delete this note? Attached photos will stay in the project photo history.')) return;
    setDeletingNoteId(noteId);
    try {
      await api.delete(`/projects/${id}/notes/${noteId}`);
      setNotes(current => current.filter(note => note.id !== noteId));
      if (editingNoteId === noteId) {
        setEditingNoteId(null);
        setEditingNoteText('');
      }
      toast.success('Note deleted');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to delete note');
    } finally {
      setDeletingNoteId(null);
    }
  };

  const startNoteDictation = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      toast.error('Microphone dictation is not supported in this browser');
      return;
    }

    noteRecognitionRef.current?.stop?.();
    noteRecognitionRef.current = null;
    noteDictationBaseRef.current = newNote;
    setNoteDictationStatus('starting');
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      if (noteRecognitionRef.current === recognition) setNoteDictationStatus('listening');
    };
    recognition.onend = () => {
      if (noteRecognitionRef.current === recognition) {
        setNoteDictationStatus('idle');
        noteRecognitionRef.current = null;
      }
    };
    recognition.onerror = (event: any) => {
      if (noteRecognitionRef.current === recognition) {
        setNoteDictationStatus('idle');
        noteRecognitionRef.current = null;
      }
      if (event?.error !== 'aborted') toast.error('Microphone dictation stopped');
    };
    recognition.onresult = (event: any) => {
      const spokenText = getRecognitionTranscript(event.results);
      if (spokenText) setNewNote(appendDictationText(noteDictationBaseRef.current, spokenText));
    };
    noteRecognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      noteRecognitionRef.current = null;
      setNoteDictationStatus('idle');
      toast.error('Microphone dictation could not start');
    }
  };

  const stopNoteDictation = () => {
    const recognition = noteRecognitionRef.current;
    noteRecognitionRef.current = null;
    recognition?.stop?.();
    setNoteDictationStatus('idle');
  };

  if (loading) return <Loading />;
  if (!project) return <div className="p-6 text-center text-gray-500">Project not found</div>;

  const canEdit = user && canManageProjects(user.role);
  const punchlistStageActive = isPunchlistStageEnabled(project.punchlist_stage);
  const canAssign = user && isAdminRole(user.role);
  const canSeeBudget = Boolean(user && canViewProjectBudget(user.role));
  const canSeeProjectCalendar = Boolean(user && canViewProjectCalendar(user.role));
  const fieldWork = project.field_work || { counts: {}, tasks: [], invoice_holds: [] };

  const tabs: { id: Tab; label: string; icon: any }[] = [
    { id: 'details', label: 'Project Details', icon: ListFilter },
    { id: 'notes', label: 'Notes', icon: MessageSquare },
    { id: 'construction-plan', label: 'Scope of Work', icon: FileText },
    { id: 'project-timeline', label: 'Project Timeline', icon: CalendarDays },
    { id: 'quotes', label: 'Quotes', icon: FileText },
    { id: 'punch-list', label: punchlistStageActive ? 'Punch List Active' : 'Start Punch List', icon: ClipboardList },
    { id: 'photos', label: 'Photos Bucket', icon: Camera },
    { id: 'team', label: 'Assigned Contractors', icon: Users },
    { id: 'texts', label: 'Text Contractors', icon: MessageSquare },
  ];

  const updateFieldWorkTask = async (taskId: string, patch: Record<string, any>) => {
    try {
      await api.put(`/field-work/projects/${id}/tasks/${taskId}`, patch);
      toast.success('Field work status updated');
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update field work status');
    }
  };

  const approveFieldWorkTask = async (taskId: string) => {
    try {
      await api.post(`/field-work/projects/${id}/tasks/${taskId}/approve`, {});
      toast.success('Field work approved for payment');
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to approve field work');
    }
  };

  const reviewFieldWorkTask = async (taskId: string, decision: string) => {
    const decisionLabel = decision.replace(/_/g, ' ');
    const comment = decision === 'approved'
      ? ''
      : window.prompt(`Add a note for "${decisionLabel}" so the field team knows what to do next:`);
    if (comment === null) return;
    if (decision !== 'approved' && !comment.trim()) {
      toast.error('A note is required when field work is not approved');
      return;
    }
    try {
      await api.post(`/field-work/projects/${id}/tasks/${taskId}/review`, { decision, comment: comment.trim() });
      toast.success('Field work review saved');
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to save field work review');
    }
  };

  const notesPanel = (compact = false, section: 'full' | 'list' | 'composer' = 'full') => (
    <div className="bt-project-notes-panel h-full rounded-xl border border-blue-400/45 bg-gradient-to-br from-slate-950 via-slate-900 to-blue-950 p-3 shadow-[0_18px_44px_rgba(15,23,42,0.34)] ring-1 ring-cyan-300/10 sm:p-4">
      <input
        ref={attachExistingNoteInputRef}
        type="file"
        multiple
        accept={PROGRESS_MEDIA_ACCEPT}
        className="hidden"
        onChange={event => attachProgressPicturesToExistingNote(event.target.files)}
      />
      {section !== 'list' && (<>
      <div className="bt-project-notes-header mb-3 flex items-center justify-between gap-3 rounded-xl border border-cyan-300/25 bg-gradient-to-r from-slate-900 via-blue-950 to-slate-900 px-3 py-2.5 shadow-[0_8px_22px_rgba(37,99,235,0.18)]">
        <div className="min-w-0">
          <h3 className="text-base font-black text-white sm:text-lg">Project Notes</h3>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={addNote}
            disabled={!newNote.trim()}
            className="inline-flex min-h-[36px] items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 text-sm font-black text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 sm:hidden"
          >
            <Send className="h-3.5 w-3.5" />
            Save
          </button>
        </div>
      </div>
      <div className="bt-project-note-composer mb-4 rounded-2xl border border-amber-300/35 bg-gradient-to-br from-slate-950 via-slate-900 to-amber-950 p-3 shadow-[0_14px_34px_rgba(245,158,11,0.14)]">
        <VoiceTextarea
          value={newNote}
          onChange={e => setNewNote(e.target.value)}
          rows={compact ? 2 : 3}
          className="mb-3 min-h-[178px] w-full resize-none rounded-xl border border-cyan-300/65 bg-[#07162F] px-4 py-3 text-lg font-bold leading-7 text-white caret-cyan-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_0_1px_rgba(37,99,235,0.20)] placeholder:text-slate-200/85 focus:border-cyan-200 focus:outline-none focus:ring-2 focus:ring-cyan-300/70 sm:min-h-[108px] sm:py-3 sm:text-base"
          placeholder="Add a note..."
        />
        <button
          type="button"
          onClick={addNote}
          disabled={!newNote.trim()}
          className="mb-3 inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-base font-black text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 sm:hidden"
        >
          <Send className="h-4 w-4" />
          Done - Submit Note
        </button>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <select value={noteType} onChange={e => setNoteType(e.target.value)} className="min-h-[46px] w-full rounded-lg border border-slate-400 bg-white px-3 py-2 text-base font-bold text-slate-800 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 sm:w-auto">
          <option value="general">General</option>
          <option value="office">Office</option>
          <option value="field">Field</option>
        </select>
        <label className="inline-flex min-h-[46px] items-center justify-center gap-2 rounded-lg border border-slate-400 bg-white px-3 py-2 text-base font-bold text-slate-700 shadow-sm">
          <input
            type="checkbox"
            checked={noteVisibility === 'public'}
            onChange={e => setNoteVisibility(e.target.checked ? 'public' : 'private')}
            style={{ accentColor: '#2563EB' }}
          />
          <span className="text-center leading-tight sm:hidden">Public</span>
          <span className="hidden sm:inline">Public to contractors</span>
        </label>
        <input
          ref={noteMediaInputRef}
          type="file"
          accept={PROGRESS_MEDIA_ACCEPT}
          multiple
          className="hidden"
          onChange={e => {
            setNotePhotoSource('desktop');
            setNotePhotoFiles(Array.from(e.target.files || []));
            e.currentTarget.value = '';
          }}
        />
        <input
          ref={noteCameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="hidden"
          onChange={e => {
            setNotePhotoSource('device_camera');
            setNotePhotoFiles(Array.from(e.target.files || []));
            e.currentTarget.value = '';
          }}
        />
        <button
          type="button"
          onClick={chooseNoteProgressPictures}
          {...fileDropHandlers(files => {
            setNotePhotoSource('desktop');
            setNotePhotoFiles(files);
          }, { accept: PROGRESS_MEDIA_ACCEPT, multiple: true })}
          className="inline-flex min-h-[46px] cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-slate-400 bg-white px-3 py-2 text-base font-bold text-slate-700 shadow-sm transition-colors hover:bg-slate-50 sm:min-w-[150px]"
        >
          <Camera className="w-4 h-4" />
          {notePhotoFiles.length ? `${notePhotoFiles.length} ready` : (
            <>
              <span className="sm:hidden">Take Pictures</span>
              <span className="hidden sm:inline">Photos</span>
            </>
          )}
        </button>
        <button
          type="button"
          onClick={openCalendarComposer}
          className="inline-flex min-h-[46px] items-center justify-center gap-1.5 rounded-lg border border-amber-400 bg-amber-50 px-3 py-2 text-base font-black text-amber-800 shadow-sm transition-colors hover:bg-amber-100"
        >
          <CalendarDays className="w-4 h-4" />
          Add to Calendar
        </button>
        <button
          type="button"
          onClick={addNote}
          className="hidden min-h-[50px] w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-3 text-base font-black text-white shadow-sm transition-colors hover:bg-blue-700 sm:col-span-1 sm:inline-flex sm:flex-1 sm:py-2"
        >
          <Send className="h-4 w-4" />
          Submit Note
        </button>
        </div>
      {showCalendarComposer && (
        <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 shadow-sm">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-black uppercase tracking-wide text-amber-800">Operations Calendar</p>
              <p className="text-xs font-semibold text-amber-700">Schedule this project item for the dashboard calendar.</p>
            </div>
            <button type="button" onClick={() => setShowCalendarComposer(false)} className="rounded-lg px-2 py-1 text-xs font-black text-amber-800 hover:bg-amber-100">
              Close
            </button>
          </div>
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1.5fr)_150px_150px_130px_auto]">
            <input
              value={calendarTitle}
              onChange={e => setCalendarTitle(e.target.value)}
              className="min-h-[42px] rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
              placeholder="Calendar item title"
            />
            <input
              type="date"
              value={calendarDate}
              onChange={e => setCalendarDate(e.target.value)}
              className="min-h-[42px] rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
            <select
              value={calendarEventType}
              onChange={e => setCalendarEventType(e.target.value)}
              className="min-h-[42px] rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
            >
              <option value="task">Task</option>
              <option value="inspection">Inspection</option>
              <option value="maintenance">Maintenance</option>
              <option value="note">Note</option>
            </select>
            <select
              value={calendarPriority}
              onChange={e => setCalendarPriority(e.target.value)}
              className="min-h-[42px] rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
            >
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
              <option value="low">Low</option>
            </select>
            <button
              type="button"
              onClick={addCalendarEvent}
              disabled={savingCalendarEvent}
              className="inline-flex min-h-[42px] items-center justify-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-black text-white shadow-sm transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-amber-300"
            >
              <CalendarDays className="h-4 w-4" />
              {savingCalendarEvent ? 'Saving' : 'Save'}
            </button>
          </div>
          <textarea
            value={calendarDetails}
            onChange={e => setCalendarDetails(e.target.value)}
            rows={2}
            className="mt-2 w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-semibold text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500"
            placeholder="Details of the task or event (optional) — what needs to be done, where, who, etc."
          />
          {isAdminRole(user?.role || '') && (
            <div className="mt-3 rounded-xl border border-amber-300 bg-white p-3 shadow-sm">
              <label className="flex items-start gap-2 text-sm font-black text-amber-900">
                <input
                  type="checkbox"
                  checked={calendarReminderEnabled}
                  onChange={e => setCalendarReminderEnabled(e.target.checked)}
                  className="mt-1 h-4 w-4 accent-amber-600"
                />
                <span>
                  Add emailed reminder from info@newurbandev.com
                  <span className="block text-xs font-semibold text-amber-700">Send now, one time, weekly, or monthly to any email address.</span>
                </span>
              </label>

              {calendarReminderEnabled && (
                <div className="mt-3 space-y-3">
                  <label className="block">
                    <span className="text-xs font-black uppercase tracking-wide text-slate-600">Reminder recipients</span>
                    <textarea
                      value={calendarReminderRecipients}
                      onChange={e => setCalendarReminderRecipients(e.target.value)}
                      rows={2}
                      className="mt-1 w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                      placeholder="contractor@email.com, manager@company.com"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-black uppercase tracking-wide text-slate-600">Email message</span>
                    <VoiceTextarea
                      value={calendarReminderMessage}
                      onChange={e => setCalendarReminderMessage(e.target.value)}
                      rows={3}
                      className="mt-1 w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                      placeholder="Write the reminder that should be emailed."
                    />
                  </label>
                  <div className="grid gap-2 md:grid-cols-3">
                    <select
                      value={calendarReminderScheduleType}
                      onChange={e => setCalendarReminderScheduleType(e.target.value as 'now' | 'once' | 'weekly' | 'monthly')}
                      className="min-h-[42px] rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                    >
                      <option value="now">Send now</option>
                      <option value="once">One time</option>
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                    </select>
                    <input
                      type="date"
                      value={calendarReminderDate}
                      onChange={e => setCalendarReminderDate(e.target.value)}
                      disabled={calendarReminderScheduleType === 'now'}
                      className="min-h-[42px] rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                    />
                    <input
                      type="time"
                      value={calendarReminderTime}
                      onChange={e => setCalendarReminderTime(e.target.value)}
                      disabled={calendarReminderScheduleType === 'now'}
                      className="min-h-[42px] rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {notePhotoFiles.length > 0 && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 shadow-sm">
          <span className="text-xs font-semibold text-blue-700 truncate">{notePhotoFiles.length} progress picture{notePhotoFiles.length === 1 ? '' : 's'} will attach to this note</span>
          <button type="button" onClick={() => { setNotePhotoFiles([]); setNotePhotoSource('desktop'); }} className="text-xs font-bold text-blue-700 hover:underline">Remove</button>
        </div>
      )}
      </div>
      </>)}
      {section !== 'composer' && (
      <div className="bt-project-notes-list space-y-2">
        {notes.map(note => (
          <div key={note.id} className={`bt-project-note-card bt-project-note-card-${note.note_type || 'general'} flex items-start gap-3 rounded-xl border border-white/12 bg-gradient-to-br from-slate-900 via-slate-950 to-blue-950 p-4 shadow-[0_14px_36px_rgba(15,23,42,0.32)]`}>
            <Avatar src={note.user_avatar_url} name={note.user_name} size={36} />
            <div className="flex-1 min-w-0">
              <div className="bt-project-note-meta-bar mb-2 flex items-start justify-between gap-3 pb-1.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-base font-black text-white truncate">{note.user_name}</span>
                    <span className="text-sm font-semibold text-blue-100/85">
                      Inserted {formatEasternDateTime(note.created_at, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} New York time
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className={`text-sm px-2.5 py-0.5 rounded-full border font-black ${note.note_type === 'field' ? 'border-emerald-300/40 bg-emerald-500/15 text-emerald-100' : note.note_type === 'office' ? 'border-blue-300/40 bg-blue-500/15 text-blue-100' : 'border-slate-500 bg-slate-800 text-slate-200'}`}>{note.note_type}</span>
                  {canDeleteProjectNotes && (
                    <button
                      type="button"
                      onClick={() => deleteProjectNote(note.id)}
                      disabled={deletingNoteId === note.id}
                      className="inline-flex items-center gap-1 rounded-full border border-red-300/45 bg-red-500/15 px-2.5 py-0.5 text-sm font-black text-red-100 transition hover:border-red-200 hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                      title="Delete note"
                    >
                      <Trash2 className="h-3 w-3" />
                      {deletingNoteId === note.id ? 'Deleting' : 'Delete'}
                    </button>
                  )}
                </div>
              </div>
              {editingNoteId === note.id ? (
                <div className="space-y-2">
                  <VoiceTextarea
                    value={editingNoteText}
                    onChange={e => setEditingNoteText(e.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-cyan-300/60 bg-[#07162F] px-3 py-2 text-base font-semibold leading-7 text-white caret-cyan-200 placeholder:text-slate-200/85 focus:outline-none focus:ring-2 focus:ring-cyan-300/70 resize-none"
                  />
                  <div className="flex items-center gap-2">
                    <select value={editingNoteType} onChange={e => setEditingNoteType(e.target.value)} className="px-2 py-1.5 rounded-lg border border-gray-300 text-sm bg-white">
                      <option value="general">General</option>
                      <option value="office">Office</option>
                      <option value="field">Field</option>
                    </select>
                    <label className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-gray-300 text-sm font-bold text-gray-600 bg-white">
                      <input
                        type="checkbox"
                        checked={editingNoteVisibility === 'public'}
                        onChange={e => setEditingNoteVisibility(e.target.checked ? 'public' : 'private')}
                        style={{ accentColor: '#2563EB' }}
                      />
                      Public
                    </label>
                    <button type="button" onClick={() => saveNoteEdit(note.id)} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-bold">Save edit</button>
                    <button type="button" onClick={() => setEditingNoteId(null)} className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm font-bold text-gray-600">Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="bt-project-note-body rounded-lg bg-black/20 px-3 py-2.5 text-base font-semibold leading-7 text-slate-50 whitespace-pre-wrap sm:text-[17px]">{note.note}</p>
                  <span className={`inline-flex mt-2 rounded-full border px-2.5 py-0.5 text-sm font-bold ${note.visibility === 'public' ? 'border-emerald-300/40 bg-emerald-500/15 text-emerald-100' : 'border-slate-500 bg-slate-800 text-slate-200'}`}>
                    {note.visibility === 'public' ? 'Public to contractors' : 'Private management note'}
                  </span>
                  {getNotePhotos(note).length > 0 && (
                    <div className="bt-project-note-media-panel mt-2 rounded-lg border border-cyan-300/25 bg-slate-950/70 p-2 shadow-inner">
                      <div className="bt-project-note-media-grid grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                        {getNotePhotos(note).map((photo: any) => {
                          const src = `/uploads/${note.project_id}/${photo.filename}`;
                          const mediaKind = getProgressMediaKind(photo);
                          const isVideo = mediaKind === 'video';
                          return (
                            <div
                              key={photo.id}
                              className={`bt-project-note-media-tile relative aspect-square overflow-hidden rounded-lg border border-slate-300 bg-white shadow-sm ${mediaKind === 'file' ? 'cursor-pointer' : ''}`}
                              onClick={() => {
                                if (mediaKind === 'file') window.open(src, '_blank', 'noopener,noreferrer');
                              }}
                            >
                              {isVideo ? (
                                <>
                                  <video src={src} className="h-full w-full object-cover" muted playsInline preload="metadata" />
                                  <PlayCircle className="absolute inset-0 m-auto h-7 w-7 text-white drop-shadow" />
                                </>
                              ) : mediaKind === 'image' ? (
                                <img src={src} alt={photo.original_name || 'Note attachment'} className="h-full w-full object-cover" loading="lazy" />
                              ) : (
                                <UnsupportedProgressMediaTile name={photo.original_name || photo.filename} />
                              )}
                              <div className="absolute bottom-1 left-1 rounded-full bg-black/65 px-1.5 py-0.5 text-[10px] font-black text-white">
                                {formatEasternDateTime(photo.taken_at || photo.created_at, { hour: 'numeric', minute: '2-digit' })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <p className="bt-project-note-media-label px-1 pt-2 text-sm font-bold text-cyan-100/85">Photos attached to this note</p>
                    </div>
                  )}
                  {note.edited_at && (
                    <p className="text-sm text-slate-300 mt-2">Edited by {note.edited_by_name || note.user_name} on {formatEasternDateTime(note.edited_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} New York time</p>
                  )}
                </>
              )}
              {note.user_id === user?.id && Number(note.edit_count || 0) < 1 && editingNoteId !== note.id && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingNoteId(note.id);
                    setEditingNoteText(note.note);
                    setEditingNoteType(note.note_type || 'general');
                    setEditingNoteVisibility(note.visibility === 'public' ? 'public' : 'private');
                  }}
                  className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-blue-200 hover:text-white hover:underline"
                >
                  <Edit2 className="w-3 h-3" />
                  Edit note
                </button>
              )}
              {editingNoteId !== note.id && (
                <button
                  type="button"
                  onClick={() => {
                    setAttachNoteId(note.id);
                    attachExistingNoteInputRef.current?.click();
                  }}
                  disabled={attachingNoteId === note.id}
                  {...fileDropHandlers(files => {
                    setAttachNoteId(note.id);
                    void attachProgressPicturesToExistingNote(files, note.id);
                  }, {
                    accept: PROGRESS_MEDIA_ACCEPT,
                    disabled: attachingNoteId === note.id,
                    multiple: true,
                  })}
                  className="mt-2 ml-3 inline-flex items-center gap-1 text-xs font-bold text-amber-200 hover:text-white hover:underline disabled:opacity-50"
                >
                  <ImagePlus className="w-3 h-3" />
                  {attachingNoteId === note.id ? 'Attaching...' : 'Attach photos'}
                </button>
              )}
            </div>
          </div>
        ))}
        {notes.length === 0 && <p className="text-center text-slate-400 text-sm py-8">No notes yet</p>}
      </div>
      )}
    </div>
  );

  const openEditProject = () => {
    setShowEdit(true);
    setEditAddress(project.address || '');
    setEditBudget(project.budget ? String(project.budget) : '');
    setEditPurchasePrice(project.purchase_price ? String(project.purchase_price) : '');
    setEditArv(project.arv ? String(project.arv) : '');
    setEditClosingCosts(project.closing_costs ? String(project.closing_costs) : '');
    Object.entries(project).forEach(([key, value]) => setValue(key, value));
    setValue('punchlist_stage', punchlistStageActive);
  };

  return (
    <div className="min-h-full">
      {/* Header */}
      <div className="sticky top-0 z-50 isolate bg-white border-b border-gray-200 shadow-sm">
        <div className="px-4 md:px-6 py-3">
          <div className="flex items-center gap-4 mb-3">
            <button onClick={() => navigate('/projects')} className="flex-shrink-0 p-2 rounded-lg text-slate-300 hover:bg-white/5 hover:text-white transition-colors" aria-label="Back to projects">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="h-16 w-20 overflow-hidden rounded-xl border border-white/10 flex items-center justify-center flex-shrink-0 shadow-[0_6px_18px_rgba(0,0,0,0.45)]" style={{ background: '#1c1f29' }}>
              {project.main_photo_url ? (
                <img src={project.main_photo_url} alt={project.address} className="h-full w-full object-cover" />
              ) : (
                <MapPin className="w-6 h-6 text-blue-400" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="font-black text-white text-xl sm:text-2xl leading-tight truncate">{formatProjectAddressLabel(project.address)}</h1>
              <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                <StatusBadge status={project.status} />
                {punchlistStageActive && (
                  <span className="inline-flex items-center rounded-full border border-amber-400/40 bg-amber-500/20 px-3 py-1 text-xs font-black uppercase tracking-wide text-amber-200">
                    Punch List Active
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="bt-project-tabs grid grid-cols-2 items-stretch gap-1.5 overflow-visible sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 2xl:grid-cols-10">
            {tabs.map(({ id: tabId, label, icon: Icon }) => (
              <button
                key={tabId}
                onClick={() => setTab(tabId)}
                aria-pressed={tab === tabId}
                className={`bt-project-tab-button inline-flex min-h-10 min-w-0 items-center justify-center gap-1 rounded-lg border px-1.5 py-1.5 text-center text-[10px] font-black leading-tight transition-all duration-150 sm:px-2 ${tab === tabId ? 'is-active border-cyan-200 bg-gradient-to-br from-blue-500 via-indigo-600 to-cyan-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_10px_20px_rgba(37,99,235,0.42)] ring-1 ring-cyan-200/50' : 'border-slate-600 bg-gradient-to-br from-slate-800 via-slate-950 to-blue-950 text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.11),0_8px_16px_rgba(2,6,23,0.36)] hover:border-cyan-300 hover:from-slate-700 hover:via-blue-950 hover:to-cyan-950 hover:text-white hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_10px_22px_rgba(14,165,233,0.24)]'}`}
              >
                <Icon className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="min-w-0 leading-tight">{label}</span>
              </button>
            ))}
            <AddToCalendarButton
              label="Add to Calendar"
              defaultTitle={`Project reminder - ${project.address || project.job_name || 'project'}`}
              defaultDescription={[project.job_name, project.address].filter(Boolean).join('\n')}
              defaultDate={project.target_completion || project.start_date || null}
              projectId={id || project.id}
              sourceType="project"
              sourceId={id || project.id}
              contextLabel={[project.address, project.job_name].filter(Boolean).join(' - ')}
              onSaved={loadProjectCalendar}
              buttonClassName="bt-project-tab-button inline-flex min-h-10 min-w-0 items-center justify-center gap-1 rounded-lg border border-slate-600 bg-gradient-to-br from-slate-800 via-slate-950 to-blue-950 px-1.5 py-1.5 text-center text-[10px] font-black leading-tight text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.11),0_8px_16px_rgba(2,6,23,0.36)] transition-all duration-150 hover:border-cyan-300 hover:from-slate-700 hover:via-blue-950 hover:to-cyan-950 hover:text-white sm:px-2"
            />
          </div>
        </div>
      </div>

      {/* Tab Content */}
      <div className={`p-4 md:p-6 mx-auto ${tab === 'project-timeline' ? 'max-w-[1480px]' : 'max-w-6xl'}`}>
        {/* Notes / Overview (unified) */}
        {(tab === 'overview' || tab === 'notes') && (
          <div className="space-y-4">
            <div className="grid lg:grid-cols-5 gap-4">
              <div className="lg:col-span-3">
                {notesPanel(true, 'list')}
              </div>
              <div className="lg:col-span-2 space-y-4">
              {notesPanel(true, 'composer')}

              {canSeeProjectCalendar && (
                <ProjectMiniCalendarCard
                  events={projectCalendarEvents}
                  loading={loadingProjectCalendar}
                  anchorDateKey={projectCalendarAnchorDateKey}
                  onAnchorDateChange={setProjectCalendarAnchorDateKey}
                />
              )}

              <RecentFieldPhotosCard
                projectId={id!}
                photos={Array.isArray(project.recent_photos) ? project.recent_photos : []}
                onViewAll={() => setTab('photos')}
                onPhotoNoteSaved={load}
              />

              <button id="construction-plan" type="button" onClick={() => setTab('construction-plan')} className="w-full bg-white rounded-xl border border-gray-200 p-4 text-left hover:border-blue-300 hover:bg-blue-50 transition-colors">
                <h3 className="font-semibold text-gray-900 mb-2 text-sm">Scope of Work</h3>
                <p className="text-sm text-gray-600">Open project scope sections by house area, plus the execution plan, materials, costs, and step photos.</p>
              </button>
              <button id="project-timeline" type="button" onClick={() => setTab('project-timeline')} className="w-full rounded-xl border border-blue-300/40 bg-gradient-to-br from-slate-950 via-blue-950 to-slate-900 p-4 text-left text-white shadow-[0_14px_36px_rgba(15,23,42,0.22)] transition-colors hover:border-cyan-300/70">
                <h3 className="font-semibold text-white mb-2 text-sm">Project Timeline</h3>
                <p className="text-sm font-semibold text-blue-100">View the rehab stages, task dates, material deliveries, and near-term lookahead for this house.</p>
              </button>
              <button id="quotes" type="button" onClick={() => setTab('quotes')} className="w-full bg-white rounded-xl border border-gray-200 p-4 text-left hover:border-blue-300 hover:bg-blue-50 transition-colors">
                <h3 className="font-semibold text-gray-900 mb-2 text-sm">Quotes</h3>
                <p className="text-sm text-gray-600">Store contractor quotes directly against this property.</p>
              </button>
              </div>
            </div>

          </div>
        )}

        {tab === 'details' && (
          <div className="max-w-4xl space-y-4">
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="font-semibold text-gray-900 text-base">Project Details</h3>
                {canEdit && (
                  <button
                    type="button"
                    onClick={openEditProject}
                    className="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border border-blue-400 bg-blue-600 px-3 text-xs font-black text-white shadow-sm transition hover:bg-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-300"
                  >
                    <Edit2 className="h-3.5 w-3.5" />
                    Edit Details
                  </button>
                )}
              </div>
              <div className="grid sm:grid-cols-2 gap-4 text-sm">
                {[
                  { label: 'Status', value: (
                    <span
                      className="text-sm font-black"
                      style={{ color: project.status === 'active_rehab' || project.status === 'active'
                        ? '#6EE7A0'
                        : project.status === 'rehab_completed'
                          ? '#93C5FD'
                          : project.status === 'closed_sold'
                            ? '#CBD5E1'
                            : project.status === 'on_market' || project.status === 'long_term_holding'
                              ? '#FCD34D'
                              : '#FFF4E8' }}
                    >
                      {statusLabels[project.status] || String(project.status || '').replace(/_/g, ' ')}
                    </span>
                  ) },
                  ...(punchlistStageActive ? [{ label: 'Punch List', value: <span className="text-sm font-black" style={{ color: '#FCD34D' }}>Active</span> }] : []),
                  { label: 'Start Date', value: project.start_date ? format(new Date(project.start_date), 'MMM d, yyyy') : '—' },
                  { label: 'Target Completion', value: project.target_completion ? format(new Date(project.target_completion), 'MMM d, yyyy') : '—' },
                  { label: 'Budget', value: project.budget ? `$${Number(project.budget).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—' },
                  { label: 'Lockbox Code', value: project.lockbox_code || 'Not entered' },
                  { label: 'Created By', value: project.created_by_name || '—' },
                ].filter(item => canSeeBudget || item.label !== 'Budget').map(({ label, value }) => (
                  <div key={label}>
                    <p className="text-xs text-gray-500 mb-0.5">{label}</p>
                    <div className="font-medium text-gray-900">{value}</div>
                  </div>
                ))}
                <ProjectContractorAssignmentPanel projectId={id!} compact canAssign={Boolean(canAssign)} />
              </div>
            </div>
          </div>
        )}

        {tab === 'progress-history' && (
          <ProgressHistoryTab projectId={id!} project={project} />
        )}

        {tab === 'construction-plan' && (
          <ScopeOfWorkTab projectId={id!} project={project} canManage={!!canEdit} />
        )}

        {tab === 'project-timeline' && (
          <ProjectTimelineTab projectId={id!} project={project} canManage={!!canEdit} canDelete={!!canChangeStatus} />
        )}

        {tab === 'quotes' && (
          <QuotesTab projectId={id!} project={project} />
        )}

        {/* Punch List Tab */}
        {tab === 'punch-list' && (
          <PunchListTab
            projectId={id!}
            user={user}
            isActive={punchlistStageActive}
            canActivate={Boolean(canChangeStatus)}
            activating={activatingPunchList}
            onActivate={activatePunchList}
          />
        )}

        {/* Photos Tab */}
        {tab === 'photos' && (
          <PhotosTab projectId={id!} project={project} user={user} />
        )}

        {/* Invoices Tab */}
        {tab === 'invoices' && (
          <InvoicesTab projectId={id!} user={user} project={project} />
        )}

        {/* Team Tab */}
        {tab === 'team' && (
          <ProjectContractorAssignmentPanel projectId={id!} canAssign={Boolean(canAssign)} />
        )}

        {tab === 'texts' && (
          <ProjectTextMessagesTab projectId={id!} project={project} />
        )}

      </div>

      {/* Edit Project Modal */}
      <Modal isOpen={showEdit} onClose={() => setShowEdit(false)} title="Edit Project" size="lg">
        <form onSubmit={handleSubmit(onEditProject)} className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-2">Main House Photo</label>
              <label
                className="flex items-center gap-3 p-3 rounded-xl border border-dashed border-gray-300 cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors"
                {...fileDropHandlers(files => handleMainPhotoUpload(files[0]), {
                  accept: 'image/*',
                  disabled: uploadingMainPhoto,
                  multiple: false,
                })}
              >
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={uploadingMainPhoto}
                  onChange={e => {
                    const file = e.target.files?.[0];
                    handleMainPhotoUpload(file);
                    e.currentTarget.value = '';
                  }}
                />
                <div className="w-16 h-12 rounded-xl overflow-hidden flex items-center justify-center flex-shrink-0" style={{ background: '#F3F4F6' }}>
                  {project.main_photo_url ? (
                    <img src={project.main_photo_url} alt={project.address} className="w-full h-full object-cover" />
                  ) : (
                    <Camera className="w-5 h-5 text-gray-400" />
                  )}
                </div>
                <div>
                  <p className="text-sm font-bold text-gray-900">{uploadingMainPhoto ? 'Uploading...' : project.main_photo_url ? 'Change main photo' : 'Upload main photo'}</p>
                  <p className="text-xs text-gray-500">One primary photo appears on the project card beside the address.</p>
                </div>
              </label>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Address *</label>
              <GooglePlacesInput
                value={editAddress}
                onChange={(val) => { setEditAddress(val); setValue('address', val); }}
                placeholder="123 Main St, City, State"
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Job Name *</label>
              <input {...register('job_name', { required: true })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              {canChangeStatus ? (
                <select {...register('status')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                  {PROJECT_STATUS_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              ) : (
                <div className="flex min-h-[42px] items-center rounded-lg border border-gray-200 bg-gray-50 px-3.5">
                  <StatusBadge status={project.status} />
                </div>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Lockbox Code</label>
              <input {...register('lockbox_code')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Enter lockbox code" />
            </div>
            {canChangeStatus && (
              <label className="sm:col-span-2 flex items-start gap-3 rounded-xl border border-yellow-300 bg-yellow-50 p-3">
                <input
                  type="checkbox"
                  {...register('punchlist_stage')}
                  className="mt-1 h-4 w-4 rounded border-yellow-400 text-yellow-500 focus:ring-yellow-400"
                />
                <span>
                  <span className="block text-sm font-black text-yellow-950">Punchlist Stage</span>
                  <span className="block text-xs font-semibold text-yellow-800">Show a large yellow badge when this project is in the final punch list stage before going to market.</span>
                </span>
              </label>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Acquisition Date</label>
              <input type="date" {...register('acquisition_date')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
              <input type="date" {...register('start_date')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Target Completion</label>
              <input type="date" {...register('target_completion')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            {canSeeBudget && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Budget</label>
                <CurrencyInput value={editBudget} onChange={setEditBudget} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            )}
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={() => setShowEdit(false)} className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">
              {isSubmitting ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Assign User Modal */}
      <Modal isOpen={showAssign} onClose={() => setShowAssign(false)} title="Assign User to Project">
        <div className="space-y-2">
          {allUsers.filter(u => !project.assignments?.some((a: any) => a.user_id === u.id)).map(u => (
            <button key={u.id} onClick={() => { handleAssign(u.id); setShowAssign(false); }} className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50 transition-colors text-left">
              <div className="w-9 h-9 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                <span className="text-blue-700 font-bold text-sm">{u.name?.[0]?.toUpperCase()}</span>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900">{u.name}</p>
                <p className="text-xs text-gray-500">{u.email} · {u.role.replace(/_/g, ' ')}</p>
              </div>
            </button>
          ))}
          {allUsers.filter(u => !project.assignments?.some((a: any) => a.user_id === u.id)).length === 0 && (
            <p className="text-center text-gray-400 text-sm py-4">All users are already assigned</p>
          )}
        </div>
      </Modal>
    </div>
  );
}

// ---- Sub-components ----

const contractorDisplayName = (contractor?: ContractorDirectoryRow | null) =>
  contractor?.name || contractor?.vendor_name || 'Unnamed contractor';

const contractorTypeLabel = (contractor?: ContractorDirectoryRow | null) => {
  if (!contractor) return 'Uncategorized';
  const categories = Array.isArray(contractor.contractor_categories)
    ? contractor.contractor_categories.map(item => String(item || '').trim()).filter(Boolean)
    : [];
  if (categories.length) return categories.join(' / ');
  return [contractor.contractor_category, contractor.contractor_secondary_category]
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .join(' / ') || 'Uncategorized';
};

const contractorProjectIds = (contractor: ContractorDirectoryRow) =>
  new Set((contractor.connected_projects || []).map(project => project.id).filter(Boolean).map(String));

function ProjectContractorAssignmentPanel({
  projectId,
  compact = false,
  canAssign,
}: {
  projectId: string;
  compact?: boolean;
  canAssign: boolean;
}) {
  const [contractors, setContractors] = useState<ContractorDirectoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAssign, setShowAssign] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);

  const isConnectedToProject = (contractor: ContractorDirectoryRow) =>
    contractorProjectIds(contractor).has(projectId);

  const loadContractors = async () => {
    setLoading(true);
    try {
      const res = await api.get('/users/contractors/directory');
      const rows: ContractorDirectoryRow[] = Array.isArray(res.data?.contractors) ? res.data.contractors : [];
      setContractors(rows);
      setSelectedIds(new Set(rows.filter(item => item.connected_projects?.some(project => project.id === projectId)).map(item => item.id)));
    } catch {
      toast.error('Failed to load contractors');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadContractors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const assignedContractors = useMemo(
    () => contractors.filter(contractor => isConnectedToProject(contractor)).sort((left, right) => contractorDisplayName(left).localeCompare(contractorDisplayName(right))),
    [contractors, projectId]
  );

  const visibleContractors = useMemo(() => {
    const search = query.trim().toLowerCase();
    return [...contractors]
      .sort((left, right) => {
        const leftSelected = selectedIds.has(left.id) ? 0 : 1;
        const rightSelected = selectedIds.has(right.id) ? 0 : 1;
        if (leftSelected !== rightSelected) return leftSelected - rightSelected;
        return contractorDisplayName(left).localeCompare(contractorDisplayName(right));
      })
      .filter(contractor => {
        if (!search) return true;
        return [
          contractorDisplayName(contractor),
          contractor.contact_name,
          contractor.phone,
          contractor.email,
          contractor.billing_address,
          contractorTypeLabel(contractor),
        ].filter(Boolean).join(' ').toLowerCase().includes(search);
      });
  }, [contractors, query, selectedIds]);

  const openAssign = () => {
    setSelectedIds(new Set(assignedContractors.map(contractor => contractor.id)));
    setShowAssign(true);
    if (!contractors.length) loadContractors();
  };

  const toggleContractor = (contractorId: string) => {
    setSelectedIds(current => {
      const next = new Set(current);
      if (next.has(contractorId)) next.delete(contractorId);
      else next.add(contractorId);
      return next;
    });
  };

  const saveAssignments = async () => {
    setSaving(true);
    try {
      const updates = contractors
        .map(contractor => {
          const currentlyConnected = isConnectedToProject(contractor);
          const shouldConnect = selectedIds.has(contractor.id);
          if (currentlyConnected === shouldConnect) return null;
          const nextProjectIds = contractorProjectIds(contractor);
          if (shouldConnect) nextProjectIds.add(projectId);
          else nextProjectIds.delete(projectId);
          return api.put(`/users/contractors/${contractor.id}/projects`, { project_ids: Array.from(nextProjectIds) });
        })
        .filter(Boolean);

      if (updates.length) {
        const results = await Promise.allSettled(updates);
        const failed = results.filter(result => result.status === 'rejected').length;
        if (failed) throw new Error(`${failed} contractor assignment update${failed === 1 ? '' : 's'} failed`);
      }

      toast.success('Contractor assignments updated');
      setShowAssign(false);
      await loadContractors();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update contractor assignments');
    } finally {
      setSaving(false);
    }
  };

  const panel = (
    <div className={`${compact ? 'sm:col-span-2' : ''} rounded-xl border border-blue-200 bg-gradient-to-br from-slate-950 via-blue-950 to-slate-900 p-4 text-white shadow-sm`}>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[11px] font-black uppercase tracking-wide text-blue-200">Project contractors</p>
          <h3 className="text-sm font-black text-white">Assigned Contractors</h3>
          <p className="mt-1 text-xs font-semibold text-blue-100">{assignedContractors.length} assigned to this project</p>
        </div>
        {canAssign && (
          <button
            type="button"
            onClick={openAssign}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-amber-300 bg-amber-500 px-4 text-sm font-black text-slate-950 shadow-sm transition hover:bg-amber-400"
          >
            <UserPlus className="h-4 w-4" />
            Assign Contractors
          </button>
        )}
      </div>

      {loading ? (
        <p className="rounded-lg border border-white/10 bg-white/10 px-3 py-2 text-xs font-bold text-blue-100">Loading contractors...</p>
      ) : assignedContractors.length ? (
        <div className={`${compact ? 'max-h-44' : 'max-h-[28rem]'} space-y-1.5 overflow-y-auto pr-1`}>
          {assignedContractors.map(contractor => (
            <div key={contractor.id} className="grid gap-1 rounded-lg border border-white/10 bg-white/10 px-3 py-2 text-xs sm:grid-cols-[minmax(8rem,1fr)_minmax(8rem,1fr)_minmax(6rem,.7fr)] sm:items-center">
              <p className="truncate font-black text-white">{contractorDisplayName(contractor)}</p>
              <p className="truncate font-semibold text-blue-100">{contractorTypeLabel(contractor)}</p>
              <p className="truncate font-semibold text-slate-300">{contractor.phone || contractor.email || 'No contact on file'}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-white/20 bg-white/5 px-3 py-4 text-sm font-semibold text-blue-100">
          No contractors assigned yet. Use Assign Contractors to select the contractors working this project.
        </p>
      )}

      <Modal isOpen={showAssign} onClose={() => setShowAssign(false)} title="Assign Contractors" size="xl">
        <div className="space-y-4">
          <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4">
            <p className="text-sm font-black text-blue-950">Select contractors for this project</p>
            <p className="mt-1 text-xs font-semibold text-blue-800">Checked contractors will be connected to this project. Unchecked contractors will be removed from this project only.</p>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2.5">
            <Search className="h-4 w-4 flex-shrink-0 text-slate-400" />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              aria-label="Search contractors"
              className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-slate-950 outline-none placeholder:text-slate-500"
            />
          </div>
          <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
            {visibleContractors.map(contractor => {
              const checked = selectedIds.has(contractor.id);
              return (
                <label
                  key={contractor.id}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${checked ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white hover:border-blue-200 hover:bg-blue-50'}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleContractor(contractor.id)}
                    className="mt-1 h-5 w-5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-black text-slate-950">{contractorDisplayName(contractor)}</p>
                      {checked && <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-black text-emerald-800">Assigned</span>}
                    </div>
                    <p className="mt-1 text-xs font-bold text-slate-600">{contractorTypeLabel(contractor)}</p>
                    <p className="mt-1 truncate text-xs font-semibold text-slate-500">{contractor.phone || contractor.email || contractor.billing_address || 'No contact details on file'}</p>
                  </div>
                </label>
              );
            })}
            {!visibleContractors.length && (
              <p className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm font-semibold text-slate-500">No contractors match this search.</p>
            )}
          </div>
          <div className="flex flex-col gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm font-black text-slate-700">{selectedIds.size} contractor{selectedIds.size === 1 ? '' : 's'} selected</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowAssign(false)}
                disabled={saving}
                className="inline-flex min-h-10 items-center justify-center rounded-xl border border-slate-300 bg-white px-4 text-sm font-black text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void saveAssignments()}
                disabled={saving}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-black text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Check className="h-4 w-4" />
                {saving ? 'Saving...' : 'Save Contractor Assignments'}
              </button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );

  return panel;
}

const textStatusMeta = (status?: string) => {
  switch (status) {
    case 'sent':
    case 'delivered':
      return { label: status === 'delivered' ? 'Delivered' : 'Sent', className: 'bg-emerald-50 text-emerald-700 border-emerald-100' };
    case 'failed':
    case 'missing_phone':
      return { label: status === 'missing_phone' ? 'Missing phone' : 'Failed', className: 'bg-red-50 text-red-700 border-red-100' };
    case 'provider_not_configured':
      return { label: 'Provider TBD', className: 'bg-amber-50 text-amber-800 border-amber-100' };
    default:
      return { label: 'Queued', className: 'bg-blue-50 text-blue-700 border-blue-100' };
  }
};

function ProjectTextMessagesTab({ projectId, project }: { projectId: string; project: any }) {
  const [contractors, setContractors] = useState<ContractorDirectoryRow[]>([]);
  const [messages, setMessages] = useState<ContractorTextMessage[]>([]);
  const [selectedContractorId, setSelectedContractorId] = useState('');
  const [messageBody, setMessageBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  const isConnectedToProject = (contractor: ContractorDirectoryRow) =>
    Boolean(contractor.connected_projects?.some(item => item.id === projectId));

  const orderedContractors = useMemo(() => {
    return [...contractors].sort((left, right) => {
      const leftConnected = isConnectedToProject(left) ? 0 : 1;
      const rightConnected = isConnectedToProject(right) ? 0 : 1;
      if (leftConnected !== rightConnected) return leftConnected - rightConnected;
      return contractorDisplayName(left).localeCompare(contractorDisplayName(right));
    });
  }, [contractors, projectId]);

  const connectedCount = useMemo(
    () => contractors.filter(item => isConnectedToProject(item)).length,
    [contractors, projectId]
  );

  const selectedContractor = useMemo(
    () => orderedContractors.find(item => item.id === selectedContractorId) || null,
    [orderedContractors, selectedContractorId]
  );

  const loadTextingData = async () => {
    setLoading(true);
    try {
      const [directoryRes, messagesRes] = await Promise.all([
        api.get('/users/contractors/directory'),
        api.get(`/text-messages?project_id=${encodeURIComponent(projectId)}&limit=200`),
      ]);
      const nextContractors: ContractorDirectoryRow[] = directoryRes.data?.contractors || [];
      setContractors(nextContractors);
      setMessages(messagesRes.data?.messages || []);
      if (!selectedContractorId && nextContractors.length) {
        const connected = nextContractors.find(item => item.connected_projects?.some(projectItem => projectItem.id === projectId));
        setSelectedContractorId((connected || nextContractors[0]).id);
      }
    } catch (err) {
      toast.error('Failed to load contractor text records');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTextingData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const sendTextMessage = async () => {
    if (!selectedContractor) return toast.error('Select a contractor');
    if (!messageBody.trim()) return toast.error('Enter a message');
    if (!selectedContractor.phone) return toast.error('Selected contractor has no phone number on file');
    setSending(true);
    try {
      const res = await api.post('/text-messages', {
        project_id: projectId,
        contractor_id: selectedContractor.id,
        body: messageBody.trim(),
      });
      const savedMessage = res.data?.message;
      if (savedMessage) setMessages(current => [savedMessage, ...current]);
      setMessageBody('');
      if (savedMessage?.status === 'sent' || savedMessage?.status === 'delivered') {
        toast.success('Text sent and recorded');
      } else if (savedMessage?.status === 'provider_not_configured') {
        toast.success('Message saved. Text provider is still TBD.');
      } else {
        toast.success('Message record saved');
      }
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to record text message');
    } finally {
      setSending(false);
    }
  };

  if (loading) return <Loading message="Loading contractor text records..." />;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-black text-gray-950">Text Contractors</h3>
            <p className="mt-1 text-xs font-semibold text-gray-500">{connectedCount} connected to this project / {contractors.length} total contractors</p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-100 bg-amber-50 px-2.5 py-1 text-xs font-black text-amber-800">
            <MessageSquare className="h-3.5 w-3.5" />
            SMS TBD
          </span>
        </div>

        <label className="mb-1 block text-xs font-black uppercase tracking-wide text-gray-500">Contractor</label>
        <select
          value={selectedContractorId}
          onChange={event => setSelectedContractorId(event.target.value)}
          className="w-full rounded-lg border border-gray-300 bg-white px-3.5 py-2.5 text-sm font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {orderedContractors.map(contractor => (
            <option key={contractor.id} value={contractor.id}>
              {isConnectedToProject(contractor) ? 'Project contractor - ' : 'All contractors - '}
              {contractorDisplayName(contractor)} - {contractor.phone || 'No phone'}
            </option>
          ))}
        </select>

        {selectedContractor ? (
          <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-black text-gray-950">{contractorDisplayName(selectedContractor)}</span>
              <span className="rounded-full bg-white px-2 py-0.5 text-xs font-black text-amber-800 ring-1 ring-amber-100">{contractorTypeLabel(selectedContractor)}</span>
              {isConnectedToProject(selectedContractor) && (
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-black text-emerald-700 ring-1 ring-emerald-100">Connected to project</span>
              )}
            </div>
            <div className="mt-2 grid gap-2 text-sm text-gray-700 sm:grid-cols-2">
              <div className="flex min-w-0 items-center gap-2">
                <Phone className="h-4 w-4 flex-shrink-0 text-gray-400" />
                <span className="truncate font-bold">{selectedContractor.phone || 'No phone on file'}</span>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <Building2 className="h-4 w-4 flex-shrink-0 text-gray-400" />
                <span className="truncate">{selectedContractor.contact_name || selectedContractor.email || 'No contact person listed'}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-3 rounded-xl border border-red-100 bg-red-50 p-3 text-sm font-bold text-red-700">No contractors are available to text.</div>
        )}

        <label className="mb-1 mt-4 block text-xs font-black uppercase tracking-wide text-gray-500">Office message</label>
        <textarea
          value={messageBody}
          onChange={event => setMessageBody(event.target.value)}
          rows={7}
          maxLength={2000}
          placeholder={`Message about ${project.address || 'this project'}...`}
          className="w-full resize-none rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm leading-6 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-xs font-semibold text-gray-500">{messageBody.length}/2000 characters</p>
          <button
            type="button"
            onClick={sendTextMessage}
            disabled={sending || !selectedContractor || !selectedContractor.phone || !messageBody.trim()}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-black text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
            {sending ? 'Saving...' : 'Send Text'}
          </button>
        </div>

        <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>Outbound texting is not enabled yet, so nothing is sent to the contractor. Every message here is safely saved to this project as an office record. Automatic sending turns on once an admin connects a text-message provider on the server &mdash; there is no in-app setup for this yet.</span>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-black text-gray-950">Text History</h3>
            <p className="mt-1 text-xs font-semibold text-gray-500">Project record for office-to-contractor messages</p>
          </div>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-black text-slate-700">{messages.length} records</span>
        </div>

        <div className="max-h-[660px] space-y-3 overflow-y-auto pr-2">
          {messages.map(message => {
            const statusMeta = textStatusMeta(message.status);
            return (
              <div key={message.id} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-gray-950">{message.contractor_name}</p>
                    <p className="mt-0.5 text-xs font-bold text-gray-500">{message.contractor_phone} / {message.sent_by_name}</p>
                  </div>
                  <div className="text-left sm:text-right">
                    <p className="text-xs font-black text-gray-900">{formatEasternDateTime(message.created_at, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
                    <span className={`mt-1 inline-flex rounded-full border px-2 py-0.5 text-xs font-black ${statusMeta.className}`}>{statusMeta.label}</span>
                  </div>
                </div>
                <p className="mt-3 whitespace-pre-wrap rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-800">{message.message_body}</p>
                {message.error_message && (
                  <p className="mt-2 text-xs font-semibold text-amber-800">{message.error_message}</p>
                )}
              </div>
            );
          })}
          {messages.length === 0 && (
            <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 py-12 text-center">
              <MessageSquare className="mx-auto mb-2 h-8 w-8 text-gray-300" />
              <p className="text-sm font-semibold text-gray-500">No contractor texts recorded for this project yet</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const fieldWorkStatusOptions = [
  { value: 'not_started', label: 'Not Started' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'waiting_materials', label: 'Waiting Materials' },
  { value: 'needs_review', label: 'Needs Review' },
  { value: 'completed', label: 'Completed' },
];

const fieldInvoiceStatusOptions = [
  { value: 'not_received', label: 'Invoice Not Received' },
  { value: 'received', label: 'Invoice Received' },
  { value: 'approval_needed', label: 'Approval Needed' },
  { value: 'approved_for_payment', label: 'Approved for Payment' },
  { value: 'paid', label: 'Paid' },
];

function fieldStatusLabel(value?: string) {
  return String(value || 'not_requested').replace(/_/g, ' ');
}

function FieldWorkStatusPanel({
  tasks,
  counts,
  canManage,
  onStatusChange,
  onApprove,
  onReview,
  onOpenScope,
}: {
  tasks: any[];
  counts: any;
  canManage: boolean;
  onStatusChange: (taskId: string, patch: Record<string, any>) => void;
  onApprove: (taskId: string) => void;
  onReview: (taskId: string, decision: string) => void;
  onOpenScope: () => void;
}) {
  const visibleTasks = tasks
    .filter(task => task.status !== 'completed' || task.invoice_status !== 'paid')
    .slice(0, 8);
  const approvalCount = Number(counts?.approvals_needed || 0);
  const holdCount = Number(counts?.invoice_holds || 0);

  return (
    <section className="rounded-xl border border-slate-300 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-black text-slate-950">Field Work Status</h3>
          <p className="mt-1 text-xs font-semibold text-slate-500">Scheduled work, field verification, and invoice readiness for this project.</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-black ${approvalCount + holdCount > 0 ? 'bg-red-50 text-red-700 ring-1 ring-red-200' : 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'}`}>
          {approvalCount + holdCount > 0 ? `${approvalCount + holdCount} check` : 'Clear'}
        </span>
      </div>

      {visibleTasks.length === 0 ? (
        <button
          type="button"
          onClick={onOpenScope}
          className="w-full rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-left text-sm font-semibold text-slate-600 hover:border-blue-300 hover:bg-blue-50"
        >
          No active field work items yet. Open Scope of Work to schedule HVAC, drywall, inspections, or other job tasks.
        </button>
      ) : (
        <div className="space-y-3">
          {visibleTasks.map(task => {
            const blocksPayment = Boolean(task.invoice_blocks_payment);
            return (
              <article key={task.id} className={`rounded-lg border p-3 ${blocksPayment ? 'border-red-200 bg-red-50' : task.verification_status === 'pending_review' ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-slate-50'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-slate-950">{task.title}</p>
                    <p className="mt-1 text-xs font-semibold text-slate-500">
                      {task.category || 'Field Work'}
                      {task.target_date ? ` - Due ${formatEasternDate(task.target_date, { month: 'short', day: 'numeric' })}` : ''}
                    </p>
                  </div>
                  {blocksPayment ? (
                    <span className="rounded-full bg-red-600 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-white">Payment Hold</span>
                  ) : (
                    <span className="rounded-full bg-white px-2 py-1 text-[10px] font-black uppercase tracking-wide text-slate-600 ring-1 ring-slate-200">{fieldStatusLabel(task.verification_status)}</span>
                  )}
                </div>

                <div className="mt-3 grid gap-2">
                  {task.latest_photo_note && (
                    <div className="rounded-md border border-blue-100 bg-white px-3 py-2 text-xs font-semibold text-slate-700">
                      <span className="block font-black uppercase tracking-wide text-blue-700">Latest photo description</span>
                      <span className="mt-1 block leading-5">{task.latest_photo_note}</span>
                    </div>
                  )}
                  {canManage ? (
                    <>
                      <label className="text-xs font-black uppercase tracking-wide text-slate-500">
                        Job status
                        <select
                          value={task.status || 'not_started'}
                          onChange={event => onStatusChange(task.id, { status: event.target.value })}
                          className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          {fieldWorkStatusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      </label>
                      <label className="text-xs font-black uppercase tracking-wide text-slate-500">
                        Invoice status
                        <select
                          value={task.invoice_status || 'not_received'}
                          onChange={event => onStatusChange(task.id, { invoice_status: event.target.value })}
                          className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          {fieldInvoiceStatusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      </label>
                      {task.verification_status !== 'approved' && (
                        <div className="grid gap-2 sm:grid-cols-2">
                          <button
                            type="button"
                            onClick={() => onApprove(task.id)}
                            className="inline-flex min-h-10 items-center justify-center rounded-md bg-emerald-600 px-3 text-sm font-black text-white hover:bg-emerald-700"
                          >
                            Approve Field Work
                          </button>
                          <button
                            type="button"
                            onClick={() => onReview(task.id, 'needs_correction')}
                            className="inline-flex min-h-10 items-center justify-center rounded-md bg-amber-600 px-3 text-sm font-black text-white hover:bg-amber-700"
                          >
                            Needs Correction
                          </button>
                          <button
                            type="button"
                            onClick={() => onReview(task.id, 'needs_work')}
                            className="inline-flex min-h-10 items-center justify-center rounded-md border border-amber-200 bg-white px-3 text-sm font-black text-amber-700 hover:bg-amber-50"
                          >
                            Needs Work
                          </button>
                          <button
                            type="button"
                            onClick={() => onReview(task.id, 'disapproved')}
                            className="inline-flex min-h-10 items-center justify-center rounded-md border border-red-200 bg-white px-3 text-sm font-black text-red-700 hover:bg-red-50"
                          >
                            Disapprove
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <span className="rounded-md bg-white px-2 py-2 font-bold text-slate-700 ring-1 ring-slate-200">{fieldStatusLabel(task.status)}</span>
                      <span className="rounded-md bg-white px-2 py-2 font-bold text-slate-700 ring-1 ring-slate-200">{fieldStatusLabel(task.verification_status)}</span>
                      <span className="rounded-md bg-white px-2 py-2 font-bold text-slate-700 ring-1 ring-slate-200">{fieldStatusLabel(task.invoice_status)}</span>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
          <button
            type="button"
            onClick={onOpenScope}
            className="text-sm font-black text-blue-600 hover:underline"
          >
            Open full Scope of Work
          </button>
        </div>
      )}
    </section>
  );
}

type ProjectTimelineRow = {
  id: string;
  kind: 'stage' | 'task' | 'material' | 'milestone';
  label: string;
  shortLabel: string;
  category: string;
  status: string;
  statusLabel: string;
  start: Date;
  end: Date;
  durationDays: number;
  owner?: string;
  detail?: string;
  progress: number;
  barClass: string;
  statusClass: string;
  children: ProjectTimelineRow[];
};

const TIMELINE_DAY_MS = 24 * 60 * 60 * 1000;

const standardRehabTimelineTemplate = [
  { id: 'scope', label: 'Scope, Walkthrough, and Final Bid Review', category: 'Planning', startOffset: 0, durationDays: 5, status: 'in_progress' },
  { id: 'procurement', label: 'Order Windows, Appliances, Cabinets, and Long-Lead Materials', category: 'Procurement', startOffset: 2, durationDays: 14, status: 'waiting_materials' },
  { id: 'demo', label: 'Demo, Trash Out, Site Protection, and Safety Setup', category: 'Site Work', startOffset: 4, durationDays: 7, status: 'not_started' },
  { id: 'rough', label: 'Rough Mechanical: Plumbing, Electrical, HVAC', category: 'MEP', startOffset: 10, durationDays: 12, status: 'not_started' },
  { id: 'exterior', label: 'Exterior, Windows, Doors, Roof, and Weather Tight Work', category: 'Exterior', startOffset: 15, durationDays: 14, status: 'not_started' },
  { id: 'drywall', label: 'Insulation, Drywall, Prime, and Paint', category: 'Interior Buildout', startOffset: 23, durationDays: 14, status: 'not_started' },
  { id: 'finishes', label: 'Flooring, Cabinets, Trim, Fixtures, and Appliances', category: 'Finishes', startOffset: 34, durationDays: 18, status: 'not_started' },
  { id: 'punch', label: 'Final Punch List, Clean, Photos, and Market Ready', category: 'Closeout', startOffset: 49, durationDays: 7, status: 'not_started' },
];

function parseTimelineDate(value: any) {
  if (!value) return null;
  if (value instanceof Date) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    date.setHours(0, 0, 0, 0);
    return date;
  }
  const text = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T00:00:00`)
    : new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

function addTimelineDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  next.setHours(0, 0, 0, 0);
  return next;
}

function daysBetween(start: Date, end: Date) {
  return Math.round((end.getTime() - start.getTime()) / TIMELINE_DAY_MS);
}

function clampTimelineValue(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function timelineDurationDays(start: Date, end: Date) {
  return Math.max(1, daysBetween(start, end) + 1);
}

function formatTimelineDate(date: Date, options: Intl.DateTimeFormatOptions = {}) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...options,
  }).format(date);
}

const timelineStatusMeta: Record<string, { label: string; statusClass: string; barClass: string; progress: number }> = {
  draft: {
    label: 'Draft',
    statusClass: 'border-slate-500/60 bg-slate-800 text-slate-100',
    barClass: 'border-slate-400/50 bg-gradient-to-r from-slate-700 via-slate-500 to-slate-400 text-white',
    progress: 5,
  },
  active: {
    label: 'Active',
    statusClass: 'border-sky-300/50 bg-sky-500/15 text-sky-100',
    barClass: 'border-sky-200/70 bg-gradient-to-r from-sky-700 via-cyan-500 to-blue-400 text-white',
    progress: 45,
  },
  not_started: {
    label: 'Not Started',
    statusClass: 'border-slate-500/60 bg-slate-800 text-slate-100',
    barClass: 'border-slate-400/50 bg-gradient-to-r from-slate-700 via-slate-500 to-slate-400 text-white',
    progress: 5,
  },
  in_progress: {
    label: 'In Progress',
    statusClass: 'border-cyan-300/50 bg-cyan-500/15 text-cyan-100',
    barClass: 'border-cyan-200/70 bg-gradient-to-r from-blue-700 via-cyan-500 to-sky-300 text-white',
    progress: 55,
  },
  waiting_materials: {
    label: 'Waiting Materials',
    statusClass: 'border-amber-300/60 bg-amber-500/15 text-amber-100',
    barClass: 'border-amber-200/80 bg-gradient-to-r from-amber-700 via-orange-500 to-amber-300 text-slate-950',
    progress: 35,
  },
  needs_review: {
    label: 'Needs Review',
    statusClass: 'border-fuchsia-300/50 bg-fuchsia-500/15 text-fuchsia-100',
    barClass: 'border-fuchsia-200/70 bg-gradient-to-r from-fuchsia-800 via-purple-500 to-fuchsia-300 text-white',
    progress: 85,
  },
  on_hold: {
    label: 'On Hold',
    statusClass: 'border-orange-300/60 bg-orange-500/15 text-orange-100',
    barClass: 'border-orange-200/80 bg-gradient-to-r from-orange-800 via-orange-500 to-amber-300 text-slate-950',
    progress: 30,
  },
  completed: {
    label: 'Complete',
    statusClass: 'border-emerald-300/50 bg-emerald-500/15 text-emerald-100',
    barClass: 'border-emerald-200/80 bg-gradient-to-r from-emerald-800 via-emerald-500 to-lime-300 text-slate-950',
    progress: 100,
  },
  delivered: {
    label: 'Delivered',
    statusClass: 'border-emerald-300/50 bg-emerald-500/15 text-emerald-100',
    barClass: 'border-emerald-200/80 bg-gradient-to-r from-emerald-800 via-emerald-500 to-lime-300 text-slate-950',
    progress: 100,
  },
  installed: {
    label: 'Installed',
    statusClass: 'border-emerald-300/50 bg-emerald-500/15 text-emerald-100',
    barClass: 'border-emerald-200/80 bg-gradient-to-r from-emerald-800 via-emerald-500 to-lime-300 text-slate-950',
    progress: 100,
  },
  ordered: {
    label: 'Ordered',
    statusClass: 'border-indigo-300/50 bg-indigo-500/15 text-indigo-100',
    barClass: 'border-indigo-200/70 bg-gradient-to-r from-indigo-800 via-indigo-500 to-sky-300 text-white',
    progress: 45,
  },
  quote_requested: {
    label: 'Quote Requested',
    statusClass: 'border-blue-300/50 bg-blue-500/15 text-blue-100',
    barClass: 'border-blue-200/70 bg-gradient-to-r from-blue-800 via-blue-500 to-cyan-300 text-white',
    progress: 20,
  },
  waiting: {
    label: 'Waiting',
    statusClass: 'border-amber-300/60 bg-amber-500/15 text-amber-100',
    barClass: 'border-amber-200/80 bg-gradient-to-r from-amber-700 via-orange-500 to-amber-300 text-slate-950',
    progress: 55,
  },
  planned: {
    label: 'Planned',
    statusClass: 'border-slate-500/60 bg-slate-800 text-slate-100',
    barClass: 'border-slate-400/50 bg-gradient-to-r from-slate-700 via-slate-500 to-slate-400 text-white',
    progress: 8,
  },
  cancelled: {
    label: 'Cancelled',
    statusClass: 'border-red-300/60 bg-red-500/15 text-red-100',
    barClass: 'border-red-200/70 bg-gradient-to-r from-red-900 via-red-600 to-red-400 text-white',
    progress: 0,
  },
};

function timelineMeta(status?: string) {
  return timelineStatusMeta[String(status || '').trim()] || timelineStatusMeta.not_started;
}

function makeTimelineRow(input: Omit<ProjectTimelineRow, 'durationDays' | 'statusLabel' | 'statusClass' | 'barClass' | 'progress' | 'children'> & { children?: ProjectTimelineRow[]; progress?: number }) {
  const meta = timelineMeta(input.status);
  const start = input.start;
  const end = input.end < input.start ? input.start : input.end;
  return {
    ...input,
    end,
    durationDays: timelineDurationDays(start, end),
    statusLabel: meta.label,
    statusClass: meta.statusClass,
    barClass: meta.barClass,
    progress: input.progress ?? meta.progress,
    children: input.children || [],
  };
}

function timelineStatusFromChildren(stageStatus: string, children: ProjectTimelineRow[]) {
  if (stageStatus === 'completed' || children.length && children.every(child => ['completed', 'delivered', 'installed'].includes(child.status))) return 'completed';
  if (stageStatus === 'on_hold' || children.some(child => ['waiting_materials', 'waiting', 'ordered'].includes(child.status))) return 'waiting_materials';
  if (children.some(child => ['needs_review'].includes(child.status))) return 'needs_review';
  if (stageStatus === 'active' || children.some(child => child.status === 'in_progress')) return 'in_progress';
  return stageStatus || 'not_started';
}

function buildProjectTimelineRows(project: any, scopes: any[], planItems: any[], materials: any[]) {
  const anchorDate = parseTimelineDate(project?.start_date || project?.acquisition_date || project?.created_at) || parseTimelineDate(new Date())!;
  const orderedScopes = [...scopes].sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0));
  const linkedItemIds = new Set<string>();
  const linkedMaterialIds = new Set<string>();

  if (!orderedScopes.length && !planItems.length && !materials.length) {
    return standardRehabTimelineTemplate.map((template, index) => makeTimelineRow({
      id: `template-${template.id}`,
      kind: 'stage',
      label: template.label,
      shortLabel: `Phase ${index + 1}`,
      category: template.category,
      status: template.status,
      start: addTimelineDays(anchorDate, template.startOffset),
      end: addTimelineDays(anchorDate, template.startOffset + template.durationDays - 1),
      owner: 'Project Manager',
      detail: 'Template stage. Add Scope of Work line items to turn this into a live project schedule.',
    }));
  }

  const stages: ProjectTimelineRow[] = orderedScopes.map((scope, scopeIndex) => {
    const scopeItems = planItems
      .filter(item => String(item.project_scope_id || '') === String(scope.id))
      .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0));
    scopeItems.forEach(item => linkedItemIds.add(String(item.id)));
    const fallbackStart = addTimelineDays(anchorDate, scopeIndex * 7);
    const scopeTimelineStart = parseTimelineDate(scope.timeline_start);
    const scopeTimelineEnd = parseTimelineDate(scope.timeline_end);

    const taskRows = scopeItems.map((item, itemIndex) => {
      const itemStart = parseTimelineDate(item.start_date || item.target_date) || addTimelineDays(fallbackStart, itemIndex * 3);
      const itemEnd = parseTimelineDate(item.target_date || item.start_date) || addTimelineDays(itemStart, 2);
      const row = makeTimelineRow({
        id: `task-${item.id}`,
        kind: 'task',
        label: item.title || 'Construction task',
        shortLabel: item.title || 'Task',
        category: item.category || scope.section_name || 'Field Work',
        status: item.status || 'not_started',
        start: itemStart,
        end: itemEnd,
        owner: item.assigned_to_name || 'Unassigned',
        detail: item.description || item.approval_notes || '',
      });
      return row;
    });

    const itemIds = new Set(scopeItems.map(item => String(item.id)));
    const materialRows = materials
      .filter(material => itemIds.has(String(material.plan_item_id || '')))
      .map((material, materialIndex) => {
        linkedMaterialIds.add(String(material.id));
        const linkedTask = scopeItems.find(item => String(item.id) === String(material.plan_item_id));
        const materialDate = parseTimelineDate(material.needed_by || material.expected_delivery || material.delivered_at || linkedTask?.target_date || linkedTask?.start_date) || addTimelineDays(fallbackStart, materialIndex * 2);
        const materialEnd = parseTimelineDate(material.expected_delivery || material.delivered_at || material.needed_by) || addTimelineDays(materialDate, 1);
        return makeTimelineRow({
          id: `material-${material.id}`,
          kind: 'material',
          label: material.material_name || 'Material order',
          shortLabel: material.material_name || 'Material',
          category: material.category || 'Materials',
          status: material.order_status || 'planned',
          start: materialDate,
          end: materialEnd,
          owner: material.supplier || 'Supplier TBD',
          detail: [material.plan_item_title, material.notes].filter(Boolean).join(' / '),
        });
      });

    const children = [...taskRows, ...materialRows].sort((left, right) => left.start.getTime() - right.start.getTime());
    const childStart = children.length ? new Date(Math.min(...children.map(child => child.start.getTime()))) : null;
    const childEnd = children.length ? new Date(Math.max(...children.map(child => child.end.getTime()))) : null;
    const stageStart = scopeTimelineStart || childStart || fallbackStart;
    const requestedStageEnd = scopeTimelineEnd || childEnd || addTimelineDays(stageStart, 6);
    const stageEnd = requestedStageEnd < stageStart ? stageStart : requestedStageEnd;
    const stageStatus = timelineStatusFromChildren(scope.status || 'active', children);
    const completeChildren = children.filter(child => ['completed', 'delivered', 'installed'].includes(child.status)).length;
    const stageProgress = stageStatus === 'completed'
      ? 100
      : children.length ? Math.round((completeChildren / children.length) * 100) : timelineMeta(stageStatus).progress;

    return makeTimelineRow({
      id: `scope-${scope.id}`,
      kind: 'stage',
      label: scope.scope_title || scope.section_name || `Stage ${scopeIndex + 1}`,
      shortLabel: scope.section_name || `Stage ${scopeIndex + 1}`,
      category: scope.section_name || 'Scope of Work',
      status: stageStatus,
      start: stageStart,
      end: stageEnd,
      owner: 'Project Manager',
      detail: scope.scope_of_work || '',
      progress: stageProgress,
      children,
    });
  });

  const unassignedTasks = planItems
    .filter(item => !linkedItemIds.has(String(item.id)))
    .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0));
  if (unassignedTasks.length) {
    const taskRows = unassignedTasks.map((item, index) => {
      const start = parseTimelineDate(item.start_date || item.target_date) || addTimelineDays(anchorDate, index * 3);
      const end = parseTimelineDate(item.target_date || item.start_date) || addTimelineDays(start, 2);
      return makeTimelineRow({
        id: `task-unassigned-${item.id}`,
        kind: 'task',
        label: item.title || 'Construction task',
        shortLabel: item.title || 'Task',
        category: item.category || 'Field Work',
        status: item.status || 'not_started',
        start,
        end,
        owner: item.assigned_to_name || 'Unassigned',
        detail: item.description || item.approval_notes || '',
      });
    });
    const stageStatus = timelineStatusFromChildren('active', taskRows);
    stages.push(makeTimelineRow({
      id: 'unassigned-work',
      kind: 'stage',
      label: 'Unassigned Construction Line Items',
      shortLabel: 'Unassigned Work',
      category: 'Field Work',
      status: stageStatus,
      start: new Date(Math.min(...taskRows.map(row => row.start.getTime()))),
      end: new Date(Math.max(...taskRows.map(row => row.end.getTime()))),
      owner: 'Project Manager',
      detail: 'Construction-plan items not connected to a scope section yet.',
      children: taskRows,
    }));
  }

  const unlinkedMaterials = materials.filter(material => !linkedMaterialIds.has(String(material.id)));
  if (unlinkedMaterials.length) {
    const materialRows = unlinkedMaterials.map((material, index) => {
      const start = parseTimelineDate(material.needed_by || material.expected_delivery || material.delivered_at) || addTimelineDays(anchorDate, index * 2);
      const end = parseTimelineDate(material.expected_delivery || material.delivered_at || material.needed_by) || addTimelineDays(start, 1);
      return makeTimelineRow({
        id: `material-unlinked-${material.id}`,
        kind: 'material',
        label: material.material_name || 'Material order',
        shortLabel: material.material_name || 'Material',
        category: material.category || 'Procurement',
        status: material.order_status || 'planned',
        start,
        end,
        owner: material.supplier || 'Supplier TBD',
        detail: [material.plan_item_title, material.notes].filter(Boolean).join(' / '),
      });
    });
    stages.unshift(makeTimelineRow({
      id: 'procurement-materials',
      kind: 'stage',
      label: 'Procurement and Long-Lead Materials',
      shortLabel: 'Procurement',
      category: 'Materials',
      status: timelineStatusFromChildren('active', materialRows),
      start: new Date(Math.min(...materialRows.map(row => row.start.getTime()))),
      end: new Date(Math.max(...materialRows.map(row => row.end.getTime()))),
      owner: 'Project Manager',
      detail: 'Project materials that are not attached to a specific construction line yet.',
      children: materialRows,
    }));
  }

  return stages.sort((left, right) => left.start.getTime() - right.start.getTime());
}

function timelineGridPosition(row: ProjectTimelineRow, windowStart: Date, weekCount: number) {
  const rawStart = Math.floor(daysBetween(windowStart, row.start) / 7) + 1;
  const rawEnd = Math.ceil((daysBetween(windowStart, row.end) + 1) / 7) + 1;
  const start = clampTimelineValue(rawStart, 1, weekCount);
  const end = clampTimelineValue(rawEnd, start + 1, weekCount + 1);
  return { start, span: Math.max(1, end - start) };
}

function rowOverlapsWindow(row: ProjectTimelineRow, windowStart: Date, windowEnd: Date) {
  return row.end >= windowStart && row.start <= windowEnd;
}

function ProjectTimelineTab({ projectId, project, canManage, canDelete }: { projectId: string; project: any; canManage: boolean; canDelete: boolean }) {
  const [scopes, setScopes] = useState<any[]>([]);
  const [planItems, setPlanItems] = useState<any[]>([]);
  const [materials, setMaterials] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [timelineMode, setTimelineMode] = useState<'full' | 'lookahead'>('full');
  const [reloadNonce, setReloadNonce] = useState(0);
  const [showAddTask, setShowAddTask] = useState(false);
  const [savingTask, setSavingTask] = useState(false);
  const [deletingScopeId, setDeletingScopeId] = useState<string | null>(null);
  const emptyTaskForm = { scope_title: '', section_name: '', status: 'active', timeline_start: '', timeline_end: '' };
  const [taskForm, setTaskForm] = useState(emptyTaskForm);

  useEffect(() => {
    let active = true;
    const loadTimeline = async () => {
      setLoading(true);
      try {
        const [scopeRes, planRes, materialRes] = await Promise.all([
          api.get(`/projects/${projectId}/scopes`),
          api.get(`/projects/${projectId}/construction-plan`),
          api.get(`/projects/${projectId}/materials`),
        ]);
        if (!active) return;
        setScopes(Array.isArray(scopeRes.data?.scopes) ? scopeRes.data.scopes : []);
        setPlanItems(Array.isArray(planRes.data?.items) ? planRes.data.items : []);
        setMaterials(Array.isArray(materialRes.data) ? materialRes.data : []);
      } catch (err: any) {
        if (active) toast.error(err.response?.data?.error || 'Failed to load project timeline');
      } finally {
        if (active) setLoading(false);
      }
    };
    loadTimeline();
    return () => { active = false; };
  }, [projectId, reloadNonce]);

  const handleAddTimelineTask = async () => {
    const title = taskForm.scope_title.trim();
    if (!title) { toast.error('Enter a task type / name'); return; }
    if (!taskForm.timeline_start || !taskForm.timeline_end) { toast.error('Enter a start and end date for the time frame'); return; }
    if (taskForm.timeline_end < taskForm.timeline_start) { toast.error('End date cannot be before the start date'); return; }
    setSavingTask(true);
    try {
      await api.post(`/projects/${projectId}/scopes`, {
        scope_title: title,
        section_name: taskForm.section_name.trim() || 'Timeline',
        scope_of_work: '',
        status: taskForm.status,
        timeline_start: taskForm.timeline_start,
        timeline_end: taskForm.timeline_end,
      });
      toast.success('Timeline task added');
      setTaskForm(emptyTaskForm);
      setShowAddTask(false);
      setReloadNonce(n => n + 1);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to add timeline task');
    } finally {
      setSavingTask(false);
    }
  };

  // Map any real (record-backed) timeline row to its delete endpoint. Returns
  // null for synthetic rows (template phases, "Unassigned"/"Procurement"
  // container stages) that are not backed by a deletable record.
  const timelineRowDeletePath = (row: ProjectTimelineRow): string | null => {
    const rid = row.id;
    if (rid.startsWith('scope-')) return `scopes/${rid.slice(6)}`;
    if (rid.startsWith('task-unassigned-')) return `construction-plan/${rid.slice('task-unassigned-'.length)}`;
    if (rid.startsWith('task-')) return `construction-plan/${rid.slice(5)}`;
    if (rid.startsWith('material-unlinked-')) return `materials/${rid.slice('material-unlinked-'.length)}`;
    if (rid.startsWith('material-')) return `materials/${rid.slice(9)}`;
    return null;
  };

  const handleDeleteTimelineRow = async (row: ProjectTimelineRow) => {
    const path = timelineRowDeletePath(row);
    if (!path) return;
    if (!window.confirm(`Delete timeline item "${row.label}"? This removes it from the schedule.`)) return;
    setDeletingScopeId(row.id);
    try {
      await api.delete(`/projects/${projectId}/${path}`);
      toast.success('Timeline item deleted');
      setReloadNonce(n => n + 1);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to delete timeline item');
    } finally {
      setDeletingScopeId(null);
    }
  };

  const timelineRows = useMemo(
    () => buildProjectTimelineRows(project, scopes, planItems, materials),
    [project, scopes, planItems, materials]
  );

  const flatRows = useMemo(() => timelineRows.flatMap(row => [row, ...row.children]), [timelineRows]);
  const today = useMemo(() => parseTimelineDate(new Date())!, []);
  const fullWindowStart = useMemo(() => {
    const dates = flatRows.flatMap(row => [row.start, row.end]);
    const projectStart = parseTimelineDate(project?.start_date || project?.acquisition_date || project?.created_at);
    if (projectStart) dates.push(projectStart);
    return dates.length ? new Date(Math.min(...dates.map(date => date.getTime()))) : today;
  }, [flatRows, project, today]);
  const fullWindowEnd = useMemo(() => {
    const dates = flatRows.flatMap(row => [row.start, row.end]);
    const target = parseTimelineDate(project?.target_completion);
    if (target) dates.push(target);
    return dates.length ? new Date(Math.max(...dates.map(date => date.getTime()))) : addTimelineDays(fullWindowStart, 83);
  }, [flatRows, fullWindowStart, project]);
  const fullWeekCount = clampTimelineValue(Math.ceil((daysBetween(fullWindowStart, fullWindowEnd) + 1) / 7), 8, 16);
  const windowStart = timelineMode === 'lookahead' ? today : fullWindowStart;
  const weekCount = timelineMode === 'lookahead' ? 4 : fullWeekCount;
  const windowEnd = addTimelineDays(windowStart, weekCount * 7 - 1);
  const timelineWeeks = Array.from({ length: weekCount }, (_, index) => addTimelineDays(windowStart, index * 7));
  const visibleRows = timelineMode === 'lookahead'
    ? timelineRows
        .map(stage => ({
          ...stage,
          children: stage.children.filter(child => rowOverlapsWindow(child, windowStart, windowEnd)),
        }))
        .filter(stage => rowOverlapsWindow(stage, windowStart, windowEnd) || stage.children.length)
    : timelineRows;
  const completedCount = flatRows.filter(row => ['completed', 'delivered', 'installed'].includes(row.status)).length;
  const waitingCount = flatRows.filter(row => ['waiting_materials', 'waiting', 'ordered', 'quote_requested'].includes(row.status)).length;
  const reviewCount = flatRows.filter(row => row.status === 'needs_review').length;
  const projectStartLabel = project?.start_date
    ? formatEasternDate(project.start_date, { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Start date not set';
  const targetLabel = project?.target_completion
    ? formatEasternDate(project.target_completion, { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Target date not set';
  const gridTemplateColumns = `repeat(${weekCount}, minmax(82px, 1fr))`;

  const renderTimelineRow = (row: ProjectTimelineRow, index: number, nested = false) => {
    const position = timelineGridPosition(row, windowStart, weekCount);
    const startLabel = formatTimelineDate(row.start);
    const endLabel = formatTimelineDate(row.end);
    const rowHeightClass = nested ? 'min-h-[46px]' : 'min-h-[58px]';
    const isComplete = ['completed', 'delivered', 'installed'].includes(row.status) || row.progress >= 100;
    return (
      <div key={row.id} className={`grid grid-cols-[330px_minmax(760px,1fr)] ${nested ? 'bg-slate-950/55' : 'bg-slate-900/70'}`}>
        <div className={`border-t border-cyan-300/15 px-3 py-2 ${rowHeightClass}`}>
          <div className="flex min-w-0 items-start gap-2">
            <span className={`inline-flex h-7 min-w-7 items-center justify-center rounded-lg border text-[11px] font-black ${nested ? 'border-white/10 bg-white/10 text-slate-200' : 'border-cyan-300/40 bg-cyan-400/15 text-cyan-100'}`}>
              {nested ? row.kind === 'material' ? 'M' : 'T' : index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className={`truncate font-black ${nested ? 'text-xs text-slate-100' : 'text-sm text-white'}`}>{row.label}</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-black capitalize ${row.statusClass}`}>{row.statusLabel}</span>
                {isComplete && (
                  <span className="rounded-full border border-emerald-200/80 bg-emerald-300 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-slate-950 shadow-sm">100% Complete</span>
                )}
                <span className="rounded-full border border-white/10 bg-white/10 px-2 py-0.5 text-[10px] font-black text-slate-200">{row.category}</span>
                <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{startLabel} - {endLabel}</span>
              </div>
            </div>
            {canDelete && timelineRowDeletePath(row) && (
              <button
                type="button"
                onClick={() => handleDeleteTimelineRow(row)}
                disabled={deletingScopeId === row.id}
                title="Delete this timeline item"
                aria-label={`Delete timeline item ${row.label}`}
                className="flex-shrink-0 rounded-lg border border-red-400/40 bg-red-500/15 p-1.5 text-red-200 transition hover:bg-red-500/30 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className={`relative border-t border-cyan-300/15 px-2 py-2 ${rowHeightClass}`}>
          <div className="absolute inset-0 grid" style={{ gridTemplateColumns }}>
            {timelineWeeks.map(week => (
              <div key={`${row.id}-${week.toISOString()}`} className="border-l border-cyan-300/10 first:border-l-0" />
            ))}
          </div>
          <div className="relative grid h-full items-center" style={{ gridTemplateColumns }}>
            <div
              className={`flex h-7 min-w-0 items-center overflow-hidden rounded-lg border px-2 text-[11px] font-black shadow-[0_10px_24px_rgba(2,6,23,0.35)] ${row.barClass}`}
              style={{ gridColumn: `${position.start} / span ${position.span}` }}
              title={`${row.label} / ${startLabel} - ${endLabel} / ${row.statusLabel} / ${row.progress}% complete`}
            >
              <span className="truncate">{row.shortLabel}</span>
              {isComplete && <span className="ml-auto rounded-full bg-white/85 px-1.5 py-0.5 text-[10px] font-black text-emerald-950">100%</span>}
            </div>
          </div>
        </div>
      </div>
    );
  };

  if (loading) return <Loading message="Loading project timeline..." />;

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-2xl border border-cyan-300/35 bg-gradient-to-br from-slate-950 via-blue-950 to-slate-900 text-white shadow-[0_22px_60px_rgba(2,6,23,0.45)] ring-1 ring-cyan-300/10">
        <div className="border-b border-cyan-300/20 bg-gradient-to-r from-slate-950 via-indigo-950 to-slate-950 p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-300/35 bg-cyan-400/15 px-3 py-1 text-[11px] font-black uppercase tracking-wide text-cyan-100">
                  <CalendarDays className="h-3.5 w-3.5" />
                  Project Only
                </span>
                <span
                  title="Project-only schedule. These timeline tasks stay on this project and do not appear on the shared dashboard Operations Calendar. To place a specific item on the Operations Calendar, use the 'Add to Calendar' button in this project's Notes / Overview section."
                  className="inline-flex cursor-help rounded-full border border-white/10 bg-white/10 px-3 py-1 text-[11px] font-black uppercase tracking-wide text-slate-200"
                >
                  Project-only schedule
                </span>
              </div>
              <h3 className="text-2xl font-black tracking-tight text-white">Project Timeline</h3>
              <p className="mt-1 max-w-4xl text-sm font-semibold leading-6 text-blue-100">
                Rehab schedule for {project?.address || project?.job_name || 'this project'} showing stage sequence, construction line items, material ordering, and near-term work.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {[
                { id: 'full' as const, label: 'Full Timeline' },
                { id: 'lookahead' as const, label: '4-Week Lookahead' },
              ].map(option => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setTimelineMode(option.id)}
                  className={`inline-flex min-h-10 items-center justify-center rounded-xl border px-4 text-sm font-black transition-all duration-150 ${timelineMode === option.id ? 'border-cyan-200 bg-gradient-to-br from-blue-500 via-indigo-600 to-cyan-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_10px_20px_rgba(37,99,235,0.42)] ring-1 ring-cyan-200/50' : 'border-slate-600 bg-gradient-to-br from-slate-800 via-slate-950 to-blue-950 text-slate-100 hover:border-cyan-300 hover:from-slate-700 hover:via-blue-950 hover:to-cyan-950 hover:text-white'}`}
                >
                  {option.label}
                </button>
              ))}
              {canManage && (
                <button
                  type="button"
                  onClick={() => setShowAddTask(v => !v)}
                  className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-slate-600 bg-gradient-to-br from-slate-800 via-slate-950 to-blue-950 px-4 text-sm font-black text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.11),0_8px_16px_rgba(2,6,23,0.36)] transition-all duration-150 hover:border-cyan-300 hover:from-slate-700 hover:via-blue-950 hover:to-cyan-950 hover:text-white"
                >
                  <Plus className="h-4 w-4" />
                  Add Timeline Task
                </button>
              )}
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-4">
            {[
              { label: 'Project Start', value: projectStartLabel, tone: 'from-blue-950 to-slate-950 border-blue-300/30 text-blue-100' },
              { label: 'Target Completion', value: targetLabel, tone: 'from-emerald-950 to-slate-950 border-emerald-300/30 text-emerald-100' },
              { label: 'Active Schedule Items', value: String(Math.max(0, flatRows.length - completedCount)), tone: 'from-cyan-950 to-slate-950 border-cyan-300/30 text-cyan-100' },
              { label: 'Materials / Review Watch', value: String(waitingCount + reviewCount), tone: 'from-fuchsia-950 to-slate-950 border-fuchsia-300/30 text-fuchsia-100' },
            ].map(tile => (
              <div key={tile.label} className={`rounded-xl border bg-gradient-to-br p-3 shadow-inner ${tile.tone}`}>
                <p className="text-[11px] font-black uppercase tracking-wide opacity-80">{tile.label}</p>
                <p className="mt-1 truncate text-lg font-black text-white">{tile.value}</p>
              </div>
            ))}
          </div>
        </div>

        {showAddTask && canManage && (
          <div className="mx-4 mt-4 rounded-xl border border-emerald-300/40 bg-slate-950/70 p-4 shadow-inner">
            <div className="mb-3 flex items-center justify-between">
              <h4 className="text-sm font-black text-white">Add Timeline Task</h4>
              <button type="button" onClick={() => { setShowAddTask(false); setTaskForm(emptyTaskForm); }} className="rounded-lg px-2 py-1 text-xs font-black text-slate-300 hover:bg-white/10">Close</button>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <label className="xl:col-span-2">
                <span className="text-[11px] font-black uppercase tracking-wide text-slate-300">Task type / name</span>
                <input value={taskForm.scope_title} onChange={e => setTaskForm(f => ({ ...f, scope_title: e.target.value }))} placeholder="e.g. Demo, Rough Plumbing, Drywall" className="mt-1 w-full rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-sm font-bold text-white placeholder:text-slate-400 outline-none focus:border-emerald-300" />
              </label>
              <label>
                <span className="text-[11px] font-black uppercase tracking-wide text-slate-300">Phase (optional)</span>
                <input value={taskForm.section_name} onChange={e => setTaskForm(f => ({ ...f, section_name: e.target.value }))} placeholder="e.g. MEP" className="mt-1 w-full rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-sm font-bold text-white placeholder:text-slate-400 outline-none focus:border-emerald-300" />
              </label>
              <label>
                <span className="text-[11px] font-black uppercase tracking-wide text-slate-300">Start date</span>
                <input type="date" value={taskForm.timeline_start} onChange={e => setTaskForm(f => ({ ...f, timeline_start: e.target.value }))} className="mt-1 w-full rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-sm font-bold text-white outline-none focus:border-emerald-300" />
              </label>
              <label>
                <span className="text-[11px] font-black uppercase tracking-wide text-slate-300">End date</span>
                <input type="date" value={taskForm.timeline_end} onChange={e => setTaskForm(f => ({ ...f, timeline_end: e.target.value }))} className="mt-1 w-full rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-sm font-bold text-white outline-none focus:border-emerald-300" />
              </label>
              <label>
                <span className="text-[11px] font-black uppercase tracking-wide text-slate-300">Status</span>
                <select value={taskForm.status} onChange={e => setTaskForm(f => ({ ...f, status: e.target.value }))} className="mt-1 w-full rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-sm font-bold text-white outline-none focus:border-emerald-300">
                  <option value="active">Active</option>
                  <option value="draft">Draft</option>
                  <option value="on_hold">On Hold</option>
                  <option value="completed">Completed</option>
                </select>
              </label>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => { setShowAddTask(false); setTaskForm(emptyTaskForm); }} className="rounded-lg border border-white/15 bg-white/10 px-4 py-2 text-sm font-black text-slate-100 hover:bg-white/15">Cancel</button>
              <button type="button" onClick={handleAddTimelineTask} disabled={savingTask} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-gradient-to-br from-slate-800 via-slate-950 to-blue-950 px-4 py-2 text-sm font-black text-slate-100 transition-all duration-150 hover:border-cyan-300 hover:text-white disabled:opacity-60">
                <Plus className="h-4 w-4" />
                {savingTask ? 'Adding...' : 'Add Task'}
              </button>
            </div>
          </div>
        )}

        <div className="p-4">
          <div className="min-w-0 overflow-hidden rounded-xl border border-cyan-300/25 bg-slate-950/45 shadow-[0_16px_42px_rgba(2,6,23,0.35)]">
            <div className="overflow-x-auto">
              <div className="min-w-[1120px]">
                <div className="grid grid-cols-[330px_minmax(760px,1fr)] border-b border-cyan-300/20 bg-slate-950">
                  <div className="px-3 py-3">
                    <p className="text-[11px] font-black uppercase tracking-wide text-cyan-200">Stage / Task</p>
                    <p className="mt-1 text-xs font-semibold text-slate-400">Status, dates, and responsibility</p>
                  </div>
                  <div className="grid" style={{ gridTemplateColumns }}>
                    {timelineWeeks.map((week, index) => (
                      <div key={week.toISOString()} className="border-l border-cyan-300/15 px-2 py-3 first:border-l-0">
                        <p className="text-[10px] font-black uppercase tracking-wide text-cyan-200">Week {index + 1}</p>
                        <p className="mt-1 text-xs font-black text-white">{formatTimelineDate(week)}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {visibleRows.length ? visibleRows.map((stage, index) => (
                  <div key={stage.id}>
                    {renderTimelineRow(stage, index)}
                    {stage.children.map(child => renderTimelineRow(child, index, true))}
                  </div>
                )) : (
                  <div className="px-4 py-12 text-center text-sm font-semibold text-slate-300">
                    No tasks fall inside this lookahead window.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

type ProjectScopeForm = {
  section_name: string;
  scope_title: string;
  scope_of_work: string;
  status: string;
  timeline_start: string;
  timeline_end: string;
};

type BulkProjectScopeRow = ProjectScopeForm & {
  rowId: string;
};

type VendorQuoteForm = {
  contractor_profile_id: string;
  vendor_name: string;
  vendor_email: string;
  vendor_phone: string;
  message: string;
  expires_in_days: string;
  include_photos: boolean;
  send_email: boolean;
  send_text: boolean;
};

const blankProjectScopeForm: ProjectScopeForm = {
  section_name: '',
  scope_title: '',
  scope_of_work: '',
  status: 'active',
  timeline_start: '',
  timeline_end: '',
};

const blankVendorQuoteForm: VendorQuoteForm = {
  contractor_profile_id: '',
  vendor_name: '',
  vendor_email: '',
  vendor_phone: '',
  message: '',
  expires_in_days: '7',
  include_photos: true,
  send_email: true,
  send_text: false,
};

let bulkScopeRowCounter = 0;

const createBulkScopeRow = (): BulkProjectScopeRow => ({
  ...blankProjectScopeForm,
  rowId: `bulk-scope-${Date.now()}-${bulkScopeRowCounter += 1}`,
});

const createBulkScopeRows = (count: number) => Array.from({ length: count }, createBulkScopeRow);

function scopeTimelineRangeLabel(scope: any) {
  const start = scope?.timeline_start ? formatEasternDate(scope.timeline_start, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const end = scope?.timeline_end ? formatEasternDate(scope.timeline_end, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  if (start && end) return `${start} - ${end}`;
  if (start) return `Starts ${start}`;
  if (end) return `Due ${end}`;
  return '';
}

function ScopeOfWorkTab({ projectId, project, canManage }: { projectId: string; project: any; canManage: boolean }) {
  const [scopes, setScopes] = useState<any[]>([]);
  const [legacyScope, setLegacyScope] = useState('');
  const [loading, setLoading] = useState(true);
  const [showEditor, setShowEditor] = useState(false);
  const [showBulkEditor, setShowBulkEditor] = useState(false);
  const [editingScope, setEditingScope] = useState<any | null>(null);
  const [scopeForm, setScopeForm] = useState<ProjectScopeForm>(blankProjectScopeForm);
  const [bulkScopeRows, setBulkScopeRows] = useState<BulkProjectScopeRow[]>(() => createBulkScopeRows(5));
  const [savingScope, setSavingScope] = useState(false);
  const [savingBulkScopes, setSavingBulkScopes] = useState(false);
  const [scopeDictationStatus, setScopeDictationStatus] = useState<DictationStatus>('idle');
  const [scopeAttachments, setScopeAttachments] = useState<File[]>([]);
  const [selectedScopePhotoIds, setSelectedScopePhotoIds] = useState<string[]>([]);
  const [selectedScopePhotos, setSelectedScopePhotos] = useState<any[]>([]);
  const [scopePhotoPicker, setScopePhotoPicker] = useState<any | null>(null);
  const [showVendorQuoteModal, setShowVendorQuoteModal] = useState(false);
  const [vendorQuoteForm, setVendorQuoteForm] = useState<VendorQuoteForm>(() => blankVendorQuoteForm);
  const [vendorQuoteContractorIds, setVendorQuoteContractorIds] = useState<string[]>([]);
  const [vendorQuoteScopeIds, setVendorQuoteScopeIds] = useState<string[]>([]);
  const [sendingVendorQuote, setSendingVendorQuote] = useState(false);
  const [quoteContractors, setQuoteContractors] = useState<ContractorDirectoryRow[]>([]);
  const [loadingQuoteContractors, setLoadingQuoteContractors] = useState(false);
  const [quoteContractorSearch, setQuoteContractorSearch] = useState('');
  const [planItems, setPlanItems] = useState<any[]>([]);
  const [materials, setMaterials] = useState<any[]>([]);
  const [expandedScopeIds, setExpandedScopeIds] = useState<Set<string>>(() => new Set());
  const [scopeLightbox, setScopeLightbox] = useState<ProgressLightboxState | null>(null);
  const [draggingScopeId, setDraggingScopeId] = useState<string | null>(null);
  const [scopeDropTarget, setScopeDropTarget] = useState<{ id: string; position: 'before' | 'after' } | null>(null);
  const [reorderingScope, setReorderingScope] = useState(false);
  const [showStepEditor, setShowStepEditor] = useState(false);
  const [showMaterialEditor, setShowMaterialEditor] = useState(false);
  const [editingStep, setEditingStep] = useState<any | null>(null);
  const [editingMaterial, setEditingMaterial] = useState<any | null>(null);
  const [activeMaterialScopeId, setActiveMaterialScopeId] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState<string | null>(null);
  const scopeAttachmentInputRef = useRef<HTMLInputElement | null>(null);
  const scopeRecognitionRef = useRef<any>(null);
  const scopeDictationBaseRef = useRef('');
  const scopeEditorFieldClass = 'bt-scope-editor-field w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';
  const listeningScope = scopeDictationStatus !== 'idle';
  const blankStepForm = {
    project_scope_id: '',
    title: '',
    category: '',
    description: '',
    status: 'not_started',
    verification_status: 'not_requested',
    invoice_status: 'not_received',
    start_date: '',
    target_date: '',
    approval_notes: '',
  };
  const blankMaterialForm = {
    plan_item_id: '',
    material_name: '',
    category: '',
    quantity: '',
    unit: '',
    estimated_cost: '',
    actual_cost: '',
    supplier: '',
    order_status: 'planned',
    needed_by: '',
    expected_delivery: '',
    delivered_at: '',
    notes: '',
  };
  const [stepForm, setStepForm] = useState(blankStepForm);
  const [materialForm, setMaterialForm] = useState(blankMaterialForm);

  const updateScopeFormField = (field: keyof ProjectScopeForm) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const value = event.currentTarget.value;
    setScopeForm(current => ({ ...current, [field]: value }));
  };

  const updateBulkScopeRow = (rowId: string, field: keyof ProjectScopeForm) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const value = event.currentTarget.value;
    setBulkScopeRows(current => current.map(row => row.rowId === rowId ? { ...row, [field]: value } : row));
  };

  const normalizeScopeDetails = () => {
    setScopeForm(current => ({ ...current, scope_of_work: scopeLineItemText(current.scope_of_work) }));
  };

  const keepScopeEditorTypingLocal = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' && event.key !== 'Tab') {
      event.stopPropagation();
    }
  };

  const scopeStatusColors: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-700',
    active: 'bg-blue-100 text-blue-700',
    on_hold: 'bg-amber-100 text-amber-700',
    completed: 'bg-green-100 text-green-700',
  };
  const scopeCardStyles = [
    {
      card: 'border-white/10 bg-slate-900/55 shadow-[0_10px_26px_rgba(0,0,0,0.35)]',
      accent: 'bg-white/15',
      number: 'bg-slate-700 text-white ring-white/15',
      section: 'border-white/15 bg-white/10 text-slate-200',
      hoverTitle: 'group-hover:text-white',
    },
  ];

  const loadScopes = async () => {
    try {
      const [scopeRes, planRes, materialRes] = await Promise.all([
        api.get(`/projects/${projectId}/scopes`),
        api.get(`/projects/${projectId}/construction-plan`),
        api.get(`/projects/${projectId}/materials`),
      ]);
      setScopes(Array.isArray(scopeRes.data?.scopes) ? scopeRes.data.scopes : []);
      setLegacyScope(scopeRes.data?.legacy_scope_of_work || '');
      setPlanItems(Array.isArray(planRes.data?.items) ? planRes.data.items : []);
      setMaterials(Array.isArray(materialRes.data) ? materialRes.data : []);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to load scopes of work');
    } finally {
      setLoading(false);
    }
  };

  const loadQuoteContractors = async () => {
    setLoadingQuoteContractors(true);
    try {
      const res = await api.get('/users/contractors/directory');
      setQuoteContractors(Array.isArray(res.data?.contractors) ? res.data.contractors : []);
    } catch {
      toast.error('Failed to load contractor list');
    } finally {
      setLoadingQuoteContractors(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    loadScopes();
  }, [projectId]);

  useEffect(() => {
    if (canManage) loadQuoteContractors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage]);

  useEffect(() => () => {
    scopeRecognitionRef.current?.stop?.();
    scopeRecognitionRef.current = null;
  }, []);

  const clearScopeAttachmentInput = () => {
    setScopeAttachments([]);
    if (scopeAttachmentInputRef.current) scopeAttachmentInputRef.current.value = '';
  };

  const closeScopeEditor = () => {
    const recognition = scopeRecognitionRef.current;
    scopeRecognitionRef.current = null;
    recognition?.stop?.();
    setScopeDictationStatus('idle');
    setShowEditor(false);
    setEditingScope(null);
    setScopeForm(blankProjectScopeForm);
    setSelectedScopePhotoIds([]);
    setSelectedScopePhotos([]);
    setScopePhotoPicker(null);
    clearScopeAttachmentInput();
  };

  const openAddScope = () => {
    setEditingScope(null);
    setScopeForm(blankProjectScopeForm);
    setSelectedScopePhotoIds([]);
    setSelectedScopePhotos([]);
    clearScopeAttachmentInput();
    setShowEditor(true);
  };

  const openBulkScopes = () => {
    setBulkScopeRows(createBulkScopeRows(5));
    setShowBulkEditor(true);
  };

  const closeBulkScopes = () => {
    if (savingBulkScopes) return;
    setShowBulkEditor(false);
    setBulkScopeRows(createBulkScopeRows(5));
  };

  const openVendorQuoteModal = (targetScope?: any) => {
    const defaultScopeIds = scopes
      .filter(scope => String(scope.status || 'active') !== 'completed')
      .map(scope => String(scope.id));
    const targetScopeId = targetScope?.id ? String(targetScope.id) : '';
    const publicProjectLabel = cityFromProjectAddress(project?.address) || 'this project';
    setVendorQuoteScopeIds(targetScopeId ? [targetScopeId] : (defaultScopeIds.length ? defaultScopeIds : scopes.map(scope => String(scope.id))));
    setVendorQuoteForm({
      ...blankVendorQuoteForm,
      message: targetScope
        ? `Please review the scope of work for ${targetScope.scope_title || targetScope.section_name || publicProjectLabel} and submit your price through this link.`
        : `Please review the selected scope of work for ${publicProjectLabel} and submit your price through this link.`,
    });
    setVendorQuoteContractorIds([]);
    setQuoteContractorSearch('');
    setShowVendorQuoteModal(true);
    if (!quoteContractors.length) loadQuoteContractors();
  };

  const closeVendorQuoteModal = () => {
    if (sendingVendorQuote) return;
    setShowVendorQuoteModal(false);
  };

  const updateVendorQuoteForm = (field: keyof VendorQuoteForm) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const value = ['include_photos', 'send_email', 'send_text'].includes(field)
      ? (event.currentTarget as HTMLInputElement).checked
      : event.currentTarget.value;
    setVendorQuoteForm(current => ({ ...current, [field]: value }));
  };

  const selectVendorQuoteContractor = (contractor: ContractorDirectoryRow) => {
    setVendorQuoteContractorIds(current => {
      const selected = current.includes(contractor.id);
      return selected ? current.filter(id => id !== contractor.id) : [...current, contractor.id];
    });
    setVendorQuoteForm(current => ({
      ...current,
      contractor_profile_id: contractor.id,
      vendor_name: contractorDisplayName(contractor),
      vendor_email: String(contractor.email || ''),
      vendor_phone: String(contractor.phone || ''),
      send_email: true,
      send_text: current.send_text || Boolean(contractor.phone),
    }));
  };

  const toggleVendorQuoteScope = (scopeId: string) => {
    setVendorQuoteScopeIds(current => {
      const next = new Set(current);
      if (next.has(scopeId)) next.delete(scopeId);
      else next.add(scopeId);
      return Array.from(next);
    });
  };

  const selectAllVendorQuoteScopes = () => {
    setVendorQuoteScopeIds(scopes.map(scope => String(scope.id)));
  };

  const clearVendorQuoteScopes = () => {
    setVendorQuoteScopeIds([]);
  };

  const sendVendorQuoteRequest = async () => {
    const selectedContractors = quoteContractors.filter(contractor => vendorQuoteContractorIds.includes(contractor.id));
    if (!selectedContractors.length) return toast.error('Select at least one contractor');
    if (!vendorQuoteForm.send_email && !vendorQuoteForm.send_text) return toast.error('Choose email, text, or both');
    if (selectedContractors.some(contractor => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(contractor.email || '')))) {
      return toast.error('Every selected contractor needs a valid email address');
    }
    if (vendorQuoteForm.send_text && selectedContractors.some(contractor => !String(contractor.phone || '').trim())) {
      return toast.error('Every selected contractor needs a phone number for text delivery');
    }
    if (!vendorQuoteScopeIds.length) return toast.error('Select at least one scope section');

    setSendingVendorQuote(true);
    try {
      const res = await api.post(`/vendor-quote-requests/projects/${projectId}`, {
        contractor_profile_ids: selectedContractors.map(contractor => contractor.id),
        message: vendorQuoteForm.message.trim(),
        expires_in_days: 7,
        include_photos: vendorQuoteForm.include_photos,
        send_email: vendorQuoteForm.send_email,
        send_text: vendorQuoteForm.send_text,
        scope_ids: vendorQuoteScopeIds,
      });
      const scopeCount = res.data?.request?.scope_count || vendorQuoteScopeIds.length;
      const delivery = res.data?.delivery || {};
      const recipientCount = res.data?.requests?.length || selectedContractors.length;
      const sentBy = [
        delivery.email_sent ? 'email' : '',
        vendorQuoteForm.send_text ? 'text' : '',
      ].filter(Boolean).join(' and ') || 'quote link';
      if (vendorQuoteForm.send_text && delivery.text_status === 'provider_not_configured') {
        toast.success(`Quote links created for ${recipientCount} contractor${recipientCount === 1 ? '' : 's'}; text provider is not configured, so texts were saved in history.`);
      } else {
        toast.success(`Quote links sent by ${sentBy} to ${recipientCount} contractor${recipientCount === 1 ? '' : 's'} with ${scopeCount} scope section${scopeCount === 1 ? '' : 's'}`);
      }
      setShowVendorQuoteModal(false);
      setVendorQuoteContractorIds([]);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to send vendor quote link');
    } finally {
      setSendingVendorQuote(false);
    }
  };

  const addBulkScopeRows = (count = 5) => {
    setBulkScopeRows(current => [...current, ...createBulkScopeRows(count)]);
  };

  const removeBulkScopeRow = (rowId: string) => {
    setBulkScopeRows(current => {
      const nextRows = current.filter(row => row.rowId !== rowId);
      return nextRows.length ? nextRows : createBulkScopeRows(1);
    });
  };

  const openEditScope = (scope: any) => {
    if (!canManage) return;
    setEditingScope(scope);
    setScopeForm({
      section_name: scope.section_name || '',
      scope_title: scope.scope_title || '',
      scope_of_work: scope.scope_of_work || '',
      status: scope.status || 'active',
      timeline_start: scope.timeline_start || '',
      timeline_end: scope.timeline_end || '',
    });
    setSelectedScopePhotos([]);
    setSelectedScopePhotoIds([]);
    clearScopeAttachmentInput();
    setShowEditor(true);
  };

  const setScopeAttachmentFiles = (files?: FileList | File[] | null) => {
    setScopeAttachments(Array.from(files || []));
  };

  const handleScopeAttachmentChange = (event: ChangeEvent<HTMLInputElement>) => {
    setScopeAttachmentFiles(event.currentTarget.files);
  };

  const startScopeDictation = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      toast.error('Microphone dictation is not supported in this browser');
      return;
    }

    scopeRecognitionRef.current?.stop?.();
    scopeRecognitionRef.current = null;
    scopeDictationBaseRef.current = scopeForm.scope_of_work;
    setScopeDictationStatus('starting');
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      if (scopeRecognitionRef.current === recognition) setScopeDictationStatus('listening');
    };
    recognition.onend = () => {
      if (scopeRecognitionRef.current === recognition) {
        setScopeDictationStatus('idle');
        scopeRecognitionRef.current = null;
      }
    };
    recognition.onerror = (event: any) => {
      if (scopeRecognitionRef.current === recognition) {
        setScopeDictationStatus('idle');
        scopeRecognitionRef.current = null;
      }
      if (event?.error !== 'aborted') toast.error('Microphone dictation stopped');
    };
    recognition.onresult = (event: any) => {
      const spokenText = getRecognitionTranscript(event.results);
      if (!spokenText) return;
      setScopeForm(current => ({
        ...current,
        scope_of_work: scopeLineItemText(appendDictationText(scopeDictationBaseRef.current, spokenText)),
      }));
    };
    scopeRecognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      scopeRecognitionRef.current = null;
      setScopeDictationStatus('idle');
      toast.error('Microphone dictation could not start');
    }
  };

  const stopScopeDictation = () => {
    const recognition = scopeRecognitionRef.current;
    scopeRecognitionRef.current = null;
    recognition?.stop?.();
    setScopeDictationStatus('idle');
  };

  const uploadScopeAttachments = async (scopeId: string) => {
    if (!scopeAttachments.length) return;
    const formData = new FormData();
    scopeAttachments.forEach(file => formData.append('documents', file));
    await api.post(`/projects/${projectId}/scopes/${scopeId}/estimate-documents`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  };

  const attachSelectedPhotosToScope = async (scopeId: string) => {
    const photoIds = Array.from(new Set(selectedScopePhotoIds.map(String).filter(Boolean)));
    if (!photoIds.length) return;
    await api.post(`/projects/${projectId}/photos/assignments`, {
      target_type: 'project_scope',
      target_id: scopeId,
      photo_ids: photoIds,
    });
  };

  const openScopeEditorPhotoPicker = () => {
    setScopePhotoPicker({
      mode: 'editor',
      title: editingScope ? `Photos for ${editingScope.scope_title}` : 'Select photos for this scope',
      initialSelectedIds: selectedScopePhotoIds,
    });
  };

  const openScopeAssignmentPhotoPicker = (scope: any) => {
    setScopePhotoPicker({
      mode: 'assign',
      targetType: 'project_scope',
      targetId: scope.id,
      title: `Attach photos to ${scope.scope_title || 'scope of work'}`,
      initialSelectedIds: [],
    });
  };

  const saveScopePhotoPickerSelection = async (photos: any[]) => {
    if (!scopePhotoPicker) return;
    const photoIds = photos.map(photo => String(photo.id)).filter(Boolean);
    if (scopePhotoPicker.mode === 'editor') {
      setSelectedScopePhotos(photos);
      setSelectedScopePhotoIds(photoIds);
      setScopePhotoPicker(null);
      return;
    }

    if (!photoIds.length) {
      setScopePhotoPicker(null);
      return;
    }

    try {
      await api.post(`/projects/${projectId}/photos/assignments`, {
        target_type: scopePhotoPicker.targetType,
        target_id: scopePhotoPicker.targetId,
        photo_ids: photoIds,
      });
      toast.success('Photos attached to scope');
      setScopePhotoPicker(null);
      await loadScopes();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to attach photos');
    }
  };

  const removeScopePhotoAssignment = async (assignmentId?: string | null) => {
    if (!assignmentId) return;
    try {
      await api.delete(`/projects/${projectId}/photos/assignments/${assignmentId}`);
      toast.success('Photo removed from this scope');
      await loadScopes();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to remove photo');
    }
  };

  const saveScope = async () => {
    if ((scopeForm.timeline_start && !scopeForm.timeline_end) || (!scopeForm.timeline_start && scopeForm.timeline_end)) {
      return toast.error('Enter both timeline start and completion dates');
    }
    if (scopeForm.timeline_start && scopeForm.timeline_end && scopeForm.timeline_end < scopeForm.timeline_start) {
      return toast.error('Timeline completion date cannot be before the start date');
    }
    const payload = {
      section_name: scopeForm.section_name.trim() || 'General',
      scope_title: scopeForm.scope_title.trim(),
      scope_of_work: scopeLineItemText(scopeForm.scope_of_work),
      status: scopeForm.status || 'active',
      timeline_start: scopeForm.timeline_start || null,
      timeline_end: scopeForm.timeline_end || null,
    };
    if (!payload.scope_title) return toast.error('Enter a scope title');

    setSavingScope(true);
    try {
      let scopeId = editingScope?.id;
      if (editingScope) {
        await api.put(`/projects/${projectId}/scopes/${editingScope.id}`, payload);
      } else {
        const res = await api.post(`/projects/${projectId}/scopes`, payload);
        scopeId = res.data?.id;
      }
      if (!scopeId) throw new Error('Scope was saved but no scope ID was returned');
      await uploadScopeAttachments(scopeId);
      await attachSelectedPhotosToScope(scopeId);
      const extraParts = [
        scopeAttachments.length ? `${scopeAttachments.length} estimate doc${scopeAttachments.length === 1 ? '' : 's'}` : '',
        selectedScopePhotoIds.length ? `${selectedScopePhotoIds.length} photo${selectedScopePhotoIds.length === 1 ? '' : 's'}` : '',
      ].filter(Boolean);
      toast.success(extraParts.length
        ? `Scope of work saved with ${extraParts.join(' and ')}`
        : editingScope ? 'Scope of work updated' : 'Scope of work added'
      );
      closeScopeEditor();
      loadScopes();
    } catch (err: any) {
      toast.error(err.response?.data?.error || err.message || 'Failed to save scope of work');
    } finally {
      setSavingScope(false);
    }
  };

  const saveBulkScopes = async () => {
    const enteredRows = bulkScopeRows
      .map((row, index) => ({ ...row, rowNumber: index + 1 }))
      .filter(row => row.scope_title.trim() || row.section_name.trim() || row.scope_of_work.trim() || row.timeline_start || row.timeline_end || row.status !== 'active');
    if (!enteredRows.length) return toast.error('Enter at least one scope title');
    const missingTitle = enteredRows.find(row => !row.scope_title.trim());
    if (missingTitle) return toast.error(`Enter a scope title on row ${missingTitle.rowNumber}`);
    const missingTimelinePair = enteredRows.find(row => (row.timeline_start && !row.timeline_end) || (!row.timeline_start && row.timeline_end));
    if (missingTimelinePair) return toast.error(`Enter both timeline dates on row ${missingTimelinePair.rowNumber}`);
    const invalidTimelineRow = enteredRows.find(row => row.timeline_start && row.timeline_end && row.timeline_end < row.timeline_start);
    if (invalidTimelineRow) return toast.error(`Timeline completion date cannot be before the start date on row ${invalidTimelineRow.rowNumber}`);

    setSavingBulkScopes(true);
    try {
      const payload = {
        scopes: enteredRows.map(row => ({
          row_number: row.rowNumber,
          scope_title: row.scope_title.trim(),
          section_name: row.section_name.trim() || 'General',
          scope_of_work: scopeLineItemText(row.scope_of_work),
          status: row.status || 'active',
          timeline_start: row.timeline_start || null,
          timeline_end: row.timeline_end || null,
        })),
      };
      const res = await api.post(`/projects/${projectId}/scopes/bulk`, payload);
      const count = Number(res.data?.count || payload.scopes.length);
      toast.success(`${count} scope ${count === 1 ? 'item' : 'items'} added`);
      setShowBulkEditor(false);
      setBulkScopeRows(createBulkScopeRows(5));
      loadScopes();
    } catch (err: any) {
      toast.error(err.response?.data?.error || err.message || 'Failed to save bulk scope of work');
    } finally {
      setSavingBulkScopes(false);
    }
  };

  const deleteScope = async () => {
    if (!editingScope) return;
    if (!window.confirm('Delete this scope of work?')) return;
    try {
      await api.delete(`/projects/${projectId}/scopes/${editingScope.id}`);
      closeScopeEditor();
      loadScopes();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to delete scope of work');
    }
  };

  const moveScope = async (scopeId: string, direction: 'up' | 'down') => {
    try {
      await api.post(`/projects/${projectId}/scopes/${scopeId}/move`, { direction });
      loadScopes();
    } catch {
      toast.error('Failed to reorder scope of work');
    }
  };

  const resetScopeDrag = () => {
    setDraggingScopeId(null);
    setScopeDropTarget(null);
  };

  const scopeDropPosition = (event: DragEvent<HTMLElement>): 'before' | 'after' => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
  };

  const dragScopeToPosition = async (sourceId: string, targetId: string, position: 'before' | 'after') => {
    if (!canManage || reorderingScope || sourceId === targetId) {
      resetScopeDrag();
      return;
    }
    const sourceIndex = scopes.findIndex(scope => String(scope.id) === sourceId);
    const targetIndex = scopes.findIndex(scope => String(scope.id) === targetId);
    if (sourceIndex < 0 || targetIndex < 0) {
      resetScopeDrag();
      return;
    }

    const originalScopes = scopes;
    const movingScope = scopes[sourceIndex];
    const withoutMoving = scopes.filter(scope => String(scope.id) !== sourceId);
    let insertIndex = withoutMoving.findIndex(scope => String(scope.id) === targetId);
    if (insertIndex < 0) {
      resetScopeDrag();
      return;
    }
    if (position === 'after') insertIndex += 1;

    const reorderedScopes = [
      ...withoutMoving.slice(0, insertIndex),
      movingScope,
      ...withoutMoving.slice(insertIndex),
    ].map((scope, index) => ({ ...scope, sort_order: index + 1 }));
    const originalOrder = originalScopes.map(scope => String(scope.id)).join('|');
    const nextOrder = reorderedScopes.map(scope => String(scope.id)).join('|');
    if (originalOrder === nextOrder) {
      resetScopeDrag();
      return;
    }

    setScopes(reorderedScopes);
    setReorderingScope(true);
    try {
      const res = await api.post(`/projects/${projectId}/scopes/reorder`, {
        scope_ids: reorderedScopes.map(scope => String(scope.id)),
      });
      if (Array.isArray(res.data?.scopes)) setScopes(res.data.scopes);
      toast.success('Scope order updated');
    } catch (err: any) {
      setScopes(originalScopes);
      toast.error(err.response?.data?.error || 'Failed to reorder scope of work');
    } finally {
      setReorderingScope(false);
      resetScopeDrag();
    }
  };

  const handleScopeDragStart = (event: DragEvent<HTMLElement>, scopeId: string) => {
    if (!canManage || reorderingScope) {
      event.preventDefault();
      return;
    }
    const nextScopeId = String(scopeId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', nextScopeId);
    setDraggingScopeId(nextScopeId);
  };

  const handleScopeDragOver = (event: DragEvent<HTMLElement>, targetId: string) => {
    if (!canManage || !draggingScopeId || String(targetId) === draggingScopeId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const position = scopeDropPosition(event);
    setScopeDropTarget(current => (
      current?.id === String(targetId) && current.position === position
        ? current
        : { id: String(targetId), position }
    ));
  };

  const handleScopeDrop = (event: DragEvent<HTMLElement>, targetId: string) => {
    if (!canManage) return;
    event.preventDefault();
    const sourceId = draggingScopeId || event.dataTransfer.getData('text/plain');
    if (!sourceId) {
      resetScopeDrag();
      return;
    }
    dragScopeToPosition(String(sourceId), String(targetId), scopeDropPosition(event));
  };

  const toggleScopeExpansion = (scopeId: string) => {
    setExpandedScopeIds(current => {
      const next = new Set(current);
      if (next.has(scopeId)) next.delete(scopeId);
      else next.add(scopeId);
      return next;
    });
  };

  const scopePlanItems = (scopeId: string) =>
    planItems.filter(item => String(item.project_scope_id || '') === String(scopeId));

  const scopeMaterials = (items: any[]) => {
    const itemIds = new Set(items.map(item => String(item.id)));
    return materials.filter(material => itemIds.has(String(material.plan_item_id || '')));
  };

  const materialCost = (materialList: any[]) =>
    materialList.reduce((sum, material) => sum + Number(material.actual_cost || material.estimated_cost || 0), 0);

  const aiAgentScopes = scopes.filter(scope => aiAgentMeta(scope));
  const aiAgentLineCount = aiAgentScopes.reduce((sum, scope) => {
    const executionLines = scopePlanItems(scope.id);
    return sum + (executionLines.length || scopeTextLines(scope.scope_of_work).length);
  }, 0);

  const statusColors: Record<string, string> = {
    not_started: 'bg-slate-800 text-slate-200 border-slate-600',
    in_progress: 'bg-blue-500/15 text-blue-100 border-blue-300/40',
    waiting_materials: 'bg-amber-500/15 text-amber-100 border-amber-300/40',
    needs_review: 'bg-purple-500/15 text-purple-100 border-purple-300/40',
    completed: 'bg-emerald-500/15 text-emerald-100 border-emerald-300/40',
  };
  const materialColors: Record<string, string> = {
    planned: 'bg-slate-800 text-slate-200 border-slate-600',
    quote_requested: 'bg-blue-500/15 text-blue-100 border-blue-300/40',
    ordered: 'bg-indigo-500/15 text-indigo-100 border-indigo-300/40',
    waiting: 'bg-amber-500/15 text-amber-100 border-amber-300/40',
    delivered: 'bg-emerald-500/15 text-emerald-100 border-emerald-300/40',
    installed: 'bg-green-500/15 text-green-100 border-green-300/40',
    cancelled: 'bg-red-500/15 text-red-100 border-red-300/40',
  };

  const openAddStep = (scopeId: string) => {
    setEditingStep(null);
    setStepForm({ ...blankStepForm, project_scope_id: scopeId });
    setShowStepEditor(true);
  };

  const openEditStep = (item: any) => {
    if (!canManage) return;
    setEditingStep(item);
    setStepForm({
      project_scope_id: item.project_scope_id || '',
      title: item.title || '',
      category: item.category || '',
      description: item.description || '',
      status: item.status || 'not_started',
      verification_status: item.verification_status || 'not_requested',
      invoice_status: item.invoice_status || 'not_received',
      start_date: item.start_date || '',
      target_date: item.target_date || '',
      approval_notes: item.approval_notes || '',
    });
    setShowStepEditor(true);
  };

  const closeStepEditor = () => {
    setShowStepEditor(false);
    setEditingStep(null);
    setStepForm(blankStepForm);
  };

  const saveStep = async () => {
    if (!stepForm.title.trim()) return toast.error('Enter a line item title');
    const payload = {
      ...stepForm,
      title: stepForm.title.trim(),
      category: stepForm.category.trim() || null,
      description: stepForm.description.trim() || null,
      project_scope_id: stepForm.project_scope_id || null,
      start_date: stepForm.start_date || null,
      target_date: stepForm.target_date || null,
      approval_notes: stepForm.approval_notes.trim() || null,
    };
    try {
      if (editingStep) {
        await api.put(`/projects/${projectId}/construction-plan/${editingStep.id}`, payload);
        toast.success('Scope execution line updated');
      } else {
        await api.post(`/projects/${projectId}/construction-plan`, payload);
        toast.success('Scope execution line added');
      }
      closeStepEditor();
      await loadScopes();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to save scope execution line');
    }
  };

  const deleteStep = async () => {
    if (!editingStep) return;
    if (!window.confirm('Delete this execution line item?')) return;
    try {
      await api.delete(`/projects/${projectId}/construction-plan/${editingStep.id}`);
      closeStepEditor();
      await loadScopes();
    } catch {
      toast.error('Failed to delete execution line');
    }
  };

  const moveStep = async (itemId: string, direction: 'up' | 'down') => {
    try {
      await api.post(`/projects/${projectId}/construction-plan/${itemId}/move`, { direction });
      await loadScopes();
    } catch {
      toast.error('Failed to reorder execution line');
    }
  };

  const quickStatus = async (item: any, status: string, patch: Record<string, any> = {}) => {
    try {
      await api.put(`/projects/${projectId}/construction-plan/${item.id}`, { ...item, status, ...patch });
      await loadScopes();
    } catch {
      toast.error('Failed to update execution line');
    }
  };

  const toggleScopeCompleted = async (scope: any) => {
    if (!canManage) return;
    const isComplete = String(scope.status || 'active') === 'completed';
    const payload = {
      section_name: scope.section_name || 'General',
      scope_title: scope.scope_title || 'Scope of Work',
      scope_of_work: scopeLineItemText(scope.scope_of_work || ''),
      status: isComplete ? 'active' : 'completed',
      timeline_start: scope.timeline_start || null,
      timeline_end: scope.timeline_end || null,
    };
    try {
      await api.put(`/projects/${projectId}/scopes/${scope.id}`, payload);
      toast.success(isComplete ? 'Scope reopened on project timeline' : 'Scope marked 100% complete on project timeline');
      await loadScopes();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update scope completion');
    }
  };

  const uploadStepPhoto = async (itemId: string, files?: FileList | File[] | null) => {
    const uploadFiles = Array.from(files || []);
    if (!uploadFiles.length) return;
    setUploadingPhoto(itemId);
    try {
      const formData = new FormData();
      uploadFiles.forEach(file => formData.append('photos', file));
      formData.append('construction_plan_item_id', itemId);
      formData.append('caption', 'Scope execution photo');
      await api.post(`/projects/${projectId}/photos`, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      await loadScopes();
    } catch {
      toast.error('Failed to upload execution photo');
    } finally {
      setUploadingPhoto(null);
    }
  };

  const openAddMaterial = (planItemId = '', scopeId: string | null = null) => {
    setEditingMaterial(null);
    setActiveMaterialScopeId(scopeId);
    setMaterialForm({ ...blankMaterialForm, plan_item_id: planItemId });
    setShowMaterialEditor(true);
  };

  const openEditMaterial = (material: any) => {
    if (!canManage) return;
    const linkedItem = planItems.find(item => item.id === material.plan_item_id);
    setActiveMaterialScopeId(linkedItem?.project_scope_id || null);
    setEditingMaterial(material);
    setMaterialForm({
      plan_item_id: material.plan_item_id || '',
      material_name: material.material_name || '',
      category: material.category || '',
      quantity: material.quantity ? String(material.quantity) : '',
      unit: material.unit || '',
      estimated_cost: material.estimated_cost ? String(material.estimated_cost) : '',
      actual_cost: material.actual_cost ? String(material.actual_cost) : '',
      supplier: material.supplier || '',
      order_status: material.order_status || 'planned',
      needed_by: material.needed_by || '',
      expected_delivery: material.expected_delivery || '',
      delivered_at: material.delivered_at || '',
      notes: material.notes || '',
    });
    setShowMaterialEditor(true);
  };

  const availableMaterialLineItems = activeMaterialScopeId
    ? planItems.filter(item => String(item.project_scope_id || '') === String(activeMaterialScopeId))
    : planItems;

  const closeMaterialEditor = () => {
    setShowMaterialEditor(false);
    setEditingMaterial(null);
    setActiveMaterialScopeId(null);
    setMaterialForm(blankMaterialForm);
  };

  const saveMaterial = async () => {
    if (!materialForm.material_name.trim()) return toast.error('Enter a material name');
    const payload = {
      ...materialForm,
      material_name: materialForm.material_name.trim(),
      category: materialForm.category.trim() || null,
      plan_item_id: materialForm.plan_item_id || null,
      quantity: materialForm.quantity ? Number(materialForm.quantity) : null,
      estimated_cost: materialForm.estimated_cost ? Number(materialForm.estimated_cost) : null,
      actual_cost: materialForm.actual_cost ? Number(materialForm.actual_cost) : null,
      needed_by: materialForm.needed_by || null,
      expected_delivery: materialForm.expected_delivery || null,
      delivered_at: materialForm.delivered_at || null,
      notes: materialForm.notes.trim() || null,
    };
    try {
      if (editingMaterial) {
        await api.put(`/projects/${projectId}/materials/${editingMaterial.id}`, payload);
        toast.success('Material updated');
      } else {
        await api.post(`/projects/${projectId}/materials`, payload);
        toast.success('Material added');
      }
      closeMaterialEditor();
      await loadScopes();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to save material');
    }
  };

  const deleteMaterial = async () => {
    if (!editingMaterial) return;
    if (!window.confirm('Delete this material line?')) return;
    try {
      await api.delete(`/projects/${projectId}/materials/${editingMaterial.id}`);
      closeMaterialEditor();
      await loadScopes();
    } catch {
      toast.error('Failed to delete material');
    }
  };

  const bulkEnteredCount = bulkScopeRows.filter(row => row.scope_title.trim() || row.section_name.trim() || row.scope_of_work.trim() || row.status !== 'active').length;
  const vendorQuoteSelectedScopes = scopes.filter(scope => vendorQuoteScopeIds.includes(String(scope.id)));
  const vendorQuotePhotoCount = vendorQuoteSelectedScopes.reduce((sum, scope) => sum + (Array.isArray(scope.photos) ? scope.photos.length : 0), 0);
  const selectedQuoteContractors = quoteContractors.filter(contractor => vendorQuoteContractorIds.includes(contractor.id));
  const visibleQuoteContractors = useMemo(() => {
    const search = quoteContractorSearch.trim().toLowerCase();
    return [...quoteContractors]
      .sort((left, right) => {
        const leftConnected = contractorProjectIds(left).has(projectId) ? 0 : 1;
        const rightConnected = contractorProjectIds(right).has(projectId) ? 0 : 1;
        if (leftConnected !== rightConnected) return leftConnected - rightConnected;
        return contractorDisplayName(left).localeCompare(contractorDisplayName(right));
      })
      .filter(contractor => {
        if (!search) return true;
        return [
          contractorDisplayName(contractor),
          contractor.contact_name,
          contractor.email,
          contractor.phone,
          contractorTypeLabel(contractor),
        ].filter(Boolean).some(value => String(value).toLowerCase().includes(search));
      })
      .slice(0, 24);
  }, [quoteContractors, quoteContractorSearch, projectId]);
  const scopeAttachmentSummary = useMemo(() => {
    if (!scopeAttachments.length) return 'Attach agreed estimate, bid, or approval file';
    const names = scopeAttachments.slice(0, 2).map(file => file.name).join(', ');
    return scopeAttachments.length > 2 ? `${names}, +${scopeAttachments.length - 2} more` : names;
  }, [scopeAttachments]);

  return (
    <div className="space-y-5">
      {loading ? (
        <Loading />
      ) : (
        <div className="space-y-3">
          {aiAgentScopes.length > 0 && (
          <section className="overflow-hidden rounded-2xl border border-violet-300/45 bg-gradient-to-br from-slate-950 via-violet-950 to-blue-950 text-white shadow-[0_18px_44px_rgba(49,46,129,0.32)]">
            <div className="flex flex-col gap-3 border-b border-white/10 p-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <span className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl border border-violet-200/35 bg-violet-400/15 text-violet-100">
                  <Bot className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-black uppercase tracking-wide text-violet-200">Telegram AI Agent Scope</p>
                  <h4 className="mt-1 text-base font-black text-white">Scope of Work Entered by AI Agents</h4>
                  <p className="mt-1 text-sm font-semibold leading-5 text-violet-100/85">
                    Scopes posted through Benito, Hermes, or another approved agent appear here before the regular scope list.
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:min-w-64">
                <div className="rounded-xl border border-violet-200/25 bg-white/10 p-3">
                  <p className="text-xl font-black text-white">{aiAgentScopes.length}</p>
                  <p className="text-[11px] font-black uppercase tracking-wide text-violet-100">AI scopes</p>
                </div>
                <div className="rounded-xl border border-cyan-200/25 bg-white/10 p-3">
                  <p className="text-xl font-black text-white">{aiAgentLineCount}</p>
                  <p className="text-[11px] font-black uppercase tracking-wide text-cyan-100">Line items</p>
                </div>
              </div>
            </div>

            {aiAgentScopes.length === 0 ? (
              <div className="p-4">
                <div className="rounded-xl border border-dashed border-violet-200/35 bg-black/18 p-4">
                  <p className="text-sm font-black text-violet-50">No AI-agent scope has posted to this property yet.</p>
                  <p className="mt-1 text-xs font-semibold leading-5 text-violet-100/80">
                    Once Hermes sends a valid BuildTrack agent key and this property address, the created scope will show here with the agent name, request ID, transcript, and line items.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-3 p-4">
                {aiAgentScopes.map(scope => {
                  const meta = aiAgentMeta(scope);
                  const executionItems = scopePlanItems(scope.id);
                  const fallbackLines = scopeTextLines(scope.scope_of_work);
                  const visibleLines = executionItems.length
                    ? executionItems.map((item, index) => ({
                        id: item.id || `${scope.id}-${index}`,
                        text: item.title || item.description || `Line ${index + 1}`,
                        meta: [item.category, item.location, String(item.status || '').replace(/_/g, ' ')].filter(Boolean).join(' - '),
                      }))
                    : fallbackLines.map((line, index) => ({
                        id: `${scope.id}-scope-line-${index}`,
                        text: line,
                        meta: '',
                      }));

                  return (
                    <article key={scope.id} className="rounded-xl border border-white/10 bg-slate-950/55 p-4 shadow-inner">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="inline-flex items-center gap-1 rounded-full border border-violet-200/40 bg-violet-500/20 px-2.5 py-1 text-[11px] font-black text-violet-50">
                              <Bot className="h-3.5 w-3.5" />
                              {meta?.agentName || 'AI Agent'}
                            </span>
                            <span className="rounded-full border border-white/10 bg-white/10 px-2.5 py-1 text-[11px] font-black capitalize text-slate-100">
                              {String(scope.status || 'active').replace(/_/g, ' ')}
                            </span>
                            <span className="text-[11px] font-bold uppercase tracking-wide text-violet-200/80">
                              {formatEasternDateTime(scope.created_at, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} New York time
                            </span>
                          </div>
                          <h5 className="mt-3 text-lg font-black text-white">{scope.scope_title || 'AI Generated Scope of Work'}</h5>
                          <p className="mt-1 text-xs font-semibold text-violet-100/80">
                            Source: {meta?.source || 'AI bridge'}{meta?.requestId ? ` - Request: ${meta.requestId}` : ''}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => toggleScopeExpansion(scope.id)}
                          className="inline-flex min-h-10 items-center justify-center rounded-xl border border-violet-200/30 bg-white/10 px-3 text-xs font-black text-violet-50 transition hover:bg-white/15"
                        >
                          {expandedScopeIds.has(scope.id) ? 'Hide Details' : 'Open Full Scope'}
                        </button>
                      </div>

                      <div className="mt-4 space-y-2">
                        {visibleLines.length ? visibleLines.map((line, index) => (
                          <div key={line.id} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-2 rounded-lg border border-white/10 bg-black/24 px-3 py-2">
                            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-violet-400/18 text-xs font-black text-violet-50">{index + 1}</span>
                            <span className="min-w-0">
                              <span className="block text-sm font-black leading-5 text-white">{line.text}</span>
                              {line.meta && <span className="mt-0.5 block text-[11px] font-bold uppercase tracking-wide text-violet-200/75">{line.meta}</span>}
                            </span>
                          </div>
                        )) : (
                          <p className="rounded-lg border border-white/10 bg-black/24 px-3 py-3 text-sm font-semibold italic text-violet-100/80">
                            This AI scope does not have visible line items yet.
                          </p>
                        )}
                      </div>

                      {meta?.rawTranscript && (
                        <details className="mt-4 rounded-lg border border-white/10 bg-black/18 p-3">
                          <summary className="cursor-pointer text-xs font-black uppercase tracking-wide text-violet-100">Original Telegram transcript</summary>
                          <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-violet-50/90">{meta.rawTranscript}</p>
                        </details>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
          )}

          {legacyScope && scopes.length === 0 && (
            <div className="bg-white rounded-2xl border border-amber-200 p-4">
              <p className="text-xs font-black uppercase tracking-wide text-amber-700">Original project scope note</p>
              <p className="text-sm text-gray-700 whitespace-pre-wrap mt-2">{legacyScope}</p>
            </div>
          )}

          {scopes.length === 0 ? (
            <div className="bg-white rounded-2xl border border-dashed border-gray-300 p-10 text-center">
              <FileText className="w-9 h-9 text-gray-300 mx-auto mb-3" />
              <p className="text-sm font-black text-gray-700">No scope sections entered yet</p>
              <p className="text-sm text-gray-500 mt-1">Add separate scopes for kitchen, bath, exterior, mechanicals, site work, or any project section.</p>
              {canManage && (
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  <button type="button" onClick={openBulkScopes} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-600 bg-gradient-to-br from-slate-800 via-slate-950 to-blue-950 text-slate-100 text-sm font-bold transition-all duration-150 hover:border-cyan-300 hover:text-white">
                    <ClipboardList className="w-4 h-4" /> Add Bulk Scope of Work
                  </button>
                  <button type="button" onClick={openAddScope} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-600 bg-gradient-to-br from-slate-800 via-slate-950 to-blue-950 text-slate-100 text-sm font-bold transition-all duration-150 hover:border-cyan-300 hover:text-white">
                    <Plus className="w-4 h-4" /> Add first scope
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              {canManage && (
                <div className="mb-2 flex flex-wrap items-center justify-end gap-2">
                  <button type="button" onClick={openBulkScopes} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-600 bg-gradient-to-br from-slate-800 via-slate-950 to-blue-950 text-slate-100 text-sm font-bold transition-all duration-150 hover:border-cyan-300 hover:text-white">
                    <ClipboardList className="w-4 h-4" /> Add Bulk Scope
                  </button>
                  <button type="button" onClick={openAddScope} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-600 bg-gradient-to-br from-slate-800 via-slate-950 to-blue-950 text-slate-100 text-sm font-bold transition-all duration-150 hover:border-cyan-300 hover:text-white">
                    <Plus className="w-4 h-4" /> Add Scope of Work
                  </button>
                </div>
              )}
              {scopes.map((scope, index) => {
                const estimateDocuments = Array.isArray(scope.estimate_documents) ? scope.estimate_documents : [];
                const scopeCardStyle = scopeCardStyles[index % scopeCardStyles.length];
                const scopeNumber = scope.sort_order || index + 1;
                const isExpanded = expandedScopeIds.has(scope.id);
                const executionItems = scopePlanItems(scope.id);
                const executionMaterials = scopeMaterials(executionItems);
                const scopeMaterialCost = materialCost(executionMaterials);
                const waitingMaterials = executionMaterials.filter(material => ['ordered', 'waiting'].includes(material.order_status)).length;
                const scopePhotos = Array.isArray(scope.photos) ? scope.photos : [];
                const scopeLightboxItems = buildScopePhotoLightboxItems(projectId, scopePhotos);
                const scopeTimelineLabel = scopeTimelineRangeLabel(scope);
                const scopeAiMeta = aiAgentMeta(scope);
                const scopeId = String(scope.id);
                const dropPosition = scopeDropTarget?.id === scopeId ? scopeDropTarget.position : null;
                const isDraggingScope = draggingScopeId === scopeId;
                return (
                <div
                  key={scope.id}
                  draggable={canManage && !reorderingScope}
                  onDragStart={event => handleScopeDragStart(event, scopeId)}
                  onDragOver={event => handleScopeDragOver(event, scopeId)}
                  onDrop={event => handleScopeDrop(event, scopeId)}
                  onDragEnd={resetScopeDrag}
                  aria-grabbed={isDraggingScope}
                  className={`relative overflow-hidden rounded-lg border text-slate-100 transition-all duration-150 hover:-translate-y-0.5 hover:border-cyan-200/90 hover:brightness-110 hover:ring-2 hover:ring-cyan-300/70 hover:shadow-[0_0_0_1px_rgba(34,211,238,0.55),0_18px_42px_rgba(8,47,73,0.45)] focus-within:border-cyan-200/90 focus-within:ring-2 focus-within:ring-cyan-300/70 ${scopeCardStyle.card} ${canManage ? 'cursor-grab active:cursor-grabbing' : ''} ${isDraggingScope ? 'scale-[0.995] opacity-45 ring-2 ring-white/30' : ''} ${dropPosition ? 'ring-2 ring-amber-300/80' : ''}`}
                >
                  {dropPosition === 'before' && <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-1.5 bg-amber-300 shadow-[0_0_20px_rgba(251,191,36,0.8)]" />}
                  {dropPosition === 'after' && <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-1.5 bg-amber-300 shadow-[0_0_20px_rgba(251,191,36,0.8)]" />}
                  <div className={`absolute inset-y-0 left-0 w-1 ${scopeCardStyle.accent}`} />
                  <div className="p-2 pl-3">
                  <div className="flex flex-col gap-2 xl:flex-row xl:items-start xl:justify-between">
                    <button type="button" onClick={() => toggleScopeExpansion(scope.id)} className="group flex min-w-0 flex-1 items-start gap-2 text-left">
                      {canManage && (
                        <span className="mt-0.5 inline-flex h-6 w-5 flex-shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/10 text-slate-300 transition-colors group-hover:text-white" title="Drag scope to reorder">
                          <GripVertical className="h-4 w-4" />
                        </span>
                      )}
                      <span className={`inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-sm font-black shadow-sm ring-1 ${scopeCardStyle.number}`}>{scopeNumber}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h4 className={`min-w-0 truncate text-sm font-black leading-5 text-white transition-colors ${scopeCardStyle.hoverTitle}`}>{scope.scope_of_work || scope.scope_title || 'Scope of work'}</h4>
                          <ChevronRight className={`h-4 w-4 flex-shrink-0 text-slate-300 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1">
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-black uppercase tracking-wide ${scopeCardStyle.section}`}>{scope.section_name || 'General'}</span>
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-black capitalize shadow-sm ${scopeStatusColors[scope.status] || scopeStatusColors.active}`}>{String(scope.status || 'active').replace(/_/g, ' ')}</span>
                          {scopeAiMeta && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-violet-200/40 bg-violet-500/20 px-2 py-0.5 text-[11px] font-black text-violet-100" title={scopeAiMeta.rawTranscript || undefined}>
                              <Bot className="h-3 w-3" />
                              AI Agent: {scopeAiMeta.agentName}
                            </span>
                          )}
                          {scopeTimelineLabel && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-cyan-300/35 bg-cyan-400/15 px-2 py-0.5 text-[11px] font-black text-cyan-100">
                              <CalendarDays className="h-3 w-3" />
                              Timeline {scopeTimelineLabel}
                            </span>
                          )}
                          <span className="inline-flex items-center rounded-full border border-white/15 bg-white/10 px-2 py-0.5 text-[11px] font-black text-slate-100">
                            {executionItems.length} line{executionItems.length === 1 ? '' : 's'}
                          </span>
                          <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
                            Updated {formatEasternDateTime(scope.updated_at || scope.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                          </span>
                        </div>
                        {/* task is shown as the title above */}
                        {executionItems.length > 0 && (
                          <div className="mt-1 space-y-1">
                            {executionItems.map((item, lineIndex) => (
                              <div key={item.id} className="flex min-w-0 items-center gap-2 rounded-md border border-white/10 bg-slate-950/45 px-2 py-1">
                                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded bg-white/10 px-1 text-[10px] font-black text-white">{item.sort_order || lineIndex + 1}</span>
                                <span className="min-w-0 flex-1 truncate text-xs font-black text-slate-50">{item.title}</span>
                                {item.category && <span className="hidden rounded-full border border-white/10 bg-white/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-slate-200 md:inline-flex">{item.category}</span>}
                                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-black capitalize ${statusColors[item.status] || statusColors.not_started}`}>{String(item.status || 'not_started').replace(/_/g, ' ')}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </button>
                    <div className="flex flex-wrap items-center gap-1.5 flex-shrink-0 xl:justify-end">
                      {canManage && String(scope.status || 'active') !== 'completed' && (
                        <button
                          type="button"
                          onClick={() => toggleScopeCompleted(scope)}
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-400/40 bg-emerald-500/15 px-2.5 py-1.5 text-xs font-black text-emerald-100 transition-colors hover:bg-emerald-500/25 hover:text-white"
                          title="Mark this scope 100% complete on the project timeline"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Mark Completed
                        </button>
                      )}
                      {String(scope.status || 'active') === 'completed' && (
                        <span className="inline-flex items-center justify-center gap-1.5 rounded-full border border-emerald-400/45 bg-emerald-500/20 px-3 py-1.5 text-xs font-black uppercase tracking-wide text-emerald-100">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Completed
                        </span>
                      )}
                      <button type="button" onClick={() => toggleScopeExpansion(scope.id)} className="rounded-lg border border-slate-600 bg-slate-950/45 px-2.5 py-1.5 text-xs font-black text-slate-100 transition-colors hover:bg-slate-800" aria-label={isExpanded ? 'Collapse scope details' : 'Expand scope details'}>
                        {isExpanded ? 'Hide' : 'Details'}
                      </button>
                      {canManage && (
                        <button type="button" onClick={() => openVendorQuoteModal(scope)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-600 bg-slate-950/45 px-2.5 py-1.5 text-xs font-black text-slate-100 transition-colors hover:bg-slate-800" aria-label="Request quote for this scope">
                          <Send className="h-3.5 w-3.5" />
                          Request Quote
                        </button>
                      )}
                      <AddToCalendarButton
                        label="Calendar"
                        defaultTitle={`Scope: ${scope.scope_title || scope.section_name || 'Scope of work'}`}
                        defaultDescription={[scope.section_name, scope.scope_of_work].filter(Boolean).join('\n\n')}
                        defaultDate={scope.timeline_end || scope.timeline_start || project?.target_completion || project?.start_date || null}
                        projectId={projectId}
                        sourceType="scope"
                        sourceId={scope.id}
                        contextLabel={[project?.address, scope.scope_title].filter(Boolean).join(' - ')}
                        buttonClassName="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-600 bg-slate-950/45 px-2 py-1.5 text-xs font-black text-slate-100 transition-colors hover:bg-slate-800"
                      />
                      <button type="button" onClick={() => openScopeAssignmentPhotoPicker(scope)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-600 bg-slate-950/45 px-2 py-1.5 text-xs font-black text-slate-100 transition-colors hover:bg-slate-800" aria-label="Attach photos to scope">
                        <Camera className="h-3.5 w-3.5" />
                        Photos
                      </button>
                      {canManage && (
                        <>
                        <button type="button" onClick={() => openEditScope(scope)} className="rounded-lg border border-slate-600 bg-slate-950/40 p-1.5 text-slate-200 transition-colors hover:bg-slate-800" aria-label="Edit scope">
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button type="button" disabled={index === 0} onClick={() => moveScope(scope.id, 'up')} className="rounded-lg border border-slate-600 bg-slate-950/40 p-1.5 text-slate-200 transition-colors hover:bg-slate-800 disabled:opacity-30" aria-label="Move scope up">
                          <ArrowUp className="w-4 h-4" />
                        </button>
                        <button type="button" disabled={index === scopes.length - 1} onClick={() => moveScope(scope.id, 'down')} className="rounded-lg border border-slate-600 bg-slate-950/40 p-1.5 text-slate-200 transition-colors hover:bg-slate-800 disabled:opacity-30" aria-label="Move scope down">
                          <ArrowDown className="w-4 h-4" />
                        </button>
                        </>
                      )}
                    </div>
                  </div>
                  {isExpanded && estimateDocuments.length > 0 && (
                    <div className="mt-4 border-t border-white/10 pt-3">
                      <p className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-wide text-slate-300">
                        <Paperclip className="w-3.5 h-3.5" /> Attached estimate docs
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {estimateDocuments.map((doc: any) => (
                          <a
                            key={doc.scope_document_id || doc.id}
                            href={`/api/documents/${projectId}/${doc.id}/download`}
                            className="inline-flex max-w-full items-center gap-2 rounded-lg border border-white/10 bg-white/10 px-3 py-2 text-xs font-bold text-slate-100 hover:bg-white/15"
                          >
                            <FileText className="h-3.5 w-3.5 flex-shrink-0" />
                            <span className="truncate">{doc.original_name || 'Estimate document'}</span>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                  {isExpanded && scopePhotos.length > 0 && (
                    <div className="mt-4 border-t border-white/10 pt-3">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <p className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-wide text-slate-300">
                          <Camera className="w-3.5 h-3.5" /> Attached photos
                        </p>
                        <span className="rounded-full border border-white/10 bg-white/10 px-2 py-0.5 text-[11px] font-black text-slate-100">{scopePhotos.length}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
                        {scopePhotos.map((photo: any) => {
                          const mediaKind = getProgressMediaKind(photo);
                          const src = progressPhotoSrc(projectId, photo);
                          const lightboxIndex = scopeLightboxItems.findIndex(item => item.id === scopePhotoLightboxKey(photo));
                          const canPreview = lightboxIndex >= 0;
                          return (
                            <div key={photo.assignment_id || photo.id} className="group relative aspect-[4/3] min-h-32 overflow-hidden rounded-xl border border-white/10 bg-slate-900 shadow-[0_14px_30px_rgba(2,6,23,0.28)]">
                              <button
                                type="button"
                                disabled={!canPreview}
                                onClick={() => canPreview && setScopeLightbox({ items: scopeLightboxItems, index: lightboxIndex })}
                                className="block h-full w-full text-left transition duration-150 hover:scale-[1.015] focus:outline-none focus:ring-2 focus:ring-amber-300 disabled:cursor-default"
                                aria-label={`View ${photo.original_name || 'scope photo'} full size`}
                              >
                                {mediaKind === 'video' ? (
                                  <video src={src} className="h-full w-full object-cover" muted playsInline preload="metadata" />
                                ) : mediaKind === 'image' ? (
                                  <img src={src} alt={photo.original_name || 'Scope photo'} className="h-full w-full object-cover" loading="lazy" />
                                ) : (
                                  <UnsupportedProgressMediaTile name={photo.original_name || photo.filename} />
                                )}
                                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent px-2.5 py-2 text-[11px] font-black text-white">
                                  <span className="line-clamp-2">{photo.individual_note || photo.batch_note || photo.caption || photo.original_name || 'Photo'}</span>
                                </div>
                              </button>
                              {photo.assignment_id && (
                                <button
                                  type="button"
                                  onClick={event => {
                                    event.stopPropagation();
                                    removeScopePhotoAssignment(photo.assignment_id);
                                  }}
                                  className="absolute right-2 top-2 hidden rounded-md border border-red-300/60 bg-red-600 px-2 py-1 text-[10px] font-black text-white shadow-sm group-hover:inline-flex"
                                  aria-label="Remove photo from scope"
                                >
                                  Remove
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {isExpanded && (
                    <div className="mt-4 border-t border-white/10 pt-4">
                      {scope.scope_of_work ? (
                        <p className="whitespace-pre-wrap text-sm leading-6 text-slate-200/90">{scope.scope_of_work}</p>
                      ) : (
                        <p className="text-sm font-semibold italic text-slate-400">No scope notes entered yet.</p>
                      )}
                      <p className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        {executionItems.length} execution line{executionItems.length === 1 ? '' : 's'} · {waitingMaterials} material{waitingMaterials === 1 ? '' : 's'} waiting · ${scopeMaterialCost.toLocaleString('en-US', { maximumFractionDigits: 0 })} material cost · Updated {formatEasternDateTime(scope.updated_at || scope.created_at, { month: 'short', day: 'numeric' })}
                      </p>
                      {scopeAiMeta && (
                        <p className="mt-2 text-[11px] font-semibold text-violet-200/80">AI Agent: {scopeAiMeta.agentName}{scopeAiMeta.requestId ? ` · Request ${scopeAiMeta.requestId}` : ''}</p>
                      )}

                      {canManage && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button type="button" onClick={() => openScopeAssignmentPhotoPicker(scope)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-950/45 px-3 py-1.5 text-xs font-black text-slate-100 hover:bg-slate-800">
                            <Camera className="h-3.5 w-3.5" /> Photos
                          </button>
                          <button type="button" onClick={() => openAddStep(scope.id)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-950/45 px-3 py-1.5 text-xs font-black text-slate-100 hover:bg-slate-800">
                            <Plus className="h-3.5 w-3.5" /> Line Item
                          </button>
                        </div>
                      )}

                      {executionItems.length > 0 && (
                        <div className="mt-4 space-y-3">
                          {executionItems.map((item, itemIndex) => {
                            const itemMaterials = materials.filter(material => material.plan_item_id === item.id);
                            return (
                              <div key={item.id} className="rounded-2xl border border-white/10 bg-slate-950/55 p-4 shadow-inner">
                                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                                  <div
                                    role={canManage ? 'button' : undefined}
                                    tabIndex={canManage ? 0 : undefined}
                                    onClick={() => openEditStep(item)}
                                    onKeyDown={event => {
                                      if (canManage && (event.key === 'Enter' || event.key === ' ')) openEditStep(item);
                                    }}
                                    className={`min-w-0 flex-1 ${canManage ? 'cursor-pointer' : ''}`}
                                  >
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="inline-flex h-8 min-w-8 items-center justify-center rounded-lg bg-white/10 px-2 text-xs font-black text-white">{item.sort_order}</span>
                                      {item.category && <span className="rounded-full border border-white/10 bg-white/10 px-2 py-1 text-[11px] font-black uppercase tracking-wide text-slate-200">{item.category}</span>}
                                      <span className={`rounded-full border px-2 py-1 text-[11px] font-black ${statusColors[item.status] || statusColors.not_started}`}>{String(item.status || 'not_started').replace(/_/g, ' ')}</span>
                                      <span className={`rounded-full border px-2 py-1 text-[11px] font-black ${item.verification_status === 'approved' ? 'border-emerald-300/40 bg-emerald-500/15 text-emerald-100' : item.verification_status === 'pending_review' ? 'border-purple-300/40 bg-purple-500/15 text-purple-100' : item.verification_status === 'rejected' ? 'border-red-300/40 bg-red-500/15 text-red-100' : 'border-slate-600 bg-slate-800 text-slate-200'}`}>
                                        {String(item.verification_status || 'not_requested').replace(/_/g, ' ')}
                                      </span>
                                      <span className={`rounded-full border px-2 py-1 text-[11px] font-black ${['received', 'approval_needed'].includes(item.invoice_status) && item.verification_status !== 'approved' ? 'border-red-300/40 bg-red-500/15 text-red-100' : item.invoice_status === 'approved_for_payment' ? 'border-emerald-300/40 bg-emerald-500/15 text-emerald-100' : 'border-slate-600 bg-slate-800 text-slate-200'}`}>
                                        {String(item.invoice_status || 'not_received').replace(/_/g, ' ')}
                                      </span>
                                    </div>
                                    <h5 className="mt-3 text-base font-black text-white">{item.title}</h5>
                                    {item.description && <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-300">{item.description}</p>}
                                    <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold text-slate-400">
                                      {item.start_date && <span>Start: {format(new Date(item.start_date), 'MMM d, yyyy')}</span>}
                                      {item.target_date && <span>Target: {format(new Date(item.target_date), 'MMM d, yyyy')}</span>}
                                    </div>
                                  </div>
                                  {canManage && (
                                    <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                                      <AddToCalendarButton
                                        label="Calendar"
                                        defaultTitle={item.title || 'Scope execution line'}
                                        defaultDescription={[scope.scope_title, item.description].filter(Boolean).join('\n\n')}
                                        defaultDate={item.target_date || item.start_date || project?.target_completion || null}
                                        projectId={projectId}
                                        sourceType="scope_execution_line"
                                        sourceId={item.id}
                                        contextLabel={[project?.address, scope.scope_title, item.title].filter(Boolean).join(' - ')}
                                        buttonClassName="inline-flex items-center gap-1.5 rounded-lg border border-cyan-300/40 bg-cyan-500/15 px-2.5 py-2 text-xs font-black text-cyan-100 hover:bg-cyan-500/25"
                                      />
                                      <button type="button" disabled={itemIndex === 0} onClick={() => moveStep(item.id, 'up')} className="rounded-lg border border-white/10 bg-black/20 p-2 text-slate-200 disabled:opacity-30" aria-label="Move line up"><ArrowUp className="h-4 w-4" /></button>
                                      <button type="button" disabled={itemIndex === executionItems.length - 1} onClick={() => moveStep(item.id, 'down')} className="rounded-lg border border-white/10 bg-black/20 p-2 text-slate-200 disabled:opacity-30" aria-label="Move line down"><ArrowDown className="h-4 w-4" /></button>
                                      <select value={item.status} onChange={event => quickStatus(item, event.target.value)} className="rounded-lg border border-white/10 bg-slate-950 px-2 py-2 text-xs font-bold text-slate-100">
                                        {['not_started', 'in_progress', 'waiting_materials', 'needs_review', 'completed'].map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
                                      </select>
                                      <button type="button" onClick={() => quickStatus(item, 'completed', { verification_status: 'approved' })} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300/40 bg-emerald-500/15 px-2.5 py-2 text-xs font-black text-emerald-100">
                                        <Check className="h-3.5 w-3.5" /> Approve
                                      </button>
                                      <label
                                        className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-blue-300/40 bg-blue-500/15 px-2.5 py-2 text-xs font-black text-blue-100"
                                        {...fileDropHandlers(files => uploadStepPhoto(item.id, files), {
                                          accept: 'image/*',
                                          disabled: uploadingPhoto === item.id,
                                          multiple: true,
                                        })}
                                      >
                                        <input type="file" accept="image/*" capture="environment" multiple className="hidden" disabled={uploadingPhoto === item.id} onChange={event => { uploadStepPhoto(item.id, event.target.files); event.currentTarget.value = ''; }} />
                                        <Camera className="h-3.5 w-3.5" />
                                        {uploadingPhoto === item.id ? 'Uploading' : 'Photo'}
                                      </label>
                                      <button type="button" onClick={() => openAddMaterial(item.id, scope.id)} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300/40 bg-amber-500/15 px-2.5 py-2 text-xs font-black text-amber-100">
                                        <Package className="h-3.5 w-3.5" /> Material
                                      </button>
                                    </div>
                                  )}
                                </div>
                                {item.photos?.length > 0 && (
                                  <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                                    {item.photos.map((photo: any) => (
                                      <img key={photo.id} src={`/uploads/${projectId}/${photo.filename}`} alt={photo.original_name || item.title} className="h-20 w-24 flex-shrink-0 rounded-lg border border-white/10 object-cover" />
                                    ))}
                                  </div>
                                )}
                                <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
                                  <div className="mb-2 flex items-center justify-between gap-3">
                                    <p className="text-xs font-black uppercase tracking-wide text-slate-300">Materials tied to this line</p>
                                    <span className="text-xs font-black text-slate-400">{itemMaterials.length}</span>
                                  </div>
                                  {itemMaterials.length === 0 ? (
                                    <p className="text-xs font-semibold text-slate-500">No materials linked yet.</p>
                                  ) : (
                                    <div className="space-y-2">
                                      {itemMaterials.map(material => (
                                        <button
                                          key={material.id}
                                          type="button"
                                          onClick={() => openEditMaterial(material)}
                                          className={`flex w-full flex-col gap-2 rounded-lg border border-white/10 bg-slate-950/70 p-3 text-left md:flex-row md:items-center md:justify-between ${canManage ? 'hover:border-amber-300/40 hover:bg-amber-500/10' : ''}`}
                                        >
                                          <div className="min-w-0">
                                            <p className="truncate text-sm font-black text-white">{material.material_name}</p>
                                            <p className="text-xs font-semibold text-slate-400">{material.quantity || '-'} {material.unit || ''} - {material.supplier || 'No supplier'} - {material.expected_delivery ? `ETA ${format(new Date(material.expected_delivery), 'MMM d')}` : 'No ETA'}</p>
                                            {material.notes && <p className="mt-1 line-clamp-2 text-xs text-slate-400">{material.notes}</p>}
                                          </div>
                                          <div className="flex items-center gap-2">
                                            <span className={`rounded-full border px-2 py-1 text-[11px] font-black ${materialColors[material.order_status] || materialColors.planned}`}>{String(material.order_status || 'planned').replace(/_/g, ' ')}</span>
                                            <span className="text-sm font-black text-white">${Number(material.actual_cost || material.estimated_cost || 0).toLocaleString('en-US')}</span>
                                          </div>
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <Modal isOpen={showStepEditor} onClose={closeStepEditor} title={editingStep ? 'Edit Scope Execution Line' : 'Add Scope Execution Line'} size="lg">
        <div className="space-y-4">
          <div className="grid md:grid-cols-2 gap-3">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Scope Section</label>
              <select value={stepForm.project_scope_id} onChange={e => setStepForm({ ...stepForm, project_scope_id: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">No scope selected</option>
                {scopes.map(scope => <option key={scope.id} value={scope.id}>{scope.sort_order || ''} {scope.section_name || 'General'} - {scope.scope_title}</option>)}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Line Item *</label>
              <input value={stepForm.title} onChange={e => setStepForm({ ...stepForm, title: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Example: Install 12x24 porcelain tile" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
              <input value={stepForm.category} onChange={e => setStepForm({ ...stepForm, category: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Tile, vanity, electrical..." />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select value={stepForm.status} onChange={e => setStepForm({ ...stepForm, status: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                {['not_started', 'in_progress', 'waiting_materials', 'needs_review', 'completed'].map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Field Verification</label>
              <select value={stepForm.verification_status} onChange={e => setStepForm({ ...stepForm, verification_status: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                {['not_requested', 'pending_review', 'approved', 'rejected'].map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Invoice Status</label>
              <select value={stepForm.invoice_status} onChange={e => setStepForm({ ...stepForm, invoice_status: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                {fieldInvoiceStatusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
              <input type="date" value={stepForm.start_date} onChange={e => setStepForm({ ...stepForm, start_date: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Target Date</label>
              <input type="date" value={stepForm.target_date} onChange={e => setStepForm({ ...stepForm, target_date: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Execution Details</label>
              <VoiceTextarea value={stepForm.description} onChange={e => setStepForm({ ...stepForm, description: e.target.value })} rows={4} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" placeholder="Describe the work, material selection, supplier, approximate cost, or approval requirements..." />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Approval Notes</label>
              <VoiceTextarea value={stepForm.approval_notes} onChange={e => setStepForm({ ...stepForm, approval_notes: e.target.value })} rows={2} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" placeholder="What must be checked before payment approval?" />
            </div>
          </div>
          <div className="flex gap-3">
            {editingStep && <button type="button" onClick={deleteStep} className="px-4 py-2.5 rounded-xl border border-red-200 text-red-700 text-sm font-black hover:bg-red-50">Delete</button>}
            <button type="button" onClick={closeStepEditor} className="ml-auto px-4 py-2.5 rounded-xl border border-gray-300 text-sm font-black text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="button" onClick={saveStep} className="px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-black hover:bg-blue-700">Save Line</button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={showMaterialEditor} onClose={closeMaterialEditor} title={editingMaterial ? 'Edit Scope Material' : 'Add Scope Material'} size="lg">
        <div className="space-y-4">
          <div className="grid md:grid-cols-3 gap-3">
            <div className="md:col-span-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">Link To Scope Execution Line</label>
              <select value={materialForm.plan_item_id} onChange={e => setMaterialForm({ ...materialForm, plan_item_id: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Unlinked material</option>
                {availableMaterialLineItems.map(item => <option key={item.id} value={item.id}>{item.sort_order}. {item.title}</option>)}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Material *</label>
              <input value={materialForm.material_name} onChange={e => setMaterialForm({ ...materialForm, material_name: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Example: 12x24 porcelain tile" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select value={materialForm.order_status} onChange={e => setMaterialForm({ ...materialForm, order_status: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                {['planned', 'quote_requested', 'ordered', 'waiting', 'delivered', 'installed', 'cancelled'].map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Category</label><input value={materialForm.category} onChange={e => setMaterialForm({ ...materialForm, category: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label><input value={materialForm.quantity} onChange={e => setMaterialForm({ ...materialForm, quantity: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Unit</label><input value={materialForm.unit} onChange={e => setMaterialForm({ ...materialForm, unit: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Estimated Cost</label><input value={materialForm.estimated_cost} onChange={e => setMaterialForm({ ...materialForm, estimated_cost: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Actual Cost</label><input value={materialForm.actual_cost} onChange={e => setMaterialForm({ ...materialForm, actual_cost: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Supplier</label><input value={materialForm.supplier} onChange={e => setMaterialForm({ ...materialForm, supplier: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Where it will be purchased" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Needed By</label><input type="date" value={materialForm.needed_by} onChange={e => setMaterialForm({ ...materialForm, needed_by: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Expected Delivery</label><input type="date" value={materialForm.expected_delivery} onChange={e => setMaterialForm({ ...materialForm, expected_delivery: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Delivered At</label><input type="date" value={materialForm.delivered_at} onChange={e => setMaterialForm({ ...materialForm, delivered_at: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div className="md:col-span-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">Material Notes</label>
              <VoiceTextarea value={materialForm.notes} onChange={e => setMaterialForm({ ...materialForm, notes: e.target.value })} rows={3} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" placeholder="Type of material, supplier notes, cost assumptions, or install notes..." />
            </div>
          </div>
          <div className="flex gap-3">
            {editingMaterial && <button type="button" onClick={deleteMaterial} className="px-4 py-2.5 rounded-xl border border-red-200 text-red-700 text-sm font-black hover:bg-red-50">Delete</button>}
            <button type="button" onClick={closeMaterialEditor} className="ml-auto px-4 py-2.5 rounded-xl border border-gray-300 text-sm font-black text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="button" onClick={saveMaterial} className="px-4 py-2.5 rounded-xl bg-amber-500 text-white text-sm font-black hover:bg-amber-600">Save Material</button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={showVendorQuoteModal} onClose={closeVendorQuoteModal} title="Request Quote" size="xl">
        <div className="space-y-4">
          <div className="rounded-2xl border border-emerald-300 bg-gradient-to-br from-slate-950 via-emerald-950 to-blue-950 p-4 shadow-[0_18px_42px_rgba(16,185,129,0.16)]">
            <p className="text-sm font-black text-white">Send selected scope sections to one or more contractors for pricing.</p>
            <p className="mt-1 text-xs font-semibold leading-5 text-emerald-100/85">
              BuildTrack sends a private secure quote link to each contractor by email, text, or both. Each contractor only sees the selected scope details{vendorQuoteForm.include_photos ? ` and ${vendorQuotePhotoCount} attached photo${vendorQuotePhotoCount === 1 ? '' : 's'}` : ''}.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-sm font-black text-slate-950">Pick one or more contractors from the contractor list</p>
                <p className="mt-1 text-xs font-semibold text-slate-500">Email and phone come from each contractor profile. Email recipients are hidden from one another.</p>
              </div>
              <div className="relative w-full md:w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  value={quoteContractorSearch}
                  onChange={event => setQuoteContractorSearch(event.currentTarget.value)}
                  aria-label="Search contractors"
                  className="w-full rounded-xl border border-slate-300 bg-slate-50 py-2.5 pl-9 pr-3 text-sm font-bold text-slate-900 outline-none focus:border-emerald-400 focus:bg-white"
                />
              </div>
            </div>

            <div className="mt-3 grid max-h-52 gap-2 overflow-y-auto pr-1 md:grid-cols-2">
              {loadingQuoteContractors ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm font-bold text-slate-500">Loading contractors...</div>
              ) : visibleQuoteContractors.length === 0 ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm font-bold text-slate-500">No contractors found.</div>
              ) : visibleQuoteContractors.map(contractor => {
                const selected = vendorQuoteContractorIds.includes(contractor.id);
                const connected = contractorProjectIds(contractor).has(projectId);
                return (
                  <button
                    key={contractor.id}
                    type="button"
                    onClick={() => selectVendorQuoteContractor(contractor)}
                    className={`rounded-xl border p-3 text-left transition ${selected ? 'border-emerald-400 bg-emerald-50 ring-4 ring-emerald-100' : 'border-slate-200 bg-slate-50 hover:border-emerald-200 hover:bg-white'}`}
                    aria-pressed={selected}
                  >
                    <div className="flex items-start gap-3">
                      <span className={`mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg border text-xs font-black ${selected ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-300 bg-white text-transparent'}`}>
                        <Check className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-black text-slate-950">{contractorDisplayName(contractor)}</p>
                          {connected && <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-blue-700">Project</span>}
                        </div>
                        <p className="mt-1 truncate text-xs font-semibold text-slate-500">{contractorTypeLabel(contractor)}</p>
                        <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-bold text-slate-600">
                          <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" /> {contractor.email || 'No email'}</span>
                          <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" /> {contractor.phone || 'No phone'}</span>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            {selectedQuoteContractors.length > 0 && (
              <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-black text-emerald-800">
                Selected {selectedQuoteContractors.length} contractor{selectedQuoteContractors.length === 1 ? '' : 's'}: {selectedQuoteContractors.slice(0, 4).map(contractorDisplayName).join(', ')}{selectedQuoteContractors.length > 4 ? `, +${selectedQuoteContractors.length - 4} more` : ''}
              </div>
            )}
          </div>

          <div className="grid gap-3">
            <div>
              <label className="block text-xs font-black uppercase tracking-wide text-gray-500 mb-1">Message To Contractor</label>
              <textarea value={vendorQuoteForm.message} onChange={updateVendorQuoteForm('message')} rows={3} className={`${scopeEditorFieldClass} resize-y`} />
            </div>
            <div className="rounded-2xl border border-amber-300/70 bg-amber-50 p-3 text-xs font-black leading-5 text-amber-900">
              Quote links expire automatically after 7 business days.
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className={`flex min-h-16 items-center gap-3 rounded-2xl border p-4 ${vendorQuoteForm.send_email ? 'border-blue-300 bg-blue-50' : 'border-slate-200 bg-white'}`}>
              <input type="checkbox" checked={vendorQuoteForm.send_email} onChange={updateVendorQuoteForm('send_email')} className="h-4 w-4 rounded border-blue-300 text-blue-600 focus:ring-blue-500" />
              <span>
                <span className="block text-sm font-black text-slate-950">Email quote link</span>
                <span className="mt-0.5 block text-xs font-semibold text-slate-500">Send as private hidden-recipient email. Contractors cannot see other contractor emails.</span>
              </span>
            </label>
            <label className={`flex min-h-16 items-center gap-3 rounded-2xl border p-4 ${vendorQuoteForm.send_text ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white'}`}>
              <input type="checkbox" checked={vendorQuoteForm.send_text} onChange={updateVendorQuoteForm('send_text')} className="h-4 w-4 rounded border-emerald-300 text-emerald-600 focus:ring-emerald-500" />
              <span>
                <span className="block text-sm font-black text-slate-950">Text quote link</span>
                <span className="mt-0.5 block text-xs font-semibold text-slate-500">Send SMS to each selected contractor phone.</span>
              </span>
            </label>
          </div>

          <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-black text-slate-900">{vendorQuoteSelectedScopes.length} of {scopes.length} scope sections selected</p>
              <p className="mt-1 text-xs font-semibold text-slate-500">Choose the entire scope or only the parts this vendor should price.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={selectAllVendorQuoteScopes} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-black text-slate-700 hover:bg-slate-100">Select All</button>
              <button type="button" onClick={clearVendorQuoteScopes} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-black text-slate-700 hover:bg-slate-100">Clear</button>
              <label className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-cyan-200 bg-cyan-50 px-3 text-xs font-black text-cyan-800">
                <input type="checkbox" checked={vendorQuoteForm.include_photos} onChange={updateVendorQuoteForm('include_photos')} className="h-4 w-4 rounded border-cyan-300 text-cyan-600 focus:ring-cyan-500" />
                Include photos
              </label>
            </div>
          </div>

          <div className="grid max-h-[42vh] gap-2 overflow-y-auto pr-1 md:grid-cols-2">
            {scopes.map(scope => {
              const selected = vendorQuoteScopeIds.includes(String(scope.id));
              const photoCount = Array.isArray(scope.photos) ? scope.photos.length : 0;
              return (
                <button
                  key={scope.id}
                  type="button"
                  onClick={() => toggleVendorQuoteScope(String(scope.id))}
                  className={`rounded-2xl border p-3 text-left transition ${selected ? 'border-amber-400 bg-amber-50 ring-4 ring-amber-100' : 'border-slate-200 bg-white hover:border-amber-200'}`}
                  aria-pressed={selected}
                >
                  <div className="flex items-start gap-3">
                    <span className={`mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg border text-xs font-black ${selected ? 'border-amber-500 bg-amber-500 text-white' : 'border-slate-300 bg-white text-white'}`}>
                      {selected ? <Check className="h-4 w-4" /> : ''}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-black text-slate-950">{scope.scope_title}</p>
                      <p className="mt-1 text-xs font-semibold text-slate-500">{scope.section_name || 'General'} - {photoCount} photo{photoCount === 1 ? '' : 's'}</p>
                      {scope.scope_of_work && <p className="mt-2 line-clamp-2 text-xs font-semibold leading-5 text-slate-600">{scope.scope_of_work}</p>}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap justify-end gap-3 border-t border-slate-200 pt-3">
            <button type="button" disabled={sendingVendorQuote} onClick={closeVendorQuoteModal} className="px-4 py-2.5 rounded-xl border border-gray-300 text-sm font-black text-gray-700 hover:bg-gray-50 disabled:opacity-60">Cancel</button>
            <button
              type="button"
              disabled={sendingVendorQuote || !vendorQuoteScopeIds.length || !vendorQuoteContractorIds.length}
              onClick={sendVendorQuoteRequest}
              className="inline-flex items-center gap-2 rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-black text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Send className="h-4 w-4" />
              {sendingVendorQuote ? 'Sending...' : 'Send Quote Links'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={showBulkEditor} onClose={closeBulkScopes} title="Add Bulk Scope of Work Items" size="xl">
        <div className="space-y-4 bt-scope-editor" onKeyDown={keepScopeEditorTypingLocal}>
          <div className="rounded-2xl border border-emerald-400/40 bg-gradient-to-br from-slate-950 via-emerald-950 to-blue-950 p-4 shadow-[0_18px_42px_rgba(16,185,129,0.16)]">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-sm font-black text-white">Bulk scope entry</p>
                <p className="text-xs font-bold text-emerald-100/80">{bulkScopeRows.length} rows ready, {bulkEnteredCount} filled</p>
              </div>
              <button
                type="button"
                onClick={() => addBulkScopeRows(5)}
                disabled={savingBulkScopes}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-300/50 bg-emerald-400/15 px-4 py-2.5 text-sm font-black text-emerald-50 hover:bg-emerald-400/25 disabled:opacity-60"
              >
                <Plus className="h-4 w-4" /> Add 5 Rows
              </button>
            </div>
          </div>

          <div className="hidden gap-3 px-3 text-[11px] font-black uppercase tracking-wide text-gray-500 md:grid md:grid-cols-[3rem_minmax(11rem,1fr)_minmax(8rem,.6fr)_minmax(7rem,.48fr)_minmax(8rem,.55fr)_minmax(8rem,.55fr)_minmax(13rem,1fr)_3rem]">
            <span>#</span>
            <span>Scope Title *</span>
            <span>House / Section</span>
            <span>Status</span>
            <span>Timeline Start</span>
            <span>Timeline Done</span>
            <span>Scope Details</span>
            <span className="sr-only">Remove</span>
          </div>

          <div className="space-y-3">
            {bulkScopeRows.map((row, index) => (
              <div key={row.rowId} className="rounded-2xl border border-slate-700 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-3 shadow-sm">
                <div className="grid gap-3 md:grid-cols-[3rem_minmax(11rem,1fr)_minmax(8rem,.6fr)_minmax(7rem,.48fr)_minmax(8rem,.55fr)_minmax(8rem,.55fr)_minmax(13rem,1fr)_3rem] md:items-start">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-sm font-black text-white">
                    {index + 1}
                  </div>
                  <label>
                    <span className="bt-scope-editor-label mb-1 block text-xs font-black uppercase tracking-wide text-gray-500 md:sr-only">Scope Title *</span>
                    <input
                      type="text"
                      autoComplete="off"
                      value={row.scope_title}
                      onChange={updateBulkScopeRow(row.rowId, 'scope_title')}
                      placeholder="Paint cabinets"
                      className={scopeEditorFieldClass}
                    />
                  </label>
                  <label>
                    <span className="bt-scope-editor-label mb-1 block text-xs font-black uppercase tracking-wide text-gray-500 md:sr-only">House / Section</span>
                    <input
                      type="text"
                      autoComplete="off"
                      value={row.section_name}
                      onChange={updateBulkScopeRow(row.rowId, 'section_name')}
                      placeholder="Kitchen"
                      className={scopeEditorFieldClass}
                    />
                  </label>
                  <label>
                    <span className="bt-scope-editor-label mb-1 block text-xs font-black uppercase tracking-wide text-gray-500 md:sr-only">Status</span>
                    <select value={row.status} onChange={updateBulkScopeRow(row.rowId, 'status')} className={`${scopeEditorFieldClass} bg-white`}>
                      {['draft', 'active', 'on_hold', 'completed'].map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
                    </select>
                  </label>
                  <label>
                    <span className="bt-scope-editor-label mb-1 block text-xs font-black uppercase tracking-wide text-gray-500 md:sr-only">Timeline Start</span>
                    <input
                      type="date"
                      value={row.timeline_start}
                      onChange={updateBulkScopeRow(row.rowId, 'timeline_start')}
                      className={scopeEditorFieldClass}
                    />
                  </label>
                  <label>
                    <span className="bt-scope-editor-label mb-1 block text-xs font-black uppercase tracking-wide text-gray-500 md:sr-only">Timeline Done</span>
                    <input
                      type="date"
                      value={row.timeline_end}
                      onChange={updateBulkScopeRow(row.rowId, 'timeline_end')}
                      className={scopeEditorFieldClass}
                    />
                  </label>
                  <label>
                    <span className="bt-scope-editor-label mb-1 block text-xs font-black uppercase tracking-wide text-gray-500 md:sr-only">Scope Details</span>
                    <textarea
                      value={row.scope_of_work}
                      onChange={updateBulkScopeRow(row.rowId, 'scope_of_work')}
                      onBlur={() => setBulkScopeRows(current => current.map(item => item.rowId === row.rowId ? { ...item, scope_of_work: scopeLineItemText(item.scope_of_work) } : item))}
                      rows={2}
                      placeholder="Enter work details..."
                      className={`${scopeEditorFieldClass} min-h-[44px] resize-y`}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => removeBulkScopeRow(row.rowId)}
                    disabled={savingBulkScopes}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-60"
                    aria-label={`Remove bulk scope row ${index + 1}`}
                    title="Remove row"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-3 border-t border-gray-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs font-bold text-gray-500">{bulkEnteredCount} scope {bulkEnteredCount === 1 ? 'item' : 'items'} ready to save</p>
            <div className="flex flex-wrap justify-end gap-3">
              <button type="button" disabled={savingBulkScopes} onClick={closeBulkScopes} className="px-4 py-2.5 rounded-xl border border-gray-300 text-sm font-black text-gray-700 hover:bg-gray-50 disabled:opacity-60">Cancel</button>
              <button type="button" disabled={savingBulkScopes} onClick={() => addBulkScopeRows(5)} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-emerald-300 bg-white text-sm font-black text-emerald-800 hover:bg-emerald-50 disabled:opacity-60">
                <Plus className="h-4 w-4" /> Add 5 Rows
              </button>
              <button type="button" disabled={savingBulkScopes} onClick={saveBulkScopes} className="px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-black hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-70">
                {savingBulkScopes ? 'Saving...' : 'Save Scope Items'}
              </button>
            </div>
          </div>
        </div>
      </Modal>

      <Modal isOpen={showEditor} onClose={closeScopeEditor} title={editingScope ? 'Edit Scope of Work' : 'Add Scope of Work'} size="lg">
        <div className="space-y-4 bt-scope-editor" onKeyDown={keepScopeEditorTypingLocal}>
          <div className="grid gap-3 md:grid-cols-4">
            <div className="md:col-span-4">
              <label className="bt-scope-editor-label block text-sm font-medium text-gray-700 mb-1">Scope Title *</label>
              <input type="text" autoComplete="off" value={scopeForm.scope_title} onChange={updateScopeFormField('scope_title')} placeholder="Kitchen cabinet and countertop replacement" className={scopeEditorFieldClass} />
            </div>
            <div>
              <label className="bt-scope-editor-label block text-sm font-medium text-gray-700 mb-1">House / Project Section</label>
              <input type="text" autoComplete="off" value={scopeForm.section_name} onChange={updateScopeFormField('section_name')} placeholder="Kitchen, exterior, roof, site work..." className={scopeEditorFieldClass} />
            </div>
            <div>
              <label className="bt-scope-editor-label block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select value={scopeForm.status} onChange={updateScopeFormField('status')} className={`${scopeEditorFieldClass} bg-white`}>
                {['draft', 'active', 'on_hold', 'completed'].map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="bt-scope-editor-label block text-sm font-medium text-gray-700 mb-1">Timeline Start Date</label>
              <input type="date" value={scopeForm.timeline_start} onChange={updateScopeFormField('timeline_start')} className={scopeEditorFieldClass} />
            </div>
            <div>
              <label className="bt-scope-editor-label block text-sm font-medium text-gray-700 mb-1">Timeline Completion Date</label>
              <input type="date" value={scopeForm.timeline_end} onChange={updateScopeFormField('timeline_end')} className={scopeEditorFieldClass} />
            </div>
            <div className="md:col-span-4">
              <label className="bt-scope-editor-label block text-sm font-medium text-gray-700 mb-1">Scope of Work</label>
              <textarea
                value={scopeForm.scope_of_work}
                onChange={updateScopeFormField('scope_of_work')}
                onBlur={normalizeScopeDetails}
                rows={8}
                placeholder="Enter one scope item per line. Pasted paragraphs and dictated sentences will be formatted into line items."
                className={`${scopeEditorFieldClass} resize-none`}
              />
            </div>
          </div>
          <div className="flex flex-col gap-3 border-t border-gray-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <input
                ref={scopeAttachmentInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleScopeAttachmentChange}
                accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg,.webp,.heic,image/*,application/pdf"
              />
              <button
                type="button"
                onClick={() => scopeAttachmentInputRef.current?.click()}
                {...fileDropHandlers(setScopeAttachmentFiles, {
                  accept: '.pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg,.webp,.heic,image/*,application/pdf',
                  multiple: true,
                })}
                className="inline-flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-black text-amber-800 hover:bg-amber-100"
              >
                <Paperclip className="h-4 w-4" /> Attach Doc
              </button>
              <button
                type="button"
                onClick={openScopeEditorPhotoPicker}
                className="inline-flex items-center gap-2 rounded-xl border border-cyan-300 bg-cyan-50 px-4 py-2.5 text-sm font-black text-cyan-800 hover:bg-cyan-100"
              >
                <Camera className="h-4 w-4" /> Select Photos
              </button>
              <span className="max-w-lg truncate text-xs font-semibold text-gray-500">{scopeAttachmentSummary}</span>
              {scopeAttachments.length > 0 && (
                <button type="button" onClick={clearScopeAttachmentInput} className="rounded-lg px-2 py-1 text-xs font-bold text-gray-500 hover:bg-gray-100">
                  Clear
                </button>
              )}
              {editingScope && <button type="button" onClick={deleteScope} className="px-4 py-2.5 rounded-xl border border-red-200 text-red-700 text-sm font-black hover:bg-red-50">Delete</button>}
            </div>
            <div className="flex justify-end gap-3">
              <button type="button" disabled={savingScope} onClick={closeScopeEditor} className="px-4 py-2.5 rounded-xl border border-gray-300 text-sm font-black text-gray-700 hover:bg-gray-50 disabled:opacity-60">Cancel</button>
              <button
                type="button"
                disabled={savingScope}
                onClick={listeningScope ? stopScopeDictation : startScopeDictation}
                className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-black disabled:opacity-60 ${
                  listeningScope
                    ? 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100'
                    : 'border-blue-200 bg-white text-blue-700 hover:bg-blue-50'
                }`}
                aria-pressed={listeningScope}
                aria-label={listeningScope ? 'Stop scope of work dictation' : 'Speak scope of work'}
              >
                {listeningScope ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                {scopeDictationStatus === 'starting' ? 'Starting...' : listeningScope ? 'Stop' : 'Speak Scope'}
              </button>
              <button type="button" disabled={savingScope} onClick={saveScope} className="px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-black hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-70">
                {savingScope ? 'Saving...' : 'Save Scope'}
              </button>
            </div>
          </div>
          {selectedScopePhotos.length > 0 && (
            <div className="rounded-2xl border border-cyan-200 bg-cyan-50 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs font-black uppercase tracking-wide text-cyan-800">{selectedScopePhotos.length} selected photo{selectedScopePhotos.length === 1 ? '' : 's'}</p>
                <button type="button" onClick={() => { setSelectedScopePhotos([]); setSelectedScopePhotoIds([]); }} className="rounded-lg px-2 py-1 text-xs font-black text-cyan-800 hover:bg-cyan-100">
                  Clear photos
                </button>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {selectedScopePhotos.map(photo => {
                  const mediaKind = getProgressMediaKind(photo);
                  const src = progressPhotoSrc(projectId, photo);
                  return (
                    <div key={photo.id} className="h-16 w-20 flex-shrink-0 overflow-hidden rounded-lg border border-cyan-200 bg-white">
                      {mediaKind === 'video' ? (
                        <video src={src} className="h-full w-full object-cover" muted playsInline preload="metadata" />
                      ) : mediaKind === 'image' ? (
                        <img src={src} alt={photo.original_name || 'Selected scope photo'} className="h-full w-full object-cover" loading="lazy" />
                      ) : (
                        <UnsupportedProgressMediaTile name={photo.original_name || photo.filename} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </Modal>
      <PhotoBucketPickerModal
        projectId={projectId}
        isOpen={Boolean(scopePhotoPicker)}
        title={scopePhotoPicker?.title || 'Select photos'}
        initialSelectedIds={scopePhotoPicker?.initialSelectedIds || []}
        onClose={() => setScopePhotoPicker(null)}
        onSave={saveScopePhotoPickerSelection}
      />
      <ProgressMediaLightbox state={scopeLightbox} onChange={setScopeLightbox} />
    </div>
  );
}

function ConstructionPlanBoard({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const [items, setItems] = useState<any[]>([]);
  const [materials, setMaterials] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showStepEditor, setShowStepEditor] = useState(false);
  const [showMaterialEditor, setShowMaterialEditor] = useState(false);
  const [editingStep, setEditingStep] = useState<any | null>(null);
  const [editingMaterial, setEditingMaterial] = useState<any | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState<string | null>(null);
  const blankStepForm = {
    title: '',
    category: '',
    description: '',
    status: 'not_started',
    verification_status: 'not_requested',
    invoice_status: 'not_received',
    start_date: '',
    target_date: '',
    approval_notes: '',
  };
  const blankMaterialForm = {
    plan_item_id: '',
    material_name: '',
    category: '',
    quantity: '',
    unit: '',
    estimated_cost: '',
    actual_cost: '',
    supplier: '',
    order_status: 'planned',
    needed_by: '',
    expected_delivery: '',
    delivered_at: '',
    notes: '',
  };
  const [stepForm, setStepForm] = useState(blankStepForm);
  const [materialForm, setMaterialForm] = useState(blankMaterialForm);

  const load = async () => {
    try {
      const [planRes, materialRes] = await Promise.all([
        api.get(`/projects/${projectId}/construction-plan`),
        api.get(`/projects/${projectId}/materials`),
      ]);
      setItems(planRes.data?.items || []);
      setMaterials(materialRes.data || []);
    } catch {
      toast.error('Failed to load construction plan');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [projectId]);

  const statusColors: Record<string, string> = {
    not_started: 'bg-slate-500/15 text-slate-200 border border-slate-400/30',
    in_progress: 'bg-blue-500/20 text-blue-200 border border-blue-400/40',
    waiting_materials: 'bg-amber-500/20 text-amber-200 border border-amber-400/40',
    needs_review: 'bg-purple-500/20 text-purple-200 border border-purple-400/40',
    completed: 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/40',
  };
  const materialColors: Record<string, string> = {
    planned: 'bg-gray-100 text-gray-700',
    quote_requested: 'bg-blue-100 text-blue-700',
    ordered: 'bg-indigo-100 text-indigo-700',
    waiting: 'bg-amber-100 text-amber-700',
    delivered: 'bg-green-100 text-green-700',
    installed: 'bg-emerald-100 text-emerald-700',
    cancelled: 'bg-red-100 text-red-700',
  };

  const openAddStep = () => {
    setEditingStep(null);
    setStepForm(blankStepForm);
    setShowStepEditor(true);
  };

  const openEditStep = (item: any) => {
    if (!canManage) return;
    setEditingStep(item);
    setStepForm({
      title: item.title || '',
      category: item.category || '',
      description: item.description || '',
      status: item.status || 'not_started',
      verification_status: item.verification_status || 'not_requested',
      invoice_status: item.invoice_status || 'not_received',
      start_date: item.start_date || '',
      target_date: item.target_date || '',
      approval_notes: item.approval_notes || '',
    });
    setShowStepEditor(true);
  };

  const saveStep = async () => {
    if (!stepForm.title.trim()) return;
    const payload = {
      ...stepForm,
      title: stepForm.title.trim(),
      category: stepForm.category.trim() || null,
      description: stepForm.description.trim() || null,
      start_date: stepForm.start_date || null,
      target_date: stepForm.target_date || null,
    };
    try {
      if (editingStep) {
        await api.put(`/projects/${projectId}/construction-plan/${editingStep.id}`, payload);
        toast.success('Construction line updated');
      } else {
        await api.post(`/projects/${projectId}/construction-plan`, payload);
        toast.success('Construction line added');
      }
      setShowStepEditor(false);
      setEditingStep(null);
      setStepForm(blankStepForm);
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to save construction line');
    }
  };

  const deleteStep = async () => {
    if (!editingStep) return;
    if (!window.confirm('Delete this construction plan line item?')) return;
    try {
      await api.delete(`/projects/${projectId}/construction-plan/${editingStep.id}`);
      setShowStepEditor(false);
      setEditingStep(null);
      load();
    } catch {
      toast.error('Failed to delete construction line');
    }
  };

  const moveStep = async (itemId: string, direction: 'up' | 'down') => {
    try {
      await api.post(`/projects/${projectId}/construction-plan/${itemId}/move`, { direction });
      load();
    } catch {
      toast.error('Failed to reorder construction plan');
    }
  };

  const quickStatus = async (item: any, status: string, patch: Record<string, any> = {}) => {
    try {
      await api.put(`/projects/${projectId}/construction-plan/${item.id}`, { ...item, status, ...patch });
      load();
    } catch {
      toast.error('Failed to update line status');
    }
  };

  const uploadStepPhoto = async (itemId: string, files?: FileList | File[] | null) => {
    const uploadFiles = Array.from(files || []);
    if (!uploadFiles.length) return;
    setUploadingPhoto(itemId);
    try {
      const formData = new FormData();
      uploadFiles.forEach(file => formData.append('photos', file));
      formData.append('construction_plan_item_id', itemId);
      formData.append('caption', 'Construction plan photo');
      await api.post(`/projects/${projectId}/photos`, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      load();
    } catch {
      toast.error('Failed to upload construction plan photo');
    } finally {
      setUploadingPhoto(null);
    }
  };

  const openAddMaterial = (planItemId = '') => {
    setEditingMaterial(null);
    setMaterialForm({ ...blankMaterialForm, plan_item_id: planItemId });
    setShowMaterialEditor(true);
  };

  const openEditMaterial = (material: any) => {
    if (!canManage) return;
    setEditingMaterial(material);
    setMaterialForm({
      plan_item_id: material.plan_item_id || '',
      material_name: material.material_name || '',
      category: material.category || '',
      quantity: material.quantity ? String(material.quantity) : '',
      unit: material.unit || '',
      estimated_cost: material.estimated_cost ? String(material.estimated_cost) : '',
      actual_cost: material.actual_cost ? String(material.actual_cost) : '',
      supplier: material.supplier || '',
      order_status: material.order_status || 'planned',
      needed_by: material.needed_by || '',
      expected_delivery: material.expected_delivery || '',
      delivered_at: material.delivered_at || '',
      notes: material.notes || '',
    });
    setShowMaterialEditor(true);
  };

  const saveMaterial = async () => {
    if (!materialForm.material_name.trim()) return;
    const payload = {
      ...materialForm,
      material_name: materialForm.material_name.trim(),
      category: materialForm.category.trim() || null,
      quantity: materialForm.quantity ? Number(materialForm.quantity) : null,
      estimated_cost: materialForm.estimated_cost ? Number(materialForm.estimated_cost) : null,
      actual_cost: materialForm.actual_cost ? Number(materialForm.actual_cost) : null,
      needed_by: materialForm.needed_by || null,
      expected_delivery: materialForm.expected_delivery || null,
      delivered_at: materialForm.delivered_at || null,
      notes: materialForm.notes.trim() || null,
    };
    try {
      if (editingMaterial) {
        await api.put(`/projects/${projectId}/materials/${editingMaterial.id}`, payload);
        toast.success('Material updated');
      } else {
        await api.post(`/projects/${projectId}/materials`, payload);
        toast.success('Material added');
      }
      setShowMaterialEditor(false);
      setEditingMaterial(null);
      setMaterialForm(blankMaterialForm);
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to save material');
    }
  };

  const deleteMaterial = async () => {
    if (!editingMaterial) return;
    if (!window.confirm('Delete this material line?')) return;
    try {
      await api.delete(`/projects/${projectId}/materials/${editingMaterial.id}`);
      setShowMaterialEditor(false);
      setEditingMaterial(null);
      load();
    } catch {
      toast.error('Failed to delete material');
    }
  };

  const totalCost = materials.reduce((sum, material) => sum + Number(material.actual_cost || material.estimated_cost || 0), 0);
  const waitingCount = materials.filter(material => ['ordered', 'waiting'].includes(material.order_status)).length;
  const unlinkedMaterials = materials.filter(material => !material.plan_item_id);

  if (loading) return <Loading />;

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-2xl border border-gray-200 p-5" style={{ boxShadow: '0 10px 30px rgba(17,24,39,0.08)' }}>
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h3 className="font-black text-gray-900">Execution Plan & Materials</h3>
            <p className="text-sm text-gray-500 mt-1">{items.length} line item{items.length !== 1 ? 's' : ''} · {materials.length} material item{materials.length !== 1 ? 's' : ''}</p>
          </div>
          {canManage && (
            <div className="flex gap-2">
              <button type="button" onClick={openAddStep} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-blue-600 text-white text-xs font-bold cursor-pointer">
                <Plus className="w-4 h-4" /> Line Item
              </button>
              <button type="button" onClick={() => openAddMaterial()} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-500 text-white text-xs font-bold cursor-pointer">
                <Package className="w-4 h-4" /> Material
              </button>
            </div>
          )}
        </div>
        <div className="grid sm:grid-cols-3 gap-3 mt-4">
          <div className="rounded-xl bg-blue-50 p-3">
            <p className="text-xl font-black text-blue-700">{items.length}</p>
            <p className="text-xs font-semibold text-blue-700">Plan lines</p>
          </div>
          <div className="rounded-xl bg-amber-50 p-3">
            <p className="text-xl font-black text-amber-700">{waitingCount}</p>
            <p className="text-xs font-semibold text-amber-700">Materials waiting</p>
          </div>
          <div className="rounded-xl bg-green-50 p-3">
            <p className="text-xl font-black text-green-700">${totalCost.toLocaleString('en-US', { maximumFractionDigits: 0 })}</p>
            <p className="text-xs font-semibold text-green-700">Material cost</p>
          </div>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="bg-white rounded-2xl border border-dashed border-gray-300 p-10 text-center">
          <FileText className="w-9 h-9 text-gray-300 mx-auto mb-3" />
          <p className="text-sm font-black text-gray-700">No execution plan lines yet</p>
          {canManage && (
            <button type="button" onClick={openAddStep} className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-bold cursor-pointer">
              <Plus className="w-4 h-4" /> Add first line item
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item, index) => {
            const linkedMaterials = materials.filter(material => material.plan_item_id === item.id);
            return (
              <div key={item.id} className="bg-white rounded-2xl border border-gray-200 overflow-hidden" style={{ boxShadow: '0 8px 24px rgba(17,24,39,0.06)' }}>
                <div
                  role={canManage ? 'button' : undefined}
                  tabIndex={canManage ? 0 : undefined}
                  onClick={() => openEditStep(item)}
                  onKeyDown={e => {
                    if (canManage && (e.key === 'Enter' || e.key === ' ')) openEditStep(item);
                  }}
                  className={`p-4 flex gap-3 text-left ${canManage ? 'cursor-pointer hover:bg-blue-50/40 transition-colors' : ''}`}
                >
                  <div className="w-9 h-9 rounded-xl bg-gray-900 text-white flex items-center justify-center text-sm font-black flex-shrink-0">{item.sort_order}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-2">
                      <div className="min-w-0">
                        {item.category && <p className="text-xs font-black uppercase tracking-wide text-gray-400">{item.category}</p>}
                        <h4 className="font-black text-gray-900">{item.title}</h4>
                        {item.description && <p className="text-sm text-gray-600 mt-1 whitespace-pre-wrap">{item.description}</p>}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {canManage && (
                          <>
                            <button type="button" disabled={index === 0} onClick={e => { e.stopPropagation(); moveStep(item.id, 'up'); }} className="p-2 rounded-lg border border-gray-200 disabled:opacity-30 cursor-pointer"><ArrowUp className="w-4 h-4" /></button>
                            <button type="button" disabled={index === items.length - 1} onClick={e => { e.stopPropagation(); moveStep(item.id, 'down'); }} className="p-2 rounded-lg border border-gray-200 disabled:opacity-30 cursor-pointer"><ArrowDown className="w-4 h-4" /></button>
                          </>
                        )}
                        <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${statusColors[item.status] || statusColors.not_started}`}>{String(item.status).replace(/_/g, ' ')}</span>
                        <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${item.verification_status === 'approved' ? 'bg-emerald-100 text-emerald-700' : item.verification_status === 'pending_review' ? 'bg-purple-100 text-purple-700' : item.verification_status === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>
                          {String(item.verification_status || 'not_requested').replace(/_/g, ' ')}
                        </span>
                        <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${['received', 'approval_needed'].includes(item.invoice_status) && item.verification_status !== 'approved' ? 'bg-red-100 text-red-700' : item.invoice_status === 'approved_for_payment' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                          {String(item.invoice_status || 'not_received').replace(/_/g, ' ')}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-3">
                      {item.start_date && <span className="text-xs font-semibold text-gray-500">Start: {format(new Date(item.start_date), 'MMM d, yyyy')}</span>}
                      {item.target_date && <span className="text-xs font-semibold text-gray-500">Target: {format(new Date(item.target_date), 'MMM d, yyyy')}</span>}
                      {canManage && (
                        <>
                          <select value={item.status} onClick={e => e.stopPropagation()} onChange={e => { e.stopPropagation(); quickStatus(item, e.target.value); }} className="px-2 py-1.5 rounded-lg border border-gray-300 text-xs bg-white cursor-pointer">
                            {['not_started', 'in_progress', 'waiting_materials', 'needs_review', 'completed'].map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
                          </select>
                          <select value={item.invoice_status || 'not_received'} onClick={e => e.stopPropagation()} onChange={e => { e.stopPropagation(); quickStatus(item, item.status, { invoice_status: e.target.value }); }} className="px-2 py-1.5 rounded-lg border border-gray-300 text-xs bg-white cursor-pointer">
                            {fieldInvoiceStatusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                          </select>
                          {item.verification_status !== 'approved' && (
                            <button type="button" onClick={e => { e.stopPropagation(); quickStatus(item, 'completed', { verification_status: 'approved' }); }} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-100 cursor-pointer">
                              <Check className="w-3.5 h-3.5" /> Approve
                            </button>
                          )}
                          <label
                            onClick={e => e.stopPropagation()}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold text-blue-700 bg-blue-50 border border-blue-100 cursor-pointer"
                            {...fileDropHandlers(files => uploadStepPhoto(item.id, files), {
                              accept: 'image/*',
                              disabled: uploadingPhoto === item.id,
                              multiple: true,
                            })}
                          >
                            <input type="file" accept="image/*" capture="environment" multiple className="hidden" disabled={uploadingPhoto === item.id} onChange={e => { uploadStepPhoto(item.id, e.target.files); e.currentTarget.value = ''; }} />
                            <Camera className="w-3.5 h-3.5" />
                            {uploadingPhoto === item.id ? 'Uploading...' : 'Add Photo'}
                          </label>
                          <button type="button" onClick={e => { e.stopPropagation(); openAddMaterial(item.id); }} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold text-amber-700 bg-amber-50 border border-amber-100 cursor-pointer">
                            <Package className="w-3.5 h-3.5" /> Material
                          </button>
                        </>
                      )}
                    </div>
                    {item.photos?.length > 0 && (
                      <div className="flex gap-2 mt-3 overflow-x-auto pb-1">
                        {item.photos.map((photo: any) => (
                          <img key={photo.id} src={`/uploads/${projectId}/${photo.filename}`} alt={photo.original_name || item.title} className="w-24 h-20 rounded-lg object-cover border border-gray-200 flex-shrink-0" />
                        ))}
                      </div>
                    )}
                    <div className="mt-4 rounded-xl bg-gray-50 p-3">
                      <div className="flex items-center justify-between gap-3 mb-2">
                        <p className="text-xs font-black uppercase tracking-wide text-gray-500">Materials tied to this line</p>
                        <span className="text-xs font-bold text-gray-400">{linkedMaterials.length}</span>
                      </div>
                      {linkedMaterials.length === 0 ? (
                        <p className="text-xs text-gray-400">No materials linked yet.</p>
                      ) : (
                        <div className="space-y-2">
                          {linkedMaterials.map(material => (
                            <div
                              key={material.id}
                              onClick={e => { e.stopPropagation(); openEditMaterial(material); }}
                              className={`flex flex-col md:flex-row md:items-center md:justify-between gap-2 rounded-lg bg-white p-2 border border-gray-100 ${canManage ? 'cursor-pointer hover:border-amber-200 hover:bg-amber-50/30' : ''}`}
                            >
                              <div className="min-w-0">
                                <p className="text-sm font-bold text-gray-900 truncate">{material.material_name}</p>
                                <p className="text-xs text-gray-500">{material.quantity || '-'} {material.unit || ''} · {material.supplier || 'No supplier'} · {material.expected_delivery ? `ETA ${format(new Date(material.expected_delivery), 'MMM d')}` : 'No ETA'}</p>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${materialColors[material.order_status] || materialColors.planned}`}>{String(material.order_status).replace(/_/g, ' ')}</span>
                                <span className="text-sm font-black text-gray-900">${Number(material.actual_cost || material.estimated_cost || 0).toLocaleString('en-US')}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {unlinkedMaterials.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-200 p-4" style={{ boxShadow: '0 8px 24px rgba(17,24,39,0.06)' }}>
          <div className="flex items-center justify-between gap-3 mb-3">
            <p className="text-sm font-black text-gray-900">Unlinked Materials</p>
            <span className="text-xs font-black text-gray-400">{unlinkedMaterials.length}</span>
          </div>
          <div className="grid md:grid-cols-2 gap-2">
            {unlinkedMaterials.map(material => (
              <button key={material.id} type="button" onClick={() => openEditMaterial(material)} className="text-left rounded-xl border border-gray-100 p-3 hover:border-amber-200 hover:bg-amber-50/30 cursor-pointer">
                <p className="text-sm font-black text-gray-900">{material.material_name}</p>
                <p className="text-xs text-gray-500">{material.supplier || 'No supplier'} · {material.expected_delivery ? `ETA ${format(new Date(material.expected_delivery), 'MMM d')}` : 'No ETA'}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      <Modal isOpen={showStepEditor} onClose={() => setShowStepEditor(false)} title={editingStep ? 'Edit Construction Line' : 'Add Construction Line'} size="lg">
        <div className="space-y-4">
          <div className="grid md:grid-cols-2 gap-3">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Line Item *</label>
              <input value={stepForm.title} onChange={e => setStepForm({ ...stepForm, title: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
              <input value={stepForm.category} onChange={e => setStepForm({ ...stepForm, category: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select value={stepForm.status} onChange={e => setStepForm({ ...stepForm, status: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                {['not_started', 'in_progress', 'waiting_materials', 'needs_review', 'completed'].map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Field Verification</label>
              <select value={stepForm.verification_status} onChange={e => setStepForm({ ...stepForm, verification_status: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                {['not_requested', 'pending_review', 'approved', 'rejected'].map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Invoice Status</label>
              <select value={stepForm.invoice_status} onChange={e => setStepForm({ ...stepForm, invoice_status: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                {fieldInvoiceStatusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
              <input type="date" value={stepForm.start_date} onChange={e => setStepForm({ ...stepForm, start_date: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Target Date</label>
              <input type="date" value={stepForm.target_date} onChange={e => setStepForm({ ...stepForm, target_date: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <VoiceTextarea value={stepForm.description} onChange={e => setStepForm({ ...stepForm, description: e.target.value })} rows={4} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Approval Notes</label>
              <VoiceTextarea value={stepForm.approval_notes} onChange={e => setStepForm({ ...stepForm, approval_notes: e.target.value })} rows={2} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" placeholder="What was checked before invoice approval?" />
            </div>
          </div>
          <div className="flex gap-3">
            {editingStep && <button type="button" onClick={deleteStep} className="px-4 py-2.5 rounded-xl border border-red-200 text-red-700 text-sm font-black hover:bg-red-50">Delete</button>}
            <button type="button" onClick={() => setShowStepEditor(false)} className="ml-auto px-4 py-2.5 rounded-xl border border-gray-300 text-sm font-black text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="button" onClick={saveStep} className="px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-black hover:bg-blue-700">Save</button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={showMaterialEditor} onClose={() => setShowMaterialEditor(false)} title={editingMaterial ? 'Edit Material' : 'Add Material'} size="lg">
        <div className="space-y-4">
          <div className="grid md:grid-cols-3 gap-3">
            <div className="md:col-span-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">Link To Construction Line</label>
              <select value={materialForm.plan_item_id} onChange={e => setMaterialForm({ ...materialForm, plan_item_id: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Unlinked material</option>
                {items.map(item => <option key={item.id} value={item.id}>{item.sort_order}. {item.title}</option>)}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Material *</label>
              <input value={materialForm.material_name} onChange={e => setMaterialForm({ ...materialForm, material_name: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select value={materialForm.order_status} onChange={e => setMaterialForm({ ...materialForm, order_status: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                {['planned', 'quote_requested', 'ordered', 'waiting', 'delivered', 'installed', 'cancelled'].map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Category</label><input value={materialForm.category} onChange={e => setMaterialForm({ ...materialForm, category: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label><input value={materialForm.quantity} onChange={e => setMaterialForm({ ...materialForm, quantity: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Unit</label><input value={materialForm.unit} onChange={e => setMaterialForm({ ...materialForm, unit: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Estimated Cost</label><input value={materialForm.estimated_cost} onChange={e => setMaterialForm({ ...materialForm, estimated_cost: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Actual Cost</label><input value={materialForm.actual_cost} onChange={e => setMaterialForm({ ...materialForm, actual_cost: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Supplier</label><input value={materialForm.supplier} onChange={e => setMaterialForm({ ...materialForm, supplier: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Needed By</label><input type="date" value={materialForm.needed_by} onChange={e => setMaterialForm({ ...materialForm, needed_by: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Expected Delivery</label><input type="date" value={materialForm.expected_delivery} onChange={e => setMaterialForm({ ...materialForm, expected_delivery: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Delivered At</label><input type="date" value={materialForm.delivered_at} onChange={e => setMaterialForm({ ...materialForm, delivered_at: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div className="md:col-span-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <VoiceTextarea value={materialForm.notes} onChange={e => setMaterialForm({ ...materialForm, notes: e.target.value })} rows={3} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
          </div>
          <div className="flex gap-3">
            {editingMaterial && <button type="button" onClick={deleteMaterial} className="px-4 py-2.5 rounded-xl border border-red-200 text-red-700 text-sm font-black hover:bg-red-50">Delete</button>}
            <button type="button" onClick={() => setShowMaterialEditor(false)} className="ml-auto px-4 py-2.5 rounded-xl border border-gray-300 text-sm font-black text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="button" onClick={saveMaterial} className="px-4 py-2.5 rounded-xl bg-amber-500 text-white text-sm font-black hover:bg-amber-600">Save</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function ConstructionPlanTab({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const [items, setItems] = useState<any[]>([]);
  const [materials, setMaterials] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddStep, setShowAddStep] = useState(false);
  const [showAddMaterial, setShowAddMaterial] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState<string | null>(null);
  const [stepForm, setStepForm] = useState({ title: '', description: '', category: 'General', target_date: '' });
  const [materialForm, setMaterialForm] = useState({
    plan_item_id: '',
    material_name: '',
    category: 'General',
    quantity: '',
    unit: '',
    estimated_cost: '',
    supplier: '',
    order_status: 'planned',
    needed_by: '',
    expected_delivery: '',
    notes: '',
  });

  const load = async () => {
    try {
      const [planRes, materialRes] = await Promise.all([
        api.get(`/projects/${projectId}/construction-plan`),
        api.get(`/projects/${projectId}/materials`),
      ]);
      setItems(planRes.data?.items || []);
      setMaterials(materialRes.data || []);
    } catch {
      toast.error('Failed to load construction plan');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [projectId]);

  const addStep = async () => {
    if (!stepForm.title.trim()) return;
    try {
      await api.post(`/projects/${projectId}/construction-plan`, stepForm);
      setStepForm({ title: '', description: '', category: 'General', target_date: '' });
      setShowAddStep(false);
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to add construction step');
    }
  };

  const updateStep = async (item: any, patch: any) => {
    try {
      await api.put(`/projects/${projectId}/construction-plan/${item.id}`, { ...item, ...patch });
      load();
    } catch {
      toast.error('Failed to update construction step');
    }
  };

  const moveStep = async (itemId: string, direction: 'up' | 'down') => {
    try {
      await api.post(`/projects/${projectId}/construction-plan/${itemId}/move`, { direction });
      load();
    } catch {
      toast.error('Failed to reorder construction plan');
    }
  };

  const uploadStepPhoto = async (itemId: string, files?: FileList | File[] | null) => {
    const uploadFiles = Array.from(files || []);
    if (!uploadFiles.length) return;
    setUploadingPhoto(itemId);
    try {
      const formData = new FormData();
      uploadFiles.forEach(file => formData.append('photos', file));
      formData.append('construction_plan_item_id', itemId);
      formData.append('caption', 'Construction plan photo');
      await api.post(`/projects/${projectId}/photos`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      load();
    } catch {
      toast.error('Failed to upload construction plan photo');
    } finally {
      setUploadingPhoto(null);
    }
  };

  const addMaterial = async () => {
    if (!materialForm.material_name.trim()) return;
    try {
      await api.post(`/projects/${projectId}/materials`, {
        ...materialForm,
        quantity: materialForm.quantity ? Number(materialForm.quantity) : null,
        estimated_cost: materialForm.estimated_cost ? Number(materialForm.estimated_cost) : null,
      });
      setMaterialForm({
        plan_item_id: '',
        material_name: '',
        category: 'General',
        quantity: '',
        unit: '',
        estimated_cost: '',
        supplier: '',
        order_status: 'planned',
        needed_by: '',
        expected_delivery: '',
        notes: '',
      });
      setShowAddMaterial(false);
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to add material');
    }
  };

  const updateMaterial = async (material: any, patch: any) => {
    try {
      await api.put(`/projects/${projectId}/materials/${material.id}`, { ...material, ...patch });
      load();
    } catch {
      toast.error('Failed to update material');
    }
  };

  const statusColors: Record<string, string> = {
    not_started: 'bg-slate-500/15 text-slate-200 border border-slate-400/30',
    in_progress: 'bg-blue-500/20 text-blue-200 border border-blue-400/40',
    waiting_materials: 'bg-amber-500/20 text-amber-200 border border-amber-400/40',
    needs_review: 'bg-purple-500/20 text-purple-200 border border-purple-400/40',
    completed: 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/40',
  };
  const materialColors: Record<string, string> = {
    planned: 'bg-gray-100 text-gray-700',
    quote_requested: 'bg-blue-100 text-blue-700',
    ordered: 'bg-indigo-100 text-indigo-700',
    waiting: 'bg-amber-100 text-amber-700',
    delivered: 'bg-green-100 text-green-700',
    installed: 'bg-emerald-100 text-emerald-700',
    cancelled: 'bg-red-100 text-red-700',
  };

  const totalCost = materials.reduce((sum, material) => sum + Number(material.actual_cost || material.estimated_cost || 0), 0);
  const waitingCount = materials.filter(material => ['ordered', 'waiting'].includes(material.order_status)).length;

  if (loading) return <Loading />;

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h3 className="font-black text-gray-900">Scope of Work & Materials Timeline</h3>
            <p className="text-sm text-gray-500 mt-1">Ordered rehab steps coordinated with supply needs, delivery dates, costs, and field photos.</p>
          </div>
          {canManage && (
            <div className="flex gap-2">
              <button type="button" onClick={() => setShowAddStep(true)} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-blue-600 text-white text-xs font-bold">
                <Plus className="w-4 h-4" /> Step
              </button>
              <button type="button" onClick={() => setShowAddMaterial(true)} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-500 text-white text-xs font-bold">
                <Package className="w-4 h-4" /> Material
              </button>
            </div>
          )}
        </div>
        <div className="grid sm:grid-cols-3 gap-3 mt-4">
          <div className="rounded-xl bg-blue-50 p-3">
            <p className="text-xl font-black text-blue-700">{items.length}</p>
            <p className="text-xs font-semibold text-blue-700">Plan steps</p>
          </div>
          <div className="rounded-xl bg-amber-50 p-3">
            <p className="text-xl font-black text-amber-700">{waitingCount}</p>
            <p className="text-xs font-semibold text-amber-700">Materials waiting</p>
          </div>
          <div className="rounded-xl bg-green-50 p-3">
            <p className="text-xl font-black text-green-700">${totalCost.toLocaleString('en-US', { maximumFractionDigits: 0 })}</p>
            <p className="text-xs font-semibold text-green-700">Material cost</p>
          </div>
        </div>
      </div>

      {showAddStep && (
        <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          <div className="grid md:grid-cols-2 gap-3">
            <input value={stepForm.title} onChange={e => setStepForm({ ...stepForm, title: e.target.value })} placeholder="Construction step title" className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
            <input value={stepForm.category} onChange={e => setStepForm({ ...stepForm, category: e.target.value })} placeholder="Category" className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
            <input type="date" value={stepForm.target_date} onChange={e => setStepForm({ ...stepForm, target_date: e.target.value })} className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
            <textarea value={stepForm.description} onChange={e => setStepForm({ ...stepForm, description: e.target.value })} placeholder="Step description" className="md:col-span-2 px-3 py-2 rounded-lg border border-gray-300 text-sm resize-none" rows={3} />
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setShowAddStep(false)} className="px-3 py-2 rounded-lg border border-gray-300 text-sm font-bold">Cancel</button>
            <button type="button" onClick={addStep} className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-bold">Add step</button>
          </div>
        </div>
      )}

      {showAddMaterial && (
        <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          <div className="grid md:grid-cols-3 gap-3">
            <select value={materialForm.plan_item_id} onChange={e => setMaterialForm({ ...materialForm, plan_item_id: e.target.value })} className="px-3 py-2 rounded-lg border border-gray-300 text-sm bg-white">
              <option value="">Link to construction step</option>
              {items.map(item => <option key={item.id} value={item.id}>{item.sort_order}. {item.title}</option>)}
            </select>
            <input value={materialForm.material_name} onChange={e => setMaterialForm({ ...materialForm, material_name: e.target.value })} placeholder="Material name" className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
            <input value={materialForm.category} onChange={e => setMaterialForm({ ...materialForm, category: e.target.value })} placeholder="Category" className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
            <input value={materialForm.quantity} onChange={e => setMaterialForm({ ...materialForm, quantity: e.target.value })} placeholder="Quantity" className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
            <input value={materialForm.unit} onChange={e => setMaterialForm({ ...materialForm, unit: e.target.value })} placeholder="Unit" className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
            <input value={materialForm.estimated_cost} onChange={e => setMaterialForm({ ...materialForm, estimated_cost: e.target.value })} placeholder="Estimated cost" className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
            <input value={materialForm.supplier} onChange={e => setMaterialForm({ ...materialForm, supplier: e.target.value })} placeholder="Supplier" className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
            <input type="date" value={materialForm.needed_by} onChange={e => setMaterialForm({ ...materialForm, needed_by: e.target.value })} className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
            <input type="date" value={materialForm.expected_delivery} onChange={e => setMaterialForm({ ...materialForm, expected_delivery: e.target.value })} className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setShowAddMaterial(false)} className="px-3 py-2 rounded-lg border border-gray-300 text-sm font-bold">Cancel</button>
            <button type="button" onClick={addMaterial} className="px-3 py-2 rounded-lg bg-amber-500 text-white text-sm font-bold">Add material</button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {items.map((item, index) => {
          const linkedMaterials = materials.filter(material => material.plan_item_id === item.id);
          return (
            <div key={item.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="p-4 flex gap-3">
                <div className="w-9 h-9 rounded-xl bg-gray-900 text-white flex items-center justify-center text-sm font-black flex-shrink-0">{item.sort_order}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-2">
                    <div>
                      <p className="text-xs font-black uppercase tracking-wide text-gray-400">{item.category}</p>
                      <h4 className="font-black text-gray-900">{item.title}</h4>
                      {item.description && <p className="text-sm text-gray-600 mt-1 whitespace-pre-wrap">{item.description}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      {canManage && (
                        <>
                          <button type="button" disabled={index === 0} onClick={() => moveStep(item.id, 'up')} className="p-2 rounded-lg border border-gray-200 disabled:opacity-30"><ArrowUp className="w-4 h-4" /></button>
                          <button type="button" disabled={index === items.length - 1} onClick={() => moveStep(item.id, 'down')} className="p-2 rounded-lg border border-gray-200 disabled:opacity-30"><ArrowDown className="w-4 h-4" /></button>
                        </>
                      )}
                      <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${statusColors[item.status] || statusColors.not_started}`}>{String(item.status).replace(/_/g, ' ')}</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 mt-3">
                    {item.target_date && <span className="text-xs font-semibold text-gray-500">Target: {format(new Date(item.target_date), 'MMM d, yyyy')}</span>}
                    {canManage && (
                      <>
                        <select value={item.status} onChange={e => updateStep(item, { status: e.target.value })} className="px-2 py-1.5 rounded-lg border border-gray-300 text-xs bg-white">
                          {['not_started', 'in_progress', 'waiting_materials', 'needs_review', 'completed'].map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
                        </select>
                        <label
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold text-blue-700 bg-blue-50 border border-blue-100 cursor-pointer"
                          {...fileDropHandlers(files => uploadStepPhoto(item.id, files), {
                            accept: 'image/*',
                            disabled: uploadingPhoto === item.id,
                            multiple: true,
                          })}
                        >
                          <input type="file" accept="image/*" capture="environment" multiple className="hidden" disabled={uploadingPhoto === item.id} onChange={e => { uploadStepPhoto(item.id, e.target.files); e.currentTarget.value = ''; }} />
                          <Camera className="w-3.5 h-3.5" />
                          {uploadingPhoto === item.id ? 'Uploading...' : 'Add Photo'}
                        </label>
                      </>
                    )}
                  </div>

                  {item.photos?.length > 0 && (
                    <div className="flex gap-2 mt-3 overflow-x-auto pb-1">
                      {item.photos.map((photo: any) => (
                        <img key={photo.id} src={`/uploads/${projectId}/${photo.filename}`} alt={photo.original_name || item.title} className="w-24 h-20 rounded-lg object-cover border border-gray-200 flex-shrink-0" />
                      ))}
                    </div>
                  )}

                  <div className="mt-4 rounded-xl bg-gray-50 p-3">
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <p className="text-xs font-black uppercase tracking-wide text-gray-500">Materials tied to this step</p>
                      <span className="text-xs font-bold text-gray-400">{linkedMaterials.length}</span>
                    </div>
                    {linkedMaterials.length === 0 ? (
                      <p className="text-xs text-gray-400">No materials linked yet.</p>
                    ) : (
                      <div className="space-y-2">
                        {linkedMaterials.map(material => (
                          <div key={material.id} className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 rounded-lg bg-white p-2 border border-gray-100">
                            <div className="min-w-0">
                              <p className="text-sm font-bold text-gray-900 truncate">{material.material_name}</p>
                              <p className="text-xs text-gray-500">{material.quantity || '-'} {material.unit || ''} · {material.supplier || 'No supplier'} · {material.expected_delivery ? `ETA ${format(new Date(material.expected_delivery), 'MMM d')}` : 'No ETA'}</p>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${materialColors[material.order_status] || materialColors.planned}`}>{String(material.order_status).replace(/_/g, ' ')}</span>
                              <span className="text-sm font-black text-gray-900">${Number(material.actual_cost || material.estimated_cost || 0).toLocaleString('en-US')}</span>
                              {canManage && (
                                <select value={material.order_status} onChange={e => updateMaterial(material, { order_status: e.target.value })} className="px-2 py-1 rounded-lg border border-gray-300 text-xs bg-white">
                                  {['planned', 'quote_requested', 'ordered', 'waiting', 'delivered', 'installed', 'cancelled'].map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
                                </select>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PunchListTab({
  projectId,
  user,
  isActive,
  canActivate,
  activating,
  onActivate,
}: {
  projectId: string;
  user: any;
  isActive: boolean;
  canActivate: boolean;
  activating: boolean;
  onActivate: () => Promise<void> | void;
}) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState('');
  const [expandedItem, setExpandedItem] = useState<string | null>(null);
  const [uploadingItemPhoto, setUploadingItemPhoto] = useState<string | null>(null);
  const [punchPhotoPickerItem, setPunchPhotoPickerItem] = useState<any | null>(null);
  const [markupPhoto, setMarkupPhoto] = useState<any | null>(null);
  const { register, handleSubmit, reset, formState: { isSubmitting } } = useForm();
  const canDelete = Boolean(user && ['super_admin', 'operations_manager'].includes(user.role));

  const load = async () => {
    try {
      const params = filter ? `?status=${filter}` : '';
      const res = await api.get(`/projects/${projectId}/punch-list${params}`);
      setItems(res.data);
    } catch (err) { } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [filter]);

  const onAdd = async (data: any) => {
    if (!isActive) {
      toast.error('Activate the punch list before adding items');
      return;
    }
    try {
      await api.post(`/projects/${projectId}/punch-list`, data);
      toast.success('Item added');
      setShowAdd(false);
      reset();
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to add item');
    }
  };

  const updateStatus = async (itemId: string, status: string) => {
    try {
      await api.put(`/projects/${projectId}/punch-list/${itemId}`, { status });
      load();
    } catch (err) { toast.error('Failed to update'); }
  };

  const deleteItem = async (itemId: string, title: string) => {
    if (!window.confirm(`Delete punch list item "${title}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/projects/${projectId}/punch-list/${itemId}`);
      toast.success('Punch list item deleted');
      if (expandedItem === itemId) setExpandedItem(null);
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to delete item');
    }
  };

  const uploadItemPhoto = async (itemId: string, files?: FileList | File[] | null) => {
    const uploadFiles = Array.from(files || []);
    if (!uploadFiles.length) return;
    setUploadingItemPhoto(itemId);
    try {
      const formData = new FormData();
      uploadFiles.forEach(file => formData.append('photos', file));
      formData.append('punch_list_item_id', itemId);
      formData.append('caption', 'Punch list item photo');
      await api.post(`/projects/${projectId}/photos`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success(`${uploadFiles.length} punch list photo${uploadFiles.length === 1 ? '' : 's'} uploaded`);
      load();
    } catch {
      toast.error('Failed to upload punch list photo');
    } finally {
      setUploadingItemPhoto(null);
    }
  };

  const savePunchPhotoPickerSelection = async (photos: any[]) => {
    if (!punchPhotoPickerItem) return;
    const photoIds = photos.map(photo => String(photo.id)).filter(Boolean);
    if (!photoIds.length) {
      setPunchPhotoPickerItem(null);
      return;
    }
    try {
      await api.post(`/projects/${projectId}/photos/assignments`, {
        target_type: 'punch_list_item',
        target_id: punchPhotoPickerItem.id,
        photo_ids: photoIds,
      });
      toast.success('Photos attached to punch item');
      setPunchPhotoPickerItem(null);
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to attach photos');
    }
  };

  const removePunchPhotoAssignment = async (assignmentId?: string | null) => {
    if (!assignmentId) return;
    try {
      await api.delete(`/projects/${projectId}/photos/assignments/${assignmentId}`);
      toast.success('Photo removed from punch item');
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to remove photo');
    }
  };

  const priorityColors: Record<string, string> = { low: 'bg-slate-500/15 text-slate-200 border border-slate-400/30', medium: 'bg-sky-500/20 text-sky-200 border border-sky-400/40', high: 'bg-orange-500/20 text-orange-200 border border-orange-400/40', urgent: 'bg-red-500/20 text-red-200 border border-red-400/40' };
  const statusColors: Record<string, string> = { not_started: 'bg-slate-500/15 text-slate-200 border border-slate-400/30', in_progress: 'bg-sky-500/20 text-sky-200 border border-sky-400/40', waiting_materials: 'bg-orange-500/20 text-orange-200 border border-orange-400/40', needs_review: 'bg-fuchsia-500/20 text-fuchsia-200 border border-fuchsia-400/40', completed: 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/40' };

  return (
    <div className="space-y-4">
      <div className={`rounded-2xl border p-4 shadow-[0_18px_44px_rgba(2,6,23,0.34)] ${isActive ? 'border-amber-300/60 bg-gradient-to-br from-slate-950 via-amber-950/50 to-blue-950' : 'border-cyan-300/40 bg-gradient-to-br from-slate-950 via-slate-900 to-blue-950'}`}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xl font-black tracking-normal text-white">{isActive ? 'Punch List Active' : 'Start Punch List'}</h3>
              {isActive && <span className="rounded-full border border-amber-400/40 bg-amber-500/20 px-3 py-1 text-xs font-black uppercase tracking-wide text-amber-200">Punch List Active</span>}
              <span className="rounded-full border border-emerald-400/50 bg-emerald-500/20 px-3 py-1 text-xs font-black uppercase tracking-wide text-emerald-200">Active Rehab</span>
            </div>
            <p className="mt-2 text-sm font-semibold leading-6 text-slate-100">Punch list is the final 90% completion workflow. It stays separate from scope of work and only opens when management activates it.</p>
          </div>
          {!isActive && (
            <button
              type="button"
              onClick={onActivate}
              disabled={!canActivate || activating}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-amber-200/70 bg-gradient-to-br from-amber-300 to-amber-500 px-4 py-2.5 text-sm font-black text-slate-950 shadow-[0_10px_24px_rgba(245,158,11,0.25)] transition hover:from-amber-200 hover:to-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
              title={canActivate ? 'Activate punch list for this project' : 'Only management can activate punch list'}
            >
              <ClipboardList className="h-4 w-4" />
              {activating ? 'Activating...' : 'Activate Punch List'}
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-2">
        <div className="flex gap-1 flex-1 overflow-x-auto">
          {[['', 'All'], ['not_started', 'Open'], ['in_progress', 'In Progress'], ['completed', 'Done'], ['urgent', 'Urgent']].map(([val, label]) => (
            <button key={val} onClick={() => setFilter(val)} className={`px-3 py-1.5 rounded-lg text-xs font-black whitespace-nowrap transition-colors ${filter === val ? 'border border-blue-300 bg-blue-600 text-white shadow-[0_0_14px_rgba(37,99,235,0.28)]' : 'border border-slate-600 bg-slate-950 text-slate-100 hover:border-cyan-300 hover:bg-slate-900 hover:text-cyan-50'}`}>{label}</button>
          ))}
        </div>
        <button disabled={!isActive} onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-blue-300/55 bg-blue-600 text-xs font-black text-white shadow-sm transition-colors flex-shrink-0 hover:bg-blue-500 disabled:cursor-not-allowed disabled:border-slate-600 disabled:bg-slate-900 disabled:text-slate-400" title={isActive ? 'Add punch list item' : 'Activate punch list before adding items'}>
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
      </div>

      {loading ? <Loading /> : (
        <div className="space-y-2">
          {items.map(item => {
            const itemAiMeta = aiAgentMeta(item);
            return (
            <div key={item.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="p-4 flex items-start gap-3">
                <button
                  disabled={!isActive}
                  onClick={() => updateStatus(item.id, item.status === 'completed' ? 'not_started' : 'completed')}
                  className={`w-5 h-5 rounded-full border-2 flex-shrink-0 mt-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${item.status === 'completed' ? 'bg-green-500 border-green-500' : 'border-gray-300 hover:border-green-400'}`}
                >
                  {item.status === 'completed' && <svg className="w-full h-full text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                </button>
                <div className="flex-1 min-w-0" onClick={() => setExpandedItem(expandedItem === item.id ? null : item.id)}>
                  <div className="flex items-start justify-between gap-2">
                    <p className={`text-sm font-medium ${item.status === 'completed' ? 'line-through text-gray-400' : 'text-gray-900'}`}>{item.title}</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${priorityColors[item.priority]}`}>{item.priority}</span>
                  </div>
                  {item.description && <p className="text-xs text-gray-500 mt-0.5 truncate">{item.description}</p>}
                  <div className="flex flex-wrap items-center gap-2 mt-1.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[item.status]}`}>{item.status.replace(/_/g, ' ')}</span>
                    {itemAiMeta && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-black text-violet-700" title={itemAiMeta.rawTranscript || undefined}>
                        <Bot className="h-3 w-3" /> AI Agent: {itemAiMeta.agentName}
                      </span>
                    )}
                    {item.assigned_to_name && <span className="text-xs text-gray-500">→ {item.assigned_to_name}</span>}
                    {item.due_date && <span className="text-xs text-gray-400">{format(new Date(item.due_date), 'MMM d')}</span>}
                    {item.photo_count > 0 && <span className="text-xs text-blue-500">{item.photo_count} photos</span>}
                  </div>
                </div>
                {canDelete && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); deleteItem(item.id, item.title); }}
                    title="Delete punch list item"
                    aria-label={`Delete ${item.title}`}
                    className="flex-shrink-0 rounded-lg border border-red-400/40 bg-red-500/15 p-1.5 text-red-300 transition-colors hover:bg-red-500/30 hover:text-red-200"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
              {expandedItem === item.id && (
                <div className="px-4 pb-4 border-t border-gray-100 pt-3">
                  {item.description && (
                    <div className="mb-3 rounded-lg bg-gray-50 p-3">
                      <p className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-1">Description</p>
                      <p className="text-sm text-gray-700 whitespace-pre-wrap">{item.description}</p>
                    </div>
                  )}
                  {itemAiMeta && (
                    <div className="mb-3 rounded-lg border border-violet-100 bg-violet-50 p-3">
                      <p className="text-xs font-black uppercase tracking-wide text-violet-700">Created by AI Agent: {itemAiMeta.agentName}</p>
                      <p className="mt-1 text-xs font-semibold text-violet-700">Source: {itemAiMeta.source}{itemAiMeta.requestId ? ` | Request: ${itemAiMeta.requestId}` : ''}</p>
                      {itemAiMeta.rawTranscript && <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-violet-900">{itemAiMeta.rawTranscript}</p>}
                    </div>
                  )}
                  <div className="flex gap-2 flex-wrap">
                    {['not_started', 'in_progress', 'waiting_materials', 'needs_review', 'completed'].map(s => (
                      <button key={s} disabled={!isActive} onClick={() => updateStatus(item.id, s)} className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${item.status === s ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{s.replace(/_/g, ' ')}</button>
                    ))}
                    <label
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold text-blue-700 bg-blue-50 border border-blue-100 cursor-pointer hover:bg-blue-100 transition-colors"
                      {...fileDropHandlers(files => uploadItemPhoto(item.id, files), {
                        accept: 'image/*',
                        disabled: !isActive || uploadingItemPhoto === item.id,
                        multiple: true,
                      })}
                    >
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        multiple
                        className="hidden"
                        disabled={!isActive || uploadingItemPhoto === item.id}
                        onChange={e => {
                          uploadItemPhoto(item.id, e.target.files);
                          e.currentTarget.value = '';
                        }}
                      />
                      <Camera className="w-3.5 h-3.5" />
                      {uploadingItemPhoto === item.id ? 'Uploading...' : 'Add Photo'}
                    </label>
                    <button
                      type="button"
                      disabled={!isActive}
                      onClick={() => setPunchPhotoPickerItem(item)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-200 bg-cyan-50 px-2.5 py-1 text-xs font-bold text-cyan-700 transition-colors hover:bg-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Camera className="w-3.5 h-3.5" />
                      Use Bucket Photo
                    </button>
                  </div>
                  {Array.isArray(item.photos) && item.photos.length > 0 && (
                    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <p className="text-xs font-black uppercase tracking-wide text-slate-500">Attached photos</p>
                        <span className="rounded-full bg-white px-2 py-0.5 text-xs font-black text-slate-600">{item.photos.length}</span>
                      </div>
                      <div className="flex gap-2 overflow-x-auto pb-1">
                        {item.photos.map((photo: any) => {
                          const mediaKind = getProgressMediaKind(photo);
                          const src = progressPhotoSrc(projectId, photo);
                          return (
                            <div key={photo.assignment_id || photo.id} className="group relative h-20 w-24 flex-shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                              {mediaKind === 'video' ? (
                                <video src={src} className="h-full w-full object-cover" muted playsInline preload="metadata" />
                              ) : mediaKind === 'image' ? (
                                <img src={src} alt={photo.original_name || 'Punch list photo'} className="h-full w-full object-cover" loading="lazy" />
                              ) : (
                                <UnsupportedProgressMediaTile name={photo.original_name || photo.filename} />
                              )}
                              {mediaKind === 'image' && (
                                <button
                                  type="button"
                                  onClick={() => setMarkupPhoto(photo)}
                                  className="absolute left-1 top-1 hidden rounded-md border border-amber-300 bg-amber-500 px-1.5 py-1 text-[10px] font-black text-slate-950 shadow-sm group-hover:inline-flex"
                                  aria-label="Mark up photo"
                                >
                                  Mark
                                </button>
                              )}
                              {photo.assignment_id && (
                                <button
                                  type="button"
                                  onClick={() => removePunchPhotoAssignment(photo.assignment_id)}
                                  className="absolute right-1 top-1 hidden rounded-md border border-red-300 bg-red-600 px-1.5 py-1 text-[10px] font-black text-white shadow-sm group-hover:inline-flex"
                                  aria-label="Remove photo from punch item"
                                >
                                  Remove
                                </button>
                              )}
                              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 py-1 text-[10px] font-black text-white">
                                {photo.individual_note || photo.batch_note || photo.caption || photo.original_name || 'Photo'}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {item.notes && <p className="text-xs text-gray-600 mt-2 bg-gray-50 rounded-lg p-2">{item.notes}</p>}
                </div>
              )}
            </div>
          );
          })}
          {items.length === 0 && <div className="text-center py-12 bg-white rounded-xl border border-gray-200"><ClipboardList className="w-8 h-8 text-gray-300 mx-auto mb-2" /><p className="text-gray-400 text-sm">No punch list items</p></div>}
        </div>
      )}

      <Modal isOpen={showAdd && isActive} onClose={() => { setShowAdd(false); reset(); }} title="Add Punch List Item">
        <form onSubmit={handleSubmit(onAdd)} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Title *</label>
            <input {...register('title', { required: true })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Task title" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description *</label>
            <textarea {...register('description', { required: true })} rows={3} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" placeholder="Describe the work, issue, location, or materials needed..." />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
              <select {...register('priority')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Due Date</label>
              <input type="date" {...register('due_date')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <VoiceTextarea {...register('notes')} rows={2} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={() => { setShowAdd(false); reset(); }} className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">Add Item</button>
          </div>
        </form>
      </Modal>
      <PhotoBucketPickerModal
        projectId={projectId}
        isOpen={Boolean(punchPhotoPickerItem)}
        title={punchPhotoPickerItem ? `Attach photos to ${punchPhotoPickerItem.title}` : 'Attach photos to punch item'}
        initialSelectedIds={[]}
        onClose={() => setPunchPhotoPickerItem(null)}
        onSave={savePunchPhotoPickerSelection}
      />
      <PhotoMarkupModal
        open={Boolean(markupPhoto)}
        projectId={projectId}
        photo={markupPhoto}
        onClose={() => setMarkupPhoto(null)}
        onSaved={async () => { await load(); setMarkupPhoto(null); }}
      />
    </div>
  );
}

function ProgressHistoryTab({ projectId, project }: { projectId: string; project: any }) {
  const [notes, setNotes] = useState<any[]>([]);
  const [photos, setPhotos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<ProgressLightboxState | null>(null);
  const [deletingPhotoId, setDeletingPhotoId] = useState('');

  const load = async () => {
    try {
      const [notesRes, photosRes] = await Promise.all([
        api.get(`/projects/${projectId}/notes`).catch(() => ({ data: [] })),
        api.get(`/projects/${projectId}/photos?type=progress`).catch(() => ({ data: [] })),
      ]);
      setNotes(Array.isArray(notesRes.data) ? notesRes.data : []);
      setPhotos(Array.isArray(photosRes.data) ? photosRes.data : []);
      setLastUpdated(new Date().toISOString());
    } catch {
      toast.error('Failed to load project progress history');
    } finally {
      setLoading(false);
    }
  };

  const deleteProgressPhotos = async (selectedPhotos: any[]) => {
    if (deletingPhotoId) return;
    const eligiblePhotos = selectedPhotos.filter(photo => photo?.can_delete_correction);
    if (!eligiblePhotos.length) {
      toast.error('Select at least one eligible progress picture to delete.');
      return;
    }
    const confirmed = window.confirm(`Delete ${eligiblePhotos.length} selected progress picture${eligiblePhotos.length === 1 ? '' : 's'}? This removes them from this project and locks correction for the selected upload record${eligiblePhotos.length === 1 ? '' : 's'}.`);
    if (!confirmed) return;
    setDeletingPhotoId('__batch__');
    try {
      const results = await Promise.allSettled(
        eligiblePhotos.map(photo => api.delete(`/projects/${projectId}/photos/${photo.id}`))
      );
      const deleted = results.filter(result => result.status === 'fulfilled').length;
      const failed = results.length - deleted;
      if (deleted) toast.success(`${deleted} progress picture${deleted === 1 ? '' : 's'} removed.`);
      if (failed) toast.error(`${failed} progress picture${failed === 1 ? '' : 's'} could not be deleted.`);
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to delete selected photos');
    } finally {
      setDeletingPhotoId('');
    }
  };

  useEffect(() => {
    load();
    const interval = window.setInterval(load, 30000);
    return () => window.clearInterval(interval);
  }, [projectId]);

  const attachedPhotoKeys = useMemo(() => {
    const keys = new Set<string>();
    notes.forEach(note => {
      getNotePhotos(note).forEach((photo: any) => {
        if (photo?.id) keys.add(`id:${photo.id}`);
        if (photo?.filename) keys.add(`filename:${photo.filename}`);
      });
    });
    return keys;
  }, [notes]);

  const formatNoteType = (value?: string | null) =>
    String(value || 'general')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, char => char.toUpperCase());

  const standalonePhotos = useMemo(
    () => photos.filter(photo => {
      if (photo.note_id) return false;
      if (photo.id && attachedPhotoKeys.has(`id:${photo.id}`)) return false;
      if (photo.filename && attachedPhotoKeys.has(`filename:${photo.filename}`)) return false;
      return true;
    }),
    [photos, attachedPhotoKeys]
  );

  const records = useMemo(() => {
    const noteRecords = notes
      .filter(note => note.created_at && (String(note.note || '').trim() || getNotePhotos(note).length))
      .map(note => ({
        id: `note-${note.id}`,
        kind: 'note',
        timestamp: note.created_at,
        userName: note.user_name || 'Unknown user',
        userAvatarUrl: note.user_avatar_url || null,
        noteText: note.note,
        noteType: note.note_type || 'general',
        visibility: note.visibility || 'private',
        photos: getNotePhotos(note),
      }));

    const mediaRecords = groupStandaloneProgressMedia(standalonePhotos, 20);

    return [...noteRecords, ...mediaRecords]
      .filter(record => record.timestamp)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [notes, standalonePhotos]);

  const groupedRecords = groupProgressRecordsByDay(records);
  const attachedMediaCount = notes.reduce((count, note) => count + getNotePhotos(note).length, 0);
  const standaloneMediaCount = standalonePhotos.length;

  const saveProgressGroupNote = async (record: any, note: string) => {
    const photoIds = (record.photos || []).map((photo: any) => photo.id).filter(Boolean);
    if (!photoIds.length) {
      toast.error('No photos are available for this description');
      return;
    }
    try {
      await api.put(`/projects/${projectId}/photos/batch-note`, { photo_ids: photoIds, note });
      toast.success(note.trim() ? 'Progress picture group description saved' : 'Progress picture group description cleared');
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to save progress picture group description');
    }
  };

  if (loading) return <Loading />;

  return (
    <div className="space-y-4">
      <div
        className="relative overflow-hidden rounded-md border border-blue-400/50 px-4 py-4 shadow-[0_22px_60px_rgba(2,6,23,0.38)]"
        style={{
          background: 'radial-gradient(110% 120% at 8% 0%, rgba(37,99,235,0.28), transparent 44%), radial-gradient(100% 90% at 92% 10%, rgba(245,158,11,0.18), transparent 42%), linear-gradient(135deg, rgba(15,23,42,0.98) 0%, rgba(17,24,39,0.96) 50%, rgba(8,47,73,0.74) 100%)',
        }}
      >
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-blue-500 via-cyan-300 to-amber-300" />
        <div className="relative flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-wide text-amber-200">Project Record</p>
            <h2 className="mt-1 text-xl font-black text-white">Progress Notes</h2>
            <p className="mt-1 text-sm font-bold text-blue-100">{project?.address || 'Project progress'} </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={load}
              className="rounded-md border border-blue-300/40 bg-blue-500/20 px-3 py-2 text-xs font-black text-blue-50 shadow-[0_0_18px_rgba(59,130,246,0.22)] hover:bg-blue-500/30"
            >
              Refresh now
            </button>
          </div>
        </div>
        <div className="relative mt-4 grid gap-2 sm:grid-cols-4">
          <div className="rounded-md border border-white/10 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]" style={{ background: 'linear-gradient(135deg, rgba(15,23,42,0.92), rgba(30,41,59,0.76))' }}>
            <p className="text-xl font-black text-white">{notes.length}</p>
            <p className="text-xs font-black uppercase tracking-wide text-slate-300">Notes</p>
          </div>
          <div className="rounded-md border border-blue-300/40 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]" style={{ background: 'linear-gradient(135deg, rgba(37,99,235,0.24), rgba(15,23,42,0.84))' }}>
            <p className="text-xl font-black text-blue-100">{attachedMediaCount}</p>
            <p className="text-xs font-black uppercase tracking-wide text-blue-100">Attached media</p>
          </div>
          <div className="rounded-md border border-amber-300/50 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]" style={{ background: 'linear-gradient(135deg, rgba(245,158,11,0.24), rgba(69,26,3,0.52))' }}>
            <p className="text-xl font-black text-amber-100">{standaloneMediaCount}</p>
            <p className="text-xs font-black uppercase tracking-wide text-amber-100">Standalone media</p>
          </div>
          <div className="rounded-md border border-cyan-300/40 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]" style={{ background: 'linear-gradient(135deg, rgba(8,47,73,0.72), rgba(15,23,42,0.88))' }}>
            <p className="text-sm font-black text-cyan-50">{lastUpdated ? formatEasternDateTime(lastUpdated, { hour: 'numeric', minute: '2-digit' }) : '-'}</p>
            <p className="text-xs font-black uppercase tracking-wide text-cyan-100">Last refresh</p>
          </div>
        </div>
      </div>

      {records.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white p-10 text-center shadow-sm">
          <MessageSquare className="mx-auto mb-3 h-10 w-10 text-slate-300" />
          <p className="font-bold text-slate-600">No progress notes yet</p>
        </div>
      ) : (
        groupedRecords.map(group => (
          <section key={group.date} className="space-y-2">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2">
              <h3 className="text-sm font-black text-slate-950">{group.date}</h3>
              <span className="text-xs font-bold text-slate-500">{group.records.length} item{group.records.length === 1 ? '' : 's'}</span>
            </div>
            {group.records.map(record => (
              <article
                key={record.id}
                className={`bt-project-progress-card rounded-lg border bg-white p-3 shadow-sm ${record.kind === 'note' ? 'border-slate-200 border-l-4 border-l-blue-500' : 'border-amber-200 border-l-4 border-l-amber-500'}`}
              >
                <div className="flex min-w-0 gap-3">
                  <Avatar src={record.userAvatarUrl} name={record.userName} size={38} roundedClassName="rounded-full" />
                  <div className="min-w-0">
                    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <p className="text-sm font-black text-slate-950">
                        {record.kind === 'note' ? 'Entered by' : 'Uploaded by'} {record.userName}
                      </p>
                      <p className="text-xs font-semibold text-slate-500">
                        Inserted {formatEasternDateTime(record.timestamp, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} New York time
                      </p>
                      {record.kind === 'note' && record.photos.length > 0 && (
                        <p className="text-xs font-bold text-blue-700">{record.photos.length} attached</p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {record.kind === 'note' ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2 py-1 text-xs font-black text-blue-700">
                          <MessageSquare className="h-3.5 w-3.5" />
                          Note
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-1 text-xs font-black text-amber-700">
                          <Camera className="h-3.5 w-3.5" />
                          Progress Pictures
                        </span>
                      )}
                      {record.kind === 'media' && (
                        <span className="rounded-full bg-amber-50 px-2 py-1 text-xs font-bold text-amber-700">
                          {record.photos.length} item{record.photos.length === 1 ? '' : 's'}
                        </span>
                      )}
                      {record.kind === 'note' && (
                        <>
                          <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-bold text-slate-600">{formatNoteType(record.noteType)}</span>
                          <span className={`rounded-full px-2 py-1 text-xs font-bold ${record.visibility === 'public' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
                            {record.visibility === 'public' ? 'Public to contractors' : 'Private management note'}
                          </span>
                        </>
                      )}
                    </div>
                    {record.kind === 'media' ? (
                      <ProgressGroupNoteEditor
                        initialNote={record.noteText || ''}
                        photoCount={record.photos.length}
                        onSave={(note) => saveProgressGroupNote(record, note)}
                      />
                    ) : record.noteText && (
                      <div className={`bt-project-progress-note-body ${record.kind === 'media' ? 'mt-2 max-h-16' : 'mt-2 max-h-28'} overflow-y-auto whitespace-pre-wrap pr-2 text-sm leading-6 text-slate-700`}>
                        {record.noteText}
                      </div>
                    )}
                    <ProgressMediaGrid
                      projectId={projectId}
                      photos={record.photos}
                      maxItems={20}
                      onLightbox={(items, index) => setLightbox({ items, index })}
                      onDeleteSelected={deleteProgressPhotos}
                      deletingPhotoId={deletingPhotoId}
                      onPhotoNoteSaved={load}
                    />
                  </div>
                </div>
              </article>
            ))}
          </section>
        ))
      )}

      <ProgressMediaLightbox state={lightbox} onChange={setLightbox} />
    </div>
  );
}

function ProgressGroupNoteEditor({
  initialNote,
  photoCount,
  onSave,
}: {
  initialNote: string;
  photoCount: number;
  onSave: (note: string) => Promise<void> | void;
}) {
  const [note, setNote] = useState(initialNote || '');
  const [saving, setSaving] = useState(false);
  const [voiceStopSignal, setVoiceStopSignal] = useState(0);

  useEffect(() => {
    setNote(initialNote || '');
  }, [initialNote]);

  const normalizedNote = note.trim();
  const normalizedInitial = String(initialNote || '').trim();
  const changed = normalizedNote !== normalizedInitial;

  const save = async (nextNote = normalizedNote) => {
    if (saving) return;
    setVoiceStopSignal(current => current + 1);
    setSaving(true);
    try {
      await onSave(nextNote);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bt-progress-group-note mt-3">
      <div className="bt-progress-group-note-header">
        <div className="bt-progress-group-note-title">
          <div className="bt-progress-group-note-icon">
            <MessageSquare className="h-4 w-4" />
          </div>
          <div>
            <p>Picture group description</p>
            <span>{photoCount} progress picture{photoCount === 1 ? '' : 's'} share this description</span>
          </div>
        </div>
        <div className="bt-progress-group-note-chips">
          <span>{normalizedInitial ? 'Saved description' : 'No saved description'}</span>
          {changed ? <span className="is-warning">Unsaved changes</span> : null}
        </div>
      </div>

      {normalizedInitial ? (
        <div className="bt-progress-group-note-preview" aria-label="Saved picture group description">
          <span>Combined group description</span>
          <p>{normalizedInitial}</p>
        </div>
      ) : null}

      <div className="bt-progress-group-note-compose">
        <VoiceTextarea
          value={note}
          onChange={event => setNote(event.target.value)}
          rows={4}
          disabled={saving}
          stopSignal={voiceStopSignal}
          placeholder="Add one clean description that applies to this full picture group..."
          wrapperClassName="bt-progress-group-note-input-wrap"
          className="bt-progress-group-note-field"
          buttonClassName="bt-progress-group-note-mic"
        />
        <div className="bt-progress-group-note-actions">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !changed || !normalizedNote}
            className="bt-progress-group-note-save"
          >
            <MessageSquare className="h-4 w-4" />
            {saving ? 'Saving...' : normalizedInitial ? 'Update description' : 'Save description'}
          </button>
          {(normalizedInitial || normalizedNote) && (
            <button
              type="button"
              onClick={() => void save('')}
              disabled={saving || (!normalizedInitial && !normalizedNote)}
              className="bt-progress-group-note-clear"
            >
              Clear description
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ProgressMediaGrid({
  projectId,
  photos,
  maxItems,
  onLightbox,
  onDeleteSelected,
  deletingPhotoId,
  onPhotoNoteSaved,
}: {
  projectId: string;
  photos: any[];
  maxItems: number;
  onLightbox: (items: ProgressLightboxItem[], index: number) => void;
  onDeleteSelected?: (photos: any[]) => Promise<void>;
  deletingPhotoId?: string;
  onPhotoNoteSaved?: (photo: any) => Promise<void> | void;
}) {
  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [notePhoto, setNotePhoto] = useState<any | null>(null);
  if (!photos.length) return null;
  const visiblePhotos = photos.slice(0, maxItems);
  const hiddenCount = photos.length - visiblePhotos.length;
  const lightboxItems = buildProgressLightboxItems(projectId, visiblePhotos);
  const selectablePhotos = visiblePhotos.filter(photo => photo.can_delete_correction);
  const selectedPhotos = selectablePhotos.filter(photo => selectedIds.has(progressPhotoKey(photo)));
  const deleting = Boolean(deletingPhotoId);

  const toggleSelection = (photo: any) => {
    if (!photo.can_delete_correction || deleting) return;
    const key = progressPhotoKey(photo);
    setSelectedIds(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const closeDeleteMode = () => {
    setDeleteMode(false);
    setSelectedIds(new Set());
  };

  const deleteSelected = async () => {
    if (!onDeleteSelected || !selectedPhotos.length || deleting) return;
    await onDeleteSelected(selectedPhotos);
    closeDeleteMode();
  };

  return (
    <div className="bt-project-progress-media-grid mt-3 rounded-lg border border-slate-100 bg-slate-50/70 p-2">
      {selectablePhotos.length > 0 && onDeleteSelected && (
        <div className="mb-2 flex flex-wrap items-center justify-center gap-2 rounded-lg border border-red-500/40 bg-red-950/25 px-2 py-2 shadow-inner">
          {!deleteMode ? (
            <button
              type="button"
              onClick={() => setDeleteMode(true)}
              className="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border border-red-400 bg-red-600 px-3 text-xs font-black text-white shadow-lg shadow-red-950/30 transition hover:border-red-300 hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-red-300"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete pictures
            </button>
          ) : (
            <>
              <span className="text-xs font-black text-red-100">Select pictures to delete</span>
              <button
                type="button"
                onClick={() => void deleteSelected()}
                disabled={!selectedPhotos.length || deleting}
                className="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border border-red-400 bg-red-600 px-3 text-xs font-black text-white shadow-lg shadow-red-950/30 transition hover:bg-red-500 disabled:cursor-not-allowed disabled:border-red-300 disabled:bg-red-300 disabled:text-red-950"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {deleting ? 'Deleting...' : `Delete selected${selectedPhotos.length ? ` (${selectedPhotos.length})` : ''}`}
              </button>
              <button
                type="button"
                onClick={closeDeleteMode}
                disabled={deleting}
                className="inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 text-xs font-black text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
      {visiblePhotos.map(photo => {
        const src = progressPhotoSrc(projectId, photo);
        const mediaKind = getProgressMediaKind(photo);
        const isVideo = mediaKind === 'video';
        const timestamp = getProgressTimestamp(photo);
        const key = progressPhotoKey(photo);
        const isSelected = selectedIds.has(key);
        const lightboxIndex = lightboxItems.findIndex(item => item.id === key);
        const hasNote = Boolean(getProgressPhotoNoteText(photo));

        return (
          <div
            key={key}
            role="button"
            tabIndex={0}
            onClick={() => {
              if (deleteMode) {
                toggleSelection(photo);
                return;
              }
              if (mediaKind === 'file') window.open(src, '_blank', 'noopener,noreferrer');
              else if (lightboxIndex >= 0) onLightbox(lightboxItems, lightboxIndex);
            }}
            onKeyDown={event => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              if (deleteMode) {
                toggleSelection(photo);
                return;
              }
              if (mediaKind === 'file') window.open(src, '_blank', 'noopener,noreferrer');
              else if (lightboxIndex >= 0) onLightbox(lightboxItems, lightboxIndex);
            }}
            className={`group relative h-20 w-20 flex-shrink-0 cursor-pointer overflow-hidden rounded-lg border bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md md:h-24 md:w-24 ${deleteMode && photo.can_delete_correction ? 'ring-2 ring-red-200' : 'border-slate-200'} ${isSelected ? 'border-red-500 ring-4 ring-red-300' : ''} ${deleteMode && !photo.can_delete_correction ? 'cursor-not-allowed opacity-60' : ''}`}
            aria-label={deleteMode ? `Select ${photo.original_name || 'photo'} for deletion` : photo.original_name || 'Open photo'}
            aria-pressed={deleteMode ? isSelected : undefined}
          >
            {isVideo ? (
              <>
                <video src={src} className="h-full w-full object-cover" muted playsInline preload="metadata" />
                <PlayCircle className="absolute inset-0 m-auto h-7 w-7 text-white drop-shadow" />
              </>
            ) : mediaKind === 'image' ? (
              <img src={src} alt={photo.original_name || 'Progress picture'} className="h-full w-full object-cover" loading="lazy" />
            ) : (
              <UnsupportedProgressMediaTile name={photo.original_name || photo.filename} />
            )}
            {mediaKind !== 'file' && (
              <div className="absolute inset-x-0 top-0 bg-gradient-to-b from-black/45 to-transparent px-1.5 py-1 text-[10px] font-black uppercase tracking-wide text-white opacity-0 transition-opacity group-hover:opacity-100">
                {deleteMode ? 'Select to delete' : 'Click to expand'}
              </div>
            )}
            {deleteMode && (
              <div className={`absolute right-1 top-1 inline-flex h-7 w-7 items-center justify-center rounded-md border text-xs font-black shadow-sm ${isSelected ? 'border-red-500 bg-red-600 text-white' : photo.can_delete_correction ? 'border-white/80 bg-black/60 text-white' : 'border-slate-400 bg-slate-700 text-slate-300'}`}>
                {isSelected ? <Check className="h-4 w-4" /> : photo.can_delete_correction ? '' : 'X'}
              </div>
            )}
            {!deleteMode && (
              <button
                type="button"
                onClick={event => {
                  event.stopPropagation();
                  setNotePhoto(photo);
                }}
                className={`absolute right-1 top-1 z-30 inline-flex min-h-7 items-center justify-center gap-1 rounded-md border px-1.5 text-[10px] font-black shadow-sm transition ${hasNote ? 'border-amber-300 bg-amber-500 text-slate-950 hover:bg-amber-400' : 'border-white/70 bg-black/65 text-white hover:border-amber-300 hover:text-amber-200'}`}
                aria-label={`${hasNote ? 'Edit' : 'Add'} description for ${photo.original_name || 'progress picture'}`}
              >
                <MessageSquare className="h-3 w-3" />
                {hasNote ? 'Desc' : 'Add desc'}
              </button>
            )}
            {timestamp && (
              <div className="absolute bottom-1 left-1 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-black text-white">
                {formatEasternDateTime(timestamp, { hour: 'numeric', minute: '2-digit' })}
              </div>
            )}
          </div>
        );
      })}
      {hiddenCount > 0 && (
        <div className="bt-project-progress-hidden-count flex h-20 w-20 flex-shrink-0 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white text-sm font-black text-slate-500 md:h-24 md:w-24">
          +{hiddenCount}
        </div>
      )}
      </div>
      <PhotoNoteModal
        projectId={projectId}
        photo={notePhoto}
        onClose={() => setNotePhoto(null)}
        onSaved={async updatedPhoto => {
          setNotePhoto(null);
          await onPhotoNoteSaved?.(updatedPhoto);
        }}
      />
    </div>
  );
}

function ProgressMediaLightbox({
  state,
  onChange,
}: {
  state: ProgressLightboxState | null;
  onChange: Dispatch<SetStateAction<ProgressLightboxState | null>>;
}) {
  const activeItem = state?.items[state.index] || null;
  const itemCount = state?.items.length || 0;

  const move = useCallback((direction: -1 | 1) => {
    onChange(current => {
      if (!current || current.items.length < 2) return current;
      const nextIndex = (current.index + direction + current.items.length) % current.items.length;
      return { ...current, index: nextIndex };
    });
  }, [onChange]);

  useEffect(() => {
    if (!state) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onChange(null);
      if (event.key === 'ArrowLeft') move(-1);
      if (event.key === 'ArrowRight') move(1);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [move, onChange, state]);

  if (!state || !activeItem) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4" onClick={() => onChange(null)}>
      <div className="relative flex h-[90dvh] max-h-[90vh] w-[94vw] max-w-7xl flex-col overflow-hidden rounded-xl border border-white/20 bg-slate-950 shadow-2xl" onClick={event => event.stopPropagation()}>
        <div className="flex min-h-14 items-center justify-between gap-3 border-b border-white/10 bg-black/45 px-4 py-3">
          <div className="min-w-0">
            <p className="text-[11px] font-black uppercase tracking-wide text-orange-300">Progress picture preview</p>
            <h3 className="truncate text-sm font-black text-white">{activeItem.name || 'Progress picture'}</h3>
            <p className="truncate text-xs font-semibold text-white/60">
              {activeItem.meta || 'Project media'}{itemCount > 1 ? ` - ${state.index + 1} of ${itemCount}` : ''}
            </p>
          </div>
          <button
            type="button"
            className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-white/20 bg-white/10 text-white transition hover:border-orange-300 hover:text-orange-200"
            onClick={() => onChange(null)}
            aria-label="Close progress picture preview"
          >
            <XIcon />
          </button>
        </div>

        <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
          {activeItem.isVideo ? (
            <video key={activeItem.src} src={activeItem.src} controls autoPlay className="max-h-full max-w-full object-contain" />
          ) : (
            <img key={activeItem.src} src={activeItem.src} alt={activeItem.name || 'Progress picture'} className="max-h-full max-w-full object-contain" />
          )}

          {activeItem.noteText && (
            <div className="absolute bottom-4 left-4 right-4 max-h-36 overflow-y-auto rounded-xl border border-amber-300/40 bg-slate-950/90 p-3 shadow-2xl backdrop-blur">
              <p className="text-[11px] font-black uppercase tracking-wide text-amber-300">Picture description</p>
              <p className="mt-1 whitespace-pre-wrap text-sm font-semibold leading-6 text-white">{activeItem.noteText}</p>
            </div>
          )}

          {itemCount > 1 && (
            <>
              <button
                type="button"
                onClick={() => move(-1)}
                className="absolute left-3 top-1/2 inline-flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/70 text-white shadow-lg transition hover:border-orange-300 hover:bg-black/90 hover:text-orange-200"
                aria-label="Previous progress picture"
              >
                <ChevronLeft className="h-7 w-7" />
              </button>
              <button
                type="button"
                onClick={() => move(1)}
                className="absolute right-3 top-1/2 inline-flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/70 text-white shadow-lg transition hover:border-orange-300 hover:bg-black/90 hover:text-orange-200"
                aria-label="Next progress picture"
              >
                <ChevronRight className="h-7 w-7" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PhotoNoteModal({
  projectId,
  photo,
  onClose,
  onSaved,
}: {
  projectId: string;
  photo: any | null;
  onClose: () => void;
  onSaved: (photo: any) => Promise<void> | void;
}) {
  const [noteText, setNoteText] = useState('');
  const [saving, setSaving] = useState(false);
  const [voiceStopSignal, setVoiceStopSignal] = useState(0);
  const [markupOpen, setMarkupOpen] = useState(false);
  const mediaKind = photo ? getProgressMediaKind(photo) : 'image';
  const src = photo ? progressPhotoSrc(projectId, photo) : '';
  const existingNote = getProgressPhotoNoteText(photo);

  useEffect(() => {
    setNoteText(existingNote);
  }, [photo?.id, photo?.filename, existingNote]);

  if (!photo) return null;

  const saveNote = async (overrideNote?: string) => {
    if (!photo.id || saving) return;
    const nextNote = overrideNote ?? noteText;
    setVoiceStopSignal(current => current + 1);
    setSaving(true);
    try {
      const res = await api.put(`/projects/${projectId}/photos/${photo.id}/note`, { note: nextNote });
      const updatedPhoto = res.data?.photo || res.data;
      toast.success(nextNote.trim() ? 'Photo description entered' : 'Photo description cleared');
      setSaving(false);
      await onSaved(updatedPhoto);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to save photo description');
      setSaving(false);
    }
  };

  return (
    <>
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-3xl overflow-hidden rounded-xl border border-amber-400/40 bg-slate-950 shadow-2xl" onClick={event => event.stopPropagation()}>
        <div
          className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3"
          style={{ background: 'linear-gradient(135deg, rgba(15,23,42,0.98), rgba(69,26,3,0.72))' }}
        >
          <div className="min-w-0">
            <p className="text-[11px] font-black uppercase tracking-wide text-amber-300">Picture description</p>
            <h3 className="truncate text-sm font-black text-white">{photo.original_name || photo.filename || 'Project picture'}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-white/20 bg-white/10 text-white transition hover:border-amber-300 hover:text-amber-200"
            aria-label="Close picture description"
          >
            <XIcon />
          </button>
        </div>

        <div className="grid gap-4 p-4 md:grid-cols-[260px_minmax(0,1fr)]">
          <div className="overflow-hidden rounded-lg border border-white/10 bg-black">
            <div className="aspect-square">
              {mediaKind === 'video' ? (
                <video src={src} className="h-full w-full object-cover" controls />
              ) : mediaKind === 'image' ? (
                <img src={src} alt={photo.original_name || 'Project picture'} className="h-full w-full object-cover" />
              ) : (
                <UnsupportedProgressMediaTile name={photo.original_name || photo.filename} />
              )}
            </div>
          </div>

          <div className="space-y-3">
            <label className="block">
              <span className="mb-2 block text-xs font-black uppercase tracking-wide text-slate-300">Photo description</span>
              <VoiceTextarea
                value={noteText}
                onChange={event => setNoteText(event.target.value)}
                rows={8}
                disabled={saving}
                stopSignal={voiceStopSignal}
                className="w-full resize-none rounded-lg border border-amber-300/30 bg-slate-900 px-3 py-2 text-sm font-semibold leading-6 text-white outline-none transition placeholder:text-slate-500 focus:border-amber-300 focus:ring-2 focus:ring-amber-300/30"
                placeholder="Describe what this picture shows..."
                autoFocus
              />
            </label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
              {mediaKind === 'image' && (
                <button
                  type="button"
                  onClick={() => setMarkupOpen(true)}
                  disabled={saving}
                  className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-amber-300/60 bg-slate-900 px-4 text-sm font-black text-amber-200 transition hover:border-amber-300 hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2}><ellipse cx="12" cy="12" rx="8" ry="6" /></svg>
                  Mark up
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-600 bg-slate-900 px-4 text-sm font-black text-slate-200 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void saveNote()}
                disabled={saving || !noteText.trim() || noteText.trim() === existingNote}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-amber-300 bg-amber-500 px-4 text-sm font-black text-slate-950 shadow-lg shadow-amber-950/25 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:border-slate-500 disabled:bg-slate-700 disabled:text-slate-300"
              >
                <MessageSquare className="h-4 w-4" />
                {saving ? 'Saving...' : 'Save Description'}
              </button>
              {(existingNote || noteText.trim()) && (
                <button
                  type="button"
                  onClick={() => void saveNote('')}
                  disabled={saving || (!existingNote && !noteText.trim())}
                  className="inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-600 bg-slate-900 px-4 text-sm font-black text-slate-200 transition hover:border-red-300 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Clear description
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
      <PhotoMarkupModal
        open={markupOpen}
        projectId={projectId}
        photo={photo}
        onClose={() => setMarkupOpen(false)}
        onSaved={async (updated) => {
          setMarkupOpen(false);
          await onSaved(updated);
          onClose();
        }}
      />
    </>
  );
}

function RecentFieldPhotosCard({
  projectId,
  photos,
  onViewAll,
  onPhotoNoteSaved,
}: {
  projectId: string;
  photos: any[];
  onViewAll: () => void;
  onPhotoNoteSaved: (photo: any) => Promise<void> | void;
}) {
  const projectPhotos = useMemo(
    () => filterPhotosForProject(photos, projectId),
    [photos, projectId]
  );
  const visiblePhotos = projectPhotos;
  const [notePhoto, setNotePhoto] = useState<any | null>(null);

  return (
    <>
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Recent Field Photos</h3>
            <p className="mt-1 text-xs font-semibold text-gray-500">
              {projectPhotos.length ? `${projectPhotos.length} latest project media item${projectPhotos.length === 1 ? '' : 's'}` : 'No field photos yet'}
            </p>
          </div>
          <button
            type="button"
            onClick={onViewAll}
            className="rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs font-black text-blue-700 transition hover:border-blue-300 hover:bg-blue-100"
          >
            View all
          </button>
        </div>

        {visiblePhotos.length ? (
          <div className="grid max-h-[440px] grid-cols-2 gap-2 overflow-y-auto pr-1">
            {visiblePhotos.map(photo => {
              const src = `/uploads/${projectId}/${photo.filename}`;
              const mediaKind = getProgressMediaKind(photo);
              const isVideo = mediaKind === 'video';
              const timestamp = getProgressTimestamp(photo);
              const noteText = getProgressPhotoNoteText(photo);
              const uploaderName = photo.uploader_name || photo.uploaded_by_name || 'Unknown user';

              return (
                <article
                  key={photo.id || photo.filename}
                  className="group overflow-hidden rounded-lg border border-gray-200 bg-gray-50 text-left transition hover:border-blue-300 hover:shadow-sm"
                >
                  <button
                    type="button"
                    onClick={() => setNotePhoto(photo)}
                    className="block w-full text-left"
                    aria-label={`${noteText ? 'View or edit' : 'Add'} description for ${photo.original_name || 'field photo'}`}
                  >
                    <div className="relative aspect-[4/3] bg-gray-100">
                      {isVideo ? (
                        <>
                          <video src={src} className="h-full w-full object-cover" muted playsInline preload="metadata" />
                          <PlayCircle className="absolute inset-0 m-auto h-8 w-8 text-white drop-shadow" />
                        </>
                      ) : mediaKind === 'image' ? (
                        <img src={src} alt={photo.original_name || 'Recent field photo'} className="h-full w-full object-cover" loading="lazy" />
                      ) : (
                        <UnsupportedProgressMediaTile name={photo.original_name || photo.filename} />
                      )}
                      <span className="absolute left-1.5 top-1.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide text-white">
                        {photo.photo_type || 'media'}
                      </span>
                      {noteText && (
                        <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-black text-slate-950 shadow-sm">
                          <MessageSquare className="h-3 w-3" />
                          Description
                        </span>
                      )}
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/80 to-black/20 px-2.5 py-2 text-left text-white shadow-[0_-8px_18px_rgba(0,0,0,0.35)]">
                        <p className="truncate text-[11px] font-black leading-4 text-white">
                          {formatProjectPhotoTimestamp(photo)}
                        </p>
                        <p className="truncate text-[10px] font-extrabold leading-4 text-white/90">
                          Inserted by {uploaderName}
                        </p>
                        <p className="truncate text-[9px] font-bold leading-3 text-cyan-100">
                          {formatProjectPhotoGps(photo)}
                        </p>
                        <p className="truncate text-[9px] font-bold leading-3 text-white/75">
                          {formatProjectPhotoIp(photo)}
                        </p>
                      </div>
                    </div>
                  </button>
                  <div className="space-y-1.5 p-2">
                    <p className="truncate text-xs font-black text-gray-900">
                      {uploaderName}
                    </p>
                    <p className="text-[11px] font-semibold text-gray-500">
                      {timestamp ? formatEasternDateTime(timestamp, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'No timestamp'}
                    </p>
                    {noteText && <p className="line-clamp-2 text-[11px] font-semibold leading-4 text-amber-700">{noteText}</p>}
                    <button
                      type="button"
                      onClick={() => setNotePhoto(photo)}
                      className="inline-flex min-h-7 items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 text-[11px] font-black text-amber-800 transition hover:bg-amber-100"
                    >
                      <MessageSquare className="h-3 w-3" />
                      {noteText ? 'Edit Description' : 'Add Description'}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 text-center">
            <Camera className="mx-auto mb-2 h-7 w-7 text-gray-300" />
            <p className="text-sm font-bold text-gray-500">No field photos connected yet.</p>
          </div>
        )}
      </section>
      <PhotoNoteModal
        projectId={projectId}
        photo={notePhoto}
        onClose={() => setNotePhoto(null)}
        onSaved={async updatedPhoto => {
          setNotePhoto(null);
          await onPhotoNoteSaved(updatedPhoto);
        }}
      />
    </>
  );
}

function XIcon() {
  return <svg className="h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>;
}

function UnsupportedProgressMediaTile({ name }: { name?: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center bg-slate-50 p-3 text-center">
      <FileImage className="mb-2 h-8 w-8 text-slate-400" />
      <p className="max-w-full truncate text-xs font-black text-slate-700">{name || 'Media file'}</p>
      <p className="mt-1 text-[10px] font-bold uppercase tracking-wide text-amber-700">Open file</p>
    </div>
  );
}

function PhotoBucketPickerModal({
  projectId,
  isOpen,
  title,
  initialSelectedIds,
  onClose,
  onSave,
}: {
  projectId: string;
  isOpen: boolean;
  title: string;
  initialSelectedIds: string[];
  onClose: () => void;
  onSave: (photos: any[]) => Promise<void> | void;
}) {
  const [photos, setPhotos] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(initialSelectedIds));

  useEffect(() => {
    if (!isOpen) return;
    setSelectedIds(new Set(initialSelectedIds));
    setQuery('');
    setLoading(true);
    api.get(`/projects/${projectId}/photos`)
      .then(res => setPhotos(Array.isArray(res.data) ? res.data : []))
      .catch(() => toast.error('Failed to load project photos'))
      .finally(() => setLoading(false));
  }, [isOpen, projectId, initialSelectedIds.join('|')]);

  const visiblePhotos = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return photos;
    return photos.filter(photo => [
      photo.original_name,
      photo.caption,
      photo.individual_note,
      photo.batch_note,
      photo.note_text,
      photo.uploader_name,
      photo.category_name,
      photo.label,
    ].filter(Boolean).join(' ').toLowerCase().includes(search));
  }, [photos, query]);

  const selectedPhotos = photos.filter(photo => selectedIds.has(String(photo.id)));

  const togglePhoto = (photoId: string) => {
    setSelectedIds(current => {
      const next = new Set(current);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  };

  const saveSelection = async () => {
    setSaving(true);
    try {
      await onSave(selectedPhotos);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="xl"
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-3 rounded-2xl border border-cyan-200 bg-gradient-to-br from-cyan-50 to-blue-50 p-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-black text-slate-950">Project photo bucket</p>
            <p className="mt-1 text-xs font-semibold text-slate-600">{selectedPhotos.length} selected from {photos.length} available</p>
          </div>
          <div className="flex min-h-11 min-w-0 items-center gap-2 rounded-xl border border-cyan-200 bg-white px-3">
            <Search className="h-4 w-4 flex-shrink-0 text-cyan-700" />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              aria-label="Search photos"
              className="min-w-0 flex-1 bg-transparent text-sm font-bold text-slate-950 outline-none placeholder:text-slate-400"
            />
          </div>
        </div>

        {loading ? (
          <Loading />
        ) : visiblePhotos.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
            <Camera className="mx-auto mb-2 h-8 w-8 text-slate-300" />
            <p className="text-sm font-black text-slate-600">No photos found</p>
          </div>
        ) : (
          <div className="grid max-h-[56vh] grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-3 lg:grid-cols-4">
            {visiblePhotos.map(photo => {
              const selected = selectedIds.has(String(photo.id));
              const mediaKind = getProgressMediaKind(photo);
              const src = progressPhotoSrc(projectId, photo);
              const timestamp = photo.captured_at || photo.taken_at || photo.uploaded_at || photo.created_at;
              return (
                <button
                  key={photo.id}
                  type="button"
                  onClick={() => togglePhoto(String(photo.id))}
                  className={`overflow-hidden rounded-2xl border bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg ${selected ? 'border-cyan-500 ring-4 ring-cyan-200' : 'border-slate-200'}`}
                  aria-pressed={selected}
                >
                  <div className="relative aspect-square bg-slate-100">
                    {mediaKind === 'video' ? (
                      <>
                        <video src={src} className="h-full w-full object-cover" muted playsInline preload="metadata" />
                        <PlayCircle className="absolute inset-0 m-auto h-8 w-8 text-white drop-shadow" />
                      </>
                    ) : mediaKind === 'image' ? (
                      <img src={src} alt={photo.original_name || 'Project photo'} className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <UnsupportedProgressMediaTile name={photo.original_name || photo.filename} />
                    )}
                    <span className={`absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-lg border text-xs font-black shadow-sm ${selected ? 'border-cyan-500 bg-cyan-600 text-white' : 'border-white/80 bg-black/60 text-white'}`}>
                      {selected ? <Check className="h-4 w-4" /> : ''}
                    </span>
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent p-2">
                      <p className="truncate text-xs font-black text-white">{photo.individual_note || photo.batch_note || photo.caption || photo.original_name || 'Project photo'}</p>
                    </div>
                  </div>
                  <div className="space-y-1 p-2">
                    <p className="truncate text-xs font-black text-slate-900">{photo.uploader_name || 'Unknown user'}</p>
                    <p className="text-[11px] font-semibold text-slate-500">
                      {timestamp ? formatEasternDateTime(timestamp, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'No timestamp'}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-3">
          <button type="button" onClick={onClose} className="min-h-10 rounded-xl border border-slate-300 bg-white px-4 text-sm font-black text-slate-700 hover:bg-slate-50">
            Cancel
          </button>
          <button
            type="button"
            onClick={saveSelection}
            disabled={saving}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-cyan-300 bg-cyan-600 px-4 text-sm font-black text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Camera className="h-4 w-4" />
            {saving ? 'Attaching...' : `Use ${selectedPhotos.length} Photo${selectedPhotos.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

type PhotoBucketAssignmentTargetType = 'project_scope' | 'punch_list_item' | 'construction_plan_item' | 'material' | 'project_note';

type PhotoBucketAssignmentTargetOption = {
  id: string;
  title: string;
  subtitle: string;
};

const PHOTO_BUCKET_ASSIGNMENT_TARGETS: Array<{
  type: PhotoBucketAssignmentTargetType;
  label: string;
  shortLabel: string;
  emptyLabel: string;
}> = [
  { type: 'project_scope', label: 'Scope of Work', shortLabel: 'Scopes', emptyLabel: 'No scope sections are available yet.' },
  { type: 'punch_list_item', label: 'Punch List', shortLabel: 'Punch List', emptyLabel: 'No punch list items are available yet.' },
  { type: 'construction_plan_item', label: 'Construction Plan', shortLabel: 'Plan', emptyLabel: 'No construction plan line items are available yet.' },
  { type: 'material', label: 'Materials', shortLabel: 'Materials', emptyLabel: 'No materials are available yet.' },
  { type: 'project_note', label: 'Project Notes', shortLabel: 'Notes', emptyLabel: 'No project notes are available yet.' },
];

function PhotosTab({ projectId, project, user }: { projectId: string; project: any; user: any }) {
  const [photos, setPhotos] = useState<any[]>([]);
  const [scopes, setScopes] = useState<any[]>([]);
  const [punchItems, setPunchItems] = useState<any[]>([]);
  const [planItems, setPlanItems] = useState<any[]>([]);
  const [materials, setMaterials] = useState<any[]>([]);
  const [projectNotes, setProjectNotes] = useState<any[]>([]);
  const activeProjectIdRef = useRef(projectId);
  const [loading, setLoading] = useState(true);
  const [lightbox, setLightbox] = useState<ProgressLightboxState | null>(null);
  const [notePhoto, setNotePhoto] = useState<any | null>(null);
  const [scopeAssignPhoto, setScopeAssignPhoto] = useState<any | null>(null);
  const [scopeAssignIds, setScopeAssignIds] = useState<Set<string>>(new Set());
  const [photoAssignTargetType, setPhotoAssignTargetType] = useState<PhotoBucketAssignmentTargetType>('project_scope');
  const [assigningScopes, setAssigningScopes] = useState(false);
  const [deletingPhotoId, setDeletingPhotoId] = useState('');
  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedDeleteIds, setSelectedDeleteIds] = useState<Set<string>>(new Set());
  const groupedPhotos = groupMediaByDay(photos);
  const projectLabel = projectPhotoRecordLabel(project, projectId);
  const lightboxItems = useMemo(() => buildProgressLightboxItems(projectId, photos), [projectId, photos]);
  const deletablePhotos = useMemo(() => photos.filter(photo => photo.can_delete_correction), [photos]);
  const selectedDeletePhotos = useMemo(
    () => deletablePhotos.filter(photo => selectedDeleteIds.has(progressPhotoKey(photo))),
    [deletablePhotos, selectedDeleteIds]
  );
  const photoDescriptionCount = useMemo(
    () => photos.filter(photo => getProgressPhotoNoteText(photo)).length,
    [photos]
  );
  const assignedScopeCount = useMemo(
    () => scopes.reduce((count, scope) => count + (Array.isArray(scope.photos) ? scope.photos.length : 0), 0),
    [scopes]
  );
  const assignmentTargetOptions = useMemo<Record<PhotoBucketAssignmentTargetType, PhotoBucketAssignmentTargetOption[]>>(() => ({
    project_scope: scopes.map(scope => ({
      id: String(scope.id),
      title: scope.scope_title || 'Scope of work',
      subtitle: scope.section_name || 'General',
    })),
    punch_list_item: punchItems.map(item => ({
      id: String(item.id),
      title: item.title || item.description || 'Punch list item',
      subtitle: [item.status, item.priority].filter(Boolean).join(' - ') || 'Punch list',
    })),
    construction_plan_item: planItems.map(item => ({
      id: String(item.id),
      title: item.title || item.task_name || item.description || 'Construction line item',
      subtitle: [item.stage || item.category, item.status].filter(Boolean).join(' - ') || 'Construction plan',
    })),
    material: materials.map(material => ({
      id: String(material.id),
      title: material.material_name || material.name || 'Material',
      subtitle: [material.category, material.order_status || material.status].filter(Boolean).join(' - ') || 'Material',
    })),
    project_note: projectNotes.map(note => ({
      id: String(note.id),
      title: String(note.note || 'Project note').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Project note',
      subtitle: [note.note_type || 'Note', note.user_name].filter(Boolean).join(' - '),
    })),
  }), [materials, planItems, projectNotes, punchItems, scopes]);
  const activeAssignmentConfig = PHOTO_BUCKET_ASSIGNMENT_TARGETS.find(target => target.type === photoAssignTargetType) || PHOTO_BUCKET_ASSIGNMENT_TARGETS[0];
  const activeAssignmentOptions = assignmentTargetOptions[photoAssignTargetType] || [];
  const hasPhotoAssignmentTargets = PHOTO_BUCKET_ASSIGNMENT_TARGETS.some(target => (assignmentTargetOptions[target.type]?.length || 0) > 0);
  const scopeAssignmentMap = useMemo(() => {
    const map = new Map<string, any[]>();
    scopes.forEach(scope => {
      const scopePhotos = Array.isArray(scope.photos) ? scope.photos : [];
      scopePhotos.forEach((photo: any) => {
        const photoId = String(photo?.id || '').trim();
        if (!photoId) return;
        const rows = map.get(photoId) || [];
        rows.push({
          scopeId: String(scope.id),
          scopeTitle: scope.scope_title || 'Scope of work',
          sectionName: scope.section_name || 'General',
          assignmentId: photo.assignment_id || null,
        });
        map.set(photoId, rows);
      });
    });
    return map;
  }, [scopes]);

  const load = useCallback(async () => {
    try {
      const requestProjectId = projectId;
      const [photosRes, scopesRes, punchRes, planRes, materialRes, notesRes] = await Promise.all([
        api.get(`/projects/${requestProjectId}/photos`),
        api.get(`/projects/${requestProjectId}/scopes`).catch(() => ({ data: { scopes: [] } })),
        api.get(`/projects/${requestProjectId}/punch-list`).catch(() => ({ data: [] })),
        api.get(`/projects/${requestProjectId}/construction-plan`).catch(() => ({ data: [] })),
        api.get(`/projects/${requestProjectId}/materials`).catch(() => ({ data: [] })),
        api.get(`/projects/${requestProjectId}/notes`).catch(() => ({ data: [] })),
      ]);
      if (activeProjectIdRef.current !== requestProjectId) return;
      setPhotos(sortProjectPhotosNewestFirst(filterPhotosForProject(Array.isArray(photosRes.data) ? photosRes.data : [], requestProjectId)));
      setScopes(filterScopesForProjectPhotos(Array.isArray(scopesRes.data?.scopes) ? scopesRes.data.scopes : [], requestProjectId));
      setPunchItems(Array.isArray(punchRes.data) ? punchRes.data : []);
      setPlanItems(Array.isArray(planRes.data) ? planRes.data : []);
      setMaterials(Array.isArray(materialRes.data) ? materialRes.data : []);
      setProjectNotes(Array.isArray(notesRes.data) ? notesRes.data : []);
    } catch (err) { } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => {
    activeProjectIdRef.current = projectId;
    setPhotos([]);
    setScopes([]);
    setPunchItems([]);
    setPlanItems([]);
    setMaterials([]);
    setProjectNotes([]);
    setLightbox(null);
    setNotePhoto(null);
    setScopeAssignPhoto(null);
    setScopeAssignIds(new Set());
    setPhotoAssignTargetType('project_scope');
    setSelectedDeleteIds(new Set());
    setDeleteMode(false);
    setLoading(true);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const assignPhotoIdsToTargets = useCallback(async (photoIds: string[], targetType: PhotoBucketAssignmentTargetType, targetIds: string[]) => {
    const cleanPhotoIds = Array.from(new Set(photoIds.map(id => String(id || '').trim()).filter(Boolean)));
    const cleanTargetIds = Array.from(new Set(targetIds.map(id => String(id || '').trim()).filter(Boolean)));
    if (!cleanPhotoIds.length || !cleanTargetIds.length) return 0;

    const results = await Promise.all(cleanTargetIds.map(targetId =>
      api.post(`/projects/${projectId}/photos/assignments`, {
        target_type: targetType,
        target_id: targetId,
        photo_ids: cleanPhotoIds,
      })
    ));
    return results.reduce((sum, result) => sum + Number(result.data?.assigned_photos?.length || result.data?.added || 0), 0);
  }, [projectId]);

  const openScopeAssignment = (photo: any) => {
    const assignedScopes = scopeAssignmentMap.get(String(photo?.id || '')) || [];
    setPhotoAssignTargetType('project_scope');
    setScopeAssignIds(new Set(assignedScopes.map(scope => String(scope.scopeId))));
    setScopeAssignPhoto(photo);
  };

  const changePhotoAssignTargetType = (targetType: PhotoBucketAssignmentTargetType) => {
    setPhotoAssignTargetType(targetType);
    if (targetType === 'project_scope' && scopeAssignPhoto) {
      const assignedScopes = scopeAssignmentMap.get(String(scopeAssignPhoto?.id || '')) || [];
      setScopeAssignIds(new Set(assignedScopes.map(scope => String(scope.scopeId))));
      return;
    }
    setScopeAssignIds(new Set());
  };

  const toggleScopeAssignment = (scopeId: string) => {
    setScopeAssignIds(current => {
      const next = new Set(current);
      if (next.has(scopeId)) next.delete(scopeId);
      else next.add(scopeId);
      return next;
    });
  };

  const savePhotoScopeAssignments = async () => {
    if (!scopeAssignPhoto || assigningScopes) return;
    const selectedScopeIds = Array.from(scopeAssignIds);
    if (!selectedScopeIds.length) {
      toast.error(`Select at least one ${activeAssignmentConfig.label.toLowerCase()} record`);
      return;
    }

    setAssigningScopes(true);
    try {
      const added = await assignPhotoIdsToTargets([scopeAssignPhoto.id], photoAssignTargetType, selectedScopeIds);
      toast.success(added > 0
        ? `Photo assigned to ${selectedScopeIds.length} ${activeAssignmentConfig.label.toLowerCase()} record${selectedScopeIds.length === 1 ? '' : 's'}`
        : `Photo is already assigned to the selected ${activeAssignmentConfig.label.toLowerCase()} record${selectedScopeIds.length === 1 ? '' : 's'}`);
      setScopeAssignPhoto(null);
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to assign photo');
    } finally {
      setAssigningScopes(false);
    }
  };

  const scopeAssignPreviewSrc = scopeAssignPhoto ? progressPhotoSrc(projectId, scopeAssignPhoto) : '';
  const scopeAssignPreviewKind = scopeAssignPhoto ? getProgressMediaKind(scopeAssignPhoto) : 'image';

  const closeDeleteMode = () => {
    setDeleteMode(false);
    setSelectedDeleteIds(new Set());
  };

  const toggleDeleteSelection = (photo: any) => {
    if (!photo.can_delete_correction || deletingPhotoId) return;
    const key = progressPhotoKey(photo);
    setSelectedDeleteIds(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const deleteSelectedProgressPhotos = async () => {
    if (!selectedDeletePhotos.length || deletingPhotoId) return;
    const confirmed = window.confirm(`Delete ${selectedDeletePhotos.length} selected photo${selectedDeletePhotos.length === 1 ? '' : 's'}? This removes them from this project and locks correction for the selected upload record${selectedDeletePhotos.length === 1 ? '' : 's'}.`);
    if (!confirmed) return;
    setDeletingPhotoId('__batch__');
    try {
      const results = await Promise.allSettled(
        selectedDeletePhotos.map(photo => api.delete(`/projects/${projectId}/photos/${photo.id}`))
      );
      const deleted = results.filter(result => result.status === 'fulfilled').length;
      const failed = results.length - deleted;
      if (deleted) toast.success(`${deleted} photo${deleted === 1 ? '' : 's'} removed.`);
      if (failed) toast.error(`${failed} photo${failed === 1 ? '' : 's'} could not be deleted.`);
      closeDeleteMode();
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to delete selected photos');
    } finally {
      setDeletingPhotoId('');
    }
  };

  return (
    <div className="bt-photos-tab space-y-4">
      <section className="bt-photos-bucket-summary rounded-2xl border border-blue-400/50 bg-gradient-to-br from-slate-950 via-blue-950 to-slate-900 p-4 text-white shadow-lg shadow-blue-950/30">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl border border-blue-300/50 bg-blue-500/20 text-blue-100 shadow-inner">
              <FileImage className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm font-black uppercase tracking-wide text-blue-100">Project Photo Bucket</p>
              <p className="mt-1 text-xs font-semibold text-slate-200">
                {projectLabel} photos are kept in one dated project record, newest first.
              </p>
              <p className="mt-1 text-xs text-slate-300">
                Bucket photos can be reused on scope of work, quotes, notes, punch list, and other project records without duplicating the original file.
              </p>
            </div>
          </div>
          <span className="inline-flex min-h-9 items-center justify-center rounded-lg border border-cyan-300/40 bg-cyan-500/15 px-3 text-xs font-black uppercase tracking-wide text-cyan-100">
            Newest photos on top
          </span>
        </div>
      </section>

      <div className="grid gap-2 sm:grid-cols-3">
        <div className="bt-photos-stat-card rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
          <p className="text-xl font-black text-slate-950">{photos.length}</p>
          <p className="text-xs font-black uppercase tracking-wide text-slate-500">Project photos</p>
        </div>
        <div className="bt-photos-stat-card bt-photos-stat-card-blue rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 shadow-sm">
          <p className="text-xl font-black text-blue-800">{photoDescriptionCount}</p>
          <p className="text-xs font-black uppercase tracking-wide text-blue-700">Descriptions</p>
        </div>
        <div className="bt-photos-stat-card bt-photos-stat-card-green rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 shadow-sm">
          <p className="text-xl font-black text-emerald-800">{assignedScopeCount}</p>
          <p className="text-xs font-black uppercase tracking-wide text-emerald-700">Scope assignments</p>
        </div>
      </div>

      {deletablePhotos.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-2 rounded-xl border border-red-500/40 bg-red-950/25 px-3 py-3 shadow-inner">
          {!deleteMode ? (
            <button
              type="button"
              onClick={() => setDeleteMode(true)}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-red-400 bg-red-600 px-4 text-sm font-black text-white shadow-lg shadow-red-950/30 transition hover:border-red-300 hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-red-300"
            >
              <Trash2 className="h-4 w-4" />
              Delete pictures
            </button>
          ) : (
            <>
              <span className="text-sm font-black text-red-100">Select pictures to delete</span>
              <button
                type="button"
                onClick={() => void deleteSelectedProgressPhotos()}
                disabled={!selectedDeletePhotos.length || Boolean(deletingPhotoId)}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-red-400 bg-red-600 px-4 text-sm font-black text-white shadow-lg shadow-red-950/30 transition hover:bg-red-500 disabled:cursor-not-allowed disabled:border-red-300 disabled:bg-red-300 disabled:text-red-950"
              >
                <Trash2 className="h-4 w-4" />
                {deletingPhotoId ? 'Deleting...' : `Delete selected${selectedDeletePhotos.length ? ` (${selectedDeletePhotos.length})` : ''}`}
              </button>
              <button
                type="button"
                onClick={closeDeleteMode}
                disabled={Boolean(deletingPhotoId)}
                className="inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-black text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      )}

      {loading ? <Loading /> : (
        <div className="space-y-5">
          {groupedPhotos.map(group => (
            <section key={group.date} className="rounded-xl border border-gray-200 bg-white p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-black text-gray-900">{group.date}</h3>
                  <p className="text-xs font-semibold text-gray-500">{group.photos.length} item{group.photos.length === 1 ? '' : 's'} ordered by time taken</p>
                </div>
                <span className="rounded-full bg-blue-50 px-2 py-1 text-xs font-black text-blue-700">Historical record</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {group.photos.map(photo => {
                  const src = progressPhotoSrc(projectId, photo);
                  const mediaKind = getProgressMediaKind(photo);
                  const isVideo = mediaKind === 'video';
                  const key = progressPhotoKey(photo);
                  const lightboxIndex = lightboxItems.findIndex(item => item.id === key);
                  const isSelected = selectedDeleteIds.has(key);
                  const noteText = getProgressPhotoNoteText(photo);
                  const assignedScopes = scopeAssignmentMap.get(String(photo.id)) || [];
                  const photoTimestamp = formatProjectPhotoTimestamp(photo);
                  const photoGps = formatProjectPhotoGps(photo);
                  const photoIp = formatProjectPhotoIp(photo);
                  return (
                    <div
                      key={key}
                      role="button"
                      tabIndex={0}
                      className={`relative group aspect-square cursor-pointer overflow-hidden rounded-xl border bg-gray-100 transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-lg ${deleteMode && photo.can_delete_correction ? 'ring-2 ring-red-200' : 'border-transparent'} ${isSelected ? 'border-red-500 ring-4 ring-red-300' : ''} ${deleteMode && !photo.can_delete_correction ? 'cursor-not-allowed opacity-60' : ''}`}
                      onClick={() => {
                        if (deleteMode) {
                          toggleDeleteSelection(photo);
                          return;
                        }
                        if (mediaKind === 'file') window.open(src, '_blank', 'noopener,noreferrer');
                        else if (lightboxIndex >= 0) setLightbox({ items: lightboxItems, index: lightboxIndex });
                      }}
                      onKeyDown={event => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        if (deleteMode) {
                          toggleDeleteSelection(photo);
                          return;
                        }
                        if (mediaKind === 'file') window.open(src, '_blank', 'noopener,noreferrer');
                        else if (lightboxIndex >= 0) setLightbox({ items: lightboxItems, index: lightboxIndex });
                      }}
                      aria-label={deleteMode ? `Select ${photo.original_name || 'photo'} for deletion` : `Open ${photo.original_name || 'photo'}`}
                      aria-pressed={deleteMode ? isSelected : undefined}
                    >
                      {isVideo ? (
                        <>
                          <video src={src} className="w-full h-full object-cover transition-transform group-hover:scale-105" muted playsInline preload="metadata" />
                          <PlayCircle className="absolute inset-0 m-auto h-10 w-10 text-white drop-shadow" />
                        </>
                      ) : mediaKind === 'image' ? (
                        <img src={src} alt={photo.original_name} className="w-full h-full object-cover transition-transform group-hover:scale-105" loading="lazy" />
                      ) : (
                          <UnsupportedProgressMediaTile name={photo.original_name || photo.filename} />
                      )}
                      {noteText && (
                        <button
                          type="button"
                          onClick={event => {
                            event.stopPropagation();
                            setNotePhoto(photo);
                          }}
                          className={`absolute left-2 ${!deleteMode && hasPhotoAssignmentTargets ? 'top-11' : 'top-2'} z-30 inline-flex min-h-8 items-center gap-1 rounded-lg bg-amber-500 px-2 text-[10px] font-black text-slate-950 shadow-sm transition hover:bg-amber-400`}
                          aria-label={`Edit description for ${photo.original_name || 'photo'}`}
                        >
                          <MessageSquare className="h-3 w-3" />
                          Edit Description
                        </button>
                      )}
                      {deleteMode && (
                        <div className={`absolute right-2 top-2 z-0 inline-flex h-8 w-8 items-center justify-center rounded-lg border text-xs font-black shadow-sm ${isSelected ? 'border-red-500 bg-red-600 text-white' : photo.can_delete_correction ? 'border-white/80 bg-black/60 text-white' : 'border-slate-400 bg-slate-700 text-slate-300'}`}>
                          {isSelected ? <Check className="h-4 w-4" /> : photo.can_delete_correction ? '' : 'X'}
                        </div>
                      )}
                      {!deleteMode && (
                        <>
                        {hasPhotoAssignmentTargets && (
                          <button
                            type="button"
                            onClick={event => {
                              event.stopPropagation();
                              openScopeAssignment(photo);
                            }}
                            className="absolute left-2 top-2 z-20 inline-flex min-h-8 items-center justify-center gap-1 rounded-lg border border-white/70 bg-blue-700/90 px-2 text-[11px] font-black text-white shadow-sm transition hover:border-blue-200 hover:bg-blue-600"
                            aria-label={`Assign ${photo.original_name || 'photo'} to project records`}
                          >
                            <ClipboardList className="h-3.5 w-3.5" />
                            {assignedScopes.length ? `${assignedScopes.length} scope${assignedScopes.length === 1 ? '' : 's'}` : 'Assign'}
                          </button>
                        )}
                        {!noteText && (
                          <button
                            type="button"
                            onClick={event => {
                              event.stopPropagation();
                              setNotePhoto(photo);
                            }}
                            className="absolute right-2 top-2 z-30 inline-flex min-h-8 items-center justify-center gap-1 rounded-lg border border-white/70 bg-black/65 px-2 text-[11px] font-black text-white shadow-sm transition hover:border-amber-300 hover:text-amber-200"
                            aria-label={`Add description for ${photo.original_name || 'photo'}`}
                          >
                            <MessageSquare className="h-3.5 w-3.5" />
                            Add Description
                          </button>
                        )}
                        </>
                      )}
                      {!deleteMode && mediaKind !== 'file' && (
                        <div className="absolute inset-x-0 top-0 z-0 bg-gradient-to-b from-black/45 to-transparent px-2 py-1.5 text-[10px] font-black uppercase tracking-wide text-white opacity-0 transition-opacity group-hover:opacity-100">
                          Click to expand
                        </div>
                      )}
                      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-transparent opacity-100 transition-opacity" />
                      <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-10 bg-gradient-to-t from-black/95 via-black/82 to-black/18 p-2 shadow-[0_-8px_18px_rgba(0,0,0,0.35)]">
                        <p className="text-white text-xs font-bold truncate">{projectLabel}</p>
                        <p className="text-white/85 text-[11px] font-semibold truncate">{photoTimestamp}</p>
                        <p className="text-white/75 text-[10px] font-semibold truncate">{photoGps}</p>
                        <p className="text-white/70 text-[10px] font-semibold truncate">{photoIp}</p>
                        <p className="text-white/70 text-[10px] truncate">Inserted by {photo.uploader_name || photo.uploaded_by_name || 'Unknown user'}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
          {photos.length === 0 && (
            <div className="col-span-full text-center py-12">
              <Camera className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="text-gray-400 text-sm">No photos yet</p>
            </div>
          )}
        </div>
      )}

      <ProgressMediaLightbox state={lightbox} onChange={setLightbox} />
      <PhotoNoteModal
        projectId={projectId}
        photo={notePhoto}
        onClose={() => setNotePhoto(null)}
        onSaved={async updatedPhoto => {
          setNotePhoto(null);
          setPhotos(current => current.map(photo => (photo.id === updatedPhoto.id ? { ...photo, ...updatedPhoto } : photo)));
          await load();
        }}
      />
      <Modal
        isOpen={Boolean(scopeAssignPhoto)}
        onClose={() => {
          setScopeAssignPhoto(null);
          setScopeAssignIds(new Set());
          setPhotoAssignTargetType('project_scope');
        }}
        title="Assign Photo to Project Records"
      >
        {scopeAssignPhoto && (
          <div className="space-y-4">
            <div className="flex gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="h-20 w-20 flex-shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-white">
                {scopeAssignPreviewKind === 'video' ? (
                  <video src={scopeAssignPreviewSrc} className="h-full w-full object-cover" muted playsInline preload="metadata" />
                ) : scopeAssignPreviewKind === 'image' ? (
                  <img src={scopeAssignPreviewSrc} alt={scopeAssignPhoto.original_name || 'Selected photo'} className="h-full w-full object-cover" />
                ) : (
                  <UnsupportedProgressMediaTile name={scopeAssignPhoto.original_name || scopeAssignPhoto.filename} />
                )}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-black text-slate-950">{scopeAssignPhoto.original_name || scopeAssignPhoto.filename || 'Project photo'}</p>
                <p className="mt-1 text-xs font-semibold text-slate-500">
                  {formatEasternDateTime(scopeAssignPhoto.taken_at || scopeAssignPhoto.created_at, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </p>
                <p className="mt-1 text-xs font-semibold text-blue-700">{scopeAssignIds.size} selected {activeAssignmentConfig.label.toLowerCase()} record{scopeAssignIds.size === 1 ? '' : 's'}</p>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-5">
              {PHOTO_BUCKET_ASSIGNMENT_TARGETS.map(target => {
                const active = target.type === photoAssignTargetType;
                const count = assignmentTargetOptions[target.type]?.length || 0;
                return (
                  <button
                    key={target.type}
                    type="button"
                    onClick={() => changePhotoAssignTargetType(target.type)}
                    disabled={assigningScopes}
                    className={`min-h-11 rounded-xl border px-2 text-left text-xs font-black transition ${active ? 'border-blue-400 bg-blue-600 text-white shadow-md shadow-blue-900/20' : 'border-slate-200 bg-white text-slate-700 hover:border-blue-300 hover:bg-blue-50'}`}
                  >
                    <span className="block truncate">{target.shortLabel}</span>
                    <span className={`mt-0.5 block text-[10px] font-black ${active ? 'text-blue-100' : 'text-slate-400'}`}>{count} records</span>
                  </button>
                );
              })}
            </div>

            {activeAssignmentOptions.length > 0 ? (
              <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                {activeAssignmentOptions.map(option => {
                  const checked = scopeAssignIds.has(option.id);
                  const alreadyAssigned = photoAssignTargetType === 'project_scope'
                    && (scopeAssignmentMap.get(String(scopeAssignPhoto.id)) || []).some(row => String(row.scopeId) === option.id);
                  return (
                    <label
                      key={`${photoAssignTargetType}-${option.id}`}
                      className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${checked ? 'border-blue-500 bg-blue-50' : 'border-slate-200 bg-white hover:border-blue-300'}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleScopeAssignment(option.id)}
                        className="mt-1 h-4 w-4 rounded border-blue-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-black text-slate-950">{option.title}</span>
                        <span className="mt-0.5 block truncate text-xs font-semibold text-slate-500">{option.subtitle}</span>
                        {alreadyAssigned && <span className="mt-1 inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-black text-emerald-700">Already assigned</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-center text-sm font-semibold text-slate-500">
                {activeAssignmentConfig.emptyLabel}
              </div>
            )}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => {
                  setScopeAssignPhoto(null);
                  setScopeAssignIds(new Set());
                  setPhotoAssignTargetType('project_scope');
                }}
                disabled={assigningScopes}
                className="inline-flex min-h-10 items-center justify-center rounded-xl border border-slate-300 bg-white px-4 text-sm font-black text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void savePhotoScopeAssignments()}
                disabled={assigningScopes || scopeAssignIds.size === 0}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-black text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
              >
                <ClipboardList className="h-4 w-4" />
                {assigningScopes ? 'Assigning...' : 'Save Photo Assignments'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function InvoicesTab({ projectId, user, project }: { projectId: string; user: any; project: any }) {
  const navigate = useNavigate();
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const res = await api.get(`/projects/${projectId}/invoices`);
      setInvoices(res.data);
    } catch (err) { } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const statusColors: Record<string, string> = { draft: 'bg-slate-500/15 text-slate-200 border border-slate-400/30', submitted: 'bg-blue-500/20 text-blue-200 border border-blue-400/40', reviewed: 'bg-amber-500/20 text-amber-200 border border-amber-400/40', approved: 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/40', paid: 'bg-teal-500/20 text-teal-200 border border-teal-400/40' };

  return (
    <div className="space-y-4">
      <button onClick={() => navigate(`/projects/${projectId}/invoices/new`)} className="w-full flex items-center justify-center gap-2 py-3.5 bg-blue-600 text-white rounded-xl font-semibold text-sm hover:bg-blue-700 transition-colors shadow-sm">
        <Plus className="w-5 h-5" /> CREATE INVOICE
      </button>

      {loading ? <Loading /> : (
        <div className="space-y-3">
          {invoices.map(inv => (
            <div key={inv.id} className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-purple-100 rounded-xl flex items-center justify-center flex-shrink-0">
                <FileText className="w-5 h-5 text-purple-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-gray-900 text-sm">#{inv.invoice_number}</p>
                <p className="text-xs text-gray-500">{inv.contractor_name} · {formatEasternDate(inv.created_at, { month: 'short', day: 'numeric', year: 'numeric' })}</p>
              </div>
              <div className="text-right">
                <p className="font-bold text-gray-900">${Number(inv.total).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[inv.status]}`}>{inv.status}</span>
              </div>
            </div>
          ))}
          {invoices.length === 0 && <div className="text-center py-12 bg-white rounded-xl border border-gray-200"><FileText className="w-8 h-8 text-gray-300 mx-auto mb-2" /><p className="text-gray-400 text-sm">No invoices yet</p></div>}
        </div>
      )}
    </div>
  );
}

type ProjectQuoteCategory = {
  id: string;
  category_group: string;
  name: string;
};

type ProjectQuoteLineForm = {
  category: string;
  subcategory: string;
  description: string;
  quantity: string;
  unit: string;
  unit_price: string;
  total_line_item_price: string;
  labor_amount: string;
  material_amount: string;
};

type ProjectQuoteForm = {
  contractor_name: string;
  contractor_address: string;
  contractor_phone: string;
  contractor_email: string;
  quote_date: string;
  status: string;
  scope_description: string;
  notes: string;
  total_quote_amount: string;
};

type QuoteFilterKey = 'review' | 'approved' | 'database' | 'compare';

const projectQuoteStatuses = ['draft', 'submitted', 'approved', 'rejected', 'paid', 'completed', 'historical'];
const approvedQuoteStatuses = ['approved', 'paid', 'completed'];

const blankProjectQuoteForm = (): ProjectQuoteForm => ({
  contractor_name: '',
  contractor_address: '',
  contractor_phone: '',
  contractor_email: '',
  quote_date: format(new Date(), 'yyyy-MM-dd'),
  status: 'submitted',
  scope_description: '',
  notes: '',
  total_quote_amount: '',
});

const blankProjectQuoteLineItem = (category = ''): ProjectQuoteLineForm => ({
  category,
  subcategory: '',
  description: '',
  quantity: '1',
  unit: '',
  unit_price: '',
  total_line_item_price: '',
  labor_amount: '',
  material_amount: '',
});

const quoteNumberValue = (value: number | string | null | undefined) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const quoteMoney = (value: number | string | null | undefined) =>
  quoteNumberValue(value).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const quoteStatusLabel = (status: string) => {
  const labelMap: Record<string, string> = {
    submitted: 'For Review',
    rejected: 'Denied',
    historical: 'In Database',
  };
  const normalized = String(status || '').toLowerCase();
  return labelMap[normalized] || normalized.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
};

const compactQuoteDateTime = (value: string | null | undefined) => {
  if (!value) return 'Not recorded';
  try {
    return formatEasternDateTime(value, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return String(value);
  }
};

const quoteScopeTitle = (quote: any) => {
  const scope = String(quote.scope_description || '')
    .replace(/\r/g, '\n')
    .split(/\n+/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .find(Boolean);
  if (scope) return scope;
  const firstLine = Array.isArray(quote.line_items) ? quote.line_items[0] : null;
  return firstLine?.description || firstLine?.subcategory || firstLine?.category || 'Scope title not entered';
};

const quoteAttachmentIsImage = (quote: any) =>
  Boolean(quote.document_download_url && /^image\//i.test(String(quote.source_file_mime_type || '')));

const quotePanelStyle = {
  background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.98) 0%, rgba(30, 58, 138, 0.86) 56%, rgba(49, 46, 129, 0.86) 100%)',
  border: '1px solid rgba(147, 197, 253, 0.34)',
  boxShadow: '0 18px 38px rgba(2, 6, 23, 0.46), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
};

const quoteInsetStyle = {
  background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.96) 0%, rgba(17, 24, 39, 0.92) 100%)',
  border: '1px solid rgba(125, 211, 252, 0.22)',
  boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.06)',
};

function QuotesTab({ projectId, project }: { projectId: string; project: any }) {
  const navigate = useNavigate();
  const [quotes, setQuotes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [quoteOptions, setQuoteOptions] = useState<{ categories: ProjectQuoteCategory[]; statuses: string[] }>({
    categories: [],
    statuses: projectQuoteStatuses,
  });
  const [showAddQuote, setShowAddQuote] = useState(false);
  const [savingQuote, setSavingQuote] = useState(false);
  const [aiExtracting, setAiExtracting] = useState(false);
  const [quoteFile, setQuoteFile] = useState<File | null>(null);
  const [quoteForm, setQuoteForm] = useState<ProjectQuoteForm>(() => blankProjectQuoteForm());
  const [quoteLineItems, setQuoteLineItems] = useState<ProjectQuoteLineForm[]>(() => [blankProjectQuoteLineItem()]);
  const [quoteFilter, setQuoteFilter] = useState<QuoteFilterKey>('review');
  const [expandedQuoteIds, setExpandedQuoteIds] = useState<Record<string, boolean>>({});
  const [updatingQuoteId, setUpdatingQuoteId] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await api.get(`/projects/${projectId}/quotes`);
      setQuotes(Array.isArray(res.data?.quotes) ? res.data.quotes : []);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to load project quotes');
    } finally {
      setLoading(false);
    }
  };

  const loadQuoteOptions = async () => {
    try {
      const res = await api.get('/quote-analytics/options');
      setQuoteOptions({
        categories: Array.isArray(res.data?.categories) ? res.data.categories : [],
        statuses: Array.isArray(res.data?.statuses) && res.data.statuses.length > 0 ? res.data.statuses : projectQuoteStatuses,
      });
    } catch {
      setQuoteOptions(current => ({ ...current, statuses: projectQuoteStatuses }));
    }
  };

  useEffect(() => {
    setLoading(true);
    load();
    loadQuoteOptions();
  }, [projectId]);

  useEffect(() => {
    setExpandedQuoteIds({});
  }, [projectId, quoteFilter]);

  useEffect(() => {
    if (quoteOptions.categories.length === 0) return;
    setQuoteLineItems(current => {
      if (current.length !== 1 || current[0].category) return current;
      return [blankProjectQuoteLineItem(quoteOptions.categories[0].name)];
    });
  }, [quoteOptions.categories]);

  const categoriesByGroup = useMemo(() => {
    const groups = new Map<string, ProjectQuoteCategory[]>();
    for (const category of quoteOptions.categories) {
      const group = category.category_group || 'Other';
      groups.set(group, [...(groups.get(group) || []), category]);
    }
    return Array.from(groups.entries());
  }, [quoteOptions.categories]);

  const reviewQuotes = useMemo(() => quotes.filter(quote => quote.status === 'submitted'), [quotes]);
  const approvedQuotes = useMemo(() => quotes.filter(quote => approvedQuoteStatuses.includes(quote.status)), [quotes]);
  const databaseQuotes = quotes;
  const visibleQuotes = useMemo(() => {
    if (quoteFilter === 'review') return reviewQuotes;
    if (quoteFilter === 'approved') return approvedQuotes;
    if (quoteFilter === 'compare') return [...quotes].sort((a, b) => quoteNumberValue(a.total_quote_amount) - quoteNumberValue(b.total_quote_amount));
    return databaseQuotes;
  }, [approvedQuotes, databaseQuotes, quoteFilter, reviewQuotes, quotes]);
  const totalQuoted = quotes.reduce((sum, quote) => sum + quoteNumberValue(quote.total_quote_amount), 0);
  const visibleQuoted = visibleQuotes.reduce((sum, quote) => sum + quoteNumberValue(quote.total_quote_amount), 0);
  const contractors = new Set(visibleQuotes.map(quote => quote.contractor_company || quote.contractor_name).filter(Boolean));
  const categories = new Set(visibleQuotes.flatMap(quote => (quote.line_items || []).map((item: any) => item.category)).filter(Boolean));
  const calculatedLineTotal = quoteLineItems.reduce((sum, item) => sum + quoteNumberValue(item.total_line_item_price), 0);
  const defaultCategory = quoteOptions.categories[0]?.name || '';
  const statusColors: Record<string, string> = {
    draft: 'bg-slate-700/80 text-slate-100 border border-slate-400/40',
    submitted: 'bg-blue-500/25 text-blue-50 border border-blue-300/50',
    approved: 'bg-emerald-500/20 text-emerald-50 border border-emerald-300/50',
    rejected: 'bg-rose-500/20 text-rose-50 border border-rose-300/50',
    paid: 'bg-teal-500/20 text-teal-50 border border-teal-300/50',
    completed: 'bg-violet-500/20 text-violet-50 border border-violet-300/50',
    historical: 'bg-cyan-500/20 text-cyan-50 border border-cyan-300/40',
  };
  const quoteFilters: Array<{
    key: QuoteFilterKey;
    label: string;
    count: number;
    value: string;
    description: string;
    Icon: typeof FileText;
  }> = [
    {
      key: 'review',
      label: 'Quotes for Review',
      count: reviewQuotes.length,
      value: quoteMoney(reviewQuotes.reduce((sum, quote) => sum + quoteNumberValue(quote.total_quote_amount), 0)),
      description: 'New submitted quotes waiting for approve or deny',
      Icon: ListFilter,
    },
    {
      key: 'approved',
      label: 'Approved Quotes',
      count: approvedQuotes.length,
      value: quoteMoney(approvedQuotes.reduce((sum, quote) => sum + quoteNumberValue(quote.total_quote_amount), 0)),
      description: 'Quotes selected for the project',
      Icon: CheckCircle2,
    },
    {
      key: 'database',
      label: 'Quote Database',
      count: databaseQuotes.length,
      value: quoteMoney(totalQuoted),
      description: 'Complete project quote history, including denied quotes',
      Icon: Database,
    },
    {
      key: 'compare',
      label: 'Compare & Pick',
      count: quotes.length,
      value: quoteMoney(totalQuoted),
      description: 'All quotes side by side — choose the winner',
      Icon: ListFilter,
    },
  ];
  const currentFilter = quoteFilters.find(filter => filter.key === quoteFilter) || quoteFilters[0];

  const resetQuoteForm = () => {
    setQuoteForm(blankProjectQuoteForm());
    setQuoteLineItems([blankProjectQuoteLineItem(defaultCategory)]);
    setQuoteFile(null);
  };

  const updateQuoteLineItem = (index: number, patch: Partial<ProjectQuoteLineForm>) => {
    setQuoteLineItems(current => current.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      const next = { ...item, ...patch };
      if ((patch.quantity !== undefined || patch.unit_price !== undefined) && !String(next.total_line_item_price || '').trim()) {
        next.total_line_item_price = String((quoteNumberValue(next.quantity) || 1) * quoteNumberValue(next.unit_price));
      }
      return next;
    }));
  };

  const autoFillQuoteFromPdf = async () => {
    if (!quoteFile) { toast.error('Attach a PDF or image of the quote first'); return; }
    setAiExtracting(true);
    try {
      const body = new FormData();
      body.append('quote_file', quoteFile);
      const res = await api.post(`/projects/${projectId}/quotes/extract`, body, { headers: { 'Content-Type': 'multipart/form-data' } });
      const q = res.data?.quote || {};
      setQuoteForm(f => ({
        ...f,
        contractor_name: q.contractor_name || f.contractor_name,
        contractor_email: q.contractor_email || q.contractor_phone || f.contractor_email,
        scope_description: q.scope_description || f.scope_description,
        total_quote_amount: q.total_quote_amount ? String(q.total_quote_amount) : f.total_quote_amount,
      }));
      const lines = Array.isArray(q.line_items) ? q.line_items : [];
      if (lines.length) {
        setQuoteLineItems(lines.map((li: any) => ({
          ...blankProjectQuoteLineItem(li.category || defaultCategory),
          category: li.category || defaultCategory,
          description: li.description || '',
          total_line_item_price: li.total_line_item_price != null ? String(li.total_line_item_price) : '',
        })));
      }
      toast.success('Quote read by AI — review the fields, then Save quote');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Could not read the quote from this file');
    } finally {
      setAiExtracting(false);
    }
  };

  const submitProjectQuote = async () => {
    if (!quoteForm.contractor_name.trim()) return toast.error("Enter the contractor's name");

    const lineItems = quoteLineItems
      .map(item => ({
        ...item,
        description: item.description.trim() || item.category || 'Quote line item',
        quantity: item.quantity || '1',
      }))
      .filter(item => item.category || item.total_line_item_price);

    if (lineItems.length === 0 || lineItems.some(item => !item.category || quoteNumberValue(item.total_line_item_price) <= 0)) {
      return toast.error('Each quote line needs a category and price');
    }

    setSavingQuote(true);
    try {
      const payload = {
        ...quoteForm,
        total_quote_amount: quoteForm.total_quote_amount || String(calculatedLineTotal),
        line_items: lineItems,
      };

      if (quoteFile) {
        const body = new FormData();
        Object.entries(payload).forEach(([key, value]) => {
          body.append(key, key === 'line_items' ? JSON.stringify(value) : String(value ?? ''));
        });
        body.append('quote_file', quoteFile);
        await api.post(`/projects/${projectId}/quotes/upload`, body, { headers: { 'Content-Type': 'multipart/form-data' } });
      } else {
        await api.post(`/projects/${projectId}/quotes`, payload);
      }

      toast.success('Quote saved to this project');
      resetQuoteForm();
      setShowAddQuote(false);
      await load();
    } catch (err: any) {
      const errors = err.response?.data?.errors;
      toast.error(Array.isArray(errors) ? errors[0] : err.response?.data?.error || 'Failed to save quote');
    } finally {
      setSavingQuote(false);
    }
  };

  const toggleQuoteExpanded = (quoteId: string) => {
    setExpandedQuoteIds(current => ({
      ...current,
      [quoteId]: !current[quoteId],
    }));
  };

  const reviewQuote = async (quote: any, decision: 'approve' | 'deny') => {
    setUpdatingQuoteId(quote.id);
    try {
      await api.post(`/projects/${projectId}/quotes/${quote.id}/${decision}`);
      toast.success(decision === 'approve'
        ? `${quote.quote_number} moved to Approved Quotes`
        : `${quote.quote_number} moved to Quote Database`);
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update quote');
    } finally {
      setUpdatingQuoteId(null);
    }
  };

  return (
    <div className="space-y-4 text-slate-100">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-black text-white">Project Quotes</h3>
          <p className="text-xs font-semibold text-slate-400">Upload a PDF or enter a quote manually, then use Compare &amp; Pick to choose the winner.</p>
        </div>
        <button type="button" onClick={() => { resetQuoteForm(); setShowAddQuote(value => !value); }} className="inline-flex items-center gap-1.5 rounded-lg border border-blue-400/60 bg-blue-600 px-3 py-2 text-xs font-black text-white transition-colors hover:bg-blue-500">
          <Plus className="h-3.5 w-3.5" /> {showAddQuote ? 'Close' : 'Add Quote'}
        </button>
      </div>

      {showAddQuote && (
        <div className="space-y-3 rounded-xl border border-white/10 bg-slate-950/55 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-[11px] font-black uppercase tracking-wide text-slate-400">Contractor name *</span>
              <input value={quoteForm.contractor_name} onChange={e => setQuoteForm(f => ({ ...f, contractor_name: e.target.value }))} className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Who gave the quote" />
            </label>
            <label className="block">
              <span className="text-[11px] font-black uppercase tracking-wide text-slate-400">Email / phone (optional)</span>
              <input value={quoteForm.contractor_email} onChange={e => setQuoteForm(f => ({ ...f, contractor_email: e.target.value }))} className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="contractor@email.com" />
            </label>
          </div>

          <label className="block">
            <span className="text-[11px] font-black uppercase tracking-wide text-slate-400">What is this quote for? (optional)</span>
            <textarea value={quoteForm.scope_description} onChange={e => setQuoteForm(f => ({ ...f, scope_description: e.target.value }))} rows={2} className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="e.g. Paint entire interior, 2 coats" />
          </label>

          <label className="block">
            <span className="text-[11px] font-black uppercase tracking-wide text-slate-400">Attach the quote PDF (optional)</span>
            <input type="file" accept="application/pdf,image/*" onChange={e => setQuoteFile(e.target.files?.[0] || null)} className="mt-1 block w-full text-xs text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-blue-600 file:px-3 file:py-2 file:text-xs file:font-black file:text-white hover:file:bg-blue-500" />
            {quoteFile && <span className="mt-1 block text-[11px] font-semibold text-emerald-300">Attached: {quoteFile.name}</span>}
          </label>

          {quoteFile && (
            <button type="button" onClick={autoFillQuoteFromPdf} disabled={aiExtracting} className="inline-flex items-center gap-1.5 rounded-lg border border-violet-400/50 bg-violet-600 px-3 py-2 text-xs font-black text-white transition-colors hover:bg-violet-500 disabled:opacity-50">
              <Bot className="h-3.5 w-3.5" /> {aiExtracting ? 'Reading the quote…' : 'Auto-fill from PDF with AI'}
            </button>
          )}

          <div className="space-y-2">
            <span className="text-[11px] font-black uppercase tracking-wide text-slate-400">Line items — each needs a category &amp; price</span>
            {quoteLineItems.map((line, idx) => (
              <div key={idx} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_120px_auto]">
                <select value={line.category} onChange={e => updateQuoteLineItem(idx, { category: e.target.value })} className="rounded-lg border border-slate-600 bg-slate-900 px-2 py-2 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">Category…</option>
                  {quoteOptions.categories.map(cat => <option key={cat.id} value={cat.name}>{cat.name}</option>)}
                </select>
                <input value={line.description} onChange={e => updateQuoteLineItem(idx, { description: e.target.value })} className="rounded-lg border border-slate-600 bg-slate-900 px-2 py-2 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Description (optional)" />
                <input value={line.total_line_item_price} onChange={e => updateQuoteLineItem(idx, { total_line_item_price: e.target.value })} inputMode="decimal" className="rounded-lg border border-slate-600 bg-slate-900 px-2 py-2 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="$ price" />
                <button type="button" onClick={() => setQuoteLineItems(cur => cur.length > 1 ? cur.filter((_, i) => i !== idx) : cur)} className="inline-flex items-center justify-center rounded-lg border border-slate-600 bg-slate-900 px-2 text-slate-300 hover:bg-slate-800" aria-label="Remove line"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
            <button type="button" onClick={() => setQuoteLineItems(cur => [...cur, blankProjectQuoteLineItem(defaultCategory)])} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 text-xs font-black text-slate-100 hover:bg-slate-800"><Plus className="h-3.5 w-3.5" /> Add line</button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-3">
            <span className="text-sm font-black text-white">Total: {quoteMoney(quoteForm.total_quote_amount || calculatedLineTotal)}</span>
            <div className="flex gap-2">
              <button type="button" onClick={() => { resetQuoteForm(); setShowAddQuote(false); }} className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-xs font-black text-slate-200 hover:bg-slate-800">Cancel</button>
              <button type="button" onClick={submitProjectQuote} disabled={savingQuote} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/50 bg-emerald-600 px-3 py-2 text-xs font-black text-white hover:bg-emerald-500 disabled:opacity-50"><Send className="h-3.5 w-3.5" /> {savingQuote ? 'Saving…' : 'Save quote'}</button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {quoteFilters.map(filter => {
          const Icon = filter.Icon;
          const active = quoteFilter === filter.key;
          return (
            <button
              key={filter.key}
              type="button"
              onClick={() => setQuoteFilter(filter.key)}
              title={filter.description}
              className={`rounded-lg px-3 py-2 text-left transition hover:-translate-y-0.5 ${active ? 'ring-2 ring-cyan-300/60' : 'opacity-90 hover:opacity-100'}`}
              style={active ? quotePanelStyle : quoteInsetStyle}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border ${active ? 'border-cyan-200/60 bg-cyan-400/20 text-cyan-100' : 'border-slate-500/60 bg-slate-900/60 text-slate-200'}`}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <p className="truncate text-[13px] font-black text-white">{filter.label}</p>
                </div>
                <span className="shrink-0 rounded-md border border-white/20 bg-white/10 px-1.5 py-0.5 text-xs font-black text-white">{filter.count}</span>
              </div>
              <p className="mt-1.5 text-base font-black text-white">{filter.value}</p>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: currentFilter.label, value: visibleQuotes.length },
          { label: 'Value In View', value: quoteMoney(visibleQuoted) },
          { label: 'Contractors', value: contractors.size },
          { label: 'Categories', value: categories.size },
        ].map(item => (
          <div key={item.label} className="rounded-lg p-4" style={quoteInsetStyle}>
            <p className="text-2xl font-black text-white">{item.value}</p>
            <p className="mt-0.5 text-xs font-bold uppercase tracking-wide text-cyan-100/75">{item.label}</p>
          </div>
        ))}
      </div>

      {loading ? <Loading /> : quoteFilter === 'compare' ? (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-[11px] font-black uppercase tracking-wide text-slate-400">
                <th className="px-3 py-2.5">Contractor</th>
                <th className="px-3 py-2.5">Quote #</th>
                <th className="px-3 py-2.5">Categories</th>
                <th className="px-3 py-2.5 text-right">Labor</th>
                <th className="px-3 py-2.5 text-right">Material</th>
                <th className="px-3 py-2.5 text-right">Total</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5 text-right">Pick</th>
              </tr>
            </thead>
            <tbody>
              {visibleQuotes.map((quote, qi) => {
                const cats = Array.from(new Set((Array.isArray(quote.line_items) ? quote.line_items : []).map((li: any) => li.category).filter(Boolean)));
                const isBest = qi === 0 && visibleQuotes.length > 1 && quoteNumberValue(quote.total_quote_amount) > 0;
                return (
                  <tr key={quote.id} className={`border-b border-white/5 ${isBest ? 'bg-emerald-500/10' : ''}`}>
                    <td className="px-3 py-3 align-top">
                      <div className="font-black text-white">{quote.contractor_company || quote.contractor_name || 'Unknown contractor'}</div>
                      {quote.contractor_company && quote.contractor_name && <div className="text-xs text-slate-400">{quote.contractor_name}</div>}
                    </td>
                    <td className="px-3 py-3 align-top font-mono text-xs text-slate-300">{quote.quote_number}</td>
                    <td className="px-3 py-3 align-top">
                      <div className="flex flex-wrap gap-1">
                        {cats.slice(0, 4).map((c: any) => <span key={c} className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] font-bold text-slate-200">{c}</span>)}
                        {cats.length > 4 && <span className="text-[10px] text-slate-400">+{cats.length - 4}</span>}
                        {cats.length === 0 && <span className="text-[10px] text-slate-500">—</span>}
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top text-right font-mono text-slate-300">{quoteMoney(quote.labor_cost)}</td>
                    <td className="px-3 py-3 align-top text-right font-mono text-slate-300">{quoteMoney(quote.material_cost)}</td>
                    <td className="px-3 py-3 align-top text-right">
                      <span className={`font-mono font-black ${isBest ? 'text-emerald-300' : 'text-white'}`}>{quoteMoney(quote.total_quote_amount)}</span>
                      {isBest && <div className="text-[9px] font-black uppercase tracking-wide text-emerald-400">Best price</div>}
                    </td>
                    <td className="px-3 py-3 align-top"><span className="rounded-full border border-white/15 bg-white/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-slate-200">{String(quote.status || '').replace(/_/g, ' ')}</span></td>
                    <td className="px-3 py-3 align-top text-right">
                      {quote.status === 'approved' ? (
                        <span className="inline-flex items-center gap-1 text-xs font-black text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" />Chosen</span>
                      ) : (
                        <button type="button" disabled={updatingQuoteId === quote.id} onClick={() => reviewQuote(quote, 'approve')} className="inline-flex items-center gap-1 rounded-lg border border-emerald-400/50 bg-emerald-600 px-2.5 py-1.5 text-xs font-black text-white transition-colors hover:bg-emerald-500 disabled:opacity-50">
                          <CheckCircle2 className="h-3.5 w-3.5" />Pick
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {visibleQuotes.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-10 text-center text-sm font-semibold text-slate-300">No quotes yet — add quotes (PDF or manual) and they'll line up here to compare.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="space-y-2">
          {visibleQuotes.map(quote => {
            const lineItems = Array.isArray(quote.line_items) ? quote.line_items : [];
            const isExpanded = Boolean(expandedQuoteIds[quote.id]);
            const canReview = quote.status === 'submitted';
            const contractorLabel = quote.contractor_company || quote.contractor_name || 'Unknown contractor';
            const contactLine = [quote.contractor_phone, quote.contractor_email].filter(Boolean).join(' - ') || 'No contact stored';
            const scopeTitle = quoteScopeTitle(quote);
            const sentLabel = quote.quote_request_sent_at
              ? compactQuoteDateTime(quote.quote_request_sent_at)
              : quote.imported_from === 'vendor_link'
                ? 'Sent time not recorded'
                : 'Manual upload';
            const returnedLabel = quote.quote_returned_at
              ? compactQuoteDateTime(quote.quote_returned_at)
              : compactQuoteDateTime(quote.created_at);
            const hasImageAttachment = quoteAttachmentIsImage(quote);
            return (
              <div key={quote.id} className="rounded-lg px-3 py-2" style={quotePanelStyle}>
                <div className="flex items-center gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <p className="shrink-0 text-sm font-black text-white">{quote.quote_number || 'Quote # pending'}</p>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black ${statusColors[quote.status] || 'bg-slate-700/80 text-slate-100 border border-slate-400/40'}`}>
                      {quoteStatusLabel(quote.status)}
                    </span>
                    <span className="shrink-0 max-w-[34%] truncate text-sm font-black text-white">{contractorLabel}</span>
                    <span className="shrink-0 text-slate-500">·</span>
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-300">{scopeTitle}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2.5">
                    <p className="text-base font-black text-white">{quoteMoney(quote.total_quote_amount)}</p>
                    {isExpanded && canReview && (
                      <>
                        <button
                          type="button"
                          disabled={updatingQuoteId === quote.id}
                          onClick={() => reviewQuote(quote, 'approve')}
                          className="inline-flex items-center gap-1 rounded-md border border-emerald-200/60 bg-emerald-500/25 px-2 py-1 text-[11px] font-black text-emerald-50 transition hover:bg-emerald-500/30 disabled:opacity-50"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Approve
                        </button>
                        <button
                          type="button"
                          disabled={updatingQuoteId === quote.id}
                          onClick={() => reviewQuote(quote, 'deny')}
                          className="inline-flex items-center gap-1 rounded-md border border-rose-200/60 bg-rose-500/25 px-2 py-1 text-[11px] font-black text-rose-50 transition hover:bg-rose-500/30 disabled:opacity-50"
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          Deny
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => toggleQuoteExpanded(quote.id)}
                      aria-expanded={isExpanded}
                      className="inline-flex items-center gap-1 rounded-md border border-cyan-200/40 bg-cyan-400/10 px-2 py-1 text-[11px] font-black text-cyan-50 transition hover:bg-cyan-400/20"
                    >
                      {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      {isExpanded ? 'Hide' : 'Details'}
                    </button>
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] font-semibold text-cyan-100/55">
                  <span>Sent: {sentLabel}</span>
                  <span className="text-slate-600">·</span>
                  <span>Returned: {returnedLabel}</span>
                  <span className="text-slate-600">·</span>
                  <span>{lineItems.length} {lineItems.length === 1 ? 'line' : 'lines'}</span>
                </div>

                {isExpanded && (
                  <div className="mt-2 space-y-2 rounded-lg p-2.5" style={quoteInsetStyle}>
                    <div className="grid gap-2 md:grid-cols-2">
                      <div className="min-w-0">
                        <p className="text-[10px] font-black uppercase tracking-wide text-cyan-100/70">Contact</p>
                        <p className="truncate text-xs font-semibold text-slate-100">{contactLine}</p>
                        {quote.contractor_address && <p className="truncate text-xs font-semibold text-slate-300">{quote.contractor_address}</p>}
                      </div>
                      <div className="min-w-0 md:text-right">
                        <p className="text-[10px] font-black uppercase tracking-wide text-cyan-100/70">Quote Date</p>
                        <p className="text-xs font-semibold text-slate-100">{quote.quote_date || 'No quote date'}</p>
                      </div>
                    </div>
                    {(quote.scope_description || quote.notes || quote.document_download_url) && (
                      <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
                        <div className="min-w-0">
                          {quote.scope_description && (
                            <p className="text-xs font-semibold leading-5 text-slate-100">{quote.scope_description}</p>
                          )}
                          {quote.notes && <p className="mt-1 text-xs font-semibold text-slate-300">{quote.notes}</p>}
                        </div>
                        {quote.document_download_url && (
                          <div className="flex flex-col gap-2 lg:items-end">
                            {hasImageAttachment && (
                              <img src={quote.document_download_url} alt="Uploaded quote attachment" className="h-20 w-28 rounded-md border border-cyan-200/30 object-cover" />
                            )}
                            <a href={quote.document_download_url} className="inline-flex min-h-8 items-center justify-center rounded-md border border-cyan-200/50 bg-cyan-400/10 px-2.5 py-1.5 text-xs font-black text-cyan-50 transition hover:bg-cyan-400/25">
                              {hasImageAttachment ? 'Open Attachment' : 'Download Quote'}
                            </a>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="overflow-x-auto rounded-lg border border-cyan-200/20">
                      <table className="w-full min-w-[680px] text-xs">
                        <thead className="bg-slate-950/70">
                          <tr className="text-left text-[11px] uppercase tracking-wide text-cyan-100/75">
                            <th className="py-1.5 px-2">Category</th>
                            <th className="py-1.5 px-2">Description</th>
                            <th className="py-1.5 px-2 text-right">Qty</th>
                            <th className="py-1.5 px-2">Unit</th>
                            <th className="py-1.5 px-2 text-right">Unit Price</th>
                            <th className="py-1.5 px-2 text-right">Line Price</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-cyan-200/10 bg-slate-950/40">
                          {lineItems.map((item: any, index: number) => (
                            <tr key={item.id || `${quote.id}-${index}`}>
                              <td className="py-1.5 px-2 font-black text-white">{item.category || '-'}</td>
                              <td className="py-1.5 px-2 font-semibold text-slate-100">{item.description || item.subcategory || '-'}</td>
                              <td className="py-1.5 px-2 text-right font-semibold text-slate-100">{quoteNumberValue(item.quantity).toLocaleString('en-US')}</td>
                              <td className="py-1.5 px-2 font-semibold text-slate-300">{item.unit || '-'}</td>
                              <td className="py-1.5 px-2 text-right font-semibold text-slate-100">{quoteNumberValue(item.unit_price) > 0 ? quoteMoney(item.unit_price) : (quoteNumberValue(item.total_line_item_price) > 0 && quoteNumberValue(item.quantity) > 0 ? <>{quoteMoney(quoteNumberValue(item.total_line_item_price) / quoteNumberValue(item.quantity))}{quoteNumberValue(item.quantity) === 1 && <span className="ml-1 rounded bg-slate-800 px-1 text-[9px] font-bold uppercase tracking-wide text-slate-400">lump</span>}</> : quoteMoney(0))}</td>
                              <td className="py-1.5 px-2 text-right font-black text-white">{quoteMoney(item.total_line_item_price)}</td>
                            </tr>
                          ))}
                          {lineItems.length === 0 && (
                            <tr>
                              <td colSpan={6} className="py-4 text-center text-xs font-semibold text-slate-300">No line items stored for this quote</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {visibleQuotes.length === 0 && (
            <div className="rounded-lg py-12 text-center" style={quoteInsetStyle}>
              <FileText className="w-8 h-8 text-cyan-100/70 mx-auto mb-2" />
              <p className="text-sm font-semibold text-slate-200">No quotes in {currentFilter.label}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
