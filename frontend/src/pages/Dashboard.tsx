import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore, isAdminRole, roleLabels } from '../store/authStore';
import api from '../lib/api';
import { Loading, Modal, StatusBadge } from '../components/ui';
import Avatar from '../components/Avatar';
import RecentActivityModal from '../components/RecentActivityModal';
import {
  FolderOpen, ClipboardList, FileText, Image,
  TrendingUp, AlertTriangle, CheckCircle2, Clock,
  ArrowUpRight, Plus, ChevronRight, MapPin, MessageSquare,
  X, Bell
} from 'lucide-react';
import { EASTERN_TIME_ZONE, formatEasternDate, formatEasternDateTime, formatEasternRelative, formatEasternTime, parseBuildTrackTimestamp } from '../lib/time';

interface Stats {
  total_projects: number;
  under_construction: number;
  completed_projects: number;
  long_term_holdings?: number;
  commercial_projects?: number;
  sold_projects: number;
  active_projects: number;
  in_progress_projects: number;
  open_punch_items: number;
  pending_invoices: number;
  recent_photos: number;
}

interface Project {
  id: string;
  address: string;
  job_name: string;
  status: string;
  open_punch_items: number;
  assigned_count: number;
  updated_at: string;
  budget: number;
  lifecycle_status?: string;
}

interface Invoice {
  id: string;
  invoice_number: string;
  address: string;
  contractor_name: string;
  total: number;
  status: string;
  created_at: string;
}

interface RecentNote {
  id: string;
  project_id: string;
  user_id: string;
  user_name: string;
  user_role: string;
  user_avatar_url?: string | null;
  note: string;
  note_type: string;
  created_at: string;
  project_address: string;
  project_job_name: string;
  project_status: string;
}

interface ReviewChange {
  id: string;
  action: string;
  user_name: string;
  created_at: string;
  summary: string;
}

interface ProjectReviewSummary {
  project_id: string;
  project_address: string;
  project_job_name: string;
  project_status: string;
  change_count: number;
  latest_at: string;
  latest_by: string;
  changes: ReviewChange[];
}

interface FieldWorkTask {
  id: string;
  project_id: string;
  title: string;
  category?: string;
  status: string;
  verification_status: string;
  invoice_status: string;
  target_date?: string | null;
  project_address: string;
  project_job_name?: string;
  alert_level: 'normal' | 'attention' | 'critical';
  invoice_blocks_payment?: number;
  latest_photo_note?: string | null;
}

interface FieldWorkNote {
  id: string;
  project_id: string;
  note?: string;
  created_at: string;
  user_name: string;
  project_address: string;
  photo_count?: number;
}

interface FieldWorkPhoto {
  id: string;
  project_id: string;
  original_name?: string;
  label?: string;
  captured_at?: string;
  user_name: string;
  project_address: string;
  photo_note?: string | null;
}

interface FieldWorkInvoiceHold {
  id: string;
  invoice_number: string;
  project_id: string;
  status: string;
  total: number;
  contractor_name: string;
  project_address: string;
  blocking_item_count: number;
}

interface FieldWorkWatchlist {
  counts: {
    field_notes: number;
    field_photos: number;
    scheduled_tasks: number;
    approvals_needed: number;
    invoice_holds: number;
    total_alerts: number;
  };
  tasks: FieldWorkTask[];
  field_notes: FieldWorkNote[];
  field_photos: FieldWorkPhoto[];
  invoice_holds: FieldWorkInvoiceHold[];
}

const greeting = () => {
  const h = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TIME_ZONE,
    hour: 'numeric',
    hour12: false,
  }).format(new Date()));
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
};

const parseDate = (value: string) => {
  return parseBuildTrackTimestamp(value) || new Date();
};

const noteTypeStyles: Record<string, { label: string; bg: string; color: string; border: string; accent: string }> = {
  general: { label: 'General note', bg: '#EFF6FF', color: '#1D4ED8', border: '#BFDBFE', accent: '#3B82F6' },
  office: { label: 'Office note', bg: '#FEF3C7', color: '#92400E', border: '#FDE68A', accent: '#D97706' },
  field: { label: 'Field note', bg: '#ECFDF5', color: '#047857', border: '#A7F3D0', accent: '#10B981' },
};

const projectStatusStyles: Record<string, { label: string; bg: string; color: string; border: string }> = {
  active_rehab: { label: 'Active Rehab', bg: 'rgba(16,185,129,0.12)', color: '#A7F3D0', border: 'rgba(16,185,129,0.35)' },
  not_started: { label: 'Not Started', bg: 'rgba(148,163,184,0.14)', color: '#CBD5E1', border: 'rgba(148,163,184,0.30)' },
  rehab_completed: { label: 'Completed', bg: 'rgba(59,130,246,0.14)', color: '#BFDBFE', border: 'rgba(59,130,246,0.35)' },
  long_term_holding: { label: 'Long-Term Holding', bg: 'rgba(217,119,6,0.14)', color: '#FCD34D', border: 'rgba(217,119,6,0.35)' },
  commercial: { label: 'Commercial', bg: 'rgba(14,116,144,0.14)', color: '#67E8F9', border: 'rgba(14,116,144,0.35)' },
  completed: { label: 'Completed', bg: 'rgba(59,130,246,0.14)', color: '#BFDBFE', border: 'rgba(59,130,246,0.35)' },
};

const getNoteTypeStyle = (type?: string) => noteTypeStyles[type || 'general'] || noteTypeStyles.general;
const getProjectStatusStyle = (status?: string) => (
  projectStatusStyles[status || ''] || { label: 'Project', bg: 'rgba(217,157,38,0.12)', color: '#FDE68A', border: 'rgba(217,157,38,0.35)' }
);

const formatMoney = (value: number) =>
  Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });


export default function Dashboard() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [stats, setStats] = useState<Stats | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [recentNotes, setRecentNotes] = useState<RecentNote[]>([]);
  const [reviewSummaries, setReviewSummaries] = useState<ProjectReviewSummary[]>([]);
  const [fieldWatch, setFieldWatch] = useState<FieldWorkWatchlist | null>(null);
  const [showReviewSummary, setShowReviewSummary] = useState(false);
  const [showFieldWatchReminder, setShowFieldWatchReminder] = useState(false);
  const [reviewDismissKey, setReviewDismissKey] = useState('');
  const [reviewLoginKey, setReviewLoginKey] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const canShowReview = !!user && isAdminRole(user.role);
        const loginSummaryKey = user?.id ? `buildtrack-login-review-summary:${user.id}` : '';
        const forceLoginSummary = canShowReview && !!loginSummaryKey && sessionStorage.getItem(loginSummaryKey) === '1';
        const [projRes, allProjRes, invRes, notesRes, reviewRes, fieldWatchRes] = await Promise.all([
          api.get('/projects?status=active_rehab'),
          api.get('/projects'),
          api.get('/invoices'),
          api.get('/notes/recent?limit=50').catch(() => ({ data: [] })),
          canShowReview
            ? api.get(`/projects/unreviewed-summary${forceLoginSummary ? '?scope=recent' : ''}`).catch(() => ({ data: { projects: [] } }))
            : Promise.resolve({ data: { projects: [] } }),
          canShowReview
            ? api.get('/field-work/watchlist').catch(() => ({ data: null }))
            : Promise.resolve({ data: null }),
        ]);
        setProjects(projRes.data.slice(0, 6));
        setRecentNotes(notesRes.data.slice(0, 50));
        setAllProjects(allProjRes.data);
        setInvoices(Array.isArray(invRes.data) ? invRes.data : []);
        const nextFieldWatch = fieldWatchRes.data && typeof fieldWatchRes.data === 'object'
          ? fieldWatchRes.data as FieldWorkWatchlist
          : null;
        setFieldWatch(nextFieldWatch);
        if (canShowReview && nextFieldWatch?.counts?.total_alerts) {
          const fieldWatchDismissKey = `buildtrack-field-watch:${user.id}:${nextFieldWatch.counts.total_alerts}`;
          setShowFieldWatchReminder(!sessionStorage.getItem(fieldWatchDismissKey));
        } else {
          setShowFieldWatchReminder(false);
        }

        const summaries = Array.isArray(reviewRes.data?.projects) ? reviewRes.data.projects : [];
        setReviewSummaries(summaries);
        if (canShowReview && summaries.length > 0) {
          const latestAt = summaries.reduce((latest: string, project: ProjectReviewSummary) =>
            !latest || parseDate(project.latest_at) > parseDate(latest) ? project.latest_at : latest
          , '');
          const dismissKey = `buildtrack-review-summary:${user.id}:${latestAt}`;
          setReviewDismissKey(dismissKey);
          setReviewLoginKey(forceLoginSummary ? loginSummaryKey : '');
          setShowReviewSummary(forceLoginSummary || !sessionStorage.getItem(dismissKey));
        } else {
          setShowReviewSummary(false);
          setReviewDismissKey('');
          setReviewLoginKey('');
          if (forceLoginSummary && loginSummaryKey) sessionStorage.removeItem(loginSummaryKey);
        }

        if (user && isAdminRole(user.role)) {
          try {
            const statsRes = await api.get('/projects/stats');
            setStats(statsRes.data);
          } catch {}
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [user?.id, user?.role]);

  if (loading) return <Loading />;

  const firstName = user?.name?.split(' ')[0] || 'there';
  const now = new Date();
  const reviewSummaryTotal = reviewSummaries.reduce((sum, project) => sum + project.change_count, 0);
  const fieldWatchTotal = fieldWatch?.counts?.total_alerts ?? 0;

  const markReviewSummariesReviewed = () => {
    const projectIds = Array.from(new Set(reviewSummaries.map(project => project.project_id).filter(Boolean)));
    if (!projectIds.length) return;
    Promise.allSettled(projectIds.map(projectId => api.post(`/projects/${projectId}/reviewed`)))
      .catch(err => console.error('Failed to mark review summary read', err));
  };

  const closeReviewSummary = () => {
    markReviewSummariesReviewed();
    if (reviewDismissKey) sessionStorage.setItem(reviewDismissKey, '1');
    if (reviewLoginKey) sessionStorage.removeItem(reviewLoginKey);
    setShowReviewSummary(false);
  };

  const closeFieldWatchReminder = () => {
    if (user?.id && fieldWatch?.counts?.total_alerts) {
      sessionStorage.setItem(`buildtrack-field-watch:${user.id}:${fieldWatch.counts.total_alerts}`, '1');
    }
    setShowFieldWatchReminder(false);
  };

  // Lifecycle KPI counts
  const totalProjects = allProjects.length;
  const activeRehabs = allProjects.filter(p => p.status === 'active_rehab').length;
  const notStarted = allProjects.filter(p => p.status === 'not_started').length;
  const completedProjects = stats?.completed_projects ?? allProjects.filter(p =>
    p.status === 'rehab_completed' || p.status === 'completed' || p.lifecycle_status === 'completed'
  ).length;
  const longTermHoldings = stats?.long_term_holdings ?? allProjects.filter(p => p.status === 'long_term_holding').length;
  const commercialProjects = stats?.commercial_projects ?? allProjects.filter(p => p.status === 'commercial').length;
  const openInvoices = invoices.filter(invoice => invoice.status !== 'paid');
  const paidInvoices = invoices.filter(invoice => invoice.status === 'paid');
  const openInvoiceAmount = openInvoices.reduce((sum, invoice) => sum + Number(invoice.total || 0), 0);
  const paidInvoiceAmount = paidInvoices.reduce((sum, invoice) => sum + Number(invoice.total || 0), 0);
  const totalBudget = allProjects.reduce((sum, project) => sum + Number(project.budget || 0), 0);
  const activeBudget = allProjects.filter(project => project.status === 'active_rehab').reduce((sum, project) => sum + Number(project.budget || 0), 0);
  const openPunchItems = stats?.open_punch_items ?? allProjects.reduce((sum, project) => sum + Number(project.open_punch_items || 0), 0);
  const pendingInvoices = stats?.pending_invoices ?? openInvoices.length;
  const recentPhotoCount = stats?.recent_photos ?? 0;
  const completionRate = totalProjects ? Math.round((completedProjects / totalProjects) * 100) : 0;
  const budgetExposureRate = totalBudget ? Math.min(100, Math.round((openInvoiceAmount / totalBudget) * 100)) : 0;
  const priorityCards = [
    {
      label: 'Projects',
      value: `${activeRehabs} active`,
      detail: `${completionRate}% completion across ${totalProjects} tracked projects`,
      trend: notStarted > 0 ? `${notStarted} queued` : 'No queued rehabs',
      icon: FolderOpen,
      to: '/projects?status=active_rehab',
      accent: '#E78B4A',
      progress: completionRate,
    },
    {
      label: 'Financials',
      value: formatMoney(openInvoiceAmount),
      detail: `${pendingInvoices} open invoices against ${formatMoney(activeBudget)} active rehab budget`,
      trend: `${formatMoney(paidInvoiceAmount)} paid to date`,
      icon: FileText,
      to: '/invoices',
      accent: '#5DA271',
      progress: budgetExposureRate,
    },
    {
      label: 'Tasks',
      value: `${openPunchItems} open`,
      detail: `${fieldWatchTotal} field alert${fieldWatchTotal === 1 ? '' : 's'}, ${reviewSummaryTotal} review update${reviewSummaryTotal === 1 ? '' : 's'}, ${recentPhotoCount} recent photos`,
      trend: fieldWatchTotal > 0 ? 'Field check required' : openPunchItems > 0 ? 'Needs field follow-up' : 'No open punch exposure',
      icon: ClipboardList,
      to: '/projects',
      accent: fieldWatchTotal > 0 || openPunchItems > 0 ? '#D46A4C' : '#5DA271',
      progress: fieldWatchTotal > 0 ? Math.min(100, fieldWatchTotal * 10) : openPunchItems > 0 ? Math.min(100, openPunchItems * 8) : 100,
    },
  ];
  const operationsModules = [
    { label: 'Project Work Status', detail: 'Review active project progress', to: '/projects', icon: FolderOpen },
    { label: 'Final Punch Lists', detail: 'Track closeout work items', to: '/punch-list', icon: ClipboardList },
  ];

  const kpiCards = [
    {
      label: 'Total Projects',
      value: totalProjects,
      sub: 'All tracked projects',
      icon: FolderOpen,
      gradient: 'linear-gradient(135deg, #1A1D21 0%, #E78B4A 100%)',
      iconBg: 'rgba(255,255,255,0.15)',
      trend: 'Project total',
      trendUp: true,
      filter: 'all_projects',
    },
    {
      label: 'Active Rehabs',
      value: activeRehabs,
      sub: 'Currently under construction',
      icon: TrendingUp,
      gradient: 'linear-gradient(135deg, #231811 0%, #D46A4C 100%)',
      iconBg: 'rgba(255,255,255,0.15)',
      trend: activeRehabs > 0 ? 'In progress' : 'None active',
      trendUp: activeRehabs > 0,
      filter: 'active_rehab',
    },
    {
      label: 'Not Started',
      value: notStarted,
      sub: 'Queued before rehab',
      icon: Clock,
      gradient: 'linear-gradient(135deg, #374151 0%, #6B7280 100%)',
      iconBg: 'rgba(255,255,255,0.15)',
      trend: notStarted > 0 ? 'Queued' : 'None waiting',
      trendUp: notStarted > 0,
      filter: 'not_started',
    },
    {
      label: 'Completed Projects',
      value: completedProjects,
      sub: 'Finished rehab projects',
      icon: CheckCircle2,
      gradient: 'linear-gradient(135deg, #102018 0%, #5DA271 100%)',
      iconBg: 'rgba(255,255,255,0.15)',
      trend: completedProjects > 0 ? 'Completed' : 'None complete',
      trendUp: completedProjects > 0,
      filter: 'rehab_completed',
    },
    {
      label: 'Long-Term Holdings',
      value: longTermHoldings,
      sub: 'Held portfolio properties',
      icon: FolderOpen,
      gradient: 'linear-gradient(135deg, #25180C 0%, #B7793C 100%)',
      iconBg: 'rgba(255,255,255,0.15)',
      trend: longTermHoldings > 0 ? 'Holding' : 'None held',
      trendUp: longTermHoldings > 0,
      filter: 'long_term_holding',
    },
    {
      label: 'Commercial',
      value: commercialProjects,
      sub: 'Commercial project pipeline',
      icon: FolderOpen,
      gradient: 'linear-gradient(135deg, #102027 0%, #4E879A 100%)',
      iconBg: 'rgba(255,255,255,0.15)',
      trend: commercialProjects > 0 ? 'Commercial' : 'None listed',
      trendUp: commercialProjects > 0,
      filter: 'commercial',
    },
  ];

  return (
    <div className="bt-desktop-page bt-dashboard-page" style={{ minHeight: '100%' }}>
      {/* Hero header bar */}
      <div
        className="border-b border-slate-800 bg-white px-6 py-5 md:px-8"
        style={{
          boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
        }}
      >
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <span
                className="inline-flex items-center gap-1.5 rounded-sm border border-orange-400/70 bg-orange-950/30 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-orange-300"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-current" />
                Operations Dashboard
              </span>
            </div>
            <h1 className="text-xl font-bold tracking-tight text-slate-950">
              {greeting()}, {firstName}
            </h1>
            <p className="mt-1 text-sm font-medium text-slate-500">
              {formatEasternDate(now.toISOString(), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} - {roleLabels[user?.role || '']}
            </p>
          </div>
          <div className="hidden md:flex items-center gap-3">
            <Link
              to="/projects"
              className="bt-btn bt-btn-primary"
            >
              <Plus className="w-4 h-4" />
              New Project
            </Link>
          </div>
        </div>
      </div>

      <div className="px-6 py-6 md:px-8 max-w-7xl mx-auto space-y-4">
        {/* Desktop command center */}
        <section className="grid gap-4 xl:grid-cols-[1.18fr_0.82fr]" aria-label="BuildTrack command center">
          <div className="bt-card p-4">
            <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="bt-section-kicker">Today&apos;s priorities</p>
                <h2 className="bt-section-title">Projects, money, and field work</h2>
              </div>
              <span className="inline-flex w-fit items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-800">
                <Bell className="h-3.5 w-3.5" />
                {reviewSummaryTotal} updates
              </span>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              {priorityCards.map(card => (
                <button
                  key={card.label}
                  type="button"
                  onClick={() => navigate(card.to)}
                  className="min-h-[138px] rounded-sm border border-slate-700 bg-slate-50 p-3 text-left transition-colors hover:border-orange-400 hover:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500"
                >
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl text-white" style={{ background: card.accent }}>
                      <card.icon className="h-5 w-5" />
                    </div>
                    <span className="inline-flex items-center gap-1 rounded-sm bg-white px-2 py-1 text-[11px] font-bold text-slate-600 ring-1 ring-slate-700">
                      {card.progress >= 65 ? <TrendingUp className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                      {card.trend}
                    </span>
                  </div>
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{card.label}</p>
                  <p className="mt-1 text-xl font-bold text-slate-950">{card.value}</p>
                  <p className="mt-1 min-h-10 text-sm font-medium leading-5 text-slate-600">{card.detail}</p>
                  <div className="mt-4 h-2 overflow-hidden rounded-full bg-white ring-1 ring-slate-200" aria-hidden="true">
                    <div className="h-full rounded-full" style={{ width: `${card.progress}%`, background: card.accent }} />
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="bt-card p-4">
            <div className="mb-4">
              <p className="bt-section-kicker">Construction modules</p>
              <h2 className="bt-section-title">Operational entry points</h2>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
              {operationsModules.map(module => (
                <Link
                  key={module.label}
                  to={module.to}
                  className="flex min-h-14 items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 transition-colors hover:border-slate-300 hover:bg-white"
                >
                  <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-slate-800 text-white">
                    <module.icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-slate-900">{module.label}</span>
                    <span className="block truncate text-xs font-medium text-slate-500">{module.detail}</span>
                  </span>
                  <ChevronRight className="ml-auto h-4 w-4 flex-shrink-0 text-slate-400" />
                </Link>
              ))}
            </div>
            <div className="mt-4 border-t border-slate-700 pt-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="bt-section-kicker">Final watch list</p>
                  <h3 className="text-sm font-bold text-slate-950">Field checks before payment</h3>
                </div>
                <span className={`rounded-sm px-2 py-1 text-xs font-black ${fieldWatchTotal > 0 ? 'bg-red-50 text-red-700 ring-1 ring-red-200' : 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'}`}>
                  {fieldWatchTotal > 0 ? `${fieldWatchTotal} alerts` : 'Clear'}
                </span>
              </div>
              <div className="grid gap-2">
                {[
                  {
                    label: 'Field notes & pictures',
                    value: `${(fieldWatch?.counts?.field_notes || 0) + (fieldWatch?.counts?.field_photos || 0)}`,
                    detail: 'New evidence to review from the field',
                    icon: Image,
                    tone: '#2563EB',
                  },
                  {
                    label: 'Scheduled work status',
                    value: `${fieldWatch?.counts?.scheduled_tasks || 0}`,
                    detail: 'Upcoming or in-process scope tasks',
                    icon: Clock,
                    tone: '#D97706',
                  },
                  {
                    label: 'Approval / invoice holds',
                    value: `${(fieldWatch?.counts?.approvals_needed || 0) + (fieldWatch?.counts?.invoice_holds || 0)}`,
                    detail: 'Must be approved before payment',
                    icon: AlertTriangle,
                    tone: '#DC2626',
                  },
                ].map(item => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => {
                      const firstTaskProject = fieldWatch?.tasks?.[0]?.project_id;
                      const firstHoldProject = fieldWatch?.invoice_holds?.[0]?.project_id;
                      const firstNoteProject = fieldWatch?.field_notes?.[0]?.project_id;
                      navigate(`/projects/${firstTaskProject || firstHoldProject || firstNoteProject || ''}`.replace(/\/$/, ''));
                    }}
                    className="flex min-h-12 items-center gap-3 rounded-sm border border-slate-700 bg-white px-3 py-2 text-left transition-colors hover:border-orange-400 hover:bg-slate-50"
                  >
                    <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-slate-100" style={{ color: item.tone }}>
                      <item.icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-black uppercase tracking-wide text-slate-700">{item.label}</span>
                      <span className="block truncate text-xs font-medium text-slate-500">{item.detail}</span>
                    </span>
                    <span className="text-lg font-black text-slate-950">{item.value}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
          {kpiCards.map(card => {
            const target = card.filter === 'all_projects' ? '/projects' : `/projects?status=${card.filter}`;
            return (
              <div
                key={card.label}
                role="button"
                tabIndex={0}
                className="bt-dashboard-stat-card relative min-h-[78px] cursor-pointer overflow-hidden rounded-sm p-3 transition-colors active:scale-[0.99]"
                onClick={() => navigate(target)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    navigate(target);
                  }
                }}
              >
                <div className="relative z-10">
                  <div className="mb-2 flex items-start justify-between">
                    <div
                      className="flex h-8 w-8 items-center justify-center rounded-md bg-slate-100 text-slate-700"
                    >
                      <card.icon className="h-3.5 w-3.5" />
                    </div>
                    <span
                      className="hidden items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 md:flex"
                    >
                      {card.trendUp ? (
                        <TrendingUp className="w-3 h-3" />
                      ) : (
                        <AlertTriangle className="w-3 h-3" />
                      )}
                      {card.trend}
                    </span>
                  </div>
                  <div className="flex items-end gap-2">
                    <p className="text-2xl font-bold leading-none text-slate-950">{card.value}</p>
                    <p className="pb-0.5 text-xs font-bold leading-tight text-slate-800">{card.label}</p>
                  </div>
                  <p className="mt-1 hidden truncate text-[10px] font-medium text-slate-500 sm:block">{card.sub}</p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Main content grid */}
        <div className="grid gap-6">
          {/* Latest Notes Activity */}
          <div
            id="recent-activity"
            className="bt-card overflow-hidden"
            style={{
              boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
            }}
          >
            <div
              className="flex items-center justify-between gap-4 border-b border-slate-700 px-4 py-3"
              style={{
                background: 'var(--bt-panel-2)',
              }}
            >
              <div className="flex items-center gap-3">
                <div
                  className="flex h-9 w-9 items-center justify-center rounded-xl border"
                  style={{ background: '#EFF6FF', borderColor: '#BFDBFE' }}
                >
                  <MessageSquare className="h-4 w-4" style={{ color: '#2563EB' }} />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-slate-950">Latest Notes Activity</h2>
                  <p className="text-xs font-medium text-slate-500">{recentNotes.length} notes across all projects</p>
                </div>
              </div>
            </div>

            {recentNotes.length === 0 ? (
              <div className="flex min-h-[420px] flex-col items-center justify-center px-6 py-16">
                <div
                  className="mb-4 flex h-14 w-14 items-center justify-center rounded-lg border border-slate-200 bg-slate-50"
                >
                  <MessageSquare className="h-7 w-7 text-slate-500" />
                </div>
                <p className="text-sm font-bold text-slate-700">No notes yet</p>
                <p className="mt-1 text-xs text-slate-500">Project notes will appear here as they are added</p>
              </div>
            ) : (
              <div className="max-h-[640px] min-h-[460px] space-y-2 overflow-y-auto p-3">
                {recentNotes.map((note) => {
                  const noteStyle = getNoteTypeStyle(note.note_type);
                  const statusStyle = getProjectStatusStyle(note.project_status);
                  return (
                    <div
                      key={note.id}
                      role="link"
                      tabIndex={0}
                      onClick={() => navigate(`/projects/${note.project_id}`)}
                      onKeyDown={event => {
                        if (event.key === 'Enter') navigate(`/projects/${note.project_id}`);
                      }}
                      className="group relative flex cursor-pointer items-start gap-3 rounded-sm border border-slate-700 bg-white p-3 transition-colors hover:border-orange-400 hover:bg-slate-50"
                      style={{
                        boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
                      }}
                    >
                      <span
                        className="absolute bottom-3 left-0 top-3 w-1 rounded-r-full"
                        style={{ background: noteStyle.accent }}
                      />
                      <div className="relative mt-0.5 flex-shrink-0 pl-1">
                        <Avatar
                          src={note.user_avatar_url}
                          name={note.user_name}
                          size={40}
                          className="border"
                          style={{ borderColor: '#E2E8F0' }}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-bold text-slate-950">{note.user_name}</span>
                          <span className="text-xs font-medium text-slate-500">
                            Inserted {formatEasternDateTime(note.created_at, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} New York time
                          </span>
                          <span className="text-xs font-medium text-slate-500">added a note</span>
                          <span
                            className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wide"
                            style={{ background: noteStyle.bg, color: noteStyle.color, borderColor: noteStyle.border }}
                          >
                            {noteStyle.label}
                          </span>
                          <span
                            className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-black"
                            style={{ background: statusStyle.bg, color: statusStyle.color, borderColor: statusStyle.border }}
                          >
                            {statusStyle.label}
                          </span>
                        </div>
                        <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                          {note.note}
                        </p>
                        {note.project_address && (
                          <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-2">
                            <MapPin className="h-3.5 w-3.5 flex-shrink-0 text-slate-400" />
                            <p className="truncate text-xs font-semibold text-slate-500">{note.project_address}</p>
                          </div>
                        )}
                      </div>
                      <div className="flex flex-shrink-0 flex-col items-end gap-1 text-right">
                        <span className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600 ring-1 ring-slate-200">
                          {formatEasternRelative(note.created_at)}
                        </span>
                        <span className="hidden text-[10px] font-semibold uppercase tracking-wide text-slate-400 sm:inline">
                          Open project
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between py-2">
          <p className="text-xs text-gray-400">© 2026 New Urban Development · BuildTrack Platform</p>
          <p className="text-xs text-gray-400">Last updated: {formatEasternTime(now.toISOString())} New York time</p>
        </div>
      </div>

      <Modal
        isOpen={showFieldWatchReminder && !!fieldWatch && fieldWatchTotal > 0}
        onClose={closeFieldWatchReminder}
        title="Field Work Needs Review"
        description="Review field notes, pictures, scheduled tasks, and payment holds before invoices are approved."
        size="xl"
      >
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-4">
            {[
              { label: 'Field evidence', value: (fieldWatch?.counts.field_notes || 0) + (fieldWatch?.counts.field_photos || 0), tone: 'bg-blue-50 text-blue-700 ring-blue-200' },
              { label: 'Scheduled tasks', value: fieldWatch?.counts.scheduled_tasks || 0, tone: 'bg-amber-50 text-amber-800 ring-amber-200' },
              { label: 'Needs approval', value: fieldWatch?.counts.approvals_needed || 0, tone: 'bg-purple-50 text-purple-700 ring-purple-200' },
              { label: 'Payment holds', value: fieldWatch?.counts.invoice_holds || 0, tone: 'bg-red-50 text-red-700 ring-red-200' },
            ].map(card => (
              <div key={card.label} className={`rounded-sm px-3 py-3 ring-1 ${card.tone}`}>
                <p className="text-2xl font-black leading-none">{card.value}</p>
                <p className="mt-1 text-xs font-black uppercase tracking-wide">{card.label}</p>
              </div>
            ))}
          </div>

          {fieldWatch?.tasks?.length ? (
            <div>
              <h3 className="mb-2 text-sm font-black text-slate-950">Work status requiring attention</h3>
              <div className="max-h-72 divide-y divide-slate-200 overflow-y-auto rounded-sm border border-slate-200">
                {fieldWatch.tasks.slice(0, 12).map(task => (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => { closeFieldWatchReminder(); navigate(`/projects/${task.project_id}#construction-plan`); }}
                    className="flex w-full items-start gap-3 bg-white px-3 py-3 text-left hover:bg-slate-50"
                  >
                    <span className={`mt-1 h-2.5 w-2.5 flex-shrink-0 rounded-full ${task.alert_level === 'critical' ? 'bg-red-500' : task.alert_level === 'attention' ? 'bg-amber-500' : 'bg-slate-400'}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-black text-slate-950">{task.title}</span>
                      <span className="block truncate text-xs font-semibold text-slate-500">{task.project_address}</span>
                            <span className="mt-1 block text-xs text-slate-600">
                              Status: {task.status.replace(/_/g, ' ')} · Verification: {task.verification_status.replace(/_/g, ' ')} · Invoice: {task.invoice_status.replace(/_/g, ' ')}
                            </span>
                            {task.latest_photo_note && (
                              <span className="mt-1 block line-clamp-2 text-xs font-semibold text-slate-700">
                                Photo note: {task.latest_photo_note}
                              </span>
                            )}
                          </span>
                    <ChevronRight className="mt-2 h-4 w-4 text-slate-400" />
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {fieldWatch?.invoice_holds?.length ? (
            <div className="rounded-sm border border-red-200 bg-red-50 px-4 py-3">
              <h3 className="text-sm font-black text-red-800">Invoices blocked by unapproved field work</h3>
              <div className="mt-2 space-y-2">
                {fieldWatch.invoice_holds.slice(0, 5).map(invoice => (
                  <button
                    key={invoice.id}
                    type="button"
                    onClick={() => { closeFieldWatchReminder(); navigate(`/projects/${invoice.project_id}/invoices/${invoice.id}`); }}
                    className="flex w-full items-center justify-between gap-3 rounded-sm bg-white px-3 py-2 text-left ring-1 ring-red-100 hover:ring-red-300"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-black text-slate-950">{invoice.invoice_number} · {invoice.contractor_name}</span>
                      <span className="block truncate text-xs font-semibold text-slate-500">{invoice.project_address}</span>
                    </span>
                    <span className="text-sm font-black text-red-700">{formatMoney(invoice.total)}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={closeFieldWatchReminder}
              className="bt-btn bt-btn-secondary"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={() => {
                const projectId = fieldWatch?.tasks?.[0]?.project_id || fieldWatch?.invoice_holds?.[0]?.project_id || fieldWatch?.field_notes?.[0]?.project_id;
                closeFieldWatchReminder();
                navigate(projectId ? `/projects/${projectId}#construction-plan` : '/projects');
              }}
              className="bt-btn bt-btn-primary"
            >
              Open first field item
            </button>
          </div>
        </div>
      </Modal>

      <RecentActivityModal userId={user?.id} />

      {showReviewSummary && reviewSummaries.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/45 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-3xl max-h-[82vh] overflow-hidden rounded-2xl shadow-2xl"
            style={{ background: 'var(--bt-surface)', border: '1px solid var(--bt-border-strong)' }}
          >
            <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-gray-100">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: '#FEF3C7' }}>
                  <Bell className="w-5 h-5" style={{ color: '#D97706' }} />
                </div>
                <div>
                  <h2 className="text-lg font-black text-gray-900">New information to review</h2>
                  <p className="text-sm text-gray-500 mt-0.5">
                    {reviewSummaryTotal} update{reviewSummaryTotal !== 1 ? 's' : ''} across {reviewSummaries.length} project{reviewSummaries.length !== 1 ? 's' : ''} since your last review.
                  </p>
                </div>
              </div>
              <button
                onClick={closeReviewSummary}
                className="p-2 rounded-xl text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                aria-label="Close review summary"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto max-h-[58vh] divide-y divide-gray-100">
              {reviewSummaries.map((project) => (
                <div key={project.project_id} className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-black text-gray-900 truncate">{project.project_address}</p>
                      <p className="text-sm text-gray-500 truncate">{project.project_job_name}</p>
                    </div>
                    <span className="px-2.5 py-1 rounded-full text-xs font-black whitespace-nowrap" style={{ background: '#FEF3C7', color: '#92400E' }}>
                      {project.change_count} new
                    </span>
                  </div>

                  <div className="mt-4 space-y-2.5">
                    {project.changes.map((change) => (
                      <div key={change.id} className="flex items-start gap-3">
                        <span className="w-2 h-2 rounded-full mt-2 flex-shrink-0" style={{ background: '#D99D26' }} />
                        <div className="min-w-0">
                          <p className="text-sm text-gray-800">
                            <span className="font-bold">{change.user_name}</span> {change.summary}
                          </p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {formatEasternRelative(change.created_at)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>

                  <Link
                    to={`/projects/${project.project_id}`}
                    onClick={closeReviewSummary}
                    className="inline-flex items-center gap-2 mt-4 text-sm font-bold"
                    style={{ color: '#2563EB' }}
                  >
                    Open project
                    <ChevronRight className="w-4 h-4" />
                  </Link>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
