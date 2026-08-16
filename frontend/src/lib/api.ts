import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  const contractorToken = localStorage.getItem('contractor_token');
  const activityKey = contractorToken && contractorToken === token
    ? 'contractor_last_activity_at'
    : 'auth_last_activity_at';
  const lastActivity = localStorage.getItem(activityKey);
  if (lastActivity) config.headers['X-BuildTrack-Last-Activity'] = lastActivity;
  return config;
});

api.interceptors.response.use(
  (res) => {
    const method = String(res.config.method || 'get').toLowerCase();
    if (['post', 'put', 'patch', 'delete'].includes(method)) {
      window.dispatchEvent(new CustomEvent('buildtrack:mutation-succeeded', {
        detail: { method, url: String(res.config.url || '') },
      }));
    }
    return res;
  },
  (err) => {
    const requestUrl = String(err.config?.url || '');
    const handlesOwnAuthError = [
      '/auth/login',
      '/auth/pin-login',
      '/auth/trusted-device-login',
      '/auth/mobile-quick-access',
      '/auth/contractor/email-login/verify',
    ].some(path => requestUrl.startsWith(path));
    if (err.response?.status === 401 && !handlesOwnAuthError) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      localStorage.removeItem('auth_last_activity_at');
      localStorage.removeItem('auth_last_refresh_at');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;
