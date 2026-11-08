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

// Display the measured register, never the goal or YOLO's recommended opening.
export function gripperVisualState(access,table,{sdk=false,busy=false,now=Date.now()}={}) {
  const f=access?.gripper_feedback;
  const result={position:null,opening_mm:null,target:Number.isInteger(access?.gripper_target)&&access.gripper_target>=0?access.gripper_target:null,
    observedAt:null,ageSeconds:null,current:null,mode:null,error:null,reason:"그리퍼 상태 미확인"};
  if(!sdk||access?.connection!=="connected"||!access.initialized||!access.gripper_supported)
    return {...result,reason:"RH-P12 SDK 연결 확인 필요"};
  if(busy)return {...result,reason:"그리퍼 응답 대기 중"};
  if(!f)return result;
  const observed=Date.parse(f.observed_at),age=(now-observed)/1000;
  if(!Number.isFinite(age)||age< -2||age>10)return {...result,observedAt:Number.isFinite(age)&&age>=0?f.observed_at:null,
    ageSeconds:Number.isFinite(age)&&age>=0?Math.floor(age):null,reason:"그리퍼 수신 지연 · 상태 읽기로 확인하세요."};
  result.observedAt=f.observed_at;result.ageSeconds=Math.max(0,Math.floor(age));
  result.error=Number.isFinite(f.error)?f.error:null;
  if(f.state!=="completed"||f.error!==0)return {...result,reason:f.error?"그리퍼 장치 오류 "+f.error:"그리퍼 결과 미확인"};
  if(!Number.isInteger(f.position)||f.position<0||f.position>700)return {...result,reason:"실제 위치 응답 오류"};
  result.position=f.position;result.current=Number.isFinite(f.current_ma)?f.current_ma:null;result.mode=Number.isFinite(f.mode)?f.mode:null;
  const stored=Array.isArray(table?.points)?table.points:[];
  if(stored.some(p=>!p||typeof p!=="object"))return {...result,reason:"실측 벌림표 오류"};
  const points=[...stored].sort((a,b)=>a.position-b.position);
  if(points.length<2)return {...result,reason:"실제 위치 확인 · 실측 벌림표를 등록하세요."};
  if(!points.every((p,i)=>Number.isInteger(p.position)&&p.position>=0&&p.position<=700&&Number.isFinite(p.width_mm)&&p.width_mm>=0&&
    (!i||(p.position>points[i-1].position&&p.width_mm<points[i-1].width_mm))))return {...result,reason:"실측 벌림표 오류"};
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i];
    if(a.position<=f.position&&f.position<=b.position){
      const t=(f.position-a.position)/(b.position-a.position),width=(1-t)*a.width_mm+t*b.width_mm;
      return {...result,opening_mm:width,reason:"최근 실측 상태"};
    }
  }
  return {...result,reason:"실제 위치가 실측 벌림표 범위 밖입니다."};
}

// Existing e0509_simple flange attachment rotates the hand by +90° about Z.
export const gripperMount = flange => multiply(flange,poseFrame([0,0,0,90,0,0]));

// Photo-based illustrative housing and pads. Only the inner opening uses the
// device's calibrated millimetres. These meshes are never used as a TCP or path.
export function mountedGripperParts(opening) {
  const known=Number.isFinite(opening)&&opening>=0&&opening<=1e6,gap=known?opening:42,parts=[];
  function rings(bottom,top,color,kind,wire=false){
    const n=bottom.length,points=[...bottom,...top],faces=[Array.from({length:n},(_,i)=>n-1-i),Array.from({length:n},(_,i)=>n+i),
      ...Array.from({length:n},(_,i)=>[i,(i+1)%n,(i+1)%n+n,i+n])];
    parts.push({points,faces,color,kind,wire});
  }
  function circle(radius,z){return Array.from({length:24},(_,i)=>[radius*Math.cos(i*Math.PI/12),radius*Math.sin(i*Math.PI/12),z]);}
  function section(x,y,z,bevel){return [[-x+bevel,-y],[x-bevel,-y],[x,-y+bevel],[x,y-bevel],[x-bevel,y],[-x+bevel,y],[-x,y-bevel],[-x,-y+bevel]].map(([x,y])=>[x,y,z]);}
  function block(center,size,color,kind,bevel=2,wire=false){const [x,y,z]=center,[w,d,h]=size;
    rings(section(w/2,d/2,-h/2,bevel).map(p=>[p[0]+x,p[1]+y,p[2]+z]),
      section(w/2,d/2,h/2,bevel).map(p=>[p[0]+x,p[1]+y,p[2]+z]),color,kind,wire);
  }
  rings(circle(25,0),circle(25,12),[.39,.47,.49,1],"adapter");
  rings(circle(26,12),circle(26,18),[.16,.67,.78,1],"mount-ring");
  rings(section(32,25,18,6),section(44,30,79,7),[.76,.82,.82,1],"housing");
  block([0,0,83],[90,62,9],[.13,.17,.18,1],"base-plate",3);
  block([0,0,89],[Math.max(82,gap+24),20,6],[.4,.48,.5,1],"slide-rail",2);
  for(const sign of [-1,1]){
    block([sign*(gap/2+7),0,96],[14,25,12],[.49,.56,.57,1],"carriage",2,!known);
    block([sign*(gap/2+6),0,122],[12,25,42],[.09,.13,.14,1],"finger",2,!known);
  }
  return parts;
}
