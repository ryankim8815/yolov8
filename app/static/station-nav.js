export const destinations = [
  { id: "dashboard", label: "대시보드", icon: "layout-dashboard" },
  { id: "orders", label: "주문·배송", icon: "package-check" },
  { id: "stock", label: "상품·재고", icon: "boxes" },
  { id: "people", label: "고객·RFID", icon: "contact" },
  { id: "training", label: "모델 학습", icon: "scan-line" },
  { id: "logs", label: "로그", icon: "scroll-text" }
];

export function icon(name) {
  return '<svg class="station-icon" aria-hidden="true"><use href="/static/station-icons.svg#' + name + '"></use></svg>';
}

const training = document.body.dataset.workspace === "training";

export function currentDestination() {
  if (training) return destinations.find(item => item.id === "training");
  const route = location.hash.slice(1);
  return destinations.find(item => item.id === route) || destinations[0];
}

function highlightDestination() {
  const current = currentDestination();
  for (const link of document.querySelectorAll(".station-nav a")) {
    if (link.dataset.page === current.id) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

const rail = document.getElementById("station-rail");
const nav = document.createElement("nav");
nav.className = "station-nav";
nav.setAttribute("aria-label", "주 메뉴");
for (const item of destinations) {
  if (item.id === "dashboard" || item.id === "stock") {
    const group = document.createElement("div");
    group.className = "nav-group";
    group.textContent = item.id === "dashboard" ? "운영" : "관리";
    nav.append(group);
  }
  const link = document.createElement("a");
  link.href = item.id === "training" ? "/training#collect" : "/#" + item.id;
  link.dataset.page = item.id;
  link.innerHTML = icon(item.icon) + item.label;
  nav.append(link);
}
rail.innerHTML = '<div class="station-brand"><span class="brand-mark">' + icon("scan-line") +
  '</span><div>Vision Lab<small>LOCAL WORKSPACE</small></div></div>';
rail.append(nav);
const mode = document.createElement("div");
mode.className = "rail-status";
mode.textContent = training ? "로컬 모델 학습" : "패킹 시뮬레이션";
rail.append(mode);
highlightDestination();
window.addEventListener("hashchange", highlightDestination);
