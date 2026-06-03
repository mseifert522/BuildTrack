import { useState } from 'react';
import { useSearchParams, Link, useNavigate } from 'react-router-dom';
import api from '../lib/api';
import toast from 'react-hot-toast';

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { toast.error('Passwords do not match'); return; }
    if (password.length < 8) { toast.error('Password must be at least 8 characters'); return; }
    setLoading(true);
    try {
      await api.post('/auth/reset-password', { token, new_password: password });
      setDone(true);
      toast.success('Password reset successfully!');
      setTimeout(() => navigate('/login'), 3000);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6" style={{ background: '#F8F9FC' }}>
        <div className="text-center">
          <h2 className="text-xl font-bold text-gray-900 mb-2">Invalid Reset Link</h2>
          <p className="text-gray-500 text-sm mb-4">This link is invalid or has expired.</p>
          <Link to="/forgot-password" className="font-bold text-sm" style={{ color: '#D99D26' }}>Request a new reset link</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: '#F8F9FC' }}>
      <div className="w-full max-w-[420px]">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl overflow-hidden border-3 shadow-xl mx-auto mb-4" style={{ borderColor: '#D99D26' }}>
            <img src="/buildtrack-logo-mark.png" alt="BuildTrack" className="h-full w-full object-cover" />
          </div>
          <h2 className="text-2xl font-black text-gray-900">Set New Password</h2>
          <p className="text-gray-500 mt-2 text-sm">Choose a strong password for your account</p>
        </div>

        {done ? (
          <div className="bg-white rounded-2xl p-8 text-center" style={{ border: '2px solid #E5E7EB' }}>
            <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
              <svg className="w-7 h-7 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h3 className="font-bold text-gray-900 mb-2">Password Reset!</h3>
            <p className="text-sm text-gray-500">Redirecting you to sign in...</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">New Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={8}
                className="w-full px-4 py-4 bg-white rounded-2xl text-sm font-medium placeholder-gray-400 focus:outline-none"
                style={{ border: '2px solid #E5E7EB' }}
                placeholder="Minimum 8 characters"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Confirm Password</label>
              <input
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                required
                className="w-full px-4 py-4 bg-white rounded-2xl text-sm font-medium placeholder-gray-400 focus:outline-none"
                style={{ border: '2px solid #E5E7EB' }}
                placeholder="Repeat your password"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-4 rounded-2xl font-bold text-sm text-white"
              style={{ background: 'linear-gradient(135deg, #D99D26, #C4891F)', boxShadow: '0 8px 24px rgba(217,157,38,0.35)' }}
            >
              {loading ? 'Resetting...' : 'Reset Password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
