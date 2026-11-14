// Fully mocked model registry. Never deletes production records or opens devices.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
process.chdir(path.resolve(__dirname,'..'));
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-networking']});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[],deletes=[];
  page.on('pageerror',e=>errors.push(e.message));
  const model=(id,name,kind='custom')=>({id,name,kind,classes:[],formats:{chrome:{state:'ready'}},version_number:kind==='custom'?1:null});
  let snapshot={backend:'chrome',active_model_id:'active',models:[model('base','기본 모델','builtin'),model('active','현재 적용 모델'),model('candidate','삭제 대상 모델')]};
  let fail=true,hold=false,release;
  await page.route('**/*',async route=>{
   const request=route.request(),u=new URL(request.url());assert.equal(u.origin,'http://models.test');
   if(u.pathname==='/'){
    const html=fs.readFileSync('app/static/training.html','utf8');
    const card=html.slice(html.indexOf('<section id="models-page"'),html.indexOf('<details class="settings">')).replace('id="models-page" hidden','id="models-page"');
    return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/style.css"><link rel="stylesheet" href="/static/model-manager.css"></head><body><main><p id="message" role="status"></p>${card}</main><script src="/static/model-manager.js"></script><script>
     const api=async(path,method='GET',body)=>{const r=await fetch(path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw Error(data.detail);return data;};
     window.update=createModelManager({api,activate:async()=>{throw Error('Unexpected activation');},reload:async()=>window.update(await api('/api/models')),message:text=>document.querySelector('#message').textContent=text});api('/api/models').then(window.update);
    </script></body></html>`});
   }
   if(u.pathname.startsWith('/static/'))return route.fulfill({path:'app'+u.pathname,contentType:u.pathname.endsWith('.js')?'text/javascript':'text/css'});
   if(u.pathname==='/api/models'&&request.method()==='GET')return route.fulfill({json:snapshot});
   if(u.pathname==='/api/models/candidate'&&request.method()==='DELETE'){
    deletes.push(request.postDataJSON());
    if(fail){fail=false;return route.fulfill({status:409,json:{detail:'시험 오류 · 상태를 확인하고 다시 시도하세요.'}});}
    if(hold)await new Promise(resolve=>release=resolve);
    snapshot.models=snapshot.models.filter(m=>m.id!=='candidate');return route.fulfill({json:{id:'candidate',deleted:true}});
   }
   throw Error('Unexpected request '+request.method()+' '+u.pathname);
  });
  await page.goto('http://models.test/');
  const select=id=>page.locator(`[data-model-id="${id}"]`).click(),dialog=page.locator('#model-dialog'),button=page.locator('#delete-model'),confirm=page.locator('#submit-model-change');
  await page.locator('[data-model-id=active]').waitFor();assert.equal(await button.isDisabled(),true);
  await select('base');assert.equal(await button.isDisabled(),true);assert.match(await page.locator('#model-delete-reason').textContent(),/기본 모델/);
  await select('candidate');assert.equal(await button.isEnabled(),true);
  await button.click();await dialog.waitFor({state:'visible'});
  assert.match(await page.locator('#model-dialog-note').textContent(),/삭제 대상 모델/);assert.match(await page.locator('#model-dialog-note').textContent(),/가중치 파일은 보존/);
  assert.equal(await page.locator('#cancel-model-change').evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Escape');assert.equal(deletes.length,0);
  await button.click();snapshot.active_model_id='candidate';await page.evaluate(data=>window.update(data),snapshot);
  assert.equal(await confirm.isDisabled(),true);assert.match(await page.locator('#model-form-error').textContent(),/현재 적용 중/);
  await page.locator('#cancel-model-change').click();snapshot.active_model_id='active';await page.evaluate(data=>window.update(data),snapshot);
  await button.click();
  fs.mkdirSync('.cache/model-delete-ui',{recursive:true});
  await dialog.screenshot({path:'.cache/model-delete-ui/confirm-desktop.png'});
  for(const width of [736,390,320]){
   await page.setViewportSize({width,height:900});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'page overflow '+width);
   assert.equal(await dialog.evaluate(el=>el.getBoundingClientRect().right>innerWidth+1),false,'dialog overflow '+width);
  }
  await dialog.screenshot({path:'.cache/model-delete-ui/confirm-mobile.png'});
  await confirm.click();await page.waitForFunction(()=>document.querySelector('#model-form-error').textContent.includes('시험 오류'));
  assert.equal(await dialog.isVisible(),true);assert.equal(await confirm.isEnabled(),true);
  hold=true;await confirm.click();await page.waitForFunction(()=>document.querySelector('#cancel-model-change').disabled);
  await page.locator('#model-form').evaluate(el=>el.requestSubmit());
  assert.equal(deletes.length,2,'double submit must not send another delete');
  assert.deepEqual(deletes,[{name:'삭제 대상 모델'},{name:'삭제 대상 모델'}]);
  release();await dialog.waitFor({state:'hidden'});await page.locator('[data-model-id=candidate]').waitFor({state:'detached'});
  assert.equal(await page.locator('#model-name').textContent(),'현재 적용 모델');assert.match(await page.locator('#message').textContent(),/삭제했습니다/);
  await page.locator('#rename-model').click();assert.equal(await confirm.getAttribute('data-mode'),'rename');assert.equal(await confirm.textContent(),'저장');await page.locator('#cancel-model-change').click();
  assert.deepEqual(errors,[]);
  console.log('PASS: active/builtin protection, delete identity and scope, cancel/Escape, concurrent activation, failure/retry, double-submit guard, refreshed list, rename unaffected, keyboard and 320–1440px layout. All API calls mocked.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
