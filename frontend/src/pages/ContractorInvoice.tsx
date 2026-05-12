import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Send, MapPin, Mic, MicOff } from 'lucide-react';
import api from '../lib/api';
import toast from 'react-hot-toast';

interface LineItem {
  id: string;
  description: string;
  amount: string;
}

export default function ContractorInvoice() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<any[]>([]);
  const [user, setUser] = useState<any>(null);
  const [selectedProject, setSelectedProject] = useState<string>('');
  const [lineItems, setLineItems] = useState<LineItem[]>([
    { id: '1', description: '', amount: '' },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceNumberLoaded, setInvoiceNumberLoaded] = useState(false);
  const [listeningId, setListeningId] = useState<string | null>(null);
  const [step, setStep] = useState<'project' | 'invoice'>('project');
  const [loadingProjects, setLoadingProjects] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('contractor_token');
    if (!token) { navigate('/app'); return; }
    try {
      const u = JSON.parse(localStorage.getItem('contractor_user') || 'null');
      setUser(u);
      // Load projects from localStorage first
      const cached = JSON.parse(localStorage.getItem('contractor_projects') || '[]');
      setProjects(cached);
      // Also fetch fresh from API
      api.get('/projects', { headers: { Authorization: `Bearer ${token}` } })
        .then(res => {
          const fresh = res.data || [];
          setProjects(fresh);
          localStorage.setItem('contractor_projects', JSON.stringify(fresh));
        })
        .catch(() => {})
        .finally(() => setLoadingProjects(false));
    } catch { navigate('/app'); }
  }, []);

  const startDictation = (itemId: string) => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      // Fallback: just focus the input, mobile keyboard will offer mic
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
    setListeningId(itemId);
    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      const item = lineItems.find(li => li.id === itemId);
      if (item) {
        const newDesc = item.description ? item.description + ' ' + transcript : transcript;
        updateLineItem(itemId, 'description', newDesc);
      }
      setListeningId(null);
    };
    recognition.onerror = () => setListeningId(null);
    recognition.onend = () => setListeningId(null);
    recognition.start();
  };

  const addLineItem = () => {
    setLineItems([...lineItems, { id: String(Date.now()), description: '', amount: '' }]);
  };

  const removeLineItem = (id: string) => {
    if (lineItems.length <= 1) return;
    setLineItems(lineItems.filter(li => li.id !== id));
  };

  const updateLineItem = (id: string, field: 'description' | 'amount', value: string) => {
    setLineItems(lineItems.map(li => li.id === id ? { ...li, [field]: value } : li));
  };

  const total = lineItems.reduce((sum, li) => {
    const amt = parseFloat(li.amount.replace(/[^0-9.]/g, ''));
    return sum + (isNaN(amt) ? 0 : amt);
  }, 0);

  const selectedProjectData = projects.find(p => p.id === selectedProject);

  // Fetch next invoice number on page load
  useEffect(() => {
    if (!invoiceNumberLoaded && projects.length > 0) {
      const token = localStorage.getItem('contractor_token');
      const pid = projects[0]?.id;
      if (pid) {
        api.get(`/projects/${pid}/invoices/next-number`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }).then(res => { setInvoiceNumber(res.data.invoice_number); setInvoiceNumberLoaded(true); }).catch(() => {});
      }
    }
  }, [projects, invoiceNumberLoaded]);

  const handleSubmit = async () => {
    if (!selectedProject) { toast.error('Select a project'); return; }
    const validItems = lineItems.filter(li => li.description.trim() && li.amount);
    if (validItems.length === 0) { toast.error('Add at least one line item'); return; }

    setSubmitting(true);
    try {
      const token = localStorage.getItem('contractor_token');
      api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
      const res = await api.post(`/projects/${selectedProject}/invoices`, {
        line_items: validItems.map((li, i) => ({
          description: li.description.trim(),
          amount: parseFloat(li.amount.replace(/[^0-9.]/g, '')) || 0,
          sort_order: i,
        })),
        notes: '',
        send_email: true,
      });

      toast.success(`Invoice ${res.data.invoice_number} submitted!`);
      navigate('/app/home');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to submit invoice');
    } finally {
      setSubmitting(false);
    }
  };

  // Step 1: Choose project
  if (step === 'project') {
    return (
      <div style={{ minHeight: '100vh', background: '#F4F5F7' }}>
        <div style={{ background: '#181D25', padding: '16px', position: 'sticky', top: 0, zIndex: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={() => navigate('/app/home')} style={{
              background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10,
              padding: 8, cursor: 'pointer', display: 'flex',
            }}>
              <ArrowLeft size={20} color="white" />
            </button>
            <p style={{ color: 'white', fontWeight: 700, fontSize: 16, margin: 0 }}>Create Invoice</p>
          </div>
        </div>

        <div style={{ padding: 16 }}>
          {invoiceNumber && (
            <div style={{ background: 'rgba(217,157,38,0.1)', borderRadius: 12, padding: '12px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <p style={{ fontSize: 12, color: '#6B7280', fontWeight: 600, margin: 0 }}>Invoice Number</p>
              <p style={{ fontSize: 18, fontWeight: 900, color: '#D99D26', margin: 0, letterSpacing: 1 }}>{invoiceNumber}</p>
            </div>
          )}
          <p style={{ color: '#6B7280', fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Select a project:</p>
          {loadingProjects && projects.length === 0 && (
            <div style={{ textAlign: 'center', padding: '32px 0' }}>
              <div style={{ width: 24, height: 24, border: '3px solid #E5E7EB', borderTopColor: '#D99D26', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto' }} />
              <p style={{ color: '#9CA3AF', fontSize: 13, marginTop: 12 }}>Loading projects...</p>
            </div>
          )}
          {!loadingProjects && projects.length === 0 && (
            <div style={{ textAlign: 'center', padding: '32px 0' }}>
              <p style={{ color: '#6B7280', fontWeight: 600 }}>No projects available</p>
              <p style={{ color: '#9CA3AF', fontSize: 12, marginTop: 4 }}>Contact your admin to get assigned to a project</p>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {projects.map(p => (
              <button
                key={p.id}
                onClick={() => { setSelectedProject(p.id); setStep('invoice'); }}
                style={{
                  background: 'white', border: 'none', borderRadius: 16, padding: '16px',
                  display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.06)', textAlign: 'left',
                }}
              >
                <div style={{
                  width: 42, height: 42, borderRadius: 14,
                  background: 'rgba(217,157,38,0.1)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <MapPin size={18} color="#D99D26" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 14, fontWeight: 700, color: '#111827', margin: 0 }}>{p.address}</p>
                  <p style={{ fontSize: 12, color: '#6B7280', margin: '2px 0 0' }}>{p.job_name}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Step 2: Invoice form
  return (
    <div style={{ minHeight: '100vh', background: '#F4F5F7', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ background: '#181D25', padding: '16px', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={() => setStep('project')} style={{
            background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10,
            padding: 8, cursor: 'pointer', display: 'flex',
          }}>
            <ArrowLeft size={20} color="white" />
          </button>
          <div style={{ flex: 1 }}>
            <p style={{ color: 'white', fontWeight: 700, fontSize: 16, margin: 0 }}>New Invoice</p>
            <p style={{ color: '#D99D26', fontSize: 11, margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedProjectData?.address}
            </p>
          </div>
          {invoiceNumber && (
            <div style={{ background: 'rgba(217,157,38,0.15)', borderRadius: 10, padding: '6px 12px', flexShrink: 0 }}>
              <p style={{ color: '#D99D26', fontSize: 12, fontWeight: 800, margin: 0, letterSpacing: 1 }}>{invoiceNumber}</p>
            </div>
          )}
        </div>
      </div>

      {/* Invoice Info Banner */}
      <div style={{ background: 'white', padding: '14px 16px', borderBottom: '1px solid #E5E7EB' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <p style={{ fontSize: 11, color: '#6B7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, margin: 0 }}>Contractor</p>
            <p style={{ fontSize: 14, fontWeight: 700, color: '#111827', margin: '2px 0 0' }}>{user?.name}</p>
          </div>
          <div style={{ textAlign: 'right' }}>
            <p style={{ fontSize: 11, color: '#6B7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, margin: 0 }}>Project</p>
            <p style={{ fontSize: 14, fontWeight: 700, color: '#111827', margin: '2px 0 0' }}>{selectedProjectData?.job_name}</p>
          </div>
        </div>
      </div>

      {/* Line Items */}
      <div style={{ flex: 1, padding: 16 }}>
        <p style={{ color: '#6B7280', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
          Line Items
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {lineItems.map((li, i) => {
            const amt = parseFloat(li.amount.replace(/[^0-9.]/g, ''));
            const isListening = listeningId === li.id;
            return (
              <div key={li.id} style={{
                background: 'white', borderRadius: 14,
                boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                overflow: 'hidden',
              }}>
                {/* Top row: # + description + mic + delete */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid #F3F4F6' }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: '#D99D26', flexShrink: 0 }}>#{i + 1}</span>
                  <input
                    type="text"
                    value={li.description}
                    onChange={e => updateLineItem(li.id, 'description', e.target.value)}
                    placeholder="Description of work..."
                    autoComplete="off"
                    style={{
                      flex: 1, border: 'none', outline: 'none', fontSize: 14,
                      fontWeight: 600, color: '#111827', background: 'transparent',
                      minWidth: 0,
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => startDictation(li.id)}
                    style={{
                      background: isListening ? 'rgba(239,68,68,0.1)' : 'rgba(107,114,128,0.08)',
                      border: 'none', borderRadius: 8,
                      padding: 7, cursor: 'pointer', display: 'flex', flexShrink: 0,
                    }}
                  >
                    {isListening ? <MicOff size={16} color="#EF4444" /> : <Mic size={16} color="#6B7280" />}
                  </button>
                  {lineItems.length > 1 && (
                    <button onClick={() => removeLineItem(li.id)} style={{
                      background: 'rgba(239,68,68,0.08)', border: 'none', borderRadius: 8,
                      padding: 7, cursor: 'pointer', display: 'flex', flexShrink: 0,
                    }}>
                      <Trash2 size={16} color="#EF4444" />
                    </button>
                  )}
                </div>
                {/* Bottom row: amount on the right */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '10px 14px', gap: 6 }}>
                  <span style={{ fontSize: 16, fontWeight: 800, color: '#9CA3AF' }}>$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={li.amount}
                    onChange={e => {
                      const val = e.target.value.replace(/[^0-9.]/g, '');
                      if (val === '' || /^[0-9]*\.?[0-9]{0,2}$/.test(val)) {
                        updateLineItem(li.id, 'amount', val);
                      }
                    }}
                    onBlur={() => {
                      const raw = parseFloat(li.amount.replace(/[^0-9.]/g, ''));
                      if (!isNaN(raw) && raw > 0) {
                        updateLineItem(li.id, 'amount', raw.toFixed(2));
                      }
                    }}
                    placeholder="0.00"
                    style={{
                      width: 130, border: 'none', outline: 'none', fontSize: 20,
                      fontWeight: 800, color: '#111827', background: 'transparent',
                      textAlign: 'right',
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* Add Line Item Button */}
        <button
          onClick={addLineItem}
          style={{
            width: '100%', marginTop: 12, padding: '14px',
            border: '2px dashed #D1D5DB', borderRadius: 14,
            background: 'transparent', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            color: '#6B7280', fontWeight: 600, fontSize: 13,
          }}
        >
          <Plus size={16} /> Add Line Item
        </button>
      </div>

      {/* Total + Submit */}
      <div style={{
        background: 'white', padding: '16px 16px 24px',
        borderTop: '1px solid #E5E7EB',
        position: 'sticky', bottom: 0,
        boxShadow: '0 -4px 12px rgba(0,0,0,0.05)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: '#6B7280', margin: 0 }}>Total</p>
          <p style={{ fontSize: 28, fontWeight: 900, color: '#111827', margin: 0 }}>
            ${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
        </div>
        <button
          onClick={handleSubmit}
          disabled={submitting || total === 0}
          style={{
            width: '100%', padding: 16, borderRadius: 16,
            border: 'none',
            background: submitting || total === 0 ? '#E5C97A' : 'linear-gradient(135deg, #D99D26, #C4891F)',
            color: 'white', fontWeight: 800, fontSize: 15,
            cursor: submitting || total === 0 ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            boxShadow: total > 0 ? '0 4px 16px rgba(217,157,38,0.4)' : 'none',
          }}
        >
          {submitting ? 'Submitting...' : (
            <>
              <Send size={18} /> Submit Invoice
            </>
          )}
        </button>
      </div>
    </div>
  );
}
