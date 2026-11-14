// Raw YOLOv8 detection head: [1, 4 + classes, anchors], class scores have no objectness channel.
export function roundEven(x) {
  const n = Math.floor(x);
  return x - n === .5 ? n + n % 2 : Math.round(x);
}

export function letterbox(width, height, size) {
  const gain = Math.min(size / width, size / height);
  const resizedWidth = roundEven(width * gain), resizedHeight = roundEven(height * gain);
  return {gain, resizedWidth, resizedHeight, left: roundEven((size - resizedWidth) / 2 - .1),
    top: roundEven((size - resizedHeight) / 2 - .1), width, height, size};
}

export function iou(a, b) {
  const intersection = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const area = x => Math.max(0, x[2] - x[0]) * Math.max(0, x[3] - x[1]);
  return intersection / (area(a) + area(b) - intersection + 1e-7);
}

export function decode(data, dims, transform, names, settings) {
  const classes = Object.keys(names).length;
  if (dims.length !== 3 || dims[0] !== 1 || dims[1] !== classes + 4 || data.length !== dims[1] * dims[2])
    throw new Error(`Unsupported raw YOLOv8 output: ${dims}`);
  const n = dims[2], candidates = [];
  for (let a = 0; a < n; a++) {
    let score = -Infinity, cls = 0;
    for (let c = 0; c < classes; c++) if (data[(c + 4) * n + a] > score) {
      score = data[(c + 4) * n + a]; cls = c;
    }
    if (!(score > settings.confidence) || !Number.isFinite(score)) continue;
    const cx = data[a], cy = data[n + a], w = data[2 * n + a], h = data[3 * n + a];
    if (![cx, cy, w, h].every(Number.isFinite) || w < 0 || h < 0) continue;
    candidates.push({class_id: cls, label: names[cls], confidence: score,
      xyxy: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]});
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  // Match Ultralytics' class-aware NMS and max_nms default.
  for (const box of candidates.slice(0, 30000)) {
    if (kept.some(other => other.class_id === box.class_id && iou(box.xyxy, other.xyxy) > settings.iou)) continue;
    kept.push(box);
    if (kept.length >= settings.max_det) break;
  }
  const {gain, width, height, size} = transform;
  const px = roundEven((size - width * gain) / 2 - .1), py = roundEven((size - height * gain) / 2 - .1);
  return kept.map(box => ({...box, xyxy: box.xyxy.map((v, i) =>
    Math.max(0, Math.min(i % 2 ? height : width, (v - (i % 2 ? py : px)) / gain)))}));
}

export function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const quantile = q => {
    const p = (sorted.length - 1) * q, lo = Math.floor(p);
    return sorted[lo] + (sorted[Math.ceil(p)] - sorted[lo]) * (p - lo);
  };
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {mean, p50: quantile(.5), p95: quantile(.95), fps: 1000 / mean};
}
