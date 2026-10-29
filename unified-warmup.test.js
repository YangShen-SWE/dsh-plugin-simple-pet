import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { UnifiedWarmupCoordinator, unifiedWarmupConfig, unifiedWarmupHandler } from './unified-warmup.js';

// All fixtures are synthetic, private temporary files. No host service, network,
// credentials, real account/configuration, model provider or active setter exists.
const NOW = Date.parse('2026-10-06T09:29:40Z');
const DUE = Date.parse('2026-10-06T09:30:00Z');
const OWNER = '11111111-1111-4111-8111-111111111111';
const SECRET = 'private-bearer-alice@example.invalid';
const hex = (n, len = 64) => n.toString(16).padStart(len, '0');
const row = (n = 1, extra = {}) => ({ accountKey: hex(n, 16), accountGeneration: hex(n + 100), modelKey: hex(n + 200), manual: true, daily: true, allowUnknownQuota: false, ...extra });
const config = (rows = [row()], extra = {}) => ({ enabled: true, daily: true, time: '09:30', timeZone: 'UTC', accounts: rows, ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const safeCode = code => e => { assert.equal(e.code, code); assert(!e.message.includes(SECRET)); return true; };

async function fixture(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-unified-test-'));
  const file = path.join(root, 'unified-warmup.json'), legacyFile = path.join(root, 'warmup.json'), retiredMultiFile = path.join(root, 'multi-warmup.json');
  let now = options.now ?? NOW;
  const c = new UnifiedWarmupCoordinator({ file, legacyFile, retiredMultiFile, clock: () => now, signal: options.signal });
  t.after(async () => {
    await c.stop();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('dsh-unified-test-'));
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { c, file, root, legacyFile, retiredMultiFile, setNow(n) { now = n; }, now: () => now,
    read() { return JSON.parse(fs.readFileSync(file, 'utf8')); }, seed(d) { fs.writeFileSync(file, JSON.stringify(d)); },
    async save(cfg = config()) { return c.configure(cfg, (await c.status()).revision); },
    async run(keys = [row().accountKey]) { return c.runManual({ revision: (await c.status()).revision, accountKeys: keys, confirmed: true }); } };
}
function service(f, options = {}) {
  let verify, connectCount = 0, calls = 0, prepareCalls = 0, activeWrites = 0;
  const events = [];
  const rows = options.rows ?? [row()];
  const executor = {
    capabilities: () => ({ contractVersion: 1, ownerEpoch: OWNER, accountBound: true, maxAccounts: 8, startupFull: false, resetFull: false, ...options.capabilities }),
    async listAccounts({ signal }) { events.push(['accounts']); return options.listAccounts ? options.listAccounts({ signal }) : { accounts: rows.map((r, i) => ({ accountKey: r.accountKey, accountGeneration: r.accountGeneration, budgetSubject: hex(i + 400), active: i === 0, label: `测试账号 ${i + 1}`, ...options.accountPatch })) }; },
    async listModels(args) { events.push(['models', args.refresh, args.accountKey]); return options.listModels ? options.listModels(args) : { verified: true, revision: hex(999), models: rows.filter(a => a.accountKey === args.accountKey).map(a => ({ modelKey: a.modelKey, name: 'mock-text' })) }; },
    async readQuota(args) { events.push(['quota', args.refresh, args.accountKey]); return options.readQuota ? options.readQuota(args) : { status: 'ready', fetchedAt: f.now() }; },
    async prepare(args) {
      prepareCalls++; events.push(['prepare', args.accountKey]);
      const binding = { accountKey: args.accountKey, accountGeneration: args.accountGeneration, modelKey: args.modelKey, ownerEpoch: args.ownerEpoch };
      assert.equal(verify(args.claimReceipt, binding), true);
      assert.equal(verify({}, binding), false);
      assert.equal(verify(args.claimReceipt, { ...binding, modelKey: hex(555) }), false);
      assert.equal(verify(args.claimReceipt, { ...binding, authorizationRevision: 'wrong' }), false);
      assert.equal(f.read().claims.at(-1).status, 'claimed');
      if (options.prepare) return options.prepare(args, verify, binding);
      return { execute: async ({ signal }) => {
        calls++; events.push(['execute', args.accountKey]);
        assert.equal(f.read().claims.at(-1).status, 'dispatching');
        assert.equal(verify(args.claimReceipt, binding), true);
        if (options.execute) return options.execute({ ...args, signal }, verify, binding);
        return { usage: { inputTokens: 2, outputTokens: 1 } };
      } };
    },
    // An accidental active-account write fails a real assertion, not a source scan.
    setActive() { activeWrites++; throw Error('active write forbidden'); },
  };
  const raw = { connect(v) { connectCount++; assert.equal(connectCount, 1); verify = v; return executor; } };
  f.c.setService(raw);
  return { raw, executor, events, get calls() { return calls; }, get prepareCalls() { return prepareCalls; }, get connectCount() { return connectCount; }, get activeWrites() { return activeWrites; }, verify: (...a) => verify(...a) };
}

 test('default off; GET/status, save and local discovery never execute or refresh', async t => {
  const f = await fixture(t); const s = service(f);
  const first = await f.c.status(); assert.equal(first.config.enabled, false); assert.equal(first.revision, 'missing');
  assert.equal(fs.existsSync(f.file), false);
  await f.save(); await f.c.status(); const directory = await f.c.discover();
  assert.equal(directory.accounts.length, 1); assert(!JSON.stringify(directory).includes('budgetSubject'));
  assert(s.events.filter(x => ['models', 'quota'].includes(x[0])).every(x => x[1] === false));
  assert.equal(s.calls, 0); assert.equal(s.activeWrites, 0); assert.deepEqual(f.read().claims, []);
  await f.c.refreshAccount({ accountKey: row().accountKey, accountGeneration: row().accountGeneration });
  assert.equal(s.events.filter(x => x[1] === true).length, 2); assert.equal(s.calls, 0);
});

test('config is exact, typed, default-deny and bounded to eight unique rows', () => {
  assert.equal(unifiedWarmupConfig(config()).time, '09:30');
  for (const bad of [config([], {}), config([row(), row()]), config(Array.from({ length: 9 }, (_, i) => row(i + 1))), config([row()], { startupFull: true }), config([row()], { timeZone: 'bad/zone' }), config([row()], { daily: 1 }), config([row(1, { active: true })])]) assert.throws(() => unifiedWarmupConfig(bad));
});

test('single connect and strict capabilities; never fall back to an old owner', async t => {
  for (const capabilities of [{ contractVersion: 2 }, { accountBound: false }, { maxAccounts: 9 }, { startupFull: true }, { resetFull: true }, { ownerEpoch: 'not-uuid' }]) {
    const f = await fixture(t); const s = service(f, { capabilities }); await f.save();
    assert.equal((await f.c.status()).capabilities.accountBound, false);
    await assert.rejects(f.run(), safeCode('unsupported')); assert.equal(s.calls, 0);
  }
  const f = await fixture(t), s = service(f); f.c.setService(s.raw); assert.equal(s.connectCount, 1);
  f.c.setService(null); f.c.setService(s.raw); assert.equal(s.connectCount, 1); assert.equal((await f.c.status()).capabilities.accountBound, false);
});

test('claim then dispatching then execute, numeric DTO only, durable shared budget', async t => {
  const f = await fixture(t), s = service(f); await f.save(); await f.run();
  const d = f.read(); assert.equal(d.claims[0].status, 'succeeded'); assert.deepEqual(d.claims[0].usage, { inputTokens: 2, outputTokens: 1 });
  await f.run(); assert.equal(s.calls, 1); assert.equal(f.read().claims.length, 1); assert.equal(s.activeWrites, 0);
  assert.equal((await f.c.status()).view.counts.skipped, 1);
});

test('manual permissions and final confirmation are distinct from saving', async t => {
  const f = await fixture(t), s = service(f); await f.save(config([row(1, { manual: false })]));
  await assert.rejects(f.run(), safeCode('authorization_required'));
  await assert.rejects(f.c.runManual({ revision: (await f.c.status()).revision, accountKeys: [row().accountKey], confirmed: false }), safeCode('invalid_run'));
  assert.equal(s.calls, 0);
});

test('CAS conflict leaves file and draft authorization unchanged', async t => {
  const f = await fixture(t); service(f); const state = await f.save(); await f.save(config([row()], { daily: false }));
  const before = fs.readFileSync(f.file);
  await assert.rejects(f.c.configure(config(), state.revision), safeCode('revision_conflict'));
  assert.deepEqual(fs.readFileSync(f.file), before);
  await assert.rejects(f.c.runManual({ revision: state.revision, accountKeys: [row().accountKey], confirmed: true }), safeCode('revision_conflict'));
});

for (const [name, options, allowed] of [
  ['unknown quota', { readQuota: async () => ({ status: 'unknown' }) }, false],
  ['restricted even with extra consent', { readQuota: async () => ({ status: 'restricted' }) }, false],
  ['unverified model', { listModels: async () => ({ verified: false, revision: hex(999), models: [{ modelKey: row().modelKey, name: 'mock' }] }) }, false],
  ['stale quota', { readQuota: async () => ({ status: 'ready', fetchedAt: NOW - 120001 }) }, false],
  ['unknown with consent', { readQuota: async () => ({ status: 'unknown' }) }, true],
]) test(name, async t => {
  const f = await fixture(t), s = service(f, options); await f.save(config([row(1, { allowUnknownQuota: allowed || name.includes('restricted') })]));
  await f.run(); assert.equal(s.calls, allowed ? 1 : 0); assert.equal(f.read().claims.length, allowed ? 1 : 0);
});

test('untrusted model/quota/identity data is rejected, not copied from active', async t => {
  const f = await fixture(t), s = service(f, { accountPatch: { accountGeneration: hex(900) } }); await f.save(); await f.run(); assert.equal(s.calls, 0);
  const g = await fixture(t), q = service(g, { listModels: async () => ({ verified: true, revision: hex(999), models: [{ modelKey: hex(888), name: SECRET }] }) }); await g.save(); await g.run(); assert.equal(q.calls, 0);
});

test('trusted prepare refusal is unsent, still consumes that subject/day', async t => {
  const f = await fixture(t), s = service(f, { prepare: async () => { throw Object.assign(Error(SECRET), { requestNotSent: true }); } });
  await f.save(); await f.run(); assert.equal(f.read().claims[0].status, 'unsent'); assert.equal(f.read().paused, null);
  await f.run(); assert.equal(s.prepareCalls, 1); assert.equal(s.calls, 0);
});

for (const name of ['execute rejection', 'forged requestNotSent', 'sync throw']) test(`${name} is unknown, persists and stops all later accounts`, async t => {
  const f = await fixture(t), rows = [row(), row(2)];
  const s = service(f, { rows, execute: () => { throw Object.assign(Error(SECRET), { requestNotSent: name === 'forged requestNotSent' }); } });
  await f.save(config(rows)); await assert.rejects(f.run(rows.map(a => a.accountKey)));
  assert.equal(s.calls, 1); assert.equal(f.read().claims[0].status, 'unknown'); assert.equal(f.read().paused, 'paused_unknown');
  assert(fs.existsSync(`${f.file}.execution.lock`));
  await f.save(config(rows, { enabled: false })); f.setNow(NOW + 86400000); await f.save(config(rows));
  assert.equal((await f.c.status()).view.status, 'paused_unknown');
  await assert.rejects(f.c.withLegacy(async () => assert.fail('old call forbidden')));
  assert(!JSON.stringify(await f.c.status()).includes(SECRET));
});

test('first success is retained when next fails, only final numeric usage is saved', async t => {
  const f = await fixture(t), rows = [row(), row(2), row(3)]; let n = 0;
  const s = service(f, { rows, execute: async () => { if (++n === 2) throw Error(SECRET); return { usage: { inputTokens: 8 }, text: SECRET }; } });
  await f.save(config(rows)); await assert.rejects(f.run(rows.map(a => a.accountKey)));
  assert.equal(s.calls, 2); assert.deepEqual(f.read().claims.map(c => c.status), ['succeeded', 'unknown']);
  assert.deepEqual(f.read().claims[0].usage, { inputTokens: 8 }); assert(!fs.readFileSync(f.file, 'utf8').includes(SECRET));
});

test('double click is refused immediately; no queued second batch', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const s = service(f, { execute: async () => { entered.resolve(); await release.promise; return {}; } }); await f.save();
  const run = f.run(); await entered.promise; await assert.rejects(f.run(), safeCode('busy'));
  release.resolve(); await run; assert.equal(s.calls, 1);
});

test('cancel and ignores-signal settle locally; late rejection cannot resume or start next', async t => {
  const f = await fixture(t), entered = deferred(), ignored = deferred(), rows = [row(), row(2)];
  const s = service(f, { rows, execute: async () => { entered.resolve(); return ignored.promise; } }); await f.save(config(rows));
  const run = f.run(rows.map(a => a.accountKey)); const observed = run.catch(e => e); await entered.promise;
  await f.c.cancel(); await observed; ignored.reject(Error(SECRET)); await new Promise(setImmediate);
  assert.equal(s.calls, 1); assert.equal(f.read().paused, 'paused_unknown'); assert.equal(f.read().claims[0].status, 'unknown');
});

test('each prepared/execution account has a bounded 60s wait, no later account', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t), entered = deferred(), rows = [row(), row(2)];
  const s = service(f, { rows, execute: async () => { entered.resolve(); return new Promise(() => {}); } }); await f.save(config(rows));
  const run = f.run(rows.map(a => a.accountKey)).catch(e => e); await entered.promise;
  t.mock.timers.tick(60_001); await run;
  assert.equal(s.calls, 1); assert.equal(f.read().claims[0].status, 'unknown');
});

test('prepare ignoring signal times out unsent and no execute/next row is invoked', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t), entered = deferred(), rows = [row(), row(2)];
  const s = service(f, { rows, prepare: async () => { entered.resolve(); return new Promise(() => {}); } }); await f.save(config(rows));
  const run = f.run(rows.map(a => a.accountKey)).catch(e => e); await entered.promise; t.mock.timers.tick(60001); await run;
  assert.equal(s.calls, 0); assert.equal(s.prepareCalls, 1); assert.equal(f.read().claims[0].status, 'unsent');
});

test('configuration revocation during execute aborts and records unknown', async t => {
  const f = await fixture(t), entered = deferred(), s = service(f, { execute: async () => { entered.resolve(); return new Promise(() => {}); } });
  await f.save(); const run = f.run().catch(e => e); await entered.promise; await f.save(config([row()], { enabled: false })); await run;
  assert.equal(s.calls, 1); assert.equal(f.read().paused, 'paused_unknown');
});

test('owner replacement invalidates outstanding receipts and stops the batch', async t => {
  const f = await fixture(t), entered = deferred();
  service(f, { execute: async () => { entered.resolve(); return new Promise(() => {}); } }); await f.save(); const run = f.run().catch(e => e); await entered.promise;
  f.c.setService(null); await run; assert.equal(f.read().claims[0].status, 'unknown');
});

test('at most eight budget subjects per day across config changes and batches', async t => {
  const f = await fixture(t), rows = Array.from({ length: 8 }, (_, i) => row(i + 1)); const s = service(f, { rows });
  await f.save(config(rows)); await f.run(rows.map(a => a.accountKey)); assert.equal(s.calls, 8);
  const ninth = row(9); s.executor.listAccounts = async () => ({ accounts: [{ accountKey: ninth.accountKey, accountGeneration: ninth.accountGeneration, budgetSubject: hex(9999), active: false, label: '九' }] });
  s.executor.listModels = async () => ({ verified: true, revision: hex(999), models: [{ modelKey: ninth.modelKey, name: 'mock' }] });
  await f.save(config([ninth])); await f.run([ninth.accountKey]); assert.equal(s.calls, 8); assert.equal(f.read().claims.length, 8);
});

test('duplicate binding or deleted/rebound row cannot mint another budget subject', async t => {
  const f = await fixture(t), rows = [row(), row(2)]; const s = service(f, { rows, accountPatch: { budgetSubject: hex(777) } });
  await f.save(config(rows)); await f.run(rows.map(a => a.accountKey)); assert.equal(s.calls, 1); assert.equal(f.read().claims.length, 1);
  await f.save(config([row(2)])); await f.run([row(2).accountKey]); assert.equal(s.calls, 1);
});

test('normal next day works without pruning any historical budgets', async t => {
  const f = await fixture(t), s = service(f); await f.save(); await f.run(); f.setNow(NOW + 86400000); await f.run();
  assert.equal(s.calls, 2); assert.equal(f.read().claims.length, 2);
});

test('clock rollback and future durable records latch paused_clock', async t => {
  const f = await fixture(t), s = service(f); await f.save(); await f.run(); f.setNow(NOW - 1); await assert.rejects(f.run());
  assert.equal(f.read().paused, 'paused_clock'); assert.equal(s.calls, 1);
  const g = await fixture(t); service(g); await g.save(); const d = g.read(); d.highWater = NOW + 1; g.seed(d); await assert.rejects(g.run()); assert.equal(g.read().paused, 'paused_clock');
});

test('timezone changes seal overlapping old/new budget days conservatively', async t => {
  const f = await fixture(t), s = service(f); await f.save(); await f.run();
  await f.save(config([row()], { timeZone: 'Pacific/Kiritimati' })); await assert.rejects(f.run(), safeCode('timezone_hold'));
  assert(f.read().timeZoneHoldUntil >= NOW + 48 * 3600000); assert.equal(s.calls, 1);
});

test('daily requires continuous crossing; no start-minute, late wake, restart or save catch-up', async t => {
  const f = await fixture(t), s = service(f); await f.save(); await f.c.tick(NOW); f.setNow(DUE); await f.c.tick(DUE); assert.equal(s.calls, 1);
  const g = await fixture(t, { now: DUE }), q = service(g); await g.save(); await g.c.tick(DUE); g.setNow(DUE + 10000); await g.c.tick(DUE + 10000); assert.equal(q.calls, 0);
  const h = await fixture(t), r = service(h); await h.save(); await h.c.tick(NOW); h.setNow(DUE + 60000); await h.c.tick(DUE + 60000); assert.equal(r.calls, 0);
  const j = await fixture(t), u = service(j); await j.save(); await j.c.tick(NOW); j.setNow(DUE); await j.save(); await j.c.tick(DUE); j.setNow(DUE + 10000); await j.c.tick(DUE + 10000); assert.equal(u.calls, 0);
});

test('DST gap skipped and repeated minute cannot duplicate a durable subject', async t => {
  const gap = Date.parse('2026-03-29T00:59:50Z');
  const f = await fixture(t, { now: gap }), s = service(f); await f.save(config([row()], { time: '02:30', timeZone: 'Europe/Copenhagen' }));
  await f.c.tick(gap); f.setNow(gap + 20000); await f.c.tick(f.now()); assert.equal(s.calls, 0);
  const first = Date.parse('2026-10-25T00:29:40Z');
  const g = await fixture(t, { now: first }), q = service(g); await g.save(config([row()], { time: '02:30', timeZone: 'Europe/Copenhagen' }));
  await g.c.tick(first); g.setNow(first + 20000); await g.c.tick(g.now()); assert.equal(q.calls, 1);
  g.setNow(first + 3600000); await g.c.tick(g.now()); g.setNow(first + 3620000); await g.c.tick(g.now()); assert.equal(q.calls, 1);
});

for (const phase of ['claimed', 'dispatching', 'succeeded']) test(`save failure at ${phase} never advances to another account`, async t => {
  const f = await fixture(t), rows = [row(), row(2)], s = service(f, { rows }); await f.save(config(rows));
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === f.file) { const d = JSON.parse(fs.readFileSync(from, 'utf8')); if (d.claims.at(-1)?.status === phase) throw Object.assign(Error('disk full'), { code: 'ENOSPC' }); }
    return rename(from, to);
  });
  await assert.rejects(f.run(rows.map(a => a.accountKey)));
  assert.equal(s.calls, phase === 'succeeded' ? 1 : 0);
  assert.equal(fs.existsSync(`${f.file}.paused-storage`), true);
  const d = f.read(); if (phase === 'succeeded') { assert(['dispatching', 'unknown'].includes(d.claims[0].status)); assert.equal(d.paused === 'paused_unknown' || fs.existsSync(`${f.file}.paused-storage`), true); }
  assert.equal(d.claims.length <= 1, true);
});

test('corruption, unknown schema and orphan claims are never treated as empty', async t => {
  for (const contents of ['{', JSON.stringify({ version: 99 }), 'null']) {
    const f = await fixture(t), s = service(f); fs.writeFileSync(f.file, contents); await assert.rejects(f.run()); assert.equal(s.calls, 0); assert.equal(fs.readFileSync(f.file, 'utf8'), contents);
  }
  const f = await fixture(t), entered = deferred(); service(f, { prepare: async () => { entered.resolve(); return new Promise(() => {}); } }); await f.save();
  const run = f.run().catch(e => e); await entered.promise; const pending = f.read(); await f.c.cancel(); await run;
  // Simulate an orphaned, previously synced claim, with no retained execution lock.
  pending.paused = null; f.seed(pending);
  const g = new UnifiedWarmupCoordinator({ file: f.file, clock: f.now }); service({ ...f, c: g });
  await assert.rejects(g.runManual({ revision: (await g.status()).revision, accountKeys: [row().accountKey], confirmed: true }));
  assert.equal(f.read().paused, 'paused_unknown'); await g.stop();
});

test('foreign nonce locks are never stolen, expired or automatically removed', async t => {
  const f = await fixture(t), s = service(f); await f.save(); const lockFile = `${f.file}.execution.lock`;
  fs.writeFileSync(lockFile, 'stale-foreign-nonce'); fs.utimesSync(lockFile, new Date(0), new Date(0));
  await assert.rejects(f.run(), safeCode('locked')); assert.equal(fs.readFileSync(lockFile, 'utf8'), 'stale-foreign-nonce'); assert.equal(s.calls, 0);
  fs.writeFileSync(`${f.file}.cas.lock`, 'foreign-cas'); await assert.rejects(f.save(), safeCode('locked')); assert.equal(fs.readFileSync(`${f.file}.cas.lock`, 'utf8'), 'foreign-cas');
});

function legacy(extra = {}) { return { version: 1, keys: [], armed: null, missedDaily: null, lastAttemptAt: null, lastSuccessAt: null, unresolvedWindow: null, ...extra }; }
function retired(extra = {}) { return { version: 1, config: { enabled: false, time: '09:30', accounts: [] }, attempts: [], paused: false, ...extra }; }

test('legacy same-day attempts are persisted into the new safety journal', async t => {
  const f = await fixture(t), s = service(f); fs.writeFileSync(f.legacyFile, JSON.stringify(legacy({ lastAttemptAt: NOW }))); await f.save();
  await assert.rejects(f.run(), safeCode('legacy_day_blocked')); assert.deepEqual(f.read().legacyDays, ['2026-10-06']); assert.equal(s.calls, 0);
  fs.unlinkSync(f.legacyFile); await assert.rejects(f.run(), safeCode('legacy_day_blocked'));
});

for (const [name, content] of [
  ['legacy unknown', legacy({ unresolvedWindow: { accountKey: row().accountKey, attemptedAt: NOW } })],
  ['legacy future', legacy({ lastAttemptAt: NOW + 1 })],
  ['legacy unknown schema', { version: 3, keys: [] }],
]) test(name + ' blocks new execution without mutating old file', async t => {
  const f = await fixture(t), s = service(f), bytes = JSON.stringify(content); fs.writeFileSync(f.legacyFile, bytes); await f.save(); await assert.rejects(f.run()); assert.equal(s.calls, 0); assert.equal(fs.readFileSync(f.legacyFile, 'utf8'), bytes);
});

for (const d of [retired({ paused: true }), retired({ config: { enabled: true, time: '09:30', accounts: [] } }), { version: 99 }, retired({ attempts: [{ day: '2026-10-06', accountKey: row().accountKey, modelKey: row().modelKey, status: 'unknown', attemptedAt: NOW }] })]) test('retired multi unknown/enabled/malformed cannot be treated as empty', async t => {
  const f = await fixture(t), s = service(f); fs.writeFileSync(f.retiredMultiFile, JSON.stringify(d)); await f.save(); await assert.rejects(f.run()); assert.equal(s.calls, 0); assert(f.read().paused);
});

test('withLegacy shares durable claim, one attempt/day and unknown protection', async t => {
  const f = await fixture(t); let calls = 0;
  await f.c.withLegacy(async ({ signal }) => { assert.equal(signal.aborted, false); assert.equal(f.read().claims[0].status, 'dispatching'); calls++; return {}; });
  await assert.rejects(f.c.withLegacy(async () => calls++), safeCode('already_claimed')); assert.equal(calls, 1);
  service(f); await f.save(); await assert.rejects(f.run(), safeCode('legacy_day_blocked'));
  const g = await fixture(t); await assert.rejects(g.c.withLegacy(async () => { throw Error(SECRET); })); assert.equal(g.read().paused, 'paused_unknown');
});

test('enable then disable persistently pauses old startup/window plans across restart', async t => {
  const f = await fixture(t); service(f); await f.save(); await f.save(config([row()], { enabled: false }));
  assert.equal(f.read().legacyResumePaused, true);
  const g = new UnifiedWarmupCoordinator({ file: f.file, clock: f.now });
  await assert.rejects(g.withLegacy(async () => assert.fail('must not restore old plan')), safeCode('legacy_paused')); await g.stop();
});

function request(method = 'GET', body, headers = { 'content-type': 'application/json' }) { return { method, headers, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)); } }; }
async function http(c, req, authorize = () => true) {
  const r = {}; await unifiedWarmupHandler({ coordinator: c, authorize })(req, { writeHead(status, headers) { r.status = status; r.headers = headers; }, end(raw) { r.raw = raw; } }); return { ...r, body: r.raw ? JSON.parse(r.raw) : undefined };
}
test('HTTP strictly validates methods, payloads, consent and errors; no accidental model calls', async t => {
  const f = await fixture(t), s = service(f);
  assert.equal((await http(f.c, request('GET'))).status, 200);
  assert.equal((await http(f.c, request('HEAD'))).raw, undefined);
  assert.equal((await http(f.c, request('DELETE'))).status, 405);
  assert.equal((await http(f.c, request('PUT', { config: config(), revision: 'missing' }))).status, 400);
  assert.equal((await http(f.c, request('PUT', { config: config(), revision: 'missing', confirmed: true }))).status, 200);
  for (const body of [{ action: 'discover', refresh: true }, { action: 'refresh', accountKey: row().accountKey, accountGeneration: row().accountGeneration }, { action: 'retry' }, { action: 'reset' }, { action: 'run', revision: (await f.c.status()).revision, accountKeys: [row().accountKey], confirmed: false }, { action: 'cancel', token: SECRET }]) assert.equal((await http(f.c, request('POST', body))).status, 400);
  assert.equal((await http(f.c, request('POST', '{'))).status, 400);
  assert.equal((await http(f.c, request('POST', Buffer.from([0xff])))).status, 400);
  assert.equal((await http(f.c, request('POST', 'x'.repeat(16385)))).status, 413);
  assert.equal((await http(f.c, request('POST', {}, { 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await http(f.c, request('POST', { action: 'discover' }))).status, 200);
  assert.equal(s.calls, 0);
  const denied = await http(f.c, request('POST', { action: 'run' }), (req, res) => { res.writeHead(403, {}); res.end(); return false; }); assert.equal(denied.status, 403);
  const before = s.events.length; await http(f.c, request('GET')); assert.equal(s.events.length, before);
});

test('HTTP never exposes original provider errors or identity-bearing labels', async t => {
  const f = await fixture(t); service(f, { accountPatch: { label: SECRET }, listModels: async () => { throw Error(SECRET); } });
  const r = await http(f.c, request('POST', { action: 'discover' })); assert.equal(r.status, 503); assert.equal(r.body.error, 'unavailable'); assert(!r.raw.includes(SECRET));
  service(f, { accountPatch: { label: SECRET } }); const d = await f.c.discover(); assert(!JSON.stringify(d).includes(SECRET));
});

// A real second Node process (not a second coordinator in one JS heap) holds the
// exact execution lock through the batch. IPC merely releases its synthetic call.
const childCode = `
import fs from 'node:fs';
import { UnifiedWarmupCoordinator } from ${JSON.stringify(new URL('./unified-warmup.js', import.meta.url).href)};
const [file, mode] = process.argv.slice(1), now = ${NOW};
const row = ${JSON.stringify(row())};
const c = new UnifiedWarmupCoordinator({ file, clock: () => now });
c.setService({ connect(verify) { return {
 capabilities: () => ({contractVersion:1,ownerEpoch:'${OWNER}',accountBound:true,maxAccounts:8,startupFull:false,resetFull:false}),
 listAccounts: async () => ({accounts:[{accountKey:row.accountKey,accountGeneration:row.accountGeneration,budgetSubject:'${hex(400)}',active:false,label:'synthetic'}]}),
 listModels: async () => ({verified:true,revision:'${hex(999)}',models:[{modelKey:row.modelKey,name:'mock'}]}),
 readQuota: async () => ({status:'ready',fetchedAt:now}),
 prepare: async args => {
  if (mode === 'crash') { process.send({kind:'claimed'}); process.exit(0); }
  return {execute: async () => { process.send({kind:'executing'}); await new Promise(resolve => process.once('message',resolve)); return {}; }};
 }
}; }});
try { await c.runManual({revision:(await c.status()).revision,accountKeys:[row.accountKey],confirmed:true}); process.send({kind:'done'}); }
catch(e) { process.send({kind:'error',code:e.code}); }
process.disconnect();
`;
function child(file, mode) { return spawn(process.execPath, ['--input-type=module', '-e', childCode, file, mode], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }); }
function message(p) { return once(p, 'message').then(([m]) => m); }

test('real multi-process lease excludes another process and legacy during in-flight batch', async t => {
  const f = await fixture(t); service(f); await f.save();
  const p = child(f.file, 'hold'); t.after(() => { if (p.exitCode === null) p.kill(); });
  assert.equal((await message(p)).kind, 'executing');
  const q = child(f.file, 'compete'); t.after(() => { if (q.exitCode === null) q.kill(); });
  assert.deepEqual(await message(q), { kind: 'error', code: 'locked' });
  await assert.rejects(f.c.withLegacy(async () => assert.fail('must not overlap')), safeCode('locked'));
  const done = message(p); p.send('finish'); assert.equal((await done).kind, 'done');
  await Promise.all([p.exitCode === null ? once(p, 'exit') : null, q.exitCode === null ? once(q, 'exit') : null]);
  assert.equal(f.read().claims.length, 1); assert.equal(f.read().claims[0].status, 'succeeded');
});

test('owner hot replacement needs explicit saved reauthorization before another batch', async t => {
  const f = await fixture(t); service(f); await f.save(); const s = service(f);
  assert.equal((await f.c.status()).view.reason, 'owner_reauthorization_required');
  await assert.rejects(f.run(), safeCode('owner_reauthorization_required')); assert.equal(s.calls, 0);
  await f.save(); await f.run(); assert.equal(s.calls, 1);
});

test('legacy callback cannot forge local-unsent after its execution boundary', async t => {
  const f = await fixture(t);
  await assert.rejects(f.c.withLegacy(async () => { throw Object.assign(Error(SECRET), { requestNotSent: true }); }));
  assert.equal(f.read().claims[0].status, 'unknown'); assert.equal(f.read().paused, 'paused_unknown');
  assert(fs.existsSync(`${f.file}.execution.lock`));
});

test('explicit account refresh is serialized without executing or changing config', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const s = service(f, { listModels: async args => { if (args.refresh) { entered.resolve(); await release.promise; } return { verified: true, revision: hex(999), models: [{ modelKey: row().modelKey, name: 'mock' }] }; } });
  await f.save(); const before = fs.readFileSync(f.file);
  const first = f.c.refreshAccount({ accountKey: row().accountKey, accountGeneration: row().accountGeneration }); await entered.promise;
  await assert.rejects(f.c.refreshAccount({ accountKey: row().accountKey, accountGeneration: row().accountGeneration }), safeCode('busy'));
  release.resolve(); await first; assert.equal(s.calls, 0); assert.deepEqual(fs.readFileSync(f.file), before);
});

test('failed final and unknown commits retain the original durable dispatching record', async t => {
  const f = await fixture(t), s = service(f); await f.save(); const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === f.file) { const d = JSON.parse(fs.readFileSync(from, 'utf8')); if (['succeeded', 'unknown'].includes(d.claims.at(-1)?.status)) throw Object.assign(Error('write failed'), { code: 'ENOSPC' }); }
    return rename(from, to);
  });
  await assert.rejects(f.run()); assert.equal(s.calls, 1); assert.equal(f.read().claims[0].status, 'dispatching');
  assert(fs.existsSync(`${f.file}.execution.lock`)); assert(fs.existsSync(`${f.file}.paused-storage`));
  await assert.rejects(f.run()); assert.equal(s.calls, 1);
});

test('observer tick cannot quarantine another live process or cause its next row to run twice', async t => {
  const f = await fixture(t); service(f); await f.save();
  const p = child(f.file, 'hold'); t.after(() => { if (p.exitCode === null) p.kill(); });
  assert.equal((await message(p)).kind, 'executing'); await f.c.tick(NOW);
  assert.equal(f.read().paused, null); assert.equal(f.read().claims[0].status, 'dispatching');
  const done = message(p); p.send('finish'); assert.equal((await done).kind, 'done');
  if (p.exitCode === null) await once(p, 'exit'); assert.equal(f.read().claims[0].status, 'succeeded');
});

test('real process exit after durable claim preserves orphan and nonce, never auto-replays', async t => {
  const f = await fixture(t), s = service(f); await f.save(); const p = child(f.file, 'crash'); t.after(() => { if (p.exitCode === null) p.kill(); });
  assert.equal((await message(p)).kind, 'claimed'); if (p.exitCode === null) await once(p, 'exit');
  assert.equal(f.read().claims[0].status, 'claimed'); const locked = fs.readFileSync(`${f.file}.execution.lock`, 'utf8');
  await assert.rejects(f.run(), safeCode('locked')); assert.equal(s.calls, 0); assert.equal(fs.readFileSync(`${f.file}.execution.lock`, 'utf8'), locked);
  assert.equal((await f.c.status()).view.status, 'paused_unknown');
});
