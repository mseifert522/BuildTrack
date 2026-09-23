import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  Circle,
  Clock3,
  FileCheck2,
  FileText,
  Landmark,
  Loader2,
  LockKeyhole,
  Mail,
  MapPin,
  Phone,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import GooglePlacesInput from '../components/GooglePlacesInput';
import { fileDropHandlers } from '../lib/fileDrop';
import { formatFileSize } from '../lib/vendorSetup';

// Public page behind the link in the "Set Up New Vendor" email (no BuildTrack
// login). The backend is routes/vendorSetup.js. Raw fetch is used on purpose:
// the app's axios client logs the browser out on any 401.

type Kind = 'w9' | 'insurance' | 'bank';

interface CompanyInfo {
  name: string;
  street: string;
  cityStateZip: string;
  phone: string;
  phoneHref: string;
  email: string;
  hours: string;
}

interface PaymentPolicy {
  title: string;
  greeting: string;
  paragraphs: string[];
  acceptance: string;
}

interface Lookup {
  company_name: string;
  vendor_type: 'contractor' | 'supplier';
  email_hint: string;
  expires_at: string;
  status: 'sent' | 'verified' | 'submitted' | 'expired';
  submitted_at?: string | null;
  company: CompanyInfo;
  payment_policy: PaymentPolicy;
  limits: { max_file_mb: number; max_files_per_kind: number };
}

interface UploadedFile {
  id: string;
  kind: Kind;
  original_name: string;
  size_bytes: number;
  mime_type: string;
}

interface QueuedUpload {
  key: string;
  kind: Kind;
  file: File;
  progress: number;
  error?: string;
}

interface VendorForm {
  company_name: string;
  contact_name: string;
  phone: string;
  email: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  w9_method: 'online' | 'upload';
  legal_name: string;
  business_name: string;
  tax_classification: string;
  llc_tax_class: string;
  other_classification: string;
  foreign_partners: boolean;
  exempt_payee_code: string;
  fatca_code: string;
  tax_id_type: 'ssn' | 'ein';
  tax_id: string;
  backup_withholding: boolean;
  w9_certified: boolean;
  w9_signature_name: string;
  insurance_provider: string;
  insurance_policy_number: string;
  insurance_expires_at: string;
  bank_name: string;
  account_holder_name: string;
  account_type: 'checking' | 'savings';
  routing_number: string;
  account_number: string;
  account_number_confirm: string;
  ach_authorized: boolean;
  payment_policy_accepted: boolean;
}

type FieldErrors = Partial<Record<keyof VendorForm | 'w9_files' | 'insurance_files', string>>;

const emptyForm: VendorForm = {
  company_name: '',
  contact_name: '',
  phone: '',
  email: '',
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  postal_code: '',
  w9_method: 'online',
  legal_name: '',
  business_name: '',
  tax_classification: '',
  llc_tax_class: '',
  other_classification: '',
  foreign_partners: false,
  exempt_payee_code: '',
  fatca_code: '',
  tax_id_type: 'ssn',
  tax_id: '',
  backup_withholding: false,
  w9_certified: false,
  w9_signature_name: '',
  insurance_provider: '',
  insurance_policy_number: '',
  insurance_expires_at: '',
  bank_name: '',
  account_holder_name: '',
  account_type: 'checking',
  routing_number: '',
  account_number: '',
  account_number_confirm: '',
  ach_authorized: false,
  payment_policy_accepted: false,
};

const TAX_CLASSIFICATIONS: Array<[string, string]> = [
  ['individual', 'Individual / sole proprietor or single-member LLC'],
  ['c_corporation', 'C corporation'],
  ['s_corporation', 'S corporation'],
  ['partnership', 'Partnership'],
  ['trust_estate', 'Trust / estate'],
  ['llc', 'Limited liability company (LLC)'],
  ['other', 'Other'],
];
const EIN_REQUIRED = new Set(['c_corporation', 's_corporation', 'partnership', 'trust_estate', 'llc']);
const ACCEPT = '.pdf,.jpg,.jpeg,.png,.gif,.webp,.heic,.heif,.tif,.tiff,.bmp,.doc,.docx,.odt,.rtf,application/pdf,image/*';

const inputClass = 'w-full min-h-11 rounded-xl border bg-white px-3.5 py-2.5 text-base text-gray-950 outline-none transition placeholder:text-gray-400 focus:border-amber-500 focus:ring-4 focus:ring-amber-100 sm:text-sm';

// ── formatting / validation (mirrors routes/vendorSetup.js) ────────────────

const digitsOnly = (value: string, max?: number) => {
  const digits = String(value || '').replace(/\D/g, '');
  return typeof max === 'number' ? digits.slice(0, max) : digits;
};

function formatTaxId(value: string, type: VendorForm['tax_id_type']) {
  const d = digitsOnly(value, 9);
  if (type === 'ssn') {
    if (d.length <= 3) return d;
    if (d.length <= 5) return `${d.slice(0, 3)}-${d.slice(3)}`;
    return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
  }
  return d.length <= 2 ? d : `${d.slice(0, 2)}-${d.slice(2)}`;
}

function formatPhone(value: string) {
  const d = digitsOnly(value, 11).replace(/^1(?=\d{10}$)/, '').slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function maskDigits(value: string, keep = 4) {
  const d = digitsOnly(value);
  if (!d) return '';
  return `${'•'.repeat(Math.max(d.length - keep, 3))}${d.slice(-keep)}`;
}

function validSsn(d: string) {
  return /^\d{9}$/.test(d) && !/^(000|666)/.test(d) && d.slice(3, 5) !== '00' && d.slice(5) !== '0000';
}

const INVALID_EIN_PREFIXES = new Set(['00', '07', '08', '09', '17', '18', '19', '28', '29', '49', '69', '70', '78', '79', '89', '96', '97']);
function validEin(d: string) {
  return /^\d{9}$/.test(d) && !INVALID_EIN_PREFIXES.has(d.slice(0, 2)) && !/^(\d)\1{8}$/.test(d);
}

function validRouting(d: string) {
  if (!/^\d{9}$/.test(d) || /^0{9}$/.test(d)) return false;
  const n = d.split('').map(Number);
  return (3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8])) % 10 === 0;
}

function validateForm(form: VendorForm, counts: Record<Kind, number>): FieldErrors {
  const e: FieldErrors = {};
  if (!form.company_name.trim()) e.company_name = 'Enter your company name';
  if (!form.contact_name.trim()) e.contact_name = 'Enter a contact name';
  if (digitsOnly(form.phone).replace(/^1(?=\d{10}$)/, '').length < 10) e.phone = 'Enter a 10-digit phone number';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) e.email = 'Enter a valid email address';
  if (!form.address_line1.trim()) e.address_line1 = 'Enter your mailing address';
  if (!form.city.trim()) e.city = 'Enter the city';
  if (!/^[A-Za-z]{2}$/.test(form.state.trim())) e.state = 'Enter the 2-letter state';
  if (!/^\d{5}(-?\d{4})?$/.test(form.postal_code.trim())) e.postal_code = 'Enter a 5-digit ZIP code';

  if (form.w9_method === 'online') {
    const tin = digitsOnly(form.tax_id);
    if (!form.legal_name.trim()) e.legal_name = 'Enter the name shown on your income tax return';
    if (!form.tax_classification) e.tax_classification = 'Choose a federal tax classification';
    if (form.tax_classification === 'llc' && !['C', 'S', 'P'].includes(form.llc_tax_class)) e.llc_tax_class = 'Choose how the LLC is taxed';
    if (form.tax_classification === 'other' && !form.other_classification.trim()) e.other_classification = 'Describe the tax classification';
    if (EIN_REQUIRED.has(form.tax_classification) && form.tax_id_type !== 'ein') e.tax_id_type = 'This classification uses an EIN';
    if (form.tax_id_type === 'ssn' && !validSsn(tin)) e.tax_id = 'Enter a valid 9-digit Social Security Number';
    if (form.tax_id_type === 'ein' && !validEin(tin)) e.tax_id = 'Enter a valid 9-digit EIN';
    if (!form.w9_certified) e.w9_certified = 'Check the certification box';
    if (form.w9_signature_name.trim().length < 3) e.w9_signature_name = 'Type your full name as your signature';
  } else if (!counts.w9) {
    e.w9_files = 'Upload your signed W-9, or choose "Fill out online"';
  }

  if (!counts.insurance) e.insurance_files = 'Upload your certificate of insurance';

  if (!form.bank_name.trim()) e.bank_name = 'Enter your bank name';
  if (!form.account_holder_name.trim()) e.account_holder_name = 'Enter the name on the account';
  if (!validRouting(digitsOnly(form.routing_number))) e.routing_number = 'Enter a valid 9-digit routing number';
  if (!/^\d{4,17}$/.test(digitsOnly(form.account_number))) e.account_number = 'Enter your account number (4 to 17 digits)';
  if (digitsOnly(form.account_number) && digitsOnly(form.account_number) !== digitsOnly(form.account_number_confirm)) {
    e.account_number_confirm = 'The account numbers do not match';
  }
  if (!form.ach_authorized) e.ach_authorized = 'Check the box to authorize direct deposit';
  if (!form.payment_policy_accepted) e.payment_policy_accepted = 'Please review and accept our payment policy';
  return e;
}

// Section order drives "scroll to the first problem".
const FIELD_ORDER: Array<keyof FieldErrors> = [
  'company_name', 'contact_name', 'phone', 'email', 'address_line1', 'city', 'state', 'postal_code',
  'legal_name', 'tax_classification', 'llc_tax_class', 'other_classification', 'tax_id_type', 'tax_id', 'w9_certified', 'w9_signature_name', 'w9_files',
  'insurance_files', 'insurance_expires_at',
  'bank_name', 'account_holder_name', 'routing_number', 'account_number', 'account_number_confirm', 'ach_authorized',
  'payment_policy_accepted',
];

async function requestJson<T>(url: string, options: RequestInit & { session?: string } = {}): Promise<T> {
  const { session, headers, ...rest } = options;
  const response = await fetch(url, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(session ? { Authorization: `Bearer ${session}` } : {}),
      ...((headers || {}) as Record<string, string>),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error || 'Something went wrong. Please try again.') as Error & { status?: number; data?: any };
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data as T;
}

function uploadWithProgress(file: File, kind: Kind, session: string, onProgress: (percent: number) => void) {
  return new Promise<{ status: number; data: any }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/vendor-setup/session/files');
    xhr.setRequestHeader('Authorization', `Bearer ${session}`);
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };
    xhr.onload = () => {
      let data: any = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* non-JSON error page */ }
      resolve({ status: xhr.status, data });
    };
    xhr.onerror = () => reject(new Error('The upload was interrupted. Please check your connection and try again.'));
    const body = new FormData();
    body.append('kind', kind);
    body.append('file', file, file.name);
    xhr.send(body);
  });
}

const dateLabel = (value?: string | null) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : '';
};

// ── small presentational pieces ─────────────────────────────────────────────

function Field({ id, label, required, hint, error, children, className = '' }: {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className} data-field={id}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-bold text-gray-800">
        {label}{required ? <span className="text-red-600"> *</span> : null}
      </label>
      {children}
      {hint && !error ? <p className="mt-1 text-xs text-gray-500">{hint}</p> : null}
      {error ? <p id={`${id}-error`} className="mt-1 text-xs font-bold text-red-600">{error}</p> : null}
    </div>
  );
}

function fieldClass(error?: string) {
  return `${inputClass} ${error ? 'border-red-400' : 'border-gray-300'}`;
}

function SensitiveInput({ id, value, onChange, placeholder, maxLength, error, mask }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  maxLength: number;
  error?: string;
  mask: (value: string) => string;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      id={id}
      value={focused ? value : mask(value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={event => onChange(event.target.value)}
      className={`${fieldClass(error)} font-mono tracking-wider`}
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      placeholder={placeholder}
      maxLength={focused ? maxLength : undefined}
      aria-invalid={Boolean(error)}
      aria-describedby={error ? `${id}-error` : undefined}
    />
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: Array<[T, string]>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="inline-flex w-full rounded-xl border border-gray-300 bg-gray-100 p-1 sm:w-auto" role="radiogroup" aria-label={label}>
      {options.map(([key, text]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={value === key}
          onClick={() => onChange(key)}
          className={`min-h-10 flex-1 rounded-lg px-4 text-sm font-bold transition sm:flex-none ${value === key ? 'bg-white text-gray-950 shadow-sm ring-1 ring-gray-200' : 'text-gray-600 hover:text-gray-900'}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function CheckRow({ id, checked, onChange, error, children }: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div data-field={id}>
      <label htmlFor={id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition ${checked ? 'border-emerald-300 bg-emerald-50' : error ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-white hover:border-gray-300'}`}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={event => onChange(event.target.checked)}
          className="mt-0.5 h-5 w-5 flex-shrink-0 cursor-pointer rounded border-gray-300"
          style={{ accentColor: '#047857' }}
        />
        <span className="text-sm leading-6 text-gray-800">{children}</span>
      </label>
      {error ? <p className="mt-1 text-xs font-bold text-red-600">{error}</p> : null}
    </div>
  );
}

function SectionCard({ id, step, title, done, icon, children }: {
  id: string;
  step: number;
  title: string;
  done: boolean;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-4 rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-3.5 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm font-black ${done ? 'bg-emerald-600 text-white' : 'bg-gray-900 text-white'}`}>
            {done ? <CheckCircle2 className="h-4 w-4" /> : step}
          </span>
          <h2 className="flex min-w-0 items-center gap-2 text-base font-black text-gray-950 sm:text-lg">
            <span className="hidden text-[#B7791F] sm:inline">{icon}</span>
            <span className="truncate">{title}</span>
          </h2>
        </div>
        {done ? <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700">Complete</span> : null}
      </div>
      <div className="p-4 sm:p-6">{children}</div>
    </section>
  );
}

function DropZone({ id, kind, title, hint, files, queue, onFiles, onRemove, onDismiss, error, disabled }: {
  id: string;
  kind: Kind;
  title: string;
  hint: string;
  files: UploadedFile[];
  queue: QueuedUpload[];
  onFiles: (kind: Kind, files: File[]) => void;
  onRemove: (file: UploadedFile) => void;
  onDismiss: (key: string) => void;
  error?: string;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const handlers = fileDropHandlers(dropped => onFiles(kind, dropped), { disabled });
  return (
    <div data-field={id}>
      <div
        {...handlers}
        className={`rounded-2xl border-2 border-dashed p-5 text-center transition ${error ? 'border-red-300 bg-red-50' : 'border-gray-300 bg-gray-50 hover:border-amber-400 hover:bg-amber-50/40'}`}
      >
        <Upload className="mx-auto h-7 w-7 text-gray-400" />
        <p className="mt-2 text-sm font-bold text-gray-900">{title}</p>
        <p className="mt-1 text-xs text-gray-500">{hint}</p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          className="mt-3 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-gray-900 px-4 text-sm font-bold text-white transition hover:bg-gray-800 disabled:opacity-50"
        >
          <Upload className="h-4 w-4" />
          Choose file or take photo
        </button>
        <input
          ref={inputRef}
          id={id}
          type="file"
          accept={ACCEPT}
          multiple
          className="sr-only"
          tabIndex={-1}
          onChange={event => {
            const picked = Array.from(event.target.files || []);
            event.target.value = '';
            if (picked.length) onFiles(kind, picked);
          }}
        />
      </div>
      {error ? <p className="mt-1 text-xs font-bold text-red-600">{error}</p> : null}
      {files.length || queue.length ? (
        <ul className="mt-3 space-y-2">
          {files.map(file => (
            <li key={file.id} className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5">
              <FileText className="h-5 w-5 flex-shrink-0 text-emerald-700" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-gray-900">{file.original_name}</p>
                <p className="text-xs text-emerald-800">Uploaded securely · {formatFileSize(file.size_bytes)}</p>
              </div>
              <button
                type="button"
                onClick={() => onRemove(file)}
                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-white hover:text-red-600"
                aria-label={`Remove ${file.original_name}`}
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
          {queue.map(item => (
            <li key={item.key} className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 ${item.error ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-white'}`}>
              {item.error ? <AlertCircle className="h-5 w-5 flex-shrink-0 text-red-600" /> : <Loader2 className="h-5 w-5 flex-shrink-0 animate-spin text-amber-600" />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-gray-900">{item.file.name}</p>
                {item.error ? (
                  <p className="text-xs font-bold text-red-700">{item.error}</p>
                ) : (
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-200">
                    <div className="h-full rounded-full bg-amber-500 transition-all" style={{ width: `${Math.max(item.progress, 4)}%` }} />
                  </div>
                )}
              </div>
              {item.error ? (
                <button
                  type="button"
                  onClick={() => onDismiss(item.key)}
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-white"
                  aria-label={`Dismiss ${item.file.name}`}
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ContactCard({ company }: { company: CompanyInfo }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <p className="text-xs font-black uppercase tracking-[0.14em] text-gray-500">Questions? Contact us</p>
      <p className="mt-2 text-base font-black text-gray-950">{company.name}</p>
      <div className="mt-3 space-y-2.5 text-sm text-gray-700">
        <p className="flex items-start gap-2.5"><MapPin className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#B7791F]" /><span>{company.street}<br />{company.cityStateZip}</span></p>
        <p className="flex items-center gap-2.5"><Phone className="h-4 w-4 flex-shrink-0 text-[#B7791F]" /><a href={company.phoneHref} className="font-bold text-gray-950 hover:underline">{company.phone}</a></p>
        <p className="flex items-center gap-2.5"><Mail className="h-4 w-4 flex-shrink-0 text-[#B7791F]" /><a href={`mailto:${company.email}`} className="font-bold text-gray-950 hover:underline">{company.email}</a></p>
        <p className="flex items-center gap-2.5"><Clock3 className="h-4 w-4 flex-shrink-0 text-[#B7791F]" /><span>{company.hours}</span></p>
      </div>
    </div>
  );
}

function SecureNote({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 ${compact ? 'p-3.5' : 'p-4'}`}>
      <LockKeyhole className="mt-0.5 h-5 w-5 flex-shrink-0 text-emerald-700" />
      <div>
        <p className="text-sm font-black text-emerald-900">This is a secure portal</p>
        <p className="mt-0.5 text-xs leading-5 text-emerald-900">
          Your information goes directly to New Urban Development. It is sent over an encrypted connection, your tax ID and bank details are encrypted when stored, and only authorized members of our office can view them.
        </p>
      </div>
    </div>
  );
}

// ── the page ───────────────────────────────────────────────────────────────

export default function VendorSetup() {
  const { token = '' } = useParams();
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);

  const [session, setSession] = useState('');
  const [code, setCode] = useState('');
  const [codeMessage, setCodeMessage] = useState('');
  const [codeError, setCodeError] = useState('');
  const [sendingCode, setSendingCode] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [reverifyNotice, setReverifyNotice] = useState(false);

  const [form, setForm] = useState<VendorForm>(emptyForm);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [queue, setQueue] = useState<QueuedUpload[]>([]);
  const [touched, setTouched] = useState(false);
  const [autosave, setAutosave] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const sessionRef = useRef('');
  const uploadingRef = useRef(false);
  const queueRef = useRef<QueuedUpload[]>([]);
  const codeSentKey = `bt-vendor-setup-code:${token.slice(0, 16)}`;

  const adoptSession = useCallback((next?: string) => {
    if (!next) return;
    sessionRef.current = next;
    setSession(next);
  }, []);

  const sessionExpired = useCallback(() => {
    sessionRef.current = '';
    setSession('');
    setReverifyNotice(true);
    setCode('');
  }, []);

  // 1. open the link
  useEffect(() => {
    let alive = true;
    requestJson<Lookup>(`/api/vendor-setup/public/${encodeURIComponent(token)}`)
      .then(data => { if (alive) setLookup(data); })
      .catch(err => { if (alive) setLoadError(err.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [token]);

  const sendCode = useCallback(async (mode: 'auto' | 'manual') => {
    setSendingCode(true);
    setCodeError('');
    try {
      const data = await requestJson<{ email_hint: string }>(`/api/vendor-setup/public/${encodeURIComponent(token)}/send-code`, { method: 'POST', body: '{}' });
      try { sessionStorage.setItem(codeSentKey, String(Date.now())); } catch { /* private mode */ }
      setCodeMessage(mode === 'auto'
        ? `We emailed a 6-digit verification code to ${data.email_hint}.`
        : `A new code was sent to ${data.email_hint}. Use the newest code.`);
    } catch (err: any) {
      const wait = err.data?.retry_after_seconds ? Math.ceil(err.data.retry_after_seconds / 60) : 0;
      setCodeError(err.status === 429 && wait
        ? `${err.message} (about ${wait} minute${wait === 1 ? '' : 's'}).`
        : err.message);
    } finally {
      setSendingCode(false);
    }
  }, [codeSentKey, token]);

  // 2. email the code once per visit (not again on a quick refresh)
  const autoSent = useRef(false);
  useEffect(() => {
    if (!lookup || autoSent.current || session) return;
    if (!['sent', 'verified'].includes(lookup.status)) return;
    autoSent.current = true;
    let recent = 0;
    try { recent = Number(sessionStorage.getItem(codeSentKey) || 0); } catch { /* private mode */ }
    if (Date.now() - recent < 10 * 60 * 1000) {
      setCodeMessage(`We already emailed a 6-digit code to ${lookup.email_hint}. Check your inbox (and spam folder).`);
      return;
    }
    sendCode('auto');
  }, [codeSentKey, lookup, sendCode, session]);

  const verify = async (event?: FormEvent) => {
    event?.preventDefault();
    if (code.length !== 6 || verifying) return;
    setVerifying(true);
    setCodeError('');
    try {
      const data = await requestJson<{
        setup_session: string;
        prefill: { company_name: string; email: string };
        draft: { form: Partial<VendorForm> } | null;
        files: UploadedFile[];
      }>(`/api/vendor-setup/public/${encodeURIComponent(token)}/verify`, { method: 'POST', body: JSON.stringify({ code }) });
      adoptSession(data.setup_session);
      setFiles(data.files || []);
      // After a session timeout the answers on screen are newer than the draft.
      if (!touched) {
        setForm(prev => ({
          ...prev,
          company_name: data.prefill.company_name,
          email: data.prefill.email,
          account_holder_name: data.prefill.company_name,
          ...(data.draft?.form || {}),
        }));
      }
      setReverifyNotice(false);
      setCode('');
      try { sessionStorage.removeItem(codeSentKey); } catch { /* private mode */ }
    } catch (err: any) {
      setCodeError(err.message);
    } finally {
      setVerifying(false);
    }
  };

  const update = <K extends keyof VendorForm>(key: K, value: VendorForm[K]) => {
    setTouched(true);
    setForm(prev => ({ ...prev, [key]: value }));
    setErrors(prev => (prev[key] ? { ...prev, [key]: undefined } : prev));
  };

  // 3. autosave (encrypted on the server) a moment after typing stops
  const saveDraft = useCallback(async (keepalive = false) => {
    const current = sessionRef.current;
    if (!current || !touched || submitted) return;
    setAutosave('saving');
    try {
      const data = await requestJson<{ setup_session?: string }>('/api/vendor-setup/session/autosave', {
        method: 'POST',
        session: current,
        body: JSON.stringify(form),
        keepalive,
      });
      adoptSession(data.setup_session);
      setAutosave('saved');
    } catch (err: any) {
      if (err.status === 401) sessionExpired();
      setAutosave('error');
    }
  }, [adoptSession, form, sessionExpired, submitted, touched]);

  useEffect(() => {
    if (!session || !touched || submitted) return;
    const timer = window.setTimeout(() => saveDraft(false), 1500);
    return () => window.clearTimeout(timer);
  }, [form, saveDraft, session, submitted, touched]);

  useEffect(() => {
    if (!session || submitted) return;
    const flush = () => { if (document.visibilityState === 'hidden') saveDraft(true); };
    document.addEventListener('visibilitychange', flush);
    return () => document.removeEventListener('visibilitychange', flush);
  }, [saveDraft, session, submitted]);

  // 4. uploads, one at a time, straight away (so nothing is lost on a refresh)
  const pumpQueue = useCallback(async () => {
    if (uploadingRef.current) return;
    uploadingRef.current = true;
    try {
      for (;;) {
        const next = queueRef.current.find(item => !item.error);
        if (!next || !sessionRef.current) break;
        let attempt = 0;
        for (;;) {
          attempt += 1;
          try {
            const result = await uploadWithProgress(next.file, next.kind, sessionRef.current, percent => {
              queueRef.current = queueRef.current.map(item => (item.key === next.key ? { ...item, progress: percent } : item));
              setQueue(queueRef.current);
            });
            if (result.status === 429 && attempt < 6) {
              await new Promise(resolve => window.setTimeout(resolve, 1500 * attempt));
              continue;
            }
            if (result.status === 401) {
              sessionExpired();
              queueRef.current = queueRef.current.map(item => (item.key === next.key ? { ...item, error: 'Please verify your email again, then re-add this file.' } : item));
            } else if (result.status >= 200 && result.status < 300 && result.data?.file) {
              adoptSession(result.data.setup_session);
              setFiles(prev => [...prev, result.data.file]);
              if (next.kind !== 'bank') setErrors(prev => ({ ...prev, [`${next.kind}_files`]: undefined }));
              queueRef.current = queueRef.current.filter(item => item.key !== next.key);
            } else {
              queueRef.current = queueRef.current.map(item => (item.key === next.key ? { ...item, error: result.data?.error || 'This file could not be uploaded.' } : item));
            }
          } catch (err: any) {
            queueRef.current = queueRef.current.map(item => (item.key === next.key ? { ...item, error: err.message } : item));
          }
          break;
        }
        setQueue(queueRef.current);
      }
    } finally {
      uploadingRef.current = false;
    }
  }, [adoptSession, sessionExpired]);

  const addFiles = (kind: Kind, picked: File[]) => {
    const maxBytes = (lookup?.limits.max_file_mb || 20) * 1024 * 1024;
    const additions = picked.map((file, index) => ({
      key: `${Date.now()}-${index}-${file.name}`,
      kind,
      file,
      progress: 0,
      error: file.size > maxBytes ? `This file is larger than ${lookup?.limits.max_file_mb || 20} MB.` : undefined,
    }));
    queueRef.current = [...queueRef.current, ...additions];
    setQueue(queueRef.current);
    pumpQueue();
  };

  const dismissQueued = (key: string) => {
    queueRef.current = queueRef.current.filter(item => item.key !== key);
    setQueue(queueRef.current);
  };

  const removeFile = async (file: UploadedFile) => {
    try {
      const data = await requestJson<{ setup_session?: string }>(`/api/vendor-setup/session/files/${file.id}`, { method: 'DELETE', session: sessionRef.current });
      adoptSession(data.setup_session);
      setFiles(prev => prev.filter(item => item.id !== file.id));
    } catch (err: any) {
      if (err.status === 401) sessionExpired();
      else window.alert(err.message);
    }
  };

  const counts = useMemo(() => ({
    w9: files.filter(file => file.kind === 'w9').length,
    insurance: files.filter(file => file.kind === 'insurance').length,
    bank: files.filter(file => file.kind === 'bank').length,
  }), [files]);

  const liveErrors = useMemo(() => validateForm(form, counts), [counts, form]);
  const done = {
    business: !['company_name', 'contact_name', 'phone', 'email', 'address_line1', 'city', 'state', 'postal_code'].some(key => liveErrors[key as keyof FieldErrors]),
    w9: !['legal_name', 'tax_classification', 'llc_tax_class', 'other_classification', 'tax_id_type', 'tax_id', 'w9_certified', 'w9_signature_name', 'w9_files'].some(key => liveErrors[key as keyof FieldErrors]),
    insurance: !liveErrors.insurance_files,
    ach: !['bank_name', 'account_holder_name', 'routing_number', 'account_number', 'account_number_confirm', 'ach_authorized'].some(key => liveErrors[key as keyof FieldErrors]),
    policy: form.payment_policy_accepted,
  };

  const scrollToFirstError = (found: FieldErrors) => {
    const first = FIELD_ORDER.find(key => found[key]);
    if (!first) return;
    window.setTimeout(() => {
      const node = document.querySelector(`[data-field="${first}"]`);
      node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const input = document.getElementById(first);
      if ((input instanceof HTMLInputElement && input.type !== 'file') || input instanceof HTMLSelectElement) input.focus({ preventScroll: true });
    }, 50);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitError('');
    if (queue.some(item => !item.error)) {
      setSubmitError('Please wait for your files to finish uploading.');
      return;
    }
    const found = validateForm(form, counts);
    if (Object.values(found).some(Boolean)) {
      setErrors(found);
      setSubmitError('A few items still need your attention. They are highlighted in red.');
      scrollToFirstError(found);
      return;
    }
    setSubmitting(true);
    try {
      await requestJson('/api/vendor-setup/session/submit', { method: 'POST', session: sessionRef.current, body: JSON.stringify(form) });
      setSubmitted(true);
      sessionRef.current = '';
      setSession('');
      document.getElementById('vendor-setup-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err: any) {
      if (err.status === 401) {
        sessionExpired();
        setSubmitError('For your security, please verify your email again. Your answers are still here.');
      } else if (err.status === 409) {
        setSubmitted(true);
      } else {
        const serverFields = (err.data?.fields || {}) as FieldErrors;
        setErrors(serverFields);
        setSubmitError(err.message);
        scrollToFirstError(serverFields);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const company = lookup?.company;
  const policy = lookup?.payment_policy;
  const vendorName = form.company_name || lookup?.company_name || 'your company';
  const showForm = Boolean(session) && !submitted;
  const needsCode = Boolean(lookup) && !session && !submitted && ['sent', 'verified'].includes(lookup!.status);

  // ── render ──
  const header = (
    <header className="bg-[#0D1117] text-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <img src="/nud-logo.jpg" alt="New Urban Development" data-no-image-lightbox="true" className="h-10 w-auto flex-shrink-0 rounded-md sm:h-12" />
          <div className="min-w-0 border-l border-white/15 pl-3">
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#D99D26]">Vendor Setup</p>
            <p className="truncate text-[13px] font-bold text-white/90 sm:text-base">New Urban Development</p>
          </div>
        </div>
        <span className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border border-emerald-400/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-bold text-emerald-200">
          <LockKeyhole className="h-3.5 w-3.5" />
          <span className="sm:hidden">Secure</span>
          <span className="hidden sm:inline">Secure portal</span>
        </span>
      </div>
    </header>
  );

  const checklist = (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <p className="text-xs font-black uppercase tracking-[0.14em] text-gray-500">What we need</p>
      <ul className="mt-3 space-y-2.5 text-sm">
        {[
          ['Business and contact details', done.business],
          ['Form W-9', done.w9],
          ['Certificate of insurance', done.insurance],
          ['ACH direct deposit', done.ach],
          ['Payment policy', done.policy],
        ].map(([label, ok]) => (
          <li key={String(label)} className="flex items-center gap-2.5">
            {ok ? <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-emerald-600" /> : <Circle className="h-4 w-4 flex-shrink-0 text-gray-300" />}
            <span className={ok ? 'font-bold text-gray-900' : 'text-gray-600'}>{label as string}</span>
          </li>
        ))}
      </ul>
    </div>
  );

  let body: ReactNode;
  if (loading) {
    body = (
      <div className="flex items-center justify-center gap-3 rounded-2xl border border-gray-200 bg-white p-12 text-sm font-bold text-gray-600">
        <Loader2 className="h-5 w-5 animate-spin text-amber-600" />
        Opening your secure vendor setup...
      </div>
    );
  } else if (loadError || !lookup) {
    body = (
      <div className="rounded-2xl border border-red-200 bg-white p-8 text-center shadow-sm">
        <AlertCircle className="mx-auto h-10 w-10 text-red-500" />
        <h1 className="mt-3 text-xl font-black text-gray-950">This link can't be opened</h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-gray-600">{loadError || 'This vendor setup link is not valid.'} If you need help, call (248) 621-4722 or email info@newurbandev.com.</p>
      </div>
    );
  } else if (submitted || lookup.status === 'submitted') {
    body = (
      <div className="rounded-2xl border border-emerald-200 bg-white p-8 text-center shadow-sm sm:p-10">
        <CheckCircle2 className="mx-auto h-14 w-14 text-emerald-600" />
        <h1 className="mt-4 text-2xl font-black text-gray-950">Thank you &mdash; you're all set</h1>
        <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-gray-600">
          {submitted
            ? `Your vendor information was sent securely to New Urban Development. We emailed a confirmation to ${form.email || 'you'}. Our office will review everything and contact you if anything else is needed.`
            : `The vendor setup for ${lookup.company_name} was already submitted${lookup.submitted_at ? ` on ${dateLabel(lookup.submitted_at)}` : ''}. If you need to change anything, please contact our office.`}
        </p>
        <p className="mt-4 text-sm font-bold text-gray-900">You may now close this page.</p>
      </div>
    );
  } else if (lookup.status === 'expired') {
    body = (
      <div className="rounded-2xl border border-amber-200 bg-white p-8 text-center shadow-sm">
        <Clock3 className="mx-auto h-10 w-10 text-amber-600" />
        <h1 className="mt-3 text-xl font-black text-gray-950">This link has expired</h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-gray-600">
          For your security, vendor setup links expire after 14 days. Please call {lookup.company.phone} or email {lookup.company.email} and we will send you a new link.
        </p>
      </div>
    );
  } else if (needsCode) {
    body = (
      <div className="space-y-5">
        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm sm:p-7">
          <p className="text-xs font-black uppercase tracking-[0.14em] text-[#B7791F]">Welcome to New Urban Development</p>
          <h1 className="mt-2 text-2xl font-black leading-tight text-gray-950 sm:text-3xl">Vendor setup for {lookup.company_name}</h1>
          <p className="mt-3 text-sm leading-6 text-gray-600">
            Thank you for working with us. This secure form collects your W-9, certificate of insurance and direct deposit details so we can set you up as a vendor and pay you by ACH. It takes about five minutes.
          </p>
        </div>
        <form onSubmit={verify} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm sm:p-7">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700 ring-1 ring-amber-200">
              <Mail className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-lg font-black text-gray-950">{reverifyNotice ? 'Please verify your email again' : 'Verify your email'}</h2>
              <p className="mt-1 text-sm leading-6 text-gray-600">
                {reverifyNotice
                  ? 'For your security, your session timed out. Your answers are still on this page; enter a new code to continue.'
                  : `To protect your information, enter the 6-digit code we emailed to ${lookup.email_hint}.`}
              </p>
            </div>
          </div>
          {codeMessage ? <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">{codeMessage}</p> : null}
          {codeError ? <p role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">{codeError}</p> : null}
          <label htmlFor="vendor-setup-code" className="mt-5 block text-sm font-bold text-gray-800">Verification code</label>
          <div className="mt-1.5 grid gap-3 sm:grid-cols-[1fr_auto]">
            <input
              id="vendor-setup-code"
              value={code}
              onChange={event => setCode(digitsOnly(event.target.value, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              className={`${inputClass} border-gray-300 text-center font-mono text-2xl font-black tracking-[0.4em] sm:text-2xl`}
            />
            <button
              type="submit"
              disabled={verifying || code.length !== 6}
              className="min-h-11 rounded-xl bg-gray-950 px-6 text-sm font-black text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {verifying ? 'Verifying...' : 'Verify and continue'}
            </button>
          </div>
          <button
            type="button"
            onClick={() => sendCode('manual')}
            disabled={sendingCode}
            className="mt-4 inline-flex min-h-10 items-center gap-2 text-sm font-bold text-gray-700 underline-offset-4 hover:underline disabled:opacity-50"
          >
            <Mail className="h-4 w-4" />
            {sendingCode ? 'Sending...' : 'Email me a new code'}
          </button>
          <p className="mt-1 text-xs text-gray-500">Codes expire after 10 minutes. Check your spam folder if you don't see it.</p>
        </form>
        <SecureNote />
      </div>
    );
  } else {
    const isBusiness = EIN_REQUIRED.has(form.tax_classification);
    const showForeign = ['partnership', 'trust_estate'].includes(form.tax_classification) || (form.tax_classification === 'llc' && form.llc_tax_class === 'P');
    body = (
      <form onSubmit={submit} className="space-y-5" noValidate>
        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm sm:p-7">
          <p className="text-xs font-black uppercase tracking-[0.14em] text-[#B7791F]">Welcome to New Urban Development</p>
          <h1 className="mt-2 text-2xl font-black leading-tight text-gray-950 sm:text-3xl">Vendor setup for {lookup.company_name}</h1>
          <p className="mt-3 text-sm leading-6 text-gray-600">
            Please complete each section below. Your progress saves automatically, so you can come back to this link and pick up where you left off.
          </p>
        </div>

        <SectionCard id="section-business" step={1} title="Business and contact details" done={done.business} icon={<Building2 className="h-5 w-5" />}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="company_name" label="Company name" required error={errors.company_name} className="sm:col-span-2">
              <input id="company_name" value={form.company_name} onChange={e => update('company_name', e.target.value)} className={fieldClass(errors.company_name)} autoComplete="organization" maxLength={150} />
            </Field>
            <Field id="contact_name" label="Primary contact name" required error={errors.contact_name}>
              <input id="contact_name" value={form.contact_name} onChange={e => update('contact_name', e.target.value)} className={fieldClass(errors.contact_name)} autoComplete="name" maxLength={120} />
            </Field>
            <Field id="phone" label="Phone number" required error={errors.phone}>
              <input id="phone" value={form.phone} onChange={e => update('phone', formatPhone(e.target.value))} className={fieldClass(errors.phone)} inputMode="tel" autoComplete="tel" placeholder="(248) 555-0100" />
            </Field>
            <Field id="email" label="Email address" required error={errors.email} hint="We send payment and invoice updates here." className="sm:col-span-2">
              <input id="email" type="email" value={form.email} onChange={e => update('email', e.target.value)} className={fieldClass(errors.email)} autoComplete="email" maxLength={160} />
            </Field>
            <Field id="address_line1" label="Mailing address" required error={errors.address_line1} className="sm:col-span-2">
              <GooglePlacesInput
                id="address_line1"
                value={form.address_line1}
                onChange={value => update('address_line1', value)}
                onPlaceSelect={place => {
                  setTouched(true);
                  setForm(prev => ({
                    ...prev,
                    address_line1: place.streetAddress || prev.address_line1,
                    city: place.city || prev.city,
                    state: (place.state || prev.state).toUpperCase().slice(0, 2),
                    postal_code: (place.postalCode || prev.postal_code).slice(0, 10),
                  }));
                  setErrors(prev => ({ ...prev, address_line1: undefined, city: undefined, state: undefined, postal_code: undefined }));
                }}
                placeholder="Street address"
                className={fieldClass(errors.address_line1)}
              />
            </Field>
            <Field id="address_line2" label="Suite / unit (optional)" className="sm:col-span-2">
              <input id="address_line2" value={form.address_line2} onChange={e => update('address_line2', e.target.value)} className={fieldClass()} maxLength={160} />
            </Field>
            <Field id="city" label="City" required error={errors.city}>
              <input id="city" value={form.city} onChange={e => update('city', e.target.value)} className={fieldClass(errors.city)} autoComplete="address-level2" maxLength={80} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field id="state" label="State" required error={errors.state}>
                <input id="state" value={form.state} onChange={e => update('state', e.target.value.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 2))} className={fieldClass(errors.state)} autoComplete="address-level1" placeholder="MI" />
              </Field>
              <Field id="postal_code" label="ZIP" required error={errors.postal_code}>
                <input id="postal_code" value={form.postal_code} onChange={e => update('postal_code', e.target.value.replace(/[^0-9-]/g, '').slice(0, 10))} className={fieldClass(errors.postal_code)} inputMode="numeric" autoComplete="postal-code" />
              </Field>
            </div>
          </div>
        </SectionCard>

        <SectionCard id="section-w9" step={2} title="Form W-9" done={done.w9} icon={<FileCheck2 className="h-5 w-5" />}>
          <p className="mb-4 text-sm leading-6 text-gray-600">We need a W-9 for year-end 1099 reporting. Fill it out here, or upload a signed W-9 in any format &mdash; PDF, a photo, or a Word document.</p>
          <Segmented
            label="How would you like to provide your W-9?"
            value={form.w9_method}
            onChange={value => update('w9_method', value)}
            options={[['online', 'Fill out online'], ['upload', 'Upload my W-9']]}
          />
          {form.w9_method === 'upload' ? (
            <div className="mt-5 space-y-3">
              <DropZone
                id="w9_files"
                kind="w9"
                title="Drag and drop your signed W-9 here"
                hint={`PDF, JPG, PNG, HEIC or Word · up to ${lookup.limits.max_file_mb} MB per file`}
                files={files.filter(file => file.kind === 'w9')}
                queue={queue.filter(item => item.kind === 'w9')}
                onFiles={addFiles}
                onRemove={removeFile}
                onDismiss={dismissQueued}
                error={errors.w9_files}
              />
              <p className="text-xs text-gray-500">
                Need a blank form? <a href="https://www.irs.gov/pub/irs-pdf/fw9.pdf" target="_blank" rel="noreferrer" className="font-bold text-gray-900 underline">Download Form W-9 from irs.gov</a>, sign it, and upload it here.
              </p>
            </div>
          ) : (
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <Field id="legal_name" label="Name (as shown on your income tax return)" required error={errors.legal_name} hint="W-9 line 1. For a sole proprietor, your own name." className="sm:col-span-2">
                <input id="legal_name" value={form.legal_name} onChange={e => update('legal_name', e.target.value)} className={fieldClass(errors.legal_name)} maxLength={150} />
              </Field>
              <Field id="business_name" label="Business name / DBA, if different" hint="W-9 line 2" className="sm:col-span-2">
                <input id="business_name" value={form.business_name} onChange={e => update('business_name', e.target.value)} className={fieldClass()} maxLength={150} />
              </Field>
              <Field id="tax_classification" label="Federal tax classification" required error={errors.tax_classification} className="sm:col-span-2">
                <select
                  id="tax_classification"
                  value={form.tax_classification}
                  onChange={e => {
                    const next = e.target.value;
                    setTouched(true);
                    setForm(prev => ({
                      ...prev,
                      tax_classification: next,
                      tax_id_type: EIN_REQUIRED.has(next) ? 'ein' : prev.tax_id_type,
                      tax_id: formatTaxId(prev.tax_id, EIN_REQUIRED.has(next) ? 'ein' : prev.tax_id_type),
                    }));
                    setErrors(prev => ({ ...prev, tax_classification: undefined, tax_id_type: undefined }));
                  }}
                  className={fieldClass(errors.tax_classification)}
                >
                  <option value="">Select a classification</option>
                  {TAX_CLASSIFICATIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </Field>
              {form.tax_classification === 'llc' ? (
                <Field id="llc_tax_class" label="The LLC is taxed as" required error={errors.llc_tax_class} className="sm:col-span-2">
                  <select id="llc_tax_class" value={form.llc_tax_class} onChange={e => update('llc_tax_class', e.target.value)} className={fieldClass(errors.llc_tax_class)}>
                    <option value="">Select one</option>
                    <option value="C">C corporation (C)</option>
                    <option value="S">S corporation (S)</option>
                    <option value="P">Partnership (P)</option>
                  </select>
                </Field>
              ) : null}
              {form.tax_classification === 'other' ? (
                <Field id="other_classification" label="Describe the classification" required error={errors.other_classification} className="sm:col-span-2">
                  <input id="other_classification" value={form.other_classification} onChange={e => update('other_classification', e.target.value)} className={fieldClass(errors.other_classification)} maxLength={80} />
                </Field>
              ) : null}
              {showForeign ? (
                <div className="sm:col-span-2">
                  <CheckRow id="foreign_partners" checked={form.foreign_partners} onChange={value => update('foreign_partners', value)}>
                    We have foreign partners, owners, or beneficiaries (W-9 line 3b). Leave unchecked if this does not apply.
                  </CheckRow>
                </div>
              ) : null}
              <Field id="tax_id_type" label="Taxpayer identification number type" required error={errors.tax_id_type} className="sm:col-span-2">
                <Segmented
                  label="Taxpayer identification number type"
                  value={form.tax_id_type}
                  onChange={value => {
                    setTouched(true);
                    setForm(prev => ({ ...prev, tax_id_type: value, tax_id: formatTaxId(prev.tax_id, value) }));
                    setErrors(prev => ({ ...prev, tax_id_type: undefined, tax_id: undefined }));
                  }}
                  options={isBusiness ? [['ein', 'Employer ID (EIN)']] : [['ssn', 'Social Security (SSN)'], ['ein', 'Employer ID (EIN)']]}
                />
              </Field>
              <Field id="tax_id" label={form.tax_id_type === 'ssn' ? 'Social Security Number' : 'Employer Identification Number'} required error={errors.tax_id} hint="Hidden when you leave the field.">
                <SensitiveInput
                  id="tax_id"
                  value={form.tax_id}
                  onChange={value => update('tax_id', formatTaxId(value, form.tax_id_type))}
                  placeholder={form.tax_id_type === 'ssn' ? '123-45-6789' : '12-3456789'}
                  maxLength={form.tax_id_type === 'ssn' ? 11 : 10}
                  error={errors.tax_id}
                  mask={value => maskDigits(value)}
                />
              </Field>
              <details className="rounded-xl border border-gray-200 bg-gray-50 p-3 sm:col-span-2">
                <summary className="cursor-pointer text-sm font-bold text-gray-700">Exemption codes (most vendors leave these blank)</summary>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <Field id="exempt_payee_code" label="Exempt payee code">
                    <input id="exempt_payee_code" value={form.exempt_payee_code} onChange={e => update('exempt_payee_code', e.target.value.slice(0, 4))} className={fieldClass()} />
                  </Field>
                  <Field id="fatca_code" label="FATCA exemption code">
                    <input id="fatca_code" value={form.fatca_code} onChange={e => update('fatca_code', e.target.value.slice(0, 4))} className={fieldClass()} />
                  </Field>
                </div>
              </details>
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-xs leading-5 text-gray-700 sm:col-span-2">
                <p className="font-black uppercase tracking-wide text-gray-900">Certification</p>
                <p className="mt-1">Under penalties of perjury, I certify that:</p>
                <ol className="mt-1 list-decimal space-y-1 pl-5">
                  <li>The number shown on this form is my correct taxpayer identification number (or I am waiting for a number to be issued to me); and</li>
                  <li>I am not subject to backup withholding because (a) I am exempt from backup withholding, or (b) I have not been notified by the Internal Revenue Service (IRS) that I am subject to backup withholding as a result of a failure to report all interest or dividends, or (c) the IRS has notified me that I am no longer subject to backup withholding; and</li>
                  <li>I am a U.S. citizen or other U.S. person; and</li>
                  <li>The FATCA code(s) entered on this form (if any) indicating that I am exempt from FATCA reporting is correct.</li>
                </ol>
                <p className="mt-2">Your mailing address above is used as your W-9 address.</p>
              </div>
              <div className="sm:col-span-2">
                <CheckRow id="backup_withholding" checked={form.backup_withholding} onChange={value => update('backup_withholding', value)}>
                  The IRS has notified me that I am currently subject to backup withholding, so item 2 above does not apply to me. <span className="text-gray-500">(Leave unchecked if this does not apply.)</span>
                </CheckRow>
              </div>
              <div className="sm:col-span-2">
                <CheckRow id="w9_certified" checked={form.w9_certified} onChange={value => update('w9_certified', value)} error={errors.w9_certified}>
                  <strong>I certify</strong> that the information above is correct, under penalties of perjury.
                </CheckRow>
              </div>
              <Field id="w9_signature_name" label="Signature: type your full legal name" required error={errors.w9_signature_name} hint={`Signed electronically on ${dateLabel(new Date().toISOString())}.`} className="sm:col-span-2">
                <input id="w9_signature_name" value={form.w9_signature_name} onChange={e => update('w9_signature_name', e.target.value)} className={`${fieldClass(errors.w9_signature_name)} font-serif text-lg italic`} autoComplete="name" maxLength={120} />
              </Field>
            </div>
          )}
        </SectionCard>

        <SectionCard id="section-insurance" step={3} title="Certificate of insurance" done={done.insurance} icon={<ShieldCheck className="h-5 w-5" />}>
          <p className="mb-4 text-sm leading-6 text-gray-600">Please upload your current certificate of insurance (COI).</p>
          <DropZone
            id="insurance_files"
            kind="insurance"
            title="Drag and drop your insurance certificate here"
            hint={`PDF, JPG, PNG, HEIC or Word · up to ${lookup.limits.max_file_mb} MB per file`}
            files={files.filter(file => file.kind === 'insurance')}
            queue={queue.filter(item => item.kind === 'insurance')}
            onFiles={addFiles}
            onRemove={removeFile}
            onDismiss={dismissQueued}
            error={errors.insurance_files}
          />
          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            <Field id="insurance_provider" label="Insurance company (optional)">
              <input id="insurance_provider" value={form.insurance_provider} onChange={e => update('insurance_provider', e.target.value)} className={fieldClass()} maxLength={120} />
            </Field>
            <Field id="insurance_policy_number" label="Policy number (optional)">
              <input id="insurance_policy_number" value={form.insurance_policy_number} onChange={e => update('insurance_policy_number', e.target.value)} className={fieldClass()} maxLength={60} />
            </Field>
            <Field id="insurance_expires_at" label="Expiration date (optional)" error={errors.insurance_expires_at}>
              <input id="insurance_expires_at" type="date" value={form.insurance_expires_at} onChange={e => update('insurance_expires_at', e.target.value)} className={fieldClass(errors.insurance_expires_at)} />
            </Field>
          </div>
        </SectionCard>

        <SectionCard id="section-ach" step={4} title="ACH direct deposit" done={done.ach} icon={<Landmark className="h-5 w-5" />}>
          <p className="mb-4 text-sm leading-6 text-gray-600">We pay vendors by direct deposit. Enter the bank account where you would like to receive payments.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="bank_name" label="Bank name" required error={errors.bank_name}>
              <input id="bank_name" value={form.bank_name} onChange={e => update('bank_name', e.target.value)} className={fieldClass(errors.bank_name)} maxLength={120} />
            </Field>
            <Field id="account_holder_name" label="Name on the account" required error={errors.account_holder_name}>
              <input id="account_holder_name" value={form.account_holder_name} onChange={e => update('account_holder_name', e.target.value)} className={fieldClass(errors.account_holder_name)} maxLength={150} />
            </Field>
            <Field id="account_type" label="Account type" required className="sm:col-span-2">
              <Segmented label="Account type" value={form.account_type} onChange={value => update('account_type', value)} options={[['checking', 'Checking'], ['savings', 'Savings']]} />
            </Field>
            <Field id="routing_number" label="Routing number" required error={errors.routing_number} hint="9 digits, bottom-left of a check">
              <SensitiveInput id="routing_number" value={form.routing_number} onChange={value => update('routing_number', digitsOnly(value, 9))} placeholder="123456789" maxLength={9} error={errors.routing_number} mask={value => maskDigits(value)} />
            </Field>
            <Field id="account_number" label="Account number" required error={errors.account_number}>
              <SensitiveInput id="account_number" value={form.account_number} onChange={value => update('account_number', digitsOnly(value, 17))} placeholder="Account number" maxLength={17} error={errors.account_number} mask={value => maskDigits(value)} />
            </Field>
            <Field id="account_number_confirm" label="Confirm account number" required error={errors.account_number_confirm} className="sm:col-start-2">
              <SensitiveInput id="account_number_confirm" value={form.account_number_confirm} onChange={value => update('account_number_confirm', digitsOnly(value, 17))} placeholder="Re-enter account number" maxLength={17} error={errors.account_number_confirm} mask={value => maskDigits(value)} />
            </Field>
          </div>
          <div className="mt-5">
            <DropZone
              id="bank_files"
              kind="bank"
              title="Optional: add a voided check or bank letter"
              hint="Helps us confirm your account details"
              files={files.filter(file => file.kind === 'bank')}
              queue={queue.filter(item => item.kind === 'bank')}
              onFiles={addFiles}
              onRemove={removeFile}
              onDismiss={dismissQueued}
            />
          </div>
          <div className="mt-5">
            <CheckRow id="ach_authorized" checked={form.ach_authorized} onChange={value => update('ach_authorized', value)} error={errors.ach_authorized}>
              <strong>Direct deposit authorization.</strong> I authorize New Urban Development to make payments to {vendorName} by ACH direct deposit (automatic credits) into the bank account above. This authorization stays in effect until I notify New Urban Development in writing to change or cancel it, allowing reasonable time to act on it. I confirm that I am authorized to provide this bank account for {vendorName}.
            </CheckRow>
          </div>
        </SectionCard>

        {policy ? (
          <SectionCard id="section-policy" step={5} title={policy.title} done={done.policy} icon={<Clock3 className="h-5 w-5" />}>
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-gray-800">
              <p className="font-bold text-gray-950">{policy.greeting}</p>
              {policy.paragraphs.map(paragraph => <p key={paragraph} className="mt-2">{paragraph}</p>)}
            </div>
            <div className="mt-4">
              <CheckRow id="payment_policy_accepted" checked={form.payment_policy_accepted} onChange={value => update('payment_policy_accepted', value)} error={errors.payment_policy_accepted}>
                {policy.acceptance}
              </CheckRow>
            </div>
          </SectionCard>
        ) : null}

        <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
          <SecureNote compact />
          {submitError ? (
            <p role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">{submitError}</p>
          ) : null}
          <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className={`text-xs font-bold ${autosave === 'error' ? 'text-red-600' : autosave === 'saved' ? 'text-emerald-700' : 'text-gray-500'}`}>
              {autosave === 'saving' ? 'Saving your progress...' : autosave === 'saved' ? 'Progress saved securely' : autosave === 'error' ? 'Progress could not be saved. Keep this page open.' : 'Your progress saves automatically.'}
            </p>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[#0D1117] px-6 text-sm font-black text-white shadow-sm transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <LockKeyhole className="h-4 w-4" />}
              {submitting ? 'Submitting securely...' : (
                <>
                  <span className="sm:hidden">Submit securely</span>
                  <span className="hidden sm:inline">Submit to New Urban Development</span>
                </>
              )}
            </button>
          </div>
        </div>
      </form>
    );
  }

  const showSidebar = Boolean(lookup) && !loadError;
  return (
    <div id="vendor-setup-scroll" className="fixed inset-0 overflow-y-auto overscroll-contain bg-[#F3F5F7] text-gray-950" style={{ colorScheme: 'light' }}>
      {header}
      <div className={`mx-auto grid max-w-6xl gap-5 px-3 py-5 sm:px-6 sm:py-8 ${showSidebar ? 'lg:grid-cols-[minmax(0,1fr)_20rem]' : ''}`}>
        <main className="min-w-0">{body}</main>
        {showSidebar && company ? (
          <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            {showForm ? checklist : null}
            <ContactCard company={company} />
            {!needsCode && !showForm ? null : <p className="px-1 text-xs leading-5 text-gray-500">This link is unique to {lookup!.company_name} and expires on {dateLabel(lookup!.expires_at)}.</p>}
          </aside>
        ) : null}
      </div>
      <footer className="pb-8 text-center text-xs text-gray-500">&copy; {new Date().getFullYear()} New Urban Development</footer>
    </div>
  );
}
