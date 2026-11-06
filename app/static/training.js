"use strict";
(() => {
  const el=id=>document.getElementById(id);
  let tab="live", ownedCollection=null, ownedObserved=false, records={models:[],jobs:[],datasets:[]}, backend="mps", samples=[], eventSocket;
  let refreshPending=false, dataKey="", pendingCollectionStart=null;
  const reasons={saving:"사진 저장 중",interval:"저장 간격 대기",stabilizing:"대상 확인 중 (3프레임)",no_detection:"탐지된 물체 없음",outside_center:"물체를 중앙에 놓아주세요",ambiguous:"중앙에 물체 하나만 놓아주세요",low_confidence:"낮은 confidence",invalid_box:"잘못된 좌표",stale:"오래된 결과 · 저장 대기",queue_full:"저장 큐 포화 · 요청 생략",heartbeat_expired:"연결 유지 신호 만료 · 저장 중지",disk_error:"디스크 오류 · 저장 중지",user_stopped:"사진 저장 중지",camera_off:"카메라 꺼짐",stopped:"사진 저장 중지",server_shutdown:"서버 종료"};
  const stages={queued:"대기",preparing:"준비",training:"학습",evaluating:"평가",exporting:"Core ML 변환·비교",completed:"완료",completed_with_warnings:"PT 완료 · Core ML 확인 필요",failed:"실패",cancelled:"취소됨",cancelling:"취소 중",interrupted:"서버 재시작으로 중단"};
  const terminal=new Set(["completed","completed_with_warnings","failed","cancelled","interrupted"]);
  function message(text,error=false){el("action-message").hidden=false;el("action-message").textContent=text;el("action-message").classList.toggle("failure",error);}
  async function api(path,method="GET",body){const response=await fetch(path,{method,headers:body?{"Content-Type":"application/json"}:{},body:body?JSON.stringify(body):undefined});const value=await response.json();if(!response.ok)throw Error(typeof value.detail==="string"?value.detail:JSON.stringify(value.detail||value));return value;}
  function action(id,handler){el(id).addEventListener("click",async()=>{el(id).disabled=true;el(id).dataset.pending="1";try{await handler();}catch(error){message(error.message,true);}finally{delete el(id).dataset.pending;el(id).disabled=id==="collect-start"&&Boolean(ownedCollection||currentStatus?.collection?.id);if(id==="train-start")updateDatasetState();}});}
  function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
  function options(id,values,label,empty){const select=el(id),old=select.value;select.replaceChildren();if(empty)select.append(new Option(empty,""));for(const v of values){const option=new Option(label(v),v.id);option.disabled=Boolean(v.disabled);select.append(option);}if([...select.options].some(o=>o.value===old&&!o.disabled))select.value=old;}
  function modelOptions(){const available=records.models.map(m=>({...m,disabled:m.formats[backend]?.state!=="ready"}));for(const id of ["live-model","teacher-model"])options(id,available,m=>m.name+(m.disabled?" (형식 없음)":""));options("initial-model",records.models.filter(m=>m.kind==="custom"&&m.formats.mps?.state==="ready"),m=>m.name,"YOLOv8n 사전 학습 가중치");}
  function trainingReady(d){
    return Boolean(d && (d.status ?? "ready")==="ready" && d.counts.train>0 && d.counts.val>0);
  }
  function updateDatasetState(){
    const selected=records.datasets.find(d=>d.id===el("dataset-select").value);
    el("train-start").disabled=!trainingReady(selected)||el("train-start").dataset.pending==="1";
    el("dataset-note").textContent=!selected?"승인 자료를 데이터셋으로 고정하면 여기에 표시됩니다.":
      trainingReady(selected)?"독립 검증 자료가 있어 학습을 시작할 수 있습니다.":
      "검증 자료 대기 · 사진과 라벨은 저장되었습니다. 같은 클래스를 다른 환경에서 촬영·승인한 뒤 새 데이터셋을 고정하세요.";
  }
  el("dataset-select").addEventListener("change",updateDatasetState);
  function datasetOptions(datasets){
    records.datasets=datasets;
    options("dataset-select",datasets.slice().reverse(),d=>`${d.created_at.slice(0,16)} · ${trainingReady(d)?"학습 가능":"검증 자료 대기"} · train ${d.counts.train} / val ${d.counts.val} · ${d.classes.map(c=>c.name).join(", ")}`);
    updateDatasetState();
  }
  async function refresh(){if(refreshPending)return;refreshPending=true;try{const [classes,groups,collections,datasets,models,jobs]=await Promise.all([api("/api/classes"),api("/api/capture-groups"),api("/api/collections"),api("/api/datasets"),api("/api/models"),api("/api/training/jobs")]);backend=models.backend;records.models=models.models;records.jobs=jobs;options("class-select",classes,c=>c.name);options("group-select",groups,g=>g.name);options("review-session",collections.slice().reverse(),c=>`${c.class_name} · ${c.created_at.slice(0,16)} · ${c.saved||0}장`);datasetOptions(datasets);modelOptions();renderJobs();renderModels();}finally{refreshPending=false;}}
  function cancelCollectionStart(cameraOff=false) {
    const attempt=pendingCollectionStart;
    if(attempt){attempt.cancelled=true;attempt.cameraOff ||= cameraOff;}
    return attempt;
  }
  function showTab(value){tab=value;if(tab!=="collect")cancelCollectionStart();document.querySelectorAll("[data-tab]").forEach(b=>b.classList.toggle("active",b.dataset.tab===tab));el("vision").hidden=!["live","collect"].includes(tab);el("collect-controls").hidden=tab!=="collect";el("review-page").hidden=tab!=="collect";el("jobs-page").hidden=tab!=="jobs";el("models-page").hidden=tab!=="models";el("center-roi").hidden=tab!=="collect";el("candidate-box").hidden=true;if(tab!=="collect"&&ownedCollection){const id=ownedCollection;ownedCollection=null;api(`/api/collections/${id}/stop`,"POST").then(refresh).catch(e=>message(e.message,true));}refresh().catch(e=>message(e.message,true));}
  document.querySelectorAll("[data-tab]").forEach(b=>b.addEventListener("click",()=>showTab(b.dataset.tab)));
  async function activate(id){const operation=await api(`/api/models/${id}/activate`,"POST");message("모델을 적용하고 있습니다. 모든 연결 화면이 갱신됩니다.");for(;;){await new Promise(r=>setTimeout(r,500));const state=await api(`/api/operations/${operation.id}`);if(state.state==="completed"){message("모델 적용 완료");return;}if(state.state!=="running")throw Error(state.error||"모델 적용 중단");}}
  action("activate-model",()=>activate(el("live-model").value));action("camera-on",()=>api("/api/camera/start","POST"));action("camera-off",async()=>{const pending=cancelCollectionStart(true);ownedCollection=null;await api("/api/camera/stop","POST");if(pending){const failure=await pending.done;if(failure)throw failure;}message("사진 저장과 카메라를 껐습니다. 학습 후 자동 재개도 취소됩니다.");});
  action("add-class",async()=>{const c=await api("/api/classes","POST",{name:el("class-name").value});el("class-name").value="";await refresh();el("class-select").value=c.id;});
  action("add-group",async()=>{const g=await api("/api/capture-groups","POST",{name:el("group-name").value});el("group-name").value="";await refresh();el("group-select").value=g.id;});
  action("collect-start",async()=>{
    const values={class_id:el("class-select").value,group_id:el("group-select").value,
      model_id:el("teacher-model").value,interval_ms:Number(el("interval").value),confidence:Number(el("collection-conf").value)};
    if(!values.model_id||!values.class_id||!values.group_id)throw Error("클래스·환경 그룹·수집 모델을 선택하세요");
    let finish;
    const attempt={cancelled:false,cameraOff:false,cameraRequested:false,startRequested:false,id:null,
      done:new Promise(resolve=>{finish=resolve;})};
    pendingCollectionStart=attempt;
    try {
      if(currentStatus?.model_version!==values.model_id)await activate(values.model_id);
      if(attempt.cancelled)return;
      attempt.cameraRequested=true;
      await api("/api/camera/start","POST");
      if(attempt.cancelled)return;
      let ready=false;
      for(let i=0;i<60;i++){
        const status=await api("/api/status");
        if(attempt.cancelled)return;
        if(status.ready){ready=true;break;}
        if(status.state==="error")throw Error(status.last_error||"카메라/모델 오류");
        await new Promise(r=>setTimeout(r,500));
        if(attempt.cancelled)return;
      }
      if(!ready)throw Error("카메라 준비 시간 초과. 상태를 확인하고 다시 시작하세요.");
      const c=await api("/api/collections","POST",values);
      attempt.id=c.id;
      if(attempt.cancelled)return;
      attempt.startRequested=true;
      await api(`/api/collections/${c.id}/start`,"POST");
      if(attempt.cancelled)return;
      ownedCollection=c.id;ownedObserved=false;
      await refresh();el("review-session").value=c.id;
      if(!attempt.cancelled)message("학습 사진을 이 Mac에 저장합니다. 대상이 없으면 저장을 대기합니다.");
    } finally {
      let cleanupError=null;
      try {
        // A stop can overtake an already-sent start request. Stop again after its
        // response, and do not acknowledge completion until this cleanup finishes.
        if(attempt.cancelled){
          if(ownedCollection===attempt.id)ownedCollection=null;
          try {
            if(attempt.startRequested)await api(`/api/collections/${attempt.id}/stop`,"POST");
          } finally {
            if(attempt.cameraOff&&attempt.cameraRequested)await api("/api/camera/stop","POST");
          }
        }
      } catch(error) {
        cleanupError=error;
        throw error;
      } finally {
        if(pendingCollectionStart===attempt)pendingCollectionStart=null;
        finish(cleanupError);
      }
    }
  });
  action("collect-stop",async()=>{
    const pending=cancelCollectionStart();
    const id=currentStatus?.collection?.id||ownedCollection;
    // Stop renewing the lease even if the HTTP stop fails; report that failure
    // while allowing the server's ten-second expiry to stop saving.
    ownedCollection=null;
    if(id)await api(`/api/collections/${id}/stop`,"POST");
    if(pending){const failure=await pending.done;if(failure)throw failure;}
    ownedCollection=null;await refresh();
    message("사진 저장 중지 완료 · 카메라 미리보기는 계속됩니다.");
  });
  setInterval(()=>{if(ownedCollection&&tab==="collect")api(`/api/collections/${ownedCollection}/heartbeat`,"POST").catch(e=>{ownedCollection=null;message(e.message,true);});},3000);
  window.addEventListener("pagehide",()=>{if(ownedCollection)fetch(`/api/collections/${ownedCollection}/stop`,{method:"POST",keepalive:true}).catch(()=>{});});
  window.addEventListener("vision-status",e=>{const c=e.detail.collection;el("active-version").textContent=records.models.find(m=>m.id===e.detail.model_version)?.name||e.detail.model_version||"";if(!c)return;el("collection-state").textContent=c.state==="stopping"?"저장 마무리 중":`${c.id?"수집 활성 · ":""}${reasons[c.reason]||c.reason}`;el("collection-counts").textContent=`저장 ${c.saved}장 · 대기열 ${c.queue_size}/8 · ${c.error?`오류 ${c.error} · `:""}생략 ${Object.entries(c.skipped||{}).map(([k,v])=>`${reasons[k]||k} ${v}`).join(" / ")||"없음"}`;if(ownedCollection&&c.id===ownedCollection)ownedObserved=true;if(ownedCollection&&ownedObserved&&c.id!==ownedCollection)ownedCollection=null;for(const id of ["class-select","class-name","group-select","group-name","teacher-model","interval","collection-conf","collect-start"])el(id).disabled=Boolean(c.id)||Boolean(e.detail.active_job)||el(id).dataset.pending==="1";if(!e.detail.ready)el("candidate-box").hidden=true;});
  async function loadSamples(){if(!el("review-session").value)return;samples=await api(`/api/collections/${el("review-session").value}/samples`);renderSamples();}
  function renderSamples(){el("samples").replaceChildren();el("review-summary").textContent=`${samples.length}장 · 승인 ${samples.filter(s=>s.review==="approved").length} · 제외 ${samples.filter(s=>s.review==="excluded").length}`;for(const s of samples.slice().sort((a,b)=>a.similar_group-b.similar_group)){const card=node("article",undefined,`sample ${s.review}`),figure=node("div",undefined,"sample-figure"),image=node("img"),box=node("div",undefined,"sample-box");figure.style.aspectRatio=`${s.width}/${s.height}`;image.src=s.image_url;image.loading="lazy";image.alt=`자동 라벨 검토 사진 ${s.frame_id}`;const [x1,y1,x2,y2]=s.box;Object.assign(box.style,{left:`${x1/s.width*100}%`,top:`${y1/s.height*100}%`,width:`${(x2-x1)/s.width*100}%`,height:`${(y2-y1)/s.height*100}%`});figure.append(image,box);const caption=node("div",undefined,"caption"),label=node("label"),check=node("input");check.type="checkbox";check.value=s.id;check.className="sample-check";label.append(check,document.createTextNode(`프레임 ${s.frame_id} · ${s.review}`));caption.append(label,node("small",`유사 묶음 ${s.similar_group+1} · ${(s.prediction.confidence*100).toFixed(1)}%`));const actions=node("div",undefined,"actions");for(const [text,value]of [["승인","approved"],["제외","excluded"]]){const button=node("button",text);button.onclick=()=>api(`/api/samples/${s.id}`,"PATCH",{review:value}).then(loadSamples).catch(e=>message(e.message,true));actions.append(button);}card.append(figure,caption,actions);el("samples").append(card);}}
  action("load-samples",loadSamples);action("select-samples",()=>{const checks=[...document.querySelectorAll(".sample-check")],all=checks.every(c=>c.checked);checks.forEach(c=>c.checked=!all);});
  for(const [id,review]of [["approve-samples","approved"],["exclude-samples","excluded"]])action(id,async()=>{const ids=[...document.querySelectorAll(".sample-check:checked")].map(c=>c.value);if(!ids.length)throw Error("검토할 사진을 선택하세요");for(let i=0;i<ids.length;i+=1000)await api("/api/samples/review","POST",{ids:ids.slice(i,i+1000),review});await loadSamples();});
  action("build-dataset",async()=>{const d=await api("/api/datasets","POST");await refresh();el("dataset-select").value=d.id;updateDatasetState();message(trainingReady(d)?`데이터셋 고정 완료 · train ${d.counts.train}, validation ${d.counts.val}장`:`데이터셋 저장 완료 · ${d.counts.train}장 · 검증 자료 대기`);showTab("jobs");});
  action("train-start",async()=>{const j=await api("/api/training/jobs","POST",{dataset_id:el("dataset-select").value,initial_model_id:el("initial-model").value||null,batch:Number(el("train-batch").value),epochs:Number(el("train-epochs").value),patience:Number(el("train-patience").value)});message(`학습 시작: ${j.id}`);await refresh();});
  function renderJobs(){el("jobs-list").replaceChildren();for(const j of records.jobs.slice().reverse()){const card=node("article",undefined,"record");card.append(node("h3",`${stages[j.state]||j.state} · ${j.created_at.slice(0,19)}`),node("p",j.id,"hint"));const p=j.progress;if(p){const bar=node("progress");bar.max=p.epochs||1;bar.value=p.epoch||0;card.append(bar,node("p",`epoch ${p.epoch??"—"}/${p.epochs??j.epochs} · batch ${j.batch}`),node("pre",JSON.stringify({loss:p.losses,metrics:p.metrics},null,2)));}if(j.error||j.warning)card.append(node("p",j.error||j.warning,"error"));const actions=node("div",undefined,"controls"),log=node("button","로그 보기");log.onclick=()=>api(`/api/training/jobs/${j.id}/log`).then(v=>{el("job-log").hidden=false;el("job-log").textContent=Object.entries(v).map(([k,text])=>`${k}\n${text}`).join("\n");}).catch(e=>message(e.message,true));actions.append(log);if(!terminal.has(j.state)){const cancel=node("button","작업 취소","danger");cancel.onclick=()=>api(`/api/training/jobs/${j.id}/cancel`,"POST").then(refresh).catch(e=>message(e.message,true));actions.append(cancel);}card.append(actions);el("jobs-list").append(card);}}
  function renderModels(){el("models-list").replaceChildren();for(const m of records.models.slice().reverse()){const card=node("article",undefined,"record");card.append(node("h3",m.name),node("p",m.classes.length?m.classes.map(c=>c.name).join(", "):"기존 수집·비교 모델"),node("p",m.dataset_id||"기본 모델","hint"));const table=node("table"),head=node("tr");for(const title of ["형식","상태","mAP50–95","p95 (ms)"])head.append(node("th",title));table.append(head);for(const key of ["mps","coreml"]){const f=m.formats[key]||{},row=node("tr");for(const value of [key.toUpperCase(),f.state||"없음",f.metrics?.map50_95?.toFixed(4)??"—",f.latency?.predict_ms?.p95?.toFixed(2)??"—"])row.append(node("td",value));table.append(row);if(f.error)card.append(node("p",f.error,"error"));}card.append(table);if(m.kind==="custom"){const details=node("details"),summary=node("summary","평가·변환·환경 상세");details.append(summary,node("pre",JSON.stringify(m,null,2)));card.append(details);}const use=node("button","실시간 탐지에 적용");use.disabled=m.formats[backend]?.state!=="ready";use.onclick=()=>activate(m.id).then(()=>showTab("live")).catch(e=>message(e.message,true));card.append(use);el("models-list").append(card);}}
  function events(){eventSocket=new WebSocket(`${location.protocol==="https:"?"wss":"ws"}://${location.host}/ws/events`);eventSocket.onmessage=e=>{try{const data=JSON.parse(e.data);records.jobs=data.jobs;records.models=data.models;renderJobs();const next=JSON.stringify(data.models);if(next!==dataKey){dataKey=next;modelOptions();renderModels();}}catch(error){console.error(error);}};eventSocket.onclose=()=>setTimeout(events,2000);eventSocket.onerror=()=>eventSocket.close();}
  refresh().catch(e=>message(e.message,true));events();
})();
