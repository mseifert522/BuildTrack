import { useEffect, useState } from 'react';
import { useAuthStore, roleLabels, canManageUsers } from '../store/authStore';
import api from '../lib/api';
import { Loading, Modal, PageHeader } from '../components/ui';
import Avatar from '../components/Avatar';
import { Plus, Edit2, Key, Mail, ShieldOff, ShieldCheck, Camera, Trash2, Radio } from 'lucide-react';
import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { format, formatDistanceToNow } from 'date-fns';
import { fileDropHandlers } from '../lib/fileDrop';

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  phone: string;
  company: string;
  contractor_category?: string | null;
  contractor_secondary_category?: string | null;
  avatar_url: string | null;
  pin: string | null;
  is_active: number;
  is_online: number;
  last_seen_at?: string | null;
  last_login_at?: string | null;
  created_at: string;
}

const fallbackCategories = [
  'Floor',
  'Roof',
  'Electrical',
  'Plumbing',
  'Handymen',
  'Painting',
  'Drywall',
  'Concrete',
  'Cleaning',
  'Window Install',
  'Carpenter',
  'Carpet Installer',
  'Foundations',
  'Excavators',
  'Framing',
];

const roleLevel: Record<string, number> = {
  contractor: 0,
  project_manager: 1,
  operations_manager: 2,
  super_admin: 3,
};

const normalizeEmail = (value?: string | null) => String(value || '').trim().toLowerCase();
const isMikeSeifert = (user?: { email?: string } | null) => normalizeEmail(user?.email) === 'mike@seifertcapital.com';
const isProtectedJeanette = (user: User) => {
  const email = normalizeEmail(user.email);
  return email === 'jeanettemfallon@gmail.com' || (email.includes('fallon') && user.name.toLowerCase().includes('jeanette'));
};

export default function Users() {
  const { user: currentUser } = useAuthStore();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [resetUser, setResetUser] = useState<User | null>(null);
  const [resetSubmitting, setResetSubmitting] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [categories, setCategories] = useState<string[]>(fallbackCategories);
  const { register, handleSubmit, reset, setValue, formState: { isSubmitting } } = useForm();

  const canManage = currentUser ? canManageUsers(currentUser.role) : false;
  const canAddCategories = currentUser ? ['super_admin', 'operations_manager'].includes(currentUser.role) : false;
  const canManageUserRecord = (u: User) => {
    if (!canManage || !currentUser || u.id === currentUser.id) return false;
    if (isMikeSeifert(currentUser)) return true;
    return (roleLevel[currentUser.role] ?? -1) > (roleLevel[u.role] ?? -1);
  };
  const canDeleteUserRecord = (u: User) => canManageUserRecord(u) && (!isProtectedJeanette(u) || isMikeSeifert(currentUser));

  const load = async () => {
    try {
      const [usersRes, categoriesRes] = await Promise.all([
        api.get('/users'),
        api.get('/users/contractor-categories'),
      ]);
      setUsers(usersRes.data);
      setCategories(Array.isArray(categoriesRes.data?.categories) ? categoriesRes.data.categories : fallbackCategories);
    } catch (err) {
      toast.error('Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  const addCategory = async (field: string) => {
    const name = window.prompt('New contractor category');
    if (!name?.trim()) {
      setValue(field, '');
      return;
    }
    try {
      const res = await api.post('/users/contractor-categories', { name: name.trim() });
      setCategories(Array.isArray(res.data?.categories) ? res.data.categories : categories);
      setValue(field, res.data?.category || name.trim());
      toast.success('Category added');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to add category');
      setValue(field, '');
    }
  };

  const categorySelect = (field: 'contractor_category' | 'contractor_secondary_category', placeholder: string) => {
    const select = register(field);
    return (
      <select
        {...select}
        onChange={(event) => {
          if (event.target.value === '__add_new__') {
            addCategory(field);
            return;
          }
          select.onChange(event);
        }}
        className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
      >
        <option value="">{placeholder}</option>
        {categories.map(category => <option key={category} value={category}>{category}</option>)}
        {canAddCategories && <option value="__add_new__">+ Add category...</option>}
      </select>
    );
  };

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 30000);
    return () => window.clearInterval(timer);
  }, []);

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

  const handleAvatarUpload = async (userId: string, file: File) => {
    setUploadingAvatar(true);
    try {
      const formData = new FormData();
      formData.append('avatar', file);
      await api.post(`/users/${userId}/avatar`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success('Photo uploaded');
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to upload photo');
    } finally {
      setUploadingAvatar(false);
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

  const onResetPassword = async () => {
    if (!resetUser) return;
    setResetSubmitting(true);
    try {
      const res = await api.post(`/users/${resetUser.id}/reset-password`);
      toast.success(res.data.message);
      setResetUser(null);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to send password setup link');
    } finally {
      setResetSubmitting(false);
    }
  };

  const handleReinvite = async (u: User) => {
    try {
      const res = await api.post(`/users/${u.id}/reinvite`);
      toast.success(res.data.message || `Welcome email sent to ${u.email}`);
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to re-invite user');
    }
  };

  /** Delete from active access while preserving historical project and audit records. */
  const handleDelete = async (u: User) => {
    if (!confirm(`Delete ${u.name} from active BuildTrack access? Historical project and audit records will be preserved.`)) return;
    try {
      const res = await api.delete(`/users/${u.id}`);
      toast.success(res.data?.message || `${u.name} has been deleted`);
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to delete user');
    }
  };

  const handleLockout = async (u: User) => {
    if (!confirm(`Lock out ${u.name}? Their session will be terminated immediately.`)) return;
    try {
      await api.post(`/users/${u.id}/lockout`);
      toast.success(`${u.name} has been locked out`);
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to lock out user');
    }
  };

  /** Reactivate a locked user */
  const handleUnlock = async (u: User) => {
    try {
      await api.post(`/users/${u.id}/unlock`);
      toast.success(`${u.name} has been reactivated`);
      load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to unlock user');
    }
  };

  const roleColors: Record<string, string> = {
    super_admin: 'bg-red-100 text-red-700',
    operations_manager: 'bg-blue-100 text-blue-700',
    project_manager: 'bg-purple-100 text-purple-700',
    contractor: 'bg-green-100 text-green-700',
  };

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <PageHeader
        title="User Management"
        subtitle={`${users.length} users`}
        actions={
          canManage ? (
            <button onClick={() => setShowCreate(true)} className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-xl font-medium text-sm hover:bg-blue-700 transition-colors shadow-sm">
              <Plus className="w-4 h-4" /> Add User
            </button>
          ) : undefined
        }
      />

      {loading ? <Loading /> : (
        <div className="space-y-3">
          {users.map(u => (
            <div key={u.id} className={`bg-white rounded-xl border p-4 flex items-center gap-3 ${!u.is_active ? 'opacity-60 border-red-200 bg-red-50' : 'border-gray-200'}`}>
              <div className="relative flex-shrink-0">
                <Avatar
                  src={u.avatar_url}
                  name={u.name}
                  size={40}
                  roundedClassName="rounded-full"
                  fallbackClassName={u.is_active ? 'text-blue-700' : 'text-red-500'}
                  fallbackStyle={{ background: u.is_active ? '#DBEAFE' : '#FEE2E2' }}
                />
                <span
                  className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-white ${u.is_online ? 'bg-green-500' : 'bg-gray-300'}`}
                  title={u.is_online ? 'Live now' : 'Offline'}
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-semibold text-gray-900 text-sm">{u.name}</p>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${roleColors[u.role] || 'bg-gray-100 text-gray-600'}`}>{roleLabels[u.role] || u.role}</span>
                  <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-bold ${u.is_online ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                    <Radio className={`w-3 h-3 ${u.is_online ? 'animate-pulse' : ''}`} />
                    {u.is_online ? 'Live now' : 'Offline'}
                  </span>
                  {!u.is_active && <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-600 font-medium">Locked Out</span>}
                </div>
                <p className="text-xs text-gray-500">{u.email}</p>
                {u.phone && <p className="text-xs text-gray-400">{u.phone}</p>}
                {u.company && <p className="text-xs text-gray-400">{u.company}</p>}
                {u.role === 'contractor' && (u.contractor_category || u.contractor_secondary_category) && (
                  <p className="text-xs text-amber-600 font-semibold">
                    {[u.contractor_category, u.contractor_secondary_category].filter(Boolean).join(' / ')}
                  </p>
                )}
                <div className="flex items-center gap-3 mt-0.5">
                  <p className="text-xs text-gray-400">Joined {format(new Date(u.created_at), 'MMM d, yyyy')}</p>
                  {u.last_seen_at && (
                    <p className="text-xs text-gray-400">
                      Seen {formatDistanceToNow(new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(u.last_seen_at) ? u.last_seen_at : `${u.last_seen_at}Z`), { addSuffix: true })}
                    </p>
                  )}
                  {u.pin && <span className="text-xs font-mono font-bold text-amber-600 bg-amber-50 px-2 py-0.5 rounded">Personal PIN: {u.pin}</span>}
                </div>
              </div>
              {canManageUserRecord(u) && (
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
                    title="Send password setup link"
                  >
                    <Key className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleReinvite(u)}
                    className="p-2 text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors"
                    title="Re-invite user"
                  >
                    <Mail className="w-4 h-4" />
                  </button>
                  {u.is_active ? (
                    <button
                      onClick={() => handleLockout(u)}
                      className="p-2 text-green-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                      title="Lock out user (instant session termination)"
                    >
                      <ShieldOff className="w-4 h-4" />
                    </button>
                  ) : (
                    <button
                      onClick={() => handleUnlock(u)}
                      className="p-2 text-red-400 hover:text-green-600 hover:bg-green-50 rounded-lg transition-colors"
                      title="Reactivate user"
                    >
                      <ShieldCheck className="w-4 h-4" />
                    </button>
                  )}
                  {canDeleteUserRecord(u) && (
                    <button
                      onClick={() => handleDelete(u)}
                      className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                      title="Delete user"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
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
              <option value="project_manager">Project Manager</option>
              {currentUser?.role === 'super_admin' && <option value="operations_manager">Operations Manager</option>}
              {currentUser?.role === 'super_admin' && <option value="super_admin">Super Admin</option>}
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
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Contractor Category</label>
            {categorySelect('contractor_category', 'Select category for contractors...')}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Secondary Category</label>
            {categorySelect('contractor_secondary_category', 'Optional secondary category...')}
          </div>
          <div className="bg-blue-50 rounded-lg p-3 text-xs text-blue-700">
            BuildTrack will email a secure welcome link so the user can create their own password. A personal PIN is assigned automatically.
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
          {/* Avatar Upload */}
          <div className="flex items-center gap-4 pb-4 border-b border-gray-200">
            <div className="w-20 h-20 rounded-full overflow-hidden bg-gray-100 flex items-center justify-center flex-shrink-0 relative group">
              <Avatar
                src={editUser?.avatar_url}
                name={editUser?.name}
                size={80}
                roundedClassName="rounded-full"
                fallbackClassName="text-gray-400"
                fallbackStyle={{ background: '#F3F4F6' }}
              />
              <label
                className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer rounded-full"
                {...fileDropHandlers(files => {
                  const file = files[0];
                  if (file && editUser) handleAvatarUpload(editUser.id, file);
                }, { accept: 'image/*', multiple: false })}
              >
                <Camera className="w-6 h-6 text-white" />
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (file && editUser) handleAvatarUpload(editUser.id, file);
                  }}
                />
              </label>
            </div>
            <div>
              <p className="font-semibold text-gray-900">{editUser?.name}</p>
              <p className="text-xs text-gray-500">{editUser?.email}</p>
              {uploadingAvatar && <p className="text-xs text-blue-500 mt-1">Uploading photo...</p>}
              {!uploadingAvatar && <p className="text-xs text-gray-400 mt-1">Hover photo to change</p>}
            </div>
          </div>

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
              <option value="project_manager">Project Manager</option>
              {currentUser?.role === 'super_admin' && <option value="operations_manager">Operations Manager</option>}
              {currentUser?.role === 'super_admin' && <option value="super_admin">Super Admin</option>}
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
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Contractor Category</label>
            {categorySelect('contractor_category', 'Select category for contractors...')}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Secondary Category</label>
            {categorySelect('contractor_secondary_category', 'Optional secondary category...')}
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={() => { setEditUser(null); reset(); }} className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">
              {isSubmitting ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Password Setup Link Modal */}
      <Modal isOpen={!!resetUser} onClose={() => setResetUser(null)} title={`Send Password Setup Link - ${resetUser?.name}`}>
        <form onSubmit={(event) => { event.preventDefault(); onResetPassword(); }} className="space-y-4">
          <div className="bg-yellow-50 rounded-lg p-3 text-xs text-yellow-700">
            BuildTrack will email this user a secure link to create and save their own password.
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={() => setResetUser(null)} className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={resetSubmitting} className="flex-1 py-2.5 bg-orange-600 text-white rounded-xl text-sm font-semibold hover:bg-orange-700 disabled:opacity-50">
              {resetSubmitting ? 'Sending...' : 'Send Link'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
