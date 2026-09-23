import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { CheckCircle2, Copy, FileCheck2, Landmark, Mail, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { Modal } from './ui';
import type { VendorSetupInvite } from '../lib/vendorSetup';

interface SentResult {
  invite: VendorSetupInvite;
  setup_url: string;
  sent_to: string;
  cc: string;
  matched_vendor: { id: string; name: string; match_kind: 'email' | 'name' } | null;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSent: (invite: VendorSetupInvite) => void;
}

const emptyForm = { company_name: '', email: '', vendor_type: 'contractor' as 'contractor' | 'supplier' };

export default function VendorSetupInviteModal({ isOpen, onClose, onSent }: Props) {
  const [form, setForm] = useState(emptyForm);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SentResult | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setForm(emptyForm);
    setError('');
    setResult(null);
  }, [isOpen]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending) return;
    const companyName = form.company_name.trim();
    const email = form.email.trim();
    if (!companyName) {
      setError('Enter the company name');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Enter a valid company email address');
      return;
    }
    setSending(true);
    setError('');
    try {
      const res = await api.post<SentResult>('/vendor-setup/invites', { ...form, company_name: companyName, email });
      setResult(res.data);
      onSent(res.data.invite);
      toast.success(`Vendor setup email sent to ${res.data.sent_to}`);
    } catch (err: any) {
      setError(err.response?.data?.error || 'The setup email could not be sent. Please try again.');
    } finally {
      setSending(false);
    }
  };

  const copyLink = () => {
    if (!result?.setup_url) return;
    navigator.clipboard?.writeText(result.setup_url);
    toast.success('Vendor setup link copied');
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Set Up New Vendor"
      description="Email a new vendor a secure link to send us their W-9, insurance certificate and ACH banking details."
      size="lg"
    >
      {result ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-emerald-600" />
              <div className="min-w-0">
                <p className="text-sm font-black text-emerald-900">Setup email sent to {result.sent_to}</p>
                <p className="mt-1 text-xs font-semibold leading-5 text-emerald-800">
                  A copy went to {result.cc}. When {result.invite.company_name} submits the secure form, BuildTrack adds them to Contractors / Suppliers automatically and emails the office.
                </p>
              </div>
            </div>
          </div>
          {result.matched_vendor ? (
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-xs font-semibold leading-5 text-blue-900">
              <span className="font-black">{result.matched_vendor.name}</span> is already in the directory (matched by {result.matched_vendor.match_kind === 'email' ? 'email address' : 'company name'}). Their answers will be added to that record instead of creating a duplicate.
            </div>
          ) : null}
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
            <p className="text-[11px] font-black uppercase tracking-wide text-gray-500">Secure vendor link</p>
            <div className="mt-1 flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs font-bold text-gray-900">{result.setup_url}</span>
              <button
                type="button"
                onClick={copyLink}
                className="inline-flex h-8 flex-shrink-0 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 text-xs font-black text-gray-700 hover:bg-gray-50"
              >
                <Copy className="h-3.5 w-3.5" />
                Copy
              </button>
            </div>
            <p className="mt-1 text-[11px] font-semibold text-gray-500">
              Only send this link to the vendor. It expires in 14 days; the vendor also confirms a code sent to {result.sent_to}.
            </p>
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => { setResult(null); setForm(emptyForm); }}
              className="flex-1 rounded-xl border border-gray-300 py-2.5 text-sm font-bold text-gray-700 hover:bg-gray-50"
            >
              Set up another vendor
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-xl bg-blue-600 py-2.5 text-sm font-black text-white hover:bg-blue-700"
            >
              Done
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-5" noValidate>
          <div>
            <p className="mb-2 block text-sm font-bold text-gray-700">Vendor type</p>
            <div className="inline-flex rounded-lg border border-gray-300 bg-white p-0.5" role="radiogroup" aria-label="Vendor type">
              {(['contractor', 'supplier'] as const).map(type => (
                <button
                  key={type}
                  type="button"
                  role="radio"
                  aria-checked={form.vendor_type === type}
                  onClick={() => setForm(prev => ({ ...prev, vendor_type: type }))}
                  className={`rounded-md px-4 py-1.5 text-xs font-black transition ${form.vendor_type === type ? 'bg-slate-950 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
                >
                  {type === 'contractor' ? 'Contractor' : 'Supplier'}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label htmlFor="vendor-setup-company" className="mb-1 block text-sm font-bold text-gray-700">Company name *</label>
              <input
                id="vendor-setup-company"
                value={form.company_name}
                onChange={event => setForm(prev => ({ ...prev, company_name: event.target.value }))}
                maxLength={150}
                autoComplete="off"
                placeholder="ABC Plumbing LLC"
                className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="vendor-setup-email" className="mb-1 block text-sm font-bold text-gray-700">Company email address *</label>
              <input
                id="vendor-setup-email"
                type="email"
                value={form.email}
                onChange={event => setForm(prev => ({ ...prev, email: event.target.value }))}
                autoComplete="off"
                placeholder="office@abcplumbing.com"
                className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
            <p className="mb-3 text-[11px] font-black uppercase tracking-wide text-gray-500">The vendor receives a welcome email that asks for</p>
            <ul className="space-y-2 text-sm font-semibold text-gray-700">
              <li className="flex items-start gap-2"><FileCheck2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" /> Their W-9, filled out online or uploaded (PDF, photo or Word)</li>
              <li className="flex items-start gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" /> Their certificate of insurance</li>
              <li className="flex items-start gap-2"><Landmark className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" /> ACH routing and checking account numbers, with permission to deposit payments</li>
              <li className="flex items-start gap-2"><Mail className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" /> It also includes our office contact details and payment policy, and a copy goes to info@newurbandev.com</li>
            </ul>
          </div>

          {error ? (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</div>
          ) : null}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-xl border border-gray-300 py-2.5 text-sm font-bold text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={sending}
              className="flex-1 rounded-xl bg-blue-600 py-2.5 text-sm font-black text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {sending ? 'Sending...' : 'Send Setup Email'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
