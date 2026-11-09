export const destinations = [
  { id: "dashboard", label: "대시보드", icon: "layout-dashboard" },
  { id: "orders", label: "주문·배송", icon: "package-check" },
  { id: "robot", label: "로봇 모니터링", icon: "robot-arm" },
  { id: "people", label: "사용자 관리", icon: "contact" },
  { id: "stock", label: "재고 관리", icon: "boxes" },
  { id: "model-management", label: "모델 관리", icon: "scan-line" },
  { id: "logs", label: "로그", icon: "scroll-text" }
];

const robotPages = [
  {id:"manipulator", label:"매니퓰레이터", icon:"robot-arm"},
  {id:"gripper", label:"그리퍼", icon:"settings"},
  {id:"work-plane", label:"작업 평면 보정", icon:"scan-line"}
];

export function icon(name) {
  return '<svg class="station-icon" aria-hidden="true"><use href="/static/station-icons.svg#' + name + '"></use></svg>';
}

const training = document.body.dataset.workspace === "training";

export function currentDestination() {
  if (document.body.dataset.workspace === "robot") {
    const id = location.hash.slice(1);
    if (["work-points-title","parcel-box-title","pose-title"].includes(id)) return robotPages[0];
    if (["gripper-table","gripper-test"].includes(id)) return robotPages.find(page => page.id === "gripper");
    return robotPages.find(page => page.id === id) || destinations.find(page => page.id === "robot");
  }
  if (training) return destinations.find(item => item.id === "model-management");
  const route = location.hash.slice(1);
  return destinations.find(item => item.id === route) || destinations[0];
}

function highlightDestination() {
  const current = currentDestination();
  if (robotPages.some(page => page.id === current.id)) expand(true);
  for (const link of document.querySelectorAll(".station-nav a")) {
    if (link.dataset.page === current.id) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

const rail = document.getElementById("station-rail");
const nav = document.createElement("nav");
nav.className = "station-nav";
nav.setAttribute("aria-label", "주 메뉴");
const toggle = document.createElement("button"), children = document.createElement("div");
toggle.type = "button"; toggle.className = "station-disclosure";
toggle.innerHTML = icon("robot-arm") + "로봇 관리";
children.id = "robot-nav-children"; children.className = "station-children";
toggle.setAttribute("aria-controls",children.id);
function expand(open) {
  toggle.setAttribute("aria-expanded", String(open));
  children.hidden = !open;
}
expand(false);
toggle.addEventListener("click", () => expand(children.hidden));
for (const page of robotPages) {
  const link = document.createElement("a");
  link.dataset.page = page.id; link.href = "/robot#" + page.id; link.textContent = page.label;
  children.append(link);
}
for (const item of destinations) {
  if (item.id === "dashboard" || item.id === "people") {
    const group = document.createElement("div");
    group.className = "nav-group";
    group.textContent = item.id === "dashboard" ? "운영" : "관리";
    nav.append(group);
  }
  if (item.id === "people") nav.append(toggle,children);
  const link = document.createElement("a");
  link.href = item.id === "robot" ? "/robot" : "/#" + item.id;
  link.dataset.page = item.id;
  link.innerHTML = icon(item.icon) + item.label;
  nav.append(link);
}
rail.innerHTML = '<div class="station-brand"><span class="brand-mark">' + icon("scan-line") +
  '</span><div>Vision Lab<small>LOCAL WORKSPACE</small></div></div>';
rail.append(nav);
const mode = document.createElement("div");
mode.className = "rail-status";
mode.textContent = training ? "로컬 모델 학습" : document.body.dataset.workspace === "robot" ? "E0509 · 유선 LAN" : "패킹 시뮬레이션";
const controls=document.createElement('div');controls.className='rail-controls';
const stop=document.createElement('button');stop.type='button';stop.id='robot-global-stop';stop.className='rail-stop';stop.textContent='■ 중단';stop.setAttribute('aria-label','로봇 작업 중단');
const stopState=document.createElement('p');stopState.className='rail-stop-state';stopState.setAttribute('role','status');stopState.hidden=true;
controls.append(stop,stopState,mode);rail.append(controls);
stop.addEventListener('click',async()=>{
  if(stop.disabled)return;
  stop.disabled=true;stopState.hidden=false;stopState.textContent='중단 요청 중…';
  window.dispatchEvent(new Event('robot-global-stop'));
  try{
    const response=await fetch('/api/robot/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)});
    const result=await response.json();
    if(!response.ok)throw Error(typeof result.detail==='string'?result.detail:'중단 요청에 실패했습니다.');
    stopState.textContent=result.message||'중단을 요청했습니다.';
  }catch(error){stopState.textContent=error.message||'중단 응답을 확인할 수 없습니다.';}
  finally{stop.disabled=false;}
});
highlightDestination();
window.addEventListener("hashchange", highlightDestination);
