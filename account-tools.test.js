import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimplePetClient, readAccountQuotaBatch, safeAccountDiagnostics } from './client-source.js';
import { DEFAULT_PREFERENCES } from './preferences.js';
const A='a'.repeat(16), B='b'.repeat(16), C='c'.repeat(16), D='d'.repeat(16);
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function harness(send){
 const cells=[],cleanups=[];let index=0,tree;
 const React={createElement(type,props,...children){return{type,props:props??{},children:children.flat().filter(v=>v!==false&&v!=null)};},useState(initial){const n=index++;if(!(n in cells))cells[n]=initial;return[cells[n],v=>{cells[n]=typeof v==='function'?v(cells[n]):v;}];},useRef(initial){return cells[index++]??={current:initial};},useEffect(fn){const n=index++;if(!(n in cells)){cells[n]=true;cleanups.push(fn());}}};
  let backgroundTick, backgroundClock=0; const services={scheduleAccountReads:fn=>{backgroundTick=fn;return()=>{};},accountReadNow:()=>backgroundClock};
 const component=createSimplePetClient(React,send,services),render=()=>{index=0;return tree=component.SimplePetSettings();};
 const nodes=(node=tree)=>node&&typeof node==='object'?[node,...node.children.flatMap(nodes)]:[],text=(node=tree)=>node&&typeof node==='object'?node.children.map(text).join(''):String(node??'');render();
 return{sync:async(ms=60001)=>{backgroundClock+=ms;backgroundTick();await settle();await settle();render();},render,nodes,text,find:(attr,value)=>nodes().find(n=>n.props[attr]!==undefined&&(value===undefined||n.props[attr]===value)),cleanup(){cleanups.splice(0).forEach(fn=>fn?.());}};
}
function fixture(t,hooks={}){
 t.mock.timers.enable({apis:['setTimeout']});
 const calls=[],state={gets:0,catalogue:{generation:1,implementation:{owner:'simple-pet',modelDiscovery:2},capabilities:{models:true,rename:true},accounts:[{accountKey:A,label:'合成工作账号',epoch:1,bound:true,selected:true,credentialStatus:'available'},{accountKey:B,label:'合成备用账号',epoch:1,bound:true,selected:false,credentialStatus:'available'}]}};
 const values={...DEFAULT_PREFERENCES,billingMode:'codex',codexAccountBackend:'official'};
 const ui=harness(async(url,init={})=>{
  calls.push({url,...init});
  if(url.endsWith('/preferences')){if(init.method==='PUT')Object.assign(values,JSON.parse(init.body).patch);return Response.json({values,revision:'r'});}
  if(!url.endsWith('/official-accounts'))return Response.json({});
  if(init.method==='POST'){
   const body=JSON.parse(init.body);if(hooks.post){const response=await hooks.post(body,state,init);if(response)return response;}
   if(body.action==='account.rename'){
    if(body.expectedGeneration!==state.catalogue.generation)return Response.json({error:'目录已变化。',code:'SOURCE_CHANGED'},{status:409});
    state.catalogue={...state.catalogue,generation:state.catalogue.generation+1,accounts:state.catalogue.accounts.map(row=>row.accountKey===body.accountKey?{...row,label:body.label}:row)};
   }else assert.equal(body.action,'quota.read');
   return Response.json({ok:true});
  }
  state.gets++;if(hooks.get){const response=await hooks.get(state,init);if(response)return response;}return Response.json(state.catalogue);
 });
 t.after(()=>ui.cleanup());
 const posts=()=>calls.filter(call=>call.method==='POST').map(call=>JSON.parse(call.body));
 const click=async(attr,value)=>{const node=ui.find(attr,value);assert(node,attr);assert.notEqual(node.props.disabled,true,attr+' disabled');node.props.onClick();await settle();await settle();ui.render();};
 const ready=async()=>{await settle();ui.render();ui.find('data-pet-tab','accounts').props.onClick();ui.render();await ui.sync();};
 const tick=async(ms=450)=>{t.mock.timers.tick(ms);await settle();await settle();ui.render();};
 const edit=value=>{ui.find('data-official-rename-input',A).props.onChange({target:{value}});ui.render();};
 return{ui,calls,state,posts,click,ready,tick,edit};
}

test('quota batch validates explicit 1–8 unique public account keys before any request',async()=>{
 let calls=0;for(const accountKeys of [[],[A,A],['private-key'],Array.from({length:9},(_,i)=>String(i).repeat(16))])await assert.rejects(readAccountQuotaBatch({accountKeys,read:async()=>{calls++;}}),/INVALID_ACCOUNT_BATCH/);assert.equal(calls,0);
});
test('quota batch has at most two in flight and dispatches once per selected account',async()=>{
 let active=0,max=0;const calls=[],release=[];
 const pending=readAccountQuotaBatch({accountKeys:[A,B,C,D],read:async key=>{calls.push(key);active++;max=Math.max(max,active);await new Promise(resolve=>release.push(resolve));active--;}});
 await settle();assert.deepEqual(calls,[A,B]);release.splice(0).forEach(fn=>fn());await settle();assert.deepEqual(calls,[A,B,C,D]);release.splice(0).forEach(fn=>fn());const result=await pending;
 assert.equal(max,2);assert(result.results.every(row=>row.status==='success'));assert.equal(result.halted,false);
});
test('known account-local quota failure does not cancel independent selected accounts',async()=>{
 const result=await readAccountQuotaBatch({accountKeys:[A,B,C],read:async key=>{if(key===A)throw Object.assign(new Error('PRIVATE_ERROR_SECRET'),{code:'OAUTH_REQUIRED'});}});
 assert.deepEqual(result.results.map(row=>row.status),['failed','success','success']);assert(!JSON.stringify(result).includes('PRIVATE_ERROR_SECRET'));assert.equal(result.halted,false);
});
test('unknown/shared and source-changed quota errors stop the queue without retries',async()=>{
 for(const code of ['SOURCE_CHANGED','UNTRUSTED_CODE_SECRET']){
  const calls=[];const result=await readAccountQuotaBatch({accountKeys:[A,B,C,D],read:async(key,signal)=>{calls.push(key);if(key===A)throw Object.assign(new Error('TOKEN_SECRET'),{code});await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}});
  assert.deepEqual(calls,[A,B]);assert.equal(result.halted,true);assert.equal(result.results[2].status,'cancelled');assert(!JSON.stringify(result).includes('SECRET'));
 }
});
test('cancelled or failed local UI callbacks cannot start further quota requests',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;
 const cancelled=await readAccountQuotaBatch({accountKeys:[A,B],signal:controller.signal,read:async()=>{calls++;}});assert.equal(calls,0);assert(cancelled.results.every(row=>row.status==='cancelled'));
 const stopped=await readAccountQuotaBatch({accountKeys:[A,B],read:async()=>{calls++;},onResult(){throw Error('LOCAL_SECRET');}});assert.equal(calls,0);assert.equal(stopped.halted,true);
});
test('diagnostics are a constructed whitelist, not a redacted copy of accounts or errors',()=>{
 const secret='VERY_PRIVATE_SECRET',catalogue={implementation:{owner:'simple-pet',modelDiscovery:2},accounts:[{accountKey:A,label:secret,email:secret,credentialKey:secret,access:secret,bound:true,selected:true,credentialStatus:'available'}],callback:secret,path:secret,error:secret};
 const models={accountKey:A,settings:{enabled:null,defaultModel:secret},models:[{id:secret,name:secret}],catalog:{source:'account-catalog',status:'stale',receivedCount:4,includedCount:1,clientVersion:'0.163.0',requestMode:'full',targetModel:{received:false,accepted:false,reason:secret},omitted:[{id:secret,reason:secret}],raw:secret,error:secret}};
 const result=safeAccountDiagnostics(catalogue,models,{directoryConfirmed:false}),json=JSON.stringify(result);assert(!json.includes(secret));assert(!json.includes(A));assert.equal(result.directory.confirmed,false);assert.equal(result.directory.accountCount,1);assert.equal(result.models.status,'stale');assert.equal(result.models.target.reason,'unknown');assert.equal(result.models.clientVersion,'0.163.0');
 assert.equal(safeAccountDiagnostics(null,null).implementation.owner,'unconfirmed');assert.equal(safeAccountDiagnostics(null,{catalog:{receivedCount:-1,includedCount:Infinity,clientVersion:secret}}).models.receivedCount,null);
});

test('local nickname automatically saves after debounce with fixed target CAS and no ordinary save button',async t=>{
 const f=fixture(t);await f.ready();await f.click('data-official-rename',A);f.edit('  本机新昵称  ');await f.tick(449);assert.equal(f.posts().length,0);await f.tick(1);
 assert.deepEqual(f.posts(),[{action:'account.rename',accountKey:A,label:'本机新昵称',expectedGeneration:1}]);assert.equal(f.ui.find('data-official-rename-editor',A),undefined);assert.match(f.ui.text(),/昵称已自动保存/);assert.equal(f.ui.find('data-settings-save'),undefined);assert.equal(f.state.catalogue.accounts[1].label,'合成备用账号');assert.equal(f.state.catalogue.accounts[0].selected,true);
});
test('invalid nickname, unchanged nickname and Escape never write or mutate account grants',async t=>{
 const f=fixture(t);await f.ready();await f.click('data-official-rename',A);
 for(const value of ['','x'.repeat(65),'bad\u202ename','bad\u0000name','bad\ud800name']){f.edit(value);await f.tick();assert.match(f.ui.text(f.ui.find('data-official-rename-status',A)),/尚未保存/);}
 f.edit('合成工作账号');await f.tick();f.edit('取消的昵称');f.ui.find('data-official-rename-input',A).props.onKeyDown({key:'Escape',preventDefault(){}});await f.tick();assert.equal(f.posts().length,0);
});
test('generation conflict retains nickname draft and never automatically retries',async t=>{
 const f=fixture(t,{post(body){if(body.action==='account.rename')return Response.json({error:'目录已变化。',code:'SOURCE_CHANGED'},{status:409});}});await f.ready();await f.click('data-official-rename',A);f.edit('仍保留草稿');await f.tick();assert.equal(f.ui.find('data-official-rename-input',A).props.value,'仍保留草稿');assert.match(f.ui.text(),/目录已变化/);await f.tick(5000);assert.equal(f.posts().length,1);assert.equal(f.ui.find('data-official-rename-retry'),undefined);
});
test('acknowledged nickname plus failed directory read remains unknown and cannot be replayed',async t=>{
 const f=fixture(t,{get(state){if(state.gets>1)return Response.json({error:'目录暂不可用。'},{status:503});}});await f.ready();await f.click('data-official-rename',A);f.edit('已提交但未核验');await f.tick();assert.equal(f.posts().length,1);assert.match(f.ui.text(),/可能已提交|尚未核验/);await f.tick(5000);assert.equal(f.posts().length,1);assert.equal(f.ui.find('data-official-rename-retry'),undefined);
});
test('unmount or backend ABA revokes pending nickname timer and captured batch authority',async t=>{
 const f=fixture(t);await f.ready();await f.click('data-official-batch-select');const oldBatch=f.ui.find('data-official-batch-read').props.onClick;await f.click('data-official-rename',A);f.edit('不能迟到提交');
 f.ui.nodes().find(n=>n.props.name==='codexAccountBackend').props.onChange({target:{value:'legacy'}});f.ui.render();f.ui.nodes().find(n=>n.props.name==='codexAccountBackend').props.onChange({target:{value:'official'}});f.ui.render();oldBatch();await f.tick(5000);assert.equal(f.posts().length,0);
});
test('new selected-account batch is explicit and account-local failure leaves B independently readable',async t=>{
 const f=fixture(t,{post(body){if(body.action==='quota.read'&&body.accountKey===A)return Response.json({error:'本地授权不可用。',code:'OAUTH_REQUIRED'},{status:409});}});await f.ready();assert.equal(f.posts().length,0);await f.click('data-official-batch-select');assert.equal(f.posts().length,0);await f.click('data-official-batch-read');assert.deepEqual(f.posts().map(row=>row.accountKey),[A,B]);assert(f.posts().every(row=>row.action==='quota.read'));assert.match(f.ui.text(f.ui.find('data-official-batch-result',A)),/失败/);assert.match(f.ui.text(f.ui.find('data-official-batch-result',B)),/收到额度响应/);assert.equal(f.state.gets,2);
});
test('cancel batch aborts queued work without switching accounts or retrying',async t=>{
 const f=fixture(t,{post(body,state,init){if(body.action==='quota.read')return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true}));}});await f.ready();await f.click('data-official-batch-select');const button=f.ui.find('data-official-batch-read');button.props.onClick();await settle();f.ui.render();assert.equal(f.posts().length,2);await f.click('data-official-batch-cancel');await f.tick(5000);assert.equal(f.posts().length,2);assert.match(f.ui.text(),/已取消|已要求取消/);assert(!f.posts().some(row=>/select|warmup|models/.test(row.action)));
});
test('downloading a diagnostic uses only an in-memory local blob, then revokes the object URL',async t=>{
 const f=fixture(t);await f.ready();await f.click('data-official-diagnostics');const before=f.calls.length;let savedBlob,clicked=0,removed=0,appended=0;const revoked=[],link={click(){clicked++;},remove(){removed++;}},previous=Object.getOwnPropertyDescriptor(globalThis,'document');
 Object.defineProperty(globalThis,'document',{configurable:true,writable:true,value:{createElement(name){assert.equal(name,'a');return link;},body:{appendChild(value){assert.equal(value,link);appended++;}}}});
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;});
 t.mock.method(URL,'createObjectURL',blob=>{savedBlob=blob;return 'blob:synthetic-diagnostic';});t.mock.method(URL,'revokeObjectURL',url=>revoked.push(url));
 await f.click('data-official-diagnostics-download');assert.equal(f.calls.length,before);assert.equal(clicked,1);assert.equal(removed,1);assert.equal(appended,1);assert.equal(link.href,'blob:synthetic-diagnostic');assert.equal(link.download,'simple-pet-account-diagnostics.json');assert.deepEqual(revoked,['blob:synthetic-diagnostic']);assert.equal(savedBlob.type,'application/json');const text=await savedBlob.text();assert(!text.includes(A));assert(!text.includes('合成工作账号'));assert.equal(JSON.parse(text).schema,'simple-pet-account-diagnostics/v1');
});
test('unmount revokes pending nickname autosave without issuing a request',async t=>{
 const f=fixture(t);await f.ready();await f.click('data-official-rename',A);f.edit('不得迟到保存');f.ui.cleanup();await f.tick(5000);assert.equal(f.posts().length,0);
});
test('background reads yield to a rename; failed post-save verification preserves an unverified draft',async t=>{
 const f=fixture(t,{get(state){if(state.gets>1)return Response.json({error:'目录不可用。'},{status:503});}});await f.ready();await f.click('data-official-rename',A);f.edit('读取失败时保留');await f.ui.sync();await f.tick(5000);assert.equal(f.posts().length,1);assert.equal(f.ui.find('data-official-rename-input',A).props.value,'读取失败时保留');assert.match(f.ui.text(f.ui.find('data-official-rename-status',A)),/结果尚未核验/);
});
test('a runtime without rename support cannot receive a captured rename action',async t=>{
 const f=fixture(t);f.state.catalogue.capabilities.rename=false;await f.ready();const button=f.ui.find('data-official-rename',A);assert.equal(button.props.disabled,true);button.props.onClick();await f.tick(5000);assert.equal(f.posts().length,0);assert.equal(f.ui.find('data-official-rename-editor',A),undefined);
});
test('generating downloadable diagnostic preview performs no request and exports no account identifiers',async t=>{
 const f=fixture(t);await f.ready();const before=f.calls.length;await f.click('data-official-diagnostics');assert.equal(f.calls.length,before);const text=f.ui.find('data-official-diagnostic-json').props.value;assert(!text.includes(A));assert(!text.includes(B));assert(!text.includes('合成工作账号'));assert.equal(JSON.parse(text).directory.confirmed,true);assert(f.ui.find('data-official-diagnostics-download'));assert.equal(f.posts().length,0);
});
