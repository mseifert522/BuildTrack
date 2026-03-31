import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore, canManageProjects, canCreateProjects } from '../store/authStore';
import api from '../lib/api';
import { Loading, StatusBadge, Modal, PageHeader } from '../components/ui';
import { Plus, Search, MapPin, Users, ClipboardList, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { useForm } from 'react-hook-form';
import GooglePlacesInput from '../components/GooglePlacesInput';

interface Project {
  id: string;
  address: string;
  job_name: string;
  status: string;
  project_stage: string;
  start_date: string;
  target_completion: string;
  open_punch_items: number;
  assigned_count: number;
  budget: number;
  updated_at: string;
}

interface ProjectForm {
  address: string;
  job_name: string;
  status: string;
  start_date: string;
  target_completion: string;
  scope_of_work: string;
  budget: string;
  project_stage: string;
  office_notes: string;
}

export default function Projects() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [addressValue, setAddressValue] = useState('');
  const { register, handleSubmit, reset, setValue, formState: { isSubmitting } } = useForm<ProjectForm>();

  const load = async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (search) params.set('search', search);
      const res = await api.get(`/projects?${params}`);
      setProjects(res.data);
    } catch (err) {
      toast.error('Failed to load projects');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [statusFilter]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    load();
  };

  const onCreateProject = async (data: ProjectForm) => {
    try {
      const res = await api.post('/projects', { ...data, address: addressValue || data.address, budget: data.budget ? parseFloat(data.budget) : null });
      toast.success('Project created!');
      setShowCreate(false);
      reset();
      navigate(`/projects/${res.data.id}`);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to create project');
    }
  };

  const canCreate = user && canCreateProjects(user.role);

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
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
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <form onSubmit={handleSearch} className="flex-1 flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by address or job name..."
              className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <button type="submit" className="px-4 py-2.5 bg-gray-900 text-white rounded-xl text-sm font-medium hover:bg-gray-800 transition-colors">Search</button>
        </form>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="px-3 py-2.5 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
        >
          <option value="">All Statuses</option>
          <option value="active">Active</option>
          <option value="in_progress">In Progress</option>
          <option value="on_hold">On Hold</option>
          <option value="completed">Completed</option>
        </select>
      </div>

      {loading ? <Loading /> : (
        <div className="grid gap-3">
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
          ) : projects.map(p => (
            <Link
              key={p.id}
              to={`/projects/${p.id}`}
              className="bg-white rounded-xl border border-gray-200 p-4 hover:shadow-md transition-all hover:border-blue-200 flex items-center gap-4"
            >
              <div className="w-11 h-11 bg-blue-50 rounded-xl flex items-center justify-center flex-shrink-0">
                <MapPin className="w-5 h-5 text-blue-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 truncate">{p.address}</p>
                    <p className="text-sm text-gray-500 truncate">{p.job_name}</p>
                  </div>
                  <StatusBadge status={p.status} className="flex-shrink-0" />
                </div>
                <div className="flex items-center gap-4 mt-2">
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
                  {p.project_stage && (
                    <span className="text-xs text-gray-400">{p.project_stage}</span>
                  )}
                  {p.budget && (
                    <span className="text-xs text-gray-500">${p.budget.toLocaleString()}</span>
                  )}
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
            </Link>
          ))}
        </div>
      )}

      {/* Create Project Modal */}
      <Modal isOpen={showCreate} onClose={() => { setShowCreate(false); reset(); }} title="Create New Project" size="lg">
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
                <option value="active">Active</option>
                <option value="in_progress">In Progress</option>
                <option value="on_hold">On Hold</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Project Stage</label>
              <input {...register('project_stage')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="e.g. Framing, Electrical" />
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
              <input type="number" {...register('budget')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="0.00" />
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
            <button type="button" onClick={() => { setShowCreate(false); reset(); }} className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50">
              {isSubmitting ? 'Creating...' : 'Create Project'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
