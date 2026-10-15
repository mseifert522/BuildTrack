const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-account-test-'));
process.env.DB_PATH = path.join(temp, 'test.db');
process.env.JWT_SECRET = 'test-account-secret-not-for-production';
const { initializeSchema, getDb } = require('../src/db/schema');
const { hashAgentKey, publicAgent } = require('../src/services/agentBridgeService');
const { agentDirectoryMetadata } = require('../src/services/accountPreferences');

(async () => {
  initializeSchema();
  initializeSchema(); // Additive migration is idempotent.
  const db = getDb();
  const insert = db.prepare('INSERT INTO users(id,name,email,password_hash,role,is_active) VALUES(?,?,?,?,?,?)');
  insert.run('one','One','one@test.invalid','hash','super_admin',1);
  insert.run('two','Two','two@test.invalid','hash','project_manager',1);
  insert.run('agent-test','Test Agent','agent@test.invalid','!no-password-login','super_admin',0);
  db.prepare('INSERT INTO agent_bridge_agents(id,agent_name,api_key_hash,enabled,allowed_scopes,acts_as_user_id) VALUES(?,?,?,?,?,?)')
    .run('test-agent','Test Agent',hashAgentKey('test-agent-key'),1,'["admin:read"]','agent-test');
  assert.equal(db.prepare('SELECT color_scheme FROM users WHERE id=?').get('one').color_scheme,'07');
  const app = express();
  app.use(express.json());
  app.use('/api/users',require('../src/routes/users'));
  app.use('/api/auth',require('../src/routes/auth'));
  app.use('/api/agent-bridge',require('../src/routes/agentBridge'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function call(route, method='GET', body, user='one') {
    const headers = { 'Content-Type':'application/json' };
    if(user) headers.Authorization = 'Bearer ' + jwt.sign({userId:user},process.env.JWT_SECRET,{expiresIn:'5m'});
    const response = await fetch(base + route, {method,headers,body:body ? JSON.stringify(body):undefined});
    return {status:response.status,body:await response.json(),headers:response.headers};
  }
  try {
    assert.equal((await call('/api/users/me/preferences','PUT',{color_scheme:'01'},null)).status,401);
    for(const color_scheme of ['01','07','08','02','dark-knight']) {
      assert.equal((await call('/api/users/me/preferences','PUT',{color_scheme})).status,200);
      assert.equal((await call('/api/auth/me')).body.color_scheme,color_scheme);
    }
    assert.equal((await call('/api/auth/me','GET',undefined,'two')).body.color_scheme,'07');
    assert.equal((await call('/api/users/me/preferences','PUT',{color_scheme:'08',user_id:'one'},'two')).status,200);
    assert.equal((await call('/api/auth/me')).body.color_scheme,'dark-knight');
    assert.equal((await call('/api/auth/refresh','POST',{})).body.user.color_scheme,'dark-knight');
    for(const color_scheme of ['03',null,7,{},['01']]) {
      assert.equal((await call('/api/users/me/preferences','PUT',{color_scheme})).status,400);
    }
    const directory = (await call('/api/users')).body;
    const agent = directory.find(user=>user.id==='agent-test');
    assert.equal(agent.agent_account.enabled,true);
    assert.equal(agent.is_active,0);
    assert.equal(agent.has_pin,0);
    assert.equal(JSON.stringify(directory).includes('api_key_hash'),false);
    assert.equal((await call('/api/users/agent-test','PUT',{is_active:1})).status,403);
    assert.equal((await call('/api/users/agent-test/unlock','POST',{})).status,403);
    assert.equal((await call('/api/users/agent-test/pin')).status,403);
    assert.equal(db.prepare('SELECT is_active FROM users WHERE id=?').get('agent-test').is_active,0);
    const admin = await call('/api/agent-bridge/admin/agents');
    assert.equal(admin.headers.get('cache-control'),'no-store');
    assert.equal(JSON.stringify(admin.body).includes('test-agent-key'),false);
    assert.equal(JSON.stringify(admin.body).includes('api_key_hash'),false);
    assert.equal((await call('/api/agent-bridge/admin/agents','GET',undefined,'two')).status,403);
    db.prepare('UPDATE agent_bridge_agents SET enabled=0 WHERE id=?').run('test-agent');
    assert.equal(agentDirectoryMetadata(db).get('agent-test').enabled,0);
    assert.equal(publicAgent(db.prepare('SELECT * FROM agent_bridge_agents').get()).api_key_hash,undefined);
    const old = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    assert.throws(()=>hashAgentKey('key'),/protection is not configured/);
    process.env.JWT_SECRET=old;
    console.log('PASS: default, five palettes, cross-user isolation, validation, auth, agent metadata, login protection, key secrecy and no-store');
  } finally {
    await new Promise(resolve=>server.close(resolve));
    db.close();
    fs.rmSync(temp,{recursive:true,force:true});
  }
})().catch(error => { console.error(error); process.exitCode=1; });
