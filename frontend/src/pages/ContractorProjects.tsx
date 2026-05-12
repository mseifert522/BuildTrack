import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, MapPin, ChevronRight } from 'lucide-react';

export default function ContractorProjects() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<any[]>([]);

  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('contractor_token');
    if (!token) { navigate('/app'); return; }
    // Load cached first
    try {
      setProjects(JSON.parse(localStorage.getItem('contractor_projects') || '[]'));
    } catch {}
    // Fetch fresh
    import('../lib/api').then(({ default: api }) => {
      api.get('/projects', { headers: { Authorization: `Bearer ${token}` } })
        .then(res => {
          setProjects(res.data || []);
          localStorage.setItem('contractor_projects', JSON.stringify(res.data || []));
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    });
  }, []);

  const statusColors: Record<string, { bg: string; text: string; label: string }> = {
    active_rehab: { bg: '#DCFCE7', text: '#166534', label: 'Active Rehab' },
    rehab_completed: { bg: '#DBEAFE', text: '#1E40AF', label: 'Rehab Completed' },
    on_market: { bg: '#FEF3C7', text: '#92400E', label: 'On Market' },
    closed_sold: { bg: '#F3F4F6', text: '#374151', label: 'Closed' },
  };

  return (
    <div style={{ minHeight: '100vh', background: '#F4F5F7' }}>
      {/* Header */}
      <div style={{ background: '#181D25', padding: '16px 16px', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={() => navigate('/app/home')} style={{
            background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10,
            padding: 8, cursor: 'pointer', display: 'flex',
          }}>
            <ArrowLeft size={20} color="white" />
          </button>
          <p style={{ color: 'white', fontWeight: 700, fontSize: 16, margin: 0 }}>My Projects</p>
        </div>
      </div>

      {/* Project List */}
      <div style={{ padding: 16 }}>
        {projects.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 24px' }}>
            <MapPin size={40} color="#D1D5DB" style={{ margin: '0 auto 12px' }} />
            <p style={{ color: '#6B7280', fontWeight: 600 }}>No projects assigned</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {projects.map(p => {
              const status = statusColors[p.status] || statusColors.active_rehab;
              return (
                <div
                  key={p.id}
                  onClick={() => navigate(`/app/project/${p.id}`)}
                  style={{
                    background: 'white', borderRadius: 16, padding: '16px 16px',
                    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
                    display: 'flex', alignItems: 'center', gap: 14,
                    cursor: 'pointer',
                  }}
                >
                  <div style={{
                    width: 42, height: 42, borderRadius: 14,
                    background: 'rgba(37,99,235,0.08)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                    <MapPin size={18} color="#2563EB" />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 14, fontWeight: 700, color: '#111827', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.address}</p>
                    <p style={{ fontSize: 12, color: '#6B7280', margin: '2px 0 0' }}>{p.job_name}</p>
                    <span style={{
                      display: 'inline-block', marginTop: 6,
                      fontSize: 10, fontWeight: 700,
                      padding: '3px 10px', borderRadius: 20,
                      background: status.bg, color: status.text,
                    }}>{status.label}</span>
                  </div>
                  <ChevronRight size={18} color="#D1D5DB" style={{ flexShrink: 0 }} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
