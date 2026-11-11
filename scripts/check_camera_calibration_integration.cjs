// Read-only whole-page check. Default is the isolated tests.preset_yolo_qa server.
// An explicit CALIBRATION_READONLY_BASE can check an unregistered localhost UI.
// All mutations and detection WebSockets are blocked, including in live mode.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const base=process.env.CALIBRATION_READONLY_BASE||'http://127.0.0.1:8012';
 assert.ok(['http://127.0.0.1:8012','http://127.0.0.1:8080','http://localhost:8080'].includes(base));
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--disable-background-networking']});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1050},colorScheme:'dark'}),errors=[],blocked=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',route=>{
   const request=route.request();
   if(request.method()!=='GET'){blocked.push(request.url());return route.fulfill({status:503,json:{detail:'읽기 전용 검증'}});}
   // The QA process must never call the real Mac video service.
   if(!process.env.CALIBRATION_READONLY_BASE&&new URL(request.url()).pathname==='/api/robot/camera-calibration/view')
    return route.fulfill({status:409,json:{detail:'카메라를 켜고 모델 전환·학습이 끝날 때까지 기다리세요.'}});
   return route.continue();
  });
  await page.routeWebSocket('**/ws/detections*',socket=>socket.close());
  await page.goto(base+'/robot#camera-calibration');
  const root=page.locator('#camera-calibration');
  await root.waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('[data-marker=save]').disabled);
  assert.equal(await page.locator('.station-nav [data-page=work-plane]').textContent(),'캘리브레이션');
  assert.equal(await page.locator('h1').textContent(),'캘리브레이션');
  assert.equal(await page.title(),'캘리브레이션 · Vision Lab');
  assert.deepEqual(await root.locator('tbody th').allTextContents(),['A','B','C','D']);
  assert.equal(await root.locator('thead th').first().textContent(),'마커 ID');
  assert.equal(await root.locator('tbody [data-marker=id]').inputValue(),'0');
  assert.equal(await root.locator('tbody [data-marker=id]').evaluate(input=>input.parentElement.rowSpan),4);
  assert.deepEqual(await page.locator('[data-pick=steps] button').allTextContents(),['모서리 A','모서리 B','모서리 C','모서리 D']);
  assert.equal(await page.locator('[data-pick=positionTitle]').textContent(),'모서리 A 위치');
  assert.equal(await page.locator('#plane-gripper-settings,#plane-example-settings').count(),0);
  assert.equal(await page.locator('.plane-view-options').isVisible(),false);
  assert.equal(await page.locator('.plane-tabs').getAttribute('aria-label'),'캘리브레이션 설정');
  assert.equal(await root.locator('tbody [data-marker-coordinate]').count(),12);
  assert.deepEqual(await root.locator('tbody [data-marker-coordinate]').evaluateAll(inputs=>inputs.map(i=>i.value)),Array(12).fill(''),'check requires an unregistered marker');
  assert.equal(await page.locator('[data-pick=legacyCamera]').evaluate(el=>el.inert),true,'legacy teaching stays locked without a frozen camera frame');
  assert.equal(await root.evaluate(el=>Boolean(el.closest('[inert]'))),false,'marker registration stays usable independently');
  await root.locator('tbody [data-marker-coordinate]').first().click();await root.locator('tbody [data-marker-coordinate]').first().fill('123');
  assert.equal(await root.locator('tbody [data-marker-coordinate]').first().evaluate(el=>document.activeElement===el),true);
  await root.locator('[data-marker=reload]').click();await page.waitForFunction(()=>!document.querySelector('[data-marker=reload]').disabled);
  assert.deepEqual(await root.locator('tbody [data-marker-coordinate]').evaluateAll(inputs=>inputs.map(i=>i.value)),Array(12).fill(''));
  assert.equal(await root.locator('[data-marker=run]').isDisabled(),true);
  await root.locator('[data-marker=preview]').click();
  await page.waitForFunction(()=>document.querySelector('[data-marker=view-status]').textContent.includes('카메라를 켜고'));
  await root.locator('[data-marker=preview]').click();
  fs.mkdirSync('.cache/calibration-audit-ui',{recursive:true});
  await root.screenshot({path:'.cache/calibration-audit-ui/integration-desktop.png'});
  for(const width of [390,320]){
   await page.setViewportSize({width,height:900});
   assert.equal(await root.evaluate(el=>el.getBoundingClientRect().right>innerWidth+1),false);
   await root.locator('[data-marker=reload]').click();
   await page.waitForFunction(()=>!document.querySelector('[data-marker=reload]').disabled);
  }
  await root.screenshot({path:'.cache/calibration-audit-ui/integration-mobile.png'});
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  fs.writeFileSync('.cache/calibration-audit-ui/integration-result.json',JSON.stringify({base,errors,blocked,coordinatesEmpty:true,legacyLocked:true,markerInteractive:true,cameraOffGuidance:true},null,2));
  console.log('PASS: whole-page camera-off marker controls, legacy lock isolation, actual mouse/keyboard input, draft reload, 320px layout and no mutation requests.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
