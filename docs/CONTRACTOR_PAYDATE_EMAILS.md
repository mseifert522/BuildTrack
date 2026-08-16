# Contractor pay-date emails (QuickBooks bill receipts)

**Live since:** 2026-08-15. **Owner surfaces:** `backend/src/routes/quickbooks.js` (queue + dispatch), `backend/src/utils/email.js` (`sendContractorInvoiceReceivedEmail`), `backend/src/db/schema.js` (columns + backfill), Invoices page + project Invoices tab + notification bell.

## What it does

When the office enters a contractor invoice as a **Bill in QuickBooks**, BuildTrack's QBO sync (every 60s, plus webhook/manual) picks it up and:

1. **Emails the contractor** (the QBO vendor's `PrimaryEmailAddr`): "We've received your invoice for $X — you will be paid on DATE", where **DATE is the QBO due date** the office chose. Reply-To is the invoices inbox (`GMAIL_INVOICE_USER`, invoices@newurbandev.com), and the email tells the contractor to reply by email only with any questions — no calls or texts.
2. **Notifies the team in-app**: an `activity_log` row (action `quickbooks_invoice_received`) renders in the notification bell with vendor • amount • expected pay date • email outcome.
3. **Shows status in the UI**: the Invoices page QBO table has an "Expected pay date" column plus a per-bill line ("Contractor emailed …", or an amber reason why not); the project Invoices tab shows the pay date and vendor email.

## How exactly-once works

Bookkeeping columns on `quickbooks_bills`: `vendor_receipt_notify_status`, `vendor_receipt_notified_at`, `vendor_receipt_notified_email`, `vendor_receipt_notify_error`, `vendor_receipt_notify_attempts`.

- The **work queue is the database**: any bill row with status `NULL` (or `failed` with < 3 attempts) is a candidate on every sync — crashes/outages defer, never lose, an email.
- A bill only enters the queue if it is **genuinely new**: unpaid AND its QBO `CreateTime` is within `QBO_VENDOR_RECEIPT_FRESH_WINDOW_HOURS` (default 72). Everything else (pre-launch history, rebuilt DBs, vendors removed from the exclusion list) is stamped `historical` and never emailed. All bills existing at first deploy were backfilled to `historical`.
- Send path claims the row (`processing`) → sends → stamps a terminal status; attempts count only real send failures. Stranded `processing` rows are swept to `failed` (retryable) at boot.
- **Statuses:** `sent`, `failed` (auto-retries up to 3, spaced ≥1h apart), `skipped_no_email` / `skipped_no_due_date` (auto **re-arm** with a fresh attempt budget once the office fixes the vendor email / due date in QuickBooks), `skipped_already_paid`, `skipped_stale` (due date already passed — no future-tense promise), `historical`.
- Rate limit: at most `QBO_VENDOR_RECEIPT_EMAIL_MAX_PER_SYNC` (default 20) bills processed per pass; the rest drain on subsequent syncs.
- Dispatch is fire-and-forget off the sync mutex, so slow SMTP never stalls the bill mirror.

## Ops notes

- **Kill switch:** `QBO_VENDOR_RECEIPT_EMAIL_ENABLED=false` — bills accumulate at `NULL` and send when re-enabled (deliberate: disabling defers, it does not consume).
- **No vendor email on file:** the Invoices page shows an amber "add the vendor's email in QuickBooks" line; adding it in QBO sends the email on the next sync automatically. Only ~30 of ~400 vendors currently have emails in QBO.
- If SMTP creds are missing the send is recorded as `failed` (never falsely `sent`).
- Envs (all optional, defaults shown): `QBO_VENDOR_RECEIPT_EMAIL_ENABLED=true`, `QBO_VENDOR_RECEIPT_EMAIL_MAX_PER_SYNC=20`, `QBO_VENDOR_RECEIPT_FRESH_WINDOW_HOURS=72`. Reply-To resolves `GMAIL_INVOICE_USER` → `INVOICE_EMAIL` → invoices@newurbandev.com.
