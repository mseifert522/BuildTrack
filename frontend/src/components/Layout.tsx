import { useState, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore, roleLabels, canManageUsers, canAccessSettings } from '../store/authStore';
import {
  LayoutDashboard, FolderOpen, ClipboardList, FileText,
  Users, Settings, LogOut, Menu, X, Bell, ChevronRight, Building2,
  Smartphone, Camera, Trash2
} from 'lucide-react';
import api from '../lib/api';
import toast from 'react-hot-toast';

interface LayoutProps { children: React.ReactNode; }

export default function Layout({ children }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const { user, logout, updateUser } = useAuthStore();
  const location = useLocation();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleLogout = () => {
    logout();
    navigate('/login');
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

  // Sidebar nav items — Dashboard, Projects, Punch Lists, Invoices only
  const navItems = [
    { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/projects', icon: FolderOpen, label: 'Projects' },
    { to: '/punch-list', icon: ClipboardList, label: 'Punch Lists' },
    { to: '/invoices', icon: FileText, label: 'Invoices' },
  ];

  const isActive = (path: string) => location.pathname.startsWith(path);

  const pageTitles: Record<string, string> = {
    '/dashboard': 'Dashboard',
    '/projects': 'Projects',
    '/punch-list': 'Punch Lists',
    '/invoices': 'Invoices',
    '/users': 'Users',
    '/settings': 'Settings',
  };

  const currentTitle = Object.entries(pageTitles).find(([path]) =>
    location.pathname.startsWith(path)
  )?.[1] || 'BuildTrack';

  const W = sidebarCollapsed ? 72 : 240;

  // Avatar display helper
  const AvatarDisplay = ({ size = 36, className = '' }: { size?: number; className?: string }) => {
    if (user?.avatar_url) {
      return (
        <img
          src={user.avatar_url}
          alt={user.name}
          className={`rounded-xl object-cover flex-shrink-0 ${className}`}
          style={{ width: size, height: size }}
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
            <img src="/nud-logo.jpg" alt="NUD" className="w-full h-full object-cover" />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="text-white font-bold text-sm leading-tight truncate">New Urban Dev</p>
              <p className="text-xs font-medium truncate" style={{ color: '#D99D26' }}>Field Operations</p>
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

      {/* Mobile switch */}
      {!collapsed && (
        <div className="px-3 pb-2">
          <Link
            to="/mobile"
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all"
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: 'rgba(255,255,255,0.5)',
            }}
          >
            <Smartphone className="w-4 h-4 flex-shrink-0" />
            <span>Switch to Mobile</span>
          </Link>
        </div>
      )}

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
                  <img src="/nud-logo.jpg" alt="NUD" className="w-full h-full object-cover" />
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
          className="flex items-center justify-between px-6 flex-shrink-0"
          style={{
            height: 64,
            background: 'white',
            borderBottom: '1px solid #E5E7EB',
            boxShadow: '0 1px 8px rgba(0,0,0,0.06)',
          }}
        >
          {/* Left: hamburger + breadcrumb */}
          <div className="flex items-center gap-4">
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

          {/* Right: Users icon, Settings icon, notification bell, user avatar dropdown */}
          <div className="flex items-center gap-2">

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
                      <Link
                        to="/mobile"
                        onClick={() => setProfileOpen(false)}
                        className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        <Smartphone className="w-4 h-4 text-gray-400" />
                        Switch to Mobile
                      </Link>
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
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
