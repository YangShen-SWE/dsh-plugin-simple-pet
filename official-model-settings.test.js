import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { AccountDirectory, createAccountService, hash } from './codex-accounts/service.js';
import { createBoundAdapter } from './codex-accounts/official-driver.js';
import { accountServiceHandler, accountServiceFetchHandler, apply } from './codex-accounts/index.js';
import { officialAccountsProxy } from './official-accounts.js';

// Private Temp metadata plus in-memory FakeStore/FakeDriver only. Seed synthetic
// bound grants directly: even fake login/OAuth is unnecessary for these tests.
const NOW = 1800000000000;
const token = id => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: id } })).toString('base64url')}.MOCK_SIGNATURE`;
const model = (id = 'codex-mini') => ({ id, name: id, inputModalities: ['text', 'image'],
  context: { contextWindow: 400000 }, reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }] } });
const settings = (extra = {}) => ({ enabled: null, defaultModel: null, reasoningEffort: null, ...extra });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'DshOfficialModelSettings-'));
  const directory = new AccountDirectory(path.join(dir, 'accounts.json'));
  const records = new Map(), tails = new Map(), calls = [], engines = new Map(); let changed = 0;
  const rows = ['A', 'B'].map((label, i) => ({ key: String(i + 1).repeat(16), epoch: 1, label, bound: true,
    revoked: false, identityHash: hash(`MOCK_ACCOUNT_${label}`) }));
  const credentials = {
    async readRecord(key) { calls.push(['credential.read', key]); return structuredClone(records.get(key)); },
    async modifyRecord(key, mutate) {
      const task = (tails.get(key) ?? Promise.resolve()).then(async () => { const value = await mutate(structuredClone(records.get(key))); if (value !== undefined) records.set(key, structuredClone(value)); return structuredClone(records.get(key)); });
      tails.set(key, task.catch(() => {})); return task;
    }, async deleteRecord(key) { records.delete(key); },
  };
  for (const row of rows) records.set(`codex-accounts/account-${row.key}`, { kind: 'grant', payload: {
    type: 'oauth', access: token(`MOCK_ACCOUNT_${row.label}`), refresh: `MOCK_REFRESH_${row.label}`, expires: NOW + 3600000, accountId: `MOCK_ACCOUNT_${row.label}` } });
  await directory.update(data => { data.rows = rows; data.defaultKey = rows[options.defaultSecond ? 1 : 0].key; });
  const driver = async ({ credentials: store }) => {
    const grant = await store.read('openai-codex'), label = grant.accountId.endsWith('_A') ? 'A' : 'B';
    let models = [model(), model('codex-large')], revision = 0;
    const engine = {
      async login() { throw Error('OAUTH_FORBIDDEN'); },
      async auth() { calls.push(['auth', label]); throw Error('AUTH_FORBIDDEN'); },
      async listModels() { calls.push(['list', label]); return structuredClone(models); },
      catalogStatus: () => ({ source: revision ? 'account-catalog' : 'builtin', status: revision ? 'ready' : 'not-refreshed', revision }),
      async refreshModels(signal) { calls.push(['refresh', label, signal]); signal.throwIfAborted(); if (options.refresh) await options.refresh(label, signal); signal.throwIfAborted(); models = [...models, model('gpt-6.1-sol')]; revision++; },
      async prepare(id) { calls.push(['prepare', label, id]); return { model: model(id), stream: opts => (async function* () {
        calls.push(['stream', label, id, opts]); yield { type: 'finish', reason: { kind: 'stop' } };
      })() }; },
    };
    engines.set(label, engine); return engine;
  };
  let selection = options.initialSelection ?? { provider: 'deepseek-official', model: 'unrelated' };
  const host = options.noHost ? undefined : {
    currentSelection() { return options.readSelection ? options.readSelection(selection) : selection; },
    async saveSelection(value) { calls.push(['host.save', structuredClone(value)]); if (!options.ignoreSave) selection = structuredClone(value); },
  };
  const service = createAccountService({ directory, credentials, driver, clock: () => NOW,
    fetchImpl: options.fetchImpl ?? (async () => { calls.push(['network']); throw Error('NETWORK_FORBIDDEN'); }),
    hostModel: () => host, changed: () => { changed++; } });
  t.after(async () => { await service.dispose(); await fs.rm(dir, { recursive: true, force: true }); });
  const keys = rows.map(row => row.identityHash.slice(0, 16));
  return { dir, directory, records, rows, credentials, service, calls, engines, host, keys,
    get changed() { return changed; }, get selection() { return selection; } };
}
function assertNoAccountWork(f) {
  assert.deepEqual(f.calls.filter(c => ['auth', 'network', 'stream', 'refresh'].includes(c[0])), []);
}
async function invoke(service, body, options = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = options.method ?? 'POST'; req.headers = { 'content-type': 'application/json' }; req.signal = options.signal;
  const result = {}, res = { writeHead(status, headers) { result.status = status; result.headers = headers; }, end(value) { if (value) result.data = JSON.parse(value); } };
  await accountServiceHandler(service, options.authorize ?? (() => true))(req, res); return result;
}

test('models read, catalogue and bindings do not automatically fetch/authenticate/run a model', async t => {
  const f = await fixture(t); const a = await f.service.models(f.keys[0]);
  await f.service.catalogue(); await f.service.bindings();
  assert.equal(a.accountKey, f.keys[0]); assert.deepEqual(a.settings, settings());
  assert.equal(a.catalog.source, 'builtin'); assert.equal(a.models[0].contextWindow, 400000);
  assertNoAccountWork(f);
});
test('explicit refresh updates only captured account, never the other account', async t => {
  const f = await fixture(t); await f.service.models(f.keys[0], true);
  const a = await f.service.models(f.keys[0]), b = await f.service.models(f.keys[1]);
  assert(a.models.some(m => m.id === 'gpt-6.1-sol')); assert(!b.models.some(m => m.id === 'gpt-6.1-sol'));
  assert.deepEqual(f.calls.filter(c => c[0] === 'refresh').map(c => c[1]), ['A']);
  assert.equal(b.catalog.source, 'builtin'); assert.equal(f.calls.filter(c => c[0] === 'stream').length, 0);
});
test('refresh passes a cancellable signal and never sends a model request', async t => {
  const entered = deferred(), f = await fixture(t, { refresh: async (_label, signal) => {
    entered.resolve(); await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  } });
  const controller = new AbortController(), operation = f.service.models(f.keys[0], true, controller.signal);
  await entered.promise; controller.abort(); await assert.rejects(operation, /MODEL_CATALOG_UNAVAILABLE/);
  assert.equal(f.calls.find(c => c[0] === 'refresh')[2].aborted, true);
  assert.equal(f.calls.filter(c => c[0] === 'stream').length, 0);
});
test('refresh errors are public codes, never raw transport/credential text', async t => {
  const f = await fixture(t, { refresh: async () => { throw Error('PRIVATE_MOCK_ACCESS PRIVATE_MOCK_ACCOUNT'); } });
  const result = await invoke(f.service, { action: 'models.refresh', accountKey: f.keys[0] });
  assert.equal(result.status, 503); assert.equal(result.data.error, 'MODEL_CATALOG_UNAVAILABLE');
  assert(!JSON.stringify(result).includes('PRIVATE'));
});
test('account model settings are independent and metadata contains no grant data', async t => {
  const f = await fixture(t), a = await f.service.models(f.keys[0]);
  const saved = await f.service.configureModels(f.keys[0], a.generation, settings({ enabled: ['codex-large'], defaultModel: 'codex-large', reasoningEffort: 'high' }));
  assert.deepEqual(saved.settings, settings({ enabled: ['codex-large'], defaultModel: 'codex-large', reasoningEffort: 'high' }));
  assert.deepEqual((await f.service.models(f.keys[1])).settings, settings());
  assert.equal(saved.models.find(m => m.id === 'codex-mini').enabled, false);
  const text = await fs.readFile(f.directory.file, 'utf8');
  for (const value of ['MOCK_REFRESH_', 'MOCK_ACCOUNT_', 'MOCK_SIGNATURE', 'eyJhbGci']) assert(!text.includes(value));
  assertNoAccountWork(f);
});
test('CAS rejects stale model configuration without overwriting newer settings', async t => {
  const f = await fixture(t), before = await f.service.models(f.keys[0]);
  await f.service.configureModels(f.keys[0], before.generation, settings({ enabled: ['codex-mini'] }));
  await assert.rejects(f.service.configureModels(f.keys[0], before.generation, settings({ enabled: ['codex-large'] })), /SOURCE_CHANGED/);
  assert.deepEqual((await f.service.models(f.keys[0])).settings.enabled, ['codex-mini']);
});
test('CAS detects unrelated account selection and model-settings ABA changes', async t => {
  const f = await fixture(t), initial = await f.service.models(f.keys[0]);
  await f.service.select(f.keys[1], initial.generation);
  await f.service.select(f.keys[0], (await f.service.catalogue()).generation);
  await assert.rejects(f.service.configureModels(f.keys[0], initial.generation, settings()), /SOURCE_CHANGED/);
});
for (const [name, patch, code] of [
  ['unknown enabled model', { enabled: ['not-a-model'] }, 'MODEL_REVOKED'],
  ['disabled default', { enabled: ['codex-mini'], defaultModel: 'codex-large' }, 'MODEL_REVOKED'],
  ['unknown default', { defaultModel: 'not-a-model' }, 'MODEL_REVOKED'],
  ['unsupported reasoning effort', { defaultModel: 'codex-mini', reasoningEffort: 'max' }, 'REASONING_UNAVAILABLE'],
  ['reasoning without default', { reasoningEffort: 'high' }, 'REASONING_UNAVAILABLE'],
  ['duplicate enabled IDs', { enabled: ['codex-mini', 'codex-mini'] }, 'INVALID_MODEL_SETTINGS'],
  ['unsafe enabled ID', { enabled: ['../private'] }, 'INVALID_MODEL_SETTINGS'],
  ['unsafe default route', { defaultModel: 'other:codex-mini' }, 'INVALID_MODEL_SETTINGS'],
  ['unknown setting field', { permission: true }, 'INVALID_MODEL_SETTINGS'],
  ['noncanonical reasoning none', { reasoningEffort: 'none' }, 'INVALID_MODEL_SETTINGS'],
]) test(`configure rejects ${name} without committing`, async t => {
  const f = await fixture(t), before = await f.service.models(f.keys[0]);
  await assert.rejects(f.service.configureModels(f.keys[0], before.generation, settings(patch)), new RegExp(code));
  const after = await f.service.models(f.keys[0]); assert.equal(after.generation, before.generation); assert.deepEqual(after.settings, before.settings);
  assertNoAccountWork(f);
});
test('all models may be disabled without any automatic replacement/default/host write', async t => {
  const f = await fixture(t), before = await f.service.models(f.keys[0]);
  const result = await f.service.configureModels(f.keys[0], before.generation, settings({ enabled: [] }));
  assert(result.models.every(m => !m.enabled)); assert.equal(result.settings.defaultModel, null);
  assert.deepEqual((await f.service.bindings()).accounts.find(a => a.accountKey === f.keys[0]).models, []);
  assert.equal(f.calls.filter(c => c[0] === 'host.save').length, 0); assertNoAccountWork(f);
});
test('per-account default reasoning reaches only matching model, with explicit request override preserved', async t => {
  const f = await fixture(t), a = await f.service.models(f.keys[0]);
  await f.service.configureModels(f.keys[0], a.generation, settings({ defaultModel: 'codex-mini', reasoningEffort: 'high' }));
  const chosen = await f.service.prepareSlug(f.keys[0], 'codex-mini');
  for await (const _ of chosen.stream({})) {} for await (const _ of chosen.stream({ reasoningEffort: 'low' })) {}
  const other = await f.service.prepareSlug(f.keys[1], 'codex-mini'); for await (const _ of other.stream({})) {}
  const streams = f.calls.filter(c => c[0] === 'stream');
  assert.equal(streams[0][3].reasoningEffort, 'high'); assert.equal(streams[1][3].reasoningEffort, 'low');
  assert.equal(streams[2][3].reasoningEffort, undefined);
});
test('disabled models reject both readable slug and historical hash selection', async t => {
  const f = await fixture(t), a = await f.service.models(f.keys[0]);
  await f.service.configureModels(f.keys[0], a.generation, settings({ enabled: ['codex-large'] }));
  await assert.rejects(f.service.prepareSlug(f.keys[0], 'codex-mini'), /MODEL_REVOKED/);
  await assert.rejects(f.service.prepare(f.keys[0], hash(`${f.keys[0]}:codex-mini`)), /MODEL_REVOKED/);
  assert.equal(f.calls.filter(c => c[0] === 'prepare').length, 0);
});
test('host selection saves only codex-accounts readable bound route and verifies readback', async t => {
  const f = await fixture(t), a = await f.service.models(f.keys[0]);
  await f.service.configureModels(f.keys[0], a.generation, settings({ defaultModel: 'codex-mini', reasoningEffort: 'high' }));
  const result = await f.service.selectHostModel(f.keys[0], hash(`${f.keys[0]}:codex-mini`));
  assert.deepEqual(f.selection, { provider: 'codex-accounts', model: `${f.keys[0]}:codex-mini`, reasoningEffort: 'high' });
  assert.equal(result.managed, true); assert.equal(result.model, `${f.keys[0]}:codex-mini`); assertNoAccountWork(f);
});
test('host absent or refusing selection fails closed', async t => {
  for (const options of [{ noHost: true }, { ignoreSave: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.service.selectHostModel(f.keys[0], hash(`${f.keys[0]}:codex-mini`)), /HOST_MODEL_(UNAVAILABLE|NOT_SAVED)/);
    assertNoAccountWork(f);
  }
});
test('host readback must confirm requested reasoning effort, not just provider/model', async t => {
  const f = await fixture(t, { readSelection: value => ({ ...value, reasoningEffort: 'low' }) });
  const a = await f.service.models(f.keys[0]);
  await f.service.configureModels(f.keys[0], a.generation, settings({ defaultModel: 'codex-mini', reasoningEffort: 'high' }));
  await assert.rejects(f.service.selectHostModel(f.keys[0], hash(`${f.keys[0]}:codex-mini`)), /HOST_MODEL_NOT_SAVED/);
});
test('host foreign-provider state is not exposed as a managed account model', async t => {
  const f = await fixture(t); const result = await f.service.catalogue();
  assert.equal(result.hostModel.available, true); assert.equal(result.hostModel.managed, false);
  assert.equal(result.hostModel.model, undefined); assert.equal(result.hostModel.reasoningEffort, undefined);
});
test('host rejects a hash belonging to another account without saving', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.selectHostModel(f.keys[1], hash(`${f.keys[0]}:codex-mini`)), /MODEL_REVOKED/);
  assert.equal(f.calls.filter(c => c[0] === 'host.save').length, 0);
});
test('picker emits readable IDs, old hash routes still prepare the same fixed account', async t => {
  const f = await fixture(t), adapter = createBoundAdapter(f.service), routes = await adapter.listModels();
  assert(routes.every(r => r.provider === 'codex-accounts'));
  assert(routes.some(r => r.id === `${f.keys[0]}:codex-mini`)); assert(!routes.some(r => r.id === `${f.keys[0]}:${hash(`${f.keys[0]}:codex-mini`)}`));
  const readable = await adapter.prepareCall('codex-accounts', `${f.keys[0]}:codex-mini`);
  const old = await adapter.prepareCall('codex-accounts', `${f.keys[0]}:${hash(`${f.keys[0]}:codex-mini`)}`);
  assert.equal(readable.model.name, old.model.name);
  assert.deepEqual(f.calls.filter(c => c[0] === 'prepare').map(c => c.slice(1)), [['A', 'codex-mini'], ['A', 'codex-mini']]);
  assertNoAccountWork(f);
});
test('default picker entries come from selected default account, not the first account', async t => {
  const f = await fixture(t, { defaultSecond: true }), first = await f.service.models(f.keys[0]);
  await f.service.configureModels(f.keys[0], first.generation, settings({ enabled: ['codex-mini'] }));
  const second = await f.service.models(f.keys[1]);
  await f.service.configureModels(f.keys[1], second.generation, settings({ enabled: ['codex-large'] }));
  const adapter = createBoundAdapter(f.service), routes = await adapter.listModels();
  assert.deepEqual(routes.filter(r => r.id.startsWith('default:')).map(r => r.id), ['default:codex-large']);
  await adapter.prepareCall('codex-accounts', 'default:codex-large');
  assert.deepEqual(f.calls.filter(c => c[0] === 'prepare').map(c => c.slice(1)), [['B', 'codex-large']]);
});
for (const provider of ['openai', 'openai-codex', 'deepseek-official']) for (const method of ['prepareCall', 'resolveModel', 'stream']) {
  test(`bound adapter ${method} refuses foreign provider ${provider} before preparation`, async t => {
    const f = await fixture(t), adapter = createBoundAdapter(f.service);
    await assert.rejects(async () => {
      if (method === 'stream') { for await (const _ of adapter.stream({ provider, model: `${f.keys[0]}:codex-mini` })) {} }
      else await adapter[method](provider, `${f.keys[0]}:codex-mini`);
    }, /PROVIDER|BOUND/);
    assert.equal(f.calls.filter(c => c[0] === 'prepare').length, 0);
  });
}
test('adapter never publishes guessed image request pricing', async t => {
  const f = await fixture(t), adapter = createBoundAdapter(f.service);
  assert.equal(adapter.imageRequestPricing('codex-accounts', `${f.keys[0]}:codex-mini`), undefined);
});
test('removed account cannot refresh/configure/select host or fall back to another account', async t => {
  const f = await fixture(t), before = await f.service.models(f.keys[0]); await f.service.remove(f.keys[0]);
  await assert.rejects(f.service.models(f.keys[0], true), /ACCOUNT_NOT_BOUND/);
  await assert.rejects(f.service.configureModels(f.keys[0], before.generation, settings()), /ACCOUNT_NOT_BOUND/);
  await assert.rejects(f.service.selectHostModel(f.keys[0], hash(`${f.keys[0]}:codex-mini`)), /ACCOUNT_NOT_BOUND/);
  assert.equal(f.calls.filter(c => c[0] === 'host.save' || c[0] === 'refresh').length, 0);
});
test('configuration shutdown is independent of warmup permission/dedup/journal I/O', async t => {
  const f = await fixture(t), before = await f.service.models(f.keys[0]);
  await f.service.configureModels(f.keys[0], before.generation, settings({ enabled: [] })); assertNoAccountWork(f);
  const source = await fs.readFile(new URL('./codex-accounts/service.js', import.meta.url), 'utf8');
  const section = source.slice(source.indexOf('async configureModels('), source.indexOf('async selectHostModel('));
  assert(section.length > 0);
  assert.doesNotMatch(section, /\b(?:warmup|quota|claim|finish|MultiWarmupStore|fetchImpl|saveSelection|deleteRecord|modifyRecord)\b/);
  assert.deepEqual((await fs.readdir(f.dir)).sort(), ['accounts.json']);
});

test('refresh captures its account before a simultaneous default-account change', async t => {
  const entered = deferred(), gate = deferred(), f = await fixture(t, { refresh: async label => { if (label === 'A') { entered.resolve(); await gate.promise; } } });
  const task = f.service.models(f.keys[0], true); await entered.promise;
  try { await f.service.select(f.keys[1], (await f.service.catalogue()).generation); }
  finally { gate.resolve(); }
  assert.equal((await task).accountKey, f.keys[0]);
  assert.deepEqual(f.calls.filter(c => c[0] === 'refresh').map(c => c[1]), ['A', 'B']);
  assert.equal((await f.service.catalogue()).defaultKey, f.keys[1]);
});
test('disabling models preserves grants, default-account selection and existing warmup identities', async t => {
  const f = await fixture(t), before = await f.service.models(f.keys[0]), records = structuredClone([...f.records]);
  const identity = hash(`${f.keys[0]}:codex-mini`), defaultKey = (await f.service.catalogue()).defaultKey;
  await f.service.configureModels(f.keys[0], before.generation, settings({ enabled: [] }));
  assert.deepEqual([...f.records], records); assert.equal((await f.service.catalogue()).defaultKey, defaultKey);
  const current = await f.service.models(f.keys[0]);
  await f.service.configureModels(f.keys[0], current.generation, settings());
  assert.equal((await f.service.bindings()).accounts.find(a => a.accountKey === f.keys[0]).models.find(m => m.baseId === 'codex-mini').modelKey, identity);
  assertNoAccountWork(f);
});
test('model RPC actions dispatch exact arguments and a bounded abort signal', async () => {
  const calls = [], service = {
    models: async (...args) => { calls.push(['models', ...args]); return { ok: true }; },
    configureModels: async (...args) => { calls.push(['configure', ...args]); return { ok: true }; },
    selectHostModel: async (...args) => { calls.push(['host', ...args]); return { ok: true }; },
  };
  const key = 'a'.repeat(16), modelKey = 'b'.repeat(64), config = settings();
  for (const body of [{ action: 'models.read', accountKey: key }, { action: 'models.refresh', accountKey: key },
    { action: 'models.configure', accountKey: key, expectedGeneration: 7, settings: config }, { action: 'host-model.select', accountKey: key, modelKey }]) {
    const result = await invoke(service, body); assert.equal(result.status, 200); assert.equal(result.headers['Cache-Control'], 'no-store');
  }
  assert.deepEqual(calls[0].slice(0, 3), ['models', key, false]); assert(calls[0][3] instanceof AbortSignal);
  assert.deepEqual(calls[1].slice(0, 3), ['models', key, true]); assert(calls[1][3] instanceof AbortSignal);
  assert.deepEqual(calls[2], ['configure', key, 7, config]); assert.deepEqual(calls[3], ['host', key, modelKey]);
});
test('model actions reject missing/extra fields before touching service', async () => {
  let calls = 0; const service = new Proxy({}, { get: () => () => { calls++; throw Error('UNEXPECTED_CALL'); } });
  for (const body of [{ action: 'models.read' }, { action: 'models.read', accountKey: 'a', refresh: true },
    { action: 'models.refresh', accountKey: 'a', url: 'https://invalid.test' },
    { action: 'models.configure', accountKey: 'a', settings: settings() },
    { action: 'host-model.select', accountKey: 'a', modelKey: 'b', provider: 'openai' }]) assert.equal((await invoke(service, body)).status, 400);
  assert.equal(calls, 0);
});
test('model actions remain auth-first and return no sensitive exception data', async () => {
  let calls = 0; const service = { models: async () => { calls++; throw Error('PRIVATE_MOCK_ACCESS PRIVATE_MOCK_ACCOUNT'); } };
  const denied = await invoke(service, { action: 'models.read', accountKey: 'a' }, { authorize: (_req, res) => { res.writeHead(403, {}); res.end('{}'); return false; } });
  assert.equal(denied.status, 403); assert.equal(calls, 0);
  const result = await invoke(service, { action: 'models.refresh', accountKey: 'a' });
  assert.equal(result.status, 503); assert.equal(result.data.error, 'ACCOUNT_SERVICE_UNAVAILABLE'); assert(!JSON.stringify(result).includes('PRIVATE'));
});
test('desktop proxy forwards model management solely to the fixed codex-accounts channel', async t => {
  const f = await fixture(t), requests = [], handler = accountServiceFetchHandler(f.service);
  const bridge = { async fetch(request) { requests.push({ url: request.url, method: request.method, body: await request.clone().json() }); return handler(request); } };
  const proxy = officialAccountsProxy({ bridge: () => bridge, authorize: () => true });
  async function post(body) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'; req.headers = { 'content-type': 'application/json' };
    const result = {}, res = { writeHead(status) { result.status = status; }, end(value) { result.data = JSON.parse(value); } };
    await proxy(req, res); return result;
  }
  const read = await post({ action: 'models.read', accountKey: f.keys[0] }); assert.equal(read.status, 200);
  const config = await post({ action: 'models.configure', accountKey: f.keys[0], expectedGeneration: read.data.generation,
    settings: settings({ enabled: ['codex-mini'] }) }); assert.equal(config.status, 200);
  assert.equal((await post({ action: 'host-model.select', accountKey: f.keys[0], modelKey: hash(`${f.keys[0]}:codex-mini`) })).status, 200);
  assert.equal((await post({ action: 'models.refresh', accountKey: f.keys[0] })).status, 200);
  assert.equal((await post({ action: 'warmup.run', accountKey: f.keys[0], modelKey: hash(`${f.keys[0]}:codex-mini`) })).status, 400);
  assert.equal(requests.length, 4);
  assert(requests.every(r => r.url === 'http://localhost/api/dsh-plugin-codex-accounts' && r.method === 'POST'));
  assert.equal(f.calls.filter(c => c[0] === 'stream' || c[0] === 'auth' || c[0] === 'network').length, 0);
});
test('already aborted Fetch model RPC never dispatches refresh', async () => {
  let calls = 0; const handler = accountServiceFetchHandler({ models: async () => { calls++; return {}; } });
  const controller = new AbortController(); controller.abort();
  const response = await handler(new Request('http://private.test/api/dsh-plugin-codex-accounts', { method: 'POST', signal: controller.signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'models.refresh', accountKey: 'a'.repeat(16) }) }));
  assert.equal(response.status, 503); assert.equal((await response.json()).error, 'REQUEST_ABORTED'); assert.equal(calls, 0);
});
test('last observed slugs survive restart as discovery hints, not model permissions',async t=>{
 const f=await fixture(t);await f.service.models(f.keys[0],true);
 const bytes=await fs.readFile(f.directory.file,'utf8');assert(bytes.includes('gpt-6.1-sol'));assert(!bytes.includes('MOCK_REFRESH'));assert(!bytes.includes('MOCK_ACCOUNT_A'));
 await f.service.dispose();const refreshes=[];
 const restored=createAccountService({directory:f.directory,credentials:f.credentials,driver:async({credentials})=>{
  const grant=await credentials.read('openai-codex');let rows=[model()],remote=false;
  return{listModels:async()=>rows,catalogStatus:()=>({source:remote?'account-catalog':'builtin'}),refreshModels:async()=>{refreshes.push(grant.accountId);rows=[model(),model('gpt-6.1-sol')];remote=true;},prepare:async id=>({model:model(id),stream:async function*(){throw Error('INFERENCE_FORBIDDEN');}})};
 }});t.after(()=>restored.dispose());
 const binding=await restored.bindings();assert(binding.accounts.find(row=>row.accountKey===f.keys[0]).models.some(m=>m.baseId==='gpt-6.1-sol'));
 await restored.prepareSlug(f.keys[0],'gpt-6.1-sol');assert.deepEqual(refreshes,['MOCK_ACCOUNT_A']);
});
test('readable unknown slug revalidates account directory once before preparation, never grants missing model',async t=>{
 const f=await fixture(t);await f.service.prepareSlug(f.keys[0],'gpt-6.1-sol');
 assert.equal(f.calls.filter(c=>c[0]==='refresh').length,1);assert(!f.calls.some(c=>c[0]==='stream'));
 await assert.rejects(f.service.prepareSlug(f.keys[0],'gpt-9-not-provided'),/MODEL_REVOKED/);
 assert.equal(f.calls.filter(c=>c[0]==='refresh').length,1);assert(!(await fs.readFile(f.directory.file,'utf8')).includes('gpt-9-not-provided'));
});
test('revoke retires model hints while preserving the stable account budget identity',async t=>{
 const f=await fixture(t);await f.service.models(f.keys[0],true);await f.service.remove(f.keys[0]);
 const row=(await f.directory.read()).rows.find(row=>row.key===f.rows[0].key);assert.equal(row.modelHints,undefined);assert.equal(row.identityHash,f.rows[0].identityHash);
 await assert.rejects(f.service.prepareSlug(f.keys[0],'gpt-6.1-sol'),/ACCOUNT_UNAVAILABLE|ACCOUNT_REVOKED|ACCOUNT_NOT_BOUND/);
});
test('corrupt persisted model hint is rejected without repairing account metadata',async t=>{
 const f=await fixture(t),data=await f.directory.read();data.rows[0].modelHints=['gpt-6.1-sol\n'];
 const bytes=JSON.stringify(data);await fs.writeFile(f.directory.file,bytes);await assert.rejects(f.directory.read(),/DIRECTORY_UNAVAILABLE/);assert.equal(await fs.readFile(f.directory.file,'utf8'),bytes);
});
for(const mode of ['caller-abort','account-revoke']) test(`reported terminal usage survives ${mode} without releasing text/tool output`,async t=>{
 const f=await fixture(t),controller=new AbortController(),usage={inputTokens:17,outputTokens:5,totalTokens:22};
 await f.service.models(f.keys[0]);const engine=f.engines.get('A');engine.prepare=async id=>({model:model(id),stream:()=> (async function*(){
  if(mode==='caller-abort')controller.abort(Error('PRIVATE_ABORT_REASON'));else await f.service.remove(f.keys[0]);
  yield{type:'usage',usage};yield{type:'text-delta',text:'MUST_NOT_ESCAPE'};yield{type:'finish',reason:{kind:'stop'}};
 })()});
 const prepared=await f.service.prepareSlug(f.keys[0],'codex-mini'),events=[];
 await assert.rejects(async()=>{for await(const event of prepared.stream({signal:controller.signal,messages:[]}))events.push(event);},error=>error.code==='BOUND_CANCELLED'&&error.requestNotSent===false&&!JSON.stringify(error).includes('PRIVATE_ABORT'));
 assert.deepEqual(events,[{type:'usage',usage}]);assert.equal(f.calls.filter(c=>['auth','network','stream'].includes(c[0])).length,0);
});
for(const [code,category] of [['AUTH','BOUND_AUTH_REQUIRED'],['RATE_LIMIT','BOUND_QUOTA_LIMITED'],['TRANSPORT','BOUND_TRANSPORT_FAILED'],['UNKNOWN','BOUND_REQUEST_FAILED']])test(`in-band SDK ${code} failure is normalized without losing reported usage`,async t=>{
 const f=await fixture(t),usage={inputTokens:17,outputTokens:5,totalTokens:22};await f.service.models(f.keys[0]);
 f.engines.get('A').prepare=async id=>({model:model(id),stream:()=> (async function*(){yield{type:'usage',usage};yield{type:'finish',reason:{kind:'error',failure:{code,message:'PRIVATE_MOCK_ACCESS PRIVATE_MOCK_ACCOUNT',cause:{secret:'PRIVATE_CAUSE'}}},privateExtension:'PRIVATE_TOP_LEVEL'};})()});
 const prepared=await f.service.prepareSlug(f.keys[0],'codex-mini'),events=[];for await(const event of prepared.stream({messages:[]}))events.push(event);
 assert.deepEqual(events[0],{type:'usage',usage});assert.equal(events.length,2);assert.equal(events[1].reason.kind,'error');assert.equal(events[1].reason.failure.code,'UNKNOWN');assert.match(events[1].reason.failure.message,new RegExp(category));assert(!JSON.stringify(events).includes('PRIVATE_'));assert.deepEqual(Object.keys(events[1]).sort(),['reason','type']);assert.deepEqual(Object.keys(events[1].reason.failure).sort(),['code','message']);
});
test('failed warmup retains SDK usage but never becomes success or proven unsent',async t=>{
 const f=await fixture(t,{fetchImpl:async()=>new Response(JSON.stringify({account_id:'MOCK_ACCOUNT_A',ordinary_usage_allowed:true,rate_limit:{allowed:true,primary_window:{used_percent:10,reset_at:1800003600,limit_window_seconds:18000}}}),{headers:{'content-type':'application/json'}})}),usage={inputTokens:17,outputTokens:5,totalTokens:22};await f.service.models(f.keys[0]);
 f.engines.get('A').auth=async()=>({apiKey:token('MOCK_ACCOUNT_A')});
 f.engines.get('A').prepare=async id=>({model:model(id),stream:()=> (async function*(){yield{type:'usage',usage};yield{type:'finish',reason:{kind:'error',failure:{code:'AUTH',message:'PRIVATE_MOCK_ACCESS'}}};})()});
 await assert.rejects(f.service.warmup(f.keys[0],hash(`${f.keys[0]}:codex-mini`),new AbortController().signal),error=>error.code==='WARMUP_UNCONFIRMED'&&error.requestNotSent===false&&JSON.stringify(error.usage)===JSON.stringify(usage)&&!JSON.stringify(error).includes('PRIVATE_'));
});

test('apply uses injected FakeStore/FakeDriver and registers only codex-accounts adapter plus agentDefaultModel integration', async t => {
  const f = await fixture(t), registrations = [], effects = [];
  const ctx = { credentials: f.credentials, get: name => name === 'agentDefaultModel' ? f.host : undefined,
    llm: { registerAdapter: (...args) => registrations.push(args), emitAdaptersUpdated() {} },
    inject() {}, effect: (factory, label) => { if (label === 'codex-accounts: lifetime') effects.push(factory()); } };
  await apply(ctx, { directoryFile: f.directory.file, driver: async () => { throw Error('IMPLICIT_DRIVER_FORBIDDEN'); }, fetchImpl: async () => { throw Error('NETWORK_FORBIDDEN'); } });
  t.after(async () => { for (const dispose of effects) await dispose(); });
  assert.deepEqual(registrations.map(r => r[0]), [['codex-accounts']]);
  const source = await fs.readFile(new URL('./codex-accounts/index.js', import.meta.url), 'utf8');
  assert.match(source, /hostModel\s*:\s*\(\)\s*=>\s*get\(['"]agentDefaultModel['"]\)/);
  assertNoAccountWork(f);
});
