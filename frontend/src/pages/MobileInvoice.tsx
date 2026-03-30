import { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../lib/api';
import toast from 'react-hot-toast';
import { useAuthStore } from '../store/authStore';
import {
  ArrowLeft, Plus, Trash2, Mic, MicOff, Send, Save,
  FileText, ChevronRight, DollarSign, MapPin, User, Calendar,
} from 'lucide-react';

interface LineItem {
  localId: string;
  description: string;
  amount: string;
}

interface SavedInvoice {
  id: string;
  invoice_number: string;
  status: string;
  total: number;
  notes?: string;
  created_at: string;
}

declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

const statusConfig: Record<string, { label: string; color: string; bg: string }> = {
  draft:     { label: 'Draft',     color: '#6B7280', bg: '#F3F4F6' },
  submitted: { label: 'Submitted', color: '#D99D26', bg: '#FEF3C7' },
  reviewed:  { label: 'Reviewed',  color: '#3B82F6', bg: '#EFF6FF' },
  approved:  { label: 'Approved',  color: '#22C55E', bg: '#F0FDF4' },
  paid:      { label: 'Paid',      color: '#059669', bg: '#ECFDF5' },
};

const makeId = () => Math.random().toString(36).slice(2);
const emptyLine = (): LineItem => ({ localId: makeId(), description: '', amount: '' });

export default function MobileInvoice() {
  const { id: projectId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuthStore();

  const [projectAddress, setProjectAddress] = useState('');
  const [projectJobName, setProjectJobName] = useState('');
  const [savedInvoices, setSavedInvoices] = useState<SavedInvoice[]>([]);
  const [view, setView] = useState<'list' | 'builder'>('list');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Builder state — 5 empty rows by default
  const [lineItems, setLineItems] = useState<LineItem[]>([
    emptyLine(), emptyLine(), emptyLine(), emptyLine(), emptyLine(),
  ]);
  const [notes, setNotes] = useState('');
  const invoiceDate = new Date().toISOString().split('T')[0];

  // Voice recognition
  const [listeningIndex, setListeningIndex] = useState<number | null>(null);
  const [listeningField, setListeningField] = useState<'description' | 'amount' | null>(null);
  const recognitionRef = useRef<any>(null);
  const hasSpeechSupport = typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  // Load project + invoices
  useEffect(() => {
    if (!projectId) return;
    Promise.all([
      api.get(`/projects/${projectId}`),
      api.get(`/projects/${projectId}/invoices`).catch(() => ({ data: [] })),
    ]).then(([projRes, invRes]) => {
      setProjectAddress(projRes.data.address || '');
      setProjectJobName(projRes.data.job_name || '');
      const invs = Array.isArray(invRes.data) ? invRes.data : [];
      setSavedInvoices(invs);
      if (invs.length === 0) setView('builder');
    }).catch(() => toast.error('Failed to load project'))
      .finally(() => setLoading(false));
  }, [projectId]);

  // Live total
  const total = lineItems.reduce((sum, item) => {
    const n = parseFloat(item.amount.replace(/[^0-9.]/g, ''));
    return sum + (isNaN(n) ? 0 : n);
  }, 0);

  const filledItems = lineItems.filter(i => i.description.trim());

  // Line item helpers
  const updateLine = (localId: string, field: 'description' | 'amount', val: string) => {
    setLineItems(prev => prev.map(i => i.localId === localId ? { ...i, [field]: val } : i));
  };
  const addLine = () => setLineItems(prev => [...prev, emptyLine()]);
  const removeLine = (localId: string) => {
    if (lineItems.length <= 1) return;
    setLineItems(prev => prev.filter(i => i.localId !== localId));
  };

  // Voice input
  const startVoice = useCallback((index: number, field: 'description' | 'amount') => {
    if (!hasSpeechSupport) { toast.error('Voice input not supported on this browser'); return; }
    if (listeningIndex !== null) {
      recognitionRef.current?.stop();
      setListeningIndex(null);
      setListeningField(null);
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SR();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => { setListeningIndex(index); setListeningField(field); };
    recognition.onresult = (e: any) => {
      const transcript = e.results[0][0].transcript;
      const item = lineItems[index];
      if (item) updateLine(item.localId, field, transcript);
    };
    recognition.onerror = () => { toast.error('Voice input failed'); };
    recognition.onend = () => { setListeningIndex(null); setListeningField(null); };
    recognitionRef.current = recognition;
    recognition.start();
  }, [hasSpeechSupport, listeningIndex, lineItems]);

  // Load existing invoice into builder
  const editInvoice = async (inv: SavedInvoice) => {
    try {
      const res = await api.get(`/projects/${projectId}/invoices/${inv.id}`);
      const data = res.data;
      const items: LineItem[] = (data.line_items || []).map((li: any) => ({
        localId: makeId(),
        description: li.description || '',
        amount: li.amount?.toString() || '',
      }));
      while (items.length < 5) items.push(emptyLine());
      setLineItems(items);
      setNotes(data.notes || '');
      setEditingId(inv.id);
      setView('builder');
    } catch {
      toast.error('Failed to load invoice');
    }
  };

  // Save as draft
  const handleSave = async () => {
    const valid = filledItems;
    if (valid.length === 0) { toast.error('Add at least one line item with a description'); return; }
    setSaving(true);
    try {
      const payload = {
        line_items: valid.map((i, idx) => ({
          description: i.description.trim(),
          amount: parseFloat(i.amount.replace(/[^0-9.]/g, '')) || 0,
          sort_order: idx + 1,
        })),
        notes,
        status: 'draft',
      };
      if (editingId) {
        await api.put(`/projects/${projectId}/invoices/${editingId}`, payload);
        toast.success('Invoice updated');
      } else {
        const res = await api.post(`/projects/${projectId}/invoices`, payload);
        setEditingId(res.data.id);
        toast.success('Invoice saved as draft');
      }
      const invRes = await api.get(`/projects/${projectId}/invoices`);
      setSavedInvoices(Array.isArray(invRes.data) ? invRes.data : []);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to save invoice');
    } finally {
      setSaving(false);
    }
  };

  // Submit invoice (sends emails to office + contractor)
  const handleSubmit = async () => {
    const valid = filledItems;
    if (valid.length === 0) { toast.error('Add at least one line item with a description'); return; }
    setSubmitting(true);
    try {
      const payload = {
        line_items: valid.map((i, idx) => ({
          description: i.description.trim(),
          amount: parseFloat(i.amount.replace(/[^0-9.]/g, '')) || 0,
          sort_order: idx + 1,
        })),
        notes,
        status: 'submitted',
      };
      let invoiceId = editingId;
      if (invoiceId) {
        await api.put(`/projects/${projectId}/invoices/${invoiceId}`, payload);
      } else {
        const res = await api.post(`/projects/${projectId}/invoices`, payload);
        invoiceId = res.data.id;
      }
      // Trigger email send
      await api.post(`/projects/${projectId}/invoices/${invoiceId}/submit`).catch(() => {});
      toast.success('Invoice submitted! Copies sent to office and your email.');
      const invRes = await api.get(`/projects/${projectId}/invoices`);
      setSavedInvoices(Array.isArray(invRes.data) ? invRes.data : []);
      setView('list');
      setEditingId(null);
      setLineItems([emptyLine(), emptyLine(), emptyLine(), emptyLine(), emptyLine()]);
      setNotes('');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to submit invoice');
    } finally {
      setSubmitting(false);
    }
  };

  const startNewInvoice = () => {
    setEditingId(null);
    setLineItems([emptyLine(), emptyLine(), emptyLine(), emptyLine(), emptyLine()]);
    setNotes('');
    setView('builder');
  };

  if (loading) {
    return (
      <div className="mobile-shell" style={{ background: '#F0F2F5', alignItems: 'center', justifyContent: 'center' }}>
        <div className="w-8 h-8 rounded-full animate-spin" style={{ border: '3px solid #E5E7EB', borderTopColor: '#D99D26' }} />
      </div>
    );
  }

  return (
    <div className="mobile-shell" style={{ background: '#F0F2F5', fontFamily: "'Inter', -apple-system, sans-serif" }}>

      {/* ── Header ── */}
      <div style={{ background: 'linear-gradient(135deg, #0D1117 0%, #181D25 100%)' }}>
        <div className="flex items-center gap-3 px-4 pt-4 pb-4">
          <button
            onClick={() => {
              if (view === 'builder' && savedInvoices.length > 0) setView('list');
              else navigate(-1);
            }}
            className="p-2 rounded-xl flex-shrink-0"
            style={{ background: 'rgba(255,255,255,0.08)' }}
          >
            <ArrowLeft className="w-5 h-5 text-white" />
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-white font-bold text-sm leading-tight">
              {view === 'builder' ? (editingId ? 'Edit Invoice' : 'New Invoice') : 'Invoices'}
            </p>
            <p className="text-xs truncate" style={{ color: 'rgba(255,255,255,0.5)' }}>{projectAddress}</p>
          </div>
          {view === 'list' && (
            <button
              onClick={startNewInvoice}
              className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-bold text-white flex-shrink-0"
              style={{ background: 'linear-gradient(135deg, #D99D26, #C4891F)' }}
            >
              <Plus className="w-4 h-4" />
              New
            </button>
          )}
        </div>
      </div>

      {/* ══ LIST VIEW ══ */}
      {view === 'list' && (
        <div className="mobile-content" style={{ padding: '16px 16px 80px' }}>
          {savedInvoices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20">
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4" style={{ background: 'rgba(124,58,237,0.1)' }}>
                <FileText className="w-8 h-8" style={{ color: '#7C3AED' }} />
              </div>
              <p className="font-bold text-gray-700 text-base">No invoices yet</p>
              <p className="text-sm text-gray-400 mt-1 text-center px-8">Tap "New" to create your first invoice for this project</p>
              <button
                onClick={startNewInvoice}
                className="mt-5 px-6 py-3 rounded-2xl font-bold text-white text-sm"
                style={{ background: 'linear-gradient(135deg, #D99D26, #C4891F)' }}
              >
                Create Invoice
              </button>
            </div>
          ) : (
            savedInvoices.map(inv => {
              const sc = statusConfig[inv.status] || statusConfig.draft;
              return (
                <button
                  key={inv.id}
                  onClick={() => editInvoice(inv)}
                  className="w-full rounded-2xl overflow-hidden text-left transition-all active:scale-95"
                  style={{ background: 'white', boxShadow: '0 2px 12px rgba(0,0,0,0.07)' }}
                >
                  <div className="px-4 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(124,58,237,0.1)' }}>
                          <FileText className="w-5 h-5" style={{ color: '#7C3AED' }} />
                        </div>
                        <div className="min-w-0">
                          <p className="font-bold text-gray-900 text-sm">Invoice #{inv.invoice_number}</p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {new Date(inv.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </p>
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-lg font-black text-gray-900">${Number(inv.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                        <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-bold mt-1" style={{ background: sc.bg, color: sc.color }}>
                          {sc.label}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between px-4 py-2.5 border-t" style={{ borderColor: '#F3F4F6', background: '#FAFAFA' }}>
                    <span className="text-xs text-gray-500 font-medium">Tap to view / edit</span>
                    <ChevronRight className="w-4 h-4 text-gray-400" />
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}

      {/* ══ BUILDER VIEW ══ */}
      {view === 'builder' && (
        <div className="mobile-content" style={{ paddingBottom: 176 }}>

          {/* Invoice Header Card */}
          <div className="mx-4 mt-4 rounded-2xl overflow-hidden" style={{ background: 'white', boxShadow: '0 2px 12px rgba(0,0,0,0.07)' }}>
            <div className="h-1.5" style={{ background: 'linear-gradient(90deg, #D99D26, #C4891F)' }} />
            <div className="px-5 py-4 space-y-3">
              <div className="flex items-start gap-3">
                <MapPin className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#D99D26' }} />
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-gray-400">Project Address</p>
                  <p className="font-bold text-gray-900 text-sm mt-0.5">{projectAddress}</p>
                  {projectJobName && <p className="text-xs text-gray-500">{projectJobName}</p>}
                </div>
              </div>
              <div className="h-px" style={{ background: '#F3F4F6' }} />
              <div className="flex items-start gap-3">
                <User className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#7C3AED' }} />
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-gray-400">Contractor</p>
                  <p className="font-bold text-gray-900 text-sm mt-0.5">{user?.name}</p>
                  <p className="text-xs text-gray-500">{user?.email}</p>
                </div>
              </div>
              <div className="h-px" style={{ background: '#F3F4F6' }} />
              <div className="flex items-start gap-3">
                <Calendar className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#3B82F6' }} />
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-gray-400">Invoice Date</p>
                  <p className="font-bold text-gray-900 text-sm mt-0.5">
                    {new Date(invoiceDate).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Line Items */}
          <div className="mx-4 mt-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-bold text-gray-900">Line Items</p>
              {hasSpeechSupport && (
                <span className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: 'rgba(217,157,38,0.1)', color: '#D99D26' }}>
                  <Mic className="w-3 h-3" />
                  Tap mic to speak
                </span>
              )}
            </div>

            <div className="space-y-3">
              {lineItems.map((item, idx) => {
                const isListeningDesc = listeningIndex === idx && listeningField === 'description';
                const isListeningAmt  = listeningIndex === idx && listeningField === 'amount';
                const amt = parseFloat(item.amount.replace(/[^0-9.]/g, ''));
                return (
                  <div
                    key={item.localId}
                    className="rounded-2xl overflow-hidden"
                    style={{
                      background: 'white',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
                      border: (isListeningDesc || isListeningAmt) ? '2px solid #D99D26' : '2px solid transparent',
                    }}
                  >
                    <div className="flex items-center justify-between px-4 pt-3 pb-1">
                      <span className="text-xs font-black text-gray-400 uppercase tracking-wider">Item {idx + 1}</span>
                      {lineItems.length > 1 && (
                        <button onClick={() => removeLine(item.localId)} className="p-1 rounded-lg" style={{ color: '#EF4444' }}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    {/* Description */}
                    <div className="px-4 pb-2">
                      <p className="text-xs font-semibold text-gray-500 mb-1.5">Description of Work</p>
                      <div
                        className="flex items-start gap-2 px-3 py-2.5 rounded-xl"
                        style={{
                          background: isListeningDesc ? 'rgba(217,157,38,0.06)' : '#F9FAFB',
                          border: `1.5px solid ${isListeningDesc ? '#D99D26' : '#E5E7EB'}`,
                        }}
                      >
                        <textarea
                          value={item.description}
                          onChange={e => updateLine(item.localId, 'description', e.target.value)}
                          placeholder="e.g. Build countertop, install tile, paint bedroom..."
                          rows={2}
                          className="flex-1 bg-transparent text-sm text-gray-900 placeholder-gray-400 focus:outline-none resize-none"
                        />
                        {hasSpeechSupport && (
                          <button
                            type="button"
                            onClick={() => startVoice(idx, 'description')}
                            className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-all"
                            style={{ background: isListeningDesc ? '#D99D26' : 'rgba(217,157,38,0.1)', color: isListeningDesc ? 'white' : '#D99D26' }}
                          >
                            {isListeningDesc ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Amount */}
                    <div className="px-4 pb-4">
                      <p className="text-xs font-semibold text-gray-500 mb-1.5">Amount Charged ($)</p>
                      <div
                        className="flex items-center gap-2 px-3 py-2.5 rounded-xl"
                        style={{
                          background: isListeningAmt ? 'rgba(217,157,38,0.06)' : '#F9FAFB',
                          border: `1.5px solid ${isListeningAmt ? '#D99D26' : '#E5E7EB'}`,
                        }}
                      >
                        <DollarSign className="w-4 h-4 flex-shrink-0 text-gray-400" />
                        <input
                          type="number"
                          inputMode="decimal"
                          value={item.amount}
                          onChange={e => updateLine(item.localId, 'amount', e.target.value)}
                          placeholder="0.00"
                          className="flex-1 bg-transparent text-sm font-bold text-gray-900 placeholder-gray-400 focus:outline-none"
                        />
                        {!isNaN(amt) && amt > 0 && (
                          <span className="text-sm font-black flex-shrink-0" style={{ color: '#22C55E' }}>
                            ${amt.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                          </span>
                        )}
                        {hasSpeechSupport && (
                          <button
                            type="button"
                            onClick={() => startVoice(idx, 'amount')}
                            className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-all"
                            style={{ background: isListeningAmt ? '#D99D26' : 'rgba(217,157,38,0.1)', color: isListeningAmt ? 'white' : '#D99D26' }}
                          >
                            {isListeningAmt ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Add Row */}
            <button
              onClick={addLine}
              className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl mt-3 font-bold text-sm transition-all active:scale-95"
              style={{ background: 'rgba(217,157,38,0.06)', border: '1.5px dashed rgba(217,157,38,0.4)', color: '#D99D26' }}
            >
              <Plus className="w-4 h-4" />
              Add Another Item
            </button>
          </div>

          {/* Notes */}
          <div className="mx-4 mt-4">
            <p className="text-sm font-bold text-gray-900 mb-2">Notes (Optional)</p>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Any additional notes for this invoice..."
              rows={3}
              className="w-full px-4 py-3 rounded-2xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none resize-none"
              style={{ background: 'white', border: '2px solid #E5E7EB', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}
            />
          </div>

          {/* Live Running Total */}
          <div
            className="mx-4 mt-4 rounded-2xl px-5 py-4"
            style={{ background: 'linear-gradient(135deg, #0D1117 0%, #181D25 100%)', boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,0.4)' }}>Invoice Total</p>
                <p className="text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.3)' }}>{filledItems.length} line item{filledItems.length !== 1 ? 's' : ''}</p>
              </div>
              <p className="text-3xl font-black" style={{ color: '#D99D26' }}>
                ${total.toLocaleString('en-US', { minimumFractionDigits: 2 })}
              </p>
            </div>
            {filledItems.length > 0 && (
              <div className="mt-3 pt-3 space-y-1.5" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                {filledItems.map((item) => {
                  const a = parseFloat(item.amount.replace(/[^0-9.]/g, '')) || 0;
                  return (
                    <div key={item.localId} className="flex items-center justify-between gap-3">
                      <p className="text-xs truncate flex-1" style={{ color: 'rgba(255,255,255,0.55)' }}>{item.description}</p>
                      <p className="text-xs font-bold flex-shrink-0" style={{ color: 'rgba(255,255,255,0.8)' }}>
                        ${a.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Fixed Bottom Action Buttons (builder only) ── */}
      {view === 'builder' && (
        <div
          className="fixed bottom-0 left-0 right-0 px-4 py-4"
          style={{
            background: 'white',
            borderTop: '1px solid #E5E7EB',
            boxShadow: '0 -4px 20px rgba(0,0,0,0.08)',
            paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
          }}
        >
          {/* Running total preview */}
          <div className="flex items-center justify-between px-1 mb-3">
            <span className="text-xs font-semibold text-gray-500">{filledItems.length} item{filledItems.length !== 1 ? 's' : ''} entered</span>
            <span className="text-base font-black" style={{ color: '#D99D26' }}>
              Total: ${total.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Save Invoice */}
            <button
              onClick={handleSave}
              disabled={saving || submitting}
              className="flex items-center justify-center gap-2 py-4 rounded-2xl font-bold text-sm transition-all active:scale-95 disabled:opacity-50"
              style={{ background: '#F3F4F6', color: '#374151', border: '2px solid #E5E7EB' }}
            >
              {saving
                ? <div className="w-4 h-4 rounded-full animate-spin" style={{ border: '2px solid #D1D5DB', borderTopColor: '#6B7280' }} />
                : <Save className="w-4 h-4" />
              }
              Save Invoice
            </button>

            {/* Submit Invoice */}
            <button
              onClick={handleSubmit}
              disabled={saving || submitting}
              className="flex items-center justify-center gap-2 py-4 rounded-2xl font-bold text-sm text-white transition-all active:scale-95 disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, #D99D26 0%, #C4891F 100%)', boxShadow: '0 4px 16px rgba(217,157,38,0.35)' }}
            >
              {submitting
                ? <div className="w-4 h-4 rounded-full animate-spin" style={{ border: '2px solid rgba(255,255,255,0.3)', borderTopColor: 'white' }} />
                : <Send className="w-4 h-4" />
              }
              Submit Invoice
            </button>
          </div>

          <p className="text-center text-xs text-gray-400 mt-2 px-2 leading-relaxed">
            Submitting sends copies to <strong>invoices@newurbandev.com</strong> and your email
          </p>
        </div>
      )}
    </div>
  );
}
