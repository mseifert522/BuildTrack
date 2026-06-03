import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  CheckCircle2,
  ClipboardList,
  ImagePlus,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { useAuthStore, canManageProjects } from '../store/authStore';
import { mobilePath } from '../lib/appUrls';

interface PunchItem {
  id: string;
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

interface DraftPunchItem {
  id: string;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  due_date: string;
  photos: File[];
  photoUrls: string[];
}

const priorityConfig: Record<string, { label: string; color: string; bg: string }> = {
  low: { label: 'Low', color: '#64748B', bg: '#F1F5F9' },
  medium: { label: 'Medium', color: '#B7791F', bg: '#FFF7D6' },
  high: { label: 'High', color: '#C2410C', bg: '#FFEDD5' },
  critical: { label: 'Critical', color: '#B91C1C', bg: '#FEE2E2' },
  urgent: { label: 'Urgent', color: '#B91C1C', bg: '#FEE2E2' },
};

const statusConfig: Record<string, { label: string; color: string; bg: string }> = {
  open: { label: 'Open', color: '#2563EB', bg: '#DBEAFE' },
  not_started: { label: 'Not Started', color: '#64748B', bg: '#F1F5F9' },
  in_progress: { label: 'In Progress', color: '#B7791F', bg: '#FFF7D6' },
  waiting_materials: { label: 'Waiting Materials', color: '#7C3AED', bg: '#F3E8FF' },
  needs_review: { label: 'Needs Review', color: '#0369A1', bg: '#E0F2FE' },
  completed: { label: 'Completed', color: '#15803D', bg: '#DCFCE7' },
  blocked: { label: 'Blocked', color: '#B91C1C', bg: '#FEE2E2' },
};

const DISPLAY_STATUSES = ['not_started', 'in_progress', 'needs_review', 'waiting_materials', 'completed', 'blocked'] as const;

function draftId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function newDraft(): DraftPunchItem {
  return {
    id: draftId(),
    title: '',
    description: '',
    priority: 'medium',
    due_date: '',
    photos: [],
    photoUrls: [],
  };
}

function isOpenItem(item: PunchItem) {
  return item.status !== 'completed';
}

export default function MobilePunchList() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const canManage = user ? canManageProjects(user.role) : false;
  const canCreatePunchItems = Boolean(user);
  const canAttachPhotos = Boolean(user);

  const [items, setItems] = useState<PunchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectAddress, setProjectAddress] = useState('');
  const [filter, setFilter] = useState<'all' | 'open' | 'completed'>('open');

  const [batchOpen, setBatchOpen] = useState(false);
  const [drafts, setDrafts] = useState<DraftPunchItem[]>(() => [newDraft()]);
  const [savingBatch, setSavingBatch] = useState(false);

  const [photoItemId, setPhotoItemId] = useState<string | null>(null);
  const [itemPhotos, setItemPhotos] = useState<Photo[]>([]);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadCaption, setUploadCaption] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewFiles, setPreviewFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);

  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const stats = useMemo(() => {
    const open = items.filter(isOpenItem).length;
    const completed = items.filter(item => item.status === 'completed').length;
    const photos = items.reduce((total, item) => total + (item.photo_count || 0), 0);
    return { open, completed, photos };
  }, [items]);

  const filteredItems = items.filter(item => {
    if (filter === 'open') return isOpenItem(item);
    if (filter === 'completed') return item.status === 'completed';
    return true;
  });

  const loadPunchList = async () => {
    if (!id) return;
    const [projRes, punchRes] = await Promise.all([
      api.get(`/projects/${id}`),
      api.get(`/projects/${id}/punch-list`),
    ]);
    setProjectAddress(projRes.data.address || projRes.data.job_name || 'Project');
    setItems(Array.isArray(punchRes.data) ? punchRes.data : []);
  };

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    loadPunchList()
      .catch(() => toast.error('Failed to load punch list'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    return () => {
      drafts.forEach(draft => draft.photoUrls.forEach(url => URL.revokeObjectURL(url)));
      previewUrls.forEach(url => URL.revokeObjectURL(url));
    };
  }, []);

  const resetBatch = () => {
    drafts.forEach(draft => draft.photoUrls.forEach(url => URL.revokeObjectURL(url)));
    setDrafts([newDraft()]);
    setBatchOpen(false);
  };

  const updateDraft = (draftId: string, patch: Partial<DraftPunchItem>) => {
    setDrafts(prev => prev.map(draft => draft.id === draftId ? { ...draft, ...patch } : draft));
  };

  const addDraftRow = () => setDrafts(prev => [...prev, newDraft()]);

  const removeDraftRow = (draftId: string) => {
    setDrafts(prev => {
      const draft = prev.find(item => item.id === draftId);
      draft?.photoUrls.forEach(url => URL.revokeObjectURL(url));
      const remaining = prev.filter(item => item.id !== draftId);
      return remaining.length ? remaining : [newDraft()];
    });
  };

  const handleDraftPhotos = (draftId: string, files: FileList | null) => {
    const nextFiles = Array.from(files || []);
    if (!nextFiles.length) return;
    setDrafts(prev => prev.map(draft => {
      if (draft.id !== draftId) return draft;
      return {
        ...draft,
        photos: [...draft.photos, ...nextFiles],
        photoUrls: [...draft.photoUrls, ...nextFiles.map(file => URL.createObjectURL(file))],
      };
    }));
  };

  const removeDraftPhoto = (draftId: string, photoIndex: number) => {
    setDrafts(prev => prev.map(draft => {
      if (draft.id !== draftId) return draft;
      URL.revokeObjectURL(draft.photoUrls[photoIndex]);
      return {
        ...draft,
        photos: draft.photos.filter((_, index) => index !== photoIndex),
        photoUrls: draft.photoUrls.filter((_, index) => index !== photoIndex),
      };
    }));
  };

  const saveBatch = async () => {
    if (!id) return;
    const readyDrafts = drafts
      .map(draft => ({ ...draft, title: draft.title.trim(), description: draft.description.trim() }))
      .filter(draft => draft.title);

    if (!readyDrafts.length) {
      toast.error('Add at least one punch item title');
      return;
    }

    setSavingBatch(true);
    let photoCount = 0;
    try {
      for (const draft of readyDrafts) {
        const created = await api.post(`/projects/${id}/punch-list`, {
          title: draft.title,
          description: draft.description || undefined,
          priority: draft.priority,
          due_date: draft.due_date || undefined,
          status: 'not_started',
        });

        const createdId = created.data?.id;
        if (createdId && draft.photos.length) {
          const formData = new FormData();
          draft.photos.forEach(file => formData.append('photos', file));
          formData.append('punch_list_item_id', String(createdId));
          formData.append('caption', `Punch list: ${draft.title}`);
          await api.post(`/projects/${id}/photos`, formData, {
            headers: { 'Content-Type': 'multipart/form-data' },
          });
          photoCount += draft.photos.length;
        }
      }

      await loadPunchList();
      resetBatch();
      toast.success(`Saved ${readyDrafts.length} item${readyDrafts.length === 1 ? '' : 's'}${photoCount ? ` and ${photoCount} photo${photoCount === 1 ? '' : 's'}` : ''}`);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to save field punch list');
    } finally {
      setSavingBatch(false);
    }
  };

  const handleStatusChange = async (item: PunchItem, newStatus: string) => {
    try {
      await api.put(`/projects/${id}/punch-list/${item.id}`, { status: newStatus });
      setItems(prev => prev.map(p => p.id === item.id ? { ...p, status: newStatus as PunchItem['status'] } : p));
      toast.success('Status updated');
    } catch {
      toast.error('Failed to update status');
    }
  };

  const openPhotoPanel = async (item: PunchItem) => {
    setPhotoItemId(item.id);
    setPhotosLoading(true);
    setPreviewFiles([]);
    previewUrls.forEach(url => URL.revokeObjectURL(url));
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
    previewUrls.forEach(url => URL.revokeObjectURL(url));
    setPreviewUrls([]);
    setUploadCaption('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    previewUrls.forEach(url => URL.revokeObjectURL(url));
    setPreviewFiles(files);
    setPreviewUrls(files.map(file => URL.createObjectURL(file)));
  };

  const handleUpload = async () => {
    if (!id || !photoItemId || !previewFiles.length) {
      toast.error('Select at least one photo');
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      previewFiles.forEach(file => formData.append('photos', file));
      formData.append('punch_list_item_id', photoItemId);
      if (uploadCaption.trim()) formData.append('caption', uploadCaption.trim());

      await api.post(`/projects/${id}/photos`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      const res = await api.get(`/projects/${id}/photos?punch_list_item_id=${photoItemId}`);
      setItemPhotos(Array.isArray(res.data) ? res.data : []);
      setItems(prev => prev.map(item => item.id === photoItemId ? { ...item, photo_count: (item.photo_count || 0) + previewFiles.length } : item));
      setPreviewFiles([]);
      previewUrls.forEach(url => URL.revokeObjectURL(url));
      setPreviewUrls([]);
      setUploadCaption('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      toast.success('Photos attached');
    } catch {
      toast.error('Photo upload failed');
    } finally {
      setUploading(false);
    }
  };

  const photoItem = items.find(item => item.id === photoItemId);

  return (
    <div className="mobile-shell bt-mobile-field" style={{ backgroundColor: '#EEF2F6' }}>
      <div className="mobile-header bt-mobile-field-header">
        <div className="bt-mobile-field-topbar">
          <button
            type="button"
            onClick={() => navigate(mobilePath(`/project/${id}`))}
            className="bt-mobile-icon-button"
            aria-label="Back to project"
          >
            <ArrowLeft size={24} />
          </button>
          <div className="bt-mobile-field-title">
            <p>Punch List</p>
            <span>{projectAddress}</span>
          </div>
          {canCreatePunchItems && (
            <button
              type="button"
              onClick={() => setBatchOpen(true)}
              className="bt-mobile-header-action"
            >
              <Plus size={20} />
              Add
            </button>
          )}
        </div>

        <div className="bt-mobile-punch-hero">
          <div>
            <span className="bt-mobile-eyebrow">Field capture</span>
            <h1>Create punch items as you walk the job</h1>
            <p>Add several issues fast. Attach photos to each item before saving.</p>
          </div>
          <div className="bt-mobile-punch-stats" aria-label="Punch list status summary">
            <span><strong>{stats.open}</strong> open</span>
            <span><strong>{stats.photos}</strong> photos</span>
          </div>
        </div>

        {canCreatePunchItems && (
          <button
            type="button"
            className="bt-mobile-big-action"
            onClick={() => setBatchOpen(true)}
          >
            <ClipboardList size={28} />
            <span>
              <strong>Start Field Punch List</strong>
              <small>Add multiple items with pictures</small>
            </span>
          </button>
        )}

        <div className="bt-mobile-segmented" role="tablist" aria-label="Punch list filters">
          {(['open', 'all', 'completed'] as const).map(nextFilter => (
            <button
              key={nextFilter}
              type="button"
              role="tab"
              aria-selected={filter === nextFilter}
              onClick={() => setFilter(nextFilter)}
              className={filter === nextFilter ? 'active' : ''}
            >
              {nextFilter}
            </button>
          ))}
        </div>
      </div>

      <div className="mobile-content bt-mobile-field-content">
        {loading ? (
          Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="bt-mobile-punch-skeleton" />
          ))
        ) : filteredItems.length === 0 ? (
          <div className="bt-mobile-empty-state">
            <ClipboardList size={42} />
            <h2>{filter === 'all' ? 'No punch items yet' : `No ${filter} punch items`}</h2>
            <p>Use field capture to add issues while you are standing in the room.</p>
            {canCreatePunchItems && (
              <button type="button" onClick={() => setBatchOpen(true)}>
                <Plus size={22} />
                Add field items
              </button>
            )}
          </div>
        ) : (
          filteredItems.map(item => {
            const priority = priorityConfig[item.priority] || priorityConfig.medium;
            const status = statusConfig[item.status] || statusConfig.not_started;
            return (
              <article key={item.id} className={`bt-mobile-punch-card ${item.status === 'completed' ? 'is-complete' : ''}`}>
                <div className="bt-mobile-punch-card-main">
                  <div className="bt-mobile-priority-dot" style={{ backgroundColor: priority.color }} />
                  <div>
                    <h2>{item.title}</h2>
                    {item.description && <p>{item.description}</p>}
                    <div className="bt-mobile-badge-row">
                      <span style={{ backgroundColor: priority.bg, color: priority.color }}>{priority.label}</span>
                      <span style={{ backgroundColor: status.bg, color: status.color }}>{status.label}</span>
                      {item.due_date && <span>Due {new Date(item.due_date).toLocaleDateString()}</span>}
                    </div>
                  </div>
                </div>

                <div className="bt-mobile-punch-actions">
                  <button type="button" onClick={() => openPhotoPanel(item)} className="bt-mobile-attach-button">
                    <Camera size={22} />
                    {(item.photo_count || 0) > 0 ? `${item.photo_count} photo${item.photo_count === 1 ? '' : 's'}` : 'Add photos'}
                  </button>
                  {canManage && (
                    <div className="bt-mobile-status-rail">
                      {DISPLAY_STATUSES.map(statusKey => {
                        const cfg = statusConfig[statusKey];
                        return (
                          <button
                            key={statusKey}
                            type="button"
                            onClick={() => handleStatusChange(item, statusKey)}
                            className={item.status === statusKey ? 'active' : ''}
                            style={item.status === statusKey ? { backgroundColor: cfg.color, color: 'white' } : { backgroundColor: cfg.bg, color: cfg.color }}
                          >
                            {cfg.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </article>
            );
          })
        )}
      </div>

      {batchOpen && (
        <div className="bt-mobile-sheet-overlay" onClick={event => { if (event.target === event.currentTarget && !savingBatch) resetBatch(); }}>
          <section className="bt-mobile-sheet bt-mobile-batch-sheet" role="dialog" aria-modal="true" aria-labelledby="field-punch-title">
            <div className="bt-mobile-sheet-handle" />
            <header className="bt-mobile-sheet-header">
              <div>
                <p className="bt-mobile-eyebrow">Fast field entry</p>
                <h2 id="field-punch-title">Add punch list items</h2>
                <span>{drafts.filter(draft => draft.title.trim()).length} ready to save</span>
              </div>
              <button type="button" onClick={resetBatch} disabled={savingBatch} aria-label="Close field entry">
                <X size={24} />
              </button>
            </header>

            <div className="bt-mobile-draft-list">
              {drafts.map((draft, index) => (
                <div key={draft.id} className="bt-mobile-draft-card">
                  <div className="bt-mobile-draft-card-header">
                    <span>Item {index + 1}</span>
                    <button type="button" onClick={() => removeDraftRow(draft.id)} aria-label={`Remove item ${index + 1}`}>
                      <Trash2 size={18} />
                    </button>
                  </div>

                  <label>
                    Issue title
                    <input
                      value={draft.title}
                      onChange={event => updateDraft(draft.id, { title: event.target.value })}
                      placeholder="Example: repair loose stair tread"
                    />
                  </label>

                  <label>
                    Details
                    <textarea
                      value={draft.description}
                      onChange={event => updateDraft(draft.id, { description: event.target.value })}
                      placeholder="Room, condition, notes for the contractor"
                      rows={2}
                    />
                  </label>

                  <div className="bt-mobile-draft-grid">
                    <label>
                      Priority
                      <select value={draft.priority} onChange={event => updateDraft(draft.id, { priority: event.target.value as DraftPunchItem['priority'] })}>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                        <option value="critical">Critical</option>
                      </select>
                    </label>
                    <label>
                      Due date
                      <input type="date" value={draft.due_date} onChange={event => updateDraft(draft.id, { due_date: event.target.value })} />
                    </label>
                  </div>

                  <div className="bt-mobile-draft-photo-block">
                    <label className="bt-mobile-photo-add">
                      <ImagePlus size={22} />
                      <span>{draft.photos.length ? 'Add more photos' : 'Attach photos'}</span>
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        capture="environment"
                        onChange={event => {
                          handleDraftPhotos(draft.id, event.target.files);
                          event.target.value = '';
                        }}
                      />
                    </label>
                    {draft.photoUrls.length > 0 && (
                      <div className="bt-mobile-draft-photo-grid">
                        {draft.photoUrls.map((url, photoIndex) => (
                          <div key={url}>
                            <img src={url} alt={`Preview for item ${index + 1}`} />
                            <button type="button" onClick={() => removeDraftPhoto(draft.id, photoIndex)} aria-label="Remove photo">
                              <X size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="bt-mobile-sheet-footer">
              <button type="button" className="bt-mobile-secondary-button" onClick={addDraftRow} disabled={savingBatch}>
                <Plus size={22} />
                Add another item
              </button>
              <button type="button" className="bt-mobile-save-button" onClick={saveBatch} disabled={savingBatch}>
                {savingBatch ? (
                  <>
                    <span className="bt-mobile-spinner" />
                    Saving field list...
                  </>
                ) : (
                  <>
                    <Save size={22} />
                    Save punch list
                  </>
                )}
              </button>
            </div>
          </section>
        </div>
      )}

      {photoItemId !== null && (
        <div className="bt-mobile-sheet-overlay" onClick={event => { if (event.target === event.currentTarget) closePhotoPanel(); }}>
          <section className="bt-mobile-sheet" role="dialog" aria-modal="true" aria-labelledby="photos-panel-title">
            <div className="bt-mobile-sheet-handle" />
            <header className="bt-mobile-sheet-header">
              <div>
                <p className="bt-mobile-eyebrow">Attached photos</p>
                <h2 id="photos-panel-title">{photoItem?.title || 'Punch item'}</h2>
                <span>{itemPhotos.length} saved photo{itemPhotos.length === 1 ? '' : 's'}</span>
              </div>
              <button type="button" onClick={closePhotoPanel} aria-label="Close photo panel">
                <X size={24} />
              </button>
            </header>

            <div className="bt-mobile-photo-panel">
              {canAttachPhotos && (
                <div className="bt-mobile-upload-zone">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    capture="environment"
                    onChange={handleFileSelect}
                  />
                  <button type="button" onClick={() => fileInputRef.current?.click()}>
                    <Camera size={26} />
                    <span>
                      <strong>Take or attach photos</strong>
                      <small>Photos connect to this punch item</small>
                    </span>
                  </button>
                </div>
              )}

              {previewUrls.length > 0 && (
                <div className="bt-mobile-selected-photos">
                  <div className="bt-mobile-photo-grid">
                    {previewUrls.map(url => <img key={url} src={url} alt="Selected punch list photo" />)}
                  </div>
                  <input
                    type="text"
                    value={uploadCaption}
                    onChange={event => setUploadCaption(event.target.value)}
                    placeholder="Optional photo caption"
                  />
                  <button type="button" onClick={handleUpload} disabled={uploading}>
                    {uploading ? <span className="bt-mobile-spinner" /> : <ImagePlus size={22} />}
                    Upload {previewFiles.length} photo{previewFiles.length === 1 ? '' : 's'}
                  </button>
                </div>
              )}

              <div>
                {photosLoading ? (
                  <div className="bt-mobile-photo-grid">
                    {[1, 2, 3].map(item => <div key={item} className="bt-mobile-photo-skeleton" />)}
                  </div>
                ) : itemPhotos.length ? (
                  <div className="bt-mobile-photo-grid">
                    {itemPhotos.map(photo => (
                      <button type="button" key={photo.id} onClick={() => setLightboxUrl(`/uploads/${id}/${photo.filename}`)}>
                        <img src={`/uploads/${id}/${photo.filename}`} alt={photo.caption || photo.original_name} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="bt-mobile-no-photos">
                    <AlertTriangle size={28} />
                    <p>No photos attached yet.</p>
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      )}

      {lightboxUrl && (
        <div className="bt-mobile-lightbox" onClick={() => setLightboxUrl(null)}>
          <img src={lightboxUrl} alt="Full size punch list attachment" />
          <button type="button" onClick={() => setLightboxUrl(null)} aria-label="Close image">
            <X size={24} />
          </button>
        </div>
      )}

      <div className="bt-mobile-floating-status" aria-live="polite">
        <CheckCircle2 size={18} />
        {stats.completed} complete
      </div>
    </div>
  );
}
