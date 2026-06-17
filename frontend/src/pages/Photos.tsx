import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../lib/api';
import { Loading } from '../components/ui';
import { Camera, FileImage, Grid, List, MessageSquare, PlayCircle, Trash2, X } from 'lucide-react';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { fileDropHandlers } from '../lib/fileDrop';
import { appendProgressUploadAudit, PROGRESS_MEDIA_ACCEPT } from '../lib/progressUpload';
import { getProgressMediaKind } from '../lib/progressMedia';
import VoiceTextarea from '../components/VoiceTextarea';

type PhotoView = 'general' | 'progress' | 'scope';

interface Photo {
  id: string;
  filename: string;
  original_name: string;
  caption: string;
  uploader_name: string;
  category_name: string;
  created_at: string;
  taken_at?: string;
  mime_type?: string;
  project_id: string;
  project_address?: string;
  note_id?: string | null;
  note_text?: string | null;
  individual_note?: string | null;
  batch_note?: string | null;
  note_user_name?: string | null;
  upload_ip_address?: string | null;
  gps_latitude?: number | null;
  gps_longitude?: number | null;
  gps_accuracy?: number | null;
  capture_latitude?: number | null;
  capture_longitude?: number | null;
  capture_accuracy?: number | null;
  capture_source?: string | null;
  uploaded_by?: string;
  uploaded_by_name?: string;
  photo_type?: string;
  show_in_progress?: number | boolean;
  show_in_scope?: number | boolean;
  can_delete_correction?: boolean;
  correction_locked?: boolean;
  correction_delete_count?: number;
}

interface LightboxMedia {
  src: string;
  isVideo: boolean;
}

const PHOTO_VIEW_META: Record<PhotoView, { label: string; type: string; uploadType: 'general' | 'progress' | 'scope'; caption: string }> = {
  general: {
    label: 'General Bucket',
    type: 'general',
    uploadType: 'general',
    caption: 'All project photos',
  },
  progress: {
    label: 'Photos',
    type: 'progress',
    uploadType: 'progress',
    caption: 'Project photo bucket',
  },
  scope: {
    label: 'Scope of Work',
    type: 'scope',
    uploadType: 'scope',
    caption: 'Scope reference photos',
  },
};

function normalizePhotoView(value: string | null): PhotoView {
  return value === 'general' || value === 'scope' ? value : 'progress';
}

function mediaLabel(count: number, photoView: PhotoView) {
  const noun = photoView === 'scope' ? 'scope item' : photoView === 'general' ? 'project photo' : 'photo item';
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function isPhotoContextEnabled(value: number | boolean | undefined, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  return fallback;
}

function UnsupportedMediaTile({ name }: { name?: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center bg-gray-50 p-3 text-center">
      <FileImage className="mb-2 h-8 w-8 text-gray-400" />
      <p className="max-w-full truncate text-xs font-black text-gray-700">{name || 'Media file'}</p>
      <p className="mt-1 text-[10px] font-bold uppercase tracking-wide text-amber-700">Open file</p>
    </div>
  );
}

function groupPhotosByDay(photos: Photo[]) {
  return photos.reduce<{ date: string; photos: Photo[] }[]>((groups, photo) => {
    const date = format(new Date(photo.taken_at || photo.created_at), 'EEEE, MMMM d, yyyy');
    const last = groups[groups.length - 1];
    if (last && last.date === date) last.photos.push(photo);
    else groups.push({ date, photos: [photo] });
    return groups;
  }, []);
}

function photoBelongsToProject(photo: Photo, projectId: string) {
  return String(photo?.project_id || '') === String(projectId || '');
}

function getPhotoDescriptionText(photo?: Photo | null) {
  return String(photo?.individual_note || photo?.caption || photo?.note_text || '').trim();
}

function formatPhotoGpsAudit(photo: Photo) {
  const latitude = Number(photo.gps_latitude ?? photo.capture_latitude);
  const longitude = Number(photo.gps_longitude ?? photo.capture_longitude);
  const hasValidCoordinates = Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && Math.abs(latitude) <= 90
    && Math.abs(longitude) <= 180
    && !(Math.abs(latitude) < 0.00001 && Math.abs(longitude) < 0.00001);
  if (!hasValidCoordinates) return 'GPS not verified';
  const accuracy = Number(photo.gps_accuracy ?? photo.capture_accuracy);
  const accuracyLabel = Number.isFinite(accuracy) ? ` +/- ${Math.round(accuracy)}m` : '';
  return `GPS verified: ${latitude.toFixed(5)}, ${longitude.toFixed(5)}${accuracyLabel}`;
}

function formatPhotoIpAudit(photo: Photo) {
  const ipAddress = String(photo.upload_ip_address || '').trim();
  return ipAddress ? `IP: ${ipAddress}` : 'IP not recorded';
}

export default function Photos() {
  const [searchParams] = useSearchParams();
  const requestedProjectId = searchParams.get('projectId') || '';
  const requestedPhotoView = normalizePhotoView(searchParams.get('type'));
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [photoView, setPhotoView] = useState<PhotoView>(requestedPhotoView);
  const [lightbox, setLightbox] = useState<LightboxMedia | null>(null);
  const [selectedProject, setSelectedProject] = useState(requestedProjectId);
  const [caption, setCaption] = useState('');
  const [deletingPhotoId, setDeletingPhotoId] = useState('');
  const [descriptionPhoto, setDescriptionPhoto] = useState<Photo | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadSequenceRef = useRef(0);
  const groupedPhotos = groupPhotosByDay(photos);

  const load = async () => {
    const loadSequence = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadSequence;
    const requestProjectId = selectedProject;
    const requestPhotoView = photoView;
    setLoading(true);
    try {
      const projRes = await api.get('/projects');
      if (loadSequenceRef.current !== loadSequence) return;
      setProjects(projRes.data);

      const allPhotos: Photo[] = [];
      const projectsToLoad = requestProjectId
        ? projRes.data.filter((p: any) => p.id === requestProjectId)
        : projRes.data;

      for (const proj of projectsToLoad) {
        try {
          const res = await api.get(`/projects/${proj.id}/photos?type=${PHOTO_VIEW_META[requestPhotoView].type}`);
          if (loadSequenceRef.current !== loadSequence) return;
          res.data.forEach((photo: Photo) => {
            allPhotos.push({ ...photo, project_address: proj.address });
          });
        } catch (err) {}
      }
      const scopedPhotos = requestProjectId
        ? allPhotos.filter(photo => photoBelongsToProject(photo, requestProjectId))
        : allPhotos;
      setPhotos(scopedPhotos.sort((a, b) => new Date(b.taken_at || b.created_at).getTime() - new Date(a.taken_at || a.created_at).getTime()));
    } catch (err) {
      console.error(err);
      toast.error('Failed to load project photos');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setPhotos([]);
    setLightbox(null);
    load();
  }, [selectedProject, photoView]);

  useEffect(() => {
    if (requestedProjectId && requestedProjectId !== selectedProject) {
      setSelectedProject(requestedProjectId);
    }
  }, [requestedProjectId, selectedProject]);

  useEffect(() => {
    setPhotoView(current => current === requestedPhotoView ? current : requestedPhotoView);
  }, [requestedPhotoView]);

  const uploadMedia = async (files?: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    if (!selectedProject) {
      toast.error('Select a project before uploading photos or videos');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      const uploadFiles = Array.from(files);
      const uploadType = PHOTO_VIEW_META[photoView].uploadType;
      const contexts = photoView === 'scope'
        ? ['general', 'scope']
        : photoView === 'general'
          ? ['general']
          : ['general', 'progress'];
      uploadFiles.forEach(file => formData.append('photos', file));
      if (caption.trim()) formData.append('caption', caption.trim());
      formData.append('photo_type', uploadType);
      formData.append('photo_contexts', JSON.stringify(contexts));
      await appendProgressUploadAudit(formData, uploadFiles, uploadFiles.map(() => 'desktop'), { projectId: selectedProject });

      await api.post(`/projects/${selectedProject}/photos?type=${uploadType}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success(`${uploadFiles.length} ${photoView === 'scope' ? 'scope' : 'project'} item${uploadFiles.length === 1 ? '' : 's'} uploaded`);
      setCaption('');
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const openMedia = (photo: Photo) => {
    const kind = getProgressMediaKind(photo);
    const src = `/uploads/${photo.project_id}/${photo.filename}`;
    if (kind === 'file') {
      window.open(src, '_blank', 'noopener,noreferrer');
      return;
    }
    setLightbox({
      src,
      isVideo: kind === 'video',
    });
  };

  const deleteProgressPhoto = async (photo: Photo) => {
    if (!photo.can_delete_correction || deletingPhotoId) return;
    const confirmed = window.confirm('Remove this uploaded project picture? This uses your one correction and then locks this upload record.');
    if (!confirmed) return;
    setDeletingPhotoId(photo.id);
    try {
      await api.delete(`/projects/${photo.project_id}/photos/${photo.id}`);
      toast.success('Project picture removed. Correction is now locked.');
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to delete project picture');
    } finally {
      setDeletingPhotoId('');
    }
  };

  const updatePhotoContexts = async (photo: Photo, next: { progress?: boolean; scope?: boolean }) => {
    const currentProgress = isPhotoContextEnabled(photo.show_in_progress, photo.photo_type === 'progress' || photo.photo_type === 'note');
    const currentScope = isPhotoContextEnabled(photo.show_in_scope, photo.photo_type === 'scope' || photo.photo_type === 'construction_plan');
    try {
      await api.put(`/projects/${photo.project_id}/photos/${photo.id}/contexts`, {
        show_in_progress: next.progress ?? currentProgress,
        show_in_scope: next.scope ?? currentScope,
      });
      toast.success('Photo usage updated');
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update photo usage');
    }
  };

  const handleDescriptionSaved = async (updatedPhoto: Photo) => {
    setDescriptionPhoto(null);
    setPhotos(current => current.map(photo => (
      photo.id === updatedPhoto.id
        ? { ...photo, ...updatedPhoto, project_address: photo.project_address || updatedPhoto.project_address }
        : photo
    )));
    await load();
  };

  const uploadDropHandlers = fileDropHandlers(uploadMedia, {
    accept: PROGRESS_MEDIA_ACCEPT,
    disabled: !selectedProject || uploading,
    multiple: true,
  });

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <div className="flex flex-col gap-3 mb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Project Photo Library</h1>
          <p className="text-sm text-gray-500 mt-0.5">{mediaLabel(photos.length, photoView)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!selectedProject || uploading}
            {...uploadDropHandlers}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-black text-white shadow-sm transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400"
          >
            <Camera className="h-4 w-4" />
            {uploading ? 'Uploading...' : `Upload or Drop ${photoView === 'scope' ? 'Scope' : 'Project'} Pictures`}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={PROGRESS_MEDIA_ACCEPT}
            disabled={!selectedProject || uploading}
            onChange={e => uploadMedia(e.target.files)}
            className="hidden"
          />
          <button onClick={() => setView('grid')} className={`min-h-11 min-w-11 p-2 rounded-lg transition-colors ${view === 'grid' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-100'}`} aria-label="Show photo grid">
            <Grid className="w-4 h-4" />
          </button>
          <button onClick={() => setView('list')} className={`min-h-11 min-w-11 p-2 rounded-lg transition-colors ${view === 'list' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-100'}`} aria-label="Show photo list">
            <List className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="mb-5 grid gap-3 lg:grid-cols-[minmax(260px,380px)_1fr]">
        <select value={selectedProject} onChange={e => setSelectedProject(e.target.value)} className="w-full px-3.5 py-2.5 rounded-xl border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">All Projects</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.address}</option>)}
        </select>

        <div className="rounded-xl border border-gray-200 bg-white p-3">
          <div className="mb-3 grid gap-2 sm:grid-cols-3">
            {(Object.keys(PHOTO_VIEW_META) as PhotoView[]).map(option => (
              <button
                key={option}
                type="button"
                onClick={() => setPhotoView(option)}
                className={`min-h-11 rounded-lg border px-3 py-2 text-left text-xs font-black transition ${photoView === option ? 'border-amber-300 bg-amber-50 text-amber-800 shadow-sm' : 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-white'}`}
              >
                <span className="block">{PHOTO_VIEW_META[option].label}</span>
                <span className="mt-0.5 block text-[10px] font-bold opacity-75">{PHOTO_VIEW_META[option].caption}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={caption}
              onChange={e => setCaption(e.target.value)}
              placeholder="Optional caption for this upload"
              className="min-w-0 flex-1 px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <p className="text-xs text-gray-500 mt-2">
            {selectedProject ? 'Media will be hosted once under the selected project and can be reused for progress, scope, or both.' : 'Select a project to add project photos or videos.'}
          </p>
        </div>
      </div>

      {loading ? <Loading /> : (
        photos.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
            <Camera className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500 font-medium">No {photoView === 'scope' ? 'scope photos' : photoView === 'general' ? 'project photos' : 'photos'} yet</p>
            <p className="text-gray-400 text-sm mt-1">Select a project above to upload photos or videos</p>
          </div>
        ) : view === 'grid' ? (
          <div className="space-y-6">
            {groupedPhotos.map(group => (
              <section key={group.date} className="rounded-2xl border border-gray-200 bg-white p-4">
                <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-sm font-black text-gray-900">{group.date}</h2>
                    <p className="text-xs font-semibold text-gray-500">{group.photos.length} project item{group.photos.length === 1 ? '' : 's'} ordered by capture time</p>
                  </div>
                  <span className="w-fit rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-black text-emerald-700">User / timestamp / IP audit</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                  {group.photos.map(photo => {
                    const src = `/uploads/${photo.project_id}/${photo.filename}`;
                    const mediaKind = getProgressMediaKind(photo);
                    const isVideo = mediaKind === 'video';
                    const progressContext = isPhotoContextEnabled(photo.show_in_progress, photo.photo_type === 'progress' || photo.photo_type === 'note');
                    const scopeContext = isPhotoContextEnabled(photo.show_in_scope, photo.photo_type === 'scope' || photo.photo_type === 'construction_plan');
                    const descriptionText = getPhotoDescriptionText(photo);
                    const photoTimestamp = format(new Date(photo.taken_at || photo.created_at), 'MMM d, yyyy h:mm a');
                    const uploaderName = photo.uploader_name || photo.uploaded_by_name || 'Unknown user';
                    return (
                      <div
                        key={photo.id}
                        className="relative group aspect-square rounded-xl overflow-hidden bg-gray-100 cursor-pointer"
                        onClick={() => openMedia(photo)}
                      >
                        {isVideo ? (
                          <video src={src} className="w-full h-full object-cover transition-transform group-hover:scale-105" preload="metadata" muted playsInline />
                        ) : mediaKind === 'image' ? (
                          <img src={src} alt={photo.original_name} className="w-full h-full object-cover transition-transform group-hover:scale-105" loading="lazy" />
                        ) : (
                          <UnsupportedMediaTile name={photo.original_name || photo.filename} />
                        )}
                        {isVideo && (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                            <PlayCircle className="w-11 h-11 text-white drop-shadow" />
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={event => {
                            event.stopPropagation();
                            setDescriptionPhoto(photo);
                          }}
                          className={`absolute left-2 top-2 z-30 inline-flex min-h-8 items-center justify-center gap-1 rounded-lg px-2 text-[10px] font-black shadow-sm transition ${
                            descriptionText
                              ? 'bg-amber-500 text-slate-950 hover:bg-amber-400'
                              : 'border border-white/70 bg-black/65 text-white hover:border-amber-300 hover:text-amber-200'
                          }`}
                          aria-label={`${descriptionText ? 'Edit' : 'Add'} description for ${photo.original_name || 'project picture'}`}
                        >
                          <MessageSquare className="h-3.5 w-3.5" />
                          {descriptionText ? 'Edit Description' : 'Add Description'}
                        </button>
                        <div className="absolute bottom-[4.75rem] left-2 right-2 z-20 grid grid-cols-2 gap-1.5">
                          <button
                            type="button"
                            onClick={event => {
                              event.stopPropagation();
                              void updatePhotoContexts(photo, { progress: !progressContext });
                            }}
                            className={`min-h-8 rounded-lg border px-2 text-[10px] font-black shadow-sm ${progressContext ? 'border-amber-200 bg-amber-100 text-amber-800' : 'border-white/40 bg-black/55 text-white'}`}
                          >
                            {progressContext ? 'In Progress' : 'Use Progress'}
                          </button>
                          <button
                            type="button"
                            onClick={event => {
                              event.stopPropagation();
                              void updatePhotoContexts(photo, { scope: !scopeContext });
                            }}
                            className={`min-h-8 rounded-lg border px-2 text-[10px] font-black shadow-sm ${scopeContext ? 'border-teal-200 bg-teal-100 text-teal-800' : 'border-white/40 bg-black/55 text-white'}`}
                          >
                            {scopeContext ? 'In Scope' : 'Use Scope'}
                          </button>
                        </div>
                        {photo.can_delete_correction && (
                          <button
                            type="button"
                            onClick={event => {
                              event.stopPropagation();
                              void deleteProgressPhoto(photo);
                            }}
                            disabled={deletingPhotoId === photo.id}
                            className="absolute right-2 top-2 z-30 inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-white/95 px-2 text-[11px] font-black text-red-700 shadow-sm transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                            aria-label="Delete this project picture as your one correction"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            {deletingPhotoId === photo.id ? 'Deleting' : 'Delete once'}
                          </button>
                        )}
                        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-100 transition-opacity" />
                        <div className="pointer-events-none absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/95 via-black/82 to-black/18 p-2 text-white shadow-[0_-8px_18px_rgba(0,0,0,0.35)]">
                          <p className="truncate text-[11px] font-black leading-4 text-white">{photoTimestamp}</p>
                          <p className="truncate text-[10px] font-extrabold leading-4 text-white/90">Inserted by {uploaderName}</p>
                          <p className="truncate text-[9px] font-bold leading-3 text-cyan-100">{formatPhotoGpsAudit(photo)}</p>
                          <p className="truncate text-[9px] font-bold leading-3 text-white/75">{formatPhotoIpAudit(photo)}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="space-y-5">
            {groupedPhotos.map(group => (
              <section key={group.date}>
                <h2 className="mb-2 text-xs font-black uppercase tracking-wide text-gray-500">{group.date}</h2>
                <div className="space-y-2">
                  {group.photos.map(photo => {
                    const src = `/uploads/${photo.project_id}/${photo.filename}`;
                    const mediaKind = getProgressMediaKind(photo);
                    const isVideo = mediaKind === 'video';
                    const progressContext = isPhotoContextEnabled(photo.show_in_progress, photo.photo_type === 'progress' || photo.photo_type === 'note');
                    const scopeContext = isPhotoContextEnabled(photo.show_in_scope, photo.photo_type === 'scope' || photo.photo_type === 'construction_plan');
                    const descriptionText = getPhotoDescriptionText(photo);
                    const photoTimestamp = format(new Date(photo.taken_at || photo.created_at), 'MMM d, yyyy h:mm a');
                    const uploaderName = photo.uploader_name || photo.uploaded_by_name || 'Unknown user';
                    return (
                      <div key={photo.id} className="bg-white rounded-xl border border-gray-200 p-3 flex items-center gap-3">
                        <div className="w-16 h-16 rounded-lg overflow-hidden bg-gray-100 flex-shrink-0 cursor-pointer relative" onClick={() => openMedia(photo)}>
                          {isVideo ? (
                            <>
                              <video src={src} className="w-full h-full object-cover" preload="metadata" muted playsInline />
                              <PlayCircle className="absolute inset-0 m-auto w-7 h-7 text-white drop-shadow" />
                            </>
                          ) : mediaKind === 'image' ? (
                            <img src={src} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <UnsupportedMediaTile name={photo.original_name || photo.filename} />
                          )}
                          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/82 px-1.5 py-1 text-white">
                            <p className="truncate text-[8px] font-black leading-3">{photoTimestamp}</p>
                            <p className="truncate text-[8px] font-bold leading-3">By {uploaderName}</p>
                          </div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{photo.project_address}</p>
                          <p className="text-xs text-gray-500">{isVideo ? 'Project video' : 'Project photo'} / {uploaderName}</p>
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            <button
                              type="button"
                              onClick={() => void updatePhotoContexts(photo, { progress: !progressContext })}
                              className={`min-h-8 rounded-lg border px-2 text-[10px] font-black ${progressContext ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-gray-200 bg-gray-50 text-gray-600'}`}
                            >
                              {progressContext ? 'In Progress' : 'Use Progress'}
                            </button>
                            <button
                              type="button"
                              onClick={() => void updatePhotoContexts(photo, { scope: !scopeContext })}
                              className={`min-h-8 rounded-lg border px-2 text-[10px] font-black ${scopeContext ? 'border-teal-200 bg-teal-50 text-teal-800' : 'border-gray-200 bg-gray-50 text-gray-600'}`}
                            >
                              {scopeContext ? 'In Scope' : 'Use Scope'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setDescriptionPhoto(photo)}
                              className={`min-h-8 rounded-lg px-2 text-[10px] font-black ${
                                descriptionText
                                  ? 'bg-amber-50 text-amber-800 ring-1 ring-amber-200'
                                  : 'border border-gray-200 bg-gray-50 text-gray-600 hover:bg-white'
                              }`}
                            >
                              <MessageSquare className="mr-1 inline h-3 w-3" />
                              {descriptionText ? 'Edit Description' : 'Add Description'}
                            </button>
                          </div>
                          {photo.note_text && <p className="text-xs font-semibold text-amber-700 truncate">Note: {photo.note_text}</p>}
                          {photo.caption && <p className="text-xs text-gray-400 truncate">{photo.caption}</p>}
                          <p className="text-xs text-gray-400">{photoTimestamp}</p>
                          <p className="text-xs font-semibold text-gray-500">{formatPhotoGpsAudit(photo)}</p>
                          <p className="text-xs text-gray-400">{formatPhotoIpAudit(photo)}</p>
                        </div>
                        {photo.can_delete_correction && (
                          <button
                            type="button"
                            onClick={() => void deleteProgressPhoto(photo)}
                            disabled={deletingPhotoId === photo.id}
                            className="inline-flex min-h-10 flex-shrink-0 items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 text-xs font-black text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            {deletingPhotoId === photo.id ? 'Deleting' : 'Delete once'}
                          </button>
                        )}
                        <Link to={`/projects/${photo.project_id}`} className="text-xs text-blue-600 hover:underline flex-shrink-0">View Project</Link>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )
      )}

      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" onClick={() => setLightbox(null)}>
          {lightbox.isVideo ? (
            <video src={lightbox.src} controls autoPlay className="max-w-full max-h-full rounded-lg" onClick={e => e.stopPropagation()} />
          ) : (
            <img src={lightbox.src} alt="" className="max-w-full max-h-full object-contain rounded-lg" />
          )}
          <button className="absolute top-4 right-4 text-white/70 hover:text-white" onClick={() => setLightbox(null)}>
            <X className="w-8 h-8" />
          </button>
        </div>
      )}
      <PhotoDescriptionModal
        photo={descriptionPhoto}
        onClose={() => setDescriptionPhoto(null)}
        onSaved={handleDescriptionSaved}
      />
    </div>
  );
}

function PhotoDescriptionModal({
  photo,
  onClose,
  onSaved,
}: {
  photo: Photo | null;
  onClose: () => void;
  onSaved: (photo: Photo) => Promise<void> | void;
}) {
  const [descriptionText, setDescriptionText] = useState('');
  const [saving, setSaving] = useState(false);
  const [voiceStopSignal, setVoiceStopSignal] = useState(0);
  const existingDescription = getPhotoDescriptionText(photo);
  const mediaKind = photo ? getProgressMediaKind(photo) : 'image';
  const src = photo ? `/uploads/${photo.project_id}/${photo.filename}` : '';

  useEffect(() => {
    setDescriptionText(existingDescription);
  }, [photo?.id, existingDescription]);

  if (!photo) return null;

  const saveDescription = async (overrideDescription?: string) => {
    if (saving) return;
    const nextDescription = overrideDescription ?? descriptionText;
    setVoiceStopSignal(current => current + 1);
    setSaving(true);
    try {
      const res = await api.put(`/projects/${photo.project_id}/photos/${photo.id}/note`, { note: nextDescription });
      const updatedPhoto = res.data?.photo || res.data;
      toast.success(nextDescription.trim() ? 'Photo description saved' : 'Photo description cleared');
      setSaving(false);
      await onSaved(updatedPhoto);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to save photo description');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-3xl overflow-hidden rounded-xl border border-amber-400/40 bg-slate-950 shadow-2xl" onClick={event => event.stopPropagation()}>
        <div
          className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3"
          style={{ background: 'linear-gradient(135deg, rgba(15,23,42,0.98), rgba(69,26,3,0.72))' }}
        >
          <div className="min-w-0">
            <p className="text-[11px] font-black uppercase tracking-wide text-amber-300">Picture description</p>
            <h3 className="truncate text-sm font-black text-white">{photo.original_name || photo.filename || 'Project picture'}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-white/20 bg-white/10 text-white transition hover:border-amber-300 hover:text-amber-200"
            aria-label="Close picture description"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="grid gap-4 p-4 md:grid-cols-[260px_minmax(0,1fr)]">
          <div className="overflow-hidden rounded-lg border border-white/10 bg-black">
            <div className="aspect-square">
              {mediaKind === 'video' ? (
                <video src={src} className="h-full w-full object-cover" controls />
              ) : mediaKind === 'image' ? (
                <img src={src} alt={photo.original_name || 'Project picture'} className="h-full w-full object-cover" />
              ) : (
                <UnsupportedMediaTile name={photo.original_name || photo.filename} />
              )}
            </div>
          </div>

          <div className="space-y-3">
            <label className="block">
              <span className="mb-2 block text-xs font-black uppercase tracking-wide text-slate-300">Photo description</span>
              <VoiceTextarea
                value={descriptionText}
                onChange={event => setDescriptionText(event.target.value)}
                rows={8}
                disabled={saving}
                stopSignal={voiceStopSignal}
                className="w-full resize-none rounded-lg border border-amber-300/30 bg-slate-900 px-3 py-2 text-sm font-semibold leading-6 text-white outline-none transition placeholder:text-slate-500 focus:border-amber-300 focus:ring-2 focus:ring-amber-300/30"
                placeholder="Describe what this picture shows..."
                autoFocus
              />
            </label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-600 bg-slate-900 px-4 text-sm font-black text-slate-200 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void saveDescription()}
                disabled={saving || !descriptionText.trim() || descriptionText.trim() === existingDescription}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-amber-300 bg-amber-500 px-4 text-sm font-black text-slate-950 shadow-lg shadow-amber-950/25 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:border-slate-500 disabled:bg-slate-700 disabled:text-slate-300"
              >
                <MessageSquare className="h-4 w-4" />
                {saving ? 'Saving...' : 'Save Description'}
              </button>
              {(existingDescription || descriptionText.trim()) && (
                <button
                  type="button"
                  onClick={() => void saveDescription('')}
                  disabled={saving || (!existingDescription && !descriptionText.trim())}
                  className="inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-600 bg-slate-900 px-4 text-sm font-black text-slate-200 transition hover:border-red-300 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Clear description
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
