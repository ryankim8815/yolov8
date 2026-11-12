import {icon} from './station-nav.js';

const root=document.getElementById('kiosk-app'),storageKey='vision-lab.kiosk.v3';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const validCustomer=c=>Number.isInteger(c?.id)&&c.id>0&&typeof c.name==='string'&&c.name.length>0;
let catalog=null,customers=[],catalogOnline=false,customersOnline=false,busy=false,recovering=false,loading=true;
let notice='',error=false,category='전체',receiptOpen=false,serial=0;
let state={cart:{},screen:'customers',customer:null,candidateId:null,returnScreen:null,buyerOnly:new URLSearchParams(location.search).get('mode')==='buyer',pending:null,receipt:null};
try {
  const current=JSON.parse(sessionStorage.getItem(storageKey));
  const saved=current||JSON.parse(sessionStorage.getItem('vision-lab.kiosk.v2'));
  if(saved&&typeof saved==='object'){
    state.buyerOnly=state.buyerOnly||saved.buyerOnly===true;
    if(current&&validCustomer(saved.customer)&&!saved.customer.is_guest){
      state.customer={id:saved.customer.id,name:saved.customer.name};
      for(const [sku,line] of Object.entries(saved.cart||{}))if(Number.isInteger(line?.quantity)&&line.quantity>0&&line.quantity<=99)state.cart[sku]={quantity:line.quantity};
      state.screen=['customers','products','review'].includes(saved.screen)?saved.screen:'products';
      state.candidateId=Number.isInteger(saved.candidateId)?saved.candidateId:null;
      state.returnScreen=['products','review'].includes(saved.returnScreen)?saved.returnScreen:null;
    }
    if(/^[0-9a-f]{32}$/.test(saved.pending?.request_id)&&Array.isArray(saved.pending.items))state.pending=saved.pending;
    if(/^[0-9a-f]{32}$/.test(saved.receipt?.request_id)&&Array.isArray(saved.receipt.items)&&Number.isInteger(saved.receipt.quantity)&&typeof saved.receipt.pickup_number==='string'){
      state.receipt=saved.receipt;state.screen='complete';
    }
  }
}catch{}
function save(){try{sessionStorage.setItem(storageKey,JSON.stringify(state));}catch{}}
function say(text,failed=false){notice=text;error=failed;}
function selectedCustomer(){return customers.find(c=>c.id===state.customer?.id);}
function hasCustomer(){return customersOnline&&Boolean(selectedCustomer());}
function online(){return catalogOnline&&customersOnline;}
function screen(){if(state.pending||recovering)return 'pending';if(state.screen==='complete'&&state.receipt)return 'complete';return state.screen==='customers'||!hasCustomer()?'customers':state.screen;}
function products(){return catalog?.products||[];}
function lines(){return Object.entries(state.cart).map(([sku,line])=>({...line,sku,product:products().find(p=>p.sku===sku)}));}
function totals(){const items=lines();return {items,quantity:items.reduce((n,l)=>n+l.quantity,0)};}
function problem(line){if(!line.product)return '현재 주문할 수 없는 상품입니다.';if(line.quantity>line.product.available)return '현재 '+Math.max(0,line.product.available)+'개까지 주문할 수 있습니다.';return '';}
function canOrder(){const a=totals();return online()&&hasCustomer()&&!busy&&!state.pending&&a.quantity>0&&a.quantity<=100&&!a.items.some(problem);}
function canReview(){return online()&&hasCustomer()&&!busy&&!state.pending&&totals().quantity>0;}
function art(p){
  const name=p.name;
  if(name.includes('빼빼로'))return '<div class="ks-prop ks-pepero">PEPERO</div>';
  if(name.includes('생수'))return '<div class="ks-prop ks-water"><b>WATER</b></div>';
  if(name.includes('스팸'))return '<div class="ks-prop ks-spam">SPAM</div>';
  if(name.includes('물티슈'))return '<div class="ks-prop ks-wipes"><b>물티슈</b></div>';
  if(name.includes('인형'))return '<div class="ks-prop ks-bear"><div class="ks-bear-head"><span class="ks-bear-eyes"></span><b>•</b></div><div class="ks-bear-body"></div></div>';
  return '<div class="ks-generic-art">'+icon('package-check')+'</div>';
}
function control(action,text,cls='ks-secondary',disabled=false,sku=''){
  const p=products().find(p=>p.sku===sku),labels={add:' 한 개 담기',minus:' 한 개 빼기',remove:' 삭제'};
  const label=p&&labels[action]?p.name+labels[action]:null;
  return '<button type="button" class="'+cls+'" data-action="'+action+'" '+(sku?'data-sku="'+esc(sku)+'"':'')+(label?' aria-label="'+esc(label)+'"':'')+' '+(disabled?'disabled':'')+'>'+text+'</button>';
}
function ownerText(c=state.customer){return c?esc(c.name)+' <span class="ks-customer-id">사용자 #'+c.id+'</span>':'주문자 선택 전';}
function ownerBanner(){return '<section class="ks-owner" aria-label="현재 주문자"><div><span class="ks-avatar">'+esc(state.customer.name[0])+'</span><div><strong>'+esc(state.customer.name)+'님으로 주문 중</strong><p class="ks-small">사용자 #'+state.customer.id+'</p></div></div>'+control('change','주문자 변경','ks-text-button',busy||!!state.pending)+'</section>';}
function customerScreen(){
  const candidate=customersOnline?customers.find(c=>c.id===state.candidateId):null;
  const changing=Boolean(state.customer),different=candidate&&state.customer&&candidate.id!==state.customer.id,clears=different&&totals().quantity>0;
  let content;
  if(loading&&!customersOnline)content='<p role="status">등록된 사용자를 불러오는 중입니다.</p>';
  else if(!customersOnline)content='<div class="ks-customer-empty">'+icon('contact')+'<strong>사용자 목록을 불러오지 못했어요</strong><p>연결을 확인한 후 다시 시도해 주세요.</p>'+control('refresh','다시 불러오기')+'</div>';
  else if(!customers.length)content='<div class="ks-customer-empty">'+icon('user-plus')+'<strong>등록된 사용자가 없습니다</strong><p>매장 직원에게 사용자 등록을 요청해 주세요.</p></div>';
  else content='<div class="ks-customer-cards">'+customers.map(c=>'<button type="button" class="ks-customer-card" data-action="select-customer" data-customer="'+c.id+'" aria-pressed="'+(candidate?.id===c.id)+'"><span class="ks-customer-check">'+(candidate?.id===c.id?'✓':'')+'</span><span class="ks-avatar">'+esc(c.name[0])+'</span><strong>'+esc(c.name)+'</strong><span class="ks-small">사용자 #'+c.id+'</span></button>').join('')+'</div>';
  const shortName=candidate&&candidate.name.length<=12?esc(candidate.name)+'님으로':'선택한 사용자로';
  const label=candidate?(clears?'장바구니 비우고 주문자 변경':shortName+' '+(changing?'계속 주문':'주문 시작')):'주문자를 먼저 선택해 주세요';
  return '<div class="ks-customer-layout"><section class="ks-customer-list" aria-label="등록 사용자 목록"><div class="ks-customer-caption"><span>사용자 관리에 등록된 사용자</span><span>'+(customersOnline?customers.length+'명':'—')+'</span></div>'+content+'<p class="ks-small">동명이인은 사용자 번호로 구분해 주세요.</p></section><aside class="ks-cart"><div class="ks-cart-title"><h2>선택한 주문자</h2></div><div class="ks-selected-customer">'+(candidate?'<span class="ks-avatar">'+esc(candidate.name[0])+'</span><strong>'+esc(candidate.name)+'</strong><span class="ks-small">사용자 #'+candidate.id+'</span>':'<p class="ks-small">본인 이름을 선택하면<br>주문을 시작할 수 있어요.</p>')+'</div><div class="ks-summary">'+(clears?'<p class="ks-customer-warning">주문자가 바뀌면 기존 장바구니 '+totals().quantity+'개를 비우고 새 주문을 시작합니다.</p>':'')+control('start-customer',label,'ks-primary',!candidate||busy)+(changing?control('cancel-customer',(state.customer.name.length<=12?esc(state.customer.name)+'님 주문 계속하기':'기존 주문 계속하기'),'ks-text-button',!hasCustomer()):'')+'<p class="ks-summary-note">선택한 사용자에게 주문이 연결됩니다.</p></div></aside></div>';
}
function cartRows(){
  const a=totals();
  return a.items.length?a.items.map(line=>{
    const p=line.product,invalid=problem(line),locked=busy||!!state.pending;
    return '<div class="ks-cart-row"><div class="ks-cart-row-head"><strong>'+esc(p?.name||line.sku)+'</strong><span>'+line.quantity+esc(p?.unit||'개')+'</span></div><div class="ks-row-controls"><div class="ks-qty" aria-label="'+esc(p?.name||line.sku)+' 수량">'+control('minus','−','',locked,line.sku)+'<output>'+line.quantity+'</output>'+control('add','+','',locked||!online()||!p||line.quantity>=Math.min(p.available,99)||a.quantity>=100,line.sku)+'</div>'+control('remove','삭제','ks-remove',locked,line.sku)+'</div>'+(invalid?'<p class="ks-line-error">'+esc(invalid)+'</p>':'')+'</div>';
  }).join(''):'<div class="ks-cart-empty">'+icon('shopping-bag')+'<p>아직 담은 상품이 없어요.</p><span>원하는 상품의 담기를 눌러주세요.</span></div>';
}
function totalBlock(review){
  const a=totals();
  return '<div class="ks-summary"><p class="ks-cart-owner">주문자 · '+ownerText()+'</p><div class="ks-summary-line"><span>상품 종류</span><span>'+a.items.length+'종</span></div><div class="ks-summary-line"><span>총 주문 수량</span><strong>'+a.quantity+'개</strong></div>'+control(review?'submit':'review',review?(state.customer.name.length<=12?esc(state.customer.name)+'님의 주문 접수':'선택한 주문자로 접수'):'주문 확인'+icon('arrow-right'),'ks-primary',review?!canOrder():!canReview())+'<p class="ks-summary-note">주문 후 수령번호가 발급됩니다.</p>'+(review?control('back','상품 선택으로 돌아가기','ks-text-button',busy||!!state.pending):'')+'</div>';
}
function productScreen(){
  const a=totals(),touch=matchMedia('(max-width:950px)').matches,cats=['전체',...(catalog?.categories||[])];
  const listing='<section class="ks-catalog" aria-label="주문할 상품 선택"><div class="ks-categories" aria-label="상품 분류">'+cats.map(c=>'<button class="ks-filter" type="button" data-action="category" data-category="'+esc(c)+'" aria-pressed="'+(category===c)+'">'+esc(c)+'</button>').join('')+'</div><div class="ks-products">'+products().filter(p=>category==='전체'||p.category===category).map(p=>{
    const sold=p.available<=0,max=(state.cart[p.sku]?.quantity||0)>=Math.min(p.available,99);
    return '<article class="ks-item" data-sold="'+sold+'"><div class="ks-art" role="img" aria-label="'+esc(p.name)+' 상품 일러스트"><span class="ks-stock">'+Math.max(0,p.available)+'개 주문 가능</span>'+art(p)+(sold?'<span class="ks-sold">품절</span>':'')+'</div><div class="ks-item-info"><h2 class="ks-item-name">'+esc(p.name)+'</h2><p class="ks-item-unit">1'+esc(p.unit)+'</p><div class="ks-item-bottom">'+control('add',icon('plus')+(sold?'품절':'담기'),'ks-add',!online()||busy||!!state.pending||sold||max||a.quantity>=100,p.sku)+'</div></div></article>';
  }).join('')+'</div>'+(!products().length?'<p class="ks-desc">현재 주문할 수 있는 상품이 없습니다.</p>':'')+'</section>';
  if(touch)return '<div class="ks-workspace">'+listing+'<div class="ks-touch-summary"><div><p class="ks-small">선택한 상품 '+a.items.length+'종</p><strong class="ks-touch-total">총 '+a.quantity+'개</strong></div>'+control('review','장바구니 확인'+icon('arrow-right'),'ks-primary',!canReview())+'</div></div>';
  return '<div class="ks-workspace">'+listing+'<aside class="ks-cart" aria-label="장바구니"><div class="ks-cart-title"><h2>장바구니</h2><span>'+a.items.length+'종 · '+a.quantity+'개</span></div><div class="ks-cart-items">'+cartRows()+'</div>'+totalBlock(false)+'</aside></div>';
}
function reviewScreen(){
  return '<div class="ks-review"><div class="ks-review-details"><section class="ks-review-section"><h2>이 사용자의 주문으로 접수합니다</h2><div class="ks-review-owner"><span class="ks-avatar">'+esc(state.customer.name[0])+'</span><div><strong>'+esc(state.customer.name)+'님</strong><p class="ks-small">사용자 #'+state.customer.id+' · 사용자 관리 등록 정보</p></div></div></section><section class="ks-review-section"><h2>주문 상품</h2>'+cartRows()+'</section><p class="ks-small">수령 장소 · '+esc(catalog.pickup)+'</p></div><aside class="ks-cart" aria-label="주문 수량 확인"><div class="ks-cart-title"><h2>주문자와 수량 확인</h2></div>'+totalBlock(true)+'</aside></div>';
}
function completeScreen(){
  const r=state.receipt,c=r.customer,ready=r.state==='awaiting_dispatch',preparing=r.state==='packing';
  const who=validCustomer(c)?esc(c.name)+'님':'이전 주문자 확인 중';
  return '<section class="ks-success" aria-label="주문 접수 결과"><span class="ks-success-icon">'+icon('circle-check')+'</span><div><p class="ks-eyebrow">ORDER '+(ready?'READY':'RECEIVED')+'</p><h1>'+who+'의<br>'+(ready?'상품이 준비되었어요':'주문이 접수되었어요')+'</h1><p class="ks-desc">'+(ready?'수령대에서 아래 번호를 알려주세요.':preparing?'상품을 준비하고 있습니다.':'주문 번호를 기억해 주세요. 상품 준비를 기다리고 있어요.')+'</p></div><div class="ks-ticket"><span class="ks-small">수령번호</span><strong class="ks-ticket-number">'+esc(r.pickup_number)+'</strong><strong class="ks-ticket-customer">'+(validCustomer(c)?ownerText(c):'주문자 정보를 확인하고 있습니다.')+'</strong><p class="ks-small">'+r.items.length+'종 · 총 '+r.quantity+'개</p></div><div class="ks-track"><strong>● 주문 접수</strong><i></i><'+(preparing?'strong':'span')+'>상품 준비</'+(preparing?'strong':'span')+'><i></i><'+(ready?'strong':'span')+'>수령 안내</'+(ready?'strong':'span')+'></div><div class="ks-success-actions">'+control('receipt',receiptOpen?'주문 내용 접기':'주문 내용 보기')+control('new','처음으로'+icon('arrow-right'),'ks-primary')+'</div>'+(receiptOpen?'<div class="ks-receipt">'+r.items.map(p=>'<div><span>'+esc(p.name)+'</span><strong>'+p.quantity+esc(p.unit)+'</strong></div>').join('')+'</div>':'')+'<p class="ks-small">수령 장소: '+esc(r.pickup)+' · 다음 주문은 사용자 선택부터 시작합니다.</p></section>';
}
function pendingScreen(){
  const body=state.pending,owner=state.customer?.id===body?.customer_id?ownerText():body?.customer_id?'사용자 #'+body.customer_id:'이전 방문 고객 주문';
  return '<section class="ks-pending-order" aria-label="접수 결과 확인"><h2>'+owner+'</h2><p>접수 결과를 확인하기 전에는 주문자를 바꾸거나 새 주문을 시작할 수 없습니다.</p>'+control('retry','동일 주문 접수 결과 확인','ks-primary',busy||recovering)+'<p class="ks-small">같은 주문 요청 번호로 확인하여 중복 접수를 방지합니다.</p></section>';
}
function progress(current){return '<ol class="ks-order-steps" aria-label="주문 진행 단계">'+['주문자 선택','상품 선택','주문 확인','완료'].map((label,i)=>'<li '+(i+1===current?'aria-current="step"':'')+'><span>'+(i+1)+'</span>'+label+'</li>').join('')+'</ol>';}
function render(){
  const focused=document.activeElement?.closest('#kiosk-app [data-action]'),focus=focused?{...focused.dataset}:null;
  document.body.classList.toggle('kiosk-buyer',state.buyerOnly);
  const view=screen(),step=({customers:1,products:2,review:3,pending:3,complete:4})[view];
  const title=view==='customers'?(state.customer?'주문자를 변경할까요?':'누구의 주문인가요?'):view==='products'?'필요한 상품을 골라보세요':view==='pending'?'주문 접수 결과를 확인하고 있습니다':'주문자와 상품을 확인해 주세요';
  const description=view==='customers'?'사용자 관리에 등록된 본인 이름을 선택해 주세요.':view==='products'?'선택한 주문자에게 상품과 수량이 연결됩니다.':'이름과 사용자 번호를 확인한 후 주문을 요청하세요.';
  root.innerHTML='<section class="ks-product '+(matchMedia('(max-width:950px)').matches?'ks-touch':'')+'"><main class="ks-main"><header class="ks-top"><div class="ks-wordmark">'+icon('shopping-bag')+'Vision Shop <span>SELF ORDER</span></div><div class="ks-person"><span class="ks-tag">구매자</span>'+(state.customer?ownerText():'주문자 선택 전')+control('mode',state.buyerOnly?'메뉴 보기':'구매자 전용 보기','ks-text-button')+'</div></header>'+progress(step)+(view==='complete'?'':'<div class="ks-heading"><div><p class="ks-eyebrow">'+(step===1?'START WITH YOUR NAME':'YOUR ORDER')+'</p><h1>'+title+'</h1><p class="ks-desc">'+description+'</p></div></div>')+'<div class="ks-feedback"><p class="ks-notice" role="'+(error?'alert':'status')+'" aria-live="polite">'+esc(notice)+'</p>'+(!online()&&view!=='pending'?control('refresh','연결 다시 확인'):'')+'</div>'+(['products','review'].includes(view)?ownerBanner():'')+(view==='customers'?customerScreen():view==='pending'?pendingScreen():view==='complete'?completeScreen():catalog?(view==='review'?reviewScreen():productScreen()):'<p role="status">상품을 불러오는 중입니다.</p>')+'<footer class="ks-foot"><span>Vision Shop · 상품과 수량으로 주문</span>'+control('help','수령 안내','ks-text-button')+'</footer></main></section>';
  root.dataset.screen=view;root.dataset.online=online();root.dataset.customerId=state.customer?.id||'';
  if(focus){const el=[...root.querySelectorAll('[data-action]')].find(el=>el.dataset.action===focus.action&&el.dataset.sku===focus.sku&&el.dataset.customer===focus.customer&&el.dataset.category===focus.category);if(el&&!el.disabled)el.focus({preventScroll:true});}
}
async function api(path,body){
  const response=await fetch('/api/kiosk'+path,{method:body?'POST':'GET',cache:'no-store',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
  const data=await response.json();
  if(!response.ok){const e=Error(typeof data.detail==='string'?data.detail:'주문 내용을 확인해 주세요.');e.status=response.status;throw e;}
  return data;
}
async function refresh(){
  const ticket=++serial;
  const result=await Promise.allSettled([api('/catalog'),api('/customers')]);if(ticket!==serial)return;
  const previous=JSON.stringify([catalog,customers,catalogOnline,customersOnline,loading]);
  if(result[0].status==='fulfilled'){catalog=result[0].value;catalogOnline=true;}else catalogOnline=false;
  if(result[1].status==='fulfilled'){
    customers=result[1].value.customers.filter(validCustomer);customersOnline=true;
    if(!customers.some(c=>c.id===state.candidateId))state.candidateId=null;
    const selected=selectedCustomer();if(selected&&!state.pending&&state.screen!=='complete'){state.customer={...selected};save();}
  }else customersOnline=false;
  loading=false;
  if(!catalogOnline||!customersOnline)say(!customersOnline?'사용자 목록에 연결할 수 없습니다. 연결을 확인하고 다시 시도하세요.':'상품 서버에 연결할 수 없습니다. 연결을 확인하고 다시 시도하세요.',true);
  else if(notice.startsWith('사용자 목록에 연결할 수')||notice.startsWith('상품 서버에 연결할 수'))say('연결을 복구했습니다.');
  if(previous!==JSON.stringify([catalog,customers,catalogOnline,customersOnline,loading]))render();
}
function sameOrder(receipt,payload){
  const canonical=items=>items.map(p=>[p.sku,p.quantity]).sort((a,b)=>a[0].localeCompare(b[0]));
  return (!payload.customer_id||receipt.customer?.id===payload.customer_id)&&JSON.stringify(canonical(receipt.items))===JSON.stringify(canonical(payload.items));
}
function accept(receipt){
  if(state.pending&&!sameOrder(receipt,state.pending))throw Error('접수된 주문의 주문자 또는 상품이 현재 요청과 다릅니다. 매장 직원에게 접수 내용을 확인해 주세요.');
  state.receipt=receipt;state.pending=null;state.cart={};state.customer=receipt.customer&&!receipt.customer.is_guest?{id:receipt.customer.id,name:receipt.customer.name}:null;state.screen='complete';state.returnScreen=null;receiptOpen=false;say('주문을 접수했습니다. 이름과 수령번호를 확인해 주세요.');save();
}
async function lookupPending(){
  const body=state.pending;if(!body)return true;
  try{accept(await api('/orders/'+body.request_id));return true;}
  catch(e){if(e.status!==404)throw e;
    if(!Number.isInteger(body.customer_id)){state.pending=null;state.cart={};state.customer=null;state.candidateId=null;state.screen='customers';say('이전 방문 고객 주문이 접수되지 않았습니다. 주문자를 선택해 새 주문을 시작하세요.');save();return true;}
    return false;
  }
}
async function submit(retry=false){
  if(busy||recovering||(!retry&&!canOrder()))return;
  if(!state.pending)state.pending={request_id:crypto.randomUUID().replaceAll('-',''),customer_id:state.customer.id,items:lines().map(l=>({sku:l.sku,quantity:l.quantity}))};
  busy=true;say('주문 접수 결과를 확인하고 있습니다.');save();render();
  try{if(!retry||!await lookupPending())accept(await api('/orders',state.pending));}
  catch(e){
    if(e.status>=400&&e.status<500){
      try{if(!await lookupPending()){state.pending=null;state.screen='review';save();say(e.message,true);}}
      catch(check){say(check.message||'접수 결과를 확인하지 못했습니다. 같은 주문으로 다시 확인해 주세요.',true);}
    }else say(e.message?.startsWith('접수된 주문의')?e.message:'접수 결과를 확인하지 못했습니다. 동일 주문 확인 버튼으로 다시 확인해 주세요.',true);
  }finally{busy=false;render();void refresh();}
}
function startCustomer(){
  const next=customersOnline?customers.find(c=>c.id===state.candidateId):null;if(!next)return;
  const changed=state.customer?.id!==next.id;
  if(changed){state.cart={};category='전체';say('선택한 주문자에게 주문이 연결됩니다.');}
  state.customer={...next};state.screen=changed?'products':state.returnScreen||'products';state.returnScreen=null;save();
}
root.addEventListener('click',async event=>{
  const b=event.target.closest('[data-action]');if(!b||b.disabled)return;
  const action=b.dataset.action,sku=b.dataset.sku,p=products().find(p=>p.sku===sku);say('');
  if(action==='submit'||action==='retry'){await submit(action==='retry');return;}
  if(action==='refresh'){await refresh();return;}
  if(action==='mode'){state.buyerOnly=!state.buyerOnly;save();render();return;}
  if(state.pending||busy||recovering)return;
  if(action==='select-customer'&&customersOnline)state.candidateId=Number(b.dataset.customer);
  if(action==='start-customer')startCustomer();
  if(action==='change'){state.returnScreen=state.screen;state.screen='customers';state.candidateId=state.customer.id;}
  if(action==='cancel-customer'&&hasCustomer()){state.screen=state.returnScreen||'products';state.returnScreen=null;}
  if(action==='add'&&p&&online()&&hasCustomer()&&totals().quantity<100){const next=(state.cart[sku]?.quantity||0)+1;if(next<=Math.min(99,p.available)){state.cart[sku]={quantity:next};say(p.name+' '+next+'개를 담았어요.');}}
  if(action==='minus'&&state.cart[sku]){if(--state.cart[sku].quantity===0)delete state.cart[sku];}
  if(action==='remove')delete state.cart[sku];
  if(action==='category')category=b.dataset.category;
  if(action==='review'&&canReview())state.screen='review';
  if(action==='back')state.screen='products';
  if(action==='receipt')receiptOpen=!receiptOpen;
  if(action==='new'){state.cart={};state.customer=null;state.candidateId=null;state.receipt=null;state.returnScreen=null;state.screen='customers';category='전체';}
  if(action==='help')say('본인 이름과 사용자 번호를 확인해 주문하세요. 주문 후에는 수령번호를 매장 직원에게 알려주세요.');
  save();render();
});
async function poll(){
  if(!document.hidden&&!busy&&!recovering){
    await refresh();
    if(state.receipt&&state.screen==='complete')try{const value=await api('/orders/'+state.receipt.request_id);if(JSON.stringify(value)!==JSON.stringify(state.receipt)){state.receipt=value;save();render();}}catch{say('주문 상태를 갱신하지 못했습니다. 이름과 수령번호는 유지됩니다.',true);render();}
  }
  setTimeout(poll,4000);
}
window.addEventListener('resize',()=>render());
render();
void(async()=>{recovering=Boolean(state.pending);render();await refresh();if(state.pending){try{if(!await lookupPending())say('이전 주문의 접수 결과를 확인해 주세요. 동일 주문 확인 버튼으로 중복 없이 다시 확인할 수 있습니다.',true);}catch(e){say(e.message||'이전 주문 결과를 확인하지 못했습니다.',true);}}recovering=false;render();void poll();})();
