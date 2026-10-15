# Account theme contrast audit

The previous palette adapter replaced text colors without replacing several legacy dark surfaces. Light schemes therefore displayed dark text on dark dashboard notes, calendars, invoice rows, and status panels. Other screens retained fixed light foregrounds and pale badges when switching to dark schemes.

## Changes

- Bind dashboard surface and foreground variables to the selected account palette.
- Theme calendar controls, table cells, invoice queues, status chips, inline labels, avatars, form groups, profile menus, and notification toasts together.
- Keep modal panels opaque and modal backdrops translucent.
- Give filled actions their corresponding foreground, including child labels and icons. Preserve legible disabled controls and captions.
- Expose the selected quote tab through `aria-pressed` and a visible themed state.
- Keep the four existing color choices, default 07, account persistence, layout, and application behavior.

## Verification

Tested all 17 authenticated desktop route variants and their additional tabs/forms/menus: 60 states per scheme, 240 combinations across 01, 07, 08, and 02.

Routes: dashboard, operations calendar, projects, project detail, quotes, invoices, new invoice, edit invoice, punch list, photos, vendor directory, users, settings, security, human resources, cost analyzer, and agreements.

Additional states include all project tabs, quote tabs, HR tabs, Cost Analyzer tabs, settings tabs, calendar day/week/month views, calendar/new-project/new-user/new-vendor forms, profile/notification menus, and invoice payment filters. Tests use synthetic records, including notes, a project, quote, contractor, invoice, and unpaid/approved/paid QuickBooks bills. All API requests are intercepted; the audit does not modify business records.

- Zero measured contrast failures in the verified matrix.
- Normal text checked at 4.5:1; large text at 3:1. Where axe cannot classify overlapping float layouts or single-digit badges, the test records those nodes separately and measures their foreground against the ancestor surfaces. Dialog backgrounds are excluded when a dialog covers them. Representative light/dark screenshots were visually reviewed.
- Immediate preference changes, persistence after reload, failed-save rollback, and agent account status regression checks passed.
- TypeScript/Vite production build passed. Repository frontend lint: 0 errors, 35 existing warnings.

This is a frontend rendering audit using representative data, not an exhaustive audit of every possible record or business workflow. Authenticated production browser inspection was unavailable because the browser connector failed to initialize. After deployment, 76 additional rendering checks against the published frontend passed across all four themes, still using intercepted sample API responses. The released assets, public health endpoint, and production container health also passed. Uploaded documents and images retain their original contents; their internal text is not recolored.

Released frontend commit: `812964f`. Production image: `sha256:da7e58ba84c51c904e470271624db462ad4a79edcb932a6e8ac0052f20716baa`. Verified stylesheet: `/assets/index-BRxX98GU.css`.

## Repeat the browser checks

From `frontend`, install dependencies with `npm ci`, then start `npm run dev`. In a second terminal run `npm run test:themes`. On non-Windows hosts install Chromium with `npx playwright install chromium`; on Windows the test defaults to installed Microsoft Edge. `PLAYWRIGHT_CHANNEL` can override the browser.

Optional environment variables: `AUDIT_URL` (default `http://127.0.0.1:5173`), `SCHEMES` (comma-separated IDs), `ROUTES` (comma-separated paths), `AUDIT_OUTPUT`, and `DEEP=0` for only the initial route states. Reports and screenshots default to `frontend/test-results/theme-contrast/`.

## Release safety

The release image extends the exact currently running BuildTrack image and replaces frontend assets only. Prior hashed assets remain available to existing sessions. No backend, database schema, credentials, permissions, or agent configuration changes are part of this fix. The previous image is retained as `production-prod-buildtrack:rollback-contrast-20261015`; the deploy script checks for concurrent image changes and rolls back automatically if health validation fails.
