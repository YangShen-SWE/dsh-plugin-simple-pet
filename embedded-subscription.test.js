import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createEmbeddedSubscription } from './embedded-subscription.js';
import { createSubscriptionSettings } from './embedded-subscription-settings.js';

const schema = raw => {
  if (Object.keys(raw).some(key => !['speedMode','autoQuotaRetry'].includes(key)) || (raw.speedMode !== undefined && !['standard','fast'].includes(raw.speedMode)) || (raw.autoQuotaRetry !== undefined && typeof raw.autoQuotaRetry !== 'boolean')) throw new Error('INVALID');
  return {speedMode:'standard',autoQuotaRetry:false,...raw};
};
async function fixture(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(),'pet-subscription-')); t.after(() => fs.rm(dir,{recursive:true,force:true})); return path.join(dir,'preferences.json'); }

test('independent settings load does not write and updates preserve explicit preferences',async t=>{
 const file=await fixture(t);const store=await createSubscriptionSettings({file,schema});
 assert.deepEqual(store.get(),schema({}));await assert.rejects(fs.stat(file),{code:'ENOENT'});
 let notices=0;const off=store.watch(()=>notices++);await store.update({speedMode:'fast'});
 assert.equal(store.get().autoQuotaRetry,false);assert.equal(notices,1);off();
 const reopened=await createSubscriptionSettings({file,schema});assert.equal(reopened.get().speedMode,'fast');
 await assert.rejects(store.update({autoQuotaRetry:'yes'}),{code:'SUBSCRIPTION_SETTINGS_INVALID'});
 assert.equal(store.get().autoQuotaRetry,false);store.dispose();assert.throws(()=>store.get(),{code:'SUBSCRIPTION_SETTINGS_CLOSED'});
});
test('actual-host-shaped volatile schema cells persist JSON values and notify previous state',async t=>{
 const file=await fixture(t);
 const volatileSchema=raw=>Object.fromEntries(Object.entries(schema(raw)).map(([key,value])=>[key,{get:()=>value}]));
 const store=await createSubscriptionSettings({file,schema:volatileSchema});let notification;
 store.watch((next,previous)=>{notification={next,previous};});
 await store.update({speedMode:'fast'});
 assert.deepEqual(notification,{next:{speedMode:'fast',autoQuotaRetry:false},previous:{speedMode:'standard',autoQuotaRetry:false}});
 const json=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(json.values.speedMode,'fast');
 const reopened=await createSubscriptionSettings({file,schema:volatileSchema});assert.equal(reopened.get().speedMode,'fast');
 store.dispose();reopened.dispose();
});
test('parallel updates serialize and stale writers never overwrite saved settings',async t=>{
 const file=await fixture(t);const a=await createSubscriptionSettings({file,schema}),b=await createSubscriptionSettings({file,schema});
 await Promise.all([a.update({speedMode:'fast'}),a.update({autoQuotaRetry:true})]);
 assert.equal(JSON.parse(await fs.readFile(file,'utf8')).revision,2);
 await assert.rejects(b.update({speedMode:'standard'}),{code:'SUBSCRIPTION_SETTINGS_CHANGED'});
 assert.deepEqual(a.get(),{speedMode:'fast',autoQuotaRetry:true});
});
test('invalid or oversized settings and occupied lock fail closed',async t=>{
 const file=await fixture(t);await fs.writeFile(file,'x'.repeat(256*1024+1));
 await assert.rejects(createSubscriptionSettings({file,schema}),{code:'SUBSCRIPTION_SETTINGS_INVALID'});
 await fs.unlink(file);const store=await createSubscriptionSettings({file,schema});await fs.writeFile(file+'.lock','');
 await assert.rejects(store.update({speedMode:'fast'}),{code:'SUBSCRIPTION_SETTINGS_BUSY'});
 await assert.rejects(fs.stat(file),{code:'ENOENT'});
});
test('external provider owner prevents even importing or executing embedded backend',async()=>{
 let loads=0;const owners=[];const plugin=createEmbeddedSubscription({load:()=>{loads++;throw Error('should not load')},onOwner:x=>owners.push(x)});
 await plugin.apply({llm:{listProviders:()=>[{id:'openai-codex'}]}});
 assert.equal(loads,0);assert.deepEqual(owners,['external']);
});
test('embedded backend gets isolated schema store and publicly configured seed; no parent settings write',async t=>{
 const file=await fixture(t),effects=[],owners=[];let settings;
 const ctx={llm:{listProviders:()=>[]},loader:{entries:()=>[{options:{id:'codex-subscription',config:{speedMode:'fast'}}}]},effect:f=>effects.push(f())};
 const plugin=createEmbeddedSubscription({settingsFile:file,onOwner:x=>owners.push(x),load:async()=>({apply:async(_ctx,_config,factory)=>{settings=await factory(schema);assert.equal(settings.get().speedMode,'fast');await settings.update({speedMode:'standard'});}})});
 assert.equal(await plugin.apply(ctx),undefined);assert.deepEqual(owners,['embedded']);assert.equal(settings.get().autoQuotaRetry,false);
 effects.forEach(fn=>fn());assert.throws(()=>settings.get(),{code:'SUBSCRIPTION_SETTINGS_CLOSED'});
});
test('provider arriving during import is not overwritten',async()=>{
 let called=false,loaded=false;const plugin=createEmbeddedSubscription({load:async()=>{loaded=true;return{apply(){called=true}}}});
 await plugin.apply({effect:()=>{},llm:{listProviders:()=>loaded?[{id:'openai-codex'}]:[]}});assert.equal(called,false);
});
test('external provider arriving during settings IO aborts before upstream side effects',async t=>{
 const file=await fixture(t),owners=[];let external=false,effects=0,adapter;
 const ctx={llm:{listProviders:()=>external?[{id:'openai-codex'}]:[]},loader:{entries:()=>[]},effect:f=>f()};
 const plugin=createEmbeddedSubscription({settingsFile:file,onOwner:x=>owners.push(x),load:async()=>({apply:async(_ctx,_config,factory)=>{
  adapter=await factory(schema);external=true;adapter.assertEmbeddedOwner();effects++;
 }})});
 assert.equal(await plugin.apply(ctx),undefined);assert.deepEqual(owners,['external']);assert.equal(effects,0);
 assert.equal(adapter.writable,false);assert.throws(()=>adapter.get(),{code:'SUBSCRIPTION_SETTINGS_CLOSED'});
});
for(const phase of ['startup','import','settings'])test(`legacy owner conflict at ${phase} never reports the dual engines unified`,async t=>{
 const file=await fixture(t),owners=[];let legacy=phase==='startup',loads=0,sideEffects=0,adapter;
 const ctx={logger:{warn(){}},llm:{listProviders:()=>legacy?[{id:'codex-accounts'}]:[]},loader:{entries:()=>[]},effect:f=>f()};
 const plugin=createEmbeddedSubscription({settingsFile:file,onOwner:x=>owners.push(x),load:async()=>{loads++;if(phase==='import')legacy=true;return{apply:async(_ctx,_config,factory)=>{adapter=await factory(schema);legacy=true;adapter.assertEmbeddedOwner();sideEffects++;}};}});
 assert.equal(await plugin.apply(ctx),undefined);assert.deepEqual(owners,['failed']);assert.equal(sideEffects,0);if(phase==='startup')assert.equal(loads,0);if(adapter)assert.equal(adapter.writable,false);
});
test('compiled frontend registers only Desktop Pet owner and contains the complete child factory',async()=>{
 const code=await fs.readFile(new URL('./lib/client.js',import.meta.url),'utf8');const ids=[];
 vm.runInNewContext(code,{window:{__ModuleLoader__:{load:module=>ids.push(module.id)}}});
 assert.deepEqual(ids,['dsh-plugin-simple-pet']);
 assert.match(code,/createEmbeddedSubscriptionClient\(require\)/);assert.match(code,/ctx\.plugin\(\{ name: 'simple-pet-subscription-client'/);
 for(const contribution of ['codex-subscription-image-viewer','codex-subscription-quota','codex-image-output','codex_image_generate']) assert.ok(code.includes(contribution));
});
