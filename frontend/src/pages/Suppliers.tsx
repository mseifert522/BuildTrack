import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, ChevronDown, Edit2, Mail, MapPin, PackageCheck, Phone, Plus, Search, Truck, UserRound } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { Loading, Modal } from '../components/ui';
import { formatEasternDateTime } from '../lib/time';

interface Supplier {
  id: string;
  name: string;
  category: string;
  categories?: string[];
  email?: string | null;
  phone?: string | null;
  contact?: string | null;
  billing_address?: string | null;
  account_number?: string | null;
  category_inferred?: boolean;
  supplier_marked_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

type SupplierForm = {
  name: string;
  categories: string[];
  billing_address: string;
  contact: string;
  phone: string;
  email: string;
  account_number: string;
};

const SUPPLY_CATEGORY_OPTIONS = [
  'Landscaping Materials',
  'Drywall',
  'General Building Materials',
  'Portable Toilets',
  'Tool Rentals',
  'Appliances',
  'Fixtures',
  'Building Materials',
  'Lumber',
  'Roofing Materials',
  'Siding Materials',
  'Electrical Supplies',
  'Plumbing Supplies',
  'HVAC Supplies',
  'Flooring Materials',
  'Paint',
  'Concrete and Masonry',
  'Windows and Doors',
  'Cabinets and Countertops',
  'Countertops and Stone',
  'Tile and Stone',
  'Tools and Hardware',
  'Welding Supplies',
  'Industrial Supplies',
  'Equipment Rentals',
  'Truck and Trailer Rentals',
  'Steel and Metal',
  'Fixtures and Furnishings',
  'Dumpster and Hauling',
  'Cleaning Supplies',
];

const emptySupplierForm: SupplierForm = {
  name: '',
  categories: [],
  billing_address: '',
  contact: '',
  phone: '',
  email: '',
  account_number: '',
};

const supplierInitials = (name?: string) =>
  (name || '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase())
    .join('') || '?';

function categoriesFor(supplier: Supplier) {
  return (supplier.categories && supplier.categories.length > 0 ? supplier.categories : [supplier.category])
    .map(category => String(category || '').trim())
    .filter(Boolean)
    .filter(category => category.toLowerCase() !== 'supplier');
}

function supplierCategoryText(supplier: Supplier) {
  const categories = categoriesFor(supplier);
  return categories.length ? categories.join(' / ') : 'Needs supply category';
}

function supplierAddress(supplier: Supplier) {
  return (supplier.billing_address || '').replace(/\s+/g, ' ').trim() || 'No address listed';
}

function supplierContact(supplier: Supplier) {
  return (supplier.contact || '').trim() || 'No contact person';
}

function supplierPhone(supplier: Supplier) {
  return (supplier.phone || '').trim() || 'No phone listed';
}

export default function Suppliers() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedSupplierId, setExpandedSupplierId] = useState<string | null>(null);
  const [showAddSupplier, setShowAddSupplier] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [form, setForm] = useState<SupplierForm>(emptySupplierForm);
  const [saving, setSaving] = useState(false);

  const loadSuppliers = async () => {
    setLoading(true);
    try {
      const res = await api.get('/users/suppliers');
      setSuppliers(Array.isArray(res.data) ? res.data : []);
      setError('');
    } catch (_) {
      setError('Supplier records are unavailable right now.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSuppliers();
  }, []);

  const categoryOptions = useMemo(() => {
    const existing = suppliers.flatMap(supplier => categoriesFor(supplier));
    return [...new Set([...SUPPLY_CATEGORY_OPTIONS, ...existing])].sort((left, right) => left.localeCompare(right));
  }, [suppliers]);

  const filteredSuppliers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter(supplier => [
      supplier.name,
      supplier.contact,
      supplier.email,
      supplier.phone,
      supplier.category,
      ...(supplier.categories || []),
      supplier.billing_address,
      supplier.account_number,
    ].filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [suppliers, query]);

  const closeSupplierModal = () => {
    setShowAddSupplier(false);
    setEditingSupplier(null);
    setForm(emptySupplierForm);
    setSaving(false);
  };

  const openAddSupplier = () => {
    setForm(emptySupplierForm);
    setEditingSupplier(null);
    setShowAddSupplier(true);
  };

  const openEditSupplier = (supplier: Supplier) => {
    setForm({
      name: supplier.name || '',
      categories: categoriesFor(supplier),
      billing_address: supplier.billing_address || '',
      contact: supplier.contact || '',
      phone: supplier.phone || '',
      email: supplier.email || '',
      account_number: supplier.account_number || '',
    });
    setEditingSupplier(supplier);
    setShowAddSupplier(false);
  };

  const toggleCategory = (category: string) => {
    setForm(current => {
      const selected = current.categories.includes(category);
      return {
        ...current,
        categories: selected
          ? current.categories.filter(item => item !== category)
          : [...current.categories, category],
      };
    });
  };

  const saveSupplier = async () => {
    if (!form.name.trim()) return toast.error('Supplier name is required');
    if (form.categories.length === 0) return toast.error('Choose at least one supply category');

    setSaving(true);
    const payload = {
      name: form.name.trim(),
      categories: form.categories,
      billing_address: form.billing_address.trim(),
      contact: form.contact.trim(),
      phone: form.phone.trim(),
      email: form.email.trim(),
      account_number: form.account_number.trim(),
    };

    try {
      const res = editingSupplier
        ? await api.put(`/users/suppliers/${editingSupplier.id}`, payload)
        : await api.post('/users/suppliers', payload);
      const supplier = res.data?.supplier as Supplier | undefined;
      if (supplier) {
        setSuppliers(current => {
          const withoutExisting = current.filter(item => item.id !== supplier.id);
          return editingSupplier ? [supplier, ...withoutExisting] : [supplier, ...current];
        });
        setExpandedSupplierId(supplier.id);
      }
      toast.success(editingSupplier ? 'Supplier updated' : 'Supplier added');
      closeSupplierModal();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to save supplier');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading />;

  return (
    <div className="bt-desktop-page bt-directory-page bt-suppliers-page min-h-full px-6 py-6 md:px-8">
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="bt-directory-hero flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="bt-directory-title-block">
            <p className="bt-directory-kicker">Materials and vendor directory</p>
            <h1 className="text-2xl font-black tracking-tight">Suppliers</h1>
            <p className="mt-1 text-sm font-semibold">{filteredSuppliers.length} active supplier records</p>
          </div>
          <div className="bt-directory-actions flex w-full flex-col gap-2 sm:flex-row md:w-auto">
            <div className="inline-flex rounded-2xl border border-slate-300 bg-white p-1 shadow-sm">
              <Link
                to="/contractors"
                className="rounded-xl px-4 py-2 text-sm font-black text-slate-600 transition hover:bg-slate-100 hover:text-slate-950"
              >
                Contractors
              </Link>
              <Link
                to="/suppliers"
                className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-black text-white shadow-sm"
              >
                Supplies
              </Link>
            </div>
            <div className="bt-directory-search flex min-h-11 w-full items-center gap-2 rounded-xl border border-slate-400 bg-slate-50 px-3 shadow-sm sm:w-80">
              <Search className="h-4 w-4 flex-shrink-0 text-gray-400" />
              <input
                value={query}
                onChange={event => setQuery(event.target.value)}
                aria-label="Search suppliers"
                className="w-full bg-transparent text-sm font-semibold text-gray-900 outline-none placeholder:text-gray-400"
              />
            </div>
            <button
              type="button"
              onClick={openAddSupplier}
              className="bt-directory-primary-action"
            >
              <Plus className="h-4 w-4" />
              Add Supplier
            </button>
          </div>
        </div>

        {error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm font-semibold text-red-700">
            {error}
          </div>
        ) : filteredSuppliers.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-gray-300 bg-white px-6 py-16 text-center shadow-sm">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-100">
              <Truck className="h-7 w-7 text-gray-300" />
            </div>
            <p className="font-bold text-gray-700">No suppliers found</p>
          </div>
        ) : (
          <div className="bt-table-wrap bt-directory-list p-2">
            <div className="bt-directory-list-header hidden rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs font-black uppercase tracking-wide text-slate-500 xl:grid xl:grid-cols-[minmax(210px,1.1fr)_minmax(220px,1fr)_minmax(260px,1.25fr)_minmax(190px,0.9fr)_minmax(160px,0.75fr)_80px] xl:gap-4">
              <span>Name</span>
              <span>Category</span>
              <span>Address</span>
              <span>Contact Person</span>
              <span>Phone Number</span>
              <span className="text-right">Open</span>
            </div>
            <div className="mt-2 space-y-2">
              {filteredSuppliers.map(supplier => {
                const isExpanded = expandedSupplierId === supplier.id;
                const categories = categoriesFor(supplier);
                return (
                  <div
                    key={supplier.id}
                    className={`bt-directory-card overflow-hidden rounded-lg border border-l-4 transition-colors ${isExpanded ? 'is-expanded border-blue-300 border-l-blue-600 bg-blue-50 ring-1 ring-blue-100' : 'border-slate-200 border-l-slate-400 bg-white hover:border-blue-200 hover:bg-slate-50'}`}
                    onClick={event => {
                      const target = event.target as HTMLElement;
                      if (target.closest('button,a,input,textarea,select,label')) return;
                      setExpandedSupplierId(current => current === supplier.id ? null : supplier.id);
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setExpandedSupplierId(current => current === supplier.id ? null : supplier.id)}
                      className="bt-directory-row grid w-full grid-cols-1 gap-3 px-4 py-4 text-left xl:grid-cols-[minmax(210px,1.1fr)_minmax(220px,1fr)_minmax(260px,1.25fr)_minmax(190px,0.9fr)_minmax(160px,0.75fr)_80px] xl:items-center xl:gap-4"
                      aria-expanded={isExpanded}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="bt-directory-avatar flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50 text-xs font-black text-blue-700 ring-1 ring-blue-100">
                          {supplierInitials(supplier.name)}
                        </div>
                        <div className="min-w-0">
                          <h2 className="truncate text-sm font-black text-gray-950">{supplier.name}</h2>
                          <p className="mt-1 text-xs font-semibold text-gray-500">{supplier.account_number ? `Acct ${supplier.account_number}` : 'Supplier record'}</p>
                        </div>
                      </div>

                      <div className="flex min-w-0 flex-wrap gap-1.5">
                        {categories.length > 0 ? categories.slice(0, 2).map(category => (
                          <span key={category} className="bt-directory-chip inline-flex min-h-7 items-center gap-1 rounded-lg border border-blue-100 bg-blue-50 px-2 py-1 text-xs font-black text-blue-700">
                            <PackageCheck className="h-3.5 w-3.5 flex-shrink-0" />
                            {category}
                          </span>
                        )) : (
                          <span className="bt-directory-chip bt-directory-chip-warning inline-flex min-h-7 items-center rounded-lg border border-amber-100 bg-amber-50 px-2 py-1 text-xs font-black text-amber-700">
                            Needs supply category
                          </span>
                        )}
                        {categories.length > 2 && (
                          <span className="bt-directory-chip inline-flex min-h-7 items-center rounded-lg bg-slate-100 px-2 py-1 text-xs font-black text-slate-600">
                            +{categories.length - 2}
                          </span>
                        )}
                      </div>

                      <div className="flex min-w-0 items-start gap-2 text-sm font-semibold text-slate-700">
                        <MapPin className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400" />
                        <span className="min-w-0 truncate">{supplierAddress(supplier)}</span>
                      </div>

                      <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-700">
                        <UserRound className="h-4 w-4 flex-shrink-0 text-slate-400" />
                        <span className="min-w-0 truncate">{supplierContact(supplier)}</span>
                      </div>

                      <div className="flex min-w-0 items-center gap-2 text-sm font-black text-slate-800">
                        <Phone className="h-4 w-4 flex-shrink-0 text-slate-400" />
                        <span className="min-w-0 truncate">{supplierPhone(supplier)}</span>
                      </div>

                      <div className="bt-directory-row-action flex items-center justify-end gap-2 text-xs font-black text-blue-700">
                        <span>{isExpanded ? 'Hide' : 'Expand'}</span>
                        <ChevronDown className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                      </div>
                    </button>

                    {isExpanded && (
                      <div className="bt-directory-expanded border-t border-slate-200 bg-slate-50 px-4 py-4">
                        <div className="grid gap-3 lg:grid-cols-[1.1fr_1fr_auto] lg:items-start">
                          <div className="bt-directory-info-panel rounded-xl border border-slate-400 bg-slate-50 p-4 shadow-sm">
                            <p className="mb-2 text-xs font-black uppercase tracking-wide text-slate-500">Supplier Details</p>
                            <div className="grid gap-3 sm:grid-cols-2">
                              <DetailLine label="Name" value={supplier.name} />
                              <DetailLine label="Supply Category" value={supplierCategoryText(supplier)} />
                              <DetailLine label="Address" value={supplierAddress(supplier)} />
                              <DetailLine label="Contact Person" value={supplierContact(supplier)} />
                            </div>
                          </div>
                          <div className="bt-directory-info-panel rounded-xl border border-slate-400 bg-slate-50 p-4 shadow-sm">
                            <p className="mb-2 text-xs font-black uppercase tracking-wide text-slate-500">Contact</p>
                            <div className="space-y-2 text-sm">
                              <p className="flex min-w-0 items-center gap-2 font-semibold text-slate-700"><Phone className="h-4 w-4 text-slate-400" />{supplierPhone(supplier)}</p>
                              <p className="flex min-w-0 items-center gap-2 font-semibold text-slate-700"><Mail className="h-4 w-4 text-slate-400" />{supplier.email || 'No email listed'}</p>
                              <p className="flex min-w-0 items-center gap-2 font-semibold text-slate-700"><Building2 className="h-4 w-4 text-slate-400" />{supplier.account_number ? `Account ${supplier.account_number}` : 'No account number'}</p>
                              <p className="text-xs font-semibold text-slate-500">
                                Updated {supplier.updated_at ? formatEasternDateTime(supplier.updated_at, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'not recorded'} ET
                              </p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => openEditSupplier(supplier)}
                            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 text-sm font-black text-white transition hover:bg-slate-800"
                          >
                            <Edit2 className="h-4 w-4" />
                            Edit Supplier
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <Modal isOpen={showAddSupplier || !!editingSupplier} onClose={closeSupplierModal} title={editingSupplier ? 'Edit Supplier' : 'Add Supplier'} size="lg">
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm font-bold text-gray-700">Supplier Name *</label>
              <input value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-bold text-gray-700">Contact Person</label>
              <input value={form.contact} onChange={event => setForm(current => ({ ...current, contact: event.target.value }))} className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-bold text-gray-700">Phone Number</label>
              <input value={form.phone} onChange={event => setForm(current => ({ ...current, phone: event.target.value }))} className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-bold text-gray-700">Email</label>
              <input value={form.email} onChange={event => setForm(current => ({ ...current, email: event.target.value }))} className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-bold text-gray-700">Account Number</label>
              <input value={form.account_number} onChange={event => setForm(current => ({ ...current, account_number: event.target.value }))} className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm font-bold text-gray-700">Address</label>
              <textarea value={form.billing_address} onChange={event => setForm(current => ({ ...current, billing_address: event.target.value }))} rows={3} className="w-full resize-none rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>

          <div className="rounded-2xl border border-blue-100 bg-blue-50/40 p-4">
            <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-black text-gray-950">Supply Category *</p>
                <p className="text-xs font-semibold text-gray-500">Choose what this supplier provides.</p>
              </div>
              <span className="rounded-full bg-white px-2.5 py-1 text-xs font-black text-blue-700 ring-1 ring-blue-100">{form.categories.length} selected</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {categoryOptions.map(category => {
                const selected = form.categories.includes(category);
                return (
                  <button
                    key={category}
                    type="button"
                    onClick={() => toggleCategory(category)}
                    className={`min-h-10 rounded-xl border px-3 py-2 text-left text-xs font-black transition ${
                      selected
                        ? 'border-blue-300 bg-blue-600 text-white shadow-sm'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-blue-200 hover:bg-blue-50'
                    }`}
                  >
                    {category}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={closeSupplierModal} className="flex-1 rounded-xl border border-gray-300 py-2.5 text-sm font-bold text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="button" onClick={saveSupplier} disabled={saving} className="flex-1 rounded-xl bg-blue-600 py-2.5 text-sm font-black text-white hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Saving...' : editingSupplier ? 'Save Supplier' : 'Add Supplier'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-black uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm font-bold text-slate-800">{value}</p>
    </div>
  );
}
