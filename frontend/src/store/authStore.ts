import { create } from 'zustand';

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'super_admin' | 'operations_manager' | 'admin_assistant' | 'contractor';
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
  admin_assistant: 'Admin Assistant',
  contractor: 'Contractor',
};

export const canManageProjects = (role: string) =>
  ['super_admin', 'operations_manager'].includes(role);

export const canManageUsers = (role: string) =>
  role === 'super_admin';

export const isAdminRole = (role: string) =>
  ['super_admin', 'operations_manager', 'admin_assistant'].includes(role);
