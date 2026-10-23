import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { apply } from './index.js';

const root = path.join(import.meta.dirname, 'work');
function call(handler, url, method = 'GET', body) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  Object.assign(req, { url, method, headers: { 'content-type':'application/json' } });
  const result = {};
  const res = { writeHead(code, headers) { result.code = code; result.headers = headers; }, end(data) { result.data = data; } };
  return Promise.resolve(handler(req, res)).then(() => result);
}

test('real plugin registers authenticated owner/preferences/assets and retired routes without real subscription, panel, or upstream calls', async () => {
  const old = process.env.LOCALAPPDATA, oldProfile = process.env.DSH_PET_PROFILE;
  const dir = path.join(root, `test-native-settings-${randomUUID()}`);
  const data = path.join(dir, 'DshSimpleDesktopPet');
  process.env.LOCALAPPDATA = dir; process.env.DSH_PET_PROFILE = 'desktop';
  await fs.mkdir(data, { recursive:true });
  const settings = path.join(data,'settings.json');
  await fs.writeFile(settings, JSON.stringify({ skin:'night',size:'small',left:12,top:23,custom:'preserve',multiAccountManagement:true,codexAccountBackend:'official',codexWarmupDaily:false,codexWarmupReset:false,codexWarmupStartup:false }));
  const handlers = new Map(), effects = [];
  let rejection, missingConnection = false, modelCalls = 0, launched = 0, factoryCalls = 0, pluginCalls = 0, panels = 0;
  const syntheticPlugin = { name:'synthetic-subscription-owner' };
  const syntheticPanel = { url:'http://127.0.0.1:1/synthetic-panel',token:'a'.repeat(64),close() {} };
  const services = {
    webServer: { register({ path: route, handler }) { handlers.set(route,handler); return () => handlers.delete(route); } },
    connection: { requestRejection() { if (missingConnection) throw new Error('host failure'); return rejection; } },
    effect(fn) { effects.push(fn()); },
  };
  const ctx = { ...services, inject(_names, fn) { fn(services); }, on() {}, settings: { describe() { return []; } },
    plugin(plugin) { pluginCalls++;assert.equal(plugin,syntheticPlugin); },
    credentials: { resolve() { assert.fail('real credentials are forbidden'); } },
    get() {}, llm: { listConfigurableProviders() { return []; }, listModels() { assert.fail('no model discovery'); }, stream() { modelCalls++; throw new Error('real model is forbidden'); } } };
  try {
    apply(ctx, {
      subscriptionFactory({onOwner,onAdapter}) { factoryCalls++;onOwner('embedded');onAdapter({prepareCall(){assert.fail('no prepared calls');}});return syntheticPlugin; },
      panelStarter:async()=>{panels++;return syntheticPanel;},
      petLauncher({profile,panel}) { launched++;assert.equal(profile,'desktop');assert.equal(panel,process.platform==='win32'?syntheticPanel:null);return () => {}; },
    });
    for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(factoryCalls,1);assert.equal(pluginCalls,1);assert.equal(launched,1);assert.equal(panels,process.platform==='win32'?1:0);
    assert.equal(handlers.size,20);
    const route = '/api/dsh-plugin-simple-pet/preferences', handler = handlers.get(route);
    let result = await call(handler,route); assert.equal(result.code,200);
    const read = JSON.parse(result.data); assert.equal(read.values.skin,'night'); assert.equal(read.values.size,'small');
    assert.equal('left' in read.values,false); assert.equal('custom' in read.values,false);
    assert.equal(read.values.multiAccountManagement,true);assert.equal(read.values.codexUnifiedControls,false);assert.equal(read.values.codexUnifiedWarmup,false);
    result = await call(handler,route,'PUT',{ patch:{size:'tiny',codexQuotaRefreshSeconds:12},revision:read.revision });
    assert.equal(result.code,200); let current=JSON.parse(result.data); const saved = JSON.parse(await fs.readFile(settings,'utf8'));
    assert.equal(saved.size,'tiny'); assert.equal(saved.codexQuotaRefreshSeconds,12); assert.equal(saved.left,12); assert.equal(saved.top,23); assert.equal(saved.custom,'preserve');
    assert.equal(saved.multiAccountManagement,true);assert.equal(saved.codexAccountBackend,'official');
    assert.equal(saved.codexWarmupDaily,false); assert.equal(saved.codexWarmupReset,false); assert.equal(saved.codexWarmupStartup,false);
    assert.notEqual(saved.codexUnifiedControls,true);assert.notEqual(saved.codexUnifiedWarmup,true);
    const explicit={codexUnifiedControls:true,codexUnifiedWarmup:true,codexWarmupStartup:true,codexWarmupReset:true,codexWarmupDaily:true,codexWarmupTime:'13:14'};
    for(const [key,value] of Object.entries(explicit)){
      const previous=current;
      result=await call(handler,route,'PUT',{patch:{[key]:value},revision:previous.revision});assert.equal(result.code,200,key);current=JSON.parse(result.data);
      assert.equal(current.values[key],value,key);assert.notEqual(current.revision,previous.revision);
      for(const other of Object.keys(explicit).filter(other=>other!==key))assert.equal(current.values[other],previous.values[other],`${key} must not carry ${other}`);
      const disk=JSON.parse(await fs.readFile(settings,'utf8'));assert.equal(disk.left,12);assert.equal(disk.top,23);assert.equal(disk.custom,'preserve');
    }
    const before = await fs.readFile(settings);
    assert.equal((await call(handler,route,'PUT',{patch:{skin:'star',codexUnifiedWarmup:false},revision:read.revision})).code,409);
    assert.deepEqual(await fs.readFile(settings),before);
    for (const code of [401,403,null,999]) {
      rejection = code;
      assert.equal((await call(handler,route,'PUT',{patch:{skin:'star',codexUnifiedControls:false,codexUnifiedWarmup:false},revision:current.revision})).code,[401,403].includes(code) ? code : 403);
      assert.deepEqual(await fs.readFile(settings),before);
    }
    rejection = undefined; missingConnection = true;
    assert.equal((await call(handler,route)).code,403); missingConnection = false;
    const connection = services.connection; delete services.connection;
    assert.equal((await call(handler,route)).code,403); services.connection = connection;
    const owner='/api/dsh-plugin-simple-pet/subscription-owner';result=await call(handlers.get(owner),owner);assert.equal(result.code,200);
    assert.deepEqual(JSON.parse(result.data),{owner:'embedded',version:'2.6.8'});
    for(const leaf of ['accounts','multi-warmup','official-accounts']){
      const retired='/api/dsh-plugin-simple-pet/'+leaf;const retiredHandler=handlers.get(retired);assert(retiredHandler);
      rejection=401;assert.equal((await call(retiredHandler,retired,'POST',{action:'select',id:'synthetic'})).code,401);rejection=undefined;
      for(const method of ['GET','HEAD','POST','PUT','DELETE'])assert.equal((await call(retiredHandler,retired,method,{action:'discover'})).code,410,leaf+' '+method);
    }
    assert.deepEqual(await fs.readFile(settings),before);
    const asset = '/api/dsh-plugin-simple-pet/asset/default-valley.png';
    let image = await call(handlers.get(asset),asset); assert.equal(image.code,200); assert.equal(image.headers['Content-Type'],'image/png');
    assert.deepEqual(image.data,await fs.readFile(new URL('./assets/default-valley.png',import.meta.url)));
    assert.equal((await call(handlers.get(asset),asset,'HEAD')).data,undefined);
    assert.equal((await call(handlers.get(asset),asset,'PUT',{})).code,405);
    rejection = 401; assert.equal((await call(handlers.get(asset),asset)).code,401);
    assert.equal(handlers.has('/api/dsh-plugin-simple-pet/asset/../../settings.json'),false);
    assert.equal(modelCalls,0);
  } finally {
    for (const cleanup of effects.reverse()) await cleanup?.();
    assert.equal(handlers.size,0);
    if (old === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = old;
    if (oldProfile === undefined) delete process.env.DSH_PET_PROFILE; else process.env.DSH_PET_PROFILE = oldProfile;
    assert.equal(path.dirname(dir),root); assert.match(path.basename(dir),/^test-native-settings-[a-f0-9-]+$/);
    await fs.rm(dir,{recursive:true,force:true});
  }
});
