import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AccountDirectory,createAccountService,hash} from './codex-accounts/service.js';
import {accountServiceFetchHandler} from './codex-accounts/index.js';
import {officialAccountsProxy} from './official-accounts.js';
import {EventEmitter} from 'node:events';

const token=id=>`header.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:id}})).toString('base64url')}.MOCK`;
async function fixture(t,{unknown=false,authBarrier}={}) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pet-reset-integration-'));let now=1800000000000;
 const directory=new AccountDirectory(path.join(dir,'accounts.json')),records=new Map(),calls=[];
 const rows=['A','B'].map((label,i)=>({key:String(i+1).repeat(16),epoch:1,label,bound:true,revoked:false,identityHash:hash('ACCOUNT_'+label)}));
 for(const row of rows)records.set('codex-accounts/account-'+row.key,{kind:'grant',payload:{type:'oauth',access:token('ACCOUNT_'+row.label),refresh:'FAKE_REFRESH',expires:now+3600000,accountId:'ACCOUNT_'+row.label}});
 await directory.update(d=>{d.rows=rows;d.defaultKey=rows[0].key;});
 const credentials={readRecord:async key=>structuredClone(records.get(key)),modifyRecord:async(key,fn)=>{const value=await fn(records.get(key));records.set(key,value);return value;},deleteRecord:async key=>records.delete(key)};
 const driver=async({credentials:store})=>({auth:async()=>{await authBarrier?.();return {apiKey:(await store.read('openai-codex')).access};},listModels:async()=>[],catalogStatus:()=>({status:'not-refreshed'}),login:async()=>{throw Error('LOGIN_FORBIDDEN');}});
 const fetchImpl=async(url,init)=>{calls.push({url,...init});if(init.method==='GET')return Response.json({available_count:1,credits:[{id:'CARD',status:'available'}]});if(unknown)throw Error('PRIVATE_TRANSPORT');return Response.json({code:'reset',windows_reset:['opaque']});};
 const make=()=>createAccountService({directory,credentials,driver,clock:()=>now,fetchImpl});
 const service=make();t.after(async()=>{await service.dispose();await fs.rm(dir,{recursive:true,force:true});});
 return {dir,directory,rows,records,calls,service,make,advance:()=>{now+=5001;},keys:rows.map(r=>r.identityHash.slice(0,16))};
}
for(const unknown of [false,true])test('fixed service/Fetch reset chain and durable no-replay '+unknown,async t=>{
 const f=await fixture(t,{unknown}),handler=accountServiceFetchHandler(f.service,()=>true);
 const send=async body=>{const r=await handler(new Request('http://localhost/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));return {status:r.status,body:await r.json()};};
 const view=await send({action:'reset.inspect',accountKey:f.keys[0]});assert.equal(view.status,200);assert.equal(f.calls.length,1);
 const prep=await send({action:'reset.prepare',accountKey:f.keys[0],creditRef:view.body.credits[0].ref});assert.equal(prep.status,200);assert.equal(f.calls.length,2);
 f.advance();
 const rejected=await send({action:'reset.consume',accountKey:f.keys[1],challengeId:prep.body.challengeId,acknowledged:true});assert.notEqual(rejected.status,200);assert.equal(f.calls.length,2);
 const result=await send({action:'reset.consume',accountKey:f.keys[0],challengeId:prep.body.challengeId,acknowledged:true});assert.equal(result.status,unknown?503:200);
 assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert(f.calls.every(c=>c.headers['chatgpt-account-id']==='ACCOUNT_A'));
 assert(!JSON.stringify(result.body).includes('PRIVATE_TRANSPORT'));
 await f.service.dispose();const again=f.make();t.after(()=>again.dispose());
 const second=await again.resetInspect(f.keys[0]);assert.equal(second.credits[0].paused,true);
 await assert.rejects(again.resetPrepare(f.keys[0],second.credits[0].ref),e=>e.code==='RESET_CLAIM_PAUSED');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 const stored=await fs.readFile(path.join(f.dir,'reset-credit-claims.json'),'utf8');assert(!stored.includes('ACCOUNT_A'));assert(!stored.includes(token('ACCOUNT_A')));
});
test('unconsumed references and confirmations cannot cross same-account epoch-one rebind',async t=>{
 const f=await fixture(t),view=await f.service.resetInspect(f.keys[0]),challenge=await f.service.resetPrepare(f.keys[0],view.credits[0].ref);
 const saved=structuredClone(f.records.get('codex-accounts/account-'+f.rows[0].key));f.advance();await f.service.remove(f.keys[0]);
 const rebound={...f.rows[0],key:'c'.repeat(16),epoch:1};f.records.set('codex-accounts/account-'+rebound.key,saved);await f.directory.update(d=>{d.rows.push(rebound);});
 await assert.rejects(f.service.resetPrepare(f.keys[0],view.credits[0].ref),e=>e.code==='RESET_CARD_INVALID');
 await assert.rejects(f.service.resetConsume(f.keys[0],challenge.challengeId,true),e=>e.code==='RESET_CHALLENGE_INVALID');assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
for(const reason of ['source','disconnect','request'])test('proxy forwards '+reason+' cancellation before reset auth finishes',async t=>{
 let hold=false;const entered=Promise.withResolvers(),gate=Promise.withResolvers();const f=await fixture(t,{authBarrier:async()=>{if(hold){entered.resolve();await gate.promise;}}});
 const v=await f.service.resetInspect(f.keys[0]),c=await f.service.resetPrepare(f.keys[0],v.credits[0].ref);f.advance();
 const source=new AbortController(),request=new AbortController(),handler=accountServiceFetchHandler(f.service,()=>true),bridge={fetch:handler};
 const proxy=officialAccountsProxy({bridge:()=>bridge,authorize:()=>true,sourceSignal:()=>source.signal});
 const req=new EventEmitter();Object.assign(req,{method:'POST',headers:{'content-type':'application/json'},signal:request.signal});req[Symbol.asyncIterator]=async function*(){yield Buffer.from(JSON.stringify({action:'reset.consume',accountKey:f.keys[0],challengeId:c.challengeId,acknowledged:true}));};
 const res=new EventEmitter();Object.assign(res,{writeHead(status){this.status=status;},end(){this.writableEnded=true;}});
 hold=true;const pending=proxy(req,res);await entered.promise;
 if(reason==='source')source.abort();else if(reason==='disconnect')res.emit('close');else request.abort();gate.resolve();await pending;
 assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assert.equal(res.listenerCount('close'),0);assert.equal(req.listenerCount('aborted'),0);
});
test('remove after prepare invalidates fixed epoch without consuming card',async t=>{
 const f=await fixture(t),view=await f.service.resetInspect(f.keys[0]);const challenge=await f.service.resetPrepare(f.keys[0],view.credits[0].ref);f.advance();await f.service.remove(f.keys[0]);
 await assert.rejects(f.service.resetConsume(f.keys[0],challenge.challengeId,true));assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
