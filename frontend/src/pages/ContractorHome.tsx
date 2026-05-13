import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderOpen, FileText, LogOut } from 'lucide-react';
import api from '../lib/api';

export default function ContractorHome() {
  const navigate = useNavigate();
  const [user, setUser] = useState<any>(null);
  const [projects, setProjects] = useState<any[]>([]);

  useEffect(() => {
    const token = localStorage.getItem('contractor_token');
    if (!token) { navigate('/app'); return; }
    try {
      setUser(JSON.parse(localStorage.getItem('contractor_user') || 'null'));
      setProjects(JSON.parse(localStorage.getItem('contractor_projects') || '[]'));
      // Set API auth header for contractor session
      api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    } catch { navigate('/app'); }
  }, []);

  const logout = () => {
    localStorage.removeItem('contractor_token');
    localStorage.removeItem('contractor_user');
    localStorage.removeItem('contractor_projects');
    localStorage.removeItem('contractor_session_started_at');
    navigate('/app');
  };

  if (!user) return null;

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      background: '#F4F5F7',
    }}>
      {/* Header */}
      <div style={{
        background: 'linear-gradient(135deg, #0D1117, #181D25)',
        padding: '20px 20px 24px',
        borderRadius: '0 0 24px 24px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <img src="/buildtrack-logo.png" alt="BuildTrack" style={{ width: 40, height: 40, borderRadius: 12, border: '2px solid #D99D26', objectFit: 'cover' }} />
            <div>
              <p style={{ color: '#D99D26', fontSize: 10, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', margin: 0 }}>BuildTrack</p>
              <p style={{ color: 'white', fontSize: 16, fontWeight: 800, margin: 0 }}>{user.name}</p>
            </div>
          </div>
          <button onClick={logout} style={{
            background: 'rgba(255,255,255,0.1)',
            border: 'none',
            borderRadius: 12,
            padding: '10px 10px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
          }}>
            <LogOut size={18} color="rgba(255,255,255,0.6)" />
          </button>
        </div>
        <p style={{ color: 'rgba(255,255,255,0.25)', fontSize: 10, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase', margin: '0 0 4px' }}>New Urban Development</p>
        <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13, margin: 0 }}>
          {projects.length} project{projects.length !== 1 ? 's' : ''} assigned
        </p>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, padding: 20, display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 24 }}>
        {/* Projects Button */}
        <button
          onClick={() => navigate('/app/projects')}
          style={{
            background: 'white',
            border: 'none',
            borderRadius: 20,
            padding: '28px 24px',
            display: 'flex',
            alignItems: 'center',
            gap: 20,
            cursor: 'pointer',
            boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
            transition: 'all 0.2s',
            textAlign: 'left',
          }}
        >
          <div style={{
            width: 56, height: 56, borderRadius: 16,
            background: 'linear-gradient(135deg, #1E3A5F, #2563EB)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 12px rgba(37,99,235,0.3)',
            flexShrink: 0,
          }}>
            <FolderOpen size={24} color="white" />
          </div>
          <div>
            <p style={{ fontSize: 18, fontWeight: 800, color: '#111827', margin: 0 }}>Projects</p>
            <p style={{ fontSize: 13, color: '#6B7280', margin: '4px 0 0' }}>View your assigned projects</p>
          </div>
        </button>

        {/* Create Invoice Button */}
        <button
          onClick={() => navigate('/app/invoice')}
          style={{
            background: 'white',
            border: 'none',
            borderRadius: 20,
            padding: '28px 24px',
            display: 'flex',
            alignItems: 'center',
            gap: 20,
            cursor: 'pointer',
            boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
            transition: 'all 0.2s',
            textAlign: 'left',
          }}
        >
          <div style={{
            width: 56, height: 56, borderRadius: 16,
            background: 'linear-gradient(135deg, #D99D26, #C4891F)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 12px rgba(217,157,38,0.3)',
            flexShrink: 0,
          }}>
            <FileText size={24} color="white" />
          </div>
          <div>
            <p style={{ fontSize: 18, fontWeight: 800, color: '#111827', margin: 0 }}>Create Invoice</p>
            <p style={{ fontSize: 13, color: '#6B7280', margin: '4px 0 0' }}>Submit an invoice for a project</p>
          </div>
        </button>
      </div>

      <p style={{ textAlign: 'center', fontSize: 11, color: '#9CA3AF', padding: '16px 0' }}>
        &copy; 2026 New Urban Development
      </p>
    </div>
  );
}
