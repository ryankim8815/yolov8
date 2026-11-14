import { decode, letterbox } from "/chrome/yolo.mjs";

export async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function openModel(bytes, names, settings) {
  if (!isSecureContext || !navigator.gpu)
    throw Error("WebGPU 지원 Chrome에서 localhost 또는 HTTPS로 접속하세요.");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter || adapter.info?.isFallbackAdapter) throw Error("WebGPU 장치를 사용할 수 없습니다.");
  const ort = await import("/chrome/vendor/ort.webgpu.min.mjs");
  ort.env.wasm.wasmPaths = new URL("/chrome/vendor/", location.href).href;
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ["webgpu"] });
  const canvas = new OffscreenCanvas(settings.imgsz, settings.imgsz);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  async function predict(image) {
    const size = settings.imgsz,
      plane = size * size;
    const t = letterbox(image.width, image.height, size);
    ctx.fillStyle = "#727272";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(image, t.left, t.top, t.resizedWidth, t.resizedHeight);
    const pixels = ctx.getImageData(0, 0, size, size).data;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      input[i] = pixels[i * 4] / 255;
      input[i + plane] = pixels[i * 4 + 1] / 255;
      input[i + 2 * plane] = pixels[i * 4 + 2] / 255;
    }
    const tensor = new ort.Tensor("float32", input, [1, 3, size, size]);
    let outputs;
    try {
      outputs = await session.run({ [session.inputNames[0]]: tensor });
      const raw = outputs[session.outputNames[0]];
      return decode(raw.data, raw.dims, t, names, settings);
    } finally {
      tensor.dispose();
      if (outputs) Object.values(outputs).forEach((v) => v.dispose());
    }
  }
  return { predict, close: () => session.release() };
}
