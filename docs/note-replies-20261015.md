# Project note conversations — October 15, 2026

Users who can read a project note can now reply directly on the dashboard, project notes, project progress history, or mobile notes. Replies display the responder's current profile photo (initials if unavailable), name, original text, and New York timestamp. Existing note layouts, note permissions, themes, and day/entry separators remain intact.

The user's confirmed scope is **original project only**. A single `project_note_replies` record belongs to its parent note; replies are never copied into another property. Dashboard and project reads return the same reply IDs and content. Reply activity brings an older conversation back into the recent dashboard feed. Mobile keeps original note-day groups stable.

## Access and reliability

- Project authorization runs before reply creation. Contractors must be assigned and can reply only to their own or public notes. Private management conversations stay private.
- The server derives the author and avatar from the authenticated account, ignoring submitted author/project/visibility overrides.
- Replies and their audit records are saved in one transaction. A per-user, per-note request ID makes double-clicks and retries safe, including when the server saves a reply but the response is lost.
- Text is required, limited to 10,000 characters, and rendered as text. Errors retain the draft for retry.
- Desktop screens use an authenticated SSE invalidation stream; mobile uses the existing project stream. Both refresh after reconnect or returning to the screen and fall back to polling when disconnected. Session/role and contractor assignment checks continue during streams. Session tokens stay in authorization headers.
- The consolidated stream carries only a project invalidation. It does not broadcast note bodies. Agent API keys cannot open it; no new agent write permissions were granted.
- Existing note deletion cascades to replies, with the deleted conversation included in the existing audit snapshot.

## Validation

- `npm test` in `backend`: all nine suites passed locally and in the exact release image, without production credentials or network access.
- New HTTP/SQLite tests cover all five roles, missing authentication, wrong project, unassigned contractors, private notes, author/avatar forgery, invalid inputs, repeat/concurrent requests, one audit record per saved reply, consistent dashboard/project/recent reads, recent-thread ordering, stream privacy, access revocation, parent edits/deletion, and repeated schema initialization.
- `npm run build` and `npm run lint` in `frontend` passed. Lint remains at **0 errors, 35 pre-existing warnings**.
- `node tests/note-replies.cjs`: real isolated SQLite API and SSE with two browser users, dashboard/project/mobile synchronization, reply photos, saved drafts, a lost-response retry, and contrast/accessibility checks in all five palettes (15 screen/theme combinations). A final Dark Knight run passed after the mobile reconnect/day-group adjustment.
- `node tests/note-separators.cjs`: 70 regression checks passed across all five palettes, including mobile.
- Published desktop assets were exercised with synthetic API requests routed exclusively to a local test database, including replies in both directions and contrast in all five palettes. No test replies were posted to production business notes. An initial Dark Knight check exceeded the test's 5-second assertion timeout; the remote-asset allowance was increased to 15 seconds, the targeted repeat passed, and a complete final repeat passed all 10 desktop screen/theme combinations with no browser errors.
- Live health is OK. The new reply and consolidated-stream endpoints reject unauthenticated requests with 401. The published JavaScript and CSS contain the reply interface.

## Release and recovery

- Source feature commit: `3a8488c`, branch `codex/account-colors-agent-status`.
- VM: `newurbandev-prod`, GCP project `maps-442718`, zone `us-central1-a`.
- Container: `prod-buildtrack`; Compose file `/opt/infrastructure/docker-compose.yml`.
- Release image: `sha256:262e0b9b6d3078cb203fbf1c611faaa24a56ec8f0b2ac74ca868f8f8fddbf7ac`.
- Previous image: `sha256:b96fb908f74afc02aaaa0208990df64f1f0e3dd83a290a66fc4469f260c8c4c4`, retained as `production-prod-buildtrack:rollback-replies-20261015`.
- Runtime database backup: `/app/backend/data/secure-backups/before-note-replies-20261015.db`, mode 0600 within the existing private data volume. The online SQLite backup passed integrity checks.
- The additive schema was tested twice against a disposable copy of that backup in a container with no network. All 97 existing business tables and 261 prior schema objects were preserved; foreign-key state and database integrity were unchanged. Only the existing category-seed timestamp refresh was excluded from row fingerprints. The new reply table was empty and indexed.
- Only `prod-buildtrack` was recreated. Other services were not restarted. Existing frontend hashed assets and Maps configuration were retained.
- Published entry assets: `/assets/index-CWEZnx9h.js`, `/assets/index-DkurFnJM.css`; shared reply code is in `/assets/noteEvents-Cl-f5jyK.js`.
- Release scripts and logs: `/tmp/buildtrack-replies-20261015/` on the VM. The guarded deployment script restores the previous image if health fails. An application rollback can retain the additive reply table and preserve any newly submitted replies; restoring the old database backup is not necessary for an image rollback.
- No Supabase migration or configuration file was changed.

## Existing limitation

`https://mobile.buildtrack.newurbandev.com/` still fails its HTTPS handshake, independently of this release (reconfirmed after deployment). Mobile reply behavior passed local browser integration tests; the live mobile hostname could not be validated. The main desktop hostname is healthy.
