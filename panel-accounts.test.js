import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startPanelAccounts, createPanelCycle } from './panel-accounts.js';
import { createAccountControl } from './account-control.js';
import { codexIdentity, identityEvidence, panelIdentityEvidence } from './codex-identity.js';
import { apply } from './index.js';
const G='a'.repeat(64), settle=()=>new Promise(r=>setImmediate(r));
function rpcBridge(handle) { return { async fetch(req) { const body=await req.json(); const response=await handle(null,{body:JSON.stringify({method:body.method,params:body.payload})});
  if (!response.ok) return response;
  return Response.json({type:'server-response',rpcId:body.rpcId,result:{ok:true,value:await response.json()}});
} }; }
function controlFixture(){let active='A',enabled=true,writes=0,changed=[];const bridge=rpcBridge(async(_url,init)=>{const {method,params}=JSON.parse(init.body);
 if(method==='codex-subscription/status')return Response.json({authenticated:true,accounts:['A','B','C'].map(id=>({id,email:`${id}@example.com`,active:id===active}))});
 if(method==='codex-subscription/account/select'){writes++;active=params.id;return Response.json({ok:true});}throw Error(method);});
 const control=createAccountControl({context:()=>enabled?{bridge,provider:'openai-codex',generation:1}:null,blocked:()=>false,begin:()=>true,end(){},changed(e){changed.push(e);}});
 return {control,grant:()=>enabled?G:null,ready:()=>enabled,disable(){enabled=false;},get active(){return active;},get writes(){return writes;},changed};}
test('panel click cycles to next account without additional UI confirmation, preserving controller checks',async()=>{
 const f=controlFixture();try{const cycle=createPanelCycle(f);await cycle(G);assert.equal(f.active,'B');await cycle(G);assert.equal(f.active,'C');await cycle(G);assert.equal(f.active,'A');assert.equal(f.writes,3);assert(f.changed.every(e=>e.confirmed));}finally{f.control.dispose();}
});
test('wrong or disabled grant never enumerates or writes',async()=>{
 const f=controlFixture();try{const cycle=createPanelCycle(f);await assert.rejects(cycle('b'.repeat(64)));f.disable();await assert.rejects(cycle(G));assert.equal(f.writes,0);}finally{f.control.dispose();}
});
test('closing grant during list or changing account list produces zero writes',async()=>{
 const f=controlFixture();const original=f.control.list;const cycle=createPanelCycle({...f,control:{...f.control,async list(){const result=await original();f.disable();return result;}}});
 try{await assert.rejects(cycle(G));assert.equal(f.writes,0);}finally{f.control.dispose();}
});
test('second simultaneous click rejected before another list, failure never retries',async()=>{
 let release,calls=0;const cycle=createPanelCycle({grant:()=>G,ready:()=>true,control:{list(){calls++;return new Promise(r=>release=r);},switch(){throw Error('unknown');}}});
 const first=cycle(G);await assert.rejects(cycle(G));release({enabled:true,token:'x',accounts:[{target:'A',current:true},{target:'B'}]});await assert.rejects(first);assert.equal(calls,1);
});
test('full email stays non enumerable and out of quota/web identity DTO',()=>{
 const identity=codexIdentity({row:{email:'private.full@example.com'}},'openai-codex','a'.repeat(16),Date.now());
 assert.equal(identity.panelEmail,'private.full@example.com');assert(!JSON.stringify(identity).includes('private.full'));
 assert(!JSON.stringify(identityEvidence({status:'ready',provider:'openai-codex',selection:'active',accountKey:'a'.repeat(16),observedAt:Date.now()},identity)).includes('private.full'));
});
test('status-confirmed panel identity does not turn missing or stale quota into usable warm-up evidence',()=>{
 const now=Date.now(), key='a'.repeat(16), identity=codexIdentity({row:{account:'full@example.com'}},'codex',key,now);
 for (const status of ['reported','unavailable','stale']) {
   const quota={status,provider:'codex',selection:'default',accountKey:key,fiveHour:{resetAt:now-1}};
   assert.equal(panelIdentityEvidence(quota,identity,now).status,'ready');
   assert.equal(identityEvidence(quota,identity,now).status,'unavailable');
 }
 for (const quota of [{status:'switching'},{status:'loading'},{status:'unavailable',provider:'codex',selection:'default',accountKey:'b'.repeat(16)}]) assert.equal(panelIdentityEvidence(quota,identity,now).status,'unavailable');
 assert.equal(panelIdentityEvidence({status:'unavailable',provider:'codex',selection:'default',accountKey:key},identity,now+120000).status,'unavailable');
});
test('ephemeral channel rejects browser origins, missing/wrong/UTF8 auth, invalid paths and methods',async()=>{
 let reads=0,writes=0;const server=await startPanelAccounts({read:()=>{reads++;return {enabled:false};},cycle:async()=>writes++});
 try{for(const authorization of [undefined,'Bearer bad','Bearer '+'é'.repeat(64)])assert.equal((await fetch(server.url,{headers:authorization?{Authorization:authorization}:{}})).status,403);
 const headers={Authorization:`Bearer ${server.token}`};assert.equal((await fetch(server.url,{headers:{...headers,Origin:'http://evil'}})).status,403);
 assert.equal((await fetch(server.url+'/other',{headers})).status,404);assert.equal((await fetch(server.url,{method:'PUT',headers})).status,405);
 assert.equal((await fetch(server.url,{headers})).status,200);assert.equal(reads,1);assert.equal(writes,0);
 }finally{server.close();}
});
test('native charset POST accepted, body bounded, owned process required and no CORS headers',async()=>{
 let active=true,writes=0;const server=await startPanelAccounts({runtime:()=>({active}),read:()=>({enabled:true,canSwitch:false,email:'',selection:'none',validForMs:2000}),cycle:async grant=>{assert.equal(grant,G);writes++;}});
 const headers={Authorization:`Bearer ${server.token}`,'Content-Type':'application/json; charset=utf-8'};
 try{const post=body=>fetch(server.url,{method:'POST',headers,body:typeof body==='string'?body:JSON.stringify(body)});
 assert.equal((await post({action:'cycle',grant:G})).status,200);assert.equal(writes,1);
 for(const body of [{action:'cycle',grant:G+'\n'},{action:'switch',grant:G},{action:'cycle',grant:G,extra:true},'x'.repeat(1025)])assert((await post(body)).status>=400);
 active=false;assert.equal((await post({action:'cycle',grant:G})).status,409);assert.equal(writes,1);
 const response=await fetch(server.url,{headers});assert.equal(response.headers.get('access-control-allow-origin'),null);assert.equal(response.headers.get('cache-control'),'no-store');
 }finally{server.close();}
});
test('actual backend keeps full email memory only, new unified-owner grant gates writes and malformed public requests fail closed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'DshPanelHost-'));const before={LOCALAPPDATA:process.env.LOCALAPPDATA,DSH_PET_PROFILE:process.env.DSH_PET_PROFILE};process.env.LOCALAPPDATA=root;process.env.DSH_PET_PROFILE='desktop';
 const routes=new Map(),events=new Map(),cleanups=[];let selected='A',writes=0,panel,runtime=true;let source='openai-codex',providerChange;
 const dir=join(root,'DshSimpleDesktopPet');await mkdir(dir);const prefs=join(dir,'settings.json');await writeFile(prefs,JSON.stringify({billingMode:'codex',codexUnifiedControls:true}));
 const invoke=async(path,method='GET')=>{let code,raw;await routes.get(path)({method,headers:{}},{writeHead(c){code=c;},end(body){raw=body;}});return {code,data:raw&&JSON.parse(raw)};};
 const bridge=rpcBridge(async(_url,init)=>{const {method,params}=JSON.parse(init.body);
 if(method==='codex-subscription/status')return Response.json({authenticated:true,accounts:['A','B'].map(id=>({id,email:`full.${id}@example.com`,active:id===selected}))});
 if(method==='codex-subscription/usage')return Response.json({fetchedAt:Date.now(),limits:[]});
 if(method==='codex-subscription/account/select'){selected=params.id;writes++;return Response.json({ok:true});}return new Response('',{status:404});});
 const ctx={plugin(){},logger:{warn(){}},credentials:{async resolve(){throw Error('no secrets');}},settings:{describe:()=>[]},sessions:{on(){}},llm:{listConfigurableProviders:()=>[]},effect(fn){const c=fn();if(typeof c==='function')cleanups.push(c);},on(e,fn){events.set(e,fn);},inject(names,fn){const child={...this,connection:{...bridge,requestRejection:()=>undefined,createSharedFetchHandler:()=>bridge,onProviderChange(fn){providerChange=fn;return()=>{};},get provider(){return source;}},webServer:{register({path,handler}){routes.set(path,handler);return()=>routes.delete(path);}}};const c=fn(child);if(typeof c==='function')cleanups.push(c);}};
 try{apply(ctx,{subscriptionFactory:({onOwner})=>{onOwner('embedded');return ()=>{};},switchSupported:()=>true,petLauncher:()=>Object.assign(()=>{}, {applicationRuntime:()=>({active:runtime})}),panelStarter:async options=>{panel=options;return {url:'http://127.0.0.1:1/panel',token:'a'.repeat(64),close(){}};}});
 let view;for(let i=0;i<100;i++){await new Promise(resolve=>setTimeout(resolve,5));if(panel){view=await panel.read();if(view.canSwitch)break;}}assert(panel);assert.equal(view.email,'full.A@example.com');assert.equal(view.canSwitch,true,JSON.stringify(view));assert.equal((await invoke('/api/dsh-plugin-simple-pet/accounts','POST')).code,410);
 const publicState=await invoke('/api/dsh-plugin-simple-pet/state');assert(!JSON.stringify(publicState).includes('full.A'));assert(!JSON.stringify(await invoke('/api/dsh-plugin-simple-pet/account')).includes('full.A'));
 for(let i=0;i<100;i++){view=await panel.read();if(view.canSwitch)break;await new Promise(resolve=>setTimeout(resolve,5));}
  await panel.cycle(view.grant);assert.equal(writes,1);for(let i=0;i<10;i++)await settle();assert.equal((await panel.read()).email,'full.B@example.com');
 const old=(await panel.read()).grant;await writeFile(prefs,JSON.stringify({billingMode:'codex',codexUnifiedControls:false}));const readonly=await panel.read();assert.equal(readonly.enabled,true);assert.equal(readonly.canSwitch,false);assert.equal(readonly.email,'f***@e***.com');await assert.rejects(panel.cycle(old));assert.equal(writes,1);
 runtime=false;assert.equal(panel.runtime().active,false);
 }finally{for(const c of cleanups.reverse())await c?.();for(const [key,val]of Object.entries(before)){if(val===undefined)delete process.env[key];else process.env[key]=val;}assert(root.startsWith(join(tmpdir(),'DshPanelHost-')));await rm(root,{recursive:true,force:true});}
});
test('native panel isolated WPF regression',()=>{
 if(process.platform!=='win32')return;
 const result=spawnSync('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./panel-accounts.test.ps1',import.meta.url))],{stdio:'inherit'});
 assert.equal(result.status,0);
});
