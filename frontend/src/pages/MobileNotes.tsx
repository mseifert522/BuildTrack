import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../lib/api';
import toast from 'react-hot-toast';
import { useAuthStore } from '../store/authStore';
import {
  ArrowLeft, Send, Trash2, MessageSquare, Wifi, WifiOff,
  Clock, User, ChevronDown,
} from 'lucide-react';

interface Note {
  id: string;
  project_id: string;
  user_id: string;
  user_name: string;
  user_role: string;
  note: string;
  note_type: string;
  created_at: string;
}

const roleLabel: Record<string, { label: string; color: string; bg: string }> = {
  super_admin:        { label: 'Super Admin',   color: '#7C3AED', bg: '#EDE9FE' },
  operations_manager: { label: 'Ops Manager',   color: '#2563EB', bg: '#DBEAFE' },
  admin_assistant:    { label: 'Admin',         color: '#0891B2', bg: '#CFFAFE' },
  contractor:         { label: 'Contractor',    color: '#D97706', bg: '#FEF3C7' },
  field_supervisor:   { label: 'Supervisor',    color: '#059669', bg: '#D1FAE5' },
};

function formatTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay === 1) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: diffDay > 365 ? 'numeric' : undefined });
}

function formatFullTime(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function getInitials(name: string) {
  return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}

function avatarColor(userId: string) {
  const colors = ['#7C3AED', '#2563EB', '#D97706', '#059669', '#DC2626', '#0891B2', '#9333EA'];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export default function MobileNotes() {
  const { id: projectId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, token } = useAuthStore();

  const [projectAddress, setProjectAddress] = useState('');
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [expandedNote, setExpandedNote] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Load project info + initial notes
  useEffect(() => {
    if (!projectId) return;
    Promise.all([
      api.get(`/projects/${projectId}`),
      api.get(`/projects/${projectId}/notes`),
    ]).then(([projRes, notesRes]) => {
      setProjectAddress(projRes.data.address || '');
      setNotes(Array.isArray(notesRes.data) ? notesRes.data : []);
    }).catch(() => toast.error('Failed to load notes'))
      .finally(() => setLoading(false));
  }, [projectId]);

  // Scroll to bottom when notes load or new note arrives
  useEffect(() => {
    if (!loading) {
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    }
  }, [notes.length, loading]);

  // SSE real-time connection
  useEffect(() => {
    if (!projectId || !token) return;

    const baseUrl = (api.defaults.baseURL || '').replace(/\/api$/, '');
    const sseUrl = `${baseUrl}/api/projects/${projectId}/notes/stream`;

    const connect = () => {
      // Append token as query param since EventSource doesn't support custom headers
      const es = new EventSource(`${sseUrl}?token=${token}`);
      eventSourceRef.current = es;

      es.onopen = () => setConnected(true);

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'new_note') {
            setNotes(prev => {
              // Avoid duplicates
              if (prev.find(n => n.id === data.note.id)) return prev;
              return [...prev, data.note];
            });
          } else if (data.type === 'delete_note') {
            setNotes(prev => prev.filter(n => n.id !== data.noteId));
          }
        } catch { /* ignore parse errors */ }
      };

      es.onerror = () => {
        setConnected(false);
        es.close();
        // Reconnect after 3 seconds
        setTimeout(connect, 3000);
      };
    };

    connect();

    return () => {
      eventSourceRef.current?.close();
    };
  }, [projectId, token]);

  // Also update the SSE auth — backend needs to accept token via query param
  // We'll handle this in the backend middleware patch below

  const handleSend = useCallback(async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    const optimisticNote: Note = {
      id: `temp-${Date.now()}`,
      project_id: projectId!,
      user_id: user!.id,
      user_name: user!.name,
      user_role: user!.role,
      note: text.trim(),
      note_type: 'general',
      created_at: new Date().toISOString(),
    };
    // Optimistic update
    setNotes(prev => [...prev, optimisticNote]);
    setText('');
    textareaRef.current?.focus();

    try {
      const res = await api.post(`/projects/${projectId}/notes`, { note: text.trim() });
      // Replace optimistic note with real one
      setNotes(prev => prev.map(n => n.id === optimisticNote.id ? res.data : n));
    } catch {
      toast.error('Failed to post note');
      setNotes(prev => prev.filter(n => n.id !== optimisticNote.id));
      setText(optimisticNote.note);
    } finally {
      setSending(false);
    }
  }, [text, sending, projectId, user]);

  const handleDelete = async (noteId: string) => {
    try {
      await api.delete(`/projects/${projectId}/notes/${noteId}`);
      setNotes(prev => prev.filter(n => n.id !== noteId));
      toast.success('Note deleted');
    } catch {
      toast.error('Failed to delete note');
    }
  };

  const canDelete = (note: Note) =>
    note.user_id === user?.id ||
    ['super_admin', 'operations_manager'].includes(user?.role || '');

  // Group notes by date
  const groupedNotes = notes.reduce<{ date: string; notes: Note[] }[]>((groups, note) => {
    const date = new Date(note.created_at).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
    const last = groups[groups.length - 1];
    if (last && last.date === date) {
      last.notes.push(note);
    } else {
      groups.push({ date, notes: [note] });
    }
    return groups;
  }, []);

  if (loading) {
    return (
      <div className="mobile-shell" style={{ background: '#F0F2F5', alignItems: 'center', justifyContent: 'center' }}>
        <div className="w-8 h-8 rounded-full animate-spin" style={{ border: '3px solid #E5E7EB', borderTopColor: '#D99D26' }} />
      </div>
    );
  }

  return (
    <div className="mobile-shell" style={{ background: '#F0F2F5', fontFamily: "'Inter', -apple-system, sans-serif" }}>
      {/* ── Header ── */}
      <div style={{ background: 'linear-gradient(135deg, #0D1117 0%, #181D25 100%)', flexShrink: 0 }}>
        <div className="flex items-center gap-3 px-4 pt-4 pb-3">
          <button
            onClick={() => navigate(-1)}
            className="p-2 rounded-xl flex-shrink-0"
            style={{ background: 'rgba(255,255,255,0.08)' }}
          >
            <ArrowLeft className="w-5 h-5 text-white" />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-white font-bold text-sm leading-tight">Project Notes</p>
              {/* Live indicator */}
              <span
                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold"
                style={{
                  background: connected ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                  color: connected ? '#22C55E' : '#EF4444',
                }}
              >
                {connected
                  ? <><Wifi className="w-3 h-3" /> Live</>
                  : <><WifiOff className="w-3 h-3" /> Reconnecting</>
                }
              </span>
            </div>
            <p className="text-xs truncate mt-0.5" style={{ color: 'rgba(255,255,255,0.5)' }}>{projectAddress}</p>
          </div>
          <div
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl flex-shrink-0"
            style={{ background: 'rgba(255,255,255,0.06)' }}
          >
            <MessageSquare className="w-3.5 h-3.5" style={{ color: '#D99D26' }} />
            <span className="text-xs font-bold text-white">{notes.length}</span>
          </div>
        </div>

        {/* Collaboration notice */}
        <div
          className="mx-4 mb-3 px-3 py-2 rounded-xl flex items-center gap-2"
          style={{ background: 'rgba(217,157,38,0.1)', border: '1px solid rgba(217,157,38,0.2)' }}
        >
          <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: '#D99D26' }} />
          <p className="text-xs" style={{ color: 'rgba(255,255,255,0.7)' }}>
            All team members on this project can see and post notes in real time
          </p>
        </div>
      </div>

      {/* ── Notes Feed ── */}
      <div className="mobile-content" style={{ padding: '16px', overscrollBehavior: 'contain' }}>
        {notes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <div
              className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
              style={{ background: 'rgba(217,157,38,0.1)' }}
            >
              <MessageSquare className="w-8 h-8" style={{ color: '#D99D26' }} />
            </div>
            <p className="font-bold text-gray-700 text-base">No notes yet</p>
            <p className="text-sm text-gray-400 mt-1 text-center px-8">
              Be the first to add a note. All team members will see it instantly.
            </p>
          </div>
        ) : (
          groupedNotes.map(group => (
            <div key={group.date}>
              {/* Date divider */}
              <div className="flex items-center gap-3 my-4">
                <div className="flex-1 h-px" style={{ background: '#E5E7EB' }} />
                <span
                  className="text-xs font-bold px-3 py-1 rounded-full flex-shrink-0"
                  style={{ background: '#E5E7EB', color: '#6B7280' }}
                >
                  {group.date}
                </span>
                <div className="flex-1 h-px" style={{ background: '#E5E7EB' }} />
              </div>

              {/* Notes in this date group */}
              <div className="space-y-3">
                {group.notes.map(note => {
                  const isOwn = note.user_id === user?.id;
                  const rl = roleLabel[note.user_role] || { label: note.user_role, color: '#6B7280', bg: '#F3F4F6' };
                  const color = avatarColor(note.user_id);
                  const isExpanded = expandedNote === note.id;

                  return (
                    <div key={note.id} className={`flex gap-3 ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}>
                      {/* Avatar */}
                      <div
                        className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-white text-xs font-black"
                        style={{ background: color, marginTop: 2 }}
                      >
                        {getInitials(note.user_name)}
                      </div>

                      {/* Bubble */}
                      <div className={`flex-1 max-w-xs ${isOwn ? 'items-end' : 'items-start'} flex flex-col`}>
                        {/* Author + role */}
                        <div className={`flex items-center gap-2 mb-1 ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}>
                          <span className="text-xs font-bold text-gray-700">{isOwn ? 'You' : note.user_name}</span>
                          <span
                            className="text-xs font-semibold px-2 py-0.5 rounded-full"
                            style={{ background: rl.bg, color: rl.color }}
                          >
                            {rl.label}
                          </span>
                        </div>

                        {/* Note content */}
                        <div
                          className="rounded-2xl px-4 py-3 relative"
                          style={{
                            background: isOwn
                              ? 'linear-gradient(135deg, #D99D26, #C4891F)'
                              : 'white',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                            borderBottomRightRadius: isOwn ? 4 : 16,
                            borderBottomLeftRadius: isOwn ? 16 : 4,
                          }}
                        >
                          <p
                            className="text-sm leading-relaxed whitespace-pre-wrap"
                            style={{ color: isOwn ? 'white' : '#111827' }}
                          >
                            {note.note}
                          </p>
                        </div>

                        {/* Timestamp + actions */}
                        <div className={`flex items-center gap-2 mt-1 ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}>
                          <button
                            onClick={() => setExpandedNote(isExpanded ? null : note.id)}
                            className="flex items-center gap-1 text-xs text-gray-400"
                          >
                            <Clock className="w-3 h-3" />
                            {formatTime(note.created_at)}
                            <ChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                          </button>
                          {canDelete(note) && (
                            <button
                              onClick={() => handleDelete(note.id)}
                              className="p-1 rounded-lg transition-colors"
                              style={{ color: '#EF4444' }}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>

                        {/* Expanded full timestamp */}
                        {isExpanded && (
                          <p className="text-xs text-gray-400 mt-0.5 px-1">
                            {formatFullTime(note.created_at)}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* ── Input Bar ── */}
      <div
        className="px-4 py-3 flex-shrink-0"
        style={{
          background: 'white',
          borderTop: '1px solid #E5E7EB',
          boxShadow: '0 -4px 20px rgba(0,0,0,0.06)',
          paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
        }}
      >
        {/* Current user indicator */}
        <div className="flex items-center gap-2 mb-2 px-1">
          <div
            className="w-5 h-5 rounded-full flex items-center justify-center text-white text-xs font-black flex-shrink-0"
            style={{ background: avatarColor(user?.id || '') }}
          >
            {getInitials(user?.name || '')}
          </div>
          <span className="text-xs text-gray-500 font-medium">
            Posting as <strong className="text-gray-700">{user?.name}</strong>
          </span>
        </div>

        <div className="flex items-end gap-3">
          <div
            className="flex-1 rounded-2xl px-4 py-3"
            style={{
              background: '#F9FAFB',
              border: '2px solid #E5E7EB',
              minHeight: 48,
            }}
          >
            <textarea
              ref={textareaRef}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Type a note… (Enter to send, Shift+Enter for new line)"
              rows={1}
              className="w-full bg-transparent text-sm text-gray-900 placeholder-gray-400 focus:outline-none resize-none"
              style={{ maxHeight: 120, overflowY: 'auto' }}
            />
          </div>

          <button
            onClick={handleSend}
            disabled={!text.trim() || sending}
            className="w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0 transition-all active:scale-95 disabled:opacity-40"
            style={{
              background: text.trim()
                ? 'linear-gradient(135deg, #D99D26, #C4891F)'
                : '#E5E7EB',
              boxShadow: text.trim() ? '0 4px 12px rgba(217,157,38,0.35)' : 'none',
            }}
          >
            {sending
              ? <div className="w-4 h-4 rounded-full animate-spin" style={{ border: '2px solid rgba(255,255,255,0.3)', borderTopColor: 'white' }} />
              : <Send className="w-5 h-5" style={{ color: text.trim() ? 'white' : '#9CA3AF' }} />
            }
          </button>
        </div>
      </div>
    </div>
  );
}
