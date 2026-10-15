import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_MULTI_WARMUP, MULTI_WARMUP_TRIGGERS, multiWarmupConfig, MultiWarmupStore, MultiWarmupScheduler, multiWarmupHandler } from './multi-warmup.js';

// No host, credentials, network, quota or model adapter is used. Every persistent
// artifact belongs to a newly allocated privateTemp directory and is removed.
const BASE = new Date(2026, 9, 6, 9, 29, 50).getTime();
const DUE = new Date(2026, 9, 6, 9, 30, 0).getTime();
const DAY = '2026-10-06';
const SECRET = 'RAW_ACCOUNT_alice@example.invalid_PRIVATE_UPSTREAM';
const account = (n = 1, patch = {}) => ({ accountKey: n.toString(16).padStart(16, '0'), modelKey: n.toString(16).padStart(64, '0'), enabled: true, allowUnverifiedQuota: true, ...patch });
const config = (accounts = [account()], patch = {}) => ({ enabled: true, time: '09:30', accounts, ...patch });
const document = (cfg = config(), attempts = [], paused = false) => ({ version: 1, config: cfg, attempts, paused });
const attempt = (patch = {}) => ({ day: DAY, accountKey: account().accountKey, modelKey: account().modelKey, status: 'succeeded', attemptedAt: DUE, finishedAt: DUE + 1, ...patch });
const catalogue = cfg => ({ accounts: cfg.accounts.map(row => ({ accountKey: row.accountKey, models: [{ modelKey: row.modelKey, modelName: 'mock-model' }] })) });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const clone = value => structuredClone(value);
const hasStatus = expected => error => { assert.equal(error.status, expected); assert.ok(!error.message.includes(SECRET)); return true; };

async function privateTemp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-multi-warmup-test-'));
  const file = path.join(root, 'multi.json');
  t.after(async () => {
    // Refuse cleanup unless the exact, freshly-created child is still in temp.
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('dsh-multi-warmup-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, file, store: new MultiWarmupStore(file), async seed(data) { await fs.writeFile(file, JSON.stringify(data)); } };
}
async function configured(t, cfg = config()) {
  const f = await privateTemp(t); await f.store.configure(cfg, 'missing'); return f;
}
function memoryStore(cfg = config(), options = {}) {
  let data = document(clone(cfg), clone(options.attempts ?? []), options.paused ?? false);
  const events = [];
  return {
    events, get data() { return data; },
    async read() { events.push('read'); if (options.readError) throw options.readError; return { data: clone(data), revision: 'a'.repeat(64) }; },
    async claim(row, day, now, expected) {
      events.push(`claim:${row.accountKey}`);
      if (options.claimError) throw options.claimError;
      if (options.claimFalse || data.paused || JSON.stringify(data.config) !== JSON.stringify(expected)
        || data.attempts.some(item => item.day === day && item.accountKey === row.accountKey)) return false;
      data.attempts.push({ day, accountKey: row.accountKey, modelKey: row.modelKey, status: 'claimed', attemptedAt: now });
      if (options.afterClaim) options.afterClaim();
      return true;
    },
    async finish(row, day, status, now) {
      events.push(`finish:${status}`); if (options.finishError) throw options.finishError;
      const item = data.attempts.find(item => item.day === day && item.accountKey === row.accountKey);
      Object.assign(item, { status, finishedAt: now }); data.paused = status === 'unknown';
    },
    setConfig(value) { data.config = clone(value); },
  };
}
function fixture(options = {}) {
  const cfg = options.config ?? config();
  let now = BASE, ctx = { bridge: {}, generation: 1, ...options.contextValue };
  const calls = [], discoveries = [], changes = [];
  const store = options.store ?? memoryStore(cfg, options.storeOptions);
  const scheduler = new MultiWarmupScheduler({ store, context: options.context ?? (() => ctx),
    discover: async args => { discoveries.push(args); return options.discover ? options.discover(args) : catalogue(cfg); },
    run: async args => { calls.push(args); store.events?.push(`run:${args.accountKey}`); return options.run?.(args); },
    signal: options.signal, clock: () => now, claimLease: options.claimLease,
    onChange: view => changes.push(clone(view)),
  });
  return { scheduler, store, calls, discoveries, changes,
    setContext(value) { ctx = value; }, get context() { return ctx; },
    async tick(at = now) { now = at; return scheduler.tick(at); },
    async fire() { await this.tick(BASE); await this.tick(DUE); },
  };
}
function request(method = 'GET', body, headers = { 'content-type': 'application/json' }) {
  return { method, headers, async *[Symbol.asyncIterator]() {
    if (body !== undefined) yield Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  } };
}
async function http(options = {}) {
  const events = [];
  const cfg = config();
  const store = options.store ?? {
    async read() { events.push('read'); return { data: document(cfg), revision: 'a'.repeat(64) }; },
    async configure(value, revision) { events.push(['configure', value, revision]); return { data: document(value), revision: 'b'.repeat(64) }; },
  };
  const ctx = { bridge: {}, generation: 1 };
  const handler = multiWarmupHandler({ store, context: options.context ?? (() => ctx),
    authorize: (req, res) => { events.push('authorize'); if (options.authorize === false) { res.writeHead(401, {}); res.end(); return false; } return true; },
    discover: async args => { events.push('discover'); return options.discover ? options.discover(args) : catalogue(cfg); },
    changed: () => events.push('changed'),
  });
  const result = { status: null, headers: null, raw: undefined };
  await handler(options.req ?? request(), { writeHead(status, headers) { result.status = status; result.headers = headers; }, end(body) { result.raw = body; } });
  return { ...result, body: result.raw ? JSON.parse(result.raw) : undefined, events };
}

test('trigger capabilities report daily support but never claim fresh startup/reset evidence', async () => {
  assert(Object.isFrozen(MULTI_WARMUP_TRIGGERS));
  assert.deepEqual(Object.keys(MULTI_WARMUP_TRIGGERS), ['daily','startupFull','resetFull','quotaEvidence','reason']);
  for (const method of ['GET','HEAD']) {
    const response = await http({ req: request(method), context() { throw Error('must not poll upstream'); } });
    assert.equal(response.status, 200); assert.deepEqual(response.events, ['authorize','read']);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    if (method === 'GET') {
      assert.deepEqual(response.body.triggers, MULTI_WARMUP_TRIGGERS);
      assert.equal(response.body.triggers.daily, true); assert.equal(response.body.triggers.startupFull, false); assert.equal(response.body.triggers.resetFull, false);
      assert.equal(response.body.triggers.quotaEvidence, 'unverifiable'); assert.match(response.body.triggers.reason, /force.*旧缓存/);
    }
  }
});
for (const key of ['startupFull','resetFull','startup','reset','triggers']) test(`forged ${key} cannot broaden daily consent or mutate durable grants`, async t => {
  const f = await configured(t), before = await fs.readFile(f.file);
  const response = await http({ store: f.store, req: request('PUT', { revision: (await f.store.read()).revision, config: { ...config(), [key]: key === 'triggers' ? { startupFull: true, resetFull: true } : true } }) });
  assert.equal(response.status, 400); assert.deepEqual(await fs.readFile(f.file), before); assert(!response.events.includes('discover')); assert(!response.events.includes('changed'));
});
test('saving daily authorization returns honest capabilities without persisting evidence or granting reset calls', async t => {
  const f = await privateTemp(t), response = await http({ store: f.store, req: request('PUT', { revision: 'missing', config: config() }) });
  assert.equal(response.status, 200); assert.deepEqual(response.body.triggers, MULTI_WARMUP_TRIGGERS);
  const durable = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.deepEqual(Object.keys(durable.config), ['enabled','time','accounts']); assert.deepEqual(durable.attempts, []);
  assert(!response.events.includes('discover'));
});
// Strict configuration and durable store.
test('default is disabled, immutable and missing private store performs no write', async t => {
  assert.deepEqual(DEFAULT_MULTI_WARMUP, { enabled: false, time: '09:30', accounts: [] });
  assert.ok(Object.isFrozen(DEFAULT_MULTI_WARMUP)); assert.ok(Object.isFrozen(DEFAULT_MULTI_WARMUP.accounts));
  const f = await privateTemp(t); const state = await f.store.read();
  assert.deepEqual(state, { data: document({ ...DEFAULT_MULTI_WARMUP, accounts: [] }), revision: 'missing' });
  assert.deepEqual(await fs.readdir(f.root), []);
});
test('strict config accepts eight explicit authorizations and copies the input', () => {
  const raw = config(Array.from({ length: 8 }, (_, i) => account(i + 1)));
  const actual = multiWarmupConfig(raw); assert.deepEqual(actual, raw);
  raw.accounts[0].enabled = false; assert.equal(actual.accounts[0].enabled, true);
});
const badConfigs = [
  ['null', null], ['array', []], ['unknown root field', { ...config(), paused: false }],
  ['enabled string', config(undefined, { enabled: 'true' })], ['missing enabled', { time: '09:30', accounts: [] }],
  ['nine accounts', config(Array.from({ length: 9 }, (_, i) => account(i + 1)))],
  ['duplicate account with different model', config([account(), account(1, { modelKey: 'f'.repeat(64) })])],
  ['enabled without an authorized account', config([])],
  ['all rows disabled', config([account(1, { enabled: false })])],
  ...['9:30', '24:00', '09:60', '09:30\n', '', 930, null].map(time => [`invalid time ${JSON.stringify(time)}`, config(undefined, { time })]),
  ...[
    { accountKey: 'a'.repeat(15) }, { accountKey: 'a'.repeat(17) }, { accountKey: 'A'.repeat(16) },
    { modelKey: 'a'.repeat(63) }, { modelKey: 'a'.repeat(65) }, { modelKey: 'Z'.repeat(64) },
    { enabled: 1 }, { allowUnverifiedQuota: 'true' }, { allowUnverifiedQuota: undefined }, { quota: 100 },
  ].map((patch, i) => [`invalid row ${i}`, config([account(1, patch)])]),
];
for (const [label, raw] of badConfigs) test(`strict config rejects ${label}`, () => assert.throws(() => multiWarmupConfig(raw), hasStatus(400)));
test('quota opt-in false is valid; missing opt-in is not silently consented', () => {
  assert.equal(multiWarmupConfig(config([account(1, { allowUnverifiedQuota: false })])).accounts[0].allowUnverifiedQuota, false);
  const row = account(); delete row.allowUnverifiedQuota;
  assert.throws(() => multiWarmupConfig(config([row])), hasStatus(400));
});
test('CAS stale revision does not overwrite bytes, attempts, or config', async t => {
  const f = await configured(t), original = await f.store.read();
  await f.store.configure(config(undefined, { time: '10:00' }), original.revision);
  const before = await fs.readFile(f.file);
  await assert.rejects(f.store.configure(config(undefined, { time: '11:00' }), original.revision), hasStatus(409));
  assert.deepEqual(await fs.readFile(f.file), before);
  await assert.rejects(f.store.configure(config(), SECRET), hasStatus(400));
});
test('two competing store instances accept only one CAS writer', async t => {
  const f = await privateTemp(t), second = new MultiWarmupStore(f.file);
  const values = await Promise.allSettled([f.store.configure(config(undefined, { time: '10:00' }), 'missing'), second.configure(config(undefined, { time: '11:00' }), 'missing')]);
  assert.equal(values.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(values.find(row => row.status === 'rejected').reason.status, 409);
  assert.deepEqual(await fs.readdir(f.root), ['multi.json']);
});
test('external atomic lock causes fail closed and is never removed', async t => {
  const f = await privateTemp(t); await fs.writeFile(`${f.file}.lock`, 'external-owner');
  await assert.rejects(f.store.configure(config(), 'missing'), hasStatus(503));
  assert.equal(await fs.readFile(`${f.file}.lock`, 'utf8'), 'external-owner');
  assert.equal((await f.store.read()).revision, 'missing');
});
test('atomic transaction releases its own lock after callback failure without rewriting', async t => {
  const f = await configured(t), before = await fs.readFile(f.file);
  await assert.rejects(f.store.transaction(() => { throw new Error(SECRET); }), hasStatus(503));
  assert.deepEqual(await fs.readFile(f.file), before); assert.deepEqual(await fs.readdir(f.root), ['multi.json']);
});
test('foreign lock replacing the acquired lock survives cleanup', async t => {
  const f = await configured(t);
  await f.store.transaction(async () => { await fs.writeFile(`${f.file}.lock`, 'new-owner'); return null; });
  assert.equal(await fs.readFile(`${f.file}.lock`, 'utf8'), 'new-owner');
});
for (const [label, bytes] of [
  ['invalid JSON', Buffer.from('{broken')], ['invalid UTF-8', Buffer.from([0xff, 0xfe])],
  ['oversized', Buffer.alloc(256 * 1024 + 1, 32)], ['wrong version', JSON.stringify({ ...document(), version: 2 })],
  ['extra attempt data', JSON.stringify(document(config(), [attempt({ rawAccount: SECRET })]))],
  ['duplicate daily account', JSON.stringify(document(config(), [attempt(), attempt({ modelKey: 'f'.repeat(64) })]))],
  ['invalid timestamp', JSON.stringify(document(config(), [attempt({ attemptedAt: 0 })]))],
  ['finished before claim', JSON.stringify(document(config(), [attempt({ finishedAt: DUE - 1 })]))],
  ['oversized attempt count', JSON.stringify(document(config(), Array.from({ length: 513 }, () => attempt())))],
]) test(`corrupt store ${label} fails closed without replacing the file`, async t => {
  const f = await privateTemp(t); await fs.writeFile(f.file, bytes); const before = await fs.readFile(f.file);
  await assert.rejects(f.store.read(), hasStatus(503));
  await assert.rejects(f.store.configure(config(), 'missing'), hasStatus(503));
  assert.deepEqual(await fs.readFile(f.file), before); assert.deepEqual(await fs.readdir(f.root), ['multi.json']);
});
test('store accepts BOM but persists only hashed account/model identity', async t => {
  const f = await privateTemp(t); await fs.writeFile(f.file, `\uFEFF${JSON.stringify(document())}`);
  const state = await f.store.read(); assert.equal(state.data.config.enabled, true);
  assert.ok(!JSON.stringify(state).includes(SECRET));
});
test('durable claim survives new store instance before run, finishes once, model change cannot bypass dedupe', async t => {
  const f = await configured(t), row = account();
  assert.equal(await f.store.claim(row, DAY, DUE, config()), true);
  const restart = new MultiWarmupStore(f.file); const pending = await restart.read();
  assert.equal(pending.data.attempts[0].status, 'claimed'); assert.equal(pending.data.paused, true);
  await restart.finish(row, DAY, 'succeeded', DUE + 1);
  const revision = (await restart.read()).revision, changed = config([account(1, { modelKey: 'f'.repeat(64) })]);
  await restart.configure(changed, revision);
  assert.equal(await restart.claim(changed.accounts[0], DAY, DUE + 2, changed), false);
  assert.equal((await restart.read()).data.attempts.length, 1);
});
for (const status of ['unsent', 'succeeded', 'unknown', 'claimed']) test(`${status} is never retried on the same day`, async t => {
  const f = await privateTemp(t); await f.seed(document(config(), [attempt({ status })]));
  assert.equal(await f.store.claim(account(), DAY, DUE + 30_000, config()), false);
});
for (const status of ['unknown', 'claimed']) test(`${status} restart pause cannot be cleared by configure`, async t => {
  const f = await privateTemp(t); await f.seed(document(config(), [attempt({ status })], false));
  const state = await f.store.read(); assert.equal(state.data.paused, true);
  await f.store.configure(config(undefined, { enabled: false }), state.revision);
  const after = await new MultiWarmupStore(f.file).read(); assert.equal(after.data.paused, true); assert.equal(after.data.attempts[0].status, status);
});
test('claim denies disabled, paused, opt-out and changed config', async t => {
  for (const cfg of [config(undefined, { enabled: false }), config([account(1, { enabled: false })], { enabled: false }), config([account(1, { allowUnverifiedQuota: false })])]) {
    const f = await configured(t, cfg); assert.equal(await f.store.claim(account(), DAY, DUE, cfg), false);
  }
  const f = await configured(t); assert.equal(await f.store.claim(account(), DAY, DUE, config(undefined, { time: '10:00' })), false);
  await f.seed(document(config(), [], true)); assert.equal(await f.store.claim(account(), DAY, DUE, config()), false);
});
test('finish rejects invalid outcome/mismatched model and preserves durable claim', async t => {
  const f = await configured(t); await f.store.claim(account(), DAY, DUE, config());
  await assert.rejects(f.store.finish(account(), DAY, 'retry', DUE + 1), TypeError);
  await assert.rejects(f.store.finish(account(1, { modelKey: 'f'.repeat(64) }), DAY, 'succeeded', DUE + 1), hasStatus(503));
  assert.equal((await f.store.read()).data.attempts[0].status, 'claimed');
});
test('next local day may claim after a known terminal result and prunes old terminal history', async t => {
  const f = await privateTemp(t); await f.seed(document(config(), [attempt()]));
  assert.equal(await f.store.claim(account(), '2026-10-07', DUE + 86_400_000, config()), true);
  assert.deepEqual((await f.store.read()).data.attempts.map(row => row.day), ['2026-10-07']);
});

test('failed atomic rename preserves original bytes and removes only its own lock/temp', async t => {
  const f = await configured(t), before = await fs.readFile(f.file);
  t.mock.method(fs, 'rename', async () => { throw new Error(SECRET); });
  await assert.rejects(f.store.configure(config(undefined, { time: '10:00' }), (await f.store.read()).revision), hasStatus(503));
  assert.deepEqual(await fs.readFile(f.file), before); assert.deepEqual(await fs.readdir(f.root), ['multi.json']);
});
test('real locked claim prevents model invocation and preserves external owner lock', async t => {
  const p = await configured(t); await fs.writeFile(`${p.file}.lock`, 'external-owner');
  const f = fixture({ store: p.store }); await f.fire(); assert.equal(f.calls.length, 0); assert.equal(f.scheduler.view.status, 'blocked');
  assert.equal((await p.store.read()).data.attempts.length, 0); assert.equal(await fs.readFile(`${p.file}.lock`, 'utf8'), 'external-owner');
});
test('actual terminal atomic-save failure retains durable claim and pauses later accounts', async t => {
  const cfg = config([account(), account(2)]), p = await configured(t, cfg);
  const originalRename = fs.rename;
  let failTerminal = false;
  t.mock.method(fs, 'rename', async (...args) => { if (failTerminal) throw new Error(SECRET); return originalRename(...args); });
  const f = fixture({ config: cfg, store: p.store, run: async () => { failTerminal = true; } });
  await f.fire(); assert.equal(f.calls.length, 1); assert.equal(f.scheduler.view.status, 'paused');
  const saved = await new MultiWarmupStore(p.file).read(); assert.equal(saved.data.paused, true); assert.equal(saved.data.attempts[0].status, 'claimed');
  assert.deepEqual(await fs.readdir(p.root), ['multi.json']); assert.ok(!JSON.stringify(f.changes).includes(SECRET));
});
test('finish with a backward clock never writes finishedAt before attemptedAt', async t => {
  const f = await configured(t); await f.store.claim(account(), DAY, DUE, config()); await f.store.finish(account(), DAY, 'succeeded', DUE - 1000);
  assert.equal((await f.store.read()).data.attempts[0].finishedAt, DUE);
});

// Safety properties under schedule/clock anomalies; failures are intentional
// regression evidence, not silently weakened assertions or expected failures.
test('future terminal journal date blocks an earlier-day claim (clock rollback)', async t => {
  const f = await privateTemp(t); await f.seed(document(config(), [attempt({ day: '2026-10-07', attemptedAt: DUE + 86_400_000, finishedAt: DUE + 86_400_001 })]));
  assert.equal(await f.store.claim(account(), DAY, DUE, config()), false, 'future durable attempt must fail closed before any new claim');
});
test('future attemptedAt on a previous day must not authorize a new request', async t => {
  const f = await privateTemp(t); await f.seed(document(config(), [attempt({ day: '2026-10-05', attemptedAt: DUE + 86_400_000, finishedAt: DUE + 86_400_001 })]));
  assert.equal(await f.store.claim(account(), DAY, DUE, config()), false, 'future timestamp indicates rollback or corrupt chronology');
});

test('disabled scheduler never discovers or runs; nextDelay is null', async () => {
  const f = fixture({ config: config([], { enabled: false }) }); await f.tick(DUE); await f.tick(DUE + 1);
  assert.equal(f.scheduler.view.status, 'disabled'); assert.equal(f.scheduler.nextDelay(), null); assert.equal(f.discoveries.length, 0); assert.equal(f.calls.length, 0);
});
test('enabling at the due instant does not immediately run', async () => {
  const f = fixture({ config: config(undefined, { enabled: false }) }); await f.tick(BASE);
  f.store.setConfig(config()); await f.tick(DUE); assert.equal(f.calls.length, 0); assert.equal(f.scheduler.view.status, 'waiting');
});
test('startup during scheduled minute does not catch up on its following tick', async () => {
  const f = fixture(); await f.tick(DUE + 1000); await f.tick(DUE + 2000);
  assert.equal(f.calls.length, 0, 'a second startup tick must not replay the missed schedule');
});
test('enabling during scheduled minute does not catch up on following tick', async () => {
  const f = fixture({ config: config(undefined, { enabled: false }) }); await f.tick(BASE);
  f.store.setConfig(config()); await f.tick(DUE + 1000); await f.tick(DUE + 2000);
  assert.equal(f.calls.length, 0, 'enable must suppress the current occurrence, not only one tick');
});
test('long sleep misses the occurrence even after a second wake tick', async () => {
  const f = fixture(); await f.tick(BASE - 300_000); await f.tick(DUE + 1000); await f.tick(DUE + 2000);
  assert.equal(f.calls.length, 0, 'sleep recovery must not replay on the next heartbeat');
});
test('an armed timer still requires a recent heartbeat and uses injected clock', async () => {
  const f = fixture(); const early = DUE - 3_600_000; await f.tick(early);
  assert.equal(f.scheduler.nextDelay(early), 3_600_000); assert.equal(f.scheduler.expectedWake, DUE);
  await f.tick(DUE - 30_000);
  await f.tick(DUE); assert.equal(f.calls.length, 1); assert.equal(f.store.data.attempts[0].attemptedAt, DUE);
  assert.equal(f.scheduler.view.status, 'settled'); assert.ok(f.changes.length >= 3);
});
test('armed wall-clock timer cannot prove no suspension, even when resume is within grace', async () => {
  const f = fixture(); await f.tick(DUE - 3_600_000); f.scheduler.nextDelay(DUE - 3_600_000);
  await f.tick(DUE + 30_000); await f.tick(DUE + 31_000); assert.equal(f.calls.length, 0);
});
test('expectedWake delayed by a full minute must not send', async () => {
  const f = fixture(); await f.tick(BASE - 300_000); f.scheduler.nextDelay(BASE - 300_000);
  await f.tick(DUE + 60_000); await f.tick(DUE + 61_000); assert.equal(f.calls.length, 0);
});
test('clock rollback tick must not send and may not replay on next tick', async () => {
  const f = fixture(); await f.tick(DUE + 10_000); await f.tick(DUE + 1000); await f.tick(DUE + 2000);
  assert.equal(f.calls.length, 0, 'backward clock must not re-arm the same missed occurrence');
});
test('scheduler persists actual privateTemp claim before adapter runs', async t => {
  const f = await configured(t); let called = false;
  const s = fixture({ store: f.store, run: async args => {
    called = true; const durable = await new MultiWarmupStore(f.file).read();
    assert.equal(durable.data.attempts[0].status, 'claimed'); assert.equal(durable.data.attempts[0].accountKey, args.accountKey);
    assert.equal(durable.data.paused, true);
  } });
  await s.fire(); assert.equal(called, true); assert.equal((await f.store.read()).data.attempts[0].status, 'succeeded');
  await s.tick(DUE + 1000); assert.equal(s.calls.length, 1);
});
test('eight accounts run serially, never concurrently, in the configured order', async () => {
  const cfg = config(Array.from({ length: 8 }, (_, i) => account(i + 1))); let active = 0, maximum = 0;
  const f = fixture({ config: cfg, run: async () => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; } });
  await f.fire(); assert.equal(maximum, 1); assert.deepEqual(f.calls.map(row => row.accountKey), cfg.accounts.map(row => row.accountKey));
  assert.equal(f.scheduler.view.accountResults.length, 8); assert.equal(f.store.data.attempts.length, 8);
  for (const row of cfg.accounts) assert.ok(f.store.events.indexOf(`claim:${row.accountKey}`) < f.store.events.indexOf(`run:${row.accountKey}`));
});
test('only explicitly opted-in unverified quota accounts may send; no fresh quota is fabricated', async () => {
  const cfg = config([account(1, { allowUnverifiedQuota: false }), account(2)]), f = fixture({ config: cfg });
  await f.fire(); assert.deepEqual(f.calls.map(row => row.accountKey), [account(2).accountKey]);
  assert.equal(f.scheduler.view.accountResults[0].status, 'skipped');
  assert.match(f.scheduler.view.accountResults[0].detail, /没有新鲜度证明/);
  assert.match(f.scheduler.view.detail, /逻辑请求.*不是 HTTP\/Token\/费用硬上限/);
  assert.equal('quota' in f.calls[0], false);
});
for (const [label, discovered] of [
  ['account removed', { accounts: [] }], ['model removed', { accounts: [{ accountKey: account().accountKey, models: [] }] }],
]) test(`catalogue revocation: ${label} skips without a claim`, async () => {
  const f = fixture({ discover: async () => discovered }); await f.fire(); assert.equal(f.calls.length, 0); assert.equal(f.store.data.attempts.length, 0); assert.equal(f.scheduler.view.accountResults[0].status, 'skipped');
});
for (const kind of ['bridge', 'generation']) test(`context ${kind} changes during discover: no claim or run`, async () => {
  const gate = deferred(), started = deferred(); const f = fixture({ discover: async () => { started.resolve(); return gate.promise; } });
  await f.tick(BASE); const task = f.tick(DUE); await started.promise;
  f.setContext({ ...f.context, [kind]: kind === 'bridge' ? {} : 2 }); gate.resolve(catalogue(config())); await task;
  assert.equal(f.calls.length, 0); assert.equal(f.store.data.attempts.length, 0); assert.equal(f.scheduler.view.status, 'blocked');
});
test('context change during claim records unsent and never invokes adapter', async () => {
  let f; f = fixture({ storeOptions: { afterClaim: () => f.setContext({ bridge: {}, generation: 2 }) } });
  await f.fire(); assert.equal(f.calls.length, 0); assert.equal(f.store.data.attempts[0].status, 'unsent');
});
test('context changes while run resolves cause unknown, pause and stop subsequent accounts', async () => {
  const cfg = config([account(), account(2)]); let f;
  f = fixture({ config: cfg, run: async () => f.setContext({ bridge: {}, generation: 2 }) });
  await f.fire(); assert.equal(f.calls.length, 1); assert.equal(f.store.data.attempts[0].status, 'unknown'); assert.equal(f.scheduler.view.status, 'paused');
});
test('legacy singleAttemptToday prevents all multi-account requests', async () => {
  const f = fixture({ config: config([account(), account(2)]), contextValue: { singleAttemptToday: true } });
  await f.fire(); assert.equal(f.calls.length, 0); assert.equal(f.store.data.attempts.length, 0); assert.equal(f.scheduler.view.accountResults.length, 2);
});
test('claimLease refusal blocks before persistent claim or run', async () => {
  const f = fixture({ claimLease: () => false }); await f.fire(); assert.equal(f.calls.length, 0); assert.equal(f.store.data.attempts.length, 0); assert.equal(f.scheduler.view.status, 'blocked');
});
test('claimLease is checked for every account and losing it prevents the next claim', async () => {
  let leases = 0;
  const f = fixture({ config: config([account(), account(2)]), claimLease: () => ++leases === 1 });
  await f.fire(); assert.equal(leases, 2); assert.equal(f.calls.length, 1); assert.equal(f.store.data.attempts.length, 1); assert.equal(f.scheduler.view.status, 'blocked');
});
test('no supported context skips discovery and model calls', async () => {
  const f = fixture({ context: () => null }); await f.fire(); assert.equal(f.scheduler.view.status, 'unsupported'); assert.equal(f.discoveries.length, 0); assert.equal(f.calls.length, 0);
});
test('busy tick does not duplicate discovery or claim; nextDelay returns null', async () => {
  const gate = deferred(), entered = deferred(); const f = fixture({ run: async () => { entered.resolve(); return gate.promise; } });
  await f.tick(BASE); const pending = f.tick(DUE); await entered.promise;
  await f.tick(DUE + 1); assert.equal(f.calls.length, 1); assert.equal(f.discoveries.length, 1); assert.equal(f.scheduler.nextDelay(DUE + 1), null);
  gate.resolve(); await pending; assert.equal(f.store.data.attempts[0].status, 'succeeded');
});
test('disabled account is excluded even when it grants unverified quota opt-in', async () => {
  const f = fixture({ config: config([account(1, { enabled: false }), account(2)]) }); await f.fire(); assert.deepEqual(f.calls.map(row => row.accountKey), [account(2).accountKey]);
});
test('durable claim denial never calls the adapter', async () => {
  const f = fixture({ storeOptions: { claimFalse: true } }); await f.fire(); assert.equal(f.calls.length, 0); assert.equal(f.scheduler.view.accountResults[0].status, 'skipped');
});
test('requestNotSent yields unsent and never retries that account on the same day', async () => {
  const f = fixture({ run: async () => { throw Object.assign(new Error(SECRET), { requestNotSent: true }); } });
  await f.fire(); await f.tick(DUE + 1); assert.equal(f.calls.length, 1); assert.equal(f.store.data.attempts[0].status, 'unsent'); assert.ok(!JSON.stringify(f.changes).includes(SECRET));
});
test('unknown result pauses and stops all later accounts without leaking raw exception', async () => {
  const f = fixture({ config: config([account(), account(2)]), run: async () => { throw new Error(SECRET); } });
  await f.fire(); await f.tick(DUE + 1); assert.equal(f.calls.length, 1); assert.equal(f.store.data.paused, true); assert.equal(f.scheduler.view.status, 'paused'); assert.ok(!JSON.stringify(f.changes).includes(SECRET));
});
test('terminal save failure preserves actual durable claim and restart pause', async t => {
  const p = await configured(t); const cfg = config([account(), account(2)]); const revision = (await p.store.read()).revision; await p.store.configure(cfg, revision);
  const store = { read: () => p.store.read(), claim: (...args) => p.store.claim(...args), finish: async () => { throw new Error(SECRET); } };
  const f = fixture({ config: cfg, store }); await f.fire(); assert.equal(f.calls.length, 1); assert.equal(f.scheduler.view.status, 'paused');
  const restarted = await new MultiWarmupStore(p.file).read(); assert.equal(restarted.data.paused, true); assert.equal(restarted.data.attempts[0].status, 'claimed'); assert.ok(!JSON.stringify(f.changes).includes(SECRET));
});
test('stop aborts an adapter ignoring AbortSignal, settles promptly, and never runs next account', async () => {
  const gate = deferred(), entered = deferred(); const f = fixture({ config: config([account(), account(2)]), run: async () => { entered.resolve(); return gate.promise; } });
  await f.tick(BASE); const pending = f.tick(DUE); await entered.promise; const sentSignal = f.calls[0].signal;
  await f.scheduler.stop(); await pending; assert.equal(sentSignal.aborted, true); assert.equal(f.calls.length, 1); assert.equal(f.scheduler.nextDelay(DUE), null);
  assert.equal(f.store.data.attempts[0].status, 'unknown'); gate.resolve(); await Promise.resolve(); await f.tick(DUE + 1); assert.equal(f.calls.length, 1);
});
test('deadline abort is bounded even for an adapter ignoring AbortSignal', async t => {
  const timeout = new AbortController(), entered = deferred(), gate = deferred();
  t.mock.method(AbortSignal, 'timeout', ms => { assert.equal(ms, 60_000); return timeout.signal; });
  const f = fixture({ config: config([account(), account(2)]), run: async () => { entered.resolve(); return gate.promise; } });
  await f.tick(BASE); const pending = f.tick(DUE); await entered.promise; timeout.abort(new Error(SECRET)); await pending;
  assert.equal(f.calls.length, 1); assert.equal(f.store.data.attempts[0].status, 'unknown'); assert.equal(f.scheduler.view.status, 'paused'); assert.ok(!JSON.stringify(f.changes).includes(SECRET)); gate.resolve();
});
test('external signal aborts pending discovery without any durable claim', async () => {
  const controller = new AbortController(), entered = deferred(), gate = deferred();
  const f = fixture({ signal: controller.signal, discover: async () => { entered.resolve(); return gate.promise; } });
  await f.tick(BASE); const pending = f.tick(DUE); await entered.promise; controller.abort(new Error(SECRET)); await pending;
  assert.equal(f.calls.length, 0); assert.equal(f.store.data.attempts.length, 0); assert.equal(f.scheduler.view.status, 'blocked'); gate.resolve(catalogue(config()));
});
test('already-aborted signal and stopped scheduler do not read/discover/run', async () => {
  const controller = new AbortController(); controller.abort(); const f = fixture({ signal: controller.signal }); await f.fire(); assert.deepEqual(f.store.events, []);
  const stopped = fixture(); await stopped.scheduler.stop(); await stopped.fire(); assert.deepEqual(stopped.store.events, []);
});
test('configuration change aborts pending run and prevents following accounts', async () => {
  const entered = deferred(), gate = deferred(), cfg = config([account(), account(2)]);
  const f = fixture({ config: cfg, run: async () => { entered.resolve(); return gate.promise; } });
  await f.tick(BASE); const pending = f.tick(DUE); await entered.promise; f.store.setConfig(config([], { enabled: false })); await f.tick(DUE + 1); await pending;
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.store.data.attempts[0].status, 'unknown'); gate.resolve();
});
for (const kind of ['read', 'claim', 'discover']) test(`external ${kind} errors are sanitized and never call run`, async () => {
  const options = kind === 'discover' ? { discover: async () => { throw new Error(SECRET); } } : { storeOptions: { [kind === 'read' ? 'readError' : 'claimError']: new Error(SECRET) } };
  const f = fixture(options); await f.fire(); assert.equal(f.calls.length, 0); assert.equal(f.scheduler.view.status, 'blocked'); assert.ok(!JSON.stringify(f.changes).includes(SECRET));
});

// In-memory HTTP request/response only: authentication must precede all work.
for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) test(`auth first: unauthorized ${method} performs no store/discovery/body work`, async () => {
  const req = { method, get headers() { throw new Error('must not inspect headers'); }, async *[Symbol.asyncIterator]() { throw new Error('must not consume body'); } };
  const response = await http({ authorize: false, req }); assert.equal(response.status, 401); assert.deepEqual(response.events, ['authorize']);
});
for (const method of ['GET', 'HEAD', 'DELETE', 'OPTIONS']) test(`${method} does not discover or consume a body`, async () => {
  const req = { method, async *[Symbol.asyncIterator]() { throw new Error('body must not be read'); } };
  const response = await http({ req }); assert.equal(response.status, ['GET', 'HEAD'].includes(method) ? 200 : 405);
  assert.equal(response.events.includes('discover'), false); assert.equal(response.headers['Cache-Control'], 'no-store'); assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
  if (method === 'HEAD') assert.equal(response.raw, undefined);
  if (response.status === 405) assert.equal(response.headers.Allow, 'GET, HEAD, PUT, POST');
  if (method === 'GET') { assert.equal('attempts' in response.body, false); assert.ok(response.body.revision); }
});
test('POST discover is explicit, returns catalogue, uses context/signal, never configures', async () => {
  let args; const response = await http({ req: request('POST', { action: 'discover' }), discover: async value => { args = value; return catalogue(config()); } });
  assert.equal(response.status, 200); assert.deepEqual(response.body, catalogue(config())); assert.ok(args.bridge); assert.equal(args.generation, 1); assert.ok(args.signal instanceof AbortSignal);
  assert.deepEqual(response.events, ['authorize', 'discover']);
});
for (const body of [{ action: 'run' }, { action: 'discover', account: SECRET }, {}, [], null, { enabled: true }]) test(`POST rejects non-discovery schema ${JSON.stringify(body)}`, async () => {
  const response = await http({ req: request('POST', body) }); assert.equal(response.status, 400); assert.deepEqual(response.events, ['authorize']); assert.ok(!response.raw.includes(SECRET));
});
for (const method of ['PUT', 'POST']) {
  for (const [label, body, headers, status] of [
    ['wrong MIME', '{}', { 'content-type': 'text/plain' }, 415],
    ['missing MIME', '{}', {}, 415], ['JSON garbage', '{', { 'content-type': 'application/json' }, 400],
    ['invalid UTF-8', Buffer.from([0xff]), { 'content-type': 'application/json' }, 400],
    ['oversized JSON', Buffer.alloc(16_385, 32), { 'content-type': 'application/json' }, 413],
  ]) test(`${method} ${label} rejected before operations`, async () => {
    const response = await http({ req: request(method, body, headers) }); assert.equal(response.status, status); assert.deepEqual(response.events, ['authorize']);
  });
}
test('JSON 16384 byte boundary accepts valid discover; cumulative chunks enforce limit', async () => {
  const body = JSON.stringify({ action: 'discover' });
  const exact = await http({ req: request('POST', body + ' '.repeat(16_384 - Buffer.byteLength(body))) }); assert.equal(exact.status, 200);
  const req = { method: 'POST', headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.alloc(8192, 32); yield Buffer.alloc(8193, 32); } };
  const over = await http({ req }); assert.equal(over.status, 413); assert.deepEqual(over.events, ['authorize']);
});
test('PUT accepts JSON charset and only calls configure/changed, never discover', async () => {
  const payload = { config: config(), revision: 'a'.repeat(64) }, response = await http({ req: request('PUT', payload, { 'content-type': 'application/json; charset=utf-8' }) });
  assert.equal(response.status, 200); assert.deepEqual(response.events, ['authorize', ['configure', payload.config, payload.revision], 'changed']);
});
for (const extra of [{ paused: false }, { attempts: [] }, { action: 'clear' }]) test(`PUT cannot manipulate ${Object.keys(extra)[0]}`, async () => {
  const response = await http({ req: request('PUT', { config: config(), revision: 'a'.repeat(64), ...extra }) }); assert.equal(response.status, 400); assert.deepEqual(response.events, ['authorize']);
});
test('PUT real CAS preserves paused attempts and rejects stale editor without changed callback', async t => {
  const f = await privateTemp(t); await f.seed(document(config(), [attempt({ status: 'unknown' })])); const state = await f.store.read();
  const first = await http({ store: f.store, req: request('PUT', { config: config(undefined, { enabled: false }), revision: state.revision }) });
  assert.equal(first.status, 200); assert.equal(first.body.paused, true); assert.equal((await f.store.read()).data.attempts[0].status, 'unknown');
  const before = await fs.readFile(f.file), stale = await http({ store: f.store, req: request('PUT', { config: config(), revision: state.revision }) });
  assert.equal(stale.status, 409); assert.equal(stale.events.includes('changed'), false); assert.deepEqual(await fs.readFile(f.file), before);
});
for (const kind of ['bridge', 'generation']) test(`POST context ${kind} race hides catalogue and reports conflict`, async () => {
  let ctx = { bridge: {}, generation: 1 };
  const response = await http({ req: request('POST', { action: 'discover' }), context: () => ctx, discover: async () => { ctx = { ...ctx, [kind]: kind === 'bridge' ? {} : 2 }; return { accounts: [{ raw: SECRET }] }; } });
  assert.equal(response.status, 409); assert.ok(!response.raw.includes(SECRET));
});
test('POST missing supported context rejects without discover', async () => {
  const response = await http({ req: request('POST', { action: 'discover' }), context: () => null }); assert.equal(response.status, 409); assert.deepEqual(response.events, ['authorize']);
});
for (const source of ['read', 'configure', 'discover', 'body']) test(`HTTP sanitizes ordinary external ${source} failures`, async () => {
  const throwSecret = async () => { throw new Error(SECRET); };
  const options = source === 'read' ? { store: { read: throwSecret } }
    : source === 'configure' ? { req: request('PUT', { config: config(), revision: 'missing' }), store: { configure: throwSecret } }
    : source === 'discover' ? { req: request('POST', { action: 'discover' }), discover: throwSecret }
    : { req: { method: 'POST', headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { throw new Error(SECRET); } } };
  const response = await http(options); assert.equal(response.status, 503); assert.ok(!response.raw.includes(SECRET));
});
test('HTTP supports Headers-style MIME access without a real HTTP server', async () => {
  const response = await http({ req: request('POST', { action: 'discover' }, new Map([['content-type', 'application/json']])) });
  assert.equal(response.status, 200); assert.deepEqual(response.events, ['authorize', 'discover']);
});
for (const body of [{}, { config: config() }, { revision: 'missing' }, [], null]) test(`PUT rejects incomplete envelope ${JSON.stringify(body)}`, async () => {
  const response = await http({ req: request('PUT', body) }); assert.equal(response.status, 400); assert.deepEqual(response.events, ['authorize']);
});
test('PUT strict configuration validation fails before any file is created', async t => {
  const p = await privateTemp(t);
  for (const cfg of [config(undefined, { enabled: 'true' }), config([account(1, { allowUnverifiedQuota: 'true' })]), config(undefined, { attempts: [] })]) {
    const response = await http({ store: p.store, req: request('PUT', { config: cfg, revision: 'missing' }) });
    assert.equal(response.status, 400); assert.equal(response.events.includes('changed'), false);
  }
  assert.deepEqual(await fs.readdir(p.root), []);
});
for (const source of ['read', 'configure', 'body']) test(`external ${source} status 400 cannot expose raw account/error text`, async () => {
  const fail = async () => { throw Object.assign(new Error(SECRET), { status: 400 }); };
  const options = source === 'read' ? { store: { read: fail } }
    : source === 'configure' ? { req: request('PUT', { config: config(), revision: 'missing' }), store: { configure: fail } }
    : { req: { method: 'POST', headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { await fail(); } } };
  const response = await http(options); assert.ok(!response.raw.includes(SECRET), 'external status is not a trust marker');
});
for (const status of [400, 409, 413, 415]) test(`external discover status ${status} must not launder its raw error into response`, async () => {
  const response = await http({ req: request('POST', { action: 'discover' }), discover: async () => { throw Object.assign(new Error(SECRET), { status }); } });
  assert.ok(!response.raw.includes(SECRET), 'only local validation errors may be exposed verbatim');
});
