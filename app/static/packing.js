import { currentDestination, icon } from "./station-nav.js";
import { demo, record, saveDemo } from "./packing-demo.js";
import { connectDashboardCamera } from "./dashboard-camera.js";

const root = document.getElementById("packing-station");
const view = document.getElementById("demo-view");
let selectedOrder = 123;
let selectedSku = "PK-001";
let customerIndex = 0;
let logKind = "작업";
let form = "";
let voiceOpen = false;
let voiceStatus = null;
let voiceSerial = 0;
const voiceStates = {disabled: "음성 기능 꺼짐", idle: "호출 대기", preparing: "마이크 준비 중", preparing_reply: "Yuna 응답 준비 중",
  permission: "Mac의 마이크 접근 창에서 허용을 눌러 주세요.", listening: "듣는 중", processing: "명령 처리 중", speaking: "Yuna 응답 중", stopping: "청취 중단 중", error: "음성 오류"};
let reply = "";
let confirmingOrder = false;
let station;
let signature = "";
let requestSerial = 0;
let pending = false;
let lastPlaceClick = -Infinity;
const api = "/api/packing";

async function request(path = "", method = "GET", body) {
  const response = await fetch(api + path, {
    method, cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(typeof error.detail === "string" ? error.detail : "요청을 처리하지 못했습니다. 입력값과 서버 연결을 확인하세요.");
  }
  return response.json();
}

async function refresh() {
  const serial = ++requestSerial;
  const next = await request();
  if (serial !== requestSerial) return;
  const content = JSON.stringify(next);
  if (content === signature) return;
  station = next;
  signature = content;
  if (!form && !pending) render();
}

const mainOrder = () => station.orders.find(o => o.number === 123);
const extraOrder = () => station.orders.some(o => o.number === 124);
const productBySku = sku => station.products.find(p => p.sku === sku);
const orderItems = (order = mainOrder()) => order.items.map(i => ({...productBySku(i.sku), ...i}));
const packed = (order = mainOrder()) => order.items.filter(i => i.done).length;
const isPacked = () => mainOrder().state === "awaiting_dispatch";
function orderStatus(order = mainOrder()) {
  if (order.state === "received") return "주문 접수";
  if (order.state === "awaiting_dispatch") return "발송 대기";
  return order.paused ? "일시정지" : "피킹 중";
}
const workEvents = () => station.events.map(e => [
  new Date(e.time).toLocaleTimeString("ko-KR", {hour12:false}), "작업", e.source, e.message
]);

const escapeHtml = value => String(value).replace(/[&<>"']/g, ch =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

function button(action, label, style = "", disabled = false) {
  return `<button type="button" data-action="${action}" class="${style}" ${disabled ? "disabled" : ""}>${label}</button>`;
}

function badge(text, style = "") {
  return `<span class="pill ${style}">${escapeHtml(text)}</span>`;
}

function panel(title, body, action = "") {
  return `<section class="panel"><div class="panel-head"><h2>${escapeHtml(title)}</h2>${action}</div>${body}</section>`;
}

function table(headings, rows) {
  const headers = headings.map(text => `<th scope="col">${text}</th>`).join("");
  const body = rows.map(cells => `<tr>${cells.map(cell => `<td>${cell}</td>`).join("")}</tr>`).join("");
  return `<div class="sheet"><table><thead><tr>${headers}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function facts(entries) {
  return `<dl class="facts">${entries.map(([label, value]) =>
    `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`;
}

function eventList(events) {
  return `<ol class="activity">${events.slice().reverse().map(([time, , source, text]) =>
    `<li><time>${escapeHtml(time)}</time><span class="event-type">${escapeHtml(source)}</span><span>${escapeHtml(text)}</span></li>`
  ).join("")}</ol>`;
}

function pickList() {
  const rows = orderItems().map((item, index) => {
    const done = item.done;
    const active = index === packed();
    const status = done ? "담음" : active ? (mainOrder().paused ? "정지" : "피킹 중") : "대기";
    const mark = icon(done ? "circle-check" : active ? "scan" : "circle");
    return `<li class="${done ? "done" : active ? "target" : ""}">${mark}<span>${escapeHtml(item.name)}</span>
      <span class="unit">1${escapeHtml(item.unit)} · ${status}</span></li>`;
  });
  return `<ul class="picks">${rows.join("")}</ul>`;
}

function packingControls() {
  if (isPacked()) return badge("포장 완료");
  const toggle = mainOrder().paused ? button("toggle", icon("play") + "작업 재개", "main-btn")
                             : button("toggle", icon("pause") + "작업 정지", "stop-btn");
  const next = orderItems().find(i => !i.done);
  return `<div><div class="buttons">${toggle}${button("place-" + next.id, "놓기 완료 시연", "", mainOrder().paused)}</div>
    <p class="meta">놓기 완료 시 재고 차감 · ${escapeHtml(next.name)} 1${escapeHtml(next.unit)}</p></div>`;
}

let stopCamera;
function disconnectCamera() {
  stopCamera?.();
  stopCamera = null;
}

function renderDashboard() {
  if (!view.querySelector("#live-camera")) {
    view.replaceChildren(document.getElementById("dashboard-layout").content.cloneNode(true));
  }
  // Keep the camera mounted across inventory and order updates.
  stopCamera ??= connectDashboardCamera(document.getElementById("live-camera"), () => station);
  if (!station) {
    document.getElementById("dashboard-order").textContent = "주문 조회 대기 중";
    return;
  }
  const progress = mainOrder().items.map(item => `<span class="${item.done ? "filled" : ""}"></span>`).join("");
  document.getElementById("dashboard-order").innerHTML = `
    <div><div class="row"><strong class="order-no">#123</strong>${badge(orderStatus(), mainOrder().paused ? "amber" : "")}</div>
      <p class="order-name">${escapeHtml(mainOrder().customer)} <span class="meta">· RFID 박스 A1</span></p></div>
    <div><div class="row"><span class="meta">포장 수량</span><span class="qty">${packed()} / ${mainOrder().items.length}</span></div>
      <div class="progress" aria-hidden="true">${progress}</div></div>
    ${pickList()}${packingControls()}`;
  document.getElementById("dashboard-events").innerHTML = eventList(workEvents().slice(-3));
}

function shippingProgress(step) {
  const stages = ["주문 접수", "택배 상품 준비", "발송 대기", "발송 완료", "배송 완료"];
  return `<ol class="pipeline" aria-label="배송 진행 단계">${stages.map((name, i) => {
    const active = i === step ? 'class="current" aria-current="step"' : "";
    return `<li ${active} ${i > 2 ? 'aria-disabled="true"' : ""}>${name}${i > 2 ? " · 비활성" : ""}</li>`;
  }).join("")}</ol>`;
}

function orders() {
  const rows = station.orders.map(o => [button("select-" + o.number, "#" + o.number, "link"), escapeHtml(o.customer),
    badge(orderStatus(o), o.paused ? "amber" : ""), o.items.length + "개"]);
  const order = station.orders.find(o => o.number === selectedOrder) || mainOrder();
  const received = order.state === "received";
  const items = received
    ? table(["주문 품목", "수량"], orderItems(order).map(p => [escapeHtml(p.name), "1" + escapeHtml(p.unit)]))
    : pickList();
  return panel("주문 목록", table(["주문 번호", "주문자", "상태", "주문 수량"], rows), button("new-order", icon("mic") + "음성 주문 예시")) +
    panel("주문 #" + order.number, `<div class="pad stack">
      ${shippingProgress(received ? 0 : order.state === "awaiting_dispatch" ? 2 : 1)}
      ${facts([["주문자", order.customer], ["박스 RFID", received ? "판독 대기" : "E2-34-08-A1"],
        ["포장 수량", packed(order) + " / " + order.items.length]])}
      ${items}${received ? '<p class="meta">다음 박스의 RFID 판독 대기</p>' : packingControls()}
    </div>`);
}

function field(label, name, value = "", attrs = "") {
  return `<label class="field">${label}<input name="${name}" value="${escapeHtml(value)}" required maxlength="40" ${attrs}></label>`;
}

function editForm(kind, fields) {
  return `<form data-edit="${kind}" class="pad"><div class="fields">${fields.join("")}</div>
    <div class="buttons end">${button("cancel", "취소")}<button type="submit" class="main-btn">저장</button></div></form>`;
}

function inventory() {
  const rows = station.products.map(p => [button("sku-" + p.sku, escapeHtml(p.name), "link"),
    escapeHtml(p.sku), p.stock, p.reserved, p.available, escapeHtml(p.bin || "—")]);
  const product = productBySku(selectedSku) || station.products[0];
  const model = station.model;
  const assigned = model.classes.find(c => c.sku === selectedSku);
  const add = form === "product" ? editForm("product", [
    field("상품명", "name"), field("단위", "unit", "개"), field("입고 수량", "stock", 1, 'type="number" min="0" max="9999"'),
    '<label class="field">음성 별칭 (선택)<input name="alias" maxlength="80"></label>',
    '<label class="field">보관 위치 (선택)<input name="bin" maxlength="80"></label>'
  ]) : "";
  const adjust = form === "adjust" ? editForm("adjust", [
    field("실사한 보유 수량", "stock", product.stock, `type="number" min="${product.reserved}" max="9999"`),
    `<input type="hidden" name="expected_stock" value="${product.stock}">`,
    `<p class="meta">예약 수량 ${product.reserved}${escapeHtml(product.unit)} 이상으로 입력하세요.</p>`
  ]) : "";
  const options = model.classes.map(c => {
    const other = c.sku && c.sku !== product.sku ? productBySku(c.sku) : null;
    return `<option value="${c.id}" ${other ? "disabled" : ""} ${c.sku === product.sku ? "selected" : ""}>${escapeHtml(c.name)}${other ? " · " + escapeHtml(other.name) + " 연결됨" : ""}</option>`;
  });
  const mapping = form === "mapping" ? editForm("mapping", [
    `<input type="hidden" name="model_id" value="${escapeHtml(model.id)}">`,
    `<label class="field">탐지 클래스<select name="class_id"><option value="">미연결</option>${options.join("")}</select></label>`
  ]) : "";
  return panel("상품 재고", add + table(["상품명", "SKU", "보유", "예약", "가용", "위치"], rows), button("add-product", icon("plus") + "상품 등록")) +
    panel(product.name, `<div class="pad stack">${facts([["음성 별칭", product.alias], ["수량 단위", product.unit],
      ["활성 모델", model.name], ["탐지 클래스", assigned?.name || "미연결"]])}
      <div class="buttons">${button("adjust", "재고 수량 조정")}${button("mapping", assigned ? "클래스 연결 변경" : "탐지 클래스 연결", "", !model.classes.length)}
      <a class="link" href="/training#collect">모델 학습 열기 ${icon("arrow-right")}</a></div>
      ${model.classes.length ? "" : '<p class="meta">활성 모델에 등록된 클래스가 없습니다.</p>'}</div>` + adjust + mapping);
}

function customers() {
  const rows = demo.customers.map((person, i) => [button("person-" + i, escapeHtml(person.name), "link"),
    `<span class="mono">${escapeHtml(person.uid || "—")}</span>`, person.uid ? badge("연결됨") : badge("미연결", "neutral")]);
  const person = demo.customers[customerIndex];
  const locked = customerIndex === 0 && !isPacked();
  const add = form === "customer" ? editForm("customer", [field("고객 이름", "name"), field("박스 RFID ID", "uid")]) : "";
  const edit = form === "rfid" ? editForm("rfid", [field("박스 RFID ID", "uid", person.uid)]) : "";
  return panel("고객 목록", add + table(["고객", "박스 RFID", "연결 상태"], rows), button("add-customer", icon("user-plus") + "고객 등록")) +
    panel(person.name + " · RFID", `<div class="pad stack">
      ${facts([["박스 RFID", person.uid || "미연결"], ["접수 주문", customerIndex === 0 ? (extraOrder() ? "#123, #124" : "#123") : "없음"]])}
      <div class="buttons">${button("edit-rfid", person.uid ? "RFID 변경" : "RFID 연결", "", locked)}
        ${person.uid ? button("unlink-rfid", "연결 해제", "", locked) : ""}
        ${customerIndex === 0 ? button("order-detail", "주문 상세 " + icon("arrow-right"), "link") : ""}</div>
      ${locked ? '<p class="meta">패킹 중인 박스의 RFID는 작업 완료 후 변경할 수 있습니다.</p>' : ""}
    </div>` + edit);
}

function logs() {
  const filters = [["작업", "작업 이력"], ["음성", "대화 기록"]].map(([kind, label]) =>
    `<button type="button" data-action="log-${kind}" aria-pressed="${logKind === kind}">${label}</button>`).join("");
  const items = logKind === "작업" ? workEvents() : demo.events;
  return `<div class="tabs" role="group" aria-label="기록 구분">${filters}</div>` +
    panel(logKind === "음성" ? "대화 기록" : "작업 이력", eventList(items), badge("스테이션 01", "neutral"));
}

const voiceCommands = {
  "query-stock": "재고 파악해줘",
  "query-order": "주문 내역 알려줘",
  "cmd-stop": "멈춰",
  "cmd-go": "피킹 시작해줘",
  "cmd-order": "빼빼로·생수·물티슈 하나씩 주문해줘"
};

async function updateVoice(action = "status") {
  const serial = ++voiceSerial;
  const previous = voiceStatus;
  if (action === "stop") {
    voiceStatus = {...previous, state: "stopping", can_stop: false};
    renderVoice();
  }
  try {
    const response = await fetch("/api/voice/" + action,
      {method: action === "status" ? "GET" : "POST", cache: "no-store"});
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "음성 서버 연결을 확인하세요.");
    if (serial !== voiceSerial || JSON.stringify(data) === JSON.stringify(voiceStatus)) return;
    voiceStatus = data;
  } catch (error) {
    if (serial !== voiceSerial) return;
    voiceStatus = {...previous, state: "error", error: error.message};
  }
  renderVoice();
}

function renderVoice() {
  const voicePanel = document.getElementById("voice-panel");
  voicePanel.hidden = !voiceOpen;
  root.querySelector(".voice").setAttribute("aria-expanded", String(voiceOpen));
  if (!voiceOpen) return;
  const commands = Object.entries(voiceCommands).map(([id, label]) => button(id, label)).join("");
  const confirm = confirmingOrder ? `<div class="buttons">${button("confirm-order", "네, 주문해줘", "main-btn")}${button("discard-order", "취소")}</div>` : "";
  const status = voiceStatus || {};
  let stateLabel = voiceStates[status.state];
  if (status.state === "speaking" && status.barge_in) stateLabel = "Yuna 응답 중 · 지금 말해도 됩니다";
  if (status.state === "listening" && status.last_playback === "interrupted") stateLabel = "낭독 중단 · 듣는 중";
  const canWake = !status.can_stop && ["idle", "error"].includes(status.state);
  const hint = status.error || (status.state === "disabled" ? "YOLO_VOICE_ENABLED=1로 서버를 시작하세요." : "");
  voicePanel.innerHTML = `<div class="row"><h3>음성 명령</h3>${button("voice", "닫기", "link")}</div>
    <p role="status">${escapeHtml(stateLabel || "상태 확인 중")}</p>
    <div class="buttons">${button("wake", "대화 시작", "main-btn", !canWake)}
      ${button("stop-listening", "청취 중단", "stop-btn", !status.can_stop)}</div>
    ${hint ? `<p>${escapeHtml(hint)}</p>` : ""}
    ${status.transcript ? `<p>작업자 · ${escapeHtml(status.transcript)}</p>` : ""}
    ${status.reply ? `<p>Yuna · ${escapeHtml(status.reply)}</p>` : ""}
    <h3>버튼으로 실행</h3><div class="buttons">${commands}</div>
    ${reply ? `<p class="reply" role="status">${escapeHtml(reply)}</p>` : ""}${confirm}`;
}

async function runCommand(action) {
  const answer = await request("/command", "POST", {action});
  const label = voiceCommands[action] || (action === "confirm-order" ? "네, 주문해줘" : "취소");
  record("음성", "사용자", label);
  reply = answer.text;
  record("음성", "시스템", reply);
  confirmingOrder = answer.confirm;
}

const pages = { orders, stock: inventory, people: customers, logs };

function render() {
  const route = location.hash.slice(1);
  // Bookmarks from the original single-page training UI still open the real tool.
  if (["collect", "jobs", "models", "live", "training"].includes(route)) {
    location.replace("/training#" + (route === "training" ? "collect" : route));
    return;
  }
  const page = currentDestination();
  document.title = page.label + " · Vision Lab";
  document.getElementById("page-title").textContent = page.label;
  root.querySelector(".voice").disabled = !station;
  renderVoice();
  if (page.id === "dashboard") {
    renderDashboard();
  } else {
    disconnectCamera();
    view.innerHTML = station ? pages[page.id]() : '<p role="status">재고와 주문을 불러오는 중입니다.</p>';
  }
}

function announce(text) {
  document.getElementById("demo-status").textContent = text;
}

function showOrder(id) {
  selectedOrder = id;
  location.hash = "orders";
}

const actions = {
  wake() { return updateVoice("wake"); },
  "stop-listening"() { return updateVoice("stop"); },
  async voice() {
    voiceOpen = !voiceOpen;
    if (voiceOpen) await updateVoice();
    reply = "";
    confirmingOrder = false;
  },
  "new-order"() {
    voiceOpen = true;
    void updateVoice();
    return runCommand("cmd-order");
  },
  async "confirm-order"() {
    if (!confirmingOrder || extraOrder()) return;
    await runCommand("confirm-order");
    showOrder(124);
  },
  "discard-order"() {
    return runCommand("discard-order");
  },
  async toggle() {
    const action = mainOrder().paused ? "cmd-go" : "cmd-stop";
    announce((await request("/command", "POST", {action})).text);
  },
  "order-detail"() { showOrder(123); },
  "all-logs"() { logKind = "작업"; location.hash = "logs"; },
  "select-123"() { selectedOrder = 123; },
  "select-124"() { selectedOrder = 124; },
  "add-product"() { form = "product"; },
  "add-customer"() { form = "customer"; },
  "edit-rfid"() { form = "rfid"; },
  "unlink-rfid"() {
    demo.customers[customerIndex].uid = "";
    form = "";
    saveDemo();
    announce("박스 RFID 연결을 해제했습니다.");
  },
  adjust() { form = "adjust"; },
  mapping() { form = "mapping"; },
  cancel() { form = ""; }
};

function showError(error, source = "action") {
  const message = document.getElementById("packing-error");
  message.dataset.source = source;
  message.textContent = error.message || "서버 연결을 확인하세요.";
  message.hidden = false;
}

async function perform(work, reload = false) {
  if (pending) return;
  pending = true;
  document.getElementById("packing-error").hidden = true;
  try {
    await work();
    if (reload) await refresh();
  } catch (error) {
    showError(error);
    await refresh().catch(() => {});
  } finally {
    pending = false;
    render();
  }
}

root.addEventListener("click", async event => {
  const control = event.target.closest("button[data-action]");
  if (!control || control.disabled || pending) return;
  const action = control.dataset.action;
  if (action.startsWith("place-")) {
    // A double click must not advance the newly rendered next item.
    if (performance.now() - lastPlaceClick < 650 || event.detail > 1) return;
    lastPlaceClick = performance.now();
    const id = action.slice(6);
    await perform(() => request("/orders/123/items/" + encodeURIComponent(id) + "/complete", "PUT"), true);
  } else if (Object.hasOwn(voiceCommands, action)) {
    await perform(() => runCommand(action), true);
  } else if (Object.hasOwn(actions, action)) {
    await perform(actions[action], ["toggle", "new-order", "confirm-order"].includes(action));
  } else {
    if (action.startsWith("sku-")) { selectedSku = action.slice(4); form = ""; }
    else if (action.startsWith("person-")) { customerIndex = Number(action.slice(7)); form = ""; }
    else if (action.startsWith("log-")) logKind = action.slice(4);
    else return;
    render();
  }
  const firstField = view.querySelector("form input:not([type=hidden]), form select");
  if (firstField) firstField.focus();
  else {
    const selector = ["wake", "stop-listening"].includes(action)
      ? '#voice-panel [data-action="wake"]:enabled, #voice-panel [data-action="stop-listening"]:enabled'
      : `[data-action="${CSS.escape(action)}"]:not(:disabled)`;
    const nextControl = root.querySelector(selector);
    if (nextControl && !nextControl.closest("[hidden]")) nextControl.focus({ preventScroll: true });
  }
});

root.addEventListener("input", event => {
  if (event.target instanceof HTMLInputElement) event.target.setCustomValidity("");
});

root.addEventListener("submit", async event => {
  const editor = event.target.closest("form[data-edit]");
  if (!editor) return;
  event.preventDefault();
  if (pending) return;
  const values = Object.fromEntries([...new FormData(editor)].map(([key, value]) => [key, value.trim()]));
  for (const [name, value] of Object.entries(values)) {
    if (!value && editor.elements[name].required) {
      editor.elements[name].setCustomValidity("값을 입력해 주세요.");
      editor.reportValidity();
      return;
    }
  }
  const kind = editor.dataset.edit;
  if (kind === "customer" || kind === "rfid") {
    const uid = values.uid.toUpperCase();
    const duplicate = demo.customers.some((c, i) => c.uid === uid && (kind === "customer" || i !== customerIndex));
    if (duplicate) {
      editor.elements.uid.setCustomValidity("이미 다른 고객에게 연결된 RFID입니다.");
      editor.reportValidity();
      return;
    }
    if (kind === "customer") {
      customerIndex = demo.customers.length;
      demo.customers.push({ name: values.name, uid });
    } else {
      demo.customers[customerIndex].uid = uid;
    }
  } else {
    const sku = selectedSku;
    await perform(async () => {
      if (kind === "product") {
        const added = await request("/products", "POST", {...values, stock: Number(values.stock)});
        selectedSku = added.sku;
      } else if (kind === "adjust") {
        await request("/products/" + sku + "/stock", "PUT", {stock: Number(values.stock), expected_stock: Number(values.expected_stock)});
      } else if (kind === "mapping") {
        await request("/models/" + encodeURIComponent(values.model_id) + "/products/" + sku + "/class", "PUT",
          {class_id: values.class_id === "" ? null : Number(values.class_id)});
      }
      form = "";
      announce("저장했습니다.");
    }, true);
    return;
  }
  form = "";
  saveDemo();
  render();
  announce("저장했습니다.");
});

window.addEventListener("hashchange", () => {
  form = "";
  voiceOpen = false;
  confirmingOrder = false;
  render();
  window.scrollTo(0, 0);
});

window.addEventListener("pagehide", disconnectCamera);
window.addEventListener("pageshow", event => { if (event.persisted) render(); });
render();

async function sync() {
  if (pending || document.hidden) return;
  try {
    await Promise.all([refresh(), voiceOpen ? updateVoice() : undefined]);
    const message = document.getElementById("packing-error");
    if (message.dataset.source === "sync") message.hidden = true;
  } catch (error) {
    showError(error, "sync");
  }
}
window.addEventListener("focus", sync);
document.addEventListener("visibilitychange", sync);
setInterval(sync, 2000);
sync();
