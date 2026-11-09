// Isolated browser check: every network request is intercepted; no device API is contacted.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
process.chdir(path.resolve(__dirname,'..'));
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--disable-background-networking']});
 try {
  const page=await browser.newPage({viewport:{width:1200,height:950}}),commands=[],errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),resource=url.pathname;
   if(resource==='/robot')return route.fulfill({contentType:'text/html',body:fs.readFileSync('app/static/robot.html','utf8').replace('<script type="module" src="/static/robot.js"></script>','')});
   if(resource.startsWith('/static/')&&fs.existsSync('app'+resource))return route.fulfill({path:'app'+resource,contentType:resource.endsWith('.js')?'text/javascript':resource.endsWith('.css')?'text/css':'image/svg+xml'});
   let value={};const body=req.postDataJSON();
   if(resource.endsWith('/contact'))value={revision:null,threshold_ma:null};
   else if(resource.endsWith('/table'))value={revision:'saved',points:[{position:0,width_mm:80},{position:700,width_mm:0}]};
   else if(resource.endsWith('/test/preview')) {
    if(body.width_mm>80)return route.fulfill({status:409,json:{detail:'필요 벌림이 교시 범위 밖입니다.'}});
    value={...body,position:262,estimated_width_mm:50.057};
   }else if(resource.endsWith('/test')||resource.endsWith('/command')) {commands.push(body);value={state:'completed',message:'모의 장치 완료',feedback:{position:262}};}
   else throw Error('Unexpected request: '+resource);
   return route.fulfill({json:value});
  });
  await page.goto('http://gripper.test/robot#gripper-table');
  await page.evaluate(async()=>{
   window.handUI=await import('/static/robot-gripper.js');
   await handUI.loadHandTable();
   window.fakeStatus={config:{access_backend:'mac-sdk'}};
   window.fakeHost={session_id:'fake',motion_token:'a'.repeat(32),can_move:true,gripper_supported:true,gripper_target:262,gripper_feedback:{state:'completed',position:262,observed_at:new Date().toISOString()}};
   handUI.renderHand(fakeStatus,fakeHost);
   document.querySelector('#work-plane').hidden=false;
   document.querySelector('#plane-hand-table').hidden=false;
  });
  await page.locator('#hand-test-width').fill('50');
  assert.equal(commands.length,0);
  await page.locator('#hand-test-preview').click();
  await page.locator('#hand-test-dialog').waitFor({state:'visible'});
  assert.match(await page.locator('#hand-test-target').textContent(),/262/);
  await page.locator('#hand-test-cancel').click();assert.equal(commands.length,0);
  await page.locator('#hand-test-preview').click();
  await page.locator('#hand-test-confirm').dblclick();
  await page.waitForFunction(()=>document.querySelector('#hand-test-result').textContent.includes('모의 장치 완료'));
  assert.equal(commands.length,1);assert.equal(commands[0].width_mm,50);assert.equal(commands[0].revision,'saved');
  assert.equal('position' in commands[0],false,'Server computes position from saved table');
  await page.evaluate(()=>handUI.renderHand(fakeStatus,fakeHost));
  assert.match(await page.locator('#hand-test-feedback').textContent(),/50.1 mm/);
  await page.locator('#hand-test-width').fill('90');await page.locator('#hand-test-preview').click();
  await page.waitForFunction(()=>document.querySelector('#hand-test-result').textContent.includes('교시 범위'));
  assert.equal(await page.locator('#hand-test-dialog').isVisible(),false);
  await page.locator('#hand-test-width').fill('50');
  await page.locator('#hand-samples input').first().fill('1');
  assert.equal(await page.locator('#hand-test-preview').isDisabled(),true);
  await page.locator('#hand-reload').click();
  await page.evaluate(()=>handUI.renderHand({...fakeStatus,pick_active:true},fakeHost));
  assert.equal(await page.locator('#hand-test-read').isDisabled(),true);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('#plane-hand-table').evaluate(n=>n.scrollWidth>n.clientWidth+1),false);
  assert.equal(commands.length,1);assert.deepEqual(errors,[]);
  console.log('PASS: preview/cancel 0 commands; approved double click 1; bounds, dirty table, lock, feedback and mobile checks');
 }finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
