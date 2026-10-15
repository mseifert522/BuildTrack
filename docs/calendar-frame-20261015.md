# Calendar frame — October 15, 2026

The bright frame around the operations calendar was the page wrapper's hard-coded ivory background, visible in dark themes. `frontend/src/operations-calendar-pro.css` now uses the selected account palette for the surround, foreground, calendar surface, and 1-pixel outer border. Outer spacing is reduced from 18px to 10px, and the decorative inset/deep shadow is removed. Calendar controls, grid structure, and event behavior are unchanged.

Validation: production build passed; the existing calendar audit passed 20 combinations (Month, Week, Day, event form across all five themes) with zero contrast violations or browser errors. After publication, all five calendar palettes passed again using published assets with synthetic API fixtures. Dark Knight and light-theme screenshots were visually inspected; the bright frame is gone. Public health and the existing reply endpoint authentication checks passed.

- Feature commit: `8b4496f` on `codex/account-colors-agent-status`.
- Deployment: only `prod-buildtrack` on `newurbandev-prod`, project `maps-442718`, zone `us-central1-a`.
- New image: `sha256:2c1ba80f3460bd5374718993f6da0d2f2e5789b5a8a5d35eca967377e506d2f6` (healthy).
- Prior image retained as `production-prod-buildtrack:rollback-calendar-frame-20261015`: `sha256:262e0b9b6d3078cb203fbf1c611faaa24a56ec8f0b2ac74ca868f8f8fddbf7ac`.
- Published CSS: `/assets/index-zydKlN-L.css`; entry JavaScript: `/assets/index-bR2NyQN2.js`.
- Release scripts/logs: `/tmp/buildtrack-calendar-frame-20261015/` on the VM. Deployment guards against a changed production image and restores the prior image on a failed health check.
- Existing hashed assets and browser Maps configuration were preserved. This release changes frontend styling only; no database, backend source, or Supabase files changed.
- Local screenshots/audit output: `frontend/test-results/calendar-frame/` and `frontend/test-results/calendar-frame-published/` (ignored generated artifacts).
