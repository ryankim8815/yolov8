import test from 'node:test';
import assert from 'node:assert/strict';
import {decode, letterbox, iou, roundEven, stats} from '../webgpu/yolo.mjs';

const settings = {confidence: .25, iou: .45, max_det: 100};
const names = {0: 'person', 1: 'bottle'};
function head(rows) {
  const data = new Float32Array(rows.length * 6);
  rows.forEach((row, anchor) => row.forEach((value, channel) => { data[channel * rows.length + anchor] = value; }));
  return data;
}

test('raw YOLOv8 class scores, class-aware NMS, confidence and coordinate restoration', () => {
  // Identical boxes in two classes must survive; lower-confidence duplicate person must be suppressed.
  const rows = [[320, 320, 100, 80, .9, .1], [321, 320, 100, 80, .8, .1],
    [320, 320, 100, 80, .1, .85], [100, 100, 20, 20, .2, .1]];
  const boxes = decode(head(rows), [1, 6, 4], letterbox(1280, 720, 640), names, settings);
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes.map(b => b.label), ['person', 'bottle']);
  assert.deepEqual(boxes[0].xyxy, [540, 280, 740, 440]);
  assert.ok(Math.abs(boxes[0].confidence - .9) < 1e-6);
});

test('max_det truncates by score; scaled coordinates clip to source boundaries', () => {
  const rows = [[0, 0, 100, 100, .8, .1], [640, 640, 100, 100, .1, .9]];
  const boxes = decode(head(rows), [1, 6, 2], letterbox(640, 640, 640), names, {...settings, max_det: 1});
  assert.equal(boxes.length, 1);
  assert.deepEqual(boxes[0].xyxy, [590, 590, 640, 640]);
});

test('invalid output layout fails instead of interpreting another model head', () => {
  assert.throws(() => decode(new Float32Array(7), [1, 7, 1], letterbox(640, 640, 640), names, settings), /Unsupported/);
  assert.deepEqual(decode(new Float32Array(6), [1, 6, 1], letterbox(640, 640, 640), names, settings), []);
});

test('Python ties-to-even resize and odd letterbox padding', () => {
  assert.equal(roundEven(2.5), 2); assert.equal(roundEven(3.5), 4);
  const t = letterbox(640, 427, 640);
  assert.equal(t.resizedHeight, 427); assert.equal(t.top, 106);
  assert.equal(iou([0, 0, 1, 1], [2, 2, 3, 3]), 0);
});

test('linear quantiles and throughput use the same sample population', () => {
  const result = stats([4, 1, 3, 2]);
  assert.equal(result.mean, 2.5); assert.equal(result.p50, 2.5);
  assert.ok(Math.abs(result.p95 - 3.85) < 1e-10); assert.equal(result.fps, 400);
});
