import api from './api';

// Thin client over the EXISTING /api/quote-analytics endpoints (management-gated).
// No new backend concepts — this only adds typed helpers for the global Quote Center.

export interface QuoteLineItem {
  id?: string;
  quote_id?: string;
  category?: string;
  category_group?: string;
  subcategory?: string;
  description?: string;
  quantity?: number;
  unit?: string | null;
  unit_price?: number;
  total_line_item_price?: number;
  labor_amount?: number;
  material_amount?: number;
}

export interface ContractorQuote {
  id: string;
  quote_number: string;
  project_id: string;
  property_address?: string;
  project_name?: string;
  contractor_name: string;
  contractor_company?: string | null;
  contractor_email?: string | null;
  contractor_phone?: string | null;
  status: string;
  quote_date: string;
  quote_year?: number;
  scope_description?: string;
  notes?: string | null;
  total_quote_amount: number;
  final_approved_amount?: number | null;
  source_file_name?: string | null;
  source_file_mime_type?: string | null;
  document_download_url?: string | null;
  document_original_name?: string | null;
  uploaded_by_name?: string | null;
  line_items?: QuoteLineItem[];
  created_at?: string;
  updated_at?: string;
}

export interface QuoteCategory {
  id: string;
  category_group: string;
  name: string;
  normalized_key: string;
}

export interface QuoteOptionProject {
  id: string;
  address: string;
  job_name: string;
  status: string;
}

export interface QuoteOptions {
  categories: QuoteCategory[];
  projects: QuoteOptionProject[];
  contractors: Array<Record<string, unknown>>;
  years: number[];
  statuses: string[];
}

export interface QuoteListResponse {
  page: number;
  limit: number;
  total: number;
  quotes: ContractorQuote[];
}

export interface QuoteListParams {
  project_id?: string;
  status?: string;
  quote_filter?: 'review' | 'approved' | 'database';
  contractor?: string;
  category?: string;
  start_date?: string;
  end_date?: string;
  min_cost?: number | string;
  max_cost?: number | string;
  year?: number | string;
  page?: number;
  limit?: number;
}

export interface CompareContractor {
  quote_id: string;
  quote_number: string;
  contractor_name: string;
  contractor_company?: string | null;
  contractor_email?: string | null;
  status: string;
  quote_date: string;
  total_quote_amount: number;
  final_approved_amount: number | null;
  data_quality_flags: string[];
  line_item_count: number;
  has_document?: boolean;
  source_file_name?: string | null;
  source_file_mime_type?: string | null;
}

export interface CompareCell {
  amount: number | null;
  present: boolean;
  line_items: QuoteLineItem[];
}

export interface CompareRow {
  category: string;
  category_group: string;
  cells: Record<string, CompareCell>;
  present_count: number;
  missing_quote_ids: string[];
  has_missing: boolean;
  low: number;
  high: number;
  average: number;
  spread: number;
}

export interface CompareResponse {
  project: { id: string; address: string; job_name: string; budget: number | null; square_footage: number | null };
  category_filter: string | null;
  contractors: CompareContractor[];
  rows: CompareRow[];
  totals: {
    by_quote: Record<string, number>;
    low: number;
    high: number;
    average: number;
    price_per_sqft_by_quote: Record<string, number> | null;
  };
}

export interface ActivityRow {
  id: string;
  user_name: string;
  action: string;
  entity_type?: string | null;
  entity_id?: string | null;
  details?: string | null;
  created_at: string;
  project_id?: string | null;
  project_address?: string | null;
  project_job_name?: string | null;
}

export async function fetchQuoteOptions(): Promise<QuoteOptions> {
  const res = await api.get('/quote-analytics/options');
  return res.data as QuoteOptions;
}

export async function fetchQuoteSummary(params: Record<string, string> = {}): Promise<any> {
  const res = await api.get('/quote-analytics/summary', { params });
  return res.data;
}

export async function fetchQuotes(params: QuoteListParams = {}): Promise<QuoteListResponse> {
  const res = await api.get('/quote-analytics/quotes', { params });
  return res.data as QuoteListResponse;
}

export async function fetchBidComparison(params: {
  project_id: string;
  category?: string;
  include_historical?: string;
}): Promise<CompareResponse> {
  const res = await api.get('/quote-analytics/compare', { params });
  return res.data as CompareResponse;
}

export async function approveQuote(
  id: string,
  body: { final_approved_amount?: number; review_note?: string } = {}
): Promise<any> {
  const res = await api.post(`/quote-analytics/quotes/${id}/approve`, body);
  return res.data;
}

export async function denyQuote(id: string, body: { review_note?: string } = {}): Promise<any> {
  const res = await api.post(`/quote-analytics/quotes/${id}/deny`, body);
  return res.data;
}

// Permanently delete a quote (super_admin / operations_manager only, enforced server-side).
export async function deleteQuote(id: string): Promise<any> {
  const res = await api.delete(`/quote-analytics/quotes/${id}`);
  return res.data;
}

// Quote-only notes (not linked to project notes / activity feed).
export interface QuoteNote {
  id: string;
  note: string;
  user_id: string;
  user_name?: string;
  user_role?: string;
  user_avatar_url?: string | null;
  created_at: string;
}

export async function fetchQuoteNotes(quoteId: string): Promise<QuoteNote[]> {
  const res = await api.get(`/quote-analytics/quotes/${quoteId}/notes`);
  return res.data as QuoteNote[];
}

export async function addQuoteNote(quoteId: string, note: string): Promise<QuoteNote> {
  const res = await api.post(`/quote-analytics/quotes/${quoteId}/notes`, { note });
  return res.data as QuoteNote;
}

export async function deleteQuoteNote(quoteId: string, noteId: string): Promise<any> {
  const res = await api.delete(`/quote-analytics/quotes/${quoteId}/notes/${noteId}`);
  return res.data;
}

export async function createQuote(payload: Record<string, unknown>): Promise<any> {
  const res = await api.post('/quote-analytics/quotes', payload);
  return res.data;
}

// Modify an existing quote's header fields + line items.
export async function updateQuote(id: string, payload: Record<string, unknown>): Promise<any> {
  const res = await api.put(`/quote-analytics/quotes/${id}`, payload);
  return res.data;
}

export async function uploadQuote(formData: FormData): Promise<any> {
  const res = await api.post('/quote-analytics/quotes/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}

// Project-agnostic AI extraction — reads an uploaded PDF/image and returns structured
// fields to pre-fill the quote form. Works before a project is selected.
export async function extractQuote(formData: FormData): Promise<any> {
  const res = await api.post('/quote-analytics/extract', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}

// Project-scoped AI extraction (kept for the per-project tab / future use).
export async function extractQuoteFromFile(projectId: string, formData: FormData): Promise<any> {
  const res = await api.post(`/projects/${projectId}/quotes/extract`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}

export async function fetchQuoteActivity(): Promise<ActivityRow[]> {
  const res = await api.get('/activity');
  return res.data as ActivityRow[];
}
