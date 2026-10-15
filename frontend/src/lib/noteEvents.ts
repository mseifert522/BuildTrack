// Live notes stream (GET /api/projects/:id/notes/stream). EventSource cannot send an
// Authorization header and the API is Bearer-only, so the stream is read with fetch().
const NOTES_STREAM_IDLE_MS = 60_000; // the server heartbeats every 25s
const NOTES_STREAM_MAX_BACKOFF_MS = 30_000;

// The api client's auth headers (lib/api.ts), read fresh on every connect: the session
// refresh in App.tsx rotates the token in localStorage without touching the auth store.
function eventStreamHeaders(): Record<string, string> | null {
  const token = localStorage.getItem('token');
  if (!token) return null;
  const contractorToken = localStorage.getItem('contractor_token');
  const activityKey = contractorToken && contractorToken === token
    ? 'contractor_last_activity_at'
    : 'auth_last_activity_at';
  const lastActivity = localStorage.getItem(activityKey);
  const headers: Record<string, string> = { Accept: 'text/event-stream', Authorization: `Bearer ${token}` };
  // Like the api client: a reconnect then counts as session activity only when the
  // user was really active, so a phone left on this page cannot keep a session alive.
  if (lastActivity) headers['X-BuildTrack-Last-Activity'] = lastActivity;
  return headers;
}

// Reads a text/event-stream body and hands each event's data to onMessage, as
// EventSource's onmessage would. Resolves when the server ends the stream.
async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onMessage: (data: string) => void,
  onBytes: () => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  let eventType = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    onBytes();
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (!line) {
        // A blank line ends the event; onmessage only ever saw unnamed events.
        if (dataLines.length && (!eventType || eventType === 'message')) onMessage(dataLines.join('\n'));
        dataLines = [];
        eventType = '';
        continue;
      }
      if (line.startsWith(':')) continue; // comment: the server's heartbeat
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') dataLines.push(value);
      else if (field === 'event') eventType = value;
    }
  }
}

// Opens the stream and keeps it open: reconnects with jittered backoff, drops a stream
// that goes silent, and returns the cleanup. A raw fetch, not the api client, so a 401
// here never trips the api client's global logout redirect.
export function openEventStream(url: string, handlers: {
  onOpen: () => void;
  onClose: () => void;
  onMessage: (data: string) => void;
}) {
  let stopped = false;
  let controller: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;

  const connect = async () => {
    if (stopped) return;
    const ctrl = new AbortController();
    controller = ctrl;
    // Silent past two heartbeats means dead (phone slept, network switched) even if
    // the socket never said so: abort, and the finally block reconnects.
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ctrl.abort(), NOTES_STREAM_IDLE_MS);
    };
    let retry = true;
    let openedAt = 0;
    try {
      const headers = eventStreamHeaders();
      if (!headers) { retry = false; return; }
      armIdle();
      const res = await fetch(url, { headers, cache: 'no-store', signal: ctrl.signal });
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        retry = false; // will not heal on retry; the page's next api call handles a dead session
        return;
      }
      if (!res.ok || !res.body || !(res.headers.get('content-type') || '').startsWith('text/event-stream')) return;
      openedAt = Date.now();
      handlers.onOpen();
      await readEventStream(res.body, handlers.onMessage, armIdle);
    } catch {
      /* network error, idle abort or cleanup: handled below */
    } finally {
      clearTimeout(idleTimer);
      if (controller === ctrl) controller = null;
      if (!stopped) {
        if (openedAt) handlers.onClose();
        // A stream that stayed up resets the backoff; one that keeps dying at once does not.
        if (openedAt && Date.now() - openedAt >= NOTES_STREAM_IDLE_MS) attempt = 0;
        if (retry) {
          // ~1s, 2s, 4s ... 30s, jittered so a deploy does not reconnect every phone at once.
          const delay = Math.min(NOTES_STREAM_MAX_BACKOFF_MS, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
          attempt += 1;
          reconnectTimer = setTimeout(connect, delay);
        }
      }
    }
  };

  // Mobile browsers freeze background tabs; on return, reconnect now instead of
  // waiting out the backoff or the idle timer.
  const onVisible = () => {
    if (stopped || controller || document.visibilityState !== 'visible') return;
    clearTimeout(reconnectTimer);
    attempt = 0;
    void connect();
  };
  document.addEventListener('visibilitychange', onVisible);
  void connect();

  return () => {
    stopped = true;
    clearTimeout(reconnectTimer);
    clearTimeout(idleTimer);
    document.removeEventListener('visibilitychange', onVisible);
    controller?.abort();
  };
}
