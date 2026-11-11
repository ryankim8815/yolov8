
// One persistent editor survives workspace remounts, just like the TCP editors.
const parcelListeners = new Set();
let parcelPreview = null;
export function subscribeParcelBox(listener) {
  parcelListeners.add(listener); listener(parcelPreview);
  return () => parcelListeners.delete(listener);
}
function createParcelBoxEditor() {
  const form = document.getElementById("parcel-box-form");
  const inputs = ["width","depth","height","x","y","z"].map(name => form.elements.namedItem(name));
  const state = document.getElementById("parcel-box-state"), hint = document.getElementById("parcel-box-preview");
  const feedback = document.getElementById("parcel-box-feedback"), save = document.getElementById("parcel-box-save");
  const cancel = document.getElementById("parcel-box-cancel"), reload = document.getElementById("parcel-box-reload");
  let saved = null, dirty = false, revision = null, pending = false, rejected = false, online = false, signature;
  function value() {
    const numbers = inputs.map(input => input.valueAsNumber);
    if (!inputs.every(input => input.validity.valid) || !numbers.every(v => Number.isFinite(v) && Math.abs(v)<=1e6) || numbers.slice(0,3).some(v => v < .001)) return null;
    return {size_mm:numbers.slice(0,3), center_base_mm:numbers.slice(3)};
  }
  function fill() {inputs.forEach((input,i) => {input.value = [...(saved?.size_mm ?? [null,null,null]),...(saved?.center_base_mm ?? [null,null,null])][i] ?? "";});}
  function message(text, error = false) {feedback.textContent=text;feedback.dataset.error=error;}
  function update() {
    const box=value(), conflict=rejected || dirty && revision !== saved?.revision;
    state.textContent = pending ? "처리 중" : conflict ? "다른 화면에서 변경됨" : dirty ? "저장 전" : saved?.revision ? "저장됨" : saved ? "기본값" : "조회 필요";
    inputs.forEach(input => {input.disabled=pending;});
    save.disabled=pending || !online || !saved || (!dirty && saved.revision !== null) || conflict || !box;
    cancel.disabled=pending || !dirty;
    reload.hidden=!conflict && Boolean(saved) && online;reload.disabled=pending;
    hint.textContent=box ? `바닥면 중심 (${box.center_base_mm.join(", ")}) mm · 윗면 Z ${Number((box.center_base_mm[2]+box.size_mm[2]).toFixed(3))} mm · ${dirty?"저장 전 미리보기":saved?.revision?"저장된 박스":"기본 박스"}`
      : "크기는 0보다 큰 값, 위치는 유효한 BASE 좌표로 모두 입력하세요. 입력이 완성되면 박스가 표시됩니다.";
    const next=box ? {...box,revision:saved?.revision??null,draft:dirty} : null, key=JSON.stringify(next);
    if(key!==signature){signature=key;parcelPreview=next;for(const listener of parcelListeners)listener(next);}
  }
  function receive(next) {
    if(next && (!saved || (next.updated_at || "") >= (saved.updated_at || "")) && (!saved || next.revision !== saved.revision)) {
      saved=next;if(!dirty&&!pending)fill();
    }
    update();
  }
  async function request(saving) {
    if(pending || saving && save.disabled)return;
    const body=saving ? {...value(),revision} : null;
    pending=true;message(saving?"박스 설정 저장 중…":"최신 박스 설정 조회 중…");update();
    try {
      const response=await fetch("/api/robot/parcel-box",saving ? {
        method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(6000)
      } : {cache:"no-store",signal:AbortSignal.timeout(6000)});
      const data=await response.json();
      if(!response.ok){if(response.status===409)rejected=true;throw Error(typeof data.detail==="string"?data.detail:"박스 크기와 위치 입력값을 확인하세요.");}
      saved=data;online=true;dirty=false;rejected=false;revision=saved.revision;fill();
      message(saving?"박스 설정을 저장했습니다.":"최신 박스 설정을 불러왔습니다.");
    } catch(error) {
      if(error instanceof TypeError || error instanceof SyntaxError || error.name==="TimeoutError") {
        online=false;message("서버 응답을 확인하지 못했습니다. 입력값을 유지합니다. 최신 설정을 다시 불러오세요.",true);
      }else message(error.message,true);
    } finally {pending=false;update();}
  }
  form.addEventListener("input",()=>{if(!dirty)revision=saved?.revision ?? null;dirty=true;message("");update();});
  form.addEventListener("submit",event=>{event.preventDefault();if(form.reportValidity())void request(true);});
  cancel.addEventListener("click",()=>{if(rejected){void request(false);return;}dirty=false;revision=saved?.revision;fill();message("");update();});
  reload.addEventListener("click",()=>void request(false));
  void request(false);
  return (data,available)=>{online=available;receive(data);};
}
const renderParcelBox=createParcelBoxEditor();

export function renderWorkPoints(data, {apiUnavailable}) {
  renderParcelBox(data.parcel_box, !apiUnavailable);
}
