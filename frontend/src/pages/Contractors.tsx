import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building2,
  Edit2,
  FileText,
  Hash,
  Link as LinkIcon,
  Mail,
  MapPin,
  MessageSquare,
  Phone,
  Search,
  Send,
  SlidersHorizontal,
  Trash2,
  Users,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { Loading, Modal } from '../components/ui';
import { useAuthStore } from '../store/authStore';

interface ContractorInvoice {
  id: string;
  invoice_number: string;
  project_id: string;
  total: number;
  status: string;
  updated_at: string;
  created_at?: string;
  address: string;
  job_name: string;
}

interface ConnectedProject {
  id?: string | null;
  address: string;
  job_name?: string | null;
  status?: string | null;
}

interface ContractorRow {
  id: string;
  name: string;
  vendor_name?: string;
  contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  billing_address?: string | null;
  account_number?: string | null;
  contractor_category?: string | null;
  contractor_secondary_category?: string | null;
  source?: string | null;
  project_addresses: string[];
  connected_projects?: ConnectedProject[];
  connected_project_count: number;
  invoice_count: number;
  total_paid: number;
  note_count?: number;
  latest_note_at?: string | null;
  latest_notes?: ContractorNotePreview[];
  last_paid_invoice?: ContractorInvoice | null;
  last_invoice?: ContractorInvoice | null;
}

interface ProjectOption {
  id: string;
  address: string;
  job_name: string;
  status: string;
}

interface ContractorNote {
  id: string;
  contractor_id: string;
  user_id: string;
  user_name: string;
  user_avatar_url?: string | null;
  note: string;
  created_at: string;
}

interface ContractorNotePreview {
  note: string;
  user_name: string;
  created_at: string;
}

const fallbackCategories = [
  'Floor',
  'Roof',
  'Electrical',
  'Plumbing',
  'Handymen',
  'Painting',
  'Drywall',
  'Concrete',
  'Cleaning',
  'Window Install',
  'Carpenter',
  'Carpet Installer',
  'Foundations',
  'Excavators',
  'Framing',
];

const money = (value?: number | null) =>
  Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const dateValue = (value?: string | null) => value ? new Date(value).getTime() : 0;

const initials = (name?: string) =>
  (name || '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase())
    .join('') || '?';

const formatDate = (value?: string | null) => {
  if (!value) return '-';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '-';
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export default function Contractors() {
  const navigate = useNavigate();
  const { user: currentUser } = useAuthStore();
  const [contractors, setContractors] = useState<ContractorRow[]>([]);
  const [categories, setCategories] = useState<string[]>(fallbackCategories);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [paidFilter, setPaidFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [sortBy, setSortBy] = useState('name');
  const [expandedContractorId, setExpandedContractorId] = useState<string | null>(null);
  const [contractorNotes, setContractorNotes] = useState<Record<string, ContractorNote[]>>({});
  const [noteInputs, setNoteInputs] = useState<Record<string, string>>({});
  const [loadingNotes, setLoadingNotes] = useState<Record<string, boolean>>({});
  const [savingNotes, setSavingNotes] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingContractor, setEditingContractor] = useState<ContractorRow | null>(null);
  const [editForm, setEditForm] = useState({
    vendor_name: '',
    contact_name: '',
    email: '',
    phone: '',
    billing_address: '',
    account_number: '',
    contractor_category: '',
    contractor_secondary_category: '',
  });
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [projectFilter, setProjectFilter] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingContractorId, setDeletingContractorId] = useState<string | null>(null);
  const canAddCategories = currentUser ? ['super_admin', 'operations_manager'].includes(currentUser.role) : false;

  const loadDirectory = async () => {
    const [directoryRes, projectsRes] = await Promise.all([
      api.get('/users/contractors/directory'),
      api.get('/projects'),
    ]);
    setContractors(Array.isArray(directoryRes.data?.contractors) ? directoryRes.data.contractors : []);
    setCategories(Array.isArray(directoryRes.data?.categories) ? directoryRes.data.categories : fallbackCategories);
    setProjects(Array.isArray(projectsRes.data) ? projectsRes.data : []);
  };

  useEffect(() => {
    loadDirectory()
      .catch(() => setError('Contractor directory is unavailable for this account.'))
      .finally(() => setLoading(false));
  }, []);

  const loadContractorNotes = async (contractorId: string) => {
    setLoadingNotes(prev => ({ ...prev, [contractorId]: true }));
    try {
      const res = await api.get(`/users/contractors/${contractorId}/notes`);
      setContractorNotes(prev => ({
        ...prev,
        [contractorId]: Array.isArray(res.data) ? res.data : [],
      }));
    } finally {
      setLoadingNotes(prev => ({ ...prev, [contractorId]: false }));
    }
  };

  const toggleNotes = async (contractorId: string) => {
    if (expandedContractorId === contractorId) {
      setExpandedContractorId(null);
      return;
    }
    setExpandedContractorId(contractorId);
    if (!contractorNotes[contractorId]) await loadContractorNotes(contractorId);
  };

  const addContractorNote = async (contractorId: string) => {
    const note = (noteInputs[contractorId] || '').trim();
    if (!note) return;

    setSavingNotes(prev => ({ ...prev, [contractorId]: true }));
    try {
      const res = await api.post(`/users/contractors/${contractorId}/notes`, { note });
      setContractorNotes(prev => ({
        ...prev,
        [contractorId]: [res.data, ...(prev[contractorId] || [])],
      }));
      setNoteInputs(prev => ({ ...prev, [contractorId]: '' }));
      setContractors(prev => prev.map(contractor => contractor.id === contractorId
        ? {
            ...contractor,
            note_count: Number(contractor.note_count || 0) + 1,
            latest_note_at: res.data.created_at,
            latest_notes: [{ note: res.data.note, user_name: res.data.user_name, created_at: res.data.created_at }, ...(contractor.latest_notes || [])].slice(0, 2),
          }
        : contractor
      ));
    } catch {
      toast.error('Failed to add contractor note');
    } finally {
      setSavingNotes(prev => ({ ...prev, [contractorId]: false }));
    }
  };

  const deleteContractorNote = async (contractorId: string, noteId: string) => {
    try {
      await api.delete(`/users/contractors/${contractorId}/notes/${noteId}`);
      setContractorNotes(prev => ({
        ...prev,
        [contractorId]: (prev[contractorId] || []).filter(note => note.id !== noteId),
      }));
      setContractors(prev => prev.map(contractor => contractor.id === contractorId
        ? { ...contractor, note_count: Math.max(Number(contractor.note_count || 1) - 1, 0) }
        : contractor
      ));
    } catch {
      toast.error('Failed to delete note');
    }
  };

  const openEdit = (contractor: ContractorRow) => {
    setEditingContractor(contractor);
    setEditForm({
      vendor_name: contractor.vendor_name || contractor.name || '',
      contact_name: contractor.contact_name || '',
      email: contractor.email || '',
      phone: contractor.phone || '',
      billing_address: contractor.billing_address || '',
      account_number: contractor.account_number || '',
      contractor_category: contractor.contractor_category || '',
      contractor_secondary_category: contractor.contractor_secondary_category || '',
    });
    setSelectedProjectIds((contractor.connected_projects || []).map(project => project.id).filter(Boolean) as string[]);
    setProjectFilter('');
  };

  const addCategory = async (field: 'contractor_category' | 'contractor_secondary_category') => {
    const name = window.prompt('New contractor category');
    if (!name?.trim()) {
      setEditForm(prev => ({ ...prev, [field]: '' }));
      return;
    }
    try {
      const res = await api.post('/users/contractor-categories', { name: name.trim() });
      setCategories(Array.isArray(res.data?.categories) ? res.data.categories : categories);
      setEditForm(prev => ({ ...prev, [field]: res.data?.category || name.trim() }));
      toast.success('Category added');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to add category');
      setEditForm(prev => ({ ...prev, [field]: '' }));
    }
  };

  const categoryLabel = (contractor: ContractorRow) =>
    [contractor.contractor_category, contractor.contractor_secondary_category].filter(Boolean).join(' / ');

  const saveEdit = async () => {
    if (!editingContractor || !editForm.vendor_name.trim()) {
      toast.error('Contractor name is required');
      return;
    }

    setSavingEdit(true);
    try {
      await api.put(`/users/contractors/${editingContractor.id}/profile`, {
        ...editForm,
        vendor_name: editForm.vendor_name.trim(),
      });
      await api.put(`/users/contractors/${editingContractor.id}/projects`, {
        project_ids: selectedProjectIds,
      });
      await loadDirectory();
      toast.success('Contractor updated');
      setEditingContractor(null);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update contractor');
    } finally {
      setSavingEdit(false);
    }
  };

  const deleteContractor = async (contractor: ContractorRow) => {
    const confirmed = window.confirm(`Delete ${contractor.name} from the contractor directory? Contractor notes and project links for this contractor will also be removed.`);
    if (!confirmed) return;

    setDeletingContractorId(contractor.id);
    try {
      await api.delete(`/users/contractors/${contractor.id}/profile`);
      setContractors(prev => prev.filter(item => item.id !== contractor.id));
      if (expandedContractorId === contractor.id) setExpandedContractorId(null);
      toast.success('Contractor deleted');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to delete contractor');
    } finally {
      setDeletingContractorId(null);
    }
  };

  const filteredContractors = useMemo(() => {
    const q = query.trim().toLowerCase();
    const min = minAmount ? Number(minAmount) : null;
    const max = maxAmount ? Number(maxAmount) : null;
    const from = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const to = dateTo ? new Date(`${dateTo}T23:59:59`).getTime() : null;

    const rows = contractors.filter((contractor) => {
      const lastPaid = contractor.last_paid_invoice;
      const lastPaidAmount = Number(lastPaid?.total || 0);
      const lastPaidDate = dateValue(lastPaid?.updated_at);

      if (q) {
        const haystack = [
          contractor.name,
          contractor.email,
          contractor.phone,
          contractor.company,
          contractor.billing_address,
          contractor.account_number,
          contractor.contractor_category,
          contractor.contractor_secondary_category,
          ...(contractor.latest_notes || []).map(note => note.note),
          ...(contractor.project_addresses || []),
          lastPaid?.invoice_number,
          lastPaid?.address,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }

      if (category && contractor.contractor_category !== category && contractor.contractor_secondary_category !== category) return false;
      if (paidFilter === 'paid' && !lastPaid) return false;
      if (paidFilter === 'unpaid' && lastPaid) return false;
      if (from !== null && (!lastPaidDate || lastPaidDate < from)) return false;
      if (to !== null && (!lastPaidDate || lastPaidDate > to)) return false;
      if (min !== null && lastPaidAmount < min) return false;
      if (max !== null && lastPaidAmount > max) return false;
      return true;
    });

    return rows.sort((a, b) => {
      if (sortBy === 'last_paid_date') return dateValue(b.last_paid_invoice?.updated_at) - dateValue(a.last_paid_invoice?.updated_at);
      if (sortBy === 'last_paid_amount') return Number(b.last_paid_invoice?.total || 0) - Number(a.last_paid_invoice?.total || 0);
      if (sortBy === 'total_paid') return Number(b.total_paid || 0) - Number(a.total_paid || 0);
      if (sortBy === 'category') return categoryLabel(a).localeCompare(categoryLabel(b));
      return a.name.localeCompare(b.name);
    });
  }, [contractors, query, category, paidFilter, dateFrom, dateTo, minAmount, maxAmount, sortBy]);

  const filteredProjectOptions = projects.filter(project => {
    const q = projectFilter.trim().toLowerCase();
    if (!q) return true;
    return `${project.address} ${project.job_name}`.toLowerCase().includes(q);
  });

  if (loading) return <Loading />;

  return (
    <div className="min-h-full px-6 py-6 md:px-8" style={{ background: '#F0F2F5' }}>
      <div className="max-w-7xl mx-auto space-y-5">
        <div className="flex flex-col xl:flex-row xl:items-end xl:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-gray-900 tracking-tight">Contractors</h1>
            <p className="text-sm text-gray-500 mt-1">
              {filteredContractors.length} of {contractors.length} contractor records
            </p>
          </div>
          <div
            className="flex items-center gap-2 px-3 py-2.5 rounded-xl w-full xl:w-[460px]"
            style={{ background: 'white', border: '1px solid #D1D5DB', boxShadow: '0 8px 24px rgba(17,24,39,0.06)' }}
          >
            <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search contractor, project, invoice, phone, or email"
              className="w-full bg-transparent text-sm outline-none text-gray-900 placeholder:text-gray-500"
            />
          </div>
        </div>

        <div className="rounded-2xl p-4" style={{ background: 'white', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>
          <div className="flex items-center gap-2 mb-3">
            <SlidersHorizontal className="w-4 h-4 text-gray-400" />
            <p className="text-sm font-black text-gray-900">Filters</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-3">
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="px-3 py-2.5 rounded-xl border border-gray-300 text-sm bg-white">
              <option value="">All categories</option>
              {categories.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            <select value={paidFilter} onChange={(e) => setPaidFilter(e.target.value)} className="px-3 py-2.5 rounded-xl border border-gray-300 text-sm bg-white">
              <option value="">All payment history</option>
              <option value="paid">Has paid job</option>
              <option value="unpaid">No paid job</option>
            </select>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="px-3 py-2.5 rounded-xl border border-gray-300 text-sm" />
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="px-3 py-2.5 rounded-xl border border-gray-300 text-sm" />
            <input type="number" min="0" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} placeholder="Min paid" className="px-3 py-2.5 rounded-xl border border-gray-300 text-sm" />
            <input type="number" min="0" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} placeholder="Max paid" className="px-3 py-2.5 rounded-xl border border-gray-300 text-sm" />
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="px-3 py-2.5 rounded-xl border border-gray-300 text-sm bg-white">
              <option value="name">Sort: Name</option>
              <option value="category">Sort: Category</option>
              <option value="last_paid_date">Sort: Last paid date</option>
              <option value="last_paid_amount">Sort: Last paid amount</option>
              <option value="total_paid">Sort: Total paid</option>
            </select>
          </div>
        </div>

        {error ? (
          <div className="rounded-2xl p-6 text-sm font-semibold text-red-700" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
            {error}
          </div>
        ) : filteredContractors.length === 0 ? (
          <div className="rounded-2xl p-12 text-center" style={{ background: 'white', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>
            <Users className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-sm font-bold text-gray-500">No contractors match these filters</p>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredContractors.map((contractor) => {
              const lastPaid = contractor.last_paid_invoice;
              const connectedProjects = contractor.connected_projects || [];
              return (
                <div key={contractor.id} className="rounded-2xl overflow-hidden" style={{ background: 'white', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>
                  <div className="p-5">
                    <div className="flex flex-col lg:flex-row lg:items-start gap-4">
                      <div className="flex items-start gap-3 flex-1 min-w-0">
                        <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white text-sm font-black flex-shrink-0" style={{ background: 'linear-gradient(135deg, #1F2937, #D99D26)' }}>
                          {initials(contractor.name)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="text-base font-black text-gray-900 truncate">{contractor.name}</h2>
                            {categoryLabel(contractor) ? (
                              <span className="inline-flex px-2.5 py-1 rounded-full text-xs font-black" style={{ background: '#FEF3C7', color: '#92400E' }}>
                                {categoryLabel(contractor)}
                              </span>
                            ) : (
                              <span className="inline-flex px-2.5 py-1 rounded-full text-xs font-black bg-gray-100 text-gray-500">
                                Uncategorized
                              </span>
                            )}
                          </div>
                          {contractor.contact_name && <p className="text-sm text-gray-500 mt-0.5">Contact: {contractor.contact_name}</p>}
                          <div className="flex flex-wrap gap-2 mt-3">
                            {contractor.phone && (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-gray-50 text-gray-700 border border-gray-100">
                                <Phone className="w-3.5 h-3.5" /> {contractor.phone}
                              </span>
                            )}
                            {contractor.email && (
                              <a href={`mailto:${contractor.email}`} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-100">
                                <Mail className="w-3.5 h-3.5" /> {contractor.email}
                              </a>
                            )}
                            {contractor.account_number && (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-gray-50 text-gray-700 border border-gray-100">
                                <Hash className="w-3.5 h-3.5" /> {contractor.account_number}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => openEdit(contractor)}
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-black bg-gray-900 text-white hover:bg-gray-800 transition-colors"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleNotes(contractor.id)}
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-black transition-colors"
                          style={{
                            background: expandedContractorId === contractor.id ? '#FEF3C7' : '#F9FAFB',
                            color: expandedContractorId === contractor.id ? '#92400E' : '#374151',
                            border: '1px solid #E5E7EB',
                          }}
                        >
                          <MessageSquare className="w-3.5 h-3.5" />
                          {contractor.note_count || 0} notes
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteContractor(contractor)}
                          disabled={deletingContractorId === contractor.id}
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-black transition-colors disabled:opacity-50"
                          style={{ background: '#FEF2F2', color: '#B91C1C', border: '1px solid #FECACA' }}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          {deletingContractorId === contractor.id ? 'Deleting...' : 'Delete'}
                        </button>
                      </div>
                    </div>

                    <div className="grid lg:grid-cols-12 gap-4 mt-5">
                      <div className="lg:col-span-3 rounded-xl border border-gray-100 p-4 bg-gray-50">
                        <div className="flex items-center gap-2 mb-2">
                          <Building2 className="w-4 h-4 text-gray-400" />
                          <p className="text-xs font-black uppercase tracking-wide text-gray-500">Billing Address</p>
                        </div>
                        <p className="text-sm text-gray-800 whitespace-pre-wrap">{contractor.billing_address || 'No billing address on file'}</p>
                      </div>

                      <div className="lg:col-span-3 rounded-xl border border-gray-100 p-4">
                        <div className="flex items-center justify-between gap-2 mb-3">
                          <div className="flex items-center gap-2">
                            <LinkIcon className="w-4 h-4 text-gray-400" />
                            <p className="text-xs font-black uppercase tracking-wide text-gray-500">Connected Projects</p>
                          </div>
                          <span className="text-xs font-black text-gray-400">{connectedProjects.length}</span>
                        </div>
                        {connectedProjects.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {connectedProjects.slice(0, 6).map((project, index) => (
                              <button
                                key={`${project.id || project.address}-${index}`}
                                type="button"
                                onClick={() => project.id ? navigate(`/projects/${project.id}`) : undefined}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold text-left"
                                style={{ background: '#EFF6FF', color: '#1D4ED8', border: '1px solid #BFDBFE' }}
                              >
                                <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
                                <span className="max-w-[220px] truncate">{project.address}</span>
                              </button>
                            ))}
                            {connectedProjects.length > 6 && (
                              <span className="px-2.5 py-1.5 rounded-xl text-xs font-black bg-gray-100 text-gray-500">
                                +{connectedProjects.length - 6} more
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="inline-flex px-2.5 py-1 rounded-full text-xs font-black" style={{ background: '#FEF2F2', color: '#B91C1C' }}>
                            Needs project connection
                          </span>
                        )}
                      </div>

                      <div className="lg:col-span-3 rounded-xl border border-gray-100 p-4 bg-white">
                        <div className="flex items-center justify-between gap-2 mb-3">
                          <div className="flex items-center gap-2">
                            <MessageSquare className="w-4 h-4 text-gray-400" />
                            <p className="text-xs font-black uppercase tracking-wide text-gray-500">Notes</p>
                          </div>
                          <span className="text-xs font-black text-gray-400">{contractor.note_count || 0}</span>
                        </div>
                        {(contractor.latest_notes || []).length > 0 ? (
                          <div className="space-y-2">
                            {(contractor.latest_notes || []).slice(0, 2).map((note, index) => (
                              <div key={`${note.created_at}-${index}`} className="rounded-lg bg-gray-50 border border-gray-100 px-2.5 py-2">
                                <p
                                  className="text-xs font-semibold text-gray-700"
                                  style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                                >
                                  {note.note}
                                </p>
                                <p className="text-[11px] text-gray-400 mt-1 truncate">{note.user_name}</p>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-gray-400">No notes yet</p>
                        )}
                      </div>

                      <div className="lg:col-span-3 rounded-xl border border-gray-100 p-4">
                        <div className="flex items-center gap-2 mb-3">
                          <FileText className="w-4 h-4 text-gray-400" />
                          <p className="text-xs font-black uppercase tracking-wide text-gray-500">Payment History</p>
                        </div>
                        <div className="space-y-2">
                          <div>
                            <p className="text-xs text-gray-400">Last job paid</p>
                            <p className="text-sm font-black text-gray-900">{lastPaid ? money(lastPaid.total) : 'No paid job'}</p>
                            {lastPaid && <p className="text-xs text-gray-500 truncate">{lastPaid.address}</p>}
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="text-xs text-gray-400">Last paid date</p>
                              <p className="text-xs font-bold text-gray-700">{formatDate(lastPaid?.updated_at)}</p>
                            </div>
                            <div className="text-right">
                              <p className="text-xs text-gray-400">Total paid</p>
                              <p className="text-xs font-black text-gray-900">{money(contractor.total_paid)}</p>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {expandedContractorId === contractor.id && (
                    <div className="border-t border-gray-100 p-5" style={{ background: '#FAFAFA' }}>
                      <div className="rounded-2xl border border-gray-200 p-4 bg-white">
                        <div className="flex items-center justify-between gap-3 mb-3">
                          <div>
                            <p className="text-sm font-black text-gray-900">Contractor Notes</p>
                            <p className="text-xs text-gray-500">Internal notes for this contractor record</p>
                          </div>
                        </div>
                        <div className="flex flex-col md:flex-row gap-3">
                          <textarea
                            value={noteInputs[contractor.id] || ''}
                            onChange={(event) => setNoteInputs(prev => ({ ...prev, [contractor.id]: event.target.value }))}
                            rows={2}
                            placeholder={`Add a note about ${contractor.name}`}
                            className="flex-1 px-3.5 py-2.5 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                          />
                          <button
                            type="button"
                            onClick={() => addContractorNote(contractor.id)}
                            disabled={savingNotes[contractor.id] || !(noteInputs[contractor.id] || '').trim()}
                            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-black text-white disabled:opacity-50"
                            style={{ background: '#2563EB' }}
                          >
                            <Send className="w-4 h-4" />
                            Add Note
                          </button>
                        </div>

                        <div className="mt-4 space-y-3">
                          {loadingNotes[contractor.id] ? (
                            <p className="text-sm text-gray-400">Loading notes...</p>
                          ) : (contractorNotes[contractor.id] || []).length === 0 ? (
                            <p className="text-sm text-gray-400">No contractor notes yet</p>
                          ) : (contractorNotes[contractor.id] || []).map((note) => (
                            <div key={note.id} className="flex items-start gap-3 rounded-xl border border-gray-100 p-3">
                              {note.user_avatar_url ? (
                                <img src={note.user_avatar_url} alt={note.user_name} className="w-9 h-9 rounded-xl object-cover flex-shrink-0" style={{ objectPosition: 'center top' }} />
                              ) : (
                                <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-black flex-shrink-0" style={{ background: 'linear-gradient(135deg, #D99D26, #C4891F)' }}>
                                  {initials(note.user_name)}
                                </div>
                              )}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="text-sm font-black text-gray-900">{note.user_name}</p>
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs text-gray-400 whitespace-nowrap">{new Date(note.created_at).toLocaleString('en-US')}</span>
                                    <button
                                      type="button"
                                      onClick={() => deleteContractorNote(contractor.id, note.id)}
                                      className="p-1 rounded-lg text-red-400 hover:bg-red-50 hover:text-red-600"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </div>
                                <p className="text-sm text-gray-700 whitespace-pre-wrap mt-1">{note.note}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal isOpen={!!editingContractor} onClose={() => setEditingContractor(null)} title="Edit Contractor" size="lg">
        <div className="space-y-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Contractor Name *</label>
              <input value={editForm.vendor_name} onChange={e => setEditForm(prev => ({ ...prev, vendor_name: e.target.value }))} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Contact Name</label>
              <input value={editForm.contact_name} onChange={e => setEditForm(prev => ({ ...prev, contact_name: e.target.value }))} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
              <select
                value={editForm.contractor_category}
                onChange={e => {
                  if (e.target.value === '__add_new__') addCategory('contractor_category');
                  else setEditForm(prev => ({ ...prev, contractor_category: e.target.value }));
                }}
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              >
                <option value="">Uncategorized</option>
                {categories.map(item => <option key={item} value={item}>{item}</option>)}
                {canAddCategories && <option value="__add_new__">+ Add category...</option>}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Secondary Category</label>
              <select
                value={editForm.contractor_secondary_category}
                onChange={e => {
                  if (e.target.value === '__add_new__') addCategory('contractor_secondary_category');
                  else setEditForm(prev => ({ ...prev, contractor_secondary_category: e.target.value }));
                }}
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              >
                <option value="">None</option>
                {categories.map(item => <option key={item} value={item}>{item}</option>)}
                {canAddCategories && <option value="__add_new__">+ Add category...</option>}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
              <input value={editForm.phone} onChange={e => setEditForm(prev => ({ ...prev, phone: e.target.value }))} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input value={editForm.email} onChange={e => setEditForm(prev => ({ ...prev, email: e.target.value }))} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Account Number</label>
              <input value={editForm.account_number} onChange={e => setEditForm(prev => ({ ...prev, account_number: e.target.value }))} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Billing Address</label>
              <textarea value={editForm.billing_address} onChange={e => setEditForm(prev => ({ ...prev, billing_address: e.target.value }))} rows={2} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 p-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
              <div>
                <p className="text-sm font-black text-gray-900">Connected Projects</p>
                <p className="text-xs text-gray-500">Select every project this contractor is tied to.</p>
              </div>
              <span className="text-xs font-black text-blue-700 bg-blue-50 px-2.5 py-1 rounded-full">
                {selectedProjectIds.length} selected
              </span>
            </div>
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                value={projectFilter}
                onChange={e => setProjectFilter(e.target.value)}
                placeholder="Filter projects by address or job name"
                className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="max-h-64 overflow-y-auto space-y-2 pr-1">
              {filteredProjectOptions.map(project => {
                const selected = selectedProjectIds.includes(project.id);
                return (
                  <label
                    key={project.id}
                    className="flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors"
                    style={{ borderColor: selected ? '#93C5FD' : '#E5E7EB', background: selected ? '#EFF6FF' : '#FFFFFF' }}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => {
                        setSelectedProjectIds(prev => selected
                          ? prev.filter(id => id !== project.id)
                          : [...prev, project.id]
                        );
                      }}
                      className="mt-1"
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-gray-900">{project.address}</p>
                      <p className="text-xs text-gray-500">{project.job_name}</p>
                    </div>
                  </label>
                );
              })}
              {filteredProjectOptions.length === 0 && (
                <p className="text-center text-sm text-gray-400 py-6">No projects match that filter</p>
              )}
            </div>
          </div>

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={() => setEditingContractor(null)} className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="button" onClick={saveEdit} disabled={savingEdit} className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">
              {savingEdit ? 'Saving...' : 'Save Contractor'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
