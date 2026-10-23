import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { statBuckets, calendarDate, quotaStatus, quotaReset, accountSummary, createSimplePetClient, createPreferenceAutosave, AUTOSAVE_PREFERENCE_KEYS, resetCreditExpiry, accountCredentialSummary } from './client-source.js';
import { DEFAULT_PREFERENCES } from './preferences.js';

function settingsRegistrationHarness() {
  const entries = new Map(), waiting = [], services = {}, effects = [];
  let unauthorizedReads = 0, requests = 0;
  const remote = Object.defineProperty({}, 'pluginManager', { get() { unauthorizedReads++; throw Error('cannot get property "remote.pluginManager" without inject'); } });
  const plugin = createSimplePetClient({ createElement() {} }, () => { requests++; throw Error('FORBIDDEN_REQUEST'); }, services);
  plugin.apply({ remote, inject(names, callback) {
    assert.deepEqual(names, ['remote.pluginManager']);
    const row = { active: true, callback, cleanup: null }; waiting.push(row);
    const stop = () => { row.active = false; row.cleanup?.(); row.cleanup = null; }; effects.push(stop); return stop;
  }, slots: { inject(name, callback) { assert.equal(name, 'settings.section'); effects.push(callback()); }, register(options, Component) {
    entries.set(options.id, { options, Component }); return () => entries.delete(options.id);
  } } });
  return { entries, services, get unauthorizedReads() { return unauthorizedReads; }, get requests() { return requests; },
    mount(manager) { const row = waiting[0]; if (!row.active) return null; row.cleanup = row.callback({ remote: { pluginManager: manager } }); return row.cleanup; },
    unmount() { const row = waiting[0]; row.cleanup?.(); row.cleanup = null; },
    dispose() { effects.reverse().forEach(fn => fn?.()); } };
}


test('chart buckets use local dates, Monday weeks, leap months and exact yearly sums', () => {
  const days = { '2024-02-29': { tokens: 48056876, cny: 3 }, '2024-03-01': { tokens: 20 }, '2023-12-31': { tokens: 9 }, '2024-01-01': { tokens: 12 } };
  assert.equal(statBuckets(days, 'month', 'tokens', new Date(2024,1,29)).length, 29);
  assert.equal(statBuckets(days, 'month', 'tokens', new Date(2024,1,29))[28].value, 48056876);
  assert.equal(statBuckets(days, 'year', 'tokens', new Date(2024,1,29))[1].value, 48056876);
  const week = statBuckets(days, 'week', 'tokens', new Date(2024,0,1));
  assert.equal(week[0].label, '一'); assert.equal(week[0].value, 12); assert.equal(week[6].value, 0);
  assert.equal(statBuckets(null, 'week', 'tokens').every(b => b.value === 0), true);
  assert.equal(statBuckets({ '2024-02-29': { tokens: -1 } }, 'month', 'tokens', new Date(2024,1,29))[28].value, 0);
});
test('host timezone determines statistics date even when browser is elsewhere', () => {
  const instant = new Date('2024-12-31T16:30:00Z');
  const host = calendarDate('Asia/Shanghai', instant);
  assert.deepEqual([host.getFullYear(),host.getMonth(),host.getDate()],[2025,0,1]);
  const browser = calendarDate('Europe/Copenhagen', instant);
  assert.deepEqual([browser.getFullYear(),browser.getMonth(),browser.getDate()],[2024,11,31]);
  assert.equal(calendarDate('invalid/timezone', instant),instant);
});
test('native Codex status distinguishes stale, cached, missing and fresh quota reports', () => {
  const now = Date.parse('2024-12-31T16:30:00Z');
  const q = { status:'ready', observedAt:now, fiveHour:{resetAt:now+3600000}, weekly:{resetAt:now+86400000} };
  assert.equal(quotaStatus({codex:q},now),'当前账号 · 官方报告');
  for (const observedAt of [undefined, NaN, 0, now-120001, now+5001]) assert.equal(quotaStatus({codex:{...q,observedAt}},now),'上次额度 · 待更新');
  assert.equal(quotaStatus({codex:{...q,fiveHour:{resetAt:now}}},now),'上次额度 · 待更新');
  assert.equal(quotaStatus({codex:{...q,status:'reported',observedAt:undefined}},now),'默认账号 · 可能缓存');
  assert.equal(quotaStatus({codex:{...q,status:'reported',weekly:{resetAt:now-1}}},now),'上次额度 · 待更新');
  assert.equal(quotaStatus(null,now),'等待 DSH 数据');
  assert.equal(quotaStatus({},now),'请重启 DSH 更新桌宠');
  for (const [status,label] of [['signed-out','请在订阅插件登录'],['unsupported','未发现支持的订阅接口'],['switching','账号切换中…'],['stale','上次额度 · 待更新']]) assert.equal(quotaStatus({codex:{status}},now),label);
});
test('quota reset labels use the host timezone and reject invalid timestamps', () => {
  const resetAt = Date.parse('2024-12-31T16:30:00Z');
  assert.match(quotaReset({resetAt},'Asia/Shanghai'),/01.01.*00:30/);
  assert.match(quotaReset({resetAt},'Europe/Copenhagen'),/12.31.*17:30/);
  for (const window of [undefined,{}, {resetAt:NaN},{resetAt:Infinity},{resetAt:0},{resetAt:-1}]) assert.equal(quotaReset(window,'Asia/Shanghai'),'重置时间未知');
  assert.equal(quotaReset({resetAt},'invalid/timezone'),'重置时间未知');
});
test('built bundle follows the real host factory contract and owns native settings registration/CSS lifecycle', () => {
  let factory, added = 0, removed = 0, registration;
  const effects = [], React = { createElement() {}, useState() {}, useEffect() {}, useRef() {} };
  const document = { createElement() { return { dataset:{}, remove() { removed++; } }; }, head: { appendChild() { added++; } } };
  const sandbox = { window: { __ModuleLoader__: { load(row) { assert.equal(row.id,'dsh-plugin-simple-pet'); factory = row.factory; } } }, document };
  vm.runInNewContext(readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8'), sandbox);
  const plugin = factory(id => { assert.equal(id, 'react'); return React; });
  assert.deepEqual([...plugin.inject], ['slots', 'remote']);
  plugin.apply({ effect(fn) { effects.push(fn()); }, inject(names) { assert.deepEqual([...names], ['remote.pluginManager']); return () => {}; }, slots: { inject(name, fn) { assert.equal(name, 'settings.section'); effects.push(fn()); }, register(options, Component) { registration = { options, Component }; return () => {}; } } });
  assert.equal(registration.options.id, 'simple-desktop-pet'); assert.equal(registration.options.label(), '桌宠');
  assert.equal(typeof registration.Component, 'function'); assert.equal(added,1);
  effects.reverse().forEach(fn => fn?.()); assert.equal(removed,1);
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.exports['./client'],'./lib/client.js'); assert.equal(pkg.dsh.client.platform,'web');
  assert(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings-general'));
  const css = readFileSync(new URL('./client.css', import.meta.url),'utf8');
  assert.match(css, /repeat\(auto-fit,minmax\(min\(100%,130px\),1fr\)\)/); assert.match(css, /background-size:400% 200%/);
});

test('account identity requires fresh matching owner, selection and account proof instead of inferring an email from quota', () => {
  const accountKey = 'a1b2c3d4a1b2c3d4';
  const snapshot = { codex: { status: 'ready', provider: 'openai-codex', selection: 'active', accountKey } };
  const proof = { status: 'ready', provider: 'openai-codex', selection: 'active', accountKey, maskedEmail: 't***@e***.com', validForMs: 120000 };
  assert.match(accountSummary(snapshot, proof, 0), /当前账号（统一订阅）.*t\*\*\*@e\*\*\*\.com/);
  assert.match(accountSummary(snapshot, proof, 119999), /t\*\*\*@e\*\*\*\.com/);
  const unconfirmed = [null, { ...proof, status: 'unavailable' }, { ...proof, provider: 'codex-accounts' }, { ...proof, selection: 'default' }, { ...proof, accountKey: 'b'.repeat(16) }, { ...proof, accountKey: 'not-an-account-key' }, { ...proof, validForMs: 0 }, { ...proof, validForMs: 120001 }];
  for (const value of unconfirmed) {
    assert.match(accountSummary(snapshot, value), /账号身份待确认/);
    assert.doesNotMatch(accountSummary(snapshot, value), /t\*\*\*@e\*\*\*\.com/);
  }
  for (const elapsed of [-1, NaN, Infinity, 120000]) assert.match(accountSummary(snapshot, proof, elapsed), /账号身份待确认/);
  for (const codex of [null, { ...snapshot.codex, status: 'switching' }, { ...snapshot.codex, accountKey: 'b'.repeat(16) }]) assert.match(accountSummary({ codex }, proof), /账号身份待确认/);
  const unsafeEmail = accountSummary(snapshot, { ...proof, maskedEmail: 'unmasked@example.com' });
  assert.match(unsafeEmail, /邮箱未提供/); assert.doesNotMatch(unsafeEmail, /unmasked@example\.com/);
});

function preferenceAutosaveHarness({ initial = {}, beforeWrite } = {}) {
  const writes = [], timers = new Map(); let timerId = 0, sequence = 0;
  let saved = { ...DEFAULT_PREFERENCES, ...initial }, revision = 'a'.repeat(64);
  const autosave = createPreferenceAutosave({
    setTimer(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimer(id) { timers.delete(id); },
    async write(patch, expected, signal) {
      const record = { patch: { ...patch }, revision: expected, signal }; writes.push(record);
      await beforeWrite?.(record, writes.length);
      assert.equal(expected, revision);
      saved = { ...saved, ...patch }; revision = (++sequence).toString(16).padStart(64, '0');
      return { values: { ...saved }, revision };
    },
  });
  autosave.load({ values: { ...saved }, revision });
  return {
    autosave, writes, timers, get saved() { return saved; }, get revision() { return revision; },
    async runTimers() {
      for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('every unified grant and warmup schedule change, including revocation, is excluded from autosave until explicit flush', async () => {
  const booleans = ['codexUnifiedControls', 'codexUnifiedWarmup', 'codexWarmupDaily', 'codexWarmupReset', 'codexWarmupStartup'];
  assert.ok(Object.isFrozen(AUTOSAVE_PREFERENCE_KEYS));
  for (const key of [...booleans, 'codexWarmupTime', 'multiAccountManagement', 'codexAccountBackend']) assert.ok(!AUTOSAVE_PREFERENCE_KEYS.includes(key), key);
  const cases = booleans.flatMap(key => [[key, false, true], [key, true, false]]).concat([['codexWarmupTime', '09:30', '11:45']]);
  for (const [key, original, edited] of cases) {
    const host = preferenceAutosaveHarness({ initial: { [key]: original, multiAccountManagement: true, codexAccountBackend: 'official' } });
    try {
      host.autosave.edit(key, edited);
      assert.equal(host.timers.size, 0, key); await host.runTimers(); await host.autosave.flush();
      assert.equal(host.writes.length, 0, key); assert.equal(host.saved[key], original);
      assert.equal(host.autosave.state().explicitDirty, true); assert.equal(host.autosave.state().safeDirty, false);
      await host.autosave.flush(true);
      assert.equal(host.writes.length, 1, key);
      assert.deepEqual(host.writes[0].patch, { [key]: edited }); assert.equal(host.writes[0].revision, 'a'.repeat(64));
      assert.equal(host.saved[key], edited); assert.equal(host.autosave.state().explicitDirty, false);
      assert.equal(host.saved.multiAccountManagement, true); assert.equal(host.saved.codexAccountBackend, 'official');
    } finally { host.autosave.dispose(); }
  }
});

test('in-flight appearance saves retain all pending grants and later visual edits without carrying authorization into either autosave', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const host = preferenceAutosaveHarness({ initial: { multiAccountManagement: true, codexAccountBackend: 'official' }, beforeWrite: (_record, count) => count === 1 ? gate : undefined });
  let saving;
  try {
    host.autosave.edit('codexUnifiedControls', true); host.autosave.edit('size', 'tiny'); saving = host.autosave.flush();
    assert.equal(host.autosave.state().inFlight, true); assert.deepEqual(host.writes[0].patch, { size: 'tiny' });
    host.autosave.edit('codexUnifiedWarmup', true); host.autosave.edit('codexWarmupTime', '11:45'); host.autosave.edit('size', 'small');
    await host.autosave.flush(true); assert.equal(host.writes.length, 1);
    release(); await saving;
    assert.equal(host.autosave.state().draft.codexUnifiedControls, true);
    assert.equal(host.autosave.state().draft.codexUnifiedWarmup, true);
    assert.equal(host.autosave.state().draft.codexWarmupTime, '11:45'); assert.equal(host.autosave.state().draft.size, 'small');
    assert.equal(host.saved.codexUnifiedControls, false); assert.equal(host.saved.codexUnifiedWarmup, false);
    const secondRevision = host.revision; await host.runTimers();
    assert.equal(host.writes.length, 2); assert.deepEqual(host.writes[1].patch, { size: 'small' }); assert.equal(host.writes[1].revision, secondRevision);
    assert.equal(host.autosave.state().explicitDirty, true); assert.equal(host.autosave.state().safeDirty, false);
    const confirmedRevision = host.revision; await host.autosave.flush(true);
    assert.equal(host.writes.length, 3); assert.equal(host.writes[2].revision, confirmedRevision);
    assert.deepEqual(host.writes[2].patch, { codexWarmupTime: '11:45', codexUnifiedControls: true, codexUnifiedWarmup: true });
    assert.equal(host.autosave.state().explicitDirty, false);
    assert.equal(host.saved.multiAccountManagement, true); assert.equal(host.saved.codexAccountBackend, 'official');
  } finally { release(); host.autosave.dispose(); await saving; }
});

test('invalid explicit warmup time cannot block visual autosave or bypass validation when confirmation is clicked', async () => {
  const host = preferenceAutosaveHarness();
  try {
    host.autosave.edit('codexUnifiedWarmup', true); host.autosave.edit('codexWarmupTime', '25:00'); host.autosave.edit('quietMode', true);
    await host.runTimers(); assert.equal(host.writes.length, 1); assert.deepEqual(host.writes[0].patch, { quietMode: true });
    assert.equal(host.saved.codexUnifiedWarmup, false); assert.equal(host.saved.codexWarmupTime, '09:30');
    await host.autosave.flush(true); assert.equal(host.writes.length, 1); assert.equal(host.autosave.state().error.validation, true);
    assert.equal(host.autosave.state().draft.codexUnifiedWarmup, true); assert.equal(host.autosave.state().draft.codexWarmupTime, '25:00');
    host.autosave.edit('codexWarmupTime', '11:45'); assert.equal(host.timers.size, 0); assert.equal(host.writes.length, 1);
    await host.autosave.flush(true); assert.equal(host.writes.length, 2);
    assert.deepEqual(host.writes[1].patch, { codexWarmupTime: '11:45', codexUnifiedWarmup: true });
  } finally { host.autosave.dispose(); }
});

test('CAS conflict preserves explicit drafts and blocks both retries and explicit confirmation until deliberate reload', async () => {
  const host = preferenceAutosaveHarness({ beforeWrite() { throw Object.assign(new Error('synthetic CAS conflict'), { status: 409 }); } });
  try {
    host.autosave.edit('codexUnifiedControls', true); host.autosave.edit('size', 'tiny'); await host.runTimers();
    assert.equal(host.writes.length, 1); assert.deepEqual(host.writes[0].patch, { size: 'tiny' });
    assert.equal(host.autosave.state().error.conflict, true); assert.equal(host.autosave.state().draft.codexUnifiedControls, true);
    await host.autosave.flush(true); await host.autosave.retry(); await host.runTimers(); assert.equal(host.writes.length, 1);
    assert.equal(host.saved.codexUnifiedControls, false); assert.equal(host.saved.size, DEFAULT_PREFERENCES.size);
    host.autosave.load({ values: { ...host.saved }, revision: 'b'.repeat(64) });
    assert.equal(host.autosave.state().error, null); assert.equal(host.autosave.state().explicitDirty, false);
    assert.equal(host.autosave.state().draft.codexUnifiedControls, false);
  } finally { host.autosave.dispose(); }
});

function visibleSettingsNodes(root) {
  if (!root || typeof root !== 'object' || root.props?.hidden) return [];
  const children = root.type === 'details' && !root.props.open ? root.children.filter(child => child?.type === 'summary') : root.children;
  return [root, ...children.flatMap(visibleSettingsNodes)];
}

test('settings menu registers without reading an undeclared optional remote namespace', () => {
  const host = settingsRegistrationHarness();
  try {
    assert.equal(host.entries.get('simple-desktop-pet').options.label(), '桌宠');
    assert.equal(host.unauthorizedReads, 0); assert.equal(host.requests, 0);
    assert.equal(host.services.pluginManager, undefined);
  } finally { host.dispose(); }
  assert.equal(host.entries.size, 0);
});

test('late or retired plugin-manager namespace cannot hide settings or leave a stale installer', () => {
  const host = settingsRegistrationHarness(), managerA = {}, managerB = {};
  try {
    const retireA = host.mount(managerA); assert.equal(host.services.pluginManager, managerA);
    host.unmount(); assert.equal(host.services.pluginManager, undefined); assert.equal(host.entries.size, 1);
    host.mount(managerB); retireA(); assert.equal(host.services.pluginManager, managerB);
    assert.equal(host.entries.size, 1); assert.equal(host.unauthorizedReads, 0); assert.equal(host.requests, 0);
  } finally { host.dispose(); }
  assert.equal(host.services.pluginManager, undefined); assert.equal(host.entries.size, 0);
});

test('disposing settings before optional service arrival revokes its waiting registration', () => {
  const host = settingsRegistrationHarness(); host.dispose();
  assert.equal(host.mount({}), null); assert.equal(host.services.pluginManager, undefined);
  assert.equal(host.entries.size, 0); assert.equal(host.requests, 0);
});

test('sticky settings toolbar flattens translucent host surfaces and ships its opaque fallback', () => {
  const css = readFileSync(new URL('./client.css', import.meta.url),'utf8');
  const toolbar = [...css.matchAll(/\.pet-settings-toolbar\{([^}]+)\}/g)].map(row => row[1]).join(';'); assert(toolbar);
  assert.match(toolbar, /position:sticky/); assert.match(toolbar, /isolation:isolate/);
  assert(toolbar.includes('background:linear-gradient(var(--dsw-alias-bg-layer-2,#202126),var(--dsw-alias-bg-layer-2,#202126)),#202126;'));
  const opaque = 'background:rgb(from var(--dsw-alias-bg-layer-2,#202126) r g b / 1);'; assert(toolbar.includes(opaque));
  assert(readFileSync(new URL('./lib/client.js', import.meta.url),'utf8').includes(opaque));
});
