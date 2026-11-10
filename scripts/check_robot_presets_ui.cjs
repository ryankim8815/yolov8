// Use a temporary robot-web on :8012 with ROS disabled. Hardware/audio commands are blocked.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--disable-background-networking']});
 try{
  const page=await browser.newPage({viewport:{width:1400,height:1000}}),base='http://127.0.0.1:8012',errors=[],commands=[];
  let executionDelay=0,fakeBusy=false,fakeApproval=false;
  page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  await page.routeWebSocket('**/ws/detections*',socket=>socket.close());
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());assert.equal(url.origin,base);
   if(url.pathname.includes('execution-preview')||url.pathname.endsWith('/executions/approve')||url.pathname==='/api/robot/preset-voice/start'){
    if(executionDelay)await new Promise(resolve=>setTimeout(resolve,executionDelay));
    commands.push(url.pathname);
    if(fakeApproval&&url.pathname.includes('execution-preview')){
     const response=await route.fetch({url:request.url().replace('execution-preview','preview'),headers:{...request.headers(),origin:'http://localhost:8080'}}),recipe=await response.json();
     return route.fulfill({status:200,json:{approval_id:'mock-approval',name:recipe.name,total_steps:recipe.steps.length,steps:recipe.steps,tcp_name:'QA',expires_in:30}});
    }
    if(fakeApproval&&url.pathname.endsWith('/executions/approve'))return route.fulfill({status:202,json:{state:'completed',message:'모의 실행 완료'}});
    return route.fulfill({status:503,json:{detail:'격리 모드 · 실제 장치 연결 없음'}});
   }
   if(url.pathname.startsWith('/api/robot/')&&request.method()!=='GET')assert.ok(url.pathname.startsWith('/api/robot/presets')||url.pathname.startsWith('/api/robot/preset-voice/test')||url.pathname==='/api/robot/stop'||url.pathname==='/api/robot/pick/cancel',url.pathname);
   const response=await route.fetch({headers:{...request.headers(),origin:'http://localhost:8080'}});
   if(url.pathname==='/api/robot/preset-voice/status')return route.fulfill({response,json:{...await response.json(),busy:fakeBusy}});
   return route.fulfill({response});
  });
  await page.goto(base+'/robot#work-points-title');
  const runName='검증 경로 '+Date.now(),command='로봇 '+runName;
  const root=page.locator('#scenario-editor'),action=name=>root.locator('[data-action="'+name+'"]');
  await page.waitForFunction(()=>document.querySelector('[data-p=list] button'));
  assert.equal(await root.locator('[role=tab], [role=tablist]').count(),0);
  await root.locator('[data-prepare-speed="0.0"]').selectOption('30');
  await action('discard').click();assert.equal(await root.locator('[data-prepare-speed="0.0"]').inputValue(),'100');
  await action('new').click();await page.waitForFunction(()=>document.querySelector('[data-field=name]')?.value==='새 이동 경로');
  await root.locator('[data-field=name]').fill(runName);
  for(const [j,value] of [0,0,90,0,90,0].entries())await root.locator('[data-joint="0.'+j+'"]').fill(String(value));
  await root.locator('[data-node-field="0.percent"]').selectOption('30');
  await root.locator('[data-p=kind]').selectOption('wait');await action('add').click();
  await root.locator('[data-node-field="1.seconds"]').fill('0.1');
  await root.locator('.preset-voice-binding > summary').click();
  await root.locator('[data-field=voice_enabled]').check();await root.locator('[data-p=aliases]').fill(command);
  await action('save').click();await page.waitForFunction(()=>document.querySelector('[data-p=message]')?.textContent.includes('저장했습니다'));
  assert.equal(await root.locator('[data-p=saved]').textContent(),'저장됨');
  // Copy common geometry only; the legacy box TCP must never become this preset's drop target.
  const presetId=new URL(page.url()).searchParams.get('preset');
  const beforeImport=await(await page.request.get(base+'/api/robot/presets/'+presetId)).json();
  await action('import-box').click();await action('save').click();
  await page.waitForFunction(()=>document.querySelector('[data-p=saved]')?.textContent==='저장됨');
  const afterImport=await(await page.request.get(base+'/api/robot/presets/'+presetId)).json();
  assert.deepEqual(afterImport.box_pose,beforeImport.box_pose);
  const commonBox=await(await page.request.get(base+'/api/robot/parcel-box')).json();
  assert.deepEqual(afterImport.box_size,commonBox.size_mm);assert.deepEqual(afterImport.box_center,commonBox.center_base_mm);
  assert.equal(await root.locator('td.preset-joints-held[colspan="6"]').count(),1);
  await page.waitForFunction(()=>!document.querySelector('[data-action=play]').disabled);
  // The row action follows the same simulation target and compiles only the selected node.
  await root.locator('[data-op=execute]').first().click();
  await page.waitForFunction(()=>document.querySelector('[data-arm=canvas]')?.dataset.simulation==='complete');
  assert.match(await root.locator('[data-p=simulation]').textContent(),/^1\/1/);assert.deepEqual(commands,[]);
  assert.equal(await page.locator('[data-arm=simulationPause],[data-arm=simulationStop]').filter({visible:true}).count(),0);
  await action('play').click();assert.equal(await root.locator('[data-p=voice-target]').count(),1);assert.equal(await root.locator('[data-op=execute]').first().isDisabled(),true);
  await page.waitForFunction(()=>document.querySelector('[data-arm=canvas]')?.dataset.simulation==='complete',null,{timeout:15000});
  assert.equal(await action('sim-stop').isDisabled(),true);
  await root.locator('[data-p=kind]').selectOption('grasp');await action('add').click();
  await page.waitForFunction(()=>document.querySelectorAll('#scenario-editor [data-preset-step]').length===7);
  const locked=root.locator('[data-node-field="2:0.kind"]');assert.equal(await locked.isDisabled(),true);
  await root.locator('.preset-node-menu').nth(2).locator('summary').click();await root.locator('[data-op=up][data-index="2"]').click();await page.waitForTimeout(400);
  await root.locator('.preset-node-menu').nth(1).locator('summary').click();await root.locator('[data-op=delete][data-index="1"]').click();
  await root.locator('.preset-node-menu').nth(1).locator('summary').click();await root.locator('[data-op=copy][data-index="1"]').click();
  assert.equal(await root.locator('[data-preset-step]').count(),3);
  const ids=await root.locator('[data-preset-step]').evaluateAll(rows=>rows.map(r=>r.dataset.presetStep));assert.equal(new Set(ids).size,3);
  await root.locator('.preset-node-menu').nth(2).locator('summary').click();await root.locator('[data-op=delete][data-index="2"]').click();await action('save').click();
  await page.waitForFunction(()=>document.querySelector('[data-p=message]')?.textContent.includes('저장했습니다'));
  await action('copy').click();await page.waitForFunction(name=>document.querySelector('[data-field=name]')?.value===name,runName+' 복사본');
  assert.equal(await root.locator('[data-field=voice_enabled]').isChecked(),false);assert.equal(await root.locator('[data-p=aliases]').inputValue(),'');
  await root.locator('[data-field=name]').fill('임시 수정');await action('discard').click();assert.equal(await root.locator('[data-field=name]').inputValue(),runName+' 복사본');
  const original=root.locator('.preset-list-item').filter({hasText:runName}).first();await original.click();
  await root.locator('.preset-command-tests > summary').click();
  await root.locator('[data-p=text]').fill(command);await action('text-test').click();
  await page.waitForFunction(()=>document.querySelector('[data-p=test-result]')?.textContent.includes('시뮬레이션 전용'));
  assert.equal(await action('test-play').isDisabled(),false);assert.deepEqual(commands,[]);
  await root.locator('[data-p=text]').fill('로봇 실행');await action('text-test').click();await page.waitForFunction(()=>document.querySelector('[data-p=test-result]')?.textContent.includes('공통 제어'));
  assert.equal(await page.locator('#manipulator-products-tab,#manipulator-poses-tab,.legacy-points').count(),0);
  await root.locator('[data-field="context.approaches.floor.distance_mm"]').fill('125');await action('save').click();
  await page.waitForFunction(()=>document.querySelector('[data-p=message]')?.textContent.includes('저장했습니다'));
  await page.reload();
  await page.waitForFunction(name=>document.querySelector('[data-field=name]')?.value===name,runName);
  assert.equal(await root.locator('[data-joint="0.2"]').inputValue(),'90');
  await root.locator('[data-p=kind]').selectOption('movec');await action('add').click();
  await root.locator('[data-node-field="2.space"]').selectOption('task');
  await root.locator('[data-step-details]').last().locator('summary').click();
  for(const [j,value] of [373,0,250,0,180,0].entries())await root.locator(`[data-node-value="2.target.${j}"]`).fill(String(value));
  for(const [j,value] of [370,15,260,0,180,0].entries())await root.locator(`[data-node-value="2.via_pose.${j}"]`).fill(String(value));
  await page.waitForTimeout(600);
  assert.equal(await root.locator('[data-step-details]').last().evaluate(el=>el.open),true);
  assert.equal(await root.locator('[data-node-value="2.via_pose.5"]').evaluate(el=>el===document.activeElement),true);
  await action('save').click();await page.waitForFunction(()=>document.querySelector('[data-p=saved]')?.textContent==='저장됨');
  await root.locator('[data-p=voice-target]').selectOption('hardware');executionDelay=800;await action('play').click();
  assert.equal(await root.locator('[data-node-value="2.target.0"]').isDisabled(),true);assert.equal(await action('reload').isDisabled(),true);
  await page.waitForFunction(()=>document.querySelector('[data-p=message]')?.textContent.includes('격리 모드'));executionDelay=0;
  fakeApproval=true;await action('play').click();await root.locator('[data-p=dialog]').waitFor({state:'visible'});
  executionDelay=800;await action('approve').click();
  assert.equal(await root.locator('[data-node-value="2.target.0"]').isDisabled(),true);
  await root.locator('[data-p=dialog]').waitFor({state:'hidden'});executionDelay=0;fakeApproval=false;
  fakeBusy=true;await page.waitForFunction(()=>document.querySelector('[data-node-value="2.target.0"]')?.disabled);
  assert.equal(await action('play').isDisabled(),true);assert.equal(await action('reload').isDisabled(),true);
  fakeBusy=false;await page.waitForFunction(()=>!document.querySelector('[data-node-value="2.target.0"]')?.disabled);
  await root.locator('.preset-node-menu').nth(2).locator('summary').click();await root.locator('[data-op=delete][data-index="2"]').click();await action('save').click();
  await page.waitForFunction(()=>document.querySelector('[data-p=saved]')?.textContent==='저장됨');
  await root.screenshot({path:'/private/tmp/robot-presets-desktop.png'});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('.plane-editor').evaluate(e=>e.scrollWidth>e.clientWidth+1),false);
  await root.screenshot({path:'/private/tmp/robot-presets-mobile.png'});
  assert.deepEqual(errors,[]);assert.equal(commands.length,3);assert.ok(commands.every(p=>p.includes('execution-preview')||p.endsWith('/executions/approve')));console.log('PASS: migration, groups, joint/TCP/arc cells, focus, speed, CRUD, inline product approach settings, common manual/voice target, text-only voice tests, playback, mocked approval, hardware exclusion, desktop/mobile; every hardware request was intercepted and no audio or SDK calls occurred.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
