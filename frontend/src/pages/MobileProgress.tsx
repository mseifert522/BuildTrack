import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../lib/api';
import toast from 'react-hot-toast';
import { useAuthStore, canManageProjects } from '../store/authStore';
import { ArrowLeft, Camera, Upload, X, ZoomIn } from 'lucide-react';

interface ProgressPhoto {
  id: string;
  filename: string;
  original_name: string;
  caption?: string;
  taken_at?: string;
  created_at: string;
  uploaded_by_name?: string;
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function groupByDate(photos: ProgressPhoto[]) {
  const groups: { date: string; photos: ProgressPhoto[] }[] = [];
  for (const photo of photos) {
    const d = new Date(photo.taken_at || photo.created_at);
    const dateKey = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const last = groups[groups.length - 1];
    if (last && last.date === dateKey) {
      last.photos.push(photo);
    } else {
      groups.push({ date: dateKey, photos: [photo] });
    }
  }
  return groups;
}

export default function MobileProgress() {
  const { id: projectId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const canManage = user ? canManageProjects(user.role) : false;

  const [projectAddress, setProjectAddress] = useState('');
  const [photos, setPhotos] = useState<ProgressPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [caption, setCaption] = useState('');
  const [previewFiles, setPreviewFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!projectId) return;
    Promise.all([
      api.get(`/projects/${projectId}`),
      api.get(`/projects/${projectId}/photos?type=progress`).catch(() => api.get(`/projects/${projectId}/photos`)),
    ]).then(([projRes, photoRes]) => {
      setProjectAddress(projRes.data.address || '');
      setPhotos(Array.isArray(photoRes.data) ? photoRes.data : []);
    }).catch(() => toast.error('Failed to load progress photos'))
      .finally(() => setLoading(false));
  }, [projectId]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setPreviewFiles(files);
    setPreviewUrls(files.map(f => URL.createObjectURL(f)));
    setShowUpload(true);
  };

  const handleUpload = async () => {
    if (!previewFiles.length) return;
    setUploading(true);
    try {
      const formData = new FormData();
      previewFiles.forEach(f => formData.append('photos', f));
      if (caption.trim()) formData.append('caption', caption.trim());
      formData.append('photo_type', 'progress');
      formData.append('taken_at', new Date().toISOString());

      await api.post(`/projects/${projectId}/photos`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      toast.success(`${previewFiles.length} photo${previewFiles.length > 1 ? 's' : ''} uploaded!`);
      const res = await api.get(`/projects/${projectId}/photos?type=progress`).catch(() => api.get(`/projects/${projectId}/photos`));
      setPhotos(Array.isArray(res.data) ? res.data : []);
      setPreviewFiles([]);
      setPreviewUrls([]);
      setCaption('');
      setShowUpload(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch {
      toast.error('Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const cancelUpload = () => {
    setPreviewFiles([]);
    setPreviewUrls([]);
    setCaption('');
    setShowUpload(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const grouped = groupByDate(photos);
  const photoBaseUrl = (api.defaults.baseURL || '').replace('/api', '');

  return (
    <div className="mobile-shell" style={{ background: '#0D1117' }}>
      {/* Header */}
      <div className="mobile-header" style={{ background: 'linear-gradient(135deg, #0D1117 0%, #181D25 100%)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 16px 12px' }}>
          <button
            onClick={() => navigate(-1)}
            style={{ background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: 10, padding: 8, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
          >
            <ArrowLeft size={20} color="white" />
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ color: 'white', fontWeight: 800, fontSize: 15, margin: 0 }}>Progress Photos</p>
            <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{projectAddress}</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(217,157,38,0.15)', borderRadius: 10, padding: '6px 10px' }}>
            <Camera size={14} color="#D99D26" />
            <span style={{ color: '#D99D26', fontSize: 12, fontWeight: 700 }}>{photos.length}</span>
          </div>
        </div>
        {/* Upload bar */}
        {canManage && (
          <div style={{ padding: '0 16px 12px', display: 'flex', gap: 8 }}>
            <label
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                background: 'linear-gradient(135deg, #D99D26, #C4891F)',
                color: 'white', borderRadius: 12, padding: '10px 16px',
                fontSize: 14, fontWeight: 700, cursor: 'pointer',
                boxShadow: '0 4px 12px rgba(217,157,38,0.35)',
              }}
            >
              <Camera size={16} color="white" />
              Take / Upload Photo
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                onChange={handleFileSelect}
                style={{ display: 'none' }}
              />
            </label>
          </div>
        )}
      </div>

      {/* Upload preview sheet */}
      {showUpload && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end' }}>
          <div style={{ width: '100%', background: 'white', borderRadius: '24px 24px 0 0', padding: '20px 16px 32px', maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ width: 40, height: 4, background: '#E5E7EB', borderRadius: 2, margin: '0 auto 16px' }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <p style={{ fontWeight: 800, fontSize: 17, color: '#111827', margin: 0 }}>Add Progress Photos</p>
              <button onClick={cancelUpload} style={{ background: '#F3F4F6', border: 'none', borderRadius: 8, padding: 6, cursor: 'pointer' }}>
                <X size={18} color="#6B7280" />
              </button>
            </div>

            {/* Timestamp notice */}
            <div style={{ background: '#FEF3C7', borderRadius: 10, padding: '8px 12px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, color: '#92400E', fontWeight: 600 }}>
                📅 Date & time stamp: {new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}
              </span>
            </div>

            {/* Previews */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 14 }}>
              {previewUrls.map((url, i) => (
                <div key={i} style={{ position: 'relative', paddingBottom: '100%', borderRadius: 10, overflow: 'hidden', background: '#F3F4F6' }}>
                  <img src={url} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>
              ))}
            </div>

            {/* Caption */}
            <input
              type="text"
              value={caption}
              onChange={e => setCaption(e.target.value)}
              placeholder="Add a caption (optional)..."
              style={{ width: '100%', border: '1.5px solid #E5E7EB', borderRadius: 12, padding: '10px 14px', fontSize: 14, color: '#111827', marginBottom: 14, boxSizing: 'border-box' }}
            />

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={cancelUpload}
                style={{ flex: 1, background: '#F3F4F6', color: '#6B7280', border: 'none', borderRadius: 12, padding: '12px 0', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={handleUpload}
                disabled={uploading}
                style={{ flex: 2, background: 'linear-gradient(135deg, #D99D26, #C4891F)', color: 'white', border: 'none', borderRadius: 12, padding: '12px 0', fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: uploading ? 0.7 : 1 }}
              >
                {uploading ? 'Uploading...' : `Upload ${previewFiles.length} Photo${previewFiles.length > 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.95)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <img src={lightbox} alt="Full size" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 8 }} />
          <button
            onClick={() => setLightbox(null)}
            style={{ position: 'absolute', top: 20, right: 20, background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: '50%', width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          >
            <X size={20} color="white" />
          </button>
        </div>
      )}

      {/* Photo Timeline */}
      <div className="mobile-content" style={{ padding: '12px 14px 80px' }}>
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 60 }}>
            <div style={{ width: 36, height: 36, borderRadius: '50%', border: '3px solid rgba(217,157,38,0.2)', borderTopColor: '#D99D26', animation: 'spin 0.8s linear infinite' }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        ) : photos.length === 0 ? (
          <div style={{ textAlign: 'center', paddingTop: 60 }}>
            <div style={{ width: 64, height: 64, borderRadius: 20, background: 'rgba(217,157,38,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <Camera size={32} color="#D99D26" />
            </div>
            <p style={{ color: 'rgba(255,255,255,0.7)', fontWeight: 700, fontSize: 16, margin: '0 0 8px' }}>No progress photos yet</p>
            <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13, margin: 0 }}>
              {canManage ? 'Tap "Take / Upload Photo" to document construction progress' : 'No photos have been uploaded yet'}
            </p>
          </div>
        ) : (
          grouped.map(group => (
            <div key={group.date} style={{ marginBottom: 24 }}>
              {/* Date divider */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.1)' }} />
                <span style={{ color: '#D99D26', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', whiteSpace: 'nowrap' }}>
                  {group.date}
                </span>
                <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.1)' }} />
              </div>

              {/* Photo grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                {group.photos.map(photo => {
                  const src = photo.filename.startsWith('http')
                    ? photo.filename
                    : `${photoBaseUrl}/uploads/${photo.filename}`;
                  return (
                    <div
                      key={photo.id}
                      style={{ borderRadius: 14, overflow: 'hidden', background: '#1A1F2B', cursor: 'pointer' }}
                      onClick={() => setLightbox(src)}
                    >
                      <div style={{ position: 'relative', paddingBottom: '75%' }}>
                        <img
                          src={src}
                          alt={photo.caption || photo.original_name}
                          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'linear-gradient(transparent, rgba(0,0,0,0.7))', padding: '16px 8px 6px' }}>
                          <ZoomIn size={12} color="rgba(255,255,255,0.7)" style={{ float: 'right' }} />
                        </div>
                      </div>
                      <div style={{ padding: '8px 10px' }}>
                        {photo.caption && (
                          <p style={{ color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: 600, margin: '0 0 3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {photo.caption}
                          </p>
                        )}
                        <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, margin: 0 }}>
                          {formatDateTime(photo.taken_at || photo.created_at)}
                        </p>
                        {photo.uploaded_by_name && (
                          <p style={{ color: 'rgba(217,157,38,0.7)', fontSize: 10, margin: '2px 0 0' }}>
                            {photo.uploaded_by_name}
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
      </div>
    </div>
  );
}
