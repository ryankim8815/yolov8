// :8012 isolated QA fixture only; no SDK, camera or microphone calls.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--disable-background-networking']});
 try{
  const base='http://127.0.0.1:8012',context=await browser.newContext({viewport:{width:1440,height:1050},colorScheme:'dark'}),page=await context.newPage();
  const headers={origin:'http://localhost:8080'},errors=[],blocked=[];
  const expected=['standby','standby',...Array(5).fill('object'),'manual','manual',...Array(4).fill('box'),'manual','manual','standby','standby'];
  const roots=[3,4,6,7],values=[[-180,0,60,0,120,0],[0,0,60,0,120,0],[1,0,61,0,119,0],[-179,0,62,0,118,0]];
  page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  const api=async(method,path,data)=>{const r=await context.request.fetch(base+'/api/robot/'+path,{method,data,headers});assert.ok(r.ok(),await r.text());return r.json();};
  const seed=(await api('GET','presets')).presets[0],copy=await api('POST','presets/'+seed.id+'/copy',{revision:seed.revision});
  copy.context.waypoint1_joints=null;for(const i of roots)copy.steps[i].target=null;
  let p=await api('PUT','presets/'+copy.id,copy);
  await page.routeWebSocket('**/*',s=>s.close());
  await page.route('**/*',async route=>{
   const r=route.request(),u=new URL(r.url());assert.equal(u.origin,base);
   if(u.pathname==='/api/status')return route.fulfill({status:503,json:{detail:'QA offline'}});
   if(r.method()!=='GET'&&(!u.pathname.startsWith('/api/robot/presets')||/execution-preview|recognition-preview|executions\/approve/.test(u.pathname))){blocked.push(u.pathname);return route.abort();}
   return route.fulfill({response:await route.fetch({headers:{...r.headers(),...headers}})});
  });
  await page.goto(base+'/robot?preset='+p.id+'#work-points-title');
  const rows=page.locator('[data-preset-step]'),action=name=>page.locator(`[data-action="${name}"]`);
  await page.waitForFunction(()=>document.querySelectorAll('[data-preset-step]').length===17);
  assert.deepEqual(await rows.evaluateAll(rows=>rows.map(row=>row.dataset.calculation)),expected);
  assert.equal(await page.locator('[data-joint]').count(),24);assert.equal(await page.locator('[data-joint]').evaluateAll(els=>els.every(el=>el.value===''&&!el.readOnly&&!el.disabled)),true);
  assert.equal(await action('play').isDisabled(),true);assert.equal(await page.locator('[data-configure-field^="step:"]').count(),4);
  for(const [i,category] of expected.entries())if(category!=='manual'){
   assert.equal(await rows.nth(i).locator('[data-joint],[data-node-value]').count(),0);
   assert.match(await rows.nth(i).locator('td').nth(2).textContent(),/자동 계산/);
   for(const input of await rows.nth(i).locator('input[type=number]').all())assert.equal(await input.getAttribute('readonly'),'');
  }
  // Editing stage 8 cannot fill or modify the three other transfer rows.
  for(const [j,v] of values[0].entries())await page.locator(`[data-joint="3.${j}"]`).fill(String(v));
  for(const root of roots.slice(1))assert.deepEqual(await page.locator(`[data-joint^="${root}."]`).evaluateAll(els=>els.map(el=>el.value)),Array(6).fill(''));
  for(let i=1;i<roots.length;i++)for(const [j,v] of values[i].entries())await page.locator(`[data-joint="${roots[i]}.${j}"]`).fill(String(v));
  await page.waitForFunction(()=>!document.querySelector('[data-action=play]').disabled);
  await action('save').click();await page.waitForFunction(()=>document.querySelector('[data-p=saved]').textContent==='저장됨');
  p=await api('GET','presets/'+p.id);assert.deepEqual(roots.map(i=>p.steps[i].target),values);
  assert.ok(roots.every(i=>p.steps[i].source==='explicit'&&!p.steps[i].reference_id&&!p.steps[i].j1_only));
  await page.locator('[data-joint="3.0"]').fill('-170');
  for(let i=1;i<roots.length;i++)assert.deepEqual(await page.locator(`[data-joint^="${roots[i]}."]`).evaluateAll(els=>els.map(el=>el.valueAsNumber)),values[i]);
  await page.locator('#manipulator-standby-tab').click();
  await page.locator('[data-field="context.standby_joints.0"]').fill('4');await page.locator('[data-field="context.standby_opening_mm"]').fill('70');
  await page.locator('#manipulator-points-tab').click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-preset-step]')[16].querySelector('.preset-hand-width input').value==='70');
  for(let i=1;i<roots.length;i++)assert.deepEqual(await page.locator(`[data-joint^="${roots[i]}."]`).evaluateAll(els=>els.map(el=>el.valueAsNumber)),values[i]);
  assert.equal(await rows.nth(16).locator('.preset-hand-source select,.preset-hand-width [data-node-field]').count(),0);
  assert.equal(await rows.nth(16).locator('.preset-hand-contact input').isDisabled(),true);
  await page.locator('[data-p=rate]').selectOption('20');await action('play').click();
  await page.waitForFunction(()=>['complete','error'].includes(document.querySelector('[data-p=simulation]').dataset.state),null,{timeout:60000});
  assert.equal(await page.locator('[data-p=simulation]').getAttribute('data-state'),'complete',await page.locator('[data-p=simulation]').textContent());
  await action('sim-stop').click();await action('discard').click();
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('[data-preset-step]').length===17);
  assert.deepEqual(await rows.evaluateAll(rows=>rows.map(row=>row.dataset.calculation)),expected);
  for(let i=0;i<roots.length;i++)assert.deepEqual(await page.locator(`[data-joint^="${roots[i]}."]`).evaluateAll(els=>els.map(el=>el.valueAsNumber)),values[i]);
  fs.mkdirSync('.cache/preset-calculation-ui',{recursive:true});
  for(const width of [1440,390,320]){await page.setViewportSize({width,height:1050});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await page.locator('.preset-table-scroll').screenshot({path:'.cache/preset-calculation-ui/table-'+width+'.png'});}
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  console.log('PASS: exact 13 automatic/4 independent manual stages, 24 editable cells, no auto-filled missing joints, locked standby/YOLO/box results including stage 17, independent edits/save/reload, standby propagation, complete offline playback and 320–1440px layout. No device or microphone calls.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
