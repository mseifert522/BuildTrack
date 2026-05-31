import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  ArrowLeft,
  Camera,
  CheckCircle2,
  Clock,
  FolderOpen,
  ImagePlus,
  MapPin,
  RefreshCw,
  Search,
  Upload,
  X,
} from 'lucide-react';
import api from '../lib/api';
import { useAuthStore } from '../store/authStore';

interface Project {
  id: string;
  address: string;
  job_name?: string;
  status?: string;
}

interface ProjectPhoto {
  id: string;
  filename: string;
  original_name: string;
  caption?: string;
  taken_at?: string;
  created_at: string;
  uploader_name?: string;
  uploaded_by_name?: string;
}

function formatDateTime(value?: string) {
  if (!value) return 'Just now';
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function clearPreviewUrls(urls: string[]) {
  urls.forEach(url => URL.revokeObjectURL(url));
}

export default function MobilePhotos() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuthStore();
  const requestedProjectId = searchParams.get('projectId') || '';
  const storageKey = `buildtrack-mobile-photo-project:${user?.id || 'session'}`;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [caption, setCaption] = useState('');
  const [photos, setPhotos] = useState<ProjectPhoto[]>([]);
  const [previewFiles, setPreviewFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showProjectSelector, setShowProjectSelector] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const selectedProject = useMemo(
    () => projects.find(project => project.id === selectedProjectId) || null,
    [projects, selectedProjectId]
  );

  const filteredProjects = useMemo(() => {
    const query = projectSearch.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter(project =>
      project.address.toLowerCase().includes(query) ||
      (project.job_name || '').toLowerCase().includes(query)
    );
  }, [projectSearch, projects]);

  const photoBaseUrl = (api.defaults.baseURL || '').replace('/api', '');

  const loadPhotos = useCallback(async (projectId: string) => {
    if (!projectId) return;
    setPhotosLoading(true);
    try {
      const res = await api.get(`/projects/${projectId}/photos?type=progress`);
      setPhotos(Array.isArray(res.data) ? res.data : []);
    } catch {
      toast.error('Failed to load project photos');
    } finally {
      setPhotosLoading(false);
    }
  }, []);

  const selectProject = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    localStorage.setItem(storageKey, projectId);
    setShowProjectSelector(false);
    setProjectSearch('');
    setPreviewFiles([]);
    setPreviewUrls(current => {
      clearPreviewUrls(current);
      return [];
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [storageKey]);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/projects');
      const nextProjects: Project[] = Array.isArray(res.data) ? res.data : [];
      setProjects(nextProjects);

      const preferredProjectId = requestedProjectId || localStorage.getItem(storageKey) || '';
      const validProject = nextProjects.find(project => project.id === preferredProjectId);
      if (validProject) {
        selectProject(validProject.id);
      } else if (nextProjects.length === 1) {
        selectProject(nextProjects[0].id);
      } else {
        setSelectedProjectId('');
        setShowProjectSelector(true);
      }
    } catch {
      toast.error('Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, [requestedProjectId, selectProject, storageKey]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (selectedProjectId) void loadPhotos(selectedProjectId);
  }, [loadPhotos, selectedProjectId]);

  useEffect(() => () => clearPreviewUrls(previewUrls), [previewUrls]);

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedProjectId) {
      setShowProjectSelector(true);
      if (fileInputRef.current) fileInputRef.current.value = '';
      toast.error('Choose a project before adding photos');
      return;
    }

    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    setPreviewFiles(files);
    setPreviewUrls(current => {
      clearPreviewUrls(current);
      return files.map(file => URL.createObjectURL(file));
    });
  };

  const cancelUpload = () => {
    setPreviewFiles([]);
    setPreviewUrls(current => {
      clearPreviewUrls(current);
      return [];
    });
    setCaption('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleUpload = async () => {
    if (!selectedProjectId) {
      setShowProjectSelector(true);
      toast.error('Choose a project before uploading');
      return;
    }
    if (!previewFiles.length) return;

    setUploading(true);
    try {
      const formData = new FormData();
      previewFiles.forEach(file => formData.append('photos', file));
      if (caption.trim()) formData.append('caption', caption.trim());
      formData.append('photo_type', 'progress');
      formData.append('taken_at_values', JSON.stringify(
        previewFiles.map(file => new Date(file.lastModified || Date.now()).toISOString())
      ));

      await api.post(`/projects/${selectedProjectId}/photos?type=progress`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      toast.success(`${previewFiles.length} photo${previewFiles.length === 1 ? '' : 's'} added to project`);
      cancelUpload();
      await loadPhotos(selectedProjectId);
    } catch {
      toast.error('Photo upload failed');
    } finally {
      setUploading(false);
    }
  };

  const openFilePicker = () => {
    if (!selectedProjectId) {
      setShowProjectSelector(true);
      return;
    }
    fileInputRef.current?.click();
  };

  const projectSelector = (
    <div style={{ position: 'fixed', inset: 0, zIndex: 220, background: 'rgba(13,17,23,0.88)', display: 'flex', alignItems: 'flex-end' }}>
      <div style={{ width: '100%', maxHeight: '86vh', background: 'white', borderRadius: '22px 22px 0 0', padding: '16px 14px 24px', overflowY: 'auto' }}>
        <div style={{ width: 42, height: 4, background: '#E5E7EB', borderRadius: 2, margin: '0 auto 14px' }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <p style={{ color: '#111827', fontSize: 18, fontWeight: 800, margin: 0 }}>Choose Project</p>
            <p style={{ color: '#6B7280', fontSize: 12, margin: '3px 0 0' }}>Photos cannot be uploaded without a project.</p>
          </div>
          {selectedProjectId && (
            <button
              onClick={() => setShowProjectSelector(false)}
              style={{ width: 34, height: 34, borderRadius: 10, border: 'none', background: '#F3F4F6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <X size={18} color="#6B7280" />
            </button>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#F3F4F6', borderRadius: 14, padding: '10px 12px', marginTop: 14 }}>
          <Search size={16} color="#6B7280" />
          <input
            value={projectSearch}
            onChange={event => setProjectSearch(event.target.value)}
            placeholder="Search project or address"
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: '#111827', fontSize: 14 }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
          {filteredProjects.map(project => (
            <button
              key={project.id}
              onClick={() => selectProject(project.id)}
              style={{ width: '100%', textAlign: 'left', border: '1px solid #E5E7EB', background: selectedProjectId === project.id ? '#FFFBEB' : 'white', borderRadius: 14, padding: 13, display: 'flex', gap: 10, alignItems: 'center' }}
            >
              <div style={{ width: 38, height: 38, borderRadius: 10, background: 'rgba(217,157,38,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <MapPin size={18} color="#D99D26" />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, color: '#111827', fontSize: 13, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.address}</p>
                <p style={{ margin: '2px 0 0', color: '#6B7280', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.job_name || project.status || 'Project'}</p>
              </div>
              {selectedProjectId === project.id && <CheckCircle2 size={20} color="#16A34A" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="mobile-shell" style={{ background: '#0D1117', alignItems: 'center', justifyContent: 'center' }}>
        <RefreshCw size={34} color="#D99D26" style={{ animation: 'spin 0.8s linear infinite' }} />
        <p style={{ color: 'rgba(255,255,255,0.55)', marginTop: 14, fontSize: 13 }}>Loading projects...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div className="mobile-shell" style={{ background: '#F4F5F7' }}>
      <div className="mobile-header" style={{ background: 'linear-gradient(135deg, #0D1117 0%, #181D25 100%)', color: 'white' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 14px 10px' }}>
          <button
            onClick={() => navigate('/mobile')}
            style={{ width: 38, height: 38, borderRadius: 11, border: 'none', background: 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <ArrowLeft size={19} color="white" />
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 850 }}>Mobile Photos</p>
            <p style={{ margin: '2px 0 0', color: '#D99D26', fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedProject ? selectedProject.address : 'No project selected'}
            </p>
          </div>
          <button
            onClick={() => loadProjects()}
            style={{ width: 38, height: 38, borderRadius: 11, border: 'none', background: 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <RefreshCw size={17} color="rgba(255,255,255,0.75)" />
          </button>
        </div>

        <div style={{ padding: '0 14px 14px', display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
          <button
            onClick={() => setShowProjectSelector(true)}
            style={{ minWidth: 0, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.08)', color: 'white', borderRadius: 13, padding: '10px 12px', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 9 }}
          >
            <FolderOpen size={17} color="#D99D26" />
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 750 }}>
              {selectedProject ? 'Change project' : 'Select project'}
            </span>
          </button>
          <button
            onClick={openFilePicker}
            style={{ border: 'none', borderRadius: 13, padding: '10px 14px', background: 'linear-gradient(135deg, #D99D26, #C4891F)', color: 'white', fontSize: 13, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 7 }}
          >
            <Camera size={17} color="white" />
            Add
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={handleFileSelect}
        style={{ display: 'none' }}
      />

      <div className="mobile-content" style={{ padding: 14, paddingBottom: 92 }}>
        {!selectedProject && (
          <button
            onClick={() => setShowProjectSelector(true)}
            style={{ width: '100%', border: '1px dashed #D99D26', background: '#FFFBEB', borderRadius: 16, padding: 18, color: '#92400E', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
          >
            <FolderOpen size={18} color="#D99D26" />
            Choose a project to add photos
          </button>
        )}

        {selectedProject && (
          <div style={{ background: 'white', borderRadius: 16, padding: 14, boxShadow: '0 1px 8px rgba(0,0,0,0.06)', marginBottom: 12 }}>
            <p style={{ margin: 0, color: '#111827', fontSize: 13, fontWeight: 850 }}>{selectedProject.address}</p>
            <p style={{ margin: '3px 0 0', color: '#6B7280', fontSize: 12 }}>{selectedProject.job_name || selectedProject.status || 'Selected project'}</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10, color: '#6B7280', fontSize: 11, fontWeight: 700 }}>
              <Clock size={13} color="#6B7280" />
              New photos will be stamped with each file's captured time when available.
            </div>
          </div>
        )}

        {previewFiles.length > 0 && (
          <div style={{ background: 'white', borderRadius: 18, padding: 14, boxShadow: '0 2px 12px rgba(0,0,0,0.08)', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <p style={{ margin: 0, color: '#111827', fontWeight: 850, fontSize: 15 }}>Ready to Upload</p>
              <button onClick={cancelUpload} style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: '#F3F4F6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <X size={16} color="#6B7280" />
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 7, marginBottom: 12 }}>
              {previewUrls.map((url, index) => (
                <div key={url} style={{ position: 'relative', aspectRatio: '1 / 1', borderRadius: 10, overflow: 'hidden', background: '#F3F4F6' }}>
                  <img src={url} alt={`Selected ${index + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>
              ))}
            </div>
            <input
              value={caption}
              onChange={event => setCaption(event.target.value)}
              placeholder="Caption for this upload"
              style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #E5E7EB', borderRadius: 12, padding: '10px 12px', color: '#111827', fontSize: 14, marginBottom: 10 }}
            />
            <button
              onClick={handleUpload}
              disabled={uploading}
              style={{ width: '100%', border: 'none', borderRadius: 13, padding: '12px 14px', background: 'linear-gradient(135deg, #D99D26, #C4891F)', color: 'white', fontSize: 14, fontWeight: 850, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: uploading ? 0.72 : 1 }}
            >
              <Upload size={17} color="white" />
              {uploading ? 'Uploading...' : `Upload ${previewFiles.length} Photo${previewFiles.length === 1 ? '' : 's'}`}
            </button>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '2px 2px 10px' }}>
          <p style={{ margin: 0, color: '#6B7280', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            {photos.length} Project Photo{photos.length === 1 ? '' : 's'}
          </p>
          {photosLoading && <RefreshCw size={14} color="#9CA3AF" style={{ animation: 'spin 0.8s linear infinite' }} />}
        </div>

        {photos.length === 0 ? (
          <div style={{ textAlign: 'center', background: 'white', borderRadius: 18, padding: '44px 18px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)' }}>
            <ImagePlus size={42} color="#D1D5DB" />
            <p style={{ margin: '12px 0 4px', color: '#374151', fontSize: 15, fontWeight: 850 }}>No project photos yet</p>
            <p style={{ margin: 0, color: '#9CA3AF', fontSize: 12 }}>Choose Add to capture or upload progress pictures.</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 9 }}>
            {photos.map(photo => {
              const src = photo.filename.startsWith('http')
                ? photo.filename
                : `${photoBaseUrl}/uploads/${selectedProjectId}/${photo.filename}`;
              return (
                <button
                  key={photo.id}
                  onClick={() => setLightbox(src)}
                  style={{ border: 'none', background: 'white', borderRadius: 14, overflow: 'hidden', padding: 0, textAlign: 'left', boxShadow: '0 1px 8px rgba(0,0,0,0.08)' }}
                >
                  <div style={{ aspectRatio: '1 / 1', background: '#E5E7EB' }}>
                    <img src={src} alt={photo.caption || photo.original_name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                  <div style={{ padding: 9 }}>
                    <p style={{ margin: 0, color: '#111827', fontSize: 11, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{photo.caption || photo.original_name || 'Project photo'}</p>
                    <p style={{ margin: '3px 0 0', color: '#6B7280', fontSize: 10 }}>{formatDateTime(photo.taken_at || photo.created_at)}</p>
                    {(photo.uploader_name || photo.uploaded_by_name) && (
                      <p style={{ margin: '2px 0 0', color: '#D99D26', fontSize: 10, fontWeight: 700 }}>{photo.uploader_name || photo.uploaded_by_name}</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {showProjectSelector && projectSelector}

      {lightbox && (
        <div onClick={() => setLightbox(null)} style={{ position: 'fixed', inset: 0, zIndex: 260, background: 'rgba(0,0,0,0.95)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <img src={lightbox} alt="Project photo" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          <button
            onClick={() => setLightbox(null)}
            style={{ position: 'absolute', top: 18, right: 18, width: 40, height: 40, borderRadius: 20, border: 'none', background: 'rgba(255,255,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <X size={20} color="white" />
          </button>
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
