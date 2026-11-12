import {watchDetections} from './detection-feed.js';
import {imagePixel} from './robot-camera-frame.js';

export function connectDashboardDepth(root,{signal,onFrame=()=>{}}){
  const ui=Object.fromEntries([...root.querySelectorAll('[data-depth]')].map(n=>[n.dataset.depth,n]));
  const figure=ui.image.parentElement;let packet=null,received=0,available=false,ready=false,remembered=false,request=0,lastInput='';
  const time=value=>{const t=new Date(value);return Number.isFinite(t.getTime())?t.toLocaleTimeString('ko-KR',{hour12:false}):'시각 미확인';};
  function invalidate(message){request++;ready=false;ui.value.textContent='거리 갱신 없음';ui.marker.replaceChildren();figure.dataset.stale='true';ui.last.hidden=!remembered;ui.empty.hidden=false;ui.message.textContent=message;onFrame(null);}
  const stop=watchDetections({image:ui.image,matchedPreview:true,displayMode:'depth',
    onStatus(status,label,reset){
      const input=JSON.stringify([status.session_id,status.camera?.id]);
      if(status.session_id&&lastInput&&input!==lastInput){remembered=false;ui.last.hidden=true;packet=null;}
      if(status.session_id)lastInput=input;
      available=Boolean(status.camera?.display_modes?.includes('depth'));
      ui.state.textContent=status.ready?(available?'Depth 수신 대기':'Depth 지원 안 함'):label;
      if(reset||!available)invalidate(status.ready&&!available?'현재 카메라는 Depth 영상을 제공하지 않습니다.':(status.last_error||label)+(remembered?' · 마지막 프레임':''));
    },
    onDetections(value){packet=value;received=performance.now();ready=true;figure.dataset.stale='false';ui.last.hidden=true;ui.state.textContent='Depth 수신 중';ui.frame.textContent=`Depth #${value.frame_id} · ${time(value.captured_at)}`;
      ui.last.width=value.source_size.width;ui.last.height=value.source_size.height;const context=ui.last.getContext('2d');context.drawImage(ui.image,0,0,ui.last.width,ui.last.height);remembered=true;
      figure.style.aspectRatio=value.source_size.width+'/'+value.source_size.height;onFrame(value);
    },
    onPreview(visible){ui.empty.hidden=visible;if(!visible&&available)invalidate('Depth 수신 끊김'+(remembered?' · 마지막 프레임':''));}
  });
  ui.image.addEventListener('click',async event=>{
    if(!ready||!packet||performance.now()-received>2000)return;
    const pixel=imagePixel(ui.image.getBoundingClientRect(),packet.source_size,event.clientX,event.clientY);if(!pixel)return;
    const [x,y]=pixel.map(Math.floor),selected=packet,serial=++request;ui.value.textContent='선택한 프레임의 깊이 조회 중';
    try{
      const params=new URLSearchParams({session_id:selected.session_id,frame_id:selected.frame_id,x,y});
      const response=await fetch('/api/camera/depth-point?'+params,{cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])});const value=await response.json();
      if(serial!==request||signal.aborted)return;if(!response.ok)throw Error(typeof value.detail==='string'?value.detail:'깊이를 조회하지 못했습니다.');
      ui.value.textContent=`(${x}, ${y}) · ${value.depth_m.toFixed(3)} m · 프레임 #${value.frame_id}`;
      ui.marker.setAttribute('viewBox',`0 0 ${selected.source_size.width} ${selected.source_size.height}`);
      const mark=document.createElementNS('http://www.w3.org/2000/svg','circle');mark.setAttribute('cx',x);mark.setAttribute('cy',y);mark.setAttribute('r','6');mark.setAttribute('fill','none');mark.setAttribute('stroke','#fff');mark.setAttribute('stroke-width','2');ui.marker.replaceChildren(mark);
    }catch(error){if(serial===request&&!signal.aborted)ui.value.textContent=error.message;}
  },{signal});
  const timer=setInterval(()=>{if(ready&&(document.hidden||performance.now()-received>2500))invalidate('Depth 수신 지연 · 마지막 프레임');},500);
  signal.addEventListener('abort',()=>{request++;clearInterval(timer);stop();},{once:true});
  return {sync(rgb,depth=packet){ui.sync.textContent=rgb&&depth&&rgb.session_id===depth.session_id&&rgb.camera_id===depth.camera_id?
    `컬러 좌표에 정렬 · RGB #${rgb.frame_id} / Depth #${depth.frame_id}`+(rgb.frame_id===depth.frame_id?' · 동일 프레임':' · 각 영상의 수신 시점 기준'):'RGB·Depth 동기 정보 대기';}};
}
