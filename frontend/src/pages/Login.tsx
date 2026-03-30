import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import api from '../lib/api';
import toast from 'react-hot-toast';

const isMobile = () =>
  /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
  window.innerWidth < 768;

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [stayLoggedIn, setStayLoggedIn] = useState(
    localStorage.getItem('stayLoggedIn') === 'true'
  );
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const { setAuth } = useAuthStore();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await api.post('/auth/login', { email, password });
      localStorage.setItem('stayLoggedIn', stayLoggedIn ? 'true' : 'false');
      setAuth(res.data.user, res.data.token);
      if (res.data.user.force_password_reset) {
        navigate('/change-password');
      } else if (isMobile()) {
        navigate('/mobile');
      } else {
        navigate('/');
      }
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Invalid credentials. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex" style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>
      {/* ── LEFT PANEL — Branding ── */}
      <div
        className="hidden lg:flex lg:w-[55%] relative flex-col justify-between p-12 overflow-hidden"
        style={{
          background: 'linear-gradient(145deg, #0D1117 0%, #181D25 40%, #1E2530 70%, #0D1117 100%)',
        }}
      >
        {/* Animated grid background */}
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage: `
              linear-gradient(rgba(217,157,38,0.8) 1px, transparent 1px),
              linear-gradient(90deg, rgba(217,157,38,0.8) 1px, transparent 1px)
            `,
            backgroundSize: '60px 60px',
          }}
        />

        {/* Glowing orbs */}
        <div
          className="absolute top-[-10%] right-[-5%] w-[500px] h-[500px] rounded-full opacity-[0.07]"
          style={{ background: 'radial-gradient(circle, #D99D26 0%, transparent 70%)' }}
        />
        <div
          className="absolute bottom-[-15%] left-[-10%] w-[600px] h-[600px] rounded-full opacity-[0.05]"
          style={{ background: 'radial-gradient(circle, #3B82F6 0%, transparent 70%)' }}
        />

        {/* Top logo */}
        <div className="relative z-10 flex items-center gap-4">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center shadow-2xl overflow-hidden border-2"
            style={{ borderColor: 'rgba(217,157,38,0.4)', background: 'rgba(217,157,38,0.1)' }}
          >
            <img src="/nud-logo.jpg" alt="NUD" className="w-full h-full object-cover" />
          </div>
          <div>
            <p className="text-white font-bold text-lg leading-tight tracking-tight">New Urban Development</p>
            <p className="text-xs font-medium tracking-widest uppercase" style={{ color: '#D99D26' }}>
              Field Operations Platform
            </p>
          </div>
        </div>

        {/* Center content */}
        <div className="relative z-10">
          <div
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold mb-8 tracking-wider uppercase"
            style={{ background: 'rgba(217,157,38,0.12)', border: '1px solid rgba(217,157,38,0.25)', color: '#D99D26' }}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
            Enterprise Construction Management
          </div>

          <h1 className="text-5xl font-black text-white leading-[1.1] mb-6 tracking-tight">
            Build smarter.<br />
            <span style={{ color: '#D99D26' }}>Track everything.</span>
          </h1>

          <p className="text-lg leading-relaxed mb-10" style={{ color: 'rgba(255,255,255,0.55)' }}>
            Unified field operations, punch list management, photo documentation, and invoicing — all in one platform built for construction professionals.
          </p>

          {/* Feature pills */}
          <div className="flex flex-wrap gap-3">
            {['Project Tracking', 'Punch Lists', 'Photo Docs', 'Invoice Management', 'Field Reports'].map(f => (
              <span
                key={f}
                className="px-4 py-2 rounded-full text-sm font-medium"
                style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: 'rgba(255,255,255,0.7)',
                }}
              >
                {f}
              </span>
            ))}
          </div>
        </div>

        {/* Bottom stats */}
        <div className="relative z-10 grid grid-cols-3 gap-6">
          {[
            { value: '100%', label: 'Mobile Ready' },
            { value: 'Real-time', label: 'Field Updates' },
            { value: 'Secure', label: 'Role-Based Access' },
          ].map(s => (
            <div key={s.label}>
              <p className="text-2xl font-black text-white mb-1">{s.value}</p>
              <p className="text-xs font-medium" style={{ color: 'rgba(255,255,255,0.4)' }}>{s.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── RIGHT PANEL — Login Form ── */}
      <div
        className="flex-1 flex flex-col items-center justify-center p-6 md:p-12 relative"
        style={{ background: '#F8F9FC' }}
      >
        {/* Mobile logo */}
        <div className="lg:hidden flex flex-col items-center mb-10">
          <div
            className="w-20 h-20 rounded-3xl overflow-hidden border-4 shadow-2xl mb-4"
            style={{ borderColor: '#D99D26' }}
          >
            <img src="/nud-logo.jpg" alt="NUD" className="w-full h-full object-cover" />
          </div>
          <h1 className="text-2xl font-black text-gray-900 text-center">New Urban Development</h1>
          <p className="text-sm font-semibold mt-1 tracking-wide" style={{ color: '#D99D26' }}>
            Field Operations Platform
          </p>
        </div>

        <div className="w-full max-w-[420px]">
          {/* Header */}
          <div className="mb-8">
            <h2 className="text-3xl font-black text-gray-900 tracking-tight">Welcome back</h2>
            <p className="text-gray-500 mt-2 text-sm">Sign in to your account to continue</p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Email */}
            <div>
              <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">
                Email Address
              </label>
              <div
                className="relative rounded-2xl transition-all duration-200"
                style={{
                  background: 'white',
                  border: `2px solid ${focusedField === 'email' ? '#D99D26' : '#E5E7EB'}`,
                  boxShadow: focusedField === 'email' ? '0 0 0 4px rgba(217,157,38,0.1)' : '0 1px 3px rgba(0,0,0,0.06)',
                }}
              >
                <div className="absolute left-4 top-1/2 -translate-y-1/2">
                  <svg className="w-5 h-5" style={{ color: focusedField === 'email' ? '#D99D26' : '#9CA3AF' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                </div>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  onFocus={() => setFocusedField('email')}
                  onBlur={() => setFocusedField(null)}
                  required
                  autoComplete="email"
                  className="w-full pl-12 pr-4 py-4 bg-transparent text-gray-900 text-sm font-medium placeholder-gray-400 focus:outline-none rounded-2xl"
                  placeholder="you@company.com"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">
                Password
              </label>
              <div
                className="relative rounded-2xl transition-all duration-200"
                style={{
                  background: 'white',
                  border: `2px solid ${focusedField === 'password' ? '#D99D26' : '#E5E7EB'}`,
                  boxShadow: focusedField === 'password' ? '0 0 0 4px rgba(217,157,38,0.1)' : '0 1px 3px rgba(0,0,0,0.06)',
                }}
              >
                <div className="absolute left-4 top-1/2 -translate-y-1/2">
                  <svg className="w-5 h-5" style={{ color: focusedField === 'password' ? '#D99D26' : '#9CA3AF' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  onFocus={() => setFocusedField('password')}
                  onBlur={() => setFocusedField(null)}
                  required
                  autoComplete="current-password"
                  className="w-full pl-12 pr-14 py-4 bg-transparent text-gray-900 text-sm font-medium placeholder-gray-400 focus:outline-none rounded-2xl"
                  placeholder="••••••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 p-1 rounded-lg transition-colors"
                  style={{ color: '#9CA3AF' }}
                >
                  {showPassword ? (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {/* Stay Logged In */}
            <div
              className="flex items-center justify-between p-4 rounded-2xl"
              style={{ background: 'white', border: '2px solid #E5E7EB' }}
            >
              <div>
                <p className="text-sm font-semibold text-gray-800">Keep me signed in</p>
                <p className="text-xs text-gray-400 mt-0.5">Stay logged in on this device</p>
              </div>
              <button
                type="button"
                onClick={() => setStayLoggedIn(!stayLoggedIn)}
                className="relative flex-shrink-0 ml-4 transition-all duration-300"
                style={{
                  width: 52,
                  height: 28,
                  borderRadius: 14,
                  backgroundColor: stayLoggedIn ? '#D99D26' : '#D1D5DB',
                }}
              >
                <span
                  className="absolute top-1 w-5 h-5 bg-white rounded-full shadow-md transition-all duration-300"
                  style={{ left: stayLoggedIn ? 28 : 4 }}
                />
              </button>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-4 rounded-2xl font-bold text-sm tracking-wide transition-all duration-200 text-white relative overflow-hidden"
              style={{
                background: loading
                  ? '#B8832A'
                  : 'linear-gradient(135deg, #D99D26 0%, #C4891F 50%, #D99D26 100%)',
                boxShadow: loading ? 'none' : '0 8px 24px rgba(217,157,38,0.35)',
                transform: loading ? 'scale(0.98)' : 'scale(1)',
              }}
            >
              {loading ? (
                <span className="flex items-center justify-center gap-3">
                  <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Authenticating...
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  Sign In to Platform
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                  </svg>
                </span>
              )}
            </button>
          </form>

          <p className="text-center text-xs text-gray-400 mt-8">
            © 2026 New Urban Development · All rights reserved
          </p>
        </div>
      </div>
    </div>
  );
}
