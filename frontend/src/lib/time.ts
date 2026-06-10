export const EASTERN_TIME_ZONE = 'America/New_York';

type DateTimeOptions = Intl.DateTimeFormatOptions;

export function parseBuildTrackTimestamp(value?: string | null): Date | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const parsed = new Date(trimmed);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const parsed = new Date(`${normalized}Z`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function formatEasternDateTime(value?: string | null, options: DateTimeOptions = {}) {
  const parsed = parseBuildTrackTimestamp(value);
  if (!parsed) return '-';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TIME_ZONE,
    month: 'short',
    day: 'numeric',
    year: options.year,
    hour: 'numeric',
    minute: '2-digit',
    ...options,
  }).format(parsed);
}

export function formatEasternDate(value?: string | null, options: DateTimeOptions = {}) {
  const parsed = parseBuildTrackTimestamp(value);
  if (!parsed) return '-';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TIME_ZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...options,
  }).format(parsed);
}

export function formatDateOnly(value?: string | null, options: DateTimeOptions = {}) {
  const trimmed = String(value || '').trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return formatEasternDate(value, options);
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (!Number.isFinite(parsed.getTime())) return '-';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...options,
  }).format(parsed);
}

export function formatEasternTime(value?: string | null, options: DateTimeOptions = {}) {
  const parsed = parseBuildTrackTimestamp(value);
  if (!parsed) return '-';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
    ...options,
  }).format(parsed);
}

export function formatEasternRelative(value?: string | null) {
  const parsed = parseBuildTrackTimestamp(value);
  if (!parsed) return '-';
  const diffSeconds = Math.round((Date.now() - parsed.getTime()) / 1000);
  const future = diffSeconds < 0;
  const abs = Math.abs(diffSeconds);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 60 * 60 * 24 * 365],
    ['month', 60 * 60 * 24 * 30],
    ['week', 60 * 60 * 24 * 7],
    ['day', 60 * 60 * 24],
    ['hour', 60 * 60],
    ['minute', 60],
    ['second', 1],
  ];
  const [unit, seconds] = units.find(([, size]) => abs >= size) || ['second', 1];
  const valueForUnit = Math.max(1, Math.floor(abs / seconds)) * (future ? 1 : -1);
  return new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' }).format(valueForUnit, unit);
}

export function easternTimeZoneLabel() {
  return 'New York time';
}
