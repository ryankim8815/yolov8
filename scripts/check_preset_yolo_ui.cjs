// Requires tests.preset_yolo_qa on :8012. Both the fixture and browser block actuators.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');

(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--disable-background-networking']});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1050}}),base='http://127.0.0.1:8012',errors=[],hardware=[];
  let holdNextVoiceStatus=false,statusHeld,releaseStatus;
  page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.routeWebSocket('**/ws/detections*',socket=>socket.close());
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());assert.equal(url.origin,base);
   if(/execution-preview|recognition-preview|executions\/approve/.test(url.pathname)){
    hardware.push({path:url.pathname,body:request.postDataJSON()});
    return route.fulfill({status:503,json:{detail:'UI 검증 · 실제 명령 차단'}});
   }
   const response=await route.fetch({headers:{...request.headers(),origin:'http://localhost:8080'}});
   if(url.pathname==='/api/robot/preset-voice/status'&&holdNextVoiceStatus){holdNextVoiceStatus=false;await new Promise(resolve=>{releaseStatus=resolve;statusHeld();});}
   return route.fulfill({response});
  });
  const setState=async data=>{const response=await page.request.post(base+'/__qa/state',{data});assert.equal(response.status(),200);};
  await page.goto(base+'/robot#work-points-title');
  const root=page.locator('#scenario-editor'),action=name=>root.locator('[data-action="'+name+'"]'),source=root.locator('[data-p=object-source]');
  const capture=async()=>{
   const response=page.waitForResponse(r=>r.url().endsWith('/detections')&&r.request().method()==='POST');
   await source.locator('[data-detection-action=capture]').click();await response;
   await page.waitForFunction(()=>!document.querySelector('[data-detection-action=capture]').disabled);
  };
  const waitSaved=()=>page.waitForFunction(()=>document.querySelector('[data-p=saved]')?.textContent==='저장됨');
  await page.waitForFunction(()=>document.querySelector('[data-p=list] button'));
  await root.locator('.preset-list-item').first().click();
  await setState({scenario:'normal'});
  const initialVoice=await (await page.request.get(base+'/api/robot/preset-voice/status')).json();
  if(initialVoice.listening){await page.waitForFunction(()=>!document.querySelector('[data-action=unlisten]').disabled);await action('unlisten').click();await page.waitForFunction(()=>document.querySelector('[data-p=mic-state]')?.textContent==='청취 종료');}
  if(!await source.locator('[data-detection-field=object_source][value=saved]').isChecked()){
   await source.locator('[data-detection-field=object_source][value=saved]').check();await action('save').click();await waitSaved();
  }
  assert.equal(await source.locator('[data-detection-field=object_source][value=saved]').isChecked(),true);
  const id=new URL(page.url()).searchParams.get('preset');
  const before=await (await page.request.get(base+'/api/robot/presets/'+id)).json();
  await source.locator('[data-detection-field=object_source][value=yolo]').check();
  await source.locator('[data-detection-field=class_id] option[value="0"]').waitFor({state:'attached'});
  await source.locator('[data-detection-field=class_id]').selectOption('0');
  assert.equal(await source.locator('[data-detection-field=min_confidence]').inputValue(),'0.8');
  assert.equal(await root.locator('[data-field^="context.virtual.floor.center_base_mm"]').count(),0);
  assert.equal(await root.locator('[data-field="context.virtual.floor.size_mm.2"]').count(),1);
  await root.locator('[data-field=voice_enabled]').check();await root.locator('[data-p=aliases]').fill('로봇 비전 포장');
  await action('save').click();await waitSaved();
  assert.equal(await action('play').isDisabled(),true);
  await capture();await source.locator('[data-detection-candidate][aria-pressed=true]').waitFor();
  await page.waitForFunction(()=>!document.querySelector('[data-action=play]').disabled);
  assert.match(await source.locator('.preset-detection-readings').textContent(),/40.00 × 40.00/);
  const persisted=await (await page.request.get(base+'/api/robot/presets/'+id)).json();
  assert.deepEqual(persisted.context.virtual,before.context.virtual);
  assert.equal(persisted.object_source,'yolo');assert.equal(persisted.yolo.class_id,0);
  const grasp=root.locator('[data-node-field="2:0.kind"]');assert.equal(await grasp.isDisabled(),true);
  await action('hardware').click();await page.waitForFunction(()=>document.querySelector('[data-p=message]')?.textContent.includes('실제 명령 차단'));
  assert.ok(hardware[0].body.snapshot_id&&hardware[0].body.candidate_id);assert.equal('pose' in hardware[0].body,false);
  await source.locator('[data-detection-action=prepare]').click();await page.waitForFunction(()=>document.querySelector('[data-p=message]')?.textContent.includes('실제 명령 차단'));
  assert.ok(hardware.some(item=>item.path.endsWith('recognition-preview')));
  await setState({scenario:'multiple'});await capture();
  assert.equal(await source.locator('[data-detection-candidate]').count(),2);
  assert.equal(await source.locator('[aria-pressed=true]').count(),0);assert.equal(await action('play').isDisabled(),true);
  await source.locator('[data-detection-candidate]').last().click();await page.waitForFunction(()=>!document.querySelector('[data-action=play]').disabled);
  await source.locator('[data-detection-field=min_confidence]').selectOption('1');
  assert.equal(await source.locator('[data-detection-candidate]').count(),0);assert.equal(await action('play').isDisabled(),true);
  await action('discard').click();await waitSaved();
  for(const state of ['none','offline']){
   await setState({scenario:state});await capture();assert.equal(await source.locator('[data-detection-candidate]').count(),0);assert.equal(await action('play').isDisabled(),true);
  }
  await setState({scenario:'multiple'});
  await root.locator('[data-p=text]').fill('로봇 비전 포장');await action('text-test').click();
  await root.locator('[data-action=text-select]').first().waitFor();
  assert.equal(await action('test-play').isDisabled(),true);await root.locator('[data-action=text-select]').first().click();
  await page.waitForFunction(()=>!document.querySelector('[data-action=test-play]').disabled);
  const voiceBefore=await (await page.request.get(base+'/api/robot/preset-voice/status')).json();assert.equal(voiceBefore.pending,null);assert.equal(voiceBefore.selection,null);
  await root.locator('[data-p=text]').fill('로봇 실행');await action('text-test').click();await page.waitForFunction(()=>document.querySelector('[data-p=test-result]')?.textContent.includes('공통 제어'));
  await root.locator('[data-p=voice-target]').selectOption('simulation');await action('listen').click();await page.waitForFunction(()=>document.querySelector('[data-p=mic-state]')?.textContent.includes('연속 대기'));
  await setState({text:'로봇 비전 포장'});
  await root.locator('[data-action=voice-select]').first().waitFor();
  assert.equal(await root.locator('[data-action=voice-approve]').count(),0);
  await root.locator('[data-action=voice-select]').first().click();await root.locator('[data-action=voice-approve]').waitFor();
  assert.match(await root.locator('[data-p=voice-pending]').textContent(),/YOLO 대상/);
  await root.locator('[data-action=voice-approve]').click();await page.waitForFunction(()=>['planning','running'].includes(document.querySelector('[data-arm=canvas]')?.dataset.simulation));
  await page.locator('#robot-global-stop').click();
  await page.waitForFunction(()=>!['planning','running','paused'].includes(document.querySelector('[data-arm=canvas]')?.dataset.simulation));
  const statusWaiting=new Promise(resolve=>{statusHeld=resolve;});holdNextVoiceStatus=true;await statusWaiting;
  await action('unlisten').click();await page.waitForFunction(()=>document.querySelector('[data-p=mic-state]')?.textContent==='청취 종료');
  releaseStatus();await page.waitForTimeout(200);
  assert.equal(await root.locator('[data-p=mic-state]').textContent(),'청취 종료');assert.equal(await action('listen').isDisabled(),false);
  await root.locator('[data-p=voice-target]').selectOption('hardware');
  const startingHardware=page.waitForResponse(r=>r.url().endsWith('/preset-voice/start'));
  await action('listen').click();await startingHardware;await page.waitForFunction(()=>document.querySelector('[data-p=mic-state]')?.textContent.includes('연속 대기'));
  await setState({text:'로봇 비전 포장'});await root.locator('[data-action=voice-prepare]').waitFor();
  const prepCount=hardware.filter(item=>item.path.endsWith('recognition-preview')).length;
  const preparationResponse=page.waitForResponse(r=>r.url().endsWith('/recognition-preview'));
  await root.locator('[data-action=voice-prepare]').click();
  await preparationResponse;
  assert.equal(hardware.filter(item=>item.path.endsWith('recognition-preview')).length,prepCount+1);
  await action('unlisten').click();await page.waitForFunction(()=>document.querySelector('[data-p=mic-state]')?.textContent==='청취 종료');
  await setState({scenario:'normal'});await capture();await page.waitForFunction(()=>!document.querySelector('[data-action=play]').disabled);
  await source.screenshot({path:'/private/tmp/preset-yolo-desktop.png'});
  await page.reload();await source.locator('[data-detection-field=object_source][value=yolo]').waitFor();
  assert.equal(await source.locator('[data-detection-field=object_source][value=yolo]').isChecked(),true);
  assert.equal(await source.locator('[data-detection-candidate]').count(),0);assert.equal(await action('play').isDisabled(),true);
  await page.setViewportSize({width:390,height:844});await capture();await page.waitForFunction(()=>!document.querySelector('[data-action=play]').disabled);
  assert.equal(await page.locator('.plane-editor').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
  await source.screenshot({path:'/private/tmp/preset-yolo-mobile.png'});
  assert.deepEqual(errors,[]);assert.equal(hardware.filter(item=>item.path.includes('executions/approve')).length,0);
  console.log('PASS: source persistence, class/confidence filters, automatic/manual targets, locked joints, hardware/preparation payloads, no match/offline, isolated sentence tests, voice selection+approval+simulation+stop+preparation, reload, desktop/mobile. Hardware intercepted; camera and ASR are fixtures.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
