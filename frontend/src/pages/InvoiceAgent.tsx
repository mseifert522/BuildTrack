import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import {
  Activity,
  AlertTriangle,
  Bot,
  BrainCircuit,
  CheckCircle2,
  FileSearch,
  Inbox,
  Loader2,
  Mail,
  Paperclip,
  Play,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Sparkles,
  WalletCards,
} from 'lucide-react';
import api from '../lib/api';
import { Loading } from '../components/ui';

interface EmailAttachment {
  id: string;
  original_name: string;
  mime_type: string;
  size: number;
}

interface EmailIntake {
  id: string;
  from_email?: string;
  from_name?: string;
  to_email?: string;
  subject?: string;
  text_body?: string;
  html_body?: string;
  attachment_count: number;
  attachments: EmailAttachment[];
  status: 'new' | 'filed' | 'ignored';
  agent_status?: 'pending' | 'matched' | 'needs_review' | 'filed' | 'ignored' | 'error';
  extracted_vendor?: string | null;
  extracted_invoice_number?: string | null;
  extracted_amount?: number | null;
  extracted_invoice_date?: string | null;
  extracted_service_address?: string | null;
  extracted_summary?: string | null;
  matched_project_id?: string | null;
  matched_project_address?: string | null;
  matched_project_job_name?: string | null;
  match_confidence?: number | null;
  agent_notes?: string | null;
  agent_model?: string | null;
  agent_last_run_at?: string | null;
  received_at: string;
}

interface ProjectOption {
  id: string;
  address: string;
  job_name?: string;
  status?: string;
}

interface PortalFinding {
  severity: string;
  area: string;
  title: string;
  detail?: string;
  recommended_action?: string;
}

interface DashboardResponse {
  configured: boolean;
  model?: string | null;
  auto_file: boolean;
  stats: {
    total: number;
    new_count: number;
    filed_count: number;
    ignored_count: number;
    pending_count: number;
    matched_count: number;
    needs_review_count: number;
    error_count: number;
    extracted_total: number;
  };
  items: EmailIntake[];
  latest_portal_scan?: {
    status: string;
    model?: string | null;
    score?: number | null;
    scan_summary?: string | null;
    findings: PortalFinding[];
    created_at: string;
    error?: string | null;
  } | null;
}

const filters = [
  { value: '', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'matched', label: 'Matched' },
  { value: 'needs_review', label: 'Review' },
  { value: 'filed', label: 'Filed' },
  { value: 'error', label: 'Errors' },
];

const money = (value?: number | null) =>
  Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const percent = (value?: number | null) => `${Math.round(Number(value || 0) * 100)}%`;

const statusStyle: Record<string, string> = {
  pending: 'bg-blue-50 text-blue-700 border-blue-100',
  matched: 'bg-indigo-50 text-indigo-700 border-indigo-100',
  needs_review: 'bg-amber-50 text-amber-700 border-amber-100',
  filed: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  ignored: 'bg-gray-50 text-gray-600 border-gray-200',
  error: 'bg-red-50 text-red-700 border-red-100',
};

const severityStyle: Record<string, string> = {
  critical: 'text-red-700 bg-red-50 border-red-100',
  high: 'text-orange-700 bg-orange-50 border-orange-100',
  medium: 'text-amber-700 bg-amber-50 border-amber-100',
  low: 'text-blue-700 bg-blue-50 border-blue-100',
  info: 'text-gray-700 bg-gray-50 border-gray-200',
};

function labelize(value?: string | null) {
  return String(value || 'pending').replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

function emailBodyText(email: EmailIntake | null) {
  if (!email) return '';
  if (email.text_body?.trim()) return email.text_body.trim();
  if (!email.html_body) return '';
  const parsed = new DOMParser().parseFromString(email.html_body, 'text/html');
  return parsed.body.textContent?.replace(/\n{3,}/g, '\n\n').trim() || '';
}

export default function InvoiceAgent() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runningItemId, setRunningItemId] = useState<string | null>(null);
  const [filing, setFiling] = useState(false);
  const [scanningPortal, setScanningPortal] = useState(false);

  const load = async (nextFilter = filter) => {
    setLoading(true);
    try {
      const [agentRes, projectRes] = await Promise.all([
        api.get('/invoice-agent', { params: { limit: 150, status: nextFilter || undefined } }),
        api.get('/projects'),
      ]);
      setData(agentRes.data);
      setProjects(Array.isArray(projectRes.data) ? projectRes.data : []);
      const items = Array.isArray(agentRes.data?.items) ? agentRes.data.items : [];
      if (!selectedId || !items.some((item: EmailIntake) => item.id === selectedId)) {
        setSelectedId(items[0]?.id || null);
      }
    } catch {
      toast.error('Failed to load invoice agent');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const items = data?.items || [];
  const selected = useMemo(
    () => items.find(item => item.id === selectedId) || items[0] || null,
    [items, selectedId]
  );

  useEffect(() => {
    setSelectedProjectId(selected?.matched_project_id || '');
  }, [selected?.id, selected?.matched_project_id]);

  const runPending = async () => {
    setRunning(true);
    try {
      const res = await api.post('/invoice-agent/run', { limit: 25, force: true });
      toast.success(`${res.data?.processed || 0} email invoice${res.data?.processed === 1 ? '' : 's'} scanned`);
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Invoice agent scan failed');
    } finally {
      setRunning(false);
    }
  };

  const runItem = async (email: EmailIntake) => {
    setRunningItemId(email.id);
    try {
      await api.post(`/invoice-agent/${email.id}/run`);
      toast.success('Email invoice scanned');
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Invoice agent scan failed');
    } finally {
      setRunningItemId(null);
    }
  };

  const fileSelected = async () => {
    if (!selected || !selectedProjectId) return;
    setFiling(true);
    try {
      await api.put(`/invoice-agent/${selected.id}/file`, { project_id: selectedProjectId });
      toast.success('Email invoice filed to property');
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to file email invoice');
    } finally {
      setFiling(false);
    }
  };

  const ignoreSelected = async () => {
    if (!selected) return;
    try {
      await api.put(`/invoices/email-intake/${selected.id}/status`, { status: 'ignored' });
      toast.success('Email invoice ignored');
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to ignore email invoice');
    }
  };

  const runPortalScan = async () => {
    setScanningPortal(true);
    try {
      await api.post('/invoice-agent/portal-scan');
      toast.success('Portal scan completed');
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Portal scan failed');
    } finally {
      setScanningPortal(false);
    }
  };

  const downloadEmailAttachment = async (email: EmailIntake, attachment: EmailAttachment) => {
    try {
      const res = await api.get(`/invoices/email-intake/${email.id}/attachments/${attachment.id}`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: attachment.mime_type || 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = attachment.original_name || 'invoice-attachment';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Failed to download attachment');
    }
  };

  if (loading && !data) return <Loading />;

  const stats = data?.stats || {
    total: 0,
    new_count: 0,
    filed_count: 0,
    ignored_count: 0,
    pending_count: 0,
    matched_count: 0,
    needs_review_count: 0,
    error_count: 0,
    extracted_total: 0,
  };
  const scan = data?.latest_portal_scan;
  const selectedBody = emailBodyText(selected);

  return (
    <div className="min-h-full px-6 py-6 md:px-8" style={{ background: '#F0F2F5' }}>
      <div className="max-w-7xl mx-auto space-y-5">
        <div className="flex flex-col xl:flex-row xl:items-end xl:justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-900 text-white text-xs font-black">
              <BrainCircuit className="w-3.5 h-3.5" />
              {data?.model || 'Anthropic'}
            </div>
            <h1 className="mt-3 text-2xl font-black text-gray-900 tracking-tight">Invoice Agent</h1>
            <p className="text-sm text-gray-500 mt-1">
              invoices@newurbandev.com
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => load()}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-gray-300 bg-white text-sm font-black text-gray-700 hover:bg-gray-50"
            >
              <RefreshCw className="w-4 h-4" />
              Refresh
            </button>
            <button
              type="button"
              disabled={running}
              onClick={runPending}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gray-900 text-white text-sm font-black hover:bg-gray-800 disabled:opacity-50"
            >
              {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              Run invoices
            </button>
            <button
              type="button"
              disabled={scanningPortal}
              onClick={runPortalScan}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-700 text-white text-sm font-black hover:bg-blue-800 disabled:opacity-50"
            >
              {scanningPortal ? <Loader2 className="w-4 h-4 animate-spin" /> : <ScanLine className="w-4 h-4" />}
              Scan portal
            </button>
          </div>
        </div>

        <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3">
          {[
            { label: 'New Email Invoices', value: stats.new_count, sub: `${stats.pending_count} pending scan`, icon: Inbox, bg: '#EFF6FF', color: '#1D4ED8' },
            { label: 'Matched To Property', value: stats.matched_count, sub: `${stats.needs_review_count} need review`, icon: FileSearch, bg: '#F5F3FF', color: '#6D28D9' },
            { label: 'Filed From Email', value: stats.filed_count, sub: `${money(stats.extracted_total)} extracted`, icon: CheckCircle2, bg: '#ECFDF5', color: '#047857' },
            { label: 'Agent Health', value: data?.configured ? 'Active' : 'No Key', sub: data?.auto_file ? 'Auto-file enabled' : 'Review mode', icon: Bot, bg: '#FFF7ED', color: '#C2410C' },
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

        <div className="rounded-2xl overflow-hidden border border-gray-200" style={{ background: 'white', boxShadow: '0 10px 30px rgba(17,24,39,0.08)' }}>
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 px-5 py-4 border-b border-gray-100 bg-gray-50">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-700 flex items-center justify-center">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-sm font-black text-gray-900">Daily portal review</h2>
                <p className="text-xs font-semibold text-gray-500">
                  {scan ? `${scan.status} | ${format(new Date(scan.created_at), 'MMM d, yyyy h:mm a')}` : 'No scan recorded'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {scan?.score !== null && scan?.score !== undefined && (
                <div className="text-right">
                  <p className="text-xl font-black text-gray-900">{scan.score}</p>
                  <p className="text-xs font-bold text-gray-500">Score</p>
                </div>
              )}
            </div>
          </div>
          <div className="grid lg:grid-cols-3 gap-0">
            <div className="lg:col-span-1 p-5 border-b lg:border-b-0 lg:border-r border-gray-100">
              <p className="text-sm font-bold text-gray-900">{scan?.scan_summary || 'Waiting for first portal scan.'}</p>
              {scan?.error && <p className="mt-2 text-xs font-bold text-red-600">{scan.error}</p>}
            </div>
            <div className="lg:col-span-2 divide-y divide-gray-100">
              {(scan?.findings || []).slice(0, 4).length === 0 ? (
                <div className="p-5 text-sm font-bold text-gray-500">No findings recorded</div>
              ) : (
                (scan?.findings || []).slice(0, 4).map((finding, index) => (
                  <div key={`${finding.title}-${index}`} className="p-4 flex items-start gap-3">
                    <span className={`px-2 py-1 rounded-lg border text-[11px] font-black uppercase ${severityStyle[finding.severity] || severityStyle.info}`}>
                      {finding.severity || 'info'}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-black text-gray-900">{finding.title}</p>
                      <p className="text-xs text-gray-500 mt-1">{finding.detail || finding.recommended_action || finding.area}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1">
          {filters.map(option => {
            const active = filter === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  setFilter(option.value);
                  load(option.value);
                }}
                className={`px-4 py-2 rounded-xl text-sm font-black whitespace-nowrap transition-colors flex-shrink-0 ${
                  active
                    ? 'bg-gray-900 text-white shadow-sm'
                    : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-50'
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        <div className="grid xl:grid-cols-[420px_1fr] gap-5 items-start">
          <div className="rounded-2xl overflow-hidden border border-gray-200" style={{ background: 'white', boxShadow: '0 10px 30px rgba(17,24,39,0.08)' }}>
            <div className="px-5 py-4 border-b border-gray-100 bg-gray-50">
              <h2 className="text-sm font-black text-gray-900">Email invoice inbox</h2>
              <p className="text-xs font-semibold text-gray-500">{items.length} visible</p>
            </div>
            <div className="max-h-[760px] overflow-y-auto divide-y divide-gray-100">
              {items.length === 0 ? (
                <div className="p-10 text-center">
                  <Mail className="w-9 h-9 text-gray-300 mx-auto mb-3" />
                  <p className="text-sm font-bold text-gray-500">No email invoices found</p>
                </div>
              ) : (
                items.map(item => {
                  const active = selected?.id === item.id;
                  const agentStatus = item.agent_status || 'pending';
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelectedId(item.id)}
                      className={`w-full text-left p-4 transition-colors ${active ? 'bg-blue-50/70' : 'hover:bg-gray-50'}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-black text-gray-900 truncate">{item.subject || '(no subject)'}</p>
                          <p className="text-xs text-gray-500 truncate mt-0.5">
                            {item.extracted_vendor || item.from_name || item.from_email || 'Unknown sender'}
                          </p>
                        </div>
                        <span className={`px-2 py-1 rounded-full border text-[11px] font-black whitespace-nowrap ${statusStyle[agentStatus] || statusStyle.pending}`}>
                          {labelize(agentStatus)}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                        <div>
                          <p className="font-black text-gray-900">{item.extracted_amount !== null && item.extracted_amount !== undefined ? money(item.extracted_amount) : '-'}</p>
                          <p className="font-semibold text-gray-500">Amount</p>
                        </div>
                        <div className="text-right">
                          <p className="font-black text-gray-900">{item.match_confidence ? percent(item.match_confidence) : '-'}</p>
                          <p className="font-semibold text-gray-500">Confidence</p>
                        </div>
                      </div>
                      <p className="mt-3 text-xs font-semibold text-gray-500 truncate">
                        {item.matched_project_address || item.extracted_service_address || 'No property match'}
                      </p>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="rounded-2xl overflow-hidden border border-gray-200 min-h-[520px]" style={{ background: 'white', boxShadow: '0 10px 30px rgba(17,24,39,0.08)' }}>
            {!selected ? (
              <div className="p-12 text-center">
                <Inbox className="w-10 h-10 text-gray-300 mx-auto mb-3" />
                <p className="text-sm font-bold text-gray-500">Select an email invoice</p>
              </div>
            ) : (
              <>
                <div className="px-5 py-4 border-b border-gray-100 bg-gray-50 flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-black uppercase tracking-wide text-gray-500">
                      {selected.received_at ? format(new Date(selected.received_at), 'MMM d, yyyy h:mm a') : 'Received'}
                    </p>
                    <h2 className="mt-1 text-lg font-black text-gray-900 truncate">{selected.subject || '(no subject)'}</h2>
                    <p className="text-sm text-gray-500 truncate">{selected.from_name || selected.from_email || 'Unknown sender'}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={runningItemId === selected.id}
                      onClick={() => runItem(selected)}
                      className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-900 text-white text-xs font-black hover:bg-gray-800 disabled:opacity-50"
                    >
                      {runningItemId === selected.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                      Run AI
                    </button>
                    {selected.status !== 'ignored' && (
                      <button
                        type="button"
                        onClick={ignoreSelected}
                        className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-gray-300 bg-white text-xs font-black text-gray-700 hover:bg-gray-50"
                      >
                        Ignore
                      </button>
                    )}
                  </div>
                </div>

                <div className="p-5 space-y-5">
                  <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3">
                    {[
                      { label: 'Vendor', value: selected.extracted_vendor || selected.from_name || selected.from_email || '-' },
                      { label: 'Amount', value: selected.extracted_amount !== null && selected.extracted_amount !== undefined ? money(selected.extracted_amount) : '-' },
                      { label: 'Invoice Date', value: selected.extracted_invoice_date || '-' },
                      { label: 'Invoice #', value: selected.extracted_invoice_number || '-' },
                    ].map(item => (
                      <div key={item.label} className="rounded-xl bg-gray-50 border border-gray-100 p-3 min-w-0">
                        <p className="text-xs font-black uppercase tracking-wide text-gray-400">{item.label}</p>
                        <p className="mt-1 text-sm font-black text-gray-900 truncate">{item.value}</p>
                      </div>
                    ))}
                  </div>

                  <div className="grid lg:grid-cols-2 gap-4">
                    <div className="rounded-xl border border-gray-200 p-4">
                      <div className="flex items-center gap-2 mb-3">
                        <WalletCards className="w-4 h-4 text-blue-700" />
                        <h3 className="text-sm font-black text-gray-900">Property match</h3>
                      </div>
                      <p className="text-sm font-black text-gray-900">{selected.matched_project_address || selected.extracted_service_address || 'No match yet'}</p>
                      {selected.matched_project_job_name && <p className="text-xs font-semibold text-gray-500 mt-1">{selected.matched_project_job_name}</p>}
                      <div className="mt-4 h-2 rounded-full bg-gray-100 overflow-hidden">
                        <div
                          className="h-full bg-blue-700"
                          style={{ width: `${Math.min(100, Math.max(0, Number(selected.match_confidence || 0) * 100))}%` }}
                        />
                      </div>
                      <p className="mt-2 text-xs font-bold text-gray-500">{percent(selected.match_confidence)} confidence</p>
                      {selected.agent_notes && <p className="mt-3 text-xs font-semibold text-gray-500">{selected.agent_notes}</p>}
                    </div>

                    <div className="rounded-xl border border-gray-200 p-4">
                      <div className="flex items-center gap-2 mb-3">
                        <CheckCircle2 className="w-4 h-4 text-emerald-700" />
                        <h3 className="text-sm font-black text-gray-900">File to property</h3>
                      </div>
                      <select
                        value={selectedProjectId}
                        onChange={event => setSelectedProjectId(event.target.value)}
                        className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-900 outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">Select project address</option>
                        {projects.map(project => (
                          <option key={project.id} value={project.id}>
                            {project.address}{project.job_name ? ` | ${project.job_name}` : ''}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={!selectedProjectId || filing}
                        onClick={fileSelected}
                        className="mt-3 inline-flex w-full items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-700 text-white text-sm font-black hover:bg-emerald-800 disabled:opacity-50"
                      >
                        {filing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                        File invoice email
                      </button>
                    </div>
                  </div>

                  {selected.attachments?.length > 0 && (
                    <div className="rounded-xl border border-gray-200 p-4">
                      <p className="text-xs font-black uppercase tracking-wide text-gray-400 mb-3">Attachments</p>
                      <div className="flex flex-wrap gap-2">
                        {selected.attachments.map(attachment => (
                          <button
                            key={attachment.id}
                            type="button"
                            onClick={() => downloadEmailAttachment(selected, attachment)}
                            className="inline-flex items-center gap-1.5 max-w-full px-3 py-2 rounded-lg text-xs font-bold text-gray-700 bg-gray-50 border border-gray-200 hover:bg-gray-100"
                            title={attachment.original_name}
                          >
                            <Paperclip className="w-3.5 h-3.5 flex-shrink-0" />
                            <span className="truncate max-w-[240px]">{attachment.original_name}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {selected.agent_status === 'error' && (
                    <div className="rounded-xl border border-red-100 bg-red-50 p-4 flex items-start gap-3">
                      <AlertTriangle className="w-5 h-5 text-red-700 flex-shrink-0" />
                      <p className="text-sm font-bold text-red-700">{selected.agent_notes || 'Agent scan failed'}</p>
                    </div>
                  )}

                  <div className="rounded-xl border border-gray-200 overflow-hidden">
                    <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center gap-2">
                      <Activity className="w-4 h-4 text-gray-500" />
                      <p className="text-xs font-black uppercase tracking-wide text-gray-500">Email body</p>
                    </div>
                    <pre className="whitespace-pre-wrap break-words text-sm text-gray-800 p-4 max-h-[420px] overflow-y-auto font-sans leading-relaxed">
                      {selectedBody || 'No email body was stored for this message.'}
                    </pre>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
