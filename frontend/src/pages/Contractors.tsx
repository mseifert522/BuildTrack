import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building2,
  CheckCircle2,
  Clock3,
  Copy,
  Edit2,
  Eye,
  EyeOff,
  ExternalLink,
  FileText,
  Hash,
  Link as LinkIcon,
  Mail,
  MapPin,
  MessageSquare,
  Phone,
  Plus,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Users,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { Loading, Modal } from '../components/ui';
import { useAuthStore } from '../store/authStore';
import { formatEasternDate, formatEasternDateTime, parseBuildTrackTimestamp } from '../lib/time';

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
  contractor_status?: 'active' | 'terminated' | 'will_use_again' | string | null;
  contractor_category?: string | null;
  contractor_secondary_category?: string | null;
  contractor_categories?: string[] | null;
  created_at?: string | null;
  updated_at?: string | null;
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
  onboarding_status?: string | null;
  onboarding_last_sent_at?: string | null;
  onboarding_expires_at?: string | null;
  onboarding_submitted_at?: string | null;
  tax_id_last4?: string | null;
  bank_account_last4?: string | null;
  routing_last4?: string | null;
  bank_name?: string | null;
}

interface Sensitive1099Details {
  contractor_id: string;
  contractor_name?: string | null;
  submitted_at?: string | null;
  updated_at?: string | null;
  legal_name?: string | null;
  business_name?: string | null;
  tax_classification?: string | null;
  tax_id_type?: string | null;
  tax_id?: string | null;
  mailing_address?: string | null;
  phone?: string | null;
  email?: string | null;
  bank_name?: string | null;
  account_type?: string | null;
  account_number?: string | null;
  routing_number?: string | null;
  payment_method?: string | null;
  insurance_provider?: string | null;
  insurance_policy_number?: string | null;
  insurance_expires_at?: string | null;
  license_number?: string | null;
  license_state?: string | null;
  w9_certified?: string | null;
  ach_authorized?: string | null;
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

const dateValue = (value?: string | null) => parseBuildTrackTimestamp(value)?.getTime() || 0;

const initials = (name?: string) =>
  (name || '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase())
    .join('') || '?';

const formatDate = (value?: string | null) => {
  if (!value) return '-';
  return formatEasternDate(value, { month: 'short', day: 'numeric', year: 'numeric' });
};

const isSetupComplete = (contractor: ContractorRow) =>
  contractor.onboarding_status === 'submitted' || Boolean(contractor.onboarding_submitted_at);

const hasContractorInformationCollected = (contractor: ContractorRow) =>
  isSetupComplete(contractor) || Boolean(contractor.tax_id_last4 || contractor.bank_account_last4);

const isSetupPending = (contractor: ContractorRow) =>
  ['sent', 'verified'].includes(contractor.onboarding_status || '') &&
  (!contractor.onboarding_expires_at || dateValue(contractor.onboarding_expires_at) > Date.now());

const setupButtonLabel = (contractor: ContractorRow, sending: boolean) => {
  if (sending) return 'Sending...';
  if (isSetupComplete(contractor)) return 'Request Updated 1099 Info';
  if (isSetupPending(contractor)) return 'Resend 1099 Setup Link';
  return 'Send 1099 Setup Link';
};

const contractorStatusMeta = (status?: string | null) => {
  if (status === 'terminated') {
    return { label: 'Terminated', background: '#FEF2F2', color: '#B91C1C', border: '#FECACA' };
  }
  if (status === 'will_use_again') {
    return { label: 'Will use again', background: '#EFF6FF', color: '#1D4ED8', border: '#BFDBFE' };
  }
  return { label: 'Active', background: '#ECFDF5', color: '#047857', border: '#A7F3D0' };
};

const emptyContractorForm = {
  vendor_name: '',
  contact_name: '',
  email: '',
  phone: '',
  billing_address: '',
  account_number: '',
  contractor_status: 'active',
  contractor_category: '',
  contractor_secondary_category: '',
  contractor_categories: [] as string[],
};

export default function Contractors() {
  const navigate = useNavigate();
  const { user: currentUser } = useAuthStore();
  const [contractors, setContractors] = useState<ContractorRow[]>([]);
  const [categories, setCategories] = useState<string[]>(fallbackCategories);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [query, setQuery] = useState('');
  const [nameSearch, setNameSearch] = useState('');
  const [category, setCategory] = useState('');
  const [paidFilter, setPaidFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [sortBy, setSortBy] = useState('newest');
  const [expandedContractorId, setExpandedContractorId] = useState<string | null>(null);
  const [contractorNotes, setContractorNotes] = useState<Record<string, ContractorNote[]>>({});
  const [noteInputs, setNoteInputs] = useState<Record<string, string>>({});
  const [loadingNotes, setLoadingNotes] = useState<Record<string, boolean>>({});
  const [savingNotes, setSavingNotes] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [addingContractor, setAddingContractor] = useState(false);
  const [addForm, setAddForm] = useState(emptyContractorForm);
  const [editingContractor, setEditingContractor] = useState<ContractorRow | null>(null);
  const [editForm, setEditForm] = useState(emptyContractorForm);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [projectFilter, setProjectFilter] = useState('');
  const [savingAdd, setSavingAdd] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingContractorId, setDeletingContractorId] = useState<string | null>(null);
  const [requestingSetupId, setRequestingSetupId] = useState<string | null>(null);
  const [setupLinks, setSetupLinks] = useState<Record<string, { url: string; expires_at?: string }>>({});
  const [setupShareEmails, setSetupShareEmails] = useState<Record<string, string>>({});
  const [setupShareSaveEmail, setSetupShareSaveEmail] = useState<Record<string, boolean>>({});
  const [selectedContractorId, setSelectedContractorId] = useState<string | null>(null);
  const [focused1099ContractorId, setFocused1099ContractorId] = useState<string | null>(null);
  const [sensitive1099Details, setSensitive1099Details] = useState<Record<string, Sensitive1099Details>>({});
  const [visible1099Details, setVisible1099Details] = useState<Record<string, boolean>>({});
  const [loading1099DetailsId, setLoading1099DetailsId] = useState<string | null>(null);
  const canAddCategories = currentUser ? ['super_admin', 'operations_manager'].includes(currentUser.role) : false;
  const canReveal1099Details = currentUser ? ['super_admin', 'operations_manager'].includes(currentUser.role) : false;

  const loadDirectory = async () => {
    const [directoryRes, projectsRes] = await Promise.all([
      api.get('/users/contractors/directory'),
      api.get('/projects'),
    ]);
    setContractors(Array.isArray(directoryRes.data?.contractors) ? directoryRes.data.contractors : []);
    setCategories(Array.isArray(directoryRes.data?.categories) ? directoryRes.data.categories : fallbackCategories);
    setProjects(Array.isArray(projectsRes.data) ? projectsRes.data : []);
  };

  const uniqueCategoryList = (values: Array<string | null | undefined>) => {
    const seen = new Set<string>();
    const result: string[] = [];
    values.forEach(value => {
      const name = String(value || '').trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      result.push(name);
    });
    return result;
  };

  const contractorCategoryList = (contractor: ContractorRow) =>
    uniqueCategoryList([
      ...(Array.isArray(contractor.contractor_categories) ? contractor.contractor_categories : []),
      contractor.contractor_category,
      contractor.contractor_secondary_category,
    ]);

  useEffect(() => {
    loadDirectory()
      .catch(() => setError('Contractor directory is unavailable for this account.'))
      .finally(() => setLoading(false));

    const refresh = () => loadDirectory().catch(() => {});
    const interval = window.setInterval(refresh, 15000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
    };
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

  const openNotes = async (contractorId: string) => {
    setExpandedContractorId(contractorId);
    if (!contractorNotes[contractorId]) await loadContractorNotes(contractorId);
  };

  const toggleNotes = async (contractorId: string) => {
    if (expandedContractorId === contractorId) {
      setExpandedContractorId(null);
      return;
    }
    await openNotes(contractorId);
  };

  const openContractorDetails = (contractorId: string) => {
    setFocused1099ContractorId(null);
    setSelectedContractorId(contractorId);
    if (!contractorNotes[contractorId]) {
      loadContractorNotes(contractorId).catch(() => {});
    }
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
    const contractorCategories = contractorCategoryList(contractor);
    setEditingContractor(contractor);
    setEditForm({
      vendor_name: contractor.vendor_name || contractor.name || '',
      contact_name: contractor.contact_name || '',
      email: contractor.email || '',
      phone: contractor.phone || '',
      billing_address: contractor.billing_address || '',
      account_number: contractor.account_number || '',
      contractor_status: contractor.contractor_status || 'active',
      contractor_category: contractorCategories[0] || '',
      contractor_secondary_category: contractorCategories[1] || '',
      contractor_categories: contractorCategories,
    });
    setSelectedProjectIds((contractor.connected_projects || []).map(project => project.id).filter(Boolean) as string[]);
    setProjectFilter('');
  };

  const openAdd = () => {
    setAddForm(emptyContractorForm);
    setSelectedProjectIds([]);
    setProjectFilter('');
    setAddingContractor(true);
  };

  const setFormCategorySelection = (target: 'add' | 'edit', categoryName: string, selected: boolean) => {
    const update = (prev: typeof emptyContractorForm) => {
      const nextCategories = selected
        ? uniqueCategoryList([...(prev.contractor_categories || []), categoryName])
        : (prev.contractor_categories || []).filter(item => item !== categoryName);
      return {
        ...prev,
        contractor_categories: nextCategories,
        contractor_category: nextCategories[0] || '',
        contractor_secondary_category: nextCategories[1] || '',
      };
    };

    if (target === 'add') setAddForm(update);
    else setEditForm(update);
  };

  const addCategory = async (target: 'add' | 'edit') => {
    const name = window.prompt('New contractor category');
    if (!name?.trim()) {
      return;
    }
    try {
      const res = await api.post('/users/contractor-categories', { name: name.trim() });
      setCategories(Array.isArray(res.data?.categories) ? res.data.categories : categories);
      setFormCategorySelection(target, res.data?.category || name.trim(), true);
      toast.success('Category added');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to add category');
    }
  };

  const categoryLabel = (contractor: ContractorRow) =>
    contractorCategoryList(contractor).join(' / ');

  const renderCategorySelector = (form: typeof emptyContractorForm, target: 'add' | 'edit') => (
    <div className="sm:col-span-2">
      <div className="flex items-center justify-between gap-3 mb-2">
        <label className="block text-sm font-medium text-gray-700">Categories</label>
        <span className="text-xs font-black text-blue-700 bg-blue-50 px-2.5 py-1 rounded-full">
          {form.contractor_categories.length || 0} selected
        </span>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-44 overflow-y-auto rounded-xl border border-gray-200 p-3 bg-gray-50">
        {categories.map(item => {
          const selected = form.contractor_categories.includes(item);
          return (
            <label
              key={item}
              className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold cursor-pointer transition-colors"
              style={{ background: selected ? '#EFF6FF' : '#FFFFFF', borderColor: selected ? '#93C5FD' : '#E5E7EB', color: selected ? '#1D4ED8' : '#374151' }}
            >
              <input
                type="checkbox"
                checked={selected}
                onChange={event => setFormCategorySelection(target, item, event.target.checked)}
              />
              <span className="truncate">{item}</span>
            </label>
          );
        })}
      </div>
      {canAddCategories && (
        <button
          type="button"
          onClick={() => addCategory(target)}
          className="mt-2 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-black bg-gray-900 text-white"
        >
          <Plus className="w-3.5 h-3.5" />
          Add category
        </button>
      )}
    </div>
  );

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

  const saveAdd = async () => {
    if (!addForm.vendor_name.trim()) {
      toast.error('Contractor name is required');
      return;
    }

    setSavingAdd(true);
    try {
      await api.post('/users/contractors/profile', {
        ...addForm,
        vendor_name: addForm.vendor_name.trim(),
        project_ids: selectedProjectIds,
      });
      await loadDirectory();
      toast.success('Contractor added');
      setAddingContractor(false);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to add contractor');
    } finally {
      setSavingAdd(false);
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
      if (selectedContractorId === contractor.id) setSelectedContractorId(null);
      toast.success('Contractor deleted');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to delete contractor');
    } finally {
      setDeletingContractorId(null);
    }
  };

  const requestContractorSetup = async (contractor: ContractorRow, recipientEmail?: string, saveEmail = true) => {
    const email = String(recipientEmail || contractor.email || '').trim();
    if (!email) {
      toast.error('Enter an email address before sending setup');
      return;
    }

    setRequestingSetupId(contractor.id);
    try {
      const body = recipientEmail ? { email, save_email: saveEmail } : {};
      const res = await api.post(`/contractor-onboarding/contractors/${contractor.id}/request`, body);
      if (res.data?.setup_url) {
        setSetupLinks(prev => ({
          ...prev,
          [contractor.id]: {
            url: res.data.setup_url,
            expires_at: res.data.expires_at,
          },
        }));
      }
      await loadDirectory();
      toast.success(`Secure 1099 setup email sent to ${res.data?.recipient_email || email}`);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to send contractor setup');
    } finally {
      setRequestingSetupId(null);
    }
  };

  const shareContractorSetup = (contractor: ContractorRow) => {
    const email = String(setupShareEmails[contractor.id] ?? contractor.email ?? '').trim();
    const saveEmail = setupShareSaveEmail[contractor.id] ?? !contractor.email;
    requestContractorSetup(contractor, email, saveEmail);
  };

  const filteredContractors = useMemo(() => {
    const q = query.trim().toLowerCase();
    const nameQ = nameSearch.trim().toLowerCase();
    const min = minAmount ? Number(minAmount) : null;
    const max = maxAmount ? Number(maxAmount) : null;
    const from = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const to = dateTo ? new Date(`${dateTo}T23:59:59`).getTime() : null;

    const rows = contractors.filter((contractor) => {
      const contractorCategories = contractorCategoryList(contractor);
      const lastPaid = contractor.last_paid_invoice;
      const lastPaidAmount = Number(lastPaid?.total || 0);
      const lastPaidDate = dateValue(lastPaid?.updated_at);

      if (nameQ) {
        const nameHaystack = [
          contractor.name,
          contractor.vendor_name,
          contractor.company,
          contractor.contact_name,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!nameHaystack.includes(nameQ)) return false;
      }

      if (q) {
        const haystack = [
          contractor.name,
          contractor.email,
          contractor.phone,
          contractor.company,
          contractor.billing_address,
          contractor.account_number,
          contractor.contractor_status,
          contractor.onboarding_status,
          contractor.bank_name,
          ...contractorCategories,
          ...(contractor.latest_notes || []).map(note => note.note),
          ...(contractor.project_addresses || []),
          lastPaid?.invoice_number,
          lastPaid?.address,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }

      if (category && !contractorCategories.includes(category)) return false;
      if (paidFilter === 'paid' && !lastPaid) return false;
      if (paidFilter === 'unpaid' && lastPaid) return false;
      if (from !== null && (!lastPaidDate || lastPaidDate < from)) return false;
      if (to !== null && (!lastPaidDate || lastPaidDate > to)) return false;
      if (min !== null && lastPaidAmount < min) return false;
      if (max !== null && lastPaidAmount > max) return false;
      return true;
    });

    return rows.sort((a, b) => {
      if (sortBy === 'newest') return (dateValue(b.created_at) - dateValue(a.created_at)) || a.name.localeCompare(b.name);
      if (sortBy === 'last_paid_date') return dateValue(b.last_paid_invoice?.updated_at) - dateValue(a.last_paid_invoice?.updated_at);
      if (sortBy === 'last_paid_amount') return Number(b.last_paid_invoice?.total || 0) - Number(a.last_paid_invoice?.total || 0);
      if (sortBy === 'total_paid') return Number(b.total_paid || 0) - Number(a.total_paid || 0);
      if (sortBy === 'category') return categoryLabel(a).localeCompare(categoryLabel(b));
      return a.name.localeCompare(b.name);
    });
  }, [contractors, query, nameSearch, category, paidFilter, dateFrom, dateTo, minAmount, maxAmount, sortBy]);

  const filteredProjectOptions = projects.filter(project => {
    const q = projectFilter.trim().toLowerCase();
    if (!q) return true;
    return `${project.address} ${project.job_name}`.toLowerCase().includes(q);
  });

  const selectedContractor = useMemo(
    () => contractors.find(contractor => contractor.id === selectedContractorId) || null,
    [contractors, selectedContractorId]
  );

  const scrollTo1099Information = (contractorId: string, delay = 120) => {
    window.setTimeout(() => {
      const section = document.getElementById(`contractor-1099-info-${contractorId}`);
      section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, delay);
  };

  useEffect(() => {
    if (!focused1099ContractorId || selectedContractorId !== focused1099ContractorId) return;
    const timer = window.setTimeout(() => scrollTo1099Information(focused1099ContractorId, 0), 150);

    return () => window.clearTimeout(timer);
  }, [focused1099ContractorId, selectedContractorId]);

  const view1099Information = (contractor: ContractorRow) => {
    setSelectedContractorId(contractor.id);
    setFocused1099ContractorId(null);
    setFocused1099ContractorId(contractor.id);
    scrollTo1099Information(contractor.id, selectedContractorId === contractor.id ? 80 : 220);
    if (!contractorNotes[contractor.id]) {
      loadContractorNotes(contractor.id).catch(() => {});
    }
  };

  const toggleSensitive1099Details = async (contractor: ContractorRow) => {
    if (visible1099Details[contractor.id]) {
      setVisible1099Details(prev => ({ ...prev, [contractor.id]: false }));
      return;
    }
    if (!canReveal1099Details) {
      toast.error('Only authorized management users can reveal full 1099 and ACH details.');
      return;
    }

    try {
      if (!sensitive1099Details[contractor.id]) {
        setLoading1099DetailsId(contractor.id);
        const res = await api.get(`/users/contractors/${contractor.id}/1099`);
        setSensitive1099Details(prev => ({ ...prev, [contractor.id]: res.data }));
      }
      setVisible1099Details(prev => ({ ...prev, [contractor.id]: true }));
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Unable to reveal 1099 information');
    } finally {
      setLoading1099DetailsId(null);
    }
  };

  const copySensitive1099Details = (details: Sensitive1099Details) => {
    const lines = [
      ['Contractor', details.contractor_name],
      ['Legal name', details.legal_name],
      ['Business name', details.business_name],
      ['Tax classification', details.tax_classification],
      ['Tax ID type', details.tax_id_type?.toUpperCase()],
      ['Tax ID', details.tax_id],
      ['Email', details.email],
      ['Phone', details.phone],
      ['Mailing address', details.mailing_address],
      ['Bank name', details.bank_name],
      ['Account type', details.account_type],
      ['ACH account number', details.account_number],
      ['Routing number', details.routing_number],
      ['W-9 certified', details.w9_certified],
      ['ACH authorized', details.ach_authorized],
    ]
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([label, value]) => `${label}: ${value}`)
      .join('\n');

    navigator.clipboard?.writeText(lines);
    toast.success('Full 1099 and ACH details copied');
  };

  const detailValue = (value?: string | number | null) => {
    if (value === null || value === undefined || value === '') return 'Not on file';
    return String(value);
  };

  const detailLine = (label: string, value?: string | number | null, className = '') => (
    <div className={`rounded-xl border border-gray-100 bg-white px-4 py-3 ${className}`}>
      <p className="text-[11px] font-black uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-1 break-words text-sm font-bold leading-5 text-gray-900 whitespace-pre-wrap">{detailValue(value)}</p>
    </div>
  );

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
          <div className="flex flex-col sm:flex-row gap-3 w-full xl:w-auto">
            <button
              type="button"
              onClick={openAdd}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-black text-white shadow-sm"
              style={{ background: '#111827' }}
            >
              <Plus className="w-4 h-4" />
              Add Contractor
            </button>
            <div
              className="flex items-center gap-2 px-3 py-2.5 rounded-xl w-full sm:w-[460px]"
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
              <option value="newest">Sort: Newest contractors</option>
              <option value="name">Sort: Name</option>
              <option value="category">Sort: Category</option>
              <option value="last_paid_date">Sort: Last paid date</option>
              <option value="last_paid_amount">Sort: Last paid amount</option>
              <option value="total_paid">Sort: Total paid</option>
            </select>
          </div>
          <div className="mt-4 pt-4 border-t border-gray-100">
            <label className="block text-xs font-black uppercase tracking-wide text-gray-500 mb-2">Find contractor by name</label>
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-gray-300 bg-white">
              <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
              <input
                value={nameSearch}
                onChange={(e) => setNameSearch(e.target.value)}
                placeholder="Type contractor, company, or contact name"
                className="w-full bg-transparent text-sm outline-none text-gray-900 placeholder:text-gray-500"
              />
            </div>
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
              const setupComplete = isSetupComplete(contractor);
              const contractorInfoCollected = hasContractorInformationCollected(contractor);
              const setupPending = isSetupPending(contractor);
              const setupSending = requestingSetupId === contractor.id;
              const SetupIcon = setupComplete ? CheckCircle2 : setupPending ? Clock3 : ShieldCheck;
              const statusMeta = contractorStatusMeta(contractor.contractor_status);
              const contractorCategories = contractorCategoryList(contractor);
              return (
                <div
                  key={contractor.id}
                  onClick={(event) => {
                    const target = event.target as HTMLElement;
                    if (target.closest('button,a,input,textarea,select,label')) return;
                    openContractorDetails(contractor.id);
                  }}
                  className="rounded-2xl overflow-hidden cursor-pointer transition-transform hover:-translate-y-0.5"
                  style={{ background: 'white', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}
                  title="Click to view contractor details"
                >
                  <div className="p-5">
                    <div className="flex flex-col lg:flex-row lg:items-start gap-4">
                      <div className="flex items-start gap-3 flex-1 min-w-0">
                        <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white text-sm font-black flex-shrink-0" style={{ background: 'linear-gradient(135deg, #1F2937, #D99D26)' }}>
                          {initials(contractor.name)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="text-base font-black text-gray-900 truncate">{contractor.name}</h2>
                            <span
                              className="inline-flex px-2.5 py-1 rounded-full text-xs font-black"
                              style={{ background: statusMeta.background, color: statusMeta.color, border: `1px solid ${statusMeta.border}` }}
                            >
                              {statusMeta.label}
                            </span>
                            {contractorCategories.length > 0 ? (
                              contractorCategories.map(item => (
                                <span key={item} className="inline-flex px-2.5 py-1 rounded-full text-xs font-black" style={{ background: '#FEF3C7', color: '#92400E' }}>
                                  {item}
                                </span>
                              ))
                            ) : (
                              <span className="inline-flex px-2.5 py-1 rounded-full text-xs font-black bg-gray-100 text-gray-500">
                                Uncategorized
                              </span>
                            )}
                            {setupComplete ? (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-black bg-emerald-50 text-emerald-700 border border-emerald-100">
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                Contractor Completed Setup
                              </span>
                            ) : setupPending ? (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-black bg-blue-50 text-blue-700 border border-blue-100">
                                <Clock3 className="w-3.5 h-3.5" />
                                Setup sent
                              </span>
                            ) : null}
                            {contractorInfoCollected && (
                              <button
                                type="button"
                                onClick={() => view1099Information(contractor)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-black bg-emerald-50 text-emerald-800 border border-emerald-200 transition hover:bg-emerald-100 hover:border-emerald-300"
                                title="View 1099 information"
                              >
                                <FileText className="w-3.5 h-3.5" />
                                1099 Info Collected
                              </button>
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
                            {contractor.tax_id_last4 && (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-100">
                                <FileText className="w-3.5 h-3.5" /> Tax ****{contractor.tax_id_last4}
                              </span>
                            )}
                            {contractor.bank_account_last4 && (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-100">
                                <ShieldCheck className="w-3.5 h-3.5" /> ACH ****{contractor.bank_account_last4}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-col items-start lg:items-end gap-2">
                        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                          <button
                            type="button"
                            onClick={() => requestContractorSetup(contractor)}
                            disabled={setupSending}
                            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-black shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-50 disabled:shadow-none"
                            style={{
                              background: setupComplete ? '#ECFDF5' : setupPending ? '#EFF6FF' : '#FFFBEB',
                              color: setupComplete ? '#047857' : setupPending ? '#1D4ED8' : '#92400E',
                              border: setupComplete ? '1px solid #A7F3D0' : setupPending ? '1px solid #BFDBFE' : '1px solid #FDE68A',
                            }}
                            title="Click to email the secure contractor information intake link"
                            aria-label={`Request contractor information from ${contractor.name}`}
                          >
                            <SetupIcon className="w-3.5 h-3.5" />
                            {setupButtonLabel(contractor, setupSending)}
                          </button>
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
                        {setupLinks[contractor.id]?.url && (
                          <div className="w-full lg:w-[26rem] rounded-xl border border-blue-100 bg-blue-50 px-3 py-2">
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-[11px] font-black uppercase tracking-wide text-blue-700">Contractor information link</p>
                                <a
                                  href={setupLinks[contractor.id].url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="block text-xs font-semibold text-blue-900 truncate underline"
                                >
                                  {setupLinks[contractor.id].url}
                                </a>
                                {setupLinks[contractor.id].expires_at && (
                                  <p className="text-[11px] text-blue-600">Expires {formatDate(setupLinks[contractor.id].expires_at)}</p>
                                )}
                              </div>
                              <div className="flex items-center gap-1 flex-shrink-0">
                                <a
                                  href={setupLinks[contractor.id].url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="h-8 w-8 rounded-lg bg-white border border-blue-100 text-blue-700 flex items-center justify-center hover:bg-blue-100"
                                  title="Open contractor information link"
                                  aria-label="Open contractor information link"
                                >
                                  <ExternalLink className="w-4 h-4" />
                                </a>
                                <button
                                  type="button"
                                  onClick={() => {
                                    navigator.clipboard?.writeText(setupLinks[contractor.id].url);
                                    toast.success('Contractor link copied');
                                  }}
                                  className="h-8 w-8 rounded-lg bg-white border border-blue-100 text-blue-700 flex items-center justify-center hover:bg-blue-100"
                                  title="Copy contractor information link"
                                  aria-label="Copy contractor information link"
                                >
                                  <Copy className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
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

                      <div className="lg:col-span-3 rounded-xl border border-gray-100 p-4 bg-white hover:border-amber-200 hover:bg-amber-50/20 transition-colors">
                        <div className="flex items-center justify-between gap-2 mb-3">
                          <div className="flex items-center gap-2">
                            <MessageSquare className="w-4 h-4 text-gray-400" />
                            <p className="text-xs font-black uppercase tracking-wide text-gray-500">Notes</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-black text-gray-400">{contractor.note_count || 0}</span>
                            <span className="text-[11px] font-black text-amber-700">View details</span>
                          </div>
                        </div>
                        {(contractor.latest_notes || []).length > 0 ? (
                          <div className="space-y-2">
                            {(contractor.latest_notes || []).slice(0, 2).map((note, index) => (
                              <div key={`${note.created_at}-${index}`} className="rounded-lg bg-gray-50 border border-gray-100 px-2.5 py-2 hover:bg-white">
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
                        <div className="mt-3 flex items-end gap-2" onClick={(event) => event.stopPropagation()}>
                          <textarea
                            value={noteInputs[contractor.id] || ''}
                            onChange={(event) => setNoteInputs(prev => ({ ...prev, [contractor.id]: event.target.value }))}
                            rows={2}
                            placeholder="Add note"
                            className="flex-1 min-h-16 resize-none px-3 py-2 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                          <button
                            type="button"
                            onClick={() => addContractorNote(contractor.id)}
                            disabled={savingNotes[contractor.id] || !(noteInputs[contractor.id] || '').trim()}
                            className="h-10 w-10 rounded-xl flex items-center justify-center text-white disabled:opacity-50 flex-shrink-0"
                            style={{ background: '#2563EB' }}
                            title="Add note"
                            aria-label="Add contractor note"
                          >
                            <Send className="w-4 h-4" />
                          </button>
                        </div>
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
                          <div className="rounded-lg bg-gray-50 border border-gray-100 p-2">
                            <p className="text-xs text-gray-400">Contractor setup</p>
                            <p className="text-xs font-black text-gray-900">
                              {setupComplete
                                ? `Complete ${formatDate(contractor.onboarding_submitted_at)}`
                                : setupPending
                                  ? `Sent ${formatDate(contractor.onboarding_last_sent_at)}`
                                  : 'Not sent'}
                            </p>
                            {contractor.bank_name && contractor.bank_account_last4 ? (
                              <p className="text-[11px] text-gray-500 truncate">{contractor.bank_name} ending {contractor.bank_account_last4}</p>
                            ) : null}
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
                                    <span className="text-xs text-gray-400 whitespace-nowrap">{formatEasternDateTime(note.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET</span>
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

      {selectedContractor && (() => {
        const contractor = selectedContractor;
        const connectedProjects = contractor.connected_projects || [];
        const contractorCategories = contractorCategoryList(contractor);
        const statusMeta = contractorStatusMeta(contractor.contractor_status);
        const setupComplete = isSetupComplete(contractor);
        const setupPending = isSetupPending(contractor);
        const contractorInfoCollected = hasContractorInformationCollected(contractor);
        const lastPaid = contractor.last_paid_invoice;
        const lastInvoice = contractor.last_invoice;
        const notes = contractorNotes[contractor.id] || [];
        const previewNotes = contractor.latest_notes || [];
        const setupShareEmail = setupShareEmails[contractor.id] ?? contractor.email ?? '';
        const setupShareSave = setupShareSaveEmail[contractor.id] ?? !contractor.email;
        const latestSetupLink = setupLinks[contractor.id];
        const full1099Details = sensitive1099Details[contractor.id];
        const full1099Visible = Boolean(visible1099Details[contractor.id] && full1099Details);
        const loadingFull1099 = loading1099DetailsId === contractor.id;

        return (
          <Modal
            isOpen={!!selectedContractor}
            onClose={() => setSelectedContractorId(null)}
            title="Contractor Details"
            size="xl"
          >
            <div className="space-y-5">
              <div className="rounded-2xl bg-gray-950 p-5 text-white">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="flex min-w-0 items-start gap-4">
                    <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl text-base font-black text-white" style={{ background: 'linear-gradient(135deg, #1F2937, #D99D26)' }}>
                      {initials(contractor.name)}
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-black uppercase tracking-[0.16em] text-amber-300">Contractor profile</p>
                      <h2 className="mt-1 break-words text-2xl font-black leading-tight">{contractor.name}</h2>
                      {contractor.contact_name ? <p className="mt-1 text-sm font-semibold text-gray-300">Contact: {contractor.contact_name}</p> : null}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <span
                          className="inline-flex rounded-full px-2.5 py-1 text-xs font-black"
                          style={{ background: statusMeta.background, color: statusMeta.color, border: `1px solid ${statusMeta.border}` }}
                        >
                          {statusMeta.label}
                        </span>
                        {contractorCategories.length > 0 ? contractorCategories.map(item => (
                          <span key={item} className="inline-flex rounded-full bg-amber-100 px-2.5 py-1 text-xs font-black text-amber-800">
                            {item}
                          </span>
                        )) : (
                          <span className="inline-flex rounded-full bg-gray-800 px-2.5 py-1 text-xs font-black text-gray-300">Uncategorized</span>
                        )}
                        {contractorInfoCollected ? (
                          <button
                            type="button"
                            onClick={() => view1099Information(contractor)}
                            className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-black text-emerald-800 transition hover:bg-emerald-200"
                            title="View 1099 information"
                          >
                            <FileText className="h-3.5 w-3.5" />
                            1099 Info Collected
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 md:justify-end">
                    {contractorInfoCollected ? (
                      <button
                        type="button"
                        onClick={() => view1099Information(contractor)}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-100 px-3 py-2 text-xs font-black text-emerald-800 hover:bg-emerald-200"
                      >
                        <FileText className="h-3.5 w-3.5" />
                        View 1099 Information
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        openEdit(contractor);
                        setSelectedContractorId(null);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-xs font-black text-gray-950 hover:bg-gray-100"
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => requestContractorSetup(contractor)}
                      disabled={requestingSetupId === contractor.id}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-amber-400 px-3 py-2 text-xs font-black text-gray-950 hover:bg-amber-300 disabled:opacity-60"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      {setupButtonLabel(contractor, requestingSetupId === contractor.id)}
                    </button>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-amber-700" />
                      <h3 className="text-sm font-black text-gray-950">Secure 1099 Setup Link</h3>
                    </div>
                    <p className="text-xs font-semibold leading-5 text-amber-900">
                      Send the secure contractor setup link to any email address. The contractor verifies by email code, enters their own email in the form, and BuildTrack assigns their mobile PIN after submission.
                    </p>
                    {latestSetupLink?.url ? (
                      <div className="mt-3 rounded-xl border border-amber-200 bg-white px-3 py-2">
                        <p className="text-[11px] font-black uppercase tracking-wide text-amber-700">Latest generated link</p>
                        <div className="mt-1 flex items-center gap-2">
                          <a href={latestSetupLink.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-xs font-bold text-gray-950 underline">
                            {latestSetupLink.url}
                          </a>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard?.writeText(latestSetupLink.url);
                              toast.success('Contractor setup link copied');
                            }}
                            className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100"
                            title="Copy setup link"
                          >
                            <Copy className="h-4 w-4" />
                          </button>
                        </div>
                        {latestSetupLink.expires_at ? <p className="mt-1 text-[11px] font-semibold text-amber-700">Expires {formatDate(latestSetupLink.expires_at)}</p> : null}
                      </div>
                    ) : null}
                  </div>
                  <div className="w-full lg:w-[23rem]">
                    <label className="mb-1 block text-[11px] font-black uppercase tracking-wide text-amber-800">Recipient email</label>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input
                        type="email"
                        value={setupShareEmail}
                        onChange={event => setSetupShareEmails(prev => ({ ...prev, [contractor.id]: event.target.value }))}
                        placeholder="contractor@email.com"
                        className="min-w-0 flex-1 rounded-xl border border-amber-200 bg-white px-3 py-2.5 text-sm font-bold text-gray-950 outline-none focus:border-amber-500"
                      />
                      <button
                        type="button"
                        onClick={() => shareContractorSetup(contractor)}
                        disabled={requestingSetupId === contractor.id}
                        className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-gray-950 px-4 py-2.5 text-xs font-black text-white hover:bg-gray-800 disabled:opacity-60"
                      >
                        <Send className="h-3.5 w-3.5" />
                        {requestingSetupId === contractor.id ? 'Sending...' : 'Send Link'}
                      </button>
                    </div>
                    <label className="mt-2 flex items-center gap-2 text-xs font-bold text-amber-900">
                      <input
                        type="checkbox"
                        checked={setupShareSave}
                        onChange={event => setSetupShareSaveEmail(prev => ({ ...prev, [contractor.id]: event.target.checked }))}
                        className="h-4 w-4 rounded border-amber-300 text-amber-600"
                      />
                      Save this as the contractor email and mobile login email
                    </label>
                  </div>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-3">
                <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <Phone className="h-4 w-4 text-gray-400" />
                    <h3 className="text-sm font-black text-gray-900">Contact Information</h3>
                  </div>
                  <div className="space-y-3">
                    {detailLine('Contractor name', contractor.name)}
                    {detailLine('Contact person', contractor.contact_name)}
                    {detailLine('Phone', contractor.phone)}
                    {detailLine('Email', contractor.email)}
                    {detailLine('Account number', contractor.account_number)}
                  </div>
                </div>

                <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-gray-400" />
                    <h3 className="text-sm font-black text-gray-900">Business Profile</h3>
                  </div>
                  <div className="space-y-3">
                    {detailLine('Company', contractor.company)}
                    {detailLine('Categories', contractorCategories.length ? contractorCategories.join(', ') : null)}
                    {detailLine('Status', statusMeta.label)}
                    {detailLine('Source', contractor.source)}
                    {detailLine('Created', formatDate(contractor.created_at))}
                    {detailLine('Updated', formatDate(contractor.updated_at))}
                  </div>
                </div>

                <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-gray-400" />
                    <h3 className="text-sm font-black text-gray-900">Address</h3>
                  </div>
                  <div className="space-y-3">
                    {detailLine('Billing address', contractor.billing_address, 'min-h-[9rem]')}
                  </div>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div
                  id={`contractor-1099-info-${contractor.id}`}
                  className={`rounded-2xl border bg-gray-50 p-4 scroll-mt-6 transition-all ${
                    focused1099ContractorId === contractor.id
                      ? 'border-emerald-300 ring-4 ring-emerald-100'
                      : 'border-gray-200'
                  }`}
                >
                  <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-gray-400" />
                      <h3 className="text-sm font-black text-gray-900">Contractor Setup And 1099 Information</h3>
                    </div>
                    {contractorInfoCollected ? (
                      <button
                        type="button"
                        onClick={() => toggleSensitive1099Details(contractor)}
                        disabled={loadingFull1099 || !canReveal1099Details}
                        className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-white px-3 py-2 text-xs font-black text-emerald-800 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-55"
                        title={canReveal1099Details ? 'Reveal full encrypted 1099 and ACH details' : 'Only authorized management users can reveal full details'}
                        aria-label={full1099Visible ? 'Hide full 1099 information' : 'Show full 1099 information'}
                      >
                        {full1099Visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        {loadingFull1099 ? 'Loading...' : full1099Visible ? 'Hide Full Details' : 'Show Full Details'}
                      </button>
                    ) : null}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {detailLine('Setup status', setupComplete ? 'Submitted' : setupPending ? 'Sent / pending' : 'Not sent')}
                    {detailLine('Setup last sent', formatDate(contractor.onboarding_last_sent_at))}
                    {detailLine('Setup expires', formatDate(contractor.onboarding_expires_at))}
                    {detailLine('Submitted', formatDate(contractor.onboarding_submitted_at))}
                    {detailLine('Tax ID', contractor.tax_id_last4 ? `Ending ${contractor.tax_id_last4}` : null)}
                    {detailLine('Bank name', contractor.bank_name)}
                    {detailLine('ACH account', contractor.bank_account_last4 ? `Ending ${contractor.bank_account_last4}` : null)}
                    {detailLine('Routing number', contractor.routing_last4 ? `Ending ${contractor.routing_last4}` : null)}
                  </div>
                  {full1099Visible && full1099Details ? (
                    <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className="text-xs font-black uppercase tracking-[0.12em] text-emerald-800">Full 1099 and ACH details</p>
                          <p className="mt-1 text-xs font-semibold leading-5 text-emerald-900">
                            Sensitive fields are revealed for banking entry. Viewing this panel is logged in BuildTrack.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => copySensitive1099Details(full1099Details)}
                          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-gray-950 px-3 py-2 text-xs font-black text-white transition hover:bg-gray-800"
                        >
                          <Copy className="h-3.5 w-3.5" />
                          Copy Details
                        </button>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {detailLine('Legal name', full1099Details.legal_name)}
                        {detailLine('Business name', full1099Details.business_name)}
                        {detailLine('Tax classification', full1099Details.tax_classification)}
                        {detailLine('Tax ID type', full1099Details.tax_id_type?.toUpperCase())}
                        {detailLine('Full Tax ID', full1099Details.tax_id)}
                        {detailLine('Email', full1099Details.email)}
                        {detailLine('Phone', full1099Details.phone)}
                        {detailLine('Mailing address', full1099Details.mailing_address, 'sm:col-span-2')}
                        {detailLine('Bank name', full1099Details.bank_name)}
                        {detailLine('Account type', full1099Details.account_type)}
                        {detailLine('Full ACH account number', full1099Details.account_number)}
                        {detailLine('Full routing number', full1099Details.routing_number)}
                        {detailLine('W-9 certified', full1099Details.w9_certified)}
                        {detailLine('ACH authorized', full1099Details.ach_authorized)}
                        {detailLine('Insurance provider', full1099Details.insurance_provider)}
                        {detailLine('Insurance policy number', full1099Details.insurance_policy_number)}
                        {detailLine('Insurance expires', formatDate(full1099Details.insurance_expires_at))}
                        {detailLine('License number', full1099Details.license_number)}
                        {detailLine('License state', full1099Details.license_state)}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <FileText className="h-4 w-4 text-gray-400" />
                    <h3 className="text-sm font-black text-gray-900">Payment And Invoice Summary</h3>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {detailLine('Total paid', money(contractor.total_paid))}
                    {detailLine('Invoice count', contractor.invoice_count)}
                    {detailLine('Last paid amount', lastPaid ? money(lastPaid.total) : null)}
                    {detailLine('Last paid date', formatDate(lastPaid?.updated_at))}
                    {detailLine('Last paid project', lastPaid?.address)}
                    {detailLine('Last invoice number', lastInvoice?.invoice_number)}
                    {detailLine('Last invoice status', lastInvoice?.status)}
                    {detailLine('Last invoice date', formatDate(lastInvoice?.updated_at || lastInvoice?.created_at))}
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <LinkIcon className="h-4 w-4 text-gray-400" />
                    <h3 className="text-sm font-black text-gray-900">Assigned Projects</h3>
                  </div>
                  <span className="rounded-full bg-white px-2.5 py-1 text-xs font-black text-gray-500">{connectedProjects.length}</span>
                </div>
                {connectedProjects.length > 0 ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    {connectedProjects.map((project, index) => (
                      <button
                        key={`${project.id || project.address}-${index}`}
                        type="button"
                        onClick={() => project.id ? navigate(`/projects/${project.id}`) : undefined}
                        className="rounded-xl border border-gray-100 bg-white px-4 py-3 text-left transition hover:border-blue-200 hover:bg-blue-50"
                      >
                        <p className="text-sm font-black text-gray-900">{project.address}</p>
                        <p className="mt-1 text-xs font-semibold text-gray-500">{project.job_name || 'No job name'}</p>
                        <p className="mt-2 text-[11px] font-black uppercase tracking-wide text-blue-700">{project.status || 'Status not set'}</p>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-gray-200 bg-white p-5 text-sm font-semibold text-gray-400">
                    No assigned projects on this contractor record.
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4 text-gray-400" />
                    <h3 className="text-sm font-black text-gray-900">Contractor Notes</h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => openNotes(contractor.id)}
                    className="rounded-xl bg-white px-3 py-2 text-xs font-black text-amber-700 hover:bg-amber-50"
                  >
                    Open notes on card
                  </button>
                </div>
                {loadingNotes[contractor.id] ? (
                  <p className="rounded-xl border border-gray-100 bg-white p-4 text-sm font-semibold text-gray-400">Loading notes...</p>
                ) : notes.length > 0 ? (
                  <div className="space-y-3">
                    {notes.map(note => (
                      <div key={note.id} className="rounded-xl border border-gray-100 bg-white p-4">
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <p className="text-sm font-black text-gray-900">{note.user_name}</p>
                          <p className="text-xs font-semibold text-gray-400">{formatEasternDateTime(note.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET</p>
                        </div>
                        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-gray-700">{note.note}</p>
                      </div>
                    ))}
                  </div>
                ) : previewNotes.length > 0 ? (
                  <div className="space-y-3">
                    {previewNotes.map((note, index) => (
                      <div key={`${note.created_at}-${index}`} className="rounded-xl border border-gray-100 bg-white p-4">
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <p className="text-sm font-black text-gray-900">{note.user_name}</p>
                          <p className="text-xs font-semibold text-gray-400">{formatEasternDateTime(note.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET</p>
                        </div>
                        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-gray-700">{note.note}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-xl border border-gray-100 bg-white p-4 text-sm font-semibold text-gray-400">No contractor notes yet.</p>
                )}
              </div>
            </div>
          </Modal>
        );
      })()}

      <Modal isOpen={addingContractor} onClose={() => setAddingContractor(false)} title="Add Contractor" size="lg">
        <div className="space-y-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Contractor Name *</label>
              <input value={addForm.vendor_name} onChange={e => setAddForm(prev => ({ ...prev, vendor_name: e.target.value }))} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Contact Name</label>
              <input value={addForm.contact_name} onChange={e => setAddForm(prev => ({ ...prev, contact_name: e.target.value }))} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select
                value={addForm.contractor_status}
                onChange={e => setAddForm(prev => ({ ...prev, contractor_status: e.target.value }))}
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              >
                <option value="active">Active</option>
                <option value="will_use_again">Will use again</option>
                <option value="terminated">Terminated</option>
              </select>
            </div>
            {renderCategorySelector(addForm, 'add')}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
              <input value={addForm.phone} onChange={e => setAddForm(prev => ({ ...prev, phone: e.target.value }))} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input value={addForm.email} onChange={e => setAddForm(prev => ({ ...prev, email: e.target.value }))} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Account Number</label>
              <input value={addForm.account_number} onChange={e => setAddForm(prev => ({ ...prev, account_number: e.target.value }))} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Billing Address</label>
              <textarea value={addForm.billing_address} onChange={e => setAddForm(prev => ({ ...prev, billing_address: e.target.value }))} rows={2} className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 p-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
              <div>
                <p className="text-sm font-black text-gray-900">Connected Projects</p>
                <p className="text-xs text-gray-500">Optional project links for this contractor.</p>
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
              {filteredProjectOptions.length === 0 && <p className="text-sm text-gray-400 px-1">No projects match this filter</p>}
            </div>
          </div>

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={() => setAddingContractor(false)} className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="button" onClick={saveAdd} disabled={savingAdd} className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">
              {savingAdd ? 'Adding...' : 'Add Contractor'}
            </button>
          </div>
        </div>
      </Modal>

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
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select
                value={editForm.contractor_status}
                onChange={e => setEditForm(prev => ({ ...prev, contractor_status: e.target.value }))}
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              >
                <option value="active">Active</option>
                <option value="will_use_again">Will use again</option>
                <option value="terminated">Terminated</option>
              </select>
            </div>
            {renderCategorySelector(editForm, 'edit')}
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
