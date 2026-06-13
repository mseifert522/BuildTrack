import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  Camera,
  ChevronRight,
  FileText,
  FolderOpen,
  KeyRound,
  LogOut,
  MapPin,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { useAuthStore, roleLabels } from '../store/authStore';
import api from '../lib/api';
import { MOBILE_DATA_CHANGED_EVENT, lastMobileDataChangedAt } from '../lib/mobileEvents';

interface Project {
  id: string;
  address: string;
  job_name?: string;
  status: string;
  scope_of_work?: string | null;
  punchlist_stage?: number | boolean | string | null;
  open_punch_items?: number;
  active_scope_count?: number;
  field_work_task_count?: number;
  lockbox_code?: string | null;
}

type Tab = 'projects' | 'photos' | 'invoices';

type MobileNavItem = {
  key: Tab;
  label: string;
  shortLabel: string;
  Icon: typeof FolderOpen;
  tone: 'blue' | 'amber' | 'teal' | 'violet';
};

const STATUS_META: Record<string, { label: string; tone: string }> = {
  not_started: { label: 'Not started', tone: 'neutral' },
  active_rehab: { label: 'Active rehab', tone: 'success' },
  rehab_completed: { label: 'Completed', tone: 'success' },
  long_term_holding: { label: 'Holding', tone: 'warning' },
  commercial: { label: 'Commercial', tone: 'info' },
  archived: { label: 'Archived', tone: 'neutral' },
};

function projectLabel(project: Project) {
  return project.job_name || project.address.split(',')[0] || 'Project';
}

function statusMeta(status?: string) {
  return STATUS_META[status || ''] || {
    label: String(status || 'Active').replace(/_/g, ' '),
    tone: 'neutral',
  };
}

function getLockboxCode(project: Project) {
  return String(project.lockbox_code || '').trim();
}

function clearMobilePhotoProjectState() {
  Object.keys(localStorage).forEach(key => {
    if (key.startsWith('buildtrack-mobile-photo-project:')) localStorage.removeItem(key);
  });
}

export default function MobileHome() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const contractorUser = user?.role === 'contractor';
  const storageKey = `buildtrack-mobile-photo-project:${user?.id || 'session'}`;
  const lastDataChangeRef = useRef(lastMobileDataChangedAt());

  const [tab, setTab] = useState<Tab>(() => {
    const requested = new URLSearchParams(window.location.search).get('tab') as Tab | null;
    return requested && ['projects', 'photos', 'invoices'].includes(requested) ? requested : 'projects';
  });
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const navItems = useMemo<MobileNavItem[]>(() => {
    return [
      { key: 'projects', label: 'Projects', shortLabel: 'Projects', Icon: FolderOpen, tone: 'blue' },
      { key: 'photos', label: 'Photos', shortLabel: 'Photos', Icon: Camera, tone: 'amber' },
      { key: 'invoices', label: 'Invoices', shortLabel: 'Invoices', Icon: FileText, tone: 'violet' },
    ];
  }, []);

  const loadData = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);

    try {
      const projectRes = await api.get('/projects');
      setProjects(Array.isArray(projectRes.data) ? projectRes.data : []);
    } catch {
      toast.error('Failed to load mobile data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const refreshSilently = () => void loadData(true);
    const refreshWhenVisible = () => {
      if (!document.hidden) refreshSilently();
    };
    const refreshAfterMobileAction = () => {
      const changedAt = lastMobileDataChangedAt();
      if (changedAt && changedAt !== lastDataChangeRef.current) {
        lastDataChangeRef.current = changedAt;
        refreshSilently();
      }
    };

    window.addEventListener('buildtrack:pull-refresh', refreshSilently);
    window.addEventListener(MOBILE_DATA_CHANGED_EVENT, refreshAfterMobileAction);
    window.addEventListener('focus', refreshWhenVisible);
    window.addEventListener('pageshow', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);

    return () => {
      window.removeEventListener('buildtrack:pull-refresh', refreshSilently);
      window.removeEventListener(MOBILE_DATA_CHANGED_EVENT, refreshAfterMobileAction);
      window.removeEventListener('focus', refreshWhenVisible);
      window.removeEventListener('pageshow', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [loadData]);

  useEffect(() => {
    const timer = window.setInterval(() => loadData(true), 30000);
    return () => window.clearInterval(timer);
  }, [loadData]);

  useEffect(() => {
    if (!navItems.some(item => item.key === tab)) setTab('projects');
  }, [navItems, tab]);

  useEffect(() => {
    const requested = new URLSearchParams(location.search).get('tab') as Tab | null;
    if (requested && navItems.some(item => item.key === requested)) setTab(requested);
  }, [location.search, navItems]);

  const filteredProjects = projects;

  const rememberedProject = projects.find(project => project.id === localStorage.getItem(storageKey));
  const activeProjects = projects.filter(project => project.status === 'active_rehab').length;
  const openPunchCount = projects.reduce((count, project) => count + (project.open_punch_items || 0), 0);

  const handleLogout = () => {
    logout();
    localStorage.removeItem('contractor_token');
    localStorage.removeItem('contractor_user');
    localStorage.removeItem('contractor_projects');
    localStorage.removeItem('contractor_session_started_at');
    localStorage.removeItem('contractor_last_activity_at');
    localStorage.removeItem('contractor_last_refresh_at');
    clearMobilePhotoProjectState();
    navigate('/login');
  };

  const currentNav = navItems.find(item => item.key === tab) || navItems[0];

  if (loading) {
    return (
      <div className="mobile-shell btm-home-shell btm-loading-screen">
        <div className="btm-loading-mark">
          <MapPin size={28} />
        </div>
        <RefreshCw className="btm-spin" size={34} />
        <p>Loading BuildTrack field app</p>
      </div>
    );
  }

  return (
    <div className="mobile-shell btm-home-shell">
      <header className="btm-home-header">
        <div className="btm-home-topbar">
          <div className="btm-brand">
            <div className="btm-brand-mark" aria-hidden="true">
              <img src="/buildtrack-logo-mark.png" alt="" className="btm-brand-logo" />
            </div>
            <div className="btm-brand-text">
              <p>BuildTrack</p>
              <span>{user?.name?.split(' ')[0] || 'User'} / {roleLabels[user?.role || ''] || 'Mobile'}</span>
            </div>
          </div>
          <div className="btm-header-actions">
            <button type="button" onClick={handleLogout} aria-label="Sign out" className="btm-icon-button">
              <LogOut size={21} />
            </button>
          </div>
        </div>

        {contractorUser ? (
          <div className="btm-context-strip btm-context-strip-assigned">
            <div>
              <span>Your Assigned Projects</span>
              <strong>{filteredProjects.length}</strong>
            </div>
          </div>
        ) : (
          <div className="btm-context-strip">
            <div>
              <span>{currentNav.label}</span>
              <strong>{tab === 'projects' ? `${filteredProjects.length} jobs` : 'Field workspace'}</strong>
            </div>
            <div>
              <span>Active</span>
              <strong>{activeProjects}</strong>
            </div>
            <div>
              <span>Punch</span>
              <strong>{openPunchCount}</strong>
            </div>
          </div>
        )}
      </header>

      <main className="mobile-content btm-home-content">
        {tab === 'projects' && (
          <section className="btm-list-section" aria-label="Projects">
            <SectionHeader
              label={`${filteredProjects.length} Project${filteredProjects.length === 1 ? '' : 's'}`}
            />

            {filteredProjects.length === 0 ? (
              <EmptyState icon={<FolderOpen size={38} />} title="No projects found" />
            ) : filteredProjects.map(project => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </section>
        )}

        {tab === 'photos' && (
          <section className="btm-list-section" aria-label="Progress photos">
            <button
              type="button"
              onClick={() => navigate(rememberedProject ? `/mobile/photos?projectId=${rememberedProject.id}&camera=1` : '/mobile/photos')}
              className="btm-feature-card btm-feature-card-photo"
            >
              <Camera size={28} />
              <span>
                <strong>Start Photo Capture</strong>
                <small>{rememberedProject ? `Continue with ${rememberedProject.address}` : 'Choose a job and upload field photos'}</small>
              </span>
              <ChevronRight size={22} />
            </button>

            <SectionHeader label="Select Project" />
            {filteredProjects.map(project => (
              <SimpleProjectButton
                key={project.id}
                project={project}
                icon={<Camera size={22} />}
                helper="Open camera and upload timestamped batches"
                onClick={() => navigate(`/mobile/photos?projectId=${project.id}&camera=1`)}
              />
            ))}
          </section>
        )}

        {tab === 'invoices' && (
          <section className="btm-list-section" aria-label="Invoices">
            <SectionHeader label="Select Project to Invoice" />
            {filteredProjects.map(project => (
              <SimpleProjectButton
                key={project.id}
                project={project}
                icon={<FileText size={22} />}
                helper="Create or submit an invoice"
                onClick={() => navigate(`/mobile/project/${project.id}/invoice`)}
              />
            ))}
          </section>
        )}

      </main>

      <nav className="btm-bottom-nav" aria-label="Mobile sections">
        {navItems.map(item => {
          const active = tab === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={`btm-nav-item btm-tone-${item.tone}${active ? ' is-active' : ''}`}
              aria-current={active ? 'page' : undefined}
            >
              <item.Icon size={22} />
              <span>{item.shortLabel}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );

  function ProjectCard({ project }: { project: Project }) {
    const meta = statusMeta(project.status);
    const openPunch = project.open_punch_items || 0;
    const lockboxCode = getLockboxCode(project);

    return (
      <article className="btm-project-card">
        <button
          type="button"
          onClick={() => navigate(`/mobile/project/${project.id}`)}
          className="btm-project-main"
        >
          <span className="btm-project-pin" aria-hidden="true">
            <MapPin size={24} />
          </span>
          <span className="btm-project-copy">
            <strong>{project.address}</strong>
            <small>{projectLabel(project)}</small>
            <span className="btm-project-badges">
              <span className={`btm-status-pill btm-status-${meta.tone}`}>{meta.label}</span>
              {openPunch > 0 && <span className="btm-status-pill btm-status-danger">{openPunch} punch</span>}
              {lockboxCode && (
                <span
                  className="btm-status-pill"
                  style={{
                    gap: 5,
                    background: 'linear-gradient(135deg, #0F172A 0%, #1E3A8A 52%, #312E81 100%)',
                    border: '1px solid #60A5FA',
                    color: '#F8FAFC',
                    boxShadow: '0 8px 18px rgba(15, 23, 42, 0.22)',
                  }}
                  title={`Lock Box ${lockboxCode}`}
                >
                  <KeyRound size={13} aria-hidden="true" />
                  <span>Lock Box</span>
                  <span
                    style={{
                      display: 'inline-flex',
                      borderRadius: 999,
                      padding: '3px 6px',
                      background: '#F8FAFC',
                      color: '#0F172A',
                      width: 'auto',
                      fontSize: 12,
                      fontWeight: 950,
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                      lineHeight: 1,
                    }}
                  >
                    {lockboxCode}
                  </span>
                </span>
              )}
            </span>
          </span>
          <ChevronRight className="btm-project-chevron" size={22} />
        </button>

        <div className="btm-project-actions btm-project-actions-compact">
          <button
            type="button"
            onClick={() => navigate(`/mobile/photos?projectId=${project.id}&camera=1`)}
            className="btm-action-button btm-action-photo"
            aria-label={`Take photos for ${project.address}`}
          >
            <Camera size={22} />
            <span>Take Photos</span>
          </button>
          <button
            type="button"
            onClick={() => navigate(`/mobile/project/${project.id}`)}
            className="btm-action-button btm-action-open"
            aria-label={`Open field workspace for ${project.address}`}
          >
            <FolderOpen size={22} />
            <span>Open</span>
          </button>
        </div>
      </article>
    );
  }

  function SimpleProjectButton({
    project,
    icon,
    helper,
    onClick,
  }: {
    project: Project;
    icon: ReactNode;
    helper: string;
    onClick: () => void;
  }) {
    return (
      <button type="button" onClick={onClick} className="btm-simple-row">
        <span className="btm-simple-icon">{icon}</span>
        <span>
          <strong>{project.address}</strong>
          <small>{helper}</small>
        </span>
        <ChevronRight size={20} />
      </button>
    );
  }
}

function SectionHeader({
  label,
  actionLabel,
  onAction,
}: {
  label: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="btm-section-header">
      <p>{label}</p>
      {actionLabel && onAction && (
        <button type="button" onClick={onAction}>
          <Plus size={16} />
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function EmptyState({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="btm-empty-state">
      {icon}
      <p>{title}</p>
    </div>
  );
}
