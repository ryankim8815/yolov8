import { connectDepthPreview } from "./gripper-depth.js";

// Tool axes in BASE coordinates for the intrinsic Z, Y′, Z″ rotations.
export function toolAxes([a, b, c]) {
  const rad = Math.PI / 180;
  const ca = Math.cos(a * rad), sa = Math.sin(a * rad);
  const cb = Math.cos(b * rad), sb = Math.sin(b * rad);
  const cc = Math.cos(c * rad), sc = Math.sin(c * rad);
  return [
    [ca * cb * cc - sa * sc, sa * cb * cc + ca * sc, -sb * cc],
    [-ca * cb * sc - sa * cc, -sa * cb * sc + ca * cc, sb * sc],
    [ca * sb, sa * sb, cb]
  ];
}

// Read-only illustration. Executable tool orientations are owned by motion presets.
const exampleAngles = [9, 103, 33];

export function connectOrientation(el, signal) {
  const depth = connectDepthPreview(el, signal);
  function render(corners, corner, camera) {
    const angles = corners[0].pose.slice(3);
    const complete = angles.every(Number.isFinite);
    const illustrated = angles.map((angle, i) => Number.isFinite(angle) ? angle : exampleAngles[i]);
    depth.render(corners, toolAxes(illustrated),
      illustrated.map((v, i) => "ABC"[i] + " " + v + "도").join(", ") + (complete ? "" : " (미입력 각도는 예시)"), camera, corner);
  }
  return {render, setEstimate:depth.setEstimate, setFloor:depth.setFloor,
    setManipulator:depth.setManipulator,robotStatus:depth.robotStatus,
    setGripperAttached:depth.setGripperAttached,gripperStatus:depth.gripperStatus,setParcelBox:depth.setParcelBox,
    simulate:depth.simulate,simulationAction:depth.simulationAction,observeSimulation:depth.observeSimulation,
    simulateRecipe:depth.simulateRecipe,setScenarioPreview:depth.setScenarioPreview,setScenarioVisible:depth.setScenarioVisible};
}
