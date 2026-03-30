import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore, isAdminRole, roleLabels } from '../store/authStore';
import api from '../lib/api';
import { Loading, StatusBadge } from '../components/ui';
import {
  FolderOpen, ClipboardList, FileText, Image,
  TrendingUp, AlertTriangle, CheckCircle2, Clock,
  ArrowUpRight, Plus, ChevronRight, MapPin, Activity,
  Smartphone
} from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';

interface Stats {
  total_projects: number;
  active_projects: number;
  in_progress_projects: number;
  completed_projects: number;
  open_punch_items: number;
  pending_invoices: number;
  recent_photos: number;
}

interface Project {
  id: string;
  address: string;
  job_name: string;
  status: string;
  project_stage: string;
  open_punch_items: number;
  assigned_count: number;
  updated_at: string;
  budget: number;
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

const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
};

const stageColor: Record<string, string> = {
  acquisition: '#8B5CF6',
  planning: '#3B82F6',
  demo: '#EF4444',
  framing: '#F59E0B',
  rough_ins: '#F97316',
  drywall: '#10B981',
  finishes: '#06B6D4',
  punch_out: '#D99D26',
  final: '#22C55E',
  complete: '#6B7280',
};

export default function Dashboard() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [stats, setStats] = useState<Stats | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [projRes, allProjRes, invRes] = await Promise.all([
          api.get('/projects?status=active'),
          api.get('/projects'),
          api.get('/invoices'),
        ]);
        setProjects(projRes.data.slice(0, 6));
        setAllProjects(allProjRes.data);
        setInvoices(invRes.data.slice(0, 5));

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
  }, [user]);

  if (loading) return <Loading />;

  const firstName = user?.name?.split(' ')[0] || 'there';
  const now = new Date();

  // Derive stats from data if API stats not available
  const totalProjects = stats?.total_projects ?? allProjects.length;
  const openPunchItems = stats?.open_punch_items ?? projects.reduce((s, p) => s + (p.open_punch_items || 0), 0);
  const pendingInvoices = stats?.pending_invoices ?? invoices.filter(i => i.status === 'pending' || i.status === 'draft').length;
  const recentPhotos = stats?.recent_photos ?? 0;

  const kpiCards = [
    {
      label: 'Total Projects',
      value: totalProjects,
      sub: `${stats?.active_projects ?? projects.length} active`,
      icon: FolderOpen,
      gradient: 'linear-gradient(135deg, #1E3A5F 0%, #2563EB 100%)',
      iconBg: 'rgba(255,255,255,0.15)',
      trend: '+2 this month',
      trendUp: true,
    },
    {
      label: 'Open Punch Items',
      value: openPunchItems,
      sub: 'Require attention',
      icon: ClipboardList,
      gradient: 'linear-gradient(135deg, #7C2D12 0%, #EA580C 100%)',
      iconBg: 'rgba(255,255,255,0.15)',
      trend: openPunchItems > 0 ? 'Action needed' : 'All clear',
      trendUp: openPunchItems === 0,
    },
    {
      label: 'Pending Invoices',
      value: pendingInvoices,
      sub: 'Awaiting approval',
      icon: FileText,
      gradient: 'linear-gradient(135deg, #4A1D96 0%, #7C3AED 100%)',
      iconBg: 'rgba(255,255,255,0.15)',
      trend: pendingInvoices > 0 ? 'Review required' : 'Up to date',
      trendUp: pendingInvoices === 0,
    },
    {
      label: 'Photos This Week',
      value: recentPhotos,
      sub: 'Field documentation',
      icon: Image,
      gradient: 'linear-gradient(135deg, #064E3B 0%, #059669 100%)',
      iconBg: 'rgba(255,255,255,0.15)',
      trend: 'Updated today',
      trendUp: true,
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
              to="/mobile"
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all"
              style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: 'rgba(255,255,255,0.7)',
              }}
            >
              <Smartphone className="w-4 h-4" />
              Mobile View
            </Link>
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
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {kpiCards.map(card => (
            <div
              key={card.label}
              className="rounded-2xl p-5 relative overflow-hidden"
              style={{
                background: card.gradient,
                boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
              }}
            >
              {/* Background decoration */}
              <div
                className="absolute top-0 right-0 w-32 h-32 rounded-full opacity-10"
                style={{ background: 'white', transform: 'translate(30%, -30%)' }}
              />
              <div className="relative z-10">
                <div className="flex items-start justify-between mb-4">
                  <div
                    className="w-11 h-11 rounded-xl flex items-center justify-center"
                    style={{ background: card.iconBg }}
                  >
                    <card.icon className="w-5 h-5 text-white" />
                  </div>
                  <span
                    className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full"
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
                <p className="text-4xl font-black text-white mb-1">{card.value}</p>
                <p className="text-sm font-bold text-white opacity-90">{card.label}</p>
                <p className="text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.55)' }}>{card.sub}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Main content grid */}
        <div className="grid xl:grid-cols-3 gap-6">
          {/* Active Projects Table — takes 2/3 */}
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
                  style={{ background: 'rgba(37,99,235,0.1)' }}
                >
                  <FolderOpen className="w-4 h-4" style={{ color: '#2563EB' }} />
                </div>
                <div>
                  <h2 className="font-bold text-gray-900 text-sm">Active Projects</h2>
                  <p className="text-xs text-gray-400">{projects.length} projects in progress</p>
                </div>
              </div>
              <Link
                to="/projects"
                className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg transition-all"
                style={{ color: '#2563EB', background: 'rgba(37,99,235,0.08)' }}
              >
                View All <ArrowUpRight className="w-3.5 h-3.5" />
              </Link>
            </div>

            {projects.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 px-6">
                <div
                  className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
                  style={{ background: '#F3F4F6' }}
                >
                  <FolderOpen className="w-7 h-7 text-gray-300" />
                </div>
                <p className="font-semibold text-gray-500 text-sm">No active projects</p>
                <p className="text-xs text-gray-400 mt-1">Create your first project to get started</p>
                <Link
                  to="/projects"
                  className="mt-4 px-4 py-2 rounded-xl text-sm font-bold text-white"
                  style={{ background: 'linear-gradient(135deg, #D99D26, #C4891F)' }}
                >
                  + New Project
                </Link>
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {projects.map((p, i) => (
                  <Link
                    key={p.id}
                    to={`/projects/${p.id}`}
                    className="flex items-center gap-4 px-6 py-4 hover:bg-gray-50 transition-colors group"
                  >
                    {/* Index number */}
                    <div
                      className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-black flex-shrink-0"
                      style={{ background: '#F3F4F6', color: '#9CA3AF' }}
                    >
                      {i + 1}
                    </div>

                    {/* Address + job name */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <MapPin className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#D99D26' }} />
                        <p className="text-sm font-bold text-gray-900 truncate">{p.address}</p>
                      </div>
                      <p className="text-xs text-gray-500 truncate pl-5">{p.job_name}</p>
                    </div>

                    {/* Stage pill */}
                    {p.project_stage && (
                      <span
                        className="hidden sm:inline-flex px-2.5 py-1 rounded-full text-xs font-bold flex-shrink-0 text-white"
                        style={{ background: stageColor[p.project_stage] || '#6B7280' }}
                      >
                        {p.project_stage.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                      </span>
                    )}

                    {/* Punch items */}
                    {p.open_punch_items > 0 && (
                      <span
                        className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold flex-shrink-0"
                        style={{ background: 'rgba(234,88,12,0.1)', color: '#EA580C' }}
                      >
                        <AlertTriangle className="w-3 h-3" />
                        {p.open_punch_items}
                      </span>
                    )}

                    {/* Status */}
                    <StatusBadge status={p.status} />

                    <ChevronRight className="w-4 h-4 text-gray-300 group-hover:text-gray-500 transition-colors flex-shrink-0" />
                  </Link>
                ))}
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
                  { to: '/projects', label: 'New Project', icon: FolderOpen, color: '#2563EB', bg: 'rgba(37,99,235,0.08)' },
                  { to: '/punch-list', label: 'Punch List', icon: ClipboardList, color: '#EA580C', bg: 'rgba(234,88,12,0.08)' },
                  { to: '/photos', label: 'Photos', icon: Image, color: '#059669', bg: 'rgba(5,150,105,0.08)' },
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
                      <p className="text-sm font-bold text-gray-900">#{inv.invoice_number}</p>
                      <p className="text-xs text-gray-400 truncate">{inv.address || inv.contractor_name}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-black text-gray-900">${inv.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                      <StatusBadge status={inv.status} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Project Stage Breakdown */}
            {allProjects.length > 0 && (
              <div
                className="rounded-2xl p-5"
                style={{ background: 'white', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}
              >
                <h3 className="font-bold text-gray-900 text-sm mb-4">Projects by Stage</h3>
                <div className="space-y-2.5">
                  {Object.entries(
                    allProjects.reduce((acc: Record<string, number>, p) => {
                      const stage = p.project_stage || 'planning';
                      acc[stage] = (acc[stage] || 0) + 1;
                      return acc;
                    }, {})
                  ).slice(0, 5).map(([stage, count]) => (
                    <div key={stage} className="flex items-center gap-3">
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ background: stageColor[stage] || '#6B7280' }}
                      />
                      <span className="flex-1 text-xs font-medium text-gray-600 capitalize">
                        {stage.replace('_', ' ')}
                      </span>
                      <div className="flex items-center gap-2">
                        <div
                          className="h-1.5 rounded-full"
                          style={{
                            width: `${Math.max(20, (count / allProjects.length) * 80)}px`,
                            background: stageColor[stage] || '#6B7280',
                            opacity: 0.6,
                          }}
                        />
                        <span className="text-xs font-bold text-gray-900 w-4 text-right">{count}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between py-2">
          <p className="text-xs text-gray-400">© 2026 New Urban Development · BuildTrack Platform</p>
          <p className="text-xs text-gray-400">Last updated: {format(now, 'h:mm a')}</p>
        </div>
      </div>
    </div>
  );
}
