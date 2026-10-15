import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverBoundAccounts, runBoundWarmup } from './multi-warmup-provider.js';

const RAW_A = 'private-account:A@example.test';
const RAW_B = 'private-account:B@example.test';
const EMAIL_A = 'alice-private@example.test';
const EMAIL_B = 'bob-private@example.test';
const BASE = 'gpt-5.3-codex';
const hash = value => createHash('sha256').update(value).digest('hex');
// Only the fake catalog produces ids; production may never synthesize a route.
const enumerated = (account, model = BASE) => `~account:${encodeURIComponent(account)}:${encodeURIComponent(model)}`;
const row = (key, account) => ({ key, account, isDefault: false });
const model = (key, base = BASE) => ({ provider: 'codex', id: enumerated(key, base), name: `UNSAFE ${EMAIL_A} ${RAW_A}` });
const microtask = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const controller = new AbortController();
  const f = {
    controller, signal: controller.signal, accountKey: hash(RAW_A).slice(0, 16), modelKey: hash(enumerated(RAW_A)),
    accounts: [row(RAW_A, EMAIL_A), row(RAW_B, EMAIL_B)],
    catalog: [model(RAW_A), model(RAW_B), { provider: 'codex', id: BASE, name: 'ordinary Pool route' }],
    calls: [], streams: [], resolved: [], usages: [],
    chunks: [{ type: 'text-delta', text: 'OK' }, { type: 'usage', usage: { inputTokens: 8, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } }],
  };
  f.bridge = { async fetch(request) {
    const body = await request.json();
    f.calls.push({ method: body.method, payload: body.payload, signal: request.signal });
    assert.equal(request.method, 'POST');
    assert.equal(new URL(request.url).pathname, '/api/subscriptions-auth.status');
    assert.equal(body.type, 'client-request');
    assert.equal(body.method, 'subscriptions-auth.status');
    assert.deepEqual(body.payload, {});
    const value = { providers: { codex: { busy: false, accounts: f.accounts } } };
    return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } });
  } };
  f.llm = {
    async listModels(...args) {
      assert.deepEqual(args, ['codex']); f.calls.push({ method: 'listModels' });
      return f.catalog;
    },
    async resolveModelInfo(provider, id, signal) {
      assert.equal(provider, 'codex'); assert.equal(signal, f.signal);
      f.resolved.push(id);
      return { provider, id, reasoning: { efforts: [{ id: 'high' }, { id: 'low' }, { id: 'medium' }], defaultEffort: 'high' } };
    },
    stream(request) {
      f.streams.push(request);
      return (async function* () { for (const chunk of f.chunks) yield chunk; })();
    },
  };
  for (const forbidden of ['fallbackPool', 'setDefault', 'activate', 'streamAccount']) {
    Object.defineProperty(f.llm, forbidden, { get() { assert.fail(`forbidden API: ${forbidden}`); } });
  }
  f.onUsage = (usage, metadata) => { f.usages.push({ usage, metadata }); };
  return f;
}

function safe(error, sent, code) {
  assert.equal(error.name, 'BoundWarmupError');
  assert.equal(error.requestNotSent, !sent);
  assert.match(error.code, /^BOUND_[A-Z_]+$/);
  assert.equal(error.message, error.code);
  if (code) assert.equal(error.code, code);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  for (const privateValue of [RAW_A, RAW_B, EMAIL_A, EMAIL_B, enumerated(RAW_A), 'SECRET_FAILURE']) {
    assert.equal(`${error.stack}\n${JSON.stringify(error)}`.includes(privateValue), false);
  }
  return true;
}
const unsent = (promise, code) => assert.rejects(promise, error => safe(error, false, code));
const sent = (promise, code) => assert.rejects(promise, error => safe(error, true, code));

function assertPrivate(value) {
  const text = JSON.stringify(value);
  for (const secret of [RAW_A, RAW_B, EMAIL_A, EMAIL_B, enumerated(RAW_A), '~account:', 'SECRET_FAILURE', 'RESPONSE_CANARY']) {
    assert.equal(text.includes(secret), false, secret);
  }
  for (const field of ['observedAt', 'receivedAt', 'fetchedAt', 'freshness', 'resetAt']) assert.equal(text.includes(`"${field}"`), false);
}

test('context invalidated during metadata preflight cannot reach stream', async () => {
  const f = fixture(); let current = true;
  const resolve = f.llm.resolveModelInfo;
  f.llm.resolveModelInfo = async (...args) => { const info = await resolve(...args); current = false; return info; };
  await unsent(runBoundWarmup({ ...f, isCurrent: () => current }), 'BOUND_CONTEXT_CHANGED');
  assert.equal(f.streams.length, 0);
});
test('bridge lifetime cancellation during metadata preflight prevents a late stream', async () => {
  const f = fixture(); let release;
  f.llm.resolveModelInfo = () => new Promise(resolve => { release = resolve; });
  const operation = runBoundWarmup({ ...f, isCurrent: () => true });
  while (!release) await microtask();
  f.controller.abort(); release({ reasoning: {} });
  await unsent(operation); assert.equal(f.streams.length, 0);
});
test('hash parameters cannot accept trailing newlines through dollar regex anchors', async () => {
  const f = fixture(); await unsent(runBoundWarmup({ ...f, accountKey: `${f.accountKey}\n` }));
  await unsent(runBoundWarmup({ ...f, modelKey: `${f.modelKey}\n` })); assert.equal(f.streams.length, 0);
});
test('discovery publishes only frozen hashes, safe base names and masked email; default flags are irrelevant', async () => {
  const f = fixture();
  f.accounts[1].isDefault = true;
  const result = await discoverBoundAccounts(f);
  assert.deepEqual(result, { provider: 'codex', binding: 'independent-entry', accounts: [
    { accountKey: f.accountKey, maskedEmail: 'a***@e***.test', models: [{ modelKey: f.modelKey, modelName: BASE }] },
    { accountKey: hash(RAW_B).slice(0, 16), maskedEmail: 'b***@e***.test',
      models: [{ modelKey: hash(enumerated(RAW_B)), modelName: BASE }] },
  ] });
  assertPrivate(result);
  assert.deepEqual(f.calls.map(call => call.method), ['subscriptions-auth.status', 'listModels']);
  assert.equal(f.resolved.length, 0); assert.equal(f.streams.length, 0);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.accounts) && Object.isFrozen(result.accounts[0].models[0]));
  assert.throws(() => { result.accounts[0].models[0].modelKey = 'tamper'; }, TypeError);
});

test('exact status/catalog intersection ignores unbound routes, foreign providers and ordinary Pool entries', async () => {
  const f = fixture();
  f.accounts = [f.accounts[0], row('no-independent-entry', 'not an email')];
  f.catalog.push(model('not-in-status'), { provider: 'openai-codex', id: enumerated(RAW_A, 'gpt-foreign') });
  const result = await discoverBoundAccounts(f);
  assert.equal(result.accounts.length, 1);
  assert.deepEqual(result.accounts[0].models, [{ modelKey: f.modelKey, modelName: BASE }]);
  f.catalog = [{ provider: 'codex', id: BASE }, { provider: 'codex', id: 'pool/default' }];
  assert.deepEqual((await discoverBoundAccounts(f)).accounts, []);
  await unsent(runBoundWarmup(f), 'BOUND_ROUTE_UNAVAILABLE');
  assert.equal(f.streams.length, 0);
});

test('canonical encoded reserved/unicode account keys are matched literally, not normalized or double-decoded', async () => {
  const f = fixture();
  const keys = ['colon:slash/a+b?x#y', '%41', '账号:é', 'name!()*\'value', '__proto__', 'constructor'];
  f.accounts = keys.map(key => row(key, 'opaque accountId'));
  f.catalog = keys.map(key => model(key));
  const result = await discoverBoundAccounts(f);
  assert.equal(result.accounts.length, keys.length);
  for (let i = 0; i < keys.length; i++) {
    assert.equal(result.accounts[i].accountKey, hash(keys[i]).slice(0, 16));
    assert.equal(result.accounts[i].models[0].modelKey, hash(enumerated(keys[i])));
    assert.equal(result.accounts[i].maskedEmail, null);
  }
  f.accounts = [row('A', 'id')]; f.catalog = [model('%41')];
  assert.deepEqual((await discoverBoundAccounts(f)).accounts, []);
});

test('email is never inferred from labels/keys and malformed/control/bidi identities remain unknown', async () => {
  for (const value of [undefined, null, 'accountId', 'alice@example.test\nSECRET_FAILURE', 'a@b..test', '\u202Ealice@example.test', 'alice@-host.test']) {
    const f = fixture();
    f.accounts[0] = { key: RAW_A, label: EMAIL_A, email: EMAIL_A, account: value };
    const result = await discoverBoundAccounts(f);
    assert.equal(result.accounts[0].maskedEmail, null);
    assertPrivate(result);
  }
});

test('safe model labels ignore aliases, suppress raw account strings and reject non-text/image models', async () => {
  const f = fixture();
  f.accounts = [row('private-secret-model', EMAIL_A)];
  f.catalog = [model('private-secret-model', 'private-secret-model'), model('private-secret-model', 'gpt-image-1'),
    { ...model('private-secret-model', 'gpt-audio'), inputModalities: ['image'] }, model('private-secret-model', 'gpt-5:mini')];
  const result = await discoverBoundAccounts(f);
  assert.deepEqual(result.accounts[0].models.map(item => item.modelName), ['Codex model', 'gpt-5:mini']);
  assert.equal(JSON.stringify(result).includes('private-secret-model'), false);
});

test('malicious independent encoding is rejected closed, with no partial capability or provider text leakage', async () => {
  const bad = [
    '~account::gpt-5', '~account:A:', '~account:A:gpt-5:extra', '~account:A',
    '~account:%:gpt-5', '~account:%GG:gpt-5', '~account:%u0041:gpt-5',
    '~account:%41:gpt-5', '~account:A:%67pt-5', '~account:A%3aB:gpt-5',
    '~account:A+Z:gpt-5', '~account:%C0%AF:gpt-5', '~account:%ED%A0%80:gpt-5',
    '~account:%F4%90%80%80:gpt-5', '~account:%E0%A4:gpt-5', '~account:%FF:gpt-5',
    '~account:%00:gpt-5', '~account:%0A:gpt-5', '~account:%7F:gpt-5',
    '~account:%E2%80%AE:gpt-5', '~account:%E2%81%A6:gpt-5', '~account:%E2%80%8B:gpt-5',
    '~account:%20A:gpt-5', '~account:A%20:gpt-5', '~account:A:gpt%205',
    '~account:A:gpt%2F5', '~account:A:%252F', '~account:A:a%40b.test',
    '~account:A:%00', '~account:A:%0A', '~account:A:%E2%80%AEgpt',
    '~account:A:~account%3AB%3Agpt-5', '~account:A:../gpt-5',
    `~account:${'a'.repeat(513)}:gpt-5`, `~account:A:${'g'.repeat(129)}`,
    `~account:${'a'.repeat(4100)}:gpt-5`, '~account:\ud800:gpt-5',
  ];
  for (const id of bad) {
    const f = fixture(); f.catalog.push({ provider: 'codex', id });
    await unsent(discoverBoundAccounts(f), 'BOUND_CATALOG_INVALID');
    await unsent(runBoundWarmup(f), 'BOUND_CATALOG_INVALID');
    assert.equal(f.streams.length, 0, id);
  }
});

test('ordinary or foreign namespaces never become synthesized independent routes', async () => {
  const f = fixture();
  f.catalog = ['~Account:A:gpt-5', '~account', 'codex/gpt-5', '~account%3AA%3Agpt-5', 'gpt-5'].map(id => ({ provider: 'codex', id }));
  f.catalog.push({ provider: 'other', id: '~account:%:malformed' });
  assert.deepEqual((await discoverBoundAccounts(f)).accounts, []);
  await unsent(runBoundWarmup(f), 'BOUND_ROUTE_UNAVAILABLE');
  assert.equal(f.streams.length, 0);
});

test('duplicate raw accounts, duplicate independent ids and malformed DTOs fail closed', async () => {
  const statusCases = [null, {}, 'not-array', [null], [row('', EMAIL_A)], [row(' space ', EMAIL_A)],
    [row('\u202Eevil', EMAIL_A)], [row('\ud800', EMAIL_A)], [row('x'.repeat(513), EMAIL_A)],
    [row(RAW_A, EMAIL_A), row(RAW_A, EMAIL_B)], Array.from({ length: 1001 }, (_, i) => row(`a${i}`, 'id'))];
  for (const accounts of statusCases) {
    const f = fixture(); f.accounts = accounts;
    await unsent(discoverBoundAccounts(f), 'BOUND_STATUS_INVALID');
    await unsent(runBoundWarmup(f), 'BOUND_STATUS_INVALID');
    assert.equal(f.streams.length, 0);
  }
  for (const catalog of [null, {}, [null], [{ provider: 'codex', id: null }],
    [model(RAW_A), model(RAW_A)], [{ ...model(RAW_A), inputModalities: 'text' }],
    Array.from({ length: 10001 }, () => ({ provider: 'codex', id: BASE }))]) {
    const f = fixture(); f.catalog = catalog;
    await unsent(discoverBoundAccounts(f), 'BOUND_CATALOG_INVALID');
    assert.equal(f.streams.length, 0);
  }
});

test('missing status route, forged RPC envelopes, bad JSON and transport failure expose only safe errors', async () => {
  for (const mode of ['404', '500', 'rpc-id', 'envelope', 'business', 'json', 'throw']) {
    const f = fixture();
    f.bridge.fetch = async request => {
      const body = await request.json();
      if (mode === '404' || mode === '500') return new Response('SECRET_FAILURE', { status: Number(mode) });
      if (mode === 'throw') throw new Error(`SECRET_FAILURE ${RAW_A}`);
      if (mode === 'json') return new Response('SECRET_FAILURE');
      return Response.json({ type: mode === 'envelope' ? 'wrong' : 'server-response',
        rpcId: mode === 'rpc-id' ? 'wrong' : body.rpcId,
        result: mode === 'business' ? { ok: false, error: { message: `SECRET_FAILURE ${RAW_A}` } }
          : { ok: true, value: { providers: { codex: { accounts: f.accounts } } } } });
    };
    await unsent(discoverBoundAccounts(f));
    await unsent(runBoundWarmup(f));
    assert.equal(f.streams.length, 0);
  }
});

test('run uses exact enumerated model once, lowest effort, no tools/history/fallback and safe return metadata', async () => {
  const f = fixture();
  f.chunks[0].text = 'RESPONSE_CANARY';
  const result = await runBoundWarmup(f);
  assert.deepEqual(result, { status: 'completed', provider: 'codex', accountKey: f.accountKey, modelKey: f.modelKey, modelName: BASE });
  assert.equal(f.streams.length, 1);
  assert.deepEqual(f.streams[0], { provider: 'codex', model: enumerated(RAW_A), tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply only OK.' }] }], signal: f.signal, reasoningEffort: 'low' });
  assert.deepEqual(f.resolved, [enumerated(RAW_A)]);
  assert.deepEqual(f.calls.map(call => call.method), ['subscriptions-auth.status', 'listModels', 'subscriptions-auth.status', 'listModels']);
  assertPrivate(result); assertPrivate(f.usages);
  assert.equal(Object.isFrozen(result), true);
});

test('multiple accounts and multiple models never share a binding hash or select the default/first route', async () => {
  const f = fixture();
  f.accounts[0].isDefault = true;
  f.catalog.push(model(RAW_B, 'gpt-5-mini'));
  const discovery = await discoverBoundAccounts(f);
  const selected = discovery.accounts[1].models[1];
  f.accountKey = discovery.accounts[1].accountKey; f.modelKey = selected.modelKey;
  const result = await runBoundWarmup(f);
  assert.equal(f.streams[0].model, enumerated(RAW_B, 'gpt-5-mini'));
  assert.equal(result.modelName, 'gpt-5-mini');
  assert.equal(f.usages[0].metadata.accountKey, f.accountKey);
  assert.notEqual(discovery.accounts[0].models[0].modelKey, discovery.accounts[1].models[0].modelKey);
});

test('caller cannot supply raw ids, truncated/uppercase hashes, wrong-account model hashes or prefixes', async () => {
  for (const [field, value] of [['accountKey', RAW_A], ['accountKey', 'a'.repeat(15)], ['accountKey', 'A'.repeat(16)],
    ['accountKey', null], ['modelKey', enumerated(RAW_A)], ['modelKey', 'a'.repeat(63)], ['modelKey', 'A'.repeat(64)], ['modelKey', null]]) {
    const f = fixture(); f[field] = value;
    await unsent(runBoundWarmup(f), 'BOUND_ARGUMENT_INVALID');
    assert.equal(f.streams.length, 0);
  }
  for (const [field, value] of [['accountKey', hash(RAW_B).slice(0, 16)], ['modelKey', hash(enumerated(RAW_B))], ['modelKey', '0'.repeat(64)]]) {
    const f = fixture(); f[field] = value;
    await unsent(runBoundWarmup(f), 'BOUND_ROUTE_UNAVAILABLE');
    assert.equal(f.streams.length, 0);
  }
});

test('run rediscovery rejects removal, model change and entry revocation after earlier discovery', async () => {
  for (const mode of ['account', 'model', 'ordinary', 'provider']) {
    const f = fixture(); await discoverBoundAccounts(f);
    if (mode === 'account') f.accounts = [f.accounts[1]];
    if (mode === 'model') f.catalog[0] = model(RAW_A, 'gpt-5-mini');
    if (mode === 'ordinary') f.catalog[0] = { provider: 'codex', id: BASE };
    if (mode === 'provider') f.catalog[0].provider = 'openai-codex';
    await unsent(runBoundWarmup(f), 'BOUND_ROUTE_UNAVAILABLE');
    assert.equal(f.streams.length, 0);
  }
});

test('final rediscovery catches membership/model revocation while resolveModelInfo awaited', async () => {
  for (const mode of ['account', 'model', 'duplicate', 'rpc']) {
    const f = fixture(), resolve = f.llm.resolveModelInfo;
    f.llm.resolveModelInfo = async (...args) => {
      const info = await resolve(...args);
      if (mode === 'account') f.accounts = [];
      if (mode === 'model') f.catalog = [{ provider: 'codex', id: BASE }];
      if (mode === 'duplicate') f.catalog.push(model(RAW_A));
      if (mode === 'rpc') f.bridge.fetch = async () => { throw new Error(`SECRET_FAILURE ${RAW_A}`); };
      return info;
    };
    await unsent(runBoundWarmup(f));
    assert.equal(f.streams.length, 0);
  }
});

test('reasoning is resolved on exact binding every run, rank-ordered not catalog/default ordered', async () => {
  for (const expected of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', undefined]) {
    const f = fixture();
    const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    f.llm.resolveModelInfo = async (provider, id, signal) => {
      assert.equal(signal, f.signal);
      return { provider, id, ...(expected ? { reasoning: { efforts: order.slice(order.indexOf(expected)).reverse().map(id => ({ id })) } } : {}) };
    };
    await runBoundWarmup(f);
    assert.equal(f.streams[0].reasoningEffort, expected);
    if (!expected) assert.equal(Object.hasOwn(f.streams[0], 'reasoningEffort'), false);
  }
});

test('unknown/malformed reasoning, wrong metadata route and missing required public API never send', async () => {
  const invalid = [null, {}, { provider: 'codex', id: BASE }, { provider: 'other', id: enumerated(RAW_A) },
    ...[null, {}, { efforts: null }, { efforts: [{ id: 'extreme' }] }, { efforts: [{ id: 'low' }, { id: 'low' }] },
      { efforts: [], defaultEffort: 'high' }, { efforts: [{ id: 'low' }], defaultEffort: 'high' }].map(reasoning =>
      ({ provider: 'codex', id: enumerated(RAW_A), reasoning }))];
  for (const info of invalid) {
    const f = fixture(); f.llm.resolveModelInfo = async () => info;
    await unsent(runBoundWarmup(f), 'BOUND_REASONING_INVALID');
    assert.equal(f.streams.length, 0);
  }
  for (const target of ['listModels', 'resolveModelInfo', 'stream']) {
    const f = fixture(); delete f.llm[target];
    await unsent(runBoundWarmup(f), 'BOUND_API_UNAVAILABLE');
  }
  const f = fixture(); delete f.bridge.fetch;
  await unsent(discoverBoundAccounts(f), 'BOUND_API_UNAVAILABLE');
  await unsent(runBoundWarmup(f), 'BOUND_API_UNAVAILABLE');
});

test('missing/invalid cancellation and malformed arguments fail closed', async () => {
  for (const options of [undefined, null, {}, { signal: {} }, { signal: 'signal' }]) {
    await unsent(discoverBoundAccounts(options));
    await unsent(runBoundWarmup(options));
  }
  const f = fixture(); f.onUsage = 'not-function';
  await unsent(runBoundWarmup(f), 'BOUND_ARGUMENT_INVALID');
});

test('throwing option getters stay inside sanitized public errors and accounting callback is captured once', async () => {
  const malicious = { get signal() { throw new Error(`SECRET_FAILURE ${RAW_A}`); } };
  await unsent(discoverBoundAccounts(malicious));
  await unsent(runBoundWarmup(malicious));
  const f = fixture(); let reads = 0, counted = 0;
  Object.defineProperty(f, 'onUsage', { get() {
    reads++; if (reads > 1) throw new Error(`SECRET_FAILURE ${RAW_A}`);
    return () => { counted++; };
  } });
  await runBoundWarmup(f);
  assert.equal(reads, 1); assert.equal(counted, 1);
});

test('pre-aborted signal never calls any API; abort reason is not exposed', async () => {
  const f = fixture(); f.controller.abort(new Error(`SECRET_FAILURE ${RAW_A}`));
  await unsent(discoverBoundAccounts(f), 'BOUND_ABORTED');
  await unsent(runBoundWarmup(f), 'BOUND_ABORTED');
  assert.equal(f.calls.length, 0); assert.equal(f.streams.length, 0);
});

test('abort during status, catalog, resolution or final rediscovery remains unsent', async () => {
  for (const stage of ['status', 'catalog', 'resolve', 'final']) {
    const f = fixture();
    if (stage === 'status') {
      const original = f.bridge.fetch;
      f.bridge.fetch = async request => { const response = await original(request); f.controller.abort(EMAIL_A); return response; };
    }
    if (stage === 'catalog') {
      const original = f.llm.listModels;
      f.llm.listModels = async (...args) => { const list = await original(...args); f.controller.abort(RAW_A); return list; };
    }
    if (stage === 'resolve') {
      const original = f.llm.resolveModelInfo;
      f.llm.resolveModelInfo = async (...args) => { const info = await original(...args); f.controller.abort(RAW_A); return info; };
    }
    if (stage === 'final') {
      const original = f.llm.listModels; let calls = 0;
      f.llm.listModels = async (...args) => { const list = await original(...args); if (++calls === 2) f.controller.abort(RAW_A); return list; };
    }
    await unsent(runBoundWarmup(f), 'BOUND_ABORTED');
    assert.equal(f.streams.length, 0);
  }
});

test('same caller timeout cancels hung catalog without a replacement signal or late send', async () => {
  const f = fixture(); f.signal = AbortSignal.timeout(25);
  let release;
  f.llm.listModels = () => new Promise(resolve => { release = resolve; });
  const keepAlive = setTimeout(() => {}, 2000);
  try { await unsent(runBoundWarmup(f), 'BOUND_ABORTED'); }
  finally { clearTimeout(keepAlive); }
  // Request.signal is a dependent signal; observe after abort dispatch settles.
  await microtask(); assert.equal(f.signal.aborted, true); assert.equal(f.calls[0].signal.aborted, true);
  release(f.catalog); await microtask();
  assert.equal(f.streams.length, 0); assert.equal(f.resolved.length, 0);
});

test('late rejection from cancelled discovery is handled and cannot escape or trigger a retry', async () => {
  const f = fixture(); let rejectLate;
  f.llm.listModels = () => new Promise((_, reject) => { rejectLate = reject; f.controller.abort(RAW_A); });
  await unsent(discoverBoundAccounts(f), 'BOUND_ABORTED');
  rejectLate(new Error(`SECRET_FAILURE ${RAW_A}`)); await microtask();
  assert.equal(f.streams.length, 0);
});

test('every synchronous stream/iterator failure crosses irreversible boundary and overrides upstream retry hints', async () => {
  for (const mode of ['throw', 'iterate', 'not-iterable', 'iterator-throw', 'next-throw', 'null-step']) {
    const f = fixture(); let calls = 0;
    const error = Object.assign(new Error(`SECRET_FAILURE ${RAW_A}`), { requestNotSent: true });
    f.llm.stream = () => {
      calls++;
      if (mode === 'throw') throw error;
      if (mode === 'iterate') return (async function* () { throw error; })();
      if (mode === 'not-iterable') return null;
      if (mode === 'iterator-throw') return { [Symbol.asyncIterator]() { throw error; } };
      return { [Symbol.asyncIterator]() { return { next() { if (mode === 'next-throw') throw error; return null; } }; } };
    };
    await sent(runBoundWarmup(f));
    assert.equal(calls, 1); assert.equal(f.usages.length, 0);
  }
});

test('only stop plus nonempty text succeeds; tools, malformed or post-finish chunks cannot be accepted', async () => {
  const text = { type: 'text-delta', text: 'OK' }, stop = { type: 'finish', reason: { kind: 'stop' } };
  const cases = [[], [text], [stop], [{ type: 'text-delta', text: ' \n' }, stop],
    [{ type: 'text-delta', text: 1 }, stop], [null], [{ type: 'error', message: EMAIL_A }],
    [text, { type: 'finish', reason: { kind: 'length' } }], [text, { type: 'finish', reason: { kind: 'error', error: EMAIL_A } }],
    [text, { type: 'finish', reason: { kind: 'aborted' } }], [text, { type: 'finish', reason: { kind: 'tool-calls' } }],
    [text, { type: 'tool-call-delta', name: 'not-allowed', argumentsDelta: EMAIL_A }, stop],
    [text, stop, text], [text, stop, stop]];
  for (const chunks of cases) {
    const f = fixture(); f.chunks = chunks;
    await sent(runBoundWarmup(f));
    assert.equal(f.streams.length, 1);
  }
});

test('finish stop does not hide a later iterator error or timeout', async () => {
  const f = fixture(); let calls = 0;
  f.llm.stream = () => { calls++; return (async function* () {
    yield { type: 'text-delta', text: 'OK' }; yield { type: 'finish', reason: { kind: 'stop' } };
    throw new Error(`SECRET_FAILURE ${RAW_A}`);
  })(); };
  await sent(runBoundWarmup(f), 'BOUND_STREAM_FAILED');
  assert.equal(calls, 1);
});

test('final cumulative usage is counted once and stripped to numeric fields, not text/ids/freshness', async () => {
  const f = fixture();
  f.chunks = [{ type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } },
    { type: 'text-delta', text: 'RESPONSE_CANARY' },
    { type: 'usage', usage: { inputTokens: 8, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4,
      reasoningTokens: 1, totalTokens: 17, text: 'RESPONSE_CANARY', account: RAW_A, model: enumerated(RAW_A), fetchedAt: Date.now() } },
    { type: 'finish', reason: { kind: 'stop' } }];
  await runBoundWarmup(f);
  assert.equal(f.usages.length, 1);
  assert.deepEqual(f.usages[0].usage, { inputTokens: 8, outputTokens: 2, totalTokens: 17, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 1 });
  assertPrivate(f.usages);
  assert.equal(Object.isFrozen(f.usages[0].usage), true);
});

test('failed and aborted streams still account delivered final usage exactly once, and never retry', async () => {
  for (const mode of ['throw', 'finish', 'abort']) {
    const f = fixture(); let calls = 0;
    f.llm.stream = () => { calls++; return (async function* () {
      yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 1 } };
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } };
      if (mode === 'abort') { f.controller.abort(`SECRET_FAILURE ${RAW_A}`); return; }
      if (mode === 'throw') throw Object.assign(new Error(`SECRET_FAILURE ${RAW_A}`), { requestNotSent: true });
      yield { type: 'finish', reason: { kind: 'error', error: EMAIL_A } };
    })(); };
    await sent(runBoundWarmup(f));
    assert.equal(calls, 1); assert.equal(f.usages.length, 1);
    assert.deepEqual(f.usages[0].usage, { inputTokens: 8, outputTokens: 2 });
    assertPrivate(f.usages);
  }
});

test('malformed numeric usage fails closed but previously valid billed usage is still reported once', async () => {
  for (const usage of [null, {}, { inputTokens: -1, outputTokens: 1 }, { inputTokens: 1.5, outputTokens: 0 },
    { inputTokens: '8', outputTokens: 1 }, { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 },
    { inputTokens: 1, outputTokens: Infinity }, { inputTokens: 1, outputTokens: 1, cacheReadTokens: NaN },
    { inputTokens: 1, outputTokens: 1, totalTokens: 'SECRET_FAILURE' }]) {
    const f = fixture(); f.chunks = [{ type: 'usage', usage: { inputTokens: 2, outputTokens: 0 } }, { type: 'usage', usage }];
    await sent(runBoundWarmup(f), 'BOUND_USAGE_INVALID');
    assert.equal(f.usages.length, 1);
    assert.deepEqual(f.usages[0].usage, { inputTokens: 2, outputTokens: 0 });
  }
});

test('sync/async accounting failures cannot expose original errors or advertise an unsent request', async () => {
  for (const asynchronous of [false, true]) {
    const f = fixture(); let calls = 0;
    const error = Object.assign(new Error(`SECRET_FAILURE ${RAW_A}`), { requestNotSent: true });
    f.onUsage = () => { calls++; if (asynchronous) return Promise.reject(error); throw error; };
    await sent(runBoundWarmup(f), 'BOUND_USAGE_ACCOUNTING_FAILED');
    assert.equal(calls, 1); assert.equal(f.streams.length, 1);
  }
});

test('accounting can cancel the operation without losing its exactly-once terminal invocation', async () => {
  const f = fixture(); let calls = 0;
  f.onUsage = () => { calls++; f.controller.abort(EMAIL_A); return Promise.reject(new Error(`SECRET_FAILURE ${RAW_A}`)); };
  await sent(runBoundWarmup(f), 'BOUND_ABORTED');
  await microtask(); assert.equal(calls, 1);
});

test('no usage means no fabricated token report; missing callback is allowed', async () => {
  const f = fixture(); f.chunks = [f.chunks[0], f.chunks[2]];
  await runBoundWarmup(f); assert.equal(f.usages.length, 0);
  const g = fixture(); delete g.onUsage;
  await runBoundWarmup(g); assert.equal(g.usages.length, 0);
});

test('same timeout signal reaches resolve and stream; hung iterator/cleanup cannot defeat cancellation', async () => {
  const f = fixture(); f.signal = AbortSignal.timeout(40); let returned = 0, streamSignal;
  f.llm.stream = request => {
    f.streams.push(request); streamSignal = request.signal;
    let first = true;
    return { [Symbol.asyncIterator]() { return {
      next() { if (first) { first = false; return Promise.resolve({ done: false, value: { type: 'usage', usage: { inputTokens: 8, outputTokens: 0 } } }); }
        return new Promise(() => {}); },
      return() { returned++; return new Promise(() => {}); },
    }; } };
  };
  const keepAlive = setTimeout(() => {}, 2000);
  try { await sent(runBoundWarmup(f), 'BOUND_ABORTED'); }
  finally { clearTimeout(keepAlive); }
  assert.equal(streamSignal, f.signal); assert.equal(streamSignal.aborted, true);
  assert.equal(f.streams.length, 1); assert.equal(returned, 1); assert.equal(f.usages.length, 1);
});

test('post-boundary provider revocation failure never tries another account or Pool route', async () => {
  const f = fixture(); let calls = 0;
  f.llm.stream = request => { calls++; assert.equal(request.model, enumerated(RAW_A));
    return (async function* () { throw new Error(`Account route unavailable: codex/${RAW_A}/${BASE}`); })(); };
  await sent(runBoundWarmup(f), 'BOUND_STREAM_FAILED');
  assert.equal(calls, 1);
});

test('private Temp persistence receives only public output, never real accounts, files or LLM', async () => {
  const tempParent = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(tempParent, 'dsh-bound-provider-test-'));
  const target = path.join(root, 'public-result.json');
  try {
    const f = fixture();
    const discovery = await discoverBoundAccounts(f), result = await runBoundWarmup(f);
    const report = { discovery, result, usage: f.usages };
    await writeFile(target, JSON.stringify(report), { encoding: 'utf8', flag: 'wx' });
    const roundtrip = JSON.parse(await readFile(target, 'utf8'));
    assertPrivate(roundtrip); assert.deepEqual(roundtrip, report);
  } finally {
    // Verify the absolute deletion target is our own mkdtemp child, never a user path.
    assert.equal(path.dirname(path.resolve(root)), tempParent);
    assert.ok(path.basename(root).startsWith('dsh-bound-provider-test-'));
    await rm(root, { recursive: true, force: true });
  }
});
