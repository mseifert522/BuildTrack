import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Search } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { Modal } from './ui';
import { announceVendorAdded, type AddedVendor } from '../lib/vendors';

// The one Add Vendor form. Opened from the top bar on every screen, from a project
// page (pre-linked to that project), from the Contractors / Suppliers directory and
// from the Documents & Agreements form. It asks the server to refuse a vendor that
// is already in the directory (by name or email) and offers that record instead.

interface ProjectOption {
  id: string;
  address: string;
  job_name?: string | null;
  status?: string | null;
}

interface DuplicateMatch {
  id: string;
  name: string;
  match_kind: 'name' | 'email';
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Pre-select (and offer to link) this project. */
  defaultProjectId?: string | null;
  defaultType?: 'contractor' | 'supplier';
  initialName?: string;
  /** Details read from a document by the AI (agreement upload). */
  initialValues?: { contact_name?: string; email?: string; phone?: string; billing_address?: string };
  /** Called with the vendor that was added - or the existing one the user chose. */
  onAdded?: (vendor: AddedVendor) => void;
}

const emptyForm = {
  name: '',
  contact_name: '',
  phone: '',
  email: '',
  billing_address: '',
  account_number: '',
};

const SUPPLIER_DEFAULT_CATEGORY = 'General Building Materials';

export default function AddVendorModal({ isOpen, onClose, defaultProjectId = null, defaultType = 'contractor', initialName = '', initialValues, onAdded }: Props) {
  const [type, setType] = useState<'contractor' | 'supplier'>(defaultType);
  const [form, setForm] = useState(emptyForm);
  const [categories, setCategories] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectId, setProjectId] = useState('');
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [duplicate, setDuplicate] = useState<DuplicateMatch | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setType(defaultType);
    setForm({
      ...emptyForm,
      name: initialName,
      contact_name: initialValues?.contact_name || '',
      email: initialValues?.email || '',
      phone: initialValues?.phone || '',
      billing_address: initialValues?.billing_address || '',
    });
    setSelectedCategories([]);
    setCategoryFilter('');
    setProjectId(defaultProjectId || '');
    setError('');
    setDuplicate(null);
    let active = true;
    setLoadingOptions(true);
    Promise.all([
      api.get('/users/contractor-categories').catch(() => ({ data: { categories: [] } })),
      api.get('/projects').catch(() => ({ data: [] })),
    ]).then(([categoryRes, projectRes]) => {
      if (!active) return;
      setCategories(Array.isArray(categoryRes.data?.categories) ? categoryRes.data.categories : []);
      const rows = Array.isArray(projectRes.data) ? projectRes.data : Array.isArray(projectRes.data?.projects) ? projectRes.data.projects : [];
      setProjects(rows
        .map((row: ProjectOption) => ({ id: row.id, address: row.address, job_name: row.job_name, status: row.status }))
        .sort((a: ProjectOption, b: ProjectOption) => Number(a.status === 'archived') - Number(b.status === 'archived')
          || String(a.address || '').localeCompare(String(b.address || ''))));
    }).finally(() => {
      if (active) setLoadingOptions(false);
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const visibleCategories = useMemo(() => {
    const term = categoryFilter.trim().toLowerCase();
    return categories.filter(name => !term || name.toLowerCase().includes(term));
  }, [categories, categoryFilter]);

  const toggleCategory = (name: string) => {
    setSelectedCategories(current => current.includes(name)
      ? current.filter(item => item !== name)
      : [...current, name]);
  };

  const finish = (vendor: AddedVendor) => {
    announceVendorAdded(vendor);
    onAdded?.(vendor);
    onClose();
  };

  const save = async (allowDuplicate: boolean) => {
    if (saving) return;
    const name = form.name.trim();
    const email = form.email.trim();
    if (!name) {
      setError(type === 'supplier' ? 'Enter the supplier name' : 'Enter the vendor / company name');
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Enter a valid email address, or leave it blank');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (type === 'supplier') {
        const res = await api.post('/users/suppliers', {
          name,
          contact: form.contact_name.trim(),
          email,
          phone: form.phone.trim(),
          billing_address: form.billing_address.trim(),
          account_number: form.account_number.trim(),
          categories: selectedCategories.length ? selectedCategories : [SUPPLIER_DEFAULT_CATEGORY],
          check_duplicates: !allowDuplicate,
        });
        toast.success(`${name} added to Contractors / Suppliers`);
        finish({ id: res.data?.supplier?.id, name, type: 'supplier', project_id: null, linked: false });
      } else {
        const res = await api.post('/users/contractors/profile', {
          vendor_name: name,
          contact_name: form.contact_name.trim(),
          email,
          phone: form.phone.trim(),
          billing_address: form.billing_address.trim(),
          account_number: form.account_number.trim(),
          contractor_status: 'active',
          contractor_categories: selectedCategories,
          project_ids: projectId ? [projectId] : [],
          check_duplicates: !allowDuplicate,
        });
        const project = projects.find(item => item.id === projectId);
        toast.success(project ? `${name} added and connected to ${project.address}` : `${name} added to Contractors / Suppliers`);
        finish({ id: res.data?.contractor?.id, name, type: 'contractor', project_id: projectId || null, linked: Boolean(projectId) });
      }
    } catch (err: any) {
      const match = err?.response?.status === 409 ? err.response.data?.duplicate : null;
      if (match?.id) {
        setDuplicate(match);
      } else {
        setError(err?.response?.data?.error || 'The vendor could not be added. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save(false);
  };

  const useExisting = () => {
    if (!duplicate) return;
    // Connecting an existing vendor to the project is done by the project page itself
    // (it holds the project's current contractor list - see ProjectContractorAssignmentPanel).
    finish({ id: duplicate.id, name: duplicate.name, type, project_id: type === 'contractor' ? projectId || null : null, linked: false });
    toast.success(`Using ${duplicate.name}`);
  };

  const field = 'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500';
  const label = 'mb-1 block text-xs font-bold uppercase tracking-wide text-gray-600';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Add Vendor"
      description="Add a contractor or supplier to the system. They appear in Contractors / Suppliers right away."
      size="lg"
    >
      <form onSubmit={submit} className="bt-add-vendor-form space-y-4" noValidate>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="bt-vs-toggle" role="radiogroup" aria-label="Vendor type">
            {(['contractor', 'supplier'] as const).map(option => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={type === option}
                onClick={() => { setType(option); setDuplicate(null); }}
              >
                {option === 'contractor' ? 'Contractor' : 'Supplier'}
              </button>
            ))}
          </div>
          {loadingOptions ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading
            </span>
          ) : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="add-vendor-name" className={label}>{type === 'supplier' ? 'Supplier name' : 'Vendor / company name'} *</label>
            <input
              id="add-vendor-name"
              value={form.name}
              onChange={event => { setForm(prev => ({ ...prev, name: event.target.value })); setDuplicate(null); }}
              maxLength={150}
              autoComplete="off"
              placeholder={type === 'supplier' ? 'ABC Supply Co.' : 'Oak Roofing LLC'}
              className={field}
            />
          </div>
          <div>
            <label htmlFor="add-vendor-contact" className={label}>Contact name</label>
            <input id="add-vendor-contact" value={form.contact_name} onChange={event => setForm(prev => ({ ...prev, contact_name: event.target.value }))} autoComplete="off" className={field} />
          </div>
          <div>
            <label htmlFor="add-vendor-phone" className={label}>Phone</label>
            <input id="add-vendor-phone" type="tel" value={form.phone} onChange={event => setForm(prev => ({ ...prev, phone: event.target.value }))} autoComplete="off" className={field} />
          </div>
          <div>
            <label htmlFor="add-vendor-email" className={label}>Email</label>
            <input id="add-vendor-email" type="email" value={form.email} onChange={event => { setForm(prev => ({ ...prev, email: event.target.value })); setDuplicate(null); }} autoComplete="off" className={field} />
          </div>
          <div>
            <label htmlFor="add-vendor-account" className={label}>Account number</label>
            <input id="add-vendor-account" value={form.account_number} onChange={event => setForm(prev => ({ ...prev, account_number: event.target.value }))} autoComplete="off" className={field} />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="add-vendor-address" className={label}>Address</label>
            <input id="add-vendor-address" value={form.billing_address} onChange={event => setForm(prev => ({ ...prev, billing_address: event.target.value }))} autoComplete="off" className={field} />
          </div>
          {type === 'contractor' ? (
            <div className="sm:col-span-2">
              <label htmlFor="add-vendor-project" className={label}>Connect to project</label>
              <select id="add-vendor-project" value={projectId} onChange={event => setProjectId(event.target.value)} className={field}>
                <option value="">Not connected to a project</option>
                {projects.map(project => (
                  <option key={project.id} value={project.id}>
                    {project.address}{project.status === 'archived' ? ' (archived)' : ''}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>

        <div>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <span className={label} style={{ marginBottom: 0 }}>
              Type of work{type === 'supplier' ? ' / supplies' : ''}
            </span>
            <span className="text-[11px] font-bold text-gray-500">
              {selectedCategories.length ? `${selectedCategories.length} selected` : type === 'supplier' ? `Defaults to ${SUPPLIER_DEFAULT_CATEGORY}` : 'Optional'}
            </span>
          </div>
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
            <input
              value={categoryFilter}
              onChange={event => setCategoryFilter(event.target.value)}
              aria-label="Filter categories"
              placeholder="Filter (e.g. roof)"
              className={`${field} pl-8`}
            />
          </div>
          <div className="bt-add-vendor-categories flex max-h-32 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-gray-200 p-2">
            {visibleCategories.map(name => {
              const selected = selectedCategories.includes(name);
              return (
                <button
                  key={name}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleCategory(name)}
                  className={`bt-chip-toggle ${selected ? 'is-selected' : ''}`}
                >
                  {name}
                </button>
              );
            })}
            {!visibleCategories.length ? <span className="px-1 text-xs font-semibold text-gray-500">No categories match</span> : null}
          </div>
        </div>

        {duplicate ? (
          <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-amber-900">{duplicate.name} is already in the system</p>
                <p className="mt-0.5 text-xs font-semibold text-amber-800">
                  Matched by {duplicate.match_kind === 'email' ? 'email address' : 'name'}. Use the existing record, or add a separate one anyway.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" onClick={useExisting} className="bt-vs-btn bt-vs-btn--primary">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Use {duplicate.name}
                  </button>
                  <button type="button" onClick={() => void save(true)} disabled={saving} className="bt-vs-btn">
                    Add anyway
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {error ? (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</div>
        ) : null}

        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <button type="button" onClick={onClose} className="bt-vs-btn bt-vs-btn--lg sm:flex-1">Cancel</button>
          <button type="submit" disabled={saving} aria-disabled={saving} className="bt-vs-btn bt-vs-btn--lg bt-vs-btn--primary sm:flex-1">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {saving ? 'Adding…' : type === 'supplier' ? 'Add Supplier' : 'Add Vendor'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
