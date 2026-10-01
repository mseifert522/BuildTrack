import api from './api';

// The AI's check of how a document is filed (backend services/documentReview.js).
export type AiReviewStatus = 'pending' | 'reading' | 'verified' | 'corrected' | 'needs_review' | 'failed' | 'skipped';
export type AiEntityType = 'agreement' | 'quote';

export interface AiFinding {
  field: string;
  label: string;
  status: 'ok' | 'info' | 'corrected' | 'mismatch' | 'warning';
  message: string;
  suggest?: Record<string, unknown> | null;
}

export interface AiReviewSummary {
  status: AiReviewStatus;
  findings: AiFinding[];
  corrections?: number;
  summary?: string | null;
  error?: string | null;
  document_count?: number | null;
  reviewed_at?: string | null;
}

export interface AiReviewDetail {
  status: AiReviewStatus;
  mode: string;
  model: string | null;
  summary: string | null;
  error: string | null;
  entry_index: number | null;
  document_count: number | null;
  findings: AiFinding[];
  corrections: Array<{ field: string; before: Record<string, unknown>; after: Record<string, unknown>; by?: string }>;
  reviewed_at: string | null;
  documents: Array<{
    index: number;
    vendor: string;
    property: string;
    trade: string;
    doc_kind: string;
    total_amount: number | null;
    executed_date: string;
    document_date: string;
    signature_status: string;
    pages: string;
    summary: string;
  }>;
  file_summary: string | null;
  read_at: string | null;
}

export interface AiStatusSummary {
  active: boolean;
  counts: Partial<Record<AiReviewStatus, number>>;
  documents: { quotes: number; agreements: number };
  ai_available: boolean;
  model: string;
}

export const AI_STATUS_LABELS: Record<AiReviewStatus, string> = {
  pending: 'AI: waiting',
  reading: 'AI: reading…',
  verified: 'AI: verified',
  corrected: 'AI: corrected',
  needs_review: 'AI: check',
  failed: 'AI: could not read',
  skipped: 'AI: not read',
};

export const AI_STATUS_HELP: Record<AiReviewStatus, string> = {
  pending: 'The AI will read this document shortly.',
  reading: 'The AI is reading this document now.',
  verified: 'The AI read the document and it is filed correctly.',
  corrected: 'The AI read the document and corrected how it was filed (you can undo).',
  needs_review: 'The AI read the document and something does not match how it is filed.',
  failed: 'The AI could not read this document. Try again, or check it by hand.',
  skipped: 'This document was not read by the AI.',
};

export function aiIsBusy(status?: AiReviewStatus | null) {
  return status === 'pending' || status === 'reading';
}

export async function fetchAiReview(entityType: AiEntityType, entityId: string) {
  const res = await api.get<{ review: AiReviewDetail | null }>(`/document-reviews/${entityType}/${entityId}`);
  return res.data.review;
}

export async function rerunAiReview(entityType: AiEntityType, entityId: string, fresh = true) {
  const res = await api.post<{ review: AiReviewDetail | null }>(`/document-reviews/${entityType}/${entityId}/rerun`, { fresh });
  return res.data.review;
}

export async function applyAiReview(entityType: AiEntityType, entityId: string, fields: string[] = []) {
  const res = await api.post<{ applied: string[]; created: string[]; review: AiReviewDetail | null }>(`/document-reviews/${entityType}/${entityId}/apply`, { fields });
  return res.data;
}

export async function undoAiReview(entityType: AiEntityType, entityId: string) {
  const res = await api.post<{ undone: number; review: AiReviewDetail | null }>(`/document-reviews/${entityType}/${entityId}/undo`, {});
  return res.data;
}

export async function fetchAiStatus() {
  const res = await api.get<AiStatusSummary>('/document-reviews/status');
  return res.data;
}

export async function startAiBackfill(force = true) {
  const res = await api.post<{ queued: number; status: AiStatusSummary }>('/document-reviews/backfill', { force });
  return res.data;
}

// Parses the JSON findings column the quotes list carries.
export function parseFindings(raw?: string | null): AiFinding[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function attentionFindings(findings: AiFinding[]) {
  return findings.filter(f => f.status === 'mismatch' || f.status === 'warning' || f.status === 'corrected');
}
