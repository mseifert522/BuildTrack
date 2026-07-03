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
type ContractorAccessMode = 'pin' | 'forgot';

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

type TwofaChallenge =
  | { method: 'password'; email: string; password: string; clientType?: string }
  | { method: 'pin'; pin: string; email?: string };

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
  const [twofaChallenge, setTwofaChallenge] = useState<TwofaChallenge | null>(null);
  const [loginMode, setLoginMode] = useState<LoginMode>(() => mobileLoginHost ? initialMode : 'password');
  const [contractorAccessMode, setContractorAccessMode] = useState<ContractorAccessMode>('pin');
  const [pinDigits, setPinDigits] = useState('');
  const [contractorEmail, setContractorEmail] = useState(() => localStorage.getItem(REMEMBERED_CONTRACTOR_EMAIL_KEY) || '');
  const [contractorActionLoading, setContractorActionLoading] = useState(false);
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
        className={`flex items-center justify-between gap-3 ${forceMobileLogin ? 'rounded-xl p-3' : 'rounded-2xl p-4'}`}
        style={{
          background: forceMobileLogin ? 'rgba(2, 6, 23, 0.28)' : 'white',
          border: forceMobileLogin ? '0' : '1px solid #E5E7EB',
        }}
      >
        <div className="min-w-0">
          <p className={`${forceMobileLogin ? 'text-xs' : 'text-sm'} font-semibold ${forceMobileLogin ? 'text-slate-50' : 'text-gray-800'}`}>{title}</p>
          <p className={`${forceMobileLogin ? 'text-[11px] leading-snug' : 'text-xs'} mt-0.5 ${forceMobileLogin ? 'text-slate-100' : 'text-gray-400'}`}>{description}</p>
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
        setTwofaChallenge({ method: 'password', email: email.toLowerCase().trim(), password });
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
      const challenge = twofaChallenge || { method: 'password' as const, email, password };
      const res = challenge.method === 'pin'
        ? await api.post('/auth/pin-login', {
            pin: challenge.pin,
            twofa_code: twofaCode,
            device_token: getStoredDeviceToken(),
            trust_device: rememberThisDevice,
          })
        : await api.post('/auth/login', {
            email: challenge.email,
            password: challenge.password,
            twofa_code: twofaCode,
            device_token: getStoredDeviceToken(),
            trust_device: rememberThisDevice,
            ...(challenge.clientType ? { client_type: challenge.clientType } : {}),
          });
      if (res.data.requires_2fa) {
        toast.error('Invalid or expired code. Try again.');
      } else {
        localStorage.setItem('stayLoggedIn', rememberThisDevice ? 'true' : 'false');
        setNeeds2FA(false);
        setTwofaCode('');
        setTwofaChallenge(null);
        completeLogin(res.data);
      }
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Invalid code');
    } finally {
      setTwofaLoading(false);
    }
  };

  const submitPinLogin = async () => {
    if (pinDigits.length !== 5) return;
    setLoading(true);
    try {
      const rememberThisDevice = wantsTrustedDevice();
      const res = await api.post('/auth/pin-login', {
        pin: pinDigits,
        device_token: getStoredDeviceToken(),
        trust_device: rememberThisDevice,
      });
      if (res.data.requires_2fa) {
        setTwofaChallenge({ method: 'pin', pin: pinDigits, email: res.data.email });
        setTrustDevicePreference(rememberThisDevice);
        setNeeds2FA(true);
        toast.success('Verification code sent to the email on file');
        return;
      }
      localStorage.setItem('stayLoggedIn', rememberThisDevice ? 'true' : 'false');
      completeLogin(res.data);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Invalid mobile app PIN');
      setPinDigits('');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (
      mobileLoginHost &&
      loginMode === 'pin' &&
      contractorAccessMode === 'pin' &&
      !needs2FA &&
      !loading &&
      pinDigits.length === 5
    ) {
      void submitPinLogin();
    }
  }, [pinDigits, mobileLoginHost, loginMode, contractorAccessMode, needs2FA, loading]);

  const handlePinLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitPinLogin();
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

  const mobileHelpLabel =
    loginMode === 'pin'
      ? contractorAccessMode === 'forgot'
        ? 'Back to PIN Number Access'
        : 'Forgot PIN Number'
      : 'Forgot Password or User ID';

  const handleMobileHelp = () => {
    if (loginMode === 'password') {
      navigate('/forgot-password');
      return;
    }
    if (contractorAccessMode === 'forgot') {
      setContractorAccessMode('pin');
      return;
    }
    setContractorAccessMode('forgot');
    setPinDigits('');
  };

  const handleResendCode = async () => {
    try {
      const challenge = twofaChallenge || { method: 'password' as const, email, password };
      if (challenge.method === 'pin') {
        await api.post('/auth/pin-login', {
          pin: challenge.pin,
          device_token: getStoredDeviceToken(),
          trust_device: wantsTrustedDevice(),
        });
      } else {
        await api.post('/auth/login', {
          email: challenge.email,
          password: challenge.password,
          ...(challenge.clientType ? { client_type: challenge.clientType } : {}),
        });
      }
      toast.success('New code sent to your email');
    } catch {
      toast.error('Failed to resend code');
    }
  };

  return (
    <div
      className={forceMobileLogin ? 'bt-mobile-login-page flex items-start justify-center px-3 py-2 sm:px-5 sm:py-4' : 'min-h-screen flex'}
      style={{
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        background: forceMobileLogin ? 'linear-gradient(180deg, #020617 0%, #07142A 48%, #0F172A 100%)' : undefined,
        minHeight: forceMobileLogin ? '100dvh' : undefined,
        height: forceMobileLogin ? '100dvh' : undefined,
        overflowY: forceMobileLogin ? 'auto' : undefined,
        overflowX: forceMobileLogin ? 'hidden' : undefined,
        overscrollBehavior: forceMobileLogin ? 'contain' : undefined,
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
          ? 'w-full max-w-[430px] min-h-full flex flex-col items-center justify-start relative bg-[#071426] px-4 py-3'
          : 'flex-1 flex flex-col items-center justify-center px-4 py-8 sm:px-6 md:px-10 relative'}
        style={{
          background: forceMobileLogin ? '#071426' : '#F8F9FC',
          paddingBottom: forceMobileLogin ? 'max(0.75rem, env(safe-area-inset-bottom))' : undefined,
        }}
      >
        <div className={`${forceMobileLogin ? 'flex gap-2 mb-2' : 'lg:hidden flex gap-3 mb-5'} items-center w-full max-w-[460px]`}>
          <div
            className={`${forceMobileLogin ? 'h-10 w-10' : 'h-12 w-12'} rounded-lg overflow-hidden bg-slate-950 shadow-sm flex-shrink-0`}
            style={{ boxShadow: '0 0 0 1px rgba(217,157,38,0.46)' }}
          >
            <img src={BUILDTRACK_TRUTH_ICON_SRC} alt="BuildTrack" className="h-full w-full object-contain" />
          </div>
          <div>
            <h1 className={`${forceMobileLogin ? 'text-lg' : 'text-xl'} font-black ${forceMobileLogin ? 'text-white' : 'text-gray-900'}`}>BuildTrack</h1>
            <p className={`${forceMobileLogin ? 'text-[10px]' : 'text-xs'} font-semibold uppercase`} style={{ color: '#D99D26' }}>Construction Management</p>
          </div>
        </div>

        <div className="w-full max-w-[460px]">
          <div className={`${forceMobileLogin ? 'mb-2' : 'mb-5'} text-center`}>
            <h2 className={`${forceMobileLogin ? 'text-xl' : 'text-3xl'} font-black ${forceMobileLogin ? 'text-white' : 'text-gray-900'}`}>Welcome back</h2>
            <p className={`${forceMobileLogin ? 'mt-0.5 text-xs' : 'mt-2 text-sm'} ${forceMobileLogin ? 'text-slate-50' : 'text-gray-500'}`}>Choose one secure sign-in method.</p>
          </div>

          {needs2FA ? (
            <form onSubmit={handleVerify2FA} className="space-y-4">
              <div
                className="rounded-2xl p-5 text-center"
                style={{
                  background: forceMobileLogin ? 'rgba(2, 6, 23, 0.28)' : 'white',
                  border: forceMobileLogin ? '0' : '1px solid #E5E7EB',
                }}
              >
                <div className="w-12 h-12 rounded-lg flex items-center justify-center mx-auto mb-4" style={{ background: 'rgba(217,157,38,0.1)' }}>
                  <Mail className="w-6 h-6" style={{ color: '#D99D26' }} />
                </div>
                <h3 className={`font-bold text-lg mb-1 ${forceMobileLogin ? 'text-white' : 'text-gray-900'}`}>Check your email</h3>
                <p className={`text-sm mb-5 ${forceMobileLogin ? 'text-slate-50' : 'text-gray-500'}`}>
                  Enter the 6-digit verification code sent to{' '}
                  <strong>{twofaChallenge?.method === 'pin' ? 'the email on file for this PIN' : twofaChallenge?.email || email}</strong>.
                </p>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={twofaCode}
                  onChange={e => setTwofaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  autoFocus
                  className="w-full text-center text-3xl font-black py-4 rounded-lg bg-slate-50 text-slate-950 placeholder:text-slate-500 focus:outline-none"
                  style={{ border: '0', caretColor: '#D99D26', boxShadow: 'inset 0 0 0 1px rgba(15,23,42,0.08)' }}
                  placeholder="000000"
                />
              </div>
              <label
                className="flex items-start gap-3 rounded-2xl p-4 cursor-pointer"
                style={{
                  background: forceMobileLogin ? 'rgba(2, 6, 23, 0.28)' : 'white',
                  border: forceMobileLogin ? '0' : '1px solid #E5E7EB',
                }}
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
          <span className={`block text-sm font-bold ${forceMobileLogin ? 'text-white' : 'text-gray-900'}`}>Enable one-touch app login</span>
          <span className={`block text-xs mt-0.5 ${forceMobileLogin ? 'text-slate-100' : 'text-gray-500'}`}>After this 2FA verification, this device can use one-touch login.</span>
        </span>
              </label>
              <button
                type="submit"
                disabled={twofaLoading || twofaCode.length !== 6}
                className="w-full py-4 rounded-lg font-bold text-sm disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #F7B733, #D99D26)', color: '#06111F', boxShadow: '0 8px 24px rgba(217,157,38,0.25)' }}
              >
                {twofaLoading ? 'Verifying...' : 'Verify and Sign In'}
              </button>
              <div className="flex items-center justify-between">
                <button type="button" onClick={() => { setNeeds2FA(false); setTwofaCode(''); setTwofaChallenge(null); }} className={`text-sm font-medium ${forceMobileLogin ? 'text-slate-50 hover:text-white' : 'text-gray-500 hover:text-gray-700'}`}>
                  Back
                </button>
                <button type="button" onClick={handleResendCode} className="text-sm font-bold" style={{ color: '#D99D26' }}>
                  Resend Code
                </button>
              </div>
            </form>
          ) : (
            <div className={forceMobileLogin ? 'space-y-2' : 'space-y-3'}>
              {quickAccessReady && (
                <button
                  type="button"
                  onClick={handleMobileQuickAccessLogin}
                  disabled={quickAccessLoading}
                  className={`w-full flex items-center justify-between gap-3 ${forceMobileLogin ? 'p-3 rounded-xl' : 'p-4 rounded-lg'} text-left transition-all disabled:opacity-60`}
                  style={{ background: 'linear-gradient(135deg, #F7B733, #D99D26)', color: '#06111F', boxShadow: '0 12px 28px rgba(217,157,38,0.28)' }}
                >
                  <span className="flex items-center gap-3 min-w-0">
                    <span className={`${forceMobileLogin ? 'h-8 w-8' : 'h-11 w-11'} rounded-lg flex items-center justify-center flex-shrink-0`} style={{ background: 'rgba(255,255,255,0.18)' }}>
                      <Smartphone className={forceMobileLogin ? 'h-4 w-4' : 'h-5 w-5'} />
                    </span>
                    <span className="min-w-0">
                      <span className={`block ${forceMobileLogin ? 'text-xs' : 'text-sm'} font-black`}>One-Touch App Login</span>
                      <span className={`block ${forceMobileLogin ? 'text-[11px] leading-snug' : 'text-xs mt-0.5'}`} style={{ color: 'rgba(6,17,31,0.78)' }}>
                        Continue as {quickAccessLabel}. {forceMobileLogin ? '7-day reset.' : 'Resets after 7 days.'}
                      </span>
                    </span>
                  </span>
                  {quickAccessLoading ? (
                    <span className="w-5 h-5 rounded-full animate-spin flex-shrink-0" style={{ border: '2px solid rgba(6,17,31,0.25)', borderTopColor: '#06111F' }} />
                  ) : (
                    <ArrowRight className="w-5 h-5 flex-shrink-0" />
                  )}
                </button>
              )}

              {!mobileLoginHost && trustedDeviceReady && (
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
                <>
                  <div className="rounded-xl bg-slate-950/30 p-2">
                    <p className="mb-1 text-center text-[10px] font-black uppercase text-white">Ways to login</p>
                    <div className="grid grid-cols-2 gap-1.5">
                    {[
                      { id: 'password', label: 'Email & Password', icon: Mail },
                      { id: 'pin', label: 'PIN Number Access', icon: KeyRound },
                    ].map(item => {
                      const Icon = item.icon;
                      const selected = loginMode === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => {
                            setLoginMode(item.id as LoginMode);
                            setContractorAccessMode('pin');
                            setPinDigits('');
                          }}
                          className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[12px] font-black transition-all whitespace-nowrap"
                          style={{
                            background: selected ? 'linear-gradient(135deg, #F7B733 0%, #D99D26 100%)' : 'rgba(15, 23, 42, 0.52)',
                            color: selected ? '#06111F' : '#F8FAFC',
                            border: '0',
                            boxShadow: selected ? '0 10px 24px rgba(217,157,38,0.22)' : 'none',
                          }}
                        >
                          <Icon className="h-3.5 w-3.5" />
                          {item.label}
                        </button>
                      );
                    })}
                    </div>
                  </div>

                  <div className="rounded-xl bg-slate-950/20 px-2 py-1.5">
                    <p className="mb-1 text-center text-[10px] font-black uppercase tracking-wide text-slate-200">Need help signing in?</p>
                    <button
                      type="button"
                      onClick={handleMobileHelp}
                      className="flex min-h-9 w-full items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-black text-slate-50 transition-all"
                      style={{ background: 'rgba(15, 23, 42, 0.58)', border: '0' }}
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      {mobileHelpLabel}
                    </button>
                  </div>
                </>
              )}

              {loginMode === 'password' ? (
                <form onSubmit={handleSubmit} className={forceMobileLogin ? 'space-y-2' : 'space-y-3'}>
                  <div>
                    <label className={`block text-xs font-bold uppercase ${forceMobileLogin ? 'mb-1 text-slate-50' : 'mb-2 text-gray-500'}`}>
                      Email Address
                    </label>
                    <div
                      className="relative rounded-lg transition-all duration-200"
                      style={{
                        background: 'white',
                        border: '0',
                        boxShadow: focusedField === 'email' ? '0 0 0 3px rgba(217,157,38,0.28)' : '0 8px 20px rgba(2,6,23,0.12)',
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
                        className={`${forceMobileLogin ? 'py-3' : 'py-4'} w-full pl-12 pr-4 bg-transparent text-gray-900 text-sm font-medium placeholder-gray-500 focus:outline-none rounded-lg`}
                        placeholder="you@company.com"
                      />
                    </div>
                  </div>

                  <div>
                    <label className={`block text-xs font-bold uppercase ${forceMobileLogin ? 'mb-1 text-slate-50' : 'mb-2 text-gray-500'}`}>
                      Password
                    </label>
                    <div
                      className="relative rounded-lg transition-all duration-200"
                      style={{
                        background: 'white',
                        border: '0',
                        boxShadow: focusedField === 'password' ? '0 0 0 3px rgba(217,157,38,0.28)' : '0 8px 20px rgba(2,6,23,0.12)',
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
                        className={`${forceMobileLogin ? 'py-3' : 'py-4'} w-full pl-12 pr-14 bg-transparent text-gray-900 text-sm font-medium placeholder-gray-500 focus:outline-none rounded-lg`}
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

                  {!mobileLoginHost && (
                    <div className="flex items-center justify-between gap-4">
                      <Link to="/forgot-password" className="text-xs font-bold hover:underline" style={{ color: '#D99D26' }}>
                        Forgot password?
                      </Link>
                    </div>
                  )}

                  {renderTrustDevicePreference()}

                  <button
                    type="submit"
                    disabled={loading}
                    className={`${forceMobileLogin ? 'min-h-11 py-2.5' : 'py-4'} w-full rounded-lg font-bold text-sm transition-all duration-200 relative overflow-hidden`}
                    style={{
                      background: loading ? '#D99D26' : 'linear-gradient(135deg, #F7B733 0%, #D99D26 100%)',
                      color: '#06111F',
                      boxShadow: loading ? 'none' : '0 8px 24px rgba(217,157,38,0.28)',
                    }}
                  >
                    {loading ? (
                      <span className="flex items-center justify-center gap-3">
                        <span className="w-5 h-5 rounded-full animate-spin" style={{ border: '2px solid rgba(6,17,31,0.25)', borderTopColor: '#06111F' }} />
                        Authenticating...
                      </span>
                    ) : (
                      'Sign In'
                    )}
                  </button>
                </form>
              ) : mobileLoginHost ? (
                <div className={forceMobileLogin ? 'space-y-2' : 'space-y-3'}>
                  {contractorAccessMode === 'pin' && (
                    <form onSubmit={handlePinLogin} className={forceMobileLogin ? 'space-y-2' : 'space-y-3'}>
                      <div
                        className={`${forceMobileLogin ? 'rounded-xl p-3' : 'rounded-2xl p-4'} text-center`}
                        style={{ background: 'rgba(2, 6, 23, 0.28)', border: '0' }}
                      >
                        <div className={`${forceMobileLogin ? 'h-8 w-8 mb-2' : 'h-10 w-10 mb-3'} rounded-lg flex items-center justify-center mx-auto`} style={{ background: 'rgba(217,157,38,0.1)' }}>
                          <Smartphone className={forceMobileLogin ? 'h-4 w-4' : 'h-5 w-5'} style={{ color: '#D99D26' }} />
                        </div>
                        <h3 className={`${forceMobileLogin ? 'text-base' : 'text-lg'} font-black text-white`}>Enter User PIN Number</h3>
                        <p className={`${forceMobileLogin ? 'text-xs mt-0.5 mb-2' : 'text-sm mt-1 mb-4'} text-slate-50`}>{forceMobileLogin ? '5-digit user PIN. Email verification may be required.' : 'Enter the user PIN number assigned in BuildTrack. First-time and untrusted devices verify by email before the app opens.'}</p>
                        <input
                          name="one-time-code"
                          type="text"
                          inputMode="numeric"
                          maxLength={5}
                          value={pinDigits}
                          onChange={e => setPinDigits(e.target.value.replace(/\D/g, '').slice(0, 5))}
                          autoComplete="one-time-code"
                          className={`${forceMobileLogin ? 'py-2 text-xl' : 'py-3 text-2xl'} w-full text-center font-black rounded-lg bg-slate-50 text-slate-950 placeholder:text-slate-500 focus:outline-none`}
                          style={{ border: '0', caretColor: '#D99D26', boxShadow: 'inset 0 0 0 1px rgba(15,23,42,0.08)' }}
                          placeholder="00000"
                        />
                      </div>

                      {loading && !forceMobileLogin && (
                        <div className="flex items-center justify-center gap-3 rounded-xl py-3 text-sm font-bold text-slate-50" style={{ background: 'rgba(2, 6, 23, 0.28)' }}>
                          <span className="w-5 h-5 rounded-full animate-spin" style={{ border: '2px solid rgba(255,255,255,0.25)', borderTopColor: 'white' }} />
                          Checking PIN...
                        </div>
                      )}

                      <button
                        type="submit"
                        disabled={loading || pinDigits.length !== 5}
                        className={`${forceMobileLogin ? 'min-h-11 py-2.5' : 'py-4'} w-full rounded-lg font-bold text-sm disabled:opacity-50`}
                        style={{ background: 'linear-gradient(135deg, #F7B733 0%, #D99D26 100%)', color: '#06111F' }}
                      >
                        {loading ? 'Checking PIN...' : 'Sign In'}
                      </button>

                      {renderTrustDevicePreference(
                        'Enable one-touch app login',
                        'This device will remember this user after a successful PIN login.'
                      )}
                    </form>
                  )}

                  {contractorAccessMode === 'forgot' && (
                    <form onSubmit={sendContractorPin} className={forceMobileLogin ? 'space-y-2' : 'space-y-3'}>
                      <div className={`${forceMobileLogin ? 'rounded-xl p-3' : 'rounded-2xl p-4'}`} style={{ background: 'rgba(2, 6, 23, 0.28)', border: '0' }}>
                        <h3 className={`${forceMobileLogin ? 'text-base' : 'text-lg'} font-black text-white`}>Forgot PIN Number</h3>
                        <p className={`${forceMobileLogin ? 'text-xs mt-0.5 mb-3' : 'text-sm mt-1 mb-5'} text-slate-50`}>Enter the email on the BuildTrack user account. If a PIN exists, BuildTrack will email it.</p>
                        <label className="block text-xs font-bold text-slate-50 uppercase mb-2">User Email</label>
                        <input
                          type="email"
                          value={contractorEmail}
                          onChange={e => setContractorEmail(e.target.value)}
                          required
                          className="w-full rounded-lg bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-950 placeholder:text-slate-500 focus:outline-none"
                          style={{ border: '0', caretColor: '#D99D26', boxShadow: 'inset 0 0 0 1px rgba(15,23,42,0.08)' }}
                          placeholder="user@email.com"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={contractorActionLoading}
                        className={`${forceMobileLogin ? 'min-h-11 py-2.5' : 'py-4'} w-full rounded-lg font-bold text-sm disabled:opacity-50`}
                        style={{ background: 'linear-gradient(135deg, #F7B733 0%, #D99D26 100%)', color: '#06111F' }}
                      >
                        {contractorActionLoading ? 'Sending...' : 'Email PIN Number'}
                      </button>
                    </form>
                  )}
                </div>
              ) : null}
            </div>
          )}

          <p className={`text-center ${forceMobileLogin ? 'mt-2 text-[10px] text-slate-400' : 'mt-8 text-xs text-gray-400'}`}>
            (c) 2026 New Urban Development. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  );
}
