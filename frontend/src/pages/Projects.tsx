import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore, canChangeProjectStatus, canCreateProjects, isAdminRole } from '../store/authStore';
import api from '../lib/api';
import { Loading, StatusBadge, Modal, PageHeader } from '../components/ui';
import { Activity, Camera, CheckCircle2, FileText, Plus, Search, MapPin, Users, ClipboardList, ChevronRight, Bell, KeyRound, MessageSquare, Upload } from 'lucide-react';
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
  const { register, handleSubmit, reset, setValue, formState: { isSubmitting } } = useForm<ProjectForm>();

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
        subtitle={`${projects.length} project${projects.length !== 1 ? 's' : ''}`}
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
        >
          {PROJECT_FILTER_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>

      {loading ? <Loading /> : (
        <div className="grid min-w-0 gap-4">
          {projects.length === 0 ? (
            <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
              <MapPin className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500 font-medium">No projects found</p>
              {canCreate && (
                <button onClick={() => setShowCreate(true)} className="mt-3 text-blue-600 text-sm font-medium hover:underline">
                  Create your first project
                </button>
              )}
            </div>
          ) : projects.map(p => {
            const review = reviewSummaries[p.id];
            return (
              <div
                key={p.id}
                onClick={() => navigate(`/projects/${p.id}`)}
                className="bt-horizontal-lock group relative flex w-full min-w-0 cursor-pointer flex-col items-stretch gap-3 overflow-hidden rounded-[1.35rem] border border-slate-300 bg-gradient-to-br from-white via-white to-blue-50/45 p-4 transition-all hover:border-blue-400 hover:bg-blue-50/35 hover:shadow-xl sm:flex-row sm:items-center sm:gap-4"
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
                    {[
                      { label: 'Scope of Work', icon: FileText, hash: 'construction-plan', color: '#1D4ED8', bg: '#EFF6FF' },
                      { label: 'Upload Quotes', icon: Upload, hash: 'quotes', color: '#0F766E', bg: '#CCFBF1' },
                      { label: p.open_punch_items > 0 ? 'Punch List' : 'Punch List: Not Started', icon: ClipboardList, hash: 'punch-list', color: '#C2410C', bg: '#FFF7ED' },
                      { label: 'Assigned Contractors', icon: Users, hash: 'assigned-contractors', color: '#047857', bg: '#ECFDF5' },
                    ].map(action => (
                      <button
                        key={action.label}
                        type="button"
                        onClick={e => {
                          e.stopPropagation();
                          navigate(`/projects/${p.id}#${action.hash}`);
                        }}
                        className="relative z-20 inline-flex w-full max-w-full items-center justify-center gap-1.5 rounded-xl px-2.5 py-1.5 text-center text-xs font-black leading-tight transition-colors cursor-pointer hover:brightness-95 sm:w-auto"
                        style={{ background: action.bg, color: action.color, border: `1px solid ${action.color}22` }}
                      >
                        <action.icon className="h-3.5 w-3.5 flex-shrink-0" />
                        <span className="min-w-0 whitespace-normal">{action.label}</span>
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation();
                        setLockboxProject(p);
                      }}
                      className="relative z-20 inline-flex w-full max-w-full items-center justify-center gap-1.5 rounded-xl px-2.5 py-1.5 text-center text-xs font-black leading-tight transition-colors cursor-pointer hover:brightness-95 sm:w-auto"
                      style={{ background: '#F5F3FF', color: '#6D28D9', border: '1px solid #6D28D922' }}
                    >
                      <KeyRound className="h-3.5 w-3.5 flex-shrink-0" />
                      <span className="min-w-0 whitespace-normal">Lockbox Code</span>
                    </button>
                    {canManageProjectActions && (
                      <button
                        type="button"
                        onClick={e => {
                          e.stopPropagation();
                          setDocumentUploadProject(p);
                        }}
                        className="relative z-20 inline-flex w-full max-w-full items-center justify-center gap-1.5 rounded-xl px-2.5 py-1.5 text-center text-xs font-black leading-tight transition-colors cursor-pointer hover:brightness-95 sm:w-auto"
                        style={{ background: '#ECFDF5', color: '#047857', border: '1px solid #04785722' }}
                      >
                        <Upload className="h-3.5 w-3.5 flex-shrink-0" />
                        <span className="min-w-0 whitespace-normal">Upload Documents</span>
                      </button>
                    )}
                  </div>
                  <div className="mt-3 grid w-full min-w-0 grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center">
                    {canManageProjectActions && (
                      <>
                        <label
                          className={`inline-flex w-full max-w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-center text-xs font-black leading-tight cursor-pointer transition-colors sm:w-auto ${p.main_photo_url ? 'relative z-0' : 'relative z-20'}`}
                          style={{ background: '#F9FAFB', color: '#374151', border: '1px solid #E5E7EB' }}
                          title="Upload one main house photo"
                          onClick={e => {
                            if (!p.main_photo_url) e.stopPropagation();
                          }}
                          onMouseDown={e => {
                            if (!p.main_photo_url) e.stopPropagation();
                          }}
                        >
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            disabled={uploadingPhoto === p.id || !!p.main_photo_url}
                            onChange={e => {
                              const file = e.target.files?.[0];
                              uploadProjectPhoto(p, file);
                              e.currentTarget.value = '';
                            }}
                          />
                          <Camera className="h-3.5 w-3.5 flex-shrink-0" />
                          <span className="min-w-0 whitespace-normal">{p.main_photo_url ? 'House Photo Added' : uploadingPhoto === p.id ? 'Uploading...' : 'Add House Photo'}</span>
                        </label>
                        {canChangeStatus && (
                          <>
                            <div
                              className="relative z-20 inline-flex min-h-10 w-full max-w-full items-center justify-between gap-2 rounded-xl border border-slate-300 bg-white px-2 py-1 shadow-sm sm:w-auto"
                              onClick={e => e.stopPropagation()}
                              onMouseDown={e => e.stopPropagation()}
                              title="Change project status"
                            >
                              <span className="text-[11px] font-black uppercase tracking-wide text-slate-500">Status</span>
                              <select
                                value={p.status}
                                disabled={updatingStatus === p.id}
                                onChange={e => updateProjectStatus(p, e.target.value)}
                                className="min-h-8 min-w-0 flex-1 rounded-lg border-0 bg-transparent px-1 text-xs font-black text-slate-800 outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-60 cursor-pointer sm:flex-none"
                                aria-label={`Change status for ${p.address}`}
                              >
                                {PROJECT_STATUS_OPTIONS.map(option => (
                                  <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                              </select>
                            </div>
                            <button
                              type="button"
                              disabled={updatingStatus === p.id || p.status === 'rehab_completed'}
                              onClick={e => {
                                e.stopPropagation();
                                updateProjectStatus(p, 'rehab_completed');
                              }}
                              className="relative z-20 inline-flex min-h-10 w-full max-w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-center text-xs font-black leading-tight transition-colors disabled:opacity-50 cursor-pointer sm:w-auto"
                              style={{
                                background: p.status === 'rehab_completed' ? '#DCFCE7' : '#ECFDF5',
                                color: '#047857',
                                border: '1px solid #A7F3D0',
                              }}
                              title="Mark project completed"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
                              <span className="min-w-0 whitespace-normal">{p.status === 'rehab_completed' ? 'Completed' : 'Mark Completed'}</span>
                            </button>
                          </>
                        )}
                      </>
                    )}
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation();
                        navigate(`/projects/${p.id}#notes`);
                      }}
                      className="relative z-20 inline-flex w-full max-w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-center text-xs font-black leading-tight transition-colors cursor-pointer hover:brightness-95 sm:w-auto"
                      style={{ background: '#EFF6FF', color: '#1D4ED8', border: '1px solid #BFDBFE' }}
                      title="Enter a project note"
                      aria-label={`Enter notes for ${p.address}`}
                    >
                      <MessageSquare className="h-3.5 w-3.5 flex-shrink-0" />
                      <span className="min-w-0 whitespace-normal">Enter Notes</span>
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
      <Modal isOpen={showCreate} onClose={() => { setShowCreate(false); reset(); setBudgetValue(''); setPurchasePriceValue(''); }} title="Create New Project" size="lg">
        <form onSubmit={handleSubmit(onCreateProject)} className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Property Address *</label>
              <GooglePlacesInput
                value={addressValue}
                onChange={(val) => { setAddressValue(val); setValue('address', val); }}
                placeholder="123 Main St, City, State"
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Job Name *</label>
              <input {...register('job_name', { required: true })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Full Kitchen Renovation" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select {...register('status')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                {PROJECT_STATUS_OPTIONS.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Lockbox Code</label>
              <input {...register('lockbox_code')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Enter code" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Acquisition Price</label>
              <CurrencyInput value={purchasePriceValue} onChange={setPurchasePriceValue} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Acquisition Date</label>
              <input type="date" {...register('acquisition_date')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
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
              <label className="block text-sm font-medium text-gray-700 mb-1">Budget</label>
              <CurrencyInput value={budgetValue} onChange={setBudgetValue} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Scope of Work</label>
              <textarea {...register('scope_of_work')} rows={3} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" placeholder="Describe the scope of work..." />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Office Notes</label>
              <textarea {...register('office_notes')} rows={2} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" placeholder="Internal notes..." />
            </div>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={() => { setShowCreate(false); reset(); setBudgetValue(''); setPurchasePriceValue(''); }} className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
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
