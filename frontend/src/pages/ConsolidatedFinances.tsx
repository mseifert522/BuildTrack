import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowDownLeft, Building2, ExternalLink, Home, Landmark, Loader2, RefreshCw, Scale, TrendingUp, Wallet } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { formatDateOnly, formatEasternRelative } from '../lib/time';
import '../styles/bank-draws.css';

// Consolidated Finances (Mike, 2026-10-19): "the combined amount of money outstanding,
// combined amount of loans and combined profit potential and combined money that should
// be coming back into the company upon the sale of the property, including equity",
// with rentals such as 171 Davis (equity, loans, interest paid monthly) - every New
// Urban Development project and rental, from QuickBooks. Super Admin, or users a Super
// Admin granted. Figures come from the server (services/consolidatedFinance.js).

type Monthly = { income: number; expenses: number; interest: number; net: number } | null;
type Row = {
  key: string;
  project_id: string | null;
  name: string;
  type: 'project' | 'rental';
  in_buildtrack: boolean;
  class_names: string[];
  sold: boolean;
  invested: number | null;
  loans_owed: number | null;
  escrow: number | null;
  equity: number | null;
  cash_in: number | null;
  carried_interest: number;
  loans: { account: string; amount: number }[];
  monthly: Monthly;
  potential_sale_price: number | null;
  projected_profit: number | null;
  coming_back: number | null;
  priced: boolean;
  sale_profit: number | null;
  rental_income: number | null;
  rental_expenses: number | null;
  rental_net: number | null;
  total_cash_in: number | null;
};
type Totals = {
  count: number;
  invested: number;
  loans_owed: number;
  escrow: number;
  cash_in: number;
  equity: number;
  projected_profit: number;
  coming_back: number;
  carried_interest: number;
  sale_profit: number;
  rental_income: number;
  rental_expenses: number;
  rental_net: number;
  priced_count: number;
  unpriced: { name: string; project_id: string | null }[];
  monthly: Monthly;
};
type Payload = {
  quickbooks: { connected: boolean; last_synced_at: string | null; error: string | null; stale: boolean; has_snapshot: boolean };
  period: { start: string; end: string; ttm_start?: string } | null;
  totals: Totals;
  projects: { totals: Totals; rows: Row[] };
  rentals: { totals: Totals; rows: Row[] };
  loans_by_account: { account: string; amount: number; properties: { name: string; amount: number }[] }[];
  sold: Row[];
  not_in_buildtrack: string[];
  error?: string;
};

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd = (value: number | null | undefined) => (value === null || value === undefined ? '—' : currency.format(value));

function Kpi({ label, value, note, tone = 'plain', icon }: { label: string; value: string; note?: string; tone?: 'plain' | 'in' | 'out' | 'due' | 'good' | 'bad'; icon?: ReactNode }) {
  return (
    <div className={`bt-bd-kpi is-${tone}`}>
      <p className="bt-bd-kpi__label">{icon}{label}</p>
      <p className="bt-bd-kpi__value">{value}</p>
      {note && <p className="bt-bd-kpi__note">{note}</p>}
    </div>
  );
}

function Block({ step, title, subtitle, children }: { step: number; title: string; subtitle: string; children: ReactNode }) {
  return (
    <section className="bt-bd-block" aria-labelledby={`bt-cf-block-${step}`}>
      <div className="bt-bd-block__intro">
        <span className="bt-bd-block__step" aria-hidden="true">{step}</span>
        <div className="min-w-0">
          <h4 id={`bt-cf-block-${step}`} className="bt-bd-block__title">{title}</h4>
          <p className="bt-bd-block__subtitle">{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

const neg = (value: number | null) => (value !== null && value < 0 ? ' is-negative' : '');

function PropertyRow({ row }: { row: Row }) {
  return (
    <tr>
      <td>
        {row.project_id
          ? <Link to={`/projects/${row.project_id}#finance`} className="bt-cf-link">{row.name}<ExternalLink className="h-3 w-3" /></Link>
          : <span className="bt-cf-name">{row.name}</span>}
        <span className="bt-bd-sub">{row.in_buildtrack ? `QuickBooks: ${row.class_names.join(', ')}` : 'In QuickBooks, not in BuildTrack'}</span>
      </td>
      <td className="bt-bd-num">{usd(row.invested)}</td>
      <td className="bt-bd-num">{usd(row.loans_owed)}</td>
      <td className="bt-bd-num">{usd(row.escrow)}</td>
      <td className={`bt-bd-num bt-bd-strong${neg(row.cash_in)}`}>{usd(row.cash_in)}</td>
      <td className="bt-bd-num">{row.potential_sale_price !== null ? usd(row.potential_sale_price) : <span className="bt-cf-missing">not entered</span>}</td>
      <td className={`bt-bd-num${neg(row.projected_profit)}`}>{usd(row.projected_profit)}</td>
      <td className={`bt-bd-num bt-bd-strong${neg(row.coming_back)}`}>{usd(row.coming_back)}</td>
    </tr>
  );
}

function SubtotalRow({ label, totals, grand = false }: { label: string; totals: Totals; grand?: boolean }) {
  return (
    <tr className={grand ? 'bt-cf-grand' : 'bt-cf-subtotal'}>
      <td>{label}</td>
      <td className="bt-bd-num">{usd(totals.invested)}</td>
      <td className="bt-bd-num">{usd(totals.loans_owed)}</td>
      <td className="bt-bd-num">{usd(totals.escrow)}</td>
      <td className={`bt-bd-num${neg(totals.cash_in)}`}>{usd(totals.cash_in)}</td>
      <td className="bt-bd-num">{totals.priced_count} of {totals.count} priced</td>
      <td className={`bt-bd-num${neg(totals.projected_profit)}`}>{usd(totals.projected_profit)}</td>
      <td className={`bt-bd-num${neg(totals.coming_back)}`}>{usd(totals.coming_back)}</td>
    </tr>
  );
}

export default function ConsolidatedFinances() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const autoSynced = useRef(false);

  const sync = useCallback(async (manual: boolean) => {
    setSyncing(true);
    try {
      const res = await api.post<Payload>('/finance/consolidated/sync');
      setData(res.data);
      if (manual) toast.success('Updated from QuickBooks');
    } catch (err: any) {
      const body = err?.response?.data as Payload | undefined;
      if (body?.totals) setData(body);
      if (manual || !body?.totals) toast.error(body?.error || 'QuickBooks could not be reached.');
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.get<Payload>('/finance/consolidated')
      .then(res => {
        if (cancelled) return;
        setData(res.data);
        if (res.data.quickbooks.connected && res.data.quickbooks.stale && !autoSynced.current) {
          autoSynced.current = true;
          void sync(false);
        }
      })
      .catch(err => { if (!cancelled) setLoadError(err?.response?.status === 403 ? 'You do not have access to the financial tabs.' : 'Consolidated Finances could not be loaded.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sync]);

  if (loading) return <div className="bt-bd-loading"><Loader2 className="h-5 w-5 animate-spin" /> Loading consolidated finances…</div>;
  if (loadError || !data) return <div className="bt-bd-loading">{loadError || 'Consolidated Finances could not be loaded.'}</div>;

  const t = data.totals;
  const rentals = data.rentals;
  const ttm = data.period?.ttm_start && data.period?.end ? `${formatDateOnly(data.period.ttm_start)} – ${formatDateOnly(data.period.end)}` : 'the last 12 months';

  return (
    <div className="bt-desktop-page bt-bd bt-cf mx-auto max-w-[1500px] p-4 md:p-6">
      <div className="bt-bd-intro">
        <div className="min-w-0">
          <p className="bt-bd-eyebrow"><Landmark className="h-3.5 w-3.5" /> Consolidated Finances · QuickBooks</p>
          <h3 className="bt-bd-title">New Urban Development — all projects and rentals</h3>
          <p className="bt-cf-lede">Every property with a balance in QuickBooks, combined. Sold properties are listed at the bottom and left out of the totals.</p>
        </div>
        <div className="bt-bd-sync">
          <span className="bt-bd-sync__status" aria-live="polite">
            {syncing ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating from QuickBooks…</>
              : data.quickbooks.last_synced_at ? `Updated ${formatEasternRelative(data.quickbooks.last_synced_at)}` : 'Not loaded from QuickBooks yet'}
          </span>
          <button type="button" className="bt-bd-btn" onClick={() => void sync(true)} disabled={syncing || !data.quickbooks.connected}>
            <RefreshCw className={`h-4 w-4${syncing ? ' animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {data.quickbooks.error && !syncing && (
        <p className="bt-bd-banner is-warn"><AlertTriangle className="h-4 w-4" /> The last QuickBooks update failed: {data.quickbooks.error} Showing the last copy BuildTrack saved.</p>
      )}
      {data.not_in_buildtrack.length > 0 && (
        <p className="bt-bd-banner is-warn"><AlertTriangle className="h-4 w-4" /> In QuickBooks but not in BuildTrack: {data.not_in_buildtrack.join(', ')}. They are counted here; add them as projects to see their Finance tab.</p>
      )}

      <div className="bt-bd-kpis bt-cf-kpis">
        <Kpi tone="in" icon={<Wallet className="h-3.5 w-3.5" />} label="Money outstanding" value={usd(t.cash_in)} note={`Company cash in ${t.count} properties: ${usd(t.invested)} invested, less loans paid off at sale`} />
        <Kpi tone="bad" icon={<Scale className="h-3.5 w-3.5" />} label="Loans outstanding" value={usd(t.loans_owed)} note={`All loans & payables on the properties · ${usd(t.escrow)} holdback still in escrow`} />
        <Kpi tone="due" icon={<TrendingUp className="h-3.5 w-3.5" />} label="Profit potential" value={usd(t.projected_profit)} note={`${t.priced_count} of ${t.count} properties priced${rentals.rows.length ? ' · rentals include rent and every expense to date' : ''}`} />
        <Kpi tone="good" icon={<ArrowDownLeft className="h-3.5 w-3.5" />} label="Coming back at sale" value={usd(t.coming_back)} note="Cash back after loans, commission and closing costs (equity where no price is entered)" />
      </div>

      <Block step={1} title="All properties" subtitle="Projects and rentals from QuickBooks, by class · cash in = invested less what the lenders take back at payoff (net of escrow)">
        <div className="bt-bd-tablewrap">
          <table className="bt-bd-register bt-cf-table">
            <thead>
              <tr>
                <th scope="col">Property</th>
                <th scope="col" className="bt-bd-num">Invested</th>
                <th scope="col" className="bt-bd-num">Loans owed</th>
                <th scope="col" className="bt-bd-num">In escrow</th>
                <th scope="col" className="bt-bd-num">Cash in (equity)</th>
                <th scope="col" className="bt-bd-num">Potential sale</th>
                <th scope="col" className="bt-bd-num">Projected profit</th>
                <th scope="col" className="bt-bd-num">Coming back</th>
              </tr>
            </thead>
            <tbody>
              {[
                { label: 'Projects', icon: <Building2 className="h-3.5 w-3.5" />, part: data.projects },
                { label: 'Rentals', icon: <Home className="h-3.5 w-3.5" />, part: rentals },
              ].filter(section => section.part.rows.length > 0).map(section => (
                <Fragment key={section.label}>
                  <tr className="bt-cf-group"><td colSpan={8}>{section.icon}{section.label} ({section.part.rows.length})</td></tr>
                  {section.part.rows.map(row => <PropertyRow key={row.key} row={row} />)}
                  <SubtotalRow label={`${section.label} total`} totals={section.part.totals} />
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <SubtotalRow label="All properties" totals={t} grand />
            </tfoot>
          </table>
        </div>
        {t.unpriced.length > 0 && (
          <p className="bt-cf-note">
            No potential sales price yet for {t.unpriced.map((u, i) => (
              <Fragment key={u.name}>{i > 0 ? ', ' : ''}{u.project_id ? <Link to={`/projects/${u.project_id}#finance`} className="bt-cf-link is-inline">{u.name}</Link> : u.name}</Fragment>
            ))}. Their equity is counted in “coming back”; their profit is added once a price is entered on the project’s Finance tab.
          </p>
        )}
        {t.carried_interest > 0 && (
          <p className="bt-cf-note">Interest carried into the projects so far (QuickBooks 1235 Carried Interest, part of “invested”): {usd(t.carried_interest)}.</p>
        )}
      </Block>

      <Block step={2} title="Rentals" subtitle={`Held properties such as 171 Davis · equity and loans today, monthly figures averaged over ${ttm} from the QuickBooks P&L`}>
        {rentals.rows.length === 0 ? (
          <p className="bt-bd-empty">No rentals. A property shows here when its BuildTrack status is Long Term Holding.</p>
        ) : (
          <>
            <div className="bt-bd-kpis">
              <Kpi tone="in" label="Equity in rentals" value={usd(rentals.totals.cash_in)} note={`${usd(rentals.totals.invested)} invested`} />
              <Kpi tone="bad" label="Loans on rentals" value={usd(rentals.totals.loans_owed)} note="Mortgages and other loans booked to the rentals" />
              <Kpi tone="out" label="Interest paid per month" value={usd(rentals.totals.monthly?.interest)} note={`Rent ${usd(rentals.totals.monthly?.income)} per month`} />
              <Kpi tone={(rentals.totals.rental_net || 0) >= 0 ? 'good' : 'bad'} label="Rent less expenses, to date" value={usd(rentals.totals.rental_net)} note={`Rent ${usd(rentals.totals.rental_income)} − every expense ${usd(rentals.totals.rental_expenses)}, all QuickBooks history`} />
            </div>
            <div className="bt-bd-tablewrap">
              <table className="bt-bd-register bt-cf-table">
                <thead>
                  <tr>
                    <th scope="col">Rental</th>
                    <th scope="col" className="bt-bd-num">Loans owed</th>
                    <th scope="col" className="bt-bd-num">Equity</th>
                    <th scope="col" className="bt-bd-num">Rent / mo</th>
                    <th scope="col" className="bt-bd-num">Interest / mo</th>
                    <th scope="col" className="bt-bd-num">Expenses / mo</th>
                    <th scope="col" className="bt-bd-num">Net / mo</th>
                    <th scope="col" className="bt-bd-num">Rent less expenses to date</th>
                    <th scope="col" className="bt-bd-num">Projected profit</th>
                  </tr>
                </thead>
                <tbody>
                  {rentals.rows.map(row => (
                    <tr key={row.key}>
                      <td>
                        {row.project_id ? <Link to={`/projects/${row.project_id}#finance`} className="bt-cf-link">{row.name}<ExternalLink className="h-3 w-3" /></Link> : row.name}
                        <span className="bt-bd-sub">{row.loans.map(l => `${l.account}: ${usd(l.amount)}`).join(' · ') || 'No loans'}</span>
                      </td>
                      <td className="bt-bd-num">{usd(row.loans_owed)}</td>
                      <td className={`bt-bd-num bt-bd-strong${neg(row.cash_in)}`}>{usd(row.cash_in)}</td>
                      <td className="bt-bd-num">{usd(row.monthly?.income)}</td>
                      <td className="bt-bd-num is-out">{usd(row.monthly?.interest)}</td>
                      <td className="bt-bd-num">{usd(row.monthly?.expenses)}</td>
                      <td className={`bt-bd-num bt-bd-strong${neg(row.monthly?.net ?? null)}`}>{usd(row.monthly?.net)}</td>
                      <td className={`bt-bd-num${neg(row.rental_net)}`}>{usd(row.rental_net)}</td>
                      <td className={`bt-bd-num bt-bd-strong${neg(row.projected_profit)}`}>{row.priced ? usd(row.projected_profit) : <span className="bt-cf-missing">no price</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="bt-cf-note">Monthly figures are QuickBooks P&amp;L totals for the period divided by 12; mortgage principal payments are not expenses, so they are not in “net per month”. For a long-term holding the projected profit is the profit on the sale plus all rent collected less every expense on the class (maintenance, interest, taxes, insurance, utilities) since the first QuickBooks entry.</p>
          </>
        )}
      </Block>

      <Block step={3} title="Loans by lender" subtitle="Every loan and payable booked to the properties above, by QuickBooks account">
        {data.loans_by_account.length === 0 ? (
          <p className="bt-bd-empty">No loans booked to the properties.</p>
        ) : (
          <div className="bt-bd-tablewrap">
            <table className="bt-bd-register bt-cf-table">
              <thead><tr><th scope="col">Account</th><th scope="col">Properties</th><th scope="col" className="bt-bd-num">Amount</th></tr></thead>
              <tbody>
                {data.loans_by_account.map(loan => (
                  <tr key={loan.account}>
                    <td className="bt-bd-strong">{loan.account}</td>
                    <td className="bt-cf-props">{loan.properties.map(p => `${p.name} ${usd(p.amount)}`).join(' · ')}</td>
                    <td className="bt-bd-num bt-bd-strong">{usd(loan.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={2}>Total loans &amp; payables</td><td className="bt-bd-num">{usd(t.loans_owed)}</td></tr></tfoot>
            </table>
          </div>
        )}
      </Block>

      {data.sold.length > 0 && (
        <details className="bt-cf-sold">
          <summary>Sold properties with leftover balances ({data.sold.length}) — not in the totals</summary>
          <div className="bt-bd-tablewrap">
            <table className="bt-bd-register bt-cf-table">
              <thead><tr><th scope="col">Property</th><th scope="col" className="bt-bd-num">Invested left</th><th scope="col" className="bt-bd-num">Liabilities left</th></tr></thead>
              <tbody>
                {data.sold.map(row => (
                  <tr key={row.key}>
                    <td>{row.project_id ? <Link to={`/projects/${row.project_id}#finance`} className="bt-cf-link">{row.name}</Link> : row.name}</td>
                    <td className="bt-bd-num">{usd(row.invested)}</td>
                    <td className="bt-bd-num">{usd(row.loans_owed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <p className="bt-cf-note">Only property classes are combined here. Company-level balances that QuickBooks does not assign to a property (lines of credit, credit cards, the vehicle class) are not included.</p>
    </div>
  );
}
