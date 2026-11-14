// One audio owner per browser tab. Only final results cross the session/turn boundary.
export class ChromeVoice {
  constructor(env=globalThis,{local=false}={}) {
    this.local=local;
    this.env=env;this.socket=null;this.clientId=null;this.connecting=null;this.recognition=null;this.stream=null;this.utterance=null;
    this.epoch=0;this.timer=null;this.heartbeat=null;this.active=null;
    env.addEventListener?.('pagehide',()=>this.close());
  }
  halt() {
    this.epoch++;this.env.clearTimeout(this.timer);this.timer=null;
    const r=this.recognition;this.recognition=null;
    if(r){r.onstart=r.onresult=r.onerror=r.onend=r.onspeechstart=r.onnomatch=null;try{r.abort();}catch{}}
    const stream=this.stream;this.stream=null;stream?.getTracks().forEach(track=>track.stop());
    if(this.utterance){this.utterance.onend=this.utterance.onerror=null;this.utterance=null;this.env.speechSynthesis.cancel();}
  }
  close() {this.halt();this.active=null;this.env.clearInterval(this.heartbeat);this.socket?.close();this.socket=null;this.clientId=null;}
  send(event,command=this.active,text='') {
    if(this.socket?.readyState===1)this.socket.send(JSON.stringify({event,session:command?.session,turn:command?.turn||0,text}));
  }
  fail(text,command=this.active) {this.halt();this.send('error',command,text);}
  async prepare() {
    if(this.socket?.readyState===1&&this.clientId)return this.clientId;
    if(this.connecting)return this.connecting;
    this.connecting=this.connect().finally(()=>{this.connecting=null;});
    return this.connecting;
  }
  async connect() {
    const w=this.env,R=w.SpeechRecognition||w.webkitSpeechRecognition,epoch=this.epoch;
    const current=()=>{if(this.epoch!==epoch)throw Error('Chrome 음성 준비가 취소되었습니다. 다시 시작하세요.');};
    if(!w.isSecureContext)throw Error('마이크를 사용하려면 Chrome에서 localhost 또는 HTTPS로 접속하세요.');
    if(!R||!w.speechSynthesis||!w.SpeechSynthesisUtterance)
      throw Error('이 브라우저는 음성 API를 지원하지 않습니다. 최신 데스크톱 Chrome을 사용하세요.');
    const policy=w.document?.permissionsPolicy||w.document?.featurePolicy;
    if(!this.local&&policy?.allowsFeature('on-device-speech-recognition'))
      throw Error('온라인 음성 인식 정책이 적용되지 않았습니다. 서버를 재시작하고 페이지를 새로고침하세요.');
    // Online recognition was explicitly authorized. Local mode remains opt-in for diagnostics.
    if(this.local){
      if(!('processLocally' in R.prototype)||!R.available||!R.install)
        throw Error('이 Chrome은 로컬 음성 API를 지원하지 않습니다. 최신 데스크톱 Chrome을 사용하세요.');
      // SODA also needs the default Live Caption pack when starting on a fresh profile.
      const options={langs:['ko-KR','en-US'],processLocally:true};
      let available=await R.available(options);current();
      if(available==='downloadable'||available==='downloading'){
        if(!await R.install(options))throw Error('Chrome 한국어 음성팩을 설치하지 못했습니다. 네트워크와 브라우저 설정을 확인하세요.');
        current();available=await R.available(options);current();
      }
      if(available!=='available')throw Error('이 Chrome에서는 한국어 로컬 음성 인식을 사용할 수 없습니다. 언어팩과 브라우저 버전을 확인하세요.');
    }
    // Chrome loads its synthesis voice list asynchronously on first access.
    const korean=()=>w.speechSynthesis.getVoices().filter(v=>/^ko(?:-|_)/i.test(v.lang));
    let voices=korean();
    if(!voices.length)await new Promise(resolve=>{
      const done=()=>{w.clearTimeout(timer);w.speechSynthesis.removeEventListener('voiceschanged',changed);resolve();};
      const changed=()=>{if(korean().length)done();};
      const timer=w.setTimeout(done,3000);w.speechSynthesis.addEventListener('voiceschanged',changed);changed();
    });
    current();voices=korean();
    if(!voices.length)throw Error('Chrome에서 사용할 한국어 읽기 음성을 설치한 뒤 다시 시작하세요.');
    this.voice=voices.find(v=>v.localService)||voices[0];
    return await new Promise((resolve,reject)=>{
      const url=new URL('/api/voice/browser',w.location.href);url.protocol=url.protocol==='https:'?'wss:':'ws:';
      const socket=new w.WebSocket(url);this.socket=socket;let ready=false;
      const timeout=w.setTimeout(()=>{socket.close();reject(Error('Chrome 음성 서버 연결 시간이 초과되었습니다.'));},10000);
      socket.onopen=()=>this.send('ready',null);
      socket.onmessage=event=>{
        if(this.socket!==socket||socket.readyState!==1)return;
        let command;try{command=JSON.parse(event.data);}catch{this.close();return;}
        if(command.action==='ready'){if(typeof command.client_id!=='string'||!command.client_id){w.clearTimeout(timeout);reject(Error('음성 서버를 업데이트하고 페이지를 새로고침하세요.'));this.close();return;}this.clientId=command.client_id;ready=true;w.clearTimeout(timeout);this.heartbeat=w.setInterval(()=>this.send('ping',null),5000);resolve(this.clientId);}
        else if(command.action==='error'){w.clearTimeout(timeout);reject(Error(command.text));this.close();}
        else this.command(command);
      };
      socket.onerror=()=>{if(!ready){w.clearTimeout(timeout);reject(Error('Chrome 음성 서버에 연결할 수 없습니다.'));}};
      socket.onclose=()=>{
        w.clearTimeout(timeout);
        if(this.socket===socket){w.clearInterval(this.heartbeat);this.socket=null;this.clientId=null;this.halt();this.active=null;}
        if(!ready)reject(Error('다른 탭의 음성 대기를 종료하고 다시 시작하세요.'));
      };
    });
  }
  command(command) {
    if(command.action==='stop'){
      if(this.active?.session===command.session){this.halt();this.active=null;}
      return;
    }
    if(!['listen','speak'].includes(command.action))return;
    this.halt();this.active=command;
    if(command.action==='listen')this.listen(command);else this.speak(command);
  }
  listen(command) {
    const w=this.env,R=w.SpeechRecognition||w.webkitSpeechRecognition,r=new R(),epoch=this.epoch;
    this.recognition=r;r.lang='ko-KR';r.processLocally=this.local;r.continuous=false;r.interimResults=false;r.maxAlternatives=1;
    let final='',failed=false,started=false,heard=false;
    const live=()=>this.epoch===epoch&&this.recognition===r;
    const stop=()=>{if(live())try{w.clearTimeout(this.timer);this.timer=w.setTimeout(()=>{if(live())this.fail('Chrome 마이크가 응답하지 않습니다. 다시 시작하세요.',command);},5000);r.stop();}catch{this.fail('마이크 청취를 종료하지 못했습니다.',command);}};
    r.onstart=()=>{if(live()){started=true;w.clearTimeout(this.timer);this.send('listening',command);this.timer=w.setTimeout(stop,6000);}};
    r.onspeechstart=()=>{if(live()){heard=true;w.clearTimeout(this.timer);this.timer=w.setTimeout(stop,30000);}};
    r.onresult=event=>{
      if(!live()||final)return;
      for(let i=event.resultIndex;i<event.results.length;i++)if(event.results[i].isFinal){final+=event.results[i][0].transcript;}
      if(final.trim())stop();
    };
    r.onnomatch=()=>{if(live())heard=true;};
    r.onerror=event=>{
      if(!live()||event.error==='no-speech')return;
      failed=true;
      const errors={'not-allowed':'Chrome의 마이크 권한을 허용하세요.','audio-capture':'마이크 연결과 Chrome의 마이크 접근 권한을 확인하세요.',
        'language-not-supported':'Chrome 한국어 로컬 언어팩을 확인하세요.','network':this.local?'Chrome 로컬 음성 인식 오류입니다. 언어팩을 확인하세요.':'Chrome 온라인 음성 인식에 연결하지 못했습니다. 인터넷 연결과 브라우저 정책을 확인하세요.',
        'service-not-allowed':'Chrome 설정 또는 조직 정책에서 음성 인식을 허용하세요.'};
      this.fail(errors[event.error]||'Chrome 음성 인식을 시작하지 못했습니다: '+event.error,command);
    };
    r.onend=()=>{
      if(!live()||failed)return;
      if(!started){this.fail('Chrome 마이크가 시작되기 전에 종료되었습니다. 권한을 확인하세요.',command);return;}
      if(heard&&!final.trim()){this.fail('Chrome이 발화를 감지했지만 한국어 인식 결과를 반환하지 않았습니다. '+(this.local?'브라우저 버전과 로컬 언어팩을':'인터넷 연결과 Chrome 음성 인식 설정을')+' 확인한 뒤 다시 시작하세요.',command);return;}
      this.halt();this.send(final.trim()?'final':'timeout',command,final.trim());
    };
    this.send('permission',command);
    this.timer=w.setTimeout(()=>{if(live())this.fail('Chrome 마이크 시작 시간이 초과되었습니다. 권한을 확인하세요.',command);},15000);
    const media=w.navigator?.mediaDevices;
    if(!media?.getUserMedia){this.fail('이 브라우저에서는 마이크를 사용할 수 없습니다. 최신 Chrome의 localhost 또는 HTTPS 페이지를 사용하세요.',command);return;}
    // Half-duplex playback already prevents feedback. Explicit capture avoids the
    // native recognition capture path suppressing speech as speaker echo.
    try{
      Promise.resolve(media.getUserMedia({audio:{echoCancellation:false,noiseSuppression:true,autoGainControl:true,channelCount:1}})).then(stream=>{
        if(!live()){stream.getTracks().forEach(track=>track.stop());return;}
        this.stream=stream;
        try{const track=stream.getAudioTracks()[0];if(!track)throw Error('사용 가능한 마이크 트랙이 없습니다.');r.start(track);}
        catch(error){this.fail('Chrome 마이크를 시작하지 못했습니다: '+error.message,command);}
      }).catch(error=>{
        if(!live())return;
        const message=error.name==='NotAllowedError'?'Chrome의 마이크 권한을 허용하세요.':error.name==='NotFoundError'?'연결된 마이크를 찾을 수 없습니다.':'마이크를 열지 못했습니다: '+error.message;
        this.fail(message,command);
      });
    }catch(error){if(live())this.fail('Chrome 마이크를 열지 못했습니다: '+error.message,command);}
  }
  speak(command) {
    const w=this.env,u=new w.SpeechSynthesisUtterance(command.text),epoch=this.epoch;
    this.utterance=u;u.lang='ko-KR';u.voice=this.voice;u.rate=1;
    const live=()=>this.epoch===epoch&&this.utterance===u;
    u.onend=()=>{if(live()){this.utterance=null;w.clearTimeout(this.timer);this.send('spoken',command);}};
    u.onerror=event=>{if(live())this.fail('Chrome 음성 재생 오류: '+event.error,command);};
    this.timer=w.setTimeout(()=>{if(live())this.fail('Chrome 음성 재생 시간이 초과되었습니다. 대화 시작을 다시 누르세요.',command);},120000);
    try{w.speechSynthesis.speak(u);}catch(error){this.fail('Chrome 음성 재생 실패: '+error.message,command);}
  }
}
let chromeVoice;
export function prepareChromeVoice(){chromeVoice??=new ChromeVoice();return chromeVoice.prepare();}

export function chromeVoiceClientId(){return chromeVoice?.clientId||null;}
