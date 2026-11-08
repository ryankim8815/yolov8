const axes = ["X (mm)", "Y (mm)", "Z (mm)", "A (°)", "B (°)", "C (°)"];
let canRead = false;
let serverAvailable = false;

function createEditor(name, title) {
  const form = document.getElementById("work-point-template").content.firstElementChild.cloneNode(true);
  const heading = form.querySelector("h3");
  heading.id = "work-point-" + name;
  heading.textContent = title;
  form.setAttribute("aria-labelledby", heading.id);
  const read = form.querySelector("[data-read]");
  const reset = form.querySelector("[data-reset]");
  const save = form.querySelector('[type="submit"]');
  const state = form.querySelector("[data-state]");
  const feedback = form.querySelector('[role="status"]');
  const fields = axes.map(axis => {
    const label = document.createElement("label");
    label.textContent = axis;
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.required = true;
    input.placeholder = "—";
    label.append(input);
    form.querySelector(".pose-fields").append(label);
    return input;
  });
  document.getElementById("work-points").append(form);

  let point = null, dirty = false, revision = null, pending = false, locked = false;
  function update() {
    const conflict = dirty && revision !== point?.revision;
    state.textContent = !point ? "조회 중" : locked ? "박스 이송 작업 중" : conflict ? "다른 화면에서 변경됨" : dirty ? "저장 전" :
      point.pose ? "저장됨 · " + new Date(point.updated_at).toLocaleString("ko-KR") : "미설정";
    fields.forEach(input => { input.disabled = !point || pending || locked; });
    read.disabled = !point || !canRead || pending || conflict || locked;
    reset.hidden = !dirty;
    reset.disabled = pending;
    save.disabled = !serverAvailable || !dirty || pending || conflict || locked;
  }
  function fill(values) {
    fields.forEach((input, i) => { input.value = values?.[i] ?? ""; });
  }
  function edit() {
    if (!dirty) revision = point.revision;
    dirty = true;
    feedback.textContent = "";
    update();
  }
  form.addEventListener("input", edit);
  reset.addEventListener("click", () => {
    dirty = false;
    fill(point.pose);
    feedback.textContent = "";
    update();
  });

  async function request(capture) {
    if ((capture ? read : save).disabled) return;
    if (capture && !dirty) revision = point.revision;
    pending = true;
    feedback.textContent = capture ? "제어기에서 현재 위치를 읽는 중…" : "좌표 저장 중…";
    update();
    try {
      const url = "/api/robot/work-points/" + (capture ? "current" : name);
      const result = await fetch(url, capture ? {cache: "no-store"} : {
        method: "PUT", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({revision, pose: fields.map(input => input.valueAsNumber)})
      });
      const data = await result.json();
      if (!result.ok) throw new Error(typeof data.detail === "string" ? data.detail : "여섯 좌표의 입력값을 확인하세요.");
      if (capture) {
        dirty = true;
        fill(data.pose);
        feedback.textContent = "현재 위치를 불러왔습니다. 값을 확인하고 좌표 저장을 누르세요.";
      } else {
        point = data;
        dirty = false;
        fill(point.pose);
        feedback.textContent = title + " 저장 완료.";
      }
    } catch (error) {
      feedback.textContent = error instanceof TypeError || error instanceof SyntaxError
        ? "웹 서버에 연결할 수 없습니다. 입력값을 유지합니다." : error.message;
    } finally {
      pending = false;
      if (!dirty) fill(point.pose);
      update();
    }
  }
  read.addEventListener("click", () => void request(true));
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (form.reportValidity()) void request(false);
  });
  update();
  return function render(next, inUse) {
    locked = inUse;
    // A poll started before a successful save may deliver an older revision.
    if (next && (!point || (next.updated_at || "") >= (point.updated_at || "")) &&
        (!point || point.revision !== next.revision)) {
      point = next;
      if (!dirty && !pending) fill(point.pose);
    }
    update();
  };
}

const editors = {
  waypoint: createEditor("waypoint", "박스 이송 경유점"),
  box: createEditor("box", "택배 박스 위치"),
  shipping_label: createEditor("shipping_label", "택배 박스의 송장 위치 (RFID 스캔)")
};

export function renderWorkPoints(data, {paused, apiUnavailable}) {
  serverAvailable = !apiUnavailable;
  canRead = serverAvailable && !paused && data.bridge_connected &&
    data.topics.some(topic => topic.kind === "monitor_joints" && topic.state === "live");
  document.getElementById("work-point-source").textContent = canRead
    ? "현재 위치를 불러올 수 있습니다. 공구를 원하는 위치에 멈춘 뒤 불러오세요."
    : apiUnavailable ? "웹 서버 응답 대기 중입니다." : paused ? "현재 위치를 불러오려면 화면 표시를 재개하세요."
    : "현재 위치를 불러오려면 읽기 전용 관절 모니터 연결이 필요합니다. 수동 입력은 가능합니다.";
  for (const [key, render] of Object.entries(editors)) render(data.work_points?.[key], key !== "shipping_label" && data.transfer_active);
}
