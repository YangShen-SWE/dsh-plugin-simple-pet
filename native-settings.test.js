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

test('real plugin registers authenticated native-settings and bundled sprite routes without upstream calls', async () => {
  const old = process.env.LOCALAPPDATA, oldProfile = process.env.DSH_PET_PROFILE;
  const dir = path.join(root, `test-native-settings-${randomUUID()}`);
  const data = path.join(dir, 'DshSimpleDesktopPet');
  process.env.LOCALAPPDATA = dir; process.env.DSH_PET_PROFILE = 'desktop';
  await fs.mkdir(data, { recursive:true });
  const settings = path.join(data,'settings.json');
  await fs.writeFile(settings, JSON.stringify({ skin:'night',size:'small',left:12,top:23,custom:'preserve',codexWarmupDaily:false,codexWarmupReset:false,codexWarmupStartup:false }));
  const handlers = new Map(), effects = [];
  let rejection, missingConnection = false, modelCalls = 0, launched = 0;
  const services = {
    webServer: { register({ path: route, handler }) { handlers.set(route,handler); return () => handlers.delete(route); } },
    connection: { requestRejection() { if (missingConnection) throw new Error('host failure'); return rejection; } },
    effect(fn) { effects.push(fn()); },
  };
  const ctx = { ...services, inject(_names, fn) { fn(services); }, on() {}, settings: { describe() { return []; } },
    get() {}, llm: { listConfigurableProviders() { return []; }, stream() { modelCalls++; throw new Error('real model is forbidden'); } } };
  try {
    apply(ctx, { petLauncher() { launched++; return () => {}; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(launched,1); assert.equal(handlers.size,14);
    const route = '/api/dsh-plugin-simple-pet/preferences', handler = handlers.get(route);
    let result = await call(handler,route); assert.equal(result.code,200);
    const read = JSON.parse(result.data); assert.equal(read.values.skin,'night'); assert.equal(read.values.size,'small');
    assert.equal('left' in read.values,false); assert.equal('custom' in read.values,false);
    result = await call(handler,route,'PUT',{ patch:{size:'tiny',codexQuotaRefreshSeconds:12},revision:read.revision });
    assert.equal(result.code,200); const saved = JSON.parse(await fs.readFile(settings,'utf8'));
    assert.equal(saved.size,'tiny'); assert.equal(saved.codexQuotaRefreshSeconds,12); assert.equal(saved.left,12); assert.equal(saved.top,23); assert.equal(saved.custom,'preserve');
    assert.equal(saved.codexWarmupDaily,false); assert.equal(saved.codexWarmupReset,false); assert.equal(saved.codexWarmupStartup,false);
    const before = await fs.readFile(settings);
    for (const code of [401,403,null,999]) {
      rejection = code;
      assert.equal((await call(handler,route,'PUT',{patch:{skin:'star'},revision:JSON.parse(result.data).revision})).code,[401,403].includes(code) ? code : 403);
      assert.deepEqual(await fs.readFile(settings),before);
    }
    rejection = undefined; missingConnection = true;
    assert.equal((await call(handler,route)).code,403); missingConnection = false;
    const connection = services.connection; delete services.connection;
    assert.equal((await call(handler,route)).code,403); services.connection = connection;
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
