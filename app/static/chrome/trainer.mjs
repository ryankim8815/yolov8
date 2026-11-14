import { letterbox } from "/chrome/yolo.mjs";
import { openModel, sha256 } from "./inference.mjs";
let cfg, size, tf, params, anchors;

function parameter(name) {
  return params["model." + name];
}
function conv(x, name, stride = 1, activation = true) {
  const kernel = parameter(name + ".weight");
  const bias = parameter(name + ".bias");
  const z = tf.conv2d(x, kernel, stride, Math.floor(kernel.shape[0] / 2)).add(bias);
  return activation ? z.mul(tf.sigmoid(z)) : z;
}
function block(x, i, s = 1) {
  return conv(x, i + ".conv", s);
}
function c2f(x, i, count, shortcut) {
  const wide = block(x, i + ".cv1"),
    half = wide.shape[3] / 2;
  const parts = [0, half].map((start) => wide.slice([0, 0, 0, start], [-1, -1, -1, half]));
  for (let k = 0; k < count; k++) {
    const prev = parts.at(-1);
    const next = block(block(prev, i + ".m." + k + ".cv1"), i + ".m." + k + ".cv2");
    parts.push(shortcut ? prev.add(next) : next);
  }
  return block(tf.concat(parts, 3), i + ".cv2");
}
function up(x) {
  return tf.image.resizeNearestNeighbor(x, [2 * x.shape[1], 2 * x.shape[2]], false);
}
function forward(x) {
  const f2 = c2f(block(block(x, 0, 2), 1, 2), 2, 1, true);
  const f4 = c2f(block(f2, 3, 2), 4, 2, true);
  const f6 = c2f(block(f4, 5, 2), 6, 2, true);
  const f8 = c2f(block(f6, 7, 2), 8, 1, true);
  const pool = [block(f8, "9.cv1")];
  for (let i = 0; i < 3; i++) pool.push(tf.maxPool(pool.at(-1), 5, 1, "same"));
  const f9 = block(tf.concat(pool, 3), "9.cv2");
  const f12 = c2f(tf.concat([up(f9), f6], 3), 12, 1, false);
  const f15 = c2f(tf.concat([up(f12), f4], 3), 15, 1, false);
  const f18 = c2f(tf.concat([block(f15, 16, 2), f12], 3), 18, 1, false);
  const f21 = c2f(tf.concat([block(f18, 19, 2), f9], 3), 21, 1, false);
  const heads = (branch) =>
    tf.concat(
      [f15, f18, f21].map((x, i) => {
        const id = "22.cv" + branch + "." + i;
        return conv(block(block(x, id + ".0"), id + ".1"), id + ".2", 1, false).reshape([
          -1,
          branch === 2 ? 64 : cfg.count,
        ]);
      }),
      0,
    );
  return { dist: heads(2).reshape([-1, 4, 16]), cls: heads(3) };
}

function boxTensor(dist) {
  const d = tf.softmax(dist, -1).mul(tf.range(0, 16)).sum(-1);
  const origin = tf.tensor2d(anchors.map(([x, y]) => [x, y, x, y]));
  const scale = tf.tensor2d(anchors.map(([, , s]) => [-s, -s, s, s]));
  return origin.add(d.mul(scale));
}
function overlap(a, b) {
  const inter =
    Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-7);
}
async function loadFrame(info) {
  const response = await fetch(info.url);
  if (!response.ok) throw Error("학습 이미지를 불러오지 못했습니다.");
  const bitmap = await createImageBitmap(await response.blob());
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(size, size),
    ctx = canvas.getContext("2d", { willReadFrequently: true });
  const t = letterbox(width, height, size);
  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(bitmap, t.left, t.top, t.resizedWidth, t.resizedHeight);
  bitmap.close();
  const input = tf.tidy(() =>
    tf.browser
      .fromPixels(ctx.getImageData(0, 0, size, size))
      .toFloat()
      .div(255)
      .expandDims(0),
  );
  const targets = info.labels.map(([c, x, y, w, h]) => ({
    c,
    box: [
      (x - w / 2) * t.resizedWidth + t.left,
      (y - h / 2) * t.resizedHeight + t.top,
      (x + w / 2) * t.resizedWidth + t.left,
      (y + h / 2) * t.resizedHeight + t.top,
    ],
  }));
  return { input, targets };
}
// Top-k anchors inside each labelled box, ranked by class probability and overlap.
async function assignment(frame) {
  const [cls, b] = tf.tidy(() => {
    const f = forward(frame.input);
    return [tf.sigmoid(f.cls), boxTensor(f.dist)];
  });
  const [scores, boxes] = await Promise.all([cls.data(), b.array()]);
  tf.dispose([cls, b]);
  const positives = new Map();
  for (const { c, box } of frame.targets) {
    const candidates = [];
    anchors.forEach(([x, y], i) => {
      if (x <= box[0] || y <= box[1] || x >= box[2] || y >= box[3]) return;
      const iou = overlap(box, boxes[i]);
      candidates.push({ i, c, box, iou, score: Math.sqrt(scores[i * cfg.count + c]) * iou ** 6 });
    });
    candidates.sort((a, b) => b.score - a.score);
    for (const row of candidates.slice(0, 10))
      if (row.iou > 0 && (!positives.has(row.i) || row.iou > positives.get(row.i).iou))
        positives.set(row.i, row);
  }

  return [...positives.values()];
}
function objective(frame, positives) {
  const { cls, dist } = forward(frame.input);
  if (!positives.length) return tf.softplus(cls).sum().mul(0.5);
  const ids = tf.tensor1d(
    positives.map((p) => p.i),
    "int32",
  );
  const classes = new Float32Array(anchors.length * cfg.count);
  for (const p of positives) classes[cfg.count * p.i + p.c] = Math.max(0.05, p.iou);
  const labels = tf.tensor2d(classes, [anchors.length, cfg.count]);
  const bce = tf.softplus(cls).sub(labels.mul(cls)).sum().div(positives.length);
  const trueBoxes = tf.tensor2d(positives.map((p) => p.box));
  const predBoxes = tf.gather(boxTensor(dist), ids);
  const halves = (boxes) => [0, 2].map((c) => boxes.slice([0, c], [-1, 2]));
  const [pmin, pmax] = halves(predBoxes),
    [tmin, tmax] = halves(trueBoxes);
  const area = (x) => x.prod(1);
  const intersection = area(tf.minimum(pmax, tmax).sub(tf.maximum(pmin, tmin)).relu());
  const union = area(pmax.sub(pmin))
    .add(area(tmax.sub(tmin)))
    .sub(intersection)
    .add(1e-7);
  const boxLoss = tf.scalar(1).sub(intersection.div(union)).mean();
  const d = positives.flatMap(({ box, i }) => {
    const [x, y, s] = anchors[i];
    return [(x - box[0]) / s, (y - box[1]) / s, (box[2] - x) / s, (box[3] - y) / s].map((v) =>
      Math.max(0, Math.min(14.99, v)),
    );
  });
  const low = d.map(Math.floor),
    frac = tf.tensor1d(d.map((v, i) => v - low[i])).expandDims(1);
  const lo = tf.oneHot(tf.tensor1d(low, "int32"), 16),
    hi = tf.oneHot(
      tf.tensor1d(
        low.map((v) => v + 1),
        "int32",
      ),
      16,
    );
  const soft = lo.mul(tf.scalar(1).sub(frac)).add(hi.mul(frac));
  const dfl = tf
    .logSoftmax(tf.gather(dist, ids).reshape([-1, 16]))
    .mul(soft)
    .sum(1)
    .neg()
    .mean();
  return bce.mul(0.5).add(boxLoss.mul(7.5)).add(dfl.mul(1.5));
}
async function initializeWeights(buffer) {
  await tf.setBackend("webgpu");
  await tf.ready();
  if (tf.getBackend() !== "webgpu") throw Error("WebGPU training backend unavailable");
  for (const [name, { shape, offset }] of Object.entries(cfg.params)) {
    const n = shape.reduce((a, b) => a * b, 1);
    const flat = new Float32Array(buffer.slice(offset, offset + n * 4));
    params[name] = tf.tidy(() => {
      let t = tf.tensor(flat, shape);
      if (shape.length === 4) t = t.transpose([2, 3, 1, 0]);
      return tf.variable(t, true, name);
    });
  }
}

async function trainBatch(rows, optimizer, progress) {
  // Accumulate per-image gradients so batch size does not multiply activation memory.
  let accumulated = {},
    total = 0;
  try {
    for (const [index, row] of rows.entries()) {
      await progress(index);
      const frame = await loadFrame(row);
      try {
        const positives = await assignment(frame);
        const { value, grads } = tf.variableGrads(
          () => objective(frame, positives),
          Object.values(params),
        );
        total += (await value.data())[0];
        value.dispose();
        for (const [name, g] of Object.entries(grads)) {
          const old = accumulated[name];
          accumulated[name] = tf.tidy(() =>
            old ? old.add(g.div(rows.length)) : g.div(rows.length),
          );
          old?.dispose();
          g.dispose();
        }
      } finally {
        frame.input.dispose();
      }
    }
    if (!Number.isFinite(total)) throw Error("학습 손실이 유한하지 않습니다.");
    optimizer.applyGradients(accumulated);
    return total;
  } finally {
    tf.dispose(accumulated);
  }
}

async function validationLoss(progress) {
  let sum = 0;
  for (const [index, row] of cfg.val.entries()) {
    await progress(index);
    const frame = await loadFrame(row);
    try {
      const positives = await assignment(frame);
      const loss = tf.tidy(() => objective(frame, positives));
      sum += (await loss.data())[0];
      loss.dispose();
    } finally {
      frame.input.dispose();
    }
  }
  const mean = sum / cfg.val.length;
  if (!Number.isFinite(mean)) throw Error("검증 손실이 유한하지 않습니다.");
  return mean;
}

async function checkpoint(base) {
  const bytes = new Uint8Array(base.slice(0));
  for (const [name, { shape, offset }] of Object.entries(cfg.params)) {
    const variable = params[name];
    const t = shape.length === 4 ? variable.transpose([3, 2, 0, 1]) : variable;
    try {
      const values = await t.data();
      bytes.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), offset);
    } finally {
      if (t !== variable) t.dispose();
    }
  }
  return bytes;
}

export async function train(config, progress) {
  cfg = config;
  size = cfg.size;
  tf = window.tf;
  params = {};
  anchors = [];
  for (const stride of [8, 16, 32]) {
    for (let y = 0; y < size / stride; y++)
      for (let x = 0; x < size / stride; x++)
        anchors.push([(x + 0.5) * stride, (y + 0.5) * stride, stride]);
  }
  const response = await fetch(cfg.url);
  if (!response.ok) throw Error("기반 모델을 불러오지 못했습니다.");
  const base = await response.arrayBuffer();
  let optimizer, best, bestMetrics;
  try {
    await initializeWeights(base);
    optimizer = tf.train.adam(0.0001);
    for (let epoch = 1; epoch <= cfg.epochs; epoch++) {
      let sum = 0;
      for (let i = 0; i < cfg.train.length; i += cfg.batch) {
        sum += await trainBatch(cfg.train.slice(i, i + cfg.batch), optimizer, (index) =>
          progress({
            stage: "training",
            epoch: epoch - 1,
            epochs: cfg.epochs,
            step: i + index,
            total: cfg.train.length,
            batch: cfg.batch,
          }),
        );
      }
      const valLoss = await validationLoss((index) =>
        progress({
          stage: "validating",
          epoch,
          epochs: cfg.epochs,
          step: index,
          total: cfg.val.length,
        }),
      );
      const metrics = {
        epoch,
        epochs: cfg.epochs,
        train_loss: sum / cfg.train.length,
        val_loss: valLoss,
      };
      await progress(metrics);
      if (!bestMetrics || metrics.val_loss < bestMetrics.val_loss) {
        best = await checkpoint(base);
        bestMetrics = metrics;
      } else if (epoch - bestMetrics.epoch >= cfg.patience) break;
    }
    await progress({ ...bestMetrics, stage: "exporting" });
    const settings = { imgsz: size, confidence: 0.25, iou: 0.45, max_det: 100 };
    const detector = await openModel(best, cfg.names, settings);
    let objects = 0;
    try {
      for (const [index, row] of cfg.val.entries()) {
        await progress({ ...bestMetrics, stage: "validating", step: index, total: cfg.val.length });
        const image = await createImageBitmap(await (await fetch(row.url)).blob());
        try {
          objects += (await detector.predict(image)).length;
        } finally {
          image.close();
        }
      }
    } finally {
      await detector.close();
    }
    return {
      weights: best,
      metrics: {
        ...bestMetrics,
        validation_images: cfg.val.length,
        detections: objects,
        verified_hash: await sha256(best),
      },
    };
  } finally {
    optimizer?.dispose();
    tf.dispose(params);
    params = {};
  }
}
