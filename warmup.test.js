import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CodexWarmupScheduler, warmupPreferences, localSchedule, loadWarmupJournal } from './warmup.js';
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
    signal: options.signal,
  });
  return { scheduler, calls, saves, reports, async tick(at, raw = prefs) { now = at; await scheduler.tick(raw, at); } };
}

test('warm-up defaults are strict, independent and reject invalid HH:mm', () => {
  assert.deepEqual(warmupPreferences(null), { daily: false, time: '09:30', reset: false });
  assert.deepEqual(warmupPreferences({ codexWarmupDaily: 'true', codexWarmupReset: 1 }), { daily: false, time: '09:30', reset: false });
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
