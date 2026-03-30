import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { useAuthStore } from './store/authStore';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Projects from './pages/Projects';
import ProjectDetail from './pages/ProjectDetail';
import PunchList from './pages/PunchList';
import Photos from './pages/Photos';
import Invoices from './pages/Invoices';
import InvoiceBuilder from './pages/InvoiceBuilder';
import Users from './pages/Users';
import Settings from './pages/Settings';
import ChangePassword from './pages/ChangePassword';
import MobileHome from './pages/MobileHome';
import MobileProjects from './pages/MobileProjects';
import MobileProjectHub from './pages/MobileProjectHub';
import MobilePunchList from './pages/MobilePunchList';
import MobileInvoice from './pages/MobileInvoice';
import MobileAddProject from './pages/MobileAddProject';
import MobileNotes from './pages/MobileNotes';
import MobileProgress from './pages/MobileProgress';

/** Detect if the current device is a mobile/tablet */
const isMobileDevice = () =>
  /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
  window.innerWidth < 768;

/** After login, redirect to the right experience based on device */
function SmartHomeRedirect() {
  if (isMobileDevice()) {
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

function AuthRoute({ children }: { children: React.ReactNode }) {
  const { token, user } = useAuthStore();
  if (token && user && !user.force_password_reset) {
    // Already logged in — send to right experience
    return isMobileDevice()
      ? <Navigate to="/mobile" replace />
      : <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
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

        {/* Root redirect — smart device detection */}
        <Route path="/" element={<ProtectedRoute><SmartHomeRedirect /></ProtectedRoute>} />

        {/* ── Mobile Routes (no sidebar layout) ── */}
        <Route path="/mobile" element={<ProtectedRoute><MobileHome /></ProtectedRoute>} />
        <Route path="/mobile/add-project" element={<ProtectedRoute><MobileAddProject /></ProtectedRoute>} />
        <Route path="/mobile/project/:id" element={<ProtectedRoute><MobileProjectHub /></ProtectedRoute>} />
        <Route path="/mobile/project/:id/punch-list" element={<ProtectedRoute><MobilePunchList /></ProtectedRoute>} />
        <Route path="/mobile/project/:id/invoice" element={<ProtectedRoute><MobileInvoice /></ProtectedRoute>} />
        <Route path="/mobile/project/:id/notes" element={<ProtectedRoute><MobileNotes /></ProtectedRoute>} />
        <Route path="/mobile/project/:id/progress" element={<ProtectedRoute><MobileProgress /></ProtectedRoute>} />

        {/* ── Desktop Routes (with enterprise sidebar layout) ── */}
        <Route path="/dashboard" element={
          <ProtectedRoute>
            <Layout><Dashboard /></Layout>
          </ProtectedRoute>
        } />
        <Route path="/projects" element={
          <ProtectedRoute>
            <Layout><Projects /></Layout>
          </ProtectedRoute>
        } />
        <Route path="/projects/:id" element={
          <ProtectedRoute>
            <Layout><ProjectDetail /></Layout>
          </ProtectedRoute>
        } />
        <Route path="/projects/:projectId/invoices/new" element={
          <ProtectedRoute>
            <Layout><InvoiceBuilder /></Layout>
          </ProtectedRoute>
        } />
        <Route path="/projects/:projectId/invoices/:invoiceId" element={
          <ProtectedRoute>
            <Layout><InvoiceBuilder /></Layout>
          </ProtectedRoute>
        } />
        <Route path="/punch-list" element={
          <ProtectedRoute>
            <Layout><PunchList /></Layout>
          </ProtectedRoute>
        } />
        <Route path="/photos" element={
          <ProtectedRoute>
            <Layout><Photos /></Layout>
          </ProtectedRoute>
        } />
        <Route path="/invoices" element={
          <ProtectedRoute>
            <Layout><Invoices /></Layout>
          </ProtectedRoute>
        } />
        <Route path="/users" element={
          <ProtectedRoute>
            <Layout><Users /></Layout>
          </ProtectedRoute>
        } />
        <Route path="/settings" element={
          <ProtectedRoute>
            <Layout><Settings /></Layout>
          </ProtectedRoute>
        } />

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
