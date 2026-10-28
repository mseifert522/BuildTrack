export const EASTERN_TIME_ZONE = 'America/New_York';

type DateTimeOptions = Intl.DateTimeFormatOptions;

// 2026-10-28: building an Intl formatter (especially a time-zone one) costs far more than
// calling .format(), and feeds/lists call these helpers dozens of times per render. Cache one
// formatter per distinct option set; same options give byte-identical output. JSON.stringify
// drops undefined keys, which Intl also treats as absent, so those share an entry correctly.
const dateTimeFormatCache = new Map<string, Intl.DateTimeFormat>();
const DATE_TIME_FORMAT_CACHE_LIMIT = 200;

function cachedDateTimeFormat(options: DateTimeOptions) {
  const key = JSON.stringify(options);
  let formatter = dateTimeFormatCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', options);
    // Option sets come from code, so this never fills in practice; the cap is only a backstop.
    if (dateTimeFormatCache.size >= DATE_TIME_FORMAT_CACHE_LIMIT) dateTimeFormatCache.clear();
    dateTimeFormatCache.set(key, formatter);
  }
  return formatter;
}

const relativeTimeFormatter = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });

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
  return cachedDateTimeFormat({
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
  return cachedDateTimeFormat({
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
  return cachedDateTimeFormat({
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
  return cachedDateTimeFormat({
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
  return relativeTimeFormatter.format(valueForUnit, unit);
}

export function easternTimeZoneLabel() {
  return 'New York time';
}
