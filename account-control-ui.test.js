import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSimplePetClient, installPanelDependency } from './client-source.js';
import { DEFAULT_PREFERENCES, preferenceValues } from './preferences.js';
import { accountSwitchCapability, warmupAfterAccountSwitch } from './index.js';
const settle = () => new Promise(r => setImmediate(r));
function harness(send, services = {}) {
 const cells=[],cleanups=[];let i=0,tree;
 const React={createElement(type,props,...children){return {type,props:props??{},children:children.flat().filter(x=>x!==false&&x!=null)};},
 useState(v){const n=i++;if(!(n in cells))cells[n]=v;return[cells[n],v=>{cells[n]=typeof v==='function'?v(cells[n]):v;}];},
 useRef(v){return cells[i++]??={current:v};},useEffect(fn){const n=i++;if(!(n in cells)){cells[n]=true;cleanups.push(fn());}}};
 const client=createSimplePetClient(React,send,services),render=()=>{i=0;return tree=client.SimplePetSettings();};
 const nodes=(n=tree)=>n&&typeof n==='object'?[n,...n.children.flatMap(nodes)]:[];
 const text=(n=tree)=>n&&typeof n==='object'?n.children.map(text).join(''):String(n??'');
 render();return {render,nodes,text,cleanup(){cleanups.splice(0).forEach(fn=>fn?.());}};
}
test('old management remains strictly typed but never authorizes unified controls or warm-up',()=>{
 assert.equal(DEFAULT_PREFERENCES.multiAccountManagement,false);
 for(const key of ['multiAccountManagement','codexUnifiedControls','codexUnifiedWarmup']) {
  assert.equal(DEFAULT_PREFERENCES[key],false);
  for(const value of ['true',1,{},[],null]) assert.equal(preferenceValues({[key]:value})[key],false,key);
 }
 const legacy=preferenceValues({multiAccountManagement:true,codexAccountBackend:'official',codexWarmupStartup:true,codexWarmupReset:true,codexWarmupDaily:true});
 assert.equal(legacy.multiAccountManagement,true);assert.equal(legacy.codexUnifiedControls,false);assert.equal(legacy.codexUnifiedWarmup,false);
});
test('settings exposes only an explicit unified-owner collaboration draft, never legacy install or actual switch UI',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const calls=[];let installs=0,values={...DEFAULT_PREFERENCES,billingMode:'codex',multiAccountManagement:true,codexAccountBackend:'official'},revision='a'.repeat(64);
 const ui=harness(async(url,init={})=>{
  calls.push({url,...init});
  assert(!['accounts','multi-warmup','official-accounts'].some(path=>url.endsWith('/'+path)),'retired routes must not be used');
  if(url.endsWith('/preferences')){if(init.method==='PUT'){const body=JSON.parse(init.body);assert.equal(body.revision,revision);values={...values,...body.patch};revision='b'.repeat(64);}return Response.json({values:{...values},revision});}
  assert(!init.method||init.method==='GET');return Response.json({status:'unavailable'});
 },{pluginManager:{listBundles(){installs++;assert.fail('settings must not inspect or install old dependency');}}});
 const field=name=>{const node=ui.nodes().find(n=>n.props.name===name);assert(node,name);return node;};
 try {
  await settle();ui.render();assert.equal(calls.length,4);
  assert.deepEqual(ui.nodes().filter(n=>n.props['data-pet-tab']).map(n=>n.props['data-pet-tab']),['appearance','stats']);
  assert(!ui.nodes().some(n=>['data-account-list','data-account-target','data-account-prepare','data-account-confirm','data-panel-install'].some(k=>n.props[k])));
  for(const name of ['multiAccountManagement','codexAccountBackend'])assert(!ui.nodes().some(n=>n.props.name===name));
  assert.equal(field('codexUnifiedControls').props.checked,false);assert.equal(field('codexUnifiedWarmup').props.checked,false);
  field('codexUnifiedControls').props.onChange({target:{checked:true}});ui.render();t.mock.timers.tick(1000);await settle();assert.equal(calls.length,4);
  field('quietMode').props.onChange({target:{checked:true}});ui.render();t.mock.timers.tick(449);await settle();assert.equal(calls.filter(c=>c.method==='PUT').length,0);
  t.mock.timers.tick(1);await settle();ui.render();assert.deepEqual(JSON.parse(calls.find(c=>c.method==='PUT').body).patch,{quietMode:true});
  assert.equal(field('codexUnifiedControls').props.checked,true);assert.equal(values.codexUnifiedControls,false);
  ui.nodes().find(n=>n.props['data-settings-save']).props.onClick();await settle();ui.render();
  const writes=calls.filter(c=>c.method==='PUT');assert.equal(writes.length,2);assert.deepEqual(JSON.parse(writes[1].body).patch,{codexUnifiedControls:true});
  assert.equal(values.codexUnifiedWarmup,false);assert.equal(installs,0);
  assert.match(ui.text(),/登录、增删账号和模型选择仍只在订阅管理/);assert.match(ui.text(),/旧版授权不会自动沿用/);
  assert.match(ui.text(),/不会重发或更改进行中的聊天/);assert(!calls.some(c=>/select|activate|switch|install/.test(c.url)));
 }finally{ui.cleanup();}
});
const accepted={status:'accepted',kind:'registry',name:'dsh-plugin-subscriptions',version:'0.9.9',bundle:true};
function managerFixture(){const calls=[];let installed=false;const manager={
 async listBundles(){calls.push('list');return installed?[{name:'dsh-plugin-subscriptions',version:'0.9.9',enabled:true,installed:true}]:[];},
 async inspect(...args){calls.push(['inspect',...args]);return accepted;},
 async installBundle(...args){calls.push(['install',...args]);installed=true;return {application:'applied',changed:true};}};return {calls,manager};}
test('explicit install uses public exact spec, no build approvals and confirms enabled install',async()=>{
 const {calls,manager}=managerFixture();assert.match(await installPanelDependency(manager),/已安装并启用/);
 assert.deepEqual(calls.find(x=>Array.isArray(x)&&x[0]==='install'),['install','dsh-plugin-subscriptions@0.9.9',{enabled:true,approvedBuilds:[]}]);
});
for(const version of ['0.8.0','0.9.9','99.0.0'])test(`existing dependency ${version} is not changed`,async()=>{
 let mutations=0;const manager={listBundles:async()=>[{name:'dsh-plugin-subscriptions',version,enabled:false}],inspect:async()=>{throw Error('not allowed');},installBundle:async()=>mutations++};
 assert.match(await installPanelDependency(manager),/不会重复安装/);assert.equal(mutations,0);
});
test('install rejects refused, mismatched, non registry and unknown bundle metadata',async()=>{
 for(const evidence of [{status:'refused'}, {...accepted,version:'9'}, {...accepted,name:'other'}, {...accepted,kind:'git'}, {...accepted,bundle:false}]){
 const {manager,calls}=managerFixture();manager.inspect=async()=>evidence;assert.match(await installPanelDependency(manager),/检查未通过/);assert(!calls.some(x=>Array.isArray(x)&&x[0]==='install'));}
});
test('concurrent discovery, unmount and missing SDK never install',async()=>{
 assert.match(await installPanelDependency(null),/不支持应用内安装/);
 for(const mode of ['race','unmount']){const {manager,calls}=managerFixture();let n=0,alive=true;
 manager.listBundles=async()=> ++n===2&&mode==='race'?[{name:'dsh-plugin-subscriptions'}]:[];
 manager.inspect=async()=>{if(mode==='unmount')alive=false;return accepted;};
 await installPanelDependency(manager,()=>alive);assert(!calls.some(x=>Array.isArray(x)&&x[0]==='install'));}
});
for(const application of ['restart-required','failed','cancelled','overridden'])test(`installation ${application} is not falsely successful`,async()=>{
 const {manager}=managerFixture();manager.installBundle=async()=>({application});const text=await installPanelDependency(manager);assert(!/已安装并启用/.test(text));
});
test('pending scripts and raw failures are not approved, replayed or exposed',async()=>{
 const {manager,calls}=managerFixture();manager.installBundle=async()=>({application:'applied',pendingBuilds:['private']});assert.match(await installPanelDependency(manager),/未自动批准/);
 manager.listBundles=async()=>{throw Error('PRIVATE_TOKEN');};assert(!String(await installPanelDependency(manager)).includes('PRIVATE_TOKEN'));
});
test('unknown mutation latch cannot be discharged by later successful reads',()=>{
 assert.equal(warmupAfterAccountSwitch(false,{attempted:false,confirmed:false}),false);
 assert.equal(warmupAfterAccountSwitch(false,{attempted:true,confirmed:true}),false);
 for(const evidence of [undefined,{attempted:false,confirmed:false},{attempted:true,confirmed:true}])assert.equal(warmupAfterAccountSwitch(true,evidence),true);
});
test('public manifest capability accepts only exact reviewed dependency versions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'DshPanelManifest-'));const plugin=join(root,'pet');await mkdir(plugin);
 try{for(const [provider,name,version] of [['openai-codex','dsh-codex-subscription','2.6.8'],['codex','dsh-plugin-subscriptions','0.9.9']]){
 const dir=join(root,name);await mkdir(dir);assert.equal(accountSwitchCapability(provider,plugin),false);await writeFile(join(dir,'package.json'),JSON.stringify({name,version}));assert.equal(accountSwitchCapability(provider,plugin),true);
 await writeFile(join(dir,'package.json'),JSON.stringify({name,version:'999'}));assert.equal(accountSwitchCapability(provider,plugin),false);}}
 finally{assert(root.startsWith(join(tmpdir(),'DshPanelManifest-')));await rm(root,{recursive:true,force:true});}
});
