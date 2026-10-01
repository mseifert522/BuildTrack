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

## Tests

`vd-kit/tests/vd-test.js` on newurbandev-prod (84 checks, real HTTP on a prod-DB copy with an SMTP sink) and `vd-kit/tests/vd-shots.mjs` (real Chromium) are run by `vd-kit/vd-build.sh` and `vd-preview.sh`, together with the vendor-setup regression suite (126 checks) and the backend unit tests.
