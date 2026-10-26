# Invoice inbox agent (invoices@newurbandev.com)

Live since 2026-10-26. Code: `backend/src/services/invoiceInboxAgent.js`, review queue
`backend/src/routes/invoiceEmailIntake.js` (mounted at `/api/invoices/email-intake`),
UI: Invoices page, "Incoming invoices from email". Tests: `backend/tests/invoiceInboxAgent.test.js`.

## What it does

1. Every 2 minutes it reads the Gmail box over IMAP (app password; read state is left
   alone, processed mail gets the `BuildTrackImported` label). Mail older than
   `INVOICE_INBOX_SINCE` is never touched. Each message is stored once in
   `invoice_email_intake` (Gmail ids are checked in decimal and in the hex form the
   old Gmail-API poller stored).
2. Claude (`INVOICE_AI_MODEL`, default claude-opus-5-5, effort high) reads the whole
   email and every attachment (PDFs, photos; iPhone HEIC and scanner TIFF are
   converted first). For every priced document it says what it is - invoice,
   estimate/quote, statement, receipt, credit memo - and quotes the words that prove
   it, then reads vendor, invoice number, dates, type, category, amounts, line items
   and the job.
3. One `invoice_inbox_items` row per document:
   - **not_invoice** - estimates, quotes (also quotes written on an invoice form),
     statements, receipts. Never a BuildTrack invoice; no vendor is created from them.
   - **duplicate** - the same invoice already received (same vendor + invoice number,
     or vendor + amount + date, or the very same file bytes). Not added again.
   - **filed** - added as a BuildTrack invoice (`source='email'`, `ai_filed=1`, with
     `category`, `invoice_type`, vendor dates, line items and the document attached)
     to the project whose address / job name is printed on the invoice or written by
     the vendor in the email. Exactly one project must match, the AI must be highly
     confident, and its own project pick must agree. A one-letter street misspelling
     counts only with the exact house number and the AI's own pick.
   - **needs_project** - the job is not clearly marked: nothing is filed (never
     guessed); the office gets one email with the invoice attached.
   - **needs_review** - vendor or amount unreadable, a revised amount for an invoice
     number already received, an attachment the AI cannot open (Excel, Word, oversize),
     or the AI could not read the email. The office gets one email.
   - **filed_by_office** - a person filed it from the review queue.
4. New vendors go into Contractors / Suppliers (`source='invoice_email'`).
5. QuickBooks: the existing bill matcher (`findInvoiceForBill`) links a bill to the
   BuildTrack invoice; a vendor invoice number now only matches when the vendor agrees.

## Settings (`/opt/production/secrets/env.buildtrack`)

`INVOICE_INBOX_ENABLED`, `INVOICE_INBOX_USER`, `INVOICE_INBOX_APP_PASSWORD`,
`INVOICE_INBOX_SINCE`, `INVOICE_INBOX_NOTIFY_EMAIL` (default info@newurbandev.com),
`INVOICE_AI_ANTHROPIC_API_KEY` (else the shared key), optional `INVOICE_INBOX_POLL_MS`,
`INVOICE_INBOX_LABEL` (`''` = do not label), `INVOICE_INBOX_SYSTEM_USER_ID` (login the
invoices are filed under; default the first active super admin).

**Blue-green deploys: the green container must get `INVOICE_INBOX_ENABLED=false`**, or
two containers read the mailbox at once.
