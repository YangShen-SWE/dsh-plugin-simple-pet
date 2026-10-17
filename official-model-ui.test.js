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
 const component=createSimplePetClient(React,send),render=()=>{index=0;return tree=component.SimplePetSettings();};
 const nodes=(n=tree)=>n&&typeof n==='object'?[n,...n.children.flatMap(nodes)]:[],text=(n=tree)=>n&&typeof n==='object'?n.children.map(text).join(''):String(n??'');render();
 return{render,nodes,text,find:k=>nodes().find(n=>n.props[k]!==undefined),cleanup(){cleanups.splice(0).forEach(fn=>fn?.());}};
}
function fixture(t, options = {}){
 if(!t.modelTimers){t.mock.timers.enable({apis:['setTimeout']});t.modelTimers=true;}
 const calls=[];let generation=1,remote=false,conflict=false;
 const values={...DEFAULT_PREFERENCES,codexAccountBackend:'official',billingMode:'codex'};
 let settings={enabled:options.enabled??null,defaultModel:null,reasoningEffort:null};
 let host={available:true,managed:false};
 const row=id=>({id,modelKey:hash(id),name:id==='gpt-6.1-sol'?'GPT 6.1 Sol':id,inputModalities:['text','image'],reasoning:{efforts:[{id:'low'},{id:'high'}]}});
 const models=()=>({accountKey:key,generation,settings:structuredClone(settings),hostModel:host,catalog:{source:remote?'account-catalog':'builtin',status:remote?'ready':'not-refreshed',omitted:options.omitted??[],capabilityGaps:options.capabilityGaps??[],receivedCount:3,includedCount:options.noSol?2:3,requestMode:'full',clientVersion:'0.153.4',targetModel:options.noTarget?undefined:{received:!options.noSol||!!options.omitted?.length,accepted:!options.noSol,reason:options.omitted?.[0]?.reason??null}},models:[row('gpt-5.5'),row('gpt-5.5-mini'),...(remote&&!options.noSol?[row('gpt-6.1-sol')]:[])]});
 const catalogue=()=>({generation,implementation:options.oldOwner?undefined:{owner:'simple-pet',modelDiscovery:2},capabilities:{models:true},busy:false,hostModel:host,accounts:[{accountKey:key,label:'合成工作账号',bound:true,selected:true}]});
 const ui=harness(async(url,init={})=>{
  calls.push({url,...init});
  if(url.endsWith('/preferences')){if(init.method==='PUT')Object.assign(values,JSON.parse(init.body).patch);return Response.json({values,revision:'r'});}
  if(!url.endsWith('/official-accounts'))return Response.json({});
  if(init.method!=='POST')return Response.json(catalogue());
  const b=JSON.parse(init.body);
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
 const open=async()=>{await settle();ui.render();ui.nodes().find(n=>n.props['data-pet-tab']==='accounts').props.onClick();ui.render();await click('data-official-read');await click('data-official-models-open');};
 const persist=async(ms=450)=>{t.mock.timers.tick(ms);await settle();ui.render();};
 return{ui,calls,posts,click,open,persist,conflict(){conflict=true;}};
}
test('models never enumerate or call inference on settings mount; opening is an explicit account action',async t=>{
 const f=fixture(t);await settle();f.ui.render();assert.equal(f.calls.length,4);assert(!f.ui.find('data-official-model-panel'));
 await f.open();assert.deepEqual(f.posts(),[{action:'models.refresh',accountKey:key}]);assert(f.ui.find('data-model-default'));assert.match(f.ui.text(),/模型偏好自动保存/);
});
test('gpt-6.1-sol appears only after explicit account directory response; no warmup or model call',async t=>{
 const f=fixture(t);await f.open();
 assert.match(f.ui.text(f.ui.find('data-model-sol-status')),/已在此账号目录中启用/);
 assert(f.ui.nodes().some(n=>n.type==='option'&&n.props.value==='gpt-6.1-sol'));assert.match(f.ui.text(),/来自该账号返回/);
 assert.deepEqual(f.posts().map(b=>b.action),['models.refresh']);assert(!f.calls.some(c=>/warmup|stream|responses/.test(c.body||'')));
});
test('ordinary and model preferences autosave without save buttons; host selection remains explicit',async t=>{
 const f=fixture(t);await f.open();await f.click('data-model-refresh');
 f.ui.find('data-model-default').props.onChange({target:{value:'gpt-6.1-sol'}});f.ui.render();
 f.ui.find('data-model-reasoning').props.onChange({target:{value:'high'}});f.ui.render();assert.equal(f.ui.find('data-model-use').props.disabled,true);
 assert.equal(f.ui.find('data-settings-save'),undefined);assert.equal(f.ui.find('data-model-save'),undefined);
 f.ui.nodes().find(n=>n.props.name==='size').props.onChange({target:{value:'small'}});f.ui.render();await f.persist();
 const preferenceSave=JSON.parse(f.calls.find(c=>c.method==='PUT').body);assert.deepEqual(preferenceSave.patch,{size:'small'});assert.equal(f.ui.find('data-model-default').props.value,'gpt-6.1-sol');
 const saved=f.posts().at(-1);assert.deepEqual(saved,{action:'models.configure',accountKey:key,expectedGeneration:1,settings:{enabled:null,defaultModel:'gpt-6.1-sol',reasoningEffort:'high'}});
 assert.equal(f.ui.find('data-model-save'),undefined);assert(!f.posts().some(b=>b.action==='host-model.select'));
 await f.click('data-model-use');assert.deepEqual(f.posts().at(-1),{action:'host-model.select',accountKey:key,modelKey:hash('gpt-6.1-sol')});assert.match(f.ui.text(),/已有会话/);
});
test('dirty model draft blocks refresh until explicit discard; generic top save does not consume it',async t=>{
 const f=fixture(t);await f.open();f.ui.find('data-model-default').props.onChange({target:{value:'gpt-5.5'}});f.ui.render();
 const count=f.posts().length;await f.click('data-model-refresh');assert.equal(f.posts().length,count);assert.match(f.ui.text(),/模型草稿尚未保存/);
 await f.click('data-model-discard');assert.equal(f.posts().at(-1).action,'models.read');assert.equal(f.ui.find('data-model-default').props.value,'');
});
test('a busy account read delays model autosave rather than dropping the only pending write',async t=>{
 let release;const quotaGate=new Promise(resolve=>{release=resolve;}),f=fixture(t,{quotaGate});await f.open();
 f.ui.find('data-model-default').props.onChange({target:{value:'gpt-6.1-sol'}});f.ui.render();
 f.ui.find('data-official-quota').props.onClick();await settle();f.ui.render();await f.persist();
 assert.match(f.ui.text(f.ui.find('data-model-status')),/结束后将自动保存/);assert.equal(f.posts().filter(b=>b.action==='models.configure').length,0);
 release();await settle();f.ui.render();await f.persist();
 assert.equal(f.posts().filter(b=>b.action==='models.configure').length,1);assert.equal(f.posts().at(-1).settings.defaultModel,'gpt-6.1-sol');
 assert(!f.posts().some(b=>b.action==='host-model.select'));assert.equal(f.ui.find('data-model-save'),undefined);
});
test('model config conflict preserves draft and account rows, and never retries or sets host selection',async t=>{
 const f=fixture(t);await f.open();f.ui.find('data-model-default').props.onChange({target:{value:'gpt-5.5'}});f.ui.render();f.conflict();
 await f.persist();assert.equal(f.ui.find('data-model-default').props.value,'gpt-5.5');assert(f.ui.find('data-official-account-row'));assert.match(f.ui.text(),/草稿已保留/);assert.equal(f.posts().filter(b=>b.action==='models.configure').length,1);assert(!f.posts().some(b=>b.action==='host-model.select'));
});
test('hiding chosen model clears its draft default but does not send any request',async t=>{
 const f=fixture(t);await f.open();f.ui.find('data-model-default').props.onChange({target:{value:'gpt-5.5'}});f.ui.render();
 const before=f.posts().length;f.ui.nodes().find(n=>n.props['data-model-enabled']==='gpt-5.5').props.onChange({target:{checked:false}});f.ui.render();
 assert.equal(f.ui.find('data-model-default').props.value,'');assert.equal(f.ui.find('data-model-use').props.disabled,true);assert.equal(f.posts().length,before);
});
for(const [options,expected]of [[{enabled:['gpt-5.5']},/被本账号可见模型筛选关闭/],[{noSol:true},/完整解析未发现/],[{noSol:true,omitted:[{id:'gpt-6.1-sol',reason:'missing-context'}]},/未提供可验证的上下文上限/],[{noSol:true,omitted:[{id:'gpt-6.1-sol',reason:'not-visible'}]},/服务端标记为隐藏/]])test('sol status distinguishes '+expected,async t=>{
 const f=fixture(t,options);await f.open();assert.match(f.ui.text(f.ui.find('data-model-sol-status')),expected);assert.deepEqual(f.posts(),[{action:'models.refresh',accountKey:key}]);assert(!f.posts().some(row=>/warmup|stream/.test(row.action)));
});
test('safe model diagnostics distinguish counts, old owner and a target omitted beyond the display cap',async t=>{
 const f=fixture(t,{oldOwner:true,noSol:true,omitted:Array.from({length:128},(_,i)=>({id:`hidden-${i}`,reason:'not-visible'}))});await f.open();
 assert.match(f.ui.text(f.ui.find('data-model-catalog-diagnostic')),/服务端条目 3/);assert.match(f.ui.text(),/完整 GET，未采用 ETag/);
 assert.match(f.ui.text(f.ui.find('data-model-owner-unconfirmed')),/安装文件更新不代表运行中服务已切换/);
 assert.match(f.ui.text(f.ui.find('data-model-sol-status')),/服务端标记为隐藏/);
 assert.deepEqual(f.posts().map(b=>b.action),['models.refresh']);
});
test('missing target evidence in an older backend cannot prove server absence',async t=>{
 const f=fixture(t,{noSol:true,noTarget:true});await f.open();assert.match(f.ui.text(f.ui.find('data-model-sol-status')),/不能把缺少显示诊断当成服务端未返回/);
});
test('unreported context stays selectable with a clearly local non-entitlement budget note',async t=>{
 const f=fixture(t,{capabilityGaps:[{id:'gpt-6.1-sol',reason:'context-limit-unreported',localContextLimit:8192}]});await f.open();
 assert(f.ui.nodes().some(n=>n.type==='option'&&n.props.value==='gpt-6.1-sol'));
 assert.match(f.ui.text(f.ui.find('data-model-context-note')),/本地 8192-token/);assert.match(f.ui.text(),/不是服务端真实上限/);
});
test('model preferences debounce latest combined draft with CAS and do not change host default',async t=>{
 const f=fixture(t);await f.open();
 f.ui.find('data-model-default').props.onChange({target:{value:'gpt-6.1-sol'}});f.ui.render();
 f.ui.find('data-model-reasoning').props.onChange({target:{value:'high'}});f.ui.render();
 assert.equal(f.posts().filter(b=>b.action==='models.configure').length,0);
 await f.persist(520);f.ui.render();
 assert.deepEqual(f.posts().filter(b=>b.action==='models.configure'),[{action:'models.configure',accountKey:key,expectedGeneration:1,settings:{enabled:null,defaultModel:'gpt-6.1-sol',reasoningEffort:'high'}}]);
 assert(!f.posts().some(b=>b.action==='host-model.select'));assert.equal(f.ui.find('data-model-save'),undefined);
 f.ui.find('data-model-reasoning').props.onChange({target:{value:'low'}});f.ui.render();await f.persist(520);f.ui.render();
 assert.equal(f.posts().filter(b=>b.action==='models.configure').at(-1).expectedGeneration,2);
});
test('model autosave conflicts and unknown writes pause with drafts intact and no hidden retries',async t=>{
 for(const failure of ['conflict','network']){
  const f=fixture(t,{failSave:failure==='network'});await f.open();
  f.ui.find('data-model-default').props.onChange({target:{value:'gpt-5.5'}});f.ui.render();if(failure==='conflict')f.conflict();
  await f.persist(520);f.ui.render();assert.equal(f.posts().filter(b=>b.action==='models.configure').length,1);
  assert.equal(f.ui.find('data-model-default').props.value,'gpt-5.5');assert.match(f.ui.text(),/草稿已保留/);
  f.ui.find('data-model-reasoning').props.onChange({target:{value:'high'}});f.ui.render();await f.persist(520);
  assert.equal(f.posts().filter(b=>b.action==='models.configure').length,1);
 }
});
test('pending model autosave is cancelled on explicit discard, backend ABA and unmount',async t=>{
 for(const mode of ['discard','ABA','unmount']){
  const f=fixture(t);await f.open();f.ui.find('data-model-default').props.onChange({target:{value:'gpt-5.5'}});f.ui.render();
  if(mode==='discard')await f.click('data-model-discard');else if(mode==='unmount')f.ui.cleanup();else for(const value of ['legacy','official']){f.ui.nodes().find(n=>n.props.name==='codexAccountBackend').props.onChange({target:{value}});f.ui.render();}
  await f.persist(520);assert.equal(f.posts().filter(b=>b.action==='models.configure').length,0);
 }
});
test('model controls are disabled while an autosave request owns the account operation',async t=>{
 let release;const saveGate=new Promise(r=>release=r);t.after(()=>release());
 const f=fixture(t,{saveGate});await f.open();f.ui.find('data-model-default').props.onChange({target:{value:'gpt-5.5'}});f.ui.render();
 await f.persist(520);f.ui.render();assert.equal(f.posts().filter(b=>b.action==='models.configure').length,1);
 assert.equal(f.ui.find('data-model-default').props.disabled,true);assert.equal(f.ui.find('data-model-use').props.disabled,true);
 release();await settle();f.ui.render();assert.equal(f.ui.find('data-model-save'),undefined);
});
test('captured model-save/use callbacks cannot survive backend ABA or unmount',async t=>{
 for(const mode of ['ABA','unmount']){
  const f=fixture(t);await f.open();f.ui.find('data-model-default').props.onChange({target:{value:'gpt-5.5'}});f.ui.render();await f.persist();
  const old=f.ui.find('data-model-use').props.onClick,before=f.posts().length;
  if(mode==='unmount')f.ui.cleanup();else for(const value of ['legacy','official']){f.ui.nodes().find(n=>n.props.name==='codexAccountBackend').props.onChange({target:{value}});f.ui.render();}
  old();await settle();assert.equal(f.posts().length,before);
 }
});
