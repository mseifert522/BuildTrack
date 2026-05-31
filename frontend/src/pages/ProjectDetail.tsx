import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore, canManageProjects, isAdminRole } from '../store/authStore';
import api from '../lib/api';
import { Loading, StatusBadge, Modal } from '../components/ui';
import { ArrowLeft, MapPin, Edit2, Users, Plus, Trash2, Camera, FileText, ClipboardList, Activity, MessageSquare, UserPlus, Mic, Square, Package, ArrowUp, ArrowDown, ImagePlus, PlayCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { useForm } from 'react-hook-form';
import { format } from 'date-fns';
import GooglePlacesInput from '../components/GooglePlacesInput';
import CurrencyInput from '../components/CurrencyInput';
import { formatEasternDate, formatEasternDateTime } from '../lib/time';
import { appendProgressUploadAudit, type ProgressCaptureSource } from '../lib/progressUpload';

type Tab = 'overview' | 'construction-plan' | 'quotes' | 'punch-list' | 'photos' | 'invoices' | 'activity' | 'notes' | 'team';

const getInitials = (name?: string) =>
  (name || '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase())
    .join('') || '?';

const getNotePhotos = (note: any) => {
  if (Array.isArray(note.photos) && note.photos.length) return note.photos;
  if (!note.photo_filename) return [];
  return [{
    id: note.photo_id || note.photo_filename,
    filename: note.photo_filename,
    original_name: note.photo_original_name || 'Progress picture',
    caption: note.photo_caption || null,
    mime_type: null,
    taken_at: note.created_at,
    created_at: note.created_at,
  }];
};

const isVideoMedia = (item: { filename?: string; mime_type?: string | null }) =>
  Boolean(item.mime_type?.startsWith('video/')) || /\.(mp4|mov|m4v|webm|avi|mkv|mpeg|mpg|3gp)$/i.test(item.filename || '');

const groupMediaByDay = (photos: any[]) =>
  photos.reduce<{ date: string; photos: any[] }[]>((groups, photo) => {
    const date = formatEasternDate(photo.taken_at || photo.created_at, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
    const last = groups[groups.length - 1];
    if (last && last.date === date) last.photos.push(photo);
    else groups.push({ date, photos: [photo] });
    return groups;
  }, []);

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [project, setProject] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('overview');
  const [showEdit, setShowEdit] = useState(false);
  const [showAssign, setShowAssign] = useState(false);
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [notes, setNotes] = useState<any[]>([]);
  const [newNote, setNewNote] = useState('');
  const [noteType, setNoteType] = useState('general');
  const [noteVisibility, setNoteVisibility] = useState<'private' | 'public'>('private');
  const [listeningNote, setListeningNote] = useState(false);
  const [notePhotoFiles, setNotePhotoFiles] = useState<File[]>([]);
  const [attachNoteId, setAttachNoteId] = useState<string | null>(null);
  const [attachingNoteId, setAttachingNoteId] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = useState('');
  const [editingNoteType, setEditingNoteType] = useState('general');
  const [editingNoteVisibility, setEditingNoteVisibility] = useState<'private' | 'public'>('private');
  const [uploadingMainPhoto, setUploadingMainPhoto] = useState(false);
  const [activity, setActivity] = useState<any[]>([]);
  const [editAddress, setEditAddress] = useState('');
  const [editBudget, setEditBudget] = useState('');
  const [editPurchasePrice, setEditPurchasePrice] = useState('');
  const [editArv, setEditArv] = useState('');
  const [editClosingCosts, setEditClosingCosts] = useState('');
  const { register, handleSubmit, reset, setValue, formState: { isSubmitting } } = useForm();
  const noteRecognitionRef = useRef<any>(null);
  const attachExistingNoteInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const res = await api.get(`/projects/${id}`);
      setProject(res.data);
    } catch (err) {
      toast.error('Failed to load project');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    const hashTabMap: Record<string, Tab> = {
      '#construction-plan': 'construction-plan',
      '#quotes': 'quotes',
      '#punch-list': 'punch-list',
      '#assigned-contractors': 'team',
    };
    if (hashTabMap[location.hash]) setTab(hashTabMap[location.hash]);
  }, [location.hash]);

  useEffect(() => {
    if (!id || !user || !isAdminRole(user.role)) return;
    api.post(`/projects/${id}/reviewed`).catch(() => {});
  }, [id, user?.id, user?.role]);

  useEffect(() => {
    if (tab === 'overview' || tab === 'notes') loadNotes();
    if (tab === 'activity') loadActivity();
  }, [tab, id]);

  useEffect(() => {
    return () => {
      noteRecognitionRef.current?.stop?.();
      noteRecognitionRef.current = null;
    };
  }, []);

  const loadNotes = async () => {
    const res = await api.get(`/projects/${id}/notes`);
    setNotes(res.data);
  };

  const loadActivity = async () => {
    const res = await api.get(`/projects/${id}/activity`);
    setActivity(res.data);
  };

  const loadUsers = async () => {
    if (user && isAdminRole(user.role)) {
      const res = await api.get('/users');
      setAllUsers(res.data);
    }
  };

  const handleAssign = async (userId: string) => {
    try {
      await api.post(`/projects/${id}/assign`, { user_id: userId });
      toast.success('User assigned');
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to assign user');
    }
  };

  const handleUnassign = async (userId: string) => {
    try {
      await api.delete(`/projects/${id}/assign/${userId}`);
      toast.success('User removed');
      load();
    } catch (err) {
      toast.error('Failed to remove user');
    }
  };

  const onEditProject = async (data: any) => {
    try {
      await api.put(`/projects/${id}`, { ...data, address: editAddress || data.address, budget: editBudget ? parseFloat(editBudget) : null, purchase_price: editPurchasePrice ? parseFloat(editPurchasePrice) : null, arv: editArv ? parseFloat(editArv) : null, closing_costs: editClosingCosts ? parseFloat(editClosingCosts) : null });
      toast.success('Project updated');
      setShowEdit(false);
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update project');
    }
  };

  const handleMainPhotoUpload = async (file?: File) => {
    if (!file || !id) return;
    setUploadingMainPhoto(true);
    try {
      const formData = new FormData();
      formData.append('photo', file);
      const res = await api.post(`/projects/${id}/main-photo`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setProject((current: any) => ({ ...current, main_photo_url: res.data.main_photo_url }));
      toast.success('Project house photo updated');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to upload project photo');
    } finally {
      setUploadingMainPhoto(false);
    }
  };

  const uploadProgressPicturesToNote = async (noteId: string, files: File[], source: ProgressCaptureSource = 'desktop') => {
    if (!files.length) return;
    const formData = new FormData();
    files.forEach(file => formData.append('photos', file));
    formData.append('note_id', noteId);
    formData.append('photo_type', 'progress');
    formData.append('caption', 'Progress pictures attached to project note');
    await appendProgressUploadAudit(formData, files, files.map(() => source));
    await api.post(`/projects/${id}/photos?type=progress`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  };

  const attachProgressPicturesToExistingNote = async (files?: FileList | null) => {
    const selectedFiles = Array.from(files || []);
    if (!attachNoteId || selectedFiles.length === 0) return;
    setAttachingNoteId(attachNoteId);
    try {
      await uploadProgressPicturesToNote(attachNoteId, selectedFiles);
      toast.success(`${selectedFiles.length} progress picture${selectedFiles.length === 1 ? '' : 's'} attached`);
      await loadNotes();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to attach progress pictures');
    } finally {
      setAttachNoteId(null);
      setAttachingNoteId(null);
      if (attachExistingNoteInputRef.current) attachExistingNoteInputRef.current.value = '';
    }
  };

  const addNote = async () => {
    if (!newNote.trim()) return;
    try {
      const noteRes = await api.post(`/projects/${id}/notes`, { note: newNote, note_type: noteType, visibility: noteVisibility });
      if (notePhotoFiles.length) {
        await uploadProgressPicturesToNote(noteRes.data.id, notePhotoFiles);
      }
      setNewNote('');
      setNotePhotoFiles([]);
      loadNotes();
    } catch (err) {
      toast.error('Failed to add note');
    }
  };

  const saveNoteEdit = async (noteId: string) => {
    if (!editingNoteText.trim()) return;
    try {
      await api.put(`/projects/${id}/notes/${noteId}`, { note: editingNoteText, note_type: editingNoteType, visibility: editingNoteVisibility });
      toast.success('Note updated');
      setEditingNoteId(null);
      setEditingNoteText('');
      loadNotes();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update note');
    }
  };

  const startNoteDictation = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      toast.error('Microphone dictation is not supported in this browser');
      return;
    }

    noteRecognitionRef.current?.stop?.();
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onstart = () => setListeningNote(true);
    recognition.onend = () => {
      if (noteRecognitionRef.current === recognition) {
        setListeningNote(false);
        noteRecognitionRef.current = null;
      }
    };
    recognition.onerror = () => {
      setListeningNote(false);
      noteRecognitionRef.current = null;
      toast.error('Microphone dictation stopped');
    };
    recognition.onresult = (event: any) => {
      const spokenText = Array.from(event.results).slice(event.resultIndex || 0)
        .filter((result: any) => result.isFinal)
        .map((result: any) => result[0]?.transcript)
        .filter(Boolean)
        .join(' ')
        .trim();
      if (spokenText) setNewNote(prev => `${prev}${prev.trim() ? ' ' : ''}${spokenText}`);
    };
    noteRecognitionRef.current = recognition;
    recognition.start();
  };

  const stopNoteDictation = () => {
    noteRecognitionRef.current?.stop?.();
    noteRecognitionRef.current = null;
    setListeningNote(false);
  };

  if (loading) return <Loading />;
  if (!project) return <div className="p-6 text-center text-gray-500">Project not found</div>;

  const tabs: { id: Tab; label: string; icon: any }[] = [
    { id: 'overview', label: 'Overview', icon: MapPin },
    { id: 'construction-plan', label: 'Scope of Work', icon: FileText },
    { id: 'quotes', label: 'Upload Quotes', icon: FileText },
    { id: 'punch-list', label: 'Punch List', icon: ClipboardList },
    { id: 'photos', label: 'Progress Photos', icon: Camera },
    { id: 'team', label: 'Assigned Contractors', icon: Users },
    { id: 'activity', label: 'Activity', icon: Activity },
  ];

  const canEdit = user && canManageProjects(user.role);
  const canAssign = user && isAdminRole(user.role);

  const notesPanel = (compact = false) => (
    <div className="bg-white rounded-xl border border-gray-200 p-4 h-full">
      <input
        ref={attachExistingNoteInputRef}
        type="file"
        multiple
        accept="image/*,video/*"
        className="hidden"
        onChange={event => attachProgressPicturesToExistingNote(event.target.files)}
      />
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h3 className="font-semibold text-gray-900 text-sm">Project Notes</h3>
          <p className="text-xs text-gray-500 mt-0.5">Office, field, and general updates for this project</p>
        </div>
        {compact && (
          <button
            type="button"
            onClick={() => setTab('notes')}
            className="text-xs font-bold text-blue-600 hover:underline"
          >
            View all
          </button>
        )}
      </div>
      <textarea
        value={newNote}
        onChange={e => setNewNote(e.target.value)}
        rows={compact ? 2 : 3}
        className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none mb-2"
        placeholder="Add a note..."
      />
      <div className="flex gap-2 mb-4">
        <select value={noteType} onChange={e => setNoteType(e.target.value)} className="px-3 py-2 rounded-lg border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="general">General</option>
          <option value="office">Office</option>
          <option value="field">Field</option>
        </select>
        <label className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 bg-white">
          <input
            type="checkbox"
            checked={noteVisibility === 'public'}
            onChange={e => setNoteVisibility(e.target.checked ? 'public' : 'private')}
            style={{ accentColor: '#2563EB' }}
          />
          Public to contractors
        </label>
        <label className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors cursor-pointer">
          <input
            type="file"
            accept="image/*,video/*"
            multiple
            className="hidden"
            onChange={e => setNotePhotoFiles(Array.from(e.target.files || []))}
          />
          <Camera className="w-4 h-4" />
          {notePhotoFiles.length ? `${notePhotoFiles.length} ready` : 'Progress pictures'}
        </label>
        <button
          type="button"
          onClick={listeningNote ? stopNoteDictation : startNoteDictation}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          {listeningNote ? <Square className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          {listeningNote ? 'Stop' : 'Mic'}
        </button>
        <button onClick={addNote} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">Add Note</button>
      </div>
      {listeningNote && (
        <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-lg bg-amber-50 text-amber-800 text-xs font-bold">
          <span>Listening</span>
          <span className="flex items-end gap-0.5 h-4">
            {[0, 1, 2, 3].map(i => (
              <span
                key={i}
                className="w-1 rounded-full bg-amber-500 animate-pulse"
                style={{ height: 6 + i * 3, animationDelay: `${i * 120}ms` }}
              />
            ))}
          </span>
        </div>
      )}
      {notePhotoFiles.length > 0 && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2">
          <span className="text-xs font-semibold text-blue-700 truncate">{notePhotoFiles.length} progress picture{notePhotoFiles.length === 1 ? '' : 's'} will attach to this note</span>
          <button type="button" onClick={() => setNotePhotoFiles([])} className="text-xs font-bold text-blue-700 hover:underline">Remove</button>
        </div>
      )}
      <div className={`space-y-3 ${compact ? 'max-h-80 overflow-y-auto pr-1' : ''}`}>
        {notes.map(note => (
          <div key={note.id} className="rounded-xl border border-gray-100 p-3 flex items-start gap-3">
            {note.user_avatar_url ? (
              <img src={note.user_avatar_url} alt={note.user_name} className="w-9 h-9 rounded-xl object-cover flex-shrink-0" style={{ objectPosition: 'center top' }} />
            ) : (
              <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-black flex-shrink-0" style={{ background: 'linear-gradient(135deg, #D99D26, #C4891F)' }}>
                {getInitials(note.user_name)}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-sm font-medium text-gray-900 truncate">{note.user_name}</span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${note.note_type === 'field' ? 'bg-green-100 text-green-700' : note.note_type === 'office' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>{note.note_type}</span>
                  <span className="hidden sm:inline text-xs text-gray-400">{formatEasternDateTime(note.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                </div>
              </div>
              {editingNoteId === note.id ? (
                <div className="space-y-2">
                  <textarea
                    value={editingNoteText}
                    onChange={e => setEditingNoteText(e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                  />
                  <div className="flex items-center gap-2">
                    <select value={editingNoteType} onChange={e => setEditingNoteType(e.target.value)} className="px-2 py-1.5 rounded-lg border border-gray-300 text-xs bg-white">
                      <option value="general">General</option>
                      <option value="office">Office</option>
                      <option value="field">Field</option>
                    </select>
                    <label className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-gray-300 text-xs font-bold text-gray-600 bg-white">
                      <input
                        type="checkbox"
                        checked={editingNoteVisibility === 'public'}
                        onChange={e => setEditingNoteVisibility(e.target.checked ? 'public' : 'private')}
                        style={{ accentColor: '#2563EB' }}
                      />
                      Public
                    </label>
                    <button type="button" onClick={() => saveNoteEdit(note.id)} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-bold">Save edit</button>
                    <button type="button" onClick={() => setEditingNoteId(null)} className="px-3 py-1.5 rounded-lg border border-gray-300 text-xs font-bold text-gray-600">Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{note.note}</p>
                  <span className={`inline-flex mt-2 px-2 py-0.5 rounded-full text-xs font-bold ${note.visibility === 'public' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                    {note.visibility === 'public' ? 'Public to contractors' : 'Private management note'}
                  </span>
                  {getNotePhotos(note).length > 0 && (
                    <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 p-2">
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {getNotePhotos(note).map((photo: any) => {
                          const src = `/uploads/${note.project_id}/${photo.filename}`;
                          const isVideo = isVideoMedia(photo);
                          return (
                            <div key={photo.id} className="relative aspect-square overflow-hidden rounded-lg bg-white">
                              {isVideo ? (
                                <>
                                  <video src={src} className="h-full w-full object-cover" muted playsInline preload="metadata" />
                                  <PlayCircle className="absolute inset-0 m-auto h-7 w-7 text-white drop-shadow" />
                                </>
                              ) : (
                                <img src={src} alt={photo.original_name || 'Note attachment'} className="h-full w-full object-cover" loading="lazy" />
                              )}
                              <div className="absolute bottom-1 left-1 rounded-full bg-black/65 px-1.5 py-0.5 text-[10px] font-black text-white">
                                {formatEasternDateTime(photo.taken_at || photo.created_at, { hour: 'numeric', minute: '2-digit' })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <p className="px-1 pt-2 text-xs font-semibold text-gray-500">Progress pictures attached to this note</p>
                    </div>
                  )}
                  {note.edited_at && (
                    <p className="text-xs text-gray-400 mt-2">Edited by {note.edited_by_name || note.user_name} on {formatEasternDateTime(note.edited_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} New York time</p>
                  )}
                </>
              )}
              {note.user_id === user?.id && Number(note.edit_count || 0) < 1 && editingNoteId !== note.id && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingNoteId(note.id);
                    setEditingNoteText(note.note);
                    setEditingNoteType(note.note_type || 'general');
                    setEditingNoteVisibility(note.visibility === 'public' ? 'public' : 'private');
                  }}
                  className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-blue-600 hover:underline"
                >
                  <Edit2 className="w-3 h-3" />
                  Edit note
                </button>
              )}
              {editingNoteId !== note.id && (
                <button
                  type="button"
                  onClick={() => {
                    setAttachNoteId(note.id);
                    attachExistingNoteInputRef.current?.click();
                  }}
                  disabled={attachingNoteId === note.id}
                  className="mt-2 ml-3 inline-flex items-center gap-1 text-xs font-bold text-amber-600 hover:underline disabled:opacity-50"
                >
                  <ImagePlus className="w-3 h-3" />
                  {attachingNoteId === note.id ? 'Attaching...' : 'Attach progress pictures'}
                </button>
              )}
            </div>
          </div>
        ))}
        {notes.length === 0 && <p className="text-center text-gray-400 text-sm py-8">No notes yet</p>}
      </div>
    </div>
  );

  return (
    <div className="min-h-full">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="px-4 md:px-6 py-3">
          <div className="flex items-center gap-3 mb-3">
            <button onClick={() => navigate('/projects')} className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="w-14 h-12 rounded-xl overflow-hidden flex items-center justify-center flex-shrink-0" style={{ background: '#EFF6FF' }}>
              {project.main_photo_url ? (
                <img src={project.main_photo_url} alt={project.address} className="w-full h-full object-cover" />
              ) : (
                <MapPin className="w-5 h-5 text-blue-600" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="font-bold text-gray-900 text-lg truncate">{project.address}</h1>
                <StatusBadge status={project.status} />
              </div>
              <p className="text-sm text-gray-500 truncate">{project.job_name}</p>
            </div>
            <button
              type="button"
              onClick={() => navigate(`/photos?projectId=${id}`)}
              className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-amber-500 px-3 py-2 text-xs font-black text-white shadow-sm transition hover:bg-amber-600"
              title="Upload timestamped progress pictures or videos"
              aria-label="Upload progress pictures"
            >
              <Camera className="h-4 w-4" />
              <span className="hidden md:inline">Upload Progress Pictures</span>
              <span className="md:hidden">Upload</span>
            </button>
            {canEdit && (
              <button onClick={() => { setShowEdit(true); setEditAddress(project.address || ''); setEditBudget(project.budget ? String(project.budget) : ''); setEditPurchasePrice(project.purchase_price ? String(project.purchase_price) : ''); setEditArv(project.arv ? String(project.arv) : ''); setEditClosingCosts(project.closing_costs ? String(project.closing_costs) : ''); Object.entries(project).forEach(([k, v]) => setValue(k, v)); }} className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors">
                <Edit2 className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Tabs */}
          <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-hide">
            {tabs.map(({ id: tabId, label, icon: Icon }) => (
              <button
                key={tabId}
                onClick={() => setTab(tabId)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors flex-shrink-0 ${
                  tab === tabId ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tab Content */}
      <div className="p-4 md:p-6 max-w-5xl mx-auto">
        {/* Overview */}
        {tab === 'overview' && (
          <div className="space-y-4">
            {/* Stats row */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {[
                { label: 'Open Punch Items', value: project.punch_stats?.filter((s: any) => s.status !== 'completed').reduce((a: number, b: any) => a + b.cnt, 0) || 0, color: 'text-orange-600', bg: 'bg-orange-50' },
                { label: 'Completed Items', value: project.punch_stats?.find((s: any) => s.status === 'completed')?.cnt || 0, color: 'text-green-600', bg: 'bg-green-50' },
                { label: 'Assigned Contractors', value: project.assignments?.length || 0, color: 'text-blue-600', bg: 'bg-blue-50' },
              ].map(({ label, value, color, bg }) => (
                <div key={label} className="bg-white rounded-xl border border-gray-200 p-4">
                  <p className={`text-2xl font-bold ${color}`}>{value}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{label}</p>
                </div>
              ))}
            </div>

            <div className="grid lg:grid-cols-5 gap-4">
              <div className="lg:col-span-2 space-y-4">
            {/* Project details */}
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <h3 className="font-semibold text-gray-900 mb-3 text-sm">Project Details</h3>
              <div className="grid sm:grid-cols-2 gap-4 text-sm">
                {[
                  { label: 'Status', value: <StatusBadge status={project.status} /> },
                  { label: 'Est. Closing Costs', value: project.closing_costs ? `$${Number(project.closing_costs).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—' },
                  { label: 'Start Date', value: project.start_date ? format(new Date(project.start_date), 'MMM d, yyyy') : '—' },
                  { label: 'Target Completion', value: project.target_completion ? format(new Date(project.target_completion), 'MMM d, yyyy') : '—' },
                  { label: 'Budget', value: project.budget ? `$${Number(project.budget).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—' },
                  { label: 'Lockbox Code', value: project.lockbox_code || 'Not entered' },
                  { label: 'Created By', value: project.created_by_name || '—' },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <p className="text-xs text-gray-500 mb-0.5">{label}</p>
                    <div className="font-medium text-gray-900">{value}</div>
                  </div>
                ))}
              </div>
            </div>

              <button id="construction-plan" type="button" onClick={() => setTab('construction-plan')} className="w-full bg-white rounded-xl border border-gray-200 p-4 text-left hover:border-blue-300 hover:bg-blue-50 transition-colors">
                <h3 className="font-semibold text-gray-900 mb-2 text-sm">Scope of Work</h3>
                <p className="text-sm text-gray-600">Open project scope sections by house area, plus the execution plan, materials, costs, and step photos.</p>
              </button>
              <button id="quotes" type="button" onClick={() => setTab('quotes')} className="w-full bg-white rounded-xl border border-gray-200 p-4 text-left hover:border-blue-300 hover:bg-blue-50 transition-colors">
                <h3 className="font-semibold text-gray-900 mb-2 text-sm">Upload Quotes</h3>
                <p className="text-sm text-gray-600">Store contractor quotes directly against this property.</p>
              </button>
              </div>
              <div className="lg:col-span-3">
                {notesPanel(true)}
              </div>
            </div>

          </div>
        )}

        {tab === 'construction-plan' && (
          <ScopeOfWorkTab projectId={id!} project={project} canManage={!!canEdit} />
        )}

        {tab === 'quotes' && (
          <QuotesTab projectId={id!} project={project} />
        )}

        {/* Punch List Tab */}
        {tab === 'punch-list' && (
          <PunchListTab projectId={id!} user={user} />
        )}

        {/* Photos Tab */}
        {tab === 'photos' && (
          <PhotosTab projectId={id!} user={user} />
        )}

        {/* Invoices Tab */}
        {tab === 'invoices' && (
          <InvoicesTab projectId={id!} user={user} project={project} />
        )}

        {/* Notes Tab */}
        {tab === 'notes' && (
          notesPanel(false)
        )}

        {/* Team Tab */}
        {tab === 'team' && (
          <div className="space-y-4">
            {canAssign && (
              <button onClick={() => { setShowAssign(true); loadUsers(); }} className="w-full flex items-center justify-center gap-2 py-3 border-2 border-dashed border-gray-300 rounded-xl text-sm font-medium text-gray-600 hover:border-blue-400 hover:text-blue-600 transition-colors">
                <UserPlus className="w-4 h-4" /> Assign User to Project
              </button>
            )}
            <div className="space-y-3">
              {project.assignments?.map((a: any) => (
                <div key={a.id} className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3">
                  <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                    <span className="text-blue-700 font-bold text-sm">{a.name?.[0]?.toUpperCase()}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900 text-sm">{a.name}</p>
                    <p className="text-xs text-gray-500">{a.email}</p>
                    <span className="text-xs text-gray-400 capitalize">{a.role.replace(/_/g, ' ')}</span>
                  </div>
                  {canAssign && (
                    <button onClick={() => handleUnassign(a.user_id)} className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
              {project.assignments?.length === 0 && <p className="text-center text-gray-400 text-sm py-8">No users assigned</p>}
            </div>
          </div>
        )}

        {/* Activity Tab */}
        {tab === 'activity' && (
          <div className="space-y-2">
            {activity.map(log => (
              <div key={log.id} className="bg-white rounded-xl border border-gray-200 p-4 flex items-start gap-3">
                <div className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Activity className="w-4 h-4 text-gray-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-900"><span className="font-medium">{log.user_name}</span> {log.action.replace(/_/g, ' ')}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{formatEasternDateTime(log.created_at, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} New York time</p>
                </div>
              </div>
            ))}
            {activity.length === 0 && <p className="text-center text-gray-400 text-sm py-8">No activity yet</p>}
          </div>
        )}
      </div>

      {/* Edit Project Modal */}
      <Modal isOpen={showEdit} onClose={() => setShowEdit(false)} title="Edit Project" size="lg">
        <form onSubmit={handleSubmit(onEditProject)} className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-2">Main House Photo</label>
              <label className="flex items-center gap-3 p-3 rounded-xl border border-dashed border-gray-300 cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={uploadingMainPhoto}
                  onChange={e => {
                    const file = e.target.files?.[0];
                    handleMainPhotoUpload(file);
                    e.currentTarget.value = '';
                  }}
                />
                <div className="w-16 h-12 rounded-xl overflow-hidden flex items-center justify-center flex-shrink-0" style={{ background: '#F3F4F6' }}>
                  {project.main_photo_url ? (
                    <img src={project.main_photo_url} alt={project.address} className="w-full h-full object-cover" />
                  ) : (
                    <Camera className="w-5 h-5 text-gray-400" />
                  )}
                </div>
                <div>
                  <p className="text-sm font-bold text-gray-900">{uploadingMainPhoto ? 'Uploading...' : project.main_photo_url ? 'Change main photo' : 'Upload main photo'}</p>
                  <p className="text-xs text-gray-500">One primary photo appears on the project card beside the address.</p>
                </div>
              </label>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Address *</label>
              <GooglePlacesInput
                value={editAddress}
                onChange={(val) => { setEditAddress(val); setValue('address', val); }}
                placeholder="123 Main St, City, State"
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Job Name *</label>
              <input {...register('job_name', { required: true })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select {...register('status')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                <option value="active_rehab">Active Rehab</option>
                <option value="rehab_completed">Completed</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Lockbox Code</label>
              <input {...register('lockbox_code')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Enter lockbox code" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Acquisition Date</label>
              <input type="date" {...register('acquisition_date')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
              <input type="date" {...register('start_date')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Target Completion</label>
              <input type="date" {...register('target_completion')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Est. Closing Costs</label>
              <CurrencyInput value={editClosingCosts} onChange={setEditClosingCosts} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Budget</label>
              <CurrencyInput value={editBudget} onChange={setEditBudget} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Scope of Work</label>
              <textarea {...register('scope_of_work')} rows={3} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Office Notes</label>
              <textarea {...register('office_notes')} rows={2} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Field Notes</label>
              <textarea {...register('field_notes')} rows={2} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={() => setShowEdit(false)} className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">
              {isSubmitting ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Assign User Modal */}
      <Modal isOpen={showAssign} onClose={() => setShowAssign(false)} title="Assign User to Project">
        <div className="space-y-2">
          {allUsers.filter(u => !project.assignments?.some((a: any) => a.user_id === u.id)).map(u => (
            <button key={u.id} onClick={() => { handleAssign(u.id); setShowAssign(false); }} className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50 transition-colors text-left">
              <div className="w-9 h-9 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                <span className="text-blue-700 font-bold text-sm">{u.name?.[0]?.toUpperCase()}</span>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900">{u.name}</p>
                <p className="text-xs text-gray-500">{u.email} · {u.role.replace(/_/g, ' ')}</p>
              </div>
            </button>
          ))}
          {allUsers.filter(u => !project.assignments?.some((a: any) => a.user_id === u.id)).length === 0 && (
            <p className="text-center text-gray-400 text-sm py-4">All users are already assigned</p>
          )}
        </div>
      </Modal>
    </div>
  );
}

// ---- Sub-components ----

type ProjectScopeForm = {
  section_name: string;
  scope_title: string;
  scope_of_work: string;
  status: string;
};

const blankProjectScopeForm: ProjectScopeForm = {
  section_name: '',
  scope_title: '',
  scope_of_work: '',
  status: 'active',
};

function ScopeOfWorkTab({ projectId, project, canManage }: { projectId: string; project: any; canManage: boolean }) {
  const [scopes, setScopes] = useState<any[]>([]);
  const [legacyScope, setLegacyScope] = useState('');
  const [loading, setLoading] = useState(true);
  const [showEditor, setShowEditor] = useState(false);
  const [editingScope, setEditingScope] = useState<any | null>(null);
  const [scopeForm, setScopeForm] = useState<ProjectScopeForm>(blankProjectScopeForm);

  const scopeStatusColors: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-700',
    active: 'bg-blue-100 text-blue-700',
    on_hold: 'bg-amber-100 text-amber-700',
    completed: 'bg-green-100 text-green-700',
  };

  const loadScopes = async () => {
    try {
      const res = await api.get(`/projects/${projectId}/scopes`);
      setScopes(Array.isArray(res.data?.scopes) ? res.data.scopes : []);
      setLegacyScope(res.data?.legacy_scope_of_work || '');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to load scopes of work');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    loadScopes();
  }, [projectId]);

  const openAddScope = () => {
    setEditingScope(null);
    setScopeForm(blankProjectScopeForm);
    setShowEditor(true);
  };

  const openEditScope = (scope: any) => {
    if (!canManage) return;
    setEditingScope(scope);
    setScopeForm({
      section_name: scope.section_name || '',
      scope_title: scope.scope_title || '',
      scope_of_work: scope.scope_of_work || '',
      status: scope.status || 'active',
    });
    setShowEditor(true);
  };

  const saveScope = async () => {
    const payload = {
      section_name: scopeForm.section_name.trim() || 'General',
      scope_title: scopeForm.scope_title.trim(),
      scope_of_work: scopeForm.scope_of_work.trim(),
      status: scopeForm.status || 'active',
    };
    if (!payload.scope_title) return toast.error('Enter a scope title');
    if (!payload.scope_of_work) return toast.error('Enter the scope of work');

    try {
      if (editingScope) {
        await api.put(`/projects/${projectId}/scopes/${editingScope.id}`, payload);
        toast.success('Scope of work updated');
      } else {
        await api.post(`/projects/${projectId}/scopes`, payload);
        toast.success('Scope of work added');
      }
      setShowEditor(false);
      setEditingScope(null);
      setScopeForm(blankProjectScopeForm);
      loadScopes();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to save scope of work');
    }
  };

  const deleteScope = async () => {
    if (!editingScope) return;
    if (!window.confirm('Delete this scope of work?')) return;
    try {
      await api.delete(`/projects/${projectId}/scopes/${editingScope.id}`);
      setShowEditor(false);
      setEditingScope(null);
      setScopeForm(blankProjectScopeForm);
      loadScopes();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to delete scope of work');
    }
  };

  const moveScope = async (scopeId: string, direction: 'up' | 'down') => {
    try {
      await api.post(`/projects/${projectId}/scopes/${scopeId}/move`, { direction });
      loadScopes();
    } catch {
      toast.error('Failed to reorder scope of work');
    }
  };

  const completedCount = scopes.filter(scope => scope.status === 'completed').length;
  const activeCount = scopes.filter(scope => scope.status === 'active').length;

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-2xl border border-gray-200 p-5" style={{ boxShadow: '0 10px 30px rgba(17,24,39,0.08)' }}>
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div>
            <h3 className="font-black text-gray-900">Scope of Work</h3>
            <p className="text-sm text-gray-500 mt-1">Central scope sections for {project?.address}. Use one scope per house area, project phase, or work section.</p>
          </div>
          {canManage && (
            <button type="button" onClick={openAddScope} className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-black hover:bg-blue-700">
              <Plus className="w-4 h-4" /> Add Scope Section
            </button>
          )}
        </div>
        <div className="grid sm:grid-cols-3 gap-3 mt-4">
          <div className="rounded-xl bg-blue-50 p-3">
            <p className="text-xl font-black text-blue-700">{scopes.length}</p>
            <p className="text-xs font-semibold text-blue-700">Scope sections</p>
          </div>
          <div className="rounded-xl bg-green-50 p-3">
            <p className="text-xl font-black text-green-700">{activeCount}</p>
            <p className="text-xs font-semibold text-green-700">Active scopes</p>
          </div>
          <div className="rounded-xl bg-gray-50 p-3">
            <p className="text-xl font-black text-gray-700">{completedCount}</p>
            <p className="text-xs font-semibold text-gray-700">Completed scopes</p>
          </div>
        </div>
      </div>

      {loading ? (
        <Loading />
      ) : (
        <div className="space-y-3">
          {legacyScope && scopes.length === 0 && (
            <div className="bg-white rounded-2xl border border-amber-200 p-4">
              <p className="text-xs font-black uppercase tracking-wide text-amber-700">Original project scope note</p>
              <p className="text-sm text-gray-700 whitespace-pre-wrap mt-2">{legacyScope}</p>
            </div>
          )}

          {scopes.length === 0 ? (
            <div className="bg-white rounded-2xl border border-dashed border-gray-300 p-10 text-center">
              <FileText className="w-9 h-9 text-gray-300 mx-auto mb-3" />
              <p className="text-sm font-black text-gray-700">No scope sections entered yet</p>
              <p className="text-sm text-gray-500 mt-1">Add separate scopes for kitchen, bath, exterior, mechanicals, site work, or any project section.</p>
              {canManage && (
                <button type="button" onClick={openAddScope} className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-bold">
                  <Plus className="w-4 h-4" /> Add first scope
                </button>
              )}
            </div>
          ) : (
            <div className="grid lg:grid-cols-2 gap-3">
              {scopes.map((scope, index) => (
                <div key={scope.id} className="bg-white rounded-2xl border border-gray-200 p-4" style={{ boxShadow: '0 8px 24px rgba(17,24,39,0.06)' }}>
                  <div className="flex items-start justify-between gap-3">
                    <button type="button" onClick={() => openEditScope(scope)} className="text-left flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="inline-flex w-7 h-7 rounded-lg bg-gray-900 text-white items-center justify-center text-xs font-black">{scope.sort_order || index + 1}</span>
                        <span className="text-xs font-black uppercase tracking-wide text-blue-700">{scope.section_name || 'General'}</span>
                        <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${scopeStatusColors[scope.status] || scopeStatusColors.active}`}>{String(scope.status || 'active').replace(/_/g, ' ')}</span>
                      </div>
                      <h4 className="font-black text-gray-900 mt-3">{scope.scope_title}</h4>
                      <p className="text-sm text-gray-700 mt-2 whitespace-pre-wrap">{scope.scope_of_work}</p>
                      <p className="text-xs text-gray-400 mt-3">
                        Updated {formatEasternDateTime(scope.updated_at || scope.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} New York time
                      </p>
                    </button>
                    {canManage && (
                      <div className="flex flex-col gap-2 flex-shrink-0">
                        <button type="button" disabled={index === 0} onClick={() => moveScope(scope.id, 'up')} className="p-2 rounded-lg border border-gray-200 disabled:opacity-30 hover:bg-gray-50">
                          <ArrowUp className="w-4 h-4" />
                        </button>
                        <button type="button" disabled={index === scopes.length - 1} onClick={() => moveScope(scope.id, 'down')} className="p-2 rounded-lg border border-gray-200 disabled:opacity-30 hover:bg-gray-50">
                          <ArrowDown className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <ConstructionPlanBoard projectId={projectId} canManage={canManage} />

      <Modal isOpen={showEditor} onClose={() => setShowEditor(false)} title={editingScope ? 'Edit Scope of Work' : 'Add Scope of Work'} size="lg">
        <div className="space-y-4">
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">House / Project Section</label>
              <input value={scopeForm.section_name} onChange={e => setScopeForm(current => ({ ...current, section_name: e.target.value }))} placeholder="Kitchen, exterior, roof, site work..." className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select value={scopeForm.status} onChange={e => setScopeForm(current => ({ ...current, status: e.target.value }))} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                {['draft', 'active', 'on_hold', 'completed'].map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Scope Title *</label>
              <input value={scopeForm.scope_title} onChange={e => setScopeForm(current => ({ ...current, scope_title: e.target.value }))} placeholder="Kitchen cabinet and countertop replacement" className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Scope of Work *</label>
              <textarea value={scopeForm.scope_of_work} onChange={e => setScopeForm(current => ({ ...current, scope_of_work: e.target.value }))} rows={8} placeholder="Enter the full scope for this section..." className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
          </div>
          <div className="flex gap-3">
            {editingScope && <button type="button" onClick={deleteScope} className="px-4 py-2.5 rounded-xl border border-red-200 text-red-700 text-sm font-black hover:bg-red-50">Delete</button>}
            <button type="button" onClick={() => setShowEditor(false)} className="ml-auto px-4 py-2.5 rounded-xl border border-gray-300 text-sm font-black text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="button" onClick={saveScope} className="px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-black hover:bg-blue-700">Save Scope</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function ConstructionPlanBoard({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const [items, setItems] = useState<any[]>([]);
  const [materials, setMaterials] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showStepEditor, setShowStepEditor] = useState(false);
  const [showMaterialEditor, setShowMaterialEditor] = useState(false);
  const [editingStep, setEditingStep] = useState<any | null>(null);
  const [editingMaterial, setEditingMaterial] = useState<any | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState<string | null>(null);
  const blankStepForm = { title: '', category: '', description: '', status: 'not_started', start_date: '', target_date: '' };
  const blankMaterialForm = {
    plan_item_id: '',
    material_name: '',
    category: '',
    quantity: '',
    unit: '',
    estimated_cost: '',
    actual_cost: '',
    supplier: '',
    order_status: 'planned',
    needed_by: '',
    expected_delivery: '',
    delivered_at: '',
    notes: '',
  };
  const [stepForm, setStepForm] = useState(blankStepForm);
  const [materialForm, setMaterialForm] = useState(blankMaterialForm);

  const load = async () => {
    try {
      const [planRes, materialRes] = await Promise.all([
        api.get(`/projects/${projectId}/construction-plan`),
        api.get(`/projects/${projectId}/materials`),
      ]);
      setItems(planRes.data?.items || []);
      setMaterials(materialRes.data || []);
    } catch {
      toast.error('Failed to load construction plan');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [projectId]);

  const statusColors: Record<string, string> = {
    not_started: 'bg-gray-100 text-gray-700',
    in_progress: 'bg-blue-100 text-blue-700',
    waiting_materials: 'bg-amber-100 text-amber-700',
    needs_review: 'bg-purple-100 text-purple-700',
    completed: 'bg-green-100 text-green-700',
  };
  const materialColors: Record<string, string> = {
    planned: 'bg-gray-100 text-gray-700',
    quote_requested: 'bg-blue-100 text-blue-700',
    ordered: 'bg-indigo-100 text-indigo-700',
    waiting: 'bg-amber-100 text-amber-700',
    delivered: 'bg-green-100 text-green-700',
    installed: 'bg-emerald-100 text-emerald-700',
    cancelled: 'bg-red-100 text-red-700',
  };

  const openAddStep = () => {
    setEditingStep(null);
    setStepForm(blankStepForm);
    setShowStepEditor(true);
  };

  const openEditStep = (item: any) => {
    if (!canManage) return;
    setEditingStep(item);
    setStepForm({
      title: item.title || '',
      category: item.category || '',
      description: item.description || '',
      status: item.status || 'not_started',
      start_date: item.start_date || '',
      target_date: item.target_date || '',
    });
    setShowStepEditor(true);
  };

  const saveStep = async () => {
    if (!stepForm.title.trim()) return;
    const payload = {
      ...stepForm,
      title: stepForm.title.trim(),
      category: stepForm.category.trim() || null,
      description: stepForm.description.trim() || null,
      start_date: stepForm.start_date || null,
      target_date: stepForm.target_date || null,
    };
    try {
      if (editingStep) {
        await api.put(`/projects/${projectId}/construction-plan/${editingStep.id}`, payload);
        toast.success('Construction line updated');
      } else {
        await api.post(`/projects/${projectId}/construction-plan`, payload);
        toast.success('Construction line added');
      }
      setShowStepEditor(false);
      setEditingStep(null);
      setStepForm(blankStepForm);
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to save construction line');
    }
  };

  const deleteStep = async () => {
    if (!editingStep) return;
    if (!window.confirm('Delete this construction plan line item?')) return;
    try {
      await api.delete(`/projects/${projectId}/construction-plan/${editingStep.id}`);
      setShowStepEditor(false);
      setEditingStep(null);
      load();
    } catch {
      toast.error('Failed to delete construction line');
    }
  };

  const moveStep = async (itemId: string, direction: 'up' | 'down') => {
    try {
      await api.post(`/projects/${projectId}/construction-plan/${itemId}/move`, { direction });
      load();
    } catch {
      toast.error('Failed to reorder construction plan');
    }
  };

  const quickStatus = async (item: any, status: string) => {
    try {
      await api.put(`/projects/${projectId}/construction-plan/${item.id}`, { ...item, status });
      load();
    } catch {
      toast.error('Failed to update line status');
    }
  };

  const uploadStepPhoto = async (itemId: string, files?: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploadingPhoto(itemId);
    try {
      const formData = new FormData();
      Array.from(files).forEach(file => formData.append('photos', file));
      formData.append('construction_plan_item_id', itemId);
      formData.append('caption', 'Construction plan photo');
      await api.post(`/projects/${projectId}/photos`, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      load();
    } catch {
      toast.error('Failed to upload construction plan photo');
    } finally {
      setUploadingPhoto(null);
    }
  };

  const openAddMaterial = (planItemId = '') => {
    setEditingMaterial(null);
    setMaterialForm({ ...blankMaterialForm, plan_item_id: planItemId });
    setShowMaterialEditor(true);
  };

  const openEditMaterial = (material: any) => {
    if (!canManage) return;
    setEditingMaterial(material);
    setMaterialForm({
      plan_item_id: material.plan_item_id || '',
      material_name: material.material_name || '',
      category: material.category || '',
      quantity: material.quantity ? String(material.quantity) : '',
      unit: material.unit || '',
      estimated_cost: material.estimated_cost ? String(material.estimated_cost) : '',
      actual_cost: material.actual_cost ? String(material.actual_cost) : '',
      supplier: material.supplier || '',
      order_status: material.order_status || 'planned',
      needed_by: material.needed_by || '',
      expected_delivery: material.expected_delivery || '',
      delivered_at: material.delivered_at || '',
      notes: material.notes || '',
    });
    setShowMaterialEditor(true);
  };

  const saveMaterial = async () => {
    if (!materialForm.material_name.trim()) return;
    const payload = {
      ...materialForm,
      material_name: materialForm.material_name.trim(),
      category: materialForm.category.trim() || null,
      quantity: materialForm.quantity ? Number(materialForm.quantity) : null,
      estimated_cost: materialForm.estimated_cost ? Number(materialForm.estimated_cost) : null,
      actual_cost: materialForm.actual_cost ? Number(materialForm.actual_cost) : null,
      needed_by: materialForm.needed_by || null,
      expected_delivery: materialForm.expected_delivery || null,
      delivered_at: materialForm.delivered_at || null,
      notes: materialForm.notes.trim() || null,
    };
    try {
      if (editingMaterial) {
        await api.put(`/projects/${projectId}/materials/${editingMaterial.id}`, payload);
        toast.success('Material updated');
      } else {
        await api.post(`/projects/${projectId}/materials`, payload);
        toast.success('Material added');
      }
      setShowMaterialEditor(false);
      setEditingMaterial(null);
      setMaterialForm(blankMaterialForm);
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to save material');
    }
  };

  const deleteMaterial = async () => {
    if (!editingMaterial) return;
    if (!window.confirm('Delete this material line?')) return;
    try {
      await api.delete(`/projects/${projectId}/materials/${editingMaterial.id}`);
      setShowMaterialEditor(false);
      setEditingMaterial(null);
      load();
    } catch {
      toast.error('Failed to delete material');
    }
  };

  const totalCost = materials.reduce((sum, material) => sum + Number(material.actual_cost || material.estimated_cost || 0), 0);
  const waitingCount = materials.filter(material => ['ordered', 'waiting'].includes(material.order_status)).length;
  const unlinkedMaterials = materials.filter(material => !material.plan_item_id);

  if (loading) return <Loading />;

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-2xl border border-gray-200 p-5" style={{ boxShadow: '0 10px 30px rgba(17,24,39,0.08)' }}>
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h3 className="font-black text-gray-900">Execution Plan & Materials</h3>
            <p className="text-sm text-gray-500 mt-1">{items.length} line item{items.length !== 1 ? 's' : ''} · {materials.length} material item{materials.length !== 1 ? 's' : ''}</p>
          </div>
          {canManage && (
            <div className="flex gap-2">
              <button type="button" onClick={openAddStep} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-blue-600 text-white text-xs font-bold cursor-pointer">
                <Plus className="w-4 h-4" /> Line Item
              </button>
              <button type="button" onClick={() => openAddMaterial()} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-500 text-white text-xs font-bold cursor-pointer">
                <Package className="w-4 h-4" /> Material
              </button>
            </div>
          )}
        </div>
        <div className="grid sm:grid-cols-3 gap-3 mt-4">
          <div className="rounded-xl bg-blue-50 p-3">
            <p className="text-xl font-black text-blue-700">{items.length}</p>
            <p className="text-xs font-semibold text-blue-700">Plan lines</p>
          </div>
          <div className="rounded-xl bg-amber-50 p-3">
            <p className="text-xl font-black text-amber-700">{waitingCount}</p>
            <p className="text-xs font-semibold text-amber-700">Materials waiting</p>
          </div>
          <div className="rounded-xl bg-green-50 p-3">
            <p className="text-xl font-black text-green-700">${totalCost.toLocaleString('en-US', { maximumFractionDigits: 0 })}</p>
            <p className="text-xs font-semibold text-green-700">Material cost</p>
          </div>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="bg-white rounded-2xl border border-dashed border-gray-300 p-10 text-center">
          <FileText className="w-9 h-9 text-gray-300 mx-auto mb-3" />
          <p className="text-sm font-black text-gray-700">No execution plan lines yet</p>
          {canManage && (
            <button type="button" onClick={openAddStep} className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-bold cursor-pointer">
              <Plus className="w-4 h-4" /> Add first line item
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item, index) => {
            const linkedMaterials = materials.filter(material => material.plan_item_id === item.id);
            return (
              <div key={item.id} className="bg-white rounded-2xl border border-gray-200 overflow-hidden" style={{ boxShadow: '0 8px 24px rgba(17,24,39,0.06)' }}>
                <div
                  role={canManage ? 'button' : undefined}
                  tabIndex={canManage ? 0 : undefined}
                  onClick={() => openEditStep(item)}
                  onKeyDown={e => {
                    if (canManage && (e.key === 'Enter' || e.key === ' ')) openEditStep(item);
                  }}
                  className={`p-4 flex gap-3 text-left ${canManage ? 'cursor-pointer hover:bg-blue-50/40 transition-colors' : ''}`}
                >
                  <div className="w-9 h-9 rounded-xl bg-gray-900 text-white flex items-center justify-center text-sm font-black flex-shrink-0">{item.sort_order}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-2">
                      <div className="min-w-0">
                        {item.category && <p className="text-xs font-black uppercase tracking-wide text-gray-400">{item.category}</p>}
                        <h4 className="font-black text-gray-900">{item.title}</h4>
                        {item.description && <p className="text-sm text-gray-600 mt-1 whitespace-pre-wrap">{item.description}</p>}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {canManage && (
                          <>
                            <button type="button" disabled={index === 0} onClick={e => { e.stopPropagation(); moveStep(item.id, 'up'); }} className="p-2 rounded-lg border border-gray-200 disabled:opacity-30 cursor-pointer"><ArrowUp className="w-4 h-4" /></button>
                            <button type="button" disabled={index === items.length - 1} onClick={e => { e.stopPropagation(); moveStep(item.id, 'down'); }} className="p-2 rounded-lg border border-gray-200 disabled:opacity-30 cursor-pointer"><ArrowDown className="w-4 h-4" /></button>
                          </>
                        )}
                        <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${statusColors[item.status] || statusColors.not_started}`}>{String(item.status).replace(/_/g, ' ')}</span>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-3">
                      {item.start_date && <span className="text-xs font-semibold text-gray-500">Start: {format(new Date(item.start_date), 'MMM d, yyyy')}</span>}
                      {item.target_date && <span className="text-xs font-semibold text-gray-500">Target: {format(new Date(item.target_date), 'MMM d, yyyy')}</span>}
                      {canManage && (
                        <>
                          <select value={item.status} onClick={e => e.stopPropagation()} onChange={e => { e.stopPropagation(); quickStatus(item, e.target.value); }} className="px-2 py-1.5 rounded-lg border border-gray-300 text-xs bg-white cursor-pointer">
                            {['not_started', 'in_progress', 'waiting_materials', 'needs_review', 'completed'].map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
                          </select>
                          <label onClick={e => e.stopPropagation()} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold text-blue-700 bg-blue-50 border border-blue-100 cursor-pointer">
                            <input type="file" accept="image/*" capture="environment" multiple className="hidden" disabled={uploadingPhoto === item.id} onChange={e => { uploadStepPhoto(item.id, e.target.files); e.currentTarget.value = ''; }} />
                            <Camera className="w-3.5 h-3.5" />
                            {uploadingPhoto === item.id ? 'Uploading...' : 'Add Photo'}
                          </label>
                          <button type="button" onClick={e => { e.stopPropagation(); openAddMaterial(item.id); }} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold text-amber-700 bg-amber-50 border border-amber-100 cursor-pointer">
                            <Package className="w-3.5 h-3.5" /> Material
                          </button>
                        </>
                      )}
                    </div>
                    {item.photos?.length > 0 && (
                      <div className="flex gap-2 mt-3 overflow-x-auto pb-1">
                        {item.photos.map((photo: any) => (
                          <img key={photo.id} src={`/uploads/${projectId}/${photo.filename}`} alt={photo.original_name || item.title} className="w-24 h-20 rounded-lg object-cover border border-gray-200 flex-shrink-0" />
                        ))}
                      </div>
                    )}
                    <div className="mt-4 rounded-xl bg-gray-50 p-3">
                      <div className="flex items-center justify-between gap-3 mb-2">
                        <p className="text-xs font-black uppercase tracking-wide text-gray-500">Materials tied to this line</p>
                        <span className="text-xs font-bold text-gray-400">{linkedMaterials.length}</span>
                      </div>
                      {linkedMaterials.length === 0 ? (
                        <p className="text-xs text-gray-400">No materials linked yet.</p>
                      ) : (
                        <div className="space-y-2">
                          {linkedMaterials.map(material => (
                            <div
                              key={material.id}
                              onClick={e => { e.stopPropagation(); openEditMaterial(material); }}
                              className={`flex flex-col md:flex-row md:items-center md:justify-between gap-2 rounded-lg bg-white p-2 border border-gray-100 ${canManage ? 'cursor-pointer hover:border-amber-200 hover:bg-amber-50/30' : ''}`}
                            >
                              <div className="min-w-0">
                                <p className="text-sm font-bold text-gray-900 truncate">{material.material_name}</p>
                                <p className="text-xs text-gray-500">{material.quantity || '-'} {material.unit || ''} · {material.supplier || 'No supplier'} · {material.expected_delivery ? `ETA ${format(new Date(material.expected_delivery), 'MMM d')}` : 'No ETA'}</p>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${materialColors[material.order_status] || materialColors.planned}`}>{String(material.order_status).replace(/_/g, ' ')}</span>
                                <span className="text-sm font-black text-gray-900">${Number(material.actual_cost || material.estimated_cost || 0).toLocaleString('en-US')}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {unlinkedMaterials.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-200 p-4" style={{ boxShadow: '0 8px 24px rgba(17,24,39,0.06)' }}>
          <div className="flex items-center justify-between gap-3 mb-3">
            <p className="text-sm font-black text-gray-900">Unlinked Materials</p>
            <span className="text-xs font-black text-gray-400">{unlinkedMaterials.length}</span>
          </div>
          <div className="grid md:grid-cols-2 gap-2">
            {unlinkedMaterials.map(material => (
              <button key={material.id} type="button" onClick={() => openEditMaterial(material)} className="text-left rounded-xl border border-gray-100 p-3 hover:border-amber-200 hover:bg-amber-50/30 cursor-pointer">
                <p className="text-sm font-black text-gray-900">{material.material_name}</p>
                <p className="text-xs text-gray-500">{material.supplier || 'No supplier'} · {material.expected_delivery ? `ETA ${format(new Date(material.expected_delivery), 'MMM d')}` : 'No ETA'}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      <Modal isOpen={showStepEditor} onClose={() => setShowStepEditor(false)} title={editingStep ? 'Edit Construction Line' : 'Add Construction Line'} size="lg">
        <div className="space-y-4">
          <div className="grid md:grid-cols-2 gap-3">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Line Item *</label>
              <input value={stepForm.title} onChange={e => setStepForm({ ...stepForm, title: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
              <input value={stepForm.category} onChange={e => setStepForm({ ...stepForm, category: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select value={stepForm.status} onChange={e => setStepForm({ ...stepForm, status: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                {['not_started', 'in_progress', 'waiting_materials', 'needs_review', 'completed'].map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
              <input type="date" value={stepForm.start_date} onChange={e => setStepForm({ ...stepForm, start_date: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Target Date</label>
              <input type="date" value={stepForm.target_date} onChange={e => setStepForm({ ...stepForm, target_date: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <textarea value={stepForm.description} onChange={e => setStepForm({ ...stepForm, description: e.target.value })} rows={4} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
          </div>
          <div className="flex gap-3">
            {editingStep && <button type="button" onClick={deleteStep} className="px-4 py-2.5 rounded-xl border border-red-200 text-red-700 text-sm font-black hover:bg-red-50">Delete</button>}
            <button type="button" onClick={() => setShowStepEditor(false)} className="ml-auto px-4 py-2.5 rounded-xl border border-gray-300 text-sm font-black text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="button" onClick={saveStep} className="px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-black hover:bg-blue-700">Save</button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={showMaterialEditor} onClose={() => setShowMaterialEditor(false)} title={editingMaterial ? 'Edit Material' : 'Add Material'} size="lg">
        <div className="space-y-4">
          <div className="grid md:grid-cols-3 gap-3">
            <div className="md:col-span-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">Link To Construction Line</label>
              <select value={materialForm.plan_item_id} onChange={e => setMaterialForm({ ...materialForm, plan_item_id: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Unlinked material</option>
                {items.map(item => <option key={item.id} value={item.id}>{item.sort_order}. {item.title}</option>)}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Material *</label>
              <input value={materialForm.material_name} onChange={e => setMaterialForm({ ...materialForm, material_name: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select value={materialForm.order_status} onChange={e => setMaterialForm({ ...materialForm, order_status: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                {['planned', 'quote_requested', 'ordered', 'waiting', 'delivered', 'installed', 'cancelled'].map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Category</label><input value={materialForm.category} onChange={e => setMaterialForm({ ...materialForm, category: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label><input value={materialForm.quantity} onChange={e => setMaterialForm({ ...materialForm, quantity: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Unit</label><input value={materialForm.unit} onChange={e => setMaterialForm({ ...materialForm, unit: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Estimated Cost</label><input value={materialForm.estimated_cost} onChange={e => setMaterialForm({ ...materialForm, estimated_cost: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Actual Cost</label><input value={materialForm.actual_cost} onChange={e => setMaterialForm({ ...materialForm, actual_cost: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Supplier</label><input value={materialForm.supplier} onChange={e => setMaterialForm({ ...materialForm, supplier: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Needed By</label><input type="date" value={materialForm.needed_by} onChange={e => setMaterialForm({ ...materialForm, needed_by: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Expected Delivery</label><input type="date" value={materialForm.expected_delivery} onChange={e => setMaterialForm({ ...materialForm, expected_delivery: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Delivered At</label><input type="date" value={materialForm.delivered_at} onChange={e => setMaterialForm({ ...materialForm, delivered_at: e.target.value })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div className="md:col-span-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <textarea value={materialForm.notes} onChange={e => setMaterialForm({ ...materialForm, notes: e.target.value })} rows={3} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
          </div>
          <div className="flex gap-3">
            {editingMaterial && <button type="button" onClick={deleteMaterial} className="px-4 py-2.5 rounded-xl border border-red-200 text-red-700 text-sm font-black hover:bg-red-50">Delete</button>}
            <button type="button" onClick={() => setShowMaterialEditor(false)} className="ml-auto px-4 py-2.5 rounded-xl border border-gray-300 text-sm font-black text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="button" onClick={saveMaterial} className="px-4 py-2.5 rounded-xl bg-amber-500 text-white text-sm font-black hover:bg-amber-600">Save</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function ConstructionPlanTab({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const [items, setItems] = useState<any[]>([]);
  const [materials, setMaterials] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddStep, setShowAddStep] = useState(false);
  const [showAddMaterial, setShowAddMaterial] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState<string | null>(null);
  const [stepForm, setStepForm] = useState({ title: '', description: '', category: 'General', target_date: '' });
  const [materialForm, setMaterialForm] = useState({
    plan_item_id: '',
    material_name: '',
    category: 'General',
    quantity: '',
    unit: '',
    estimated_cost: '',
    supplier: '',
    order_status: 'planned',
    needed_by: '',
    expected_delivery: '',
    notes: '',
  });

  const load = async () => {
    try {
      const [planRes, materialRes] = await Promise.all([
        api.get(`/projects/${projectId}/construction-plan`),
        api.get(`/projects/${projectId}/materials`),
      ]);
      setItems(planRes.data?.items || []);
      setMaterials(materialRes.data || []);
    } catch {
      toast.error('Failed to load construction plan');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [projectId]);

  const addStep = async () => {
    if (!stepForm.title.trim()) return;
    try {
      await api.post(`/projects/${projectId}/construction-plan`, stepForm);
      setStepForm({ title: '', description: '', category: 'General', target_date: '' });
      setShowAddStep(false);
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to add construction step');
    }
  };

  const updateStep = async (item: any, patch: any) => {
    try {
      await api.put(`/projects/${projectId}/construction-plan/${item.id}`, { ...item, ...patch });
      load();
    } catch {
      toast.error('Failed to update construction step');
    }
  };

  const moveStep = async (itemId: string, direction: 'up' | 'down') => {
    try {
      await api.post(`/projects/${projectId}/construction-plan/${itemId}/move`, { direction });
      load();
    } catch {
      toast.error('Failed to reorder construction plan');
    }
  };

  const uploadStepPhoto = async (itemId: string, files?: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploadingPhoto(itemId);
    try {
      const formData = new FormData();
      Array.from(files).forEach(file => formData.append('photos', file));
      formData.append('construction_plan_item_id', itemId);
      formData.append('caption', 'Construction plan photo');
      await api.post(`/projects/${projectId}/photos`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      load();
    } catch {
      toast.error('Failed to upload construction plan photo');
    } finally {
      setUploadingPhoto(null);
    }
  };

  const addMaterial = async () => {
    if (!materialForm.material_name.trim()) return;
    try {
      await api.post(`/projects/${projectId}/materials`, {
        ...materialForm,
        quantity: materialForm.quantity ? Number(materialForm.quantity) : null,
        estimated_cost: materialForm.estimated_cost ? Number(materialForm.estimated_cost) : null,
      });
      setMaterialForm({
        plan_item_id: '',
        material_name: '',
        category: 'General',
        quantity: '',
        unit: '',
        estimated_cost: '',
        supplier: '',
        order_status: 'planned',
        needed_by: '',
        expected_delivery: '',
        notes: '',
      });
      setShowAddMaterial(false);
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to add material');
    }
  };

  const updateMaterial = async (material: any, patch: any) => {
    try {
      await api.put(`/projects/${projectId}/materials/${material.id}`, { ...material, ...patch });
      load();
    } catch {
      toast.error('Failed to update material');
    }
  };

  const statusColors: Record<string, string> = {
    not_started: 'bg-gray-100 text-gray-700',
    in_progress: 'bg-blue-100 text-blue-700',
    waiting_materials: 'bg-amber-100 text-amber-700',
    needs_review: 'bg-purple-100 text-purple-700',
    completed: 'bg-green-100 text-green-700',
  };
  const materialColors: Record<string, string> = {
    planned: 'bg-gray-100 text-gray-700',
    quote_requested: 'bg-blue-100 text-blue-700',
    ordered: 'bg-indigo-100 text-indigo-700',
    waiting: 'bg-amber-100 text-amber-700',
    delivered: 'bg-green-100 text-green-700',
    installed: 'bg-emerald-100 text-emerald-700',
    cancelled: 'bg-red-100 text-red-700',
  };

  const totalCost = materials.reduce((sum, material) => sum + Number(material.actual_cost || material.estimated_cost || 0), 0);
  const waitingCount = materials.filter(material => ['ordered', 'waiting'].includes(material.order_status)).length;

  if (loading) return <Loading />;

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h3 className="font-black text-gray-900">Scope of Work & Materials Timeline</h3>
            <p className="text-sm text-gray-500 mt-1">Ordered rehab steps coordinated with supply needs, delivery dates, costs, and field photos.</p>
          </div>
          {canManage && (
            <div className="flex gap-2">
              <button type="button" onClick={() => setShowAddStep(true)} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-blue-600 text-white text-xs font-bold">
                <Plus className="w-4 h-4" /> Step
              </button>
              <button type="button" onClick={() => setShowAddMaterial(true)} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-500 text-white text-xs font-bold">
                <Package className="w-4 h-4" /> Material
              </button>
            </div>
          )}
        </div>
        <div className="grid sm:grid-cols-3 gap-3 mt-4">
          <div className="rounded-xl bg-blue-50 p-3">
            <p className="text-xl font-black text-blue-700">{items.length}</p>
            <p className="text-xs font-semibold text-blue-700">Plan steps</p>
          </div>
          <div className="rounded-xl bg-amber-50 p-3">
            <p className="text-xl font-black text-amber-700">{waitingCount}</p>
            <p className="text-xs font-semibold text-amber-700">Materials waiting</p>
          </div>
          <div className="rounded-xl bg-green-50 p-3">
            <p className="text-xl font-black text-green-700">${totalCost.toLocaleString('en-US', { maximumFractionDigits: 0 })}</p>
            <p className="text-xs font-semibold text-green-700">Material cost</p>
          </div>
        </div>
      </div>

      {showAddStep && (
        <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          <div className="grid md:grid-cols-2 gap-3">
            <input value={stepForm.title} onChange={e => setStepForm({ ...stepForm, title: e.target.value })} placeholder="Construction step title" className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
            <input value={stepForm.category} onChange={e => setStepForm({ ...stepForm, category: e.target.value })} placeholder="Category" className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
            <input type="date" value={stepForm.target_date} onChange={e => setStepForm({ ...stepForm, target_date: e.target.value })} className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
            <textarea value={stepForm.description} onChange={e => setStepForm({ ...stepForm, description: e.target.value })} placeholder="Step description" className="md:col-span-2 px-3 py-2 rounded-lg border border-gray-300 text-sm resize-none" rows={3} />
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setShowAddStep(false)} className="px-3 py-2 rounded-lg border border-gray-300 text-sm font-bold">Cancel</button>
            <button type="button" onClick={addStep} className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-bold">Add step</button>
          </div>
        </div>
      )}

      {showAddMaterial && (
        <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          <div className="grid md:grid-cols-3 gap-3">
            <select value={materialForm.plan_item_id} onChange={e => setMaterialForm({ ...materialForm, plan_item_id: e.target.value })} className="px-3 py-2 rounded-lg border border-gray-300 text-sm bg-white">
              <option value="">Link to construction step</option>
              {items.map(item => <option key={item.id} value={item.id}>{item.sort_order}. {item.title}</option>)}
            </select>
            <input value={materialForm.material_name} onChange={e => setMaterialForm({ ...materialForm, material_name: e.target.value })} placeholder="Material name" className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
            <input value={materialForm.category} onChange={e => setMaterialForm({ ...materialForm, category: e.target.value })} placeholder="Category" className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
            <input value={materialForm.quantity} onChange={e => setMaterialForm({ ...materialForm, quantity: e.target.value })} placeholder="Quantity" className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
            <input value={materialForm.unit} onChange={e => setMaterialForm({ ...materialForm, unit: e.target.value })} placeholder="Unit" className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
            <input value={materialForm.estimated_cost} onChange={e => setMaterialForm({ ...materialForm, estimated_cost: e.target.value })} placeholder="Estimated cost" className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
            <input value={materialForm.supplier} onChange={e => setMaterialForm({ ...materialForm, supplier: e.target.value })} placeholder="Supplier" className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
            <input type="date" value={materialForm.needed_by} onChange={e => setMaterialForm({ ...materialForm, needed_by: e.target.value })} className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
            <input type="date" value={materialForm.expected_delivery} onChange={e => setMaterialForm({ ...materialForm, expected_delivery: e.target.value })} className="px-3 py-2 rounded-lg border border-gray-300 text-sm" />
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setShowAddMaterial(false)} className="px-3 py-2 rounded-lg border border-gray-300 text-sm font-bold">Cancel</button>
            <button type="button" onClick={addMaterial} className="px-3 py-2 rounded-lg bg-amber-500 text-white text-sm font-bold">Add material</button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {items.map((item, index) => {
          const linkedMaterials = materials.filter(material => material.plan_item_id === item.id);
          return (
            <div key={item.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="p-4 flex gap-3">
                <div className="w-9 h-9 rounded-xl bg-gray-900 text-white flex items-center justify-center text-sm font-black flex-shrink-0">{item.sort_order}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-2">
                    <div>
                      <p className="text-xs font-black uppercase tracking-wide text-gray-400">{item.category}</p>
                      <h4 className="font-black text-gray-900">{item.title}</h4>
                      {item.description && <p className="text-sm text-gray-600 mt-1 whitespace-pre-wrap">{item.description}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      {canManage && (
                        <>
                          <button type="button" disabled={index === 0} onClick={() => moveStep(item.id, 'up')} className="p-2 rounded-lg border border-gray-200 disabled:opacity-30"><ArrowUp className="w-4 h-4" /></button>
                          <button type="button" disabled={index === items.length - 1} onClick={() => moveStep(item.id, 'down')} className="p-2 rounded-lg border border-gray-200 disabled:opacity-30"><ArrowDown className="w-4 h-4" /></button>
                        </>
                      )}
                      <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${statusColors[item.status] || statusColors.not_started}`}>{String(item.status).replace(/_/g, ' ')}</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 mt-3">
                    {item.target_date && <span className="text-xs font-semibold text-gray-500">Target: {format(new Date(item.target_date), 'MMM d, yyyy')}</span>}
                    {canManage && (
                      <>
                        <select value={item.status} onChange={e => updateStep(item, { status: e.target.value })} className="px-2 py-1.5 rounded-lg border border-gray-300 text-xs bg-white">
                          {['not_started', 'in_progress', 'waiting_materials', 'needs_review', 'completed'].map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
                        </select>
                        <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold text-blue-700 bg-blue-50 border border-blue-100 cursor-pointer">
                          <input type="file" accept="image/*" capture="environment" multiple className="hidden" disabled={uploadingPhoto === item.id} onChange={e => { uploadStepPhoto(item.id, e.target.files); e.currentTarget.value = ''; }} />
                          <Camera className="w-3.5 h-3.5" />
                          {uploadingPhoto === item.id ? 'Uploading...' : 'Add Photo'}
                        </label>
                      </>
                    )}
                  </div>

                  {item.photos?.length > 0 && (
                    <div className="flex gap-2 mt-3 overflow-x-auto pb-1">
                      {item.photos.map((photo: any) => (
                        <img key={photo.id} src={`/uploads/${projectId}/${photo.filename}`} alt={photo.original_name || item.title} className="w-24 h-20 rounded-lg object-cover border border-gray-200 flex-shrink-0" />
                      ))}
                    </div>
                  )}

                  <div className="mt-4 rounded-xl bg-gray-50 p-3">
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <p className="text-xs font-black uppercase tracking-wide text-gray-500">Materials tied to this step</p>
                      <span className="text-xs font-bold text-gray-400">{linkedMaterials.length}</span>
                    </div>
                    {linkedMaterials.length === 0 ? (
                      <p className="text-xs text-gray-400">No materials linked yet.</p>
                    ) : (
                      <div className="space-y-2">
                        {linkedMaterials.map(material => (
                          <div key={material.id} className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 rounded-lg bg-white p-2 border border-gray-100">
                            <div className="min-w-0">
                              <p className="text-sm font-bold text-gray-900 truncate">{material.material_name}</p>
                              <p className="text-xs text-gray-500">{material.quantity || '-'} {material.unit || ''} · {material.supplier || 'No supplier'} · {material.expected_delivery ? `ETA ${format(new Date(material.expected_delivery), 'MMM d')}` : 'No ETA'}</p>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${materialColors[material.order_status] || materialColors.planned}`}>{String(material.order_status).replace(/_/g, ' ')}</span>
                              <span className="text-sm font-black text-gray-900">${Number(material.actual_cost || material.estimated_cost || 0).toLocaleString('en-US')}</span>
                              {canManage && (
                                <select value={material.order_status} onChange={e => updateMaterial(material, { order_status: e.target.value })} className="px-2 py-1 rounded-lg border border-gray-300 text-xs bg-white">
                                  {['planned', 'quote_requested', 'ordered', 'waiting', 'delivered', 'installed', 'cancelled'].map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
                                </select>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PunchListTab({ projectId, user }: { projectId: string; user: any }) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState('');
  const [expandedItem, setExpandedItem] = useState<string | null>(null);
  const [uploadingItemPhoto, setUploadingItemPhoto] = useState<string | null>(null);
  const { register, handleSubmit, reset, formState: { isSubmitting } } = useForm();

  const load = async () => {
    try {
      const params = filter ? `?status=${filter}` : '';
      const res = await api.get(`/projects/${projectId}/punch-list${params}`);
      setItems(res.data);
    } catch (err) { } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [filter]);

  const onAdd = async (data: any) => {
    try {
      await api.post(`/projects/${projectId}/punch-list`, data);
      toast.success('Item added');
      setShowAdd(false);
      reset();
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to add item');
    }
  };

  const updateStatus = async (itemId: string, status: string) => {
    try {
      await api.put(`/projects/${projectId}/punch-list/${itemId}`, { status });
      load();
    } catch (err) { toast.error('Failed to update'); }
  };

  const uploadItemPhoto = async (itemId: string, files?: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploadingItemPhoto(itemId);
    try {
      const formData = new FormData();
      Array.from(files).forEach(file => formData.append('photos', file));
      formData.append('punch_list_item_id', itemId);
      formData.append('caption', 'Punch list item photo');
      await api.post(`/projects/${projectId}/photos`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success(`${files.length} punch list photo${files.length === 1 ? '' : 's'} uploaded`);
      load();
    } catch {
      toast.error('Failed to upload punch list photo');
    } finally {
      setUploadingItemPhoto(null);
    }
  };

  const priorityColors: Record<string, string> = { low: 'bg-gray-100 text-gray-600', medium: 'bg-blue-100 text-blue-700', high: 'bg-orange-100 text-orange-700', urgent: 'bg-red-100 text-red-700' };
  const statusColors: Record<string, string> = { not_started: 'bg-gray-100 text-gray-600', in_progress: 'bg-blue-100 text-blue-700', waiting_materials: 'bg-orange-100 text-orange-700', needs_review: 'bg-purple-100 text-purple-700', completed: 'bg-green-100 text-green-700' };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <div className="flex gap-1 flex-1 overflow-x-auto">
          {[['', 'All'], ['not_started', 'Open'], ['in_progress', 'In Progress'], ['completed', 'Done'], ['urgent', 'Urgent']].map(([val, label]) => (
            <button key={val} onClick={() => setFilter(val)} className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${filter === val ? 'bg-blue-600 text-white' : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-50'}`}>{label}</button>
          ))}
        </div>
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 transition-colors flex-shrink-0">
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
      </div>

      {loading ? <Loading /> : (
        <div className="space-y-2">
          {items.map(item => (
            <div key={item.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="p-4 flex items-start gap-3">
                <button
                  onClick={() => updateStatus(item.id, item.status === 'completed' ? 'not_started' : 'completed')}
                  className={`w-5 h-5 rounded-full border-2 flex-shrink-0 mt-0.5 transition-colors ${item.status === 'completed' ? 'bg-green-500 border-green-500' : 'border-gray-300 hover:border-green-400'}`}
                >
                  {item.status === 'completed' && <svg className="w-full h-full text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                </button>
                <div className="flex-1 min-w-0" onClick={() => setExpandedItem(expandedItem === item.id ? null : item.id)}>
                  <div className="flex items-start justify-between gap-2">
                    <p className={`text-sm font-medium ${item.status === 'completed' ? 'line-through text-gray-400' : 'text-gray-900'}`}>{item.title}</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${priorityColors[item.priority]}`}>{item.priority}</span>
                  </div>
                  {item.description && <p className="text-xs text-gray-500 mt-0.5 truncate">{item.description}</p>}
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[item.status]}`}>{item.status.replace(/_/g, ' ')}</span>
                    {item.assigned_to_name && <span className="text-xs text-gray-500">→ {item.assigned_to_name}</span>}
                    {item.due_date && <span className="text-xs text-gray-400">{format(new Date(item.due_date), 'MMM d')}</span>}
                    {item.photo_count > 0 && <span className="text-xs text-blue-500">{item.photo_count} photos</span>}
                  </div>
                </div>
              </div>
              {expandedItem === item.id && (
                <div className="px-4 pb-4 border-t border-gray-100 pt-3">
                  {item.description && (
                    <div className="mb-3 rounded-lg bg-gray-50 p-3">
                      <p className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-1">Description</p>
                      <p className="text-sm text-gray-700 whitespace-pre-wrap">{item.description}</p>
                    </div>
                  )}
                  <div className="flex gap-2 flex-wrap">
                    {['not_started', 'in_progress', 'waiting_materials', 'needs_review', 'completed'].map(s => (
                      <button key={s} onClick={() => updateStatus(item.id, s)} className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${item.status === s ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{s.replace(/_/g, ' ')}</button>
                    ))}
                    <label className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold text-blue-700 bg-blue-50 border border-blue-100 cursor-pointer hover:bg-blue-100 transition-colors">
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        multiple
                        className="hidden"
                        disabled={uploadingItemPhoto === item.id}
                        onChange={e => {
                          uploadItemPhoto(item.id, e.target.files);
                          e.currentTarget.value = '';
                        }}
                      />
                      <Camera className="w-3.5 h-3.5" />
                      {uploadingItemPhoto === item.id ? 'Uploading...' : 'Add Photo'}
                    </label>
                  </div>
                  {item.notes && <p className="text-xs text-gray-600 mt-2 bg-gray-50 rounded-lg p-2">{item.notes}</p>}
                </div>
              )}
            </div>
          ))}
          {items.length === 0 && <div className="text-center py-12 bg-white rounded-xl border border-gray-200"><ClipboardList className="w-8 h-8 text-gray-300 mx-auto mb-2" /><p className="text-gray-400 text-sm">No punch list items</p></div>}
        </div>
      )}

      <Modal isOpen={showAdd} onClose={() => { setShowAdd(false); reset(); }} title="Add Punch List Item">
        <form onSubmit={handleSubmit(onAdd)} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Title *</label>
            <input {...register('title', { required: true })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Task title" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description *</label>
            <textarea {...register('description', { required: true })} rows={3} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" placeholder="Describe the work, issue, location, or materials needed..." />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
              <select {...register('priority')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Due Date</label>
              <input type="date" {...register('due_date')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea {...register('notes')} rows={2} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={() => { setShowAdd(false); reset(); }} className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">Add Item</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function PhotosTab({ projectId, user }: { projectId: string; user: any }) {
  const [photos, setPhotos] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; isVideo: boolean } | null>(null);
  const [showNewCat, setShowNewCat] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const groupedPhotos = groupMediaByDay(photos);

  const load = async () => {
    try {
      const [photosRes, catsRes] = await Promise.all([
        api.get(`/projects/${projectId}/photos?type=progress${selectedCategory ? `&category_id=${selectedCategory}` : ''}`),
        api.get(`/projects/${projectId}/photos/categories`),
      ]);
      setPhotos(photosRes.data);
      setCategories(catsRes.data);
    } catch (err) { } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [selectedCategory]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    setUploading(true);
    const formData = new FormData();
    Array.from(e.target.files).forEach(f => formData.append('photos', f));
    if (selectedCategory) formData.append('category_id', selectedCategory);
    formData.append('photo_type', 'progress');
    await appendProgressUploadAudit(formData, Array.from(e.target.files), Array.from(e.target.files).map(() => 'desktop'));
    try {
      await api.post(`/projects/${projectId}/photos?type=progress`, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(`${e.target.files.length} photo(s) uploaded`);
      load();
    } catch (err) {
      toast.error('Upload failed');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const addCategory = async () => {
    if (!newCatName.trim()) return;
    try {
      await api.post(`/projects/${projectId}/photos/categories`, { name: newCatName });
      setNewCatName('');
      setShowNewCat(false);
      load();
    } catch (err) { toast.error('Failed to add category'); }
  };

  return (
    <div className="space-y-4">
      {/* Upload button */}
      <label className={`flex items-center justify-center gap-2 py-3 border-2 border-dashed rounded-xl cursor-pointer transition-colors ${uploading ? 'border-blue-400 bg-blue-50' : 'border-gray-300 hover:border-blue-400 hover:bg-blue-50'}`}>
        <input type="file" multiple accept="image/*,video/*" onChange={handleUpload} className="hidden" disabled={uploading} />
        <Camera className="w-5 h-5 text-blue-500" />
        <span className="text-sm font-medium text-blue-600">{uploading ? 'Uploading...' : 'Upload Progress Pictures'}</span>
      </label>

      {/* Categories */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        <button onClick={() => setSelectedCategory('')} className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap flex-shrink-0 transition-colors ${!selectedCategory ? 'bg-blue-600 text-white' : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-50'}`}>All Photos ({photos.length})</button>
        {categories.map(cat => (
          <button key={cat.id} onClick={() => setSelectedCategory(cat.id)} className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap flex-shrink-0 transition-colors ${selectedCategory === cat.id ? 'bg-blue-600 text-white' : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-50'}`}>{cat.name} ({cat.photo_count})</button>
        ))}
        <button onClick={() => setShowNewCat(true)} className="px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap flex-shrink-0 bg-white border border-dashed border-gray-300 text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors">+ Category</button>
      </div>

      {showNewCat && (
        <div className="flex gap-2">
          <input value={newCatName} onChange={e => setNewCatName(e.target.value)} placeholder="Category name" className="flex-1 px-3.5 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" onKeyDown={e => e.key === 'Enter' && addCategory()} />
          <button onClick={addCategory} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">Add</button>
          <button onClick={() => setShowNewCat(false)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
        </div>
      )}

      {loading ? <Loading /> : (
        <div className="space-y-5">
          {groupedPhotos.map(group => (
            <section key={group.date} className="rounded-xl border border-gray-200 bg-white p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-black text-gray-900">{group.date}</h3>
                  <p className="text-xs font-semibold text-gray-500">{group.photos.length} item{group.photos.length === 1 ? '' : 's'} ordered by time taken</p>
                </div>
                <span className="rounded-full bg-blue-50 px-2 py-1 text-xs font-black text-blue-700">Historical record</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {group.photos.map(photo => {
                  const src = `/uploads/${projectId}/${photo.filename}`;
                  const isVideo = isVideoMedia(photo);
                  return (
                    <div key={photo.id} className="relative group aspect-square rounded-xl overflow-hidden bg-gray-100 cursor-pointer" onClick={() => setLightbox({ src, isVideo })}>
                      {isVideo ? (
                        <>
                          <video src={src} className="w-full h-full object-cover transition-transform group-hover:scale-105" muted playsInline preload="metadata" />
                          <PlayCircle className="absolute inset-0 m-auto h-10 w-10 text-white drop-shadow" />
                        </>
                      ) : (
                        <img src={src} alt={photo.original_name} className="w-full h-full object-cover transition-transform group-hover:scale-105" loading="lazy" />
                      )}
                      {photo.note_id && (
                        <span className="absolute left-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-black text-white">Note</span>
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-transparent opacity-100 transition-opacity" />
                      <div className="absolute bottom-0 left-0 right-0 p-2">
                        <p className="text-white text-xs font-bold truncate">{photo.uploader_name || 'Unknown user'}</p>
                        <p className="text-white/80 text-xs">{formatEasternDateTime(photo.taken_at || photo.created_at, { hour: 'numeric', minute: '2-digit' })}</p>
                        <p className="text-white/70 text-[10px] truncate">{photo.capture_latitude ? 'GPS recorded' : 'IP recorded'}{photo.upload_ip_address ? ` / ${photo.upload_ip_address}` : ''}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
          {photos.length === 0 && (
            <div className="col-span-full text-center py-12">
              <Camera className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="text-gray-400 text-sm">No photos yet</p>
            </div>
          )}
        </div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" onClick={() => setLightbox(null)}>
          {lightbox.isVideo ? (
            <video src={lightbox.src} controls autoPlay className="max-w-full max-h-full rounded-lg" onClick={event => event.stopPropagation()} />
          ) : (
            <img src={lightbox.src} alt="" className="max-w-full max-h-full object-contain rounded-lg" />
          )}
          <button className="absolute top-4 right-4 text-white/70 hover:text-white" onClick={() => setLightbox(null)}>
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      )}
    </div>
  );
}

function InvoicesTab({ projectId, user, project }: { projectId: string; user: any; project: any }) {
  const navigate = useNavigate();
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const res = await api.get(`/projects/${projectId}/invoices`);
      setInvoices(res.data);
    } catch (err) { } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const statusColors: Record<string, string> = { draft: 'bg-gray-100 text-gray-600', submitted: 'bg-blue-100 text-blue-700', reviewed: 'bg-yellow-100 text-yellow-700', approved: 'bg-green-100 text-green-700', paid: 'bg-emerald-100 text-emerald-700' };

  return (
    <div className="space-y-4">
      <button onClick={() => navigate(`/projects/${projectId}/invoices/new`)} className="w-full flex items-center justify-center gap-2 py-3.5 bg-blue-600 text-white rounded-xl font-semibold text-sm hover:bg-blue-700 transition-colors shadow-sm">
        <Plus className="w-5 h-5" /> CREATE INVOICE
      </button>

      {loading ? <Loading /> : (
        <div className="space-y-3">
          {invoices.map(inv => (
            <div key={inv.id} className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-purple-100 rounded-xl flex items-center justify-center flex-shrink-0">
                <FileText className="w-5 h-5 text-purple-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-gray-900 text-sm">#{inv.invoice_number}</p>
                <p className="text-xs text-gray-500">{inv.contractor_name} · {formatEasternDate(inv.created_at, { month: 'short', day: 'numeric', year: 'numeric' })}</p>
              </div>
              <div className="text-right">
                <p className="font-bold text-gray-900">${Number(inv.total).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[inv.status]}`}>{inv.status}</span>
              </div>
            </div>
          ))}
          {invoices.length === 0 && <div className="text-center py-12 bg-white rounded-xl border border-gray-200"><FileText className="w-8 h-8 text-gray-300 mx-auto mb-2" /><p className="text-gray-400 text-sm">No invoices yet</p></div>}
        </div>
      )}
    </div>
  );
}

type ProjectQuoteCategory = {
  id: string;
  category_group: string;
  name: string;
};

type ProjectQuoteLineForm = {
  category: string;
  subcategory: string;
  description: string;
  quantity: string;
  unit: string;
  unit_price: string;
  total_line_item_price: string;
  labor_amount: string;
  material_amount: string;
};

type ProjectQuoteForm = {
  contractor_name: string;
  contractor_address: string;
  contractor_phone: string;
  contractor_email: string;
  quote_date: string;
  status: string;
  scope_description: string;
  notes: string;
  total_quote_amount: string;
};

const projectQuoteStatuses = ['draft', 'submitted', 'approved', 'rejected', 'paid', 'completed', 'historical'];

const blankProjectQuoteForm = (): ProjectQuoteForm => ({
  contractor_name: '',
  contractor_address: '',
  contractor_phone: '',
  contractor_email: '',
  quote_date: format(new Date(), 'yyyy-MM-dd'),
  status: 'submitted',
  scope_description: '',
  notes: '',
  total_quote_amount: '',
});

const blankProjectQuoteLineItem = (category = ''): ProjectQuoteLineForm => ({
  category,
  subcategory: '',
  description: '',
  quantity: '1',
  unit: '',
  unit_price: '',
  total_line_item_price: '',
  labor_amount: '',
  material_amount: '',
});

const quoteNumberValue = (value: number | string | null | undefined) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const quoteMoney = (value: number | string | null | undefined) =>
  quoteNumberValue(value).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const quoteStatusLabel = (status: string) =>
  String(status || '').replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());

function QuotesTab({ projectId, project }: { projectId: string; project: any }) {
  const navigate = useNavigate();
  const [quotes, setQuotes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [quoteOptions, setQuoteOptions] = useState<{ categories: ProjectQuoteCategory[]; statuses: string[] }>({
    categories: [],
    statuses: projectQuoteStatuses,
  });
  const [showAddQuote, setShowAddQuote] = useState(false);
  const [savingQuote, setSavingQuote] = useState(false);
  const [quoteFile, setQuoteFile] = useState<File | null>(null);
  const [quoteForm, setQuoteForm] = useState<ProjectQuoteForm>(() => blankProjectQuoteForm());
  const [quoteLineItems, setQuoteLineItems] = useState<ProjectQuoteLineForm[]>(() => [blankProjectQuoteLineItem()]);

  const load = async () => {
    try {
      const res = await api.get(`/projects/${projectId}/quotes`);
      setQuotes(Array.isArray(res.data?.quotes) ? res.data.quotes : []);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to load project quotes');
    } finally {
      setLoading(false);
    }
  };

  const loadQuoteOptions = async () => {
    try {
      const res = await api.get('/quote-analytics/options');
      setQuoteOptions({
        categories: Array.isArray(res.data?.categories) ? res.data.categories : [],
        statuses: Array.isArray(res.data?.statuses) && res.data.statuses.length > 0 ? res.data.statuses : projectQuoteStatuses,
      });
    } catch {
      setQuoteOptions(current => ({ ...current, statuses: projectQuoteStatuses }));
    }
  };

  useEffect(() => {
    setLoading(true);
    load();
    loadQuoteOptions();
  }, [projectId]);

  useEffect(() => {
    if (quoteOptions.categories.length === 0) return;
    setQuoteLineItems(current => {
      if (current.length !== 1 || current[0].category) return current;
      return [blankProjectQuoteLineItem(quoteOptions.categories[0].name)];
    });
  }, [quoteOptions.categories]);

  const categoriesByGroup = useMemo(() => {
    const groups = new Map<string, ProjectQuoteCategory[]>();
    for (const category of quoteOptions.categories) {
      const group = category.category_group || 'Other';
      groups.set(group, [...(groups.get(group) || []), category]);
    }
    return Array.from(groups.entries());
  }, [quoteOptions.categories]);

  const totalQuoted = quotes.reduce((sum, quote) => sum + quoteNumberValue(quote.total_quote_amount), 0);
  const contractors = new Set(quotes.map(quote => quote.contractor_company || quote.contractor_name).filter(Boolean));
  const categories = new Set(quotes.flatMap(quote => (quote.line_items || []).map((item: any) => item.category)).filter(Boolean));
  const calculatedLineTotal = quoteLineItems.reduce((sum, item) => sum + quoteNumberValue(item.total_line_item_price), 0);
  const defaultCategory = quoteOptions.categories[0]?.name || '';
  const statusColors: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-600',
    submitted: 'bg-blue-100 text-blue-700',
    approved: 'bg-green-100 text-green-700',
    rejected: 'bg-red-100 text-red-700',
    paid: 'bg-emerald-100 text-emerald-700',
    completed: 'bg-purple-100 text-purple-700',
    historical: 'bg-amber-100 text-amber-700',
  };

  const categoryTotals = useMemo(() => {
    const totals = new Map<string, { category: string; total: number; count: number }>();
    for (const quote of quotes) {
      for (const item of quote.line_items || []) {
        const category = item.category || 'Uncategorized';
        const current = totals.get(category) || { category, total: 0, count: 0 };
        current.total += quoteNumberValue(item.total_line_item_price);
        current.count += 1;
        totals.set(category, current);
      }
    }
    return Array.from(totals.values()).sort((a, b) => b.total - a.total);
  }, [quotes]);

  const resetQuoteForm = () => {
    setQuoteForm(blankProjectQuoteForm());
    setQuoteLineItems([blankProjectQuoteLineItem(defaultCategory)]);
    setQuoteFile(null);
  };

  const updateQuoteLineItem = (index: number, patch: Partial<ProjectQuoteLineForm>) => {
    setQuoteLineItems(current => current.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      const next = { ...item, ...patch };
      if ((patch.quantity !== undefined || patch.unit_price !== undefined) && !String(next.total_line_item_price || '').trim()) {
        next.total_line_item_price = String((quoteNumberValue(next.quantity) || 1) * quoteNumberValue(next.unit_price));
      }
      return next;
    }));
  };

  const submitProjectQuote = async () => {
    if (!quoteForm.contractor_name.trim()) return toast.error("Enter the contractor's name");

    const lineItems = quoteLineItems
      .map(item => ({
        ...item,
        description: item.description.trim() || item.category || 'Quote line item',
        quantity: item.quantity || '1',
      }))
      .filter(item => item.category || item.total_line_item_price);

    if (lineItems.length === 0 || lineItems.some(item => !item.category || quoteNumberValue(item.total_line_item_price) <= 0)) {
      return toast.error('Each quote line needs a category and price');
    }

    setSavingQuote(true);
    try {
      const payload = {
        ...quoteForm,
        total_quote_amount: quoteForm.total_quote_amount || String(calculatedLineTotal),
        line_items: lineItems,
      };

      if (quoteFile) {
        const body = new FormData();
        Object.entries(payload).forEach(([key, value]) => {
          body.append(key, key === 'line_items' ? JSON.stringify(value) : String(value ?? ''));
        });
        body.append('quote_file', quoteFile);
        await api.post(`/projects/${projectId}/quotes/upload`, body, { headers: { 'Content-Type': 'multipart/form-data' } });
      } else {
        await api.post(`/projects/${projectId}/quotes`, payload);
      }

      toast.success('Quote saved to this project and master analytics');
      resetQuoteForm();
      setShowAddQuote(false);
      await load();
    } catch (err: any) {
      const errors = err.response?.data?.errors;
      toast.error(Array.isArray(errors) ? errors[0] : err.response?.data?.error || 'Failed to save quote');
    } finally {
      setSavingQuote(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Quotes Uploaded', value: quotes.length },
          { label: 'Quoted Value', value: quoteMoney(totalQuoted) },
          { label: 'Contractors', value: contractors.size },
          { label: 'Categories', value: categories.size },
        ].map(item => (
          <div key={item.label} className="bg-white rounded-xl border border-gray-200 p-4">
            <p className="text-2xl font-bold text-blue-600">{item.value}</p>
            <p className="text-xs text-gray-500 mt-0.5">{item.label}</p>
          </div>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setShowAddQuote(current => !current)}
          className="w-full flex items-center justify-center gap-2 py-3.5 bg-blue-600 text-white rounded-xl font-semibold text-sm hover:bg-blue-700 transition-colors shadow-sm"
        >
          <Plus className="w-5 h-5" /> ADD QUOTE TO THIS PROJECT
        </button>
        <button
          type="button"
          onClick={() => navigate(`/data-analytics?project=${projectId}`)}
          className="w-full flex items-center justify-center gap-2 py-3.5 bg-white border border-gray-200 text-gray-700 rounded-xl font-semibold text-sm hover:bg-gray-50 transition-colors"
        >
          <Activity className="w-5 h-5" /> VIEW PROPERTY QUOTE ANALYTICS
        </button>
      </div>

      {showAddQuote && (
        <div className="bg-white rounded-xl border border-blue-100 p-4" style={{ boxShadow: '0 8px 28px rgba(37,99,235,0.08)' }}>
          <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3 mb-4">
            <div>
              <h3 className="text-base font-black text-gray-900">Upload Quote For This Project</h3>
              <p className="text-sm text-gray-500 mt-1">{project?.address} - quote data will also feed Data Analytics.</p>
            </div>
            <button type="button" onClick={() => { resetQuoteForm(); setShowAddQuote(false); }} className="px-3 py-2 rounded-xl text-xs font-black bg-gray-100 text-gray-600 hover:bg-gray-200">
              Close
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
            <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-black uppercase tracking-wide text-gray-500 mb-1">Contractor Name *</label>
                <input value={quoteForm.contractor_name} onChange={e => setQuoteForm(current => ({ ...current, contractor_name: e.target.value }))} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs font-black uppercase tracking-wide text-gray-500 mb-1">Phone Number</label>
                <input value={quoteForm.contractor_phone} onChange={e => setQuoteForm(current => ({ ...current, contractor_phone: e.target.value }))} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-black uppercase tracking-wide text-gray-500 mb-1">Contractor Address</label>
                <input value={quoteForm.contractor_address} onChange={e => setQuoteForm(current => ({ ...current, contractor_address: e.target.value }))} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs font-black uppercase tracking-wide text-gray-500 mb-1">Email Address</label>
                <input type="email" value={quoteForm.contractor_email} onChange={e => setQuoteForm(current => ({ ...current, contractor_email: e.target.value }))} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs font-black uppercase tracking-wide text-gray-500 mb-1">Quote Date</label>
                <input type="date" value={quoteForm.quote_date} onChange={e => setQuoteForm(current => ({ ...current, quote_date: e.target.value }))} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>

            <div>
              <label className="block text-xs font-black uppercase tracking-wide text-gray-500 mb-1">Status</label>
              <select value={quoteForm.status} onChange={e => setQuoteForm(current => ({ ...current, status: e.target.value }))} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                {quoteOptions.statuses.map(status => <option key={status} value={status}>{quoteStatusLabel(status)}</option>)}
              </select>
              <label className="block text-xs font-black uppercase tracking-wide text-gray-500 mt-3 mb-1">Total Quote</label>
              <input value={quoteForm.total_quote_amount} onChange={e => setQuoteForm(current => ({ ...current, total_quote_amount: e.target.value }))} placeholder={quoteMoney(calculatedLineTotal)} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <label className="mt-3 flex items-center justify-center gap-2 px-3 py-3 rounded-xl border border-dashed border-gray-300 text-sm font-black text-gray-600 cursor-pointer hover:bg-gray-50">
                <FileText className="w-4 h-4" />
                {quoteFile ? quoteFile.name : 'Attach quote document'}
                <input type="file" className="hidden" onChange={e => setQuoteFile(e.target.files?.[0] || null)} />
              </label>
            </div>

            <div>
              <label className="block text-xs font-black uppercase tracking-wide text-gray-500 mb-1">Scope</label>
              <textarea value={quoteForm.scope_description} onChange={e => setQuoteForm(current => ({ ...current, scope_description: e.target.value }))} rows={3} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <label className="block text-xs font-black uppercase tracking-wide text-gray-500 mt-3 mb-1">Notes</label>
              <textarea value={quoteForm.notes} onChange={e => setQuoteForm(current => ({ ...current, notes: e.target.value }))} rows={3} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>

          <div className="mt-5">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <h4 className="text-sm font-black text-gray-900">Quote Categories And Prices</h4>
                <p className="text-xs text-gray-500">Add one row per category, scope, or line item in the contractor quote.</p>
              </div>
              <button type="button" onClick={() => setQuoteLineItems(current => [...current, blankProjectQuoteLineItem(defaultCategory)])} className="px-3 py-2 rounded-xl text-xs font-black text-blue-700 bg-blue-50 hover:bg-blue-100">
                Add Category
              </button>
            </div>

            <div className="space-y-2">
              {quoteLineItems.map((item, index) => (
                <div key={index} className="grid grid-cols-1 md:grid-cols-12 gap-2">
                  <select value={item.category} onChange={e => updateQuoteLineItem(index, { category: e.target.value })} className="md:col-span-3 px-3 py-2.5 rounded-lg border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="">Category *</option>
                    {categoriesByGroup.map(([group, groupCategories]) => (
                      <optgroup key={group} label={group}>
                        {groupCategories.map(category => <option key={category.id} value={category.name}>{category.name}</option>)}
                      </optgroup>
                    ))}
                  </select>
                  <input value={item.description} onChange={e => updateQuoteLineItem(index, { description: e.target.value })} placeholder="Line item description" className="md:col-span-3 px-3 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <input value={item.quantity} onChange={e => updateQuoteLineItem(index, { quantity: e.target.value })} placeholder="Qty" className="md:col-span-1 px-3 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <input value={item.unit} onChange={e => updateQuoteLineItem(index, { unit: e.target.value })} placeholder="Unit" className="md:col-span-1 px-3 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <input value={item.unit_price} onChange={e => updateQuoteLineItem(index, { unit_price: e.target.value })} placeholder="Unit price" className="md:col-span-2 px-3 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <div className="md:col-span-2 flex gap-2">
                    <input value={item.total_line_item_price} onChange={e => updateQuoteLineItem(index, { total_line_item_price: e.target.value })} placeholder="Line price *" className="w-full px-3 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    {quoteLineItems.length > 1 && (
                      <button type="button" onClick={() => setQuoteLineItems(current => current.filter((_, itemIndex) => itemIndex !== index))} className="px-3 rounded-lg bg-red-50 text-red-700 hover:bg-red-100">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mt-5 pt-4 border-t border-gray-100">
            <p className="text-sm text-gray-600">Line item total: <span className="font-black text-gray-900">{quoteMoney(calculatedLineTotal)}</span></p>
            <div className="flex gap-2">
              <button type="button" onClick={resetQuoteForm} className="px-4 py-2.5 rounded-xl text-sm font-black bg-gray-100 text-gray-700 hover:bg-gray-200">Clear</button>
              <button type="button" disabled={savingQuote} onClick={submitProjectQuote} className="px-4 py-2.5 rounded-xl text-sm font-black bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-60">
                {savingQuote ? 'Saving...' : 'Save Quote To Project'}
              </button>
            </div>
          </div>
        </div>
      )}

      {categoryTotals.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <h3 className="text-sm font-black text-gray-900">Category Pricing On This Project</h3>
              <p className="text-xs text-gray-500">Aggregated from the quote line items below.</p>
            </div>
            <span className="text-xs font-black text-gray-400">{categoryTotals.length} categories</span>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
            {categoryTotals.slice(0, 12).map(item => (
              <div key={item.category} className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                <p className="text-sm font-black text-gray-900 truncate">{item.category}</p>
                <p className="text-lg font-black text-blue-700 mt-1">{quoteMoney(item.total)}</p>
                <p className="text-xs text-gray-500">{item.count} line items</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading ? <Loading /> : (
        <div className="space-y-3">
          {quotes.map(quote => {
            const lineItems = Array.isArray(quote.line_items) ? quote.line_items : [];
            return (
              <div key={quote.id} className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-black text-gray-900 text-sm">{quote.quote_number}</p>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-black ${statusColors[quote.status] || 'bg-gray-100 text-gray-700'}`}>
                        {quoteStatusLabel(quote.status)}
                      </span>
                      <span className="text-xs text-gray-400">{quote.quote_date}</span>
                    </div>
                    <div className="grid md:grid-cols-2 gap-2 mt-3 text-sm">
                      <div>
                        <p className="text-xs font-black uppercase tracking-wide text-gray-400">Contractor</p>
                        <p className="font-black text-gray-900">{quote.contractor_company || quote.contractor_name}</p>
                        {quote.contractor_name && quote.contractor_company && quote.contractor_name !== quote.contractor_company && <p className="text-xs text-gray-500">{quote.contractor_name}</p>}
                      </div>
                      <div>
                        <p className="text-xs font-black uppercase tracking-wide text-gray-400">Contact</p>
                        <p className="text-gray-700">{quote.contractor_phone || 'No phone'} - {quote.contractor_email || 'No email'}</p>
                        {quote.contractor_address && <p className="text-xs text-gray-500 mt-0.5">{quote.contractor_address}</p>}
                      </div>
                    </div>
                    {(quote.scope_description || quote.notes) && (
                      <div className="mt-3 rounded-lg bg-gray-50 p-3">
                        {quote.scope_description && <p className="text-sm text-gray-800">{quote.scope_description}</p>}
                        {quote.notes && <p className="text-xs text-gray-500 mt-1">{quote.notes}</p>}
                      </div>
                    )}
                  </div>
                  <div className="text-left lg:text-right flex-shrink-0">
                    <p className="text-2xl font-black text-gray-900">{quoteMoney(quote.total_quote_amount)}</p>
                    <p className="text-xs text-gray-500 mt-1">Total quote price</p>
                    {quote.document_download_url && (
                      <a href={quote.document_download_url} className="inline-flex mt-2 text-xs font-bold text-blue-700 hover:underline">
                        Download quote
                      </a>
                    )}
                  </div>
                </div>

                <div className="mt-4 overflow-x-auto rounded-lg border border-gray-100">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead className="bg-gray-50">
                      <tr className="text-left text-xs uppercase tracking-wide text-gray-400">
                        <th className="py-2.5 px-3">Category</th>
                        <th className="py-2.5 px-3">Description</th>
                        <th className="py-2.5 px-3 text-right">Qty</th>
                        <th className="py-2.5 px-3">Unit</th>
                        <th className="py-2.5 px-3 text-right">Unit Price</th>
                        <th className="py-2.5 px-3 text-right">Line Price</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {lineItems.map((item: any, index: number) => (
                        <tr key={item.id || `${quote.id}-${index}`}>
                          <td className="py-2.5 px-3 font-black text-gray-900">{item.category || '-'}</td>
                          <td className="py-2.5 px-3 text-gray-700">{item.description || item.subcategory || '-'}</td>
                          <td className="py-2.5 px-3 text-right">{quoteNumberValue(item.quantity).toLocaleString('en-US')}</td>
                          <td className="py-2.5 px-3 text-gray-600">{item.unit || '-'}</td>
                          <td className="py-2.5 px-3 text-right">{quoteMoney(item.unit_price)}</td>
                          <td className="py-2.5 px-3 text-right font-black text-gray-900">{quoteMoney(item.total_line_item_price)}</td>
                        </tr>
                      ))}
                      {lineItems.length === 0 && (
                        <tr>
                          <td colSpan={6} className="py-6 text-center text-sm text-gray-400">No line items stored for this quote</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
          {quotes.length === 0 && (
            <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
              <FileText className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="text-gray-400 text-sm">No quotes uploaded for this property yet</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
