// Dashboard requests are entirely mocked; this suite cannot contact a device or server.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
process.chdir(path.resolve(__dirname,'..'));
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-networking']});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],writes=[];let sockets=[],supported=['detections','color'];
  page.on('pageerror',error=>errors.push(error.message));
  const presets=[{id:'saved-path',name:'저장 경로',object_source:'saved'},{id:'vision-path',name:'비전 포장',object_source:'yolo'}];
  const status=modes=>({event:'status',ready:true,state:'ready',session_id:'mock-camera',camera_enabled:true,camera:{id:'mock',index:0,display_modes:modes,mode_note:'장치 안내가 있어도 미지원 모드는 숨김'}});
  await page.routeWebSocket('**/ws/detections*',socket=>{sockets.push(socket);socket.send(JSON.stringify(status(supported)));});
  await page.route('**/*',async route=>{
   const r=route.request(),url=new URL(r.url());assert.equal(url.origin,'http://cleanup.test');
   if(r.method()!=='GET'){writes.push(url.pathname);throw Error('Unexpected mutation: '+url.pathname);}
   if(url.pathname==='/'){
    const index=fs.readFileSync('app/static/index.html','utf8'),template=index.match(/<template id="dashboard-layout">([\s\S]*?)<\/template>/)[1];
    return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="ko"><head><meta charset="utf-8"><link rel="stylesheet" href="/static/station-shell.css"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/packing.css"><link rel="stylesheet" href="/static/dashboard-camera.css"></head><body>${template}<script type="module">import {connectDashboardCamera} from '/static/dashboard-camera.js';connectDashboardCamera(document.querySelector('#live-camera'),()=>null);</script></body></html>`});
   }
   if(url.pathname.startsWith('/static/'))return route.fulfill({path:'app'+url.pathname,contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'image/svg+xml'});
   if(url.pathname==='/api/camera/devices')return route.fulfill({json:[{id:'mock',name:'모의 카메라',index:0}]});
   if(url.pathname==='/api/robot/presets')return route.fulfill({json:{schema_version:2,presets}});
   throw Error('Unexpected read: '+url.pathname);
  });
  await page.goto('http://cleanup.test/');
  const select=page.locator('[data-preset-launch=select]'),link=page.locator('[data-preset-launch=open]');
  await select.waitFor();await page.waitForFunction(()=>!document.querySelector('[data-preset-launch=select]').disabled);
  assert.equal(await page.locator('[data-pick=dialog],[data-pick=select],[data-pick=job]').count(),0);
  await select.selectOption('vision-path');assert.equal(await link.getAttribute('href'),'/robot?preset=vision-path#work-points-title');
  assert.match(await page.locator('[data-preset-launch=status]').textContent(),/YOLOv8.*음성 클래스/);
  await page.locator('[data-preset-launch=refresh]').click();assert.equal(await select.inputValue(),'vision-path');
  const modes=page.locator('[data-camera=mode]');
  await page.waitForFunction(()=>!document.querySelector('[data-camera=mode]').disabled);
  assert.deepEqual(await modes.locator('option:not([hidden])').evaluateAll(items=>items.map(n=>n.value)),['detections','color']);
  await modes.selectOption('color');await page.waitForFunction(()=>document.querySelector('[data-camera=mode]').value==='color');
  supported=['detections','depth','rgbd','cloud'];sockets.at(-1).send(JSON.stringify(status(supported)));
  await page.waitForFunction(()=>document.querySelector('[data-camera=mode] option[value=depth]')?.hidden===false);
  assert.deepEqual(await modes.locator('option:not([hidden])').evaluateAll(items=>items.map(n=>n.value)),['detections','depth','rgbd','cloud']);
  await page.locator('#live-camera').screenshot({path:'/private/tmp/ui-cleanup-dashboard-desktop.png'});
  await select.focus();await select.press('Home');await select.press('Enter');
  for(const width of [736,390,320]){
   await page.setViewportSize({width,height:900});
   assert.equal(await page.locator('.dashboard-preset-launcher').evaluate(el=>el.scrollWidth>el.clientWidth+1),false,'launcher overflow at '+width);
  }
  await page.locator('#live-camera').screenshot({path:'/private/tmp/ui-cleanup-dashboard-mobile.png'});
  assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
  console.log('PASS: canonical preset launcher, selected-route link and refresh, no legacy execution UI, only supported camera modes even with mode notes, keyboard and responsive layout. All network mocked.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
