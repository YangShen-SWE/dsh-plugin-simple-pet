import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccountDirectory, createAccountService, hash } from './codex-accounts/service.js';
import { createOfficialDriver, createBoundAdapter } from './codex-accounts/official-driver.js';

// Only private Temp metadata and synthetic, in-memory grants/SDKs/transports.
// No installed plugin, real credentials, OAuth flow, inference or network is used.
const NOW = 1800000000000;
const PRIVATE = 'PRIVATE_MOCK_ACCESS PRIVATE_MOCK_REFRESH PRIVATE_MOCK_ACCOUNT';
const token = id => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: id },
})).toString('base64url')}.MOCK_SIGNATURE`;
const model = id => ({ id, name: id, inputModalities: ['text'],
  context: { contextWindow: 200000 }, reasoning: { efforts: [{ id: 'high' }] } });
const settings = extra => ({ enabled: null, defaultModel: null, reasoningEffort: null, ...extra });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'DshIntegratedModelRefresh-'));
  const directory = new AccountDirectory(path.join(dir, 'accounts.json'));
  const calls = [], records = new Map(), services = [], engines = new Map();
  const rows = ['A', 'B'].map((label, i) => ({ key: String(i + 1).repeat(16), epoch: 1,
    label, bound: true, revoked: false, identityHash: hash(`MOCK_ACCOUNT_${label}`) }));
  const keys = rows.map(row => row.identityHash.slice(0, 16));
  for (const row of rows) records.set(`codex-accounts/account-${row.key}`, { kind: 'grant', payload: {
    type: 'oauth', accountId: `MOCK_ACCOUNT_${row.label}`, access: token(`MOCK_ACCOUNT_${row.label}`),
    refresh: `MOCK_REFRESH_${row.label}`, expires: NOW + 3600000,
  } });
  const credentials = {
    async readRecord(key) { calls.push(['credential.read', key]); return structuredClone(records.get(key)); },
    async modifyRecord() { calls.push(['credential.modify']); throw Error('CREDENTIAL_MUTATION_FORBIDDEN'); },
    async deleteRecord() { calls.push(['credential.delete']); throw Error('CREDENTIAL_DELETION_FORBIDDEN'); },
  };
  const host = {
    currentSelection: () => ({ provider: 'deepseek-official', model: 'unrelated' }),
    async saveSelection() { calls.push(['host.save']); throw Error('HOST_SAVE_FORBIDDEN'); },
  };
  const makeDriver = driverOptions => async ({ credentials: scoped }) => {
    const grant = await scoped.read('openai-codex');
    const label = grant.accountId.endsWith('_A') ? 'A' : 'B';
    calls.push(['driver', label]);
    let models = [model('codex-mini'), model('codex-large')], revision = 0;
    const engine = {
      async login() { calls.push(['login', label]); throw Error('OAUTH_FORBIDDEN'); },
      async auth() { calls.push(['auth', label]); throw Error('QUOTA_AUTH_FORBIDDEN'); },
      async listModels() { calls.push(['list', label]); return structuredClone(models); },
      catalogStatus: () => ({ source: revision ? 'account-catalog' : 'builtin',
        status: revision ? 'ready' : 'not-refreshed', revision }),
      async refreshModels(signal) {
        calls.push(['refresh', label, signal]);
        signal.throwIfAborted();
        if (driverOptions.refresh) await driverOptions.refresh(label, signal);
        signal.throwIfAborted();
        models = (driverOptions.remoteIds ?? ['codex-mini', 'codex-large', 'gpt-6.1-sol']).map(model);
        revision++;
      },
      async prepare(id) {
        calls.push(['prepare', label, id]);
        return { model: model(id), stream: async function* () {
          calls.push(['stream', label]); throw Error('INFERENCE_FORBIDDEN');
        } };
      },
    };
    engines.set(label, engine);
    return engine;
  };
  const start = (driverOptions = options) => {
    const service = createAccountService({ directory, credentials, driver: makeDriver(driverOptions),
      clock: () => NOW, hostModel: () => host,
      fetchImpl: async () => { calls.push(['network']); throw Error('NETWORK_FORBIDDEN'); } });
    services.push(service);
    return service;
  };
  t.after(async () => {
    for (const service of services) await service.dispose();
    // Validate the exact mkdtemp result before deleting only this private fixture.
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert(path.basename(dir).startsWith('DshIntegratedModelRefresh-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  await directory.update(data => { data.rows = rows; data.defaultKey = rows[0].key; });
  return { dir, directory, calls, records, rows, keys, engines, start, service: start() };
}
function assertPassive(f) {
  assert.deepEqual(f.calls.filter(call => ['login', 'auth', 'network', 'stream', 'host.save',
    'credential.modify', 'credential.delete'].includes(call[0])), []);
}
const refreshLabels = f => f.calls.filter(call => call[0] === 'refresh').map(call => call[1]);

// Wrap the real entry point, rather than substituting its implementation: this
// checks select's captured arguments, commit ordering AND the actual refresh.
test('select commits the captured account before models(key, true, signal) and returns its refreshed snapshot', async t => {
  const f = await fixture(t), before = await f.service.catalogue(), controller = new AbortController();
  const original = f.service.models, dispatches = [], records = structuredClone([...f.records]);
  f.service.models = async (...args) => {
    dispatches.push({ args, selected: (await f.directory.read()).defaultKey });
    return original(...args);
  };
  const result = await f.service.select(f.keys[1], before.generation, controller.signal);
  assert.equal(dispatches.length, 1);
  assert.deepEqual(dispatches[0].args, [f.keys[1], true, controller.signal]);
  assert.equal(dispatches[0].selected, f.rows[1].key);
  assert.equal(result.ok, true); assert.equal(result.accountKey, f.keys[1]);
  assert.equal(result.modelError, null); assert.equal(result.models.accountKey, f.keys[1]);
  assert.equal(result.models.catalog.source, 'account-catalog');
  assert(result.models.models.some(row => row.id === 'gpt-6.1-sol'));
  assert.equal((await f.service.catalogue()).defaultKey, f.keys[1]);
  assert.deepEqual(refreshLabels(f), ['B']);
  assert.deepEqual(f.calls.filter(call => call[0] === 'driver').map(call => call[1]), ['B']);
  assert.deepEqual([...f.records], records); assertPassive(f);
});

test('select refresh failure is a public modelError and never rolls back the committed account', async t => {
  const f = await fixture(t, { refresh: async () => { throw Error(PRIVATE); } });
  const result = await f.service.select(f.keys[1], (await f.service.catalogue()).generation);
  assert.deepEqual(result, { ok: true, accountKey: f.keys[1], models: null, modelError: 'MODEL_CATALOG_UNAVAILABLE' });
  assert.equal((await f.service.catalogue()).defaultKey, f.keys[1]);
  assert.equal((await f.directory.read()).defaultKey, f.rows[1].key);
  assert(!JSON.stringify(result).includes('PRIVATE'));
  assert.deepEqual(refreshLabels(f), ['B']); assertPassive(f);
});

test('select forwards cancellation into only its account refresh while selection remains committed', { timeout: 5000 }, async t => {
  const entered = deferred(), controller = new AbortController();
  const f = await fixture(t, { refresh: async (_label, signal) => {
    entered.resolve(signal);
    await new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  } });
  const operation = f.service.select(f.keys[1], (await f.service.catalogue()).generation, controller.signal);
  t.after(() => controller.abort());
  const received = await entered.promise;
  assert(received instanceof AbortSignal); assert.equal(received.aborted, false);
  assert.equal((await f.service.catalogue()).defaultKey, f.keys[1]);
  controller.abort(Error(PRIVATE));
  const result = await operation;
  assert.equal(received.aborted, true);
  assert.equal(result.ok, true); assert.equal(result.models, null);
  assert.equal(result.modelError, 'MODEL_CATALOG_UNAVAILABLE');
  assert.equal((await f.service.catalogue()).defaultKey, f.keys[1]);
  assert(!JSON.stringify(result).includes('PRIVATE')); assert.deepEqual(refreshLabels(f), ['B']); assertPassive(f);
});

test('a slower selection refresh remains bound to its original account after a newer selection', { timeout: 5000 }, async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { refresh: async label => {
    if (label === 'A') { entered.resolve(); await release.promise; }
  } });
  const first = f.service.select(f.keys[0], (await f.service.catalogue()).generation);
  try {
    await entered.promise;
    const second = await f.service.select(f.keys[1], (await f.service.catalogue()).generation);
    assert.equal(second.models.accountKey, f.keys[1]); assert.equal(second.modelError, null);
  } finally { release.resolve(); }
  const result = await first;
  assert.equal(result.accountKey, f.keys[0]); assert.equal(result.models.accountKey, f.keys[0]);
  assert.equal(result.modelError, null);
  assert.equal((await f.service.catalogue()).defaultKey, f.keys[1]);
  assert.deepEqual(refreshLabels(f), ['A', 'B']); assertPassive(f);
});

test('stale selection generation does not commit or start any account refresh', async t => {
  const f = await fixture(t), before = await f.service.catalogue();
  await assert.rejects(f.service.select(f.keys[1], before.generation - 1), /SOURCE_CHANGED/);
  assert.equal((await f.service.catalogue()).defaultKey, f.keys[0]);
  assert.deepEqual(refreshLabels(f), []);
  assert.equal(f.calls.filter(call => call[0] === 'driver').length, 0); assertPassive(f);
});

async function restarted(t, restoredOptions = {}) {
  const f = await fixture(t);
  await f.service.models(f.keys[0], true);
  await f.service.dispose();
  f.calls.length = 0;
  // Recreate only the service, not the host/process; same private Temp metadata.
  return { ...f, restored: f.start(restoredOptions) };
}

test('models(key, false) after service recreation revalidates persisted hints for only that account', async t => {
  const f = await restarted(t), records = structuredClone([...f.records]);
  const result = await f.restored.models(f.keys[0], false);
  assert.equal(result.accountKey, f.keys[0]); assert.equal(result.catalog.source, 'account-catalog');
  assert(result.models.some(row => row.id === 'gpt-6.1-sol'));
  assert.deepEqual(refreshLabels(f), ['A']);
  await f.restored.models(f.keys[0], false);
  const other = await f.restored.models(f.keys[1], false);
  assert.equal(other.catalog.source, 'builtin');
  assert(!other.models.some(row => row.id === 'gpt-6.1-sol'));
  assert.deepEqual(refreshLabels(f), ['A']); assert.deepEqual([...f.records], records); assertPassive(f);
});

test('persisted hints cannot grant a model absent from the revalidated catalogue', async t => {
  const f = await restarted(t, { remoteIds: ['codex-mini'] });
  const result = await f.restored.models(f.keys[0], false);
  assert.deepEqual(result.models.map(row => row.id), ['codex-mini']);
  const row = (await f.directory.read()).rows.find(row => row.key === f.rows[0].key);
  assert.deepEqual(row.modelHints, ['codex-mini']);
  await assert.rejects(f.restored.prepareSlug(f.keys[0], 'gpt-6.1-sol'), /MODEL_REVOKED/);
  assert.deepEqual(refreshLabels(f), ['A']);
  assert.equal(f.calls.filter(call => call[0] === 'prepare').length, 0); assertPassive(f);
});

test('hint revalidation failure rejects models(false) rather than publishing saved hints as permissions', async t => {
  const f = await restarted(t, { refresh: async () => { throw Error(PRIVATE); } });
  const bytes = await fs.readFile(f.directory.file, 'utf8');
  await assert.rejects(f.restored.models(f.keys[0], false), error =>
    error.code === 'MODEL_CATALOG_UNAVAILABLE' && !String(error).includes('PRIVATE'));
  assert.equal(await fs.readFile(f.directory.file, 'utf8'), bytes);
  assert.equal((await f.restored.catalogue()).defaultKey, f.keys[0]);
  assert.deepEqual(refreshLabels(f), ['A']); assertPassive(f);
});

for (const code of ['MODEL_CATALOG_AUTH_REQUIRED', 'MODEL_CATALOG_UNAVAILABLE']) test(`restart ${code} is isolated from other account picker models`, async t => {
  const f = await restarted(t, { refresh: async label => { assert.equal(label, 'A'); throw Error(code); } });
  const bytes = await fs.readFile(f.directory.file, 'utf8');
  const bindings = await f.restored.bindings();
  const a = bindings.accounts.find(row => row.accountKey === f.keys[0]);
  const b = bindings.accounts.find(row => row.accountKey === f.keys[1]);
  assert.deepEqual(a.models, []); assert.equal(a.modelError, code);
  assert.deepEqual(b.models.map(row => row.baseId), ['codex-mini', 'codex-large']);
  const routes = await createBoundAdapter(f.restored).listModels();
  assert(routes.some(row => row.id === `${f.keys[1]}:codex-mini`));
  assert(!routes.some(row => row.id.startsWith(f.keys[0] + ':') || row.id.startsWith('default:')));
  await assert.rejects(f.restored.prepareSlug(f.keys[0], 'gpt-6.1-sol'), new RegExp(code));
  assert.equal(await fs.readFile(f.directory.file, 'utf8'), bytes);
  assert.equal((await f.restored.catalogue()).defaultKey, f.keys[0]); assertPassive(f);
});

test('selection refresh discovers new models without expanding the saved enabled allowlist', async t => {
  const f = await fixture(t), before = await f.service.models(f.keys[1], false);
  const saved = settings({ enabled: ['codex-mini'], defaultModel: 'codex-mini', reasoningEffort: 'high' });
  await f.service.configureModels(f.keys[1], before.generation, saved);
  const selected = await f.service.select(f.keys[1], (await f.service.catalogue()).generation);
  assert.equal(selected.modelError, null); assert.deepEqual(selected.models.settings, saved);
  assert.equal(selected.models.models.find(row => row.id === 'gpt-6.1-sol').enabled, false);
  const bindings = await f.service.bindings();
  assert.deepEqual(bindings.accounts.find(row => row.accountKey === f.keys[1]).models.map(row => row.baseId), ['codex-mini']);
  const routes = await createBoundAdapter(f.service).listModels();
  assert.deepEqual(routes.filter(row => row.id.startsWith('default:')).map(row => row.id), ['default:codex-mini']);
  await assert.rejects(f.service.prepareSlug(f.keys[1], 'gpt-6.1-sol'), /MODEL_REVOKED/);
  await assert.rejects(f.service.prepare(f.keys[1], hash(`${f.keys[1]}:gpt-6.1-sol`)), /MODEL_REVOKED/);
  assert.equal(f.calls.filter(call => call[0] === 'prepare').length, 0);
  assert.deepEqual(refreshLabels(f), ['B']); assertPassive(f);
});

test('models(false) revalidation after service recreation still filters persisted enabled models', async t => {
  const f = await fixture(t), first = await f.service.models(f.keys[0], true);
  const saved = settings({ enabled: ['gpt-6.1-sol'], defaultModel: 'gpt-6.1-sol', reasoningEffort: 'high' });
  await f.service.configureModels(f.keys[0], first.generation, saved);
  await f.service.dispose(); f.calls.length = 0;
  const restored = f.start(), current = await restored.models(f.keys[0], false);
  assert.deepEqual(current.settings, saved);
  assert.deepEqual(current.models.filter(row => row.enabled).map(row => row.id), ['gpt-6.1-sol']);
  const bindings = await restored.bindings();
  assert.deepEqual(bindings.accounts.find(row => row.accountKey === f.keys[0]).models.map(row => row.baseId), ['gpt-6.1-sol']);
  await assert.rejects(restored.prepareSlug(f.keys[0], 'codex-mini'), /MODEL_REVOKED/);
  assert.equal(f.calls.filter(call => call[0] === 'prepare').length, 0);
  assert.deepEqual(refreshLabels(f), ['A']); assertPassive(f);
});

// Exercise the production official driver, injecting every external SDK module
// and fetch. Deferred responses force ordering without sleeps or real traffic.
const builtin = () => [{ id: 'codex-mini', name: 'Codex mini', provider: 'openai-codex',
  input: ['text'], contextWindow: 200000, maxTokens: 8192, reasoning: false,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } }];
const response = (id, etag) => Response.json({ models: [{ slug: id, display_name: id,
  visibility: 'list', context_window: 400000, input_modalities: ['text'] }] }, { headers: { etag } });
async function controlledOfficial() {
  const pending = [], started = [deferred(), deferred(), deferred()], maps = [], calls = [];
  const grant = { type: 'oauth', access: 'PRIVATE_MOCK_ACCESS', accountId: 'PRIVATE_MOCK_ACCOUNT' };
  let profiles;
  class Adapter {
    constructor(options) { profiles = options.profiles; }
    listModels() { const map = profiles(); maps.push(map); return map.get('openai-codex').piProvider.getModels().map(row => ({ id: row.id, name: row.name })); }
    resolveModel(_provider, id) { return { id }; }
    prepareCall() { calls.push('prepare'); throw Error('INFERENCE_FORBIDDEN'); }
  }
  const driver = await createOfficialDriver({ credentials: { read: async () => structuredClone(grant) },
    runtime: { fetchImpl: async (url, init) => {
      const gate = deferred(), index = pending.length;
      pending.push({ gate, url, init }); started[index]?.resolve();
      return gate.promise;
    } } }, async () => ({
    createModels: () => ({ setProvider() {}, getAuth: async () => ({ source: 'OAuth', auth: { apiKey: grant.access } }),
      login() { calls.push('login'); throw Error('OAUTH_FORBIDDEN'); } }),
    openaiCodexProvider: () => ({ id: 'openai-codex', auth: { oauth: { isSubscription: true } }, getModels: builtin }),
    PiAiAdapter: Adapter,
  }));
  return { driver, pending, started, maps, calls };
}

for (const older of ['success', 'failure']) test(`latest driver refresh wins when an older ${older} settles afterwards`, { timeout: 5000 }, async () => {
  const f = await controlledOfficial();
  assert.deepEqual((await f.driver.listModels()).map(row => row.id), ['codex-mini']);
  const first = f.driver.refreshModels();
  const rejected = assert.rejects(first, error => error.message ===
    (older === 'success' ? 'MODEL_CATALOG_SUPERSEDED' : 'MODEL_CATALOG_UNAVAILABLE'));
  await f.started[0].promise;
  const second = f.driver.refreshModels(); await f.started[1].promise;
  f.pending[1].gate.resolve(response('new-catalogue-model', '"new"'));
  await second;
  const latest = f.driver.catalogStatus();
  assert.equal(latest.status, 'ready'); assert.equal(latest.error, null); assert.equal(latest.revision, 1);
  assert.deepEqual((await f.driver.listModels()).map(row => row.id), ['new-catalogue-model']);
  const latestMap = f.maps.at(-1);
  assert.notEqual(latestMap, f.maps[0]);
  if (older === 'success') f.pending[0].gate.resolve(response('old-catalogue-model', '"old"'));
  else f.pending[0].gate.reject(Error(PRIVATE));
  await rejected;
  assert.deepEqual(f.driver.catalogStatus(), latest);
  assert.deepEqual((await f.driver.listModels()).map(row => row.id), ['new-catalogue-model']);
  assert.equal(f.maps.at(-1), latestMap);
  // A later conditional refresh must use the winning ETag, never the old one.
  const third = f.driver.refreshModels(); await f.started[2].promise;
  assert.equal(new Headers(f.pending[2].init.headers).get('if-none-match'), '"new"');
  f.pending[2].gate.resolve(new Response(null, { status: 304 })); await third;
  assert.equal(f.driver.catalogStatus().revision, latest.revision);
  assert.equal(f.driver.catalogStatus().status, 'ready');
  assert.deepEqual((await f.driver.listModels()).map(row => row.id), ['new-catalogue-model']);
  assert(!JSON.stringify(f.driver.catalogStatus()).includes('PRIVATE')); assert.deepEqual(f.calls, []);
});

test('a newer failed refresh also supersedes an older success instead of granting its obsolete catalogue', { timeout: 5000 }, async () => {
  const f = await controlledOfficial(), first = f.driver.refreshModels();
  const firstRejected = assert.rejects(first, /MODEL_CATALOG_SUPERSEDED/);
  await f.started[0].promise;
  const second = f.driver.refreshModels(), secondRejected = assert.rejects(second, /MODEL_CATALOG_UNAVAILABLE/);
  await f.started[1].promise;
  f.pending[1].gate.reject(Error(PRIVATE)); await secondRejected;
  const latest = f.driver.catalogStatus();
  assert.equal(latest.source, 'builtin'); assert.equal(latest.status, 'stale');
  assert.equal(latest.error, 'MODEL_CATALOG_UNAVAILABLE'); assert.equal(latest.revision, 0);
  f.pending[0].gate.resolve(response('obsolete-model', '"obsolete"')); await firstRejected;
  assert.deepEqual(f.driver.catalogStatus(), latest);
  assert.deepEqual((await f.driver.listModels()).map(row => row.id), ['codex-mini']);
  assert(!JSON.stringify(latest).includes('PRIVATE')); assert.deepEqual(f.calls, []);
});
