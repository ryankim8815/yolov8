// Isolated browser check: every network request is intercepted; no device API is contacted.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
process.chdir(path.resolve(__dirname,'..'));
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--disable-background-networking']});
 try {
  const page=await browser.newPage({viewport:{width:1200,height:950}}),commands=[],errors=[];
  const status={config:{access_backend:'mac-sdk',ros_pc_ip:'127.0.0.1'},topics:[{name:'joint_states',state:'waiting',hz:null,message:null}]};
  const host={session_id:'fake',motion_token:'a'.repeat(32),can_move:true,gripper_supported:true,gripper_target:262,
   gripper_feedback:{state:'completed',position:262,current_ma:30,goal_current_ma:120,limit_ma:250,mode:5,error:0,input_voltage_v:24.1,observed_at:new Date().toISOString()}};
  let table={revision:'saved',points:[{position:0,width_mm:80},{position:700,width_mm:0}]};
  let contact={revision:null,threshold_ma:null};const contactWrites=[];let holdPreview=false,previewStarted,releasePreview;
  page.on('pageerror',e=>errors.push(e.message));
  await page.routeWebSocket('**/ws/detections*',socket=>socket.send(JSON.stringify({event:'status',ready:false,state:'camera_off'})));
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),resource=url.pathname;
   if(resource==='/robot')return route.fulfill({path:'app/static/robot.html',contentType:'text/html'});
   if(resource.startsWith('/static/')&&fs.existsSync('app'+resource))return route.fulfill({path:'app'+resource,contentType:resource.endsWith('.js')?'text/javascript':resource.endsWith('.css')?'text/css':'image/svg+xml'});
   let value={};const body=req.postDataJSON();
   if(resource==='/api/status')value={state:'camera_off',ready:false};
   else if(resource==='/api/robot/camera-calibration')value={revision:null,enabled:false,config:null,result:null,state:'unconfigured',message:'마커 좌표 등록 후 캘리브레이션하세요.',busy:false};
   else if(resource==='/api/robot/status')value=status;
   else if(resource==='/api/robot/host-access/status')value=host;
   else if(resource.endsWith('/parcel-box'))value={revision:null};
   else if(resource==='/api/robot/presets')return route.fulfill({status:503,json:{detail:'그리퍼 전용 모의 화면'}});
   else if(resource==='/api/robot/preset-voice/status')value={busy:false,listening:false,can_stop:false,stop_serial:0};
   else if(resource==='/api/robot/pick/scenario/status')value={move:null};
   else if(resource.endsWith('/floor-reference'))value={revision:null,z_mm:0};
   else if(resource.endsWith('/contact')){
    if(req.method()==='PUT'){contactWrites.push(body);contact={revision:'contact-saved',threshold_ma:body.threshold_ma};}
    value=contact;
   }
   else if(resource.endsWith('/table')){
    if(req.method()==='PUT')table={revision:'updated',points:body.points};
    value=table;
   }
   else if(resource.endsWith('/test/preview')) {
    if(holdPreview){holdPreview=false;previewStarted();await new Promise(resolve=>{releasePreview=resolve;});}
    if(body.width_mm>table.points[0].width_mm)return route.fulfill({status:409,json:{detail:'필요 벌림이 교시 범위 밖입니다.'}});
    value={...body,position:267,estimated_width_mm:50.104};
   }else if(resource.endsWith('/test')||resource.endsWith('/command')) {commands.push(body);value={state:'completed',message:'모의 장치 완료',feedback:{position:262}};}
   else throw Error('Unexpected request: '+resource);
   return route.fulfill({json:value});
  });
  const unit=page.locator('#hand-position-unit'),input=page.locator('#hand-position'),move=page.locator('#hand-position-move');
  const dialog=page.locator('#hand-move-dialog'),confirm=page.locator('#hand-move-confirm');
  await page.goto('http://gripper.test/robot#gripper');
  await page.locator('#hand-samples input').first().waitFor();
  assert.equal(await page.locator('.plane-tabs').isVisible(),false);
  assert.equal(await page.getByRole('tab',{name:'벌림 테스트'}).count(),0);
  assert.equal(await page.locator('#plane-hand-test').count(),0);
  assert.equal(await page.locator('#plane-hand-table').isVisible(),true);
  assert.equal(await page.locator('.plane-summary').isVisible(),false);
  assert.equal(await page.locator('.pick-footer').isVisible(),false);
  assert.equal(await page.locator('[data-pick=modelTitle]').textContent(),'그리퍼 방향');
  await page.getByRole('button',{name:'측면',exact:true}).click();
  assert.equal(await page.locator('[data-depth-view=side]').getAttribute('aria-pressed'),'true');
  await page.locator('[data-page=work-plane]').click();
  await page.locator('.plane-tabs').waitFor({state:'visible'});
  assert.equal(await page.locator('.plane-tabs').isVisible(),true);
  assert.equal(await page.locator('.plane-view-options').isVisible(),false);
  assert.equal(await page.locator('#plane-example-settings,#plane-gripper-settings').count(),0);
  assert.deepEqual(await page.locator('.plane-tabs [role=tab]:visible').allTextContents(),['카메라 좌표 설정','바닥 기준']);
  await page.goto('http://gripper.test/robot#gripper-test');
  await page.locator('#hand-samples input').first().waitFor();
  assert.match(page.url(),/#gripper$/);assert.equal(await page.locator('#plane-hand-table').isVisible(),true);
  await page.goto('http://gripper.test/robot#gripper-table');
  await page.locator('#hand-samples input').first().waitFor();
  await page.locator('#hand-samples [data-field=width_mm]').first().fill('81');await page.locator('#hand-save').click();
  await page.waitForFunction(()=>document.querySelector('#hand-table-note').textContent.includes('저장했습니다'));
  assert.equal(table.points[0].width_mm,81);
  assert.equal(await unit.inputValue(),'position');assert.equal(await input.getAttribute('step'),'1');
  await page.waitForFunction(()=>!document.querySelector('#hand-position-move').disabled);
  for(const invalid of ['1.5','701']){await input.fill(invalid);await move.click();assert.equal(commands.length,0);}
  await input.fill('350');await move.click();await page.waitForFunction(()=>document.querySelector('#hand-result').textContent.includes('모의 장치 완료'));
  assert.equal(commands.length,1);assert.equal(commands[0].action,'position');assert.equal(commands[0].position,350);assert.equal('width_mm' in commands[0],false);
  await page.waitForFunction(()=>!document.querySelector('#hand-position-unit').disabled);
  await unit.selectOption('width');assert.equal(await input.inputValue(),'');assert.equal(await input.getAttribute('step'),'any');
  await input.fill('50');await move.click();await dialog.waitFor({state:'visible'});
  assert.match(await page.locator('#hand-move-target').textContent(),/267/);
  await page.locator('#hand-move-cancel').click();assert.equal(commands.length,1);
  await move.click();await dialog.waitFor({state:'visible'});await confirm.dblclick();
  await page.waitForFunction(()=>document.querySelector('#hand-result').textContent.includes('모의 장치 완료'));
  assert.equal(commands.length,2);assert.equal(commands[1].width_mm,50);assert.equal(commands[1].revision,'updated');assert.equal('position' in commands[1],false);
  await page.waitForFunction(()=>document.querySelector('#hand-opening').textContent.includes('50.7 mm'));
  await input.fill('90');await move.click();await page.waitForFunction(()=>document.querySelector('#hand-result').textContent.includes('교시 범위'));assert.equal(await dialog.isVisible(),false);
  await input.fill('50');await page.locator('#hand-samples input').first().fill('1');
  assert.equal(await move.isDisabled(),true);assert.match(await page.locator('#hand-position-help').textContent(),/변경사항/);
  await page.locator('#hand-reload').click();await page.waitForFunction(()=>!document.querySelector('#hand-position-move').disabled);
  const waiting=new Promise(resolve=>{previewStarted=resolve;});holdPreview=true;
  await move.click();await waiting;await unit.selectOption('position');assert.equal(await input.inputValue(),'');
  const finished=page.waitForResponse(r=>r.url().endsWith('/test/preview'));releasePreview();await finished;
  await page.waitForFunction(()=>!document.querySelector('#hand-position-move').disabled);assert.equal(await dialog.isVisible(),false);assert.equal(commands.length,2);
  await unit.selectOption('width');await input.fill('50');await move.click();await dialog.waitFor({state:'visible'});
  await page.evaluate(()=>window.dispatchEvent(new Event('robot-global-stop')));await dialog.waitFor({state:'hidden'});assert.equal(commands.length,2);
  await move.click();await dialog.waitFor({state:'visible'});status.pick_active=true;
  await page.waitForFunction(()=>document.querySelector('#hand-move-confirm').disabled);await page.locator('#hand-move-cancel').click();
  await unit.selectOption('position');assert.equal(await move.isDisabled(),true);
  status.pick_active=false;await page.waitForFunction(()=>!document.querySelector('#hand-position-move').disabled);
  await page.locator('[data-hand=read]').click();await page.waitForFunction(()=>document.querySelector('#hand-result').textContent.includes('모의 장치 완료'));
  assert.equal(commands.length,3);assert.equal(commands[2].action,'read');
  await page.waitForFunction(()=>!document.querySelector('[data-hand=read]').disabled);
  await unit.selectOption('width');await input.fill('50');
  await page.locator('#plane-hand-table').screenshot({path:'/private/tmp/gripper-calibration-integrated-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  for(const mode of ['position','width']){await unit.selectOption(mode);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
  await input.fill('50');
  await page.locator('#plane-hand-table').screenshot({path:'/private/tmp/gripper-calibration-integrated-mobile.png'});
  table={revision:null,points:[]};await page.goto('http://gripper.test/robot#gripper-table');await page.reload();
  await page.locator('#hand-samples input').first().waitFor();assert.equal(await page.locator('.hand-sample').count(),2);
  await unit.selectOption('width');await input.fill('50');assert.equal(await move.isDisabled(),true);
  assert.equal(await page.locator('#hand-save').isDisabled(),true);assert.match(await page.locator('#hand-table-validation').textContent(),/1번.*실제 위치/);
  await page.waitForFunction(()=>!document.querySelector('#hand-capture').disabled);await page.locator('#hand-capture').click();
  assert.equal(await page.locator('.hand-sample').count(),2);assert.equal(await page.locator('.hand-sample [data-field=position]').first().inputValue(),'262');
  const sample=number=>page.locator('.hand-sample').nth(number);
  await sample(0).locator('[data-field=position]').fill('0');await sample(0).locator('[data-field=width_mm]').fill('80');assert.equal(await page.locator('#hand-save').isDisabled(),true);
  await sample(1).locator('[data-field=position]').fill('700');await sample(1).locator('[data-field=width_mm]').fill('0');assert.equal(await page.locator('#hand-save').isEnabled(),true);
  await sample(1).locator('[data-field=position]').fill('0');assert.match(await page.locator('#hand-table-validation').textContent(),/중복/);
  await sample(1).locator('[data-field=position]').fill('700');await sample(1).locator('[data-field=width_mm]').fill('90');assert.match(await page.locator('#hand-table-validation').textContent(),/작아져야/);
  await sample(1).locator('[data-field=width_mm]').fill('0');await page.locator('#hand-save').click();
  await page.waitForFunction(()=>document.querySelector('#hand-table-note').textContent.includes('저장했습니다'));assert.deepEqual(table.points,[{position:0,width_mm:80},{position:700,width_mm:0}]);
  assert.equal(await page.locator('#hand-contact-current').inputValue(),'30');assert.equal(contactWrites.length,0);
  await page.locator('#hand-contact-save').click();await page.waitForFunction(()=>document.querySelector('#hand-contact-result').textContent.includes('저장 완료'));assert.equal(contactWrites[0].threshold_ma,30);
  contact={revision:'existing-contact',threshold_ma:45};await page.locator('#hand-contact-reload').click();await page.waitForFunction(()=>document.querySelector('#hand-contact-current').value==='45');
  // The monitoring shortcut and global control share the same state-aware recovery dialog.
  host.robot_state='SAFE_OFF';host.servo={token:'b'.repeat(32),message:'서보 꺼짐'};
  await page.goto('http://gripper.test/robot#manipulator');
  await page.waitForFunction(()=>document.querySelector('#servo-on')?.textContent==='서보 켜기…');
  assert.equal(await page.locator('#servo-dialog,#pose-dialog').count(),0);
  await page.locator('#servo-on').click();await page.locator('#robot-standby-dialog').waitFor({state:'visible'});
  assert.match(await page.locator('#robot-standby-title').textContent(),/서보/);
  await page.getByRole('button',{name:'복구 요청 취소',exact:true}).click();
  host.robot_state='SAFE_STOP';await page.locator('#robot-standby').click();
  await page.locator('#robot-standby-dialog').waitFor({state:'visible'});
  assert.match(await page.locator('#robot-standby-description').textContent(),/SAFE_STOP/);
  await page.getByRole('button',{name:'복구 요청 취소',exact:true}).click();
  host.robot_state='STANDBY';await page.locator('#robot-standby').click();
  await page.waitForFunction(()=>document.querySelector('.rail-standby-state')?.textContent.includes('준비 완료'));
  assert.equal(await page.locator('#robot-standby-dialog').isVisible(),false);
  assert.equal(commands.length,3);assert.deepEqual(errors,[]);
  console.log('PASS: integrated raw/mm move, legacy links, no redundant tabs, preserved direction/work plane, calibration/contact/read, bounds, saved-table conversion, cancel/double click, stale preview after unit switch, stop/lock, desktop/mobile. All network mocked; no devices.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
