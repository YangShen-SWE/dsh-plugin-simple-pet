import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectAccountModelCatalogue, mergeAccountModels, fetchAccountModels, modelIdOK, validModelSettings, MODEL_CATALOGUE_PROFILE, MODEL_CATALOGUE_CLIENT_VERSION, MODEL_CATALOGUE_LIMITS } from './model-catalogue.js';
import { createOfficialDriver } from './official-driver.js';

// All catalogue responses and OAuth values below are synthetic. No real fetch,
// credential service, plugin runtime, OAuth flow or model request is used.
const builtin = () => [{ id: 'codex-mini', name: 'Codex mini', provider: 'openai-codex',
  input: ['text', 'image'], contextWindow: 200000, maxTokens: 8192, reasoning: true,
  thinkingLevelMap: { off: 'none', low: 'low', high: 'high' },
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } }];
const row = (extra = {}) => ({ slug: 'gpt-6.1-sol', display_name: 'GPT 6.1 Sol', visibility: 'list',
  context_window: 400000, input_modalities: ['text', 'image'],
  supported_reasoning_levels: [{ effort: 'none' }, { effort: 'low' }, { effort: 'high' }], ...extra });
const merge = (...rows) => mergeAccountModels({ models: rows }, builtin());
const privateText = 'PRIVATE_MOCK_ACCESS PRIVATE_MOCK_ACCOUNT PRIVATE_MOCK_REFRESH';
const request = extra => fetchAccountModels({ auth: 'PRIVATE_MOCK_ACCESS', accountId: 'PRIVATE_MOCK_ACCOUNT',
  fetchImpl: async () => Response.json({ models: [row()] }), ...extra });
function fakeBody(chunks) {
  let cancelled = 0, reads = 0;
  return { response: { ok: true, status: 200, headers: new Headers(), body: { getReader() {
    let i = 0; return { async read() { reads++; return i < chunks.length ? { value: chunks[i++], done: false } : { done: true }; },
      async cancel() { cancelled++; } };
  } } }, get cancelled() { return cancelled; }, get reads() { return reads; } };
}

test('unknown model never inherits image or reasoning capabilities missing from account metadata',()=>{
 const [value]=merge(row({input_modalities:undefined,supported_reasoning_levels:undefined}));
 assert.deepEqual(value.input,['text']);assert.equal(value.reasoning,false);assert.equal(value.thinkingLevelMap,undefined);assert.equal(value.cost,undefined);
});
test('merge admits remote gpt-6.1-sol without mutating builtins or remote rows', () => {
  const b = builtin(), raw = { models: [row()] }, before = structuredClone({ b, raw });
  const [model] = mergeAccountModels(raw, b);
  assert.equal(model.id, 'gpt-6.1-sol'); assert.equal(model.name, 'GPT 6.1 Sol');
  assert.equal(model.contextWindow, 400000); assert.deepEqual(model.input, ['text', 'image']);
  assert.deepEqual({ b, raw }, before);
});
test('new remote model does not invent zero/free pricing or inherit another model price', () => {
  const [model] = merge(row());
  assert.notDeepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 'unknown account-catalogue pricing must not be presented as free');
  assert.notDeepEqual(model.cost, builtin()[0].cost, 'a new slug has no verified static price');
});
test('remote permission/billing fields are not promoted into trusted model metadata', () => {
  const [model] = merge(row({ allowed: true, entitled: true, permission: 'granted', subscription: 'paid', cost: { input: -1 }, apiKey: privateText }));
  for (const key of ['allowed', 'entitled', 'permission', 'subscription', 'apiKey']) assert.equal(Object.hasOwn(model, key), false);
  assert(!JSON.stringify(model).includes(privateText));
});
for (const id of ['', ' gpt-6.1-sol', 'gpt-6.1-sol ', '../gpt', 'x/y', 'a:b', 'a\nb', 'x'.repeat(129), null, 12]) {
  test(`model slug validation rejects ${JSON.stringify(id)}`, () => {
    assert.equal(modelIdOK(id), false);
    assert.throws(() => merge(row({ slug: id })), /MODEL_CATALOG_EMPTY/);
  });
}
test('merge drops duplicate IDs, hidden/missing visibility and reserved entries', () => {
  const models = merge(row(), row({ display_name: 'duplicate' }), row({ slug: 'hidden', visibility: 'hide' }),
    row({ slug: 'missing', visibility: undefined }), row({ slug: 'codex-reserve' }));
  assert.deepEqual(models.map(m => m.id), ['gpt-6.1-sol']); assert.equal(models[0].name, 'GPT 6.1 Sol');
});
test('target diagnostics are independent of the 128-row omitted display cap', () => {
  const hidden = Array.from({length: 128}, (_, i) => row({slug:`hidden-${i}`,visibility:'hide'}));
  const report = inspectAccountModelCatalogue({models:[...hidden,row({visibility:'hide'})]},builtin());
  assert.equal(report.omitted.length,128);assert(!report.omitted.some(item=>item.id==='gpt-6.1-sol'));
  assert.deepEqual(report.targetModel,{received:true,accepted:false,reason:'not-visible'});
  const accepted=inspectAccountModelCatalogue({models:[...hidden,row({visibility:'hide'}),row()]},builtin());
  assert.deepEqual(accepted.targetModel,{received:true,accepted:true,reason:null});
  assert.deepEqual(inspectAccountModelCatalogue({models:[row({slug:'other-model'})]},builtin()).targetModel,{received:false,accepted:false,reason:null});
  assert(!JSON.stringify(report.targetModel).includes('PRIVATE'));
});
test('invalid first duplicate does not suppress a later valid model', () => {
  assert.equal(merge(row({ context_window: 0 }), row())[0].contextWindow, 400000);
});
for (const context of [0, -1, 1.5, 10000001, '400000']) {
  test(`new model never guesses unknown/invalid context ${JSON.stringify(context)}`, () => {
    assert.throws(() => merge(row({ context_window: context })), /MODEL_CATALOG_EMPTY/);
  });
}
test('online model with omitted optional context remains discoverable with an explicit conservative LOCAL budget', () => {
  for (const context of [undefined, null]) {
    const report = inspectAccountModelCatalogue({models:[row({context_window:context})]}, builtin());
    const model = report.models[0];
    assert.equal(model.id, 'gpt-6.1-sol'); assert.equal(model.contextWindow, 8192);
    assert.equal(model.maxTokens, 4096); assert.equal(model.cost, undefined);
    assert.deepEqual(report.omitted, []);
    assert.deepEqual(report.capabilityGaps, [{id:'gpt-6.1-sol',reason:'context-limit-unreported',localContextLimit:8192}]);
  }
});
test('fallback requires an online visible model and a compatible SDK template; never fabricates a slug', () => {
  assert.deepEqual(inspectAccountModelCatalogue({models:[]},builtin()).models, []);
  assert.throws(()=>mergeAccountModels({models:[row({context_window:undefined})]},[]),/MODEL_CATALOG_EMPTY/);
  assert.throws(()=>merge(row({visibility:'hide',context_window:undefined})),/MODEL_CATALOG_EMPTY/);
  const base=[{...builtin()[0],contextWindow:2048,maxTokens:8000,maxContextWindow:1000000}];
  const [model]=mergeAccountModels({models:[row({context_window:undefined})]},base);
  assert.equal(model.contextWindow,2048);assert.equal(model.maxTokens,1024);assert.equal(model.maxContextWindow,undefined);
});
test('known model may retain verified static context and pricing', () => {
  const [model] = merge(row({ slug: 'codex-mini', context_window: undefined }));
  assert.equal(model.contextWindow, 200000); assert.deepEqual(model.cost, builtin()[0].cost);
});
test('max_context_window accepted when primary context is missing', () => {
  assert.equal(merge(row({ context_window: undefined, max_context_window: 123456 }))[0].contextWindow, 123456);
});
test('reasoning none maps to off and unsupported known levels are explicitly null', () => {
  const [model] = merge(row());
  assert.equal(model.thinkingLevelMap.off, 'none'); assert.equal(model.thinkingLevelMap.low, 'low');
  assert.equal(model.thinkingLevelMap.high, 'high'); assert.equal(model.thinkingLevelMap.max, null);
});
test('unrecognised reasoning disables unknown efforts without concealing the returned model', () => {
  for (const supported_reasoning_levels of [[{ effort: 'unlimited' }], [{}]]) {
    const [model] = merge(row({ supported_reasoning_levels }));
    assert.equal(model.id, 'gpt-6.1-sol');
    assert(Object.values(model.thinkingLevelMap).every(value => value === null));
    assert.equal(model.reasoning, false);
  }
});
test('empty reasoning list disables reasoning and does not inherit template levels', () => {
  const [model] = merge(row({ supported_reasoning_levels: [] }));
  assert.equal(model.reasoning, false); assert(Object.values(model.thinkingLevelMap).every(v => v === null));
});
test('input modalities are allowlisted and image-only models are not assumed text-capable', () => {
  assert.deepEqual(merge(row({ input_modalities: ['text', 'audio', 'image', 'text'] }))[0].input, ['text', 'image']);
  assert.throws(() => merge(row({ input_modalities: ['image'] })), /MODEL_CATALOG_EMPTY/);
});
test('unsafe display labels fall back to slug', () => {
  for (const display_name of ['bad\nlabel', 'bad\u202elabel', 'x'.repeat(161)]) assert.equal(merge(row({ display_name }))[0].name, 'gpt-6.1-sol');
});
test('malformed, oversized, and empty remote catalogues fail closed', () => {
  for (const raw of [null, [], {}, { models: {} }, { models: Array(1001).fill(row()) }]) assert.throws(() => mergeAccountModels(raw, builtin()), /MODEL_CATALOG_INVALID/);
  assert.throws(() => mergeAccountModels({ models: [] }, builtin()), /MODEL_CATALOG_EMPTY/);
});
test('settings schema rejects extra fields, duplicate/invalid IDs, and unsupported effort', () => {
  const settings = { enabled: ['gpt-6.1-sol'], defaultModel: 'gpt-6.1-sol', reasoningEffort: 'high' };
  assert.equal(validModelSettings(settings), true);
  for (const patch of [{ enabled: ['a', 'a'] }, { enabled: ['../bad'] }, { enabled: Array.from({ length: 129 }, (_, i) => `m-${i}`) },
    { reasoningEffort: 'none' }, { defaultModel: 'a:b' }, { permission: true }]) assert.equal(Boolean(validModelSettings({ ...settings, ...patch })), false);
});

test('catalogue request uses only fixed GET endpoint, required account headers, and redirect:error', async () => {
  const controller = new AbortController(), signal = controller.signal; let call;
  const result = await request({ signal, etag: '"mock-v1"', fetchImpl: async (url, init) => { call = { url, init }; return Response.json({ models: [row()] }, { headers: { etag: '"mock-v2"' } }); } });
  assert.equal(call.url, 'https://chatgpt.com/backend-api/codex/models?client_version=0.163.0');
  assert.equal(MODEL_CATALOGUE_CLIENT_VERSION, '0.163.0'); assert(Object.isFrozen(MODEL_CATALOGUE_PROFILE));
  assert.equal(call.init.method, 'GET'); assert.equal(call.init.redirect, 'error'); assert(call.init.signal instanceof AbortSignal);
  assert.equal(call.init.signal.aborted, false); controller.abort(); assert.equal(call.init.signal.aborted, true);
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get('authorization'), 'Bearer PRIVATE_MOCK_ACCESS'); assert.equal(headers.get('chatgpt-account-id'), 'PRIVATE_MOCK_ACCOUNT');
  assert.equal(headers.get('accept'), 'application/json'); assert.equal(headers.get('originator'), 'pi'); assert.equal(headers.get('version'), '0.163.0');
  assert.equal(headers.get('OpenAI-Beta'), null); assert.equal(headers.get('session_id'), null); assert.equal(headers.get('conversation_id'), null);
  assert.match(headers.get('user-agent'), /^dsh-plugin-simple-pet\//); assert.equal(headers.get('if-none-match'), '"mock-v1"');
  assert.equal(call.init.body, undefined); assert.equal(result.etag, '"mock-v2"'); assert.equal(result.raw.models[0].slug, 'gpt-6.1-sol');
});
test('304 result does not attempt to parse a body', async () => {
  assert.deepEqual(await request({ fetchImpl: async () => new Response(null, { status: 304 }) }), { notModified: true });
});
for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'AUTH_REQUIRED'], [429, 'UNAVAILABLE'], [500, 'UNAVAILABLE'], [302, 'UNAVAILABLE']]) {
  test(`HTTP ${status} catalogue failure never leaks response body`, async () => {
    await assert.rejects(request({ fetchImpl: async () => new Response(privateText, { status }) }), e => e.message === `MODEL_CATALOG_${code}` && !String(e).includes('PRIVATE'));
  });
}
test('transport exceptions do not leak upstream sensitive text', async () => {
  await assert.rejects(request({ fetchImpl: async () => { throw new Error(privateText); } }), e => !String(e).includes('PRIVATE') && /^MODEL_CATALOG_/.test(e.message));
});
test('valid catalogue with large instruction metadata is not mistaken for an incompatible model schema', async () => {
  // Synthetic application of the public legacy serializer: the instruction
  // template is also emitted as base_instructions. No real account response.
  const instructions = 'Synthetic instructions. '.repeat(16000);
  const raw = { models: [row({ base_instructions: instructions, model_messages: { instructions_template: instructions } })] };
  const text = JSON.stringify(raw); assert(Buffer.byteLength(text) > 524288);
  for (const declared of [false, true]) {
    const bytes = Buffer.from(text), f = fakeBody([bytes.subarray(0, 350000), bytes.subarray(350000)]);
    if (declared) f.response.headers = new Headers({ 'content-length': String(bytes.length) });
    const result = await request({ fetchImpl: async () => f.response });
    assert.equal(mergeAccountModels(result.raw, builtin())[0].id, 'gpt-6.1-sol');
    assert.equal(f.cancelled, 1);
  }
});
test('limits remain frozen local resource bounds, not model permissions', () => {
  assert(Object.isFrozen(MODEL_CATALOGUE_LIMITS));
  assert.deepEqual(MODEL_CATALOGUE_LIMITS, { maxBytes: 8388608, maxModels: 1000, timeoutMs: 10000 });
});
test('content-length above the byte limit is rejected without reading and releases its reader', async () => {
  const f = fakeBody([Buffer.from('{}')]);
  f.response.headers = new Headers({ 'content-length': String(MODEL_CATALOGUE_LIMITS.maxBytes + 1) });
  await assert.rejects(request({ fetchImpl: async () => f.response }), /MODEL_CATALOG_TOO_LARGE/);
  assert.equal(f.reads, 0); assert.equal(f.cancelled, 1);
  await assert.rejects(request({ fetchImpl: async () => new Response(null) }), /MODEL_CATALOG_INVALID/);
});
test('streamed byte limit is enforced without content-length and cancels reader', async () => {
  const f = fakeBody([new Uint8Array(MODEL_CATALOGUE_LIMITS.maxBytes), new Uint8Array(1)]);
  await assert.rejects(request({ fetchImpl: async () => f.response }), /MODEL_CATALOG_TOO_LARGE/);
  assert.equal(f.cancelled, 1);
});
test('exact byte boundary accepted, larger UTF8 payload rejected based on bytes not characters', async () => {
  const count = Math.floor((MODEL_CATALOGUE_LIMITS.maxBytes - 20) / 3);
  const text = JSON.stringify({ text: '汉'.repeat(count) });
  assert(text.length < MODEL_CATALOGUE_LIMITS.maxBytes); assert(Buffer.byteLength(text) < MODEL_CATALOGUE_LIMITS.maxBytes);
  const exact = text + ' '.repeat(MODEL_CATALOGUE_LIMITS.maxBytes - Buffer.byteLength(text));
  assert.equal((await request({ fetchImpl: async () => new Response(exact) })).raw.text.length, count);
  await assert.rejects(request({ fetchImpl: async () => new Response(exact + '汉') }), /MODEL_CATALOG_TOO_LARGE/);
});
test('many tiny chunks are joined without corrupting a valid catalogue', async () => {
  const bytes = Buffer.from(JSON.stringify({ models: [row({ base_instructions: 'mock'.repeat(20000) })] }));
  const f = fakeBody(Array.from({ length: Math.ceil(bytes.length / 7) }, (_, i) => bytes.subarray(i * 7, i * 7 + 7)));
  assert.equal(mergeAccountModels((await request({ fetchImpl: async () => f.response })).raw, builtin())[0].id, 'gpt-6.1-sol');
  assert.equal(f.cancelled, 1);
});
test('UTF8 decoding is fatal and malformed JSON cannot expose raw contents', async () => {
  for (const bytes of [new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]), Buffer.from(privateText)]) {
    await assert.rejects(request({ fetchImpl: async () => new Response(bytes) }), e => e.message === 'MODEL_CATALOG_INVALID');
  }
});
test('multibyte UTF8 may span response chunks; reader is cancelled after success', async () => {
  const bytes = Buffer.from(JSON.stringify({ text: '汉' })), split = bytes.indexOf(0xe6) + 1;
  const f = fakeBody([bytes.subarray(0, split), bytes.subarray(split)]);
  assert.equal((await request({ fetchImpl: async () => f.response })).raw.text, '汉'); assert.equal(f.cancelled, 1);
});
test('oversized or control-bearing ETag is never returned as a replayable header', async () => {
  for (const etag of ['x'.repeat(257), 'bad\u007ftag']) {
    const f = fakeBody([Buffer.from('{}')]); f.response.headers = { get: key => key === 'etag' ? etag : null };
    assert.equal((await request({ fetchImpl: async () => f.response })).etag, null);
  }
});
test('already aborted signal prevents fetch and does not expose custom abort reason', async () => {
  const controller = new AbortController(); controller.abort(new Error(privateText)); let fetched = 0;
  await assert.rejects(request({ signal: controller.signal, fetchImpl: async () => { fetched++; return Response.json({}); } }), e => !String(e).includes('PRIVATE') && e.message === 'MODEL_CATALOG_UNAVAILABLE');
  assert.equal(fetched, 0);
});

test('cancellation arriving with final reader completion cannot produce a successful catalogue', async () => {
  const controller = new AbortController(); let reads = 0, cancelled = 0;
  const response = { ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({
    async read() { if (reads++ === 0) return { done: false, value: Buffer.from('{}') }; controller.abort(); return { done: true }; },
    async cancel() { cancelled++; },
  }) } };
  await assert.rejects(request({ signal: controller.signal, fetchImpl: async () => response }), e => e.message === 'MODEL_CATALOG_UNAVAILABLE');
  assert.equal(cancelled, 1);
});
test('reader failures release reader and do not expose private upstream text', async () => {
  let cancelled = 0;
  const response = { ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({
    async read() { throw Error(privateText); }, async cancel() { cancelled++; },
  }) } };
  await assert.rejects(request({ fetchImpl: async () => response }), e => !String(e).includes('PRIVATE') && /^MODEL_CATALOG_/.test(e.message));
  assert.equal(cancelled, 1);
});

test('cancelling an unresolved fetch settles without waiting for upstream', { timeout: 2000 }, async () => {
  const controller = new AbortController(); let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const operation = request({ signal: controller.signal, fetchImpl: () => { entered(); return new Promise(() => {}); } });
  await started; controller.abort(new Error(privateText));
  await assert.rejects(operation, e => e.message === 'MODEL_CATALOG_UNAVAILABLE' && !String(e).includes('PRIVATE'));
});
test('cancelling a stalled body releases it without waiting for stalled cancel promise', { timeout: 2000 }, async () => {
  const controller = new AbortController(); let entered, cancelled = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const response = { ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({
    read() { entered(); return new Promise(() => {}); }, cancel() { cancelled++; return new Promise(() => {}); },
  }) } };
  const operation = request({ signal: controller.signal, fetchImpl: async () => response });
  await started; controller.abort(new Error(privateText));
  await assert.rejects(operation, e => e.message === 'MODEL_CATALOG_UNAVAILABLE'); assert.equal(cancelled, 1);
});
test('invalid auth/account headers fail locally without calling fetch', async () => {
  for (const patch of [{ auth: '' }, { accountId: '' }, { auth: 'secret\r\nInjected: true' }, { accountId: 'account\u007f' }]) {
    let calls = 0;
    await assert.rejects(request({ ...patch, fetchImpl: async () => { calls++; throw Error(privateText); } }), /MODEL_CATALOG_AUTH_REQUIRED/);
    assert.equal(calls, 0);
  }
});
test('unsafe request ETag is not copied into outbound headers', async () => {
  for (const etag of ['x'.repeat(257), 'private\r\nInjected: true']) {
    let headers;
    await request({ etag, fetchImpl: async (_url, init) => { headers = new Headers(init.headers); return Response.json({}); } });
    assert.equal(headers.has('if-none-match'), false);
  }
});

async function mockOfficial(overrides = {}) {
  let profileGetter, authCalls = 0, fetchCalls = 0; const maps = [];
  const grant = { type: 'oauth', access: 'PRIVATE_MOCK_ACCESS', accountId: 'PRIVATE_MOCK_ACCOUNT' };
  class Adapter {
    constructor(options) { profileGetter = options.profiles; }
    listModels() { const map = profileGetter(); maps.push(map); return map.get('openai-codex').piProvider.getModels().map(m => ({ id: m.id, name: m.name })); }
    resolveModel(_provider, id) { return { id }; }
    prepareCall() { throw new Error('MODEL_EXECUTION_FORBIDDEN'); }
  }
  const driver = await createOfficialDriver({ credentials: { read: async () => grant }, runtime: {
    fetchImpl: async (...args) => { fetchCalls++; return overrides.fetch ? overrides.fetch(...args) : Response.json({ models: [row()] }, { headers: { etag: '"v1"' } }); },
  } }, async () => ({ createModels: () => ({ setProvider() {}, getAuth: async () => { authCalls++; return overrides.auth ?? { source: 'OAuth', auth: { apiKey: grant.access } }; } }),
    openaiCodexProvider: () => ({ id: 'openai-codex', auth: { oauth: { isSubscription: true } }, getModels: builtin }), PiAiAdapter: Adapter }));
  return { driver, maps, get authCalls() { return authCalls; }, get fetchCalls() { return fetchCalls; } };
}
test('official driver listing is offline until explicit refresh; refresh replaces profile Map identity', async () => {
  const f = await mockOfficial(); assert.equal((await f.driver.listModels())[0].id, 'codex-mini');
  assert.equal(f.authCalls, 0); assert.equal(f.fetchCalls, 0);
  await f.driver.refreshModels(); assert.equal((await f.driver.listModels())[0].id, 'gpt-6.1-sol');
  assert.notEqual(f.maps[0], f.maps[1]); assert.equal(f.driver.catalogStatus().source, 'account-catalog');
});
test('official driver 304 preserves prior model list/revision and sends prior ETag', async () => {
  let requests = 0, tag;
  const f = await mockOfficial({ fetch: async (_url, init) => { tag = new Headers(init.headers).get('if-none-match'); return ++requests === 1 ? Response.json({ models: [row()] }, { headers: { etag: '"v1"' } }) : new Response(null, { status: 304 }); } });
  await f.driver.refreshModels(); const first = f.driver.catalogStatus(); await f.driver.refreshModels();
  assert.equal(tag, '"v1"'); assert.equal(f.driver.catalogStatus().revision, first.revision); assert.equal((await f.driver.listModels())[0].id, 'gpt-6.1-sol');
});
test('initial 304 is not a valid fresh remote catalogue', async () => {
  const f = await mockOfficial({ fetch: async () => new Response(null, { status: 304 }) });
  await assert.rejects(f.driver.refreshModels(), /MODEL_CATALOG_INVALID/); assert.equal(f.driver.catalogStatus().status, 'stale');
});
test('failed refresh keeps last catalogue but marks it stale without leaking secrets', async () => {
  let broken = false; const f = await mockOfficial({ fetch: async () => { if (broken) throw new Error(privateText); return Response.json({ models: [row()] }); } });
  await f.driver.refreshModels(); broken = true;
  await assert.rejects(f.driver.refreshModels(), e => e.message === 'MODEL_CATALOG_UNAVAILABLE');
  assert.equal((await f.driver.listModels())[0].id, 'gpt-6.1-sol'); assert.equal(f.driver.catalogStatus().status, 'stale');
  assert(!JSON.stringify(f.driver.catalogStatus()).includes('PRIVATE'));
});
test('a too-large refresh keeps the last successful catalogue and ETag with an explicit stale error', async () => {
  let calls = 0, tag;
  const f = await mockOfficial({ fetch: async (_url, init) => {
    tag = new Headers(init.headers).get('if-none-match');
    calls++;
    if (calls === 1) return Response.json({ models: [row()] }, { headers: { etag: '"v1"' } });
    if (calls === 2) return new Response('{}', { headers: { etag: '"must-not-save"', 'content-length': String(MODEL_CATALOGUE_LIMITS.maxBytes + 1) } });
    return new Response(null, { status: 304 });
  } });
  await f.driver.refreshModels(); const first = f.driver.catalogStatus();
  await assert.rejects(f.driver.refreshModels(undefined, { force: true }), /MODEL_CATALOG_TOO_LARGE/);
  assert.equal(tag, null);
  assert.equal(f.driver.catalogStatus().revision, first.revision);
  assert.equal(f.driver.catalogStatus().error, 'MODEL_CATALOG_TOO_LARGE');
  assert.equal(f.driver.catalogStatus().status, 'stale');
  assert.equal((await f.driver.listModels())[0].id, 'gpt-6.1-sol');
  await f.driver.refreshModels();
  assert.equal(tag, '"v1"'); assert.equal(f.driver.catalogStatus().status, 'ready');
  assert.equal(f.driver.catalogStatus().revision, first.revision); assert.equal(calls, 3);
  assert(!JSON.stringify(f.driver.catalogStatus()).includes('PRIVATE'));
});
test('official catalogue rejects non-OAuth resolution without network', async () => {
  const f = await mockOfficial({ auth: { source: 'API Key', auth: { apiKey: 'PRIVATE_MOCK_ACCESS' } } });
  await assert.rejects(f.driver.refreshModels(), /MODEL_CATALOG_/); assert.equal(f.fetchCalls, 0);
});
