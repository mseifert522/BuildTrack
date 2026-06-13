import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle, Building2, Camera, CheckCircle2, FileText, Loader2, Send, X } from 'lucide-react';

type QuoteCategory = {
  id: string;
  group: string;
  name: string;
};

type ScopePhoto = {
  id: string;
  url: string;
  original_name?: string | null;
  mime_type?: string | null;
  caption?: string | null;
  individual_note?: string | null;
  batch_note?: string | null;
};

type ScopeExecutionItem = {
  id: string;
  title: string;
  description?: string | null;
  category?: string | null;
  status?: string | null;
};

type VendorScope = {
  id: string;
  section_name?: string | null;
  scope_title: string;
  scope_of_work?: string | null;
  suggested_category?: string | null;
  execution_items?: ScopeExecutionItem[];
  photos?: ScopePhoto[];
};

type VendorQuotePayload = {
  request: {
    vendor_name: string;
    vendor_email: string;
    vendor_phone?: string;
    message?: string;
    include_photos: boolean;
    status: string;
    expires_at: string;
    submitted_at?: string | null;
  };
  project: {
    id: string;
    city?: string | null;
    label?: string | null;
  };
  scopes: VendorScope[];
  categories: QuoteCategory[];
};

type LineItemForm = {
  id: string;
  scope_id: string;
  description: string;
  amount: string;
  pricing_enabled: boolean;
};

const inputClass = 'w-full min-h-11 rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-base text-slate-950 outline-none transition focus:border-amber-500 focus:ring-4 focus:ring-amber-100 sm:text-sm';
const labelClass = 'mb-1 block text-xs font-black uppercase tracking-wide text-slate-600';

function requestDateLabel(value?: string | null) {
  if (!value) return 'Not provided';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function moneyValue(value: string | number) {
  const parsed = Number(String(value || '').replace(/[$,]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function currency(value: number) {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function sanitizeDollarInput(value: string) {
  const cleaned = String(value || '').replace(/[^\d.]/g, '');
  if (!cleaned) return '';
  const hasDecimal = cleaned.includes('.');
  const [wholeRaw, ...decimalParts] = cleaned.split('.');
  const whole = wholeRaw ? wholeRaw.replace(/^0+(?=\d)/, '') : (hasDecimal ? '0' : '');
  const decimals = decimalParts.join('').slice(0, 2);
  return hasDecimal ? `${whole || '0'}.${decimals}` : whole;
}

function formatDollarInput(value: string) {
  if (!String(value || '').trim()) return '';
  return currency(moneyValue(value));
}

function scopeLineItems(value?: string | null) {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/[•·]/g, '\n')
    .replace(/(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/g, '\n')
    .replace(/([.!?])\s+(?=[A-Z0-9])/g, '$1\n')
    .split(/\n+/)
    .map(item => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function scopeQuoteDescriptions(scope: VendorScope) {
  const writtenItems = scopeLineItems(scope.scope_of_work);
  if (writtenItems.length) return writtenItems;
  const executionItems = (scope.execution_items || [])
    .map(item => [item.title, item.description].filter(Boolean).join(' - ').trim())
    .filter(Boolean);
  return executionItems.length ? executionItems : [scope.scope_title || 'Scope quote'];
}

function fileSizeLabel(size?: number) {
  if (!size || size <= 0) return '';
  if (size < 1024 * 1024) return `${Math.max(size / 1024, 1).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function isImage(photo: ScopePhoto) {
  const mime = String(photo.mime_type || '').toLowerCase();
  const url = String(photo.url || '').toLowerCase();
  return mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|heic|avif)(\?|$)/.test(url);
}

function isVideo(photo: ScopePhoto) {
  const mime = String(photo.mime_type || '').toLowerCase();
  const url = String(photo.url || '').toLowerCase();
  return mime.startsWith('video/') || /\.(mp4|mov|webm|m4v)(\?|$)/.test(url);
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const isFormData = typeof FormData !== 'undefined' && options?.body instanceof FormData;
  const response = await fetch(url, {
    ...options,
    headers: isFormData
      ? { ...(options?.headers || {}) }
      : {
          'Content-Type': 'application/json',
          ...(options?.headers || {}),
        },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || 'Request failed');
  }
  return data;
}

export default function VendorQuoteRequest() {
  const { token = '' } = useParams();
  const [payload, setPayload] = useState<VendorQuotePayload | null>(null);
  const [lineItems, setLineItems] = useState<LineItemForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [submittedQuoteNumber, setSubmittedQuoteNumber] = useState('');
  const [closeNotice, setCloseNotice] = useState('');
  const [quotePdf, setQuotePdf] = useState<File | null>(null);
  const [form, setForm] = useState({
    contractor_name: '',
    contractor_company: '',
    contractor_email: '',
    contractor_phone: '',
    quote_date: new Date().toISOString().slice(0, 10),
    notes: '',
    pdf_total_amount: '',
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    fetchJson<VendorQuotePayload>(`/api/vendor-quote-requests/public/${encodeURIComponent(token)}`)
      .then(data => {
        if (cancelled) return;
        setPayload(data);
        setForm(current => ({
          ...current,
          contractor_name: data.request.vendor_name || '',
          contractor_company: data.request.vendor_name || '',
          contractor_email: data.request.vendor_email || '',
          contractor_phone: data.request.vendor_phone || '',
        }));
        setLineItems((data.scopes || []).flatMap(scope => (
          scopeQuoteDescriptions(scope).map((description, index) => ({
            id: `${scope.id}:${index}`,
            scope_id: scope.id,
            description,
            amount: '',
            pricing_enabled: false,
          }))
        )));
      })
      .catch(err => {
        if (!cancelled) setError(err.message || 'Quote request could not be loaded');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const total = useMemo(
    () => lineItems.reduce((sum, item) => sum + (item.pricing_enabled ? moneyValue(item.amount) : 0), 0),
    [lineItems]
  );
  const pdfTotal = moneyValue(form.pdf_total_amount);
  const submitTotal = total > 0 ? total : pdfTotal;
  const canSubmitQuote = total > 0 || pdfTotal > 0 || Boolean(quotePdf);
  const projectLabel = payload?.project.label || payload?.project.city || 'BuildTrack project';

  const updateLineItem = (lineItemId: string, patch: Partial<LineItemForm>) => {
    setLineItems(current => current.map(item => item.id === lineItemId ? { ...item, ...patch } : item));
  };

  const handlePdfChange = (file?: File | null) => {
    if (!file) {
      setQuotePdf(null);
      return;
    }
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      setQuotePdf(null);
      setError('Upload a PDF quote file.');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setQuotePdf(null);
      setError('PDF quote must be 20MB or smaller.');
      return;
    }
    setError('');
    setQuotePdf(file);
  };

  const submitQuote = async (event: FormEvent) => {
    event.preventDefault();
    if (!payload || submitting) return;
    if (payload.request.status === 'submitted') {
      setError('This quote request has already been submitted.');
      return;
    }
    if (!canSubmitQuote) {
      setError('Enter at least one price or attach a PDF quote before submitting.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const submission = {
        ...form,
        total_quote_amount: submitTotal,
        line_items: lineItems
          .filter(item => item.pricing_enabled && moneyValue(item.amount) > 0)
          .map(item => ({
            scope_id: item.scope_id,
            description: item.description,
            quantity: 1,
            unit: 'scope',
            unit_price: moneyValue(item.amount),
            total_line_item_price: moneyValue(item.amount),
          })),
      };
      const requestOptions: RequestInit = { method: 'POST' };
      if (quotePdf) {
        const body = new FormData();
        Object.entries(submission).forEach(([key, value]) => {
          body.append(key, key === 'line_items' ? JSON.stringify(value) : String(value ?? ''));
        });
        body.append('quote_pdf', quotePdf);
        requestOptions.body = body;
      } else {
        requestOptions.body = JSON.stringify(submission);
      }
      const response = await fetchJson<{ quote?: { quote_number?: string } }>(
        `/api/vendor-quote-requests/public/${encodeURIComponent(token)}/submit`,
        requestOptions
      );
      setSubmittedQuoteNumber(response.quote?.quote_number || 'submitted');
    } catch (err: any) {
      setError(err.message || 'Quote could not be submitted');
    } finally {
      setSubmitting(false);
    }
  };

  const setDollarFormField = (field: 'pdf_total_amount') => (value: string) => {
    setForm(current => ({ ...current, [field]: sanitizeDollarInput(value) }));
  };

  const formatDollarFormField = (field: 'pdf_total_amount') => {
    setForm(current => ({ ...current, [field]: formatDollarInput(current[field]) }));
  };

  const enableLineItemPricing = (lineItemId: string) => {
    updateLineItem(lineItemId, { pricing_enabled: true });
  };

  const clearLineItemPricing = (lineItemId: string) => {
    updateLineItem(lineItemId, { pricing_enabled: false, amount: '' });
  };

  const updateLineItemPrice = (lineItemId: string, value: string) => {
    updateLineItem(lineItemId, { amount: sanitizeDollarInput(value) });
  };

  const formatLineItemPrice = (lineItemId: string) => {
    setLineItems(current => current.map(item => (
      item.id === lineItemId ? { ...item, amount: formatDollarInput(item.amount) } : item
    )));
  };

  const closeQuoteWindow = () => {
    window.close();
    window.setTimeout(() => setCloseNotice('You can close this tab now.'), 150);
  };

  if (loading) {
    return (
      <main className="min-h-dvh bg-slate-100 px-4 py-10">
        <div className="mx-auto flex max-w-3xl items-center justify-center rounded-2xl border border-slate-200 bg-white p-10 shadow-sm">
          <Loader2 className="mr-3 h-5 w-5 animate-spin text-amber-600" />
          <span className="text-sm font-black text-slate-700">Loading quote request...</span>
        </div>
      </main>
    );
  }

  if (error && !payload) {
    return (
      <main className="min-h-dvh bg-slate-100 px-4 py-10">
        <div className="mx-auto max-w-2xl rounded-2xl border border-red-200 bg-white p-8 text-center shadow-sm">
          <AlertTriangle className="mx-auto mb-3 h-9 w-9 text-red-500" />
          <h1 className="text-xl font-black text-slate-950">Quote link unavailable</h1>
          <p className="mt-2 text-sm font-semibold text-slate-600">{error}</p>
        </div>
      </main>
    );
  }

  if (submittedQuoteNumber || payload?.request.status === 'submitted') {
    return (
      <main className="min-h-dvh bg-slate-100 px-4 py-10">
        <div className="mx-auto max-w-2xl rounded-2xl border border-emerald-200 bg-white p-8 text-center shadow-sm">
          <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-emerald-600" />
          <h1 className="text-2xl font-black text-slate-950">Quote submitted</h1>
          <p className="mt-2 text-sm font-semibold text-slate-600">
            Thank you. Your price has been sent to New Urban Development for review.
          </p>
          {submittedQuoteNumber && (
            <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-black text-emerald-800">
              Quote Number: {submittedQuoteNumber}
            </p>
          )}
          <button
            type="button"
            onClick={closeQuoteWindow}
            className="mt-4 inline-flex min-h-11 items-center justify-center rounded-xl bg-slate-950 px-5 text-sm font-black text-white transition hover:bg-slate-800"
          >
            Close Window
          </button>
          {closeNotice && <p className="mt-3 text-xs font-semibold text-slate-500">{closeNotice}</p>}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-slate-100 px-4 py-6 text-slate-950 sm:py-10">
      <form onSubmit={submitQuote} className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="space-y-5">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-black uppercase tracking-wide text-amber-800">
                  <Building2 className="h-3.5 w-3.5" />
                  Vendor quote request
                </p>
                <h1 className="mt-3 text-2xl font-black tracking-normal text-slate-950 sm:text-3xl">{projectLabel}</h1>
                <p className="mt-2 text-sm font-semibold leading-6 text-slate-600">
                  Review the selected scope of work and enter pricing for the sections you can perform.
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-left sm:text-right">
                <p className="text-xs font-black uppercase tracking-wide text-slate-500">Expires</p>
                <p className="text-sm font-black text-slate-900">{requestDateLabel(payload?.request.expires_at)}</p>
              </div>
            </div>
            {payload?.request.message && (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-xs font-black uppercase tracking-wide text-amber-800">Message from BuildTrack</p>
                <p className="mt-2 whitespace-pre-wrap text-sm font-semibold leading-6 text-amber-950">{payload.request.message}</p>
              </div>
            )}
          </div>

          <div className="space-y-4">
            {(payload?.scopes || []).map(scope => {
              const scopePricingItems = lineItems.filter(item => item.scope_id === scope.id);
              const detailItems = scopeQuoteDescriptions(scope);
              const scopeTotal = scopePricingItems.reduce((sum, item) => sum + (item.pricing_enabled ? moneyValue(item.amount) : 0), 0);
              return (
                <article key={scope.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                  <div className="border-b border-slate-200 bg-slate-950 p-4 text-white">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0">
                        <p className="text-xs font-black uppercase tracking-wide text-amber-300">{scope.section_name || 'Scope'}</p>
                        <h2 className="mt-1 text-lg font-black text-white">{scope.scope_title}</h2>
                      </div>
                      <div className="min-w-[160px] rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-right">
                        <p className="text-xs font-black uppercase tracking-wide text-slate-300">Scope total</p>
                        <strong className="mt-1 block text-lg font-black text-white">{currency(scopeTotal)}</strong>
                      </div>
                    </div>
                  </div>
                  <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_240px]">
                    <div className="space-y-4">
                      <div>
                        <p className="text-xs font-black uppercase tracking-wide text-slate-500">Scope details</p>
                        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm font-semibold leading-6 text-slate-700">
                          {detailItems.map((item, index) => (
                            <li key={`${scope.id}-detail-${index}`}>{item}</li>
                          ))}
                        </ol>
                      </div>
                      {(scope.execution_items || []).length > 0 && (
                        <div>
                          <p className="text-xs font-black uppercase tracking-wide text-slate-500">Execution lines</p>
                          <div className="mt-2 space-y-2">
                            {(scope.execution_items || []).map(item => (
                              <div key={item.id} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                                <p className="text-sm font-black text-slate-900">{item.title}</p>
                                {item.description && <p className="mt-1 text-xs font-semibold leading-5 text-slate-600">{item.description}</p>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <div>
                        <p className="text-xs font-black uppercase tracking-wide text-slate-500">Price itemization</p>
                        <p className="mt-1 text-sm font-semibold leading-6 text-slate-600">
                          If this quote requires individual itemized pricing, add a price next to the line item below. If not, enter one total price for the entire job in the Submit quote panel.
                        </p>
                        <div className="mt-2 space-y-2">
                          {scopePricingItems.map((lineItem, index) => (
                            <div key={lineItem.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                                <div className="min-w-0">
                                  <span className={labelClass}>Line {index + 1}</span>
                                  <p className="text-sm font-black leading-6 text-slate-950">{lineItem.description || 'Scope line item'}</p>
                                </div>
                                {lineItem.pricing_enabled ? (
                                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                                    <label className="min-w-[180px]">
                                      <span className={labelClass}>Price</span>
                                      <input
                                        inputMode="decimal"
                                        value={lineItem.amount || ''}
                                        onChange={event => updateLineItemPrice(lineItem.id, event.target.value)}
                                        onBlur={() => formatLineItemPrice(lineItem.id)}
                                        placeholder="$0.00"
                                        className={`${inputClass} font-black`}
                                      />
                                    </label>
                                    <button
                                      type="button"
                                      onClick={() => clearLineItemPricing(lineItem.id)}
                                      className="inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-300 bg-white px-3 text-xs font-black text-slate-700 transition hover:bg-slate-100"
                                    >
                                      Remove price
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => enableLineItemPricing(lineItem.id)}
                                    className="inline-flex min-h-11 items-center justify-center rounded-xl border border-amber-300 bg-amber-50 px-4 text-sm font-black text-amber-900 transition hover:bg-amber-100"
                                  >
                                    Add price field
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                    <aside>
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <p className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-wide text-slate-600">
                          <Camera className="h-3.5 w-3.5" />
                          Photos
                        </p>
                        {(scope.photos || []).length === 0 ? (
                          <p className="mt-3 text-xs font-semibold leading-5 text-slate-500">
                            No photos were attached to this scope.
                          </p>
                        ) : (
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            {(scope.photos || []).slice(0, 8).map(photo => (
                              <a
                                key={photo.id}
                                href={photo.url}
                                target="_blank"
                                rel="noreferrer"
                                className="group overflow-hidden rounded-lg border border-slate-200 bg-white"
                              >
                                <div className="aspect-square bg-slate-200">
                                  {isImage(photo) ? (
                                    <img src={photo.url} alt={photo.original_name || 'Scope photo'} className="h-full w-full object-cover transition group-hover:scale-105" loading="lazy" />
                                  ) : isVideo(photo) ? (
                                    <video src={photo.url} className="h-full w-full object-cover" muted playsInline preload="metadata" />
                                  ) : (
                                    <div className="flex h-full w-full items-center justify-center">
                                      <FileText className="h-7 w-7 text-slate-400" />
                                    </div>
                                  )}
                                </div>
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    </aside>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <aside className="lg:sticky lg:top-5 lg:self-start">
          <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div>
              <h2 className="text-base font-black text-slate-950">Submit quote</h2>
              <p className="mt-1 text-sm font-semibold text-slate-500">{currency(submitTotal)} total</p>
            </div>
            {error && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700">
                {error}
              </div>
            )}
            <div>
              <label className={labelClass} htmlFor="contractor_company">Company</label>
              <input id="contractor_company" value={form.contractor_company} onChange={event => setForm(current => ({ ...current, contractor_company: event.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className={labelClass} htmlFor="contractor_name">Contact name</label>
              <input id="contractor_name" value={form.contractor_name} onChange={event => setForm(current => ({ ...current, contractor_name: event.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className={labelClass} htmlFor="contractor_email">Email</label>
              <input id="contractor_email" type="email" value={form.contractor_email} onChange={event => setForm(current => ({ ...current, contractor_email: event.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className={labelClass} htmlFor="contractor_phone">Phone</label>
              <input id="contractor_phone" value={form.contractor_phone} onChange={event => setForm(current => ({ ...current, contractor_phone: event.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className={labelClass} htmlFor="quote_date">Quote date</label>
              <input id="quote_date" type="date" value={form.quote_date} onChange={event => setForm(current => ({ ...current, quote_date: event.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className={labelClass} htmlFor="notes">Notes</label>
              <textarea id="notes" value={form.notes} onChange={event => setForm(current => ({ ...current, notes: event.target.value }))} rows={4} className={`${inputClass} resize-y`} />
            </div>
            <div>
              <label className={labelClass} htmlFor="pdf_total_amount">Total quote amount</label>
              <input
                id="pdf_total_amount"
                inputMode="decimal"
                value={form.pdf_total_amount}
                onChange={event => setDollarFormField('pdf_total_amount')(event.target.value)}
                onBlur={() => formatDollarFormField('pdf_total_amount')}
                placeholder={total > 0 ? currency(total) : '$0.00'}
                className={inputClass}
              />
              <p className="mt-1 text-xs font-semibold leading-5 text-slate-500">Use this when submitting one total instead of itemizing every scope line.</p>
            </div>
            <div>
              <label className={labelClass} htmlFor="quote_pdf">PDF quote</label>
              <label
                htmlFor="quote_pdf"
                className="flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-sm font-black text-slate-700 transition hover:border-amber-300 hover:bg-amber-50"
              >
                <FileText className="h-4 w-4 text-amber-600" />
                <span className="min-w-0 truncate">{quotePdf ? quotePdf.name : 'Attach PDF quote'}</span>
              </label>
              <input
                id="quote_pdf"
                type="file"
                accept="application/pdf,.pdf"
                className="hidden"
                onChange={event => {
                  handlePdfChange(event.target.files?.[0] || null);
                  event.currentTarget.value = '';
                }}
              />
              {quotePdf && (
                <div className="mt-2 flex items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
                  <span className="min-w-0 truncate text-xs font-bold text-amber-900">{fileSizeLabel(quotePdf.size)}</span>
                  <button
                    type="button"
                    onClick={() => setQuotePdf(null)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-amber-800 hover:bg-amber-100"
                    aria-label="Remove PDF quote"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
            <button
              type="submit"
              disabled={submitting || !canSubmitQuote}
              className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 text-sm font-black text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {submitting ? 'Submitting...' : 'Submit Price'}
            </button>
          </div>
        </aside>
      </form>
    </main>
  );
}
