// Only tests.preset_yolo_qa on :8012. Camera, ASR and SDK are isolated fixtures.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--disable-background-networking']});
 try{
  const base='http://127.0.0.1:8012',page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[],hardware=[];
  page.setDefaultTimeout(15000);if(process.env.QA_TRACE)page.on('request',r=>{if(r.url().includes('preset-voice/')&&r.method()==='POST')console.log(new URL(r.url()).pathname,r.postData());});page.on('pageerror',e=>errors.push(e.message));
  await page.routeWebSocket('**/ws/detections*',socket=>socket.close());
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());assert.equal(url.origin,base);
   if(/execution-preview|recognition-preview|executions\/approve/.test(url.pathname)){
    hardware.push(url.pathname);return route.fulfill({status:503,json:{detail:'UI 검증 · 실제 명령 차단'}});
   }
   return route.fulfill({response:await route.fetch({headers:{...request.headers(),origin:'http://localhost:8080'}})});
  });
  const state=async data=>assert.equal((await page.request.post(base+'/__qa/state',{data})).status(),200);
  const voice=async()=>await(await page.request.get(base+'/api/robot/preset-voice/status')).json();
  await page.goto(base+'/robot#work-points-title');
  const root=page.locator('#scenario-editor'),action=name=>root.locator('[data-action="'+name+'"]'),source=root.locator('[data-p=object-source]'),gate=root.locator('[data-p=class-gate]');
  const waitSaved=()=>page.waitForFunction(()=>document.querySelector('[data-p=saved]')?.textContent==='저장됨');
  const waitClass=()=>page.waitForFunction(()=>document.querySelector('[data-p=class-gate]')?.textContent.includes('클래스 이름을 말씀하세요'));
  const waitMessage=text=>page.waitForFunction(t=>document.querySelector('[data-p=voice-message]')?.textContent.includes(t),text);
  await page.waitForFunction(()=>document.querySelector('[data-p=list] button'));
  if((await voice()).can_stop){await action('unlisten').click();await page.waitForFunction(()=>document.querySelector('[data-p=mic-state]')?.textContent==='청취 종료');}
  await root.locator('.preset-list-item').first().click();await state({scenario:'normal',model_version:'qa-yolo'});
  const id=new URL(page.url()).searchParams.get('preset'),before=await(await page.request.get(base+'/api/robot/presets/'+id)).json();
  await source.locator('[data-detection-field=object_source][value=yolo]').check();
  assert.equal(await source.locator('[data-detection-field=class_id]').count(),0);
  await source.locator('.preset-class-list').filter({hasText:'테스트 상품'}).waitFor();
  assert.equal(await root.locator('[data-field^="context.virtual.floor.center_base_mm"]').count(),0);
  await root.locator('.preset-voice-binding > summary').click();await root.locator('[data-field=voice_enabled]').check();await root.locator('[data-p=aliases]').fill('로봇 비전 포장');
  await action('save').click();await waitSaved();await page.waitForFunction(()=>!document.querySelector('[data-action=play]').disabled);
  assert.equal(await root.locator('.preset-player .preset-voice-console').count(),1);
  const persisted=await(await page.request.get(base+'/api/robot/presets/'+id)).json();
  assert.deepEqual(persisted.context.virtual,before.context.virtual);
  await action('play').click();await waitClass();await action('class-retry').focus();await page.waitForTimeout(1500);assert.equal(await page.evaluate(()=>document.activeElement.dataset.action),'class-retry');assert.match(await gate.textContent(),/테스트 상품.*다른 상품/s);
  for(const text of ['테스트 상픔','테스트 상품 다른 상품']){await state({text});await waitMessage('한 개만');assert.equal((await voice()).pending,null);}
  await state({text:'로봇 실행'});await waitMessage('먼저 선택');assert.equal(await gate.isVisible(),true);
  await state({scenario:'multiple'});await state({text:'테스트 상품'});
  await root.locator('[data-action=voice-select]').first().waitFor();assert.equal(await root.locator('[data-action=voice-approve]').count(),0);
  await root.locator('[data-action=voice-select]').last().click();await root.locator('[data-action=voice-approve]').waitFor();
  assert.match(await root.locator('[data-p=voice-pending]').textContent(),/YOLO 대상/);
  const pending=(await voice()).pending.approval_id;
  await root.locator('.preset-command-tests > summary').click();await root.locator('[data-p=text]').fill('로봇 비전 포장');await root.locator('[data-p=test-class]').fill('테스트 상품');await action('text-test').click();
  await root.locator('[data-action=text-select]').first().waitFor();await root.locator('[data-action=text-select]').first().click();
  await page.waitForFunction(()=>!document.querySelector('[data-action=test-play]').disabled);
  assert.equal((await voice()).pending.approval_id,pending);
  await root.locator('[data-action=voice-approve]').click();await page.waitForFunction(()=>['planning','running'].includes(document.querySelector('[data-arm=canvas]')?.dataset.simulation));
  await page.locator('#robot-global-stop').click();await page.waitForFunction(()=>!['planning','running','paused'].includes(document.querySelector('[data-arm=canvas]')?.dataset.simulation));
  await state({scenario:'none'});await action('play').click();await waitClass();await state({text:'테스트 상품'});await waitMessage('대상이 없습니다');assert.equal((await voice()).pending,null);
  await state({scenario:'normal'});await action('class-retry').click();await waitClass();await state({text:'테스트 상품'});await root.locator('[data-action=voice-approve]').waitFor();
  await action('voice-cancel').first().click();await gate.waitFor({state:'hidden'});assert.equal((await voice()).pending,null);
  await action('play').click();await waitClass();await state({model_version:'qa-yolo-new'});await waitMessage('모델 또는 클래스 목록');await gate.waitFor({state:'hidden'});
  await state({model_version:'qa-yolo'});await action('unlisten').click();await root.locator('[data-p=voice-target]').selectOption('hardware');await action('play').click();await page.waitForFunction(()=>document.querySelector('[data-p=class-gate]')?.textContent.includes('실제 로봇'));assert.match(await gate.textContent(),/실제 로봇/);
  await state({text:'테스트 상품'});await action('voice-prepare').waitFor();
  await action('voice-prepare').click();await page.waitForFunction(()=>document.querySelector('[data-p=message]')?.textContent.includes('실제 명령 차단'));
  assert.equal(hardware.filter(p=>p.endsWith('recognition-preview')).length,1);
  await action('unlisten').click();await gate.waitFor({state:'hidden'});
  await action('play').click();await waitClass();await root.locator('.preset-player').screenshot({path:'/private/tmp/preset-voice-class-desktop.png'});
  for(const width of [736,390,320]){
   await page.setViewportSize({width,height:1000});
   assert.equal(await root.locator('.preset-player').evaluate(el=>el.scrollWidth>el.clientWidth+1),false,'execution overflow at '+width);
  }
  await root.locator('.preset-player').screenshot({path:'/private/tmp/preset-voice-class-mobile.png'});
  await action('unlisten').click();await gate.waitFor({state:'hidden'});
  await page.reload();await source.locator('[data-detection-field=object_source][value=yolo]').waitFor();
  assert.equal(await source.locator('[data-detection-field=object_source][value=yolo]').isChecked(),true);assert.equal(await gate.isVisible(),false);
  assert.deepEqual(await(await page.request.get(base+'/api/robot/presets/'+id)).json(),persisted);
  await source.locator('[data-detection-field=object_source][value=saved]').check();await action('save').click();await waitSaved();
  assert.deepEqual(errors,[]);assert.equal(hardware.filter(p=>p.endsWith('executions/approve')).length,0);
  console.log('PASS: integrated voice class gate, allowlist, invalid/multiple words, no bypass, object selection, isolated text test, simulation+stop, no match, retry, cancel, model change, hardware preparation, persistence, 1440/736/390/320px. No real SDK/audio/camera.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
