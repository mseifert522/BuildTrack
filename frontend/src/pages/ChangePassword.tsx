import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import api from '../lib/api';
import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { Shield } from 'lucide-react';

export default function ChangePassword() {
  const { user, updateUser } = useAuthStore();
  const navigate = useNavigate();
  const { register, handleSubmit, formState: { isSubmitting } } = useForm();

  const onSubmit = async (data: any) => {
    if (data.new_password !== data.confirm_password) {
      toast.error('Passwords do not match');
      return;
    }
    if (data.new_password.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    try {
      await api.post('/auth/change-password', { new_password: data.new_password });
      updateUser({ force_password_reset: false });
      toast.success('Password changed! Welcome to the app.');
      navigate('/mobile');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to change password');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'linear-gradient(160deg, #181D25 0%, #2B303B 60%, #181D25 100%)' }}>
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-2xl p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 bg-orange-100 rounded-xl flex items-center justify-center">
              <Shield className="w-6 h-6 text-orange-600" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-900">Set Your Password</h1>
              <p className="text-sm text-gray-500">Welcome, {user?.name}! Please set a new password.</p>
            </div>
          </div>

          <div className="bg-orange-50 rounded-xl p-4 mb-6 text-sm text-orange-700">
            Your account was created with a temporary password. You must set a new password to continue.
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">New Password</label>
              <input
                type="password"
                {...register('new_password', { required: true })}
                className="w-full px-4 py-3 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Min. 8 characters"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Confirm Password</label>
              <input
                type="password"
                {...register('confirm_password', { required: true })}
                className="w-full px-4 py-3 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Confirm new password"
              />
            </div>
            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-3.5 bg-blue-600 text-white rounded-xl font-semibold text-sm hover:bg-blue-700 transition-all disabled:opacity-50 shadow-sm"
            >
              {isSubmitting ? 'Setting Password...' : 'Set Password & Continue'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
