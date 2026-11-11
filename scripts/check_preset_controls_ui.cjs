// Only the isolated tests.preset_yolo_qa on :8012. Every SDK/audio/camera request is mocked.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--disable-background-networking']});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1050}}),base='http://127.0.0.1:8012',errors=[],hardware=[],deviceReads=[];
  let voice={listening:false,can_stop:false,target:'simulation',state:'idle'},nativeReady=false,robotReady=false,sdkOnline=true;
  const headers={origin:'http://localhost:8080'};
  const create=async body=>{const r=await context.request.post(base+'/api/robot/presets',{data:body,headers});assert.equal(r.status(),201,await r.text());return r.json();};
  const joints=await create({name:'모의 저장 자세',steps:[{kind:'movej',target:[0,0,90,0,90,0]}]});
  const tcp=await create({name:'모의 저장 TCP',steps:[{kind:'movej',space:'task',target:[450,0,120,0,180,0]}]});
  const free=await create({name:'제어 회귀 경로',steps:[{kind:'movej',target:[0,0,90,0,90,0]},{kind:'wait',seconds:3}]});
  const incomplete=await create({name:'미설정 좌표 경로',steps:[{kind:'movej',source:'waypoint1'},{kind:'place'}]});
  await context.routeWebSocket('**/ws/detections*',socket=>socket.send(JSON.stringify({event:'status',ready:false,state:'camera_off'})));
  await context.route('**/*',async route=>{
   const r=route.request(),u=new URL(r.url());assert.equal(u.origin,base);
   if(/execution-preview|recognition-preview|executions\/approve/.test(u.pathname)){
    hardware.push({path:u.pathname,body:r.postDataJSON()});return route.fulfill({status:503,json:{detail:'모의 장치 · 승인 요청 기록'}});
   }
   if(u.pathname==='/api/status')return route.fulfill({status:nativeReady?200:503,json:nativeReady?{ready:false,state:'camera_off'}:{detail:'모의 서비스 연결 단절'}});
   if(u.pathname==='/api/robot/host-access/status'&&!sdkOnline)return route.fulfill({status:503,json:{detail:'모의 SDK 서비스 연결 단절'}});
   if(u.pathname==='/api/robot/host-access/status')return route.fulfill({json:{connection:robotReady?'connected':'disconnected',initialized:robotReady,robot_state:robotReady?'STANDBY':null,operation_mode:'AUTO',detail:robotReady?'':'모의 유선 연결 확인 필요',can_move:false}});
   if(u.pathname==='/api/robot/work-points/current'){
    assert.equal(r.method(),'GET');deviceReads.push(u.pathname);return route.fulfill({json:{pose:[451,2,123,0,180,0]}});
   }
   if(u.pathname==='/api/robot/preset-voice/start'){
    voice={listening:true,can_stop:true,target:r.postDataJSON().target,state:'listening'};return route.fulfill({json:voice});
   }
   if(u.pathname==='/api/robot/preset-voice/stop'){voice={...voice,listening:false,can_stop:false,state:'idle'};return route.fulfill({json:voice});}
   if(r.method()!=='GET')assert.ok(u.pathname.startsWith('/api/robot/presets')||u.pathname==='/api/robot/pick/cancel'||u.pathname==='/api/robot/preset-voice/cancel',u.pathname);
   const response=await route.fetch({headers:{...r.headers(),...headers}});
   if(u.pathname==='/api/robot/preset-voice/status')return route.fulfill({response,json:{...await response.json(),...voice}});
   if(u.pathname==='/api/robot/status'){
    const data=await response.json();data.config.access_backend='mac-sdk';return route.fulfill({response,json:data});
   }
   return route.fulfill({response});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
  const root=page.locator('#scenario-editor'),action=name=>page.locator(`[data-action="${name}"]`);
  await page.goto(base+'/robot?preset='+free.id+'#work-points-title');await page.locator('[data-op=execute]').first().waitFor();
  await page.waitForFunction(()=>!document.querySelector('[data-action=play]').disabled);
  robotReady=true;await action('refresh-readiness').click();
  await page.waitForFunction(()=>document.querySelector('[data-p=robot-status]').textContent.includes('실제 로봇 연결됨'));
  const other=await context.newPage();other.on('pageerror',e=>errors.push(e.message));
  await other.goto(base+'/robot?preset='+free.id+'#work-points-title');
  await other.locator('[data-p=voice-target]').selectOption('hardware');await other.locator('[data-action=listen]').click();
  await page.waitForFunction(()=>document.querySelector('[data-action=play]')?.textContent==='실제 프리셋 실행');
  assert.deepEqual(await page.locator('[data-op=execute]').allTextContents(),['이 단계 실제 실행','이 단계 실제 실행']);
  await page.bringToFront();await page.locator('[data-op=execute]').first().click();
  await page.waitForFunction(()=>document.querySelector('[data-p=message]')?.textContent.includes('승인 요청 기록'));
  assert.equal(hardware.length,1);assert.equal(hardware[0].body.step_id,free.steps[0].id);
  await other.locator('[data-action=unlisten]').click();await other.close();
  await page.locator('[data-p=voice-target]').selectOption('simulation');
  robotReady=false;await action('refresh-readiness').click();
  assert.deepEqual(await page.locator('[data-op=execute]').allTextContents(),['이 단계 시뮬레이션','이 단계 시뮬레이션']);
  await page.locator('[data-p=rate]').selectOption('1');await action('play').click();
  await page.waitForFunction(()=>document.querySelector('[data-p=simulation]')?.dataset.state==='running');
  await action('pause').click();await page.waitForFunction(()=>document.querySelector('[data-p=simulation]')?.dataset.state==='paused');
  const run=await page.locator('[data-p=simulation]').getAttribute('data-playback');
  await page.getByRole('link',{name:'경로 편집 ↓',exact:true}).click();await page.getByRole('link',{name:'3D 시뮬레이션 제어 ↑',exact:true}).click();
  assert.match(page.url(),/#preset-execution$/);assert.equal(await root.isVisible(),true);
  assert.equal(await page.locator('#manipulator-points-tab').getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('[data-p=simulation]').getAttribute('data-state'),'paused');
  assert.equal(await page.locator('[data-p=simulation]').getAttribute('data-playback'),run);
  await action('sim-stop').click();
  await page.reload();await page.waitForFunction(()=>document.querySelector('[data-field=name]')?.value==='제어 회귀 경로');
  assert.equal(await root.isVisible(),true);assert.equal(await page.locator('#manipulator-points-tab').getAttribute('aria-selected'),'true');
  await page.locator(`[data-select="${incomplete.id}"]`).click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-configure-field]').length===2);
  await page.locator('[data-configure-field="context.waypoint1_joints.0"]').click();
  assert.equal(await page.locator('[data-field="context.waypoint1_joints.0"]').evaluate(e=>e===document.activeElement),true);
  assert.equal(await page.locator('[data-field="context.waypoint1_joints.0"]').inputValue(),'');
  await page.locator('[data-pose-source="context.waypoint1_joints"]').selectOption(joints.id);
  await page.locator('[data-action=import-joints][data-destination="context.waypoint1_joints"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-p=message]')?.textContent.includes('초안에 불러왔습니다'));
  assert.equal(await page.locator('[data-field="context.waypoint1_joints.2"]').inputValue(),'90');
  assert.equal((await(await context.request.get(base+'/api/robot/presets/'+incomplete.id)).json()).context.waypoint1_joints,null);
  await page.locator('[data-configure-field="box_pose.0"]').click();
  await page.locator('[data-pose-source=box_pose]').selectOption(tcp.id);await action('import-tcp').click();
  await page.waitForFunction(()=>document.querySelector('[data-field="box_pose.0"]')?.value==='450');
  assert.equal(await page.locator('[data-configure-field]').count(),0);
  assert.equal((await(await context.request.get(base+'/api/robot/presets/'+incomplete.id)).json()).box_pose,null);
  await page.waitForFunction(()=>!document.querySelector('[data-action=refresh-readiness]').disabled);
  await action('refresh-readiness').click();assert.match(await page.locator('[data-p=native-status]').textContent(),/서비스 연결 안 됨/);
  assert.equal(await action('capture-box').isDisabled(),true);assert.deepEqual(deviceReads,[]);
  sdkOnline=false;await action('refresh-readiness').click();
  await page.waitForFunction(()=>document.querySelector('[data-p=robot-status]').textContent.includes('Mac SDK 서비스 연결 안 됨'));
  assert.equal(await action('capture-box').isDisabled(),true);
  sdkOnline=true;nativeReady=true;robotReady=true;await action('refresh-readiness').click();
  await page.waitForFunction(()=>!document.querySelector('[data-action=capture-box]').disabled&&document.querySelector('[data-p=native-status]').textContent.includes('서비스 연결됨'));
  assert.match(await page.locator('[data-p=native-status]').textContent(),/연결됨.*카메라 꺼짐/);
  await action('capture-box').click();assert.equal(deviceReads.length,1);
  await page.waitForFunction(()=>document.querySelector('[data-field="box_pose.0"]')?.value==='451');
  assert.equal((await(await context.request.get(base+'/api/robot/presets/'+incomplete.id)).json()).box_pose,null);
  await action('save').click();await page.waitForFunction(()=>document.querySelector('[data-p=saved]')?.textContent==='저장됨');
  const saved=await(await context.request.get(base+'/api/robot/presets/'+incomplete.id)).json();assert.deepEqual(saved.box_pose,[451,2,123,0,180,0]);assert.deepEqual(saved.context.waypoint1_joints,joints.steps[0].target);
  // A changed source revision cannot silently replace the coordinates shown in the picker.
  const changed=await context.request.put(base+'/api/robot/presets/'+joints.id,{headers,data:{...joints,name:'모의 저장 자세 변경'}});assert.equal(changed.status(),200);
  await page.locator('[data-pose-source="context.waypoint1_joints"]').selectOption(joints.id);await page.locator('[data-action=import-joints][data-destination="context.waypoint1_joints"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-p=message]')?.textContent.includes('저장 자세가 변경'));
  assert.equal(await page.locator('[data-p=saved]').textContent(),'저장됨');
  await page.locator('.preset-player').screenshot({path:'/private/tmp/preset-controls-fixed-desktop.png'});
  for(const width of [736,390,320]){await page.setViewportSize({width,height:1000});assert.equal(await page.locator('.plane-editor').evaluate(e=>e.scrollWidth>e.clientWidth+1),false,'overflow at '+width);}
  await page.locator('.preset-player').evaluate(el=>el.scrollIntoView({block:'start'}));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.locator('.preset-player').screenshot({path:'/private/tmp/preset-controls-fixed-mobile.png'});
  assert.deepEqual(errors,[]);assert.equal(hardware.length,1);
  console.log('PASS: two-tab target/row labels and correct request, paused playback link and reload, missing-field focus, explicit taught-joint/TCP copies, draft-only capture/save, source revision conflict, readiness offline/recovery, responsive layout. No physical SDK/audio/camera.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
