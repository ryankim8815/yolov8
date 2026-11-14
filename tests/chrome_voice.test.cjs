const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const source=fs.readFileSync('app/static/chrome-voice.js','utf8');
const modulePromise=import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
function environment(){
 const records=[],timers=new Map();let timer=0;
 class Recognition {
  static available=async options=>{records.push(['available',options]);return 'available';};
  static install=async()=>true;
  start(track){this.track=track;records.push(['start',this]);this.onstart?.();}
  stop(){records.push(['stop',this]);}
  abort(){records.push(['abort',this]);}
 }
 Recognition.prototype.processLocally=false;
 class Socket {
  constructor(){this.readyState=0;queueMicrotask(()=>{this.readyState=1;this.onopen();});}
  send(raw){const data=JSON.parse(raw);records.push(['send',data]);if(data.event==='ready')queueMicrotask(()=>this.onmessage({data:'{"action":"ready","client_id":"browser-client"}'}));}
  close(){this.readyState=3;this.onclose?.();}
 }
 class Utterance {constructor(text){this.text=text;}}
 const env={SpeechRecognition:Recognition,WebSocket:Socket,SpeechSynthesisUtterance:Utterance,isSecureContext:true,
  navigator:{mediaDevices:{async getUserMedia(options){records.push(['capture',options]);const track={stopped:false,stop(){this.stopped=true;records.push(['release',this]);}};return {getTracks:()=>[track],getAudioTracks:()=>[track]};}}},
  location:{href:'http://localhost:8080/'},setTimeout(fn,ms){const id=++timer;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},
  setInterval(){return ++timer;},clearInterval(){},speechSynthesis:{getVoices:()=>[{lang:'ko-KR',localService:true,name:'Korean'}],speak:u=>records.push(['speak',u]),cancel:()=>records.push(['cancel']),addEventListener(){},removeEventListener(){}}};
 return {env,records,timers,Recognition,sent:()=>records.filter(r=>r[0]==='send').map(r=>r[1])};
}
const listen=async(voice,turn=1)=>{voice.command({action:'listen',session:'session',turn});await new Promise(setImmediate);};
const final=text=>({resultIndex:0,results:[Object.assign([{transcript:text}],{isFinal:true})]});
test('prepares local Korean recognition once and selects Chrome Korean voice',async()=>{
 const {ChromeVoice}=await modulePromise,e=environment(),v=new ChromeVoice(e.env,{local:true});
 assert.deepEqual(await Promise.all([v.prepare(),v.prepare()]),['browser-client','browser-client']);
 assert.equal(e.records.filter(r=>r[0]==='available').length,1);
 assert.deepEqual(e.records[0][1],{langs:['ko-KR','en-US'],processLocally:true});assert.equal(v.voice.lang,'ko-KR');v.close();
});
test('unsupported API, insecure context and unavailable pack never fall back to cloud',async()=>{
 const {ChromeVoice}=await modulePromise;
 for(const mode of ['insecure','unsupported','unavailable','install-failed']){
  const e=environment();
  if(mode==='insecure')e.env.isSecureContext=false;
  if(mode==='unsupported')delete e.Recognition.prototype.processLocally;
  if(mode==='unavailable')e.Recognition.available=async()=> 'unavailable';
  if(mode==='install-failed'){e.Recognition.available=async()=> 'downloadable';e.Recognition.install=async()=>false;}
  await assert.rejects(new ChromeVoice(e.env,{local:true}).prepare());assert.equal(e.records.some(r=>r[0]==='start'),false);
 }
});
test('downloadable pack installs then verifies readiness',async()=>{
 const {ChromeVoice}=await modulePromise,e=environment();let installed=false;
 e.Recognition.available=async()=>installed?'available':'downloadable';e.Recognition.install=async()=>installed=true;
 const v=new ChromeVoice(e.env,{local:true});await v.prepare();assert.ok(installed);v.close();
});
test('only finals are sent after microphone ends, synthesis releases before next turn',async()=>{
 const {ChromeVoice}=await modulePromise,e=environment(),v=new ChromeVoice(e.env,{local:true});await v.prepare();await listen(v);
 const r=v.recognition;assert.ok(r.track);assert.equal(r.processLocally,true);assert.equal(r.lang,'ko-KR');
 r.onresult({resultIndex:0,results:[[{transcript:'interim'}]]});assert.equal(e.sent().some(r=>r.event==='final'),false);
 r.onresult(final('재고 알려줘'));const late=r.onresult;
 assert.equal(e.sent().some(r=>r.event==='final'),false);r.onend();
 assert.equal(e.sent().filter(r=>r.event==='final').length,1);
 v.command({action:'speak',session:'session',turn:1,text:'재고입니다.'});
 assert.equal(v.recognition,null);assert.equal(r.track.stopped,true);assert.equal(v.stream,null);assert.equal(v.utterance.text,'재고입니다.');
 late(final('주문 확정'));assert.equal(e.sent().filter(r=>r.event==='final').length,1);
 const u=v.utterance;u.onend();assert.equal(e.sent().at(-1).event,'spoken');await listen(v,2);assert.equal(e.sent().at(-1).turn,2);v.close();
});
test('stop and disconnect cancel playback and ignore late microphone callbacks',async()=>{
 const {ChromeVoice}=await modulePromise,e=environment(),v=new ChromeVoice(e.env,{local:true});await v.prepare();await listen(v);
 const result=v.recognition.onresult,end=v.recognition.onend;
 v.command({action:'stop',session:'old',turn:1});assert.ok(v.recognition);
 v.command({action:'stop',session:'session',turn:1});result(final('주문 확정'));end();
 assert.equal(e.sent().some(r=>r.event==='final'),false);assert.equal(v.recognition,null);
 v.command({action:'speak',session:'session',turn:2,text:'안내'});const spoken=v.utterance.onend;
 v.close();spoken();assert.ok(e.records.some(r=>r[0]==='cancel'));assert.equal(e.sent().some(r=>r.event==='spoken'),false);
});
test('permission error, no speech, start hang and stop hang terminate predictably',async()=>{
 const {ChromeVoice}=await modulePromise;
 for(const mode of ['permission','silence','start-hang','stop-hang','early-end']){
  const e=environment();if(mode==='start-hang')e.Recognition.prototype.start=function(){};
  if(mode==='early-end')e.Recognition.prototype.start=function(){this.onend();};
  const v=new ChromeVoice(e.env,{local:true});await v.prepare();await listen(v);const r=v.recognition;
  if(mode==='permission')r.onerror({error:'not-allowed'});
  if(mode==='silence'){r.onerror({error:'no-speech'});r.onend();}
  if(mode==='start-hang')[...e.timers.values()].find(t=>t.ms===15000).fn();
  if(mode==='stop-hang'){r.onresult(final('재고'));[...e.timers.values()].find(t=>t.ms===5000).fn();}
  assert.equal(e.sent().at(-1).event,mode==='silence'?'timeout':'error');assert.equal(v.recognition,null);v.close();
 }
});

test('closing during model preparation cannot open a late socket or install a pack',async()=>{
 const {ChromeVoice}=await modulePromise,e=environment();let release,installed=false;
 e.Recognition.available=()=>new Promise(resolve=>{release=resolve;});e.Recognition.install=async()=>{installed=true;return true;};
 const v=new ChromeVoice(e.env,{local:true}),preparing=v.prepare();v.close();release('downloadable');
 await assert.rejects(preparing,/취소/);assert.equal(v.socket,null);assert.equal(installed,false);assert.deepEqual(e.sent(),[]);
});

test('speech without a final result is an explicit recognition failure, not silent timeout',async()=>{
 const {ChromeVoice}=await modulePromise;
 for(const event of ['speechstart','nomatch']){
  const e=environment(),v=new ChromeVoice(e.env,{local:true});await v.prepare();await listen(v);const r=v.recognition;
  r['on'+event]();r.onend();
  assert.equal(e.sent().at(-1).event,'error');assert.match(e.sent().at(-1).text,/인식 결과/);
  assert.equal(v.recognition,null);assert.equal(e.sent().some(e=>e.event==='final'),false);v.close();
 }
});

test('authorized default uses Chrome online STT without installing local packs',async()=>{
 const {ChromeVoice}=await modulePromise,e=environment();delete e.Recognition.available;delete e.Recognition.install;delete e.Recognition.prototype.processLocally;
 const v=new ChromeVoice(e.env);await v.prepare();await listen(v);assert.equal(v.recognition.processLocally,false);
 assert.equal(e.records.some(r=>r[0]==='available'),false);v.recognition.onerror({error:'network'});
 assert.equal(e.sent().at(-1).event,'error');assert.match(e.sent().at(-1).text,/온라인/);v.close();
});

test('online STT refuses a document that still permits Chrome to prefer local SODA',async()=>{
 const {ChromeVoice}=await modulePromise,e=environment();e.env.document={featurePolicy:{allowsFeature:()=>true}};
 const v=new ChromeVoice(e.env);await assert.rejects(v.prepare(),/정책/);assert.equal(e.sent().length,0);
});

test('a delayed close from an old socket cannot cancel the new owner heartbeat',async()=>{
 const {ChromeVoice}=await modulePromise,e=environment(),cleared=[];e.env.clearInterval=id=>cleared.push(id);
 const v=new ChromeVoice(e.env);await v.prepare();const old=v.socket,lateClose=old.onclose;
 old.close=function(){this.readyState=3;};v.close();await v.prepare();const current=v.socket,heartbeat=v.heartbeat;
 lateClose();assert.equal(v.socket,current);assert.equal(cleared.includes(heartbeat),false);assert.equal(v.clientId,'browser-client');v.close();
});

test('permission granted after cancellation releases its stream without starting recognition',async()=>{
 const {ChromeVoice}=await modulePromise,e=environment();let release;
 e.env.navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{release=resolve;});
 const v=new ChromeVoice(e.env);await v.prepare();await listen(v);v.close();
 const track={stopped:false,stop(){this.stopped=true;}};
 release({getTracks:()=>[track],getAudioTracks:()=>[track]});await new Promise(setImmediate);
 assert.equal(track.stopped,true);assert.equal(e.records.some(r=>r[0]==='start'),false);assert.equal(v.stream,null);
});
test('microphone denial is reported and a failed recognition start releases capture',async()=>{
 const {ChromeVoice}=await modulePromise;
 for(const failure of ['permission','start']){
  const e=environment();
  if(failure==='permission')e.env.navigator.mediaDevices.getUserMedia=async()=>{throw Object.assign(Error('denied'),{name:'NotAllowedError'});};
  else e.Recognition.prototype.start=function(){throw Error('start failed');};
  const v=new ChromeVoice(e.env);await v.prepare();await listen(v);assert.equal(e.sent().at(-1).event,'error');
  if(failure==='start')assert.ok(e.records.some(r=>r[0]==='release'));
  assert.equal(v.stream,null);assert.equal(v.recognition,null);v.close();
 }
});
