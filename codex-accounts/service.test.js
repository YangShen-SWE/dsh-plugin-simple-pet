import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccountDirectory, createAccountService, fixedCredentialView } from './service.js';
import { createOfficialDriver } from './official-driver.js';
import { parseQuota } from './quota.js';
import { apply } from './index.js';

test('independent package uses official OAuth resolution rather than API-key credential',async()=>{
  const stores=[];
  class FakeAdapter { constructor(options){stores.push(options.auth.credentials);assert.equal(options.profiles().get('openai-codex').transport,'sse');assert.equal(options.profiles().get('openai-codex').retryPolicy.maxRetries,0);} }
  const createModels=({credentials})=>({setProvider(p){assert.equal(p.id,'openai-codex');assert.equal(p.auth.oauth.isSubscription,true);},async login(id,type,interaction){assert.equal(type,'oauth');interaction.signal.throwIfAborted();await credentials.modify(id,()=>({type:'oauth',access:'FAKE_ACCESS',refresh:'FAKE_REFRESH',expires:Date.now()+3600000,accountId:'ACCOUNT'}));},async getAuth(){return {source:'OAuth',auth:{apiKey:'FAKE_ACCESS'}};},getModels(){return [{id:'codex-mini',name:'Codex mini'}];}});
  let grant;const store={read:async()=>grant,modify:async(_,fn)=>{grant=await fn(grant);return grant;},list:async()=>[],delete:async()=>{grant=undefined;}};
  const driver=await createOfficialDriver({credentials:store},async()=>({createModels,PiAiAdapter:FakeAdapter,openaiCodexProvider:()=>({id:'openai-codex',auth:{oauth:{isSubscription:true}}})}));
  await driver.login({signal:AbortSignal.timeout(1000)});assert.equal((await driver.auth(AbortSignal.timeout(1000))).apiKey,'FAKE_ACCESS');assert.equal(stores[0],store);assert.equal(grant.type,'oauth');
});
test('API-key/ambient result cannot satisfy official OAuth driver',async()=>{
  const driver=await createOfficialDriver({credentials:{}},async()=>({createModels:()=>({setProvider(){},getAuth:async()=>({source:'environment',auth:{apiKey:'PRIVATE'}})}),PiAiAdapter:class{},openaiCodexProvider:()=>({id:'openai-codex',auth:{oauth:{isSubscription:true}}})}));
  await assert.rejects(driver.auth(AbortSignal.timeout(1000)),/SUBSCRIPTION_OAUTH_REQUIRED/);
});
test('independent metadata directory is atomic and never accepts corrupt schema',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'DshCodexPackage-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const directory=new AccountDirectory(path.join(dir,'accounts.json'));
  await directory.update(data=>{data.rows.push({key:'a'.repeat(16),epoch:1,label:'A',bound:false,revoked:false,identityHash:null,createdAt:Date.now()});});assert.equal((await directory.read()).rows.length,1);
  await fs.writeFile(directory.file,'{broken');await assert.rejects(directory.read(),/DIRECTORY_UNAVAILABLE/);assert.equal(await fs.readFile(directory.file,'utf8'),'{broken');
});
test('raw quota report remains source limited and cannot prove exact full/reset trigger',()=>{
  const now=Date.now(),q=parseQuota({account_id:'ACCOUNT',rate_limit:{allowed:true,primary_window:{used_percent:0,reset_at:Math.floor(now/1000)+3600,limit_window_seconds:18000}}},'ACCOUNT',now);
  assert.equal(q.fiveHour.remainingPercent,100);assert.equal(q.serverSampledAt,null);assert.equal(q.fullTriggerEligible,false);assert.equal(q.status,'reported');assert.equal(q.identityBinding,'server-echo');
});
test('service cannot start without official credential storage, no ambient fallback',()=>{
  assert.throws(()=>createAccountService({directory:{},credentials:{},driver(){}}),/CREDENTIALS_UNAVAILABLE/);
});
test('plugin apply resolves to a valid Cordis lifecycle effect, not its service object',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'DshCodexLifecycle-'));
  const cleanups=[],http=new Map(),fetchRoutes=new Map();let credentialsTouched=0;
  t.after(async()=>{for(const dispose of cleanups.reverse())await dispose();await fs.rm(dir,{recursive:true,force:true});});
  const ctx={
    credentials:{async readRecord(){credentialsTouched++;throw Error('No real grants');},async modifyRecord(){credentialsTouched++;throw Error('No OAuth');},async deleteRecord(){credentialsTouched++;}},
    llm:{registerAdapter(){}},
    effect(fn){const value=fn();if(typeof value==='function')cleanups.push(value);else if(value!=null)throw new TypeError('Invalid effect');},
    webServer:{register(route){http.set(route.path,route);return()=>http.delete(route.path);}},
    connection:{requestRejection(){return undefined;},fetch:{register(route){fetchRoutes.set(route.path,route);const dispose=()=>fetchRoutes.delete(route.path);cleanups.push(dispose);return dispose;}}},
    inject(_names,fn){const result=fn(this);if(result!=null&&typeof result!=='function')throw new TypeError('Invalid effect');},
  };
  const result=await apply(ctx,{directoryFile:path.join(dir,'accounts.json'),driver:async()=>{throw Error('No login or model work');}});
  // Matches the public Cordis safeCollect rule for async plugin setup.
  assert.equal(result,undefined,'A returned plain object makes the real host unload every route');
  assert.equal(http.size,1);assert.equal(fetchRoutes.size,1);
  const response=await fetchRoutes.get('/api/dsh-plugin-codex-accounts').fetch(new Request('http://localhost/api/dsh-plugin-codex-accounts',{method:'HEAD'}));
  assert.equal(response.status,200);assert.equal(credentialsTouched,0);
});
