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
  Minus,
  Plus,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Search,
  StickyNote,
  Tag,
  Trash2,
  ZoomIn,
  WifiOff,
  X,
} from 'lucide-react';
import api from '../lib/api';
import { useAuthStore } from '../store/authStore';
import {
  appendProgressUploadAudit,
  PROGRESS_MEDIA_ACCEPT,
  prepareProgressUploadFile,
  type ProgressUploadLocation,
  type ProgressCaptureSource,
} from '../lib/progressUpload';
import { MOBILE_DATA_CHANGED_EVENT, notifyMobileDataChanged } from '../lib/mobileEvents';
import VoiceTextarea from '../components/VoiceTextarea';

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
  uploaded_by?: string;
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

type UploadStatus = 'queued' | 'uploading' | 'uploaded' | 'failed';
type NoteSyncStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'failed';
type PhotoPurpose = 'progress' | 'scope' | 'both';

interface UploadItem {
  id: string;
  projectId: string;
  file: File;
  previewUrl: string;
  source: ProgressCaptureSource;
  note: string;
  label: string;
  batchNote: string;
  purpose: PhotoPurpose;
  batchId: string;
  sequence: number;
  status: UploadStatus;
  progress: number;
  error: string;
  uploadedPhotoId?: string;
  noteStatus: NoteSyncStatus;
  noteError: string;
  captureLocation?: ProgressUploadLocation | null;
}

interface CachedCaptureLocation extends ProgressUploadLocation {
  recordedAt: number;
}

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
const DEFAULT_SCOPE_LABEL = 'Inspection';
const PHOTO_PURPOSES: { value: PhotoPurpose; label: string; helper: string }[] = [
  { value: 'progress', label: 'Progress', helper: 'Progress history' },
  { value: 'scope', label: 'Scope', helper: 'Scope of work' },
  { value: 'both', label: 'Both', helper: 'Progress + scope' },
];
const SUPPORTED_MEDIA_TYPES = /^(image|video)\//;
const SUPPORTED_FILE_EXTENSIONS = /\.(avif|bmp|dib|gif|heic|heif|jpe?g|jfif|pjpeg|pjp|png|tiff?|webp|dng|mp4|mov|qt|m4v|webm|avi|mkv|mpe?g|3gp|3g2|hevc|mts|m2ts)$/i;
const MOBILE_PROGRESS_UPLOAD_CONCURRENCY = 3;
const LIVE_CAMERA_CAPTURE_MAX_DIMENSION = 1800;
const LIVE_CAMERA_IMAGE_QUALITY = 0.88;
const CAPTURE_LOCATION_MAX_AGE_MS = 2 * 60 * 1000;
const CAPTURE_LOCATION_TIMEOUT_MS = 1200;

function makeBatchId() {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `bt-${random}`;
}

function makeUploadItemId(file: File) {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 10);
  return `bt-upload-${file.lastModified}-${file.size}-${random}`;
}

function imageExtensionForMime(mimeType: string) {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('webp')) return 'webp';
  return 'jpg';
}

function normalizePhotoPurpose(value: string | null): PhotoPurpose {
  const requested = String(value || '').trim().toLowerCase();
  if (requested === 'scope' || requested === 'scope_of_work') return 'scope';
  if (requested === 'both') return 'both';
  return 'progress';
}

function contextsForPurpose(purpose: PhotoPurpose) {
  if (purpose === 'both') return ['general', 'progress', 'scope'];
  return ['general', purpose];
}

function primaryTypeForPurpose(purpose: PhotoPurpose) {
  return purpose === 'scope' ? 'scope' : 'progress';
}

function defaultLabelForPurpose(purpose: PhotoPurpose) {
  return purpose === 'scope' ? DEFAULT_SCOPE_LABEL : DEFAULT_PHOTO_LABEL;
}

function nounForPurpose(purpose: PhotoPurpose) {
  if (purpose === 'scope') return 'scope photos';
  if (purpose === 'both') return 'progress and scope photos';
  return 'progress photos';
}

function isPhotoContextEnabled(value: number | boolean | undefined, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  return fallback;
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

function playShutterSound() {
  if (typeof window === 'undefined') return;
  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextCtor) return;

  try {
    const context = new AudioContextCtor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(1450, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(720, context.currentTime + 0.055);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.11, context.currentTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.075);
    oscillator.connect(gain);
    gain.connect(context.destination);
    void context.resume();
    oscillator.start();
    oscillator.stop(context.currentTime + 0.08);
    window.setTimeout(() => {
      try {
        void context.close();
      } catch {
        // Browsers can close the short-lived audio context automatically.
      }
    }, 160);
  } catch {
    // Audio is best-effort and may be blocked when the device is muted.
  }
}

function captureVideoFrameBlob(video: HTMLVideoElement): Promise<Blob | null> {
  if (!video.videoWidth || !video.videoHeight) return Promise.resolve(null);
  const scale = Math.min(1, LIVE_CAMERA_CAPTURE_MAX_DIMENSION / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) return Promise.resolve(null);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', LIVE_CAMERA_IMAGE_QUALITY));
}

async function applyTrackZoom(track: MediaStreamTrack | null, value: number) {
  if (!track?.applyConstraints) return false;
  try {
    await track.applyConstraints({ advanced: [{ zoom: value } as any] } as any);
    return true;
  } catch {
    return false;
  }
}

export default function MobilePhotos() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuthStore();
  const requestedProjectId = searchParams.get('projectId') || '';
  const requestedPurpose = normalizePhotoPurpose(searchParams.get('mode') || searchParams.get('purpose'));
  const cameraFirstRequested = searchParams.get('camera') === '1' || searchParams.get('take') === '1';
  const storageKey = `buildtrack-mobile-photo-project:${user?.id || 'session'}`;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const cameraFirstHandledRef = useRef('');
  const previewUrlsRef = useRef<string[]>([]);
  const batchCameraVideoRef = useRef<HTMLVideoElement>(null);
  const batchCameraStreamRef = useRef<MediaStream | null>(null);
  const batchCameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const imageCaptureRef = useRef<any>(null);
  const uploadSequenceRef = useRef(0);
  const activeUploadCountRef = useRef(0);
  const refreshPhotosTimerRef = useRef<number | null>(null);
  const shotFeedbackTimerRef = useRef<number | null>(null);
  const uploadItemsRef = useRef<UploadItem[]>([]);
  const activeBatchIdRef = useRef('');
  const uploadQueueRef = useRef<UploadItem[]>([]);
  const captureInFlightRef = useRef(false);
  const captureLocationRef = useRef<CachedCaptureLocation | null>(null);
  const captureLocationPromiseRef = useRef<Promise<CachedCaptureLocation | null> | null>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [batchNote, setBatchNote] = useState('');
  const [batchLabel, setBatchLabel] = useState(defaultLabelForPurpose(requestedPurpose));
  const [photoPurpose, setPhotoPurpose] = useState<PhotoPurpose>(requestedPurpose);
  const [photos, setPhotos] = useState<ProjectPhoto[]>([]);
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const [activeBatchId, setActiveBatchId] = useState('');
  const [labelFilter, setLabelFilter] = useState('');
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [loading, setLoading] = useState(true);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [activeUploadCount, setActiveUploadCount] = useState(0);
  const [showProjectSelector, setShowProjectSelector] = useState(false);
  const [showUploadOptions, setShowUploadOptions] = useState(false);
  const [showCaptureDetails, setShowCaptureDetails] = useState(false);
  const [showPhotoFilters, setShowPhotoFilters] = useState(false);
  const [showBatchCamera, setShowBatchCamera] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [cameraZoomSupported, setCameraZoomSupported] = useState(false);
  const [cameraZoom, setCameraZoom] = useState(1);
  const [cameraZoomMin, setCameraZoomMin] = useState(1);
  const [cameraZoomMax, setCameraZoomMax] = useState(1);
  const [cameraZoomStep, setCameraZoomStep] = useState(0.1);
  const [captureProcessing, setCaptureProcessing] = useState(false);
  const [captureButtonPressed, setCaptureButtonPressed] = useState(false);
  const [shotFeedbackActive, setShotFeedbackActive] = useState(false);
  const [shotFeedbackMessage, setShotFeedbackMessage] = useState('');
  const [batchNoteSaving, setBatchNoteSaving] = useState(false);
  const [batchNoteSyncMessage, setBatchNoteSyncMessage] = useState('');
  const [lightbox, setLightbox] = useState<LightboxMedia | null>(null);
  const [deletingPhotoId, setDeletingPhotoId] = useState('');

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

  const queuedCount = uploadItems.filter(item => item.status === 'queued').length;
  const uploadingCount = uploadItems.filter(item => item.status === 'uploading').length;
  const failedCount = uploadItems.filter(item => item.status === 'failed').length;
  const uploadedCount = uploadItems.filter(item => item.status === 'uploaded').length;
  const uploadedPhotoIds = uploadItems
    .filter(item => item.status === 'uploaded' && item.uploadedPhotoId)
    .map(item => item.uploadedPhotoId as string);
  const dirtyIndividualNoteCount = uploadItems.filter(item => item.status === 'uploaded' && item.noteStatus === 'dirty').length;
  const retryableCount = failedCount;
  const uploading = activeUploadCount > 0;
  const aggregateProgress = uploadItems.length
    ? Math.round(uploadItems.reduce((total, item) => total + item.progress, 0) / uploadItems.length)
    : 0;
  const uploadComplete = uploadItems.length > 0 && failedCount === 0 && uploadedCount === uploadItems.length;
  const uploadStatusMessage = uploadComplete
    ? `All ${uploadedCount} photo${uploadedCount === 1 ? '' : 's'} secured in BuildTrack`
    : `${uploadedCount} secured / ${uploadingCount} uploading / ${queuedCount} queued / ${failedCount} failed`;

  const visiblePhotos = useMemo(() => {
    const filtered = labelFilter ? photos.filter(photo => photo.label === labelFilter) : photos;
    return [...filtered].sort((a, b) => {
      const left = new Date(a.captured_at || a.taken_at || a.uploaded_at || a.created_at).getTime();
      const right = new Date(b.captured_at || b.taken_at || b.uploaded_at || b.created_at).getTime();
      return sortOrder === 'oldest' ? left - right : right - left;
    });
  }, [labelFilter, photos, sortOrder]);

  const photoBaseUrl = (api.defaults.baseURL || '').replace('/api', '');

  useEffect(() => {
    setPhotoPurpose(current => current === requestedPurpose ? current : requestedPurpose);
    setBatchLabel(current => (
      current === DEFAULT_PHOTO_LABEL || current === DEFAULT_SCOPE_LABEL
        ? defaultLabelForPurpose(requestedPurpose)
        : current
    ));
  }, [requestedPurpose]);

  const loadPhotos = useCallback(async (projectId: string) => {
    if (!projectId) return;
    setPhotosLoading(true);
    try {
      const res = await api.get(`/projects/${projectId}/photos?type=${photoPurpose === 'scope' ? 'scope' : 'progress'}`);
      setPhotos(Array.isArray(res.data) ? res.data : []);
    } catch {
      toast.error(`Failed to load ${nounForPurpose(photoPurpose)}`);
    } finally {
      setPhotosLoading(false);
    }
  }, [photoPurpose]);

  const clearUploadQueue = useCallback(() => {
    uploadQueueRef.current = [];
    activeBatchIdRef.current = '';
    setUploadItems(current => {
      current.forEach(item => URL.revokeObjectURL(item.previewUrl));
      return [];
    });
    setActiveBatchId('');
    uploadSequenceRef.current = 0;
    setBatchNote('');
    setBatchNoteSyncMessage('');
    setBatchLabel(defaultLabelForPurpose(photoPurpose));
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (cameraInputRef.current) cameraInputRef.current.value = '';
  }, [photoPurpose]);

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
    const refreshPhotosScreen = () => {
      if (selectedProjectId) void loadPhotos(selectedProjectId);
      else void loadProjects();
    };
    const refreshWhenVisible = () => {
      if (!document.hidden) refreshPhotosScreen();
    };
    window.addEventListener(MOBILE_DATA_CHANGED_EVENT, refreshPhotosScreen);
    window.addEventListener('focus', refreshWhenVisible);
    window.addEventListener('pageshow', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener(MOBILE_DATA_CHANGED_EVENT, refreshPhotosScreen);
      window.removeEventListener('focus', refreshWhenVisible);
      window.removeEventListener('pageshow', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [loadPhotos, loadProjects, selectedProjectId]);

  useEffect(() => {
    previewUrlsRef.current = uploadItems.map(item => item.previewUrl);
    uploadItemsRef.current = uploadItems;
  }, [uploadItems]);

  useEffect(() => {
    activeBatchIdRef.current = activeBatchId;
  }, [activeBatchId]);

  useEffect(() => () => clearPreviewUrls(previewUrlsRef.current), []);

  useEffect(() => () => {
    if (refreshPhotosTimerRef.current) window.clearTimeout(refreshPhotosTimerRef.current);
    if (shotFeedbackTimerRef.current) window.clearTimeout(shotFeedbackTimerRef.current);
  }, []);

  const fileKey = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;

  const isSupportedFile = (file: File) => {
    return SUPPORTED_MEDIA_TYPES.test(file.type) || SUPPORTED_FILE_EXTENSIONS.test(file.name);
  };

  const adjustActiveUploadCount = useCallback((delta: number) => {
    activeUploadCountRef.current = Math.max(0, activeUploadCountRef.current + delta);
    setActiveUploadCount(activeUploadCountRef.current);
  }, []);

  const schedulePhotoRefresh = useCallback((projectId: string) => {
    if (projectId !== selectedProjectId) return;
    if (refreshPhotosTimerRef.current) window.clearTimeout(refreshPhotosTimerRef.current);
    refreshPhotosTimerRef.current = window.setTimeout(() => {
      refreshPhotosTimerRef.current = null;
      void loadPhotos(projectId);
    }, 650);
  }, [loadPhotos, selectedProjectId]);

  const getCaptureLocation = useCallback((force = false): Promise<CachedCaptureLocation | null> => {
    const existing = captureLocationRef.current;
    const freshEnough = existing && Date.now() - existing.recordedAt < CAPTURE_LOCATION_MAX_AGE_MS;
    if (!force && freshEnough) return Promise.resolve(existing);
    if (!navigator.geolocation) return Promise.resolve(existing || null);
    if (captureLocationPromiseRef.current) return captureLocationPromiseRef.current;

    const locationPromise: Promise<CachedCaptureLocation | null> = new Promise<CachedCaptureLocation | null>(resolve => {
      navigator.geolocation.getCurrentPosition(
        position => {
          const nextLocation = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            recordedAt: Date.now(),
          };
          captureLocationRef.current = nextLocation;
          resolve(nextLocation);
        },
        () => resolve(existing || null),
        {
          enableHighAccuracy: true,
          maximumAge: CAPTURE_LOCATION_MAX_AGE_MS,
          timeout: CAPTURE_LOCATION_TIMEOUT_MS,
        }
      );
    }).finally(() => {
      captureLocationPromiseRef.current = null;
    });
    captureLocationPromiseRef.current = locationPromise;

    return locationPromise;
  }, []);

  const triggerShotFeedback = useCallback((message = 'Captured') => {
    try {
      navigator.vibrate?.([18, 28, 18]);
    } catch {
      // Vibration support varies by mobile browser.
    }
    playShutterSound();
    setShotFeedbackMessage(message);
    setShotFeedbackActive(true);
    if (shotFeedbackTimerRef.current) window.clearTimeout(shotFeedbackTimerRef.current);
    shotFeedbackTimerRef.current = window.setTimeout(() => {
      shotFeedbackTimerRef.current = null;
      setShotFeedbackActive(false);
    }, 280);
  }, []);

  const triggerCapturePressFeedback = useCallback(() => {
    try {
      navigator.vibrate?.(12);
    } catch {
      // Vibration support varies by mobile browser.
    }
    setCaptureButtonPressed(true);
    setShotFeedbackMessage('Taking photo...');
    setShotFeedbackActive(true);
    if (shotFeedbackTimerRef.current) window.clearTimeout(shotFeedbackTimerRef.current);
    shotFeedbackTimerRef.current = window.setTimeout(() => {
      shotFeedbackTimerRef.current = null;
      setShotFeedbackActive(false);
      setCaptureButtonPressed(false);
    }, 220);
  }, []);

  const updatePhotoInList = useCallback((photoId: string, patch: Partial<ProjectPhoto>) => {
    setPhotos(current => current.map(photo => photo.id === photoId ? { ...photo, ...patch } : photo));
  }, []);

  const addUploadedPhotosToList = useCallback((projectId: string, uploadedPhotos: any[], fallbackFile: File) => {
    if (projectId !== selectedProjectId || !uploadedPhotos.length) return;
    setPhotos(current => {
      const existingIds = new Set(current.map(photo => photo.id));
      const nextPhotos = uploadedPhotos
        .filter(photo => photo?.id && !existingIds.has(photo.id))
        .map(photo => ({
          created_at: photo.created_at || photo.uploaded_at || new Date().toISOString(),
          mime_type: photo.mime_type || fallbackFile.type,
          uploader_name: photo.uploader_name || user?.name,
          uploaded_by_name: photo.uploaded_by_name || user?.name,
          uploaded_by: photo.uploaded_by || user?.id,
          can_delete_correction: true,
          ...photo,
        }));
      return nextPhotos.length ? [...nextPhotos, ...current] : current;
    });
  }, [selectedProjectId, user?.id, user?.name]);

  const uploadItemNow = useCallback(async (item: UploadItem) => {
    setUploadItems(current => current.map(uploadItem => uploadItem.id === item.id
      ? { ...uploadItem, status: 'uploading', progress: Math.max(uploadItem.progress, 5), error: '' }
      : uploadItem
    ));
    adjustActiveUploadCount(1);

    try {
      const preparedFile = await prepareProgressUploadFile(item.file);
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const uploadType = primaryTypeForPurpose(item.purpose);
      const label = item.label || defaultLabelForPurpose(item.purpose);
      const formData = new FormData();
      formData.append('photo_type', uploadType);
      formData.append('photo_contexts', JSON.stringify(contextsForPurpose(item.purpose)));
      formData.append('timezone', timezone);
      formData.append('label', label);
      formData.append('batch_sequence', String(item.sequence));
      if (item.batchNote) formData.append('batch_note', item.batchNote);
      if (item.note.trim()) formData.append('individual_note', item.note.trim());
      await appendProgressUploadAudit(formData, [preparedFile], [item.source], {
        batchId: item.batchId,
        batchNote: item.batchNote,
        labels: [label],
        individualNotes: [item.note || ''],
        timezone,
        batchSequenceStart: item.sequence,
        location: item.captureLocation || null,
        skipDeviceLocation: item.source === 'batch_camera' && !item.captureLocation,
      });
      formData.append('photos', preparedFile, preparedFile.name);

      const response = await api.post(`/projects/${item.projectId}/photos?type=${uploadType}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: event => {
          if (!event.total) return;
          const percent = Math.min(98, Math.round((event.loaded / event.total) * 100));
          setUploadItems(current => current.map(uploadItem => uploadItem.id === item.id
            ? { ...uploadItem, progress: percent }
            : uploadItem
          ));
        },
      });

      const uploadedPhotos = Array.isArray(response.data?.photos) ? response.data.photos : [];
      const uploadedPhoto = uploadedPhotos[0] || null;
      addUploadedPhotosToList(item.projectId, uploadedPhotos, preparedFile);
      setUploadItems(current => current.map(uploadItem => uploadItem.id === item.id
        ? {
            ...uploadItem,
            status: 'uploaded',
            progress: 100,
            error: '',
            uploadedPhotoId: uploadedPhoto?.id || uploadItem.uploadedPhotoId,
            noteStatus: uploadItem.note.trim() ? 'saved' : 'idle',
            noteError: '',
          }
        : uploadItem
      ));
      notifyMobileDataChanged({ entity: 'photo', action: 'uploaded', projectId: item.projectId });
      schedulePhotoRefresh(item.projectId);
    } catch (err: any) {
      const message = err.response?.data?.error
        || (navigator.onLine ? 'Upload failed. Check the file and retry.' : 'No connection. Retry when service returns.');
      setUploadItems(current => current.map(uploadItem => uploadItem.id === item.id
        ? { ...uploadItem, status: 'failed', progress: 0, error: message }
        : uploadItem
      ));
      toast.error(message);
    } finally {
      adjustActiveUploadCount(-1);
    }
  }, [addUploadedPhotosToList, adjustActiveUploadCount, schedulePhotoRefresh]);

  const pumpUploadQueue = useCallback(() => {
    while (activeUploadCountRef.current < MOBILE_PROGRESS_UPLOAD_CONCURRENCY && uploadQueueRef.current.length > 0) {
      const item = uploadQueueRef.current.shift();
      if (!item) continue;
      void uploadItemNow(item).finally(() => {
        pumpUploadQueue();
      });
    }
  }, [uploadItemNow]);

  const uploadItemsImmediately = useCallback((items: UploadItem[]) => {
    if (!items.length) return;
    uploadQueueRef.current.push(...items);
    pumpUploadQueue();
  }, [pumpUploadQueue]);

  const addPreviewFiles = (
    files: File[],
    source: ProgressCaptureSource = 'library',
    options: { captureLocation?: ProgressUploadLocation | null } = {}
  ) => {
    if (!files.length) return;
    if (!selectedProjectId) {
      setShowProjectSelector(true);
      toast.error(`Choose a project before adding ${nounForPurpose(photoPurpose)} or videos`);
      return;
    }

    const validFiles = files.filter(isSupportedFile);
    if (validFiles.length < files.length) {
      window.setTimeout(() => toast.error('Unsupported files were skipped. Use image or video media files.'), 0);
    }
    if (!validFiles.length) return;

    const existing = new Set(uploadItemsRef.current.map(item => fileKey(item.file)));
    const acceptedFiles = validFiles.filter(file => !existing.has(fileKey(file)));
    if (!acceptedFiles.length) return;

    const batchId = activeBatchIdRef.current || makeBatchId();
    if (!activeBatchIdRef.current) {
      activeBatchIdRef.current = batchId;
      setActiveBatchId(batchId);
    }
    const currentBatchNote = batchNote.trim();
    const currentLabel = batchLabel || defaultLabelForPurpose(photoPurpose);
    const currentPurpose = photoPurpose;
    const nextItems = acceptedFiles.map(file => {
      uploadSequenceRef.current += 1;
      return {
        id: makeUploadItemId(file),
        projectId: selectedProjectId,
        file,
        previewUrl: URL.createObjectURL(file),
        source,
        note: '',
        label: currentLabel,
        batchNote: currentBatchNote,
        purpose: currentPurpose,
        batchId,
        sequence: uploadSequenceRef.current,
        status: 'queued' as UploadStatus,
        progress: 0,
        error: '',
        noteStatus: 'idle' as NoteSyncStatus,
        noteError: '',
        captureLocation: options.captureLocation || null,
      };
    });

    setUploadItems(current => {
      const next = [...current, ...nextItems];
      uploadItemsRef.current = next;
      return next;
    });
    void uploadItemsImmediately(nextItems);
  };

  const removeUploadItem = (itemId: string) => {
    const item = uploadItems.find(uploadItem => uploadItem.id === itemId);
    if (item?.status === 'uploading') {
      toast.error('Wait for this item to finish before removing it');
      return;
    }
    setUploadItems(current => {
      current.forEach(uploadItem => {
        if (uploadItem.id === itemId) URL.revokeObjectURL(uploadItem.previewUrl);
      });
      return current.filter(uploadItem => uploadItem.id !== itemId);
    });
  };

  const updateUploadItemNote = (itemId: string, value: string) => {
    setUploadItems(current => current.map(item => {
      if (item.id !== itemId) return item;
      return {
        ...item,
        note: value,
        noteStatus: item.status === 'uploaded' ? 'dirty' : item.noteStatus,
        noteError: '',
      };
    }));
  };

  const updateUploadItemLabel = (itemId: string, value: string) => {
    setUploadItems(current => current.map(item => item.id === itemId ? { ...item, label: value } : item));
  };

  const saveIndividualNote = async (itemId: string) => {
    const item = uploadItemsRef.current.find(uploadItem => uploadItem.id === itemId);
    if (!item) return;
    if (item.status !== 'uploaded' || !item.uploadedPhotoId) {
      toast.error('Wait until this picture is secured before saving its note');
      return;
    }

    const noteText = item.note.trim();
    setUploadItems(current => current.map(uploadItem => uploadItem.id === itemId
      ? { ...uploadItem, noteStatus: 'saving', noteError: '' }
      : uploadItem
    ));

    try {
      const response = await api.put(`/projects/${item.projectId}/photos/${item.uploadedPhotoId}/note`, { note: noteText });
      const updatedPhoto = response.data?.photo;
      if (updatedPhoto?.id) {
        setPhotos(current => current.map(photo => photo.id === updatedPhoto.id ? { ...photo, ...updatedPhoto } : photo));
      } else {
        updatePhotoInList(item.uploadedPhotoId, {
          individual_note: noteText || null,
          batch_note: null,
          caption: noteText || undefined,
          note_text: noteText || null,
        });
      }
      setUploadItems(current => current.map(uploadItem => uploadItem.id === itemId
        ? { ...uploadItem, noteStatus: 'saved', noteError: '' }
        : uploadItem
      ));
      notifyMobileDataChanged({ entity: 'photo_note', action: noteText ? 'saved' : 'cleared', projectId: item.projectId });
      toast.success(noteText ? 'Photo note secured' : 'Photo note cleared');
    } catch (err: any) {
      const message = err.response?.data?.error || 'Failed to save photo note';
      setUploadItems(current => current.map(uploadItem => uploadItem.id === itemId
        ? { ...uploadItem, noteStatus: 'failed', noteError: message }
        : uploadItem
      ));
      toast.error(message);
    }
  };

  const saveBatchNoteToUploads = async () => {
    if (!selectedProjectId) {
      setShowProjectSelector(true);
      return;
    }

    const noteText = batchNote.trim();
    const currentItems = uploadItemsRef.current.filter(item => item.projectId === selectedProjectId);
    if (!currentItems.length) {
      toast.error('Take pictures before saving a batch note');
      return;
    }

    setBatchNoteSaving(true);
    setBatchNoteSyncMessage('');
    setUploadItems(current => current.map(item => item.projectId === selectedProjectId
      ? { ...item, batchNote: noteText }
      : item
    ));

    const securedIds = currentItems
      .filter(item => item.status === 'uploaded' && item.uploadedPhotoId)
      .map(item => item.uploadedPhotoId as string);
    const pendingCount = currentItems.filter(item => item.status !== 'uploaded').length;

    if (!securedIds.length) {
      setBatchNoteSaving(false);
      setBatchNoteSyncMessage(`Note queued for ${pendingCount} picture${pendingCount === 1 ? '' : 's'} still uploading.`);
      toast.success('Batch note will upload with the queued pictures');
      return;
    }

    try {
      await api.put(`/projects/${selectedProjectId}/photos/batch-note`, {
        photo_ids: securedIds,
        note: noteText,
      });
      setPhotos(current => current.map(photo => securedIds.includes(photo.id)
        ? { ...photo, batch_note: noteText || null, individual_note: photo.individual_note || null }
        : photo
      ));
      setBatchNoteSyncMessage(`${securedIds.length} secured picture${securedIds.length === 1 ? '' : 's'} updated${pendingCount ? `; ${pendingCount} queued picture${pendingCount === 1 ? '' : 's'} will carry this note.` : '.'}`);
      notifyMobileDataChanged({ entity: 'photo_batch_note', action: noteText ? 'saved' : 'cleared', projectId: selectedProjectId });
      toast.success(noteText ? 'Batch note secured in BuildTrack' : 'Batch note cleared');
    } catch (err: any) {
      const message = err.response?.data?.error || 'Failed to save batch note';
      setBatchNoteSyncMessage(message);
      toast.error(message);
    } finally {
      setBatchNoteSaving(false);
    }
  };

  const stopBatchCamera = useCallback(() => {
    batchCameraStreamRef.current?.getTracks().forEach(track => track.stop());
    batchCameraStreamRef.current = null;
    batchCameraTrackRef.current = null;
    imageCaptureRef.current = null;
    setCameraReady(false);
  }, []);

  const startBatchCamera = useCallback(async () => {
    setCameraError('');
    setCameraReady(false);
    setCameraZoomSupported(false);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('This device does not support the in-app camera. Use the device camera fallback below.');
      return;
    }

    try {
      stopBatchCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      const track = stream.getVideoTracks()[0] || null;
      batchCameraStreamRef.current = stream;
      batchCameraTrackRef.current = track;

      const ImageCaptureCtor = (window as any).ImageCapture;
      imageCaptureRef.current = ImageCaptureCtor && track ? new ImageCaptureCtor(track) : null;

      const capabilities = track?.getCapabilities?.() as any;
      const cameraTuning: Record<string, string>[] = [];
      if (Array.isArray(capabilities?.focusMode) && capabilities.focusMode.includes('continuous')) {
        cameraTuning.push({ focusMode: 'continuous' });
      }
      if (Array.isArray(capabilities?.exposureMode) && capabilities.exposureMode.includes('continuous')) {
        cameraTuning.push({ exposureMode: 'continuous' });
      }
      if (Array.isArray(capabilities?.whiteBalanceMode) && capabilities.whiteBalanceMode.includes('continuous')) {
        cameraTuning.push({ whiteBalanceMode: 'continuous' });
      }
      if (cameraTuning.length && track?.applyConstraints) {
        try {
          await track.applyConstraints({ advanced: cameraTuning } as any);
        } catch {
          // Some mobile browsers advertise controls they will not apply in every camera mode.
        }
      }

      if (capabilities?.zoom) {
        const min = Number(capabilities.zoom.min || 1);
        const max = Number(capabilities.zoom.max || min);
        const step = Number(capabilities.zoom.step || 0.1);
        setCameraZoomSupported(max > min);
        setCameraZoomMin(min);
        setCameraZoomMax(max);
        setCameraZoomStep(step);
        setCameraZoom(min);
        void applyTrackZoom(track, min);
      }

      if (batchCameraVideoRef.current) {
        batchCameraVideoRef.current.srcObject = stream;
        await batchCameraVideoRef.current.play();
      }
      void getCaptureLocation(false);
      setCameraReady(true);
    } catch {
      setCameraError('Camera access was not available. Use the device camera fallback or choose photos from the library.');
    }
  }, [getCaptureLocation, stopBatchCamera]);

  useEffect(() => {
    if (!showBatchCamera) {
      stopBatchCamera();
      return;
    }
    void startBatchCamera();
    return () => stopBatchCamera();
  }, [showBatchCamera, startBatchCamera, stopBatchCamera]);

  const updateCameraZoom = async (value: number) => {
    const nextZoom = Math.min(cameraZoomMax, Math.max(cameraZoomMin, value));
    setCameraZoom(nextZoom);
    const applied = await applyTrackZoom(batchCameraTrackRef.current, nextZoom);
    if (!applied) toast.error('Zoom is not available on this camera mode');
  };

  const stepCameraZoom = (direction: -1 | 1) => {
    void updateCameraZoom(cameraZoom + (direction * cameraZoomStep));
  };

  const captureBatchPhoto = async () => {
    const video = batchCameraVideoRef.current;
    if (captureInFlightRef.current) return;
    if (!video || !cameraReady) {
      toast.error('Camera is still getting ready');
      return;
    }
    if (!video.videoWidth || !video.videoHeight) {
      toast.error('Camera is still getting ready');
      return;
    }

    const capturedAt = Date.now();
    const captureLocation = captureLocationRef.current && Date.now() - captureLocationRef.current.recordedAt < CAPTURE_LOCATION_MAX_AGE_MS
      ? captureLocationRef.current
      : null;
    captureInFlightRef.current = true;
    setCaptureProcessing(true);
    triggerShotFeedback('Captured');
    try {
      const blob = await captureVideoFrameBlob(video);

      if (!blob) {
        toast.error('Camera capture failed');
        return;
      }

      const type = blob.type || 'image/jpeg';
      const file = new File([blob], `${primaryTypeForPurpose(photoPurpose)}-${capturedAt}.${imageExtensionForMime(type)}`, {
        type,
        lastModified: capturedAt,
      });
      addPreviewFiles([file], 'batch_camera', { captureLocation });
      void getCaptureLocation(false);
    } catch {
      toast.error('Camera capture failed');
    } finally {
      captureInFlightRef.current = false;
      setCaptureProcessing(false);
      setCaptureButtonPressed(false);
    }
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedProjectId) {
      setShowProjectSelector(true);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (cameraInputRef.current) cameraInputRef.current.value = '';
      toast.error(`Choose a project before adding ${nounForPurpose(photoPurpose)} or videos`);
      return;
    }

    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    const source = event.currentTarget === cameraInputRef.current ? 'device_camera' : 'library';
    const captureLocation = source === 'device_camera' && captureLocationRef.current && Date.now() - captureLocationRef.current.recordedAt < CAPTURE_LOCATION_MAX_AGE_MS
      ? captureLocationRef.current
      : null;
    addPreviewFiles(files, source, { captureLocation });
    if (source === 'device_camera') {
      setShowUploadOptions(false);
      triggerShotFeedback(files.length === 1 ? 'Photo added' : `${files.length} photos added`);
      void getCaptureLocation(false);
    }
    event.currentTarget.value = '';
  };

  const cancelUpload = () => {
    clearUploadQueue();
  };

  const retryUpload = (itemId: string) => {
    const item = uploadItems.find(uploadItem => uploadItem.id === itemId);
    if (!item || item.status === 'uploading') return;
    void uploadItemsImmediately([item]);
  };

  const retryFailedUploads = () => {
    const retryItems = uploadItems.filter(item => item.status === 'failed');
    if (!retryItems.length) return;
    void uploadItemsImmediately(retryItems);
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
    void getCaptureLocation(false);
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
    void getCaptureLocation(false);
    setShowUploadOptions(false);
    setShowBatchCamera(true);
  };

  const openCameraFirst = () => {
    if (!selectedProjectId) {
      setShowProjectSelector(true);
      return;
    }
    setShowUploadOptions(false);
    if (typeof navigator.mediaDevices?.getUserMedia === 'function') {
      openBatchCamera();
      return;
    }
    openCamera();
  };

  const closeBatchCamera = () => {
    setShowBatchCamera(false);
    stopBatchCamera();
  };

  const deleteProgressPhoto = async (photo: ProjectPhoto) => {
    if (!selectedProjectId || !photo.can_delete_correction || deletingPhotoId) return;
    const confirmed = window.confirm('Remove this uploaded project picture? This uses your one correction and then locks this upload record.');
    if (!confirmed) return;
    setDeletingPhotoId(photo.id);
    try {
      await api.delete(`/projects/${selectedProjectId}/photos/${photo.id}`);
      toast.success('Project picture removed. Correction is now locked.');
      notifyMobileDataChanged({ entity: 'photo', action: 'deleted', projectId: selectedProjectId });
      await loadPhotos(selectedProjectId);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to delete project picture');
    } finally {
      setDeletingPhotoId('');
    }
  };

  useEffect(() => {
    const requestKey = `${requestedProjectId || selectedProjectId}:camera`;
    if (!cameraFirstRequested || cameraFirstHandledRef.current === requestKey || loading || !selectedProjectId) return;
    cameraFirstHandledRef.current = requestKey;
    setShowUploadOptions(false);
    setShowBatchCamera(true);
  }, [cameraFirstRequested, loading, requestedProjectId, selectedProjectId]);

  const changePhotoPurpose = (purpose: PhotoPurpose) => {
    setPhotoPurpose(purpose);
    setLabelFilter('');
    setBatchLabel(current => (
      current === DEFAULT_PHOTO_LABEL || current === DEFAULT_SCOPE_LABEL
        ? defaultLabelForPurpose(purpose)
        : current
    ));
  };

  const projectSelector = (
    <div style={{ position: 'fixed', inset: 0, zIndex: 220, background: 'rgba(13,17,23,0.88)', display: 'flex', alignItems: 'flex-end' }}>
      <div style={{ width: '100%', maxHeight: '86vh', background: 'white', borderRadius: '22px 22px 0 0', padding: '16px 14px 24px', overflowY: 'auto' }}>
        <div style={{ width: 42, height: 4, background: '#E5E7EB', borderRadius: 2, margin: '0 auto 14px' }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <p style={{ color: '#111827', fontSize: 18, fontWeight: 800, margin: 0 }}>Choose Project</p>
            <p style={{ color: '#6B7280', fontSize: 12, margin: '3px 0 0' }}>Project photos and videos cannot be uploaded without a project.</p>
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
  const captureDetailsOpen = showCaptureDetails || uploadItems.length > 0 || Boolean(batchNote.trim());
  const filtersActive = Boolean(labelFilter) || sortOrder !== 'newest';
  const cameraPreviewTopInset = 'calc(62px + env(safe-area-inset-top))';
  const cameraPreviewBottomInset = uploadItems.length > 0
    ? 'calc(306px + env(safe-area-inset-bottom))'
    : cameraZoomSupported
      ? 'calc(172px + env(safe-area-inset-bottom))'
      : 'calc(122px + env(safe-area-inset-bottom))';

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
            <p style={{ margin: 0, fontSize: 16, fontWeight: 850 }}>{photoPurpose === 'scope' ? 'Scope Photos' : photoPurpose === 'both' ? 'Progress + Scope Photos' : 'Progress Photos'}</p>
            <p style={{ margin: '2px 0 0', color: '#D99D26', fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedProject ? selectedProject.address : 'No project selected'}
            </p>
          </div>
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
            onClick={openCameraFirst}
            style={{ minHeight: 50, width: '100%', border: 'none', borderRadius: 13, padding: '11px 14px', background: 'linear-gradient(135deg, #D99D26, #C4891F)', color: 'white', fontSize: 14, fontWeight: 950, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, whiteSpace: 'normal', textAlign: 'center', lineHeight: 1.15, boxShadow: '0 10px 20px rgba(217,157,38,0.24)' }}
          >
            <Camera size={18} color="white" />
            Take Pictures
          </button>
          <button
            onClick={openUploadOptions}
            style={{ minHeight: 44, width: '100%', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 13, padding: '9px 14px', background: 'rgba(255,255,255,0.09)', color: 'white', fontSize: 12, fontWeight: 850, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, whiteSpace: 'normal', textAlign: 'center', lineHeight: 1.15 }}
          >
            <ImagePlus size={16} color="#D99D26" />
            Upload From Device
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
            Choose a project to upload {nounForPurpose(photoPurpose)}
          </button>
        )}

        {selectedProject && (
          <div style={{ background: 'white', borderRadius: 16, padding: 14, boxShadow: '0 1px 8px rgba(0,0,0,0.06)', marginBottom: 12 }}>
            <p style={{ margin: 0, color: '#111827', fontSize: 13, fontWeight: 850 }}>{selectedProject.address}</p>
            <p style={{ margin: '3px 0 0', color: '#6B7280', fontSize: 12 }}>{selectedProject.job_name || selectedProject.status || 'Selected project'}</p>
            <div style={{ marginTop: 12, display: 'grid', gap: 7 }}>
              <span style={{ color: '#6B7280', fontSize: 11, fontWeight: 900, textTransform: 'uppercase' }}>Save photos as</span>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 7 }}>
                {PHOTO_PURPOSES.map(option => {
                  const active = photoPurpose === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => changePhotoPurpose(option.value)}
                      style={{
                        minHeight: 54,
                        border: active ? '1px solid #D99D26' : '1px solid #E5E7EB',
                        borderRadius: 13,
                        background: active ? '#FFFBEB' : '#F9FAFB',
                        color: active ? '#92400E' : '#374151',
                        padding: '8px 6px',
                        display: 'grid',
                        gap: 2,
                        alignContent: 'center',
                        textAlign: 'center',
                        boxShadow: active ? '0 8px 18px rgba(217,157,38,0.14)' : 'none',
                      }}
                    >
                      <span style={{ fontSize: 12, fontWeight: 950 }}>{option.label}</span>
                      <span style={{ fontSize: 9.5, fontWeight: 800, lineHeight: 1.2, color: active ? '#B45309' : '#6B7280' }}>{option.helper}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10, color: '#6B7280', fontSize: 11, fontWeight: 700 }}>
              <Clock size={13} color="#6B7280" />
              New photos and videos will be stamped with each file's captured time when available.
            </div>
            <button
              type="button"
              onClick={() => setShowCaptureDetails(value => !value)}
              style={{ width: '100%', minHeight: 48, marginTop: 12, border: '1px solid #E5E7EB', borderRadius: 13, background: '#F9FAFB', color: '#111827', padding: '9px 11px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, textAlign: 'left' }}
            >
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12, fontWeight: 950 }}>Photo details</span>
                <span style={{ display: 'block', marginTop: 2, color: '#6B7280', fontSize: 10.5, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {batchNote.trim() ? `${batchLabel} / batch note added` : `${batchLabel} label`}
                </span>
              </span>
              {captureDetailsOpen ? <Minus size={17} color="#6B7280" /> : <Plus size={17} color="#6B7280" />}
            </button>
            {captureDetailsOpen && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8, marginTop: 10 }}>
                <label style={{ display: 'grid', gap: 5 }}>
                  <span style={{ color: '#6B7280', fontSize: 11, fontWeight: 900, textTransform: 'uppercase' }}>Batch label</span>
                  <select
                    value={batchLabel}
                    onChange={event => setBatchLabel(event.target.value)}
                    style={{ width: '100%', border: '1px solid #E5E7EB', borderRadius: 12, padding: '10px 12px', color: '#111827', fontSize: 14, fontWeight: 800, background: 'white' }}
                  >
                    {PHOTO_LABELS.map(option => <option key={option} value={option}>{option}</option>)}
                  </select>
                </label>
                <label style={{ display: 'grid', gap: 5 }}>
                  <span style={{ color: '#6B7280', fontSize: 11, fontWeight: 900, textTransform: 'uppercase' }}>Batch note</span>
                  <VoiceTextarea
                    value={batchNote}
                    onChange={event => {
                      setBatchNote(event.target.value);
                      if (batchNoteSyncMessage) setBatchNoteSyncMessage('');
                    }}
                    placeholder="Optional note for this picture batch"
                    rows={2}
                    style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #E5E7EB', borderRadius: 12, padding: '10px 12px', color: '#111827', fontSize: 14, resize: 'vertical', minHeight: 46 }}
                  />
                </label>
                {uploadItems.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 7 }}>
                    <button
                      type="button"
                      onClick={() => void saveBatchNoteToUploads()}
                      disabled={batchNoteSaving || uploadItems.length === 0}
                      style={{ minHeight: 44, border: 'none', borderRadius: 12, background: batchNoteSaving ? '#9CA3AF' : '#16A34A', color: 'white', fontSize: 13, fontWeight: 950, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                    >
                      <CheckCircle2 size={16} color="white" />
                      {batchNoteSaving ? 'Saving Note...' : uploadedPhotoIds.length ? `Save Note To ${uploadedPhotoIds.length} Secured` : 'Queue Note With Photos'}
                    </button>
                    <p style={{ margin: 0, color: '#15803D', fontSize: 11, fontWeight: 850, lineHeight: 1.35 }}>
                      {batchNoteSyncMessage || (dirtyIndividualNoteCount ? `${dirtyIndividualNoteCount} individual photo note${dirtyIndividualNoteCount === 1 ? '' : 's'} still need Save Note.` : 'Batch notes stay attached to the uploaded photo records.')}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {uploadItems.length > 0 && (
          <div className={`bt-mobile-photo-upload-panel${uploadComplete ? ' bt-mobile-photo-upload-panel-complete' : ''}`} style={{ background: uploadComplete ? '#F0FDF4' : 'white', border: uploadComplete ? '1px solid #BBF7D0' : '1px solid transparent', borderRadius: 18, padding: 14, boxShadow: '0 2px 12px rgba(0,0,0,0.08)', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div>
                <p style={{ margin: 0, color: '#111827', fontWeight: 900, fontSize: 15 }}>Live photo upload</p>
                <p style={{ margin: '2px 0 0', color: uploadComplete ? '#15803D' : '#6B7280', fontSize: 11, fontWeight: 800 }}>
                  {uploadStatusMessage}
                </p>
              </div>
              <button onClick={cancelUpload} disabled={uploading} aria-label="Clear finished upload list" style={{ width: 34, height: 34, borderRadius: 10, border: 'none', background: uploadComplete ? '#DCFCE7' : '#F3F4F6', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: uploading ? 0.5 : 1 }}>
                <X size={16} color="#6B7280" />
              </button>
            </div>
            {uploadComplete && (
              <div className="bt-mobile-photo-secured-banner" style={{ display: 'flex', alignItems: 'center', gap: 8, borderRadius: 13, background: '#DCFCE7', border: '1px solid #86EFAC', color: '#166534', padding: '10px 11px', marginBottom: 10 }}>
                <CheckCircle2 size={17} color="#16A34A" />
                <span style={{ fontSize: 12, fontWeight: 900 }}>Secured in BuildTrack. Notes can still be saved from this screen.</span>
              </div>
            )}
            {!navigator.onLine && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderRadius: 13, background: '#FFF7ED', border: '1px solid #FED7AA', color: '#9A3412', padding: '9px 10px', marginBottom: 10 }}>
                <WifiOff size={15} color="#EA580C" />
                <span style={{ fontSize: 11, fontWeight: 850 }}>No connection detected. Keep this screen open and retry when service returns.</span>
              </div>
            )}
            <div style={{ borderRadius: 12, background: uploadComplete ? '#BBF7D0' : '#F3F4F6', overflow: 'hidden', marginBottom: 12 }}>
              <div style={{ height: 8, width: `${aggregateProgress}%`, background: uploadComplete ? '#16A34A' : 'linear-gradient(135deg, #D99D26, #C4891F)', transition: 'width 180ms ease' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', margin: '-6px 1px 11px', color: uploadComplete ? '#15803D' : '#6B7280', fontSize: 10, fontWeight: 900, textTransform: 'uppercase' }}>
              <span>{aggregateProgress}% uploaded</span>
              <span>{uploadedCount}/{uploadItems.length} complete</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(82px, 1fr))', gap: 8, marginBottom: 12 }}>
              {uploadItems.map(item => (
                <div key={`stack-${item.id}`} style={{ position: 'relative', aspectRatio: '1 / 1', borderRadius: 13, overflow: 'hidden', background: '#F3F4F6', border: `2px solid ${item.status === 'uploaded' ? '#16A34A' : item.status === 'failed' ? '#DC2626' : '#D99D26'}` }}>
                  <div aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <FileImage size={22} color="#9CA3AF" />
                  </div>
                  {isVideoMedia(item.file) ? (
                    <>
                      <video src={item.previewUrl} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} muted playsInline />
                      <PlayCircle size={22} color="white" style={{ position: 'absolute', inset: 0, margin: 'auto', filter: 'drop-shadow(0 1px 4px rgba(0,0,0,0.65))' }} />
                    </>
                  ) : (
                    <img
                      src={item.previewUrl}
                      alt=""
                      onError={event => { event.currentTarget.style.display = 'none'; }}
                      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  )}
                  <span style={{ position: 'absolute', left: 5, top: 5, borderRadius: 999, background: 'rgba(17,24,39,0.78)', color: 'white', padding: '3px 6px', fontSize: 9, fontWeight: 900 }}>
                    {String(item.sequence).padStart(2, '0')}
                  </span>
                  <span style={{ position: 'absolute', right: 5, top: 5, borderRadius: 999, background: item.purpose === 'scope' ? 'rgba(13,148,136,0.9)' : item.purpose === 'both' ? 'rgba(124,58,237,0.9)' : 'rgba(217,157,38,0.92)', color: 'white', padding: '3px 6px', fontSize: 8.5, fontWeight: 950 }}>
                    {item.purpose === 'both' ? 'Both' : item.purpose === 'scope' ? 'Scope' : 'Progress'}
                  </span>
                  <span style={{ position: 'absolute', right: 5, bottom: 5, minWidth: item.status === 'uploaded' ? 46 : 26, height: 22, borderRadius: 999, background: item.status === 'uploaded' ? '#16A34A' : item.status === 'failed' ? '#DC2626' : '#D99D26', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 6px', fontSize: item.status === 'uploaded' ? 8 : 9, fontWeight: 900 }}>
                    {item.status === 'uploaded' ? 'SECURE' : item.status === 'failed' ? '!' : `${Math.max(0, Math.min(99, item.progress || 0))}%`}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10, marginBottom: 12 }}>
              {uploadItems.map(item => (
                <div key={item.id} style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: 10, border: '1px solid #E5E7EB', borderRadius: 14, padding: 8, background: item.status === 'failed' ? '#FEF2F2' : '#FFFFFF' }}>
                  <div style={{ position: 'relative', width: 92, height: 92, borderRadius: 10, overflow: 'hidden', background: '#F3F4F6' }}>
                    <div aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <FileImage size={24} color="#9CA3AF" />
                    </div>
                    {isVideoMedia(item.file) ? (
                      <>
                        <video src={item.previewUrl} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} muted playsInline />
                        <PlayCircle size={24} color="white" style={{ position: 'absolute', inset: 0, margin: 'auto', filter: 'drop-shadow(0 1px 4px rgba(0,0,0,0.65))' }} />
                      </>
                    ) : (
                      <img
                        src={item.previewUrl}
                        alt=""
                        onError={event => { event.currentTarget.style.display = 'none'; }}
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    )}
                    <span style={{ position: 'absolute', left: 6, bottom: 6, borderRadius: 999, background: 'rgba(17,24,39,0.78)', color: 'white', padding: '3px 6px', fontSize: 9, fontWeight: 900 }}>
                      {String(item.sequence).padStart(2, '0')}
                    </span>
                  </div>
                  <div style={{ minWidth: 0, display: 'grid', gap: 7 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <p style={{ margin: 0, minWidth: 0, color: '#111827', fontSize: 12, fontWeight: 900, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.file.name || 'Selected photo'}</p>
                      <span style={{ flexShrink: 0, borderRadius: 999, background: item.purpose === 'scope' ? '#CCFBF1' : item.purpose === 'both' ? '#EDE9FE' : '#FEF3C7', color: item.purpose === 'scope' ? '#0F766E' : item.purpose === 'both' ? '#6D28D9' : '#B45309', padding: '4px 7px', fontSize: 9, fontWeight: 950 }}>
                        {item.purpose === 'both' ? 'Both' : item.purpose === 'scope' ? 'Scope' : 'Progress'}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeUploadItem(item.id)}
                        disabled={item.status === 'uploading'}
                        aria-label="Remove photo from batch"
                        style={{ width: 32, height: 32, border: 'none', borderRadius: 10, background: '#F3F4F6', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: item.status === 'uploading' ? 0.55 : 1 }}
                      >
                        <Trash2 size={15} color="#6B7280" />
                      </button>
                    </div>
                    <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 5, color: '#4B5563', fontSize: 10.5, fontWeight: 850 }}>
                      <Clock size={12} color="#D99D26" />
                      Captured {formatDateTime(item.file.lastModified ? new Date(item.file.lastModified).toISOString() : undefined)}
                    </p>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 6 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid #E5E7EB', borderRadius: 10, padding: '7px 8px', background: 'white' }}>
                        <Tag size={13} color="#D99D26" />
                        <select
                          value={item.label || batchLabel}
                          onChange={event => updateUploadItemLabel(item.id, event.target.value)}
                          disabled={item.status === 'uploading' || item.status === 'uploaded'}
                          style={{ minWidth: 0, flex: 1, border: 'none', outline: 'none', background: 'transparent', color: '#111827', fontSize: 12, fontWeight: 800 }}
                        >
                          {PHOTO_LABELS.map(option => <option key={option} value={option}>{option}</option>)}
                        </select>
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid #E5E7EB', borderRadius: 10, padding: '7px 8px', background: 'white' }}>
                        <StickyNote size={13} color="#6B7280" />
                        <VoiceTextarea
                          value={item.note || ''}
                          onChange={event => updateUploadItemNote(item.id, event.target.value)}
                          disabled={item.status === 'uploading' || item.noteStatus === 'saving'}
                          placeholder="Optional note for this photo"
                          rows={1}
                          wrapperStyle={{ minWidth: 0, flex: 1 }}
                          style={{ minWidth: 0, width: '100%', border: 'none', outline: 'none', background: 'transparent', color: '#111827', fontSize: 12, resize: 'none', minHeight: 34 }}
                        />
                      </label>
                      {item.status === 'uploaded' ? (
                        <button
                          type="button"
                          onClick={() => void saveIndividualNote(item.id)}
                          disabled={item.noteStatus === 'saving' || !item.uploadedPhotoId || !['dirty', 'failed'].includes(item.noteStatus)}
                          style={{
                            minHeight: 38,
                            border: 'none',
                            borderRadius: 10,
                            background: item.noteStatus === 'dirty' ? '#16A34A' : item.noteStatus === 'failed' ? '#DC2626' : '#E8F7EE',
                            color: item.noteStatus === 'dirty' || item.noteStatus === 'failed' ? 'white' : '#166534',
                            fontSize: 11,
                            fontWeight: 950,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 6,
                            opacity: item.noteStatus === 'saving' || !item.uploadedPhotoId ? 0.72 : 1,
                          }}
                        >
                          <CheckCircle2 size={14} color={item.noteStatus === 'dirty' || item.noteStatus === 'failed' ? 'white' : '#16A34A'} />
                          {item.noteStatus === 'saving' ? 'Saving Note...' : item.noteStatus === 'dirty' ? 'Save Note' : item.noteStatus === 'failed' ? 'Retry Note Save' : 'Note Secured'}
                        </button>
                      ) : (
                        <p style={{ margin: 0, color: '#6B7280', fontSize: 10.5, fontWeight: 800 }}>
                          Note will upload automatically with this picture.
                        </p>
                      )}
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ color: item.status === 'failed' ? '#B91C1C' : item.status === 'uploaded' ? '#15803D' : '#6B7280', fontSize: 10, fontWeight: 900, textTransform: 'uppercase' }}>
                          {item.status === 'uploaded' ? 'secured in BuildTrack' : item.status}
                        </span>
                        {item.status === 'failed' && (
                          <button
                            type="button"
                            onClick={() => retryUpload(item.id)}
                            style={{ border: 'none', borderRadius: 9, background: '#DC2626', color: 'white', padding: '6px 8px', fontSize: 10, fontWeight: 900, display: 'flex', alignItems: 'center', gap: 4 }}
                          >
                            <RotateCcw size={12} color="white" />
                            Retry
                          </button>
                        )}
                      </div>
                      {(item.status === 'uploading' || item.status === 'uploaded') && (
                        <div style={{ height: 5, borderRadius: 999, background: '#E5E7EB', overflow: 'hidden', marginTop: 5 }}>
                          <div style={{ width: `${item.progress || 0}%`, height: '100%', background: item.status === 'uploaded' ? '#16A34A' : '#D99D26', transition: 'width 160ms ease' }} />
                        </div>
                      )}
                      {item.error && (
                        <p style={{ margin: '5px 0 0', color: '#B91C1C', fontSize: 10, lineHeight: 1.35, fontWeight: 750 }}>{item.error}</p>
                      )}
                      {item.noteError && (
                        <p style={{ margin: '5px 0 0', color: '#B91C1C', fontSize: 10, lineHeight: 1.35, fontWeight: 750 }}>{item.noteError}</p>
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
                style={{ minHeight: 44, border: '1px solid #F3D08A', borderRadius: 12, background: '#FFFBEB', color: '#92400E', fontSize: 12, fontWeight: 850, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                <ImagePlus size={15} color="#D99D26" />
                Upload From Device
              </button>
              <button
                onClick={openCameraFirst}
                type="button"
                style={{ minHeight: 44, border: '1px solid #D1D5DB', borderRadius: 12, background: '#F9FAFB', color: '#374151', fontSize: 12, fontWeight: 850, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                <Camera size={15} color="#374151" />
                Take More Pictures
              </button>
            </div>
            {failedCount > 0 && (
              <button
                onClick={retryFailedUploads}
                disabled={retryableCount === 0}
                style={{ width: '100%', border: 'none', borderRadius: 13, padding: '12px 14px', background: '#DC2626', color: 'white', fontSize: 14, fontWeight: 850, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
              >
                <RotateCcw size={17} color="white" />
                Retry Failed Upload{failedCount === 1 ? '' : 's'}
              </button>
            )}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '2px 2px 10px' }}>
          <p style={{ margin: 0, color: '#6B7280', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            {visiblePhotos.length} {photoPurpose === 'scope' ? 'Scope' : 'Progress'} Item{visiblePhotos.length === 1 ? '' : 's'}
          </p>
          {photosLoading && <RefreshCw size={14} color="#9CA3AF" style={{ animation: 'spin 0.8s linear infinite' }} />}
        </div>

        {photos.length > 0 && (
          <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
            <button
              type="button"
              onClick={() => setShowPhotoFilters(value => !value)}
              style={{ minHeight: 44, border: filtersActive ? '1px solid #D99D26' : '1px solid #E5E7EB', borderRadius: 13, background: filtersActive ? '#FFFBEB' : 'white', color: filtersActive ? '#92400E' : '#111827', padding: '9px 11px', fontSize: 12, fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <Tag size={14} color={filtersActive ? '#D99D26' : '#6B7280'} />
                {filtersActive ? 'Filters active' : 'Filter and sort'}
              </span>
              {showPhotoFilters ? <Minus size={16} color="#6B7280" /> : <Plus size={16} color="#6B7280" />}
            </button>
            {showPhotoFilters && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
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
          </div>
        )}

        {photos.length === 0 ? (
          <div style={{ textAlign: 'center', background: 'white', borderRadius: 18, padding: '44px 18px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)' }}>
            <ImagePlus size={42} color="#D1D5DB" />
            <p style={{ margin: '12px 0 4px', color: '#374151', fontSize: 15, fontWeight: 850 }}>No {nounForPurpose(photoPurpose)} yet</p>
            <p style={{ margin: 0, color: '#9CA3AF', fontSize: 12 }}>Take pictures or choose files to add project media.</p>
            <button
              type="button"
              onClick={openCameraFirst}
              style={{ marginTop: 16, width: '100%', minHeight: 46, border: 'none', borderRadius: 13, background: 'linear-gradient(135deg, #D99D26, #C4891F)', color: 'white', fontSize: 13, fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}
            >
              <Camera size={17} color="white" />
              Take Pictures
            </button>
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
                    <p style={{ margin: '2px 0 0', color: '#6B7280', fontSize: 11, fontWeight: 700 }}>{group.photos.length} project item{group.photos.length === 1 ? '' : 's'}</p>
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
                    const progressContext = isPhotoContextEnabled(photo.show_in_progress, photo.photo_type === 'progress' || photo.photo_type === 'note');
                    const scopeContext = isPhotoContextEnabled(photo.show_in_scope, photo.photo_type === 'scope' || photo.photo_type === 'construction_plan');
                    return (
                      <div
                        key={photo.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setLightbox({ src, isVideo })}
                        onKeyDown={event => {
                          if (event.key !== 'Enter' && event.key !== ' ') return;
                          event.preventDefault();
                          setLightbox({ src, isVideo });
                        }}
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
                          {(progressContext || scopeContext) && (
                            <span style={{ position: 'absolute', left: 6, bottom: photo.can_delete_correction ? 53 : 6, borderRadius: 999, background: 'rgba(255,255,255,0.94)', color: scopeContext && progressContext ? '#6D28D9' : scopeContext ? '#0F766E' : '#B45309', padding: '4px 7px', fontSize: 9, fontWeight: 950, boxShadow: '0 4px 10px rgba(0,0,0,0.14)' }}>
                              {progressContext && scopeContext ? 'Progress + Scope' : scopeContext ? 'Scope' : 'Progress'}
                            </span>
                          )}
                          {photo.can_delete_correction && (
                            <button
                              type="button"
                              onClick={event => {
                                event.stopPropagation();
                                void deleteProgressPhoto(photo);
                              }}
                              disabled={deletingPhotoId === photo.id}
                              aria-label="Delete this progress picture as your one correction"
                              style={{
                                position: 'absolute',
                                left: 6,
                                bottom: 6,
                                minHeight: 44,
                                border: '1px solid #FECACA',
                                borderRadius: 12,
                                background: 'rgba(255,255,255,0.96)',
                                color: '#B91C1C',
                                padding: '0 10px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: 5,
                                fontSize: 11,
                                fontWeight: 900,
                                boxShadow: '0 4px 12px rgba(0,0,0,0.16)',
                                opacity: deletingPhotoId === photo.id ? 0.65 : 1,
                              }}
                            >
                              <Trash2 size={14} color="#B91C1C" />
                              {deletingPhotoId === photo.id ? 'Deleting' : 'Delete once'}
                            </button>
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
                      </div>
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
            <p style={{ margin: 0, color: '#111827', fontSize: 18, fontWeight: 900 }}>Add Project Media</p>
            <p style={{ margin: '4px 0 16px', color: '#6B7280', fontSize: 12, lineHeight: 1.45 }}>
              Capture photos or select a whole batch for {nounForPurpose(photoPurpose)}.
            </p>
            <div style={{ display: 'grid', gap: 10 }}>
              <button
                type="button"
                onClick={openCameraFirst}
                style={{ minHeight: 64, border: 'none', borderRadius: 16, background: 'linear-gradient(135deg, #D99D26, #C4891F)', color: 'white', padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left' }}
              >
                <Camera size={22} color="white" />
                <span style={{ display: 'block' }}>
                  <span style={{ display: 'block', fontSize: 14, fontWeight: 900 }}>Take Pictures</span>
                  <span style={{ display: 'block', marginTop: 2, fontSize: 11, fontWeight: 700, opacity: 0.82 }}>Use the device camera</span>
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
                  <span style={{ display: 'block', fontSize: 14, fontWeight: 900 }}>Upload From Device</span>
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
        <div style={{ position: 'fixed', inset: 0, zIndex: 250, background: '#05070A', minHeight: '100dvh', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, minHeight: cameraPreviewTopInset, display: 'flex', alignItems: 'center', gap: 8, padding: 'max(8px, env(safe-area-inset-top)) 12px 8px', color: 'white', background: '#05070A', zIndex: 4, boxShadow: '0 1px 0 rgba(255,255,255,0.08)' }}>
            <button
              type="button"
              onClick={closeBatchCamera}
              style={{ minWidth: 42, minHeight: 42, width: 42, height: 42, borderRadius: 13, border: 'none', background: 'rgba(255,255,255,0.12)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              aria-label="Close camera"
            >
              <X size={20} color="white" />
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 900, lineHeight: 1.15 }}>Take {photoPurpose === 'scope' ? 'Scope' : photoPurpose === 'both' ? 'Progress + Scope' : 'Progress'} Pictures</p>
              <p style={{ margin: '1px 0 0', fontSize: 10.5, opacity: 0.72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selectedProject?.address || 'Selected project'}
              </p>
            </div>
            <div style={{ borderRadius: 999, background: uploadComplete ? 'rgba(22,163,74,0.22)' : 'rgba(217,157,38,0.18)', color: uploadComplete ? '#BBF7D0' : '#FBD38D', padding: '7px 10px', fontSize: 11.5, fontWeight: 900 }}>
              {uploadComplete ? 'Secured' : uploading || queuedCount ? `${uploadingCount} uploading` : 'Ready'}
            </div>
          </div>

          <div
            className={shotFeedbackActive ? 'bt-camera-shot-frame' : undefined}
            style={{ position: 'absolute', top: cameraPreviewTopInset, left: 0, right: 0, bottom: cameraPreviewBottomInset, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', background: '#000' }}
          >
            <video
              ref={batchCameraVideoRef}
              autoPlay
              muted
              playsInline
              style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
            />
            {shotFeedbackActive && (
              <>
                <div style={{ position: 'absolute', inset: 0, background: 'rgba(255,255,255,0.62)', pointerEvents: 'none', animation: 'bt-camera-flash 260ms ease-out forwards' }} />
                <div style={{ position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)', borderRadius: 999, background: 'rgba(5,7,10,0.72)', color: 'white', padding: '8px 13px', fontSize: 12, fontWeight: 950, letterSpacing: '0.02em', boxShadow: '0 8px 24px rgba(0,0,0,0.24)', pointerEvents: 'none' }}>
                  {shotFeedbackMessage || 'Captured'}
                </div>
              </>
            )}
            {cameraError && (
              <div style={{ position: 'absolute', left: 14, right: 14, bottom: 18, borderRadius: 18, background: 'rgba(255,255,255,0.94)', padding: 16, textAlign: 'center', boxShadow: '0 14px 30px rgba(0,0,0,0.24)' }}>
                <p style={{ margin: 0, color: '#111827', fontSize: 14, fontWeight: 900 }}>Camera unavailable</p>
                <p style={{ margin: '6px 0 14px', color: '#6B7280', fontSize: 12, lineHeight: 1.45 }}>{cameraError}</p>
                <div style={{ display: 'grid', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => {
                      stopBatchCamera();
                      setShowBatchCamera(false);
                      cameraInputRef.current?.click();
                    }}
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

          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 4, background: 'linear-gradient(0deg, rgba(5,7,10,0.98), rgba(5,7,10,0.84))', padding: '10px 14px calc(18px + env(safe-area-inset-bottom))', color: 'white', boxShadow: '0 -18px 44px rgba(0,0,0,0.34)' }}>
            {uploadItems.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
                  <span style={{ color: uploadComplete ? '#BBF7D0' : 'rgba(255,255,255,0.78)', fontSize: 11, fontWeight: 900 }}>
                    {uploadStatusMessage}
                  </span>
                  <span style={{ color: uploadComplete ? '#86EFAC' : '#FBD38D', fontSize: 11, fontWeight: 900 }}>{aggregateProgress}%</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: 126, overflowY: 'auto', paddingBottom: 2 }}>
                {uploadItems.map(item => (
                  <div key={item.id} style={{ position: 'relative', width: 52, height: 52, borderRadius: 12, overflow: 'hidden', background: '#111827', border: '1px solid rgba(255,255,255,0.12)', flexShrink: 0 }}>
                    <div aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <FileImage size={18} color="rgba(255,255,255,0.62)" />
                    </div>
                    {isVideoMedia(item.file) ? (
                      <video src={item.previewUrl} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} muted playsInline />
                    ) : (
                      <img
                        src={item.previewUrl}
                        alt=""
                        onError={event => { event.currentTarget.style.display = 'none'; }}
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    )}
                    <span style={{ position: 'absolute', right: 4, bottom: 4, minWidth: 18, height: 18, borderRadius: 999, background: item.status === 'uploaded' ? '#16A34A' : item.status === 'failed' ? '#DC2626' : '#D99D26', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px', fontSize: 8, fontWeight: 900 }}>
                      {item.status === 'uploaded' ? 'SAFE' : item.status === 'failed' ? '!' : Math.max(0, Math.min(99, item.progress || 0))}
                    </span>
                  </div>
                ))}
                </div>
              </div>
            )}
            {cameraZoomSupported && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 42, marginBottom: 8, borderRadius: 14, background: 'rgba(255,255,255,0.08)', padding: '0 8px' }}>
                <button
                  type="button"
                  onClick={() => stepCameraZoom(-1)}
                  disabled={cameraZoom <= cameraZoomMin + (cameraZoomStep / 2)}
                  aria-label="Zoom out"
                  style={{ width: 34, height: 34, minWidth: 34, minHeight: 34, border: 'none', borderRadius: 11, background: 'rgba(255,255,255,0.12)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: cameraZoom <= cameraZoomMin + (cameraZoomStep / 2) ? 0.45 : 1 }}
                >
                  <Minus size={16} color="white" />
                </button>
                <ZoomIn size={16} color="#FBD38D" />
                <input
                  type="range"
                  min={cameraZoomMin}
                  max={cameraZoomMax}
                  step={cameraZoomStep}
                  value={cameraZoom}
                  onChange={event => void updateCameraZoom(Number(event.target.value))}
                  style={{ flex: 1 }}
                  aria-label="Camera zoom"
                />
                <span style={{ minWidth: 38, textAlign: 'right', color: 'rgba(255,255,255,0.78)', fontSize: 11, fontWeight: 900 }}>{cameraZoom.toFixed(1)}x</span>
                <button
                  type="button"
                  onClick={() => stepCameraZoom(1)}
                  disabled={cameraZoom >= cameraZoomMax - (cameraZoomStep / 2)}
                  aria-label="Zoom in"
                  style={{ width: 34, height: 34, minWidth: 34, minHeight: 34, border: 'none', borderRadius: 11, background: 'rgba(255,255,255,0.12)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: cameraZoom >= cameraZoomMax - (cameraZoomStep / 2) ? 0.45 : 1 }}
                >
                  <Plus size={16} color="white" />
                </button>
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
                onPointerDown={triggerCapturePressFeedback}
                onPointerUp={() => setCaptureButtonPressed(false)}
                onPointerCancel={() => setCaptureButtonPressed(false)}
                onPointerLeave={() => setCaptureButtonPressed(false)}
                onClick={() => void captureBatchPhoto()}
                disabled={!cameraReady || Boolean(cameraError) || captureProcessing}
                style={{ width: 76, height: 76, borderRadius: 38, border: '5px solid rgba(255,255,255,0.65)', background: cameraReady && !cameraError ? '#D99D26' : '#6B7280', boxShadow: shotFeedbackActive || captureButtonPressed ? '0 0 0 8px rgba(217,157,38,0.32), 0 0 26px rgba(217,157,38,0.42)' : '0 0 0 5px rgba(255,255,255,0.14)', opacity: cameraReady && !cameraError ? 1 : 0.6, transform: shotFeedbackActive || captureButtonPressed ? 'scale(0.94)' : 'scale(1)', transition: 'transform 120ms ease, box-shadow 160ms ease' }}
                aria-label={`Capture ${nounForPurpose(photoPurpose)}`}
              >
                <span aria-hidden="true" style={{ display: 'block', width: 48, height: 48, borderRadius: 24, background: captureProcessing ? 'rgba(255,255,255,0.38)' : 'rgba(255,255,255,0.92)', margin: 'auto' }} />
              </button>
              <button
                type="button"
                onClick={closeBatchCamera}
                style={{ minHeight: 46, border: 'none', borderRadius: 14, background: '#16A34A', color: 'white', fontSize: 12, fontWeight: 900 }}
              >
                Done
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

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes bt-camera-flash {
          0% { opacity: 0.78; }
          100% { opacity: 0; }
        }
        @keyframes bt-camera-shake {
          0% { transform: translate3d(0, 0, 0); }
          22% { transform: translate3d(-2px, 1px, 0); }
          48% { transform: translate3d(2px, -1px, 0); }
          72% { transform: translate3d(-1px, 1px, 0); }
          100% { transform: translate3d(0, 0, 0); }
        }
        .bt-camera-shot-frame {
          animation: bt-camera-shake 180ms ease-out;
        }
      `}</style>
    </div>
  );
}
