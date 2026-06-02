import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  ArrowLeft,
  Camera,
  CheckCircle2,
  Clock,
  FileImage,
  FolderOpen,
  ImagePlus,
  MapPin,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Search,
  StickyNote,
  Tag,
  Trash2,
  Upload,
  WifiOff,
  X,
} from 'lucide-react';
import api from '../lib/api';
import { useAuthStore } from '../store/authStore';
import {
  appendProgressUploadAudit,
  PROGRESS_MEDIA_ACCEPT,
  prepareProgressUploadFile,
  type ProgressCaptureSource,
} from '../lib/progressUpload';

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
  note_id?: string | null;
  note_text?: string | null;
  note_user_name?: string | null;
  upload_ip_address?: string | null;
  capture_latitude?: number | null;
  capture_longitude?: number | null;
  capture_accuracy?: number | null;
  capture_source?: string | null;
  capture_recorded_at?: string | null;
  batch_id?: string | null;
  batch_note?: string | null;
  individual_note?: string | null;
  label?: string | null;
  uploaded_at?: string | null;
  captured_at?: string | null;
  timezone?: string | null;
  upload_status?: string | null;
}

interface LightboxMedia {
  src: string;
  isVideo: boolean;
}

type UploadStatus = 'queued' | 'uploading' | 'uploaded' | 'failed';

const PHOTO_LABELS = [
  'Before',
  'During',
  'After',
  'Issue',
  'Damage',
  'Inspection',
  'Materials',
  'Progress',
  'Completed Work',
  'Change Order',
  'Safety Concern',
  'Other',
] as const;

const DEFAULT_PHOTO_LABEL = 'Progress';
const SUPPORTED_MEDIA_TYPES = /^(image|video)\//;
const SUPPORTED_FILE_EXTENSIONS = /\.(avif|bmp|dib|gif|heic|heif|jpe?g|jfif|pjpeg|pjp|png|tiff?|webp|dng|mp4|mov|qt|m4v|webm|avi|mkv|mpe?g|3gp|3g2|hevc|mts|m2ts)$/i;

function makeBatchId() {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `bt-${random}`;
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

function isVideoMedia(item: Pick<ProjectPhoto, 'filename' | 'mime_type'> | File) {
  if (item instanceof File) return item.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|avi|mkv|mpeg|mpg|3gp)$/i.test(item.name);
  return Boolean(item.mime_type?.startsWith('video/')) || /\.(mp4|mov|m4v|webm|avi|mkv|mpeg|mpg|3gp)$/i.test(item.filename);
}

function groupPhotosByDay(photos: ProjectPhoto[]) {
  return photos.reduce<{ date: string; photos: ProjectPhoto[] }[]>((groups, photo) => {
    const value = photo.taken_at || photo.created_at;
    const date = new Date(value).toLocaleDateString('en-US', {
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
}

function auditLabel(photo: ProjectPhoto) {
  if (photo.capture_source === 'batch_camera') return 'Live camera';
  if (photo.capture_source === 'device_camera') return 'Device camera';
  if (photo.capture_source === 'library') return 'Library import';
  if (photo.capture_source === 'desktop') return 'Desktop upload';
  return 'Upload audit';
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
  const [batchNote, setBatchNote] = useState('');
  const [batchLabel, setBatchLabel] = useState(DEFAULT_PHOTO_LABEL);
  const [photos, setPhotos] = useState<ProjectPhoto[]>([]);
  const [previewFiles, setPreviewFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [previewSources, setPreviewSources] = useState<ProgressCaptureSource[]>([]);
  const [individualNotes, setIndividualNotes] = useState<string[]>([]);
  const [individualLabels, setIndividualLabels] = useState<string[]>([]);
  const [uploadStatuses, setUploadStatuses] = useState<UploadStatus[]>([]);
  const [uploadProgress, setUploadProgress] = useState<number[]>([]);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [activeBatchId, setActiveBatchId] = useState('');
  const [labelFilter, setLabelFilter] = useState('');
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
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

  const queuedCount = uploadStatuses.filter(status => status === 'queued').length;
  const failedCount = uploadStatuses.filter(status => status === 'failed').length;
  const uploadedCount = uploadStatuses.filter(status => status === 'uploaded').length;
  const uploadableCount = uploadStatuses.filter(status => status === 'queued' || status === 'failed').length;
  const aggregateProgress = previewFiles.length
    ? Math.round(uploadProgress.reduce((total, value) => total + value, 0) / previewFiles.length)
    : 0;

  const visiblePhotos = useMemo(() => {
    const filtered = labelFilter ? photos.filter(photo => photo.label === labelFilter) : photos;
    return [...filtered].sort((a, b) => {
      const left = new Date(a.captured_at || a.taken_at || a.uploaded_at || a.created_at).getTime();
      const right = new Date(b.captured_at || b.taken_at || b.uploaded_at || b.created_at).getTime();
      return sortOrder === 'oldest' ? left - right : right - left;
    });
  }, [labelFilter, photos, sortOrder]);

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

  const clearUploadQueue = useCallback(() => {
    setPreviewFiles([]);
    setPreviewSources([]);
    setIndividualNotes([]);
    setIndividualLabels([]);
    setUploadStatuses([]);
    setUploadProgress([]);
    setUploadErrors([]);
    setActiveBatchId('');
    setBatchNote('');
    setBatchLabel(DEFAULT_PHOTO_LABEL);
    setPreviewUrls(current => {
      clearPreviewUrls(current);
      return [];
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (cameraInputRef.current) cameraInputRef.current.value = '';
  }, []);

  const selectProject = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    localStorage.setItem(storageKey, projectId);
    setShowProjectSelector(false);
    setProjectSearch('');
    clearUploadQueue();
  }, [clearUploadQueue, storageKey]);

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

  const isSupportedFile = (file: File) => {
    return SUPPORTED_MEDIA_TYPES.test(file.type) || SUPPORTED_FILE_EXTENSIONS.test(file.name);
  };

  const addPreviewFiles = (files: File[], source: ProgressCaptureSource = 'library') => {
    if (!files.length) return;
    const validFiles = files.filter(isSupportedFile);
    if (validFiles.length < files.length) {
      window.setTimeout(() => toast.error('Unsupported files were skipped. Use image or video media files.'), 0);
    }
    if (!validFiles.length) return;
    setPreviewFiles(current => {
      const existing = new Set(current.map(fileKey));
      const acceptedFiles = validFiles.filter(file => !existing.has(fileKey(file)));
      if (!acceptedFiles.length) return current;
      setActiveBatchId(value => value || makeBatchId());
      setPreviewUrls(urls => [...urls, ...acceptedFiles.map(file => URL.createObjectURL(file))]);
      setPreviewSources(currentSources => [...currentSources, ...acceptedFiles.map(() => source)]);
      setIndividualNotes(notes => [...notes, ...acceptedFiles.map(() => '')]);
      setIndividualLabels(labels => [...labels, ...acceptedFiles.map(() => batchLabel)]);
      setUploadStatuses(statuses => [...statuses, ...acceptedFiles.map(() => 'queued' as UploadStatus)]);
      setUploadProgress(progress => [...progress, ...acceptedFiles.map(() => 0)]);
      setUploadErrors(errors => [...errors, ...acceptedFiles.map(() => '')]);
      return [...current, ...acceptedFiles];
    });
  };

  const removePreviewFile = (index: number) => {
    if (uploadStatuses[index] === 'uploading') {
      toast.error('Wait for this item to finish before removing it');
      return;
    }
    setPreviewUrls(urls => {
      const next = [...urls];
      const [removed] = next.splice(index, 1);
      if (removed) URL.revokeObjectURL(removed);
      return next;
    });
    setPreviewFiles(files => files.filter((_, itemIndex) => itemIndex !== index));
    setPreviewSources(sources => sources.filter((_, itemIndex) => itemIndex !== index));
    setIndividualNotes(notes => notes.filter((_, itemIndex) => itemIndex !== index));
    setIndividualLabels(labels => labels.filter((_, itemIndex) => itemIndex !== index));
    setUploadStatuses(statuses => statuses.filter((_, itemIndex) => itemIndex !== index));
    setUploadProgress(progress => progress.filter((_, itemIndex) => itemIndex !== index));
    setUploadErrors(errors => errors.filter((_, itemIndex) => itemIndex !== index));
  };

  const updateIndividualNote = (index: number, value: string) => {
    setIndividualNotes(notes => notes.map((note, itemIndex) => itemIndex === index ? value : note));
  };

  const updateIndividualLabel = (index: number, value: string) => {
    setIndividualLabels(labels => labels.map((label, itemIndex) => itemIndex === index ? value : label));
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
      addPreviewFiles([file], 'batch_camera');
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
    addPreviewFiles(files, event.currentTarget === cameraInputRef.current ? 'device_camera' : 'library');
    event.currentTarget.value = '';
  };

  const cancelUpload = () => {
    clearUploadQueue();
  };

  const uploadQueueIndexes = async (indexes: number[]) => {
    if (!selectedProjectId) {
      setShowProjectSelector(true);
      toast.error('Choose a project before uploading');
      return { successCount: 0, failedCount: indexes.length };
    }
    if (!previewFiles.length) return;
    setUploading(true);
    const batchId = activeBatchId || makeBatchId();
    setActiveBatchId(batchId);
    let successCount = 0;
    let failedTotal = 0;
    const successIndexes = new Set<number>();
    const failedIndexes = new Set<number>();

    try {
      for (const index of indexes) {
        const file = previewFiles[index];
        if (!file) continue;
        setUploadStatuses(statuses => statuses.map((status, itemIndex) => itemIndex === index ? 'uploading' : status));
        setUploadErrors(errors => errors.map((error, itemIndex) => itemIndex === index ? '' : error));
        setUploadProgress(progress => progress.map((value, itemIndex) => itemIndex === index ? Math.max(value, 5) : value));

        try {
          const preparedFile = await prepareProgressUploadFile(file);
          const formData = new FormData();
          formData.append('photo_type', 'progress');
          formData.append('batch_id', batchId);
          formData.append('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
          formData.append('label', individualLabels[index] || batchLabel || DEFAULT_PHOTO_LABEL);
          formData.append('batch_sequence', String(index + 1));
          if (batchNote.trim()) formData.append('batch_note', batchNote.trim());
          if (individualNotes[index]?.trim()) formData.append('individual_note', individualNotes[index].trim());
          await appendProgressUploadAudit(formData, [preparedFile], [previewSources[index] || 'unknown'], {
            batchId,
            batchNote: batchNote.trim(),
            labels: [individualLabels[index] || batchLabel || DEFAULT_PHOTO_LABEL],
            individualNotes: [individualNotes[index] || ''],
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            batchSequenceStart: index + 1,
          });
          formData.append('photos', preparedFile, preparedFile.name);

          await api.post(`/projects/${selectedProjectId}/photos?type=progress`, formData, {
            headers: { 'Content-Type': 'multipart/form-data' },
            onUploadProgress: event => {
              if (!event.total) return;
              const percent = Math.min(98, Math.round((event.loaded / event.total) * 100));
              setUploadProgress(progress => progress.map((value, itemIndex) => itemIndex === index ? percent : value));
            },
          });

          successCount += 1;
          successIndexes.add(index);
          failedIndexes.delete(index);
          setUploadStatuses(statuses => statuses.map((status, itemIndex) => itemIndex === index ? 'uploaded' : status));
          setUploadProgress(progress => progress.map((value, itemIndex) => itemIndex === index ? 100 : value));
        } catch (err: any) {
          failedTotal += 1;
          failedIndexes.add(index);
          const message = err.response?.data?.error
            || (navigator.onLine ? 'Upload failed. Check the file and retry.' : 'No connection. Retry when service returns.');
          setUploadStatuses(statuses => statuses.map((status, itemIndex) => itemIndex === index ? 'failed' : status));
          setUploadProgress(progress => progress.map((value, itemIndex) => itemIndex === index ? 0 : value));
          setUploadErrors(errors => errors.map((error, itemIndex) => itemIndex === index ? message : error));
        }
      }

      if (successCount) {
        await loadPhotos(selectedProjectId);
      }

      setPreviewUrls(urls => {
        return urls.filter((url, index) => {
          const keep = failedIndexes.has(index) || (!successIndexes.has(index) && !indexes.includes(index));
          if (!keep) URL.revokeObjectURL(url);
          return keep;
        });
      });

      const shouldKeep = (_: unknown, index: number) => failedIndexes.has(index) || (!successIndexes.has(index) && !indexes.includes(index));
      setPreviewFiles(files => files.filter(shouldKeep));
      setPreviewSources(sources => sources.filter(shouldKeep));
      setIndividualNotes(notes => notes.filter(shouldKeep));
      setIndividualLabels(labels => labels.filter(shouldKeep));
      setUploadErrors(errors => errors.filter(shouldKeep));
      setUploadProgress(progress => progress.filter(shouldKeep).map(() => 0));
      setUploadStatuses(statuses => statuses.filter((_, index) => shouldKeep(null, index)).map(status => status === 'failed' ? 'failed' : 'queued'));

      if (successCount && failedTotal) {
        toast.error(`${successCount} uploaded, ${failedTotal} failed. Retry the failed item${failedTotal === 1 ? '' : 's'}.`);
      } else if (successCount) {
        toast.success(`${successCount} progress item${successCount === 1 ? '' : 's'} added to project`);
        clearUploadQueue();
      } else if (failedTotal) {
        toast.error(navigator.onLine ? 'Upload failed. Retry the queued items.' : 'No connection. Photos are still queued for retry.');
      }

      return { successCount, failedCount: failedTotal };
    } finally {
      setUploading(false);
    }
  };

  const handleUpload = async () => {
    const indexes = uploadStatuses
      .map((status, index) => (status === 'queued' || status === 'failed' ? index : -1))
      .filter(index => index >= 0);
    if (!indexes.length) return;
    await uploadQueueIndexes(indexes);
  };

  const retryUpload = async (index: number) => {
    await uploadQueueIndexes([index]);
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

  const groupedPhotos = groupPhotosByDay(visiblePhotos);

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
            Add Photos
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={PROGRESS_MEDIA_ACCEPT}
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
              <div>
                <p style={{ margin: 0, color: '#111827', fontWeight: 900, fontSize: 15 }}>Photo Batch</p>
                <p style={{ margin: '2px 0 0', color: '#6B7280', fontSize: 11, fontWeight: 700 }}>
                  {queuedCount} queued / {uploadedCount} uploaded / {failedCount} failed
                </p>
              </div>
              <button onClick={cancelUpload} disabled={uploading} style={{ width: 34, height: 34, borderRadius: 10, border: 'none', background: '#F3F4F6', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: uploading ? 0.5 : 1 }}>
                <X size={16} color="#6B7280" />
              </button>
            </div>
            {!navigator.onLine && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderRadius: 13, background: '#FFF7ED', border: '1px solid #FED7AA', color: '#9A3412', padding: '9px 10px', marginBottom: 10 }}>
                <WifiOff size={15} color="#EA580C" />
                <span style={{ fontSize: 11, fontWeight: 850 }}>No connection detected. Keep this screen open and retry when service returns.</span>
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8, marginBottom: 12 }}>
              <label style={{ display: 'grid', gap: 5 }}>
                <span style={{ color: '#6B7280', fontSize: 11, fontWeight: 900, textTransform: 'uppercase' }}>Batch label</span>
                <select
                  value={batchLabel}
                  onChange={event => {
                    const nextLabel = event.target.value;
                    setBatchLabel(nextLabel);
                    setIndividualLabels(labels => labels.map(label => label || nextLabel));
                  }}
                  disabled={uploading}
                  style={{ width: '100%', border: '1px solid #E5E7EB', borderRadius: 12, padding: '10px 12px', color: '#111827', fontSize: 14, fontWeight: 800, background: 'white' }}
                >
                  {PHOTO_LABELS.map(option => <option key={option} value={option}>{option}</option>)}
                </select>
              </label>
              <label style={{ display: 'grid', gap: 5 }}>
                <span style={{ color: '#6B7280', fontSize: 11, fontWeight: 900, textTransform: 'uppercase' }}>Batch note</span>
                <textarea
                  value={batchNote}
                  onChange={event => setBatchNote(event.target.value)}
                  disabled={uploading}
                  placeholder="Optional note for the whole batch"
                  rows={2}
                  style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #E5E7EB', borderRadius: 12, padding: '10px 12px', color: '#111827', fontSize: 14, resize: 'vertical', minHeight: 46 }}
                />
              </label>
            </div>
            {uploading && (
              <div style={{ borderRadius: 12, background: '#F3F4F6', overflow: 'hidden', marginBottom: 12 }}>
                <div style={{ height: 8, width: `${aggregateProgress}%`, background: 'linear-gradient(135deg, #D99D26, #C4891F)', transition: 'width 180ms ease' }} />
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10, marginBottom: 12 }}>
              {previewUrls.map((url, index) => (
                <div key={url} style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: 10, border: '1px solid #E5E7EB', borderRadius: 14, padding: 8, background: uploadStatuses[index] === 'failed' ? '#FEF2F2' : '#FFFFFF' }}>
                  <div style={{ position: 'relative', width: 92, height: 92, borderRadius: 10, overflow: 'hidden', background: '#F3F4F6' }}>
                    <div aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <FileImage size={24} color="#9CA3AF" />
                    </div>
                    {isVideoMedia(previewFiles[index]) ? (
                      <>
                        <video src={url} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} muted playsInline />
                        <PlayCircle size={24} color="white" style={{ position: 'absolute', inset: 0, margin: 'auto', filter: 'drop-shadow(0 1px 4px rgba(0,0,0,0.65))' }} />
                      </>
                    ) : (
                      <img
                        src={url}
                        alt=""
                        onError={event => { event.currentTarget.style.display = 'none'; }}
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    )}
                    <span style={{ position: 'absolute', left: 6, bottom: 6, borderRadius: 999, background: 'rgba(17,24,39,0.78)', color: 'white', padding: '3px 6px', fontSize: 9, fontWeight: 900 }}>
                      {String(index + 1).padStart(2, '0')}
                    </span>
                  </div>
                  <div style={{ minWidth: 0, display: 'grid', gap: 7 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <p style={{ margin: 0, minWidth: 0, color: '#111827', fontSize: 12, fontWeight: 900, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{previewFiles[index]?.name || 'Selected photo'}</p>
                      <button
                        type="button"
                        onClick={() => removePreviewFile(index)}
                        disabled={uploading || uploadStatuses[index] === 'uploading'}
                        aria-label="Remove photo from batch"
                        style={{ width: 32, height: 32, border: 'none', borderRadius: 10, background: '#F3F4F6', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: uploading ? 0.55 : 1 }}
                      >
                        <Trash2 size={15} color="#6B7280" />
                      </button>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 6 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid #E5E7EB', borderRadius: 10, padding: '7px 8px', background: 'white' }}>
                        <Tag size={13} color="#D99D26" />
                        <select
                          value={individualLabels[index] || batchLabel}
                          onChange={event => updateIndividualLabel(index, event.target.value)}
                          disabled={uploading}
                          style={{ minWidth: 0, flex: 1, border: 'none', outline: 'none', background: 'transparent', color: '#111827', fontSize: 12, fontWeight: 800 }}
                        >
                          {PHOTO_LABELS.map(option => <option key={option} value={option}>{option}</option>)}
                        </select>
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid #E5E7EB', borderRadius: 10, padding: '7px 8px', background: 'white' }}>
                        <StickyNote size={13} color="#6B7280" />
                        <input
                          value={individualNotes[index] || ''}
                          onChange={event => updateIndividualNote(index, event.target.value)}
                          disabled={uploading}
                          placeholder="Optional note for this photo"
                          style={{ minWidth: 0, flex: 1, border: 'none', outline: 'none', background: 'transparent', color: '#111827', fontSize: 12 }}
                        />
                      </label>
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ color: uploadStatuses[index] === 'failed' ? '#B91C1C' : uploadStatuses[index] === 'uploaded' ? '#15803D' : '#6B7280', fontSize: 10, fontWeight: 900, textTransform: 'uppercase' }}>
                          {uploadStatuses[index]}
                        </span>
                        {uploadStatuses[index] === 'failed' && (
                          <button
                            type="button"
                            onClick={() => retryUpload(index)}
                            disabled={uploading}
                            style={{ border: 'none', borderRadius: 9, background: '#DC2626', color: 'white', padding: '6px 8px', fontSize: 10, fontWeight: 900, display: 'flex', alignItems: 'center', gap: 4 }}
                          >
                            <RotateCcw size={12} color="white" />
                            Retry
                          </button>
                        )}
                      </div>
                      {(uploadStatuses[index] === 'uploading' || uploadStatuses[index] === 'uploaded') && (
                        <div style={{ height: 5, borderRadius: 999, background: '#E5E7EB', overflow: 'hidden', marginTop: 5 }}>
                          <div style={{ width: `${uploadProgress[index] || 0}%`, height: '100%', background: uploadStatuses[index] === 'uploaded' ? '#16A34A' : '#D99D26', transition: 'width 160ms ease' }} />
                        </div>
                      )}
                      {uploadErrors[index] && (
                        <p style={{ margin: '5px 0 0', color: '#B91C1C', fontSize: 10, lineHeight: 1.35, fontWeight: 750 }}>{uploadErrors[index]}</p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
              <button
                onClick={openFilePicker}
                type="button"
                disabled={uploading}
                style={{ minHeight: 44, border: '1px solid #F3D08A', borderRadius: 12, background: '#FFFBEB', color: '#92400E', fontSize: 12, fontWeight: 850, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                <ImagePlus size={15} color="#D99D26" />
                Add More
              </button>
              <button
                onClick={openBatchCamera}
                type="button"
                disabled={uploading}
                style={{ minHeight: 44, border: '1px solid #D1D5DB', borderRadius: 12, background: '#F9FAFB', color: '#374151', fontSize: 12, fontWeight: 850, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                <Camera size={15} color="#374151" />
                Batch Camera
              </button>
            </div>
            <button
              onClick={handleUpload}
              disabled={uploading || uploadableCount === 0}
              style={{ width: '100%', border: 'none', borderRadius: 13, padding: '12px 14px', background: 'linear-gradient(135deg, #D99D26, #C4891F)', color: 'white', fontSize: 14, fontWeight: 850, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: uploading ? 0.72 : 1 }}
            >
              <Upload size={17} color="white" />
              {uploading ? `Uploading ${aggregateProgress}%` : failedCount ? `Retry ${failedCount} Failed Item${failedCount === 1 ? '' : 's'}` : `Upload ${uploadableCount} Item${uploadableCount === 1 ? '' : 's'}`}
            </button>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '2px 2px 10px' }}>
          <p style={{ margin: 0, color: '#6B7280', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            {visiblePhotos.length} Progress Item{visiblePhotos.length === 1 ? '' : 's'}
          </p>
          {photosLoading && <RefreshCw size={14} color="#9CA3AF" style={{ animation: 'spin 0.8s linear infinite' }} />}
        </div>

        {photos.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid #E5E7EB', borderRadius: 12, background: 'white', padding: '9px 10px' }}>
              <Tag size={14} color="#D99D26" />
              <select
                value={labelFilter}
                onChange={event => setLabelFilter(event.target.value)}
                style={{ minWidth: 0, flex: 1, border: 'none', outline: 'none', background: 'transparent', color: '#111827', fontSize: 12, fontWeight: 850 }}
              >
                <option value="">All labels</option>
                {PHOTO_LABELS.map(option => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
            <button
              type="button"
              onClick={() => setSortOrder(value => value === 'newest' ? 'oldest' : 'newest')}
              style={{ border: '1px solid #E5E7EB', borderRadius: 12, background: 'white', color: '#111827', padding: '9px 10px', fontSize: 12, fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
            >
              <Clock size={14} color="#6B7280" />
              {sortOrder === 'newest' ? 'Newest first' : 'Oldest first'}
            </button>
          </div>
        )}

        {photos.length === 0 ? (
          <div style={{ textAlign: 'center', background: 'white', borderRadius: 18, padding: '44px 18px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)' }}>
            <ImagePlus size={42} color="#D1D5DB" />
            <p style={{ margin: '12px 0 4px', color: '#374151', fontSize: 15, fontWeight: 850 }}>No progress photos yet</p>
            <p style={{ margin: 0, color: '#9CA3AF', fontSize: 12 }}>Choose multiple pictures at once, or open the camera and add shots before uploading.</p>
          </div>
        ) : visiblePhotos.length === 0 ? (
          <div style={{ textAlign: 'center', background: 'white', borderRadius: 18, padding: '34px 18px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)' }}>
            <FileImage size={36} color="#D1D5DB" />
            <p style={{ margin: '10px 0 4px', color: '#374151', fontSize: 14, fontWeight: 850 }}>No photos match this filter</p>
            <button type="button" onClick={() => setLabelFilter('')} style={{ marginTop: 8, border: 'none', borderRadius: 11, background: '#111827', color: 'white', padding: '9px 12px', fontSize: 12, fontWeight: 900 }}>Clear filter</button>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 16 }}>
            {groupedPhotos.map(group => (
              <section key={group.date}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 9 }}>
                  <div>
                    <p style={{ margin: 0, color: '#111827', fontSize: 14, fontWeight: 900 }}>{group.date}</p>
                    <p style={{ margin: '2px 0 0', color: '#6B7280', fontSize: 11, fontWeight: 700 }}>{group.photos.length} progress item{group.photos.length === 1 ? '' : 's'}</p>
                  </div>
                  <span style={{ borderRadius: 999, background: '#EEF2FF', color: '#3730A3', padding: '5px 8px', fontSize: 10, fontWeight: 900 }}>
                    By time taken
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 9 }}>
                  {group.photos.map(photo => {
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
                        <div style={{ aspectRatio: '1 / 1', background: '#E5E7EB', position: 'relative' }}>
                          {isVideo ? (
                            <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                              <video src={src} style={{ width: '100%', height: '100%', objectFit: 'cover' }} preload="metadata" muted playsInline />
                              <PlayCircle size={30} color="white" style={{ position: 'absolute', inset: 0, margin: 'auto', filter: 'drop-shadow(0 1px 4px rgba(0,0,0,0.65))' }} />
                            </div>
                          ) : (
                            <img src={src} alt={photo.caption || photo.original_name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          )}
                          {photo.label && (
                            <span style={{ position: 'absolute', left: 6, top: 6, borderRadius: 999, background: 'rgba(217,157,38,0.92)', color: 'white', padding: '4px 7px', fontSize: 9, fontWeight: 900 }}>
                              {photo.label}
                            </span>
                          )}
                          {(photo.note_id || photo.individual_note || photo.batch_note) && (
                            <span style={{ position: 'absolute', right: 6, top: 6, borderRadius: 999, background: 'rgba(17,24,39,0.78)', color: 'white', padding: '4px 7px', fontSize: 9, fontWeight: 900 }}>
                              Note
                            </span>
                          )}
                        </div>
                        <div style={{ padding: 9 }}>
                          <p style={{ margin: 0, color: '#111827', fontSize: 11, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{photo.individual_note || photo.batch_note || photo.caption || photo.note_text || photo.original_name || (isVideo ? 'Project video' : 'Progress photo')}</p>
                          <p style={{ margin: '3px 0 0', color: '#6B7280', fontSize: 10 }}>{formatDateTime(photo.captured_at || photo.taken_at || photo.uploaded_at || photo.created_at)}</p>
                          {(photo.uploader_name || photo.uploaded_by_name) && (
                            <p style={{ margin: '2px 0 0', color: '#D99D26', fontSize: 10, fontWeight: 700 }}>{photo.uploader_name || photo.uploaded_by_name}</p>
                          )}
                          <p style={{ margin: '2px 0 0', color: photo.capture_latitude ? '#16A34A' : '#9CA3AF', fontSize: 10, fontWeight: 750 }}>{auditLabel(photo)}{photo.capture_latitude ? ' / GPS' : ''}{photo.batch_id ? ' / Batch' : ''}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
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
            <p style={{ margin: 0, color: '#111827', fontSize: 18, fontWeight: 900 }}>Add Photos</p>
            <p style={{ margin: '4px 0 16px', color: '#6B7280', fontSize: 12, lineHeight: 1.45 }}>
              Capture photos or select a whole batch before sending it to the project.
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
              {previewFiles.length} queued
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
                    <div key={url} style={{ position: 'relative', width: 52, height: 52, borderRadius: 12, overflow: 'hidden', background: '#111827', border: '1px solid rgba(255,255,255,0.12)', flexShrink: 0 }}>
                      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <FileImage size={18} color="rgba(255,255,255,0.62)" />
                      </div>
                      {file && isVideoMedia(file) ? (
                        <video src={url} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} muted playsInline />
                      ) : (
                        <img
                          src={url}
                          alt=""
                          onError={event => { event.currentTarget.style.display = 'none'; }}
                          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                        />
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
                style={{ minHeight: 46, border: '1px solid rgba(255,255,255,0.14)', borderRadius: 14, background: 'rgba(255,255,255,0.08)', color: 'white', fontSize: 12, fontWeight: 850 }}
              >
                Add Library
              </button>
              <button
                type="button"
                onClick={captureBatchPhoto}
                disabled={!cameraReady || Boolean(cameraError)}
                style={{ width: 76, height: 76, borderRadius: 38, border: '5px solid rgba(255,255,255,0.65)', background: cameraReady && !cameraError ? '#D99D26' : '#6B7280', boxShadow: '0 0 0 5px rgba(255,255,255,0.14)', opacity: cameraReady && !cameraError ? 1 : 0.6 }}
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
