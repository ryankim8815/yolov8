import { currentDestination, icon } from "./station-nav.js";
import { demo, isPacked, orderItems, orderStatus, packNext, record, reserved, saveDemo, setPaused } from "./packing-demo.js";
import { connectDashboardCamera } from "./dashboard-camera.js";

const root = document.getElementById("packing-station");
const view = document.getElementById("demo-view");
let selectedOrder = 123;
let productIndex = 0;
let customerIndex = 0;
let logKind = "작업";
let form = "";
let voiceOpen = false;
let reply = "";
let confirmingOrder = false;

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
    const done = index < demo.packed;
    const active = index === demo.packed;
    const status = done ? "담음" : active ? (demo.paused ? "정지" : "피킹 중") : "대기";
    const mark = icon(done ? "circle-check" : active ? "scan" : "circle");
    return `<li class="${done ? "done" : active ? "target" : ""}">${mark}<span>${escapeHtml(item.name)}</span>
      <span class="unit">1${escapeHtml(item.unit)} · ${status}</span></li>`;
  });
  return `<ul class="picks">${rows.join("")}</ul>`;
}

function packingControls() {
  if (isPacked()) return badge("포장 완료");
  const toggle = demo.paused ? button("toggle", icon("play") + "작업 재개", "main-btn")
                             : button("toggle", icon("pause") + "작업 정지", "stop-btn");
  return `<div class="buttons">${toggle}${button("advance", "놓기 완료 시연", "", demo.paused)}</div>`;
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
  // Keep the camera element and its subscription mounted across mock order updates.
  stopCamera ??= connectDashboardCamera(document.getElementById("live-camera"));
  const progress = orderItems().map((_, i) => `<span class="${i < demo.packed ? "filled" : ""}"></span>`).join("");
  document.getElementById("dashboard-order").innerHTML = `
    <div><div class="row"><strong class="order-no">#123</strong>${badge(orderStatus(), demo.paused ? "amber" : "")}</div>
      <p class="order-name">홍길동 <span class="meta">· RFID 박스 A1</span></p></div>
    <div><div class="row"><span class="meta">포장 수량</span><span class="qty">${demo.packed} / 3</span></div>
      <div class="progress" aria-hidden="true">${progress}</div></div>
    ${pickList()}${packingControls()}`;
  document.getElementById("dashboard-events").innerHTML = eventList(demo.events.slice(-3));
}

function shippingProgress(step) {
  const stages = ["주문 접수", "택배 상품 준비", "발송 대기", "발송 완료", "배송 완료"];
  return `<ol class="pipeline" aria-label="배송 진행 단계">${stages.map((name, i) => {
    const active = i === step ? 'class="current" aria-current="step"' : "";
    return `<li ${active} ${i > 2 ? 'aria-disabled="true"' : ""}>${name}${i > 2 ? " · 비활성" : ""}</li>`;
  }).join("")}</ol>`;
}

function orders() {
  const rows = [[button("select-123", "#123", "link"), "홍길동", badge(orderStatus(), demo.paused ? "amber" : ""), "3개"]];
  if (demo.extraOrder) rows.push([button("select-124", "#124", "link"), "홍길동", badge("주문 접수", "neutral"), "3개"]);
  const pending = selectedOrder === 124 && demo.extraOrder;
  const items = pending
    ? table(["주문 품목", "수량"], orderItems().map(p => [escapeHtml(p.name), "1" + escapeHtml(p.unit)]))
    : pickList();
  return panel("주문 목록", table(["주문 번호", "주문자", "상태", "주문 수량"], rows), button("new-order", icon("mic") + "음성 주문 예시")) +
    panel("주문 #" + (pending ? 124 : 123), `<div class="pad stack">
      ${shippingProgress(pending ? 0 : isPacked() ? 2 : 1)}
      ${facts([["주문자", "홍길동"], ["박스 RFID", pending ? "판독 대기" : "E2-34-08-A1"], ["포장 수량", (pending ? 0 : demo.packed) + " / 3"]])}
      ${items}${pending ? '<p class="meta">다음 박스의 RFID 판독 대기</p>' : packingControls()}
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
  const rows = demo.products.map((p, i) => [button("sku-" + i, escapeHtml(p.name), "link"),
    `<span class="mono">${escapeHtml(p.sku)}</span>`, p.stock, reserved(i), p.stock - reserved(i), escapeHtml(p.bin)]);
  const product = demo.products[productIndex];
  const add = form === "product" ? editForm("product", [
    field("상품명", "name"), field("단위", "unit", "개"),
    field("입고 수량", "stock", 1, 'type="number" min="0" max="9999"'), field("보관 위치", "bin")
  ]) : "";
  const adjust = form === "adjust" ? editForm("adjust", [
    field("실사한 보유 수량", "stock", product.stock, `type="number" min="${reserved(productIndex)}" max="9999"`)
  ]) : "";
  return panel("상품 재고", add + table(["상품명", "SKU", "보유", "예약", "가용", "위치"], rows), button("add-product", icon("plus") + "상품 등록")) +
    panel(product.name, `<div class="pad stack">${facts([["음성 별칭", product.alias], ["수량 단위", product.unit], ["예시 학습 클래스", product.label || "미등록"]])}
      <div class="buttons">${button("adjust", "재고 수량 조정")}<a class="link" href="/training#collect">모델 학습 열기 ${icon("arrow-right")}</a></div></div>` + adjust);
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
      ${facts([["박스 RFID", person.uid || "미연결"], ["접수 주문", customerIndex === 0 ? (demo.extraOrder ? "#123, #124" : "#123") : "없음"]])}
      <div class="buttons">${button("edit-rfid", person.uid ? "RFID 변경" : "RFID 연결", "", locked)}
        ${person.uid ? button("unlink-rfid", "연결 해제", "", locked) : ""}
        ${customerIndex === 0 ? button("order-detail", "주문 상세 " + icon("arrow-right"), "link") : ""}</div>
      ${locked ? '<p class="meta">패킹 중인 박스의 RFID는 작업 완료 후 변경할 수 있습니다.</p>' : ""}
    </div>` + edit);
}

function logs() {
  const filters = [["작업", "작업 이력"], ["음성", "대화 기록"]].map(([kind, label]) =>
    `<button type="button" data-action="log-${kind}" aria-pressed="${logKind === kind}">${label}</button>`).join("");
  const items = demo.events.filter(([, kind]) => kind === logKind);
  return `<div class="tabs" role="group" aria-label="기록 구분">${filters}</div>` +
    panel(logKind === "음성" ? "대화 기록" : "작업 이력", eventList(items), badge("스테이션 01", "neutral"));
}

const voiceCommands = {
  "query-stock": ["재고 파악해줘", () => orderItems().map((p, i) =>
    p.name + " " + (p.stock - reserved(i)) + p.unit).join(", ") + " 주문 가능합니다."],
  "query-order": ["주문 내역 알려줘", () =>
    "홍길동님의 123번 주문은 과자 1봉, 음료수 1캔, 휴지 1개입니다. 현재 " + demo.packed +
    "개를 담았습니다." + (demo.extraOrder ? " 추가 주문 124번은 접수 상태입니다." : "")],
  "cmd-stop": ["멈춰", () => setPaused(true)],
  "cmd-go": ["피킹 시작해줘", () => setPaused(false)],
  "cmd-order": ["과자·음료수·휴지 하나씩 주문해줘", () => demo.extraOrder
    ? "같은 예시 주문이 124번으로 접수되어 있습니다." : "홍길동님, 과자 1봉, 음료수 1캔, 휴지 1개로 주문할까요?"]
};

function renderVoice() {
  const voicePanel = document.getElementById("voice-panel");
  voicePanel.hidden = !voiceOpen;
  root.querySelector(".voice").setAttribute("aria-expanded", String(voiceOpen));
  if (!voiceOpen) return;
  const commands = Object.entries(voiceCommands).map(([id, [label]]) => button(id, label)).join("");
  const confirm = confirmingOrder ? `<div class="buttons">${button("confirm-order", "네, 주문해줘", "main-btn")}${button("discard-order", "취소")}</div>` : "";
  voicePanel.innerHTML = `<div class="row"><h3>예시 명령</h3>${button("voice", "닫기", "link")}</div>
    <div class="buttons">${commands}</div>
    <p class="reply" role="status">${escapeHtml(reply || "명령을 선택하면 시뮬레이션 응답을 확인할 수 있습니다.")}</p>${confirm}`;
}

function runCommand(action) {
  const [command, respond] = voiceCommands[action];
  record("음성", "사용자", command);
  reply = respond();
  record("음성", "시스템", reply);
  confirmingOrder = action === "cmd-order" && !demo.extraOrder;
  saveDemo();
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
  renderVoice();
  if (page.id === "dashboard") {
    renderDashboard();
  } else {
    disconnectCamera();
    view.innerHTML = pages[page.id]();
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
  voice() {
    voiceOpen = !voiceOpen;
    reply = "";
    confirmingOrder = false;
  },
  "new-order"() {
    voiceOpen = true;
    runCommand("cmd-order");
  },
  "confirm-order"() {
    if (!confirmingOrder || demo.extraOrder) return;
    demo.extraOrder = true;
    confirmingOrder = false;
    reply = "124번 주문을 접수했습니다.";
    record("음성", "사용자", "네, 주문해줘.");
    record("작업", "주문", "주문 #124 접수 · 홍길동 · 품목 3개");
    record("음성", "시스템", reply);
    saveDemo();
    showOrder(124);
  },
  "discard-order"() {
    confirmingOrder = false;
    reply = "추가 주문을 취소했습니다.";
    record("음성", "시스템", reply);
    saveDemo();
  },
  toggle() {
    announce(setPaused(!demo.paused));
    saveDemo();
  },
  advance() {
    announce(packNext());
    saveDemo();
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
  cancel() { form = ""; }
};

root.addEventListener("click", event => {
  const control = event.target.closest("button[data-action]");
  if (!control || control.disabled) return;
  const action = control.dataset.action;
  if (Object.hasOwn(voiceCommands, action)) runCommand(action);
  else if (Object.hasOwn(actions, action)) actions[action]();
  else if (action.startsWith("sku-")) { productIndex = Number(action.slice(4)); form = ""; }
  else if (action.startsWith("person-")) { customerIndex = Number(action.slice(7)); form = ""; }
  else if (action.startsWith("log-")) logKind = action.slice(4);
  else return;
  render();
  const firstField = view.querySelector("form input");
  if (firstField) firstField.focus();
  else {
    const nextControl = root.querySelector(`[data-action="${CSS.escape(action)}"]:not(:disabled)`);
    if (nextControl && !nextControl.closest("[hidden]")) nextControl.focus({ preventScroll: true });
  }
});

root.addEventListener("input", event => {
  if (event.target instanceof HTMLInputElement) event.target.setCustomValidity("");
});

root.addEventListener("submit", event => {
  const editor = event.target.closest("form[data-edit]");
  if (!editor) return;
  event.preventDefault();
  const values = Object.fromEntries([...new FormData(editor)].map(([key, value]) => [key, value.trim()]));
  for (const [name, value] of Object.entries(values)) {
    if (!value) {
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
  } else if (kind === "product") {
    productIndex = demo.products.length;
    const sku = "IT-" + String(productIndex + 1).padStart(3, "0");
    demo.products.push({ sku, name: values.name, alias: values.name, unit: values.unit,
      bin: values.bin, stock: Number(values.stock), label: "" });
  } else if (kind === "adjust") {
    const product = demo.products[productIndex];
    product.stock = Number(values.stock);
    record("작업", "재고", product.name + " 보유 수량 조정 · " + product.stock + product.unit);
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
