// Isolated tests.dashboard_qa on :8016; synthetic speech, no real microphone or robot.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const base='http://127.0.0.1:8016',context=await browser.newContext(),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
  await page.route('**/api/robot/**',route=>route.continue({headers:{...route.request().headers(),origin:'http://localhost:8080'}}));
  await context.addInitScript(()=>{
   window.__liveTracks=0;
   navigator.mediaDevices.getUserMedia=async()=>{window.__liveTracks++;let stopped=false;const track={stop(){if(!stopped){stopped=true;window.__liveTracks--;}}};return {getTracks:()=>[track],getAudioTracks:()=>[track]};};
   window.__audio=[];window.__synth=null;window.__recognition=null;
   class Recognition {
    static async available(){return 'available';}static async install(){return true;}
    start(){window.__recognition=this;window.__audio.push(['listen',this.processLocally,this.lang]);queueMicrotask(()=>this.onstart?.());}
    stop(){queueMicrotask(()=>this.onend?.());}
    abort(){window.__recognition=null;}
   }
   Recognition.prototype.processLocally=false;window.SpeechRecognition=Recognition;
   window.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};
   Object.defineProperty(window,'speechSynthesis',{value:{getVoices:()=>[{lang:'ko-KR',name:'QA Korean',localService:true}],
    speak(u){window.__synth=u;window.__audio.push(['speak',u.text]);},cancel(){window.__synth=null;},addEventListener(){},removeEventListener(){}}});
   window.__say=text=>{
    const r=window.__recognition;if(!r)throw Error('Not listening: '+JSON.stringify(window.__audio));
    r.onresult({resultIndex:0,results:[Object.assign([{transcript:text}],{isFinal:true})]});
   };
  });
  const status=async()=>{const r=await page.request.get(base+'/api/voice/status');return r.json();};
  const wait=async state=>{const end=Date.now()+15000;while(Date.now()<end){if((await status()).state===state)return;await new Promise(r=>setTimeout(r,100));}throw Error('Voice state timed out: '+state+' '+JSON.stringify(await status()));};
  await page.goto(base+'/');
  await page.locator('.headline [data-action=voice]').click();
  await page.locator('#voice-panel [data-action=wake]').click();await wait('listening');
  assert.equal((await status()).provider,'chrome');
  await page.evaluate(()=>window.__say('예시 주문'));await wait('speaking');
  await page.waitForFunction(()=>document.querySelector('#voice-panel').textContent.includes('Chrome')); 
  assert.equal(await page.evaluate(()=>window.__recognition===null),true);
  assert.match(await page.evaluate(()=>window.__synth.text),/주문/);
  await page.evaluate(()=>window.__synth.onend());await wait('listening');
  await page.evaluate(()=>window.__say('주문 확정'));await wait('speaking');
  await page.locator('#voice-panel [data-action=stop-listening]').click();await wait('idle');
  await page.waitForFunction(()=>window.__synth===null&&window.__recognition===null);
  // Dashboard controls share the same Chrome transport.
  await page.locator('[data-voice-action=start]').click();await wait('listening');
  await page.locator('[data-voice-action=stop]').click();await wait('idle');
  await page.locator('[data-vc=mode]').selectOption('robot');assert.match(await page.locator('[data-vc=hint]').textContent(),/Google/);
  await page.locator('[data-voice-action=start]').click();await wait('listening');
  await page.evaluate(()=>window.__say('로봇 테스트 대기'));
  await page.locator('[data-voice-action=approve]').waitFor();
  await page.locator('[data-voice-action=cancel]').click();
  await page.locator('[data-voice-action=stop]').click();await wait('idle');
  // A new document owns a fresh transport; navigation releases the old owner.
  await page.goto(base+'/robot#work-points-title');
  await page.locator('[data-action=listen]').click();await wait('listening');await page.waitForFunction(()=>window.__recognition!==null);
  await page.evaluate(()=>window.__say('로봇 테스트 대기'));
  await page.locator('[data-action=voice-approve]').waitFor();
  await page.locator('[data-action=voice-cancel]').click();
  await page.locator('[data-action=unlisten]').click();await wait('idle');
  assert.ok((await page.evaluate(()=>window.__audio)).every(a=>a[0]!=='listen'||a[1]===false&&a[2]==='ko-KR'));
  await page.locator('[data-action=listen]').click();await wait('listening');await page.waitForFunction(()=>window.__recognition!==null);
  await page.goto(base+'/healthz');await wait('error');
  assert.equal((await status()).can_stop,false);
  assert.equal(await page.evaluate(()=>window.__liveTracks),0);
  assert.deepEqual(errors,[]);
  // Probe actual Chrome APIs separately, without mocks or microphone access.
  const native=await browser.newPage();await native.goto(base+'/healthz');
  const capabilities=await native.evaluate(async()=>{
   const R=window.SpeechRecognition||window.webkitSpeechRecognition;
   speechSynthesis.getVoices();await new Promise(r=>setTimeout(r,500));
   let korean='unsupported';try{if(R?.available)korean=await R.available({langs:['ko-KR'],processLocally:true});}catch(e){korean=e.message;}
   return {secure:isSecureContext,recognition:!!R,local:!!R&&'processLocally'in R.prototype,korean,voices:speechSynthesis.getVoices().filter(v=>v.lang.startsWith('ko')).map(v=>({name:v.name,local:v.localService}))};
  });
  console.log(JSON.stringify({ui:'passed: packing, dashboard, robot, cancellation, navigation',chrome:browser.version(),capabilities},null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
