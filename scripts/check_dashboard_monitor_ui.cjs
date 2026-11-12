// :8014 synthetic sensors and empty robot only. No physical or microphone commands.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--disable-background-networking']});try{
 const base='http://127.0.0.1:8014',page=await browser.newPage({viewport:{width:1600,height:1100},colorScheme:'dark'}),errors=[],writes=[];let voiceOffline=false;
 page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const r=route.request(),u=new URL(r.url());assert.equal(u.origin,base);
  if(voiceOffline&&u.pathname==='/api/voice/history')return route.fulfill({status:503,json:{detail:'QA voice unavailable'}});
  if(r.method()!=='GET'&&!(r.method()==='POST'&&/^\/api\/robot\/presets\/[^/]+\/preview$/.test(u.pathname))){writes.push(r.method()+' '+u.pathname);return route.abort();}
  if(r.method()==='GET')return route.continue();
  return route.fulfill({response:await route.fetch({headers:{...r.headers(),origin:'http://localhost:8080','sec-fetch-site':'same-origin'}})});
 });
 const action=name=>page.locator(`[data-monitor="${name}"]`),qa=async data=>{const r=await page.request.post(base+'/__qa/state',{data});assert.ok(r.ok(),await r.text());};
 await page.goto(base+'/#dashboard');await page.waitForFunction(()=>!document.querySelector('[data-monitor=play]')?.disabled);
 await page.locator('[data-depth=image]:visible').waitFor();await page.waitForFunction(()=>document.querySelectorAll('.dashboard-chat-turn').length===2);
 const robot=await page.locator('.dashboard-robot').boundingBox(),chat=await page.locator('.dashboard-conversation').boundingBox(),cameras=await page.locator('.dashboard-cameras').boundingBox(),lower=await page.locator('.dashboard-lower-grid').boundingBox();
 assert.ok(chat.x>robot.x&&Math.abs(chat.y-robot.y)<2);assert.ok(cameras.y>robot.y&&lower.y>cameras.y);
 assert.match(await page.locator('[data-depth=sync]').textContent(),/컬러 좌표에 정렬/);
 await page.locator('[data-depth=image]').click({position:{x:130,y:100}});await page.waitForFunction(()=>document.querySelector('[data-depth=value]').textContent.includes('0.740 m'));
 assert.match(await page.locator('[data-depth=value]').textContent(),/프레임 #/);
 await page.locator('[data-dashboard=rate]').selectOption('20');await action('play').click();
 await page.waitForFunction(()=>document.querySelector('#dashboard-monitor').dataset.simulationState==='running');assert.equal(await action('play').isDisabled(),true);
 assert.match(await page.locator('[data-dashboard=reason]').textContent(),/진행 중/);await action('pause').click();await page.waitForFunction(()=>document.querySelector('#dashboard-monitor').dataset.simulationState==='paused');
 const pausedStep=Number((await page.locator('[data-dashboard=step-count]').textContent()).split('/')[0]);await action('next').click();await page.waitForFunction(step=>document.querySelector('[data-dashboard=step-count]').textContent.startsWith(step+' /'),pausedStep+1);
 await page.locator('[data-dashboard=progress]').fill('500');assert.equal(await action('path').isEnabled(),true);await action('path').click();assert.equal(await action('path').getAttribute('aria-pressed'),'false');
 await action('pause').click();await page.waitForFunction(()=>['complete','error'].includes(document.querySelector('#dashboard-monitor').dataset.simulationState),null,{timeout:60000});
 assert.equal(await page.locator('#dashboard-monitor').getAttribute('data-simulation-state'),'complete',await page.locator('[data-dashboard=stage]').textContent());
 assert.match(await page.locator('[data-dashboard=step-count]').textContent(),/17 \/ 17/);await action('sim-stop').click();
 await qa({text:'<img src=x onerror=alert(1)> 음성 인식',robot_text:'로봇 안내 · 대시보드 수신 확인'});
 await page.waitForFunction(()=>document.querySelectorAll('.dashboard-chat-turn').length===4);assert.equal(await page.locator('.dashboard-chat-turn img').count(),0);assert.match(await page.locator('.dashboard-chat-log').textContent(),/로봇 안내 · 대시보드 수신 확인/);
 voiceOffline=true;await page.waitForFunction(()=>document.querySelector('[data-conversation=notice]').textContent.includes('이미 받은 대화'));
 assert.equal(await page.locator('.dashboard-chat-turn').count(),4);voiceOffline=false;
 await qa({disconnect:true});await page.waitForFunction(()=>document.querySelector('.dashboard-depth-image').dataset.stale==='true'&&!document.querySelector('[data-depth=last]').hidden);
 assert.match(await page.locator('[data-depth=value]').textContent(),/갱신 없음/);await qa({disconnect:false});await page.locator('[data-depth=image]:visible').waitFor();
 await qa({depth:false});await page.waitForFunction(()=>document.querySelector('[data-depth=state]').textContent.includes('지원 안 함'));await qa({depth:true});await page.locator('[data-depth=image]:visible').waitFor();
 await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.dashboard-chat-turn').length===4);await page.waitForFunction(()=>!document.querySelector('[data-monitor=play]').disabled);
 await page.locator('[data-dashboard=preset]').selectOption({label:'모듈 파지·놓기'});await page.waitForFunction(()=>!document.querySelector('[data-monitor=play]').disabled);await action('play').click();
 await page.waitForFunction(()=>['complete','error'].includes(document.querySelector('#dashboard-monitor').dataset.simulationState),null,{timeout:60000});assert.equal(await page.locator('#dashboard-monitor').getAttribute('data-simulation-state'),'complete');assert.match(await page.locator('[data-dashboard=step-count]').textContent(),/9 \/ 9/);await action('sim-stop').click();
 await page.locator('[data-dashboard=preset]').selectOption({label:'좌표 입력 전'});await page.waitForFunction(()=>document.querySelector('[data-dashboard=reason]').textContent.includes('목표 좌표'));assert.equal(await action('play').isDisabled(),true);
 fs.mkdirSync('.cache/dashboard-monitor-ui',{recursive:true});
 for(const width of [1600,1024,768,390,320]){await page.setViewportSize({width,height:1100});await page.waitForTimeout(80);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'overflow at '+width);if([1600,390].includes(width))await page.screenshot({path:'.cache/dashboard-monitor-ui/dark-'+width+'.png',fullPage:true});}
 await page.setViewportSize({width:1600,height:1100});await page.emulateMedia({colorScheme:'light'});await page.screenshot({path:'.cache/dashboard-monitor-ui/light-1600.png',fullPage:true});
 await page.getByRole('button',{name:'상세 ↗',exact:true}).click();await page.waitForURL('**/#orders');await page.waitForTimeout(250);
 assert.equal(await page.locator('#dashboard-monitor').count(),0);await page.goto(base+'/#dashboard');await page.waitForFunction(()=>document.querySelectorAll('.dashboard-chat-turn').length===4);
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 console.log('PASS: workflow layout; shared E0509 renderer, full 17-stage and variable 9-stage offline playback/pause/step/seek/path toggle; missing-target reasons; RGB + aligned Depth and frame-bound metric pick; sensor recovery; persistent packing/robot chat, escaped transcript, outage retention; navigation cleanup; dark/light and 320–1600px. No SDK, storage or microphone commands.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
