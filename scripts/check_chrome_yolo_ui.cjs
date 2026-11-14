// Run with tests.chrome_yolo_qa:create_qa_app on port 18280 (isolated state, replay camera).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
(async () => {
  const base = "http://127.0.0.1:18280";
  const retain = process.env.CHROME_QA_RETAIN === "1";
  const epochs = process.env.CHROME_QA_EPOCHS || "1";
  const browser = await chromium.launch({ channel: "chrome", headless: false });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error(e.message);
    });
    await page.route("**/api/robot/**", (route) =>
      route.fulfill({ status: 503, json: { detail: "isolated camera test" } }),
    );
    const json = async (route) => (await page.request.get(base + route)).json();
    await page.goto(base);
    async function poll(get, test, ms = 90000) {
      const end = Date.now() + ms;
      let value;
      while (Date.now() < end) {
        value = await get();
        if (test(value)) return value;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw Error("Timed out: " + JSON.stringify(value).slice(0, 800));
    }
    const latest = (id, requireBoxes = false) =>
      poll(
        () => json("/api/detections/latest"),
        (r) =>
          r.backend === "chrome" && r.model_version === id && (!requireBoxes || r.objects.length),
      );
    const initial = await latest("coco-yolov8n", true);
    console.log("Dashboard:", initial.backend, initial.objects.length, "objects");
    await page.goto(base + "/training#jobs");
    const dataset = (await json("/api/datasets")).at(-1);
    await page.locator("#dataset-open").click();
    await page.locator('[data-id="' + dataset.id + '"]').click();
    await page.locator("#ds-confirm:enabled").click();
    await page.locator("#class-select-none:enabled").click();
    if (retain) {
      await page.getByRole("checkbox", { name: "zebra 클래스 유지", exact: true }).check();
      await page
        .getByRole("combobox", { name: "zebra 사진 라벨 연결", exact: true })
        .selectOption(dataset.classes[0].uuid);
    } else await page.locator("#class-new-rows input").first().check();
    await page.locator("#class-preview").click();
    await page.locator("#class-plan-confirm:enabled").check();
    await page.locator("#train-epochs").fill(epochs);
    await page.locator("#train-batch").fill("2");
    const posted = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/api/training/jobs"),
    );
    await page.locator("#train-start:enabled").click();
    const response = await posted;
    const job = await response.json();
    assert.equal(response.status(), 202, JSON.stringify(job));
    const completed = await poll(
      () => json("/api/training/jobs/" + job.id),
      (j) => ["completed", "failed", "interrupted", "cancelled"].includes(j.state),
      180000,
    );
    assert.equal(completed.state, "completed", completed.error);
    console.log("Trained", completed.model_id, completed.progress);
    const models = await json("/api/models"),
      trained = models.models.find((m) => m.id === completed.model_id);
    assert.ok(trained.formats.chrome.sha256);
    assert.equal(trained.classes.length, 1);
    await page.goto(base + "/training#models");
    await page.locator('[data-model-id="' + trained.id + '"]').click();
    await page.locator("#use-version:enabled").click();
    await page.locator("#submit-model-change").click();
    await poll(
      () => json("/api/models"),
      (m) => m.active_model_id === trained.id,
      100000,
    );
    await page.goto(base);
    const final = await latest(trained.id, retain || Number(epochs) >= 10);
    assert.ok(final.objects.every((b) => b.label === trained.classes[0].name));
    assert.deepEqual(errors, []);
    console.log(
      "Dashboard applied:",
      final.model_version,
      "frame",
      final.frame_id,
      "Chrome",
      browser.version(),
    );
    // Continue from a browser-trained checkpoint through the same public job API.
    await page.goto(base + "/training#jobs");
    const resumed = await page.request.post(base + "/api/training/jobs", {
      data: {
        dataset_id: completed.dataset_id,
        initial_model_id: trained.id,
        epochs: 1,
        batch: 2,
      },
    });
    const resumedJob = await resumed.json();
    assert.equal(resumed.status(), 202, JSON.stringify(resumedJob));
    await page.evaluate((id) => {
      import("/static/chrome/client.mjs").then((m) => m.runJob(id)).catch((e) => console.error(e));
    }, resumedJob.id);
    const continued = await poll(
      () => json("/api/training/jobs/" + resumedJob.id),
      (j) => ["completed", "failed"].includes(j.state),
      180000,
    );
    assert.equal(continued.state, "completed", continued.error);
    const child = (await json("/api/models")).models.find((m) => m.id === continued.model_id);
    assert.equal(child.parent_model_id, trained.id);
    assert.equal(child.version_number, trained.version_number + 1);
    assert.notEqual(child.formats.chrome.sha256, trained.formats.chrome.sha256);
    assert.deepEqual(errors, []);
    console.log("Resumed browser model:", child.id, "version", child.version_number);
    // The server must re-open the training slot when its owner leaves mid-job.
    await page.goto(base + "/training#jobs");
    const pending = await page.request.post(base + "/api/training/jobs", {
      data: { dataset_id: dataset.id, epochs: 3, batch: 2 },
    });
    const nextJob = await pending.json();
    assert.equal(pending.status(), 202, JSON.stringify(nextJob));
    await page.evaluate((id) => {
      import("/static/chrome/client.mjs").then((m) => m.runJob(id)).catch(() => {});
    }, nextJob.id);
    await poll(
      () => json("/api/training/jobs/" + nextJob.id),
      (j) => j.state === "training",
    );
    await page.goto("about:blank");
    const failed = await poll(
      () => json("/api/training/jobs/" + nextJob.id),
      (j) => j.state === "failed",
    );
    assert.equal((await json("/api/status")).active_job, null);
    assert.ok(!(await json("/api/models")).models.some((m) => m.id === failed.model_id));
    console.log("Disconnected training session released; no partial model published.");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
