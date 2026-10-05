import assert from 'node:assert/strict';
import test from 'node:test';
import { readCodexQuota, normalizeCodexQuota, quotaDeltas, codexTokenItems } from './codex.js';
const NOW = 1_800_000_000_000;
const sample = (five = 80, week = 60, fetchedAt = NOW) => ({ fetchedAt, rateLimits: [
  { id: 'code_review', windows: [{ windowSeconds: 604800, remainingPercent: 99 }] },
  { id: 'codex', windows: [{ windowSeconds: 604800, remainingPercent: week, resetsAt: NOW / 1000 + 10000 },
    { windowSeconds: 18000, remainingPercent: five, resetsAt: NOW / 1000 + 5000 }] },
] });
function bridge(values) {
  const calls = [];
  return { calls, async fetch(request) {
    const body = await request.json();
    assert.equal(body.type, 'client-request');
    assert.equal(request.headers.get('content-type'), 'application/json');
    assert.equal(new URL(request.url).pathname, `/api/${body.method}`);
    calls.push(body);
    const value = typeof values === 'function' ? values(body, calls.length) : values[body.method];
    if (value === null) return new Response('', { status: 404 });
    return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } });
  } };
}
test('quota windows are classified by duration, not position or code-review quota', () => {
  const quota = normalizeCodexQuota(sample(0, 100), 'a', NOW);
  assert.equal(quota.status, 'ready');
  assert.equal(quota.fiveHour.remainingPercent, 0);
  assert.equal(quota.weekly.remainingPercent, 100);
  assert.equal(quota.fiveHour.resetAt, NOW + 5_000_000);
});
test('unknown, invalid, expired and old reports never become full or real-time quota', () => {
  assert.equal(normalizeCodexQuota({}, 'a', NOW).status, 'unavailable');
  assert.equal(normalizeCodexQuota(sample(-1, NaN), 'a', NOW).fiveHour, null);
  assert.equal(normalizeCodexQuota(sample(80, 60, NOW - 121000), 'a', NOW).status, 'stale');
  const data = sample(); data.rateLimits[1].windows[1].resetsAt = NOW / 1000 - 1;
  assert.equal(normalizeCodexQuota(data, 'a', NOW).status, 'stale');
  const noTimestamp = sample(); delete noTimestamp.fetchedAt;
  assert.equal(normalizeCodexQuota(noTimestamp, 'a', NOW).status, 'stale');
});
test('only new same-account same-reset percentage decreases generate observed deltas', () => {
  const previous = normalizeCodexQuota(sample(), 'a', NOW);
  const current = normalizeCodexQuota(sample(79, 59.5, NOW + 1000), 'a', NOW + 1000);
  assert.deepEqual(quotaDeltas(previous, current).map(e => [e.window, e.percent]), [['fiveHour', 1], ['weekly', .5]]);
  assert.ok(quotaDeltas(previous, current).every(event => event.accountKey === current.accountKey));
  assert.deepEqual(quotaDeltas(previous, { ...current, accountKey: 'b' }), []);
  assert.deepEqual(quotaDeltas(previous, { ...current, observedAt: NOW }), []);
  assert.deepEqual(quotaDeltas(previous, { ...current, status: 'stale' }), []);
  assert.deepEqual(quotaDeltas(previous, { ...current, fiveHour: { ...current.fiveHour, resetAt: NOW + 1 }, weekly: null }), []);
  assert.deepEqual(quotaDeltas(current, previous), []);
});
test('usage counts reported token buckets once and never converts reasoning or tokens to percent', () => {
  const items = codexTokenItems({ inputTokens: 100, cacheWriteTokens: 10, cacheReadTokens: 20, outputTokens: 30, reasoningTokens: 15 });
  assert.equal(items.reduce((sum, item) => sum + item.tokens, 0), 160);
  assert.ok(items.every(item => item.cny === null && item.billingMode === 'codex' && !('percent' in item)));
  assert.deepEqual(codexTokenItems({ inputTokens: -1, outputTokens: 1.5 }), []);
});
test('dedicated active account is checked before and after quota, with no account mutation', async () => {
  const status = { authenticated: true, accounts: [{ id: 'a', active: true, email: 'not-forwarded' }, { id: 'b', active: false }] };
  const fake = bridge({ 'codex-subscription/status': status, 'codex-subscription/usage': sample() });
  const quota = await readCodexQuota(fake, new AbortController().signal, NOW);
  assert.equal(quota.status, 'ready');
  assert.equal(quota.accountCount, 2);
  assert.equal(quota.selection, 'active');
  assert.ok(!JSON.stringify(quota).includes('not-forwarded'));
  assert.ok(fake.calls.every(call => /\/(status|usage)$/.test(call.method)));
  assert.deepEqual(fake.calls[1].payload, { force: false });
});
test('switching active accounts during a request discards the old quota', async () => {
  const fake = bridge((call, i) => call.method.endsWith('/usage') ? sample() : { authenticated: true, accounts: [{ id: i === 1 ? 'a' : 'b', active: true }] });
  const quota = await readCodexQuota(fake, new AbortController().signal, NOW);
  assert.equal(quota.status, 'switching');
  assert.equal(quota.fiveHour, null);
});
test('missing bridge routes and signed-out accounts remain unknown', async () => {
  const missing = await readCodexQuota(bridge(() => null), new AbortController().signal, NOW);
  assert.equal(missing.status, 'unsupported'); assert.equal(missing.fiveHour, null);
  const signedOut = await readCodexQuota(bridge({ 'codex-subscription/status': { authenticated: false } }), new AbortController().signal, NOW);
  assert.equal(signedOut.status, 'signed-out');
});
test('multi-provider fallback is explicitly default-account, potentially cached, and never measured delta', async () => {
  const fake = bridge({ 'codex-subscription/status': null,
    'subscriptions-auth.status': { providers: { codex: { accounts: [{ key: 'default-key', isDefault: true }, { key: 'second', isDefault: false }] } } },
    'subscriptions-auth.usage': { supported: true, windows: [{ kind: 'session', usedPercent: 20, resetsAt: NOW + 5000 }, { kind: 'weekly', usedPercent: 90, resetsAt: NOW + 6000 }] } });
  const quota = await readCodexQuota(fake, new AbortController().signal, NOW);
  assert.equal(quota.status, 'reported'); assert.equal(quota.selection, 'default'); assert.equal(quota.observedAt, null);
  assert.equal(quota.fiveHour.remainingPercent, 80); assert.equal(quota.weekly.resetAt, NOW + 6000);
  assert.deepEqual(fake.calls[2].payload, { provider: 'codex', account: 'default-key', force: false });
  assert.deepEqual(quotaDeltas(quota, { ...quota, receivedAt: NOW + 1000 }), []);
});
test('expired cached fallback keeps historical numbers but is explicitly stale', async () => {
  const quota = await readCodexQuota(bridge({
    'subscriptions-auth.status': { providers: { codex: { accounts: [{ key: 'default', isDefault: true }] } } },
    'subscriptions-auth.usage': { supported: true, windows: [{ kind: 'session', usedPercent: 100, resetsAt: NOW - 1000 }] },
  }), new AbortController().signal, NOW, 'codex');
  assert.equal(quota.status, 'stale');
  assert.equal(quota.fiveHour.remainingPercent, 0);
  assert.equal(quota.observedAt, null);
});
test('malformed or mismatched RPC responses fail closed', async () => {
  await assert.rejects(readCodexQuota({ fetch: async () => Response.json({ type: 'server-response', rpcId: 'wrong', result: { ok: true, value: {} } }) }, new AbortController().signal, NOW));
});
