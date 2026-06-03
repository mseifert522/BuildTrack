import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  Clock,
  type LucideIcon,
  LogOut,
  Monitor,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  UserX,
} from 'lucide-react';
import api from '../lib/api';
import { Loading, PageHeader } from '../components/ui';
import { useAuthStore, roleLabels } from '../store/authStore';
import { formatEasternDateTime, parseBuildTrackTimestamp } from '../lib/time';

type SecurityStatus = 'online' | 'recently_active' | 'signed_in' | 'offline';

interface SecuritySession {
  id: string;
  user_id: string;
  session_type: string;
  ip_address?: string | null;
  user_agent?: string | null;
  issued_at?: string | null;
  last_seen_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  security_status: SecurityStatus;
  client_type: 'desktop' | 'mobile_app' | string;
  client_label: string;
  device_type: 'desktop' | 'mobile' | 'tablet' | string;
  device_label: string;
  os_label: string;
  browser_label: string;
  is_current_session?: boolean;
  details?: Record<string, any> | null;
}

interface SecurityUser {
  id: string;
  name: string;
  email: string;
  role: string;
  phone?: string | null;
  company?: string | null;
  avatar_url?: string | null;
  last_login_at?: string | null;
  last_seen_at?: string | null;
  session_revoked_at?: string | null;
  active_session_count: number;
  session_last_seen_at?: string | null;
  latest_session_issued_at?: string | null;
  session_types?: string;
  trusted_device_count: number;
  quick_access_count: number;
  security_status: SecurityStatus;
  sessions?: SecuritySession[];
}

interface SecurityEvent {
  id: string;
  actor_user_id: string;
  target_user_id?: string | null;
  action: string;
  reason?: string | null;
  details?: string | null;
  created_at: string;
  actor_name: string;
  actor_email: string;
  target_name?: string | null;
  target_email?: string | null;
}

interface SummaryCard {
  label: string;
  value: number;
  icon: LucideIcon;
  color: string;
  bg: string;
}

const statusCopy: Record<SecurityUser['security_status'], { label: string; className: string; dot: string }> = {
  online: { label: 'Online now', className: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: '#10B981' },
  recently_active: { label: 'Recently active', className: 'bg-amber-50 text-amber-700 border-amber-200', dot: '#F59E0B' },
  signed_in: { label: 'Signed in', className: 'bg-blue-50 text-blue-700 border-blue-200', dot: '#2563EB' },
  offline: { label: 'Offline', className: 'bg-gray-50 text-gray-600 border-gray-200', dot: '#9CA3AF' },
};

const actionLabels: Record<string, string> = {
  security_logout_all_users: 'Logged out all users',
  security_logout_user: 'Logged out user',
  security_logout_session: 'Logged out session',
};

function clearLocalLoginState() {
  [
    'token',
    'user',
    'auth_session_started_at',
    'auth_last_activity_at',
    'auth_last_refresh_at',
    'contractor_token',
    'contractor_user',
    'contractor_projects',
    'contractor_session_started_at',
    'contractor_last_activity_at',
    'contractor_last_refresh_at',
    'bt_device_token',
    'bt_device_trusted_until',
    'bt_mobile_quick_access_token',
    'bt_mobile_quick_access_expires_at',
    'bt_mobile_quick_access_user_label',
  ].forEach(key => localStorage.removeItem(key));
}

function formatDateTime(value?: string | null) {
  if (!value || !parseBuildTrackTimestamp(value)) return 'No record';
  return formatEasternDateTime(value, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function timeDistance(value?: string | null) {
  const parsed = value ? parseBuildTrackTimestamp(value) : null;
  if (!parsed) return 'No recent activity';
  const diffMs = Date.now() - parsed.getTime();
  const minutes = Math.max(0, Math.round(diffMs / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return formatDateTime(value);
}

function sessionAccessMethod(session: SecuritySession) {
  const issuedVia = session.details?.issued_via || {};
  if (issuedVia.mobile_quick_access) return 'One-touch login';
  if (issuedVia.trusted_device_quick_login || issuedVia.trusted_device) return 'Trusted device';
  if (issuedVia.pin_login) return 'PIN login';
  if (issuedVia.contractor_email_2fa) return 'Contractor email 2FA';
  if (issuedVia.two_factor === true) return 'Password + 2FA';
  if (issuedVia.two_factor === 'skipped_no_smtp') return 'Password login';
  return 'Authenticated session';
}

function sessionIcon(session: SecuritySession) {
  return session.client_type === 'mobile_app' || session.device_type === 'mobile' || session.device_type === 'tablet'
    ? Smartphone
    : Monitor;
}

function truncateMiddle(value?: string | null, max = 92) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  const keep = Math.floor((max - 3) / 2);
  return `${text.slice(0, keep)}...${text.slice(-keep)}`;
}

function eventDescription(event: SecurityEvent) {
  if (event.action === 'security_logout_all_users') return 'Every active account was forced to sign in again.';
  if (event.action === 'security_logout_user') {
    return `${event.target_name || event.target_email || 'A user'} was forced to sign in again.`;
  }
  if (event.action === 'security_logout_session') {
    return `${event.target_name || event.target_email || 'A user'} had one selected device session terminated.`;
  }
  return event.reason || 'Security event recorded.';
}

export default function Security() {
  const [users, setUsers] = useState<SecurityUser[]>([]);
  const [sessions, setSessions] = useState<SecuritySession[]>([]);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [globalLogoutLoading, setGlobalLogoutLoading] = useState(false);
  const [userLogoutId, setUserLogoutId] = useState<string | null>(null);
  const [sessionLogoutId, setSessionLogoutId] = useState<string | null>(null);
  const [securitySearch, setSecuritySearch] = useState('');
  const [securityStatusFilter, setSecurityStatusFilter] = useState('');
  const [securityClientFilter, setSecurityClientFilter] = useState('');
  const { user: currentUser, logout } = useAuthStore();
  const navigate = useNavigate();

  const sessionRows = useMemo(() => users.flatMap(row =>
    (row.sessions || []).map((session, index) => ({
      user: row,
      session,
      index,
      total: row.sessions?.length || 0,
    }))
  ), [users]);

  const savedAccessRows = useMemo(() => users.filter(row =>
    (!row.sessions || row.sessions.length === 0) && (row.trusted_device_count > 0 || row.quick_access_count > 0 || row.last_login_at)
  ), [users]);

  const filteredSessionRows = useMemo(() => {
    const q = securitySearch.trim().toLowerCase();
    return sessionRows.filter(({ user: row, session }) => {
      if (securityStatusFilter && session.security_status !== securityStatusFilter) return false;
      if (securityClientFilter && session.client_type !== securityClientFilter && session.device_type !== securityClientFilter) return false;
      if (!q) return true;
      return [
        row.name,
        row.email,
        roleLabels[row.role] || row.role,
        session.ip_address,
        session.client_label,
        session.device_label,
        session.os_label,
        session.browser_label,
        session.user_agent,
        sessionAccessMethod(session),
      ].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }, [sessionRows, securityClientFilter, securitySearch, securityStatusFilter]);

  const filteredSavedAccessRows = useMemo(() => {
    const q = securitySearch.trim().toLowerCase();
    return savedAccessRows.filter(row => {
      if (!q) return true;
      return [
        row.name,
        row.email,
        roleLabels[row.role] || row.role,
        row.company,
      ].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }, [savedAccessRows, securitySearch]);

  const counts = useMemo(() => ({
    online: sessions.filter(row => row.security_status === 'online').length,
    active: sessions.filter(row => ['online', 'recently_active'].includes(row.security_status)).length,
    signedIn: sessions.length,
    quickAccess: users.reduce((sum, row) => sum + Number(row.quick_access_count || 0), 0),
  }), [sessions, users]);

  const summaryCards: SummaryCard[] = [
    { label: 'Online sessions', value: counts.online, icon: ShieldCheck, color: '#059669', bg: '#ECFDF5' },
    { label: 'Sessions active last 15 min', value: counts.active, icon: Clock, color: '#D97706', bg: '#FFFBEB' },
    { label: 'Signed-in sessions', value: counts.signedIn, icon: LogOut, color: '#2563EB', bg: '#EFF6FF' },
    { label: 'One-touch app access', value: counts.quickAccess, icon: Smartphone, color: '#7C3AED', bg: '#F5F3FF' },
  ];

  const loadSecurity = async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      const [sessionsRes, eventsRes] = await Promise.all([
        api.get('/security/sessions'),
        api.get('/security/events', { params: { limit: 40 } }),
      ]);
      setUsers(Array.isArray(sessionsRes.data?.users) ? sessionsRes.data.users : []);
      setSessions(Array.isArray(sessionsRes.data?.sessions) ? sessionsRes.data.sessions : []);
      setEvents(Array.isArray(eventsRes.data?.events) ? eventsRes.data.events : []);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to load security dashboard');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadSecurity();
    const timer = window.setInterval(() => loadSecurity(true), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const handleLogoutAll = async () => {
    if (!confirm('Log out ALL users? Everyone will be forced to sign in again on desktop and mobile.')) return;
    if (!confirm('Confirm security action: this will revoke active sessions, trusted devices, and one-touch app access for every user.')) return;
    const reason = window.prompt('Reason for security history', 'Security logout all users') || 'Security logout all users';
    setGlobalLogoutLoading(true);
    try {
      const res = await api.post('/security/logout-all', { reason });
      toast.success(res.data?.message || 'All users logged out');
      clearLocalLoginState();
      logout();
      navigate('/login', { replace: true });
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to log out all users');
    } finally {
      setGlobalLogoutLoading(false);
    }
  };

  const handleLogoutUser = async (target: SecurityUser) => {
    if (!confirm(`Log ${target.name} out now? They will need to sign back in on desktop or mobile.`)) return;
    const reason = window.prompt('Reason for security history', `Security logout: ${target.name}`) || `Security logout: ${target.name}`;
    setUserLogoutId(target.id);
    try {
      const res = await api.post(`/security/users/${target.id}/logout`, { reason });
      toast.success(res.data?.message || `${target.name} logged out`);
      if (target.id === currentUser?.id) {
        clearLocalLoginState();
        logout();
        navigate('/login', { replace: true });
        return;
      }
      await loadSecurity(true);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to log out user');
    } finally {
      setUserLogoutId(null);
    }
  };

  const handleLogoutSession = async (target: SecurityUser, session: SecuritySession) => {
    const ipLabel = session.ip_address || 'unknown IP';
    if (!confirm(`Log out this ${session.client_label} session for ${target.name} at ${ipLabel}?`)) return;
    const reason = window.prompt('Reason for security history', `Security logout session: ${target.name} ${ipLabel}`) || `Security logout session: ${target.name}`;
    setSessionLogoutId(session.id);
    try {
      const res = await api.post(`/security/sessions/${session.id}/logout`, { reason });
      toast.success(res.data?.message || 'Session logged out');
      if (session.is_current_session) {
        clearLocalLoginState();
        logout();
        navigate('/login', { replace: true });
        return;
      }
      await loadSecurity(true);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to log out session');
    } finally {
      setSessionLogoutId(null);
    }
  };

  if (loading) return <Loading message="Loading security controls..." />;

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5">
      <PageHeader
        title="Security"
        subtitle="Active sessions, mobile app access, and forced logout controls."
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => loadSecurity(true)}
              disabled={refreshing}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3.5 py-2.5 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-60"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button
              type="button"
              onClick={handleLogoutAll}
              disabled={globalLogoutLoading}
              className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-600 px-3.5 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-red-700 disabled:opacity-60"
            >
              <ShieldAlert className="w-4 h-4" />
              {globalLogoutLoading ? 'Logging out...' : 'Log Out All Users'}
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        {summaryCards.map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-gray-500">{label}</p>
                <p className="mt-1 text-2xl font-black text-gray-950">{value}</p>
              </div>
              <div className="flex h-11 w-11 items-center justify-center rounded-lg" style={{ background: bg, color }}>
                <Icon className="h-5 w-5" />
              </div>
            </div>
          </div>
        ))}
      </div>

      <section className="rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
          <div>
            <h2 className="text-base font-bold text-gray-950">Logged-In Users & Sessions</h2>
            <p className="text-sm text-gray-500">Each active desktop, mobile, and tablet session is shown separately with IP address and device details.</p>
          </div>
          <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-bold text-gray-600">
            {filteredSessionRows.length} of {sessionRows.length} session record{sessionRows.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="grid gap-3 border-b border-gray-100 bg-gray-50 px-4 py-3 lg:grid-cols-[1fr_auto_auto]">
          <label className="relative block">
            <span className="sr-only">Search sessions by user, IP, device, browser, or access method</span>
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              value={securitySearch}
              onChange={event => setSecuritySearch(event.target.value)}
              placeholder="Search user, IP, device, browser, or access method"
              className="min-h-11 w-full rounded-xl border border-gray-300 bg-white py-2.5 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>
          <select
            value={securityStatusFilter}
            onChange={event => setSecurityStatusFilter(event.target.value)}
            className="min-h-11 rounded-xl border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-label="Filter sessions by status"
          >
            <option value="">All statuses</option>
            <option value="online">Online now</option>
            <option value="recently_active">Recently active</option>
            <option value="signed_in">Signed in</option>
            <option value="offline">Offline</option>
          </select>
          <select
            value={securityClientFilter}
            onChange={event => setSecurityClientFilter(event.target.value)}
            className="min-h-11 rounded-xl border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-label="Filter sessions by client"
          >
            <option value="">All clients</option>
            <option value="desktop">Desktop</option>
            <option value="mobile_app">Mobile app</option>
            <option value="mobile">Mobile browser</option>
            <option value="tablet">Tablet</option>
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-gray-500">User</th>
                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-gray-500">Session Status</th>
                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-gray-500">Device & IP Address</th>
                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-gray-500">Last Activity</th>
                <th className="px-4 py-3 text-right text-xs font-bold uppercase tracking-wide text-gray-500">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {filteredSessionRows.map(({ user: row, session, index, total }) => {
                const status = statusCopy[session.security_status] || statusCopy.offline;
                const SessionIcon = sessionIcon(session);
                const lastSeen = session.last_seen_at || session.issued_at;
                return (
                  <tr key={session.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg bg-gray-100 text-sm font-black text-gray-700">
                          {row.avatar_url ? <img src={row.avatar_url} alt={row.name} className="h-full w-full object-cover" /> : row.name?.slice(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <p className="font-bold text-gray-950">{row.name}</p>
                          <p className="text-xs text-gray-500">{row.email}</p>
                          <p className="text-xs font-semibold text-gray-400">{roleLabels[row.role] || row.role}</p>
                          <p className="mt-1 text-[11px] font-bold text-blue-600">Session {index + 1} of {total}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="space-y-2">
                        <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-bold ${status.className}`}>
                          <span className="h-2 w-2 rounded-full" style={{ background: status.dot }} />
                          {status.label}
                        </span>
                        {session.is_current_session && (
                          <span className="block w-fit rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-blue-700">
                            Current admin session
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      <div className="flex items-start gap-3">
                        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-blue-100 bg-blue-50 text-blue-700">
                          <SessionIcon className="h-5 w-5" />
                        </div>
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full bg-gray-900 px-2 py-0.5 text-[11px] font-black text-white">
                              {session.client_label}
                            </span>
                            <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-bold text-gray-600">
                              {sessionAccessMethod(session)}
                            </span>
                          </div>
                          <p className="font-bold text-gray-950">IP: {session.ip_address || 'Not recorded'}</p>
                          <p className="text-xs font-semibold text-gray-600">{session.device_label}</p>
                          <p className="max-w-xl truncate text-xs text-gray-400" title={session.user_agent || ''}>
                            {truncateMiddle(session.user_agent || 'User agent not recorded')}
                          </p>
                          <p className="text-xs text-gray-500">
                            Trusted devices: {row.trusted_device_count} - One-touch: {row.quick_access_count}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-gray-800">{timeDistance(lastSeen)}</p>
                      <p className="text-xs text-gray-500">{formatDateTime(lastSeen)}</p>
                      <p className="mt-1 text-xs text-gray-400">Issued {formatDateTime(session.issued_at)}</p>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex flex-col items-end gap-2">
                        <button
                          type="button"
                          onClick={() => handleLogoutSession(row, session)}
                          disabled={sessionLogoutId === session.id}
                          className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700 hover:bg-red-100 disabled:opacity-60"
                        >
                          <LogOut className="h-4 w-4" />
                          {sessionLogoutId === session.id ? 'Logging out...' : 'Log Session Out'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleLogoutUser(row)}
                          disabled={userLogoutId === row.id}
                          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                        >
                          <UserX className="h-4 w-4" />
                          {userLogoutId === row.id ? 'Logging out...' : 'Log User Out'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filteredSessionRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-gray-500">
                    No session records match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {filteredSavedAccessRows.length > 0 && (
          <div className="border-t border-gray-200 bg-gray-50 px-4 py-3">
            <p className="mb-3 text-xs font-black uppercase tracking-wide text-gray-500">Saved access without an active session</p>
            <div className="grid gap-2 md:grid-cols-2">
              {filteredSavedAccessRows.map(row => (
                <div key={row.id} className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-gray-950">{row.name}</p>
                    <p className="truncate text-xs text-gray-500">{row.email}</p>
                    <p className="mt-1 text-xs text-gray-500">Trusted devices: {row.trusted_device_count} - One-touch: {row.quick_access_count}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleLogoutUser(row)}
                    disabled={userLogoutId === row.id}
                    className="inline-flex flex-shrink-0 items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700 hover:bg-red-100 disabled:opacity-60"
                  >
                    <UserX className="h-4 w-4" />
                    Clear Access
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-200 px-4 py-3">
          <h2 className="text-base font-bold text-gray-950">Security History</h2>
          <p className="text-sm text-gray-500">Forced logout actions are recorded here for management review.</p>
        </div>
        <div className="divide-y divide-gray-100">
          {events.map(event => (
            <div key={event.id} className="flex items-start gap-3 px-4 py-3">
              <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg bg-red-50 text-red-600">
                <AlertTriangle className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-bold text-gray-950">{actionLabels[event.action] || event.action.replace(/_/g, ' ')}</p>
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">{formatDateTime(event.created_at)}</span>
                </div>
                <p className="mt-1 text-sm text-gray-700">{eventDescription(event)}</p>
                <p className="mt-1 text-xs text-gray-500">
                  By {event.actor_name} ({event.actor_email}){event.reason ? ` · Reason: ${event.reason}` : ''}
                </p>
              </div>
            </div>
          ))}
          {events.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-gray-500">No security actions recorded yet.</div>
          )}
        </div>
      </section>
    </div>
  );
}
