// Only the isolated tests.training_classes_qa server. No actual training or devices.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-networking']});
 try{
  const base='http://127.0.0.1:8013',page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[],jobs=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.routeWebSocket('**/ws/*',socket=>socket.close());
  await page.route('**/*',route=>{const request=route.request(),url=new URL(request.url());assert.equal(url.origin,base);
   if(request.method()!=='GET'&&!['/api/training/class-preview','/api/training/jobs'].includes(url.pathname))throw Error('Unexpected mutation '+url.pathname);
   if(request.method()==='POST'&&url.pathname==='/api/training/jobs')jobs.push(request.postDataJSON());
   return route.continue();});
  const state=await(await page.request.get(base+'/__qa/state')).json();
  // This fixture checks submission only. The WebGPU integration suite executes the trainer.
  await page.route('**/static/chrome/client.mjs', route => route.fulfill({
    contentType: 'text/javascript', body: 'export function runJob() { return new Promise(() => {}); }'
  }));
  await page.goto(base+'/training#jobs');
  await page.locator('#initial-model option[value=parent]').waitFor({state:'attached'});
  assert.equal(await page.locator('#train-start').isDisabled(),true);
  await page.locator('#dataset-open').click();await page.locator(`[data-id="${state.extra.id}"]`).click();await page.locator('#ds-confirm:enabled').click();
  await page.locator('#initial-model').selectOption('parent');
  const cup=page.getByRole('checkbox',{name:'cup 클래스 유지',exact:true});await cup.waitFor();
  assert.equal(await cup.isChecked(),true);assert.equal(await page.getByRole('checkbox',{name:'person 클래스 유지',exact:true}).isChecked(),true);
  assert.match(await page.locator('#class-source-info').textContent(),/기반 모델 자료 재사용/);
  await page.locator('#class-source-search').fill('person');assert.equal(await page.locator('#class-base-rows tbody tr:visible').count(),1);await page.locator('#class-source-search').fill('');
  const mapping=page.getByRole('combobox',{name:'cup 사진 라벨 연결',exact:true});
  await mapping.selectOption(state.selection.retained[0].class_uuid);await page.locator('#class-preview').click();
  await page.waitForFunction(()=>document.querySelector('#class-plan-status').textContent.includes('중복'));
  assert.equal(await page.locator('#train-start').isDisabled(),true);
  await cup.uncheck();await page.locator('#class-preview').click();await page.locator('#class-plan-confirm:enabled').waitFor();
  assert.deepEqual(await page.locator('#class-plan-rows tbody th').allTextContents(),['다른 물체','새 상품']);
  assert.match(await page.locator('#class-plan-status').textContent(),/최종 2개 클래스/);
  assert.equal(await page.locator('#train-start').isDisabled(),true);
  await page.locator('#class-plan-confirm').check();assert.equal(await page.locator('#train-start').isEnabled(),true);
  await page.locator('#class-select-all').click();assert.equal(await page.locator('#class-plan-confirm').isChecked(),false);assert.equal(await page.locator('#train-start').isDisabled(),true);
  await cup.uncheck();await page.locator('#class-preview').click();await page.locator('#class-plan-confirm:enabled').waitFor();await page.locator('#class-plan-confirm').check();
  fs.mkdirSync('.cache/training-class-ui',{recursive:true});await page.locator('#training-classes').screenshot({path:'.cache/training-class-ui/desktop.png'});
  for(const width of [736,390,320]){await page.setViewportSize({width,height:1100});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'page overflow '+width);}
  await page.locator('#training-classes').screenshot({path:'.cache/training-class-ui/mobile.png'});
  await page.locator('#train-start').click();await page.waitForFunction(()=>document.querySelector('#action-message').textContent.includes('학습 시작'));
  assert.equal(jobs.length,1);assert.deepEqual(jobs[0].class_selection,state.selection);assert.match(jobs[0].class_plan_signature,/^[a-f0-9]{64}$/);
  const response=await(await page.request.get(base+'/api/training/jobs')).json();assert.equal(response.length,1);assert.notEqual(response[0].dataset_id,state.extra.id);assert.equal(response[0].class_plan.classes.length,2);
  assert.equal(await page.locator('#train-start').isDisabled(),true,'a queued training job must block duplicate starts');
  assert.deepEqual((await(await page.request.get(base+'/api/datasets/'+state.base.id)).json()),state.base);
  assert.deepEqual(errors,[]);
  console.log('PASS: existing data reuse, source class search, explicit labels, duplicate guard, subset+new classes, final train/val preview and confirmation, invalidation, job plan persistence, original snapshot preservation, 320–1440px. Fake worker only.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
