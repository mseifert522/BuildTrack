import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
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
      localStorage.removeItem('auth_session_started_at');
      localStorage.removeItem('auth_last_activity_at');
      localStorage.removeItem('auth_last_refresh_at');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;
