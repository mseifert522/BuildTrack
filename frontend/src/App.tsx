import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useParams } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { useAuthStore, canManageUsers, canAccessSettings, canAccessSecurity } from './store/authStore';
import Layout from './components/Layout';
import { Loading } from './components/ui';

const Login = lazy(() => import('./pages/Login'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Projects = lazy(() => import('./pages/Projects'));
const ProjectDetail = lazy(() => import('./pages/ProjectDetail'));
const PunchList = lazy(() => import('./pages/PunchList'));
const Photos = lazy(() => import('./pages/Photos'));
const Invoices = lazy(() => import('./pages/Invoices'));
const InvoiceBuilder = lazy(() => import('./pages/InvoiceBuilder'));
const Contractors = lazy(() => import('./pages/Contractors'));
const Suppliers = lazy(() => import('./pages/Suppliers'));
const Users = lazy(() => import('./pages/Users'));
const Settings = lazy(() => import('./pages/Settings'));
const Security = lazy(() => import('./pages/Security'));
const ChangePassword = lazy(() => import('./pages/ChangePassword'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const ContractorSetup = lazy(() => import('./pages/ContractorSetup'));
const Documents = lazy(() => import('./pages/Documents'));
const MobileHome = lazy(() => import('./pages/MobileHome'));
const MobileProjects = lazy(() => import('./pages/MobileProjects'));
const MobileProjectHub = lazy(() => import('./pages/MobileProjectHub'));
const MobilePunchList = lazy(() => import('./pages/MobilePunchList'));
const MobileInvoice = lazy(() => import('./pages/MobileInvoice'));
const MobileAddProject = lazy(() => import('./pages/MobileAddProject'));
const MobileNotes = lazy(() => import('./pages/MobileNotes'));
const MobileProgress = lazy(() => import('./pages/MobileProgress'));
const MobilePhotos = lazy(() => import('./pages/MobilePhotos'));

const DESKTOP_IDLE_TIMEOUT_MS = 45 * 60 * 1000;
const ACTIVITY_WRITE_INTERVAL_MS = 15 * 1000;
const TOKEN_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const AUTH_LAST_ACTIVITY_KEY = 'auth_last_activity_at';
const AUTH_LAST_REFRESH_KEY = 'auth_last_refresh_at';
const CONTRACTOR_LAST_ACTIVITY_KEY = 'contractor_last_activity_at';
const CONTRACTOR_LAST_REFRESH_KEY = 'contractor_last_refresh_at';
const MOBILE_USER_AGENT_PATTERN = /android|iphone|ipad|ipod|mobile|tablet|silk|kindle|webos|blackberry|windows phone/i;

function isMobileDeviceSession() {
  if (typeof window === 'undefined') return false;
  return window.location.pathname.startsWith('/mobile')
    || window.location.pathname.startsWith('/app')
    || MOBILE_USER_AGENT_PATTERN.test(window.navigator.userAgent || '');
}

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

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, token } = useAuthStore();
  if (!token || !user) return <Navigate to="/login" replace />;
  if (user.force_password_reset) return <Navigate to="/change-password" replace />;
  return <>{children}</>;
}

function MobileRoute({ children }: { children: ReactNode }) {
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
function DesktopRoute({ children }: { children: ReactNode }) {
  const { user, token } = useAuthStore();
  if (!token || !user) return <Navigate to="/login" replace />;
  if (user.force_password_reset) return <Navigate to="/change-password" replace />;
  if (user.role === 'contractor') return <Navigate to="/mobile" replace />;
  return <>{children}</>;
}

/** Only super_admin and operations_manager can access Users page */
function AdminRoute({ children }: { children: ReactNode }) {
  const { user, token } = useAuthStore();
  if (!token || !user) return <Navigate to="/login" replace />;
  if (user.force_password_reset) return <Navigate to="/change-password" replace />;
  if (!canManageUsers(user.role)) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

/** Only super_admin and operations_manager can access Settings page */
function SettingsRoute({ children }: { children: ReactNode }) {
  const { user, token } = useAuthStore();
  if (!token || !user) return <Navigate to="/login" replace />;
  if (user.force_password_reset) return <Navigate to="/change-password" replace />;
  if (!canAccessSettings(user.role)) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

/** Only super_admin and operations_manager can access Security page */
function SecurityRoute({ children }: { children: ReactNode }) {
  const { user, token } = useAuthStore();
  if (!token || !user) return <Navigate to="/login" replace />;
  if (user.force_password_reset) return <Navigate to="/change-password" replace />;
  if (!canAccessSecurity(user.role)) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

function AuthRoute({ children }: { children: ReactNode }) {
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
  const { token, user, logout } = useAuthStore();
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
      sessionType: 'desktop' | 'contractor',
      enforceIdleTimeout: boolean
    ) => {
      const now = Date.now();
      const activeToken = localStorage.getItem(tokenKey);
      if (!activeToken) return true;

      const lastActivity = Number(localStorage.getItem(activityKey) || now);
      if (!localStorage.getItem(activityKey)) {
        localStorage.setItem(activityKey, String(now));
      }

      if (enforceIdleTimeout && now - lastActivity >= DESKTOP_IDLE_TIMEOUT_MS) {
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
      const activeToken = localStorage.getItem('token');
      const contractorToken = localStorage.getItem('contractor_token');
      const normalTokenIsMirroredContractorToken = Boolean(
        user?.role === 'contractor'
        && contractorToken
        && activeToken === contractorToken
      );

      if (!normalTokenIsMirroredContractorToken) {
        const enforceDesktopIdleTimeout = !isMobileDeviceSession() && user?.role !== 'contractor';
        if (!checkActiveSession('token', AUTH_LAST_ACTIVITY_KEY, AUTH_LAST_REFRESH_KEY, 'user', 'desktop', enforceDesktopIdleTimeout)) return;
      }

      checkActiveSession('contractor_token', CONTRACTOR_LAST_ACTIVITY_KEY, CONTRACTOR_LAST_REFRESH_KEY, 'contractor_user', 'contractor', false);
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
  }, [token, user?.role, logout, navigate]);

  return null;
}

function MobileGestureShortcuts() {
  const navigate = useNavigate();
  const startRef = useRef<{ x: number; y: number; scrollTop: number } | null>(null);

  useEffect(() => {
    const getScrollableTarget = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return document.querySelector('.mobile-content') as HTMLElement | null;
      return target.closest('.mobile-content') as HTMLElement | null
        || document.querySelector('.mobile-content') as HTMLElement | null;
    };

    const isMobileContext = () =>
      window.matchMedia?.('(max-width: 1023px)').matches || window.location.pathname.startsWith('/mobile');

    const handleTouchStart = (event: TouchEvent) => {
      if (!isMobileContext() || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const scroller = getScrollableTarget(event.target);
      startRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        scrollTop: scroller?.scrollTop ?? window.scrollY,
      };
    };

    const handleTouchEnd = (event: TouchEvent) => {
      const start = startRef.current;
      if (!start || !isMobileContext() || event.changedTouches.length !== 1) return;
      startRef.current = null;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      const mostlyHorizontal = Math.abs(dx) > Math.abs(dy) * 1.6;
      const mostlyVertical = Math.abs(dy) > Math.abs(dx) * 1.6;

      if (start.x <= 32 && dx > 78 && mostlyHorizontal && window.history.length > 1) {
        navigate(-1);
        return;
      }

      if (window.location.pathname.startsWith('/mobile') && start.scrollTop <= 2 && dy > 92 && mostlyVertical) {
        window.dispatchEvent(new CustomEvent('buildtrack:pull-refresh'));
      }
    };

    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchend', handleTouchEnd);
    };
  }, [navigate]);

  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionTimeout />
      <MobileGestureShortcuts />
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
      <Suspense fallback={<Loading message="Loading BuildTrack..." />}>
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
            <Layout><Documents /></Layout>
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
        <Route path="/security" element={
          <SecurityRoute>
            <Layout><Security /></Layout>
          </SecurityRoute>
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
      </Suspense>
    </BrowserRouter>
  );
}
