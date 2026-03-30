import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../lib/api';
import { Loading, StatusBadge } from '../components/ui';
import { FileText, Plus, Download } from 'lucide-react';
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
}

export default function Invoices() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        const res = await api.get('/invoices');
        setInvoices(res.data);
      } catch (err) {
        toast.error('Failed to load invoices');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const updateStatus = async (invoiceId: string, projectId: string, status: string) => {
    try {
      await api.put(`/projects/${projectId}/invoices/${invoiceId}/status`, { status });
      setInvoices(prev => prev.map(inv => inv.id === invoiceId ? { ...inv, status } : inv));
      toast.success('Status updated');
    } catch (err) {
      toast.error('Failed to update status');
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
    } catch (err) {
      toast.error('Failed to download PDF');
    }
  };

  const filtered = statusFilter ? invoices.filter(inv => inv.status === statusFilter) : invoices;

  const statusColors: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-600',
    submitted: 'bg-blue-100 text-blue-700',
    reviewed: 'bg-yellow-100 text-yellow-700',
    approved: 'bg-green-100 text-green-700',
    paid: 'bg-emerald-100 text-emerald-700',
  };

  const totalAmount = filtered.reduce((sum, inv) => sum + inv.total, 0);

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Invoices</h1>
          <p className="text-sm text-gray-500 mt-0.5">{filtered.length} invoices · ${totalAmount.toFixed(2)} total</p>
        </div>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1 mb-5">
        {[['', 'All'], ['draft', 'Draft'], ['submitted', 'Submitted'], ['reviewed', 'Reviewed'], ['approved', 'Approved'], ['paid', 'Paid']].map(([val, label]) => (
          <button
            key={val}
            onClick={() => setStatusFilter(val)}
            className={`px-4 py-2 rounded-xl text-sm font-medium whitespace-nowrap transition-colors flex-shrink-0 ${statusFilter === val ? 'bg-blue-600 text-white shadow-sm' : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-50'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? <Loading /> : (
        filtered.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
            <FileText className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500 font-medium">No invoices found</p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map(inv => (
              <div key={inv.id} className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 bg-purple-100 rounded-xl flex items-center justify-center flex-shrink-0">
                    <FileText className="w-5 h-5 text-purple-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-semibold text-gray-900">#{inv.invoice_number}</p>
                        <p className="text-sm text-gray-600 truncate">{inv.address}</p>
                        {isAdminRole(user?.role || '') && (
                          <p className="text-xs text-gray-400">{inv.contractor_name}</p>
                        )}
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-lg font-bold text-gray-900">${inv.total.toFixed(2)}</p>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[inv.status]}`}>{inv.status}</span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between mt-3">
                      <p className="text-xs text-gray-400">
                        {inv.submitted_at ? `Submitted ${format(new Date(inv.submitted_at), 'MMM d, yyyy')}` : `Created ${format(new Date(inv.created_at), 'MMM d, yyyy')}`}
                      </p>
                      <div className="flex items-center gap-2">
                        {isAdminRole(user?.role || '') && inv.status !== 'paid' && (
                          <select
                            value={inv.status}
                            onChange={e => updateStatus(inv.id, inv.project_id, e.target.value)}
                            className="text-xs border border-gray-300 rounded-lg px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                            onClick={e => e.stopPropagation()}
                          >
                            <option value="submitted">Submitted</option>
                            <option value="reviewed">Reviewed</option>
                            <option value="approved">Approved</option>
                            <option value="paid">Paid</option>
                          </select>
                        )}
                        <button onClick={() => downloadPDF(inv)} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors" title="Download PDF">
                          <Download className="w-4 h-4" />
                        </button>
                        <Link to={`/projects/${inv.project_id}/invoices/${inv.id}`} className="text-xs text-blue-600 hover:underline font-medium">View</Link>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
