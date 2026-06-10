import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, MessageSquare, Camera, ClipboardList, Plus, Send, Trash2, Upload, FileText, Package } from 'lucide-react';
import api from '../lib/api';
import toast from 'react-hot-toast';
import { formatEasternDateTime, formatEasternRelative } from '../lib/time';
import { PROGRESS_MEDIA_ACCEPT } from '../lib/progressUpload';
import VoiceTextarea from '../components/VoiceTextarea';

type Tab = 'plan' | 'notes' | 'photos' | 'punch';

export default function ContractorProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<any>(null);
  const [tab, setTab] = useState<Tab>('plan');
  const [loading, setLoading] = useState(true);

  // Notes state
  const [notes, setNotes] = useState<any[]>([]);
  const [newNote, setNewNote] = useState('');
  const [addingNote, setAddingNote] = useState(false);

  // Photos state
  const [photos, setPhotos] = useState<any[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  // Punch list state
  const [punchItems, setPunchItems] = useState<any[]>([]);
  const [newPunchTitle, setNewPunchTitle] = useState('');
  const [newPunchDesc, setNewPunchDesc] = useState('');
  const [addingPunch, setAddingPunch] = useState(false);
  const [showAddPunch, setShowAddPunch] = useState(false);
  const [planItems, setPlanItems] = useState<any[]>([]);
  const [materials, setMaterials] = useState<any[]>([]);

  const token = localStorage.getItem('contractor_token');

  useEffect(() => {
    if (!token) { navigate('/app'); return; }
    api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    loadProject();
  }, [id]);

  useEffect(() => {
    if (!id || !token) return;
    if (tab === 'plan') loadConstructionPlan();
    if (tab === 'notes') loadNotes();
    if (tab === 'photos') loadPhotos();
    if (tab === 'punch') loadPunchItems();
  }, [tab, id]);

  const loadProject = async () => {
    try {
      const res = await api.get(`/projects/${id}`);
      setProject(res.data);
    } catch { toast.error('Failed to load project'); }
    finally { setLoading(false); }
  };

  const loadNotes = async () => {
    try { const res = await api.get(`/projects/${id}/notes`); setNotes(res.data); } catch {}
  };

  const loadPhotos = async () => {
    try { const res = await api.get(`/projects/${id}/photos?type=progress`); setPhotos(res.data); } catch {}
  };

  const loadPunchItems = async () => {
    try { const res = await api.get(`/projects/${id}/punch-list`); setPunchItems(res.data); } catch {}
  };

  const loadConstructionPlan = async () => {
    try {
      const [planRes, materialRes] = await Promise.all([
        api.get(`/projects/${id}/construction-plan`),
        api.get(`/projects/${id}/materials`),
      ]);
      setPlanItems(planRes.data?.items || []);
      setMaterials(materialRes.data || []);
    } catch {}
  };

  const addNote = async () => {
    if (!newNote.trim()) return;
    setAddingNote(true);
    try {
      await api.post(`/projects/${id}/notes`, { note: newNote, note_type: 'field' });
      setNewNote('');
      loadNotes();
      toast.success('Note added');
    } catch { toast.error('Failed to add note'); }
    finally { setAddingNote(false); }
  };

  const uploadPhotos = async (files: FileList) => {
    setUploading(true);
    try {
      const formData = new FormData();
      Array.from(files).forEach(f => formData.append('photos', f));
      formData.append('photo_type', 'progress');
      formData.append('taken_at_values', JSON.stringify(
        Array.from(files).map(file => new Date(file.lastModified || Date.now()).toISOString())
      ));
      await api.post(`/projects/${id}/photos?type=progress`, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      loadPhotos();
      toast.success(`${files.length} progress photo${files.length > 1 ? 's' : ''} uploaded`);
    } catch { toast.error('Failed to upload'); }
    finally { setUploading(false); }
  };

  const addPunchItem = async () => {
    if (!newPunchTitle.trim()) return;
    setAddingPunch(true);
    try {
      await api.post(`/projects/${id}/punch-list`, { title: newPunchTitle, description: newPunchDesc, priority: 'medium' });
      setNewPunchTitle('');
      setNewPunchDesc('');
      setShowAddPunch(false);
      loadPunchItems();
      toast.success('Punch list item added');
    } catch { toast.error('Failed to add item'); }
    finally { setAddingPunch(false); }
  };

  if (loading) return (
    <div style={{ minHeight: '100vh', background: '#F4F5F7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 28, height: 28, border: '3px solid #E5E7EB', borderTopColor: '#D99D26', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  const tabs: { id: Tab; label: string; icon: any }[] = [
    { id: 'plan', label: 'Plan', icon: FileText },
    { id: 'notes', label: 'Notes', icon: MessageSquare },
    { id: 'photos', label: 'Photos', icon: Camera },
    { id: 'punch', label: 'Punch List', icon: ClipboardList },
  ];

  const priorityColors: Record<string, { bg: string; text: string }> = {
    low: { bg: '#F3F4F6', text: '#6B7280' },
    medium: { bg: '#DBEAFE', text: '#1D4ED8' },
    high: { bg: '#FEF3C7', text: '#92400E' },
    urgent: { bg: '#FEE2E2', text: '#DC2626' },
  };

  const statusLabels: Record<string, string> = {
    not_started: 'Open',
    in_progress: 'In Progress',
    waiting_materials: 'Waiting',
    needs_review: 'Review',
    completed: 'Done',
  };

  return (
    <div style={{ minHeight: '100vh', background: '#F4F5F7', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ background: '#181D25', padding: '16px', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={() => navigate('/app/projects')} style={{
            background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10,
            padding: 8, cursor: 'pointer', display: 'flex',
          }}>
            <ArrowLeft size={20} color="white" />
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ color: 'white', fontWeight: 700, fontSize: 15, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project?.address}</p>
            <p style={{ color: '#D99D26', fontSize: 11, margin: '2px 0 0' }}>{project?.job_name}</p>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                padding: '10px 0', borderRadius: 12, border: 'none', cursor: 'pointer',
                background: tab === t.id ? '#D99D26' : 'rgba(255,255,255,0.08)',
                color: tab === t.id ? 'white' : 'rgba(255,255,255,0.5)',
                fontWeight: 700, fontSize: 12,
                transition: 'all 0.2s',
              }}
            >
              <t.icon size={14} />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, padding: 16, paddingBottom: 100 }}>

        {/* Construction Plan Tab */}
        {tab === 'plan' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ background: 'white', borderRadius: 14, padding: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <p style={{ fontSize: 15, fontWeight: 800, color: '#111827', margin: 0 }}>Construction Plan</p>
              <p style={{ fontSize: 12, color: '#6B7280', margin: '4px 0 0' }}>Project steps and supply timing for this rehab.</p>
            </div>
            {planItems.length === 0 && <p style={{ textAlign: 'center', color: '#9CA3AF', fontSize: 13, padding: 32 }}>No construction plan yet</p>}
            {planItems.map(item => {
              const linkedMaterials = materials.filter(m => m.plan_item_id === item.id);
              return (
                <div key={item.id} style={{ background: 'white', borderRadius: 14, padding: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <div style={{ width: 28, height: 28, borderRadius: 9, background: '#181D25', color: 'white', fontSize: 12, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {item.sort_order}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontSize: 11, fontWeight: 800, color: '#D99D26', margin: 0, textTransform: 'uppercase' }}>{item.category}</p>
                      <p style={{ fontSize: 14, fontWeight: 800, color: '#111827', margin: '2px 0 0' }}>{item.title}</p>
                      {item.description && <p style={{ fontSize: 12, color: '#6B7280', margin: '6px 0 0', lineHeight: 1.5 }}>{item.description}</p>}
                      <span style={{ display: 'inline-block', marginTop: 8, fontSize: 10, fontWeight: 800, padding: '3px 9px', borderRadius: 999, background: item.status === 'completed' ? '#DCFCE7' : item.status === 'waiting_materials' ? '#FEF3C7' : '#F3F4F6', color: item.status === 'completed' ? '#166534' : item.status === 'waiting_materials' ? '#92400E' : '#374151' }}>
                        {String(item.status).replace(/_/g, ' ')}
                      </span>
                    </div>
                  </div>
                  {linkedMaterials.length > 0 && (
                    <div style={{ marginTop: 10, padding: 10, borderRadius: 12, background: '#F9FAFB' }}>
                      <p style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 800, color: '#6B7280', margin: '0 0 8px' }}><Package size={12} /> Materials</p>
                      {linkedMaterials.map(material => (
                        <div key={material.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, color: '#374151', padding: '5px 0', borderTop: '1px solid #E5E7EB' }}>
                          <span>{material.material_name}</span>
                          <span style={{ fontWeight: 700 }}>{String(material.order_status).replace(/_/g, ' ')}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── Notes Tab ── */}
        {tab === 'notes' && (
          <div>
            {/* Add Note */}
            <div style={{ background: 'white', borderRadius: 14, padding: 14, marginBottom: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <VoiceTextarea
                value={newNote}
                onChange={e => setNewNote(e.target.value)}
                placeholder="Add a field note..."
                rows={3}
                style={{ width: '100%', border: 'none', outline: 'none', fontSize: 14, color: '#111827', resize: 'none', background: 'transparent', boxSizing: 'border-box' }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                <button
                  onClick={addNote}
                  disabled={addingNote || !newNote.trim()}
                  style={{
                    background: addingNote || !newNote.trim() ? '#E5C97A' : '#D99D26',
                    color: 'white', border: 'none', borderRadius: 10, padding: '8px 20px',
                    fontWeight: 700, fontSize: 13, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}
                >
                  <Send size={14} /> {addingNote ? 'Saving...' : 'Add Note'}
                </button>
              </div>
            </div>

            {/* Notes List */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {notes.length === 0 && <p style={{ textAlign: 'center', color: '#9CA3AF', fontSize: 13, padding: 32 }}>No notes yet</p>}
              {notes.map(n => (
                <div key={n.id} style={{ background: 'white', borderRadius: 14, padding: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
                    <p style={{ fontSize: 13, fontWeight: 700, color: '#111827', margin: 0 }}>
                      {n.user_name}
                      <span style={{ color: '#6B7280', fontSize: 11, fontWeight: 600 }}> · Inserted {formatEasternDateTime(n.created_at, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} New York time</span>
                    </p>
                    <p style={{ fontSize: 11, color: '#9CA3AF', margin: 0 }}>{formatEasternRelative(n.created_at)}</p>
                  </div>
                  <p style={{ fontSize: 14, color: '#374151', margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{n.note}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Photos Tab ── */}
        {tab === 'photos' && (
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept={PROGRESS_MEDIA_ACCEPT}
              multiple
              style={{ display: 'none' }}
              onChange={e => { if (e.target.files && e.target.files.length > 0) uploadPhotos(e.target.files); e.currentTarget.value = ''; }}
            />
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              onChange={e => { if (e.target.files && e.target.files.length > 0) uploadPhotos(e.target.files); e.currentTarget.value = ''; }}
            />

            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              style={{
                width: '100%', padding: 16, borderRadius: 14,
                border: '2px dashed #D1D5DB', background: uploading ? '#F9FAFB' : 'white',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                color: '#6B7280', fontWeight: 700, fontSize: 14, marginBottom: 16,
              }}
            >
              {uploading ? (
                <><div style={{ width: 18, height: 18, border: '2px solid #D99D26', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} /> Uploading...</>
              ) : (
                <><Upload size={18} /> Upload Progress Pictures</>
              )}
            </button>
            <button
              onClick={() => cameraInputRef.current?.click()}
              disabled={uploading}
              style={{
                width: '100%', padding: 14, borderRadius: 14,
                border: '1px solid #F3D08A', background: '#FFFBEB',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                color: '#92400E', fontWeight: 800, fontSize: 14, marginBottom: 16,
              }}
            >
              <Camera size={18} /> Open Camera
            </button>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {photos.map(p => (
                <div key={p.id} style={{ borderRadius: 10, overflow: 'hidden', aspectRatio: '1', background: '#E5E7EB' }}>
                  <img
                    src={`/uploads/${id}/${p.filename}`}
                    alt={p.caption || ''}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                </div>
              ))}
            </div>
            {photos.length === 0 && !uploading && <p style={{ textAlign: 'center', color: '#9CA3AF', fontSize: 13, padding: 32 }}>No photos yet</p>}
          </div>
        )}

        {/* ── Punch List Tab ── */}
        {tab === 'punch' && (
          <div>
            {/* Add Punch Item */}
            {!showAddPunch ? (
              <button
                onClick={() => setShowAddPunch(true)}
                style={{
                  width: '100%', padding: 14, borderRadius: 14,
                  border: '2px dashed #D1D5DB', background: 'white',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  color: '#6B7280', fontWeight: 700, fontSize: 13, marginBottom: 16,
                }}
              >
                <Plus size={16} /> Add Punch List Item
              </button>
            ) : (
              <div style={{ background: 'white', borderRadius: 14, padding: 14, marginBottom: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <input
                  type="text"
                  value={newPunchTitle}
                  onChange={e => setNewPunchTitle(e.target.value)}
                  placeholder="Item title *"
                  style={{ width: '100%', border: 'none', outline: 'none', fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 8, background: 'transparent', boxSizing: 'border-box' }}
                />
                <textarea
                  value={newPunchDesc}
                  onChange={e => setNewPunchDesc(e.target.value)}
                  placeholder="Description (optional)"
                  rows={2}
                  style={{ width: '100%', border: 'none', outline: 'none', fontSize: 13, color: '#6B7280', resize: 'none', background: 'transparent', boxSizing: 'border-box' }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button onClick={() => { setShowAddPunch(false); setNewPunchTitle(''); setNewPunchDesc(''); }}
                    style={{ flex: 1, padding: '10px', borderRadius: 10, border: '1px solid #E5E7EB', background: 'white', color: '#6B7280', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                    Cancel
                  </button>
                  <button onClick={addPunchItem} disabled={addingPunch || !newPunchTitle.trim()}
                    style={{
                      flex: 1, padding: '10px', borderRadius: 10, border: 'none',
                      background: addingPunch || !newPunchTitle.trim() ? '#E5C97A' : '#D99D26',
                      color: 'white', fontWeight: 700, fontSize: 13, cursor: 'pointer',
                    }}>
                    {addingPunch ? 'Adding...' : 'Add Item'}
                  </button>
                </div>
              </div>
            )}

            {/* Punch List Items */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {punchItems.length === 0 && <p style={{ textAlign: 'center', color: '#9CA3AF', fontSize: 13, padding: 32 }}>No punch list items yet</p>}
              {punchItems.map(item => {
                const pColor = priorityColors[item.priority] || priorityColors.medium;
                return (
                  <div key={item.id} style={{ background: 'white', borderRadius: 14, padding: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                      <div style={{
                        width: 22, height: 22, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                        border: item.status === 'completed' ? '2px solid #22C55E' : '2px solid #D1D5DB',
                        background: item.status === 'completed' ? '#22C55E' : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        {item.status === 'completed' && (
                          <svg width="12" height="12" fill="none" stroke="white" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                        )}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{
                          fontSize: 14, fontWeight: 700, margin: 0,
                          color: item.status === 'completed' ? '#9CA3AF' : '#111827',
                          textDecoration: item.status === 'completed' ? 'line-through' : 'none',
                        }}>{item.title}</p>
                        {item.description && <p style={{ fontSize: 12, color: '#6B7280', margin: '4px 0 0' }}>{item.description}</p>}
                        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: pColor.bg, color: pColor.text }}>{item.priority}</span>
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: '#F3F4F6', color: '#6B7280' }}>{statusLabels[item.status] || item.status}</span>
                          {item.assigned_to_name && <span style={{ fontSize: 10, color: '#9CA3AF' }}>{item.assigned_to_name}</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
