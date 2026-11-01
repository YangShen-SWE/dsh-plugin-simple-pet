import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubscriptionRotation, rotationBinding, rotationHistory } from './subscription-rotation.js';

// These tests import only the engine and its pure policy. No OAuth, real vault,
// persisted configuration, credential file, provider SDK or network is involved.
const NOW = 1800000000000;
const URL = 'https://chatgpt.com/backend-api/codex/responses';
const MODEL = 'synthetic-codex';
const copy = value => JSON.parse(JSON.stringify(value));
const ZERO = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const usage = overrides => ({ planType: 'plus', fetchedAt: NOW,
  rateLimits: [{ id: 'codex', windows: [{ remainingPercent: 80, windowSeconds: 18000, resetsAt: NOW / 1000 + 600 }] }], ...overrides });
const limited = { error: { type: 'usage_limit_reached', message: 'Synthetic official quota rejection' } };
const coded = code => Object.assign(new Error(code), { code });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, { count = 2, enabled = true, strategy = 'balanced', reservePercent = 10, defaults = false } = {}) {
  const rows = Array.from({ length: count }, (_, i) => ({ id: `synthetic-local-${i}`,
    credential: { type: 'oauth', accountId: `synthetic-budget-${i}` }, active: i === 0 }));
  const refs = () => rows.map(row => {
    const { accountKey, accountGeneration } = rotationBinding(row);
    return { accountKey, accountGeneration };
  });
  const state = { epoch: 0, time: NOW, config: defaults ? undefined : { enabled, strategy, reservePercent, accounts: refs() },
    selections: [], selected: [], fetches: [], prepares: [], streams: [], quotas: [], catalogs: [], bound: [], records: [], next: 0,
    reports: new Map(), models: new Map(), catalogStatuses: new Map(), writes: [], failCAS: false };
  const active = () => rows.find(row => row.active);
  const select = index => { rows.forEach((row, i) => { row.active = i === index; }); state.epoch++; };
  const vault = {
    warmupSnapshot: async () => copy(rows),
    selectionEpoch: () => state.epoch,
    forAccount(id, identity) {
      const row = rows.find(row => row.id === id && row.credential.accountId === identity);
      assert.ok(row, 'context must be bound to an exact synthetic account identity');
      return { id, identity };
    },
    async selectRotation({ from, to, validate }) {
      state.selections.push(copy({ from, to }));
      await state.beforeCAS?.({ from, to });
      const current = rotationBinding(active());
      if (state.failCAS || current.accountGeneration !== from.accountGeneration || state.epoch !== from.selectionEpoch) throw coded('ROTATION_ACCOUNT_CHANGED');
      const index = rows.findIndex(row => row.id === to.id && row.credential.accountId === to.identity && rotationBinding(row).accountGeneration === to.accountGeneration);
      if (index < 0) throw coded('ROTATION_ACCOUNT_CHANGED');
      if (validate() !== true) throw coded('ROTATION_CONFIGURATION_CHANGED');
      select(index);
      return state.epoch;
    },
  };
  const engine = createSubscriptionRotation({ vault,
    createContext(target) {
      assert.match(target.id, /^synthetic-local-/);
      return {
        quota: { async read(options) {
          assert.equal(options.force, true);
          state.quotas.push(target.id);
          await state.onQuota?.(target, options);
          return state.reports.has(target.id) ? state.reports.get(target.id) : usage();
        } },
        catalog: {
          async refresh(options) { state.catalogs.push(target.id); await state.onCatalog?.(target, options); },
          status: () => state.catalogStatuses.get(target.id) ?? { source: 'online', refresh: 'ok' },
          getModels: () => (state.models.get(target.id) ?? [MODEL]).map(id => ({ id })),
        },
      };
    },
    readConfig: () => state.config,
    writeConfig: async config => { state.writes.push(copy(config)); state.config = copy(config); },
    onSelected: async options => { state.selected.push(active().id); await state.onSelected?.(options); },
    now: () => state.time,
  });
  t.after(() => engine.dispose());
  const agent = { session: { append: (type, data) => state.records.push({ type, data: copy(data) }) } };
  const next = () => { state.next++; return 'synthetic-next'; };
  function adapterFor(scenario = {}) {
    return {
      async prepareCall(provider, model, signal) {
        const binding = engine.binding();
        state.prepares.push({ provider, model, binding: binding && copy(binding) });
        return { provider, model,
          async *stream(options) {
            state.streams.push({ options, binding: engine.binding() });
            const request = engine.requestOptions({ fetch: async (input, init) => {
              // This is the ONLY fetch implementation used; it never calls global fetch.
              state.fetches.push({ input: String(input), init, binding: copy(engine.binding()) });
              await scenario.onFetch?.();
              if (scenario.networkError) throw new TypeError('Synthetic network failure');
              return new Response(scenario.bodyText ?? JSON.stringify(scenario.body ?? limited), { status: scenario.status ?? 429 });
            } });
            if (state.config?.enabled) {
              assert.equal(request.transport, 'sse');
              assert.equal(request.maxRetries, 0);
            }
            let error;
            try {
              await request.fetch(scenario.url ?? URL, { method: scenario.method ?? 'POST', body: '{"model":"synthetic-codex"}' });
              if (scenario.secondDispatch) await request.fetch(URL, { method: 'POST' });
            } catch (caught) { error = caught; }
            if (scenario.throwTransport && error) throw error;
            for (const chunk of scenario.chunks ?? [{ type: 'usage', usage: ZERO }]) yield copy(chunk);
            yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message: error?.message ?? 'Synthetic pi-ai provider rejected HTTP response' } } };
          },
        };
      },
    };
  }
  const wrap = scenario => engine.wrapAdapter(adapterFor(scenario), (binding, signal, op) => {
    state.bound.push(copy(binding));
    return op();
  });
  async function prepare(scenario = {}, signal) { return wrap(scenario).prepareCall('openai-codex', MODEL, signal); }
  async function consume(call, signal, messages = []) {
    const chunks = [];
    for await (const chunk of call.stream({ provider: 'openai-codex', model: MODEL, signal, messages })) chunks.push(chunk);
    const failure = chunks.findLast(chunk => chunk.type === 'finish').reason.failure;
    // The real host clones/detaches failures; preserving object identity here would hide bugs.
    return { chunks, failure: copy(failure) };
  }
  async function failure(scenario = {}, signal) { return consume(await prepare(scenario, signal), signal); }
  const handle = (failure, extra = {}) => engine.handle({ failure: copy(failure), provider: 'openai-codex', agent, turn: 1, step: 0, ...extra }, next);
  const noSwitch = () => { assert.equal(state.selections.length, 0); assert.equal(state.selected.length, 0); assert.equal(active().id, rows[0].id); };
  return { engine, state, rows, refs, vault, active, select, agent, prepare, consume, failure, handle, noSwitch, wrap };
}

for (const chunks of [[], [{ type: 'usage', usage: {} }], [{ type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }]]) test('absent or incomplete usage can never prove a zero-output quota rejection', async t => {
  const f = fixture(t);
  assert.equal(await f.handle((await f.failure({ chunks })).failure), undefined);
  f.noSwitch(); assert.equal(f.state.next, 0);
});

test('legacy alias retry records preserve the failed request provider required by the host', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.handle((await f.failure()).failure, { provider: 'codex-accounts' }), { kind: 'retry' });
  assert.equal(f.state.records[0].data.provider, 'codex-accounts');
});

test('defaults are disabled: a real wrapped quota failure never selects or retries', async t => {
  const f = fixture(t, { defaults: true });
  const { failure } = await f.failure();
  assert.equal(failure.code, 'PI_AI_ERROR');
  assert.equal(failure.requestId, undefined);
  assert.equal(await f.handle(failure), 'synthetic-next');
  assert.equal((await f.engine.status()).config.enabled, false);
  assert.equal(f.state.fetches.length, 1);
  f.noSwitch();
});

test('enabled explicit official quota failure survives JSON host clone, CAS-selects and returns retry only', async t => {
  const f = fixture(t);
  const { failure, chunks } = await f.failure();
  assert.deepEqual(chunks[0], { type: 'usage', usage: ZERO });
  assert.match(failure.requestId, /^pet-rotation-/);
  assert.deepEqual(await f.handle(failure), { kind: 'retry' });
  assert.equal(f.active().id, f.rows[1].id);
  assert.equal(f.state.epoch, 1);
  assert.deepEqual(f.state.selected, [f.rows[1].id]);
  assert.deepEqual(f.state.quotas, [f.rows[1].id]);
  assert.deepEqual(f.state.catalogs, [f.rows[1].id]);
  assert.equal(f.state.fetches.length, 1, 'handle must not dispatch a hidden retry');
  assert.equal(f.state.fetches[0].input, URL);
  assert.equal(f.state.fetches[0].init.method, 'POST');
  assert.equal(f.state.fetches[0].init.redirect, 'error');
  assert.equal(f.state.fetches[0].binding.accountGeneration, rotationBinding(f.rows[0]).accountGeneration);
  assert.deepEqual(f.state.records.map(row => row.type), ['llm/retry', 'llm/retry-started']);
  assert.equal(f.state.records[0].data.delayMs, 0);
  assert.equal(f.state.records[0].data.retryId, f.state.records[1].data.retryId);
  assert.equal((await f.engine.status()).lastEvent.code, 'ROTATION_CONTINUING');
  assert.equal(f.state.next, 0);
});

for (const [name, scenario] of [
  ['generic 429', { body: { error: { type: 'rate_limit_exceeded' } } }],
  ['401 even with quota-looking body', { status: 401 }],
  ['network error', { networkError: true }],
  ['unknown error', { body: { error: { type: 'future_error' } } }],
  ['non-JSON response', { bodyText: 'usage_limit_reached' }],
  ['message-only quota text', { body: { error: { message: 'usage_limit_reached' } } }],
  ['oversized quota body', { body: { ...limited, padding: 'x'.repeat(17000) } }],
]) test(`${name} cannot authorize a cross-account continuation`, async t => {
  const f = fixture(t);
  assert.equal(await f.handle((await f.failure(scenario)).failure), undefined);
  f.noSwitch();
  assert.equal(f.state.quotas.length, 0);
});

test('official usage_limit_reached error.code is accepted as well as error.type', async t => {
  const f = fixture(t);
  const { failure } = await f.failure({ body: { error: { code: 'usage_limit_reached' } } });
  assert.deepEqual(await f.handle(failure), { kind: 'retry' });
});

for (const [name, chunks] of [
  ['positive input usage', [{ type: 'usage', usage: { ...ZERO, inputTokens: 1 } }]],
  ['positive output usage', [{ type: 'usage', usage: { ...ZERO, outputTokens: 1 } }]],
  ['positive reasoning usage', [{ type: 'usage', usage: { ...ZERO, reasoningTokens: 1 } }]],
  ['unknown usage field', [{ type: 'usage', usage: { ...ZERO, futureTokens: 0 } }]],
  ['text block even empty', [{ type: 'block', block: { type: 'text', text: '' } }, { type: 'usage', usage: ZERO }]],
  ['tool block', [{ type: 'block', block: { type: 'tool-call', id: 'synthetic-tool', name: 'noop', arguments: {} } }]],
  ['reasoning block', [{ type: 'block', block: { type: 'reasoning', text: 'synthetic thought' } }]],
  ['unknown chunk', [{ type: 'future-provider-chunk' }]],
]) test(`${name} makes the failed attempt unsafe to rotate`, async t => {
  const f = fixture(t);
  assert.equal(await f.handle((await f.failure({ chunks })).failure), undefined);
  f.noSwitch();
});

for (const [name, setup] of [
  ['no authorized alternative', f => { f.state.config.accounts = f.refs().slice(0, 1); }],
  ['explicitly disabled quota', f => { f.state.reports.set(f.rows[1].id, usage({ spendControlReached: true })); }],
  ['unknown quota', f => { f.state.reports.set(f.rows[1].id, {}); }],
  ['stale quota', f => { f.state.reports.set(f.rows[1].id, usage({ fetchedAt: NOW - 120001 })); }],
  ['reserve boundary', f => { f.state.config.reservePercent = 80; }],
  ['unknown plan in tier strategy', f => { f.state.config.strategy = 'low-tier-first'; f.state.reports.set(f.rows[1].id, usage({ planType: 'future_plan' })); }],
  ['same model unsupported', f => { f.state.models.set(f.rows[1].id, ['different-model']); }],
  ['offline model catalogue', f => { f.state.catalogStatuses.set(f.rows[1].id, { source: 'cache', refresh: 'ok' }); }],
  ['failed model refresh', f => { f.state.onCatalog = () => { throw new Error('Synthetic model catalogue failure'); }; }],
  ['quota read failure', f => { f.state.onQuota = () => { throw new Error('Synthetic quota read failure'); }; }],
  ['same-budget alias', f => { f.rows[1].credential.accountId = f.rows[0].credential.accountId; f.state.config.accounts = f.refs(); }],
]) test(`${name} leaves selection unchanged`, async t => {
  const f = fixture(t);
  setup(f);
  assert.equal(await f.handle((await f.failure()).failure), undefined);
  f.noSwitch();
  assert.equal((await f.engine.status()).lastEvent.code, 'ROTATION_NO_ELIGIBLE_ACCOUNT');
});

test('unknown plan remains usable for a non-tier policy without inventing a tier', async t => {
  const f = fixture(t, { strategy: 'most-remaining' });
  f.state.reports.set(f.rows[1].id, usage({ planType: 'future_plan' }));
  assert.deepEqual(await f.handle((await f.failure()).failure), { kind: 'retry' });
});

test('reserve is strict: remaining above the configured reserve is eligible', async t => {
  const f = fixture(t, { reservePercent: 79 });
  assert.deepEqual(await f.handle((await f.failure()).failure), { kind: 'retry' });
});

for (const [name, mutate] of [
  ['configuration revoked', f => { f.state.config.enabled = false; }],
  ['configuration changed', f => { f.state.config.reservePercent++; }],
  ['active account changed', f => { f.select(1); }],
  ['A-B-A selection epoch changed', f => { f.select(1); f.select(0); }],
  ['credential generation changed under same local id', f => { f.rows[0].credential.accountId = 'synthetic-replacement'; }],
  ['proof expired', f => { f.state.time += 120001; }],
  ['disposed', f => { f.engine.dispose(); }],
]) test(`${name} invalidates the captured failure proof`, async t => {
  const f = fixture(t);
  const { failure } = await f.failure();
  mutate(f);
  await f.handle(failure);
  assert.equal(f.state.selections.length, 0);
  assert.equal(f.state.selected.length, 0);
  assert.equal(f.state.fetches.length, 1);
});

test('cancelled host request cannot select', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  const { failure } = await f.failure({}, controller.signal);
  controller.abort();
  assert.equal(await f.handle(failure, { signal: controller.signal }), undefined);
  f.noSwitch();
});

for (const [name, mutate] of [
  ['configuration revoked during quota read', f => { f.state.config.enabled = false; }],
  ['cancelled during quota read', (f, controller) => controller.abort()],
  ['disposed during quota read', f => f.engine.dispose()],
  ['selection changed during candidate read (CAS)', f => { f.select(1); f.select(0); }],
]) test(`${name} never reports a successful continuation`, async t => {
  const f = fixture(t);
  const controller = new AbortController();
  const { failure } = await f.failure({}, controller.signal);
  f.state.onQuota = () => mutate(f, controller);
  assert.equal(await f.handle(failure, { signal: controller.signal }), undefined);
  assert.equal(f.state.selected.length, 0);
  assert.equal(f.state.records.filter(row => row.type === 'llm/retry-started').length, 0);
});

test('synthetic selection CAS rejection fails closed without onSelected or retry-started', async t => {
  const f = fixture(t);
  f.state.failCAS = true;
  assert.equal(await f.handle((await f.failure()).failure), undefined);
  assert.equal(f.state.selections.length, 1);
  assert.equal(f.active().id, f.rows[0].id);
  assert.equal(f.state.selected.length, 0);
  assert.equal(f.state.records.filter(row => row.type === 'llm/retry-started').length, 0);
  assert.equal((await f.engine.status()).lastEvent.code, 'ROTATION_ACCOUNT_CHANGED');
});

for (const [name, mutate] of [
  ['binding changes in onSelected', f => { f.select(0); }],
  ['A-B-A epoch changes in onSelected', f => { f.select(0); f.select(1); }],
  ['configuration revoked in onSelected', f => { f.state.config.enabled = false; }],
  ['onSelected cancellation', (f, controller) => controller.abort()],
  ['onSelected disposal', f => f.engine.dispose()],
]) test(`${name} prevents retry after CAS`, async t => {
  const f = fixture(t);
  const controller = new AbortController();
  const { failure } = await f.failure({}, controller.signal);
  f.state.onSelected = () => mutate(f, controller);
  assert.equal(await f.handle(failure, { signal: controller.signal }), undefined);
  assert.equal(f.state.selections.length, 1);
  assert.equal(f.state.records.filter(row => row.type === 'llm/retry-started').length, 0);
});

for (const [name, scenario, expected] of [
  ['different POST target', { url: 'https://example.invalid/responses', throwTransport: true }, 'ROTATION_ROUTE_CHANGED'],
  ['GET method', { method: 'GET', throwTransport: true }, 'ROTATION_ROUTE_CHANGED'],
  ['SDK second dispatch', { secondDispatch: true, throwTransport: true }, 'ROTATION_SECOND_DISPATCH_FORBIDDEN'],
]) test(`${name} is rejected before any extra provider dispatch`, async t => {
  const f = fixture(t);
  await assert.rejects(f.failure(scenario), { code: expected });
  assert.equal(f.state.fetches.length, scenario.secondDispatch ? 1 : 0);
  f.noSwitch();
});

for (const [name, mutate] of [
  ['configuration revoked', f => { f.state.config.enabled = false; }],
  ['A-B-A account selection', f => { f.select(1); f.select(0); }],
]) test(`${name} after prepare prevents model fetch`, async t => {
  const f = fixture(t);
  const call = await f.prepare({ throwTransport: true });
  mutate(f);
  await assert.rejects(f.consume(call), { code: 'ROTATION_ACCOUNT_CHANGED' });
  assert.equal(f.state.fetches.length, 0);
  f.noSwitch();
});

test('cancellation after prepare prevents provider fetch', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  const prepared = await f.prepare({ throwTransport: true }, controller.signal);
  controller.abort();
  await assert.rejects(f.consume(prepared, controller.signal), { name: 'AbortError' });
  assert.equal(f.state.fetches.length, 0);
  f.noSwitch();
});

test('disposing the engine invalidates an unconsumed prepared call before provider fetch', async t => {
  const f = fixture(t);
  const prepared = await f.prepare({ throwTransport: true });
  f.engine.dispose();
  // A disposed engine must not let an old prepared operation escape its lifetime.
  // The exact cancellation code is deliberately not prescribed by this contract.
  try { await f.consume(prepared); } catch (error) { assert.ok(error instanceof Error); }
  assert.equal(f.state.fetches.length, 0, 'disposed prepared call must not dispatch the provider');
  assert.equal(f.state.selections.length, 0);
});

test('concurrent failures cannot both select, and a busy-consumed proof cannot be replayed', async t => {
  const f = fixture(t, { count: 3 });
  const first = (await f.failure()).failure;
  const second = (await f.failure()).failure;
  const entered = deferred(), release = deferred();
  f.state.onQuota = async () => { entered.resolve(); await release.promise; };
  const pending = f.handle(first);
  await entered.promise;
  assert.equal((await f.engine.status()).busy, true);
  try {
    assert.equal(await f.handle(second), undefined);
  } finally { release.resolve(); }
  assert.deepEqual(await pending, { kind: 'retry' });
  assert.equal(await f.handle(second), undefined);
  assert.equal(f.state.selections.length, 1);
});

test('failure proof is one-shot and each continuation requires a newly prepared account-bound call', async t => {
  const f = fixture(t, { count: 3 });
  const prepared = await f.prepare();
  const first = (await f.consume(prepared)).failure;
  assert.deepEqual(await f.handle(first), { kind: 'retry' });
  assert.equal(await f.handle(first), undefined);
  assert.throws(() => prepared.stream({ messages: [] }), { code: 'ROTATION_PREPARED_CALL_USED' });
  const second = (await f.failure()).failure;
  assert.notEqual(second.requestId, first.requestId);
  assert.deepEqual(await f.handle(second), { kind: 'retry' });
  assert.equal(f.state.selections.length, 2);
  assert.equal(new Set(f.state.fetches.map(row => row.binding.budgetSubject)).size, 2);
  assert.equal(f.state.prepares[1].binding.selectionEpoch, 1);
  assert.equal(await f.handle((await f.failure()).failure), undefined, 'must not return to either exhausted budget subject');
});

test('one host step uses at most eight distinct budget subjects including original, new step resets history', async t => {
  const f = fixture(t, { count: 10 });
  const subjects = new Set([rotationBinding(f.active()).budgetSubject]);
  for (let i = 0; i < 7; i++) {
    assert.deepEqual(await f.handle((await f.failure()).failure), { kind: 'retry' });
    subjects.add(rotationBinding(f.active()).budgetSubject);
  }
  assert.equal(subjects.size, 8);
  assert.equal(await f.handle((await f.failure()).failure), undefined);
  assert.equal(f.state.selections.length, 7);
  assert.equal((await f.engine.status()).lastEvent.code, 'ROTATION_ATTEMPT_LIMIT');
  assert.deepEqual(await f.handle((await f.failure()).failure, { step: 1 }), { kind: 'retry' });
  assert.equal(f.state.selections.length, 8);
});

test('unknown owned marker stops fallback; unrelated failures delegate and invalid host context never selects', async t => {
  const f = fixture(t);
  assert.equal(await f.handle({ code: 'PI_AI_ERROR' }), 'synthetic-next');
  assert.equal(await f.handle({ code: 'PI_AI_ERROR', requestId: 'pet-rotation-forged' }), undefined);
  for (const extra of [{ provider: 'other' }, { agent: {} }, { turn: 1.5 }, { step: -Infinity }]) {
    assert.equal(await f.handle((await f.failure()).failure, extra), undefined);
  }
  f.noSwitch();
});

test('a saturated proof cache still owns unsafe failures and never falls back to old retry', async t => {
  const f = fixture(t);
  for (let i = 0; i < 256; i++) await f.failure();
  const { failure } = await f.failure({ chunks: [{ type: 'block', block: { type: 'text', text: 'synthetic' } }] });
  assert.match(failure.requestId, /^pet-rotation-/);
  assert.equal(await f.handle(failure), undefined);
  assert.equal(f.state.next, 0); f.noSwitch();
});

test('config revoked or signal cancelled at the atomic select boundary cannot change accounts', async t => {
  for (const reason of ['config', 'abort']) {
    const f = fixture(t), ac = new AbortController();
    f.state.beforeCAS = async () => { if (reason === 'config') f.state.config.enabled = false; else ac.abort(); };
    assert.equal(await f.handle((await f.failure({}, ac.signal)).failure, { signal: ac.signal }), undefined);
    assert.equal(f.active().id, f.rows[0].id); assert.equal(f.state.selected.length, 0);
  }
});

test('enablement requires acknowledgement, two current bindings, and stores only public references', async t => {
  const f = fixture(t, { defaults: true });
  const config = { enabled: true, strategy: 'balanced', reservePercent: 10, accounts: f.refs() };
  await assert.rejects(f.engine.update(config), { code: 'ROTATION_ACKNOWLEDGEMENT_REQUIRED' });
  await assert.rejects(f.engine.update({ ...config, acknowledged: true, accounts: config.accounts.slice(0, 1) }), { code: 'ROTATION_TWO_ACCOUNTS_REQUIRED' });
  await f.engine.update({ ...config, acknowledged: true });
  assert.deepEqual(f.state.writes, [config]);
  assert.equal(JSON.stringify(f.state.writes).includes('synthetic-budget'), false);
  await f.engine.update({ ...config, enabled: false });
  assert.equal((await f.engine.status()).config.enabled, false);
  const stale = copy(config); stale.accounts[1].accountGeneration = 'f'.repeat(64);
  await assert.rejects(f.engine.update({ ...stale, acknowledged: true }), { code: 'ROTATION_ACCOUNT_CHANGED' });
});

test('wrapper strips cross-account replay IDs on a copy and preserves the supported checkpoint', async t => {
  const f = fixture(t);
  const messages = [{ role: 'user', content: 'synthetic' }, { role: 'assistant', source: {
    provider: 'openai-codex', replayState: { response: { id: 'synthetic-native-id', codexCompactionV1: { opaque: 'synthetic-checkpoint' } }, signature: 'synthetic-native-signature' },
  } }];
  const before = copy(messages);
  await f.consume(await f.prepare(), undefined, messages);
  assert.deepEqual(messages, before);
  assert.deepEqual(f.state.streams[0].options.messages, rotationHistory(messages));
  assert.deepEqual(f.state.streams[0].options.messages[1].source.replayState, { response: { codexCompactionV1: { opaque: 'synthetic-checkpoint' } } });
});
