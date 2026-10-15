// Browser integration uses real SQLite routes and SSE with synthetic data only.
const {chromium,expect:baseExpect}=require('@playwright/test');
const expect=baseExpect.configure({timeout:15000});
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const backend=require('node:module').createRequire(path.resolve(__dirname,'../../backend/package.json'));
const express=backend('express');const jwt=backend('jsonwebtoken');
const {fixture,userBase,notes,project}=require('./theme-contrast.cjs');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bt-reply-browser-'));
process.env.DB_PATH=path.join(temp,'test.db');process.env.JWT_SECRET='local-browser-test-only';
const {initializeSchema,getDb}=backend('./src/db/schema');
const out=path.resolve(process.env.AUDIT_OUTPUT||'test-results/note-replies');fs.mkdirSync(out,{recursive:true});
(async()=>{
 initializeSchema();const db=getDb();
 const users=[{...userBase,avatar_url:'/test-avatar.svg'},{...userBase,id:'operations',name:'Operations Manager',role:'operations_manager',avatar_url:'/test-avatar.svg'}];
 for(const u of users)db.prepare('INSERT INTO users(id,name,email,password_hash,role,is_active,avatar_url) VALUES(?,?,?,?,?,1,?)').run(u.id,u.name,u.id+'@example.invalid','hash',u.role,u.avatar_url);
 db.prepare('INSERT INTO projects(id,address,job_name,status,created_by) VALUES(?,?,?,?,?)').run(project.id,project.address,project.job_name,project.status,userBase.id);
 db.prepare('INSERT INTO projects(id,address,job_name,status,created_by) VALUES(?,?,?,?,?)').run('unrelated','456 Separate Property','Separate project',project.status,userBase.id);
 for(const n of notes)db.prepare('INSERT INTO project_notes(id,project_id,user_id,note,note_type,visibility,created_at) VALUES(?,?,?,?,?,?,?)').run(n.id,project.id,n.user_id,n.note,n.note_type,'public',n.created_at);
 const app=express();app.use(express.json());
 const notesRouter=backend('./src/routes/notes');const {authenticate,rejectTokenInUrl}=backend('./src/middleware/auth');
 app.get('/api/notes/stream',rejectTokenInUrl,authenticate,notesRouter.streamAllNotes);
 const projectsRouter=backend('./src/routes/projects');
 app.use('/api/projects',(req,res,next)=>/^\/[^/]+\/notes(?:\/|$)/.test(req.url)?projectsRouter(req,res,next):next());
 app.use('/api/projects/:projectId/notes',notesRouter);
 app.use('/api',backend('./src/routes/noteFeeds'));
 app.use('/api',(req,res)=>{
   const claims=jwt.verify((req.headers.authorization||'').replace('Bearer ',''),process.env.JWT_SECRET);
   const user={...users.find(u=>u.id===claims.userId),color_scheme:claims.scheme};
   res.json(fixture(new URL(req.originalUrl,'http://test.invalid'),user));
 });
 app.get('/test-avatar.svg',(_req,res)=>res.type('svg').send('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#334155"/><circle cx="20" cy="15" r="8" fill="#f8fafc"/><path d="M5 40a15 16 0 0130 0" fill="#f8fafc"/></svg>'));
 app.use(express.static(path.resolve(__dirname,'../dist')));
 app.get('/{*path}',(_req,res)=>res.sendFile(path.resolve(__dirname,'../dist/index.html')));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=process.env.AUDIT_URL||'http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});
 const errors=[];const results=[];
 try{
  for(const scheme of (process.env.SCHEMES||'01,07,08,02,dark-knight').split(',')){
   const contexts=[];
   const create=async(index,mobile=false)=>{
    const user={...users[index],color_scheme:scheme};const token=jwt.sign({userId:user.id,scheme},process.env.JWT_SECRET,{expiresIn:'10m'});
    const ctx=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},colorScheme:scheme==='dark-knight'?'dark':'light'});contexts.push(ctx);
    await ctx.addInitScript(({user,token})=>{localStorage.setItem('token',token);localStorage.setItem('user',JSON.stringify(user));for(const key of ['auth_session_started_at','auth_last_activity_at','auth_last_refresh_at'])localStorage.setItem(key,String(Date.now()));},{user,token});
    // Optional published-asset verification: every API request stays on the local test server.
    if(process.env.AUDIT_URL)await ctx.route('**/api/**',async route=>{const u=new URL(route.request().url());if(u.pathname.endsWith('/stream'))return route.fulfill({status:404,json:{}});const r=await route.fetch({url:'http://127.0.0.1:'+server.address().port+u.pathname+u.search});await route.fulfill({response:r});});
    if(process.env.AUDIT_URL)await ctx.route('**/test-avatar.svg',async route=>{const r=await route.fetch({url:'http://127.0.0.1:'+server.address().port+'/test-avatar.svg'});await route.fulfill({response:r});});
    const page=await ctx.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));return page;
   };
   try{
    const dashboard=await create(0);const projectPage=await create(1);const mobile=process.env.AUDIT_URL?null:await create(1,true);
    await dashboard.goto(base+'/dashboard',{waitUntil:'domcontentloaded'});
    await projectPage.goto(base+'/projects/'+project.id+'?tab=notes',{waitUntil:'domcontentloaded'});
    if(mobile)await mobile.goto(base+'/mobile/project/'+project.id+'/notes',{waitUntil:'domcontentloaded'});
    const thread=dashboard.locator('.bt-note-entry').filter({hasText:notes[0].note});
    await thread.getByRole('button',{name:/Reply to note/}).click();
    const text='Dashboard reply '+scheme+' — confirm delivery.';
    await thread.getByRole('textbox').fill(text);await thread.getByRole('button',{name:'Send reply',exact:true}).click();
    await expect(thread.locator('.bt-note-reply').filter({hasText:text})).toHaveCount(1);
    assert.ok(dashboard.url().includes('/dashboard'),'reply must not navigate');
    if(process.env.AUDIT_URL)await projectPage.reload();
    await expect(projectPage.locator('.bt-note-reply').filter({hasText:text})).toHaveCount(1);
    if(mobile)await expect(mobile.locator('.bt-note-reply').filter({hasText:text})).toHaveCount(1);
    const projectThread=projectPage.locator('.bt-note-entry').filter({hasText:notes[0].note});
    await projectThread.getByRole('button',{name:/Reply to note/}).click();
    const response='Operations response '+scheme;
    await projectThread.getByRole('textbox').fill(response);await projectThread.getByRole('button',{name:'Send reply',exact:true}).click();
    if(process.env.AUDIT_URL)await dashboard.reload();
    await expect(dashboard.locator('.bt-note-reply').filter({hasText:response})).toHaveCount(1);
    const image=dashboard.locator('.bt-note-reply').filter({hasText:response}).getByRole('img',{name:'Operations Manager profile photo'});
    await expect(image).toBeVisible();assert.ok(await image.evaluate(img=>img.complete&&img.naturalWidth>0));
    if(mobile){
      const mt=mobile.locator('.bt-mobile-note-entry').filter({hasText:notes[0].note});await mt.getByRole('button',{name:/Reply to note/}).click();
      await mt.getByRole('textbox').fill('Mobile response '+scheme);await mt.getByRole('button',{name:'Send reply',exact:true}).click();
      await expect(projectPage.locator('.bt-note-reply').filter({hasText:'Mobile response '+scheme})).toHaveCount(1);
    }
    // Simulate a response lost AFTER the server saved it: retry must not duplicate.
    if(!process.env.AUDIT_URL){
      let drops=0;await dashboard.route('**/replies',async route=>{if(drops++===0){await route.fetch();await route.abort('failed');}else await route.continue();});
      const retryText='Retry after lost response '+scheme;
      await thread.getByRole('textbox').fill(retryText);await thread.getByRole('button',{name:'Send reply',exact:true}).click();
      await expect(thread.getByRole('alert')).toBeVisible();await expect(thread.getByRole('textbox')).toHaveValue(retryText);
      await thread.getByRole('button',{name:'Send reply',exact:true}).click();await expect(thread.getByRole('textbox')).toHaveValue('');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_note_replies WHERE note=?').get(retryText).n,1);
      await thread.getByRole('textbox').fill('Unsaved draft survives live updates');
      await projectThread.getByRole('textbox').fill('New update '+scheme);await projectThread.getByRole('button',{name:'Send reply',exact:true}).click();
      await expect(thread.locator('.bt-note-reply').filter({hasText:'New update '+scheme})).toHaveCount(1);
      await expect(thread.getByRole('textbox')).toHaveValue('Unsaved draft survives live updates');
    }
    for(const [name,page] of [['dashboard',dashboard],['project',projectPage],...(mobile?[['mobile',mobile]]:[])]){
      await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});
      const violations=await page.evaluate(async()=> (await axe.run('.bt-note-replies',{runOnly:['color-contrast','label','button-name']})).violations);
      assert.equal(violations.length,0,scheme+' '+name+' '+JSON.stringify(violations));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,name+' horizontal overflow');
      await page.screenshot({path:path.join(out,scheme+'-'+name+'.png'),fullPage:false});
      results.push({scheme,page:name,contrast:'pass',replySync:'pass',avatar:'pass'});
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_note_replies r JOIN project_notes n ON n.id=r.note_id WHERE n.project_id='unrelated'").get().n,0);
    console.log('PASS '+scheme+': two users, dashboard/project'+(mobile?'/mobile':'')+', avatars, contrast, project isolation'+(!process.env.AUDIT_URL?', SSE, lost-response retry, draft preservation':''));
   }catch(error){
    for(const [i,ctx] of contexts.entries())for(const page of ctx.pages())await page.screenshot({path:path.join(out,scheme+'-failure-'+i+'.png')}).catch(()=>{});
    throw error;
   }finally{
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({results,errors},null,2));
    for(const ctx of contexts)await ctx.close();
   }
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({results,errors},null,2));
 }finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));db.close();fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
