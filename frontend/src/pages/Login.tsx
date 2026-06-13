import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
  ShieldCheck,
  Smartphone,
  UserPlus,
} from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import api from '../lib/api';
import { isMobileAppHost, mobilePath } from '../lib/appUrls';
import { BUILDTRACK_TRUTH_ICON_SRC } from '../lib/branding';
import toast from 'react-hot-toast';

const DEVICE_TOKEN_KEY = 'bt_device_token';
const DEVICE_TRUSTED_UNTIL_KEY = 'bt_device_trusted_until';
const QUICK_ACCESS_TOKEN_KEY = 'bt_mobile_quick_access_token';
const QUICK_ACCESS_EXPIRES_AT_KEY = 'bt_mobile_quick_access_expires_at';
const QUICK_ACCESS_USER_LABEL_KEY = 'bt_mobile_quick_access_user_label';
const REMEMBERED_EMAIL_KEY = 'bt_remembered_email';
const REMEMBERED_CONTRACTOR_EMAIL_KEY = 'bt_remembered_contractor_email';
const CONTRACTOR_TOKEN_KEY = 'contractor_token';
const CONTRACTOR_USER_KEY = 'contractor_user';
const CONTRACTOR_PROJECTS_KEY = 'contractor_projects';
const CONTRACTOR_SESSION_STARTED_KEY = 'contractor_session_started_at';
const CONTRACTOR_LAST_ACTIVITY_KEY = 'contractor_last_activity_at';
const CONTRACTOR_LAST_REFRESH_KEY = 'contractor_last_refresh_at';

type LoginMode = 'password' | 'pin';
type ContractorAccessMode = 'pin' | 'email' | 'forgot' | 'signup';

type LoginProps = {
  initialMode?: LoginMode;
  forceMobileLogin?: boolean;
};

type LoginPayload = {
  token: string;
  user: {
    id?: string;
    role?: string;
    force_password_reset?: boolean;
    [key: string]: any;
  };
  projects?: any[];
  device_token?: string;
  trusted_device_expires_at?: string;
  quick_access?: {
    token?: string;
    expires_at?: string;
    expires_in_days?: number;
  };
};

const landingPathFor = (user: { role?: string; force_password_reset?: boolean }) => {
  if (user.force_password_reset) return '/change-password';
  return isMobileAppHost() || user.role === 'contractor' ? mobilePath() : '/dashboard';
};

const clearContractorSession = () => {
  localStorage.removeItem(CONTRACTOR_TOKEN_KEY);
  localStorage.removeItem(CONTRACTOR_USER_KEY);
  localStorage.removeItem(CONTRACTOR_PROJECTS_KEY);
  localStorage.removeItem(CONTRACTOR_SESSION_STARTED_KEY);
  localStorage.removeItem(CONTRACTOR_LAST_ACTIVITY_KEY);
  localStorage.removeItem(CONTRACTOR_LAST_REFRESH_KEY);
};

const saveContractorSession = (data: LoginPayload) => {
  if (data.user?.role !== 'contractor') return;
  const now = String(Date.now());
  localStorage.setItem(CONTRACTOR_TOKEN_KEY, data.token);
  localStorage.setItem(CONTRACTOR_USER_KEY, JSON.stringify(data.user));
  localStorage.setItem(CONTRACTOR_PROJECTS_KEY, JSON.stringify(data.projects || []));
  localStorage.setItem(CONTRACTOR_SESSION_STARTED_KEY, now);
  localStorage.setItem(CONTRACTOR_LAST_ACTIVITY_KEY, now);
  localStorage.setItem(CONTRACTOR_LAST_REFRESH_KEY, now);
};

const saveTrustedDevice = (data: { device_token?: string; trusted_device_expires_at?: string }) => {
  if (data.device_token) localStorage.setItem(DEVICE_TOKEN_KEY, data.device_token);
  if (data.trusted_device_expires_at) {
    localStorage.setItem(DEVICE_TRUSTED_UNTIL_KEY, data.trusted_device_expires_at);
  }
};

const saveMobileQuickAccess = (data: LoginPayload) => {
  const token = data.quick_access?.token;
  const expiresAt = data.quick_access?.expires_at;
  if (!token || !expiresAt) return;

  const userLabel = data.user?.name || data.user?.email || 'this device';
  localStorage.setItem(QUICK_ACCESS_TOKEN_KEY, token);
  localStorage.setItem(QUICK_ACCESS_EXPIRES_AT_KEY, expiresAt);
  localStorage.setItem(QUICK_ACCESS_USER_LABEL_KEY, userLabel);
};

const saveRememberedIdentity = (data: LoginPayload) => {
  const rememberedEmail = data.user?.email;
  if (!rememberedEmail) return;
  if (data.user?.role === 'contractor') {
    localStorage.setItem(REMEMBERED_CONTRACTOR_EMAIL_KEY, rememberedEmail);
  } else {
    localStorage.setItem(REMEMBERED_EMAIL_KEY, rememberedEmail);
  }
};

const parseTrustedUntil = (value?: string | null) => {
  if (!value) return 0;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const timestamp = new Date(normalized).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const clearMobileQuickAccess = () => {
  localStorage.removeItem(QUICK_ACCESS_TOKEN_KEY);
  localStorage.removeItem(QUICK_ACCESS_EXPIRES_AT_KEY);
  localStorage.removeItem(QUICK_ACCESS_USER_LABEL_KEY);
};

const getTrustedDeviceState = () => {
  const token = localStorage.getItem(DEVICE_TOKEN_KEY);
  const trustedUntil = localStorage.getItem(DEVICE_TRUSTED_UNTIL_KEY);
  return {
    token,
    trustedUntil,
    available: Boolean(token && trustedUntil && parseTrustedUntil(trustedUntil) > Date.now()),
  };
};

const getStoredDeviceToken = () => localStorage.getItem(DEVICE_TOKEN_KEY) || undefined;

const getMobileQuickAccessState = () => {
  const token = localStorage.getItem(QUICK_ACCESS_TOKEN_KEY);
  const expiresAt = localStorage.getItem(QUICK_ACCESS_EXPIRES_AT_KEY);
  const userLabel = localStorage.getItem(QUICK_ACCESS_USER_LABEL_KEY) || 'BuildTrack';
  const expiresMs = parseTrustedUntil(expiresAt);

  if (token && expiresAt && expiresMs <= Date.now()) {
    clearMobileQuickAccess();
    return { token: null, expiresAt: null, userLabel, available: false };
  }

  return {
    token,
    expiresAt,
    userLabel,
    available: Boolean(token && expiresAt && expiresMs > Date.now()),
  };
};

export default function Login({ initialMode = 'password', forceMobileLogin = false }: LoginProps) {
  const mobileLoginHost = forceMobileLogin || isMobileAppHost();
  const [email, setEmail] = useState(() => localStorage.getItem(REMEMBERED_EMAIL_KEY) || '');
  const [password, setPassword] = useState('');
  const [stayLoggedIn, setStayLoggedIn] = useState(() =>
    mobileLoginHost || localStorage.getItem('stayLoggedIn') === 'true'
  );
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [trustedDeviceLoading, setTrustedDeviceLoading] = useState(false);
  const [trustedDeviceReady, setTrustedDeviceReady] = useState(() => getTrustedDeviceState().available);
  const [quickAccessLoading, setQuickAccessLoading] = useState(false);
  const [quickAccessReady, setQuickAccessReady] = useState(() => getMobileQuickAccessState().available);
  const [quickAccessLabel, setQuickAccessLabel] = useState(() => getMobileQuickAccessState().userLabel);
  const [needs2FA, setNeeds2FA] = useState(false);
  const [twofaCode, setTwofaCode] = useState('');
  const [trustDevice, setTrustDevice] = useState(() => mobileLoginHost);
  const [twofaLoading, setTwofaLoading] = useState(false);
  const [loginMode, setLoginMode] = useState<LoginMode>(() => mobileLoginHost ? initialMode : 'password');
  const [contractorAccessMode, setContractorAccessMode] = useState<ContractorAccessMode>('pin');
  const [pinDigits, setPinDigits] = useState('');
  const [contractorEmail, setContractorEmail] = useState(() => localStorage.getItem(REMEMBERED_CONTRACTOR_EMAIL_KEY) || '');
  const [contractorPassword, setContractorPassword] = useState('');
  const [showContractorPassword, setShowContractorPassword] = useState(false);
  const [contractorActionLoading, setContractorActionLoading] = useState(false);
  const [signupForm, setSignupForm] = useState({ name: '', company: '', email: '', phone: '' });
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const { setAuth } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (!mobileLoginHost && loginMode === 'pin') {
      setLoginMode('password');
    }
  }, [mobileLoginHost, loginMode]);

  const wantsTrustedDevice = () => trustDevice || stayLoggedIn;

  const setTrustDevicePreference = (trusted: boolean) => {
    setTrustDevice(trusted);
    setStayLoggedIn(trusted);
  };

  const renderTrustDevicePreference = (
    title = 'Trust this device after verification',
    description = 'Remember email, then skip password and 2FA next time on this browser.'
  ) => {
    const enabled = wantsTrustedDevice();
    return (
      <div
        className="flex items-center justify-between gap-4 p-4 rounded-lg"
        style={{ background: 'white', border: '1px solid #E5E7EB' }}
      >
        <div>
          <p className="text-sm font-semibold text-gray-800">{title}</p>
          <p className="text-xs text-gray-400 mt-0.5">{description}</p>
        </div>
        <button
          type="button"
          onClick={() => setTrustDevicePreference(!enabled)}
          className="relative flex-shrink-0 transition-all duration-300"
          style={{
            width: 52,
            height: 28,
            borderRadius: 999,
            backgroundColor: enabled ? '#D99D26' : '#D1D5DB',
          }}
          aria-label={title}
          aria-pressed={enabled}
        >
          <span
            className="absolute top-1 w-5 h-5 bg-white rounded-full shadow-md transition-all duration-300"
            style={{ left: enabled ? 28 : 4 }}
          />
        </button>
      </div>
    );
  };

  useEffect(() => {
    setTrustedDeviceReady(getTrustedDeviceState().available);
    const quickAccess = getMobileQuickAccessState();
    setQuickAccessReady(quickAccess.available);
    setQuickAccessLabel(quickAccess.userLabel);

    const contractorToken = localStorage.getItem(CONTRACTOR_TOKEN_KEY);
    if (!localStorage.getItem('token') && contractorToken) {
      try {
        const contractorUser = JSON.parse(localStorage.getItem(CONTRACTOR_USER_KEY) || 'null');
        if (contractorUser) {
          setAuth(contractorUser, contractorToken);
          navigate(mobilePath(), { replace: true });
        }
      } catch {
        clearContractorSession();
      }
    }
  }, [navigate, setAuth]);

  const completeLogin = (data: LoginPayload) => {
    if (data.user?.role === 'contractor') saveContractorSession(data);
    else clearContractorSession();
    saveTrustedDevice(data);
    saveMobileQuickAccess(data);
    saveRememberedIdentity(data);
    const quickAccess = getMobileQuickAccessState();
    setQuickAccessReady(quickAccess.available);
    setQuickAccessLabel(quickAccess.userLabel);
    setAuth(data.user as any, data.token);
    navigate(landingPathFor(data.user));
  };

  const handleMobileQuickAccessLogin = async () => {
    const quickAccess = getMobileQuickAccessState();
    if (!quickAccess.available || !quickAccess.token) {
      clearMobileQuickAccess();
      setQuickAccessReady(false);
      toast.error(mobileLoginHost
        ? 'Quick app access expired. Please sign in with your password or mobile app PIN.'
        : 'Quick app access expired. Please sign in with your password.'
      );
      return;
    }

    setQuickAccessLoading(true);
    try {
      const res = await api.post('/auth/mobile-quick-access', { quick_access_token: quickAccess.token });
      completeLogin(res.data);
      toast.success('One-touch app access opened');
    } catch (err: any) {
      if (err.response?.data?.reset_quick_access) {
        clearMobileQuickAccess();
        setQuickAccessReady(false);
      }
      toast.error(err.response?.data?.error || 'Quick app access failed. Please sign in again.');
    } finally {
      setQuickAccessLoading(false);
    }
  };

  const handleTrustedDeviceLogin = async () => {
    const device = getTrustedDeviceState();
    if (!device.available || !device.token) {
      setTrustedDeviceReady(false);
      toast.error('Trusted device approval has expired. Please sign in again.');
      return;
    }

    setTrustedDeviceLoading(true);
    try {
      const res = await api.post('/auth/trusted-device-login', { device_token: device.token });
      localStorage.setItem('stayLoggedIn', 'true');
      completeLogin(res.data);
      toast.success('Signed in from this trusted device');
    } catch (err: any) {
      localStorage.removeItem(DEVICE_TOKEN_KEY);
      localStorage.removeItem(DEVICE_TRUSTED_UNTIL_KEY);
      setTrustedDeviceReady(false);
      toast.error(err.response?.data?.error || 'Trusted device sign-in failed');
    } finally {
      setTrustedDeviceLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const rememberThisDevice = wantsTrustedDevice();
      const res = await api.post('/auth/login', {
        email,
        password,
        device_token: getStoredDeviceToken(),
        trust_device: rememberThisDevice,
      });

      if (res.data.requires_2fa) {
        localStorage.setItem(REMEMBERED_EMAIL_KEY, email.toLowerCase().trim());
        setTrustDevicePreference(rememberThisDevice);
        setNeeds2FA(true);
        toast.success('Verification code sent to your email');
      } else {
        localStorage.setItem('stayLoggedIn', rememberThisDevice ? 'true' : 'false');
        completeLogin(res.data);
      }
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Invalid credentials. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify2FA = async (e: React.FormEvent) => {
    e.preventDefault();
    setTwofaLoading(true);
    try {
      const rememberThisDevice = wantsTrustedDevice();
      const res = await api.post('/auth/login', {
        email,
        password,
        twofa_code: twofaCode,
        device_token: getStoredDeviceToken(),
        trust_device: rememberThisDevice,
      });
      if (res.data.requires_2fa) {
        toast.error('Invalid or expired code. Try again.');
      } else {
        localStorage.setItem('stayLoggedIn', rememberThisDevice ? 'true' : 'false');
        completeLogin(res.data);
      }
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Invalid code');
    } finally {
      setTwofaLoading(false);
    }
  };

  const handlePinLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pinDigits.length !== 5) return;
    setLoading(true);
    try {
      const rememberThisDevice = wantsTrustedDevice();
      const res = await api.post('/auth/pin-login', {
        pin: pinDigits,
        device_token: getStoredDeviceToken(),
        trust_device: rememberThisDevice,
      });
      localStorage.setItem('stayLoggedIn', rememberThisDevice ? 'true' : 'false');
      completeLogin(res.data);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Invalid mobile app PIN');
      setPinDigits('');
    } finally {
      setLoading(false);
    }
  };

  const handleContractorPasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setContractorActionLoading(true);
    try {
      const normalizedEmail = contractorEmail.toLowerCase().trim();
      const rememberThisDevice = wantsTrustedDevice();
      const res = await api.post('/auth/login', {
        email: normalizedEmail,
        password: contractorPassword,
        device_token: getStoredDeviceToken(),
        trust_device: rememberThisDevice,
        client_type: 'contractor-mobile',
      });
      localStorage.setItem('stayLoggedIn', rememberThisDevice ? 'true' : 'false');
      localStorage.setItem(REMEMBERED_CONTRACTOR_EMAIL_KEY, normalizedEmail);
      completeLogin(res.data);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Invalid contractor email or password');
      setContractorPassword('');
    } finally {
      setContractorActionLoading(false);
    }
  };

  const sendContractorPin = async (e: React.FormEvent) => {
    e.preventDefault();
    setContractorActionLoading(true);
    try {
      await api.post('/auth/contractor/forgot-pin', { email: contractorEmail });
      toast.success('If that email is on file, BuildTrack sent the PIN.');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Unable to send PIN');
    } finally {
      setContractorActionLoading(false);
    }
  };

  const submitContractorSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setContractorActionLoading(true);
    try {
      await api.post('/contractor-onboarding/self-signup', signupForm);
      setContractorEmail(signupForm.email);
      setContractorAccessMode('email');
      setContractorPassword('');
      toast.success('Check your email for the secure setup link.');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Unable to start contractor signup');
    } finally {
      setContractorActionLoading(false);
    }
  };

  const handleResendCode = async () => {
    try {
      await api.post('/auth/login', { email, password });
      toast.success('New code sent to your email');
    } catch {
      toast.error('Failed to resend code');
    }
  };

  return (
    <div
      className={forceMobileLogin ? 'min-h-screen flex items-start justify-center px-3 py-5 sm:px-5' : 'min-h-screen flex'}
      style={{
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        background: forceMobileLogin ? 'linear-gradient(145deg, #090D15 0%, #111827 52%, #1E293B 100%)' : undefined,
      }}
    >
      {!forceMobileLogin && (
      <div
        className="hidden lg:flex lg:w-[52%] relative flex-col justify-between p-12 overflow-hidden"
        style={{ background: 'linear-gradient(145deg, #0D1117 0%, #151B24 58%, #1E2530 100%)' }}
      >
        <div
          className="absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage: 'linear-gradient(rgba(217,157,38,0.8) 1px, transparent 1px), linear-gradient(90deg, rgba(217,157,38,0.8) 1px, transparent 1px)',
            backgroundSize: '64px 64px',
          }}
        />

        <div className="relative z-10 flex items-center gap-4">
          <div
            className="w-12 h-12 rounded-lg flex items-center justify-center overflow-hidden bg-slate-950"
            style={{ boxShadow: '0 0 0 1px rgba(245,183,49,0.38)' }}
          >
            <img src={BUILDTRACK_TRUTH_ICON_SRC} alt="BuildTrack" className="h-full w-full object-contain" />
          </div>
          <div>
            <p className="text-white font-bold text-lg leading-tight">BuildTrack</p>
            <p className="text-xs font-semibold uppercase" style={{ color: '#D99D26' }}>
              Construction Management
            </p>
          </div>
        </div>

        <div className="relative z-10 max-w-3xl">
          <div
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold mb-7 uppercase"
            style={{ background: 'rgba(217,157,38,0.12)', border: '1px solid rgba(217,157,38,0.3)', color: '#D99D26' }}
          >
            <Building2 className="w-4 h-4" />
            Enterprise field operations
          </div>

          <h1 className="text-5xl font-black text-white leading-[1.08] mb-6">
            Build smarter.<br />
            <span style={{ color: '#D99D26' }}>Track everything.</span>
          </h1>

          <p className="text-lg leading-relaxed mb-10" style={{ color: 'rgba(255,255,255,0.62)' }}>
            Unified project tracking, photos, field notes, invoices, contractors, and suppliers in one controlled construction platform.
          </p>

          <div className="grid grid-cols-2 gap-3 max-w-xl">
            {[
              'Photos',
              'Project Notes',
              'Contractor Access',
              'Invoice Uploads',
            ].map(item => (
              <div
                key={item}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.78)' }}
              >
                <CheckCircle2 className="w-4 h-4" style={{ color: '#D99D26' }} />
                {item}
              </div>
            ))}
          </div>
        </div>

        <div className="relative z-10 grid grid-cols-3 gap-6">
          {[
            { value: 'Mobile', label: 'Field Ready' },
            { value: 'Secure', label: '2FA + Trust' },
            { value: 'Tracked', label: 'Project Media' },
          ].map(item => (
            <div key={item.label}>
              <p className="text-2xl font-black text-white mb-1">{item.value}</p>
              <p className="text-xs font-medium" style={{ color: 'rgba(255,255,255,0.48)' }}>{item.label}</p>
            </div>
          ))}
        </div>
      </div>
      )}

      <div
        className={forceMobileLogin
          ? 'w-full max-w-[430px] flex flex-col items-center justify-center relative rounded-[28px] border border-slate-700/70 bg-[#F8F9FC] px-4 py-7 shadow-2xl'
          : 'flex-1 flex flex-col items-center justify-center px-4 py-8 sm:px-6 md:px-10 relative'}
        style={{ background: forceMobileLogin ? '#F8F9FC' : '#F8F9FC' }}
      >
        <div className={`${forceMobileLogin ? 'flex' : 'lg:hidden flex'} items-center gap-3 mb-6 w-full max-w-[460px]`}>
          <div
            className="w-12 h-12 rounded-lg overflow-hidden bg-slate-950 shadow-sm"
            style={{ boxShadow: '0 0 0 1px rgba(217,157,38,0.46)' }}
          >
            <img src={BUILDTRACK_TRUTH_ICON_SRC} alt="BuildTrack" className="h-full w-full object-contain" />
          </div>
          <div>
            <h1 className="text-xl font-black text-gray-900">BuildTrack</h1>
            <p className="text-xs font-semibold uppercase" style={{ color: '#D99D26' }}>Construction Management</p>
          </div>
        </div>

        <div className="w-full max-w-[460px]">
          <div className="mb-6">
            <h2 className="text-3xl font-black text-gray-900">Welcome back</h2>
            <p className="text-gray-500 mt-2 text-sm">Choose the secure sign-in method for this device.</p>
          </div>

          {needs2FA ? (
            <form onSubmit={handleVerify2FA} className="space-y-4">
              <div className="bg-white rounded-lg p-5 text-center" style={{ border: '1px solid #E5E7EB' }}>
                <div className="w-12 h-12 rounded-lg flex items-center justify-center mx-auto mb-4" style={{ background: 'rgba(217,157,38,0.1)' }}>
                  <Mail className="w-6 h-6" style={{ color: '#D99D26' }} />
                </div>
                <h3 className="font-bold text-gray-900 text-lg mb-1">Check your email</h3>
                <p className="text-sm text-gray-500 mb-5">Enter the 6-digit verification code sent to <strong>{email}</strong>.</p>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={twofaCode}
                  onChange={e => setTwofaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  autoFocus
                  className="w-full text-center text-3xl font-black py-4 rounded-lg focus:outline-none"
                  style={{ border: '2px solid #E5E7EB' }}
                  placeholder="000000"
                />
              </div>
              <label
                className="flex items-start gap-3 p-4 rounded-lg cursor-pointer"
                style={{ background: 'white', border: '1px solid #E5E7EB' }}
              >
                <input
                  type="checkbox"
                  checked={trustDevice}
                  onChange={e => {
                    setTrustDevice(e.target.checked);
                    setStayLoggedIn(e.target.checked);
                  }}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300"
                  style={{ accentColor: '#D99D26' }}
                />
        <span>
          <span className="block text-sm font-bold text-gray-900">Trust this device and remember email</span>
          <span className="block text-xs text-gray-500 mt-0.5">Skip password and email verification on this approved browser.</span>
        </span>
              </label>
              <button
                type="submit"
                disabled={twofaLoading || twofaCode.length !== 6}
                className="w-full py-4 rounded-lg font-bold text-sm text-white disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #D99D26, #C4891F)', boxShadow: '0 8px 24px rgba(217,157,38,0.25)' }}
              >
                {twofaLoading ? 'Verifying...' : 'Verify and Sign In'}
              </button>
              <div className="flex items-center justify-between">
                <button type="button" onClick={() => { setNeeds2FA(false); setTwofaCode(''); }} className="text-sm font-medium text-gray-500 hover:text-gray-700">
                  Back
                </button>
                <button type="button" onClick={handleResendCode} className="text-sm font-bold" style={{ color: '#D99D26' }}>
                  Resend Code
                </button>
              </div>
            </form>
          ) : (
            <div className="space-y-4">
              {quickAccessReady && (
                <button
                  type="button"
                  onClick={handleMobileQuickAccessLogin}
                  disabled={quickAccessLoading}
                  className="w-full flex items-center justify-between gap-3 p-4 rounded-lg text-left transition-all disabled:opacity-60"
                  style={{ background: 'linear-gradient(135deg, #D99D26, #C4891F)', color: 'white', boxShadow: '0 12px 28px rgba(217,157,38,0.28)' }}
                >
                  <span className="flex items-center gap-3 min-w-0">
                    <span className="w-11 h-11 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(255,255,255,0.18)' }}>
                      <Smartphone className="w-5 h-5" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-black">One-Touch App Login</span>
                      <span className="block text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.78)' }}>
                        Continue as {quickAccessLabel}. Resets after 7 days.
                      </span>
                    </span>
                  </span>
                  {quickAccessLoading ? (
                    <span className="w-5 h-5 rounded-full animate-spin flex-shrink-0" style={{ border: '2px solid rgba(255,255,255,0.35)', borderTopColor: 'white' }} />
                  ) : (
                    <ArrowRight className="w-5 h-5 flex-shrink-0" />
                  )}
                </button>
              )}

              {trustedDeviceReady && (
                <button
                  type="button"
                  onClick={handleTrustedDeviceLogin}
                  disabled={trustedDeviceLoading}
                  className="w-full flex items-center justify-between gap-3 p-4 rounded-lg text-left transition-all disabled:opacity-60"
                  style={{ background: '#111827', color: 'white', boxShadow: '0 10px 26px rgba(17,24,39,0.18)' }}
                >
                  <span className="flex items-center gap-3 min-w-0">
                    <span className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(217,157,38,0.18)' }}>
                      <ShieldCheck className="w-5 h-5" style={{ color: '#D99D26' }} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-black">Continue on this trusted device</span>
                      <span className="block text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.62)' }}>Open your approved BuildTrack session.</span>
                    </span>
                  </span>
                  {trustedDeviceLoading ? (
                    <span className="w-5 h-5 rounded-full animate-spin flex-shrink-0" style={{ border: '2px solid rgba(255,255,255,0.25)', borderTopColor: '#D99D26' }} />
                  ) : (
                    <ArrowRight className="w-5 h-5 flex-shrink-0" />
                  )}
                </button>
              )}

              {mobileLoginHost && (
              <div className="grid grid-cols-2 gap-2 rounded-lg p-1" style={{ background: '#E8ECF3' }}>
                <button
                  type="button"
                  onClick={() => setLoginMode('password')}
                  className="flex items-center justify-center gap-2 rounded-md py-2.5 text-sm font-bold transition-all"
                  style={{
                    background: loginMode === 'password' ? 'white' : 'transparent',
                    color: loginMode === 'password' ? '#111827' : '#64748B',
                    boxShadow: loginMode === 'password' ? '0 1px 4px rgba(15,23,42,0.12)' : 'none',
                  }}
                >
                  <Mail className="w-4 h-4" />
                  Email & Password
                </button>
                <button
                  type="button"
                  onClick={() => setLoginMode('pin')}
                  className="flex items-center justify-center gap-2 rounded-md py-2.5 text-sm font-bold transition-all"
                  style={{
                    background: loginMode === 'pin' ? 'white' : 'transparent',
                    color: loginMode === 'pin' ? '#111827' : '#64748B',
                    boxShadow: loginMode === 'pin' ? '0 1px 4px rgba(15,23,42,0.12)' : 'none',
                  }}
                >
                  <KeyRound className="w-4 h-4" />
                  PIN Number
                </button>
              </div>
              )}

              {loginMode === 'password' ? (
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase mb-2">
                      Email Address
                    </label>
                    <div
                      className="relative rounded-lg transition-all duration-200"
                      style={{
                        background: 'white',
                        border: `2px solid ${focusedField === 'email' ? '#D99D26' : '#E5E7EB'}`,
                        boxShadow: focusedField === 'email' ? '0 0 0 4px rgba(217,157,38,0.1)' : '0 1px 3px rgba(0,0,0,0.06)',
                      }}
                    >
                      <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5" style={{ color: focusedField === 'email' ? '#D99D26' : '#9CA3AF' }} />
                      <input
                        id="buildtrack-email"
                        name="email"
                        type="email"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        onFocus={() => setFocusedField('email')}
                        onBlur={() => setFocusedField(null)}
                        required
                        autoComplete="username email"
                        className="w-full pl-12 pr-4 py-4 bg-transparent text-gray-900 text-sm font-medium placeholder-gray-400 focus:outline-none rounded-lg"
                        placeholder="you@company.com"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase mb-2">
                      Password
                    </label>
                    <div
                      className="relative rounded-lg transition-all duration-200"
                      style={{
                        background: 'white',
                        border: `2px solid ${focusedField === 'password' ? '#D99D26' : '#E5E7EB'}`,
                        boxShadow: focusedField === 'password' ? '0 0 0 4px rgba(217,157,38,0.1)' : '0 1px 3px rgba(0,0,0,0.06)',
                      }}
                    >
                      <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5" style={{ color: focusedField === 'password' ? '#D99D26' : '#9CA3AF' }} />
                      <input
                        id="buildtrack-password"
                        name="password"
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        onFocus={() => setFocusedField('password')}
                        onBlur={() => setFocusedField(null)}
                        required
                        autoComplete="current-password"
                        className="w-full pl-12 pr-14 py-4 bg-transparent text-gray-900 text-sm font-medium placeholder-gray-400 focus:outline-none rounded-lg"
                        placeholder="Password"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-md transition-colors"
                        style={{ color: '#9CA3AF' }}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                      >
                        {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-4">
                    <Link to="/forgot-password" className="text-xs font-bold hover:underline" style={{ color: '#D99D26' }}>
                      Forgot password?
                    </Link>
                  </div>

                  {renderTrustDevicePreference()}

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-4 rounded-lg font-bold text-sm transition-all duration-200 text-white relative overflow-hidden"
                    style={{
                      background: loading ? '#B8832A' : 'linear-gradient(135deg, #D99D26 0%, #C4891F 100%)',
                      boxShadow: loading ? 'none' : '0 8px 24px rgba(217,157,38,0.28)',
                    }}
                  >
                    {loading ? (
                      <span className="flex items-center justify-center gap-3">
                        <span className="w-5 h-5 rounded-full animate-spin" style={{ border: '2px solid rgba(255,255,255,0.25)', borderTopColor: 'white' }} />
                        Authenticating...
                      </span>
                    ) : (
                      <span className="flex items-center justify-center gap-2">
                        Sign In to BuildTrack
                        <ArrowRight className="w-4 h-4" />
                      </span>
                    )}
                  </button>
                </form>
              ) : mobileLoginHost ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { id: 'pin' as ContractorAccessMode, label: 'Use PIN Number', icon: KeyRound },
                      { id: 'email' as ContractorAccessMode, label: 'Email & Password', icon: Mail },
                      { id: 'forgot' as ContractorAccessMode, label: 'Forgot PIN', icon: ShieldCheck },
                      { id: 'signup' as ContractorAccessMode, label: 'Sign Up', icon: UserPlus },
                    ].map(item => {
                      const Icon = item.icon;
                      const selected = contractorAccessMode === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setContractorAccessMode(item.id)}
                          className="flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-black transition-all"
                          style={{
                            background: selected ? '#111827' : 'white',
                            color: selected ? 'white' : '#374151',
                            border: selected ? '1px solid #111827' : '1px solid #E5E7EB',
                          }}
                        >
                          <Icon className="w-3.5 h-3.5" />
                          {item.label}
                        </button>
                      );
                    })}
                  </div>

                  {contractorAccessMode === 'pin' && (
                    <form onSubmit={handlePinLogin} className="space-y-4">
                      <div
                        className="rounded-lg p-5 text-center"
                        style={{ background: 'white', border: '1px solid #E5E7EB' }}
                      >
                        <div className="w-12 h-12 rounded-lg flex items-center justify-center mx-auto mb-4" style={{ background: 'rgba(217,157,38,0.1)' }}>
                          <Smartphone className="w-6 h-6" style={{ color: '#D99D26' }} />
                        </div>
                        <h3 className="font-black text-gray-900 text-lg">PIN Number Access</h3>
                        <p className="text-sm text-gray-500 mt-1 mb-5">Enter the contractor PIN number from management to open assigned projects.</p>
                        <input
                          name="one-time-code"
                          type="text"
                          inputMode="numeric"
                          maxLength={5}
                          value={pinDigits}
                          onChange={e => setPinDigits(e.target.value.replace(/\D/g, '').slice(0, 5))}
                          autoComplete="one-time-code"
                          className="w-full text-center text-3xl font-black py-4 rounded-lg focus:outline-none"
                          style={{ border: '2px solid #E5E7EB' }}
                          placeholder="00000"
                        />
                      </div>

                      {renderTrustDevicePreference(
                        'Enable one-touch app login',
                        'This device will remember the contractor after this successful PIN login.'
                      )}

                      <button
                        type="submit"
                        disabled={loading || pinDigits.length !== 5}
                        className="w-full py-4 rounded-lg font-bold text-sm transition-all duration-200 text-white disabled:opacity-50"
                        style={{ background: 'linear-gradient(135deg, #D99D26 0%, #C4891F 100%)', boxShadow: '0 8px 24px rgba(217,157,38,0.28)' }}
                      >
                        {loading ? (
                          <span className="flex items-center justify-center gap-3">
                            <span className="w-5 h-5 rounded-full animate-spin" style={{ border: '2px solid rgba(255,255,255,0.25)', borderTopColor: 'white' }} />
                            Verifying PIN...
                          </span>
                        ) : (
                          <span className="flex items-center justify-center gap-2">
                            Open Assigned Projects
                            <ArrowRight className="w-4 h-4" />
                          </span>
                        )}
                      </button>
                    </form>
                  )}

                  {contractorAccessMode === 'email' && (
                    <form onSubmit={handleContractorPasswordLogin} className="space-y-4">
                      <div className="rounded-lg p-5" style={{ background: 'white', border: '1px solid #E5E7EB' }}>
                        <div className="w-12 h-12 rounded-lg flex items-center justify-center mx-auto mb-4" style={{ background: 'rgba(217,157,38,0.1)' }}>
                          <Mail className="w-6 h-6" style={{ color: '#D99D26' }} />
                        </div>
                        <h3 className="text-center font-black text-gray-900 text-lg">Email & Password Login</h3>
                        <p className="text-center text-sm text-gray-500 mt-1 mb-5">Use the contractor email and password listed in BuildTrack.</p>
                        <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Contractor Email</label>
                        <input
                          name="contractor-email"
                          type="email"
                          value={contractorEmail}
                          onChange={e => setContractorEmail(e.target.value)}
                          required
                          autoComplete="email"
                          className="w-full rounded-lg px-4 py-3 text-sm font-semibold text-gray-900 focus:outline-none"
                          style={{ border: '2px solid #E5E7EB' }}
                          placeholder="contractor@email.com"
                        />
                        <div className="mt-4">
                          <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Password</label>
                          <div className="relative">
                            <input
                              name="contractor-password"
                              type={showContractorPassword ? 'text' : 'password'}
                              value={contractorPassword}
                              onChange={e => setContractorPassword(e.target.value)}
                              required
                              autoComplete="current-password"
                              className="w-full rounded-lg py-3 pl-4 pr-12 text-sm font-semibold text-gray-900 focus:outline-none"
                              style={{ border: '2px solid #E5E7EB' }}
                              placeholder="Password"
                            />
                            <button
                              type="button"
                              onClick={() => setShowContractorPassword(!showContractorPassword)}
                              className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 text-gray-400"
                              aria-label={showContractorPassword ? 'Hide password' : 'Show password'}
                            >
                              {showContractorPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                            </button>
                          </div>
                        </div>
                      </div>
                      {renderTrustDevicePreference(
                        'Enable one-touch app login',
                        'This device will remember the contractor after this successful email and password login.'
                      )}
                      <button
                        type="submit"
                        disabled={contractorActionLoading || !contractorEmail.trim() || !contractorPassword}
                        className="w-full py-4 rounded-lg font-bold text-sm text-white disabled:opacity-50"
                        style={{ background: 'linear-gradient(135deg, #D99D26 0%, #C4891F 100%)' }}
                      >
                        {contractorActionLoading ? 'Signing In...' : 'Sign In and Open Projects'}
                      </button>
                    </form>
                  )}

                  {contractorAccessMode === 'forgot' && (
                    <form onSubmit={sendContractorPin} className="space-y-4">
                      <div className="rounded-lg p-5" style={{ background: 'white', border: '1px solid #E5E7EB' }}>
                        <h3 className="font-black text-gray-900 text-lg">Forgot PIN or Login?</h3>
                        <p className="text-sm text-gray-500 mt-1 mb-5">Enter the email management has on file. BuildTrack will email the PIN number if the account exists.</p>
                        <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Contractor Email</label>
                        <input
                          type="email"
                          value={contractorEmail}
                          onChange={e => setContractorEmail(e.target.value)}
                          required
                          className="w-full rounded-lg px-4 py-3 text-sm font-semibold text-gray-900 focus:outline-none"
                          style={{ border: '2px solid #E5E7EB' }}
                          placeholder="contractor@email.com"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={contractorActionLoading}
                        className="w-full py-4 rounded-lg font-bold text-sm text-white disabled:opacity-50"
                        style={{ background: '#111827' }}
                      >
                        {contractorActionLoading ? 'Sending...' : 'Email My PIN'}
                      </button>
                    </form>
                  )}

                  {contractorAccessMode === 'signup' && (
                    <form onSubmit={submitContractorSignup} className="space-y-4">
                      <div className="rounded-lg p-5" style={{ background: 'white', border: '1px solid #E5E7EB' }}>
                        <h3 className="font-black text-gray-900 text-lg">Contractor Sign Up</h3>
                        <p className="text-sm text-gray-500 mt-1 mb-5">Start your secure contractor setup and 1099 form. Your Mobile App Pin# is emailed after submission.</p>
                        <div className="grid gap-3">
                          <input
                            type="text"
                            value={signupForm.name}
                            onChange={e => setSignupForm(prev => ({ ...prev, name: e.target.value }))}
                            required
                            className="w-full rounded-lg px-4 py-3 text-sm font-semibold text-gray-900 focus:outline-none"
                            style={{ border: '2px solid #E5E7EB' }}
                            placeholder="Your name"
                          />
                          <input
                            type="text"
                            value={signupForm.company}
                            onChange={e => setSignupForm(prev => ({ ...prev, company: e.target.value }))}
                            className="w-full rounded-lg px-4 py-3 text-sm font-semibold text-gray-900 focus:outline-none"
                            style={{ border: '2px solid #E5E7EB' }}
                            placeholder="Company name"
                          />
                          <input
                            type="email"
                            value={signupForm.email}
                            onChange={e => setSignupForm(prev => ({ ...prev, email: e.target.value }))}
                            required
                            className="w-full rounded-lg px-4 py-3 text-sm font-semibold text-gray-900 focus:outline-none"
                            style={{ border: '2px solid #E5E7EB' }}
                            placeholder="Email address"
                          />
                          <input
                            type="tel"
                            value={signupForm.phone}
                            onChange={e => setSignupForm(prev => ({ ...prev, phone: e.target.value }))}
                            className="w-full rounded-lg px-4 py-3 text-sm font-semibold text-gray-900 focus:outline-none"
                            style={{ border: '2px solid #E5E7EB' }}
                            placeholder="Phone number"
                          />
                        </div>
                      </div>
                      <button
                        type="submit"
                        disabled={contractorActionLoading}
                        className="w-full py-4 rounded-lg font-bold text-sm text-white disabled:opacity-50"
                        style={{ background: 'linear-gradient(135deg, #D99D26 0%, #C4891F 100%)' }}
                      >
                        {contractorActionLoading ? 'Starting Setup...' : 'Start Secure Contractor Setup'}
                      </button>
                    </form>
                  )}
                </div>
              ) : null}
            </div>
          )}

          <p className="text-center text-xs text-gray-400 mt-8">
            (c) 2026 New Urban Development. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  );
}
