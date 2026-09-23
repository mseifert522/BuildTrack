import { useMemo, useState } from 'react';
import { ChevronDown, ExternalLink, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { formatEasternDate } from '../lib/time';
import { vendorSetupStatusMeta, type VendorSetupInvite } from '../lib/vendorSetup';

const TONES = {
  emerald: { background: '#ECFDF5', color: '#047857', border: '#A7F3D0' },
  blue: { background: '#EFF6FF', color: '#1D4ED8', border: '#BFDBFE' },
  amber: { background: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  red: { background: '#FEF2F2', color: '#B91C1C', border: '#FECACA' },
};

const shortDate = (value?: string | null) =>
  value ? formatEasternDate(value, { month: 'short', day: 'numeric', year: 'numeric' }) : '';

interface Props {
  invites: VendorSetupInvite[];
  onChanged: () => void;
  onOpenVendor: (contractorId: string) => void;
}

// "Set Up New Vendor" requests: who has been asked, where each vendor is, and
// resend / delete. Everyone who can send may resend; only super admins and
// operations managers get Delete (the API enforces it too).
export default function VendorSetupRequests({ invites, onChanged, onOpenVendor }: Props) {
  const waiting = invites.filter(invite => invite.status !== 'submitted');
  const completed = invites.length - waiting.length;
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const open = expanded ?? waiting.length > 0;

  const rows = useMemo(() => [...invites].sort((a, b) => {
    const rank = (invite: VendorSetupInvite) => (invite.status === 'submitted' ? 1 : 0);
    return rank(a) - rank(b);
  }), [invites]);

  if (!invites.length) return null;

  const resend = async (invite: VendorSetupInvite) => {
    const email = window.prompt(`Resend the secure setup link for ${invite.company_name} to:`, invite.email);
    if (email === null) return;
    setBusyId(invite.id);
    try {
      const res = await api.post(`/vendor-setup/invites/${invite.id}/resend`, { email: email.trim() });
      toast.success(`New setup link sent to ${res.data?.sent_to || email.trim()}`);
      onChanged();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Could not resend the setup email');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (invite: VendorSetupInvite) => {
    const question = invite.status === 'submitted'
      ? `Remove the completed setup for ${invite.company_name} from this list? The vendor record and their documents stay in the directory.`
      : `Cancel the setup request for ${invite.company_name}? Their link stops working and anything they already uploaded is erased.`;
    if (!window.confirm(question)) return;
    setBusyId(invite.id);
    try {
      const res = await api.delete(`/vendor-setup/invites/${invite.id}`);
      toast.success(res.data?.message || 'Setup request deleted');
      onChanged();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Could not delete the setup request');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="bt-vendor-setup-requests rounded-lg border border-slate-200 bg-slate-50">
      <button
        type="button"
        onClick={() => setExpanded(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ShieldCheck className="h-4 w-4 flex-shrink-0 text-amber-500" />
          <span className="text-xs font-black uppercase tracking-wide text-slate-600">Vendor setup requests</span>
          <span className="truncate text-xs font-semibold text-slate-400">
            {waiting.length} waiting{completed ? ` · ${completed} completed` : ''}
          </span>
        </span>
        <ChevronDown className={`h-4 w-4 flex-shrink-0 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? (
        <div className="space-y-2 border-t border-slate-200 px-3 py-3">
          {rows.map(invite => {
            const status = vendorSetupStatusMeta(invite);
            const tone = TONES[status.tone];
            const busy = busyId === invite.id;
            const docs = invite.file_counts;
            const meta = invite.status === 'submitted'
              ? `Completed ${shortDate(invite.submitted_at)}${invite.w9_method ? ` · W-9 ${invite.w9_method === 'online' ? 'filled out online' : 'uploaded'}` : ''} · ${docs.insurance} insurance file${docs.insurance === 1 ? '' : 's'}`
              : invite.status === 'expired'
                ? `Link expired ${shortDate(invite.expires_at)}`
                : `Sent ${shortDate(invite.last_sent_at || invite.created_at)}${invite.requested_by_name ? ` by ${invite.requested_by_name}` : ''}${invite.send_count > 1 ? ` · sent ${invite.send_count} times` : ''} · link good until ${shortDate(invite.expires_at)}`;
            return (
              <div key={invite.id} className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-black text-gray-950">{invite.company_name}</p>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-black text-slate-600">
                      {invite.vendor_type === 'supplier' ? 'Supplier' : 'Contractor'}
                    </span>
                    <span
                      className="rounded-full px-2 py-0.5 text-[11px] font-black"
                      style={{ background: tone.background, color: tone.color, border: `1px solid ${tone.border}` }}
                    >
                      {status.label}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs font-semibold text-gray-500">{invite.email}</p>
                  <p className="mt-0.5 text-[11px] font-semibold text-gray-400">
                    {meta}
                    {invite.contractor_name && invite.status !== 'submitted' ? ` · will be added to ${invite.contractor_name}` : ''}
                  </p>
                </div>
                <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
                  {invite.status === 'submitted' && invite.contractor_id ? (
                    <button
                      type="button"
                      onClick={() => onOpenVendor(invite.contractor_id!)}
                      className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 text-xs font-black text-emerald-800 hover:bg-emerald-100"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      View vendor
                    </button>
                  ) : null}
                  {invite.status !== 'submitted' ? (
                    <button
                      type="button"
                      onClick={() => resend(invite)}
                      disabled={busy}
                      className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-xs font-black text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
                      Resend
                    </button>
                  ) : null}
                  {invite.can_delete ? (
                    <button
                      type="button"
                      onClick={() => remove(invite)}
                      disabled={busy}
                      className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-black disabled:opacity-50"
                      style={{ background: '#FEF2F2', color: '#B91C1C', borderColor: '#FECACA' }}
                      title={invite.status === 'submitted' ? 'Remove from this list' : 'Cancel this setup request'}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
