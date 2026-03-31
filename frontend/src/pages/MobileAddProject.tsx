import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api';
import toast from 'react-hot-toast';
import { useAuthStore, canCreateProjects } from '../store/authStore';
import GooglePlacesInput from '../components/GooglePlacesInput';

const STAGES = [
  { value: 'acquisition', label: 'Acquisition' },
  { value: 'planning', label: 'Planning' },
  { value: 'demo', label: 'Demo' },
  { value: 'framing', label: 'Framing' },
  { value: 'rough_ins', label: 'Rough-Ins' },
  { value: 'drywall', label: 'Drywall' },
  { value: 'finishes', label: 'Finishes' },
  { value: 'punch_out', label: 'Punch-Out' },
  { value: 'final', label: 'Final' },
  { value: 'complete', label: 'Complete' },
];

const STATUSES = [
  { value: 'active', label: 'Active', color: '#22c55e' },
  { value: 'pending', label: 'Pending', color: '#D99D26' },
  { value: 'on_hold', label: 'On Hold', color: '#ef4444' },
  { value: 'completed', label: 'Completed', color: '#6b7280' },
];

export default function MobileAddProject() {
  const navigate = useNavigate();
  const { user } = useAuthStore();

  // Form fields
  const [address, setAddress] = useState('');
  const [jobName, setJobName] = useState('');
  const [status, setStatus] = useState('active');
  const [stage, setStage] = useState('planning');
  const [startDate, setStartDate] = useState('');
  const [targetCompletion, setTargetCompletion] = useState('');
  const [budget, setBudget] = useState('');
  const [scopeOfWork, setScopeOfWork] = useState('');
  const [fieldNotes, setFieldNotes] = useState('');
  const [saving, setSaving] = useState(false);

  // Role guard
  if (!user || !canCreateProjects(user.role)) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: '#F4F5F7', padding: 24 }}>
        <div style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: '#FEF2F2', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
          <svg width="32" height="32" fill="none" stroke="#ef4444" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5.07 19H19a2 2 0 001.75-2.98L13.75 4a2 2 0 00-3.5 0L3.25 16.02A2 2 0 005.07 19z" />
          </svg>
        </div>
        <p style={{ color: '#111827', fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Access Restricted</p>
        <p style={{ color: '#6B7280', fontSize: 14, textAlign: 'center', marginBottom: 24 }}>Only Admins and Operations Managers can create projects.</p>
        <button onClick={() => navigate('/mobile')} style={{ backgroundColor: '#D99D26', color: 'white', border: 'none', borderRadius: 12, padding: '12px 24px', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>
          Back to Projects
        </button>
      </div>
    );
  }

  const handleSubmit = async () => {
    if (!address.trim()) { toast.error('Address is required'); return; }
    if (!jobName.trim()) { toast.error('Job name is required'); return; }
    setSaving(true);
    try {
      const res = await api.post('/projects', {
        address: address.trim(),
        job_name: jobName.trim(),
        status,
        project_stage: stage,
        start_date: startDate || undefined,
        target_completion: targetCompletion || undefined,
        budget: budget ? Number(budget) : undefined,
        scope_of_work: scopeOfWork.trim() || undefined,
        field_notes: fieldNotes.trim() || undefined,
      });
      toast.success('Project created!');
      navigate(`/mobile/project/${res.data.id}`);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to create project');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: '#F4F5F7' }}>
      {/* Header */}
      <div style={{ backgroundColor: '#181D25', boxShadow: '0 2px 8px rgba(0,0,0,0.3)', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 16px 16px' }}>
          <button
            onClick={() => navigate('/mobile')}
            style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, padding: 8, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
          >
            <svg width="20" height="20" fill="none" stroke="white" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div style={{ flex: 1 }}>
            <p style={{ color: 'white', fontWeight: 700, fontSize: 16, margin: 0 }}>New Project</p>
            <p style={{ color: '#D99D26', fontSize: 12, margin: '2px 0 0' }}>New Urban Development</p>
          </div>
          <img src="/nud-logo.jpg" alt="NUD" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', border: '2px solid #D99D26' }} />
        </div>
      </div>

      {/* Form */}
      <div style={{ flex: 1, padding: 16, paddingBottom: 32 }}>

        {/* Section: Basic Info */}
        <div style={{ marginBottom: 8 }}>
          <p style={{ color: '#9CA3AF', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', margin: '16px 0 10px' }}>
            Basic Information
          </p>
          <div style={{ backgroundColor: 'white', borderRadius: 16, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
            {/* Address */}
            <div style={{ padding: '14px 16px', borderBottom: '1px solid #F3F4F6' }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                Address *
              </label>
              <GooglePlacesInput
                value={address}
                onChange={setAddress}
                placeholder="123 Main St, Detroit, MI"
                style={{ width: '100%', border: 'none', outline: 'none', fontSize: 15, color: '#111827', backgroundColor: 'transparent', boxSizing: 'border-box' }}
              />
            </div>
            {/* Job Name */}
            <div style={{ padding: '14px 16px' }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                Job Name *
              </label>
              <input
                type="text"
                value={jobName}
                onChange={e => setJobName(e.target.value)}
                placeholder="e.g. Kitchen Renovation"
                style={{ width: '100%', border: 'none', outline: 'none', fontSize: 15, color: '#111827', backgroundColor: 'transparent', boxSizing: 'border-box' }}
              />
            </div>
          </div>
        </div>

        {/* Section: Status & Stage */}
        <div style={{ marginBottom: 8 }}>
          <p style={{ color: '#9CA3AF', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', margin: '16px 0 10px' }}>
            Status & Stage
          </p>

          {/* Status Selector */}
          <div style={{ backgroundColor: 'white', borderRadius: 16, padding: '14px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', marginBottom: 10 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
              Project Status
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {STATUSES.map(s => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setStatus(s.value)}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 12,
                    border: `2px solid ${status === s.value ? s.color : 'transparent'}`,
                    backgroundColor: status === s.value ? s.color + '18' : '#F9FAFB',
                    color: status === s.value ? s.color : '#6B7280',
                    fontWeight: 700,
                    fontSize: 13,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: status === s.value ? s.color : '#D1D5DB', flexShrink: 0 }} />
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Stage Selector */}
          <div style={{ backgroundColor: 'white', borderRadius: 16, padding: '14px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
              Project Stage
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {STAGES.map(s => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setStage(s.value)}
                  style={{
                    padding: '8px 14px',
                    borderRadius: 20,
                    border: 'none',
                    backgroundColor: stage === s.value ? '#D99D26' : '#F3F4F6',
                    color: stage === s.value ? 'white' : '#6B7280',
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Section: Dates & Budget */}
        <div style={{ marginBottom: 8 }}>
          <p style={{ color: '#9CA3AF', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', margin: '16px 0 10px' }}>
            Dates & Budget
          </p>
          <div style={{ backgroundColor: 'white', borderRadius: 16, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
            <div style={{ padding: '14px 16px', borderBottom: '1px solid #F3F4F6' }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                Start Date
              </label>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                style={{ width: '100%', border: 'none', outline: 'none', fontSize: 15, color: '#111827', backgroundColor: 'transparent', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ padding: '14px 16px', borderBottom: '1px solid #F3F4F6' }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                Target Completion
              </label>
              <input
                type="date"
                value={targetCompletion}
                onChange={e => setTargetCompletion(e.target.value)}
                style={{ width: '100%', border: 'none', outline: 'none', fontSize: 15, color: '#111827', backgroundColor: 'transparent', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ padding: '14px 16px' }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                Budget ($)
              </label>
              <input
                type="number"
                value={budget}
                onChange={e => setBudget(e.target.value)}
                placeholder="0.00"
                min="0"
                style={{ width: '100%', border: 'none', outline: 'none', fontSize: 15, color: '#111827', backgroundColor: 'transparent', boxSizing: 'border-box' }}
              />
            </div>
          </div>
        </div>

        {/* Section: Notes */}
        <div style={{ marginBottom: 8 }}>
          <p style={{ color: '#9CA3AF', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', margin: '16px 0 10px' }}>
            Notes
          </p>
          <div style={{ backgroundColor: 'white', borderRadius: 16, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
            <div style={{ padding: '14px 16px', borderBottom: '1px solid #F3F4F6' }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                Scope of Work
              </label>
              <textarea
                value={scopeOfWork}
                onChange={e => setScopeOfWork(e.target.value)}
                placeholder="Describe the work to be done..."
                rows={3}
                style={{ width: '100%', border: 'none', outline: 'none', fontSize: 15, color: '#111827', backgroundColor: 'transparent', resize: 'none', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ padding: '14px 16px' }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                Field Notes
              </label>
              <textarea
                value={fieldNotes}
                onChange={e => setFieldNotes(e.target.value)}
                placeholder="Field observations, access info, etc..."
                rows={3}
                style={{ width: '100%', border: 'none', outline: 'none', fontSize: 15, color: '#111827', backgroundColor: 'transparent', resize: 'none', boxSizing: 'border-box' }}
              />
            </div>
          </div>
        </div>

        {/* Submit Button */}
        <button
          onClick={handleSubmit}
          disabled={saving}
          style={{
            width: '100%',
            padding: '16px',
            borderRadius: 16,
            border: 'none',
            backgroundColor: saving ? '#E5C97A' : '#D99D26',
            color: 'white',
            fontWeight: 700,
            fontSize: 16,
            cursor: saving ? 'not-allowed' : 'pointer',
            marginTop: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            boxShadow: '0 4px 12px rgba(217,157,38,0.4)',
            transition: 'all 0.2s',
          }}
        >
          {saving ? (
            <>
              <div style={{ width: 18, height: 18, border: '2px solid white', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              Creating Project...
            </>
          ) : (
            <>
              <svg width="20" height="20" fill="none" stroke="white" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
              </svg>
              Create Project
            </>
          )}
        </button>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
