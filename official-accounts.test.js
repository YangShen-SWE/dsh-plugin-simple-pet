import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { AccountDirectory, createAccountService, fixedCredentialView, hash } from './codex-accounts/service.js';
import { createOfficialDriver, createBoundAdapter } from './codex-accounts/official-driver.js';
import { parseQuota, fetchQuota } from './codex-accounts/quota.js';
import { accountServiceHandler, apply as applyAccounts } from './codex-accounts/index.js';
import { readOfficialQuota, discoverOfficialAccounts, runOfficialWarmup, officialAccountsProxy, officialAccountRpc } from './official-accounts.js';
import { MultiWarmupStore } from './multi-warmup.js';
const NOW = Date.now();
const token = id => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:id}})).toString('base64url')}.MOCK_SIGNATURE`;
const rawQuota = (extra = {}) => ({ account_id: 'account-1', rate_limit: { allowed: true, primary_window: { used_percent: 20, reset_at: Math.floor(NOW / 1000) + 3600, limit_window_seconds: 18000 }, secondary_window: { used_percent: 40, reset_at: Math.floor(NOW / 1000) + 86400, limit_window_seconds: 604800 } }, ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
async function fixture(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'DshOfficialAccounts-'));
  const directory = new AccountDirectory(path.join(dir, 'accounts.json'));
  const records = new Map(), tails = new Map(), calls = [], streams = [];
  const credentials = {
    async readRecord(key) { calls.push(['read',key]); return structuredClone(records.get(key)); },
    async modifyRecord(key, mutate) {
      const p = (tails.get(key) || Promise.resolve()).then(async () => { const n = await mutate(structuredClone(records.get(key))); if(n !== undefined) records.set(key,structuredClone(n)); return structuredClone(records.get(key)); });
      tails.set(key, p.catch(()=>{})); return p;
    },
    async deleteRecord(key) { records.delete(key); },
  };
  let sequence = 0;
  const driver = async ({credentials: store}) => {
    let number = ++sequence;
    return {
      async login(interaction) { if(overrides.login) return overrides.login(store,interaction,number); await store.modify('openai-codex',()=>({type:'oauth',access:token(`account-${number}`),refresh:`REFRESH_${number}`,expires:NOW+3600000,accountId:`account-${number}`})); },
      async auth(signal) { signal?.throwIfAborted(); if(overrides.auth) return overrides.auth(store,signal); return {apiKey:(await store.read('openai-codex')).access}; },
      async listModels() { return [{id:'codex-mini',name:'Codex mini'}]; },
      async prepare(model) { if(overrides.prepare) await overrides.prepare(); return {model:{provider:'openai-codex',id:model,name:'Codex mini'}, stream: options => (async function*(){ const grant=await store.read('openai-codex'); streams.push({account:grant.accountId, options}); if(overrides.stream) yield* overrides.stream(options, grant); else {yield{type:'text-delta',text:'OK'};yield{type:'usage',usage:{inputTokens:4,outputTokens:1}};yield{type:'finish',reason:{kind:'stop'}};} })()}; },
    };
  };
  const quotaCalls=[];
  const service=createAccountService({directory,credentials,driver,clock:()=>NOW,fetchImpl:async(url, init)=>{quotaCalls.push({url,init});if(overrides.fetch) return overrides.fetch(url,init); const accountId=init.headers['ChatGPT-Account-Id'];return new Response(JSON.stringify(rawQuota({account_id:accountId})),{headers:{'Content-Type':'application/json'}});}});
  t.after(async()=>{await service.dispose();await fs.rm(dir,{recursive:true,force:true});});
  const add=async label=>{const a=await service.beginLogin(label);for(let i=0;i<1000;i++){const c=await service.catalogue();if(c.login?.status==='completed')return c.accounts.find(r=>r.label===label);if(['failed','cancelled'].includes(c.login?.status))throw Error('mock login failed: '+c.login?.errorCode);await new Promise(r=>setTimeout(r,2));}throw Error('mock login timeout');};
  return{dir,directory,records,credentials,calls,streams,quotaCalls,service,add};
}
async function invoke(handler, method='GET', body, headers={'content-type':'application/json'}) {
  const req=Readable.from(body===undefined?[]:[Buffer.from(typeof body==='string'?body:JSON.stringify(body))]);req.method=method;req.headers=headers;
  const result={};const res={writeHead(status,h){result.status=status;result.headers=h;},end(v){result.body=v;}};
  await handler(req,res);if(result.body)result.data=JSON.parse(result.body);return result;
}
const authorized=()=>true;

test('official OAuth directory stores only opaque metadata; independent grant namespace',async t=>{
  const f=await fixture(t);const a=await f.add('Work'),b=await f.add('Personal');
  assert.notEqual(a.accountKey,b.accountKey);assert.equal(a.accountKey.length,16);assert.equal(f.records.size,2);
  const text=await fs.readFile(f.directory.file,'utf8');for(const secret of ['ACCESS_','REFRESH_','account-1','account-2','llm-pi-ai'])assert(!text.includes(secret));
  assert([...f.records.keys()].every(k=>/^codex-accounts\/account-[a-f0-9]{16}$/.test(k)));
  assert.equal((await f.service.catalogue()).defaultKey,a.accountKey);assert.equal(f.streams.length,0);assert.equal(f.quotaCalls.length,0);
});
test('fixed view rejects Platform API keys, foreign providers and undefined-delete confusion',async t=>{
  const f=await fixture(t),a=await f.add('A'),data=await f.directory.read();const view=fixedCredentialView(f.credentials,f.directory,data.rows[0]);
  await assert.rejects(view.read('openai'),/PROVIDER_REJECTED/);await assert.rejects(view.modify('openai-codex',()=>({type:'api_key',key:'PRIVATE'})),/OAUTH_REQUIRED/);
  const before=await view.read('openai-codex');await view.modify('openai-codex',()=>undefined);assert.deepEqual(await view.read('openai-codex'),before);assert.equal((await view.list())[0].type,'oauth');
  await f.service.remove(a.accountKey);await assert.rejects(view.read('openai-codex'),/ACCOUNT_REVOKED/);
});
test('per-account refresh mutation serializes without crossing accounts',async t=>{
  const f=await fixture(t);await f.add('A');await f.add('B');const d=await f.directory.read();
  const a=fixedCredentialView(f.credentials,f.directory,d.rows[0]),b=fixedCredentialView(f.credentials,f.directory,d.rows[1]);
  await Promise.all(Array.from({length:12},()=>a.modify('openai-codex',async g=>({...g,expires:g.expires+1}))));
  assert.equal((await a.read('openai-codex')).expires,NOW+3600012);assert.equal((await b.read('openai-codex')).expires,NOW+3600000);
});
test('new-request default captured before async preparation; changing default cannot redirect in-flight A',async t=>{
  const gate=deferred();let hold=false;const f=await fixture(t,{prepare:()=>hold?gate.promise:undefined});const a=await f.add('A'),b=await f.add('B');
  await f.service.catalogue();const adapter=createBoundAdapter(f.service);hold=true;
  const iterator=adapter.stream({provider:'codex-accounts',model:'default:codex-mini',tools:[],messages:[]});
  const c=await f.service.catalogue();await f.service.select(b.accountKey,c.generation);gate.resolve();for await(const _ of iterator){}
  assert.equal(f.streams[0].account,'account-1');
  for await(const _ of adapter.stream({provider:'codex-accounts',model:'default:codex-mini'})){}
  assert.equal(f.streams[1].account,'account-2');assert.equal((await f.service.catalogue()).defaultKey,b.accountKey);assert.notEqual(a.accountKey,b.accountKey);
});
test('default selection rejects stale generation including A to B to A',async t=>{
  const f=await fixture(t),a=await f.add('A'),b=await f.add('B');const c=await f.service.catalogue();await f.service.select(b.accountKey,c.generation);
  await f.service.select(a.accountKey,(await f.service.catalogue()).generation);await assert.rejects(f.service.select(b.accountKey,c.generation),/SOURCE_CHANGED/);
});
test('revoked bound request never falls back to new default',async t=>{
  const f=await fixture(t),a=await f.add('A');await f.add('B');const model=(await f.service.bindings()).accounts[0].models[0];const p=await f.service.prepare(a.accountKey,model.modelKey);
  await f.service.remove(a.accountKey);await assert.rejects(async()=>{for await(const _ of p.stream({})){};});assert.equal(f.streams.length,0);
});
test('quota GET has correct OAuth account headers, no redirects or inference; no false freshness',async t=>{
  const f=await fixture(t),a=await f.add('A'),q=await f.service.quota(a.accountKey,AbortSignal.timeout(1000));
  assert.equal(q.status,'reported');assert.equal(q.fiveHour.remainingPercent,80);assert.equal(q.serverSampledAt,null);assert.equal(q.identityBinding,'server-echo');assert.equal(q.clientObservedAt,NOW);
  assert.equal(f.quotaCalls[0].url,'https://chatgpt.com/backend-api/wham/usage');assert.equal(f.quotaCalls[0].init.method,'GET');assert.equal(f.quotaCalls[0].init.redirect,'error');assert.equal(f.quotaCalls[0].init.headers['ChatGPT-Account-Id'],'account-1');assert.equal(f.streams.length,0);
});
for(const [name,mutate,check] of [
  ['missing server identity',r=>{delete r.account_id;return r;},q=>assert.equal(q.identityBinding,'fixed-store-no-server-echo')],
  ['ordinary usage denied',r=>({...r,ordinary_usage_allowed:false}),q=>assert.equal(q.ordinaryUsageAllowed,false)],
  ['ambiguous duration',r=>{r.rate_limit.secondary_window={...r.rate_limit.primary_window};return r;},q=>assert.equal(q.fiveHour,null)],
  ['rounded non-five-hour',r=>{r.rate_limit.primary_window.limit_window_seconds=17999;return r;},q=>assert.equal(q.fiveHour,null)],
  ['out-of-range percent',r=>{r.rate_limit.primary_window.used_percent=101;return r;},q=>assert.equal(q.fiveHour,null)],
  ['expired deadline',r=>{r.rate_limit.primary_window.reset_at=Math.floor(NOW/1000)-1;return r;},q=>assert.equal(q.status,'stale')],
])test(`quota schema: ${name}`,()=>check(parseQuota(mutate(rawQuota()),'account-1',NOW)));
test('quota wrong account echo rejected; parse does not confuse by-limit buckets with accounts',()=>{
  assert.throws(()=>parseQuota(rawQuota(),'someone-else',NOW),/QUOTA_IDENTITY_MISMATCH/);assert.throws(()=>parseQuota([],'account-1',NOW));
  assert.equal(parseQuota({account_id:'account-1',additional_rate_limits:[{limit_name:'model-bucket',rate_limit:rawQuota().rate_limit}]},'account-1',NOW).status,'unavailable');
});
test('quota failed refresh cannot turn an old observation into fresh success',async t=>{
  let broken=false;const f=await fixture(t,{fetch:()=>{if(broken)throw Error('PRIVATE_TOKEN');return new Response(JSON.stringify(rawQuota()));}}),a=await f.add('A');
  const one=await f.service.quota(a.accountKey,AbortSignal.timeout(1000));broken=true;const two=await f.service.quota(a.accountKey,AbortSignal.timeout(1000));
  assert.equal(two.status,'stale');assert.equal(two.clientObservedAt,one.clientObservedAt);assert(!JSON.stringify(two).includes('PRIVATE_TOKEN'));
});
test('warmup single bound request only after ordinary quota permission, no model text saved',async t=>{
  const f=await fixture(t),a=await f.add('A'),model=(await f.service.bindings()).accounts[0].models[0];
  const r=await f.service.warmup(a.accountKey,model.modelKey,AbortSignal.timeout(1000));assert.equal(r.status,'completed');assert.equal(f.streams.length,1);assert.equal(f.streams[0].account,'account-1');
  assert.deepEqual(f.streams[0].options.tools,[]);assert.equal(f.streams[0].options.messages[0].content[0].text,'Reply only OK.');assert(!JSON.stringify(r).includes('OK'));assert.equal(r.usage.outputTokens,1);
});
for(const rate of [{allowed:false},{allowed:true,limit_reached:true},{allowed:true,primary_window:{used_percent:100,reset_at:Math.floor(NOW/1000)+600,limit_window_seconds:18000}}])test(`warmup refuses prohibited/exhausted quota ${JSON.stringify(rate)}`,async t=>{
  const f=await fixture(t,{fetch:()=>new Response(JSON.stringify({account_id:'account-1',rate_limit:rate}))}),a=await f.add('A'),m=(await f.service.bindings()).accounts[0].models[0];
  await assert.rejects(f.service.warmup(a.accountKey,m.modelKey,AbortSignal.timeout(1000)),e=>e.requestNotSent===true);assert.equal(f.streams.length,0);
});
test('post-stream failure is unknown, never retry or false unsent',async t=>{
  const f=await fixture(t,{stream:async function*(){yield{type:'text-delta',text:'OK'};throw Error('ACCESS_SECRET');}}),a=await f.add('A'),m=(await f.service.bindings()).accounts[0].models[0];
  await assert.rejects(f.service.warmup(a.accountKey,m.modelKey,AbortSignal.timeout(1000)),e=>e.requestNotSent===false&&!String(e).includes('SECRET'));assert.equal(f.streams.length,1);
});
test('auth-first, method/content/size/action validation and no private error disclosure',async t=>{
  const f=await fixture(t);await f.add('A');let access=0;const service=new Proxy(f.service,{get(o,k){if(k==='catalogue')return()=>{access++;return o[k]();};return o[k];}});
  const denied=accountServiceHandler(service,(_q,r)=>{r.writeHead(403,{});r.end('{}');return false;});assert.equal((await invoke(denied)).status,403);assert.equal(access,0);
  const handler=accountServiceHandler(service,authorized);assert.equal((await invoke(handler,'GET')).headers['Cache-Control'],'no-store');assert.equal((await invoke(handler,'HEAD')).body,undefined);
  for(const [method,body,headers,status] of [['PUT',{},undefined,405],['POST',{}, {},415],['POST','{',undefined,400],['POST',{action:'warmup.run',accountKey:'x',modelKey:'x',extra:'PRIVATE'},undefined,400],['POST','x'.repeat(8193),undefined,413]])assert.equal((await invoke(handler,method,body,headers)).status,status);
});
test('login cancel invalidates late OAuth writes and never adopts global slot',async t=>{
  const gate=deferred();const f=await fixture(t,{login:async(store)=>{await gate.promise;await store.modify('openai-codex',()=>({type:'oauth',access:'PRIVATE',refresh:'PRIVATE',expires:NOW+1000,accountId:'bad'}));}});
  const l=await f.service.beginLogin('cancel');await f.service.cancelLogin(l.id);gate.resolve();await new Promise(r=>setTimeout(r,20));
  assert.equal((await f.service.catalogue()).accounts.length,0);assert.equal(f.records.size,0);assert(f.calls.every(c=>!c[1].startsWith('llm-pi-ai/')));
});
test('public official driver requires subscription provider and empty ambient fallback; mock-only API contract',async()=>{
  let configured, login, prepared;
  class Adapter{constructor(o){configured=o;}listModels(){return [];}prepareCall(p,m){prepared=[p,m];return {};}}
  const credentials={};const driver=await createOfficialDriver({credentials},async()=>({createModels:auth=>({setProvider(){},login(...args){login=args;},getAuth(){return {apiKey:'mock'};}}),openaiCodexProvider:()=>({id:'openai-codex',auth:{oauth:{isSubscription:true}}}),PiAiAdapter:Adapter}));
  await driver.login({});await driver.prepare('mini');assert.equal(login[0],'openai-codex');assert.equal(login[1],'oauth');assert.deepEqual(prepared,['openai-codex','mini']);assert.equal(configured.auth.credentials,credentials);assert.equal(await configured.auth.authContext.env('OPENAI_API_KEY'),undefined);assert.equal(await configured.auth.authContext.fileExists('~/.codex/auth.json'),false);assert.equal(configured.profiles().get('openai-codex').retryPolicy.maxRetries,0);
  await assert.rejects(createOfficialDriver({credentials},async()=>({createModels(){},openaiCodexProvider:()=>({id:'openai',auth:{}}),PiAiAdapter:Adapter})),/SUBSCRIPTION_DRIVER_REQUIRED/);
});
test('desktop bridge integrates official quota/bindings/warmup without third-party RPC envelope',async t=>{
  const f=await fixture(t);await f.add('A');const handler=accountServiceHandler(f.service,authorized), requests=[];
  const bridge={async fetch(req){requests.push({url:req.url,method:req.method});const result=await invoke(handler,req.method,req.method==='POST'?await req.text():undefined);return new Response(result.body,{status:result.status,headers:result.headers});}};
  let identity;const q=await readOfficialQuota(bridge,AbortSignal.timeout(1000),x=>{identity=x;});assert.equal(q.provider,'codex-accounts');assert.equal(q.status,'reported');assert.equal(q.observedAt,null);assert.equal(identity.accountKey,q.accountKey);
  const b=await discoverOfficialAccounts({bridge,signal:AbortSignal.timeout(1000)});let usage;const r=await runOfficialWarmup({bridge,accountKey:b.accounts[0].accountKey,modelKey:b.accounts[0].models[0].modelKey,signal:AbortSignal.timeout(1000),onUsage:u=>{usage=u;}});
  assert.equal(r.status,'completed');assert.equal(usage.outputTokens,1);assert(requests.every(x=>x.url.endsWith('/api/dsh-plugin-codex-accounts')));assert.equal(f.streams.length,1);
});
test('desktop official proxy cannot send warmup or arbitrary RPC; no automatic fallback',async()=>{
  let count=0;const proxy=officialAccountsProxy({bridge:()=>({fetch(){count++;throw Error('PRIVATE');}}),authorize:authorized});
  assert.equal((await invoke(proxy,'POST',{action:'warmup.run'})).status,400);assert.equal(count,0);assert.equal((await invoke(proxy,'GET')).status,503);assert.equal(count,1);
});
test('persistent daily budget rejects cross-backend replay even under distinct account keys',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'DshOfficialBudget-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new MultiWarmupStore(path.join(dir,'multi.json'));const now=new Date(2026,9,16,9,30).getTime(),day='2026-10-16',a={accountKey:'a'.repeat(16),modelKey:'b'.repeat(64),enabled:true,allowUnverifiedQuota:true},b={...a,accountKey:'c'.repeat(16)};
  let r=await store.read();r=await store.configure({enabled:true,time:'09:30',accounts:[a,b]},r.revision);assert(await store.claim(a,day,now,r.data.config,'legacy'));await store.finish(a,day,'succeeded',now);
  assert.equal(await store.claim(b,day,now,r.data.config,'official'),false);assert(await store.claim(b,day,now,r.data.config,'legacy'));
});
test('bound OAuth refresh cannot change stored identity or contradict its JWT account',async t=>{
  const f=await fixture(t);await f.add('A');const row=(await f.directory.read()).rows[0],view=fixedCredentialView(f.credentials,f.directory,row),before=await view.read('openai-codex');
  await assert.rejects(view.modify('openai-codex',g=>({...g,access:token('OTHER'),accountId:'OTHER'})),/OAUTH_IDENTITY_CHANGED/);
  await assert.rejects(view.modify('openai-codex',g=>({...g,access:token('OTHER')})),/OAUTH_IDENTITY_CHANGED/);
  assert.deepEqual(await view.read('openai-codex'),before);
});
test('revoke is durable before a slow credential deletion and blocks first new capture',async t=>{
  const f=await fixture(t),a=await f.add('A'),model=(await f.service.bindings()).accounts[0].models[0],entered=deferred(),gate=deferred(),remove=f.credentials.deleteRecord;
  f.credentials.deleteRecord=async key=>{entered.resolve();await gate.promise;return remove(key);};const task=f.service.remove(a.accountKey);
  try{await entered.promise;await assert.rejects(f.service.prepare(a.accountKey,model.modelKey),/ACCOUNT_NOT_BOUND/);assert.equal(f.streams.length,0);}finally{gate.resolve();await task;}
});
test('dispose while initial directory write waits cannot start official login later',async t=>{
  let started=0;const f=await fixture(t,{login:async()=>{started++;}}),gate=deferred(),entered=deferred(),update=f.directory.update.bind(f.directory);let first=true;
  f.directory.update=fn=>{if(first){first=false;entered.resolve();return gate.promise.then(()=>update(fn));}return update(fn);};
  const task=f.service.beginLogin('late');await entered.promise;await f.service.dispose();gate.resolve();await assert.rejects(task,/SERVICE_CLOSED/);assert.equal(started,0);assert((await f.directory.read()).rows.every(r=>r.revoked));
});
test('same subscription rebind preserves public account and model keys and cannot reset daily budget',async t=>{
  const f=await fixture(t,{login:store=>store.modify('openai-codex',()=>({type:'oauth',access:token('SAME'),refresh:'MOCK_REFRESH',expires:NOW+3600000,accountId:'SAME'}))}),a=await f.add('first'),before=(await f.service.bindings()).accounts[0];
  const store=new MultiWarmupStore(path.join(f.dir,'daily.json')),d=new Date(NOW),day=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const grant={accountKey:a.accountKey,modelKey:before.models[0].modelKey,enabled:true,allowUnverifiedQuota:true};let saved=await store.read();saved=await store.configure({enabled:true,time:'09:30',accounts:[grant]},saved.revision);assert(await store.claim(grant,day,NOW,saved.data.config,'official'));await store.finish(grant,day,'succeeded',NOW);
  await f.service.remove(a.accountKey);const b=await f.add('rebound'),after=(await f.service.bindings()).accounts[0];assert.equal(b.accountKey,a.accountKey);assert.equal(after.models[0].modelKey,grant.modelKey);assert.equal(await store.claim(grant,day,NOW,saved.data.config,'official'),false);
});
test('public usage and finish chunks preserve billing; unsolicited tool blocks are unconfirmed',async t=>{
  const f=await fixture(t,{stream:async function*(){yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'text-delta',text:'OK'};yield{type:'usage',usage:{inputTokens:7,outputTokens:2,totalTokens:9,private:'NEVER'}};yield{type:'finish',reason:{kind:'stop'}};}}),a=await f.add('A'),m=(await f.service.bindings()).accounts[0].models[0];
  await assert.rejects(f.service.warmup(a.accountKey,m.modelKey,AbortSignal.timeout(1000)),e=>e.requestNotSent===false&&e.usage.inputTokens===7&&e.usage.totalTokens===9&&!('private'in e.usage));
  assert.equal(createBoundAdapter(f.service).imageRequestPricing('codex-accounts','default:codex-mini'),undefined);
});
test('metadata alone cannot grant a valid binding or two-account panel capability',async t=>{
 const f=await fixture(t),a=await f.add('A');await f.add('B');const row=(await f.directory.read()).rows[0];f.records.delete(`codex-accounts/account-${row.key}`);
 const list=await f.service.catalogue();assert.equal(list.accounts.find(r=>r.accountKey===a.accountKey).bound,false);assert.equal(list.accounts.filter(r=>r.bound).length,1);assert.equal((await f.service.bindings()).accounts.length,1);await assert.rejects(f.service.select(a.accountKey,list.generation),/OAUTH_REQUIRED/);
});
test('Windows transient metadata replace contention retries only the same local rename',async t=>{
 if(process.platform!=='win32')return;const f=await fixture(t),original=fs.rename;let attempts=0;
 fs.rename=async(...args)=>{if(args[1]===f.directory.file&&attempts++<7)throw Object.assign(Error('synthetic sharing violation'),{code:'EPERM'});return original(...args);};
 try{await f.directory.update(()=>{});assert.equal(attempts,8);assert.equal((await f.directory.read()).version,1);assert.equal(f.streams.length,0);assert.equal(f.quotaCalls.length,0);}finally{fs.rename=original;}
});
test('persistent Windows replace failure stays bounded, private and cannot send account work',async t=>{
 if(process.platform!=='win32')return;const f=await fixture(t),original=fs.rename;let attempts=0;
 fs.rename=async(...args)=>{if(args[1]===f.directory.file){attempts++;throw Object.assign(Error('PRIVATE_PATH must not escape'),{code:'EPERM'});}return original(...args);};
 try{await assert.rejects(f.directory.update(()=>{}),e=>e.code==='DIRECTORY_WRITE_UNAVAILABLE'&&!e.message.includes('PRIVATE_PATH'));assert.equal(attempts,10);assert.equal(f.streams.length,0);assert.equal(f.quotaCalls.length,0);assert(! (await fs.readdir(path.dirname(f.directory.file))).some(name=>name.endsWith('.tmp')||name.endsWith('.lock')));}finally{fs.rename=original;}
});
test('official quota rejects source ABA or lost binding without publishing an identity',async()=>{
 const key='a'.repeat(16);for(const lost of [false,true]){let reads=0,identities=0;const bridge={fetch:async req=>{if(req.method==='GET'){reads++;return Response.json({generation:lost?1:(reads===1?1:3),defaultKey:key,accounts:[{accountKey:key,epoch:1,bound:!(lost&&reads>1)}]});}return Response.json({status:'reported',fiveHour:{remainingPercent:80}});}};const result=await readOfficialQuota(bridge,AbortSignal.timeout(1000),()=>identities++);assert.equal(result.status,'switching');assert.equal(identities,0);}
});
test('post-response source revocation still settles known fixed-account usage once then fails closed',async()=>{
 const key='a'.repeat(16),model='b'.repeat(64);let current=true,calls=0,settled=0;const bridge={fetch:async()=>{calls++;current=false;return Response.json({status:'completed',accountKey:key,modelKey:model,usage:{inputTokens:3},modelName:'Codex mini'});}};
 await assert.rejects(runOfficialWarmup({bridge,accountKey:key,modelKey:model,signal:AbortSignal.timeout(1000),isCurrent:()=>current,onUsage:usage=>{settled++;assert.equal(usage.inputTokens,3);}}),/unconfirmed/);assert.equal(calls,1);assert.equal(settled,1);
});
test('directory corrupt/future schema fails closed without overwriting original bytes',async t=>{
  const f=await fixture(t);await fs.mkdir(path.dirname(f.directory.file),{recursive:true});await fs.writeFile(f.directory.file,'{broken');await assert.rejects(f.directory.read(),/DIRECTORY_UNAVAILABLE/);assert.equal(await fs.readFile(f.directory.file,'utf8'),'{broken');
});
