// Isolated :8012 only. Uses real browser mouse drag-and-drop; every device request is blocked.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--disable-background-networking']});
 try{
  const base='http://127.0.0.1:8012',context=await browser.newContext({viewport:{width:1440,height:1050},colorScheme:'dark'}),page=await context.newPage();
  const errors=[],blocked=[],headers={origin:'http://localhost:8080'};page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  const api=async(method,path,data)=>{const r=await context.request.fetch(base+'/api/robot/'+path,{method,data,headers});assert.ok(r.ok(),await r.text());return r.json();};
  const seed=(await api('GET','presets')).presets[0];let p=await api('POST','presets/'+seed.id+'/copy',{revision:seed.revision});
  const initial=await api('POST','presets/'+p.id+'/preview',{}),originalOrder=p.steps.map(s=>s.id);
  const grasp=p.steps.find(s=>s.kind==='grasp'),manual=p.steps[3],manualReturn=p.steps[6];
  await page.routeWebSocket('**/*',socket=>socket.close());
  await page.route('**/*',async route=>{
   const r=route.request(),u=new URL(r.url());assert.equal(u.origin,base);
   if(u.pathname==='/api/status')return route.fulfill({status:503,json:{detail:'QA offline'}});
   if(r.method()!=='GET'&&(!u.pathname.startsWith('/api/robot/presets')||/execution-preview|recognition-preview|executions\/approve/.test(u.pathname))){blocked.push(u.pathname);return route.abort();}
   return route.fulfill({response:await route.fetch({headers:{...r.headers(),...headers}})});
  });
  const action=name=>page.locator(`[data-action="${name}"]`),handle=id=>page.locator(`[data-drag-id="${id}"]`);
  const rowFor=id=>page.locator(`tr[data-unit-id="${id}"]`).first();
  const order=()=>page.locator('tbody > tr[data-unit-id]').evaluateAll(rows=>rows.filter((row,i)=>i===0||row.dataset.unitId!==rows[i-1].dataset.unitId).map(row=>row.dataset.unitId));
  const physical=id=>page.locator(`[data-unit-id="${id}"][data-preset-step]`).evaluateAll(rows=>rows.map(row=>row.dataset.presetStep));
  const save=async()=>{await action('save').click();await page.waitForFunction(()=>document.querySelector('[data-p=saved]').textContent==='저장됨'&&[...document.querySelectorAll('[data-drag-id]')].every(el=>!el.disabled));p=await api('GET','presets/'+p.id);};
  await page.goto(base+'/robot?preset='+p.id+'#work-points-title');
  await page.waitForFunction(()=>document.querySelectorAll('[data-preset-step]').length===17);
  assert.deepEqual(await order(),originalOrder);assert.equal(await page.locator('[data-drag-id]').count(),p.steps.length);
  assert.equal(await page.locator('[data-module-kind=prepare]').count(),2);
  assert.equal(await page.locator('[data-module-kind=grasp]').count(),1);assert.equal(await page.locator('[data-module-kind=place]').count(),1);
  assert.deepEqual(await page.locator('[data-p=module] option').evaluateAll(els=>els.map(el=>el.value)),['builtin-standby','builtin-grasp','builtin-place']);
  assert.equal(await page.locator('[data-preset-step][data-unit-id] [data-drag-id]').count(),4);
  const children=await physical(grasp.id);assert.equal(children.length,5);
  for(const id of children)assert.equal(await page.locator(`[data-preset-step="${id}"] [draggable=true]`).count(),0);
  // A native mouse drop below a manual row moves the complete five-stage grasp module.
  const box=await rowFor(manual.id).boundingBox();
  await handle(grasp.id).dragTo(rowFor(manual.id),{targetPosition:{x:120,y:box.height-4}});
  const expected=[...originalOrder];expected.splice(2,1);expected.splice(3,0,grasp.id);
  await page.waitForFunction(expected=>{const rows=[...document.querySelectorAll('tbody > tr[data-unit-id]')];return JSON.stringify(rows.filter((r,i)=>!i||r.dataset.unitId!==rows[i-1].dataset.unitId).map(r=>r.dataset.unitId))===JSON.stringify(expected);},expected);
  await page.waitForFunction(()=>document.querySelectorAll('[data-preset-step]').length===17);
  assert.deepEqual(await physical(grasp.id),children);assert.match(await page.locator('[data-p=reorder-status]').textContent(),/모듈 전체/);
  await save();assert.deepEqual(p.steps.map(s=>s.id),expected);
  const compiled=await api('POST','presets/'+p.id+'/preview',{});
  const byRoot=new Map(originalOrder.map(id=>[id,initial.steps.filter(s=>(s.group_id||s.id)===id).map(s=>s.id)]));
  assert.deepEqual(compiled.steps.map(s=>s.id),expected.flatMap(id=>byRoot.get(id)));
  // Dropping on a child row can insert only before/after its entire owning module.
  // Activate the native drag before scrolling a distant drop target into view.
  const sourceHandle=handle(manualReturn.id),targetChild=page.locator(`[data-preset-step="${children[0]}"]`);
  await sourceHandle.scrollIntoViewIfNeeded();const sourceBox=await sourceHandle.boundingBox();
  await page.mouse.move(sourceBox.x+sourceBox.width/2,sourceBox.y+sourceBox.height/2);await page.mouse.down();
  await page.mouse.move(sourceBox.x+sourceBox.width/2+10,sourceBox.y+sourceBox.height/2,{steps:3});
  await targetChild.scrollIntoViewIfNeeded();const childBox=await targetChild.boundingBox();
  await page.mouse.move(childBox.x+120,childBox.y+8,{steps:20});await page.mouse.move(childBox.x+121,childBox.y+8);await page.mouse.up();
  const second=[...expected];second.splice(second.indexOf(manualReturn.id),1);second.splice(second.indexOf(grasp.id),0,manualReturn.id);
  await page.waitForFunction(expected=>{const rows=[...document.querySelectorAll('tbody > tr[data-unit-id]')];return JSON.stringify(rows.filter((r,i)=>!i||r.dataset.unitId!==rows[i-1].dataset.unitId).map(r=>r.dataset.unitId))===JSON.stringify(expected);},second);
  await page.waitForFunction(()=>document.querySelectorAll('[data-preset-step]').length===17);
  assert.deepEqual(await physical(grasp.id),children);await save();
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('[data-preset-step]').length===17);
  assert.deepEqual(await order(),second);assert.deepEqual(await physical(grasp.id),children);
  // The server rejects both same-kind swaps and attempts to strip slot metadata.
  for(const strip of [false,true]){
   const bad=structuredClone(p),g=bad.steps.find(s=>s.id===grasp.id);[g.children[2],g.children[4]]=[g.children[4],g.children[2]];
   if(strip)for(const child of g.children)delete child.module_slot;
   const response=await context.request.put(base+'/api/robot/presets/'+p.id,{data:bad,headers});assert.equal(response.status(),422);
  }
  // Reordered playback consumes the same stored whole-unit order; handles lock during playback.
  await page.locator('[data-p=rate]').selectOption('20');await action('play').click();
  await page.waitForFunction(()=>['running','error'].includes(document.querySelector('[data-p=simulation]').dataset.state));
  assert.equal(await page.locator('[data-p=simulation]').getAttribute('data-state'),'running',await page.locator('[data-p=simulation]').textContent());
  assert.equal(await page.locator('[data-drag-id]:not(:disabled)').count(),0);
  await page.waitForFunction(()=>['complete','error'].includes(document.querySelector('[data-p=simulation]').dataset.state),null,{timeout:60000});
  assert.equal(await page.locator('[data-p=simulation]').getAttribute('data-state'),'complete',await page.locator('[data-p=simulation]').textContent());
  await action('sim-stop').click();
  // All three module types can be inserted, and a standby copy gets a distinct hand ID.
  for(const id of ['builtin-standby','builtin-grasp','builtin-place']){await page.locator('[data-p=module]').selectOption(id);await action('add-module').click();}
  await page.waitForFunction(()=>document.querySelectorAll('[data-preset-step]').length===28);await save();
  const standby=p.steps.findLast(s=>s.kind==='prepare'),index=p.steps.findIndex(s=>s.id===standby.id);
  await rowFor(standby.id).locator('.preset-node-menu > summary').click();await page.locator(`[data-op=copy][data-index="${index}"]`).click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-preset-step]').length===30);await save();
  const ids=(await api('POST','presets/'+p.id+'/preview',{})).steps.map(s=>s.id);assert.equal(new Set(ids).size,30);
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('[data-preset-step]').length===30);
  assert.equal(await page.locator('[data-module-kind=prepare]').count(),4);
  fs.mkdirSync('.cache/preset-modules-ui',{recursive:true});
  for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:1050});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
   await page.locator('#scenario-editor .preset-step-add').screenshot({path:'.cache/preset-modules-ui/add-'+width+'.png'});
  }
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  console.log('PASS: all 3 module types, start/return standby grouping, native mouse drag of complete modules and individual rows, drop onto a child stays at module boundaries, fixed internal IDs/order, server rejection, save/reload, reordered playback, busy locks, module copy and 320–1440px layout. No device or microphone calls.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
