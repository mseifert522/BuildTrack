import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Loader2, Mail, Search, Send, UserPlus, X } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { Modal } from './ui';
import VoiceTextarea from './VoiceTextarea';

// Email / Send Punch List: assign each item to a contractor, pick the
// contractors to notify, and send each one a single email with their items.
// Every recipient reports truthfully whether an email actually went out.

type Contractor = {
  id: string;
  vendor_name: string;
  contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  contractor_category?: string | null;
  linked_to_project?: number;
  assigned_item_count?: number;
  open_item_count?: number;
  last_sent_at?: string | null;
};

type PunchItem = {
  id: string;
  title: string;
  status: string;
  priority: string;
  assigned_contractor_id?: string | null;
  last_sent_at?: string | null;
  last_sent_to?: string | null;
};

type Recipient = { checked: boolean; email: string; saveEmail: boolean; scope: 'assigned' | 'all' };

type SendResult = {
  contractor_id: string;
  contractor: string;
  email: string | null;
  sent: boolean;
  reason: string | null;
  item_count: number;
};

const REASON_TEXT: Record<string, string> = {
  sent: 'Sent',
  no_email_on_file: 'No email on file. Add one and send again.',
  no_items: 'No items to send. Assign items to them or choose “All open items”.',
  send_failed: 'The email failed to send. Try again in a moment.',
  email_not_configured: 'Email is not configured on this server.',
  contractor_not_found: 'Contractor not found.',
};

function contractorLabel(contractor: Contractor) {
  return contractor.vendor_name || contractor.contact_name || 'Contractor';
}

function formatSent(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function PunchListSendModal({
  projectId,
  isOpen,
  onClose,
  onSent,
}: {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
  onSent: () => Promise<void> | void;
}) {
  const [loading, setLoading] = useState(false);
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [directory, setDirectory] = useState<Contractor[]>([]);
  const [ccEmail, setCcEmail] = useState('info@newurbandev.com');
  const [emailConfigured, setEmailConfigured] = useState(true);
  const [items, setItems] = useState<PunchItem[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [savedAssignments, setSavedAssignments] = useState<Record<string, string>>({});
  const [recipients, setRecipients] = useState<Record<string, Recipient>>({});
  const [extraIds, setExtraIds] = useState<string[]>([]);
  const [directoryQuery, setDirectoryQuery] = useState('');
  const [message, setMessage] = useState('');
  const [ccOffice, setCcOffice] = useState(true);
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [savingAssignments, setSavingAssignments] = useState(false);
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<SendResult[] | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setResults(null);
    setMessage('');
    setCcOffice(true);
    setIncludeCompleted(false);
    setExtraIds([]);
    setDirectoryQuery('');
    Promise.all([
      api.get(`/projects/${projectId}/punch-list/contractors`),
      api.get(`/projects/${projectId}/punch-list`),
    ])
      .then(([contractorRes, itemRes]) => {
        if (cancelled) return;
        const linked: Contractor[] = Array.isArray(contractorRes.data?.contractors) ? contractorRes.data.contractors : [];
        const dir: Contractor[] = Array.isArray(contractorRes.data?.directory) ? contractorRes.data.directory : [];
        const rows: PunchItem[] = Array.isArray(itemRes.data) ? itemRes.data : [];
        setContractors(linked);
        setDirectory(dir);
        setCcEmail(String(contractorRes.data?.cc_email || 'info@newurbandev.com'));
        setEmailConfigured(contractorRes.data?.email_configured !== false);
        setItems(rows);
        const initial: Record<string, string> = {};
        rows.forEach(item => { initial[item.id] = item.assigned_contractor_id ? String(item.assigned_contractor_id) : ''; });
        setAssignments(initial);
        setSavedAssignments(initial);
        const initialRecipients: Record<string, Recipient> = {};
        linked.forEach(contractor => {
          const hasOpen = Number(contractor.open_item_count || 0) > 0;
          initialRecipients[contractor.id] = { checked: hasOpen, email: String(contractor.email || ''), saveEmail: true, scope: 'assigned' };
        });
        setRecipients(initialRecipients);
      })
      .catch(() => toast.error('Failed to load contractors for this project'))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen, projectId]);

  const contractorById = useMemo(() => {
    const map = new Map<string, Contractor>();
    directory.forEach(contractor => map.set(String(contractor.id), contractor));
    contractors.forEach(contractor => map.set(String(contractor.id), { ...map.get(String(contractor.id)), ...contractor }));
    return map;
  }, [contractors, directory]);

  const recipientList = useMemo(() => {
    const ids = [...contractors.map(contractor => String(contractor.id)), ...extraIds];
    return Array.from(new Set(ids)).map(id => contractorById.get(id)).filter(Boolean) as Contractor[];
  }, [contractors, extraIds, contractorById]);

  const openItems = useMemo(() => items.filter(item => includeCompleted || item.status !== 'completed'), [items, includeCompleted]);
  const assignedCount = (contractorId: string) => openItems.filter(item => assignments[item.id] === contractorId).length;
  const dirtyAssignments = useMemo(
    () => Object.entries(assignments).filter(([itemId, contractorId]) => (savedAssignments[itemId] || '') !== (contractorId || '')),
    [assignments, savedAssignments]
  );

  const recipientFor = (id: string): Recipient => recipients[id] || { checked: false, email: String(contractorById.get(id)?.email || ''), saveEmail: true, scope: 'assigned' };
  const updateRecipient = (id: string, patch: Partial<Recipient>) => {
    setRecipients(prev => ({ ...prev, [id]: { ...recipientFor(id), ...patch } }));
  };

  const addFromDirectory = (contractor: Contractor) => {
    const id = String(contractor.id);
    if (!recipientList.some(row => String(row.id) === id)) setExtraIds(prev => [...prev, id]);
    updateRecipient(id, { checked: true, scope: assignedCount(id) > 0 ? 'assigned' : 'all', email: String(contractor.email || '') });
    setDirectoryQuery('');
  };

  const directoryMatches = useMemo(() => {
    const search = directoryQuery.trim().toLowerCase();
    if (!search) return [];
    const listed = new Set(recipientList.map(row => String(row.id)));
    return directory
      .filter(contractor => !listed.has(String(contractor.id)))
      .filter(contractor => [contractor.vendor_name, contractor.contact_name, contractor.email, contractor.contractor_category].filter(Boolean).join(' ').toLowerCase().includes(search))
      .slice(0, 8);
  }, [directory, directoryQuery, recipientList]);

  const selectOptions = useMemo(() => {
    const onProject = new Set(contractors.map(contractor => String(contractor.id)));
    const others = directory.filter(contractor => !onProject.has(String(contractor.id)));
    return { onProject: contractors, others };
  }, [contractors, directory]);

  // After an item is assigned, make sure that contractor is in the send list and checked.
  const assignItem = (itemId: string, contractorId: string) => {
    setAssignments(prev => ({ ...prev, [itemId]: contractorId }));
    if (contractorId) {
      const contractor = contractorById.get(contractorId);
      if (contractor && !recipientList.some(row => String(row.id) === contractorId)) setExtraIds(prev => [...prev, contractorId]);
      updateRecipient(contractorId, { checked: true, scope: 'assigned', email: recipientFor(contractorId).email || String(contractor?.email || '') });
    }
  };

  const assignAllUnassigned = (contractorId: string) => {
    if (!contractorId) return;
    openItems.forEach(item => { if (!assignments[item.id]) assignItem(item.id, contractorId); });
  };

  const saveAssignments = async (): Promise<boolean> => {
    if (!dirtyAssignments.length) return true;
    setSavingAssignments(true);
    try {
      await api.put(`/projects/${projectId}/punch-list/assignments`, {
        assignments: dirtyAssignments.map(([item_id, contractor_id]) => ({ item_id, contractor_id: contractor_id || null })),
      });
      setSavedAssignments({ ...assignments });
      toast.success(`${dirtyAssignments.length} item${dirtyAssignments.length === 1 ? '' : 's'} assigned`);
      await onSent();
      return true;
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to save assignments');
      return false;
    } finally {
      setSavingAssignments(false);
    }
  };

  const checkedRecipients = recipientList.filter(contractor => recipientFor(String(contractor.id)).checked);

  const send = async () => {
    if (sending) return;
    if (!checkedRecipients.length) {
      toast.error('Check at least one contractor to send to');
      return;
    }
    const missingEmail = checkedRecipients.find(contractor => !recipientFor(String(contractor.id)).email.trim());
    if (missingEmail) {
      toast.error(`Add an email for ${contractorLabel(missingEmail)} or uncheck them`);
      return;
    }
    setSending(true);
    try {
      if (!(await saveAssignments())) return;
      const res = await api.post(`/projects/${projectId}/punch-list/send`, {
        recipients: checkedRecipients.map(contractor => {
          const recipient = recipientFor(String(contractor.id));
          const onFile = String(contractor.email || '').trim().toLowerCase();
          const typed = recipient.email.trim().toLowerCase();
          return {
            contractor_id: contractor.id,
            scope: recipient.scope,
            ...(typed && typed !== onFile ? { email: typed, save_email: recipient.saveEmail } : {}),
          };
        }),
        message: message.trim() || undefined,
        cc: ccOffice,
        include_completed: includeCompleted,
      });
      const list: SendResult[] = Array.isArray(res.data?.results) ? res.data.results : [];
      setResults(list);
      const sentCount = Number(res.data?.sent_count || 0);
      if (sentCount) toast.success(`Punch list sent to ${sentCount} contractor${sentCount === 1 ? '' : 's'}`);
      else toast.error('Nothing was sent. See the details below.');
      await onSent();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to send the punch list');
    } finally {
      setSending(false);
    }
  };

  const busy = sending || savingAssignments;
  const inputClass = 'rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm font-semibold text-gray-900 outline-none placeholder:text-gray-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-300/60';

  return (
    <Modal
      isOpen={isOpen}
      onClose={busy ? () => undefined : onClose}
      title="Email / Send Punch List"
      description="Each contractor gets one email listing their punch list items, with photo links. Assign items below, then check who to send to."
      size="xl"
    >
      {loading ? (
        <div className="flex items-center gap-2 py-10 text-sm font-semibold text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading contractors…</div>
      ) : results ? (
        <div className="space-y-3">
          <p className="text-xs font-black uppercase tracking-wide text-gray-500">Send results</p>
          <ul className="space-y-1.5">
            {results.map(result => (
              <li key={result.contractor_id || result.contractor} className={`flex items-start gap-3 rounded-xl border px-3 py-2 ${result.sent ? 'border-emerald-300 bg-emerald-50' : 'border-red-300 bg-red-50'}`}>
                {result.sent ? <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-700" /> : <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-700" />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-black text-gray-900">{result.contractor}{result.item_count ? <span className="ml-2 font-semibold text-gray-500">{result.item_count} item{result.item_count === 1 ? '' : 's'}</span> : null}</p>
                  <p className={`text-xs font-semibold ${result.sent ? 'text-emerald-700' : 'text-red-700'}`}>
                    {result.sent ? `Sent to ${result.email}${ccOffice ? ` · cc ${ccEmail}` : ''}` : (REASON_TEXT[result.reason || ''] || result.reason || 'Not sent')}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2 border-t border-gray-200 pt-3">
            <button type="button" onClick={() => setResults(null)} className="min-h-10 rounded-xl border border-gray-300 bg-white px-4 text-sm font-black text-gray-700 hover:bg-gray-50">Back</button>
            <button type="button" onClick={onClose} className="min-h-10 rounded-xl border border-blue-300/60 bg-blue-600 px-4 text-sm font-black text-white hover:bg-blue-500">Done</button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {!emailConfigured && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> Email is not configured on this server, so nothing can be sent yet. Assignments still save.
            </div>
          )}

          <section className="rounded-xl border border-gray-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <p className="text-xs font-black uppercase tracking-wide text-gray-500">1 · Who does each item · {openItems.length} item{openItems.length === 1 ? '' : 's'}</p>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-500">
                  Assign all unassigned to
                  <select
                    value=""
                    onChange={event => assignAllUnassigned(event.target.value)}
                    disabled={busy}
                    aria-label="Assign all unassigned items to a contractor"
                    className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs font-bold text-gray-700 outline-none"
                  >
                    <option value="">choose…</option>
                    {selectOptions.onProject.map(contractor => <option key={contractor.id} value={contractor.id}>{contractorLabel(contractor)}</option>)}
                    {selectOptions.others.length > 0 && (
                      <optgroup label="Directory">
                        {selectOptions.others.map(contractor => <option key={contractor.id} value={contractor.id}>{contractorLabel(contractor)}</option>)}
                      </optgroup>
                    )}
                  </select>
                </label>
                {dirtyAssignments.length > 0 && (
                  <button type="button" onClick={saveAssignments} disabled={busy} className="rounded-lg border border-blue-300/60 bg-blue-600 px-2.5 py-1 text-xs font-black text-white hover:bg-blue-500 disabled:opacity-60">
                    {savingAssignments ? 'Saving…' : `Save ${dirtyAssignments.length} assignment${dirtyAssignments.length === 1 ? '' : 's'}`}
                  </button>
                )}
              </div>
            </div>
            <ul className="max-h-[32vh] overflow-y-auto border-t border-gray-200">
              {openItems.length === 0 && <li className="px-3 py-4 text-sm font-semibold text-gray-500">No open punch list items.</li>}
              {openItems.map((item, index) => (
                <li key={item.id} className="flex items-center gap-2 border-t border-gray-200 px-3 py-1.5 first:border-t-0">
                  <span className="w-6 flex-shrink-0 text-right text-[11px] font-black tabular-nums text-gray-400">{index + 1}.</span>
                  <p className={`min-w-0 flex-1 truncate text-sm font-semibold ${item.status === 'completed' ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                    {item.title}
                    {item.last_sent_at && <span className="ml-2 text-[11px] font-semibold text-emerald-700">sent {formatSent(item.last_sent_at)}{item.last_sent_to ? ` to ${item.last_sent_to}` : ''}</span>}
                  </p>
                  <select
                    value={assignments[item.id] || ''}
                    onChange={event => assignItem(item.id, event.target.value)}
                    disabled={busy}
                    aria-label={`Contractor for ${item.title}`}
                    data-assign-select={item.id}
                    className={`w-52 flex-shrink-0 rounded-lg border bg-white px-2 py-1 text-xs font-bold outline-none ${assignments[item.id] ? 'border-amber-300 text-gray-900' : 'border-gray-200 text-gray-500'}`}
                  >
                    <option value="">Unassigned</option>
                    {selectOptions.onProject.map(contractor => <option key={contractor.id} value={contractor.id}>{contractorLabel(contractor)}</option>)}
                    {selectOptions.others.length > 0 && (
                      <optgroup label="Directory">
                        {selectOptions.others.map(contractor => <option key={contractor.id} value={contractor.id}>{contractorLabel(contractor)}</option>)}
                      </optgroup>
                    )}
                  </select>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-xl border border-gray-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <p className="text-xs font-black uppercase tracking-wide text-gray-500">2 · Send to · {checkedRecipients.length} checked</p>
              <div className="relative">
                <div className="flex min-w-64 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2 py-1">
                  <Search className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
                  <input
                    value={directoryQuery}
                    onChange={event => setDirectoryQuery(event.target.value)}
                    placeholder="Add another contractor…"
                    aria-label="Search the contractor directory"
                    disabled={busy}
                    className="min-w-0 flex-1 bg-transparent text-xs font-semibold text-gray-900 outline-none placeholder:text-gray-400"
                  />
                </div>
                {directoryMatches.length > 0 && (
                  <ul className="absolute right-0 z-20 mt-1 w-80 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
                    {directoryMatches.map(contractor => (
                      <li key={contractor.id}>
                        <button type="button" onClick={() => addFromDirectory(contractor)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-100">
                          <UserPlus className="h-3.5 w-3.5 flex-shrink-0 text-blue-700" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-bold text-gray-900">{contractorLabel(contractor)}</span>
                            <span className="block truncate text-[11px] text-gray-500">{[contractor.contact_name, contractor.contractor_category, contractor.email || 'no email on file'].filter(Boolean).join(' · ')}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <ul className="border-t border-gray-200">
              {recipientList.length === 0 && (
                <li className="px-3 py-4 text-sm font-semibold text-gray-500">No contractors are connected to this project yet. Assign an item above or search the directory to add one.</li>
              )}
              {recipientList.map(contractor => {
                const id = String(contractor.id);
                const recipient = recipientFor(id);
                const mine = assignedCount(id);
                const onFile = String(contractor.email || '').trim();
                const typedDiffers = recipient.email.trim().toLowerCase() !== onFile.toLowerCase();
                return (
                  <li key={id} data-recipient={id} className={`border-t border-gray-200 px-3 py-2 first:border-t-0 ${recipient.checked ? 'bg-blue-50' : ''}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="checkbox"
                        checked={recipient.checked}
                        onChange={event => updateRecipient(id, { checked: event.target.checked })}
                        disabled={busy}
                        aria-label={`Send to ${contractorLabel(contractor)}`}
                        className="h-4 w-4 accent-blue-600"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-black text-gray-900">
                          {contractorLabel(contractor)}
                          {contractor.contact_name && <span className="ml-2 font-semibold text-gray-500">{contractor.contact_name}</span>}
                          {contractor.contractor_category && <span className="ml-2 rounded-full bg-gray-100 px-1.5 text-[10px] font-bold text-gray-600">{contractor.contractor_category}</span>}
                        </p>
                        <p className="text-[11px] font-semibold text-gray-500">
                          {mine} item{mine === 1 ? '' : 's'} assigned{contractor.last_sent_at ? ` · last sent ${formatSent(contractor.last_sent_at)}` : ''}{!contractor.linked_to_project && contractors.some(row => String(row.id) === id) ? '' : contractor.linked_to_project ? '' : ' · not on the Assigned Contractors tab'}
                        </p>
                      </div>
                      <input
                        type="email"
                        value={recipient.email}
                        onChange={event => updateRecipient(id, { email: event.target.value })}
                        placeholder="email address"
                        aria-label={`Email for ${contractorLabel(contractor)}`}
                        disabled={busy}
                        className={`${inputClass} w-56 ${!recipient.email.trim() && recipient.checked ? 'border-red-300' : ''}`}
                      />
                      <div className="flex flex-shrink-0 rounded-lg border border-gray-200 bg-white p-0.5 text-[11px] font-bold">
                        <button type="button" onClick={() => updateRecipient(id, { scope: 'assigned' })} disabled={busy} className={`rounded-md px-2 py-1 ${recipient.scope === 'assigned' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}>Their items ({mine})</button>
                        <button type="button" onClick={() => updateRecipient(id, { scope: 'all' })} disabled={busy} className={`rounded-md px-2 py-1 ${recipient.scope === 'all' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}>All open ({openItems.length})</button>
                      </div>
                    </div>
                    {typedDiffers && recipient.email.trim() && (
                      <label className="mt-1 flex items-center gap-1.5 pl-6 text-[11px] font-semibold text-gray-500">
                        <input type="checkbox" checked={recipient.saveEmail} onChange={event => updateRecipient(id, { saveEmail: event.target.checked })} className="h-3.5 w-3.5 accent-blue-600" />
                        Save this email to {contractorLabel(contractor)}'s profile
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="space-y-2">
            <label className="block text-xs font-black uppercase tracking-wide text-gray-500" htmlFor="punch-send-message">3 · Note to include (optional)</label>
            <VoiceTextarea
              id="punch-send-message"
              value={message}
              onChange={event => setMessage(event.target.value)}
              rows={2}
              disabled={busy}
              placeholder="e.g. Please complete these by Friday and text the office when done."
              className={`${inputClass} w-full resize-none`}
            />
            <div className="flex flex-wrap items-center gap-4 text-xs font-semibold text-gray-600">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={ccOffice} onChange={event => setCcOffice(event.target.checked)} disabled={busy} className="h-4 w-4 accent-blue-600" /> CC the office ({ccEmail})</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={includeCompleted} onChange={event => setIncludeCompleted(event.target.checked)} disabled={busy} className="h-4 w-4 accent-blue-600" /> Include completed items</label>
            </div>
          </section>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-200 pt-3">
            <button type="button" onClick={onClose} disabled={busy} className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-gray-300 bg-white px-4 text-sm font-black text-gray-700 hover:bg-gray-50 disabled:opacity-60">
              <X className="h-4 w-4" /> Cancel
            </button>
            <button
              type="button"
              onClick={send}
              disabled={busy || !emailConfigured || checkedRecipients.length === 0}
              className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-blue-300/60 bg-blue-600 px-4 text-sm font-black text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
              title={!emailConfigured ? 'Email is not configured on this server' : undefined}
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : checkedRecipients.length ? <Send className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
              {sending ? 'Sending…' : `Send to ${checkedRecipients.length} contractor${checkedRecipients.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
