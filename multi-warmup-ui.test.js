import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createSimplePetClient } from './client-source.js';
import { DEFAULT_PREFERENCES } from './preferences.js';
import { apply, multiBlocksLegacy, legacyBlocksMulti, readLegacyWarmup } from './index.js';
import { MultiWarmupStore } from './multi-warmup.js';
import { localSchedule } from './warmup.js';

const settle = () => new Promise(r => setImmediate(r));
const work = join(import.meta.dirname, 'work');
const explicitKeys = ['codexUnifiedControls', 'codexUnifiedWarmup', 'codexWarmupStartup', 'codexWarmupReset', 'codexWarmupDaily', 'codexWarmupTime'];
const retiredPaths = ['accounts', 'multi-warmup', 'official-accounts'];
async function scratch(prefix) { await mkdir(work, { recursive: true }); return mkdtemp(join(work, prefix)); }
function harness(send) {
  const cells = [], cleanups = []; let i = 0, tree;
  const React = { createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat().filter(x => x !== false && x != null) }; },
    useState(value) { const n = i++; if (!(n in cells)) cells[n] = value; return [cells[n], value => { cells[n] = typeof value === 'function' ? value(cells[n]) : value; }]; },
    useRef(value) { return cells[i++] ??= { current: value }; }, useEffect(fn) { const n = i++; if (!(n in cells)) { cells[n] = true; cleanups.push(fn()); } } };
  const client = createSimplePetClient(React, send), render = () => { i = 0; return tree = client.SimplePetSettings(); };
  const nodes = (node = tree) => node && typeof node === 'object' ? [node, ...node.children.flatMap(nodes)] : [];
  const find = key => { const node = nodes().find(n => n.props[key]); assert(node, key); return node; };
  const field = name => { const node = nodes().find(n => n.props.name === name); assert(node, name); return node; };
  const text = (node = tree) => node && typeof node === 'object' ? node.children.map(text).join('') : String(node ?? '');
  render(); return { render, nodes, find, field, text, cleanup() { cleanups.splice(0).forEach(fn => fn?.()); } };
}
function fixture(overrides = {}) {
  const calls = []; let values = { ...DEFAULT_PREFERENCES, billingMode: 'codex', ...overrides }, revision = 'b'.repeat(64), handler;
  const current = () => ({ values: { ...values }, revision });
  const ui = harness(async (url, init = {}) => {
    calls.push({ url, ...init });
    assert(!retiredPaths.some(path => url.endsWith('/' + path)), 'retired UI must not access old account engines');
    if (url.endsWith('/preferences')) {
      if (handler) return handler(url, init);
      if (init.method === 'PUT') {
        const body = JSON.parse(init.body);
        if (body.revision !== revision) return Response.json({ error: 'conflict' }, { status: 409 });
        values = { ...values, ...body.patch }; revision = 'c'.repeat(64);
      }
      return Response.json(current());
    }
    assert(['state', 'application', 'account'].some(path => url.endsWith('/' + path)), 'only read-only public state is allowed');
    assert(!init.method || init.method === 'GET');
    return Response.json({ status: 'unavailable' });
  });
  return { ...ui, calls, current, setHandler(fn) { handler = fn; }, external(patch) { values = { ...values, ...patch }; revision = 'd'.repeat(64); } };
}
async function load(ui) { await settle(); await settle(); ui.render(); }
function change(ui, name, value) { ui.field(name).props.onChange({ target: typeof value === 'boolean' ? { checked: value } : { value } }); ui.render(); }
function navigate(ui, id) { const tab = ui.nodes().find(n => n.props['data-pet-tab'] === id); assert(tab, id); tab.props.onClick(); ui.render(); }
const writes = ui => ui.calls.filter(c => c.method === 'PUT');
const preferencesReads = ui => ui.calls.filter(c => c.url.endsWith('/preferences') && !c.method);

// These are collaboration drafts for the sole subscription owner, not a restored batch-warm-up UI.
test('startup and reset are independent explicit drafts and never imply unified warm-up consent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const ui = fixture();
  try {
    await load(ui); change(ui, 'codexWarmupStartup', true); change(ui, 'codexWarmupReset', true);
    assert.equal(ui.field('codexUnifiedWarmup').props.checked, false);
    assert.equal(ui.field('codexUnifiedControls').props.checked, false);
    t.mock.timers.tick(1000); await settle(); assert.equal(writes(ui).length, 0);
    ui.find('data-settings-save').props.onClick(); await load(ui);
    assert.deepEqual(JSON.parse(writes(ui)[0].body).patch, { codexWarmupReset: true, codexWarmupStartup: true });
    assert.equal(ui.current().values.codexUnifiedWarmup, false);
    assert.match(ui.text(), /真实消耗当前选中账号/); assert.match(ui.text(), /无聊天历史、无工具/);
    assert.match(ui.text(), /结果未知不自动重试/); assert.match(ui.text(), /同一窗口持久去重/);
  } finally { ui.cleanup(); }
});
test('collaboration draft survives supported tab navigation without writes or account rediscovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const ui = fixture();
  try {
    await load(ui); change(ui, 'codexWarmupTime', '11:24'); change(ui, 'codexUnifiedWarmup', true);
    const before = ui.calls.length; navigate(ui, 'stats'); navigate(ui, 'appearance'); t.mock.timers.tick(1000); await settle(); ui.render();
    assert.equal(ui.field('codexWarmupTime').props.value, '11:24'); assert.equal(ui.field('codexUnifiedWarmup').props.checked, true);
    assert.equal(ui.calls.length, before); assert.equal(writes(ui).length, 0); assert.match(ui.text(), /账号与预热授权尚未保存/);
    assert.deepEqual(ui.nodes().filter(n => n.props['data-pet-tab']).map(n => n.props['data-pet-tab']), ['appearance', 'stats']);
  } finally { ui.cleanup(); }
});
test('450ms visual autosave neither commits nor discards an independent collaboration draft', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const ui = fixture();
  try {
    await load(ui); change(ui, 'codexWarmupTime', '11:24'); change(ui, 'codexUnifiedWarmup', true);
    navigate(ui, 'stats'); navigate(ui, 'appearance'); change(ui, 'quietMode', true);
    t.mock.timers.tick(449); await settle(); assert.equal(writes(ui).length, 0);
    t.mock.timers.tick(1); await load(ui); assert.equal(writes(ui).length, 1);
    assert.deepEqual(JSON.parse(writes(ui)[0].body), { patch: { quietMode: true }, revision: 'b'.repeat(64) });
    assert.equal(ui.field('codexWarmupTime').props.value, '11:24'); assert.equal(ui.field('codexUnifiedWarmup').props.checked, true);
    assert.equal(ui.current().values.codexUnifiedWarmup, false); assert.equal(ui.current().values.codexWarmupTime, '09:30');
    assert.equal(ui.find('data-settings-save').props.disabled, false);
  } finally { ui.cleanup(); }
});
test('mount and rendering never discover accounts, expose retired pages, or send spending requests', async () => {
  const ui = fixture();
  try {
    await load(ui); assert.equal(ui.calls.length, 4);
    assert.deepEqual(ui.calls.map(c => c.url.split('/').at(-1)), ['preferences', 'state', 'application', 'account']);
    assert(!ui.nodes().some(n => Object.keys(n.props).some(key => /^data-multi-/.test(key))));
    for (const key of ['multiAccountManagement', 'codexAccountBackend', 'codexUsageRefreshMode']) assert(!ui.nodes().some(n => n.props.name === key));
    assert.match(ui.text(), /不自动轮换账号/); assert.match(ui.text(), /旧逐账号计划不迁移授权/);
    assert.equal(writes(ui).length, 0);
  } finally { ui.cleanup(); }
});
test('explicit reload only reads preferences; all new collaboration permissions remain off', async () => {
  const ui = fixture();
  try {
    await load(ui); const before = ui.calls.length; ui.find('data-settings-reload').props.onClick(); await load(ui);
    assert.equal(ui.calls.length, before + 1); assert.equal(preferencesReads(ui).length, 2);
    for (const key of explicitKeys.filter(key => key !== 'codexWarmupTime')) assert.equal(ui.field(key).props.checked, false, key);
    assert.equal(ui.field('codexWarmupTime').props.value, '09:30'); assert.equal(writes(ui).length, 0);
  } finally { ui.cleanup(); }
});
test('warm-up enrollment and daily trigger are separate; double confirmation is single-flight and never invokes a run', async () => {
  const ui = fixture();
  try {
    await load(ui); change(ui, 'codexUnifiedWarmup', true);
    for (const key of ['codexUnifiedControls', 'codexWarmupDaily', 'codexWarmupStartup', 'codexWarmupReset']) assert.equal(ui.field(key).props.checked, false, key);
    change(ui, 'codexWarmupDaily', true); const save = ui.find('data-settings-save'); save.props.onClick(); save.props.onClick(); await load(ui);
    assert.equal(writes(ui).length, 1);
    assert.deepEqual(JSON.parse(writes(ui)[0].body), { patch: { codexUnifiedWarmup: true, codexWarmupDaily: true }, revision: 'b'.repeat(64) });
    assert.match(ui.text(), /设置保存本身不代表请求已执行/); assert(!ui.calls.some(c => /run|activate|select|discover/.test(c.url)));
  } finally { ui.cleanup(); }
});
test('dirty draft never silently rebases CAS on background reads; explicit discard and reload is required', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); const ui = fixture();
  try {
    await load(ui); change(ui, 'codexWarmupTime', '10:12'); change(ui, 'codexUnifiedWarmup', true);
    ui.external({ codexUnifiedWarmup: false, codexWarmupTime: '11:43' });
    t.mock.timers.tick(5000); await load(ui); assert.equal(preferencesReads(ui).length, 1);
    ui.find('data-settings-save').props.onClick(); await load(ui);
    assert.equal(JSON.parse(writes(ui)[0].body).revision, 'b'.repeat(64)); assert.equal(writes(ui).length, 1);
    assert.equal(ui.field('codexWarmupTime').props.value, '10:12'); assert.equal(ui.field('codexUnifiedWarmup').props.checked, true);
    assert.match(ui.text(), /当前草稿已保留/); assert.match(ui.text(), /明确放弃草稿并重新读取/);
    ui.find('data-settings-reload').props.onClick(); await load(ui);
    assert.equal(ui.field('codexWarmupTime').props.value, '11:43'); assert.equal(ui.field('codexUnifiedWarmup').props.checked, false);
    assert.equal(writes(ui).length, 1);
  } finally { ui.cleanup(); }
});
test('clean explicit reread follows externally revoked permissions without regranting them', async () => {
  const ui = fixture({ codexUnifiedWarmup: true, codexUnifiedControls: true, codexWarmupDaily: true });
  try {
    await load(ui); ui.external({ codexUnifiedControls: false, codexUnifiedWarmup: false, codexWarmupDaily: false, codexWarmupTime: '11:43' });
    ui.find('data-settings-reload').props.onClick(); await load(ui);
    for (const key of ['codexUnifiedControls', 'codexUnifiedWarmup', 'codexWarmupDaily']) assert.equal(ui.field(key).props.checked, false, key);
    assert.equal(ui.field('codexWarmupTime').props.value, '11:43'); assert.equal(ui.find('data-settings-save').props.disabled, true);
    ui.find('data-settings-save').props.onClick(); await load(ui); assert.equal(writes(ui).length, 0);
    change(ui, 'codexWarmupTime', '12:34'); ui.find('data-settings-save').props.onClick(); await load(ui);
    assert.deepEqual(JSON.parse(writes(ui)[0].body), { patch: { codexWarmupTime: '12:34' }, revision: 'd'.repeat(64) });
  } finally { ui.cleanup(); }
});
test('409 preserves exact collaboration draft without retries, visual write, or retired route fallback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const ui = fixture();
  try {
    await load(ui); change(ui, 'codexWarmupTime', '10:12'); change(ui, 'codexUnifiedWarmup', true);
    ui.setHandler(async () => Response.json({ error: 'conflict' }, { status: 409 }));
    ui.find('data-settings-save').props.onClick(); await load(ui);
    assert.equal(ui.field('codexWarmupTime').props.value, '10:12'); assert.equal(ui.field('codexUnifiedWarmup').props.checked, true);
    assert.match(ui.text(), /草稿已保留/); assert.equal(ui.find('data-settings-save').props.disabled, true);
    ui.find('data-settings-save').props.onClick(); t.mock.timers.tick(10000); await load(ui); assert.equal(writes(ui).length, 1);
    assert.deepEqual(JSON.parse(writes(ui)[0].body).patch, { codexUnifiedWarmup: true, codexWarmupTime: '10:12' });
    assert(!ui.nodes().some(n => n.props['data-settings-retry']));
  } finally { ui.cleanup(); }
});
test('unmount aborts an explicit preference read and no late result can save the draft', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const ui = fixture(); let release;
  try {
    await load(ui); change(ui, 'codexWarmupTime', '10:12');
    ui.setHandler(() => new Promise(resolve => { release = resolve; })); ui.find('data-settings-reload').props.onClick();
    const pending = ui.calls.at(-1); assert(pending.url.endsWith('/preferences')); ui.cleanup(); assert.equal(pending.signal.aborted, true);
    release(Response.json(ui.current())); await settle(); t.mock.timers.tick(10000); await settle();
    assert.equal(preferencesReads(ui).length, 2); assert.equal(writes(ui).length, 0);
  } finally { ui.cleanup(); }
});
for (const key of explicitKeys) test(`${key} is independently confirmed and never piggybacks on visual autosave`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const ui = fixture();
  try {
    await load(ui); const value = key === 'codexWarmupTime' ? '13:14' : true;
    change(ui, key, value); t.mock.timers.tick(450); await settle(); assert.equal(writes(ui).length, 0);
    change(ui, 'quietMode', true); t.mock.timers.tick(450); await load(ui);
    assert.deepEqual(JSON.parse(writes(ui)[0].body).patch, { quietMode: true });
    ui.find('data-settings-save').props.onClick(); await load(ui); assert.equal(writes(ui).length, 2);
    assert.deepEqual(JSON.parse(writes(ui)[1].body), { patch: { [key]: value }, revision: 'c'.repeat(64) });
    for (const other of explicitKeys.filter(other => other !== key)) assert.equal(ui.current().values[other], DEFAULT_PREFERENCES[other], other);
  } finally { ui.cleanup(); }
});

async function invoke(handler, body, method = 'GET') {
  let code, headers, result; const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
  await handler({ method, headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { if (bytes) yield bytes; } }, { writeHead(c, h) { code = c; headers = h; }, end(value) { result = value; } });
  return { code, headers, data: result && /json/.test(headers?.['Content-Type']) ? JSON.parse(result) : null };
}
test('shared day arbitration stays symmetric, pauses on unknown/future claims, and reloads legacy disk data', async t => {
  const now = new Date(2026, 9, 15, 9, 30).getTime(), day = localSchedule(now, '00:00').day;
  assert(multiBlocksLegacy({ paused: false, attempts: [{ day, attemptedAt: now }] }, now));
  assert(multiBlocksLegacy({ paused: false, attempts: [{ day: '2099-01-01', attemptedAt: now + 1000 }] }, now));
  assert(multiBlocksLegacy({ paused: true, attempts: [] }, now));
  assert(!multiBlocksLegacy({ paused: false, attempts: [] }, now));
  assert(legacyBlocksMulti({ keys: [], lastAttemptAt: now }, now));
  assert(legacyBlocksMulti({ keys: [`daily:${day}`], lastAttemptAt: 0 }, now));
  const root = await scratch('test-multi-legacy-'); t.after(async () => { assert.equal(dirname(root), work); assert.match(basename(root), /^test-multi-legacy-/); await rm(root, { recursive: true, force: true }); });
  const file = join(root, 'warmup.json'); assert(readLegacyWarmup(file).readable);
  const first = { version: 1, keys: [], lastAttemptAt: now - 86_400_000 }; await writeFile(file, JSON.stringify(first));
  const stale = readLegacyWarmup(file); assert(!legacyBlocksMulti(stale.journal, now));
  await writeFile(file, JSON.stringify({ ...first, lastAttemptAt: now })); assert(legacyBlocksMulti(readLegacyWarmup(file).journal, now));
  await writeFile(file, '{bad'); assert.equal(readLegacyWarmup(file).readable, false);
  await writeFile(file, JSON.stringify({ ...first, lastAttemptAt: 'bad' })); assert.equal(readLegacyWarmup(file).readable, false);
});
async function desktopHost(t, { legacy = null, multiAttempt = false, enabled = false, authorized = true, owner = 'embedded' } = {}) {
  const root = await scratch('test-multi-desktop-'), old = process.env.LOCALAPPDATA, profile = process.env.DSH_PET_PROFILE;
  process.env.LOCALAPPDATA = root; process.env.DSH_PET_PROFILE = 'desktop';
  const cleanups = [], routes = new Map(), intervals = [], calls = []; let disposeBridge, releaseMetadata, streams = 0, prepared = 0, deny, activeId = 'SYNTHETIC_RAW';
  const oldInterval = globalThis.setInterval; globalThis.setInterval = (fn, ms, ...rest) => { intervals.push({ fn, ms }); return oldInterval(fn, ms, ...rest); };
  t.after(async () => {
    globalThis.setInterval = oldInterval; for (const fn of cleanups.reverse()) await fn?.();
    if (old === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = old;
    if (profile === undefined) delete process.env.DSH_PET_PROFILE; else process.env.DSH_PET_PROFILE = profile;
    assert.equal(resolve(dirname(root)), resolve(work)); assert.match(basename(root), /^test-multi-desktop-/); await rm(root, { recursive: true, force: true });
  });
  const dir = join(root, 'DshSimpleDesktopPet'); await mkdir(dir);
  const now = { value: Date.now() }, due = now.value + 30_000;
  const accountKey = createHash('sha256').update(activeId).digest('hex').slice(0, 16), modelKey = createHash('sha256').update('~account:SYNTHETIC_RAW:mock-model').digest('hex');
  const config = { enabled: true, time: '09:30', accounts: [{ accountKey, modelKey, enabled: true, allowUnverifiedQuota: true }] };
  const multiFile = join(dir, 'multi-warmup.json'), store = new MultiWarmupStore(multiFile); await store.configure(config, 'missing');
  if (multiAttempt) { await store.claim(config.accounts[0], localSchedule(now.value, '00:00').day, now.value, config); await store.finish(config.accounts[0], localSchedule(now.value, '00:00').day, 'succeeded', now.value); }
  if (!enabled) await store.configure({ ...config, enabled: false }, (await store.read()).revision);
  const legacyFile = join(dir, 'warmup.json');
  if (legacy !== null) await writeFile(legacyFile, typeof legacy === 'string' ? legacy : JSON.stringify(legacy));
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ ...DEFAULT_PREFERENCES, billingMode: 'codex', multiAccountManagement: true, codexAccountBackend: 'official', codexUnifiedWarmup: authorized, codexWarmupStartup: true, codexWarmupReset: true, codexWarmupDaily: true }));
  const bridge = { async fetch(req) {
    const body = await req.json(); calls.push(body);
    let value;
    if (body.method === 'codex-subscription/status') value = { authenticated: true, accounts: [{ id: activeId, active: true, email: 'synthetic@example.invalid' }] };
    else if (body.method === 'codex-subscription/default-model/status') value = { managed: true, provider: 'openai-codex', model: 'mock-model' };
    else if (body.method === 'codex-subscription/usage') value = { fetchedAt: now.value, rateLimits: [{ id: 'codex', windows: [
      { windowSeconds: 18000, remainingPercent: 100, resetsAt: Math.floor(now.value / 1000) + 18000 },
      { windowSeconds: 604800, remainingPercent: 100, resetsAt: Math.floor(now.value / 1000) + 604800 },
    ] }] };
    else assert.fail('no retired engine, account switch, or actual network RPC: ' + body.method);
    return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } });
  } };
  const services = { effect(fn, label) { const cleanup = fn(); cleanups.push(cleanup); if (label?.includes('subscription bridge')) disposeBridge = cleanup; }, webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path); } }, connection: { requestRejection() { return deny; }, createSharedFetchHandler() { return bridge; } } };
  const llm = { listConfigurableProviders() { return []; }, async listModels(provider) { assert.equal(provider, 'openai-codex'); return [{ provider, id: 'mock-model' }]; }, resolveModelInfo(provider, model, signal) { assert.equal(provider, 'openai-codex'); assert.equal(model, 'mock-model'); return new Promise(resolve => { releaseMetadata = value => resolve(value); }); }, stream() { assert.fail('the owner-bound prepared stream must be used'); } };
  const plugin = { synthetic: true };
  apply({ ...services, plugin(value) { assert.equal(value, plugin); }, inject(_deps, fn) { fn(services); }, on() {}, get() { return null; }, settings: { describe() { return []; } }, credentials: { resolve() { assert.fail('private credentials'); } }, llm }, {
    subscriptionFactory({ onOwner, onAdapter }) { onOwner(owner); onAdapter({ async prepareCall(provider, model, signal, key) { prepared++; assert.equal(provider, 'openai-codex'); assert.equal(model, 'mock-model'); assert.equal(key, accountKey); signal.throwIfAborted(); return { stream() { streams++; return (async function* () { yield { type: 'text-delta', text: 'OK' }; yield { type: 'finish', reason: { kind: 'stop' } }; })(); } }; } }); return plugin; },
    panelStarter: async () => ({ url: 'http://127.0.0.1:1/synthetic-panel', token: 'a'.repeat(64), close() {} }),
    petLauncher() { return () => {}; }, switchSupported: () => false, warmupClock: () => now.value,
  });
  const until = async predicate => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('mock host did not reach expected phase'); };
  await until(() => routes.has('/api/dsh-plugin-simple-pet/state')); for (let i = 0; i < 12; i++) await settle();
  return { store, routes, now, due, intervals, until, calls, legacyFile, multiFile, metadata: () => releaseMetadata, streamCount: () => streams, preparedCount: () => prepared, disposeBridge: () => disposeBridge(), setDeny(value) { deny = value; }, changeAccount() { activeId = 'SYNTHETIC_OTHER'; }, state: () => invoke(routes.get('/api/dsh-plugin-simple-pet/state')) };
}
test('enabled retired multi plan conservatively blocks the old current-account startup path', async t => {
  const f = await desktopHost(t, { enabled: true });
  await f.until(async () => /保护状态待核验/.test((await f.state()).data.codexWarmup.detail));
  const status = await invoke(f.routes.get('/api/dsh-plugin-simple-pet/unified-warmup'));
  assert.equal(status.data.paused, true); assert.equal(status.data.view.status, 'paused_legacy');
  assert.equal(f.metadata(), undefined); assert.equal(f.preparedCount(), 0); assert.equal(f.streamCount(), 0);
});
test('actual bridge disposal during independent owner preflight produces zero late prepared or model calls', async t => {
  const f = await desktopHost(t); await f.until(() => !!f.metadata());
  f.disposeBridge(); f.metadata()({ reasoning: {} });
  for (let i = 0; i < 12; i++) await settle(); assert.equal(f.preparedCount(), 0); assert.equal(f.streamCount(), 0);
});
test('actual disabled-multi host does not resume single startup after a multi claim today', async t => {
  const f = await desktopHost(t, { multiAttempt: true, enabled: false });
  await f.until(async () => /今天已有多账号认领/.test((await f.state()).data.codexWarmup.detail));
  assert.equal(f.streamCount(), 0); assert.equal(f.metadata(), undefined);
});
test('a corrupt shared legacy journal disables authorized owner automation without rewriting it', async t => {
  const f = await desktopHost(t, { legacy: '{broken' });
  await f.until(async () => /原单账号预热日志不可读/.test((await f.state()).data.codexWarmup.detail));
  assert.equal(f.streamCount(), 0); assert.equal(f.metadata(), undefined); assert.equal(await readFile(f.legacyFile, 'utf8'), '{broken');
});
test('retired account and batch routes are authenticated 410 tombstones with no discovery, write, or model side effects', async t => {
  const f = await desktopHost(t, { authorized: false }), before = await readFile(f.multiFile);
  for (const privateValue of ['SYNTHETIC_RAW', 'synthetic@example.invalid', 's***@e***.invalid']) {
    assert(!before.toString('utf8').includes(privateValue)); assert(!JSON.stringify((await f.state()).data).includes(privateValue));
  }
  for (const path of retiredPaths) {
    const handler = f.routes.get('/api/dsh-plugin-simple-pet/' + path); assert(handler, path);
    for (const code of [401, 403, null, 999]) { f.setDeny(code); assert.equal((await invoke(handler, { action: 'discover' }, 'POST')).code, [401, 403].includes(code) ? code : 403); }
    f.setDeny(undefined); const callsBefore = f.calls.length;
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) {
      const result = await invoke(handler, { action: 'discover', config: { enabled: true }, accountKey: 'synthetic' }, method);
      assert.equal(result.code, 410, path + ' ' + method); if (method === 'HEAD') assert.equal(result.data, null);
      assert(!JSON.stringify(result.data).includes('SYNTHETIC_RAW')); assert(!JSON.stringify(result.data).includes('synthetic@example.invalid'));
    }
    assert.equal(f.calls.length, callsBefore, path + ' must not invoke an account owner');
  }
  assert.deepEqual(await readFile(f.multiFile), before); assert.equal(f.streamCount(), 0); assert.equal(f.metadata(), undefined);
  assert(!f.calls.some(call => /subscriptions-auth|select|activate|default-model/.test(call.method)));
});
for (const mode of ['old-grants-only', 'external-owner']) test(`${mode} cannot authorize new owner warm-up despite old account and startup/reset/daily grants`, async t => {
  const f = await desktopHost(t, mode === 'old-grants-only' ? { authorized: false } : { owner: 'external' });
  await f.until(async () => /统一订阅自动预热未授权/.test((await f.state()).data.codexWarmup.detail));
  f.now.value = f.due; for (const interval of f.intervals) interval.fn(); for (let i = 0; i < 12; i++) await settle();
  assert.equal(f.metadata(), undefined); assert.equal(f.preparedCount(), 0); assert.equal(f.streamCount(), 0);
  assert(!f.calls.some(call => /subscriptions-auth|select|activate|default-model/.test(call.method)));
  await assert.rejects(readFile(f.legacyFile), { code: 'ENOENT' });
});
test('account identity change during owner preflight never retargets or streams the prepared request', async t => {
  const f = await desktopHost(t); await f.until(() => !!f.metadata()); f.changeAccount(); f.metadata()({ reasoning: {} });
  await f.until(() => f.preparedCount() === 1); for (let i = 0; i < 12; i++) await settle();
  assert.equal(f.streamCount(), 0); assert(!f.calls.some(call => /select|activate/.test(call.method)));
});
