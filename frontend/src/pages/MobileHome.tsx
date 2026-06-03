import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  Camera,
  ChevronRight,
  ClipboardList,
  FileText,
  FolderOpen,
  LogOut,
  MapPin,
  Plus,
  RefreshCw,
  Search,
  Send,
  Truck,
  Users,
} from 'lucide-react';
import { useAuthStore, roleLabels, canCreateProjects } from '../store/authStore';
import api from '../lib/api';

interface Project {
  id: string;
  address: string;
  job_name?: string;
  status: string;
  open_punch_items?: number;
}

interface ContractorItem {
  id: string;
  name?: string;
  company?: string;
  contact_name?: string | null;
  phone?: string | null;
  email?: string | null;
  category?: string | null;
  contractor_category?: string | null;
  connected_project_count?: number;
  assigned_project_count?: number;
}

interface SupplierItem {
  id: string;
  name?: string;
  contact?: string | null;
  phone?: string | null;
  email?: string | null;
  category?: string | null;
}

type Tab = 'projects' | 'photos' | 'invoices' | 'contractors' | 'suppliers';

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

function isManagementRole(role?: string) {
  return role === 'super_admin' || role === 'operations_manager' || role === 'project_manager';
}

function projectLabel(project: Project) {
  return project.job_name || project.address.split(',')[0] || 'Project';
}

function statusMeta(status?: string) {
  return STATUS_META[status || ''] || {
    label: String(status || 'Active').replace(/_/g, ' '),
    tone: 'neutral',
  };
}

function clearMobilePhotoProjectState() {
  Object.keys(localStorage).forEach(key => {
    if (key.startsWith('buildtrack-mobile-photo-project:')) localStorage.removeItem(key);
  });
}

export default function MobileHome() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const managementUser = isManagementRole(user?.role);
  const storageKey = `buildtrack-mobile-photo-project:${user?.id || 'session'}`;

  const [tab, setTab] = useState<Tab>('projects');
  const [projects, setProjects] = useState<Project[]>([]);
  const [contractors, setContractors] = useState<ContractorItem[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierItem[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [setupEmailInputs, setSetupEmailInputs] = useState<Record<string, string>>({});
  const [sendingSetupId, setSendingSetupId] = useState<string | null>(null);

  const navItems = useMemo<MobileNavItem[]>(() => {
    if (managementUser) {
      return [
        { key: 'projects', label: 'Projects', shortLabel: 'Projects', Icon: FolderOpen, tone: 'blue' },
        { key: 'photos', label: 'Progress Photos', shortLabel: 'Photos', Icon: Camera, tone: 'amber' },
        { key: 'contractors', label: 'Contractors', shortLabel: 'Crews', Icon: Users, tone: 'teal' },
        { key: 'suppliers', label: 'Suppliers', shortLabel: 'Vendors', Icon: Truck, tone: 'violet' },
      ];
    }

    return [
      { key: 'projects', label: 'Projects', shortLabel: 'Projects', Icon: FolderOpen, tone: 'blue' },
      { key: 'photos', label: 'Progress Photos', shortLabel: 'Photos', Icon: Camera, tone: 'amber' },
      { key: 'invoices', label: 'Invoices', shortLabel: 'Invoices', Icon: FileText, tone: 'violet' },
    ];
  }, [managementUser]);

  const loadData = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);

    try {
      if (managementUser) {
        const [projectRes, contractorRes, supplierRes] = await Promise.all([
          api.get('/projects'),
          api.get('/users/contractors/directory').catch(() => ({ data: { contractors: [] } })),
          api.get('/users/suppliers').catch(() => ({ data: [] })),
        ]);
        setProjects(Array.isArray(projectRes.data) ? projectRes.data : []);
        setContractors(Array.isArray(contractorRes.data?.contractors) ? contractorRes.data.contractors : []);
        setSuppliers(Array.isArray(supplierRes.data) ? supplierRes.data : []);
      } else {
        const projectRes = await api.get('/projects');
        setProjects(Array.isArray(projectRes.data) ? projectRes.data : []);
      }
    } catch {
      toast.error('Failed to load mobile data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [managementUser]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const refreshFromGesture = () => loadData(true);
    window.addEventListener('buildtrack:pull-refresh', refreshFromGesture);
    return () => window.removeEventListener('buildtrack:pull-refresh', refreshFromGesture);
  }, [loadData]);

  useEffect(() => {
    const timer = window.setInterval(() => loadData(true), 30000);
    return () => window.clearInterval(timer);
  }, [loadData]);

  useEffect(() => {
    if (!navItems.some(item => item.key === tab)) setTab('projects');
  }, [navItems, tab]);

  const normalizedSearch = search.trim().toLowerCase();
  const filteredProjects = projects.filter(project =>
    project.address.toLowerCase().includes(normalizedSearch) ||
    (project.job_name || '').toLowerCase().includes(normalizedSearch)
  );
  const filteredContractors = contractors.filter(contractor =>
    (contractor.name || contractor.company || contractor.contact_name || '').toLowerCase().includes(normalizedSearch) ||
    (contractor.email || '').toLowerCase().includes(normalizedSearch) ||
    (contractor.phone || '').toLowerCase().includes(normalizedSearch)
  );
  const filteredSuppliers = suppliers.filter(supplier =>
    (supplier.name || supplier.contact || '').toLowerCase().includes(normalizedSearch) ||
    (supplier.email || '').toLowerCase().includes(normalizedSearch) ||
    (supplier.phone || '').toLowerCase().includes(normalizedSearch)
  );

  const rememberedProject = projects.find(project => project.id === localStorage.getItem(storageKey));
  const activeProjects = projects.filter(project => project.status === 'active_rehab').length;
  const openPunchCount = projects.reduce((count, project) => count + (project.open_punch_items || 0), 0);

  const sendContractorSetup = async (contractor: ContractorItem) => {
    const email = String(setupEmailInputs[contractor.id] ?? contractor.email ?? '').trim();
    if (!email) {
      toast.error('Enter an email for the secure 1099 setup link');
      return;
    }

    setSendingSetupId(contractor.id);
    try {
      await api.post(`/contractor-onboarding/contractors/${contractor.id}/request`, {
        email,
        save_email: !contractor.email,
      });
      toast.success('Secure 1099 setup link sent');
      await loadData(true);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to send setup link');
    } finally {
      setSendingSetupId(null);
    }
  };

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
              <MapPin size={22} />
            </div>
            <div className="btm-brand-text">
              <p>BuildTrack</p>
              <span>{user?.name?.split(' ')[0] || 'User'} / {roleLabels[user?.role || ''] || 'Mobile'}</span>
            </div>
          </div>
          <div className="btm-header-actions">
            <button
              type="button"
              onClick={() => loadData(true)}
              disabled={refreshing}
              aria-label="Refresh mobile dashboard"
              className="btm-icon-button"
            >
              <RefreshCw className={refreshing ? 'btm-spin' : ''} size={21} />
            </button>
            {canCreateProjects(user?.role || '') && (
              <button
                type="button"
                onClick={() => navigate('/mobile/add-project')}
                aria-label="Add new project"
                className="btm-icon-button btm-icon-button-create"
              >
                <Plus size={23} />
              </button>
            )}
            <button type="button" onClick={handleLogout} aria-label="Sign out" className="btm-icon-button">
              <LogOut size={21} />
            </button>
          </div>
        </div>

        <label className="btm-search" aria-label="Search mobile app">
          <Search size={22} />
          <input
            type="text"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder={managementUser ? 'Search jobs, crews, vendors' : 'Search assigned jobs'}
          />
        </label>

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
      </header>

      <main className="mobile-content btm-home-content">
        {tab === 'projects' && (
          <section className="btm-list-section" aria-label="Projects">
            <SectionHeader
              label={`${filteredProjects.length} Project${filteredProjects.length === 1 ? '' : 's'}`}
              actionLabel={canCreateProjects(user?.role || '') ? 'New Project' : undefined}
              onAction={canCreateProjects(user?.role || '') ? () => navigate('/mobile/add-project') : undefined}
            />

            {filteredProjects.length === 0 ? (
              <EmptyState icon={<FolderOpen size={38} />} title="No projects found" />
            ) : filteredProjects.map(project => (
              <ProjectCard key={project.id} project={project} managementUser={managementUser} />
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

        {tab === 'contractors' && managementUser && (
          <section className="btm-list-section" aria-label="Contractors">
            <SectionHeader label={`${filteredContractors.length} Contractor${filteredContractors.length === 1 ? '' : 's'}`} />
            {filteredContractors.slice(0, 80).map(contractor => {
              const setupEmail = setupEmailInputs[contractor.id] ?? contractor.email ?? '';
              return (
                <article key={contractor.id} className="btm-directory-card">
                  <div className="btm-directory-main">
                    <div className="btm-directory-icon btm-directory-icon-crew">
                      <Users size={22} />
                    </div>
                    <div>
                      <h2>{contractor.name || contractor.company || contractor.contact_name || 'Contractor'}</h2>
                      <p>{contractor.contractor_category || contractor.category || contractor.email || contractor.phone || 'Contractor record'}</p>
                    </div>
                    <span>{contractor.connected_project_count ?? contractor.assigned_project_count ?? 0}</span>
                  </div>
                  <div className="btm-setup-row">
                    <label>
                      <span>Secure 1099 setup</span>
                      <input
                        type="email"
                        value={setupEmail}
                        onChange={event => setSetupEmailInputs(prev => ({ ...prev, [contractor.id]: event.target.value }))}
                        placeholder="contractor@email.com"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => sendContractorSetup(contractor)}
                      disabled={sendingSetupId === contractor.id}
                      aria-label="Send secure 1099 setup link"
                    >
                      <Send size={19} />
                    </button>
                  </div>
                </article>
              );
            })}
          </section>
        )}

        {tab === 'suppliers' && managementUser && (
          <section className="btm-list-section" aria-label="Suppliers">
            <SectionHeader label={`${filteredSuppliers.length} Supplier${filteredSuppliers.length === 1 ? '' : 's'}`} />
            {filteredSuppliers.slice(0, 80).map(supplier => (
              <article key={supplier.id} className="btm-directory-card">
                <div className="btm-directory-main">
                  <div className="btm-directory-icon btm-directory-icon-vendor">
                    <Truck size={22} />
                  </div>
                  <div>
                    <h2>{supplier.name || supplier.contact || 'Supplier'}</h2>
                    <p>{supplier.category || supplier.email || supplier.phone || 'Supplier record'}</p>
                  </div>
                </div>
              </article>
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

  function ProjectCard({ project, managementUser }: { project: Project; managementUser: boolean }) {
    const meta = statusMeta(project.status);
    const openPunch = project.open_punch_items || 0;

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
            </span>
          </span>
          <ChevronRight className="btm-project-chevron" size={22} />
        </button>

        <div className="btm-project-actions">
          <button
            type="button"
            onClick={() => navigate(`/mobile/photos?projectId=${project.id}&camera=1`)}
            className="btm-action-button btm-action-photo"
            aria-label={`Take progress pictures for ${project.address}`}
          >
            <Camera size={22} />
            <span>Take Photos</span>
          </button>
          <button
            type="button"
            onClick={() => navigate(`/mobile/project/${project.id}`)}
            className="btm-action-button btm-action-open"
          >
            <FolderOpen size={22} />
            <span>Open Project</span>
          </button>
          <button
            type="button"
            onClick={() => navigate(`/mobile/project/${project.id}/punch-list`)}
            className={`btm-action-button ${openPunch > 0 ? 'btm-action-punch-hot' : 'btm-action-punch'}`}
          >
            <ClipboardList size={22} />
            <span>Punch List</span>
          </button>
          {!managementUser && (
            <button
              type="button"
              onClick={() => navigate(`/mobile/project/${project.id}/invoice`)}
              className="btm-action-button btm-action-invoice"
            >
              <FileText size={22} />
              <span>Invoice</span>
            </button>
          )}
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
