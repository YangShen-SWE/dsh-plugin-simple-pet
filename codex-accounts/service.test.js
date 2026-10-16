import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccountDirectory, createAccountService, fixedCredentialView } from './service.js';
import { createOfficialDriver } from './official-driver.js';
import { parseQuota } from './quota.js';

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
