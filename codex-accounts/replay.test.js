import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { accountReplayMessages, accountReplayEvent } from './replay.js';

const key='a'.repeat(16), other='b'.repeat(16), model='gpt-test';
const native=()=>({response:{kind:'pi-ai',version:2,provider:'openai-codex',model,responseId:'synthetic',api:'openai-codex-responses',stopReason:'stop'},blocks:[{type:'text',textSignature:'opaque'}]});
const event=()=>({type:'finish',reason:{kind:'stop'},replayState:native()});
const history=(route,state)=>[{role:'assistant',source:{provider:'codex-accounts',model:route,replayState:state},content:[{type:'text',text:'OK'}]}];
for(const route of [`${key}:${model}`,`default:${model}`,`${key}:${createHash('sha256').update(`${key}:${model}`).digest('hex')}`])test(`account replay round trips ${route}`,()=>{
 const wrapped=accountReplayEvent(event(),key,model),input=history(route,wrapped.replayState),before=structuredClone(input);
 const output=accountReplayMessages(input,key,model);
 assert.deepEqual(output[0].source,{provider:'openai-codex',model,replayState:native()});assert.deepEqual(input,before);
 assert.deepEqual(output[0].content,input[0].content);assert.equal(wrapped.replayState.accountKey,key);
});
for(const mode of ['other-account','other-model','foreign-route','old-unwrapped','invalid-version','native-route-mismatch'])test(`account replay degrades ${mode} without losing content`,()=>{
 const state=accountReplayEvent(event(),key,model).replayState;
 let route=`${key}:${model}`,targetKey=key,targetModel=model;
 if(mode==='other-account')targetKey=other;if(mode==='other-model')targetModel='other';
 if(mode==='foreign-route')route=`${other}:${model}`;
 if(mode==='invalid-version')state.version=2;
 if(mode==='native-route-mismatch')state.state.response.model='other';
 const input=history(route,mode==='old-unwrapped'?native():state),before=structuredClone(input),output=accountReplayMessages(input,targetKey,targetModel);
 assert.equal(output[0].source.replayState,undefined);assert.deepEqual(output[0].content,input[0].content);assert.deepEqual(input,before);
});
test('legacy global Codex replay has no verifiable account and is neutralized',()=>{
 const input=history(model,native());input[0].source.provider='openai-codex';
 const result=accountReplayMessages(input,key,model);assert.equal(result[0].source.replayState,undefined);assert.deepEqual(result[0].content,input[0].content);
});
test('unrelated provider replay is not rewritten',()=>{
 const input=history(model,native());input[0].source.provider='unrelated';
 assert.equal(accountReplayMessages(input,key,model)[0],input[0]);
});
test('usage and errors pass without invented replay metadata',()=>{
 const usage={type:'usage',usage:{inputTokens:5}};assert.equal(accountReplayEvent(usage,key,model),usage);
 const unknown=event();unknown.replayState.response.version=99;assert.equal(accountReplayEvent(unknown,key,model).replayState,undefined);
});
