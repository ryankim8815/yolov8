"use strict";
const $ = (id) => document.getElementById(id);
const names = {starting:"모델 준비 중",ready:"실시간 탐지 중",camera_unavailable:"카메라 연결 대기",stale:"영상 수신 지연",error:"실행 오류",stopped:"서버 종료",offline:"서버 연결 끊김",camera_off:"카메라 꺼짐",training:"학습·평가·변환 중",switching_model:"모델 전환 중"};
let currentStatus = null;
let streamActive = false;
let socket = null;
let reconnectDelay = 1000;
let lastSession = null;
let lastFrame = -1;
let lastEventAt = 0;

function clearObjects(message) {
  $("objects").replaceChildren();
  const li = document.createElement("li"); li.className = "empty"; li.textContent = message;
  $("objects").append(li); $("count").textContent = "—";
}
function updateStatus(status) {
  if(currentStatus?.session_id !== status.session_id){streamActive=false;$("preview").removeAttribute("src");$("preview").hidden=true;clearObjects("새 모델 결과 대기 중");}
  currentStatus = status;
  $("state").textContent = names[status.state] || status.state;
  $("status-pill").classList.toggle("ready", Boolean(status.ready));
  $("error").hidden = !status.last_error; $("error").textContent = status.last_error || "";
  if (status.backend) $("backend").textContent = status.backend.toUpperCase();
  if (status.model) $("model").textContent = status.model;
  if($("active-version")) $("active-version").textContent = status.model_version || "";
  window.dispatchEvent(new CustomEvent("vision-status", {detail:status}));
  if (status.configuration) {
    const c=status.configuration;
    $("settings-values").textContent=`입력 ${c.imgsz} × ${c.imgsz} · 최소 confidence ${c.confidence} · NMS IoU ${c.iou} · 최대 ${c.max_det}개 객체 · 미리보기 최대 ${c.preview_fps} FPS`;
  }
  $("fps").textContent = status.fps?.detected?.toFixed(1) ?? "—";
  $("capture-fps").textContent = `카메라 ${status.fps?.captured?.toFixed(1) ?? "—"} / 미리보기 ${status.fps?.encoded?.toFixed(1) ?? "—"}`;
  $("latency").textContent = status.capture_to_result_ms?.p95?.toFixed(1) ?? "—";
  $("drops").textContent = `생략한 입력 ${status.input_dropped ?? 0}`;
  $("frame-age").textContent = status.frame_age_ms != null ? `최근 결과 입력 ${status.frame_age_ms.toFixed(0)} ms 전` : "결과 수신 대기";
  const size = status.camera?.actual_size;
  if(size) document.querySelector(".viewport").style.aspectRatio=`${size.width}/${size.height}`;
  $("resolution").textContent = size ? `${size.width} × ${size.height}` : "입력 대기 중";
  if (status.ready) {
    if (!streamActive) {streamActive = true; $("preview").src = `/stream.mjpg?t=${Date.now()}`;}
  } else {
    streamActive = false; $("preview").removeAttribute("src"); $("preview").hidden = true;
    $("placeholder").hidden = false; $("placeholder-title").textContent = names[status.state] || "입력 대기 중";
    $("placeholder-detail").textContent = status.last_error || "유효한 카메라 프레임을 기다리고 있습니다.";
    clearObjects("현재 유효한 탐지 결과가 없습니다.");
  }
}
function updateDetections(packet) {
  if (!currentStatus?.ready) return;
  if (packet.session_id !== lastSession) {lastSession = packet.session_id; lastFrame = -1;}
  if (packet.session_id !== currentStatus.session_id || packet.frame_id <= lastFrame) return;
  window.dispatchEvent(new CustomEvent("vision-detections", {detail:packet}));
  lastFrame = packet.frame_id; $("frame-id").textContent = `프레임 #${packet.frame_id}`;
  $("objects").replaceChildren();
  if (!packet.objects.length) clearObjects("감지된 객체가 없습니다.");
  $("count").textContent = String(packet.objects.length);
  for (const object of packet.objects) {
    const li = document.createElement("li"); li.className = "object";
    const details = document.createElement("div"); const label = document.createElement("strong");
    label.textContent = object.label;
    const coordinates = document.createElement("small"); coordinates.textContent = object.xyxy.map(Math.round).join(" · ");
    details.append(label, coordinates);
    const score = document.createElement("span"); score.className = "confidence"; score.textContent = `${(object.confidence * 100).toFixed(1)}%`;
    li.append(details, score); $("objects").append(li);
  }
}
$("preview").addEventListener("load", () => {if(currentStatus?.ready){$("preview").hidden=false;$("placeholder").hidden=true;}});
$("preview").addEventListener("error", () => {streamActive=false;$("preview").hidden=true;$("placeholder").hidden=false;$("placeholder-title").textContent="영상 연결을 다시 시도합니다";});
function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}/ws/detections`);
  socket.onopen = () => {reconnectDelay=1000;lastFrame=-1;lastEventAt=Date.now();};
  socket.onmessage = (event) => {
    lastEventAt=Date.now();
    try {const packet=JSON.parse(event.data);if(packet.event==="status")updateStatus(packet);else if(packet.event==="detections")updateDetections(packet);} catch(error){console.error("Invalid server message",error);}
  };
  socket.onclose = () => {updateStatus({state:"offline",ready:false});setTimeout(connect,reconnectDelay);reconnectDelay=Math.min(10000,reconnectDelay*2);};
  socket.onerror = () => socket.close();
}
// Also detect a frozen connection so the last image is never presented as live indefinitely.
setInterval(() => {if(socket?.readyState===WebSocket.OPEN && Date.now()-lastEventAt>3000){updateStatus({state:"offline",ready:false});socket.close();}},1000);
connect();
