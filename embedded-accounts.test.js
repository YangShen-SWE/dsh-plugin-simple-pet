import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEmbeddedAccountsPlugin, embeddedAccountsPlugin } from './embedded-accounts.js';
import { inspectAccountModelCatalogue } from './codex-accounts/model-catalogue.js';

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
test('root owns an embedded public Cordis child; one package declares the official dependencies',async()=>{
 const pkg=JSON.parse(await fs.readFile(new URL('./package.json',import.meta.url),'utf8')),source=await fs.readFile(new URL('./index.js',import.meta.url),'utf8');
 assert.equal(pkg.version,'1.0.0');assert.equal(pkg.dependencies['@earendil-works/pi-ai'],'0.87.1');assert.equal(pkg.dependencies['@deepseek-ai/dsh-llm-pi-ai'],'0.2.0-rc.2');
 assert.deepEqual(embeddedAccountsPlugin.inject,['credentials','llm']);assert.match(source,/ctx\.plugin\(embeddedAccountsPlugin\)/);
});
test('only embedded entry activates account routes/provider; empty startup has no external calls',async t=>{
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
 for(const [extra,reason]of [[{context_window:undefined},'missing-context'],[{visibility:'hide'},'not-visible'],[{input_modalities:['audio']},'unsupported-input']]){
 const report=inspectAccountModelCatalogue({models:[row(extra)]},builtin);assert.equal(report.models.length,0);assert.deepEqual(report.omitted,[{id:'gpt-6.1-sol',reason}]);assert.equal(report.receivedCount,1);
 }
});
test('catalogue diagnostics are bounded and never expose raw metadata/private unsupported capability text',()=>{
 const report=inspectAccountModelCatalogue({models:Array.from({length:150},(_,i)=>row({slug:'safe-model-'+i,supported_reasoning_levels:[{effort:'PRIVATE_SECRET'}]}))},builtin);
 assert.equal(report.capabilityGaps.length,128);assert(!JSON.stringify(report).includes('PRIVATE_SECRET'));
 const invalid=inspectAccountModelCatalogue({models:[row({slug:'PRIVATE\nTOKEN'})]},builtin);assert.deepEqual(invalid.omitted,[]);
});
