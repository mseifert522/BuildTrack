import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../lib/api';
import { Loading } from '../components/ui';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Download,
  Eye,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Mail,
  Paperclip,
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
import { formatDateOnly, formatEasternDate, formatEasternDateTime, parseBuildTrackTimestamp } from '../lib/time';

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
type QuickBooksInvoiceFilterMode = 'all' | 'project' | 'project_date_range' | 'project_vendor' | 'project_vendor_date_range' | 'project_specific_date' | 'vendor_only';
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
const DEFAULT_QUICKBOOKS_INVOICE_FILTER: QuickBooksInvoiceFilterState = {
  mode: 'all',
  projectId: '',
  vendor: '',
  startDate: '',
  endDate: '',
  exactDate: '',
};
const DEFAULT_QUICKBOOKS_INVOICE_SORT: QuickBooksInvoiceSortState = {
  key: 'bill_date',
  direction: 'desc',
};
const QUICKBOOKS_INVOICE_FILTER_OPTIONS: { value: QuickBooksInvoiceFilterMode; label: string }[] = [
  { value: 'all', label: 'No project filter' },
  { value: 'project', label: 'Project only' },
  { value: 'project_date_range', label: 'Project + date range' },
  { value: 'project_vendor', label: 'Project + Vendor / Suppliers' },
  { value: 'project_vendor_date_range', label: 'Project + Vendor / Suppliers + date range' },
  { value: 'project_specific_date', label: 'Project + specific date' },
  { value: 'vendor_only', label: 'Vendor / Suppliers Only' },
];
const QUICKBOOKS_FILTER_PROJECT_MODES = new Set<QuickBooksInvoiceFilterMode>(['project', 'project_date_range', 'project_vendor', 'project_vendor_date_range', 'project_specific_date']);
const QUICKBOOKS_FILTER_VENDOR_MODES = new Set<QuickBooksInvoiceFilterMode>(['project_vendor', 'project_vendor_date_range', 'vendor_only']);
const QUICKBOOKS_FILTER_DATE_RANGE_MODES = new Set<QuickBooksInvoiceFilterMode>(['project_date_range', 'project_vendor_date_range']);
const QUICKBOOKS_FILTER_EXACT_DATE_MODES = new Set<QuickBooksInvoiceFilterMode>(['project_specific_date']);
const DEFAULT_QUICKBOOKS_INVOICE_YEAR = new Date().getFullYear();

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
  if (filter === 'paid') return paid;
  if (filter === 'friday_queue') return !paid && bill.payment_approval_status === 'approved_for_payment';
  if (filter === 'open') return !paid && bill.payment_approval_status !== 'approved_for_payment';
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
  if (QUICKBOOKS_FILTER_PROJECT_MODES.has(filter.mode)) {
    if (!filter.projectId) return false;
    if (!quickBooksBillMatchesProject(bill, invoice, filter.projectId)) return false;
  }
  if (QUICKBOOKS_FILTER_VENDOR_MODES.has(filter.mode)) {
    if (!filter.vendor) return false;
    if (!quickBooksBillMatchesVendorSupplier(bill, filter.vendor, vendorSupplierAliasMap)) return false;
  }
  if (QUICKBOOKS_FILTER_DATE_RANGE_MODES.has(filter.mode)) {
    if (!filter.startDate && !filter.endDate) return false;
    if (!quickBooksBillMatchesDateRange(bill, filter.startDate, filter.endDate)) return false;
  }
  if (QUICKBOOKS_FILTER_EXACT_DATE_MODES.has(filter.mode)) {
    if (!filter.exactDate) return false;
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
  const [expandedEmailIds, setExpandedEmailIds] = useState<Record<string, boolean>>({});
  const [assignmentDrafts, setAssignmentDrafts] = useState<Record<string, AssignmentDraft>>({});
  const [assignmentOptions, setAssignmentOptions] = useState<Record<string, AssignmentOptions>>({});
  const [filingEmailId, setFilingEmailId] = useState<string | null>(null);
  const [ignoringEmailId, setIgnoringEmailId] = useState<string | null>(null);
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
  const [quickBooksInvoiceSort, setQuickBooksInvoiceSort] = useState<QuickBooksInvoiceSortState | null>(null);
  const [approvingQboBillId, setApprovingQboBillId] = useState<string | null>(null);
  const [removingQboBillId, setRemovingQboBillId] = useState<string | null>(null);
  const [deletingQboBillId, setDeletingQboBillId] = useState<string | null>(null);
  const [uploadingQboBillPdfId, setUploadingQboBillPdfId] = useState<string | null>(null);
  const [draggingQboBillPdfId, setDraggingQboBillPdfId] = useState<string | null>(null);
  const [notifyingPaymentQueue, setNotifyingPaymentQueue] = useState(false);
  const canReadQuickBooksStatus = isAdminRole(user?.role || '');
  const canManageQuickBooks = Boolean(user?.role && QUICKBOOKS_PANEL_ROLES.includes(user.role));

  const load = async () => {
    setLoading(true);
    try {
      const [projectRes, invoiceRes, qboStatusRes, qboBillsRes, contractorSupplierRes] = await Promise.all([
        api.get('/projects'),
        api.get('/invoices'),
        canReadQuickBooksStatus ? api.get('/quickbooks/status').catch(() => ({ data: null })) : Promise.resolve({ data: null }),
        canManageQuickBooks
          ? api.get(QUICKBOOKS_BILLS_PATH).catch(() => ({ data: [] }))
          : Promise.resolve({ data: [] }),
        canManageQuickBooks
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
      .filter(bill => !isQuickBooksBillPaid(bill) && bill.payment_approval_status === 'approved_for_payment')
      .sort((a, b) => {
        const dateCompare = String(a.payment_run_date || '').localeCompare(String(b.payment_run_date || ''));
        if (dateCompare !== 0) return dateCompare;
        return Number(b.balance || 0) - Number(a.balance || 0);
      }),
    [quickBooksBills]
  );
  const approvedPaymentTotal = approvedPaymentQueue.reduce((sum, bill) => sum + Number(bill.balance || 0), 0);
  const invoiceById = useMemo(() => new Map(invoices.map(invoice => [invoice.id, invoice])), [invoices]);
  const projectById = useMemo(() => new Map(projects.map(project => [project.id, project])), [projects]);
  const allQuickBooksBills = useMemo(() => sortQuickBooksBillsByBillDate(quickBooksBills), [quickBooksBills]);
  const quickBooksAllMirrorRows = useMemo(() => allQuickBooksBills.map(bill => ({
    bill,
    invoice: bill.matched_invoice_id ? invoiceById.get(bill.matched_invoice_id) || null : null,
  })), [allQuickBooksBills, invoiceById]);
  const quickBooksDefaultYearMirrorRows = useMemo(() => (
    quickBooksAllMirrorRows.filter(({ bill }) => quickBooksBillMatchesYear(bill, DEFAULT_QUICKBOOKS_INVOICE_YEAR))
  ), [quickBooksAllMirrorRows]);
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

    return Array.from(options.values()).sort((a, b) => a.label.localeCompare(b.label));
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
  const quickBooksInvoiceFilterReady = quickBooksInvoiceFilter.mode === 'all' || (
    (!quickBooksInvoiceFilterNeedsProject || Boolean(quickBooksInvoiceFilter.projectId))
    && (!quickBooksInvoiceFilterNeedsVendor || Boolean(quickBooksInvoiceFilter.vendor))
    && (!quickBooksInvoiceFilterNeedsDateRange || Boolean(quickBooksInvoiceFilter.startDate || quickBooksInvoiceFilter.endDate))
    && (!quickBooksInvoiceFilterNeedsExactDate || Boolean(quickBooksInvoiceFilter.exactDate))
  );
  const quickBooksInvoiceFilterInUse = quickBooksInvoiceFilter.mode !== 'all';
  const quickBooksInvoiceFilterActive = quickBooksInvoiceFilter.mode !== 'all' && quickBooksInvoiceFilterReady;
  const quickBooksEffectiveInvoiceSort = quickBooksInvoiceSort || (
    quickBooksInvoiceFilterInUse || deferredQuickBooksBillFilter === 'all' || deferredQuickBooksBillFilter === 'open'
      ? DEFAULT_QUICKBOOKS_INVOICE_SORT
      : null
  );
  const quickBooksInvoiceScopeRows = useMemo(() => {
    const baseRows = quickBooksInvoiceFilter.mode === 'all' ? quickBooksDefaultYearMirrorRows : quickBooksAllMirrorRows;
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
  }, [quickBooksAllMirrorRows, quickBooksDefaultYearMirrorRows, quickBooksInvoiceFilter, quickBooksInvoiceFilterNeedsProject, quickBooksVendorSupplierAliasMap]);
  const quickBooksStatusScopedRows = useMemo<Record<QuickBooksBillFilter, QuickBooksMirrorRow[]>>(() => ({
    open: quickBooksInvoiceScopeRows.filter(({ bill }) => quickBooksBillMatchesStatusFilter(bill, 'open')),
    friday_queue: quickBooksInvoiceScopeRows.filter(({ bill }) => quickBooksBillMatchesStatusFilter(bill, 'friday_queue')),
    paid: quickBooksInvoiceScopeRows.filter(({ bill }) => quickBooksBillMatchesStatusFilter(bill, 'paid')),
    all: quickBooksInvoiceScopeRows,
  }), [quickBooksInvoiceScopeRows]);
  const quickBooksBillFilterMeta: Record<QuickBooksBillFilter, { label: string; title: string; subtitle: string; count: number }> = {
    open: {
      label: 'Open bills',
      title: 'QuickBooks open bills',
      subtitle: 'Unpaid bills not yet approved for the Friday payment queue',
      count: quickBooksStatusScopedRows.open.length,
    },
    friday_queue: {
      label: 'Approved bills',
      title: 'Friday payment queue',
      subtitle: 'Approved unpaid bills waiting for QuickBooks payment',
      count: quickBooksStatusScopedRows.friday_queue.length,
    },
    paid: {
      label: 'Paid bills',
      title: 'Paid QuickBooks bills',
      subtitle: 'Latest paid bills first by QuickBooks payment date and time',
      count: quickBooksStatusScopedRows.paid.length,
    },
    all: {
      label: 'Total bills',
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
  const quickBooksInvoiceFilterPrompt = quickBooksInvoiceFilter.mode === 'all'
    ? `${DEFAULT_QUICKBOOKS_INVOICE_YEAR} invoices`
    : quickBooksInvoiceFilterNeedsProject && !quickBooksInvoiceFilter.projectId
      ? 'Select project'
      : quickBooksInvoiceFilterNeedsVendor && !quickBooksInvoiceFilter.vendor
        ? 'Select vendor / supplier'
        : quickBooksInvoiceFilterNeedsDateRange && !quickBooksInvoiceFilter.startDate && !quickBooksInvoiceFilter.endDate
          ? 'Select date range'
          : quickBooksInvoiceFilterNeedsExactDate && !quickBooksInvoiceFilter.exactDate
            ? 'Select bill date'
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
      ? `${quickBooksMirrorRows.length} Awaiting Approval`
      : deferredQuickBooksBillFilter === 'friday_queue'
        ? `${quickBooksMirrorRows.length} Approved`
        : deferredQuickBooksBillFilter === 'paid'
          ? `${quickBooksMirrorRows.length} Paid`
          : `${quickBooksMirrorRows.length} Total`;
  const showFridayPaymentQueuePanel = deferredQuickBooksBillFilter === 'open' && !quickBooksInvoiceFilterInUse;
  const clearQuickBooksInvoiceFilter = () => {
    setQuickBooksInvoiceFilter({ ...DEFAULT_QUICKBOOKS_INVOICE_FILTER });
    setQuickBooksBillFilter('open');
    setQuickBooksInvoiceSort(null);
  };
  const updateQuickBooksInvoiceFilter = (patch: Partial<QuickBooksInvoiceFilterState>) => {
    setQuickBooksInvoiceFilter(current => ({ ...current, ...patch }));
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
        className={`inline-flex items-center gap-1 bg-transparent p-0 text-left font-black uppercase tracking-wide transition ${activeSort ? 'text-white' : 'text-orange-300 hover:text-white'}`}
        onClick={() => updateQuickBooksInvoiceSort(key)}
        title={`Sort by ${label}`}
      >
        <span>{label}</span>
        <SortIcon className={`h-3.5 w-3.5 ${activeSort ? 'opacity-100' : 'opacity-60'}`} />
      </button>
    );
  };
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

  const qboPdfFrameSrc = qboPdfPreviewUrl && qboPdfPreview
    ? `${qboPdfPreviewUrl}#page=${Math.max(1, qboPdfPreview.page)}&zoom=${qboPdfPreview.zoom}&toolbar=0&navpanes=0&scrollbar=1`
    : '';

  const updateQboPdfViewer = (patch: Partial<Pick<InvoicePdfPreviewState, 'page' | 'zoom'>>) => {
    setQboPdfPreview(current => {
      if (!current) return current;
      const page = patch.page !== undefined ? Math.max(1, Math.floor(patch.page || 1)) : current.page;
      const zoom = patch.zoom !== undefined ? Math.max(50, Math.min(250, Math.round(patch.zoom))) : current.zoom;
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
      zoom: 115,
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

  const canDeleteQuickBooksOpenBill = (bill: QuickBooksBill) => (
    canManageQuickBooks
    && !isQuickBooksBillPaid(bill)
    && bill.payment_approval_status !== 'approved_for_payment'
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
    <div className="bt-desktop-page bt-invoices-light min-h-full px-6 py-6 md:px-8">
      <div className={`${quickBooksInvoiceFilterInUse ? 'bt-invoice-filter-results-layout max-w-none' : 'max-w-7xl'} mx-auto space-y-5`}>
        {canManageQuickBooks && (
          <section className={`bt-invoice-section bt-qbo-mirror-section ${quickBooksInvoiceFilterInUse ? 'is-filter-results' : ''}`}>
            <div className="bt-qbo-status-row bt-qbo-kpi-row">
              <div>
                <span>Last sync</span>
                <strong>{quickBooksStatus?.connection?.last_sync_at ? formatEasternDateTime(quickBooksStatus.connection.last_sync_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not synced yet'}</strong>
                <small>{quickBooksStatus?.connection?.last_sync_status || 'Waiting'}</small>
              </div>
              <button
                type="button"
                onClick={() => updateQuickBooksBillFilter('friday_queue')}
                className={quickBooksBillFilter === 'friday_queue' ? 'is-active' : ''}
              >
                <span>Approved bills</span>
                <strong>{quickBooksBillFilterMeta.friday_queue.count}</strong>
                <small>{money(quickBooksScopedApprovedPaymentTotal)} due</small>
              </button>
              <button
                type="button"
                onClick={() => updateQuickBooksBillFilter('paid')}
                className={quickBooksBillFilter === 'paid' ? 'is-active' : ''}
              >
                <span>Paid bills</span>
                <strong>{quickBooksBillFilterMeta.paid.count}</strong>
                <small>{money(quickBooksScopedPaidTotal)} paid</small>
              </button>
              <button
                type="button"
                onClick={() => updateQuickBooksBillFilter('all')}
                className={quickBooksBillFilter === 'all' ? 'is-active' : ''}
              >
                <span>Total bills</span>
                <strong>{quickBooksBillFilterMeta.all.count}</strong>
                <small>{quickBooksScopedOpenCount} open</small>
              </button>
            </div>

            <div className="bt-qbo-filter-row mx-4 mt-3 flex flex-wrap items-center gap-2">
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
                      <option value="">Select vendor / supplier</option>
                      {quickBooksVendorSupplierFilterOptions.map(option => (
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
                {quickBooksInvoiceFilter.mode !== 'all' && (
                  <button type="button" className="bt-qbo-clear-invoice-filter" onClick={clearQuickBooksInvoiceFilter}>
                    <X className="h-3.5 w-3.5" />
                    Clear
                  </button>
                )}
              </div>
            </div>

            {quickBooksStatus?.connection?.last_sync_error && (
              <div className="mt-3 mx-4 flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm font-semibold text-red-100">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>{quickBooksStatus.connection.last_sync_error}</span>
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
                    ? 'Select the required invoice filter fields to show paid and unpaid invoices.'
                    : quickBooksInvoiceFilterActive
                      ? `No paid or unpaid invoices match this ${quickBooksInvoiceFilterScope} filter right now.`
                      : `No ${selectedQuickBooksBillFilter.label.toLowerCase()} are showing right now.`}
                </p>
              </div>
            ) : (
              <div className="bt-qbo-table-shell">
                <div className="bt-qbo-table-title">
                  <div>
                    <strong>{quickBooksTableCountLabel}</strong>
                  </div>
                </div>
                <div className="bt-qbo-table-wrap">
                  <table className="bt-qbo-bill-table">
                    <thead>
                      <tr>
                        <th aria-sort={quickBooksSortAria('status')}>{renderQuickBooksSortableHeader('status', 'Status')}</th>
                        <th aria-sort={quickBooksSortAria('vendor')}>{renderQuickBooksSortableHeader('vendor', 'Vendor')}</th>
                        <th aria-sort={quickBooksSortAria('bill_date')}>{renderQuickBooksSortableHeader('bill_date', 'Bill date')}</th>
                        <th aria-sort={quickBooksSortAria('due_date')}>{renderQuickBooksSortableHeader('due_date', 'Due date')}</th>
                        <th aria-sort={quickBooksSortAria('bill_amount')}>{renderQuickBooksSortableHeader('bill_amount', 'Bill amount')}</th>
                        <th aria-sort={quickBooksSortAria('open_balance')}>{renderQuickBooksSortableHeader('open_balance', 'Open balance')}</th>
                        <th>BuildTrack match</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {quickBooksMirrorRows.map(({ bill, invoice }) => {
                        const isPaid = isQuickBooksBillPaid(bill);
                        const isApprovedForPay = bill.payment_approval_status === 'approved_for_payment' && !isPaid;
                        const localInvoiceMarkedPaid = Boolean(!isPaid && invoice && (invoice.status === 'paid' || invoice.quickbooks_payment_status === 'paid'));
                        const splitLines = quickBooksVisibleSplitLines(bill);
                        const visibleSplitLineCount = splitLines.length;
                        const splitLineCount = quickBooksSplitLineCount(bill);
                        const unmatchedSplitCount = quickBooksUnmatchedSplitLineCount(bill);
                        const splitMatched = quickBooksBillSplitMatched(bill);
                        const isSplitScoped = Boolean(bill.split_scope_line_id);
                        const projectMatched = quickBooksBillHasApprovalMatch(bill, invoice);
                        const needsReview = !projectMatched && !isPaid;
                        const canDeleteOpenBill = canDeleteQuickBooksOpenBill(bill);
                        const matchAddress = isSplitScoped ? bill.project_address || invoice?.address || '' : invoice?.address || bill.project_address || '';
                        const matchName = isSplitScoped ? bill.project_job_name || invoice?.job_name || '' : invoice?.job_name || bill.project_job_name || '';
                        const paidDateLabel = isPaid ? formatQuickBooksPaidDate(bill) : '';
                        const deiDateLabel = formatQuickBooksDeiDate(bill, invoice);
                        const rowKey = isSplitScoped ? `${bill.qbo_id}:${bill.split_scope_line_id}` : bill.qbo_id;
                        return (
                          <tr key={rowKey} className={`${isPaid ? 'is-paid' : isApprovedForPay ? 'is-approved-for-pay' : 'is-unpaid'} ${needsReview ? 'needs-review' : ''}`}>
                            <td>
                              <span className={`bt-qbo-status-chip ${isPaid ? 'is-paid' : isApprovedForPay ? 'is-approved-for-pay' : 'is-unpaid'}`}>
                                {isApprovedForPay ? 'Queued' : qboStatusLabel(bill.payment_status)}
                              </span>
                              <small>QBO #{bill.doc_number || bill.qbo_id}</small>
                              <small>DEI: {deiDateLabel}</small>
                              {paidDateLabel ? <small>Paid: {paidDateLabel}</small> : null}
                              {isApprovedForPay ? <small>Pay run: Friday {qboPaymentRunLabel(bill)}</small> : null}
                              {localInvoiceMarkedPaid ? <small>BuildTrack marked paid; QBO still open</small> : null}
                              {renderQuickBooksBillPdfControl(bill)}
                            </td>
                            <td>
                              <strong>{bill.vendor_name || 'Vendor missing'}</strong>
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
                                  {isSplitScoped && bill.project_id ? (
                                    <Link to={`/projects/${bill.project_id}`}>Open project</Link>
                                  ) : invoice ? (
                                    <Link to={`/projects/${invoice.project_id}/invoices/${invoice.id}`}>Open invoice</Link>
                                  ) : bill.project_id ? (
                                    <Link to={`/projects/${bill.project_id}`}>Open project</Link>
                                  ) : splitLineCount > 0 ? (
                                    <span className="bt-qbo-split-summary-chip">{splitLineCount} project splits</span>
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
                <span>Invoice PDF Viewer</span>
                <strong>{qboPdfPreview.title || 'Invoice PDF'}</strong>
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
                    onClick={() => updateQboPdfViewer({ zoom: qboPdfPreview.zoom - 15 })}
                    disabled={qboPdfPreview.zoom <= 50}
                    aria-label="Zoom out"
                    title="Zoom out"
                  >
                    <ZoomOut className="h-4 w-4" />
                  </button>
                  <strong>{qboPdfPreview.zoom}%</strong>
                  <button
                    type="button"
                    onClick={() => updateQboPdfViewer({ zoom: qboPdfPreview.zoom + 15 })}
                    disabled={qboPdfPreview.zoom >= 250}
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
              ) : qboPdfFrameSrc ? (
                <iframe title={qboPdfPreview.title || 'Invoice PDF'} src={qboPdfFrameSrc} />
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
