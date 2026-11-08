import { connectOrientation } from "./gripper-orientation.js";
import { describeGripper, trackGripperEstimate } from "./gripper-measurement.js";

// The bitmap is drawn with object-fit: contain. Ignore clicks in its letterbox.
export function imagePixel(rect, size, clientX, clientY) {
  const scale = Math.min(rect.width / size.width, rect.height / size.height);
  if (!scale) return null;
  const x = (clientX - rect.left - (rect.width - size.width * scale) / 2) / scale;
  const y = (clientY - rect.top - (rect.height - size.height * scale) / 2) / scale;
  return x >= 0 && y >= 0 && x < size.width && y < size.height ? [x, y] : null;
}

const axes = ["X", "Y", "Z", "A", "B", "C"];
const units = ["mm", "mm", "mm", "°", "°", "°"];
const motionKey = "vision-last-camera-pick";

async function api(path, method = "GET", body, signal) {
  const response = await fetch("/api/robot/" + path, {method, signal, cache: "no-store",
    headers: body ? {"Content-Type": "application/json"} : {}, body: body && JSON.stringify(body)});
  let data;
  try { data = await response.json(); } catch { throw new Error("로봇 웹 서버에 연결할 수 없습니다."); }
  if (!response.ok) {
    const error = new Error(typeof data.detail === "string" ? data.detail : "입력한 좌표와 연결 상태를 확인하세요.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function center(obj) {
  const [x1, y1, x2, y2] = obj.xyxy;
  return [(x1 + x2) / 2, (y1 + y2) / 2];
}

function marker(ctx, x, y, r, color) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "#142d29";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function sameInput(packet, original) {
  return packet && original && ["session_id", "model_version", "camera_id", "camera_generation"].every(k => packet[k] === original[k])
    && packet.source_size.width === original.source_size.width && packet.source_size.height === original.source_size.height;
}

export function connectCameraPick(panel) {
  const el = Object.fromEntries([...panel.querySelectorAll("[data-pick]")].map(node => [node.dataset.pick, node]));
  const lifetime = new AbortController();
  const on = (node, type, handler) => node.addEventListener(type, handler, {signal: lifetime.signal});
  let live = null, frozen = null, mode = "", selected = -1, calibration, corners, savedCorners, corner = 0;
  let clearance, measureIndex = -1;
  let approval, expiryTimer, pending = false, moveId = sessionStorage.getItem(motionKey);
  let pollTimer, disposed = false;
  const fields = axes.slice(0, 3).map((axis, index) => {
    const label = document.createElement("label"), input = document.createElement("input");
    label.textContent = axis + " (" + units[index] + ")";
    input.type = "number"; input.step = "any";
    label.append(input); el.fields.append(label);
    on(input, "input", () => {
      corners[corner].pose[index] = Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : null;
      showPosition(); showOrientation(); updateSave();
    });
    return input;
  });
  const orientation = connectOrientation(el, (index, value, input) => {
    corners[0].pose[3 + index] = value;
    showOrientation(input);
    updateSave();
  }, lifetime.signal);
  const measurement = trackGripperEstimate(
    (body, signal) => api("pick/gripper-preview", "POST", body, signal),
    estimate => {
      el.sizing.textContent = describeGripper(estimate);
      orientation.setEstimate(estimate);
    });

  function draftCalibration() {
    if (!calibration || !Number.isFinite(clearance) || clearance < 0 || !corners.every((p,i) =>
      p.pixel && p.pose.slice(0,i === 0 ? 6 : 3).every(Number.isFinite))) return null;
    return {...calibration, clearance_per_side_mm:clearance,
      corners:corners.map(p => ({pixel:p.pixel, pose:[...p.pose.slice(0,3),...corners[0].pose.slice(3)]}))};
  }

  function updateMeasurement() {
    const {objects} = frozen.packet;
    const object = objects[measureIndex];
    const draft = draftCalibration();
    let reason = null;
    if (!objects.length) reason = "고정된 영상에 탐지된 객체가 없습니다.";
    else if (!object) reason = "손가락 치수에서 측정할 탐지 객체를 선택하세요.";
    else if (!Number.isFinite(clearance) || clearance < 0) reason = "한쪽 여유를 0 이상의 mm 값으로 입력하세요.";
    else if (!draft) reason = "네 모서리의 영상·BASE 좌표와 공구 방향을 입력하세요.";
    measurement.update(draft, object, measureIndex, reason);
  }

  function showOrientation(editing) {
    // The preview belongs to this frozen input even while calibration is loading.
    const packet = frozen.packet;
    updateMeasurement();
    orientation.render(corners, corner, pending || !calibration, {camera_id:packet.camera_id, ...packet.source_size}, editing);
  }

  function controls() {
    el.select.disabled = !live?.packet.objects.length || Boolean(moveId);
    el.teach.disabled = !live || Boolean(moveId);
  }

  function changeMode(next) {
    mode = next;
    const teaching = next === "calibration";
    el.dialog.classList.toggle("teaching", teaching);
    for (const node of [el.teachIcon, el.model, el.close, el.discard]) node.hidden = !teaching;
    el.cancel.hidden = teaching;
    (teaching ? el.planeFrame : el.selectionFrame).append(el.photo);
    el.title.textContent = {calibration: "작업 평면 보정", candidates: "파지 대상 선택", confirmation: "파지 위치 승인"}[next];
    for (const key of ["calibration", "candidates", "confirmation"]) el[key].hidden = key !== next;
    el.save.hidden = next !== "calibration";
    el.preview.hidden = next !== "candidates";
    el.approve.hidden = next !== "confirmation";
    el.note.textContent = "";
  }

  function draw() {
    if (!frozen?.photo) return;
    const {packet, photo} = frozen, canvas = el.photo;
    canvas.width = packet.source_size.width; canvas.height = packet.source_size.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(photo, 0, 0, canvas.width, canvas.height);
    const radius = Math.max(5, canvas.width / 150);
    if (mode === "calibration") {
      if (corners.every(p => p.pixel)) {
        ctx.beginPath();
        corners.forEach(({pixel}, i) => i ? ctx.lineTo(...pixel) : ctx.moveTo(...pixel));
        ctx.closePath();
        ctx.strokeStyle = "#a0ffcf"; ctx.lineWidth = 2; ctx.stroke();
      }
      corners.forEach((p, i) => {
        if (!p.pixel) return;
        const [x, y] = p.pixel;
        marker(ctx, x, y, radius, i === corner ? "#ffcf61" : "#a0ffcf");
        ctx.font = "bold " + Math.max(16, radius * 3) + "px sans-serif";
        ctx.lineWidth = 4; ctx.strokeStyle = "#18302b"; ctx.fillStyle = "white";
        ctx.strokeText(String(i + 1), x + radius, y); ctx.fillText(String(i + 1), x + radius, y);
      });
    }
    const index = mode === "calibration" ? measureIndex : selected;
    const highlight = context => {
      if (index < 0) return;
      const obj = packet.objects[index], [x1,y1,x2,y2] = obj.xyxy;
      context.strokeStyle = "#80ffd0"; context.lineWidth = 4; context.strokeRect(x1,y1,x2-x1,y2-y1);
      marker(context,...center(obj),radius,"#ffcf61");
    };
    highlight(ctx);
    if (mode === "calibration") {
      const sample = el.measurePhoto;
      sample.width = canvas.width; sample.height = canvas.height;
      const sampleContext = sample.getContext("2d");
      sampleContext.drawImage(photo,0,0,sample.width,sample.height);
      highlight(sampleContext);
    }
  }

  function updateSave() {
    const dirty = clearance !== (calibration?.clearance_per_side_mm ?? 5) || JSON.stringify(corners) !== JSON.stringify(savedCorners);
    el.discard.disabled = pending || !calibration || !dirty;
    el.save.disabled = el.discard.disabled || !draftCalibration();
    if (!pending && calibration) el.note.textContent = dirty ? "저장 전 변경 사항이 있습니다." :
      calibration.revision ? "저장된 작업 평면입니다." : "영상의 네 모서리를 둘레 순서로 교시하세요.";
  }

  const steps = Array.from({length: 4}, (_, i) => {
    const button = document.createElement("button");
    button.type = "button"; el.steps.append(button);
    on(button, "click", () => selectCorner(i));
    return button;
  });

  function selectCorner(i) {
    corner = i;
    if (!corners[i].pixel) el.position.open = true;
    showCorner();
  }

  function showPosition() {
    const point = corners[corner];
    el.positionTitle.textContent = (corner + 1) + "번 모서리 위치";
    el.xyzSummary.textContent = axes.slice(0, 3).map((axis, i) => axis + " " + (point.pose[i] ?? "—")).join("　") + " mm";
    el.pixel.textContent = point.pixel ? "영상 위치　" + point.pixel.map(n => n.toFixed(1)).join(", ") + " px" :
      (corner + 1) + "번 모서리를 영상에서 짚으세요.";
  }

  function showCorner() {
    steps.forEach((step, i) => {
      step.textContent = (i + 1) + "번 모서리" + (corners[i].pixel ? " ✓" : "");
      step.setAttribute("aria-pressed", String(i === corner));
      step.disabled = pending;
    });
    fields.forEach((field, i) => {
      field.value = corners[corner].pose[i] ?? "";
      field.disabled = pending || !calibration;
    });
    showPosition();
    showOrientation();
    el.clearance.disabled = pending || !calibration;
    el.read.disabled = !calibration || pending;
    draw(); updateSave();
  }

  function candidates(indices) {
    el.choices.replaceChildren(...indices.map(index => {
      const obj = frozen.packet.objects[index];
      return new Option(obj.label + " · " + Math.round(100 * obj.confidence) + "% · 중심 " +
        center(obj).map(Math.round).join(", ") + " px", String(index));
    }));
    selected = Number(el.choices.value);
    draw();
  }

  async function preview() {
    if (pending || !frozen) return;
    const snapshot = frozen;
    pending = true; el.preview.disabled = true; el.choices.disabled = true;
    el.note.textContent = "목표 좌표를 계산하고 있습니다.";
    try {
      const packet = snapshot.packet;
      const result = await api("pick/preview", "POST", {session_id: packet.session_id,
        frame_id: packet.frame_id, object_index: selected});
      if (frozen !== snapshot) { void cancelId(result.approval_id); return; }
      approval = result.approval_id;
      changeMode("confirmation");
      el.object.textContent = result.label + " · 신뢰도 " + Math.round(result.confidence * 100) + "%";
      el.confirmationSizing.textContent = describeGripper(result.gripper);
      el.target.replaceChildren(...result.pose.map((v, i) => {
        const cell = document.createElement("div"), dt = document.createElement("dt"), dd = document.createElement("dd");
        dt.textContent = "BASE " + axes[i]; dd.textContent = v.toFixed(2) + " " + units[i];
        cell.append(dt, dd); return cell;
      }));
      el.approve.disabled = Boolean(result.motion_reason);
      el.note.textContent = result.motion_reason || "선택한 좌표로 10 mm/s 직선 이동합니다. 이동 경로를 확인하세요.";
      expiryTimer = setTimeout(() => {
        el.approve.disabled = true; el.note.textContent = "승인이 만료되었습니다. 대상을 다시 선택하세요.";
      }, result.expires_in * 1000);
    } catch (error) {
      if (frozen === snapshot) el.note.textContent = error.message;
    } finally {
      if (frozen === snapshot) { pending = false; el.preview.disabled = false; el.choices.disabled = false; }
    }
  }

  async function open(next, indices = []) {
    if (!live || el.dialog.open || moveId) return;
    const snapshot = frozen = {...live};
    pending = false; approval = null; calibration = null; selected = -1; corner = 0;
    corners = Array.from({length: 4}, () => ({pixel: null, pose: Array(6).fill(null)}));
    savedCorners = structuredClone(corners);
    changeMode(next);
    el.preview.disabled = true; el.choices.disabled = true; el.approve.disabled = true;
    el.photo.width = snapshot.packet.source_size.width; el.photo.height = snapshot.packet.source_size.height;
    el.dialog.showModal();
    if (next === "calibration") {
      clearance = 5; el.clearance.value = clearance;
      const objects = snapshot.packet.objects;
      measureIndex = objects.length === 1 ? 0 : -1;
      el.measureObject.replaceChildren(new Option(objects.length ? "객체 선택" : "탐지된 객체 없음", "-1"),
        ...objects.map((obj,i) => new Option((i+1)+"번 · "+obj.label+" · 중심 "+center(obj).map(Math.round).join(", ")+" px",String(i))));
      el.measureObject.value = String(measureIndex);
      el.measureObject.disabled = !objects.length;
      el.position.open = true;
      el.frameSize.textContent = "탐지 영상 · " + el.photo.width + " × " + el.photo.height + " px";
      el.note.textContent = "작업 평면을 불러오고 있습니다.";
      showCorner();
    }
    const url = URL.createObjectURL(snapshot.jpeg);
    try {
      const photo = new Image(); photo.src = url; await photo.decode();
      if (frozen !== snapshot) return;
      snapshot.photo = photo;
      if (next === "calibration") {
        draw();
        const data = await api("pick/calibration");
        if (frozen !== snapshot) return;
        const c = data.camera, p = snapshot.packet;
        if (c.session_id !== p.session_id || c.camera_id !== p.camera_id || c.camera_generation !== p.camera_generation ||
            c.width !== p.source_size.width || c.height !== p.source_size.height) throw new Error("입력 영상이 바뀌었습니다. 보정을 다시 시작하세요.");
        calibration = data;
        clearance = data.clearance_per_side_mm ?? 5; el.clearance.value = clearance;
        if (data.corners.length) {
          savedCorners = data.corners;
          corners = structuredClone(savedCorners);
          el.position.open = false;
        }
        showCorner();
      } else {
        candidates(indices);
        el.choices.disabled = false; el.preview.disabled = false;
        if (indices.length === 1) await preview();
      }
    } catch (error) {
      if (frozen === snapshot) el.note.textContent = error.message;
    } finally { URL.revokeObjectURL(url); }
  }

  on(el.teach, "click", () => void open("calibration"));
  on(el.select, "click", () => void open("candidates", live.packet.objects.map((_, i) => i)));
  on(el.overlay, "click", event => {
    if (!live || moveId) return;
    const pixel = imagePixel(el.overlay.getBoundingClientRect(), live.packet.source_size, event.clientX, event.clientY);
    if (!pixel) return;
    const [x, y] = pixel;
    const hits = live.packet.objects.flatMap((obj, i) => {
      const [x1, y1, x2, y2] = obj.xyxy;
      return x >= x1 && x <= x2 && y >= y1 && y <= y2 ? [i] : [];
    });
    if (hits.length) void open("candidates", hits);
  });
  on(el.choices, "change", () => { selected = Number(el.choices.value); draw(); });
  on(el.measureObject, "change", () => {
    measureIndex = Number(el.measureObject.value); updateMeasurement(); draw();
  });
  on(el.clearance, "input", () => {
    clearance = Number.isFinite(el.clearance.valueAsNumber) ? el.clearance.valueAsNumber : null;
    updateMeasurement(); updateSave();
  });
  on(el.preview, "click", () => void preview());
  on(el.photo, "click", event => {
    if (mode !== "calibration" || !calibration || pending) return;
    const pixel = imagePixel(el.photo.getBoundingClientRect(), frozen.packet.source_size, event.clientX, event.clientY);
    if (pixel) { corners[corner].pixel = pixel; showCorner(); }
  });
  on(el.read, "click", async () => {
    const snapshot = frozen, index = corner;
    pending = true; showCorner();
    el.note.textContent = "현재 TCP 위치를 읽는 중입니다.";
    try {
      const data = await api("work-points/current");
      if (frozen === snapshot) {
        if (index === 0) corners[index].pose = data.pose;
        else corners[index].pose.splice(0, 3, ...data.pose.slice(0, 3));
      }
    } catch (error) {
      if (frozen === snapshot) { pending = false; showCorner(); el.note.textContent = error.message; }
      return;
    }
    if (frozen === snapshot) { pending = false; showCorner(); }
  });
  on(el.save, "click", async () => {
    if (el.save.disabled) return;
    const snapshot = frozen;
    pending = true; showCorner();
    el.note.textContent = "작업 평면을 저장하고 있습니다.";
    try {
      const saved = await api("pick/calibration", "PUT", draftCalibration());
      if (frozen !== snapshot) return;
      calibration = saved; savedCorners = saved.corners;
      clearance = saved.clearance_per_side_mm; el.clearance.value = clearance;
      corners = structuredClone(savedCorners);
      pending = false; showCorner();
      el.status.textContent = el.note.textContent = "작업 평면을 저장했습니다.";
    } catch (error) {
      if (frozen === snapshot) { pending = false; showCorner(); el.note.textContent = error.message; }
    }
  });
  on(el.editDirection, "click", () => selectCorner(0));
  on(el.discard, "click", () => {
    corners = structuredClone(savedCorners);
    clearance = calibration.clearance_per_side_mm ?? 5; el.clearance.value = clearance;
    showCorner();
    el.note.textContent = "변경 사항을 취소했습니다.";
  });
  on(el.close, "click", () => el.dialog.close());

  async function cancelId(id) {
    try { await api("pick/cancel", "POST", {approval_id: id}); } catch { /* Also expires on the server. */ }
  }
  function resetDialog() {
    measurement.reset();
    if (approval) void cancelId(approval);
    clearTimeout(expiryTimer); approval = null; frozen = null; pending = false;
  }
  on(el.cancel, "click", () => el.dialog.close());
  on(el.dialog, "close", resetDialog);

  async function pollMove() {
    if (!moveId || disposed) return;
    const id = moveId;
    try {
      const result = await api("pick/moves/" + id);
      if (disposed || id !== moveId) return;
      el.status.textContent = result.state === "unknown" ? "이동 결과 미확인 · " + result.message : result.message;
      if (!["checking", "moving"].includes(result.state)) {
        moveId = null; sessionStorage.removeItem(motionKey); controls(); return;
      }
    } catch (error) {
      if (disposed) return;
      el.status.textContent = "이동 결과 미확인 · " + error.message;
      if (error.status === 404) {
        moveId = null; sessionStorage.removeItem(motionKey); controls(); return;
      }
    }
    if (!disposed) pollTimer = setTimeout(pollMove, 1000);
  }

  on(el.approve, "click", async () => {
    if (!approval || el.approve.disabled) return;
    const id = approval;
    approval = null; el.approve.disabled = true;
    moveId = id; sessionStorage.setItem(motionKey, id); controls();
    el.dialog.close(); el.status.textContent = "승인한 대상의 현재 위치를 확인하고 있습니다.";
    try {
      await api("pick/approve", "POST", {approval_id: id});
    } catch (error) {
      if (disposed) return;
      if (error.status >= 400 && error.status < 500) {
        moveId = null; sessionStorage.removeItem(motionKey); controls();
        el.status.textContent = error.message; return;
      }
      el.status.textContent = "이동 결과 미확인 · " + error.message;
    }
    void pollMove();
  });

  function update(packet, jpeg) {
    live = packet?.display_mode === "detections" && jpeg ? {packet, jpeg} : null;
    if (frozen && !sameInput(live?.packet, frozen.packet)) {
      el.dialog.close(); resetDialog(); el.status.textContent = "카메라 입력이 변경되어 선택을 닫았습니다.";
    }
    el.overlay.hidden = !live;
    controls();
    if (!live) return;
    const canvas = el.overlay, {width, height} = packet.source_size;
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    for (const obj of packet.objects) marker(ctx, ...center(obj), Math.max(4, width / 220), "#a0ffcf");
    if (el.status.textContent === "탐지 영상 대기 중") el.status.textContent = "영상에서 파지할 객체를 선택하세요.";
  }
  if (moveId) void pollMove();
  return {update, dispose() {
    disposed = true; lifetime.abort(); clearTimeout(pollTimer);
    if (el.dialog.open) el.dialog.close();
    resetDialog();
  }};
}
