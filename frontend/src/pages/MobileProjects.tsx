import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore, canManageProjects } from '../store/authStore';
import api from '../lib/api';
import toast from 'react-hot-toast';

interface Project {
  id: number;
  address: string;
  job_name?: string;
  status: string;
  project_stage?: string;
  open_punch_items?: number;
}

const statusColors: Record<string, string> = {
  active: '#22c55e',
  pending: '#D99D26',
  completed: '#6b7280',
  on_hold: '#ef4444',
};

const stageLabel: Record<string, string> = {
  acquisition: 'Acquisition',
  planning: 'Planning',
  demo: 'Demo',
  framing: 'Framing',
  rough_ins: 'Rough-Ins',
  drywall: 'Drywall',
  finishes: 'Finishes',
  punch_out: 'Punch-Out',
  final: 'Final',
  complete: 'Complete',
};

export default function MobileProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [filtered, setFiltered] = useState<Project[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const canManage = user ? canManageProjects(user.role) : false;

  useEffect(() => {
    api.get('/projects')
      .then(res => {
        setProjects(res.data);
        setFiltered(res.data);
      })
      .catch(() => toast.error('Failed to load projects'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const q = search.toLowerCase();
    setFiltered(
      projects.filter(p =>
        p.address.toLowerCase().includes(q) ||
        (p.job_name || '').toLowerCase().includes(q)
      )
    );
  }, [search, projects]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="mobile-shell" style={{ backgroundColor: '#F4F5F7' }}>
      {/* Header */}
      <div className="sticky top-0 z-10 shadow-md" style={{ backgroundColor: '#181D25' }}>
        <div className="flex items-center justify-between px-4 pt-4 pb-3">
          <div className="flex items-center gap-3">
            <img src="/nud-logo.jpg" alt="NUD" className="w-9 h-9 rounded-full object-cover border-2" style={{ borderColor: '#D99D26' }} />
            <div>
              <p className="text-white font-bold text-sm leading-tight">BuildTrack</p>
              <p className="text-xs" style={{ color: '#D99D26' }}>New Urban Development</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-white text-xs font-semibold">{user?.name}</p>
              <p className="text-xs capitalize" style={{ color: '#D99D26' }}>
                {user?.role?.replace(/_/g, ' ')}
              </p>
            </div>
            <button
              onClick={handleLogout}
              className="p-2 rounded-xl hover:bg-white/10 transition-colors"
              title="Sign out"
            >
              <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-4 pb-3">
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by address or job name..."
              className="w-full pl-9 pr-4 py-2.5 rounded-xl text-sm focus:outline-none focus:ring-2 bg-white/10 text-white placeholder-gray-400 border border-white/10"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Project Count + Add button row */}
      <div className="px-4 py-3 flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          {loading ? 'Loading...' : `${filtered.length} Project${filtered.length !== 1 ? 's' : ''}`}
        </p>
        {canManage && (
          <button
            onClick={() => navigate('/mobile/add-project')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              backgroundColor: '#D99D26',
              color: 'white',
              border: 'none',
              borderRadius: 12,
              padding: '8px 14px',
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(217,157,38,0.35)',
            }}
          >
            <svg width="14" height="14" fill="none" stroke="white" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
            </svg>
            New Project
          </button>
        )}
      </div>

      {/* Project List */}
      <div className="mobile-content" style={{ padding: '0 16px 80px' }}>
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-white rounded-2xl p-4 animate-pulse">
              <div className="h-4 bg-gray-200 rounded w-3/4 mb-2" />
              <div className="h-3 bg-gray-100 rounded w-1/2" />
            </div>
          ))
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <svg className="w-12 h-12 mx-auto text-gray-300 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
            <p className="text-gray-400 font-medium">No projects found</p>
            {canManage && !search && (
              <button
                onClick={() => navigate('/mobile/add-project')}
                className="mt-4 px-5 py-2.5 rounded-xl text-sm font-bold text-white"
                style={{ backgroundColor: '#D99D26' }}
              >
                + Create First Project
              </button>
            )}
          </div>
        ) : (
          filtered.map(project => (
            <button
              key={project.id}
              onClick={() => navigate(`/mobile/project/${project.id}`)}
              className="w-full text-left bg-white rounded-2xl shadow-sm p-4 active:scale-98 transition-all hover:shadow-md border border-gray-100"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  {/* Address — primary */}
                  <div className="flex items-center gap-2 mb-1">
                    <svg className="w-4 h-4 flex-shrink-0" style={{ color: '#D99D26' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    <p className="font-bold text-gray-900 text-sm truncate">{project.address}</p>
                  </div>
                  {project.job_name && (
                    <p className="text-xs text-gray-500 ml-6 mb-2">{project.job_name}</p>
                  )}
                  <div className="flex items-center gap-2 ml-6 flex-wrap">
                    {/* Status badge */}
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold text-white"
                      style={{ backgroundColor: statusColors[project.status] || '#6b7280' }}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-white/70" />
                      {project.status?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                    </span>
                    {/* Stage badge */}
                    {project.project_stage && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                        {stageLabel[project.project_stage] || project.project_stage}
                      </span>
                    )}
                    {/* Open punch items */}
                    {(project.open_punch_items ?? 0) > 0 && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-semibold text-white" style={{ backgroundColor: '#ef4444' }}>
                        {project.open_punch_items} open
                      </span>
                    )}
                  </div>
                </div>
                <svg className="w-5 h-5 text-gray-300 flex-shrink-0 mt-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </button>
          ))
        )}
      </div>

      {/* Floating Action Button for managers */}
      {canManage && (
        <button
          onClick={() => navigate('/mobile/add-project')}
          style={{
            position: 'fixed',
            bottom: 28,
            right: 20,
            width: 56,
            height: 56,
            borderRadius: '50%',
            backgroundColor: '#D99D26',
            border: 'none',
            boxShadow: '0 4px 16px rgba(217,157,38,0.5)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 20,
          }}
          title="Add New Project"
        >
          <svg width="24" height="24" fill="none" stroke="white" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      )}
    </div>
  );
}
