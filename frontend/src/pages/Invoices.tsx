import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../lib/api';
import { Loading } from '../components/ui';
import InvoiceMonitorPanel from '../components/InvoiceMonitorPanel';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  ExternalLink,
  FileText,
  Mail,
  Receipt,
  RefreshCw,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useAuthStore, isAdminRole } from '../store/authStore';
import toast from 'react-hot-toast';
import { formatDateOnly, formatEasternDate, formatEasternDateTime, formatEasternTime, parseBuildTrackTimestamp } from '../lib/time';

interface InvoicePdfSummary {
  available: boolean;
  source?: string | null;
  label?: string | null;
  id?: string | null;
  invoice_id?: string | null;
  project_id?: string | null;
  qbo_bill_id?: string | null;
  original_name?: string | null;
  mime_type?: string | null;
  size?: number | null;
  size_label?: string | null;
  uploaded_by_name?: string | null;
  created_at?: string | null;
  url?: string | null;
}

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
  invoice_pdf?: InvoicePdfSummary | null;
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
  bt_invoice_number?: string | null;
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
  vendor_email?: string | null;
  vendor_receipt_notify_status?: string | null;
  vendor_receipt_notified_at?: string | null;
  vendor_receipt_notified_email?: string | null;
  qbo_updated_at?: string | null;
  first_seen_at?: string | null;
  last_seen_at?: string | null;
  last_paid_at?: string | null;
  last_paid_seen_at?: string | null;
  last_paid_payment_id?: string | null;
  split_lines?: QuickBooksBillSplitLine[];
  split_line_count?: number;
  matched_split_line_count?: number;
  unmatched_split_line_count?: number;
  visible_split_lines?: QuickBooksBillSplitLine[];
  split_scope_line_id?: string | null;
  split_scope_project_id?: string | null;
  split_scope_parent_total?: number | null;
  split_scope_parent_balance?: number | null;
  invoice_pdf?: InvoicePdfSummary | null;
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
type QuickBooksInvoiceFilterMode = 'all' | 'project' | 'project_date_range' | 'project_specific_date' | 'vendor_only';
type QuickBooksInvoicePeriodMode = 'all_time' | 'year' | 'month' | 'day';
type QuickBooksInvoiceSortKey = 'status' | 'vendor' | 'bill_date' | 'due_date' | 'bill_amount' | 'open_balance';
type QuickBooksInvoiceSortDirection = 'asc' | 'desc';

interface QuickBooksInvoiceFilterState {
  mode: QuickBooksInvoiceFilterMode;
  projectId: string;
  vendor: string;
  startDate: string;
  endDate: string;
  exactDate: string;
}

interface QuickBooksInvoicePeriodState {
  mode: QuickBooksInvoicePeriodMode;
  day: string;
}

interface QuickBooksInvoiceSortState {
  key: QuickBooksInvoiceSortKey;
  direction: QuickBooksInvoiceSortDirection;
}

interface ProjectOption {
  id: string;
  address: string;
  job_name: string;
  status: string;
  updated_at?: string;
}

interface ContractorSupplierDirectoryRow {
  id: string;
  name?: string | null;
  vendor_name?: string | null;
  company?: string | null;
  contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  account_number?: string | null;
}

interface VendorSupplierFilterOption {
  label: string;
  aliases: string[];
}

interface QuickBooksMirrorRow {
  bill: QuickBooksBill;
  invoice: Invoice | null;
}

interface QuickBooksProjectSpendSummary {
  projectLabel: string;
  classLabel: string;
  billCount: number;
  paidBillCount: number;
  unpaidBillCount: number;
  paidTotal: number;
  unpaidTotal: number;
  total: number;
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
  agent_status?: string;
  provider?: string | null;
  agent_model?: string | null;
  extracted_vendor?: string | null;
  extracted_invoice_number?: string | null;
  extracted_amount?: number | null;
  extracted_summary?: string | null;
  matched_project_id?: string | null;
  match_confidence?: number | null;
  matched_project_address?: string | null;
  matched_project_job_name?: string | null;
  agent_notes?: string | null;
  ai_error?: string | null;
  ai_items?: InvoiceInboxAiItem[];
}

const OPEN_AI_STATUSES = new Set(['needs_project', 'needs_review']);
const isOpenAiItem = (item?: InvoiceInboxAiItem | null) => Boolean(item && !item.invoice_id && OPEN_AI_STATUSES.has(item.status));

const QBO_STATUS_LABELS: Record<string, string> = {
  matched: 'Matches QuickBooks',
  matched_split: 'Matches QuickBooks',
  partially_entered: 'Partly in QuickBooks',
  waiting_for_quickbooks: 'Waiting for QuickBooks',
  not_in_quickbooks: 'Not in QuickBooks',
  amount_mismatch: 'Amount differs',
  over_entered: 'More in QuickBooks',
};

// "2811 Wisconsin Rd, Troy, MI 48083, USA" -> "2811 Wisconsin Rd, Troy"
const shortAddress = (value?: string | null) => String(value || '').split(',').slice(0, 2).join(',').trim();

// One invoice the invoice inbox agent found in an email (invoice_inbox_items).
interface InvoiceInboxAiItem {
  id: string;
  status: 'filed' | 'needs_project' | 'needs_review' | 'duplicate' | 'filed_by_office' | 'not_invoice' | string;
  reason?: string | null;
  vendor_name?: string | null;
  vendor_created?: number | null;
  invoice_number?: string | null;
  invoice_date?: string | null;
  invoice_type?: string | null;
  category?: string | null;
  total?: number | null;
  project_id?: string | null;
  project_address?: string | null;
  invoice_id?: string | null;
  bt_invoice_number?: string | null;
  bt_total?: number | null;
  source_attachment_id?: string | null;
  source_attachment_name?: string | null;
  qbo_status?: string | null;
  qbo_summary?: string | null;
  suggestions?: InvoiceProjectSuggestion[];
}

// Where QuickBooks points for an invoice that waits for a project: a bill the office
// already entered for it, or the vendor's recent classes.
interface InvoiceProjectSuggestion {
  project_id: string;
  address: string;
  class_name?: string | null;
  source: 'quickbooks_bill' | 'vendor_history' | string;
  qbo_bill_id?: string | null;
  bill_date?: string | null;
  amount?: number | null;
}

// The review queue: the project, plus what the AI could not read.
interface QueueDraft {
  projectId: string;
  vendorName: string;
  total: string;
  invoiceNumber: string;
}

const EMPTY_QUEUE_DRAFT: QueueDraft = { projectId: '', vendorName: '', total: '', invoiceNumber: '' };

interface QueueRow {
  key: string;
  email: InvoiceEmailItem;
  item: InvoiceInboxAiItem | null;
}

interface AttachmentPreviewState {
  emailId: string;
  attachment: InvoiceEmailAttachment;
}

interface InvoicePdfPreviewState {
  title: string;
  filename?: string | null;
  url: string;
  mime_type?: string | null;
  size_label?: string | null;
  page: number;
  zoom: number;
}

const money = (value: number) =>
  Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const formatBytes = (value?: number) => {
  const size = Number(value || 0);
  if (!size) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
};

const invoicePdfDownloadName = (filename?: string | null) => {
  const raw = String(filename || 'invoice').trim() || 'invoice';
  const base = raw
    .replace(/\.pdf$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'invoice';
  const limited = base.length > 170 ? base.slice(0, 170).trim() : base;
  return `${limited.replace(/\.+$/, '') || 'invoice'}.pdf`;
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

const isImagePreviewFile = (mimeType?: string | null, filename?: string | null) =>
  Boolean(
    String(mimeType || '').toLowerCase().startsWith('image/') ||
    /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i.test(String(filename || ''))
  );

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

const AI_ITEM_LABELS: Record<string, string> = {
  filed: 'Filed by AI',
  needs_project: 'Project not identified',
  needs_review: 'Needs a person',
  duplicate: 'Duplicate - not added',
  filed_by_office: 'Filed by office',
  not_invoice: 'Not an invoice',
};

const AI_INVOICE_TYPE_LABELS: Record<string, string> = {
  labor: 'Labor',
  materials: 'Materials',
  labor_and_materials: 'Labor & materials',
  equipment_rental: 'Equipment rental',
  permit_or_fee: 'Permit / fee',
  utility: 'Utility',
  professional_service: 'Professional service',
  other: 'Other',
};

const QUICKBOOKS_PANEL_ROLES = ['super_admin', 'operations_manager'];
const QUICKBOOKS_BILLS_PATH = '/quickbooks/bills?limit=1000';
const QUICKBOOKS_APPROVED_FOR_PAYMENT_STATUS = 'approved_for_payment';
const QUICKBOOKS_BUILDTRACK_PAID_STATUS = 'paid_from_buildtrack';
const DEFAULT_QUICKBOOKS_INVOICE_FILTER: QuickBooksInvoiceFilterState = {
  mode: 'all',
  projectId: '',
  vendor: '',
  startDate: '',
  endDate: '',
  exactDate: '',
};
const quickBooksTodayDateValue = () => {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};
const DEFAULT_QUICKBOOKS_INVOICE_PERIOD: QuickBooksInvoicePeriodState = {
  mode: 'year',
  day: quickBooksTodayDateValue(),
};
const DEFAULT_QUICKBOOKS_INVOICE_SORT: QuickBooksInvoiceSortState = {
  key: 'bill_date',
  direction: 'desc',
};
const DEFAULT_QUICKBOOKS_AWAITING_APPROVAL_SORT: QuickBooksInvoiceSortState = {
  key: 'bill_date',
  direction: 'asc',
};
// Project is the anchor: pick one and every bill on it shows at once. Vendor /
// supplier and the date pickers only NARROW that list when filled in - an empty
// vendor means "all vendors on this project", not "not ready yet". The old
// "Project + Vendor" modes existed only to reveal the vendor picker; it is now
// available under every project mode, so they collapsed into these.
const QUICKBOOKS_INVOICE_FILTER_OPTIONS: { value: QuickBooksInvoiceFilterMode; label: string }[] = [
  { value: 'all', label: 'No project filter' },
  { value: 'project', label: 'Project + Vendor / Suppliers' },
  { value: 'project_date_range', label: 'Project + Vendor / Suppliers + date range' },
  { value: 'project_specific_date', label: 'Project + specific date' },
  { value: 'vendor_only', label: 'Vendor / Suppliers Only' },
];
const QUICKBOOKS_FILTER_PROJECT_MODES = new Set<QuickBooksInvoiceFilterMode>(['project', 'project_date_range', 'project_specific_date']);
const QUICKBOOKS_FILTER_VENDOR_MODES = new Set<QuickBooksInvoiceFilterMode>(['project', 'project_date_range', 'project_specific_date', 'vendor_only']);
const QUICKBOOKS_FILTER_DATE_RANGE_MODES = new Set<QuickBooksInvoiceFilterMode>(['project_date_range']);
const QUICKBOOKS_FILTER_EXACT_DATE_MODES = new Set<QuickBooksInvoiceFilterMode>(['project_specific_date']);
const DEFAULT_QUICKBOOKS_INVOICE_YEAR = new Date().getFullYear();
const DEFAULT_QUICKBOOKS_INVOICE_MONTH = quickBooksTodayDateValue().slice(0, 7);
const QUICKBOOKS_INVOICE_PERIOD_OPTIONS: { value: QuickBooksInvoicePeriodMode; label: string }[] = [
  { value: 'year', label: `Current year (${DEFAULT_QUICKBOOKS_INVOICE_YEAR})` },
  { value: 'all_time', label: 'All time' },
  { value: 'month', label: 'Current month' },
  { value: 'day', label: 'Specific day' },
];

const qboStatusLabel = (status?: string | null) => {
  const value = String(status || 'unpaid').toLowerCase();
  if (value === 'paid') return 'Paid in Full';
  if (value === 'partial') return 'Partial';
  return 'Unpaid';
};

const isQuickBooksBillPaid = (bill?: QuickBooksBill | null) => (
  String(bill?.payment_status || '').toLowerCase() === 'paid'
  || Number(bill?.balance || 0) <= 0
);

const isQuickBooksBillBuildTrackPaid = (bill?: QuickBooksBill | null) => (
  bill?.payment_approval_status === QUICKBOOKS_BUILDTRACK_PAID_STATUS
);

const quickBooksBillDateKey = (bill?: QuickBooksBill | null) => (
  String(bill?.txn_date || bill?.due_date || bill?.qbo_updated_at || bill?.last_seen_at || '')
);

const sortQuickBooksBillsByBillDate = (bills: QuickBooksBill[], direction: QuickBooksInvoiceSortDirection = 'desc') => [...bills].sort((a, b) => {
  const dateCompare = quickBooksBillDateKey(a).localeCompare(quickBooksBillDateKey(b));
  if (dateCompare !== 0) return direction === 'asc' ? dateCompare : -dateCompare;
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
    || bill?.txn_date
    || bill?.due_date
    || bill?.last_paid_seen_at
    || bill?.qbo_updated_at
    || bill?.last_seen_at
    || ''
  )
);

const quickBooksInvoiceDateEnteredValue = (bill?: QuickBooksBill | null, invoice?: Invoice | null) => (
  bill?.first_seen_at || invoice?.created_at || bill?.last_seen_at || bill?.qbo_updated_at || bill?.txn_date || bill?.due_date || ''
);

const quickBooksInvoiceDateEnteredSortValue = (bill?: QuickBooksBill | null, invoice?: Invoice | null) => (
  quickBooksDateRank(quickBooksInvoiceDateEnteredValue(bill, invoice))
);

const formatQuickBooksPaidDate = (bill?: QuickBooksBill | null) => {
  const value = bill?.last_paid_at || bill?.last_paid_seen_at || bill?.qbo_updated_at || bill?.last_seen_at || '';
  if (!value) return '';
  return /[T:]/.test(value)
    ? formatEasternDateTime(value, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : formatDateOnly(value, { month: 'short', day: 'numeric', year: 'numeric' });
};

const formatQuickBooksDeiDate = (bill?: QuickBooksBill | null, invoice?: Invoice | null) => {
  const value = quickBooksInvoiceDateEnteredValue(bill, invoice);
  return value ? formatDateOnly(value, { month: 'short', day: 'numeric', year: 'numeric' }) : '-';
};

const quickBooksSplitLines = (bill: QuickBooksBill) => (
  Array.isArray(bill.split_lines) ? bill.split_lines : []
);

const quickBooksVisibleSplitLines = (bill: QuickBooksBill) => (
  Array.isArray(bill.visible_split_lines) ? bill.visible_split_lines : quickBooksSplitLines(bill)
);

const quickBooksDateOnly = (value?: string | null) => {
  const text = String(value || '').trim();
  if (!text) return '';
  const isoMatch = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  const parsed = parseBuildTrackTimestamp(text) || new Date(text);
  if (!Number.isFinite(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
};

const quickBooksFilterText = (value?: string | null) => String(value || '').trim().toLowerCase();

const vendorSupplierAliasCandidates = (row: ContractorSupplierDirectoryRow) => (
  [
    row.vendor_name,
    row.name,
    row.company,
    row.contact_name,
    row.email,
    row.phone,
    row.account_number,
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean)
);

const quickBooksBillFilterDate = (bill: QuickBooksBill) => (
  quickBooksDateOnly(bill.txn_date || bill.due_date || bill.qbo_updated_at || bill.last_seen_at)
);

const quickBooksBillMatchesYear = (bill: QuickBooksBill, year: number) => {
  const billDate = quickBooksBillFilterDate(bill);
  return Boolean(billDate && Number(billDate.slice(0, 4)) === year);
};

const quickBooksBillMatchesPeriod = (bill: QuickBooksBill, period: QuickBooksInvoicePeriodState) => {
  if (period.mode === 'all_time') return true;
  const billDate = quickBooksBillFilterDate(bill);
  if (!billDate) return false;
  if (period.mode === 'year') return quickBooksBillMatchesYear(bill, DEFAULT_QUICKBOOKS_INVOICE_YEAR);
  if (period.mode === 'month') return billDate.startsWith(DEFAULT_QUICKBOOKS_INVOICE_MONTH);
  return billDate === (period.day || quickBooksTodayDateValue());
};

const quickBooksPeriodDateLabel = (dateValue: string) => (
  dateValue
    ? formatDateOnly(`${dateValue}T12:00:00`, { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Selected day'
);

const quickBooksBillDueDateKey = (bill?: QuickBooksBill | null) => String(bill?.due_date || '');

const quickBooksInvoiceRowTieBreak = (a: QuickBooksMirrorRow, b: QuickBooksMirrorRow) => {
  const billDateCompare = quickBooksDateRank(quickBooksBillDateKey(b.bill)) - quickBooksDateRank(quickBooksBillDateKey(a.bill));
  if (billDateCompare !== 0) return billDateCompare;
  const vendorCompare = String(a.bill.vendor_name || '').localeCompare(String(b.bill.vendor_name || ''));
  if (vendorCompare !== 0) return vendorCompare;
  return String(a.bill.doc_number || a.bill.qbo_id || '').localeCompare(String(b.bill.doc_number || b.bill.qbo_id || ''));
};

const quickBooksInvoiceTextSortValue = (value?: string | null) => (
  String(value || '').trim().toLocaleLowerCase()
);

const quickBooksInvoiceMoneySortValue = (value?: number | null) => {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount : 0;
};

const quickBooksMoneyAmount = (value?: number | null) => {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount : 0;
};

const quickBooksProjectLineOpenBalance = (bill: QuickBooksBill, lineAmount: number) => {
  if (isQuickBooksBillPaid(bill)) return 0;
  const amount = Math.max(quickBooksMoneyAmount(lineAmount), 0);
  const parentTotal = Math.max(quickBooksMoneyAmount(bill.total_amt), 0);
  const parentBalance = Math.max(quickBooksMoneyAmount(bill.balance), 0);
  if (!amount || !parentBalance) return 0;
  if (parentTotal > 0 && parentBalance < parentTotal) {
    return Math.min(amount, parentBalance * (amount / parentTotal));
  }
  return amount;
};

const quickBooksBillSpendAmounts = (bill: QuickBooksBill) => {
  const total = Math.max(quickBooksMoneyAmount(bill.total_amt), 0);
  const unpaid = Math.min(total, Math.max(quickBooksMoneyAmount(bill.balance), 0));
  return {
    paid: Math.max(total - unpaid, 0),
    unpaid,
    total,
  };
};

const sortQuickBooksInvoiceRows = (
  rows: QuickBooksMirrorRow[],
  sortState: QuickBooksInvoiceSortState | null
) => {
  if (!sortState) return rows;
  return [...rows].sort((a, b) => {
    let compare = 0;
    if (sortState.key === 'status') {
      compare = quickBooksInvoiceDateEnteredSortValue(a.bill, a.invoice) - quickBooksInvoiceDateEnteredSortValue(b.bill, b.invoice);
    } else if (sortState.key === 'vendor') {
      compare = quickBooksInvoiceTextSortValue(a.bill.vendor_name).localeCompare(quickBooksInvoiceTextSortValue(b.bill.vendor_name));
    } else if (sortState.key === 'bill_date') {
      compare = quickBooksDateRank(quickBooksBillDateKey(a.bill)) - quickBooksDateRank(quickBooksBillDateKey(b.bill));
    } else if (sortState.key === 'due_date') {
      compare = quickBooksDateRank(quickBooksBillDueDateKey(a.bill)) - quickBooksDateRank(quickBooksBillDueDateKey(b.bill));
    } else if (sortState.key === 'bill_amount') {
      compare = quickBooksInvoiceMoneySortValue(a.bill.total_amt) - quickBooksInvoiceMoneySortValue(b.bill.total_amt);
    } else {
      compare = quickBooksInvoiceMoneySortValue(a.bill.balance) - quickBooksInvoiceMoneySortValue(b.bill.balance);
    }
    if (sortState.direction === 'desc') compare *= -1;
    return compare || quickBooksInvoiceRowTieBreak(a, b);
  });
};

const quickBooksBillProjectIds = (bill: QuickBooksBill, invoice?: Invoice | null) => {
  const ids = new Set<string>();
  if (invoice?.project_id) ids.add(invoice.project_id);
  if (bill.project_id) ids.add(bill.project_id);
  quickBooksSplitLines(bill).forEach(line => {
    if (line.project_id) ids.add(line.project_id);
  });
  return ids;
};

const quickBooksBillMatchesProject = (bill: QuickBooksBill, invoice: Invoice | null, projectId: string) => (
  !projectId || quickBooksBillProjectIds(bill, invoice).has(projectId)
);

const quickBooksBillMatchesVendorSupplier = (
  bill: QuickBooksBill,
  vendor: string,
  vendorSupplierAliasMap?: Map<string, Set<string>>
) => {
  if (!vendor) return true;
  const billVendor = quickBooksFilterText(bill.vendor_name);
  const selectedVendor = quickBooksFilterText(vendor);
  if (!billVendor || !selectedVendor) return false;
  if (billVendor === selectedVendor) return true;
  return vendorSupplierAliasMap?.get(selectedVendor)?.has(billVendor) || false;
};

const quickBooksBillMatchesDateRange = (bill: QuickBooksBill, startDate: string, endDate: string) => {
  const billDate = quickBooksBillFilterDate(bill);
  if (!billDate) return false;
  if (startDate && billDate < startDate) return false;
  if (endDate && billDate > endDate) return false;
  return true;
};

const quickBooksBillMatchesExactDate = (bill: QuickBooksBill, exactDate: string) => (
  !exactDate || quickBooksBillFilterDate(bill) === exactDate
);

const quickBooksBillMatchesStatusFilter = (bill: QuickBooksBill, filter: QuickBooksBillFilter) => {
  const paid = isQuickBooksBillPaid(bill);
  const buildTrackPaid = isQuickBooksBillBuildTrackPaid(bill);
  // QuickBooks is the accounting source of truth. A local "paid" marker must
  // never hide a balance that QuickBooks still reports as open.
  if (filter === 'paid') return paid;
  if (filter === 'friday_queue') return !paid && !buildTrackPaid && bill.payment_approval_status === QUICKBOOKS_APPROVED_FOR_PAYMENT_STATUS;
  if (filter === 'open') return !paid && bill.payment_approval_status !== QUICKBOOKS_APPROVED_FOR_PAYMENT_STATUS;
  return true;
};

const quickBooksBillScopedToProject = (
  bill: QuickBooksBill,
  invoice: Invoice | null,
  projectId: string
) => {
  if (!projectId) return [bill];
  const splitLines = quickBooksSplitLines(bill);
  if (!splitLines.length) return quickBooksBillMatchesProject(bill, invoice, projectId) ? [bill] : [];

  const matchingLines = splitLines.filter(line => line.project_id === projectId);
  if (!matchingLines.length) return [];

  const paid = isQuickBooksBillPaid(bill);
  return matchingLines.map((line, index) => {
    const lineAmount = Number(line.amount || 0);
    const lineOpenBalance = quickBooksProjectLineOpenBalance(bill, lineAmount);
    return {
      ...bill,
      total_amt: lineAmount,
      balance: paid ? 0 : lineOpenBalance,
      project_id: line.project_id || bill.project_id || null,
      project_address: line.project_address || bill.project_address || null,
      project_job_name: line.project_job_name || bill.project_job_name || null,
      qbo_class_id: line.class_id || bill.qbo_class_id || null,
      qbo_class_name: line.class_name || bill.qbo_class_name || null,
      visible_split_lines: [line],
      split_scope_line_id: line.id || line.qbo_line_id || `${bill.qbo_id}:${line.line_num || index + 1}`,
      split_scope_project_id: line.project_id || null,
      split_scope_parent_total: Number(bill.total_amt || 0),
      split_scope_parent_balance: Number(bill.balance || 0),
    };
  });
};

const quickBooksBillMatchesInvoiceFilter = (
  bill: QuickBooksBill,
  invoice: Invoice | null,
  filter: QuickBooksInvoiceFilterState,
  vendorSupplierAliasMap?: Map<string, Set<string>>
) => {
  if (filter.mode === 'all') return true;
  // Anchors gate; narrowers only apply once filled in.
  if (QUICKBOOKS_FILTER_PROJECT_MODES.has(filter.mode)) {
    if (!filter.projectId) return false;
    if (!quickBooksBillMatchesProject(bill, invoice, filter.projectId)) return false;
  }
  if (QUICKBOOKS_FILTER_VENDOR_MODES.has(filter.mode)) {
    if (filter.vendor) {
      if (!quickBooksBillMatchesVendorSupplier(bill, filter.vendor, vendorSupplierAliasMap)) return false;
    } else if (filter.mode === 'vendor_only') {
      return false; // nothing else anchors this mode
    }
  }
  if (QUICKBOOKS_FILTER_DATE_RANGE_MODES.has(filter.mode) && (filter.startDate || filter.endDate)) {
    if (!quickBooksBillMatchesDateRange(bill, filter.startDate, filter.endDate)) return false;
  }
  if (QUICKBOOKS_FILTER_EXACT_DATE_MODES.has(filter.mode) && filter.exactDate) {
    if (!quickBooksBillMatchesExactDate(bill, filter.exactDate)) return false;
  }
  return true;
};

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
  const [queueDrafts, setQueueDrafts] = useState<Record<string, QueueDraft>>({});
  const [assigningItemId, setAssigningItemId] = useState<string | null>(null);
  const [ignoringEmailId, setIgnoringEmailId] = useState<string | null>(null);
  const [rereadingEmailId, setRereadingEmailId] = useState<string | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreviewState | null>(null);
  const [attachmentPreviewUrl, setAttachmentPreviewUrl] = useState('');
  const [attachmentPreviewLoading, setAttachmentPreviewLoading] = useState(false);
  const [attachmentPreviewError, setAttachmentPreviewError] = useState('');
  const [qboPdfPreview, setQboPdfPreview] = useState<InvoicePdfPreviewState | null>(null);
  const [qboPdfPreviewUrl, setQboPdfPreviewUrl] = useState('');
  const [qboPdfPreviewLoading, setQboPdfPreviewLoading] = useState(false);
  const [qboPdfPreviewError, setQboPdfPreviewError] = useState('');
  const [quickBooksStatus, setQuickBooksStatus] = useState<QuickBooksStatus | null>(null);
  const [quickBooksBills, setQuickBooksBills] = useState<QuickBooksBill[]>([]);
  const [contractorSupplierDirectory, setContractorSupplierDirectory] = useState<ContractorSupplierDirectoryRow[]>([]);
  const [quickBooksBillFilter, setQuickBooksBillFilter] = useState<QuickBooksBillFilter>('open');
  const deferredQuickBooksBillFilter = useDeferredValue(quickBooksBillFilter);
  const [quickBooksInvoiceFilter, setQuickBooksInvoiceFilter] = useState<QuickBooksInvoiceFilterState>({ ...DEFAULT_QUICKBOOKS_INVOICE_FILTER });
  const [quickBooksInvoicePeriod, setQuickBooksInvoicePeriod] = useState<QuickBooksInvoicePeriodState>({ ...DEFAULT_QUICKBOOKS_INVOICE_PERIOD });
  const [quickBooksInvoiceSort, setQuickBooksInvoiceSort] = useState<QuickBooksInvoiceSortState | null>(null);
  const [approvingQboBillId, setApprovingQboBillId] = useState<string | null>(null);
  const [removingQboBillId, setRemovingQboBillId] = useState<string | null>(null);
  const [markingQboPaidId, setMarkingQboPaidId] = useState<string | null>(null);
  const [deletingQboBillId, setDeletingQboBillId] = useState<string | null>(null);
  const [sendingPayDateQboBillId, setSendingPayDateQboBillId] = useState<string | null>(null);
  const [expandedSplitBills, setExpandedSplitBills] = useState<Record<string, boolean>>({});
  const toggleSplitExpanded = (key: string) => setExpandedSplitBills(prev => ({ ...prev, [key]: !prev[key] }));
  const [uploadingQboBillPdfId, setUploadingQboBillPdfId] = useState<string | null>(null);
  const [draggingQboBillPdfId, setDraggingQboBillPdfId] = useState<string | null>(null);
  const [notifyingPaymentQueue, setNotifyingPaymentQueue] = useState(false);
  const [queueCheckedAt, setQueueCheckedAt] = useState<string | null>(null);
  const [checkingPaymentQueue, setCheckingPaymentQueue] = useState(false);
  const canReadQuickBooksStatus = isAdminRole(user?.role || '');
  const canManageQuickBooks = Boolean(user?.role && QUICKBOOKS_PANEL_ROLES.includes(user.role));
  // Project managers can VIEW the invoice center; every mutation stays behind
  // canManageQuickBooks (and the backend enforces the same split).
  const canViewQuickBooks = isAdminRole(user?.role || '');

  const load = async () => {
    setLoading(true);
    try {
      const [projectRes, invoiceRes, qboStatusRes, qboBillsRes, contractorSupplierRes] = await Promise.all([
        api.get('/projects'),
        api.get('/invoices'),
        canReadQuickBooksStatus ? api.get('/quickbooks/status').catch(() => ({ data: null })) : Promise.resolve({ data: null }),
        canViewQuickBooks
          ? api.get(QUICKBOOKS_BILLS_PATH).catch(() => ({ data: [] }))
          : Promise.resolve({ data: [] }),
        canViewQuickBooks
          ? api.get('/users/contractors/directory').catch(() => ({ data: { contractors: [] } }))
          : Promise.resolve({ data: { contractors: [] } }),
      ]);
      setProjects(Array.isArray(projectRes.data) ? projectRes.data : []);
      setInvoices(Array.isArray(invoiceRes.data) ? invoiceRes.data : []);
      setQuickBooksStatus(qboStatusRes.data || null);
      setQuickBooksBills(Array.isArray(qboBillsRes.data) ? qboBillsRes.data : []);
      setContractorSupplierDirectory(Array.isArray(contractorSupplierRes.data?.contractors) ? contractorSupplierRes.data.contractors : []);
    } catch {
      toast.error('Failed to load invoices');
    } finally {
      setLoading(false);
    }
  };

  // Background refresh (no page spinner). A request that fails keeps what is on
  // screen: the old poll replaced the QuickBooks list with [] on any error, which
  // blanked the queue until the next poll. With recheckQueue, admins first have
  // BuildTrack re-read the queued bills from QuickBooks, so a bill paid there a
  // moment ago leaves the Friday queue now rather than after the next full sync
  // plus the next poll (up to two minutes).
  const refreshInvoiceData = async ({
    recheckQueue = false,
    announce = false,
    onlyIfQueueChanged = false,
  }: { recheckQueue?: boolean; announce?: boolean; onlyIfQueueChanged?: boolean } = {}) => {
    let nowPaid = 0;
    let recheckFailed = false;
    if (recheckQueue && canManageQuickBooks) {
      try {
        const res = await api.post('/quickbooks/payment-queue/recheck');
        setQueueCheckedAt(res.data?.checked_at || new Date().toISOString());
        nowPaid = Array.isArray(res.data?.now_paid) ? res.data.now_paid.length : 0;
      } catch (err: any) {
        recheckFailed = true;
        if (announce) toast.error(err.response?.data?.error || 'Could not reach QuickBooks to re-check the queue');
      }
    }
    if (!onlyIfQueueChanged || nowPaid > 0) {
      const [invoiceRes, qboStatusRes, qboBillsRes] = await Promise.all([
        api.get('/invoices').catch(() => null),
        canReadQuickBooksStatus ? api.get('/quickbooks/status').catch(() => null) : Promise.resolve(null),
        canViewQuickBooks ? api.get(QUICKBOOKS_BILLS_PATH).catch(() => null) : Promise.resolve(null),
      ]);
      if (Array.isArray(invoiceRes?.data)) setInvoices(invoiceRes.data);
      if (qboStatusRes?.data) setQuickBooksStatus(qboStatusRes.data);
      if (Array.isArray(qboBillsRes?.data)) setQuickBooksBills(qboBillsRes.data);
    }
    if (announce && !recheckFailed) {
      toast.success(nowPaid
        ? `${nowPaid} invoice${nowPaid === 1 ? '' : 's'} paid in QuickBooks; moved to Paid in Full`
        : 'The Friday queue matches QuickBooks');
    }
  };
  // Timers and window listeners below call the latest render's function.
  const refreshInvoiceDataRef = useRef(refreshInvoiceData);
  refreshInvoiceDataRef.current = refreshInvoiceData;

  const checkPaymentQueueNow = async () => {
    if (checkingPaymentQueue) return;
    setCheckingPaymentQueue(true);
    try {
      await refreshInvoiceData({ recheckQueue: true, announce: true });
    } finally {
      setCheckingPaymentQueue(false);
    }
  };

  const updateQueueDraft = (itemId: string, patch: Partial<QueueDraft>) => {
    setQueueDrafts(current => ({ ...current, [itemId]: { ...(current[itemId] || EMPTY_QUEUE_DRAFT), ...patch } }));
  };

  const loadEmailBox = async () => {
    setEmailBoxLoading(true);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (emailBoxStatus) params.set('status', emailBoxStatus);
      const res = await api.get(`/invoices/email-intake?${params}`);
      const rows: InvoiceEmailItem[] = Array.isArray(res.data) ? res.data : [];
      setEmailBoxItems(rows);
      // A bill the office already entered for this very invoice picks the project;
      // several (the monitor could not choose) leave it to the person.
      setQueueDrafts(current => {
        const next = { ...current };
        rows.flatMap(row => row.ai_items || []).filter(isOpenAiItem).forEach(ai => {
          if (next[ai.id]) return;
          const fromBills = (ai.suggestions || []).filter(s => s.source === 'quickbooks_bill');
          next[ai.id] = {
            projectId: fromBills.length === 1 ? fromBills[0].project_id : '',
            vendorName: '',
            total: '',
            invoiceNumber: '',
          };
        });
        return next;
      });
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to load live invoice email box');
    } finally {
      setEmailBoxLoading(false);
    }
  };

  // What still has to be typed before an invoice can be filed (only what the AI could not read).
  const queueNeeds = (item: InvoiceInboxAiItem) => ({
    vendor: !String(item.vendor_name || '').trim(),
    total: !(Number(item.total) > 0),
  });

  const assignQueueItem = async (email: InvoiceEmailItem, item: InvoiceInboxAiItem) => {
    const draft = queueDrafts[item.id];
    const needs = queueNeeds(item);
    if (!draft?.projectId) return toast.error('Choose the project');
    if (needs.vendor && !draft.vendorName.trim()) return toast.error('Enter the vendor');
    if (needs.total && !(Number(draft.total.replace(/[$,\s]/g, '')) > 0)) return toast.error('Enter the amount');
    setAssigningItemId(item.id);
    try {
      const res = await api.post(`/invoices/email-intake/${email.id}/items/${item.id}/assign`, {
        project_id: draft.projectId,
        vendor_name: needs.vendor ? draft.vendorName.trim() : undefined,
        total: needs.total ? draft.total : undefined,
        invoice_number: draft.invoiceNumber.trim() || undefined,
      });
      toast.success(res.data?.message || 'Invoice filed');
      await Promise.all([refreshInvoiceData(), loadEmailBox()]);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Could not file this invoice');
    } finally {
      setAssigningItemId(null);
    }
  };

  const rereadEmailWithAi = async (item: InvoiceEmailItem) => {
    if (rereadingEmailId) return;
    setRereadingEmailId(item.id);
    try {
      await api.post(`/invoices/email-intake/${item.id}/ai-reread`);
      toast.success('The AI read this email again');
      await Promise.all([refreshInvoiceData(), loadEmailBox()]);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'The AI could not read this email again');
    } finally {
      setRereadingEmailId(null);
    }
  };

  useEffect(() => {
    if (!isAdminRole(user?.role || '')) return;
    void loadEmailBox();
    // loadEmailBox reads the current filter; reload when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailBoxStatus, user?.role]);

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
    // Ask QuickBooks about the queued bills once the page is up; reload only if any were paid.
    load().then(() => refreshInvoiceDataRef.current({ recheckQueue: true, onlyIfQueueChanged: true }));
  }, []);

  useEffect(() => {
    // QuickBooks is only re-checked while someone can see the page; hidden tabs
    // just reload BuildTrack's own data.
    const interval = window.setInterval(() => {
      void refreshInvoiceDataRef.current({ recheckQueue: document.visibilityState === 'visible' });
    }, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  // The office records the payment in QuickBooks in another tab or window, then
  // comes back here: re-check right away. focus and visibilitychange both fire on
  // one switch, hence the short guard.
  const lastReturnRefreshAt = useRef(0);
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastReturnRefreshAt.current < 5_000) return;
      lastReturnRefreshAt.current = Date.now();
      void refreshInvoiceDataRef.current({ recheckQueue: true });
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, []);

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

  useEffect(() => {
    if (!qboPdfPreview) {
      setQboPdfPreviewUrl('');
      setQboPdfPreviewError('');
      setQboPdfPreviewLoading(false);
      return;
    }

    let active = true;
    let objectUrl = '';
    setQboPdfPreviewUrl('');
    setQboPdfPreviewError('');
    setQboPdfPreviewLoading(true);

    api.get(apiClientPath(qboPdfPreview.url), { responseType: 'blob' })
      .then(res => {
        if (!active) return;
        const responseContentType = res.headers?.['content-type'];
        const blobType = typeof responseContentType === 'string' ? responseContentType : 'application/pdf';
        const blob = new Blob([res.data], { type: qboPdfPreview.mime_type || blobType });
        objectUrl = URL.createObjectURL(blob);
        setQboPdfPreviewUrl(objectUrl);
      })
      .catch(() => {
        if (active) setQboPdfPreviewError('Unable to load invoice PDF. Try refreshing the invoices page and open it again.');
      })
      .finally(() => {
        if (active) setQboPdfPreviewLoading(false);
      });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [qboPdfPreview?.url]);

  const approvedPaymentQueue = useMemo(
    () => quickBooksBills
      .filter(bill => (
        !isQuickBooksBillPaid(bill)
        && !isQuickBooksBillBuildTrackPaid(bill)
        && bill.payment_approval_status === QUICKBOOKS_APPROVED_FOR_PAYMENT_STATUS
      ))
      .sort((a, b) => {
        const dateCompare = String(a.payment_run_date || '').localeCompare(String(b.payment_run_date || ''));
        if (dateCompare !== 0) return dateCompare;
        return Number(b.balance || 0) - Number(a.balance || 0);
      }),
    [quickBooksBills]
  );
  const approvedPaymentTotal = approvedPaymentQueue.reduce((sum, bill) => sum + Number(bill.balance || 0), 0);
  // Newest of this page's own queue re-check and the server's minute-by-minute full sync.
  const queueLastCheckedAt = [queueCheckedAt, quickBooksStatus?.connection?.last_sync_at || null]
    .filter((value): value is string => Boolean(parseBuildTrackTimestamp(value)))
    .sort((a, b) => (parseBuildTrackTimestamp(b)?.getTime() || 0) - (parseBuildTrackTimestamp(a)?.getTime() || 0))[0] || null;

  // Bank-entry checklist (Mike, 2026-09-18). Whoever keys these payments into
  // the bank ticks each row as they go so nothing is missed or paid twice. It
  // is a personal scratch list: it never touches the bill's real status (that
  // stays "Verify QBO Paid"), so it lives in this browser only, per user, and a
  // tick falls away on its own once the bill leaves the queue.
  const bankEntryStorageKey = `bt:bank-entry-checks:${user?.id || 'anon'}`;
  const [bankEntryChecked, setBankEntryChecked] = useState<Record<string, string>>({});
  const [bankEntryLoadedKey, setBankEntryLoadedKey] = useState('');
  // Persist is declared BEFORE load on purpose: when the key changes (user id
  // arrives after mount) this pass must not write the previous key's ticks
  // under the new one; the guard skips it until load has caught up.
  useEffect(() => {
    if (bankEntryLoadedKey !== bankEntryStorageKey) return;
    try { window.localStorage.setItem(bankEntryStorageKey, JSON.stringify(bankEntryChecked)); } catch { /* private mode / blocked storage */ }
  }, [bankEntryChecked, bankEntryLoadedKey, bankEntryStorageKey]);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(bankEntryStorageKey);
      const parsed = raw ? JSON.parse(raw) : {};
      setBankEntryChecked(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
    } catch {
      setBankEntryChecked({});
    }
    setBankEntryLoadedKey(bankEntryStorageKey);
  }, [bankEntryStorageKey]);
  useEffect(() => {
    // Prune ticks for bills no longer queued - but only once bills have loaded,
    // or the empty first render would wipe the list.
    if (!quickBooksBills.length) return;
    const live = new Set(approvedPaymentQueue.map(bill => String(bill.qbo_id)));
    const stale = Object.keys(bankEntryChecked).filter(id => !live.has(id));
    if (!stale.length) return;
    setBankEntryChecked(current => {
      const next = { ...current };
      stale.forEach(id => { delete next[id]; });
      return next;
    });
  }, [approvedPaymentQueue, bankEntryChecked, quickBooksBills.length]);
  const toggleBankEntryChecked = (qboId: string) => {
    setBankEntryChecked(current => {
      const next = { ...current };
      if (next[qboId]) delete next[qboId];
      else next[qboId] = new Date().toISOString();
      return next;
    });
  };
  const bankEntryCheckedCount = approvedPaymentQueue.filter(bill => bankEntryChecked[String(bill.qbo_id)]).length;
  const invoiceById = useMemo(() => new Map(invoices.map(invoice => [invoice.id, invoice])), [invoices]);
  const projectById = useMemo(() => new Map(projects.map(project => [project.id, project])), [projects]);
  const allQuickBooksBills = useMemo(() => sortQuickBooksBillsByBillDate(quickBooksBills), [quickBooksBills]);
  const quickBooksAllMirrorRows = useMemo(() => allQuickBooksBills.map(bill => ({
    bill,
    invoice: bill.matched_invoice_id ? invoiceById.get(bill.matched_invoice_id) || null : null,
  })), [allQuickBooksBills, invoiceById]);
  const quickBooksPeriodMirrorRows = useMemo(() => (
    quickBooksAllMirrorRows.filter(({ bill }) => quickBooksBillMatchesPeriod(bill, quickBooksInvoicePeriod))
  ), [quickBooksAllMirrorRows, quickBooksInvoicePeriod]);
  const quickBooksProjectFilterOptions = useMemo(() => {
    const options = new Map<string, string>();
    const addOption = (projectId?: string | null, address?: string | null, jobName?: string | null) => {
      if (!projectId || options.has(projectId)) return;
      const project = projectById.get(projectId);
      const labelParts = [
        project?.address || address || '',
        project?.job_name || jobName || '',
      ].filter(Boolean);
      options.set(projectId, labelParts.join(' - ') || projectId);
    };
    projects.forEach(project => addOption(project.id, project.address, project.job_name));
    quickBooksBills.forEach(bill => {
      const invoice = bill.matched_invoice_id ? invoiceById.get(bill.matched_invoice_id) || null : null;
      addOption(invoice?.project_id, invoice?.address, invoice?.job_name);
      addOption(bill.project_id, bill.project_address, bill.project_job_name);
      quickBooksSplitLines(bill).forEach(line => addOption(line.project_id, line.project_address, line.project_job_name));
    });
    return Array.from(options.entries())
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [invoiceById, projectById, projects, quickBooksBills]);
  const quickBooksVendorSupplierFilterOptions = useMemo(() => {
    const options = new Map<string, VendorSupplierFilterOption>();
    const addOption = (labelValue?: string | null, aliases: string[] = []) => {
      const label = String(labelValue || '').trim();
      if (!label) return;
      const key = quickBooksFilterText(label);
      const normalizedAliases = Array.from(new Set(
        [label, ...aliases]
          .map(value => String(value || '').trim())
          .filter(Boolean)
      ));
      const existing = options.get(key);
      if (existing) {
        existing.aliases = Array.from(new Set([...existing.aliases, ...normalizedAliases]));
        return;
      }
      options.set(key, { label, aliases: normalizedAliases });
    };

    contractorSupplierDirectory.forEach(row => {
      const aliases = vendorSupplierAliasCandidates(row);
      addOption(row.vendor_name || row.name || row.company || row.contact_name, aliases);
    });
    quickBooksBills.forEach(bill => addOption(bill.vendor_name, [String(bill.vendor_name || '').trim()]));

    // Mike: the vendors we are actively paying belong at the top of the list.
    // Rank each vendor by its most recent QuickBooks payment; vendors never
    // paid in the system follow, A-Z.
    const lastPaidByVendor = new Map<string, number>();
    quickBooksBills.forEach(bill => {
      if (!isQuickBooksBillPaid(bill)) return;
      const key = quickBooksFilterText(bill.vendor_name);
      if (!key) return;
      const paidAt = quickBooksDateRank(quickBooksPaidDateKey(bill));
      if (paidAt > (lastPaidByVendor.get(key) || 0)) lastPaidByVendor.set(key, paidAt);
    });
    const lastPaidFor = (option: VendorSupplierFilterOption) => option.aliases.reduce(
      (latest, alias) => Math.max(latest, lastPaidByVendor.get(quickBooksFilterText(alias)) || 0),
      lastPaidByVendor.get(quickBooksFilterText(option.label)) || 0
    );
    return Array.from(options.values()).sort((a, b) => (
      lastPaidFor(b) - lastPaidFor(a) || a.label.localeCompare(b.label)
    ));
  }, [contractorSupplierDirectory, quickBooksBills]);
  const quickBooksVendorSupplierAliasMap = useMemo(() => {
    const aliasMap = new Map<string, Set<string>>();
    quickBooksVendorSupplierFilterOptions.forEach(option => {
      const key = quickBooksFilterText(option.label);
      if (!key) return;
      aliasMap.set(key, new Set(option.aliases.map(alias => quickBooksFilterText(alias)).filter(Boolean)));
    });
    return aliasMap;
  }, [quickBooksVendorSupplierFilterOptions]);
  const quickBooksInvoiceFilterNeedsProject = QUICKBOOKS_FILTER_PROJECT_MODES.has(quickBooksInvoiceFilter.mode);
  const quickBooksInvoiceFilterNeedsVendor = QUICKBOOKS_FILTER_VENDOR_MODES.has(quickBooksInvoiceFilter.mode);
  const quickBooksInvoiceFilterNeedsDateRange = QUICKBOOKS_FILTER_DATE_RANGE_MODES.has(quickBooksInvoiceFilter.mode);
  const quickBooksInvoiceFilterNeedsExactDate = QUICKBOOKS_FILTER_EXACT_DATE_MODES.has(quickBooksInvoiceFilter.mode);
  // Ready as soon as the anchor is set: the project in project modes, the
  // vendor in vendor-only mode. Everything else narrows and never blocks.
  const quickBooksInvoiceFilterReady = quickBooksInvoiceFilter.mode === 'all' || (
    (!quickBooksInvoiceFilterNeedsProject || Boolean(quickBooksInvoiceFilter.projectId))
    && (quickBooksInvoiceFilter.mode !== 'vendor_only' || Boolean(quickBooksInvoiceFilter.vendor))
  );
  // With a project chosen, offer only vendors that actually have a bill on it
  // in the current period - not the whole 400-vendor directory.
  const quickBooksVendorOptionsForFilter = useMemo(() => {
    if (!quickBooksInvoiceFilterNeedsProject || !quickBooksInvoiceFilter.projectId) return quickBooksVendorSupplierFilterOptions;
    const projectVendorKeys = new Set<string>();
    quickBooksPeriodMirrorRows.forEach(({ bill, invoice }) => {
      if (!quickBooksBillMatchesProject(bill, invoice, quickBooksInvoiceFilter.projectId)) return;
      const key = quickBooksFilterText(bill.vendor_name);
      if (key) projectVendorKeys.add(key);
    });
    return quickBooksVendorSupplierFilterOptions.filter(option => {
      const key = quickBooksFilterText(option.label);
      if (projectVendorKeys.has(key)) return true;
      const aliases = quickBooksVendorSupplierAliasMap.get(key);
      return aliases ? Array.from(aliases).some(alias => projectVendorKeys.has(alias)) : false;
    });
  }, [
    quickBooksInvoiceFilter.projectId,
    quickBooksInvoiceFilterNeedsProject,
    quickBooksPeriodMirrorRows,
    quickBooksVendorSupplierAliasMap,
    quickBooksVendorSupplierFilterOptions,
  ]);
  const quickBooksInvoiceProjectFilterInUse = quickBooksInvoiceFilter.mode !== 'all';
  const quickBooksInvoicePeriodInUse = (
    quickBooksInvoicePeriod.mode !== DEFAULT_QUICKBOOKS_INVOICE_PERIOD.mode
    || (quickBooksInvoicePeriod.mode === 'day' && quickBooksInvoicePeriod.day !== DEFAULT_QUICKBOOKS_INVOICE_PERIOD.day)
  );
  const quickBooksInvoiceFilterInUse = quickBooksInvoiceProjectFilterInUse || quickBooksInvoicePeriodInUse;
  const quickBooksInvoiceFilterActive = (quickBooksInvoiceProjectFilterInUse && quickBooksInvoiceFilterReady) || quickBooksInvoicePeriodInUse;
  const quickBooksDefaultSortForStatus = deferredQuickBooksBillFilter === 'open'
    ? DEFAULT_QUICKBOOKS_AWAITING_APPROVAL_SORT
    : DEFAULT_QUICKBOOKS_INVOICE_SORT;
  const quickBooksEffectiveInvoiceSort = quickBooksInvoiceSort || (
    quickBooksInvoiceFilterInUse || deferredQuickBooksBillFilter === 'all' || deferredQuickBooksBillFilter === 'open'
      ? quickBooksDefaultSortForStatus
      : null
  );
  const quickBooksInvoiceScopeRows = useMemo(() => {
    const baseRows = quickBooksPeriodMirrorRows;
    const filteredRows = baseRows.filter(({ bill, invoice }) => (
      quickBooksBillMatchesInvoiceFilter(bill, invoice, quickBooksInvoiceFilter, quickBooksVendorSupplierAliasMap)
    ));
    return (!quickBooksInvoiceFilterNeedsProject || !quickBooksInvoiceFilter.projectId)
      ? filteredRows
      : filteredRows.flatMap(({ bill, invoice }) => (
        quickBooksBillScopedToProject(bill, invoice, quickBooksInvoiceFilter.projectId)
        .filter(scopedBill => quickBooksBillMatchesInvoiceFilter(scopedBill, invoice, quickBooksInvoiceFilter, quickBooksVendorSupplierAliasMap))
        .map(scopedBill => ({ bill: scopedBill, invoice }))
      ));
  }, [quickBooksInvoiceFilter, quickBooksInvoiceFilterNeedsProject, quickBooksPeriodMirrorRows, quickBooksVendorSupplierAliasMap]);
  const quickBooksStatusScopedRows = useMemo<Record<QuickBooksBillFilter, QuickBooksMirrorRow[]>>(() => ({
    open: quickBooksInvoiceScopeRows.filter(({ bill }) => quickBooksBillMatchesStatusFilter(bill, 'open')),
    friday_queue: quickBooksInvoiceScopeRows.filter(({ bill }) => quickBooksBillMatchesStatusFilter(bill, 'friday_queue')),
    paid: quickBooksInvoiceScopeRows.filter(({ bill }) => quickBooksBillMatchesStatusFilter(bill, 'paid')),
    all: quickBooksInvoiceScopeRows,
  }), [quickBooksInvoiceScopeRows]);
  const quickBooksPaymentMismatchRows = useMemo(() => (
    quickBooksInvoiceScopeRows.filter(({ bill }) => (
      !isQuickBooksBillPaid(bill) && isQuickBooksBillBuildTrackPaid(bill)
    ))
  ), [quickBooksInvoiceScopeRows]);
  const quickBooksBillFilterMeta: Record<QuickBooksBillFilter, { label: string; title: string; subtitle: string; count: number }> = {
    open: {
      label: 'Waiting for Approval',
      title: 'Waiting for Approval',
      subtitle: 'Unpaid QuickBooks invoices with an Approve to Pay action',
      count: quickBooksStatusScopedRows.open.length,
    },
    friday_queue: {
      label: 'Approved to Pay',
      title: 'Friday payment queue',
      subtitle: 'Approved unpaid bills waiting for QuickBooks payment',
      count: quickBooksStatusScopedRows.friday_queue.length,
    },
    paid: {
      label: 'Paid in Full',
      title: 'Paid in Full - QuickBooks',
      subtitle: 'Latest paid bills first by QuickBooks payment date and time',
      count: quickBooksStatusScopedRows.paid.length,
    },
    all: {
      label: 'All Invoices',
      title: 'All mirrored QuickBooks bills',
      subtitle: 'Every bill currently mirrored from QuickBooks',
      count: quickBooksStatusScopedRows.all.length,
    },
  };
  const selectedQuickBooksBillFilter = quickBooksBillFilterMeta[deferredQuickBooksBillFilter];
  const quickBooksScopedApprovedPaymentTotal = quickBooksStatusScopedRows.friday_queue.reduce((sum, { bill }) => sum + quickBooksMoneyAmount(bill.balance), 0);
  const quickBooksScopedPaidTotal = quickBooksStatusScopedRows.paid.reduce((sum, { bill }) => sum + quickBooksMoneyAmount(bill.total_amt), 0);
  const quickBooksScopedOpenCount = quickBooksStatusScopedRows.open.length;
  const quickBooksMirrorRows = useMemo(() => (
    sortQuickBooksInvoiceRows(quickBooksStatusScopedRows[deferredQuickBooksBillFilter] || [], quickBooksEffectiveInvoiceSort)
  ), [deferredQuickBooksBillFilter, quickBooksEffectiveInvoiceSort, quickBooksStatusScopedRows]);
  // Footer total for the Open balance column: what the currently shown queue is
  // worth. On the default "Waiting for Approval" tab this is the dollar value
  // still awaiting an approval decision.
  const quickBooksVisibleOpenBalanceTotal = useMemo(() => (
    quickBooksMirrorRows.reduce((sum, { bill }) => sum + quickBooksMoneyAmount(bill.balance), 0)
  ), [quickBooksMirrorRows]);
  const quickBooksProjectSpendSummary = useMemo<QuickBooksProjectSpendSummary | null>(() => {
    if (!quickBooksInvoiceFilterNeedsProject || !quickBooksInvoiceFilter.projectId || !quickBooksInvoiceFilterReady) return null;
    const selectedProject = projectById.get(quickBooksInvoiceFilter.projectId);
    const optionLabel = quickBooksProjectFilterOptions.find(option => option.id === quickBooksInvoiceFilter.projectId)?.label;
    const totals = quickBooksInvoiceScopeRows.reduce(
      (summary, { bill }) => {
        const amounts = quickBooksBillSpendAmounts(bill);
        const className = String(bill.qbo_class_name || '').trim();
        if (className) summary.classNames.add(className);
        summary.paidTotal += amounts.paid;
        summary.unpaidTotal += amounts.unpaid;
        summary.total += amounts.total;
        if (amounts.paid > 0) summary.paidBillCount += 1;
        if (amounts.unpaid > 0) summary.unpaidBillCount += 1;
        return summary;
      },
      {
        paidTotal: 0,
        unpaidTotal: 0,
        total: 0,
        paidBillCount: 0,
        unpaidBillCount: 0,
        classNames: new Set<string>(),
      }
    );

    return {
      projectLabel: optionLabel || selectedProject?.address || selectedProject?.job_name || 'Selected project',
      classLabel: Array.from(totals.classNames).sort().join(', ') || selectedProject?.address || 'Project address class',
      billCount: quickBooksInvoiceScopeRows.length,
      paidBillCount: totals.paidBillCount,
      unpaidBillCount: totals.unpaidBillCount,
      paidTotal: totals.paidTotal,
      unpaidTotal: totals.unpaidTotal,
      total: totals.total,
    };
  }, [
    projectById,
    quickBooksInvoiceFilter.projectId,
    quickBooksInvoiceFilterNeedsProject,
    quickBooksInvoiceFilterReady,
    quickBooksInvoiceScopeRows,
    quickBooksProjectFilterOptions,
  ]);
  const quickBooksInvoiceFilterLabel = QUICKBOOKS_INVOICE_FILTER_OPTIONS.find(option => option.value === quickBooksInvoiceFilter.mode)?.label || 'Filter';
  const quickBooksInvoiceFilterScope = quickBooksInvoiceFilter.mode === 'vendor_only' ? 'vendor / supplier' : 'project';
  const quickBooksInvoicePeriodLabel = quickBooksInvoicePeriod.mode === 'all_time'
    ? 'all-time invoices'
    : quickBooksInvoicePeriod.mode === 'month'
      ? `${formatDateOnly(`${DEFAULT_QUICKBOOKS_INVOICE_MONTH}-01T12:00:00`, { month: 'long', year: 'numeric' })} invoices`
      : quickBooksInvoicePeriod.mode === 'day'
        ? `${quickBooksPeriodDateLabel(quickBooksInvoicePeriod.day)} invoices`
        : `${DEFAULT_QUICKBOOKS_INVOICE_YEAR} invoices`;
  const quickBooksInvoicePeriodMessage = quickBooksInvoicePeriod.mode === 'year'
    ? `Default time period: ${DEFAULT_QUICKBOOKS_INVOICE_YEAR}. Counts, paid totals, open bills, and project spend use QuickBooks bill dates in this year.`
    : quickBooksInvoicePeriod.mode === 'all_time'
      ? 'Time period: all time. Counts, paid totals, open bills, and project spend include every mirrored QuickBooks bill.'
      : quickBooksInvoicePeriod.mode === 'month'
        ? `Time period: ${formatDateOnly(`${DEFAULT_QUICKBOOKS_INVOICE_MONTH}-01T12:00:00`, { month: 'long', year: 'numeric' })}. Counts, paid totals, open bills, and project spend use QuickBooks bill dates in this month.`
        : `Time period: ${quickBooksPeriodDateLabel(quickBooksInvoicePeriod.day)}. Counts, paid totals, open bills, and project spend use that QuickBooks bill date.`;
  const quickBooksInvoiceFilterPrompt = quickBooksInvoiceFilter.mode === 'all'
    ? `${quickBooksInvoiceScopeRows.length} ${quickBooksInvoicePeriodLabel}`
    : quickBooksInvoiceFilterNeedsProject && !quickBooksInvoiceFilter.projectId
      ? 'Select project'
      : quickBooksInvoiceFilter.mode === 'vendor_only' && !quickBooksInvoiceFilter.vendor
        ? 'Select vendor / supplier'
        : `${quickBooksInvoiceScopeRows.length} ${quickBooksInvoiceFilterScope} invoice${quickBooksInvoiceScopeRows.length === 1 ? '' : 's'}`;
  const quickBooksTableCountLabel = quickBooksInvoiceFilterActive
    ? deferredQuickBooksBillFilter === 'open'
      ? `${quickBooksMirrorRows.length} Filtered Open`
      : deferredQuickBooksBillFilter === 'friday_queue'
        ? `${quickBooksMirrorRows.length} Filtered Approved`
        : deferredQuickBooksBillFilter === 'paid'
          ? `${quickBooksMirrorRows.length} Filtered Paid`
          : `${quickBooksMirrorRows.length} Filtered Total`
    : deferredQuickBooksBillFilter === 'open'
      ? `${quickBooksMirrorRows.length} Waiting for Approval`
      : deferredQuickBooksBillFilter === 'friday_queue'
        ? `${quickBooksMirrorRows.length} Approved to Pay`
        : deferredQuickBooksBillFilter === 'paid'
          ? `${quickBooksMirrorRows.length} Paid in Full`
          : `${quickBooksMirrorRows.length} Total`;
  const showFridayPaymentQueuePanel = deferredQuickBooksBillFilter === 'open' && !quickBooksInvoiceFilterInUse;
  const clearQuickBooksInvoiceFilter = () => {
    setQuickBooksInvoiceFilter({ ...DEFAULT_QUICKBOOKS_INVOICE_FILTER });
    setQuickBooksInvoicePeriod({ ...DEFAULT_QUICKBOOKS_INVOICE_PERIOD, day: quickBooksTodayDateValue() });
    setQuickBooksBillFilter('open');
    setQuickBooksInvoiceSort(null);
  };
  const updateQuickBooksInvoiceFilter = (patch: Partial<QuickBooksInvoiceFilterState>) => {
    setQuickBooksInvoiceFilter(current => {
      const next = { ...current, ...patch };
      // A new project gets the full vendor list again; a vendor narrowing
      // chosen for the previous project must not silently carry over.
      if (patch.projectId !== undefined && patch.projectId !== current.projectId) next.vendor = '';
      return next;
    });
    // Project/vendor/date filters are investigative views. Show paid and open
    // results together so records do not disappear behind the prior status tab.
    if (patch.mode && patch.mode !== 'all') setQuickBooksBillFilter('all');
  };
  const updateQuickBooksInvoicePeriodMode = (mode: QuickBooksInvoicePeriodMode) => {
    setQuickBooksInvoicePeriod(current => ({ ...current, mode, day: current.day || quickBooksTodayDateValue() }));
  };
  const updateQuickBooksInvoicePeriodDay = (day: string) => {
    setQuickBooksInvoicePeriod(current => ({ ...current, mode: 'day', day }));
  };
  const updateQuickBooksBillFilter = (filter: QuickBooksBillFilter) => {
    setQuickBooksBillFilter(current => current === filter ? current : filter);
  };
  const updateQuickBooksInvoiceSort = (key: QuickBooksInvoiceSortKey) => {
    setQuickBooksInvoiceSort(current => {
      const currentSort = current || quickBooksEffectiveInvoiceSort;
      if (currentSort?.key === key) {
        return { key, direction: currentSort.direction === 'desc' ? 'asc' : 'desc' };
      }
      return { key, direction: key === 'status' || key === 'vendor' ? 'asc' : 'desc' };
    });
  };
  const quickBooksSortAria = (key: QuickBooksInvoiceSortKey): 'none' | 'ascending' | 'descending' => {
    if (quickBooksEffectiveInvoiceSort?.key !== key) return 'none';
    return quickBooksEffectiveInvoiceSort.direction === 'asc' ? 'ascending' : 'descending';
  };
  const renderQuickBooksSortableHeader = (key: QuickBooksInvoiceSortKey, label: string) => {
    const activeSort = quickBooksEffectiveInvoiceSort?.key === key ? quickBooksEffectiveInvoiceSort : null;
    const SortIcon = !activeSort ? ArrowUpDown : activeSort.direction === 'asc' ? ArrowUp : ArrowDown;
    return (
      <button
        type="button"
        className={`inline-flex items-center gap-1 bg-transparent p-0 text-left font-bold uppercase tracking-wide transition ${activeSort ? 'text-white' : 'text-slate-400 hover:text-white'}`}
        onClick={() => updateQuickBooksInvoiceSort(key)}
        title={`Sort by ${label}`}
      >
        <span>{label}</span>
        <SortIcon className={`h-3.5 w-3.5 ${activeSort ? 'opacity-100' : 'opacity-25'}`} />
      </button>
    );
  };
  const canApproveForPayment = (invoice?: Invoice | null) => Boolean(
    invoice
    && canManageQuickBooks
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

  const qboPdfInputId = (bill: QuickBooksBill) =>
    `qbo-bill-pdf-${String(bill.qbo_id || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  const apiClientPath = (url: string) => {
    const value = String(url || '').trim();
    if (!value) return value;
    if (value.startsWith('/api/')) return value.slice(4);
    if (/^https?:\/\//i.test(value)) {
      try {
        const parsed = new URL(value);
        if (parsed.origin === window.location.origin && parsed.pathname.startsWith('/api/')) {
          return `${parsed.pathname.slice(4)}${parsed.search}`;
        }
      } catch {
        return value;
      }
    }
    return value;
  };

  const qboPdfPreviewIsImage = Boolean(
    qboPdfPreview && isImagePreviewFile(qboPdfPreview.mime_type, qboPdfPreview.filename || qboPdfPreview.title)
  );
  const qboPdfFrameSrc = qboPdfPreviewUrl && qboPdfPreview && !qboPdfPreviewIsImage
    ? `${qboPdfPreviewUrl}#page=${Math.max(1, qboPdfPreview.page)}&zoom=${qboPdfPreview.zoom}&toolbar=0&navpanes=0&scrollbar=1`
    : '';

  const updateQboPdfViewer = (patch: Partial<Pick<InvoicePdfPreviewState, 'page' | 'zoom'>>) => {
    setQboPdfPreview(current => {
      if (!current) return current;
      const page = patch.page !== undefined ? Math.max(1, Math.floor(patch.page || 1)) : current.page;
      const zoom = patch.zoom !== undefined ? Math.max(25, Math.min(200, Math.round(patch.zoom))) : current.zoom;
      return { ...current, page, zoom };
    });
  };

  const previewQuickBooksBillPdf = (bill: QuickBooksBill) => {
    const pdf = bill.invoice_pdf;
    if (!pdf?.available || !pdf.url) {
      toast.error('No PDF invoice is attached to this bill yet');
      return;
    }
    const title = pdf.original_name || `QBO bill ${bill.doc_number || bill.qbo_id}.pdf`;
    setQboPdfPreview({
      title,
      filename: invoicePdfDownloadName(title),
      url: pdf.url,
      mime_type: pdf.mime_type || 'application/pdf',
      size_label: pdf.size_label || null,
      page: 1,
      zoom: 85,
    });
  };

  const uploadQuickBooksBillPdf = async (bill: QuickBooksBill, file?: File | null) => {
    if (!file) return;
    const isPdf = file.type.toLowerCase().includes('pdf') || file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      toast.error('Upload a PDF invoice file');
      return;
    }

    setUploadingQboBillPdfId(bill.qbo_id);
    try {
      const form = new FormData();
      form.append('invoice_pdf', file);
      const res = await api.post(`/quickbooks/bills/${encodeURIComponent(bill.qbo_id)}/attachments`, form);
      updateQuickBooksBill(res.data);
      toast.success('Invoice PDF uploaded');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to upload invoice PDF');
    } finally {
      setUploadingQboBillPdfId(null);
      setDraggingQboBillPdfId(null);
    }
  };

  const handleQuickBooksBillPdfFiles = (bill: QuickBooksBill, files?: FileList | null) => {
    const file = files && files.length ? files[0] : null;
    uploadQuickBooksBillPdf(bill, file);
  };

  const canApproveQuickBooksBill = (bill: QuickBooksBill, invoice?: Invoice | null) => {
    if (!canManageQuickBooks) return false;
    if (isQuickBooksBillPaid(bill)) return false;
    if (isQuickBooksBillBuildTrackPaid(bill)) return false;
    if (bill.payment_approval_status === QUICKBOOKS_APPROVED_FOR_PAYMENT_STATUS) return false;
    return quickBooksBillHasApprovalMatch(bill, invoice);
  };

  const quickBooksApprovalBlockedReason = (bill: QuickBooksBill, invoice?: Invoice | null) => {
    if (isQuickBooksBillPaid(bill)) return 'Already paid in QuickBooks';
    if (isQuickBooksBillBuildTrackPaid(bill)) return 'Already marked paid in BuildTrack; QuickBooks match stays linked';
    if (bill.payment_approval_status === QUICKBOOKS_APPROVED_FOR_PAYMENT_STATUS) return 'Already in the Friday payment queue';
    if (quickBooksSplitLineCount(bill) > 0 && quickBooksUnmatchedSplitLineCount(bill) > 0) return 'Assign every class split before approval';
    if (!quickBooksBillHasApprovalMatch(bill, invoice)) return 'Assign before approval';
    return 'Ready for Friday payment approval';
  };

  const canDeleteQuickBooksOpenBill = (bill: QuickBooksBill) => (
    canManageQuickBooks
    && !isQuickBooksBillPaid(bill)
    && !isQuickBooksBillBuildTrackPaid(bill)
    && bill.payment_approval_status !== QUICKBOOKS_APPROVED_FOR_PAYMENT_STATUS
  );

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

  // Pay-date emails to contractors are manual-only: nothing sends until the
  // office presses this button on a Waiting for Approval row.
  const sendQuickBooksPayDateEmail = async (bill: QuickBooksBill) => {
    setSendingPayDateQboBillId(bill.qbo_id);
    try {
      const res = await api.post(`/quickbooks/bills/${encodeURIComponent(bill.qbo_id)}/send-pay-date`);
      updateQuickBooksBill(res.data);
      toast.success('Pay-date email sent to the contractor');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to send the pay-date email');
    } finally {
      setSendingPayDateQboBillId(null);
    }
  };

  const removeQuickBooksBillFromPay = async (bill: QuickBooksBill) => {
    setRemovingQboBillId(bill.qbo_id);
    try {
      const res = await api.put(`/quickbooks/bills/${encodeURIComponent(bill.qbo_id)}/remove-from-pay`);
      updateQuickBooksBill(res.data);
      await refreshQuickBooksStatus();
      toast.success(res.data?.already_paid
        ? 'Already paid in QuickBooks; moved to Paid in Full'
        : 'Invoice removed from the Friday payment queue');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to remove this bill from the payment queue');
      await refreshInvoiceData();
    } finally {
      setRemovingQboBillId(null);
    }
  };

  const markQuickBooksBillPaidFromQueue = async (bill: QuickBooksBill) => {
    if (isQuickBooksBillPaid(bill)) {
      toast.error('This invoice is already paid in QuickBooks.');
      return;
    }
    if (bill.payment_approval_status !== QUICKBOOKS_APPROVED_FOR_PAYMENT_STATUS) {
      toast.error('Only Friday queue invoices can be marked paid.');
      return;
    }

    setMarkingQboPaidId(bill.qbo_id);
    try {
      const res = await api.put(`/quickbooks/bills/${encodeURIComponent(bill.qbo_id)}/mark-paid-from-queue`);
      updateQuickBooksBill(res.data);
      await refreshQuickBooksStatus();
      toast.success(res.data?.already_paid
        ? 'Already paid in QuickBooks; moved to Paid in Full'
        : 'QuickBooks payment confirmed; invoice moved to Paid in Full');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to verify this invoice in QuickBooks');
      if (err.response?.data?.bill) updateQuickBooksBill(err.response.data.bill);
      await refreshInvoiceData();
    } finally {
      setMarkingQboPaidId(null);
    }
  };

  const deleteQuickBooksOpenBill = async (bill: QuickBooksBill) => {
    if (!canDeleteQuickBooksOpenBill(bill)) {
      toast.error('Only unpaid open bills can be deleted from BuildTrack.');
      return;
    }
    const label = bill.doc_number || bill.vendor_name || bill.qbo_id;
    const confirmed = window.confirm(`Delete open bill ${label} from BuildTrack? This removes the local mirrored bill and any attached invoice PDF from BuildTrack.`);
    if (!confirmed) return;

    setDeletingQboBillId(bill.qbo_id);
    try {
      const res = await api.delete(`/quickbooks/bills/${encodeURIComponent(bill.qbo_id)}`);
      setQuickBooksBills(prev => prev.filter(item => item.qbo_id !== bill.qbo_id));
      await refreshQuickBooksStatus();
      toast.success(res.data?.message || 'Open bill deleted');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to delete this open bill');
    } finally {
      setDeletingQboBillId(null);
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

  // Incoming invoices from email (Mike, 2026-10-27): one row per invoice - received,
  // vendor, invoice #, amount, work, document, project - and one click to file it. The
  // raw email is not shown; the AI's read is what matters. QuickBooks stays the source of
  // truth: once the bill is entered there, the invoice follows its class and amount.
  const queueWork = (item: InvoiceInboxAiItem) =>
    [item.category, item.invoice_type ? AI_INVOICE_TYPE_LABELS[item.invoice_type] || item.invoice_type : ''].filter(Boolean).join(' · ') || '-';

  const queueDocument = (email: InvoiceEmailItem, item: InvoiceInboxAiItem | null) => {
    const files = email.attachments || [];
    const attachment = item?.source_attachment_id
      ? files.find(file => file.id === item.source_attachment_id) || null
      : (files.length === 1 ? files[0] : null);
    if (!attachment) return <span className="bt-inq-muted">{files.length ? `${files.length} files` : 'In the email'}</span>;
    return (
      <button
        type="button"
        className="bt-inq-doc"
        onClick={() => setAttachmentPreview({ emailId: email.id, attachment })}
        title={`View ${attachment.original_name || 'document'}`}
      >
        <FileText className="h-3.5 w-3.5 shrink-0" />
        <span>{attachment.original_name || 'Document'}</span>
      </button>
    );
  };

  const queueRowActions = (email: InvoiceEmailItem) => (
    <>
      <button
        type="button"
        className="bt-inq-icon"
        title="Read again with the AI"
        aria-label="Read again with the AI"
        disabled={rereadingEmailId === email.id}
        onClick={() => void rereadEmailWithAi(email)}
      >
        <RefreshCw className={`h-3.5 w-3.5 ${rereadingEmailId === email.id ? 'animate-spin' : ''}`} />
      </button>
      {email.status !== 'ignored' ? (
        <button
          type="button"
          className="bt-inq-icon"
          title="Not an invoice"
          aria-label="Not an invoice"
          disabled={ignoringEmailId === email.id}
          onClick={() => void markEmailNotInvoice(email)}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </>
  );

  const renderQueueRow = (row: QueueRow, projectChoices: ProjectOption[]) => {
    const { email, item } = row;
    const received = (
      <span className="bt-inq-cell bt-inq-muted" title={formatEasternDateTime(email.received_at)}>
        {formatEasternDate(email.received_at, { year: undefined })}
      </span>
    );

    // Waiting for a person: pick the project (and type what the AI could not read).
    if (item && isOpenAiItem(item)) {
      const draft = queueDrafts[item.id] || EMPTY_QUEUE_DRAFT;
      const needs = queueNeeds(item);
      const suggestions = item.suggestions || [];
      const fromBills = suggestions.filter(s => s.source === 'quickbooks_bill');
      const recent = suggestions.filter(s => s.source !== 'quickbooks_bill');
      const ready = Boolean(draft.projectId)
        && (!needs.vendor || Boolean(draft.vendorName.trim()))
        && (!needs.total || Number(draft.total.replace(/[$,\s]/g, '')) > 0);
      const busy = assigningItemId === item.id;
      const chip = (s: InvoiceProjectSuggestion) => (
        <button
          key={`${s.source}-${s.project_id}`}
          type="button"
          className={`bt-inq-chip ${s.source === 'quickbooks_bill' ? 'is-qbo' : ''} ${draft.projectId === s.project_id ? 'is-selected' : ''}`}
          onClick={() => updateQueueDraft(item.id, { projectId: s.project_id })}
          title={s.source === 'quickbooks_bill'
            ? `QuickBooks bill ${s.qbo_bill_id || ''} ${s.amount ? money(s.amount) : ''} ${s.bill_date ? formatDateOnly(s.bill_date) : ''}${s.class_name ? ` - class ${s.class_name}` : ''}`
            : `${item.vendor_name || 'This vendor'} was last billed here in QuickBooks${s.bill_date ? ` on ${formatDateOnly(s.bill_date)}` : ''}`}
        >
          {shortAddress(s.address).split(',')[0]}
        </button>
      );
      return (
        <li key={row.key} className="bt-inq-item is-open">
          <div className="bt-inq-row">
            {received}
            <span className="bt-inq-cell">
              {needs.vendor ? (
                <input className="bt-inq-input" placeholder="Vendor" aria-label="Vendor" value={draft.vendorName}
                  onChange={event => updateQueueDraft(item.id, { vendorName: event.target.value })} />
              ) : <strong title={item.vendor_name || ''}>{item.vendor_name}</strong>}
            </span>
            <span className="bt-inq-cell">
              {needs.vendor || needs.total ? (
                <input className="bt-inq-input" placeholder="Invoice #" aria-label="Invoice number" value={draft.invoiceNumber}
                  onChange={event => updateQueueDraft(item.id, { invoiceNumber: event.target.value })} />
              ) : (item.invoice_number ? `#${item.invoice_number}` : <span className="bt-inq-muted">-</span>)}
            </span>
            <span className="bt-inq-cell is-amount">
              {needs.total ? (
                <input className="bt-inq-input" placeholder="0.00" aria-label="Amount" inputMode="decimal" value={draft.total}
                  onChange={event => updateQueueDraft(item.id, { total: event.target.value })} />
              ) : money(Number(item.total))}
            </span>
            <span className="bt-inq-cell bt-inq-muted">{queueWork(item)}</span>
            <span className="bt-inq-cell">{queueDocument(email, item)}</span>
            <span className="bt-inq-cell">
              <select
                className="bt-inq-select"
                value={draft.projectId}
                aria-label={`Project for ${item.vendor_name || 'this invoice'}`}
                onChange={event => updateQueueDraft(item.id, { projectId: event.target.value })}
              >
                <option value="">Choose project</option>
                {suggestions.length ? (
                  <optgroup label="From QuickBooks">
                    {suggestions.map(s => <option key={`s-${s.project_id}`} value={s.project_id}>{shortAddress(s.address)}</option>)}
                  </optgroup>
                ) : null}
                <optgroup label="All projects">
                  {projectChoices.map(project => <option key={project.id} value={project.id}>{shortAddress(project.address)}</option>)}
                </optgroup>
              </select>
            </span>
            <span className="bt-inq-actions">
              <button type="button" className="bt-inq-assign" disabled={!ready || busy} onClick={() => void assignQueueItem(email, item)}>
                {busy ? 'Filing...' : 'Assign'}
              </button>
              {queueRowActions(email)}
            </span>
          </div>
          <div className="bt-inq-note">
            <span className="bt-inq-reason" title={item.reason || ''}>{item.reason || AI_ITEM_LABELS[item.status] || 'Needs a person'}</span>
            {fromBills.length ? (
              <span className="bt-inq-suggest"><span className="bt-inq-muted">In QuickBooks:</span>{fromBills.map(chip)}</span>
            ) : null}
            {recent.length ? (
              <span className="bt-inq-suggest"><span className="bt-inq-muted">Recent jobs:</span>{recent.map(chip)}</span>
            ) : null}
          </div>
        </li>
      );
    }

    // Filed: its project and how QuickBooks has it.
    if (item && item.invoice_id) {
      const qbo = item.qbo_status || '';
      return (
        <li key={row.key} className="bt-inq-item">
          <div className="bt-inq-row">
            {received}
            <span className="bt-inq-cell"><strong title={item.vendor_name || ''}>{item.vendor_name || '-'}</strong></span>
            <span className="bt-inq-cell">{item.invoice_number ? `#${item.invoice_number}` : <span className="bt-inq-muted">-</span>}</span>
            <span className="bt-inq-cell is-amount">{money(Number(item.bt_total ?? item.total ?? 0))}</span>
            <span className="bt-inq-cell bt-inq-muted">{queueWork(item)}</span>
            <span className="bt-inq-cell">{queueDocument(email, item)}</span>
            <span className="bt-inq-cell">
              {item.project_id ? (
                <Link to={`/projects/${item.project_id}/invoices/${item.invoice_id}`} className="bt-inq-link" title={item.project_address || ''}>
                  {shortAddress(item.project_address) || 'Project'}
                </Link>
              ) : '-'}
              {item.bt_invoice_number ? <span className="bt-inq-muted"> · {item.bt_invoice_number}</span> : null}
            </span>
            <span className="bt-inq-actions">
              <span className={`bt-monitor-status is-${qbo || 'waiting_for_quickbooks'}`} title={item.qbo_summary || ''}>
                {QBO_STATUS_LABELS[qbo] || 'Waiting for QuickBooks'}
              </span>
            </span>
          </div>
        </li>
      );
    }

    // Duplicates, estimates and emails with nothing to file: one quiet line.
    const who = item?.vendor_name || email.from_name || email.from_email || 'Unknown sender';
    const what = item
      ? `${AI_ITEM_LABELS[item.status] || item.status}${item.reason ? ` - ${item.reason}` : ''}`
      : (email.agent_notes || (email.agent_status === 'pending' ? 'Waiting for the AI to read it.' : email.subject || '(no subject)'));
    return (
      <li key={row.key} className="bt-inq-item is-quiet">
        <div className="bt-inq-row">
          {received}
          <span className="bt-inq-cell"><strong title={who}>{who}</strong></span>
          <span className="bt-inq-cell bt-inq-span" title={what}>{what}</span>
          <span className="bt-inq-actions">{queueRowActions(email)}</span>
        </div>
      </li>
    );
  };

  const renderInvoiceQueue = () => {
    const rows = emailBoxItems.flatMap<QueueRow>(email => {
      const items = email.ai_items || [];
      const shown = emailBoxStatus === 'new' ? items.filter(isOpenAiItem) : items;
      if (shown.length) return shown.map(item => ({ key: item.id, email, item }));
      return [{ key: email.id, email, item: null }];
    });
    const projectChoices = projects
      .filter(project => project.status !== 'archived')
      .sort((a, b) => a.address.localeCompare(b.address));
    const tabs = [
      { value: 'new', label: 'Needs a project' },
      { value: 'filed', label: 'Filed' },
      { value: 'ignored', label: 'Not invoices' },
      { value: '', label: 'All' },
    ];
    return (
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
                The AI files every invoice sent to invoices@newurbandev.com. The ones with no clear job wait here - choose the project and assign.
                QuickBooks is the source of truth: once the bill is entered there, the invoice follows its class and amount.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {tabs.map(option => (
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
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${emailBoxLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {emailBoxLoading && emailBoxItems.length === 0 ? (
          <div className="bt-invoice-empty">Loading invoices from email...</div>
        ) : rows.length === 0 ? (
          <div className="bt-invoice-empty">
            <p className="text-sm font-bold text-gray-600">
              {emailBoxStatus === 'new' ? 'Nothing waiting - every emailed invoice is filed.' : 'No emailed invoices here.'}
            </p>
          </div>
        ) : (
          <div className="bt-inq">
            <div className="bt-inq-head" aria-hidden="true">
              <span>Received</span>
              <span>Vendor</span>
              <span>Invoice #</span>
              <span className="is-amount">Amount</span>
              <span>Work</span>
              <span>Document</span>
              <span>Project</span>
              <span />
            </div>
            <ul className="bt-inq-list">
              {rows.map(row => renderQueueRow(row, projectChoices))}
            </ul>
          </div>
        )}
      </section>
    );
  };

  const renderQuickBooksBillPdfControl = (bill: QuickBooksBill) => {
    const pdf = bill.invoice_pdf;
    const hasPdf = Boolean(pdf?.available && pdf.url);
    const inputId = qboPdfInputId(bill);
    const busy = uploadingQboBillPdfId === bill.qbo_id;
    const dragging = draggingQboBillPdfId === bill.qbo_id;

    if (hasPdf) {
      return (
        <div className="bt-qbo-pdf-control has-pdf">
          <button
            type="button"
            className="bt-qbo-pdf-view-button"
            onClick={() => previewQuickBooksBillPdf(bill)}
            title={`View ${pdf?.original_name || 'invoice PDF'}`}
          >
            <FileText className="h-4 w-4" />
            <span>View Invoice</span>
            <Eye className="h-3.5 w-3.5" />
          </button>
          <small>{pdf?.label || 'PDF available'}{pdf?.size_label ? ` - ${pdf.size_label}` : ''}</small>
        </div>
      );
    }

    if (!canManageQuickBooks) {
      return (
        <div className="bt-qbo-pdf-control needs-pdf">
          <small>No PDF attached yet</small>
        </div>
      );
    }

    return (
      <div
        className={`bt-qbo-pdf-control needs-pdf ${dragging ? 'is-dragging' : ''} ${busy ? 'is-uploading' : ''}`}
        onDragOver={event => {
          event.preventDefault();
          setDraggingQboBillPdfId(bill.qbo_id);
        }}
        onDragLeave={() => setDraggingQboBillPdfId(current => current === bill.qbo_id ? null : current)}
        onDrop={event => {
          event.preventDefault();
          handleQuickBooksBillPdfFiles(bill, event.dataTransfer.files);
        }}
      >
        <label htmlFor={inputId} className="bt-qbo-pdf-upload-button">
          <Upload className="h-4 w-4" />
          <span>{busy ? 'Uploading...' : 'Add PDF'}</span>
          <input
            id={inputId}
            type="file"
            accept="application/pdf,.pdf"
            disabled={busy}
            onChange={event => {
              handleQuickBooksBillPdfFiles(bill, event.target.files);
              event.currentTarget.value = '';
            }}
          />
        </label>
        <small>{dragging ? 'Drop PDF to attach' : 'Drop PDF or click to upload'}</small>
      </div>
    );
  };

  if (loading) return <Loading />;

  return (
    <div className="bt-desktop-page bt-invoices-light min-h-full px-6 pt-2 pb-6 md:px-8">
      <div className={`${quickBooksInvoiceFilterInUse ? 'bt-invoice-filter-results-layout max-w-none' : 'max-w-7xl'} mx-auto space-y-3`}>
        <header className="bt-invoice-page-heading">
          <div>
            <span>Invoice Center</span>
            <h1>Invoices</h1>
          </div>
          <div className="bt-invoice-workflow-key" aria-label="Invoice workflow sections">
            <span data-stage="waiting"><strong>1</strong> Waiting for Approval</span>
            <span data-stage="approved"><strong>2</strong> Approved to Pay</span>
            <span data-stage="paid"><strong>3</strong> Paid in Full</span>
          </div>
        </header>
        {canViewQuickBooks && (
          <section className={`bt-invoice-section bt-qbo-mirror-section ${quickBooksInvoiceFilterInUse ? 'is-filter-results' : ''}`}>
            <div className="bt-qbo-filter-row mx-4 mt-2 flex flex-wrap items-center gap-2">
              <div className="bt-qbo-status-filter-pills">
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
                      onClick={() => updateQuickBooksBillFilter(option.key)}
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

              <div className="bt-qbo-invoice-filter-panel">
                <label>
                  <span>Time period</span>
                  <select
                    value={quickBooksInvoicePeriod.mode}
                    onChange={event => updateQuickBooksInvoicePeriodMode(event.target.value as QuickBooksInvoicePeriodMode)}
                  >
                    {QUICKBOOKS_INVOICE_PERIOD_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                {quickBooksInvoicePeriod.mode === 'day' && (
                  <label>
                    <span>Specific day</span>
                    <input
                      type="date"
                      value={quickBooksInvoicePeriod.day}
                      onChange={event => updateQuickBooksInvoicePeriodDay(event.target.value)}
                    />
                  </label>
                )}
                <label>
                  <span>Invoice filter</span>
                  <select
                    value={quickBooksInvoiceFilter.mode}
                    onChange={event => updateQuickBooksInvoiceFilter({ mode: event.target.value as QuickBooksInvoiceFilterMode })}
                  >
                    {QUICKBOOKS_INVOICE_FILTER_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                {quickBooksInvoiceFilterNeedsProject && (
                  <label>
                    <span>Project required</span>
                    <select
                      value={quickBooksInvoiceFilter.projectId}
                      onChange={event => updateQuickBooksInvoiceFilter({ projectId: event.target.value })}
                    >
                      <option value="">Select project</option>
                      {quickBooksProjectFilterOptions.map(option => (
                        <option key={option.id} value={option.id}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                )}
                {quickBooksInvoiceFilterNeedsVendor && (
                  <label>
                    <span>Vendor / Suppliers</span>
                    <select
                      value={quickBooksInvoiceFilter.vendor}
                      onChange={event => updateQuickBooksInvoiceFilter({ vendor: event.target.value })}
                    >
                      <option value="">
                        {quickBooksInvoiceFilter.mode === 'vendor_only' ? 'Select vendor / supplier' : 'All vendors / suppliers'}
                      </option>
                      {quickBooksVendorOptionsForFilter.map(option => (
                        <option key={option.label} value={option.label}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                )}
                {quickBooksInvoiceFilterNeedsDateRange && (
                  <>
                    <label>
                      <span>Start date</span>
                      <input
                        type="date"
                        value={quickBooksInvoiceFilter.startDate}
                        onChange={event => updateQuickBooksInvoiceFilter({ startDate: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>End date</span>
                      <input
                        type="date"
                        value={quickBooksInvoiceFilter.endDate}
                        onChange={event => updateQuickBooksInvoiceFilter({ endDate: event.target.value })}
                      />
                    </label>
                  </>
                )}
                {quickBooksInvoiceFilterNeedsExactDate && (
                  <label>
                    <span>Bill date</span>
                    <input
                      type="date"
                      value={quickBooksInvoiceFilter.exactDate}
                      onChange={event => updateQuickBooksInvoiceFilter({ exactDate: event.target.value })}
                    />
                  </label>
                )}
                <span className={`bt-qbo-invoice-filter-count ${quickBooksInvoiceFilterActive ? 'is-active' : ''}`}>
                  {quickBooksInvoiceFilterPrompt}
                </span>
                {quickBooksInvoiceFilterInUse && (
                  <button type="button" className="bt-qbo-clear-invoice-filter" onClick={clearQuickBooksInvoiceFilter}>
                    <X className="h-3.5 w-3.5" />
                    Clear
                  </button>
                )}
                <div className="bt-qbo-period-note">
                  <CalendarDays className="h-4 w-4" />
                  <span>{quickBooksInvoicePeriodMessage}</span>
                </div>
              </div>
            </div>

            {quickBooksStatus?.connection?.last_sync_error && (
              <div className="mt-3 mx-4 flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm font-semibold text-red-100">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>{quickBooksStatus.connection.last_sync_error}</span>
              </div>
            )}

            {quickBooksPaymentMismatchRows.length > 0 && (
              <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-amber-400 bg-amber-50 p-3 text-sm font-semibold text-amber-900" role="status">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>
                  {quickBooksPaymentMismatchRows.length} bill{quickBooksPaymentMismatchRows.length === 1 ? '' : 's'} marked paid in BuildTrack still {quickBooksPaymentMismatchRows.length === 1 ? 'has' : 'have'} an open QuickBooks balance. {quickBooksPaymentMismatchRows.length === 1 ? 'It remains' : 'They remain'} visible under Open Bills until QuickBooks reports payment.
                </span>
              </div>
            )}

            {quickBooksProjectSpendSummary && (
              <section className="bt-qbo-project-spend-summary" aria-label="QuickBooks project bill spend summary">
                <div className="bt-qbo-project-spend-summary__heading">
                  <div>
                    <span>Project bill spend</span>
                    <strong>{quickBooksProjectSpendSummary.projectLabel}</strong>
                    <small>QBO class: {quickBooksProjectSpendSummary.classLabel}</small>
                  </div>
                  <div>
                    <span>Source of truth</span>
                    <strong>QuickBooks Online</strong>
                    <small>
                      {quickBooksStatus?.connection?.last_sync_at
                        ? `Synced ${formatEasternDateTime(quickBooksStatus.connection.last_sync_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                        : 'Awaiting sync timestamp'}
                    </small>
                  </div>
                </div>
                <div className="bt-qbo-project-spend-summary__cards">
                  <div>
                    <span>Paid bills</span>
                    <strong>{money(quickBooksProjectSpendSummary.paidTotal)}</strong>
                    <small>{quickBooksProjectSpendSummary.paidBillCount} bill{quickBooksProjectSpendSummary.paidBillCount === 1 ? '' : 's'} paid in QBO</small>
                  </div>
                  <div>
                    <span>Unpaid/open bills</span>
                    <strong>{money(quickBooksProjectSpendSummary.unpaidTotal)}</strong>
                    <small>{quickBooksProjectSpendSummary.unpaidBillCount} bill{quickBooksProjectSpendSummary.unpaidBillCount === 1 ? '' : 's'} still open in QBO</small>
                  </div>
                  <div>
                    <span>Total project bills</span>
                    <strong>{money(quickBooksProjectSpendSummary.total)}</strong>
                    <small>{quickBooksProjectSpendSummary.billCount} filtered bill{quickBooksProjectSpendSummary.billCount === 1 ? '' : 's'}</small>
                  </div>
                </div>
              </section>
            )}

            {quickBooksMirrorRows.length === 0 ? (
              <div className="bt-invoice-empty bt-qbo-table-empty">
                <Receipt className="mx-auto mb-3 h-8 w-8 text-blue-300" />
                <p className="text-sm font-bold text-gray-600">
                  {quickBooksInvoiceFilter.mode !== 'all' && !quickBooksInvoiceFilterReady
                    ? quickBooksInvoiceFilter.mode === 'vendor_only'
                      ? 'Select a vendor / supplier to show their paid and unpaid invoices.'
                      : 'Select a project to show all of its paid and unpaid invoices.'
                    : quickBooksInvoiceFilterActive
                      ? `No paid or unpaid invoices match this ${quickBooksInvoiceFilterScope} filter right now.`
                      : `No ${selectedQuickBooksBillFilter.label.toLowerCase()} are showing right now.`}
                </p>
              </div>
            ) : (
              <div className="bt-qbo-table-shell">
                <div className="bt-qbo-table-title">
                  <div>
                    <span>{selectedQuickBooksBillFilter.title}</span>
                    <p>{selectedQuickBooksBillFilter.subtitle}</p>
                  </div>
                  <strong className="bt-qbo-table-count">{quickBooksTableCountLabel}</strong>
                </div>
                <div className="bt-qbo-table-wrap">
                  <table className="bt-qbo-bill-table">
                    <thead>
                      <tr>
                        <th aria-sort={quickBooksSortAria('status')}>{renderQuickBooksSortableHeader('status', 'Status')}</th>
                        <th aria-sort={quickBooksSortAria('vendor')}>{renderQuickBooksSortableHeader('vendor', 'Vendor')}</th>
                        <th aria-sort={quickBooksSortAria('bill_date')}>{renderQuickBooksSortableHeader('bill_date', 'Bill date')}</th>
                        <th aria-sort={quickBooksSortAria('due_date')}>{renderQuickBooksSortableHeader('due_date', 'Expected pay date')}</th>
                        <th aria-sort={quickBooksSortAria('bill_amount')}>{renderQuickBooksSortableHeader('bill_amount', 'Bill amount')}</th>
                        <th aria-sort={quickBooksSortAria('open_balance')}>{renderQuickBooksSortableHeader('open_balance', 'Open balance')}</th>
                        <th>BuildTrack match</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {quickBooksMirrorRows.map(({ bill, invoice }) => {
                        const isPaid = isQuickBooksBillPaid(bill);
                        const isBuildTrackPaid = isQuickBooksBillBuildTrackPaid(bill);
                        const hasPaymentMismatch = !isPaid && isBuildTrackPaid;
                        const isApprovedForPay = bill.payment_approval_status === QUICKBOOKS_APPROVED_FOR_PAYMENT_STATUS && !isPaid && !isBuildTrackPaid;
                        const localInvoiceMarkedPaid = Boolean(!isPaid && !isBuildTrackPaid && invoice && (invoice.status === 'paid' || invoice.quickbooks_payment_status === 'paid'));
                        const splitLines = quickBooksVisibleSplitLines(bill);
                        const visibleSplitLineCount = splitLines.length;
                        const splitLineCount = quickBooksSplitLineCount(bill);
                        const unmatchedSplitCount = quickBooksUnmatchedSplitLineCount(bill);
                        const splitMatched = quickBooksBillSplitMatched(bill);
                        const isSplitScoped = Boolean(bill.split_scope_line_id);
                        const projectMatched = quickBooksBillHasApprovalMatch(bill, invoice);
                        const needsReview = hasPaymentMismatch || (!projectMatched && !isPaid && !isBuildTrackPaid);
                        const canDeleteOpenBill = canDeleteQuickBooksOpenBill(bill);
                        const isWaitingForApproval = !isPaid && !isBuildTrackPaid && !isApprovedForPay;
                        const payDateButton = isWaitingForApproval && canManageQuickBooks ? (
                          <button
                            type="button"
                            onClick={() => sendQuickBooksPayDateEmail(bill)}
                            disabled={sendingPayDateQboBillId === bill.qbo_id || !bill.vendor_email || !bill.due_date}
                            title={!bill.vendor_email
                              ? "Add the vendor's email in QuickBooks and sync to enable this"
                              : !bill.due_date
                                ? "Set the bill's due date in QuickBooks and sync to enable this"
                                : bill.vendor_receipt_notify_status === 'sent'
                                  ? 'Re-send the pay-date email to the contractor'
                                  : 'Email the contractor their expected pay date'}
                            className={`bt-send-paydate-button ${bill.vendor_receipt_notify_status === 'sent' ? 'is-sent' : ''}`}
                          >
                            <Mail className="h-4 w-4" />
                            {sendingPayDateQboBillId === bill.qbo_id ? 'Sending...' : bill.vendor_receipt_notify_status === 'sent' ? 'Re-send pay date' : 'Send pay date'}
                          </button>
                        ) : null;
                        const matchAddress = isSplitScoped ? bill.project_address || invoice?.address || '' : invoice?.address || bill.project_address || '';
                        const matchName = isSplitScoped ? bill.project_job_name || invoice?.job_name || '' : invoice?.job_name || bill.project_job_name || '';
                        const paidDateLabel = isPaid ? formatQuickBooksPaidDate(bill) : '';
                        const deiDateLabel = formatQuickBooksDeiDate(bill, invoice);
                        const rowKey = isSplitScoped ? `${bill.qbo_id}:${bill.split_scope_line_id}` : bill.qbo_id;
                        const isSplitsExpanded = Boolean(expandedSplitBills[rowKey]);
                        return (
                          <tr key={rowKey} className={`${isPaid ? 'is-paid' : isApprovedForPay ? 'is-approved-for-pay' : 'is-unpaid'} ${needsReview ? 'needs-review' : ''}`}>
                            <td>
                              <span className={`bt-qbo-status-chip ${isPaid ? 'is-paid' : isApprovedForPay ? 'is-approved-for-pay' : 'is-unpaid'}`}>
                                {isPaid ? 'Paid in Full' : isApprovedForPay ? 'Approved to Pay' : 'Waiting for Approval'}
                              </span>
                              <small>Inv# {bill.bt_invoice_number || String(bill.invoice_number || '').replace(/^NUD-/, '') || bill.doc_number || bill.qbo_id}</small>
                              <small>DEI: {deiDateLabel}</small>
                              {paidDateLabel ? <small>Paid: {paidDateLabel}</small> : null}
                              {isApprovedForPay ? <small>Pay run: Friday {qboPaymentRunLabel(bill)}</small> : null}
                              {hasPaymentMismatch ? <small className="font-bold text-amber-700">Payment mismatch: BuildTrack marked paid; QuickBooks still shows {money(bill.balance || 0)} due</small> : null}
                              {localInvoiceMarkedPaid ? <small>BuildTrack marked paid; QBO still open</small> : null}
                              {bill.vendor_receipt_notify_status === 'sent' && bill.vendor_receipt_notified_at ? (
                                <small>Contractor emailed {formatEasternDateTime(bill.vendor_receipt_notified_at, { month: 'short', day: 'numeric' })}{bill.vendor_receipt_notified_email ? ` (${bill.vendor_receipt_notified_email})` : ''}</small>
                              ) : null}
                              {bill.vendor_receipt_notify_status === 'skipped_no_email' ? (
                                <small className="font-bold text-amber-700">Pay-date email not sent: add the vendor's email in QuickBooks, sync, then press Send pay date</small>
                              ) : null}
                              {bill.vendor_receipt_notify_status === 'skipped_no_due_date' ? (
                                <small className="font-bold text-amber-700">Pay-date email not sent: set the bill's due date in QuickBooks, sync, then press Send pay date</small>
                              ) : null}
                              {bill.vendor_receipt_notify_status === 'skipped_already_paid' ? (
                                <small>Pay-date email skipped: bill already paid</small>
                              ) : null}
                              {bill.vendor_receipt_notify_status === 'skipped_stale' ? (
                                <small className="font-bold text-amber-700">Pay-date email skipped: due date already passed</small>
                              ) : null}
                              {bill.vendor_receipt_notify_status === 'failed' ? (
                                <small className="font-bold text-amber-700">Pay-date email failed - press Send pay date to retry</small>
                              ) : null}
                              {bill.vendor_receipt_notify_status === 'processing' ? (
                                <small>Pay-date email sending…</small>
                              ) : null}
                              {renderQuickBooksBillPdfControl(bill)}
                            </td>
                            <td>
                              <strong>{bill.vendor_name || 'Vendor missing'}</strong>
                              {bill.vendor_email ? <small>{bill.vendor_email}</small> : null}
                              {bill.private_note ? <small>{bill.private_note}</small> : null}
                              {isSplitScoped ? (
                                <small>Project split from bill total {money(bill.split_scope_parent_total || 0)}</small>
                              ) : splitLineCount > 1 ? (
                                <small>{splitLineCount} QBO class split lines</small>
                              ) : null}
                            </td>
                            <td>{bill.txn_date ? formatDateOnly(bill.txn_date, { month: 'short', day: 'numeric', year: 'numeric' }) : '-'}</td>
                            <td>{bill.due_date ? formatDateOnly(bill.due_date, { month: 'short', day: 'numeric', year: 'numeric' }) : '-'}</td>
                            <td className="bt-qbo-money">{money(bill.total_amt || 0)}</td>
                            <td className="bt-qbo-money">{money(bill.balance || 0)}</td>
                            <td>
                              {visibleSplitLineCount > 0 ? (
                                <>
                                  <strong>{isSplitScoped ? 'Project split matched' : splitMatched ? `${splitLineCount} class splits matched` : `${unmatchedSplitCount} class split${unmatchedSplitCount === 1 ? '' : 's'} need match`}</strong>
                                  <small>{isSplitScoped ? 'Showing only the selected project split.' : 'Approval stays on one QBO balance'}</small>
                                  <button
                                    type="button"
                                    className="bt-qbo-split-toggle"
                                    onClick={() => toggleSplitExpanded(rowKey)}
                                    aria-expanded={isSplitsExpanded}
                                  >
                                    {isSplitsExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                                    <span>{isSplitsExpanded ? 'Hide split lines' : `Show ${visibleSplitLineCount} split line${visibleSplitLineCount === 1 ? '' : 's'}`}</span>
                                  </button>
                                  {isSplitsExpanded ? (
                                    <div className="bt-qbo-split-list">
                                      {splitLines.map(line => (
                                        <div
                                          key={line.id || `${bill.qbo_id}-${line.qbo_line_id || line.line_num || line.description}`}
                                          className={`bt-qbo-split-line ${line.project_id ? 'is-matched' : 'needs-match'}`}
                                        >
                                          <span
                                            className="bt-qbo-split-line-text"
                                            title={[line.description, line.class_name ? `QBO class: ${line.class_name}` : 'No QBO class', line.category_name].filter(Boolean).join('  |  ')}
                                          >
                                            <span className="bt-qbo-split-line-label">{line.description || line.class_name || `Line ${line.line_num || ''}`.trim() || 'Split line'}</span>
                                            {line.project_id ? (
                                              <Link to={`/projects/${line.project_id}`} className="bt-qbo-split-line-proj">
                                                {line.project_address || line.project_job_name || 'Open project'}
                                              </Link>
                                            ) : (
                                              <span className="bt-qbo-split-line-proj is-need">Project match needed</span>
                                            )}
                                          </span>
                                          <strong>{money(line.amount || 0)}</strong>
                                        </div>
                                      ))}
                                    </div>
                                  ) : null}
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
                              ) : hasPaymentMismatch ? (
                                <>
                                  <strong>Payment status mismatch</strong>
                                  <small>QuickBooks remains authoritative and still reports this balance due</small>
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
                              {projectMatched || isPaid || isBuildTrackPaid ? (
                                <div className="bt-qbo-row-actions">
                                  {isPaid ? (
                                    <span className="bt-payment-run-chip is-paid">
                                      <CheckCircle2 className="h-3.5 w-3.5" />
                                      Paid in Full
                                    </span>
                                  ) : hasPaymentMismatch ? (
                                    <span className="bt-payment-run-chip border-amber-300 bg-amber-50 text-amber-800">
                                      <AlertTriangle className="h-3.5 w-3.5" />
                                      QBO still unpaid
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
                                      {approvingQboBillId === bill.qbo_id ? 'Approving...' : 'Approve to Pay'}
                                    </button>
                                  )}
                                  {payDateButton}
                                  {isSplitScoped && bill.project_id ? (
                                    <Link to={`/projects/${bill.project_id}`}>Open project</Link>
                                  ) : invoice ? (
                                    <Link to={`/projects/${invoice.project_id}/invoices/${invoice.id}`}>Open invoice</Link>
                                  ) : bill.project_id ? (
                                    <Link to={`/projects/${bill.project_id}`}>Open project</Link>
                                  ) : null}
                                  {canDeleteOpenBill ? (
                                    <button
                                      type="button"
                                      onClick={() => deleteQuickBooksOpenBill(bill)}
                                      disabled={deletingQboBillId === bill.qbo_id}
                                      title="Delete incorrect open bill from BuildTrack"
                                      className="bt-qbo-delete-open-bill-button"
                                    >
                                      <Trash2 className="h-4 w-4" />
                                      {deletingQboBillId === bill.qbo_id ? 'Deleting...' : 'Delete'}
                                    </button>
                                  ) : null}
                                </div>
                              ) : (
                                <div className="bt-qbo-row-actions">
                                  <span className="bt-qbo-unmatched">
                                    {splitLineCount > 0 ? 'Assign every class split' : 'Assign before approval'}
                                  </span>
                                  {payDateButton}
                                  {canDeleteOpenBill ? (
                                    <button
                                      type="button"
                                      onClick={() => deleteQuickBooksOpenBill(bill)}
                                      disabled={deletingQboBillId === bill.qbo_id}
                                      title="Delete incorrect open bill from BuildTrack"
                                      className="bt-qbo-delete-open-bill-button"
                                    >
                                      <Trash2 className="h-4 w-4" />
                                      {deletingQboBillId === bill.qbo_id ? 'Deleting...' : 'Delete'}
                                    </button>
                                  ) : null}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    {quickBooksMirrorRows.length > 0 && (
                      <tfoot className="bt-qbo-bill-table-foot">
                        <tr>
                          <td colSpan={5} className="bt-qbo-foot-label">
                            {selectedQuickBooksBillFilter.label} total
                            <span className="bt-qbo-foot-count">
                              {quickBooksMirrorRows.length} invoice{quickBooksMirrorRows.length === 1 ? '' : 's'}
                            </span>
                          </td>
                          <td className="bt-qbo-foot-total">{money(quickBooksVisibleOpenBalanceTotal)}</td>
                          <td colSpan={2} />
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>
            )}

            {showFridayPaymentQueuePanel && (
            <div className="bt-approved-pay-panel bt-approved-pay-panel--embedded">
              <div className="bt-approved-pay-header">
                <div>
                  <p className="text-xs font-black uppercase tracking-wide text-orange-300">Approved for payment</p>
                  <h2 className="text-lg font-black text-gray-900">Friday payment queue</h2>
                  <p className="text-sm text-gray-500">Approved invoices show here with the next biweekly Friday pay run. Once the payment is recorded in QuickBooks, the invoice moves to Paid in Full on its own.</p>
                  {canManageQuickBooks && (
                    <p className="bt-approved-pay-sync" aria-live="polite">
                      <span>
                        {queueLastCheckedAt
                          ? `Checked with QuickBooks at ${formatEasternTime(queueLastCheckedAt, { second: '2-digit' })}`
                          : 'Checked with QuickBooks every minute'}
                      </span>
                      <button type="button" onClick={checkPaymentQueueNow} disabled={checkingPaymentQueue}>
                        {checkingPaymentQueue ? 'Checking QuickBooks...' : 'Check QuickBooks now'}
                      </button>
                    </p>
                  )}
                </div>
                <div className="bt-approved-pay-actions">
                  {canManageQuickBooks && (
                    <button
                      type="button"
                      onClick={notifyApprovedPaymentQueue}
                      disabled={!approvedPaymentQueue.length || notifyingPaymentQueue}
                      className="bt-approved-pay-notify-button"
                    >
                      <Mail className="h-4 w-4" />
                      {notifyingPaymentQueue ? 'Emailing...' : 'Done Approving - Email Management'}
                    </button>
                  )}
                  <div className="bt-approved-pay-total">
                    <span>Total balance due</span>
                    <strong>{money(approvedPaymentTotal)}</strong>
                    {bankEntryCheckedCount > 0 ? (
                      <>
                        <small>{bankEntryCheckedCount} of {approvedPaymentQueue.length} entered in bank</small>
                        <button type="button" onClick={() => setBankEntryChecked({})} title="Clear your checklist ticks (does not change any invoice)">
                          Clear ticks
                        </button>
                      </>
                    ) : null}
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
                    return (
                    <article key={bill.qbo_id} className={`bt-approved-pay-card bt-approved-pay-card--checklist${bankEntryChecked[String(bill.qbo_id)] ? ' is-bank-entered' : ''}`}>
                      {/* The card is a one-row grid. The tick gets its own first
                          column so it sits in line with the pill, and the pill
                          itself becomes the yellow PAID badge when ticked. */}
                      <label className="bt-bank-entry-check" title="Tick once you have entered this payment in the bank. This is your checklist only - it does not change the invoice.">
                        <input
                          type="checkbox"
                          checked={Boolean(bankEntryChecked[String(bill.qbo_id)])}
                          onChange={() => toggleBankEntryChecked(String(bill.qbo_id))}
                          aria-label={`Entered in bank: ${bill.vendor_name || 'vendor'} ${money(bill.balance || 0)}`}
                        />
                      </label>
                      <div className="bt-approved-pay-card-top">
                        <span>{bankEntryChecked[String(bill.qbo_id)] ? 'Paid · entered in bank' : 'Approved'}</span>
                        <strong>{money(bill.balance || 0)}</strong>
                      </div>
                      <div className="bt-approved-pay-card-body">
                        <p className="bt-approved-pay-contractor">{bill.vendor_name || 'Vendor missing'}</p>
                        <p className="bt-approved-pay-meta">Inv# {bill.bt_invoice_number || String(bill.invoice_number || '').replace(/^NUD-/, '') || bill.doc_number || bill.qbo_id}</p>
                        <p className="bt-approved-pay-project">{invoice?.address || bill.project_address || bill.project_job_name || 'Project not listed'}</p>
                        <p className="bt-approved-pay-meta">Pay run: Friday {qboPaymentRunLabel(bill)}</p>
                        <p className="bt-approved-pay-meta">
                          {bill.payment_approval_notified_at
                            ? `Management emailed ${formatEasternDateTime(bill.payment_approval_notified_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                            : 'Management email not sent yet'}
                        </p>
                      </div>
                      {canManageQuickBooks && (
                        <div className="bt-approved-pay-card-bottom">
                          <button
                            type="button"
                            className="bt-approved-pay-paid-button"
                            onClick={() => markQuickBooksBillPaidFromQueue(bill)}
                            disabled={markingQboPaidId === bill.qbo_id}
                          >
                            <CheckCircle2 className="h-4 w-4" />
                            {markingQboPaidId === bill.qbo_id ? 'Checking QBO...' : 'Verify QBO Paid'}
                          </button>
                          <button
                            type="button"
                            onClick={() => removeQuickBooksBillFromPay(bill)}
                            disabled={removingQboBillId === bill.qbo_id}
                          >
                            {removingQboBillId === bill.qbo_id ? 'Removing...' : 'Remove from queue'}
                          </button>
                        </div>
                      )}
                    </article>
                    );
                  })}
                </div>
              )}
            </div>
            )}
          </section>
        )}

        {isAdminRole(user?.role || '') && (
          <InvoiceMonitorPanel canManage={['super_admin', 'operations_manager'].includes(user?.role || '')} />
        )}

        {isAdminRole(user?.role || '') && renderInvoiceQueue()}

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
                {isPdfAttachment(attachmentPreview.attachment) && attachmentPreviewUrl ? (
                  <a
                    href={attachmentPreviewUrl}
                    download={invoicePdfDownloadName(attachmentPreview.attachment.original_name || 'invoice attachment.pdf')}
                    className="bt-invoice-modal-action"
                    title="Download invoice PDF"
                  >
                    <Download className="h-4 w-4" />
                    Download
                  </a>
                ) : null}
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

      {qboPdfPreview && (
        <div
          className="bt-invoice-pdf-viewer-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`PDF viewer for ${qboPdfPreview.title || 'invoice PDF'}`}
          onClick={() => setQboPdfPreview(null)}
        >
          <div className="bt-invoice-pdf-viewer-panel" onClick={event => event.stopPropagation()}>
            <div className="bt-invoice-pdf-viewer-header">
              <div className="bt-invoice-pdf-title">
                <span>Invoice Document Viewer</span>
                <strong>{qboPdfPreview.title || 'Invoice document'}</strong>
                <small>
                  {qboPdfPreview.mime_type || 'application/pdf'}
                  {qboPdfPreview.size_label ? ` - ${qboPdfPreview.size_label}` : ''}
                </small>
              </div>
              <div className="bt-invoice-pdf-toolbar" aria-label="PDF viewer controls">
                <div className="bt-invoice-pdf-control-group" aria-label="Page controls">
                  <button
                    type="button"
                    onClick={() => updateQboPdfViewer({ page: qboPdfPreview.page - 1 })}
                    disabled={qboPdfPreview.page <= 1}
                    aria-label="Previous page"
                    title="Previous page"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <label>
                    <span>Page</span>
                    <input
                      type="number"
                      min={1}
                      value={qboPdfPreview.page}
                      onChange={event => updateQboPdfViewer({ page: Number(event.target.value || 1) })}
                      aria-label="PDF page number"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => updateQboPdfViewer({ page: qboPdfPreview.page + 1 })}
                    aria-label="Next page"
                    title="Next page"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
                <div className="bt-invoice-pdf-control-group" aria-label="Zoom controls">
                  <button
                    type="button"
                    onClick={() => updateQboPdfViewer({ zoom: qboPdfPreview.zoom - 10 })}
                    disabled={qboPdfPreview.zoom <= 25}
                    aria-label="Zoom out"
                    title="Zoom out"
                  >
                    <ZoomOut className="h-4 w-4" />
                  </button>
                  <strong>{qboPdfPreview.zoom}%</strong>
                  <button
                    type="button"
                    onClick={() => updateQboPdfViewer({ zoom: qboPdfPreview.zoom + 10 })}
                    disabled={qboPdfPreview.zoom >= 200}
                    aria-label="Zoom in"
                    title="Zoom in"
                  >
                    <ZoomIn className="h-4 w-4" />
                  </button>
                </div>
                {qboPdfPreviewUrl ? (
                  <a
                    href={qboPdfPreviewUrl}
                    className="bt-invoice-pdf-open-link"
                    target="_blank"
                    rel="noreferrer"
                    title="Open PDF in a new tab"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Open
                  </a>
                ) : null}
                {qboPdfPreviewUrl ? (
                  <a
                    href={qboPdfPreviewUrl}
                    download={invoicePdfDownloadName(qboPdfPreview.filename || qboPdfPreview.title)}
                    className="bt-invoice-pdf-open-link"
                    title="Download invoice PDF"
                  >
                    <Download className="h-4 w-4" />
                    Download
                  </a>
                ) : null}
                <button
                  type="button"
                  className="bt-invoice-pdf-close"
                  onClick={() => setQboPdfPreview(null)}
                  aria-label="Close invoice PDF preview"
                  title="Close viewer"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <div className="bt-invoice-pdf-viewer-body">
              {qboPdfPreviewLoading ? (
                <div className="bt-invoice-attachment-fallback">
                  <FileText className="h-10 w-10" />
                  <p>Loading invoice PDF...</p>
                </div>
              ) : qboPdfPreviewError ? (
                <div className="bt-invoice-attachment-fallback">
                  <FileText className="h-10 w-10" />
                  <p>{qboPdfPreviewError}</p>
                </div>
              ) : qboPdfPreviewIsImage && qboPdfPreviewUrl ? (
                <div className="bt-invoice-pdf-image-stage">
                  <img
                    src={qboPdfPreviewUrl}
                    alt={qboPdfPreview.title || 'Invoice document preview'}
                    style={{ width: `${qboPdfPreview.zoom}%` }}
                  />
                </div>
              ) : qboPdfFrameSrc ? (
                <iframe
                  key={`${qboPdfPreview.page}-${qboPdfPreview.zoom}`}
                  title={qboPdfPreview.title || 'Invoice PDF'}
                  src={qboPdfFrameSrc}
                />
              ) : (
                <div className="bt-invoice-attachment-fallback">
                  <FileText className="h-10 w-10" />
                  <p>No invoice PDF preview is available.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
