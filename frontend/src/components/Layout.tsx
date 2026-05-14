import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore, roleLabels, canManageUsers, canAccessSettings, isAdminRole } from '../store/authStore';
import {
  LayoutDashboard, FolderOpen, ClipboardList, FileText,
  Users, Settings, LogOut, Menu, X, Bell, ChevronRight,
  Camera, Search, Trash2, Truck
} from 'lucide-react';
import api from '../lib/api';
import toast from 'react-hot-toast';
import ManagementChatWidget from './ManagementChatWidget';

interface LayoutProps { children: React.ReactNode; }

interface SearchResult {
  type: string;
  title: string;
  subtitle?: string;
  url: string;
  meta?: string;
}

interface PresenceUser {
  id: string;
  name: string;
  email: string;
  role: string;
  avatar_url?: string | null;
  last_login_at?: string | null;
  last_seen_at?: string | null;
  is_online?: number;
}

export default function Layout({ children }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [presenceUsers, setPresenceUsers] = useState<PresenceUser[]>([]);
  const { user, logout, updateUser } = useAuthStore();
  const location = useLocation();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleLogout = () => {
    logout();
    navigate('/login');
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
    if (!user || !isAdminRole(user.role)) return;

    const loadPresence = () => {
      api.get('/users/presence')
        .then(res => setPresenceUsers(Array.isArray(res.data) ? res.data : []))
        .catch(() => setPresenceUsers([]));
    };

    loadPresence();
    const timer = window.setInterval(loadPresence, 30000);
    return () => window.clearInterval(timer);
  }, [user?.id, user?.role]);

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
  ];

  const isActive = (path: string) => location.pathname.startsWith(path);

  const pageTitles: Record<string, string> = {
    '/dashboard': 'Dashboard',
    '/projects': 'Projects',
    '/invoices': 'Invoices',
    '/contractors': 'Contractors',
    '/suppliers': 'Suppliers',
    '/users': 'Users',
    '/settings': 'Settings',
  };

  const currentTitle = Object.entries(pageTitles).find(([path]) =>
    location.pathname.startsWith(path)
  )?.[1] || 'BuildTrack';

  const W = sidebarCollapsed ? 72 : 240;
  const onlineUsers = presenceUsers.filter(member => Number(member.is_online) === 1);

  const getPresenceState = (member: PresenceUser) => {
    if (Number(member.is_online) === 1) return { label: 'Online now', color: '#059669', bg: '#ECFDF5' };
    if (member.last_seen_at) {
      const seenAt = new Date(member.last_seen_at).getTime();
      if (Number.isFinite(seenAt) && Date.now() - seenAt < 15 * 60 * 1000) {
        return { label: 'Recently active', color: '#D97706', bg: '#FFFBEB' };
      }
    }
    return { label: 'Offline', color: '#6B7280', bg: '#F3F4F6' };
  };

  const formatPresenceTime = (member: PresenceUser) => {
    const value = member.last_seen_at || member.last_login_at;
    if (!value) return 'No recent activity';
    const time = new Date(value);
    if (!Number.isFinite(time.getTime())) return 'No recent activity';
    return `Last active ${time.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
  };

  // Avatar display helper
  const AvatarDisplay = ({ size = 36, className = '' }: { size?: number; className?: string }) => {
    if (user?.avatar_url) {
      return (
        <img
          src={user.avatar_url}
          alt={user.name}
          className={`rounded-xl object-cover flex-shrink-0 ${className}`}
          style={{ width: size, height: size, objectPosition: 'center top' }}
        />
      );
    }
    return (
      <div
        className={`rounded-xl flex items-center justify-center flex-shrink-0 text-white font-black ${className}`}
        style={{
          width: size,
          height: size,
          fontSize: size * 0.38,
          background: 'linear-gradient(135deg, #D99D26, #C4891F)',
        }}
      >
        {user?.name?.[0]?.toUpperCase()}
      </div>
    );
  };

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
            className="w-9 h-9 rounded-xl overflow-hidden flex-shrink-0 border-2"
            style={{ borderColor: 'rgba(217,157,38,0.5)' }}
          >
            <img src="/buildtrack-logo.png" alt="BuildTrack" className="w-full h-full object-cover" />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="text-white font-bold text-sm leading-tight truncate">BuildTrack</p>
              <p className="text-xs font-medium truncate" style={{ color: '#D99D26' }}>Construction Mgmt</p>
            </div>
          )}
        </div>
        {!collapsed && (
          <button
            onClick={() => setSidebarCollapsed(true)}
            className="p-1.5 rounded-lg transition-colors hidden lg:flex"
            style={{ color: 'rgba(255,255,255,0.4)' }}
            title="Collapse sidebar"
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
                  ? 'linear-gradient(135deg, rgba(217,157,38,0.2) 0%, rgba(217,157,38,0.08) 100%)'
                  : 'transparent',
                color: active ? '#D99D26' : 'rgba(255,255,255,0.6)',
                borderLeft: active ? '3px solid #D99D26' : '3px solid transparent',
              }}
            >
              <Icon className="w-5 h-5 flex-shrink-0" style={{ opacity: active ? 1 : 0.7 }} />
              {!collapsed && (
                <span className="flex-1 truncate" style={{ color: active ? '#FFFFFF' : 'rgba(255,255,255,0.65)' }}>
                  {label}
                </span>
              )}
              {active && !collapsed && (
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: '#D99D26' }} />
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
          className="flex items-center gap-3 p-2.5 rounded-xl"
          style={{
            background: 'rgba(255,255,255,0.05)',
            justifyContent: collapsed ? 'center' : 'flex-start',
          }}
        >
          <AvatarDisplay size={32} />
          {!collapsed && (
            <>
              <div className="flex-1 min-w-0">
                <p className="text-white text-sm font-semibold truncate leading-tight">{user?.name}</p>
                <p className="text-xs truncate" style={{ color: 'rgba(255,255,255,0.4)' }}>
                  {user ? roleLabels[user.role] : ''}
                </p>
              </div>
              <button
                onClick={handleLogout}
                className="p-1.5 rounded-lg transition-colors flex-shrink-0"
                style={{ color: 'rgba(255,255,255,0.35)' }}
                title="Sign out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
        {collapsed && (
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center p-2 rounded-xl mt-1 transition-colors"
            style={{ color: 'rgba(255,255,255,0.35)' }}
            title="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Expand button when collapsed */}
      {collapsed && (
        <div className="px-3 pb-3">
          <button
            onClick={() => setSidebarCollapsed(false)}
            className="w-full flex items-center justify-center p-2 rounded-xl transition-colors"
            style={{ color: 'rgba(255,255,255,0.3)', background: 'rgba(255,255,255,0.04)' }}
            title="Expand sidebar"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#F0F2F5' }}>
      {/* Desktop Sidebar */}
      <aside
        className="hidden lg:flex flex-col flex-shrink-0 transition-all duration-300"
        style={{
          width: W,
          background: 'linear-gradient(180deg, #0D1117 0%, #181D25 50%, #0D1117 100%)',
          boxShadow: '4px 0 24px rgba(0,0,0,0.25)',
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
                <div className="w-8 h-8 rounded-xl overflow-hidden border-2" style={{ borderColor: 'rgba(217,157,38,0.5)' }}>
                  <img src="/buildtrack-logo.png" alt="BuildTrack" className="w-full h-full object-contain" />
                </div>
                <div>
                  <p className="text-white font-bold text-sm">New Urban Dev</p>
                  <p className="text-xs" style={{ color: '#D99D26' }}>Field Operations</p>
                </div>
              </div>
              <button onClick={() => setSidebarOpen(false)} className="p-2 rounded-lg" style={{ color: 'rgba(255,255,255,0.4)' }}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <SidebarContent />
          </aside>
        </div>
      )}

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Header Bar */}
        <header
          className="flex items-center justify-between gap-4 px-6 flex-shrink-0"
          style={{
            height: 64,
            background: 'white',
            borderBottom: '1px solid #E5E7EB',
            boxShadow: '0 1px 8px rgba(0,0,0,0.06)',
          }}
        >
          {/* Left: hamburger + breadcrumb */}
          <div className="flex items-center gap-4 min-w-0">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 rounded-xl transition-colors lg:hidden"
              style={{ color: '#6B7280' }}
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium" style={{ color: '#9CA3AF' }}>BuildTrack</span>
              <ChevronRight className="w-3.5 h-3.5" style={{ color: '#D1D5DB' }} />
              <span className="font-bold text-gray-900">{currentTitle}</span>
            </div>
          </div>

          {/* Global search */}
          <div className="relative hidden md:block flex-1 max-w-2xl">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: '#6B7280' }} />
              <input
                value={searchTerm}
                onChange={e => {
                  setSearchTerm(e.target.value);
                  setSearchOpen(true);
                }}
                onFocus={() => setSearchOpen(true)}
                placeholder="Search anything in BuildTrack..."
                className="w-full pl-11 pr-10 py-3 rounded-2xl text-sm font-medium placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500"
                style={{
                  background: '#FFFFFF',
                  color: '#111827',
                  border: '1px solid #D1D5DB',
                  boxShadow: '0 8px 24px rgba(17,24,39,0.08)',
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

          {/* Right: team availability, users icon, settings icon, notification bell, user avatar dropdown */}
          <div className="flex items-center gap-2">
            {user && isAdminRole(user.role) && (
              <div className="relative hidden xl:block">
                <button
                  type="button"
                  onClick={() => setTeamOpen(!teamOpen)}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl transition-all"
                  style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', color: '#374151' }}
                  title="Team availability"
                >
                  <div className="relative">
                    <Users className="w-[18px] h-[18px]" />
                    {onlineUsers.length > 0 && (
                      <span className="absolute -right-1 -top-1 w-2.5 h-2.5 rounded-full border-2 border-white" style={{ background: '#059669' }} />
                    )}
                  </div>
                  <div className="text-left leading-tight">
                    <p className="text-xs font-black text-gray-900">Team availability</p>
                    <p className="text-[11px] text-gray-500">{onlineUsers.length} online</p>
                  </div>
                </button>

                {teamOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setTeamOpen(false)} />
                    <div className="absolute right-0 top-full mt-2 w-80 rounded-2xl bg-white border border-gray-200 shadow-xl z-20 overflow-hidden">
                      <div className="px-4 py-3 border-b border-gray-100">
                        <p className="text-sm font-black text-gray-900">Team availability</p>
                        <p className="text-xs text-gray-500 mt-0.5">Presence only. Use the bottom message bar for IM chat.</p>
                      </div>
                      <div className="max-h-80 overflow-y-auto divide-y divide-gray-50">
                        {presenceUsers.length === 0 ? (
                          <p className="px-4 py-5 text-sm text-gray-400">No team status available</p>
                        ) : presenceUsers.map(member => {
                          const state = getPresenceState(member);
                          return (
                            <button
                              key={member.id}
                              type="button"
                              onClick={() => {
                                setTeamOpen(false);
                                if (canManageUsers(user.role)) navigate('/users');
                              }}
                              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
                            >
                              {member.avatar_url ? (
                                <img src={member.avatar_url} alt={member.name} className="w-9 h-9 rounded-xl object-cover flex-shrink-0" style={{ objectPosition: 'center top' }} />
                              ) : (
                                <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-black flex-shrink-0" style={{ background: 'linear-gradient(135deg, #D99D26, #C4891F)' }}>
                                  {member.name?.[0]?.toUpperCase() || '?'}
                                </div>
                              )}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="text-sm font-bold text-gray-900 truncate">{member.name}</p>
                                  <span className="inline-flex items-center gap-1 text-[10px] font-black px-2 py-0.5 rounded-full whitespace-nowrap" style={{ color: state.color, background: state.bg }}>
                                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: state.color }} />
                                    {state.label}
                                  </span>
                                </div>
                                <p className="text-xs text-gray-500 truncate">{roleLabels[member.role] || member.role}</p>
                                <p className="text-[11px] text-gray-400">{formatPresenceTime(member)}</p>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Users icon — only for super_admin and operations_manager */}
            {user && canManageUsers(user.role) && (
              <Link
                to="/users"
                title="User Management"
                className="p-2.5 rounded-xl transition-all"
                style={{
                  background: location.pathname.startsWith('/users') ? '#F3F4F6' : '#F9FAFB',
                  border: `1px solid ${location.pathname.startsWith('/users') ? '#D99D26' : '#E5E7EB'}`,
                  color: location.pathname.startsWith('/users') ? '#D99D26' : '#6B7280',
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
                className="p-2.5 rounded-xl transition-all"
                style={{
                  background: location.pathname.startsWith('/settings') ? '#F3F4F6' : '#F9FAFB',
                  border: `1px solid ${location.pathname.startsWith('/settings') ? '#D99D26' : '#E5E7EB'}`,
                  color: location.pathname.startsWith('/settings') ? '#D99D26' : '#6B7280',
                }}
              >
                <Settings className="w-[18px] h-[18px]" />
              </Link>
            )}

            {/* Notification bell */}
            <button
              className="relative p-2.5 rounded-xl transition-all"
              style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', color: '#6B7280' }}
            >
              <Bell className="w-[18px] h-[18px]" />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full" style={{ background: '#D99D26' }} />
            </button>

            {/* User avatar + profile dropdown */}
            <div className="relative">
              <button
                onClick={() => setProfileOpen(!profileOpen)}
                className="flex items-center gap-3 px-3 py-2 rounded-xl cursor-pointer transition-all"
                style={{ background: '#F9FAFB', border: '1px solid #E5E7EB' }}
              >
                <AvatarDisplay size={32} />
                <div className="hidden sm:block text-left">
                  <p className="text-sm font-bold text-gray-900 leading-tight">{user?.name}</p>
                  <p className="text-xs" style={{ color: '#D99D26' }}>{user ? roleLabels[user.role] : ''}</p>
                  <p className="text-[10px] font-bold" style={{ color: '#059669' }}>Online now</p>
                </div>
                <ChevronRight className={`w-3.5 h-3.5 hidden sm:block transition-transform ${profileOpen ? 'rotate-90' : 'rotate-0'}`} style={{ color: '#9CA3AF' }} />
              </button>

              {/* Profile dropdown */}
              {profileOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setProfileOpen(false)} />
                  <div
                    className="absolute right-0 top-full mt-2 w-72 rounded-2xl shadow-xl z-20 overflow-hidden"
                    style={{ background: 'white', border: '1px solid #E5E7EB' }}
                  >
                    {/* Profile header */}
                    <div className="p-4 border-b" style={{ borderColor: '#F3F4F6' }}>
                      <div className="flex items-center gap-3">
                        {/* Avatar with upload overlay */}
                        <div className="relative group cursor-pointer" onClick={() => fileInputRef.current?.click()}>
                          <AvatarDisplay size={52} />
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
                          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-colors"
                          style={{ background: '#F3F4F6', color: '#374151' }}
                        >
                          <Camera className="w-3.5 h-3.5" />
                          {uploadingAvatar ? 'Uploading...' : 'Upload Photo'}
                        </button>
                        {user?.avatar_url && (
                          <button
                            onClick={handleRemoveAvatar}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                            style={{ background: '#FEF2F2', color: '#DC2626' }}
                            title="Remove photo"
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
                          className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                        >
                          <Users className="w-4 h-4 text-gray-400" />
                          User Management
                        </Link>
                      )}
                      {user && canAccessSettings(user.role) && (
                        <Link
                          to="/settings"
                          onClick={() => setProfileOpen(false)}
                          className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                        >
                          <Settings className="w-4 h-4 text-gray-400" />
                          Settings
                        </Link>
                      )}
                      <div className="border-t my-1" style={{ borderColor: '#F3F4F6' }} />
                      <button
                        onClick={() => { setProfileOpen(false); handleLogout(); }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors"
                        style={{ color: '#DC2626' }}
                      >
                        <LogOut className="w-4 h-4" />
                        Sign Out
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto pb-24">
          {children}
        </main>
        <ManagementChatWidget />
      </div>
    </div>
  );
}
