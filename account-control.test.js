import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountControl, accountControlHandler } from './account-control.js';

const RAW = 'alice.private@example.com', SECRET = 'private-account-alpha', OTHER = 'private-account-beta';
const privateText = /alice\.private|private-account|sensitive-label|C:\\private|upstream-secret/;
const dedicated = (ids = [SECRET, OTHER], selected = SECRET) => ({ authenticated: true,
  accounts: ids.map(id => ({ id, active: id === selected, email: id === SECRET ? RAW : undefined, label: 'sensitive-label' })) });
const general = (ids = [SECRET, OTHER], selected = SECRET) => ({ providers: { codex: {
  accounts: ids.map(key => ({ key, isDefault: key === selected, account: key === SECRET ? RAW : undefined, label: 'sensitive-label' })) } } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(provider = 'openai-codex') {
  const state = { provider, generation: 1, now: 1000, blocked: false, selected: SECRET, ids: [SECRET, OTHER],
    statusOverride: undefined, calls: [], events: [], hook: null, starts: 0, ends: 0, changes: 0, hostLease: false };
  const bridge = { async fetch(req) {
    assert(req instanceof Request); assert.equal(req.method, 'POST');
    const body = await req.json();
    const call = { method: body.method, payload: body.payload, signal: req.signal };
    state.calls.push(call);
    assert.match(body.method, /^(?:codex-subscription\/(?:status|account\/select)|subscriptions-auth\.(?:status|setDefault))$/);
    if (state.hook) {
      const result = await state.hook(call, state.calls.length);
      if (result instanceof Response) return result;
      if (result !== undefined) return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: result } });
    }
    let value;
    if (/status$/.test(body.method)) value = state.statusOverride ?? (provider === 'codex' ? general(state.ids, state.selected) : dedicated(state.ids, state.selected));
    else {
      state.events.push('select');
      state.selected = provider === 'codex' ? body.payload.account : body.payload.id;
      value = { ok: true };
    }
    return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } });
  } };
  state.context = { bridge, provider, generation: 1 };
  const control = createAccountControl({ context: () => state.context, blocked: () => state.blocked || state.hostLease,
    begin() { state.events.push('begin'); state.starts++; if (state.beginError) throw new Error('upstream-secret'); if (state.denyLease) return false; state.hostLease = true; },
    end() { state.events.push('end'); state.ends++; state.hostLease = false; if (state.endError) throw new Error('upstream-secret'); },
    changed() { state.changes++; state.events.push('changed'); if (state.changeError) throw new Error('upstream-secret'); }, clock: () => state.now });
  return { state, control, bridge };
}
const choose = list => ({ token: list.token, target: list.accounts.find(row => !row.current).target, confirm: true });
const writes = state => state.calls.filter(call => /(?:select|setDefault)$/.test(call.method));
async function invoke(handler, method = 'GET', body, headers = {}) {
  const req = new Request('http://private.invalid/account-control', { method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  let code, responseHeaders, text;
  await handler(req, { writeHead(value, h) { code = value; responseHeaders = h; }, end(value) { text = value; } });
  assert.equal(responseHeaders['Cache-Control'], 'no-store'); assert.equal(responseHeaders['X-Content-Type-Options'], 'nosniff');
  assert.doesNotMatch(text ?? '', privateText);
  return { code, headers: responseHeaders, text, data: text ? JSON.parse(text) : null };
}

for (const provider of ['openai-codex', 'codex']) {
  test(`${provider}: view is pure memory and multi-warmup is explicitly unavailable`, () => {
    const { control, state } = fixture(provider);
    assert.deepEqual(control.view(), { busy: false, multiWarmup: { available: false,
      reason: '缺少本机已验证的公共账号绑定模型及逐账号预算授权；未启用，不后台轮换账号。' } });
    assert.equal(state.calls.length, 0);
  });
  for (const [count, reason] of [[0, /没有已绑定/], [1, /至少需要两个/], [2, null]]) {
    test(`${provider}: ${count} valid bound accounts`, async () => {
      const { control, state } = fixture(provider); state.ids = [SECRET, OTHER].slice(0, count);
      const result = await control.list(); assert.equal(result.enabled, count === 2);
      assert.equal(state.calls.length, 1); assert.equal(state.calls[0].method, provider === 'codex' ? 'subscriptions-auth.status' : 'codex-subscription/status');
      if (reason) { assert.match(result.reason, reason); assert.equal(result.token, null); assert.equal(result.validForMs, 0); }
      else { assert.equal(result.accounts.length, 2); assert.equal(result.validForMs, 15000); assert.equal(result.current, result.accounts[0].target); }
      assert.doesNotMatch(JSON.stringify(result), privateText);
    });
  }
  test(`${provider}: one write, exact source/payload, host lease then verified unique selection`, async () => {
    const { control, state } = fixture(provider), list = await control.list(), input = choose(list);
    state.hook = call => { if (state.calls.length > 1) { assert.equal(control.view().busy, true); assert.equal(state.hostLease, true); } };
    assert.deepEqual(await control.switch(input), { ok: true, provider, selection: provider === 'codex' ? 'default' : 'active', current: input.target });
    assert.equal(state.calls.length, 4); assert.equal(writes(state).length, 1);
    assert.deepEqual(writes(state)[0].payload, provider === 'codex' ? { provider: 'codex', account: OTHER } : { id: OTHER });
    assert.deepEqual(state.events, ['begin', 'select', 'end', 'changed']);
    assert.equal(control.view().busy, false); assert.equal(state.starts, 1); assert.equal(state.ends, 1);
    assert(state.calls.every(call => !/usage/.test(call.method)));
    await assert.rejects(control.switch(input), /过期或无效/); assert.equal(writes(state).length, 1);
  });
  test(`${provider}: duplicate IDs, invalid IDs, missing/ambiguous selection are disabled`, async () => {
    for (const kind of ['duplicate', 'invalid', 'multiple', 'none', 'missing', 'too-many']) {
      const { control, state } = fixture(provider), value = provider === 'codex' ? general() : dedicated();
      const rows = provider === 'codex' ? value.providers.codex.accounts : value.accounts;
      const id = provider === 'codex' ? 'key' : 'id', flag = provider === 'codex' ? 'isDefault' : 'active';
      if (kind === 'duplicate') rows[1][id] = rows[0][id];
      if (kind === 'invalid') rows[1][id] = 'bad\u202e';
      if (kind === 'multiple') rows[1][flag] = true;
      if (kind === 'none') rows[0][flag] = false;
      if (kind === 'missing') delete rows[1][id];
      if (kind === 'too-many') rows.push(...Array.from({ length: 1000 }, (_, n) => ({ [id]: `id-${n}` })));
      state.statusOverride = value;
      assert.equal((await control.list()).enabled, false, kind); assert.equal(writes(state).length, 0);
    }
  });
  for (const change of ['2-to-1', 'target-deleted', 'added', 'external-selection']) {
    test(`${provider}: confirmation rejects ${change} before writing`, async () => {
      const { control, state } = fixture(provider), list = await control.list();
      if (change === '2-to-1') state.ids = [SECRET];
      if (change === 'target-deleted') state.ids = [SECRET, 'third-private-id'];
      if (change === 'added') state.ids.push('third-private-id');
      if (change === 'external-selection') state.selected = OTHER;
      await assert.rejects(control.switch(choose(list)), /已变化/);
      assert.equal(writes(state).length, 0); assert.equal(state.ends, 1); assert.equal(state.changes, 1);
    });
  }
}

test('missing capability and invalid provider never infer a source or touch upstream', async () => {
  for (const ctx of [null, {}, { provider: 'other' }, { provider: '__proto__' }]) {
    const { control, state } = fixture(); state.context = ctx;
    assert.equal((await control.list()).enabled, false); assert.equal(state.calls.length, 0);
  }
});
test('404 dedicated interface never falls back to subscriptions-auth', async () => {
  const { control, state } = fixture(); state.hook = () => new Response('', { status: 404 });
  const result = await control.list(); assert.equal(result.enabled, false); assert.match(result.reason, /缺少公共账号状态接口/);
  assert.deepEqual(state.calls.map(call => call.method), ['codex-subscription/status']);
});
test('logged-out statuses explicitly disable both sources', async () => {
  for (const [provider, status] of [['openai-codex', { authenticated: false }], ['codex', { providers: {} }]]) {
    const { control, state } = fixture(provider); state.statusOverride = status;
    assert.match((await control.list()).reason, /尚未登录/);
  }
});
test('list labels only contain masked email or salted anonymous hashes; targets rotate', async () => {
  const { control, state } = fixture(), first = await control.list(), next = await control.list();
  assert.equal(first.accounts[0].label, 'a***@e***.com'); assert.match(first.accounts[1].label, /^匿名账号 [a-f0-9]{8}$/);
  assert.notEqual(first.token, next.token); assert.notEqual(first.accounts[0].target, next.accounts[0].target);
  await assert.rejects(control.switch(choose(first)), /过期或无效/); assert.equal(writes(state).length, 0);
  await assert.rejects(control.switch(choose(next)), /过期或无效/);
});
test('cancel/current/foreign target consume confirmation without any write', async () => {
  for (const mode of ['cancel', 'current', 'foreign']) {
    const { control, state } = fixture(), list = await control.list(), input = choose(list);
    if (mode === 'cancel') input.confirm = false;
    if (mode === 'current') input.target = list.current;
    if (mode === 'foreign') input.target = 'unknown';
    await assert.rejects(control.switch(input), /明确确认/);
    assert.equal(state.calls.length, 1); assert.equal(writes(state).length, 0);
    await assert.rejects(control.switch(choose(list)), /过期或无效/);
  }
});
test('confirmation lease rejects exactly 15 seconds and clocks moving backwards', async () => {
  for (const delta of [15000, -1]) {
    const { control, state } = fixture(), list = await control.list(); state.now += delta;
    await assert.rejects(control.switch(choose(list)), /过期或无效/); assert.equal(state.calls.length, 1);
  }
  const { control, state } = fixture(), list = await control.list(); state.now += 14999;
  assert.equal((await control.switch(choose(list))).ok, true);
});
test('warmup/read activity rejects synchronously without starting RPC or host lease', async () => {
  const { control, state } = fixture(), list = await control.list(); state.blocked = true;
  await assert.rejects(control.switch(choose(list)), /进行中/); assert.equal(state.starts, 0); assert.equal(state.calls.length, 1);
  await assert.rejects(control.list(), /进行中/); state.blocked = false;
  await assert.rejects(control.switch(choose(list)), /过期或无效/);
});
test('host lease denial/failure never writes and triggers safe refresh', async () => {
  for (const kind of ['denyLease', 'beginError']) {
    const { control, state } = fixture(), list = await control.list(); state[kind] = true;
    await assert.rejects(control.switch(choose(list)), error => !privateText.test(error.message));
    assert.equal(state.ends, 0); assert.equal(state.changes, 1); assert.equal(writes(state).length, 0); assert.equal(control.view().busy, false);
  }
});
test('busy switch rejects list/duplicate and holds host lease before first await', async () => {
  const { control, state } = fixture(), list = await control.list(), wait = deferred();
  state.hook = (_call, n) => n === 2 ? wait.promise : undefined;
  const pending = control.switch(choose(list));
  assert.equal(control.view().busy, true); assert.equal(state.hostLease, true); assert.equal(state.starts, 1);
  await assert.rejects(control.list(), /进行中/); await assert.rejects(control.switch(choose(list)), /进行中/);
  wait.resolve(); assert.equal((await pending).ok, true); assert.equal(writes(state).length, 1);
});
test('busy list rejects concurrent reads; failed new list invalidates old confirmation', async () => {
  const { control, state } = fixture(), first = await control.list(), wait = deferred();
  state.hook = () => wait.promise; const pending = control.list(); await tick();
  await assert.rejects(control.list(), /进行中/); wait.reject(new Error('upstream-secret C:\\private'));
  await assert.rejects(pending, error => !privateText.test(error.message));
  await assert.rejects(control.switch(choose(first)), /过期或无效/);
});
for (const change of ['bridge', 'provider', 'generation', 'null']) {
  test(`context ${change} before confirmation never writes`, async () => {
    const { control, state } = fixture(), list = await control.list();
    state.context = change === 'null' ? null : { ...state.context,
      ...(change === 'bridge' ? { bridge: { fetch() { assert.fail('not called'); } } } : change === 'provider' ? { provider: 'codex' } : { generation: 2 }) };
    await assert.rejects(control.switch(choose(list)), /已变化/); assert.equal(state.calls.length, 1);
  });
}
for (const boundary of [2, 3, 4]) {
  test(`context change at await boundary ${boundary} suppresses late continuation/success`, async () => {
    const { control, state } = fixture(), list = await control.list();
    state.hook = (_call, n) => { if (n === boundary) state.context = { ...state.context, generation: 2 }; };
    await assert.rejects(control.switch(choose(list)), /已变化/);
    assert.equal(state.calls.length, boundary); assert.equal(writes(state).length, boundary >= 3 ? 1 : 0);
    assert.equal(state.ends, 1); assert.equal(state.changes, 1);
  });
}
for (const boundary of [2, 3, 4]) {
  test(`RPC failure at boundary ${boundary} is private, consumed, never retried or rolled back`, async () => {
    const { control, state } = fixture(), list = await control.list();
    state.hook = (_call, n) => { if (n === boundary) throw new Error('upstream-secret C:\\private alice.private@example.com'); };
    await assert.rejects(control.switch(choose(list)), error => !privateText.test(error.message));
    assert.equal(state.calls.length, boundary); assert.equal(writes(state).length, boundary >= 3 ? 1 : 0);
    assert.equal(state.ends, 1); assert.equal(state.changes, 1);
    await assert.rejects(control.switch(choose(list)), /过期或无效/); assert.equal(state.calls.length, boundary);
  });
}
test('write success without uniquely selected target is unknown, with no rollback', async () => {
  const { control, state } = fixture(), list = await control.list();
  state.hook = (_call, n) => n === 4 ? dedicated() : undefined;
  await assert.rejects(control.switch(choose(list)), /结果未知/); assert.equal(writes(state).length, 1);
});
for (const boundary of [2, 3, 4]) {
  test(`one bounded timeout covers boundary ${boundary}, ignoring transport abort and late result`, async t => {
    const { control, state } = fixture(), list = await control.list(), timeout = new AbortController(), wait = deferred();
    let deadlines = 0;
    t.mock.method(AbortSignal, 'timeout', ms => { assert.equal(ms, 10000); deadlines++; return timeout.signal; });
    state.hook = (_call, n) => n === boundary ? wait.promise : undefined;
    const pending = control.switch(choose(list));
    while (state.calls.length < boundary) await tick();
    timeout.abort(new DOMException('upstream-secret', 'TimeoutError'));
    await assert.rejects(pending, error => !privateText.test(error.message));
    assert.equal(deadlines, 1); assert.equal(state.ends, 1); assert.equal(state.changes, 1); assert.equal(control.view().busy, false);
    wait.resolve(); await tick(); await tick();
    assert.equal(state.calls.length, boundary); assert.equal(writes(state).length, boundary >= 3 ? 1 : 0);
  });
}
test('dispose clears tokens, aborts pending operation and refuses all later actions', async () => {
  const { control, state } = fixture(), list = await control.list(), wait = deferred();
  state.hook = (_call, n) => n === 2 ? wait.promise : undefined;
  const pending = control.switch(choose(list)); await tick(); control.dispose(); control.dispose();
  await assert.rejects(pending, /关闭|不可用/); assert.equal(state.ends, 1); assert.equal(state.changes, 1);
  assert.throws(() => control.view(), /关闭/); await assert.rejects(control.list(), /关闭/); await assert.rejects(control.switch(choose(list)), /关闭/);
  wait.resolve(); await tick(); assert.equal(writes(state).length, 0);
});
test('dispose while list is pending cannot issue a late token', async () => {
  const { control, state } = fixture(), wait = deferred(); state.hook = () => wait.promise;
  const pending = control.list(); await tick(); control.dispose(); await assert.rejects(pending); wait.resolve(); await tick();
  assert.equal(state.calls.length, 1);
});

test('safe pre-lease failures refresh the host and do not acquire its lock', async () => {
  for (const mode of ['token', 'confirm', 'stale', 'blocked']) {
    const { control, state } = fixture(), list = await control.list(), input = choose(list);
    if (mode === 'token') input.token = 'bad';
    if (mode === 'confirm') input.confirm = false;
    if (mode === 'stale') state.context = { ...state.context, generation: 2 };
    if (mode === 'blocked') state.blocked = true;
    await assert.rejects(control.switch(input));
    assert.equal(state.changes, 1, mode); assert.equal(state.starts, 0); assert.equal(writes(state).length, 0);
  }
});
test('lease release failure cannot report success or expose host exception', async () => {
  const { control, state } = fixture(), list = await control.list(); state.endError = true;
  await assert.rejects(control.switch(choose(list)), /结果未知/);
  assert.equal(state.ends, 1); assert.equal(state.changes, 1); assert.equal(writes(state).length, 1);
  assert.equal(control.view().busy, false);
});
test('host refresh exceptions are private and cannot cause another selection', async () => {
  const { control, state } = fixture(), list = await control.list(); state.changeError = true;
  assert.equal((await control.switch(choose(list))).ok, true); assert.equal(writes(state).length, 1);
});
test('mutating the caller input during a pending confirmation cannot alter result identity', async () => {
  const { control, state } = fixture(), list = await control.list(), input = choose(list), target = input.target, wait = deferred();
  state.hook = (_call, n) => n === 2 ? wait.promise : undefined;
  const pending = control.switch(input); await tick(); input.target = RAW; wait.resolve();
  const result = await pending; assert.equal(result.current, target); assert.doesNotMatch(JSON.stringify(result), privateText);
});
test('source generation change during list discards all tokens and labels', async () => {
  const { control, state } = fixture(); state.hook = () => { state.context = { ...state.context, generation: 2 }; };
  await assert.rejects(control.list(), /已变化/); await assert.rejects(control.switch({}), /过期或无效/);
  assert.equal(state.calls.length, 1);
});

test('HTTP GET/HEAD are authenticated memory-only; unsupported methods are 405', async () => {
  const { control, state } = fixture(), handler = accountControlHandler(control, () => true);
  assert.equal((await invoke(handler)).code, 200); const head = await invoke(handler, 'HEAD'); assert.equal(head.code, 200); assert.equal(head.text, undefined);
  for (const method of ['PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
    const result = await invoke(handler, method); assert.equal(result.code, 405); assert.equal(result.headers.Allow, 'GET, HEAD, POST');
  }
  assert.equal(state.calls.length, 0);
});
test('HTTP auth failures and exceptions fail closed without leaking authorizer strings', async () => {
  const { control, state } = fixture();
  for (const authorize of [() => false, () => undefined, () => { throw new Error('upstream-secret'); }, (_req, res) => { res.writeHead(401, {}); res.end('upstream-secret'); return false; }]) {
    const result = await invoke(accountControlHandler(control, authorize), 'POST', { action: 'list' }); assert([401, 403].includes(result.code));
  }
  assert.equal(state.calls.length, 0);
});
test('HTTP JSON schema only accepts exact list or explicitly confirmed switch', async () => {
  const { control, state } = fixture(), handler = accountControlHandler(control, () => true);
  for (const body of [null, [], {}, { action: 'usage' }, { action: 'list', extra: 1 }, { action: 'list', token: 'x' },
    { action: 'switch', token: 'x', target: 'x', confirm: true }, { action: 'switch', token: 'a'.repeat(16), target: 'b'.repeat(16), confirm: false },
    { action: 'switch', token: 'a'.repeat(16), target: 'b'.repeat(16), confirm: true, extra: 1 }, '{', '{"__proto__":{},"action":"list"}']) {
    assert.equal((await invoke(handler, 'POST', body)).code, 400);
  }
  assert.equal(state.calls.length, 0);
  const listed = await invoke(handler, 'POST', { action: 'list' }); assert.equal(listed.code, 200);
  assert.equal((await invoke(handler, 'POST', { action: 'switch', ...choose(listed.data) })).code, 200);
  assert.equal(writes(state).length, 1);
});
test('HTTP 415/413 cover media type, declared size and streaming UTF8 byte size', async () => {
  const { control, state } = fixture(), handler = accountControlHandler(control, () => true);
  for (const type of ['text/plain', 'application/jsonp', 'application/json; charset=latin1', '']) {
    assert.equal((await invoke(handler, 'POST', '{"action":"list"}', { 'content-type': type })).code, 415);
  }
  assert.equal((await invoke(handler, 'POST', { action: 'list' }, { 'content-length': '8193' })).code, 413);
  assert.equal((await invoke(handler, 'POST', { action: 'list' }, { 'content-length': 'garbage' })).code, 413);
  assert.equal((await invoke(handler, 'POST', '中'.repeat(3000))).code, 413);
  assert.equal(state.calls.length, 0);
});
test('Node IncomingMessage-style streaming enforces size and preserves authorization contract', async () => {
  const { control, state } = fixture(), handler = accountControlHandler(control, (_req, res) => { res.setHeader('private', 'upstream-secret'); return true; });
  const request = { method: 'POST', headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.from('{"action":'); yield Buffer.from('"list"}'); } };
  let status, data;
  await handler(request, { writeHead(code, headers) { status = code; assert.equal(headers['Cache-Control'], 'no-store'); }, end(body) { data = JSON.parse(body); } });
  assert.equal(status, 200); assert.equal(data.enabled, true); assert.equal(state.calls.length, 1);
});
test('HTTP exceptions never trust arbitrary error messages, status codes, IDs or paths', async () => {
  const fake = { view() { throw Object.assign(new Error('upstream-secret C:\\private alice.private@example.com'), { status: 400 }); } };
  const result = await invoke(accountControlHandler(fake, () => true)); assert.equal(result.code, 503);
});
