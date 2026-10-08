const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { v4: uuidv4 } = require('uuid');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildtrack-agent-principal-'));
process.env.DB_PATH = path.join(tempDir, 'buildtrack-test.db');
process.env.JWT_SECRET = 'agent-principal-test-secret';
process.env.AGENT_API_RATE_LIMIT_MAX = '1000';

const { initializeSchema, getDb } = require('../src/db/schema');
const { hashAgentKey, resolveProperty } = require('../src/services/agentBridgeService');
const { authenticate } = require('../src/middleware/auth');
const { createUploadsGate } = require('../src/middleware/uploadsGate');
const projectRoutes = require('../src/routes/projects');
const notesRoutes = require('../src/routes/notes');
const agentBridgeRoutes = require('../src/routes/agentBridge');

const KEY = 'bt_agent_full_key';
const NO_NOTES_KEY = 'bt_agent_no_notes';
const LEGACY_KEY = 'bt_agent_legacy';
const UNLINKED_KEY = 'bt_agent_unlinked';
const uploadsRoot = path.join(tempDir, 'uploads');

function seed() {
  const db = initializeSchema();
  const addUser = db.prepare('INSERT INTO users (id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, ?)');
  addUser.run('admin-user', 'Admin User', 'admin@example.test', 'hash', 'super_admin', 1);
  addUser.run('agent-benito', 'Benito (AI Agent)', 'benito-agent@agents.buildtrack.invalid', '!agent-no-login', 'super_admin', 0);
  const addProject = db.prepare('INSERT INTO projects (id, address, job_name, status, created_by) VALUES (?, ?, ?, ?, ?)');
  addProject.run('project-joel', '34641 Joel St, New Baltimore, MI 48047, USA', '34641 Joel', 'active_rehab', 'admin-user');
  addProject.run('project-wis', '2811 Wisconsin Rd, Troy, MI 48083, USA', '2811 Wisconsin', 'active_rehab', 'admin-user');
  addProject.run('project-blair', '1132 N Blair Ave, Royal Oak, MI 48067, USA', '1132 Blair', 'active_rehab', 'admin-user');
  db.prepare(`INSERT INTO project_notes (id, project_id, user_id, note, note_type, visibility, created_at)
    VALUES ('note-1', 'project-wis', 'admin-user', 'Existing admin note', 'general', 'private', datetime('now'))`).run();
  const addAgent = db.prepare(`
    INSERT INTO agent_bridge_agents (id, agent_name, api_key_hash, enabled, allowed_scopes, acts_as_user_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  addAgent.run('a-benito', 'Benito', hashAgentKey(KEY), 1, JSON.stringify(['property:read', 'punch_list:write', 'scope_of_work:write', 'admin:read', 'notes:write']), 'agent-benito');
  addAgent.run('a-reader', 'Reader', hashAgentKey(NO_NOTES_KEY), 1, JSON.stringify(['admin:read']), 'agent-benito');
  addAgent.run('a-legacy', 'Legacy', hashAgentKey(LEGACY_KEY), 1, JSON.stringify(['property:read']), 'agent-benito');
  addAgent.run('a-unlinked', 'Unlinked', hashAgentKey(UNLINKED_KEY), 1, JSON.stringify(['admin:read']), null);
  addAgent.run('a-off', 'Off', hashAgentKey('off-key'), 0, JSON.stringify(['admin:read']), 'agent-benito');
  fs.mkdirSync(path.join(uploadsRoot, 'project-wis'), { recursive: true });
  fs.writeFileSync(path.join(uploadsRoot, 'project-wis', 'site.jpg'), 'jpegbytes');
}

function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/uploads', createUploadsGate(uploadsRoot), express.static(uploadsRoot));
  app.use('/api/projects', projectRoutes);
  app.use('/api/projects/:projectId/notes', notesRoutes);
  app.use('/api/agent-bridge', agentBridgeRoutes);
  // Stand-ins: the denial is decided in authenticate(), before any handler.
  app.get('/api/auth/me', authenticate, (_req, res) => res.json({ ok: true }));
  app.get('/api/quickbooks/connect-url', authenticate, (_req, res) => res.json({ ok: true }));
  app.get('/api/users/:id/pin', authenticate, (_req, res) => res.json({ pin: '123456' }));
  app.get('/api/human-resources/ai-settings/anthropic', authenticate, (_req, res) => res.json({ ok: true }));
  app.get('/api/human-resources/employees', authenticate, (req, res) => res.json({ role: req.user.role }));
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function call(base, pathName, { method = 'GET', key = KEY, agent = 'Benito', requestId, body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (key) h['X-BuildTrack-Agent-Key'] = key;
  if (agent) h['X-BuildTrack-Agent-Name'] = agent;
  if (requestId) h['X-Request-Id'] = requestId;
  const res = await fetch(`${base}${pathName}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  return { status: res.status, json, text };
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (err) {
    results.push(['FAIL', name, err.message]);
  }
}

(async () => {
  seed();
  const db = getDb();
  const { server, base } = await startApp();
  try {
    await check('no agent key keeps normal auth (401)', async () => {
      const r = await call(base, '/api/projects', { key: null, agent: null });
      assert.equal(r.status, 401);
      assert.equal(r.json.error, 'Authentication required');
    });
    await check('agent lists every project', async () => {
      const r = await call(base, '/api/projects');
      assert.equal(r.status, 200, r.text.slice(0, 200));
      const list = Array.isArray(r.json) ? r.json : (r.json.projects || []);
      assert.deepEqual(list.map(p => p.id).sort(), ['project-blair', 'project-joel', 'project-wis']);
    });
    await check('agent reads one project', async () => {
      const r = await call(base, '/api/projects/project-wis');
      assert.equal(r.status, 200, r.text.slice(0, 200));
    });
    await check('agent reads project notes', async () => {
      const r = await call(base, '/api/projects/project-wis/notes');
      assert.equal(r.status, 200, r.text.slice(0, 200));
      const notes = Array.isArray(r.json) ? r.json : (r.json.notes || []);
      assert.ok(notes.some(n => n.note === 'Existing admin note'));
    });
    await check('agent reads an admin-only area as super_admin', async () => {
      const r = await call(base, '/api/human-resources/employees');
      assert.equal(r.status, 200);
      assert.equal(r.json.role, 'super_admin');
    });
    await check('agent adds a note as its own user', async () => {
      const r = await call(base, '/api/projects/project-wis/notes', { method: 'POST', requestId: 'tg-1-note', body: { note: 'Water coming in at the back of the house.' } });
      assert.equal(r.status, 201, r.text.slice(0, 200));
      assert.equal(r.json.user_id, 'agent-benito');
      assert.equal(r.json.user_name, 'Benito (AI Agent)');
      const row = db.prepare("SELECT user_id, visibility FROM project_notes WHERE note LIKE 'Water coming in%'").get();
      assert.equal(row.user_id, 'agent-benito');
      assert.equal(row.visibility, 'private');
    });
    await check('retrying the same note is refused, not duplicated', async () => {
      const r = await call(base, '/api/projects/project-wis/notes', { method: 'POST', requestId: 'tg-1-note', body: { note: 'Water coming in at the back of the house.' } });
      assert.equal(r.status, 409);
      assert.equal(r.json.error, 'DUPLICATE_REQUEST_ID');
      assert.equal(db.prepare("SELECT COUNT(*) c FROM project_notes WHERE note LIKE 'Water coming in%'").get().c, 1);
    });
    await check('a note needs X-Request-Id', async () => {
      const r = await call(base, '/api/projects/project-wis/notes', { method: 'POST', body: { note: 'x' } });
      assert.equal(r.status, 400);
      assert.equal(r.json.error, 'MISSING_REQUEST_ID');
    });
    await check('editing a note is refused', async () => {
      const r = await call(base, '/api/projects/project-wis/notes/note-1', { method: 'PUT', requestId: 'e1', body: { note: 'changed' } });
      assert.equal(r.status, 403);
      assert.equal(r.json.error, 'AGENT_READ_ONLY');
      assert.equal(db.prepare("SELECT note FROM project_notes WHERE id = 'note-1'").get().note, 'Existing admin note');
    });
    await check('deleting a note or project is refused', async () => {
      assert.equal((await call(base, '/api/projects/project-wis/notes/note-1', { method: 'DELETE', requestId: 'd1' })).status, 403);
      assert.equal((await call(base, '/api/projects/project-wis', { method: 'DELETE', requestId: 'd2' })).status, 403);
      assert.equal(db.prepare('SELECT COUNT(*) c FROM projects').get().c, 3);
    });
    await check('creating a project is refused', async () => {
      const r = await call(base, '/api/projects', { method: 'POST', requestId: 'p1', body: { address: '1 Test' } });
      assert.equal(r.status, 403);
    });
    await check('notes:write is required to add a note', async () => {
      const r = await call(base, '/api/projects/project-wis/notes', { method: 'POST', key: NO_NOTES_KEY, agent: 'Reader', requestId: 'r1', body: { note: 'x' } });
      assert.equal(r.status, 403);
      assert.equal(r.json.error, 'AGENT_SCOPE_DENIED');
    });
    await check('an agent without admin:read cannot use the API', async () => {
      const r = await call(base, '/api/projects', { key: LEGACY_KEY, agent: 'Legacy' });
      assert.equal(r.status, 403);
    });
    await check('wrong key, wrong name, disabled, unlinked', async () => {
      assert.equal((await call(base, '/api/projects', { key: 'bt_agent_wrong' })).status, 401);
      assert.equal((await call(base, '/api/projects', { agent: 'Nobody' })).status, 401);
      assert.equal((await call(base, '/api/projects', { agent: null })).status, 400);
      assert.equal((await call(base, '/api/projects', { key: 'off-key', agent: 'Off' })).status, 403);
      assert.equal((await call(base, '/api/projects', { key: UNLINKED_KEY, agent: 'Unlinked' })).status, 503);
    });
    await check('a key for one agent does not work under another name', async () => {
      assert.equal((await call(base, '/api/projects', { key: KEY, agent: 'Reader' })).status, 401);
    });
    await check('denied endpoints: auth, PINs, AI key settings, agent admin, notes stream, QuickBooks OAuth', async () => {
      for (const p of ['/api/auth/me', '/api/users/admin-user/pin', '/api/human-resources/ai-settings/anthropic', '/api/agent-bridge/admin/agents', '/api/projects/project-wis/notes/stream', '/api/quickbooks/connect-url']) {
        const r = await call(base, p);
        assert.equal(r.status, 403, p);
        assert.equal(r.json.error, 'AGENT_PATH_DENIED', p);
      }
    });
    await check('the bridge endpoints still work with the Bearer key', async () => {
      const res = await fetch(`${base}/api/agent-bridge/property-lookup?address=${encodeURIComponent('34641 Joel Street, Chesterfield, MI')}`, {
        headers: { Authorization: `Bearer ${KEY}`, 'X-BuildTrack-Agent-Name': 'Benito', 'X-Request-Id': uuidv4() },
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).property.propertyId, 'project-joel');
    });
    await check('address match ignores a different city for the same house + street', async () => {
      for (const a of ['34641 Joel Street, Chesterfield, MI', '34641 Joel, Chesterfield Township, MI', '34641 Joel Dr, Chesterfield, MI 48051']) {
        assert.equal(resolveProperty(db, { propertyAddress: a }).project.id, 'project-joel', a);
      }
      assert.equal(resolveProperty(db, { propertyAddress: '1132 Blair, Royal Oak' }).project.id, 'project-blair');
      db.prepare("INSERT INTO projects (id, address, job_name, status, created_by) VALUES ('project-sblair', '1132 S Blair Ave, Royal Oak, MI 48067, USA', 'S Blair', 'active_rehab', 'admin-user')").run();
      assert.throws(() => resolveProperty(db, { propertyAddress: '1132 Blair, Royal Oak' }), /Multiple/);
      db.prepare("DELETE FROM projects WHERE id = 'project-sblair'").run();
      assert.throws(() => resolveProperty(db, { propertyAddress: '34642 Joel St, Chesterfield, MI' }), /does not exist/);
      assert.throws(() => resolveProperty(db, { propertyAddress: 'Joel Street, Chesterfield, MI' }), /does not exist|Multiple/);
    });
    await check('agent opens a project file under /uploads', async () => {
      const r = await call(base, '/uploads/project-wis/site.jpg');
      assert.equal(r.status, 200);
      assert.equal(r.text, 'jpegbytes');
      assert.equal((await call(base, '/uploads/project-wis/site.jpg', { key: 'bt_agent_wrong' })).status, 401);
      assert.equal((await call(base, '/uploads/project-wis/site.jpg', { key: LEGACY_KEY, agent: 'Legacy' })).status, 401);
    });
    await check('every agent call is audited, including refusals', async () => {
      const rows = db.prepare("SELECT intent, status, endpoint FROM agent_bridge_request_logs WHERE agent_id = 'a-benito'").all();
      assert.ok(rows.some(r => r.intent === 'api_read' && r.status === 'completed' && r.endpoint === 'GET /api/projects'));
      assert.ok(rows.some(r => r.intent === 'note_create' && r.status === 'completed'));
      assert.ok(rows.some(r => r.intent === 'denied' && r.endpoint.startsWith('PUT ')));
      assert.ok(rows.some(r => r.intent === 'denied' && r.endpoint === 'GET /api/auth/me'));
      assert.ok(!rows.some(r => r.status === 'processing'), 'no row left in processing');
    });
    await check('the linked user cannot sign in (inactive)', async () => {
      const u = db.prepare("SELECT * FROM users WHERE id = 'agent-benito'").get();
      assert.equal(u.is_active, 0);
      assert.equal(db.prepare('SELECT COUNT(*) c FROM users WHERE id = ? AND is_active = 1').get('agent-benito').c, 0);
    });
    await check('nested routers authorize and log a request once', async () => {
      const before = db.prepare("SELECT COUNT(*) c FROM agent_bridge_request_logs WHERE agent_id = 'a-benito'").get().c;
      await call(base, '/api/projects/project-wis/notes');
      const after = db.prepare("SELECT COUNT(*) c FROM agent_bridge_request_logs WHERE agent_id = 'a-benito'").get().c;
      assert.equal(after - before, 1);
    });
  } finally {
    server.close();
    for (const r of results) console.log(r.join(' | '));
    const failed = results.filter(r => r[0] === 'FAIL').length;
    console.log(`${results.length - failed}/${results.length} agent principal checks passed`);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    if (failed) process.exitCode = 1;
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
