// Preview geometry only. Lengths are millimetres; the TCP is the fixed origin
// of the drawing. Camera range is measured by the operator, never inferred from BASE X.
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross = ([x,y,z], [u,v,w]) => [y*w-z*v, z*u-x*w, x*v-y*u];
const sub = (a, b) => a.map((v, i) => v - b[i]);
const scaled = (p, k) => p.map(v => v * k);
const unit = p => scaled(p, 1 / Math.hypot(...p));
const identity = [[1,0,0], [0,1,0], [0,0,1]];
const area = (a, b, c) => (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]);

function convex(points) {
  const turns = points.map((p, i) => area(p, points[(i+1)%4], points[(i+2)%4]));
  const span = Math.max(...points.flatMap(a => points.map(b => Math.hypot(...sub(a, b)))));
  const epsilon = Math.max(1e-6, span * span * 1e-6);
  return Math.min(...turns) > epsilon || Math.max(...turns) < -epsilon;
}

// For a frontoparallel target in the original camera image, image right × down
// points away from the camera. Using pixel order removes any dependence on
// which corner the operator taught first, or in which direction they went.
export function cameraBasis(corners) {
  if (corners?.length !== 4 || !corners.every(p => p.pixel?.length === 2 && p.pixel.every(Number.isFinite)
      && p.pose?.length >= 3 && p.pose.slice(0, 3).every(Number.isFinite))) return null;
  const pixels = corners.map(p => p.pixel), xyz = corners.map(p => p.pose.slice(0, 3));
  if (!convex(pixels)) return null;
  const ab = sub(xyz[1], xyz[0]), ac = sub(xyz[2], xyz[0]), normal = cross(ab, ac);
  if (Math.hypot(...normal) < 1e-6) return null;
  const det = area(...pixels.slice(0, 3)), forward = scaled(unit(normal), Math.sign(det));
  if (Math.abs(dot(forward, sub(xyz[3], xyz[0]))) > 2) return null;
  const dv1 = pixels[1][1] - pixels[0][1], dv2 = pixels[2][1] - pixels[0][1];
  const left = scaled(unit(ab.map((v, i) => v * dv2 - ac[i] * dv1)), -Math.sign(det));
  const up = cross(forward, left);
  if (!convex(xyz.map(p => [dot(p, left), dot(p, up)]))) return null;
  return [forward, left, up];
}

const metal = ["#83979f","#e8ece6","#a2b3b5","#c3d1d0","#a5b7b9","#e0e6e1"];
const steel = ["#344c57","#829599","#49616b","#617a81","#526b75","#8c9d9e"];
const amber = ["#dcaa74","#91623e","#aa7048","#d38f5c","#bb8052","#ce9668"];
const sides = [[0,2,3,1],[4,5,7,6],[0,1,5,4],[2,6,7,3],[0,4,6,2],[1,3,7,5]];
const extentY = 113, extentZ = 75;
export const defaultScene = Object.freeze({distance:480, tcpDepth:410, protrusion:50, length:70,
  kind:"object", view:"oblique", panel:"angles"});

function box(center, size, transform) {
  const points = [];
  for (const z of [-1,1]) for (const y of [-1,1]) for (const x of [-1,1]) {
    const p = [x,y,z].map((s, i) => center[i] + s * size[i] / 2);
    points.push(transform ? transform(p) : p);
  }
  return points;
}

export function depthModel(settings, toolAxes, camera = identity, estimate = null) {
  const {distance, tcpDepth, kind, protrusion, length} = settings;
  const opening = estimate?.opening_mm;
  const worldTool = toolAxes.map(axis => camera.map(direction => dot(axis, direction)));
  const transform = p => [0,1,2].map(i => p.reduce((n, v, j) => n + v * worldTool[j][i], 0));
  const frontDepth = distance - (kind === "object" ? protrusion : 0);
  const wallX = distance - tcpDepth, frontX = frontDepth - tcpDepth;
  const parts = [], pads = [];
  function part(center, size, palette, pad = false) {
    const points = box(center, size, transform);
    parts.push({points, palette});
    if (pad) pads.push(...points);
  }
  part([0,0,-length-26], [29,30,18], steel);
  let face = [];
  if (Number.isFinite(opening)) {
    part([0,0,-length-9], [opening+30,32,24], metal);
    for (const sign of [-1,1]) {
      part([sign*(opening/2+9),0,(-length-5)/2], [10,15,length-5], metal);
      part([sign*(opening/2+6),0,-5], [12,19,10], steel, true);
    }
    if (kind === "object") {
      face = estimate.footprint_base_mm.map(p => [frontX, dot(p,camera[1]), dot(p,camera[2])]);
      // Front/back pairs, in the vertex order used by box().
      const vertices = [0,1,3,2].flatMap(i => [face[i], [wallX,face[i][1],face[i][2]]]);
      parts.push({points:vertices, palette:amber});
    }
  }
  const tip = pads.length ? pads.reduce((best, p) => p[0] > best[0] ? p : best) : null;
  return {parts, face, opening, frontDepth, wallX, frontX, tip, gap:tip ? frontX-tip[0] : null, toolZ:worldTool[2], camera};
}

function svgNode(tag, attrs, value) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, val] of Object.entries(attrs)) n.setAttribute(key, val);
  if (value !== undefined) n.textContent = value;
  return n;
}
const pointsAttr = ps => ps.map(p => p.join(",")).join(" ");
const line = ([x1,y1], [x2,y2], stroke, width = 1, more = {}) =>
  svgNode("line", {x1,y1,x2,y2,stroke,"stroke-width":width,...more});
const label = (x,y,value,fill,more={}) => svgNode("text", {x,y,fill,"font-size":12,...more}, value);

function drawRuler(svg, {distance,tcpDepth,kind}, front) {
  const w = svg.clientWidth, h = 66, y = 32;
  if (!w) return;
  const max = Math.ceil((Math.max(distance,tcpDepth)+25)/50)*50;
  const pos = v => 12 + (w-24) * v / max;
  const nodes = [line([pos(0),y],[pos(max),y],"var(--line)",2)];
  for (let x=0; x<=max; x+=50) nodes.push(line([pos(x),y-2],[pos(x),y+3],"var(--sub)",.7));
  function mark(depth, text, labelX, above, anchor, color) {
    const x = pos(depth), dy = above ? -1 : 1;
    nodes.push(svgNode("polyline",{points:pointsAttr([[x,y],[x,y+dy*6],[labelX,y+dy*12]]),fill:"none",stroke:color}),
      label(labelX,y+(above?-16:25),text,color,{"text-anchor":anchor}));
  }
  mark(0,"카메라 0 mm",7,false,"start","var(--sub)");
  mark(tcpDepth,"TCP "+tcpDepth+" mm",w*.47,true,"end","var(--ink)");
  mark(distance,"벽 "+distance+" mm",w-8,true,"end","var(--mint)");
  const frontLabel = +front.toFixed(2);
  if (kind === "object") mark(front,"물체 앞면 "+frontLabel+" mm",Math.max(117,Math.min(w-62,pos(front))),false,"middle","var(--ink)");
  svg.setAttribute("viewBox", "0 0 "+w+" "+h);
  svg.setAttribute("aria-label", "카메라 기준 TCP "+tcpDepth+" mm, 벽 "+distance+" mm, 대상 앞면 "+frontLabel+" mm");
  svg.replaceChildren(...nodes);
}

function drawScene(el, settings, model, anglesText) {
  const {scene, world} = el, w = scene.clientWidth, h = scene.clientHeight;
  if (!w || !h) return;
  const {parts, face, opening, tip, wallX, frontX, frontDepth, gap, toolZ, camera} = model;
  const side = settings.view === "side";
  const xy = ([x,y,z]) => side ? [x,-z] : [.866*x-.5*y, -.17*x-.294*y-.94*z];
  const depth = ([x,y,z]) => side ? -y : -.47*x-.814*y+.34*z;
  const rect = (x, y, z) => [[x,-y,-z],[x,y,-z],[x,y,z],[x,-y,z]];
  const wall = rect(wallX,extentY,extentZ);
  const bounds = [...wall, ...face, ...face.map(([,y,z]) => [wallX,y,z])].map(xy);
  const radius = Math.hypot(settings.length + 35, (opening ?? 0)/2+15, 16);
  const halfW = Math.max(radius, ...bounds.map(([x]) => Math.abs(x)));
  const halfH = Math.max(radius, ...bounds.map(([,y]) => Math.abs(y)));
  // Fit without following the rotating mesh: TCP remains at the same screen pixel.
  const scale = Math.min((w-42)/(2*halfW), (h-20)/(2*halfH));
  function project(p) {const [x,y] = xy(p); return [w/2+x*scale,h/2+y*scale];}
  const origin = project([0,0,0]);
  scene.setAttribute("viewBox","0 0 "+w+" "+h);
  const nodes = [svgNode("polygon",{points:pointsAttr(wall.map(project)),fill:"#364a51",
    stroke:settings.kind === "wall" ? "#ffc08b" : "#90a7a9","stroke-width":1.3})];
  if (!side) {
    for (let v=-100; v<=100; v+=25) nodes.push(line(project([wallX,v,-extentZ]),project([wallX,v,extentZ]),"#587074",.7));
    for (let v=-75; v<=75; v+=25) nodes.push(line(project([wallX,-extentY,v]),project([wallX,extentY,v]),"#587074",.7));
  }
  nodes.push(line(project([-Math.min(120,settings.tcpDepth),0,0]),project([wallX,0,0]),"#8eafbb",1,{"stroke-dasharray":"4 5"}));
  const faces = parts.flatMap(({points,palette}) => sides.map((indices,i) => {
    const ps = indices.map(j => points[j]);
    return {points:ps, color:palette[i], depth:ps.reduce((n,p) => n+depth(p),0)/4};
  })).sort((a,b) => a.depth-b.depth);
  for (const f of faces) nodes.push(svgNode("polygon",{points:pointsAttr(f.points.map(project)),fill:f.color,
    stroke:"#24383d","stroke-width":.85,"stroke-linejoin":"round"}));
  if (face.length) nodes.push(svgNode("polygon",{points:pointsAttr(face.map(project)),fill:"none",stroke:"#ffc08b","stroke-width":1.5}));
  if (side && settings.kind === "wall") nodes.push(line(project([wallX,0,-extentZ]),project([wallX,0,extentZ]),"#ffc08b",1.5));
  const end = project(scaled(toolZ, 30));
  if (Math.hypot(...sub(end,origin)) > 1) nodes.push(line(origin,end,"#83ead3",2.8,{"marker-end":"url(#pick-z-arrow)"}));
  nodes.push(svgNode("circle",{cx:origin[0],cy:origin[1],r:4.6,fill:"#27363a",stroke:"#ffe4a2","stroke-width":2}));
  if (tip) {
    const a = project(tip), b = project([frontX,tip[1],tip[2]]);
    nodes.push(line(a,b,"#ffba81",2,{"stroke-dasharray":"3 2"}));
    for (const [x,y] of [a,b]) nodes.push(line([x,y-4],[x,y+4],"#ffba81",1.5));
  }
  const [wx,wy] = project(wall[3]);
  nodes.push(label(Math.min(w-22,wx+5),Math.max(14,wy-4),"벽","#d3e5e5"));
  // Small BASE triad keeps the camera-relative view tied to the robot frame.
  const base = [41,h-33];
  for (const [i,name] of ["X","Y","Z"].entries()) {
    const [dx,dy] = xy(camera.map(axis => axis[i])), to = [base[0]+dx*21,base[1]+dy*21];
    if (Math.hypot(dx,dy) > .1) nodes.push(line(base,to,"#a0b3ba",1.2),label(to[0]+dx*6,to[1]+dy*5+3,name,"#c0d2d8",{"font-size":10,"text-anchor":"middle"}));
  }
  nodes.push(label(base[0]-1,h-6,"BASE","#a0b3ba",{"font-size":10,"text-anchor":"middle"}));
  world.replaceChildren(...nodes);
  const past = gap < -.05;
  el.gapLabel.textContent = past ? "앞면을 지난 깊이" : "손끝 → 앞면";
  el.gap.textContent = gap === null ? "—" : Math.abs(gap).toFixed(1)+" mm";
  scene.setAttribute("aria-label", "고정 TCP의 그리퍼 방향: "+anglesText+". "+(face.length ? "벽과 가상 물체" : "벽")+
    ". 대상 앞면 "+(+frontDepth.toFixed(2))+" mm. "+el.gapLabel.textContent+" "+el.gap.textContent+" (시선축 기준).");
  drawRuler(el.ruler,settings,frontDepth);
}

const dimensions = [
  ["distance","카메라 → 벽",300,700,"depthFields"],
  ["protrusion","물체 돌출 깊이",10,120,"depthFields"],
  ["tcpDepth","카메라 → TCP",0,1000,"depthFields"],
  ["length","손가락 길이",25,110,"jawPanel"]
];
const choices = {view:["oblique","side"],kind:["wall","object"],panel:["angles","jaws"]};

function restoredSettings(key) {
  const result = {...defaultScene};
  if (!key) return result;
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    for (const [name,,min,max] of dimensions) {
      if (Number.isFinite(saved?.[name]) && saved[name] >= min && saved[name] <= max) result[name] = saved[name];
    }
    for (const [name, allowed] of Object.entries(choices)) if (allowed.includes(saved?.[name])) result[name] = saved[name];
  } catch { /* Storage is optional. */ }
  return result;
}

export function connectDepthPreview(el, signal) {
  let key, settings = {...defaultScene}, pose, estimate = null;
  const fields = {};
  const on = (node, type, fn) => node.addEventListener(type, fn, {signal});
  function remember() {
    try { if (key) localStorage.setItem(key,JSON.stringify(settings)); } catch { /* Private browsing. */ }
  }
  function draw() {
    if (!pose) return;
    drawScene(el, settings, depthModel(settings, pose.axes, pose.basis ?? identity, estimate), pose.anglesText);
  }
  function sync() {
    for (const [name,buttons] of Object.entries(groups)) {
      for (const button of buttons) button.setAttribute("aria-pressed",String(button.getAttribute("data-depth-"+name) === settings[name]));
    }
    el.anglePanel.hidden = settings.panel !== "angles";
    el.jawPanel.hidden = settings.panel !== "jaws";
    fields.protrusion.row.hidden = settings.kind === "wall";
    for (const [name,{range,number}] of Object.entries(fields)) range.value = number.value = settings[name];
    draw();
  }
  const groups = {};
  for (const name of Object.keys(choices)) {
    groups[name] = el.calibration.querySelectorAll("[data-depth-"+name+"]");
    for (const button of groups[name]) on(button,"click",() => {
      settings[name] = button.getAttribute("data-depth-"+name);
      sync(); remember();
    });
  }
  for (const [name,caption,min,max,group] of dimensions) {
    const row = document.createElement("div"), head = document.createElement("div"), lab = document.createElement("label");
    const value = document.createElement("span"), number = document.createElement("input"), range = document.createElement("input");
    row.className = "pick-angle-row"; head.className = "pick-angle-label"; value.className = "pick-angle-value";
    range.type = "range"; range.id = "pick-depth-"+name; number.type = "number";
    range.step = ".1"; number.step = "any"; number.required = true;
    range.min = number.min = min; range.max = number.max = max;
    number.title = min+"–"+max+" mm";
    lab.htmlFor = range.id; lab.textContent = caption; number.setAttribute("aria-label", caption+" 직접 입력 (mm)");
    value.append(number,"mm"); head.append(lab,value); row.append(head,range); el[group].append(row);
    fields[name] = {row,number,range};
    on(range,"input",() => {settings[name] = range.valueAsNumber; number.value = settings[name]; draw();});
    on(range,"change",remember);
    on(number,"input",() => {
      if (number.validity.valid) {settings[name] = number.valueAsNumber; range.value = settings[name]; draw();}
    });
    on(number,"change",() => {number.value = settings[name]; remember();});
    on(number,"blur",() => {number.value = settings[name];});
  }
  const observer = new ResizeObserver(draw);
  observer.observe(el.scene);
  signal.addEventListener("abort",() => observer.disconnect(),{once:true});
  function render(corners, axes, anglesText, camera) {
    const next = camera?.camera_id ? "vision-gripper-preview-v1:"+JSON.stringify([camera.camera_id,camera.width,camera.height]) : null;
    pose = {basis:cameraBasis(corners), axes, anglesText};
    el.basisHint.textContent = pose.basis ? "시선: 네 모서리의 작업면에 수직." : "예시 시선: BASE +X (유효한 네 점을 교시하기 전).";
    if (next !== key) {
      key = next; settings = restoredSettings(key); sync();
    } else draw();
  }
  return {render, setEstimate(result) { estimate = result; draw(); }};
}
