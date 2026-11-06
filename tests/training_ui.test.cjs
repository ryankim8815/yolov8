// Exercise async button intent without a camera, network, DOM library or build step.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(gatePath, failStop=false, datasets=[]) {
  const elements = new Map(), calls = [], intervals = [];
  let release, cameraOn = false, collecting = false;
  const gate = new Promise(resolve => release = resolve);
  class Element {
    constructor() {this.value='';this.dataset={};this.options=[];this.handlers={};this.classList={toggle(){}};this.style={};}
    addEventListener(name, handler) {this.handlers[name] = handler;}
    replaceChildren() {this.options=[];this.value='';}
    append(...items) {for(const item of items){if(item instanceof Option){this.options.push(item);if(this.options.length===1)this.value=item.value;}}}
  }
  class Option {constructor(text,value){this.text=text;this.value=value;}}
  const el = id => {if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const tabs = ['live','collect','jobs','models'].map(name=>{const button=new Element();button.dataset.tab=name;return button;});
  const model = {id:'base',name:'base',classes:[],formats:{mps:{state:'ready'}}};
  async function fetch(url, options={}) {
    calls.push({url,method:options.method||'GET'});
    if(url===gatePath)await gate;
    if(url==='/api/camera/start')cameraOn=true;
    if(url==='/api/camera/stop'){cameraOn=false;collecting=false;}
    if(url==='/api/collections/c1/start')collecting=true;
    if(url==='/api/collections/c1/stop'){
      if(failStop)return {ok:false,json:async()=>({detail:'stop failed'})};
      collecting=false;
    }
    let data={};
    if(url==='/api/classes')data=[{id:'class1',name:'class'}];
    if(url==='/api/capture-groups')data=[{id:'group1',name:'group'}];
    if(url==='/api/collections')data=options.method==='POST'?{id:'c1'}:[];
    if(url==='/api/datasets')data=datasets;
    if(url==='/api/training/jobs')data=[];
    if(url==='/api/models')data={backend:'mps',models:[model]};
    if(url==='/api/status')data={ready:true,state:'ready'};
    return {ok:true,json:async()=>data};
  }
  const context=vm.createContext({
    document:{getElementById:el,createElement:()=>new Element(),createTextNode:text=>text,
      querySelectorAll:selector=>selector==='[data-tab]'?tabs:[]},
    window:{addEventListener(){}},Option,fetch,console,
    location:{protocol:'http:',host:'localhost'},WebSocket:class {},
    setInterval(fn){intervals.push(fn);},setTimeout:(fn)=>setImmediate(fn),
    currentStatus:{model_version:'base',collection:{id:null}}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../app/static/training.js'),'utf8'),context);
  const click=id=>el(id).handlers.click();
  return {calls,release,click,el,tabs,heartbeat:()=>intervals.forEach(fn=>fn()),state:()=>({cameraOn,collecting}),async ready(){
    await tick();tabs.find(b=>b.dataset.tab==='collect').handlers.click();await tick();
    el('interval').value='250';el('collection-conf').value='.5';
  }};
}

for(const scenario of ['photo stop while preparing','camera off while preparing','photo stop while start request is pending']) {
  test(scenario,async()=>{
    const gatePath=scenario.endsWith('pending')?'/api/collections/c1/start':'/api/camera/start';
    const h=harness(gatePath);await h.ready();
    const starting=h.click('collect-start');
    for(let i=0;i<20&&!h.calls.some(c=>c.url===gatePath);i++)await tick();
    assert.ok(h.calls.some(c=>c.url===gatePath));
    const stopping=h.click(scenario.startsWith('camera')?'camera-off':'collect-stop');
    await tick();h.release();await Promise.all([starting,stopping]);
    assert.equal(h.state().collecting,false,'A completed stop must not be followed by a late photo start');
    if(scenario.startsWith('camera'))assert.equal(h.state().cameraOn,false,'A late start must not reopen the camera');
    if(!scenario.endsWith('pending'))assert.equal(h.calls.filter(c=>c.url==='/api/collections/c1/start').length,0);
  });
}

test('failed cancellation is never presented as a successful stop',async()=>{
  const h=harness('/api/collections/c1/start',true);await h.ready();
  const starting=h.click('collect-start');
  for(let i=0;i<20&&!h.calls.some(c=>c.url==='/api/collections/c1/start');i++)await tick();
  const stopping=h.click('collect-stop');await tick();h.release();
  await Promise.all([starting,stopping]);
  assert.equal(h.el('action-message').textContent,'stop failed');
});

test('failed stop does not keep renewing the photo lease',async()=>{
  const h=harness(null,true);await h.ready();
  await h.click('collect-start');
  h.heartbeat();await tick();
  const count=()=>h.calls.filter(c=>c.url==='/api/collections/c1/heartbeat').length;
  assert.equal(count(),1);
  await h.click('collect-stop');
  h.heartbeat();await tick();
  assert.equal(count(),1,'A failed stop must allow the server lease to expire');
  assert.equal(h.el('action-message').textContent,'stop failed');
});

test('saved single-environment snapshot is visible while training requires validation',async()=>{
  const common={created_at:'2026-11-06',classes:[{name:'시계'}]};
  const h=harness(null,false,[
    {...common,id:'legacy',counts:{train:8,val:2}},
    {...common,id:'single',status:'awaiting_validation',counts:{train:18,val:0}}
  ]);
  await h.ready();
  const select=h.el('dataset-select');
  assert.equal(select.value,'single');
  assert.match(select.options[0].text,/검증 자료 대기/);
  assert.equal(h.el('train-start').disabled,true);
  assert.match(h.el('dataset-note').textContent,/사진과 라벨은 저장/);
  select.value='legacy';select.handlers.change();
  assert.equal(h.el('train-start').disabled,false);
});
