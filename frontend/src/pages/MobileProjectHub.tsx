import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../lib/api';
import { useAuthStore, canManageProjects } from '../store/authStore';

interface Project {
  id: string;
  address: string;
  job_name?: string;
  status: string;
  project_stage?: string;
  budget?: number;
}

const stageLabel: Record<string, string> = {
  acquisition: 'Acquisition', planning: 'Planning', demo: 'Demo',
  framing: 'Framing', rough_ins: 'Rough-Ins', drywall: 'Drywall',
  finishes: 'Finishes', punch_out: 'Punch-Out', final: 'Final', complete: 'Complete',
  electrical: 'Electrical', plumbing: 'Plumbing',
};

export default function MobileProjectHub() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const canManage = user ? canManageProjects(user.role) : false;
  const [project, setProject] = useState<Project | null>(null);
  const [punchCount, setPunchCount] = useState(0);
  const [openCount, setOpenCount] = useState(0);
  const [invoiceCount, setInvoiceCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api.get(`/projects/${id}`)
      .then((res) => {
        setProject(res.data);
        return Promise.all([
          api.get(`/projects/${id}/punch-list`).catch(() => ({ data: [] })),
          api.get(`/projects/${id}/invoices`).catch(() => ({ data: [] })),
        ]);
      })
      .then(([punchRes, invRes]) => {
        const items = Array.isArray(punchRes.data) ? punchRes.data : [];
        setPunchCount(items.length);
        setOpenCount(items.filter((p: any) => p.status !== 'completed').length);
        setInvoiceCount(Array.isArray(invRes.data) ? invRes.data.length : 0);
      })
      .catch((err) => {
        setError('Failed to load project. Please go back and try again.');
        console.error('Project load error:', err);
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="mobile-shell" style={{ alignItems: 'center', justifyContent: 'center', backgroundColor: '#F4F5F7' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 40, height: 40, border: '4px solid #D99D26', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 12px' }} />
          <p style={{ color: '#6B7280', fontSize: 14 }}>Loading project...</p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="mobile-shell" style={{ alignItems: 'center', justifyContent: 'center', backgroundColor: '#F4F5F7', padding: 24 }}>
        <p style={{ color: '#ef4444', marginBottom: 16, textAlign: 'center' }}>{error || 'Project not found.'}</p>
        <button
          onClick={() => navigate('/mobile')}
          style={{ backgroundColor: '#D99D26', color: 'white', border: 'none', borderRadius: 12, padding: '12px 24px', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}
        >
          Back to Projects
        </button>
      </div>
    );
  }

  return (
    <div className="mobile-shell" style={{ backgroundColor: '#F4F5F7' }}>
      {/* Header */}
      <div style={{ backgroundColor: '#181D25', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 16px 8px' }}>
          <button
            onClick={() => navigate('/mobile')}
            style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, padding: 8, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
          >
            <svg width="20" height="20" fill="none" stroke="white" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ color: 'white', fontWeight: 700, fontSize: 14, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {project.address}
            </p>
            {project.job_name && (
              <p style={{ color: '#D99D26', fontSize: 12, margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {project.job_name}
              </p>
            )}
          </div>
          <img src="/nud-logo.jpg" alt="NUD" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', border: '2px solid #D99D26', flexShrink: 0 }} />
        </div>
        {/* Stage / Status strip */}
        <div style={{ display: 'flex', gap: 8, padding: '0 16px 12px', flexWrap: 'wrap' }}>
          <span style={{ backgroundColor: '#D99D26', color: 'white', borderRadius: 20, padding: '4px 12px', fontSize: 12, fontWeight: 600 }}>
            {stageLabel[project.project_stage || ''] || project.project_stage || 'No Stage'}
          </span>
          <span style={{ backgroundColor: 'rgba(255,255,255,0.15)', color: 'white', borderRadius: 20, padding: '4px 12px', fontSize: 12, fontWeight: 600, textTransform: 'capitalize' }}>
            {project.status?.replace(/_/g, ' ')}
          </span>
          {project.budget && (
            <span style={{ backgroundColor: 'rgba(255,255,255,0.15)', color: 'white', borderRadius: 20, padding: '4px 12px', fontSize: 12, fontWeight: 600 }}>
              ${Number(project.budget).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      {/* Action Cards */}
      <div className="mobile-content" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ color: '#9CA3AF', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', margin: '4px 0 0' }}>
          Select Action
        </p>

        {/* Punch List Card */}
        <button
          onClick={() => navigate(`/mobile/project/${id}/punch-list`)}
          style={{ width: '100%', textAlign: 'left', backgroundColor: 'white', borderRadius: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', padding: 20, border: '1px solid #F3F4F6', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: '#FEF3C7', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="28" height="28" fill="none" stroke="#D99D26" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
            </div>
            <div>
              <p style={{ fontWeight: 700, color: '#111827', fontSize: 16, margin: 0 }}>Punch List</p>
              {punchCount === 0 ? (
                <p style={{ color: '#9CA3AF', fontSize: 13, margin: '4px 0 0' }}>No items yet — tap to create</p>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <span style={{ color: '#6B7280', fontSize: 13 }}>{punchCount} items</span>
                  {openCount > 0 ? (
                    <span style={{ backgroundColor: '#ef4444', color: 'white', borderRadius: 20, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>{openCount} open</span>
                  ) : (
                    <span style={{ backgroundColor: '#22c55e', color: 'white', borderRadius: 20, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>All done</span>
                  )}
                </div>
              )}
            </div>
          </div>
          <svg width="20" height="20" fill="none" stroke="#D1D5DB" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>

        {/* Invoice Card */}
        <button
          onClick={() => navigate(`/mobile/project/${id}/invoice`)}
          style={{ width: '100%', textAlign: 'left', backgroundColor: 'white', borderRadius: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', padding: 20, border: '1px solid #F3F4F6', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: '#F0FDF4', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="28" height="28" fill="none" stroke="#16a34a" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div>
              <p style={{ fontWeight: 700, color: '#111827', fontSize: 16, margin: 0 }}>Invoice</p>
              {invoiceCount === 0 ? (
                <p style={{ color: '#9CA3AF', fontSize: 13, margin: '4px 0 0' }}>No invoices yet — tap to create</p>
              ) : (
                <p style={{ color: '#6B7280', fontSize: 13, margin: '4px 0 0' }}>{invoiceCount} invoice{invoiceCount !== 1 ? 's' : ''}</p>
              )}
            </div>
          </div>
          <svg width="20" height="20" fill="none" stroke="#D1D5DB" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>

        {/* Progress Card */}
        <button
          onClick={() => navigate(`/mobile/project/${id}/progress`)}
          style={{ width: '100%', textAlign: 'left', backgroundColor: 'white', borderRadius: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', padding: 20, border: '1px solid #F3F4F6', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: '#FDF4FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="28" height="28" fill="none" stroke="#a855f7" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <div>
              <p style={{ fontWeight: 700, color: '#111827', fontSize: 16, margin: 0 }}>Progress Photos</p>
              <p style={{ color: '#9CA3AF', fontSize: 13, margin: '4px 0 0' }}>Construction timeline with date stamps</p>
            </div>
          </div>
          <svg width="20" height="20" fill="none" stroke="#D1D5DB" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>

        {/* Notes Card */}
        <button
          onClick={() => navigate(`/mobile/project/${id}/notes`)}
          style={{ width: '100%', textAlign: 'left', backgroundColor: 'white', borderRadius: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', padding: 20, border: '1px solid #F3F4F6', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: '#F0FDF4', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="28" height="28" fill="none" stroke="#16a34a" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <div>
              <p style={{ fontWeight: 700, color: '#111827', fontSize: 16, margin: 0 }}>Notes</p>
              <p style={{ color: '#9CA3AF', fontSize: 13, margin: '4px 0 0' }}>Real-time team notes & updates</p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ background: 'rgba(34,197,94,0.1)', color: '#16a34a', borderRadius: 20, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>LIVE</span>
            <svg width="20" height="20" fill="none" stroke="#D1D5DB" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </div>
        </button>

        {/* Full Project View Card */}
        <button
          onClick={() => navigate(`/projects/${id}`)}
          style={{ width: '100%', textAlign: 'left', backgroundColor: 'white', borderRadius: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', padding: 20, border: '1px solid #F3F4F6', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: '#EFF6FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="28" height="28" fill="none" stroke="#3b82f6" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <p style={{ fontWeight: 700, color: '#111827', fontSize: 16, margin: 0 }}>Full Project View</p>
              <p style={{ color: '#9CA3AF', fontSize: 13, margin: '4px 0 0' }}>Photos, notes, details & more</p>
            </div>
          </div>
          <svg width="20" height="20" fill="none" stroke="#D1D5DB" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Footer */}
      <div style={{ padding: '12px 16px', textAlign: 'center' }}>
        <p style={{ color: '#D1D5DB', fontSize: 11, margin: 0 }}>© 2026 New Urban Development</p>
      </div>
    </div>
  );
}
