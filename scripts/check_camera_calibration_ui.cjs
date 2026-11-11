// Every request is intercepted. No camera, microphone, robot or production state.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
process.chdir(path.resolve(__dirname,'..'));
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-networking']});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:1000}}),errors=[],writes=[];
  page.on('pageerror',e=>errors.push(e.message));
  let state={revision:null,enabled:false,config:null,result:null,state:'unconfigured',message:'마커 좌표 등록 후 캘리브레이션하세요.',busy:false};
  let pauseView=false,releaseView,notifyView;
  const cal={token:'a'.repeat(32),camera:{width:640,height:480},camera_from_base:[[0,-1,0,0],[0,0,-1,450],[1,0,0,1500],[0,0,0,1]],intrinsics:[[600,0,320],[0,600,240],[0,0,1]],distortion:[0,0,0,0,0],quality:{frames:12,reprojection_px:.3,depth_rms_mm:1.2,translation_jitter_mm:.5,rotation_jitter_deg:.1}};
  await page.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url());assert.equal(u.origin,'http://marker.test');
   if(u.pathname==='/'){
    const html=fs.readFileSync('app/static/robot.html','utf8');
    const card=html.slice(html.indexOf('<section id="camera-calibration"'),html.indexOf('<div data-pick="legacyCamera">'));
    return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/station-shell.css"><link rel="stylesheet" href="/static/packing.css"><link rel="stylesheet" href="/static/robot.css"><link rel="stylesheet" href="/static/dashboard-camera.css"><link rel="stylesheet" href="/static/robot-camera-calibration.css"></head><body style="margin:20px"><main><article class="panel pick-dialog teaching plane-editor"><section data-pick="calibration"><section id="plane-camera-settings" role="tabpanel">${card}</section></section></article></main><script type="module">import {connectCameraCalibration} from '/static/robot-camera-calibration.js';connectCameraCalibration(document.querySelector('#camera-calibration'),new AbortController().signal);</script></body></html>`});
   }
   if(u.pathname.startsWith('/static/'))return route.fulfill({path:'app'+u.pathname,contentType:u.pathname.endsWith('.js')?'text/javascript':'text/css'});
   if(req.method()!=='GET')writes.push({path:u.pathname,body:req.postDataJSON()});
   if(u.pathname==='/api/robot/work-points/current'){
    assert.equal(u.searchParams.get('monitor_only'),'true');return route.fulfill({json:{pose:[-10,20,30,0,180,0]}});
   }
   if(u.pathname==='/api/robot/camera-calibration'&&req.method()==='GET')return route.fulfill({json:state});
   if(u.pathname==='/api/robot/camera-calibration'&&req.method()==='PUT'){
    const body=req.postDataJSON();assert.equal(body.revision,state.revision);assert.equal(body.config.corners_base_mm.length,4);
    state={...state,...body,revision:'1'.repeat(32),state:'required',message:'마커 좌표를 저장했습니다.'};return route.fulfill({json:state});
   }
   if(u.pathname==='/api/robot/camera-calibration/run'){
    assert.equal(req.postDataJSON().revision,state.revision);state={...state,state:'ready',revision:'2'.repeat(32),result:cal,calibrated_at:new Date().toISOString(),message:'보정 완료'};
    return route.fulfill({json:state});
   }
   if(u.pathname==='/api/robot/camera-calibration/view'){
    const view={status:structuredClone(state),calibration:state.result,error:null,image:'data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#33464e"/><text x="20" y="30" fill="white">SIMULATED CAMERA / CAD PROJECTION</text></svg>').toString('base64'),frame_id:12,captured_at:new Date().toISOString(),robot:{state:'monitoring',bridge_connected:true,config:{stale_seconds:3},display_joint_topic:'/monitor/joint_states',topics:[{name:'/monitor/joint_states',state:'live',age_seconds:0,message:{name:[1,2,3,4,5,6].map(i=>'joint_'+i),position:[0,0,Math.PI/2,0,Math.PI/2,0]},received_at:new Date().toISOString()}]}};
    if(pauseView){pauseView=false;await new Promise(resolve=>{releaseView=resolve;notifyView();});}
    return route.fulfill({json:view});
   }
   throw Error('Unexpected request: '+u.pathname);
  });
  await page.goto('http://marker.test/');
  const root=page.locator('#camera-calibration'),run=root.locator('[data-marker=run]');
  await page.waitForFunction(()=>!document.querySelector('[data-marker=save]').disabled);
  const id=root.locator('tbody [data-marker=id]');
  assert.deepEqual(await root.locator('thead th').allTextContents(),['마커 ID','모서리','X (mm)','Y (mm)','Z (mm)','좌표 읽기']);
  assert.equal(await id.count(),4);assert.deepEqual(await id.evaluateAll(inputs=>inputs.map(i=>i.value)),['0','1','2','3']);
  assert.deepEqual(await id.evaluateAll(inputs=>inputs.map(input=>input.parentElement.rowSpan)),[1,1,1,1]);
  assert.deepEqual(await root.locator('tbody th').allTextContents(),['A','B','C','D']);
  assert.equal(await root.locator('tbody [data-marker-coordinate]').first().getAttribute('aria-label'),'모서리 A 마커 중심 BASE X');
  assert.equal(await root.locator('tbody button').last().getAttribute('aria-label'),'모서리 D 마커 중심에 현재 TCP 좌표 입력');
  assert.equal(await run.isDisabled(),true);
  await id.first().fill('9');await root.locator('tbody [data-marker-coordinate]').first().fill('123');
  await root.locator('[data-marker=reload]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-marker=reload]').disabled);
  assert.deepEqual(await root.locator('tbody [data-marker-coordinate]').evaluateAll(inputs=>inputs.map(i=>i.value)),Array(12).fill(''),'reload must discard unsaved coordinates when no marker is registered');
  assert.deepEqual(await id.evaluateAll(inputs=>inputs.map(i=>i.value)),['0','1','2','3']);
  assert.equal(await root.locator('[data-marker=enabled]').isChecked(),false);
  await root.locator('[data-marker=enabled]').check();
  assert.deepEqual(await root.locator('tbody [data-marker-coordinate]').evaluateAll(inputs=>inputs.map(i=>i.value)),Array(12).fill(''));
  const markerIds=[7,8,11,15];
  for(let i=0;i<4;i++){
   await id.nth(i).fill(String(markerIds[i]));
   const link=new URL(await root.locator('[data-marker-print]').nth(i).getAttribute('href'),'http://marker.test');
   assert.equal(link.searchParams.get('marker_id'),String(markerIds[i]));assert.equal(link.searchParams.get('point'),'ABCD'[i]);
  }
  await root.locator('tbody button').first().click();await page.waitForFunction(()=>!document.querySelector('[data-marker=save]').disabled);
  assert.deepEqual(await id.evaluateAll(inputs=>inputs.map(i=>Number(i.value))),markerIds,'reading corner A must preserve every marker ID');
  assert.deepEqual(await root.locator('tbody tr').first().locator('[data-marker-coordinate]').evaluateAll(inputs=>inputs.map(i=>Number(i.value))),[-10,20,30]);
  const points=[[0,200,0],[300,200,0],[300,0,0],[0,0,0]],coords=points.flat();
  for(let i=0;i<12;i++)await root.locator('tbody [data-marker-coordinate]').nth(i).fill(String(coords[i]));
  await root.locator('tbody [data-marker-coordinate]').first().focus();await page.keyboard.press('Tab');
  assert.equal(await root.locator('tbody [data-marker-coordinate]').nth(1).evaluate(input=>input===document.activeElement),true);
  await id.nth(1).fill('7');assert.equal(await id.first().evaluate(input=>input.validity.customError),true);
  await root.locator('[data-marker=save]').click();assert.equal(writes.length,0,'duplicate IDs must not be submitted');
  await id.nth(1).fill('8');
  await root.locator('[data-marker=save]').click();await page.waitForFunction(()=>!document.querySelector('[data-marker=run]').disabled);
  assert.deepEqual(writes[0].body.config.marker_ids,markerIds);assert.equal(writes[0].body.config.marker_id,undefined);assert.deepEqual(writes[0].body.config.corners_base_mm,points);
  await run.click();await page.waitForFunction(()=>document.querySelector('[data-marker=quality]').textContent.includes('12장'));
  await root.locator('[data-marker=preview]').click();await page.waitForFunction(()=>document.querySelector('[data-marker=view-status]').textContent.includes('영상 #12'));
  const projected=await page.evaluate(async()=>{const {projectBase}=await import('/static/robot-camera-calibration.js');return projectBase([0,0,0],{camera_from_base:[[0,-1,0,0],[0,0,-1,450],[1,0,0,1500],[0,0,0,1]],intrinsics:[[600,0,320],[0,600,240],[0,0,1]],distortion:[0,0,0,0,0]});});
  assert.deepEqual(projected,[320,420]);
  const pixels=await root.locator('canvas').evaluate(c=>{const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<d.length;i+=4)if(d[i])n++;return n;});
  assert.ok(pixels>1000,'CAD should render with live telemetry');
  await root.locator('[data-marker=image]').evaluate(image=>image.decode());
  const overlay=await root.evaluate(el=>{const image=el.querySelector('[data-marker=image]').getBoundingClientRect(),canvas=el.querySelector('canvas'),rect=canvas.getBoundingClientRect();return {image:[image.x,image.y,image.width,image.height],canvas:[rect.x,rect.y,rect.width,rect.height],background:getComputedStyle(canvas).backgroundColor};});
  assert.ok(overlay.image.every((value,i)=>Math.abs(value-overlay.canvas[i])<1),'image and overlay must have identical bounds inside the real dialog styles');
  assert.equal(overlay.background,'rgba(0, 0, 0, 0)');
  fs.mkdirSync('.cache/marker-calibration-ui',{recursive:true});
  await root.screenshot({path:'.cache/marker-calibration-ui/desktop.png'});
  await root.locator('[data-marker=preview]').click();
  const held=new Promise(resolve=>notifyView=resolve);pauseView=true;
  await root.locator('[data-marker=preview]').click();await held;
  state={...state,revision:'3'.repeat(32),result:null,state:'required',message:'최신 등록값 · 재보정 필요'};
  await root.locator('[data-marker=reload]').click();
  await page.waitForFunction(()=>document.querySelector('[data-marker=status]').textContent.includes('최신 등록값'));
  assert.deepEqual(await id.evaluateAll(inputs=>inputs.map(i=>Number(i.value))),markerIds);
  const oldResponse=page.waitForResponse(async response=>response.url().endsWith('/camera-calibration/view')&&(await response.json()).status.revision==='2'.repeat(32));
  releaseView();await oldResponse;
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.match(await root.locator('[data-marker=status]').textContent(),/최신 등록값/,'late preview must not restore an earlier calibration');
  await root.locator('[data-marker=preview]').click();
  await root.locator('tbody [data-marker-coordinate]').first().fill('1');assert.equal(await run.isDisabled(),true);
  for(const width of [736,390,320]){
   await page.setViewportSize({width,height:900});
   const boxes=await page.evaluate(()=>[...document.querySelectorAll('body,main,#camera-calibration,form,details,.marker-settings,.marker-actions,.marker-image')].map(e=>[e.tagName,e.className,e.getBoundingClientRect().width,e.scrollWidth]));
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'page overflow at '+width+' '+JSON.stringify(boxes));
   const widths=await root.locator('tbody [data-marker-coordinate]').first().evaluate(input=>[input.getBoundingClientRect().width,input.parentElement.getBoundingClientRect().width]);
   assert.ok(widths[0]<=widths[1]);
  }
  await root.screenshot({path:'.cache/marker-calibration-ui/mobile.png'});
  const legacyPoints=[[0,100,0],[100,100,0],[100,0,0],[0,0,0]];
  state={...state,config:{marker_id:9,side_mm:100,corners_base_mm:legacyPoints},revision:'4'.repeat(32)};
  await root.locator('[data-marker=reload]').click();await page.waitForFunction(()=>!document.querySelector('[data-marker=reload]').disabled);
  assert.equal(await root.locator('[data-marker=legacy]').isVisible(),true);
  assert.deepEqual(await id.evaluateAll(inputs=>inputs.map(i=>[i.value,i.readOnly])),[['9',false],['9',true],['9',true],['9',true]]);
  assert.deepEqual(await root.locator('[data-marker-coordinate]').evaluateAll(inputs=>inputs.map(i=>Number(i.value))),legacyPoints.flat());
  await root.locator('[data-marker=convert]').click();
  assert.deepEqual(await id.evaluateAll(inputs=>inputs.map(i=>[i.value,i.readOnly])),[['0',false],['1',false],['2',false],['3',false]]);
  assert.deepEqual(await root.locator('[data-marker-coordinate]').evaluateAll(inputs=>inputs.map(i=>i.value)),Array(12).fill(''));
  await root.locator('[data-marker=reload]').click();await page.waitForFunction(()=>!document.querySelector('[data-marker=reload]').disabled);
  assert.deepEqual(state.config,{marker_id:9,side_mm:100,corners_base_mm:legacyPoints});
  assert.deepEqual(writes.map(x=>x.path),['/api/robot/camera-calibration','/api/robot/camera-calibration/run']);
  assert.deepEqual(errors,[]);
  console.log('PASS: four independent IDs and print links, duplicate rejection, save/reload, TCP read isolation, legacy preservation and explicit conversion, calibration+CAD overlay, late-preview isolation, keyboard and 320–1200px layouts. All network mocked.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
