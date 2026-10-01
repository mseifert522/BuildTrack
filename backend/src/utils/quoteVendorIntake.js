'use strict';
// Every quote added to BuildTrack puts its vendor in Contractors / Suppliers
// (Mike, 2026-10-01): an existing vendor is linked, a new one is created, and a
// quote whose vendor name cannot be read is flagged and - when `notify` - the
// office is emailed to clarify it. Called AFTER the quote is committed by every
// path that adds a quote (Quotes page, project Quotes tab, vendor quote link); it
// never fails the quote.
//
// Every quote with a document is then read by the AI (services/documentReview.js)
// to check it is filed correctly. When the vendor's name could not be read from
// what was typed, the clarification email waits for that AI read: the AI may find
// the name, and only if it cannot is the office emailed.
const { logActivity } = require('./audit');
const { isEmailConfigured, sendVendorClarificationEmail, vendorClarificationRecipient } = require('./email');
const { ensureQuoteVendor } = require('./vendorDirectory');

function documentReview() {
  // Lazy: documentReview requires this module too.
  return require('../services/documentReview');
}

// Emails the office that a quote's vendor could not be added. Returns the
// notification outcome and logs it for the bell.
async function notifyVendorClarification(db, quoteId, { reason, readName = '', userId = null, userName = null } = {}) {
  const quote = db.prepare(`
    SELECT q.id, q.quote_number, q.project_id, q.property_address, q.total_quote_amount, q.source_file_name,
           u.name AS uploaded_by_name
    FROM contractor_quotes q LEFT JOIN users u ON u.id = q.uploaded_by
    WHERE q.id = ?
  `).get(quoteId);
  if (!quote) return { sent: false, reason: 'missing', to: vendorClarificationRecipient() };
  const to = vendorClarificationRecipient();
  let notification = { sent: false, reason: 'send_failed', to };
  if (!isEmailConfigured()) {
    notification.reason = 'email_not_configured';
  } else {
    try {
      await sendVendorClarificationEmail({
        quoteNumber: quote.quote_number,
        projectLabel: quote.property_address,
        readName,
        reason,
        totalAmount: quote.total_quote_amount,
        fileName: quote.source_file_name,
        addedBy: quote.uploaded_by_name || userName || null,
        quoteUrl: `/quotes?search=${encodeURIComponent(quote.quote_number)}`,
      });
      notification = { sent: true, reason: 'sent', to };
    } catch (err) {
      console.error('[quote-vendor] clarification email failed:', err?.message || err);
    }
  }
  logActivity({
    userId,
    projectId: quote.project_id,
    action: 'quote_vendor_clarification_requested',
    entityType: 'contractor_quote',
    entityId: quote.id,
    details: {
      quote_number: quote.quote_number,
      title: reason,
      email_sent: notification.sent,
      email_reason: notification.reason,
    },
  });
  return notification;
}

async function resolveQuoteVendor(db, quoteId, user, { notify = false } = {}) {
  let outcome;
  try {
    outcome = ensureQuoteVendor(db, quoteId, { actorId: user?.id || null });
  } catch (err) {
    console.error('[quote-vendor] vendor intake failed:', err);
    return { status: 'error', reason: 'The vendor could not be added automatically.' };
  }
  const quote = db.prepare('SELECT id, quote_number, project_id, source_file_path FROM contractor_quotes WHERE id = ?').get(quoteId);
  if (!quote) return outcome;

  if (outcome.status === 'created') {
    logActivity({
      userId: user?.id,
      projectId: quote.project_id,
      action: 'quote_vendor_created',
      entityType: 'contractor_profile',
      entityId: outcome.contractor_id,
      details: { quote_number: quote.quote_number, name: outcome.vendor_name, contractor_category: outcome.category || null },
    });
  }

  const hasDocument = Boolean(quote.source_file_path);
  let aiWillRead = false;
  if (hasDocument) {
    try {
      aiWillRead = documentReview().aiReadsEnabled();
    } catch (_) {
      aiWillRead = false;
    }
  }

  if (outcome.status === 'needs_clarification') {
    const to = vendorClarificationRecipient();
    if (notify && aiWillRead) {
      // The AI reads the document next; it emails the office only if it cannot find the name either.
      outcome.notification = { sent: false, reason: 'pending_ai_read', to };
    } else if (notify) {
      outcome.notification = await notifyVendorClarification(db, quote.id, {
        reason: outcome.reason, readName: outcome.read_name, userId: user?.id || null, userName: user?.name || null,
      });
    } else {
      outcome.notification = { sent: false, reason: 'not_requested', to };
    }
  }

  // The AI reads every quote document and checks how it is filed.
  if (aiWillRead) {
    documentReview().enqueueReview('quote', quote.id, {
      mode: 'upload',
      notify: Boolean(notify && outcome.status === 'needs_clarification'),
      userId: user?.id || null,
    });
    outcome.ai_review = 'queued';
  }
  return outcome;
}

module.exports = { resolveQuoteVendor, notifyVendorClarification };
