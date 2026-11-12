export function connectDashboardConversation(root,{signal,onRobotVoice=()=>{},onNativeVoice=()=>{}}){
  const ui=Object.fromEntries([...root.querySelectorAll('[data-conversation]')].map(n=>[n.dataset.conversation,n]));
  const sources=[{name:'주문·재고',url:'/api/voice/history',cursor:0,epoch:null},{name:'로봇 명령',url:'/api/robot/preset-voice/history',cursor:0,epoch:null}];
  let timer,busy=false,messages=new Map(),shown=new Map(),unread=0;
  const time=value=>{const d=new Date(value);return Number.isFinite(d.getTime())?d.toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'';};
  async function get(url){const r=await fetch(url,{cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])});if(!r.ok)throw Error();return r.json();}
  function render(){
    const pinned=ui.log.scrollTop+ui.log.clientHeight>=ui.log.scrollHeight-48;
    const list=[...messages.values()].sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at)||a.sequence-b.sequence).slice(-400);
    messages=new Map(list.map(m=>[m.id,m]));let added=0;
    for(const [id,node] of shown)if(!messages.has(id)){node.remove();shown.delete(id);}
    let previous=ui.empty;
    for(const m of list){let node=shown.get(m.id);if(!node){node=document.createElement('article');node.className='dashboard-chat-turn';node.dataset.role=m.role;
      const meta=document.createElement('div'),who=document.createElement('span'),stamp=document.createElement('time'),bubble=document.createElement('p');meta.className='dashboard-chat-meta';bubble.className='dashboard-chat-bubble';
      who.textContent=(m.role==='user'?(m.source==='button'?'사용자 · 버튼 입력':'사용자 · 최종 인식'):m.role==='system'?'상태 안내':m.context==='robot'?'로봇 안내':m.source==='button'?'시스템 응답':'Yuna 응답')+' · '+(m.context==='robot'?'로봇 명령':'주문·재고');stamp.dateTime=m.created_at;stamp.textContent=time(m.created_at);bubble.textContent=m.text;meta.append(who,stamp);node.append(meta,bubble);shown.set(m.id,node);added++;}
      if(previous.nextElementSibling!==node)ui.log.insertBefore(node,previous.nextElementSibling);previous=node;
    }
    ui.empty.hidden=list.length>0;
    if(pinned){ui.log.scrollTop=ui.log.scrollHeight;unread=0;}else unread+=added;
    ui.latest.hidden=!unread;ui.latest.textContent=`새 대화 ${unread}개 · 최신으로`;
  }
  async function poll(){
    if(signal.aborted)return;if(document.hidden){timer=setTimeout(poll,2000);return;}if(busy)return;busy=true;
    try{
      const results=await Promise.allSettled([...sources.map(s=>get(s.url+'?after='+s.cursor)),get('/api/robot/preset-voice/status?heartbeat=true')]);if(signal.aborted)return;
      const failures=[];let native=null,robot=null;
      sources.forEach((source,i)=>{const result=results[i];if(result.status==='rejected'){failures.push(source.name+' 서비스 연결 안 됨');return;}
        const data=result.value;if(source.epoch&&source.epoch!==data.epoch&&!data.reset){source.cursor=0;source.epoch=data.epoch;return;}
        source.epoch=data.epoch;source.cursor=data.cursor;for(const m of data.messages||[])messages.set(m.id,m);if(i===0)native=data.status;
      });
      if(results[2].status==='fulfilled'){robot=results[2].value;onRobotVoice(robot);}else failures.push('로봇 음성 상태 조회 실패');
      onNativeVoice(native);
      render();const current=native?.can_stop?native:robot?.listening?robot:native;
      ui.context.textContent=current?.context==='robot'||robot?.listening?'로봇 명령 모드':'주문·재고 대화';
      ui.state.textContent=!native&&!robot?'서비스 연결 안 됨':current?.state==='disabled'?'음성 기능 꺼짐':current?.can_stop||robot?.listening?({listening:'듣는 중',speaking:'응답 중',processing:'명령 처리 중',preparing:'마이크 준비 중',permission:'마이크 권한 확인 필요'}[current.state]||'음성 대기 중'):'청취 종료';
      ui.notice.textContent=[...new Set([...failures,...(native?.error?[native.error]:[])])].join(' · ')+(failures.length?' · 이미 받은 대화는 유지됩니다.':'');
    }finally{busy=false;if(!signal.aborted)timer=setTimeout(poll,1200);}
  }
  ui.latest.addEventListener('click',()=>{ui.log.scrollTop=ui.log.scrollHeight;unread=0;ui.latest.hidden=true;},{signal});
  signal.addEventListener('abort',()=>clearTimeout(timer),{once:true});void poll();
}
