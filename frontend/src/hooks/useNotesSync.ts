import { useEffect, useRef } from 'react';
import api from '../lib/api';
import { openEventStream } from '../lib/noteEvents';
import { useAuthStore } from '../store/authStore';

// One canonical API read on change, reconnect or return to a tab. Refs let callers
// use their current refresh function without reopening the stream on each render.
export function useNotesSync(projectId: string | undefined, refresh: () => Promise<unknown>, enabled = true) {
  const { token, user } = useAuthStore();
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    if (!enabled || !token) return;
    let connected = false;
    let active = true;
    let inFlight = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      if (!active || document.visibilityState !== 'visible') return;
      if (inFlight) { again = true; return; }
      inFlight = true;
      try { await latest.current(); } catch { /* retain the last successful view */ }
      finally { inFlight = false; if (again && active) { again = false; schedule(); } }
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void run(), 150); };
    const close = openEventStream(`${api.defaults.baseURL || '/api'}/notes/stream`, {
      onOpen: () => { connected = true; schedule(); },
      onClose: () => { connected = false; },
      onMessage: raw => {
        try {
          const event = JSON.parse(raw);
          if (event.type === 'notes_changed' && (!projectId || event.project_id === projectId)) schedule();
        } catch { /* ignore malformed events */ }
      },
    });
    const mutation = (event: Event) => {
      const url = (event as CustomEvent<{ url?: string }>).detail?.url || '';
      if (/\/projects\/[^/]+\/notes(?:\/|$)/.test(url) && (!projectId || url.startsWith(`/projects/${projectId}/notes`))) schedule();
    };
    const fallback = setInterval(() => { if (!connected) schedule(); }, 30000);
    window.addEventListener('focus', schedule);
    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('buildtrack:mutation-succeeded', mutation);
    return () => {
      active = false; close(); clearTimeout(timer); clearInterval(fallback);
      window.removeEventListener('focus', schedule);
      document.removeEventListener('visibilitychange', schedule);
      window.removeEventListener('buildtrack:mutation-succeeded', mutation);
    };
  }, [enabled, projectId, token, user?.id]);
}
