// Isolated :8012 QA state; SDK, microphone and camera remain disconnected.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--disable-background-networking']});
 try{
  const base='http://127.0.0.1:8012',context=await browser.newContext({viewport:{width:1440,height:1050},colorScheme:'dark'}),page=await context.newPage();
  const errors=[],forbidden=[],headers={origin:'http://localhost:8080'};let demoCalls=0,delayDemo=false,releaseDemo,requestStarted;
  page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  const api=async(method,path,data)=>{const r=await context.request.fetch(base+'/api/robot/'+path,{method,data,headers});assert.ok(r.ok(),r.status()+' '+path);return r.json();};
  const seed=(await api('GET','presets')).presets[0],preset=await api('POST','presets/'+seed.id+'/copy',{revision:seed.revision});
  preset.name='오프라인 미설정 경로';preset.object_source='saved';preset.context.waypoint1_joints=null;preset.box_pose=null;
  preset.simulation_objects={floor:null,shelf:null};const original=await api('PUT','presets/'+preset.id,preset);
  await page.routeWebSocket('**/ws/*',s=>s.close());
  await page.route('**/*',async route=>{
   const r=route.request(),u=new URL(r.url());assert.equal(u.origin,base);
   if(u.pathname==='/api/status')return route.fulfill({status:503,json:{detail:'카메라·음성 서비스 꺼짐'}});
   if(u.pathname==='/api/robot/host-access/status')return route.fulfill({json:{connection:'disconnected',initialized:false,can_move:false,detail:'모의 로봇 미연결'}});
   if(u.pathname==='/api/robot/work-points/current'){forbidden.push(u.pathname);return route.abort();}
   const demo=u.pathname==='/api/robot/pick/scenario/preview';
   if(r.method()!=='GET'&&!demo&&!/^\/api\/robot\/presets\/[^/]+\/preview$/.test(u.pathname)){forbidden.push(u.pathname);return route.abort();}
   if(demo){
    demoCalls++;const response=await route.fetch({headers:{...r.headers(),...headers}});
    if(delayDemo){delayDemo=false;requestStarted();await new Promise(resolve=>{releaseDemo=resolve;});try{return await route.fulfill({response});}catch{return;}}
    return route.fulfill({response});
   }
   const response=await route.fetch({headers:{...r.headers(),...headers}});
   if(u.pathname==='/api/robot/parcel-box'){const data=await response.json();data.center_base_mm=[-500,0,0];return route.fulfill({response,json:data});}
   if(u.pathname==='/api/robot/status'){const data=await response.json();data.config.access_backend='mac-sdk';data.bridge_connected=false;data.state='offline';data.parcel_box.center_base_mm=[-500,0,0];return route.fulfill({response,json:data});}
   return route.fulfill({response});
  });
  const root=page.locator('#scenario-editor'),action=name=>root.locator(`[data-action="${name}"]`),canvas=page.locator('[data-arm=canvas]');
  const state=()=>root.locator('[data-p=simulation]').getAttribute('data-state');
  const waitState=value=>page.waitForFunction(value=>document.querySelector('[data-p=simulation]').dataset.state===value&&(['idle','error'].includes(value)||document.querySelector('[data-arm=canvas]').dataset.simulation===value),value,{timeout:60000});
  const seek=async value=>root.locator('[data-p=progress]').evaluate((el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));},value);
  await page.goto(base+'/robot?preset='+preset.id+'#work-points-title');
  await page.waitForFunction(()=>document.querySelectorAll('[data-configure-field]').length===2);
  assert.equal(await action('play').isDisabled(),true);assert.equal(await action('demo').isEnabled(),true);
  assert.match(await root.locator('[data-p=simulation-connection]').textContent(),/로봇 미연결.*가상 테스트 가능/);
  assert.match(await root.locator('[data-p=simulation]').textContent(),/필수 좌표 2개/);
  assert.equal(await action('pause').isDisabled(),true);assert.equal(await action('sim-stop').isDisabled(),true);
  assert.equal(await page.locator('[data-pick=sizing]').isVisible(),false);
  assert.equal(await page.locator('.plane-heights').isVisible(),false);
  await root.locator('[data-p=rate]').selectOption('20');
  for(const region of ['floor','shelf']){
   await root.locator('[data-p=demo-region]').selectOption(region);await action('demo').click();await waitState('running');
   assert.equal(await action('play').isDisabled(),true);assert.equal(await action('demo').isDisabled(),true);
   assert.match(await root.locator('[data-p=simulation-context]').textContent(),/현재 프리셋과 별개/);
   assert.equal(await page.locator('[data-arm=hand]').isVisible(),false);
   if(region==='floor'){
    const count=demoCalls;await action('demo').evaluate(el=>el.click());assert.equal(demoCalls,count);
    await action('pause').click();await waitState('paused');assert.equal(await action('pause').textContent(),'계속 재생');
    const joints=await canvas.getAttribute('data-joints');await page.waitForTimeout(150);assert.equal(await canvas.getAttribute('data-joints'),joints);
    await page.getByRole('link',{name:'재생 제어로 이동',exact:true}).click();assert.equal(await state(),'paused');
    await seek(250);await waitState('paused');assert.equal(await root.locator('[data-p=percent]').textContent(),'25%');
    await seek(0);await action('pause').click();
   }
   await waitState('awaiting_grip');assert.equal(await action('pause').isDisabled(),true);assert.equal(await action('confirm-simulation').isVisible(),true);
   assert.equal(JSON.parse(await canvas.getAttribute('data-virtual-product')).holding,true);
   fs.mkdirSync('.cache/offline-preset-ui',{recursive:true});
   await page.locator('.gripper-panel').screenshot({path:'.cache/offline-preset-ui/'+region+'-grip.png'});
   await action('confirm-simulation').click();await waitState('awaiting_open');await action('confirm-simulation').click();await waitState('complete');
   assert.equal(await root.locator('[data-p=percent]').textContent(),'100%');assert.equal(await action('sim-stop').isEnabled(),true);
   assert.equal(JSON.parse(await canvas.getAttribute('data-virtual-product')).released,true);
   assert.deepEqual(await api('GET','presets/'+preset.id),original);
   console.log('PASS: disconnected '+region+' 17-step playback, pause/seek/confirm/complete, unchanged preset.');
   await action('sim-stop').click();await waitState('idle');assert.equal(await root.locator('[data-p=percent]').textContent(),'0%');
  }
  // Abort an in-flight example response; it must never start playback afterwards.
  const started=new Promise(resolve=>{requestStarted=resolve;});delayDemo=true;await action('demo').click();await started;
  assert.equal(await action('sim-stop').isEnabled(),true);await action('sim-stop').click();releaseDemo();
  await page.waitForTimeout(200);assert.equal(await state(),'idle');assert.equal(await action('demo').isEnabled(),true);
  // A valid edited stage can be tested while unrelated waypoint/box fields are empty.
  await root.locator('[data-coordinate-section=joints] > summary').click();
  await root.locator('[data-field="context.standby_joints.0"]').fill('1');
  await page.waitForFunction(()=>document.querySelector('[data-p=saved]').textContent==='저장 전 변경');
  await root.locator('[data-op=execute]').first().click();await waitState('complete');
  assert.match(await root.locator('[data-p=simulation-context]').textContent(),/저장 전 변경/);
  assert.match(await root.locator('[data-p=simulation]').textContent(),/기본 자세에서 재생/);
  assert.deepEqual(JSON.parse(await canvas.getAttribute('data-parcel-box')).center_base_mm,original.box_center);
  assert.equal(await page.locator('[data-arm=boxTitle]').textContent(),'프리셋 택배 박스');
  assert.equal(await page.locator('[data-arm=hand]').isVisible(),false);
  assert.equal(await action('play').isDisabled(),true);assert.equal(Number((await canvas.getAttribute('data-joints')).split(',')[0]),1);
  await action('sim-stop').click();await action('discard').click();
  await page.locator('#manipulator-box-tab').click();
  await page.waitForFunction(()=>JSON.parse(document.querySelector('[data-arm=canvas]').dataset.parcelBox).center_base_mm[0]===-500);
  await page.locator('#manipulator-points-tab').click();
  await page.waitForFunction(()=>JSON.parse(document.querySelector('[data-arm=canvas]').dataset.parcelBox).center_base_mm[0]!==-500);
  await root.locator('[data-p=voice-target]').selectOption('hardware');
  assert.equal(await action('play').isDisabled(),true);assert.equal(await action('demo').isDisabled(),true);
  assert.equal(await root.locator('[data-op=execute]').first().isDisabled(),true);
  await root.locator('[data-p=voice-target]').selectOption('simulation');
  for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:1000});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'overflow at '+width);
   await root.locator('#preset-execution').screenshot({path:'.cache/offline-preset-ui/player-'+width+'.png'});
  }
  await page.reload();await page.waitForFunction(()=>Boolean(document.querySelector('[data-action=demo]')));
  assert.equal(await state(),'idle');assert.deepEqual(await api('GET','presets/'+preset.id),original);
  assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);
  console.log('PASS: pending cancellation, unsaved single-stage preview, offline hardware disabled, 320–1440px, reload, no device or microphone requests.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
