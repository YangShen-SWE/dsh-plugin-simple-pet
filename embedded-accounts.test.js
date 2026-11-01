import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEmbeddedAccountsPlugin, embeddedAccountsPlugin } from './embedded-accounts.js';
import { createEmbeddedSubscription, SUBSCRIPTION_SERVICES } from './embedded-subscription.js';
import { apply } from './index.js';
import { inspectAccountModelCatalogue, MODEL_CATALOGUE_PROFILE } from './codex-accounts/model-catalogue.js';

async function fixture(t) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'DshEmbeddedAccounts-'));
 const routes=new Map(),http=new Map(),adapters=new Map(),cleanups=[];let forbidden=0;
 const ctx={credentials:{readRecord(){forbidden++;throw Error('no grants');},modifyRecord(){forbidden++;throw Error('no login');},deleteRecord(){forbidden++;throw Error('no revoke');}},
 llm:{listProviders:()=>[...adapters.keys()].map(id=>({id})),registerAdapter(ids,adapter){for(const id of ids){assert(!adapters.has(id));adapters.set(id,adapter);}cleanups.push(()=>ids.forEach(id=>adapters.delete(id)));}},
 effect(fn){const cleanup=fn();if(typeof cleanup==='function')cleanups.push(cleanup);},
 inject(names,fn){fn({...this,webServer:{register(row){assert(!http.has(row.path));http.set(row.path,row);return()=>http.delete(row.path);}},connection:{requestRejection:()=>undefined,fetch:{register(row){assert(!routes.has(row.path));routes.set(row.path,row);cleanups.push(()=>routes.delete(row.path));}}}});}};
 const plugin=createEmbeddedAccountsPlugin({directoryFile:path.join(dir,'accounts.json'),driver:()=>{forbidden++;throw Error('no driver');}});
 t.after(async()=>{for(const fn of cleanups.reverse())await fn();assert.equal(forbidden,0);assert.equal(routes.size,0);assert.equal(http.size,0);assert.equal(adapters.size,0);assert(dir.startsWith(path.join(os.tmpdir(),'DshEmbeddedAccounts-')));await fs.rm(dir,{recursive:true,force:true});});
 return{ctx,plugin,routes,http,adapters};
}
async function rootFixture(t, { subscriptionFactory, withPlugin = true } = {}) {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'DshEmbeddedRoot-'));
 const oldRoot = process.env.LOCALAPPDATA, oldProfile = process.env.DSH_PET_PROFILE;
 process.env.LOCALAPPDATA = root; process.env.DSH_PET_PROFILE = 'desktop';
 const cleanups = [], children = [], routes = new Map(); let forbidden = 0;
 const unexpected = () => { forbidden++; throw new Error('no credentials, network, adapter registration or model requests in root fixture'); };
 t.mock.method(globalThis, 'fetch', unexpected);
 const services = { effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
  connection: { requestRejection: () => undefined },
  webServer: { register(row) { assert(!routes.has(row.path)); routes.set(row.path, row); return () => routes.delete(row.path); } } };
 const ctx = { ...services, on() {}, inject(_names, callback) { callback(services); }, get() { return null; },
  settings: { describe: () => [] }, credentials: { resolve: unexpected, readRecord: unexpected, modifyRecord: unexpected, deleteRecord: unexpected },
  llm: { listConfigurableProviders: () => [], listProviders: () => [], registerAdapter: unexpected, stream: unexpected } };
 if (withPlugin) ctx.plugin = child => { children.push(child); };
 t.after(async () => {
  try { for (const fn of cleanups.reverse()) await fn(); }
  finally {
   if (oldRoot === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = oldRoot;
   if (oldProfile === undefined) delete process.env.DSH_PET_PROFILE; else process.env.DSH_PET_PROFILE = oldProfile;
   assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('DshEmbeddedRoot-'));
   await fs.rm(root, { recursive: true, force: true });
  }
  assert.equal(forbidden, 0); assert.equal(routes.size, 0);
 });
 const options = { panelStarter: async () => ({ url: 'http://127.0.0.1:1/panel', token: 'a'.repeat(64), close() {} }), petLauncher: () => () => {} };
 if (subscriptionFactory !== undefined) options.subscriptionFactory = subscriptionFactory;
 assert.equal(apply(ctx, options), undefined);
 await new Promise(resolve => setImmediate(resolve));
 assert(!routes.has('/api/dsh-plugin-codex-accounts'), 'retired account routes never activate from the root');
 assert(children.every(child => child.name !== embeddedAccountsPlugin.name), 'retired account plugin is never mounted');
 return { children, routes };
}

test('root defaults to the embedded subscription Cordis child and never reactivates the retired engine; one package declares the official dependencies',async t=>{
 const pkg=JSON.parse(await fs.readFile(new URL('./package.json',import.meta.url),'utf8')),source=await fs.readFile(new URL('./index.js',import.meta.url),'utf8');
 assert.equal(pkg.version,'1.1.6');assert.equal(MODEL_CATALOGUE_PROFILE.userAgent,`${pkg.name}/${pkg.version}`);assert.equal(pkg.dependencies['@earendil-works/pi-ai'],'0.87.1');assert.equal(pkg.dependencies['@deepseek-ai/dsh-llm-pi-ai'],'0.2.0-rc.2');
 assert.deepEqual(embeddedAccountsPlugin.inject,['credentials','llm']);
 assert.match(source,/subscriptionFactory\s*=\s*createEmbeddedSubscription/);assert.match(source,/ctx\.plugin\(subscriptionFactory\(/);
 assert.doesNotMatch(source,/ctx\.plugin\(embeddedAccountsPlugin\)/);assert.doesNotMatch(source,/from ['"]\.\/embedded-accounts\.js['"]/);
 const f = await rootFixture(t), expected = createEmbeddedSubscription({ settingsFile: path.join(os.tmpdir(), 'unused-synthetic-subscription.json') });
 assert.equal(f.children.length, 1); assert.equal(f.children[0].name, expected.name); assert.equal(f.children[0].name, 'simple-pet-embedded-subscription');
 assert.deepEqual(f.children[0].inject, ['llm','credentials','settings','web','loader','tools','attachments']);
 assert.deepEqual(f.children[0].inject, SUBSCRIPTION_SERVICES); assert.equal(typeof f.children[0].apply, 'function');
});
test('root honors injected subscriptionFactory without loading a real subscription or starting retired account services', async t => {
 let calls = 0;
 const child = { name: 'synthetic-subscription', inject: [], apply() { assert.fail('child apply is owned by Cordis, never invoked by the test root'); } };
 const f = await rootFixture(t, { subscriptionFactory(options) {
  calls++; assert.deepEqual(Object.keys(options).sort(), ['onAdapter', 'onOwner', 'onWarmupService']);
   assert.equal(typeof options.onWarmupService, 'function');
  assert.equal(typeof options.onOwner, 'function'); assert.equal(typeof options.onAdapter, 'function');
  options.onOwner('external'); options.onAdapter(null); return child;
 } });
 assert.equal(calls, 1); assert.deepEqual(f.children, [child]);
});
test('mock-only contexts without plugin never construct or activate any account owner', async t => {
 const f = await rootFixture(t, { withPlugin: false, subscriptionFactory() { assert.fail('no plugin means no subscription factory or account engine'); } });
 assert.deepEqual(f.children, []);
});
test('explicit legacy entry alone activates its isolated account routes/provider; empty startup has no external calls',async t=>{
 const f=await fixture(t);assert.equal(await f.plugin.apply(f.ctx),undefined);assert.equal(f.adapters.size,1);assert.equal(f.http.size,1);assert.equal(f.routes.size,1);
 const response=await f.routes.get('/api/dsh-plugin-codex-accounts').fetch(new Request('http://localhost/api/dsh-plugin-codex-accounts'));
 assert.equal(response.status,200);assert.deepEqual((await response.json()).accounts,[]);assert.deepEqual(await f.adapters.get('codex-accounts').listModels(),[]);
});
test('an already registered standalone route is never replaced or duplicated',async()=>{
 let calls=0;const ctx={llm:{listProviders:()=>[{id:'codex-accounts'}]},get credentials(){calls++;throw Error('must not touch grants');}};
 assert.equal(await embeddedAccountsPlugin.apply(ctx),undefined);assert.equal(calls,0);
});
const builtin=[{id:'codex-mini',contextWindow:200000,maxTokens:8192,input:['text'],cost:{input:1},thinkingLevelMap:{low:'low'}}];
const row=extra=>({slug:'gpt-6.1-sol',visibility:'list',context_window:400000,input_modalities:['text','image'],supported_reasoning_levels:[{effort:'low'},{effort:'future-level'}],...extra});
test('unknown reasoning does not hide a returned sol model or enable an unknown effort',()=>{
 const report=inspectAccountModelCatalogue({models:[row()]},builtin);assert.equal(report.models[0].id,'gpt-6.1-sol');assert.equal(report.models[0].thinkingLevelMap.low,'low');assert.equal(report.models[0].thinkingLevelMap.off,null);assert(!Object.values(report.models[0].thinkingLevelMap).includes('future-level'));assert.equal(report.models[0].cost,undefined);assert.deepEqual(report.capabilityGaps,[{id:'gpt-6.1-sol',reason:'unknown-reasoning'}]);
});
test('missing/hidden/incompatible catalogue rows are explained, never invented or granted',()=>{
 for(const [extra,reason]of [[{context_window:0},'missing-context'],[{visibility:'hide'},'not-visible'],[{input_modalities:['audio']},'unsupported-input']]){
 const report=inspectAccountModelCatalogue({models:[row(extra)]},builtin);assert.equal(report.models.length,0);assert.deepEqual(report.omitted,[{id:'gpt-6.1-sol',reason}]);assert.equal(report.receivedCount,1);
 }
});
test('catalogue diagnostics are bounded and never expose raw metadata/private unsupported capability text',()=>{
 const report=inspectAccountModelCatalogue({models:Array.from({length:150},(_,i)=>row({slug:'safe-model-'+i,supported_reasoning_levels:[{effort:'PRIVATE_SECRET'}]}))},builtin);
 assert.equal(report.capabilityGaps.length,128);assert(!JSON.stringify(report).includes('PRIVATE_SECRET'));
 const invalid=inspectAccountModelCatalogue({models:[row({slug:'PRIVATE\nTOKEN'})]},builtin);assert.deepEqual(invalid.omitted,[]);
});
