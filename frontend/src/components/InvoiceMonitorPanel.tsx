// Invoice monitor (2026-10-26): every invoice that came in by email checked against
// what the office entered in QuickBooks (halves, parts, class splits), what needs a
// person, and the feed of everything the inbox and QuickBooks did.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, AlertTriangle, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { formatDateOnly, formatEasternDateTime } from '../lib/time';

interface MonitorEntry {
  qbo_bill_id: string;
  amount: number;
  part: string;
  txn_date?: string | null;
  total_amt?: number | null;
  balance?: number | null;
  payment_status?: string | null;
  payment_approval_status?: string | null;
  private_note?: string | null;
  qbo_class_name?: string | null;
}

interface MonitorInvoice {
  id: string;
  invoice_number: string;
  vendor_name?: string | null;
  external_invoice_number?: string | null;
  total: number;
  category?: string | null;
  project_id: string;
  project_address?: string | null;
  created_at: string;
  reconciliation_status?: string | null;
  quickbooks_total?: number | null;
  paid_amount?: number | null;
  quickbooks_entries: MonitorEntry[];
}

interface MonitorIssue {
  id: string;
  kind: string;
  severity: 'alert' | 'warning' | 'info';
  message: string;
  invoice_id?: string | null;
  invoice_number?: string | null;
  project_id?: string | null;
  project_address?: string | null;
  first_seen_at: string;
}

interface MonitorEvent {
  id: string;
  created_at: string;
  source: 'email' | 'quickbooks' | 'buildtrack' | 'monitor';
  kind: string;
  severity: 'alert' | 'warning' | 'info';
  message: string;
  invoice_id?: string | null;
  project_id?: string | null;
}

interface MonitorData {
  status: { enabled: boolean; since: string; last_run_at?: string | null; last_error?: string | null };
  status_labels: Record<string, string>;
  part_labels: Record<string, string>;
  counts: Record<string, number>;
  issues: MonitorIssue[];
  invoices: MonitorInvoice[];
  events: MonitorEvent[];
}

type MonitorTab = 'attention' | 'invoices' | 'activity';

const SOURCE_LABELS: Record<MonitorEvent['source'], string> = {
  email: 'Email',
  quickbooks: 'QuickBooks',
  buildtrack: 'BuildTrack',
  monitor: 'Monitor',
};

const ISSUE_TITLES: Record<string, string> = {
  possible_double_entry: 'Possible double entry',
  estimate_billed: 'Estimate entered as a bill',
  amount_mismatch: 'Amount differs',
  over_entered: 'More in QuickBooks than invoiced',
  project_mismatch: 'Different project in QuickBooks',
  quickbooks_deleted: 'Deleted in QuickBooks',
  not_in_quickbooks: 'Not in QuickBooks yet',
  partially_entered: 'Partly in QuickBooks',
  document_total_differs: 'Attached document total differs',
};

const money = (value?: number | null) =>
  Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function InvoiceMonitorPanel({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<MonitorData | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [tab, setTab] = useState<MonitorTab>('attention');

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get('/invoices/monitor');
      setData(res.data);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to load the invoice monitor');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // Fresh while someone is looking; hidden tabs do not poll.
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 60000);
    return () => window.clearInterval(timer);
  }, []);

  const runNow = async () => {
    setRunning(true);
    try {
      await api.post('/invoices/monitor/run');
      await load();
      toast.success('Checked against QuickBooks');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'The invoice monitor could not run');
    } finally {
      setRunning(false);
    }
  };

  const dismiss = async (issue: MonitorIssue) => {
    setDismissingId(issue.id);
    try {
      await api.post(`/invoices/monitor/issues/${issue.id}/dismiss`);
      setData(current => (current ? { ...current, issues: current.issues.filter(row => row.id !== issue.id) } : current));
      toast.success('Marked as OK');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Could not mark it as OK');
    } finally {
      setDismissingId(null);
    }
  };

  const counts = data?.counts || {};
  const attention = (data?.issues || []).filter(issue => issue.severity !== 'info');
  const notes = (data?.issues || []).filter(issue => issue.severity === 'info');
  const summary = [
    { label: 'Match QuickBooks', value: (counts.matched || 0) + (counts.matched_split || 0) },
    { label: 'Partly entered', value: counts.partially_entered || 0 },
    { label: 'Waiting for QuickBooks', value: counts.waiting_for_quickbooks || 0 },
    { label: 'Not in QuickBooks', value: counts.not_in_quickbooks || 0 },
    { label: 'Need attention', value: attention.length, hot: attention.length > 0 },
  ];
  const tabs: Array<{ value: MonitorTab; label: string }> = [
    { value: 'attention', label: `Needs attention (${attention.length})` },
    { value: 'invoices', label: `Emailed invoices (${data?.invoices.length || 0})` },
    { value: 'activity', label: 'Activity' },
  ];

  return (
    <section id="invoice-monitor" className="bt-invoice-section bt-monitor">
      <div className="bt-invoice-section-header">
        <div className="flex items-start gap-3">
          <div className="bt-invoice-icon bg-blue-50 text-blue-700">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <p className="text-xs font-black uppercase tracking-wide text-blue-700">Invoice monitor</p>
            <h2 className="text-lg font-black text-gray-900">Email, invoices and QuickBooks</h2>
            <p className="text-sm text-gray-600">
              Every invoice that comes in by email is checked against what is entered in QuickBooks - including invoices entered in halves or split across projects.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {tabs.map(option => (
            <button
              key={option.value}
              type="button"
              onClick={() => setTab(option.value)}
              className={`bt-invoice-filter ${tab === option.value ? 'is-active' : ''}`}
            >
              {option.label}
            </button>
          ))}
          {canManage && (
            <button type="button" onClick={() => void runNow()} disabled={running} className="bt-invoice-refresh">
              <RefreshCw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} />
              {running ? 'Checking...' : 'Check now'}
            </button>
          )}
        </div>
      </div>

      <div className="bt-monitor-summary">
        {summary.map(item => (
          <div key={item.label} className={`bt-monitor-stat ${item.hot ? 'is-hot' : ''}`}>
            <strong>{item.value}</strong>
            <span>{item.label}</span>
          </div>
        ))}
      </div>
      {data?.status?.last_error ? <p className="bt-monitor-error">Last check failed: {data.status.last_error}</p> : null}

      {!data && loading ? <div className="bt-invoice-empty">Loading the invoice monitor...</div> : null}

      {data && tab === 'attention' && (
        <div className="bt-monitor-list">
          {!attention.length && <div className="bt-invoice-empty">Everything that came in by email matches QuickBooks.</div>}
          {attention.map(issue => (
            <article key={issue.id} className={`bt-monitor-issue is-${issue.severity}`}>
              <div className="bt-monitor-issue-head">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <strong>{ISSUE_TITLES[issue.kind] || 'Needs attention'}</strong>
                <span>{formatEasternDateTime(issue.first_seen_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
              </div>
              <p>{issue.message}</p>
              <div className="bt-monitor-issue-actions">
                {issue.invoice_id && issue.project_id ? (
                  <Link to={`/projects/${issue.project_id}/invoices/${issue.invoice_id}`} className="bt-invoice-soft-chip">
                    Open {issue.invoice_number || 'invoice'}
                  </Link>
                ) : null}
                {canManage && (
                  <button type="button" onClick={() => void dismiss(issue)} disabled={dismissingId === issue.id} className="bt-invoice-refresh">
                    {dismissingId === issue.id ? 'Saving...' : 'It is OK'}
                  </button>
                )}
              </div>
            </article>
          ))}
          {notes.length > 0 && (
            <details className="bt-monitor-notes">
              <summary>{notes.length} note{notes.length === 1 ? '' : 's'} (no action needed)</summary>
              {notes.map(issue => <p key={issue.id}>{issue.message}</p>)}
            </details>
          )}
        </div>
      )}

      {data && tab === 'invoices' && (
        <div className="bt-monitor-list">
          {!data.invoices.length && <div className="bt-invoice-empty">No invoices have come in by email yet.</div>}
          {data.invoices.map(invoice => (
            <article key={invoice.id} className="bt-monitor-invoice">
              <div className="bt-monitor-invoice-head">
                <Link to={`/projects/${invoice.project_id}/invoices/${invoice.id}`}>{invoice.invoice_number}</Link>
                <strong>{invoice.vendor_name || 'Vendor'}</strong>
                {invoice.external_invoice_number ? <span>#{invoice.external_invoice_number}</span> : null}
                <span>{money(invoice.total)}</span>
                {invoice.category ? <span className="bt-invoice-soft-chip">{invoice.category}</span> : null}
                <span className={`bt-monitor-status is-${invoice.reconciliation_status || 'waiting_for_quickbooks'}`}>
                  {data.status_labels[invoice.reconciliation_status || ''] || 'Not checked yet'}
                </span>
              </div>
              <p className="bt-monitor-invoice-project">{invoice.project_address || 'No project'}</p>
              {invoice.quickbooks_entries.length > 0 ? (
                <ul className="bt-monitor-entries">
                  {invoice.quickbooks_entries.map(entry => (
                    <li key={entry.qbo_bill_id}>
                      <span>{data.part_labels[entry.part] || entry.part}</span>
                      <span>Bill {entry.qbo_bill_id}</span>
                      <span>{money(entry.amount)}</span>
                      <span>{entry.payment_status === 'paid' ? 'Paid' : 'Open'}</span>
                      {entry.txn_date ? <span>{formatDateOnly(entry.txn_date, { month: 'short', day: 'numeric' })}</span> : null}
                      {entry.qbo_class_name ? <span>{entry.qbo_class_name}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="bt-monitor-invoice-project">Not entered in QuickBooks yet.</p>
              )}
            </article>
          ))}
        </div>
      )}

      {data && tab === 'activity' && (
        <ol className="bt-monitor-feed">
          {!data.events.length && <li className="bt-invoice-empty">Nothing yet.</li>}
          {data.events.map(event => (
            <li key={event.id} className={`is-${event.severity}`}>
              <span className="bt-monitor-feed-time">{formatEasternDateTime(event.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
              <span className={`bt-monitor-source is-${event.source}`}>{SOURCE_LABELS[event.source] || event.source}</span>
              <span className="bt-monitor-feed-message">{event.message}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
