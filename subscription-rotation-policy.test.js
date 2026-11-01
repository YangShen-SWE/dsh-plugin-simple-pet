import test from 'node:test';
import assert from 'node:assert/strict';
import { ROTATION_STRATEGIES, normalizeRotationConfig, rotationUsageSummary, recommendRotation } from './subscription-rotation-policy.js';

const NOW = 1800000000000;
const RESET = NOW / 1000 + 600;
const key = n => n.toString(16).padStart(16, '0');
const gen = n => n.toString(16).padStart(64, '0');
const config = overrides => ({ enabled: true, strategy: 'balanced', reservePercent: 10, accounts: [{ accountKey: key(1), accountGeneration: gen(1) }], ...overrides });
const window = overrides => ({ remainingPercent: 80, windowSeconds: 18000, resetsAt: RESET, ...overrides });
const report = overrides => ({ planType: 'plus', fetchedAt: NOW, rateLimits: [{ id: 'codex', windows: [window()] }], ...overrides });
const ready = overrides => ({ status: 'ready', remainingPercent: 80, fetchedAt: NOW, resetsAt: RESET, planType: 'plus', ...overrides });
const row = (n, overrides) => ({ accountKey: key(n), accountGeneration: gen(n), budgetSubject: `subject-${n}`, active: false, usage: ready(), ...overrides });
const options = overrides => ({ strategy: 'balanced', reservePercent: 10, ...overrides });
const summary = overrides => rotationUsageSummary(report(overrides), NOW);
const choose = (rows, overrides) => recommendRotation(rows, options(overrides), NOW);
const safeError = error => error.code === 'ROTATION_CONFIG_INVALID' && error.message === 'ROTATION_CONFIG_INVALID';

 test('strategy catalogue exposes exactly the five immutable presets', () => {
  assert.deepEqual(ROTATION_STRATEGIES.map(item => item.id), ['balanced', 'most-remaining', 'low-tier-first', 'high-tier-first', 'reset-soon']);
  assert.ok(Object.isFrozen(ROTATION_STRATEGIES));
  for (const item of ROTATION_STRATEGIES) {
    assert.ok(Object.isFrozen(item));
    assert.equal(typeof item.label, 'string');
    assert.equal(typeof item.description, 'string');
  }
});

test('undefined alone returns isolated defaults; valid config is copied and hex canonicalized', () => {
  const defaults = normalizeRotationConfig();
  assert.deepEqual(defaults, { enabled: false, strategy: 'balanced', reservePercent: 10, accounts: [] });
  defaults.accounts.push('not shared');
  assert.deepEqual(normalizeRotationConfig().accounts, []);
  const input = config({ accounts: [{ accountKey: 'A'.repeat(16), accountGeneration: 'B'.repeat(64) }] });
  const output = normalizeRotationConfig(input);
  assert.deepEqual(output.accounts, [{ accountKey: 'a'.repeat(16), accountGeneration: 'b'.repeat(64) }]);
  assert.notEqual(output, input);
  assert.notEqual(output.accounts[0], input.accounts[0]);
  for (const strategy of ROTATION_STRATEGIES) assert.equal(normalizeRotationConfig(config({ strategy: strategy.id })).strategy, strategy.id);
  assert.equal(normalizeRotationConfig(config({ reservePercent: 0 })).reservePercent, 0);
  assert.equal(normalizeRotationConfig(config({ reservePercent: 90 })).reservePercent, 90);
});

test('strict configuration rejects missing, extra, coerced and malicious fields with a safe code', () => {
  const accessor = config();
  Object.defineProperty(accessor, 'enabled', { get() { throw new Error('SECRET'); } });
  const bad = [null, false, 0, '', {}, [], accessor,
    config({ enabled: 1 }), config({ strategy: '__proto__' }), config({ strategy: {} }),
    config({ reservePercent: '10' }), config({ reservePercent: NaN }), config({ reservePercent: Infinity }),
    config({ reservePercent: 1.1 }), config({ reservePercent: -1 }), config({ reservePercent: 91 }),
    config({ secret: 'never echoed' }), config({ accounts: null }), config({ accounts: new Array(1) }),
    config({ accounts: [{ accountKey: key(1), accountGeneration: gen(1), secret: 'never echoed' }] }),
    config({ accounts: [{ accountKey: '../secret', accountGeneration: gen(1) }] }),
    config({ accounts: [{ accountKey: key(1), accountGeneration: 'a'.repeat(63) }] }),
    config({ accounts: [null] }), config({ accounts: Array.from({ length: 33 }, (_, n) => ({ accountKey: key(n), accountGeneration: gen(n) })) }),
    Object.assign(Object.create({ inherited: true }), config()),
  ];
  const missing = config(); delete missing.enabled; bad.push(missing);
  const symbol = config(); symbol[Symbol('hidden')] = true; bad.push(symbol);
  for (const value of bad) assert.throws(() => normalizeRotationConfig(value), safeError);
  assert.equal(normalizeRotationConfig(config({ accounts: Array.from({ length: 32 }, (_, n) => ({ accountKey: key(n), accountGeneration: gen(n) })) })).accounts.length, 32);
});

test('duplicate public keys are rejected regardless of generation or hex case', () => {
  for (const second of [{ accountKey: key(1), accountGeneration: gen(2) }, { accountKey: 'A'.repeat(16), accountGeneration: gen(2) }]) {
    const first = { accountKey: second.accountKey.toLowerCase(), accountGeneration: gen(1) };
    assert.throws(() => normalizeRotationConfig(config({ accounts: [first, second] })), safeError);
  }
});

test('summary uses minimum across all codex windows and individual limit, not credits or other limits', () => {
  const result = summary({
    rateLimits: [{ id: 'codex', windows: [window(), window({ remainingPercent: 50, resetsAt: RESET + 200 })] }, { id: 'code_review', windows: [window({ remainingPercent: 0 })] }],
    individualLimit: { remainingPercent: 25, limit: '100.0', used: '75', resetsAt: RESET - 10 },
    credits: { unlimited: true, balance: '999999999' },
  });
  assert.deepEqual(result, { status: 'ready', planType: 'plus', fetchedAt: NOW, remainingPercent: 25, resetsAt: RESET - 10 });
});

test('freshness includes exactly 120 seconds, rejects stale, future, missing and invalid timestamps', () => {
  assert.equal(summary({ fetchedAt: NOW - 120000 }).status, 'ready');
  for (const fetchedAt of [NOW - 120001, NOW + 1, undefined, null, NaN, Infinity, '1800000000000', -1, NOW + 0.1]) {
    assert.equal(summary({ fetchedAt }).status, 'unknown');
  }
  assert.equal(rotationUsageSummary(report(), NaN).status, 'unknown');
});

test('all codex windows must be nonempty, numeric and unexpired', () => {
  const invalidWindows = [[], [null], [window({ remainingPercent: 101 })], [window({ remainingPercent: '80' })],
    [window({ remainingPercent: NaN })], [window({ remainingPercent: Infinity })],
    [window({ windowSeconds: 0 })], [window({ windowSeconds: -1 })], [window({ windowSeconds: '18000' })],
    [window({ windowSeconds: 0.5 })], [window({ resetsAt: NOW / 1000 })], [window({ resetsAt: RESET - 10000 })],
    [window({ resetsAt: '1800000600' })], [window({ resetsAt: NaN })], [window({ resetsAt: null })],
    [window(), window({ remainingPercent: 200 })], [window(), window({ resetsAt: 1 })],
  ];
  for (const windows of invalidWindows) assert.equal(summary({ rateLimits: [{ id: 'codex', windows }] }).status, 'unknown');
  for (const rateLimits of [undefined, null, [], [{ id: 'other', windows: [window()] }], [{ id: 'codex', windows: null }], [{ id: 'codex', windows: [window()] }, { id: 'codex', windows: [window()] }]]) {
    assert.equal(summary({ rateLimits }).status, 'unknown');
  }
});

test('missing reset stays usable but does not invent reset-soon ordering', () => {
  const result = summary({ rateLimits: [{ id: 'codex', windows: [window({ resetsAt: undefined }), window()] }] });
  assert.equal(result.status, 'ready');
  assert.equal(result.resetsAt, undefined);
  assert.equal(choose([row(1, { usage: result })], { strategy: 'reset-soon' }), null);
});

test('known restrictions dominate missing, malformed or stale quota and credits', () => {
  for (const overrides of [
    { spendControlReached: true, rateLimits: [] },
    { rateLimitReachedType: 'workspace_usage_limit_reached', rateLimits: null },
    { individualLimit: { remainingPercent: 0 } },
    { rateLimits: [{ id: 'codex', windows: [window({ remainingPercent: 0 })] }] },
    { rateLimits: [{ id: 'codex', windows: [window({ remainingPercent: -1 })] }] },
  ]) assert.equal(summary({ ...overrides, fetchedAt: NOW - 999999, credits: { unlimited: true } }).status, 'restricted');
});

test('individual limits require official decimal strings and legal optional resets', () => {
  const valid = { remainingPercent: 50, limit: '100', used: '50' };
  for (const individualLimit of [null, {}, { ...valid, remainingPercent: '50' }, { ...valid, remainingPercent: 101 },
    { ...valid, limit: 100 }, { ...valid, limit: '-1' }, { ...valid, limit: '0' },
    { ...valid, used: '-1' }, { ...valid, used: '101' }, { ...valid, used: 'Infinity' }, { ...valid, resetsAt: NOW / 1000 }]) {
    assert.equal(summary({ individualLimit }).status, 'unknown');
  }
  const result = summary({ individualLimit: valid });
  assert.equal(result.status, 'ready');
  assert.equal(result.remainingPercent, 50);
  assert.equal(result.resetsAt, undefined);
  assert.equal(summary({ spendControlReached: 'false' }).status, 'unknown');
  assert.equal(summary({ rateLimitReachedType: {} }).status, 'unknown');
});

test('official plan strings are preserved without inferring a tier', () => {
  for (const planType of ['free', 'go', 'plus', 'pro', 'team', 'business', 'enterprise', 'edu', 'future_plan']) {
    const usage = summary({ planType });
    assert.equal(usage.planType, planType);
    assert.equal(usage.status, 'ready');
    const account = row(1, { usage });
    assert.equal(choose([account]), account);
    assert.equal(choose([account], { strategy: 'most-remaining' }), account);
    assert.equal(choose([account], { strategy: 'reset-soon' }), account);
    const known = ['free', 'go', 'plus', 'pro'].includes(planType);
    for (const strategy of ['low-tier-first', 'high-tier-first']) assert.equal(choose([account], { strategy }), known ? account : null);
  }
  assert.equal(summary({ planType: undefined }).planType, undefined);
  assert.equal(summary({ planType: '<script>' }).planType, undefined);
});

test('recommend excludes active subscriptions including aliases, explicit subjects and missing identities', () => {
  const active = row(1, { active: true });
  const alias = row(2, { budgetSubject: active.budgetSubject });
  const excluded = row(3);
  const missing = row(4, { budgetSubject: undefined });
  const good = row(5);
  assert.equal(choose([active, alias, excluded, missing, good], { excludeSubjects: [excluded.budgetSubject] }), good);
  assert.equal(choose([alias], { excludeSubjects: [active.budgetSubject] }), null);
  assert.equal(choose([row(6, { active: undefined }), row(7, { accountGeneration: undefined })]), null);
  assert.equal(choose([row(1), row(1, { accountGeneration: gen(2) })]), null);
});

test('recommend never selects unknown, restricted, stale, future, expired, malformed or reserve-boundary usage', () => {
  for (const usage of [undefined, ready({ status: 'unknown' }), ready({ status: 'restricted' }),
    ready({ remainingPercent: 10 }), ready({ remainingPercent: 0 }), ready({ remainingPercent: 101 }),
    ready({ remainingPercent: '80' }), ready({ remainingPercent: NaN }), ready({ fetchedAt: undefined }),
    ready({ fetchedAt: NOW - 120001 }), ready({ fetchedAt: NOW + 1 }), ready({ resetsAt: NOW / 1000 }), ready({ resetsAt: null })]) {
    assert.equal(choose([row(1, { usage })]), null);
  }
  assert.notEqual(choose([row(1, { usage: ready({ fetchedAt: NOW - 120000, remainingPercent: 10.1 }) })]), null);
});

test('balanced prioritizes never-used subjects then oldest use with stable public-key ties', () => {
  const a = row(1), b = row(2), c = row(3, { usage: ready({ remainingPercent: 99 }) });
  assert.equal(choose([c, b, a]), a);
  assert.equal(choose([a, b, c], { lastUsed: { [a.budgetSubject]: NOW - 10000, [b.budgetSubject]: NOW - 20000 } }), c);
  assert.equal(choose([a, b], { lastUsed: { [a.budgetSubject]: NOW - 10000, [b.budgetSubject]: NOW - 20000 } }), b);
  assert.equal(choose([a, b], { lastUsed: { [a.budgetSubject]: NOW + 1, [b.budgetSubject]: NOW - 10000 } }), a);
});

test('most-remaining and tier policies order minimum percentage then stable key', () => {
  const free = row(1, { usage: ready({ planType: 'free', remainingPercent: 20 }) });
  const go = row(2, { usage: ready({ planType: 'go', remainingPercent: 99 }) });
  const plus = row(3, { usage: ready({ planType: 'plus', remainingPercent: 60 }) });
  const pro = row(4, { usage: ready({ planType: 'pro', remainingPercent: 15 }) });
  const rows = [pro, plus, go, free];
  assert.equal(choose(rows, { strategy: 'most-remaining' }), go);
  assert.equal(choose(rows, { strategy: 'low-tier-first' }), free);
  assert.equal(choose(rows, { strategy: 'high-tier-first' }), pro);
  const more = row(5, { usage: ready({ planType: 'pro', remainingPercent: 50 }) });
  assert.equal(choose([...rows, more], { strategy: 'high-tier-first' }), more);
  const same = row(6, { usage: { ...more.usage } });
  assert.equal(choose([same, more], { strategy: 'most-remaining' }), more);
});

test('reset-soon requires future known reset; equal reset prefers more remaining then stable key', () => {
  const later = row(1, { usage: ready({ resetsAt: RESET + 100 }) });
  const soon = row(2, { usage: ready({ resetsAt: RESET, remainingPercent: 20 }) });
  const more = row(3, { usage: ready({ resetsAt: RESET, remainingPercent: 50 }) });
  const unknown = row(4, { usage: ready({ resetsAt: undefined }) });
  assert.equal(choose([later, soon, more, unknown], { strategy: 'reset-soon' }), more);
});

test('duplicate subjects share usage history and exclusions; input rows remain unchanged and returned by identity', () => {
  const a = row(1), alias = row(2, { budgetSubject: a.budgetSubject }), b = row(3);
  const rows = [alias, b, a];
  const before = structuredClone(rows);
  rows.forEach(item => { Object.freeze(item.usage); Object.freeze(item); }); Object.freeze(rows);
  assert.equal(choose(rows, { lastUsed: { [a.budgetSubject]: NOW } }), b);
  assert.equal(choose(rows, { excludeSubjects: [a.budgetSubject] }), b);
  assert.deepEqual(rows, before);
});

test('malicious or invalid input fails closed without invoking getters or echoing secrets', () => {
  let invoked = false;
  const evil = {};
  Object.defineProperty(evil, 'fetchedAt', { get() { invoked = true; throw new Error('SECRET'); } });
  assert.deepEqual(rotationUsageSummary(evil, NOW), { status: 'unknown' });
  assert.equal(choose([evil]), null);
  assert.equal(invoked, false);
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.deepEqual(rotationUsageSummary(revoked.proxy, NOW), { status: 'unknown' });
  assert.equal(choose([revoked.proxy]), null);
  assert.throws(() => normalizeRotationConfig(revoked.proxy), safeError);
  for (const invalidOptions of [undefined, null, {}, options({ strategy: 'arbitrary' }), options({ reservePercent: '10' }), options({ excludeSubjects: [null] }), options({ lastUsed: null })]) {
    assert.equal(recommendRotation([row(1)], invalidOptions, NOW), null);
  }
  assert.equal(choose(null), null);
  assert.equal(recommendRotation([row(1)], options(), NaN), null);
  assert.equal(choose([row(1, { budgetSubject: 'bad\nsubject' })]), null);
});
