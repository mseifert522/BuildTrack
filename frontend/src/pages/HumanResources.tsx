import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BadgeDollarSign,
  BriefcaseBusiness,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  Clock3,
  Download,
  FileText,
  HeartPulse,
  KeyRound,
  LoaderCircle,
  Mail,
  Phone,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Upload,
  UserRound,
  UsersRound,
  X,
} from 'lucide-react';
import toast from 'react-hot-toast';

import api from '../lib/api';
import { Loading, Modal, PageHeader } from '../components/ui';
import VoiceTextarea from '../components/VoiceTextarea';
import { useAuthStore } from '../store/authStore';

type TabId = 'overview' | 'resumes' | 'employees' | 'time' | 'pay' | 'compliance';
type ModalId =
  | 'candidate'
  | 'candidate_detail'
  | 'activity'
  | 'employee'
  | 'employee_detail'
  | 'time'
  | 'leave'
  | 'leave_balance'
  | 'benefit'
  | 'compliance'
  | 'resume_import'
  | 'ai_settings'
  | null;

type Overview = {
  stats: {
    active_employees: number;
    open_candidates: number;
    resumes: number;
    pending_compliance: number;
    pending_leave: number;
  };
  hours: {
    regular_hours: number;
    overtime_hours: number;
    pto_hours: number;
    sick_hours: number;
  };
  week_start: string;
  week_end: string;
  tasks: ComplianceTask[];
};

type Candidate = {
  id: string;
  first_name: string;
  last_name: string;
  email?: string | null;
  phone?: string | null;
  position?: string | null;
  source?: string | null;
  status: string;
  last_contacted_at?: string | null;
  next_follow_up_at?: string | null;
  notes?: string | null;
  activity_count?: number;
  resume_count?: number;
  latest_resume_id?: string | null;
  latest_resume_name?: string | null;
  ai_review_required?: number;
};

type CandidateActivity = {
  id: string;
  contact_type: string;
  direction: string;
  outcome?: string | null;
  notes?: string | null;
  contacted_at: string;
  created_by_name?: string | null;
};

type HrDocument = {
  id: string;
  document_type: string;
  original_name: string;
  mime_type: string;
  size: number;
  created_at: string;
  uploaded_by_name?: string | null;
};

type Employee = {
  id: string;
  source_candidate_id?: string | null;
  first_name: string;
  last_name: string;
  preferred_name?: string | null;
  personal_email?: string | null;
  work_email?: string | null;
  phone?: string | null;
  mailing_address?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  job_title?: string | null;
  department?: string | null;
  manager_name?: string | null;
  work_location?: string | null;
  employment_status: string;
  employment_type: string;
  classification: string;
  hire_date?: string | null;
  termination_date?: string | null;
  pay_type: string;
  pay_rate_cents: number;
  pay_frequency: string;
  standard_weekly_hours: number;
  benefit_eligible: number;
  benefit_eligibility_date?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_relationship?: string | null;
  emergency_contact_phone?: string | null;
  notes?: string | null;
  enrolled_benefit_count?: number;
  pending_task_count?: number;
};

type TimeEntry = {
  id: string;
  employee_id: string;
  first_name: string;
  last_name: string;
  job_title?: string | null;
  work_date: string;
  regular_hours: number;
  overtime_hours: number;
  pto_hours: number;
  sick_hours: number;
  unpaid_hours: number;
  notes?: string | null;
};

type LeaveRequest = {
  id: string;
  employee_id: string;
  first_name: string;
  last_name: string;
  leave_type: string;
  start_date: string;
  end_date: string;
  hours: number;
  status: string;
  notes?: string | null;
  reviewed_by_name?: string | null;
};

type LeaveBalance = {
  id: string;
  employee_id: string;
  leave_type: string;
  benefit_year: number;
  opening_hours: number;
  accrued_hours: number;
  used_hours: number;
  annual_use_limit_hours?: number | null;
};

type Benefit = {
  id: string;
  employee_id: string;
  first_name?: string;
  last_name?: string;
  benefit_type: string;
  plan_name: string;
  coverage_level?: string | null;
  status: string;
  effective_date?: string | null;
  end_date?: string | null;
  employee_monthly_cents: number;
  employer_monthly_cents: number;
  notes?: string | null;
};

type ComplianceTask = {
  id: string;
  employee_id: string;
  first_name: string;
  last_name: string;
  job_title?: string | null;
  category: string;
  task_name: string;
  due_date?: string | null;
  status: string;
  notes?: string | null;
  completed_at?: string | null;
  completed_by_name?: string | null;
};

type CandidateDetail = {
  candidate: Candidate;
  activities: CandidateActivity[];
  documents: HrDocument[];
};

type EmployeeDetail = {
  employee: Employee;
  benefits: Benefit[];
  leave_balances: LeaveBalance[];
  compliance_tasks: ComplianceTask[];
};

type AiSettings = {
  configured: boolean;
  source: 'managed' | 'environment' | null;
  last_four?: string | null;
  updated_at?: string | null;
  model: string;
};

type ResumeImportBatch = {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'partial' | 'failed';
  total_files: number;
  processed_files: number;
  imported_files: number;
  duplicate_files: number;
  failed_files: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  created_by_name?: string | null;
  created_at: string;
  completed_at?: string | null;
};

type ResumeImportItem = {
  id: string;
  status: 'queued' | 'processing' | 'imported' | 'duplicate' | 'failed';
  original_name: string;
  size: number;
  candidate_id?: string | null;
  matched_candidate_id?: string | null;
  document_id?: string | null;
  review_required: boolean;
  error_message?: string | null;
  extracted?: {
    first_name?: string;
    last_name?: string;
    email?: string;
    position?: string;
    needs_review?: boolean;
    source_packet?: {
      original_name?: string;
      page_count?: number;
      resume_count?: number;
      resume_number?: number;
      start_page?: number;
      end_page?: number;
    };
  } | null;
};

type ResumeImportDetail = {
  batch: ResumeImportBatch;
  items: ResumeImportItem[];
};

const TABS: Array<{ id: TabId; label: string; icon: typeof BriefcaseBusiness }> = [
  { id: 'overview', label: 'Dashboard', icon: BriefcaseBusiness },
  { id: 'resumes', label: 'Resumes', icon: FileText },
  { id: 'employees', label: 'Employees', icon: UsersRound },
  { id: 'time', label: 'Time & Leave', icon: Clock3 },
  { id: 'pay', label: 'Pay & Benefits', icon: BadgeDollarSign },
  { id: 'compliance', label: 'Compliance', icon: ShieldCheck },
];

const CANDIDATE_STATUSES = ['new', 'contacted', 'screening', 'interview', 'offer', 'hired', 'not_selected', 'on_hold'];
const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'seasonal', 'temporary', 'contractor'];
const LEAVE_TYPES = ['pto', 'sick', 'vacation', 'fmla', 'unpaid', 'bereavement', 'other'];
const BENEFIT_TYPES = ['health', 'dental', 'vision', 'life', 'disability', 'retirement', 'other'];

const fieldClass =
  'h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-amber-600 focus:ring-2 focus:ring-amber-100';
const textAreaClass =
  'min-h-24 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-amber-600 focus:ring-2 focus:ring-amber-100';
const primaryButton =
  'inline-flex h-10 items-center justify-center gap-2 rounded-md bg-slate-900 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButton =
  'inline-flex h-10 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
const iconButton =
  'inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 transition hover:bg-slate-50 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-40';

const emptyCandidateForm = {
  first_name: '',
  last_name: '',
  email: '',
  phone: '',
  position: '',
  source: '',
  status: 'new',
  next_follow_up_at: '',
  notes: '',
};

const emptyEmployeeForm = {
  source_candidate_id: '',
  first_name: '',
  last_name: '',
  preferred_name: '',
  personal_email: '',
  work_email: '',
  phone: '',
  mailing_address: '',
  city: '',
  state: 'MI',
  postal_code: '',
  job_title: '',
  department: '',
  manager_name: '',
  work_location: '',
  employment_status: 'active',
  employment_type: 'full_time',
  classification: 'non_exempt',
  hire_date: '',
  termination_date: '',
  pay_type: 'hourly',
  pay_rate: '',
  pay_frequency: 'biweekly',
  standard_weekly_hours: '40',
  benefit_eligible: false,
  benefit_eligibility_date: '',
  emergency_contact_name: '',
  emergency_contact_relationship: '',
  emergency_contact_phone: '',
  notes: '',
};

function label(value?: string | null) {
  return String(value || 'Not set')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase());
}

function formatDate(value?: string | null) {
  if (!value) return 'Not set';
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(value?: string | null) {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatBytes(bytes = 0) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCurrency(cents = 0, maximumFractionDigits = 2) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits,
  }).format(cents / 100);
}

function formatPay(employee: Employee) {
  if (!employee.pay_rate_cents) return 'Not set';
  return employee.pay_type === 'salary'
    ? `${formatCurrency(employee.pay_rate_cents, 0)} / year`
    : `${formatCurrency(employee.pay_rate_cents)} / hour`;
}

function statusClasses(status: string) {
  if (['active', 'complete', 'completed', 'approved', 'enrolled', 'hired', 'imported'].includes(status)) return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
  if (['offer', 'interview', 'screening', 'contacted', 'requested', 'pending', 'processing', 'queued', 'partial'].includes(status)) return 'bg-amber-50 text-amber-800 ring-amber-200';
  if (['terminated', 'denied', 'not_selected', 'ended', 'failed'].includes(status)) return 'bg-rose-50 text-rose-700 ring-rose-200';
  return 'bg-slate-100 text-slate-700 ring-slate-200';
}

function StatusPill({ value }: { value: string }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${statusClasses(value)}`}>
      {label(value)}
    </span>
  );
}

function Field({
  labelText,
  children,
  className = '',
}: {
  labelText: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-xs font-semibold uppercase text-slate-600">{labelText}</span>
      {children}
    </label>
  );
}

function FormActions({ saving, onCancel, submitLabel = 'Save' }: { saving: boolean; onCancel: () => void; submitLabel?: string }) {
  return (
    <div className="mt-6 flex justify-end gap-2 border-t border-slate-200 pt-4">
      <button type="button" className={secondaryButton} onClick={onCancel}>Cancel</button>
      <button type="submit" className={primaryButton} disabled={saving}>
        {saving ? 'Saving...' : submitLabel}
      </button>
    </div>
  );
}

function SectionHeading({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-3">
      <h2 className="text-sm font-bold uppercase text-slate-700">{title}</h2>
      {action}
    </div>
  );
}

function apiError(error: unknown) {
  const candidate = error as { response?: { data?: { error?: string } }; message?: string };
  return candidate.response?.data?.error || candidate.message || 'Request failed';
}

export default function HumanResources() {
  const user = useAuthStore(state => state.user);
  const isSuperAdmin = user?.role === 'super_admin';
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [modal, setModal] = useState<ModalId>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequest[]>([]);
  const [benefits, setBenefits] = useState<Benefit[]>([]);
  const [complianceTasks, setComplianceTasks] = useState<ComplianceTask[]>([]);
  const [candidateDetail, setCandidateDetail] = useState<CandidateDetail | null>(null);
  const [employeeDetail, setEmployeeDetail] = useState<EmployeeDetail | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState<Candidate | null>(null);
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const [candidateSearch, setCandidateSearch] = useState('');
  const [candidateStatus, setCandidateStatus] = useState('');
  const [resumeImports, setResumeImports] = useState<ResumeImportBatch[]>([]);
  const [activeResumeImport, setActiveResumeImport] = useState<ResumeImportDetail | null>(null);
  const [selectedResumeFiles, setSelectedResumeFiles] = useState<File[]>([]);
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [anthropicKey, setAnthropicKey] = useState('');
  const [timeFrom, setTimeFrom] = useState(() => {
    const today = new Date();
    const day = today.getDay();
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((day + 6) % 7));
    return monday.toISOString().slice(0, 10);
  });
  const [timeTo, setTimeTo] = useState(() => {
    const result = new Date();
    const day = result.getDay();
    result.setDate(result.getDate() - ((day + 6) % 7) + 6);
    return result.toISOString().slice(0, 10);
  });
  const [timeEmployeeFilter, setTimeEmployeeFilter] = useState('');

  const [candidateForm, setCandidateForm] = useState(emptyCandidateForm);
  const [activityForm, setActivityForm] = useState({
    contact_type: 'call',
    direction: 'outbound',
    outcome: '',
    notes: '',
    contacted_at: new Date().toISOString().slice(0, 16),
  });
  const [employeeForm, setEmployeeForm] = useState(emptyEmployeeForm);
  const [timeForm, setTimeForm] = useState({
    employee_id: '',
    work_date: new Date().toISOString().slice(0, 10),
    regular_hours: '',
    overtime_hours: '',
    pto_hours: '',
    sick_hours: '',
    unpaid_hours: '',
    notes: '',
  });
  const [leaveForm, setLeaveForm] = useState({
    employee_id: '',
    leave_type: 'pto',
    start_date: '',
    end_date: '',
    hours: '',
    status: 'requested',
    notes: '',
  });
  const [leaveBalanceForm, setLeaveBalanceForm] = useState({
    employee_id: '',
    leave_type: 'sick',
    benefit_year: String(new Date().getFullYear()),
    opening_hours: '',
    accrued_hours: '',
    used_hours: '',
    annual_use_limit_hours: '',
  });
  const [benefitForm, setBenefitForm] = useState({
    employee_id: '',
    benefit_type: 'health',
    plan_name: '',
    coverage_level: '',
    status: 'offered',
    effective_date: '',
    end_date: '',
    employee_monthly: '',
    employer_monthly: '',
    notes: '',
  });
  const [complianceForm, setComplianceForm] = useState({
    employee_id: '',
    category: 'other',
    task_name: '',
    due_date: '',
    status: 'pending',
    notes: '',
  });
  const resumeInputRef = useRef<HTMLInputElement>(null);
  const resumeBatchInputRef = useRef<HTMLInputElement>(null);
  const activeResumeDocuments = useMemo(() => {
    const items = activeResumeImport?.items || [];
    return [...items].sort((left, right) => {
      const leftPacket = left.extracted?.source_packet;
      const rightPacket = right.extracted?.source_packet;
      const packetOrder = String(leftPacket?.original_name || left.original_name)
        .localeCompare(String(rightPacket?.original_name || right.original_name));
      if (packetOrder) return packetOrder;
      return Number(leftPacket?.resume_number || 1) - Number(rightPacket?.resume_number || 1);
    });
  }, [activeResumeImport?.items]);

  const loadOverview = useCallback(async () => {
    const response = await api.get('/human-resources/overview');
    setOverview(response.data);
  }, []);

  const loadCandidates = useCallback(async () => {
    const response = await api.get('/human-resources/candidates', {
      params: { search: candidateSearch || undefined, status: candidateStatus || undefined },
    });
    setCandidates(response.data.candidates);
  }, [candidateSearch, candidateStatus]);

  const loadResumeImport = useCallback(async (batchId: string) => {
    const response = await api.get(`/human-resources/resume-imports/${batchId}`);
    setActiveResumeImport(response.data);
    return response.data as ResumeImportDetail;
  }, []);

  const loadResumeImports = useCallback(async () => {
    const response = await api.get('/human-resources/resume-imports', { params: { limit: 5 } });
    const batches = response.data.batches as ResumeImportBatch[];
    setResumeImports(batches);
    if (batches[0]) await loadResumeImport(batches[0].id);
    else setActiveResumeImport(null);
  }, [loadResumeImport]);

  const loadAiSettings = useCallback(async () => {
    if (!isSuperAdmin) return;
    const response = await api.get('/human-resources/ai-settings/anthropic');
    setAiSettings(response.data.settings);
  }, [isSuperAdmin]);

  const loadEmployees = useCallback(async () => {
    const response = await api.get('/human-resources/employees');
    setEmployees(response.data.employees);
  }, []);

  const loadTimeAndLeave = useCallback(async () => {
    const [timeResponse, leaveResponse] = await Promise.all([
      api.get('/human-resources/time-entries', {
        params: { from: timeFrom, to: timeTo, employee_id: timeEmployeeFilter || undefined },
      }),
      api.get('/human-resources/leave-requests'),
    ]);
    setTimeEntries(timeResponse.data.entries);
    setLeaveRequests(leaveResponse.data.requests);
  }, [timeEmployeeFilter, timeFrom, timeTo]);

  const loadBenefits = useCallback(async () => {
    const response = await api.get('/human-resources/benefits');
    setBenefits(response.data.benefits);
  }, []);

  const loadCompliance = useCallback(async () => {
    const response = await api.get('/human-resources/compliance');
    setComplianceTasks(response.data.tasks);
  }, []);

  const loadTab = useCallback(async (tab: TabId) => {
    if (tab === 'overview') await loadOverview();
    if (tab === 'resumes') {
      await Promise.all([
        loadCandidates(),
        loadResumeImports(),
        isSuperAdmin ? loadAiSettings() : Promise.resolve(),
      ]);
    }
    if (tab === 'employees') await loadEmployees();
    if (tab === 'time') await loadTimeAndLeave();
    if (tab === 'pay') await Promise.all([loadEmployees(), loadBenefits()]);
    if (tab === 'compliance') await Promise.all([loadEmployees(), loadCompliance()]);
  }, [isSuperAdmin, loadAiSettings, loadBenefits, loadCandidates, loadCompliance, loadEmployees, loadOverview, loadResumeImports, loadTimeAndLeave]);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    Promise.all([loadEmployees(), loadTab(activeTab)])
      .catch(error => mounted && toast.error(apiError(error)))
      .finally(() => mounted && setLoading(false));
    return () => { mounted = false; };
  }, [activeTab, loadEmployees, loadTab]);

  useEffect(() => {
    const batch = activeResumeImport?.batch;
    if (!batch || !['queued', 'processing'].includes(batch.status)) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const detail = await loadResumeImport(batch.id);
        setResumeImports(current => current.map(item => item.id === detail.batch.id ? detail.batch : item));
        if (!['queued', 'processing'].includes(detail.batch.status)) {
          await Promise.all([loadCandidates(), loadOverview()]);
        }
      } catch (_error) {
        window.clearInterval(timer);
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [activeResumeImport?.batch.id, activeResumeImport?.batch.status, loadCandidates, loadOverview, loadResumeImport]);

  const openCandidate = async (candidate: Candidate) => {
    try {
      setSelectedCandidate(candidate);
      const response = await api.get(`/human-resources/candidates/${candidate.id}`);
      setCandidateDetail(response.data);
      setModal('candidate_detail');
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  const refreshCandidateDetail = async (candidateId: string) => {
    const response = await api.get(`/human-resources/candidates/${candidateId}`);
    setCandidateDetail(response.data);
    setSelectedCandidate(response.data.candidate);
  };

  const openEmployee = async (employee: Employee) => {
    try {
      setSelectedEmployee(employee);
      const response = await api.get(`/human-resources/employees/${employee.id}`);
      setEmployeeDetail(response.data);
      setModal('employee_detail');
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  const refreshEmployeeDetail = async (employeeId: string) => {
    const response = await api.get(`/human-resources/employees/${employeeId}`);
    setEmployeeDetail(response.data);
    setSelectedEmployee(response.data.employee);
  };

  const openAddCandidate = () => {
    setSelectedCandidate(null);
    setCandidateForm(emptyCandidateForm);
    setModal('candidate');
  };

  const openEditCandidate = (candidate: Candidate) => {
    setSelectedCandidate(candidate);
    setCandidateForm({
      first_name: candidate.first_name,
      last_name: candidate.last_name,
      email: candidate.email || '',
      phone: candidate.phone || '',
      position: candidate.position || '',
      source: candidate.source || '',
      status: candidate.status,
      next_follow_up_at: candidate.next_follow_up_at?.slice(0, 16) || '',
      notes: candidate.notes || '',
    });
    setModal('candidate');
  };

  const saveCandidate = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      if (selectedCandidate) {
        await api.patch(`/human-resources/candidates/${selectedCandidate.id}`, candidateForm);
        toast.success('Applicant updated');
      } else {
        await api.post('/human-resources/candidates', candidateForm);
        toast.success('Applicant added');
      }
      setModal(null);
      await Promise.all([loadCandidates(), loadOverview()]);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  const openActivity = (contactType: string) => {
    setActivityForm({
      contact_type: contactType,
      direction: contactType === 'note' ? 'internal' : 'outbound',
      outcome: '',
      notes: '',
      contacted_at: new Date().toISOString().slice(0, 16),
    });
    setModal('activity');
  };

  const saveActivity = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedCandidate) return;
    setSaving(true);
    try {
      await api.post(`/human-resources/candidates/${selectedCandidate.id}/activities`, activityForm);
      toast.success(`${label(activityForm.contact_type)} logged`);
      await Promise.all([refreshCandidateDetail(selectedCandidate.id), loadCandidates(), loadOverview()]);
      setModal('candidate_detail');
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  const uploadResume = async (file?: File) => {
    if (!file || !selectedCandidate) return;
    const formData = new FormData();
    formData.append('resume', file);
    setSaving(true);
    try {
      await api.post(`/human-resources/candidates/${selectedCandidate.id}/resume`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success('Resume uploaded');
      await Promise.all([refreshCandidateDetail(selectedCandidate.id), loadCandidates(), loadOverview()]);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
      if (resumeInputRef.current) resumeInputRef.current.value = '';
    }
  };

  const openResumeIntake = () => {
    setSelectedResumeFiles([]);
    if (resumeBatchInputRef.current) resumeBatchInputRef.current.value = '';
    setModal('resume_import');
  };

  const selectResumeBatchFiles = (files?: FileList | null) => {
    const selected = Array.from(files || []);
    if (selected.length > 20) {
      toast.error('Select no more than 20 PDFs at a time');
      return;
    }
    const invalid = selected.find(file => file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf'));
    if (invalid) {
      toast.error('Resume upload accepts PDF files only');
      return;
    }
    setSelectedResumeFiles(selected);
  };

  const startResumeIntake = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedResumeFiles.length) return;
    const formData = new FormData();
    selectedResumeFiles.forEach(file => formData.append('resumes', file));
    setSaving(true);
    try {
      const response = await api.post('/human-resources/resume-imports', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const detail = response.data as ResumeImportDetail;
      setActiveResumeImport(detail);
      setResumeImports(current => [detail.batch, ...current.filter(batch => batch.id !== detail.batch.id)].slice(0, 5));
      setModal(null);
      setSelectedResumeFiles([]);
      toast.success(`${detail.batch.total_files} resume${detail.batch.total_files === 1 ? '' : 's'} queued for Claude`);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
      if (resumeBatchInputRef.current) resumeBatchInputRef.current.value = '';
    }
  };

  const saveAnthropicSettings = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!anthropicKey.trim()) return;
    setSaving(true);
    try {
      const response = await api.put('/human-resources/ai-settings/anthropic', { api_key: anthropicKey.trim() });
      setAiSettings(response.data.settings);
      setAnthropicKey('');
      toast.success('Claude key validated and encrypted');
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  const removeManagedAnthropicKey = async () => {
    if (!window.confirm('Remove the managed Claude key and return to the server environment configuration?')) return;
    setSaving(true);
    try {
      const response = await api.delete('/human-resources/ai-settings/anthropic');
      setAiSettings(response.data.settings);
      setAnthropicKey('');
      toast.success('Managed Claude key removed');
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  const retryResumeImport = async () => {
    if (!activeResumeImport) return;
    setSaving(true);
    try {
      const response = await api.post(`/human-resources/resume-imports/${activeResumeImport.batch.id}/retry`);
      setActiveResumeImport(response.data);
      toast.success('Failed resumes queued again');
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  const markAiReviewed = async (candidateId: string) => {
    try {
      await api.patch(`/human-resources/candidates/${candidateId}/ai-review`, { reviewed: true });
      await Promise.all([refreshCandidateDetail(candidateId), loadCandidates()]);
      toast.success('Resume marked reviewed');
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  const downloadDocument = async (document: HrDocument | { id: string; original_name?: string | null }) => {
    try {
      const response = await api.get(`/human-resources/documents/${document.id}/download`, { responseType: 'blob' });
      const url = URL.createObjectURL(response.data);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = document.original_name || 'document';
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  const openAddEmployee = (candidate?: Candidate) => {
    setSelectedEmployee(null);
    setEmployeeForm({
      ...emptyEmployeeForm,
      source_candidate_id: candidate?.id || '',
      first_name: candidate?.first_name || '',
      last_name: candidate?.last_name || '',
      personal_email: candidate?.email || '',
      phone: candidate?.phone || '',
      job_title: candidate?.position || '',
    });
    setModal('employee');
  };

  const openEditEmployee = (employee: Employee) => {
    setSelectedEmployee(employee);
    setEmployeeForm({
      source_candidate_id: employee.source_candidate_id || '',
      first_name: employee.first_name,
      last_name: employee.last_name,
      preferred_name: employee.preferred_name || '',
      personal_email: employee.personal_email || '',
      work_email: employee.work_email || '',
      phone: employee.phone || '',
      mailing_address: employee.mailing_address || '',
      city: employee.city || '',
      state: employee.state || 'MI',
      postal_code: employee.postal_code || '',
      job_title: employee.job_title || '',
      department: employee.department || '',
      manager_name: employee.manager_name || '',
      work_location: employee.work_location || '',
      employment_status: employee.employment_status,
      employment_type: employee.employment_type,
      classification: employee.classification,
      hire_date: employee.hire_date || '',
      termination_date: employee.termination_date || '',
      pay_type: employee.pay_type,
      pay_rate: employee.pay_rate_cents ? String(employee.pay_rate_cents / 100) : '',
      pay_frequency: employee.pay_frequency,
      standard_weekly_hours: String(employee.standard_weekly_hours ?? 40),
      benefit_eligible: Boolean(employee.benefit_eligible),
      benefit_eligibility_date: employee.benefit_eligibility_date || '',
      emergency_contact_name: employee.emergency_contact_name || '',
      emergency_contact_relationship: employee.emergency_contact_relationship || '',
      emergency_contact_phone: employee.emergency_contact_phone || '',
      notes: employee.notes || '',
    });
    setModal('employee');
  };

  const saveEmployee = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    const payload = {
      ...employeeForm,
      pay_rate_cents: Math.round(Number(employeeForm.pay_rate || 0) * 100),
      standard_weekly_hours: Number(employeeForm.standard_weekly_hours || 0),
    };
    try {
      if (selectedEmployee) {
        await api.patch(`/human-resources/employees/${selectedEmployee.id}`, payload);
        toast.success('Employee updated');
      } else {
        await api.post('/human-resources/employees', payload);
        toast.success('Employee added with onboarding checklist');
      }
      setModal(null);
      await Promise.all([loadEmployees(), loadCandidates(), loadOverview()]);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  const openTimeEntry = (entry?: TimeEntry) => {
    setTimeForm({
      employee_id: entry?.employee_id || employees[0]?.id || '',
      work_date: entry?.work_date || new Date().toISOString().slice(0, 10),
      regular_hours: entry ? String(entry.regular_hours) : '',
      overtime_hours: entry ? String(entry.overtime_hours) : '',
      pto_hours: entry ? String(entry.pto_hours) : '',
      sick_hours: entry ? String(entry.sick_hours) : '',
      unpaid_hours: entry ? String(entry.unpaid_hours) : '',
      notes: entry?.notes || '',
    });
    setModal('time');
  };

  const saveTimeEntry = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api.post('/human-resources/time-entries', timeForm);
      toast.success('Hours saved');
      setModal(null);
      await Promise.all([loadTimeAndLeave(), loadOverview()]);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  const openLeaveRequest = () => {
    setLeaveForm({
      employee_id: employees[0]?.id || '',
      leave_type: 'pto',
      start_date: '',
      end_date: '',
      hours: '',
      status: 'requested',
      notes: '',
    });
    setModal('leave');
  };

  const saveLeaveRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api.post('/human-resources/leave-requests', leaveForm);
      toast.success('Leave request saved');
      setModal(null);
      await Promise.all([loadTimeAndLeave(), loadOverview()]);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  const reviewLeave = async (requestId: string, status: 'approved' | 'denied') => {
    try {
      await api.patch(`/human-resources/leave-requests/${requestId}`, { status });
      toast.success(`Leave ${status}`);
      await Promise.all([loadTimeAndLeave(), loadOverview()]);
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  const openLeaveBalance = (employee?: Employee) => {
    setLeaveBalanceForm({
      employee_id: employee?.id || employees[0]?.id || '',
      leave_type: 'sick',
      benefit_year: String(new Date().getFullYear()),
      opening_hours: '',
      accrued_hours: '',
      used_hours: '',
      annual_use_limit_hours: '',
    });
    setModal('leave_balance');
  };

  const saveLeaveBalance = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const { employee_id, leave_type, ...payload } = leaveBalanceForm;
      await api.put(`/human-resources/employees/${employee_id}/leave-balances/${leave_type}`, payload);
      toast.success('Leave balance saved');
      if (employeeDetail?.employee.id === employee_id) await refreshEmployeeDetail(employee_id);
      setModal(employeeDetail ? 'employee_detail' : null);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  const openBenefit = (employee?: Employee) => {
    setBenefitForm({
      employee_id: employee?.id || employees[0]?.id || '',
      benefit_type: 'health',
      plan_name: '',
      coverage_level: '',
      status: 'offered',
      effective_date: '',
      end_date: '',
      employee_monthly: '',
      employer_monthly: '',
      notes: '',
    });
    setModal('benefit');
  };

  const saveBenefit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api.post('/human-resources/benefits', {
        ...benefitForm,
        employee_monthly_cents: Math.round(Number(benefitForm.employee_monthly || 0) * 100),
        employer_monthly_cents: Math.round(Number(benefitForm.employer_monthly || 0) * 100),
      });
      toast.success('Benefit record added');
      if (employeeDetail?.employee.id === benefitForm.employee_id) await refreshEmployeeDetail(benefitForm.employee_id);
      await loadBenefits();
      setModal(employeeDetail ? 'employee_detail' : null);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  const openComplianceTask = (employee?: Employee) => {
    setComplianceForm({
      employee_id: employee?.id || employees[0]?.id || '',
      category: 'other',
      task_name: '',
      due_date: '',
      status: 'pending',
      notes: '',
    });
    setModal('compliance');
  };

  const saveComplianceTask = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api.post('/human-resources/compliance', complianceForm);
      toast.success('Compliance task added');
      await Promise.all([loadCompliance(), loadOverview()]);
      setModal(null);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  const updateCompliance = async (taskId: string, status: 'complete' | 'pending' | 'not_applicable') => {
    try {
      await api.patch(`/human-resources/compliance/${taskId}`, { status });
      toast.success(status === 'complete' ? 'Task completed' : 'Task updated');
      await Promise.all([loadCompliance(), loadOverview()]);
      if (employeeDetail) await refreshEmployeeDetail(employeeDetail.employee.id);
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  const timeTotals = useMemo(() => timeEntries.reduce(
    (totals, entry) => ({
      regular: totals.regular + entry.regular_hours,
      overtime: totals.overtime + entry.overtime_hours,
      paidLeave: totals.paidLeave + entry.pto_hours + entry.sick_hours,
    }),
    { regular: 0, overtime: 0, paidLeave: 0 },
  ), [timeEntries]);

  const tabAction = () => {
    if (activeTab === 'resumes') {
      return (
        <div className="flex flex-wrap gap-2">
          {isSuperAdmin && (
            <button
              className={iconButton}
              onClick={() => {
                setAnthropicKey('');
                setModal('ai_settings');
              }}
              title="Configure resume scanner"
            >
              <KeyRound className="h-4 w-4" />
            </button>
          )}
          <button className={secondaryButton} onClick={openResumeIntake} title="Upload Resumes">
            <Upload className="h-4 w-4" /><span className="hidden sm:inline">Upload Resumes</span>
          </button>
          <button className={primaryButton} onClick={openAddCandidate} title="Add applicant">
            <Plus className="h-4 w-4" /><span className="hidden sm:inline">Add applicant</span>
          </button>
        </div>
      );
    }
    if (activeTab === 'employees') return <button className={primaryButton} onClick={() => openAddEmployee()}><Plus className="h-4 w-4" />Add employee</button>;
    if (activeTab === 'time') {
      return (
        <div className="flex gap-2">
          <button className={secondaryButton} onClick={openLeaveRequest}><CalendarClock className="h-4 w-4" />Leave</button>
          <button className={primaryButton} onClick={() => openTimeEntry()}><Plus className="h-4 w-4" />Hours</button>
        </div>
      );
    }
    if (activeTab === 'pay') return <button className={primaryButton} onClick={() => openBenefit()}><Plus className="h-4 w-4" />Add benefit</button>;
    if (activeTab === 'compliance') return <button className={primaryButton} onClick={() => openComplianceTask()}><Plus className="h-4 w-4" />Add task</button>;
    return null;
  };

  return (
    <div className="bt-desktop-page mx-auto max-w-[1500px] space-y-5 p-4 md:p-6">
      <PageHeader
        title="Human Resources"
        subtitle="People operations"
        actions={tabAction()}
      />

      <div className="overflow-x-auto border-b border-slate-300">
        <nav className="flex min-w-max gap-1" aria-label="Human Resources sections">
          {TABS.map(tab => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex h-11 items-center gap-2 border-b-2 px-3 text-sm font-semibold transition ${
                  active
                    ? 'border-amber-700 text-slate-950'
                    : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800'
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {loading ? <Loading message="Loading Human Resources..." /> : (
        <>
          {activeTab === 'overview' && overview && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                {[
                  { title: 'Active employees', value: overview.stats.active_employees, Icon: UsersRound },
                  { title: 'Open applicants', value: overview.stats.open_candidates, Icon: UserRound },
                  { title: 'Resumes', value: overview.stats.resumes, Icon: FileText },
                  { title: 'Pending compliance', value: overview.stats.pending_compliance, Icon: ClipboardCheck },
                  { title: 'Pending leave', value: overview.stats.pending_leave, Icon: CalendarClock },
                ].map(({ title, value, Icon }) => (
                  <div key={title} className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-semibold uppercase text-slate-500">{title}</span>
                      <Icon className="h-4 w-4 text-amber-700" />
                    </div>
                    <p className="mt-3 text-2xl font-bold text-slate-950">{value}</p>
                  </div>
                ))}
              </div>

              <section className="space-y-4">
                <SectionHeading title={`Hours · ${formatDate(overview.week_start)} to ${formatDate(overview.week_end)}`} />
                <div className="grid grid-cols-2 gap-x-8 gap-y-4 border-b border-slate-200 pb-5 md:grid-cols-4">
                  {[
                    ['Regular', overview.hours.regular_hours],
                    ['Overtime', overview.hours.overtime_hours],
                    ['PTO', overview.hours.pto_hours],
                    ['Sick', overview.hours.sick_hours],
                  ].map(([title, value]) => (
                    <div key={String(title)}>
                      <p className="text-xs font-semibold uppercase text-slate-500">{String(title)}</p>
                      <p className="mt-1 text-xl font-bold text-slate-900">{Number(value).toFixed(1)}</p>
                    </div>
                  ))}
                </div>
              </section>

              <section className="space-y-3">
                <SectionHeading title="Compliance due" />
                {overview.tasks.length === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-500">No pending compliance tasks.</p>
                ) : (
                  <div className="divide-y divide-slate-200 border-y border-slate-200">
                    {overview.tasks.map(task => (
                      <div key={task.id} className="flex items-center gap-3 py-3">
                        <button
                          type="button"
                          className={iconButton}
                          title="Mark complete"
                          onClick={() => updateCompliance(task.id, 'complete')}
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-slate-900">{task.task_name}</p>
                          <p className="text-xs text-slate-500">{task.first_name} {task.last_name} · {label(task.category)}</p>
                        </div>
                        <span className={`text-xs font-semibold ${task.due_date && task.due_date < new Date().toISOString().slice(0, 10) ? 'text-rose-700' : 'text-slate-500'}`}>
                          {formatDate(task.due_date)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {activeTab === 'resumes' && (
            <div className="space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row">
                <label className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
                  <input
                    className={`${fieldClass} pl-9`}
                    placeholder="Search applicants"
                    value={candidateSearch}
                    onChange={event => setCandidateSearch(event.target.value)}
                    onKeyDown={event => event.key === 'Enter' && loadCandidates()}
                  />
                </label>
                <select className={`${fieldClass} sm:w-52`} value={candidateStatus} onChange={event => setCandidateStatus(event.target.value)}>
                  <option value="">All statuses</option>
                  {CANDIDATE_STATUSES.map(status => <option key={status} value={status}>{label(status)}</option>)}
                </select>
                <button className={secondaryButton} onClick={() => loadCandidates()}>Apply</button>
              </div>

              <div className="overflow-x-auto border-y border-slate-200">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Applicant</th>
                      <th className="px-4 py-3">Position</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Last contact</th>
                      <th className="px-4 py-3">Follow-up</th>
                      <th className="px-4 py-3">Resume</th>
                      <th className="w-12 px-4 py-3"><span className="sr-only">Open</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white">
                    {candidates.map(candidate => (
                      <tr
                        key={candidate.id}
                        className="bt-hr-candidate-row cursor-pointer outline-none"
                        tabIndex={0}
                        aria-label={`Open applicant ${candidate.first_name} ${candidate.last_name}`}
                        onClick={() => openCandidate(candidate)}
                        onKeyDown={event => {
                          if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
                          event.preventDefault();
                          openCandidate(candidate);
                        }}
                      >
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-semibold text-slate-950">{candidate.first_name} {candidate.last_name}</p>
                            {Boolean(candidate.ai_review_required) && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-200">
                                <CircleAlert className="h-3 w-3" />Review required
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-500">{candidate.email || candidate.phone || 'No contact information'}</p>
                        </td>
                        <td className="px-4 py-3 text-slate-700">{candidate.position || 'Not set'}</td>
                        <td className="px-4 py-3"><StatusPill value={candidate.status} /></td>
                        <td className="px-4 py-3 text-slate-600">{formatDateTime(candidate.last_contacted_at)}</td>
                        <td className="px-4 py-3 text-slate-600">{formatDate(candidate.next_follow_up_at)}</td>
                        <td className="px-4 py-3">
                          {candidate.latest_resume_id ? (
                            <button
                              className="inline-flex items-center gap-1.5 text-sm font-semibold text-amber-800 hover:text-amber-950"
                              onClick={event => {
                                event.stopPropagation();
                                downloadDocument({ id: candidate.latest_resume_id!, original_name: candidate.latest_resume_name });
                              }}
                            >
                              <FileText className="h-4 w-4" />
                              {candidate.latest_resume_name || 'Resume'}
                            </button>
                          ) : <span className="text-slate-400">Missing</span>}
                        </td>
                        <td className="px-4 py-3"><ChevronRight className="h-4 w-4 text-slate-400" /></td>
                      </tr>
                    ))}
                    {candidates.length === 0 && (
                      <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-500">No applicants found.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {activeResumeImport && (
                <section className="space-y-3 pt-2">
                  <SectionHeading
                    title="Applicant documents"
                    action={
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-slate-500">{activeResumeDocuments.length} resumes</span>
                        {resumeImports.length > 1 && (
                          <select
                            className="h-9 rounded-md border border-slate-300 bg-white px-2 text-xs font-semibold text-slate-700"
                            value={activeResumeImport.batch.id}
                            aria-label="Select resume upload"
                            onChange={event => loadResumeImport(event.target.value).catch(error => toast.error(apiError(error)))}
                          >
                            {resumeImports.map(batch => (
                              <option key={batch.id} value={batch.id}>
                                {formatDateTime(batch.created_at)}
                              </option>
                            ))}
                          </select>
                        )}
                        {activeResumeImport.batch.failed_files > 0 && (
                          <button
                            className={secondaryButton}
                            onClick={retryResumeImport}
                            disabled={saving || activeResumeImport.batch.status === 'processing'}
                          >
                            <RefreshCw className="h-4 w-4" />Retry failed
                          </button>
                        )}
                      </div>
                    }
                  />
                  <div className="overflow-x-auto border-y border-slate-200">
                    <table className="w-full min-w-[760px] text-left text-sm">
                      <thead className="bg-slate-50 text-xs uppercase text-slate-600">
                        <tr>
                          <th className="px-4 py-3">Applicant</th>
                          <th className="px-4 py-3">Resume file</th>
                          <th className="px-4 py-3">Packet pages</th>
                          <th className="px-4 py-3">Status</th>
                          <th className="w-12 px-4 py-3"><span className="sr-only">Download</span></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 bg-white">
                        {activeResumeDocuments.map(item => {
                          const packet = item.extracted?.source_packet;
                          const applicantName = `${item.extracted?.first_name || ''} ${item.extracted?.last_name || ''}`.trim();
                          return (
                            <tr key={item.id}>
                              <td className="px-4 py-3">
                                <p className="font-semibold text-slate-950">{applicantName || 'Pending identification'}</p>
                                <p className="text-xs text-slate-500">{item.extracted?.position || formatBytes(item.size)}</p>
                              </td>
                              <td className="px-4 py-3">
                                <p className="max-w-sm truncate font-semibold text-slate-800">{item.original_name}</p>
                                {packet?.resume_count && packet.resume_count > 1 && (
                                  <p className="text-xs text-slate-500">
                                    Resume {packet.resume_number} of {packet.resume_count} from {packet.original_name || 'uploaded packet'}
                                  </p>
                                )}
                              </td>
                              <td className="px-4 py-3 text-slate-600">
                                {packet?.start_page && packet?.end_page
                                  ? `${packet.start_page}-${packet.end_page}`
                                  : 'Single resume'}
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2">
                                  {item.status === 'processing' || item.status === 'queued' ? (
                                    <LoaderCircle className="h-4 w-4 animate-spin text-amber-700" />
                                  ) : item.status === 'failed' ? (
                                    <CircleAlert className="h-4 w-4 text-rose-700" />
                                  ) : (
                                    <CheckCircle2 className="h-4 w-4 text-emerald-700" />
                                  )}
                                  <StatusPill value={item.status} />
                                </div>
                                {item.error_message && <p className="mt-1 max-w-sm text-xs text-rose-700">{item.error_message}</p>}
                              </td>
                              <td className="px-4 py-3">
                                {item.document_id && (
                                  <button
                                    className={iconButton}
                                    title={`Download ${item.original_name}`}
                                    onClick={() => downloadDocument({ id: item.document_id!, original_name: item.original_name })}
                                  >
                                    <Download className="h-4 w-4" />
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                        {activeResumeDocuments.length === 0 && (
                          <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-500">No resume documents in this intake.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </div>
          )}

          {activeTab === 'employees' && (
            <div className="overflow-x-auto border-y border-slate-200">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Employee</th>
                    <th className="px-4 py-3">Role</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Classification</th>
                    <th className="px-4 py-3">Start date</th>
                    <th className="px-4 py-3">Pay</th>
                    <th className="px-4 py-3">Open tasks</th>
                    <th className="w-12 px-4 py-3"><span className="sr-only">Open</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {employees.map(employee => (
                    <tr key={employee.id} className="cursor-pointer hover:bg-slate-50" onClick={() => openEmployee(employee)}>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-slate-950">{employee.first_name} {employee.last_name}</p>
                        <p className="text-xs text-slate-500">{employee.work_email || employee.personal_email || employee.phone || 'No contact information'}</p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-slate-800">{employee.job_title || 'Not set'}</p>
                        <p className="text-xs text-slate-500">{employee.department || 'No department'}</p>
                      </td>
                      <td className="px-4 py-3"><StatusPill value={employee.employment_status} /></td>
                      <td className="px-4 py-3 text-slate-600">{label(employee.classification)}</td>
                      <td className="px-4 py-3 text-slate-600">{formatDate(employee.hire_date)}</td>
                      <td className="px-4 py-3 text-slate-800">{formatPay(employee)}</td>
                      <td className="px-4 py-3 text-slate-600">{employee.pending_task_count || 0}</td>
                      <td className="px-4 py-3"><ChevronRight className="h-4 w-4 text-slate-400" /></td>
                    </tr>
                  ))}
                  {employees.length === 0 && (
                    <tr><td colSpan={8} className="px-4 py-12 text-center text-slate-500">No employees added.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'time' && (
            <div className="space-y-7">
              <section className="space-y-4">
                <SectionHeading title="Hours" />
                <div className="grid gap-3 sm:grid-cols-4">
                  <Field labelText="From"><input type="date" className={fieldClass} value={timeFrom} onChange={event => setTimeFrom(event.target.value)} /></Field>
                  <Field labelText="To"><input type="date" className={fieldClass} value={timeTo} onChange={event => setTimeTo(event.target.value)} /></Field>
                  <Field labelText="Employee">
                    <select className={fieldClass} value={timeEmployeeFilter} onChange={event => setTimeEmployeeFilter(event.target.value)}>
                      <option value="">All employees</option>
                      {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.first_name} {employee.last_name}</option>)}
                    </select>
                  </Field>
                  <div className="flex items-end"><button className={`${secondaryButton} w-full`} onClick={() => loadTimeAndLeave()}>Apply</button></div>
                </div>
                <div className="flex gap-6 border-y border-slate-200 py-3 text-sm">
                  <span><strong className="text-slate-950">{timeTotals.regular.toFixed(1)}</strong> regular</span>
                  <span><strong className="text-slate-950">{timeTotals.overtime.toFixed(1)}</strong> overtime</span>
                  <span><strong className="text-slate-950">{timeTotals.paidLeave.toFixed(1)}</strong> paid leave</span>
                </div>
                <div className="overflow-x-auto border-b border-slate-200">
                  <table className="w-full min-w-[900px] text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                      <tr>
                        <th className="px-4 py-3">Date</th><th className="px-4 py-3">Employee</th>
                        <th className="px-4 py-3">Regular</th><th className="px-4 py-3">OT</th>
                        <th className="px-4 py-3">PTO</th><th className="px-4 py-3">Sick</th>
                        <th className="px-4 py-3">Unpaid</th><th className="px-4 py-3">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 bg-white">
                      {timeEntries.map(entry => (
                        <tr key={entry.id} className="cursor-pointer hover:bg-slate-50" onClick={() => openTimeEntry(entry)}>
                          <td className="px-4 py-3 font-semibold text-slate-900">{formatDate(entry.work_date)}</td>
                          <td className="px-4 py-3">{entry.first_name} {entry.last_name}</td>
                          <td className="px-4 py-3">{entry.regular_hours}</td>
                          <td className="px-4 py-3">{entry.overtime_hours}</td>
                          <td className="px-4 py-3">{entry.pto_hours}</td>
                          <td className="px-4 py-3">{entry.sick_hours}</td>
                          <td className="px-4 py-3">{entry.unpaid_hours}</td>
                          <td className="max-w-64 truncate px-4 py-3 text-slate-500">{entry.notes || '—'}</td>
                        </tr>
                      ))}
                      {timeEntries.length === 0 && <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-500">No hours recorded for this period.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="space-y-4">
                <SectionHeading title="Leave requests" action={<button className={secondaryButton} onClick={openLeaveRequest}><Plus className="h-4 w-4" />Add</button>} />
                <div className="divide-y divide-slate-200 border-y border-slate-200">
                  {leaveRequests.map(request => (
                    <div key={request.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-slate-950">{request.first_name} {request.last_name} · {label(request.leave_type)}</p>
                        <p className="text-sm text-slate-500">{formatDate(request.start_date)} to {formatDate(request.end_date)} · {request.hours} hours</p>
                      </div>
                      <StatusPill value={request.status} />
                      {request.status === 'requested' && (
                        <div className="flex gap-2">
                          <button className={secondaryButton} onClick={() => reviewLeave(request.id, 'denied')}><X className="h-4 w-4" />Deny</button>
                          <button className={primaryButton} onClick={() => reviewLeave(request.id, 'approved')}><Check className="h-4 w-4" />Approve</button>
                        </div>
                      )}
                    </div>
                  ))}
                  {leaveRequests.length === 0 && <p className="py-10 text-center text-sm text-slate-500">No leave requests.</p>}
                </div>
              </section>
            </div>
          )}

          {activeTab === 'pay' && (
            <div className="space-y-7">
              <section className="space-y-4">
                <SectionHeading title="Compensation" />
                <div className="overflow-x-auto border-b border-slate-200">
                  <table className="w-full min-w-[900px] text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                      <tr><th className="px-4 py-3">Employee</th><th className="px-4 py-3">Pay</th><th className="px-4 py-3">Frequency</th><th className="px-4 py-3">Classification</th><th className="px-4 py-3">Standard hours</th><th className="px-4 py-3">Benefit eligible</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 bg-white">
                      {employees.map(employee => (
                        <tr key={employee.id} className="cursor-pointer hover:bg-slate-50" onClick={() => openEmployee(employee)}>
                          <td className="px-4 py-3 font-semibold text-slate-950">{employee.first_name} {employee.last_name}</td>
                          <td className="px-4 py-3">{formatPay(employee)}</td>
                          <td className="px-4 py-3">{label(employee.pay_frequency)}</td>
                          <td className="px-4 py-3">{label(employee.classification)}</td>
                          <td className="px-4 py-3">{employee.standard_weekly_hours}</td>
                          <td className="px-4 py-3">{employee.benefit_eligible ? formatDate(employee.benefit_eligibility_date) : 'No'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="space-y-4">
                <SectionHeading title="Benefits" action={<button className={secondaryButton} onClick={() => openBenefit()}><Plus className="h-4 w-4" />Add</button>} />
                <div className="overflow-x-auto border-b border-slate-200">
                  <table className="w-full min-w-[950px] text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                      <tr><th className="px-4 py-3">Employee</th><th className="px-4 py-3">Benefit</th><th className="px-4 py-3">Plan</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Effective</th><th className="px-4 py-3">Employee / mo.</th><th className="px-4 py-3">Employer / mo.</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 bg-white">
                      {benefits.map(benefit => (
                        <tr key={benefit.id}>
                          <td className="px-4 py-3 font-semibold text-slate-950">{benefit.first_name} {benefit.last_name}</td>
                          <td className="px-4 py-3">{label(benefit.benefit_type)}</td>
                          <td className="px-4 py-3">{benefit.plan_name}<span className="block text-xs text-slate-500">{benefit.coverage_level || ''}</span></td>
                          <td className="px-4 py-3"><StatusPill value={benefit.status} /></td>
                          <td className="px-4 py-3">{formatDate(benefit.effective_date)}</td>
                          <td className="px-4 py-3">{formatCurrency(benefit.employee_monthly_cents)}</td>
                          <td className="px-4 py-3">{formatCurrency(benefit.employer_monthly_cents)}</td>
                        </tr>
                      ))}
                      {benefits.length === 0 && <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-500">No benefit records.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          )}

          {activeTab === 'compliance' && (
            <div className="space-y-4">
              <div className="divide-y divide-slate-200 border-y border-slate-200">
                {complianceTasks.map(task => {
                  const overdue = task.status === 'pending' && task.due_date && task.due_date < new Date().toISOString().slice(0, 10);
                  return (
                    <div key={task.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center">
                      <button
                        type="button"
                        className={iconButton}
                        title={task.status === 'complete' ? 'Reopen task' : 'Mark complete'}
                        onClick={() => updateCompliance(task.id, task.status === 'complete' ? 'pending' : 'complete')}
                      >
                        {task.status === 'complete' ? <Check className="h-4 w-4 text-emerald-700" /> : <ClipboardCheck className="h-4 w-4" />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className={`text-sm font-semibold ${task.status === 'complete' ? 'text-slate-500 line-through' : 'text-slate-950'}`}>{task.task_name}</p>
                        <p className="text-xs text-slate-500">{task.first_name} {task.last_name} · {label(task.category)}</p>
                      </div>
                      <span className={`text-xs font-semibold ${overdue ? 'text-rose-700' : 'text-slate-500'}`}>{formatDate(task.due_date)}</span>
                      <StatusPill value={task.status} />
                    </div>
                  );
                })}
                {complianceTasks.length === 0 && <p className="py-12 text-center text-sm text-slate-500">No compliance tasks.</p>}
              </div>
            </div>
          )}
        </>
      )}

      <Modal isOpen={modal === 'resume_import'} onClose={() => setModal(null)} title="Upload Resumes" size="lg">
        <form onSubmit={startResumeIntake}>
          <input
            ref={resumeBatchInputRef}
            type="file"
            accept=".pdf,application/pdf"
            multiple
            className="hidden"
            onChange={event => selectResumeBatchFiles(event.target.files)}
          />
          <button
            type="button"
            className="flex min-h-28 w-full items-center justify-center gap-3 rounded-md border border-dashed border-slate-400 bg-slate-50 px-4 text-sm font-semibold text-slate-700 transition hover:border-amber-700 hover:bg-amber-50"
            onClick={() => resumeBatchInputRef.current?.click()}
          >
            <Upload className="h-5 w-5" />
            Select up to 20 PDF resumes or resume packets
          </button>

          {selectedResumeFiles.length > 0 && (
            <div className="mt-4 max-h-56 divide-y divide-slate-200 overflow-y-auto border-y border-slate-200">
              {selectedResumeFiles.map(file => (
                <div key={`${file.name}-${file.size}-${file.lastModified}`} className="flex items-center gap-3 py-3">
                  <FileText className="h-4 w-4 shrink-0 text-amber-700" />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">{file.name}</span>
                  <span className="text-xs text-slate-500">{formatBytes(file.size)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 flex gap-3 border-l-4 border-amber-600 bg-amber-50 px-4 py-3 text-sm text-slate-900">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              BuildTrack scans every page, separates multi-person packets into one PDF per applicant, and sends the
              candidate-specific files to Anthropic for factual data extraction. The full source packet stays private
              and is never attached to an individual applicant. Every result requires management review.
            </p>
          </div>

          <div className="mt-6 flex justify-end gap-2 border-t border-slate-200 pt-4">
            <button type="button" className={secondaryButton} onClick={() => setModal(null)}>Cancel</button>
            <button type="submit" className={primaryButton} disabled={saving || selectedResumeFiles.length === 0}>
              <Upload className="h-4 w-4" />
              {saving ? 'Uploading...' : `Upload Resumes${selectedResumeFiles.length ? ` (${selectedResumeFiles.length})` : ''}`}
            </button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={modal === 'ai_settings'} onClose={() => setModal(null)} title="Claude configuration" size="md">
        <form onSubmit={saveAnthropicSettings}>
          <div className="border-y border-slate-200 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-950">
                  {aiSettings?.configured ? `Configured ****${aiSettings.last_four || ''}` : 'Not configured'}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {aiSettings?.configured
                    ? `${aiSettings.source === 'managed' ? 'Managed in BuildTrack' : 'Server environment'} · ${aiSettings.model}`
                    : 'Add an Anthropic API key to enable resume uploads.'}
                </p>
              </div>
              <StatusPill value={aiSettings?.configured ? 'active' : 'not_set'} />
            </div>
          </div>

          <Field labelText={aiSettings?.configured ? 'Replace API key' : 'Anthropic API key'} className="mt-5">
            <input
              type="password"
              autoComplete="new-password"
              className={fieldClass}
              value={anthropicKey}
              onChange={event => setAnthropicKey(event.target.value)}
              placeholder="sk-ant-..."
            />
          </Field>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            BuildTrack validates the key before encrypting it. The full key is never returned to the browser.
          </p>

          <div className="mt-6 flex flex-wrap justify-between gap-2 border-t border-slate-200 pt-4">
            <div>
              {aiSettings?.source === 'managed' && (
                <button type="button" className={secondaryButton} onClick={removeManagedAnthropicKey} disabled={saving}>
                  Remove override
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button type="button" className={secondaryButton} onClick={() => setModal(null)}>Close</button>
              <button type="submit" className={primaryButton} disabled={saving || !anthropicKey.trim()}>
                <KeyRound className="h-4 w-4" />
                {saving ? 'Validating...' : 'Validate and save'}
              </button>
            </div>
          </div>
        </form>
      </Modal>

      <Modal isOpen={modal === 'candidate'} onClose={() => setModal(null)} title={selectedCandidate ? 'Edit applicant' : 'Add applicant'} size="lg">
        <form onSubmit={saveCandidate}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field labelText="First name"><input required className={fieldClass} value={candidateForm.first_name} onChange={event => setCandidateForm({ ...candidateForm, first_name: event.target.value })} /></Field>
            <Field labelText="Last name"><input required className={fieldClass} value={candidateForm.last_name} onChange={event => setCandidateForm({ ...candidateForm, last_name: event.target.value })} /></Field>
            <Field labelText="Email"><input type="email" className={fieldClass} value={candidateForm.email} onChange={event => setCandidateForm({ ...candidateForm, email: event.target.value })} /></Field>
            <Field labelText="Phone"><input type="tel" className={fieldClass} value={candidateForm.phone} onChange={event => setCandidateForm({ ...candidateForm, phone: event.target.value })} /></Field>
            <Field labelText="Position"><input className={fieldClass} value={candidateForm.position} onChange={event => setCandidateForm({ ...candidateForm, position: event.target.value })} /></Field>
            <Field labelText="Source"><input className={fieldClass} placeholder="Referral, Indeed, website" value={candidateForm.source} onChange={event => setCandidateForm({ ...candidateForm, source: event.target.value })} /></Field>
            <Field labelText="Status">
              <select className={fieldClass} value={candidateForm.status} onChange={event => setCandidateForm({ ...candidateForm, status: event.target.value })}>
                {CANDIDATE_STATUSES.map(status => <option key={status} value={status}>{label(status)}</option>)}
              </select>
            </Field>
            <Field labelText="Next follow-up"><input type="datetime-local" className={fieldClass} value={candidateForm.next_follow_up_at} onChange={event => setCandidateForm({ ...candidateForm, next_follow_up_at: event.target.value })} /></Field>
            <Field labelText="Notes" className="sm:col-span-2">
              <VoiceTextarea name="candidate_notes" className={textAreaClass} rows={4} placeholder="Applicant and resume notes..." value={candidateForm.notes} onChange={event => setCandidateForm({ ...candidateForm, notes: event.target.value })} />
            </Field>
          </div>
          <FormActions saving={saving} onCancel={() => setModal(null)} />
        </form>
      </Modal>

      <Modal isOpen={modal === 'candidate_detail'} onClose={() => setModal(null)} title={candidateDetail ? `${candidateDetail.candidate.first_name} ${candidateDetail.candidate.last_name}` : 'Applicant'} size="xl">
        {candidateDetail && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill value={candidateDetail.candidate.status} />
              {candidateDetail.candidate.phone && <a className={secondaryButton} href={`tel:${candidateDetail.candidate.phone}`}><Phone className="h-4 w-4" />Call</a>}
              {candidateDetail.candidate.email && <a className={secondaryButton} href={`mailto:${candidateDetail.candidate.email}`}><Mail className="h-4 w-4" />Email</a>}
              <button className={secondaryButton} onClick={() => openActivity('call')}><Phone className="h-4 w-4" />Log call</button>
              <button className={secondaryButton} onClick={() => openActivity('email')}><Mail className="h-4 w-4" />Log email</button>
              {Boolean(candidateDetail.candidate.ai_review_required) && (
                <button className={secondaryButton} onClick={() => markAiReviewed(candidateDetail.candidate.id)}>
                  <CheckCircle2 className="h-4 w-4" />Mark reviewed
                </button>
              )}
              <button className={secondaryButton} onClick={() => openEditCandidate(candidateDetail.candidate)}>Edit</button>
              {candidateDetail.candidate.status !== 'hired' && <button className={primaryButton} onClick={() => openAddEmployee(candidateDetail.candidate)}><UsersRound className="h-4 w-4" />Hire</button>}
            </div>

            <dl className="grid gap-x-8 gap-y-4 border-y border-slate-200 py-4 sm:grid-cols-3">
              {[
                ['Position', candidateDetail.candidate.position],
                ['Email', candidateDetail.candidate.email],
                ['Phone', candidateDetail.candidate.phone],
                ['Source', candidateDetail.candidate.source],
                ['Last contact', formatDateTime(candidateDetail.candidate.last_contacted_at)],
                ['Next follow-up', formatDateTime(candidateDetail.candidate.next_follow_up_at)],
              ].map(([title, value]) => (
                <div key={String(title)}>
                  <dt className="text-xs font-semibold uppercase text-slate-500">{title}</dt>
                  <dd className="mt-1 text-sm text-slate-900">{value || 'Not set'}</dd>
                </div>
              ))}
            </dl>

            {candidateDetail.candidate.notes && (
              <section className="space-y-2">
                <SectionHeading title="Applicant notes" />
                <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">{candidateDetail.candidate.notes}</p>
              </section>
            )}

            <section className="space-y-3">
              <SectionHeading
                title="Resumes"
                action={
                  <>
                    <input ref={resumeInputRef} type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg" className="hidden" onChange={event => uploadResume(event.target.files?.[0])} />
                    <button className={secondaryButton} onClick={() => resumeInputRef.current?.click()} disabled={saving}><Upload className="h-4 w-4" />Upload</button>
                  </>
                }
              />
              <div className="divide-y divide-slate-200">
                {candidateDetail.documents.map(document => (
                  <div key={document.id} className="flex items-center gap-3 py-3">
                    <FileText className="h-5 w-5 text-amber-700" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-900">{document.original_name}</p>
                      <p className="text-xs text-slate-500">{(document.size / 1024).toFixed(0)} KB · {formatDate(document.created_at)}</p>
                    </div>
                    <button className={iconButton} title="Download resume" onClick={() => downloadDocument(document)}><Download className="h-4 w-4" /></button>
                  </div>
                ))}
                {candidateDetail.documents.length === 0 && <p className="py-6 text-center text-sm text-slate-500">No resume uploaded.</p>}
              </div>
            </section>

            <section className="space-y-3">
              <SectionHeading title="Contact history" action={<button className={secondaryButton} onClick={() => openActivity('note')}><Plus className="h-4 w-4" />Note</button>} />
              <div className="divide-y divide-slate-200">
                {candidateDetail.activities.map(activity => (
                  <div key={activity.id} className="flex gap-3 py-3">
                    <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-600">
                      {activity.contact_type === 'call' ? <Phone className="h-4 w-4" /> : activity.contact_type === 'email' ? <Mail className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-slate-900">{label(activity.contact_type)}{activity.outcome ? ` · ${activity.outcome}` : ''}</p>
                      {activity.notes && <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{activity.notes}</p>}
                      <p className="mt-1 text-xs text-slate-400">{formatDateTime(activity.contacted_at)} · {activity.created_by_name || 'Management'}</p>
                    </div>
                  </div>
                ))}
                {candidateDetail.activities.length === 0 && <p className="py-6 text-center text-sm text-slate-500">No contact activity logged.</p>}
              </div>
            </section>
          </div>
        )}
      </Modal>

      <Modal isOpen={modal === 'activity'} onClose={() => setModal('candidate_detail')} title={`Log ${label(activityForm.contact_type)}`} size="md">
        <form onSubmit={saveActivity}>
          <div className="space-y-4">
            <Field labelText="Type">
              <select className={fieldClass} value={activityForm.contact_type} onChange={event => setActivityForm({ ...activityForm, contact_type: event.target.value })}>
                {['call', 'email', 'voicemail', 'text', 'interview', 'note'].map(type => <option key={type} value={type}>{label(type)}</option>)}
              </select>
            </Field>
            <Field labelText="Date and time"><input required type="datetime-local" className={fieldClass} value={activityForm.contacted_at} onChange={event => setActivityForm({ ...activityForm, contacted_at: event.target.value })} /></Field>
            <Field labelText="Outcome"><input className={fieldClass} placeholder="Reached, left voicemail, follow-up needed" value={activityForm.outcome} onChange={event => setActivityForm({ ...activityForm, outcome: event.target.value })} /></Field>
            <Field labelText="Notes">
              <VoiceTextarea name="candidate_activity_notes" className={textAreaClass} rows={3} value={activityForm.notes} onChange={event => setActivityForm({ ...activityForm, notes: event.target.value })} />
            </Field>
          </div>
          <FormActions saving={saving} onCancel={() => setModal('candidate_detail')} submitLabel="Log activity" />
        </form>
      </Modal>

      <Modal isOpen={modal === 'employee'} onClose={() => setModal(null)} title={selectedEmployee ? 'Edit employee' : 'Add employee'} size="xl">
        <form onSubmit={saveEmployee} className="space-y-6">
          <section className="space-y-4">
            <SectionHeading title="Person" />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field labelText="First name"><input required className={fieldClass} value={employeeForm.first_name} onChange={event => setEmployeeForm({ ...employeeForm, first_name: event.target.value })} /></Field>
              <Field labelText="Last name"><input required className={fieldClass} value={employeeForm.last_name} onChange={event => setEmployeeForm({ ...employeeForm, last_name: event.target.value })} /></Field>
              <Field labelText="Preferred name"><input className={fieldClass} value={employeeForm.preferred_name} onChange={event => setEmployeeForm({ ...employeeForm, preferred_name: event.target.value })} /></Field>
              <Field labelText="Personal email"><input type="email" className={fieldClass} value={employeeForm.personal_email} onChange={event => setEmployeeForm({ ...employeeForm, personal_email: event.target.value })} /></Field>
              <Field labelText="Work email"><input type="email" className={fieldClass} value={employeeForm.work_email} onChange={event => setEmployeeForm({ ...employeeForm, work_email: event.target.value })} /></Field>
              <Field labelText="Phone"><input type="tel" className={fieldClass} value={employeeForm.phone} onChange={event => setEmployeeForm({ ...employeeForm, phone: event.target.value })} /></Field>
              <Field labelText="Mailing address" className="sm:col-span-2"><input className={fieldClass} value={employeeForm.mailing_address} onChange={event => setEmployeeForm({ ...employeeForm, mailing_address: event.target.value })} /></Field>
              <Field labelText="City"><input className={fieldClass} value={employeeForm.city} onChange={event => setEmployeeForm({ ...employeeForm, city: event.target.value })} /></Field>
              <Field labelText="State"><input className={fieldClass} value={employeeForm.state} onChange={event => setEmployeeForm({ ...employeeForm, state: event.target.value })} /></Field>
              <Field labelText="ZIP"><input className={fieldClass} value={employeeForm.postal_code} onChange={event => setEmployeeForm({ ...employeeForm, postal_code: event.target.value })} /></Field>
            </div>
          </section>

          <section className="space-y-4">
            <SectionHeading title="Employment" />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field labelText="Job title"><input className={fieldClass} value={employeeForm.job_title} onChange={event => setEmployeeForm({ ...employeeForm, job_title: event.target.value })} /></Field>
              <Field labelText="Department"><input className={fieldClass} value={employeeForm.department} onChange={event => setEmployeeForm({ ...employeeForm, department: event.target.value })} /></Field>
              <Field labelText="Manager"><input className={fieldClass} value={employeeForm.manager_name} onChange={event => setEmployeeForm({ ...employeeForm, manager_name: event.target.value })} /></Field>
              <Field labelText="Work location"><input className={fieldClass} value={employeeForm.work_location} onChange={event => setEmployeeForm({ ...employeeForm, work_location: event.target.value })} /></Field>
              <Field labelText="Status">
                <select className={fieldClass} value={employeeForm.employment_status} onChange={event => setEmployeeForm({ ...employeeForm, employment_status: event.target.value })}>
                  {['active', 'leave', 'terminated'].map(value => <option key={value} value={value}>{label(value)}</option>)}
                </select>
              </Field>
              <Field labelText="Employment type">
                <select className={fieldClass} value={employeeForm.employment_type} onChange={event => setEmployeeForm({ ...employeeForm, employment_type: event.target.value })}>
                  {EMPLOYMENT_TYPES.map(value => <option key={value} value={value}>{label(value)}</option>)}
                </select>
              </Field>
              <Field labelText="Classification">
                <select className={fieldClass} value={employeeForm.classification} onChange={event => setEmployeeForm({ ...employeeForm, classification: event.target.value })}>
                  {['non_exempt', 'exempt', 'independent_contractor'].map(value => <option key={value} value={value}>{label(value)}</option>)}
                </select>
              </Field>
              <Field labelText="Hire date"><input type="date" className={fieldClass} value={employeeForm.hire_date} onChange={event => setEmployeeForm({ ...employeeForm, hire_date: event.target.value })} /></Field>
              <Field labelText="Termination date"><input type="date" className={fieldClass} value={employeeForm.termination_date} onChange={event => setEmployeeForm({ ...employeeForm, termination_date: event.target.value })} /></Field>
            </div>
          </section>

          <section className="space-y-4">
            <SectionHeading title="Pay and benefits" />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field labelText="Pay type">
                <select className={fieldClass} value={employeeForm.pay_type} onChange={event => setEmployeeForm({ ...employeeForm, pay_type: event.target.value })}>
                  <option value="hourly">Hourly</option><option value="salary">Salary</option>
                </select>
              </Field>
              <Field labelText={employeeForm.pay_type === 'salary' ? 'Annual salary' : 'Hourly rate'}><input type="number" min="0" step="0.01" className={fieldClass} value={employeeForm.pay_rate} onChange={event => setEmployeeForm({ ...employeeForm, pay_rate: event.target.value })} /></Field>
              <Field labelText="Pay frequency">
                <select className={fieldClass} value={employeeForm.pay_frequency} onChange={event => setEmployeeForm({ ...employeeForm, pay_frequency: event.target.value })}>
                  {['weekly', 'biweekly', 'semimonthly', 'monthly'].map(value => <option key={value} value={value}>{label(value)}</option>)}
                </select>
              </Field>
              <Field labelText="Standard weekly hours"><input type="number" min="0" max="168" step="0.25" className={fieldClass} value={employeeForm.standard_weekly_hours} onChange={event => setEmployeeForm({ ...employeeForm, standard_weekly_hours: event.target.value })} /></Field>
              <label className="flex h-10 items-center gap-2 self-end rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700">
                <input type="checkbox" checked={employeeForm.benefit_eligible} onChange={event => setEmployeeForm({ ...employeeForm, benefit_eligible: event.target.checked })} />
                Benefit eligible
              </label>
              <Field labelText="Benefit eligibility date"><input type="date" className={fieldClass} value={employeeForm.benefit_eligibility_date} onChange={event => setEmployeeForm({ ...employeeForm, benefit_eligibility_date: event.target.value })} /></Field>
            </div>
          </section>

          <section className="space-y-4">
            <SectionHeading title="Emergency contact" />
            <div className="grid gap-4 sm:grid-cols-3">
              <Field labelText="Name"><input className={fieldClass} value={employeeForm.emergency_contact_name} onChange={event => setEmployeeForm({ ...employeeForm, emergency_contact_name: event.target.value })} /></Field>
              <Field labelText="Relationship"><input className={fieldClass} value={employeeForm.emergency_contact_relationship} onChange={event => setEmployeeForm({ ...employeeForm, emergency_contact_relationship: event.target.value })} /></Field>
              <Field labelText="Phone"><input type="tel" className={fieldClass} value={employeeForm.emergency_contact_phone} onChange={event => setEmployeeForm({ ...employeeForm, emergency_contact_phone: event.target.value })} /></Field>
              <Field labelText="Notes" className="sm:col-span-3">
                <VoiceTextarea name="employee_notes" className={textAreaClass} rows={4} value={employeeForm.notes} onChange={event => setEmployeeForm({ ...employeeForm, notes: event.target.value })} />
              </Field>
            </div>
          </section>
          <FormActions saving={saving} onCancel={() => setModal(null)} />
        </form>
      </Modal>

      <Modal isOpen={modal === 'employee_detail'} onClose={() => setModal(null)} title={employeeDetail ? `${employeeDetail.employee.first_name} ${employeeDetail.employee.last_name}` : 'Employee'} size="xl">
        {employeeDetail && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill value={employeeDetail.employee.employment_status} />
              <button className={secondaryButton} onClick={() => openEditEmployee(employeeDetail.employee)}>Edit employee</button>
              <button className={secondaryButton} onClick={() => openLeaveBalance(employeeDetail.employee)}><Clock3 className="h-4 w-4" />Leave balance</button>
              <button className={primaryButton} onClick={() => openBenefit(employeeDetail.employee)}><HeartPulse className="h-4 w-4" />Add benefit</button>
            </div>
            <dl className="grid gap-x-8 gap-y-4 border-y border-slate-200 py-4 sm:grid-cols-3">
              {[
                ['Job title', employeeDetail.employee.job_title],
                ['Department', employeeDetail.employee.department],
                ['Manager', employeeDetail.employee.manager_name],
                ['Employment type', label(employeeDetail.employee.employment_type)],
                ['Classification', label(employeeDetail.employee.classification)],
                ['Hire date', formatDate(employeeDetail.employee.hire_date)],
                ['Pay', formatPay(employeeDetail.employee)],
                ['Pay frequency', label(employeeDetail.employee.pay_frequency)],
                ['Standard hours', `${employeeDetail.employee.standard_weekly_hours} / week`],
                ['Email', employeeDetail.employee.work_email || employeeDetail.employee.personal_email],
                ['Phone', employeeDetail.employee.phone],
                ['Work location', employeeDetail.employee.work_location],
              ].map(([title, value]) => (
                <div key={String(title)}>
                  <dt className="text-xs font-semibold uppercase text-slate-500">{title}</dt>
                  <dd className="mt-1 text-sm text-slate-900">{value || 'Not set'}</dd>
                </div>
              ))}
            </dl>
            <section className="space-y-3">
              <SectionHeading title="Benefits" />
              <div className="divide-y divide-slate-200">
                {employeeDetail.benefits.map(benefit => (
                  <div key={benefit.id} className="flex items-center gap-3 py-3">
                    <HeartPulse className="h-4 w-4 text-amber-700" />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-slate-900">{benefit.plan_name}</p>
                      <p className="text-xs text-slate-500">{label(benefit.benefit_type)} · {benefit.coverage_level || 'No coverage level'} · {formatDate(benefit.effective_date)}</p>
                    </div>
                    <StatusPill value={benefit.status} />
                  </div>
                ))}
                {employeeDetail.benefits.length === 0 && <p className="py-5 text-sm text-slate-500">No benefit records.</p>}
              </div>
            </section>
            <section className="space-y-3">
              <SectionHeading title="Leave balances" />
              <div className="grid gap-3 sm:grid-cols-3">
                {employeeDetail.leave_balances.map(balance => (
                  <div key={balance.id} className="rounded-md border border-slate-200 p-3">
                    <p className="text-xs font-semibold uppercase text-slate-500">{label(balance.leave_type)} · {balance.benefit_year}</p>
                    <p className="mt-2 text-xl font-bold text-slate-950">{(balance.opening_hours + balance.accrued_hours - balance.used_hours).toFixed(1)}</p>
                    <p className="text-xs text-slate-500">{balance.used_hours} used</p>
                  </div>
                ))}
                {employeeDetail.leave_balances.length === 0 && <p className="py-5 text-sm text-slate-500">No leave balances.</p>}
              </div>
            </section>
            <section className="space-y-3">
              <SectionHeading title="Onboarding and compliance" />
              <div className="divide-y divide-slate-200">
                {employeeDetail.compliance_tasks.map(task => (
                  <div key={task.id} className="flex items-center gap-3 py-3">
                    <button className={iconButton} title={task.status === 'complete' ? 'Reopen task' : 'Mark complete'} onClick={() => updateCompliance(task.id, task.status === 'complete' ? 'pending' : 'complete')}>
                      {task.status === 'complete' ? <Check className="h-4 w-4 text-emerald-700" /> : <ClipboardCheck className="h-4 w-4" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm font-semibold ${task.status === 'complete' ? 'text-slate-500 line-through' : 'text-slate-900'}`}>{task.task_name}</p>
                      <p className="text-xs text-slate-500">{label(task.category)}</p>
                    </div>
                    <span className="text-xs text-slate-500">{formatDate(task.due_date)}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </Modal>

      <Modal isOpen={modal === 'time'} onClose={() => setModal(null)} title="Record hours" size="lg">
        <form onSubmit={saveTimeEntry}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field labelText="Employee">
              <select required className={fieldClass} value={timeForm.employee_id} onChange={event => setTimeForm({ ...timeForm, employee_id: event.target.value })}>
                <option value="">Select employee</option>
                {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.first_name} {employee.last_name}</option>)}
              </select>
            </Field>
            <Field labelText="Work date"><input required type="date" className={fieldClass} value={timeForm.work_date} onChange={event => setTimeForm({ ...timeForm, work_date: event.target.value })} /></Field>
            {[
              ['Regular hours', 'regular_hours'],
              ['Overtime hours', 'overtime_hours'],
              ['PTO hours', 'pto_hours'],
              ['Sick hours', 'sick_hours'],
              ['Unpaid hours', 'unpaid_hours'],
            ].map(([title, key]) => (
              <Field key={key} labelText={title}>
                <input type="number" min="0" max="24" step="0.25" className={fieldClass} value={timeForm[key as keyof typeof timeForm]} onChange={event => setTimeForm({ ...timeForm, [key]: event.target.value })} />
              </Field>
            ))}
            <Field labelText="Notes" className="sm:col-span-2">
              <VoiceTextarea name="time_entry_notes" className={textAreaClass} rows={3} value={timeForm.notes} onChange={event => setTimeForm({ ...timeForm, notes: event.target.value })} />
            </Field>
          </div>
          <FormActions saving={saving} onCancel={() => setModal(null)} submitLabel="Save hours" />
        </form>
      </Modal>

      <Modal isOpen={modal === 'leave'} onClose={() => setModal(null)} title="Leave request" size="lg">
        <form onSubmit={saveLeaveRequest}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field labelText="Employee">
              <select required className={fieldClass} value={leaveForm.employee_id} onChange={event => setLeaveForm({ ...leaveForm, employee_id: event.target.value })}>
                <option value="">Select employee</option>
                {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.first_name} {employee.last_name}</option>)}
              </select>
            </Field>
            <Field labelText="Leave type"><select className={fieldClass} value={leaveForm.leave_type} onChange={event => setLeaveForm({ ...leaveForm, leave_type: event.target.value })}>{LEAVE_TYPES.map(type => <option key={type} value={type}>{label(type)}</option>)}</select></Field>
            <Field labelText="Start date"><input required type="date" className={fieldClass} value={leaveForm.start_date} onChange={event => setLeaveForm({ ...leaveForm, start_date: event.target.value })} /></Field>
            <Field labelText="End date"><input required type="date" className={fieldClass} value={leaveForm.end_date} onChange={event => setLeaveForm({ ...leaveForm, end_date: event.target.value })} /></Field>
            <Field labelText="Hours"><input type="number" min="0" step="0.25" className={fieldClass} value={leaveForm.hours} onChange={event => setLeaveForm({ ...leaveForm, hours: event.target.value })} /></Field>
            <Field labelText="Status"><select className={fieldClass} value={leaveForm.status} onChange={event => setLeaveForm({ ...leaveForm, status: event.target.value })}><option value="requested">Requested</option><option value="approved">Approved</option></select></Field>
            <Field labelText="Notes" className="sm:col-span-2">
              <VoiceTextarea name="leave_request_notes" className={textAreaClass} rows={3} value={leaveForm.notes} onChange={event => setLeaveForm({ ...leaveForm, notes: event.target.value })} />
            </Field>
          </div>
          <FormActions saving={saving} onCancel={() => setModal(null)} />
        </form>
      </Modal>

      <Modal isOpen={modal === 'leave_balance'} onClose={() => setModal(employeeDetail ? 'employee_detail' : null)} title="Leave balance" size="lg">
        <form onSubmit={saveLeaveBalance}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field labelText="Employee">
              <select required className={fieldClass} value={leaveBalanceForm.employee_id} onChange={event => setLeaveBalanceForm({ ...leaveBalanceForm, employee_id: event.target.value })}>
                {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.first_name} {employee.last_name}</option>)}
              </select>
            </Field>
            <Field labelText="Leave type"><select className={fieldClass} value={leaveBalanceForm.leave_type} onChange={event => setLeaveBalanceForm({ ...leaveBalanceForm, leave_type: event.target.value })}>{LEAVE_TYPES.map(type => <option key={type} value={type}>{label(type)}</option>)}</select></Field>
            <Field labelText="Benefit year"><input type="number" className={fieldClass} value={leaveBalanceForm.benefit_year} onChange={event => setLeaveBalanceForm({ ...leaveBalanceForm, benefit_year: event.target.value })} /></Field>
            <Field labelText="Opening hours"><input type="number" min="0" step="0.25" className={fieldClass} value={leaveBalanceForm.opening_hours} onChange={event => setLeaveBalanceForm({ ...leaveBalanceForm, opening_hours: event.target.value })} /></Field>
            <Field labelText="Accrued hours"><input type="number" min="0" step="0.25" className={fieldClass} value={leaveBalanceForm.accrued_hours} onChange={event => setLeaveBalanceForm({ ...leaveBalanceForm, accrued_hours: event.target.value })} /></Field>
            <Field labelText="Used hours"><input type="number" min="0" step="0.25" className={fieldClass} value={leaveBalanceForm.used_hours} onChange={event => setLeaveBalanceForm({ ...leaveBalanceForm, used_hours: event.target.value })} /></Field>
            <Field labelText="Annual use limit"><input type="number" min="0" step="0.25" className={fieldClass} value={leaveBalanceForm.annual_use_limit_hours} onChange={event => setLeaveBalanceForm({ ...leaveBalanceForm, annual_use_limit_hours: event.target.value })} /></Field>
          </div>
          <FormActions saving={saving} onCancel={() => setModal(employeeDetail ? 'employee_detail' : null)} />
        </form>
      </Modal>

      <Modal isOpen={modal === 'benefit'} onClose={() => setModal(employeeDetail ? 'employee_detail' : null)} title="Add benefit" size="lg">
        <form onSubmit={saveBenefit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field labelText="Employee">
              <select required className={fieldClass} value={benefitForm.employee_id} onChange={event => setBenefitForm({ ...benefitForm, employee_id: event.target.value })}>
                <option value="">Select employee</option>
                {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.first_name} {employee.last_name}</option>)}
              </select>
            </Field>
            <Field labelText="Benefit type"><select className={fieldClass} value={benefitForm.benefit_type} onChange={event => setBenefitForm({ ...benefitForm, benefit_type: event.target.value })}>{BENEFIT_TYPES.map(type => <option key={type} value={type}>{label(type)}</option>)}</select></Field>
            <Field labelText="Plan name"><input required className={fieldClass} value={benefitForm.plan_name} onChange={event => setBenefitForm({ ...benefitForm, plan_name: event.target.value })} /></Field>
            <Field labelText="Coverage level"><input className={fieldClass} placeholder="Employee, family, employee + spouse" value={benefitForm.coverage_level} onChange={event => setBenefitForm({ ...benefitForm, coverage_level: event.target.value })} /></Field>
            <Field labelText="Status"><select className={fieldClass} value={benefitForm.status} onChange={event => setBenefitForm({ ...benefitForm, status: event.target.value })}>{['offered', 'waived', 'enrolled', 'ended'].map(status => <option key={status} value={status}>{label(status)}</option>)}</select></Field>
            <Field labelText="Effective date"><input type="date" className={fieldClass} value={benefitForm.effective_date} onChange={event => setBenefitForm({ ...benefitForm, effective_date: event.target.value })} /></Field>
            <Field labelText="Employee monthly contribution"><input type="number" min="0" step="0.01" className={fieldClass} value={benefitForm.employee_monthly} onChange={event => setBenefitForm({ ...benefitForm, employee_monthly: event.target.value })} /></Field>
            <Field labelText="Employer monthly contribution"><input type="number" min="0" step="0.01" className={fieldClass} value={benefitForm.employer_monthly} onChange={event => setBenefitForm({ ...benefitForm, employer_monthly: event.target.value })} /></Field>
            <Field labelText="Notes" className="sm:col-span-2">
              <VoiceTextarea name="benefit_notes" className={textAreaClass} rows={3} value={benefitForm.notes} onChange={event => setBenefitForm({ ...benefitForm, notes: event.target.value })} />
            </Field>
          </div>
          <FormActions saving={saving} onCancel={() => setModal(employeeDetail ? 'employee_detail' : null)} />
        </form>
      </Modal>

      <Modal isOpen={modal === 'compliance'} onClose={() => setModal(null)} title="Add compliance task" size="lg">
        <form onSubmit={saveComplianceTask}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field labelText="Employee">
              <select required className={fieldClass} value={complianceForm.employee_id} onChange={event => setComplianceForm({ ...complianceForm, employee_id: event.target.value })}>
                <option value="">Select employee</option>
                {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.first_name} {employee.last_name}</option>)}
              </select>
            </Field>
            <Field labelText="Category">
              <select className={fieldClass} value={complianceForm.category} onChange={event => setComplianceForm({ ...complianceForm, category: event.target.value })}>
                {['work_authorization', 'payroll', 'new_hire_reporting', 'policy', 'safety', 'benefits', 'training', 'other'].map(category => <option key={category} value={category}>{label(category)}</option>)}
              </select>
            </Field>
            <Field labelText="Task" className="sm:col-span-2"><input required className={fieldClass} value={complianceForm.task_name} onChange={event => setComplianceForm({ ...complianceForm, task_name: event.target.value })} /></Field>
            <Field labelText="Due date"><input type="date" className={fieldClass} value={complianceForm.due_date} onChange={event => setComplianceForm({ ...complianceForm, due_date: event.target.value })} /></Field>
            <Field labelText="Status"><select className={fieldClass} value={complianceForm.status} onChange={event => setComplianceForm({ ...complianceForm, status: event.target.value })}><option value="pending">Pending</option><option value="complete">Complete</option><option value="not_applicable">Not applicable</option></select></Field>
            <Field labelText="Notes" className="sm:col-span-2">
              <VoiceTextarea name="compliance_notes" className={textAreaClass} rows={3} value={complianceForm.notes} onChange={event => setComplianceForm({ ...complianceForm, notes: event.target.value })} />
            </Field>
          </div>
          <FormActions saving={saving} onCancel={() => setModal(null)} />
        </form>
      </Modal>
    </div>
  );
}
