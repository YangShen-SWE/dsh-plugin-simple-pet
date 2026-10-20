import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfficialDriver } from './official-driver.js';

class LlmError extends Error {
 constructor(message,code,fields={}) { super(message);this.code=code;this.failure={code,message,...fields}; }
}
async function fixture() {
 let received, profile;
 const driver=await createOfficialDriver({credentials:{}},async()=>({
  LlmError, createModels:()=>({setProvider(){}}),
  openaiCodexProvider:()=>({id:'openai-codex',auth:{oauth:{isSubscription:true}},getModels:()=>[]}),
  PiAiAdapter:class { constructor(options){profile=options.profiles().get('openai-codex');} async prepareCall(){return {model:{id:'synthetic'},stream(options){received=options;return (async function*(){yield {type:'finish',reason:{kind:'stop'}};})();}};} },
 }));
 return {driver,get received(){return received;},get profile(){return profile;}};
}
test('subscription uses SSE with original ten-minute idle window and no automatic retry',async()=>{
 const f=await fixture();
 assert.equal(f.profile.transport,'sse');assert.equal(f.profile.streamIdleTimeoutMs,600000);assert.equal(f.profile.retryPolicy.maxRetries,0);
});
test('only branded valid offload controls are reconstructed without private facts',async()=>{
 const {driver}=await fixture();
 const raw=new LlmError('PRIVATE','IMAGE_OFFLOAD_REQUIRED',{offloadImages:14,cause:{secret:'PRIVATE'}}),result=driver.preflightFailure(raw);
 assert(result instanceof LlmError);assert.equal(result.code,'IMAGE_OFFLOAD_REQUIRED');assert.equal(result.failure.offloadImages,14);assert.equal(result.requestNotSent,true);assert(!JSON.stringify(result).includes('PRIVATE'));
 for(const n of [undefined,0,-1,1.5,'14',Infinity,Number.MAX_SAFE_INTEGER+1])assert.equal(driver.preflightFailure(new LlmError('PRIVATE','IMAGE_OFFLOAD_REQUIRED',{offloadImages:n})),undefined);
 assert.equal(driver.preflightFailure(Object.assign(Error('PRIVATE'),{code:'IMAGE_OFFLOAD_REQUIRED',failure:{offloadImages:14}})),undefined);
 assert.equal(driver.preflightFailure(new LlmError('PRIVATE','UNSUPPORTED_CONTENT',{offloadImages:14})),undefined);
});
test('generic defaults normalize without mutating input or erasing real unsupported options',async()=>{
 const f=await fixture(),prepared=await f.driver.prepare('synthetic');
 const input={temperature:0.7,stop:[],messages:[],tools:[],reasoningEffort:'low',sessionId:'synthetic'};
 for await(const _ of prepared.stream(input)){};
 assert.equal(f.received.temperature,undefined);assert.equal(f.received.stop,undefined);assert.equal(input.temperature,0.7);assert.deepEqual(input.stop,[]);assert.equal(f.received.messages,input.messages);assert.equal(f.received.reasoningEffort,'low');
 for await(const _ of prepared.stream({...input,stop:['STOP']})){};assert.deepEqual(f.received.stop,['STOP']);
});
