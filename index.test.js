import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { apply } from './index.js';

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
  assert.deepEqual(payload.events.map(e=>e.kind),['hit','miss','output','hit','miss','output','combo']);
  assert.equal(payload.cacheHitRate,2/3);
  const today = new Date('2026-09-29T01:00:00Z');
  const dayKey = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  assert.equal(payload.stats.days[dayKey].tokens, 1200);
  for (const dispose of disposers.reverse()) dispose?.();
  assert.equal(petStopped, true);
  if (previousDataDir === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = previousDataDir;
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
