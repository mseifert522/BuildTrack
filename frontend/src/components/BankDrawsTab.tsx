import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, CheckCircle2, ExternalLink, Landmark, Loader2, PencilLine, RefreshCw, Scale, ShieldCheck, Tag, TrendingUp, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { formatDateOnly, formatEasternRelative } from '../lib/time';
import { Modal } from './ui';
import '../styles/bank-draws.css';

// Finance tab (Mike, 2026-10-19; named "Bank Draws" until the same afternoon). Each
// project's own construction-loan draws from QuickBooks account 1130 (Funds in Escrow /
// Holdbacks) allocated by the project's class, the manually entered potential sale
// (less the realtor commission and closing costs), then the project's financing (Balance
// Sheet) and Profit & Loss for that class, each in its own block. Super Admin, and users a
// Super Admin granted, only - the backend refuses everyone else.

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
  commission_pct: number;
  commission: number | null;
  closing_costs: number;
  selling_costs: number | null;
  net_proceeds: number | null;
  loan_payoff: number | null;
  cash_back: number | null;
  invested: number | null;
  projected_profit: number | null;
  cash_in: number | null;
  updated_at: string | null;
  updated_by_name: string | null;
};

type MatchStatus = 'exact' | 'number_differs' | 'mismatch' | 'auto_linked' | 'confirmed_alias' | 'unlinked' | 'ambiguous' | 'class_missing';

type BankDrawPayload = {
  project: { id: string; address: string; job_name: string; quickbooks_class_id: string | null; quickbooks_class_name: string | null; arv?: number | null };
  default_commission_pct: number;
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
    match: { status: MatchStatus; class_name: string | null; candidates?: string[]; aliases?: string[] };
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

// The project's QuickBooks class. A class whose name does not match the address can be
// confirmed as this property (Mike, 2026-10-19: 2153 Milverton is recorded in QuickBooks
// as "1253 Milverton" - same class, same project); entries under either name then count
// here. Confirming / undoing is for Super Admins.
function ClassMatch({ finance, project, canConfirm, onUpdated }: {
  finance: BankDrawPayload['finance'];
  project: BankDrawPayload['project'];
  canConfirm: boolean;
  onUpdated: (next: BankDrawPayload) => void;
}) {
  const [busy, setBusy] = useState(false);
  const match = finance?.match;
  const className = match?.class_name || project.quickbooks_class_name;
  const change = async (method: 'post' | 'delete') => {
    setBusy(true);
    try {
      const res = method === 'post'
        ? await api.post<BankDrawPayload>(`/projects/${project.id}/bank-draws/class-alias`, { class_name: className })
        : await api.delete<BankDrawPayload>(`/projects/${project.id}/bank-draws/class-alias`, { data: { class_name: className } });
      onUpdated(res.data);
      toast.success(method === 'post' ? `“${className}” confirmed as this property` : 'Confirmation removed');
    } catch (err: any) {
      const body = err?.response?.data as BankDrawPayload & { error?: string } | undefined;
      if (body?.register) onUpdated(body);
      toast.error(body?.error || 'The QuickBooks class could not be updated.');
    } finally {
      setBusy(false);
    }
  };
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
      <div className="bt-bd-match is-warn" title="Linked by QuickBooks class ID">
        <AlertTriangle className="h-3.5 w-3.5" />
        <span>
          QuickBooks class “{className}” does not match this project’s address. It is linked by class ID.
          {canConfirm ? ' If it is the same property, confirm it and entries under either name will count here.' : ' A Super Admin can confirm it is the same property.'}
          {canConfirm && (
            <button type="button" className="bt-bd-btn bt-bd-match__action" onClick={() => void change('post')} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} This is the same property
            </button>
          )}
        </span>
      </div>
    );
  }
  if (match.status === 'class_missing') {
    return <p className="bt-bd-match is-warn"><AlertTriangle className="h-3.5 w-3.5" /> The linked QuickBooks class no longer exists.</p>;
  }
  if (match.status === 'confirmed_alias') {
    const address = (project.address || project.job_name || '').split(',')[0];
    return (
      <div className="bt-bd-match">
        <CheckCircle2 className="h-3.5 w-3.5" />
        <span>
          QuickBooks class “{className}”{extra.length ? ` + ${extra.join(', ')}` : ''} · confirmed as {address} (the class name in QuickBooks is spelled differently). Entries recorded under either name count here.
          {canConfirm && (
            <button type="button" className="bt-bd-match__undo" onClick={() => void change('delete')} disabled={busy}>Undo</button>
          )}
        </span>
      </div>
    );
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
    <Modal isOpen onClose={onClose} title="Who can see the financial tabs" description="Only Super Admins see Finance automatically. Give an Operations Manager, or anyone else, access here." size="lg">
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

// Potential sale (Mike, 2026-10-19): "what the house could sell for minus closing
// costs", then "allow user to adjust ... 3% for realtor commission standard and then
// manually add closing costs". Entered by hand; the payoff and profit lines come from
// the class's balance sheet. The server computes every line (services/bankDraws.js).
function PotentialSale({ projectId, data, onSaved }: { projectId: string; data: BankDrawPayload; onSaved: (next: BankDrawPayload) => void }) {
  const p = data.projection;
  const defaultPct = data.default_commission_pct ?? 3;
  const [editing, setEditing] = useState(false);
  const [price, setPrice] = useState('');
  const [pct, setPct] = useState('');
  const [closing, setClosing] = useState('');
  const [saving, setSaving] = useState(false);
  const arv = Number(data.project.arv) > 0 ? Number(data.project.arv) : null;
  const moneyInput = (next: string) => /^[0-9,]*\.?[0-9]{0,2}$/.test(next);
  const toNumber = (value: string) => Number(String(value).replace(/[^0-9.]/g, ''));

  const startEdit = (prefill?: number | null) => {
    setPrice(prefill !== undefined && prefill !== null ? String(prefill) : p.potential_sale_price !== null ? String(p.potential_sale_price) : '');
    setPct(String(p.commission_pct ?? defaultPct));
    setClosing(p.closing_costs ? String(p.closing_costs) : '');
    setEditing(true);
  };
  const save = async (clear = false) => {
    setSaving(true);
    try {
      const res = await api.put<BankDrawPayload>(`/projects/${projectId}/bank-draws/projection`, {
        potential_sale_price: clear ? '' : price,
        commission_pct: pct === '' ? defaultPct : pct,
        closing_costs: clear ? '' : closing,
      });
      onSaved(res.data);
      setEditing(false);
      toast.success(clear ? 'Potential sales price cleared' : 'Potential sale saved');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'The potential sale could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    const priceNum = toNumber(price);
    const pctNum = pct === '' ? defaultPct : Number(pct);
    const closingNum = closing === '' ? 0 : toNumber(closing);
    const valid = price !== '' && Number.isFinite(priceNum) && Number.isFinite(pctNum) && pctNum >= 0 && pctNum <= 10 && Number.isFinite(closingNum);
    const commission = valid ? Math.round(priceNum * pctNum) / 100 : null;
    return (
      // data-autosave="off": the app-wide draft saver keys drafts per form, not per
      // project, so it could restore one house's unsaved figures into another's.
      <form className="bt-bd-proj-form" onSubmit={event => { event.preventDefault(); if (valid) void save(); }}>
        <label className="bt-bd-field">
          <span>Potential sales price</span>
          <span className="bt-bd-money">
            <span className="bt-bd-money__sign" aria-hidden="true">$</span>
            <input type="text" inputMode="decimal" autoComplete="off" data-autosave="off" value={price} placeholder="0.00"
              onChange={event => { const next = event.currentTarget.value; if (moneyInput(next)) setPrice(next); }}
              className="bt-bd-input bt-bd-input--money" />
          </span>
        </label>
        <label className="bt-bd-field">
          <span>Realtor commission (%)</span>
          <input type="number" inputMode="decimal" step="0.25" min="0" max="10" autoComplete="off" data-autosave="off" value={pct}
            onChange={event => setPct(event.currentTarget.value)} className="bt-bd-input" />
        </label>
        <label className="bt-bd-field">
          <span>Closing costs</span>
          <span className="bt-bd-money">
            <span className="bt-bd-money__sign" aria-hidden="true">$</span>
            <input type="text" inputMode="decimal" autoComplete="off" data-autosave="off" value={closing} placeholder="0.00"
              onChange={event => { const next = event.currentTarget.value; if (moneyInput(next)) setClosing(next); }}
              className="bt-bd-input bt-bd-input--money" />
          </span>
        </label>
        <p className="bt-bd-proj-preview" aria-live="polite">
          {valid && commission !== null
            ? <>Commission {usd(commission)} + closing costs {usd(closingNum)} · Net sale proceeds <strong>{usd(priceNum - commission - closingNum)}</strong></>
            : `Enter the price the house could sell for. The realtor commission is ${defaultPct}% unless you change it; add the closing costs in dollars.`}
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
        <p>No potential sales price yet. Enter what this house could sell for — BuildTrack takes off the realtor commission ({p.commission_pct ?? defaultPct}% standard, adjustable) and the closing costs you add, and shows what comes back after the loans are paid.</p>
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
        <Kpi tone="out" label="Commission + closing costs" value={usd(p.selling_costs)} note={`${p.commission_pct}% commission ${usd(p.commission)} + closing costs ${usd(p.closing_costs)}`} />
        <Kpi tone="due" label="Net sale proceeds" value={usd(p.net_proceeds)} note="Sales price minus commission and closing costs" />
        <Kpi tone={hasBooks ? ((p.projected_profit || 0) >= 0 ? 'good' : 'bad') : 'plain'} icon={<TrendingUp className="h-3.5 w-3.5" />} label="Projected profit" value={hasBooks ? usd(p.projected_profit) : '—'} note={hasBooks ? `Net proceeds minus ${usd(p.invested)} invested` : 'Needs the QuickBooks balance sheet'} />
      </div>
      <div className="bt-bd-tablewrap">
        <table className="bt-bd-stmt">
          <thead><tr><th scope="col">Potential sale</th><th scope="col" className="bt-bd-num">Amount</th></tr></thead>
          <tbody>
            <tr className="bt-bd-stmt__line"><td>Potential sales price</td><td className="bt-bd-num">{usd(p.potential_sale_price)}</td></tr>
            <tr className="bt-bd-stmt__line"><td>Less realtor commission ({p.commission_pct}%)</td><td className="bt-bd-num is-negative">{usd(-(p.commission || 0))}</td></tr>
            <tr className="bt-bd-stmt__line"><td>Less closing costs{p.closing_costs ? '' : ' (none entered)'}</td><td className={`bt-bd-num${p.closing_costs ? ' is-negative' : ''}`}>{usd(-(p.closing_costs || 0))}</td></tr>
            <tr className="bt-bd-stmt__total"><td>Net sale proceeds</td><td className="bt-bd-num">{usd(p.net_proceeds)}</td></tr>
            {hasBooks && (
              <>
                <tr className="bt-bd-stmt__line">
                  <td>Less loans &amp; payables paid off at sale{fin ? ` (owed ${usd(fin.total_liabilities)}, less ${usd(fin.escrow_balance)} still in escrow)` : ''}</td>
                  <td className="bt-bd-num is-negative">{usd(-(p.loan_payoff || 0))}</td>
                </tr>
                <tr className="bt-bd-stmt__grand"><td>Approximate funds to be returned (cash back at sale)</td><td className={`bt-bd-num${(p.cash_back || 0) < 0 ? ' is-negative' : ''}`}>{usd(p.cash_back)}</td></tr>
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

// Approximate funds to be returned (Mike, 2026-10-19): "at the bottom under the
// liabilities ... approximate funds including profit in cash to be returned", i.e. how
// much money should come back from the project after expenses. Cash in the project
// (invested less what the lenders take back at payoff) plus the projected profit from
// the potential sale = the cash back at sale. Figures come from the server.
function FundsReturned({ p }: { p: Projection }) {
  if (p.cash_in === null) return null;
  const priced = p.potential_sale_price !== null && p.projected_profit !== null && p.cash_back !== null;
  return (
    <section className="bt-bd-return" aria-labelledby="bt-bd-return-title">
      <div className="bt-bd-return__head">
        <p id="bt-bd-return-title" className="bt-bd-return__title">Approximate funds to be returned</p>
        <p className="bt-bd-return__sub">The money expected back from this project after the house sells, the loans are paid off, and the commission and closing costs are paid: your cash in the project plus the profit.</p>
      </div>
      <table className="bt-bd-stmt bt-bd-return__table">
        <tbody>
          <tr className="bt-bd-stmt__line">
            <td>Cash in the project<span className="bt-bd-return__hint">Invested {usd(p.invested)}, less {usd(p.loan_payoff)} paid off to the lenders at sale</span></td>
            <td className="bt-bd-num">{usd(p.cash_in)}</td>
          </tr>
          <tr className="bt-bd-stmt__line">
            <td>Plus projected profit<span className="bt-bd-return__hint">{priced ? `At the ${usd(p.potential_sale_price)} potential sale, after ${usd(p.selling_costs)} commission and closing costs` : 'Enter a potential sales price in section 2 to include the profit'}</span></td>
            <td className={`bt-bd-num${priced && (p.projected_profit || 0) < 0 ? ' is-negative' : ''}`}>{priced ? usd(p.projected_profit) : '—'}</td>
          </tr>
          <tr className="bt-bd-stmt__grand bt-bd-return__total">
            <td>Approximate funds to be returned</td>
            <td className={`bt-bd-num${priced && (p.cash_back || 0) < 0 ? ' is-negative' : ''}`}>{priced ? usd(p.cash_back) : '—'}</td>
          </tr>
        </tbody>
      </table>
    </section>
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
          <ClassMatch finance={finance} project={data.project} canConfirm={canManageAccess} onUpdated={setData} />
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

      <Block step={2} title="Potential sale" subtitle="Entered by hand · what the house could sell for, less the realtor commission and closing costs">
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
            <FundsReturned p={data.projection} />
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
