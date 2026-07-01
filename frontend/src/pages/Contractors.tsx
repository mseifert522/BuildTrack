import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building2,
  ChevronDown,
  CheckCircle2,
  Clock3,
  Copy,
  Edit2,
  Eye,
  EyeOff,
  ExternalLink,
  FileText,
  Link as LinkIcon,
  MapPin,
  MessageSquare,
  PackageCheck,
  Phone,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { Loading, Modal } from '../components/ui';
import Avatar from '../components/Avatar';
import { useAuthStore } from '../store/authStore';
import { formatEasternDate, formatEasternDateTime, parseBuildTrackTimestamp } from '../lib/time';
import VoiceTextarea from '../components/VoiceTextarea';

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

interface QuickBooksVendorInfo {
  id?: string | null;
  display_name?: string | null;
  company_name?: string | null;
  print_on_check_name?: string | null;
  primary_email?: string | null;
  primary_phone?: string | null;
  billing_address?: string | null;
  account_number?: string | null;
  vendor_1099?: boolean | number | null;
  tax_identifier_last4?: string | null;
  balance?: number | null;
  active?: boolean | number | null;
  synced_at?: string | null;
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
  quickbooks_vendor_id?: string | null;
  quickbooks_display_name?: string | null;
  quickbooks_company_name?: string | null;
  quickbooks_print_on_check_name?: string | null;
  quickbooks_primary_email?: string | null;
  quickbooks_primary_phone?: string | null;
  quickbooks_bill_addr?: string | null;
  quickbooks_account_number?: string | null;
  quickbooks_vendor_1099?: boolean | number | null;
  quickbooks_tax_identifier_last4?: string | null;
  quickbooks_balance?: number | null;
  quickbooks_active?: boolean | number | null;
  quickbooks_synced_at?: string | null;
  quickbooks_vendor?: QuickBooksVendorInfo | null;
  contractor_status?: 'active' | 'terminated' | 'will_use_again' | string | null;
  contractor_category?: string | null;
  contractor_secondary_category?: string | null;
  contractor_categories?: string[] | null;
  created_at?: string | null;
  updated_at?: string | null;
  source?: string | null;
  is_supplier?: boolean | number | null;
  supplier_marked_at?: string | null;
  supplier_marked_by?: string | null;
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
  id?: string;
  note: string;
  user_name: string;
  user_avatar_url?: string | null;
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

const supplierCategoryDefaults = [
  'General Building Materials',
  'Lumber',
  'Roofing Materials',
  'Electrical Supplies',
  'Plumbing Supplies',
  'HVAC Supplies',
  'Drywall',
  'Flooring',
  'Paint',
  'Appliances',
  'Portable Toilets',
  'Tool Rentals',
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

const contractorAddressLine = (value?: string | null) => {
  const address = (value || '').replace(/\s+/g, ' ').trim();
  return address || 'No address on file';
};

const quickBooksVendorInfo = (contractor: ContractorRow): QuickBooksVendorInfo | null =>
  contractor.quickbooks_vendor || (contractor.quickbooks_vendor_id ? {
    id: contractor.quickbooks_vendor_id,
    display_name: contractor.quickbooks_display_name,
    company_name: contractor.quickbooks_company_name,
    print_on_check_name: contractor.quickbooks_print_on_check_name,
    primary_email: contractor.quickbooks_primary_email,
    primary_phone: contractor.quickbooks_primary_phone,
    billing_address: contractor.quickbooks_bill_addr,
    account_number: contractor.quickbooks_account_number,
    vendor_1099: contractor.quickbooks_vendor_1099,
    tax_identifier_last4: contractor.quickbooks_tax_identifier_last4,
    balance: contractor.quickbooks_balance,
    active: contractor.quickbooks_active,
    synced_at: contractor.quickbooks_synced_at,
  } : null);

const contractorVendorAddress = (contractor: ContractorRow) =>
  contractor.billing_address || quickBooksVendorInfo(contractor)?.billing_address || contractor.quickbooks_bill_addr || null;

const contractorVendorPhone = (contractor: ContractorRow) =>
  contractor.phone || quickBooksVendorInfo(contractor)?.primary_phone || contractor.quickbooks_primary_phone || null;

const contractorVendorEmail = (contractor: ContractorRow) =>
  contractor.email || quickBooksVendorInfo(contractor)?.primary_email || contractor.quickbooks_primary_email || null;

const contractorVendorAccountNumber = (contractor: ContractorRow) =>
  contractor.account_number || quickBooksVendorInfo(contractor)?.account_number || contractor.quickbooks_account_number || null;

const quickBooksBoolean = (value?: boolean | number | null) =>
  value === true || Number(value || 0) === 1;

const directoryAddressLine = (contractor: ContractorRow) => {
  const value = contractorVendorAddress(contractor);
  const address = (value || '').replace(/\s+/g, ' ').trim();
  return address || 'No address listed';
};

const directoryContactLine = (contractor: ContractorRow) =>
  (contractor.contact_name || contractor.company || quickBooksVendorInfo(contractor)?.company_name || '').trim() || 'No contact person';

const directoryPhoneLine = (contractor: ContractorRow) =>
  (contractorVendorPhone(contractor) || '').trim() || 'No phone listed';

const uniqueTextList = (values: Array<string | null | undefined>) => {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach(value => {
    const name = String(value || '').replace(/\s+/g, ' ').trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(name);
  });
  return result;
};

const normalizeDirectoryValue = (value?: string | null) =>
  String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '').trim();

const supplierFlag = (contractor: ContractorRow) => Boolean(Number(contractor.is_supplier || 0));

const supplierOnlyRecord = (contractor: ContractorRow) =>
  supplierFlag(contractor)
  && String(contractor.source || '').toLowerCase() === 'manual_supplier'
  && !contractor.connected_project_count
  && !contractor.invoice_count;

const directoryRecordLabel = (contractor: ContractorRow) => {
  if (supplierOnlyRecord(contractor)) return 'Supplier record';
  if (supplierFlag(contractor)) return 'Contractor / Supplier record';
  return 'Contractor record';
};

const directoryIdentityKeys = (contractor: ContractorRow) => {
  const name = normalizeDirectoryValue(contractor.vendor_name || contractor.name);
  const email = normalizeDirectoryValue(contractor.email);
  const phone = normalizeDirectoryValue(contractor.phone);
  const address = normalizeDirectoryValue(contractor.billing_address);
  const account = normalizeDirectoryValue(contractor.account_number);
  const keys = [
    contractor.id ? `id:${contractor.id}` : '',
    email ? `email:${email}` : '',
    phone && name ? `phone-name:${phone}:${name}` : '',
    account && name ? `account-name:${account}:${name}` : '',
    address && name ? `address-name:${address}:${name}` : '',
    name ? `name:${name}` : '',
  ].filter(Boolean);
  return keys.length ? keys : [`row:${contractor.id || contractor.source || contractor.created_at || contractor.updated_at || 'unknown'}`];
};

const directoryRowScore = (contractor: ContractorRow) => [
  contractor.name,
  contractor.vendor_name,
  contractor.contact_name,
  contractor.email,
  contractor.phone,
  contractor.company,
  contractor.billing_address,
  contractor.account_number,
  contractor.contractor_status,
  contractor.onboarding_status,
  contractor.bank_name,
].filter(Boolean).length
  + (contractor.contractor_categories?.length || 0)
  + (contractor.connected_projects?.length || 0)
  + (contractor.project_addresses?.length || 0)
  + Number(Boolean(contractor.total_paid))
  + Number(Boolean(contractor.invoice_count))
  + Number(Boolean(contractor.note_count));

const newerInvoice = (a?: ContractorInvoice | null, b?: ContractorInvoice | null) =>
  dateValue(b?.updated_at || b?.created_at) > dateValue(a?.updated_at || a?.created_at) ? b : a;

const mergeDirectoryRows = (current: ContractorRow, incoming: ContractorRow): ContractorRow => {
  const primary = directoryRowScore(incoming) > directoryRowScore(current) ? incoming : current;
  const secondary = primary === incoming ? current : incoming;
  const connectedProjects = [...(primary.connected_projects || []), ...(secondary.connected_projects || [])]
    .filter((project, index, list) => {
      const key = `${project.id || ''}|${project.address || ''}`.toLowerCase();
      return key.trim() && list.findIndex(item => `${item.id || ''}|${item.address || ''}`.toLowerCase() === key) === index;
    });

  return {
    ...secondary,
    ...primary,
    is_supplier: supplierFlag(current) || supplierFlag(incoming),
    contractor_categories: uniqueTextList([
      ...(current.contractor_categories || []),
      ...(incoming.contractor_categories || []),
      current.contractor_category,
      incoming.contractor_category,
      current.contractor_secondary_category,
      incoming.contractor_secondary_category,
    ]),
    project_addresses: uniqueTextList([
      ...(current.project_addresses || []),
      ...(incoming.project_addresses || []),
    ]),
    connected_projects: connectedProjects,
    connected_project_count: Math.max(
      Number(current.connected_project_count || 0),
      Number(incoming.connected_project_count || 0),
      connectedProjects.length
    ),
    invoice_count: Math.max(Number(current.invoice_count || 0), Number(incoming.invoice_count || 0)),
    total_paid: Math.max(Number(current.total_paid || 0), Number(incoming.total_paid || 0)),
    note_count: Math.max(Number(current.note_count || 0), Number(incoming.note_count || 0)),
    last_paid_invoice: newerInvoice(current.last_paid_invoice, incoming.last_paid_invoice),
    last_invoice: newerInvoice(current.last_invoice, incoming.last_invoice),
  };
};

const dedupeDirectoryRows = (rows: ContractorRow[]) => {
  const result: ContractorRow[] = [];
  const keyToIndex = new Map<string, number>();

  rows.forEach(row => {
    const keys = directoryIdentityKeys(row);
    const existingIndex = keys
      .map(key => keyToIndex.get(key))
      .find((index): index is number => typeof index === 'number');

    if (existingIndex === undefined) {
      const index = result.length;
      result.push(row);
      keys.forEach(key => keyToIndex.set(key, index));
      return;
    }

    result[existingIndex] = mergeDirectoryRows(result[existingIndex], row);
    directoryIdentityKeys(result[existingIndex]).forEach(key => keyToIndex.set(key, existingIndex));
  });

  return result;
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
  ]).filter(item => item.toLowerCase() !== 'supplier');

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

const emptySupplierForm = {
  name: '',
  contact: '',
  email: '',
  phone: '',
  billing_address: '',
  account_number: '',
  categories: [] as string[],
};

export default function Contractors() {
  const navigate = useNavigate();
  const { user: currentUser } = useAuthStore();
  const [contractors, setContractors] = useState<ContractorRow[]>([]);
  const [categories, setCategories] = useState<string[]>(fallbackCategories);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<'name_asc' | 'name_desc' | 'date_newest' | 'date_oldest'>('name_asc');
  const [expandedContractorId, setExpandedContractorId] = useState<string | null>(null);
  const [contractorNotes, setContractorNotes] = useState<Record<string, ContractorNote[]>>({});
  const [noteInputs, setNoteInputs] = useState<Record<string, string>>({});
  const [noteEntryOpen, setNoteEntryOpen] = useState<Record<string, boolean>>({});
  const [loadingNotes, setLoadingNotes] = useState<Record<string, boolean>>({});
  const [savingNotes, setSavingNotes] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [choosingVendorType, setChoosingVendorType] = useState(false);
  const [addingContractor, setAddingContractor] = useState(false);
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [addForm, setAddForm] = useState(emptyContractorForm);
  const [supplierForm, setSupplierForm] = useState(emptySupplierForm);
  const [editingContractor, setEditingContractor] = useState<ContractorRow | null>(null);
  const [editForm, setEditForm] = useState(emptyContractorForm);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [projectFilter, setProjectFilter] = useState('');
  const [savingAdd, setSavingAdd] = useState(false);
  const [savingSupplier, setSavingSupplier] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingContractorId, setDeletingContractorId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [deletingContractorNoteId, setDeletingContractorNoteId] = useState<string | null>(null);
  const [requestingSetupId, setRequestingSetupId] = useState<string | null>(null);
  const [setupLinks, setSetupLinks] = useState<Record<string, { url: string; expires_at?: string }>>({});
  const [setupShareEmails, setSetupShareEmails] = useState<Record<string, string>>({});
  const [setupShareSaveEmail, setSetupShareSaveEmail] = useState<Record<string, boolean>>({});
  const [selectedContractorId, setSelectedContractorId] = useState<string | null>(null);
  const [focused1099ContractorId, setFocused1099ContractorId] = useState<string | null>(null);
  const [sensitive1099Details, setSensitive1099Details] = useState<Record<string, Sensitive1099Details>>({});
  const [visible1099Details, setVisible1099Details] = useState<Record<string, boolean>>({});
  const [loading1099DetailsId, setLoading1099DetailsId] = useState<string | null>(null);
  const canManageVendors = currentUser ? ['super_admin', 'operations_manager'].includes(currentUser.role) : false;
  const canAddCategories = canManageVendors;
  const canReveal1099Details = canManageVendors;
  const canDeleteNotes = canManageVendors;
  const canDeleteContractors = canManageVendors;

  const loadDirectory = async () => {
    const [directoryRes, projectsRes] = await Promise.all([
      api.get('/users/contractors/directory'),
      api.get('/projects'),
    ]);
    setContractors(Array.isArray(directoryRes.data?.contractors) ? directoryRes.data.contractors : []);
    setCategories(Array.isArray(directoryRes.data?.categories) ? directoryRes.data.categories : fallbackCategories);
    setProjects(Array.isArray(projectsRes.data) ? projectsRes.data : []);
  };

  const combinedDirectoryRows = useMemo(() => dedupeDirectoryRows(contractors), [contractors]);

  const supplierCategoryOptions = useMemo(
    () => uniqueCategoryList([...supplierCategoryDefaults, ...categories]),
    [categories]
  );

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

  const openContractorNoteEntry = (contractorId: string) => {
    setNoteEntryOpen(prev => ({ ...prev, [contractorId]: true }));
    if (!contractorNotes[contractorId]) {
      loadContractorNotes(contractorId).catch(() => {});
    }
  };

  const closeContractorNoteEntry = (contractorId: string) => {
    setNoteEntryOpen(prev => ({ ...prev, [contractorId]: false }));
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
      closeContractorNoteEntry(contractorId);
      setContractors(prev => prev.map(contractor => contractor.id === contractorId
        ? {
            ...contractor,
            note_count: Number(contractor.note_count || 0) + 1,
            latest_note_at: res.data.created_at,
            latest_notes: [{ id: res.data.id, note: res.data.note, user_name: res.data.user_name, user_avatar_url: res.data.user_avatar_url || null, created_at: res.data.created_at }, ...(contractor.latest_notes || [])].slice(0, 2),
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
    if (!canDeleteNotes || deletingContractorNoteId) return;
    if (!window.confirm('Delete this contractor/supplier note?')) return;
    setDeletingContractorNoteId(noteId);
    try {
      await api.delete(`/users/contractors/${contractorId}/notes/${noteId}`);
      setContractorNotes(prev => ({
        ...prev,
        [contractorId]: (prev[contractorId] || []).filter(note => note.id !== noteId),
      }));
      setContractors(prev => prev.map(contractor => contractor.id === contractorId
        ? {
            ...contractor,
            note_count: Math.max(Number(contractor.note_count || 1) - 1, 0),
            latest_notes: (contractor.latest_notes || []).filter(note => note.id !== noteId),
          }
        : contractor
      ));
      toast.success('Note deleted');
    } catch {
      toast.error('Failed to delete note');
    } finally {
      setDeletingContractorNoteId(null);
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

  const openAddSupplier = () => {
    setSupplierForm({
      ...emptySupplierForm,
      categories: ['General Building Materials'],
    });
    setAddingSupplier(true);
  };

  const chooseVendorType = (type: 'contractor' | 'supplier') => {
    setChoosingVendorType(false);
    if (type === 'contractor') {
      openAdd();
      return;
    }
    openAddSupplier();
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

  const setSupplierCategorySelection = (categoryName: string, selected: boolean) => {
    setSupplierForm(prev => {
      const nextCategories = selected
        ? uniqueCategoryList([...(prev.categories || []), categoryName])
        : (prev.categories || []).filter(item => item !== categoryName);
      return { ...prev, categories: nextCategories };
    });
  };

  const renderSupplierCategorySelector = () => (
    <div className="sm:col-span-2">
      <div className="mb-2 flex items-center justify-between gap-3">
        <label className="block text-sm font-bold text-gray-700">Supplier Categories</label>
        <span className="rounded-full bg-white px-2.5 py-1 text-xs font-black text-blue-700 ring-1 ring-blue-100">
          {supplierForm.categories.length} selected
        </span>
      </div>
      <div className="grid max-h-48 gap-2 overflow-y-auto rounded-xl border border-gray-200 bg-gray-50 p-3 sm:grid-cols-2 lg:grid-cols-3">
        {supplierCategoryOptions.map(item => {
          const selected = supplierForm.categories.includes(item);
          return (
            <label
              key={item}
              className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors"
              style={{
                background: selected ? '#EFF6FF' : '#FFFFFF',
                borderColor: selected ? '#93C5FD' : '#E5E7EB',
                color: selected ? '#1D4ED8' : '#374151',
              }}
            >
              <input
                type="checkbox"
                checked={selected}
                onChange={event => setSupplierCategorySelection(item, event.target.checked)}
              />
              <span className="truncate">{item}</span>
            </label>
          );
        })}
      </div>
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

  const closeSupplierModal = () => {
    setAddingSupplier(false);
    setSupplierForm(emptySupplierForm);
  };

  const saveSupplier = async () => {
    if (!supplierForm.name.trim()) {
      toast.error('Supplier name is required');
      return;
    }

    setSavingSupplier(true);
    try {
      const categoriesForPayload = supplierForm.categories.length
        ? supplierForm.categories
        : ['General Building Materials'];
      await api.post('/users/suppliers', {
        name: supplierForm.name.trim(),
        contact: supplierForm.contact.trim(),
        email: supplierForm.email.trim(),
        phone: supplierForm.phone.trim(),
        billing_address: supplierForm.billing_address.trim(),
        account_number: supplierForm.account_number.trim(),
        categories: categoriesForPayload,
      });
      await loadDirectory();
      toast.success('Supplier added');
      closeSupplierModal();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to add supplier');
    } finally {
      setSavingSupplier(false);
    }
  };

  const deleteContractor = async (contractor: ContractorRow) => {
    if (!canDeleteContractors || deletingContractorId) return;
    const confirmed = window.confirm(`Delete ${contractor.name} from the combined directory? Notes and project links for this record will also be removed.`);
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
    const normalizedQ = normalizeDirectoryValue(q);

    const rows = combinedDirectoryRows.filter((contractor) => {
      const contractorCategories = contractorCategoryList(contractor);
      const lastPaid = contractor.last_paid_invoice;
      const lastInvoice = contractor.last_invoice;

      if (q) {
        const haystack = [
          contractor.name,
          contractor.vendor_name,
          contractor.contact_name,
          contractor.email,
          contractor.phone,
          contractor.company,
          contractor.billing_address,
          contractor.account_number,
          contractor.contractor_status,
          contractor.source,
          contractor.onboarding_status,
          contractor.bank_name,
          contractor.tax_id_last4,
          contractor.bank_account_last4,
          contractor.routing_last4,
          contractor.connected_project_count,
          contractor.invoice_count,
          contractor.total_paid,
          directoryRecordLabel(contractor),
          ...contractorCategories,
          ...(contractor.latest_notes || []).flatMap(note => [note.note, note.user_name, note.created_at]),
          ...(contractor.project_addresses || []),
          ...(contractor.connected_projects || []).flatMap(project => [project.address, project.job_name, project.status]),
          lastPaid?.invoice_number,
          lastPaid?.address,
          lastPaid?.job_name,
          lastPaid?.status,
          lastPaid?.total,
          lastInvoice?.invoice_number,
          lastInvoice?.address,
          lastInvoice?.job_name,
          lastInvoice?.status,
          lastInvoice?.total,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(q) && (!normalizedQ || !normalizeDirectoryValue(haystack).includes(normalizedQ))) return false;
      }

      return true;
    });

    const sorted = [...rows];
    switch (sortMode) {
      case 'name_asc':
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'name_desc':
        sorted.sort((a, b) => b.name.localeCompare(a.name));
        break;
      case 'date_oldest':
        sorted.sort((a, b) =>
          (dateValue(a.created_at) - dateValue(b.created_at))
          || (dateValue(a.updated_at) - dateValue(b.updated_at))
          || a.name.localeCompare(b.name)
        );
        break;
      case 'date_newest':
      default:
        sorted.sort((a, b) =>
          (dateValue(b.created_at) - dateValue(a.created_at))
          || (dateValue(b.updated_at) - dateValue(a.updated_at))
          || a.name.localeCompare(b.name)
        );
        break;
    }
    return sorted;
  }, [combinedDirectoryRows, query, sortMode]);

  // Keep the multi-select selection scoped to what is currently visible, so a
  // search/filter change can never leave hidden rows silently selected for deletion.
  useEffect(() => {
    setSelectedIds(prev => {
      if (prev.size === 0) return prev;
      const visible = new Set(filteredContractors.map(c => c.id));
      let changed = false;
      const next = new Set<string>();
      prev.forEach(id => { if (visible.has(id)) next.add(id); else changed = true; });
      return changed ? next : prev;
    });
  }, [filteredContractors]);

  const allVisibleSelected = filteredContractors.length > 0 && filteredContractors.every(c => selectedIds.has(c.id));

  const toggleSelectContractor = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    setSelectedIds(prev => {
      if (filteredContractors.length > 0 && filteredContractors.every(c => prev.has(c.id))) return new Set();
      return new Set(filteredContractors.map(c => c.id));
    });
  };

  const bulkDeleteContractors = async () => {
    if (!canDeleteContractors || bulkDeleting) return;
    const ids = filteredContractors.filter(c => selectedIds.has(c.id)).map(c => c.id);
    if (ids.length === 0) return;
    const confirmed = window.confirm(
      `Delete ${ids.length} selected record${ids.length === 1 ? '' : 's'} from the directory? ` +
      `Notes and project links for these records will also be removed. ` +
      `QuickBooks-linked vendors will be blocked from re-importing so they stay deleted.`
    );
    if (!confirmed) return;

    setBulkDeleting(true);
    try {
      const res = await api.post('/users/contractors/bulk-delete', { ids });
      const deletedIds: string[] = res.data?.deleted_ids || ids;
      const deletedSet = new Set(deletedIds);
      setContractors(prev => prev.filter(item => !deletedSet.has(item.id)));
      setSelectedIds(new Set());
      if (expandedContractorId && deletedSet.has(expandedContractorId)) setExpandedContractorId(null);
      if (selectedContractorId && deletedSet.has(selectedContractorId)) setSelectedContractorId(null);
      toast.success(res.data?.message || `Deleted ${deletedIds.length} record${deletedIds.length === 1 ? '' : 's'}`);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to delete selected records');
    } finally {
      setBulkDeleting(false);
    }
  };

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
    <div className={`rounded-xl border border-white/10 bg-slate-900/55 px-4 py-3 shadow-sm ${className}`}>
      <p className="text-[11px] font-black uppercase tracking-wide" style={{ color: '#9BA9BA' }}>{label}</p>
      <p className="mt-1 break-words text-sm font-bold leading-5 whitespace-pre-wrap" style={{ color: '#F8FAFC' }}>{detailValue(value)}</p>
    </div>
  );

  if (loading) return <Loading />;

  return (
    <div className="bt-desktop-page bt-directory-page bt-contractors-page bt-suppliers-page min-h-full px-6 py-6 md:px-8">
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="bt-directory-hero flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="bt-directory-title-block">
            <h1 className="text-2xl font-black tracking-tight">Contractors / Suppliers</h1>
          </div>
          <div className="bt-directory-actions flex w-full flex-col gap-2 sm:flex-row xl:w-auto">
            <button
              type="button"
              onClick={() => setChoosingVendorType(true)}
              className="bt-directory-primary-action"
            >
              <Plus className="w-4 h-4" />
              Add Vendor
            </button>
            <div className="bt-directory-search-stack flex w-full flex-col gap-1 sm:w-[420px]">
              <div
                className="bt-directory-search flex min-h-11 w-full items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 shadow-sm"
              >
                <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Search contractors and suppliers"
                  className="w-full bg-transparent text-sm outline-none text-gray-900 placeholder:text-gray-500"
                />
              </div>
              <p className="bt-directory-record-count" aria-live="polite">
                {filteredContractors.length} Records
              </p>
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
            <p className="text-sm font-bold text-gray-500">No contractor or supplier records match this search</p>
          </div>
        ) : (
          <div className="bt-table-wrap bt-directory-list p-2">
            <div className="bt-directory-sortbar mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5">
              <label htmlFor="vendor-sort" className="text-xs font-black uppercase tracking-wide text-slate-600">Sort by</label>
              <select
                id="vendor-sort"
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as typeof sortMode)}
                className="min-h-9 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-gray-900 shadow-sm outline-none focus:border-blue-400"
              >
                <option value="name_asc">Name (A-Z)</option>
                <option value="name_desc">Name (Z-A)</option>
                <option value="date_newest">Date entered - Newest first</option>
                <option value="date_oldest">Date entered - Oldest first</option>
              </select>
              <span className="text-xs font-semibold text-slate-400">{filteredContractors.length} records</span>
            </div>
            {canDeleteContractors && (
              <div className="bt-directory-bulkbar mb-2 flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5">
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-black uppercase tracking-wide text-slate-600">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAllVisible}
                    disabled={bulkDeleting || filteredContractors.length === 0}
                    style={{ accentColor: '#2563eb' }}
                    className="h-4 w-4 cursor-pointer rounded border-slate-400"
                    aria-label="Select all vendors"
                  />
                  Select all ({filteredContractors.length})
                </label>
                {selectedIds.size > 0 ? (
                  <>
                    <span className="text-xs font-black text-blue-700">{selectedIds.size} selected</span>
                    <button
                      type="button"
                      onClick={bulkDeleteContractors}
                      disabled={bulkDeleting}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-red-500 bg-red-600 px-3 py-2 text-xs font-black text-white shadow-sm transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {bulkDeleting ? 'Deleting...' : `Delete selected (${selectedIds.size})`}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedIds(new Set())}
                      disabled={bulkDeleting}
                      className="inline-flex min-h-9 items-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-black text-slate-600 shadow-sm transition hover:bg-slate-100 disabled:opacity-60"
                    >
                      Clear
                    </button>
                  </>
                ) : (
                  <span className="text-xs font-semibold text-slate-400">Check vendors to delete several at once</span>
                )}
              </div>
            )}
            <div className={`bt-directory-list-header hidden rounded-lg border border-slate-200 bg-slate-50 py-3 text-xs font-black uppercase tracking-wide text-slate-500 xl:grid xl:grid-cols-[minmax(210px,1.1fr)_minmax(220px,1fr)_minmax(260px,1.25fr)_minmax(190px,0.9fr)_minmax(160px,0.75fr)_80px] xl:gap-4 ${canDeleteContractors ? 'pl-12 pr-4' : 'px-4'}`}>
              <span>Name</span>
              <span>Category</span>
              <span>Address</span>
              <span>Contact Person</span>
              <span>Phone Number</span>
              <span className="text-right">{canDeleteContractors ? 'Actions' : 'Open'}</span>
            </div>
            <div className="mt-2 space-y-2">
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
              const isExpanded = expandedContractorId === contractor.id;
              const qboVendor = quickBooksVendorInfo(contractor);
              const addressLine = directoryAddressLine(contractor);
              const contactLine = directoryContactLine(contractor);
              const phoneLine = directoryPhoneLine(contractor);
              const recordLabel = directoryRecordLabel(contractor);
              return (
                <div
                  key={contractor.id}
                  className={`bt-directory-card relative overflow-hidden rounded-lg border border-l-4 transition-colors ${isExpanded ? 'is-expanded border-blue-300 border-l-blue-600 bg-blue-50 ring-1 ring-blue-100' : 'border-slate-200 border-l-slate-400 bg-white hover:border-blue-200 hover:bg-slate-50'}`}
                >
                  <div>
                    {canDeleteContractors && (
                      <div
                        className="absolute left-3 top-4 z-20 flex items-center xl:top-1/2 xl:-translate-y-1/2"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={selectedIds.has(contractor.id)}
                          onChange={() => toggleSelectContractor(contractor.id)}
                          disabled={bulkDeleting}
                          style={{ accentColor: '#2563eb' }}
                          className="h-4 w-4 cursor-pointer rounded border-slate-400"
                          aria-label={`Select ${contractor.name}`}
                          title={`Select ${contractor.name}`}
                        />
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setExpandedContractorId(current => current === contractor.id ? null : contractor.id)}
                      aria-expanded={isExpanded}
                      aria-controls={`contractor-directory-details-${contractor.id}`}
                      className={`bt-directory-row grid w-full cursor-pointer grid-cols-1 gap-3 py-4 text-left xl:grid-cols-[minmax(210px,1.1fr)_minmax(220px,1fr)_minmax(260px,1.25fr)_minmax(190px,0.9fr)_minmax(160px,0.75fr)_80px] xl:items-center xl:gap-4 ${canDeleteContractors ? 'pl-12 pr-32 sm:pr-36 xl:pr-40' : 'px-4'}`}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="bt-directory-avatar flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xs font-black text-slate-700 ring-1 ring-slate-200">
                          {initials(contractor.name)}
                        </div>
                        <div className="min-w-0">
                          <h2 className="truncate text-sm font-black text-gray-950">{contractor.name}</h2>
                          <p className="mt-1 text-xs font-semibold text-gray-500">{recordLabel}</p>
                          {qboVendor?.id ? (
                            <p className="mt-1 truncate text-[11px] font-black text-emerald-700">QuickBooks vendor linked</p>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        {contractorCategories.length > 0 ? (
                          <>
                            {contractorCategories.slice(0, 2).map(item => (
                              <span key={item} className="bt-directory-chip inline-flex max-w-full items-center gap-1.5 truncate rounded px-2.5 py-1 text-xs font-black text-blue-100 ring-1 ring-blue-400/40" title={item}>
                                <PackageCheck className="h-3.5 w-3.5 flex-shrink-0" />
                                <span className="truncate">{item}</span>
                              </span>
                            ))}
                            {contractorCategories.length > 2 ? (
                              <span className="bt-directory-chip inline-flex rounded px-2.5 py-1 text-xs font-black text-blue-100 ring-1 ring-blue-400/40">
                                +{contractorCategories.length - 2}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span className="bt-directory-chip inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-black text-blue-100 ring-1 ring-blue-400/40">
                            <PackageCheck className="h-3.5 w-3.5" />
                            Uncategorized
                          </span>
                        )}
                      </div>
                      <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-gray-600">
                        <MapPin className="h-4 w-4 flex-shrink-0 text-gray-400" />
                        <span className="truncate">{addressLine}</span>
                      </div>
                      <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-gray-600">
                        <UserRound className="h-4 w-4 flex-shrink-0 text-gray-400" />
                        <span className="truncate">{contactLine}</span>
                      </div>
                      <div className="flex min-w-0 items-center gap-2 text-sm font-bold text-gray-700">
                        <Phone className="h-4 w-4 flex-shrink-0 text-gray-400" />
                        <span className="truncate">{phoneLine}</span>
                      </div>
                      <div className="bt-directory-row-action flex items-center justify-end gap-2 text-xs font-black text-blue-700">
                        <span>{isExpanded ? 'Hide details' : 'View details'}</span>
                        <ChevronDown className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                      </div>
                    </button>
                    {canDeleteContractors && (
                      <button
                        type="button"
                        onClick={() => deleteContractor(contractor)}
                        disabled={Boolean(deletingContractorId)}
                        className="absolute right-3 top-3 z-10 inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-red-400/40 bg-red-500/15 px-3 py-2 text-xs font-black text-red-300 shadow-sm transition hover:bg-red-500/30 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-60"
                        title={`Delete ${contractor.name}`}
                        aria-label={`Delete ${contractor.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {deletingContractorId === contractor.id ? 'Deleting...' : 'Delete'}
                      </button>
                    )}

                    {noteEntryOpen[contractor.id] && (
                      <div
                        className="border-t border-white/10 px-4 py-4 md:px-5"
                        style={{ background: 'rgba(13, 18, 24, 0.6)' }}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div className="rounded-2xl border border-white/10 bg-slate-900/50 p-4 shadow-sm">
                          <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                              <p className="text-xs font-black uppercase tracking-wide text-amber-700">New Directory Note</p>
                              <p className="text-sm font-black text-gray-950">{contractor.name}</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => closeContractorNoteEntry(contractor.id)}
                              className="inline-flex items-center justify-center rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-black text-gray-600 hover:bg-gray-50"
                            >
                              Cancel
                            </button>
                          </div>
                          <div className="flex flex-col gap-3 md:flex-row md:items-end">
                            <VoiceTextarea
                              value={noteInputs[contractor.id] || ''}
                              onChange={(event) => setNoteInputs(prev => ({ ...prev, [contractor.id]: event.target.value }))}
                              rows={3}
                              placeholder={`Enter a note about ${contractor.name}`}
                              wrapperClassName="flex-1"
                              className="min-h-24 w-full resize-none rounded-xl border border-white/15 bg-slate-900/55 px-3.5 py-3 text-sm font-semibold text-slate-100 placeholder:text-slate-400 outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/30"
                            />
                            <button
                              type="button"
                              onClick={() => addContractorNote(contractor.id)}
                              disabled={savingNotes[contractor.id] || !(noteInputs[contractor.id] || '').trim()}
                              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-600 bg-gradient-to-br from-slate-800 via-slate-950 to-blue-950 px-4 py-2.5 text-sm font-black text-slate-100 shadow-sm transition-all duration-150 hover:border-cyan-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <Send className="h-4 w-4" />
                              Save Note
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    {isExpanded && (
                      <div id={`contractor-directory-details-${contractor.id}`} className="bt-directory-expanded border-t border-slate-200 bg-slate-50 px-4 py-4 md:px-5">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className="inline-flex px-2.5 py-1 rounded-full text-xs font-black"
                              style={{ background: statusMeta.background, color: statusMeta.color, border: `1px solid ${statusMeta.border}` }}
                            >
                              {statusMeta.label}
                            </span>
                            {contractorCategories.length > 0 ? (
                              contractorCategories.map(item => (
                                <span key={item} className="inline-flex px-2.5 py-1 rounded-full text-xs font-black bg-slate-100 text-slate-700">
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
                          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                            <button
                              type="button"
                              onClick={() => openContractorDetails(contractor.id)}
                              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-black bg-white text-gray-700 border border-gray-200 hover:bg-gray-50 transition-colors"
                            >
                              View full profile
                            </button>
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
                              onClick={() => openNotes(contractor.id)}
                              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-black transition-colors"
                              style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #FDE68A' }}
                            >
                              <MessageSquare className="w-3.5 h-3.5" />
                              {contractor.note_count || 0} notes
                            </button>
                            {canDeleteContractors && (
                              <button
                                type="button"
                                onClick={() => deleteContractor(contractor)}
                                disabled={Boolean(deletingContractorId)}
                                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-black transition-colors disabled:opacity-50"
                                style={{ background: '#FEF2F2', color: '#B91C1C', border: '1px solid #FECACA' }}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                {deletingContractorId === contractor.id ? 'Deleting...' : 'Delete'}
                              </button>
                            )}
                          </div>
                        </div>
                        {setupLinks[contractor.id]?.url && (
                          <div className="mt-3 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2">
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

                    <div className="mt-5 grid gap-4 lg:grid-cols-3">
                      <div className="rounded-xl border border-slate-300 bg-white p-4 shadow-sm lg:col-span-2">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <FileText className="h-4 w-4 text-emerald-600" />
                            <p className="text-xs font-black uppercase tracking-wide text-gray-500">QuickBooks Vendor Record</p>
                          </div>
                          {qboVendor?.id ? (
                            <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-black text-emerald-700 ring-1 ring-emerald-100">
                              Synced
                            </span>
                          ) : (
                            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-black text-slate-500">
                              Not linked
                            </span>
                          )}
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          {detailLine('QuickBooks vendor name', qboVendor?.display_name || contractor.quickbooks_display_name)}
                          {detailLine('Company name', qboVendor?.company_name || contractor.quickbooks_company_name)}
                          {detailLine('Print on check as', qboVendor?.print_on_check_name || contractor.quickbooks_print_on_check_name)}
                          {detailLine('QuickBooks vendor ID', qboVendor?.id || contractor.quickbooks_vendor_id)}
                          {detailLine('QuickBooks phone', qboVendor?.primary_phone || contractor.quickbooks_primary_phone)}
                          {detailLine('QuickBooks email', qboVendor?.primary_email || contractor.quickbooks_primary_email)}
                          {detailLine('QuickBooks account number', qboVendor?.account_number || contractor.quickbooks_account_number)}
                          {detailLine('QuickBooks balance', qboVendor?.balance !== null && qboVendor?.balance !== undefined ? money(Number(qboVendor.balance)) : contractor.quickbooks_balance !== null && contractor.quickbooks_balance !== undefined ? money(Number(contractor.quickbooks_balance)) : null)}
                        </div>
                      </div>
                      <div className="rounded-xl border border-slate-300 bg-white p-4 shadow-sm">
                        <div className="mb-3 flex items-center gap-2">
                          <ShieldCheck className="h-4 w-4 text-emerald-600" />
                          <p className="text-xs font-black uppercase tracking-wide text-gray-500">1099 Status</p>
                        </div>
                        <div className="space-y-3">
                          {detailLine('QuickBooks 1099 vendor', quickBooksBoolean(qboVendor?.vendor_1099 ?? contractor.quickbooks_vendor_1099) ? 'Yes' : 'No')}
                          {detailLine('QuickBooks Tax ID', (qboVendor?.tax_identifier_last4 || contractor.quickbooks_tax_identifier_last4) ? `Ending ${qboVendor?.tax_identifier_last4 || contractor.quickbooks_tax_identifier_last4}` : null)}
                          {detailLine('Contractor setup tax ID', contractor.tax_id_last4 ? `Ending ${contractor.tax_id_last4}` : null)}
                          {detailLine('Vendor active in QuickBooks', quickBooksBoolean(qboVendor?.active ?? contractor.quickbooks_active ?? 1) ? 'Yes' : 'No')}
                        </div>
                      </div>
                    </div>

                    <div className="grid lg:grid-cols-12 gap-4 mt-5">
                      <div className="lg:col-span-3 rounded-xl border border-slate-300 p-4 bg-slate-100 shadow-sm">
                        <div className="flex items-center gap-2 mb-2">
                          <Building2 className="w-4 h-4 text-gray-400" />
                          <p className="text-xs font-black uppercase tracking-wide text-gray-500">Billing Address</p>
                        </div>
                        <p className="text-sm text-gray-800 whitespace-pre-wrap">{contractorVendorAddress(contractor) || 'No billing address on file'}</p>
                      </div>

                      <div className="lg:col-span-3 rounded-xl border border-slate-300 bg-slate-50 p-4 shadow-sm">
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
                                style={{ background: 'rgba(30, 58, 95, 0.5)', color: '#BFDBFE', border: '1px solid rgba(96, 165, 250, 0.35)' }}
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

                      <div className="lg:col-span-3 rounded-xl border border-slate-300 bg-slate-50 p-4 shadow-sm transition-colors hover:border-amber-300 hover:bg-amber-50/40">
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
                              <div key={`${note.created_at}-${index}`} className="rounded-lg bg-white border border-slate-200 px-2.5 py-2 hover:border-amber-200">
                                <div className="mb-1.5 flex items-center justify-between gap-2">
                                  <div className="flex min-w-0 items-center gap-2">
                                    <Avatar src={note.user_avatar_url} name={note.user_name} size={24} roundedClassName="rounded-full" />
                                    <p className="truncate text-[11px] font-black text-gray-700">{note.user_name}</p>
                                  </div>
                                  {canDeleteNotes && note.id ? (
                                    <button
                                      type="button"
                                      onClick={event => {
                                        event.stopPropagation();
                                        deleteContractorNote(contractor.id, note.id!);
                                      }}
                                      disabled={deletingContractorNoteId === note.id}
                                      className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-black text-red-500 transition hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                                      title="Delete note"
                                    >
                                      <Trash2 className="h-3 w-3" />
                                      {deletingContractorNoteId === note.id ? 'Deleting' : 'Delete'}
                                    </button>
                                  ) : null}
                                </div>
                                <p
                                  className="text-xs font-semibold text-gray-700"
                                  style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                                >
                                  {note.note}
                                </p>
                                <p className="text-[11px] text-gray-400 mt-1 truncate">
                                  {note.user_name} · Inserted {formatEasternDateTime(note.created_at, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} ET
                                </p>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-gray-400">No notes yet</p>
                        )}
                        <div className="mt-3 flex items-end gap-2" onClick={(event) => event.stopPropagation()}>
                          <VoiceTextarea
                            value={noteInputs[contractor.id] || ''}
                            onChange={(event) => setNoteInputs(prev => ({ ...prev, [contractor.id]: event.target.value }))}
                            rows={2}
                            placeholder="Add note"
                            wrapperClassName="flex-1"
                            className="min-h-16 w-full resize-none px-3 py-2 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                          <button
                            type="button"
                            onClick={() => addContractorNote(contractor.id)}
                            disabled={savingNotes[contractor.id] || !(noteInputs[contractor.id] || '').trim()}
                            className="h-10 w-10 rounded-xl flex items-center justify-center text-white disabled:opacity-50 flex-shrink-0"
                            style={{ background: 'linear-gradient(135deg, #334155, #0f172a)', border: '1px solid #475569' }}
                            title="Add note"
                            aria-label="Add contractor note"
                          >
                            <Send className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      <div className="lg:col-span-3 rounded-xl border border-slate-300 bg-slate-50 p-4 shadow-sm">
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
                          <div className="rounded-lg bg-white border border-slate-200 p-2">
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
                    )}

                  {expandedContractorId === contractor.id && (
                    <div className="border-t border-white/10 p-5" style={{ background: 'rgba(13, 18, 24, 0.6)' }}>
                      <div className="rounded-2xl border border-slate-300 bg-white p-4">
                        <div className="flex items-center justify-between gap-3 mb-3">
                          <div>
                            <p className="text-sm font-black text-gray-900">Directory Notes</p>
                            <p className="text-xs text-gray-500">Internal notes for this directory record</p>
                          </div>
                        </div>
                        <div className="flex flex-col md:flex-row gap-3">
                          <VoiceTextarea
                            value={noteInputs[contractor.id] || ''}
                            onChange={(event) => setNoteInputs(prev => ({ ...prev, [contractor.id]: event.target.value }))}
                            rows={2}
                            placeholder={`Add a note about ${contractor.name}`}
                            wrapperClassName="flex-1"
                            className="w-full px-3.5 py-2.5 rounded-xl border border-white/15 bg-slate-900/55 text-sm text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 resize-none"
                          />
                          <button
                            type="button"
                            onClick={() => addContractorNote(contractor.id)}
                            disabled={savingNotes[contractor.id] || !(noteInputs[contractor.id] || '').trim()}
                            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-black text-white disabled:opacity-50"
                            style={{ background: 'linear-gradient(135deg, #334155, #0f172a)', border: '1px solid #475569' }}
                          >
                            <Send className="w-4 h-4" />
                            Add Note
                          </button>
                        </div>

                        <div className="mt-4 space-y-3">
                          {loadingNotes[contractor.id] ? (
                            <p className="text-sm text-gray-400">Loading notes...</p>
                          ) : (contractorNotes[contractor.id] || []).length === 0 ? (
                            <p className="text-sm text-gray-400">No notes yet</p>
                          ) : (contractorNotes[contractor.id] || []).map((note) => (
                            <div key={note.id} className="flex items-start gap-3 rounded-xl border border-gray-100 p-3">
                              <Avatar src={note.user_avatar_url} name={note.user_name} size={36} />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="text-sm font-black text-gray-900">{note.user_name}</p>
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs text-gray-400 whitespace-nowrap">{formatEasternDateTime(note.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET</span>
                                    {canDeleteNotes && (
                                      <button
                                        type="button"
                                        onClick={() => deleteContractorNote(contractor.id, note.id)}
                                        disabled={deletingContractorNoteId === note.id}
                                        className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-black text-red-500 transition hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                                        title="Delete note"
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                        {deletingContractorNoteId === note.id ? 'Deleting' : 'Delete'}
                                      </button>
                                    )}
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
                </div>
              );
            })}
          </div>
          </div>
        )}
      </div>

      <Modal isOpen={choosingVendorType} onClose={() => setChoosingVendorType(false)} title="Add Vendor" size="sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => chooseVendorType('contractor')}
            className="rounded-xl border border-slate-300 bg-white px-4 py-4 text-sm font-black text-slate-900 shadow-sm hover:border-blue-400 hover:bg-blue-50"
          >
            Contractor
          </button>
          <button
            type="button"
            onClick={() => chooseVendorType('supplier')}
            className="rounded-xl border border-slate-300 bg-white px-4 py-4 text-sm font-black text-slate-900 shadow-sm hover:border-blue-400 hover:bg-blue-50"
          >
            Supplier
          </button>
        </div>
      </Modal>

      <Modal isOpen={addingSupplier} onClose={closeSupplierModal} title="Add Supplier" size="lg">
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm font-bold text-gray-700">Supplier Name *</label>
              <input
                value={supplierForm.name}
                onChange={event => setSupplierForm(prev => ({ ...prev, name: event.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-bold text-gray-700">Contact Person</label>
              <input
                value={supplierForm.contact}
                onChange={event => setSupplierForm(prev => ({ ...prev, contact: event.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-bold text-gray-700">Phone</label>
              <input
                value={supplierForm.phone}
                onChange={event => setSupplierForm(prev => ({ ...prev, phone: event.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-bold text-gray-700">Email</label>
              <input
                value={supplierForm.email}
                onChange={event => setSupplierForm(prev => ({ ...prev, email: event.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-bold text-gray-700">Account Number</label>
              <input
                value={supplierForm.account_number}
                onChange={event => setSupplierForm(prev => ({ ...prev, account_number: event.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm font-bold text-gray-700">Address</label>
              <textarea
                value={supplierForm.billing_address}
                onChange={event => setSupplierForm(prev => ({ ...prev, billing_address: event.target.value }))}
                rows={3}
                className="w-full resize-none rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            {renderSupplierCategorySelector()}
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={closeSupplierModal}
              className="flex-1 rounded-xl border border-gray-300 py-2.5 text-sm font-bold text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveSupplier}
              disabled={savingSupplier}
              className="flex-1 rounded-xl bg-blue-600 py-2.5 text-sm font-black text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {savingSupplier ? 'Saving...' : 'Add Supplier'}
            </button>
          </div>
        </div>
      </Modal>

      {selectedContractor && (() => {
        const contractor = selectedContractor;
        const connectedProjects = contractor.connected_projects || [];
        const contractorCategories = contractorCategoryList(contractor);
        const qboVendor = quickBooksVendorInfo(contractor);
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
            title="Vendor / Contractor Details"
            size="xl"
          >
            <div className="space-y-5">
              <div className="rounded-lg border border-slate-200 bg-white p-5">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="flex min-w-0 items-start gap-4">
                    <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-lg bg-slate-100 text-base font-black text-slate-700 ring-1 ring-slate-200">
                      {initials(contractor.name)}
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Vendor profile</p>
                      <h2 className="mt-1 break-words text-2xl font-black leading-tight text-slate-950">{contractor.name}</h2>
                      {contractor.contact_name ? <p className="mt-1 text-sm font-semibold text-slate-500">Contact: {contractor.contact_name}</p> : null}
                      {qboVendor?.display_name ? <p className="mt-1 text-sm font-semibold text-emerald-700">QuickBooks: {qboVendor.display_name}</p> : null}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <span
                          className="inline-flex rounded-full px-2.5 py-1 text-xs font-black"
                          style={{ background: statusMeta.background, color: statusMeta.color, border: `1px solid ${statusMeta.border}` }}
                        >
                          {statusMeta.label}
                        </span>
                        {contractorCategories.length > 0 ? contractorCategories.map(item => (
                          <span key={item} className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-black text-slate-700">
                            {item}
                          </span>
                        )) : (
                          <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-black text-slate-600">Uncategorized</span>
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
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-black text-slate-700 hover:bg-slate-50"
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => requestContractorSetup(contractor)}
                      disabled={requestingSetupId === contractor.id}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-black text-white hover:bg-blue-700 disabled:opacity-60"
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
                    {detailLine('Phone', contractorVendorPhone(contractor))}
                    {detailLine('Email', contractorVendorEmail(contractor))}
                    {detailLine('Account number', contractorVendorAccountNumber(contractor))}
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
                    {detailLine('QuickBooks linked', qboVendor?.id ? 'Yes' : 'No')}
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
                    {detailLine('Billing address', contractorVendorAddress(contractor), 'min-h-[9rem]')}
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4">
                <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-emerald-700" />
                    <h3 className="text-sm font-black text-gray-900">QuickBooks Vendor Information</h3>
                  </div>
                  <span className="inline-flex w-fit rounded-full bg-white px-2.5 py-1 text-xs font-black text-emerald-800 ring-1 ring-emerald-200">
                    {qboVendor?.id ? 'Synced from QuickBooks' : 'No QuickBooks vendor linked'}
                  </span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {detailLine('Vendor ID', qboVendor?.id || contractor.quickbooks_vendor_id)}
                  {detailLine('Display name', qboVendor?.display_name || contractor.quickbooks_display_name)}
                  {detailLine('Company name', qboVendor?.company_name || contractor.quickbooks_company_name)}
                  {detailLine('Print on check', qboVendor?.print_on_check_name || contractor.quickbooks_print_on_check_name)}
                  {detailLine('Phone', qboVendor?.primary_phone || contractor.quickbooks_primary_phone)}
                  {detailLine('Email', qboVendor?.primary_email || contractor.quickbooks_primary_email)}
                  {detailLine('Account number', qboVendor?.account_number || contractor.quickbooks_account_number)}
                  {detailLine('Current balance', qboVendor?.balance !== null && qboVendor?.balance !== undefined ? money(Number(qboVendor.balance)) : contractor.quickbooks_balance !== null && contractor.quickbooks_balance !== undefined ? money(Number(contractor.quickbooks_balance)) : null)}
                  {detailLine('1099 vendor', quickBooksBoolean(qboVendor?.vendor_1099 ?? contractor.quickbooks_vendor_1099) ? 'Yes' : 'No')}
                  {detailLine('Tax ID', (qboVendor?.tax_identifier_last4 || contractor.quickbooks_tax_identifier_last4) ? `Ending ${qboVendor?.tax_identifier_last4 || contractor.quickbooks_tax_identifier_last4}` : null)}
                  {detailLine('Active', quickBooksBoolean(qboVendor?.active ?? contractor.quickbooks_active ?? 1) ? 'Yes' : 'No')}
                  {detailLine('Last synced', formatDate(qboVendor?.synced_at || contractor.quickbooks_synced_at))}
                  {detailLine('QuickBooks billing address', qboVendor?.billing_address || contractor.quickbooks_bill_addr, 'sm:col-span-2 lg:col-span-4')}
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
                    No assigned projects on this record.
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4 text-gray-400" />
                    <h3 className="text-sm font-black text-gray-900">Directory Notes</h3>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => openContractorNoteEntry(contractor.id)}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-black text-amber-800 shadow-sm hover:bg-amber-100"
                    >
                      <MessageSquare className="h-3.5 w-3.5" />
                      Enter Note
                    </button>
                    <button
                      type="button"
                      onClick={() => openNotes(contractor.id)}
                      className="rounded-xl bg-white px-3 py-2 text-xs font-black text-amber-700 hover:bg-amber-50"
                    >
                      Open notes on card
                    </button>
                  </div>
                </div>
                {noteEntryOpen[contractor.id] ? (
                  <div className="mb-4 rounded-2xl border border-amber-200 bg-white p-4 shadow-sm">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-black uppercase tracking-wide text-amber-700">New Directory Note</p>
                        <p className="text-sm font-bold text-gray-500">Type or use the microphone to add this note.</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => closeContractorNoteEntry(contractor.id)}
                        className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-black text-gray-600 hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    </div>
                    <div className="flex flex-col gap-3 md:flex-row md:items-end">
                      <VoiceTextarea
                        value={noteInputs[contractor.id] || ''}
                        onChange={(event) => setNoteInputs(prev => ({ ...prev, [contractor.id]: event.target.value }))}
                        rows={3}
                        placeholder={`Enter a note about ${contractor.name}`}
                        wrapperClassName="flex-1"
                        className="min-h-24 w-full resize-none rounded-xl border border-amber-200 bg-amber-50/40 px-3.5 py-3 text-sm font-semibold text-gray-950 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
                      />
                      <button
                        type="button"
                        onClick={() => addContractorNote(contractor.id)}
                        disabled={savingNotes[contractor.id] || !(noteInputs[contractor.id] || '').trim()}
                        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-black text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Send className="h-4 w-4" />
                        Save Note
                      </button>
                    </div>
                  </div>
                ) : null}
                {loadingNotes[contractor.id] ? (
                  <p className="rounded-xl border border-gray-100 bg-white p-4 text-sm font-semibold text-gray-400">Loading notes...</p>
                ) : notes.length > 0 ? (
                  <div className="space-y-3">
                    {notes.map(note => (
                      <div key={note.id} className="rounded-xl border border-gray-100 bg-white p-4">
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-2">
                            <Avatar src={note.user_avatar_url} name={note.user_name} size={32} roundedClassName="rounded-full" />
                            <p className="truncate text-sm font-black text-gray-900">{note.user_name}</p>
                          </div>
                          <div className="flex flex-shrink-0 items-center gap-2">
                            <p className="text-xs font-semibold text-gray-400">{formatEasternDateTime(note.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET</p>
                            {canDeleteNotes && (
                              <button
                                type="button"
                                onClick={() => deleteContractorNote(contractor.id, note.id)}
                                disabled={deletingContractorNoteId === note.id}
                                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-black text-red-500 transition hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                                title="Delete note"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                {deletingContractorNoteId === note.id ? 'Deleting' : 'Delete'}
                              </button>
                            )}
                          </div>
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
                          <div className="flex min-w-0 items-center gap-2">
                            <Avatar src={note.user_avatar_url} name={note.user_name} size={32} roundedClassName="rounded-full" />
                            <p className="truncate text-sm font-black text-gray-900">{note.user_name}</p>
                          </div>
                          <div className="flex flex-shrink-0 items-center gap-2">
                            <p className="text-xs font-semibold text-gray-400">{formatEasternDateTime(note.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET</p>
                            {canDeleteNotes && note.id && (
                              <button
                                type="button"
                                onClick={() => deleteContractorNote(contractor.id, note.id!)}
                                disabled={deletingContractorNoteId === note.id}
                                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-black text-red-500 transition hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                                title="Delete note"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                {deletingContractorNoteId === note.id ? 'Deleting' : 'Delete'}
                              </button>
                            )}
                          </div>
                        </div>
                        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-gray-700">{note.note}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-xl border border-gray-100 bg-white p-4 text-sm font-semibold text-gray-400">No notes yet.</p>
                )}
              </div>
            </div>
          </Modal>
        );
      })()}

      <Modal isOpen={addingContractor} onClose={() => setAddingContractor(false)} title="Add Vendor / Contractor" size="lg">
        <div className="space-y-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Vendor / Contractor Name *</label>
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
                aria-label="Filter projects by address or job name"
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
              {savingAdd ? 'Adding...' : 'Add Vendor'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!editingContractor} onClose={() => setEditingContractor(null)} title="Vendor Details" size="lg">
        <div className="space-y-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Vendor / Contractor Name *</label>
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

          {editingContractor ? (() => {
            const qboVendor = quickBooksVendorInfo(editingContractor);
            return (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4">
                <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-black text-gray-900">QuickBooks Vendor Record</p>
                    <p className="text-xs text-emerald-800">Read-only accounting fields synced through the QuickBooks API.</p>
                  </div>
                  <span className="inline-flex w-fit rounded-full bg-white px-2.5 py-1 text-xs font-black text-emerald-800 ring-1 ring-emerald-200">
                    {qboVendor?.id ? 'Linked' : 'Not linked'}
                  </span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {detailLine('QuickBooks vendor ID', qboVendor?.id || editingContractor.quickbooks_vendor_id)}
                  {detailLine('Display name', qboVendor?.display_name || editingContractor.quickbooks_display_name)}
                  {detailLine('Company name', qboVendor?.company_name || editingContractor.quickbooks_company_name)}
                  {detailLine('Print on check', qboVendor?.print_on_check_name || editingContractor.quickbooks_print_on_check_name)}
                  {detailLine('QuickBooks phone', qboVendor?.primary_phone || editingContractor.quickbooks_primary_phone)}
                  {detailLine('QuickBooks email', qboVendor?.primary_email || editingContractor.quickbooks_primary_email)}
                  {detailLine('1099 vendor', quickBooksBoolean(qboVendor?.vendor_1099 ?? editingContractor.quickbooks_vendor_1099) ? 'Yes' : 'No')}
                  {detailLine('Tax ID', (qboVendor?.tax_identifier_last4 || editingContractor.quickbooks_tax_identifier_last4) ? `Ending ${qboVendor?.tax_identifier_last4 || editingContractor.quickbooks_tax_identifier_last4}` : null)}
                  {detailLine('QuickBooks billing address', qboVendor?.billing_address || editingContractor.quickbooks_bill_addr, 'sm:col-span-2')}
                </div>
              </div>
            );
          })() : null}

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
                aria-label="Filter projects by address or job name"
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
              {savingEdit ? 'Saving...' : 'Save Vendor Details'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
