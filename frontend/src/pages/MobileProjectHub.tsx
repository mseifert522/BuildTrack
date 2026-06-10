import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  ArrowLeft,
  Calendar,
  Camera,
  ChevronRight,
  ClipboardList,
  DollarSign,
  FileText,
  ImagePlus,
  MessageSquare,
  MoreHorizontal,
  Package,
  Users,
  X,
} from 'lucide-react';
import api from '../lib/api';
import { useAuthStore } from '../store/authStore';
import { MOBILE_DATA_CHANGED_EVENT } from '../lib/mobileEvents';

interface Project {
  id: string;
  address: string;
  job_name?: string;
  status: string;
  budget?: number;
  punchlist_stage?: number | boolean | string | null;
  active_scope_count?: number;
  field_work_task_count?: number;
}

interface ProjectTool {
  label: string;
  helper: string;
  Icon: typeof Camera;
  tone: 'amber' | 'blue' | 'green' | 'red' | 'teal' | 'violet' | 'slate';
  to: string;
}

const STATUS_LABELS: Record<string, string> = {
  not_started: 'Not Started',
  active_rehab: 'Active Rehab',
  rehab_completed: 'Completed',
  long_term_holding: 'Long-Term Holding',
  commercial: 'Commercial',
  archived: 'Archived',
};

function toCount(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isEnabledFlag(value: unknown) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  return false;
}

function hasScopeOfWork(project: Project) {
  return toCount(project.active_scope_count) > 0 || toCount(project.field_work_task_count) > 0;
}

function projectTitle(project: Project) {
  return project.job_name || project.address.split(',')[0] || 'Project';
}

function statusLabel(status: string) {
  return STATUS_LABELS[status] || status.replace(/_/g, ' ');
}

function formatMoney(value?: number) {
  if (!value) return null;
  return Number(value).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

export default function MobileProjectHub() {
  const { id } = useParams<{ id: string }>();
  const projectId = id || '';
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [project, setProject] = useState<Project | null>(null);
  const [punchCount, setPunchCount] = useState(0);
  const [openCount, setOpenCount] = useState(0);
  const [invoiceCount, setInvoiceCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showMoreActions, setShowMoreActions] = useState(false);
  const managementUser = user?.role !== 'contractor';
  const scopeEnabled = project ? hasScopeOfWork(project) : false;
  const punchEnabled = project ? isEnabledFlag(project.punchlist_stage) : false;
  const budgetLabel = project ? formatMoney(project.budget) : null;

  const loadProject = useCallback(async (silent = false) => {
    if (!projectId) return;
    if (!silent) setLoading(true);
    try {
      const res = await api.get(`/projects/${projectId}`);
      setProject(res.data);
      const [punchRes, invRes] = await Promise.all([
        api.get(`/projects/${projectId}/punch-list`).catch(() => ({ data: [] })),
        api.get(`/projects/${projectId}/invoices`).catch(() => ({ data: [] })),
      ]);
      const items = Array.isArray(punchRes.data) ? punchRes.data : [];
      setPunchCount(items.length);
      setOpenCount(items.filter((p: any) => p.status !== 'completed' && p.status !== 'rehab_completed' && p.status !== 'closed_sold').length);
      setInvoiceCount(Array.isArray(invRes.data) ? invRes.data.length : 0);
      setError('');
    } catch (err) {
      if (!silent) setError('Failed to load project. Please go back and try again.');
      console.error('Project load error:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  useEffect(() => {
    const refreshProject = () => void loadProject(true);
    const refreshWhenVisible = () => {
      if (!document.hidden) refreshProject();
    };
    window.addEventListener(MOBILE_DATA_CHANGED_EVENT, refreshProject);
    window.addEventListener('focus', refreshWhenVisible);
    window.addEventListener('pageshow', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener(MOBILE_DATA_CHANGED_EVENT, refreshProject);
      window.removeEventListener('focus', refreshWhenVisible);
      window.removeEventListener('pageshow', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [loadProject]);

  const drawerActions = useMemo<ProjectTool[]>(() => {
    const actions: ProjectTool[] = [];
    if (!projectId) return actions;

    if (scopeEnabled) {
      actions.push({
        label: 'Scope Photos',
        helper: 'Capture scope evidence for desktop review',
        Icon: ImagePlus,
        tone: 'teal',
        to: `/mobile/photos?projectId=${projectId}&mode=scope&camera=1`,
      });
    }

    if (punchEnabled) {
      actions.push({
        label: 'Punch List',
        helper: openCount > 0 ? `${openCount} open item${openCount === 1 ? '' : 's'}` : 'Walk-through issues and closeout',
        Icon: ClipboardList,
        tone: openCount > 0 ? 'red' : 'slate',
        to: `/mobile/project/${projectId}/punch-list`,
      });
    }

    actions.push(
      {
        label: 'Notes',
        helper: 'Read and add project notes',
        Icon: MessageSquare,
        tone: 'green',
        to: `/mobile/project/${projectId}/notes`,
      },
      {
        label: 'Photo Timeline',
        helper: 'Review progress media by date',
        Icon: Camera,
        tone: 'amber',
        to: `/mobile/project/${projectId}/progress`,
      },
      {
        label: 'Invoice',
        helper: invoiceCount === 0 ? 'Create first invoice' : `${invoiceCount} invoice${invoiceCount === 1 ? '' : 's'}`,
        Icon: FileText,
        tone: 'violet',
        to: `/mobile/project/${projectId}/invoice`,
      }
    );

    if (managementUser) {
      actions.push(
        {
          label: 'Full Project View',
          helper: 'Open the desktop project record',
          Icon: FileText,
          tone: 'blue',
          to: `/projects/${projectId}`,
        },
        {
          label: 'Schedule and Scope',
          helper: 'Milestones, dependencies, and rehab steps',
          Icon: Calendar,
          tone: 'blue',
          to: `/projects/${projectId}#construction-plan`,
        },
        {
          label: 'Budget and Quotes',
          helper: 'Forecast costs and contractor quotes',
          Icon: DollarSign,
          tone: 'green',
          to: `/projects/${projectId}#quotes`,
        },
        {
          label: 'Resources',
          helper: 'Assigned contractors and labor coverage',
          Icon: Users,
          tone: 'teal',
          to: `/projects/${projectId}#assigned-contractors`,
        },
        {
          label: 'Materials',
          helper: 'Supplies, delivery timing, and order status',
          Icon: Package,
          tone: 'amber',
          to: `/projects/${projectId}#construction-plan`,
        },
        {
          label: 'Reports',
          helper: 'Progress history and field activity',
          Icon: Activity,
          tone: 'red',
          to: `/projects/${projectId}#progress-history`,
        },
        {
          label: 'Messaging',
          helper: 'Text contractors and track responses',
          Icon: MessageSquare,
          tone: 'violet',
          to: `/projects/${projectId}#texts`,
        }
      );
    }

    return actions;
  }, [invoiceCount, managementUser, openCount, projectId, punchEnabled, scopeEnabled]);

  const goTo = (path: string) => {
    setShowMoreActions(false);
    navigate(path);
  };

  if (loading) {
    return (
      <div className="mobile-shell btm-home-shell btm-loading-screen">
        <div className="btm-loading-mark">
          <Camera size={26} />
        </div>
        <p>Loading project...</p>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="mobile-shell btm-home-shell btm-project-empty">
        <p>{error || 'Project not found.'}</p>
        <button type="button" onClick={() => navigate('/mobile')}>
          Back to Projects
        </button>
      </div>
    );
  }

  return (
    <div className="mobile-shell btm-home-shell btm-project-shell">
      <header className="btm-project-header">
        <button
          type="button"
          onClick={() => navigate('/mobile')}
          aria-label="Back to mobile home"
          className="btm-icon-button"
        >
          <ArrowLeft size={22} />
        </button>
        <div className="btm-project-header-title">
          <p>{projectTitle(project)}</p>
          <span>{project.address}</span>
        </div>
        <button
          type="button"
          onClick={() => setShowMoreActions(true)}
          aria-label="Open project tools"
          className="btm-icon-button"
        >
          <MoreHorizontal size={22} />
        </button>
      </header>

      <main className="mobile-content btm-project-content">
        <section className="btm-project-hero-panel" aria-label="Project summary">
          <div className="btm-project-status-row">
            <span>{statusLabel(project.status)}</span>
            {budgetLabel && <span>{budgetLabel}</span>}
          </div>
          <h1>{projectTitle(project)}</h1>
          <p>{project.address}</p>
          <div className="btm-project-metrics">
            {punchEnabled && (
              <span>
                <strong>{openCount}</strong>
                <small>open punch</small>
              </span>
            )}
            <span>
              <strong>{invoiceCount}</strong>
              <small>invoices</small>
            </span>
            <span>
              <strong>{scopeEnabled ? 'On' : 'Off'}</strong>
              <small>scope</small>
            </span>
          </div>
        </section>

        <section className="btm-primary-stack" aria-label="Field actions">
          <button
            type="button"
            onClick={() => navigate(`/mobile/photos?projectId=${projectId}&camera=1`)}
            className="btm-primary-action btm-primary-action-photo"
          >
            <span className="btm-primary-icon"><Camera size={28} /></span>
            <span>
              <strong>Take Progress Photos</strong>
              <small>Camera opens straight to this project</small>
            </span>
            <ChevronRight size={22} />
          </button>

          {scopeEnabled && (
            <button
              type="button"
              onClick={() => navigate(`/mobile/project/${projectId}/field-work`)}
              className="btm-primary-action btm-primary-action-scope"
            >
              <span className="btm-primary-icon"><FileText size={27} /></span>
              <span>
                <strong>Scope of Work</strong>
                <small>Tasks, notes, approvals, and scope evidence</small>
              </span>
              <ChevronRight size={22} />
            </button>
          )}

          {punchEnabled && openCount > 0 && (
            <button
              type="button"
              onClick={() => navigate(`/mobile/project/${projectId}/punch-list`)}
              className="btm-alert-row"
            >
              <ClipboardList size={22} />
              <span>{openCount} open punch item{openCount === 1 ? '' : 's'}</span>
              <ChevronRight size={20} />
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowMoreActions(true)}
            className="btm-more-tools-button"
          >
            <MoreHorizontal size={21} />
            <span>More Project Tools</span>
            <ChevronRight size={20} />
          </button>
        </section>
      </main>

      {showMoreActions && (
        <div className="btm-sheet-backdrop" onClick={() => setShowMoreActions(false)}>
          <section className="btm-tools-sheet" onClick={event => event.stopPropagation()} aria-label="Project tools">
            <div className="btm-sheet-handle" />
            <div className="btm-tools-sheet-header">
              <div>
                <p>Project Tools</p>
                <span>{projectTitle(project)}</span>
              </div>
              <button type="button" onClick={() => setShowMoreActions(false)} aria-label="Close project tools">
                <X size={20} />
              </button>
            </div>
            <div className="btm-tools-list">
              {drawerActions.map(action => (
                <button
                  key={`${action.label}-${action.to}`}
                  type="button"
                  onClick={() => goTo(action.to)}
                  className={`btm-tool-row btm-tool-${action.tone}`}
                >
                  <span className="btm-tool-icon"><action.Icon size={22} /></span>
                  <span>
                    <strong>{action.label}</strong>
                    <small>{action.helper}</small>
                  </span>
                  <ChevronRight size={19} />
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
