import {api} from './robot-camera-frame.js';
import {endpointIK,poseFrame,simulationToolPose} from './robot-arm.js?v=joint-targets';
import {connectPresetDetection} from './robot-preset-detection.js?v=yolo-presets';

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
  root.innerHTML=`<div class="preset-heading"><div><p class="scenario-eyebrow">MOTION PRESETS</p><h3>이동 프리셋</h3><p class="scenario-caption">저장한 경로를 선택하고 단계와 음성 명령을 설정하세요.</p></div><span data-p="saved" class="scenario-badge">조회 중</span></div>
    <div class="preset-layout"><aside class="preset-library"><div class="preset-library-head"><h4>내 프리셋</h4><button type="button" data-action="new">＋ 추가</button></div><div data-p="list"></div></aside>
    <section class="preset-detail"><div class="preset-edit-head"><label>프리셋 이름<input data-field="name" maxlength="80"></label><button type="button" data-action="copy">복제</button></div>
    <section data-p="object-source" class="preset-object-source" aria-label="객체 정보 출처"></section>
    <div class="preset-fields"><label>실행 범위<select data-p="range"><option value="all">전체 경로</option><option value="custom">단계 구간 지정</option></select></label><label data-range-field hidden>시작 단계<select data-p="start"></select></label><label data-range-field hidden>종료 단계<select data-p="end"></select></label></div>
    <details class="preset-coordinates" open><summary>객체·경유점·박스 좌표</summary><div data-p="coordinates"></div><button type="button" data-action="import-box">택배 박스 탭의 저장 좌표 가져오기</button></details>
    <div class="preset-step-add"><h4>단계별 조인트 설정 · °</h4><label>추가할 동작<select data-p="kind">${Object.entries(names).filter(([k])=>!['prepare','checkpoint'].includes(k)).map(([v,t])=>`<option value="${v}">${t}</option>`).join('')}</select></label><button type="button" data-action="add">단계 추가</button></div>
    <p class="scenario-caption">자동 묶음은 내부 좌표와 순서를 잠급니다. 이동 속도 100%는 현재 허용 상한(관절 10°/s · 직선 10 mm/s · 그리퍼 10 rpm)입니다.</p>
    <div class="preset-table-scroll"><table class="scenario-joint-table preset-table"><thead><tr><th>단계</th><th>이동 방식</th><th>이동 속도</th><th>입력 방식</th>${[1,2,3,4,5,6].map(i=>'<th>J'+i+'</th>').join('')}</tr></thead><tbody data-p="steps"></tbody></table></div>
    <section class="preset-voice-binding"><div class="preset-edit-head"><h4>음성 명령 연결</h4><label class="preset-check"><input type="checkbox" data-field="voice_enabled">음성 사용</label></div><label>등록 명령 · 한 줄에 하나<textarea data-p="aliases" rows="2" placeholder="로봇 A박스 포장"></textarea></label><label>실행 확인<select data-field="confirmation"><option value="screen">화면에서 승인 후 실행</option><option value="voice">‘로봇 실행’으로 음성 재확인</option></select></label><button type="button" data-action="use-transcript" disabled>최근 인식문을 명령에 추가</button><p class="scenario-caption">공통 명령: 로봇 실행 · 로봇 취소 · 로봇 중단 · 음성 대기 종료</p></section>
    <div class="pose-actions"><button type="button" data-action="save">프리셋 저장</button><button type="button" data-action="discard">변경 취소</button><button type="button" data-action="reload">최신 설정 불러오기</button></div><p data-p="message" role="status"></p></section></div>
    <section class="preset-player"><div class="panel-head"><h4>경로 시뮬레이션 · 실제 실행</h4><span data-p="count"></span></div><div class="pose-actions"><button type="button" data-action="play">시뮬레이션 시작</button><button type="button" data-action="pause">일시정지 / 계속</button><button type="button" data-action="sim-stop">종료</button><label>재생 배속<select data-p="rate"><option>1</option><option>5</option><option selected>10</option><option>20</option></select></label><button type="button" data-action="hardware">실제 프리셋 실행</button></div><p data-p="simulation" role="status">경로를 불러오는 중입니다.</p><p data-p="job" role="status"></p></section>
    <section class="preset-voice-console"><div class="preset-edit-head"><h4>음성 명령</h4><span data-p="mic-state" class="scenario-badge">청취 종료</span></div><div class="pose-actions"><label>음성 실행 대상<select data-p="voice-target"><option value="simulation">시뮬레이션</option><option value="hardware">실제 로봇</option></select></label><button type="button" data-action="listen">음성 대기 시작</button><button type="button" data-action="unlisten">음성 대기 종료</button></div><p class="scenario-caption">마이크 입력은 Mac 음성 서비스를 사용합니다. 종료 전까지 연속 대기합니다. 청취 종료와 로봇 작업 중단은 별개입니다.</p><p data-p="transcript"></p><p data-p="voice-message" role="status"></p><div data-p="voice-selection" class="preset-pending preset-voice-selection" hidden></div><div data-p="voice-pending" class="preset-pending" hidden></div>
    <hr><label>문장 입력 테스트 · 실제 장비 실행 불가<input data-p="text" placeholder="등록한 명령을 입력하세요"></label><div class="pose-actions"><button type="button" data-action="text-test">명령 테스트</button><button type="button" data-action="test-play" disabled>테스트 결과 시뮬레이션</button></div><p data-p="test-result" role="status"></p><div data-p="test-targets" class="preset-detection-candidates"></div></section>
    <dialog data-p="dialog" aria-labelledby="preset-execution-title"><h3 id="preset-execution-title">실제 프리셋 실행 승인</h3><p data-p="approval-summary"></p><pre data-p="approval-path" class="scenario-hardware-path"></pre><p data-p="approval-status" role="status"></p><div class="pose-actions"><button type="button" data-action="cancel">취소</button><button type="button" data-action="approve">승인 후 실제 실행</button></div></dialog>`;
  const ui=Object.fromEntries([...root.querySelectorAll('[data-p]')].map(n=>[n.dataset.p,n]));
  const productMount=document.querySelector('[data-product-mount]');
  productMount.innerHTML=`<p data-product-preset class="scenario-caption"></p><div class="scenario-regions">${['floor','shelf'].map(region=>`<section class="scenario-card"><h4>${region==='floor'?'바닥 · 수직 파지':'선반 · 수평 파지'}</h4>${numberInput('context.approaches.'+region+'.distance_mm',100,'접근·후퇴 간격 (mm)')}${region==='shelf'?'<label class="preset-check"><input type="checkbox" data-field="context.approaches.shelf.reverse">수평 접근 방향 반전</label>':''}<a href="/robot?pick_region=${region}#work-plane">파지 평면 네 점 교시 →</a></section>`).join('')}</div><div class="pose-actions"><button type="button" data-action="save">프리셋 저장</button><button type="button" data-action="discard">변경 취소</button><a href="#work-points-title">이동 프리셋에서 확인</a></div><p data-product-message role="status"></p>`;
  const on=(el,event,fn)=>el.addEventListener(event,fn,{signal});
  let presets=[],draft=null,dirty=false,busy=false,realBusy=false,conflict=false,recipe=null,testRecipe=null,previewTimer,pollTimer,epoch=0,ticket=null,ticketTimer,lastVoiceSimulation=null,simulation={state:'idle',step:0};
  let voicePending=null,voiceSelection=null,voicePreparation=null,lastTranscript='',lastStopSerial=null,testBinding=null,textRequest=0;
  let voiceBusy=false,voiceListening=false,voiceCanStop=false,pollEpoch=0;
  const message=(text,error=false)=>{ui.message.textContent=productMount.querySelector('[data-product-message]').textContent=text;ui.message.dataset.error=error;};
  const detection=connectPresetDetection(ui['object-source'],{getDraft:()=>draft,onChange:()=>changed(true),onResolved:resolveDetection,onPrepare:()=>void hardware(null,true),signal});
  const snapshot=()=>{if(draft)cache.set(draft.id,{draft:structuredClone(draft),dirty});};
  function invalidate(keepDetection=false){epoch++;clearTimeout(previewTimer);recipe=null;arm.simulationAction('stop');arm.setScenarioPreview(null);cancelTicket();if(!keepDetection)detection.reset();}
  async function resolveDetection(options={}){if(options.expired){invalidate(true);controls();return;}if(busy||realBusy)return;invalidate(true);busy=true;controls();try{if(options.capture)await detection.capture();await preview();}catch(error){message(error.message,true);}finally{busy=false;controls();}}
  function cancelTicket(){clearTimeout(ticketTimer);if(ticket){void api('pick/cancel','POST',{approval_id:ticket.approval_id}).catch(()=>{});ticket=null;}if(ui.dialog.open)ui.dialog.close();}
  const simulationActive=()=>['planning','running','paused','awaiting_grip','awaiting_open'].includes(simulation.state);
  function controls(){
    ui.saved.textContent=conflict?'다른 화면에서 변경됨':dirty?'저장 전 변경':'저장됨';
    for(const scope of [root,productMount])for(const button of scope.querySelectorAll('[data-action="save"]'))button.disabled=!draft||!dirty||busy||realBusy||conflict;
    for(const scope of [root,productMount])for(const button of scope.querySelectorAll('[data-action="discard"]'))button.disabled=!dirty||busy||realBusy;
    for(const action of ['new','copy','add','import-box','hardware'])root.querySelector(`[data-action="${action}"]`).disabled=!draft||busy||realBusy||(['hardware','copy'].includes(action)&&(dirty||conflict));
    root.querySelector('[data-action="reload"]').disabled=busy||realBusy;
    if(simulationActive())root.querySelector('[data-action="hardware"]').disabled=true;
    root.querySelector('[data-action="play"]').disabled=!recipe||recipe.errors.length>0||busy||realBusy;
    root.querySelector('[data-action="test-play"]').disabled=!testRecipe||busy||realBusy;
    root.querySelector('[data-action="use-transcript"]').disabled=!lastTranscript||busy||realBusy;
    for(const button of root.querySelectorAll('[data-select]'))button.disabled=busy||realBusy;
    for(const button of root.querySelectorAll('[data-op]'))button.disabled=busy||realBusy||(button.dataset.op==='execute'&&(dirty||conflict||simulationActive()));
    for(const input of root.querySelectorAll('[data-field],[data-joint],[data-node-field],[data-node-value],[data-prepare-speed], [data-p="aliases"], [data-p="range"],[data-p="start"],[data-p="end"]'))input.disabled=busy||realBusy||input.hasAttribute('data-locked');
    for(const input of productMount.querySelectorAll('[data-field]'))input.disabled=busy||realBusy;
    productMount.querySelector('[data-product-preset]').textContent=draft?'편집 중인 프리셋: '+draft.name:'';
    document.querySelector('[data-product-saved]').textContent=ui.saved.textContent;
    detection.controls({busy,locked:realBusy||simulationActive(),dirty:dirty||conflict});
    for(const button of root.querySelectorAll('[data-action="voice-approve"],[data-action="voice-select"],[data-action="voice-prepare"]'))button.disabled=busy||realBusy||dirty||conflict||button.hasAttribute('data-invalid');
    root.querySelector('[data-action="listen"]').disabled=voiceBusy||voiceListening;
    root.querySelector('[data-action="unlisten"]').disabled=voiceBusy||!voiceCanStop;
    ui['voice-target'].disabled=voiceBusy||voiceListening;
  }
  function list(){ui.list.innerHTML=presets.map(p=>`<button type="button" class="preset-list-item" data-select="${p.id}" aria-pressed="${p.id===draft?.id}"><strong>${esc(p.name)}</strong><small>${p.steps.length}개 동작·묶음 · ${p.voice_enabled?esc(p.aliases[0]||'명령 미등록'):'음성 사용 안 함'}</small></button>`).join('');}
  function contextFields(){const c=draft.context,region=draft.region,depth=region==='floor'?2:0;ui.coordinates.innerHTML=`<div class="preset-fields">${draft.object_source==='yolo'?numberInput(`context.virtual.${region}.size_mm.${depth}`,c.virtual[region].size_mm[depth],'물체 두께·깊이 (mm)'):[0,1,2].map((i)=>numberInput(`context.virtual.${region}.center_base_mm.${i}`,c.virtual[region].center_base_mm[i],'객체 중심 '+'XYZ'[i]+' (mm)')).join('')+[0,1,2].map(i=>numberInput(`context.virtual.${region}.size_mm.${i}`,c.virtual[region].size_mm[i],`객체 ${'XYZ'[i]} 크기 (mm)`)).join('')}</div><details><summary>대기·경유 관절각</summary>${['standby_joints','waypoint1_joints'].map(key=>`<p class="scenario-caption">${key==='standby_joints'?'대기 자세':'1차 경유점'}</p><div class="preset-fields">${[0,1,2,3,4,5].map(i=>numberInput(`context.${key}.${i}`,c[key]?.[i],'J'+(i+1)+' (°)')).join('')}</div>`).join('')}</details><details><summary>박스 놓기 TCP · BASE</summary><div class="preset-fields">${[0,1,2,3,4,5].map(i=>numberInput(`box_pose.${i}`,draft.box_pose?.[i],'XYZABC'[i]+(i<3?' (mm)':' (°)'))).join('')}${numberInput('context.box_clearance_mm',c.box_clearance_mm,'박스 위 간격 (mm)')}${numberInput('context.standby_opening_mm',c.standby_opening_mm,'대기 벌림 (mm)')}</div></details>`;}
  function render(){if(!draft)return;
    list();for(const el of [...root.querySelectorAll('[data-field]'),...productMount.querySelectorAll('[data-field]')]){const value=at(draft,el.dataset.field);if(el.type==='checkbox')el.checked=Boolean(value);else el.value=value??'';}
    ui.aliases.value=draft.aliases.join('\n');ui.range.value=draft.range_start?'custom':'all';
    const options=draft.steps.map((s,i)=>`<option value="${s.id}">${i+1} · ${esc(s.name||names[s.kind])}</option>`).join('');ui.start.innerHTML=ui.end.innerHTML=options;
    ui.start.value=draft.range_start||draft.steps[0].id;ui.end.value=draft.range_end||draft.steps.at(-1).id;for(const el of root.querySelectorAll('[data-range-field]'))el.hidden=ui.range.value!=='custom';
    contextFields();renderSteps();detection.activate();controls();
  }
  function operations(index){return `<div class="preset-row-actions"><button type="button" data-op="up" data-index="${index}" aria-label="${index+1}번 동작 위로">↑</button><button type="button" data-op="down" data-index="${index}" aria-label="${index+1}번 동작 아래로">↓</button><button type="button" data-op="copy" data-index="${index}" aria-label="${index+1}번 동작 복제">복제</button><button type="button" data-op="delete" data-index="${index}">삭제</button>${draft.steps[index].kind==='checkpoint'?'':`<button type="button" data-op="execute" data-index="${index}" ${dirty?'disabled':''}>이 단계 실행</button>`}</div>`;}
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
      const speed=s.kind==='wait'?'—':`<select ${draft.steps[index].kind==='prepare'?`data-prepare-speed="${index}.${childIndex}"`:`data-node-field="${prefix}.percent"`} aria-label="${row+1}단계 이동 속도">${percentage%10?`<option value="legacy" selected disabled>${percentage}% · 기존</option>`:''}${percentages(percentage)}</select>`;
      const modes=['movej','movel','movec'].includes(s.kind)?`<select data-node-field="${prefix}.kind" aria-label="${row+1}단계 이동 방식" ${auto?'data-locked disabled':''}>${['movej','movel','movec'].map(k=>`<option ${s.kind===k?'selected':''}>${k}</option>`).join('')}</select>`:names[s.kind];
      const inputMode=['movej','movel','movec'].includes(s.kind)&&!auto?`<select data-node-field="${prefix}.space"><option value="joint" ${s.space==='joint'?'selected':''}>관절 입력</option><option value="task" ${s.space==='task'?'selected':''}>TCP 입력</option></select>`:auto?'자동 계산':'팔 자세 유지';
      const title=s.name||names[s.kind];row++;
      let html=`<tr class="scenario-stage-joints" data-preset-step="${esc(s.id)}"><th scope="row"><strong>${row} · ${esc(title)}</strong>${childIndex===null&&!forced?operations(index):''}</th><td>${modes}</td><td>${speed}</td><td>${inputMode}</td>${[0,1,2,3,4,5].map(j=>`<td><input type="number" step="any" aria-label="${row}단계 J${j+1}" ${editable?'data-joint="'+index+'.'+j+'"':'readonly'} value="${esc(editable?s.target?.[j]:joints?.[j]===undefined?'':Number(joints[j].toFixed(2)))}"></td>`).join('')}</tr>`;
      if(childIndex===null&&!forced){let fields='';
        if(s.space==='task'&&['movej','movel','movec'].includes(s.kind)&&!auto)fields+=`<div class="preset-fields">${[0,1,2,3,4,5].map(i=>`<label>TCP ${'XYZABC'[i]}<input type="number" step="any" data-node-value="${index}.target.${i}" value="${esc(s.target?.[i])}"></label>`).join('')}</div>`;
        if(s.kind==='movec')fields+=`<p class="scenario-caption">원호 경유 TCP</p><div class="preset-fields">${[0,1,2,3,4,5].map(i=>`<label>${'XYZABC'[i]}<input type="number" step="any" data-node-value="${index}.via_pose.${i}" value="${esc(s.via_pose?.[i])}"></label>`).join('')}</div>`;
        if(s.kind==='gripper')fields+=`<label>벌림 기준<select data-node-field="${index}.opening_source">${[['explicit','직접 입력'],['object','객체 권장 벌림'],['idle','대기 벌림']].map(([v,t])=>`<option value="${v}" ${(s.opening_source||'explicit')===v?'selected':''}>${t}</option>`).join('')}</select></label><label>벌림 (mm)<input type="number" step="any" data-node-field="${index}.opening_mm" ${s.opening_source&&s.opening_source!=='explicit'?'data-locked disabled':''} value="${esc(s.opening_source&&s.opening_source!=='explicit'?compiled?.opening_mm:s.opening_mm)}"></label><label class="preset-check"><input type="checkbox" data-node-field="${index}.contact" ${s.contact?'checked':''}>접촉 전류까지 닫기</label>`;
        if(s.kind==='wait')fields+=`<label>대기 시간 (0.1~600초)<input type="number" step="any" min=".1" max="600" data-node-field="${index}.seconds" value="${s.seconds??1}"></label>`;
        if(fields)html+=`<tr class="preset-extra"><td colspan="10"><details data-step-details="${s.id}" ${(expanded.get(s.id)??(s.kind==='wait'||s.kind==='gripper'))?'open':''}><summary>동작 상세 설정</summary>${fields}</details></td></tr>`;
      }
      return html;
    }
    ui.steps.innerHTML=draft.steps.map((s,index)=>{
      if(s.kind==='checkpoint')return `<tr><th colspan="10">${draft.object_source==='yolo'?'YOLO 대상 확인 · '+(recipe?.detected?.label||'대상 선택 전'):'저장된 객체 좌표 확인'} ${operations(index)}</th></tr>`;
      if(groupKinds.has(s.kind)){
        const compiled=(recipe?.steps||[]).filter(c=>c.group_id===s.id);
        let html=`<tr class="scenario-table-phase"><th colspan="10">${esc(s.name||names[s.kind])} · 내부 순서 고정 ${operations(index)}</th></tr>`;
        if(compiled.length)html+=compiled.map((c,j)=>tr(s.children?.[j]||{...s,kind:c.motion||c.kind,name:c.title,id:c.id},index,j,c)).join('');
        else html+=`<tr><td colspan="10">객체·박스 좌표 입력 후 자동 계산됩니다.</td></tr>`;
        return html;
      }
      return tr(s,index);
    }).join('');
    if(focus)ui.steps.querySelector(`[${focus[0]}="${CSS.escape(focus[1])}"]`)?.focus({preventScroll:true});
  }
  function changed(rerender=false){dirty=true;conflict=false;snapshot();invalidate();if(voicePending||voiceSelection||voicePreparation){voicePending=voiceSelection=voicePreparation=null;ui['voice-pending'].hidden=ui['voice-selection'].hidden=true;void api('preset-voice/cancel','POST',{},signal).catch(()=>{});}if(rerender)render();controls();previewTimer=setTimeout(preview,300);}
  async function preview(){if(!draft||signal.aborted)return;const version=++epoch;try{const p=await api(`presets/${draft.id}/preview`,'POST',{preset:draft,...(draft.object_source==='yolo'?detection.payload():{})},signal);if(version!==epoch)return;recipe=p;arm.setScenarioPreview(p.object_source==='yolo'&&p.errors.length?null:p);ui.count.textContent=p.steps.length+'단계';ui.simulation.textContent=p.errors.length?p.errors.join(' '):'재생 준비 완료 · 실제 장치 명령 없음';renderSteps();controls();}catch(error){if(version===epoch){recipe=null;arm.setScenarioPreview(null);ui.simulation.textContent=error.message;controls();}}}
  async function choose(id){snapshot();invalidate();const p=presets.find(p=>p.id===id)||presets[0];selected=p.id;const url=new URL(location.href);url.searchParams.set('preset',selected);history.replaceState(history.state,'',url);const stored=cache.get(p.id);draft=structuredClone(stored?.dirty?stored.draft:p);dirty=stored?.dirty||false;conflict=dirty&&draft.revision!==p.revision;message('');render();await preview();}
  async function load(){busy=true;controls();try{presets=(await api('presets','GET',undefined,signal)).presets;await choose(presets.some(p=>p.id===selected)?selected:presets[0].id);}catch(error){message(error.message,true);}finally{busy=false;controls();}}
  async function save(){if(!draft||busy||realBusy)return;busy=true;controls();try{const p=await api('presets/'+draft.id,'PUT',draft,signal);presets=presets.map(item=>item.id===p.id?p:item);draft=p;dirty=false;conflict=false;snapshot();invalidate();render();await preview();message('프리셋을 저장했습니다.');}catch(error){if(error.status===412)conflict=true;message(error.message,true);}finally{busy=false;controls();}}
  async function create(copy=false){busy=true;controls();try{const p=copy?await api(`presets/${draft.id}/copy`,'POST',{revision:presets.find(p=>p.id===draft.id).revision},signal):await api('presets','POST',{id:uid(),name:'새 이동 경로'},signal);presets.push(p);await choose(p.id);}catch(error){message(error.message,true);}finally{busy=false;controls();}}
  async function hardware(stepId=null,recognition=false){
    if(dirty||busy||realBusy||simulationActive())return;
    busy=true;controls();const version=epoch;
    try{
      const binding=draft.object_source==='yolo'&&!recognition?await detection.ensure(true):{};
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
    if(el===ui.text){textRequest++;testRecipe=null;testBinding=null;ui['test-targets'].innerHTML='';controls();return;}
    if(el.dataset.field){const key=el.dataset.field;const value=el.type==='checkbox'?el.checked:el.type==='number'?(Number.isFinite(el.valueAsNumber)?el.valueAsNumber:null):el.value;
      if(key.startsWith('box_pose.')&&!draft.box_pose)draft.box_pose=Array(6).fill(null);
      if(key.startsWith('context.waypoint1_joints.')&&!draft.context.waypoint1_joints)draft.context.waypoint1_joints=Array(6).fill(null);
      put(draft,key,value);changed(key==='region');
    }else if(el===ui.aliases){draft.aliases=el.value.split('\n').map(s=>s.trim()).filter(Boolean);changed();}
    else if(el.dataset.joint){const [n,j]=el.dataset.joint.split('.').map(Number),s=draft.steps[n];s.target??=Array(6).fill(null);s.target[j]=Number.isFinite(el.valueAsNumber)?el.valueAsNumber:null;changed();}
    else if(el.dataset.prepareSpeed){const [index,child]=el.dataset.prepareSpeed.split('.').map(Number),s=draft.steps[index];if(child===0){s.percent=Number(el.value);s.legacy_speed=null;}else{s.prepare_hand_speed={speed:Number(el.value)/10,acceleration:s.prepare_hand_speed?.acceleration||3000};}changed();}
    else if(el.dataset.nodeValue){const [n,key,j]=el.dataset.nodeValue.split('.'),s=draft.steps[n];s[key]??=Array(6).fill(null);s[key][Number(j)]=Number.isFinite(el.valueAsNumber)?el.valueAsNumber:null;changed();}
    else if(el.dataset.nodeField){const [key,field]=el.dataset.nodeField.split('.'),s=nodeAt(key);s[field]=el.type==='checkbox'?el.checked:el.type==='number'?(Number.isFinite(el.valueAsNumber)?el.valueAsNumber:null):field==='percent'?Number(el.value):el.value;if(field==='percent')s.legacy_speed=null;if(field==='space'){s.source='explicit';s.reference_id=null;s.target=null;}changed(['kind','space','opening_source'].includes(field));}
  }
  for(const scope of [root,productMount]){on(scope,'input',input);on(scope,'click',async event=>{const button=event.target.closest('button');if(!button)return;try{
    if(button.dataset.select){if(!busy&&!realBusy)await choose(button.dataset.select);return;}
    const op=button.dataset.op;if(op&&!busy&&!realBusy){const i=Number(button.dataset.index),s=draft.steps[i];if(op==='execute'){await hardware(s.id);return;}if(op==='copy'){const copy=structuredClone(s);copy.id=uid();for(const child of copy.children||[])child.id=uid();draft.steps.splice(i+1,0,copy);}else if(op==='delete'){if(draft.steps.length===1)throw Error('한 개 이상의 동작을 남겨주세요.');if(draft.steps.some(n=>n.reference_id===s.id))throw Error('다른 단계가 참조하고 있어 삭제할 수 없습니다.');draft.steps.splice(i,1);if([draft.range_start,draft.range_end].includes(s.id))draft.range_start=draft.range_end=null;}else{const next=i+(op==='up'?-1:1);if(next<0||next>=draft.steps.length)return;[draft.steps[i],draft.steps[next]]=[draft.steps[next],draft.steps[i]];}changed(true);return;}
    if((busy||realBusy)&&['new','copy','discard','reload','import-box','play','test-play','use-transcript'].includes(button.dataset.action))return;
    switch(button.dataset.action){
      case 'new':await create();break;case 'copy':await create(true);break;case 'save':await save();break;
      case 'discard':{const id=draft.id;cache.delete(id);draft=null;dirty=false;await choose(id);break;}
      case 'reload':cache.delete(draft?.id);dirty=false;draft=null;await load();break;
      case 'add':if(busy||realBusy)break;draft.steps.push({id:uid(),kind:ui.kind.value,name:names[ui.kind.value],percent:50,acceleration:ui.kind.value==='gripper'?3000:5,space:'joint',source:'explicit',target:null,seconds:1,contact:false,children:[]});changed(true);break;
      case 'import-box':{busy=true;controls();try{const data=await api('status','GET',undefined,signal);draft.box_pose=structuredClone(data.work_points.box.pose);draft.box_size=data.parcel_box.size_mm;draft.box_center=data.parcel_box.center_base_mm;changed(true);}finally{busy=false;controls();}break;}
      case 'play':if(recipe&&!recipe.errors.length){arm.simulationAction('rate',Number(ui.rate.value));await arm.simulateRecipe(recipe);}break;
      case 'pause':arm.simulationAction(simulation.state==='paused'?'resume':'pause');break;
      case 'sim-stop':arm.simulationAction('stop');break;
      case 'hardware':await hardware();break;case 'cancel':cancelTicket();break;
      case 'approve':{if(!ticket||busy||realBusy)break;const id=ticket.approval_id;ticket=null;clearTimeout(ticketTimer);root.querySelector('[data-action="approve"]').disabled=true;busy=true;controls();try{const move=await api('presets/executions/approve','POST',{approval_id:id},signal);realBusy=!terminal(move.state);ui.dialog.close();ui.job.textContent=move.message;await poll();}finally{busy=false;controls();}break;}
      case 'listen':await listening(true);break;
      case 'unlisten':await listening(false);break;
      case 'voice-approve':if(voicePending){await api('preset-voice/approve','POST',{approval_id:voicePending.approval_id},signal);await poll();}break;
      case 'voice-select':if(voiceSelection){await api('preset-voice/select','POST',{request_id:voiceSelection.request_id,candidate_id:button.dataset.candidate},signal);await poll();}break;
      case 'voice-prepare':if(voicePreparation&&!busy&&!realBusy){const target=voicePreparation;presets=(await api('presets','GET',undefined,signal)).presets;await choose(target.preset_id);if(draft.id!==target.preset_id||draft.revision!==target.revision)throw Error('프리셋이 변경되었습니다. 명령을 다시 확인하세요.');await hardware(null,true);}break;
      case 'voice-cancel':await api('preset-voice/cancel','POST',{},signal);await poll();break;
      case 'use-transcript':if(lastTranscript){draft.aliases=[...new Set([...draft.aliases,lastTranscript.trim()])];ui.aliases.value=draft.aliases.join('\n');changed();}break;
      case 'text-test':await testSentence();break;
      case 'text-select':if(testBinding)await testSentence({snapshot_id:testBinding.snapshot_id,candidate_id:button.dataset.candidate});break;
      case 'test-play':if(testRecipe){arm.simulationAction('rate',Number(ui.rate.value));await arm.simulateRecipe(testRecipe);}break;
    }
  }catch(error){message(error.message,true);if(button.dataset.action==='approve')ui['approval-status'].textContent=error.message;if(['listen','unlisten','voice-select','voice-approve','voice-prepare'].includes(button.dataset.action))ui['voice-message'].textContent=error.message;if(['text-test','text-select'].includes(button.dataset.action))ui['test-result'].textContent=error.message;}});}
  for(const el of [ui.range,ui.start,ui.end])on(el,'change',()=>{if(!draft)return;draft.range_start=ui.range.value==='all'?null:ui.start.value;draft.range_end=ui.range.value==='all'?null:ui.end.value;changed(true);});
  on(ui.rate,'change',()=>arm.simulationAction('rate',Number(ui.rate.value)));
  async function listening(start){
    if(voiceBusy)return;
    voiceBusy=true;pollEpoch++;clearTimeout(pollTimer);pollTimer=null;controls();
    try{await api('preset-voice/'+(start?'start':'stop'),'POST',start?{target:ui['voice-target'].value}:{},signal);await poll();}
    finally{voiceBusy=false;controls();if(!signal.aborted&&!pollTimer)pollTimer=setTimeout(poll,700);}
  }
  async function testSentence(binding={}){
    const version=++textRequest,text=ui.text.value;testRecipe=null;ui['test-targets'].innerHTML='';controls();
    const result=await api('preset-voice/test','POST',{text,...binding},signal);if(version!==textRequest)return;
    testRecipe=result.recipe;testBinding=result.detection||null;
    if(testRecipe)ui['test-result'].textContent=result.name+' · 저장된 '+result.revision.slice(0,8)+' · '+testRecipe.steps.length+'단계 · 시뮬레이션 전용';
    else{ui['test-result'].textContent=result.name+' · 문장 테스트 · '+result.detection.message;ui['test-targets'].innerHTML=result.detection.candidates.map((c,i)=>`<button type="button" data-action="text-select" data-candidate="${c.id}" ${c.reason?'disabled':''}>${esc(c.label)} · 후보 ${i+1} · ${Math.round(c.confidence*100)}% · ${esc(c.reason||c.pose?.join(', '))}</button>`).join('');}
    controls();
  }
  on(ui.dialog,'close',cancelTicket);
  on(window,'robot-global-stop',()=>{invalidate();void poll();});
  const unsubscribe=arm.observeSimulation(next=>{simulation=next;ui.simulation.textContent=`${next.step||0}/${recipe?.steps.length||next.route?.length||0} · ${next.message||next.state}`;for(const row of ui.steps.querySelectorAll('[data-preset-step]'))row.dataset.current=recipe?.steps?.[next.step-1]?.id===row.dataset.presetStep?'true':'false';controls();});
  async function poll(){clearTimeout(pollTimer);pollTimer=null;if(signal.aborted)return;const request=++pollEpoch;try{
    const visible=!document.hidden&&!root.closest('[data-manipulator-panel]').hidden;
    const [v,status]=await Promise.all([api('preset-voice/status?heartbeat='+visible,'GET',undefined,signal),api('pick/scenario/status','GET',undefined,signal)]);
    if(request!==pollEpoch||signal.aborted)return;
    voiceListening=v.listening;voiceCanStop=v.listening||v.can_stop;
    ui['mic-state'].textContent=v.listening?'연속 대기 · '+v.state:v.can_stop?'마이크 종료 재시도 필요':'청취 종료';if(v.listening)ui['voice-target'].value=v.target;
    if(lastStopSerial!==null&&lastStopSerial!==v.stop_serial)invalidate();lastStopSerial=v.stop_serial;lastTranscript=v.transcript||'';root.querySelector('[data-action=use-transcript]').disabled=!lastTranscript||busy||realBusy;
    ui.transcript.textContent=v.transcript?'인식 문장: '+v.transcript:'';ui['voice-message'].textContent=v.message;
    voicePending=v.pending;ui['voice-pending'].hidden=!voicePending;if(voicePending)ui['voice-pending'].innerHTML=`<strong>${esc(voicePending.name)}</strong><p>${esc(voicePending.range_label)} · ${voicePending.total_steps}단계 · ${voicePending.target==='hardware'?'실제 로봇':'시뮬레이션'} · 저장된 ${esc(voicePending.revision.slice(0,8))}</p><div class="pose-actions">${voicePending.confirmation==='screen'?'<button type="button" data-action="voice-approve">승인 후 실행</button>':'<span>‘로봇 실행’을 말씀하세요.</span>'}<button type="button" data-action="voice-cancel">취소</button></div>`;
    if(voicePending?.detected){const data=voicePending.detected;ui['voice-pending'].insertAdjacentHTML('beforeend',`<p>YOLO 대상: ${esc(data.label)} · ${Math.round(data.confidence*100)}% · 파지 TCP [${esc(data.pose.join(', '))}] · 벌림 ${data.opening_mm.toFixed(2)} mm</p>`);}
    voiceSelection=v.selection;voicePreparation=v.needs_preparation;ui['voice-selection'].hidden=!voiceSelection&&!voicePreparation;
    if(voiceSelection)ui['voice-selection'].innerHTML=`<strong>${esc(voiceSelection.name)} · YOLO 대상 선택</strong><p>실행할 대상을 선택한 뒤 별도로 승인합니다. ${voiceSelection.target==='hardware'?'실제 로봇':'시뮬레이션'}</p><div class="preset-detection-candidates">${voiceSelection.detection.candidates.map((c,i)=>`<button type="button" data-action="voice-select" data-candidate="${c.id}" ${c.reason?'disabled data-invalid':''}>${esc(c.label)} · 후보 ${i+1} · ${Math.round(c.confidence*100)}% · ${esc(c.reason||c.pose?.join(', '))}</button>`).join('')}</div><button type="button" data-action="voice-cancel">선택 취소</button>`;
    else if(voicePreparation)ui['voice-selection'].innerHTML=`<strong>${esc(voicePreparation.name)} · 인식 자세 준비 필요</strong><p>저장된 대기 자세 이동을 먼저 화면에서 승인하세요. 준비 후 등록 명령을 다시 말씀하세요.</p><button type="button" data-action="voice-prepare">인식 자세 준비</button>`;
    const move=status.move;realBusy=Boolean(v.busy||(move&&!terminal(move.state)));if(realBusy&&simulationActive())arm.simulationAction('stop');ui.job.textContent=move?`${move.step||0}/${move.total_steps||move.steps?.length||17} · ${move.message}`:realBusy?'다른 실제 로봇 작업이 진행 중입니다.':'진행 중인 실제 작업이 없습니다.';
    if(v.simulation&&v.simulation.id!==lastVoiceSimulation&&visible&&!realBusy&&!busy){
      if(dirty){lastVoiceSimulation=v.simulation.id;message('저장 전 편집값이 있어 음성 시뮬레이션을 시작하지 않았습니다. 저장하거나 취소한 뒤 다시 요청하세요.',true);}
      else{
        presets=(await api('presets','GET',undefined,signal)).presets;
        if(request!==pollEpoch||signal.aborted)return;
        await choose(v.simulation.recipe.preset_id);
        if(request!==pollEpoch||signal.aborted)return;
        if(!dirty&&draft.revision===v.simulation.recipe.revision){lastVoiceSimulation=v.simulation.id;recipe=v.simulation.recipe;arm.simulationAction('rate',Number(ui.rate.value));await arm.simulateRecipe(recipe);}
        else{lastVoiceSimulation=v.simulation.id;message('프리셋이 변경되었거나 저장 전 편집값이 있습니다. 음성 명령을 다시 확인하세요.',true);}
      }
    }
    controls();
  }catch(error){if(request===pollEpoch&&error.name!=='AbortError')ui['voice-message'].textContent=error.message;}finally{if(!signal.aborted&&request===pollEpoch)pollTimer=setTimeout(poll,700);}}
  signal.addEventListener('abort',()=>{snapshot();clearTimeout(previewTimer);clearTimeout(pollTimer);clearTimeout(ticketTimer);cancelTicket();unsubscribe();},{once:true});
  void load();void poll();
}
