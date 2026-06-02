import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore, isAdminRole, roleLabels } from '../store/authStore';
import api from '../lib/api';
import { Loading, StatusBadge } from '../components/ui';
import {
  FolderOpen, ClipboardList, FileText, Image,
  TrendingUp, AlertTriangle, CheckCircle2, Clock,
  ArrowUpRight, Plus, ChevronRight, MapPin, MessageSquare, Camera,
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

const getInitials = (name?: string) =>
  (name || '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase())
    .join('') || '?';

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


export default function Dashboard() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [stats, setStats] = useState<Stats | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [recentNotes, setRecentNotes] = useState<RecentNote[]>([]);
  const [reviewSummaries, setReviewSummaries] = useState<ProjectReviewSummary[]>([]);
  const [showReviewSummary, setShowReviewSummary] = useState(false);
  const [reviewDismissKey, setReviewDismissKey] = useState('');
  const [reviewLoginKey, setReviewLoginKey] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const canShowReview = !!user && isAdminRole(user.role);
        const loginSummaryKey = user?.id ? `buildtrack-login-review-summary:${user.id}` : '';
        const forceLoginSummary = canShowReview && !!loginSummaryKey && sessionStorage.getItem(loginSummaryKey) === '1';
        const [projRes, allProjRes, invRes, notesRes, reviewRes] = await Promise.all([
          api.get('/projects?status=active_rehab'),
          api.get('/projects'),
          api.get('/invoices'),
          api.get('/notes/recent?limit=50').catch(() => ({ data: [] })),
          canShowReview
            ? api.get(`/projects/unreviewed-summary${forceLoginSummary ? '?scope=recent' : ''}`).catch(() => ({ data: { projects: [] } }))
            : Promise.resolve({ data: { projects: [] } }),
        ]);
        setProjects(projRes.data.slice(0, 6));
        setRecentNotes(notesRes.data.slice(0, 50));
        setAllProjects(allProjRes.data);
        setInvoices(invRes.data.slice(0, 5));

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

  // Lifecycle KPI counts
  const totalProjects = allProjects.length;
  const activeRehabs = allProjects.filter(p => p.status === 'active_rehab').length;
  const notStarted = allProjects.filter(p => p.status === 'not_started').length;
  const completedProjects = stats?.completed_projects ?? allProjects.filter(p =>
    p.status === 'rehab_completed' || p.status === 'completed' || p.lifecycle_status === 'completed'
  ).length;
  const longTermHoldings = stats?.long_term_holdings ?? allProjects.filter(p => p.status === 'long_term_holding').length;
  const commercialProjects = stats?.commercial_projects ?? allProjects.filter(p => p.status === 'commercial').length;

  const kpiCards = [
    {
      label: 'Total Projects',
      value: totalProjects,
      sub: 'All tracked projects',
      icon: FolderOpen,
      gradient: 'linear-gradient(135deg, #1E3A5F 0%, #2563EB 100%)',
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
      gradient: 'linear-gradient(135deg, #7C2D12 0%, #EA580C 100%)',
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
      gradient: 'linear-gradient(135deg, #065F46 0%, #059669 100%)',
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
      gradient: 'linear-gradient(135deg, #78350F 0%, #D97706 100%)',
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
      gradient: 'linear-gradient(135deg, #155E75 0%, #0891B2 100%)',
      iconBg: 'rgba(255,255,255,0.15)',
      trend: commercialProjects > 0 ? 'Commercial' : 'None listed',
      trendUp: commercialProjects > 0,
      filter: 'commercial',
    },
  ];

  return (
    <div style={{ background: '#F0F2F5', minHeight: '100%' }}>
      {/* Hero header bar */}
      <div
        className="px-6 py-6 md:px-8"
        style={{
          background: 'linear-gradient(135deg, #0D1117 0%, #181D25 60%, #1E2530 100%)',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <span
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest"
                style={{ background: 'rgba(217,157,38,0.15)', color: '#D99D26', border: '1px solid rgba(217,157,38,0.25)' }}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                Live Dashboard
              </span>
            </div>
            <h1 className="text-2xl md:text-3xl font-black text-white tracking-tight">
              {greeting()}, {firstName}
            </h1>
            <p className="text-sm mt-1" style={{ color: 'rgba(255,255,255,0.45)' }}>
              {formatEasternDate(now.toISOString(), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} - {roleLabels[user?.role || '']}
            </p>
          </div>
          <div className="hidden md:flex items-center gap-3">
            <Link
              to="/projects"
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition-all text-white"
              style={{ background: 'linear-gradient(135deg, #D99D26, #C4891F)', boxShadow: '0 4px 16px rgba(217,157,38,0.3)' }}
            >
              <Plus className="w-4 h-4" />
              New Project
            </Link>
          </div>
        </div>
      </div>

      <div className="px-6 py-6 md:px-8 max-w-7xl mx-auto space-y-6">
        {/* KPI Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-3">
          {kpiCards.map(card => (
            <div
              key={card.label}
              className="relative min-h-[88px] cursor-pointer overflow-hidden rounded-xl p-3 transition-all hover:-translate-y-0.5 active:scale-[0.99]"
              style={{
                background: card.gradient,
                boxShadow: '0 8px 22px rgba(15,23,42,0.14)',
              }}
              onClick={() => navigate(card.filter === 'all_projects' ? '/projects' : `/projects?status=${card.filter}`)}
            >
              {/* Background decoration */}
              <div
                className="absolute top-0 right-0 h-16 w-16 rounded-full opacity-10"
                style={{ background: 'white', transform: 'translate(28%, -34%)' }}
              />
              <div className="relative z-10">
                <div className="mb-2 flex items-start justify-between">
                  <div
                    className="flex h-8 w-8 items-center justify-center rounded-lg"
                    style={{ background: card.iconBg }}
                  >
                    <card.icon className="h-3.5 w-3.5 text-white" />
                  </div>
                  <span
                    className="hidden md:flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full"
                    style={{
                      background: 'rgba(255,255,255,0.15)',
                      color: 'rgba(255,255,255,0.9)',
                    }}
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
                  <p className="text-2xl font-black leading-none text-white">{card.value}</p>
                  <p className="pb-0.5 text-xs font-bold leading-tight text-white opacity-95">{card.label}</p>
                </div>
                <p className="hidden sm:block truncate text-[10px] mt-1" style={{ color: 'rgba(255,255,255,0.62)' }}>{card.sub}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Main content grid */}
        <div className="grid xl:grid-cols-3 gap-6">
          {/* Latest Notes Activity - takes 2/3 */}
          <div
            className="xl:col-span-2 overflow-hidden rounded-2xl border"
            style={{
              background: '#0F172A',
              borderColor: '#1F2A3D',
              boxShadow: '0 18px 42px rgba(15,23,42,0.22)',
            }}
          >
            <div
              className="flex items-center justify-between gap-4 px-6 py-4"
              style={{
                background: 'linear-gradient(135deg, #111827 0%, #172033 100%)',
                borderBottom: '1px solid rgba(148,163,184,0.22)',
              }}
            >
              <div className="flex items-center gap-3">
                <div
                  className="flex h-9 w-9 items-center justify-center rounded-xl border"
                  style={{ background: 'rgba(217,157,38,0.14)', borderColor: 'rgba(217,157,38,0.35)' }}
                >
                  <MessageSquare className="h-4 w-4" style={{ color: '#FBBF24' }} />
                </div>
                <div>
                  <h2 className="text-sm font-black text-white">Latest Notes Activity</h2>
                  <p className="text-xs font-semibold text-slate-400">{recentNotes.length} notes across all projects</p>
                </div>
              </div>
            </div>

            {recentNotes.length === 0 ? (
              <div className="flex min-h-[520px] flex-col items-center justify-center px-6 py-16">
                <div
                  className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border"
                  style={{ background: 'rgba(255,255,255,0.04)', borderColor: 'rgba(148,163,184,0.22)' }}
                >
                  <MessageSquare className="h-7 w-7 text-slate-500" />
                </div>
                <p className="text-sm font-bold text-slate-300">No notes yet</p>
                <p className="mt-1 text-xs text-slate-500">Project notes will appear here as they are added</p>
              </div>
            ) : (
              <div className="max-h-[660px] min-h-[560px] space-y-3 overflow-y-auto p-4">
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
                      className="group relative flex cursor-pointer items-start gap-4 rounded-xl border p-4 transition-all hover:-translate-y-0.5"
                      style={{
                        background: 'linear-gradient(135deg, rgba(15,23,42,0.96) 0%, rgba(30,41,59,0.88) 100%)',
                        borderColor: 'rgba(148,163,184,0.20)',
                        boxShadow: '0 10px 26px rgba(0,0,0,0.16)',
                      }}
                    >
                      <span
                        className="absolute bottom-3 left-0 top-3 w-1 rounded-r-full"
                        style={{ background: noteStyle.accent }}
                      />
                      <div className="relative mt-0.5 flex-shrink-0 pl-1">
                        {note.user_avatar_url ? (
                          <img
                            src={note.user_avatar_url}
                            alt={note.user_name}
                            className="h-10 w-10 rounded-xl border object-cover"
                            style={{ objectPosition: 'center top', borderColor: 'rgba(255,255,255,0.16)' }}
                          />
                        ) : (
                          <div
                            className="flex h-10 w-10 items-center justify-center rounded-xl text-xs font-black text-white"
                            style={{ background: 'linear-gradient(135deg, #D99D26, #C4891F)' }}
                          >
                            {getInitials(note.user_name)}
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-black text-white">{note.user_name}</span>
                          <span className="text-xs font-semibold text-slate-400">
                            Inserted {formatEasternDateTime(note.created_at, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} New York time
                          </span>
                          <span className="text-xs font-semibold text-slate-500">added a note</span>
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
                        <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-sm leading-6 text-slate-100">
                          {note.note}
                        </p>
                        {note.project_address && (
                          <div className="mt-3 flex items-center gap-2 border-t border-white/10 pt-2">
                            <MapPin className="h-3.5 w-3.5 flex-shrink-0" style={{ color: '#FBBF24' }} />
                            <p className="truncate text-xs font-semibold text-slate-400">{note.project_address}</p>
                          </div>
                        )}
                      </div>
                      <div className="flex flex-shrink-0 flex-col items-end gap-1 text-right">
                        <span className="rounded-full bg-slate-950/70 px-2.5 py-1 text-xs font-bold text-slate-300 ring-1 ring-white/10">
                          {formatEasternRelative(note.created_at)}
                        </span>
                        <span className="hidden text-[10px] font-semibold uppercase tracking-wide text-slate-500 sm:inline">
                          Open project
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right column */}
          <div className="space-y-5">
            {/* Quick Actions */}
            <div
              className="rounded-2xl p-5"
              style={{ background: 'white', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}
            >
              <h3 className="font-bold text-gray-900 text-sm mb-4">Quick Actions</h3>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { to: '/projects', label: 'Add Note', icon: MessageSquare, color: '#D97706', bg: 'rgba(217,119,6,0.08)' },
                  { to: '/projects', label: 'Punch List', icon: ClipboardList, color: '#EA580C', bg: 'rgba(234,88,12,0.08)' },
                  { to: '/photos', label: 'Upload Photos', icon: Camera, color: '#059669', bg: 'rgba(5,150,105,0.08)' },
                  { to: '/invoices', label: 'Invoices', icon: FileText, color: '#7C3AED', bg: 'rgba(124,58,237,0.08)' },
                ].map(a => (
                  <Link
                    key={a.to}
                    to={a.to}
                    className="flex flex-col items-center gap-2 p-4 rounded-xl transition-all hover:scale-105"
                    style={{ background: a.bg, border: `1px solid ${a.color}20` }}
                  >
                    <a.icon className="w-5 h-5" style={{ color: a.color }} />
                    <span className="text-xs font-bold" style={{ color: a.color }}>{a.label}</span>
                  </Link>
                ))}
              </div>
            </div>

            {/* Recent Invoices */}
            <div
              className="rounded-2xl overflow-hidden"
              style={{ background: 'white', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}
            >
              <div
                className="flex items-center justify-between px-5 py-4"
                style={{ borderBottom: '1px solid #F3F4F6' }}
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className="w-7 h-7 rounded-lg flex items-center justify-center"
                    style={{ background: 'rgba(124,58,237,0.1)' }}
                  >
                    <FileText className="w-3.5 h-3.5" style={{ color: '#7C3AED' }} />
                  </div>
                  <h3 className="font-bold text-gray-900 text-sm">Recent Invoices</h3>
                </div>
                <Link
                  to="/invoices"
                  className="text-xs font-bold"
                  style={{ color: '#7C3AED' }}
                >
                  View all
                </Link>
              </div>
              <div className="divide-y divide-gray-50">
                {invoices.length === 0 ? (
                  <p className="text-center text-gray-400 text-sm py-8">No invoices yet</p>
                ) : invoices.map(inv => (
                  <div key={inv.id} className="flex items-center gap-3 px-5 py-3.5">
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 text-white text-xs font-black"
                      style={{ background: 'linear-gradient(135deg, #7C3AED, #6D28D9)' }}
                    >
                      #
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-gray-900 truncate">{inv.contractor_name}</p>
                      <p className="text-xs text-gray-400">{formatEasternDate(inv.created_at, { month: 'short', day: 'numeric', year: 'numeric' })}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-black text-gray-900">${Number(inv.total).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between py-2">
          <p className="text-xs text-gray-400">© 2026 New Urban Development · BuildTrack Platform</p>
          <p className="text-xs text-gray-400">Last updated: {formatEasternTime(now.toISOString())} New York time</p>
        </div>
      </div>

      {showReviewSummary && reviewSummaries.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/45 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-3xl max-h-[82vh] overflow-hidden rounded-2xl shadow-2xl"
            style={{ background: 'white', border: '1px solid #E5E7EB' }}
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
