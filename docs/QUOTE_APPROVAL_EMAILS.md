# Quote Approval Vendor Emails

When a management user approves a contractor quote (Quotes page — grid or Compare Bids tab —
or a project's Quotes tab, including the compare-table "Pick" button), BuildTrack automatically
emails the vendor that their quote was approved, CC'ing the office.

## What the vendor receives

- **To:** the vendor's email on file (resolution order below)
- **CC:** `QUOTE_APPROVED_CC_EMAIL` env, default `info@newurbandev.com`
- **Reply-To:** `info@newurbandev.com`
- **Subject:** `Your quote has been approved (Q-YYYY-NNNNN)`
- **Body:** branded HTML (same wrapper as the pay-date emails): greeting by contractor name,
  "your quote … has been approved by our office", green *What happens next* card ("A member of
  our office will be contacting you shortly to schedule the job and coordinate the details"),
  details card (quote number, approved amount, property), amber *Questions?* card pointing to
  `info@newurbandev.com`. Sender: `sendQuoteApprovedEmail` in `backend/src/utils/email.js`.

## "Email on file" resolution (`resolveQuoteVendorEmail` in `quoteAnalytics.js`)

1. `contractor_quotes.contractor_email` (captured on the quote itself)
2. Live `contractor_profiles.email`, then `contractor_profiles.quickbooks_primary_email`
   (via `contractor_profile_id`) — so an email added to the vendor profile *after* the quote
   was entered is found at approval time
3. Live `users.email` via `contractor_id`

Each candidate is validated with `normalizeEmail` (trim/lowercase/regex); malformed addresses
count as "no email on file".

## Truthful outcome — no hallucinations

The approval itself always commits first; the email is attempted afterwards and **awaited**, and
the approve response carries `vendor_notification`:

```json
{ "sent": true|false, "reason": "sent|no_email_on_file|send_failed|email_not_configured|already_approved|historical_quote",
  "email": "...", "contractor": "...", "cc": "info@newurbandev.com" }
```

- `sent: true` only when the SMTP handoff actually succeeded. When SMTP is unconfigured
  (`isEmailConfigured()` false — the mock transporter would falsely "succeed"), the route
  reports `email_not_configured` **without** invoking the sender.
- Re-approving a quote already in `approved`/`paid`/`completed` reports `already_approved`
  and sends nothing (no duplicate emails, no error popup).
- Approving a `historical` (imported archive) quote reports `historical_quote` and sends
  nothing — archive quotes must never email a vendor about a years-old job (no error popup).
- An SMTP failure never fails the approval — it reports `send_failed`.
- The outcome is stamped into the `quote_approved` activity-log details as
  `vendor_email_sent` + `vendor_email_reason` — deliberately WITHOUT the raw address,
  because project activity is readable by contractor-role users assigned to the project.

## UI behavior

Both approve surfaces (`pages/Quotes.tsx`, `pages/ProjectDetail.tsx` QuotesTab) share
`components/QuoteApprovalEmailNotice.tsx` — **never fork its wording**:

- Email sent → success toast includes "approval email sent to `<address>` (cc `<office>`)".
- No email on file / send failed / email not configured → a **blocking red modal** tells the
  user the contractor was approved but was NOT emailed, and what to do (add the email to the
  contractor's profile or the quote, notify them directly). Notices are queued per page, so
  two racing approvals can never overwrite each other's unread dialog.

## Testing

`buildtrack-work/bt-quoteemail-test.mjs` (workstation harness, not in the repo image) boots the
real backend against a throwaway DB with SMTP pointed at a local sink and asserts recipients,
CC, subject, body copy, the profile-fallback live lookup, the no-email/send-failed/re-approve
paths, and that deny/restore responses are untouched.
