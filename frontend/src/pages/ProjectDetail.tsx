import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useAuthStore, canManageProjects, isAdminRole } from '../store/authStore';
import api from '../lib/api';
import { Loading, StatusBadge, Modal } from '../components/ui';
import { ArrowLeft, MapPin, Edit2, Users, Plus, Trash2, Camera, FileText, ClipboardList, Activity, MessageSquare, UserPlus } from 'lucide-react';
import toast from 'react-hot-toast';
import { useForm } from 'react-hook-form';
import { format } from 'date-fns';
import GooglePlacesInput from '../components/GooglePlacesInput';

type Tab = 'overview' | 'punch-list' | 'photos' | 'invoices' | 'activity' | 'notes' | 'team';

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [project, setProject] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('overview');
  const [showEdit, setShowEdit] = useState(false);
  const [showAssign, setShowAssign] = useState(false);
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [notes, setNotes] = useState<any[]>([]);
  const [newNote, setNewNote] = useState('');
  const [noteType, setNoteType] = useState('general');
  const [activity, setActivity] = useState<any[]>([]);
  const [editAddress, setEditAddress] = useState('');
  const { register, handleSubmit, reset, setValue, formState: { isSubmitting } } = useForm();

  const load = async () => {
    try {
      const res = await api.get(`/projects/${id}`);
      setProject(res.data);
    } catch (err) {
      toast.error('Failed to load project');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (tab === 'notes') loadNotes();
    if (tab === 'activity') loadActivity();
  }, [tab]);

  const loadNotes = async () => {
    const res = await api.get(`/projects/${id}/notes`);
    setNotes(res.data);
  };

  const loadActivity = async () => {
    const res = await api.get(`/projects/${id}/activity`);
    setActivity(res.data);
  };

  const loadUsers = async () => {
    if (user && isAdminRole(user.role)) {
      const res = await api.get('/users');
      setAllUsers(res.data);
    }
  };

  const handleAssign = async (userId: string) => {
    try {
      await api.post(`/projects/${id}/assign`, { user_id: userId });
      toast.success('User assigned');
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to assign user');
    }
  };

  const handleUnassign = async (userId: string) => {
    try {
      await api.delete(`/projects/${id}/assign/${userId}`);
      toast.success('User removed');
      load();
    } catch (err) {
      toast.error('Failed to remove user');
    }
  };

  const onEditProject = async (data: any) => {
    try {
      await api.put(`/projects/${id}`, { ...data, address: editAddress || data.address, budget: data.budget ? parseFloat(data.budget) : null });
      toast.success('Project updated');
      setShowEdit(false);
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update project');
    }
  };

  const addNote = async () => {
    if (!newNote.trim()) return;
    try {
      await api.post(`/projects/${id}/notes`, { note: newNote, note_type: noteType });
      setNewNote('');
      loadNotes();
    } catch (err) {
      toast.error('Failed to add note');
    }
  };

  if (loading) return <Loading />;
  if (!project) return <div className="p-6 text-center text-gray-500">Project not found</div>;

  const tabs: { id: Tab; label: string; icon: any }[] = [
    { id: 'overview', label: 'Overview', icon: MapPin },
    { id: 'punch-list', label: 'Punch List', icon: ClipboardList },
    { id: 'photos', label: 'Photos', icon: Camera },
    { id: 'invoices', label: 'Invoices', icon: FileText },
    { id: 'notes', label: 'Notes', icon: MessageSquare },
    { id: 'team', label: 'Team', icon: Users },
    { id: 'activity', label: 'Activity', icon: Activity },
  ];

  const canEdit = user && canManageProjects(user.role);
  const canAssign = user && isAdminRole(user.role);

  return (
    <div className="min-h-full">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="px-4 md:px-6 py-3">
          <div className="flex items-center gap-3 mb-3">
            <button onClick={() => navigate('/projects')} className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="font-bold text-gray-900 text-lg truncate">{project.address}</h1>
                <StatusBadge status={project.status} />
              </div>
              <p className="text-sm text-gray-500 truncate">{project.job_name}</p>
            </div>
            {canEdit && (
              <button onClick={() => { setShowEdit(true); setEditAddress(project.address || ''); Object.entries(project).forEach(([k, v]) => setValue(k, v)); }} className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors">
                <Edit2 className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Tabs */}
          <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-hide">
            {tabs.map(({ id: tabId, label, icon: Icon }) => (
              <button
                key={tabId}
                onClick={() => setTab(tabId)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors flex-shrink-0 ${
                  tab === tabId ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tab Content */}
      <div className="p-4 md:p-6 max-w-5xl mx-auto">
        {/* Overview */}
        {tab === 'overview' && (
          <div className="space-y-4">
            {/* Stats row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: 'Open Punch Items', value: project.punch_stats?.filter((s: any) => s.status !== 'completed').reduce((a: number, b: any) => a + b.cnt, 0) || 0, color: 'text-orange-600', bg: 'bg-orange-50' },
                { label: 'Completed Items', value: project.punch_stats?.find((s: any) => s.status === 'completed')?.cnt || 0, color: 'text-green-600', bg: 'bg-green-50' },
                { label: 'Recent Photos', value: project.recent_photos?.length || 0, color: 'text-blue-600', bg: 'bg-blue-50' },
                { label: 'Invoices', value: project.recent_invoices?.length || 0, color: 'text-purple-600', bg: 'bg-purple-50' },
              ].map(({ label, value, color, bg }) => (
                <div key={label} className="bg-white rounded-xl border border-gray-200 p-4">
                  <p className={`text-2xl font-bold ${color}`}>{value}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{label}</p>
                </div>
              ))}
            </div>

            {/* Project details */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="font-semibold text-gray-900 mb-4">Project Details</h3>
              <div className="grid sm:grid-cols-2 gap-4 text-sm">
                {[
                  { label: 'Status', value: <StatusBadge status={project.status} /> },
                  { label: 'Stage', value: project.project_stage || '—' },
                  { label: 'Start Date', value: project.start_date ? format(new Date(project.start_date), 'MMM d, yyyy') : '—' },
                  { label: 'Target Completion', value: project.target_completion ? format(new Date(project.target_completion), 'MMM d, yyyy') : '—' },
                  { label: 'Budget', value: project.budget ? `$${project.budget.toLocaleString()}` : '—' },
                  { label: 'Created By', value: project.created_by_name || '—' },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <p className="text-xs text-gray-500 mb-0.5">{label}</p>
                    <div className="font-medium text-gray-900">{value}</div>
                  </div>
                ))}
              </div>
            </div>

            {project.scope_of_work && (
              <div className="bg-white rounded-xl border border-gray-200 p-5">
                <h3 className="font-semibold text-gray-900 mb-2">Scope of Work</h3>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{project.scope_of_work}</p>
              </div>
            )}

            {/* Quick actions */}
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => setTab('punch-list')} className="flex items-center gap-3 p-4 bg-white rounded-xl border border-gray-200 hover:border-orange-300 hover:bg-orange-50 transition-all text-left">
                <ClipboardList className="w-6 h-6 text-orange-500" />
                <div>
                  <p className="font-medium text-gray-900 text-sm">Punch List</p>
                  <p className="text-xs text-gray-500">View & update tasks</p>
                </div>
              </button>
              <button onClick={() => setTab('photos')} className="flex items-center gap-3 p-4 bg-white rounded-xl border border-gray-200 hover:border-blue-300 hover:bg-blue-50 transition-all text-left">
                <Camera className="w-6 h-6 text-blue-500" />
                <div>
                  <p className="font-medium text-gray-900 text-sm">Photos</p>
                  <p className="text-xs text-gray-500">Upload & view photos</p>
                </div>
              </button>
              <button onClick={() => setTab('invoices')} className="flex items-center gap-3 p-4 bg-white rounded-xl border border-gray-200 hover:border-purple-300 hover:bg-purple-50 transition-all text-left">
                <FileText className="w-6 h-6 text-purple-500" />
                <div>
                  <p className="font-medium text-gray-900 text-sm">Invoices</p>
                  <p className="text-xs text-gray-500">Create & submit invoices</p>
                </div>
              </button>
              <button onClick={() => setTab('notes')} className="flex items-center gap-3 p-4 bg-white rounded-xl border border-gray-200 hover:border-green-300 hover:bg-green-50 transition-all text-left">
                <MessageSquare className="w-6 h-6 text-green-500" />
                <div>
                  <p className="font-medium text-gray-900 text-sm">Notes</p>
                  <p className="text-xs text-gray-500">Add field & office notes</p>
                </div>
              </button>
            </div>
          </div>
        )}

        {/* Punch List Tab */}
        {tab === 'punch-list' && (
          <PunchListTab projectId={id!} user={user} />
        )}

        {/* Photos Tab */}
        {tab === 'photos' && (
          <PhotosTab projectId={id!} user={user} />
        )}

        {/* Invoices Tab */}
        {tab === 'invoices' && (
          <InvoicesTab projectId={id!} user={user} project={project} />
        )}

        {/* Notes Tab */}
        {tab === 'notes' && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <h3 className="font-semibold text-gray-900 mb-3 text-sm">Add Note</h3>
              <textarea
                value={newNote}
                onChange={e => setNewNote(e.target.value)}
                rows={3}
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none mb-2"
                placeholder="Add a note..."
              />
              <div className="flex gap-2">
                <select value={noteType} onChange={e => setNoteType(e.target.value)} className="px-3 py-2 rounded-lg border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="general">General</option>
                  <option value="office">Office</option>
                  <option value="field">Field</option>
                </select>
                <button onClick={addNote} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">Add Note</button>
              </div>
            </div>
            <div className="space-y-3">
              {notes.map(note => (
                <div key={note.id} className="bg-white rounded-xl border border-gray-200 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-gray-900">{note.user_name}</span>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${note.note_type === 'field' ? 'bg-green-100 text-green-700' : note.note_type === 'office' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>{note.note_type}</span>
                      <span className="text-xs text-gray-400">{format(new Date(note.created_at), 'MMM d, h:mm a')}</span>
                    </div>
                  </div>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{note.note}</p>
                </div>
              ))}
              {notes.length === 0 && <p className="text-center text-gray-400 text-sm py-8">No notes yet</p>}
            </div>
          </div>
        )}

        {/* Team Tab */}
        {tab === 'team' && (
          <div className="space-y-4">
            {canAssign && (
              <button onClick={() => { setShowAssign(true); loadUsers(); }} className="w-full flex items-center justify-center gap-2 py-3 border-2 border-dashed border-gray-300 rounded-xl text-sm font-medium text-gray-600 hover:border-blue-400 hover:text-blue-600 transition-colors">
                <UserPlus className="w-4 h-4" /> Assign User to Project
              </button>
            )}
            <div className="space-y-3">
              {project.assignments?.map((a: any) => (
                <div key={a.id} className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3">
                  <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                    <span className="text-blue-700 font-bold text-sm">{a.name?.[0]?.toUpperCase()}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900 text-sm">{a.name}</p>
                    <p className="text-xs text-gray-500">{a.email}</p>
                    <span className="text-xs text-gray-400 capitalize">{a.role.replace(/_/g, ' ')}</span>
                  </div>
                  {canAssign && (
                    <button onClick={() => handleUnassign(a.user_id)} className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
              {project.assignments?.length === 0 && <p className="text-center text-gray-400 text-sm py-8">No users assigned</p>}
            </div>
          </div>
        )}

        {/* Activity Tab */}
        {tab === 'activity' && (
          <div className="space-y-2">
            {activity.map(log => (
              <div key={log.id} className="bg-white rounded-xl border border-gray-200 p-4 flex items-start gap-3">
                <div className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Activity className="w-4 h-4 text-gray-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-900"><span className="font-medium">{log.user_name}</span> {log.action.replace(/_/g, ' ')}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{format(new Date(log.created_at), 'MMM d, yyyy h:mm a')}</p>
                </div>
              </div>
            ))}
            {activity.length === 0 && <p className="text-center text-gray-400 text-sm py-8">No activity yet</p>}
          </div>
        )}
      </div>

      {/* Edit Project Modal */}
      <Modal isOpen={showEdit} onClose={() => setShowEdit(false)} title="Edit Project" size="lg">
        <form onSubmit={handleSubmit(onEditProject)} className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Address *</label>
              <GooglePlacesInput
                value={editAddress}
                onChange={(val) => { setEditAddress(val); setValue('address', val); }}
                placeholder="123 Main St, City, State"
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Job Name *</label>
              <input {...register('job_name', { required: true })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select {...register('status')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                <option value="active">Active</option>
                <option value="in_progress">In Progress</option>
                <option value="on_hold">On Hold</option>
                <option value="completed">Completed</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Stage</label>
              <input {...register('project_stage')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
              <input type="date" {...register('start_date')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Target Completion</label>
              <input type="date" {...register('target_completion')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Budget ($)</label>
              <input type="number" {...register('budget')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Scope of Work</label>
              <textarea {...register('scope_of_work')} rows={3} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Office Notes</label>
              <textarea {...register('office_notes')} rows={2} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Field Notes</label>
              <textarea {...register('field_notes')} rows={2} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={() => setShowEdit(false)} className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">
              {isSubmitting ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Assign User Modal */}
      <Modal isOpen={showAssign} onClose={() => setShowAssign(false)} title="Assign User to Project">
        <div className="space-y-2">
          {allUsers.filter(u => !project.assignments?.some((a: any) => a.user_id === u.id)).map(u => (
            <button key={u.id} onClick={() => { handleAssign(u.id); setShowAssign(false); }} className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50 transition-colors text-left">
              <div className="w-9 h-9 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                <span className="text-blue-700 font-bold text-sm">{u.name?.[0]?.toUpperCase()}</span>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900">{u.name}</p>
                <p className="text-xs text-gray-500">{u.email} · {u.role.replace(/_/g, ' ')}</p>
              </div>
            </button>
          ))}
          {allUsers.filter(u => !project.assignments?.some((a: any) => a.user_id === u.id)).length === 0 && (
            <p className="text-center text-gray-400 text-sm py-4">All users are already assigned</p>
          )}
        </div>
      </Modal>
    </div>
  );
}

// ---- Sub-components ----

function PunchListTab({ projectId, user }: { projectId: string; user: any }) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState('');
  const [expandedItem, setExpandedItem] = useState<string | null>(null);
  const { register, handleSubmit, reset, formState: { isSubmitting } } = useForm();

  const load = async () => {
    try {
      const params = filter ? `?status=${filter}` : '';
      const res = await api.get(`/projects/${projectId}/punch-list${params}`);
      setItems(res.data);
    } catch (err) { } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [filter]);

  const onAdd = async (data: any) => {
    try {
      await api.post(`/projects/${projectId}/punch-list`, data);
      toast.success('Item added');
      setShowAdd(false);
      reset();
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to add item');
    }
  };

  const updateStatus = async (itemId: string, status: string) => {
    try {
      await api.put(`/projects/${projectId}/punch-list/${itemId}`, { status });
      load();
    } catch (err) { toast.error('Failed to update'); }
  };

  const priorityColors: Record<string, string> = { low: 'bg-gray-100 text-gray-600', medium: 'bg-blue-100 text-blue-700', high: 'bg-orange-100 text-orange-700', urgent: 'bg-red-100 text-red-700' };
  const statusColors: Record<string, string> = { not_started: 'bg-gray-100 text-gray-600', in_progress: 'bg-blue-100 text-blue-700', waiting_materials: 'bg-orange-100 text-orange-700', needs_review: 'bg-purple-100 text-purple-700', completed: 'bg-green-100 text-green-700' };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <div className="flex gap-1 flex-1 overflow-x-auto">
          {[['', 'All'], ['not_started', 'Open'], ['in_progress', 'In Progress'], ['completed', 'Done'], ['urgent', 'Urgent']].map(([val, label]) => (
            <button key={val} onClick={() => setFilter(val)} className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${filter === val ? 'bg-blue-600 text-white' : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-50'}`}>{label}</button>
          ))}
        </div>
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 transition-colors flex-shrink-0">
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
      </div>

      {loading ? <Loading /> : (
        <div className="space-y-2">
          {items.map(item => (
            <div key={item.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="p-4 flex items-start gap-3">
                <button
                  onClick={() => updateStatus(item.id, item.status === 'completed' ? 'not_started' : 'completed')}
                  className={`w-5 h-5 rounded-full border-2 flex-shrink-0 mt-0.5 transition-colors ${item.status === 'completed' ? 'bg-green-500 border-green-500' : 'border-gray-300 hover:border-green-400'}`}
                >
                  {item.status === 'completed' && <svg className="w-full h-full text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                </button>
                <div className="flex-1 min-w-0" onClick={() => setExpandedItem(expandedItem === item.id ? null : item.id)}>
                  <div className="flex items-start justify-between gap-2">
                    <p className={`text-sm font-medium ${item.status === 'completed' ? 'line-through text-gray-400' : 'text-gray-900'}`}>{item.title}</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${priorityColors[item.priority]}`}>{item.priority}</span>
                  </div>
                  {item.description && <p className="text-xs text-gray-500 mt-0.5 truncate">{item.description}</p>}
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[item.status]}`}>{item.status.replace(/_/g, ' ')}</span>
                    {item.assigned_to_name && <span className="text-xs text-gray-500">→ {item.assigned_to_name}</span>}
                    {item.due_date && <span className="text-xs text-gray-400">{format(new Date(item.due_date), 'MMM d')}</span>}
                    {item.photo_count > 0 && <span className="text-xs text-blue-500">{item.photo_count} photos</span>}
                  </div>
                </div>
              </div>
              {expandedItem === item.id && (
                <div className="px-4 pb-4 border-t border-gray-100 pt-3">
                  <div className="flex gap-2 flex-wrap">
                    {['not_started', 'in_progress', 'waiting_materials', 'needs_review', 'completed'].map(s => (
                      <button key={s} onClick={() => updateStatus(item.id, s)} className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${item.status === s ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{s.replace(/_/g, ' ')}</button>
                    ))}
                  </div>
                  {item.notes && <p className="text-xs text-gray-600 mt-2 bg-gray-50 rounded-lg p-2">{item.notes}</p>}
                </div>
              )}
            </div>
          ))}
          {items.length === 0 && <div className="text-center py-12 bg-white rounded-xl border border-gray-200"><ClipboardList className="w-8 h-8 text-gray-300 mx-auto mb-2" /><p className="text-gray-400 text-sm">No punch list items</p></div>}
        </div>
      )}

      <Modal isOpen={showAdd} onClose={() => { setShowAdd(false); reset(); }} title="Add Punch List Item">
        <form onSubmit={handleSubmit(onAdd)} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Title *</label>
            <input {...register('title', { required: true })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Task title" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea {...register('description')} rows={2} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" placeholder="Detailed description..." />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
              <select {...register('priority')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Due Date</label>
              <input type="date" {...register('due_date')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea {...register('notes')} rows={2} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={() => { setShowAdd(false); reset(); }} className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">Add Item</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function PhotosTab({ projectId, user }: { projectId: string; user: any }) {
  const [photos, setPhotos] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [showNewCat, setShowNewCat] = useState(false);
  const [newCatName, setNewCatName] = useState('');

  const load = async () => {
    try {
      const [photosRes, catsRes] = await Promise.all([
        api.get(`/projects/${projectId}/photos${selectedCategory ? `?category_id=${selectedCategory}` : ''}`),
        api.get(`/projects/${projectId}/photos/categories`),
      ]);
      setPhotos(photosRes.data);
      setCategories(catsRes.data);
    } catch (err) { } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [selectedCategory]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    setUploading(true);
    const formData = new FormData();
    Array.from(e.target.files).forEach(f => formData.append('photos', f));
    if (selectedCategory) formData.append('category_id', selectedCategory);
    try {
      await api.post(`/projects/${projectId}/photos`, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(`${e.target.files.length} photo(s) uploaded`);
      load();
    } catch (err) {
      toast.error('Upload failed');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const addCategory = async () => {
    if (!newCatName.trim()) return;
    try {
      await api.post(`/projects/${projectId}/photos/categories`, { name: newCatName });
      setNewCatName('');
      setShowNewCat(false);
      load();
    } catch (err) { toast.error('Failed to add category'); }
  };

  return (
    <div className="space-y-4">
      {/* Upload button */}
      <label className={`flex items-center justify-center gap-2 py-3 border-2 border-dashed rounded-xl cursor-pointer transition-colors ${uploading ? 'border-blue-400 bg-blue-50' : 'border-gray-300 hover:border-blue-400 hover:bg-blue-50'}`}>
        <input type="file" multiple accept="image/*" onChange={handleUpload} className="hidden" disabled={uploading} />
        <Camera className="w-5 h-5 text-blue-500" />
        <span className="text-sm font-medium text-blue-600">{uploading ? 'Uploading...' : 'Tap to Upload Photos'}</span>
      </label>

      {/* Categories */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        <button onClick={() => setSelectedCategory('')} className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap flex-shrink-0 transition-colors ${!selectedCategory ? 'bg-blue-600 text-white' : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-50'}`}>All Photos ({photos.length})</button>
        {categories.map(cat => (
          <button key={cat.id} onClick={() => setSelectedCategory(cat.id)} className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap flex-shrink-0 transition-colors ${selectedCategory === cat.id ? 'bg-blue-600 text-white' : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-50'}`}>{cat.name} ({cat.photo_count})</button>
        ))}
        <button onClick={() => setShowNewCat(true)} className="px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap flex-shrink-0 bg-white border border-dashed border-gray-300 text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors">+ Category</button>
      </div>

      {showNewCat && (
        <div className="flex gap-2">
          <input value={newCatName} onChange={e => setNewCatName(e.target.value)} placeholder="Category name" className="flex-1 px-3.5 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" onKeyDown={e => e.key === 'Enter' && addCategory()} />
          <button onClick={addCategory} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">Add</button>
          <button onClick={() => setShowNewCat(false)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
        </div>
      )}

      {loading ? <Loading /> : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
          {photos.map(photo => (
            <div key={photo.id} className="relative group aspect-square rounded-xl overflow-hidden bg-gray-100 cursor-pointer" onClick={() => setLightbox(`/uploads/${projectId}/${photo.filename}`)}>
              <img src={`/uploads/${projectId}/${photo.filename}`} alt={photo.original_name} className="w-full h-full object-cover transition-transform group-hover:scale-105" />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
              <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                <p className="text-white text-xs truncate">{photo.uploader_name}</p>
                <p className="text-white/70 text-xs">{format(new Date(photo.created_at), 'MMM d')}</p>
              </div>
            </div>
          ))}
          {photos.length === 0 && (
            <div className="col-span-full text-center py-12">
              <Camera className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="text-gray-400 text-sm">No photos yet</p>
            </div>
          )}
        </div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" className="max-w-full max-h-full object-contain rounded-lg" />
          <button className="absolute top-4 right-4 text-white/70 hover:text-white" onClick={() => setLightbox(null)}>
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      )}
    </div>
  );
}

function InvoicesTab({ projectId, user, project }: { projectId: string; user: any; project: any }) {
  const navigate = useNavigate();
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const res = await api.get(`/projects/${projectId}/invoices`);
      setInvoices(res.data);
    } catch (err) { } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const statusColors: Record<string, string> = { draft: 'bg-gray-100 text-gray-600', submitted: 'bg-blue-100 text-blue-700', reviewed: 'bg-yellow-100 text-yellow-700', approved: 'bg-green-100 text-green-700', paid: 'bg-emerald-100 text-emerald-700' };

  return (
    <div className="space-y-4">
      <button onClick={() => navigate(`/projects/${projectId}/invoices/new`)} className="w-full flex items-center justify-center gap-2 py-3.5 bg-blue-600 text-white rounded-xl font-semibold text-sm hover:bg-blue-700 transition-colors shadow-sm">
        <Plus className="w-5 h-5" /> CREATE INVOICE
      </button>

      {loading ? <Loading /> : (
        <div className="space-y-3">
          {invoices.map(inv => (
            <div key={inv.id} className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-purple-100 rounded-xl flex items-center justify-center flex-shrink-0">
                <FileText className="w-5 h-5 text-purple-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-gray-900 text-sm">#{inv.invoice_number}</p>
                <p className="text-xs text-gray-500">{inv.contractor_name} · {format(new Date(inv.created_at), 'MMM d, yyyy')}</p>
              </div>
              <div className="text-right">
                <p className="font-bold text-gray-900">${inv.total.toFixed(2)}</p>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[inv.status]}`}>{inv.status}</span>
              </div>
            </div>
          ))}
          {invoices.length === 0 && <div className="text-center py-12 bg-white rounded-xl border border-gray-200"><FileText className="w-8 h-8 text-gray-300 mx-auto mb-2" /><p className="text-gray-400 text-sm">No invoices yet</p></div>}
        </div>
      )}
    </div>
  );
}
