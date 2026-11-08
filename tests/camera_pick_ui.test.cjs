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

function measured(opening_mm = 65) {
  return {opening_mm, footprint_base_mm:[[0,-20,15],[0,20,15],[0,20,-15],[0,-20,-15]]};
}

test('the floor stays level in BASE and extends from the wall towards the camera', async () => {
  const {workSurfaces} = await import('../app/static/gripper-depth.js');
  const s = Math.SQRT1_2;
  const camera = [[s,0,s],[0,1,0],[-s,0,s]];
  for (const [floorZ,tcpZ,relativeZ] of [[0,null,0],[-120,null,-120],[25,null,25],[-120,30,-150],[30,30,0],[40,15,25]]) {
    for (const wallX of [70,120]) {
      const {floor,wall} = workSurfaces(camera,wallX,floorZ,tcpZ);
      assert.equal(floor.baseZ,floorZ);
      assert.deepEqual(floor.points.slice(0,2),wall.points.slice(0,2));
      assert.ok(wall.points.every(p=>p[0]===wallX));
      assert.ok(floor.points.slice(2).every(p=>p[0]<wallX));
      for (const p of [...floor.points, ...floor.lines.flat()]) {
        const dz = p.reduce((sum,v,i)=>sum+v*camera[i][2],0);
        assert.ok(Math.abs(dz-relativeZ)<1e-9);
      }
    }
  }
  assert.equal(workSurfaces(camera,70,null,null).floor,null);
});

test('parallel and nearly parallel walls give a finite floor at the projection of the wall center', async () => {
  const {workSurfaces} = await import('../app/static/gripper-depth.js');
  for (const pitch of [Math.PI/2,Math.PI/2-1e-5]) {
    const s=Math.sin(pitch), c=Math.cos(pitch);
    const camera=[[c,0,s],[0,1,0],[-s,0,c]];
    const {floor,wall}=workSurfaces(camera,70,-120,30);
    const rear = floor.points[0].map((v,i)=>(v+floor.points[1][i])/2);
    assert.ok(Math.abs(rear[0]*c-rear[2]*s-70*c)<1e-8);
    for (const p of floor.points) {
      assert.ok(Math.abs(p[0]*s+p[2]*c+150)<1e-8);
      assert.ok(Math.hypot(...p)<500);
    }
    assert.ok(wall.points.every(p=>p[0]===70));
  }
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
    const result = depthModel(defaultScene, toolAxes([90,90,0]), basis, measured());
    assert.ok(Math.abs(result.gap-20)<1e-10);
    assert.deepEqual(result.lens, [-defaultScene.tcpDepth,0,0]);
    assert.equal(result.wallX-result.lens[0], defaultScene.distance);
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

test('the lens stays on the sight axis through the TCP, including when the TCP reaches the lens or passes the wall', async () => {
  const {depthModel,defaultScene} = await import('../app/static/gripper-depth.js');
  const {toolAxes} = await import('../app/static/gripper-orientation.js');
  for (const tcpDepth of [0,410,1000]) {
    const settings = {...defaultScene, tcpDepth};
    const model = depthModel(settings,toolAxes([10,120,5]));
    assert.equal(Math.hypot(...model.lens), tcpDepth);
    assert.equal(model.wallX-model.lens[0], settings.distance);
    assert.equal(model.frontX-model.lens[0], settings.distance-settings.protrusion);
  }
});

test('signed depth is measured to the foremost finger pad, not to the TCP or the wrist', async () => {
  const {depthModel,defaultScene} = await import('../app/static/gripper-depth.js');
  const {toolAxes} = await import('../app/static/gripper-orientation.js');
  const model = (overrides={}, angles=[0,90,0], opening=65) => depthModel({...defaultScene,...overrides},toolAxes(angles),undefined,measured(opening));
  assert.equal(model().frontDepth,430);
  const near = (value, expected) => assert.ok(Math.abs(value-expected)<1e-9, value+' should equal '+expected);
  near(model().gap,20);
  near(model({kind:'wall'}).gap,70);
  near(model({distance:510}).gap,50);
  near(model({tcpDepth:432}).gap,-2);
  near(model({protrusion:90}).gap,-20);
  // With local X along sight, the positive pad ends at opening/2 + 12 mm.
  near(model({},[0,0,0]).gap,20-65/2-12);
  near(model({},[0,0,0],0).gap,20-12);
  near(model({length:100}).gap,20); // Extending the finger moves the wrist, not the defined TCP.
  assert.equal(model({},[9,103,33]).gap.toFixed(1),'7.8');
});

test('the detection footprint sizes the object and sets the opening between both finger pads', async () => {
  const {depthModel,defaultScene} = await import('../app/static/gripper-depth.js');
  const {toolAxes} = await import('../app/static/gripper-orientation.js');
  const axes = toolAxes([0,0,0]);
  const drawn = depthModel(defaultScene,axes,undefined,measured(50));
  assert.deepEqual(drawn.face.map(p=>p.slice(1)),[[-20,15],[20,15],[20,-15],[-20,-15]]);
  assert.equal(drawn.exampleObject,false);
  assert.equal(drawn.tip[0],37); // 25 mm inner half-opening plus the 12 mm pad
});

test('without a width estimate the whole gripper still rotates, with illustrative spacing only', async () => {
  const {depthModel,defaultScene} = await import('../app/static/gripper-depth.js');
  const {toolAxes} = await import('../app/static/gripper-orientation.js');
  for (const angles of [[0,0,0], [9,103,33]]) {
    const axes = toolAxes(angles);
    const reference = depthModel({...defaultScene,kind:'wall'},axes,undefined,measured(65));
    assert.equal(reference.parts.length,6); // Wrist, palm, two fingers and two pads.
    for (const estimate of [null, {reason:'unmeasurable',opening_mm:null}]) {
      const missing = depthModel({...defaultScene,kind:'wall',opening:100},axes,undefined,estimate);
      assert.deepEqual(missing.parts,reference.parts);
      assert.equal(missing.opening,null);
      assert.equal(missing.tip,null);
      assert.equal(missing.gap,null);
      assert.deepEqual(missing.face,[]);
    }
  }
});

test('wall + object extrudes an illustrative face when no footprint is available', async () => {
  const {depthModel,defaultScene} = await import('../app/static/gripper-depth.js');
  const {toolAxes} = await import('../app/static/gripper-orientation.js');
  for (const protrusion of [10,50,120]) {
    const settings = {...defaultScene,protrusion};
    const axes = toolAxes([9,103,33]);
    for (const estimate of [null, {reason:'unmeasurable'}, {footprint_base_mm:[]}]) {
      const model = depthModel(settings,axes,undefined,estimate);
      assert.equal(model.exampleObject,true);
      assert.equal(model.face.length,4);
      assert.ok(model.face.every(([x])=>x===model.wallX-protrusion));
      assert.equal(new Set(model.face.map(p=>p.slice(1).join(','))).size,4);
      assert.equal(model.parts.length,7);
      assert.deepEqual(model.parts.at(-1).points.map(([x])=>x),Array(4).fill([model.frontX,model.wallX]).flat());
      assert.equal(model.opening,null);
      assert.equal(model.gap,null);
    }
    const {footprint_base_mm} = measured();
    const projected = depthModel(settings,axes,undefined,{footprint_base_mm});
    assert.equal(projected.exampleObject,false);
    assert.deepEqual(projected.face.map(p=>p.slice(1)),footprint_base_mm.map(p=>p.slice(1)));
    assert.equal(projected.gap,null);
    const wall = depthModel({...settings,kind:'wall'},axes,undefined,measured());
    assert.equal(wall.parts.length,6);
    assert.deepEqual(wall.face,[]);
  }
});

test('a late measurement cannot restore an old selection after its replacement is unavailable', {timeout:1500}, async () => {
  const {trackGripperEstimate} = await import('../app/static/gripper-measurement.js');
  let finish, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const results = [];
  const tracker = trackGripperEstimate(() => new Promise(resolve => {finish=resolve; started();}), result=>results.push(result));
  tracker.update({}, {xyxy:[10,10,30,50]}, 0, null);
  await waiting;
  tracker.update(null, null, -1, '객체를 선택하세요.');
  finish(measured(50));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(results.at(-1),{reason:'객체를 선택하세요.'});
  assert.ok(results.every(result=>result.opening_mm === undefined));
  tracker.reset();
});
