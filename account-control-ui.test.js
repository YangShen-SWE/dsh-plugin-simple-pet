import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createSimplePetClient } from './client-source.js';
import { DEFAULT_PREFERENCES } from './preferences.js';
import { accountSwitchCapability, warmupAfterAccountSwitch, apply } from './index.js';
const settle = () => new Promise(r => setImmediate(r));
function harness(send) {
 const cells=[],cleanups=[];let i=0,tree;
 const React={ createElement(type,props,...children){return {type,props:props??{},children:children.flat().filter(x=>x!==false&&x!=null)};},
 useState(v){const n=i++;if(!(n in cells))cells[n]=v;return[cells[n],v=>{cells[n]=typeof v==='function'?v(cells[n]):v;}];},
 useRef(v){return cells[i++]??={current:v};},useEffect(fn){const n=i++;if(!(n in cells)){cells[n]=true;cleanups.push(fn());}}};
 const client=createSimplePetClient(React,send),render=()=>{i=0;return tree=client.SimplePetSettings();};
 const nodes=(n=tree)=>n&&typeof n==='object'?[n,...n.children.flatMap(nodes)]:[];
 const find=k=>{const n=nodes().find(n=>n.props[k]);assert(n,k);return n;};
 const text=(n=tree)=>n&&typeof n==='object'?n.children.map(text).join(''):String(n??'');
 render();return {render,nodes,find,text,cleanup(){cleanups.forEach(fn=>fn?.());}};
}
const list={enabled:true,token:'opaque-confirm',validForMs:15000,provider:'openai-codex',selection:'active',current:'A',accounts:[{target:'A',label:'a***@e***.com',current:true},{target:'B',label:'b***@e***.com',current:false}]};
function fixture(response=list) {
 const calls=[];let switchResponse=()=>Response.json({ok:true}),listResponse=()=>Response.json(response);
 const ui=harness(async(url,init={})=>{calls.push({url,...init});
 if(url.endsWith('/accounts')){const body=JSON.parse(init.body);return body.action==='list'?listResponse():switchResponse();}
 if(url.endsWith('/preferences'))return Response.json({values:{...DEFAULT_PREFERENCES,billingMode:'codex'},revision:'a'.repeat(64)});
 return Response.json({status:'unavailable'});});
 return {...ui,calls,setSwitch(fn){switchResponse=fn;},setList(fn){listResponse=fn;}};
}
async function load(ui){await settle();ui.render();await ui.find('data-account-list').props.onClick();await settle();ui.render();}
function prepare(ui){ui.find('data-account-target').props.onChange({target:{value:'B'}});ui.render();ui.find('data-account-prepare').props.onClick();ui.render();}
test('mount and preference editing never enumerate or mutate upstream accounts',async()=>{
 const ui=fixture();try{await settle();ui.render();assert.equal(ui.calls.length,4);assert(!ui.calls.some(c=>c.url.endsWith('/accounts')));assert.equal(ui.find('data-account-prepare').props.disabled,true);assert.match(ui.text(),/多账号 warm-up 未启用/);}finally{ui.cleanup();}
});
test('fresh 2-account list requires explicit selection and a separate shared-account confirmation',async()=>{
 const ui=fixture();try{await load(ui);assert.equal(ui.find('data-account-prepare').props.disabled,true);prepare(ui);assert.match(ui.text(),/其他会话也可能受影响/);
 assert.equal(ui.calls.filter(c=>c.url.endsWith('/accounts')).length,1);const confirm=ui.find('data-account-confirm');confirm.props.onClick();confirm.props.onClick();await settle();ui.render();
 const posts=ui.calls.filter(c=>c.url.endsWith('/accounts')).map(c=>JSON.parse(c.body));assert.deepEqual(posts,[{action:'list'},{action:'switch',token:list.token,target:'B',confirm:true}]);assert.match(ui.text(),/订阅插件已确认/);assert(!ui.nodes().some(n=>n.props['data-account-confirm']));
 }finally{ui.cleanup();}
});
test('cancel revokes local confirmation without a switch or settings write',async()=>{
 const ui=fixture();try{await load(ui);prepare(ui);ui.nodes().find(n=>n.type==='button'&&ui.text(n)==='取消切号').props.onClick();ui.render();assert.equal(ui.calls.filter(c=>c.url.endsWith('/accounts')).length,1);assert(!ui.nodes().some(n=>n.props['data-account-confirm']));assert(!ui.calls.some(c=>c.method==='PUT'));}finally{ui.cleanup();}
});
test('0/1/invalid capability views never enable target or confirmation',async()=>{
 for(const value of [{enabled:false,reason:'至少需要两个有效账号'}, {...list,accounts:list.accounts.slice(0,1)}, {...list,validForMs:0}]){const ui=fixture(value);try{await load(ui);assert.equal(ui.find('data-account-target').props.disabled,true);assert.equal(ui.find('data-account-prepare').props.disabled,true);}finally{ui.cleanup();}}
});
test('monotonic lease expiry disables confirmation even when the handler was captured',async t=>{
 let elapsed=0;t.mock.method(performance,'now',()=>elapsed);const ui=fixture();try{await load(ui);prepare(ui);const confirm=ui.find('data-account-confirm');elapsed=15000;ui.render();assert.equal(ui.find('data-account-confirm').props.disabled,true);confirm.props.onClick();await settle();assert.equal(ui.calls.filter(c=>c.url.endsWith('/accounts')).length,1);}finally{ui.cleanup();}
});
test('uncertain write clears token and never retries, rolls back or claims success',async()=>{
 const ui=fixture();try{await load(ui);prepare(ui);ui.setSwitch(()=>Response.json({error:'unknown'},{status:503}));ui.find('data-account-confirm').props.onClick();await settle();ui.render();assert.match(ui.text(),/未获得切号成功确认/);assert(!ui.nodes().some(n=>n.props['data-account-confirm']));assert.equal(ui.calls.filter(c=>c.url.endsWith('/accounts')).length,2);}finally{ui.cleanup();}
});
test('captured confirmation callbacks are revoked on cancel, unmount and target changes',async()=>{
 for(const action of ['cancel','unmount','target']){const ui=fixture();try{await load(ui);prepare(ui);const oldConfirm=ui.find('data-account-confirm').props.onClick;
 if(action==='cancel')ui.nodes().find(n=>n.type==='button'&&ui.text(n)==='取消切号').props.onClick();
 if(action==='unmount')ui.cleanup();
 if(action==='target')ui.find('data-account-target').props.onChange({target:{value:'A'}});
 oldConfirm();await settle();assert.equal(ui.calls.filter(c=>c.url.endsWith('/accounts')).length,1,action);
 }finally{ui.cleanup();}}
});
test('unknown mutation latches automatic warmup off even after fresh reads, late results or later confirmations',()=>{
 assert.equal(warmupAfterAccountSwitch(false,{attempted:false,confirmed:false}),false);
 assert.equal(warmupAfterAccountSwitch(false,{attempted:true,confirmed:true}),false);
 let paused=warmupAfterAccountSwitch(false,{attempted:true,confirmed:false});assert.equal(paused,true);
 for(const evidence of [undefined,{attempted:false,confirmed:false},{attempted:true,confirmed:true}]){paused=warmupAfterAccountSwitch(paused,evidence);assert.equal(paused,true);}
});
test('unmount aborts pending explicit list and a late response cannot execute a write',async()=>{
 const ui=fixture();await settle();let release;ui.setList(()=>new Promise(r=>release=r));ui.render();ui.find('data-account-list').props.onClick();ui.cleanup();const pending=ui.calls.at(-1);assert.equal(pending.signal.aborted,true);release(Response.json(list));await settle();assert.equal(ui.calls.filter(c=>c.url.endsWith('/accounts')).length,1);
});
test('public manifest gate accepts only reviewed names and exact versions, not inferred providers',async()=>{
 const root=await mkdtemp(join(tmpdir(),'DshSwitchManifest-'));const plugin=join(root,'pet');await mkdir(plugin);
 try{for(const [provider,name,version] of [['openai-codex','dsh-codex-subscription','2.6.8'],['codex','dsh-plugin-subscriptions','0.9.9']]){const dir=join(root,name);await mkdir(dir);assert.equal(accountSwitchCapability(provider,plugin),false);await writeFile(join(dir,'package.json'),JSON.stringify({name,version}));assert.equal(accountSwitchCapability(provider,plugin),true);await writeFile(join(dir,'package.json'),JSON.stringify({name,version:'999.0.0'}));assert.equal(accountSwitchCapability(provider,plugin),false);}assert.equal(accountSwitchCapability('__proto__',plugin),false);}finally{assert(root.startsWith(join(tmpdir(),'DshSwitchManifest-')));await rm(root,{recursive:true,force:true});}
});
async function invoke(handler,body,method='POST'){let code,headers,result;const bytes=body===undefined?null:Buffer.from(JSON.stringify(body));const req={method,headers:{'content-type':'application/json'},async *[Symbol.asyncIterator](){if(bytes)yield bytes;}};await handler(req,{writeHead(c,h){code=c;headers=h;},end(b){result=b;}});return {code,data:result&&headers['Content-Type'].includes('json')?JSON.parse(result):null};}
test('actual backend wires auth, no-I/O capability read and verified mutation, invalidates identity and never calls LLM',async()=>{
 const root=await mkdtemp(join(tmpdir(),'DshSwitchHost-'));const old=process.env.LOCALAPPDATA,profile=process.env.DSH_PET_PROFILE;process.env.LOCALAPPDATA=root;process.env.DSH_PET_PROFILE='web';
 const routes=new Map(),events=new Map(),cleanups=[],calls=[];let active='a',deny,selectFailure=false;
 const bridge={async fetch(req){const b=await req.json();calls.push(b);if(b.method.endsWith('/select')){active=b.payload.id;if(selectFailure)return new Response('',{status:503});}const value=b.method.endsWith('/usage')?{fetchedAt:Date.now(),rateLimits:[{id:'codex',windows:[{windowSeconds:18000,remainingPercent:80,resetsAt:Math.floor(Date.now()/1000)+1000}]}]}:{authenticated:true,accounts:[{id:'a',active:active==='a'},{id:'b',active:active==='b'}]};return Response.json({type:'server-response',rpcId:b.rpcId,result:{ok:true,value}});}};
 const services={effect(fn){cleanups.push(fn());},webServer:{register({path,handler}){routes.set(path,handler);return()=>routes.delete(path);}},connection:{requestRejection(){return deny;},createSharedFetchHandler(){return bridge;}}};
 try{apply({...services,inject(_n,fn){fn(services);},on(name,fn){events.set(name,fn);},get(){return null;},settings:{describe(){return[];}},credentials:{resolve(){assert.fail('no credentials');}},llm:{listConfigurableProviders(){return[];},stream(){assert.fail('no models');}}},{petLauncher(){return()=>{};},switchSupported:()=>true});
 for(let i=0;i<40&&calls.length<3;i++)await settle();const handler=routes.get('/api/dsh-plugin-simple-pet/accounts');assert(handler);let count=calls.length;
 assert.equal((await invoke(handler,undefined,'GET')).data.multiWarmup.available,false);assert.equal(calls.length,count);deny=401;assert.equal((await invoke(handler,{action:'list'})).code,401);deny=undefined;
 const available=(await invoke(handler,{action:'list'})).data;assert.equal(available.enabled,true);const target=available.accounts.find(a=>!a.current).target;
 const switched=await invoke(handler,{action:'switch',token:available.token,target,confirm:true});assert.equal(switched.data.ok,true);assert.equal(active,'b');assert.equal(calls.filter(c=>c.method.endsWith('/select')).length,1);
 for(let i=0;i<10;i++)await settle();
 const beforeABA=(await invoke(handler,{action:'list'})).data;
 const writesBefore=calls.filter(c=>c.method.endsWith('/select')).length;
 for(const [i,provider] of ['codex','openai-codex'].entries())events.get('session/event')({id:'aba'}, {seq:i+1,type:'assistant/message',time:new Date().toISOString(),data:{message:{source:{kind:'model',provider,model:'test'}}}});
 for(let i=0;i<20;i++)await settle();
 const rejectedABA=await invoke(handler,{action:'switch',token:beforeABA.token,target:beforeABA.accounts.find(a=>!a.current).target,confirm:true});assert.equal(rejectedABA.code,409);assert.equal(calls.filter(c=>c.method.endsWith('/select')).length,writesBefore,'source ABA invalidates old confirmation');
 for(let i=0;i<10;i++)await settle();
 const fresh=(await invoke(handler,{action:'list'})).data;assert.equal(fresh.enabled,true);selectFailure=true;
 assert.equal((await invoke(handler,{action:'switch',token:fresh.token,target:fresh.accounts.find(a=>!a.current).target,confirm:true})).code,503);
 for(let i=0;i<20;i++)await settle();
 const paused=await invoke(routes.get('/api/dsh-plugin-simple-pet/state'),undefined,'GET');assert.equal(paused.data.codexWarmup.accountSwitchPaused,true);assert.match(paused.data.codexWarmup.detail,/预热已暂停/);const callsAfterUnknown=calls.length;assert.equal((await invoke(handler,{action:'list'})).code,409);assert.equal(calls.length,callsAfterUnknown,'uncertain local write quarantines further control RPCs');
 const current=await invoke(routes.get('/api/dsh-plugin-simple-pet/account'),undefined,'GET');assert(current.data.status !== 'ready' || current.data.accountKey === createHash('sha256').update(active).digest('hex').slice(0,16), 'never re-pair old identity after switch');
 }finally{for(const fn of cleanups.reverse())await fn?.();if(old===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=old;if(profile===undefined)delete process.env.DSH_PET_PROFILE;else process.env.DSH_PET_PROFILE=profile;assert(root.startsWith(join(tmpdir(),'DshSwitchHost-')));await rm(root,{recursive:true,force:true});}
});
