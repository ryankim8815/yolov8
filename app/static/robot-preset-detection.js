import {api} from './robot-camera-frame.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function connectPresetDetection(root,{getDraft,onChange,onPrepare,signal}){
  let catalog=null,catalogError='',catalogLoading=false,busy=false,locked=false,dirty=false;
  function controls(state={}){
    if('busy' in state)busy=state.busy;
    if('locked' in state)locked=state.locked;
    if('dirty' in state)dirty=state.dirty;
    for(const el of root.querySelectorAll('input,select,button'))el.disabled=busy||locked;
    for(const el of root.querySelectorAll('[data-detection-action=prepare]'))el.disabled=busy||locked||dirty;
    const refresh=root.querySelector('[data-detection-action=catalog]');if(refresh)refresh.disabled=busy||locked||catalogLoading;
  }
  async function loadCatalog(){
    if(catalogLoading)return;catalogLoading=true;catalogError='';render();
    try{catalog=await api('presets/sources/yolo','GET',undefined,signal);}
    catch(error){if(error.name!=='AbortError')catalogError=error.message;}
    finally{catalogLoading=false;if(!signal.aborted)render();}
  }
  function render(){
    const p=getDraft();if(!p)return;
    const yolo=p.object_source==='yolo',criteria=p.yolo||{};
    root.innerHTML=`<div class="preset-edit-head"><h4>객체 정보 출처</h4><span class="scenario-badge">${yolo?'실행 전 음성 클래스 선택':'프리셋 저장값 사용'}</span></div>
      <div class="preset-source-options" role="radiogroup" aria-label="객체 정보 출처">
        ${[['saved','저장한 객체 좌표'],['yolo','YOLOv8 탐지값']].map(([v,t])=>`<label><input type="radio" name="preset-object-source" data-detection-field="object_source" value="${v}" ${p.object_source===v?'checked':''}>${t}</label>`).join('')}
      </div>
      <div class="preset-fields"><label>작업 영역<select data-detection-field="region"><option value="floor" ${p.region==='floor'?'selected':''}>바닥 · 수직 파지</option><option value="shelf" ${p.region==='shelf'?'selected':''}>선반 · 수평 파지</option></select></label>
      ${yolo?`<label>최소 신뢰도<select data-detection-field="min_confidence">${[...new Set([.7,.8,.9,1,criteria.min_confidence??.8])].sort().map(n=>`<option value="${n}" ${criteria.min_confidence===n?'selected':''}>${Math.round(n*100)}%</option>`).join('')}</select></label>
        <label>대상 선택<select data-detection-field="selection"><option value="unique" ${criteria.selection==='unique'?'selected':''}>후보 1개일 때만 자동 확정</option><option value="manual" ${criteria.selection==='manual'?'selected':''}>항상 화면에서 선택</option></select></label>`:''}</div>
      ${yolo?`<p><strong>대상 클래스는 실행할 때 음성으로 선택합니다.</strong></p>
        <p class="scenario-caption">${catalog?esc(catalog.model_name)+(catalog.ready?' · 탐지 중':' · 카메라 탐지 필요'):esc(catalogError||(catalogLoading?'클래스 조회 중…':'클래스 목록을 불러오세요.'))}</p>
        <div class="preset-class-list" aria-label="현재 모델의 클래스 목록">${(catalog?.classes||[]).map(c=>`<span>${esc(c.name)}</span>`).join('')}</div>
        <p class="scenario-caption">목록의 클래스 한 개만 선택할 수 있으며 이번 실행에만 적용합니다. 위치·벌림은 탐지값과 작업면 보정으로 계산하고, 두께·깊이는 아래 저장값을 사용합니다.</p>
        <div class="pose-actions"><button type="button" data-detection-action="catalog">클래스 새로고침</button><button type="button" data-detection-action="prepare">인식 자세 실제 준비…</button></div>`:
        '<p class="scenario-caption">저장한 객체 위치·크기로 자동 파지 묶음을 계산합니다.</p>'}`;
    controls();
  }
  root.addEventListener('change',event=>{
    const el=event.target,key=el.dataset.detectionField,p=getDraft();if(!key||busy||locked)return;
    if(key==='object_source'||key==='region')p[key]=el.value;
    else p.yolo[key]=key==='min_confidence'?Number(el.value):el.value;
    onChange();if(p.object_source==='yolo'&&!catalog&&!catalogLoading)void loadCatalog();
  },{signal});
  root.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.dataset.detectionAction==='catalog')void loadCatalog();
    if(button.dataset.detectionAction==='prepare')onPrepare();
  },{signal});
  return {render,reset:()=>render(),controls,payload:()=>({}),loadCatalog,
    activate(){render();if(getDraft()?.object_source==='yolo'&&!catalog&&!catalogLoading)void loadCatalog();}};
}
