const get = id => document.getElementById(id);
const samples = get("hand-samples");
let contact=null,contactPending=false;
async function loadContact(){try{contact=await api('contact');get('hand-contact-current').value=contact.threshold_ma??'';get('hand-contact-result').textContent=contact.threshold_ma==null?'접촉 전류 미설정 · 17단계 실제 이송이 차단됩니다.':'저장된 임계값 · '+contact.threshold_ma+' mA';}catch(error){get('hand-contact-result').textContent=error.message;}}
get('hand-contact-reload').onclick=()=>void loadContact();
get('hand-contact-save').onclick=async()=>{if(contactPending||!contact||locked)return;const value=get('hand-contact-current').valueAsNumber;if(!Number.isInteger(value)||value<1||value>1984){get('hand-contact-result').textContent='1~1984 mA의 정수 임계값을 입력하세요.';return;}contactPending=true;controls();try{contact=await api('contact','PUT',{revision:contact.revision,threshold_ma:value});get('hand-contact-result').textContent='접촉 설정 저장 완료.';}catch(error){get('hand-contact-result').textContent=error.message;}finally{contactPending=false;controls();}};
void loadContact();
let table = null, dirty = false, saving = false, busy = false, host = null, locked = false, sdkMode = false;
let loading = 0;
async function api(path, method = "GET", body) {
  const res = await fetch("/api/robot/gripper/"+path, {method,cache:"no-store",
    headers:body ? {"Content-Type":"application/json"} : {}, body:body && JSON.stringify(body)});
  const value = await res.json();
  if (!res.ok) throw Error(typeof value.detail === "string" ? value.detail : "입력값과 로봇 상태를 확인하세요.");
  return value;
}
const rows = () => [...samples.children].map(row => ({
  position:row.querySelector('[data-field="position"]').valueAsNumber,
  width_mm:row.querySelector('[data-field="width_mm"]').valueAsNumber
}));
function valid(points) {
  const sorted = [...points].sort((a,b)=>a.position-b.position);
  return sorted.length >= 2 && sorted.every((p,i) => Number.isInteger(p.position) && p.position>=0 && p.position<=700 &&
    Number.isFinite(p.width_mm) && p.width_mm>=0 && (!i || (sorted[i-1].position<p.position && sorted[i-1].width_mm>p.width_mm)));
}
function controls() {
  get('hand-contact-save').disabled=contactPending||locked||!contact;
  get('hand-contact-current').disabled=contactPending||locked;
  const ready = host?.gripper_supported && host.can_move && !locked && !busy;
  for (const button of document.querySelectorAll("[data-hand]")) button.disabled = !ready;
  get("hand-ready").textContent = !sdkMode ? "RH-P12 제어에는 Mac SDK가 필요합니다." :
    locked ? "로봇 작업 진행 중" : !host?.gripper_supported ? host?.detail || "RH-P12 지원 SDK 작업자 연결 대기" :
    host.motion_reason || (!host.gripper_feedback ? "SDK 준비 · 상태 읽기로 장치 연결을 확인하세요." :
      host.gripper_feedback.state === "completed" ? "RH-P12 최근 응답 확인 · 자동 운전" : "RH-P12 응답 또는 장치 상태를 확인하세요.");
  get("hand-save").disabled = saving || locked || !dirty || !table || !valid(rows());
  get("hand-add").disabled = saving || !table;
  get("hand-capture").disabled = saving || !host?.gripper_supported || host.gripper_feedback?.state !== "completed" ||
    !Number.isInteger(host.gripper_feedback.position) || !table;
  get("hand-reload").disabled = saving;
}
function row(position="", width="") {
  const item = document.createElement("div"); item.className="hand-sample";
  for (const [key,name,val] of [["position","실제 위치",position],["width_mm","안쪽 간격 (mm)",width]]) {
    const label=document.createElement("label"), input=document.createElement("input");
    input.type="number"; input.min=0; input.step=key==="position"?"1":"any";
    if(key==="position") input.max=700;
    input.dataset.field=key; input.value=val; label.append(name+" ",input);item.append(label);
  }
  const remove=document.createElement("button"); remove.type="button";remove.textContent="삭제";
  remove.onclick=()=>{item.remove();dirty=true;controls();};
  item.append(remove);samples.append(item);
}
function fill(data) {
  table=data;dirty=false;samples.replaceChildren();
  for(const p of data.points) row(p.position,p.width_mm);
  controls();
}
export async function loadHandTable(force=false) {
  if (dirty && !force) return;
  const version=++loading;
  try {
    const result=await api("table");
    if(version!==loading || (dirty && !force)) return;
    fill(result);
    get("hand-table-note").textContent = result.points.length ? "저장된 교시점 "+result.points.length+"개" : "등록된 교시점이 없습니다.";
  } catch(error) { get("hand-table-note").textContent=error.message; controls(); }
}
export function renderHand(status, access) {
  host=access; sdkMode=status?.config.access_backend==="mac-sdk";
  locked=Boolean(status?.pick_active || status?.pose_tests?.busy || status?.hand_busy);
  const f=host?.gripper_feedback;
  get("hand-target").textContent=host?.gripper_target ?? "—";
  get("hand-actual").textContent=Number.isInteger(f?.position) ? f.position+" · "+new Date(f.observed_at).toLocaleTimeString("ko-KR") : "—";
  get("hand-current").textContent=f?.position != null ? [f.current_ma,f.goal_current_ma,f.limit_ma].join(" / ")+" mA" : "—";
  get("hand-mode").textContent=f?.position != null ? f.mode+" · 오류 "+f.error : "—";
  controls();
}
samples.addEventListener("input",()=>{dirty=true; controls();});
get("hand-add").onclick=()=>{row();dirty=true;controls();};
get("hand-capture").onclick=()=>{row(host.gripper_feedback.position);dirty=true;controls();};
get("hand-reload").onclick=()=>void loadHandTable(true);
get("hand-save").onclick=async()=>{
  const points=rows();
  if(!valid(points) || saving || !table) return;
  saving=true; samples.inert=true; controls();
  try { fill(await api("table","PUT",{revision:table.revision,points})); get("hand-table-note").textContent="벌림표를 저장했습니다."; }
  catch(error) { get("hand-table-note").textContent=error.message; }
  finally { saving=false; samples.inert=false; controls(); }
};
for(const button of document.querySelectorAll("[data-hand]")) button.onclick=async()=>{
  if(button.disabled || busy) return;
  const action=button.dataset.hand;
  const body={session_id:host.session_id,motion_token:host.motion_token,action};
  if(action==="position") {
    body.position=get("hand-position").valueAsNumber;
    if(!Number.isInteger(body.position) || body.position<0 || body.position>700) {
      get("hand-result").textContent="0~700의 정수 위치를 입력하세요.";return;
    }
  }
  busy=true;controls();get("hand-result").textContent="장치 응답 대기 중";
  try {
    const result=await api("command","POST",body);
    get("hand-result").textContent=(result.state==="unknown"?"결과 미확인 · ":"")+result.message;
  } catch(error) { get("hand-result").textContent="명령 상태 확인 필요 · "+error.message; }
  finally { busy=false;host=null;controls(); }
};
