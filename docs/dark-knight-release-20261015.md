# Dark Knight account color option

The first fresh Dark Knight sample, Monolith, is available as the fifth color choice under Profile → Settings → Preferred Color. Its black surfaces, silver actions, and self-hosted Inter Tight variable font apply immediately throughout the desktop workspace. The original palette IDs retain their meanings; the new choice uses internal ID `dark-knight` and display number 05. The default remains Midnight Navy (07).

The preference is saved to the signed-in user's existing account field and returned by authentication/refresh responses. Failed saves restore both the previous colors and font. Five previews fit in a three-column grid on wide desktops; smaller screens retain two or one columns. The active settings tab and selected palette checkmark use matching foreground/background pairs.

## Account migration and release safety

The existing SQLite `users.color_scheme` CHECK constraint accepted only four values. The migration expands that constraint in one transaction using SQLite's table-rebuild procedure, preserving all columns, rowids, data, indexes, triggers, views, and foreign-key relationships. Unknown schemas or collisions fail closed; no second preference store is introduced.

A private SQLite backup is retained in the existing data volume at `secure-backups/before-dark-knight-20261015.db`, mode 0600. Testing on a disposable copy verified byte-equivalent row fingerprints across all 97 tables during the color migration, along with schema-object preservation and foreign-key integrity. Startup's existing Cost Analyzer category seed also runs normally; it is unrelated to the color migration.

The new image extends the exact prior production image and copies only the frontend and the affected account-preference code. Previous hashed web assets remain available. The prior image is retained as `production-prod-buildtrack:rollback-knight-20261015`. An image rollback can leave the expanded database constraint in place; it remains compatible with the old four themes. Old frontend code falls back to 07 if it encounters a saved Dark Knight preference.

## Verification

- Production TypeScript/Vite build; frontend lint has 0 errors and 35 existing warnings.
- Full backend test suite, including five account preferences, cross-user isolation, authentication/refresh, API-key protections, agent behavior, quotes, HR, and Cost Analyzer.
- Migration tests cover existing accounts, extra columns, foreign keys, indexes, triggers, views, repeated startup, invalid choices, and collision rollback.
- Browser tests cover all five immediate color changes, fifth-card placement, reload persistence, font loading/restoration, selected-tab/checkmark colors, and failed-save rollback.
- Dark Knight: all 60 desktop route/tab/form/menu states pass measured text contrast checks with representative sample data. Updated settings states also pass in the four existing schemes.

Browser rendering checks intercept API calls and use synthetic records; they do not modify business data or establish exhaustive coverage of every production record and workflow.
