import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore, roleLabels } from '../store/authStore';
import api from '../lib/api';
import toast from 'react-hot-toast';
import {
  MapPin, ClipboardList, FileText, ChevronRight,
  LogOut, AlertTriangle, CheckCircle2, Clock,
  Search, FolderOpen, RefreshCw, Plus,
} from 'lucide-react';

interface Project {
  id: string;
  address: string;
  job_name?: string;
  status: string;
  project_stage?: string;
  open_punch_items?: number;
}

interface PunchSummary {
  project_id: string;
  address: string;
  job_name?: string;
  total: number;
  open: number;
  completed: number;
  in_progress: number;
}

const stageLabel: Record<string, string> = {
  acquisition: 'Acquisition', planning: 'Planning', demo: 'Demo',
  framing: 'Framing', rough_ins: 'Rough-Ins', drywall: 'Drywall',
  finishes: 'Finishes', punch_out: 'Punch-Out', final: 'Final', complete: 'Complete',
};

const stageColor: Record<string, string> = {
  acquisition: '#8B5CF6', planning: '#3B82F6', demo: '#EF4444',
  framing: '#F59E0B', rough_ins: '#F97316', drywall: '#10B981',
  finishes: '#06B6D4', punch_out: '#D99D26', final: '#22C55E', complete: '#6B7280',
};

type Tab = 'projects' | 'punchlists' | 'invoices';

const NAV_ITEMS: { key: Tab; label: string; Icon: any; color: string }[] = [
  { key: 'projects',   label: 'Projects',   Icon: FolderOpen,    color: '#2563EB' },
  { key: 'punchlists', label: 'Punch List',  Icon: ClipboardList, color: '#EA580C' },
  { key: 'invoices',   label: 'Invoice',     Icon: FileText,      color: '#7C3AED' },
];

export default function MobileHome() {
  const [tab, setTab] = useState<Tab>('projects');
  const [projects, setProjects] = useState<Project[]>([]);
  const [punchSummaries, setPunchSummaries] = useState<PunchSummary[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    try {
      const projRes = await api.get('/projects');
      const projs: Project[] = projRes.data;
      setProjects(projs);

      const summaries: PunchSummary[] = [];
      await Promise.all(
        projs.map(async (p) => {
          try {
            const res = await api.get(`/projects/${p.id}/punch-list`);
            const items = res.data;
            if (items.length > 0) {
              summaries.push({
                project_id: p.id,
                address: p.address,
                job_name: p.job_name,
                total: items.length,
                open: items.filter((i: any) => i.status === 'not_started' || i.status === 'open').length,
                completed: items.filter((i: any) => i.status === 'completed').length,
                in_progress: items.filter((i: any) => i.status === 'in_progress').length,
              });
            }
          } catch {}
        })
      );
      setPunchSummaries(summaries);
    } catch {
      toast.error('Failed to load data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => {
    const interval = setInterval(() => loadData(true), 20000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleLogout = () => { logout(); navigate('/login'); };

  const filteredProjects = projects.filter(p =>
    p.address.toLowerCase().includes(search.toLowerCase()) ||
    (p.job_name || '').toLowerCase().includes(search.toLowerCase())
  );
  const filteredPunch = punchSummaries.filter(s =>
    s.address.toLowerCase().includes(search.toLowerCase()) ||
    (s.job_name || '').toLowerCase().includes(search.toLowerCase())
  );

  if (loading) {
    return (
      <div className="mobile-shell" style={{ background: '#0D1117', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{
          width: 56, height: 56, borderRadius: 16,
          background: 'linear-gradient(135deg, #D99D26, #C4891F)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginBottom: 20, boxShadow: '0 8px 24px rgba(217,157,38,0.4)',
        }}>
          <MapPin size={28} color="white" />
        </div>
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          border: '3px solid rgba(217,157,38,0.2)',
          borderTopColor: '#D99D26',
          animation: 'spin 0.8s linear infinite',
        }} />
        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, marginTop: 14, fontWeight: 500 }}>Loading BuildTrack...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div className="mobile-shell">
      {/* ── Fixed Header ── */}
      <div className="mobile-header" style={{ background: 'linear-gradient(135deg, #0D1117 0%, #181D25 100%)' }}>
        {/* Top bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 38, height: 38, borderRadius: 12,
              background: 'linear-gradient(135deg, #D99D26, #C4891F)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 4px 12px rgba(217,157,38,0.35)',
              flexShrink: 0,
            }}>
              <MapPin size={18} color="white" />
            </div>
            <div>
              <p style={{ color: 'white', fontWeight: 800, fontSize: 15, lineHeight: 1.2, margin: 0 }}>BuildTrack</p>
              <p style={{ color: '#D99D26', fontSize: 11, fontWeight: 600, margin: 0 }}>
                {user?.name?.split(' ')[0]} · {roleLabels[user?.role || '']}
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {refreshing && <RefreshCw size={15} color="rgba(255,255,255,0.4)" style={{ animation: 'spin 0.8s linear infinite' }} />}
            <button
              onClick={handleLogout}
              style={{
                width: 36, height: 36, borderRadius: 10,
                background: 'rgba(255,255,255,0.08)',
                border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <LogOut size={16} color="rgba(255,255,255,0.7)" />
            </button>
          </div>
        </div>

        {/* Search */}
        <div style={{ padding: '0 16px 12px' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: 'rgba(255,255,255,0.08)',
            borderRadius: 14, padding: '10px 14px',
          }}>
            <Search size={15} color="rgba(255,255,255,0.4)" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search projects or addresses..."
              style={{
                flex: 1, background: 'transparent', border: 'none', outline: 'none',
                color: 'white', fontSize: 14, fontFamily: 'inherit',
              }}
            />
          </div>
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          {NAV_ITEMS.map(item => {
            const active = tab === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                style={{
                  flex: 1, display: 'flex', flexDirection: 'column',
                  alignItems: 'center', gap: 4, padding: '10px 4px',
                  background: 'none', border: 'none', cursor: 'pointer',
                  borderBottom: active ? `2px solid ${item.color}` : '2px solid transparent',
                  color: active ? item.color : 'rgba(255,255,255,0.45)',
                  transition: 'color 0.15s',
                }}
              >
                <item.Icon size={18} />
                <span style={{ fontSize: 11, fontWeight: 700 }}>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Scrollable Content ── */}
      <div className="mobile-content" style={{ padding: '12px 14px 16px' }}>

        {/* ══ PROJECTS ══ */}
        {tab === 'projects' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '4px 2px 0' }}>
              {filteredProjects.length} Project{filteredProjects.length !== 1 ? 's' : ''}
            </p>

            {filteredProjects.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 20px', gap: 8 }}>
                <FolderOpen size={44} color="#D1D5DB" />
                <p style={{ color: '#9CA3AF', fontWeight: 600, fontSize: 14, margin: 0 }}>No projects found</p>
              </div>
            ) : (
              filteredProjects.map(p => (
                <div key={p.id} style={{ background: 'white', borderRadius: 18, overflow: 'hidden', boxShadow: '0 2px 12px rgba(0,0,0,0.07)' }}>
                  {/* Project info */}
                  <div style={{ padding: '14px 14px 10px' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                      <div style={{
                        width: 38, height: 38, borderRadius: 10,
                        background: 'rgba(217,157,38,0.1)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                      }}>
                        <MapPin size={18} color="#D99D26" />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontWeight: 700, fontSize: 13, color: '#111827', margin: 0, lineHeight: 1.3 }}>{p.address}</p>
                        {p.job_name && <p style={{ fontSize: 11, color: '#9CA3AF', margin: '2px 0 0' }}>{p.job_name}</p>}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                          {p.project_stage && (
                            <span style={{
                              background: stageColor[p.project_stage] || '#6B7280',
                              color: 'white', borderRadius: 20, padding: '3px 10px',
                              fontSize: 11, fontWeight: 700,
                            }}>
                              {stageLabel[p.project_stage] || p.project_stage}
                            </span>
                          )}
                          {(p.open_punch_items || 0) > 0 && (
                            <span style={{
                              background: 'rgba(234,88,12,0.1)', color: '#EA580C',
                              borderRadius: 20, padding: '3px 10px',
                              fontSize: 11, fontWeight: 700,
                              display: 'flex', alignItems: 'center', gap: 4,
                            }}>
                              <AlertTriangle size={10} /> {p.open_punch_items} open
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 3 action buttons */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', borderTop: '1px solid #F3F4F6' }}>
                    {[
                      { label: 'Punch List', icon: ClipboardList, color: '#EA580C', path: `/mobile/project/${p.id}/punch-list` },
                      { label: 'Invoice',    icon: FileText,      color: '#7C3AED', path: `/mobile/project/${p.id}/invoice`, border: true },
                      { label: 'Details',    icon: FolderOpen,    color: '#2563EB', path: `/mobile/project/${p.id}` },
                    ].map(btn => {
                      const BtnIcon = btn.icon;
                      return (
                        <button
                          key={btn.label}
                          onClick={() => navigate(btn.path)}
                          style={{
                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                            padding: '12px 4px', background: 'none', border: 'none', cursor: 'pointer',
                            borderLeft: (btn as any).border ? '1px solid #F3F4F6' : 'none',
                            borderRight: (btn as any).border ? '1px solid #F3F4F6' : 'none',
                            transition: 'background 0.1s',
                          }}
                          onTouchStart={e => (e.currentTarget.style.background = '#F9FAFB')}
                          onTouchEnd={e => (e.currentTarget.style.background = 'none')}
                        >
                          <BtnIcon size={18} color={btn.color} />
                          <span style={{ fontSize: 11, fontWeight: 700, color: '#4B5563' }}>{btn.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* ══ PUNCH LISTS ══ */}
        {tab === 'punchlists' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '4px 2px 0' }}>
              {filteredPunch.length} Punch List{filteredPunch.length !== 1 ? 's' : ''}
            </p>

            {filteredPunch.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '60px 20px', gap: 10 }}>
                <ClipboardList size={44} color="#D1D5DB" />
                <p style={{ color: '#9CA3AF', fontWeight: 600, fontSize: 14, margin: 0 }}>No punch lists yet</p>
                <p style={{ color: '#D1D5DB', fontSize: 12, margin: 0, textAlign: 'center' }}>Open a project and tap Punch List to get started</p>
                <button
                  onClick={() => setTab('projects')}
                  style={{
                    marginTop: 8, background: 'linear-gradient(135deg, #D99D26, #C4891F)',
                    color: 'white', border: 'none', borderRadius: 12,
                    padding: '10px 20px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}
                >
                  <FolderOpen size={15} /> Go to Projects
                </button>
              </div>
            ) : (
              filteredPunch.map(s => {
                const pct = s.total > 0 ? Math.round((s.completed / s.total) * 100) : 0;
                return (
                  <button
                    key={s.project_id}
                    onClick={() => navigate(`/mobile/project/${s.project_id}/punch-list`)}
                    style={{
                      background: 'white', borderRadius: 18, overflow: 'hidden',
                      boxShadow: '0 2px 12px rgba(0,0,0,0.07)',
                      border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left',
                      transition: 'transform 0.1s',
                    }}
                    onTouchStart={e => (e.currentTarget.style.transform = 'scale(0.99)')}
                    onTouchEnd={e => (e.currentTarget.style.transform = 'scale(1)')}
                  >
                    {/* Progress bar */}
                    <div style={{ height: 4, background: '#F3F4F6' }}>
                      <div style={{
                        height: '100%', width: `${pct}%`,
                        background: pct === 100 ? 'linear-gradient(90deg,#22C55E,#16A34A)' : 'linear-gradient(90deg,#D99D26,#C4891F)',
                        transition: 'width 0.5s ease',
                      }} />
                    </div>
                    <div style={{ padding: '14px' }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                        <div style={{
                          width: 38, height: 38, borderRadius: 10, flexShrink: 0,
                          background: pct === 100 ? 'rgba(34,197,94,0.1)' : 'rgba(234,88,12,0.1)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          {pct === 100
                            ? <CheckCircle2 size={18} color="#22C55E" />
                            : <ClipboardList size={18} color="#EA580C" />
                          }
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ fontWeight: 700, fontSize: 13, color: '#111827', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.address}</p>
                          {s.job_name && <p style={{ fontSize: 11, color: '#9CA3AF', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.job_name}</p>}
                          <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 11, fontWeight: 600, color: '#EA580C', display: 'flex', alignItems: 'center', gap: 3 }}>
                              <Clock size={11} /> {s.open} open
                            </span>
                            <span style={{ fontSize: 11, fontWeight: 600, color: '#3B82F6', display: 'flex', alignItems: 'center', gap: 3 }}>
                              <RefreshCw size={11} /> {s.in_progress} active
                            </span>
                            <span style={{ fontSize: 11, fontWeight: 600, color: '#22C55E', display: 'flex', alignItems: 'center', gap: 3 }}>
                              <CheckCircle2 size={11} /> {s.completed} done
                            </span>
                          </div>
                        </div>
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <p style={{ fontSize: 20, fontWeight: 900, color: pct === 100 ? '#22C55E' : '#D99D26', margin: 0 }}>{pct}%</p>
                          <p style={{ fontSize: 11, color: '#9CA3AF', margin: 0 }}>{s.total} items</p>
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 14px', borderTop: '1px solid #F3F4F6', background: '#FAFAFA' }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: '#9CA3AF' }}>Tap to open punch list</span>
                      <ChevronRight size={14} color="#9CA3AF" />
                    </div>
                  </button>
                );
              })
            )}
          </div>
        )}

        {/* ══ INVOICES ══ */}
        {tab === 'invoices' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '4px 2px 0' }}>
              Select a Project to Invoice
            </p>

            {projects.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '60px 20px', gap: 8 }}>
                <FileText size={44} color="#D1D5DB" />
                <p style={{ color: '#9CA3AF', fontWeight: 600, fontSize: 14, margin: 0 }}>No projects available</p>
              </div>
            ) : (
              projects
                .filter(p =>
                  p.address.toLowerCase().includes(search.toLowerCase()) ||
                  (p.job_name || '').toLowerCase().includes(search.toLowerCase())
                )
                .map(p => (
                  <button
                    key={p.id}
                    onClick={() => navigate(`/mobile/project/${p.id}/invoice`)}
                    style={{
                      background: 'white', borderRadius: 18, overflow: 'hidden',
                      boxShadow: '0 2px 12px rgba(0,0,0,0.07)',
                      border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left',
                      transition: 'transform 0.1s',
                    }}
                    onTouchStart={e => (e.currentTarget.style.transform = 'scale(0.99)')}
                    onTouchEnd={e => (e.currentTarget.style.transform = 'scale(1)')}
                  >
                    <div style={{ padding: '14px', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{
                        width: 38, height: 38, borderRadius: 10, flexShrink: 0,
                        background: 'rgba(124,58,237,0.1)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <FileText size={18} color="#7C3AED" />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontWeight: 700, fontSize: 13, color: '#111827', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.address}</p>
                        {p.job_name && <p style={{ fontSize: 11, color: '#9CA3AF', margin: '2px 0 0' }}>{p.job_name}</p>}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                        <span style={{
                          background: 'linear-gradient(135deg,#7C3AED,#6D28D9)',
                          color: 'white', borderRadius: 10, padding: '6px 12px',
                          fontSize: 12, fontWeight: 700,
                          display: 'flex', alignItems: 'center', gap: 4,
                        }}>
                          <Plus size={12} /> Invoice
                        </span>
                        <ChevronRight size={14} color="#9CA3AF" />
                      </div>
                    </div>
                  </button>
                ))
            )}
          </div>
        )}
      </div>

      {/* ── Fixed Bottom Nav ── */}
      <div className="mobile-bottom-nav" style={{ background: 'white', borderTop: '1px solid #E5E7EB', boxShadow: '0 -4px 20px rgba(0,0,0,0.08)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr' }}>
          {NAV_ITEMS.map(item => {
            const active = tab === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                  padding: '10px 4px 8px', background: 'none', border: 'none', cursor: 'pointer',
                  color: active ? item.color : '#9CA3AF',
                  position: 'relative', transition: 'color 0.15s',
                }}
              >
                {active && (
                  <div style={{
                    position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)',
                    width: 32, height: 3, borderRadius: '0 0 3px 3px', background: item.color,
                  }} />
                )}
                <item.Icon size={20} />
                <span style={{ fontSize: 10, fontWeight: 700 }}>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
