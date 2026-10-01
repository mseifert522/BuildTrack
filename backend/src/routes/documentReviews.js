'use strict';
// AI document review API (services/documentReview.js): status of the re-read,
// one record's findings, apply the AI's reading, undo the AI's corrections, re-read
// one document, and re-read everything (super admin / operations manager).
const express = require('express');
const { getDb } = require('../db/schema');
const { authenticate, authorize } = require('../middleware/auth');
const { logActivity } = require('../utils/audit');
const documentReview = require('../services/documentReview');

const router = express.Router();
const MANAGEMENT_ROLES = ['super_admin', 'operations_manager', 'project_manager'];
const UPPER_ROLES = ['super_admin', 'operations_manager'];
const ENTITY_TYPES = new Set(['agreement', 'quote']);

function sendError(res, err, fallback) {
  if (!err.statusCode || err.statusCode >= 500) console.error(`[document-reviews] ${fallback}:`, err);
  res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : fallback });
}

function entityExists(db, type, id) {
  return type === 'agreement'
    ? Boolean(db.prepare('SELECT 1 FROM vendor_agreements WHERE id = ?').get(id))
    : Boolean(db.prepare('SELECT 1 FROM contractor_quotes WHERE id = ?').get(id));
}

function checkEntity(req) {
  const type = String(req.params.entityType || '');
  if (!ENTITY_TYPES.has(type)) throw Object.assign(new Error('Unknown document'), { statusCode: 404 });
  const db = getDb();
  if (!entityExists(db, type, req.params.entityId)) throw Object.assign(new Error('Document not found'), { statusCode: 404 });
  return { db, type, id: req.params.entityId };
}

function reviewShape(db, review) {
  if (!review) return null;
  let read = null;
  if (review.file_sha256) {
    const hit = db.prepare('SELECT read_json, model, created_at FROM document_ai_reads WHERE sha256 = ? AND read_version = ?')
      .get(review.file_sha256, documentReview.READ_VERSION);
    try { read = hit ? { ...JSON.parse(hit.read_json), model: hit.model, read_at: hit.created_at } : null; } catch (_) { read = null; }
  }
  const list = value => { try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch (_) { return []; } };
  return {
    status: review.status,
    mode: review.mode,
    model: review.model,
    summary: review.summary,
    error: review.error,
    entry_index: review.entry_index,
    document_count: review.document_count,
    findings: list(review.findings_json),
    corrections: list(review.corrections_json),
    reviewed_at: review.reviewed_at,
    documents: read ? read.documents.map((doc, index) => ({
      index,
      vendor: doc.vendor?.name || '',
      property: doc.property?.address || '',
      trade: doc.trade,
      doc_kind: doc.doc_kind,
      total_amount: doc.total_amount,
      executed_date: doc.executed_date,
      document_date: doc.document_date,
      signature_status: doc.signature_status,
      pages: doc.page_start ? `${doc.page_start}${doc.page_end && doc.page_end !== doc.page_start ? `-${doc.page_end}` : ''}` : '',
      summary: doc.summary,
    })) : [],
    file_summary: read?.file_summary || null,
    read_at: read?.read_at || null,
  };
}

router.use(authenticate, authorize(...MANAGEMENT_ROLES));

router.get('/status', (req, res) => {
  try {
    res.json(documentReview.statusSummary(getDb()));
  } catch (err) {
    sendError(res, err, 'Unable to load the AI review status');
  }
});

// Re-read every agreement and quote document now (confident fixes are applied).
router.post('/backfill', authorize(...UPPER_ROLES), (req, res) => {
  try {
    const db = getDb();
    if (!documentReview.aiReadsEnabled()) {
      return res.status(503).json({ error: 'AI reading is not available on this server right now' });
    }
    const queued = documentReview.enqueueBackfill(db, { force: Boolean(req.body?.force), userId: req.user.id, mode: 'backfill' });
    logActivity({ userId: req.user.id, action: 'ai_review_backfill_started', entityType: 'document_review', details: { title: `AI re-read of ${queued} document(s)`, queued } });
    res.json({ queued, status: documentReview.statusSummary(db) });
  } catch (err) {
    sendError(res, err, 'Unable to start the AI re-read');
  }
});

router.get('/:entityType/:entityId', (req, res) => {
  try {
    const { db, type, id } = checkEntity(req);
    res.json({ review: reviewShape(db, documentReview.loadReview(db, type, id)) });
  } catch (err) {
    sendError(res, err, 'Unable to load the AI review');
  }
});

// Re-read this one document. fresh: true asks the AI again instead of reusing its last reading.
router.post('/:entityType/:entityId/rerun', (req, res) => {
  try {
    const { db, type, id } = checkEntity(req);
    if (req.body?.fresh) {
      const sha = type === 'agreement'
        ? db.prepare('SELECT sha256 AS sha FROM vendor_agreements WHERE id = ?').get(id)?.sha
        : db.prepare('SELECT source_file_hash AS sha FROM contractor_quotes WHERE id = ?').get(id)?.sha;
      if (sha) db.prepare('DELETE FROM document_ai_reads WHERE sha256 = ?').run(sha);
    }
    documentReview.enqueueReview(type, id, { mode: 'rerun', userId: req.user.id });
    res.json({ review: reviewShape(db, documentReview.loadReview(db, type, id)) });
  } catch (err) {
    sendError(res, err, 'Unable to re-read the document');
  }
});

// Apply the AI's reading for the named fields (all flagged fields when none named).
router.post('/:entityType/:entityId/apply', (req, res) => {
  try {
    const { db, type, id } = checkEntity(req);
    const fields = Array.isArray(req.body?.fields) ? req.body.fields.map(String) : [];
    const result = documentReview.applySuggestions(db, type, id, fields, req.user.id);
    res.json({ ...result, review: reviewShape(db, documentReview.loadReview(db, type, id)) });
  } catch (err) {
    sendError(res, err, 'Unable to apply the AI reading');
  }
});

router.post('/:entityType/:entityId/undo', (req, res) => {
  try {
    const { db, type, id } = checkEntity(req);
    const result = documentReview.undoCorrections(db, type, id, req.user.id);
    res.json({ ...result, review: reviewShape(db, documentReview.loadReview(db, type, id)) });
  } catch (err) {
    sendError(res, err, 'Unable to undo the AI corrections');
  }
});

module.exports = router;
