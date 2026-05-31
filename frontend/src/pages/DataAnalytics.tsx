import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  BarChart3,
  BriefcaseBusiness,
  CheckCircle2,
  CircleDollarSign,
  FileText,
  Filter,
  LineChart,
  Plus,
  Search,
  TrendingUp,
  Upload,
  WalletCards,
  X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../lib/api';
import { Loading } from '../components/ui';
import { formatEasternDateTime } from '../lib/time';

interface QuoteCategory {
  id: string;
  category_group: string;
  name: string;
  normalized_key: string;
}

interface ProjectOption {
  id: string;
  address: string;
  job_name: string;
  status: string;
}

interface ContractorOption {
  id: string;
  vendor_name: string;
  contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  billing_address?: string | null;
}

interface QuoteLineItem {
  id?: string;
  quote_id?: string;
  category: string;
  category_group?: string;
  subcategory?: string | null;
  description: string;
  quantity: number | string;
  unit?: string | null;
  unit_price: number | string;
  total_line_item_price: number | string;
  labor_amount: number | string;
  material_amount: number | string;
}

interface Quote {
  id: string;
  quote_number: string;
  project_id: string;
  property_address: string;
  project_name: string;
  contractor_name: string;
  contractor_company?: string | null;
  contractor_email?: string | null;
  contractor_phone?: string | null;
  contractor_address?: string | null;
  quote_date: string;
  quote_year: number;
  status: string;
  scope_description?: string | null;
  notes?: string | null;
  total_quote_amount: number;
  labor_cost: number;
  material_cost: number;
  final_approved_amount?: number | null;
  source_document_id?: string | null;
  source_file_name?: string | null;
  uploaded_by_name?: string | null;
  updated_at: string;
  document_download_url?: string | null;
  line_items: QuoteLineItem[];
}

interface SummaryRow {
  key: string;
  count: number;
  total: number;
  average: number;
  median: number;
  low: number;
  high: number;
  yoy_change_percent?: number;
  award_rate?: number;
}

interface PropertyRow extends SummaryRow {
  project_id: string;
  property_address: string;
  project_name: string;
}

interface CategoryYearRow {
  category: string;
  year: number;
  count: number;
  total: number;
  average: number;
}

interface CategoryChangeRow {
  category: string;
  latest_year: number | null;
  latest_average: number;
  previous_average: number;
  change_percent: number;
  total: number;
  count: number;
}

interface Summary {
  metrics: {
    total_quotes_uploaded: number;
    total_quoted_value: number;
    contractors_count: number;
    properties_count: number;
    average_quote_amount: number;
    median_quote_amount: number;
    lowest_quote: number;
    highest_quote: number;
    active_projects: number;
    historical_records_count: number;
    line_item_records: number;
    average_line_item_amount: number;
    labor_material_ratio: number;
  };
  by_year: SummaryRow[];
  by_contractor: SummaryRow[];
  by_property: PropertyRow[];
  by_category: SummaryRow[];
  category_by_year: CategoryYearRow[];
  category_cost_changes: CategoryChangeRow[];
  quote_volume_by_year: { year: string; count: number }[];
  labor_material_breakdown: { key: string; total: number }[];
  status_counts: SummaryRow[];
}

interface OptionsPayload {
  categories: QuoteCategory[];
  projects: ProjectOption[];
  contractors: ContractorOption[];
  years: number[];
  statuses: string[];
}

type FiltersState = {
  year: string;
  project_id: string;
  contractor: string;
  category: string;
  status: string;
  start_date: string;
  end_date: string;
  min_cost: string;
  max_cost: string;
};

type QuoteFormState = {
  project_id: string;
  contractor_profile_id: string;
  contractor_name: string;
  contractor_company: string;
  contractor_email: string;
  contractor_phone: string;
  contractor_address: string;
  quote_date: string;
  status: string;
  scope_description: string;
  notes: string;
  total_quote_amount: string;
  labor_cost: string;
  material_cost: string;
  permit_costs: string;
  equipment_costs: string;
  disposal_cleanup_costs: string;
  tax: string;
  insurance: string;
  overhead: string;
  profit_margin: string;
  contingency: string;
  final_approved_amount: string;
};

const emptyOptions: OptionsPayload = { categories: [], projects: [], contractors: [], years: [], statuses: [] };

const emptyFilters = (projectId = ''): FiltersState => ({
  year: '',
  project_id: projectId,
  contractor: '',
  category: '',
  status: '',
  start_date: '',
  end_date: '',
  min_cost: '',
  max_cost: '',
});

const today = () => new Date().toISOString().slice(0, 10);

const emptyForm = (projectId = ''): QuoteFormState => ({
  project_id: projectId,
  contractor_profile_id: '',
  contractor_name: '',
  contractor_company: '',
  contractor_email: '',
  contractor_phone: '',
  contractor_address: '',
  quote_date: today(),
  status: 'submitted',
  scope_description: '',
  notes: '',
  total_quote_amount: '',
  labor_cost: '',
  material_cost: '',
  permit_costs: '',
  equipment_costs: '',
  disposal_cleanup_costs: '',
  tax: '',
  insurance: '',
  overhead: '',
  profit_margin: '',
  contingency: '',
  final_approved_amount: '',
});

const emptyLineItem = (category = ''): QuoteLineItem => ({
  category,
  subcategory: '',
  description: '',
  quantity: 1,
  unit: '',
  unit_price: '',
  total_line_item_price: '',
  labor_amount: '',
  material_amount: '',
});

const money = (value: number | string | null | undefined) =>
  Number(value || 0).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

const numberValue = (value: number | string | null | undefined) => Number(value || 0);

const statusLabel = (status: string) =>
  status.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());

const percent = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;

const buildQuery = (filters: FiltersState) => {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  return params.toString();
};

function MetricCard({ label, value, sub, icon: Icon, color, bg }: {
  label: string;
  value: string;
  sub: string;
  icon: any;
  color: string;
  bg: string;
}) {
  return (
    <div className="rounded-2xl p-5 bg-white" style={{ boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-black uppercase tracking-wide text-gray-400">{label}</p>
          <p className="text-2xl font-black text-gray-900 mt-2 truncate">{value}</p>
          <p className="text-sm text-gray-500 mt-1">{sub}</p>
        </div>
        <div className="w-11 h-11 rounded-2xl flex items-center justify-center flex-shrink-0" style={{ background: bg, color }}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
    </div>
  );
}

function HorizontalBars({ rows, valueKey = 'total', labelKey = 'key', formatValue = money, color = '#2563EB' }: {
  rows: any[];
  valueKey?: string;
  labelKey?: string;
  formatValue?: (value: number) => string;
  color?: string;
}) {
  const max = Math.max(...rows.map(row => numberValue(row[valueKey])), 1);
  if (rows.length === 0) return <p className="text-sm text-gray-400">No data available</p>;
  return (
    <div className="space-y-4">
      {rows.map(row => {
        const value = numberValue(row[valueKey]);
        return (
          <div key={`${row[labelKey]}-${value}`}>
            <div className="flex items-center justify-between gap-3 text-sm mb-2">
              <span className="font-bold text-gray-700 truncate">{row[labelKey]}</span>
              <span className="font-black text-gray-900 flex-shrink-0">{formatValue(value)}</span>
            </div>
            <div className="h-2.5 rounded-full bg-gray-100 overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${Math.max((value / max) * 100, 4)}%`, background: color }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Section({ title, subtitle, icon: Icon, children }: { title: string; subtitle?: string; icon?: any; children: ReactNode }) {
  return (
    <section className="rounded-2xl bg-white p-5" style={{ boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>
      <div className="flex items-center justify-between gap-3 mb-5">
        <div>
          <h2 className="text-base font-black text-gray-900">{title}</h2>
          {subtitle && <p className="text-sm text-gray-500 mt-1">{subtitle}</p>}
        </div>
        {Icon && <Icon className="w-5 h-5 text-blue-600 flex-shrink-0" />}
      </div>
      {children}
    </section>
  );
}

export default function DataAnalytics() {
  const [searchParams] = useSearchParams();
  const initialProjectId = searchParams.get('project') || searchParams.get('project_id') || '';
  const [options, setOptions] = useState<OptionsPayload>(emptyOptions);
  const [filters, setFilters] = useState<FiltersState>(emptyFilters(initialProjectId));
  const [summary, setSummary] = useState<Summary | null>(null);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);
  const [quotesLoading, setQuotesLoading] = useState(false);
  const [showForm, setShowForm] = useState(searchParams.get('addQuote') === '1');
  const [form, setForm] = useState<QuoteFormState>(emptyForm(initialProjectId));
  const [lineItems, setLineItems] = useState<QuoteLineItem[]>([emptyLineItem()]);
  const [quoteFile, setQuoteFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedPropertyId, setSelectedPropertyId] = useState(initialProjectId);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedContractor, setSelectedContractor] = useState('');

  const categoryByName = useMemo(() => new Map(options.categories.map(category => [category.name, category])), [options.categories]);
  const categoriesByGroup = useMemo(() => {
    const grouped = new Map<string, QuoteCategory[]>();
    for (const category of options.categories) {
      const list = grouped.get(category.category_group) || [];
      list.push(category);
      grouped.set(category.category_group, list);
    }
    return Array.from(grouped.entries());
  }, [options.categories]);

  const loadOptions = async () => {
    const res = await api.get('/quote-analytics/options');
    setOptions(res.data || emptyOptions);
    setLineItems(current => current.map(item => item.category ? item : { ...item, category: res.data?.categories?.[0]?.name || '' }));
  };

  const loadAnalytics = async () => {
    setQuotesLoading(true);
    try {
      const query = buildQuery(filters);
      const [summaryRes, quoteRes] = await Promise.all([
        api.get(`/quote-analytics/summary${query ? `?${query}` : ''}`),
        api.get(`/quote-analytics/quotes?limit=200${query ? `&${query}` : ''}`),
      ]);
      setSummary(summaryRes.data);
      setQuotes(Array.isArray(quoteRes.data?.quotes) ? quoteRes.data.quotes : []);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to load quote analytics');
    } finally {
      setLoading(false);
      setQuotesLoading(false);
    }
  };

  useEffect(() => {
    loadOptions().catch(() => {
      setLoading(false);
      toast.error('Failed to load analytics options');
    });
  }, []);

  useEffect(() => {
    loadAnalytics();
  }, [filters]);

  const updateFilter = (key: keyof FiltersState, value: string) => {
    setFilters(current => ({ ...current, [key]: value }));
  };

  const resetFilters = () => {
    setFilters(emptyFilters());
    setSelectedPropertyId('');
    setSelectedCategory('');
    setSelectedContractor('');
  };

  const openForm = (projectId = filters.project_id) => {
    const defaultCategory = options.categories[0]?.name || '';
    setForm(emptyForm(projectId));
    setLineItems([emptyLineItem(defaultCategory)]);
    setQuoteFile(null);
    setShowForm(true);
  };

  const chooseContractor = (contractorId: string) => {
    const contractor = options.contractors.find(item => item.id === contractorId);
    setForm(current => ({
      ...current,
      contractor_profile_id: contractorId,
      contractor_company: contractor?.vendor_name || current.contractor_company,
      contractor_name: contractor?.contact_name || contractor?.vendor_name || current.contractor_name,
      contractor_email: contractor?.email || current.contractor_email,
      contractor_phone: contractor?.phone || current.contractor_phone,
      contractor_address: contractor?.billing_address || current.contractor_address,
    }));
  };

  const updateLineItem = (index: number, patch: Partial<QuoteLineItem>) => {
    setLineItems(current => current.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      const next = { ...item, ...patch };
      const quantity = numberValue(next.quantity || 1);
      const unitPrice = numberValue(next.unit_price);
      if ((patch.quantity !== undefined || patch.unit_price !== undefined) && !next.total_line_item_price) {
        next.total_line_item_price = quantity * unitPrice;
      }
      const category = categoryByName.get(String(next.category || ''));
      if (category) next.category_group = category.category_group;
      return next;
    }));
  };

  const calculatedLineTotal = lineItems.reduce((sum, item) => sum + numberValue(item.total_line_item_price), 0);

  const submitQuote = async () => {
    if (!form.project_id) return toast.error('Select a property');
    if (!form.contractor_name && !form.contractor_company) return toast.error('Enter a contractor');
    if (lineItems.some(item => !item.category || !numberValue(item.total_line_item_price))) {
      return toast.error('Each line item needs a category and price');
    }

    setSaving(true);
    try {
      const projectQuoteBase = form.project_id ? `/projects/${form.project_id}/quotes` : '/quote-analytics/quotes';
      const payload = {
        ...form,
        total_quote_amount: form.total_quote_amount || String(calculatedLineTotal),
        line_items: lineItems,
      };

      if (quoteFile) {
        const body = new FormData();
        Object.entries(payload).forEach(([key, value]) => {
          body.append(key, key === 'line_items' ? JSON.stringify(value) : String(value ?? ''));
        });
        body.append('quote_file', quoteFile);
        await api.post(`${projectQuoteBase}/upload`, body, { headers: { 'Content-Type': 'multipart/form-data' } });
      } else {
        await api.post(projectQuoteBase, payload);
      }

      toast.success('Quote uploaded for this property and added to master analytics');
      setShowForm(false);
      await loadAnalytics();
    } catch (err: any) {
      const errors = err.response?.data?.errors;
      toast.error(Array.isArray(errors) ? errors[0] : err.response?.data?.error || 'Failed to save quote');
    } finally {
      setSaving(false);
    }
  };

  if (loading && !summary) return <Loading />;

  const metrics = summary?.metrics;
  const selectedProperty = summary?.by_property.find(row => row.project_id === selectedPropertyId) || null;
  const selectedPropertyQuotes = quotes.filter(quote => quote.project_id === selectedPropertyId);
  const selectedCategoryRows = summary?.category_by_year.filter(row => row.category === selectedCategory) || [];
  const selectedCategoryQuotes = quotes.filter(quote => quote.line_items.some(item => item.category === selectedCategory));
  const selectedContractorQuotes = quotes.filter(quote => (quote.contractor_company || quote.contractor_name) === selectedContractor);

  const metricCards = [
    { label: 'Total Quotes Uploaded', value: String(metrics?.total_quotes_uploaded || 0), sub: `${metrics?.historical_records_count || 0} immutable records`, icon: FileText, color: '#2563EB', bg: '#EFF6FF' },
    { label: 'Total Quoted Value', value: money(metrics?.total_quoted_value), sub: `Median ${money(metrics?.median_quote_amount)}`, icon: CircleDollarSign, color: '#059669', bg: '#ECFDF5' },
    { label: 'Contractors', value: String(metrics?.contractors_count || 0), sub: `${metrics?.properties_count || 0} properties quoted`, icon: BriefcaseBusiness, color: '#B45309', bg: '#FFFBEB' },
    { label: 'Average Quote', value: money(metrics?.average_quote_amount), sub: `Low ${money(metrics?.lowest_quote)} / High ${money(metrics?.highest_quote)}`, icon: WalletCards, color: '#DC2626', bg: '#FEF2F2' },
    { label: 'Active Projects', value: String(metrics?.active_projects || 0), sub: `${metrics?.line_item_records || 0} normalized line items`, icon: CheckCircle2, color: '#7C3AED', bg: '#F5F3FF' },
  ];

  return (
    <div className="min-h-full px-6 py-6 md:px-8" style={{ background: '#F0F2F5' }}>
      <div className="max-w-7xl mx-auto space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-black bg-gray-900 text-white mb-3">
              <BarChart3 className="w-3.5 h-3.5" />
              Master Quote Intelligence
            </div>
            <h1 className="text-2xl font-black text-gray-900 tracking-tight">Data Analytics</h1>
            <p className="text-sm text-gray-500 mt-1">Centralized contractor quote history, pricing trends, category benchmarks, and property-level bid tracking</p>
          </div>
          <button
            type="button"
            onClick={() => openForm()}
            className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-gray-900 text-white text-sm font-black hover:bg-gray-800"
          >
            <Plus className="w-4 h-4" />
            Add Quote To A Single Project
          </button>
        </div>

        <section className="rounded-2xl bg-white p-4" style={{ boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>
          <div className="flex items-center gap-2 mb-4">
            <Filter className="w-4 h-4 text-gray-500" />
            <h2 className="text-sm font-black text-gray-900">Filters</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            <select value={filters.year} onChange={event => updateFilter('year', event.target.value)} className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm bg-white">
              <option value="">All years</option>
              {options.years.map(year => <option key={year} value={year}>{year}</option>)}
            </select>
            <select value={filters.project_id} onChange={event => { updateFilter('project_id', event.target.value); setSelectedPropertyId(event.target.value); }} className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm bg-white">
              <option value="">All properties</option>
              {options.projects.map(project => <option key={project.id} value={project.id}>{project.address}</option>)}
            </select>
            <select value={filters.category} onChange={event => { updateFilter('category', event.target.value); setSelectedCategory(event.target.value); }} className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm bg-white">
              <option value="">All categories</option>
              {options.categories.map(category => <option key={category.id} value={category.name}>{category.category_group} / {category.name}</option>)}
            </select>
            <select value={filters.status} onChange={event => updateFilter('status', event.target.value)} className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm bg-white">
              <option value="">All statuses</option>
              {options.statuses.map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}
            </select>
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-gray-200">
              <Search className="w-4 h-4 text-gray-400" />
              <input value={filters.contractor} onChange={event => updateFilter('contractor', event.target.value)} placeholder="Contractor search" className="w-full text-sm outline-none" />
            </div>
            <input type="date" value={filters.start_date} onChange={event => updateFilter('start_date', event.target.value)} className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
            <input type="date" value={filters.end_date} onChange={event => updateFilter('end_date', event.target.value)} className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
            <div className="grid grid-cols-2 gap-2">
              <input value={filters.min_cost} onChange={event => updateFilter('min_cost', event.target.value)} placeholder="Min cost" className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
              <input value={filters.max_cost} onChange={event => updateFilter('max_cost', event.target.value)} placeholder="Max cost" className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
            </div>
          </div>
          <div className="flex justify-end mt-3">
            <button type="button" onClick={resetFilters} className="px-3 py-2 rounded-xl text-xs font-black text-gray-600 bg-gray-100 hover:bg-gray-200">
              Reset Filters
            </button>
          </div>
        </section>

        {showForm && (
          <section className="rounded-2xl bg-white p-5" style={{ boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>
            <div className="flex items-center justify-between gap-3 mb-5">
              <div>
                <h2 className="text-base font-black text-gray-900">Add Quote To A Single Project</h2>
                <p className="text-sm text-gray-500 mt-1">Select one property and enter quote line items for any standardized construction category.</p>
              </div>
              <button type="button" onClick={() => setShowForm(false)} className="p-2 rounded-xl text-gray-500 hover:bg-gray-100">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="space-y-3">
                <select value={form.project_id} onChange={event => setForm(current => ({ ...current, project_id: event.target.value }))} className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm bg-white">
                  <option value="">Select single project / property</option>
                  {options.projects.map(project => <option key={project.id} value={project.id}>{project.address}</option>)}
                </select>
                <select value={form.contractor_profile_id} onChange={event => chooseContractor(event.target.value)} className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm bg-white">
                  <option value="">Select contractor profile</option>
                  {options.contractors.map(contractor => <option key={contractor.id} value={contractor.id}>{contractor.vendor_name}</option>)}
                </select>
                <input value={form.contractor_name} onChange={event => setForm(current => ({ ...current, contractor_name: event.target.value }))} placeholder="Contractor name" className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
                <input value={form.contractor_company} onChange={event => setForm(current => ({ ...current, contractor_company: event.target.value }))} placeholder="Contractor company" className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
                <input value={form.contractor_address} onChange={event => setForm(current => ({ ...current, contractor_address: event.target.value }))} placeholder="Contractor address" className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
                <div className="grid grid-cols-2 gap-2">
                  <input value={form.contractor_email} onChange={event => setForm(current => ({ ...current, contractor_email: event.target.value }))} placeholder="Email" className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
                  <input value={form.contractor_phone} onChange={event => setForm(current => ({ ...current, contractor_phone: event.target.value }))} placeholder="Phone" className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
                </div>
              </div>

              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <input type="date" value={form.quote_date} onChange={event => setForm(current => ({ ...current, quote_date: event.target.value }))} className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
                  <select value={form.status} onChange={event => setForm(current => ({ ...current, status: event.target.value }))} className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm bg-white">
                    {options.statuses.map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}
                  </select>
                </div>
                <textarea value={form.scope_description} onChange={event => setForm(current => ({ ...current, scope_description: event.target.value }))} placeholder="Scope description" rows={3} className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm resize-none" />
                <textarea value={form.notes} onChange={event => setForm(current => ({ ...current, notes: event.target.value }))} placeholder="Notes" rows={3} className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm resize-none" />
                <label className="flex items-center justify-center gap-2 px-3 py-3 rounded-xl border border-dashed border-gray-300 text-sm font-black text-gray-600 cursor-pointer hover:bg-gray-50">
                  <Upload className="w-4 h-4" />
                  {quoteFile ? quoteFile.name : 'Attach quote document'}
                  <input type="file" className="hidden" onChange={event => setQuoteFile(event.target.files?.[0] || null)} />
                </label>
              </div>

              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <input value={form.total_quote_amount} onChange={event => setForm(current => ({ ...current, total_quote_amount: event.target.value }))} placeholder={`Total (${money(calculatedLineTotal)})`} className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
                  <input value={form.final_approved_amount} onChange={event => setForm(current => ({ ...current, final_approved_amount: event.target.value }))} placeholder="Final approved" className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
                  <input value={form.labor_cost} onChange={event => setForm(current => ({ ...current, labor_cost: event.target.value }))} placeholder="Labor cost" className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
                  <input value={form.material_cost} onChange={event => setForm(current => ({ ...current, material_cost: event.target.value }))} placeholder="Material cost" className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
                  <input value={form.permit_costs} onChange={event => setForm(current => ({ ...current, permit_costs: event.target.value }))} placeholder="Permits" className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
                  <input value={form.equipment_costs} onChange={event => setForm(current => ({ ...current, equipment_costs: event.target.value }))} placeholder="Equipment" className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
                  <input value={form.disposal_cleanup_costs} onChange={event => setForm(current => ({ ...current, disposal_cleanup_costs: event.target.value }))} placeholder="Disposal/cleanup" className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
                  <input value={form.tax} onChange={event => setForm(current => ({ ...current, tax: event.target.value }))} placeholder="Tax" className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
                  <input value={form.insurance} onChange={event => setForm(current => ({ ...current, insurance: event.target.value }))} placeholder="Insurance" className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
                  <input value={form.overhead} onChange={event => setForm(current => ({ ...current, overhead: event.target.value }))} placeholder="Overhead" className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
                  <input value={form.profit_margin} onChange={event => setForm(current => ({ ...current, profit_margin: event.target.value }))} placeholder="Profit margin" className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
                  <input value={form.contingency} onChange={event => setForm(current => ({ ...current, contingency: event.target.value }))} placeholder="Contingency" className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
                </div>
              </div>
            </div>

            <div className="mt-5 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-black text-gray-900">Category Quote Line Items</h3>
                  <p className="text-xs text-gray-500 mt-0.5">Add as many category lines as needed for this single project quote.</p>
                </div>
                <button type="button" onClick={() => setLineItems(current => [...current, emptyLineItem(options.categories[0]?.name || '')])} className="px-3 py-2 rounded-xl text-xs font-black text-blue-700 bg-blue-50">
                  Add Another Category
                </button>
              </div>
              {lineItems.map((item, index) => (
                <div key={index} className="grid grid-cols-1 md:grid-cols-6 gap-2">
                  <select value={item.category} onChange={event => updateLineItem(index, { category: event.target.value })} className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm bg-white">
                    <option value="">Category</option>
                    {categoriesByGroup.map(([group, categories]) => (
                      <optgroup key={group} label={group}>
                        {categories.map(category => (
                          <option key={category.id} value={category.name}>{category.name}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <input value={item.subcategory || ''} onChange={event => updateLineItem(index, { subcategory: event.target.value })} placeholder="Subcategory" className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
                  <input value={item.description} onChange={event => updateLineItem(index, { description: event.target.value })} placeholder="Description" className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm md:col-span-2" />
                  <input value={item.quantity} onChange={event => updateLineItem(index, { quantity: event.target.value })} placeholder="Qty" className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
                  <div className="flex gap-2">
                    <input value={item.total_line_item_price} onChange={event => updateLineItem(index, { total_line_item_price: event.target.value })} placeholder="Total" className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm" />
                    {lineItems.length > 1 && (
                      <button type="button" onClick={() => setLineItems(current => current.filter((_, i) => i !== index))} className="px-3 rounded-xl bg-red-50 text-red-700">
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2 mt-5">
              <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2.5 rounded-xl text-sm font-black bg-gray-100 text-gray-700">Cancel</button>
              <button type="button" disabled={saving} onClick={submitQuote} className="px-4 py-2.5 rounded-xl text-sm font-black bg-gray-900 text-white disabled:opacity-60">
                {saving ? 'Saving...' : 'Save Quote'}
              </button>
            </div>
          </section>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
          {metricCards.map(card => <MetricCard key={card.label} {...card} />)}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          <Section title="Yearly Construction Pricing Trends" subtitle="Average quote movement by year" icon={LineChart}>
            <HorizontalBars rows={summary?.by_year || []} valueKey="average" formatValue={money} color="#2563EB" />
            <div className="mt-4 space-y-2">
              {(summary?.by_year || []).map(row => (
                <div key={row.key} className="flex items-center justify-between text-xs text-gray-500">
                  <span>{row.key} YOY change</span>
                  <span className={`font-black ${Number(row.yoy_change_percent || 0) >= 0 ? 'text-red-600' : 'text-emerald-600'}`}>{percent(row.yoy_change_percent || 0)}</span>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Top Expensive Categories" subtitle="Normalized category totals across all quotes" icon={TrendingUp}>
            <HorizontalBars rows={(summary?.by_category || []).slice(0, 10)} formatValue={money} color="#D97706" />
          </Section>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
          <Section title="Contractor Ranking Analysis" subtitle="Pricing volume and award rate" icon={BriefcaseBusiness}>
            <div className="space-y-3">
              {(summary?.by_contractor || []).slice(0, 8).map(row => (
                <button key={row.key} type="button" onClick={() => setSelectedContractor(row.key)} className="w-full text-left rounded-xl border border-gray-100 p-3 hover:bg-gray-50">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-black text-gray-900 truncate">{row.key}</p>
                    <p className="text-sm font-black text-gray-900">{money(row.average)}</p>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{row.count} quotes · {row.award_rate || 0}% award rate</p>
                </button>
              ))}
            </div>
          </Section>

          <Section title="Labor vs Material" subtitle={`Ratio ${Number(metrics?.labor_material_ratio || 0).toFixed(2)}`} icon={WalletCards}>
            <HorizontalBars rows={summary?.labor_material_breakdown || []} formatValue={money} color="#059669" />
          </Section>

          <Section title="Historical Quote Volume" subtitle="Upload and entry count by year" icon={BarChart3}>
            <HorizontalBars rows={summary?.quote_volume_by_year || []} valueKey="count" labelKey="year" formatValue={value => String(value)} color="#7C3AED" />
          </Section>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          <Section title="Property Spend Over Time" subtitle="Select a property for quote drilldown" icon={BriefcaseBusiness}>
            <div className="space-y-3">
              {(summary?.by_property || []).slice(0, 12).map(row => (
                <button key={row.project_id} type="button" onClick={() => setSelectedPropertyId(row.project_id)} className={`w-full text-left rounded-xl border p-3 hover:bg-gray-50 ${selectedPropertyId === row.project_id ? 'border-blue-300 bg-blue-50' : 'border-gray-100'}`}>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-black text-gray-900 truncate">{row.property_address}</p>
                    <p className="text-sm font-black text-gray-900">{money(row.total)}</p>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{row.project_name} · {row.count} quotes</p>
                </button>
              ))}
            </div>
          </Section>

          <Section title="Average Category Cost Changes" subtitle="Latest year versus prior year" icon={TrendingUp}>
            <div className="space-y-3">
              {(summary?.category_cost_changes || []).slice(0, 12).map(row => (
                <button key={row.category} type="button" onClick={() => setSelectedCategory(row.category)} className={`w-full text-left rounded-xl border p-3 hover:bg-gray-50 ${selectedCategory === row.category ? 'border-amber-300 bg-amber-50' : 'border-gray-100'}`}>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-black text-gray-900 truncate">{row.category}</p>
                    <p className={`text-sm font-black ${row.change_percent >= 0 ? 'text-red-600' : 'text-emerald-600'}`}>{percent(row.change_percent)}</p>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{row.latest_year || 'No year'} avg {money(row.latest_average)} · {row.count} line items</p>
                </button>
              ))}
            </div>
          </Section>
        </div>

        {(selectedProperty || selectedPropertyQuotes.length > 0) && (
          <Section title="Property Drilldown" subtitle={selectedProperty?.property_address || 'Selected property'} icon={BriefcaseBusiness}>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
              <MetricCard label="Property Total" value={money(selectedProperty?.total || 0)} sub={`${selectedProperty?.count || selectedPropertyQuotes.length} quotes`} icon={CircleDollarSign} color="#2563EB" bg="#EFF6FF" />
              <MetricCard label="Average Quote" value={money(selectedProperty?.average || 0)} sub={`Median ${money(selectedProperty?.median || 0)}`} icon={WalletCards} color="#059669" bg="#ECFDF5" />
              <MetricCard label="Lowest Quote" value={money(selectedProperty?.low || 0)} sub={`Highest ${money(selectedProperty?.high || 0)}`} icon={TrendingUp} color="#B45309" bg="#FFFBEB" />
              <button type="button" onClick={() => openForm(selectedPropertyId)} className="rounded-2xl bg-gray-900 text-white p-5 text-left">
                <Plus className="w-5 h-5 mb-3" />
                <p className="text-sm font-black">Add Quote To This Single Project</p>
              </button>
            </div>
            <QuoteMiniTable quotes={selectedPropertyQuotes} />
          </Section>
        )}

        {selectedCategory && (
          <Section title="Category Drilldown" subtitle={selectedCategory} icon={BarChart3}>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
              <HorizontalBars rows={selectedCategoryRows.map(row => ({ key: row.year, total: row.average }))} formatValue={money} color="#D97706" />
              <QuoteMiniTable quotes={selectedCategoryQuotes.slice(0, 8)} />
            </div>
          </Section>
        )}

        {selectedContractor && (
          <Section title="Contractor Analytics" subtitle={selectedContractor} icon={BriefcaseBusiness}>
            <QuoteMiniTable quotes={selectedContractorQuotes.slice(0, 10)} />
          </Section>
        )}

        <Section title="Master Analytics Table" subtitle={`${quotes.length} visible records${quotesLoading ? ' · refreshing' : ''}`} icon={FileText}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1120px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-100">
                  <th className="py-3 pr-3">Property</th>
                  <th className="py-3 pr-3">Contractor</th>
                  <th className="py-3 pr-3">Date</th>
                  <th className="py-3 pr-3">Year</th>
                  <th className="py-3 pr-3">Category</th>
                  <th className="py-3 pr-3">Scope</th>
                  <th className="py-3 pr-3 text-right">Total Quote</th>
                  <th className="py-3 pr-3">Status</th>
                  <th className="py-3 pr-3">Document</th>
                  <th className="py-3">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {quotes.map(quote => (
                  <tr key={quote.id} className="align-top">
                    <td className="py-3 pr-3">
                      <p className="font-black text-gray-900">{quote.property_address}</p>
                      <p className="text-xs text-gray-500">{quote.project_name}</p>
                    </td>
                    <td className="py-3 pr-3">
                      <p className="font-bold text-gray-800">{quote.contractor_company || quote.contractor_name}</p>
                      <p className="text-xs text-gray-500">{quote.contractor_name}</p>
                      {quote.contractor_address && <p className="text-xs text-gray-400 line-clamp-1">{quote.contractor_address}</p>}
                    </td>
                    <td className="py-3 pr-3">{quote.quote_date}</td>
                    <td className="py-3 pr-3">{quote.quote_year}</td>
                    <td className="py-3 pr-3 min-w-[190px]">
                      <div className="space-y-1">
                        {(quote.line_items || []).slice(0, 4).map(item => (
                          <div key={item.id || `${quote.id}-${item.category}`} className="flex items-center justify-between gap-2 rounded-lg bg-gray-50 px-2 py-1">
                            <span className="font-bold text-gray-700 truncate">{item.category}</span>
                            <span className="text-xs font-black text-gray-900">{money(item.total_line_item_price)}</span>
                          </div>
                        ))}
                        {(quote.line_items || []).length === 0 && <span className="text-gray-400">-</span>}
                        {(quote.line_items || []).length > 4 && <p className="text-xs text-gray-400">+{(quote.line_items || []).length - 4} more lines</p>}
                      </div>
                    </td>
                    <td className="py-3 pr-3 max-w-[220px]">
                      <p className="line-clamp-2">{quote.scope_description || quote.line_items[0]?.description || '-'}</p>
                    </td>
                    <td className="py-3 pr-3 text-right font-black">{money(quote.total_quote_amount)}</td>
                    <td className="py-3 pr-3">
                      <span className="inline-flex px-2 py-1 rounded-full text-xs font-black bg-gray-100 text-gray-700">{statusLabel(quote.status)}</span>
                    </td>
                    <td className="py-3 pr-3">
                      {quote.document_download_url ? (
                        <a href={quote.document_download_url} className="text-blue-700 font-black hover:underline">Download</a>
                      ) : <span className="text-gray-400">None</span>}
                    </td>
                    <td className="py-3 text-xs text-gray-500">{formatEasternDateTime(quote.updated_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {quotes.length === 0 && (
              <div className="text-center py-12">
                <FileText className="w-9 h-9 text-gray-300 mx-auto mb-2" />
                <p className="text-sm font-bold text-gray-400">No quote records match the current filters</p>
              </div>
            )}
          </div>
        </Section>
      </div>
    </div>
  );
}

function QuoteMiniTable({ quotes }: { quotes: Quote[] }) {
  if (quotes.length === 0) return <p className="text-sm text-gray-400">No quote records in this drilldown</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-100">
            <th className="py-2 pr-3">Quote</th>
            <th className="py-2 pr-3">Contractor</th>
            <th className="py-2 pr-3">Date</th>
            <th className="py-2 pr-3 text-right">Total</th>
            <th className="py-2">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {quotes.map(quote => (
            <Fragment key={quote.id}>
              <tr>
                <td className="py-2 pr-3 font-black text-gray-900">{quote.quote_number}</td>
                <td className="py-2 pr-3">
                  <p>{quote.contractor_company || quote.contractor_name}</p>
                  {quote.contractor_address && <p className="text-xs text-gray-400">{quote.contractor_address}</p>}
                </td>
                <td className="py-2 pr-3">{quote.quote_date}</td>
                <td className="py-2 pr-3 text-right font-black">{money(quote.total_quote_amount)}</td>
                <td className="py-2">{statusLabel(quote.status)}</td>
              </tr>
              {(quote.line_items || []).length > 0 && (
                <tr className="bg-gray-50/60">
                  <td colSpan={5} className="py-2 px-3">
                    <div className="grid md:grid-cols-2 gap-2">
                      {(quote.line_items || []).map(item => (
                        <div key={item.id || `${quote.id}-${item.category}-${item.description}`} className="flex items-center justify-between gap-3 rounded-lg bg-white border border-gray-100 px-3 py-2">
                          <div className="min-w-0">
                            <p className="text-xs font-black text-gray-900 truncate">{item.category}</p>
                            <p className="text-xs text-gray-500 truncate">{item.description || item.subcategory || 'Quote line item'}</p>
                          </div>
                          <p className="text-xs font-black text-gray-900 flex-shrink-0">{money(item.total_line_item_price)}</p>
                        </div>
                      ))}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
