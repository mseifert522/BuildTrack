import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api';
import toast from 'react-hot-toast';

export default function PinLogin() {
  const [digits, setDigits] = useState(['', '', '', '', '']);
  const [loading, setLoading] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    // Check if already logged in
    const token = localStorage.getItem('contractor_token');
    if (token) navigate('/app/home');
    inputRefs.current[0]?.focus();
  }, []);

  const handleChange = (index: number, value: string) => {
    if (!/^\d*$/.test(value)) return;
    const newDigits = [...digits];
    newDigits[index] = value.slice(-1);
    setDigits(newDigits);

    if (value && index < 4) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when all 5 digits entered
    const pin = newDigits.join('');
    if (pin.length === 5 && newDigits.every(d => d)) {
      handleLogin(pin);
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handleLogin = async (pin: string) => {
    setLoading(true);
    try {
      const res = await api.post('/auth/pin-login', { pin });
      localStorage.setItem('contractor_token', res.data.token);
      localStorage.setItem('contractor_user', JSON.stringify(res.data.user));
      localStorage.setItem('contractor_projects', JSON.stringify(res.data.projects));
      const now = String(Date.now());
      localStorage.setItem('contractor_session_started_at', now);
      localStorage.setItem('contractor_last_activity_at', now);
      localStorage.setItem('contractor_last_refresh_at', now);
      navigate('/app/home');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Invalid PIN');
      setDigits(['', '', '', '', '']);
      inputRefs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(145deg, #0D1117 0%, #181D25 50%, #1E2530 100%)',
      padding: '24px 16px',
      boxSizing: 'border-box' as const,
      width: '100%',
      overflow: 'hidden',
    }}>
      {/* Company Branding */}
      <div style={{ marginBottom: 16, textAlign: 'center' }}>
        <img src="/nud-company-logo.png" alt="New Urban Development" style={{ height: 32, objectFit: 'contain', opacity: 0.7, marginBottom: 4 }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, fontWeight: 600, letterSpacing: 3, textTransform: 'uppercase', margin: 0 }}>
          New Urban Development
        </p>
      </div>

      {/* Logo */}
      <div style={{ marginBottom: 32, textAlign: 'center', width: '100%', maxWidth: 400 }}>
        <div style={{
          margin: '0 auto 24px',
          padding: '16px 20px',
          borderRadius: 24,
          border: '2px solid rgba(217,157,38,0.4)',
          background: 'rgba(217,157,38,0.06)',
          boxShadow: '0 12px 40px rgba(217,157,38,0.15), 0 0 0 1px rgba(255,255,255,0.03) inset',
          backdropFilter: 'blur(10px)',
          textAlign: 'center',
          width: '100%',
          maxWidth: 400,
          boxSizing: 'border-box' as const,
        }}>
          <img src="/buildtrack-logo.png" alt="BuildTrack" style={{ width: '100%', maxWidth: 380, objectFit: 'contain', display: 'block', margin: '0 auto' }} />
        </div>
        <p style={{ color: '#D99D26', fontSize: 14, fontWeight: 700, letterSpacing: 4, textTransform: 'uppercase', margin: '8px 0 0' }}>
          Contractor Portal
        </p>
      </div>

      {/* PIN Entry */}
      <div style={{
        background: 'rgba(255,255,255,0.05)',
        borderRadius: 24,
        padding: '32px 24px',
        width: '100%',
        maxWidth: 400,
        boxSizing: 'border-box' as const,
        border: '1px solid rgba(255,255,255,0.1)',
        backdropFilter: 'blur(20px)',
      }}>
        <p style={{ color: 'white', fontSize: 18, fontWeight: 700, textAlign: 'center', margin: '0 0 4px' }}>
          Enter Your PIN
        </p>
        <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: 13, textAlign: 'center', margin: '0 0 28px' }}>
          5-digit access code
        </p>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginBottom: 28 }}>
          {digits.map((digit, i) => (
            <input
              key={i}
              ref={el => { inputRefs.current[i] = el; }}
              type="tel"
              inputMode="numeric"
              maxLength={1}
              value={digit}
              onChange={e => handleChange(i, e.target.value)}
              onKeyDown={e => handleKeyDown(i, e)}
              disabled={loading}
              style={{
                width: '17%', maxWidth: 56, height: 64,
                borderRadius: 16,
                border: digit ? '2px solid #D99D26' : '2px solid rgba(255,255,255,0.15)',
                background: digit ? 'rgba(217,157,38,0.1)' : 'rgba(255,255,255,0.05)',
                color: 'white',
                fontSize: 28,
                fontWeight: 800,
                textAlign: 'center',
                outline: 'none',
                transition: 'all 0.2s',
              }}
            />
          ))}
        </div>

        {loading && (
          <div style={{ textAlign: 'center' }}>
            <div style={{
              width: 24, height: 24,
              border: '3px solid rgba(217,157,38,0.3)',
              borderTopColor: '#D99D26',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
              margin: '0 auto',
            }} />
            <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, marginTop: 12 }}>Verifying...</p>
          </div>
        )}
      </div>

      <p style={{ color: 'rgba(255,255,255,0.25)', fontSize: 11, marginTop: 32 }}>
        &copy; 2026 New Urban Development
      </p>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
