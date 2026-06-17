import { Component, lazy, Suspense, useEffect, useRef, type ErrorInfo, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { useAuthStore, canManageUsers, canAccessSettings, canAccessSecurity } from './store/authStore';
import Layout from './components/Layout';
import GlobalImageLightbox from './components/GlobalImageLightbox';
import { Loading } from './components/ui';
import {
  isLegacyContractorAppPath,
  isLegacyMobilePath,
  isBuildTrackAppHost,
  isDesktopAppHost,
  isMobileAppHost,
  desktopExternalUrl,
  legacyMobilePathToMobileHostPath,
  mobileExternalUrl,
  mobilePath,
} from './lib/appUrls';
import { BUILDTRACK_TRUTH_ICON_SRC } from './lib/branding';

const Login = lazy(() => import('./pages/Login'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const OperationsCalendar = lazy(() => import('./pages/OperationsCalendar'));
const Projects = lazy(() => import('./pages/Projects'));
const ProjectDetail = lazy(() => import('./pages/ProjectDetail'));
const PunchList = lazy(() => import('./pages/PunchList'));
const Photos = lazy(() => import('./pages/Photos'));
const Invoices = lazy(() => import('./pages/Invoices'));
const InvoiceBuilder = lazy(() => import('./pages/InvoiceBuilder'));
const Contractors = lazy(() => import('./pages/Contractors'));
const Users = lazy(() => import('./pages/Users'));
const Settings = lazy(() => import('./pages/Settings'));
const Security = lazy(() => import('./pages/Security'));
const ChangePassword = lazy(() => import('./pages/ChangePassword'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const ContractorSetup = lazy(() => import('./pages/ContractorSetup'));
const VendorQuoteRequest = lazy(() => import('./pages/VendorQuoteRequest'));
const MobileHome = lazy(() => import('./pages/MobileHome'));
const MobileProjects = lazy(() => import('./pages/MobileProjects'));
const MobileProjectHub = lazy(() => import('./pages/MobileProjectHub'));
const MobilePunchList = lazy(() => import('./pages/MobilePunchList'));
const MobileInvoice = lazy(() => import('./pages/MobileInvoice'));
const MobileNotes = lazy(() => import('./pages/MobileNotes'));
const MobileProgress = lazy(() => import('./pages/MobileProgress'));
const MobilePhotos = lazy(() => import('./pages/MobilePhotos'));
const MobileFieldWork = lazy(() => import('./pages/MobileFieldWork'));
const MobileContractorPreview = lazy(() => import('./pages/MobileContractorPreview'));

const DESKTOP_SESSION_TIMEOUT_MS = 45 * 60 * 1000;
const ACTIVITY_WRITE_INTERVAL_MS = 15 * 1000;
const TOKEN_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const AUTH_SESSION_STARTED_KEY = 'auth_session_started_at';
const AUTH_LAST_ACTIVITY_KEY = 'auth_last_activity_at';
const AUTH_LAST_REFRESH_KEY = 'auth_last_refresh_at';
const CONTRACTOR_LAST_ACTIVITY_KEY = 'contractor_last_activity_at';
const CONTRACTOR_LAST_REFRESH_KEY = 'contractor_last_refresh_at';
const MOBILE_USER_AGENT_PATTERN = /android|iphone|ipad|ipod|mobile|tablet|silk|kindle|webos|blackberry|windows phone/i;
const ASSET_RELOAD_ATTEMPT_KEY = 'bt_asset_reload_attempted_at';

function isAssetLoadError(value: unknown) {
  const text = String(
    value instanceof Error
      ? `${value.name} ${value.message} ${value.stack || ''}`
      : value || ''
  );
  return /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed|modulepreload|Unable to preload CSS|error loading dynamically imported module/i.test(text);
}

function reloadForFreshAssets() {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  const lastAttempt = Number(sessionStorage.getItem(ASSET_RELOAD_ATTEMPT_KEY) || 0);
  if (now - lastAttempt < 30000) return;
  sessionStorage.setItem(ASSET_RELOAD_ATTEMPT_KEY, String(now));
  window.location.reload();
}

function RootErrorFallback({ error }: { error?: Error | null }) {
  const isAssetError = isAssetLoadError(error);
  return (
    <div className="min-h-screen bg-slate-950 px-4 py-10 text-white">
      <div className="mx-auto flex min-h-[70vh] max-w-lg flex-col justify-center">
        <div className="mb-5 flex items-center gap-3">
          <div className="h-12 w-12 overflow-hidden rounded-lg bg-slate-950" style={{ boxShadow: '0 0 0 1px rgba(245,183,49,0.38)' }}>
            <img src={BUILDTRACK_TRUTH_ICON_SRC} alt="BuildTrack" className="h-full w-full object-contain" />
          </div>
          <div>
            <p className="text-lg font-black">BuildTrack</p>
            <p className="text-xs font-bold uppercase tracking-wide text-amber-300">Session recovery</p>
          </div>
        </div>
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
          <h1 className="text-xl font-black">{isAssetError ? 'Refreshing BuildTrack' : 'BuildTrack needs a refresh'}</h1>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            {isAssetError
              ? 'A newer BuildTrack version is available. Refreshing loads the latest dashboard files.'
              : 'The dashboard hit a loading issue. Refreshing usually restores the session without logging you out.'}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 inline-flex min-h-11 items-center justify-center rounded-lg bg-amber-500 px-4 text-sm font-black text-slate-950 hover:bg-amber-400"
          >
            Refresh BuildTrack
          </button>
        </div>
      </div>
    </div>
  );
}

class BuildTrackErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[BuildTrack] Root render error:', error, info.componentStack);
    if (isAssetLoadError(error)) {
      window.setTimeout(reloadForFreshAssets, 100);
    }
  }

  render() {
    if (this.state.error) return <RootErrorFallback error={this.state.error} />;
    return this.props.children;
  }
}

function isMobileDeviceSession() {
  if (typeof window === 'undefined') return false;
  return isMobileAppHost()
    || isLegacyMobilePath(window.location.pathname)
    || isLegacyContractorAppPath(window.location.pathname)
    || MOBILE_USER_AGENT_PATTERN.test(window.navigator.userAgent || '');
}

function isLikelyMobileDevice() {
  if (typeof window === 'undefined') return false;
  const userAgent = window.navigator.userAgent || '';
  const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches || false;
  const compactViewport = window.matchMedia?.('(max-width: 1024px)').matches || false;
  const touchCapable = Number(window.navigator.maxTouchPoints || 0) > 1;

  return MOBILE_USER_AGENT_PATTERN.test(userAgent) || (compactViewport && (coarsePointer || touchCapable));
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
  if (isMobileAppHost() || user?.role === 'contractor') {
    return <Navigate to={mobilePath()} replace />;
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

function ManagementMobileRoute({ children }: { children: ReactNode }) {
  const { user, token } = useAuthStore();
  if (!token || !user) return <Navigate to="/login" replace />;
  if (user.force_password_reset) return <Navigate to="/change-password" replace />;
  if (user.role === 'contractor') return <Navigate to={mobilePath()} replace />;
  return <>{children}</>;
}

function UpperManagementMobileRoute({
  children,
  allowed,
}: {
  children: ReactNode;
  allowed: (role: string) => boolean;
}) {
  const { user, token } = useAuthStore();
  if (!token || !user) return <Navigate to="/login" replace />;
  if (user.force_password_reset) return <Navigate to="/change-password" replace />;
  if (!allowed(user.role)) return <Navigate to={mobilePath()} replace />;
  return <>{children}</>;
}

function LegacyMobilePathRedirect() {
  const location = useLocation();
  const destination = `${legacyMobilePathToMobileHostPath(location.pathname)}${location.search}${location.hash}`;
  return <Navigate to={destination} replace />;
}

function DesktopMobileAppRedirect() {
  const location = useLocation();

  useEffect(() => {
    const requestedPath = `${location.pathname}${location.search}${location.hash}`;
    window.location.replace(mobileExternalUrl(requestedPath));
  }, [location.hash, location.pathname, location.search]);

  return <Loading message="Opening BuildTrack mobile app..." />;
}

function DeviceHostRedirect() {
  const location = useLocation();

  useEffect(() => {
    if (!isBuildTrackAppHost()) return;

    const requestedPath = `${location.pathname}${location.search}${location.hash}`;
    const mobileDevice = isLikelyMobileDevice();
    const onMobileHost = isMobileAppHost();
    const onDesktopHost = isDesktopAppHost();
    const legacyMobilePath = isLegacyMobilePath(location.pathname) || isLegacyContractorAppPath(location.pathname);
    let destination = '';

    if (mobileDevice && onDesktopHost) {
      destination = mobileExternalUrl(requestedPath);
    } else if (!mobileDevice && onMobileHost) {
      destination = desktopExternalUrl(requestedPath);
    } else if (!mobileDevice && onDesktopHost && legacyMobilePath) {
      destination = desktopExternalUrl(requestedPath);
    } else if (mobileDevice && onMobileHost && legacyMobilePath) {
      destination = mobileExternalUrl(requestedPath);
    }

    if (destination && destination !== window.location.href) {
      window.location.replace(destination);
    }
  }, [location.hash, location.pathname, location.search]);

  return null;
}

/** Redirect contractors away from desktop — they should use mobile */
function DesktopRoute({ children }: { children: ReactNode }) {
  const { user, token } = useAuthStore();
  if (!token || !user) return <Navigate to="/login" replace />;
  if (user.force_password_reset) return <Navigate to="/change-password" replace />;
  if (isMobileAppHost() || user.role === 'contractor') return <Navigate to={mobilePath()} replace />;
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
    return isMobileAppHost() || user.role === 'contractor'
      ? <Navigate to={mobilePath()} replace />
      : <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}

function MobileLoginDesignPreview() {
  return <Login initialMode="pin" forceMobileLogin />;
}

function SessionTimeout() {
  const navigate = useNavigate();
  const { token, user, logout } = useAuthStore();
  const refreshInFlight = useRef({ desktop: false, contractor: false });

  useEffect(() => {
    let lastActivityWrite = 0;

    const clearDesktopSession = () => {
      localStorage.removeItem(AUTH_SESSION_STARTED_KEY);
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
          navigate(isMobileAppHost() ? '/login' : '/app', { replace: true });
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
      enforceDesktopTimeout: boolean
    ) => {
      const now = Date.now();
      const activeToken = localStorage.getItem(tokenKey);
      if (!activeToken) return true;

      if (!localStorage.getItem(activityKey)) {
        localStorage.setItem(activityKey, String(now));
      }

      if (enforceDesktopTimeout) {
        const startedAt = Number(localStorage.getItem(AUTH_SESSION_STARTED_KEY) || now);
        if (!localStorage.getItem(AUTH_SESSION_STARTED_KEY)) {
          localStorage.setItem(AUTH_SESSION_STARTED_KEY, String(startedAt));
        }
        if (now - startedAt >= DESKTOP_SESSION_TIMEOUT_MS) {
          clearDesktopSession();
          navigate('/login', { replace: true });
          return false;
        }
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
    if (localStorage.getItem('token') && !localStorage.getItem(AUTH_SESSION_STARTED_KEY)) {
      localStorage.setItem(AUTH_SESSION_STARTED_KEY, String(Date.now()));
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

    const isMobileContext = () => isMobileAppHost() || isLegacyMobilePath(window.location.pathname);

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

      if (isMobileContext() && start.scrollTop <= 2 && dy > 92 && mostlyVertical) {
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

function MobileHostRoutes() {
  return (
    <Routes>
      <Route path="/approval/mobile-contractor-preview" element={<MobileContractorPreview />} />
      <Route path="/approval/mobile-login-preview" element={<MobileLoginDesignPreview />} />

      {/* Auth */}
      <Route path="/login" element={<AuthRoute><Login initialMode="pin" /></AuthRoute>} />
      <Route path="/change-password" element={<ChangePassword />} />
      <Route path="/forgot-password" element={<AuthRoute><ForgotPassword /></AuthRoute>} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/contractor-setup" element={<ContractorSetup />} />
      <Route path="/vendor-quote/:token" element={<VendorQuoteRequest />} />

      {/* Mobile-first BuildTrack app on the dedicated mobile host */}
      <Route path="/" element={<MobileRoute><MobileHome /></MobileRoute>} />
      <Route path="/photos" element={<MobileRoute><MobilePhotos /></MobileRoute>} />
      <Route path="/project/:id" element={<MobileRoute><MobileProjectHub /></MobileRoute>} />
      <Route path="/project/:id/punch-list" element={<MobileRoute><MobilePunchList /></MobileRoute>} />
      <Route path="/project/:id/invoice" element={<MobileRoute><MobileInvoice /></MobileRoute>} />
      <Route path="/project/:id/notes" element={<MobileRoute><MobileNotes /></MobileRoute>} />
      <Route path="/project/:id/progress" element={<MobileRoute><MobileProgress /></MobileRoute>} />
      <Route path="/project/:id/field-work" element={<MobileRoute><MobileFieldWork /></MobileRoute>} />
      <Route path="/add-project" element={<MobileRoute><Navigate to="/" replace /></MobileRoute>} />

      {/* Legacy mobile paths are normalized on the mobile host. */}
      <Route path="/mobile/*" element={<MobileRoute><LegacyMobilePathRedirect /></MobileRoute>} />
      <Route path="/app" element={<AuthRoute><Login initialMode="pin" /></AuthRoute>} />
      <Route path="/app/*" element={<MobileRoute><LegacyMobilePathRedirect /></MobileRoute>} />

      {/* Management users can reach the full management surface from the mobile host. */}
      <Route path="/dashboard" element={<ManagementMobileRoute><Layout><Dashboard /></Layout></ManagementMobileRoute>} />
      <Route path="/operations-calendar" element={<ManagementMobileRoute><Layout><OperationsCalendar /></Layout></ManagementMobileRoute>} />
      <Route path="/projects" element={<ManagementMobileRoute><Layout><Projects /></Layout></ManagementMobileRoute>} />
      <Route path="/projects/:id" element={<ManagementMobileRoute><Layout><ProjectDetail /></Layout></ManagementMobileRoute>} />
      <Route path="/projects/:projectId/invoices/new" element={<ManagementMobileRoute><Layout><InvoiceBuilder /></Layout></ManagementMobileRoute>} />
      <Route path="/projects/:projectId/invoices/:invoiceId" element={<ManagementMobileRoute><Layout><InvoiceBuilder /></Layout></ManagementMobileRoute>} />
      <Route path="/punch-list" element={<ManagementMobileRoute><Layout><PunchList /></Layout></ManagementMobileRoute>} />
      <Route path="/desktop/photos" element={<ManagementMobileRoute><Layout><Photos /></Layout></ManagementMobileRoute>} />
      <Route path="/contractors" element={<ManagementMobileRoute><Layout><Contractors /></Layout></ManagementMobileRoute>} />
      <Route path="/suppliers" element={<ManagementMobileRoute><Layout><Contractors /></Layout></ManagementMobileRoute>} />
      <Route path="/invoices" element={<ManagementMobileRoute><Layout><Invoices /></Layout></ManagementMobileRoute>} />
      <Route path="/users" element={<UpperManagementMobileRoute allowed={canManageUsers}><Layout><Users /></Layout></UpperManagementMobileRoute>} />
      <Route path="/settings" element={<UpperManagementMobileRoute allowed={canAccessSettings}><Layout><Settings /></Layout></UpperManagementMobileRoute>} />
      <Route path="/security" element={<UpperManagementMobileRoute allowed={canAccessSecurity}><Layout><Security /></Layout></UpperManagementMobileRoute>} />

      <Route path="/documents" element={<Navigate to="/" replace />} />

      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

export default function App() {
  useEffect(() => {
    const path = window.location.pathname;
    if (isMobileAppHost() || /^\/(mobile|app)(\/|$)/.test(path)) {
      void import('./styles/mobile-heavy.css');
    }
  }, []);

  useEffect(() => {
    const handleWindowError = (event: ErrorEvent) => {
      const errorLike = event.error || event.message;
      if (!isAssetLoadError(errorLike)) return;
      event.preventDefault();
      reloadForFreshAssets();
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (!isAssetLoadError(event.reason)) return;
      event.preventDefault();
      reloadForFreshAssets();
    };

    window.addEventListener('error', handleWindowError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    return () => {
      window.removeEventListener('error', handleWindowError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, []);

  return (
    <BrowserRouter>
      <BuildTrackErrorBoundary>
        <DeviceHostRedirect />
        <SessionTimeout />
        <MobileGestureShortcuts />
        <GlobalImageLightbox />
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
        {isMobileAppHost() ? (
          <MobileHostRoutes />
        ) : (
        <Routes>
        <Route path="/approval/mobile-contractor-preview" element={<MobileContractorPreview />} />
        <Route path="/approval/mobile-login-preview" element={<MobileLoginDesignPreview />} />

        {/* Auth */}
        <Route path="/login" element={<AuthRoute><Login /></AuthRoute>} />
        <Route path="/change-password" element={<ChangePassword />} />
        <Route path="/forgot-password" element={<AuthRoute><ForgotPassword /></AuthRoute>} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/contractor-setup" element={<ContractorSetup />} />
        <Route path="/vendor-quote/:token" element={<VendorQuoteRequest />} />

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
        <Route path="/mobile/project/:id/field-work" element={<MobileRoute><MobileFieldWork /></MobileRoute>} />
        <Route path="/mobile/add-project" element={<MobileRoute><Navigate to="/mobile" replace /></MobileRoute>} />
        <Route path="/mobile/*" element={<MobileRoute><Navigate to="/mobile" replace /></MobileRoute>} />

        {/* ── Desktop Routes (contractors are redirected to /mobile) ── */}
        <Route path="/dashboard" element={
          <DesktopRoute>
            <Layout><Dashboard /></Layout>
          </DesktopRoute>
        } />
        <Route path="/operations-calendar" element={
          <DesktopRoute>
            <Layout><OperationsCalendar /></Layout>
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
        <Route path="/documents" element={<Navigate to="/dashboard" replace />} />
        <Route path="/contractors" element={
          <DesktopRoute>
            <Layout><Contractors /></Layout>
          </DesktopRoute>
        } />
        <Route path="/suppliers" element={
          <DesktopRoute>
            <Layout><Contractors /></Layout>
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

        {/* Legacy contractor app entry points now leave the desktop host. */}
        <Route path="/app" element={<DesktopMobileAppRedirect />} />
        <Route path="/app/*" element={<DesktopMobileAppRedirect />} />

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
        )}
        </Suspense>
      </BuildTrackErrorBoundary>
    </BrowserRouter>
  );
}
