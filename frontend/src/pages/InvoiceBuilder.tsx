import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import api from '../lib/api';
import { Loading } from '../components/ui';
import { Plus, Trash2, ArrowLeft, Send, Save, Download } from 'lucide-react';
import toast from 'react-hot-toast';

interface LineItem {
  id?: string;
  description: string;
  amount: string;
}

export default function InvoiceBuilder() {
  const { projectId, invoiceId } = useParams<{ projectId: string; invoiceId?: string }>();
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [project, setProject] = useState<any>(null);
  const [invoice, setInvoice] = useState<any>(null);
  const [lineItems, setLineItems] = useState<LineItem[]>([{ description: '', amount: '' }]);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const projRes = await api.get(`/projects/${projectId}`);
        setProject(projRes.data);

        if (invoiceId) {
          const invRes = await api.get(`/projects/${projectId}/invoices/${invoiceId}`);
          setInvoice(invRes.data);
          setLineItems(invRes.data.line_items?.length > 0
            ? invRes.data.line_items.map((li: any) => ({ id: li.id, description: li.description, amount: String(li.amount) }))
            : [{ description: '', amount: '' }]
          );
          setNotes(invRes.data.notes || '');
        }
      } catch (err) {
        toast.error('Failed to load data');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [projectId, invoiceId]);

  const total = lineItems.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);

  const addLine = () => setLineItems([...lineItems, { description: '', amount: '' }]);
  const removeLine = (idx: number) => setLineItems(lineItems.filter((_, i) => i !== idx));
  const updateLine = (idx: number, field: 'description' | 'amount', value: string) => {
    setLineItems(lineItems.map((item, i) => i === idx ? { ...item, [field]: value } : item));
  };

  const getPayload = () => ({
    notes,
    line_items: lineItems.filter(li => li.description.trim()).map(li => ({
      description: li.description,
      amount: parseFloat(li.amount) || 0,
    })),
  });

  const handleSave = async () => {
    if (lineItems.filter(li => li.description.trim()).length === 0) {
      toast.error('Add at least one line item');
      return;
    }
    setSaving(true);
    try {
      if (invoiceId) {
        await api.put(`/projects/${projectId}/invoices/${invoiceId}`, getPayload());
        toast.success('Invoice saved');
      } else {
        const res = await api.post(`/projects/${projectId}/invoices`, getPayload());
        toast.success('Invoice saved as draft');
        navigate(`/projects/${projectId}/invoices/${res.data.id}`);
      }
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to save invoice');
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async () => {
    if (!invoiceId) {
      toast.error('Save the invoice first');
      return;
    }
    if (!confirm('Submit this invoice? It will be emailed to invoices@newurbandev.com and a copy sent to you.')) return;
    setSubmitting(true);
    try {
      await api.post(`/projects/${projectId}/invoices/${invoiceId}/submit`);
      toast.success('Invoice submitted successfully!');
      navigate(`/projects/${projectId}`);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to submit invoice');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDownloadPDF = async () => {
    if (!invoiceId) { toast.error('Save the invoice first'); return; }
    try {
      const res = await api.get(`/projects/${projectId}/invoices/${invoiceId}/pdf`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `invoice-${invoice?.invoice_number || 'draft'}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error('Failed to download PDF');
    }
  };

  if (loading) return <Loading />;

  const isReadOnly = invoice?.status && invoice.status !== 'draft';

  return (
    <div className="min-h-full bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="px-4 md:px-6 py-3 flex items-center gap-3">
          <button onClick={() => navigate(`/projects/${projectId}`)} className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="font-bold text-gray-900 text-base">
              {invoiceId ? `Invoice #${invoice?.invoice_number}` : 'New Invoice'}
            </h1>
            <p className="text-xs text-gray-500 truncate">{project?.address}</p>
          </div>
          {invoice?.status && (
            <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${
              invoice.status === 'paid' ? 'bg-emerald-100 text-emerald-700' :
              invoice.status === 'approved' ? 'bg-green-100 text-green-700' :
              invoice.status === 'submitted' ? 'bg-blue-100 text-blue-700' :
              'bg-gray-100 text-gray-600'
            }`}>{invoice.status}</span>
          )}
        </div>
      </div>

      <div className="max-w-2xl mx-auto p-4 md:p-6 space-y-4">
        {/* Company Header */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-xl font-bold text-gray-900">New Urban Developments</h2>
              <p className="text-sm text-gray-500 mt-0.5">invoices@newurbandev.com</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-gray-400">Invoice</p>
              <p className="font-bold text-gray-900">{invoice?.invoice_number || 'DRAFT'}</p>
              <p className="text-xs text-gray-400 mt-1">{new Date().toLocaleDateString()}</p>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-gray-100">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-xs text-gray-400 mb-0.5">Project Address</p>
                <p className="font-medium text-gray-900">{project?.address}</p>
                <p className="text-gray-500">{project?.job_name}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400 mb-0.5">From</p>
                <p className="font-medium text-gray-900">{user?.name}</p>
                <p className="text-gray-500">{user?.email}</p>
                {user?.phone && <p className="text-gray-500">{user.phone}</p>}
                {user?.company && <p className="text-gray-500">{user.company}</p>}
              </div>
            </div>
          </div>
        </div>

        {/* Line Items */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
            <div className="grid grid-cols-[1fr_120px_32px] gap-3 flex-1 text-xs font-medium text-gray-500 uppercase tracking-wide">
              <span>Description</span>
              <span className="text-right">Amount</span>
              <span />
            </div>
          </div>

          <div className="divide-y divide-gray-100">
            {lineItems.map((item, idx) => (
              <div key={idx} className="px-5 py-3 grid grid-cols-[1fr_120px_32px] gap-3 items-center">
                <input
                  value={item.description}
                  onChange={e => updateLine(idx, 'description', e.target.value)}
                  placeholder="Description of work..."
                  disabled={isReadOnly}
                  className="text-sm text-gray-900 bg-transparent border-0 outline-none focus:bg-gray-50 rounded px-1 py-0.5 w-full disabled:text-gray-500"
                />
                <div className="relative">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                  <input
                    type="number"
                    value={item.amount}
                    onChange={e => updateLine(idx, 'amount', e.target.value)}
                    placeholder="0.00"
                    step="0.01"
                    min="0"
                    disabled={isReadOnly}
                    className="text-sm text-gray-900 bg-transparent border-0 outline-none focus:bg-gray-50 rounded pl-5 pr-1 py-0.5 w-full text-right disabled:text-gray-500"
                  />
                </div>
                {!isReadOnly && lineItems.length > 1 && (
                  <button onClick={() => removeLine(idx)} className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>

          {!isReadOnly && (
            <div className="px-5 py-3 border-t border-gray-100">
              <button onClick={addLine} className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700 font-medium transition-colors">
                <Plus className="w-4 h-4" /> Add Line Item
              </button>
            </div>
          )}

          {/* Total */}
          <div className="px-5 py-4 bg-gray-50 border-t border-gray-200">
            <div className="flex items-center justify-between">
              <span className="font-bold text-gray-900">TOTAL</span>
              <span className="text-2xl font-bold text-gray-900">${total.toFixed(2)}</span>
            </div>
          </div>
        </div>

        {/* Notes */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <label className="block text-sm font-medium text-gray-700 mb-2">Notes</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={3}
            disabled={isReadOnly}
            className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none disabled:bg-gray-50 disabled:text-gray-500"
            placeholder="Payment terms, additional notes..."
          />
        </div>

        {/* Actions */}
        {!isReadOnly && (
          <div className="space-y-3 pb-6">
            <button
              onClick={handleSubmit}
              disabled={submitting || !invoiceId}
              className="w-full flex items-center justify-center gap-2 py-4 bg-blue-600 text-white rounded-xl font-bold text-base hover:bg-blue-700 transition-colors disabled:opacity-50 shadow-md"
            >
              <Send className="w-5 h-5" />
              {submitting ? 'Submitting...' : 'SUBMIT INVOICE'}
            </button>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center justify-center gap-2 py-3 border border-gray-300 bg-white text-gray-700 rounded-xl font-medium text-sm hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                <Save className="w-4 h-4" />
                {saving ? 'Saving...' : 'Save Draft'}
              </button>
              {invoiceId && (
                <button
                  onClick={handleDownloadPDF}
                  className="flex items-center justify-center gap-2 py-3 border border-gray-300 bg-white text-gray-700 rounded-xl font-medium text-sm hover:bg-gray-50 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Download PDF
                </button>
              )}
            </div>
          </div>
        )}

        {isReadOnly && invoiceId && (
          <div className="pb-6">
            <button
              onClick={handleDownloadPDF}
              className="w-full flex items-center justify-center gap-2 py-3 border border-gray-300 bg-white text-gray-700 rounded-xl font-medium text-sm hover:bg-gray-50 transition-colors"
            >
              <Download className="w-4 h-4" />
              Download PDF
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
