const {chromium}=require('@playwright/test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {fixture,userBase,notes,project}=require('./theme-contrast.cjs');
const base=process.env.AUDIT_URL||'http://127.0.0.1:5187';
const out=path.resolve(process.env.AUDIT_OUTPUT||'test-results/note-separators');
fs.mkdirSync(out,{recursive:true});
const schemes=(process.env.SCHEMES||'01,07,08,02,dark-knight').split(',');
const expectedDays=['Thursday, October 15, 2026','Wednesday, October 14, 2026','Thursday, October 8, 2026'];
const photos=notes.map((note,index)=>({id:'test-photo-'+index,filename:'test-photo.svg',original_name:'Inspection photo',mime_type:'image/svg+xml',photo_type:'progress',project_id:project.id,created_at:note.created_at,taken_at:note.created_at,caption:note.note,individual_note:note.note,uploader_name:'Audit User',show_in_progress:1}));
const results=[];
const errors=[];

async function boundaries(locator) {
  return locator.evaluateAll(elements=>{
    const ctx=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
    const rgb=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3)};
    const lum=color=>rgb(color).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    return elements.map(el=>{
      const s=getComputedStyle(el),rect=el.getBoundingClientRect();
      let bg=s.backgroundColor;
      for(let p=el.parentElement;p&&bg==='rgba(0, 0, 0, 0)';p=p.parentElement)bg=getComputedStyle(p).backgroundColor;
      const a=lum(s.borderTopColor),b=lum(bg);
      return {width:parseFloat(s.borderTopWidth),style:s.borderTopStyle,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),height:rect.height,top:rect.top,bottom:rect.bottom,right:rect.right};
    });
  });
}

(async()=>{
  const browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});
  try {
    for(const scheme of schemes) {
      const user={...userBase,color_scheme:scheme};
      const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Asia/Tokyo'});
      let current='';
      let testNotes=notes;
      let previewOnly=false;
      await context.addInitScript(user=>{
        localStorage.setItem('token','local-note-test');localStorage.setItem('user',JSON.stringify(user));
        for(const key of ['auth_session_started_at','auth_last_activity_at','auth_last_refresh_at'])localStorage.setItem(key,String(Date.now()));
      },user);
      await context.route('**/api/**',route=>{
        const url=new URL(route.request().url());
        const p=url.pathname;
        if(p.endsWith('/notes/stream'))return route.fulfill({status:200,contentType:'text/event-stream',body:': test heartbeat\n\n'});
        if(p.endsWith('/notes'))return route.fulfill({status:200,json:previewOnly?[]:testNotes});
        if(p.endsWith('/photos'))return route.fulfill({status:200,json:photos});
        return route.fulfill({status:200,json:fixture(url,user)});
      });
      await context.route('**/uploads/**',route=>route.fulfill({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#334155"/></svg>'}));
      const page=await context.newPage();page.setDefaultTimeout(10000);
      page.on('pageerror',e=>errors.push({scheme,page:current,error:e.message}));
      page.on('console',m=>{if(m.type()==='error'&&m.text().includes('Root render error'))errors.push({scheme,page:current,error:m.text()})});
      const visit=async url=>{current=url;await page.goto(base+url,{waitUntil:'networkidle',timeout:45000});assert.equal(await page.getByText('BuildTrack needs a refresh',{exact:false}).count(),0);await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')})};
      const checkFeed=async(label,feed,count=4,days=expectedDays)=>{
        await feed.locator('.bt-note-entry').first().waitFor();
        assert.equal(await feed.locator('.bt-note-entry').count(),count,label+' entry count');
        assert.deepEqual(await feed.locator('.bt-note-day').allTextContents(),days,label+' New York date grouping');
        const contrast=await feed.evaluate(async el=>(await axe.run(el,{runOnly:['color-contrast']})).violations);
        assert.equal(contrast.length,0,label+' text contrast: '+JSON.stringify(contrast.map(v=>v.nodes.map(n=>n.failureSummary))));
        const borders=await boundaries(feed.locator('.bt-note-entry'));
        for(const b of borders){assert.ok(b.width>=1&&b.style==='solid'&&b.height>20,label+' visible border');assert.ok(b.contrast>=3,label+' border contrast '+b.contrast)}
        for(let i=1;i<borders.length;i++)assert.ok(borders[i].top-borders[i-1].bottom>=8,label+' entry spacing');
        results.push({scheme,page:label,entries:count,days,borderContrast:Math.min(...borders.map(b=>b.contrast))});
      };
      try {
        if(process.env.HR_ONLY!=='1') {
        await visit('/dashboard');
        await checkFeed('Dashboard',page.locator('.bt-dashboard-notes-flow .bt-note-feed'));
        const calendar=await page.locator('.bt-dashboard-calendar-stack').boundingBox();
        const first=await page.locator('.bt-dashboard-notes-flow .bt-note-entry').first().boundingBox();
        assert.ok(first.x+first.width<=calendar.x,'Dashboard calendar retains its own column');
        await page.screenshot({path:path.join(out,scheme+'-dashboard.png'),fullPage:true});
        await page.getByRole('button',{name:'Open notifications',exact:true}).click();
        await page.locator('.bt-notification-row').first().waitFor();
        assert.equal(await page.locator('.bt-notification-row').first().locator('..').getAttribute('class'),'bt-note-entry');
        results.push({scheme,page:'Notification entries',entries:await page.locator('.bt-notification-row').count()});

        await visit('/projects/audit-project');
        await page.locator('.bt-project-tab-button').getByText('Notes',{exact:true}).click();
        await checkFeed('Project notes',page.locator('.bt-project-notes-list .bt-note-feed'));
        const edit=page.getByRole('button',{name:'Edit note',exact:true}).first();
        await edit.click();
        assert.ok(await page.locator('.bt-note-entry textarea').count()>0,'Note editor remains available');
        await page.locator('.bt-note-entry').getByRole('button',{name:'Cancel',exact:true}).click();
        await page.locator('.bt-project-notes-list').screenshot({path:path.join(out,scheme+'-project-notes.png')});
        await page.locator('.bt-project-tab-button').getByText('Photos Bucket',{exact:true}).click();
        await page.locator('.bt-media-note-entry').first().waitFor();
        assert.equal(await page.locator('.bt-media-note-entry').count(),4);
        assert.equal(await page.locator('.bt-note-day-boundary').count(),3);
        results.push({scheme,page:'Project photo notes',entries:4,days:3});

        await visit('/contractors?search=Sample');
        await page.locator('.bt-directory-row').first().click();
        await checkFeed('Vendor preview',page.locator('.bt-note-feed').first(),2,expectedDays.slice(0,2));
        await page.getByRole('button',{name:'4 notes',exact:true}).click();
        await checkFeed('Vendor expanded notes',page.locator('.bt-note-feed').nth(1));
        await page.getByRole('button',{name:'View full profile',exact:true}).click();
        await checkFeed('Vendor profile notes',page.locator('[role="dialog"] .bt-note-feed'));
        await page.locator('[role="dialog"] .bt-note-feed').screenshot({path:path.join(out,scheme+'-vendor-notes.png')});
        await page.keyboard.press('Escape');
        previewOnly=true;
        await visit('/contractors?search=Sample');
        await page.locator('.bt-directory-row').first().click();
        await page.getByRole('button',{name:'View full profile',exact:true}).click();
        await checkFeed('Vendor profile preview fallback',page.locator('[role="dialog"] .bt-note-feed'),2,expectedDays.slice(0,2));
        previewOnly=false;

        await visit('/quotes');
        await page.getByRole('button',{name:'Toggle line items',exact:true}).first().click();
        await checkFeed('Quote notes',page.locator('.bt-note-feed'));
        await page.locator('.bt-note-feed').screenshot({path:path.join(out,scheme+'-quote-notes.png')});
        await visit('/photos');
        await page.locator('.bt-media-note-entry').first().waitFor();
        assert.equal(await page.locator('.bt-media-note-entry').count(),4);
        assert.equal(await page.locator('.bt-note-day-boundary').count(),3);
        await page.getByRole('button',{name:'Show photo list',exact:true}).click();
        assert.equal(await page.locator('.bt-media-note-entry').count(),4);
        assert.equal(await page.locator('.bt-note-day-boundary').count(),3);
        results.push({scheme,page:'Photo notes grid and list',entries:4,days:3});

        // Date edges: midnight SQL timestamps, daylight saving fall-back, and bad dates.
        testNotes=['2026-11-01T06:30:00Z','2026-11-01T05:30:00Z','2026-11-01 03:30:00','not-a-date'].map((created_at,i)=>({...notes[0],id:'edge-'+i,created_at}));
        await visit('/quotes');
        await page.getByRole('button',{name:'Toggle line items',exact:true}).first().click();
        await checkFeed('Date edge cases',page.locator('.bt-note-feed'),4,['Sunday, November 1, 2026','Saturday, October 31, 2026','Date unavailable']);
        testNotes=notes;

        if(process.env.MOBILE!=='0') {
          await page.setViewportSize({width:390,height:844});
          await visit('/mobile/project/audit-project/notes');
          await page.locator('.bt-mobile-note-entry').first().waitFor();
          assert.equal(await page.locator('.bt-mobile-note-entry').count(),4);
          assert.equal(await page.locator('.bt-mobile-note-day').count(),3);
          for(const b of await boundaries(page.locator('.bt-mobile-note-entry')))assert.ok(b.width>=1&&b.contrast>=3,'Mobile entry boundary');
          assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile has no horizontal overflow');
          for(const mode of ['light','dark']) {
            await page.emulateMedia({colorScheme:mode});
            const violations=await page.evaluate(async()=>(await axe.run({include:[['.bt-mobile-note-entry'],['.bt-mobile-note-day'],['.bt-mobile-notes-header']]},{runOnly:['color-contrast']})).violations);
            assert.equal(violations.length,0,'Mobile '+mode+' text contrast '+JSON.stringify(violations.map(v=>v.nodes.map(n=>n.failureSummary))));
          }
          await page.emulateMedia({colorScheme:'light'});
          await page.locator('.bt-mobile-note-entry').first().scrollIntoViewIfNeeded();
          await page.screenshot({path:path.join(out,scheme+'-mobile-notes.png')});
          results.push({scheme,page:'Mobile notes',entries:4,days:3});
          await visit('/mobile/photos?projectId=audit-project');
          await page.locator('.bt-mobile-media-entry').first().waitFor();
          assert.equal(await page.locator('.bt-mobile-media-entry').count(),4);
          assert.equal(await page.locator('.bt-note-day-boundary').count(),3);
          results.push({scheme,page:'Mobile photo notes',entries:4,days:3});
        }
        }
        await visit('/human-resources');
        await page.getByRole('button',{name:'Resumes',exact:true}).click();
        await page.getByText('Sample Applicant',{exact:true}).click();
        await checkFeed('HR contact notes',page.locator('[role="dialog"] .bt-note-feed'));
        await page.locator('[role="dialog"] .bt-note-feed').screenshot({path:path.join(out,scheme+'-hr-notes.png')});
      } catch(e) {errors.push({scheme,page:current,error:e.message});await page.screenshot({path:path.join(out,scheme+'-failure.png')})}
      finally {await context.close()}
      console.log(scheme,'completed',results.filter(r=>r.scheme===scheme).length,'checks');
    }
  } finally {await browser.close();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({results,errors},null,2))}
  console.log(JSON.stringify({checks:results.length,errors}));
  if(errors.length)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
