import { useEffect, useRef, useState } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

type DraftField = {
  value: string;
  baseline: string;
  updatedAt: number;
};

type DraftRecord = {
  version: 1;
  updatedAt: number;
  fields: Record<string, DraftField>;
};

type DraftStatus = 'saved' | 'restored' | null;

const STORAGE_PREFIX = 'buildtrack:drafts:v1';
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 500;
const MAX_DRAFT_FIELDS = 120;
const MAX_FIELD_LENGTH = 100_000;
const SAVE_ACTION_PATTERN = /\b(save|add|create|submit|post|send|update|record|log|upload|publish|complete|approve)\b/i;
const SENSITIVE_FIELD_PATTERN = /password|passcode|\bpin\b|verification|two.?factor|\botp\b|secret|token|api.?key|security.?code|credit.?card|card.?number|\bcvv\b|\bssn\b|social security|bank account|routing number/i;
const EXCLUDED_ROUTES = ['/login', '/forgot-password', '/reset-password', '/change-password'];

type DraftElement = HTMLInputElement | HTMLTextAreaElement;

function normalizeKeyPart(value: string | null | undefined) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9:_\- ]/g, '')
    .slice(0, 100);
}

function fieldLabel(element: DraftElement) {
  const id = element.id;
  if (id) {
    const explicitLabel = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
    if (explicitLabel?.textContent) return explicitLabel.textContent;
  }
  return element.closest('label')?.textContent || '';
}

function isEligibleField(value: EventTarget | Element | null): value is DraftElement {
  if (!(value instanceof HTMLInputElement || value instanceof HTMLTextAreaElement)) return false;
  if (value.disabled || value.readOnly || value.dataset.autosave === 'off') return false;

  if (value instanceof HTMLInputElement) {
    const type = (value.type || 'text').toLowerCase();
    if (!['text', 'email', 'tel', 'url', 'number', 'date', 'time', 'datetime-local', 'month', 'week'].includes(type)) {
      return false;
    }
  }

  const identity = [
    value.id,
    value.name,
    value.type,
    value.autocomplete,
    value.placeholder,
    value.getAttribute('aria-label'),
    fieldLabel(value),
  ].join(' ');
  return !SENSITIVE_FIELD_PATTERN.test(identity);
}

function fieldScope(element: DraftElement) {
  return element.closest<HTMLElement>('form, [role="dialog"], [data-autosave-scope], .modal, [class*="modal"]')
    || element.closest<HTMLElement>('main')
    || document.body;
}

function scopeDescriptor(scope: HTMLElement) {
  const heading = scope.querySelector<HTMLElement>('h1, h2, h3, legend')?.textContent;
  return normalizeKeyPart(
    scope.dataset.autosaveScope
      || scope.id
      || scope.getAttribute('aria-label')
      || scope.getAttribute('name')
      || heading
      || scope.tagName
  );
}

function fieldDescriptor(element: DraftElement) {
  return normalizeKeyPart(
    element.dataset.autosaveKey
      || element.name
      || element.id
      || element.getAttribute('aria-label')
      || element.placeholder
      || fieldLabel(element)
      || `${element.tagName}-${element.type || 'text'}`
  );
}

function fieldKey(element: DraftElement) {
  const scope = fieldScope(element);
  const descriptor = fieldDescriptor(element);
  const matches = Array.from(scope.querySelectorAll('input, textarea'))
    .filter(isEligibleField)
    .filter(candidate => fieldDescriptor(candidate) === descriptor);
  const duplicateIndex = Math.max(0, matches.indexOf(element));
  return `${scopeDescriptor(scope)}|${element.tagName.toLowerCase()}:${descriptor}|${duplicateIndex}`;
}

function setNativeValue(element: DraftElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function readDraft(storageKey: string): DraftRecord {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || 'null') as DraftRecord | null;
    if (!parsed || parsed.version !== 1 || Date.now() - Number(parsed.updatedAt || 0) > DRAFT_MAX_AGE_MS) {
      localStorage.removeItem(storageKey);
      return { version: 1, updatedAt: Date.now(), fields: {} };
    }
    return parsed;
  } catch {
    localStorage.removeItem(storageKey);
    return { version: 1, updatedAt: Date.now(), fields: {} };
  }
}

function writeDraft(storageKey: string, draft: DraftRecord) {
  const entries = Object.entries(draft.fields)
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_DRAFT_FIELDS);
  draft.fields = Object.fromEntries(entries);
  draft.updatedAt = Date.now();

  try {
    if (entries.length === 0) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, JSON.stringify(draft));
  } catch {
    // A full browser storage quota must never interrupt note entry.
  }
}

function collectFields(scope: ParentNode) {
  return Array.from(scope.querySelectorAll('input, textarea')).filter(isEligibleField);
}

export default function DraftAutosave() {
  const location = useLocation();
  const { user, token } = useAuthStore();
  const [status, setStatus] = useState<DraftStatus>(null);
  const statusTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!user?.id || !token || EXCLUDED_ROUTES.some(route => location.pathname.startsWith(route))) return;

    const routeKey = `${location.pathname}${location.search}${location.hash}`;
    const storageKey = `${STORAGE_PREFIX}:${user.id}:${routeKey}`;
    const draft = readDraft(storageKey);
    const baselines = new WeakMap<DraftElement, string>();
    const recentFieldKeys = new Map<string, number>();
    let writeTimer: number | null = null;
    let restoreTimer: number | null = null;
    let restoring = false;
    let pendingSave: { keys: Set<string>; expiresAt: number } | null = null;
    const initialRestoreTimers: number[] = [];

    const showStatus = (nextStatus: Exclude<DraftStatus, null>) => {
      setStatus(nextStatus);
      if (statusTimer.current) window.clearTimeout(statusTimer.current);
      statusTimer.current = window.setTimeout(() => setStatus(null), 1800);
    };

    const flush = (showSaved = false) => {
      if (writeTimer) {
        window.clearTimeout(writeTimer);
        writeTimer = null;
      }
      writeDraft(storageKey, draft);
      if (showSaved) showStatus('saved');
    };

    const scheduleWrite = () => {
      if (writeTimer) window.clearTimeout(writeTimer);
      writeTimer = window.setTimeout(() => flush(true), SAVE_DEBOUNCE_MS);
    };

    const rememberBaseline = (event: Event) => {
      if (!isEligibleField(event.target)) return;
      if (!baselines.has(event.target)) baselines.set(event.target, event.target.value);
    };

    const captureValue = (event: Event) => {
      if (restoring || !isEligibleField(event.target)) return;
      const element = event.target;
      const key = fieldKey(element);
      const value = element.value.slice(0, MAX_FIELD_LENGTH);
      if (!value) {
        delete draft.fields[key];
        recentFieldKeys.delete(key);
      } else {
        draft.fields[key] = {
          value,
          baseline: baselines.get(element) ?? '',
          updatedAt: Date.now(),
        };
        recentFieldKeys.set(key, Date.now());
      }
      scheduleWrite();
    };

    const restoreFields = () => {
      const fields = collectFields(document);
      let restoredCount = 0;
      restoring = true;
      try {
        fields.forEach(element => {
          const saved = draft.fields[fieldKey(element)];
          if (!saved?.value || element.value === saved.value) return;
          const canRestore = element.value === '' || element.value === saved.baseline;
          if (!canRestore) return;
          baselines.set(element, saved.baseline);
          setNativeValue(element, saved.value);
          restoredCount += 1;
        });
      } finally {
        restoring = false;
      }
      if (restoredCount > 0) showStatus('restored');
    };

    const scheduleRestore = () => {
      if (restoreTimer) window.clearTimeout(restoreTimer);
      restoreTimer = window.setTimeout(restoreFields, 120);
    };

    const stageSaveKeys = (scope: ParentNode | null) => {
      const keys = new Set<string>();
      if (scope) {
        collectFields(scope).forEach(field => {
          const key = fieldKey(field);
          if (draft.fields[key]) keys.add(key);
        });
      }
      if (keys.size === 0) {
        const cutoff = Date.now() - 10 * 60 * 1000;
        recentFieldKeys.forEach((editedAt, key) => {
          if (editedAt >= cutoff && draft.fields[key]) keys.add(key);
        });
      }
      if (keys.size > 0) pendingSave = { keys, expiresAt: Date.now() + 15_000 };
    };

    const handleSubmit = (event: Event) => {
      stageSaveKeys(event.target instanceof HTMLFormElement ? event.target : null);
      flush();
    };

    const handleClick = (event: Event) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>('button, [role="button"], input[type="submit"]')
        : null;
      if (!target) return;
      const actionText = [
        target.textContent,
        target.getAttribute('aria-label'),
        target.getAttribute('title'),
        target.getAttribute('value'),
      ].join(' ');
      const isSubmit = target instanceof HTMLButtonElement && target.type === 'submit'
        || target instanceof HTMLInputElement && target.type === 'submit';
      if (!isSubmit && !SAVE_ACTION_PATTERN.test(actionText)) return;

      const scope = target.closest<HTMLElement>('form, [role="dialog"], [data-autosave-scope], .modal, [class*="modal"]');
      stageSaveKeys(scope);
      flush();
    };

    const handleMutationSuccess = (event: Event) => {
      const detail = (event as CustomEvent<{ url?: string }>).detail;
      if (String(detail?.url || '').startsWith('/auth/')) return;
      if (!pendingSave || pendingSave.expiresAt < Date.now()) {
        pendingSave = null;
        return;
      }
      const keys = pendingSave.keys;
      pendingSave = null;
      keys.forEach(key => {
        delete draft.fields[key];
        recentFieldKeys.delete(key);
      });
      flush();
    };

    const handleBeforeUnload = () => flush();
    const observer = new MutationObserver(scheduleRestore);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('focusin', rememberBaseline, true);
    document.addEventListener('input', captureValue, true);
    document.addEventListener('change', captureValue, true);
    document.addEventListener('submit', handleSubmit, true);
    document.addEventListener('click', handleClick, true);
    window.addEventListener('buildtrack:mutation-succeeded', handleMutationSuccess);
    window.addEventListener('beforeunload', handleBeforeUnload);

    restoreFields();
    [400, 1200, 2500].forEach(delay => initialRestoreTimers.push(window.setTimeout(restoreFields, delay)));

    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', rememberBaseline, true);
      document.removeEventListener('input', captureValue, true);
      document.removeEventListener('change', captureValue, true);
      document.removeEventListener('submit', handleSubmit, true);
      document.removeEventListener('click', handleClick, true);
      window.removeEventListener('buildtrack:mutation-succeeded', handleMutationSuccess);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (restoreTimer) window.clearTimeout(restoreTimer);
      initialRestoreTimers.forEach(timer => window.clearTimeout(timer));
      if (statusTimer.current) window.clearTimeout(statusTimer.current);
      flush();
    };
  }, [location.hash, location.pathname, location.search, token, user?.id]);

  if (!status) return null;
  const restored = status === 'restored';
  const Icon = restored ? RotateCcw : Check;
  return (
    <div
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[10000] flex items-center gap-2 rounded-md border border-slate-600 bg-slate-950 px-3 py-2 text-xs font-bold text-white shadow-xl"
    >
      <Icon size={14} aria-hidden="true" />
      {restored ? 'Draft restored' : 'Draft saved'}
    </div>
  );
}
