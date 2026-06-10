export const MOBILE_DATA_CHANGED_EVENT = 'buildtrack:mobile-data-changed';
const MOBILE_DATA_CHANGED_AT_KEY = 'buildtrack-mobile-data-changed-at';

export function lastMobileDataChangedAt() {
  if (typeof window === 'undefined') return 0;
  return Number(localStorage.getItem(MOBILE_DATA_CHANGED_AT_KEY) || 0);
}

export function notifyMobileDataChanged(detail: Record<string, unknown> = {}) {
  if (typeof window === 'undefined') return;
  const changedAt = Date.now();
  localStorage.setItem(MOBILE_DATA_CHANGED_AT_KEY, String(changedAt));
  window.dispatchEvent(new CustomEvent(MOBILE_DATA_CHANGED_EVENT, {
    detail: { ...detail, changedAt },
  }));
}
