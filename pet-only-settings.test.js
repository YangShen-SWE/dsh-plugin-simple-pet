import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { createSimplePetClient } from './client-source.js';
import { DEFAULT_PREFERENCES, preferenceValues } from './preferences.js';

const ACCOUNT_KEY = 'a1b2c3d4a1b2c3d4';
const EXPLICIT_KEYS = ['codexUnifiedControls', 'codexUnifiedWarmup', 'codexWarmupDaily', 'codexWarmupTime', 'codexWarmupReset', 'codexWarmupStartup'];
const initialReads = ['account', 'application', 'preferences', 'state'];
const identity = { status: 'ready', provider: 'openai-codex', selection: 'active', accountKey: ACCOUNT_KEY, maskedEmail: 't***@e***.com', validForMs: 120000 };
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture({ legacy = true, saveGate = null, preferences = {}, readAccount = () => identity } = {}) {
  const cells = [], cleanups = [], calls = [];
  let cursor = 0, tree, revision = 'a'.repeat(64), writes = 0, accountReads = 0, disposed = false;
  let values = { ...DEFAULT_PREFERENCES, codexAccountBackend: 'official', multiAccountManagement: legacy, codexWarmupDaily: legacy, codexWarmupReset: legacy, codexWarmupStartup: legacy, ...preferences };
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(x => x !== false && x != null) }),
    useState(value) { const i = cursor++; if (!(i in cells)) cells[i] = value; return [cells[i], v => { cells[i] = typeof v === 'function' ? v(cells[i]) : v; }]; },
    useRef(value) { const i = cursor++; return cells[i] ??= { current: value }; },
    useEffect(fn) { const i = cursor++; if (!(i in cells)) { cells[i] = true; cleanups.push(fn()); } },
  };
  const send = async (url, options = {}) => {
    calls.push({ url, ...options });
    assert.match(url, /^api\/dsh-plugin-simple-pet\/(preferences|state|application|account)$/);
    assert.equal(options.credentials, 'same-origin');
    const path = url.split('/').at(-1), method = options.method ?? 'GET';
    assert.ok(method === 'GET' || path === 'preferences' && method === 'PUT');
    if (path !== 'preferences') assert.equal(options.body, undefined);
    if (path === 'state') return Response.json({ stats: { days: {} }, codexStats: { days: {} }, codex: { status: 'ready', provider: 'openai-codex', selection: 'active', accountKey: ACCOUNT_KEY, observedAt: Date.now(), fiveHour: { remainingPercent: 84 }, weekly: { remainingPercent: 34 } } });
    if (path === 'application') return Response.json({});
    if (path === 'account') return Response.json(await readAccount(++accountReads));
    if (method === 'PUT') {
      await saveGate;
      const data = JSON.parse(options.body);
      assert.equal(data.revision, revision);
      values = { ...values, ...data.patch };
      revision = (++writes).toString(16).padStart(64, '0');
    }
    return Response.json({ values, revision, timeZone: 'Europe/Copenhagen' });
  };
  const client = createSimplePetClient(React, send), render = () => { cursor = 0; tree = client.SimplePetSettings(); return tree; };
  const nodes = (node = tree) => node && typeof node === 'object' ? [node, ...node.children.flatMap(x => nodes(x))] : [];
  const text = (node = tree) => node && typeof node === 'object' ? node.children.map(text).join('') : String(node ?? '');
  render();
  return {
    client, calls, render, nodes, text, values: () => values, revision: () => revision,
    find: predicate => { const node = nodes().find(predicate); assert.ok(node, 'expected control exists'); return node; },
    dispose() { if (!disposed) { disposed = true; cleanups.forEach(fn => fn?.()); } },
  };
}

function assertReadOnly(calls) {
  for (const call of calls) {
    assert.match(call.url, /^api\/dsh-plugin-simple-pet\/(preferences|state|application|account)$/);
    assert.equal(call.method ?? 'GET', 'GET');
    assert.equal(call.body, undefined);
    assert.equal(call.credentials, 'same-origin');
  }
}

function assertNoDuplicateManagement(ui) {
  assert.deepEqual(ui.nodes().filter(node => node.props['data-pet-tab']).map(node => node.props['data-pet-tab']), ['appearance', 'stats']);
  for (const name of ['multiAccountManagement', 'codexAccountBackend']) assert.ok(!ui.nodes().some(node => node.props.name === name));
  assert.ok(!/账号来源|添加账号|删除账号|新增账号|模型设置|模型管理|多账号管理|重置卡|兑换|授权.*来源/.test(ui.text()));
  assert.ok(!ui.nodes().some(node => ['button', 'a'].includes(node.type) && /OAuth|登录|添加账号|删除账号|模型管理/.test(ui.text(node))));
}

test('pet settings retain two tabs and appearance choices, with only the unified owner read-only identity endpoint', async () => {
  const ui = fixture();
  try {
    await settle(); ui.render();
    assert.deepEqual(ui.calls.map(call => call.url.split('/').at(-1)).sort(), initialReads);
    assertReadOnly(ui.calls); assertNoDuplicateManagement(ui);
    assert.ok(!ui.nodes().some(node => node.props['data-account-identity'] || node.props['data-warmup-settings'] || node.props['data-settings-save']));
    for (const name of EXPLICIT_KEYS) assert.ok(!ui.nodes().some(node => node.props.name === name));
    assert.equal(ui.nodes().filter(node => node.props.role === 'radio' && !node.props['data-card-theme-choice']).length, 6);
    assert.equal(ui.nodes().filter(node => node.props['data-card-theme-choice']).length, 5);
  } finally { ui.dispose(); }
});

test('only Codex mode displays unified account identity and explicitly saved warmup grants, without account or model management', async () => {
  const ui = fixture({ preferences: { billingMode: 'codex' } });
  try {
    await settle(); ui.render(); assertNoDuplicateManagement(ui); assertReadOnly(ui.calls);
    assert.match(ui.text(ui.find(node => node.props['data-account-identity'])), /当前账号（统一订阅）.*t\*\*\*@e\*\*\*\.com/);
    for (const name of EXPLICIT_KEYS) assert.equal(ui.nodes().filter(node => node.props.name === name).length, 1);
    assert.equal(ui.find(node => node.props.name === 'codexUnifiedControls').props.checked, false);
    assert.equal(ui.find(node => node.props.name === 'codexUnifiedWarmup').props.checked, false);
    assert.equal(ui.find(node => node.props['data-settings-save']).props.disabled, true);
    assert.match(ui.text(), /真实消耗.*订阅额度/);
    assert.match(ui.text(), /旧版授权不会自动沿用/);
    ui.find(node => node.props.name === 'billingMode').props.onChange({ target: { value: 'deepseek' } }); ui.render();
    assert.ok(!ui.nodes().some(node => node.props['data-account-identity'] || node.props['data-warmup-settings'] || node.props['data-settings-save']));
    for (const name of EXPLICIT_KEYS) assert.ok(!ui.nodes().some(node => node.props.name === name));
  } finally { ui.dispose(); }
});

test('visual preferences still autosave with CAS without piggybacking old account grants', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const ui = fixture();
  try {
    await settle(); ui.render(); ui.find(node => node.props.name === 'size').props.onChange({ target: { value: 'tiny' } }); ui.render();
    t.mock.timers.tick(450); await settle(); ui.render();
    const writes = ui.calls.filter(call => call.method === 'PUT'); assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(writes[0].body), { patch: { size: 'tiny' }, revision: 'a'.repeat(64) });
    assert.equal(ui.values().codexWarmupDaily, true); assert.equal(ui.values().multiAccountManagement, true);
    assert.equal(ui.values().codexUnifiedControls, false); assert.equal(ui.values().codexUnifiedWarmup, false);
    assert.ok(!ui.nodes().some(node => node.props['data-settings-save']));
  } finally { ui.dispose(); }
});

test('pending unified grants and every warmup setting survive appearance autosave and submit only on explicit confirmation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ui = fixture({ legacy: false, preferences: { billingMode: 'codex' } });
  const explicit = { codexUnifiedControls: true, codexUnifiedWarmup: true, codexWarmupDaily: true, codexWarmupTime: '10:15', codexWarmupReset: true, codexWarmupStartup: true };
  try {
    await settle(); ui.render();
    for (const [name, value] of Object.entries(explicit)) ui.find(node => node.props.name === name).props.onChange({ target: typeof value === 'boolean' ? { checked: value } : { value } });
    ui.render(); t.mock.timers.tick(1000); await settle(); ui.render();
    assert.equal(ui.calls.filter(call => call.method === 'PUT').length, 0);
    assert.match(ui.text(), /外观自动保存不会顺带提交这些更改/);
    ui.find(node => node.props.name === 'size').props.onChange({ target: { value: 'tiny' } }); ui.render();
    t.mock.timers.tick(450); await settle(); ui.render();
    let writes = ui.calls.filter(call => call.method === 'PUT'); assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(writes[0].body), { patch: { size: 'tiny' }, revision: 'a'.repeat(64) });
    for (const [name, value] of Object.entries(explicit)) {
      assert.equal(ui.values()[name], DEFAULT_PREFERENCES[name]);
      assert.equal(ui.find(node => node.props.name === name).props[typeof value === 'boolean' ? 'checked' : 'value'], value);
    }
    const revision = ui.revision();
    assert.equal(ui.find(node => node.props['data-settings-save']).props.disabled, false);
    ui.find(node => node.props['data-settings-save']).props.onClick(); await settle(); ui.render();
    writes = ui.calls.filter(call => call.method === 'PUT'); assert.equal(writes.length, 2);
    assert.deepEqual(JSON.parse(writes[1].body), { patch: explicit, revision });
    for (const [name, value] of Object.entries(explicit)) assert.equal(ui.values()[name], value);
    assert.equal(ui.find(node => node.props['data-settings-save']).props.disabled, true);
    assertReadOnly(ui.calls.filter(call => call.method !== 'PUT'));
    assert.ok(writes.every(call => call.url === 'api/dsh-plugin-simple-pet/preferences' && call.credentials === 'same-origin'));
    assertNoDuplicateManagement(ui);
  } finally { ui.dispose(); }
});

test('read-only account polling refreshes matching unified identity and clears it on failure or owner mismatch', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const ui = fixture({ preferences: { billingMode: 'codex' }, readAccount: read => {
    if (read === 2) throw new Error('synthetic identity unavailable');
    return { ...identity, ...(read === 3 ? { provider: 'codex-accounts' } : read >= 4 ? { maskedEmail: 'n***@e***.com' } : {}) };
  } });
  const identityText = () => ui.text(ui.find(node => node.props['data-account-identity']));
  try {
    await settle(); ui.render(); assert.match(identityText(), /t\*\*\*@e\*\*\*\.com/);
    for (let refresh = 1; refresh <= 3; refresh++) {
      const before = ui.calls.length;
      t.mock.timers.tick(5000); await settle(); ui.render();
      assert.deepEqual(ui.calls.slice(before).map(call => call.url.split('/').at(-1)).sort(), ['account', 'application', 'state']);
      if (refresh < 3) { assert.match(identityText(), /账号身份待确认/); assert.doesNotMatch(identityText(), /t\*\*\*@e\*\*\*\.com/); }
      else assert.match(identityText(), /n\*\*\*@e\*\*\*\.com/);
    }
    assertReadOnly(ui.calls);
    ui.dispose(); const count = ui.calls.length;
    t.mock.timers.tick(10000); await settle(); assert.equal(ui.calls.length, count);
    assert.ok(ui.calls.every(call => call.signal.aborted));
  } finally { ui.dispose(); }
});

test('statistics remain local and Codex quota values and chart modes need no connection actions', async () => {
  const ui = fixture({ preferences: { billingMode: 'codex' } });
  try {
    await settle(); ui.render(); ui.find(node => node.props['data-pet-tab'] === 'stats').props.onClick(); ui.render();
    assert.ok(ui.nodes().some(node => node.props['data-statistics-page'])); assert.match(ui.text(), /84%.*34%/s);
    for (const value of ['month', 'year', 'week']) {
      ui.find(node => node.props['data-stat-range']).props.onChange({ target: { value } }); ui.render();
      assert.equal(ui.find(node => node.props['data-stat-range']).props.value, value);
    }
    assert.deepEqual(ui.calls.map(call => call.url.split('/').at(-1)).sort(), initialReads); assertReadOnly(ui.calls);
  } finally { ui.dispose(); }
});

test('two-page keyboard navigation keeps roving focus without extra account reads or mutations', async () => {
  const ui = fixture();
  try {
    await settle(); ui.render(); let focused = 0, prevented = 0;
    const controls = [{ focus() { focused = 1; } }, { focus() { focused = 2; } }];
    ui.find(node => node.props['data-pet-tab'] === 'appearance').props.onKeyDown({ key: 'End', preventDefault() { prevented++; }, currentTarget: { parentElement: { querySelectorAll: () => controls } } });
    ui.render(); assert.equal(focused, 2); assert.equal(prevented, 1);
    assert.equal(ui.find(node => node.props['data-pet-tab'] === 'stats').props.tabIndex, 0);
    assert.deepEqual(ui.calls.map(call => call.url.split('/').at(-1)).sort(), initialReads); assertReadOnly(ui.calls);
  } finally { ui.dispose(); }
});

test('unmount cancels delayed autosave, aborts reads and clears account polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); const ui = fixture();
  try {
    await settle(); ui.render(); ui.find(node => node.props.name === 'quietMode').props.onChange({ target: { checked: true } });
    ui.dispose(); const count = ui.calls.length; t.mock.timers.tick(10000); await settle();
    assert.equal(ui.calls.filter(call => call.method === 'PUT').length, 0); assert.equal(ui.calls.length, count);
    assert.ok(ui.calls.every(call => call.signal.aborted));
  } finally { ui.dispose(); }
});

// Evaluate only the named closures against in-memory services. Never call apply(),
// which would read real preferences/journals or start the pet and its subscriptions.
const rootSource = readFileSync(new URL('./index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function rootFunction(name) {
  const source = rootSource.match(new RegExp(`^  (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}`, 'm'))?.[0];
  assert.ok(source, `root closure ${name} exists`); return source;
}
function rootHarness(preferences = {}) {
  const calls = { aborts: 0, ticks: [], updates: [], journalReads: 0, schedules: 0 };
  const env = {
    live: true, profile: 'desktop', subscriptionOwner: 'embedded', subscriptionAdapter: {}, instance: 'synthetic-run', bridgeRevision: 1,
    preferences: { ...DEFAULT_PREFERENCES, billingMode: 'codex', ...preferences }, prefsFile: 'memory-only-preferences',
    prefsReading: false, warmupRefreshPending: false, warmupTimer: null, codexBridge: {}, accountChanging: false,
    warmupSwitchUncertain: false, warmupModeUncertain: false, legacyDayBlocked: false, warmupJournalReadable: true, multiReadable: true,
    createHash, clearTimeout() {}, queueMicrotask, warmupClock: () => 1000,
    unifiedPermissions: () => preferenceValues(env.preferences),
    async readFile(file, encoding) { assert.equal(file, 'memory-only-preferences'); assert.equal(encoding, 'utf8'); if (env.readError) throw env.readError; return JSON.stringify(env.preferences); },
    configureQuotaPolling() {},
    multiStore: { async read() { calls.journalReads++; if (env.journalError) throw env.journalError; return { data: {} }; } },
    multiBlocksLegacy: () => env.blockedToday === true,
    warmup: {
      active: { abort() { calls.aborts++; } },
      update(status, detail) { calls.updates.push({ status, detail }); },
      async tick(raw, now) { calls.ticks.push({ raw: JSON.parse(JSON.stringify(raw)), now }); },
    },
    scheduleWarmup() { calls.schedules++; },
  };
  const functions = vm.runInNewContext(`${rootFunction('panelGrant')}\n${rootFunction('warmupAuthorized')}\n${rootFunction('pollWarmup')}\n({panelGrant,warmupAuthorized,pollWarmup})`, env);
  return { env, calls, ...functions };
}

test('root keeps the subscription as sole owner and legacy route uses its exact complete adapter', () => {
  const vendor = readFileSync(new URL('./vendor/codex-subscription/lib/index.js', import.meta.url), 'utf8');
  assert.ok(!/ctx\.plugin\(embeddedAccountsPlugin\)/.test(rootSource));
  assert.ok(/const accountBackend = 'legacy';/.test(rootSource));
  assert.ok(/function refreshAccountBackend\(\) \{ return accountBackend; \}/.test(rootSource));
  assert.ok(/registerAdapter\(\[PROVIDER\], completeAdapter\)/.test(vendor));
  assert.ok(/registerAdapter\(\['codex-accounts'\], createSubscriptionLegacyAdapter\(completeAdapter\)\)/.test(vendor));
});

test('retired account grants never authorize unified controls or warmup, and the two new grants remain independent', () => {
  for (const backend of ['legacy', 'official']) {
    const host = rootHarness({ codexAccountBackend: backend, multiAccountManagement: true, codexWarmupDaily: true, codexWarmupReset: true, codexWarmupStartup: true });
    assert.equal(host.panelGrant(), null); assert.equal(host.warmupAuthorized(), false);
    host.env.preferences.codexUnifiedControls = true;
    const grant = host.panelGrant(); assert.match(grant, /^[a-f0-9]{64}$/); assert.equal(host.panelGrant(), grant);
    assert.equal(host.warmupAuthorized(), false);
    host.env.bridgeRevision++; assert.notEqual(host.panelGrant(), grant);
    host.env.preferences.codexUnifiedControls = false; host.env.preferences.codexUnifiedWarmup = true;
    assert.equal(host.panelGrant(), null); assert.equal(host.warmupAuthorized(), true);
  }
});

test('unified grants fail closed for a different or unavailable owner, revoked controls, wrong display mode, or missing warmup adapter', () => {
  const host = rootHarness({ codexUnifiedControls: true, codexUnifiedWarmup: true });
  assert.ok(host.panelGrant()); assert.equal(host.warmupAuthorized(), true);
  for (const owner of ['external', 'loading', 'conflict', 'closed']) {
    host.env.subscriptionOwner = owner; assert.equal(host.panelGrant(), null); assert.equal(host.warmupAuthorized(), false);
  }
  host.env.subscriptionOwner = 'embedded'; host.env.preferences.billingMode = 'deepseek'; assert.equal(host.panelGrant(), null);
  host.env.preferences.billingMode = 'codex'; host.env.preferences.codexUnifiedControls = false; assert.equal(host.panelGrant(), null);
  host.env.subscriptionAdapter = null; assert.equal(host.warmupAuthorized(), false);
  host.env.subscriptionAdapter = {}; host.env.profile = 'server'; assert.equal(host.warmupAuthorized(), false);
  host.env.profile = 'desktop'; host.env.live = false; assert.equal(host.panelGrant(), null); assert.equal(host.warmupAuthorized(), false);
});

test('warmup polling ticks only after the same owner receives explicit warmup authorization and a readable unblocked journal', async () => {
  const legacy = rootHarness({ multiAccountManagement: true, codexAccountBackend: 'official', codexWarmupDaily: true });
  await legacy.pollWarmup(); assert.equal(legacy.calls.ticks.length, 0); assert.equal(legacy.calls.journalReads, 0);
  assert.equal(legacy.calls.aborts, 1); assert.match(legacy.calls.updates.at(-1).detail, /未授权/);
  const granted = rootHarness({ codexUnifiedWarmup: true, codexWarmupDaily: true });
  await granted.pollWarmup(); assert.equal(granted.calls.journalReads, 1);
  assert.deepEqual(granted.calls.ticks, [{ raw: granted.env.preferences, now: 1000 }]); assert.equal(granted.calls.aborts, 0);
  const otherOwner = rootHarness({ codexUnifiedWarmup: true }); otherOwner.env.subscriptionOwner = 'external';
  await otherOwner.pollWarmup(); assert.equal(otherOwner.calls.ticks.length, 0); assert.equal(otherOwner.calls.aborts, 1);
  for (const [key, value] of [['codexBridge', null], ['accountChanging', true], ['warmupSwitchUncertain', true], ['warmupModeUncertain', true], ['blockedToday', true], ['warmupJournalReadable', false], ['readError', new Error('synthetic read failure')], ['journalError', new Error('synthetic journal failure')]]) {
    const blocked = rootHarness({ codexUnifiedWarmup: true }); blocked.env[key] = value;
    await blocked.pollWarmup(); assert.equal(blocked.calls.ticks.length, 0, key); assert.equal(blocked.calls.aborts, 1, key);
  }
  const busy = rootHarness({ codexUnifiedWarmup: true }); busy.env.prefsReading = true;
  await busy.pollWarmup({ preferencesChanged: true }); assert.equal(busy.calls.aborts, 1); assert.equal(busy.calls.ticks.length, 0);
  assert.equal(busy.env.warmupRefreshPending, true);
});
