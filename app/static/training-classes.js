"use strict";

function createTrainingClasses({api,node,getContext,onChange}) {
  const el=id=>document.getElementById(id);
  let contextKey="",generation=0,options=null,retained=new Map(),enabled=new Set(),added=new Set(),plan=null,busy=false;
  const context=()=>getContext();
  const selection=()=>({retained:[...enabled].map(id=>({source_class_id:id,class_uuid:retained.get(id)||""})),new_class_uuids:[...added]});
  function invalidate(text="설정이 변경되었습니다. 최종 클래스·자료를 다시 확인하세요.") {
    generation++;plan=null;el('class-plan-confirm').checked=false;el('class-plan-confirm').disabled=true;
    el('class-plan-rows').replaceChildren();el('class-plan-status').textContent=text;onChange();
  }
  function controls() {
    el('class-preview').disabled=busy||!options;
    el('class-select-all').disabled=el('class-select-none').disabled=busy||!options;
    el('class-options-reload').disabled=busy;
  }
  function table(headers) {
    const t=node('table'),head=node('thead'),tr=node('tr'),body=node('tbody');
    headers.forEach(text=>{const th=node('th',text);th.scope='col';tr.append(th);});head.append(tr);t.append(head,body);return [t,body];
  }
  function render() {
    if(!options)return;
    const focus=document.activeElement?.dataset?.classFocus;
    const [t,body]=table(['사용','기반 클래스','사진 라벨 연결','재사용 자료']);const focusables=[];
    options.base_classes.forEach(source=>{
      const row=node('tr'),cell=node('td'),check=node('input');check.type='checkbox';check.checked=enabled.has(source.id);check.disabled=busy;
      check.setAttribute('aria-label',source.name+' 클래스 유지');check.dataset.classFocus='use-'+source.id;focusables.push(check);
      check.addEventListener('change',()=>{if(check.checked){enabled.add(source.id);added.delete(retained.get(source.id));}else enabled.delete(source.id);invalidate();render();});
      cell.append(check);const name=node('th',`#${source.id} · ${source.name}`);name.scope='row';
      const data=node('td'),select=node('select');select.setAttribute('aria-label',source.name+' 사진 라벨 연결');select.dataset.classFocus='label-'+source.id;focusables.push(select);
      select.append(new Option('라벨 선택 · 직접 연결',''));options.data_classes.forEach(cls=>select.append(new Option(cls.name,cls.uuid)));
      select.value=retained.get(source.id)||'';select.disabled=busy;
      select.addEventListener('change',()=>{retained.set(source.id,select.value);if(enabled.has(source.id))added.delete(select.value);invalidate();render();});data.append(select);
      const match=options.data_classes.find(c=>c.uuid===select.value);
      row.append(cell,name,data,node('td',match?`${match.available}장 · 독립 그룹 ${match.groups}개`:'자료 연결 필요'));
      row.dataset.search=(source.name+' '+(match?.name||'')).toLowerCase();body.append(row);
    });
    el('class-base-rows').replaceChildren(t);
    const linked=new Set([...enabled].map(id=>retained.get(id)));const chips=[];
    options.data_classes.forEach(cls=>{
      const label=node('label',undefined,'class-add'),check=node('input');check.type='checkbox';check.checked=added.has(cls.uuid);check.disabled=busy||linked.has(cls.uuid);check.dataset.classFocus='new-'+cls.uuid;focusables.push(check);
      check.setAttribute('aria-label',cls.name+' 새 클래스 추가');
      check.addEventListener('change',()=>{if(check.checked)added.add(cls.uuid);else added.delete(cls.uuid);invalidate();});
      label.append(check,node('span',cls.name+(linked.has(cls.uuid)?' · 기반 클래스에 연결됨':` · ${cls.available}장`)));chips.push(label);
    });
    el('class-new-rows').replaceChildren(...chips);
    if(!chips.length)el('class-new-rows').textContent='선택한 자료에 사진 라벨이 없습니다.';
    const query=el('class-source-search').value.trim().toLowerCase();[...body.children].forEach(row=>row.hidden=!row.dataset.search.includes(query));
    focusables.find(input=>input.dataset.classFocus===focus)?.focus?.({preventScroll:true});controls();
  }
  async function sync(force=false) {
    const current=context(),key=JSON.stringify([current.dataset_id,current.initial_model_id,current.model_key]);
    if(!force&&key===contextKey)return;
    contextKey=key;invalidate('학습 자료와 기반 클래스를 확인하고 있습니다.');const revision=generation;
    options=null;busy=true;el('class-base-rows').replaceChildren();el('class-new-rows').replaceChildren();controls();
    if(!current.dataset_id){busy=false;el('class-plan-status').textContent='학습에 사용할 데이터셋을 먼저 선택하세요.';controls();return;}
    try {
      const data=await api('/api/training/class-options?'+new URLSearchParams({dataset_id:current.dataset_id,initial_model_id:current.initial_model_id}));
      if(revision!==generation)return;
      options=data;retained=new Map(data.base_classes.map(c=>[c.id,c.suggested_uuid||'']));
      enabled=new Set(data.base_classes.filter(c=>data.initial_model_id!=='coco-yolov8n'||c.suggested_uuid).map(c=>c.id));
      const matched=new Set(data.base_classes.map(c=>c.suggested_uuid));added=new Set(data.data_classes.filter(c=>!matched.has(c.uuid)).map(c=>c.uuid));
      el('class-source-info').textContent=data.source_datasets.map(d=>(d.reused?'기반 모델 자료 재사용':'선택한 자료')+' · '+(d.counts.train+d.counts.val)+'장').join(' / ')+' · 중복 사진은 한 번만 사용합니다.';
      el('class-plan-status').textContent='유지할 기반 클래스와 추가할 사진 라벨을 선택한 뒤 최종 구성을 확인하세요.';
    } catch(error){if(revision===generation)el('class-plan-status').textContent=error.message;}
    finally{if(revision===generation){busy=false;render();controls();onChange();}}
  }
  async function preview() {
    if(busy||!options)return;
    if([...enabled].some(id=>!retained.get(id))){el('class-plan-status').textContent='선택한 기반 클래스마다 사진 라벨을 연결하세요.';return;}
    invalidate('클래스별 자료를 합쳐 학습·검증 구성을 계산하고 있습니다.');const revision=generation;busy=true;render();
    try {
      const data=await api('/api/training/class-preview','POST',{...context().values,class_selection:selection()});
      if(revision!==generation)return;
      plan=data;
      const [t,body]=table(['최종 ID','인식 클래스','연결한 기반 클래스','학습','검증','사용 가능 자료']);
      data.classes.forEach(cls=>{const tr=node('tr');tr.append(node('td','#'+cls.id),node('th',cls.name),node('td',cls.source_name??'새 클래스'),node('td',cls.train+'장'),node('td',cls.val+'장'),node('td',cls.available+'장 · 독립 '+cls.groups+'개'));body.append(tr);});
      el('class-plan-rows').replaceChildren(t);
      el('class-plan-status').textContent=data.ready?`최종 ${data.classes.length}개 클래스 · 학습 ${data.counts.train}장 / 검증 ${data.counts.val}장. 아래 확인란을 선택하면 새 버전 학습을 시작할 수 있습니다.`:data.errors.join(' ');
      el('class-plan-confirm').disabled=!data.ready;
    } catch(error){if(revision===generation)el('class-plan-status').textContent=error.message;}
    finally{if(revision===generation){busy=false;render();onChange();}}
  }
  el('class-source-search').addEventListener('input',()=>{if(options)render();});
  el('class-select-all').addEventListener('click',()=>{if(!options)return;enabled=new Set(options.base_classes.map(c=>c.id));enabled.forEach(id=>added.delete(retained.get(id)));invalidate();render();});
  el('class-select-none').addEventListener('click',()=>{enabled.clear();invalidate();render();});
  el('class-options-reload').addEventListener('click',()=>sync(true));
  el('class-preview').addEventListener('click',preview);
  el('class-plan-confirm').addEventListener('change',onChange);
  controls();
  return {sync,get ready(){return Boolean(plan?.ready&&el('class-plan-confirm').checked&&!busy);},values(){if(!this.ready)throw Error('최종 클래스와 자료 구성을 먼저 확인하세요.');return {...context().values,class_selection:selection(),class_plan_signature:plan.signature};}};
}
