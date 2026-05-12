import { Building2, Mail, Phone, Search, Truck } from 'lucide-react';

interface Supplier {
  id: string;
  name: string;
  category: string;
  email?: string;
  phone?: string;
  contact?: string;
}

const suppliers: Supplier[] = [];

export default function Suppliers() {
  return (
    <div className="min-h-full px-6 py-6 md:px-8" style={{ background: '#F0F2F5' }}>
      <div className="max-w-7xl mx-auto space-y-5">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-gray-900 tracking-tight">Suppliers</h1>
            <p className="text-sm text-gray-500 mt-1">{suppliers.length} active supplier records</p>
          </div>
          <div
            className="flex items-center gap-2 px-3 py-2.5 rounded-xl w-full md:w-80"
            style={{ background: 'white', border: '1px solid #E5E7EB' }}
          >
            <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
            <input
              disabled
              placeholder="Search suppliers"
              className="w-full bg-transparent text-sm outline-none text-gray-400 placeholder:text-gray-400"
            />
          </div>
        </div>

        {suppliers.length === 0 ? (
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
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {suppliers.map((supplier) => (
              <div
                key={supplier.id}
                className="rounded-2xl p-5"
                style={{ background: 'white', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}
              >
                <div className="flex items-start gap-3">
                  <div
                    className="w-11 h-11 rounded-xl flex items-center justify-center text-white flex-shrink-0"
                    style={{ background: 'linear-gradient(135deg, #1E3A5F, #2563EB)' }}
                  >
                    <Truck className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="font-black text-gray-900 truncate">{supplier.name}</h2>
                    <div className="flex items-center gap-1.5 text-sm text-gray-500 mt-1">
                      <Building2 className="w-3.5 h-3.5 flex-shrink-0" />
                      <span className="truncate">{supplier.category}</span>
                    </div>
                  </div>
                </div>

                <div className="mt-5 space-y-2.5">
                  {supplier.contact && <p className="text-sm font-semibold text-gray-700">{supplier.contact}</p>}
                  {supplier.email && (
                    <a href={`mailto:${supplier.email}`} className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900">
                      <Mail className="w-4 h-4 text-gray-400 flex-shrink-0" />
                      <span className="truncate">{supplier.email}</span>
                    </a>
                  )}
                  {supplier.phone && (
                    <a href={`tel:${supplier.phone}`} className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900">
                      <Phone className="w-4 h-4 text-gray-400 flex-shrink-0" />
                      <span>{supplier.phone}</span>
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
