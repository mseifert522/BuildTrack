import { useEffect, useMemo, useState } from 'react';
import { Building2, Mail, MapPin, Phone, Search, Truck, UserRound } from 'lucide-react';
import api from '../lib/api';
import { Loading } from '../components/ui';

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
  supplier_marked_at?: string | null;
}

function categoriesFor(supplier: Supplier) {
  return (supplier.categories && supplier.categories.length > 0 ? supplier.categories : [supplier.category])
    .map(category => String(category || '').trim())
    .filter(Boolean);
}

function supplierContactLines(supplier: Supplier) {
  return [
    supplier.billing_address
      ? { key: 'address', Icon: MapPin, value: supplier.billing_address, href: null }
      : null,
    supplier.contact
      ? { key: 'contact', Icon: UserRound, value: `Contact: ${supplier.contact}`, href: null }
      : null,
    supplier.email
      ? { key: 'email', Icon: Mail, value: supplier.email, href: `mailto:${supplier.email}` }
      : null,
    supplier.phone
      ? { key: 'phone', Icon: Phone, value: supplier.phone, href: `tel:${supplier.phone}` }
      : null,
  ].filter(Boolean) as { key: string; Icon: typeof MapPin; value: string; href: string | null }[];
}

export default function Suppliers() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/users/suppliers')
      .then(res => setSuppliers(Array.isArray(res.data) ? res.data : []))
      .catch(() => setError('Supplier records are unavailable right now.'))
      .finally(() => setLoading(false));
  }, []);

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

  if (loading) return <Loading />;

  return (
    <div className="min-h-full px-6 py-6 md:px-8" style={{ background: '#F0F2F5' }}>
      <div className="max-w-7xl mx-auto space-y-5">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-gray-900 tracking-tight">Suppliers</h1>
            <p className="text-sm text-gray-500 mt-1">{filteredSuppliers.length} active supplier records</p>
          </div>
          <div
            className="flex items-center gap-2 px-3 py-2.5 rounded-xl w-full md:w-80"
            style={{ background: 'white', border: '1px solid #E5E7EB' }}
          >
            <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search suppliers"
              className="w-full bg-transparent text-sm outline-none text-gray-900 placeholder:text-gray-400"
            />
          </div>
        </div>

        {error ? (
          <div className="rounded-2xl p-6 text-sm font-semibold text-red-700" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
            {error}
          </div>
        ) : filteredSuppliers.length === 0 ? (
          <div
            className="rounded-2xl py-16 px-6 flex flex-col items-center justify-center text-center"
            style={{ background: 'white', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}
          >
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style={{ background: '#F3F4F6' }}>
              <Truck className="w-7 h-7 text-gray-300" />
            </div>
            <p className="font-bold text-gray-700">No suppliers found</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
            <div className="hidden border-b border-gray-200 bg-gray-50 px-4 py-3 text-xs font-black uppercase text-gray-500 lg:grid lg:grid-cols-[minmax(220px,1fr)_minmax(260px,1fr)_minmax(360px,1.5fr)] lg:gap-5">
              <span>Name</span>
              <span>Category</span>
              <span>Contact</span>
            </div>
            <div className="divide-y divide-gray-100">
            {filteredSuppliers.map((supplier) => (
              <div
                key={supplier.id}
                className="grid gap-4 px-4 py-4 transition hover:bg-gray-50 lg:grid-cols-[minmax(220px,1fr)_minmax(260px,1fr)_minmax(360px,1.5fr)] lg:items-start lg:gap-5"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <div
                    className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-white"
                    style={{ background: '#1E3A5F' }}
                  >
                    <Truck className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-black text-gray-900">{supplier.name}</h2>
                    {supplier.account_number ? (
                      <p className="mt-1 truncate text-xs font-semibold text-gray-500">Acct {supplier.account_number}</p>
                    ) : null}
                  </div>
                </div>

                <div className="flex min-w-0 flex-wrap gap-1.5">
                  {categoriesFor(supplier).length > 0 ? categoriesFor(supplier).map(category => (
                    <span key={category} className="inline-flex min-h-7 items-center gap-1 rounded-md border border-blue-100 bg-blue-50 px-2 py-1 text-xs font-black text-blue-700">
                      <Building2 className="h-3 w-3 flex-shrink-0" />
                      {category}
                    </span>
                  )) : (
                    <span className="inline-flex min-h-7 items-center rounded-md border border-amber-100 bg-amber-50 px-2 py-1 text-xs font-black text-amber-700">
                      Assign supply category
                    </span>
                  )}
                </div>

                <div className="min-w-0 space-y-2">
                  <span className="lg:hidden text-xs font-black uppercase text-gray-400">Contact</span>
                  {supplierContactLines(supplier).length > 0 ? supplierContactLines(supplier).map(({ key, Icon, value, href }) => {
                    const content = (
                      <>
                        <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-400" />
                        <span className="min-w-0 whitespace-pre-wrap break-words">{value}</span>
                      </>
                    );
                    return href ? (
                      <a key={key} href={href} className="flex min-w-0 items-start gap-2 text-sm font-semibold text-gray-600 hover:text-gray-900">
                        {content}
                      </a>
                    ) : (
                      <p key={key} className="flex min-w-0 items-start gap-2 text-sm font-semibold text-gray-600">
                        {content}
                      </p>
                    );
                  }) : (
                    <p className="text-sm font-semibold text-gray-400">No contact details listed</p>
                  )}
                </div>
              </div>
            ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
