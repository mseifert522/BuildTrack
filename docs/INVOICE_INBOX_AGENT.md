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

## Review queue (since 2026-10-27)

Invoices page, "Incoming invoices from email": one row per invoice - received, vendor,
invoice #, amount, work (category + type), document, project - and one click. The raw
email is not shown. An invoice waiting for a project offers, first, the projects of
QuickBooks bills already entered for it (same vendor, its amount or half, dated for it,
not linked yet - the project is preselected when exactly one) and then the vendor's
recent QuickBooks classes (`projectSuggestions`). **Assign** calls
`POST /api/invoices/email-intake/:id/items/:itemId/assign` (`assignItem`): filed exactly
as the AI files (its read, the document on the invoice, vendor matched or added,
`ai_filed=0`, no scope task), item -> `filed_by_office`. Vendor / amount / invoice # are
asked for only when the AI could not read them. The old `/file` route (scope task
required) is no longer used by the page.
5. QuickBooks: the existing bill matcher (`findInvoiceForBill`) links a bill to the
   BuildTrack invoice; a vendor invoice number now only matches when the vendor agrees.

## Settings (`/opt/production/secrets/env.buildtrack`)

`INVOICE_INBOX_ENABLED`, `INVOICE_INBOX_USER`, `INVOICE_INBOX_APP_PASSWORD`,
`INVOICE_INBOX_SINCE`, `INVOICE_INBOX_NOTIFY_EMAIL` (default info@newurbandev.com),
`INVOICE_AI_ANTHROPIC_API_KEY` (else the shared key), optional `INVOICE_INBOX_POLL_MS`,
`INVOICE_INBOX_LABEL` (`''` = do not label), `INVOICE_INBOX_SYSTEM_USER_ID` (login the
invoices are filed under; default the first active super admin).

**Blue-green deploys: the green container must get `INVOICE_INBOX_ENABLED=false` and
`INVOICE_MONITOR_ENABLED=false`**, or two containers read the mailbox / write links at once.

# Invoice <-> QuickBooks monitor

Live since 2026-10-26. Code: `backend/src/services/invoiceReconciliation.js`, API
`backend/src/routes/invoiceMonitor.js` (`/api/invoices/monitor`), UI: Invoices page,
"Invoice monitor" (`frontend/src/components/InvoiceMonitorPanel.tsx`). Tests:
`backend/tests/invoiceReconciliation.test.js`.

Every emailed invoice must match what the operations manager enters in QuickBooks. The
monitor reads only BuildTrack's QuickBooks mirror (kept current by the existing sync from
Intuit's change feed) - it never calls the Intuit API and never writes to QuickBooks. It
runs every 5 minutes and a few seconds after any QuickBooks sync or inbox change.

- **Links** (`invoice_qbo_links`): each emailed invoice to the bill(s) entered for it -
  same vendor only, by the same attached document (sha256), the invoice number in the
  bill's note, the full amount, two halves (the office writes "First Half" / "Second
  Half" in the note; there is no DocNumber), parts adding up to it, or a bill whose class
  lines split it across projects. Never a guess: a bill dated before the invoice (3 days'
  slack), entered more than 3 weeks before the email, or one of several equally
  plausible bills is not taken. The QuickBooks sync honors these links
  (`findInvoiceForBill`), and an invoice entered as several bills is not overwritten by
  each bill.
- **Filed from QuickBooks**: an emailed invoice whose job was not on it (`needs_project`)
  is filed under the project the office chose in QuickBooks - one BuildTrack invoice per
  project share when the bill splits it across classes.
- **QuickBooks is the source of truth** (2026-10-27, `followQuickBooks`): once linked, the
  invoice follows its bill(s) on every run. A bill edited in QuickBooks updates the link
  amount. The whole invoice under one class -> the invoice moves to that project, its
  documents copied to `invoice-attachments/<project>/<invoice>` inside the run's
  transaction and the old folder removed after commit (not when scope tasks of the old
  project are tied to it, or the bill splits it across classes - those stay a
  `project_mismatch` issue). Entered in full (one bill, both halves, or its project
  share) for another amount -> the BuildTrack total becomes the QuickBooks amount (one
  line item takes it, otherwise an "Adjustment to match QuickBooks" line). Each change is
  noted on the invoice and in the feed. Partly entered and more-than-invoiced stay issues.
- **Mirrors QuickBooks**: project invoice lists show an emailed invoice that is entered in
  QuickBooks as those QuickBooks rows (tagged "Emailed NUD-x - 1st half"), so nothing is
  counted twice; what is not entered yet shows as "Not in QuickBooks yet". All parts
  paid -> the BuildTrack invoice is marked paid.
- **Issues** (`invoice_monitor_issues`, emailed to info@ once, batched every 10 minutes):
  possible double entry (same vendor, amount and description within 10 days), a bill for
  a document the AI read as an estimate, amount differs (only when it cannot follow),
  more entered than invoiced, QuickBooks has another project and the invoice cannot move,
  a linked bill deleted in QuickBooks, not entered after
  `INVOICE_MONITOR_GRACE_DAYS` (3), only partly entered. Info only (not emailed): the
  document attached in QuickBooks totals something else (Cost Analyzer's read). "It is OK"
  dismisses an issue.
- **Feed** (`invoice_monitor_events`): every email received, AI verdict, invoice filed,
  duplicate, estimate, QuickBooks bill entered / edited / paid / deleted, link and issue.

Settings: `INVOICE_MONITOR_ENABLED` (default on), `INVOICE_MONITOR_SINCE` (bills checked
from this date, default 2026-08-01), `INVOICE_MONITOR_GRACE_DAYS`, `INVOICE_MONITOR_INTERVAL_MS`.
