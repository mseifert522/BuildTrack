import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore, canChangeProjectStatus, canCreateProjects, isAdminRole } from '../store/authStore';
import api from '../lib/api';
import { Loading, StatusBadge, Modal, PageHeader } from '../components/ui';
import { Activity, Camera, CheckCircle2, FileText, Plus, Search, MapPin, Users, ClipboardList, ChevronRight, Bell, KeyRound, MessageSquare, Upload, MoreHorizontal } from 'lucide-react';
import toast from 'react-hot-toast';
import { useForm } from 'react-hook-form';
import GooglePlacesInput from '../components/GooglePlacesInput';
import CurrencyInput from '../components/CurrencyInput';

interface Project {
  id: string;
  address: string;
  job_name: string;
  status: string;
  start_date: string;
  target_completion: string;
  open_punch_items: number;
  assigned_count: number;
  budget: number;
  updated_at: string;
  main_photo_url?: string | null;
  lockbox_code?: string | null;
}

interface ProjectForm {
  address: string;
  job_name: string;
  status: string;
  start_date: string;
  target_completion: string;
  scope_of_work: string;
  budget: string;
  office_notes: string;
  purchase_price: string;
  acquisition_date: string;
  lockbox_code: string;
}

interface ProjectReviewSummary {
  project_id: string;
  change_count: number;
  latest_at: string;
  latest_by: string;
  changes: { id: string; summary: string; user_name: string; created_at: string }[];
}

const PROJECT_FILTER_OPTIONS = [
  { value: '', label: 'Total Projects' },
  { value: 'active_rehab', label: 'Active Rehabs' },
  { value: 'not_started', label: 'Not Started' },
  { value: 'rehab_completed', label: 'Completed Projects' },
  { value: 'long_term_holding', label: 'Long-Term Holdings' },
  { value: 'commercial', label: 'Commercial' },
];

const PROJECT_STATUS_OPTIONS = [
  { value: 'not_started', label: 'Not Started' },
  { value: 'active_rehab', label: 'Active Rehabs' },
  { value: 'rehab_completed', label: 'Completed Projects' },
  { value: 'long_term_holding', label: 'Long-Term Holdings' },
  { value: 'commercial', label: 'Commercial' },
];

const DOCUMENT_CATEGORIES = [
  { value: 'invoices', label: 'Invoices' },
  { value: 'quotes', label: 'Quotes' },
  { value: 'other_documents', label: 'Other Documents' },
  { value: 'insurance_documents', label: 'Insurance Documents' },
];

function isMobileCaptureContext() {
  if (typeof window === 'undefined') return false;
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return Boolean(window.matchMedia?.('(max-width: 767px)').matches) || /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
}

export default function Projects() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [searchParams] = useSearchParams();
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || '');
  const [showCreate, setShowCreate] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState<string | null>(null);
  const [lockboxProject, setLockboxProject] = useState<Project | null>(null);
  const [documentUploadProject, setDocumentUploadProject] = useState<Project | null>(null);
  const [documentType, setDocumentType] = useState(DOCUMENT_CATEGORIES[0].value);
  const [documentFiles, setDocumentFiles] = useState<File[]>([]);
  const [uploadingDocuments, setUploadingDocuments] = useState(false);
  const [reviewSummaries, setReviewSummaries] = useState<Record<string, ProjectReviewSummary>>({});
  const [addressValue, setAddressValue] = useState('');
  const [budgetValue, setBudgetValue] = useState('');
  const [purchasePriceValue, setPurchasePriceValue] = useState('');
  const [activeActionsProjectId, setActiveActionsProjectId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState('updated');
  const [teamFilter, setTeamFilter] = useState('');
  const { register, handleSubmit, reset, setValue, formState: { isSubmitting, errors } } = useForm<ProjectForm>();

  const load = async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (search) params.set('search', search);
      const [res, reviewRes] = await Promise.all([
        api.get(`/projects?${params}`),
        user && isAdminRole(user.role)
          ? api.get('/projects/unreviewed-summary').catch(() => ({ data: { projects: [] } }))
          : Promise.resolve({ data: { projects: [] } }),
      ]);
      setProjects(res.data);
      const summaries = Array.isArray(reviewRes.data?.projects) ? reviewRes.data.projects : [];
      setReviewSummaries(Object.fromEntries(summaries.map((s: ProjectReviewSummary) => [s.project_id, s])));
    } catch (err) {
      toast.error('Failed to load projects');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [statusFilter, user?.id, user?.role]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    load();
  };

  const onCreateProject = async (data: ProjectForm) => {
    try {
      const res = await api.post('/projects', { ...data, address: addressValue || data.address, budget: budgetValue ? parseFloat(budgetValue) : null, purchase_price: purchasePriceValue ? parseFloat(purchasePriceValue) : null });
      toast.success('Project created!');
      setShowCreate(false);
      reset();
      navigate(`/projects/${res.data.id}`);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to create project');
    }
  };

  const canCreate = user && canCreateProjects(user.role);
  const canManageProjectActions = user && isAdminRole(user.role);
  const canChangeStatus = user && canChangeProjectStatus(user.role);

  const projectRows = useMemo(() => {
    const toTime = (value?: string) => value ? new Date(value).getTime() || 0 : 0;
    return [...projects]
      .filter(project => {
        if (teamFilter === 'assigned') return Number(project.assigned_count || 0) > 0;
        if (teamFilter === 'unassigned') return Number(project.assigned_count || 0) === 0;
        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'address') return String(a.address || '').localeCompare(String(b.address || ''));
        if (sortBy === 'budget') return Number(b.budget || 0) - Number(a.budget || 0);
        if (sortBy === 'punch') return Number(b.open_punch_items || 0) - Number(a.open_punch_items || 0);
        if (sortBy === 'target') return toTime(a.target_completion) - toTime(b.target_completion);
        return toTime(b.updated_at) - toTime(a.updated_at);
      });
  }, [projects, sortBy, teamFilter]);

  const updateProjectStatus = async (project: Project, nextStatus: string) => {
    if (!canChangeStatus || project.status === nextStatus) return;
    setUpdatingStatus(project.id);
    try {
      await api.put(`/projects/${project.id}`, { status: nextStatus });
      setProjects(current => current.map(item => item.id === project.id ? { ...item, status: nextStatus } : item));
      toast.success(`Status updated to ${PROJECT_STATUS_OPTIONS.find(option => option.value === nextStatus)?.label || nextStatus}`);
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update project status');
    } finally {
      setUpdatingStatus(null);
    }
  };

  const uploadProjectPhoto = async (project: Project, file?: File) => {
    if (!file || !canManageProjectActions) return;
    setUploadingPhoto(project.id);
    try {
      const formData = new FormData();
      formData.append('photo', file);
      const res = await api.post(`/projects/${project.id}/main-photo`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setProjects(current => current.map(item => item.id === project.id ? { ...item, main_photo_url: res.data.main_photo_url } : item));
      toast.success('Project house photo updated');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to upload project photo');
    } finally {
      setUploadingPhoto(null);
    }
  };

  const closeDocumentUpload = () => {
    setDocumentUploadProject(null);
    setDocumentType(DOCUMENT_CATEGORIES[0].value);
    setDocumentFiles([]);
  };

  const uploadProjectDocuments = async () => {
    if (!documentUploadProject || documentFiles.length === 0) return;
    setUploadingDocuments(true);
    try {
      const formData = new FormData();
      formData.append('document_type', documentType);
      documentFiles.forEach(file => formData.append('documents', file));
      await api.post(`/documents/${documentUploadProject.id}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success(documentFiles.length === 1 ? 'Document uploaded' : 'Documents uploaded');
      closeDocumentUpload();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to upload documents');
    } finally {
      setUploadingDocuments(false);
    }
  };

  return (
    <div
      className="bt-horizontal-lock min-h-full w-full max-w-full overflow-x-hidden px-4 py-4 md:px-8 md:py-6"
      style={{ background: '#F0F2F5', touchAction: 'pan-y', overscrollBehaviorX: 'none' }}
    >
      <div className="bt-horizontal-lock mx-auto w-full max-w-7xl min-w-0">
      <PageHeader
        title="Projects"
        subtitle={`${projectRows.length} of ${projects.length} project${projects.length !== 1 ? 's' : ''}`}
        actions={canCreate ? (
          <button onClick={() => setShowCreate(true)} className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-xl font-medium text-sm hover:bg-blue-700 transition-colors shadow-sm">
            <Plus className="w-4 h-4" /> New Project
          </button>
        ) : undefined}
      />

      {/* Filters */}
      <div className="bt-horizontal-lock mb-5 flex w-full min-w-0 flex-col gap-3 rounded-2xl border border-gray-200 p-3 sm:flex-row" style={{ background: 'white', boxShadow: '0 8px 24px rgba(17,24,39,0.06)' }}>
        <form onSubmit={handleSearch} className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by address or job name..."
              className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <button type="submit" className="w-full rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800 sm:w-auto">Search</button>
        </form>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 sm:w-auto"
          aria-label="Filter projects by status"
        >
          {PROJECT_FILTER_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <select
          value={teamFilter}
          onChange={e => setTeamFilter(e.target.value)}
          className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 sm:w-auto"
          aria-label="Filter projects by team assignment"
        >
          <option value="">All teams</option>
          <option value="assigned">Assigned contractors</option>
          <option value="unassigned">Unassigned projects</option>
        </select>
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value)}
          className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 sm:w-auto"
          aria-label="Sort projects"
        >
          <option value="updated">Sort: Recently updated</option>
          <option value="target">Sort: Target completion</option>
          <option value="punch">Sort: Open punch items</option>
          <option value="budget">Sort: Budget high to low</option>
          <option value="address">Sort: Location A-Z</option>
        </select>
      </div>

      {loading ? <Loading /> : (
        <div className="grid min-w-0 gap-4">
          {projectRows.length === 0 ? (
            <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
              <MapPin className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500 font-medium">No projects found</p>
              {canCreate && (
                <button onClick={() => setShowCreate(true)} className="mt-3 text-blue-600 text-sm font-medium hover:underline">
                  Create your first project
                </button>
              )}
            </div>
          ) : projectRows.map(p => {
            const review = reviewSummaries[p.id];
            return (
              <div
                key={p.id}
                onClick={() => navigate(`/projects/${p.id}`)}
                className="bt-horizontal-lock group relative flex w-full min-w-0 cursor-pointer flex-col items-stretch gap-3 overflow-visible rounded-[1.35rem] border border-slate-300 bg-gradient-to-br from-white via-white to-blue-50/45 p-4 transition-all hover:border-blue-400 hover:bg-blue-50/35 hover:shadow-xl sm:flex-row sm:items-center sm:gap-4"
                style={{
                  boxShadow: '0 10px 28px rgba(15,23,42,0.10), 0 1px 0 rgba(15,23,42,0.04)',
                  borderLeft: '5px solid #2563EB',
                }}
              >
                <button
                  type="button"
                  aria-label={`Open project ${p.address}`}
                  onClick={e => {
                    e.stopPropagation();
                    navigate(`/projects/${p.id}`);
                  }}
                  className="absolute inset-0 z-10 rounded-[1.35rem] cursor-pointer bg-transparent focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                />
                <label
                  className={`relative w-20 h-16 rounded-xl border border-blue-200 shadow-sm flex items-center justify-center flex-shrink-0 overflow-hidden ${canManageProjectActions && !p.main_photo_url ? 'z-20 cursor-pointer' : 'z-0 cursor-pointer'}`}
                  style={{ background: 'linear-gradient(135deg, #EFF6FF, #DBEAFE)' }}
                  onClick={e => {
                    if (canManageProjectActions && !p.main_photo_url) e.stopPropagation();
                  }}
                  onMouseDown={e => {
                    if (canManageProjectActions && !p.main_photo_url) e.stopPropagation();
                  }}
                  title={p.main_photo_url ? 'Main house photo uploaded' : 'Add main house photo'}
                >
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={!canManageProjectActions || uploadingPhoto === p.id || !!p.main_photo_url}
                    onChange={e => {
                      const file = e.target.files?.[0];
                      uploadProjectPhoto(p, file);
                      e.currentTarget.value = '';
                    }}
                  />
                  {p.main_photo_url ? (
                    <img src={p.main_photo_url} alt={p.address} className="w-full h-full object-cover" />
                  ) : (
                    <>
                      <MapPin className="w-6 h-6 text-blue-600" />
                      {canManageProjectActions && (
                        <span className="absolute -right-1 -top-1 w-7 h-7 rounded-full bg-blue-600 text-white flex items-center justify-center shadow-md">
                          <Plus className="w-4 h-4" />
                        </span>
                      )}
                    </>
                  )}
                </label>
                <div className="w-full flex-1 min-w-0 max-w-full">
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-900 truncate">{p.address}</p>
                      <p className="text-sm text-gray-500 truncate">{p.job_name}</p>
                    </div>
                    <div className="flex flex-shrink-0 flex-wrap items-start gap-2 sm:items-center sm:justify-end">
                      {review && (
                        <span
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-black uppercase tracking-wide whitespace-nowrap"
                          style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #FCD34D' }}
                          title={`${review.change_count} new update${review.change_count !== 1 ? 's' : ''} since your last review`}
                        >
                          <Bell className="w-3 h-3" />
                          New info to review
                        </span>
                      )}
                      <StatusBadge status={p.status} className="flex-shrink-0" />
                      <div
                        className="relative z-30"
                        onClick={event => event.stopPropagation()}
                        onMouseDown={event => event.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => setActiveActionsProjectId(activeActionsProjectId === p.id ? null : p.id)}
                          className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-black text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
                          aria-haspopup="menu"
                          aria-expanded={activeActionsProjectId === p.id}
                          aria-label={`Open actions for ${p.address}`}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                          Actions
                        </button>
                        {activeActionsProjectId === p.id && (
                          <div
                            role="menu"
                            className="absolute right-0 top-full mt-2 w-72 overflow-hidden rounded-2xl border border-slate-200 bg-white p-2 text-sm shadow-2xl"
                          >
                            {[
                              { label: 'Scope of Work', icon: FileText, hash: 'construction-plan' },
                              { label: 'Upload Quotes', icon: Upload, hash: 'quotes' },
                              { label: p.open_punch_items > 0 ? 'Punch List' : 'Punch List: Not Started', icon: ClipboardList, hash: 'punch-list' },
                              { label: 'Assigned Contractors', icon: Users, hash: 'assigned-contractors' },
                              { label: 'Enter Notes', icon: MessageSquare, hash: 'notes' },
                            ].map(action => (
                              <button
                                key={action.label}
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setActiveActionsProjectId(null);
                                  navigate(`/projects/${p.id}#${action.hash}`);
                                }}
                                className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-left font-bold text-slate-700 transition-colors hover:bg-slate-50"
                              >
                                <action.icon className="h-4 w-4 text-slate-500" />
                                {action.label}
                              </button>
                            ))}
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setActiveActionsProjectId(null);
                                setLockboxProject(p);
                              }}
                              className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-left font-bold text-slate-700 transition-colors hover:bg-slate-50"
                            >
                              <KeyRound className="h-4 w-4 text-slate-500" />
                              Lockbox Code
                            </button>
                            {canManageProjectActions && (
                              <>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => {
                                    setActiveActionsProjectId(null);
                                    setDocumentUploadProject(p);
                                  }}
                                  className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-left font-bold text-slate-700 transition-colors hover:bg-slate-50"
                                >
                                  <Upload className="h-4 w-4 text-slate-500" />
                                  Upload Documents
                                </button>
                                <label
                                  role="menuitem"
                                  className={`flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-left font-bold transition-colors ${p.main_photo_url ? 'text-slate-400' : 'cursor-pointer text-slate-700 hover:bg-slate-50'}`}
                                >
                                  <input
                                    type="file"
                                    accept="image/*"
                                    className="hidden"
                                    disabled={uploadingPhoto === p.id || !!p.main_photo_url}
                                    onChange={event => {
                                      const file = event.target.files?.[0];
                                      uploadProjectPhoto(p, file);
                                      event.currentTarget.value = '';
                                      setActiveActionsProjectId(null);
                                    }}
                                  />
                                  <Camera className="h-4 w-4 text-slate-500" />
                                  {p.main_photo_url ? 'House Photo Added' : uploadingPhoto === p.id ? 'Uploading...' : 'Add House Photo'}
                                </label>
                              </>
                            )}
                            {canChangeStatus && (
                              <div className="mt-2 border-t border-slate-100 p-2">
                                <label className="mb-1 block text-[11px] font-black uppercase tracking-wide text-slate-500">
                                  Project status
                                </label>
                                <select
                                  value={p.status}
                                  disabled={updatingStatus === p.id}
                                  onChange={event => updateProjectStatus(p, event.target.value)}
                                  className="mb-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-60"
                                  aria-label={`Change status for ${p.address}`}
                                >
                                  {PROJECT_STATUS_OPTIONS.map(option => (
                                    <option key={option.value} value={option.value}>{option.label}</option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  disabled={updatingStatus === p.id || p.status === 'rehab_completed'}
                                  onClick={() => updateProjectStatus(p, 'rehab_completed')}
                                  className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-black text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50"
                                >
                                  <CheckCircle2 className="h-4 w-4" />
                                  {p.status === 'rehab_completed' ? 'Completed' : 'Mark Completed'}
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  {review?.changes?.[0] && (
                    <p className="mt-2 text-xs text-amber-700 truncate">
                      {review.change_count} new update{review.change_count !== 1 ? 's' : ''}: {review.changes[0].summary}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-3 sm:gap-4">
                    {p.open_punch_items > 0 && (
                      <span className="flex items-center gap-1 text-xs text-orange-600">
                        <ClipboardList className="w-3.5 h-3.5" />
                        {p.open_punch_items} open
                      </span>
                    )}
                    {p.assigned_count > 0 && (
                      <span className="flex items-center gap-1 text-xs text-gray-500">
                        <Users className="w-3.5 h-3.5" />
                        {p.assigned_count} assigned
                      </span>
                    )}
                    {p.budget && (
                      <span className="text-xs text-gray-500">${Number(p.budget).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    )}
                  </div>
                  <div className="mt-3 grid w-full min-w-0 grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center">
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation();
                        navigate(isMobileCaptureContext() ? `/mobile/photos?projectId=${p.id}&camera=1` : `/photos?projectId=${p.id}`);
                      }}
                      className="relative z-20 inline-flex min-h-10 w-full max-w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-center text-xs font-black leading-tight text-white shadow-sm transition-colors cursor-pointer hover:bg-amber-600 sm:w-auto"
                      style={{ background: '#D99D26', border: '1px solid #B7791F' }}
                      title="Take timestamped progress pictures for this project"
                      aria-label={`Take progress pictures for ${p.address}`}
                    >
                      <Camera className="h-3.5 w-3.5 flex-shrink-0" />
                      <span className="min-w-0 whitespace-normal sm:hidden">Take Pictures</span>
                      <span className="hidden min-w-0 whitespace-normal sm:inline">Upload Progress Pictures</span>
                    </button>
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation();
                        navigate(`/projects/${p.id}#progress-history`);
                      }}
                      className="relative z-20 inline-flex min-h-10 w-full max-w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-center text-xs font-black leading-tight text-white shadow-sm transition-colors cursor-pointer hover:bg-slate-800 sm:w-auto"
                      style={{ background: '#0F172A', border: '1px solid #020617' }}
                      title="View progress pictures, notes, timestamps, and historical project activity"
                      aria-label={`View progress pictures and notes for ${p.address}`}
                    >
                      <Activity className="h-3.5 w-3.5 flex-shrink-0" />
                      <span className="min-w-0 whitespace-normal">View Progress, Pictures, and Notes</span>
                    </button>
                  </div>
                </div>
                <ChevronRight className="hidden w-4 h-4 text-gray-400 flex-shrink-0 sm:block" />
              </div>
            );
          })}
        </div>
      )}

      <Modal isOpen={!!lockboxProject} onClose={() => setLockboxProject(null)} title="Lockbox Code">
        <div className="space-y-4">
          <div className="rounded-xl bg-purple-50 border border-purple-100 p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-purple-700 mb-1">Project</p>
            <p className="font-black text-gray-900">{lockboxProject?.address}</p>
          </div>
          <div className="rounded-2xl bg-gray-900 text-white text-center p-6">
            <KeyRound className="w-7 h-7 mx-auto mb-3 text-purple-300" />
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-gray-400">Current code</p>
            <p className="mt-2 text-4xl font-black tracking-[0.25em]">
              {lockboxProject?.lockbox_code || 'Not Set'}
            </p>
          </div>
          <p className="text-xs text-gray-500">Update this code from the project edit screen.</p>
        </div>
      </Modal>

      <Modal isOpen={!!documentUploadProject} onClose={closeDocumentUpload} title="Upload Documents">
        <div className="space-y-4">
          <div className="rounded-xl bg-gray-50 border border-gray-200 p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-1">Project</p>
            <p className="font-black text-gray-900">{documentUploadProject?.address}</p>
            <p className="text-sm text-gray-500">{documentUploadProject?.job_name}</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Document category</label>
            <select
              value={documentType}
              onChange={event => setDocumentType(event.target.value)}
              className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              {DOCUMENT_CATEGORIES.map(category => (
                <option key={category.value} value={category.value}>{category.label}</option>
              ))}
            </select>
          </div>

          <label className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-gray-300 bg-gray-50 px-4 py-5 text-center transition-colors hover:border-blue-400 hover:bg-blue-50">
            <Upload className="h-6 w-6 text-blue-600" />
            <span className="text-sm font-black text-gray-900">
              {documentFiles.length > 0
                ? `${documentFiles.length} file${documentFiles.length === 1 ? '' : 's'} selected`
                : 'Choose document files'}
            </span>
            <span className="text-xs text-gray-500">Invoices, quotes, insurance documents, and other files</span>
            <input
              type="file"
              multiple
              className="hidden"
              onChange={event => setDocumentFiles(Array.from(event.target.files || []))}
            />
          </label>

          {documentFiles.length > 0 && (
            <div className="max-h-32 overflow-y-auto rounded-xl border border-gray-200 bg-white">
              {documentFiles.map(file => (
                <div key={`${file.name}-${file.size}`} className="flex items-center gap-2 border-b border-gray-100 px-3 py-2 last:border-b-0">
                  <FileText className="h-4 w-4 flex-shrink-0 text-gray-400" />
                  <span className="truncate text-sm font-semibold text-gray-700">{file.name}</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={closeDocumentUpload} className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
            <button
              type="button"
              onClick={uploadProjectDocuments}
              disabled={uploadingDocuments || documentFiles.length === 0}
              className="flex-1 py-2.5 bg-gray-900 text-white rounded-xl text-sm font-semibold hover:bg-gray-800 transition-colors disabled:opacity-50"
            >
              {uploadingDocuments ? 'Uploading...' : 'Upload Documents'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Create Project Modal */}
      <Modal isOpen={showCreate} onClose={() => { setShowCreate(false); reset(); setAddressValue(''); setBudgetValue(''); setPurchasePriceValue(''); }} title="Create New Project" size="lg">
        <form onSubmit={handleSubmit(onCreateProject)} className="space-y-4">
          <input type="hidden" {...register('address', { required: 'Property address is required' })} />

          <fieldset className="rounded-2xl border border-gray-200 bg-gray-50/70 p-4">
            <legend className="px-2 text-xs font-black uppercase tracking-wide text-gray-500">Project Info</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="block text-sm font-semibold text-gray-800 mb-1">
                  Property Address <span className="text-red-600">*</span>
                </label>
                <GooglePlacesInput
                  value={addressValue}
                  onChange={(val) => { setAddressValue(val); setValue('address', val, { shouldValidate: true }); }}
                  placeholder="123 Main St, City, State"
                  className={`w-full px-3.5 py-2.5 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${errors.address ? 'border-red-400' : 'border-gray-300'}`}
                />
                {errors.address && <p className="mt-1 text-xs font-semibold text-red-600" role="alert">{errors.address.message}</p>}
              </div>
              <div className="sm:col-span-2">
                <label className="block text-sm font-semibold text-gray-800 mb-1">
                  Job Name <span className="text-red-600">*</span>
                </label>
                <input
                  {...register('job_name', { required: 'Job name is required' })}
                  aria-invalid={Boolean(errors.job_name)}
                  className={`w-full px-3.5 py-2.5 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${errors.job_name ? 'border-red-400' : 'border-gray-300'}`}
                  placeholder="Full Kitchen Renovation"
                />
                {errors.job_name && <p className="mt-1 text-xs font-semibold text-red-600" role="alert">{errors.job_name.message}</p>}
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-800 mb-1">Status</label>
                <select {...register('status')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                  {PROJECT_STATUS_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-800 mb-1">Lockbox Code</label>
                <input {...register('lockbox_code')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Enter code" />
              </div>
            </div>
          </fieldset>

          <fieldset className="rounded-2xl border border-gray-200 bg-white p-4">
            <legend className="px-2 text-xs font-black uppercase tracking-wide text-gray-500">Financials</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-semibold text-gray-800 mb-1">Acquisition Price</label>
                <CurrencyInput value={purchasePriceValue} onChange={setPurchasePriceValue} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-800 mb-1">Budget</label>
                <CurrencyInput value={budgetValue} onChange={setBudgetValue} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
          </fieldset>

          <fieldset className="rounded-2xl border border-gray-200 bg-white p-4">
            <legend className="px-2 text-xs font-black uppercase tracking-wide text-gray-500">Timeline</legend>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="block text-sm font-semibold text-gray-800 mb-1">Acquisition Date</label>
                <input type="date" {...register('acquisition_date')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-800 mb-1">Start Date</label>
                <input type="date" {...register('start_date')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-800 mb-1">Target Completion</label>
                <input type="date" {...register('target_completion')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
          </fieldset>

          <fieldset className="rounded-2xl border border-gray-200 bg-white p-4">
            <legend className="px-2 text-xs font-black uppercase tracking-wide text-gray-500">Scope and Notes</legend>
            <div className="grid gap-4">
              <div>
                <label className="block text-sm font-semibold text-gray-800 mb-1">Scope of Work</label>
                <textarea {...register('scope_of_work')} rows={3} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" placeholder="Describe the scope of work..." />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-800 mb-1">Office Notes</label>
                <textarea {...register('office_notes')} rows={2} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" placeholder="Internal notes..." />
              </div>
            </div>
          </fieldset>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={() => { setShowCreate(false); reset(); setAddressValue(''); setBudgetValue(''); setPurchasePriceValue(''); }} className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50">
              {isSubmitting ? 'Creating...' : 'Create Project'}
            </button>
          </div>
        </form>
      </Modal>
      </div>
    </div>
  );
}
