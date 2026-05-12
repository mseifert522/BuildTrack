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
import { formatDistanceToNow, format } from 'date-fns';

interface Stats {
  total_projects: number;
  under_construction: number;
  completed_projects: number;
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
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
};

const parseDate = (value: string) => {
  if (!value) return new Date();
  return new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
};

const getInitials = (name?: string) =>
  (name || '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase())
    .join('') || '?';


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

  const closeReviewSummary = () => {
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

  const kpiCards = [
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
              {format(now, "EEEE, MMMM d, yyyy")} · {roleLabels[user?.role || '']}
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
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {kpiCards.map(card => (
            <div
              key={card.label}
              className="rounded-xl p-3.5 relative overflow-hidden cursor-pointer transition-all hover:scale-[1.03] active:scale-[0.98]"
              style={{
                background: card.gradient,
                boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
              }}
              onClick={() => navigate(card.filter === 'all_projects' ? '/projects' : `/projects?status=${card.filter}`)}
            >
              {/* Background decoration */}
              <div
                className="absolute top-0 right-0 w-24 h-24 rounded-full opacity-10"
                style={{ background: 'white', transform: 'translate(30%, -30%)' }}
              />
              <div className="relative z-10">
                <div className="flex items-start justify-between mb-4">
                  <div
                    className="w-9 h-9 rounded-lg flex items-center justify-center"
                    style={{ background: card.iconBg }}
                  >
                    <card.icon className="w-4 h-4 text-white" />
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
                <p className="text-2xl font-black text-white mb-0.5">{card.value}</p>
                <p className="text-xs font-bold text-white opacity-90">{card.label}</p>
                <p className="hidden sm:block text-[10px] mt-0.5" style={{ color: 'rgba(255,255,255,0.55)' }}>{card.sub}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Main content grid */}
        <div className="grid xl:grid-cols-3 gap-6">
          {/* Latest Notes Activity - takes 2/3 */}
          <div
            className="xl:col-span-2 rounded-2xl overflow-hidden"
            style={{ background: 'white', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}
          >
            <div
              className="flex items-center justify-between px-6 py-4"
              style={{ borderBottom: '1px solid #F3F4F6' }}
            >
              <div className="flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center"
                  style={{ background: 'rgba(124,58,237,0.1)' }}
                >
                  <MessageSquare className="w-4 h-4" style={{ color: '#7C3AED' }} />
                </div>
                <div>
                  <h2 className="font-bold text-gray-900 text-sm">Latest Notes Activity</h2>
                  <p className="text-xs text-gray-400">{recentNotes.length} notes across all projects</p>
                </div>
              </div>
            </div>

            {recentNotes.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 px-6">
                <div
                  className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
                  style={{ background: '#F3F4F6' }}
                >
                  <MessageSquare className="w-7 h-7 text-gray-300" />
                </div>
                <p className="font-semibold text-gray-500 text-sm">No notes yet</p>
                <p className="text-xs text-gray-400 mt-1">Project notes will appear here as they are added</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-50 max-h-[480px] overflow-y-auto">
                {recentNotes.map((note) => {
                  return (
                    <Link
                      key={note.id}
                      to={`/projects/${note.project_id}`}
                      className="flex items-start gap-3 px-6 py-3.5 hover:bg-gray-50 transition-colors"
                    >
                      {note.user_avatar_url ? (
                        <img
                          src={note.user_avatar_url}
                          alt={note.user_name}
                          className="w-8 h-8 rounded-lg object-cover flex-shrink-0 mt-0.5"
                          style={{ objectPosition: 'center top' }}
                        />
                      ) : (
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 text-xs font-black text-white"
                          style={{ background: 'linear-gradient(135deg, #D99D26, #C4891F)' }}
                        >
                          {getInitials(note.user_name)}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-900">
                          <span className="font-bold">{note.user_name}</span>{' '}
                          <span className="text-gray-500">added a note</span>
                        </p>
                        <p className="text-sm text-gray-700 mt-1 line-clamp-2 whitespace-pre-wrap">
                          {note.note}
                        </p>
                        {note.project_address && (
                          <p className="text-xs text-gray-400 truncate mt-0.5">
                            <MapPin className="w-3 h-3 inline mr-1" style={{ color: '#D99D26' }} />
                            {note.project_address}
                          </p>
                        )}
                      </div>
                      <span className="text-xs text-gray-400 flex-shrink-0 whitespace-nowrap mt-0.5">
                        {formatDistanceToNow(parseDate(note.created_at), { addSuffix: true })}
                      </span>
                    </Link>
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
                      <p className="text-xs text-gray-400">{format(new Date(inv.created_at), 'MMM d, yyyy')}</p>
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
          <p className="text-xs text-gray-400">Last updated: {format(now, 'h:mm a')}</p>
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
                            {formatDistanceToNow(parseDate(change.created_at), { addSuffix: true })}
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
