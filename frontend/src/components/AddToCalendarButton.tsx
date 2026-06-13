import { type MouseEvent, useState } from 'react';
import { CalendarPlus, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { Modal } from './ui';
import VoiceTextarea from './VoiceTextarea';

type CalendarEventType = 'task' | 'maintenance' | 'inspection' | 'note' | 'other';
type CalendarPriority = 'low' | 'normal' | 'high' | 'critical';

interface AddToCalendarButtonProps {
  label?: string;
  defaultTitle?: string;
  defaultDescription?: string;
  defaultDate?: string | null;
  defaultTime?: string | null;
  defaultEventType?: CalendarEventType;
  defaultPriority?: CalendarPriority;
  projectId?: string | null;
  sourceType?: string;
  sourceId?: string | null;
  contextLabel?: string | null;
  buttonClassName?: string;
  modalTitle?: string;
  ariaLabel?: string;
  iconOnly?: boolean;
  icon?: 'calendar' | 'plus';
  onSaved?: () => void | Promise<void>;
}

const todayInputValue = () => new Date().toISOString().slice(0, 10);

const normalizeDateInput = (value?: string | null) => {
  if (!value) return todayInputValue();
  return String(value).slice(0, 10);
};

const defaultButtonClass =
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-cyan-300/60 bg-gradient-to-r from-cyan-500/22 via-blue-500/18 to-orange-500/18 px-3 py-2 text-sm font-black text-white shadow-sm shadow-cyan-950/20 transition-colors hover:border-cyan-200 hover:from-cyan-400/28 hover:via-blue-500/22 hover:to-orange-400/22 focus:outline-none focus:ring-2 focus:ring-cyan-300/50';

export default function AddToCalendarButton({
  label = 'Add to Calendar',
  defaultTitle = '',
  defaultDescription = '',
  defaultDate,
  defaultTime = '',
  defaultEventType = 'task',
  defaultPriority = 'normal',
  projectId = null,
  sourceType = 'manual',
  sourceId = null,
  contextLabel = null,
  buttonClassName = defaultButtonClass,
  modalTitle = 'Add to Calendar',
  ariaLabel,
  iconOnly = false,
  icon = 'calendar',
  onSaved,
}: AddToCalendarButtonProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState(defaultDescription);
  const [date, setDate] = useState(normalizeDateInput(defaultDate));
  const [time, setTime] = useState(defaultTime || '');
  const [eventType, setEventType] = useState<CalendarEventType>(defaultEventType);
  const [priority, setPriority] = useState<CalendarPriority>(defaultPriority);
  const [stopSignal, setStopSignal] = useState(0);

  const resetForm = () => {
    setTitle(defaultTitle);
    setDescription(defaultDescription);
    setDate(normalizeDateInput(defaultDate));
    setTime(defaultTime || '');
    setEventType(defaultEventType);
    setPriority(defaultPriority);
  };

  const openComposer = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    resetForm();
    setOpen(true);
  };

  const closeComposer = () => {
    setStopSignal(current => current + 1);
    setOpen(false);
  };

  const saveEvent = async () => {
    if (!title.trim()) {
      toast.error('Calendar title is required');
      return;
    }
    if (!date) {
      toast.error('Calendar date is required');
      return;
    }

    setSaving(true);
    try {
      await api.post('/calendar/events', {
        project_id: projectId || null,
        title: title.trim(),
        description: description.trim() || null,
        event_type: eventType,
        scheduled_for: date,
        due_time: time || null,
        priority,
        source_type: sourceType,
        source_id: sourceId || null,
      });
      toast.success('Added to main calendar');
      setOpen(false);
      setStopSignal(current => current + 1);
      await onSaved?.();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to add calendar item');
    } finally {
      setSaving(false);
    }
  };

  const ButtonIcon = icon === 'plus' ? Plus : CalendarPlus;
  const buttonStyle = iconOnly
    ? undefined
    : { minWidth: 'max-content', whiteSpace: 'nowrap' } as const;

  return (
    <>
      <button type="button" onClick={openComposer} className={buttonClassName} style={buttonStyle} aria-label={ariaLabel || label}>
        <ButtonIcon className="h-3.5 w-3.5 flex-shrink-0" />
        <span className={iconOnly ? 'sr-only' : 'flex-shrink-0 whitespace-nowrap'}>{label}</span>
      </button>

      <Modal
        isOpen={open}
        onClose={closeComposer}
        title={modalTitle}
        description="Create a task or reminder on the main BuildTrack operations calendar."
        size="lg"
      >
        <div className="space-y-4">
          {contextLabel ? (
            <div className="rounded-xl border border-cyan-200 bg-gradient-to-br from-cyan-50 to-blue-50 px-4 py-3">
              <p className="text-xs font-black uppercase tracking-wide text-cyan-800">Calendar source</p>
              <p className="mt-1 text-sm font-black text-slate-950">{contextLabel}</p>
            </div>
          ) : null}

          <label className="block">
            <span className="text-xs font-black uppercase tracking-wide text-slate-600">Task or reminder title</span>
            <input
              value={title}
              onChange={event => setTitle(event.target.value)}
              className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-950 outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-200"
              placeholder="What should show on the calendar?"
            />
          </label>

          <div className="grid gap-3 md:grid-cols-4">
            <label className="block md:col-span-2">
              <span className="text-xs font-black uppercase tracking-wide text-slate-600">Date</span>
              <input
                type="date"
                value={date}
                onChange={event => setDate(event.target.value)}
                className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-950 outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-200"
              />
            </label>
            <label className="block">
              <span className="text-xs font-black uppercase tracking-wide text-slate-600">Time</span>
              <input
                type="time"
                value={time}
                onChange={event => setTime(event.target.value)}
                className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-950 outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-200"
              />
            </label>
            <label className="block">
              <span className="text-xs font-black uppercase tracking-wide text-slate-600">Priority</span>
              <select
                value={priority}
                onChange={event => setPriority(event.target.value as CalendarPriority)}
                className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-950 outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-200"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </label>
          </div>

          <label className="block">
            <span className="text-xs font-black uppercase tracking-wide text-slate-600">Calendar type</span>
            <select
              value={eventType}
              onChange={event => setEventType(event.target.value as CalendarEventType)}
              className="mt-1 min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-950 outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-200"
            >
              <option value="task">Task</option>
              <option value="inspection">Inspection</option>
              <option value="maintenance">Maintenance</option>
              <option value="note">Note</option>
              <option value="other">Calendar</option>
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-black uppercase tracking-wide text-slate-600">Notes</span>
            <VoiceTextarea
              value={description}
              onChange={event => setDescription(event.target.value)}
              stopSignal={stopSignal}
              rows={4}
              className="mt-1 w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold leading-6 text-slate-950 outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-200"
              placeholder="Add details users should see when they open the calendar item."
            />
          </label>

          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={closeComposer}
              className="min-h-10 rounded-xl border border-slate-300 bg-white px-4 text-sm font-black text-slate-700 transition-colors hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveEvent}
              disabled={saving}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-cyan-300 bg-cyan-600 px-4 text-sm font-black text-white shadow-sm transition hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <CalendarPlus className="h-4 w-4" />
              {saving ? 'Saving' : 'Add to Calendar'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
