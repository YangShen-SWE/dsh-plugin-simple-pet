import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createSimplePetClient } from './client-source.js';
import { DEFAULT_PREFERENCES } from './preferences.js';
import { apply, multiBlocksLegacy, legacyBlocksMulti, readLegacyWarmup } from './index.js';
import { MultiWarmupStore } from './multi-warmup.js';
import { localSchedule } from './warmup.js';
import { createHash } from 'node:crypto';
const settle = () => new Promise(r => setImmediate(r));
function harness(send) {
  const cells = [], cleanups = []; let i = 0, tree;
  const React = { createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat().filter(x => x !== false && x != null) }; },
    useState(value) { const n = i++; if (!(n in cells)) cells[n] = value; return [cells[n], value => { cells[n] = typeof value === 'function' ? value(cells[n]) : value; }]; },
    useRef(value) { return cells[i++] ??= { current: value }; }, useEffect(fn) { const n = i++; if (!(n in cells)) { cells[n] = true; cleanups.push(fn()); } } };
  const client = createSimplePetClient(React, send), render = () => { i = 0; return tree = client.SimplePetSettings(); };
  const nodes = (node = tree) => node && typeof node === 'object' ? [node, ...node.children.flatMap(nodes)] : [];
  const find = key => { const node = nodes().find(n => n.props[key]); assert(node, key); return node; };
  const text = (node = tree) => node && typeof node === 'object' ? node.children.map(text).join('') : String(node ?? '');
  render(); return { render, nodes, find, text, cleanup() { cleanups.forEach(fn => fn?.()); } };
}
const row = { accountKey: '1'.repeat(16), maskedEmail: 'a***@e***.com', models: [{ modelKey: '2'.repeat(64), modelName: 'mock-model' }] };
const initial = () => ({ config: { enabled: false, time: '09:30', accounts: [] }, revision: 'a'.repeat(64), paused: false });
function fixture() {
  const calls = []; let handler = async (_url, init) => init.method === 'POST' ? Response.json({ accounts: [row] }) : Response.json(initial());
  const ui = harness(async (url, init = {}) => {
    calls.push({ url, ...init });
    if (url.endsWith('/multi-warmup')) return handler(url, init);
    if (url.endsWith('/preferences')) return Response.json({ values: { ...DEFAULT_PREFERENCES, billingMode: 'codex' }, revision: 'b'.repeat(64) });
    return Response.json({ status: 'unavailable' });
  });
  return { ...ui, calls, setHandler(fn) { handler = fn; } };
}
async function load(ui) { await settle(); ui.render(); ui.find('data-multi-read').props.onClick(); await settle(); await settle(); ui.render(); }
test('unsupported startup/reset controls remain disabled before and after daily quota override consent', async () => {
  const ui = fixture();
  try {
    await load(ui);
    ui.find('data-multi-account').props.onChange({ target: { checked: true } }); ui.render();
    ui.find('data-multi-unverified').props.onChange({ target: { checked: true } }); ui.render();
    const controls = ui.nodes().filter(n => n.props['data-multi-trigger']);
    assert.deepEqual(controls.map(n => n.props['data-multi-trigger']), ['startup','reset']);
    assert(controls.every(n => n.props.disabled === true && n.props.checked === false && !n.props.onChange));
    assert.match(ui.text(), /额外额度授权只适用于每日次数预算/);
    assert.match(ui.text(), /force 失败也可能返回旧缓存/);
    assert.equal(ui.calls.filter(c => c.method === 'PUT').length, 0);
  } finally { ui.cleanup(); }
});
test('multi-account draft and pending reads survive navigation without implicit writes or rediscovery', async () => {
  const ui = fixture(), navigate = id => { ui.nodes().find(n => n.props['data-pet-tab'] === id).props.onClick(); ui.render(); };
  try {
    await load(ui); navigate('warmup');
    ui.find('data-multi-time').props.onChange({ target: { value: '11:24' } }); ui.render();
    const before = ui.calls.length;
    navigate('stats'); navigate('accounts'); navigate('appearance'); navigate('warmup');
    assert.equal(ui.find('data-multi-time').props.value, '11:24'); assert.equal(ui.calls.length, before);
    assert.equal(ui.calls.filter(c => c.method === 'PUT').length, 0);
    assert.match(ui.text(), /尚未保存多账号设置/);
  } finally { ui.cleanup(); }
});
test('cross-page preference save never commits or discards an independent multi-account draft', async () => {
  const ui = fixture();
  try {
    await load(ui); ui.find('data-multi-time').props.onChange({ target: { value: '11:24' } });
    ui.nodes().find(n => n.props['data-pet-tab'] === 'appearance').props.onClick(); ui.render();
    ui.nodes().find(n => n.props.name === 'quietMode').props.onChange({ target: { checked: true } }); ui.render();
    ui.nodes().find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); await settle(); ui.render();
    const writes = ui.calls.filter(c => c.method === 'PUT'); assert.equal(writes.length, 1);
    assert(writes[0].url.endsWith('/preferences')); assert.deepEqual(JSON.parse(writes[0].body).patch, { quietMode: true });
    assert.equal(ui.find('data-multi-time').props.value, '11:24');
    assert(!ui.calls.some(c => c.method === 'PUT' && c.url.endsWith('/multi-warmup')));
  } finally { ui.cleanup(); }
});
test('mount and visual preference edits never read bindings or send multi-warmup requests', async () => {
  const ui = fixture(); try { await settle(); ui.render(); assert.equal(ui.calls.length, 4); assert(!ui.calls.some(c => c.url.endsWith('/multi-warmup'))); assert.match(ui.text(), /每账号每天最多一次逻辑请求/); assert.match(ui.text(), /HTTP、Token 或费用硬上限/); } finally { ui.cleanup(); }
});
test('explicit read is GET then public discover only; all new grants remain off', async () => {
  const ui = fixture(); try { await load(ui); const calls = ui.calls.filter(c => c.url.endsWith('/multi-warmup')); assert.equal(calls.length, 2); assert.deepEqual(JSON.parse(calls[1].body), { action: 'discover' }); assert.equal(ui.find('data-multi-enabled').props.checked, false); assert.equal(ui.find('data-multi-account').props.checked, false); assert(!ui.nodes().some(n => n.props['data-multi-unverified'])); } finally { ui.cleanup(); }
});
test('account enrollment is explicit, quota override separate, and save never invokes a run', async () => {
  const ui = fixture(); try {
    await load(ui); ui.find('data-multi-account').props.onChange({ target: { checked: true } }); ui.render();
    assert.equal(ui.find('data-multi-unverified').props.checked, false);
    ui.find('data-multi-unverified').props.onChange({ target: { checked: true } }); ui.find('data-multi-enabled').props.onChange({ target: { checked: true } }); ui.render();
    ui.setHandler(async (_url, init) => Response.json({ config: JSON.parse(init.body).config, revision: 'c'.repeat(64), paused: false }));
    const save = ui.find('data-multi-save'); save.props.onClick(); save.props.onClick(); await settle(); ui.render();
    const writes = ui.calls.filter(c => c.method === 'PUT'); assert.equal(writes.length, 1); assert(writes[0].url.endsWith('/multi-warmup'));
    const body = JSON.parse(writes[0].body); assert.equal(body.revision, 'a'.repeat(64)); assert.deepEqual(body.config, { enabled: true, time: '09:30', accounts: [{ accountKey: row.accountKey, modelKey: row.models[0].modelKey, enabled: true, allowUnverifiedQuota: true }] });
    assert.match(ui.text(), /本次保存不执行预热/); assert(!ui.calls.some(c => /run|activate|select/.test(c.url)));
  } finally { ui.cleanup(); }
});
test('dirty draft cannot silently adopt a new revision through reread; explicit discard is required', async () => {
  const ui = fixture(); try { await load(ui); ui.find('data-multi-time').props.onChange({ target: { value: '10:12' } }); const before = ui.calls.length; ui.find('data-multi-read').props.onClick(); await settle(); ui.render(); assert.equal(ui.calls.length, before); assert.match(ui.text(), /存在未保存草稿/); assert.equal(ui.find('data-multi-time').props.value, '10:12'); ui.find('data-multi-discard').props.onClick(); await settle(); await settle(); ui.render(); assert.equal(ui.find('data-multi-time').props.value, '09:30'); } finally { ui.cleanup(); }
});
test('clean reread follows externally revoked grants instead of rebasing old grants', async () => {
  const ui = fixture(); try {
    await load(ui);
    const revoked = { ...initial(), revision: 'd'.repeat(64), config: { enabled: false, time: '11:43', accounts: [] } };
    ui.setHandler(async (_url, init) => init.method === 'POST' ? Response.json({ accounts: [row] }) : Response.json(revoked));
    ui.find('data-multi-read').props.onClick(); await settle(); await settle(); ui.render();
    assert.equal(ui.find('data-multi-time').props.value, '11:43');
    ui.setHandler(async (_url, init) => Response.json({ ...revoked, config: JSON.parse(init.body).config }));
    ui.find('data-multi-save').props.onClick(); await settle(); ui.render();
    const saved = JSON.parse(ui.calls.find(c => c.method === 'PUT').body);
    assert.equal(saved.revision, revoked.revision); assert.deepEqual(saved.config, revoked.config);
  } finally { ui.cleanup(); }
});
test('409 preserves exact multi draft with no retry or visual-settings write', async () => {
  const ui = fixture(); try { await load(ui); ui.find('data-multi-time').props.onChange({ target: { value: '10:12' } }); ui.setHandler(async () => Response.json({ error: '冲突' }, { status: 409 })); ui.find('data-multi-save').props.onClick(); await settle(); ui.render(); assert.equal(ui.find('data-multi-time').props.value, '10:12'); assert.match(ui.text(), /草稿保留/); assert.equal(ui.calls.filter(c => c.method === 'PUT').length, 1); } finally { ui.cleanup(); }
});
test('unmount aborts explicit catalogue read and no late result can issue a write', async () => {
  const ui = fixture(); await settle(); ui.render(); let release; ui.setHandler(() => new Promise(r => { release = r; })); ui.find('data-multi-read').props.onClick(); const pending = ui.calls.at(-1); ui.cleanup(); assert.equal(pending.signal.aborted, true); release(Response.json(initial())); await settle(); assert.equal(ui.calls.filter(c => c.url.endsWith('/multi-warmup')).length, 1);
});
async function invoke(handler, body, method = 'GET') {
  let code, headers, result; const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
  await handler({ method, headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { if (bytes) yield bytes; } }, { writeHead(c, h) { code = c; headers = h; }, end(value) { result = value; } });
  return { code, headers, data: result && /json/.test(headers?.['Content-Type']) ? JSON.parse(result) : null };
}
test('shared day arbitration is symmetric, conservative on future claims, and reloads legacy disk data', async t => {
  const now = new Date(2026, 9, 15, 9, 30).getTime(), day = localSchedule(now, '00:00').day;
  assert(multiBlocksLegacy({ paused: false, attempts: [{ day, attemptedAt: now }] }, now));
  assert(multiBlocksLegacy({ paused: false, attempts: [{ day: '2099-01-01', attemptedAt: now + 1000 }] }, now));
  assert(!multiBlocksLegacy({ paused: false, attempts: [] }, now));
  assert(legacyBlocksMulti({ keys: [], lastAttemptAt: now }, now));
  assert(legacyBlocksMulti({ keys: [`daily:${day}`], lastAttemptAt: 0 }, now));
  const root = await mkdtemp(join(tmpdir(), 'DshMultiLegacy-')); t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const file = join(root, 'warmup.json'); assert(readLegacyWarmup(file).readable);
  const first = { version: 1, keys: [], lastAttemptAt: now - 86_400_000 }; await writeFile(file, JSON.stringify(first));
  const stale = readLegacyWarmup(file); assert(!legacyBlocksMulti(stale.journal, now));
  await writeFile(file, JSON.stringify({ ...first, lastAttemptAt: now })); assert(legacyBlocksMulti(readLegacyWarmup(file).journal, now));
  await writeFile(file, '{bad'); assert.equal(readLegacyWarmup(file).readable, false);
  await writeFile(file, JSON.stringify({ ...first, lastAttemptAt: 'bad' })); assert.equal(readLegacyWarmup(file).readable, false);
});
async function desktopHost(t, { legacy = null, multiAttempt = false, enabled = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'DshMultiDesktop-')), old = process.env.LOCALAPPDATA, profile = process.env.DSH_PET_PROFILE;
  process.env.LOCALAPPDATA = root; process.env.DSH_PET_PROFILE = 'desktop';
  const dir = join(root, 'DshSimpleDesktopPet'); await mkdir(dir);
  const now = { value: new Date(2026, 9, 15, 9, 29, 30).getTime() }, due = now.value + 30_000;
  const accountKey = createHash('sha256').update('RAW').digest('hex').slice(0, 16), fullId = '~account:RAW:mock-model';
  const modelKey = createHash('sha256').update(fullId).digest('hex');
  const config = { enabled: true, time: '09:30', accounts: [{ accountKey, modelKey, enabled: true, allowUnverifiedQuota: true }] };
  const store = new MultiWarmupStore(join(dir, 'multi-warmup.json')); await store.configure(config, 'missing');
  if (multiAttempt) { await store.claim(config.accounts[0], localSchedule(now.value, '00:00').day, now.value, config); await store.finish(config.accounts[0], localSchedule(now.value, '00:00').day, 'succeeded', now.value); }
  if (!enabled) await store.configure({ ...config, enabled: false }, (await store.read()).revision);
  if (legacy !== null) await writeFile(join(dir, 'warmup.json'), typeof legacy === 'string' ? legacy : JSON.stringify(legacy));
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ ...DEFAULT_PREFERENCES, codexWarmupStartup: true }));
  const cleanups = [], routes = new Map(), intervals = []; let disposeBridge, releaseMetadata, streams = 0;
  const oldInterval = globalThis.setInterval; globalThis.setInterval = (fn, ms, ...rest) => { intervals.push({ fn, ms }); return oldInterval(fn, ms, ...rest); };
  t.after(async () => { globalThis.setInterval = oldInterval; for (const fn of cleanups.reverse()) await fn?.(); if (old === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = old; if (profile === undefined) delete process.env.DSH_PET_PROFILE; else process.env.DSH_PET_PROFILE = profile; await rm(root, { recursive: true, force: true }); });
  const bridge = { async fetch(req) { const body = await req.json(); const value = body.method === 'subscriptions-auth.status' ? { providers: { codex: { accounts: [{ key: 'RAW', isDefault: true }] } } } : { authenticated: false, accounts: [] }; return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }); } };
  const services = { effect(fn, label) { const cleanup = fn(); cleanups.push(cleanup); if (label?.includes('subscription bridge')) disposeBridge = cleanup; }, webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path); } }, connection: { requestRejection() {}, createSharedFetchHandler() { return bridge; } } };
  apply({ ...services, inject(_deps, fn) { fn(services); }, on() {}, get() { return null; }, settings: { describe() { return []; } }, credentials: { resolve() { assert.fail('private credentials'); } }, llm: { listConfigurableProviders() { return []; }, async listModels() { return [{ provider: 'codex', id: fullId }]; }, resolveModelInfo() { return new Promise(resolve => { releaseMetadata = resolve; }); }, stream() { streams++; return (async function* () { yield { type: 'text-delta', text: 'OK' }; yield { type: 'finish', reason: { kind: 'stop' } }; })(); } } }, { petLauncher() { return () => {}; }, switchSupported: () => true, warmupClock: () => now.value });
  const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('mock host did not reach expected phase'); };
  await until(() => routes.has('/api/dsh-plugin-simple-pet/state')); for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 5));
  return { store, routes, now, due, intervals, until, metadata: () => releaseMetadata, streamCount: () => streams, disposeBridge: () => disposeBridge(), state: () => invoke(routes.get('/api/dsh-plugin-simple-pet/state')) };
}
test('actual bridge disposal during independent preflight produces zero late model calls', async t => {
  const f = await desktopHost(t); f.now.value = f.due;
  for (const interval of f.intervals) interval.fn(); await f.until(() => !!f.metadata());
  f.disposeBridge(); f.metadata()({ reasoning: {} });
  for (let i = 0; i < 12; i++) await settle(); assert.equal(f.streamCount(), 0);
});
test('actual disabled-multi host does not resume single startup after a multi claim today', async t => {
  const f = await desktopHost(t, { multiAttempt: true, enabled: false });
  const state = (await f.state()).data; assert.match(state.codexWarmup.detail, /今天已有多账号认领/); assert.equal(f.streamCount(), 0); assert.equal(f.metadata(), undefined);
});
test('a corrupt shared legacy journal disables multi automation without rewriting it', async t => {
  const f = await desktopHost(t, { legacy: '{broken' }); f.now.value = f.due; for (const interval of f.intervals) interval.fn();
  for (let i = 0; i < 12; i++) await settle(); assert.equal(f.streamCount(), 0); assert.equal(f.metadata(), undefined);
});
test('actual host route is authenticated, read-only discovery uses exact public bindings, save sends no model or switch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'DshMultiHost-')), old = process.env.LOCALAPPDATA, profile = process.env.DSH_PET_PROFILE;
  process.env.LOCALAPPDATA = root; process.env.DSH_PET_PROFILE = 'web'; const routes = new Map(), cleanups = [], calls = []; let deny;
  const bridge = { async fetch(req) { const body = await req.json(); calls.push(body.method); assert(!/select|activate/.test(body.method)); const value = body.method === 'subscriptions-auth.status' ? { providers: { codex: { accounts: [{ key: 'PRIVATE_RAW_ACCOUNT', account: 'alice@example.invalid', isDefault: true }] } } } : { authenticated: false, accounts: [] }; return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }); } };
  const services = { effect(fn) { cleanups.push(fn()); }, webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path); } }, connection: { requestRejection() { return deny; }, createSharedFetchHandler() { return bridge; } } };
  const llm = { listConfigurableProviders() { return []; }, async listModels() { return [{ provider: 'codex', id: '~account:PRIVATE_RAW_ACCOUNT:mock-model', inputModalities: ['text'] }]; }, resolveModelInfo() { assert.fail('save/read must not resolve calls'); }, stream() { assert.fail('no actual models'); } };
  try {
    apply({ ...services, inject(_name, fn) { fn(services); }, on() {}, get() { return null; }, settings: { describe() { return []; } }, credentials: { resolve() { assert.fail('no credentials'); } }, llm }, { petLauncher() { return () => {}; }, switchSupported: () => true });
    for (let i = 0; i < 10; i++) await settle(); const handler = routes.get('/api/dsh-plugin-simple-pet/multi-warmup'); assert(handler); const before = calls.length;
    deny = 401; assert.equal((await invoke(handler)).code, 401); assert.equal(calls.length, before); deny = undefined;
    const read = await invoke(handler); assert.equal(read.code, 200); assert.equal(read.data.config.enabled, false); assert.equal(calls.length, before);
    const discovered = await invoke(handler, { action: 'discover' }, 'POST'); assert.equal(discovered.code, 200); assert.equal(discovered.data.accounts.length, 1); assert(!JSON.stringify(discovered.data).includes('PRIVATE_RAW_ACCOUNT')); assert(!JSON.stringify(discovered.data).includes('alice@example.invalid'));
    const discoveredRow = discovered.data.accounts[0]; const saved = await invoke(handler, { revision: read.data.revision, config: { enabled: true, time: '09:30', accounts: [{ accountKey: discoveredRow.accountKey, modelKey: discoveredRow.models[0].modelKey, enabled: true, allowUnverifiedQuota: false }] } }, 'PUT'); assert.equal(saved.code, 200);
    const file = join(root, 'DshSimpleDesktopPet', 'multi-warmup.json'), contents = await readFile(file, 'utf8'); assert(!contents.includes('PRIVATE_RAW_ACCOUNT')); assert(!contents.includes('alice@example.invalid')); assert(!contents.includes('a***@'));
    assert(!calls.some(method => /select|activate/.test(method))); // Existing ordinary quota polling is independent of this route.
  } finally {
    for (const fn of cleanups.reverse()) await fn?.(); if (old === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = old; if (profile === undefined) delete process.env.DSH_PET_PROFILE; else process.env.DSH_PET_PROFILE = profile;
    assert.equal(dirname(root), resolve(tmpdir())); assert(basename(root).startsWith('DshMultiHost-')); await rm(root, { recursive: true, force: true });
  }
});
