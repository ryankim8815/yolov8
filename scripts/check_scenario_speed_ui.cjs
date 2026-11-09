// Requires an isolated robot-web on port 8012 with a fresh ROBOT_STATE_DIR.
// Only configuration saves and virtual previews are allowed; device commands are blocked.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--disable-background-networking']});
 try{
  const ctx=await browser.newContext({viewport:{width:1360,height:1000}}),page=await ctx.newPage(),errors=[],writes=[];
  const base='http://127.0.0.1:8012';let latest=null;
  const get=async resource=>(await ctx.request.get(base+'/api/robot/'+resource)).json();
  const status=await get('status');assert.equal(status.config.access_backend,'ros');assert.equal(status.config.ros_pc_ip,'');
  const config=await get('pick-scenario');assert.equal(config.waypoint1_joints,null,'Use an isolated QA state directory');
  for(const stage of Object.values(config.stages))stage.override=null;
  Object.assign(config.stages['8'],{profile:'medium',motion:null});
  assert.ok((await ctx.request.put(base+'/api/robot/pick-scenario',{data:config})).ok());
  page.on('pageerror',error=>errors.push(error.message));
  await ctx.routeWebSocket('**/ws/detections*',socket=>socket.close());
  await ctx.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());assert.equal(url.origin,base);
   if(url.pathname.startsWith('/api/robot/')&&request.method()!=='GET'){
    writes.push(url.pathname);
    assert.ok((url.pathname==='/api/robot/pick-scenario'&&request.method()==='PUT')||(url.pathname==='/api/robot/pick/scenario/preview'&&request.method()==='POST'),'Device command attempted: '+url.pathname);
   }
   const response=await route.fetch({headers:{...request.headers(),origin:'http://localhost:8080'}});
   if(url.pathname==='/api/robot/pick/scenario/preview'&&response.ok())latest=await response.json();
   return route.fulfill({response});
  });
  await page.goto(base+'/robot#work-points-title');
  const editor=page.locator('#scenario-editor'),speed=n=>editor.locator('[data-speed-percent="'+n+'"]');
  await page.waitForFunction(()=>!document.querySelector('[data-sc=play]')?.disabled);
  assert.deepEqual(await editor.locator('.scenario-tabs [role=tab]').allTextContents(),['상품·파지 영역','시뮬레이션']);
  assert.deepEqual(await editor.locator('thead th').allTextContents(),['단계','이동 방식','이동 속도','입력 방식','J1','J2','J3','J4','J5','J6']);
  assert.equal(await editor.locator('[data-speed-percent]').count(),16);assert.equal(await speed(2).count(),0);
  for(const n of [1,5,6])assert.deepEqual(await speed(n).locator('option:not([disabled])').allTextContents(),Array.from({length:10},(_,i)=>(i+1)*10+'%'));
  for(const [number,percent]of [[1,30],[5,40],[6,70]]){
   await speed(number).selectOption(String(percent));
   await page.waitForFunction(([n,p])=>document.querySelector('[data-speed-percent="'+n+'"]').title.startsWith(p/10+' '),[number,percent]);
   await page.waitForTimeout(350);assert.equal(latest.steps[number-1].speed.speed,percent/10);
  }
  for(let percent=10;percent<=100;percent+=10){await speed(1).selectOption(String(percent));assert.equal(await speed(1).inputValue(),String(percent));}
  await editor.locator('[data-sc=source]').selectOption('saved');
  await page.waitForFunction(()=>document.querySelector('[data-speed-percent="8"]')?.value==='75');
  assert.equal(await speed(8).locator('option:checked').isDisabled(),true,'Legacy speed is preserved until explicitly edited');
  assert.equal(await speed(8).locator('option:not([disabled])').count(),10);
  await speed(8).selectOption('30');
  await editor.locator('[data-config="stages.8.motion"]').selectOption('movel');
  assert.equal(await speed(8).inputValue(),'30','Motion changes preserve percentage');
  await speed(5).selectOption('60');await speed(6).selectOption('80');
  await editor.locator('[data-sc=save]').click();
  await page.waitForFunction(()=>document.querySelector('[data-sc=message]')?.textContent.includes('저장 완료'));
  const saved=await get('pick-scenario');
  assert.equal(saved.stages['8'].override.speed,3);assert.equal(saved.stages['8'].override.acceleration,7.5);
  assert.equal(saved.stages['5'].override.speed,6);assert.equal(saved.stages['6'].override.speed,8);
  await page.reload();await editor.locator('[data-sc=source]').selectOption('saved');
  await page.waitForFunction(()=>document.querySelector('[data-speed-percent="8"]')?.value==='30');
  assert.equal(await speed(5).inputValue(),'60');assert.equal(await speed(6).inputValue(),'80');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('.plane-editor').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
  assert.equal(await editor.locator('thead th').count(),10);
  assert.deepEqual(errors,[]);assert.ok(writes.length>0);
  console.log('PASS: speed tab removed; 10-column table; 10–100% options; joint/line/gripper preview speeds; legacy preservation; movement changes; save/reload; mobile; no hardware commands.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
