import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Activity, Calendar, Camera, ClipboardList, DollarSign, FileText, ImagePlus, MessageSquare, Package, Users } from 'lucide-react';
import api from '../lib/api';
import { useAuthStore } from '../store/authStore';

interface Project {
  id: string;
  address: string;
  job_name?: string;
  status: string;
  budget?: number;
}


export default function MobileProjectHub() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [project, setProject] = useState<Project | null>(null);
  const [punchCount, setPunchCount] = useState(0);
  const [openCount, setOpenCount] = useState(0);
  const [invoiceCount, setInvoiceCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const managementUser = user?.role !== 'contractor';

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
        setOpenCount(items.filter((p: any) => p.status !== 'completed' && p.status !== 'rehab_completed' && p.status !== 'closed_sold').length);
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
            aria-label="Back to mobile home"
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
          <img src="/buildtrack-logo-mark.png" alt="BuildTrack" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', border: '2px solid #D99D26', flexShrink: 0 }} />
        </div>
        {/* Stage / Status strip */}
        <div style={{ display: 'flex', gap: 8, padding: '0 16px 12px', flexWrap: 'wrap' }}>

          <span style={{ backgroundColor: 'rgba(255,255,255,0.15)', color: 'white', borderRadius: 20, padding: '4px 12px', fontSize: 12, fontWeight: 600, textTransform: 'capitalize' }}>
            {project.status?.replace(/_/g, ' ')}
          </span>
          {project.budget && (
            <span style={{ backgroundColor: 'rgba(255,255,255,0.15)', color: 'white', borderRadius: 20, padding: '4px 12px', fontSize: 12, fontWeight: 600 }}>
              ${Number(project.budget).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          )}
        </div>
      </div>

      {/* Action Cards */}
      <div className="mobile-content" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ color: '#475569', fontSize: 13, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '4px 0 0' }}>
          Field actions
        </p>

        {managementUser && (
          <button
            onClick={() => navigate(`/mobile/project/${id}/field-work`)}
            style={{
              width: '100%',
              textAlign: 'left',
              background: 'linear-gradient(135deg, #1D4ED8, #0F766E)',
              color: 'white',
              borderRadius: 18,
              boxShadow: '0 12px 24px rgba(15,118,110,0.24)',
              padding: 20,
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              minHeight: 92,
            }}
            aria-label="Open field work tasks, notes, photos, and approvals"
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
              <div style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <ClipboardList size={28} color="white" />
              </div>
              <div style={{ minWidth: 0 }}>
                <p style={{ fontWeight: 950, color: 'white', fontSize: 18, margin: 0 }}>Field Work Status</p>
                <p style={{ color: 'rgba(255,255,255,0.84)', fontSize: 13, margin: '4px 0 0', lineHeight: 1.35 }}>Create scope tasks, add field notes, attach photos, and mark work ready for approval.</p>
              </div>
            </div>
            <ImagePlus size={26} color="white" style={{ flexShrink: 0 }} />
          </button>
        )}

        <button
          onClick={() => navigate(`/mobile/photos?projectId=${id}&camera=1`)}
          style={{
            width: '100%',
            textAlign: 'left',
            background: 'linear-gradient(135deg, #D99D26, #C4891F)',
            color: 'white',
            borderRadius: 18,
            boxShadow: '0 10px 22px rgba(217,157,38,0.26)',
            padding: 20,
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            minHeight: 88,
          }}
          aria-label="Take progress pictures"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Camera size={28} color="white" />
            </div>
            <div>
              <p style={{ fontWeight: 900, color: 'white', fontSize: 17, margin: 0 }}>Take Pictures</p>
              <p style={{ color: 'rgba(255,255,255,0.82)', fontSize: 13, margin: '4px 0 0' }}>Open the camera and upload a timestamped batch</p>
            </div>
          </div>
          <svg width="20" height="20" fill="none" stroke="white" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>

        <button
          onClick={() => navigate(`/mobile/photos?projectId=${id}`)}
          style={{ width: '100%', textAlign: 'left', backgroundColor: 'white', borderRadius: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', padding: 18, border: '1px solid #F3F4F6', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          aria-label="Upload progress photos from device"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 50, height: 50, borderRadius: 15, backgroundColor: '#FFFBEB', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Camera size={24} color="#D99D26" />
            </div>
            <div>
              <p style={{ fontWeight: 800, color: '#111827', fontSize: 15, margin: 0 }}>Upload Progress Photos</p>
              <p style={{ color: '#9CA3AF', fontSize: 12, margin: '4px 0 0' }}>Choose existing photos or videos from the device</p>
            </div>
          </div>
          <svg width="20" height="20" fill="none" stroke="#D1D5DB" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>

        {managementUser && (
          <>
            <p style={{ color: '#9CA3AF', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', margin: '8px 0 0' }}>
              Construction Operations
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
              {[
                { label: 'Schedule & Scope', text: 'Milestones, dependencies and rehab steps', Icon: Calendar, color: '#2563EB', bg: '#EFF6FF', to: `/projects/${id}#construction-plan` },
                { label: 'Budget & Quotes', text: 'Forecast costs and compare contractor quotes', Icon: DollarSign, color: '#059669', bg: '#ECFDF5', to: `/projects/${id}#quotes` },
                { label: 'Documents', text: 'Central files, downloads and uploads', Icon: FileText, color: '#7C3AED', bg: '#F5F3FF', to: '/documents' },
                { label: 'Resources', text: 'Assigned contractors and labor coverage', Icon: Users, color: '#0F766E', bg: '#CCFBF1', to: `/projects/${id}#assigned-contractors` },
                { label: 'Materials', text: 'Supplies, delivery timing and order status', Icon: Package, color: '#A16207', bg: '#FEF3C7', to: `/projects/${id}#construction-plan` },
                { label: 'Reports', text: 'Progress history and field activity', Icon: Activity, color: '#BE123C', bg: '#FFF1F2', to: `/projects/${id}#progress-history` },
                { label: 'Messaging', text: 'Text contractors and track responses', Icon: MessageSquare, color: '#4338CA', bg: '#EEF2FF', to: `/projects/${id}#texts` },
                { label: 'Safety & Quality', text: 'Issue capture, reviews and closeout', Icon: ClipboardList, color: '#EA580C', bg: '#FFEDD5', to: `/mobile/project/${id}/punch-list` },
              ].map(card => (
                <button
                  key={card.label}
                  type="button"
                  onClick={() => navigate(card.to)}
                  aria-label={`${card.label}: ${card.text}`}
                  style={{
                    minHeight: 112,
                    width: '100%',
                    textAlign: 'left',
                    backgroundColor: 'white',
                    borderRadius: 16,
                    border: '1px solid #F3F4F6',
                    boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
                    padding: 14,
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    gap: 10,
                  }}
                >
                  <span style={{ width: 42, height: 42, borderRadius: 13, backgroundColor: card.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <card.Icon size={21} color={card.color} />
                  </span>
                  <span>
                    <span style={{ display: 'block', color: '#111827', fontSize: 13, fontWeight: 900, lineHeight: 1.2 }}>{card.label}</span>
                    <span style={{ display: 'block', color: '#6B7280', fontSize: 11, lineHeight: 1.35, marginTop: 3 }}>{card.text}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {/* Punch List Card */}
        <button
          onClick={() => navigate(`/mobile/project/${id}/punch-list`)}
          style={{
            width: '100%',
            minHeight: 112,
            textAlign: 'left',
            background: 'linear-gradient(135deg, #111827 0%, #1F2937 100%)',
            borderRadius: 22,
            boxShadow: '0 16px 30px rgba(17,24,39,0.22)',
            padding: 20,
            border: '1px solid rgba(255,255,255,0.08)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 14,
          }}
          aria-label="Open field punch list and add multiple items with pictures"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
            <div style={{ width: 64, height: 64, borderRadius: 19, backgroundColor: 'rgba(217,157,38,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <ClipboardList size={32} color="#F7C96D" />
            </div>
            <div style={{ minWidth: 0 }}>
              <p style={{ color: '#F7C96D', fontSize: 12, fontWeight: 900, letterSpacing: '0.08em', textTransform: 'uppercase', margin: '0 0 5px' }}>Walk-through capture</p>
              <p style={{ fontWeight: 950, color: 'white', fontSize: 20, lineHeight: 1.12, margin: 0 }}>Create Field Punch List</p>
              <p style={{ color: '#D4DEE9', fontSize: 14, lineHeight: 1.35, margin: '6px 0 0' }}>Add multiple issues quickly and attach pictures to each item.</p>
              {punchCount === 0 ? (
                <p style={{ color: '#F7C96D', fontSize: 13, fontWeight: 850, margin: '8px 0 0' }}>No items yet - tap to start</p>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9, flexWrap: 'wrap' }}>
                  <span style={{ backgroundColor: 'rgba(255,255,255,0.12)', color: 'white', borderRadius: 20, padding: '4px 10px', fontSize: 12, fontWeight: 900 }}>{punchCount} items</span>
                  {openCount > 0 ? (
                    <span style={{ backgroundColor: '#F97316', color: 'white', borderRadius: 20, padding: '4px 10px', fontSize: 12, fontWeight: 900 }}>{openCount} open</span>
                  ) : (
                    <span style={{ backgroundColor: '#22c55e', color: 'white', borderRadius: 20, padding: '4px 10px', fontSize: 12, fontWeight: 900 }}>All done</span>
                  )}
                </div>
              )}
            </div>
          </div>
          <ImagePlus size={28} color="#F7C96D" style={{ flexShrink: 0 }} />
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

        {managementUser && (
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
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: '12px 16px', textAlign: 'center' }}>
        <p style={{ color: '#D1D5DB', fontSize: 11, margin: 0 }}>© 2026 New Urban Development</p>
      </div>
    </div>
  );
}
