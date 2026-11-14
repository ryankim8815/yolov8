import {decode, letterbox, stats} from './yolo.mjs';

let ort, manifest, session, adapterInfo, loadMs, modelFetchMs, initPromise;
let busy = false, stream, cameraGeneration = 0;
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', {willReadFrequently: true});
const status = text => { document.querySelector('#status').textContent = text; };
const manifestPromise = fetch('/manifest.json').then(r => {
  if (!r.ok) throw Error('모델 준비가 필요합니다: scripts.prepare_webgpu');
  return r.json();
});

async function initialize() {
  if (!isSecureContext || !navigator.gpu) throw Error('WebGPU를 사용할 수 없습니다. 최신 Chrome에서 localhost 또는 HTTPS로 접속하세요.');
  const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
  if (!adapter || adapter.info?.isFallbackAdapter || adapter.isFallbackAdapter) throw Error('하드웨어 WebGPU 어댑터를 찾지 못했습니다. CPU로 자동 전환하지 않습니다.');
  adapterInfo = Object.fromEntries(['vendor', 'architecture', 'device', 'description', 'isFallbackAdapter'].map(k => [k, adapter.info?.[k] ?? null]));
  manifest = await manifestPromise;
  ort = await import('/ort/ort.webgpu.min.mjs');
  ort.env.wasm.wasmPaths = new URL('/ort/', location.href).href;
  ort.env.wasm.numThreads = 1;
  const t0 = performance.now();
  const response = await fetch(manifest.model);
  if (!response.ok) throw Error('ONNX 모델을 읽을 수 없습니다.');
  const model = await response.arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', model)), b => b.toString(16).padStart(2, '0')).join('');
  if (hash !== manifest.model_sha256) throw Error('모델 SHA-256이 manifest와 다릅니다.');
  modelFetchMs = performance.now() - t0;
  const start = performance.now();
  // Explicit WebGPU EP; no application-level WASM retry. ORT may execute shape/control ops on CPU.
  session = await ort.InferenceSession.create(model, {executionProviders: ['webgpu'], graphOptimizationLevel: 'all'});
  loadMs = performance.now() - start;
  status(`WebGPU 준비 완료 · ${adapterInfo.vendor || 'GPU'} · YOLOv8n ${manifest.settings.imgsz}`);
}

export function init() {
  if (!initPromise) initPromise = initialize().catch(error => { initPromise = null; throw error; });
  return initPromise;
}

export async function predict(source, width, height) {
  const start = performance.now(), size = manifest.settings.imgsz;
  const transform = letterbox(width, height, size);
  if (canvas.width !== size) canvas.width = canvas.height = size;
  ctx.fillStyle = 'rgb(114,114,114)'; ctx.fillRect(0, 0, size, size);
  ctx.drawImage(source, 0, 0, width, height, transform.left, transform.top, transform.resizedWidth, transform.resizedHeight);
  const pixels = ctx.getImageData(0, 0, size, size).data;
  const plane = size * size, input = new Float32Array(plane * 3);
  for (let p = 0; p < plane; p++) {
    input[p] = pixels[p * 4] / 255; input[plane + p] = pixels[p * 4 + 1] / 255; input[2 * plane + p] = pixels[p * 4 + 2] / 255;
  }
  const tensor = new ort.Tensor('float32', input, [1, 3, size, size]);
  const preEnd = performance.now();
  let outputs;
  try {
    outputs = await session.run({[session.inputNames[0]]: tensor});
    const output = outputs[session.outputNames[0]];
    // CPU output materialization is inside this timed interval (not just GPU command submission).
    const data = output.location === 'gpu-buffer' ? await output.getData() : output.data;
    const runEnd = performance.now();
    const detections = decode(data, output.dims, transform, manifest.names, manifest.settings);
    const end = performance.now();
    return {detections, timing: {preprocess: preEnd - start, run_and_readback: runEnd - preEnd,
      postprocess: end - runEnd, predict: end - start}};
  } finally {
    tensor.dispose();
    if (outputs) for (const value of Object.values(outputs)) value.dispose();
  }
}

async function fixture(info) {
  const response = await fetch(info.url);
  if (!response.ok) throw Error(`Fixture load failed: ${info.name}`);
  const bytes = new Uint8ClampedArray(await response.arrayBuffer());
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  if (hash !== info.sha256) throw Error(`Fixture SHA-256 mismatch: ${info.name}`);
  const bitmap = await createImageBitmap(new ImageData(bytes, info.width, info.height), {colorSpaceConversion: 'none'});
  return {...info, bitmap};
}

export async function benchmark({iterations = 256, warmup = 30, repeats = 3} = {}) {
  if (![iterations, repeats].every(n => Number.isInteger(n) && n > 0 && n <= 10000) || !Number.isInteger(warmup) || warmup < 0 || warmup > 10000)
    throw Error('Invalid benchmark counts');
  if (busy || stream) throw Error('다른 추론 또는 카메라를 먼저 종료하세요.');
  busy = true;
  const fixtures = [];
  try {
    await init();
    for (const info of manifest.images) fixtures.push(await fixture(info));
    const run = index => { const f = fixtures[index % fixtures.length]; return predict(f.bitmap, f.width, f.height); };
    const rounds = [];
    for (let round = 0; round < repeats; round++) {
      status(`벤치마크 ${round + 1}/${repeats} · 워밍업 ${warmup}`);
      for (let i = 0; i < warmup; i++) await run(i);
      const samples = [];
      for (let i = 0; i < iterations; i++) samples.push((await run(i)).timing);
      rounds.push({samples, ...Object.fromEntries(Object.keys(samples[0]).map(k => [k + '_ms', stats(samples.map(s => s[k]))]))});
      // Between-round UI updates are outside the measured region.
      status(`벤치마크 ${round + 1}/${repeats} 완료`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const predictions = {};
    for (let i = 0; i < fixtures.length; i++) predictions[fixtures[i].name] = (await run(i)).detections;
    const preview = await run(0);
    render(fixtures[0].bitmap, fixtures[0].width, fixtures[0].height, preview);
    const result = {backend: 'webgpu', recorded_at: new Date().toISOString(),
      environment: {userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
        crossOriginIsolated, secureContext: isSecureContext, adapter: adapterInfo, runtime: manifest.runtime},
      settings: manifest.settings, source_sha256: manifest.source_sha256, model_sha256: manifest.model_sha256,
      image_hashes: Object.fromEntries(manifest.images.map(i => [i.name, i.source_sha256])),
      iterations, warmup, repeats, load_ms: loadMs, model_fetch_and_verify_ms: modelFetchMs,
      rounds, predict_ms: stats(rounds.flatMap(r => r.samples.map(s => s.predict))), predictions,
      note: 'Decoded images resident before timing. Canvas letterbox + RGB/255 NCHW + session.run with CPU readback + class-aware NMS + coordinate scaling. No camera/network/JPEG decode/render time. Canvas resize differs from OpenCV.'};
    window.webgpuLastResult = result;
    document.querySelector('#result').textContent = JSON.stringify({predict_ms: result.predict_ms, rounds: rounds.map(r => r.predict_ms), adapter: adapterInfo}, null, 2);
    document.querySelector('#download').disabled = false;
    status('벤치마크 완료');
    return result;
  } finally { fixtures.forEach(f => f.bitmap.close()); busy = false; }
}

function render(source, width, height, result) {
  const output = document.querySelector('#preview');
  output.width = width; output.height = height;
  const c = output.getContext('2d'); c.drawImage(source, 0, 0, width, height);
  c.lineWidth = Math.max(2, width / 320); c.font = `${Math.max(14, width / 40)}px sans-serif`;
  for (const box of result.detections) {
    const [x1, y1, x2, y2] = box.xyxy;
    c.strokeStyle = '#50f0b4'; c.fillStyle = '#50f0b4'; c.strokeRect(x1, y1, x2 - x1, y2 - y1);
    c.fillText(`${box.label} ${(box.confidence * 100).toFixed(0)}%`, x1 + 3, Math.max(20, y1 - 5));
  }
  document.querySelector('#detections').textContent = `${result.detections.length}개 · ${result.timing.predict.toFixed(1)} ms (화면 그리기 제외)`;
}

async function runImage(load) {
  if (busy || stream) throw Error('실행 중인 작업을 먼저 종료하세요.');
  busy = true;
  let bitmap;
  try { await init(); bitmap = await load(); const result = await predict(bitmap, bitmap.width, bitmap.height); render(bitmap, bitmap.width, bitmap.height, result); }
  finally { bitmap?.close(); busy = false; }
}

function stopCamera() {
  cameraGeneration++;
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  document.querySelector('#video').srcObject = null;
}

const guarded = fn => async () => { try { await fn(); } catch (e) { status(e.message); console.error(e); } };
document.querySelector('#initialize').onclick = guarded(init);
document.querySelector('#sample').onclick = guarded(() => runImage(async () => {
  const info = manifest.images[0]; return createImageBitmap(await (await fetch(info.jpeg)).blob());
}));
document.querySelector('#image').onchange = guarded(() => runImage(() => {
  const file = document.querySelector('#image').files[0];
  if (!file) throw Error('이미지를 선택하세요.'); return createImageBitmap(file);
}));
document.querySelector('#benchmark').onclick = guarded(() => benchmark());
document.querySelector('#stop').onclick = stopCamera;
document.querySelector('#camera').onclick = guarded(async () => {
  if (busy || stream) throw Error('실행 중인 작업을 먼저 종료하세요.');
  busy = true;
  const generation = ++cameraGeneration;
  try {
    await init();
    const acquired = await navigator.mediaDevices.getUserMedia({video: {width: 640, height: 480}, audio: false});
    if (generation !== cameraGeneration || document.hidden) { acquired.getTracks().forEach(t => t.stop()); return; }
    stream = acquired;
    const video = document.querySelector('#video'); video.srcObject = stream; await video.play();
    while (stream && generation === cameraGeneration && !document.hidden) {
      // Freeze the source so the boxes and displayed image refer to the same camera frame.
      const frame = await createImageBitmap(video);
      try {
        const result = await predict(frame, frame.width, frame.height);
        if (stream && generation === cameraGeneration) render(frame, frame.width, frame.height, result);
      } finally { frame.close(); }
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  } finally { stopCamera(); busy = false; }
});
document.querySelector('#download').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(window.webgpuLastResult, null, 2)], {type: 'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = 'webgpu-benchmark.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });
window.addEventListener('pagehide', stopCamera);
window.webgpuPoc = {init, benchmark};
manifestPromise.catch(error => status(error.message));
