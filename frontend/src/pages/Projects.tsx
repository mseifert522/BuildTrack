import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore, canChangeProjectStatus, canCreateProjects, isAdminRole } from '../store/authStore';
import api from '../lib/api';
import { Loading, Modal, PageHeader } from '../components/ui';
import { Camera, CheckCircle2, FileText, Plus, Search, MapPin, Users, ClipboardList, ChevronRight, Bell, KeyRound, MessageSquare, Upload, MoreHorizontal } from 'lucide-react';
import toast from 'react-hot-toast';
import { useForm } from 'react-hook-form';
import GooglePlacesInput from '../components/GooglePlacesInput';
import CurrencyInput from '../components/CurrencyInput';
import AddToCalendarButton from '../components/AddToCalendarButton';
import { fileDropHandlers } from '../lib/fileDrop';

interface Project {
  id: string;
  address: string;
  job_name: string;
  status: string;
  start_date: string;
  target_completion: string;
  open_punch_items: number;
  assigned_count: number;
  budget?: number | null;
  updated_at: string;
  main_photo_url?: string | null;
  main_photo_thumb_url?: string | null;
  lockbox_code?: string | null;
  market_status?: string | null;
  work_priority?: number | string | null;
}

interface ProjectForm {
  address: string;
  job_name: string;
  status: string;
  start_date: string;
  target_completion: string;
  purchase_price: string;
  acquisition_date: string;
  lockbox_code: string;
  market_status: string;
  work_priority: string;
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
  { value: 'wholesale', label: 'Wholesale' },
];

const PROJECT_STATUS_OPTIONS = [
  { value: 'not_started', label: 'Not Started' },
  { value: 'active_rehab', label: 'Active Rehabs' },
  { value: 'rehab_completed', label: 'Completed Projects' },
  { value: 'long_term_holding', label: 'Long-Term Holdings' },
  { value: 'commercial', label: 'Commercial' },
  { value: 'wholesale', label: 'Wholesale' },
];

const PROJECT_STATUS_BADGES: Record<string, { label: string; className: string }> = {
  not_started: { label: 'Not Started', className: 'border-slate-300 bg-slate-100 text-slate-700' },
  active_rehab: { label: 'Being Worked On', className: 'border-blue-300 bg-blue-100 text-blue-800' },
  rehab_completed: { label: 'Completed', className: 'border-emerald-300 bg-emerald-100 text-emerald-800' },
  long_term_holding: { label: 'Holding', className: 'border-amber-300 bg-amber-100 text-amber-800' },
  commercial: { label: 'Commercial', className: 'border-cyan-300 bg-cyan-100 text-cyan-800' },
  wholesale: { label: 'Wholesale', className: 'border-teal-300 bg-teal-100 text-teal-800' },
};

const MARKET_STATUS_OPTIONS = [
  { value: 'not_on_market', label: 'Not On Market' },
  { value: 'on_market', label: 'On Market' },
];

const WORK_PRIORITY_OPTIONS = Array.from({ length: 20 }, (_, index) => index + 1);

const DEFAULT_PROJECT_FORM_VALUES: Partial<ProjectForm> = {
  status: 'not_started',
  market_status: 'not_on_market',
  work_priority: '',
};

const DOCUMENT_CATEGORIES = [
  { value: 'invoices', label: 'Invoices' },
  { value: 'quotes', label: 'Quotes' },
  { value: 'other_documents', label: 'Other Documents' },
  { value: 'insurance_documents', label: 'Insurance Documents' },
];

const SOLD_DISPLAY_STATUSES = new Set(['sold', 'closed_sold', 'rehab_completed']);
const PROJECT_BUDGET_ROLES = new Set(['super_admin', 'operations_manager', 'project_manager']);

function canViewProjectBudget(role?: string | null) {
  return PROJECT_BUDGET_ROLES.has(String(role || ''));
}

function getProjectStatusBadge(status?: string | null) {
  return PROJECT_STATUS_BADGES[String(status || '')] || PROJECT_STATUS_BADGES.not_started;
}

function getProjectPriority(project: Project) {
  const priority = Number(project.work_priority || 0);
  return Number.isInteger(priority) && priority >= 1 && priority <= 20 ? priority : null;
}

function getMarketStatusLabel(value?: string | null) {
  return MARKET_STATUS_OPTIONS.find(option => option.value === value)?.label || 'Not On Market';
}

function getLockboxCode(project: Pick<Project, 'lockbox_code'>) {
  return String(project.lockbox_code || '').trim();
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
  const [sortBy, setSortBy] = useState('priority');
  const [teamFilter, setTeamFilter] = useState('');
  const [updatingPlanning, setUpdatingPlanning] = useState<string | null>(null);
  const { register, handleSubmit, reset, setValue, formState: { isSubmitting, errors } } = useForm<ProjectForm>({
    defaultValues: DEFAULT_PROJECT_FORM_VALUES,
  });

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
      const priority = data.work_priority ? Number.parseInt(String(data.work_priority), 10) : null;
      const res = await api.post('/projects', {
        ...data,
        address: addressValue || data.address,
        ...(canSeeBudget ? { budget: budgetValue ? parseFloat(budgetValue) : null } : {}),
        purchase_price: purchasePriceValue ? parseFloat(purchasePriceValue) : null,
        market_status: data.market_status || 'not_on_market',
        work_priority: priority,
      });
      toast.success('Project created!');
      setShowCreate(false);
      reset(DEFAULT_PROJECT_FORM_VALUES);
      navigate(`/projects/${res.data.id}`);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to create project');
    }
  };

  const canCreate = user && canCreateProjects(user.role);
  const canManageProjectActions = user && isAdminRole(user.role);
  const canChangeStatus = user && canChangeProjectStatus(user.role);
  const canSeeBudget = Boolean(user && canViewProjectBudget(user.role));

  useEffect(() => {
    if (!canSeeBudget && sortBy === 'budget') setSortBy('priority');
  }, [canSeeBudget, sortBy]);

  const projectRows = useMemo(() => {
    const toTime = (value?: string) => value ? new Date(value).getTime() || 0 : 0;
    return [...projects]
      .filter(project => {
        if (teamFilter === 'assigned') return Number(project.assigned_count || 0) > 0;
        if (teamFilter === 'unassigned') return Number(project.assigned_count || 0) === 0;
        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'priority') {
          const priorityA = getProjectPriority(a) || 999;
          const priorityB = getProjectPriority(b) || 999;
          if (priorityA !== priorityB) return priorityA - priorityB;
          return toTime(b.updated_at) - toTime(a.updated_at);
        }
        if (sortBy === 'address') return String(a.address || '').localeCompare(String(b.address || ''));
        if (sortBy === 'budget' && canSeeBudget) return Number(b.budget || 0) - Number(a.budget || 0);
        if (sortBy === 'punch') return Number(b.open_punch_items || 0) - Number(a.open_punch_items || 0);
        if (sortBy === 'target') return toTime(a.target_completion) - toTime(b.target_completion);
        return toTime(b.updated_at) - toTime(a.updated_at);
      });
  }, [canSeeBudget, projects, sortBy, teamFilter]);

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

  const updateProjectPlanning = async (project: Project, patch: Partial<Pick<Project, 'market_status' | 'work_priority'>>) => {
    if (!canChangeStatus) return;
    setUpdatingPlanning(project.id);
    try {
      await api.put(`/projects/${project.id}`, patch);
      setProjects(current => current.map(item => item.id === project.id ? { ...item, ...patch } : item));
      toast.success(patch.market_status !== undefined ? 'Market status updated' : 'Project priority updated');
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update project priority');
    } finally {
      setUpdatingPlanning(null);
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
      setProjects(current => current.map(item => item.id === project.id ? {
        ...item,
        main_photo_url: res.data.main_photo_url,
        main_photo_thumb_url: res.data.main_photo_thumb_url || res.data.main_photo_url,
      } : item));
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
      className="bt-desktop-page bt-projects-page bt-horizontal-lock min-h-full w-full max-w-full overflow-x-hidden px-4 py-4 md:px-8 md:py-6"
      style={{ background: '#F0F2F5', touchAction: 'pan-y', overscrollBehaviorX: 'none' }}
    >
      <div className="mx-auto w-full max-w-7xl min-w-0">
      <div className="bt-projects-header">
        <PageHeader
          title="Projects"
          subtitle={`${projectRows.length} of ${projects.length} project${projects.length !== 1 ? 's' : ''}`}
          actions={canCreate ? (
            <button onClick={() => setShowCreate(true)} className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-xl font-medium text-sm hover:bg-blue-700 transition-colors shadow-sm">
              <Plus className="w-4 h-4" /> New Project
            </button>
          ) : undefined}
        />
      </div>

      {/* Filters */}
      <div className="bt-project-filterbar mb-5 flex w-full min-w-0 flex-col gap-3 rounded-2xl border border-gray-200 p-3 sm:flex-row" style={{ background: 'white', boxShadow: '0 8px 24px rgba(17,24,39,0.06)' }}>
        <form onSubmit={handleSearch} className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              aria-label="Search projects"
              className="w-full rounded-xl border border-gray-300 bg-white py-2.5 pl-9 pr-4 text-sm font-semibold text-slate-950 placeholder:text-slate-500 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
              style={{ colorScheme: 'light' }}
            />
          </div>
          <button type="submit" className="w-full rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800 sm:w-auto">Search</button>
        </form>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm font-semibold text-slate-950 focus:outline-none focus:ring-2 focus:ring-blue-500 sm:w-auto"
          style={{ colorScheme: 'light' }}
          aria-label="Filter projects by status"
        >
          {PROJECT_FILTER_OPTIONS.map(option => (
            <option key={option.value} value={option.value} className="bg-white text-slate-950">{option.label}</option>
          ))}
        </select>
        <select
          value={teamFilter}
          onChange={e => setTeamFilter(e.target.value)}
          className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm font-semibold text-slate-950 focus:outline-none focus:ring-2 focus:ring-blue-500 sm:w-auto"
          style={{ colorScheme: 'light' }}
          aria-label="Filter projects by team assignment"
        >
          <option value="" className="bg-white text-slate-950">All teams</option>
          <option value="assigned" className="bg-white text-slate-950">Assigned contractors</option>
          <option value="unassigned" className="bg-white text-slate-950">Unassigned projects</option>
        </select>
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value)}
          className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm font-semibold text-slate-950 focus:outline-none focus:ring-2 focus:ring-blue-500 sm:w-auto"
          style={{ colorScheme: 'light' }}
          aria-label="Sort projects"
        >
          <option value="priority" className="bg-white text-slate-950">Sort: Priority order</option>
          <option value="updated" className="bg-white text-slate-950">Sort: Recently updated</option>
          <option value="target" className="bg-white text-slate-950">Sort: Target completion</option>
          <option value="punch" className="bg-white text-slate-950">Sort: Open punch items</option>
          {canSeeBudget && <option value="budget" className="bg-white text-slate-950">Sort: Budget high to low</option>}
          <option value="address" className="bg-white text-slate-950">Sort: Location A-Z</option>
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
            const priority = getProjectPriority(p);
            const statusBadge = getProjectStatusBadge(p.status);
            const isOnMarket = p.market_status === 'on_market';
            const lockboxCode = getLockboxCode(p);
            const isActionsOpen = activeActionsProjectId === p.id;
            return (
              <div
                key={p.id}
                onClick={() => navigate(`/projects/${p.id}`)}
                className={`bt-project-card group relative isolate flex w-full min-w-0 cursor-pointer flex-col items-stretch gap-4 overflow-visible rounded-[1.35rem] border p-5 transition-all sm:flex-row sm:items-center sm:gap-5 ${isActionsOpen ? 'z-50' : 'z-0'}`}
                style={{
                  borderLeft: `5px solid ${priority ? (priority <= 5 ? '#F59E0B' : '#2563EB') : '#2563EB'}`,
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
                  className={`relative h-24 w-32 rounded-xl border border-blue-200 shadow-md flex items-center justify-center flex-shrink-0 overflow-hidden sm:h-20 sm:w-28 lg:h-24 lg:w-32 ${canManageProjectActions && !p.main_photo_url ? 'z-20 cursor-pointer' : 'z-0 cursor-pointer'}`}
                  style={{ background: 'linear-gradient(135deg, #EFF6FF, #DBEAFE)' }}
                  {...fileDropHandlers(files => uploadProjectPhoto(p, files[0]), {
                    accept: 'image/*',
                    disabled: !canManageProjectActions || uploadingPhoto === p.id || !!p.main_photo_url,
                    multiple: false,
                  })}
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
                    <img
                      src={p.main_photo_thumb_url || p.main_photo_url}
                      alt={p.address}
                      loading="lazy"
                      decoding="async"
                      className="w-full h-full object-cover"
                      onError={event => {
                        if (!p.main_photo_url || event.currentTarget.dataset.fallback === '1') return;
                        event.currentTarget.dataset.fallback = '1';
                        event.currentTarget.src = p.main_photo_url;
                      }}
                    />
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
                      <div className="mb-2 flex flex-wrap items-center gap-1.5">
                        {priority && (
                          <span
                            className={`inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-black uppercase tracking-wide shadow-sm ${
                              priority <= 5
                                ? 'border-amber-300 bg-amber-400 text-amber-950'
                                : 'border-blue-300 bg-blue-100 text-blue-800'
                            }`}
                            title={`Work priority ${priority} of 20`}
                          >
                            Priority {priority}
                          </span>
                        )}
                        <span className={`inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-black uppercase tracking-wide ${statusBadge.className}`}>
                          {statusBadge.label}
                        </span>
                        <span
                          className={`inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-black uppercase tracking-wide ${
                            isOnMarket
                              ? 'border-emerald-300 bg-emerald-500 text-emerald-950 shadow-sm'
                              : 'border-slate-300 bg-slate-100 text-slate-600'
                          }`}
                        >
                          {getMarketStatusLabel(p.market_status)}
                        </span>
                        {lockboxCode && (
                          <span
                            className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-black uppercase tracking-wide shadow-sm"
                            style={{
                              background: 'linear-gradient(135deg, #0F172A 0%, #1E3A8A 52%, #312E81 100%)',
                              borderColor: '#60A5FA',
                              color: '#F8FAFC',
                              boxShadow: '0 8px 18px rgba(15, 23, 42, 0.26)',
                            }}
                            title={`Lock Box ${lockboxCode}`}
                          >
                            <KeyRound className="h-3.5 w-3.5" />
                            <span>Lock Box</span>
                            <span
                              className="rounded-full px-2 py-0.5 font-mono text-xs tracking-normal"
                              style={{
                                background: '#F8FAFC',
                                color: '#0F172A',
                              }}
                            >
                              {lockboxCode}
                            </span>
                          </span>
                        )}
                      </div>
                      <p className="bt-project-title truncate text-lg font-black leading-6 text-gray-950 sm:text-xl">{p.address}</p>
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
                      {SOLD_DISPLAY_STATUSES.has(String(p.status || '')) && (
                        <span className="inline-flex flex-shrink-0 items-center rounded-full border border-emerald-300 bg-emerald-500 px-3 py-1 text-xs font-black uppercase tracking-wide text-emerald-950 shadow-sm">
                          Sold
                        </span>
                      )}
                      <div
                        className="relative z-30"
                        onClick={event => event.stopPropagation()}
                        onMouseDown={event => event.stopPropagation()}
                      >
                        <AddToCalendarButton
                          label="Add to Calendar"
                          defaultTitle={`Project reminder - ${p.address || p.job_name || 'project'}`}
                          defaultDescription={[p.job_name, p.address].filter(Boolean).join('\n')}
                          defaultDate={p.target_completion || p.start_date || null}
                          projectId={p.id}
                          sourceType="project"
                          sourceId={p.id}
                          contextLabel={[p.address, p.job_name].filter(Boolean).join(' - ')}
                          buttonClassName="inline-flex min-h-10 min-w-max items-center justify-center gap-1.5 rounded-xl border border-cyan-200 bg-cyan-50 px-3 py-2 text-xs font-black text-cyan-800 shadow-sm transition-colors hover:bg-cyan-100"
                        />
                      </div>
                      <div
                        className="relative z-30"
                        onClick={event => event.stopPropagation()}
                        onMouseDown={event => event.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => setActiveActionsProjectId(isActionsOpen ? null : p.id)}
                          className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-black text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
                          aria-haspopup="menu"
                          aria-expanded={isActionsOpen}
                          aria-label={`Open actions for ${p.address}`}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                          Actions
                        </button>
                        {isActionsOpen && (
                          <div
                            role="menu"
                            className="absolute right-0 top-full z-50 mt-2 w-72 overflow-hidden rounded-2xl border border-slate-200 bg-white p-2 text-sm shadow-2xl"
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
                                  {...fileDropHandlers(files => {
                                    uploadProjectPhoto(p, files[0]);
                                    setActiveActionsProjectId(null);
                                  }, {
                                    accept: 'image/*',
                                    disabled: uploadingPhoto === p.id || !!p.main_photo_url,
                                    multiple: false,
                                  })}
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
                                <label className="mb-1 block text-[11px] font-black uppercase tracking-wide text-slate-500">
                                  Market status
                                </label>
                                <select
                                  value={p.market_status || 'not_on_market'}
                                  disabled={updatingPlanning === p.id}
                                  onChange={event => updateProjectPlanning(p, { market_status: event.target.value })}
                                  className="mb-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-60"
                                  aria-label={`Change market status for ${p.address}`}
                                >
                                  {MARKET_STATUS_OPTIONS.map(option => (
                                    <option key={option.value} value={option.value}>{option.label}</option>
                                  ))}
                                </select>
                                <label className="mb-1 block text-[11px] font-black uppercase tracking-wide text-slate-500">
                                  Work priority
                                </label>
                                <select
                                  value={getProjectPriority(p) || ''}
                                  disabled={updatingPlanning === p.id}
                                  onChange={event => updateProjectPlanning(p, { work_priority: event.target.value ? Number(event.target.value) : null })}
                                  className="mb-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-60"
                                  aria-label={`Change work priority for ${p.address}`}
                                >
                                  <option value="">No priority</option>
                                  {WORK_PRIORITY_OPTIONS.map(priorityNumber => (
                                    <option key={priorityNumber} value={priorityNumber}>Priority {priorityNumber}</option>
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
                    <p className="bt-project-review mt-2 text-xs text-amber-700 truncate">
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

          <label
            className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-gray-300 bg-gray-50 px-4 py-5 text-center transition-colors hover:border-blue-400 hover:bg-blue-50"
            {...fileDropHandlers(files => setDocumentFiles(files), { multiple: true })}
          >
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
      <Modal isOpen={showCreate} onClose={() => { setShowCreate(false); reset(DEFAULT_PROJECT_FORM_VALUES); setAddressValue(''); setBudgetValue(''); setPurchasePriceValue(''); }} title="Create New Project" size="lg">
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
                <label className="block text-sm font-semibold text-gray-800 mb-1">Market Status</label>
                <select {...register('market_status')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                  {MARKET_STATUS_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-800 mb-1">Work Priority</label>
                <select {...register('work_priority')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                  <option value="">No priority</option>
                  {WORK_PRIORITY_OPTIONS.map(priorityNumber => (
                    <option key={priorityNumber} value={priorityNumber}>Priority {priorityNumber}</option>
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
              {canSeeBudget && (
                <div>
                  <label className="block text-sm font-semibold text-gray-800 mb-1">Budget</label>
                  <CurrencyInput value={budgetValue} onChange={setBudgetValue} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              )}
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

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={() => { setShowCreate(false); reset(DEFAULT_PROJECT_FORM_VALUES); setAddressValue(''); setBudgetValue(''); setPurchasePriceValue(''); }} className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
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
