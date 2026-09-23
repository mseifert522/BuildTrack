import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ExternalLink, Mail, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { formatEasternDate } from '../lib/time';
import { vendorSetupStatusMeta, type VendorSetupInvite } from '../lib/vendorSetup';
import ConfirmDialog from './ConfirmDialog';

const TONES = {
  emerald: { background: '#ECFDF5', color: '#047857', border: '#A7F3D0' },
  blue: { background: '#EFF6FF', color: '#1D4ED8', border: '#BFDBFE' },
  amber: { background: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  red: { background: '#FEF2F2', color: '#B91C1C', border: '#FECACA' },
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const shortDate = (value?: string | null) =>
  value ? formatEasternDate(value, { month: 'short', day: 'numeric', year: 'numeric' }) : '';

interface Props {
  invites: VendorSetupInvite[];
  onChanged: () => void;
  onOpenVendor: (contractorId: string) => void;
}

interface ResendDraft {
  invite: VendorSetupInvite;
  companyName: string;
  email: string;
}

// "Set Up New Vendor" requests: who has been asked, where each vendor is, and
// resend / delete. Everyone who can send may resend; only super admins and
// operations managers get Delete (the API enforces it too). Both actions confirm
// in an in-page dialog first - never a browser prompt.
export default function VendorSetupRequests({ invites, onChanged, onOpenVendor }: Props) {
  const waiting = invites.filter(invite => invite.status !== 'submitted');
  const completed = invites.length - waiting.length;
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const [resendDraft, setResendDraft] = useState<ResendDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VendorSetupInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const open = expanded ?? waiting.length > 0;

  // The list refreshes every 15 s. If the request a dialog is about disappears
  // (another admin deleted it, or it aged out), close the dialog rather than
  // leave it pointing at a row that no longer exists.
  useEffect(() => {
    if (busy) return;
    if (resendDraft && !invites.some(invite => invite.id === resendDraft.invite.id && invite.status !== 'submitted')) setResendDraft(null);
    if (deleteTarget && !invites.some(invite => invite.id === deleteTarget.id)) setDeleteTarget(null);
  }, [busy, deleteTarget, invites, resendDraft]);

  const rows = useMemo(() => [...invites].sort((a, b) => {
    const rank = (invite: VendorSetupInvite) => (invite.status === 'submitted' ? 1 : 0);
    return rank(a) - rank(b);
  }), [invites]);

  const startResend = (invite: VendorSetupInvite) => {
    setDialogError('');
    setResendDraft({ invite, companyName: invite.company_name, email: invite.email });
  };

  const resendCompany = resendDraft?.companyName.trim() || '';
  const resendEmail = resendDraft?.email.trim().toLowerCase() || '';
  const resendInvalid = !resendCompany || !EMAIL_PATTERN.test(resendEmail);

  const confirmResend = async () => {
    if (!resendDraft || resendInvalid) return;
    setBusy(true);
    setDialogError('');
    try {
      const res = await api.post(`/vendor-setup/invites/${resendDraft.invite.id}/resend`, {
        company_name: resendCompany,
        email: resendEmail,
      });
      toast.success(`New setup link sent to ${res.data?.sent_to || resendEmail}`);
      setResendDraft(null);
      onChanged();
    } catch (err: any) {
      setDialogError(err.response?.data?.error || 'The setup email could not be sent. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    setDialogError('');
    try {
      const res = await api.delete(`/vendor-setup/invites/${deleteTarget.id}`);
      toast.success(res.data?.message || 'Setup request deleted');
      setDeleteTarget(null);
      onChanged();
    } catch (err: any) {
      setDialogError(err.response?.data?.error || 'The setup request could not be deleted.');
    } finally {
      setBusy(false);
    }
  };

  const changedName = resendDraft && resendCompany !== resendDraft.invite.company_name;
  const changedEmail = resendDraft && resendEmail !== resendDraft.invite.email;

  if (!invites.length && !resendDraft && !deleteTarget) return null;

  return (
    <section className="bt-vendor-setup-requests rounded-lg border border-slate-200 bg-slate-50">
      <button
        type="button"
        onClick={() => setExpanded(!open)}
        aria-expanded={open}
        className="bt-vs-panel-toggle flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
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
                      className="bt-vs-btn bt-vs-btn--success"
                      title={`Open ${invite.contractor_name || invite.company_name} in the directory`}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      View vendor
                    </button>
                  ) : null}
                  {invite.status !== 'submitted' ? (
                    <button
                      type="button"
                      onClick={() => startResend(invite)}
                      className="bt-vs-btn"
                      title={`Send ${invite.company_name} a new secure setup link`}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Resend
                    </button>
                  ) : null}
                  {invite.can_delete ? (
                    <button
                      type="button"
                      onClick={() => { setDialogError(''); setDeleteTarget(invite); }}
                      className="bt-vs-btn bt-vs-btn--danger"
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

      <ConfirmDialog
        isOpen={Boolean(resendDraft)}
        title="Resend vendor setup link"
        description="Please confirm the company name and email address before we send."
        confirmLabel={resendInvalid ? 'Send new link' : `Yes, send to ${resendEmail}`}
        busyLabel="Sending..."
        busy={busy}
        error={dialogError}
        confirmDisabled={resendInvalid}
        onConfirm={confirmResend}
        onCancel={() => setResendDraft(null)}
      >
        {resendDraft ? (
          <div className="space-y-4">
            <div className="grid gap-4">
              <div>
                <label htmlFor="vendor-resend-company" className="mb-1 block text-sm font-bold text-gray-700">Company name</label>
                <input
                  id="vendor-resend-company"
                  value={resendDraft.companyName}
                  onChange={event => setResendDraft(prev => (prev ? { ...prev, companyName: event.target.value } : prev))}
                  maxLength={150}
                  autoComplete="off"
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                {!resendCompany ? <p className="mt-1 text-xs font-bold text-red-400">Enter the company name</p> : null}
              </div>
              <div>
                <label htmlFor="vendor-resend-email" className="mb-1 block text-sm font-bold text-gray-700">Send the link to</label>
                <input
                  id="vendor-resend-email"
                  type="email"
                  value={resendDraft.email}
                  onChange={event => setResendDraft(prev => (prev ? { ...prev, email: event.target.value } : prev))}
                  autoComplete="off"
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                {resendEmail && !EMAIL_PATTERN.test(resendEmail) ? <p className="mt-1 text-xs font-bold text-red-400">Enter a valid email address</p> : null}
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-3.5 text-sm leading-6 text-gray-700">
              <p className="flex items-start gap-2">
                <Mail className="mt-1 h-4 w-4 flex-shrink-0 text-amber-500" />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <strong className="text-gray-900">{resendCompany || 'This vendor'}</strong> will get a new welcome email at{' '}
                  <strong className="text-gray-900">{resendEmail || '-'}</strong>, with a copy to info@newurbandev.com.
                </span>
              </p>
              <p className="mt-2 text-xs text-gray-500">
                The link sent before stops working.
                {resendDraft.invite.status === 'verified' ? ' The vendor is filling out the form right now; anything they already entered is kept.' : ''}
                {changedName || changedEmail ? ` You changed the ${[changedName ? 'company name' : '', changedEmail ? 'email' : ''].filter(Boolean).join(' and ')}; the request will be updated.` : ''}
              </p>
            </div>
          </div>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        isOpen={Boolean(deleteTarget)}
        title={deleteTarget?.status === 'submitted' ? 'Remove completed setup?' : 'Cancel setup request?'}
        confirmLabel={deleteTarget?.status === 'submitted' ? 'Yes, remove it' : 'Yes, cancel request'}
        cancelLabel="Keep it"
        busyLabel="Deleting..."
        tone="danger"
        busy={busy}
        error={dialogError}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      >
        {deleteTarget ? (
          <div className="space-y-3 text-sm leading-6 text-gray-700">
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-3.5">
              <p className="font-black text-gray-900">{deleteTarget.company_name}</p>
              <p className="text-xs text-gray-500">{deleteTarget.email}</p>
            </div>
            <p>
              {deleteTarget.status === 'submitted'
                ? 'This only removes the entry from this list. The vendor record and the documents they sent stay in the directory.'
                : 'The vendor’s link stops working, and anything they already uploaded is permanently erased.'}
            </p>
          </div>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}
