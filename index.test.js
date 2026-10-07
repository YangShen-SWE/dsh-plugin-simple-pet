import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { apply, codexQuotaRefreshSeconds } from './index.js';

test('quota refresh interval defaults to 5 seconds and accepts only bounded integer seconds', () => {
  for (const seconds of [undefined, null, true, false, '5', 0, -1, 1.5, 3601, Infinity, NaN, {}, []]) {
    assert.equal(codexQuotaRefreshSeconds({ codexQuotaRefreshSeconds: seconds }), 5);
  }
  assert.equal(codexQuotaRefreshSeconds(null), 5);
  for (const seconds of [1, 5, 12, 60, 3600]) assert.equal(codexQuotaRefreshSeconds({ codexQuotaRefreshSeconds: seconds }), seconds);
});

for (const scenario of ['normal', 'corrupt', 'drain', 'web', 'duplicate', 'startup', 'periodic']) test(`automatic warm-up integration: ${scenario}`, async (t) => {
  const damaged = scenario === 'corrupt';
  const previous = process.env.LOCALAPPDATA, previousProfile = process.env.DSH_PET_PROFILE;
  process.env.DSH_PET_PROFILE = scenario === 'web' ? 'web' : 'desktop';
  const root = join(import.meta.dirname, 'work', `test-warmup-${randomUUID()}`);
  process.env.LOCALAPPDATA = root;
  const data = join(root, 'DshSimpleDesktopPet'); await mkdir(data, { recursive: true });
  const date = new Date(); date.setSeconds(0, 0); const now = date.getTime();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  await writeFile(join(data, 'settings.json'), '\uFEFF' + JSON.stringify({ codexWarmupDaily: !['startup', 'periodic'].includes(scenario), codexWarmupStartup: scenario === 'startup', codexWarmupTime: time, codexWarmupReset: scenario === 'periodic', billingMode: 'deepseek' }));
  if (damaged) await writeFile(join(data, 'warmup.json'), '{broken');
  const handlers = new Map(), disposers = [], calls = [];
  let modelCalls = 0, streamPaused = false, fullRestored = false;
  if (scenario === 'periodic') t.mock.timers.enable({ apis: ['setInterval'] });
  const services = { effect(fn) { disposers.push(fn()); },
    webServer: { register({ path, handler }) { handlers.set(path, handler); return () => {}; } },
    connection: { requestRejection() { return undefined; }, createSharedFetchHandler() { return { async fetch(request) {
      const body = await request.json(); calls.push(body);
      let value;
      if (body.method === 'codex-subscription/status') value = { authenticated: true, accounts: [{ id: 'private-test-account', active: true, email: 'private-test-email' }] };
      else if (body.method === 'codex-subscription/default-model/status') value = { managed: false, provider: 'deepseek-official', model: 'deepseek-flash' };
      else if (body.method === 'codex-subscription/usage') value = { fetchedAt: now, rateLimits: [{ id: 'codex', windows: [
        { windowSeconds: 18000, remainingPercent: scenario === 'startup' || fullRestored ? 100 : 80, resetsAt: Math.floor(now / 1000) + 18000 },
        { windowSeconds: 604800, remainingPercent: 90, resetsAt: Math.floor(now / 1000) + 604800 },
      ] }] };
      else throw new Error('unexpected write RPC');
      return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } });
    } }; } },
  };
  const ctx = { ...services, on() {}, inject(_names, fn) { fn(services); }, settings: { describe() { return []; } },
    get(name) { if (name === 'deepseekAccount') return { async getBalance() { return { status: 'ready', value: [{ currency: 'CNY', balance: '50' }] }; } }; },
    llm: { listConfigurableProviders() { return []; }, async listModels(provider) { return [{ provider, id: 'gpt-test' }]; },
      async *stream(options) { modelCalls++; assert.equal(options.provider, 'openai-codex');
        yield { type: 'text-delta', text: 'OK' }; yield { type: 'usage', usage: { inputTokens: 11, cacheReadTokens: 3, outputTokens: 2, reasoningTokens: 1 } };
        if (scenario === 'drain') {
          streamPaused = true;
          await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  };
  try {
    apply(ctx, { petLauncher: () => () => {}, warmupClock: () => now });
    const state = () => { let body; handlers.get('/api/dsh-plugin-simple-pet/state')({ method: 'GET', url: '/api/dsh-plugin-simple-pet/state?since=0', headers: {} },
      { writeHead() {}, end(value) { body = value; } }); return JSON.parse(body); };
    for (let i = 0; i < 500; i++) {
      if (scenario === 'periodic' && !fullRestored && state().codex.status === 'ready'
        && state().codexWarmup.status === 'idle') {
        assert.equal(modelCalls, 0); assert.equal(state().codexQuotaRefreshSeconds, 5);
        fullRestored = true; t.mock.timers.tick(4999);
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(modelCalls, 0, 'does not poll before the five-second interval');
        t.mock.timers.tick(1);
      }
      if (['succeeded', 'failed', 'skipped'].includes(state().codexWarmup.status) || streamPaused
        || (scenario === 'web' && state().codex.status === 'ready' && state().balance === 50)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (scenario === 'drain') {
      assert.equal(streamPaused, true); assert.equal(modelCalls, 1);
      for (const dispose of disposers.splice(0).reverse()) await dispose?.();
      const saved = JSON.parse(await readFile(join(data, 'stats-codex-desktop.json'), 'utf8'));
      assert.equal(Object.values(saved.days).reduce((sum, day) => sum + day.tokens, 0), 16);
      assert.equal(state().events.length, 0, 'drained usage creates no events after unload'); return;
    }
    if (scenario === 'web') {
      assert.equal(state().codexWarmup.status, 'disabled'); assert.equal(modelCalls, 0);
      assert.ok(!calls.some(call => call.payload.force === true));
      await assert.rejects(readFile(join(data, 'warmup.json')), { code: 'ENOENT' }); return;
    }
    const value = state();
    if (damaged) {
      assert.equal(value.codexWarmup.status, 'failed'); assert.ok(value.codexWarmup.alertId); assert.equal(modelCalls, 0);
      assert.equal(await readFile(join(data, 'warmup.json'), 'utf8'), '{broken'); return;
    }
    if (scenario === 'periodic') assert.ok(['succeeded', 'skipped'].includes(value.codexWarmup.status), JSON.stringify(value.codexWarmup));
    else assert.equal(value.codexWarmup.status, 'succeeded', JSON.stringify(value.codexWarmup));
    assert.equal(modelCalls, 1); assert.equal(value.balance, 50);
    assert.equal(Object.values(value.stats.days).length, 0);
    assert.equal(Object.values(value.codexStats.days).reduce((sum, day) => sum + day.tokens, 0), 16);
    assert.ok(value.events.every(event => event.billingMode === 'codex' && event.cny === null && event.warmup === true));
    assert.ok(!JSON.stringify(value).includes('private-test')); assert.ok(!JSON.stringify(value).includes('Reply only'));
    assert.ok(calls.some(call => call.method.endsWith('/usage') && call.payload.force === true));
    const journal = JSON.parse(await readFile(join(data, 'warmup.json'), 'utf8'));
    assert.equal(journal.keys.filter(key => key.startsWith('daily:')).length, ['startup', 'periodic'].includes(scenario) ? 0 : 1);
    assert.equal(new Set(journal.keys.filter(key => key.startsWith('window:'))).size, 1); assert.equal(journal.lastSuccessAt, now);
    if (scenario === 'periodic') {
      assert.equal(value.codexWarmup.lastReason, 'full');
      t.mock.timers.tick(5000); await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(modelCalls, 1, 'sustained 100% never sends on every timer refresh');
      const settingsFile = join(data, 'settings.json');
      const saved = JSON.parse((await readFile(settingsFile, 'utf8')).replace(/^\uFEFF/, ''));
      saved.codexQuotaRefreshSeconds = 12;
      await writeFile(settingsFile, JSON.stringify(saved));
      for (let i = 0; i < 100 && state().codexQuotaRefreshSeconds !== 12; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(state().codexQuotaRefreshSeconds, 12, 'settings watcher rearms without restarting DSH');
      const usageCount = () => calls.filter(call => call.method.endsWith('/usage')).length;
      const before = usageCount();
      t.mock.timers.tick(11_999); await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(usageCount(), before, 'old five-second interval is removed');
      t.mock.timers.tick(1); await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(usageCount(), before + 1, 'uses the new twelve-second interval for upstream polling');
      assert.equal(calls.filter(call => call.method.endsWith('/usage')).at(-1).payload.force, true);
      assert.equal(modelCalls, 1, 'changing cadence never bypasses window dedup');
      for (const dispose of disposers.splice(0).reverse()) await dispose?.();
      const afterDispose = usageCount();
      t.mock.timers.tick(120_000); await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(usageCount(), afterDispose, 'disposal removes the configurable poll timer');
    }
    if (scenario === 'startup') {
      assert.equal(value.codexWarmup.lastReason, 'startup');
      for (const dispose of disposers.splice(0).reverse()) await dispose?.();
      apply(ctx, { petLauncher: () => () => {}, warmupClock: () => now });
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(modelCalls, 1, 'persisted window prevents a second startup call');
    }
    if (scenario === 'duplicate') {
      let duplicateBody;
      const duplicateServices = { ...services, webServer: { register({ path, handler }) {
        if (path.endsWith('/state')) duplicateBody = handler; return () => {};
      } } };
      apply({ ...ctx, inject(_names, fn) { fn(duplicateServices); } }, { petLauncher: () => () => {}, warmupClock: () => now });
      for (let i = 0; i < 100; i++) {
        let body; duplicateBody({ method: 'GET', url: '/api/dsh-plugin-simple-pet/state', headers: {} },
          { writeHead() {}, end(value) { body = value; } });
        if (JSON.parse(body).codexWarmup.status !== 'disabled') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(modelCalls, 1, 'a second mounted context cannot repeat the local daily occurrence');
    }
  } finally {
    for (const dispose of disposers.reverse()) await dispose?.();
    if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous;
    if (previousProfile === undefined) delete process.env.DSH_PET_PROFILE; else process.env.DSH_PET_PROFILE = previousProfile;
  }
});

test('both DeepSeek provider routes enter, while unrelated providers stay out', async () => {
  const previousDataDir = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = join(import.meta.dirname, 'work', `test-runtime-${process.pid}`);
  const handlers = new Map();
  const listeners = new Map();
  const disposers = [];
  const ctx = {
    on(name, fn) { listeners.set(name, fn); },
    effect(fn) { disposers.push(fn()); },
    inject(_services, fn) { fn({
      webServer: { register({ path, handler }) { handlers.set(path, handler); return () => handlers.delete(path); } },
      connection: { requestRejection(req) { return req.headers.authorization === 'test' ? undefined : 401; } },
      effect(fn) { disposers.push(fn()); },
    }); },
    llm: { listConfigurableProviders() { return []; } },
    settings: { describe() { return []; } },
  };
  let petStarted = false;
  let petStopped = false;
  apply(ctx, { petLauncher({ profile }) {
    assert.equal(profile, 'desktop');
    petStarted = true;
    return () => { petStopped = true; };
  } });
  assert.equal(petStarted, true);
  const emit = listeners.get('session/event');
  const makeEvent = (seq, provider) => ({ seq, type:'assistant/message', time:'2026-09-29T01:00:00Z', data:{
    message:{ source:{ kind:'model', provider, model:'deepseek-v4-flash' } },
    usage:{ inputTokens:100,cacheReadTokens:200,outputTokens:300 },
  } });
  const session = { id:'s1',firstLiveSeq:2 };
  emit(session,makeEvent(1,'deepseek-official'));
  emit(session,makeEvent(2,'other'));
  emit(session,makeEvent(3,'deepseek-official'));
  emit(session,makeEvent(3,'deepseek-official'));
  emit(session,makeEvent(4,'deepseek-account'));
  emit(session,makeEvent(5,'openai-codex'));
  const handler = handlers.get('/api/dsh-plugin-simple-pet/state');
  function request(auth) {
    const result = { code:null, body:'' };
    const res = { writeHead(code) { result.code=code; }, end(body) { result.body=body ?? ''; } };
    handler({ method:'GET',url:'/api/dsh-plugin-simple-pet/state?since=0',headers:{authorization:auth} },res);
    return result;
  }
  assert.equal(request('').code,401);
  // All runtime skin images use the same local connection guard as state.
  for (const skin of ['default', 'night', 'snow', 'mint', 'cherry', 'star']) {
    for (const mode of ['peak', 'valley']) {
      const path = `/api/dsh-plugin-simple-pet/asset/${skin}-${mode}.png`;
      const imageHandler = handlers.get(path);
      assert.equal(typeof imageHandler, 'function', path);
      const getImage = async (authorization, method = 'GET') => {
        const result = {};
        await imageHandler({ method, url: path, headers: { authorization } }, {
          writeHead(code, headers) { Object.assign(result, { code, headers }); },
          end(body) { result.body = body; },
        });
        return result;
      };
      assert.equal((await getImage('')).code, 401);
      const image = await getImage('test');
      assert.equal(image.code, 200);
      assert.equal(image.headers['Content-Type'], 'image/png');
      assert.deepEqual(image.body.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      assert.equal((await getImage('test', 'HEAD')).body, undefined);
      assert.equal((await getImage('test', 'POST')).code, 405);
    }
  }
  assert.ok(![...handlers.keys()].some(path => path.includes('source')), 'generation originals are not exposed as an API asset');
  const response = request('test');
  assert.equal(response.code,200);
  const payload = JSON.parse(response.body);
  assert.deepEqual(payload.events.filter(e => e.billingMode === 'deepseek').map(e=>e.kind),['hit','miss','output','hit','miss','output','combo']);
  assert.deepEqual(payload.events.filter(e => e.billingMode === 'codex').map(e => e.kind), ['hit','miss','output']);
  assert.ok(payload.events.filter(e => e.billingMode === 'codex').every(e => e.cny === null));
  assert.equal(payload.cacheHitRate,2/3);
  const today = new Date('2026-09-29T01:00:00Z');
  const dayKey = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  assert.equal(payload.stats.days[dayKey].tokens, 1200);
  assert.equal(payload.codexStats.days[dayKey].tokens, 600);
  assert.equal(payload.codexStats.days[dayKey].cny, 0);
  for (const dispose of disposers.reverse()) dispose?.();
  assert.equal(petStopped, true);
  if (previousDataDir === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = previousDataDir;
});

test('subscription bridge reaches guarded state DTO without changing the DeepSeek wallet', async () => {
  const previousDataDir = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = join(import.meta.dirname, 'work', `test-codex-bridge-${process.pid}`);
  const handlers = new Map(), listeners = new Map(), disposers = [], calls = [];
  const now = Date.now();
  const services = {
    effect(fn) { disposers.push(fn()); },
    webServer: { register({ path, handler }) { handlers.set(path, handler); return () => {}; } },
    connection: {
      requestRejection(req) { return req.headers.authorization === 'fixture' ? undefined : 401; },
      createSharedFetchHandler(prefix) {
        assert.equal(prefix, '/api');
        return { async fetch(request) {
          const body = await request.json(); calls.push(body);
          assert.equal(body.type, 'client-request');
          assert.ok(['codex-subscription/status', 'codex-subscription/usage'].includes(body.method));
          const value = body.method.endsWith('/status')
            ? { authenticated: true, accounts: [{ id: 'fixture-private-id', email: 'fixture-private-email', active: true }] }
            : { fetchedAt: now, rateLimits: [{ id: 'codex', windows: [{ windowSeconds: 18000, remainingPercent: 75, resetsAt: Math.floor(now / 1000) + 3600 }] }] };
          return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } });
        } };
      },
    },
  };
  const ctx = { ...services, on(name, fn) { listeners.set(name, fn); }, inject(_names, fn) { fn(services); },
    llm: { listConfigurableProviders() { return []; } }, settings: { describe() { return []; } } };
  try {
    apply(ctx, { petLauncher: () => () => {} });
    const state = (auth = 'fixture') => {
      let body, code;
      handlers.get('/api/dsh-plugin-simple-pet/state')({ method: 'GET', url: '/api/dsh-plugin-simple-pet/state?since=0', headers: { authorization: auth } },
        { writeHead(value) { code = value; }, end(value) { body = value; } });
      return { code, payload: code === 200 ? JSON.parse(body) : body };
    };
    for (let i = 0; i < 50 && state().payload.codex.status === 'loading'; i++) await new Promise(setImmediate);
    const before = state().payload;
    assert.equal(before.codex.status, 'ready');
    assert.equal(before.codex.fiveHour.remainingPercent, 75);
    assert.equal(before.codex.weekly, null);
    assert.ok(!JSON.stringify(before).includes('fixture-private'));
    assert.equal(state('').code, 401);
    assert.deepEqual(calls[1].payload, { force: false });
    listeners.get('session/event')({ id: 'codex-bridge', firstLiveSeq: 1 }, { seq: 1, type: 'assistant/message', time: new Date(now).toISOString(), data: {
      message: { source: { kind: 'model', provider: 'openai-codex', model: 'fixture-model' } }, usage: { inputTokens: 10, outputTokens: 20 },
    } });
    const after = state().payload;
    assert.equal(after.balance, before.balance);
    assert.ok(after.events.every(event => event.billingMode === 'codex' && event.cny === null));
    assert.equal(Object.values(after.codexStats.days).reduce((sum, day) => sum + day.tokens, 0), 30);
  } finally {
    for (const dispose of disposers.reverse()) dispose?.();
    if (previousDataDir === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previousDataDir;
  }
});

test('startup reads the account wallet before usage, then switches wallets by provider', async () => {
  const previousDataDir = process.env.LOCALAPPDATA;
  const previousFetch = globalThis.fetch;
  process.env.LOCALAPPDATA = join(import.meta.dirname, 'work', `test-account-${process.pid}`);
  globalThis.fetch = async () => new Response(JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '100' }] }), { status: 200 });
  const handlers = new Map();
  const listeners = new Map();
  const disposers = [];
  let accountReads = 0;
  const ctx = {
    on(name, fn) { listeners.set(name, fn); },
    effect(fn) { disposers.push(fn()); },
    inject(_services, fn) { fn({
      webServer: { register({ path, handler }) { handlers.set(path, handler); return () => {}; } },
      connection: { requestRejection() { return undefined; } },
      effect(fn) { disposers.push(fn()); },
    }); },
    llm: { listConfigurableProviders() { return [{ provider: 'deepseek-official', settingsNs: 'llm-deepseek' }]; } },
    settings: { describe() { return [{ ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } }]; } },
    credentials: { async resolve() { return { value: 'test-only' }; } },
    get(name) {
      if (name !== 'deepseekAccount') return undefined;
      return { async getBalance() {
        accountReads++;
        return { status: 'ready', value: [{ currency: 'CNY', balance: '8' }], bonusWallets: [{ currency: 'CNY', balance: '2' }] };
      } };
    },
  };
  try {
    apply(ctx, { petLauncher: () => () => {} });
    await new Promise(setImmediate);
    const handler = handlers.get('/api/dsh-plugin-simple-pet/state');
    function state() {
      let body;
      handler({ method: 'GET', url: '/api/dsh-plugin-simple-pet/state?since=0', headers: {} },
        { writeHead() {}, end(value) { body = value; } });
      return JSON.parse(body);
    }
    assert.equal(accountReads, 1);
    assert.equal(state().balance, 10);
    assert.equal(state().seq, 0); // No model usage was needed to read the account wallet.
    const emit = listeners.get('session/event');
    const session = { id: 'account-session', firstLiveSeq: 1 };
    const usage = { inputTokens: 1000, outputTokens: 100 };
    const makeEvent = (seq, provider) => ({
      seq, type: 'assistant/message', time: '2026-09-29T01:00:00Z', data: {
        message: { source: { kind: 'model', provider, model: 'deepseek-flash' } }, usage,
      },
    });
    emit(session, makeEvent(1, 'deepseek-account'));
    assert.equal(accountReads, 1);
    assert.ok(state().balance < 10 && state().balance > 9);
    assert.equal(state().stats.days['2026-09-29'].tokens, 1100);
    assert.deepEqual(state().events.map(event => event.kind), ['miss', 'output']);
    emit(session, makeEvent(2, 'deepseek-official'));
    await new Promise(setImmediate);
    assert.equal(state().balance, 100); // Switching wallets never carries over the other wallet's deduction.
    emit(session, makeEvent(3, 'deepseek-account'));
    await new Promise(setImmediate);
    assert.equal(accountReads, 2);
    assert.equal(state().balance, 10);
  } finally {
    for (const dispose of disposers.reverse()) dispose?.();
    globalThis.fetch = previousFetch;
    if (previousDataDir === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousDataDir;
  }
});
