const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-replies-test-'));
process.env.DB_PATH = path.join(temp, 'test.db');
process.env.JWT_SECRET = 'test-replies-secret-not-for-production';
const { initializeSchema, getDb } = require('../src/db/schema');

(async () => {
  initializeSchema();
  const db = getDb();
  const roles = ['super_admin','operations_manager','project_manager','admin_assistant','contractor'];
  for (const [i,role] of roles.entries()) db.prepare('INSERT INTO users(id,name,email,password_hash,role,is_active,avatar_url) VALUES(?,?,?,?,?,1,?)').run('u'+i,role,role+'@test.invalid','hash',role,'/uploads/avatar-'+i+'.jpg');
  db.prepare('INSERT INTO users(id,name,email,password_hash,role,is_active) VALUES(?,?,?,?,?,1)').run('other','Other','other@test.invalid','hash','contractor');
  for (const id of ['p1','p2']) db.prepare('INSERT INTO projects(id,address,job_name,created_by) VALUES(?,?,?,?)').run(id,id,'Test property','u0');
  db.prepare('INSERT INTO project_assignments(id,project_id,user_id,assigned_by) VALUES(?,?,?,?)').run('a1','p1','u4','u0');
  for (const [id,user,visibility,date] of [['old','u2','public','2020-01-01'],['private','u2','private','2026-01-02'],['own','u4','private','2026-01-03']]) {
    db.prepare('INSERT INTO project_notes(id,project_id,user_id,note,visibility,created_at) VALUES(?,?,?,?,?,?)').run(id,'p1',user,'Original '+id,visibility,date);
  }
  const original = db.prepare('SELECT * FROM project_notes ORDER BY id').all();
  initializeSchema();
  assert.deepEqual(db.prepare('SELECT * FROM project_notes ORDER BY id').all(),original);
  const notes = require('../src/routes/notes');
  const { authenticate, rejectTokenInUrl } = require('../src/middleware/auth');
  const app = express(); app.use(express.json());
  app.use('/api/projects',require('../src/routes/projects'));
  app.use('/api/projects/:projectId/notes',notes);
  app.get('/api/notes/stream',rejectTokenInUrl,authenticate,notes.streamAllNotes);
  app.use('/api',require('../src/routes/noteFeeds'));
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base = 'http://127.0.0.1:'+server.address().port;
  const headers = user => ({'Content-Type':'application/json',...(user ? {Authorization:'Bearer '+jwt.sign({userId:user},process.env.JWT_SECRET,{expiresIn:'5m'})}:{})});
  async function call(route,method='GET',body,user='u0') {
    const response = await fetch(base+route,{method,headers:headers(user),body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  }
  const reply = (user, note='old', project='p1', body={note:'Response from '+user,client_id:'request-'+user}) => call(`/api/projects/${project}/notes/${note}/replies`,'POST',body,user);
  const controllers=[];
  async function stream(user,route='/api/notes/stream') {
    const controller=new AbortController();controllers.push(controller);
    const response=await fetch(base+route,{headers:headers(user),signal:controller.signal});
    assert.equal(response.status,200);
    const state={text:'',ended:false};
    state.read=(async()=>{try{for await(const chunk of response.body) state.text+=Buffer.from(chunk).toString();}catch{}finally{state.ended=true;}})();
    return state;
  }
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  try {
    assert.equal((await reply(null)).status,401);
    assert.equal((await reply('other')).status,403);
    assert.equal((await reply('u4','old','p2')).status,403);
    assert.equal((await reply('u0','old','p2')).status,404);
    assert.equal((await reply('u4','private')).status,404);
    assert.equal((await reply('u4','own')).status,201);
    for (const [i] of roles.entries()) assert.equal((await reply('u'+i)).status,201);
    const duplicate=await reply('u1');assert.equal(duplicate.status,200);
    assert.equal((await reply('u1','old','p1',{note:'Different',client_id:'request-u1'})).status,409);
    for(const value of ['', '   ', {}, 'a'.repeat(10001)]) assert.equal((await reply('u0','old','p1',{note:value,client_id:'validation'})).status,400);
    assert.equal((await reply('u0','old','p1',{note:'Valid',client_id:'bad'})).status,400);
    const forged=await reply('u2','old','p1',{note:'<script>literal & safe</script>',client_id:'forgery-test',user_id:'u0',user_name:'Forged',user_avatar_url:'evil',visibility:'public',project_id:'p2'});
    assert.equal(forged.body.user_id,'u2');assert.equal(forged.body.user_avatar_url,'/uploads/avatar-2.jpg');
    const concurrent=await Promise.all(Array.from({length:5},()=>reply('u3','old','p1',{note:'Retry test',client_id:'concurrent-test'})));
    assert.equal(new Set(concurrent.map(r=>r.body.id)).size,1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE entity_id=?").get(concurrent[0].body.id).n,1);
    const project=(await call('/api/projects/p1/notes')).body;
    const dashboard=(await call('/api/dashboard/activity-feed')).body.items;
    const recent=(await call('/api/notes/recent')).body;
    assert.equal(dashboard[0].id,'old');
    assert.deepEqual(dashboard[0].replies,project.find(n=>n.id==='old').replies);
    assert.deepEqual(dashboard[0].replies,recent[0].replies);
    assert.equal((await call('/api/projects/p2/notes')).body.length,0);
    const contractor=(await call('/api/dashboard/activity-feed','GET',undefined,'u4')).body.items;
    assert.equal(contractor.some(n=>n.id==='private'),false);
    assert.equal(contractor.find(n=>n.id==='old').replies.length,7);
    const adminStream=await stream('u0'); const contractorStream=await stream('u4'); const otherStream=await stream('other');
    const projectStream=await stream('u4','/api/projects/p1/notes/stream');
    await reply('u0','old','p1',{note:'Live reply',client_id:'live-reply'});await pause(80);
    assert.match(adminStream.text,/notes_changed/);assert.match(contractorStream.text,/notes_changed/);assert.doesNotMatch(otherStream.text,/notes_changed/);
    assert.doesNotMatch(adminStream.text,/Live reply|old|user_id/);assert.match(projectStream.text,/note_replied/);
    contractorStream.text='';projectStream.text='';
    await reply('u0','private','p1',{note:'Hidden reply',client_id:'hidden-reply'});await pause(80);
    assert.doesNotMatch(contractorStream.text,/notes_changed|Hidden/);assert.doesNotMatch(projectStream.text,/Hidden/);
    const edited=await call('/api/projects/p1/notes/old','PUT',{note:'Edited original',note_type:'general',visibility:'private'});
    assert.equal(edited.status,200);assert.equal(edited.body.replies.length,8);await pause(80);
    assert.match(projectStream.text,/delete_note/);
    assert.equal((await reply('u4','old','p1',{note:'No longer visible',client_id:'hidden-old'})).status,404);
    db.prepare('DELETE FROM project_assignments WHERE user_id=?').run('u4');
    await reply('u0','own','p1',{note:'Assignment removed',client_id:'removed-assignment'});await pause(80);
    assert.equal(projectStream.ended,true);
    db.prepare('UPDATE users SET is_active=0 WHERE id=?').run('u0');
    await reply('u1','own','p1',{note:'Account disabled',client_id:'disabled-account'});await pause(80);
    assert.equal(adminStream.ended,true);assert.equal((await reply('u0')).status,401);
    const deleted=await call('/api/projects/p1/notes/old','DELETE',undefined,'u1');assert.equal(deleted.status,200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_note_replies WHERE note_id=?').get('old').n,0);
    const audit=db.prepare("SELECT details FROM activity_log WHERE action='note_deleted' AND entity_id='old'").get();
    assert.equal(JSON.parse(audit.details).replies.length,8);
    assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
    console.log('PASS: canonical replies, all five roles, avatars, access/visibility, validation, idempotency, audit, dashboard ordering, live streams, revocation, deletion and additive schema');
  } finally {
    controllers.forEach(c=>c.abort());server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(temp,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
