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
  PlayCircle,
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
  mime_type?: string;
  uploader_name?: string;
  uploaded_by_name?: string;
}

interface LightboxMedia {
  src: string;
  isVideo: boolean;
}

const MAX_PROGRESS_UPLOAD_FILES = 20;

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

function isVideoMedia(item: Pick<ProjectPhoto, 'filename' | 'mime_type'> | File) {
  if (item instanceof File) return item.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|avi|mkv|mpeg|mpg|3gp)$/i.test(item.name);
  return Boolean(item.mime_type?.startsWith('video/')) || /\.(mp4|mov|m4v|webm|avi|mkv|mpeg|mpg|3gp)$/i.test(item.filename);
}

export default function MobilePhotos() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuthStore();
  const requestedProjectId = searchParams.get('projectId') || '';
  const storageKey = `buildtrack-mobile-photo-project:${user?.id || 'session'}`;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const previewUrlsRef = useRef<string[]>([]);
  const batchCameraVideoRef = useRef<HTMLVideoElement>(null);
  const batchCameraStreamRef = useRef<MediaStream | null>(null);

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
  const [showUploadOptions, setShowUploadOptions] = useState(false);
  const [showBatchCamera, setShowBatchCamera] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [lightbox, setLightbox] = useState<LightboxMedia | null>(null);

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
      toast.error('Failed to load progress photos');
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
    if (cameraInputRef.current) cameraInputRef.current.value = '';
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

  useEffect(() => {
    previewUrlsRef.current = previewUrls;
  }, [previewUrls]);

  useEffect(() => () => clearPreviewUrls(previewUrlsRef.current), []);

  const fileKey = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;

  const addPreviewFiles = (files: File[]) => {
    if (!files.length) return;
    setPreviewFiles(current => {
      const existing = new Set(current.map(fileKey));
      const nextFiles = files.filter(file => !existing.has(fileKey(file)));
      if (!nextFiles.length) return current;
      const availableSlots = Math.max(0, MAX_PROGRESS_UPLOAD_FILES - current.length);
      const acceptedFiles = nextFiles.slice(0, availableSlots);
      if (acceptedFiles.length < nextFiles.length) {
        window.setTimeout(() => toast.error(`Upload batches are limited to ${MAX_PROGRESS_UPLOAD_FILES} items`), 0);
      }
      if (!acceptedFiles.length) return current;
      setPreviewUrls(urls => [...urls, ...acceptedFiles.map(file => URL.createObjectURL(file))]);
      return [...current, ...acceptedFiles];
    });
  };

  const stopBatchCamera = useCallback(() => {
    batchCameraStreamRef.current?.getTracks().forEach(track => track.stop());
    batchCameraStreamRef.current = null;
    setCameraReady(false);
  }, []);

  const startBatchCamera = useCallback(async () => {
    setCameraError('');
    setCameraReady(false);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('This device does not support the in-app batch camera. Use the device camera fallback below.');
      return;
    }

    try {
      stopBatchCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      batchCameraStreamRef.current = stream;
      if (batchCameraVideoRef.current) {
        batchCameraVideoRef.current.srcObject = stream;
        await batchCameraVideoRef.current.play();
      }
      setCameraReady(true);
    } catch {
      setCameraError('Camera access was not available. Use the device camera fallback or choose photos from the library.');
    }
  }, [stopBatchCamera]);

  useEffect(() => {
    if (!showBatchCamera) {
      stopBatchCamera();
      return;
    }
    void startBatchCamera();
    return () => stopBatchCamera();
  }, [showBatchCamera, startBatchCamera, stopBatchCamera]);

  const captureBatchPhoto = () => {
    const video = batchCameraVideoRef.current;
    if (!video || !cameraReady || !video.videoWidth || !video.videoHeight) {
      toast.error('Camera is still getting ready');
      return;
    }

    const capturedAt = Date.now();
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      toast.error('Camera capture failed');
      return;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(blob => {
      if (!blob) {
        toast.error('Camera capture failed');
        return;
      }
      const file = new File([blob], `progress-${capturedAt}.jpg`, {
        type: 'image/jpeg',
        lastModified: capturedAt,
      });
      addPreviewFiles([file]);
    }, 'image/jpeg', 0.9);
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedProjectId) {
      setShowProjectSelector(true);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (cameraInputRef.current) cameraInputRef.current.value = '';
      toast.error('Choose a project before adding progress photos or videos');
      return;
    }

    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    addPreviewFiles(files);
    event.currentTarget.value = '';
  };

  const cancelUpload = () => {
    setPreviewFiles([]);
    setPreviewUrls(current => {
      clearPreviewUrls(current);
      return [];
    });
    setCaption('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (cameraInputRef.current) cameraInputRef.current.value = '';
  };

  const handleUpload = async () => {
    if (!selectedProjectId) {
      setShowProjectSelector(true);
      toast.error('Choose a project before uploading');
      return;
    }
    if (!previewFiles.length) return;
    if (previewFiles.length > MAX_PROGRESS_UPLOAD_FILES) {
      toast.error(`Upload batches are limited to ${MAX_PROGRESS_UPLOAD_FILES} items`);
      return;
    }

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

      toast.success(`${previewFiles.length} progress item${previewFiles.length === 1 ? '' : 's'} added to project`);
      cancelUpload();
      await loadPhotos(selectedProjectId);
    } catch {
      toast.error('Progress upload failed');
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

  const openCamera = () => {
    if (!selectedProjectId) {
      setShowProjectSelector(true);
      return;
    }
    cameraInputRef.current?.click();
  };

  const openUploadOptions = () => {
    if (!selectedProjectId) {
      setShowProjectSelector(true);
      return;
    }
    setShowUploadOptions(true);
  };

  const openBatchCamera = () => {
    if (!selectedProjectId) {
      setShowProjectSelector(true);
      return;
    }
    setShowUploadOptions(false);
    setShowBatchCamera(true);
  };

  const closeBatchCamera = () => {
    setShowBatchCamera(false);
    stopBatchCamera();
  };

  const projectSelector = (
    <div style={{ position: 'fixed', inset: 0, zIndex: 220, background: 'rgba(13,17,23,0.88)', display: 'flex', alignItems: 'flex-end' }}>
      <div style={{ width: '100%', maxHeight: '86vh', background: 'white', borderRadius: '22px 22px 0 0', padding: '16px 14px 24px', overflowY: 'auto' }}>
        <div style={{ width: 42, height: 4, background: '#E5E7EB', borderRadius: 2, margin: '0 auto 14px' }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <p style={{ color: '#111827', fontSize: 18, fontWeight: 800, margin: 0 }}>Choose Project</p>
            <p style={{ color: '#6B7280', fontSize: 12, margin: '3px 0 0' }}>Progress photos and videos cannot be uploaded without a project.</p>
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
            <p style={{ margin: 0, fontSize: 16, fontWeight: 850 }}>Progress Photos</p>
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

        <div style={{ padding: '0 14px 14px', display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
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
            onClick={openUploadOptions}
            style={{ minHeight: 48, width: '100%', border: 'none', borderRadius: 13, padding: '10px 14px', background: 'linear-gradient(135deg, #D99D26, #C4891F)', color: 'white', fontSize: 13, fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, whiteSpace: 'normal', textAlign: 'center', lineHeight: 1.15 }}
          >
            <Camera size={17} color="white" />
            Upload Progress Pictures
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        onChange={handleFileSelect}
        style={{ display: 'none' }}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
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
            Choose a project to upload progress pictures
          </button>
        )}

        {selectedProject && (
          <div style={{ background: 'white', borderRadius: 16, padding: 14, boxShadow: '0 1px 8px rgba(0,0,0,0.06)', marginBottom: 12 }}>
            <p style={{ margin: 0, color: '#111827', fontSize: 13, fontWeight: 850 }}>{selectedProject.address}</p>
            <p style={{ margin: '3px 0 0', color: '#6B7280', fontSize: 12 }}>{selectedProject.job_name || selectedProject.status || 'Selected project'}</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10, color: '#6B7280', fontSize: 11, fontWeight: 700 }}>
              <Clock size={13} color="#6B7280" />
              New photos and videos will be stamped with each file's captured time when available.
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
                  {isVideoMedia(previewFiles[index]) ? (
                    <>
                      <video src={url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} muted playsInline />
                      <PlayCircle size={24} color="white" style={{ position: 'absolute', inset: 0, margin: 'auto', filter: 'drop-shadow(0 1px 4px rgba(0,0,0,0.65))' }} />
                    </>
                  ) : (
                    <img src={url} alt={`Selected ${index + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  )}
                </div>
              ))}
            </div>
            <input
              value={caption}
              onChange={event => setCaption(event.target.value)}
              placeholder="Caption for this upload"
              style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #E5E7EB', borderRadius: 12, padding: '10px 12px', color: '#111827', fontSize: 14, marginBottom: 10 }}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
              <button
                onClick={openFilePicker}
                type="button"
                style={{ minHeight: 44, border: '1px solid #F3D08A', borderRadius: 12, background: '#FFFBEB', color: '#92400E', fontSize: 12, fontWeight: 850, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                <ImagePlus size={15} color="#D99D26" />
                Add More
              </button>
              <button
                onClick={openBatchCamera}
                type="button"
                style={{ minHeight: 44, border: '1px solid #D1D5DB', borderRadius: 12, background: '#F9FAFB', color: '#374151', fontSize: 12, fontWeight: 850, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                <Camera size={15} color="#374151" />
                Batch Camera
              </button>
            </div>
            <button
              onClick={handleUpload}
              disabled={uploading}
              style={{ width: '100%', border: 'none', borderRadius: 13, padding: '12px 14px', background: 'linear-gradient(135deg, #D99D26, #C4891F)', color: 'white', fontSize: 14, fontWeight: 850, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: uploading ? 0.72 : 1 }}
            >
              <Upload size={17} color="white" />
              {uploading ? 'Uploading...' : `Upload ${previewFiles.length} Item${previewFiles.length === 1 ? '' : 's'}`}
            </button>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '2px 2px 10px' }}>
          <p style={{ margin: 0, color: '#6B7280', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            {photos.length} Progress Item{photos.length === 1 ? '' : 's'}
          </p>
          {photosLoading && <RefreshCw size={14} color="#9CA3AF" style={{ animation: 'spin 0.8s linear infinite' }} />}
        </div>

        {photos.length === 0 ? (
          <div style={{ textAlign: 'center', background: 'white', borderRadius: 18, padding: '44px 18px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)' }}>
            <ImagePlus size={42} color="#D1D5DB" />
            <p style={{ margin: '12px 0 4px', color: '#374151', fontSize: 15, fontWeight: 850 }}>No progress photos yet</p>
            <p style={{ margin: 0, color: '#9CA3AF', fontSize: 12 }}>Choose multiple pictures at once, or open the camera and add shots before uploading.</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 9 }}>
            {photos.map(photo => {
              const src = photo.filename.startsWith('http')
                ? photo.filename
                : `${photoBaseUrl}/uploads/${selectedProjectId}/${photo.filename}`;
              const isVideo = isVideoMedia(photo);
              return (
                <button
                  key={photo.id}
                  onClick={() => setLightbox({ src, isVideo })}
                  style={{ border: 'none', background: 'white', borderRadius: 14, overflow: 'hidden', padding: 0, textAlign: 'left', boxShadow: '0 1px 8px rgba(0,0,0,0.08)' }}
                >
                  <div style={{ aspectRatio: '1 / 1', background: '#E5E7EB' }}>
                    {isVideo ? (
                      <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                        <video src={src} style={{ width: '100%', height: '100%', objectFit: 'cover' }} preload="metadata" muted playsInline />
                        <PlayCircle size={30} color="white" style={{ position: 'absolute', inset: 0, margin: 'auto', filter: 'drop-shadow(0 1px 4px rgba(0,0,0,0.65))' }} />
                      </div>
                    ) : (
                      <img src={src} alt={photo.caption || photo.original_name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    )}
                  </div>
                  <div style={{ padding: 9 }}>
                    <p style={{ margin: 0, color: '#111827', fontSize: 11, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{photo.caption || photo.original_name || (isVideo ? 'Project video' : 'Progress photo')}</p>
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

      {showUploadOptions && (
        <div
          onClick={() => setShowUploadOptions(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 230, background: 'rgba(13,17,23,0.78)', display: 'flex', alignItems: 'flex-end' }}
        >
          <div
            onClick={event => event.stopPropagation()}
            style={{ width: '100%', background: 'white', borderRadius: '22px 22px 0 0', padding: '18px 14px 24px', boxShadow: '0 -14px 30px rgba(0,0,0,0.18)' }}
          >
            <div style={{ width: 42, height: 4, background: '#E5E7EB', borderRadius: 2, margin: '0 auto 14px' }} />
            <p style={{ margin: 0, color: '#111827', fontSize: 18, fontWeight: 900 }}>Upload Progress Pictures</p>
            <p style={{ margin: '4px 0 16px', color: '#6B7280', fontSize: 12, lineHeight: 1.45 }}>
              Add a whole batch before sending it to the project.
            </p>
            <div style={{ display: 'grid', gap: 10 }}>
              <button
                type="button"
                onClick={openBatchCamera}
                style={{ minHeight: 64, border: 'none', borderRadius: 16, background: 'linear-gradient(135deg, #D99D26, #C4891F)', color: 'white', padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left' }}
              >
                <Camera size={22} color="white" />
                <span style={{ display: 'block' }}>
                  <span style={{ display: 'block', fontSize: 14, fontWeight: 900 }}>Start Batch Camera</span>
                  <span style={{ display: 'block', marginTop: 2, fontSize: 11, fontWeight: 700, opacity: 0.82 }}>Take several photos without leaving this screen</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowUploadOptions(false);
                  openFilePicker();
                }}
                style={{ minHeight: 58, border: '1px solid #E5E7EB', borderRadius: 16, background: '#F9FAFB', color: '#111827', padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left' }}
              >
                <ImagePlus size={21} color="#D99D26" />
                <span style={{ display: 'block' }}>
                  <span style={{ display: 'block', fontSize: 14, fontWeight: 900 }}>Choose Multiple From Library</span>
                  <span style={{ display: 'block', marginTop: 2, fontSize: 11, fontWeight: 700, color: '#6B7280' }}>Select many photos or videos at one time</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setShowUploadOptions(false)}
                style={{ minHeight: 44, border: 'none', borderRadius: 14, background: '#F3F4F6', color: '#6B7280', fontSize: 13, fontWeight: 850 }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showBatchCamera && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 250, background: '#05070A', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px', color: 'white', background: 'linear-gradient(180deg, rgba(0,0,0,0.78), rgba(0,0,0,0))', zIndex: 2 }}>
            <button
              type="button"
              onClick={closeBatchCamera}
              style={{ minWidth: 44, minHeight: 44, borderRadius: 14, border: 'none', background: 'rgba(255,255,255,0.12)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              aria-label="Close batch camera"
            >
              <X size={20} color="white" />
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 900 }}>Batch Camera</p>
              <p style={{ margin: '2px 0 0', fontSize: 11, opacity: 0.72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selectedProject?.address || 'Selected project'}
              </p>
            </div>
            <div style={{ borderRadius: 999, background: 'rgba(217,157,38,0.18)', color: '#FBD38D', padding: '8px 11px', fontSize: 12, fontWeight: 900 }}>
              {previewFiles.length}/{MAX_PROGRESS_UPLOAD_FILES} queued
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            <video
              ref={batchCameraVideoRef}
              autoPlay
              muted
              playsInline
              style={{ width: '100%', height: '100%', objectFit: 'cover', background: '#111827' }}
            />
            {cameraError && (
              <div style={{ position: 'absolute', left: 14, right: 14, bottom: 18, borderRadius: 18, background: 'rgba(255,255,255,0.94)', padding: 16, textAlign: 'center', boxShadow: '0 14px 30px rgba(0,0,0,0.24)' }}>
                <p style={{ margin: 0, color: '#111827', fontSize: 14, fontWeight: 900 }}>Camera unavailable</p>
                <p style={{ margin: '6px 0 14px', color: '#6B7280', fontSize: 12, lineHeight: 1.45 }}>{cameraError}</p>
                <div style={{ display: 'grid', gap: 8 }}>
                  <button
                    type="button"
                    onClick={openCamera}
                    style={{ minHeight: 44, border: 'none', borderRadius: 12, background: '#D99D26', color: 'white', fontSize: 13, fontWeight: 900 }}
                  >
                    Use Device Camera
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      closeBatchCamera();
                      openFilePicker();
                    }}
                    style={{ minHeight: 44, border: '1px solid #E5E7EB', borderRadius: 12, background: 'white', color: '#374151', fontSize: 13, fontWeight: 850 }}
                  >
                    Choose From Library
                  </button>
                </div>
              </div>
            )}
          </div>

          <div style={{ background: 'rgba(5,7,10,0.96)', padding: '10px 14px 18px', color: 'white' }}>
            {previewUrls.length > 0 && (
              <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 10 }}>
                {previewUrls.slice(-8).map((url, offset) => {
                  const index = Math.max(0, previewUrls.length - 8) + offset;
                  const file = previewFiles[index];
                  return (
                    <div key={url} style={{ width: 52, height: 52, borderRadius: 12, overflow: 'hidden', background: '#111827', border: '1px solid rgba(255,255,255,0.12)', flexShrink: 0 }}>
                      {file && isVideoMedia(file) ? (
                        <video src={url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} muted playsInline />
                      ) : (
                        <img src={url} alt={`Queued ${index + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 76px 1fr', alignItems: 'center', gap: 12 }}>
              <button
                type="button"
                onClick={openFilePicker}
                disabled={previewFiles.length >= MAX_PROGRESS_UPLOAD_FILES}
                style={{ minHeight: 46, border: '1px solid rgba(255,255,255,0.14)', borderRadius: 14, background: 'rgba(255,255,255,0.08)', color: 'white', fontSize: 12, fontWeight: 850, opacity: previewFiles.length >= MAX_PROGRESS_UPLOAD_FILES ? 0.48 : 1 }}
              >
                Add Library
              </button>
              <button
                type="button"
                onClick={captureBatchPhoto}
                disabled={!cameraReady || Boolean(cameraError) || previewFiles.length >= MAX_PROGRESS_UPLOAD_FILES}
                style={{ width: 76, height: 76, borderRadius: 38, border: '5px solid rgba(255,255,255,0.65)', background: cameraReady && !cameraError && previewFiles.length < MAX_PROGRESS_UPLOAD_FILES ? '#D99D26' : '#6B7280', boxShadow: '0 0 0 5px rgba(255,255,255,0.14)', opacity: cameraReady && !cameraError && previewFiles.length < MAX_PROGRESS_UPLOAD_FILES ? 1 : 0.6 }}
                aria-label="Capture progress photo"
              />
              <button
                type="button"
                onClick={() => {
                  closeBatchCamera();
                  if (previewFiles.length) void handleUpload();
                }}
                disabled={!previewFiles.length || uploading}
                style={{ minHeight: 46, border: 'none', borderRadius: 14, background: previewFiles.length ? '#16A34A' : 'rgba(255,255,255,0.12)', color: 'white', fontSize: 12, fontWeight: 900, opacity: uploading ? 0.7 : 1 }}
              >
                {uploading ? 'Uploading...' : `Upload ${previewFiles.length || ''}`.trim()}
              </button>
            </div>
          </div>
        </div>
      )}

      {lightbox && (
        <div onClick={() => setLightbox(null)} style={{ position: 'fixed', inset: 0, zIndex: 260, background: 'rgba(0,0,0,0.95)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {lightbox.isVideo ? (
            <video src={lightbox.src} controls autoPlay style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 8 }} onClick={event => event.stopPropagation()} />
          ) : (
            <img src={lightbox.src} alt="Project photo" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          )}
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
