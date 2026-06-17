const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { v4: uuidv4 } = require('uuid');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildtrack-agent-bridge-'));
process.env.DB_PATH = path.join(tempDir, 'buildtrack-test.db');
process.env.JWT_SECRET = 'agent-bridge-test-secret';

const { initializeSchema, getDb } = require('../src/db/schema');
const { hashAgentKey } = require('../src/services/agentBridgeService');
const agentBridgeRoutes = require('../src/routes/agentBridge');

const API_KEY = 'bt_agent_test_key';
const LIMITED_KEY = 'bt_agent_limited_key';

function seed() {
  const db = initializeSchema();
  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, role, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run('admin-user', 'Admin User', 'admin@example.test', 'hash', 'super_admin');
  db.prepare(`
    INSERT INTO projects (id, address, job_name, status, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run('project-123', '123 Main Street, Detroit, MI 48201', '123 Main', 'active_rehab', 'admin-user');
  db.prepare(`
    INSERT INTO projects (id, address, job_name, status, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run('project-124', '123 Main Street, Warren, MI 48089', '123 Main Warren', 'active_rehab', 'admin-user');
  db.prepare(`
    INSERT INTO projects (id, address, job_name, status, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run('project-500', '500 Oak Avenue, Detroit, MI 48202', '500 Oak', 'active_rehab', 'admin-user');
  db.prepare(`
    INSERT INTO agent_bridge_agents (id, agent_name, api_key_hash, enabled, allowed_scopes, created_by_user_id)
    VALUES (?, ?, ?, 1, ?, ?)
  `).run('agent-benito', 'Benito', hashAgentKey(API_KEY), JSON.stringify(['property:read', 'scope_of_work:write', 'punch_list:write']), 'admin-user');
  db.prepare(`
    INSERT INTO agent_bridge_agents (id, agent_name, api_key_hash, enabled, allowed_scopes, created_by_user_id)
    VALUES (?, ?, ?, 1, ?, ?)
  `).run('agent-limited', 'Jasmine', hashAgentKey(LIMITED_KEY), JSON.stringify(['property:read']), 'admin-user');
  db.prepare(`
    INSERT INTO agent_bridge_agents (id, agent_name, api_key_hash, enabled, allowed_scopes, created_by_user_id)
    VALUES (?, ?, ?, 0, ?, ?)
  `).run('agent-disabled', 'Disabled', hashAgentKey('disabled-key'), JSON.stringify(['property:read']), 'admin-user');
}

function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/agent-bridge', agentBridgeRoutes);
  return new Promise(resolve => {
    const server = app.listen(0, () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}/api/agent-bridge` });
    });
  });
}

async function request(baseUrl, pathName, { method = 'GET', key = API_KEY, agentName = 'Benito', requestId = uuidv4(), body } = {}) {
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'X-BuildTrack-Agent-Name': agentName,
      'X-Request-Id': requestId,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) { json = null; }
  return { status: res.status, json };
}

(async () => {
  seed();
  const db = getDb();
  const { server, baseUrl } = await startApp();

  try {
    let res = await request(baseUrl, '/property-lookup?address=500%20Oak%20Ave%20Detroit', { requestId: 'lookup-normalized' });
    assert.equal(res.status, 200);
    assert.equal(res.json.property.propertyId, 'project-500');

    res = await request(baseUrl, '/scope-of-work', {
      method: 'POST',
      requestId: 'scope-success',
      body: {
        intent: 'scope_of_work',
        propertyId: 'project-500',
        rawTranscript: 'Scope of work for 500 Oak: demo kitchen cabinets, paint bedrooms',
        title: 'AI Generated Scope of Work',
        items: [
          { description: 'Demo kitchen cabinets', category: 'Demolition', location: 'Kitchen', trade: 'General Contractor', status: 'not_started' },
          { description: 'Paint bedrooms', category: 'Painting', location: 'Bedrooms', trade: 'Painter', status: 'not_started' },
        ],
      },
    });
    assert.equal(res.status, 201);
    assert.equal(db.prepare('SELECT COUNT(*) as count FROM project_scopes WHERE agent_request_id = ?').get('scope-success').count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) as count FROM construction_plan_items WHERE agent_request_id = ?').get('scope-success').count, 2);
    assert.equal(db.prepare('SELECT COUNT(*) as count FROM activity_log WHERE action = ?').get('agent_bridge_scope_of_work_created').count, 1);

    res = await request(baseUrl, '/scope-of-work', {
      method: 'POST',
      requestId: 'scope-success',
      body: { intent: 'scope_of_work', propertyId: 'project-500', rawTranscript: 'Scope of work for 500 Oak: replace vanity' },
    });
    assert.equal(res.status, 409);
    assert.equal(db.prepare('SELECT COUNT(*) as count FROM construction_plan_items WHERE agent_request_id = ?').get('scope-success').count, 2);

    res = await request(baseUrl, '/punch-list', {
      method: 'POST',
      requestId: 'punch-success',
      body: {
        intent: 'punch_list',
        propertyId: 'project-500',
        rawTranscript: 'Punch list for 500 Oak: fix loose handrail, clean basement',
        items: [
          { description: 'Fix loose handrail', location: 'Stairway', priority: 'high', trade: 'Carpentry', status: 'open' },
        ],
      },
    });
    assert.equal(res.status, 201);
    assert.equal(db.prepare('SELECT COUNT(*) as count FROM punch_list_items WHERE agent_request_id = ?').get('punch-success').count, 1);
    assert.equal(db.prepare('SELECT punchlist_stage FROM projects WHERE id = ?').get('project-500').punchlist_stage, 1);

    res = await request(baseUrl, '/scope-of-work', {
      method: 'POST',
      key: 'wrong-key',
      requestId: 'invalid-key',
      body: { intent: 'scope_of_work', propertyId: 'project-500', items: [{ description: 'Paint' }] },
    });
    assert.equal(res.status, 401);

    res = await request(baseUrl, '/property-lookup?address=500%20Oak%20Ave', {
      key: 'disabled-key',
      agentName: 'Disabled',
      requestId: 'disabled-agent',
    });
    assert.equal(res.status, 403);

    res = await request(baseUrl, '/scope-of-work', {
      method: 'POST',
      key: LIMITED_KEY,
      agentName: 'Jasmine',
      requestId: 'scope-denied',
      body: { intent: 'scope_of_work', propertyId: 'project-500', items: [{ description: 'Paint' }] },
    });
    assert.equal(res.status, 403);

    res = await request(baseUrl, '/scope-of-work', {
      method: 'POST',
      requestId: 'missing-address',
      body: { intent: 'scope_of_work', rawTranscript: 'paint bedrooms', items: [{ description: 'Paint bedrooms' }] },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'MISSING_PROPERTY_ADDRESS');

    res = await request(baseUrl, '/punch-list', {
      method: 'POST',
      requestId: 'missing-items',
      body: { intent: 'punch_list', propertyId: 'project-500' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'MISSING_ITEMS');

    res = await request(baseUrl, '/property-lookup?address=123%20Main%20Street', { requestId: 'ambiguous-property' });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'AMBIGUOUS_PROPERTY_MATCH');

    res = await request(baseUrl, '/property-lookup?address=999%20Missing%20Street', { requestId: 'missing-property' });
    assert.equal(res.status, 404);
    assert.equal(res.json.error, 'PROPERTY_NOT_FOUND');

    res = await request(baseUrl, '/scope-of-work', {
      method: 'POST',
      requestId: 'fallback-parser',
      body: {
        intent: 'scope_of_work',
        propertyId: 'project-500',
        rawTranscript: 'Scope of work for 500 Oak: demo cabinets; replace drywall, paint bedrooms',
      },
    });
    assert.equal(res.status, 201);
    assert.equal(db.prepare('SELECT COUNT(*) as count FROM construction_plan_items WHERE agent_request_id = ?').get('fallback-parser').count, 3);

    assert.ok(db.prepare('SELECT COUNT(*) as count FROM agent_bridge_request_logs').get().count >= 8);
    console.log('Agent bridge tests passed');
  } finally {
    server.close();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
