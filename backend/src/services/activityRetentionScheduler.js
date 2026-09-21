// Daily activity_log retention: keep the last ACTIVITY_LOG_RETENTION_DAYS (default 30)
// and delete everything older, per Mike 2026-09-21. ~99% of the table is the
// per-minute QuickBooks sync record (2,880 rows/day), so without this it grows forever.
//
// Nothing relies on rows older than a day: the only logic reader is the Friday
// payment-queue "already sent" guard, which looks up a row written the same day.
// Every other reader (the bell, project activity, review badges) is display-only.
//
// Deletes in small batches and yields between them, so the SQLite write lock is held
// for milliseconds and the app's own writers never wait long. Idempotent, so it is
// harmless if blue and green both run it during a blue-green overlap.
const { getDb } = require('../db/schema');

const TAG = '[ACTIVITY RETENTION]';
const BATCH_SIZE = 500;
const BATCH_PAUSE_MS = 50;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function retentionDays() {
  const days = Number.parseInt(process.env.ACTIVITY_LOG_RETENTION_DAYS || '30', 10);
  // Below 1 day would remove the row the Friday payment-queue guard needs.
  return Number.isFinite(days) && days >= 1 ? days : 0;
}

let running = false;

async function purgeOldActivity() {
  const days = retentionDays();
  if (!days || running) return { deleted: 0, skipped: true };
  running = true;
  try {
    const db = getDb();
    // activity_log.created_at is stored as 'YYYY-MM-DD HH:MM:SS' (UTC), the same format
    // datetime() returns, so this compare is exact and served by idx_activity_log_created_at.
    const cutoff = db.prepare("SELECT datetime('now', ?) AS cutoff").get(`-${days} days`).cutoff;
    const remove = db.prepare(`
      DELETE FROM activity_log
      WHERE rowid IN (SELECT rowid FROM activity_log WHERE created_at < ? LIMIT ?)
    `);
    let deleted = 0;
    for (;;) {
      const changes = remove.run(cutoff, BATCH_SIZE).changes;
      deleted += changes;
      if (changes < BATCH_SIZE) break;
      await sleep(BATCH_PAUSE_MS);
    }
    // Keep the query planner's statistics current as the data changes. Cheap: it only
    // re-analyzes tables that changed enough to matter.
    db.pragma('optimize');
    if (deleted) console.log(`${TAG} Deleted ${deleted} rows older than ${days} days (before ${cutoff} UTC)`);
    return { deleted, cutoff };
  } finally {
    running = false;
  }
}

function startActivityRetentionScheduler() {
  if (String(process.env.ACTIVITY_LOG_RETENTION_ENABLED || 'true').toLowerCase() === 'false') {
    console.log(`${TAG} Disabled by environment`);
    return;
  }
  if (!retentionDays()) {
    console.log(`${TAG} Disabled (ACTIVITY_LOG_RETENTION_DAYS < 1)`);
    return;
  }
  const intervalMs = Number.parseInt(process.env.ACTIVITY_LOG_RETENTION_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10);
  const run = () => purgeOldActivity().catch(err => console.error(`${TAG} Purge failed:`, err.message || err));
  // First run 10 minutes after boot, well clear of a blue-green swap in progress.
  setTimeout(run, 10 * 60 * 1000).unref?.();
  setInterval(run, Number.isFinite(intervalMs) && intervalMs >= 60 * 60 * 1000 ? intervalMs : 24 * 60 * 60 * 1000).unref?.();
  console.log(`${TAG} Scheduler started (keep ${retentionDays()} days, daily)`);
}

module.exports = { startActivityRetentionScheduler, purgeOldActivity };
