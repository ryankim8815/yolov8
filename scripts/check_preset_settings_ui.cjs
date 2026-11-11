// Only the isolated tests.preset_yolo_qa server on 8012. No hardware or audio.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--disable-background-networking']});
 try{
  const base='http://127.0.0.1:8012',page=await browser.newPage({viewport:{width:1440,height:1050},colorScheme:'dark'}),errors=[],forbidden=[],voice=[];
  page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
  await page.request.post(base+'/api/robot/preset-voice/stop',{data:{},headers:{origin:'http://localhost:8080'}});
  const seed=(await(await page.request.get(base+'/api/robot/presets')).json()).presets[0];
  const copied=await(await page.request.post(base+'/api/robot/presets/'+seed.id+'/copy',{data:{revision:seed.revision},headers:{origin:'http://localhost:8080'}})).json();
  copied.object_source='saved';copied.region='floor';copied.grasp_abc={floor:null,shelf:null};copied.simulation_objects={floor:null,shelf:null};
  assert.equal((await page.request.put(base+'/api/robot/presets/'+copied.id,{data:copied,headers:{origin:'http://localhost:8080'}})).status(),200);
  const oldKey='vision-gripper-preview-v1:'+JSON.stringify(['old-camera',320,240]);
  const old={distance:550,tcpDepth:350,protrusion:65,length:85,view:'side'};
  await page.addInitScript(({key,value})=>{if(!localStorage.getItem('settings-qa-seeded')){localStorage.setItem(key,JSON.stringify(value));localStorage.setItem('vision-work-plane-example-v1',JSON.stringify({x:-430,y:0,z:35,sizeX:50,sizeY:60,sizeZ:70,showWhenMissing:true}));localStorage.setItem('settings-qa-seeded','1');}},{key:oldKey,value:old});
  await page.routeWebSocket('**/ws/detections*',socket=>socket.close());
  await page.route('**/*',async route=>{
   const r=route.request(),u=new URL(r.url());assert.equal(u.origin,base);
   if(r.method()!=='GET'&&u.pathname.includes('preset-voice'))voice.push(u.pathname);
   if(r.method()!=='GET'&&(!u.pathname.startsWith('/api/robot/presets')||/execution-preview|recognition-preview|executions\/approve/.test(u.pathname))){
    forbidden.push(u.pathname);return route.fulfill({status:503,json:{detail:'모의 UI · 실제 명령 차단'}});
   }
   return route.fulfill({response:await route.fetch({headers:{...r.headers(),origin:'http://localhost:8080'}})});
  });
  const nav=id=>page.locator(`.station-nav [data-page="${id}"]`).click();
  await page.goto(base+'/robot#work-plane');await page.locator('[data-marker=save]:enabled').waitFor();
  assert.deepEqual(await page.locator('.plane-tabs [role=tab]:visible').allTextContents(),['카메라 좌표 설정','바닥 기준']);
  assert.equal(await page.locator('#plane-example-settings,#plane-gripper-settings,#pick-angle-A').count(),0);
  assert.equal(await page.locator('.plane-view-options').isVisible(),false);
  await nav('manipulator');await page.locator('.plane-view-options').waitFor({state:'visible'});
  await page.locator('.plane-view-options > summary').click();
  await page.locator('[data-pick=viewImport] select').selectOption(oldKey);
  await page.getByRole('button',{name:'기존 거리 가이드 불러오기',exact:true}).click();
  assert.equal(await page.locator('#pick-depth-distance').inputValue(),'550');
  const distance=page.getByRole('spinbutton',{name:'카메라 → 벽 직접 입력 (mm)',exact:true});await distance.fill('575');await distance.press('Tab');
  await nav('gripper');await page.locator('[data-gripper-geometry]').waitFor({state:'visible'});
  assert.equal(await page.locator('.plane-view-options').isVisible(),false);
  await page.locator('[data-pick=geometryImport] select').selectOption(oldKey);
  await page.getByRole('button',{name:'기존 손가락 치수 불러오기',exact:true}).click();
  assert.equal(await page.locator('#pick-depth-length').inputValue(),'85');
  const length=page.getByRole('spinbutton',{name:'손가락 길이 직접 입력 (mm)',exact:true});await length.fill('90');await length.press('Tab');
  assert.deepEqual(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),oldKey),old);
  await page.goto(base+'/robot?preset='+copied.id+'#work-points-title');
  const root=page.locator('#scenario-editor');await root.locator('[data-grasp-mode]').waitFor();
  const p=await(await page.request.get(base+'/api/robot/presets')).json();
  const id=new URL(page.url()).searchParams.get('preset'),original=p.presets.find(p=>p.id===id);
  await root.locator('[data-grasp-mode]').selectOption('custom');
  await root.locator('[data-field="grasp_abc.floor.0"]').fill('90');
  await root.locator('[data-action=save]').click();await page.waitForFunction(()=>document.querySelector('[data-p=message]').textContent.includes('저장했습니다'));
  await root.locator('[data-action=import-example]').click();
  await page.waitForFunction(()=>document.querySelector('[data-p=simulation]').textContent.includes('모의 객체'));
  assert.equal(await root.locator('[data-field="simulation_objects.floor.center_base_mm.0"]').inputValue(),'-430');
  await root.locator('[data-action=save]').click();await page.waitForFunction(()=>document.querySelector('[data-p=saved]').textContent.includes('저장됨'));
  const saved=await(await page.request.get(base+'/api/robot/presets/'+id)).json();
  assert.deepEqual(saved.grasp_abc.floor,[90,180,0]);assert.deepEqual(saved.context.virtual,original.context.virtual);
  assert.deepEqual(saved.simulation_objects.floor,{center_base_mm:[-430,0,35],size_mm:[50,60,70]});
  await root.locator('[data-action=copy]').click();await page.waitForFunction(old=>new URL(location.href).searchParams.get('preset')!==old,id);
  const copyId=new URL(page.url()).searchParams.get('preset');
  await root.locator('[data-field="simulation_objects.floor.center_base_mm.0"]').fill('-410');await root.locator('[data-action=save]').click();
  await page.waitForFunction(()=>document.querySelector('[data-p=saved]').textContent.includes('저장됨'));
  assert.equal((await(await page.request.get(base+'/api/robot/presets/'+id)).json()).simulation_objects.floor.center_base_mm[0],-430);
  await page.reload();await page.locator('[data-grasp-mode]').waitFor();
  assert.equal(await root.locator('[data-field="grasp_abc.floor.0"]').inputValue(),'90');
  assert.equal(await root.locator('[data-field="simulation_objects.floor.center_base_mm.0"]').inputValue(),'-410');
  const hardwarePreview=page.waitForResponse(r=>r.url().endsWith('/preview')&&r.request().postDataJSON()?.simulation_object===false);
  await root.locator('[data-p=voice-target]').selectOption('hardware');
  const request=await hardwarePreview;
  const actual=await request.json();assert.equal(actual.example,undefined);assert.deepEqual(actual.pose.slice(0,3),original.context.virtual.floor.center_base_mm);
  await root.locator('[data-p=voice-target]').selectOption('simulation');
  await root.locator('[data-detection-field=object_source][value=yolo]').check();
  await page.waitForFunction(()=>document.querySelector('[data-p=simulation]').textContent.includes('모의 객체'));
  await root.locator('[data-action=play]').click();
  await page.waitForFunction(()=>['running','paused','error','complete'].includes(document.querySelector('[data-p=simulation]').dataset.state));
  assert.notEqual(await root.locator('[data-p=simulation]').getAttribute('data-state'),'error',await root.locator('[data-p=simulation]').textContent());
  assert.deepEqual(voice,[],'mock-object playback must not start ASR');
  await root.locator('[data-action=sim-stop]').click();
  fs.mkdirSync('.cache/preset-settings-ui',{recursive:true});
  await root.locator('.preset-simulation-settings').screenshot({path:'.cache/preset-settings-ui/simulation.png'});
  await root.locator('[data-coordinate-section=grasp]').screenshot({path:'.cache/preset-settings-ui/grasp.png'});
  for(const width of [736,390,320]){await page.setViewportSize({width,height:1000});assert.equal(await root.locator('.preset-simulation-settings').evaluate(el=>el.scrollWidth>el.clientWidth+1),false,'simulation settings overflow at '+width);}
  await nav('gripper');assert.equal(await length.inputValue(),'90');
  assert.deepEqual(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),oldKey),old);
  assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);
  console.log('PASS: four workspace moves, legacy browser value imports, per-preset pose/mock persistence and copy isolation, hardware ignores mock object, camera-free mock playback without ASR, 320px settings layout. No real device commands.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
