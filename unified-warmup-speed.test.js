import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import vm from 'node:vm';
import { createSubscriptionRequestAuth } from './subscription-oauth.js';
import { createSubscriptionLegacyAdapter } from './subscription-legacy-route.js';
import { runCodexWarmup } from './warmup-call.js';

// Execute the shipped provider factory AND its private/public adapter wiring.
// Only SDK/host/transport boundaries are synthetic. Do not import the plugin's
// startup path: it can open real stores, timers and network connections.
// Source boundaries load executable code; no source-text assertion proves speed.
const bundle = readFileSync(new URL('./vendor/codex-subscription/lib/index.js', import.meta.url), 'utf8');
function section(start, end, from = 0) {
  const first = bundle.indexOf(start, from);
  const last = bundle.indexOf(end, first + start.length);
  if (first < 0 || last < 0) throw new Error(`Offline fixture boundary missing: ${start}`);
  return bundle.slice(first, last);
}
const applyStart = bundle.indexOf('async function apply(');
const executable = [
  section('//#region src/capability-settings.js', '//#endregion'),
  section('//#region src/settings-contract.js', '//#endregion'),
  section('//#region src/transport-failure.js', '//#endregion'),
  section('//#region src/pi-ai-runtime.js', '//#endregion'),
  section('\tconst providerOptions = {', '\n\tconst preferences = {', applyStart),
  section('\tconst profile = Object.freeze({', '\n\tresolveAuth = ', applyStart),
  section('\tconst petCallScope = new AsyncLocalStorage();', '\n\tconst currentAgent = ', applyStart),
  '({ provider, petWarmupProvider, completeAdapter, petWarmupAdapter });',
].join('\n');
const PROVIDER = 'openai-codex';
const MODEL = 'gpt-offline-speed-test';
const accountHash = key => createHash('sha256').update(key).digest('hex').slice(0, 16);
const expectedTier = mode => ({ fast: 'priority', ultrafast: 'ultrafast' })[mode];
async function consume(iterable) { const chunks = []; for await (const chunk of iterable) chunks.push(chunk); return chunks; }

function fixture(initialSpeed = 'fast') {
  let speed = initialSpeed, speedReads = 0, settingsWrites = 0, refreshes = 0;
  let account = 'offline-vault-a', identity = 'offline-account-a', bearer = 'synthetic-access-a';
  let privateAdapter, beforeResolve, injectCompactionTier = false, seedTier;
  const dispatched = [], compactionInputs = [], registered = new Map(), adapters = [];
  const model = Object.freeze({ id: MODEL, provider: PROVIDER, contextWindow: 128000 });
  const preferences = Object.freeze({
    get speedMode() { speedReads++; return speed; },
    outputVerbosity: 'high', reasoningSummary: 'concise', inputImageDetail: 'high',
    contextMode: 'standard', streamIdleTimeoutMinutes: 5, retryPolicy: 'off',
  });
  const settings = {
    get: () => preferences,
    update() { settingsWrites++; throw new Error('Global settings must never be written'); },
    onSubscriptionAdapter(value) { privateAdapter = value; },
  };
  const requestAuth = createSubscriptionRequestAuth({
    readAccountKey: async () => account,
    readCredential: async ({ signal }) => {
      signal?.throwIfAborted();
      return { type: 'oauth', access: bearer, accountId: identity };
    },
    resolveAuth: async options => {
      refreshes++;
      assert.equal(options.minOAuthValidityMs, 60000);
      await beforeResolve?.(options);
      return { auth: { apiKey: bearer }, source: 'synthetic OAuth' };
    },
  });
  const baseProvider = () => {
    const stream = async function* (requestModel, context, options) {
      options.signal?.throwIfAborted();
      const payload = await options.onPayload({
        model: requestModel.id,
        input: context.messages,
        reasoning: { effort: 'low', summary: 'auto' },
        ...(options.serviceTier === undefined ? {} : { service_tier: options.serviceTier }),
        ...(seedTier === undefined ? {} : { service_tier: seedTier }),
      }, requestModel);
      dispatched.push({ options, payload: JSON.parse(JSON.stringify(payload)) });
      yield { type: 'text-delta', text: 'OK' };
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 1 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    };
    return { auth: {}, getModels: () => [model], stream, streamSimple: stream };
  };
  // This host boundary only captures auth and forwards the selected profile's
  // provider. It contains no speed-mode or service-tier policy of its own.
  class PiAiAdapter {
    constructor(options) { this.options = options; adapters.push(this); }
    providerInfo(provider) { return { id: provider }; }
    providerRetryPolicy() { return undefined; }
    imageRequestPricing() { return undefined; }
    async listModels(provider) { return this.options.profiles().get(provider).piProvider.getModels(); }
    async resolveModel(provider, id) { return (await this.listModels(provider)).find(row => row.id === id); }
    async prepareCall(provider, id, signal) {
      signal?.throwIfAborted();
      const profile = this.options.profiles().get(provider);
      const selected = profile.piProvider.getModels().find(row => row.id === id);
      assert.ok(selected, 'synthetic model must exist');
      const handle = await this.options.resolveApiKey();
      signal?.throwIfAborted();
      return {
        model: selected,
        stream: options => profile.piProvider.streamSimple(selected, { messages: options.messages, tools: options.tools }, {
          ...options, apiKey: handle, signal: options.signal ?? signal,
        }),
      };
    }
    stream(options) {
      const pending = this.prepareCall(options.provider, options.model, options.signal);
      return (async function* () { yield* (await pending).stream(options); })();
    }
  }
  const compaction = {
    wrapAdapter: adapter => adapter,
    preparePayload(payload) {
      compactionInputs.push(payload);
      return injectCompactionTier ? { ...payload, service_tier: 'ultrafast' } : payload;
    },
    requestOptions: options => options,
    networkOptions: options => options,
  };
  const exports = vm.runInNewContext(executable, {
    PROVIDER, AsyncLocalStorage, PiAiAdapter, requestAuth, settings, compaction,
    createOpenAICodexProvider: baseProvider,
    createSubscriptionLegacyAdapter,
    createEmbeddedSettings: () => {},
    adapterAuth: Object.freeze({ marker: 'synthetic shared auth store' }),
    modelCatalog: {
      getModels: () => [model], revision: () => 1,
      metadata: () => ({ supportsFast: true, supportsUltrafast: true, supportVerbosity: true }),
    },
    connection: { prepare: async options => { options.signal?.throwIfAborted(); return { options }; } },
    network: { run: (_area, operation) => operation() },
    ctx: { get: () => undefined, llm: { registerAdapter(ids, adapter) { for (const id of ids) registered.set(id, adapter); } } },
    dshLlm: { LlmError: class extends Error { constructor(message, code) { super(message); this.code = code; } } },
    retryPolicyFor: () => undefined,
    MAX_REQUEST_IMAGE_BYTES: 1000000,
    REQUEST_IMAGE_PIXEL_BUDGET: 1000000, REQUEST_IMAGE_MAX_BYTES: 1000000,
    fetch() { throw new Error('Network forbidden in offline fixture'); },
  }, { filename: 'shipped-subscription-provider.offline.js' });
  const options = signal => ({ provider: PROVIDER, model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'OK' }] }], tools: [], signal });
  const bridge = { async fetch(request) {
    const body = await request.json();
    const value = body.method === 'codex-subscription/status'
      ? { authenticated: true, accounts: [{ active: true, id: account }] }
      : { managed: true, provider: PROVIDER, model: MODEL };
    return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } });
  } };
  return {
    ...exports, privateAdapter, registered, adapters, requestAuth, dispatched, compactionInputs, options,
    get speed() { return speed; }, set speed(value) { speed = value; },
    get speedReads() { return speedReads; }, get settingsWrites() { return settingsWrites; }, get refreshes() { return refreshes; },
    get accountKey() { return accountHash(account); },
    set beforeResolve(value) { beforeResolve = value; },
    set injectCompactionTier(value) { injectCompactionTier = value; },
    set seedTier(value) { seedTier = value; },
    switchAccount() { account = 'offline-vault-b'; identity = 'offline-account-b'; bearer = 'synthetic-access-b'; },
    rotateBearer() { bearer = 'synthetic-rotated-access-a'; },
    async warmup(signal = new AbortController().signal) {
      return runCodexWarmup({
        llm: {
          listModels: async () => [model],
          resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
          stream() { throw new Error('Private warmup must not use the general llm.stream route'); },
        },
        bridge, quota: { accountKey: accountHash(account) }, signal,
        prepareCall: (provider, id, requestSignal) => privateAdapter.prepareCall(provider, id, requestSignal, accountHash(account)),
      });
    },
  };
}

for (const mode of ['standard', 'fast', 'ultrafast']) {
  test(`real private warmup is standard under global ${mode}; chat keeps its chosen tier`, async () => {
    const f = fixture(mode);
    assert.deepEqual(await f.warmup(), { model: MODEL });
    assert.equal(f.dispatched.length, 1);
    assert.equal(Object.hasOwn(f.dispatched[0].options, 'serviceTier'), false);
    assert.equal(Object.hasOwn(f.dispatched[0].payload, 'service_tier'), false);
    assert.equal(f.speedReads, 0, 'private provider must not inherit the global speed setting');
    const prepared = await f.registered.get(PROVIDER).prepareCall(PROVIDER, MODEL);
    await consume(prepared.stream(f.options()));
    assert.equal(f.dispatched[1].options.serviceTier, expectedTier(mode));
    assert.equal(f.dispatched[1].payload.service_tier, expectedTier(mode));
    assert.equal(f.speedReads, 1);
    assert.equal(f.speed, mode); assert.equal(f.settingsWrites, 0);
    assert.equal(f.dispatched[0].payload.text.verbosity, 'high');
    assert.equal(f.dispatched[0].payload.reasoning.summary, 'concise');
    assert.equal(f.adapters[0].options.auth, f.adapters[1].options.auth);
    const { piProvider: chatProvider, ...chatProfile } = f.adapters[0].options.profiles().get(PROVIDER);
    const { piProvider: warmupProvider, ...warmupProfile } = f.adapters[1].options.profiles().get(PROVIDER);
    assert.deepEqual(warmupProfile, chatProfile, 'all non-provider profile controls stay identical');
    assert.equal(chatProvider, f.provider); assert.equal(warmupProvider, f.petWarmupProvider);
    assert.equal(f.registered.get(PROVIDER), f.completeAdapter);
    assert.notEqual(f.registered.get(PROVIDER), f.petWarmupAdapter);
  });
}

for (const method of ['stream', 'streamSimple']) {
  test(`private ${method} removes explicit, base-payload, compaction and callback tiers`, async () => {
    const f = fixture('ultrafast'); f.seedTier = 'ultrafast'; f.injectCompactionTier = true;
    const handle = await f.requestAuth.capture({ expectedAccountKey: f.accountKey });
    const original = Object.freeze({
      apiKey: handle, serviceTier: 'priority', temperature: 1,
      onPayload: payload => ({ ...payload, service_tier: 'priority', marker: 'callback kept' }),
    });
    await consume(f.petWarmupProvider[method]({ id: MODEL, contextWindow: 128000 }, { messages: [] }, original));
    const { options, payload } = f.dispatched[0];
    assert.equal(Object.hasOwn(options, 'serviceTier'), false);
    assert.equal(Object.hasOwn(f.compactionInputs[0], 'service_tier'), false);
    assert.equal(Object.hasOwn(payload, 'service_tier'), false);
    assert.equal(payload.marker, 'callback kept');
    assert.equal(Object.hasOwn(payload, 'temperature'), false);
    assert.equal(original.serviceTier, 'priority', 'caller-owned options must not be mutated');
    assert.equal(f.speed, 'ultrafast'); assert.equal(f.settingsWrites, 0);
  });
  for (const mode of ['standard', 'fast', 'ultrafast']) {
    test(`public ${method} ignores forged private speed flags under ${mode}`, async () => {
      const f = fixture(mode), handle = await f.requestAuth.capture();
      await consume(f.provider[method]({ id: MODEL }, { messages: [] }, {
        apiKey: handle, standardSpeedOnly: true, speedMode: 'standard',
      }));
      assert.equal(f.dispatched[0].payload.service_tier, expectedTier(mode));
      assert.equal(f.dispatched[0].options.serviceTier, expectedTier(mode));
    });
  }
}

test('concurrent private and ordinary/legacy calls remain isolated across live speed changes', async () => {
  const f = fixture('fast');
  const warmup = await f.privateAdapter.prepareCall(PROVIDER, MODEL, undefined, f.accountKey);
  const chat = await f.completeAdapter.prepareCall(PROVIDER, MODEL);
  const legacy = await f.registered.get('codex-accounts').prepareCall('codex-accounts', `default:${MODEL}`);
  f.speed = 'ultrafast';
  await Promise.all([
    consume(warmup.stream(f.options())),
    consume(chat.stream({ ...f.options(), standardSpeedOnly: true })),
    consume(legacy.stream({ ...f.options(), provider: 'codex-accounts', model: `default:${MODEL}`, standardSpeedOnly: true })),
  ]);
  assert.deepEqual(f.dispatched.map(row => row.payload.service_tier).sort(), [undefined, 'ultrafast', 'ultrafast'].sort());
  assert.equal(f.dispatched.filter(row => Object.hasOwn(row.payload, 'service_tier')).length, 2);
  assert.equal(f.speed, 'ultrafast'); assert.equal(f.settingsWrites, 0);
});

test('private account binding still rejects missing, malformed, mismatched and switched accounts', async () => {
  const f = fixture();
  for (const key of [undefined, '', 'not-a-hash']) {
    assert.throws(() => f.privateAdapter.prepareCall(PROVIDER, MODEL, undefined, key), /SUBSCRIPTION_WARMUP_BINDING_REQUIRED/);
  }
  assert.throws(() => f.privateAdapter.prepareCall('codex-accounts', MODEL, undefined, f.accountKey), /SUBSCRIPTION_WARMUP_BINDING_REQUIRED/);
  await assert.rejects(f.privateAdapter.prepareCall(PROVIDER, MODEL, undefined, '0'.repeat(16)), { code: 'AUTH_FAILED' });
  const prepared = await f.privateAdapter.prepareCall(PROVIDER, MODEL, undefined, f.accountKey);
  f.switchAccount();
  await assert.rejects(consume(prepared.stream(f.options())), { code: 'SUBSCRIPTION_AUTH_ACCOUNT_CHANGED' });
  assert.equal(f.dispatched.length, 0); assert.equal(f.refreshes, 0);
});

test('private stream retains lazy OAuth refresh rather than capturing or copying a bearer', async () => {
  const f = fixture();
  const prepared = await f.privateAdapter.prepareCall(PROVIDER, MODEL, undefined, f.accountKey);
  assert.equal(f.refreshes, 0);
  f.rotateBearer();
  await consume(prepared.stream(f.options()));
  assert.equal(f.refreshes, 1);
  assert.equal(f.dispatched[0].options.apiKey, 'synthetic-rotated-access-a');
  assert.equal(Object.hasOwn(f.dispatched[0].payload, 'service_tier'), false);
});

test('abort before dispatch or during lazy OAuth resolution never reaches the synthetic model transport', async () => {
  for (const phase of ['before-prepare', 'before-dispatch', 'during-auth']) {
    const f = fixture(), controller = new AbortController();
    if (phase === 'before-prepare') {
      controller.abort();
      await assert.rejects(f.privateAdapter.prepareCall(PROVIDER, MODEL, controller.signal, f.accountKey), { name: 'AbortError' });
    } else {
      const prepared = await f.privateAdapter.prepareCall(PROVIDER, MODEL, controller.signal, f.accountKey);
      if (phase === 'before-dispatch') controller.abort();
      else f.beforeResolve = options => { assert.equal(options.signal, controller.signal); controller.abort(); };
      await assert.rejects(consume(prepared.stream(f.options(controller.signal))), { name: 'AbortError' });
    }
    assert.equal(f.dispatched.length, 0, phase);
    assert.equal(f.refreshes, phase === 'during-auth' ? 1 : 0, phase);
  }
});
