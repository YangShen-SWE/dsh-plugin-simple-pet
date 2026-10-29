import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import { createDurableSubscriptionResetService } from './durable-subscription-reset.js';

// Execute the actual existing factory in a VM, without importing/applying the
// plugin, its dependencies, host settings, account files, or any real network.
const vendor = await fs.readFile(new URL('./vendor/codex-subscription/lib/index.js', import.meta.url), 'utf8');
const credentialCode = vendor.slice(vendor.indexOf('async function readSubscriptionCredentials('), vendor.indexOf('const ORIGINAL_IMAGE_CHUNK_BYTES'));
const resetCode = vendor.slice(vendor.indexOf('//#region src/reset-credits.js'), vendor.indexOf('//#region src/subscription-rpc.js'));
assert(credentialCode.includes('credential.access === auth.auth.apiKey'));
assert(resetCode.includes('function createCodexResetCreditService(options)'));
const createService = vm.runInNewContext(`${credentialCode}\n${resetCode}\ncreateCodexResetCreditService`, {
  AbortSignal, randomUUID, USER_AGENT: 'offline-durable-reset-fixture',
  fetch() { throw new Error('REAL_NETWORK_FORBIDDEN'); },
});
const keyOf = (accountId, creditId) => createHash('sha256').update(JSON.stringify(['reset-credit-v1', accountId, creditId])).digest('hex');
const isCode = (code, requestNotSent) => e => e?.code === code && (requestNotSent === undefined || e.requestNotSent === requestNotSent);
async function fixture(t, config = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pet-durable-subscription-reset-'));
  const storeFile = path.join(dir, 'reset-credit-claims.json');
  // Only this test-created, verified temporary directory is removed.
  t.after(async () => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert(path.basename(dir).startsWith('pet-durable-subscription-reset-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  let time = 1800000000000, accountId = 'SYNTHETIC_ACCOUNT_A', token = 'SYNTHETIC_ACCESS_A';
  const calls = [], instances = [];
  const make = (extra = {}) => {
    const s = createDurableSubscriptionResetService({
      createService, storeFile, now: () => time,
      getAuth: async () => ({ auth: { apiKey: token } }),
      readCredential: async () => ({ type: 'oauth', accountId, access: token }),
      usageReader: { clear() {} },
      fetch: async (url, init) => {
        calls.push({ url, method: init.method, signal: init.signal, body: init.body });
        if (init.method === 'GET') return Response.json({ available_count: 1, credits: [{ id: 'SYNTHETIC_CARD', status: 'available' }] });
        return config.post ? config.post(url, init) : Response.json({ code: 'reset', windows_reset: ['DO_NOT_PERSIST_WINDOW_TEXT'] });
      },
      ...extra,
    });
    instances.push(s); return s;
  };
  t.after(() => { for (const s of instances) s.dispose(); });
  const service = make();
  return { dir, storeFile, service, make, calls,
    get posts() { return calls.filter(c => c.method === 'POST'); },
    advance(ms = 5001) { time += ms; },
    switchAccount(value) { accountId = value; token = `SYNTHETIC_ACCESS_${value}`; },
    refreshToken() { token = 'SYNTHETIC_ACCESS_REFRESHED'; },
    async prepare(s = service) { const i = await s.inspect(); return s.prepare({ creditRef: i.credits[0].ref }); },
    consume(s, challenge) { return s.consume({ challengeId: challenge.challengeId, acknowledged: true }); },
    async stored() { return JSON.parse(await fs.readFile(storeFile, 'utf8')); },
  };
}

test('factory requires an explicit transport and absolute host-owned protection path', () => {
  for (const opts of [{}, { createService }, { createService, storeFile: 'relative.json', fetch() {} },
    { createService, storeFile: path.resolve('synthetic.json') },
    { createService, storeFile: path.resolve('synthetic.json'), fetch() {}, validateDispatch: true }]) {
    assert.throws(() => createDurableSubscriptionResetService(opts), isCode('RESET_OPTIONS_INVALID'));
  }
});

test('upstream delay, explicit acknowledgement, and private opaque DTOs remain intact', async t => {
  const f = await fixture(t), c = await f.prepare();
  await assert.rejects(f.consume(f.service, c), /Wait before confirming/);
  f.advance();
  await assert.rejects(f.service.consume({ challengeId: c.challengeId, acknowledged: false }), /acknowledge/);
  assert.equal(f.posts.length, 0);
  await assert.rejects(fs.stat(f.storeFile), { code: 'ENOENT' });
  assert(!JSON.stringify(c).includes('SYNTHETIC_CARD'));
  assert(!JSON.stringify(c).includes('SYNTHETIC_ACCOUNT'));
});

for (const code of ['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed']) {
  test(`recognized ${code} is settled; clear/restart/token refresh cannot replay the card`, async t => {
    const f = await fixture(t, { post: () => Response.json({ code, windows_reset: ['DO_NOT_PERSIST_WINDOW_TEXT'] }) });
    const c = await f.prepare(); f.advance();
    const value = await f.consume(f.service, c);
    assert.equal(value.code, code); assert.equal(f.posts.length, 1);
    const raw = await fs.readFile(f.storeFile, 'utf8'), saved = JSON.parse(raw);
    assert.equal(saved.claims[0].state, 'settled');
    assert.deepEqual(saved.claims[0].result, { code, windowsResetCount: 1 });
    for (const forbidden of ['SYNTHETIC_ACCESS', 'SYNTHETIC_ACCOUNT', 'SYNTHETIC_CARD', 'DO_NOT_PERSIST_WINDOW_TEXT']) assert(!raw.includes(forbidden));
    f.service.clear(); f.refreshToken(); f.advance(120000);
    const again = f.make(), c2 = await f.prepare(again); f.advance();
    await assert.rejects(f.consume(again, c2), isCode('RESET_CLAIM_PAUSED', false));
    assert.equal(f.posts.length, 1);
  });
}

for (const [name, post] of [
  ['transport exception', () => { throw new Error('SYNTHETIC_PRIVATE_UPSTREAM_ERROR'); }],
  ['HTTP 500', () => new Response('', { status: 500 })],
  ['HTTP 401', () => new Response('', { status: 401 })],
  ['HTTP 429', () => new Response('', { status: 429 })],
  ['unreadable body', () => new Response('not JSON')],
  ['unknown code', () => Response.json({ code: 'unknown_future_code' })],
]) {
  test(`${name} stays claimed and cannot be retried even with same challenge or after restart`, async t => {
    const f = await fixture(t, { post }), c = await f.prepare(); f.advance();
    await assert.rejects(f.consume(f.service, c), isCode('RESET_UNCERTAIN', false));
    assert.equal((await f.stored()).claims[0].state, 'claimed');
    assert.equal(f.posts.length, 1);
    // The old factory may keep an uncertain challenge or delete it. Both are safe.
    await assert.rejects(f.consume(f.service, c));
    f.service.clear(); f.advance(120000);
    const again = f.make(), c2 = await f.prepare(again); f.advance();
    await assert.rejects(f.consume(again, c2), isCode('RESET_CLAIM_PAUSED', false));
    assert.equal(f.posts.length, 1);
  });
}

test('claim is synced on disk BEFORE dispatch, even when upstream has not replied', async t => {
  let release;
  const reply = new Promise(resolve => { release = resolve; });
  let entered;
  const sent = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { post: async () => { entered(); return reply; } });
  const c = await f.prepare(); f.advance();
  const pending = f.consume(f.service, c); await sent;
  const stored = await f.stored(); assert.equal(stored.claims[0].state, 'claimed');
  assert.equal(stored.claims[0].key, keyOf('SYNTHETIC_ACCOUNT_A', 'SYNTHETIC_CARD'));
  const again = f.make(), c2 = await f.prepare(again); f.advance();
  await assert.rejects(f.consume(again, c2), isCode('RESET_CLAIM_PAUSED', false));
  release(Response.json({ code: 'reset' })); await pending;
  assert.equal(f.posts.length, 1);
});

test('concurrent runtimes obtain at most one claim and one POST', async t => {
  const f = await fixture(t), second = f.make();
  const a = await f.prepare(), b = await f.prepare(second); f.advance();
  const results = await Promise.allSettled([f.consume(f.service, a), f.consume(second, b)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  const errors = results.filter(x => x.status === 'rejected').map(x => x.reason.code);
  assert(errors.every(code => ['RESET_STORE_LOCKED', 'RESET_CLAIM_PAUSED'].includes(code)));
  assert.equal(f.posts.length, 1);
});

test('same card ID belongs to separate account claims; new account never inherits old request', async t => {
  const f = await fixture(t), a = await f.prepare(); f.advance(); await f.consume(f.service, a);
  f.service.clear(); f.switchAccount('SYNTHETIC_ACCOUNT_B');
  const b = await f.prepare(); f.advance(); await f.consume(f.service, b);
  assert.equal(f.posts.length, 2); assert.equal((await f.stored()).claims.length, 2);
  assert.notEqual(JSON.parse(f.posts[0].body).redeem_request_id, JSON.parse(f.posts[1].body).redeem_request_id);
});

test('recognizes old engine v1 claimed and settled protection, preserving it byte-for-byte', async t => {
  const f = await fixture(t);
  for (const state of ['claimed', 'settled']) {
    const row = { key: keyOf('SYNTHETIC_ACCOUNT_A', 'SYNTHETIC_CARD'), requestId: randomUUID(), state, at: 1800000000000,
      ...(state === 'settled' ? { result: { code: 'already_redeemed', windowsResetCount: 0 } } : {}) };
    const raw = JSON.stringify({ version: 1, claims: [row] }); await fs.writeFile(f.storeFile, raw);
    f.service.clear(); const c = await f.prepare(); f.advance();
    await assert.rejects(f.consume(f.service, c), isCode('RESET_CLAIM_PAUSED', false));
    assert.equal(await fs.readFile(f.storeFile, 'utf8'), raw);
  }
  assert.equal(f.posts.length, 0);
});

for (const [name, content] of [
  ['invalid JSON', '{'], ['wrong version', JSON.stringify({ version: 2, claims: [] })],
  ['oversized file', ' '.repeat(524289)], ['unexpected fields', JSON.stringify({ version: 1, claims: [], autoRetry: true })],
  ['invalid claim', JSON.stringify({ version: 1, claims: [{ key: 'bad', requestId: 'bad', state: 'claimed', at: 1 }] })],
]) {
  test(`${name} fails closed, never silently empties store or dispatches`, async t => {
    const f = await fixture(t); await fs.writeFile(f.storeFile, content);
    const c = await f.prepare(); f.advance();
    await assert.rejects(f.consume(f.service, c), isCode('RESET_STORE_UNAVAILABLE', true));
    assert.equal(await fs.readFile(f.storeFile, 'utf8'), content); assert.equal(f.posts.length, 0);
  });
}

test('pre-existing lock is never stolen or removed and no POST is sent', async t => {
  const f = await fixture(t); await fs.writeFile(f.storeFile + '.lock', 'SYNTHETIC_STALE_LOCK');
  const c = await f.prepare(); f.advance();
  await assert.rejects(f.consume(f.service, c), isCode('RESET_STORE_LOCKED', true));
  assert.equal(await fs.readFile(f.storeFile + '.lock', 'utf8'), 'SYNTHETIC_STALE_LOCK');
  assert.equal(f.posts.length, 0);
});

test('capacity exhaustion does not prune previous claims or dispatch', async t => {
  const f = await fixture(t);
  const claims = Array.from({ length: 2048 }, (_, n) => ({ key: n.toString(16).padStart(64, '0'), requestId: randomUUID(), state: 'claimed', at: 1 }));
  const raw = JSON.stringify({ version: 1, claims }); await fs.writeFile(f.storeFile, raw);
  const c = await f.prepare(); f.advance();
  await assert.rejects(f.consume(f.service, c), isCode('RESET_STORE_FULL', true));
  assert.equal(await fs.readFile(f.storeFile, 'utf8'), raw); assert.equal(f.posts.length, 0);
});

for (const valid of [false, Promise.resolve(true)]) {
  test(`final dispatch guard requires synchronous literal true (${typeof valid})`, async t => {
    const f = await fixture(t), s = f.make({ validateDispatch: () => valid });
    const c = await f.prepare(s); f.advance();
    await assert.rejects(f.consume(s, c), isCode('RESET_IDENTITY_CHANGED', true));
    assert.equal(f.posts.length, 0); assert.equal((await f.stored()).claims[0].state, 'claimed');
    s.clear(); const c2 = await f.prepare(s); f.advance();
    await assert.rejects(f.consume(s, c2), isCode('RESET_CLAIM_PAUSED', false));
  });
}

test('clear during synchronous final guard prevents dispatch, but keeps the durable claim', async t => {
  const f = await fixture(t); let s;
  s = f.make({ validateDispatch: () => { s.clear(); return true; } });
  const c = await f.prepare(s); f.advance();
  await assert.rejects(f.consume(s, c), isCode('RESET_IDENTITY_CHANGED', true));
  assert.equal(f.posts.length, 0); assert.equal((await f.stored()).claims.length, 1);
});

test('clear after dispatch aborts signal, rejects stale success and keeps no-replay protection', async t => {
  let release, entered;
  const reply = new Promise(resolve => { release = resolve; }), sent = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { post: () => { entered(); return reply; } });
  const c = await f.prepare(); f.advance(); const pending = f.consume(f.service, c); await sent;
  f.service.clear(); assert.equal(f.posts[0].signal.aborted, true);
  release(Response.json({ code: 'reset' }));
  await assert.rejects(pending, isCode('RESET_UNCERTAIN', false));
  const again = f.make(), c2 = await f.prepare(again); f.advance();
  await assert.rejects(f.consume(again, c2), isCode('RESET_CLAIM_PAUSED', false)); assert.equal(f.posts.length, 1);
});

test('settlement write failure cannot report success or reopen a dispatched claim', async t => {
  let release, entered;
  const reply = new Promise(resolve => { release = resolve; }), sent = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { post: () => { entered(); return reply; } });
  const c = await f.prepare(); f.advance(); const pending = f.consume(f.service, c); await sent;
  const claimed = await fs.readFile(f.storeFile, 'utf8');
  await fs.writeFile(f.storeFile + '.lock', 'SYNTHETIC_EXTERNAL_LOCK');
  release(Response.json({ code: 'reset' }));
  await assert.rejects(pending, isCode('RESET_UNCERTAIN', false));
  assert.equal(await fs.readFile(f.storeFile, 'utf8'), claimed);
  assert.equal(f.posts.length, 1);
  assert.equal(await fs.readFile(f.storeFile + '.lock', 'utf8'), 'SYNTHETIC_EXTERNAL_LOCK');
});

test('cancellation during final dispatch check preserves claim without sending', async t => {
  const f = await fixture(t), cancellation = new AbortController();
  const s = f.make({ validateDispatch: () => { cancellation.abort(); return true; } });
  const c = await f.prepare(s); f.advance();
  await assert.rejects(s.consume({ challengeId: c.challengeId, acknowledged: true, signal: cancellation.signal }), isCode('RESET_CANCELLED', true));
  assert.equal(f.posts.length, 0); assert.equal((await f.stored()).claims[0].state, 'claimed');
});

test('throwing dispatch validator reports safe identity error rather than private exception', async t => {
  const f = await fixture(t), s = f.make({ validateDispatch: () => { throw new Error('SYNTHETIC_PRIVATE_IDENTITY'); } });
  const c = await f.prepare(s); f.advance();
  await assert.rejects(f.consume(s, c), isCode('RESET_IDENTITY_CHANGED', true));
  assert.equal(f.posts.length, 0); assert.equal((await f.stored()).claims.length, 1);
});

test('preexisting directory at store path fails closed instead of replacing data', async t => {
  const f = await fixture(t); await fs.mkdir(f.storeFile);
  const c = await f.prepare(); f.advance();
  await assert.rejects(f.consume(f.service, c), isCode('RESET_STORE_UNAVAILABLE', true));
  assert.equal((await fs.stat(f.storeFile)).isDirectory(), true); assert.equal(f.posts.length, 0);
});

test('cancelled calls and disposed services do not send or remove protection', async t => {
  const f = await fixture(t), c = await f.prepare(); f.advance();
  const cancellation = new AbortController(); cancellation.abort();
  await assert.rejects(f.service.consume({ challengeId: c.challengeId, acknowledged: true, signal: cancellation.signal }), isCode('RESET_CANCELLED', true));
  assert.equal(f.posts.length, 0); await assert.rejects(fs.stat(f.storeFile), { code: 'ENOENT' });
  f.service.dispose(); await assert.rejects(f.service.inspect(), isCode('RESET_CLOSED', true));
});
