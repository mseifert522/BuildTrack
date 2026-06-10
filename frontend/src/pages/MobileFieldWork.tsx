import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, Camera, CheckCircle2, ClipboardList, FileText, ImagePlus, Plus, Send } from 'lucide-react';
import api from '../lib/api';
import { useAuthStore } from '../store/authStore';
import { appendProgressUploadAudit, PROGRESS_MEDIA_ACCEPT } from '../lib/progressUpload';
import { notifyMobileDataChanged } from '../lib/mobileEvents';
import VoiceTextarea from '../components/VoiceTextarea';

const workStatuses = [
  ['not_started', 'Not Started'],
  ['in_progress', 'In Progress'],
  ['waiting_materials', 'Waiting Materials'],
  ['needs_review', 'Needs Review'],
  ['completed', 'Completed'],
];

const invoiceStatuses = [
  ['not_received', 'Invoice Not Received'],
  ['received', 'Invoice Received'],
  ['approval_needed', 'Approval Needed'],
  ['approved_for_payment', 'Approved for Payment'],
  ['paid', 'Paid'],
];

export default function MobileFieldWork() {
  const { id: projectId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const managementUser = user?.role !== 'contractor';
  const upperManagementUser = user?.role === 'super_admin' || user?.role === 'operations_manager';
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [projectAddress, setProjectAddress] = useState('');
  const [fieldWork, setFieldWork] = useState<any>({ tasks: [], counts: {} });
  const [scopes, setScopes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingTask, setSavingTask] = useState(false);
  const [sendingNote, setSendingNote] = useState(false);
  const [uploadingTaskId, setUploadingTaskId] = useState<string | null>(null);
  const [noteFiles, setNoteFiles] = useState<File[]>([]);
  const [taskEvidenceDrafts, setTaskEvidenceDrafts] = useState<Record<string, { note: string; files: File[] }>>({});
  const [taskForm, setTaskForm] = useState({
    title: '',
    category: 'Field Work',
    description: '',
    target_date: '',
  });
  const [noteText, setNoteText] = useState('');

  const load = async () => {
    if (!projectId) return;
    try {
      const [projectRes, fieldRes, scopeRes] = await Promise.all([
        api.get(`/projects/${projectId}`),
        api.get(`/field-work/projects/${projectId}`),
        api.get(`/projects/${projectId}/scopes`).catch(() => ({ data: { scopes: [] } })),
      ]);
      setProjectAddress(projectRes.data?.address || '');
      setFieldWork(fieldRes.data || { tasks: [], counts: {} });
      setScopes(Array.isArray(scopeRes.data?.scopes) ? scopeRes.data.scopes.filter((scope: any) => scope.status === 'active') : []);
    } catch {
      toast.error('Failed to load field work');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [projectId]);

  const getTaskEvidenceDraft = (taskId: string) => taskEvidenceDrafts[taskId] || { note: '', files: [] };

  const updateTaskEvidenceDraft = (taskId: string, patch: Partial<{ note: string; files: File[] }>) => {
    setTaskEvidenceDrafts(current => ({
      ...current,
      [taskId]: { ...(current[taskId] || { note: '', files: [] }), ...patch },
    }));
  };

  const clearTaskEvidenceDraft = (taskId: string) => {
    setTaskEvidenceDrafts(current => {
      const next = { ...current };
      delete next[taskId];
      return next;
    });
  };

  const createTask = async () => {
    if (!projectId || !taskForm.title.trim()) return;
    setSavingTask(true);
    try {
      await api.post(`/field-work/projects/${projectId}/tasks`, {
        ...taskForm,
        title: taskForm.title.trim(),
        description: taskForm.description.trim() || null,
        target_date: taskForm.target_date || null,
      });
      toast.success('Field work task added');
      setTaskForm({ title: '', category: 'Field Work', description: '', target_date: '' });
      await load();
      notifyMobileDataChanged({ entity: 'field_work', action: 'task_created', projectId });
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to add field task');
    } finally {
      setSavingTask(false);
    }
  };

  const updateTask = async (task: any, patch: Record<string, any>) => {
    try {
      await api.put(`/field-work/projects/${projectId}/tasks/${task.id}`, patch);
      await load();
      notifyMobileDataChanged({ entity: 'field_work', action: 'task_updated', projectId });
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update task');
    }
  };

  const approveTask = async (task: any) => {
    try {
      await api.post(`/field-work/projects/${projectId}/tasks/${task.id}/approve`, {});
      toast.success('Approved for payment');
      await load();
      notifyMobileDataChanged({ entity: 'field_work', action: 'task_approved', projectId });
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to approve task');
    }
  };

  const sendFieldNote = async () => {
    if (!projectId || !noteText.trim() || sendingNote) return;
    const files = [...noteFiles];
    setSendingNote(true);
    try {
      const noteRes = await api.post(`/projects/${projectId}/notes`, {
        note: noteText.trim(),
        note_type: 'field',
        visibility: 'private',
      });
      if (files.length) {
        const formData = new FormData();
        files.forEach(file => formData.append('photos', file));
        formData.append('note_id', noteRes.data.id);
        formData.append('photo_type', 'scope');
        formData.append('photo_contexts', JSON.stringify(['general', 'scope']));
        formData.append('caption', 'Field work evidence attached to field note');
        await appendProgressUploadAudit(formData, files, files.map(() => 'device_camera'));
        await api.post(`/projects/${projectId}/photos?type=scope`, formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
      }
      toast.success('Field note sent to desktop');
      setNoteText('');
      setNoteFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await load();
      notifyMobileDataChanged({ entity: 'field_note', action: 'sent', projectId });
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to send field note');
    } finally {
      setSendingNote(false);
    }
  };

  const uploadTaskPhotos = async (task: any) => {
    const draft = getTaskEvidenceDraft(task.id);
    const selected = [...draft.files];
    const evidenceNote = draft.note.trim();
    if (!projectId || !selected.length) return;
    setUploadingTaskId(task.id);
    try {
      const formData = new FormData();
      selected.forEach(file => formData.append('photos', file));
      formData.append('construction_plan_item_id', task.id);
      formData.append('photo_contexts', JSON.stringify(['general', 'scope']));
      formData.append('caption', evidenceNote || `Field work evidence for ${task.title}`);
      if (evidenceNote) {
        formData.append('batch_note', evidenceNote);
        formData.append('individual_note_values', JSON.stringify(selected.map(() => evidenceNote)));
      }
      await appendProgressUploadAudit(formData, selected, selected.map(() => 'device_camera'), {
        batchNote: evidenceNote,
        individualNotes: selected.map(() => evidenceNote),
      });
      await api.post(`/projects/${projectId}/photos`, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(evidenceNote ? 'Photo and note uploaded for review' : 'Evidence uploaded for review');
      clearTaskEvidenceDraft(task.id);
      await load();
      notifyMobileDataChanged({ entity: 'field_evidence', action: 'uploaded', projectId });
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to upload evidence');
    } finally {
      setUploadingTaskId(null);
    }
  };

  if (loading) {
    return (
      <div className="mobile-shell btm-home-shell btm-loading-screen">
        <div className="btm-loading-mark"><ClipboardList size={26} /></div>
        <p>Loading field work...</p>
      </div>
    );
  }

  return (
    <div className="mobile-shell btm-home-shell">
      <header className="btm-home-header">
        <div className="btm-home-topbar">
          <div className="btm-brand">
            <button type="button" onClick={() => navigate(`/mobile/project/${projectId}`)} className="btm-icon-button" aria-label="Back to project">
              <ArrowLeft size={22} />
            </button>
            <div className="btm-brand-text">
              <p>Scope of Work</p>
              <span>{projectAddress || 'Project field record'}</span>
            </div>
          </div>
        </div>
      </header>

      <main className="btm-home-content">
        {scopes.length > 0 && (
          <section className="btm-list-section" aria-label="Scope of work">
            <div className="btm-section-header"><p>{scopes.length} Active Scope{scopes.length === 1 ? '' : 's'}</p></div>
            {scopes.map(scope => (
              <article key={scope.id} className="btm-project-card btm-scope-card" style={{ padding: 14 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <span className="btm-project-pin" style={{ width: 48, height: 48, borderRadius: 14, flexShrink: 0 }} aria-hidden="true">
                    <FileText size={22} />
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p className="btm-scope-section" style={{ margin: 0, color: '#1D4ED8', fontSize: 11, fontWeight: 950, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                      {scope.section_name || 'General'}
                    </p>
                    <h2 className="btm-scope-title" style={{ margin: '5px 0 0', color: '#111827', fontSize: 17, fontWeight: 950, lineHeight: 1.2 }}>
                      {scope.scope_title || 'Scope of Work'}
                    </h2>
                    {scope.scope_of_work && (
                      <p className="btm-scope-body" style={{ margin: '8px 0 0', color: '#475569', fontSize: 14, fontWeight: 750, lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
                        {scope.scope_of_work}
                      </p>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </section>
        )}

        {managementUser && (
        <section className="btm-list-section" aria-label="Create field work task" style={{ marginTop: scopes.length > 0 ? 18 : 0 }}>
          <div className="btm-section-header"><p>Schedule work</p></div>
          <div className="btm-project-card" style={{ padding: 14 }}>
            <input
              value={taskForm.title}
              onChange={event => setTaskForm(current => ({ ...current, title: event.target.value }))}
              placeholder="Install furnace, mud and tape drywall..."
              style={{ width: '100%', minHeight: 54, border: '1px solid #D7DEE8', borderRadius: 14, padding: '0 13px', fontWeight: 850, color: '#111827' }}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
              <input
                value={taskForm.category}
                onChange={event => setTaskForm(current => ({ ...current, category: event.target.value }))}
                placeholder="Trade"
                style={{ minHeight: 52, border: '1px solid #D7DEE8', borderRadius: 14, padding: '0 13px', fontWeight: 800, color: '#111827' }}
              />
              <input
                type="date"
                value={taskForm.target_date}
                onChange={event => setTaskForm(current => ({ ...current, target_date: event.target.value }))}
                style={{ minHeight: 52, border: '1px solid #D7DEE8', borderRadius: 14, padding: '0 13px', fontWeight: 800, color: '#111827' }}
              />
            </div>
            <textarea
              value={taskForm.description}
              onChange={event => setTaskForm(current => ({ ...current, description: event.target.value }))}
              placeholder="What needs to happen and what should be checked?"
              rows={3}
              style={{ width: '100%', marginTop: 10, border: '1px solid #D7DEE8', borderRadius: 14, padding: 13, fontWeight: 750, color: '#111827' }}
            />
            <button type="button" onClick={createTask} disabled={savingTask || !taskForm.title.trim()} className="btm-action-button btm-action-open" style={{ width: '100%', marginTop: 10 }}>
              <Plus size={21} />
              <span>{savingTask ? 'Saving...' : 'Add Field Task'}</span>
            </button>
          </div>
        </section>
        )}

        <section className="btm-list-section" aria-label="Field note" style={{ marginTop: 18 }}>
          <div className="btm-section-header"><p>Field note and pictures</p></div>
          <div className="btm-project-card" style={{ padding: 14 }}>
            <VoiceTextarea
              value={noteText}
              onChange={event => setNoteText(event.target.value)}
              placeholder="Write what you saw in the field..."
              rows={4}
              style={{ width: '100%', border: '1px solid #D7DEE8', borderRadius: 14, padding: 13, fontWeight: 800, color: '#111827' }}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept={PROGRESS_MEDIA_ACCEPT}
              capture="environment"
              multiple
              onChange={event => setNoteFiles(Array.from(event.target.files || []))}
              style={{ display: 'none' }}
            />
            <div className="btm-project-actions" style={{ padding: '10px 0 0' }}>
              <button type="button" onClick={() => fileInputRef.current?.click()} className="btm-action-button btm-action-photo">
                <Camera size={21} />
                <span>{noteFiles.length ? `${noteFiles.length} Ready` : 'Add Pictures'}</span>
              </button>
              <button type="button" onClick={sendFieldNote} disabled={sendingNote || !noteText.trim()} className="btm-action-button btm-action-punch">
                <Send size={21} />
                <span>{sendingNote ? 'Sending...' : 'Send Field Note'}</span>
              </button>
            </div>
          </div>
        </section>

        <section className="btm-list-section" aria-label="Active field work" style={{ marginTop: 18 }}>
          <div className="btm-section-header"><p>{fieldWork.tasks?.length || 0} Work Items</p></div>
          {(fieldWork.tasks || []).map((task: any) => {
            const paymentHold = task.invoice_blocks_payment;
            const taskDraft = getTaskEvidenceDraft(task.id);
            return (
              <article key={task.id} className="btm-project-card" style={{ padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ color: '#111827', fontSize: 17, lineHeight: 1.2 }}>{task.title}</strong>
                    <p style={{ color: '#5D697A', margin: '5px 0 0', fontSize: 13, fontWeight: 800 }}>{task.category || 'Field Work'}</p>
                  </div>
                  <span className={`btm-status-pill ${paymentHold ? 'btm-status-danger' : task.verification_status === 'approved' ? 'btm-status-success' : 'btm-status-warning'}`}>
                    {paymentHold ? 'Hold' : String(task.verification_status || 'review').replace(/_/g, ' ')}
                  </span>
                </div>
                {upperManagementUser ? (
                  <div style={{ display: 'grid', gap: 9, marginTop: 12 }}>
                    <select value={task.status || 'not_started'} onChange={event => updateTask(task, { status: event.target.value })} style={{ minHeight: 52, borderRadius: 14, border: '1px solid #D7DEE8', padding: '0 12px', fontWeight: 900, color: '#111827', background: '#fff' }}>
                      {workStatuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    <select value={task.invoice_status || 'not_received'} onChange={event => updateTask(task, { invoice_status: event.target.value })} style={{ minHeight: 52, borderRadius: 14, border: '1px solid #D7DEE8', padding: '0 12px', fontWeight: 900, color: '#111827', background: '#fff' }}>
                      {invoiceStatuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                    <span className="btm-status-pill btm-status-info">{String(task.status || 'not_started').replace(/_/g, ' ')}</span>
                    <span className="btm-status-pill btm-status-neutral">{String(task.invoice_status || 'not_received').replace(/_/g, ' ')}</span>
                  </div>
                )}
                {task.latest_photo_note && (
                  <div style={{ marginTop: 12, border: '1px solid #DBEAFE', borderRadius: 14, background: '#EFF6FF', padding: 10 }}>
                    <p style={{ margin: 0, color: '#1E3A8A', fontSize: 11, fontWeight: 950, textTransform: 'uppercase' }}>Latest photo note</p>
                    <p style={{ margin: '4px 0 0', color: '#111827', fontSize: 13, fontWeight: 750, lineHeight: 1.35 }}>{task.latest_photo_note}</p>
                  </div>
                )}
                <div style={{ marginTop: 12, border: '1px solid #D7DEE8', borderRadius: 16, background: '#F8FAFC', padding: 11 }}>
                  <label style={{ display: 'grid', gap: 6 }}>
                    <span style={{ color: '#4B5563', fontSize: 11, fontWeight: 950, textTransform: 'uppercase' }}>Note for these pictures</span>
                    <VoiceTextarea
                      value={taskDraft.note}
                      onChange={event => updateTaskEvidenceDraft(task.id, { note: event.target.value })}
                      rows={3}
                      disabled={uploadingTaskId === task.id}
                      placeholder="Example: Furnace installed, needs final wiring check before invoice approval."
                      style={{ width: '100%', boxSizing: 'border-box', borderRadius: 13, border: '1px solid #CBD5E1', padding: 11, color: '#111827', fontSize: 14, fontWeight: 800, resize: 'vertical', background: 'white' }}
                    />
                  </label>
                  {taskDraft.files.length > 0 && (
                    <p style={{ margin: '8px 0 0', color: '#374151', fontSize: 12, fontWeight: 850 }}>
                      {taskDraft.files.length} picture{taskDraft.files.length === 1 ? '' : 's'} selected for this note.
                    </p>
                  )}
                </div>
                <div className="btm-project-actions" style={{ padding: '10px 0 0' }}>
                  <label className="btm-action-button btm-action-photo" style={{ cursor: 'pointer' }}>
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      multiple
                      style={{ display: 'none' }}
                      disabled={uploadingTaskId === task.id}
                      onChange={event => {
                        updateTaskEvidenceDraft(task.id, { files: Array.from(event.target.files || []) });
                        event.currentTarget.value = '';
                      }}
                    />
                    <ImagePlus size={21} />
                    <span>{taskDraft.files.length ? `${taskDraft.files.length} Ready` : 'Task Photos'}</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => uploadTaskPhotos(task)}
                    disabled={uploadingTaskId === task.id || taskDraft.files.length === 0}
                    className="btm-action-button btm-action-open"
                  >
                    <Send size={21} />
                    <span>{uploadingTaskId === task.id ? 'Uploading...' : 'Send Photo + Note'}</span>
                  </button>
                  {upperManagementUser && task.verification_status !== 'approved' && (
                    <button type="button" onClick={() => approveTask(task)} className="btm-action-button btm-action-punch">
                      <CheckCircle2 size={21} />
                      <span>Approve</span>
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </section>
      </main>
    </div>
  );
}
