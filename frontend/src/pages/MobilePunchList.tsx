import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../lib/api';
import toast from 'react-hot-toast';
import { useAuthStore, canManageProjects } from '../store/authStore';

interface PunchItem {
  id: number;
  title: string;
  description?: string;
  status: 'open' | 'in_progress' | 'completed' | 'blocked' | 'not_started' | 'waiting_materials' | 'needs_review';
  priority: 'low' | 'medium' | 'high' | 'critical' | 'urgent';
  assigned_to_name?: string;
  due_date?: string;
  photo_count?: number;
}

interface Photo {
  id: string;
  filename: string;
  original_name: string;
  caption?: string;
}

const priorityConfig: Record<string, { label: string; color: string; bg: string }> = {
  low:      { label: 'Low',      color: '#6b7280', bg: '#F3F4F6' },
  medium:   { label: 'Medium',   color: '#D99D26', bg: '#FEF3C7' },
  high:     { label: 'High',     color: '#f97316', bg: '#FFF7ED' },
  critical: { label: 'Critical', color: '#ef4444', bg: '#FEF2F2' },
  urgent:   { label: 'Urgent',   color: '#ef4444', bg: '#FEF2F2' },
};

const statusConfig: Record<string, { label: string; color: string; bg: string }> = {
  open:              { label: 'Open',              color: '#3b82f6', bg: '#EFF6FF' },
  not_started:       { label: 'Not Started',       color: '#6b7280', bg: '#F3F4F6' },
  in_progress:       { label: 'In Progress',       color: '#D99D26', bg: '#FEF3C7' },
  waiting_materials: { label: 'Waiting Materials', color: '#8b5cf6', bg: '#F5F3FF' },
  needs_review:      { label: 'Needs Review',      color: '#0ea5e9', bg: '#F0F9FF' },
  completed:         { label: 'Completed',         color: '#22c55e', bg: '#F0FDF4' },
  blocked:           { label: 'Blocked',           color: '#ef4444', bg: '#FEF2F2' },
};

const DISPLAY_STATUSES = ['open', 'not_started', 'in_progress', 'waiting_materials', 'needs_review', 'completed', 'blocked'] as const;

export default function MobilePunchList() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const canManage = user ? canManageProjects(user.role) : false;

  const [items, setItems] = useState<PunchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectAddress, setProjectAddress] = useState('');
  const [filter, setFilter] = useState<'all' | 'open' | 'completed'>('all');

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newPriority, setNewPriority] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');
  const [newDue, setNewDue] = useState('');

  // Photo upload state
  const [photoItemId, setPhotoItemId] = useState<number | null>(null);
  const [itemPhotos, setItemPhotos] = useState<Photo[]>([]);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadCaption, setUploadCaption] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewFiles, setPreviewFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);

  // Lightbox
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      api.get(`/projects/${id}`),
      api.get(`/projects/${id}/punch-list`),
    ]).then(([projRes, punchRes]) => {
      setProjectAddress(projRes.data.address || projRes.data.job_name || 'Project');
      setItems(Array.isArray(punchRes.data) ? punchRes.data : []);
    }).catch(() => toast.error('Failed to load punch list'))
      .finally(() => setLoading(false));
  }, [id]);

  const filteredItems = items.filter(item => {
    if (filter === 'open') return item.status !== 'completed';
    if (filter === 'completed') return item.status === 'completed';
    return true;
  });

  // ── Create punch item ──
  const handleCreate = async () => {
    if (!newTitle.trim()) { toast.error('Title is required'); return; }
    setSaving(true);
    try {
      const res = await api.post(`/projects/${id}/punch-list`, {
        title: newTitle.trim(),
        description: newDesc.trim() || undefined,
        priority: newPriority,
        due_date: newDue || undefined,
      });
      // Refresh full list to get photo_count and proper status
      const refreshed = await api.get(`/projects/${id}/punch-list`);
      setItems(Array.isArray(refreshed.data) ? refreshed.data : []);
      setNewTitle(''); setNewDesc(''); setNewPriority('medium'); setNewDue('');
      setShowCreate(false);
      toast.success('Item added!');
    } catch {
      toast.error('Failed to add item');
    } finally {
      setSaving(false);
    }
  };

  // ── Status change ──
  const handleStatusChange = async (item: PunchItem, newStatus: string) => {
    try {
      await api.put(`/projects/${id}/punch-list/${item.id}`, { status: newStatus });
      setItems(prev => prev.map(p => p.id === item.id ? { ...p, status: newStatus as any } : p));
      toast.success('Status updated');
    } catch {
      toast.error('Failed to update status');
    }
  };

  // ── Open photo panel ──
  const openPhotoPanel = async (item: PunchItem) => {
    setPhotoItemId(item.id);
    setPhotosLoading(true);
    setPreviewFiles([]);
    setPreviewUrls([]);
    setUploadCaption('');
    try {
      const res = await api.get(`/projects/${id}/photos?punch_list_item_id=${item.id}`);
      setItemPhotos(Array.isArray(res.data) ? res.data : []);
    } catch {
      toast.error('Failed to load photos');
    } finally {
      setPhotosLoading(false);
    }
  };

  const closePhotoPanel = () => {
    setPhotoItemId(null);
    setItemPhotos([]);
    setPreviewFiles([]);
    setPreviewUrls([]);
    setUploadCaption('');
  };

  // ── File selection ──
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setPreviewFiles(files);
    const urls = files.map(f => URL.createObjectURL(f));
    setPreviewUrls(urls);
  };

  // ── Upload photos ──
  const handleUpload = async () => {
    if (previewFiles.length === 0) { toast.error('Select at least one photo'); return; }
    setUploading(true);
    try {
      const formData = new FormData();
      previewFiles.forEach(f => formData.append('photos', f));
      if (uploadCaption.trim()) formData.append('caption', uploadCaption.trim());
      if (photoItemId) formData.append('punch_list_item_id', String(photoItemId));

      await api.post(`/projects/${id}/photos`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      toast.success(`${previewFiles.length} photo${previewFiles.length > 1 ? 's' : ''} uploaded!`);
      // Refresh photos
      const res = await api.get(`/projects/${id}/photos?punch_list_item_id=${photoItemId}`);
      setItemPhotos(Array.isArray(res.data) ? res.data : []);
      // Update photo count on item
      setItems(prev => prev.map(p => p.id === photoItemId ? { ...p, photo_count: (p.photo_count || 0) + previewFiles.length } : p));
      setPreviewFiles([]);
      setPreviewUrls([]);
      setUploadCaption('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch {
      toast.error('Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const photoItem = items.find(i => i.id === photoItemId);

  return (
    <div className="mobile-shell" style={{ backgroundColor: '#F4F5F7' }}>
      {/* Header */}
      <div className="mobile-header" style={{ backgroundColor: '#181D25', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
        <div className="flex items-center gap-3 px-4 pt-4 pb-3">
          <button onClick={() => navigate(`/mobile/project/${id}`)} className="p-2 rounded-xl hover:bg-white/10 -ml-1">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-white font-bold text-sm">Punch List</p>
            <p className="text-xs truncate" style={{ color: '#D99D26' }}>{projectAddress}</p>
          </div>
          {canManage && (
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl font-semibold text-xs text-white"
              style={{ backgroundColor: '#D99D26' }}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Item
            </button>
          )}
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1 px-4 pb-3">
          {(['all', 'open', 'completed'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="px-3 py-1.5 rounded-xl text-xs font-semibold transition-all capitalize"
              style={filter === f
                ? { backgroundColor: '#D99D26', color: 'white' }
                : { backgroundColor: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.6)' }
              }
            >
              {f}
            </button>
          ))}
          <span className="ml-auto text-xs text-gray-400 self-center">
            {filteredItems.length} item{filteredItems.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* ── Create Form Bottom Sheet ── */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-end" style={{ backgroundColor: 'rgba(0,0,0,0.55)' }} onClick={e => { if (e.target === e.currentTarget) setShowCreate(false); }}>
          <div className="w-full bg-white rounded-t-3xl p-6 pb-10 max-h-[90vh] overflow-y-auto">
            <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-5" />
            <div className="flex items-center justify-between mb-5">
              <h3 className="font-bold text-gray-900 text-lg">New Punch Item</h3>
              <button onClick={() => setShowCreate(false)} className="p-2 rounded-xl hover:bg-gray-100">
                <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Title *</label>
                <input
                  type="text"
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                  placeholder="e.g. Fix drywall crack in bedroom"
                  className="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm focus:outline-none bg-gray-50"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Description</label>
                <textarea
                  value={newDesc}
                  onChange={e => setNewDesc(e.target.value)}
                  placeholder="Optional details..."
                  rows={3}
                  className="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm focus:outline-none bg-gray-50 resize-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Priority</label>
                <div className="grid grid-cols-4 gap-2">
                  {(['low', 'medium', 'high', 'critical'] as const).map(p => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setNewPriority(p)}
                      className="py-2.5 rounded-xl text-xs font-bold transition-all border-2"
                      style={newPriority === p
                        ? { backgroundColor: priorityConfig[p].color, color: 'white', borderColor: priorityConfig[p].color }
                        : { backgroundColor: priorityConfig[p].bg, color: priorityConfig[p].color, borderColor: 'transparent' }
                      }
                    >
                      {priorityConfig[p].label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Due Date</label>
                <input
                  type="date"
                  value={newDue}
                  onChange={e => setNewDue(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm focus:outline-none bg-gray-50"
                />
              </div>

              <button
                onClick={handleCreate}
                disabled={saving}
                className="w-full py-4 rounded-2xl font-bold text-white text-sm transition-all disabled:opacity-50"
                style={{ backgroundColor: '#D99D26' }}
              >
                {saving ? 'Adding...' : 'Add to Punch List'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Photo Panel Bottom Sheet ── */}
      {photoItemId !== null && (
        <div className="fixed inset-0 z-50 flex items-end" style={{ backgroundColor: 'rgba(0,0,0,0.55)' }} onClick={e => { if (e.target === e.currentTarget) closePhotoPanel(); }}>
          <div className="w-full bg-white rounded-t-3xl max-h-[92vh] flex flex-col">
            {/* Panel header */}
            <div className="px-6 pt-5 pb-4 border-b border-gray-100 flex-shrink-0">
              <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-4" />
              <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0 pr-3">
                  <p className="font-bold text-gray-900 text-base truncate">
                    {photoItem?.title || 'Punch Item Photos'}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {itemPhotos.length} photo{itemPhotos.length !== 1 ? 's' : ''}
                  </p>
                </div>
                <button onClick={closePhotoPanel} className="p-2 rounded-xl hover:bg-gray-100 flex-shrink-0">
                  <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Scrollable content */}
            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">

              {/* Upload zone — only for managers */}
              {canManage && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Upload Photos</p>

                  {/* File picker */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    capture="environment"
                    onChange={handleFileSelect}
                    style={{ display: 'none' }}
                  />

                  {previewUrls.length === 0 ? (
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      style={{
                        width: '100%',
                        border: '2px dashed #D99D26',
                        borderRadius: 16,
                        padding: '28px 16px',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 10,
                        backgroundColor: '#FFFBF0',
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: '#FEF3C7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <svg width="26" height="26" fill="none" stroke="#D99D26" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                      </div>
                      <div style={{ textAlign: 'center' }}>
                        <p style={{ fontWeight: 700, color: '#D99D26', fontSize: 14, margin: 0 }}>Tap to take or select photos</p>
                        <p style={{ color: '#9CA3AF', fontSize: 12, margin: '4px 0 0' }}>JPEG, PNG, HEIC up to 20MB each</p>
                      </div>
                    </button>
                  ) : (
                    <div>
                      {/* Preview grid */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 12 }}>
                        {previewUrls.map((url, i) => (
                          <div key={i} style={{ position: 'relative', paddingBottom: '100%', borderRadius: 10, overflow: 'hidden', backgroundColor: '#F3F4F6' }}>
                            <img src={url} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                          </div>
                        ))}
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          style={{ paddingBottom: '100%', borderRadius: 10, border: '2px dashed #D99D26', backgroundColor: '#FFFBF0', cursor: 'pointer', position: 'relative' }}
                        >
                          <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#D99D26', fontWeight: 700, fontSize: 22 }}>+</span>
                        </button>
                      </div>
                      <p style={{ fontSize: 12, color: '#6B7280', marginBottom: 8 }}>{previewFiles.length} file{previewFiles.length > 1 ? 's' : ''} selected</p>

                      {/* Caption */}
                      <input
                        type="text"
                        value={uploadCaption}
                        onChange={e => setUploadCaption(e.target.value)}
                        placeholder="Optional caption..."
                        style={{ width: '100%', padding: '10px 14px', borderRadius: 10, border: '1px solid #E5E7EB', fontSize: 14, outline: 'none', backgroundColor: '#F9FAFB', boxSizing: 'border-box', marginBottom: 10 }}
                      />

                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          onClick={() => { setPreviewFiles([]); setPreviewUrls([]); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                          style={{ flex: 1, padding: '11px', borderRadius: 12, border: '1px solid #E5E7EB', backgroundColor: 'white', color: '#6B7280', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
                        >
                          Clear
                        </button>
                        <button
                          onClick={handleUpload}
                          disabled={uploading}
                          style={{ flex: 2, padding: '11px', borderRadius: 12, border: 'none', backgroundColor: uploading ? '#E5C97A' : '#D99D26', color: 'white', fontWeight: 700, fontSize: 13, cursor: uploading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                        >
                          {uploading ? (
                            <>
                              <div style={{ width: 14, height: 14, border: '2px solid white', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                              Uploading...
                            </>
                          ) : (
                            <>
                              <svg width="16" height="16" fill="none" stroke="white" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                              </svg>
                              Upload {previewFiles.length} Photo{previewFiles.length > 1 ? 's' : ''}
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Existing photos */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                  {itemPhotos.length > 0 ? 'Attached Photos' : 'No Photos Yet'}
                </p>
                {photosLoading ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                    {[1, 2, 3].map(i => (
                      <div key={i} style={{ paddingBottom: '100%', borderRadius: 10, backgroundColor: '#F3F4F6', animation: 'pulse 1.5s ease-in-out infinite' }} />
                    ))}
                  </div>
                ) : itemPhotos.length > 0 ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                    {itemPhotos.map(photo => (
                      <button
                        key={photo.id}
                        onClick={() => setLightboxUrl(`/uploads/${id}/${photo.filename}`)}
                        style={{ position: 'relative', paddingBottom: '100%', borderRadius: 10, overflow: 'hidden', backgroundColor: '#F3F4F6', border: 'none', cursor: 'pointer' }}
                      >
                        <img
                          src={`/uploads/${id}/${photo.filename}`}
                          alt={photo.caption || photo.original_name}
                          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                        />
                      </button>
                    ))}
                  </div>
                ) : (
                  !canManage && (
                    <div style={{ textAlign: 'center', padding: '24px 0', color: '#9CA3AF', fontSize: 13 }}>
                      No photos attached to this item.
                    </div>
                  )
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Lightbox ── */}
      {lightboxUrl && (
        <div
          onClick={() => setLightboxUrl(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 100, backgroundColor: 'rgba(0,0,0,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
        >
          <img src={lightboxUrl} alt="Full size" style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 12, objectFit: 'contain' }} />
          <button
            onClick={() => setLightboxUrl(null)}
            style={{ position: 'absolute', top: 20, right: 20, background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: '50%', width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          >
            <svg width="20" height="20" fill="none" stroke="white" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* ── Punch List Items ── */}
      <div className="mobile-content" style={{ padding: '12px 14px 80px' }}>
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bg-white rounded-2xl p-4 animate-pulse">
              <div className="h-4 bg-gray-200 rounded w-3/4 mb-2" />
              <div className="h-3 bg-gray-100 rounded w-1/2" />
            </div>
          ))
        ) : filteredItems.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center" style={{ backgroundColor: '#FEF3C7' }}>
              <svg className="w-8 h-8" style={{ color: '#D99D26' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </div>
            <p className="text-gray-500 font-semibold">
              {filter === 'all' ? 'No punch list items yet' : `No ${filter} items`}
            </p>
            {filter === 'all' && canManage && (
              <button
                onClick={() => setShowCreate(true)}
                className="mt-3 px-5 py-2.5 rounded-xl text-sm font-bold text-white"
                style={{ backgroundColor: '#D99D26' }}
              >
                + Add First Item
              </button>
            )}
          </div>
        ) : (
          filteredItems.map(item => {
            const pCfg = priorityConfig[item.priority] || priorityConfig.medium;
            const sCfg = statusConfig[item.status] || statusConfig.open;
            return (
              <div key={item.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                <div className="p-4">
                  <div className="flex items-start gap-3">
                    {/* Priority dot */}
                    <div className="w-3 h-3 rounded-full mt-1.5 flex-shrink-0" style={{ backgroundColor: pCfg.color }} />
                    <div className="flex-1 min-w-0">
                      <p className={`font-semibold text-sm ${item.status === 'completed' ? 'line-through text-gray-400' : 'text-gray-900'}`}>
                        {item.title}
                      </p>
                      {item.description && (
                        <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{item.description}</p>
                      )}
                      <div className="flex items-center gap-2 mt-2 flex-wrap">
                        <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ backgroundColor: pCfg.bg, color: pCfg.color }}>
                          {pCfg.label}
                        </span>
                        <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ backgroundColor: sCfg.bg, color: sCfg.color }}>
                          {sCfg.label}
                        </span>
                        {item.assigned_to_name && (
                          <span className="text-xs text-gray-400">@{item.assigned_to_name}</span>
                        )}
                        {item.due_date && (
                          <span className="text-xs text-gray-400">
                            Due {new Date(item.due_date).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Photo button */}
                    <button
                      onClick={() => openPhotoPanel(item)}
                      style={{
                        flexShrink: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 2,
                        padding: '6px 8px',
                        borderRadius: 10,
                        border: 'none',
                        backgroundColor: (item.photo_count || 0) > 0 ? '#FEF3C7' : '#F9FAFB',
                        cursor: 'pointer',
                      }}
                    >
                      <svg width="18" height="18" fill="none" stroke={(item.photo_count || 0) > 0 ? '#D99D26' : '#9CA3AF'} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      {(item.photo_count || 0) > 0 && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: '#D99D26' }}>{item.photo_count}</span>
                      )}
                    </button>
                  </div>
                </div>

                {/* Status selector — only for managers */}
                {canManage && (
                  <div className="border-t border-gray-100 px-4 py-2.5 flex items-center gap-2 overflow-x-auto">
                    {DISPLAY_STATUSES.map(s => {
                      const cfg = statusConfig[s];
                      const isActive = item.status === s;
                      return (
                        <button
                          key={s}
                          onClick={() => handleStatusChange(item, s)}
                          className="flex-shrink-0 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all"
                          style={isActive
                            ? { backgroundColor: cfg.color, color: 'white' }
                            : { backgroundColor: cfg.bg, color: cfg.color }
                          }
                        >
                          {cfg.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      `}</style>
    </div>
  );
}
