import { useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useParams } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { useAuthStore, canManageUsers, canAccessSettings } from './store/authStore';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Projects from './pages/Projects';
import ProjectDetail from './pages/ProjectDetail';
import PunchList from './pages/PunchList';
import Photos from './pages/Photos';
import Invoices from './pages/Invoices';
import InvoiceBuilder from './pages/InvoiceBuilder';
import Contractors from './pages/Contractors';
import Suppliers from './pages/Suppliers';
import Users from './pages/Users';
import Settings from './pages/Settings';
import ChangePassword from './pages/ChangePassword';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import ContractorSetup from './pages/ContractorSetup';
import MobileHome from './pages/MobileHome';
import MobileProjects from './pages/MobileProjects';
import MobileProjectHub from './pages/MobileProjectHub';
import MobilePunchList from './pages/MobilePunchList';
import MobileInvoice from './pages/MobileInvoice';
import MobileAddProject from './pages/MobileAddProject';
import MobileNotes from './pages/MobileNotes';
import MobileProgress from './pages/MobileProgress';
import MobilePhotos from './pages/MobilePhotos';

const IDLE_TIMEOUT_MS = 45 * 60 * 1000;
const ACTIVITY_WRITE_INTERVAL_MS = 15 * 1000;
const TOKEN_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const AUTH_LAST_ACTIVITY_KEY = 'auth_last_activity_at';
const AUTH_LAST_REFRESH_KEY = 'auth_last_refresh_at';
const CONTRACTOR_LAST_ACTIVITY_KEY = 'contractor_last_activity_at';
const CONTRACTOR_LAST_REFRESH_KEY = 'contractor_last_refresh_at';

function clearContractorSession() {
  localStorage.removeItem('contractor_token');
  localStorage.removeItem('contractor_user');
  localStorage.removeItem('contractor_projects');
  localStorage.removeItem('contractor_session_started_at');
  localStorage.removeItem(CONTRACTOR_LAST_ACTIVITY_KEY);
  localStorage.removeItem(CONTRACTOR_LAST_REFRESH_KEY);
}

/** After login, redirect to the right experience based on role */
function SmartHomeRedirect() {
  const { user } = useAuthStore();
  if (user?.role === 'contractor') {
    return <Navigate to="/mobile" replace />;
  }
  return <Navigate to="/dashboard" replace />;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, token } = useAuthStore();
  if (!token || !user) return <Navigate to="/login" replace />;
  if (user.force_password_reset) return <Navigate to="/change-password" replace />;
  return <>{children}</>;
}

function MobileRoute({ children }: { children: React.ReactNode }) {
  const { user, token } = useAuthStore();
  if (!token || !user) return <Navigate to="/login" replace />;
  const isPinSession = user.role === 'contractor' && localStorage.getItem('contractor_token') === token;
  if (user.force_password_reset && !isPinSession) return <Navigate to="/change-password" replace />;
  return <>{children}</>;
}

function LegacyMobileProjectRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={id ? `/mobile/project/${id}` : '/mobile'} replace />;
}

/** Redirect contractors away from desktop — they should use mobile */
function DesktopRoute({ children }: { children: React.ReactNode }) {
  const { user, token } = useAuthStore();
  if (!token || !user) return <Navigate to="/login" replace />;
  if (user.force_password_reset) return <Navigate to="/change-password" replace />;
  if (user.role === 'contractor') return <Navigate to="/mobile" replace />;
  return <>{children}</>;
}

/** Only super_admin and operations_manager can access Users page */
function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, token } = useAuthStore();
  if (!token || !user) return <Navigate to="/login" replace />;
  if (user.force_password_reset) return <Navigate to="/change-password" replace />;
  if (!canManageUsers(user.role)) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

/** Only super_admin and operations_manager can access Settings page */
function SettingsRoute({ children }: { children: React.ReactNode }) {
  const { user, token } = useAuthStore();
  if (!token || !user) return <Navigate to="/login" replace />;
  if (user.force_password_reset) return <Navigate to="/change-password" replace />;
  if (!canAccessSettings(user.role)) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

function AuthRoute({ children }: { children: React.ReactNode }) {
  const { token, user } = useAuthStore();
  if (token && user && !user.force_password_reset) {
    return user.role === 'contractor'
      ? <Navigate to="/mobile" replace />
      : <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}

function SessionTimeout() {
  const navigate = useNavigate();
  const { token, logout } = useAuthStore();
  const refreshInFlight = useRef({ desktop: false, contractor: false });

  useEffect(() => {
    let lastActivityWrite = 0;

    const clearDesktopSession = () => {
      localStorage.removeItem(AUTH_LAST_ACTIVITY_KEY);
      localStorage.removeItem(AUTH_LAST_REFRESH_KEY);
      logout();
    };

    const markActivity = () => {
      const now = Date.now();
      if (now - lastActivityWrite < ACTIVITY_WRITE_INTERVAL_MS) return;
      lastActivityWrite = now;
      if (localStorage.getItem('token')) {
        localStorage.setItem(AUTH_LAST_ACTIVITY_KEY, String(now));
      }
      if (localStorage.getItem('contractor_token')) {
        localStorage.setItem(CONTRACTOR_LAST_ACTIVITY_KEY, String(now));
      }
    };

    const refreshSession = async (
      tokenKey: 'token' | 'contractor_token',
      refreshKey: string,
      userKey: 'user' | 'contractor_user',
      sessionType: 'desktop' | 'contractor'
    ) => {
      if (refreshInFlight.current[sessionType]) return;
      const currentToken = localStorage.getItem(tokenKey);
      if (!currentToken) return;

      refreshInFlight.current[sessionType] = true;
      try {
        const response = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { Authorization: `Bearer ${currentToken}` },
        });
        if (!response.ok) throw new Error('Refresh failed');
        const data = await response.json();
        if (data?.token) {
          localStorage.setItem(tokenKey, data.token);
          localStorage.setItem(refreshKey, String(Date.now()));
        }
        if (data?.user) {
          localStorage.setItem(userKey, JSON.stringify(data.user));
        }
      } catch {
        if (sessionType === 'desktop') {
          clearDesktopSession();
          navigate('/login', { replace: true });
        } else {
          clearContractorSession();
          navigate('/app', { replace: true });
        }
      } finally {
        refreshInFlight.current[sessionType] = false;
      }
    };

    const checkActiveSession = (
      tokenKey: 'token' | 'contractor_token',
      activityKey: string,
      refreshKey: string,
      userKey: 'user' | 'contractor_user',
      sessionType: 'desktop' | 'contractor'
    ) => {
      const now = Date.now();
      const activeToken = localStorage.getItem(tokenKey);
      if (!activeToken) return true;

      const lastActivity = Number(localStorage.getItem(activityKey) || now);
      if (!localStorage.getItem(activityKey)) {
        localStorage.setItem(activityKey, String(now));
      }

      if (now - lastActivity >= IDLE_TIMEOUT_MS) {
        if (sessionType === 'desktop') {
          clearDesktopSession();
          navigate('/login', { replace: true });
        } else {
          clearContractorSession();
          navigate('/app', { replace: true });
        }
        return false;
      }

      const lastRefresh = Number(localStorage.getItem(refreshKey) || 0);
      if (!lastRefresh || now - lastRefresh >= TOKEN_REFRESH_INTERVAL_MS) {
        void refreshSession(tokenKey, refreshKey, userKey, sessionType);
      }
      return true;
    };

    const checkSession = () => {
      if (!checkActiveSession('token', AUTH_LAST_ACTIVITY_KEY, AUTH_LAST_REFRESH_KEY, 'user', 'desktop')) return;
      checkActiveSession('contractor_token', CONTRACTOR_LAST_ACTIVITY_KEY, CONTRACTOR_LAST_REFRESH_KEY, 'contractor_user', 'contractor');
    };

    if (localStorage.getItem('token') && !localStorage.getItem(AUTH_LAST_ACTIVITY_KEY)) {
      localStorage.setItem(AUTH_LAST_ACTIVITY_KEY, String(Date.now()));
    }
    if (localStorage.getItem('contractor_token') && !localStorage.getItem(CONTRACTOR_LAST_ACTIVITY_KEY)) {
      localStorage.setItem(CONTRACTOR_LAST_ACTIVITY_KEY, String(Date.now()));
    }

    const activityEvents = ['mousemove', 'mousedown', 'keydown', 'scroll', 'wheel', 'touchstart', 'touchmove', 'pointerdown', 'input'];
    activityEvents.forEach(event => window.addEventListener(event, markActivity, { passive: true }));
    document.addEventListener('visibilitychange', markActivity);
    checkSession();
    const timer = window.setInterval(checkSession, 30000);
    return () => {
      window.clearInterval(timer);
      activityEvents.forEach(event => window.removeEventListener(event, markActivity));
      document.removeEventListener('visibilitychange', markActivity);
    };
  }, [token, logout, navigate]);

  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionTimeout />
      <Toaster
        position="top-center"
        toastOptions={{
          duration: 3000,
          style: {
            background: '#181D25',
            color: '#fff',
            borderRadius: '12px',
            fontSize: '14px',
            padding: '12px 16px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
          },
          success: { iconTheme: { primary: '#D99D26', secondary: '#fff' } },
          error: { iconTheme: { primary: '#ef4444', secondary: '#fff' } },
        }}
      />
      <Routes>
        {/* Auth */}
        <Route path="/login" element={<AuthRoute><Login /></AuthRoute>} />
        <Route path="/change-password" element={<ChangePassword />} />
        <Route path="/forgot-password" element={<AuthRoute><ForgotPassword /></AuthRoute>} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/contractor-setup" element={<ContractorSetup />} />

        {/* Root redirect — smart device detection */}
        <Route path="/" element={<ProtectedRoute><SmartHomeRedirect /></ProtectedRoute>} />

        {/* Mobile BuildTrack app */}
        <Route path="/mobile" element={<MobileRoute><MobileHome /></MobileRoute>} />
        <Route path="/mobile/projects" element={<MobileRoute><MobileProjects /></MobileRoute>} />
        <Route path="/mobile/photos" element={<MobileRoute><MobilePhotos /></MobileRoute>} />
        <Route path="/mobile/project/:id" element={<MobileRoute><MobileProjectHub /></MobileRoute>} />
        <Route path="/mobile/project/:id/punch-list" element={<MobileRoute><MobilePunchList /></MobileRoute>} />
        <Route path="/mobile/project/:id/invoice" element={<MobileRoute><MobileInvoice /></MobileRoute>} />
        <Route path="/mobile/project/:id/notes" element={<MobileRoute><MobileNotes /></MobileRoute>} />
        <Route path="/mobile/project/:id/progress" element={<MobileRoute><MobileProgress /></MobileRoute>} />
        <Route path="/mobile/add-project" element={<MobileRoute><MobileAddProject /></MobileRoute>} />
        <Route path="/mobile/*" element={<MobileRoute><Navigate to="/mobile" replace /></MobileRoute>} />

        {/* ── Desktop Routes (contractors are redirected to /mobile) ── */}
        <Route path="/dashboard" element={
          <DesktopRoute>
            <Layout><Dashboard /></Layout>
          </DesktopRoute>
        } />
        <Route path="/projects" element={
          <DesktopRoute>
            <Layout><Projects /></Layout>
          </DesktopRoute>
        } />
        <Route path="/projects/:id" element={
          <DesktopRoute>
            <Layout><ProjectDetail /></Layout>
          </DesktopRoute>
        } />
        <Route path="/projects/:projectId/invoices/new" element={
          <DesktopRoute>
            <Layout><InvoiceBuilder /></Layout>
          </DesktopRoute>
        } />
        <Route path="/projects/:projectId/invoices/:invoiceId" element={
          <DesktopRoute>
            <Layout><InvoiceBuilder /></Layout>
          </DesktopRoute>
        } />
        <Route path="/punch-list" element={
          <DesktopRoute>
            <Layout><PunchList /></Layout>
          </DesktopRoute>
        } />
        <Route path="/photos" element={
          <DesktopRoute>
            <Layout><Photos /></Layout>
          </DesktopRoute>
        } />
        <Route path="/invoices" element={
          <DesktopRoute>
            <Layout><Invoices /></Layout>
          </DesktopRoute>
        } />
        <Route path="/invoice-agent" element={<Navigate to="/invoices" replace />} />
        <Route path="/documents" element={
          <DesktopRoute>
            <Navigate to="/projects" replace />
          </DesktopRoute>
        } />
        <Route path="/contractors" element={
          <DesktopRoute>
            <Layout><Contractors /></Layout>
          </DesktopRoute>
        } />
        <Route path="/suppliers" element={
          <DesktopRoute>
            <Layout><Suppliers /></Layout>
          </DesktopRoute>
        } />
        {/* Users: super_admin and operations_manager only */}
        <Route path="/users" element={
          <AdminRoute>
            <Layout><Users /></Layout>
          </AdminRoute>
        } />
        {/* Settings: super_admin and operations_manager only */}
        <Route path="/settings" element={
          <SettingsRoute>
            <Layout><Settings /></Layout>
          </SettingsRoute>
        } />

        {/* Legacy contractor app entry points */}
        <Route path="/app" element={<AuthRoute><Login initialMode="pin" /></AuthRoute>} />
        <Route path="/app/home" element={<MobileRoute><Navigate to="/mobile" replace /></MobileRoute>} />
        <Route path="/app/projects" element={<MobileRoute><Navigate to="/mobile/projects" replace /></MobileRoute>} />
        <Route path="/app/project/:id" element={<MobileRoute><LegacyMobileProjectRedirect /></MobileRoute>} />
        <Route path="/app/invoice" element={<MobileRoute><Navigate to="/mobile" replace /></MobileRoute>} />

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
