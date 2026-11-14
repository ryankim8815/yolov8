// Run against scripts.serve_webgpu. Use a separate Chrome profile, with real hardware GPU.
// NODE_PATH or PLAYWRIGHT_MODULE may point to an existing Playwright installation.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const base = process.env.WEBGPU_URL || 'http://localhost:8018';
  const output = path.resolve(process.env.WEBGPU_OUTPUT || 'artifacts/webgpu-poc/webgpu.json');
  const browser = await chromium.launch({channel: 'chrome', headless: process.env.WEBGPU_HEADLESS === '1'});
  try {
    const context = await browser.newContext({viewport: {width: 1280, height: 1000}});
    const page = await context.newPage(), errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push({url: request.url(), method: request.method()}));
    page.on('console', message => { if (message.type() === 'error') console.error(message.text().slice(0, 400)); });
    await page.goto(base);
    await page.waitForFunction(() => !!window.webgpuPoc);
    await page.evaluate(() => window.webgpuPoc.init());
    await page.locator('#sample').click();
    await page.waitForFunction(() => document.querySelector('#detections').textContent.includes('개'));
    const counts = {iterations: Number(process.env.WEBGPU_ITERATIONS || 256),
      warmup: Number(process.env.WEBGPU_WARMUP || 30), repeats: Number(process.env.WEBGPU_REPEATS || 3)};
    console.log('Hardware WebGPU initialized; starting', counts);
    const result = await page.evaluate(counts => window.webgpuPoc.benchmark(counts), counts);
    result.environment.chrome_version = browser.version();
    result.environment.headless = process.env.WEBGPU_HEADLESS === '1';
    assert.equal(result.backend, 'webgpu');
    assert.ok(Object.values(result.predictions).some(boxes => boxes.length > 0), 'No detections in fixtures');
    assert.deepEqual(errors, []);
    assert.ok(requests.every(r => new URL(r.url).origin === new URL(base).origin && r.method === 'GET'), 'Unexpected external request or upload');
    result.validation = {page_errors: errors, requests: requests.length, all_requests_local_get: true};
    await fs.mkdir(path.dirname(output), {recursive: true});
    await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
    await page.screenshot({path: path.join(path.dirname(output), 'chrome-webgpu.png'), fullPage: true});
    await page.setViewportSize({width: 390, height: 844});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile layout overflows');
    await page.screenshot({path: path.join(path.dirname(output), 'chrome-webgpu-mobile.png'), fullPage: true});
    // Exercise the camera lifecycle with a synthetic canvas stream; never request real camera access.
    await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#777'; ctx.fillRect(0, 0, 640, 480);
      const stream = canvas.captureStream(15);
      window.__testCamera = {canvas, stream};
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {value: async () => stream});
      document.querySelector('#detections').textContent = '';
    });
    await page.locator('#camera').click();
    await page.waitForFunction(() => document.querySelector('#detections').textContent.includes('개'));
    await page.locator('#stop').click();
    assert.ok(await page.evaluate(() => window.__testCamera.stream.getTracks().every(t => t.readyState === 'ended')));
    const unsupported = await context.newPage();
    await unsupported.addInitScript(() => Object.defineProperty(navigator, 'gpu', {value: undefined}));
    await unsupported.goto(base); await unsupported.locator('#initialize').click();
    await unsupported.waitForFunction(() => document.querySelector('#status').textContent.includes('WebGPU를 사용할 수 없습니다'));
    result.validation.synthetic_camera_start_stop = true;
    result.validation.unsupported_gpu_error = true;
    assert.deepEqual(errors, []);
    await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({chrome: browser.version(), adapter: result.environment.adapter, predict_ms: result.predict_ms, output}, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
