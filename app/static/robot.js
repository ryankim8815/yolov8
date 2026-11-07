import "./station-nav.js";
import {renderPoseTests} from "./robot-poses.js";

const get = id => document.getElementById(id);
const states = {
  unconfigured: "수신 설정 대기", offline: "브리지 연결 대기", waiting: "관절 수신 대기",
  no_publisher: "관절 발행자 없음", live: "관절 수신 중", monitoring: "관절 수신 중 · 읽기 전용",
  stale: "관절 수신 지연", robot_disconnected: "로봇 연결 끊김"
};
const topicStates = {waiting: "대기", no_publisher: "발행자 없음", unavailable: "구독 오류", live: "수신", stale: "지연", listening: "이벤트 대기", received: "이벤트 수신"};
let selectedTopic = null;
let topicChosen = false;
let paused = false;
let latest = null;
let requestController = null;
let stopped = false;
let apiUnavailable = false;
let configSignature = "";
let topicSignature = "";

const timeText = value => value ? new Date(value).toLocaleTimeString("ko-KR", {hour12: false}) : "—";
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function renderConfig(config) {
  const signature = JSON.stringify(config);
  if (signature === configSignature) return;
  configSignature = signature;
  const localBridge = config.ros_pc_ip.startsWith("127.") || config.ros_pc_ip === "::1";
  get("bridge-path").textContent = localBridge ? "로컬 · WS" : "LAN · WS";
  get("bridge-host").textContent = localBridge ? "로컬 ROS 2" : "ROS 2 컨트롤러";
  get("robot-endpoint").textContent = `E0509 제어기 · ${config.ip} · TCP ${config.port}`;
  get("bridge-port").textContent = config.rosbridge_port;
  const entries = [
    ["E0509 제어기 IP", config.ip, "ROBOT_IP"], ["E0509 제어기 TCP 포트", config.port, "ROBOT_PORT"],
    ["rosbridge 호스트 IP", config.ros_pc_ip || "미설정", "ROBOT_ROS_PC_IP"],
    ["rosbridge 수신 포트", config.rosbridge_port, "ROBOT_ROSBRIDGE_PORT"],
    ["ROS 2 네임스페이스", config.namespace, "ROBOT_NAMESPACE"]
  ];
  get("robot-config").replaceChildren(...entries.map(([label, value, env]) => {
    const row = element("div"), details = element("dd", value);
    details.append(element("code", env));
    row.append(element("dt", label), details);
    return row;
  }));
  get("robot-env").textContent = [
    `ROBOT_IP=${config.ip}`, `ROBOT_PORT=${config.port}`, `ROBOT_NAMESPACE=${config.namespace}`,
    `ROBOT_ROS_PC_IP=${config.ros_pc_ip}`, `ROBOT_ROSBRIDGE_PORT=${config.rosbridge_port}`,
    `ROBOT_STALE_SECONDS=${config.stale_seconds}`
  ].join("\n");
}

function renderTopics(topics) {
  const signature = topics.map(topic => topic.name).join("|");
  if (signature !== topicSignature) {
    topicSignature = signature;
    if (!topics.some(topic => topic.name === selectedTopic)) selectedTopic = topics[0]?.name;
    get("robot-topics").replaceChildren(...topics.map(topic => {
      const button = element("button", undefined, "robot-topic");
      button.type = "button";
      button.dataset.topic = topic.name;
      const identity = element("span");
      identity.append(element("b", topic.name), element("small", topic.type));
      button.append(identity, element("span", "—", "robot-topic-rate"), element("span", "대기", "robot-topic-status"));
      button.addEventListener("click", () => { topicChosen = true; selectedTopic = topic.name; render(latest); });
      return button;
    }));
  }
  const buttons = get("robot-topics").children;
  topics.forEach((topic, index) => {
    const button = buttons[index];
    button.setAttribute("aria-pressed", String(topic.name === selectedTopic));
    button.querySelector(".robot-topic-rate").textContent = topic.kind === "event" ? "이벤트" : topic.hz === null ? "—" : topic.hz.toFixed(1);
    const status = button.querySelector(".robot-topic-status");
    status.textContent = apiUnavailable ? "확인 불가" : topicStates[topic.state] || "대기";
    status.dataset.state = apiUnavailable ? "waiting" : topic.state;
    if (apiUnavailable && topic.kind !== "event") button.querySelector(".robot-topic-rate").textContent = "—";
  });
  const topic = topics.find(topic => topic.name === selectedTopic);
  get("selected-topic").textContent = topic?.name || "토픽 선택";
  get("message-time").textContent = timeText(topic?.received_at);
  get("robot-message").textContent = topic?.message ? JSON.stringify(topic.message, null, 2) : "메시지 수신 대기 중";
}

function render(data) {
  if (!data) return;
  renderPoseTests(data, {paused, apiUnavailable});
  renderConfig(data.config);
  const joint = data.topics.find(topic => topic.name === data.display_joint_topic) || data.topics[0];
  if (!topicChosen) selectedTopic = joint.name;
  const names = joint.message?.name || [];
  const positions = joint.message?.position || [];
  const live = !apiUnavailable && ["live", "monitoring"].includes(data.state);
  get("robot-state").textContent = apiUnavailable ? "서버 응답 없음" : states[data.state] || "연결 상태 확인 중";
  get("robot-state").dataset.state = apiUnavailable ? "offline" : data.state;
  get("robot-hz").textContent = live && joint.hz !== null ? joint.hz.toFixed(1) : "—";
  get("robot-axis-count").textContent = live ? names.length : "—";
  get("robot-received").textContent = timeText(joint.received_at);
  get("joint-age").textContent = joint.received_at ?
    `${live ? "최근 수신" : "마지막 수신값"} · ${joint.age_seconds.toFixed(1)}초 전 · °` : "수신 대기 · °";
  get("robot-joints").replaceChildren(...Array.from({length: 6}, (_, index) => {
    const item = element("div", undefined, "robot-joint");
    item.append(element("span", names[index] || `J${index + 1}`));
    const value = positions[index];
    const number = element("strong", Number.isFinite(value) ? (value * 180 / Math.PI).toFixed(1) : "—");
    number.append(element("small", "°"));
    item.append(number);
    return item;
  }));
  const notices = {
    unconfigured: "Mac의 .env에 rosbridge 호스트 IP(ROBOT_ROS_PC_IP)를 설정하고 서버를 다시 시작하세요.",
    offline: "rosbridge 연결을 시도하고 있습니다. 호스트 IP와 rosbridge 실행 상태를 확인하세요.",
    waiting: data.joint_publishers?.length ? `관절 발행자 ${data.joint_publishers.join(", ")}에서 첫 메시지를 기다리고 있습니다.` :
      "rosbridge 연결 완료. 관절 토픽의 발행자를 확인하고 있습니다.",
    no_publisher: `rosbridge의 ROS 그래프에서 ${joint.name} 발행자가 0개입니다. 두산 드라이버, ROS 도메인과 네임스페이스를 확인하세요.`,
    live: "ROS 2 관절 데이터를 수신하고 있습니다.",
    monitoring: `E0509 제어기의 실제 관절각을 ${joint.name}에서 수신하고 있습니다. 자세 이동은 두산 드라이버 연결 후 사용할 수 있습니다.`,
    stale: "관절 데이터 갱신이 멈췄습니다. 마지막 수신값을 표시합니다.",
    robot_disconnected: "드라이버에서 로봇 연결 끊김 이벤트를 수신했습니다. LAN 케이블과 컨트롤러를 확인하세요."
  };
  get("robot-notice").textContent = paused ? "표시를 일시정지했습니다. 재개하면 최신 수신값을 불러옵니다." :
    apiUnavailable ? "모니터링 서버의 응답을 기다리고 있습니다. 마지막 수신값을 표시합니다." :
    data.error || notices[data.state] || "연결 상태 확인 중";
  get("robot-notice").dataset.warning = String(Boolean(data.error) || ["no_publisher", "stale", "robot_disconnected"].includes(data.state));
  renderTopics(data.topics);
}

async function refresh() {
  if (stopped || paused || document.hidden || requestController) return;
  const controller = new AbortController();
  requestController = controller;
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch("/api/robot/status", {cache: "no-store", signal: controller.signal});
    if (!response.ok) throw new Error("status unavailable");
    const data = await response.json();
    if (stopped || paused) return;
    latest = data;
    apiUnavailable = false;
    get("robot-api-error").hidden = true;
    render(data);
  } catch {
    if (stopped || paused) return;
    apiUnavailable = true;
    get("robot-api-error").textContent = "모니터링 서버의 응답이 없습니다. 표시된 값은 마지막 수신값입니다.";
    get("robot-api-error").hidden = false;
    if (latest) render(latest);
    else get("robot-state").textContent = "서버 응답 없음";
  } finally {
    clearTimeout(timeout);
    if (requestController === controller) requestController = null;
  }
}
get("connection-settings").addEventListener("click", () => {
  const panel = get("robot-settings");
  panel.hidden = !panel.hidden;
  get("connection-settings").setAttribute("aria-expanded", String(!panel.hidden));
});
get("robot-pause").addEventListener("click", () => {
  paused = !paused;
  get("robot-pause").textContent = paused ? "표시 재개" : "표시 일시정지";
  get("robot-pause").setAttribute("aria-pressed", String(paused));
  if (paused) get("robot-notice").textContent = "표시를 일시정지했습니다. 재개하면 최신 수신값을 불러옵니다.";
  else refresh();
  if (latest) renderPoseTests(latest, {paused, apiUnavailable});
});
window.addEventListener("pagehide", () => { stopped = true; requestController?.abort(); });
window.addEventListener("pageshow", () => { stopped = false; refresh(); });
document.addEventListener("visibilitychange", refresh);
setInterval(refresh, 1000);
refresh();
