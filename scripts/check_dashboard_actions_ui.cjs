// Full app on isolated :8014: fake audio helper, synthetic camera, no SDK connection.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--disable-background-networking']});try{
 const base='http://127.0.0.1:8014',page=await browser.newPage({viewport:{width:1600,height:1100},colorScheme:'dark'}),errors=[],forbidden=[];
 page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));let heldPreview=false,releasePreview=null,previewCaptured=false;
 const headers={origin:'http://localhost:8080','sec-fetch-site':'same-origin'};
 const api=async(path,method='GET',data)=>{const r=await page.request.fetch(base+path,{method,data,headers});assert.ok(r.ok(),path+' '+await r.text());return r.json();};
 const qa=data=>api('/__qa/state','POST',data);
 const until=async(fn)=>{for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,40));}throw Error('API condition not reached');};
 await page.route('**/*',async route=>{const r=route.request(),u=new URL(r.url());assert.equal(u.origin,base);
  const allowed=u.pathname.startsWith('/api/robot/preset-voice/')||u.pathname==='/api/robot/stop'||u.pathname==='/api/robot/pick/scenario/preview'||/^\/api\/robot\/presets\/[^/]+\/preview$/.test(u.pathname)||['/api/voice/wake','/api/voice/stop','/api/camera/select','/api/camera/start','/api/packing/command'].includes(u.pathname)||/^\/api\/packing\/orders\/123\/items\/[^/]+\/complete$/.test(u.pathname);
  if(r.method()!=='GET'&&!allowed){forbidden.push(r.method()+' '+u.pathname);return route.abort();}
  if(heldPreview&&/^\/api\/robot\/presets\/[^/]+\/preview$/.test(u.pathname)){previewCaptured=true;await new Promise(resolve=>releasePreview=resolve);heldPreview=false;}
  if(r.method()==='GET')return route.continue();
  return route.fulfill({response:await route.fetch({headers:{...r.headers(),...headers}})});
 });
 const action=name=>page.locator(`[data-monitor="${name}"]`),voice=name=>page.locator(`[data-voice-action="${name}"]`),mode=page.locator('[data-vc=mode]');
 const choose=async name=>{await page.locator('[data-dashboard=preset]').selectOption({label:name});await page.waitForFunction(()=>!document.querySelector('[data-dashboard=preset]').disabled);};
 const listening=()=>until(async()=>(await api('/api/voice/status')).state==='listening');
 const speak=async text=>{await listening();await qa({utterance:text});};
 const pending=()=>page.locator('.dashboard-voice-pending').waitFor();
 const finish=async expected=>{await page.waitForFunction(()=>['complete','error'].includes(document.querySelector('#dashboard-monitor').dataset.simulationState),null,{timeout:60000});assert.equal(await page.locator('#dashboard-monitor').getAttribute('data-simulation-state'),'complete',await page.locator('[data-dashboard=stage]').textContent());assert.match(await page.locator('[data-dashboard=step-count]').textContent(),new RegExp(expected+' / '+expected));await action('sim-stop').click();};
 await page.goto(base+'/#dashboard');await page.waitForFunction(()=>!document.querySelector('[data-voice-action=start]').disabled);await page.locator('[data-camera=image]:visible').waitFor();
 // Native final-event pipeline: fake helper -> Voice -> intent -> stock -> chat.
 await voice('start').click();await listening();assert.equal((await api('/api/voice/status')).context,'packing');
 await speak('재고 조회해줘');await page.waitForFunction(()=>document.querySelector('[data-conversation=log]').textContent.includes('주문 가능합니다.'));
 await voice('stop').click();await until(async()=>!(await api('/api/voice/status')).can_stop);await page.waitForFunction(()=>!document.querySelector('[data-vc=mode]').disabled);
 // Existing command buttons now also publish their real replies to the chat.
 await page.getByRole('button',{name:'주문·재고 명령',exact:true}).click();await page.locator('#voice-panel [data-action=query-order]').click();
 await page.waitForFunction(()=>[...document.querySelectorAll('.dashboard-chat-meta')].some(el=>el.textContent.includes('버튼 입력')));
 await page.locator('#voice-panel [data-action=voice]').click();
 const packing=await api('/api/packing');await page.locator('.dashboard-lower-grid [data-action=toggle]').click();await until(async()=>(await api('/api/packing')).orders.find(o=>o.number===123).paused);
 await page.locator('.dashboard-lower-grid [data-action=toggle]').click();await until(async()=>!(await api('/api/packing')).orders.find(o=>o.number===123).paused);
 await page.locator('.dashboard-lower-grid [data-action^=place-]').click();await until(async()=>(await api('/api/packing')).orders.find(o=>o.number===123).items.filter(i=>i.done).length===1);
 // A usable 17-stage demo stays separate from an incomplete saved preset.
 await choose('좌표 입력 전');assert.equal(await action('play').isDisabled(),true);await page.locator('[data-dashboard=rate]').selectOption('20');await action('demo').click();
 for(let i=0;i<3;i++){await page.waitForFunction(()=>['awaiting_grip','awaiting_open','complete','error'].includes(document.querySelector('#dashboard-monitor').dataset.simulationState),null,{timeout:60000});const state=await page.locator('#dashboard-monitor').getAttribute('data-simulation-state');if(state==='complete'||state==='error')break;await action('confirm').click();}
 await finish(17);assert.equal(await page.locator('[data-dashboard=preset] option:checked').textContent(),'좌표 입력 전');assert.equal(await action('play').isDisabled(),true);
 // A registered spoken preset can be approved and rendered on this same page.
 await choose('음성 대기 테스트');await mode.selectOption('robot');await voice('start').click();await listening();assert.equal((await api('/api/voice/status')).context,'robot');
 await speak('등록되지 않은 문장');await until(async()=>!(await api('/api/robot/preset-voice/status')).pending);await speak('로봇 테스트 대기');await pending();await voice('approve').click();
 await page.waitForFunction(()=>!!document.querySelector('#dashboard-monitor').dataset.voiceSimulationId);await finish(1);
 // A saved route with no alias is still explicitly preparable; cancellation/expiry work.
 await choose('모듈 파지·놓기');await voice('prepare').click();await pending();await voice('cancel').click();await page.locator('.dashboard-voice-pending').waitFor({state:'detached'});
 await voice('prepare').click();await pending();await qa({expire:true});await page.locator('.dashboard-voice-pending').waitFor({state:'detached'});assert.equal((await api('/api/robot/preset-voice/status')).simulation,null);
 // YOLO class input is constrained to the active model and selects detected objects.
 await choose('YOLO screen');await voice('prepare').click();await page.locator('.dashboard-voice-classes').waitFor();assert.match(await page.locator('.dashboard-voice-classes').textContent(),/테스트 상품/);
 await speak('없는 클래스');await until(async()=>(await api('/api/robot/preset-voice/status')).class_request?.phase==='class');await speak('테스트 상품');await pending();await voice('approve').click();await finish(9);
 await qa({multiple:true});await voice('prepare').click();await page.locator('.dashboard-voice-classes').waitFor();await speak('테스트 상품');await voice('select').first().waitFor();assert.equal(await voice('select').count(),2);await voice('select').first().click();await pending();await voice('cancel').click();await qa({multiple:false});
 await choose('YOLO voice');await voice('prepare').click();await page.locator('.dashboard-voice-classes').waitFor();await speak('테스트 상품');await pending();assert.equal(await voice('approve').isDisabled(),true);await speak('로봇 실행');await finish(9);
 // Approval arriving while preview is in flight must not be silently dropped.
 await choose('음성 대기 테스트');await voice('prepare').click();await pending();heldPreview=true;await action('reload').click();await until(async()=>previewCaptured);
 await voice('approve').click();await until(async()=>!!(await api('/api/robot/preset-voice/status')).simulation);releasePreview();await finish(1);
 await voice('stop').click();await until(async()=>!(await api('/api/voice/status')).can_stop);
 // Every camera control operates on the real runtime API, with synthetic sensors here.
 await page.locator('[data-camera=refresh]').click();await page.waitForFunction(()=>!document.querySelector('[data-camera=device]').disabled);assert.equal(await page.locator('[data-camera=device] option:not([value=""])').count(),2);
 await page.locator('[data-camera=mode]').selectOption('color');await page.locator('[data-camera=image]:visible').waitFor();await page.locator('[data-camera=mode]').selectOption('detections');
 await page.locator('[data-camera=device]').selectOption('qa-rgb-camera');await page.locator('[data-camera=apply]').click();await page.waitForFunction(()=>document.querySelector('[data-depth=state]').textContent.includes('지원 안 함'));
 await page.locator('[data-camera=device]').selectOption('qa-depth-camera');await page.locator('[data-camera=apply]').click();await page.locator('[data-depth=image]:visible').waitFor();await page.locator('[data-depth=image]').click({position:{x:120,y:100}});await page.waitForFunction(()=>document.querySelector('[data-depth=value]').textContent.includes('0.740 m'));
 await api('/api/camera/stop','POST',{});await page.waitForFunction(()=>document.querySelector('[data-camera=apply]').textContent==='탐지 시작');await page.locator('[data-camera=apply]').click();await page.locator('[data-camera=image]:visible').waitFor();
 await choose('좌표 입력 전');await action('demo').click();await page.waitForFunction(()=>document.querySelector('#dashboard-monitor').dataset.simulationState==='running');await page.locator('#robot-global-stop').click();await page.waitForFunction(()=>document.querySelector('#dashboard-monitor').dataset.simulationState==='idle');
 fs.mkdirSync('.cache/dashboard-actions-ui',{recursive:true});for(const width of [1600,1024,768,390,320]){await page.setViewportSize({width,height:1100});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'overflow '+width);if(width===1600||width===390)await page.screenshot({path:'.cache/dashboard-actions-ui/dashboard-'+width+'.png',fullPage:true});}
 assert.deepEqual(errors,[]);assert.deepEqual(forbidden,[]);
 console.log('PASS: complete dashboard interaction audit: stock/order final speech pipeline and chat; button replies, pause/resume/place inventory; independent 17-stage demo and confirmations; robot listening, registered/one-off paths, screen approval, cancellation/expiry; YOLO class restriction, candidate selection and fresh voice confirmation; delayed-preview approval; camera refresh/mode/select/restart, frame-bound Depth; global stop; 320–1600px. Real audio helper and SDK are never used by this fixture.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
