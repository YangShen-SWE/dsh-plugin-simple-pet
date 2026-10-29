import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WarmupErrorLog } from './warmup-error-log.js';
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-diagnostic-')); t.after(() => fs.rmSync(dir, {recursive:true,force:true})); return path.join(dir,'errors.json'); }
test('failed warmup is persisted once, survives restart, and exposes safe settings history only', t => {
 const file=fixture(t), log=new WarmupErrorLog(file,{clock:()=>1800000000000});
 const failure={status:'failed',alertId:'warmup:1800000000000:1',detail:'SECRET',rawError:'TOKEN',model:'PRIVATE',accountId:'PRIVATE'};
 log.record(failure); log.record(failure);
 assert.equal(log.view().length,1); assert.match(log.view()[0].detail,/不会自动重试/);
 assert.doesNotMatch(fs.readFileSync(file,'utf8'),/SECRET|TOKEN|PRIVATE/);
 const next=new WarmupErrorLog(file);next.record(failure);assert.equal(next.view().length,1);
 assert.deepEqual(Object.keys(next.view()[0]),['at','detail']);
});
test('bounded diagnostics ignore nonfailures, invalid IDs and raw journal fields', t=>{
 const file=fixture(t),log=new WarmupErrorLog(file,{clock:()=>1800000000000});
 log.record({status:'succeeded',alertId:'test'});log.record({status:'failed',alertId:'bad\nSECRET'});assert.equal(fs.existsSync(file),false);
 for(let i=0;i<30;i++)log.record({status:'failed',alertId:`warmup:${i}`});
 assert.equal(log.view().length,20);assert.equal(new WarmupErrorLog(file).view().length,20);
 log.record({status:'failed',alertId:'legacy-journal-unavailable'});assert.match(log.view().at(-1).detail,/不要删除/);
});
test('unavailable diagnostic storage never throws or modifies scheduling claims', t=>{
 const file=fixture(t),claim=path.join(path.dirname(file),'warmup.json');fs.writeFileSync(claim,'DO-NOT-CHANGE');let warnings=0;
 const log=new WarmupErrorLog(path.join(file,'missing.json'),{warn:()=>warnings++});
 assert.doesNotThrow(()=>log.record({status:'failed',alertId:'warmup:1'}));assert.equal(warnings,1);
 assert.equal(fs.readFileSync(claim,'utf8'),'DO-NOT-CHANGE');assert.equal(log.view().length,1);
});
test('malformed persisted history is safe and diagnostics never trust persisted summary strings', t=>{
 const file=fixture(t);fs.writeFileSync(file,JSON.stringify([{id:'a',at:1800000000000,kind:'unknown',detail:'SECRET'},{id:'b',at:1,kind:'__proto__'}]));
 const log=new WarmupErrorLog(file);assert.equal(log.view().length,1);assert.doesNotMatch(JSON.stringify(log.view()),/SECRET/);
 fs.writeFileSync(file,'not json');assert.doesNotThrow(()=>new WarmupErrorLog(file));
});
test('desktop has no modal warmup failure path and both settings surfaces show the diagnostic history',()=>{
 const read=name=>fs.readFileSync(new URL(name,import.meta.url),'utf8');
 assert.doesNotMatch(read('./pet.ps1'),/MessageBox.*Show|自动预热已停止/);
 assert.match(read('./client-source.js'),/data-warmup-error-log/);assert.match(read('./client-source.js'),/snapshot\.codexWarmup\.errorLog\.map/);
 assert.match(read('./usage-view.ps1'),/LastSnapshot\.codexWarmup\.errorLog/);
 assert.match(read('./settings-window.ps1'),/CodexWarmupErrorLog/);
 assert.match(read('./index.js'),/errorLog: warmupErrorLog\.view\(\)/);
});
