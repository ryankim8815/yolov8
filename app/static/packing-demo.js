// All packing records belong to this browser tab. Training uses its own server endpoints.
const storageKey = "vision-lab.packing-demo.v1";
const initial = {
  packed: 1,
  paused: false,
  extraOrder: false,
  customers: [
    { name: "홍길동", uid: "E2-34-08-A1" },
    { name: "김서연", uid: "E2-34-08-B2" }
  ],
  products: [
    { sku: "SN-001", name: "감자칩", alias: "과자", unit: "봉", bin: "A-01", stock: 23, label: "snack" },
    { sku: "BV-002", name: "탄산음료", alias: "음료수", unit: "캔", bin: "A-02", stock: 18, label: "drink_can" },
    { sku: "HS-003", name: "휴대용 휴지", alias: "휴지", unit: "개", bin: "A-03", stock: 12, label: "tissue" }
  ],
  events: [
    ["14:32:05", "음성", "사용자", "주문 들어왔어요."],
    ["14:32:06", "작업", "RFID", "박스 판독 완료 · 홍길동"],
    ["14:32:07", "음성", "시스템", "주문 123번, 홍길동님의 주문서를 확인했습니다."],
    ["14:32:09", "작업", "재고", "상품 3개 재고 예약 완료"],
    ["14:32:14", "작업", "로봇", "감자칩 1봉을 박스에 담았습니다."],
    ["14:32:16", "음성", "시스템", "탄산음료 한 캔 피킹을 시작합니다."],
    ["14:32:17", "작업", "탐지", "탄산음료 위치 확인 · 그리퍼 접근 중"]
  ]
};

function load() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey));
    if (saved && Number.isInteger(saved.packed) && saved.packed >= 0 && saved.packed <= 3 &&
        saved.products?.length >= 3 && saved.customers?.length && saved.events?.length) {
      return saved;
    }
  } catch {
    // A restricted browser can still use the demo in memory.
  }
  return structuredClone(initial);
}

export const demo = load();
export const orderItems = () => demo.products.slice(0, 3);
export const isPacked = () => demo.packed === 3;
export const reserved = index => Number(index >= demo.packed && index < 3);
export const orderStatus = () => isPacked() ? "발송 대기" : demo.paused ? "일시정지" : "피킹 중";

export function saveDemo() {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(demo));
  } catch {
    // Storage may be disabled or full. The current session stays usable.
  }
}

export function record(kind, source, message) {
  const lastTime = demo.events.at(-1)[0];
  const tick = new Date("2026-11-06T" + lastTime + "Z");
  tick.setUTCSeconds(tick.getUTCSeconds() + 2);
  demo.events.push([tick.toISOString().slice(11, 19), kind, source, message]);
}

export function setPaused(paused) {
  if (isPacked()) return "123번 주문은 발송 대기 중입니다.";
  if (demo.paused === paused) return paused ? "이미 일시정지 상태입니다." : "123번 주문의 피킹이 진행 중입니다.";
  demo.paused = paused;
  const message = paused ? "123번 주문의 피킹을 정지했습니다." : orderItems()[demo.packed].name + " 피킹을 재개합니다.";
  record("작업", "로봇", message);
  return message;
}

export function packNext() {
  if (demo.paused || isPacked()) return;
  const product = orderItems()[demo.packed];
  product.stock -= 1;
  demo.packed += 1;
  record("작업", "로봇", product.name + " 1" + product.unit + " 놓기 완료 · 출고 반영");
  const message = isPacked() ? "123번 주문의 상품 3개를 모두 담았습니다. 발송 대기입니다." :
    product.name + " 포장 완료. " + orderItems()[demo.packed].name + " 피킹을 시작합니다.";
  record("음성", "시스템", message);
  return message;
}
