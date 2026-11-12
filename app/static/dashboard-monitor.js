import {connectDashboardCamera} from './dashboard-camera.js';
import {connectDashboardDepth} from './dashboard-depth.js';
import {connectDashboardConversation} from './dashboard-conversation.js';
import {connectDashboardVoiceControls} from './dashboard-voice-controls.js';
import {connectRobotArm} from './robot-arm-view.js';

export function connectDashboardMonitor(root,getStation){
  const lifetime=new AbortController(),signal=lifetime.signal;
  const ui=Object.fromEntries([...root.querySelectorAll('[data-dashboard]')].map(n=>[n.dataset.dashboard,n]));
  const button=name=>root.querySelector(`[data-monitor="${name}"]`);
  let presets=[],recipe=null,busy=false,previewError='',request=0,pollTimer,modulesRevision=null,lastConfig='',lastCatalog=0;
  let simulation={state:'idle',progress:0,step:0},robotVoiceBaseline=false,lastVoiceSimulation=null,lastGlobalStop=null;
  let rgbFrame=null,depthFrame=null;
  let voiceControls=null,playingRecipe=null,pendingVoice=null,voiceSimulationBusy=false;
  const arm=connectRobotArm({armView:ui['arm-view'],modelHint:ui['model-hint']},signal,()=>{}, {readOnly:true,noScroll:true,compact:true});
  arm.active(true);arm.setAttached(true);arm.setScenarioVisible(true);
  let depth;depth=connectDashboardDepth(root.querySelector('.dashboard-depth'),{signal,onFrame:value=>{depthFrame=value;depth?.sync(rgbFrame,depthFrame);}});
  // Feed callbacks may fire before connectDashboardDepth returns.
  const stopCamera=connectDashboardCamera(root.querySelector('#live-camera'),getStation,{onFrame:value=>{rgbFrame=value;depth.sync(rgbFrame,depthFrame);},onStatus:status=>{if(!status.ready){rgbFrame=null;depth.sync(null,depthFrame);}}});
  const selected=()=>presets.find(p=>p.id===ui.preset.value);
  const active=()=>['planning','running','paused','awaiting_grip','awaiting_open'].includes(simulation.state);
  function controls(){
    const reasons=[];if(!selected())reasons.push('모니터링할 프리셋을 선택하세요.');if(busy)reasons.push('저장된 경로를 계산하고 있습니다.');
    if(voiceSimulationBusy)reasons.push('음성으로 승인한 가상 경로를 불러오고 있습니다.');
    if(active())reasons.push(simulation.state==='paused'?'시뮬레이션이 일시정지되어 있습니다. 계속 재생하거나 가상 재생을 종료하세요.':simulation.state.startsWith('awaiting')?'가상 파지·벌림 확인을 기다리고 있습니다. 아래 확인 버튼으로 진행하세요.':'시뮬레이션이 진행 중입니다.');
    if(previewError)reasons.push(previewError);else if(recipe?.errors?.length)reasons.push(...recipe.errors);
    if(selected()&&!recipe&&!busy&&!previewError)reasons.push('경로 계산 결과를 기다리고 있습니다.');
    button('play').disabled=reasons.length>0;button('play').title=reasons.join('\n');ui.reason.textContent=[...new Set(reasons)].join('\n');ui.reason.hidden=!reasons.length;
    button('pause').disabled=!['running','paused'].includes(simulation.state);button('pause').textContent=simulation.state==='paused'?'계속 재생':'일시정지';
    button('sim-stop').disabled=simulation.state==='idle';button('previous').disabled=!['running','paused','complete','awaiting_grip','awaiting_open'].includes(simulation.state)||simulation.step<=1;
    button('next').disabled=!['running','paused','complete','awaiting_grip','awaiting_open'].includes(simulation.state)||simulation.step>=((playingRecipe||recipe)?.steps.length||0);
    ui.progress.disabled=!['running','paused','complete','awaiting_grip','awaiting_open'].includes(simulation.state);ui.preset.disabled=busy||voiceSimulationBusy||active()||!presets.length;
    button('reload').disabled=busy||voiceSimulationBusy||active();button('path').disabled=simulation.state==='idle';button('demo').disabled=busy||voiceSimulationBusy||active();ui['demo-region'].disabled=button('demo').disabled;
    button('confirm').hidden=!['awaiting_grip','awaiting_open'].includes(simulation.state);button('confirm').textContent=simulation.state==='awaiting_open'?'가상 박스에서 열기':'가상 파지 확인 후 이송';
    ui.mode.textContent=playingRecipe?.standalone_demo?'예시 시뮬레이션':simulation.state!=='idle'?'시뮬레이션 재생':'저장된 가상 경로';voiceControls?.refresh();
  }
  function showSimulation(value){simulation=value;root.dataset.simulationState=value.state;
    if(playingRecipe?.voice_approved)voiceControls?.playback(value);
    ui.progress.value=Math.round(value.progress*1000);const count=(playingRecipe||recipe)?.steps.length||0;ui['step-count'].textContent=count?(value.state==='idle'?'—':Math.min(count,value.step))+' / '+count:'—';
    ui.stage.textContent=value.state==='idle'?(recipe?.steps[0]?.title||'저장된 경로를 선택하세요.'):value.message;
    controls();
  }
  const unsubscribe=arm.observeSimulation(showSimulation);
  async function json(url,body){const res=await fetch(url,{method:body?'POST':'GET',cache:'no-store',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.any([signal,AbortSignal.timeout(8000)])});const value=await res.json();if(!res.ok)throw Error(typeof value.detail==='string'?value.detail:Array.isArray(value.detail)?value.detail.map(e=>e.msg).join(' · '):'서비스 연결을 확인하세요.');return value;}
  async function preview(){
    const p=selected();if(!p)return;const serial=++request;busy=true;previewError='';recipe=null;playingRecipe=null;arm.simulationAction('stop');controls();
    ui.edit.href='/robot?preset='+encodeURIComponent(p.id)+'#work-points-title';
    try{
      const value=await json('/api/robot/presets/'+p.id+'/preview',{simulation_defaults:true,simulation_object:Boolean(p.simulation_objects?.[p.region])});
      if(serial!==request||signal.aborted)return;recipe=value;recipe.region??=p.region;
      arm.setScenarioPreview(value.product?.center_base_mm?.every(Number.isFinite)?value:null);arm.setParcelBox(value.box);
      const defaults=value.simulation_defaults||[];ui['simulation-context'].textContent='브라우저 시뮬레이션 · 실제 장비 명령 없음 · 택배 박스 설정 사용'+(defaults.length?' · 가상 기본값: '+defaults.map(v=>v.label).join(', '):'');
      if(p.object_source==='yolo'&&!p.simulation_objects?.[p.region])previewError='실제 YOLO 탐지값을 사용하려면 음성 모드를 로봇 프리셋으로 바꾸고 선택 프리셋 실행 준비를 누르세요. 모델 클래스 선택 후 확인한 경로를 가상 재생합니다.';
      showSimulation({state:'idle',step:0,progress:0});
    }catch(error){if(serial===request&&!signal.aborted){previewError='경로 계산 실패: '+error.message;arm.setScenarioPreview(null);}}
    finally{if(serial===request){busy=false;controls();void consumeVoiceSimulation();}}
  }
  async function load(){
    try{const next=(await json('/api/robot/presets')).presets;if(signal.aborted)return;
      let id=ui.preset.value;try{id||=localStorage.getItem('robot-preset-selection');}catch{}
      const previous=selected();presets=next;ui.preset.replaceChildren(...presets.map(p=>new Option(p.name,p.id)));ui.preset.value=presets.some(p=>p.id===id)?id:presets[0]?.id||'';
      if(!recipe||previous?.revision!==selected()?.revision||previous?.id!==selected()?.id)await preview();else controls();
    }catch(error){if(!signal.aborted){previewError='프리셋 조회 실패: '+error.message;controls();}}
  }
  function robotVoice(value){
    if(!value)return;
    if(lastGlobalStop!==null&&lastGlobalStop!==value.stop_serial)arm.simulationAction('stop');lastGlobalStop=value.stop_serial;
    // A dashboard never replays a previous session's last approved simulation on load.
    if(!robotVoiceBaseline){lastVoiceSimulation=value.simulation?.id;robotVoiceBaseline=true;return;}
    if(!value.simulation){pendingVoice=null;return;}
    if(value.simulation.id!==lastVoiceSimulation){pendingVoice=value.simulation;void consumeVoiceSimulation();}
  }
  async function consumeVoiceSimulation(){
    if(!pendingVoice||busy||voiceSimulationBusy||document.hidden||signal.aborted)return;
    const candidate=pendingVoice,incoming=candidate.recipe;voiceSimulationBusy=true;controls();
    try{
      const [p,modules,box]=await Promise.all([json('/api/robot/presets/'+incoming.preset_id),json('/api/robot/modules'),json('/api/robot/parcel-box')]);
      if(pendingVoice?.id!==candidate.id||signal.aborted)return;
      if(p.revision!==incoming.revision||(incoming.modules_revision&&incoming.modules_revision!==modules.revision)||(incoming.box_revision&&incoming.box_revision!==box.revision))throw Error('프리셋·모듈·박스 설정이 변경되었습니다. 음성 실행을 다시 준비하세요.');
      if(!presets.some(item=>item.id===p.id)){presets.push(p);ui.preset.add(new Option(p.name,p.id));}else presets=presets.map(item=>item.id===p.id?p:item);
      ui.preset.value=p.id;ui.edit.href='/robot?preset='+encodeURIComponent(p.id)+'#work-points-title';
      arm.simulationAction('stop');recipe=incoming;playingRecipe={...incoming,voice_approved:true};recipe.region??=p.region;previewError='';pendingVoice=null;lastVoiceSimulation=candidate.id;
      root.dataset.voiceSimulationId=candidate.id;
      ui['simulation-context'].textContent='음성으로 확인한 저장 경로 · 브라우저 시뮬레이션 · 실제 장비 명령 없음';arm.setScenarioPreview(recipe);arm.simulationAction('rate',Number(ui.rate.value));await arm.simulateRecipe(recipe);
    }catch(error){if(!signal.aborted&&pendingVoice?.id===candidate.id){lastVoiceSimulation=candidate.id;pendingVoice=null;ui.stage.textContent=error.message;}}
    finally{voiceSimulationBusy=false;if(!signal.aborted){controls();if(pendingVoice)void consumeVoiceSimulation();}}
  }
  voiceControls=connectDashboardVoiceControls(ui['voice-controls'],{signal,getContext:()=>({preset:selected(),canPrepare:!busy&&!active()&&!voiceSimulationBusy}),onRobotVoice:value=>{voiceControls.robot(value);robotVoice(value);}});
  connectDashboardConversation(root.querySelector('.dashboard-conversation'),{signal,onRobotVoice:value=>{voiceControls.robot(value);robotVoice(value);},onNativeVoice:value=>voiceControls.native(value)});
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
      if(performance.now()-lastCatalog>10000&&!busy&&!voiceSimulationBusy&&!active()){lastCatalog=performance.now();await load();
        try{const catalog=await json('/api/robot/modules');if(modulesRevision&&modulesRevision!==catalog.revision)await preview();modulesRevision=catalog.revision;}catch{}
      }
    }finally{if(!signal.aborted)pollTimer=setTimeout(poll,2000);}
  }
  root.addEventListener('click',async event=>{const b=event.target.closest('[data-monitor]');if(!b||b.disabled)return;
    try{
    switch(b.dataset.monitor){case'reload':await load();await preview();break;
      case'play':if(recipe&&!recipe.errors.length){playingRecipe=recipe;arm.simulationAction('rate',Number(ui.rate.value));await arm.simulateRecipe(recipe);}break;
      case'demo':{const serial=++request;busy=true;controls();try{const demo=await json('/api/robot/pick/scenario/preview',{example:true,region:ui['demo-region'].value});if(serial!==request||signal.aborted)return;if(demo.errors.length)throw Error(demo.errors.join(' '));arm.simulationAction('stop');playingRecipe={...demo,standalone_demo:true};arm.setScenarioPreview(playingRecipe);ui['simulation-context'].textContent='예시 17단계 · 택배 박스 설정 사용 · 현재 프리셋과 별개 · 저장하지 않음';arm.simulationAction('rate',Number(ui.rate.value));await arm.simulateRecipe(playingRecipe);}finally{if(serial===request){busy=false;controls();void consumeVoiceSimulation();}}break;}
      case'pause':arm.simulationAction(simulation.state==='paused'?'resume':'pause');break;
      case'sim-stop':arm.simulationAction('stop');playingRecipe=null;arm.setScenarioPreview(recipe);break;
      case'previous':arm.simulationAction('step',simulation.step-1);break;
      case'next':arm.simulationAction('step',simulation.step+1);break;
      case'confirm':arm.simulationAction(simulation.state==='awaiting_grip'?'confirm-grip':'open-at-box');break;
      case'path':{const visible=b.getAttribute('aria-pressed')!=='true';b.setAttribute('aria-pressed',visible);arm.setPathVisible(visible);break;}
    }
    }catch(error){if(!signal.aborted){ui.stage.textContent=error.message;controls();}}
  },{signal});
  ui.preset.addEventListener('change',()=>{try{localStorage.setItem('robot-preset-selection',ui.preset.value);}catch{}void preview();},{signal});
  ui.rate.addEventListener('change',()=>arm.simulationAction('rate',Number(ui.rate.value)),{signal});ui.progress.addEventListener('input',()=>arm.simulationAction('seek',Number(ui.progress.value)/1000),{signal});
  window.addEventListener('robot-global-stop',()=>{lastVoiceSimulation=pendingVoice?.id||lastVoiceSimulation;pendingVoice=null;request++;busy=false;arm.simulationAction('stop');playingRecipe=null;controls();},{signal});
  controls();void load();void poll();
  return ()=>{request++;lifetime.abort();clearTimeout(pollTimer);unsubscribe();stopCamera();};
}
