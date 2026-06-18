import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  ChevronDown,
  Clock,
  Database,
  Download,
  Eye,
  FileDown,
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
import { Loading, Modal, PageHeader } from '../components/ui';
import Avatar from '../components/Avatar';
import { useAuthStore, roleLabels } from '../store/authStore';
import { formatEasternDateTime, parseBuildTrackTimestamp } from '../lib/time';

type SecurityStatus = 'online' | 'recently_active' | 'signed_in' | 'offline';

interface SecuritySession {
  id: string;
  user_id: string;
  session_type: string;
  ip_address?: string | null;
  login_ip_address?: string | null;
  current_ip_address?: string | null;
  ip_address_updated_at?: string | null;
  user_agent?: string | null;
  issued_at?: string | null;
  last_seen_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  revoked_at?: string | null;
  revoke_reason?: string | null;
  revoked_by?: string | null;
  revoked_by_name?: string | null;
  archived_reason?: string | null;
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

interface ArchivedSecuritySession extends SecuritySession {
  user_name?: string | null;
  user_email?: string | null;
  user_role?: string | null;
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

interface DataAccessEvent {
  id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  user_role: string;
  action: string;
  access_type: string;
  entity_type: string;
  entity_id?: string | null;
  project_id?: string | null;
  project_address?: string | null;
  project_job_name?: string | null;
  record_count?: number | null;
  risk_level?: string | null;
  route?: string | null;
  method?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  details?: Record<string, any> | null;
  created_at: string;
}

interface DataAccessCounts {
  total_24h: number;
  downloads_24h: number;
  sensitive_views_24h: number;
  project_access_24h: number;
  vendor_supplier_access_24h: number;
}

interface SecuritySessionCounts {
  session_records: number;
  total_active_session_records: number;
  archived_session_records: number;
  online_sessions: number;
  recent_sessions: number;
  active_session_display_limit: number;
  archive_display_limit: number;
  desktop_idle_timeout_minutes: number;
  mobile_session_max_age_hours: number;
  session_archive_after_days: number;
}

type PendingSecurityAction =
  | { type: 'all' }
  | { type: 'user'; target: SecurityUser }
  | { type: 'session'; target: SecurityUser; session: SecuritySession };

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
  session_ip_changed: 'Session IP changed',
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
  if (event.action === 'session_ip_changed') {
    return 'A signed-in device changed networks; BuildTrack updated the current session IP while preserving the original login IP.';
  }
  return event.reason || 'Security event recorded.';
}

const dataAccessActionLabels: Record<string, string> = {
  project_list_viewed: 'Viewed project list',
  project_detail_viewed: 'Viewed project details',
  project_scopes_viewed: 'Viewed scope of work',
  project_construction_plan_viewed: 'Viewed field work plan',
  project_materials_viewed: 'Viewed project materials',
  project_activity_viewed: 'Viewed project activity',
  project_notes_viewed: 'Viewed project notes',
  user_directory_viewed: 'Viewed user directory',
  contractor_user_list_viewed: 'Viewed contractor users',
  contractor_directory_viewed: 'Viewed contractor directory',
  contractor_1099_sensitive_viewed: 'Revealed contractor 1099/ACH',
  contractor_notes_viewed: 'Viewed contractor notes',
  supplier_list_viewed: 'Viewed supplier list',
  documents_index_viewed: 'Viewed documents index',
  project_documents_viewed: 'Viewed project documents',
  project_document_downloaded: 'Downloaded project document',
  project_invoice_list_viewed: 'Viewed project invoices',
  invoice_admin_list_viewed: 'Viewed invoice list',
  invoice_detail_viewed: 'Viewed invoice details',
  invoice_attachment_viewed: 'Previewed invoice attachment',
  invoice_attachment_downloaded: 'Downloaded invoice attachment',
  invoice_pdf_downloaded: 'Downloaded invoice PDF',
};

const accessTypeCopy: Record<string, { label: string; className: string }> = {
  view: { label: 'View', className: 'border-blue-200 bg-blue-50 text-blue-700' },
  download: { label: 'Download', className: 'border-red-200 bg-red-50 text-red-700' },
  sensitive_view: { label: 'Sensitive view', className: 'border-amber-200 bg-amber-50 text-amber-700' },
};

function dataAccessRecordLabel(event: DataAccessEvent) {
  const details = event.details || {};
  return String(
    details.original_name
    || details.contractor_name
    || event.project_address
    || event.project_job_name
    || event.entity_id
    || event.entity_type.replace(/_/g, ' ')
  );
}

function dataAccessDetailText(event: DataAccessEvent) {
  const details = event.details || {};
  const items = [
    event.record_count !== null && event.record_count !== undefined ? `${event.record_count} record${Number(event.record_count) === 1 ? '' : 's'}` : '',
    details.document_type ? `Type: ${details.document_type}` : '',
    details.invoice_number ? `Invoice: ${details.invoice_number}` : '',
    details.total ? `Total: $${Number(details.total).toLocaleString()}` : '',
    details.viewed_fields ? `Fields: ${Array.isArray(details.viewed_fields) ? details.viewed_fields.join(', ') : details.viewed_fields}` : '',
    details.project_count ? `Projects: ${details.project_count}` : '',
    details.address ? `Project: ${details.address}` : '',
  ].filter(Boolean);
  return items.join(' | ') || 'No additional details recorded';
}

function CollapsibleSecuritySection({
  title,
  description,
  badge,
  children,
}: {
  title: string;
  description: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className="group rounded-lg border border-gray-200 bg-white shadow-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 marker:hidden">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-gray-950">{title}</h2>
          <p className="text-sm text-gray-500">{description}</p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {badge}
          <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-black text-blue-700">
            <span className="group-open:hidden">View full log</span>
            <span className="hidden group-open:inline">Hide log</span>
            <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
          </span>
        </div>
      </summary>
      <div className="border-t border-gray-200">
        {children}
      </div>
    </details>
  );
}

export default function Security() {
  const [users, setUsers] = useState<SecurityUser[]>([]);
  const [sessions, setSessions] = useState<SecuritySession[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<ArchivedSecuritySession[]>([]);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [dataAccessEvents, setDataAccessEvents] = useState<DataAccessEvent[]>([]);
  const [dataAccessCounts, setDataAccessCounts] = useState<DataAccessCounts>({
    total_24h: 0,
    downloads_24h: 0,
    sensitive_views_24h: 0,
    project_access_24h: 0,
    vendor_supplier_access_24h: 0,
  });
  const [securitySessionCounts, setSecuritySessionCounts] = useState<SecuritySessionCounts>({
    session_records: 0,
    total_active_session_records: 0,
    archived_session_records: 0,
    online_sessions: 0,
    recent_sessions: 0,
    active_session_display_limit: 10,
    archive_display_limit: 40,
    desktop_idle_timeout_minutes: 70,
    mobile_session_max_age_hours: 48,
    session_archive_after_days: 14,
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [globalLogoutLoading, setGlobalLogoutLoading] = useState(false);
  const [userLogoutId, setUserLogoutId] = useState<string | null>(null);
  const [sessionLogoutId, setSessionLogoutId] = useState<string | null>(null);
  const [securitySearch, setSecuritySearch] = useState('');
  const [securityStatusFilter, setSecurityStatusFilter] = useState('');
  const [securityClientFilter, setSecurityClientFilter] = useState('');
  const [pendingSecurityAction, setPendingSecurityAction] = useState<PendingSecurityAction | null>(null);
  const [securityReason, setSecurityReason] = useState('');
  const { user: currentUser, logout } = useAuthStore();
  const navigate = useNavigate();

  const usersById = useMemo(() => new Map(users.map(row => [row.id, row])), [users]);

  const sessionRows = useMemo(() => sessions
    .map(session => {
      const row = usersById.get(session.user_id);
      if (!row) return null;
      const userSessions = row.sessions || [];
      const index = userSessions.findIndex(item => item.id === session.id);
      return {
        user: row,
        session,
        index: index >= 0 ? index : 0,
        total: userSessions.length || 1,
      };
    })
    .filter((row): row is { user: SecurityUser; session: SecuritySession; index: number; total: number } => Boolean(row)),
    [sessions, usersById]
  );

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

  const filteredArchivedSessionRows = useMemo(() => {
    const q = securitySearch.trim().toLowerCase();
    return archivedSessions.filter(session => {
      if (securityClientFilter && session.client_type !== securityClientFilter && session.device_type !== securityClientFilter) return false;
      if (!q) return true;
      return [
        session.user_name,
        session.user_email,
        roleLabels[session.user_role || ''] || session.user_role,
        session.ip_address,
        session.client_label,
        session.device_label,
        session.os_label,
        session.browser_label,
        session.user_agent,
        session.archived_reason,
      ].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }, [archivedSessions, securityClientFilter, securitySearch]);

  const counts = useMemo(() => ({
    online: securitySessionCounts.online_sessions || sessions.filter(row => row.security_status === 'online').length,
    active: securitySessionCounts.recent_sessions || sessions.filter(row => ['online', 'recently_active'].includes(row.security_status)).length,
    signedIn: securitySessionCounts.total_active_session_records || sessions.length,
    quickAccess: users.reduce((sum, row) => sum + Number(row.quick_access_count || 0), 0),
  }), [securitySessionCounts, sessions, users]);

  const summaryCards: SummaryCard[] = [
    { label: 'Online sessions', value: counts.online, icon: ShieldCheck, color: '#059669', bg: '#ECFDF5' },
    { label: 'Sessions active last 15 min', value: counts.active, icon: Clock, color: '#D97706', bg: '#FFFBEB' },
    { label: 'Signed-in sessions', value: counts.signedIn, icon: LogOut, color: '#2563EB', bg: '#EFF6FF' },
    { label: 'One-touch app access', value: counts.quickAccess, icon: Smartphone, color: '#7C3AED', bg: '#F5F3FF' },
  ];

  const dataAccessCards: SummaryCard[] = [
    { label: 'Data access last 24h', value: dataAccessCounts.total_24h, icon: Database, color: '#2563EB', bg: '#EFF6FF' },
    { label: 'Downloads last 24h', value: dataAccessCounts.downloads_24h, icon: Download, color: '#DC2626', bg: '#FEF2F2' },
    { label: 'Sensitive views', value: dataAccessCounts.sensitive_views_24h, icon: Eye, color: '#D97706', bg: '#FFFBEB' },
    { label: 'Vendor/supplier access', value: dataAccessCounts.vendor_supplier_access_24h, icon: FileDown, color: '#0F766E', bg: '#F0FDFA' },
  ];

  const loadSecurity = async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      const [sessionsRes, eventsRes, dataAccessRes] = await Promise.all([
        api.get('/security/sessions', { params: { limit: 10, archive_limit: 40 } }),
        api.get('/security/events', { params: { limit: 10 } }),
        api.get('/security/data-access', { params: { limit: 120 } }),
      ]);
      setUsers(Array.isArray(sessionsRes.data?.users) ? sessionsRes.data.users : []);
      setSessions(Array.isArray(sessionsRes.data?.sessions) ? sessionsRes.data.sessions : []);
      setArchivedSessions(Array.isArray(sessionsRes.data?.archived_sessions) ? sessionsRes.data.archived_sessions : []);
      setSecuritySessionCounts({
        session_records: Number(sessionsRes.data?.counts?.session_records || 0),
        total_active_session_records: Number(sessionsRes.data?.counts?.total_active_session_records || sessionsRes.data?.counts?.session_records || 0),
        archived_session_records: Number(sessionsRes.data?.counts?.archived_session_records || 0),
        online_sessions: Number(sessionsRes.data?.counts?.online_sessions || 0),
        recent_sessions: Number(sessionsRes.data?.counts?.recent_sessions || 0),
        active_session_display_limit: Number(sessionsRes.data?.counts?.active_session_display_limit || 10),
        archive_display_limit: Number(sessionsRes.data?.counts?.archive_display_limit || 40),
        desktop_idle_timeout_minutes: Number(sessionsRes.data?.counts?.desktop_idle_timeout_minutes || 70),
        mobile_session_max_age_hours: Number(sessionsRes.data?.counts?.mobile_session_max_age_hours || 48),
        session_archive_after_days: Number(sessionsRes.data?.counts?.session_archive_after_days || 14),
      });
      setEvents(Array.isArray(eventsRes.data?.events) ? eventsRes.data.events : []);
      setDataAccessEvents(Array.isArray(dataAccessRes.data?.events) ? dataAccessRes.data.events : []);
      setDataAccessCounts({
        total_24h: Number(dataAccessRes.data?.counts?.total_24h || 0),
        downloads_24h: Number(dataAccessRes.data?.counts?.downloads_24h || 0),
        sensitive_views_24h: Number(dataAccessRes.data?.counts?.sensitive_views_24h || 0),
        project_access_24h: Number(dataAccessRes.data?.counts?.project_access_24h || 0),
        vendor_supplier_access_24h: Number(dataAccessRes.data?.counts?.vendor_supplier_access_24h || 0),
      });
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

  const requestLogoutAll = () => {
    setSecurityReason('Security logout all users');
    setPendingSecurityAction({ type: 'all' });
  };

  const requestLogoutUser = (target: SecurityUser) => {
    setSecurityReason(`Security logout: ${target.name}`);
    setPendingSecurityAction({ type: 'user', target });
  };

  const requestLogoutSession = (target: SecurityUser, session: SecuritySession) => {
    setSecurityReason(`Security logout session: ${target.name} ${session.ip_address || 'unknown IP'}`);
    setPendingSecurityAction({ type: 'session', target, session });
  };

  const confirmSecurityAction = async () => {
    if (!pendingSecurityAction) return;
    const reason = securityReason.trim() || 'Security action';
    const pending = pendingSecurityAction;
    setPendingSecurityAction(null);

    if (pending.type === 'all') {
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
      return;
    }

    if (pending.type === 'user') {
    const target = pending.target;
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
      return;
    }

    if (pending.type === 'session') {
    const { target, session } = pending;
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
    }
  };

  if (loading) return <Loading message="Loading security controls..." />;

  return (
    <div className="bt-desktop-page p-4 md:p-6 max-w-7xl mx-auto space-y-5">
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
              onClick={requestLogoutAll}
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

      <CollapsibleSecuritySection
        title="Data Access & Download Audit"
        description="Timestamped access to projects, vendors, suppliers, documents, invoice files, and contractor compliance data."
        badge={(
          <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-bold text-gray-600">
            {dataAccessEvents.length} recent record{dataAccessEvents.length === 1 ? '' : 's'}
          </span>
        )}
      >

        <div className="grid grid-cols-1 gap-3 border-b border-gray-100 bg-gray-50 px-4 py-3 md:grid-cols-4">
          {dataAccessCards.map(({ label, value, icon: Icon, color, bg }) => (
            <div key={label} className="rounded-lg border border-gray-200 bg-white p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-black uppercase tracking-wide text-gray-500">{label}</p>
                  <p className="mt-1 text-2xl font-black text-gray-950">{value}</p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg" style={{ background: bg, color }}>
                  <Icon className="h-5 w-5" />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-gray-500">Time</th>
                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-gray-500">User</th>
                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-gray-500">Access</th>
                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-gray-500">Record</th>
                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-gray-500">Route & IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {dataAccessEvents.map(event => {
                const accessType = accessTypeCopy[event.access_type] || { label: event.access_type.replace(/_/g, ' '), className: 'border-gray-200 bg-gray-50 text-gray-700' };
                return (
                  <tr key={event.id} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-4 py-3">
                      <p className="font-semibold text-gray-900">{formatDateTime(event.created_at)}</p>
                      <p className="text-xs text-gray-500">{timeDistance(event.created_at)}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-bold text-gray-950">{event.user_name}</p>
                      <p className="text-xs text-gray-500">{event.user_email}</p>
                      <p className="text-xs font-semibold text-gray-400">{roleLabels[event.user_role] || event.user_role}</p>
                    </td>
                    <td className="px-4 py-3">
                      <div className="space-y-1">
                        <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-bold capitalize ${accessType.className}`}>
                          {accessType.label}
                        </span>
                        <p className="font-bold text-gray-950">{dataAccessActionLabels[event.action] || event.action.replace(/_/g, ' ')}</p>
                        {event.risk_level === 'critical' && (
                          <p className="w-fit rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-red-700">
                            Critical
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <p className="max-w-xs truncate font-bold text-gray-950" title={dataAccessRecordLabel(event)}>
                        {dataAccessRecordLabel(event)}
                      </p>
                      <p className="text-xs text-gray-500">{event.entity_type.replace(/_/g, ' ')}</p>
                      <p className="max-w-sm text-xs text-gray-500">{dataAccessDetailText(event)}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-gray-900">IP: {event.ip_address || 'Not recorded'}</p>
                      <p className="max-w-md truncate text-xs text-gray-500" title={event.route || ''}>
                        {event.method || 'GET'} {event.route || 'Route not recorded'}
                      </p>
                      <p className="max-w-md truncate text-xs text-gray-400" title={event.user_agent || ''}>
                        {truncateMiddle(event.user_agent || 'User agent not recorded')}
                      </p>
                    </td>
                  </tr>
                );
              })}
              {dataAccessEvents.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-gray-500">
                    No data access records have been captured yet. New project, vendor, supplier, and download access will appear here.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CollapsibleSecuritySection>

      <CollapsibleSecuritySection
        title="Last 10 Logged-In Users & Sessions"
        description={`Desktop sessions are automatically logged out after ${securitySessionCounts.desktop_idle_timeout_minutes} minutes idle. Mobile sessions remain active up to ${securitySessionCounts.mobile_session_max_age_hours} hours.`}
        badge={(
          <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-bold text-gray-600">
            Showing {filteredSessionRows.length} of {counts.signedIn} active session{counts.signedIn === 1 ? '' : 's'}
          </span>
        )}
      >

        <div className="grid gap-3 border-b border-gray-100 bg-gray-50 px-4 py-3 lg:grid-cols-[1fr_auto_auto]">
          <label className="relative block">
            <span className="sr-only">Search sessions by user, IP, device, browser, or access method</span>
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              value={securitySearch}
              onChange={event => setSecuritySearch(event.target.value)}
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

        <div className="border-b border-amber-100 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-900">
          Stale desktop sessions are removed from this list after {securitySessionCounts.desktop_idle_timeout_minutes} minutes with no activity. Mobile app sessions are not affected by the desktop idle rule and are automatically logged out after {securitySessionCounts.mobile_session_max_age_hours} hours.
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
                const currentIp = session.current_ip_address || session.ip_address || '';
                const loginIp = session.login_ip_address || session.ip_address || '';
                const ipChanged = Boolean(currentIp && loginIp && currentIp !== loginIp);
                return (
                  <tr key={session.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar
                          src={row.avatar_url}
                          name={row.name}
                          size={40}
                          roundedClassName="rounded-lg"
                          fallbackClassName="text-gray-700"
                          fallbackStyle={{ background: '#F3F4F6' }}
                        />
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
                          <p className="font-bold text-gray-950">Current IP: {currentIp || 'Not recorded'}</p>
                          <p className="text-xs font-semibold text-gray-500">
                            Login IP: {loginIp || 'Not recorded'}
                            {ipChanged ? ' - network changed' : ''}
                          </p>
                          {session.ip_address_updated_at && (
                            <p className="text-[11px] font-semibold text-blue-600">
                              IP checked {formatDateTime(session.ip_address_updated_at)}
                            </p>
                          )}
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
                          <p className="mt-1 text-[11px] font-semibold text-gray-500">
                            {session.client_type === 'mobile_app'
                              ? `Mobile auto logout after ${securitySessionCounts.mobile_session_max_age_hours} hours`
                              : `Desktop idle logout after ${securitySessionCounts.desktop_idle_timeout_minutes} minutes`}
                          </p>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex flex-col items-end gap-2">
                        <button
                          type="button"
                          onClick={() => requestLogoutSession(row, session)}
                          disabled={sessionLogoutId === session.id}
                          className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700 hover:bg-red-100 disabled:opacity-60"
                        >
                          <LogOut className="h-4 w-4" />
                          {sessionLogoutId === session.id ? 'Logging out...' : 'Log Session Out'}
                        </button>
                        <button
                          type="button"
                          onClick={() => requestLogoutUser(row)}
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
                    onClick={() => requestLogoutUser(row)}
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
      </CollapsibleSecuritySection>

      <CollapsibleSecuritySection
        title="Past Sessions Archive"
        description={`Sessions older than ${securitySessionCounts.session_archive_after_days} days and terminated sessions are kept here for security review.`}
        badge={(
          <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-bold text-gray-600">
            Showing {filteredArchivedSessionRows.length} of {securitySessionCounts.archived_session_records} archived
          </span>
        )}
      >

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-gray-500">User</th>
                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-gray-500">Past Device</th>
                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-gray-500">Last Activity</th>
                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-gray-500">Archive Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {filteredArchivedSessionRows.map(session => {
                const SessionIcon = sessionIcon(session);
                const lastSeen = session.last_seen_at || session.issued_at || session.created_at;
                const currentIp = session.current_ip_address || session.ip_address || '';
                const loginIp = session.login_ip_address || session.ip_address || '';
                const ipChanged = Boolean(currentIp && loginIp && currentIp !== loginIp);
                return (
                  <tr key={`archive-${session.id}`} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <p className="font-bold text-gray-950">{session.user_name || 'Unknown user'}</p>
                      <p className="text-xs text-gray-500">{session.user_email || 'No email recorded'}</p>
                      <p className="text-xs font-semibold text-gray-400">{roleLabels[session.user_role || ''] || session.user_role || 'User'}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      <div className="flex items-start gap-3">
                        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 text-gray-600">
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
                          <p className="font-bold text-gray-950">Current IP: {currentIp || 'Not recorded'}</p>
                          <p className="text-xs font-semibold text-gray-500">
                            Login IP: {loginIp || 'Not recorded'}
                            {ipChanged ? ' - network changed' : ''}
                          </p>
                          <p className="text-xs font-semibold text-gray-600">{session.device_label}</p>
                          <p className="max-w-xl truncate text-xs text-gray-400" title={session.user_agent || ''}>
                            {truncateMiddle(session.user_agent || 'User agent not recorded')}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-gray-800">{timeDistance(lastSeen)}</p>
                      <p className="text-xs text-gray-500">{formatDateTime(lastSeen)}</p>
                      <p className="mt-1 text-xs text-gray-400">Issued {formatDateTime(session.issued_at)}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-bold text-gray-900">{session.archived_reason || session.revoke_reason || 'Past session'}</p>
                      {session.revoked_at && <p className="mt-1 text-xs text-gray-500">Revoked {formatDateTime(session.revoked_at)}</p>}
                      {session.revoked_by_name && <p className="mt-1 text-xs text-gray-400">By {session.revoked_by_name}</p>}
                    </td>
                  </tr>
                );
              })}
              {filteredArchivedSessionRows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-500">
                    No past sessions match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CollapsibleSecuritySection>

      <CollapsibleSecuritySection
        title="Security History"
        description="The last 10 security actions are shown here for management review."
        badge={(
          <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-bold text-gray-600">
            {events.length} recent action{events.length === 1 ? '' : 's'}
          </span>
        )}
      >
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
      </CollapsibleSecuritySection>

      <Modal
        isOpen={!!pendingSecurityAction}
        onClose={() => setPendingSecurityAction(null)}
        title="Confirm Security Action"
        description="This action affects active access. Enter a reason so the security history remains auditable."
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-red-200 bg-red-50 p-4">
            <p className="text-sm font-bold text-red-800">
              {pendingSecurityAction?.type === 'all'
                ? 'Log out all desktop and mobile users.'
                : pendingSecurityAction?.type === 'user'
                  ? `Log out ${pendingSecurityAction.target.name}.`
                  : pendingSecurityAction?.type === 'session'
                    ? `Terminate one ${pendingSecurityAction.session.client_label} session for ${pendingSecurityAction.target.name}.`
                    : 'Confirm this security action.'}
            </p>
            <p className="mt-1 text-sm text-red-700">
              Users affected by this action will need to authenticate again.
            </p>
          </div>

          <label className="block">
            <span className="mb-1 block text-sm font-bold text-gray-800">Reason for audit log *</span>
            <textarea
              value={securityReason}
              onChange={event => setSecurityReason(event.target.value)}
              rows={3}
              className="w-full resize-none rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Example: Terminating stale sessions after admin review"
            />
          </label>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setPendingSecurityAction(null)} className="bt-btn bt-btn-secondary">
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmSecurityAction}
              disabled={!securityReason.trim() || globalLogoutLoading || Boolean(userLogoutId) || Boolean(sessionLogoutId)}
              className="bt-btn bt-btn-danger disabled:opacity-50"
            >
              Confirm Action
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
