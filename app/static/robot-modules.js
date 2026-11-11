import {api} from './robot-camera-frame.js';
import {subscribeParcelBox} from './robot-work-points.js';

const listeners=new Set();let latest=null;
export function subscribeModules(fn){listeners.add(fn);fn(latest);return ()=>listeners.delete(fn);}
const names={prepare:'대기 자세',grasp:'파지 단계 · YOLOv8 좌표',place:'박스 위치 기반 단계'};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const percent=n=>Array.from({length:10},(_,i)=>`<option value="${(i+1)*10}" ${(i+1)*10===n?'selected':''}>${(i+1)*10}%</option>`).join('');
const at=(o,key)=>key.split('.').reduce((v,k)=>v?.[k],o);
const put=(o,key,value)=>{const keys=key.split('.');let p=o;for(const key of keys.slice(0,-1))p=p[key];p[keys.at(-1)]=value;};
const field=(key,value,label,extra='')=>`<label>${label}<input type="number" step="any" data-mf="${key}" value="${esc(value)}" ${extra}></label>`;

export function connectModuleManager(root,signal){
  root.innerHTML=`<p class="work-point-help">모듈을 저장하면 이 모듈을 사용하는 프리셋의 경로 계산에 반영됩니다. 기본 모듈 3종은 수정만 가능하며 삭제할 수 없습니다. 추가 시 기본 속도는 새로 경로에 넣는 모듈에 적용합니다.</p>
    <div class="preset-step-add"><label>새 모듈 유형<select data-m="new-kind">${Object.entries(names).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><button type="button" data-ma="new">모듈 추가</button><button type="button" data-ma="reload">최신 목록 불러오기</button></div>
    <p data-m="notice" class="work-point-help"></p><div class="preset-layout module-manager-layout"><aside class="preset-library"><h3>모듈 목록</h3><div data-m="list"></div></aside>
    <form data-m="form" class="preset-detail"><div class="preset-edit-head"><label>모듈 이름<input data-mf="name" maxlength="80" required></label><span data-m="state" class="scenario-badge"></span></div>
    <p data-m="kind" class="scenario-caption"></p><label>설명<textarea data-mf="description" rows="2" maxlength="500"></textarea></label><label>추가 시 기본 속도<select data-mf="default_percent"></select></label>
    <div data-m="fields"></div><div data-m="uses" class="scenario-caption"></div><div class="pose-actions"><button type="submit" data-ma="save">모듈 저장</button><button type="button" data-ma="cancel">변경 취소</button><button type="button" data-ma="copy">복제</button><button type="button" data-ma="delete">모듈 삭제</button></div></form></div><p data-m="message" role="status"></p>`;
  const ui=Object.fromEntries([...root.querySelectorAll('[data-m]')].map(el=>[el.dataset.m,el]));
  let catalog=null,draft=null,base=null,dirty=false,busy=false,conflict=false,selected=null,timer,box=null;
  const on=(el,event,fn)=>el.addEventListener(event,fn,{signal});
  const message=(text,error=false)=>{ui.message.textContent=text;ui.message.dataset.error=error;};
  const button=action=>root.querySelector(`[data-ma="${action}"]`);
  function controls(){
    ui.state.textContent=conflict?'다른 화면에서 변경됨':dirty?'저장 전 변경':draft?.builtin?'기본 모듈 · 저장됨':'저장됨';
    for(const input of root.querySelectorAll('[data-mf],[data-orient-region]'))input.disabled=busy||!draft||input.hasAttribute('data-locked');
    button('save').disabled=busy||!draft||!dirty||conflict;button('cancel').disabled=busy||!dirty;
    button('delete').disabled=busy||!draft||draft.builtin||Boolean(base?.used_by?.length)||dirty;
    button('delete').title=draft?.builtin?'기본 모듈은 삭제할 수 없습니다.':base?.used_by?.length?'프리셋에서 제거한 뒤 삭제하세요.':'';
    button('copy').disabled=busy||!draft||dirty;button('new').disabled=busy||!catalog;button('reload').disabled=busy;
    if(base)ui.uses.innerHTML=base.used_by.length?'사용 중: '+base.used_by.map(p=>`<a href="/robot?preset=${p.id}#work-points-title">${esc(p.name)}</a> (${p.instances}개)`).join(', ')+' · 삭제하려면 프리셋에서 먼저 제거하세요.':'사용 중인 프리셋이 없습니다.';
    for(const node of root.querySelectorAll('[data-module-select]'))node.disabled=busy;
  }
  function fields(){
    if(!draft){ui.fields.innerHTML='';return;}
    const s=draft.settings;
    if(draft.kind==='prepare')ui.fields.innerHTML=`<div class="preset-fields">${s.joints.map((v,i)=>field('settings.joints.'+i,v,'J'+(i+1)+' (°)',`required min="-${[360,360,155,360,155,360][i]}" max="${[360,360,155,360,155,360][i]}"`)).join('')}</div>${field('settings.opening_mm',s.opening_mm,'대기 벌림 (mm)','min="0.001" max="1000"')}<p class="scenario-caption">벌림을 비우면 장비 공통 실측 벌림표의 최대 벌림을 사용합니다. 이 모듈의 모든 준비·복귀 동작에 반영됩니다.</p>`;
    else if(draft.kind==='grasp')ui.fields.innerHTML=`${['floor','shelf'].map(region=>{const abc=s.grasp_abc[region];return `<fieldset class="parcel-box-fields"><legend>${region==='floor'?'바닥 · 수직 파지':'선반 · 수평 파지'}</legend>${field('settings.approaches.'+region+'.distance_mm',s.approaches[region].distance_mm,'접근·후퇴 간격 (mm)','required min="0.001" max="1000"')}${region==='shelf'?`<label class="preset-check"><input type="checkbox" data-mf="settings.approaches.shelf.reverse" ${s.approaches.shelf.reverse?'checked':''}>접근 방향 반전</label>`:''}<label class="preset-check"><input type="checkbox" data-orient-region="${region}" ${abc?'checked':''}>공구 방향 직접 설정</label><div class="preset-fields">${['A','B','C'].map((axis,i)=>field('settings.grasp_abc.'+region+'.'+i,abc?.[i],axis+' (°)',abc?'required min="-1000000" max="1000000"':'data-locked disabled')).join('')}</div><p class="scenario-caption">직접 설정을 끄면 기존 작업면 보정·기본 파지 방향을 사용합니다. 대상 클래스와 위치는 실행할 때 YOLOv8에서 확인합니다.</p></fieldset>`;}).join('')}`;
    else ui.fields.innerHTML=`<p class="work-point-help">박스 크기·위치·놓기 TCP·상승 간격은 모든 프리셋이 <a href="#parcel-box-title">택배 박스 설정</a>을 함께 사용합니다. 모듈은 박스 위 이동 → 하강 → 벌림 복원 → 상승의 고정 순서로 실행합니다.</p><p data-module-box-summary class="scenario-caption"></p>`;
    boxSummary();controls();
  }
  function boxSummary(){const el=ui.fields.querySelector('[data-module-box-summary]');if(el)el.textContent=box?(box.draft?'저장 전 · ':'저장됨 · ')+'박스 중심 ['+box.center_base_mm.join(', ')+'] mm · 놓기 TCP '+(box.tcp_pose?'['+box.tcp_pose.join(', ')+']':'미설정')+' · 상승 '+box.clearance_mm+' mm':'공통 박스 설정을 불러오는 중입니다.';}
  function renderList(){ui.list.innerHTML=(catalog?.modules||[]).map(m=>`<button type="button" class="preset-list-item" data-module-select="${m.id}" aria-pressed="${m.id===selected}"><strong>${esc(m.name)}</strong><small>${m.builtin?'기본 · 수정만 가능':'사용자 모듈'} · ${m.used_by.reduce((n,p)=>n+p.instances,0)}곳 사용</small></button>`).join('');}
  function choose(identifier){base=structuredClone(catalog.modules.find(m=>m.id===identifier)||catalog.modules[0]);selected=base.id;draft=structuredClone(base);dirty=conflict=false;
    root.querySelector('[data-mf=name]').value=draft.name;root.querySelector('[data-mf=description]').value=draft.description;root.querySelector('[data-mf=default_percent]').innerHTML=percent(draft.default_percent);
    ui.kind.textContent='모듈 유형 · '+names[draft.kind];ui.uses.innerHTML=base.used_by.length?'사용 중: '+base.used_by.map(p=>`<a href="/robot?preset=${p.id}#work-points-title">${esc(p.name)}</a> (${p.instances}개)`).join(', ')+' · 삭제하려면 프리셋에서 이 모듈을 먼저 제거하세요.':'사용 중인 프리셋이 없습니다.';
    fields();renderList();controls();
  }
  async function load(force=false){
    clearTimeout(timer);try{const next=await api('modules','GET',undefined,signal);if(signal.aborted)return;
      const oldRevision=catalog?.modules.find(m=>m.id===selected)?.revision;catalog=next;ui.notice.textContent=next.migration_notice||'';
      if(!latest||JSON.stringify(latest)!==JSON.stringify(next)){latest=next;for(const fn of listeners)fn(next);}
      const current=next.modules.find(m=>m.id===selected);
      if(force||!draft||!current)choose(selected);else if(current.revision!==oldRevision){if(dirty){conflict=true;renderList();controls();}else choose(selected);}else{base.used_by=current.used_by;renderList();controls();}
    }catch(error){if(!signal.aborted)message(error.message,true);}finally{if(!signal.aborted)timer=setTimeout(()=>{if(!document.hidden&&!busy)void load();else timer=setTimeout(()=>void load(),4000);},4000);}
  }
  on(root,'input',event=>{const el=event.target;if(!draft||busy||!el.dataset.mf)return;const key=el.dataset.mf,value=el.type==='checkbox'?el.checked:el.type==='number'?(Number.isFinite(el.valueAsNumber)?el.valueAsNumber:null):key==='default_percent'?Number(el.value):el.value;put(draft,key,value);dirty=true;message('');controls();});
  on(root,'change',event=>{const region=event.target.dataset.orientRegion;if(!region||busy)return;draft.settings.grasp_abc[region]=event.target.checked?(region==='floor'?[0,180,0]:[180,90,90]):null;dirty=true;fields();controls();});
  const body=module=>Object.fromEntries(['name','kind','description','default_percent','settings','revision'].map(key=>[key,module[key]]));
  on(ui.form,'submit',async event=>{event.preventDefault();if(button('save').disabled||!ui.form.reportValidity())return;busy=true;controls();try{await api('modules/'+draft.id,'PUT',body(draft),signal);dirty=false;await load(true);message('모듈을 저장했습니다. 연결된 프리셋의 경로 계산에 반영됩니다.');}catch(error){if(error.status===412)conflict=true;message(error.message,true);}finally{busy=false;controls();}});
  on(root,'click',async event=>{const item=event.target.closest('[data-module-select]');if(item&&!busy){choose(item.dataset.moduleSelect);message('');return;}const action=event.target.closest('[data-ma]');if(!action||action.disabled||action.dataset.ma==='save')return;
    if(action.dataset.ma==='cancel'){choose(selected);message('변경을 취소했습니다.');return;}if(action.dataset.ma==='reload'){dirty=false;await load(true);message('최신 모듈을 불러왔습니다.');return;}
    busy=true;controls();try{
      if(action.dataset.ma==='delete'){await api('modules/'+draft.id,'DELETE',{revision:draft.revision},signal);selected=null;draft=null;dirty=false;await load(true);message('사용자 모듈을 삭제했습니다.');}
      else{const kind=action.dataset.ma==='copy'?draft.kind:ui['new-kind'].value,source=action.dataset.ma==='copy'?draft:catalog.modules.find(m=>m.builtin&&m.kind===kind),created=await api('modules','POST',{...body(source),revision:null,name:(action.dataset.ma==='copy'?source.name+' 복사본':'새 '+names[kind]).slice(0,80)},signal);selected=created.id;dirty=false;await load(true);message('사용자 모듈을 추가했습니다. 내용을 수정하고 저장하세요.');}
    }catch(error){message(error.message,true);}finally{busy=false;controls();}
  });
  const unsubscribe=subscribeParcelBox(value=>{box=value;boxSummary();});
  signal.addEventListener('abort',()=>{clearTimeout(timer);unsubscribe();},{once:true});
  controls();void load();
}
