import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { useAuthStore, canManageUsers, canAccessSettings, isAdminRole } from './store/authStore';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Projects from './pages/Projects';
import ProjectDetail from './pages/ProjectDetail';
import PunchList from './pages/PunchList';
import Photos from './pages/Photos';
import Invoices from './pages/Invoices';
import InvoiceBuilder from './pages/InvoiceBuilder';
import Documents from './pages/Documents';
import Contractors from './pages/Contractors';
import Suppliers from './pages/Suppliers';
import Users from './pages/Users';
import Settings from './pages/Settings';
import ChangePassword from './pages/ChangePassword';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import MobileHome from './pages/MobileHome';
import MobileProjects from './pages/MobileProjects';
import MobileProjectHub from './pages/MobileProjectHub';
import MobilePunchList from './pages/MobilePunchList';
import MobileInvoice from './pages/MobileInvoice';
import MobileAddProject from './pages/MobileAddProject';
import MobileNotes from './pages/MobileNotes';
import MobileProgress from './pages/MobileProgress';
import PinLogin from './pages/PinLogin';
import ContractorHome from './pages/ContractorHome';
import ContractorProjects from './pages/ContractorProjects';
import ContractorInvoice from './pages/ContractorInvoice';
import ContractorProjectDetail from './pages/ContractorProjectDetail';

const SESSION_TIMEOUT_MS = 45 * 60 * 1000;

function clearContractorSession() {
  localStorage.removeItem('contractor_token');
  localStorage.removeItem('contractor_user');
  localStorage.removeItem('contractor_projects');
  localStorage.removeItem('contractor_session_started_at');
}

/** Redirect /mobile to the public mobile invoice app. */
function MobileRedirect() {
  window.location.href = 'https://invoices.newurbandev.com/app';
  return null;
}

/** After login, redirect to the right experience based on role */
function SmartHomeRedirect() {
  const { user } = useAuthStore();
  if (user?.role === 'contractor') {
    window.location.href = 'https://invoices.newurbandev.com/app';
    return null;
  }
  return <Navigate to="/dashboard" replace />;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, token } = useAuthStore();
  if (!token || !user) return <Navigate to="/login" replace />;
  if (user.force_password_reset) return <Navigate to="/change-password" replace />;
  return <>{children}</>;
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

  useEffect(() => {
    const checkSession = () => {
      const now = Date.now();
      const desktopToken = localStorage.getItem('token');
      const desktopStartedAt = Number(localStorage.getItem('auth_session_started_at') || now);
      if (desktopToken && now - desktopStartedAt >= SESSION_TIMEOUT_MS) {
        logout();
        navigate('/login', { replace: true });
        return;
      }

      const contractorToken = localStorage.getItem('contractor_token');
      const contractorStartedAt = Number(localStorage.getItem('contractor_session_started_at') || now);
      if (contractorToken && now - contractorStartedAt >= SESSION_TIMEOUT_MS) {
        clearContractorSession();
        navigate('/app', { replace: true });
      }
    };

    if (localStorage.getItem('token') && !localStorage.getItem('auth_session_started_at')) {
      localStorage.setItem('auth_session_started_at', String(Date.now()));
    }
    if (localStorage.getItem('contractor_token') && !localStorage.getItem('contractor_session_started_at')) {
      localStorage.setItem('contractor_session_started_at', String(Date.now()));
    }

    checkSession();
    const timer = window.setInterval(checkSession, 30000);
    return () => window.clearInterval(timer);
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

        {/* Root redirect — smart device detection */}
        <Route path="/" element={<ProtectedRoute><SmartHomeRedirect /></ProtectedRoute>} />

        {/* Mobile redirect to invoices.newurbandev.com/app */}
        <Route path="/mobile/*" element={<MobileRedirect />} />

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

        {/* Contractor App (invoices.newurbandev.com/app) */}
        <Route path="/app" element={<PinLogin />} />
        <Route path="/app/home" element={<ContractorHome />} />
        <Route path="/app/projects" element={<ContractorProjects />} />
        <Route path="/app/project/:id" element={<ContractorProjectDetail />} />
        <Route path="/app/invoice" element={<ContractorInvoice />} />

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
