import { formatEasternDate } from './time';

// QuickBooks bill-payment activity the directory endpoints attach to every
// contractor / supplier row (backend users.js, QBO_ACTIVITY_* fragments).
// "Most active" = paid through QuickBooks in the last six months. Both the
// Contractors page and the Suppliers page rank with THIS comparator so the two
// directories can never disagree.
export interface QboActivityFields {
  qbo_last_paid_at?: string | null; // 'YYYY-MM-DD', all-time most recent payment
  qbo_last_paid_amount?: number | null;
  qbo_paid_count_6mo?: number;
  qbo_paid_total_6mo?: number;
  qbo_active_6mo?: boolean | number;
  qbo_match_kind?: 'vendor_id' | 'name' | null;
}

export const isQboActive = (row: QboActivityFields) => Boolean(row.qbo_active_6mo);

// Most recently paid first, then more payments in the window, then A-Z. The
// dates are 'YYYY-MM-DD' so a plain string compare is exact - never route
// them through a timestamp parser.
export const compareByQboActivity = (
  a: QboActivityFields & { name?: string | null },
  b: QboActivityFields & { name?: string | null },
) =>
  (Number(isQboActive(b)) - Number(isQboActive(a)))
  || (b.qbo_last_paid_at || '').localeCompare(a.qbo_last_paid_at || '')
  || ((b.qbo_paid_count_6mo || 0) - (a.qbo_paid_count_6mo || 0))
  || (a.name || '').localeCompare(b.name || '');

// A bare 'YYYY-MM-DD' rendered as that calendar day in Eastern time. Noon
// avoids the previous-day shift a midnight-UTC parse would give.
// formatEasternDate keeps its own year:'numeric' default unless the caller
// overrides it, so the short style must pass year: undefined explicitly.
export const formatQboDate = (value?: string | null, style: 'long' | 'short' = 'long') =>
  value
    ? formatEasternDate(`${String(value).slice(0, 10)}T12:00:00`, style === 'long'
      ? { month: 'short', day: 'numeric', year: 'numeric' }
      : { month: 'short', day: 'numeric', year: undefined })
    : '-';

export const formatMoney = (value?: number | null) =>
  Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// One-line badge under a vendor's name.
export const qboActivityLine = (row: QboActivityFields) => {
  const count = Number(row.qbo_paid_count_6mo || 0);
  if (isQboActive(row)) {
    return `Paid ${formatQboDate(row.qbo_last_paid_at, 'short')} · ${count} payment${count === 1 ? '' : 's'} in the last 6 months`;
  }
  if (row.qbo_last_paid_at) return `Last paid ${formatQboDate(row.qbo_last_paid_at)}`;
  return '';
};

// Activity for two duplicate directory rows folded into one: the later
// payment wins, counts take the max, active is OR.
export const mergeQboActivity = (a: QboActivityFields, b: QboActivityFields): QboActivityFields => {
  const dateWinner = (b.qbo_last_paid_at || '') > (a.qbo_last_paid_at || '') ? b : a;
  return {
    qbo_last_paid_at: dateWinner.qbo_last_paid_at || null,
    qbo_last_paid_amount: dateWinner.qbo_last_paid_amount ?? null,
    qbo_paid_count_6mo: Math.max(Number(a.qbo_paid_count_6mo || 0), Number(b.qbo_paid_count_6mo || 0)),
    qbo_paid_total_6mo: Math.max(Number(a.qbo_paid_total_6mo || 0), Number(b.qbo_paid_total_6mo || 0)),
    qbo_active_6mo: isQboActive(a) || isQboActive(b),
    qbo_match_kind: a.qbo_match_kind === 'vendor_id' || b.qbo_match_kind === 'vendor_id'
      ? 'vendor_id'
      : (a.qbo_match_kind || b.qbo_match_kind || null),
  };
};
