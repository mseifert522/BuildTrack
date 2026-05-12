import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../lib/api';
import { Loading } from '../components/ui';
import {
  ArrowLeft,
  Building2,
  CheckCircle2,
  ChevronRight,
  Download,
  FileText,
  Receipt,
  Search,
  WalletCards,
} from 'lucide-react';
import { format } from 'date-fns';
import { useAuthStore, isAdminRole } from '../store/authStore';
import toast from 'react-hot-toast';

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
}

interface ProjectOption {
  id: string;
  address: string;
  job_name: string;
  status: string;
  updated_at?: string;
}

const money = (value: number) =>
  Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

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

const tabOptions = [
  { value: '', label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'reviewed', label: 'Reviewed' },
  { value: 'approved', label: 'Approved' },
  { value: 'paid', label: 'Paid' },
];

export default function Invoices() {
  const { user } = useAuthStore();
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [updatingInvoiceId, setUpdatingInvoiceId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [projectRes, invoiceRes] = await Promise.all([
        api.get('/projects'),
        api.get('/invoices'),
      ]);
      setProjects(Array.isArray(projectRes.data) ? projectRes.data : []);
      setInvoices(Array.isArray(invoiceRes.data) ? invoiceRes.data : []);
    } catch {
      toast.error('Failed to load invoices');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const selectedProject = projects.find(project => project.id === selectedProjectId) || null;

  const projectSummaries = useMemo(() => {
    const byProject = new Map(projects.map(project => [project.id, {
      ...project,
      invoice_count: 0,
      total: 0,
      open_total: 0,
      paid_total: 0,
      new_count: 0,
      paid_count: 0,
      latest_at: project.updated_at || '',
    }]));

    invoices.forEach(invoice => {
      const existing = byProject.get(invoice.project_id) || {
        id: invoice.project_id,
        address: invoice.address,
        job_name: invoice.job_name,
        status: '',
        invoice_count: 0,
        total: 0,
        open_total: 0,
        paid_total: 0,
        new_count: 0,
        paid_count: 0,
        latest_at: '',
      };
      existing.invoice_count += 1;
      existing.total += Number(invoice.total || 0);
      if (invoice.status === 'paid') {
        existing.paid_total += Number(invoice.total || 0);
        existing.paid_count += 1;
      } else {
        existing.open_total += Number(invoice.total || 0);
      }
      if (invoice.status === 'draft' || invoice.status === 'submitted') existing.new_count += 1;
      const invoiceDate = invoice.updated_at || invoice.submitted_at || invoice.created_at || '';
      if (!existing.latest_at || new Date(invoiceDate).getTime() > new Date(existing.latest_at).getTime()) {
        existing.latest_at = invoiceDate;
      }
      byProject.set(invoice.project_id, existing);
    });

    const q = projectSearch.trim().toLowerCase();
    return Array.from(byProject.values())
      .filter(project => !q || `${project.address} ${project.job_name}`.toLowerCase().includes(q))
      .sort((a, b) => {
        if (b.invoice_count !== a.invoice_count) return b.invoice_count - a.invoice_count;
        return String(a.address || '').localeCompare(String(b.address || ''));
      });
  }, [projects, invoices, projectSearch]);

  const selectedInvoices = useMemo(() => {
    const rows = invoices.filter(invoice => invoice.project_id === selectedProjectId);
    return rows.filter(invoice => {
      if (!statusFilter) return true;
      if (statusFilter === 'new') return invoice.status === 'draft' || invoice.status === 'submitted';
      return invoice.status === statusFilter;
    });
  }, [invoices, selectedProjectId, statusFilter]);

  const projectInvoiceTotals = useMemo(() => ({
    all: invoices.filter(invoice => invoice.project_id === selectedProjectId).length,
    new: invoices.filter(invoice => invoice.project_id === selectedProjectId && ['draft', 'submitted'].includes(invoice.status)).length,
    reviewed: invoices.filter(invoice => invoice.project_id === selectedProjectId && invoice.status === 'reviewed').length,
    approved: invoices.filter(invoice => invoice.project_id === selectedProjectId && invoice.status === 'approved').length,
    paid: invoices.filter(invoice => invoice.project_id === selectedProjectId && invoice.status === 'paid').length,
  }), [invoices, selectedProjectId]);

  const visibleTotal = selectedInvoices.reduce((sum, invoice) => sum + Number(invoice.total || 0), 0);
  const invoiceStats = useMemo(() => {
    const openStatuses = new Set(['draft', 'submitted', 'reviewed', 'approved']);
    const openInvoices = invoices.filter(invoice => openStatuses.has(invoice.status));
    const paidInvoices = invoices.filter(invoice => invoice.status === 'paid');
    const newInvoices = invoices.filter(invoice => invoice.status === 'draft' || invoice.status === 'submitted');
    const approvedInvoices = invoices.filter(invoice => invoice.status === 'approved');
    return {
      openAmount: openInvoices.reduce((sum, invoice) => sum + Number(invoice.total || 0), 0),
      paidAmount: paidInvoices.reduce((sum, invoice) => sum + Number(invoice.total || 0), 0),
      newAmount: newInvoices.reduce((sum, invoice) => sum + Number(invoice.total || 0), 0),
      approvedAmount: approvedInvoices.reduce((sum, invoice) => sum + Number(invoice.total || 0), 0),
      invoiceCount: invoices.length,
      openCount: openInvoices.length,
      paidCount: paidInvoices.length,
      newCount: newInvoices.length,
      projectCount: new Set(invoices.map(invoice => invoice.project_id)).size,
    };
  }, [invoices]);

  const updateStatus = async (invoice: Invoice, status: string) => {
    if (!isAdminRole(user?.role || '') || invoice.status === status) return;
    setUpdatingInvoiceId(invoice.id);
    try {
      await api.put(`/projects/${invoice.project_id}/invoices/${invoice.id}/status`, { status });
      setInvoices(prev => prev.map(item => item.id === invoice.id ? { ...item, status, updated_at: new Date().toISOString() } : item));
      toast.success(status === 'paid' ? 'Invoice marked paid' : 'Invoice status updated');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update invoice status');
    } finally {
      setUpdatingInvoiceId(null);
    }
  };

  const downloadPDF = async (invoice: Invoice) => {
    try {
      const res = await api.get(`/projects/${invoice.project_id}/invoices/${invoice.id}/pdf`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `invoice-${invoice.invoice_number}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Failed to download PDF');
    }
  };

  if (loading) return <Loading />;

  return (
    <div className="min-h-full px-6 py-6 md:px-8" style={{ background: '#F0F2F5' }}>
      <div className="max-w-7xl mx-auto space-y-5">
        <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3">
          {[
            {
              label: 'Open Invoice Exposure',
              value: money(invoiceStats.openAmount),
              sub: `${invoiceStats.openCount} invoice${invoiceStats.openCount !== 1 ? 's' : ''} not paid`,
              icon: WalletCards,
              bg: '#EFF6FF',
              color: '#1D4ED8',
            },
            {
              label: 'New Invoices',
              value: money(invoiceStats.newAmount),
              sub: `${invoiceStats.newCount} awaiting review`,
              icon: Receipt,
              bg: '#FFF7ED',
              color: '#C2410C',
            },
            {
              label: 'Approved To Pay',
              value: money(invoiceStats.approvedAmount),
              sub: 'Ready for payment action',
              icon: CheckCircle2,
              bg: '#ECFDF5',
              color: '#047857',
            },
            {
              label: 'Paid To Date',
              value: money(invoiceStats.paidAmount),
              sub: `${invoiceStats.paidCount} paid invoices`,
              icon: FileText,
              bg: '#F5F3FF',
              color: '#6D28D9',
            },
          ].map(card => (
            <div key={card.label} className="rounded-2xl border border-gray-200 p-4" style={{ background: 'white', boxShadow: '0 8px 24px rgba(17,24,39,0.06)' }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-black uppercase tracking-wide text-gray-500">{card.label}</p>
                  <p className="mt-2 text-2xl font-black text-gray-900 truncate">{card.value}</p>
                  <p className="mt-1 text-xs font-semibold text-gray-500">{card.sub}</p>
                </div>
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: card.bg, color: card.color }}>
                  <card.icon className="w-5 h-5" />
                </div>
              </div>
            </div>
          ))}
        </div>

        {!selectedProject ? (
          <>
            <div className="flex flex-col xl:flex-row xl:items-end xl:justify-between gap-4">
              <div>
                <h1 className="text-2xl font-black text-gray-900 tracking-tight">Invoices</h1>
                <p className="text-sm text-gray-500 mt-1">
                  {invoiceStats.invoiceCount} invoices across {invoiceStats.projectCount} project{invoiceStats.projectCount !== 1 ? 's' : ''}. Select a project first, then review that project&apos;s invoice status and payment queue.
                </p>
              </div>
              <div
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl w-full xl:w-[460px]"
                style={{ background: 'white', border: '1px solid #D1D5DB', boxShadow: '0 8px 24px rgba(17,24,39,0.06)' }}
              >
                <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
                <input
                  value={projectSearch}
                  onChange={e => setProjectSearch(e.target.value)}
                  placeholder="Search projects by address or job name"
                  className="w-full bg-transparent text-sm outline-none text-gray-900 placeholder:text-gray-500"
                />
              </div>
            </div>

            <div className="rounded-2xl overflow-hidden border border-gray-200" style={{ background: 'white', boxShadow: '0 10px 30px rgba(17,24,39,0.08)' }}>
              <div className="grid grid-cols-12 px-5 py-3 text-xs font-black uppercase tracking-wide text-gray-500 border-b border-gray-100 bg-gray-50">
                <div className="col-span-5">Project Address</div>
                <div className="col-span-2 text-right">Invoices</div>
                <div className="col-span-2 text-right">Open Amount</div>
                <div className="col-span-2 text-right">Paid Amount</div>
                <div className="col-span-1" />
              </div>

              {projectSummaries.length === 0 ? (
                <div className="text-center py-16">
                  <Building2 className="w-10 h-10 text-gray-300 mx-auto mb-3" />
                  <p className="text-sm font-bold text-gray-500">No projects found</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {projectSummaries.map(project => (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() => {
                        setSelectedProjectId(project.id);
                        setStatusFilter('');
                      }}
                      className="grid grid-cols-12 w-full px-5 py-4 text-left hover:bg-blue-50/50 transition-colors cursor-pointer"
                    >
                      <div className="col-span-5 min-w-0 flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-700 flex items-center justify-center flex-shrink-0">
                          <Building2 className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-black text-gray-900 truncate">{project.address}</p>
                          <p className="text-xs text-gray-500 truncate">{project.job_name || 'No job name'}</p>
                        </div>
                      </div>
                      <div className="col-span-2 text-right self-center">
                        <p className="text-sm font-black text-gray-900">{project.invoice_count}</p>
                        <p className="text-xs text-blue-600 font-bold">{project.new_count} new</p>
                      </div>
                      <div className="col-span-2 text-right self-center text-sm font-black text-gray-900">{money(project.open_total)}</div>
                      <div className="col-span-2 text-right self-center text-sm font-black text-green-700">{money(project.paid_total)}</div>
                      <div className="col-span-1 self-center flex justify-end">
                        <ChevronRight className="w-5 h-5 text-gray-400" />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="rounded-2xl border border-gray-200 p-5" style={{ background: 'white', boxShadow: '0 10px 30px rgba(17,24,39,0.08)' }}>
              <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4">
                <div className="flex items-start gap-3 min-w-0">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedProjectId(null);
                      setStatusFilter('');
                    }}
                    className="p-2 rounded-xl border border-gray-200 text-gray-500 hover:bg-gray-50"
                    title="Back to project list"
                  >
                    <ArrowLeft className="w-5 h-5" />
                  </button>
                  <div className="min-w-0">
                    <p className="text-xs font-black uppercase tracking-wide text-gray-500">Project invoices</p>
                    <h1 className="text-xl font-black text-gray-900 truncate">{selectedProject.address}</h1>
                    <p className="text-sm text-gray-500 truncate">{selectedProject.job_name}</p>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3 min-w-[300px]">
                  <div className="rounded-xl bg-blue-50 p-3 text-right">
                    <p className="text-lg font-black text-blue-700">{projectInvoiceTotals.all}</p>
                    <p className="text-xs font-bold text-blue-700">All</p>
                  </div>
                  <div className="rounded-xl bg-amber-50 p-3 text-right">
                    <p className="text-lg font-black text-amber-700">{projectInvoiceTotals.new}</p>
                    <p className="text-xs font-bold text-amber-700">New</p>
                  </div>
                  <div className="rounded-xl bg-green-50 p-3 text-right">
                    <p className="text-lg font-black text-green-700">{money(visibleTotal)}</p>
                    <p className="text-xs font-bold text-green-700">Visible Total</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex gap-2 overflow-x-auto pb-1">
              {tabOptions.map(tab => {
                const count = tab.value === ''
                  ? projectInvoiceTotals.all
                  : projectInvoiceTotals[tab.value as keyof typeof projectInvoiceTotals] || 0;
                return (
                  <button
                    key={tab.value}
                    type="button"
                    onClick={() => setStatusFilter(tab.value)}
                    className={`px-4 py-2 rounded-xl text-sm font-black whitespace-nowrap transition-colors flex-shrink-0 cursor-pointer ${
                      statusFilter === tab.value
                        ? 'bg-gray-900 text-white shadow-sm'
                        : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {tab.label} <span className="opacity-70">({count})</span>
                  </button>
                );
              })}
            </div>

            {selectedInvoices.length === 0 ? (
              <div className="text-center py-16 bg-white rounded-2xl border border-gray-200">
                <FileText className="w-10 h-10 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-500 font-bold">No invoices in this category</p>
              </div>
            ) : (
              <div className="rounded-2xl overflow-hidden border border-gray-200" style={{ background: 'white', boxShadow: '0 10px 30px rgba(17,24,39,0.08)' }}>
                <div className="grid grid-cols-12 px-5 py-3 text-xs font-black uppercase tracking-wide text-gray-500 border-b border-gray-100 bg-gray-50">
                  <div className="col-span-3">Invoice</div>
                  <div className="col-span-3">Contractor</div>
                  <div className="col-span-2">Status</div>
                  <div className="col-span-2 text-right">Amount</div>
                  <div className="col-span-2 text-right">Actions</div>
                </div>
                <div className="divide-y divide-gray-100">
                  {selectedInvoices.map(invoice => (
                    <div key={invoice.id} className="grid grid-cols-12 gap-3 px-5 py-4 items-center">
                      <div className="col-span-3 min-w-0">
                        <p className="text-sm font-black text-gray-900">#{invoice.invoice_number}</p>
                        <p className="text-xs text-gray-500">
                          {invoice.submitted_at
                            ? `Submitted ${format(new Date(invoice.submitted_at), 'MMM d, yyyy')}`
                            : `Created ${format(new Date(invoice.created_at), 'MMM d, yyyy')}`}
                        </p>
                      </div>
                      <div className="col-span-3 min-w-0">
                        <p className="text-sm font-bold text-gray-900 truncate">{invoice.contractor_name || 'Unassigned contractor'}</p>
                      </div>
                      <div className="col-span-2">
                        <span className={`inline-flex px-2.5 py-1 rounded-full border text-xs font-black ${statusClass[invoice.status] || statusClass.draft}`}>
                          {statusLabel(invoice.status)}
                        </span>
                      </div>
                      <div className="col-span-2 text-right text-sm font-black text-gray-900">{money(invoice.total)}</div>
                      <div className="col-span-2 flex justify-end items-center gap-2">
                        {isAdminRole(user?.role || '') && invoice.status !== 'paid' && (
                          <button
                            type="button"
                            disabled={updatingInvoiceId === invoice.id}
                            onClick={() => updateStatus(invoice, 'paid')}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-black text-green-700 bg-green-50 border border-green-100 hover:bg-green-100 disabled:opacity-50 cursor-pointer"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Mark Paid
                          </button>
                        )}
                        {isAdminRole(user?.role || '') && invoice.status !== 'paid' && (
                          <select
                            value={invoice.status}
                            onChange={e => updateStatus(invoice, e.target.value)}
                            className="px-2 py-2 rounded-xl border border-gray-300 bg-white text-xs font-bold text-gray-700 cursor-pointer"
                          >
                            <option value="submitted">New Invoice</option>
                            <option value="reviewed">Reviewed</option>
                            <option value="approved">Approved</option>
                            <option value="paid">Paid</option>
                          </select>
                        )}
                        <button
                          type="button"
                          onClick={() => downloadPDF(invoice)}
                          className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-xl transition-colors cursor-pointer"
                          title="Download PDF"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                        <Link to={`/projects/${invoice.project_id}/invoices/${invoice.id}`} className="px-3 py-2 rounded-xl text-xs font-black text-blue-700 bg-blue-50 border border-blue-100 hover:bg-blue-100 cursor-pointer">
                          View
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
