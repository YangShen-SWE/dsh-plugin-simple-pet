import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createSimplePetClient } from './client-source.js';
import { DEFAULT_PREFERENCES } from './preferences.js';
import { apply as applyPet } from './index.js';
import { apply as applyAccounts } from './codex-accounts/index.js';
const settle=()=>new Promise(r=>setImmediate(r));
const token=id=>`eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:id}})).toString('base64url')}.MOCK_SIGNATURE`;
function uiFixture(send){
 const cells=[],cleanups=[];let i=0,tree;
 const React={createElement(type,props,...children){return{type,props:props??{},children:children.flat().filter(v=>v!==false&&v!=null)};},useState(v){const n=i++;if(!(n in cells))cells[n]=v;return[cells[n],v=>{cells[n]=typeof v==='function'?v(cells[n]):v;}];},useRef(v){return cells[i++]??={current:v};},useEffect(fn){const n=i++;if(!(n in cells)){cells[n]=true;cleanups.push(fn());}}};
 const client=createSimplePetClient(React,send),render=()=>{i=0;return tree=client.SimplePetSettings();};
 const nodes=(n=tree)=>n&&typeof n==='object'?[n,...n.children.flatMap(nodes)]:[];const text=(n=tree)=>n&&typeof n==='object'?n.children.map(text).join(''):String(n??'');render();
 return{render,nodes,text,find:k=>nodes().find(n=>n.props[k]!==undefined),cleanup(){cleanups.splice(0).forEach(f=>f?.());}};
}
function webFixture(backend='official',bound=true){
 const calls=[];let catalogue={busy:false,generation:1,defaultKey:'a'.repeat(16),accounts:[{accountKey:'a'.repeat(16),label:'A',selected:true,bound},{accountKey:'b'.repeat(16),label:'B',selected:false,bound}]};
 const ui=uiFixture(async(url,init={})=>{calls.push({url,...init});if(url.endsWith('/preferences'))return Response.json({values:{...DEFAULT_PREFERENCES,billingMode:'codex',codexAccountBackend:backend},revision:'r'});if(url.endsWith('/official-accounts')){if(init.method==='POST'){const b=JSON.parse(init.body);if(b.action==='login.start')catalogue={...catalogue,login:{id:'login',status:'running',url:'https://auth.openai.com/mock',userCode:'ABC-123'}};if(b.action==='account.select')catalogue={...catalogue,generation:2,defaultKey:b.accountKey,accounts:catalogue.accounts.map(a=>({...a,selected:a.accountKey===b.accountKey}))};}return Response.json(catalogue);}return Response.json({});});return{ui,calls};
}
test('official backend UI never logs in, reads extra accounts or sends model on mount',async()=>{const{ui,calls}=webFixture();try{await settle();ui.render();assert.equal(calls.length,4);assert.equal(ui.find('data-official-read').props.disabled,false);assert(!calls.some(c=>c.url.endsWith('/official-accounts')));assert.match(ui.text(),/ChatGPT.*OAuth/);assert.match(ui.text(),/不是.*API Key/);}finally{ui.cleanup();}});
test('unsaved backend change cannot send official operation',async()=>{const{ui,calls}=webFixture('legacy');try{await settle();ui.render();ui.nodes().find(n=>n.props.name==='codexAccountBackend').props.onChange({target:{value:'official'}});ui.render();await ui.find('data-official-read').props.onClick();await settle();ui.render();assert.equal(calls.length,4);assert.match(ui.text(),/保存/);}finally{ui.cleanup();}});
test('explicit catalogue, official login and default selection are distinct from warmup',async()=>{const{ui,calls}=webFixture();try{await settle();ui.render();await ui.find('data-official-read').props.onClick();await settle();ui.render();assert(ui.find('data-official-select'));
 const target=ui.nodes().find(n=>n.props['data-official-select']==='b'.repeat(16));assert.equal(target.props.disabled,false);await target.props.onClick();await settle();ui.render();assert.equal(JSON.parse(calls.findLast(c=>c.method==='POST').body).expectedGeneration,1);
 ui.find('data-official-add').props.onClick();ui.render();await ui.find('data-official-login').props.onClick();await settle();ui.render();assert.equal(JSON.parse(calls.findLast(c=>c.method==='POST').body).action,'login.start');assert(!calls.some(c=>c.body&&/warmup/.test(c.body)));assert(!ui.text().includes('PRIVATE_ACCESS'));}finally{ui.cleanup();}});
test('unreadable binding keeps default-select disabled and explains revocation recovery',async()=>{const{ui,calls}=webFixture('official',false);try{await settle();ui.render();await ui.find('data-official-read').props.onClick();await settle();ui.render();assert(ui.nodes().filter(n=>n.props['data-official-select']).every(n=>n.props.disabled));assert.match(ui.text(),/凭据不可用/);assert(!calls.some(c=>c.method==='POST'));}finally{ui.cleanup();}});
test('captured official action cannot run after unmount or backend draft revocation',async()=>{for(const mode of ['unmount','change']){const{ui,calls}=webFixture();await settle();ui.render();ui.find('data-official-add').props.onClick();ui.render();const old=ui.find('data-official-login');if(mode==='unmount')ui.cleanup();else{ui.nodes().find(n=>n.props.name==='codexAccountBackend').props.onChange({target:{value:'legacy'}});ui.render();}await old.props.onClick();await settle();assert.equal(calls.length,4);ui.cleanup();}});

test('captured official callback stays revoked across backend ABA and clears old account rows',async()=>{
 const {ui,calls}=webFixture();try{await settle();ui.render();await ui.find('data-official-read').props.onClick();await settle();ui.render();assert(ui.find('data-official-account-row'));
 ui.find('data-official-add').props.onClick();ui.render();const old=ui.find('data-official-login').props.onClick;
 for(const value of ['legacy','official']){ui.nodes().find(n=>n.props.name==='codexAccountBackend').props.onChange({target:{value}});ui.render();}
 const before=calls.length;await old();await settle();ui.render();assert.equal(calls.length,before);assert(!ui.find('data-official-account-row'));
 }finally{ui.cleanup();}
});
test('top save is outside the scrolling form and saves preferences only from the account page',async()=>{
 const calls=[];const ui=uiFixture(async(url,init={})=>{calls.push({url,...init});return Response.json(url.endsWith('/preferences')?{values:{...DEFAULT_PREFERENCES,billingMode:'codex'},revision:'r'}:{});});
 try{await settle();ui.render();ui.nodes().find(n=>n.props['data-pet-tab']==='accounts').props.onClick();ui.render();ui.nodes().find(n=>n.props.name==='codexAccountBackend').props.onChange({target:{value:'official'}});ui.render();
 const toolbar=ui.find('data-settings-toolbar'),save=ui.find('data-settings-save');assert(toolbar);assert.equal(save.type,'button');assert.equal(save.props.disabled,false);
 assert(!ui.nodes().filter(n=>n.type==='form').some(n=>ui.nodes(n).includes(save)));
 await save.props.onClick();await settle();ui.render();const puts=calls.filter(c=>c.method==='PUT');assert.equal(puts.length,1);assert.deepEqual(JSON.parse(puts[0].body).patch,{codexAccountBackend:'official'});assert(!calls.some(c=>c.url.endsWith('/official-accounts')||c.url.endsWith('/multi-warmup')));
 }finally{ui.cleanup();}
});

async function actualFixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'DshOfficialHost-')),before={LOCALAPPDATA:process.env.LOCALAPPDATA,DSH_PET_PROFILE:process.env.DSH_PET_PROFILE};process.env.LOCALAPPDATA=root;process.env.DSH_PET_PROFILE='desktop';
 const data=path.join(root,'DshSimpleDesktopPet');await fs.mkdir(data);await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({...DEFAULT_PREFERENCES,billingMode:'codex',codexAccountBackend:'official',multiAccountManagement:true}));
 const routes=new Map(),fetchRoutes=new Map(),cleanups=[],records=new Map(),tails=new Map(),streams=[];let panel,loginNumber=0,registered;
 const credentials={readRecord:async k=>structuredClone(records.get(k)),modifyRecord(k,fn){const p=(tails.get(k)||Promise.resolve()).then(async()=>{const n=await fn(structuredClone(records.get(k)));if(n!==undefined)records.set(k,structuredClone(n));return structuredClone(records.get(k));});tails.set(k,p.catch(()=>{}));return p;},deleteRecord:async k=>{records.delete(k);}};
 const driver=async({credentials:store})=>({async login(){const n=++loginNumber;await store.modify('openai-codex',()=>({type:'oauth',access:token(`LOGIN_${n}`),refresh:`PRIVATE_REFRESH_${n}`,accountId:`LOGIN_${n}`,expires:Date.now()+3600000}));},auth:async()=>({apiKey:(await store.read('openai-codex')).access}),listModels:async()=>[{id:'codex-mini',name:'Codex mini'}],prepare:async()=>({model:{provider:'openai-codex',id:'codex-mini',reasoning:{efforts:[{id:'low'}]}},stream:options=>(async function*(){streams.push({identity:(await store.read('openai-codex')).accountId,options});yield{type:'text-delta',text:'OK'};yield{type:'usage',usage:{inputTokens:3,outputTokens:1}};yield{type:'finish',reason:{kind:'stop'}};})()})});
 async function invoke(p,method='GET',body){let code=200,raw='',headers={};const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{method,headers:{'content-type':'application/json'}});const handler=routes.get(p);if(!handler)return{code:404,data:{},headers};await handler(req,{writeHead(c,h){code=c;headers=h||{};},setHeader(k,v){headers[k]=v;},end(b){raw=b||'';}});return{code,data:raw?JSON.parse(raw):null,headers};}
 const bridge={async fetch(req){const route=fetchRoutes.get(new URL(req.url).pathname);return route?.methods.includes(req.method)?route.fetch(req):new Response('not found',{status:404});}};
 const connection={requestRejection:()=>undefined,fetch:{register(route){fetchRoutes.set(route.path,route);const dispose=()=>fetchRoutes.delete(route.path);cleanups.push(dispose);return dispose;}},createSharedFetchHandler:()=>bridge,onProviderChange:()=>()=>{},provider:'openai-codex'};
 const ctx={logger:{warn(){}},credentials,settings:{describe:()=>[]},sessions:{on(){}},llm:{registerAdapter(providers,adapter){registered={providers,adapter};return()=>{};},listConfigurableProviders:()=>[]},effect(fn){const c=fn();if(typeof c==='function')cleanups.push(c);},on(){},inject(names,fn){const c=fn({...this,connection,webServer:{register({path,handler}){routes.set(path,handler);return()=>routes.delete(path);}}});if(typeof c==='function')cleanups.push(c);}};
 const service=await applyAccounts(ctx,{directoryFile:path.join(root,'accounts','directory.json'),driver,fetchImpl:async(_url,init)=>new Response(JSON.stringify({account_id:init.headers['ChatGPT-Account-Id'],rate_limit:{allowed:true,primary_window:{used_percent:10,limit_window_seconds:18000,reset_at:Math.floor(Date.now()/1000)+3600},secondary_window:{used_percent:20,limit_window_seconds:604800,reset_at:Math.floor(Date.now()/1000)+86400}}}))});
 const add=async label=>{await service.beginLogin(label);for(let i=0;i<100;i++){const c=await service.catalogue();if(c.login.status==='completed')return c.accounts.find(a=>a.label===label);await new Promise(r=>setTimeout(r,5));}throw Error('mock login timed out');};
 t.after(async()=>{for(const fn of cleanups.reverse())await fn();for(const[k,v]of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}assert(root.startsWith(path.join(os.tmpdir(),'DshOfficialHost-')));await fs.rm(root,{recursive:true,force:true});});
 const a=await add('A'),b=await add('B');applyPet(ctx,{petLauncher:()=>Object.assign(()=>{}, {applicationRuntime:()=>({active:true})}),panelStarter:async options=>{panel=options;return{url:'http://127.0.0.1:1/panel',token:'a'.repeat(64),close(){}};}});
 for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,5));if(panel&&(await panel.read()).canSwitch)break;}
 return{root,service,invoke,bridge,streams,a,b,get panel(){return panel;},registered};
}
test('actual two plugins integrate official quota, panel cycle, discovery and fixed-account run without old plugin',async t=>{
 const f=await actualFixture(t);assert.deepEqual(f.registered.providers,['codex-accounts']);assert(f.panel);let v;for(let i=0;i<100;i++){v=await f.panel.read();if(v.canSwitch)break;await new Promise(r=>setTimeout(r,5));}assert.equal(v.canSwitch,true,JSON.stringify(v));assert.equal(v.email,'A');
 let state;for(let i=0;i<100;i++){state=(await f.invoke('/api/dsh-plugin-simple-pet/state')).data;if(state.codex.provider==='codex-accounts')break;await new Promise(r=>setTimeout(r,5));}assert.equal(state.codex.provider,'codex-accounts',JSON.stringify(state.codex));assert.equal(state.codex.fiveHour.remainingPercent,90);assert.equal(state.codex.observedAt,null);assert.equal(f.streams.length,0);assert(!JSON.stringify(state).includes('PRIVATE_ACCESS'));
 for(let i=0;i<100;i++){if((await f.panel.read()).canSwitch)break;await new Promise(r=>setTimeout(r,5));}
 const panelGrant=(await f.panel.read()).grant;await assert.rejects(f.panel.cycle('invalid-grant'));await f.panel.cycle(panelGrant);assert.equal((await f.service.catalogue()).defaultKey,f.b.accountKey);assert.equal(f.streams.length,0);
 const read=await f.invoke('/api/dsh-plugin-simple-pet/multi-warmup','POST',{action:'discover'});assert.equal(read.code,200,JSON.stringify(read.data));assert.equal(read.data.accounts.length,2);
 const model=read.data.accounts.find(a=>a.accountKey===f.a.accountKey).models[0];
 const fromProvider=await f.registered.adapter.prepareCall('codex-accounts',`${f.a.accountKey}:${model.modelKey}`);for await(const _ of fromProvider.stream({signal:AbortSignal.timeout(1000),tools:[],messages:[{role:'user',content:[{type:'text',text:'Mock only'}]}]})){}assert.equal(f.streams.at(-1).identity,'LOGIN_1');
 const privateFiles=await fs.readFile(path.join(f.root,'accounts','directory.json'),'utf8');assert(!/PRIVATE_ACCESS|PRIVATE_REFRESH|LOGIN_1/.test(privateFiles));
});
