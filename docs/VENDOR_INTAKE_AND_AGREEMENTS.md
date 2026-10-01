# Vendor intake from quotes, Add Vendor everywhere, Documents & Agreements

Built 2026-10-01 at Mike's request. Three related pieces.

## 1. Every quote puts its vendor in Contractors / Suppliers

`backend/src/utils/quoteVendorIntake.js` runs after a quote is committed by every path that adds one (Quotes page, the project's Quotes tab, the vendor quote link). It never fails the quote.

- `utils/vendorDirectory.js` `ensureQuoteVendor` links the quote (`contractor_quotes.contractor_profile_id`) to a vendor that is already in the directory — by a contractor login, then an exact letters-and-digits match on the business name or contact name against `vendor_name` / QuickBooks display, company and print-on-check names, then the email — or creates one (`source = 'quote'`, contact/email/phone/address from the quote, category mapped from the quote's category, e.g. Roofing -> Roof). No mobile login is created.
- If the name cannot be read (blank, a placeholder like "N/A", garbled, our own company, the property address or one of our own staff), nothing is created. The quote gets the `vendor_needs_clarification` data-quality flag (a "Vendor needed" badge in the Quotes grid), and the office is emailed (`VENDOR_CLARIFICATION_EMAIL`, default info@newurbandev.com) with a link to `/quotes?search=<quote number>`. When the "company" read is our own side, the contact name next to it is ours too and is not used as a fallback.
- A quote may now be saved without a vendor name only when its document is attached. Editing the quote with a readable name adds or links the vendor and clears the flag. Edits never email.
- The AI quote reader is told that the vendor is the business that issued the quote, never the bill-to party or the property, and to leave the name blank rather than guess.

## 2. Add Vendor from any screen

`frontend/src/components/AddVendorModal.tsx` is the only Add Vendor form. It is opened from the top bar on every screen, from each project header (pre-connected to that project), from the Contractors / Suppliers page and from the agreement upload form. It sends `check_duplicates: true`, so a vendor already in the directory by name or email comes back as `409` plus the existing record ("Use X" / "Add anyway"). `lib/vendors.ts` announces every addition (`bt:vendor-added`) so the directory and the project's contractor list reload. An existing vendor picked for a project is connected through the same atomic `PUT /projects/:id/contractors` that Assign Contractors uses.

## 3. Documents & Agreements (project tab)

Every executed contract and signed agreement with a vendor or contractor. It is a tab on each project (`ProjectDetail` `#agreements`), and `/agreements` lists all projects.

- **Vendor and project are required** on every save (`routes/agreements.js` `parseAgreementFields`), along with the type of work, the document type and the executed date. The list is ordered newest-executed first, can be grouped by type of work, and has type-of-work filter chips.
- **Private:** the API is management-only (super admin, operations manager, project manager; contractors get 403). Only super admins and operations managers can delete. Every file read is written to `data_access_events`.
- **Encrypted at rest:** files are stored in `uploads/agreements/<year>/<id>.bta` as `BTA1 | IV | AES-256-GCM ciphertext | tag`, using streaming encryption with a key derived from `CONTRACTOR_ONBOARDING_ENCRYPTION_KEY` via `secureFields.deriveFileKey('buildtrack:agreement-files:v1')`. **Rotating that secret makes every stored agreement (and every vendor W-9) unreadable.** The plaintext upload is deleted as soon as it is sealed.
- `uploads/agreements` is never served statically (`server.js` 404, and `uploadsGate` classifies it as `blocked` after path resolution). Files are opened only through `GET /api/agreements/:id/file`, fetched by the page as a blob.
- The file type is decided by content (`vendorSetupFiles.sniffFileType`): PDF, images and scans, Word, ODT or RTF. The same file on the same project is rejected with 409.
- A vendor that has agreements on file cannot be deleted (`users.js` `deleteContractorProfileCascade` returns 409). Projects are only ever archived.
- Activity rows (`agreement_*`) carry no `project_id` column value, because project activity is readable by the project's contractors. The project id is kept in `details`.

## 4. The AI reads every agreement and quote document

Added the same day: Mike asked that the AI read every executed agreement and executed quote and make sure each is filed correctly, including everything already uploaded. `services/documentReview.js` does this, and `routes/documentReviews.js` (`/api/document-reviews`, management only) exposes it.

- **One read per file.** Claude (`DOCUMENT_REVIEW_MODEL`, default `claude-opus-5-5`, stepping down to `claude-opus-5` / `claude-opus-4-8` if the model is unavailable) reads the PDF or image with a JSON-schema answer: one entry per separate document in the file (vendor, job address, type of work, document type, signatures, dates, total, pages, and a confidence for each). Reads are cached in `document_ai_reads` by the file's SHA-256 and `READ_VERSION`, so a file is never paid for twice. Server-side refusal fallbacks are on (`fallbacks: 'default'`). A read costs about $0.04.
- **While uploading an agreement:** `POST /api/agreements/read` reads the picked file and pre-fills the form (vendor, type of work, type, date, amount, title). A vendor that is not in the directory is proposed as a new vendor and created when the form is saved. A file holding several documents (e.g. "Executed Quotes.pdf" with three vendors' quotes) is split: each document is filed separately to its own vendor, sharing one encrypted file, and the viewer opens at that document's page. A shared file is deleted only with its last filing.
- **After every save** a review is queued (`document_ai_reviews`, one row per agreement or quote) and the read is compared with how the record is filed. On upload, only blanks are filled; disagreements are flagged ("AI: check") with a one-click "Use AI reading". The badge sits under each agreement and next to each quote's contractor.
- **Re-reading** (on boot for anything never reviewed, a 10-minute sweep, "Re-read all with AI" for super admins and operations managers, or "Read again" on one record) corrects confident disagreements on agreements: vendor, project, document type and amount at high confidence, the executed date at medium or better; type of work is only ever flagged. Every correction is recorded and can be undone, and each corrected or flagged record rings the bell.
- **Quotes:** the AI links the quote to its vendor (creating it from what it read if needed), and moves a quote to the right project only on a re-read at high confidence, taking its document along. Quote totals and dates are only ever flagged, never changed.
- **The clarification email waits for the AI.** When a quote's vendor cannot be read from what was typed and the document is attached, the office is emailed only if the AI cannot find the name either.
- Switches: `DOCUMENT_REVIEW_READS=on|off|cache_only` (`cache_only` never calls the API; used by the tests) and `DOCUMENT_REVIEW_AUTO=false` (no boot re-read or sweep; set on the green container during a deploy).
- Scope: agreements and quote documents. QuickBooks bills and receipts are read separately by the Cost Analyzer.

## 5. Quotes by category

The Quotes page has a "By Category" tab: every category with its quote count and low / median / high, and for a chosen category (e.g. Roofing) every quote's amount for that category's lines side by side, by property or as one list, lowest first, with the difference from the lowest and a "View PDF" for each. `?category=Roofing` opens it directly.

## 6. Protected files open with the login

`/api` files need the Bearer token, so a plain `<a href>` or `<img src>` opened `{"error":"Authentication required"}` (the project Quotes tab's quote PDF links). `lib/authFiles.ts` (`openAuthedFile`, `downloadAuthedFile`) and `components/AuthedImage.tsx` fetch them as blobs. Never link an `/api` file directly.

## Tests

`vd-kit/tests/vd-test.js` on newurbandev-prod (84 checks, real HTTP on a prod-DB copy with an SMTP sink), `vd-kit/tests/vd-ai-test.js` (56 checks, cache-only AI reads), and `vd-kit/tests/vd-shots.mjs` (real Chromium) are run by `vd-kit/vd-build.sh` and `vd-preview.sh`, together with the vendor-setup regression suite (126 checks) and the backend unit tests. `vd-probe.sh` runs a real-AI re-read of every document on a prod-DB copy before a deploy.
