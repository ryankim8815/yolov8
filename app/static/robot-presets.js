import {api} from './robot-camera-frame.js';
import {endpointIK,poseFrame,simulationToolPose} from './robot-arm.js?v=joint-targets';
import {connectPresetDetection} from './robot-preset-detection.js?v=voice-class';

const cache=new Map();let selected=new URLSearchParams(location.search).get('preset');
const names={movej:'관절 이동',movel:'직선 이동',movec:'원호 이동',gripper:'그리퍼',wait:'시간 대기',grasp:'자동 파지',place:'박스 놓기',prepare:'대기 상태 준비',checkpoint:'객체 좌표 확인'};
const groupKinds=new Set(['grasp','place','prepare']);
const uid=()=>crypto.randomUUID().replaceAll('-','');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const at=(obj,key)=>key.split('.').reduce((v,k)=>v?.[k],obj);
function put(obj,key,value){const keys=key.split('.');let parent=obj;for(const k of keys.slice(0,-1))parent=parent[k]??={};parent[keys.at(-1)]=value;}
const percentages=value=>Array.from({length:10},(_,i)=>{const n=(i+1)*10;return `<option value="${n}" ${n===value?'selected':''}>${n}%</option>`;}).join('');
const numberInput=(key,value,label)=>`<label>${label}<input type="number" step="any" data-field="${key}" value="${esc(value)}"></label>`;
const terminal=state=>['completed','failed','unknown','cancelled'].includes(state);

export function connectPresets(root,arm,signal){
  root.innerHTML=`<div class="preset-heading"><div><h3>경로 편집</h3><p class="scenario-caption">저장한 경로를 선택하고 단계와 음성 명령을 설정하세요.</p></div><div class="preset-preview-entry"><a href="#preset-execution">시뮬레이션으로 미리보기 ↓</a><span data-p="saved" class="scenario-badge">조회 중</span></div></div>
    <div class="preset-layout"><aside class="preset-library"><div class="preset-library-head"><h4>내 프리셋</h4><button type="button" data-action="new">＋ 추가</button></div><div data-p="list"></div></aside>
    <section class="preset-detail"><div class="preset-edit-head"><label>프리셋 이름<input data-field="name" maxlength="80"></label><button type="button" data-action="copy">복제</button></div>
    <section data-p="object-source" class="preset-object-source" aria-label="객체 정보 출처"></section>
    <div class="preset-fields"><label>실행 범위<select data-p="range"><option value="all">전체 경로</option><option value="custom">단계 구간 지정</option></select></label><label data-range-field hidden>시작 단계<select data-p="start"></select></label><label data-range-field hidden>종료 단계<select data-p="end"></select></label></div>
    <details class="preset-coordinates" open><summary>객체·경유점·박스 좌표</summary><div data-p="coordinates"></div><button type="button" data-action="import-box">택배 박스 크기·위치 복사</button></details>
    <div class="preset-step-add"><h4>단계별 조인트 설정 · °</h4><label>추가할 동작<select data-p="kind">${Object.entries(names).filter(([k])=>!['prepare','checkpoint'].includes(k)).map(([v,t])=>`<option value="${v}">${t}</option>`).join('')}</select></label><button type="button" data-action="add">단계 추가</button></div>
    <p class="scenario-caption">자동 묶음은 내부 좌표와 순서를 잠급니다. 동작 속도 100%는 현재 허용 상한(관절 10°/s · 직선 10 mm/s · 그리퍼 10 rpm)입니다. 그리퍼 행에서 벌림과 접촉 파지를 설정하며, 다른 행에서는 그리퍼 상태를 유지합니다.</p>
    <div class="preset-table-scroll"><table class="scenario-joint-table preset-table"><thead><tr><th>단계</th><th>이동 방식</th><th>동작 속도</th><th>입력 방식</th>${[1,2,3,4,5,6].map(i=>'<th>J'+i+'</th>').join('')}<th>벌림 기준</th><th>벌림 (mm)</th><th>접촉 파지</th></tr></thead><tbody data-p="steps"></tbody></table></div>
    <details class="preset-voice-binding"><summary>음성 명령 연결</summary><div class="preset-edit-head"><h4>등록 문장과 확인 방식</h4><label class="preset-check"><input type="checkbox" data-field="voice_enabled">음성 사용</label></div><label>등록 명령 · 한 줄에 하나<textarea data-p="aliases" rows="2" placeholder="로봇 A박스 포장"></textarea></label><label>실행 확인<select data-field="confirmation"><option value="screen">화면에서 승인 후 실행</option><option value="voice">‘로봇 실행’으로 음성 재확인</option></select></label><button type="button" data-action="use-transcript" disabled>최근 인식문을 명령에 추가</button><p class="scenario-caption">공통 명령: 로봇 실행 · 로봇 취소 · 로봇 중단 · 음성 대기 종료</p></details>
    <div class="pose-actions"><button type="button" data-action="save">프리셋 저장</button><button type="button" data-action="discard">변경 취소</button><button type="button" data-action="reload">최신 설정 불러오기</button></div><p data-p="message" role="status"></p></section></div>
    <section class="preset-player" id="preset-execution"><div class="panel-head"><h4>경로 시뮬레이션 · 실제 실행</h4><span data-p="count"></span></div><section class="preset-simulation-guide" aria-label="장비 없이 시뮬레이션"><div class="preset-edit-head"><h5>로봇 연결 없이 가상으로 테스트하세요</h5><span data-p="simulation-connection" class="scenario-badge">연결 확인 중</span></div><p>저장된 좌표나 편집 중인 좌표로 미리 볼 수 있습니다. 좌표가 아직 없다면 예시 경로로 먼저 체험하세요.</p><div class="pose-actions"><label>예시 작업<select data-p="demo-region"><option value="floor">바닥 · 수직 파지</option><option value="shelf">선반 · 수평 파지</option></select></label><button type="button" data-action="demo">예시 17단계 체험</button></div><p class="scenario-caption">예시는 현재 프리셋과 별개의 가상 경로입니다. 프리셋·작업 좌표를 저장하거나 로봇·마이크를 작동하지 않습니다.</p></section><details class="preset-simulation-settings" open><summary>시뮬레이션 객체 설정</summary><div data-p="simulation-settings"></div></details><section class="preset-readiness" aria-label="실행 준비 상태"><div class="preset-edit-head"><h5>서비스 연결 · 프리셋 준비 상태</h5><button type="button" data-action="refresh-readiness">상태 다시 확인</button></div><p data-p="native-status" role="status">카메라·음성 서비스 확인 중</p><p data-p="robot-status" role="status">실제 로봇 연결 확인 중</p><div data-p="requirements"></div><div class="pose-actions"><a href="/training#live">카메라 설정</a><a href="#manipulator">로봇 연결 상태</a></div></section><div class="pose-actions"><label>실행 대상 · 수동·음성 공통<select data-p="voice-target"><option value="simulation">시뮬레이션</option><option value="hardware">실제 로봇</option></select></label><button type="button" data-action="play">시뮬레이션 시작</button><button type="button" data-action="pause">일시정지</button><button type="button" data-action="confirm-simulation" hidden>가상 파지 확인 후 이송</button><button type="button" data-action="sim-stop">가상 재생 종료</button><label>재생 배속<select data-p="rate"><option>1</option><option>5</option><option selected>10</option><option>20</option></select></label></div><p data-p="simulation-context" class="preset-simulation-context"></p><label class="simulation-progress preset-playback-progress">전체 진행<input data-p="progress" type="range" min="0" max="1000" value="0" disabled><output data-p="percent">0%</output></label><p data-p="simulation" role="status">경로를 불러오는 중입니다.</p><details data-p="simulation-errors" class="preset-simulation-errors" hidden><summary>경로 계산 오류 자세히 보기</summary><p data-p="simulation-error-detail"></p></details><p data-p="job" role="status" hidden></p>
    <section class="preset-voice-console"><div class="preset-edit-head"><h4>음성 대기</h4><span data-p="mic-state" class="scenario-badge">청취 종료</span></div><div class="pose-actions"><button type="button" data-action="listen">음성 대기 시작</button><button type="button" data-action="unlisten">음성 대기 종료</button></div><p class="scenario-caption">마이크 입력은 Mac 음성 서비스를 사용합니다. 종료 전까지 연속 대기합니다. 청취 종료와 로봇 작업 중단은 별개입니다.</p><div data-p="class-gate" class="preset-class-gate" hidden></div><p data-p="transcript"></p><p data-p="voice-message" role="status"></p><div data-p="voice-selection" class="preset-pending preset-voice-selection" hidden></div><div data-p="voice-pending" class="preset-pending" hidden></div>
    <details class="preset-command-tests"><summary>고급 · 문장 입력 테스트</summary><label>문장 입력 테스트 · 실제 장비 실행 불가<input data-p="text" placeholder="등록한 명령을 입력하세요"></label><label data-p="test-class-field" hidden>테스트 클래스 · 현재 모델의 이름 한 개<input data-p="test-class" placeholder="예: 스팸 · 모의 입력 전용"></label><div class="pose-actions"><button type="button" data-action="text-test">명령 테스트</button><button type="button" data-action="test-play" disabled>테스트 결과 시뮬레이션</button></div><p data-p="test-result" role="status"></p><div data-p="test-targets" class="preset-detection-candidates"></div></details></section></section>
    <dialog data-p="dialog" aria-labelledby="preset-execution-title"><h3 id="preset-execution-title">실제 프리셋 실행 승인</h3><p data-p="approval-summary"></p><pre data-p="approval-path" class="scenario-hardware-path"></pre><p data-p="approval-status" role="status"></p><div class="pose-actions"><button type="button" data-action="cancel">승인 요청 취소</button><button type="button" data-action="approve">승인 후 실제 실행</button></div></dialog>`;
  const ui=Object.fromEntries([...root.querySelectorAll('[data-p]')].map(n=>[n.dataset.p,n]));
  const on=(el,event,fn)=>el.addEventListener(event,fn,{signal});
  let playingRecipe=null,playbackSerial=0;
  let presets=[],draft=null,dirty=false,busy=false,realBusy=false,conflict=false,recipe=null,testRecipe=null,previewTimer,pollTimer,epoch=0,ticket=null,ticketTimer,lastVoiceSimulation=null,simulation={state:'idle',step:0};
  let voicePending=null,voiceSelection=null,voicePreparation=null,voiceClass=null,lastTranscript='',lastStopSerial=null,testBinding=null,textRequest=0;
  let voiceBusy=false,voiceListening=false,voiceCanStop=false,pollEpoch=0;
  let readinessBusy=false,readinessTimer,robotConnected=false,requirementsSignature='',demoRequest=0,demoController=null;
  const message=(text,error=false)=>{ui.message.textContent=text;ui.message.dataset.error=error;};
  const detection=connectPresetDetection(ui['object-source'],{getDraft:()=>draft,onChange:()=>changed(true),onPrepare:()=>void hardware(null,true),signal});
  const snapshot=()=>{if(draft)cache.set(draft.id,{draft:structuredClone(draft),dirty});};
  function cancelDemo(){demoRequest++;if(demoController){demoController.abort();demoController=null;busy=false;}}
  function invalidate(keepDetection=false){epoch++;cancelDemo();clearTimeout(previewTimer);recipe=null;arm.simulationAction('stop');arm.setScenarioPreview(null);cancelTicket();if(!keepDetection)detection.reset();}
  function cancelTicket(){clearTimeout(ticketTimer);if(ticket){void api('pick/cancel','POST',{approval_id:ticket.approval_id}).catch(()=>{});ticket=null;}if(ui.dialog.open)ui.dialog.close();}
  const simulationActive=()=>['planning','running','paused','awaiting_grip','awaiting_open'].includes(simulation.state);
  function controls(){
    ui.saved.textContent=conflict?'다른 화면에서 변경됨':dirty?'저장 전 변경':'저장됨';
    for(const scope of [root])for(const button of scope.querySelectorAll('[data-action="save"]'))button.disabled=!draft||!dirty||busy||realBusy||conflict;
    for(const scope of [root])for(const button of scope.querySelectorAll('[data-action="discard"]'))button.disabled=!dirty||busy||realBusy;
    for(const action of ['new','copy','add','import-box'])root.querySelector(`[data-action="${action}"]`).disabled=!draft||busy||realBusy||voiceBusy||(action==='copy'&&(dirty||conflict));
    root.querySelector('[data-action="reload"]').disabled=busy||realBusy||voiceBusy;
    for(const button of root.querySelectorAll('[data-action="import-example"]'))button.disabled=!draft||busy||realBusy||voiceBusy;
    const hardwareTarget=ui['voice-target'].value==='hardware',needsYolo=draft?.object_source==='yolo'&&!usesSimulationObject(),needsSaved=hardwareTarget||needsYolo;
    root.querySelector('[data-action="play"]').disabled=!draft||simulationActive()||(!needsYolo&&(!recipe||recipe.errors.length>0))||(needsSaved&&(dirty||conflict))||busy||realBusy||voiceBusy||(hardwareTarget&&!robotConnected);
    root.querySelector('[data-action="play"]').textContent=hardwareTarget?'실제 프리셋 실행':'시뮬레이션 시작';
    root.querySelector('[data-action="pause"]').disabled=!['running','paused'].includes(simulation.state);
    root.querySelector('[data-action="pause"]').textContent=simulation.state==='paused'?'계속 재생':'일시정지';
    const confirmation=root.querySelector('[data-action="confirm-simulation"]');confirmation.hidden=!['awaiting_grip','awaiting_open'].includes(simulation.state);confirmation.textContent=simulation.state==='awaiting_open'?'가상 박스에서 열기':'가상 파지 확인 후 이송';
    root.querySelector('[data-action="sim-stop"]').disabled=simulation.state==='idle'&&!demoController;
    root.querySelector('[data-action="test-play"]').disabled=!testRecipe||busy||realBusy||simulationActive();
    root.querySelector('[data-action="demo"]').disabled=!draft||busy||realBusy||voiceBusy||simulationActive()||hardwareTarget;
    ui['demo-region'].disabled=busy||realBusy||voiceBusy||simulationActive()||hardwareTarget;
    ui.progress.disabled=!['running','paused','awaiting_grip','awaiting_open','complete'].includes(simulation.state);
    ui['simulation-connection'].textContent=robotConnected?'로봇 연결됨 · 가상 테스트 가능':'로봇 미연결 · 가상 테스트 가능';
    ui.job.hidden=!hardwareTarget&&!realBusy;
    root.querySelector('[data-action="use-transcript"]').disabled=!lastTranscript||busy||realBusy;
    for(const button of root.querySelectorAll('[data-select]'))button.disabled=busy||realBusy||voiceBusy;
    for(const button of root.querySelectorAll('[data-op]')){
      button.disabled=busy||realBusy||voiceBusy||(button.dataset.op==='execute'&&(simulationActive()||needsSaved&&(dirty||conflict)||hardwareTarget&&!robotConnected));
      if(button.dataset.op==='execute')button.textContent=ui['voice-target'].value==='hardware'?'이 단계 실제 실행':'이 단계 시뮬레이션';
    }
    for(const input of root.querySelectorAll('[data-field],[data-joint],[data-node-field],[data-node-value],[data-prepare-speed],[data-grasp-mode],[data-simulation-mode], [data-p="aliases"], [data-p="range"],[data-p="start"],[data-p="end"]'))input.disabled=busy||realBusy||voiceBusy||input.hasAttribute('data-locked');
    detection.controls({busy:busy||voiceBusy,locked:realBusy||simulationActive(),dirty:dirty||conflict});
    for(const button of root.querySelectorAll('[data-action="voice-approve"],[data-action="voice-select"],[data-action="voice-prepare"],[data-action="class-retry"]'))button.disabled=busy||realBusy||dirty||conflict||voiceBusy||button.hasAttribute('data-invalid');
    root.querySelector('[data-action="listen"]').disabled=voiceBusy||voiceListening;
    root.querySelector('[data-action="unlisten"]').disabled=voiceBusy||!voiceCanStop;
    ui['voice-target'].disabled=busy||realBusy||voiceBusy||voiceCanStop;
    ui['test-class-field'].hidden=draft?.object_source!=='yolo';
    root.querySelector('[data-action="refresh-readiness"]').disabled=readinessBusy;
    for(const select of root.querySelectorAll('[data-pose-source]'))select.disabled=busy||realBusy||voiceBusy||select.options.length<2;
    for(const button of root.querySelectorAll('[data-action="import-joints"],[data-action="import-tcp"]'))button.disabled=busy||realBusy||voiceBusy||!root.querySelector(`[data-pose-source="${button.dataset.destination}"]`)?.value;
    for(const button of root.querySelectorAll('[data-action="capture-box"],[data-action="capture-grasp"]'))button.disabled=busy||realBusy||voiceBusy||!robotConnected;
  }
  function list(){ui.list.innerHTML=presets.map(p=>`<button type="button" class="preset-list-item" data-select="${p.id}" aria-pressed="${p.id===draft?.id}"><strong>${esc(p.name)}</strong><small>${p.steps.length}개 동작·묶음 · ${p.voice_enabled?esc(p.aliases[0]||'명령 미등록'):'음성 사용 안 함'}</small></button>`).join('');}
  const validVector=value=>Array.isArray(value)&&value.length===6&&value.every(Number.isFinite);
  function taughtStep(p,space){const step=p.steps.length===1?p.steps[0]:null;return step&&['movej','movel','movec'].includes(step.kind)&&step.space===space&&step.source==='explicit'&&!step.reference_id&&validVector(step.target)?step:null;}
  function sourcePicker(destination,space){
    const sources=presets.filter(p=>taughtStep(p,space)),label=space==='joint'?'저장 자세':'저장 TCP';
    return `<div class="preset-source-copy"><label>${label} 선택<select data-pose-source="${destination}"><option value="">${sources.length?label+'를 선택하세요':label+' 프리셋 없음'}</option>${sources.map(p=>`<option value="${p.id}">${esc(p.name)} · ${esc(p.revision.slice(0,8))}</option>`).join('')}</select></label><button type="button" data-action="${space==='joint'?'import-joints':'import-tcp'}" data-destination="${destination}" disabled>선택한 ${label} 불러오기</button></div>`;
  }
  function configurationIssues(){
    if(!draft)return [];
    const nodes=draft.steps.flatMap(step=>[step,...step.children||[]]),issues=[];
    if(nodes.some(s=>['waypoint1','waypoint2'].includes(s.source))&&!validVector(draft.context.waypoint1_joints))issues.push(['context.waypoint1_joints.0','1차 경유 관절각 J1~J6를 설정하세요.']);
    if(nodes.some(s=>s.kind==='place'||['box','above_box'].includes(s.source))&&!validVector(draft.box_pose))issues.push(['box_pose.0','박스 놓기 TCP X·Y·Z·A·B·C를 설정하세요.']);
    return issues;
  }
  function renderRequirements(){
    const issues=configurationIssues(),signature=JSON.stringify(issues);if(signature===requirementsSignature)return;requirementsSignature=signature;
    ui.requirements.innerHTML=issues.length?`<strong>입력할 작업 좌표 ${issues.length}개</strong>${issues.map(([field,label])=>`<div class="preset-requirement"><span>${label}</span><button type="button" data-configure-field="${field}">입력 위치로 이동</button></div>`).join('')}<p class="scenario-caption">좌표를 입력하거나 저장 자세를 불러오면 저장 전에도 시뮬레이션할 수 있습니다. 실제 실행 전에는 프리셋을 저장하세요.</p>`:'';
  }
  function configureField(field){
    const input=root.querySelector(`[data-field="${CSS.escape(field)}"]`);if(!input)return;
    for(let parent=input.parentElement;parent&&parent!==root;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
    input.scrollIntoView({block:'center',behavior:'smooth'});input.focus({preventScroll:true});
  }
  async function copyTaught(destination,space){
    const id=root.querySelector(`[data-pose-source="${destination}"]`)?.value,source=presets.find(p=>p.id===id);if(!source||busy||realBusy||voiceBusy)return;
    busy=true;controls();try{
      const latest=await api('presets/'+source.id,'GET',undefined,signal);if(latest.revision!==source.revision)throw Error('저장 자세가 변경되었습니다. 최신 설정을 불러온 뒤 선택하세요.');
      const step=taughtStep(latest,space);if(!step)throw Error('직접 교시한 한 단계 프리셋을 선택하세요.');
      put(draft,destination,structuredClone(step.target));changed(true);
      message(`${source.name} · 저장 버전 ${source.revision.slice(0,8)}의 ${space==='joint'?'관절각':'TCP'}을 초안에 불러왔습니다. 확인 후 프리셋을 저장하세요.`);
    }finally{busy=false;controls();}
  }
  function pollReadiness(){if(signal.aborted)return;if(document.hidden||root.closest('[data-manipulator-panel]').hidden)readinessTimer=setTimeout(pollReadiness,5000);else void refreshReadiness();}
  async function refreshReadiness(){
    if(readinessBusy||signal.aborted)return;clearTimeout(readinessTimer);readinessBusy=true;controls();
    const requestSignal=AbortSignal.any([signal,AbortSignal.timeout(5000)]);
    try{
      const results=await Promise.allSettled([
        fetch('/api/status',{cache:'no-store',signal:requestSignal}).then(async r=>{if(!r.ok)throw Error();return r.json();}),
        api('status','GET',undefined,requestSignal).then(async status=>{let host=null,hostError='';if(status.config.access_backend==='mac-sdk')try{host=await api('host-access/status','GET',undefined,requestSignal);}catch(error){hostError=error.message;}return {status,host,hostError};})
      ]);
      if(signal.aborted)return;
      const [native,robot]=results;
      ui['native-status'].textContent=native.status==='fulfilled'?`카메라·음성 서비스 연결됨 · ${native.value.ready?'탐지 중':native.value.state==='camera_off'?'카메라 꺼짐 · 카메라 설정에서 시작하세요.':native.value.state}`:'카메라·음성 서비스 연결 안 됨 · Mac 웹 서비스를 실행한 뒤 상태를 다시 확인하세요.';
      if(robot.status==='fulfilled'){
        const {status,host,hostError}=robot.value;
        robotConnected=!hostError&&(host?host.connection==='connected'&&host.initialized:status.bridge_connected&&['live','monitoring'].includes(status.state));
        ui['robot-status'].textContent=hostError?'Mac SDK 서비스 연결 안 됨 · '+hostError:host?(robotConnected?`실제 로봇 연결됨 · ${host.robot_state||'상태 확인 중'} · ${host.operation_mode||'운전 모드 확인 중'}`:'실제 로봇 연결 안 됨 · '+(host.detail||host.motion_reason||'유선 연결과 SDK 서비스를 확인하세요.')):robotConnected?'ROS 로봇 연결됨':'실제 로봇 연결 안 됨 · 로봇 모니터링에서 연결 상태를 확인하세요.';
      }else{robotConnected=false;ui['robot-status'].textContent='로봇 웹 서비스 연결 안 됨 · 상태를 다시 확인하세요.';}
    }finally{readinessBusy=false;if(!signal.aborted){controls();readinessTimer=setTimeout(pollReadiness,5000);}}
  }
  const defaultABC=region=>region==='floor'?[0,180,0]:[180,90,90];
  const usesSimulationObject=()=>ui['voice-target'].value==='simulation'&&Boolean(draft?.simulation_objects?.[draft.region]);
  function contextFields(){
    const expanded=new Map([...ui.coordinates.querySelectorAll('[data-coordinate-section]')].map(el=>[el.dataset.coordinateSection,el.open]));
    const c=draft.context,region=draft.region,depth=region==='floor'?2:0,abc=draft.grasp_abc?.[region];
    ui.coordinates.innerHTML=`<details data-coordinate-section="object" open><summary>작업 객체·접근 설정</summary><div class="preset-fields">${draft.object_source==='yolo'?numberInput(`context.virtual.${region}.size_mm.${depth}`,c.virtual[region].size_mm[depth],'물체 두께·깊이 (mm)'):[0,1,2].map(i=>numberInput(`context.virtual.${region}.center_base_mm.${i}`,c.virtual[region].center_base_mm[i],'객체 중심 '+'XYZ'[i]+' (mm)')).join('')+[0,1,2].map(i=>numberInput(`context.virtual.${region}.size_mm.${i}`,c.virtual[region].size_mm[i],`객체 ${'XYZ'[i]} 크기 (mm)`)).join('')}</div>
      <div class="scenario-regions">${['floor','shelf'].map(r=>`<section class="scenario-card"><h5>${r==='floor'?'바닥 · 수직 파지':'선반 · 수평 파지'}</h5>${numberInput('context.approaches.'+r+'.distance_mm',c.approaches[r].distance_mm,'접근·후퇴 간격 (mm)')}${r==='shelf'?`<label class="preset-check"><input type="checkbox" data-field="context.approaches.shelf.reverse" ${c.approaches.shelf.reverse?'checked':''}>수평 접근 방향 반전</label>`:''}<a href="/robot?pick_region=${r}#work-plane">장비 공통 파지 평면 교시 →</a></section>`).join('')}</div></details>
      <details data-coordinate-section="grasp" open><summary>파지 자세 · 공구 방향</summary><p class="scenario-caption">${region==='floor'?'바닥':'선반'} 파지에 사용할 BASE 기준 Z–Y′–Z″ 회전각입니다. 이 프리셋의 접근·파지·후퇴와 권장 벌림에 반영됩니다.</p>
      <label>자세 출처<select data-grasp-mode><option value="inherit" ${abc?'':'selected'}>기존 동작 유지 · 기본/기존 영역 교시</option><option value="custom" ${abc?'selected':''}>이 프리셋에 직접 설정</option></select></label>
      <div class="preset-fields">${['A','B','C'].map((axis,i)=>`<label>공구 ${axis} (°)<input type="number" step="any" data-field="grasp_abc.${region}.${i}" value="${esc(abc?.[i])}" placeholder="${defaultABC(region)[i]}" ${abc?'':'data-locked disabled'}></label>`).join('')}</div>
      <button type="button" data-action="capture-grasp" disabled>현재 TCP에서 공구 방향 불러오기</button><p class="scenario-caption">미설정 시 기존 경로를 유지합니다. ‘직접 설정’과 현재 TCP 읽기는 초안만 변경하며 프리셋 저장 후 실제 실행에 반영됩니다.</p></details>
      <details data-coordinate-section="joints"><summary>대기·경유 관절각</summary>${['standby_joints','waypoint1_joints'].map(key=>`<p class="scenario-caption">${key==='standby_joints'?'대기 자세':'1차 경유점'}</p><div class="preset-fields">${[0,1,2,3,4,5].map(i=>numberInput(`context.${key}.${i}`,c[key]?.[i],'J'+(i+1)+' (°)')).join('')}</div>${sourcePicker('context.'+key,'joint')}`).join('')}</details>
      <details data-coordinate-section="box"><summary>프리셋별 박스 놓기 TCP · BASE</summary><p class="scenario-caption">이 프리셋의 실제 놓기 목표입니다. 택배 박스 크기·위치 복사로 덮어쓰지 않습니다.</p><div class="preset-fields">${[0,1,2,3,4,5].map(i=>numberInput(`box_pose.${i}`,draft.box_pose?.[i],'XYZABC'[i]+(i<3?' (mm)':' (°)'))).join('')}${numberInput('context.box_clearance_mm',c.box_clearance_mm,'박스 위 간격 (mm)')}${numberInput('context.standby_opening_mm',c.standby_opening_mm,'대기 벌림 (mm)')}</div>${sourcePicker('box_pose','task')}<button type="button" data-action="capture-box" disabled>현재 TCP를 놓기 목표로 불러오기</button><p class="scenario-caption">불러오기는 좌표만 읽습니다. 실제 놓기 위치에서 TCP를 확인하고 프리셋을 저장하세요.</p></details>`;
    for(const section of ui.coordinates.querySelectorAll('[data-coordinate-section]'))if(expanded.has(section.dataset.coordinateSection))section.open=expanded.get(section.dataset.coordinateSection);
    const obj=draft.simulation_objects?.[region];
    ui['simulation-settings'].innerHTML=`<label class="preset-check"><input type="checkbox" data-simulation-mode ${obj?'checked':''}>이 프리셋의 모의 객체 사용 · 시뮬레이션 전용</label><p class="scenario-caption">작업 객체와 별도로 저장합니다. 실제 장비 실행은 작업 객체·YOLO 탐지값을 사용합니다. 미사용 시 실제 작업과 같은 객체로 경로를 확인합니다.</p>
      ${obj?`<div class="preset-fields">${[0,1,2].map(i=>numberInput(`simulation_objects.${region}.center_base_mm.${i}`,obj.center_base_mm[i],'모의 중심 '+'XYZ'[i]+' (mm)')).join('')}${[0,1,2].map(i=>numberInput(`simulation_objects.${region}.size_mm.${i}`,obj.size_mm[i],'모의 크기 '+'XYZ'[i]+' (mm)')).join('')}</div>`:''}
      <button type="button" data-action="import-example">기존 브라우저 예시 객체 불러오기</button><p class="scenario-caption">이전 예시 객체는 모의 객체 초안으로만 가져옵니다. 작업 좌표와 이전 원본 값은 유지됩니다. 프리셋 저장으로 보관하세요.</p>`;
  }
  function render(){if(!draft)return;
    list();for(const el of root.querySelectorAll('[data-field]')){const value=at(draft,el.dataset.field);if(el.type==='checkbox')el.checked=Boolean(value);else el.value=value??'';}
    ui.aliases.value=draft.aliases.join('\n');ui.range.value=draft.range_start?'custom':'all';
    const options=draft.steps.map((s,i)=>`<option value="${s.id}">${i+1} · ${esc(s.name||names[s.kind])}</option>`).join('');ui.start.innerHTML=ui.end.innerHTML=options;
    ui.start.value=draft.range_start||draft.steps[0].id;ui.end.value=draft.range_end||draft.steps.at(-1).id;for(const el of root.querySelectorAll('[data-range-field]'))el.hidden=ui.range.value!=='custom';
    contextFields();renderRequirements();renderSteps();detection.activate();controls();
  }
  function operations(index){return `<div class="preset-row-actions"><details class="preset-node-menu"><summary aria-label="${index+1}번 동작 편집">편집</summary><div><button type="button" data-op="up" data-index="${index}" aria-label="${index+1}번 동작 위로">↑</button><button type="button" data-op="down" data-index="${index}" aria-label="${index+1}번 동작 아래로">↓</button><button type="button" data-op="copy" data-index="${index}" aria-label="${index+1}번 동작 복제">복제</button><button type="button" data-op="delete" data-index="${index}">삭제</button></div></details>${draft.steps[index].kind==='checkpoint'?'':`<button type="button" data-op="execute" data-index="${index}" ${dirty?'disabled':''}>${ui['voice-target'].value==='hardware'?'이 단계 실제 실행':'이 단계 시뮬레이션'}</button>`}</div>`;}
  function renderSteps(){
    const active=document.activeElement,focus=ui.steps.contains(active)?['data-joint','data-node-field','data-node-value','data-prepare-speed'].map(key=>[key,active.getAttribute(key)]).find(([,v])=>v!==null):null;
    const expanded=new Map([...ui.steps.querySelectorAll('[data-step-details]')].map(el=>[el.dataset.stepDetails,el.open]));
    let row=0,seed=draft.context.standby_joints;const tool=poseFrame(simulationToolPose),byId=new Map((recipe?.steps||[]).map(s=>[s.id,s]));
    function tr(s,index,childIndex=null,forced=null){
      const compiled=forced||byId.get(s.id),auto=childIndex!==null||s.source!=='explicit'||s.reference_id||groupKinds.has(s.kind);
      let joints=compiled?.space==='joint'?compiled.target:null;
      if(compiled?.space==='task'&&compiled.target)joints=endpointIK(poseFrame(compiled.target),seed,tool,draft.context.waypoint1_joints?.[0]);
      if(joints)seed=joints;
      const editable=!auto&&['movej','movel','movec'].includes(s.kind)&&s.space==='joint';
      const prefix=childIndex===null?`${index}`:`${index}:${childIndex}`;
      const percentage=compiled?.speed?compiled.speed.speed*10:s.legacy_speed?s.legacy_speed.speed*10:s.percent;
      const speed=s.kind==='wait'?'—':`<select ${draft.steps[index].kind==='prepare'?`data-prepare-speed="${index}.${childIndex}"`:`data-node-field="${prefix}.percent"`} aria-label="${row+1}단계 ${s.kind==='gripper'?'그리퍼':'이동'} 속도">${percentage%10?`<option value="legacy" selected disabled>${percentage}% · 기존</option>`:''}${percentages(percentage)}</select>`;
      const modes=['movej','movel','movec'].includes(s.kind)?`<select data-node-field="${prefix}.kind" aria-label="${row+1}단계 이동 방식" ${auto?'data-locked disabled':''}>${['movej','movel','movec'].map(k=>`<option ${s.kind===k?'selected':''}>${k}</option>`).join('')}</select>`:names[s.kind];
      const inputMode=['movej','movel','movec'].includes(s.kind)&&!auto?`<select data-node-field="${prefix}.space"><option value="joint" ${s.space==='joint'?'selected':''}>관절 입력</option><option value="task" ${s.space==='task'?'selected':''}>TCP 입력</option></select>`:auto?'자동 계산':'팔 자세 유지';
      const title=s.name||names[s.kind];row++;
      let handCells='<td class="preset-hand-source"><span>유지</span></td><td class="preset-hand-width"><span>—</span></td><td class="preset-hand-contact"><span>—</span></td>';
      if(s.kind==='gripper'){
        const automatic=childIndex!==null||Boolean(forced),contact=compiled?.contact??s.contact??false;
        const group=draft.steps[index].kind,source=automatic?(group==='prepare'?'idle':'object'):(s.opening_source||'explicit');
        const sourceLabel=automatic&&group==='place'?'파지 전 벌림':{explicit:'직접 입력',object:'객체 권장 벌림',idle:'대기 벌림'}[source];
        const width=contact?null:compiled?.opening_mm??(source==='explicit'?s.opening_mm:null);
        const sourceCell=automatic?`<span>${contact?'접촉 시 종료':esc(sourceLabel)} · 자동</span>`:`<select data-node-field="${prefix}.opening_source" aria-label="${row}단계 그리퍼 벌림 기준" ${contact?'data-locked disabled':''}>${[['explicit','직접 입력'],['object','객체 권장 벌림'],['idle','대기 벌림']].map(([v,t])=>`<option value="${v}" ${source===v?'selected':''}>${t}</option>`).join('')}</select>`;
        const widthCell=`<input type="number" step="any" min="0" max="1000" aria-label="${row}단계 그리퍼 벌림 (mm)" ${!automatic&&source==='explicit'&&!contact?`data-node-field="${prefix}.opening_mm"`:'readonly'} value="${esc(width===null||width===undefined?'':Number(width.toFixed(2)))}" placeholder="${contact?'접촉 시 종료':!automatic&&source==='explicit'?'직접 입력':source==='object'&&draft.object_source==='yolo'?'탐지 후 계산':'자동 계산'}">`;
        handCells=`<td class="preset-hand-source">${sourceCell}</td><td class="preset-hand-width">${widthCell}</td><td class="preset-hand-contact"><label class="preset-hand-check"><input type="checkbox" aria-label="${row}단계 접촉 전류까지 닫기" ${automatic?'data-locked disabled':`data-node-field="${prefix}.contact"`} ${contact?'checked':''}></label></td>`;
      }
      let html=`<tr class="scenario-stage-joints" data-preset-step="${esc(s.id)}"><th scope="row"><strong>${row} · ${esc(title)}</strong>${childIndex===null&&!forced?operations(index):''}</th><td>${modes}</td><td>${speed}</td><td>${inputMode}</td>${['gripper','wait'].includes(s.kind)?'<td colspan="6" class="preset-joints-held">관절 유지</td>':[0,1,2,3,4,5].map(j=>`<td><input type="number" step="any" aria-label="${row}단계 J${j+1}" ${editable?'data-joint="'+index+'.'+j+'"':'readonly'} value="${esc(editable?s.target?.[j]:joints?.[j]===undefined?'':Number(joints[j].toFixed(2)))}"></td>`).join('')}${handCells}</tr>`;
      if(childIndex===null&&!forced){let fields='';
        if(s.space==='task'&&['movej','movel','movec'].includes(s.kind)&&!auto)fields+=`<div class="preset-fields">${[0,1,2,3,4,5].map(i=>`<label>TCP ${'XYZABC'[i]}<input type="number" step="any" data-node-value="${index}.target.${i}" value="${esc(s.target?.[i])}"></label>`).join('')}</div>`;
        if(s.kind==='movec')fields+=`<p class="scenario-caption">원호 경유 TCP</p><div class="preset-fields">${[0,1,2,3,4,5].map(i=>`<label>${'XYZABC'[i]}<input type="number" step="any" data-node-value="${index}.via_pose.${i}" value="${esc(s.via_pose?.[i])}"></label>`).join('')}</div>`;
        if(s.kind==='wait')fields+=`<label>대기 시간 (0.1~600초)<input type="number" step="any" min=".1" max="600" data-node-field="${index}.seconds" value="${s.seconds??1}"></label>`;
        if(fields)html+=`<tr class="preset-extra"><td colspan="13"><details data-step-details="${s.id}" ${(expanded.get(s.id)??s.kind==='wait')?'open':''}><summary>동작 상세 설정</summary>${fields}</details></td></tr>`;
      }
      return html;
    }
    ui.steps.innerHTML=draft.steps.map((s,index)=>{
      if(s.kind==='checkpoint')return `<tr><th colspan="13">${draft.object_source==='yolo'?'YOLO 대상 확인 · '+(recipe?.detected?.label||'대상 선택 전'):'저장된 객체 좌표 확인'} ${operations(index)}</th></tr>`;
      if(groupKinds.has(s.kind)){
        const compiled=(recipe?.steps||[]).filter(c=>c.group_id===s.id);
        let html=`<tr class="scenario-table-phase"><th colspan="13">${esc(s.name||names[s.kind])} · 내부 순서 고정 ${operations(index)}</th></tr>`;
        if(compiled.length)html+=compiled.map((c,j)=>tr(s.children?.[j]||{...s,kind:c.motion||c.kind,name:c.title,id:c.id},index,j,c)).join('');
        else html+=`<tr><td colspan="13">객체·박스 좌표 입력 후 자동 계산됩니다.</td></tr>`;
        return html;
      }
      return tr(s,index);
    }).join('');
    if(focus)ui.steps.querySelector(`[${focus[0]}="${CSS.escape(focus[1])}"]`)?.focus({preventScroll:true});
  }
  function changed(rerender=false){dirty=true;conflict=false;snapshot();invalidate();if(voicePending||voiceSelection||voicePreparation||voiceClass){voicePending=voiceSelection=voicePreparation=voiceClass=null;ui['class-gate'].hidden=true;ui['voice-pending'].hidden=ui['voice-selection'].hidden=true;void api('preset-voice/cancel','POST',{},signal).catch(()=>{});}if(rerender)render();renderRequirements();controls();previewTimer=setTimeout(preview,300);}
  async function preview(){
    if(!draft||signal.aborted)return;const version=++epoch;
    try{
      const p=await api(`presets/${draft.id}/preview`,'POST',{preset:draft,simulation_object:usesSimulationObject(),...(draft.object_source==='yolo'?detection.payload():{})},signal);
      if(version!==epoch)return;p.region??=draft.region;recipe=p;arm.setScenarioPreview(p.product?.center_base_mm?.every(Number.isFinite)?p:null);ui.count.textContent=p.steps.length+'단계';
      if(simulation.state==='idle'){
        ui['simulation-errors'].hidden=!p.errors.length;ui['simulation-error-detail'].textContent=[...new Set(p.errors)].join('\n');
        ui['simulation-context'].textContent=dirty?'편집 중인 프리셋 경로 · 저장 전 변경 포함':'저장된 프리셋 경로';
        ui.simulation.textContent=p.errors.length?(configurationIssues().length?'필수 좌표 '+configurationIssues().length+'개를 입력하면 프리셋 시뮬레이션을 시작할 수 있습니다. 예시 경로는 바로 체험할 수 있습니다.':p.errors[0]):p.example?'모의 객체 · 시뮬레이션 전용 · 실제 장비 목표와 다를 수 있습니다.':p.object_source==='yolo'&&!p.detected?'시작 버튼을 누르고 대상 클래스를 말씀하세요. 탐지 객체 선택 후 경로를 계산하고 별도로 승인합니다.':'재생 준비 완료 · 실제 장치 명령 없음';
      }
      renderSteps();controls();
    }catch(error){if(version===epoch){recipe=null;arm.setScenarioPreview(null);if(simulation.state==='idle')ui.simulation.textContent=error.message;controls();}}
  }
  async function choose(id){snapshot();invalidate();const p=presets.find(p=>p.id===id)||presets[0];selected=p.id;try{localStorage.setItem('robot-preset-selection',p.id);}catch{}const url=new URL(location.href);url.searchParams.set('preset',selected);history.replaceState(history.state,'',url);const stored=cache.get(p.id);draft=structuredClone(stored?.dirty?stored.draft:p);draft.grasp_abc??={floor:null,shelf:null};draft.simulation_objects??={floor:null,shelf:null};dirty=stored?.dirty||false;conflict=dirty&&draft.revision!==p.revision;message('');render();await preview();}
  async function load(){busy=true;controls();try{presets=(await api('presets','GET',undefined,signal)).presets;await choose(presets.some(p=>p.id===selected)?selected:presets[0].id);}catch(error){message(error.message,true);}finally{busy=false;controls();if(location.hash==='#preset-execution'&&!root.closest('[data-manipulator-panel]').hidden)requestAnimationFrame(()=>root.querySelector('#preset-execution').scrollIntoView({block:'start'}));}}
  async function save(){if(!draft||busy||realBusy)return;busy=true;controls();try{const p=await api('presets/'+draft.id,'PUT',draft,signal);presets=presets.map(item=>item.id===p.id?p:item);draft=p;dirty=false;conflict=false;snapshot();invalidate();render();await preview();message('프리셋을 저장했습니다.');}catch(error){if(error.status===412)conflict=true;message(error.message,true);}finally{busy=false;controls();}}
  async function create(copy=false){busy=true;controls();try{const p=copy?await api(`presets/${draft.id}/copy`,'POST',{revision:presets.find(p=>p.id===draft.id).revision},signal):await api('presets','POST',{id:uid(),name:'새 이동 경로'},signal);presets.push(p);await choose(p.id);}catch(error){message(error.message,true);}finally{busy=false;controls();}}
  async function playRecipe(path){
    path={...path,region:path.region??draft.region};
    arm.simulationAction('stop');
    playingRecipe=path;ui['simulation-errors'].hidden=true;ui['simulation-context'].textContent=path.standalone_demo?'예시 17단계 · '+(path.region==='shelf'?'선반':'바닥')+' · 현재 프리셋과 별개 · 저장하지 않음':(path.example?'모의 객체 · ':'')+(dirty?'편집 중인 프리셋 경로 · 저장 전 변경 포함':'프리셋 경로');ui.simulation.dataset.playback=String(++playbackSerial);
    arm.simulationAction('rate',Number(ui.rate.value));await arm.simulateRecipe(path);
  }
  async function run(stepId=null){
    if(!draft||busy||realBusy||voiceBusy||simulationActive())return;
    if(ui['voice-target'].value==='hardware'){await hardware(stepId);return;}
    if(draft?.object_source==='yolo'&&!usesSimulationObject()){await requestClass('simulation',stepId);return;}
    if(!stepId&&(!recipe||recipe.errors.length))return;
    const version=stepId?++epoch:epoch;
    if(stepId){clearTimeout(previewTimer);arm.simulationAction('stop');}
    let path=recipe;
    if(stepId){busy=true;controls();try{path=await api(`presets/${draft.id}/preview`,'POST',{preset:{...draft,range_start:stepId,range_end:stepId},simulation_object:usesSimulationObject()},signal);}finally{busy=false;controls();}}
    if(version!==epoch)return;
    if(path.errors.length){ui.simulation.textContent=path.errors[0];ui['simulation-errors'].hidden=false;ui['simulation-error-detail'].textContent=path.errors.join('\n');return;}
    await playRecipe(path);
    if(stepId&&version===epoch)void preview();
  }
  async function demo(){
    if(!draft||busy||realBusy||voiceBusy||simulationActive()||ui['voice-target'].value!=='simulation')return;
    const request=++demoRequest,controller=new AbortController();demoController=controller;busy=true;controls();
    ui.simulation.textContent='예시 경로를 준비하고 있습니다.';
    try{
      const path=await api('pick/scenario/preview','POST',{example:true,region:ui['demo-region'].value},AbortSignal.any([signal,controller.signal]));
      if(request!==demoRequest||signal.aborted||root.closest('[data-manipulator-panel]').hidden)return;
      if(path.errors.length)throw Error(path.errors.join(' '));
      await playRecipe({...path,standalone_demo:true});
    }catch(error){if(request===demoRequest)ui.simulation.textContent=error.message;}
    finally{if(demoController===controller){demoController=null;busy=false;controls();}}
  }
  async function hardware(stepId=null,recognition=false){
    if(dirty||busy||realBusy||simulationActive())return;
    if(!robotConnected){ui.simulation.textContent='실제 로봇이 연결되지 않았습니다. 실행 대상을 시뮬레이션으로 바꾸세요.';return;}
    if(draft.object_source==='yolo'&&!recognition){await requestClass('hardware',stepId);return;}
    busy=true;controls();const version=epoch;
    try{
      const binding={};
      if(binding===null)return;
      const body=recognition?{revision:draft.revision}:{revision:draft.revision,step_id:stepId,...binding};
      const target=await api(`presets/${draft.id}/${recognition?'recognition-preview':'execution-preview'}`,'POST',body,signal);
      if(version!==epoch||root.closest('[data-manipulator-panel]').hidden){void api('pick/cancel','POST',{approval_id:target.approval_id});return;}
      ticket=target;
      const detected=target.detected;
      ui['approval-summary'].textContent=`${target.name} · ${target.total_steps}단계 · TCP ${target.tcp_name}`+(detected?` · ${detected.label} ${Math.round(detected.confidence*100)}% · 파지 [${detected.pose.join(', ')}] · 벌림 ${detected.opening_mm.toFixed(2)} mm`:'');
      ui['approval-path'].textContent=target.steps.map(s=>`${s.number}. ${s.title} · ${s.motion||s.kind} · ${s.speed.speed}${s.kind==='gripper'?' rpm':s.kind==='joint'?' °/s':' mm/s'}${s.target?' · ['+s.target.join(', ')+']':''}`).join('\n');
      ui['approval-status'].textContent=recognition?'인식 자세 이동과 대기 벌림만 준비합니다. 완료 후 YOLO 대상을 다시 확인하세요.':'일회용 승인 · 실제 로봇과 그리퍼가 움직입니다.';
      root.querySelector('[data-action="approve"]').disabled=false;ui.dialog.showModal();
      ticketTimer=setTimeout(()=>{root.querySelector('[data-action="approve"]').disabled=true;ui['approval-status'].textContent='승인이 만료되었습니다. 대상을 다시 확인하세요.';},Math.max(0,(target.expires_in??30)*1000));
    }catch(error){message(error.message,true);}finally{busy=false;controls();}
  }
  function nodeAt(key){const [index,childIndex]=key.split(':').map(Number);const parent=draft.steps[index];if(childIndex===undefined)return parent;
    if(!parent.children?.length){const specs=parent.kind==='grasp'?['movej','gripper','movel','gripper','movel']:['movej','movel','gripper','movel'];parent.children=specs.map(kind=>({id:uid(),kind,name:names[kind],percent:parent.percent,acceleration:kind==='gripper'?3000:5}));}return parent.children[childIndex];}
  function input(event){const el=event.target;if(!draft||busy||realBusy)return;
    if(el.hasAttribute('data-grasp-mode')){const custom=el.value==='custom';if(custom===Boolean(draft.grasp_abc[draft.region]))return;draft.grasp_abc[draft.region]=custom?defaultABC(draft.region):null;changed(true);return;}
    if(el.hasAttribute('data-simulation-mode')){if(el.checked===Boolean(draft.simulation_objects[draft.region]))return;draft.simulation_objects[draft.region]=el.checked?structuredClone(draft.context.virtual[draft.region]):null;changed(true);return;}
    if(el.dataset.poseSource){controls();return;}
    if(el===ui.text||el===ui['test-class']){textRequest++;testRecipe=null;testBinding=null;ui['test-targets'].innerHTML='';controls();return;}
    if(el.dataset.field){const key=el.dataset.field;const value=el.type==='checkbox'?el.checked:el.type==='number'?(Number.isFinite(el.valueAsNumber)?el.valueAsNumber:null):el.value;
      if(key.startsWith('box_pose.')&&!draft.box_pose)draft.box_pose=Array(6).fill(null);
      if(key.startsWith('context.waypoint1_joints.')&&!draft.context.waypoint1_joints)draft.context.waypoint1_joints=Array(6).fill(null);
      put(draft,key,value);changed(key==='region');
    }else if(el===ui.aliases){draft.aliases=el.value.split('\n').map(s=>s.trim()).filter(Boolean);changed();}
    else if(el.dataset.joint){const [n,j]=el.dataset.joint.split('.').map(Number),s=draft.steps[n];s.target??=Array(6).fill(null);s.target[j]=Number.isFinite(el.valueAsNumber)?el.valueAsNumber:null;changed();}
    else if(el.dataset.prepareSpeed){const [index,child]=el.dataset.prepareSpeed.split('.').map(Number),s=draft.steps[index];if(child===0){s.percent=Number(el.value);s.legacy_speed=null;}else{s.prepare_hand_speed={speed:Number(el.value)/10,acceleration:s.prepare_hand_speed?.acceleration||3000};}changed();}
    else if(el.dataset.nodeValue){const [n,key,j]=el.dataset.nodeValue.split('.'),s=draft.steps[n];s[key]??=Array(6).fill(null);s[key][Number(j)]=Number.isFinite(el.valueAsNumber)?el.valueAsNumber:null;changed();}
    else if(el.dataset.nodeField){const [key,field]=el.dataset.nodeField.split('.'),s=nodeAt(key);s[field]=el.type==='checkbox'?el.checked:el.type==='number'?(Number.isFinite(el.valueAsNumber)?el.valueAsNumber:null):field==='percent'?Number(el.value):el.value;if(field==='percent')s.legacy_speed=null;if(field==='space'){s.source='explicit';s.reference_id=null;s.target=null;}changed(['kind','space','opening_source','contact'].includes(field));}
  }
  for(const scope of [root]){on(scope,'input',input);on(scope,'click',async event=>{const button=event.target.closest('button');if(!button||button.disabled)return;try{
    if(button.dataset.configureField){configureField(button.dataset.configureField);return;}
    if(button.dataset.select){if(!busy&&!realBusy){if(voiceClass||voicePending||voiceSelection)await api('preset-voice/cancel','POST',{},signal);await choose(button.dataset.select);}return;}
    const op=button.dataset.op;if(op&&!busy&&!realBusy){const i=Number(button.dataset.index),s=draft.steps[i];if(op==='execute'){await run(s.id);return;}if(op==='copy'){const copy=structuredClone(s);copy.id=uid();for(const child of copy.children||[])child.id=uid();draft.steps.splice(i+1,0,copy);}else if(op==='delete'){if(draft.steps.length===1)throw Error('한 개 이상의 동작을 남겨주세요.');if(draft.steps.some(n=>n.reference_id===s.id))throw Error('다른 단계가 참조하고 있어 삭제할 수 없습니다.');draft.steps.splice(i,1);if([draft.range_start,draft.range_end].includes(s.id))draft.range_start=draft.range_end=null;}else{const next=i+(op==='up'?-1:1);if(next<0||next>=draft.steps.length)return;[draft.steps[i],draft.steps[next]]=[draft.steps[next],draft.steps[i]];}changed(true);return;}
    if((busy||realBusy)&&['new','copy','discard','reload','import-box','play','test-play','use-transcript'].includes(button.dataset.action))return;
    switch(button.dataset.action){
      case 'new':await create();break;case 'copy':await create(true);break;case 'save':await save();break;
      case 'discard':{const id=draft.id;cache.delete(id);draft=null;dirty=false;await choose(id);break;}
      case 'reload':cache.delete(draft?.id);dirty=false;draft=null;await load();break;
      case 'add':if(busy||realBusy)break;draft.steps.push({id:uid(),kind:ui.kind.value,name:names[ui.kind.value],percent:50,acceleration:ui.kind.value==='gripper'?3000:5,space:'joint',source:'explicit',target:null,seconds:1,contact:false,children:[]});changed(true);break;
      case 'import-box':{busy=true;controls();try{const data=await api('status','GET',undefined,signal);draft.box_size=structuredClone(data.parcel_box.size_mm);draft.box_center=structuredClone(data.parcel_box.center_base_mm);changed(true);message('택배 박스 설정의 크기·중심만 복사했습니다. 출처 버전: '+(data.parcel_box.revision?.slice(0,8)||'기본값')+' · 박스 놓기 TCP는 유지됩니다. 프리셋을 저장하세요.');}finally{busy=false;controls();}break;}
      case 'import-joints':await copyTaught(button.dataset.destination,'joint');break;
      case 'import-tcp':await copyTaught(button.dataset.destination,'task');break;
      case 'capture-grasp':{if(!robotConnected||busy||realBusy||voiceBusy)break;busy=true;controls();try{const {pose}=await api('work-points/current?monitor_only=true','GET',undefined,signal);if(!validVector(pose))throw Error('현재 TCP 여섯 좌표를 확인할 수 없습니다.');draft.grasp_abc[draft.region]=pose.slice(3);changed(true);message('현재 TCP 공구 방향을 이 프리셋의 초안에 불러왔습니다.');}finally{busy=false;controls();}break;}
      case 'import-example':{let value;try{value=JSON.parse(localStorage.getItem('vision-work-plane-example-v1'));}catch{}const center=['x','y','z'].map(k=>value?.[k]),size=['sizeX','sizeY','sizeZ'].map(k=>value?.[k]);if(!center.every(v=>Number.isFinite(v)&&Math.abs(v)<=1e6)||!size.every(v=>Number.isFinite(v)&&v>0&&v<=1000))throw Error('불러올 유효한 이전 예시 객체가 없습니다.');draft.simulation_objects[draft.region]={center_base_mm:center,size_mm:size};changed(true);message('이전 예시를 모의 객체 초안으로 가져왔습니다. 실제 작업 객체 좌표는 유지됩니다.');break;}
      case 'capture-box':if(!robotConnected||busy||realBusy||voiceBusy)break;busy=true;controls();try{const {pose}=await api('work-points/current','GET',undefined,signal);if(!validVector(pose))throw Error('현재 TCP 여섯 좌표를 확인할 수 없습니다.');draft.box_pose=pose;changed(true);message('현재 TCP를 초안에 불러왔습니다. 놓기 위치를 확인한 뒤 프리셋을 저장하세요.');}finally{busy=false;controls();}break;
      case 'refresh-readiness':await refreshReadiness();break;
      case 'play':await run();break;
      case 'demo':await demo();break;
      case 'pause':arm.simulationAction(simulation.state==='paused'?'resume':'pause');break;
      case 'confirm-simulation':arm.simulationAction(simulation.state==='awaiting_grip'?'confirm-grip':'open-at-box');break;
      case 'sim-stop':cancelDemo();arm.simulationAction('stop');if(simulation.state==='idle')ui.simulation.textContent='시뮬레이션 종료 · 프리셋과 저장 좌표는 유지됩니다.';controls();break;
      case 'cancel':cancelTicket();break;
      case 'approve':{if(!ticket||busy||realBusy)break;const id=ticket.approval_id;ticket=null;clearTimeout(ticketTimer);root.querySelector('[data-action="approve"]').disabled=true;busy=true;controls();try{const move=await api('presets/executions/approve','POST',{approval_id:id},signal);realBusy=!terminal(move.state);ui.dialog.close();ui.job.textContent=move.message;await poll();}finally{busy=false;controls();}break;}
      case 'listen':await listening(true);break;
      case 'unlisten':await listening(false);break;
      case 'voice-approve':if(voicePending){await api('preset-voice/approve','POST',{approval_id:voicePending.approval_id},signal);await poll();}break;
      case 'voice-select':if(voiceSelection){await api('preset-voice/select','POST',{request_id:voiceSelection.request_id,candidate_id:button.dataset.candidate},signal);await poll();}break;
      case 'voice-prepare':if(voicePreparation&&!busy&&!realBusy){const target=voicePreparation;presets=(await api('presets','GET',undefined,signal)).presets;await choose(target.preset_id);if(draft.id!==target.preset_id||draft.revision!==target.revision)throw Error('프리셋이 변경되었습니다. 명령을 다시 확인하세요.');await hardware(null,true);}break;
      case 'class-retry':if(voiceClass)await requestClass(voiceClass.target,voiceClass.step_id);break;
      case 'voice-cancel':await api('preset-voice/cancel','POST',{},signal);await poll();break;
      case 'use-transcript':if(lastTranscript){draft.aliases=[...new Set([...draft.aliases,lastTranscript.trim()])];ui.aliases.value=draft.aliases.join('\n');changed();}break;
      case 'text-test':await testSentence();break;
      case 'text-select':if(testBinding)await testSentence({snapshot_id:testBinding.snapshot_id,candidate_id:button.dataset.candidate});break;
      case 'test-play':if(testRecipe)await playRecipe(testRecipe);break;
    }
  }catch(error){message(error.message,true);if(button.dataset.action==='approve')ui['approval-status'].textContent=error.message;if(['listen','unlisten','voice-select','voice-approve','voice-prepare','class-retry'].includes(button.dataset.action))ui['voice-message'].textContent=error.message;if(['text-test','text-select'].includes(button.dataset.action))ui['test-result'].textContent=error.message;}});}
  for(const el of [ui.range,ui.start,ui.end])on(el,'change',()=>{if(!draft)return;draft.range_start=ui.range.value==='all'?null:ui.start.value;draft.range_end=ui.range.value==='all'?null:ui.end.value;changed(true);});
  on(ui['voice-target'],'change',()=>{cancelTicket();arm.simulationAction('stop');if(voicePending||voiceSelection||voiceClass)void api('preset-voice/cancel','POST',{},signal).then(poll).catch(error=>message(error.message,true));invalidate();void preview();renderSteps();controls();});
  on(ui.rate,'change',()=>arm.simulationAction('rate',Number(ui.rate.value)));
  on(ui.progress,'input',()=>{if(!ui.progress.disabled)arm.simulationAction('seek',Number(ui.progress.value)/1000);});
  async function requestClass(target,stepId=null){
    if(!draft||dirty||conflict||busy||realBusy||voiceBusy||simulationActive())return;
    voiceBusy=true;pollEpoch++;clearTimeout(pollTimer);controls();
    try{
      if(voiceListening&&ui['voice-target'].value!==target)await api('preset-voice/stop','POST',{},signal);
      ui['voice-target'].value=target;
      await api('preset-voice/class-request','POST',{preset_id:draft.id,revision:draft.revision,target,step_id:stepId},signal);
      await poll();ui['class-gate'].scrollIntoView({block:'center',behavior:'smooth'});
    }finally{voiceBusy=false;controls();if(!signal.aborted&&!pollTimer)pollTimer=setTimeout(poll,700);}
  }
  async function listening(start){
    if(voiceBusy)return;
    voiceBusy=true;pollEpoch++;clearTimeout(pollTimer);pollTimer=null;controls();
    try{await api('preset-voice/'+(start?'start':'stop'),'POST',start?{target:ui['voice-target'].value}:{},signal);await poll();}
    finally{voiceBusy=false;controls();if(!signal.aborted&&!pollTimer)pollTimer=setTimeout(poll,700);}
  }
  async function testSentence(binding={}){
    const version=++textRequest,text=ui.text.value;testRecipe=null;ui['test-targets'].innerHTML='';controls();
    const result=await api('preset-voice/test','POST',{text,...(ui['test-class'].value.trim()?{class_name:ui['test-class'].value.trim()}:{}),...binding},signal);if(version!==textRequest)return;
    testRecipe=result.recipe;testBinding=result.detection||null;
    if(testRecipe)ui['test-result'].textContent=result.name+' · 저장된 '+result.revision.slice(0,8)+' · '+testRecipe.steps.length+'단계 · 시뮬레이션 전용';
    else{ui['test-result'].textContent=result.name+' · 문장 테스트 · '+result.detection.message;ui['test-targets'].innerHTML=result.detection.candidates.map((c,i)=>`<button type="button" data-action="text-select" data-candidate="${c.id}" ${c.reason?'disabled':''}>${esc(c.label)} · 후보 ${i+1} · ${Math.round(c.confidence*100)}% · ${esc(c.reason||c.pose?.join(', '))}</button>`).join('');}
    controls();
  }
  on(ui.dialog,'close',cancelTicket);
  on(window,'robot-global-stop',()=>{invalidate();void poll();});
  const unsubscribe=arm.observeSimulation(next=>{
    simulation=next;ui.simulation.dataset.state=next.state;
    ui.progress.value=Math.round((next.progress||0)*1000);ui.percent.textContent=Math.round((next.progress||0)*100)+'%';
    if(next.state==='idle'){
      playingRecipe=null;ui['simulation-context'].textContent='프리셋 경로 · 로봇 연결 없이 미리보기';
      ui.simulation.textContent='시뮬레이션 대기 · 프리셋 경로 또는 예시 경로를 선택하세요.';
    }else ui.simulation.textContent=`${next.message||next.state}`+(next.seedSource==='fallback'?' · 로봇 미연결 · 기본 자세에서 재생':'');
    for(const row of ui.steps.querySelectorAll('[data-preset-step]'))row.dataset.current=next.state!=='idle'&&!playingRecipe?.standalone_demo&&(playingRecipe||recipe)?.steps?.[next.step-1]?.id===row.dataset.presetStep?'true':'false';
    controls();
  });
  async function poll(){clearTimeout(pollTimer);pollTimer=null;if(signal.aborted)return;const request=++pollEpoch;try{
    const visible=!document.hidden&&!root.closest('[data-manipulator-panel]').hidden;
    const [v,status]=await Promise.all([api('preset-voice/status?heartbeat='+visible,'GET',undefined,signal),api('pick/scenario/status','GET',undefined,signal)]);
    if(request!==pollEpoch||signal.aborted)return;
    const active=document.activeElement,voiceScope=active?.closest('[data-p="class-gate"],[data-p="voice-selection"],[data-p="voice-pending"]');
    const voiceFocus=voiceScope&&root.contains(voiceScope)&&active.dataset.action?{scope:voiceScope.dataset.p,action:active.dataset.action,candidate:active.dataset.candidate}:null;
    voiceListening=v.listening;voiceCanStop=v.listening||v.can_stop;
    ui['mic-state'].textContent=v.listening?'연속 대기 · '+({listening:'인식 대기',transcribing:'인식 중',loading:'준비 중',speaking:'안내 중'}[v.state]||'연결됨'):v.can_stop?'마이크 종료 재시도 필요':'청취 종료';if(v.listening)ui['voice-target'].value=v.target;
    if(lastStopSerial!==null&&lastStopSerial!==v.stop_serial)invalidate();lastStopSerial=v.stop_serial;lastTranscript=v.transcript||'';root.querySelector('[data-action=use-transcript]').disabled=!lastTranscript||busy||realBusy;
    ui.transcript.textContent=v.transcript?'인식 문장: '+v.transcript:'';ui['voice-message'].textContent=v.message;
    voiceClass=v.class_request;ui['class-gate'].hidden=!voiceClass;
    if(voiceClass){
      const c=voiceClass,phases={loading:'클래스 목록 조회 중',class:'클래스 이름을 말씀하세요',detecting:'YOLO 대상 확인 중',objects:'탐지 객체를 하나 선택하세요',no_match:'현재 화면에 해당 클래스의 대상이 없습니다',preparation:'인식 자세 준비가 필요합니다',approval:'대상과 경로를 확인하고 승인하세요'};
      ui['class-gate'].innerHTML=`<div class="preset-edit-head"><h4>${esc(phases[c.phase]||'실행 전 클래스 선택')}</h4><span class="scenario-badge">${c.target==='hardware'?'실제 로봇':'시뮬레이션'} · 이번 실행 1회</span></div><p>${esc(c.name)} · ${c.step_id?'선택한 동작':'저장한 실행 범위'} · 저장 버전 ${esc(c.revision.slice(0,8))}</p><ol class="preset-class-flow"><li data-current="${['loading','class'].includes(c.phase)}">클래스 발화</li><li data-current="${['detecting','objects','no_match','preparation'].includes(c.phase)}">YOLO 대상 확인</li><li data-current="${c.phase==='approval'}">최종 승인</li></ol><p class="scenario-caption">허용 클래스 · ${esc(c.model_name||'조회 중')} · ${Math.ceil(c.expires_in)}초 이내</p><div class="preset-class-list" aria-label="말할 수 있는 클래스">${(c.classes||[]).map(item=>`<span data-selected="${item.name===c.recognized}">${esc(item.name)}</span>`).join('')}</div><p><strong>${c.recognized?'선택 클래스: '+esc(c.recognized):'목록의 이름 한 개만 말씀하세요.'}</strong></p><div class="pose-actions"><button type="button" data-action="class-retry">클래스 다시 선택</button><button type="button" data-action="voice-cancel">승인 요청 취소</button></div>`;
    }
    voicePending=v.pending;ui['voice-pending'].hidden=!voicePending;if(voicePending)ui['voice-pending'].innerHTML=`<strong>${esc(voicePending.name)}</strong><p>${esc(voicePending.range_label)} · ${voicePending.total_steps}단계 · ${voicePending.target==='hardware'?'실제 로봇':'시뮬레이션'} · 저장된 ${esc(voicePending.revision.slice(0,8))}</p><div class="pose-actions">${voicePending.confirmation==='screen'?'<button type="button" data-action="voice-approve">승인 후 실행</button>':'<span>‘로봇 실행’을 말씀하세요.</span>'}<button type="button" data-action="voice-cancel">승인 요청 취소</button></div>`;
    if(voicePending?.detected){const data=voicePending.detected;ui['voice-pending'].insertAdjacentHTML('beforeend',`<p>YOLO 대상: ${esc(data.label)} · ${Math.round(data.confidence*100)}% · 파지 TCP [${esc(data.pose.join(', '))}] · 벌림 ${data.opening_mm.toFixed(2)} mm</p>`);}
    voiceSelection=v.selection;voicePreparation=v.needs_preparation;ui['voice-selection'].hidden=!voiceSelection&&!voicePreparation;
    if(voiceSelection)ui['voice-selection'].innerHTML=`<strong>${esc(voiceSelection.name)} · YOLO 대상 선택</strong><p>실행할 대상을 선택한 뒤 별도로 승인합니다. ${voiceSelection.target==='hardware'?'실제 로봇':'시뮬레이션'}</p><div class="preset-detection-candidates">${voiceSelection.detection.candidates.map((c,i)=>`<button type="button" data-action="voice-select" data-candidate="${c.id}" ${c.reason?'disabled data-invalid':''}>${esc(c.label)} · 후보 ${i+1} · ${Math.round(c.confidence*100)}% · ${esc(c.reason||c.pose?.join(', '))}</button>`).join('')}</div><button type="button" data-action="voice-cancel">승인 요청 취소</button>`;
    else if(voicePreparation)ui['voice-selection'].innerHTML=`<strong>${esc(voicePreparation.name)} · 인식 자세 준비 필요</strong><p>저장된 대기 자세 이동을 먼저 화면에서 승인하세요. 준비 후 실행 버튼을 눌러 클래스를 다시 선택하세요.</p><button type="button" data-action="voice-prepare">인식 자세 준비</button>`;
    const move=status.move;realBusy=Boolean(v.busy||(move&&!terminal(move.state)));if(realBusy&&simulationActive())arm.simulationAction('stop');ui.job.textContent=move?`${move.step||0}/${move.total_steps||move.steps?.length||0} · ${move.message}`:realBusy?'다른 실제 로봇 작업이 진행 중입니다.':'진행 중인 실제 작업이 없습니다.';
    if(v.simulation&&v.simulation.id!==lastVoiceSimulation&&visible&&!realBusy&&!busy){
      if(dirty){lastVoiceSimulation=v.simulation.id;message('저장 전 편집값이 있어 음성 시뮬레이션을 시작하지 않았습니다. 저장하거나 취소한 뒤 다시 요청하세요.',true);}
      else{
        presets=(await api('presets','GET',undefined,signal)).presets;
        if(request!==pollEpoch||signal.aborted)return;
        await choose(v.simulation.recipe.preset_id);
        if(request!==pollEpoch||signal.aborted)return;
        if(!dirty&&draft.revision===v.simulation.recipe.revision){lastVoiceSimulation=v.simulation.id;recipe=v.simulation.recipe;await playRecipe(recipe);}
        else{lastVoiceSimulation=v.simulation.id;message('프리셋이 변경되었거나 저장 전 편집값이 있습니다. 음성 명령을 다시 확인하세요.',true);}
      }
    }
    for(const button of ui['voice-selection'].querySelectorAll('[data-action=voice-cancel]'))button.hidden=Boolean(voiceClass);
    for(const button of ui['voice-pending'].querySelectorAll('[data-action=voice-cancel]'))button.hidden=Boolean(voiceClass);
    controls();
    if(voiceFocus){const selector=`[data-action="${CSS.escape(voiceFocus.action)}"]${voiceFocus.candidate?`[data-candidate="${CSS.escape(voiceFocus.candidate)}"]`:''}`;const next=ui[voiceFocus.scope].querySelector(selector);if(next&&!next.disabled&&!ui[voiceFocus.scope].hidden)next.focus({preventScroll:true});}
  }catch(error){if(request===pollEpoch&&error.name!=='AbortError')ui['voice-message'].textContent=error.message;}finally{if(!signal.aborted&&request===pollEpoch)pollTimer=setTimeout(poll,700);}}
  signal.addEventListener('abort',()=>{cancelDemo();snapshot();clearTimeout(previewTimer);clearTimeout(pollTimer);clearTimeout(ticketTimer);clearTimeout(readinessTimer);cancelTicket();unsubscribe();},{once:true});
  void load();void poll();void refreshReadiness();
}
