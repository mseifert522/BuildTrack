import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  FileCheck2,
  Landmark,
  LockKeyhole,
  Mail,
  ShieldCheck,
} from 'lucide-react';
import GooglePlacesInput from '../components/GooglePlacesInput';

interface LookupPayload {
  contractor_name: string;
  contact_name?: string | null;
  email_hint: string;
  expires_at: string;
  status: string;
  submitted_at?: string | null;
  requires_verification: boolean;
}

interface SetupForm {
  legal_name: string;
  business_name: string;
  tax_classification: string;
  tax_id_type: 'ssn' | 'ein';
  tax_id: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  phone: string;
  email: string;
  bank_name: string;
  routing_number: string;
  account_number: string;
  account_type: 'checking' | 'savings';
  insurance_provider: string;
  insurance_policy_number: string;
  insurance_expires_at: string;
  license_number: string;
  license_state: string;
  w9_certified: boolean;
  ach_authorized: boolean;
}

interface DraftPayload {
  form: Partial<SetupForm>;
  updated_at?: string | null;
}

type DeviceProfile = {
  type: 'mobile' | 'tablet' | 'desktop';
  touch: boolean;
};

const initialForm: SetupForm = {
  legal_name: '',
  business_name: '',
  tax_classification: '',
  tax_id_type: 'ssn',
  tax_id: '',
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  postal_code: '',
  country: 'US',
  phone: '',
  email: '',
  bank_name: '',
  routing_number: '',
  account_number: '',
  account_type: 'checking',
  insurance_provider: '',
  insurance_policy_number: '',
  insurance_expires_at: '',
  license_number: '',
  license_state: '',
  w9_certified: false,
  ach_authorized: false,
};

const inputClass = 'w-full min-h-11 rounded-xl border border-gray-300 bg-white px-3.5 py-2.5 text-base sm:text-sm text-gray-950 outline-none transition focus:border-amber-500 focus:ring-4 focus:ring-amber-100';
const sectionClass = 'rounded-2xl border border-gray-200 bg-white p-4 sm:p-5 shadow-sm';
const businessTaxClassifications = new Set(['single_member_llc', 'llc', 'c_corporation', 's_corporation', 'partnership']);

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = (options?.headers || {}) as Record<string, string>;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error || 'Request failed') as Error & { status?: number };
    error.status = response.status;
    Object.assign(error, data);
    throw error;
  }
  return data;
}

function waitLabel(seconds?: number) {
  if (!seconds || seconds <= 0) return 'a few minutes';
  const minutes = Math.ceil(seconds / 60);
  return minutes <= 1 ? 'one minute' : `${minutes} minutes`;
}

function digitsOnly(value: string, maxLength?: number) {
  const digits = String(value || '').replace(/\D/g, '');
  return typeof maxLength === 'number' ? digits.slice(0, maxLength) : digits;
}

function formatSsn(value: string) {
  const digits = digitsOnly(value, 9);
  if (digits.length <= 3) return digits;
  if (digits.length <= 5) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

function formatEin(value: string) {
  const digits = digitsOnly(value, 9);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

function formatTaxId(value: string, type: SetupForm['tax_id_type']) {
  return type === 'ssn' ? formatSsn(value) : formatEin(value);
}

function formatPhone(value: string) {
  const digits = digitsOnly(value, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function formatPostalCode(value: string) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9 -]/g, '').slice(0, 10);
}

function maskTaxId(value: string, type: SetupForm['tax_id_type']) {
  const digits = digitsOnly(value);
  if (!digits) return '';
  const last4 = digits.slice(-4).padStart(Math.min(digits.length, 4), '*');
  return type === 'ssn' ? `***-**-${last4}` : `**-***${last4}`;
}

function maskBankValue(value: string) {
  const digits = digitsOnly(value);
  if (!digits) return '';
  return `${'*'.repeat(Math.max(digits.length - 4, 4))}${digits.slice(-4)}`;
}

function normalizeDraftForm(draft: Partial<SetupForm>): Partial<SetupForm> {
  const accountType = draft.account_type === 'savings' ? 'savings' : 'checking';
  const taxIdType = draft.tax_id_type === 'ein' ? 'ein' : 'ssn';
  return {
    ...draft,
    tax_id_type: taxIdType,
    tax_id: draft.tax_id ? formatTaxId(draft.tax_id, taxIdType) : '',
    routing_number: draft.routing_number ? digitsOnly(draft.routing_number, 9) : '',
    account_number: draft.account_number ? digitsOnly(draft.account_number, 17) : '',
    account_type: accountType,
    w9_certified: Boolean(draft.w9_certified),
    ach_authorized: Boolean(draft.ach_authorized),
  };
}

function autosaveLabel(status: 'idle' | 'saving' | 'saved' | 'error', lastAutosavedAt: string) {
  if (status === 'saving') return 'Autosaving...';
  if (status === 'error') return 'Autosave failed. Keep this page open and try again.';
  if (status === 'saved') {
    const savedAt = lastAutosavedAt ? new Date(lastAutosavedAt) : null;
    const time = savedAt && !Number.isNaN(savedAt.getTime())
      ? savedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : '';
    return time ? `Autosaved at ${time}` : 'Autosaved';
  }
  return 'Autosave starts after you begin typing.';
}

function detectDevice(): DeviceProfile {
  if (typeof window === 'undefined') return { type: 'desktop', touch: false };
  const width = window.innerWidth;
  const ua = navigator.userAgent || '';
  const touch = window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const ipad = /iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const mobile = /Android|iPhone|iPod|Mobile/i.test(ua) && !ipad;
  if (width < 700 || mobile) return { type: 'mobile', touch };
  if (width < 1100 || ipad || /Tablet/i.test(ua)) return { type: 'tablet', touch };
  return { type: 'desktop', touch };
}

function Field({
  label,
  children,
  required,
}: {
  label: string;
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-black text-gray-700">
        {label}{required ? <span className="text-red-500"> *</span> : null}
      </span>
      {children}
    </label>
  );
}

function InfoPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-black text-gray-600 shadow-sm">
      {children}
    </span>
  );
}

function SensitiveInput({
  value,
  onChange,
  maskValue,
  placeholder,
  maxLength,
  required,
}: {
  value: string;
  onChange: (value: string) => void;
  maskValue: (value: string) => string;
  placeholder: string;
  maxLength?: number;
  required?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      value={focused ? value : maskValue(value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={event => onChange(event.target.value)}
      className={inputClass}
      inputMode="numeric"
      autoComplete="off"
      type="text"
      placeholder={placeholder}
      maxLength={focused ? maxLength : undefined}
      required={required}
    />
  );
}

export default function ContractorSetup() {
  const token = useMemo(() => new URLSearchParams(window.location.search).get('token') || '', []);
  const [device, setDevice] = useState<DeviceProfile>(() => detectDevice());
  const [lookup, setLookup] = useState<LookupPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [code, setCode] = useState('');
  const [setupSession, setSetupSession] = useState('');
  const [form, setForm] = useState<SetupForm>(initialForm);
  const [sendingCode, setSendingCode] = useState(false);
  const [autoCodeAttempted, setAutoCodeAttempted] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [showSubmitConfirmation, setShowSubmitConfirmation] = useState(false);
  const [submitErrorMessage, setSubmitErrorMessage] = useState('');
  const [hasInteractedWithForm, setHasInteractedWithForm] = useState(false);
  const [autosaveStatus, setAutosaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [lastAutosavedAt, setLastAutosavedAt] = useState('');

  useEffect(() => {
    const updateDevice = () => setDevice(detectDevice());
    window.addEventListener('resize', updateDevice);
    window.addEventListener('orientationchange', updateDevice);
    return () => {
      window.removeEventListener('resize', updateDevice);
      window.removeEventListener('orientationchange', updateDevice);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    async function load() {
      if (!token) {
        setError('Setup link is missing a token.');
        setLoading(false);
        return;
      }
      try {
        const data = await requestJson<LookupPayload>(`/api/contractor-onboarding/lookup?token=${encodeURIComponent(token)}`);
        if (!mounted) return;
        setLookup(data);
        setSubmitted(data.status === 'submitted');
      } catch (err: any) {
        if (mounted) setError(err.message || 'Unable to open setup link.');
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => {
      mounted = false;
    };
  }, [token]);

  const update = <K extends keyof SetupForm>(key: K, value: SetupForm[K]) => {
    setHasInteractedWithForm(true);
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const handleTaxClassificationChange = (value: string) => {
    setHasInteractedWithForm(true);
    setForm(prev => {
      const nextType = businessTaxClassifications.has(value) ? 'ein' : prev.tax_id_type;
      return {
        ...prev,
        tax_classification: value,
        tax_id_type: nextType,
        tax_id: formatTaxId(prev.tax_id, nextType),
      };
    });
  };

  const handleTaxIdTypeChange = (value: SetupForm['tax_id_type']) => {
    setHasInteractedWithForm(true);
    setForm(prev => ({
      ...prev,
      tax_id_type: value,
      tax_id: formatTaxId(prev.tax_id, value),
    }));
  };

  const handleAddressSelected = (place: {
    streetAddress: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  }) => {
    setHasInteractedWithForm(true);
    setForm(prev => ({
      ...prev,
      address_line1: place.streetAddress || prev.address_line1,
      city: place.city || prev.city,
      state: (place.state || prev.state).toUpperCase().slice(0, 2),
      postal_code: formatPostalCode(place.postalCode || prev.postal_code),
      country: (place.country || prev.country || 'US').toUpperCase(),
    }));
  };

  const sendCode = async (mode: 'auto' | 'manual' = 'manual') => {
    setSendingCode(true);
    setError('');
    const inboxLabel = lookup?.email_hint ? ` at ${lookup.email_hint}` : '';
    setMessage(mode === 'auto' ? `Sending your 2FA code to your email inbox${inboxLabel}...` : '');
    try {
      await requestJson('/api/contractor-onboarding/send-code', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      setCodeSent(true);
      setMessage(mode === 'auto'
        ? `A 2FA code was just sent to your email inbox${inboxLabel}. Keep this screen open, check your email, then enter the 6-digit code below.`
        : `Another 2FA code was sent to your email inbox${inboxLabel}. Use the newest code you received.`
      );
    } catch (err: any) {
      setCodeSent(false);
      const friendly = err.status === 429
        ? `Two verification codes were already sent. Use the newest code in your inbox or wait ${waitLabel(err.retry_after_seconds)} before requesting another code.`
        : (err.message || 'Unable to send verification code.');
      if (mode === 'auto') setMessage(friendly);
      else setError(friendly);
    } finally {
      setSendingCode(false);
    }
  };

  useEffect(() => {
    if (loading || !lookup || submitted || setupSession || autoCodeAttempted || !token) return;
    setAutoCodeAttempted(true);
    sendCode('auto');
  }, [loading, lookup, submitted, setupSession, autoCodeAttempted, token]);

  const verifyCode = async () => {
    setVerifying(true);
    setError('');
    setMessage('');
    try {
      const data = await requestJson<{ setup_session: string; contractor: LookupPayload; draft?: DraftPayload | null }>('/api/contractor-onboarding/verify-code', {
        method: 'POST',
        body: JSON.stringify({ token, code }),
      });
      setSetupSession(data.setup_session);
      setLookup(data.contractor);
      setCodeSent(false);
      if (data.draft?.form) {
        setForm(prev => ({ ...prev, ...normalizeDraftForm(data.draft?.form || {}) }));
        setLastAutosavedAt(data.draft.updated_at || '');
        setAutosaveStatus('saved');
        setMessage('Email verified. Your saved progress was restored.');
      } else {
        setAutosaveStatus('idle');
        setMessage('Email verified. Complete the secure form below.');
      }
      setHasInteractedWithForm(false);
    } catch (err: any) {
      setError(err.message || 'Unable to verify code.');
    } finally {
      setVerifying(false);
    }
  };

  const autosaveDraft = useCallback(async (mode: 'auto' | 'flush' = 'auto') => {
    if (!setupSession || submitted || !hasInteractedWithForm) return;
    setAutosaveStatus('saving');
    try {
      const data = await requestJson<{ updated_at?: string }>('/api/contractor-onboarding/autosave', {
        method: 'POST',
        headers: { Authorization: `Bearer ${setupSession}` },
        body: JSON.stringify(form),
        keepalive: mode === 'flush',
      });
      setLastAutosavedAt(data.updated_at || new Date().toISOString());
      setAutosaveStatus('saved');
    } catch (_) {
      setAutosaveStatus('error');
    }
  }, [form, hasInteractedWithForm, setupSession, submitted]);

  useEffect(() => {
    if (!setupSession || submitted || !hasInteractedWithForm) return;
    const timer = window.setTimeout(() => {
      autosaveDraft('auto');
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [autosaveDraft, form, hasInteractedWithForm, setupSession, submitted]);

  useEffect(() => {
    if (!setupSession || submitted || !hasInteractedWithForm) return;
    const flush = () => {
      autosaveDraft('flush');
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('blur', flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('blur', flush);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [autosaveDraft, hasInteractedWithForm, setupSession, submitted]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    setSubmitErrorMessage('');
    try {
      await requestJson('/api/contractor-onboarding/submit', {
        method: 'POST',
        headers: { Authorization: `Bearer ${setupSession}` },
        body: JSON.stringify(form),
      });
      setSubmitted(true);
      setSetupSession('');
      setHasInteractedWithForm(false);
      setAutosaveStatus('idle');
      setMessage('Your information has been sent to the main office. BuildTrack will email your contractor PIN so you can open the mobile app when your projects are assigned.');
      setShowSubmitConfirmation(true);
    } catch (err: any) {
      const submitMessage = err.details?.[0] || err.message || 'Unable to submit setup form.';
      setError(submitMessage);
      setSubmitErrorMessage(submitMessage);
    } finally {
      setSubmitting(false);
    }
  };

  const compact = device.type === 'mobile';
  const showVerificationStep = !loading && !submitted && !setupSession && Boolean(lookup);
  const verificationCard = (
    <div className={compact ? 'space-y-4' : 'mx-auto max-w-xl py-4 sm:py-8'}>
      {compact ? (
        <div className="text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-50 text-amber-700 ring-1 ring-amber-200">
            <LockKeyhole className="h-7 w-7" />
          </div>
          <h2 className="text-2xl font-black text-gray-950">Enter 2FA code</h2>
          <p className="mx-auto mt-2 max-w-xs text-sm leading-6 text-gray-600">
            We sent a 6-digit code to {lookup?.email_hint || 'the contractor email inbox'}.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <LockKeyhole className="mt-0.5 h-6 w-6 flex-shrink-0 text-amber-700" />
            <div>
              <p className="text-base font-black text-gray-950">Email verification required</p>
              <p className="mt-1 text-sm leading-6 text-gray-700">
                BuildTrack automatically sends a 6-digit 2FA code when this secure link opens. Keep this screen open, check the contractor email inbox, then enter the code below.
              </p>
            </div>
          </div>
        </div>
      )}

      {!compact && codeSent ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-800">
          <div className="flex items-start gap-2">
            <Mail className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>
              A 2FA code was just sent to {lookup?.email_hint || 'the contractor email inbox'}. Check that inbox, then enter the newest 6-digit code on this screen.
            </span>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</div>
      ) : null}
      {!compact && message ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-700">{message}</div>
      ) : null}

      <div className={compact ? 'rounded-2xl border border-gray-200 bg-gray-50 p-3' : 'rounded-2xl border border-gray-200 bg-gray-50 p-4'}>
        <label className="mb-2 block text-sm font-black text-gray-700">{compact ? 'Verification code' : 'Enter verification code'}</label>
        <div className={compact ? 'grid gap-3' : 'grid gap-3 sm:grid-cols-[1fr_auto]'}>
          <input
            value={code}
            onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            autoFocus={compact}
            className={`${inputClass} text-center text-2xl font-black tracking-[0.35em] ${compact ? 'min-h-14' : ''}`}
          />
          <button
            type="button"
            onClick={verifyCode}
            disabled={verifying || code.length !== 6}
            className="min-h-11 cursor-pointer rounded-xl bg-gray-950 px-5 py-2.5 text-sm font-black text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {verifying ? 'Verifying...' : 'Verify code'}
          </button>
        </div>
        <button
          type="button"
          onClick={() => sendCode('manual')}
          disabled={sendingCode}
          className="mt-3 inline-flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white px-4 py-2 text-sm font-black text-gray-700 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
        >
          <Mail className="h-4 w-4" />
          {sendingCode ? 'Sending code...' : 'Send another 2FA code'}
        </button>
        <p className="mt-2 text-xs leading-5 text-gray-500">
          {compact
            ? 'Keep this page open while you check email. Use the newest code you receive.'
            : 'If the first email is missed, you can request one more code right away. After two code emails, wait five minutes before requesting another.'}
        </p>
      </div>
    </div>
  );

  return (
    <div className="contractor-setup-shell bg-[#F3F5F7] px-3 py-4 sm:px-6 sm:py-7 lg:px-8">
      <div className="mx-auto w-full max-w-6xl">
        <div className="mb-4 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl bg-gray-950 text-white shadow-lg shadow-gray-900/15">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-black uppercase tracking-[0.18em] text-[#B7791F]">New Urban Development</p>
              <h1 className="truncate text-2xl font-black text-gray-950 sm:text-3xl">Contractor Setup</h1>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <InfoPill><LockKeyhole className="h-3.5 w-3.5 text-emerald-600" /> Secured portal</InfoPill>
          </div>
        </div>

        <div className={`grid gap-5 ${compact ? '' : 'lg:grid-cols-[21rem_1fr]'}`}>
          <aside className="rounded-3xl border border-gray-200 bg-white p-5 shadow-sm lg:sticky lg:top-6 lg:self-start">
            <div className="mb-5">
              <p className="text-xs font-black uppercase tracking-[0.16em] text-gray-400">Requested for</p>
              <h2 className="mt-1 text-xl font-black text-gray-950">{lookup?.contractor_name || 'Contractor onboarding'}</h2>
              {lookup?.email_hint ? (
                <p className="mt-2 flex items-center gap-2 text-sm font-semibold text-gray-600">
                  <Mail className="h-4 w-4 text-gray-400" />
                  {lookup.email_hint}
                </p>
              ) : null}
            </div>
            <div className="space-y-3 text-sm">
              <div className={`rounded-2xl border p-3 ${setupSession || submitted ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}>
                <p className="font-black text-gray-950">1. Email verification</p>
                <p className="mt-1 text-xs leading-5 text-gray-600">{setupSession || submitted ? 'Verified' : 'Code is emailed automatically when the link opens.'}</p>
              </div>
              <div className={`rounded-2xl border p-3 ${setupSession ? 'border-amber-200 bg-amber-50' : submitted ? 'border-emerald-200 bg-emerald-50' : 'border-gray-200 bg-gray-50'}`}>
                <p className="font-black text-gray-950">2. Secure intake form</p>
                <p className="mt-1 text-xs leading-5 text-gray-600">1099, address, ACH, insurance, and license details.</p>
              </div>
              <div className={`rounded-2xl border p-3 ${submitted ? 'border-emerald-200 bg-emerald-50' : 'border-gray-200 bg-gray-50'}`}>
                <p className="font-black text-gray-950">3. Submit to operations</p>
                <p className="mt-1 text-xs leading-5 text-gray-600">Sensitive fields are encrypted before storage.</p>
              </div>
            </div>
            {lookup?.expires_at ? (
              <p className="mt-5 rounded-2xl bg-gray-100 px-3 py-2 text-xs font-black text-gray-600">
                Link expires {new Date(lookup.expires_at).toLocaleDateString()}
              </p>
            ) : null}
          </aside>

          <main className="rounded-3xl border border-gray-200 bg-white shadow-sm">
            <div className="border-b border-gray-100 p-4 sm:p-6">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.16em] text-gray-400">Secure contractor intake</p>
                  <h2 className="mt-1 text-xl font-black text-gray-950 sm:text-2xl">
                    {setupSession ? 'Complete your information' : submitted ? 'Submission received' : 'Verify your email'}
                  </h2>
                </div>
                <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-gray-950 px-3 py-1.5 text-xs font-black text-white">
                  <LockKeyhole className="h-3.5 w-3.5" />
                  Protected
                </span>
              </div>
            </div>

            <div className="p-4 sm:p-6">
              {loading ? (
                <div className="py-16 text-center text-sm font-bold text-gray-500">Loading setup portal...</div>
              ) : submitted ? (
                <div className="py-16 text-center">
                  <CheckCircle2 className="mx-auto mb-4 h-14 w-14 text-emerald-600" />
                  <h2 className="text-2xl font-black text-gray-950">Setup submitted</h2>
                  <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-gray-500">
                    Your information has been sent to the main office and will be processed. Thank you. You may now close this browser.
                  </p>
                </div>
              ) : error && !lookup ? (
                <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                    <span>{error}</span>
                  </div>
                </div>
              ) : !setupSession ? (
                compact ? null : verificationCard
              ) : (
                <form onSubmit={submit} className="space-y-5">
                  {error ? (
                    <div className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</div>
                  ) : null}
                  {message ? (
                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-700">{message}</div>
                  ) : null}

                  <section className={sectionClass}>
                    <div className="mb-4 flex items-center gap-2">
                      <FileCheck2 className="h-5 w-5 text-[#B7791F]" />
                      <h3 className="text-sm font-black uppercase tracking-wide text-gray-800">1099 tax information</h3>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <Field label="Control person's name / business owner's name / sole proprietor's name" required>
                        <input value={form.legal_name} onChange={event => update('legal_name', event.target.value)} className={inputClass} required />
                      </Field>
                      <Field label="Business name">
                        <input value={form.business_name} onChange={event => update('business_name', event.target.value)} className={inputClass} />
                      </Field>
                      <Field label="Tax classification" required>
                        <select value={form.tax_classification} onChange={event => handleTaxClassificationChange(event.target.value)} className={inputClass} required>
                          <option value="">Select classification</option>
                          <option value="individual">Individual / sole proprietor</option>
                          <option value="single_member_llc">Single-member LLC</option>
                          <option value="llc">LLC</option>
                          <option value="c_corporation">C corporation</option>
                          <option value="s_corporation">S corporation</option>
                          <option value="partnership">Partnership</option>
                          <option value="other">Other</option>
                        </select>
                      </Field>
                      <Field label="Tax ID type" required>
                        <select value={form.tax_id_type} onChange={event => handleTaxIdTypeChange(event.target.value as SetupForm['tax_id_type'])} className={inputClass} required>
                          <option value="ssn">SSN</option>
                          <option value="ein">EIN / Tax ID</option>
                        </select>
                      </Field>
                      <Field label="SSN or Tax ID number" required>
                        <SensitiveInput
                          value={form.tax_id}
                          onChange={value => update('tax_id', formatTaxId(value, form.tax_id_type))}
                          maskValue={value => maskTaxId(value, form.tax_id_type)}
                          placeholder={form.tax_id_type === 'ssn' ? '123-12-1234' : '12-3456789'}
                          maxLength={form.tax_id_type === 'ssn' ? 11 : 10}
                          required
                        />
                      </Field>
                    </div>
                  </section>

                  <section className={sectionClass}>
                    <div className="mb-4 flex items-center gap-2">
                      <Building2 className="h-5 w-5 text-[#B7791F]" />
                      <h3 className="text-sm font-black uppercase tracking-wide text-gray-800">Address and contact</h3>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="md:col-span-2">
                        <Field label="Address line 1" required>
                          <GooglePlacesInput
                            value={form.address_line1}
                            onChange={value => update('address_line1', value)}
                            onPlaceSelect={handleAddressSelected}
                            placeholder="Start typing the contractor mailing address"
                            className={inputClass}
                            required
                          />
                        </Field>
                      </div>
                      <div className="md:col-span-2">
                        <Field label="Address line 2">
                          <input value={form.address_line2} onChange={event => update('address_line2', event.target.value)} className={inputClass} />
                        </Field>
                      </div>
                      <Field label="City" required>
                        <input value={form.city} onChange={event => update('city', event.target.value)} className={inputClass} required />
                      </Field>
                      <Field label="State" required>
                        <input value={form.state} onChange={event => update('state', event.target.value.toUpperCase().slice(0, 2))} className={inputClass} maxLength={2} required />
                      </Field>
                      <Field label="ZIP / postal code" required>
                        <input value={form.postal_code} onChange={event => update('postal_code', formatPostalCode(event.target.value))} className={inputClass} autoComplete="postal-code" required />
                      </Field>
                      <Field label="Country" required>
                        <input value={form.country} onChange={event => update('country', event.target.value.toUpperCase().slice(0, 2))} className={inputClass} maxLength={2} required />
                      </Field>
                      <Field label="Phone" required>
                        <input value={form.phone} onChange={event => update('phone', formatPhone(event.target.value))} className={inputClass} inputMode="tel" autoComplete="tel" placeholder="(123) 456-7890" required />
                      </Field>
                      <Field label="Email" required>
                        <input value={form.email} onChange={event => update('email', event.target.value)} className={inputClass} type="email" autoComplete="email" required />
                      </Field>
                    </div>
                  </section>

                  <section className={sectionClass}>
                    <div className="mb-4 flex items-center gap-2">
                      <Landmark className="h-5 w-5 text-[#B7791F]" />
                      <h3 className="text-sm font-black uppercase tracking-wide text-gray-800">ACH payment details</h3>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <Field label="Bank name" required>
                        <input value={form.bank_name} onChange={event => update('bank_name', event.target.value)} className={inputClass} required />
                      </Field>
                      <Field label="Account type" required>
                        <select value={form.account_type} onChange={event => update('account_type', event.target.value as SetupForm['account_type'])} className={inputClass} required>
                          <option value="checking">Checking</option>
                          <option value="savings">Savings</option>
                        </select>
                      </Field>
                      <Field label="Routing number" required>
                        <SensitiveInput
                          value={form.routing_number}
                          onChange={value => update('routing_number', digitsOnly(value, 9))}
                          maskValue={maskBankValue}
                          placeholder="9-digit routing number"
                          maxLength={9}
                          required
                        />
                      </Field>
                      <Field label="Account number" required>
                        <SensitiveInput
                          value={form.account_number}
                          onChange={value => update('account_number', digitsOnly(value, 17))}
                          maskValue={maskBankValue}
                          placeholder="Bank account number"
                          maxLength={17}
                          required
                        />
                      </Field>
                    </div>
                  </section>

                  <section className={sectionClass}>
                    <div className="mb-4 flex items-center gap-2">
                      <ShieldCheck className="h-5 w-5 text-[#B7791F]" />
                      <h3 className="text-sm font-black uppercase tracking-wide text-gray-800">Insurance and licensing</h3>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <Field label="Insurance provider">
                        <input value={form.insurance_provider} onChange={event => update('insurance_provider', event.target.value)} className={inputClass} />
                      </Field>
                      <Field label="Policy number">
                        <input value={form.insurance_policy_number} onChange={event => update('insurance_policy_number', event.target.value)} className={inputClass} />
                      </Field>
                      <Field label="Insurance expiration">
                        <input value={form.insurance_expires_at} onChange={event => update('insurance_expires_at', event.target.value)} className={inputClass} type="date" />
                      </Field>
                      <Field label="License state">
                        <input value={form.license_state} onChange={event => update('license_state', event.target.value.toUpperCase().slice(0, 2))} className={inputClass} maxLength={2} />
                      </Field>
                      <div className="md:col-span-2">
                        <Field label="License number">
                          <input value={form.license_number} onChange={event => update('license_number', event.target.value)} className={inputClass} />
                        </Field>
                      </div>
                    </div>
                  </section>

                  <section className="space-y-3 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
                    <label className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={form.w9_certified}
                        onChange={event => update('w9_certified', event.target.checked)}
                        className="mt-1 h-5 w-5 rounded border-gray-300 text-amber-600"
                        required
                      />
                      <span className="text-sm font-semibold leading-6 text-gray-700">
                        I certify that the tax information provided is accurate for 1099 reporting.
                      </span>
                    </label>
                    <label className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={form.ach_authorized}
                        onChange={event => update('ach_authorized', event.target.checked)}
                        className="mt-1 h-5 w-5 rounded border-gray-300 text-amber-600"
                        required
                      />
                      <span className="text-sm font-semibold leading-6 text-gray-700">
                        I authorize New Urban Development to use the ACH information above for contractor payments.
                      </span>
                    </label>
                  </section>

                  <div className="sticky bottom-0 -mx-4 bg-white/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:bg-transparent sm:px-0 sm:py-0">
                    {error ? (
                      <div className="mb-3 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">
                        {error}
                      </div>
                    ) : null}
                    <p className={`mb-2 text-xs font-black ${autosaveStatus === 'error' ? 'text-red-600' : autosaveStatus === 'saved' ? 'text-emerald-700' : 'text-gray-500'}`}>
                      {autosaveLabel(autosaveStatus, lastAutosavedAt)}
                    </p>
                    <button
                      type="submit"
                      disabled={submitting}
                      className="flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-2xl bg-gray-950 px-5 py-3 text-sm font-black text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      {submitting ? 'Submitting...' : 'Submit Information Now'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </main>
        </div>
      </div>
      {compact && showVerificationStep ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-gray-950/60 px-4 py-6"
          role="dialog"
          aria-modal="true"
          aria-label="Email verification"
        >
          <div className="contractor-setup-verification-scroll w-full max-w-sm rounded-3xl bg-white p-4 shadow-2xl max-h-[calc(100svh-2rem)]">
            {verificationCard}
          </div>
        </div>
      ) : null}
      {submitErrorMessage ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/60 px-4">
          <div className="w-full max-w-md rounded-3xl bg-white p-6 text-center shadow-2xl">
            <AlertCircle className="mx-auto mb-4 h-14 w-14 text-red-600" />
            <h2 className="text-xl font-black text-gray-950">Information not submitted</h2>
            <p className="mt-2 text-sm leading-6 text-gray-600">
              {submitErrorMessage}
            </p>
            <button
              type="button"
              onClick={() => setSubmitErrorMessage('')}
              className="mt-5 min-h-11 w-full rounded-2xl bg-gray-950 px-4 py-2.5 text-sm font-black text-white transition hover:bg-gray-800"
            >
              Review Information
            </button>
          </div>
        </div>
      ) : null}
      {showSubmitConfirmation ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/60 px-4">
          <div className="w-full max-w-md rounded-3xl bg-white p-6 text-center shadow-2xl">
            <CheckCircle2 className="mx-auto mb-4 h-14 w-14 text-emerald-600" />
            <h2 className="text-xl font-black text-gray-950">Information submitted</h2>
            <p className="mt-2 text-sm leading-6 text-gray-600">
              Your information has been sent to the main office and will be processed. Thank you. You may now close this browser.
            </p>
            <button
              type="button"
              onClick={() => setShowSubmitConfirmation(false)}
              className="mt-5 min-h-11 w-full rounded-2xl bg-gray-950 px-4 py-2.5 text-sm font-black text-white transition hover:bg-gray-800"
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
