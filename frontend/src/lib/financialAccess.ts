import { useEffect, useState } from 'react';
import api from './api';
import { useAuthStore } from '../store/authStore';

// Who may open the financial tabs (project Finance + Consolidated Finances). Mike,
// 2026-10-19: Super Admins automatically; anyone else only when a Super Admin grants it.
// The server decides (GET /api/feature-access/me); this caches the answer per signed-in
// user so the menu and the route guard ask once.
type FinancialAccess = { loading: boolean; allowed: boolean; canManage: boolean };

let cached: { userId: string; promise: Promise<Omit<FinancialAccess, 'loading'>> } | null = null;

export function useFinancialAccess(): FinancialAccess {
  const user = useAuthStore(state => state.user);
  const [state, setState] = useState<FinancialAccess>({ loading: true, allowed: false, canManage: false });
  useEffect(() => {
    if (!user?.id || user.role === 'contractor') {
      setState({ loading: false, allowed: false, canManage: false });
      return;
    }
    if (!cached || cached.userId !== user.id) {
      cached = {
        userId: user.id,
        promise: api.get('/feature-access/me')
          .then(res => ({ allowed: Boolean(res.data?.access?.bank_draws), canManage: Boolean(res.data?.can_manage) }))
          .catch(() => {
            cached = null;
            return { allowed: false, canManage: false };
          }),
      };
    }
    let cancelled = false;
    cached.promise.then(value => { if (!cancelled) setState({ loading: false, ...value }); });
    return () => { cancelled = true; };
  }, [user?.id, user?.role]);
  return state;
}
