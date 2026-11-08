// E0509 forward kinematics from DoosanRobotics/doosan-robot2,
// dsr_description2/urdf/e0509.white.urdf (Apache-2.0). All lengths are mm.
export const defaultArmJoints = Object.freeze([0,0,90,0,90,0]);
const jointOrigins = [
  [[0,0,204.5],[0,0,0]], [[0,0,0],[0,-1.5708,-1.5708]],
  [[373,0,0],[0,0,1.5708]], [[0,-373,0],[1.5708,0,0]],
  [[0,0,0],[-1.5708,0,0]], [[0,-172.5,0],[1.5708,0,0]]
];
export const identity = () => [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
export function multiply(a,b) {
  const c = Array(16).fill(0);
  for (let j=0;j<4;j++) for (let i=0;i<4;i++) for (let k=0;k<4;k++) c[j*4+i] += a[k*4+i]*b[j*4+k];
  return c;
}
export const transformPoint = (m,p) => [0,1,2].map(i => m[i]*p[0]+m[4+i]*p[1]+m[8+i]*p[2]+m[12+i]);
export const frameAxis = (m,i) => [m[i*4],m[i*4+1],m[i*4+2]];
function rotation(i,a) {
  const m=identity(),c=Math.cos(a),s=Math.sin(a);
  if (i===0) {m[5]=c;m[6]=s;m[9]=-s;m[10]=c;}
  else if (i===1) {m[0]=c;m[2]=-s;m[8]=s;m[10]=c;}
  else {m[0]=c;m[1]=s;m[4]=-s;m[5]=c;}
  return m;
}
const origins = jointOrigins.map(([p,r]) => {
  const m = multiply(multiply(rotation(2,r[2]),rotation(1,r[1])),rotation(0,r[0]));
  p.forEach((v,i) => m[12+i]=v);
  return m;
});
export function armFrames(degrees) {
  if (!Array.isArray(degrees) || degrees.length!==6 || !degrees.every(Number.isFinite)) throw new TypeError("Six finite joint angles required");
  const frames=[identity()];
  degrees.forEach((a,i) => frames.push(multiply(multiply(frames.at(-1),origins[i]),rotation(2,a*Math.PI/180))));
  return frames;
}
export function framePose(m) {
  const b=Math.acos(Math.min(1,Math.max(-1,m[10]))),singular=Math.abs(Math.sin(b))<1e-5;
  const a=singular ? Math.atan2(m[1]*(b>Math.PI/2?-1:1),m[0]*(b>Math.PI/2?-1:1)) : Math.atan2(m[9],m[8]);
  const c=singular ? 0 : Math.atan2(m[6],-m[2]);
  return [...transformPoint(m,[0,0,0]),a*180/Math.PI,b*180/Math.PI,c*180/Math.PI];
}
export function poseFrame(pose) {
  const m=multiply(multiply(rotation(2,pose[3]*Math.PI/180),rotation(1,pose[4]*Math.PI/180)),rotation(2,pose[5]*Math.PI/180));
  pose.slice(0,3).forEach((v,i) => m[12+i]=v);
  return m;
}

// JointState positions are radians. Use names, never a gripper joint or the
// current topic picker order. Browser elapsed time also expires stalled HTTP.
export function armTelemetry(data, elapsedSeconds=0) {
  const offline = reason => ({live:false,angles:[...defaultArmJoints],reason,receivedAt:null});
  if (!data) return offline("로봇 상태 수신 대기 · 기본 자세");
  if (!["live","monitoring"].includes(data.state) || data.bridge_connected===false) return offline(
    data.state==="stale" ? "관절 수신 지연 · 기본 자세" : "로봇 미연결 · 기본 자세");
  const topic=data.topics?.find(t => t.name===data.display_joint_topic);
  const limit=Number.isFinite(data.config?.stale_seconds) && data.config.stale_seconds>0 ? data.config.stale_seconds : 3;
  if (topic?.state!=="live" || !Number.isFinite(topic.age_seconds) || topic.age_seconds<0 || topic.age_seconds+Math.max(0,elapsedSeconds)>limit)
    return offline("최신 관절 데이터 없음 · 기본 자세");
  const names=topic.message?.name,positions=topic.message?.position;
  if (!Array.isArray(names) || !Array.isArray(positions) || names.length!==positions.length) return offline("6축 관절 데이터 불완전 · 기본 자세");
  const angles=Array(6).fill(null);
  for (let i=0;i<names.length;i++) {
    const match=typeof names[i]==="string" && names[i].match(/(?:^|[/_])joint_?([1-6])$/i);
    if (!match) continue;
    const index=Number(match[1])-1;
    if (angles[index]!==null || !Number.isFinite(positions[i])) return offline("6축 관절 데이터 오류 · 기본 자세");
    angles[index]=positions[i]*180/Math.PI;
  }
  if (!angles.every(Number.isFinite)) return offline("6축 관절 데이터 불완전 · 기본 자세");
  return {live:true,angles,reason:"실제 관절 수신 중",receivedAt:topic.received_at ?? null};
}

// Existing camera preview points are relative to the selected teaching TCP.
// The physical arm remains at BASE zero regardless of the teaching selection.
export function cameraPointToBase(p,camera,anchor) {
  return [0,1,2].map(i => (anchor?.[i] ?? 0)+p.reduce((sum,v,j) => sum+v*camera[j][i],0));
}
