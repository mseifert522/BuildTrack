const {chromium}=require('@playwright/test');
const fs=require('node:fs');
const path=require('node:path');
const axePath=require.resolve('axe-core/axe.min.js');
const out=path.resolve(process.env.AUDIT_OUTPUT||path.join(__dirname,'..','test-results','theme-contrast'));
fs.mkdirSync(out,{recursive:true});
const base=process.env.AUDIT_URL||'http://127.0.0.1:5173';
const schemes=(process.env.SCHEMES||'01,07,08,02,dark-knight').split(',');
const project={id:'audit-project',address:'123 Sample Avenue',job_name:'Sample Renovation',status:'active_rehab',start_date:'2026-10-01',target_completion:'2026-12-01',open_punch_items:4,assigned_count:2,budget:125000,updated_at:'2026-10-15',created_at:'2026-10-01',market_status:'not_on_market',work_priority:1,contractors:[],stats:{total_invoiced:4250,total_paid:1250,open_punch_items:4},assigned_users:[]};
const userBase={id:'audit-user',name:'Audit User',email:'audit@example.invalid',role:'super_admin',is_active:1,company:'Sample Company',created_at:'2026-10-01'};
const note={id:'audit-note',feed_type:'note',note_type:'field',user_id:'audit-user',user_name:'Audit User',project_id:project.id,project_address:project.address,created_at:'2026-10-15T13:00:00Z',content:'Field inspection completed. Cabinet installation and final painting are scheduled for this week. Please confirm delivery before work begins.',text:'Field inspection completed.',media:[],attachments:[]};
const invoice={id:'audit-invoice',invoice_number:'INV-101',project_id:project.id,project_address:project.address,contractor_name:'Sample Contractor',status:'submitted',total:4250,amount:4250,created_at:'2026-10-14',line_items:[]};
const punch={id:'audit-punch',title:'Complete final paint inspection',description:'Confirm finish quality before handover.',status:'in_progress',priority:'high',project_id:project.id,assigned_to:'audit-user',assigned_name:'Audit User',created_at:'2026-10-14',photos:[],comments:[]};
const event={id:'audit-event',title:'Site inspection',description:'Review remaining work on site.',event_type:'task',status:'open',priority:'high',project_id:project.id,project_address:project.address,start_at:'2026-10-15T16:00:00Z',end_at:'2026-10-15T17:00:00Z',start_date:'2026-10-15',end_date:'2026-10-15',assigned_users:[],is_completed:0};
note.note=note.content;
const contractor={id:'audit-vendor',name:'Sample Contractor',company:'Sample Trade Company',email:'vendor@example.invalid',phone:'555-0100',status:'active',is_active:1,is_supplier:false,categories:['General contractor'],assigned_projects:[project],project_count:1,created_at:'2026-10-01',notes_count:1};
const quote={id:'audit-quote',quote_number:'Q-101',project_id:project.id,property_address:project.address,contractor_name:'Sample Contractor',status:'pending',quote_date:'2026-10-14',total_quote_amount:4250,scope_description:'Replace kitchen cabinets',line_items:[],created_at:'2026-10-14'};
const docs={attachments:1,pending:1,running:0,extracted:0,unreadable:0,failed:0,skipped:0,duplicate:0};
const bills=['unpaid','approved','paid'].map((status,i)=>({qbo_id:'audit-bill-'+i,doc_number:'B-10'+i,vendor_name:'Sample Contractor',txn_date:'2026-10-14',due_date:'2026-10-16',total_amt:4250,balance:status==='paid'?0:4250,payment_status:status==='paid'?'paid':'unpaid',payment_approval_status:status==='approved'?'approved_for_payment':null,payment_run_date:'2026-10-16',project_id:project.id,project_address:project.address,invoice_pdf:{available:false}}));
const reportBase={warnings:[],filters:{today:'2026-10-15'},labels:{full_year:'Full-year hourly rate',annualized:'Annualized rate',window:'Selected window',doc:'Documented cost'},years_available:[2026]};
function fixture(url,user){
 const p=url.pathname.replace(/^\/api/,'');
 if(p==='/auth/me')return user;
 if(p==='/auth/refresh')return {user,token:'local-contrast-test'};
 if(p==='/projects')return [project];
 if(p==='/projects/unreviewed-summary')return {projects:[]};
 if(p==='/projects/'+project.id)return project;
 if(p.endsWith('/punch-list'))return [punch];
 if(p.endsWith('/notes')||p==='/notes/recent')return [note];
 if(p.endsWith('/photos'))return [];
 if(p.endsWith('/scopes'))return {scopes:[]};
 if(p==='/dashboard/activity-feed')return {items:[note,{...note,id:'audit-note2',user_name:'Sample Team Member',content:'Work is ready for review.'}]};
 if(p==='/calendar/events')return {events:[event]};
 if(p==='/quickbooks/status')return {configured:true,connected:true,connection:{company_name:'Sample Company'},stats:{bill_count:3,paid_count:1,open_count:2,open_balance:8500,unmatched_count:0,approved_payment_count:1,approved_payment_balance:4250}};
 if(p==='/quickbooks/bills')return bills;
 if(p==='/users')return [user,{...userBase,id:'audit-vendor',name:'Sample Contractor',role:'contractor'}];
 if(p==='/users/contractors/directory')return {contractors:[contractor],suppliers:[],categories:[{id:'general',name:'General contractor'}]};
 if(p==='/invoices'||p.endsWith('/invoices'))return [invoice];
 if(p==='/projects/'+project.id+'/invoices/audit-invoice')return {...invoice,items:[]};
 if(p==='/invoices/email-intake')return {items:[],emails:[],counts:{},total:0};
 if(p==='/vendor-setup/invites')return {invites:[]};
 if(p==='/agreements/options')return {vendors:[],projects:[project],trades:[],document_types:[],max_file_mb:25};
 if(p==='/agreements')return {agreements:[]};
 if(p==='/agent-bridge/admin/agents')return {agents:[],availableScopes:['property:read']};
 if(p==='/agent-bridge/admin/logs')return {logs:[]};
 if(p==='/human-resources/overview')return {stats:{active_employees:2,open_candidates:1,resumes:1,pending_compliance:0,pending_leave:0},hours:{regular_hours:64,overtime_hours:0,pto_hours:0,sick_hours:0},week_start:'2026-10-12',week_end:'2026-10-18',tasks:[]};
 const hr={'candidates':{candidates:[]},'employees':{employees:[]},'time-entries':{entries:[]},'leave-requests':{requests:[]},'benefits':{benefits:[]},'compliance':{tasks:[]},'resume-imports':{batches:[]},'ai-settings/anthropic':{settings:{configured:false}}};
 if(p.startsWith('/human-resources/'))return hr[p.slice(17)]||{};
 if(p==='/security/sessions')return {users:[user],sessions:[],archived_sessions:[],counts:{}};
 if(p==='/security/events')return {events:[],counts:{}};
 if(p==='/security/data-access')return {events:[],counts:{}};
 if(p==='/quote-analytics/options')return {vendors:[],contractors:[contractor],projects:[project],categories:[{id:'general',category_group:'General',name:'General contractor'}],years:[2026],trades:[],statuses:[]};
 if(p==='/quote-analytics/quotes')return {quotes:[quote],total:1,page:1,limit:20};
 if(p==='/quote-analytics/summary')return {stats:{},totals:{},by_status:[],by_trade:[],by_vendor:[],by_project:[]};
 if(p==='/quote-analytics/compare')return {
  project:{...project,square_footage:1800},category_filter:null,
  contractors:[quote,{...quote,id:'audit-quote-2',quote_number:'Q-102',contractor_name:'Second Sample Contractor',total_quote_amount:4750}].map(q=>({...q,quote_id:q.id,final_approved_amount:null,data_quality_flags:[],line_item_count:1})),
  rows:[{category:'Cabinets',category_group:'Kitchen',cells:{'audit-quote':{amount:4250,present:true,line_items:[]},'audit-quote-2':{amount:4750,present:true,line_items:[]}},present_count:2,missing_quote_ids:[],has_missing:false,low:4250,high:4750,average:4500,spread:500}],
  totals:{by_quote:{'audit-quote':4250,'audit-quote-2':4750},low:4250,high:4750,average:4500,price_per_sqft_by_quote:null},
 };
 if(p==='/quote-analytics/activity')return [{id:'audit-activity',user_name:user.name,action:'quote_created',entity_type:'quote',entity_id:quote.id,details:'Sample cabinet quote received for review.',created_at:'2026-10-14T14:00:00Z',project_id:project.id,project_address:project.address}];
 if(p==='/field-work/projects/'+project.id)return null;
 if(p==='/cost-analyzer/overview')return {...reportBase,totals:{spend:4250,bills:1,vendors:1,vendors_categorized:0,vendors_needing_review:1,classes:1,classes_with_sqft:0},spend_by_type:{rehab:4250,new_construction:0,maintenance:0,other:0},categories:[],top_vendors:[],documents:docs,last_scan:null,rate_caption:'Sample report'};
 if(p==='/cost-analyzer/vendors')return {...reportBase,vendors:[]};
 if(p==='/cost-analyzer/classes')return {...reportBase,classes:[],classes_with_sqft:0};
 if(p==='/cost-analyzer/categories/stats')return {...reportBase,categories:[],total:0};
 if(p==='/cost-analyzer/materials')return {...reportBase,documents:docs,totals:{n_items:0,n_manual_items:0},families:[],coverage:[],job_costs:[],unknowns:[],resolved:[]};
 if(p==='/cost-analyzer/documents')return {...reportBase,documents:[],counts:docs,pagination:{page:1,limit:50,total:0},total:0};
 return [];
}
const routes=['/dashboard','/operations-calendar','/projects','/projects/audit-project','/quotes','/invoices','/projects/audit-project/invoices/new','/projects/audit-project/invoices/audit-invoice','/punch-list','/photos','/contractors','/users','/settings','/security','/human-resources','/cost-analyzer','/agreements'];
(async()=>{
 const channel=process.env.PLAYWRIGHT_CHANNEL||(process.platform==='win32'?'msedge':undefined);
 const browser=await chromium.launch({channel,headless:true});
 const results=[];const errors=[];const requested=new Set();
 try{
 for(const scheme of schemes){
 const user={...userBase,color_scheme:scheme};
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addInitScript(user=>{
 localStorage.setItem('token','local-contrast-test');localStorage.setItem('user',JSON.stringify(user));
 for(const k of ['auth_session_started_at','auth_last_activity_at','auth_last_refresh_at'])localStorage.setItem(k,String(Date.now()));
 },user);
 await context.route('**/api/**',route=>{
 const url=new URL(route.request().url());requested.add(url.pathname);
 return route.fulfill({status:200,json:fixture(url,user)});
 });
 const page=await context.newPage();page.setDefaultTimeout(5000);let current='';page.on('pageerror',e=>errors.push({scheme,page:current,message:e.message}));
 page.on('console',message=>{if(message.type()==='error'&&message.text().includes('[BuildTrack] Root render error'))errors.push({scheme,page:current,message:message.text()});});
 const audit=async label=>{
   await page.waitForLoadState('networkidle');
   await page.waitForTimeout(250);
   if(await page.getByText('BuildTrack needs a refresh',{exact:false}).count())throw Error('Application render fallback displayed: '+label);
   await page.locator('.bt-desktop-shell').waitFor({state:'visible'});
   const result=await page.evaluate(async()=>{
    const r=await axe.run(document,{runOnly:['color-contrast'],resultTypes:['violations','incomplete']});
    // axe cannot resolve float overlaps and single-digit badges. Verify those
    // separately against the element's actual solid ancestor surfaces. Keep the
    // unresolved list in the report for visual review (never count it as a pass).
    const incomplete=r.incomplete.flatMap(v=>v.nodes.map(n=>({target:n.target,html:n.html,summary:n.failureSummary})));
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const rgba=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].map((n,i)=>i===3?n/255:n)};
    const over=(a,b)=>{const alpha=a[3]+b[3]*(1-a[3]);return [...a.slice(0,3).map((v,i)=>alpha?(v*a[3]+b[i]*b[3]*(1-a[3]))/alpha:0),alpha]};
    const luminance=c=>c.slice(0,3).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4}).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
    const resolved=[];
    for(const node of incomplete){
     if(typeof node.target[0]!=='string')continue;
     const el=document.querySelector(node.target[0]);if(!el)continue;
     const dialog=document.querySelector('[role="dialog"]');if(dialog&&!dialog.contains(el))continue;
     const style=getComputedStyle(el);let bg=[0,0,0,0],opacity=1;
     for(let parent=el;parent;parent=parent.parentElement){const st=getComputedStyle(parent);bg=over(bg,rgba(st.backgroundColor));opacity*=Number(st.opacity)}
     bg=over(bg,[255,255,255,1]);const raw=rgba(style.color);raw[3]*=opacity;const fg=over(raw,bg);
     const a=luminance(fg),b=luminance(bg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
     const size=parseFloat(style.fontSize),weight=parseInt(style.fontWeight,10);const required=size>=24||(size>=18.667&&weight>=700)?3:4.5;
     resolved.push({...node,ratio:Number(ratio.toFixed(2)),required});
    }
    return {violations:r.violations.flatMap(v=>v.nodes.map(n=>({target:n.target,html:n.html,summary:n.failureSummary}))),incomplete,resolvedIncomplete:resolved,textLength:document.body.innerText.length};
   });
   results.push({scheme,page:label,...result});
   if(/profile menu|new project form|calendar event form|Preferred Color/.test(label))await page.screenshot({path:path.join(out,scheme+'-'+label.replace(/[^a-z0-9]+/gi,'-')+'.png')});
   fs.writeFileSync(path.join(out,process.env.REPORT||'report.json'),JSON.stringify({results,errors,requested:[...requested]},null,2));
   console.log(scheme,label,'contrast failures:',result.violations.length);
 };
 const clickAudit=async(locator,label)=>{await locator.click();await audit(current+' :: '+label)};
 const dialogAudit=async(locator,label)=>{
   await locator.click();await page.locator('[role="dialog"]').last().waitFor();await audit(current+' :: '+label);
   if(await page.locator('.ops-modal__panel').count())await page.locator('.ops-modal__panel').getByRole('button',{name:'Close',exact:true}).click();
   else await page.keyboard.press('Escape');
 };
 for(const pathname of (process.env.ROUTES||'').split(',').filter(Boolean).length?(process.env.ROUTES.split(',')):routes){
 current=pathname;
 try{
 await page.goto(base+pathname,{waitUntil:'networkidle',timeout:20000});
 await page.addStyleTag({content:'*, *::before, *::after { transition: none !important; animation: none !important; }'});
 await page.addScriptTag({path:axePath});
 await audit(pathname);
 if(['/dashboard','/operations-calendar','/settings','/invoices'].includes(pathname))await page.screenshot({path:path.join(out,scheme+'-'+pathname.replaceAll('/','')+'.png')});
 if(process.env.DEEP!=='0'){
 if(pathname==='/dashboard'){
  if(!await page.getByText(note.note,{exact:true}).count())throw Error('Populated dashboard note not rendered');
  await clickAudit(page.getByRole('button',{name:'Open profile menu',exact:true}),'profile menu');
  await page.mouse.click(20,500);
  await clickAudit(page.getByRole('button',{name:'Open notifications',exact:true}),'notifications');
  await page.mouse.click(20,500);
 }
 if(pathname==='/projects')await dialogAudit(page.getByRole('button',{name:'New Project',exact:true}),'new project form');
 if(pathname==='/users')await dialogAudit(page.getByRole('button',{name:'Add User',exact:true}),'new user form');
 if(pathname==='/contractors')await dialogAudit(page.locator('.bt-directory-primary-action').first(),'new vendor form');
 if(pathname==='/invoices'){
  for(const button of await page.locator('.bt-qbo-status-filter-pills button').all())await clickAudit(button,(await button.innerText()).trim());
 }
 if(pathname==='/operations-calendar'){
  await dialogAudit(page.locator('.ops-add-button'),'calendar event form');
  for(const label of ['Week','Day'])await clickAudit(page.locator('.ops-view-toggle').getByRole('button',{name:label,exact:true}),label+' view');
 }
 if(pathname==='/projects/audit-project'){
  const tabs=await page.locator('.bt-project-tab-button').allTextContents();
  for(const label of tabs)await clickAudit(page.locator('.bt-project-tab-button').filter({hasText:label.trim()}).first(),label.trim());
 }
 if(pathname==='/settings'){
  for(const label of await page.getByRole('tab').allTextContents())await clickAudit(page.getByRole('tab',{name:label.trim(),exact:true}),label.trim());
 }
 if(pathname==='/quotes'){
  for(const label of ['By Category','Compare Bids','Approved Quotes','Rejected Quotes','Attachments','Audit Log']){
   await page.goto(base+pathname,{waitUntil:'networkidle'});await page.addScriptTag({path:axePath});
   await clickAudit(page.getByRole('button',{name:label,exact:true}),label);
  }
 }
 if(pathname==='/human-resources'){
  for(const label of ['Resumes','Employees','Time & Leave','Pay & Benefits','Compliance'])await clickAudit(page.getByRole('button',{name:label,exact:true}),label);
 }
 if(pathname==='/cost-analyzer'){
  for(const label of ['Vendors','Projects','Categories','Materials','Documents'])await clickAudit(page.getByRole('navigation',{name:'Cost Analyzer sections'}).getByRole('button',{name:label,exact:true}),label);
 }
 }
 }catch(e){errors.push({scheme,page:pathname,message:e.message});}
 }
 await context.close();
 }
 }finally{await browser.close();fs.writeFileSync(path.join(out,process.env.REPORT||'report.json'),JSON.stringify({results,errors,requested:[...requested]},null,2));}
 console.log(JSON.stringify({pages:results.length,violations:results.reduce((n,r)=>n+r.violations.length,0),errors}));
 if(errors.length||results.some(r=>r.violations.length||r.textLength<250||r.resolvedIncomplete.some(n=>n.ratio<n.required)))process.exitCode=1;
})().catch(e=>{console.error(e);process.exit(1)});

