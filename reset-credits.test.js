import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createResetCredits } from './codex-accounts/reset-credits.js';

// ALL fetches are injected mocks. Every writable path is a fresh private fixture.
const endpoint = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const identity = Object.freeze({ accountKey: 'fixed-key', epoch: 7,bindingInstance:'private-row-1', accountId: 'private-account', access: 'private-token' });
const creditId = 'private-credit';
const json = (x, init) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' }, ...init });
const listing = () => ({ available_count: 1, credits: [{ id: creditId, status: 'available', title: identity.access, description: identity.accountId }] });
const error = (code, notSent = true) => e => { assert.equal(e.message, code); assert.equal(e.code, code); assert.equal(e.requestNotSent, notSent); assert.equal(e.cause, undefined); return true; };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reset-credits-test-'));
  if (process.platform !== 'win32') await fs.chmod(dir, 0o700);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let clock = 1800000000000;
  const calls = [], services = [];
  const file = path.join(dir, 'claims.json');
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return options.fetch ? options.fetch(url, init) : init.method === 'GET' ? json(listing()) : json({ code: 'reset', windows_reset: ['private-window'] });
  };
  const make = (overrides = {}) => {
    const s = createResetCredits({ storeFile: file, fetchImpl, now: () => clock, validate: () => true, revalidate: () => true, ...overrides });
    services.push(s); return s;
  };
  t.after(() => services.forEach(s => s.dispose()));
  const service = make(options.service);
  return { dir, file, calls, service, make, advance: n => { clock += n; }, clock: () => clock,
    async prepare(s = service, who = identity) {
      const view = await s.inspect({ identity: who });
      const challenge = await s.prepare({ identity: who, creditRef: view.credits[0].ref });
      return { view, challenge };
    },
  };
}
const redeem = (s, challenge, extra = {}) => s.consume({ identity, challengeId: challenge.challengeId, acknowledged: true, ...extra });

test('fixed protocol, opaque DTOs, safe result and durable pre-dispatch claim', async t => {
  let file, requestId;
  const f = await fixture(t, { fetch: async (url, init) => {
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, `Bearer ${identity.access}`);
    assert.equal(init.headers['chatgpt-account-id'], identity.accountId);
    if (init.method === 'GET') { assert.equal(url, endpoint); return json(listing()); }
    assert.equal(url, `${endpoint}/consume`);
    const body = JSON.parse(init.body); assert.equal(body.credit_id, creditId);
    const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(persisted.claims.length, 1); assert.equal(persisted.claims[0].state, 'claimed');
    assert.equal(persisted.claims[0].requestId, body.redeem_request_id); requestId = body.redeem_request_id;
    return json({ code: 'reset', windows_reset: ['secret-window'], token: identity.access, message: creditId });
  } }); file = f.file;
  const { view, challenge } = await f.prepare();
  assert.equal(challenge.readyAt, f.clock() + 5000); assert.equal(challenge.expiresAt, f.clock() + 60000);
  assert.equal(challenge.acknowledgementRequired, true);
  await assert.rejects(fs.access(file), e => e.code === 'ENOENT'); // inspect/prepare are disk read-only
  f.advance(5000);
  const result = await redeem(f.service, challenge);
  assert.deepEqual(result, { code: 'reset', windowsResetCount: 1 });
  const persisted = await fs.readFile(file, 'utf8');
  assert.equal(JSON.parse(persisted).claims[0].state, 'settled');
  for (const secret of [identity.access, identity.accountId, creditId, requestId, 'secret-window']) {
    assert.ok(!JSON.stringify({ view, challenge, result }).includes(secret));
    if (secret !== requestId) assert.ok(!persisted.includes(secret));
  }
  await assert.rejects(redeem(f.service, challenge), error('RESET_ALREADY_USED'));
  assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 1);
});

test('five-second delay, explicit ack, exact TTL and expired challenges', async t => {
  const f = await fixture(t); const { challenge } = await f.prepare();
  await assert.rejects(redeem(f.service, challenge), error('RESET_WAIT_REQUIRED'));
  f.advance(4999); await assert.rejects(redeem(f.service, challenge), error('RESET_WAIT_REQUIRED'));
  f.advance(1); await assert.rejects(redeem(f.service, challenge, { acknowledged: 'true' }), error('RESET_ACK_REQUIRED'));
  f.advance(55000); await assert.rejects(redeem(f.service, challenge), error('RESET_CHALLENGE_EXPIRED'));
  assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 0);
});

test('prepare reuse does not bypass delay or extend TTL', async t => {
  const f = await fixture(t); const { view, challenge } = await f.prepare(); f.advance(1000);
  assert.deepEqual(await f.service.prepare({ identity, creditRef: view.credits[0].ref }), challenge);
});

test('refs and challenges bind all of accountKey, epoch and accountId; no fallback', async t => {
  const f = await fixture(t); const { view, challenge } = await f.prepare(); f.advance(5000);
  for (const who of [{ ...identity, epoch: 8 },{ ...identity,bindingInstance:'private-rebound-row' }, { ...identity, accountKey: 'other-key' }, { ...identity, accountId: 'other-account' }]) {
    await assert.rejects(f.service.prepare({ identity: who, creditRef: view.credits[0].ref }), error('RESET_CARD_INVALID'));
    await assert.rejects(redeem(f.service, challenge, { identity: who }), error('RESET_CHALLENGE_INVALID'));
  }
  // A fresh access value for the same captured identity is allowed.
  await redeem(f.service, challenge, { identity: { ...identity, access: 'fresh-private-token' } });
  assert.equal(f.calls.at(-1).init.headers.authorization, 'Bearer fresh-private-token');
});

test('same-instance simultaneous consume has exactly one POST', async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, { fetch: (url, init) => {
    if (init.method === 'GET') return json(listing());
    started.resolve(); return gate.promise;
  } });
  const { challenge } = await f.prepare(); f.advance(5000);
  const pending = redeem(f.service, challenge); await started.promise;
  await assert.rejects(redeem(f.service, challenge), error('RESET_IN_PROGRESS'));
  gate.resolve(json({ code: 'reset' })); await pending;
  assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 1);
});

test('independent services serialize through exclusive file lock and hash claim', async t => {
  const f = await fixture(t), other = f.make();
  const a = await f.prepare(), b = await f.prepare(other); f.advance(5000);
  const settled = await Promise.allSettled([redeem(f.service, a.challenge), redeem(other, b.challenge)]);
  assert.equal(settled.filter(x => x.status === 'fulfilled').length, 1);
  error('RESET_CLAIM_PAUSED', false)(settled.find(x => x.status === 'rejected').reason);
  assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 1);
});

for (const code of ['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed']) {
  test(`only allowlisted consume status ${code} is accepted`, async t => {
    const f = await fixture(t, { fetch: (_, init) => init.method === 'GET' ? json(listing()) : json({ code, windows_reset: 2 }) });
    const { challenge } = await f.prepare(); f.advance(5000);
    assert.deepEqual(await redeem(f.service, challenge), { code, windowsResetCount: 2 });
  });
}

for (const [label, response] of [
  ['unknown code', () => json({ code: 'success', message: identity.access })],
  ['missing code', () => json({ ok: true })],
  ['HTTP 401', () => json({ token: identity.access }, { status: 401 })],
  ['HTTP 503', () => json({}, { status: 503 })],
  ['invalid JSON', () => new Response('private-token-not-json', { headers: { 'content-type': 'application/json' } })],
  ['oversized response', () => new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } })],
  ['transport throw', () => { throw new Error(identity.access); }],
]) {
  test(`POST ${label} is permanently uncertain across restart and epoch/rebind`, async t => {
    const f = await fixture(t, { fetch: (_, init) => init.method === 'GET' ? json(listing()) : response() });
    const { challenge } = await f.prepare(); f.advance(5000);
    await assert.rejects(redeem(f.service, challenge), error('RESET_UNCERTAIN', false));
    await assert.rejects(redeem(f.service, challenge), error('RESET_CLAIM_PAUSED', false));
    const restarted = f.make(), who = { ...identity, accountKey: 'rebound-key', epoch: 99 };
    const view = await restarted.inspect({ identity: who }); assert.equal(view.credits[0].paused, true);
    await assert.rejects(restarted.prepare({ identity: who, creditRef: view.credits[0].ref }), error('RESET_CLAIM_PAUSED', false));
    assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 1);
  });
}

test('real process exit at dispatch leaves durable claim, not a new request on restart', async t => {
  const f = await fixture(t);
  const moduleURL = new URL('./codex-accounts/reset-credits.js', import.meta.url).href;
  const script = `import {createResetCredits} from ${JSON.stringify(moduleURL)};
    let n=1800000000000;const identity=${JSON.stringify(identity)};
    const s=createResetCredits({storeFile:${JSON.stringify(f.file)},now:()=>n,validate:()=>true,revalidate:()=>true,
      fetchImpl:async(_,o)=>{if(o.method==='POST')process.exit(73);return new Response(${JSON.stringify(JSON.stringify(listing()))},{headers:{'content-type':'application/json'}})}});
    const v=await s.inspect({identity});const c=await s.prepare({identity,creditRef:v.credits[0].ref});n+=5000;
    await s.consume({identity,challengeId:c.challengeId,acknowledged:true});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit', timeout: 10000 });
  assert.ifError(child.error); assert.equal(child.status, 73);
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).claims[0].state, 'claimed');
  const { credits } = await f.service.inspect({ identity }); assert.equal(credits[0].paused, true);
  await assert.rejects(f.service.prepare({ identity, creditRef: credits[0].ref }), error('RESET_CLAIM_PAUSED', false));
  assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 0);
});

test('cancel before dispatch is not sent; persisted preflight claim stays paused', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { service: { validate: (_, { phase }) => { if (phase === 'consume-dispatch') controller.abort(new Error(identity.access)); return true; } } });
  const { challenge } = await f.prepare(); f.advance(5000);
  await assert.rejects(redeem(f.service, challenge, { signal: controller.signal }), error('RESET_CANCELLED'));
  assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 0);
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).claims[0].state, 'claimed');
  await assert.rejects(redeem(f.service, challenge), error('RESET_CLAIM_PAUSED', false));
});

test('already aborted signal does not start GET or POST', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort(identity.access);
  await assert.rejects(f.service.inspect({ identity, signal: controller.signal }), error('RESET_CANCELLED'));
  assert.equal(f.calls.length, 0);
});

test('abort after POST invocation is uncertain, not requestNotSent', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { fetch: (_, init) => {
    if (init.method === 'GET') return json(listing());
    controller.abort(new Error(identity.access)); return new Promise(() => {});
  } });
  const { challenge } = await f.prepare(); f.advance(5000);
  await assert.rejects(redeem(f.service, challenge, { signal: controller.signal }), error('RESET_UNCERTAIN', false));
});

test('async validator and synchronous dispatch revalidator are both enforced', async t => {
  let valid = true, final = true;
  const f = await fixture(t, { service: { validate: async () => valid, revalidate: () => final } });
  const { challenge } = await f.prepare(); f.advance(5000);
  valid = false; await assert.rejects(redeem(f.service, challenge), error('RESET_IDENTITY_CHANGED'));
  await assert.rejects(fs.access(f.file), e => e.code === 'ENOENT');
  valid = true; final = false;
  await assert.rejects(redeem(f.service, challenge), error('RESET_IDENTITY_CHANGED'));
  assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 0);
  const asyncFinal = f.make({ revalidate: async () => true });
  await assert.rejects(asyncFinal.inspect({ identity }), error('RESET_IDENTITY_CHANGED'));
});

test('dispose aborts a pending GET even when mock fetch ignores signal', async t => {
  const started = deferred();
  const f = await fixture(t, { fetch: () => { started.resolve(); return new Promise(() => {}); } });
  const pending = f.service.inspect({ identity }); await started.promise; f.service.dispose();
  await assert.rejects(pending, error('RESET_CLOSED'));
  await assert.rejects(f.service.inspect({ identity }), error('RESET_CLOSED'));
});

test('dispose after dispatch aborts pending POST and preserves uncertain claim', async t => {
  const started = deferred();
  const f = await fixture(t, { fetch: (_, init) => {
    if (init.method === 'GET') return json(listing());
    started.resolve(); return new Promise(() => {});
  } });
  const { challenge } = await f.prepare(); f.advance(5000);
  const pending = redeem(f.service, challenge); await started.promise; f.service.dispose();
  await assert.rejects(pending, error('RESET_UNCERTAIN', false));
  assert.equal((await f.make().inspect({ identity })).credits[0].paused, true);
});

test('timeout bounds fetch and POST uncertainty even if transport ignores abort', async t => {
  const f = await fixture(t, { service: { timeoutMs: 20 }, fetch: (_, init) => init.method === 'GET' ? json(listing()) : new Promise(() => {}) });
  const { challenge } = await f.prepare(); f.advance(5000);
  await assert.rejects(redeem(f.service, challenge), error('RESET_UNCERTAIN', false));
  const hangingGET = f.make({ timeoutMs: 20, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(hangingGET.inspect({ identity }), error('RESET_TIMEOUT'));
});

test('timeout also bounds body streaming and cancels stalled reader', async t => {
  let cancelled = false;
  const f = await fixture(t, { service: { timeoutMs: 20 }, fetch: () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(f.service.inspect({ identity }), error('RESET_TIMEOUT'));
  assert.equal(cancelled, true);
});

for (const [label, response] of [
  ['oversized content-length', () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '65537' } })],
  ['oversized stream', () => new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } })],
  ['invalid utf8', () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } })],
  ['wrong content type', () => new Response('{}', { headers: { 'content-type': 'text/html' } })],
  ['bad count', () => json({ available_count: 129, credits: [] })],
  ['duplicate ids', () => json({ available_count: 2, credits: [listing().credits[0], listing().credits[0]] })],
  ['invalid expiration', () => json({ available_count: 1, credits: [{ id: creditId, status: 'available', expires_at: 'not-a-date' }] })],
]) {
  test(`GET rejects ${label} with a safe fixed error`, async t => {
    const f = await fixture(t, { fetch: response });
    await assert.rejects(f.service.inspect({ identity }), error('RESET_RESPONSE_INVALID'));
  });
}

test('no credits, expired credits, earliest-expiring selection and card freshness', async t => {
  let raw = { available_count: 0, credits: [] };
  const f = await fixture(t, { fetch: (_, init) => init.method === 'GET' ? json(raw) : json({ code: 'reset' }) });
  assert.deepEqual(await f.service.inspect({ identity }), { availableCount: 0, credits: [] });
  raw = { available_count: 3, credits: [
    { id: 'late', status: 'available', expires_at: new Date(f.clock() + 50000).toISOString() },
    { id: 'expired', status: 'available', expires_at: (f.clock() - 1000) / 1000 },
    { id: 'early', status: 'AVAILABLE', expires_at: (f.clock() + 10000) / 1000 },
  ] };
  const view = await f.service.inspect({ identity }); assert.equal(view.credits.length, 2);
  assert.equal(view.credits[0].expiresAt, f.clock() + 10000);
  const c = await f.service.prepare({ identity, creditRef: view.credits[0].ref }); assert.equal(c.expiresAt, f.clock() + 10000);
  f.advance(5000); await redeem(f.service, c);
  assert.equal(JSON.parse(f.calls.at(-1).init.body).credit_id, 'early');
  const stale = view.credits[1].ref; raw = { available_count: 0, credits: [] };
  await assert.rejects(f.service.prepare({ identity, creditRef: stale }), error('RESET_CARD_INVALID'));
});

test('too-soon expiry and stale opaque refs cannot prepare', async t => {
  let expiration;
  const f = await fixture(t, { fetch: () => json({ available_count: 1, credits: [{ id: creditId, status: 'available', expires_at: expiration }] }) });
  expiration = (f.clock() + 5000) / 1000;
  const view = await f.service.inspect({ identity });
  await assert.rejects(f.service.prepare({ identity, creditRef: view.credits[0].ref }), error('RESET_CARD_EXPIRES_SOON'));
  expiration = undefined;
  const second = await f.service.inspect({ identity }); f.advance(60000);
  await assert.rejects(f.service.prepare({ identity, creditRef: second.credits[0].ref }), error('RESET_CARD_INVALID'));
});

test('corrupt or oversized store fails closed; never overwrites protection', async t => {
  const f = await fixture(t);
  for (const bytes of ['not-json', JSON.stringify({ version: 1, claims: [{ key: ['a'.repeat(64)], requestId: 'e338ff4c-4169-44c3-80d4-d9b0194c88fd', state: 'claimed', at: 1 }] }), 'x'.repeat(524289)]) {
    await fs.writeFile(f.file, bytes);
    await assert.rejects(f.service.inspect({ identity }), error('RESET_STORE_UNAVAILABLE'));
    assert.equal(await fs.readFile(f.file, 'utf8'), bytes);
  }
});

test('stale lock is not stolen; no POST on lock timeout', async t => {
  const f = await fixture(t); const { challenge } = await f.prepare(); f.advance(5000);
  await fs.writeFile(`${f.file}.lock`, 'private-fixture-lock');
  await assert.rejects(redeem(f.service, challenge), error('RESET_STORE_LOCKED'));
  assert.equal(await fs.readFile(`${f.file}.lock`, 'utf8'), 'private-fixture-lock');
  assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 0);
});

test('new card refs produce separately bound challenges but cannot double-spend', async t => {
  const f = await fixture(t); const a = await f.prepare(), b = await f.prepare();
  assert.notEqual(a.view.credits[0].ref, b.view.credits[0].ref);
  assert.notEqual(a.challenge.challengeId, b.challenge.challengeId);
  assert.equal(a.challenge.creditRef, a.view.credits[0].ref);
  assert.equal(b.challenge.creditRef, b.view.credits[0].ref);
  f.advance(5000); await redeem(f.service, a.challenge);
  await assert.rejects(redeem(f.service, b.challenge), error('RESET_CLAIM_PAUSED', false));
  const restarted = f.make(); const view = await restarted.inspect({ identity });
  assert.equal(view.credits[0].paused, true);
  await assert.rejects(restarted.prepare({ identity, creditRef: view.credits[0].ref }), error('RESET_CLAIM_PAUSED', false));
  assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 1);
});

test('expiry during persistence/revalidation stops POST but retains protective claim', async t => {
  let f;
  f = await fixture(t, { service: { validate: (_, { phase }) => { if (phase === 'consume-dispatch') f.advance(60000); return true; } } });
  const { challenge } = await f.prepare(); f.advance(5000);
  await assert.rejects(redeem(f.service, challenge), error('RESET_CHALLENGE_EXPIRED'));
  assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 0);
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).claims[0].state, 'claimed');
});

test('epoch change after POST cannot return stale success or permit another redemption', async t => {
  const f = await fixture(t, { service: { validate: (_, { phase }) => phase !== 'consume-result' } });
  const { challenge } = await f.prepare(); f.advance(5000);
  await assert.rejects(redeem(f.service, challenge), error('RESET_UNCERTAIN', false));
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).claims[0].state, 'settled');
  assert.equal((await f.make().inspect({ identity })).credits[0].paused, true);
});

test('store capacity fails closed rather than dropping old claims', async t => {
  const f = await fixture(t); const { challenge } = await f.prepare(); f.advance(5000);
  const claims = Array.from({ length: 2048 }, (_, n) => ({ key: n.toString(16).padStart(64, '0'), requestId: 'e338ff4c-4169-44c3-80d4-d9b0194c88fd', state: 'claimed', at: 1 }));
  await fs.writeFile(f.file, JSON.stringify({ version: 1, claims }));
  await assert.rejects(redeem(f.service, challenge), error('RESET_STORE_FULL'));
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).claims.length, 2048);
  assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 0);
});

test('persistence failure blocks dispatch and never exposes filesystem messages', async t => {
  const f = await fixture(t); const { challenge } = await f.prepare(); f.advance(5000);
  await fs.mkdir(f.file);
  await assert.rejects(redeem(f.service, challenge), error('RESET_STORE_UNAVAILABLE'));
  assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 0);
});

test('factory requires explicit mockable transport and validators; malformed identity is safe', async t => {
  assert.throws(() => createResetCredits(), error('RESET_OPTIONS_INVALID'));
  const f = await fixture(t);
  for (const who of [undefined, { ...identity, epoch: 0 }, { ...identity, accountId: 'id\nsecret' }, { ...identity, access: '' }]) {
    await assert.rejects(f.service.inspect({ identity: who }), error('RESET_IDENTITY_INVALID'));
  }
  await assert.rejects(f.service.inspect({ identity, signal: {} }), error('RESET_SIGNAL_INVALID'));
  const badClock = f.make({ now: () => { throw new Error(identity.access); } });
  await assert.rejects(badClock.inspect({ identity }), error('RESET_CLOCK_INVALID'));
  assert.equal(f.calls.length, 0);
});
