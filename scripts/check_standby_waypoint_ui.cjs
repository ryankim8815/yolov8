// Temporary :8012 QA only; real SDK, camera and microphone requests are blocked.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--disable-background-networking']});
 try{
  const base='http://127.0.0.1:8012',context=await browser.newContext({viewport:{width:1440,height:1050},colorScheme:'dark'}),page=await context.newPage();
  const errors=[],blocked=[],headers={origin:'http://localhost:8080'};
  page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  const api=async(method,path,data)=>{const r=await context.request.fetch(base+'/api/robot/'+path,{method,data,headers});assert.ok(r.ok(),await r.text());return r.json();};
  const seed=(await api('GET','presets')).presets[0],p=await api('POST','presets/'+seed.id+'/copy',{revision:seed.revision});
  const rowIndex=3,row=p.steps[rowIndex];
  await page.routeWebSocket('**/*',socket=>socket.close());
  await page.route('**/*',async route=>{
   const r=route.request(),url=new URL(r.url());assert.equal(url.origin,base);
   if(url.pathname==='/api/status')return route.fulfill({status:503,json:{detail:'QA offline'}});
   if(r.method()!=='GET'&&(!url.pathname.startsWith('/api/robot/presets')||/execution-preview|recognition-preview|executions\/approve/.test(url.pathname))){blocked.push(url.pathname);return route.abort();}
   return route.fulfill({response:await route.fetch({headers:{...r.headers(),...headers}})});
  });
  const action=name=>page.locator(`[data-action="${name}"]`),standby=page.locator('#manipulator-standby');
  await page.goto(base+'/robot?preset='+p.id+'#work-points-title');
  await page.locator(`[data-joint="${rowIndex}.0"]`).waitFor();
  assert.deepEqual(await page.locator('.plane-tabs [data-manipulator-tab]').allTextContents(),['로봇 제어','이동 프리셋','대기 자세','택배 박스 설정']);
  assert.equal(await page.locator('[data-field^="context.waypoint1_joints"],[data-pose-source="context.waypoint1_joints"],[data-coordinate-section=joints]').count(),0);
  assert.equal(await page.locator('#scenario-editor [data-field^="context.standby_joints"]').count(),0);
  assert.equal(await page.locator(`[data-joint="${rowIndex}.0"]`).inputValue(),'-180');
  assert.equal(await page.locator(`[data-joint="${rowIndex}.0"]`).getAttribute('readonly'),null);
  await page.locator(`[data-joint="${rowIndex}.0"]`).fill('-170');await page.locator(`[data-joint="${rowIndex}.2"]`).fill('65');
  await page.waitForFunction(()=>document.querySelector('[data-p=saved]').textContent==='저장 전 변경');
  await action('save').click();await page.waitForFunction(()=>document.querySelector('[data-p=saved]').textContent==='저장됨');
  const edited=await api('GET','presets/'+p.id),target=[-170,0,65,0,120,0];
  assert.deepEqual(edited.context.waypoint1_joints,p.context.waypoint1_joints);
  assert.equal(edited.steps[rowIndex].source,'explicit');assert.deepEqual(edited.steps[rowIndex].target,target);
  const compiled=await api('POST','presets/'+p.id+'/preview',{simulation_defaults:true});
  const turn=edited.steps[4];
  assert.deepEqual(compiled.steps.find(s=>s.id===turn.id).target,p.steps[4].target);
  await page.locator('#manipulator-standby-tab').click();assert.match(page.url(),/#standby-title$/);
  assert.equal(await standby.isVisible(),true);assert.equal(await page.locator('#scenario-editor').isVisible(),false);
  assert.equal(await page.locator('#preset-execution').isVisible(),false);
  assert.equal(await standby.locator('[data-field^="context.standby_joints"]').count(),6);
  await standby.locator('[data-field="context.standby_joints.0"]').fill('1');
  assert.equal(await standby.locator('[data-p=standby-saved]').textContent(),'저장 전 변경');
  await action('standby-save').click();await page.waitForFunction(()=>document.querySelector('[data-p=standby-saved]').textContent==='저장됨');
  const saved=await api('GET','presets/'+p.id);assert.deepEqual(saved.context.standby_joints,[1,0,90,0,90,0]);
  const preview=await api('POST','presets/'+p.id+'/preview',{});
  assert.deepEqual(preview.steps[0].target,saved.context.standby_joints);
  assert.deepEqual(preview.steps.at(-2).target,saved.context.standby_joints);
  await page.reload();await standby.locator('[data-p=standby-preset]').waitFor();
  assert.equal(await page.locator('#manipulator-standby-tab').getAttribute('aria-selected'),'true');
  assert.equal(await standby.locator('[data-field="context.standby_joints.0"]').inputValue(),'1');
  await standby.locator('[data-field="context.standby_joints.0"]').fill('2');await action('standby-discard').click();
  assert.equal(await standby.locator('[data-field="context.standby_joints.0"]').inputValue(),'1');
  await standby.locator('[data-p=standby-preset]').selectOption(seed.id);
  await page.waitForFunction(id=>new URL(location.href).searchParams.get('preset')===id,seed.id);
  assert.equal(await standby.locator('[data-field="context.standby_joints.0"]').inputValue(),String(seed.context.standby_joints[0]));
  await standby.locator('[data-p=standby-preset]').selectOption(p.id);
  await page.waitForFunction(id=>new URL(location.href).searchParams.get('preset')===id,p.id);
  assert.equal(await standby.locator('[data-field="context.standby_joints.0"]').inputValue(),'1');
  await page.locator('#manipulator-standby-tab').focus();await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#manipulator-points-tab').getAttribute('aria-selected'),'true');
  assert.equal(await page.locator(`[data-joint="${rowIndex}.0"]`).inputValue(),'-170');
  await page.keyboard.press('ArrowRight');assert.equal(await standby.isVisible(),true);
  fs.mkdirSync('.cache/standby-waypoint-ui',{recursive:true});
  for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:1050});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
   await standby.screenshot({path:'.cache/standby-waypoint-ui/standby-'+width+'.png'});
  }
  // Remounting the workspace keeps one standalone editor and the selected saved preset.
  await page.goto(base+'/robot#dashboard');await page.goto(base+'/robot?preset='+p.id+'#standby-title');
  await standby.locator('[data-p=standby-preset]').waitFor();assert.equal(await page.locator('[data-p=standby]').count(),1);
  assert.deepEqual(await api('GET','presets/'+seed.id),seed);assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  console.log('PASS: waypoint inputs removed from settings and independently editable in table; standalone standby tab order, per-preset save/discard/reload, prepare/return targets, deep links, keyboard navigation, remount and 320–1440px layout. No device or microphone calls.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
