// Opt-in STT acceptance test against tests.dashboard_qa only. TTS is not repeated.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const assert=require('node:assert/strict'),fs=require('node:fs');
const exec=promisify(execFile),base='http://127.0.0.1:8016';
async function soundSettings(){const {stdout}=await exec('/usr/bin/osascript',['-e','get volume settings']);return {level:Number(stdout.match(/output volume:(\d+)/)[1]),muted:stdout.includes('output muted:true')};}
(async()=>{
 if(process.env.VOICE_TEST_REAL_AUDIO!=='1')throw Error('Explicit permission and VOICE_TEST_REAL_AUDIO=1 are required.');
 const wav=process.env.VOICE_TEST_WAV;if(!wav||!fs.existsSync(wav))throw Error('A synthetic Korean query WAV is required.');
 const browser=await chromium.launch({channel:'chrome',headless:false,
  args:['--use-fake-ui-for-media-stream',...(process.env.VOICE_TEST_DEBUG?['--enable-logging=stderr','--vmodule=*speech*=2,*soda*=2']:[])]});
 let page,originalVolume,testVolume,session;
 try{
  page=await browser.newPage();page.on('console',m=>console.log('Chrome:',m.text()));
  const fixture=await page.request.get(base+'/__qa/voice-fixture');assert.ok(fixture.ok(),'Isolated QA fixture is required');assert.equal((await fixture.json()).fixture,'isolated-dashboard');
  const before=await(await page.request.get(base+'/api/voice/status')).json();assert.equal(before.can_stop,false,'Another voice session is running; tests must run sequentially');
  if(process.env.VOICE_TEST_VOLUME){
   testVolume=Number(process.env.VOICE_TEST_VOLUME);assert.ok(Number.isInteger(testVolume)&&testVolume>=0&&testVolume<=50);
   originalVolume=await soundSettings();console.log('Original sound settings:',JSON.stringify(originalVolume));
   await exec('/usr/bin/osascript',['-e',`set volume output volume ${testVolume}`]);
  }
  await page.goto(base+'/healthz');
  await page.evaluate(async()=>{
   document.body.innerHTML='<button id="start">Run authorized Chrome STT test</button>';
   window.__speechEvents=[];
   const R=window.SpeechRecognition||window.webkitSpeechRecognition,start=R.prototype.start;
   R.prototype.start=function(...args){
    for(const event of ['start','audiostart','speechstart','result','error','end'])this.addEventListener(event,e=>window.__speechEvents.push({event,local:this.processLocally,error:e.error||'',results:e.results?Array.from(e.results,r=>({final:r.isFinal,text:r[0].transcript})):null}));
    return start.apply(this,args);
   };
   const {ChromeVoice}=await import('/static/chrome-voice.js');
   const audio=new ChromeVoice();window.__audio=audio;
   // Narration has already passed. Capture the reply without invoking speechSynthesis.
   audio.speak=command=>{window.__reply=command;};
   document.querySelector('button').onclick=async()=>{
    try{const clientId=await audio.prepare();const r=await fetch('/api/voice/wake',{method:'POST',headers:{'X-Voice-Client':clientId}});if(!r.ok)throw Error(await r.text());window.__session=(await r.json()).session_id;window.__started=true;}
    catch(e){window.__error=e.message;}
   };
  });
  await page.click('#start');await page.waitForFunction(()=>window.__started||window.__error,{},{timeout:20000});
  const startup=await page.evaluate(()=>({error:window.__error,session:window.__session}));if(startup.error)throw Error(startup.error);session=startup.session;assert.ok(session);
  async function poll(predicate,timeout){
   const deadline=Date.now()+timeout;
   while(Date.now()<deadline){
    const s=await(await page.request.get(base+'/api/voice/status',{headers:{'Cache-Control':'no-cache'}})).json();
    if(s.session_id!==session)throw Error('Test session ended or changed: '+JSON.stringify(s));
    if(s.error)throw Error(s.error);if(predicate(s))return s;
    await new Promise(r=>setTimeout(r,100));
   }
   throw Error('Chrome STT status timed out');
  }
  await poll(s=>s.state==='listening',15000);
  console.log('Microphone ready; playing the synthetic Korean query once');await exec('/usr/bin/afplay',[wav],{timeout:10000});
  const recognized=await poll(s=>Boolean(s.transcript&&s.reply),40000);
  const events=await page.evaluate(()=>window.__speechEvents);console.log('Speech events:',JSON.stringify(events));
  assert.ok(events.some(e=>e.event==='result'&&e.local===false&&e.results.some(r=>r.final&&/재고/.test(r.text))),'A real final result from this Chrome instance is required');
  assert.match(recognized.transcript,/재고/);assert.match(recognized.reply,/생수|빼빼로|물티슈/);
  await page.waitForFunction(()=>Boolean(window.__reply));assert.equal(await page.evaluate(()=>window.__reply.session),session);
  assert.equal(await page.evaluate(()=>window.__audio.stream===null&&window.__audio.recognition===null),true,'Microphone must be released before the reply');
  const history=await(await page.request.get(base+'/api/voice/history')).json();
  assert.ok(history.messages.some(m=>m.session_id===session&&m.role==='user'&&m.text===recognized.transcript));
  console.log('PASS online Chrome Korean STT -> matching server session/reply. Narration not repeated.');
 }finally{
  try{
   if(originalVolume){const current=await soundSettings();if(current.level===testVolume)await exec('/usr/bin/osascript',['-e',`set volume output volume ${originalVolume.level}`,'-e',`set volume output muted ${originalVolume.muted}`]);console.log('Final sound settings:',JSON.stringify(await soundSettings()));}
  }finally{
   if(page){if(session){const s=await page.request.get(base+'/api/voice/status').then(r=>r.json()).catch(()=>null);if(s?.session_id===session)await page.request.post(base+'/api/voice/stop').catch(()=>{});}await page.evaluate(()=>window.__audio?.close()).catch(()=>{});}
   await browser.close();
  }
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
