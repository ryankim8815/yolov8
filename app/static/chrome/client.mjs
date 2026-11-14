import { openModel, sha256 } from "./inference.mjs";
function socket(path) {
  const url = new URL(path, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(url);
}

let connection, retry;
function report(message) {
  const status = document.getElementById("chrome-worker-status");
  if (status) {
    status.textContent = message;
    status.hidden = !message;
  }
}
function connect() {
  if (document.hidden || connection) return;
  const ws = socket("/api/chrome/inference");
  connection = ws;
  let detector,
    frame,
    chain = Promise.resolve();
  async function process(data) {
    let reply;
    if (typeof data === "string") {
      const command = JSON.parse(data);
      if (command.action === "idle") reply = { idle: true };
      if (command.action === "load") {
        await detector?.close();
        detector = null;
        const response = await fetch(command.url);
        if (!response.ok) throw Error("모델을 읽지 못했습니다.");
        const bytes = await response.arrayBuffer();
        if ((await sha256(bytes)) !== command.hash) throw Error("모델 해시가 다릅니다.");
        detector = await openModel(bytes, command.names, command.settings);
        reply = { loaded: command.hash };
        report("");
      }
      if (command.action === "predict") frame = command;
    } else {
      const image = await createImageBitmap(data);
      try {
        reply = {
          session: frame.session,
          frame_id: frame.frame_id,
          objects: await detector.predict(image),
        };
      } finally {
        image.close();
        frame = null;
      }
    }
    if (reply && ws.readyState === 1) ws.send(JSON.stringify(reply));
  }
  ws.onmessage = (event) => {
    chain = chain
      .then(() => process(event.data))
      .catch((error) => {
        report(error.message);
        if (ws.readyState === 1) ws.send(JSON.stringify({ error: error.message }));
        ws.close();
      });
  };
  ws.onclose = () => {
    if (connection === ws) connection = null;
    chain.finally(() => detector?.close());
    clearTimeout(retry);
    if (!document.hidden) retry = setTimeout(connect, 2000);
  };
}

async function init() {
  const response = await fetch("/api/status");
  if (!response.ok) throw Error("카메라 서버에 연결할 수 없습니다.");
  if ((await response.json()).backend !== "chrome") return;
  connect();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) connection?.close();
    else connect();
  });
  window.addEventListener("pagehide", () => {
    clearTimeout(retry);
    connection?.close();
  });
}
init().catch((e) => report(e.message));

let libraries;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/chrome/vendor/" + src;
    script.onload = resolve;
    script.onerror = () => reject(Error("Chrome 학습 라이브러리를 읽지 못했습니다."));
    document.head.append(script);
  });
}
export async function runJob(id) {
  const ws = socket("/api/chrome/jobs/" + encodeURIComponent(id));
  let resolveMessage,
    rejectMessage,
    closed = false;
  const next = () =>
    closed
      ? Promise.reject(Error("학습 연결이 종료되었습니다."))
      : new Promise((ok, fail) => {
          resolveMessage = ok;
          rejectMessage = fail;
        });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.error) rejectMessage?.(Error(m.error));
    else resolveMessage?.(m);
  };
  ws.onclose = () => {
    closed = true;
    rejectMessage?.(Error("학습 연결이 종료되었습니다."));
  };
  try {
    const cfg = await next();
    if (!libraries)
      libraries = loadScript("tf.min.js")
        .then(() => loadScript("tf-backend-webgpu.min.js"))
        .catch((e) => {
          libraries = null;
          throw e;
        });
    await libraries;
    const { train } = await import("./trainer.mjs");
    const { weights, metrics } = await train(cfg, async (progress) => {
      const response = next();
      ws.send(JSON.stringify({ progress }));
      await response;
    });
    const response = next();
    ws.send(JSON.stringify({ done: true, metrics }));
    ws.send(weights);
    return (await response).published;
  } catch (e) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ error: e.message }));
    throw e;
  } finally {
    ws.close();
  }
}
