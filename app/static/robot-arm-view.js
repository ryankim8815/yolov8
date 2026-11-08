import { armTelemetry, armFrames, framePose } from "./robot-arm.js";
import { connectArmRenderer } from "./robot-arm-renderer.js";

export function connectRobotArm(el,signal,onOrbit) {
  const root=el.armView,ui=Object.fromEntries([...root.querySelectorAll("[data-arm]")].map(n=>[n.dataset.arm,n]));
  const renderer=connectArmRenderer(ui.canvas,ui.labels,ui.graphics,signal,onOrbit);
  let active=false,data=null,arrived=performance.now(),sample=armTelemetry(null),guides=null,selected=2,tcp=null,tcpAt=0;
  let pending=null,lastRead=0,source="",signature="",tcpMessage="수신 대기",compact;
  const buttons=Array.from({length:6},(_,i)=>{
    const b=document.createElement("button"),name=document.createElement("span"),value=document.createElement("strong");
    b.type="button";name.textContent="J"+(i+1);b.append(name,value);
    b.addEventListener("click",()=>{selected=i;publish();},{signal});ui.joints.append(b);return b;
  });
  const poseFields={};
  for(const key of ["flange","tcp"])poseFields[key]=[..."XYZABC"].map(axis=>{
    const row=document.createElement("div"),dt=document.createElement("dt"),dd=document.createElement("dd");dt.textContent=axis;dd.textContent="—";row.append(dt,dd);ui[key].append(row);return dd;
  });
  const mm=v=>Number.isFinite(v)?(Math.abs(v)<.05?"0.0":v.toFixed(1)):"—";
  function cancelTcp(reason) {pending?.abort();pending=null;tcp=null;tcpAt=0;tcpMessage=reason;}
  function publish() {
    if(!active)return;
    ui.source.textContent=sample.live?"실제 관절 수신 중":"기본 자세 · 실측 아님";ui.source.dataset.live=sample.live;
    const hint=sample.reason+(sample.live?" · BASE 원점 고정":" [0, 0, 90, 0, 90, 0]°");
    if(el.modelHint.textContent!==hint)el.modelHint.textContent=hint;
    buttons.forEach((b,i)=>{b.setAttribute("aria-pressed",String(i===selected));b.querySelector("strong").textContent=mm(sample.angles[i])+"°";b.setAttribute("aria-label","J"+(i+1)+" 관절 "+mm(sample.angles[i])+"도 강조");});
    ui.array.textContent="["+sample.angles.map(v=>Number(v.toFixed(1))).join(", ")+"]°";
    ui.received.textContent=sample.live&&sample.receivedAt?"관절 수신 · "+new Date(sample.receivedAt).toLocaleTimeString("ko-KR",{hour12:false}):"기본 관절각 · 실측 자세 아님";
    const flange=framePose(armFrames(sample.angles)[6]);
    poseFields.flange.forEach((n,i)=>n.textContent=mm(flange[i]));poseFields.tcp.forEach((n,i)=>n.textContent=mm(tcp?.[i]));
    ui.tcpState.textContent=tcp?"조회 "+new Date(tcpAt).toLocaleTimeString("ko-KR",{hour12:false}):tcpMessage;
    ui.canvas.setAttribute("aria-label","E0509 6축 매니퓰레이터. "+sample.reason+". 관절각 "+sample.angles.map(mm).join(", ")+"도. BASE 원점 고정. "+(tcp?"실측 TCP와 공구 방향 표시.":"TCP 수신 없음. 모델 플랜지 방향 표시."));
    renderer.update({angles:sample.angles,live:sample.live,tcp,selected,guides});
  }
  async function readTcp() {
    if(!active||!sample.live||pending||document.hidden||performance.now()-lastRead<1800)return;
    const controller=new AbortController(),key=source;pending=controller;lastRead=performance.now();
    const timeout=setTimeout(()=>controller.abort(),4000);
    try {
      const response=await fetch("/api/robot/work-points/current",{cache:"no-store",signal:AbortSignal.any([signal,controller.signal])});
      const result=await response.json();
      if(!response.ok||!Array.isArray(result.pose)||result.pose.length!==6||!result.pose.every(Number.isFinite))throw Error("TCP unavailable");
      if(pending!==controller||signal.aborted||!active||key!==source||!armTelemetry(data,(performance.now()-arrived)/1000).live)return;
      tcp=result.pose;tcpAt=Date.now();tcpMessage="";
    } catch {
      if(pending===controller){tcp=null;tcpAt=0;tcpMessage="실측 TCP 조회 불가";}
    } finally {
      clearTimeout(timeout);if(pending===controller){pending=null;publish();}
    }
  }
  function tick() {
    if(!active)return;
    const next=armTelemetry(document.hidden?null:data,(performance.now()-arrived)/1000),changed=JSON.stringify(next)!==signature;
    sample=next;signature=JSON.stringify(next);
    if(!sample.live&& (tcp||pending||tcpMessage!=="수신 없음")){cancelTcp("수신 없음");publish();}
    if(tcp&&Date.now()-tcpAt>4500){tcp=null;tcpAt=0;tcpMessage="실측 TCP 수신 지연";publish();}
    if(changed)publish();
    void readTcp();
  }
  const interval=setInterval(tick,250);
  const observer=new ResizeObserver(()=>{
    const next=root.clientWidth<650||innerHeight<540;
    if(next!==compact){compact=next;ui.readings.open=!compact;}
  });observer.observe(root);
  document.addEventListener("visibilitychange",()=>{if(document.hidden){data=null;cancelTcp("화면 비활성");tick();}},{signal});
  signal.addEventListener("abort",()=>{clearInterval(interval);cancelTcp("수신 없음");observer.disconnect();},{once:true});
  return {
    active(value){active=value;root.hidden=!value;if(!value)cancelTcp("수신 대기");else{tick();publish();}},
    robotStatus(value){
      const key=JSON.stringify([value?.config?.ip,value?.config?.port,value?.config?.namespace,value?.display_joint_topic]);
      if(key!==source){cancelTcp("수신 대기");source=key;lastRead=0;}
      data=value;arrived=performance.now();tick();
    },
    setGuides(value){guides=value;publish();},
    setView:renderer.setView,getView:renderer.getView
  };
}
