import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Execute the actual shipped component region with a tiny hook/JSX host. No
// installed React, host services, real credentials, timers or network are used.
const source = await fs.readFile(new URL('./vendor/codex-subscription/lib/client.js', import.meta.url), 'utf8');
const region = source.split('//#region src/client-usage.jsx')[1]?.split('//#endregion')[0];
assert.ok(region, 'the full upstream usage component region must exist');
const fill = (text, values) => Object.entries(values).reduce((next, [key, value]) => next.replace(`{${key}}`, String(value)), text);
const t = key => ({ resetCreditsAvailable: 'available {count}', creditsMessages: 'local {local}, cloud {cloud}', creditsExpires: '{date}: {days} days', creditsExpiredToday: 'expires today {date}' })[key] ?? key;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function fixture(name, props = {}, { usage = { rateLimits: [] }, usageError } = {}) {
  let now = 1800000000000, index = 0, dirty = false, tree;
  const cells = [], effects = [], intervals = new Map(), calls = [];
  class Clock extends Date { static now() { return now; } }
  const react = {
    useState(initial) {
      const i = index++;
      if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial;
      return [cells[i], next => { const value = typeof next === 'function' ? next(cells[i]) : next; if (!Object.is(cells[i], value)) { cells[i] = value; dirty = true; } }];
    },
    useRef(initial) { const i = index++; return cells[i] ??= { current: initial }; },
    useEffect(run, deps) {
      const i = index++, old = cells[i];
      if (!old || !deps || deps.some((value, j) => !Object.is(value, old.deps[j]))) {
        effects.push(() => { old?.cleanup?.(); const entry = { deps }; cells[i] = entry; entry.cleanup = run(); });
      }
    },
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const rpc = props.rpc ?? { call: async (_channel, endpoint, payload) => { calls.push({ endpoint, payload }); return { ok: true, value: { availableCount: 0, credits: [] } }; } };
  const sandbox = {
    react, react_jsx_runtime: { jsx, jsxs: jsx, Fragment: 'Fragment' }, Button: 'button', CHANNEL: 'codex-subscription',
    Date: Clock, Error, Map, Number, fill, console,
    window: { setInterval: fn => { const id = Symbol(); intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id) },
    validDate: value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date : undefined; },
    creditExpiryStatus: expiry => ({ daysLeft: Math.max(0, Math.ceil((expiry.expiresAt - now) / 86400000)), soon: expiry.expiresAt - now <= 30 * 86400000 }),
    unwrap: result => { if (result?.ok === true) return result.value; throw new Error(result?.error?.message ?? 'RPC unavailable'); },
    recoveryCall: async (_rpc, endpoint, payload) => { calls.push({ endpoint, payload }); if (usageError) throw usageError; return usage; },
    notifyQuickQuota() {}, percent: String, windowLabel: () => 'window', formatQuotaForecast: () => 'forecast',
    fetch() { throw new Error('NETWORK_FORBIDDEN'); },
  };
  const components = vm.runInNewContext(`${region}\n;({ UsageCard, ResetCreditList, ResetCreditControl, CreditExpiry })`, sandbox);
  let current = { rpc, t, ...props };
  const render = (patch = {}) => {
    current = { ...current, ...patch };
    let runs = 0;
    do {
      dirty = false; index = 0;
      tree = components[name](current);
      for (const run of effects.splice(0)) run();
      assert.ok(++runs < 30, 'hook render must settle');
    } while (dirty);
    return tree;
  };
  const settle = async () => { await tick(); return render(); };
  const advance = ms => { now += ms; for (const callback of intervals.values()) callback(); return render(); };
  const dispose = () => { for (const cell of cells) cell?.cleanup?.(); };
  render();
  return { render, settle, advance, dispose, calls, get tree() { return tree; }, get now() { return now; } };
}
function nodes(tree, predicate) {
  const result = [];
  const visit = value => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    if (predicate(value)) result.push(value);
    visit(value.props?.children);
  };
  visit(tree); return result;
}
const text = tree => {
  if (Array.isArray(tree)) return tree.map(text).join(' ');
  if (tree == null || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  return text(tree.props?.children);
};
const button = (f, label) => nodes(f.tree, node => node.type === 'button' && text(node) === label)[0];
const component = (f, name) => nodes(f.tree, node => node.type?.name === name);
const click = node => { assert.ok(node, 'button must be visible'); assert.notEqual(node.props.disabled, true); node.props.onClick(); };

for (const usageError of [undefined, new Error('synthetic usage failure')]) test(`reset discovery survives absent summary / usage error ${!!usageError}`, async () => {
  const f = fixture('UsageCard', { signedIn: true, resetKey: 1 }, { usageError });
  await f.settle();
  assert.equal(component(f, 'ResetCreditList').length, 1);
  assert.equal(component(f, 'ResetCreditList')[0].props.count, undefined);
  assert.match(text(f.tree), /creditsBalance.*unavailable.*creditsUnknown/s);
  assert.deepEqual(f.calls.map(call => call.endpoint), ['usage']);
  f.render({ signedIn: false });
  assert.equal(component(f, 'ResetCreditList').length, 0);
  assert.doesNotMatch(text(f.tree), /creditsBalance/);
  f.dispose();
});

test('upstream Credits zero/unlimited/expiry/ranges/monthly limit remain distinct', async () => {
  const expiry = 1800000000000 + 86400000;
  const usage = { rateLimits: [], credits: { balance: '0', unlimited: false, expiresAt: expiry, expirySource: 'estimate', approxLocalMessages: [0, 10], approxCloudMessages: [0, 2] }, individualLimit: { remainingPercent: 50, used: 3, limit: 6 }, chatPass: { windows: [] }, resetCredits: { availableCount: 0 } };
  const f = fixture('UsageCard', { signedIn: true, resetKey: 1 }, { usage }); await f.settle();
  assert.match(text(f.tree), /0 creditsUnit/);
  assert.doesNotMatch(text(f.tree), /creditsUnknown/);
  assert.match(text(f.tree), /local 0–10, cloud 0–2/);
  assert.match(text(f.tree), /monthlyCreditLimit/);
  assert.equal(component(f, 'CreditExpiry')[0].props.credits.expiresAt, expiry);
  assert.equal(component(f, 'ResetCreditList')[0].props.count, 0);
  const e = fixture('CreditExpiry', { credits: usage.credits });
  assert.match(text(e.tree), /creditsExpiryEstimate/);
  const unlimited = fixture('UsageCard', { signedIn: true }, { usage: { rateLimits: [], credits: { unlimited: true } } }); await unlimited.settle();
  assert.match(text(unlimited.tree), /unlimited/); assert.doesNotMatch(text(unlimited.tree), /creditsAfterAllowance/);
  assert.equal(fixture('CreditExpiry', { credits: { unlimited: true, expiresAt: expiry } }).tree, null);
});

for (const count of [undefined, 0]) test(`missing/zero reset summary exposes read-only inspection, count=${count}`, async () => {
  const pending = deferred(), calls = [];
  const rpc = { call: (_channel, endpoint, payload) => { calls.push({ endpoint, payload }); return pending.promise; } };
  const f = fixture('ResetCreditList', { rpc, count });
  assert.equal(calls.length, 0);
  assert.match(text(f.tree), count === 0 ? /resetCreditEmpty/ : /resetCreditUnknown/);
  const read = button(f, 'resetInspect'); click(read); read.props.onClick();
  assert.equal(calls.length, 1, 'same-render double click only reads once');
  assert.equal(calls[0].endpoint, 'reset-credit/inspect');
  assert.equal(Object.keys(calls[0].payload).length, 0);
  pending.resolve({ ok: true, value: { availableCount: 1, credits: [{ ref: 'opaque-ref', name: 'Full reset' }] } });
  await f.settle();
  assert.equal(component(f, 'ResetCreditControl').length, 1);
  assert.match(text(f.tree), /available 1/);
  assert.equal(calls.length, 1, 'inspection never prepares or consumes');
});

test('positive summary keeps upstream auto-inspect, stale replies cannot restore previous cards', async () => {
  const a = deferred(), b = deferred(), calls = [];
  const rpc = { call: (_channel, endpoint) => { calls.push(endpoint); return calls.length === 1 ? a.promise : b.promise; } };
  const f = fixture('ResetCreditList', { rpc, count: 1, refreshKey: 'A' });
  assert.deepEqual(calls, ['reset-credit/inspect']);
  f.render({ refreshKey: 'B' }); assert.equal(calls.length, 2);
  b.resolve({ ok: true, value: { availableCount: 1, credits: [{ ref: 'B' }] } }); await f.settle();
  a.resolve({ ok: true, value: { availableCount: 1, credits: [{ ref: 'A' }] } }); await f.settle();
  assert.equal(component(f, 'ResetCreditControl')[0].props.credit.ref, 'B');
  f.dispose();
});

for (const reply of [
  { ok: true, value: { availableCount: 0, credits: [] } },
  { ok: false, error: { message: 'No quota reset is available' } },
  { ok: true, value: { availableCount: 1, credits: [] } },
  { ok: false, error: { message: 'synthetic transport failure' } },
  { ok: true, value: { credits: [{ ref: 'untrusted' }] } },
  { ok: true, value: { availableCount: 1, credits: [{ id: 'no-opaque-ref' }] } },
]) test(`reset empty/unusable/error states do not invent usable cards: ${JSON.stringify(reply)}`, async () => {
  const f = fixture('ResetCreditList', { rpc: { call: async () => reply } });
  click(button(f, 'resetInspect')); await f.settle();
  assert.equal(component(f, 'ResetCreditControl').length, 0);
  if (reply.value?.availableCount === 0 || reply.error?.message === 'No quota reset is available') assert.match(text(f.tree), /resetCreditEmpty/);
  else if (reply.value?.availableCount === 1 && reply.value.credits.length === 0) assert.match(text(f.tree), /resetCreditUnusable/);
  else { assert.match(text(f.tree), /resetCreditExpiryFailed/); assert.doesNotMatch(text(f.tree), /available 0/); }
});

function resetFixture({ readyAt, expiresAt, challengeId = 'challenge-A', consume } = {}) {
  const calls = []; let consumed = 0;
  const rpc = { call: async (_channel, endpoint, payload) => {
    calls.push({ endpoint, payload });
    return { ok: true, value: endpoint === 'reset-credit/prepare' ? { challengeId, readyAt: readyAt ?? 1800000005000, expiresAt: expiresAt ?? 1800000060000 } : consume ? await consume() : { code: 'reset' } };
  } };
  const f = fixture('ResetCreditControl', { rpc, credit: { ref: 'opaque-card', name: 'Full reset' }, onConsumed: () => { consumed++; } });
  return { ...f, get tree() { return f.tree; }, calls, get consumed() { return consumed; } };
}
const acknowledge = f => { const checkbox = nodes(f.tree, node => node.type === 'input' && node.props.type === 'checkbox')[0]; assert.ok(checkbox); checkbox.props.onChange({ target: { checked: true } }); f.render(); };

test('redemption requires prepare click, acknowledgement, cooldown and final click; double clicks stay single-flight', async () => {
  const f = resetFixture();
  assert.equal(f.calls.length, 0); assert.match(text(f.tree), /resetFull/);
  const prepare = button(f, 'resetUse'); click(prepare); prepare.props.onClick(); await f.settle();
  assert.deepEqual(f.calls.map(call => call.endpoint), ['reset-credit/prepare']);
  assert.equal(f.calls[0].payload.creditRef, 'opaque-card');
  button(f, 'resetFinal').props.onClick(); assert.equal(f.calls.length, 1);
  acknowledge(f); button(f, 'resetFinal').props.onClick(); assert.equal(f.calls.length, 1);
  f.advance(5001); assert.equal(f.calls.length, 1, 'timer must never redeem');
  const final = button(f, 'resetFinal'); click(final); final.props.onClick(); await f.settle();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].endpoint, 'reset-credit/consume');
  assert.equal(f.calls[1].payload.challengeId, 'challenge-A'); assert.equal(f.calls[1].payload.acknowledged, true);
  assert.equal(f.consumed, 1); assert.match(text(f.tree), /resetSuccess/);
  f.dispose();
});

test('cancelled or expired challenge cannot consume, including an old final-click handler', async () => {
  const f = resetFixture(); click(button(f, 'resetUse')); await f.settle(); acknowledge(f); f.advance(5001);
  const stale = button(f, 'resetFinal'); f.advance(60000); stale.props.onClick();
  assert.equal(f.calls.length, 1); assert.equal(button(f, 'resetFinal').props.disabled, true);
  click(button(f, 'cancel')); f.render(); assert.equal(button(f, 'resetFinal'), undefined);
  const g = resetFixture(); click(button(g, 'resetUse')); await g.settle(); acknowledge(g); g.advance(5001);
  const cancelledHandler = button(g, 'resetFinal'); click(button(g, 'cancel')); g.render(); cancelledHandler.props.onClick(); g.advance(10000);
  assert.equal(g.calls.length, 1); assert.equal(button(g, 'resetFinal'), undefined);
});

for (const patch of [{ readyAt: NaN }, { readyAt: 1800000060000 }, { expiresAt: 1 }, { challengeId: '' }]) test(`malformed confirmation stays fail-closed: ${JSON.stringify(patch)}`, async () => {
  const f = resetFixture(patch); click(button(f, 'resetUse')); await f.settle();
  assert.equal(button(f, 'resetFinal'), undefined); assert.match(text(f.tree), /resetExpired/); assert.equal(f.calls.length, 1);
});

for (const unknown of [false, true, 'public-fallback', 'public-paused', 'public-uncertain', 'public-storage']) test(`uncertain consume never reports success or automatically redeems again: ${unknown}`, async () => {
  const messages = {
    'public-fallback': 'Could not use the quota reset',
    'public-paused': 'This quota reset is paused; check quota and account status before any further action',
    'public-uncertain': 'Quota reset result is uncertain; do not send another redemption request',
    'public-storage': 'Quota reset protection storage is unavailable; no new request was sent',
  };
  const f = resetFixture({ consume: async () => { if (unknown === true) return { code: 'unrecognized' }; throw new Error(messages[unknown] ?? 'Quota reset result is uncertain; retry this confirmation to check the same request'); } });
  click(button(f, 'resetUse')); await f.settle(); acknowledge(f); f.advance(5001);
  const stale = button(f, 'resetFinal'); click(stale); await f.settle();
  assert.equal(f.calls.length, 2); assert.equal(f.consumed, 0);
  assert.match(text(f.tree), /resetPaused/);
  if (unknown === 'public-uncertain') assert.match(text(f.tree), /resetUncertain/);
  if (unknown === 'public-storage') assert.match(text(f.tree), /resetStorage/); assert.doesNotMatch(text(f.tree), /resetAlready|resetSuccess/);
  f.advance(1000); await f.settle(); assert.equal(f.calls.length, 2);
  assert.equal(button(f, 'resetFinal').props.disabled, true);
  button(f, 'resetFinal').props.onClick(); stale.props.onClick(); await f.settle();
  assert.equal(f.calls.length, 2, 'even retained handlers cannot retry a consumed/unknown attempt');
  click(button(f, 'cancel')); f.render();
  assert.equal(button(f, 'resetUse').props.disabled, true); assert.match(text(f.tree), /resetPaused/);
  button(f, 'resetUse').props.onClick(); await f.settle(); assert.equal(f.calls.length, 2);
});

test('upstream usage parser exposes the real Credits and reset summary contract using synthetic raw payloads', async () => {
  const backend = await fs.readFile(new URL('./vendor/codex-subscription/lib/index.js', import.meta.url), 'utf8');
  const expiry = backend.split('//#region src/credit-expiry.js')[1]?.split('//#endregion')[0];
  const parser = backend.split('//#region src/usage.js')[1]?.split('const requestSignal$1')[0];
  assert.ok(expiry && parser);
  const parse = vm.runInNewContext(`${expiry}\n${parser}\n;parseCodexUsage`, { Date, Error });
  const unknown = parse({});
  assert.equal(unknown.credits, undefined); assert.equal(unknown.resetCredits, undefined);
  const value = parse({
    plan_type: 'plus',
    credits: { has_credits: true, unlimited: false, balance: '0', expires_at: '2030-01-01T00:00:00Z', approx_local_messages: [0, 10], approx_cloud_messages: [0, 2] },
    rate_limit_reset_credits: { available_count: 1, credits: [{ id: 'private-card-id', title: 'Full reset', status: 'available', expires_at: 1900000000 }, { id: 'spent', status: 'used' }] },
  });
  assert.equal(String(value.credits.balance), '0'); assert.equal(value.credits.unlimited, false);
  assert.equal(value.credits.expirySource, 'api');
  assert.equal(value.resetCredits.availableCount, 1); assert.equal(value.resetCredits.credits[0].name, 'Full reset');
  assert.equal(value.resetCredits.credits[0].expiresAt, 1900000000000);
  assert.ok(!JSON.stringify(value).includes('private-card-id'), 'usage summaries contain display metadata, not usable redemption refs');
  assert.equal(value.resetCredits.credits[0].ref, undefined);
  const empty = parse({ credits: { has_credits: false, unlimited: false }, rate_limit_reset_credits: { available_count: 0 } });
  assert.equal(empty.credits, undefined); assert.equal(empty.resetCredits.availableCount, 0);
});

test('root client loader embeds the complete fork rather than guessing reset/credits RPC names', async () => {
  const build = await fs.readFile(new URL('./build-client.js', import.meta.url), 'utf8');
  assert.match(build, /vendor\/codex-subscription\/lib\/client\.js/);
  assert.match(build, /upstreamFactory\[1\]/);
  assert.match(source, /reset-credit\/inspect/); assert.match(source, /reset-credit\/prepare/); assert.match(source, /reset-credit\/consume/);
  assert.match(source, /creditsBalance/); assert.match(source, /resetInspect/);
  new vm.Script(source); // Full vendor syntax, without evaluating the host plugin.
});
