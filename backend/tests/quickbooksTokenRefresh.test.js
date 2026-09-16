// Harness for BuildTrack refreshAccessToken: extracts the function from quickbooks.js and runs it
// against a simulated Intuit token endpoint that rotates the refresh token on EVERY refresh and
// rejects any superseded one. Never touches the network or the real database.
// usage: node tests/quickbooksTokenRefresh.test.js [path/to/quickbooks.js] [expect-bug]
//   expect-bug = negative control: exits 0 only if the given file REPRODUCES the stale-token bug.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = process.argv[2] || path.join(__dirname, '..', 'src', 'routes', 'quickbooks.js');
const expectBug = process.argv[3] === 'expect-bug';
const src = fs.readFileSync(file, 'utf8');

const start = src.indexOf('function readStoredConnectionTokens(') >= 0
  ? src.indexOf('function readStoredConnectionTokens(')
  : src.indexOf('async function refreshAccessToken(');
const end = src.indexOf('async function qboRequest(');
if (start < 0 || end < 0 || end <= start) throw new Error('could not locate refreshAccessToken in ' + file);
const fnSource = src.slice(start, end);

let Database = null;
for (const p of ['/app/backend/node_modules/better-sqlite3', 'better-sqlite3']) {
  try { Database = require(p); break; } catch (_) {}
}

function makeDb() {
  if (Database) {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE quickbooks_connections (
      id TEXT PRIMARY KEY, realm_id TEXT, environment TEXT, scope TEXT,
      access_token_encrypted TEXT, refresh_token_encrypted TEXT NOT NULL,
      access_token_expires_at TEXT, is_active INTEGER DEFAULT 1, updated_at TEXT)`);
    return db;
  }
  // Minimal fake for local runs without better-sqlite3 (handles the three statements used).
  const rows = new Map();
  return {
    exec() {},
    prepare(sql) {
      return {
        get: (id) => { const r = rows.get(id === undefined ? 'primary' : id); return r ? { ...r } : undefined; },
        run: (...args) => {
          if (/^\s*INSERT/i.test(sql)) { const [id, at, rt, exp] = args; rows.set(id, { id, realm_id: '1', environment: 'production', scope: 's', access_token_encrypted: at, refresh_token_encrypted: rt, access_token_expires_at: exp, is_active: 1 }); return; }
          const [at, rt, exp, scope, id] = args; const r = rows.get(id);
          Object.assign(r, { access_token_encrypted: at, refresh_token_encrypted: rt, access_token_expires_at: exp, scope: scope || r.scope });
        },
      };
    },
  };
}

function makeWorld({ failNext = 0, delayMs = 25 } = {}) {
  const db = makeDb();
  const intuit = { current: 'R1', seq: 1, calls: 0, rejected: 0, failNext };
  const ctx = {
    console, Date, Map, Promise, Object, Number, String, Boolean,
    encryptSecret: (v) => `enc:${v}`,
    decryptSecret: (v) => String(v).replace(/^enc:/, ''),
    addSeconds: (s) => new Date(Date.now() + s * 1000).toISOString(),
    tokenRequest: async (params) => {
      intuit.calls += 1;
      await new Promise((r) => setTimeout(r, delayMs));
      if (intuit.failNext > 0) { intuit.failNext -= 1; const e = new Error('Intuit down'); e.statusCode = 503; throw e; }
      if (params.grant_type !== 'refresh_token' || params.refresh_token !== intuit.current) {
        intuit.rejected += 1;
        const e = new Error('Incorrect or invalid refresh token'); e.statusCode = 400; throw e;
      }
      intuit.seq += 1;
      intuit.current = `R${intuit.seq}`;
      return { access_token: `A${intuit.seq}`, refresh_token: intuit.current, expires_in: 3600, scope: 'com.intuit.quickbooks.accounting' };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`const qboTokenRefreshInFlight = new Map();\n${fnSource}\nthis.refreshAccessToken = refreshAccessToken;`, ctx);
  const seed = (accessExpiresInSec) => db.prepare(`INSERT INTO quickbooks_connections (id, access_token_encrypted, refresh_token_encrypted, access_token_expires_at, realm_id, environment, scope, is_active) VALUES (?, ?, ?, ?, '1', 'production', 's', 1)`)
    .run('primary', 'enc:A1', 'enc:R1', new Date(Date.now() + accessExpiresInSec * 1000).toISOString());
  const load = () => db.prepare(`SELECT * FROM quickbooks_connections WHERE id = ?`).get('primary');
  return { db, intuit, ctx, seed, load, refresh: (c) => ctx.refreshAccessToken(db, c) };
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push([true, name]); } catch (e) { results.push([false, `${name} -> ${e.message}`]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  // 1. Finance Tracker pattern: load once, 8 sequential requests, token needs refresh.
  await check('sequential requests on one loaded connection refresh once and all succeed', async () => {
    const w = makeWorld(); w.seed(30);
    const conn = w.load();
    const tokens = [];
    for (let i = 0; i < 8; i++) tokens.push(await w.refresh(conn));
    assert(w.intuit.calls === 1, `expected 1 Intuit call, got ${w.intuit.calls}`);
    assert(w.intuit.rejected === 0, `rejected ${w.intuit.rejected}`);
    assert(tokens.every((t) => t === 'A2'), `tokens ${tokens.join(',')}`);
    assert(w.load().refresh_token_encrypted === 'enc:R2', 'stored refresh token not rotated');
  });

  // 2. A connection object loaded BEFORE someone else refreshed.
  await check('stale caller copy uses the refreshed stored token without a new refresh', async () => {
    const w = makeWorld(); w.seed(30);
    const stale = w.load();
    await w.refresh(w.load());
    const callsBefore = w.intuit.calls;
    const t = await w.refresh(stale);
    assert(t === 'A2', `got ${t}`);
    assert(w.intuit.calls === callsBefore, `extra Intuit call (${w.intuit.calls - callsBefore})`);
    assert(stale.refresh_token_encrypted === 'enc:R2', 'caller copy not updated');
  });

  // 3. Concurrent callers (auto-sync + service endpoint at the same moment).
  await check('5 concurrent callers share one refresh', async () => {
    const w = makeWorld({ delayMs: 40 }); w.seed(10);
    const out = await Promise.all([0, 1, 2, 3, 4].map(() => w.refresh(w.load())));
    assert(w.intuit.calls === 1, `expected 1 Intuit call, got ${w.intuit.calls}`);
    assert(out.every((t) => t === 'A2'), `tokens ${out.join(',')}`);
  });

  // 4. Token endpoint failure: everyone waiting sees it, nothing is written, next call retries.
  await check('failed refresh rejects waiters, leaves the row alone, and the next call retries', async () => {
    const w = makeWorld({ failNext: 1 }); w.seed(10);
    const settled = await Promise.allSettled([0, 1, 2].map(() => w.refresh(w.load())));
    assert(settled.every((s) => s.status === 'rejected' && /Intuit down/.test(s.reason.message)), 'not all rejected with the Intuit error');
    assert(w.intuit.calls === 1, `expected 1 Intuit call, got ${w.intuit.calls}`);
    assert(w.load().refresh_token_encrypted === 'enc:R1', 'row changed after a failed refresh');
    const t = await w.refresh(w.load());
    assert(t === 'A2' && w.intuit.calls === 2, `retry got ${t} after ${w.intuit.calls} calls`);
  });

  // 5. Valid token: no refresh at all.
  await check('valid stored token returns without calling Intuit', async () => {
    const w = makeWorld(); w.seed(1800);
    const t = await w.refresh(w.load());
    assert(t === 'A1' && w.intuit.calls === 0, `got ${t}, calls ${w.intuit.calls}`);
  });

  // 6. Response without refresh_token keeps the stored one.
  await check('refresh response without refresh_token keeps the stored refresh token', async () => {
    const w = makeWorld(); w.seed(10);
    const orig = w.ctx.tokenRequest;
    w.ctx.tokenRequest = async (p) => { const r = await orig(p); w.intuit.current = 'R1'; return { access_token: r.access_token, expires_in: 3600 }; };
    await w.refresh(w.load());
    assert(w.load().refresh_token_encrypted === 'enc:R1', `stored ${w.load().refresh_token_encrypted}`);
  });

  const failed = results.filter(([ok]) => !ok).length;
  for (const [ok, name] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`${Database ? 'sqlite=better-sqlite3' : 'sqlite=fake'}  ${results.length - failed}/${results.length} passed  (${file})`);
  if (expectBug) {
    // Negative control: the original code must FAIL the bug scenarios (1-3).
    const bugReproduced = results.slice(0, 3).some(([ok]) => !ok);
    console.log(bugReproduced ? 'CONTROL OK: original code reproduces the bug' : 'CONTROL BROKEN: original code passed the bug scenarios');
    process.exit(bugReproduced ? 0 : 1);
  }
  process.exit(failed ? 1 : 0);
})();
