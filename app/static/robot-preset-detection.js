import {api} from './robot-camera-frame.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const vector=values=>values?.map(v=>Number(v.toFixed(2))).join(', ')||'—';

export function connectPresetDetection(root,{getDraft,onChange,onResolved,onPrepare,signal}){
  let catalog=null,catalogError='',catalogLoading=false,snapshot=null,selected=null,deadline=0,generation=0,timer,message='',busy=false,locked=false,dirty=false;
  const selectedObject=()=>snapshot?.candidates.find(c=>c.id===selected);
  function controls(state={}){
    if('busy' in state)busy=state.busy;
    if('locked' in state)locked=state.locked;
    if('dirty' in state)dirty=state.dirty;
    for(const el of root.querySelectorAll('input:not([readonly]),select,button'))el.disabled=busy||locked;
    for(const el of root.querySelectorAll('[data-invalid]'))el.disabled=true;
    const prepare=root.querySelector('[data-detection-action=prepare]');if(prepare)prepare.disabled=busy||locked||dirty;
    const refresh=root.querySelector('[data-detection-action=catalog]');if(refresh)refresh.disabled=busy||locked||catalogLoading;
  }
  function payload(){return snapshot&&selected&&deadline>Date.now()?{snapshot_id:snapshot.snapshot_id,candidate_id:selected}:{};}
  function reset(text=''){
    generation++;clearTimeout(timer);snapshot=null;selected=null;deadline=0;message=text;render();
  }
  async function loadCatalog(){
    if(catalogLoading)return;catalogLoading=true;catalogError='';render();
    try{catalog=await api('presets/sources/yolo','GET',undefined,signal);}
    catch(error){if(error.name!=='AbortError')catalogError=error.message;}
    finally{catalogLoading=false;if(!signal.aborted)render();}
  }
  function render(){
    const p=getDraft();if(!p)return;
    const yolo=p.object_source==='yolo',criteria=p.yolo||{},sameModel=catalog?.model_version===criteria.model_version;
    const classOptions=(catalog?.classes||[]).map(c=>`<option value="${c.id}" ${sameModel&&criteria.class_id===c.id?'selected':''}>${esc(c.name)}</option>`).join('');
    const object=selectedObject();
    root.innerHTML=`<div class="preset-edit-head"><h4>객체 정보 출처</h4><span class="scenario-badge">${yolo?'실행마다 최신 탐지':'프리셋 저장값 사용'}</span></div>
      <div class="preset-source-options" role="radiogroup" aria-label="객체 정보 출처">
        ${[['saved','저장한 객체 좌표'],['yolo','YOLOv8 탐지값']].map(([v,t])=>`<label><input type="radio" name="preset-object-source" data-detection-field="object_source" value="${v}" ${p.object_source===v?'checked':''}>${t}</label>`).join('')}
      </div>
      <div class="preset-fields"><label>작업 영역<select data-detection-field="region"><option value="floor" ${p.region==='floor'?'selected':''}>바닥 · 수직 파지</option><option value="shelf" ${p.region==='shelf'?'selected':''}>선반 · 수평 파지</option></select></label>
      ${yolo?`<label>대상 클래스<select data-detection-field="class_id"><option value="" ${!sameModel||criteria.class_id===null?'selected':''}>${catalogLoading?'클래스 조회 중…':'클래스를 선택하세요'}</option>${classOptions}</select></label>
        <label>최소 신뢰도<select data-detection-field="min_confidence">${[...new Set([.7,.8,.9,1,criteria.min_confidence??.8])].sort().map(n=>`<option value="${n}" ${criteria.min_confidence===n?'selected':''}>${Math.round(n*100)}%</option>`).join('')}</select></label>
        <label>대상 선택<select data-detection-field="selection"><option value="unique" ${criteria.selection==='unique'?'selected':''}>후보 1개일 때만 자동 확정</option><option value="manual" ${criteria.selection==='manual'?'selected':''}>항상 화면에서 선택</option></select></label>
        <label>카메라<input readonly value="${esc(catalog?.camera?.id||'현재 활성 카메라')}" aria-label="탐지 카메라"></label><label>인식 자세<input readonly value="${esc(vector(p.context.standby_joints))}°" aria-label="저장된 대기 관절각"></label>`:''}</div>
      ${yolo?`<div class="pose-actions"><button type="button" data-detection-action="catalog">클래스 새로고침</button><button type="button" data-detection-action="prepare">인식 자세 준비</button><button type="button" data-detection-action="capture">YOLO 대상 확인</button></div>
        <p class="scenario-caption">${catalog?esc(catalog.model_name)+(catalog.ready?' · 탐지 중':' · 카메라 탐지를 켠 뒤 대상을 확인하세요.'):esc(catalogError||'클래스 목록을 불러오세요.')}</p>
        ${criteria.class_id!==null&&!sameModel?`<p class="preset-detection-warning">저장 클래스: ${esc(criteria.class_label||criteria.class_id)} · 현재 모델의 클래스를 확인하고 저장하세요.</p>`:''}
        <p class="scenario-caption">위치·권장 벌림은 탐지 상자와 작업면 보정으로 계산합니다. 물체 두께·깊이는 아래 저장값을 사용합니다. 실제 실행의 인식 자세 이동은 별도 승인이 필요합니다.</p>
        <div class="preset-detection-candidates">${(snapshot?.candidates||[]).map((c,i)=>`<button type="button" data-detection-candidate="${c.id}" ${c.reason?'data-invalid':''} aria-pressed="${selected===c.id}"><strong>${esc(c.label)} · 후보 ${i+1} · ${Math.round(c.confidence*100)}%</strong><span>파지 TCP: ${esc(vector(c.pose))}</span>${c.reason?`<span>${esc(c.reason)}</span>`:''}</button>`).join('')}</div>
        ${object?`<dl class="preset-detection-readings"><div><dt>파지 TCP · BASE mm/°</dt><dd>${esc(vector(object.pose))}</dd></div><div><dt>평면상 크기 추정 · mm</dt><dd>${esc(object.planar_size_mm?.map(v=>v.toFixed(2)).join(' × ')||'—')}</dd></div><div><dt>권장 벌림 · mm</dt><dd>${esc(object.opening_mm?.toFixed(2))}</dd></div></dl>`:''}
        ${snapshot?`<p class="scenario-caption">프레임 ${snapshot.frame_id} · ${p.region==='floor'?'바닥':'선반'} 보정 적용 · 대상 확인 후 30초 이내 경로 승인</p>`:''}
        <p class="preset-detection-status" role="status" aria-live="polite">${esc(message||'인식 자세 확인 → 최신 탐지 → 대상·경로 확정 → 30초 승인')}</p>`:
        '<p class="scenario-caption">저장한 객체 위치·크기로 자동 파지 묶음을 계산합니다.</p>'}`;
    controls();
  }
  async function capture(hardware=false){
    const p=getDraft(),version=++generation;clearTimeout(timer);snapshot=null;selected=null;message='최신 YOLO 대상을 확인하고 있습니다.';render();
    try{
      const response=await api(`presets/${p.id}/detections`,'POST',hardware?{revision:p.revision,hardware:true}:{preset:p,revision:p.revision},signal);
      if(version!==generation||signal.aborted)return null;
      snapshot=response;selected=response.selected_id;deadline=Date.now()+response.expires_in*1000;message=response.message;
      timer=setTimeout(()=>{reset('대상 확인이 만료되었습니다. YOLO 대상을 다시 확인하세요.');onResolved({expired:true});},Math.max(0,deadline-Date.now()));
      render();return response;
    }catch(error){if(version===generation){message=error.message;render();}throw error;}
  }
  async function ensure(hardware=false){
    if(snapshot&&deadline<=Date.now())reset('대상 확인이 만료되었습니다.');
    if(!Object.keys(payload()).length&&!snapshot)await capture(hardware);
    if(!Object.keys(payload()).length){message=snapshot?.state==='no_match'?'조건에 맞는 대상이 없습니다. 탐지 조건과 작업면을 확인하세요.':'실행할 대상을 선택하고 경로를 확인하세요.';render();root.scrollIntoView({block:'center',behavior:'smooth'});return null;}
    return payload();
  }
  root.addEventListener('change',event=>{
    const el=event.target,key=el.dataset.detectionField,p=getDraft();if(!key||busy||locked)return;
    if(key==='object_source')p.object_source=el.value;
    else if(key==='region')p.region=el.value;
    else if(key==='class_id'){
      const entry=catalog?.classes.find(c=>c.id===Number(el.value));
      if(!el.value||!entry){p.yolo.class_id=null;p.yolo.model_version=null;p.yolo.class_label='';}
      else p.yolo={...p.yolo,class_id:entry.id,model_version:catalog.model_version,class_label:entry.name};
    }else p.yolo[key]=key==='min_confidence'?Number(el.value):el.value;
    reset();onChange();if(p.object_source==='yolo'&&!catalog&&!catalogLoading)void loadCatalog();
  },{signal});
  root.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.dataset.detectionCandidate){selected=button.dataset.detectionCandidate;message='대상을 확정했습니다. 선택한 값으로 경로를 다시 확인하세요.';render();onResolved();return;}
    if(button.dataset.detectionAction==='catalog')void loadCatalog();
    if(button.dataset.detectionAction==='prepare')onPrepare();
    if(button.dataset.detectionAction==='capture')onResolved({capture:true});
  },{signal});
  signal.addEventListener('abort',()=>{generation++;clearTimeout(timer);},{once:true});
  return {render,reset,controls,payload,capture,ensure,loadCatalog,hasSnapshot:()=>Boolean(snapshot),
    activate(){render();if(getDraft()?.object_source==='yolo'&&!catalog&&!catalogLoading)void loadCatalog();}};
}
