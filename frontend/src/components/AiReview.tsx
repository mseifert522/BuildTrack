import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Bot, CheckCircle2, Info, Loader2, RefreshCw, RotateCcw, Sparkles, Wand2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { Modal } from './ui';
import { formatEasternDateTime } from '../lib/time';
import {
  AI_STATUS_HELP, AI_STATUS_LABELS, aiIsBusy, applyAiReview, attentionFindings, fetchAiReview, rerunAiReview, undoAiReview,
  type AiEntityType, type AiFinding, type AiReviewDetail, type AiReviewStatus,
} from '../lib/documentReview';

// The AI's check of how a document is filed: a small badge in a list row, and the
// dialog behind it (what the AI read, each check, apply / undo / read again).

export function AiReviewBadge({ status, findings = [], onClick }: {
  status?: AiReviewStatus | null;
  findings?: AiFinding[];
  onClick?: () => void;
}) {
  if (!status) return null;
  const attention = attentionFindings(findings);
  const title = [AI_STATUS_HELP[status], ...attention.map(f => `• ${f.label}: ${f.message}`)].join('\n');
  return (
    <button type="button" onClick={onClick} title={title} className={`bt-ai-badge bt-ai-badge--${status}`}>
      {aiIsBusy(status) ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Bot className="h-3 w-3" aria-hidden="true" />}
      {AI_STATUS_LABELS[status]}
    </button>
  );
}

const FINDING_ICON: Record<AiFinding['status'], typeof Info> = {
  ok: CheckCircle2,
  info: Info,
  corrected: Sparkles,
  mismatch: AlertTriangle,
  warning: AlertTriangle,
};

const money = (value: number | null) => (value === null || value === undefined
  ? '—'
  : `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

export function AiReviewModal({ entityType, entityId, title, onClose, onChanged }: {
  entityType: AiEntityType;
  entityId: string;
  title: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [review, setReview] = useState<AiReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setReview(await fetchAiReview(entityType, entityId));
      setError('');
    } catch (err: any) {
      setError(err?.response?.data?.error || 'The AI review could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId]);

  useEffect(() => { void load(); }, [load]);

  // Follow a read in progress.
  useEffect(() => {
    if (!review || !aiIsBusy(review.status)) return undefined;
    const timer = window.setInterval(() => { void load(); }, 3000);
    return () => window.clearInterval(timer);
  }, [review, load]);

  // Tell the page once a read it is following finishes.
  const [wasBusy, setWasBusy] = useState(false);
  useEffect(() => {
    if (!review) return;
    if (aiIsBusy(review.status)) setWasBusy(true);
    else if (wasBusy) {
      setWasBusy(false);
      onChanged?.();
    }
  }, [review, wasBusy, onChanged]);

  const run = async (key: string, action: () => Promise<{ review: AiReviewDetail | null } | AiReviewDetail | null>, done: string) => {
    setBusy(key);
    setError('');
    try {
      const result = await action();
      const next = result && 'review' in result ? result.review : (result as AiReviewDetail | null);
      if (next) setReview(next);
      toast.success(done);
      onChanged?.();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'That did not work. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const status = review?.status;
  const applicable = (review?.findings || []).filter(f => (f.status === 'mismatch' || f.status === 'warning') && f.suggest);
  const corrections = review?.corrections || [];

  return (
    <Modal isOpen onClose={onClose} title="AI check" description={title} size="lg">
      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : !review ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">The AI has not read this document yet.</p>
          <button type="button" className="bt-vs-btn bt-vs-btn--primary" disabled={busy !== null}
            onClick={() => void run('rerun', () => rerunAiReview(entityType, entityId, false), 'The AI will read it now')}>
            <Bot className="h-4 w-4" /> Read with AI
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className={`bt-ai-status-panel bt-ai-status-panel--${status}`}>
            <div className="flex items-start gap-2">
              {aiIsBusy(status) ? <Loader2 className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin" /> : <Bot className="mt-0.5 h-4 w-4 flex-shrink-0" />}
              <div className="min-w-0">
                <p className="text-sm font-bold">{status ? AI_STATUS_LABELS[status].replace('AI: ', 'AI ') : ''}</p>
                <p className="mt-0.5 text-xs">{status ? AI_STATUS_HELP[status] : ''}</p>
                {review.error ? <p className="mt-1 text-xs">{review.error}</p> : null}
                {review.summary ? <p className="mt-1 text-xs opacity-90">{review.summary}</p> : null}
                {review.reviewed_at ? (
                  <p className="mt-1 text-[11px] opacity-75">
                    Checked {formatEasternDateTime(review.reviewed_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}{review.model ? ` · ${review.model}` : ''}
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          {review.findings.length ? (
            <ul className="space-y-1.5">
              {review.findings.map(f => {
                const Icon = FINDING_ICON[f.status] || Info;
                return (
                  <li key={`${f.field}-${f.label}`} className={`bt-ai-finding bt-ai-finding--${f.status}`}>
                    <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold uppercase tracking-wide opacity-80">{f.label}</p>
                      <p className="text-sm">{f.message}</p>
                    </div>
                    {(f.status === 'mismatch' || f.status === 'warning') && f.suggest ? (
                      <button type="button" className="bt-vs-btn flex-shrink-0" disabled={busy !== null}
                        onClick={() => void run(`apply-${f.field}`, () => applyAiReview(entityType, entityId, [f.field]),
                          f.field === 'split' ? 'The other documents in this file were filed' : `${f.label} updated from the document`)}>
                        {busy === `apply-${f.field}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                        {f.field === 'split' ? 'File the others' : 'Use AI reading'}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {review.documents.length ? (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase text-slate-500">
                What the AI read{review.documents.length > 1 ? ` - ${review.documents.length} documents in this file` : ''}
              </p>
              <div className="overflow-x-auto rounded-md border border-slate-200">
                <table className="w-full min-w-[560px] text-left text-xs">
                  <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
                    <tr>
                      <th className="px-2.5 py-1.5 font-semibold">Vendor</th>
                      <th className="px-2.5 py-1.5 font-semibold">Job address</th>
                      <th className="px-2.5 py-1.5 font-semibold">Work</th>
                      <th className="px-2.5 py-1.5 font-semibold">Dated</th>
                      <th className="px-2.5 py-1.5 text-right font-semibold">Total</th>
                      <th className="px-2.5 py-1.5 font-semibold">Pages</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {review.documents.map(doc => (
                      <tr key={doc.index} className={doc.index === review.entry_index && review.documents.length > 1 ? 'bt-ai-read-current' : ''}>
                        <td className="px-2.5 py-1.5 font-semibold text-slate-900">{doc.vendor || '(not printed)'}</td>
                        <td className="px-2.5 py-1.5 text-slate-700">{doc.property || '—'}</td>
                        <td className="px-2.5 py-1.5 text-slate-700">{doc.trade || '—'}</td>
                        <td className="whitespace-nowrap px-2.5 py-1.5 text-slate-700">{doc.executed_date || doc.document_date || '—'}</td>
                        <td className="whitespace-nowrap px-2.5 py-1.5 text-right text-slate-700">{money(doc.total_amount)}</td>
                        <td className="px-2.5 py-1.5 text-slate-700">{doc.pages || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {error ? <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</div> : null}

          <div className="flex flex-wrap justify-end gap-2">
            {corrections.length ? (
              <button type="button" className="bt-vs-btn" disabled={busy !== null}
                onClick={() => void run('undo', () => undoAiReview(entityType, entityId), 'Put back how it was filed before')}>
                {busy === 'undo' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                Undo AI changes ({corrections.length})
              </button>
            ) : null}
            <button type="button" className="bt-vs-btn" disabled={busy !== null || aiIsBusy(status)}
              onClick={() => void run('rerun', () => rerunAiReview(entityType, entityId, true), 'The AI is reading it again')}>
              {busy === 'rerun' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Read again
            </button>
            {applicable.length > 1 ? (
              <button type="button" className="bt-vs-btn bt-vs-btn--primary" disabled={busy !== null}
                onClick={() => void run('apply-all', () => applyAiReview(entityType, entityId, applicable.map(f => f.field)), 'Filed the way the document reads')}>
                {busy === 'apply-all' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                Use all AI readings
              </button>
            ) : null}
            <button type="button" className="bt-vs-btn" onClick={onClose}>Close</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
