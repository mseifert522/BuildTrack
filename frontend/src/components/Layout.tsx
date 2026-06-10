import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore, roleLabels, canManageUsers, canAccessSettings, canAccessSecurity } from '../store/authStore';
import {
  LayoutDashboard, FolderOpen, ClipboardList, FileText,
  Users, Settings, LogOut, Menu, X, Bell, ChevronRight,
  Camera, Search, Trash2, Truck, ShieldCheck, MessageSquare,
  ArrowLeft
} from 'lucide-react';
import api from '../lib/api';
import toast from 'react-hot-toast';
import Avatar from './Avatar';
import { BUILDTRACK_TRUTH_ICON_SRC } from '../lib/branding';
import { formatEasternRelative, parseBuildTrackTimestamp } from '../lib/time';

interface LayoutProps { children: React.ReactNode; }

interface SearchResult {
  type: string;
  title: string;
  subtitle?: string;
  url: string;
  meta?: string;
}

interface RecentNote {
  id: string;
  project_id: string;
  user_name: string;
  user_avatar_url?: string | null;
  note: string;
  created_at: string;
  project_address?: string | null;
  project_job_name?: string | null;
}

interface ActivityLog {
  id: string;
  project_id?: string | null;
  user_name: string;
  user_avatar_url?: string | null;
  action: string;
  entity_type?: string | null;
  entity_id?: string | null;
  details?: string | null;
  created_at: string;
  project_address?: string | null;
  project_job_name?: string | null;
}

interface NotificationItem {
  id: string;
  userName: string;
  userAvatarUrl?: string | null;
  icon: typeof Bell;
  description: string;
  connectedRecord: string;
  preview?: string;
  createdAt: string;
  to: string;
}

function safeDetails(raw?: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function notificationLabel(action: string, details?: Record<string, any> | null) {
  const labels: Record<string, string> = {
    note_added: 'added a project note',
    note_updated: 'updated a project note',
    project_created: 'created a project',
    project_updated: 'updated a project',
    invoice_created: 'created an invoice',
    invoice_submitted: 'submitted an invoice',
    invoice_status_updated: `updated invoice status${details?.status ? ` to ${String(details.status).replace(/_/g, ' ')}` : ''}`,
    punch_item_created: 'created a punch list item',
    punch_item_updated: 'updated a punch list item',
    document_uploaded: 'uploaded a document',
    contractor_profile_created: 'created a contractor record',
    contractor_profile_updated: 'updated a contractor record',
    supplier_profile_created: 'created a supplier record',
    supplier_profile_updated: 'updated a supplier record',
    avatar_updated: 'updated a profile photo',
  };
  return labels[action] || action.replace(/_/g, ' ');
}

function notificationLink(log: ActivityLog) {
  if (log.project_id && log.entity_type === 'invoice' && log.entity_id) {
    return `/projects/${log.project_id}/invoices/${log.entity_id}`;
  }
  if (log.project_id) return `/projects/${log.project_id}`;
  const subject = `${log.action} ${log.entity_type || ''}`.toLowerCase();
  if (subject.includes('contractor')) return '/contractors';
  if (subject.includes('supplier')) return '/suppliers';
  if (subject.includes('invoice')) return '/invoices';
  return '/dashboard';
}

export default function Layout({ children }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notificationsLoaded, setNotificationsLoaded] = useState(false);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationItems, setNotificationItems] = useState<NotificationItem[]>([]);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { user, logout, updateUser } = useAuthStore();
  const location = useLocation();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const loadNotifications = async () => {
    if (notificationsLoading) return;
    setNotificationsLoading(true);
    try {
      const [notesRes, activityRes] = await Promise.all([
        api.get('/notes/recent?limit=8').catch(() => ({ data: [] })),
        api.get('/activity').catch(() => ({ data: [] })),
      ]);
      const noteItems: NotificationItem[] = (Array.isArray(notesRes.data) ? notesRes.data : []).map((note: RecentNote) => ({
        id: `note-${note.id}`,
        userName: note.user_name || 'Unknown user',
        userAvatarUrl: note.user_avatar_url || null,
        icon: MessageSquare,
        description: 'added a project note',
        connectedRecord: note.project_address || note.project_job_name || 'Project note',
        preview: note.note,
        createdAt: note.created_at,
        to: `/projects/${note.project_id}#notes`,
      }));
      const activityItems: NotificationItem[] = (Array.isArray(activityRes.data) ? activityRes.data : []).map((log: ActivityLog) => {
        const details = safeDetails(log.details);
        const subject = `${log.action} ${log.entity_type || ''}`.toLowerCase();
        const Icon = subject.includes('note') ? MessageSquare : ClipboardList;
        return {
          id: `activity-${log.id}`,
          userName: log.user_name || 'Unknown user',
          userAvatarUrl: log.user_avatar_url || null,
          icon: Icon,
          description: notificationLabel(log.action, details),
          connectedRecord: log.project_address || log.project_job_name || log.entity_type || 'BuildTrack',
          preview: details?.note || details?.title || details?.name || details?.scope_title || details?.material_name,
          createdAt: log.created_at,
          to: notificationLink(log),
        };
      });
      setNotificationItems([...noteItems, ...activityItems]
        .sort((left, right) =>
          (parseBuildTrackTimestamp(right.createdAt)?.getTime() || 0) -
          (parseBuildTrackTimestamp(left.createdAt)?.getTime() || 0)
        )
        .slice(0, 8));
      setNotificationsLoaded(true);
    } catch {
      toast.error('Unable to load notifications');
    } finally {
      setNotificationsLoading(false);
    }
  };

  const toggleNotifications = () => {
    const nextOpen = !notificationsOpen;
    setNotificationsOpen(nextOpen);
    setProfileOpen(false);
    setSearchOpen(false);
    if (nextOpen && !notificationsLoaded) loadNotifications();
  };

  const openNotification = (to: string) => {
    setNotificationsOpen(false);
    navigate(to);
  };

  useEffect(() => {
    if (!user) return;
    api.post('/auth/heartbeat').catch(() => {});
    api.get('/auth/me')
      .then(res => updateUser(res.data))
      .catch(() => {});
    const timer = window.setInterval(() => {
      api.post('/auth/heartbeat').catch(() => {});
    }, 45000);
    return () => window.clearInterval(timer);
  }, [user?.id]);

  useEffect(() => {
    const q = searchTerm.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await api.get('/search', { params: { q, limit: 8 } });
        setSearchResults(res.data.results || []);
        setSearchOpen(true);
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [searchTerm]);

  const goToSearchResult = (result: SearchResult) => {
    setSearchTerm('');
    setSearchResults([]);
    setSearchOpen(false);
    navigate(result.url);
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingAvatar(true);
    try {
      const formData = new FormData();
      formData.append('avatar', file);
      const res = await api.post('/users/me/avatar', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      updateUser({ avatar_url: res.data.avatar_url });
      toast.success('Profile photo updated!');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to upload photo');
    } finally {
      setUploadingAvatar(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemoveAvatar = async () => {
    try {
      await api.delete('/users/me/avatar');
      updateUser({ avatar_url: null });
      toast.success('Profile photo removed');
    } catch {
      toast.error('Failed to remove photo');
    }
  };

  // Sidebar nav items
  const navItems = [
    { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/projects', icon: FolderOpen, label: 'Projects' },
    { to: '/invoices', icon: FileText, label: 'Invoices' },
    { to: '/contractors', icon: Users, label: 'Contractors' },
    { to: '/suppliers', icon: Truck, label: 'Suppliers' },
    ...(user && canAccessSecurity(user.role) ? [{ to: '/security', icon: ShieldCheck, label: 'Security' }] : []),
  ];

  const isActive = (path: string) => location.pathname.startsWith(path);

  const pageTitles: Record<string, string> = {
    '/dashboard': 'Dashboard',
    '/projects': 'Projects',
    '/invoices': 'Invoices',
    '/contractors': 'Contractors',
    '/suppliers': 'Suppliers',
    '/security': 'Security',
    '/users': 'Users',
    '/settings': 'Settings',
  };

  const currentTitle = Object.entries(pageTitles).find(([path]) =>
    location.pathname.startsWith(path)
  )?.[1] || 'BuildTrack';
  const showBackToDashboard = !location.pathname.startsWith('/dashboard');

  useEffect(() => {
    setProfileOpen(false);
    setNotificationsOpen(false);
  }, [location.pathname]);

  const W = sidebarCollapsed ? 72 : 240;
  const SidebarContent = ({ collapsed = false }: { collapsed?: boolean }) => (
    <div className="flex flex-col h-full">
      {/* Logo area */}
      <div
        className="flex items-center px-4 border-b"
        style={{
          height: 64,
          borderColor: 'rgba(255,255,255,0.07)',
          justifyContent: collapsed ? 'center' : 'space-between',
        }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="w-10 h-10 rounded-xl overflow-hidden flex-shrink-0 bg-slate-950"
            style={{ boxShadow: '0 0 0 1px rgba(245,183,49,0.38)' }}
          >
            <img src={BUILDTRACK_TRUTH_ICON_SRC} alt="BuildTrack" className="h-full w-full object-contain" />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="text-white font-bold text-sm leading-tight truncate">BuildTrack</p>
              <p className="text-xs font-medium truncate" style={{ color: '#F4A261' }}>Construction Ops</p>
            </div>
          )}
        </div>
        {!collapsed && (
          <button
            onClick={() => setSidebarCollapsed(true)}
            className="hidden h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border transition-colors hover:border-orange-400/70 hover:text-orange-300 lg:flex"
            style={{ color: 'rgba(255,255,255,0.48)', background: '#0E1012', borderColor: '#242A31' }}
            aria-label="Collapse navigation menu"
          >
            <ChevronRight className="w-4 h-4 rotate-180" />
          </button>
        )}
      </div>

      {/* Nav section label */}
      {!collapsed && (
        <div className="px-4 pt-5 pb-2">
          <p className="text-xs font-bold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,0.25)' }}>
            Navigation
          </p>
        </div>
      )}

      {/* Nav items */}
      <nav className="flex-1 px-3 py-2 space-y-0.5 overflow-y-auto">
        {navItems.map(({ to, icon: Icon, label }) => {
          const active = isActive(to);
          return (
            <Link
              key={to}
              to={to}
              onClick={() => setSidebarOpen(false)}
              title={collapsed ? label : undefined}
              className="flex items-center gap-3 rounded-xl text-sm font-medium transition-all duration-150 relative group"
              style={{
                padding: collapsed ? '10px 0' : '10px 12px',
                justifyContent: collapsed ? 'center' : 'flex-start',
                background: active
                  ? 'rgba(231,139,74,0.12)'
                  : 'transparent',
                color: active ? '#F4A261' : 'rgba(220,222,224,0.68)',
                borderLeft: active ? '3px solid #E78B4A' : '3px solid transparent',
              }}
            >
              <Icon className="w-5 h-5 flex-shrink-0" style={{ opacity: active ? 1 : 0.7 }} />
              {!collapsed && (
                <span className="flex-1 truncate" style={{ color: active ? '#FFFFFF' : 'rgba(255,255,255,0.72)' }}>
                  {label}
                </span>
              )}
              {active && !collapsed && (
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: '#E78B4A' }} />
              )}
              {collapsed && (
                <div
                  className="absolute left-full ml-3 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50"
                  style={{ background: '#1E2530', color: 'white', boxShadow: '0 4px 12px rgba(0,0,0,0.3)' }}
                >
                  {label}
                </div>
              )}
            </Link>
          );
        })}
      </nav>

      {/* User footer */}
      <div className="px-3 py-3 border-t" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
        <div
          className="rounded-md border p-2"
          style={{
            background: 'rgba(255,255,255,0.05)',
            borderColor: 'rgba(255,255,255,0.06)',
          }}
        >
          <div className="flex items-start gap-2">
            <Avatar src={user?.avatar_url} name={user?.name} size={32} />
            {!collapsed && (
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold leading-snug text-white break-words">{user?.name}</p>
                <p className="mt-0.5 text-[11px] leading-tight" style={{ color: 'rgba(255,255,255,0.52)' }}>
                  {user ? roleLabels[user.role] : ''}
                </p>
              </div>
            )}
          </div>
          {!collapsed && (
            <div className="mt-2 flex justify-end">
              <button
                onClick={handleLogout}
                className="inline-flex h-6 items-center justify-center gap-1 rounded-md border px-2 text-[9px] font-black uppercase tracking-wide transition-colors"
                style={{ color: '#FCA5A5', background: 'rgba(127,29,29,0.12)', borderColor: 'rgba(127,29,29,0.42)' }}
                title="Log off"
                aria-label="Log off"
              >
                <LogOut className="w-3 h-3" />
                Log off
              </button>
            </div>
          )}
        </div>
        {collapsed && (
          <button
            onClick={handleLogout}
            className="mt-1 flex h-7 w-full items-center justify-center rounded-md border transition-colors"
            style={{ color: '#FCA5A5', background: 'rgba(127,29,29,0.18)', borderColor: 'rgba(127,29,29,0.52)' }}
            title="Log off"
            aria-label="Log off"
          >
            <LogOut className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Expand button when collapsed */}
      {collapsed && (
        <div className="px-3 pb-3">
          <button
            onClick={() => setSidebarCollapsed(false)}
            className="flex h-8 w-full items-center justify-center rounded-md border transition-colors"
            style={{ color: '#FFD0A8', background: '#1E1610', borderColor: '#E78B4A' }}
            aria-label="Expand navigation menu"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="bt-desktop-shell bt-horizontal-lock flex h-screen max-w-full overflow-hidden" style={{ background: 'var(--bt-bg)' }}>
      {/* Desktop Sidebar */}
      <aside
        className="hidden lg:flex flex-col flex-shrink-0 transition-all duration-300"
        style={{
          width: W,
          background: '#080A0C',
          boxShadow: '1px 0 0 #2E343B',
        }}
      >
        <SidebarContent collapsed={sidebarCollapsed} />
      </aside>

      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0"
            style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
            onClick={() => setSidebarOpen(false)}
          />
          <aside
            className="absolute left-0 top-0 bottom-0 flex flex-col"
            style={{
              width: 260,
              background: 'linear-gradient(180deg, #0D1117 0%, #181D25 50%, #0D1117 100%)',
              boxShadow: '8px 0 32px rgba(0,0,0,0.4)',
            }}
          >
            <div className="flex items-center justify-between px-4 py-4 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl overflow-hidden bg-slate-950" style={{ boxShadow: '0 0 0 1px rgba(245,183,49,0.38)' }}>
                  <img src={BUILDTRACK_TRUTH_ICON_SRC} alt="BuildTrack" className="h-full w-full object-contain" />
                </div>
                <div>
                  <p className="text-white font-bold text-sm">New Urban Dev</p>
                  <p className="text-xs" style={{ color: '#D99D26' }}>Field Operations</p>
                </div>
              </div>
              <button onClick={() => setSidebarOpen(false)} className="p-2 rounded-lg" style={{ color: 'rgba(255,255,255,0.4)' }} aria-label="Close navigation menu">
                <X className="w-5 h-5" />
              </button>
            </div>
            <SidebarContent />
          </aside>
        </div>
      )}

      {/* Main content area */}
      <div className="bt-horizontal-lock flex-1 flex flex-col min-w-0 max-w-full overflow-hidden">
        {/* Top Header Bar */}
        <header
          className="bt-desktop-topbar bt-horizontal-lock flex items-center justify-between gap-3 px-4 sm:gap-4 sm:px-6 flex-shrink-0"
          style={{
            height: 58,
            background: '#0B0D0F',
            borderBottom: '1px solid var(--bt-border)',
            boxShadow: '0 1px 0 #222831',
          }}
        >
          {/* Left: hamburger + breadcrumb */}
          <div className="flex flex-1 items-center gap-3 min-w-0 sm:gap-4">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 rounded-xl transition-colors lg:hidden"
              style={{ color: 'var(--bt-text-muted)' }}
              aria-label="Open navigation menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            {showBackToDashboard && (
              <Link
                to="/dashboard"
                className="hidden min-h-9 flex-shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-xs font-black uppercase tracking-wide transition-colors sm:inline-flex"
                style={{ background: '#1E1610', borderColor: '#E78B4A', color: '#FFD0A8' }}
                aria-label="Back to Dashboard"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to Dashboard
              </Link>
            )}
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <span className="flex-shrink-0 font-medium" style={{ color: 'var(--bt-text-muted)' }}>BuildTrack</span>
              <ChevronRight className="w-3.5 h-3.5" style={{ color: '#D1D5DB' }} />
              <span className="min-w-0 truncate font-bold" style={{ color: 'var(--bt-text)' }}>{currentTitle}</span>
            </div>
          </div>

          {/* Global search */}
          <div className="relative hidden md:block flex-1 max-w-2xl">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: '#8A929C' }} />
              <input
                value={searchTerm}
                onChange={e => {
                  setSearchTerm(e.target.value);
                  setSearchOpen(true);
                }}
                onFocus={() => setSearchOpen(true)}
                placeholder="Search anything in BuildTrack..."
                className="w-full rounded-md py-2 pl-10 pr-10 text-sm font-medium placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500"
                style={{
                  background: '#111315',
                  color: 'var(--bt-text)',
                  border: '1px solid var(--bt-border)',
                }}
              />
              {searchTerm && (
                <button
                  onClick={() => {
                    setSearchTerm('');
                    setSearchResults([]);
                    setSearchOpen(false);
                  }}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-lg text-gray-400 hover:text-gray-700"
                  title="Clear search"
                  aria-label="Clear search"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            {searchOpen && searchTerm.trim().length >= 2 && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setSearchOpen(false)} />
                <div className="absolute left-0 right-0 top-full mt-2 rounded-2xl bg-white border border-gray-200 shadow-xl z-20 overflow-hidden">
                  {searchLoading ? (
                    <div className="px-4 py-5 text-sm text-gray-400">Searching...</div>
                  ) : searchResults.length === 0 ? (
                    <div className="px-4 py-5 text-sm text-gray-400">No results found</div>
                  ) : (
                    <div className="max-h-96 overflow-y-auto divide-y divide-gray-50">
                      {searchResults.map((result, index) => (
                        <button
                          key={`${result.type}-${result.url}-${index}`}
                          onClick={() => goToSearchResult(result)}
                          className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-bold text-gray-900 truncate">{result.title}</p>
                              {result.subtitle && <p className="text-xs text-gray-500 truncate mt-0.5">{result.subtitle}</p>}
                            </div>
                            <div className="flex flex-col items-end gap-1 flex-shrink-0">
                              <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
                                {result.type}
                              </span>
                              {result.meta && <span className="text-[10px] text-gray-400 truncate max-w-[120px]">{result.meta}</span>}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Right: users icon, settings icon, notification bell, user avatar dropdown */}
          <div className="flex flex-shrink-0 items-center gap-1 sm:gap-2">
            {/* Users icon — only for super_admin and operations_manager */}
            {user && canManageUsers(user.role) && (
              <Link
                to="/users"
                title="User Management"
                aria-label="User Management"
                className="bt-topbar-action p-2 rounded-xl transition-all sm:p-2.5"
                style={{
                  background: location.pathname.startsWith('/users') ? '#1E1610' : '#111315',
                  border: `1px solid ${location.pathname.startsWith('/users') ? '#E78B4A' : '#343A42'}`,
                  color: location.pathname.startsWith('/users') ? '#F4A261' : '#B8BEC6',
                }}
              >
                <Users className="w-[18px] h-[18px]" />
              </Link>
            )}

            {/* Settings icon — only for super_admin and operations_manager */}
            {user && canAccessSettings(user.role) && (
              <Link
                to="/settings"
                title="Settings"
                aria-label="Settings"
                className="bt-topbar-action p-2 rounded-xl transition-all sm:p-2.5"
                style={{
                  background: location.pathname.startsWith('/settings') ? '#1E1610' : '#111315',
                  border: `1px solid ${location.pathname.startsWith('/settings') ? '#E78B4A' : '#343A42'}`,
                  color: location.pathname.startsWith('/settings') ? '#F4A261' : '#B8BEC6',
                }}
              >
                <Settings className="w-[18px] h-[18px]" />
              </Link>
            )}

            {/* Notification bell */}
            <div className="relative">
              <button
                type="button"
                onClick={toggleNotifications}
                className="bt-topbar-action relative p-2 rounded-xl transition-all sm:p-2.5"
                style={{
                  background: notificationsOpen ? '#1E1610' : '#111315',
                  border: `1px solid ${notificationsOpen ? '#E78B4A' : '#343A42'}`,
                  color: notificationsOpen ? '#F4A261' : '#B8BEC6',
                }}
                aria-label="Open notifications"
                aria-haspopup="menu"
                aria-expanded={notificationsOpen}
              >
                <Bell className="w-[18px] h-[18px]" />
                <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full" style={{ background: '#D97706' }} />
              </button>

              {notificationsOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setNotificationsOpen(false)} />
                  <div
                    className="absolute right-0 top-full z-20 mt-2 w-[22rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-md"
                    style={{ background: '#111315', border: '1px solid #E78B4A', boxShadow: '0 18px 36px rgba(0,0,0,0.38)' }}
                    role="menu"
                    aria-label="Notifications"
                  >
                    <div className="flex items-center justify-between border-b px-3 py-2.5" style={{ borderColor: '#343A42' }}>
                      <div>
                        <p className="text-sm font-bold" style={{ color: 'var(--bt-text)' }}>Notifications</p>
                        <p className="text-[11px] font-semibold" style={{ color: 'var(--bt-text-soft)' }}>Recent team activity</p>
                      </div>
                      <button
                        type="button"
                        onClick={loadNotifications}
                        disabled={notificationsLoading}
                        className="rounded border px-2 py-1 text-[11px] font-bold transition-colors disabled:opacity-60"
                        style={{ borderColor: '#343A42', color: '#C4CAD2', background: '#0E1012' }}
                      >
                        {notificationsLoading ? 'Loading' : 'Refresh'}
                      </button>
                    </div>
                    <div className="max-h-96 overflow-y-auto p-2">
                      {notificationsLoading && !notificationItems.length ? (
                        <div className="space-y-2 p-1">
                          {[0, 1, 2].map(index => (
                            <div key={index} className="h-14 animate-pulse rounded border" style={{ background: '#15181C', borderColor: '#343A42' }} />
                          ))}
                        </div>
                      ) : notificationItems.length === 0 ? (
                        <div className="px-3 py-8 text-center text-sm font-semibold" style={{ color: 'var(--bt-text-muted)' }}>
                          No notifications yet.
                        </div>
                      ) : (
                        <div className="space-y-1">
                          {notificationItems.map(item => {
                            const Icon = item.icon;
                            return (
                              <button
                                key={item.id}
                                type="button"
                                onClick={() => openNotification(item.to)}
                                className="bt-notification-row flex w-full items-start gap-3 rounded-md border p-2.5 text-left transition-colors"
                                style={{ borderColor: '#26313A', background: '#0E1012' }}
                                role="menuitem"
                              >
                                <Avatar src={item.userAvatarUrl} name={item.userName} size={30} />
                                <div className="min-w-0 flex-1">
                                  <div className="flex min-w-0 items-center gap-1.5">
                                    <Icon className="h-3.5 w-3.5 flex-shrink-0" style={{ color: '#E78B4A' }} />
                                    <p className="truncate text-xs font-bold" style={{ color: 'var(--bt-text)' }}>{item.userName}</p>
                                    <span className="text-[10px] font-semibold" style={{ color: 'var(--bt-text-soft)' }}>
                                      {formatEasternRelative(item.createdAt)}
                                    </span>
                                  </div>
                                  <p className="mt-0.5 truncate text-xs font-semibold" style={{ color: '#C4CAD2' }}>
                                    {item.description}
                                  </p>
                                  <p className="truncate text-[11px] font-semibold" style={{ color: '#98A2AD' }}>
                                    {item.connectedRecord}
                                  </p>
                                  {item.preview && (
                                    <p className="mt-1 line-clamp-2 text-[11px] leading-4" style={{ color: '#D8D1C8' }}>
                                      {item.preview}
                                    </p>
                                  )}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* User avatar + profile dropdown */}
            <div className="relative">
              <button
                onClick={() => { setProfileOpen(!profileOpen); setNotificationsOpen(false); }}
                className="bt-profile-chip flex h-10 min-w-0 max-w-[176px] cursor-pointer items-center gap-2 overflow-hidden rounded-md px-2.5 py-0 transition-all"
                style={{ background: '#111315', border: '1px solid #343A42' }}
                aria-label="Open profile menu"
              >
                <Avatar src={user?.avatar_url} name={user?.name} size={30} />
                <div className="hidden min-w-0 text-left sm:block">
                  <p className="truncate text-[13px] font-bold leading-4 text-gray-900">{user?.name}</p>
                  <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                    <p className="truncate text-[11px] font-semibold leading-3" style={{ color: '#F4A261' }}>
                      {user ? roleLabels[user.role] : ''}
                    </p>
                    <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: '#059669' }} aria-label="Online now" />
                  </div>
                </div>
                <ChevronRight className={`hidden h-3 w-3 flex-shrink-0 transition-transform sm:block ${profileOpen ? 'rotate-90' : 'rotate-0'}`} style={{ color: '#9CA3AF' }} />
              </button>

              {/* Profile dropdown */}
              {profileOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setProfileOpen(false)} />
                  <div
                    className="absolute right-0 top-full mt-2 w-72 rounded-md shadow-xl z-20 overflow-hidden"
                    style={{ background: '#111315', border: '1px solid #E78B4A' }}
                  >
                    {/* Profile header */}
                    <div className="p-4 border-b" style={{ borderColor: '#343A42' }}>
                      <div className="flex items-center gap-3">
                        {/* Avatar with upload overlay */}
                        <div className="relative group cursor-pointer" onClick={() => fileInputRef.current?.click()}>
                          <Avatar src={user?.avatar_url} name={user?.name} size={52} />
                          <div className="absolute inset-0 rounded-xl bg-black bg-opacity-0 group-hover:bg-opacity-40 transition-all flex items-center justify-center">
                            <Camera className="w-5 h-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                          </div>
                          {uploadingAvatar && (
                            <div className="absolute inset-0 rounded-xl bg-black bg-opacity-50 flex items-center justify-center">
                              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-bold text-gray-900 text-sm truncate">{user?.name}</p>
                          <p className="text-xs text-gray-500 truncate">{user?.email}</p>
                          <span
                            className="inline-block mt-1 text-xs px-2 py-0.5 rounded-full font-medium"
                            style={{ background: '#FEF3C7', color: '#92400E' }}
                          >
                            {user ? roleLabels[user.role] : ''}
                          </span>
                        </div>
                      </div>

                      {/* Avatar actions */}
                      <div className="flex gap-2 mt-3">
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          disabled={uploadingAvatar}
                          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium transition-colors"
                          style={{ background: '#171A1D', color: '#E7E0D7', border: '1px solid #343A42' }}
                        >
                          <Camera className="w-3.5 h-3.5" />
                          {uploadingAvatar ? 'Uploading...' : 'Upload Photo'}
                        </button>
                        {user?.avatar_url && (
                          <button
                            onClick={handleRemoveAvatar}
                            className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                            style={{ background: '#261010', color: '#FCA5A5', border: '1px solid #7F1D1D' }}
                            title="Remove photo"
                            aria-label="Remove profile photo"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>

                      {/* Hidden file input */}
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={handleAvatarUpload}
                      />
                    </div>

                    {/* Menu items */}
                    <div className="p-2">
                      {user && canManageUsers(user.role) && (
                        <Link
                          to="/users"
                          onClick={() => setProfileOpen(false)}
                          className="flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                        >
                          <Users className="w-4 h-4 text-gray-400" />
                          User Management
                        </Link>
                      )}
                      {user && canAccessSettings(user.role) && (
                        <Link
                          to="/settings"
                          onClick={() => setProfileOpen(false)}
                          className="flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                        >
                          <Settings className="w-4 h-4 text-gray-400" />
                          Settings
                        </Link>
                      )}
                      <div className="border-t my-1" style={{ borderColor: '#343A42' }} />
                      <button
                        onClick={() => { setProfileOpen(false); handleLogout(); }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors"
                        style={{ color: '#FCA5A5' }}
                      >
                        <LogOut className="w-4 h-4" />
                        Log off
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="bt-horizontal-lock flex-1 overflow-y-auto overflow-x-hidden" style={{ touchAction: 'pan-y', overscrollBehaviorX: 'none' }}>
          {children}
        </main>
      </div>
    </div>
  );
}
