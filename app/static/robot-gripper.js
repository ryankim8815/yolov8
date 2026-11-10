const get = id => document.getElementById(id);
const samples = get("hand-samples");
const initialContactCurrent=30;
let contact=null,contactPending=false;
async function loadContact(){try{contact=await api('contact');get('hand-contact-current').value=contact.threshold_ma??initialContactCurrent;get('hand-contact-result').textContent=contact.threshold_ma==null?'초기 제안값 · '+initialContactCurrent+' mA · 접촉 설정 저장 후 적용됩니다.':'저장된 임계값 · '+contact.threshold_ma+' mA';}catch(error){get('hand-contact-result').textContent=error.message;}finally{controls();}}
get('hand-contact-reload').onclick=()=>void loadContact();
get('hand-contact-save').onclick=async()=>{if(contactPending||!contact||locked)return;const value=get('hand-contact-current').valueAsNumber;if(!Number.isInteger(value)||value<1||value>1984){get('hand-contact-result').textContent='1~1984 mA의 정수 임계값을 입력하세요.';return;}contactPending=true;controls();try{contact=await api('contact','PUT',{revision:contact.revision,threshold_ma:value});get('hand-contact-result').textContent='접촉 설정 저장 완료.';}catch(error){get('hand-contact-result').textContent=error.message;}finally{contactPending=false;controls();}};
void loadContact();
let table = null, dirty = false, saving = false, busy = false, host = null, locked = false, sdkMode = false;
let loading = 0;
let widthPending=false, widthTarget=null, widthVersion=0, widthExpiry=null;
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
function calibrationError(points) {
  if(points.length<2)return "실제 위치와 안쪽 간격을 두 점 이상 입력하세요.";
  if(points.length>701)return "교시점은 최대 701개까지 등록할 수 있습니다.";
  for(const [index,point] of points.entries()){
    if(!Number.isInteger(point.position)||point.position<0||point.position>700)return (index+1)+"번 교시점의 실제 위치를 0~700 정수로 입력하세요.";
    if(!Number.isFinite(point.width_mm)||point.width_mm<0)return (index+1)+"번 교시점의 안쪽 간격을 0 이상 mm로 입력하세요.";
  }
  const sorted = [...points].sort((a,b)=>a.position-b.position);
  for(let i=1;i<sorted.length;i++){
    if(sorted[i-1].position===sorted[i].position)return "실제 위치 "+sorted[i].position+"가 중복됩니다. 서로 다른 위치를 입력하세요.";
    if(sorted[i-1].width_mm<=sorted[i].width_mm)return "실제 위치가 커질수록 안쪽 간격은 작아져야 합니다.";
  }
  return "";
}
const valid=points=>!calibrationError(points);
function controls() {
  get('hand-contact-save').disabled=contactPending||locked||busy||!contact;
  get('hand-contact-current').disabled=contactPending||locked||busy;
  const ready = host?.gripper_supported && host.can_move && !locked && !busy && !widthPending && !saving;
  for (const button of document.querySelectorAll("[data-hand]")) button.disabled = !ready;
  get("hand-ready").textContent = !sdkMode ? "RH-P12 제어에는 Mac SDK가 필요합니다." :
    locked ? "로봇 작업 진행 중" : !host?.gripper_supported ? host?.detail || "RH-P12 지원 SDK 작업자 연결 대기" :
    host.motion_reason || (!host.gripper_feedback ? "SDK 준비 · 상태 읽기로 장치 연결을 확인하세요." :
      host.gripper_feedback.state === "completed" ? "RH-P12 최근 응답 확인 · 자동 운전" : "RH-P12 응답 또는 장치 상태를 확인하세요.");
  samples.inert=saving||busy;
  const reason=busy?"그리퍼 응답을 확인한 뒤 저장하세요.":saving?"벌림표 저장 중입니다.":locked?"로봇 작업이 끝나면 저장할 수 있습니다.":!table?"벌림표를 불러오는 중입니다. 조회 실패 시 저장값 불러오기를 누르세요.":calibrationError(rows())||(!dirty?"저장된 값입니다. 값을 변경하면 저장할 수 있습니다.":"");
  get("hand-save").disabled = Boolean(reason);
  get("hand-save").title=reason||"입력한 실측 벌림표 저장";
  get("hand-table-validation").textContent=reason||"저장할 수 있습니다. 측정값을 확인한 뒤 벌림표 저장을 누르세요.";
  get("hand-add").disabled = saving || busy || !table;
  get("hand-capture").disabled = saving || busy || !host?.gripper_supported || host.gripper_feedback?.state !== "completed" ||
    !Number.isInteger(host.gripper_feedback.position) || !table;
  get("hand-reload").disabled = saving || busy;
  moveControls();
}
function row(position="", width="") {
  const item = document.createElement("div"); item.className="hand-sample";
  for (const [key,name,val] of [["position","실제 위치",position],["width_mm","안쪽 간격 (mm)",width]]) {
    const label=document.createElement("label"), input=document.createElement("input");
    input.type="number"; input.min=0; input.step=key==="position"?"1":"any";
    input.placeholder=key==="position"?"0–700":"실측 mm";
    if(key==="position") input.max=700;
    input.dataset.field=key; input.value=val; label.append(name+" ",input);item.append(label);
  }
  const remove=document.createElement("button"); remove.type="button";remove.textContent="삭제";
  remove.onclick=()=>{item.remove();dirty=true;invalidateMove();controls();};
  item.append(remove);samples.append(item);
}
function fill(data) {
  invalidateMove();
  table=data;dirty=false;samples.replaceChildren();
  for(const p of data.points) row(p.position,p.width_mm);
  if(!data.points.length){row();row();}
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
  get("hand-voltage").textContent=Number.isFinite(f?.input_voltage_v) ? f.input_voltage_v.toFixed(1)+" V" : "—";
  controls();
}
samples.addEventListener("input",()=>{dirty=true;invalidateMove();controls();});
get("hand-add").onclick=()=>{row();dirty=true;invalidateMove();controls();};
get("hand-capture").onclick=()=>{
  const empty=[...samples.children].find(item=>[...item.querySelectorAll('input')].every(input=>input.value===""));
  if(empty)empty.querySelector('[data-field="position"]').value=host.gripper_feedback.position;
  else row(host.gripper_feedback.position);
  dirty=true;invalidateMove();controls();
};
get("hand-reload").onclick=()=>void loadHandTable(true);
get("hand-save").onclick=async()=>{
  const points=rows();
  if(get("hand-save").disabled || !valid(points) || saving || locked || !table) return;
  saving=true; samples.inert=true; controls();
  try { fill(await api("table","PUT",{revision:table.revision,points})); get("hand-table-note").textContent="벌림표를 저장했습니다."; }
  catch(error) { get("hand-table-note").textContent=error.message; }
  finally { saving=false; samples.inert=false; controls(); }
};
const widthMode=()=>get('hand-position-unit').value==='width';
const calibrationVisible=()=>!get('plane-hand-table').hidden&&!get('work-plane').hidden;
function invalidateMove() {
  widthVersion++;widthTarget=null;clearTimeout(widthExpiry);
  if(get('hand-move-dialog').open)get('hand-move-dialog').close();
}
function feedbackWidth(position) {
  for(let i=1;i<(table?.points.length??0);i++){
    const a=table.points[i-1],b=table.points[i];
    if(a.position<=position&&position<=b.position)
      return a.width_mm+(b.width_mm-a.width_mm)*(position-a.position)/(b.position-a.position);
  }
  return null;
}
function moveControls() {
  const calibrated=table&&valid(table.points),isWidth=widthMode(),input=get('hand-position');
  const ready=sdkMode&&host?.gripper_supported&&host.can_move&&!locked&&!busy&&!widthPending&&!saving;
  input.disabled=get('hand-position-unit').disabled=busy||saving;
  input.step=isWidth?'any':'1';input.placeholder=isWidth?'예: 50':'0–700';
  if(!isWidth)input.max=700;
  else if(calibrated)input.max=table.points[0].width_mm;
  else input.removeAttribute('max');
  get('hand-position-label').textContent=isWidth?'목표 벌림 (mm)':'지정 위치';
  get('hand-position-move').textContent=isWidth?'벌림 확인 후 이동':'지정 위치로 이동';
  get('hand-position-move').disabled=isWidth?
    !ready||!calibrated||dirty||!Number.isFinite(input.valueAsNumber)||input.valueAsNumber<0:!ready;
  const range=calibrated?`저장된 교시 범위 ${table.points.at(-1).width_mm}–${table.points[0].width_mm} mm`:'실측 벌림표를 두 점 이상 교시하고 저장하세요.';
  get('hand-position-help').textContent=!isWidth?'위치값은 0–700의 정수입니다. 값이 커질수록 손가락이 닫힙니다.':
    dirty?'벌림표 변경사항을 저장하거나 저장값을 불러온 뒤 이동하세요.':range+' · 저장된 벌림표로 위치를 계산하고 승인 후 이동합니다.';
  const reason=dirty?'벌림표 변경사항을 저장하거나 저장값을 불러오세요.':!ready?get('hand-ready').textContent:'';
  get('hand-move-confirm-state').textContent=reason;
  get('hand-move-confirm').disabled=!ready||!widthTarget||dirty||saving||!isWidth||
    widthTarget.session_id!==host?.session_id||widthTarget.motion_token!==host?.motion_token||Date.now()>widthTarget.expires;
  const f=host?.gripper_feedback,estimated=f?.state==='completed'&&Number.isInteger(f.position)?feedbackWidth(f.position):null;
  get('hand-opening').textContent=estimated===null?'—':estimated.toFixed(1)+' mm';
}
for(const button of document.querySelectorAll('[data-hand]'))button.onclick=async()=>{
  if(button.disabled||busy||widthPending)return;
  const action=button.dataset.hand;
  if(action==='position'&&widthMode()){await previewWidth();return;}
  const body={session_id:host.session_id,motion_token:host.motion_token,action};
  if(action==='position'){
    body.position=get('hand-position').valueAsNumber;
    if(!Number.isInteger(body.position)||body.position<0||body.position>700){get('hand-result').textContent='0~700의 정수 위치를 입력하세요.';return;}
  }
  invalidateMove();busy=true;controls();get('hand-result').textContent='장치 응답 대기 중';
  try{
    const result=await api('command','POST',body);
    get('hand-result').textContent=(result.state==='unknown'?'결과 미확인 · ':'')+result.message;
  }catch(error){get('hand-result').textContent='명령 상태 확인 필요 · '+error.message;}
  finally{busy=false;host=null;controls();}
};
get('hand-position-unit').onchange=()=>{
  invalidateMove();get('hand-position').value='';get('hand-result').textContent='';controls();
};
get('hand-position').oninput=()=>{invalidateMove();get('hand-result').textContent='';controls();};
async function previewWidth(){
  if(get('hand-position-move').disabled||!widthMode())return;
  invalidateMove();const version=widthVersion;
  const body={width_mm:get('hand-position').valueAsNumber,revision:table.revision};
  widthPending=true;controls();get('hand-result').textContent='벌림 계산 중';
  try{
    const target=await api('test/preview','POST',body);
    if(version!==widthVersion||dirty||!widthMode()||!calibrationVisible())return;
    widthTarget={...body,session_id:host?.session_id,motion_token:host?.motion_token,expires:Date.now()+30000};
    get('hand-move-target').textContent=`요청 벌림 ${target.width_mm} mm → 명령 위치 ${target.position} · 예상 벌림 ${target.estimated_width_mm.toFixed(1)} mm (더 열린 쪽으로 반올림)`;
    get('hand-result').textContent=get('hand-move-target').textContent;
    get('hand-move-dialog').showModal();
    widthExpiry=setTimeout(()=>{invalidateMove();get('hand-result').textContent='이동 확인이 만료되었습니다. 다시 확인하세요.';controls();},30000);
  }catch(error){if(version===widthVersion)get('hand-result').textContent=error.message;}
  finally{widthPending=false;controls();}
}
get('hand-move-cancel').onclick=()=>get('hand-move-dialog').close();
get('hand-move-dialog').addEventListener('close',()=>{if(!get('hand-move-dialog').open){widthTarget=null;clearTimeout(widthExpiry);}});
get('hand-move-confirm').onclick=async()=>{
  if(get('hand-move-confirm').disabled||!widthTarget)return;
  const {expires,...body}=widthTarget;
  invalidateMove();busy=true;controls();get('hand-result').textContent='실제 그리퍼 응답 대기 중';
  try{
    const result=await api('test','POST',body);
    get('hand-result').textContent=(result.state==='unknown'?'결과 미확인 · ':'')+result.message;
  }catch(error){get('hand-result').textContent='명령 결과 확인 필요 · '+error.message;}
  finally{busy=false;host=null;controls();}
};
window.addEventListener('hashchange',invalidateMove);
window.addEventListener('robot-global-stop',invalidateMove);
