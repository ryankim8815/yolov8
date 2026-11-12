import {connectDashboardCamera} from './dashboard-camera.js';
import {connectDashboardDepth} from './dashboard-depth.js';
import {connectDashboardConversation} from './dashboard-conversation.js';
import {connectRobotArm} from './robot-arm-view.js';

export function connectDashboardMonitor(root,getStation){
  const lifetime=new AbortController(),signal=lifetime.signal;
  const ui=Object.fromEntries([...root.querySelectorAll('[data-dashboard]')].map(n=>[n.dataset.dashboard,n]));
  const button=name=>root.querySelector(`[data-monitor="${name}"]`);
  let presets=[],recipe=null,busy=false,previewError='',request=0,pollTimer,modulesRevision=null,lastConfig='',lastCatalog=0;
  let simulation={state:'idle',progress:0,step:0},robotVoiceBaseline=false,lastVoiceSimulation=null,lastGlobalStop=null;
  let rgbFrame=null,depthFrame=null;
  const arm=connectRobotArm({armView:ui['arm-view'],modelHint:ui['model-hint']},signal,()=>{}, {readOnly:true,noScroll:true,compact:true});
  arm.active(true);arm.setAttached(true);arm.setScenarioVisible(true);
  let depth;depth=connectDashboardDepth(root.querySelector('.dashboard-depth'),{signal,onFrame:value=>{depthFrame=value;depth?.sync(rgbFrame,depthFrame);}});
  // Feed callbacks may fire before connectDashboardDepth returns.
  const stopCamera=connectDashboardCamera(root.querySelector('#live-camera'),getStation,{onFrame:value=>{rgbFrame=value;depth.sync(rgbFrame,depthFrame);},onStatus:status=>{if(!status.ready){rgbFrame=null;depth.sync(null,depthFrame);}}});
  const selected=()=>presets.find(p=>p.id===ui.preset.value);
  const active=()=>['planning','running','paused','awaiting_grip','awaiting_open'].includes(simulation.state);
  function controls(){
    const reasons=[];if(!selected())reasons.push('모니터링할 프리셋을 선택하세요.');if(busy)reasons.push('저장된 경로를 계산하고 있습니다.');
    if(active())reasons.push(simulation.state==='paused'?'시뮬레이션이 일시정지되어 있습니다. 계속 재생하거나 가상 재생을 종료하세요.':simulation.state.startsWith('awaiting')?'가상 파지·벌림 확인을 기다리고 있습니다. 아래 확인 버튼으로 진행하세요.':'시뮬레이션이 진행 중입니다.');
    if(previewError)reasons.push(previewError);else if(recipe?.errors?.length)reasons.push(...recipe.errors);
    if(selected()&&!recipe&&!busy&&!previewError)reasons.push('경로 계산 결과를 기다리고 있습니다.');
    button('play').disabled=reasons.length>0;button('play').title=reasons.join('\n');ui.reason.textContent=[...new Set(reasons)].join('\n');ui.reason.hidden=!reasons.length;
    button('pause').disabled=!['running','paused'].includes(simulation.state);button('pause').textContent=simulation.state==='paused'?'계속 재생':'일시정지';
    button('sim-stop').disabled=simulation.state==='idle';button('previous').disabled=!['running','paused','complete','awaiting_grip','awaiting_open'].includes(simulation.state)||simulation.step<=1;
    button('next').disabled=!['running','paused','complete','awaiting_grip','awaiting_open'].includes(simulation.state)||simulation.step>=(recipe?.steps.length||0);
    ui.progress.disabled=!['running','paused','complete','awaiting_grip','awaiting_open'].includes(simulation.state);ui.preset.disabled=busy||active()||!presets.length;
    button('reload').disabled=busy||active();button('path').disabled=simulation.state==='idle';
    button('confirm').hidden=!['awaiting_grip','awaiting_open'].includes(simulation.state);button('confirm').textContent=simulation.state==='awaiting_open'?'가상 박스에서 열기':'가상 파지 확인 후 이송';
    ui.mode.textContent=simulation.state!=='idle'?'시뮬레이션 재생':'가상 경로 미리보기';
  }
  function showSimulation(value){simulation=value;root.dataset.simulationState=value.state;
    ui.progress.value=Math.round(value.progress*1000);const count=recipe?.steps.length||0;ui['step-count'].textContent=count?(value.state==='idle'?'—':Math.min(count,value.step))+' / '+count:'—';
    ui.stage.textContent=value.state==='idle'?(recipe?.steps[0]?.title||'저장된 경로를 선택하세요.'):value.message;
    controls();
  }
  const unsubscribe=arm.observeSimulation(showSimulation);
  async function json(url,body){const res=await fetch(url,{method:body?'POST':'GET',cache:'no-store',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.any([signal,AbortSignal.timeout(8000)])});const value=await res.json();if(!res.ok)throw Error(typeof value.detail==='string'?value.detail:Array.isArray(value.detail)?value.detail.map(e=>e.msg).join(' · '):'서비스 연결을 확인하세요.');return value;}
  async function preview(){
    const p=selected();if(!p)return;const serial=++request;busy=true;previewError='';recipe=null;arm.simulationAction('stop');controls();
    ui.edit.href='/robot?preset='+encodeURIComponent(p.id)+'#work-points-title';
    try{
      const value=await json('/api/robot/presets/'+p.id+'/preview',{simulation_defaults:true,simulation_object:Boolean(p.simulation_objects?.[p.region])});
      if(serial!==request||signal.aborted)return;recipe=value;recipe.region??=p.region;
      arm.setScenarioPreview(value.product?.center_base_mm?.every(Number.isFinite)?value:null);arm.setParcelBox(value.box);
      const defaults=value.simulation_defaults||[];ui['simulation-context'].textContent='브라우저 시뮬레이션 · 실제 장비 명령 없음 · 택배 박스 설정 사용'+(defaults.length?' · 가상 기본값: '+defaults.map(v=>v.label).join(', '):'');
      if(p.object_source==='yolo'&&!p.simulation_objects?.[p.region])previewError='YOLOv8 클래스 선택과 대상 확인은 이동 프리셋 화면에서 진행하세요. 대시보드 가상 재생에는 저장된 시뮬레이션 객체가 필요합니다.';
      showSimulation({state:'idle',step:0,progress:0});
    }catch(error){if(serial===request&&!signal.aborted){previewError='경로 계산 실패: '+error.message;arm.setScenarioPreview(null);}}
    finally{if(serial===request){busy=false;controls();}}
  }
  async function load(){
    try{const next=(await json('/api/robot/presets')).presets;if(signal.aborted)return;
      let id=ui.preset.value;try{id||=localStorage.getItem('robot-preset-selection');}catch{}
      const previous=selected();presets=next;ui.preset.replaceChildren(...presets.map(p=>new Option(p.name,p.id)));ui.preset.value=presets.some(p=>p.id===id)?id:presets[0]?.id||'';
      if(!recipe||previous?.revision!==selected()?.revision||previous?.id!==selected()?.id)await preview();else controls();
    }catch(error){if(!signal.aborted){previewError='프리셋 조회 실패: '+error.message;controls();}}
  }
  function robotVoice(value){
    if(lastGlobalStop!==null&&lastGlobalStop!==value.stop_serial)arm.simulationAction('stop');lastGlobalStop=value.stop_serial;
    // A dashboard never replays a previous session's last approved simulation on load.
    if(!robotVoiceBaseline){lastVoiceSimulation=value.simulation?.id;robotVoiceBaseline=true;return;}
    if(value.simulation&&value.simulation.id!==lastVoiceSimulation){lastVoiceSimulation=value.simulation.id;
      if(active()||busy)return;const incoming=value.simulation.recipe,p=presets.find(p=>p.id===incoming.preset_id&&p.revision===incoming.revision);
      if(!p)return;ui.preset.value=p.id;recipe=incoming;recipe.region??=p.region;previewError='';arm.setScenarioPreview(recipe);arm.simulationAction('rate',Number(ui.rate.value));void arm.simulateRecipe(recipe);
    }
  }
  connectDashboardConversation(root.querySelector('.dashboard-conversation'),{signal,onRobotVoice:robotVoice});
  async function poll(){
    if(signal.aborted)return;if(document.hidden){pollTimer=setTimeout(poll,2500);return;}
    try{
      const results=await Promise.allSettled([json('/api/robot/status'),json('/api/robot/host-access/status'),json('/api/robot/pick/scenario/status')]);if(signal.aborted)return;
      const status=results[0].status==='fulfilled'?results[0].value:null,host=results[1].status==='fulfilled'?results[1].value:null;
      arm.robotStatus(status);arm.gripperStatus(status,host);
      ui['robot-state'].textContent=host?(host.connection==='connected'&&host.initialized?'실제 로봇 연결됨':'실제 로봇 미연결'):status?.bridge_connected?'로봇 상태 수신 중':status?'실제 로봇 미연결':'로봇 서비스 연결 안 됨';
      const move=results[2].status==='fulfilled'?results[2].value.move:null;
      ui.execution.textContent=move&&!['completed','failed','unknown','cancelled'].includes(move.state)?'실제 작업 · '+(move.message||move.state):'실제 로봇과 별개인 가상 경로';
      if(status?.parcel_box){arm.setParcelBox(status.parcel_box);const config=JSON.stringify(status.parcel_box);if(lastConfig&&lastConfig!==config)await preview();lastConfig=config;}
      if(performance.now()-lastCatalog>10000){lastCatalog=performance.now();await load();
        try{const catalog=await json('/api/robot/modules');if(modulesRevision&&modulesRevision!==catalog.revision)await preview();modulesRevision=catalog.revision;}catch{}
      }
    }finally{if(!signal.aborted)pollTimer=setTimeout(poll,2000);}
  }
  root.addEventListener('click',async event=>{const b=event.target.closest('[data-monitor]');if(!b||b.disabled)return;
    switch(b.dataset.monitor){case'reload':await load();await preview();break;
      case'play':if(recipe&&!recipe.errors.length){arm.simulationAction('rate',Number(ui.rate.value));await arm.simulateRecipe(recipe);}break;
      case'pause':arm.simulationAction(simulation.state==='paused'?'resume':'pause');break;
      case'sim-stop':arm.simulationAction('stop');break;
      case'previous':arm.simulationAction('step',simulation.step-1);break;
      case'next':arm.simulationAction('step',simulation.step+1);break;
      case'confirm':arm.simulationAction(simulation.state==='awaiting_grip'?'confirm-grip':'open-at-box');break;
      case'path':{const visible=b.getAttribute('aria-pressed')!=='true';b.setAttribute('aria-pressed',visible);arm.setPathVisible(visible);break;}
    }
  },{signal});
  ui.preset.addEventListener('change',()=>{try{localStorage.setItem('robot-preset-selection',ui.preset.value);}catch{}void preview();},{signal});
  ui.rate.addEventListener('change',()=>arm.simulationAction('rate',Number(ui.rate.value)),{signal});ui.progress.addEventListener('input',()=>arm.simulationAction('seek',Number(ui.progress.value)/1000),{signal});
  window.addEventListener('robot-global-stop',()=>arm.simulationAction('stop'),{signal});
  controls();void load();void poll();
  return ()=>{request++;lifetime.abort();clearTimeout(pollTimer);unsubscribe();stopCamera();};
}
