'use strict';
// Every quote added to BuildTrack puts its vendor in Contractors / Suppliers
// (Mike, 2026-10-01): an existing vendor is linked, a new one is created, and a
// quote whose vendor name cannot be read is flagged and - when `notify` - the
// office is emailed to clarify it. Called AFTER the quote is committed by every
// path that adds a quote (Quotes page, project Quotes tab, vendor quote link); it
// never fails the quote.
const { logActivity } = require('./audit');
const { isEmailConfigured, sendVendorClarificationEmail, vendorClarificationRecipient } = require('./email');
const { ensureQuoteVendor } = require('./vendorDirectory');

async function resolveQuoteVendor(db, quoteId, user, { notify = false } = {}) {
  let outcome;
  try {
    outcome = ensureQuoteVendor(db, quoteId, { actorId: user?.id || null });
  } catch (err) {
    console.error('[quote-vendor] vendor intake failed:', err);
    return { status: 'error', reason: 'The vendor could not be added automatically.' };
  }
  const quote = db.prepare(`
    SELECT q.id, q.quote_number, q.project_id, q.property_address, q.total_quote_amount, q.source_file_name,
           u.name AS uploaded_by_name
    FROM contractor_quotes q LEFT JOIN users u ON u.id = q.uploaded_by
    WHERE q.id = ?
  `).get(quoteId);
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

  if (outcome.status === 'needs_clarification') {
    const to = vendorClarificationRecipient();
    outcome.notification = { sent: false, reason: notify ? 'send_failed' : 'not_requested', to };
    if (notify) {
      // The mock transporter "succeeds" without SMTP, so never report a send it did not make.
      if (!isEmailConfigured()) {
        outcome.notification.reason = 'email_not_configured';
      } else {
        try {
          await sendVendorClarificationEmail({
            quoteNumber: quote.quote_number,
            projectLabel: quote.property_address,
            readName: outcome.read_name,
            reason: outcome.reason,
            totalAmount: quote.total_quote_amount,
            fileName: quote.source_file_name,
            addedBy: quote.uploaded_by_name || user?.name || null,
            quoteUrl: `/quotes?search=${encodeURIComponent(quote.quote_number)}`,
          });
          outcome.notification = { sent: true, reason: 'sent', to };
        } catch (err) {
          console.error('[quote-vendor] clarification email failed:', err?.message || err);
        }
      }
      logActivity({
        userId: user?.id,
        projectId: quote.project_id,
        action: 'quote_vendor_clarification_requested',
        entityType: 'contractor_quote',
        entityId: quote.id,
        details: {
          quote_number: quote.quote_number,
          title: outcome.reason,
          email_sent: outcome.notification.sent,
          email_reason: outcome.notification.reason,
        },
      });
    }
  }
  return outcome;
}

module.exports = { resolveQuoteVendor };
