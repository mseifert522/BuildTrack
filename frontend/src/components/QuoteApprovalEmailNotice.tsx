import { AlertTriangle } from 'lucide-react';
import { Modal } from './ui';
import type { QuoteVendorNotification } from '../lib/quotesApi';

export interface ApprovalEmailNotice {
  quoteNumber?: string | null;
  notification: QuoteVendorNotification;
}

// Builds the blocking-dialog payload from an approve response. Returns null when no
// dialog is needed: email actually sent, a re-approval, or a historical/archive quote
// (both deliberately send nothing, so there is no missing email to warn about).
export function noticeFromApproveResponse(
  res: { vendor_notification?: QuoteVendorNotification } | null | undefined,
  quoteNumber?: string | null,
): ApprovalEmailNotice | null {
  const notification = res?.vendor_notification;
  if (!notification || notification.sent) return null;
  if (notification.reason === 'already_approved' || notification.reason === 'historical_quote') return null;
  return { quoteNumber: quoteNumber || null, notification };
}

// Success-toast suffix — only ever claims a send the server actually performed.
export function approvalEmailToastSuffix(notification?: QuoteVendorNotification | null): string {
  return notification?.sent && notification.email
    ? ` — approval email sent to ${notification.email} (cc ${notification.cc})`
    : '';
}

// Blocking "the approval email did NOT go out" dialog, shared by every quote-approve
// surface (Quotes page + ProjectDetail). The wording lives here only — never fork it.
export function QuoteApprovalEmailNoticeModal({
  notice,
  onClose,
}: {
  notice: ApprovalEmailNotice | null;
  onClose: () => void;
}) {
  if (!notice) return null;
  const { notification, quoteNumber } = notice;
  const who = `${notification.contractor}${quoteNumber ? ` (quote ${quoteNumber})` : ''}`;
  const message = notification.reason === 'no_email_on_file'
    ? `${who} has been approved, but no approval email was sent because this contractor does not have an email address on file. Add their email address to the contractor's profile or the quote, then notify them directly.`
    : notification.reason === 'email_not_configured'
      ? `${who} has been approved, but email sending is not configured on this server, so no approval email was sent. Please notify the contractor directly.`
      : `${who} has been approved, but the approval email to ${notification.email || 'the contractor'} could not be sent because of an email system error. Please notify the contractor directly.`;
  return (
    <Modal isOpen onClose={onClose} title="Approval email NOT sent" size="md">
      <div className="flex items-start gap-3 rounded-xl border border-red-300 bg-red-50 p-4">
        <AlertTriangle className="mt-0.5 h-6 w-6 flex-shrink-0 text-red-700" />
        <div>
          <p className="text-sm font-bold text-red-800">The quote was approved, but the contractor was NOT emailed.</p>
          <p className="mt-2 text-sm font-medium leading-relaxed text-red-900">{message}</p>
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-red-500"
        >
          Got it
        </button>
      </div>
    </Modal>
  );
}
