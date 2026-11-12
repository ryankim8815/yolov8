const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function connectDashboardVoiceControls(root,{signal,getContext,onRobotVoice}){
  root.innerHTML=`<div class="dashboard-voice-toolbar"><label>음성 모드<select data-vc="mode"><option value="packing">주문·재고 대화</option><option value="robot">로봇 프리셋 · 가상 실행</option></select></label><div class="buttons"><button type="button" data-voice-action="start">음성 대기 시작</button><button type="button" data-voice-action="stop" disabled>청취 종료</button><button type="button" data-voice-action="prepare" hidden>선택 프리셋 실행 준비</button></div><p class="meta" data-vc="hint"></p><p data-vc="message" role="status"></p></div><div data-vc="gate"></div><div data-vc="pending"></div>`;
  const ui=Object.fromEntries([...root.querySelectorAll('[data-vc]')].map(el=>[el.dataset.vc,el])),button=action=>root.querySelector(`[data-voice-action="${action}"]`),markup=new Map();
  let native=null,robot=null,busy=false,nativeConnected=false;
  const fill=(node,html)=>{if(markup.get(node)!==html){node.innerHTML=html;markup.set(node,html);}};
  const notice=(text,error=false)=>{ui.message.textContent=text;ui.message.dataset.error=error;};
  async function call(url,body={}){const response=await fetch(url,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});const value=await response.json();if(!response.ok)throw Error(typeof value.detail==='string'?value.detail:'음성 요청을 처리하지 못했습니다.');return value;}
  function render(){
    const context=getContext(),p=context.preset,robotMode=ui.mode.value==='robot',listening=Boolean(native?.can_stop||robot?.listening||robot?.can_stop);
    ui.mode.disabled=busy||listening;button('start').disabled=busy||listening||!nativeConnected||native?.state==='disabled';button('stop').disabled=busy||!listening;
    button('prepare').hidden=!robotMode;button('prepare').disabled=busy||!p||!context.canPrepare||Boolean(robot?.busy)||Boolean(listening&&native?.context!=='robot')||Boolean(robot?.listening&&robot.target!=='simulation');
    const aliases=p?.voice_enabled?p.aliases||[]:[];
    ui.hint.textContent=robotMode?(aliases.length?'등록 명령: '+aliases.join(' · '):'등록 명령이 없어도 선택 프리셋 실행 준비로 확인할 수 있습니다.')+' · 시뮬레이션 대상 · 승인 후 재생':native?.state==='disabled'?'Mac 음성 기능이 꺼져 있습니다. 음성 서비스를 켜세요.':'마이크로 재고 조회·주문 조회 등을 말씀하세요. 청취 종료는 실행 중인 로봇 작업을 중단하지 않습니다.';
    const c=robot?.class_request,s=robot?.selection;
    let gate='';
    if(c){const phases={loading:'클래스 목록 조회 중',class:'클래스 이름 하나를 말씀하세요',detecting:'최신 YOLO 대상 확인 중',objects:'탐지 객체 선택',no_match:'선택한 클래스의 객체가 보이지 않습니다',preparation:'인식 자세 준비 필요',approval:'경로 확인 완료'};
      gate=`<section class="dashboard-voice-gate"><strong>${esc(phases[c.phase]||c.phase)}</strong><span class="meta">${esc(c.name)} · ${esc(c.model_name||'활성 모델')} · <span data-voice-expiry="class"></span></span><div class="dashboard-voice-classes" aria-label="음성으로 선택 가능한 모델 클래스">${(c.classes||[]).map(entry=>`<span>${esc(entry.name)}</span>`).join('')}</div>${c.recognized?`<p>인식한 클래스: ${esc(c.recognized)}</p>`:''}${c.phase==='preparation'?'<a href="/robot#work-points-title">인식 자세 확인·준비 →</a>':''}<p>${esc(robot.message)}</p>${c.phase==='no_match'?'<button type="button" data-voice-action="retry">클래스 다시 선택</button>':''}</section>`;
    }
    if(s)gate+=`<section class="dashboard-voice-gate"><strong>${esc(s.name)} · 탐지 객체 선택</strong>${(s.detection?.candidates||[]).map((entry,i)=>`<button type="button" data-voice-action="select" data-candidate="${esc(entry.id)}" ${entry.reason||s.target!=='simulation'?'disabled':''}>${esc(entry.label)} · 후보 ${i+1} · ${Math.round(entry.confidence*100)}%${entry.reason?' · '+esc(entry.reason):''}</button>`).join('')}</section>`;
    fill(ui.gate,gate);
    const pending=robot?.pending;
    fill(ui.pending,pending?`<section class="dashboard-voice-pending"><strong>${esc(pending.name)} · ${pending.total_steps}단계</strong><span class="meta">${esc(pending.range_label)} · 저장 버전 ${esc(pending.revision?.slice(0,8))} · <span data-voice-expiry="approval"></span></span><p>${pending.target==='hardware'?'실제 로봇 승인입니다. 이동 프리셋 화면에서 확인하세요.':pending.confirmation==='voice'?'마이크에 “로봇 실행”을 새로 말씀해 재확인하세요.':'선택한 경로의 브라우저 시뮬레이션을 시작합니다.'}</p>${pending.detected?`<p>대상: ${esc(pending.detected.label||'선택 객체')}</p>`:''}<div class="buttons"><button type="button" data-voice-action="approve" ${pending.target!=='simulation'||pending.confirmation!=='screen'?'disabled':''}>승인 후 가상 재생</button><button type="button" data-voice-action="cancel">확인 취소</button></div>${pending.target==='hardware'?'<a href="/robot#work-points-title">실제 로봇 경로 확인 →</a>':''}</section>`:'');
    for(const el of root.querySelectorAll('[data-voice-expiry]'))el.textContent=Math.ceil(el.dataset.voiceExpiry==='class'?c.expires_in:pending.expires_in)+'초 남음';
    for(const b of root.querySelectorAll('[data-voice-action=select],[data-voice-action=approve],[data-voice-action=cancel],[data-voice-action=retry]'))b.disabled=busy||b.hasAttribute('data-locked')||(b.dataset.voiceAction==='approve'&&(pending?.target!=='simulation'||pending?.confirmation!=='screen'))||(b.dataset.voiceAction==='select'&&(!s||s.target!=='simulation'||Boolean(s.detection?.candidates.find(c=>c.id===b.dataset.candidate)?.reason)));
  }
  root.addEventListener('click',async event=>{const b=event.target.closest('[data-voice-action]');if(!b||b.disabled||busy)return;busy=true;notice('');render();
    try{
      let value;
      switch(b.dataset.voiceAction){
        case'start':if(ui.mode.value==='robot'){value=await call('/api/robot/preset-voice/start',{target:'simulation'});robot=value;onRobotVoice(value);}else{native=await call('/api/voice/wake');nativeConnected=true;}notice('음성 대기를 시작했습니다.');break;
        case'stop':if(robot?.listening||robot?.can_stop){robot=await call('/api/robot/preset-voice/stop');onRobotVoice(robot);}else native=await call('/api/voice/stop');notice('청취를 종료했습니다.');break;
        case'prepare':case'retry':{const p=getContext().preset;if(!p)throw Error('프리셋을 선택하세요.');robot=await call('/api/robot/preset-voice/preset-request',{preset_id:p.id,revision:p.revision,target:'simulation'});onRobotVoice(robot);notice(p.object_source==='yolo'?'모델 클래스 이름 하나를 말씀하세요.':'경로를 확인하고 승인하세요.');break;}
        case'select':robot=await call('/api/robot/preset-voice/select',{request_id:robot.selection.request_id,candidate_id:b.dataset.candidate});onRobotVoice(robot);break;
        case'approve':await call('/api/robot/preset-voice/approve',{approval_id:robot.pending.approval_id});notice('승인한 가상 경로를 불러오고 있습니다.');break;
        case'cancel':robot=await call('/api/robot/preset-voice/cancel');onRobotVoice(robot);notice('실행 확인을 취소했습니다.');break;
      }
    }catch(error){if(!signal.aborted)notice(error.message,true);}finally{busy=false;if(!signal.aborted)render();}
  },{signal});
  ui.mode.addEventListener('change',()=>{notice('');render();},{signal});
  render();
  return {native(value){nativeConnected=Boolean(value);if(value){native=value;if(value.can_stop)ui.mode.value=value.context==='robot'?'robot':'packing';}render();},robot(value){robot=value;if(value?.listening)ui.mode.value='robot';render();},playback(value){const labels={planning:'승인한 가상 경로를 준비하고 있습니다.',running:'승인한 경로를 3D 시뮬레이션에서 재생 중입니다.',paused:'가상 재생이 일시정지되었습니다.',awaiting_grip:'3D 보기의 가상 파지 확인 버튼을 눌러 진행하세요.',awaiting_open:'3D 보기의 가상 박스에서 열기 버튼을 눌러 진행하세요.',complete:'승인한 경로의 가상 재생을 완료했습니다.',idle:'가상 재생을 종료했습니다.'};notice(labels[value.state]||value.message||'가상 재생 상태를 확인하세요.',value.state==='error');},refresh:render};
}
