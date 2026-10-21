import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { activateEmbeddedSubscriptionClient } from './embedded-subscription-client.js';

for (const owner of ['external','failed','closed','unknown']) test(`client never mounts complete RPC or slot contributions for owner ${owner}`,async()=>{
 let applies=0,reads=0;const cleanup=[];
 await activateEmbeddedSubscriptionClient({effect:f=>cleanup.push(f())},{apply(){applies++;}},{fetchOwner:async()=>{reads++;return Response.json({owner,version:'2.6.8'});}});
 assert.equal(applies,0);assert.equal(reads,1);cleanup.forEach(f=>f());
});
test('client waits for confirmed ownership and aborts activation after unload',async()=>{
 let applies=0,reads=0;const cleanup=[];
 await activateEmbeddedSubscriptionClient({effect:f=>cleanup.push(f())},{apply(){applies++;}},{fetchOwner:async()=>Response.json({owner:++reads===1?'loading':'embedded',version:'2.6.8'}),wait:async()=>{}});
 assert.equal(applies,1);assert.equal(reads,2);cleanup.forEach(f=>f());
 let release;const gate=new Promise(resolve=>{release=resolve;});const end=[];
 const pending=activateEmbeddedSubscriptionClient({effect:f=>end.push(f())},{apply(){applies++;}},{fetchOwner:()=>gate});
 end.forEach(f=>f());release(Response.json({owner:'embedded',version:'2.6.8'}));await pending;
 assert.equal(applies,1);
});
test('forked client uses embedded RPC preferences, not retired Loader namespace',async()=>{
 const code=await fs.readFile(new URL('./vendor/codex-subscription/lib/client.js',import.meta.url),'utf8');
 assert.doesNotMatch(code,/settingsScope.*bind\(\{ namespace: "codex-subscription"/);
 assert.match(code,/id: "simple-pet-subscription"/);assert.match(code,/订阅管理（桌宠内置）/);
});

test('the complete upstream factory materializes as an owned child, never a dormant second module',async()=>{
 const code=await fs.readFile(new URL('./lib/client.js',import.meta.url),'utf8');
 let module;const children=[],styles=[],sections=[];
 const React={createElement:()=>null,forwardRef:fn=>fn,memo:fn=>fn,createContext:()=>({}),Fragment:Symbol('Fragment')};
 const document={createElement:()=>({dataset:{},remove(){this.removed=true;}}),head:{appendChild:tag=>styles.push(tag)}};
 const sandbox={window:{__ModuleLoader__:{load:value=>{assert.equal(module,undefined);module=value;}}},document,URL,WeakMap,Map,Set,AbortController,AbortSignal,TextEncoder,TextDecoder,console};
 vm.runInNewContext(code,sandbox);
 const calls=[];
 const plugin=module.factory(id=>{calls.push(id);if(id==='react')return React;if(id==='react/jsx-runtime')return{};if(id==='react-dom')return{};if(id==='@deepseek-ai/dsh-client-ui-primitives')return{};throw Error('Unexpected dependency '+id);});
 const disposers=[];
 plugin.apply({effect:factory=>disposers.push(factory()),slots:{inject:(_name,factory)=>factory(),register:spec=>{sections.push(spec.id);return()=>{};}},inject:()=>{},plugin:child=>children.push(child)});
 assert.deepEqual(sections,['simple-desktop-pet']);assert.equal(children.length,1);
 assert.equal(children[0].name,'simple-pet-subscription-client');assert.equal(typeof children[0].apply,'function');
 assert.deepEqual(Array.from(children[0].inject),['slots','locale','connection','remote','modelDirectories','conversation','uiConversation','sessions']);
 assert.ok(calls.includes('react/jsx-runtime'));assert.ok(calls.includes('@deepseek-ai/dsh-client-ui-primitives'));
 for(const disposer of disposers)disposer?.();assert.equal(styles[0].removed,true);
});
