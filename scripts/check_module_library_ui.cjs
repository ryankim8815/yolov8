// Isolated :8012 fixture only. Shared module/box changes stay in temporary QA state.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--disable-background-networking']});
 try{
  const base='http://127.0.0.1:8012',context=await browser.newContext({viewport:{width:1440,height:1050},colorScheme:'dark'}),page=await context.newPage();
  const headers={origin:'http://localhost:8080'},errors=[],blocked=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  const api=async(method,path,data)=>{const r=await context.request.fetch(base+'/api/robot/'+path,{method,data,headers});assert.ok(r.ok(),await r.text());return r.json();};
  const seed=(await api('GET','presets')).presets[0],p=await api('POST','presets/'+seed.id+'/copy',{revision:seed.revision});
  await page.routeWebSocket('**/*',s=>s.close());
  await page.route('**/*',async route=>{
   const r=route.request(),u=new URL(r.url());assert.equal(u.origin,base);
   if(u.pathname==='/api/status')return route.fulfill({status:503,json:{detail:'QA offline'}});
   if(r.method()!=='GET'&&(!['/api/robot/modules','/api/robot/parcel-box','/api/robot/presets'].some(prefix=>u.pathname.startsWith(prefix))||/execution-preview|recognition-preview|executions\/approve/.test(u.pathname))){blocked.push(u.pathname);return route.abort();}
   return route.fulfill({response:await route.fetch({headers:{...r.headers(),...headers}})});
  });
  const manager=page.locator('[data-module-manager]'),ma=name=>manager.locator(`[data-ma="${name}"]`),field=key=>manager.locator(`[data-mf="${key}"]`);
  const selectModule=id=>manager.locator(`[data-module-select="${id}"]`).click();
  const saveModule=async()=>{await ma('save').click();await page.waitForFunction(()=>document.querySelector('[data-m=message]').textContent.includes('모듈을 저장했습니다'));};
  await page.goto(base+'/robot?preset='+p.id+'#module-management-title');
  await manager.locator('[data-module-select=builtin-standby]').waitFor();
  assert.deepEqual(await page.locator('.plane-tabs [data-manipulator-tab]').allTextContents(),['로봇 제어','이동 프리셋','모듈 관리','택배 박스 설정']);
  assert.equal(await manager.locator('[data-module-select]').count(),3);assert.equal(await ma('delete').isDisabled(),true);
  assert.equal(await page.getByText('프리셋별 박스 놓기 TCP · BASE',{exact:true}).count(),0);
  assert.equal(await page.locator('[data-field^="box_pose."],[data-action=import-box],[data-p=standby]').count(),0);
  const protectedResponse=await context.request.delete(base+'/api/robot/modules/builtin-standby',{data:{revision:(await api('GET','modules/builtin-standby')).revision},headers});assert.equal(protectedResponse.status(),409);
  await field('settings.joints.0').fill('4');await field('settings.opening_mm').fill('70');await saveModule();
  await page.locator('#manipulator-points-tab').click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-preset-step]')[0]?.querySelector('[aria-label="1단계 J1"]').value==='4');
  assert.equal(await page.locator('[aria-label="16단계 J1"]').inputValue(),'4');assert.equal(await page.locator('[aria-label="17단계 그리퍼 벌림 (mm)"]').inputValue(),'70');
  await page.locator('#manipulator-modules-tab').click();await manager.locator('[data-m=new-kind]').selectOption('prepare');await ma('new').click();
  await page.waitForFunction(()=>document.querySelector('[data-m=message]').textContent.includes('사용자 모듈을 추가'));
  await field('name').fill('QA 사용자 대기');await field('settings.joints.0').fill('6');await field('default_percent').selectOption('30');await saveModule();
  const custom=(await api('GET','modules')).modules.find(m=>m.name==='QA 사용자 대기');assert.ok(custom&&!custom.builtin);assert.equal(await ma('delete').isEnabled(),true);
  await page.locator('#manipulator-points-tab').click();await page.locator('[data-module-ref="0"]').selectOption(custom.id);
  await page.waitForFunction(()=>document.querySelector('[aria-label="1단계 J1"]')?.value==='6');assert.equal(await page.locator('[aria-label="16단계 J1"]').inputValue(),'4');
  await page.locator('[data-action=save]').click();await page.waitForFunction(()=>document.querySelector('[data-p=saved]').textContent==='저장됨');
  await page.locator('#manipulator-modules-tab').click();await ma('reload').click();await selectModule(custom.id);
  await page.waitForFunction(()=>document.querySelector('[data-ma=delete]').disabled);assert.match(await manager.locator('[data-m=uses]').textContent(),/사용 중/);
  await page.locator('#manipulator-points-tab').click();await page.locator('[data-module-ref="0"]').selectOption('builtin-standby');await page.locator('[data-action=save]').click();await page.waitForFunction(()=>document.querySelector('[data-p=saved]').textContent==='저장됨');
  await page.locator('#manipulator-modules-tab').click();await ma('reload').click();await selectModule(custom.id);
  await page.waitForFunction(()=>!document.querySelector('[data-ma=delete]').disabled);await ma('delete').click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-module-select]').length===3);
  assert.equal((await context.request.get(base+'/api/robot/modules/'+custom.id)).status(),404);
  // Built-in grasp settings can be edited and affect current linked route calculations.
  await selectModule('builtin-grasp');await field('settings.approaches.floor.distance_mm').fill('150');
  await manager.locator('[data-orient-region=floor]').check();await field('settings.grasp_abc.floor.0').fill('90');await saveModule();
  const path=await api('POST','presets/'+p.id+'/preview',{});assert.equal(path.pose[3],90);assert.equal(path.approach[2],path.pose[2]+150);
  // One shared box form owns geometry, taught TCP and clearance.
  await page.locator('#manipulator-box-tab').click();const form=page.locator('#parcel-box-form');
  for(const [name,value] of Object.entries({x:-480,y:10,z:0,tcp_x:-480,tcp_y:10,tcp_z:130,tcp_a:0,tcp_b:180,tcp_c:0,clearance:170}))await form.locator(`[name="${name}"]`).fill(String(value));
  await page.locator('#parcel-box-save').click();await page.waitForFunction(()=>document.querySelector('#parcel-box-feedback').textContent.includes('설정을 저장했습니다'));
  const box=await api('GET','parcel-box');assert.deepEqual(box.tcp_pose,[-480,10,130,0,180,0]);assert.equal(box.clearance_mm,170);
  const updated=await api('POST','presets/'+p.id+'/preview',{simulation_defaults:true});
  assert.deepEqual(updated.steps[10].target,box.tcp_pose);assert.deepEqual(updated.steps[9].target,[-480,10,300,0,180,0]);
  await page.reload();await form.locator('[name=tcp_x]').waitFor();assert.equal(await form.locator('[name=tcp_x]').inputValue(),'-480');
  await page.locator('#manipulator-modules-tab').click();await selectModule('builtin-place');assert.equal(await ma('delete').isDisabled(),true);
  assert.match(await manager.locator('[data-module-box-summary]').textContent(),/-480, 10, 130/);
  fs.mkdirSync('.cache/module-library-ui',{recursive:true});
  for(const width of [1440,390,320]){await page.setViewportSize({width,height:1050});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await manager.screenshot({path:'.cache/module-library-ui/manager-'+width+'.png'});}
  await page.locator('#manipulator-box-tab').click();await form.screenshot({path:'.cache/module-library-ui/shared-box-320.png'});
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  console.log('PASS: renamed module tab, 3 protected editable defaults, user create/read/update/apply/delete, in-use protection, per-instance binding, live standby/grasp updates, removed per-preset TCP, shared box goal/clearance save/reload and 320–1440px UI. No device or microphone calls.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
