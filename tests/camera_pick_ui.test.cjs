const assert = require('node:assert/strict');
const test = require('node:test');

test('resized and letterboxed camera views select the same original pixel', async () => {
  const {imagePixel} = await import('../app/static/camera-pick.js');
  const image = {width: 1280, height: 720};
  const scaled = {left: 20, top: 80, width: 640, height: 360};
  assert.deepEqual(imagePixel(scaled, image, 180, 170), [320, 180]);
  const letterboxed = {...scaled, height: 480};
  assert.deepEqual(imagePixel(letterboxed, image, 180, 230), [320, 180]);
  assert.equal(imagePixel(letterboxed, image, 180, 100), null);
  assert.equal(imagePixel(letterboxed, image, 180, 520), null);
});

test('the preview rotates around the taught Z–Y′–Z″ axes', async () => {
  const {toolAxes} = await import('../app/static/gripper-orientation.js');
  function close(actual, expected) {
    actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-10));
  }
  close(toolAxes([0, 90, 0])[2], [1, 0, 0]);
  close(toolAxes([90, 90, 0])[2], [0, 1, 0]);
  const [x, y, z] = toolAxes([35, -53, 21]);
  const rotated = toolAxes([35, -53, 111]);
  close(rotated[0], y);
  close(rotated[1], x.map(value => -value));
  close(rotated[2], z);
});

test('camera depth uses the taught face normal, independent of BASE origin and teaching order', async () => {
  const {cameraBasis, depthModel, defaultScene} = await import('../app/static/gripper-depth.js');
  const {toolAxes} = await import('../app/static/gripper-orientation.js');
  // The camera sees along +BASE Y; pixel right is +X and pixel down is -Z.
  const points = [[20,40],[140,25],[155,130],[40,120]].map(([u,v]) =>
    ({pixel:[u,v],pose:[680+u, -235, 700-v, 0,0,0]}));
  for (const ordered of [points,[...points].reverse(),[...points.slice(2),...points.slice(0,2)]]) {
    const basis = cameraBasis(ordered);
    basis[0].forEach((v,i) => assert.ok(Math.abs(v-[0,1,0][i])<1e-10));
    const result = depthModel(defaultScene, toolAxes([90,90,0]), basis);
    assert.ok(Math.abs(result.gap-20)<1e-10);
  }
  // Invalid/incomplete teaching must not masquerade as a measured camera direction.
  assert.equal(cameraBasis(points.slice(1)),null);
  assert.equal(cameraBasis([points[0],points[2],points[1],points[3]]),null);
  const bad = structuredClone(points);
  bad[3].pose[1] += 5;
  assert.equal(cameraBasis(bad),null);
  const degenerate = points.map(p => ({...p,pose:[10,20,30,0,0,0]}));
  assert.equal(cameraBasis(degenerate),null);
});

test('signed depth is measured to the foremost finger pad, not to the TCP or the wrist', async () => {
  const {depthModel,defaultScene} = await import('../app/static/gripper-depth.js');
  const {toolAxes} = await import('../app/static/gripper-orientation.js');
  const model = (overrides={}, angles=[0,90,0]) => depthModel({...defaultScene,...overrides},toolAxes(angles));
  assert.equal(model().frontDepth,430);
  const near = (value, expected) => assert.ok(Math.abs(value-expected)<1e-9, value+' should equal '+expected);
  near(model().gap,20);
  near(model({kind:'wall'}).gap,70);
  near(model({distance:510}).gap,50);
  near(model({tcpDepth:432}).gap,-2);
  near(model({protrusion:90}).gap,-20);
  // With local X along sight, the positive pad ends at opening/2 + 12 mm.
  near(model({},[0,0,0]).gap,20-65/2-12);
  near(model({opening:0},[0,0,0]).gap,20-12);
  near(model({length:100}).gap,20); // Extending the finger moves the wrist, not the defined TCP.
  assert.equal(model({},[9,103,33]).gap.toFixed(1),'7.8');
});
