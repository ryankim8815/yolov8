// Temporary :8012 fixture only; every device and microphone command is blocked.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--disable-background-networking']});
 try{
  const base='http://127.0.0.1:8012',context=await browser.newContext({viewport:{width:1440,height:1050},colorScheme:'dark'}),page=await context.newPage(),headers={origin:'http://localhost:8080'},errors=[],blocked=[];
  page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));let previewFailure=false;
  const api=async(method,path,data)=>{const r=await context.request.fetch(base+'/api/robot/'+path,{method,data,headers});assert.ok(r.ok(),await r.text());return r.json();};
  await page.routeWebSocket('**/*',s=>s.close());
  await page.route('**/*',async route=>{
   const r=route.request(),u=new URL(r.url());assert.equal(u.origin,base);
   if(u.pathname==='/api/status')return route.fulfill({status:503,json:{detail:'QA offline'}});
   if(previewFailure&&u.pathname.endsWith('/preview'))return route.fulfill({status:503,json:{detail:'QA 경로 서버 연결 실패'}});
   if(r.method()!=='GET'&&(!u.pathname.startsWith('/api/robot/presets')||/execution-preview|recognition-preview|executions\/approve/.test(u.pathname))){blocked.push(u.pathname);return route.abort();}
   return route.fulfill({response:await route.fetch({headers:{...r.headers(),...headers}})});
  });
  const action=name=>page.locator(`[data-action="${name}"]`),reason=page.locator('[data-p=play-disabled]');
  const open=async(p,count)=>{await page.goto(base+'/robot?preset='+p.id+'#work-points-title');await page.waitForFunction(n=>document.querySelectorAll('[data-preset-step]').length===n,count);};
  const save=async id=>{await action('save').click();await page.waitForFunction(()=>document.querySelector('[data-p=saved]').textContent==='저장됨'&&!document.querySelector('[data-action=reload]').disabled);return api('GET','presets/'+id);};
  const order=()=>page.locator('[data-p=steps] > tr[data-unit-id]').evaluateAll(rows=>rows.filter((r,i)=>!i||r.dataset.unitId!==rows[i-1].dataset.unitId).map(r=>r.dataset.unitId));
  const waitOrder=expected=>page.waitForFunction(expected=>{const rows=[...document.querySelectorAll('[data-p=steps] > tr[data-unit-id]')];return JSON.stringify(rows.filter((r,i)=>!i||r.dataset.unitId!==rows[i-1].dataset.unitId).map(r=>r.dataset.unitId))===JSON.stringify(expected);},expected);
  const seed=(await api('GET','presets')).presets[0];let p=await api('POST','presets/'+seed.id+'/copy',{revision:seed.revision});
  const initial=await api('POST','presets/'+p.id+'/preview',{});await open(p,17);
  // Every physical row, including both standby rows and all fixed module children, is named independently.
  const names=new Map();
  for(const [i,s] of initial.steps.entries()){
   const name=`단계 ${i+1} · 한글 사용자 이름`;names.set(s.id,name);
   await page.locator(`[data-preset-step="${s.id}"] .preset-step-name`).fill(name);
  }
  for(const [i,s] of p.steps.entries())if(['prepare','grasp','place','checkpoint'].includes(s.kind))await page.locator(`[data-node-field="${i}.name"]`).fill('사용자 묶음 '+i);
  p=await save(p.id);const renamed=await api('POST','presets/'+p.id+'/preview',{});
  assert.deepEqual(renamed.steps.map(s=>s.title),[...names.values()]);
  const motion=steps=>steps.map(({title,...s})=>s);assert.deepEqual(motion(renamed.steps),motion(initial.steps));
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('[data-preset-step]').length===17);
  for(const [id,name] of names)assert.equal(await page.locator(`[data-preset-step="${id}"] .preset-step-name`).inputValue(),name);
  assert.equal(await page.locator('[data-node-field="1.name"]').inputValue(),'사용자 묶음 1');
  // A mouse drag is tested for every independent kind across the module boundary.
  const free=await api('POST','presets',{name:'QA 개별 단계 순서',steps:[{kind:'prepare'},...['movej','movel','movec','gripper','wait','checkpoint'].map(kind=>({kind,name:kind,target:[0,0,90,0,90,0],opening_mm:50,seconds:.5,via_pose:[400,0,300,0,180,0]}))]});
  await open(free,7);let expected=free.steps.map(s=>s.id);
  for(const s of free.steps.slice(1)){
   const handle=page.locator(`[data-drag-id="${s.id}"]`);await handle.scrollIntoViewIfNeeded();const source=await handle.boundingBox();
   await page.mouse.move(source.x+source.width/2,source.y+source.height/2);await page.mouse.down();await page.mouse.move(source.x+source.width/2+12,source.y+source.height/2,{steps:3});
   const target=page.locator(`tr[data-unit-id="${expected[0]}"]`).first();await target.scrollIntoViewIfNeeded();const box=await target.boundingBox();
   await page.mouse.move(box.x+120,box.y+3,{steps:15});await page.mouse.move(box.x+121,box.y+3);await page.mouse.up();
   expected=expected.filter(id=>id!==s.id);expected.unshift(s.id);await waitOrder(expected);
   await page.waitForFunction(()=>document.querySelectorAll('[data-preset-step]').length===7);
   assert.equal(await page.locator('[data-module-kind=prepare]').count(),1);
   assert.equal(await page.locator('[data-calculation=standby] [draggable=true]').count(),0);
  }
  // Visible arrow controls offer the same reordering through the keyboard.
  const down=page.locator('[data-op=down][data-index="0"]');await down.focus();await page.keyboard.press('Enter');[expected[0],expected[1]]=[expected[1],expected[0]];await waitOrder(expected);
  const stored=await save(free.id);assert.deepEqual(stored.steps.map(s=>s.id),expected);
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('[data-preset-step]').length===7);assert.deepEqual(await order(),expected);
  // Missing data and server failures give actionable reasons beside the disabled button.
  const missing=await api('POST','presets',{name:'QA 입력 전 경로',steps:[{kind:'movej',name:'대상 위치'}]});await open(missing,1);
  await page.waitForFunction(()=>document.querySelector('[data-p=play-disabled]').textContent.includes('목표 좌표'));
  assert.equal(await action('play').isDisabled(),true);assert.equal(await action('play').getAttribute('aria-describedby'),'preset-play-disabled');
  fs.mkdirSync('.cache/preset-step-editing-ui',{recursive:true});await page.locator('#preset-execution').screenshot({path:'.cache/preset-step-editing-ui/missing-reason.png'});
  for(let j=0;j<6;j++)await page.locator(`[data-joint="0.${j}"]`).fill(String([0,0,90,0,90,0][j]));
  await page.waitForFunction(()=>!document.querySelector('[data-action=play]').disabled);assert.equal(await reason.isHidden(),true);
  previewFailure=true;await page.locator('[aria-label="1단계 이름"]').fill('연결 실패 확인');
  await page.waitForFunction(()=>document.querySelector('[data-p=play-disabled]').textContent.includes('경로 계산 실패: QA 경로 서버 연결 실패'));assert.equal(await action('play').isDisabled(),true);
  previewFailure=false;await page.locator('[aria-label="1단계 이름"]').fill('연결 복구 확인');await page.waitForFunction(()=>!document.querySelector('[data-action=play]').disabled);assert.equal(await reason.isHidden(),true);
  await page.locator('[data-p=voice-target]').selectOption('hardware');await page.waitForFunction(()=>document.querySelector('[data-p=play-disabled]').textContent.includes('실제 로봇이 연결되지 않았습니다'));
  assert.match(await reason.textContent(),/변경사항을 저장/);await page.locator('[data-p=voice-target]').selectOption('simulation');await page.waitForFunction(()=>!document.querySelector('[data-action=play]').disabled);
  // Active and paused simulations explain why another start is blocked.
  const slow=await api('POST','presets',{name:'QA 대기 재생',steps:[{kind:'wait',seconds:30}]});await open(slow,1);await page.locator('[data-p=rate]').selectOption('1');await action('play').click();
  await page.waitForFunction(()=>document.querySelector('[data-p=play-disabled]').textContent.includes('시뮬레이션이 진행 중'));
  await action('pause').click();await page.waitForFunction(()=>document.querySelector('[data-p=play-disabled]').textContent.includes('일시정지'));
  await action('sim-stop').click();await page.waitForFunction(()=>!document.querySelector('[data-action=play]').disabled);assert.equal(await reason.isHidden(),true);
  // YOLO-backed simulation requires saving edits even without a hardware connection.
  const yolo=await api('POST','presets',{name:'QA YOLO 경로',object_source:'yolo',steps:[{kind:'wait'}]});await open(yolo,1);
  await page.locator('[aria-label="1단계 이름"]').fill('YOLO 이름 수정');await page.waitForFunction(()=>document.querySelector('[data-p=play-disabled]').textContent.includes('YOLOv8 탐지 실행 전에'));
  assert.equal(await action('play').isDisabled(),true);await save(yolo.id);await page.waitForFunction(()=>!document.querySelector('[data-action=play]').disabled);assert.equal(await reason.isHidden(),true);
  await open(p,17);
  for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:1050});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
   await page.locator('.preset-table-scroll').screenshot({path:'.cache/preset-step-editing-ui/table-'+width+'.png'});
  }
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  console.log('PASS: rename all 17 physical stages and module/checkpoint names, unchanged motion/IDs, save/reload; drag all 6 independent kinds and keyboard reorder; fixed module boundaries; visible missing-coordinate, API-failure, dirty/YOLO, offline-hardware, active/paused reasons with recovery; 320–1440px layout. No device/microphone commands.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
