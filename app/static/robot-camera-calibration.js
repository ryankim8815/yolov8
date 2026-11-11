import {api} from './robot-camera-frame.js';
import {armFrames,armTelemetry,transformPoint} from './robot-arm.js';
import {e0509Model} from './robot-e0509-model.js';

// OpenCV color optics: BASE mm -> color-camera mm -> Brown-Conrady pixel.
export function projectBase(point,calibration){
  const m=calibration.camera_from_base;
  const v=[0,1,2].map(i=>m[i][0]*point[0]+m[i][1]*point[1]+m[i][2]*point[2]+m[i][3]);
  if(v[2]<=10)return null;
  let x=v[0]/v[2],y=v[1]/v[2];const r=x*x+y*y,[k1,k2,p1,p2,k3]=calibration.distortion;
  const f=1+k1*r+k2*r*r+k3*r*r*r;
  const xx=x*f+2*p1*x*y+p2*(r+2*x*x),yy=y*f+p1*(r+2*y*y)+2*p2*x*y;
  const k=calibration.intrinsics;return [k[0][0]*xx+k[0][2],k[1][1]*yy+k[1][2]];
}

export function connectCameraCalibration(root,signal){
  const get=key=>root.querySelector(`[data-marker="${key}"]`);
  let state=null,dirty=false,busy=false,preview=false,timer,parts,operation=0,disposed=false;
  const corners=get('corners');
  for(let i=0;i<4;i++){
    const row=document.createElement('tr'),label=document.createElement('th');label.scope='row';label.textContent=i;row.append(label);
    for(const axis of ['X','Y','Z']){
      const td=document.createElement('td'),input=document.createElement('input');input.type='number';input.step='any';input.required=true;
      input.min='-5000';input.max='5000';input.setAttribute('aria-label',`마커 ${i}번 모서리 BASE ${axis}`);td.append(input);row.append(td);
    }
    const td=document.createElement('td'),read=document.createElement('button');read.type='button';read.textContent='현재 TCP';read.setAttribute('aria-label',`${i}번 모서리에 현재 TCP 좌표 입력`);
    read.addEventListener('click',()=>action(async()=>{const data=await api('work-points/current?monitor_only=true');row.querySelectorAll('input').forEach((input,j)=>input.value=data.pose[j]);changed();}));td.append(read);row.append(td);corners.append(row);
  }
  function message(value,error=false){get('status').textContent=value;get('status').dataset.state=error?'error':state?.state||'required';}
  function buttons(){
    for(const input of get('form').querySelectorAll('input,button'))input.disabled=busy;
    get('run').disabled=busy||dirty||!state?.enabled||!state?.config||state?.busy;
    get('save').disabled=busy||!state;get('reload').disabled=busy;
  }
  function showStatus(data){
    state=data;message(data.state==='ready'?'보정 완료 · '+data.message:data.message);
    const q=data.result?.quality;
    get('quality').textContent=q?`${data.state==='ready'?'':'이전 보정 · '}${q.frames}장 · 영상 오차 ${q.reprojection_px.toFixed(2)} px · 깊이 오차 ${q.depth_rms_mm.toFixed(1)} mm · 위치 흔들림 ${q.translation_jitter_mm.toFixed(1)} mm · 회전 흔들림 ${q.rotation_jitter_deg.toFixed(2)}° · 보정 ${new Date(data.calibrated_at).toLocaleString('ko-KR')}`:'검증 기준: 영상 ≤1.5 px · 깊이 ≤10 mm · 위치 흔들림 ≤5 mm · 회전 흔들림 ≤1°';
    buttons();
  }
  function printLink(){get('print').href=`/api/camera/marker/marker.svg?marker_id=${encodeURIComponent(get('id').value)}&side_mm=${encodeURIComponent(get('side').value)}`;}
  function changed(){dirty=true;printLink();buttons();message('변경한 마커 좌표를 저장한 뒤 캘리브레이션하세요.');}
  get('form').addEventListener('input',changed);
  async function action(fn){
    if(busy||disposed)return;operation++;clearTimeout(timer);busy=true;buttons();
    try{await fn();}catch(error){message(error.message,true);}finally{busy=false;buttons();if(preview&&!disposed){clearTimeout(timer);timer=setTimeout(tick,0);}}
  }
  async function load(){
    const data=await api('camera-calibration');
    get('enabled').checked=data.enabled;
    get('id').value=data.config?.marker_id??0;get('side').value=data.config?.side_mm??100;
    corners.querySelectorAll('tr').forEach((row,i)=>row.querySelectorAll('input').forEach((input,j)=>input.value=data.config?.corners_base_mm[i][j]??''));
    dirty=false;printLink();showStatus(data);
  }
  get('reload').addEventListener('click',()=>action(load));
  get('form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{
    const config={marker_id:Number(get('id').value),side_mm:Number(get('side').value),corners_base_mm:[...corners.rows].map(row=>[...row.querySelectorAll('input')].map(input=>Number(input.value)))};
    const data=await api('camera-calibration','PUT',{revision:state.revision,enabled:get('enabled').checked,config});dirty=false;showStatus(data);
  });});
  get('run').addEventListener('click',()=>action(async()=>{
    message('보정 중 · 카메라·마커·로봇을 고정하세요.');
    try{showStatus(await api('camera-calibration/run','POST',{revision:state.revision}));}
    catch(error){const text=error.message;await load();message(text,true);}
  }));
  function decode(value,Type){return new Type(Uint8Array.from(atob(value),c=>c.charCodeAt(0)).buffer);}
  function draw(data){
    const canvas=get('overlay'),cal=data.calibration;canvas.width=data.status.result?.camera.width||get('image').naturalWidth||640;canvas.height=data.status.result?.camera.height||get('image').naturalHeight||480;
    const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);
    const telemetry=armTelemetry(data.robot);
    if(!cal||!telemetry.live){get('view-status').textContent=data.error||'보정 완료와 실제 6축 관절 수신 후 모델을 중첩합니다.';return;}
    const frames=armFrames(telemetry.angles);
    parts??=e0509Model.parts.map(p=>({link:p.link,vertices:decode(p.v,Int16Array),indices:decode(p.f,Uint16Array)}));
    ctx.strokeStyle='#6ae1c3';ctx.globalAlpha=.5;ctx.lineWidth=.6;ctx.beginPath();
    for(const part of parts){
      const vertex=index=>projectBase(transformPoint(frames[part.link],[...part.vertices.slice(index*3,index*3+3)].map(x=>x/10)),cal);
      for(let i=0;i<part.indices.length;i+=9){const ps=[0,1,2].map(j=>vertex(part.indices[i+j]));if(ps.some(p=>!p||p.some(x=>!Number.isFinite(x))))continue;
        if(ps.every(p=>p[0]<0||p[1]<0||p[0]>canvas.width||p[1]>canvas.height))continue;
        ctx.moveTo(...ps[0]);ctx.lineTo(...ps[1]);ctx.lineTo(...ps[2]);ctx.closePath();}
    }
    ctx.stroke();ctx.globalAlpha=1;
    get('view-status').textContent=`영상 #${data.frame_id} · ${new Date(data.captured_at).toLocaleTimeString('ko-KR')} · 실제 관절 수신 ${new Date(telemetry.receivedAt).toLocaleTimeString('ko-KR')}`;
  }
  async function tick(){
    if(!preview)return;
    if(document.hidden||!root.getClientRects().length||busy){timer=setTimeout(tick,700);return;}
    const version=operation;
    try{const data=await api('camera-calibration/view');
      if(preview&&!busy&&!disposed&&version===operation){get('image').src=data.image;if(!dirty)showStatus(data.status);draw(data);}
    }catch(error){if(preview&&!busy&&!disposed&&version===operation){get('view-status').textContent=error.message;get('image').removeAttribute('src');const canvas=get('overlay');canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);}}
    if(preview&&!disposed&&version===operation)timer=setTimeout(tick,1000);
  }
  get('preview').addEventListener('click',()=>{operation++;preview=!preview;get('view').hidden=!preview;get('preview').textContent=preview?'중첩 보기 닫기':'영상·로봇 중첩 보기';clearTimeout(timer);if(preview)tick();});
  const close=()=>{operation++;preview=false;clearTimeout(timer);get('view').hidden=true;get('preview').textContent='영상·로봇 중첩 보기';};
  window.addEventListener('pagehide',close,{signal});signal?.addEventListener('abort',()=>{disposed=true;close();},{once:true});
  action(load);
}
