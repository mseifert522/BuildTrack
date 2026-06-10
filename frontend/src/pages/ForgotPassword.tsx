import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../lib/api';
import { BUILDTRACK_TRUTH_ICON_SRC } from '../lib/branding';
import toast from 'react-hot-toast';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
      toast.success('If that email exists, a reset link has been sent.');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: '#F8F9FC' }}>
      <div className="w-full max-w-[420px]">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl overflow-hidden bg-slate-950 shadow-xl mx-auto mb-4" style={{ boxShadow: '0 14px 32px rgba(15, 23, 42, 0.18), 0 0 0 1px rgba(217,157,38,0.46)' }}>
            <img src={BUILDTRACK_TRUTH_ICON_SRC} alt="BuildTrack" className="h-full w-full object-contain" />
          </div>
          <h2 className="text-2xl font-black text-gray-900">Forgot Password</h2>
          <p className="text-gray-500 mt-2 text-sm">Enter your email and we'll send you a reset link</p>
        </div>

        {sent ? (
          <div className="bg-white rounded-2xl p-8 text-center" style={{ border: '2px solid #E5E7EB' }}>
            <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
              <svg className="w-7 h-7 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <h3 className="font-bold text-gray-900 mb-2">Check your email</h3>
            <p className="text-sm text-gray-500 mb-6">We sent a password reset link to <strong>{email}</strong></p>
            <Link to="/login" className="text-sm font-bold" style={{ color: '#D99D26' }}>Back to Sign In</Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Email Address</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                className="w-full px-4 py-4 bg-white rounded-2xl text-sm font-medium placeholder-gray-400 focus:outline-none"
                style={{ border: '2px solid #E5E7EB' }}
                placeholder="you@company.com"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-4 rounded-2xl font-bold text-sm text-white"
              style={{ background: 'linear-gradient(135deg, #D99D26, #C4891F)', boxShadow: '0 8px 24px rgba(217,157,38,0.35)' }}
            >
              {loading ? 'Sending...' : 'Send Reset Link'}
            </button>
            <p className="text-center text-sm">
              <Link to="/login" className="font-bold" style={{ color: '#D99D26' }}>Back to Sign In</Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
