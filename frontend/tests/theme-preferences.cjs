const {chromium} = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.AUDIT_URL || 'http://127.0.0.1:5173';
const output = path.join(__dirname,'..','test-results','theme-preferences');
fs.mkdirSync(output,{recursive:true});

(async()=>{
  const browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || (process.platform==='win32'?'msedge':undefined),headless:true});
  let user = {id:'preference-test',name:'Sample User',email:'sample@example.invalid',role:'super_admin',color_scheme:'07'};
  const errors=[];
  let failSave=false;
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1080}});
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(user=>{
      if(!localStorage.getItem('token')){
        localStorage.setItem('token','sample-preference-token');
        localStorage.setItem('user',JSON.stringify(user));
      }
      for(const key of ['auth_session_started_at','auth_last_activity_at','auth_last_refresh_at'])localStorage.setItem(key,String(Date.now()));
    },user);
    await page.route('**/api/**',async route=>{
      const pathname=new URL(route.request().url()).pathname;
      let json=[];
      if(pathname==='/api/auth/me')json=user;
      if(pathname==='/api/auth/refresh')json={user,token:'sample-preference-token'};
      if(pathname==='/api/users/me/preferences'){
        await new Promise(resolve=>setTimeout(resolve,300));
        if(failSave)return route.fulfill({status:500,json:{error:'Simulated save failure'}});
        user={...user,...route.request().postDataJSON()};
        json={color_scheme:user.color_scheme};
      }
      return route.fulfill({status:200,json});
    });
    await page.goto(base+'/settings');
    await page.getByRole('tab',{name:'Preferred Color',exact:true}).click();
    assert.equal(await page.locator('.bt-color-option').count(),5);
    assert.equal(await page.locator('.bt-color-option').last().getAttribute('aria-label'),'05 Dark Knight');
    assert.equal(await page.locator('html').getAttribute('data-bt-scheme'),'07');
    for(const [id,label,background] of [
      ['01','01 Porcelain Blue','rgb(238, 242, 247)'],
      ['07','07 Midnight Navy','rgb(14, 26, 43)'],
      ['08','08 Carbon Silver','rgb(25, 26, 28)'],
      ['02','02 Warm Ivory','rgb(243, 240, 233)'],
      ['dark-knight','05 Dark Knight','rgb(9, 9, 9)'],
    ]){
      await page.getByRole('button',{name:label,exact:true}).click();
      assert.equal(await page.locator('html').getAttribute('data-bt-scheme'),id);
      assert.equal(await page.locator('.bt-desktop-shell').evaluate(el=>getComputedStyle(el).backgroundColor),background);
      await page.waitForFunction(()=>!document.querySelector('[aria-busy="true"]'));
      assert.equal(user.color_scheme,id);
    }
    await page.evaluate(()=>document.fonts.ready);
    assert.ok(await page.evaluate(()=>document.fonts.check('16px "Inter Tight Variable"')));
    const tightLoaded=await page.evaluate(()=>[...document.fonts].some(font=>font.family.replace(/['"]/g,'')==='Inter Tight Variable'&&font.status==='loaded'));
    assert.ok(tightLoaded,'Inter Tight webfont must be loaded, not just a fallback');
    const font=await page.locator('.bt-desktop-shell').evaluate(el=>getComputedStyle(el).fontFamily);
    assert.match(font,/Inter Tight Variable/);
    await page.reload();
    await page.getByRole('tab',{name:'Preferred Color',exact:true}).click();
    assert.equal(await page.locator('html').getAttribute('data-bt-scheme'),'dark-knight');
    assert.equal(await page.getByRole('button',{name:'05 Dark Knight',exact:true}).getAttribute('aria-pressed'),'true');
    await page.waitForTimeout(250); // Finish tab color transitions before checking.
    assert.equal(await page.getByRole('tab',{name:'Preferred Color',exact:true}).evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(238, 238, 238)');
    assert.equal(await page.locator('.is-selected .bt-color-check svg').evaluate(el=>getComputedStyle(el).color),'rgb(17, 17, 17)');
    await page.screenshot({path:path.join(output,'dark-knight-settings.png'),fullPage:true});
    failSave=true;
    await page.getByRole('button',{name:'01 Porcelain Blue',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'Could not save'}).waitFor();
    assert.equal(await page.locator('html').getAttribute('data-bt-scheme'),'dark-knight');
    assert.match(await page.locator('.bt-desktop-shell').evaluate(el=>getComputedStyle(el).fontFamily),/Inter Tight Variable/);
    failSave=false;
    await page.getByRole('button',{name:'01 Porcelain Blue',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('[aria-busy="true"]'));
    const restoredFont=await page.locator('.bt-desktop-shell').evaluate(el=>getComputedStyle(el).fontFamily);
    assert.match(restoredFont,/Inter Variable/);
    assert.doesNotMatch(restoredFont,/Inter Tight/);
    assert.deepEqual(errors,[]);
    console.log('PASS: fifth option, unchanged default, five immediate palette changes, saved selection, reload persistence, Inter Tight loaded, failure rollback and font restoration');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
