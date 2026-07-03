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
  const projectListLabel = user?.role === 'contractor' ? 'Assigned Projects' : 'Projects';

  const rememberedProject = projects.find(project => project.id === localStorage.getItem(storageKey));

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
      </header>

      <main className="mobile-content btm-home-content">
        {tab === 'projects' && (
          <section className="btm-list-section" aria-label="Projects">
            <SectionHeader label={projectListLabel} />

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
          <span className="btm-project-copy">
            <span className="btm-project-topline">
              <span
                className={`btm-lockbox-chip${lockboxCode ? '' : ' btm-lockbox-empty'}`}
                title={lockboxCode ? `Lockbox ${lockboxCode}` : 'Lockbox not set'}
              >
                <KeyRound size={14} aria-hidden="true" />
                <span>Lockbox</span>
                <strong>{lockboxCode || 'Not set'}</strong>
              </span>
              <span className={`btm-status-pill btm-status-${meta.tone}`}>{meta.label}</span>
            </span>
            <span className="btm-project-address">{project.address}</span>
            {openPunch > 0 && (
              <span className="btm-project-alert">{openPunch} open punch item{openPunch === 1 ? '' : 's'}</span>
            )}
          </span>
          <ChevronRight className="btm-project-chevron" size={22} />
        </button>
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
