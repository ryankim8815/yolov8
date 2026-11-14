// File-only real Chrome online STT acceptance. No microphone or narration.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const wav=process.env.VOICE_TEST_WAV;if(!wav||!fs.existsSync(wav))throw Error('A synthetic Korean query WAV is required.');
 // No node is connected to audio.destination. Do not globally mute stream tracks.
 const browser=await chromium.launch({channel:'chrome',headless:true,ignoreDefaultArgs:['--mute-audio'],args:['--autoplay-policy=no-user-gesture-required']});
 let page,session;
 const base='http://127.0.0.1:8016';
 try{
  page=await browser.newPage();page.on('console',m=>console.log('Chrome:',m.text()));
  const fixture=await page.request.get(base+'/__qa/voice-fixture');assert.equal((await fixture.json()).fixture,'isolated-dashboard');
  const before=await(await page.request.get(base+'/api/voice/status')).json();assert.equal(before.can_stop,false,'Run voice tests sequentially');
  await page.route('**/__qa/audio.wav',route=>route.fulfill({body:fs.readFileSync(wav),contentType:'audio/wav'}));
  await page.goto(base+'/__qa/file-voice');
  await page.evaluate(async()=>{
   document.body.innerHTML='<button id="start">Run file-only Chrome STT test</button>';
   window.__results=[];
   const R=window.SpeechRecognition||window.webkitSpeechRecognition,start=R.prototype.start,sources=new Map();
   navigator.mediaDevices.getUserMedia=async()=>{
    const audio=new AudioContext({sampleRate:48000}),destination=audio.createMediaStreamDestination(),source=audio.createBufferSource();destination.channelCount=1;
    source.buffer=await audio.decodeAudioData(await(await fetch('/__qa/audio.wav')).arrayBuffer());source.connect(destination);
    const track=destination.stream.getAudioTracks()[0],stop=track.stop.bind(track);sources.set(track.id,{source,audio});
    track.stop=()=>{try{source.stop();}catch{}stop();sources.delete(track.id);void audio.close();};
    return destination.stream;
   };
   R.prototype.start=function(track){
    const input=sources.get(track.id);if(!input)throw Error('Expected the injected WAV track');
    this.addEventListener('result',e=>{for(const result of e.results)if(result.isFinal)window.__results.push(result[0].transcript);});
    this.addEventListener('audiostart',()=>{void input.audio.resume().then(()=>input.source.start());},{once:true});
    return start.call(this,track);
   };
   const {ChromeVoice}=await import('/static/chrome-voice.js');const audio=new ChromeVoice();window.__audio=audio;
   audio.speak=command=>{window.__reply=command;};
   document.querySelector('button').onclick=async()=>{try{const clientId=await audio.prepare();const r=await fetch('/api/voice/wake',{method:'POST',headers:{'X-Voice-Client':clientId}});if(!r.ok)throw Error(await r.text());window.__session=(await r.json()).session_id;window.__started=true;}catch(e){window.__error=e.message;}};
  });
  await page.click('#start');await page.waitForFunction(()=>window.__started||window.__error,{},{timeout:20000});
  const startup=await page.evaluate(()=>({error:window.__error,session:window.__session}));if(startup.error)throw Error(startup.error);session=startup.session;
  await page.waitForFunction(()=>window.__reply||window.__error,{},{timeout:45000});
  const output=await page.evaluate(()=>({error:window.__error,results:window.__results,reply:window.__reply}));if(output.error)throw Error(output.error);
  assert.ok(output.results.some(text=>/재고/.test(text)),'A real final Chrome transcription is required');assert.equal(output.reply.session,session);
  const history=await(await page.request.get(base+'/api/voice/history')).json();assert.ok(history.messages.some(m=>m.session_id===session&&m.role==='user'&&/재고/.test(m.text)));
  console.log('PASS real Chrome online Korean STT with synthetic WAV and matching server session. No microphone or narration.',JSON.stringify(output));
 }finally{
  if(page){if(session){const s=await page.request.get(base+'/api/voice/status').then(r=>r.json()).catch(()=>null);if(s?.session_id===session)await page.request.post(base+'/api/voice/stop').catch(()=>{});}await page.evaluate(()=>window.__audio?.close()).catch(()=>{});}
  await browser.close();
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
