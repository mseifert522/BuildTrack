import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../lib/api';
import toast from 'react-hot-toast';
import { useAuthStore } from '../store/authStore';
import {
  ArrowLeft, Send, MessageSquare, Wifi, WifiOff,
  Clock, ChevronDown, Mic, Square, Edit2, Check, X,
  Camera, ImagePlus, PlayCircle,
} from 'lucide-react';
import { formatEasternDate, formatEasternDateTime, formatEasternRelative } from '../lib/time';
import { appendProgressUploadAudit, PROGRESS_MEDIA_ACCEPT } from '../lib/progressUpload';
import Avatar from '../components/Avatar';

interface NotePhoto {
  id: string;
  filename: string;
  original_name: string;
  caption?: string | null;
  mime_type?: string | null;
  taken_at?: string | null;
  created_at: string;
  uploader_name?: string | null;
  capture_latitude?: number | null;
  upload_ip_address?: string | null;
}

interface Note {
  id: string;
  project_id: string;
  user_id: string;
  user_name: string;
  user_role: string;
  user_avatar_url?: string | null;
  note: string;
  note_type: string;
  visibility?: 'private' | 'public';
  edit_count?: number;
  edited_at?: string | null;
  edited_by_name?: string | null;
  photos?: NotePhoto[];
  photo_id?: string | null;
  photo_filename?: string | null;
  photo_original_name?: string | null;
  photo_caption?: string | null;
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
  return formatEasternRelative(iso);
}

function formatFullTime(iso: string) {
  return `${formatEasternDateTime(iso, {
    weekday: 'short', month: 'short', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  })} New York time`;
}

const CONTRACTOR_NOTE_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

function noteCreatedAtMs(note: Note) {
  const raw = note.created_at || '';
  const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const timestamp = new Date(normalized).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function canEditNote(note: Note, user?: { id?: string; role?: string } | null) {
  if (!user || note.user_id !== user.id) return false;
  if (user.role === 'contractor') {
    const createdAt = noteCreatedAtMs(note);
    return Boolean(createdAt && Date.now() - createdAt <= CONTRACTOR_NOTE_EDIT_WINDOW_MS);
  }
  return Number(note.edit_count || 0) < 1;
}

function editWindowLabel(note: Note, user?: { role?: string } | null) {
  if (user?.role !== 'contractor') return 'Edit note';
  const createdAt = noteCreatedAtMs(note);
  const remainingMs = Math.max(CONTRACTOR_NOTE_EDIT_WINDOW_MS - (Date.now() - createdAt), 0);
  const remainingHours = Math.max(Math.ceil(remainingMs / (60 * 60 * 1000)), 1);
  return `Edit note (${remainingHours}h left)`;
}

function avatarColor(userId: string) {
  const colors = ['#7C3AED', '#2563EB', '#D97706', '#059669', '#DC2626', '#0891B2', '#9333EA'];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function notePhotos(note: Note): NotePhoto[] {
  if (Array.isArray(note.photos) && note.photos.length) return note.photos;
  if (!note.photo_filename) return [];
  return [{
    id: note.photo_id || note.photo_filename,
    filename: note.photo_filename,
    original_name: note.photo_original_name || 'Progress photo',
    caption: note.photo_caption || null,
    created_at: note.created_at,
  }];
}

function isVideoAttachment(photo: NotePhoto) {
  return Boolean(photo.mime_type?.startsWith('video/')) || /\.(mp4|mov|m4v|webm|avi|mkv|mpeg|mpg|3gp)$/i.test(photo.filename);
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
  const [listening, setListening] = useState(false);
  const [connected, setConnected] = useState(false);
  const [expandedNote, setExpandedNote] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [noteFiles, setNoteFiles] = useState<File[]>([]);
  const [noteFileUrls, setNoteFileUrls] = useState<string[]>([]);
  const [attachToNoteId, setAttachToNoteId] = useState<string | null>(null);
  const [attachingNoteId, setAttachingNoteId] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const noteFileInputRef = useRef<HTMLInputElement>(null);
  const noteFileUrlsRef = useRef<string[]>([]);
  const attachExistingInputRef = useRef<HTMLInputElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const recognitionRef = useRef<any>(null);

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

  useEffect(() => {
    noteFileUrlsRef.current = noteFileUrls;
  }, [noteFileUrls]);

  useEffect(() => () => {
    noteFileUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
  }, []);

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
          } else if (data.type === 'update_note') {
            setNotes(prev => prev.map(n => n.id === data.note.id ? data.note : n));
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

  const clearNoteFiles = useCallback(() => {
    setNoteFiles([]);
    setNoteFileUrls(current => {
      current.forEach(url => URL.revokeObjectURL(url));
      return [];
    });
    if (noteFileInputRef.current) noteFileInputRef.current.value = '';
  }, []);

  const queueNoteFiles = useCallback((files?: FileList | null) => {
    const nextFiles = Array.from(files || []);
    if (!nextFiles.length) return;
    setNoteFiles(current => [...current, ...nextFiles]);
    setNoteFileUrls(current => [...current, ...nextFiles.map(file => URL.createObjectURL(file))]);
    if (noteFileInputRef.current) noteFileInputRef.current.value = '';
  }, []);

  const uploadFilesToNote = useCallback(async (noteId: string, files: File[]) => {
    if (!projectId || !files.length) return;
    const formData = new FormData();
    files.forEach(file => formData.append('photos', file));
    formData.append('note_id', noteId);
    formData.append('photo_type', 'progress');
    formData.append('caption', 'Progress pictures attached to project note');
    await appendProgressUploadAudit(formData, files, files.map(() => 'library'));
    await api.post(`/projects/${projectId}/photos?type=progress`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  }, [projectId]);

  const refreshNotes = useCallback(async () => {
    if (!projectId) return;
    const notesRes = await api.get(`/projects/${projectId}/notes`);
    setNotes(Array.isArray(notesRes.data) ? notesRes.data : []);
  }, [projectId]);

  const attachFilesToExistingNote = useCallback(async (files?: FileList | null) => {
    const selectedFiles = Array.from(files || []);
    const noteId = attachToNoteId;
    if (!noteId || !selectedFiles.length) return;
    setAttachingNoteId(noteId);
    try {
      await uploadFilesToNote(noteId, selectedFiles);
      await refreshNotes();
      toast.success(`${selectedFiles.length} progress picture${selectedFiles.length === 1 ? '' : 's'} attached`);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to attach progress pictures');
    } finally {
      setAttachingNoteId(null);
      setAttachToNoteId(null);
      if (attachExistingInputRef.current) attachExistingInputRef.current.value = '';
    }
  }, [attachToNoteId, refreshNotes, uploadFilesToNote]);

  const handleSend = useCallback(async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    const filesForNote = [...noteFiles];
    const optimisticNote: Note = {
      id: `temp-${Date.now()}`,
      project_id: projectId!,
      user_id: user!.id,
      user_name: user!.name,
      user_role: user!.role,
      user_avatar_url: user!.avatar_url || null,
      note: text.trim(),
      note_type: 'general',
      photos: [],
      created_at: new Date().toISOString(),
    };
    // Optimistic update
    setNotes(prev => [...prev, optimisticNote]);
    setText('');
    textareaRef.current?.focus();

    try {
      const res = await api.post(`/projects/${projectId}/notes`, { note: text.trim() });
      if (filesForNote.length) {
        await uploadFilesToNote(res.data.id, filesForNote);
        await refreshNotes();
      } else {
        // Replace optimistic note with real one
        setNotes(prev => prev.map(n => n.id === optimisticNote.id ? res.data : n));
      }
      clearNoteFiles();
    } catch {
      toast.error('Failed to post note');
      setNotes(prev => prev.filter(n => n.id !== optimisticNote.id));
      setText(optimisticNote.note);
    } finally {
      setSending(false);
    }
  }, [clearNoteFiles, noteFiles, refreshNotes, sending, projectId, text, uploadFilesToNote, user]);

  const startEdit = useCallback((note: Note) => {
    setEditingNoteId(note.id);
    setEditingText(note.note);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingNoteId(null);
    setEditingText('');
  }, []);

  const saveNoteEdit = useCallback(async (note: Note) => {
    if (!projectId || !editingText.trim() || savingEdit) return;
    setSavingEdit(true);
    try {
      const res = await api.put(`/projects/${projectId}/notes/${note.id}`, {
        note: editingText.trim(),
        note_type: note.note_type || 'general',
        visibility: note.visibility || 'private',
      });
      setNotes(prev => prev.map(item => item.id === note.id ? res.data : item));
      cancelEdit();
      toast.success('Note updated');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update note');
    } finally {
      setSavingEdit(false);
    }
  }, [cancelEdit, editingText, projectId, savingEdit]);

  const startDictation = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      toast.error('Microphone dictation is not supported in this browser');
      return;
    }

    recognitionRef.current?.stop?.();
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onstart = () => setListening(true);
    recognition.onend = () => {
      if (recognitionRef.current === recognition) {
        setListening(false);
        recognitionRef.current = null;
      }
    };
    recognition.onerror = () => {
      setListening(false);
      recognitionRef.current = null;
      toast.error('Microphone dictation stopped');
    };
    recognition.onresult = (event: any) => {
      const spokenText = Array.from(event.results).slice(event.resultIndex || 0)
        .filter((result: any) => result.isFinal)
        .map((result: any) => result[0]?.transcript)
        .filter(Boolean)
        .join(' ')
        .trim();
      if (spokenText) setText(prev => `${prev}${prev.trim() ? ' ' : ''}${spokenText}`);
    };
    recognitionRef.current = recognition;
    recognition.start();
  }, []);

  const stopDictation = useCallback(() => {
    recognitionRef.current?.stop?.();
    recognitionRef.current = null;
    setListening(false);
  }, []);

  // Group notes by date
  const groupedNotes = notes.reduce<{ date: string; notes: Note[] }[]>((groups, note) => {
    const date = formatEasternDate(note.created_at, {
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
                  const isEditing = editingNoteId === note.id;
                  const editable = canEditNote(note, user);
                  const attachments = notePhotos(note);

                  return (
                    <div key={note.id} className={`flex gap-3 ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}>
                      {/* Avatar */}
                      <Avatar
                        src={note.user_avatar_url}
                        name={note.user_name}
                        size={36}
                        roundedClassName="rounded-full"
                        style={{ marginTop: 2 }}
                        fallbackStyle={{ background: color }}
                      />

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
                            background: isEditing
                              ? 'white'
                              : isOwn
                              ? 'linear-gradient(135deg, #D99D26, #C4891F)'
                              : 'white',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                            border: isEditing ? '1px solid #D99D26' : 'none',
                            borderBottomRightRadius: isOwn ? 4 : 16,
                            borderBottomLeftRadius: isOwn ? 16 : 4,
                          }}
                        >
                          {isEditing ? (
                            <div className="space-y-3">
                              <textarea
                                value={editingText}
                                onChange={e => setEditingText(e.target.value)}
                                rows={3}
                                autoFocus
                                className="w-full text-sm leading-relaxed text-gray-900 bg-white focus:outline-none resize-none"
                                style={{ minWidth: 220 }}
                              />
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={cancelEdit}
                                  className="w-9 h-9 rounded-xl flex items-center justify-center"
                                  style={{ background: '#F3F4F6', color: '#6B7280' }}
                                  aria-label="Cancel note edit"
                                >
                                  <X className="w-4 h-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => saveNoteEdit(note)}
                                  disabled={savingEdit || !editingText.trim()}
                                  className="w-9 h-9 rounded-xl flex items-center justify-center disabled:opacity-50"
                                  style={{ background: '#D99D26', color: 'white' }}
                                  aria-label="Save note edit"
                                >
                                  {savingEdit ? (
                                    <span className="w-4 h-4 rounded-full animate-spin" style={{ border: '2px solid rgba(255,255,255,0.35)', borderTopColor: 'white' }} />
                                  ) : (
                                    <Check className="w-4 h-4" />
                                  )}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <p
                                className="text-sm leading-relaxed whitespace-pre-wrap"
                                style={{ color: isOwn ? 'white' : '#111827' }}
                              >
                                {note.note}
                              </p>
                              {attachments.length > 0 && (
                                <div className="grid grid-cols-2 gap-1.5 mt-3">
                                  {attachments.map(photo => {
                                    const src = `/uploads/${note.project_id}/${photo.filename}`;
                                    const isVideo = isVideoAttachment(photo);
                                    return (
                                      <div key={photo.id} className="relative aspect-square rounded-xl overflow-hidden" style={{ background: 'rgba(0,0,0,0.12)' }}>
                                        {isVideo ? (
                                          <>
                                            <video src={src} className="w-full h-full object-cover" muted playsInline preload="metadata" />
                                            <PlayCircle className="absolute inset-0 m-auto w-7 h-7 text-white drop-shadow" />
                                          </>
                                        ) : (
                                          <img src={src} alt={photo.original_name || 'Progress picture'} className="w-full h-full object-cover" loading="lazy" />
                                        )}
                                        <div className="absolute left-1 bottom-1 rounded-full px-1.5 py-0.5 text-[9px] font-black text-white" style={{ background: 'rgba(17,24,39,0.72)' }}>
                                          {formatEasternDateTime(photo.taken_at || photo.created_at, { hour: 'numeric', minute: '2-digit' })}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </>
                          )}
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
                          {editable && !isEditing && (
                            <button
                              type="button"
                              onClick={() => startEdit(note)}
                              className="flex items-center gap-1 text-xs font-bold"
                              style={{ color: '#2563EB' }}
                            >
                              <Edit2 className="w-3 h-3" />
                              {editWindowLabel(note, user)}
                            </button>
                          )}
                          {!isEditing && (
                            <button
                              type="button"
                              onClick={() => {
                                setAttachToNoteId(note.id);
                                attachExistingInputRef.current?.click();
                              }}
                              disabled={attachingNoteId === note.id}
                              className="flex items-center gap-1 text-xs font-bold disabled:opacity-50"
                              style={{ color: '#D99D26' }}
                            >
                              <ImagePlus className="w-3 h-3" />
                              {attachingNoteId === note.id ? 'Attaching...' : 'Attach pictures'}
                            </button>
                          )}
                        </div>

                        {/* Expanded full timestamp */}
                        {isExpanded && (
                          <div className="mt-0.5 px-1">
                            <p className="text-xs text-gray-400">
                              {formatFullTime(note.created_at)}
                            </p>
                            {note.edited_at && (
                              <p className="text-xs text-gray-400 mt-0.5">
                                Edited by {note.edited_by_name || note.user_name} on {formatFullTime(note.edited_at)}
                              </p>
                            )}
                          </div>
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
        <input
          ref={noteFileInputRef}
          type="file"
          accept={PROGRESS_MEDIA_ACCEPT}
          multiple
          className="hidden"
          onChange={event => queueNoteFiles(event.target.files)}
        />
        <input
          ref={attachExistingInputRef}
          type="file"
          accept={PROGRESS_MEDIA_ACCEPT}
          multiple
          className="hidden"
          onChange={event => attachFilesToExistingNote(event.target.files)}
        />
        {/* Current user indicator */}
        <div className="flex items-center gap-2 mb-2 px-1">
          <Avatar
            src={user?.avatar_url}
            name={user?.name}
            size={20}
            roundedClassName="rounded-full"
            fallbackStyle={{ background: avatarColor(user?.id || '') }}
          />
          <span className="text-xs text-gray-500 font-medium">
            Posting as <strong className="text-gray-700">{user?.name}</strong>
          </span>
        </div>
        {listening && (
          <div className="flex items-center gap-2 mb-2 px-2 py-1.5 rounded-xl" style={{ background: '#FEF3C7', color: '#92400E' }}>
            <span className="text-xs font-black">Listening</span>
            <span className="flex items-end gap-0.5 h-4">
              {[0, 1, 2, 3].map(i => (
                <span key={i} className="w-1 rounded-full bg-current animate-pulse" style={{ height: 5 + i * 3, animationDelay: `${i * 120}ms` }} />
              ))}
            </span>
          </div>
        )}

        {noteFiles.length > 0 && (
          <div className="mb-2 rounded-2xl border border-amber-100 bg-amber-50 p-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-black text-amber-900">{noteFiles.length} progress picture{noteFiles.length === 1 ? '' : 's'} ready for this note</span>
              <button type="button" onClick={clearNoteFiles} className="text-xs font-black text-amber-800">Clear</button>
            </div>
            <div className="flex gap-2 overflow-x-auto">
              {noteFileUrls.map((url, index) => (
                <div key={url} className="relative h-14 w-14 flex-shrink-0 overflow-hidden rounded-xl bg-white">
                  {noteFiles[index]?.type.startsWith('video/') ? (
                    <>
                      <video src={url} className="h-full w-full object-cover" muted playsInline />
                      <PlayCircle className="absolute inset-0 m-auto h-5 w-5 text-white drop-shadow" />
                    </>
                  ) : (
                    <img src={url} alt={`Queued progress picture ${index + 1}`} className="h-full w-full object-cover" />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-end gap-3">
          <button
            type="button"
            onClick={() => noteFileInputRef.current?.click()}
            className="w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0 transition-all active:scale-95"
            style={{ background: '#FFFBEB', border: '1px solid #F3D08A' }}
            aria-label="Attach progress pictures to note"
          >
            <Camera className="w-5 h-5" style={{ color: '#D99D26' }} />
          </button>
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
            onClick={listening ? stopDictation : startDictation}
            className="w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0 transition-all active:scale-95 disabled:opacity-60"
            style={{
              background: listening ? '#FEF3C7' : '#F3F4F6',
              border: listening ? '1px solid #D99D26' : '1px solid #E5E7EB',
            }}
          >
            {listening ? <Square className="w-5 h-5" style={{ color: '#D99D26' }} /> : <Mic className="w-5 h-5" style={{ color: '#6B7280' }} />}
          </button>

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
