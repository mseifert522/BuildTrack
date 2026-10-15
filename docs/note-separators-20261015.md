# Notes: day and entry separation

The dashboard previously removed note borders with `border: none !important`. Once an account palette made adjacent surfaces the same color, only whitespace separated records. Several other note lists also lacked day headings.

`DatedNoteList` now supplies New York day headings and a bordered container for every entry while preserving each caller's ordering, content, editing, attachments, deletion, and navigation. Day groups handle UTC, offset, and SQLite timestamps; invalid timestamps receive a "Date unavailable" heading. The dashboard keeps its floating calendar and existing layout.

The shared list is used by dashboard activity, project notes, all four vendor note presentations, quote notes, notification previews, and HR applicant contact history. The unmounted legacy contractor project component was also updated. Existing progress and photo timelines retain their grouping with stronger day rules and entry borders. Desktop and mobile photo timestamps now use the same New York day as other notes.

Mobile project notes retain their separate mobile presentation with outlined entries and stronger day dividers. Their header and note text now use explicit solid foreground/background pairs: the global flat-style gradient removal previously left white text on pale surfaces. Actions wrap within narrow phone cards. Both OS light and dark settings were checked.

## Validation

- TypeScript/Vite production build passes.
- Frontend lint: 0 errors; the existing 35 warnings remain. The final HR addition was checked separately with ESLint.
- 300 distinct desktop route/tab/form/menu states across all five palettes pass the contrast and render checks. The initial run completed 296 states; a calendar close timeout and a development-page reload interrupted two routes. Targeted reruns completed all 300 states with no remaining errors or measured contrast failures. Original interruptions are retained in the local combined report.
- 70 focused checks cover note counts, New York day boundaries, spacing, entry-border contrast of at least 3:1, note text contrast, dashboard calendar position, project editing/cancel, vendor previews/expanded lists/profile/fallbacks, quotes, photos, mobile notes/photos, and HR contact history across all five account palettes. DST fall-back and invalid dates are included. Mobile note contrast also passes with OS light and dark preferences.
- Screenshots were reviewed for light and Dark Knight dashboards and phone notes.

Browser checks use intercepted APIs and synthetic records, including a browser timezone of Asia/Tokyo to verify New York grouping. They do not write business data or claim coverage of every production record or workflow. Unmounted legacy screens are source/build checked, not runtime tested.

## Release safety

This release replaces only the frontend on top of the verified running image `sha256:91de19eb13a26c596316f0a1170d9f4821ec5a16ad62dacf26e88e62c14257ba`. Backend files and database schemas are unchanged. Previous hashed assets remain available for existing sessions. The prior image is retained as `production-prod-buildtrack:rollback-notes-20261015`.

The deployment script verifies the running image still matches discovery, validates Compose, recreates only `prod-buildtrack`, and restores the prior image if the new container does not become healthy.

## Published verification

Deployed application source: `033a4d4`. Healthy production image: `sha256:b96fb908f74afc02aaaa0208990df64f1f0e3dd83a290a66fc4469f260c8c4c4`. Published main assets: `/assets/index-uJbyJTc9.js` and `/assets/index-CRRah_dh.css`. Public `/api/health` returns 200 with status `ok`.

All 60 focused desktop checks pass against the published frontend across five palettes, using synthetic API responses. The Warm Ivory vendor test initially read the preview list before the expanded list finished loading. The regression test now waits for that second list explicitly; the full Warm Ivory rerun passed. Both the initial report and the combined verified report are retained locally.

Public mobile verification is blocked by the mobile hostname's HTTPS handshake failure. Edge reports `ERR_SSL_VERSION_OR_CIPHER_MISMATCH`; a separate request from the production VM also fails before HTTP. No certificate, DNS, or proxy changes were made in this frontend release. Mobile note and photo screens were tested locally, including both OS color settings for note readability; the shared production frontend contains those changes.
