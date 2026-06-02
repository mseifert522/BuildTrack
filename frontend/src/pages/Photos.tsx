import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../lib/api';
import { Loading } from '../components/ui';
import { Camera, Grid, List, PlayCircle, X } from 'lucide-react';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { appendProgressUploadAudit, PROGRESS_MEDIA_ACCEPT } from '../lib/progressUpload';

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
  note_user_name?: string | null;
  upload_ip_address?: string | null;
  capture_latitude?: number | null;
  capture_longitude?: number | null;
  capture_accuracy?: number | null;
  capture_source?: string | null;
}

interface LightboxMedia {
  src: string;
  isVideo: boolean;
}

function isVideoMedia(item: Pick<Photo, 'filename' | 'mime_type'>) {
  return Boolean(item.mime_type?.startsWith('video/')) || /\.(mp4|mov|m4v|webm|avi|mkv|mpeg|mpg|3gp)$/i.test(item.filename);
}

function mediaLabel(count: number) {
  return `${count} progress item${count === 1 ? '' : 's'}`;
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

export default function Photos() {
  const [searchParams] = useSearchParams();
  const requestedProjectId = searchParams.get('projectId') || '';
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [lightbox, setLightbox] = useState<LightboxMedia | null>(null);
  const [selectedProject, setSelectedProject] = useState(requestedProjectId);
  const [caption, setCaption] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const groupedPhotos = groupPhotosByDay(photos);

  const load = async () => {
    setLoading(true);
    try {
      const projRes = await api.get('/projects');
      setProjects(projRes.data);

      const allPhotos: Photo[] = [];
      const projectsToLoad = selectedProject
        ? projRes.data.filter((p: any) => p.id === selectedProject)
        : projRes.data;

      for (const proj of projectsToLoad) {
        try {
          const res = await api.get(`/projects/${proj.id}/photos?type=progress`);
          res.data.forEach((photo: Photo) => {
            allPhotos.push({ ...photo, project_address: proj.address });
          });
        } catch (err) {}
      }
      setPhotos(allPhotos.sort((a, b) => new Date(b.taken_at || b.created_at).getTime() - new Date(a.taken_at || a.created_at).getTime()));
    } catch (err) {
      console.error(err);
      toast.error('Failed to load progress photos');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [selectedProject]);

  useEffect(() => {
    if (requestedProjectId && requestedProjectId !== selectedProject) {
      setSelectedProject(requestedProjectId);
    }
  }, [requestedProjectId, selectedProject]);

  const uploadMedia = async (files?: FileList | null) => {
    if (!files || files.length === 0) return;
    if (!selectedProject) {
      toast.error('Select a project before uploading progress photos or videos');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      const uploadFiles = Array.from(files);
      uploadFiles.forEach(file => formData.append('photos', file));
      if (caption.trim()) formData.append('caption', caption.trim());
      formData.append('photo_type', 'progress');
      await appendProgressUploadAudit(formData, uploadFiles, uploadFiles.map(() => 'desktop'));

      await api.post(`/projects/${selectedProject}/photos?type=progress`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success(`${files.length} progress item${files.length === 1 ? '' : 's'} uploaded`);
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
    setLightbox({
      src: `/uploads/${photo.project_id}/${photo.filename}`,
      isVideo: isVideoMedia(photo),
    });
  };

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <div className="flex flex-col gap-3 mb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Progress Photos</h1>
          <p className="text-sm text-gray-500 mt-0.5">{mediaLabel(photos.length)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!selectedProject || uploading}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-black text-white shadow-sm transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400"
          >
            <Camera className="h-4 w-4" />
            {uploading ? 'Uploading...' : 'Upload Progress Pictures'}
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
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={caption}
              onChange={e => setCaption(e.target.value)}
              placeholder="Optional caption for this upload"
              className="min-w-0 flex-1 px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <p className="text-xs text-gray-500 mt-2">
            {selectedProject ? 'Media will be hosted under the selected project with captured timestamp metadata.' : 'Select a project to add progress photos or project videos.'}
          </p>
        </div>
      </div>

      {loading ? <Loading /> : (
        photos.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
            <Camera className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500 font-medium">No progress photos yet</p>
            <p className="text-gray-400 text-sm mt-1">Select a project above to upload photos or videos</p>
          </div>
        ) : view === 'grid' ? (
          <div className="space-y-6">
            {groupedPhotos.map(group => (
              <section key={group.date} className="rounded-2xl border border-gray-200 bg-white p-4">
                <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-sm font-black text-gray-900">{group.date}</h2>
                    <p className="text-xs font-semibold text-gray-500">{group.photos.length} progress item{group.photos.length === 1 ? '' : 's'} ordered by capture time</p>
                  </div>
                  <span className="w-fit rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-black text-emerald-700">User / timestamp / IP audit</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                  {group.photos.map(photo => {
                    const src = `/uploads/${photo.project_id}/${photo.filename}`;
                    const isVideo = isVideoMedia(photo);
                    return (
                      <div
                        key={photo.id}
                        className="relative group aspect-square rounded-xl overflow-hidden bg-gray-100 cursor-pointer"
                        onClick={() => openMedia(photo)}
                      >
                        {isVideo ? (
                          <video src={src} className="w-full h-full object-cover transition-transform group-hover:scale-105" preload="metadata" muted playsInline />
                        ) : (
                          <img src={src} alt={photo.original_name} className="w-full h-full object-cover transition-transform group-hover:scale-105" loading="lazy" />
                        )}
                        {isVideo && (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                            <PlayCircle className="w-11 h-11 text-white drop-shadow" />
                          </div>
                        )}
                        {photo.note_id && <span className="absolute left-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-black text-white">Note</span>}
                        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-transparent opacity-100 transition-opacity" />
                        <div className="absolute bottom-0 left-0 right-0 p-2">
                          <p className="text-white text-xs font-bold truncate">{photo.project_address}</p>
                          <p className="text-white/80 text-xs truncate">{photo.uploader_name || 'Unknown user'} / {format(new Date(photo.taken_at || photo.created_at), 'h:mm a')}</p>
                          <p className="text-white/70 text-[10px] truncate">{photo.capture_latitude ? 'GPS recorded' : 'IP recorded'}{photo.upload_ip_address ? ` / ${photo.upload_ip_address}` : ''}</p>
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
                    const isVideo = isVideoMedia(photo);
                    return (
                      <div key={photo.id} className="bg-white rounded-xl border border-gray-200 p-3 flex items-center gap-3">
                        <div className="w-16 h-16 rounded-lg overflow-hidden bg-gray-100 flex-shrink-0 cursor-pointer relative" onClick={() => openMedia(photo)}>
                          {isVideo ? (
                            <>
                              <video src={src} className="w-full h-full object-cover" preload="metadata" muted playsInline />
                              <PlayCircle className="absolute inset-0 m-auto w-7 h-7 text-white drop-shadow" />
                            </>
                          ) : (
                            <img src={src} alt="" className="w-full h-full object-cover" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{photo.project_address}</p>
                          <p className="text-xs text-gray-500">{isVideo ? 'Project video' : 'Progress photo'} / {photo.uploader_name || 'Unknown user'}</p>
                          {photo.note_text && <p className="text-xs font-semibold text-amber-700 truncate">Note: {photo.note_text}</p>}
                          {photo.caption && <p className="text-xs text-gray-400 truncate">{photo.caption}</p>}
                          <p className="text-xs text-gray-400">{format(new Date(photo.taken_at || photo.created_at), 'MMM d, yyyy h:mm a')} / {photo.capture_latitude ? 'GPS recorded' : 'IP recorded'}{photo.upload_ip_address ? ` / ${photo.upload_ip_address}` : ''}</p>
                        </div>
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
    </div>
  );
}
