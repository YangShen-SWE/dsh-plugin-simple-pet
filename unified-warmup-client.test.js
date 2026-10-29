import test from 'node:test';
import assert from 'node:assert/strict';
import { createUnifiedWarmupSettings } from './unified-warmup-client.js';

// No DOM, real credentials, configuration, timers, transport or model SDK. Events
// call the actual component handlers and effects run after the synthetic commit.
const A = 'a'.repeat(16), B = 'b'.repeat(16), GA = '1'.repeat(64), GB = '2'.repeat(64), M = '3'.repeat(64), N = '4'.repeat(64);
const tick = () => new Promise(resolve => setImmediate(resolve));
const copy = value => JSON.parse(JSON.stringify(value));
const defaults = () => ({ enabled: false, daily: false, time: '09:30', timeZone: 'UTC', accounts: [] });
const grant = (accountKey = A, extra = {}) => ({ accountKey, accountGeneration: accountKey === A ? GA : GB, modelKey: M, manual: true, daily: false, allowUnknownQuota: false, ...extra });
const account = (accountKey = A, extra = {}) => ({ accountKey, accountGeneration: accountKey === A ? GA : GB,
  active: accountKey === A, label: accountKey === A ? '合成甲' : '合成乙',
  models: { verified: true, revision: 'catalog-1', models: [{ modelKey: M, name: '合成文本模型' }, { modelKey: N, name: '另一文本模型' }] }, quota: { status: 'ready', fetchedAt: 1000 }, ...extra });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness(request) {
  const cells = [], effects = [], cleanup = []; let index = 0, tree, mounted = true, updatesAfterUnmount = 0;
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity).filter(value => value != null && value !== false) }; },
    useState(value) { const n = index++; if (!(n in cells)) cells[n] = value; return [cells[n], update => { if (!mounted) updatesAfterUnmount++; cells[n] = typeof update === 'function' ? update(cells[n]) : update; }]; },
    useRef(value) { return cells[index++] ??= { current: value }; },
    useEffect(effect) { const n = index++; if (!(n in cells)) { cells[n] = true; effects.push(effect); } },
  };
  const Component = createUnifiedWarmupSettings(React, { request });
  const render = () => { index = 0; tree = Component(); for (const effect of effects.splice(0)) cleanup.push(effect()); return tree; };
  const nodes = (node = tree) => node && typeof node === 'object' ? [node, ...node.children.flatMap(child => nodes(child))] : [];
  const text = (node = tree) => node && typeof node === 'object' ? node.children.map(child => text(child)).join('') : String(node ?? '');
  render();
  return { render, nodes, text, find: (attr, value) => nodes().find(node => node.props[attr] !== undefined && (value === undefined || node.props[attr] === value)),
    async flush() { await tick(); await tick(); render(); },
    unmount() { for (const effect of cleanup.splice(0)) effect?.(); mounted = false; }, get updatesAfterUnmount() { return updatesAfterUnmount; } };
}
function fixture(t, options = {}) {
  const state = { config: options.config || defaults(), revision: 'r1', paused: false, view: { status: 'disabled', rows: [] },
    capabilities: { accountBound: true, manual: true, daily: true }, accounts: [account(), account(B)] }, calls = [];
  const ui = harness(async (path, init) => {
    assert.equal(path, 'unified-warmup'); assert(init.signal instanceof AbortSignal);
    const body = init.body ? JSON.parse(init.body) : null; calls.push({ path, ...init, body });
    if (options.handle) { const result = await options.handle(init, body, state); if (result !== undefined) return result; }
    if (init.method === 'GET') return copy({ config: state.config, revision: state.revision, paused: state.paused, view: state.view, capabilities: state.capabilities });
    if (init.method === 'PUT') { assert.equal(body.confirmed, true); state.config = copy(body.config); state.revision = 'r2'; return copy({ ...state, accounts: undefined }); }
    if (body.action === 'discover') return copy({ accounts: state.accounts });
    if (body.action === 'refresh') return copy({ account: state.accounts.find(row => row.accountKey === body.accountKey) });
    if (body.action === 'run') return { paused: false, view: { status: 'settled', rows: body.accountKeys.map(accountKey => ({ accountKey, status: 'succeeded' })) } };
    if (body.action === 'cancel') return { paused: true, view: { status: 'cancelled' } };
    throw new Error('Unexpected synthetic operation');
  });
  t.after(() => ui.unmount());
  const click = async name => { const node = ui.find('data-warmup-action', name); assert(node, name); assert.notEqual(node.props.disabled, true, `${name} disabled`); node.props.onClick(); await ui.flush(); };
  const change = (name, value) => { const node = ui.find('data-warmup-field', name); assert(node, name); assert.notEqual(node.props.disabled, true, `${name} disabled`); node.props.onChange({ target: { checked: value, value } }); ui.render(); };
  const actions = action => calls.filter(call => call.body?.action === action);
  return { ui, state, calls, click, change, actions, async ready() { await ui.flush(); }, async discover() { await click('discover'); }, async save() { await click('save'); await click('confirm'); },
    async selectSaved(key = A) { await ui.flush(); await click('discover'); change(`run:${key}`, true); },
    async buildDraft() { await ui.flush(); await click('discover'); change(`include:${A}`, true); change(`model:${A}`, M); change(`manual:${A}`, true); change('enabled', true); } };
}

test('mount reads only GET; disabled default UTC 09:30 and no automatic account/active selection', async t => {
  const f = fixture(t); await f.ready();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'GET');
  assert.equal(f.ui.find('data-warmup-field', 'enabled').props.checked, false);
  assert.equal(f.ui.find('data-warmup-field', 'daily').props.checked, false);
  assert.equal(f.ui.find('data-warmup-field', 'time').props.value, '09:30');
  assert.equal(f.ui.find('data-warmup-field', 'timeZone').props.value, 'UTC');
  await f.discover();
  assert.equal(f.ui.find('data-warmup-field', `include:${A}`).props.checked, false);
  assert.equal(f.ui.find('data-warmup-field', `include:${B}`).props.checked, false);
  assert.deepEqual(f.calls.map(call => call.body?.action || call.method), ['GET', 'discover']);
  assert.match(f.ui.text(), /普通当前账号（仅展示，不自动选择）/);
});

test('draft edits never auto-save; explicit confirmation saves exact grants and never runs', async t => {
  const f = fixture(t); await f.buildDraft();
  f.change('daily', true); f.change(`daily:${A}`, true); f.change('timeZone', 'Europe/Copenhagen');
  assert.match(f.ui.text(), /Europe\/Copenhagen/);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  await f.click('save'); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  assert.match(f.ui.text(), /可能真实消耗订阅额度.*无自动重试.*未知结果持久暂停/);
  await f.click('confirm');
  const saved = f.calls.find(call => call.method === 'PUT').body;
  assert.deepEqual(saved, { config: { enabled: true, daily: true, time: '09:30', timeZone: 'Europe/Copenhagen', accounts: [grant(A, { daily: true })] }, revision: 'r1', confirmed: true });
  assert.equal(f.actions('run').length, 0); assert.equal(f.actions('refresh').length, 0);
  assert.equal(f.ui.find('data-warmup-draft').props['data-warmup-draft'], 'saved');
});

test('save confirmation dismissed or invalidated by later edits sends nothing', async t => {
  const f = fixture(t); await f.buildDraft(); await f.click('save'); const oldConfirm = f.ui.find('data-warmup-action', 'confirm').props.onClick;
  f.change('time', '10:15'); oldConfirm(); await f.ui.flush();
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  await f.click('save'); await f.click('dismiss'); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
});

test('verified per-account directory is mandatory and explicit refresh needs its own no-model consent', async t => {
  const f = fixture(t); f.state.accounts[0].models = { verified: false, revision: 'x', models: [{ modelKey: M, name: '不得使用' }] };
  await f.ready(); await f.discover(); f.change(`include:${A}`, true);
  assert.equal(f.ui.find('data-warmup-field', `model:${A}`).props.disabled, true);
  assert.equal(f.ui.find('data-warmup-field', `manual:${A}`).props.checked, false);
  await f.click(`refresh:${A}`); assert.equal(f.actions('refresh').length, 0);
  assert.match(f.ui.text(), /可能联网.*刷新 OAuth.*不发送模型请求/);
  f.state.accounts[0] = account(); await f.click('confirm');
  assert.deepEqual(f.actions('refresh')[0].body, { action: 'refresh', accountKey: A, accountGeneration: GA, confirmed: true });
  assert.equal(f.ui.find('data-warmup-field', `model:${A}`).props.value, '');
  assert.equal(f.ui.find('data-warmup-field', `manual:${A}`).props.checked, false);
});

test('manual execution requires saved manual grants, explicit batch selection and visible final account/model confirmation', async t => {
  const f = fixture(t, { config: { ...defaults(), enabled: true, accounts: [grant(), grant(B)] } }); await f.selectSaved();
  assert.equal(f.ui.find('data-warmup-field', `run:${B}`).props.checked, false);
  await f.click('run'); assert.equal(f.actions('run').length, 0);
  const confirmation = f.ui.find('data-warmup-final-rows'); assert.match(f.ui.text(confirmation), /合成甲 → 合成文本模型/);
  assert(f.ui.text(confirmation).includes(A)); assert(f.ui.text(confirmation).includes(M));
  assert.doesNotMatch(f.ui.text(confirmation), /合成乙/); assert.match(f.ui.text(), /可能消耗额度/);
  await f.click('confirm'); assert.deepEqual(f.actions('run')[0].body, { action: 'run', revision: 'r1', accountKeys: [A], confirmed: true });
  assert.match(f.ui.text(), /请求已完成/);
});

test('daily grant does not imply manual permission; model change revokes all row grants', async t => {
  const f = fixture(t, { config: { ...defaults(), enabled: true, daily: true, accounts: [grant(A, { manual: false, daily: true, allowUnknownQuota: true })] } });
  await f.ready(); await f.discover();
  assert.equal(f.ui.find('data-warmup-field', `run:${A}`).props.disabled, true); assert.match(f.ui.text(), /未授权手动/);
  f.change(`model:${A}`, N);
  for (const field of ['manual', 'daily', 'unknown']) assert.equal(f.ui.find('data-warmup-field', `${field}:${A}`).props.checked, false);
});

test('unknown quota defaults to skipped and restricted quota cannot be bypassed by unknown consent', async t => {
  const f = fixture(t, { config: { ...defaults(), enabled: true, accounts: [grant(), grant(B, { allowUnknownQuota: true })] } });
  f.state.accounts[0].quota.status = 'unknown'; f.state.accounts[1].quota.status = 'restricted'; await f.ready(); await f.discover();
  assert.equal(f.ui.find('data-warmup-field', `run:${A}`).props.disabled, true);
  assert.equal(f.ui.find('data-warmup-field', `run:${B}`).props.disabled, true);
  f.change(`unknown:${A}`, true); await f.save();
  assert.equal(f.ui.find('data-warmup-field', `run:${A}`).props.disabled, false);
  assert.equal(f.ui.find('data-warmup-field', `run:${B}`).props.disabled, true);
  assert.equal(f.actions('run').length, 0);
});

test('capabilities fail closed and missing/invalid model, time and timezone cannot be saved', async t => {
  const f = fixture(t); await f.ready(); f.state.capabilities = {}; await f.click('read');
  assert.equal(f.ui.find('data-warmup-field', 'enabled').props.disabled, true);
  assert.equal(f.ui.find('data-warmup-field', 'daily').props.disabled, true);
  f.state.capabilities = { accountBound: true, manual: true, daily: true }; await f.click('read'); await f.discover();
  f.change(`include:${A}`, true); await f.click('save'); assert.match(f.ui.text(), /草稿无效/);
  f.change(`model:${A}`, M); f.change('time', '25:00'); await f.click('save'); assert.match(f.ui.text(), /草稿无效/);
  f.change('time', '09:30'); f.change('timeZone', 'Invalid/Zone'); await f.click('save');
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
});

test('at most eight grants; no automatic ninth replacement and all row grants start off', async t => {
  const f = fixture(t); f.state.accounts = Array.from({ length: 9 }, (_, index) => account((index + 1).toString(16).padStart(16, '0')));
  await f.ready(); await f.discover();
  for (const row of f.state.accounts.slice(0, 8)) { f.change(`include:${row.accountKey}`, true); assert.equal(f.ui.find('data-warmup-field', `manual:${row.accountKey}`).props.checked, false); }
  assert.equal(f.ui.find('data-warmup-field', `include:${f.state.accounts[8].accountKey}`).props.disabled, true);
  assert.equal(f.ui.nodes().filter(node => String(node.props['data-warmup-field']).startsWith('include:') && node.props.checked).length, 8);
});

test('GET refresh preserves local draft; CAS conflict retains it until explicit latest-baseline confirmation', async t => {
  let rejectSave = true;
  const f = fixture(t, { handle(init) { if (init.method === 'PUT' && rejectSave) throw Object.assign(new Error('secret raw transport identity'), { status: 409 }); } });
  await f.buildDraft(); f.change('time', '11:11'); await f.save();
  assert.match(f.ui.text(), /草稿已保留/); assert.doesNotMatch(f.ui.text(), /secret raw/);
  f.state.revision = 'r9'; f.state.config.time = '22:22'; await f.click('read');
  assert.equal(f.ui.find('data-warmup-field', 'time').props.value, '11:11');
  assert.equal(f.ui.find('data-warmup-action', 'save').props.disabled, true);
  await f.click('rebase'); assert.equal(f.ui.find('data-warmup-field', 'time').props.value, '11:11');
  await f.click('confirm'); rejectSave = false; await f.save();
  assert.equal(f.calls.filter(call => call.method === 'PUT').at(-1).body.revision, 'r9');
  assert.equal(f.state.config.time, '11:11'); assert.equal(f.actions('run').length, 0);
});

test('changes made during a pending save survive its response and stay dirty', async t => {
  const pending = deferred();
  const f = fixture(t, { handle(init, body, state) { if (init.method === 'PUT') return pending.promise.then(() => ({ config: body.config, revision: 'r2', paused: false, view: state.view, capabilities: state.capabilities })); } });
  await f.buildDraft(); await f.click('save'); const confirm = f.ui.find('data-warmup-action', 'confirm').props.onClick;
  confirm(); f.ui.render(); f.change('time', '12:34'); pending.resolve(); await f.ui.flush();
  assert.equal(f.ui.find('data-warmup-field', 'time').props.value, '12:34');
  assert.equal(f.ui.find('data-warmup-draft').props['data-warmup-draft'], 'dirty');
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
});

test('synchronous double clicks and stale confirmation callbacks issue only one request', async t => {
  const pending = deferred();
  const f = fixture(t, { config: { ...defaults(), enabled: true, accounts: [grant()] }, handle(init, body) { if (body?.action === 'run') return pending.promise; } });
  await f.selectSaved(); await f.click('run'); const callback = f.ui.find('data-warmup-action', 'confirm').props.onClick;
  callback(); callback(); assert.equal(f.actions('run').length, 1);
  pending.resolve({ view: { status: 'settled', rows: [] }, paused: false }); await f.ui.flush(); callback(); await f.ui.flush();
  assert.equal(f.actions('run').length, 1);
});

test('unknown backend result is not success and remains blocked after ordinary GET/save', async t => {
  const f = fixture(t, { config: { ...defaults(), enabled: true, accounts: [grant()] }, handle(init, body) {
    if (body?.action === 'run') return { paused: true, view: { status: 'unknown', rows: [{ accountKey: A, status: 'unknown' }] } };
  } });
  await f.selectSaved(); await f.click('run'); await f.click('confirm');
  assert.match(f.ui.text(), /请求可能已消耗.*持久暂停/); assert.doesNotMatch(f.ui.text(), /请求已完成/);
  f.state.paused = false; await f.click('read'); f.change('time', '10:30'); await f.save();
  assert.equal(f.ui.find('data-warmup-action', 'run').props.disabled, true);
  assert.equal(f.actions('run').length, 1);
});

test('settled batch with an unknown or unfamiliar row outcome remains fail-closed', async t => {
  for (const outcome of ['paused_unknown', 'future_backend_outcome']) {
    const f = fixture(t, { config: { ...defaults(), enabled: true, accounts: [grant()] }, handle(init, body) {
      if (body?.action === 'run') return { view: { status: 'settled', rows: [{ accountKey: A, status: outcome }] } };
    } });
    await f.selectSaved(); await f.click('run'); await f.click('confirm');
    assert.equal(f.ui.find('data-warmup-action', 'run').props.disabled, true); assert.doesNotMatch(f.ui.text(), /请求已完成/);
  }
});

test('cancel aborts run signal, posts cancel once, ignores late success and retains consumption warning', async t => {
  const pending = deferred();
  const f = fixture(t, { config: { ...defaults(), enabled: true, accounts: [grant()] }, handle(init, body) { if (body?.action === 'run') return pending.promise; } });
  await f.selectSaved(); await f.click('run'); await f.click('confirm');
  const cancel = f.ui.find('data-warmup-action', 'cancel').props.onClick;
  cancel(); cancel(); await f.ui.flush();
  assert.equal(f.actions('cancel').length, 1); assert.equal(f.actions('run')[0].signal.aborted, true);
  // A transport that ignores abort must not hold the UI operation lock forever.
  assert.equal(f.ui.find('data-warmup-action', 'read').props.disabled, false); await f.click('read');
  pending.resolve({ paused: false, view: { status: 'settled', rows: [{ accountKey: A, status: 'succeeded' }] } }); await f.ui.flush();
  assert.doesNotMatch(f.ui.text(), /请求已完成/); assert.match(f.ui.text(), /已发送部分可能消耗额度/);
  assert.equal(f.ui.find('data-warmup-action', 'run').props.disabled, true);
});

test('unmount revokes captured action handlers, aborts pending requests and ignores delayed resolution', async t => {
  const pending = deferred();
  const f = fixture(t, { handle(init) { if (init.method === 'GET') return pending.promise; } });
  const discover = f.ui.find('data-warmup-action', 'discover').props.onClick, cancel = f.ui.find('data-warmup-action', 'cancel').props.onClick;
  f.ui.unmount(); assert.equal(f.calls[0].signal.aborted, true); discover(); cancel();
  pending.resolve({ config: defaults(), revision: 'r1', paused: false, view: {}, capabilities: {} }); await tick(); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.ui.updatesAfterUnmount, 0);
});

test('late rejection after cancellation is handled; raw errors and identity-like labels never render', async t => {
  const pending = deferred();
  const f = fixture(t, { config: { ...defaults(), enabled: true, accounts: [grant()] }, handle(init, body) { if (body?.action === 'run') return pending.promise; } });
  f.state.accounts[0].label = 'private@example.test'; f.state.accounts[0].models.models[0].name = 'https://private.test/token';
  await f.selectSaved(); await f.click('run'); assert.doesNotMatch(f.ui.text(), /private|https:/);
  await f.click('confirm'); await f.click('cancel'); pending.reject(new Error('Bearer raw-secret-value')); await f.ui.flush();
  assert.doesNotMatch(f.ui.text(), /Bearer|raw-secret-value|private@example/);
});

test('account generation drift cannot retain old grant validity or silently switch model', async t => {
  const f = fixture(t, { config: { ...defaults(), enabled: true, accounts: [grant()] } }); await f.ready();
  f.state.accounts[0].accountGeneration = '5'.repeat(64); await f.discover();
  assert.equal(f.ui.find('data-warmup-field', `run:${A}`).props.disabled, true);
  assert.equal(f.ui.find('data-warmup-field', `model:${A}`).props.value, '');
  f.change(`model:${A}`, M); assert.equal(f.ui.find('data-warmup-field', `manual:${A}`).props.checked, false);
  assert.equal(f.ui.find('data-warmup-draft').props['data-warmup-draft'], 'dirty');
});

test('server config is projected to exact fixed schema before future PUT, never forwards extra identity fields', async t => {
  const f = fixture(t, { config: { ...defaults(), rawIdentity: 'SHOULD_NOT_LEAK', accounts: [grant(A, { identity: 'SHOULD_NOT_LEAK' })] } });
  await f.ready(); await f.discover(); f.change('time', '10:10'); await f.save();
  const body = f.calls.find(call => call.method === 'PUT').body;
  assert.doesNotMatch(JSON.stringify(body), /SHOULD_NOT_LEAK|rawIdentity|identity/);
});

test('a stale confirmation cannot authorize a replacement dialog and stale run clicks cannot bypass new draft edits', async t => {
  const f = fixture(t, { config: { ...defaults(), enabled: true, accounts: [grant()] } }); await f.selectSaved();
  const oldRun = f.ui.find('data-warmup-action', 'run').props.onClick;
  await f.click('run'); const oldConfirm = f.ui.find('data-warmup-action', 'confirm').props.onClick;
  await f.click('dismiss'); await f.click('run'); oldConfirm(); await f.ui.flush(); assert.equal(f.actions('run').length, 0);
  await f.click('dismiss'); f.change('time', '11:12'); oldRun(); await f.ui.flush();
  assert(!f.ui.find('data-warmup-confirm')); assert.equal(f.actions('run').length, 0);
});

test('disabling an existing plan remains possible when capabilities/catalog are unavailable', async t => {
  const f = fixture(t, { config: { ...defaults(), enabled: true, accounts: [grant()] } }); await f.ready();
  f.state.capabilities = {}; await f.click('read');
  assert.equal(f.ui.find('data-warmup-field', 'enabled').props.disabled, false);
  f.change('enabled', false); await f.save();
  assert.equal(f.state.config.enabled, false); assert.equal(f.actions('refresh').length, 0); assert.equal(f.actions('run').length, 0);
});

test('malformed account references and arbitrary backend status names fail closed without raw data attributes', async t => {
  const f = fixture(t); await f.ready(); f.state.accounts.push({ accountKey: 1234567890123456, accountGeneration: GA });
  await f.discover(); assert.equal(f.ui.nodes().filter(node => node.props['data-warmup-account']).length, 2);
  f.state.view = { status: '__proto__', rows: [{ accountKey: A, status: 'RAW_PRIVATE_STATUS' }] }; await f.click('read');
  assert.equal(f.ui.find('data-warmup-result').props['data-warmup-result'], 'unconfirmed');
  assert.doesNotMatch(f.ui.text(), /RAW_PRIVATE_STATUS/);
  assert(!f.ui.nodes().some(node => /reset|startup|fiveHour|clear|restore/i.test(String(node.props['data-warmup-action'] || ''))));
});

test('unauthorized and unknown statuses use enum copy, not backend detail/error payloads', async t => {
  const f = fixture(t, { handle(init) { if (init.method === 'POST') throw Object.assign(new Error('raw-account-and-token'), { status: 403 }); } });
  await f.ready(); await f.discover(); assert.match(f.ui.text(), /未获授权/); assert.doesNotMatch(f.ui.text(), /raw-account-and-token/);
  f.state.view = { status: 'invented success private', rows: [{ accountKey: A, status: 'unauthorized', detail: 'secret' }] }; await f.click('read');
  assert.match(f.ui.text(), /状态未确认/); assert.match(f.ui.text(), /未授权/); assert.doesNotMatch(f.ui.text(), /invented success private|secret/);
});
