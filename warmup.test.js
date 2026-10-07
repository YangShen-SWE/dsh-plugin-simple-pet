import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CodexWarmupScheduler, warmupPreferences, localSchedule, loadWarmupJournal, WARMUP_RETRY_DELAY, WARMUP_TIMEOUT } from './warmup.js';
import { runCodexWarmup, chooseWarmupModel } from './warmup-call.js';
import { readCodexQuota } from './codex.js';

const ACCOUNT = '0123456789abcdef';
const base = new Date(2026, 9, 6, 9, 29, 50).getTime();
const due = base + 10_000;
const prefs = { codexWarmupDaily: true, codexWarmupTime: '09:30', codexWarmupReset: false };
function fresh(now, patch = {}) {
  return { provider: 'openai-codex', selection: 'active', status: 'ready', accountKey: ACCOUNT, observedAt: now,
    fiveHour: { remainingPercent: 80, resetAt: due + 18_000_000 },
    weekly: { remainingPercent: 90, resetAt: due + 604_800_000 }, ...patch };
}
function fixture(options = {}) {
  let now = base;
  const calls = [], saves = [], reports = [];
  const scheduler = new CodexWarmupScheduler({ clock: () => now, journal: options.journal,
    getQuota: async args => { reports.push(args.force); return options.getQuota ? options.getQuota(args, now) : fresh(now); },
    save: async journal => { saves.push(structuredClone(journal)); if (options.failSave) throw new Error('private failure'); },
    run: async args => { calls.push(args); if (options.run) return options.run(args); return { model: 'gpt-test' }; },
    signal: options.signal, wait: options.wait ?? (async () => {}),
  });
  return { scheduler, calls, saves, reports, async tick(at, raw = prefs) { now = at; await scheduler.tick(raw, at); } };
}

test('warm-up defaults are strict, independent and reject invalid HH:mm', () => {
  assert.deepEqual(warmupPreferences(null), { daily: false, time: '09:30', reset: false, startup: false });
  assert.deepEqual(warmupPreferences({ codexWarmupDaily: 'true', codexWarmupReset: 1 }), { daily: false, time: '09:30', reset: false, startup: false });
  for (const time of ['9:30', '24:00', '09:60', '09:30\n', '', ' 09:30', '09:30x']) {
    assert.equal(warmupPreferences({ ...prefs, codexWarmupTime: time }).daily, false, time);
  }
  assert.equal(warmupPreferences({ ...prefs, codexWarmupDaily: false, codexWarmupReset: true }).reset, true);
});

test('disabled settings make no quota or model calls', async () => {
  const f = fixture(); await f.tick(due, null);
  assert.deepEqual(f.reports, []); assert.equal(f.calls.length, 0); assert.equal(f.scheduler.view.status, 'disabled');
});

test('daily fires once, claims before model and stays deduplicated across restart', async () => {
  const f = fixture(); await f.tick(base); assert.equal(f.calls.length, 0);
  await f.tick(due + 5000); assert.equal(f.calls.length, 1);
  assert.equal(f.scheduler.view.status, 'succeeded');
  assert.deepEqual(f.reports, [false, false, true]);
  assert.ok(f.saves.some(j => j.keys.includes('daily:2026-10-06') && j.lastSuccessAt === null));
  await f.tick(due + 10_000); assert.equal(f.calls.length, 1);
  const restarted = fixture({ journal: f.scheduler.journal }); await restarted.tick(due + 15_000);
  assert.equal(restarted.calls.length, 0);
  const changedTime = { ...prefs, codexWarmupTime: '09:31' }; await f.tick(due + 60_000, changedTime);
  assert.equal(f.calls.length, 1, 'time changes cannot produce a second daily attempt');
});

test('missed daily time and long sleep are never caught up', async () => {
  const late = fixture(); await late.tick(due + 60_000); assert.equal(late.calls.length, 0);
  const slept = fixture(); await slept.tick(base - 300_000); await slept.tick(due + 5000);
  assert.equal(slept.calls.length, 0);
  await slept.tick(due + 10_000); assert.equal(slept.calls.length, 0, 'second wake tick also skips');
  const booted = fixture(); await booted.tick(due + 20_000); await booted.tick(due + 25_000);
  assert.equal(booted.calls.length, 0, 'startup during the scheduled minute is not catch-up');
  const restarted = fixture({ journal: slept.scheduler.journal }); await restarted.tick(due + 30_000);
  assert.equal(restarted.calls.length, 0, 'missed occurrence stays suppressed after restart');
  await booted.tick(due + 50_000, { ...prefs, codexWarmupTime: '09:31' });
  await booted.tick(due + 65_000, { ...prefs, codexWarmupTime: '09:31' });
  assert.equal(booted.calls.length, 1, 'a newly scheduled future time may still run today');
});

test('reset needs an armed, fresh dedicated 5h deadline; weekly reset alone never triggers', async () => {
  const resetPrefs = { ...prefs, codexWarmupDaily: false, codexWarmupReset: true };
  const f = fixture({ getQuota: (_args, now) => fresh(now, { fiveHour: { remainingPercent: 30, resetAt: due } }) });
  await f.tick(base, resetPrefs); assert.equal(f.calls.length, 0); assert.equal(f.scheduler.journal.armed.resetAt, due);
  await f.tick(due + 1000, resetPrefs); assert.equal(f.calls.length, 1);
  assert.equal(f.scheduler.view.lastReason, 'reset');
  await f.tick(due + 10_000, resetPrefs); assert.equal(f.calls.length, 1);
  const weekly = fixture({ getQuota: (_args, now) => fresh(now, { weekly: { remainingPercent: 80, resetAt: due } }) });
  await weekly.tick(base, resetPrefs); await weekly.tick(due + 1000, resetPrefs); assert.equal(weekly.calls.length, 0);
  const unarmed = fixture({ getQuota: (_args, now) => fresh(now, { fiveHour: { remainingPercent: 30, resetAt: due } }) });
  await unarmed.tick(due + 1000, resetPrefs); assert.equal(unarmed.calls.length, 0);
});

test('daily and reset in the same tick coalesce into one logical attempt', async () => {
  const both = { ...prefs, codexWarmupReset: true };
  const f = fixture({ getQuota: (_args, now) => fresh(now, { fiveHour: { remainingPercent: 30, resetAt: due } }) });
  await f.tick(base, both); await f.tick(due + 1000, both);
  assert.equal(f.calls.length, 1); assert.equal(f.scheduler.journal.keys.length, 2);
});

test('reset skips late wakeup, pre-reset cached report and already-used new window', async () => {
  const resetPrefs = { ...prefs, codexWarmupDaily: false, codexWarmupReset: true };
  for (const mode of ['late', 'cached', 'used']) {
    const f = fixture({ getQuota: ({ force }, now) => fresh(now, {
      observedAt: force && mode === 'cached' ? due - 1000 : now,
      fiveHour: { remainingPercent: 30, resetAt: force && mode === 'used' ? due + 18_000_000 : due },
    }) });
    await f.tick(base, resetPrefs); await f.tick(due + (mode === 'late' ? 100_000 : 1000), resetPrefs);
    assert.equal(f.calls.length, 0, mode);
  }
});

test('sleep or restart cannot replay an armed reset after stale then fresh reports', async () => {
  const resetPrefs = { ...prefs, codexWarmupDaily: false, codexWarmupReset: true };
  const f = fixture({ getQuota: (_args, now) => fresh(now, {
    observedAt: now === due + 20_000 ? due - 200_000 : now,
    fiveHour: { remainingPercent: 30, resetAt: due },
  }) });
  await f.tick(base - 300_000, resetPrefs);
  await f.tick(due + 20_000, resetPrefs); await f.tick(due + 25_000, resetPrefs);
  assert.equal(f.calls.length, 0);
  const restarted = fixture({ journal: { version: 1, keys: [], armed: { accountKey: ACCOUNT, resetAt: due } },
    getQuota: (_args, now) => fresh(now, { fiveHour: { remainingPercent: 30, resetAt: due } }) });
  await restarted.tick(due + 1000, resetPrefs); await restarted.tick(due + 5000, resetPrefs);
  assert.equal(restarted.calls.length, 0);
});

test('unknown/stale/multi-provider/zero quota and account switch fail closed', async () => {
  const patches = [
    { status: 'reported', provider: 'codex', selection: 'default', observedAt: null },
    { status: 'signed-out' }, { observedAt: due - 121_000 }, { observedAt: due + 6000 },
    { fiveHour: null }, { weekly: null }, { fiveHour: { remainingPercent: NaN } },
    { fiveHour: { remainingPercent: 0, resetAt: due + 1000 } },
    { weekly: { remainingPercent: 0, resetAt: due + 1000 } },
    { accountKey: 'fedcba9876543210' },
  ];
  for (const patch of patches) {
    const f = fixture({ getQuota: ({ force }, now) => fresh(now, force ? patch : {}) });
    await f.tick(due); assert.equal(f.calls.length, 0, JSON.stringify(patch));
  }
});

test('failed model or journal saves never retry a claimed occurrence', async () => {
  for (const options of [{ run: () => { throw new Error('secret upstream'); } }, { failSave: true }]) {
    const f = fixture(options); await f.tick(due); await f.tick(due + 5000);
    assert.equal(f.calls.length, options.failSave ? 0 : 1);
    assert.ok(!JSON.stringify(f.scheduler.view).includes('secret'));
  }
});

test('settings changes abort and prevent overlap; unload awaits settlement', async () => {
  let startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const f = fixture({ run: ({ signal }) => new Promise((resolve, reject) => {
    startedResolve(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const first = f.tick(due); await started;
  await f.tick(due + 1000, { ...prefs, codexWarmupDaily: false }); await first;
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].signal.aborted, true);
  await f.tick(due + 2000, null); assert.equal(f.scheduler.view.status, 'disabled');
  const second = fixture({ run: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const task = second.tick(due); await new Promise(resolve => setImmediate(resolve));
  await second.scheduler.stop(); await task;
  await second.tick(due + 1000); assert.equal(second.calls.length, 1);
});

test('local schedule handles DST skip/repeat and system timezone changes', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'Europe/Copenhagen';
    const spring = localSchedule(new Date(2026, 2, 29, 1, 0).getTime(), '02:30');
    assert.equal(spring.at, null); assert.equal(new Date(spring.next).getDate(), 30);
    const before = localSchedule(new Date('2026-10-25T00:15:00Z').getTime(), '02:30');
    const after = localSchedule(new Date('2026-10-25T01:15:00Z').getTime(), '02:30');
    assert.equal(before.day, after.day); assert.equal(before.at, after.at);
    const stamp = Date.UTC(2026, 9, 6, 6, 0);
    process.env.TZ = 'Asia/Shanghai'; const china = localSchedule(stamp, '09:30').at;
    process.env.TZ = 'Europe/Copenhagen'; const europe = localSchedule(stamp, '09:30').at;
    assert.notEqual(china, europe);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('journal whitelists data and bounds retention', () => {
  const loaded = loadWarmupJournal({ keys: ['email@example.org', 'daily:2026-10-06', `reset:${ACCOUNT}:${due}`],
    armed: { accountKey: ACCOUNT, resetAt: due, email: 'secret' }, response: 'secret', token: 'secret' });
  assert.equal(loaded.keys.length, 2); assert.ok(!JSON.stringify(loaded).includes('secret'));
});

const startupPrefs = { codexWarmupStartup: true };
const unused = now => fresh(now, { fiveHour: { remainingPercent: 100, resetAt: due + 18_000_000 } });

test('startup is opt-in, requires fresh 100% 5h, and persists window dedup across reboot', async () => {
  const f = fixture({ getQuota: (_args, now) => unused(now) });
  await f.tick(base, startupPrefs);
  assert.equal(f.calls.length, 1); assert.equal(f.scheduler.view.lastReason, 'startup');
  assert.deepEqual(f.reports, [true, true]);
  assert.ok(f.scheduler.journal.keys.includes(`window:${ACCOUNT}:${due + 18_000_000}`));
  await f.tick(base + 5000, startupPrefs); assert.equal(f.calls.length, 1);
  const reboot = fixture({ journal: f.scheduler.journal, getQuota: (_args, now) => unused(now) });
  await reboot.tick(base + 10_000, startupPrefs); assert.equal(reboot.calls.length, 0);
  for (const patch of [{ fiveHour: { remainingPercent: 99, resetAt: due + 18_000_000 } },
    { fiveHour: { remainingPercent: 100, resetAt: null } }, { observedAt: base - 121_000 },
    { weekly: null }, { weekly: { remainingPercent: 0, resetAt: due + 18_000_000 } }]) {
    const bad = fixture({ getQuota: (_args, now) => ({ ...unused(now), ...patch }) });
    await bad.tick(base, startupPrefs); assert.equal(bad.calls.length, 0, JSON.stringify(patch));
  }
});

test('startup waits for a usable quota report rather than consuming the check during bridge loading', async () => {
  let ready = false;
  const f = fixture({ getQuota: (_args, now) => ready ? unused(now)
    : { status: 'loading', observedAt: null, fiveHour: null, weekly: null } });
  await f.tick(base, startupPrefs);
  assert.equal(f.scheduler.startupChecked, false); assert.equal(f.calls.length, 0);
  ready = true; await f.tick(base + 60_000, startupPrefs);
  assert.equal(f.calls.length, 1); assert.equal(f.scheduler.view.lastReason, 'startup');
  await f.tick(base + 120_000, startupPrefs); assert.equal(f.calls.length, 1);
});

test('periodic reset checking warms an early restored full window and never repeats sustained 100%', async () => {
  const raw = { codexWarmupReset: true };
  let full = false;
  const f = fixture({ getQuota: (_args, now) => full ? unused(now) : fresh(now) });
  await f.tick(base, raw); assert.equal(f.calls.length, 0);
  full = true;
  await f.tick(base + 60_000, raw);
  assert.equal(f.calls.length, 1); assert.equal(f.scheduler.view.lastReason, 'full');
  assert.ok(base + 60_000 < f.scheduler.journal.armed.resetAt, 'does not wait for the old reset deadline');
  await f.tick(base + 120_000, raw); await f.tick(base + 180_000, raw);
  assert.equal(f.calls.length, 1, 'a tiny successful call may still report rounded 100%');
  const reboot = fixture({ journal: f.scheduler.journal, getQuota: (_args, now) => unused(now) });
  await reboot.tick(base + 180_000, raw); assert.equal(reboot.calls.length, 0);
});

test('periodic full checking finds a changed deadline while quota remains 100%', async () => {
  let resetAt = due + 18_000_000;
  const f = fixture({ getQuota: (_args, now) => fresh(now, { fiveHour: { remainingPercent: 100, resetAt } }) });
  const raw = { codexWarmupReset: true };
  await f.tick(base, raw); assert.equal(f.calls.length, 1);
  resetAt += 3_600_000;
  await f.tick(base + 60_000, raw); assert.equal(f.calls.length, 2);
  await f.tick(base + 120_000, raw); assert.equal(f.calls.length, 2);
});

test('full unused quota with an expired idle deadline can start a window without repeat calls', async () => {
  for (const raw of [startupPrefs, { codexWarmupReset: true }]) {
    const expired = base - 60_000;
    let sent = false;
    const f = fixture({ getQuota: (_args, now) => fresh(now, { fiveHour: {
      remainingPercent: 100, resetAt: sent ? due + 18_000_000 : expired,
    } }), run: async () => { sent = true; return { model: 'test' }; } });
    await f.tick(base, raw); assert.equal(f.calls.length, 1);
    assert.ok(f.scheduler.journal.keys.includes(`window:${ACCOUNT}:${expired}`));
    assert.ok(f.scheduler.journal.keys.includes(`window:${ACCOUNT}:${due + 18_000_000}`));
    await f.tick(base + 60_000, raw); assert.equal(f.calls.length, 1);
    const reboot = fixture({ journal: f.scheduler.journal, getQuota: (_args, now) => unused(now) });
    await reboot.tick(base + 120_000, raw); assert.equal(reboot.calls.length, 0);
  }
});

test('periodic full detection still rejects stale/default/unknown/exhausted quota and disabled switches', async () => {
  for (const patch of [{ observedAt: base - 121_000 }, { selection: 'default' }, { weekly: null },
    { weekly: { remainingPercent: 0, resetAt: due + 604_800_000 } },
    { fiveHour: { remainingPercent: 100, resetAt: null } }]) {
    const f = fixture({ getQuota: (_args, now) => ({ ...unused(now), ...patch }) });
    await f.tick(base, { codexWarmupReset: true }); assert.equal(f.calls.length, 0);
  }
  const daily = fixture({ getQuota: (_args, now) => unused(now) });
  await daily.tick(base, prefs); assert.equal(daily.calls.length, 0, 'daily alone does not opt into full-quota requests');
});

test('startup/daily/reset share one window claim and never duplicate a same-window request', async () => {
  const f = fixture({ getQuota: (_args, now) => unused(now) });
  const all = { ...prefs, codexWarmupStartup: true, codexWarmupReset: true };
  await f.tick(base, all); await f.tick(due, all);
  assert.equal(f.calls.length, 1); assert.ok(f.scheduler.journal.keys.includes('daily:2026-10-06'));
  const daily = fixture({ getQuota: (_args, now) => unused(now) }); await daily.tick(due);
  const reboot = fixture({ journal: daily.scheduler.journal, getQuota: (_args, now) => unused(now) });
  await reboot.tick(due + 5000, startupPrefs); assert.equal(reboot.calls.length, 0);
});

test('single deadline wake allows hours-long intentional gap but late/sleep wake is suppressed', async () => {
  const early = base - 8 * 3_600_000;
  const f = fixture(); await f.tick(early);
  assert.equal(f.scheduler.nextWakeAt(early), due);
  assert.equal(f.scheduler.nextDelay(early), due - early);
  await f.tick(due + 1000); assert.equal(f.calls.length, 1);
  assert.ok(f.scheduler.nextWakeAt(due + 1000) > due + 23 * 3_600_000);
  const late = fixture(); await late.tick(early); late.scheduler.nextWakeAt(early);
  await late.tick(due + 60_000); await late.tick(due + 65_000); assert.equal(late.calls.length, 0);
  const reset = fixture({ getQuota: (_args, now) => fresh(now, { fiveHour: { remainingPercent: 30, resetAt: due } }) });
  const resetPrefs = { codexWarmupReset: true };
  await reset.tick(early, resetPrefs); assert.equal(reset.scheduler.nextWakeAt(early), due);
  await reset.tick(due + 1000, resetPrefs); assert.equal(reset.calls.length, 1);
  const disabled = fixture(); await disabled.tick(base, null);
  assert.equal(disabled.scheduler.nextDelay(base), null); await f.scheduler.stop();
  assert.equal(f.scheduler.nextWakeAt(due), null);
});

test('only proven unsent run failures retry, at most 3 attempts with 5 second delays', async () => {
  let count = 0; const waits = [];
  const f = fixture({ wait: async ms => waits.push(ms), run: () => {
    if (++count < 3) throw Object.assign(new Error('secret'), { requestNotSent: true });
    return { model: 'gpt-test' };
  } });
  await f.tick(due); assert.equal(f.calls.length, 3);
  assert.deepEqual(waits, [WARMUP_RETRY_DELAY, WARMUP_RETRY_DELAY]);
  assert.equal(f.scheduler.view.status, 'succeeded');
  const terminal = fixture({ run: () => { throw Object.assign(new Error('secret'), { requestNotSent: true }); } });
  await terminal.tick(due); await terminal.tick(due + 5000);
  assert.equal(terminal.calls.length, 3); assert.equal(terminal.scheduler.view.status, 'failed');
  assert.ok(terminal.scheduler.view.alertId); assert.ok(terminal.scheduler.view.safetyHint);
  assert.ok(!JSON.stringify(terminal.scheduler.view).includes('secret'));
  const unknown = fixture({ run: () => { throw new Error('secret'); } });
  await unknown.tick(due); assert.equal(unknown.calls.length, 1);
  assert.match(unknown.scheduler.view.safetyHint, /结果未知/);
});

test('precheck errors retry safely and terminal daily claims cannot replay', async () => {
  let forced = 0;
  const f = fixture({ getQuota: ({ force }, now) => {
    if (force && ++forced < 3) throw new Error('quota transport'); return fresh(now);
  } });
  await f.tick(due); assert.equal(forced, 3); assert.equal(f.calls.length, 1);
  let reads = 0;
  const terminal = fixture({ getQuota: () => { reads++; throw new Error('quota unavailable'); } });
  await terminal.tick(due); assert.equal(reads, 3); assert.ok(terminal.scheduler.view.alertId);
  await terminal.tick(due + 5000); assert.equal(terminal.calls.length, 0);
  assert.equal(reads, 4, 'next tick may refresh quota but must not re-run the claimed occurrence');
});

test('account switch on proven-unsent failure skips rather than retrying', async () => {
  const f = fixture({ run: () => { throw Object.assign(new Error('account'), { requestNotSent: true, accountChanged: true }); } });
  await f.tick(due); assert.equal(f.calls.length, 1); assert.equal(f.scheduler.view.status, 'skipped');
  assert.equal(f.scheduler.view.alertId, null);
});

test('retry waits and uncooperative external waits are cancellable', async () => {
  let waiting; const started = new Promise(resolve => { waiting = resolve; });
  const f = fixture({ run: () => { throw Object.assign(new Error('preflight'), { requestNotSent: true }); },
    wait: () => { waiting(); return new Promise(() => {}); } });
  const task = f.tick(due); await started;
  await f.tick(due + 1000, null); await task;
  assert.equal(f.calls.length, 1); await f.tick(due + 2000, null);
  assert.equal(f.scheduler.view.status, 'disabled');
  const blocked = fixture({ getQuota: () => new Promise(() => {}) });
  const pending = blocked.tick(due); await new Promise(resolve => setImmediate(resolve));
  await blocked.scheduler.stop(); await pending; assert.equal(blocked.calls.length, 0);
});

test('expired idle deadlines cannot permanently suppress future daily warmup', async () => {
  const idle = fixture({ getQuota: (_args, now) => fresh(now, { fiveHour: { remainingPercent: 100, resetAt: due - 1000 } }) });
  await idle.tick(due);
  assert.equal(idle.calls.length, 1); assert.equal(idle.scheduler.journal.unresolvedWindow.accountKey, ACCOUNT);
  assert.ok(!idle.scheduler.journal.keys.includes(`window:${ACCOUNT}:${due - 1000}`));
  const tomorrow = due + 86_400_000;
  await idle.tick(tomorrow - 10_000); await idle.tick(tomorrow);
  assert.equal(idle.calls.length, 2);
  const reboot = fixture({ journal: idle.scheduler.journal, getQuota: (_args, now) => fresh(now,
    { fiveHour: { remainingPercent: 100, resetAt: tomorrow + 18_000_000 } }) });
  await reboot.tick(tomorrow + 5000, { codexWarmupStartup: true }); assert.equal(reboot.calls.length, 0);
});

test('post-call quota refresh records a real newly started window for reboot dedup', async () => {
  let sent = false;
  const f = fixture({ getQuota: (_args, now) => fresh(now, {
    fiveHour: { remainingPercent: 100, resetAt: sent ? due + 18_000_000 : due - 1000 },
  }), run: () => { sent = true; return { model: 'gpt-test' }; } });
  await f.tick(due); assert.equal(f.calls.length, 1);
  assert.ok(f.scheduler.journal.keys.includes(`window:${ACCOUNT}:${due + 18_000_000}`));
  assert.equal(f.scheduler.journal.unresolvedWindow, null);
  const reboot = fixture({ journal: f.scheduler.journal, getQuota: (_args, now) => unused(now) });
  await reboot.tick(due + 5000, startupPrefs); assert.equal(reboot.calls.length, 0);
});

test('stream timeout is unknown and never retries even if adapter ignores cancellation', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let startedResolve; const started = new Promise(resolve => { startedResolve = resolve; });
  const f = fixture({ run: () => { startedResolve(); return new Promise(() => {}); } });
  const task = f.tick(due); await started;
  context.mock.timers.tick(WARMUP_TIMEOUT); await task;
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.scheduler.view.status, 'failed'); assert.ok(f.scheduler.view.alertId);
  assert.match(f.scheduler.view.safetyHint, /结果未知/);
  await f.tick(due + 1000); assert.equal(f.calls.length, 1);
});

test('precheck timeouts can retry, but still stop at 3 total attempts', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let forced = 0, announce;
  const reports = () => new Promise(resolve => { announce = resolve; });
  let started = reports();
  const f = fixture({ getQuota: ({ force }, now) => {
    if (!force) return fresh(now);
    forced++; announce(); return new Promise(() => {});
  } });
  const task = f.tick(due);
  for (let i = 0; i < 3; i++) {
    await started; started = reports(); context.mock.timers.tick(WARMUP_TIMEOUT);
  }
  await task; assert.equal(forced, 3); assert.equal(f.calls.length, 0);
  assert.ok(f.scheduler.view.alertId); assert.match(f.scheduler.view.safetyHint, /未调用模型/);
});

function callFixture({ accountAfter = 'account-A', chunks, defaultProvider = 'deepseek-official' } = {}) {
  const calls = [], requests = [], usages = [];
  let statusCount = 0;
  const accountKey = createHash('sha256').update('account-A').digest('hex').slice(0, 16);
  const bridge = { async fetch(request) {
    const body = await request.json(); requests.push(body);
    let value;
    if (body.method === 'codex-subscription/status') value = { authenticated: true,
      accounts: [{ id: statusCount++ === 0 ? 'account-A' : accountAfter, active: true, email: 'private@example.org' }] };
    else if (body.method === 'codex-subscription/default-model/status') value = { managed: defaultProvider === 'openai-codex', provider: defaultProvider, model: 'gpt-second' };
    else throw new Error('unexpected RPC');
    return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } });
  } };
  const llm = {
    async listModels(provider) { assert.equal(provider, 'openai-codex'); return [{ provider, id: 'gpt-first' }, { provider, id: 'gpt-second' }]; },
    async resolveModelInfo(provider, model, signal) { return { provider, id: model, reasoning: { efforts: [{ id: 'high' }, { id: 'low' }] } }; },
    async *stream(options) {
      calls.push(options);
      for (const chunk of chunks ?? [{ type: 'text-delta', text: 'OK' }, { type: 'usage', usage: { inputTokens: 8, outputTokens: 1 } }, { type: 'finish', reason: { kind: 'stop' } }]) yield chunk;
    },
  };
  return { calls, requests, usages, llm, bridge, quota: { accountKey }, signal: new AbortController().signal,
    onUsage(usage, model) { usages.push({ usage, model }); } };
}

test('real-call seam sends only minimal user text, no context/tools/selection writes', async () => {
  const f = callFixture(); const result = await runCodexWarmup(f);
  assert.equal(result.model, 'gpt-first'); assert.equal(f.calls.length, 1);
  const options = f.calls[0]; assert.equal(options.provider, 'openai-codex'); assert.equal(options.reasoningEffort, 'low');
  assert.deepEqual(options.messages, [{ role: 'user', content: [{ type: 'text', text: 'Reply only OK.' }] }]);
  assert.deepEqual(options.tools, []);
  for (const key of ['system', 'sessionId', 'purpose', 'toolHistory', 'maxTokens', 'maxRetries', 'transport']) assert.ok(!(key in options), key);
  assert.equal(f.usages.length, 1); assert.ok(f.requests.every(r => !/update|select|consume/.test(r.method)));
  const codex = callFixture({ defaultProvider: 'openai-codex' });
  assert.equal((await chooseWarmupModel(codex.llm, codex.bridge, codex.signal)).model, 'gpt-second');
});

test('missing/error/aborted/blank finish is not success; final usage counted once', async () => {
  for (const kind of [null, 'error', 'aborted', 'tool-calls', 'max-tokens', 'blank']) {
    const chunks = [{ type: 'text-delta', text: kind === 'blank' ? '  ' : 'OK' },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'usage', usage: { inputTokens: 8, outputTokens: 1 } },
      ...(kind === null ? [] : [{ type: 'finish', reason: { kind: kind === 'blank' ? 'stop' : kind } }])];
    const f = callFixture({ chunks }); await assert.rejects(runCodexWarmup(f));
    assert.equal(f.calls.length, 1); assert.equal(f.usages.length, 1); assert.equal(f.usages[0].usage.inputTokens, 8);
  }
});

test('account switch during stream is not claimed as success', async () => {
  const f = callFixture({ accountAfter: 'account-B' }); await assert.rejects(runCodexWarmup(f), /active account changed/);
  assert.equal(f.calls.length, 1); assert.equal(f.usages.length, 1);
});

test('forced quota reads remain guarded public RPC without changing default polling', async () => {
  for (const force of [false, true]) {
    const requests = [], now = Date.now();
    const bridge = { async fetch(request) {
      const body = await request.json(); requests.push(body);
      const value = body.method.endsWith('/status') ? { authenticated: true, accounts: [{ id: 'A', active: true }] }
        : { fetchedAt: now, rateLimits: [{ id: 'codex', windows: [{ windowSeconds: 18000, remainingPercent: 80, resetsAt: Math.floor(now / 1000) + 18000 }] }] };
      return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } });
    } };
    await readCodexQuota(bridge, new AbortController().signal, now, 'openai-codex', { force });
    assert.equal(requests.find(r => r.method.endsWith('/usage')).payload.force, force);
    assert.deepEqual(requests.map(r => r.method), ['codex-subscription/status', 'codex-subscription/usage', 'codex-subscription/status']);
  }
});
