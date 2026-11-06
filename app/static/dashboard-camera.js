import { watchDetections } from "./detection-feed.js";

function createClassSummary(fields) {
  const buttons = new Map();
  let groups = new Map();
  let selected = null;
  let frameSize = null;
  let waiting = true;

  function drawBoxes(layer, objects) {
    while (layer.children.length > objects.length) layer.lastElementChild.remove();
    objects.forEach(({ xyxy }, i) => {
      let rect = layer.children[i];
      if (!rect) {
        rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("vector-effect", "non-scaling-stroke");
        layer.append(rect);
      }
      const [left, top, right, bottom] = xyxy;
      rect.setAttribute("x", left);
      rect.setAttribute("y", top);
      rect.setAttribute("width", right - left);
      rect.setAttribute("height", bottom - top);
    });
  }

  function showSelection() {
    const objects = groups.get(selected) || [];
    for (const [label, button] of buttons) {
      const pressed = String(label === selected);
      if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
    }
    fields.overlay.toggleAttribute("hidden", !objects.length || !frameSize);
    if (objects.length && frameSize) {
      fields.overlay.setAttribute("viewBox", `0 0 ${frameSize.width} ${frameSize.height}`);
    }
    drawBoxes(fields.cutouts, objects);
    drawBoxes(fields.outlines, objects);
    let detail = "";
    if (objects.length) {
      const scores = objects.map(o => Math.round(o.confidence * 100) + "%");
      detail = selected + " · 탐지 신뢰도 " + scores.join(", ");
    } else if (!groups.size) {
      detail = waiting ? "탐지 결과 대기 중" : "탐지된 객체가 없습니다.";
    }
    if (fields.detail.textContent !== detail) fields.detail.textContent = detail;
    fields.detail.hidden = !detail;
  }

  function selectClass(event) {
    const chip = event.target.closest("button[data-label]");
    if (!chip) return;
    selected = selected === chip.dataset.label ? null : chip.dataset.label;
    showSelection();
  }
  fields.chips.addEventListener("click", selectClass);

  function update(packet) {
    waiting = !packet;
    frameSize = packet?.source_size;
    groups = new Map();
    for (const object of packet?.objects || []) {
      if (!groups.has(object.label)) groups.set(object.label, []);
      groups.get(object.label).push(object);
    }
    for (const [name, button] of buttons) {
      if (!groups.has(name)) { button.remove(); buttons.delete(name); }
    }
    if (!groups.has(selected)) selected = null;
    // Stable buttons keep pointer and keyboard targets in place when confidence order changes.
    [...groups.keys()].sort().forEach((name, index) => {
      let button = buttons.get(name);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.dataset.label = name;
        const label = document.createElement("span");
        label.textContent = name;
        button.append(label, document.createElement("small"));
        buttons.set(name, button);
      }
      const quantity = groups.get(name).length;
      const text = "×" + quantity;
      if (button.lastElementChild.textContent !== text) {
        button.lastElementChild.textContent = text;
        button.setAttribute("aria-label", name + " " + quantity + "개 강조");
      }
      const atIndex = fields.chips.children[index];
      if (atIndex !== button) fields.chips.insertBefore(button, atIndex || null);
    });
    fields.classCount.textContent = waiting ? "—" : groups.size + "종";
    showSelection();
  }
  return { update, dispose: () => fields.chips.removeEventListener("click", selectClass) };
}

export function connectDashboardCamera(panel) {
  const fields = Object.fromEntries([...panel.querySelectorAll("[data-camera]")].map(node => [node.dataset.camera, node]));
  const classes = createClassSummary(fields);
  const stop = watchDetections({
    image: fields.image,
    matchedPreview: true,
    onStatus(status, label, reset) {
      if (fields.state.textContent !== label) fields.state.textContent = label;
      fields.state.classList.toggle("ready", status.ready);
      fields.fps.textContent = status.ready ? status.fps?.detected?.toFixed(1) ?? "—" : "—";
      fields.latency.textContent = status.ready ? status.capture_to_result_ms?.p95?.toFixed(0) ?? "—" : "—";
      fields.settings.hidden = !["camera_off", "camera_unavailable", "error"].includes(status.state);
      const size = status.camera?.actual_size;
      if (fields.image.hidden && size?.width && size?.height) {
        fields.image.parentElement.style.aspectRatio = size.width + "/" + size.height;
      }
      if (reset) {
        classes.update(null);
        fields.empty.hidden = false;
        fields.message.textContent = status.last_error || (status.ready ? "첫 영상 프레임 수신 대기" : label);
        fields.count.textContent = "—";
        fields.caption.textContent = "";
        fields.caption.hidden = true;
      }
    },
    onDetections(packet) {
      classes.update(packet);
      fields.image.parentElement.style.aspectRatio = packet.source_size.width + "/" + packet.source_size.height;
      fields.count.textContent = String(packet.objects.length);
      fields.caption.textContent = [packet.model_version || packet.model, "탐지 #" + packet.frame_id].filter(Boolean).join(" · ");
      fields.caption.hidden = fields.image.hidden;
    },
    onPreview(visible) {
      fields.empty.hidden = visible;
      fields.caption.hidden = !visible || !fields.caption.textContent;
      if (!visible) {
        fields.message.textContent = "영상 연결을 다시 시도합니다.";
        fields.count.textContent = "—";
        classes.update(null);
      }
    }
  });
  return () => {
    stop();
    classes.dispose();
  };
}
