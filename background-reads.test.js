import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSimplePetClient } from './client-source.js';
import { DEFAULT_PREFERENCES } from './preferences.js';
const settle=()=>new Promise(r=>setImmediate(r));
const key='a'.repeat(16),hash=id=>createHash('sha256').update(`${key}:${id}`).digest('hex');
function harness(send){
 const cells=[],cleanups=[];let index=0,tree;
 const React={createElement(type,props,...children){return{type,props:props??{},children:children.flat().filter(v=>v!==false&&v!=null)};},useState(initial){const n=index++;if(!(n in cells))cells[n]=initial;return[cells[n],v=>{cells[n]=typeof v==='function'?v(cells[n]):v;}];},useRef(initial){return cells[index++]??={current:initial};},useEffect(fn){const n=index++;if(!(n in cells)){cells[n]=true;cleanups.push(fn());}}};
  let backgroundTick, backgroundClock=0; const services={scheduleAccountReads:fn=>{backgroundTick=fn;return()=>{};},accountReadNow:()=>backgroundClock};
 const component=createSimplePetClient(React,send,services),render=()=>{index=0;return tree=component.SimplePetSettings();};
 const nodes=(n=tree)=>n&&typeof n==='object'?[n,...n.children.flatMap(nodes)]:[],text=(n=tree)=>n&&typeof n==='object'?n.children.map(text).join(''):String(n??'');render();
 return{sync:async(ms=60001)=>{backgroundClock+=ms;backgroundTick();await settle();await settle();render();},render,nodes,text,find:k=>nodes().find(n=>n.props[k]!==undefined),cleanup(){cleanups.splice(0).forEach(fn=>fn?.());}};
}
function fixture(t, options = {}){
 if(!t.modelTimers){t.mock.timers.enable({apis:['setTimeout']});t.modelTimers=true;}
 const calls=[];let generation=1,remote=false,conflict=false;
 const values={...DEFAULT_PREFERENCES,codexAccountBackend:'official',billingMode:'codex'};
 let settings={enabled:options.enabled??null,defaultModel:null,reasoningEffort:null};
 let host={available:true,managed:false};
 const row=id=>({id,modelKey:hash(id),name:id==='gpt-6.1-sol'?'GPT 6.1 Sol':id,speedModes:options.fast?['standard','fast']:['standard'],inputModalities:['text','image'],reasoning:{efforts:[{id:'low'},{id:'high'}]}});
 const models=()=>({accountKey:key,generation,settings:structuredClone(settings),hostModel:host,catalog:{source:remote?'account-catalog':'builtin',status:remote?'ready':'not-refreshed',omitted:options.omitted??[],capabilityGaps:options.capabilityGaps??[],receivedCount:3,includedCount:options.noSol?2:3,requestMode:'full',clientVersion:'0.153.4',targetModel:options.noTarget?undefined:{received:!options.noSol||!!options.omitted?.length,accepted:!options.noSol,reason:options.omitted?.[0]?.reason??null}},models:[row('gpt-5.5'),row('gpt-5.5-mini'),...(remote&&!options.noSol?[row('gpt-6.1-sol')]:[])]});
 const catalogue=()=>({generation,implementation:options.oldOwner?undefined:{owner:'simple-pet',modelDiscovery:2},capabilities:{models:true,resetCredits:options.resets===true},busy:false,hostModel:host,accounts:[{accountKey:key,label:'合成工作账号',epoch:1,bound:true,selected:true}]});
 const ui=harness(async(url,init={})=>{
  calls.push({url,...init});
  if(url.endsWith('/preferences')){if(init.method==='PUT')Object.assign(values,JSON.parse(init.body).patch);return Response.json({values,revision:'r'});}
  if(!url.endsWith('/official-accounts'))return Response.json({});
  if(init.method!=='POST'){if(options.readGate)await options.readGate;return Response.json(catalogue());}
  const b=JSON.parse(init.body);
  if(b.action==='reset.inspect')return Response.json({availableCount:1,credits:[{ref:'opaque-card',paused:false}]});
  if(b.action==='reset.prepare')return Response.json({challengeId:'opaque-confirm',readyAt:Date.now()-1000,expiresAt:Date.now()+60000});
  if(b.action==='reset.consume')return options.resetUnknown?Response.json({code:'RESET_UNCERTAIN',error:'兑换可能已发送，结果未知；不再自动重试。'},{status:503}):Response.json({code:'reset',windowsResetCount:1});
  if(b.action==='models.configure'){
   if(options.failSave)throw new Error('Synthetic network failure');
   if(options.saveGate)await options.saveGate;
   if(conflict||b.expectedGeneration!==generation)return Response.json({error:'模型配置已变化，请重新读取。'},{status:409});
   settings=structuredClone(b.settings);generation++;return Response.json(models());
  }
  if(b.action==='host-model.select'){
   const m=models().models.find(row=>row.modelKey===b.modelKey);assert(m);host={available:true,managed:true,model:`${key}:${m.id}`,reasoningEffort:settings.reasoningEffort};return Response.json(host);
  }
  if(b.action==='quota.read'){if(options.quotaGate)await options.quotaGate;return Response.json({});}
  if(b.action==='models.refresh')remote=true;
  if(b.action==='models.read'||b.action==='models.refresh')return Response.json(models());
  assert.fail('Unexpected action '+b.action);
 });
 t.after(()=>ui.cleanup());
 const posts=()=>calls.filter(c=>c.method==='POST').map(c=>JSON.parse(c.body));
 const click=async name=>{const node=ui.find(name);assert(node,name+' missing');assert.notEqual(node.props.disabled,true,name+' disabled');node.props.onClick();await settle();ui.render();};
 const open=async()=>{await settle();ui.render();ui.nodes().find(n=>n.props['data-pet-tab']==='accounts').props.onClick();ui.render();await ui.sync();await click('data-official-models-open');};
 const persist=async(ms=450)=>{t.mock.timers.tick(ms);await settle();ui.render();};
 return{ui,calls,posts,click,open,persist,conflict(){conflict=true;}};
}

test('background reads load the visible account once without directory/check buttons or consuming',async t=>{
 const f=fixture(t,{resets:true});await settle();f.ui.render();f.ui.nodes().find(n=>n.props['data-pet-tab']==='appearance').props.onClick();f.ui.render();await f.ui.sync();assert.equal(f.calls.filter(c=>c.url.endsWith('/official-accounts')).length,0);
 f.ui.nodes().find(n=>n.props['data-pet-tab']==='accounts').props.onClick();f.ui.render();await f.ui.sync(0);await f.ui.sync(0);
 assert.deepEqual(f.posts().map(b=>b.action),['reset.inspect']);assert.equal(f.ui.find('data-official-read'),undefined);assert.equal(f.ui.find('data-reset-inspect'),undefined);assert.equal(f.ui.find('data-model-refresh'),undefined);
 for(let i=0;i<20;i++)await f.ui.sync(0);assert.deepEqual(f.posts().map(b=>b.action),['reset.inspect']);assert.match(f.ui.text(f.ui.find('data-reset-card-panel')),/1 张可用/);
});
test('background models refresh is scoped and has a five minute attempt budget',async t=>{
 const f=fixture(t);await settle();f.ui.render();f.ui.nodes().find(n=>n.props['data-pet-tab']==='models').props.onClick();f.ui.render();await f.ui.sync(0);await f.ui.sync(0);assert.deepEqual(f.posts().map(b=>b.action),['models.refresh']);
 await f.ui.sync(59999);await f.ui.sync(0);assert.equal(f.posts().length,1);await f.ui.sync(240002);await f.ui.sync(0);assert.equal(f.posts().length,2);assert(f.posts().every(p=>p.action==='models.refresh'));
});
test('confirmation and unknown redemption pause background card discovery without replaying consume',async t=>{
 const f=fixture(t,{resets:true,resetUnknown:true});await settle();f.ui.render();f.ui.nodes().find(n=>n.props['data-pet-tab']==='accounts').props.onClick();f.ui.render();await f.ui.sync(0);await f.ui.sync(0);await f.click('data-reset-prepare');
 const before=f.calls.length;await f.ui.sync(300000);assert.equal(f.calls.length,before);f.ui.find('data-reset-ack').props.onChange({target:{checked:true}});f.ui.render();await f.click('data-reset-consume');
 await f.ui.sync(300000);await f.ui.sync(0);assert.equal(f.posts().filter(p=>p.action==='reset.inspect').length,1);assert.equal(f.posts().filter(p=>p.action==='reset.consume').length,1);assert.match(f.ui.text(f.ui.find('data-reset-status')),/结果未知/);
});
test('backend changes, inactive page, dirty model and unmount stop automatic requests',async t=>{
 const f=fixture(t);await f.open();f.ui.find('data-model-default').props.onChange({target:{value:'gpt-5.5'}});f.ui.render();const count=f.calls.length;await f.ui.sync(300000);assert.equal(f.calls.length,count);
 f.ui.nodes().find(n=>n.props.name==='codexAccountBackend').props.onChange({target:{value:'legacy'}});f.ui.render();await f.ui.sync(300000);assert.equal(f.calls.length,count);f.ui.cleanup();await f.ui.sync(300000);assert.equal(f.calls.length,count);
});

test('hiding aborts a background read and a return reclaims its attempt without a fake loading TTL',async t=>{
 let handler,release;const previous=Object.getOwnPropertyDescriptor(globalThis,'document'),doc={visibilityState:'visible',addEventListener(type,fn){if(type==='visibilitychange')handler=fn;},removeEventListener(){}};
 Object.defineProperty(globalThis,'document',{configurable:true,value:doc});t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;});
 const readGate=new Promise(resolve=>{release=resolve;}),f=fixture(t,{readGate,resets:true});await settle();f.ui.render();await f.ui.sync(0);const read=f.calls.find(c=>c.url.endsWith('/official-accounts'));assert(read);assert.equal(read.signal.aborted,false);
 doc.visibilityState='hidden';handler();assert.equal(read.signal.aborted,true);release();await settle();f.ui.render();assert.equal(f.ui.find('data-official-account-row'),undefined);await f.ui.sync(0);assert.equal(f.calls.filter(c=>c.url.endsWith('/official-accounts')).length,1);
 doc.visibilityState='visible';handler();await settle();await settle();f.ui.render();assert(f.ui.find('data-official-account-row'));assert.equal(f.calls.filter(c=>c.url.endsWith('/official-accounts')).length,2);await f.ui.sync(0);assert.equal(f.posts().at(-1).action,'reset.inspect');
});
test('Fast consent is not replaced by automatic directory reads',async t=>{
 const f=fixture(t,{fast:true});await f.open();f.ui.find('data-model-default').props.onChange({target:{value:'gpt-6.1-sol'}});f.ui.render();await f.persist();await f.click('data-speed-request');const count=f.calls.length;await f.ui.sync(600000);assert.equal(f.calls.length,count);assert(f.ui.find('data-speed-confirmation'));
});
