import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, CheckCircle2, ExternalLink, Landmark, Loader2, PencilLine, RefreshCw, Scale, ShieldCheck, Tag, TrendingUp, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { formatDateOnly, formatEasternRelative } from '../lib/time';
import { Modal } from './ui';
import CurrencyInput from './CurrencyInput';
import '../styles/bank-draws.css';

// Finance tab (Mike, 2026-10-19; named "Bank Draws" until the same afternoon). Each
// project's own construction-loan draws from QuickBooks account 1130 (Funds in Escrow /
// Holdbacks) allocated by the project's class, the manually entered potential sale
// (less ~3.5% closing costs), then the project's financing (Balance Sheet) and Profit & Loss for that
// class, each in its own block. Super Admin, Operations Manager and users granted
// access only - the backend refuses everyone else, project managers included.

type RegisterRow = {
  id: string;
  kind: 'draw' | 'holdback_funded' | 'escrow_adjustment';
  draw_number: number | null;
  date: string | null;
  type: string | null;
  ref_no: string | null;
  payee: string | null;
  memo: string | null;
  account: string | null;
  decrease: number | null;
  increase: number | null;
  balance: number;
  qbo_url: string | null;
};

type StatementNode =
  | { kind: 'section'; title: string; group: string | null; total: number | null; totalLabel: string; children: StatementNode[] }
  | { kind: 'line'; account: string; accountId: string | null; amount: number }
  | { kind: 'total'; title: string; amount: number; group: string | null };

type FinanceSummary = {
  total_assets: number;
  invested: number;
  current_assets: number;
  escrow_balance: number;
  total_liabilities: number;
  net_debt_after_escrow: number;
  owner_equity: number;
  income: number | null;
  cost_of_goods_sold: number | null;
  gross_profit: number | null;
  expenses: number | null;
  net_income: number | null;
};

type Projection = {
  potential_sale_price: number | null;
  closing_cost_pct: number;
  closing_costs: number | null;
  net_proceeds: number | null;
  loan_payoff: number | null;
  cash_back: number | null;
  invested: number | null;
  projected_profit: number | null;
  updated_at: string | null;
  updated_by_name: string | null;
};

type MatchStatus = 'exact' | 'number_differs' | 'mismatch' | 'auto_linked' | 'unlinked' | 'ambiguous' | 'class_missing';

type BankDrawPayload = {
  project: { id: string; address: string; job_name: string; quickbooks_class_id: string | null; quickbooks_class_name: string | null; arv?: number | null };
  default_closing_cost_pct: number;
  projection: Projection;
  linked: boolean;
  quickbooks: { connected: boolean; last_synced_at: string | null; status: string; error: string | null; stale: boolean };
  summary: {
    holdback_funded: number;
    drawn: number;
    escrow_adjustments: number;
    holdback_remaining: number;
    draw_count: number;
    last_draw_date: string | null;
    last_draw_amount: number | null;
    percent_drawn: number | null;
  };
  register: RegisterRow[];
  finance: {
    class_id: string | null;
    class_names: string[];
    match: { status: MatchStatus; class_name: string | null; candidates?: string[] };
    summary: FinanceSummary | null;
    balance_sheet: { sections: StatementNode[]; found: boolean };
    profit_loss: { sections: StatementNode[]; found: boolean };
    period: { start: string; end: string };
  } | null;
  error?: string;
};

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd = (value: number | null | undefined) => (value === null || value === undefined ? '—' : currency.format(value));
const shortDate = (value: string | null | undefined) => (value ? formatDateOnly(value) : '—');

const KIND_LABEL: Record<RegisterRow['kind'], string> = {
  draw: 'Draw',
  holdback_funded: 'Holdback set aside',
  escrow_adjustment: 'Escrow adjustment',
};

function Kpi({ label, value, note, tone = 'plain', icon }: { label: string; value: string; note?: string; tone?: 'plain' | 'in' | 'out' | 'due' | 'good' | 'bad'; icon?: ReactNode }) {
  return (
    <div className={`bt-bd-kpi is-${tone}`}>
      <p className="bt-bd-kpi__label">{icon}{label}</p>
      <p className="bt-bd-kpi__value">{value}</p>
      {note && <p className="bt-bd-kpi__note">{note}</p>}
    </div>
  );
}

function StatementRows({ nodes, depth = 0 }: { nodes: StatementNode[]; depth?: number }) {
  return (
    <>
      {nodes.map((node, index) => {
        if (node.kind === 'line') {
          return (
            <tr key={`${depth}-${index}-${node.account}`} className="bt-bd-stmt__line">
              <td style={{ paddingLeft: `${14 + depth * 18}px` }}>{node.account}</td>
              <td className="bt-bd-num">{usd(node.amount)}</td>
            </tr>
          );
        }
        if (node.kind === 'total') {
          return (
            <tr key={`${depth}-${index}-${node.title}`} className="bt-bd-stmt__grand">
              <td>{node.title}</td>
              <td className={`bt-bd-num${node.amount < 0 ? ' is-negative' : ''}`}>{usd(node.amount)}</td>
            </tr>
          );
        }
        return (
          <Fragment key={`${depth}-${index}-${node.title}`}>
            <tr className={depth === 0 ? 'bt-bd-stmt__group' : 'bt-bd-stmt__sub'}>
              <td colSpan={2} style={{ paddingLeft: `${14 + depth * 18}px` }}>{node.title}</td>
            </tr>
            <StatementRows nodes={node.children} depth={depth + 1} />
            {node.total !== null && (
              <tr className={depth === 0 ? 'bt-bd-stmt__total is-top' : 'bt-bd-stmt__total'}>
                <td style={{ paddingLeft: `${14 + depth * 18}px` }}>{node.totalLabel}</td>
                <td className={`bt-bd-num${node.total < 0 ? ' is-negative' : ''}`}>{usd(node.total)}</td>
              </tr>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

function Block({ step, title, subtitle, children }: { step: number; title: string; subtitle: string; children: ReactNode }) {
  return (
    <section className="bt-bd-block" aria-labelledby={`bt-bd-block-${step}`}>
      <div className="bt-bd-block__intro">
        <span className="bt-bd-block__step" aria-hidden="true">{step}</span>
        <div className="min-w-0">
          <h4 id={`bt-bd-block-${step}`} className="bt-bd-block__title">{title}</h4>
          <p className="bt-bd-block__subtitle">{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function ClassMatch({ finance, project }: { finance: BankDrawPayload['finance']; project: BankDrawPayload['project'] }) {
  const match = finance?.match;
  const className = match?.class_name || project.quickbooks_class_name;
  if (!match || match.status === 'unlinked' || match.status === 'ambiguous' || !className) {
    return (
      <p className="bt-bd-match is-warn">
        <AlertTriangle className="h-3.5 w-3.5" />
        No QuickBooks class matches this address yet
        {match?.candidates?.length ? ` (closest: ${match.candidates.join(', ')})` : ''}.
      </p>
    );
  }
  const extra = (finance?.class_names || []).slice(1);
  if (match.status === 'number_differs' || match.status === 'mismatch') {
    return (
      <p className="bt-bd-match is-warn" title="Linked by QuickBooks class ID">
        <AlertTriangle className="h-3.5 w-3.5" />
        QuickBooks class “{className}” — the class name does not match this project’s address. Linked by class ID; please correct the name in QuickBooks.
      </p>
    );
  }
  if (match.status === 'class_missing') {
    return <p className="bt-bd-match is-warn"><AlertTriangle className="h-3.5 w-3.5" /> The linked QuickBooks class no longer exists.</p>;
  }
  return (
    <p className="bt-bd-match">
      <CheckCircle2 className="h-3.5 w-3.5" />
      QuickBooks class “{className}”{extra.length ? ` + ${extra.join(', ')}` : ''} · matched to this address{match.status === 'auto_linked' ? ' automatically' : ''}
    </p>
  );
}

function AccessManager({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<{ role_holders: { user_id: string; name: string; role: string }[]; users: { user_id: string; name: string; email: string; role: string; granted: boolean }[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    api.get('/feature-access/bank_draws').then(res => setData(res.data)).catch(() => toast.error('Could not load who has access.'));
  }, []);
  const toggle = async (userId: string, granted: boolean) => {
    setBusy(userId);
    try {
      const res = granted ? await api.delete(`/feature-access/bank_draws/${userId}`) : await api.put(`/feature-access/bank_draws/${userId}`);
      setData(current => (current ? { ...current, users: res.data.users } : current));
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Access could not be changed.');
    } finally {
      setBusy(null);
    }
  };
  const roleLabel = (role: string) => ({ super_admin: 'Super Admin', operations_manager: 'Operations Manager', project_manager: 'Project Manager' } as Record<string, string>)[role] || role.replace(/_/g, ' ');
  return (
    <Modal isOpen onClose={onClose} title="Who can see Finance" description="Super Admins and Operations Managers always can. Give anyone else access here." size="lg">
      {!data ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : (
        <div className="bt-bd-access">
          <p className="bt-bd-access__heading">Always have access</p>
          <ul>
            {data.role_holders.map(person => (
              <li key={person.user_id} className="bt-bd-access__row">
                <span className="bt-bd-access__name">{person.name}<small>{roleLabel(person.role)}</small></span>
                <span className="bt-bd-access__badge"><ShieldCheck className="h-3.5 w-3.5" /> By role</span>
              </li>
            ))}
          </ul>
          <p className="bt-bd-access__heading">Assigned access</p>
          {data.users.length === 0 ? (
            <p className="bt-bd-access__empty">No other active staff accounts.</p>
          ) : (
            <ul>
              {data.users.map(person => (
                <li key={person.user_id} className="bt-bd-access__row">
                  <span className="bt-bd-access__name">{person.name}<small>{roleLabel(person.role)} · {person.email}</small></span>
                  <label className="bt-bd-access__switch">
                    <input
                      type="checkbox"
                      checked={person.granted}
                      disabled={busy === person.user_id}
                      onChange={() => void toggle(person.user_id, person.granted)}
                    />
                    <span>{person.granted ? 'Has access' : 'No access'}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

// Potential sale (Mike, 2026-10-19): "what the house could sell for minus closing costs,
// roughly 3.5% for each property". Entered by hand; the figures below it come from the
// class's balance sheet. The server computes every line (services/bankDraws.js).
function PotentialSale({ projectId, data, onSaved }: { projectId: string; data: BankDrawPayload; onSaved: (next: BankDrawPayload) => void }) {
  const p = data.projection;
  const defaultPct = data.default_closing_cost_pct ?? 3.5;
  const [editing, setEditing] = useState(false);
  const [price, setPrice] = useState('');
  const [pct, setPct] = useState('');
  const [saving, setSaving] = useState(false);
  const arv = Number(data.project.arv) > 0 ? Number(data.project.arv) : null;

  const startEdit = (prefill?: number | null) => {
    setPrice(prefill !== undefined && prefill !== null ? String(prefill) : p.potential_sale_price !== null ? String(p.potential_sale_price) : '');
    setPct(String(p.closing_cost_pct ?? defaultPct));
    setEditing(true);
  };
  const save = async (clear = false) => {
    setSaving(true);
    try {
      const res = await api.put<BankDrawPayload>(`/projects/${projectId}/bank-draws/projection`, {
        potential_sale_price: clear ? '' : price,
        closing_cost_pct: pct === '' ? defaultPct : pct,
      });
      onSaved(res.data);
      setEditing(false);
      toast.success(clear ? 'Potential sales price cleared' : 'Potential sales price saved');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'The potential sales price could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    const priceNum = Number(String(price).replace(/[^0-9.]/g, ''));
    const pctNum = pct === '' ? defaultPct : Number(pct);
    const valid = price !== '' && Number.isFinite(priceNum) && Number.isFinite(pctNum) && pctNum >= 0 && pctNum <= 20;
    const closing = valid ? Math.round(priceNum * pctNum) / 100 : null;
    return (
      <form className="bt-bd-proj-form" onSubmit={event => { event.preventDefault(); if (valid) void save(); }}>
        <label className="bt-bd-field">
          <span>Potential sales price</span>
          <CurrencyInput value={price} onChange={setPrice} placeholder="0.00" className="bt-bd-input" />
        </label>
        <label className="bt-bd-field is-narrow">
          <span>Closing costs (%)</span>
          <input type="number" inputMode="decimal" step="0.1" min="0" max="20" value={pct} onChange={event => setPct(event.currentTarget.value)} className="bt-bd-input" />
        </label>
        <p className="bt-bd-proj-preview" aria-live="polite">
          {valid && closing !== null
            ? <>Closing costs {usd(closing)} · Net sale proceeds <strong>{usd(priceNum - closing)}</strong></>
            : 'Enter the price the house could sell for. Closing costs default to 3.5%.'}
        </p>
        <div className="bt-bd-proj-actions">
          <button type="submit" className="bt-bd-btn bt-bd-btn--primary" disabled={!valid || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Save
          </button>
          <button type="button" className="bt-bd-btn" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
          {p.potential_sale_price !== null && (
            <button type="button" className="bt-bd-btn is-danger" onClick={() => void save(true)} disabled={saving}>Clear</button>
          )}
        </div>
      </form>
    );
  }

  if (p.potential_sale_price === null) {
    return (
      <div className="bt-bd-empty bt-bd-proj-start">
        <p>No potential sales price yet. Enter what this house could sell for — BuildTrack takes {p.closing_cost_pct ?? defaultPct}% off for closing costs and shows what comes back after the loans are paid.</p>
        <div className="bt-bd-proj-actions is-centered">
          <button type="button" className="bt-bd-btn bt-bd-btn--primary" onClick={() => startEdit()}>
            <PencilLine className="h-4 w-4" /> Add potential sales price
          </button>
          {arv !== null && (
            <button type="button" className="bt-bd-btn" onClick={() => startEdit(arv)}>Start from the ARV ({usd(arv)})</button>
          )}
        </div>
      </div>
    );
  }

  const hasBooks = p.loan_payoff !== null && p.invested !== null;
  const fin = data.finance?.summary || null;
  return (
    <>
      <div className="bt-bd-kpis">
        <Kpi tone="in" icon={<Tag className="h-3.5 w-3.5" />} label="Potential sales price" value={usd(p.potential_sale_price)} note="Entered by hand" />
        <Kpi tone="out" label={`Closing costs (${p.closing_cost_pct}%)`} value={usd(p.closing_costs)} note="Taken off the sales price" />
        <Kpi tone="due" label="Net sale proceeds" value={usd(p.net_proceeds)} note="Sales price minus closing costs" />
        <Kpi tone={hasBooks ? ((p.projected_profit || 0) >= 0 ? 'good' : 'bad') : 'plain'} icon={<TrendingUp className="h-3.5 w-3.5" />} label="Projected profit" value={hasBooks ? usd(p.projected_profit) : '—'} note={hasBooks ? `Net proceeds minus ${usd(p.invested)} invested` : 'Needs the QuickBooks balance sheet'} />
      </div>
      <div className="bt-bd-tablewrap">
        <table className="bt-bd-stmt">
          <thead><tr><th scope="col">Potential sale</th><th scope="col" className="bt-bd-num">Amount</th></tr></thead>
          <tbody>
            <tr className="bt-bd-stmt__line"><td>Potential sales price</td><td className="bt-bd-num">{usd(p.potential_sale_price)}</td></tr>
            <tr className="bt-bd-stmt__line"><td>Less closing costs ({p.closing_cost_pct}%)</td><td className="bt-bd-num is-negative">{usd(-(p.closing_costs || 0))}</td></tr>
            <tr className="bt-bd-stmt__total"><td>Net sale proceeds</td><td className="bt-bd-num">{usd(p.net_proceeds)}</td></tr>
            {hasBooks && (
              <>
                <tr className="bt-bd-stmt__line">
                  <td>Less loans &amp; payables paid off at sale{fin ? ` (owed ${usd(fin.total_liabilities)}, less ${usd(fin.escrow_balance)} still in escrow)` : ''}</td>
                  <td className="bt-bd-num is-negative">{usd(-(p.loan_payoff || 0))}</td>
                </tr>
                <tr className="bt-bd-stmt__grand"><td>Cash back at sale</td><td className={`bt-bd-num${(p.cash_back || 0) < 0 ? ' is-negative' : ''}`}>{usd(p.cash_back)}</td></tr>
                <tr className="bt-bd-stmt__line"><td>Total invested in the property (balance sheet)</td><td className="bt-bd-num">{usd(p.invested)}</td></tr>
                <tr className="bt-bd-stmt__grand"><td>Projected profit (net sale proceeds minus invested)</td><td className={`bt-bd-num${(p.projected_profit || 0) < 0 ? ' is-negative' : ''}`}>{usd(p.projected_profit)}</td></tr>
              </>
            )}
          </tbody>
        </table>
      </div>
      <div className="bt-bd-proj-meta">
        <span>{p.updated_by_name ? `Entered by ${p.updated_by_name}` : 'Entered'}{p.updated_at ? ` · ${formatEasternRelative(p.updated_at)}` : ''}{hasBooks ? '' : ' · payoff and profit appear once QuickBooks has a balance sheet for this class'}</span>
        <button type="button" className="bt-bd-btn" onClick={() => startEdit()}><PencilLine className="h-4 w-4" /> Edit</button>
      </div>
    </>
  );
}

export default function BankDrawsTab({ projectId, canManageAccess }: { projectId: string; canManageAccess: boolean }) {
  const [data, setData] = useState<BankDrawPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [accessOpen, setAccessOpen] = useState(false);
  const autoSynced = useRef(false);

  const sync = useCallback(async (manual: boolean) => {
    setSyncing(true);
    try {
      const res = await api.post<BankDrawPayload>(`/projects/${projectId}/bank-draws/sync`);
      setData(res.data);
      if (manual) toast.success('Updated from QuickBooks');
    } catch (err: any) {
      const body = err?.response?.data as BankDrawPayload | undefined;
      if (body?.register) setData(body);
      if (manual || !body?.register) toast.error(body?.error || 'QuickBooks could not be reached.');
    } finally {
      setSyncing(false);
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    autoSynced.current = false;
    setLoading(true);
    setLoadError('');
    api.get<BankDrawPayload>(`/projects/${projectId}/bank-draws`)
      .then(res => {
        if (cancelled) return;
        setData(res.data);
        // Pull fresh figures from QuickBooks whenever the saved copy is a few minutes old.
        if (res.data.quickbooks.connected && res.data.quickbooks.stale && !autoSynced.current) {
          autoSynced.current = true;
          void sync(false);
        }
      })
      .catch(err => { if (!cancelled) setLoadError(err?.response?.status === 403 ? 'You do not have access to Finance.' : 'Finance could not be loaded.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, sync]);

  if (loading) {
    return <div className="bt-bd-loading"><Loader2 className="h-5 w-5 animate-spin" /> Loading finance…</div>;
  }
  if (loadError || !data) {
    return <div className="bt-bd-loading">{loadError || 'Finance could not be loaded.'}</div>;
  }

  const { summary, register, finance, quickbooks } = data;
  const fin = finance?.summary || null;
  const className = finance?.match?.class_name || data.project.quickbooks_class_name || 'this project';
  const newestFirst = [...register].reverse();
  const neverSynced = !quickbooks.last_synced_at;
  const pct = summary.percent_drawn === null ? null : Math.round(summary.percent_drawn * 100);

  return (
    <div className="bt-bd">
      <div className="bt-bd-intro">
        <div className="min-w-0">
          <p className="bt-bd-eyebrow"><Landmark className="h-3.5 w-3.5" /> Finance · QuickBooks</p>
          <h3 className="bt-bd-title">{data.project.address || data.project.job_name}</h3>
          <ClassMatch finance={finance} project={data.project} />
        </div>
        <div className="bt-bd-sync">
          <span className="bt-bd-sync__status" aria-live="polite">
            {syncing ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating from QuickBooks…</>
              : neverSynced ? 'Not loaded from QuickBooks yet'
              : `Updated ${formatEasternRelative(quickbooks.last_synced_at)}`}
          </span>
          <button type="button" className="bt-bd-btn" onClick={() => void sync(true)} disabled={syncing || !quickbooks.connected}>
            <RefreshCw className={`h-4 w-4${syncing ? ' animate-spin' : ''}`} /> Refresh
          </button>
          {canManageAccess && (
            <button type="button" className="bt-bd-btn" onClick={() => setAccessOpen(true)}>
              <Users className="h-4 w-4" /> Access
            </button>
          )}
        </div>
      </div>

      {!quickbooks.connected && (
        <p className="bt-bd-banner is-warn"><AlertTriangle className="h-4 w-4" /> QuickBooks is not connected, so these figures cannot be updated.</p>
      )}
      {quickbooks.error && !syncing && (
        <p className="bt-bd-banner is-warn"><AlertTriangle className="h-4 w-4" /> The last QuickBooks update failed: {quickbooks.error} Showing the last copy BuildTrack saved.</p>
      )}

      <Block step={1} title="Bank draws" subtitle={`QuickBooks account 1130 · Funds in Escrow / Holdbacks · class ${className}`}>
        <div className="bt-bd-kpis">
          <Kpi tone="in" icon={<ArrowDownLeft className="h-3.5 w-3.5" />} label="In · holdback set aside" value={usd(summary.holdback_funded)} note="Held by the lender at closing" />
          <Kpi tone="out" icon={<ArrowUpRight className="h-3.5 w-3.5" />} label="Out · drawn to the project" value={usd(summary.drawn)} note={`${summary.draw_count} draw${summary.draw_count === 1 ? '' : 's'}${summary.escrow_adjustments ? ` · ${usd(Math.abs(summary.escrow_adjustments))} adjustments` : ''}`} />
          <Kpi tone="due" icon={<Scale className="h-3.5 w-3.5" />} label="Outstanding in escrow" value={usd(summary.holdback_remaining)} note="Still available to draw" />
          <Kpi label="Last draw" value={summary.last_draw_date ? shortDate(summary.last_draw_date) : '—'} note={summary.last_draw_amount !== null ? usd(summary.last_draw_amount) : 'No draws yet'} />
        </div>
        {pct !== null && (
          <div className="bt-bd-progress" role="img" aria-label={`${pct}% of the holdback drawn`}>
            <div className="bt-bd-progress__bar"><span style={{ width: `${pct}%` }} /></div>
            <p>{pct}% of the holdback drawn · {usd(summary.holdback_remaining)} left</p>
          </div>
        )}
        {register.length === 0 ? (
          <p className="bt-bd-empty">
            {neverSynced ? 'Loading from QuickBooks…' : `No construction loan entries on account 1130 for class ${className} yet. Draws will appear here as soon as they are booked in QuickBooks.`}
          </p>
        ) : (
          <div className="bt-bd-tablewrap">
            <table className="bt-bd-register">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Entry</th>
                  <th scope="col">Payee</th>
                  <th scope="col">Memo</th>
                  <th scope="col" className="bt-bd-num">Drawn (out)</th>
                  <th scope="col" className="bt-bd-num">Set aside (in)</th>
                  <th scope="col" className="bt-bd-num">In escrow</th>
                  <th scope="col">Account</th>
                  <th scope="col"><span className="sr-only">Open in QuickBooks</span></th>
                </tr>
              </thead>
              <tbody>
                {newestFirst.map(row => (
                  <tr key={row.id} className={`is-${row.kind}`}>
                    <td className="bt-bd-nowrap">{shortDate(row.date)}</td>
                    <td className="bt-bd-nowrap">
                      <span className={`bt-bd-chip is-${row.kind}`}>{row.kind === 'draw' ? `Draw ${row.draw_number}` : KIND_LABEL[row.kind]}</span>
                      <span className="bt-bd-sub">{[row.type, row.ref_no ? `#${row.ref_no}` : ''].filter(Boolean).join(' ')}</span>
                    </td>
                    <td>{row.payee || '—'}</td>
                    <td className="bt-bd-memo">{row.memo || '—'}</td>
                    <td className="bt-bd-num is-out">{row.decrease !== null ? usd(row.decrease) : ''}</td>
                    <td className="bt-bd-num is-in">{row.increase !== null ? usd(row.increase) : ''}</td>
                    <td className="bt-bd-num bt-bd-strong">{usd(row.balance)}</td>
                    <td className="bt-bd-account">{row.account || '—'}</td>
                    <td>
                      {row.qbo_url && (
                        <a href={row.qbo_url} target="_blank" rel="noopener noreferrer" className="bt-bd-qbo" title="Open this entry in QuickBooks">
                          <ExternalLink className="h-3.5 w-3.5" /><span className="sr-only">Open in QuickBooks</span>
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4}>Totals · {register.length} entr{register.length === 1 ? 'y' : 'ies'}</td>
                  <td className="bt-bd-num">{usd(register.reduce((s, r) => s + (r.decrease || 0), 0))}</td>
                  <td className="bt-bd-num">{usd(register.reduce((s, r) => s + (r.increase || 0), 0))}</td>
                  <td className="bt-bd-num">{usd(summary.holdback_remaining)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Block>

      <Block step={2} title="Potential sale" subtitle="Entered by hand · what the house could sell for, less closing costs">
        <PotentialSale projectId={projectId} data={data} onSaved={setData} />
      </Block>

      <Block step={3} title="Project financing" subtitle={`Balance sheet for class ${className} · as of ${shortDate(finance?.period?.end)} · line by line from QuickBooks`}>
        {!finance?.balance_sheet?.found || !fin ? (
          <p className="bt-bd-empty">{neverSynced ? 'Loading from QuickBooks…' : `QuickBooks has no balance sheet entries for class ${className}.`}</p>
        ) : (
          <>
            <div className="bt-bd-kpis">
              <Kpi icon={<Landmark className="h-3.5 w-3.5" />} label="Total invested in the property" value={usd(fin.invested)} note="Land, building, improvements and carried costs" />
              <Kpi tone="bad" icon={<Scale className="h-3.5 w-3.5" />} label="Loans & payables owed" value={usd(fin.total_liabilities)} note="All liabilities booked to this class" />
              <Kpi tone="due" icon={<ArrowDownLeft className="h-3.5 w-3.5" />} label="Holdback still in escrow" value={usd(fin.escrow_balance)} note={`Net debt after escrow ${usd(fin.net_debt_after_escrow)}`} />
              <Kpi tone={fin.owner_equity >= 0 ? 'good' : 'bad'} icon={<TrendingUp className="h-3.5 w-3.5" />} label="Equity in the project" value={usd(fin.owner_equity)} note="Total assets minus everything owed" />
            </div>
            <div className="bt-bd-tablewrap">
              <table className="bt-bd-stmt">
                <thead><tr><th scope="col">Account</th><th scope="col" className="bt-bd-num">Balance</th></tr></thead>
                <tbody><StatementRows nodes={finance.balance_sheet.sections} /></tbody>
              </table>
            </div>
          </>
        )}
      </Block>

      <Block step={4} title="Profit & Loss" subtitle={`Class ${className} · life to date, ${shortDate(finance?.period?.start)} – ${shortDate(finance?.period?.end)} · line by line from QuickBooks`}>
        {!finance?.profit_loss?.found || !fin ? (
          <p className="bt-bd-empty">
            {neverSynced ? 'Loading from QuickBooks…' : `No income or expenses have been booked to class ${className} yet. While a house is being renovated, its costs are carried on the balance sheet above until it sells.`}
          </p>
        ) : (
          <>
            <div className="bt-bd-kpis">
              <Kpi tone="in" label="Income" value={usd(fin.income)} />
              <Kpi label="Cost of goods sold" value={usd(fin.cost_of_goods_sold)} note={`Gross profit ${usd(fin.gross_profit)}`} />
              <Kpi label="Expenses" value={usd(fin.expenses)} />
              <Kpi tone={(fin.net_income || 0) >= 0 ? 'good' : 'bad'} label="Net income" value={usd(fin.net_income)} />
            </div>
            <div className="bt-bd-tablewrap">
              <table className="bt-bd-stmt">
                <thead><tr><th scope="col">Account</th><th scope="col" className="bt-bd-num">Amount</th></tr></thead>
                <tbody><StatementRows nodes={finance.profit_loss.sections} /></tbody>
              </table>
            </div>
          </>
        )}
      </Block>

      {accessOpen && <AccessManager onClose={() => setAccessOpen(false)} />}
    </div>
  );
}
