import { useEffect, useState } from 'react';
import { useAuthStore, roleLabels } from '../store/authStore';
import api from '../lib/api';
import { Loading, Modal, PageHeader } from '../components/ui';
import { Users as UsersIcon, Plus, Edit2, Key, ToggleLeft, ToggleRight } from 'lucide-react';
import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { format } from 'date-fns';

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  phone: string;
  company: string;
  is_active: number;
  created_at: string;
}

export default function Users() {
  const { user: currentUser } = useAuthStore();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [resetUser, setResetUser] = useState<User | null>(null);
  const { register, handleSubmit, reset, setValue, formState: { isSubmitting } } = useForm();
  const { register: registerReset, handleSubmit: handleSubmitReset, reset: resetForm, formState: { isSubmitting: isResetting } } = useForm();

  const load = async () => {
    try {
      const res = await api.get('/users');
      setUsers(res.data);
    } catch (err) {
      toast.error('Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const onCreateUser = async (data: any) => {
    try {
      const res = await api.post('/users', data);
      toast.success(`User created! ${res.data.message}`);
      setShowCreate(false);
      reset();
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to create user');
    }
  };

  const onEditUser = async (data: any) => {
    if (!editUser) return;
    try {
      await api.put(`/users/${editUser.id}`, data);
      toast.success('User updated');
      setEditUser(null);
      reset();
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update user');
    }
  };

  const onResetPassword = async (data: any) => {
    if (!resetUser) return;
    try {
      const res = await api.post(`/users/${resetUser.id}/reset-password`, data);
      toast.success(res.data.message);
      setResetUser(null);
      resetForm();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to reset password');
    }
  };

  const toggleActive = async (user: User) => {
    try {
      await api.put(`/users/${user.id}`, { ...user, is_active: user.is_active ? 0 : 1 });
      toast.success(user.is_active ? 'User deactivated' : 'User activated');
      load();
    } catch (err) {
      toast.error('Failed to update user');
    }
  };

  const roleColors: Record<string, string> = {
    super_admin: 'bg-red-100 text-red-700',
    operations_manager: 'bg-blue-100 text-blue-700',
    admin_assistant: 'bg-purple-100 text-purple-700',
    contractor: 'bg-green-100 text-green-700',
  };

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <PageHeader
        title="User Management"
        subtitle={`${users.length} users`}
        actions={
          <button onClick={() => setShowCreate(true)} className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-xl font-medium text-sm hover:bg-blue-700 transition-colors shadow-sm">
            <Plus className="w-4 h-4" /> Add User
          </button>
        }
      />

      {loading ? <Loading /> : (
        <div className="space-y-3">
          {users.map(u => (
            <div key={u.id} className={`bg-white rounded-xl border p-4 flex items-center gap-3 ${!u.is_active ? 'opacity-60 border-gray-200' : 'border-gray-200'}`}>
              <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${u.is_active ? 'bg-blue-100' : 'bg-gray-100'}`}>
                <span className={`font-bold text-sm ${u.is_active ? 'text-blue-700' : 'text-gray-500'}`}>{u.name?.[0]?.toUpperCase()}</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-semibold text-gray-900 text-sm">{u.name}</p>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${roleColors[u.role]}`}>{roleLabels[u.role]}</span>
                  {!u.is_active && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">Inactive</span>}
                </div>
                <p className="text-xs text-gray-500">{u.email}</p>
                {u.phone && <p className="text-xs text-gray-400">{u.phone}</p>}
                <p className="text-xs text-gray-400 mt-0.5">Joined {format(new Date(u.created_at), 'MMM d, yyyy')}</p>
              </div>
              {currentUser?.role === 'super_admin' && u.id !== currentUser.id && (
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => { setEditUser(u); Object.entries(u).forEach(([k, v]) => setValue(k, v)); }}
                    className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                    title="Edit user"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setResetUser(u)}
                    className="p-2 text-gray-400 hover:text-orange-600 hover:bg-orange-50 rounded-lg transition-colors"
                    title="Reset password"
                  >
                    <Key className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => toggleActive(u)}
                    className={`p-2 rounded-lg transition-colors ${u.is_active ? 'text-green-500 hover:text-red-500 hover:bg-red-50' : 'text-gray-400 hover:text-green-500 hover:bg-green-50'}`}
                    title={u.is_active ? 'Deactivate user' : 'Activate user'}
                  >
                    {u.is_active ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create User Modal */}
      <Modal isOpen={showCreate} onClose={() => { setShowCreate(false); reset(); }} title="Add New User">
        <form onSubmit={handleSubmit(onCreateUser)} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Full Name *</label>
            <input {...register('name', { required: true })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="John Smith" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
            <input type="email" {...register('email', { required: true })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="john@example.com" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Role *</label>
            <select {...register('role', { required: true })} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
              <option value="">Select role...</option>
              <option value="contractor">Contractor</option>
              <option value="admin_assistant">Admin Assistant</option>
              <option value="operations_manager">Operations Manager</option>
              <option value="super_admin">Super Admin</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
            <input {...register('phone')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="+1 (555) 000-0000" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Company</label>
            <input {...register('company')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Company name" />
          </div>
          <div className="bg-blue-50 rounded-lg p-3 text-xs text-blue-700">
            A temporary password (TempPass2026!) will be set. The user will be prompted to change it on first login.
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={() => { setShowCreate(false); reset(); }} className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">
              {isSubmitting ? 'Creating...' : 'Create User'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit User Modal */}
      <Modal isOpen={!!editUser} onClose={() => { setEditUser(null); reset(); }} title="Edit User">
        <form onSubmit={handleSubmit(onEditUser)} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
            <input {...register('name')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input type="email" {...register('email')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
            <select {...register('role')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
              <option value="contractor">Contractor</option>
              <option value="admin_assistant">Admin Assistant</option>
              <option value="operations_manager">Operations Manager</option>
              <option value="super_admin">Super Admin</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
            <input {...register('phone')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Company</label>
            <input {...register('company')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={() => { setEditUser(null); reset(); }} className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">
              {isSubmitting ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Reset Password Modal */}
      <Modal isOpen={!!resetUser} onClose={() => { setResetUser(null); resetForm(); }} title={`Reset Password — ${resetUser?.name}`}>
        <form onSubmit={handleSubmitReset(onResetPassword)} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">New Password</label>
            <input type="password" {...registerReset('new_password')} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Leave blank for TempPass2026!" />
          </div>
          <div className="bg-yellow-50 rounded-lg p-3 text-xs text-yellow-700">
            The user will be required to change their password on next login.
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={() => { setResetUser(null); resetForm(); }} className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={isResetting} className="flex-1 py-2.5 bg-orange-600 text-white rounded-xl text-sm font-semibold hover:bg-orange-700 disabled:opacity-50">
              {isResetting ? 'Resetting...' : 'Reset Password'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
