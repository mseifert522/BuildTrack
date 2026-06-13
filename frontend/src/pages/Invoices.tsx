import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../lib/api';
import { Loading } from '../components/ui';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Eye,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Mail,
  Paperclip,
  Receipt,
  RefreshCw,
  X,
} from 'lucide-react';
import { useAuthStore, isAdminRole } from '../store/authStore';
import toast from 'react-hot-toast';
import { formatDateOnly, formatEasternDate, formatEasternDateTime, parseBuildTrackTimestamp } from '../lib/time';

interface Invoice {
  id: string;
  invoice_number: string;
  project_id: string;
  address: string;
  job_name: string;
  contractor_name: string;
  total: number;
  status: string;
  created_at: string;
  submitted_at: string;
  updated_at?: string;
  linked_work_count?: number;
  payment_hold_count?: number;
  quickbooks_status?: string;
  quickbooks_bill_id?: string | null;
  quickbooks_balance?: number | null;
  quickbooks_payment_status?: string | null;
  quickbooks_synced_at?: string | null;
  quickbooks_vendor_name?: string | null;
  quickbooks_doc_number?: string | null;
  quickbooks_txn_date?: string | null;
  quickbooks_due_date?: string | null;
  quickbooks_last_seen_at?: string | null;
  source?: string;
  vendor_name?: string | null;
  vendor_email?: string | null;
  external_invoice_number?: string | null;
  source_attachment_id?: string | null;
  source_attachment_name?: string | null;
}

interface QuickBooksStatus {
  configured: boolean;
  connected: boolean;
  missing?: string[];
  environment?: string;
  redirect_uri?: string;
  webhook_configured?: boolean;
  webhook_url?: string;
  scope?: string;
  connection?: {
    realm_id?: string;
    company_name?: string | null;
    environment?: string;
    connected_at?: string;
    last_sync_at?: string | null;
    last_sync_status?: string | null;
    last_sync_error?: string | null;
  } | null;
  stats?: {
    bill_count: number;
    paid_count: number;
    open_count: number;
    open_balance: number;
    unmatched_count: number;
    approved_payment_count?: number;
    approved_payment_balance?: number;
  };
}

interface QuickBooksBill {
  qbo_id: string;
  doc_number?: string | null;
  vendor_name?: string | null;
  txn_date?: string | null;
  due_date?: string | null;
  total_amt: number;
  balance: number;
  payment_status: string;
  payment_approval_status?: string | null;
  payment_approved_at?: string | null;
  payment_approved_by?: string | null;
  payment_approved_by_name?: string | null;
  payment_run_date?: string | null;
  payment_approval_notified_at?: string | null;
  payment_approval_notified_by?: string | null;
  payment_approval_notified_by_name?: string | null;
  private_note?: string | null;
  qbo_class_id?: string | null;
  qbo_class_name?: string | null;
  matched_invoice_id?: string | null;
  project_id?: string | null;
  invoice_number?: string | null;
  external_invoice_number?: string | null;
  buildtrack_status?: string | null;
  project_address?: string | null;
  project_job_name?: string | null;
  qbo_updated_at?: string | null;
  last_seen_at?: string | null;
  last_paid_at?: string | null;
  last_paid_seen_at?: string | null;
  last_paid_payment_id?: string | null;
  split_lines?: QuickBooksBillSplitLine[];
  split_line_count?: number;
  matched_split_line_count?: number;
  unmatched_split_line_count?: number;
}

interface QuickBooksBillSplitLine {
  id: string;
  qbo_bill_id: string;
  qbo_line_id?: string | null;
  line_num?: number | null;
  description?: string | null;
  amount: number;
  category_name?: string | null;
  class_id?: string | null;
  class_name?: string | null;
  project_id?: string | null;
  project_address?: string | null;
  project_job_name?: string | null;
}

type QuickBooksBillFilter = 'open' | 'friday_queue' | 'paid' | 'all';

interface ProjectOption {
  id: string;
  address: string;
  job_name: string;
  status: string;
  updated_at?: string;
}

interface InvoiceEmailAttachment {
  id: string;
  original_name: string;
  mime_type?: string;
  size: number;
  filed_invoice_id?: string | null;
  filed_invoice_number?: string | null;
  filed_project_id?: string | null;
  filed_project_address?: string | null;
  filed_at?: string | null;
}

interface InvoiceEmailItem {
  id: string;
  from_email?: string | null;
  from_name?: string | null;
  subject: string;
  status: string;
  received_at: string;
  attachment_count: number;
  attachments: InvoiceEmailAttachment[];
  filed_attachment_count?: number;
  unfiled_attachment_count?: number;
  body_preview?: string | null;
  text_body?: string | null;
  html_body?: string | null;
  agent_status?: string;
  extracted_vendor?: string | null;
  extracted_invoice_number?: string | null;
  extracted_amount?: number | null;
  extracted_summary?: string | null;
  matched_project_id?: string | null;
  match_confidence?: number | null;
  matched_project_address?: string | null;
  matched_project_job_name?: string | null;
}

interface AssignmentTask {
  id: string;
  title: string;
  category?: string | null;
  status: string;
  verification_status: string;
  invoice_status: string;
  project_scope_id?: string | null;
}

interface AssignmentScope {
  id: string;
  section_name: string;
  scope_title: string;
  status: string;
}

interface AssignmentOptions {
  tasks: AssignmentTask[];
  scopes: AssignmentScope[];
}

interface AssignmentDraft {
  projectId: string;
  taskId: string;
  scopeId: string;
  newTaskTitle: string;
  total: string;
  vendorName: string;
  externalInvoiceNumber: string;
}

interface AttachmentPreviewState {
  emailId: string;
  attachment: InvoiceEmailAttachment;
}

const money = (value: number) =>
  Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const stripEmailMarkup = (value?: string | null) =>
  String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

const formatBytes = (value?: number) => {
  const size = Number(value || 0);
  if (!size) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
};

const attachmentUrl = (emailId: string, attachmentId: string, inline = false) =>
  `/api/invoices/email-intake/${emailId}/attachments/${attachmentId}${inline ? '?inline=1' : ''}`;

const attachmentApiPath = (emailId: string, attachmentId: string, inline = false) =>
  `/invoices/email-intake/${emailId}/attachments/${attachmentId}${inline ? '?inline=1' : ''}`;

const isPdfAttachment = (attachment?: InvoiceEmailAttachment | null) =>
  Boolean(attachment && (
    String(attachment.mime_type || '').toLowerCase().includes('pdf') ||
    String(attachment.original_name || '').toLowerCase().endsWith('.pdf')
  ));

const isImageAttachment = (attachment?: InvoiceEmailAttachment | null) =>
  Boolean(attachment && (
    String(attachment.mime_type || '').toLowerCase().startsWith('image/') ||
    /\.(jpe?g|png|gif|webp|bmp)$/i.test(String(attachment.original_name || ''))
  ));

const attachmentKindLabel = (attachment?: InvoiceEmailAttachment | null) => {
  if (isPdfAttachment(attachment)) return 'PDF';
  if (isImageAttachment(attachment)) return 'IMG';
  return 'FILE';
};

const PAYDAY_ANCHOR = new Date('2026-06-12T12:00:00');

const nextPayday = (value?: string | null) => {
  const start = parseBuildTrackTimestamp(value || '') || new Date();
  const candidate = new Date(start);
  candidate.setHours(12, 0, 0, 0);
  const daysUntilFriday = (5 - candidate.getDay() + 7) % 7;
  candidate.setDate(candidate.getDate() + daysUntilFriday);
  if (candidate.getTime() < start.getTime()) candidate.setDate(candidate.getDate() + 7);
  while (Math.round((candidate.getTime() - PAYDAY_ANCHOR.getTime()) / 86400000) % 14 !== 0) {
    candidate.setDate(candidate.getDate() + 7);
  }
  return candidate.toISOString();
};

const statusLabel = (status: string) => {
  if (status === 'draft' || status === 'submitted') return 'New Invoice';
  return status.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
};

const statusClass: Record<string, string> = {
  draft: 'bg-blue-50 text-blue-700 border-blue-100',
  submitted: 'bg-blue-50 text-blue-700 border-blue-100',
  reviewed: 'bg-amber-50 text-amber-700 border-amber-100',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  paid: 'bg-green-50 text-green-700 border-green-100',
};

const emailStatusClass: Record<string, string> = {
  new: 'bg-blue-50 text-blue-700 border-blue-100',
  filed: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  ignored: 'bg-gray-100 text-gray-600 border-gray-200',
};

const QUICKBOOKS_PANEL_ROLES = ['super_admin', 'operations_manager'];
const QUICKBOOKS_BILLS_PATH = '/quickbooks/bills?limit=1000';

const qboStatusLabel = (status?: string | null) => {
  const value = String(status || 'unpaid').toLowerCase();
  if (value === 'paid') return 'Paid';
  if (value === 'partial') return 'Partial';
  return 'Unpaid';
};

const isQuickBooksBillPaid = (bill?: QuickBooksBill | null) => (
  String(bill?.payment_status || '').toLowerCase() === 'paid'
  || Number(bill?.balance || 0) <= 0
);

const quickBooksBillDateKey = (bill?: QuickBooksBill | null) => (
  String(bill?.txn_date || bill?.due_date || bill?.qbo_updated_at || bill?.last_seen_at || '')
);

const sortQuickBooksBillsByBillDate = (bills: QuickBooksBill[]) => [...bills].sort((a, b) => {
  const dateCompare = quickBooksBillDateKey(a).localeCompare(quickBooksBillDateKey(b));
  if (dateCompare !== 0) return dateCompare;
  const vendorCompare = String(a.vendor_name || '').localeCompare(String(b.vendor_name || ''));
  if (vendorCompare !== 0) return vendorCompare;
  return String(a.doc_number || a.qbo_id || '').localeCompare(String(b.doc_number || b.qbo_id || ''));
});

const quickBooksDateRank = (value?: string | null) => {
  if (!value) return 0;
  const parsed = parseBuildTrackTimestamp(value) || new Date(value);
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : 0;
};

const quickBooksPaidDateKey = (bill?: QuickBooksBill | null) => (
  String(
    bill?.last_paid_at
    || bill?.last_paid_seen_at
    || bill?.qbo_updated_at
    || bill?.last_seen_at
    || bill?.txn_date
    || bill?.due_date
    || ''
  )
);

const sortQuickBooksBillsByPaidDate = (bills: QuickBooksBill[]) => [...bills].sort((a, b) => {
  const paidCompare = quickBooksDateRank(quickBooksPaidDateKey(b)) - quickBooksDateRank(quickBooksPaidDateKey(a));
  if (paidCompare !== 0) return paidCompare;
  const observedCompare = quickBooksDateRank(b.last_paid_seen_at || b.qbo_updated_at || b.last_seen_at) - quickBooksDateRank(a.last_paid_seen_at || a.qbo_updated_at || a.last_seen_at);
  if (observedCompare !== 0) return observedCompare;
  const vendorCompare = String(a.vendor_name || '').localeCompare(String(b.vendor_name || ''));
  if (vendorCompare !== 0) return vendorCompare;
  return String(a.doc_number || a.qbo_id || '').localeCompare(String(b.doc_number || b.qbo_id || ''));
});

const formatQuickBooksPaidDate = (bill?: QuickBooksBill | null) => {
  const value = bill?.last_paid_at || bill?.last_paid_seen_at || bill?.qbo_updated_at || bill?.last_seen_at || '';
  if (!value) return '';
  return /[T:]/.test(value)
    ? formatEasternDateTime(value, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : formatDateOnly(value, { month: 'short', day: 'numeric', year: 'numeric' });
};

const quickBooksSplitLines = (bill: QuickBooksBill) => (
  Array.isArray(bill.split_lines) ? bill.split_lines : []
);

const quickBooksSplitLineCount = (bill: QuickBooksBill) => Number(
  bill.split_line_count ?? quickBooksSplitLines(bill).length ?? 0
);

const quickBooksUnmatchedSplitLineCount = (bill: QuickBooksBill) => Number(
  bill.unmatched_split_line_count
  ?? quickBooksSplitLines(bill).filter(line => !line.project_id).length
  ?? 0
);

const quickBooksBillSplitMatched = (bill: QuickBooksBill) => (
  quickBooksSplitLineCount(bill) > 0 && quickBooksUnmatchedSplitLineCount(bill) === 0
);

const quickBooksBillHasApprovalMatch = (bill: QuickBooksBill, invoice?: Invoice | null) => Boolean(
  invoice?.project_id || bill.project_id || quickBooksBillSplitMatched(bill)
);

export default function Invoices() {
  const { user } = useAuthStore();
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingInvoiceId, setUpdatingInvoiceId] = useState<string | null>(null);
  const [emailBoxLoading, setEmailBoxLoading] = useState(false);
  const [emailBoxStatus, setEmailBoxStatus] = useState('new');
  const [emailBoxItems, setEmailBoxItems] = useState<InvoiceEmailItem[]>([]);
  const [expandedEmailIds, setExpandedEmailIds] = useState<Record<string, boolean>>({});
  const [assignmentDrafts, setAssignmentDrafts] = useState<Record<string, AssignmentDraft>>({});
  const [assignmentOptions, setAssignmentOptions] = useState<Record<string, AssignmentOptions>>({});
  const [filingEmailId, setFilingEmailId] = useState<string | null>(null);
  const [ignoringEmailId, setIgnoringEmailId] = useState<string | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreviewState | null>(null);
  const [attachmentPreviewUrl, setAttachmentPreviewUrl] = useState('');
  const [attachmentPreviewLoading, setAttachmentPreviewLoading] = useState(false);
  const [attachmentPreviewError, setAttachmentPreviewError] = useState('');
  const [quickBooksStatus, setQuickBooksStatus] = useState<QuickBooksStatus | null>(null);
  const [quickBooksBills, setQuickBooksBills] = useState<QuickBooksBill[]>([]);
  const [quickBooksBillFilter, setQuickBooksBillFilter] = useState<QuickBooksBillFilter>('open');
  const [approvingQboBillId, setApprovingQboBillId] = useState<string | null>(null);
  const [removingQboBillId, setRemovingQboBillId] = useState<string | null>(null);
  const [notifyingPaymentQueue, setNotifyingPaymentQueue] = useState(false);
  const canReadQuickBooksStatus = isAdminRole(user?.role || '');
  const canManageQuickBooks = Boolean(user?.role && QUICKBOOKS_PANEL_ROLES.includes(user.role));

  const load = async () => {
    setLoading(true);
    try {
      const [projectRes, invoiceRes, qboStatusRes, qboBillsRes] = await Promise.all([
        api.get('/projects'),
        api.get('/invoices'),
        canReadQuickBooksStatus ? api.get('/quickbooks/status').catch(() => ({ data: null })) : Promise.resolve({ data: null }),
        canManageQuickBooks
          ? api.get(QUICKBOOKS_BILLS_PATH).catch(() => ({ data: [] }))
          : Promise.resolve({ data: [] }),
      ]);
      setProjects(Array.isArray(projectRes.data) ? projectRes.data : []);
      setInvoices(Array.isArray(invoiceRes.data) ? invoiceRes.data : []);
      setQuickBooksStatus(qboStatusRes.data || null);
      setQuickBooksBills(Array.isArray(qboBillsRes.data) ? qboBillsRes.data : []);
    } catch {
      toast.error('Failed to load invoices');
    } finally {
      setLoading(false);
    }
  };

  const connectQuickBooks = async () => {
    try {
      const res = await api.get('/quickbooks/connect-url');
      if (!res.data?.auth_url) throw new Error('QuickBooks did not return a connection URL');
      window.location.href = res.data.auth_url;
    } catch (err: any) {
      toast.error(err.response?.data?.error || err.message || 'Failed to start QuickBooks connection');
    }
  };

  const emailDraftKey = (id: string) => `email:${id}`;
  const emailAttachmentDraftKey = (emailId: string, attachmentId: string) => `email:${emailId}:attachment:${attachmentId}`;

  const toggleEmailExpanded = (id: string) => {
    setExpandedEmailIds(current => ({ ...current, [id]: !current[id] }));
  };

  const defaultEmailTaskTitle = (item: InvoiceEmailItem, attachment?: InvoiceEmailAttachment) =>
    String(attachment?.original_name || item.extracted_summary || item.subject || item.extracted_vendor || 'Invoice review').slice(0, 120);

  const loadAssignmentOptions = async (projectId: string) => {
    if (!projectId || assignmentOptions[projectId]) return;
    try {
      const res = await api.get(`/invoices/email-intake/assignment-options?project_id=${encodeURIComponent(projectId)}`);
      setAssignmentOptions(current => ({
        ...current,
        [projectId]: {
          tasks: Array.isArray(res.data?.tasks) ? res.data.tasks : [],
          scopes: Array.isArray(res.data?.scopes) ? res.data.scopes : [],
        },
      }));
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to load project tasks');
    }
  };

  const updateAssignmentDraft = (key: string, patch: Partial<AssignmentDraft>) => {
    setAssignmentDrafts(current => {
      const existing = current[key] || {
        projectId: '',
        taskId: '',
        scopeId: '',
        newTaskTitle: '',
        total: '',
        vendorName: '',
        externalInvoiceNumber: '',
      };
      return { ...current, [key]: { ...existing, ...patch } };
    });
    if (patch.projectId) loadAssignmentOptions(patch.projectId);
  };

  const loadEmailBox = async () => {
    setEmailBoxLoading(true);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (emailBoxStatus) params.set('status', emailBoxStatus);
      const res = await api.get(`/invoices/email-intake?${params}`);
      const rows: InvoiceEmailItem[] = Array.isArray(res.data) ? res.data : [];
      setEmailBoxItems(rows);
      setAssignmentDrafts(current => {
        const next = { ...current };
        rows.forEach(item => {
          const key = emailDraftKey(item.id);
          if (!next[key]) {
            next[key] = {
              projectId: item.matched_project_id || '',
              taskId: '',
              scopeId: '',
              newTaskTitle: defaultEmailTaskTitle(item),
              total: item.extracted_amount ? String(item.extracted_amount) : '',
              vendorName: item.extracted_vendor || item.from_name || item.from_email || '',
              externalInvoiceNumber: item.extracted_invoice_number || '',
            };
          }
          (item.attachments || []).forEach(attachment => {
            const attachmentKey = emailAttachmentDraftKey(item.id, attachment.id);
            if (!next[attachmentKey]) {
              next[attachmentKey] = {
                projectId: attachment.filed_project_id || item.matched_project_id || '',
                taskId: '',
                scopeId: '',
                newTaskTitle: defaultEmailTaskTitle(item, attachment),
                total: item.extracted_amount ? String(item.extracted_amount) : '',
                vendorName: item.extracted_vendor || item.from_name || item.from_email || '',
                externalInvoiceNumber: item.extracted_invoice_number || '',
              };
            }
          });
        });
        return next;
      });
      rows.forEach(item => {
        if (item.matched_project_id) loadAssignmentOptions(item.matched_project_id);
      });
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to load live invoice email box');
    } finally {
      setEmailBoxLoading(false);
    }
  };

  const markEmailNotInvoice = async (item: InvoiceEmailItem) => {
    if (item.status === 'ignored' || ignoringEmailId) return;
    const confirmed = window.confirm(
      'Mark this email as Not an invoice? It will be removed from the active BuildTrack invoice queue, but the original message will remain in Gmail.'
    );
    if (!confirmed) return;

    setIgnoringEmailId(item.id);
    try {
      await api.put(`/invoices/email-intake/${item.id}/status`, { status: 'ignored' });
      setEmailBoxItems(current => (
        emailBoxStatus === 'ignored'
          ? current.map(row => row.id === item.id ? { ...row, status: 'ignored', agent_status: 'ignored' } : row)
          : current.filter(row => row.id !== item.id)
      ));
      toast.success('Removed from BuildTrack invoice queue');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to mark email as not an invoice');
    } finally {
      setIgnoringEmailId(null);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const interval = window.setInterval(async () => {
      try {
        const [invoiceRes, qboStatusRes, qboBillsRes] = await Promise.all([
          api.get('/invoices'),
          canReadQuickBooksStatus ? api.get('/quickbooks/status').catch(() => ({ data: null })) : Promise.resolve({ data: null }),
          canManageQuickBooks
            ? api.get(QUICKBOOKS_BILLS_PATH).catch(() => ({ data: [] }))
            : Promise.resolve({ data: [] }),
        ]);
        setInvoices(Array.isArray(invoiceRes.data) ? invoiceRes.data : []);
        setQuickBooksStatus(qboStatusRes.data || null);
        setQuickBooksBills(Array.isArray(qboBillsRes.data) ? qboBillsRes.data : []);
      } catch {
        // Keep the current dashboard state if a background refresh is interrupted.
      }
    }, 60_000);
    return () => window.clearInterval(interval);
  }, [canManageQuickBooks, canReadQuickBooksStatus]);

  useEffect(() => {
    if (!attachmentPreview) {
      setAttachmentPreviewUrl('');
      setAttachmentPreviewError('');
      setAttachmentPreviewLoading(false);
      return;
    }

    let active = true;
    let objectUrl = '';
    setAttachmentPreviewUrl('');
    setAttachmentPreviewError('');
    setAttachmentPreviewLoading(true);

    api.get(attachmentApiPath(attachmentPreview.emailId, attachmentPreview.attachment.id, true), { responseType: 'blob' })
      .then(res => {
        if (!active) return;
        const responseContentType = res.headers?.['content-type'];
        const blobType = typeof responseContentType === 'string' ? responseContentType : 'application/octet-stream';
        const blob = new Blob([res.data], {
          type: attachmentPreview.attachment.mime_type || blobType,
        });
        objectUrl = URL.createObjectURL(blob);
        setAttachmentPreviewUrl(objectUrl);
      })
      .catch(() => {
        if (active) setAttachmentPreviewError('Unable to load attachment preview. Use Open to view it in a separate tab.');
      })
      .finally(() => {
        if (active) setAttachmentPreviewLoading(false);
      });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachmentPreview?.emailId, attachmentPreview?.attachment.id]);

  const approvedPaymentQueue = useMemo(
    () => quickBooksBills
      .filter(bill => !isQuickBooksBillPaid(bill) && bill.payment_approval_status === 'approved_for_payment')
      .sort((a, b) => {
        const dateCompare = String(a.payment_run_date || '').localeCompare(String(b.payment_run_date || ''));
        if (dateCompare !== 0) return dateCompare;
        return Number(b.balance || 0) - Number(a.balance || 0);
      }),
    [quickBooksBills]
  );
  const approvedPaymentTotal = approvedPaymentQueue.reduce((sum, bill) => sum + Number(bill.balance || 0), 0);
  const paidQuickBooksBills = useMemo(
    () => sortQuickBooksBillsByPaidDate(quickBooksBills.filter(bill => isQuickBooksBillPaid(bill))),
    [quickBooksBills]
  );
  const paidQuickBooksTotal = paidQuickBooksBills.reduce((sum, bill) => sum + Number(bill.total_amt || 0), 0);
  const invoiceById = useMemo(() => new Map(invoices.map(invoice => [invoice.id, invoice])), [invoices]);
  const openQuickBooksBills = useMemo(
    () => quickBooksBills.filter(bill => !isQuickBooksBillPaid(bill) && bill.payment_approval_status !== 'approved_for_payment'),
    [quickBooksBills]
  );
  const allQuickBooksBills = useMemo(() => sortQuickBooksBillsByBillDate(quickBooksBills), [quickBooksBills]);
  const filteredQuickBooksBills = useMemo(
    () => {
      if (quickBooksBillFilter === 'paid') return paidQuickBooksBills;
      if (quickBooksBillFilter === 'friday_queue') return approvedPaymentQueue;
      if (quickBooksBillFilter === 'all') return allQuickBooksBills;
      return sortQuickBooksBillsByBillDate(openQuickBooksBills);
    },
    [allQuickBooksBills, approvedPaymentQueue, openQuickBooksBills, paidQuickBooksBills, quickBooksBillFilter]
  );
  const quickBooksBillFilterMeta: Record<QuickBooksBillFilter, { label: string; title: string; subtitle: string; count: number }> = {
    open: {
      label: 'Open bills',
      title: 'QuickBooks open bills',
      subtitle: 'Unpaid bills not yet approved for the Friday payment queue',
      count: openQuickBooksBills.length,
    },
    friday_queue: {
      label: 'Approved bills',
      title: 'Friday payment queue',
      subtitle: 'Approved unpaid bills waiting for QuickBooks payment',
      count: approvedPaymentQueue.length,
    },
    paid: {
      label: 'Paid bills',
      title: 'Paid QuickBooks bills',
      subtitle: 'Latest paid bills first by QuickBooks payment date and time',
      count: paidQuickBooksBills.length,
    },
    all: {
      label: 'Total bills',
      title: 'All mirrored QuickBooks bills',
      subtitle: 'Every bill currently mirrored from QuickBooks',
      count: allQuickBooksBills.length,
    },
  };
  const selectedQuickBooksBillFilter = quickBooksBillFilterMeta[quickBooksBillFilter];
  const quickBooksMirrorRows = useMemo(() => filteredQuickBooksBills.map(bill => ({
    bill,
    invoice: bill.matched_invoice_id ? invoiceById.get(bill.matched_invoice_id) || null : null,
  })), [filteredQuickBooksBills, invoiceById]);
  const canApproveForPayment = (invoice?: Invoice | null) => Boolean(
    invoice
    && isAdminRole(user?.role || '')
    && invoice.status !== 'approved'
    && invoice.status !== 'paid'
    && invoice.quickbooks_payment_status !== 'paid'
    && Number(invoice.linked_work_count || 0) > 0
    && Number(invoice.payment_hold_count || 0) === 0
  );
  const approvalBlockedReason = (invoice?: Invoice | null) => {
    if (!invoice) return 'No BuildTrack invoice match yet';
    if (invoice.status === 'approved') return 'Already approved for payment';
    if (invoice.status === 'paid' || invoice.quickbooks_payment_status === 'paid') return 'Already paid';
    if (Number(invoice.linked_work_count || 0) === 0) return 'Assign to project work before approval';
    if (Number(invoice.payment_hold_count || 0) > 0) return 'Field work approval is still required';
    return 'Ready for payment approval';
  };
  const paymentRunLabel = (invoice?: Invoice | null) =>
    invoice ? formatEasternDate(nextPayday(invoice.updated_at || invoice.submitted_at || invoice.created_at), { month: 'short', day: 'numeric', year: 'numeric' }) : '';

  const refreshQuickBooksStatus = async () => {
    if (!canReadQuickBooksStatus) return;
    const res = await api.get('/quickbooks/status').catch(() => ({ data: null }));
    if (res.data) setQuickBooksStatus(res.data);
  };

  const qboPaymentRunLabel = (bill?: QuickBooksBill | null) => {
    if (!bill) return '';
    if (bill.payment_run_date) return formatDateOnly(bill.payment_run_date, { month: 'short', day: 'numeric', year: 'numeric' });
    return formatEasternDate(nextPayday(bill.due_date || bill.txn_date || bill.last_seen_at), { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const updateQuickBooksBill = (updated?: QuickBooksBill | null) => {
    if (!updated?.qbo_id) return;
    setQuickBooksBills(prev => prev.map(item => item.qbo_id === updated.qbo_id ? { ...item, ...updated } : item));
  };

  const canApproveQuickBooksBill = (bill: QuickBooksBill, invoice?: Invoice | null) => {
    if (!isAdminRole(user?.role || '')) return false;
    if (isQuickBooksBillPaid(bill)) return false;
    if (bill.payment_approval_status === 'approved_for_payment') return false;
    return quickBooksBillHasApprovalMatch(bill, invoice);
  };

  const quickBooksApprovalBlockedReason = (bill: QuickBooksBill, invoice?: Invoice | null) => {
    if (isQuickBooksBillPaid(bill)) return 'Already paid in QuickBooks';
    if (bill.payment_approval_status === 'approved_for_payment') return 'Already in the Friday payment queue';
    if (quickBooksSplitLineCount(bill) > 0 && quickBooksUnmatchedSplitLineCount(bill) > 0) return 'Assign every class split before approval';
    if (!quickBooksBillHasApprovalMatch(bill, invoice)) return 'Assign before approval';
    return 'Ready for Friday payment approval';
  };

  const approveQuickBooksBillForPay = async (bill: QuickBooksBill, invoice?: Invoice | null) => {
    if (!canApproveQuickBooksBill(bill, invoice)) {
      toast.error(quickBooksApprovalBlockedReason(bill, invoice));
      return;
    }
    setApprovingQboBillId(bill.qbo_id);
    try {
      const res = await api.put(`/quickbooks/bills/${encodeURIComponent(bill.qbo_id)}/approve-for-pay`);
      updateQuickBooksBill(res.data);
      await refreshQuickBooksStatus();
      toast.success('Invoice added to the Friday payment queue');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to approve this bill for pay');
    } finally {
      setApprovingQboBillId(null);
    }
  };

  const removeQuickBooksBillFromPay = async (bill: QuickBooksBill) => {
    setRemovingQboBillId(bill.qbo_id);
    try {
      const res = await api.put(`/quickbooks/bills/${encodeURIComponent(bill.qbo_id)}/remove-from-pay`);
      updateQuickBooksBill(res.data);
      await refreshQuickBooksStatus();
      toast.success('Invoice removed from the Friday payment queue');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to remove this bill from the payment queue');
    } finally {
      setRemovingQboBillId(null);
    }
  };

  const notifyApprovedPaymentQueue = async () => {
    if (!approvedPaymentQueue.length) return toast.error('Approve at least one invoice before sending management the queue');
    setNotifyingPaymentQueue(true);
    try {
      const res = await api.post('/quickbooks/payment-queue/notify');
      const updatedRows: QuickBooksBill[] = Array.isArray(res.data?.rows) ? res.data.rows : [];
      if (updatedRows.length) {
        setQuickBooksBills(prev => prev.map(item => updatedRows.find(row => row.qbo_id === item.qbo_id) || item));
      }
      await refreshQuickBooksStatus();
      toast.success('Management email sent for the Friday payment queue');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to email the approved payment queue');
    } finally {
      setNotifyingPaymentQueue(false);
    }
  };

  const approveForPayment = async (invoice: Invoice) => {
    if (!canApproveForPayment(invoice)) {
      toast.error(approvalBlockedReason(invoice));
      return;
    }
    setUpdatingInvoiceId(invoice.id);
    try {
      await api.put(`/projects/${invoice.project_id}/invoices/${invoice.id}/status`, { status: 'approved' });
      setInvoices(prev => prev.map(item => item.id === invoice.id ? { ...item, status: 'approved', updated_at: new Date().toISOString() } : item));
      toast.success('Invoice approved for payment and management notified');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to approve invoice for payment');
    } finally {
      setUpdatingInvoiceId(null);
    }
  };

  const fileEmailInvoice = async (item: InvoiceEmailItem, attachment?: InvoiceEmailAttachment) => {
    const key = attachment ? emailAttachmentDraftKey(item.id, attachment.id) : emailDraftKey(item.id);
    const draft = assignmentDrafts[key];
    if (!draft?.projectId) return toast.error('Select a project first');
    if (!draft.taskId && !draft.newTaskTitle.trim()) return toast.error('Select an existing task or enter a new task name');

    const busyKey = attachment ? `${item.id}:${attachment.id}` : item.id;
    setFilingEmailId(busyKey);
    try {
      await api.post(`/invoices/email-intake/${item.id}/file`, {
        attachment_id: attachment?.id || undefined,
        project_id: draft.projectId,
        work_item_ids: draft.taskId ? [draft.taskId] : [],
        project_scope_id: draft.scopeId || null,
        new_task_title: draft.newTaskTitle.trim(),
        total: draft.total,
        vendor_name: draft.vendorName,
        external_invoice_number: draft.externalInvoiceNumber,
      });
      toast.success(attachment ? 'Attachment assigned to project invoice' : 'Invoice assigned to project');
      await Promise.all([load(), loadEmailBox()]);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to file invoice');
    } finally {
      setFilingEmailId(null);
    }
  };

  const formatEmailDate = (value?: string) => {
    if (!value) return '-';
    return formatEasternDateTime(value, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  const emailBodyPreview = (item: InvoiceEmailItem) =>
    stripEmailMarkup(item.body_preview || item.text_body || item.html_body || item.extracted_summary || '');

  const renderAssignmentControls = (
    key: string,
    onSave: () => void,
    saveLabel: string,
    busy: boolean,
    includeInvoiceFields = false
  ) => {
    const draft = assignmentDrafts[key] || {
      projectId: '',
      taskId: '',
      scopeId: '',
      newTaskTitle: '',
      total: '',
      vendorName: '',
      externalInvoiceNumber: '',
    };
    const options = draft.projectId ? assignmentOptions[draft.projectId] : null;
    const selectedProject = projects.find(project => project.id === draft.projectId);
    const canSave = Boolean(draft.projectId && (draft.taskId || draft.newTaskTitle.trim()));

    return (
      <div className="bt-invoice-assignment-grid">
        <label className="bt-invoice-field">
          <span>Project</span>
          <select
            value={draft.projectId}
            onChange={event => updateAssignmentDraft(key, { projectId: event.target.value, taskId: '', scopeId: '' })}
          >
            <option value="">Select project</option>
            {projects.map(project => (
              <option key={project.id} value={project.id}>{project.address}</option>
            ))}
          </select>
        </label>

        <label className="bt-invoice-field">
          <span>Existing scope task</span>
          <select
            value={draft.taskId}
            disabled={!draft.projectId}
            onChange={event => updateAssignmentDraft(key, { taskId: event.target.value })}
          >
            <option value="">Create or choose task</option>
            {(options?.tasks || []).map(task => (
              <option key={task.id} value={task.id}>
                {task.title} - {task.status.replace(/_/g, ' ')} / {task.verification_status.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>

        <label className="bt-invoice-field">
          <span>Scope section</span>
          <select
            value={draft.scopeId}
            disabled={!draft.projectId}
            onChange={event => updateAssignmentDraft(key, { scopeId: event.target.value })}
          >
            <option value="">No scope selected</option>
            {(options?.scopes || []).map(scope => (
              <option key={scope.id} value={scope.id}>{scope.section_name} - {scope.scope_title}</option>
            ))}
          </select>
        </label>

        <label className="bt-invoice-field">
          <span>New task if needed</span>
          <input
            value={draft.newTaskTitle}
            onChange={event => updateAssignmentDraft(key, { newTaskTitle: event.target.value })}
            placeholder={selectedProject ? `Task under ${selectedProject.job_name || selectedProject.address}` : 'Enter task name'}
          />
        </label>

        {includeInvoiceFields && (
          <>
            <label className="bt-invoice-field">
              <span>Vendor</span>
              <input
                value={draft.vendorName}
                onChange={event => updateAssignmentDraft(key, { vendorName: event.target.value })}
                placeholder="Vendor or sender"
              />
            </label>
            <label className="bt-invoice-field">
              <span>Invoice #</span>
              <input
                value={draft.externalInvoiceNumber}
                onChange={event => updateAssignmentDraft(key, { externalInvoiceNumber: event.target.value })}
                placeholder="Vendor invoice number"
              />
            </label>
            <label className="bt-invoice-field">
              <span>Amount</span>
              <input
                value={draft.total}
                onChange={event => updateAssignmentDraft(key, { total: event.target.value })}
                placeholder="0.00"
                inputMode="decimal"
              />
            </label>
          </>
        )}

        <button
          type="button"
          onClick={onSave}
          disabled={busy}
          className={`bt-invoice-save-button ${canSave ? '' : 'needs-input'}`}
          title={canSave ? saveLabel : 'Select a project and task, then assign this invoice'}
        >
          <ClipboardCheck className="h-4 w-4" />
          {busy ? 'Saving...' : saveLabel}
        </button>
      </div>
    );
  };

  if (loading) return <Loading />;

  return (
    <div className="bt-desktop-page bt-invoices-light min-h-full px-6 py-6 md:px-8">
      <div className="max-w-7xl mx-auto space-y-5">
        {canManageQuickBooks && (
          <section className="bt-invoice-section bt-qbo-mirror-section">
            <div className="bt-invoice-section-header">
              <div className="flex items-start gap-3">
                <div className="bt-invoice-icon bg-blue-50 text-blue-700">
                  <Receipt className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-xs font-black uppercase tracking-wide text-orange-300">QuickBooks Online source of truth</p>
                  <h2 className="text-lg font-black text-gray-900">QuickBooks Bills mirror</h2>
                  <p className="text-sm text-gray-600">
                    Bills entered in QuickBooks are mirrored here automatically. Accounting sync stays in the background.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <span className={`bt-invoice-filter ${quickBooksStatus?.connected ? 'is-active' : ''}`}>
                  {quickBooksStatus?.connected ? `${quickBooksStatus.connection?.company_name || 'QBO'} connected` : 'QBO not connected'}
                </span>
                {!quickBooksStatus?.connected && (
                  <button
                    type="button"
                    onClick={connectQuickBooks}
                    disabled={!quickBooksStatus?.configured}
                    className="bt-invoice-refresh"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Connect QuickBooks
                  </button>
                )}
              </div>
            </div>

            <div className="bt-qbo-status-row bt-qbo-kpi-row">
              <div>
                <span>Last sync</span>
                <strong>{quickBooksStatus?.connection?.last_sync_at ? formatEasternDateTime(quickBooksStatus.connection.last_sync_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not synced yet'}</strong>
                <small>{quickBooksStatus?.connection?.last_sync_status || 'Waiting'}</small>
              </div>
              <button
                type="button"
                onClick={() => setQuickBooksBillFilter('friday_queue')}
                className={quickBooksBillFilter === 'friday_queue' ? 'is-active' : ''}
              >
                <span>Approved bills</span>
                <strong>{approvedPaymentQueue.length}</strong>
                <small>{money(approvedPaymentTotal)} due</small>
              </button>
              <button
                type="button"
                onClick={() => setQuickBooksBillFilter('paid')}
                className={quickBooksBillFilter === 'paid' ? 'is-active' : ''}
              >
                <span>Paid bills</span>
                <strong>{paidQuickBooksBills.length}</strong>
                <small>{money(paidQuickBooksTotal)} paid</small>
              </button>
              <button
                type="button"
                onClick={() => setQuickBooksBillFilter('all')}
                className={quickBooksBillFilter === 'all' ? 'is-active' : ''}
              >
                <span>Total bills</span>
                <strong>{quickBooksStatus?.stats?.bill_count || allQuickBooksBills.length}</strong>
                <small>{openQuickBooksBills.length} open</small>
              </button>
            </div>

            <div className="bt-qbo-filter-row mx-4 mt-3 flex flex-wrap items-center gap-2">
              {([
                { key: 'open', tone: 'blue' },
                { key: 'friday_queue', tone: 'amber' },
                { key: 'paid', tone: 'emerald' },
                { key: 'all', tone: 'slate' },
              ] as const).map(option => {
                const meta = quickBooksBillFilterMeta[option.key];
                const active = quickBooksBillFilter === option.key;
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setQuickBooksBillFilter(option.key)}
                    className={`bt-invoice-filter ${active ? 'is-active' : ''}`}
                    aria-pressed={active}
                    data-tone={option.tone}
                  >
                    {meta.label}
                    <span className="ml-1 rounded-full bg-black/10 px-1.5 py-0.5 text-[10px] font-black">{meta.count}</span>
                  </button>
                );
              })}
            </div>

            {quickBooksStatus?.connection?.last_sync_error && (
              <div className="mt-3 mx-4 flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm font-semibold text-red-100">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>{quickBooksStatus.connection.last_sync_error}</span>
              </div>
            )}

            {quickBooksMirrorRows.length === 0 ? (
              <div className="bt-invoice-empty bt-qbo-table-empty">
                <Receipt className="mx-auto mb-3 h-8 w-8 text-blue-300" />
                <p className="text-sm font-bold text-gray-600">
                  No {selectedQuickBooksBillFilter.label.toLowerCase()} are showing right now.
                </p>
              </div>
            ) : (
              <div className="bt-qbo-table-shell">
                <div className="bt-qbo-table-title">
                  <div>
                    <span>{selectedQuickBooksBillFilter.title}</span>
                    <strong>{quickBooksMirrorRows.length} shown</strong>
                  </div>
                  <p>{selectedQuickBooksBillFilter.subtitle}</p>
                </div>
                <div className="bt-qbo-table-wrap">
                  <table className="bt-qbo-bill-table">
                    <thead>
                      <tr>
                        <th>Status</th>
                        <th>Vendor</th>
                        <th>Bill date</th>
                        <th>Due date</th>
                        <th>Bill amount</th>
                        <th>Open balance</th>
                        <th>BuildTrack match</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {quickBooksMirrorRows.map(({ bill, invoice }) => {
                        const isPaid = isQuickBooksBillPaid(bill);
                        const isApprovedForPay = bill.payment_approval_status === 'approved_for_payment' && !isPaid;
                        const localInvoiceMarkedPaid = Boolean(!isPaid && invoice && (invoice.status === 'paid' || invoice.quickbooks_payment_status === 'paid'));
                        const splitLines = quickBooksSplitLines(bill);
                        const splitLineCount = quickBooksSplitLineCount(bill);
                        const unmatchedSplitCount = quickBooksUnmatchedSplitLineCount(bill);
                        const splitMatched = quickBooksBillSplitMatched(bill);
                        const projectMatched = quickBooksBillHasApprovalMatch(bill, invoice);
                        const needsReview = !projectMatched && !isPaid;
                        const matchAddress = invoice?.address || bill.project_address || '';
                        const matchName = invoice?.job_name || bill.project_job_name || '';
                        const paidDateLabel = isPaid ? formatQuickBooksPaidDate(bill) : '';
                        return (
                          <tr key={bill.qbo_id} className={`${isPaid ? 'is-paid' : isApprovedForPay ? 'is-approved-for-pay' : 'is-unpaid'} ${needsReview ? 'needs-review' : ''}`}>
                            <td>
                              <span className={`bt-qbo-status-chip ${isPaid ? 'is-paid' : isApprovedForPay ? 'is-approved-for-pay' : 'is-unpaid'}`}>
                                {isApprovedForPay ? 'Queued' : qboStatusLabel(bill.payment_status)}
                              </span>
                              <small>QBO #{bill.doc_number || bill.qbo_id}</small>
                              {paidDateLabel ? <small>Paid: {paidDateLabel}</small> : null}
                              {isApprovedForPay ? <small>Pay run: Friday {qboPaymentRunLabel(bill)}</small> : null}
                              {localInvoiceMarkedPaid ? <small>BuildTrack marked paid; QBO still open</small> : null}
                            </td>
                            <td>
                              <strong>{bill.vendor_name || 'Vendor missing'}</strong>
                              {bill.private_note ? <small>{bill.private_note}</small> : null}
                              {splitLineCount > 1 ? <small>{splitLineCount} QBO class split lines</small> : null}
                            </td>
                            <td>{bill.txn_date ? formatDateOnly(bill.txn_date, { month: 'short', day: 'numeric', year: 'numeric' }) : '-'}</td>
                            <td>{bill.due_date ? formatDateOnly(bill.due_date, { month: 'short', day: 'numeric', year: 'numeric' }) : '-'}</td>
                            <td className="bt-qbo-money">{money(bill.total_amt || 0)}</td>
                            <td className="bt-qbo-money">{money(bill.balance || 0)}</td>
                            <td>
                              {splitLineCount > 0 ? (
                                <>
                                  <strong>{splitMatched ? `${splitLineCount} class splits matched` : `${unmatchedSplitCount} class split${unmatchedSplitCount === 1 ? '' : 's'} need match`}</strong>
                                  <small>Approval stays on one QBO balance</small>
                                  <div className="bt-qbo-split-list">
                                    {splitLines.map(line => (
                                      <div
                                        key={line.id || `${bill.qbo_id}-${line.qbo_line_id || line.line_num || line.description}`}
                                        className={`bt-qbo-split-line ${line.project_id ? 'is-matched' : 'needs-match'}`}
                                      >
                                        <div>
                                          <span>{line.description || `Line ${line.line_num || ''}`.trim() || 'Split line'}</span>
                                          <small>
                                            {line.class_name ? `QBO class: ${line.class_name}` : 'No QBO class'}
                                            {line.category_name ? ` | ${line.category_name}` : ''}
                                          </small>
                                          {line.project_id ? (
                                            <Link to={`/projects/${line.project_id}`}>
                                              {line.project_address || line.project_job_name || 'Open project'}
                                            </Link>
                                          ) : (
                                            <small>Project match needed</small>
                                          )}
                                        </div>
                                        <strong>{money(line.amount || 0)}</strong>
                                      </div>
                                    ))}
                                  </div>
                                </>
                              ) : invoice ? (
                                <>
                                  <strong>{invoice.external_invoice_number || invoice.invoice_number}</strong>
                                  <small>{matchAddress || matchName || 'Project linked'}</small>
                                  {bill.qbo_class_name ? <small>QBO class: {bill.qbo_class_name}</small> : null}
                                </>
                              ) : projectMatched ? (
                                <>
                                  <strong>Project matched</strong>
                                  <small>{matchAddress || matchName || 'Project linked from QuickBooks class'}</small>
                                  {bill.qbo_class_name ? <small>QBO class: {bill.qbo_class_name}</small> : null}
                                </>
                              ) : isPaid ? (
                                <>
                                  <strong>QuickBooks paid bill</strong>
                                  <small>Paid in QBO; no payment approval needed</small>
                                  {bill.qbo_class_name ? <small>QBO class: {bill.qbo_class_name}</small> : null}
                                </>
                              ) : (
                                <>
                                  <span className="bt-qbo-match-needed">Match needed</span>
                                  {bill.qbo_class_name ? <small>QBO class: {bill.qbo_class_name}</small> : null}
                                </>
                              )}
                            </td>
                            <td>
                              {projectMatched || isPaid ? (
                                <div className="bt-qbo-row-actions">
                                  {isPaid ? (
                                    <span className="bt-payment-run-chip is-paid">
                                      <CheckCircle2 className="h-3.5 w-3.5" />
                                      Paid in QBO
                                    </span>
                                  ) : isApprovedForPay ? (
                                    <span className="bt-payment-run-chip">
                                      <CalendarDays className="h-3.5 w-3.5" />
                                      Friday {qboPaymentRunLabel(bill)}
                                    </span>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => approveQuickBooksBillForPay(bill, invoice)}
                                      disabled={!canApproveQuickBooksBill(bill, invoice) || approvingQboBillId === bill.qbo_id}
                                      title={quickBooksApprovalBlockedReason(bill, invoice)}
                                      className="bt-approve-payment-button"
                                    >
                                      <CheckCircle2 className="h-4 w-4" />
                                      {approvingQboBillId === bill.qbo_id ? 'Approving...' : 'Approve for Pay'}
                                    </button>
                                  )}
                                  {invoice ? (
                                    <Link to={`/projects/${invoice.project_id}/invoices/${invoice.id}`}>Open invoice</Link>
                                  ) : bill.project_id ? (
                                    <Link to={`/projects/${bill.project_id}`}>Open project</Link>
                                  ) : splitLineCount > 0 ? (
                                    <span className="bt-qbo-split-summary-chip">{splitLineCount} project splits</span>
                                  ) : null}
                                </div>
                              ) : (
                                <span className="bt-qbo-unmatched">
                                  {splitLineCount > 0 ? 'Assign every class split' : 'Assign before approval'}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {quickBooksBillFilter !== 'paid' && quickBooksBillFilter !== 'all' && (
            <div className="bt-approved-pay-panel bt-approved-pay-panel--embedded">
              <div className="bt-approved-pay-header">
                <div>
                  <p className="text-xs font-black uppercase tracking-wide text-orange-300">Approved for payment</p>
                  <h2 className="text-lg font-black text-gray-900">Friday payment queue</h2>
                  <p className="text-sm text-gray-500">Approved invoices show here with the next biweekly Friday pay run.</p>
                </div>
                <div className="bt-approved-pay-actions">
                  <button
                    type="button"
                    onClick={notifyApprovedPaymentQueue}
                    disabled={!approvedPaymentQueue.length || notifyingPaymentQueue}
                    className="bt-approved-pay-notify-button"
                  >
                    <Mail className="h-4 w-4" />
                    {notifyingPaymentQueue ? 'Emailing...' : 'Done Approving - Email Management'}
                  </button>
                  <div className="bt-approved-pay-total">
                    <span>Total balance due</span>
                    <strong>{money(approvedPaymentTotal)}</strong>
                  </div>
                </div>
              </div>
              {approvedPaymentQueue.length === 0 ? (
                <div className="bt-approved-pay-empty">
                  <CheckCircle2 className="h-5 w-5" />
                  No invoices are currently approved for the next payment run.
                </div>
              ) : (
                <div className="bt-approved-pay-grid">
                  {approvedPaymentQueue.map(bill => {
                    const invoice = bill.matched_invoice_id ? invoiceById.get(bill.matched_invoice_id) || null : null;
                    const projectHref = invoice?.project_id
                      ? `/projects/${invoice.project_id}/invoices/${invoice.id}`
                      : bill.project_id
                        ? `/projects/${bill.project_id}`
                        : '/invoices';
                    return (
                    <article key={bill.qbo_id} className="bt-approved-pay-card">
                      <div className="bt-approved-pay-card-top">
                        <span>Approved</span>
                        <strong>{money(bill.balance || 0)}</strong>
                      </div>
                      <div className="bt-approved-pay-card-body">
                        <p className="bt-approved-pay-contractor">{bill.vendor_name || 'Vendor missing'}</p>
                        <p className="bt-approved-pay-meta">QBO #{bill.doc_number || bill.qbo_id}</p>
                        <p className="bt-approved-pay-project">{invoice?.address || bill.project_address || bill.project_job_name || 'Project not listed'}</p>
                        <p className="bt-approved-pay-meta">Pay run: Friday {qboPaymentRunLabel(bill)}</p>
                        <p className="bt-approved-pay-meta">
                          {bill.payment_approval_notified_at
                            ? `Management emailed ${formatEasternDateTime(bill.payment_approval_notified_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                            : 'Management email not sent yet'}
                        </p>
                      </div>
                      <div className="bt-approved-pay-card-bottom">
                        <button
                          type="button"
                          onClick={() => removeQuickBooksBillFromPay(bill)}
                          disabled={removingQboBillId === bill.qbo_id}
                        >
                          {removingQboBillId === bill.qbo_id ? 'Removing...' : 'Remove from queue'}
                        </button>
                        <Link to={projectHref}>Review</Link>
                      </div>
                    </article>
                    );
                  })}
                </div>
              )}
            </div>
            )}
          </section>
        )}

        {false && isAdminRole(user?.role || '') && (
          <section className="bt-invoice-section">
            <div className="bt-invoice-section-header">
              <div className="flex items-start gap-3">
                <div className="bt-invoice-icon bg-blue-50 text-blue-700">
                  <Mail className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-xs font-black uppercase tracking-wide text-blue-700">Auto invoice intake</p>
                  <h2 className="text-lg font-black text-gray-900">Incoming invoices from email</h2>
                  <p className="text-sm text-gray-600">
                    Auto-refreshes from invoices@newurbandev.com. File each invoice to a project and scope task before payment review.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {[
                  { value: 'new', label: 'Needs Assignment' },
                  { value: '', label: 'All' },
                  { value: 'filed', label: 'Filed' },
                  { value: 'ignored', label: 'Ignored' },
                ].map(option => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setEmailBoxStatus(option.value)}
                    className={`bt-invoice-filter ${emailBoxStatus === option.value ? 'is-active' : ''}`}
                  >
                    {option.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={loadEmailBox}
                  disabled={emailBoxLoading}
                  className="bt-invoice-refresh"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${emailBoxLoading ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
              </div>
            </div>

            {emailBoxLoading && emailBoxItems.length === 0 ? (
              <div className="bt-invoice-empty">Loading live invoice email queue...</div>
            ) : emailBoxItems.length === 0 ? (
              <div className="bt-invoice-empty">
                <Mail className="mx-auto mb-3 h-8 w-8 text-blue-300" />
                <p className="text-sm font-bold text-gray-600">No email invoices found for this filter</p>
              </div>
            ) : (
              <div className="bt-invoice-email-queue">
                {emailBoxItems.map(item => {
                  const itemAttachments = item.attachments || [];
                  const senderName = item.extracted_vendor || item.from_name || 'Contractor / sender not assigned';
                  const senderEmail = item.from_email || 'No origin email captured';
                  const isExpanded = Boolean(expandedEmailIds[item.id]);
                  const unfiledCount = item.unfiled_attachment_count ?? itemAttachments.filter(attachment => !attachment.filed_invoice_id).length;
                  const previewText = emailBodyPreview(item);
                  return (
                  <article key={item.id} className={`bt-invoice-intake-card ${isExpanded ? 'is-expanded' : ''}`}>
                    <div className={`bt-invoice-email-row ${isExpanded ? 'is-expanded' : ''}`}>
                      <div className="bt-invoice-email-row-status">
                        <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-black ${emailStatusClass[item.status] || emailStatusClass.new}`}>
                          {item.status === 'new' ? 'needs assignment' : item.status}
                        </span>
                        {item.agent_status ? <span className="bt-invoice-soft-chip">{item.agent_status.replace(/_/g, ' ')}</span> : null}
                      </div>
                      <div className="bt-invoice-email-row-cell">
                        <span>Sent from</span>
                        <strong>{senderName}</strong>
                        <small>{senderEmail}</small>
                      </div>
                      <div className="bt-invoice-email-row-cell bt-invoice-email-row-subject">
                        <span>Email subject</span>
                        <strong>{item.subject || '(no subject)'}</strong>
                        <small>{previewText || 'No email message body captured'}</small>
                      </div>
                      <div className="bt-invoice-email-row-cell">
                        <span>Received</span>
                        <strong>{formatEmailDate(item.received_at)}</strong>
                      </div>
                      <div className="bt-invoice-email-row-cell">
                        <span>Files</span>
                        <strong>{item.attachment_count || 0} file{Number(item.attachment_count || 0) === 1 ? '' : 's'}</strong>
                        <small>{unfiledCount > 0 ? `${unfiledCount} need assignment` : 'filed or no files'}</small>
                      </div>
                      <div className="bt-invoice-email-row-cell">
                        <span>Amount</span>
                        <strong>{item.extracted_amount ? money(item.extracted_amount) : '-'}</strong>
                        <small>{item.extracted_invoice_number ? `Invoice #${item.extracted_invoice_number}` : 'No invoice # captured'}</small>
                      </div>
                      <button
                        type="button"
                        onClick={() => toggleEmailExpanded(item.id)}
                        className={`bt-invoice-expand-button ${isExpanded ? 'is-expanded' : ''}`}
                        aria-expanded={isExpanded}
                        aria-controls={`invoice-email-detail-${item.id}`}
                      >
                        <ChevronRight className="h-4 w-4" />
                        {isExpanded ? 'Collapse' : 'Expand'}
                      </button>
                    </div>

                    {isExpanded && (
                      <div id={`invoice-email-detail-${item.id}`} className="bt-invoice-intake-detail">
                        <div className="bt-invoice-email-layout">
                          <div className="bt-invoice-email-content min-w-0">
                            <div className="bt-invoice-email-heading">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-black ${emailStatusClass[item.status] || emailStatusClass.new}`}>
                                    {item.status === 'new' ? 'needs assignment' : item.status}
                                  </span>
                                  <span className="text-xs font-semibold text-slate-300">{formatEmailDate(item.received_at)}</span>
                                  {item.agent_status ? <span className="bt-invoice-soft-chip">{item.agent_status.replace(/_/g, ' ')}</span> : null}
                                </div>
                                <p className="bt-invoice-origin-title">{item.subject || '(no subject)'}</p>
                              </div>
                              {item.status === 'ignored' ? (
                                <span className="bt-invoice-not-invoice-badge">Ignored in BuildTrack</span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => void markEmailNotInvoice(item)}
                                  disabled={ignoringEmailId === item.id}
                                  className="bt-invoice-not-invoice-button"
                                >
                                  <X className="h-3.5 w-3.5" />
                                  {ignoringEmailId === item.id ? 'Removing...' : 'Not an invoice'}
                                </button>
                              )}
                            </div>
                            <div className="bt-invoice-sender-panel">
                              <div>
                                <span>Contractor / sender</span>
                                <strong>{senderName}</strong>
                              </div>
                              <div>
                                <span>Email of origin</span>
                                <strong>{senderEmail}</strong>
                              </div>
                              <div>
                                <span>Received</span>
                                <strong>{formatEmailDate(item.received_at)}</strong>
                              </div>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-2 text-xs font-bold text-gray-600">
                              {item.extracted_invoice_number ? <span className="bt-invoice-soft-chip">Invoice #{item.extracted_invoice_number}</span> : null}
                              {item.extracted_amount ? <span className="bt-invoice-soft-chip">{money(item.extracted_amount)}</span> : null}
                              {item.matched_project_address ? (
                                <span className="bt-invoice-soft-chip text-blue-200">
                                  Suggested: {item.matched_project_address}
                                </span>
                              ) : null}
                            </div>
                            <div className="bt-invoice-email-attachments">
                              <span className="bt-invoice-attachments-label">Attachments</span>
                              {itemAttachments.map(attachment => (
                                <button
                                  key={attachment.id}
                                  type="button"
                                  onClick={() => setAttachmentPreview({ emailId: item.id, attachment })}
                                  className={`bt-invoice-attachment-button ${isPdfAttachment(attachment) ? 'is-pdf' : ''}`}
                                  title={`Preview ${attachment.original_name || 'attachment'}`}
                                >
                                  <span className="bt-invoice-attachment-type">{attachmentKindLabel(attachment)}</span>
                                  {isPdfAttachment(attachment) ? <FileText className="bt-invoice-attachment-file-icon w-3.5 h-3.5" /> : isImageAttachment(attachment) ? <ImageIcon className="w-3.5 h-3.5" /> : <Paperclip className="w-3.5 h-3.5" />}
                                  <span className="truncate">{attachment.original_name || 'Attachment'}</span>
                                  {formatBytes(attachment.size) ? <span className="bt-invoice-attachment-size">{formatBytes(attachment.size)}</span> : null}
                                  <Eye className="w-3.5 h-3.5" />
                                </button>
                              ))}
                              {itemAttachments.length === 0 && (
                                <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-bold text-slate-300">
                                  <Paperclip className="w-3.5 h-3.5" />
                                  No attachments
                                </span>
                              )}
                            </div>
                          </div>
                          <aside className="bt-invoice-message-preview" aria-label="Email message preview">
                            <div className="mb-2 flex items-center justify-between gap-3">
                              <p className="text-[11px] font-black uppercase tracking-wide">Email preview</p>
                              <span className="bt-invoice-soft-chip">{item.attachment_count || 0} file{Number(item.attachment_count || 0) === 1 ? '' : 's'}</span>
                            </div>
                            <div className="bt-invoice-message-scroll">
                              {previewText ? (
                                <p>{previewText}</p>
                              ) : (
                                <p className="opacity-70">No email message body was captured for this invoice email.</p>
                              )}
                            </div>
                          </aside>
                        </div>
                        {item.status === 'new' ? (
                          itemAttachments.length > 0 ? (
                            <div className="bt-invoice-attachment-assignments">
                              <div className="bt-invoice-attachment-assignments-header">
                                <div>
                                  <p>Project assignment</p>
                                  <span>{unfiledCount} attachment{Number(unfiledCount) === 1 ? '' : 's'} still need project assignment</span>
                                </div>
                              </div>
                              {itemAttachments.map(attachment => {
                                const attachmentKey = emailAttachmentDraftKey(item.id, attachment.id);
                                const projectName = attachment.filed_project_address || projects.find(project => project.id === attachment.filed_project_id)?.address || '';
                                return (
                                  <div key={attachment.id} className="bt-invoice-attachment-assignment-card">
                                    <div className="bt-invoice-attachment-assignment-title">
                                      <button
                                        type="button"
                                        onClick={() => setAttachmentPreview({ emailId: item.id, attachment })}
                                        className={`bt-invoice-attachment-button ${isPdfAttachment(attachment) ? 'is-pdf' : ''}`}
                                      >
                                        <span className="bt-invoice-attachment-type">{attachmentKindLabel(attachment)}</span>
                                        {isPdfAttachment(attachment) ? <FileText className="bt-invoice-attachment-file-icon w-3.5 h-3.5" /> : isImageAttachment(attachment) ? <ImageIcon className="w-3.5 h-3.5" /> : <Paperclip className="w-3.5 h-3.5" />}
                                        <span className="truncate">{attachment.original_name || 'Attachment'}</span>
                                        {formatBytes(attachment.size) ? <span className="bt-invoice-attachment-size">{formatBytes(attachment.size)}</span> : null}
                                        <Eye className="w-3.5 h-3.5" />
                                      </button>
                                      {attachment.filed_invoice_id ? (
                                        <span className="bt-invoice-assigned-chip">
                                          Assigned{projectName ? ` to ${projectName}` : ''}
                                        </span>
                                      ) : null}
                                    </div>
                                    {renderAssignmentControls(
                                      attachmentKey,
                                      () => fileEmailInvoice(item, attachment),
                                      'Assign to a Project',
                                      filingEmailId === `${item.id}:${attachment.id}`,
                                      true
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="mt-4 rounded-md border border-blue-900/70 bg-blue-950/30 p-3">
                              {renderAssignmentControls(emailDraftKey(item.id), () => fileEmailInvoice(item), 'Assign to a Project', filingEmailId === item.id, true)}
                            </div>
                          )
                        ) : null}
                      </div>
                    )}
                  </article>
                );
                })}
              </div>
            )}
          </section>
        )}

      </div>

      {attachmentPreview && (
        <div
          className="bt-invoice-attachment-modal"
          role="dialog"
          aria-modal="true"
          aria-label={`Preview ${attachmentPreview.attachment.original_name || 'invoice attachment'}`}
          onClick={() => setAttachmentPreview(null)}
        >
          <div className="bt-invoice-attachment-modal-panel" onClick={event => event.stopPropagation()}>
            <div className="bt-invoice-attachment-modal-header">
              <div className="min-w-0">
                <p className="text-[11px] font-black uppercase tracking-wide text-orange-300">Attachment preview</p>
                <h3 className="truncate text-base font-black text-gray-900">{attachmentPreview.attachment.original_name || 'Invoice attachment'}</h3>
                <p className="text-xs font-semibold text-gray-500">
                  {attachmentPreview.attachment.mime_type || 'Attachment'}
                  {formatBytes(attachmentPreview.attachment.size) ? ` - ${formatBytes(attachmentPreview.attachment.size)}` : ''}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={attachmentUrl(attachmentPreview.emailId, attachmentPreview.attachment.id)}
                  className="bt-invoice-modal-action"
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink className="h-4 w-4" />
                  Open
                </a>
                <button
                  type="button"
                  className="bt-invoice-modal-close"
                  onClick={() => setAttachmentPreview(null)}
                  aria-label="Close attachment preview"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <div className="bt-invoice-attachment-modal-body">
              {attachmentPreviewLoading ? (
                <div className="bt-invoice-attachment-fallback">
                  <FileText className="h-10 w-10" />
                  <p>Loading attachment preview...</p>
                </div>
              ) : attachmentPreviewError ? (
                <div className="bt-invoice-attachment-fallback">
                  <FileText className="h-10 w-10" />
                  <p>{attachmentPreviewError}</p>
                </div>
              ) : isImageAttachment(attachmentPreview.attachment) && attachmentPreviewUrl ? (
                <img
                  src={attachmentPreviewUrl}
                  alt={attachmentPreview.attachment.original_name || 'Invoice attachment'}
                />
              ) : isPdfAttachment(attachmentPreview.attachment) && attachmentPreviewUrl ? (
                <iframe
                  title={attachmentPreview.attachment.original_name || 'Invoice PDF attachment'}
                  src={attachmentPreviewUrl}
                />
              ) : (
                <div className="bt-invoice-attachment-fallback">
                  <FileText className="h-10 w-10" />
                  <p>This attachment type may not preview in the browser. Use Open to view or download it.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
