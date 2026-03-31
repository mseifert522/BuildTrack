import { create } from 'zustand';

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'super_admin' | 'operations_manager' | 'project_manager' | 'contractor';
  is_active?: number;
  phone?: string;
  company?: string;
  force_password_reset?: boolean;
}

interface AuthState {
  user: User | null;
  token: string | null;
  setAuth: (user: User, token: string) => void;
  logout: () => void;
  updateUser: (user: Partial<User>) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: (() => {
    try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch { return null; }
  })(),
  token: localStorage.getItem('token'),
  setAuth: (user, token) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    set({ user, token });
  },
  logout: () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    set({ user: null, token: null });
  },
  updateUser: (updates) => set((state) => {
    const updated = state.user ? { ...state.user, ...updates } : null;
    if (updated) localStorage.setItem('user', JSON.stringify(updated));
    return { user: updated };
  }),
}));

export const roleLabels: Record<string, string> = {
  super_admin: 'Super Admin',
  operations_manager: 'Operations Manager',
  project_manager: 'Project Manager',
  contractor: 'Contractor',
};

/** Can create/edit/delete projects */
export const canManageProjects = (role: string) =>
  ['super_admin', 'operations_manager', 'project_manager'].includes(role);

/** Can create NEW projects (desktop only) */
export const canCreateProjects = (role: string) =>
  ['super_admin', 'operations_manager'].includes(role);

/** Can access Users management page */
export const canManageUsers = (role: string) =>
  ['super_admin', 'operations_manager'].includes(role);

/** Non-contractor roles that can access the desktop dashboard */
export const isAdminRole = (role: string) =>
  ['super_admin', 'operations_manager', 'project_manager'].includes(role);

/** Can access Settings page */
export const canAccessSettings = (role: string) =>
  ['super_admin', 'operations_manager'].includes(role);
