import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DEFAULT_PREFERENCES, PreferencesStore } from './preferences.js';
import { applicationEvidence, applicationHandler, readApplicationReceipt } from './preferences-applied.js';
import { applicationStatus, applicationSummary, createSimplePetClient } from './client-source.js';
import { apply, launchPetProcess } from './index.js';

const now = 1_900_000_000_000;
const runId = '12345678-1234-1234-1234-123456789abc';
const runtime = { active: true, runId, pid: 4321 };
const preferences = { values: { ...DEFAULT_PREFERENCES }, revision: 'a'.repeat(64) };
const receipt = extra => ({ version: 1, status: 'applied', profile: 'desktop', runId, pid: 4321,
  revision: preferences.revision, values: { ...preferences.values }, appliedAt: now - 3000, heartbeatAt: now - 1000, ...extra });
const evidence = (extra, run = runtime, profile = 'desktop', saved = preferences) => applicationEvidence(saved, receipt(extra), run, profile, now);
async function invoke(handler, req = {}) {
  let code, headers, body;
  await handler({ method: 'GET', ...req }, { writeHead(c, h) { code = c; headers = h; }, end(b) { body = b; } });
  return { code, headers, body, data: body && headers?.['Content-Type']?.startsWith('application/json') ? JSON.parse(body) : undefined };
}
function handler(options = {}) {
  return applicationHandler({ store: { async read() { return preferences; } }, receiptFile: 'unused', profile: 'desktop',
    runtime: () => runtime, authorize: () => true, clock: () => now, readReceipt: async () => receipt(), ...options });
}

test('receipt confirms only owned running process and matching saved effective preferences', () => {
  assert.deepEqual(evidence(), { revision: preferences.revision, status: 'applied', observedAt: now,
    appliedAt: now - 3000, heartbeatAt: now - 1000, validForMs: 14000 });
  assert.equal(evidence({ status: 'pending', values: undefined, revision: undefined }).status, 'pending');
});
test('old runs, profiles, process exits, missing versions and forged identities never confirm', () => {
  for (const extra of [{ runId: randomUUID() }, { pid: 4322 }, { pid: '4321' }, { profile: 'web' },
    { version: 2 }, { version: '1' }, { status: 'saved' }, { revision: 'b'.repeat(64) }]) assert.notEqual(evidence(extra).status, 'applied');
  for (const run of [null, {}, { ...runtime, active: false }, { ...runtime, pid: 0 }, { ...runtime, pid: '4321' },
    { ...runtime, runId: 'invalid' }]) assert.equal(evidence({}, run).status, 'offline');
  assert.notEqual(evidence({}, runtime, 'web').status, 'applied');
  assert.notEqual(evidence({}, runtime, 'desktop', { ...preferences, revision: 'missing' }).status, 'applied');
});
test('expired, future, nonsensical and fractional timestamps fail closed', () => {
  for (const heartbeatAt of [now - 15001, now + 1, 0, null, String(now), now - .5, Infinity]) assert.notEqual(evidence({ heartbeatAt }).status, 'applied');
  for (const appliedAt of [now + 1, now, 0, '123', now - .5]) assert.notEqual(evidence({ appliedAt }).status, 'applied');
  assert.notEqual(evidence({ heartbeatAt: now - 15000 }).status, 'applied');
  assert.equal(evidence({ heartbeatAt: now - 14999, appliedAt: now - 16000 }).validForMs, 1);
});
test('same raw revision is insufficient when PowerShell effective normalization differs', () => {
  for (const values of [{ ...preferences.values, sleepMinutes: 240 }, { ...preferences.values, skin: 'NIGHT' },
    { ...preferences.values, quietMode: 0 }, { ...preferences.values, left: 123 }, [], null, {}]) assert.notEqual(evidence({ values }).status, 'applied');
});
test('authenticated route is read only, no-store, HEAD safe and rejects before reading', async () => {
  const result = await invoke(handler()); assert.equal(result.code, 200); assert.equal(result.data.status, 'applied');
  assert.equal(result.headers['Cache-Control'], 'no-store'); assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal((await invoke(handler(), { method: 'HEAD' })).body, undefined);
  let reads = 0;
  const store = { async read() { reads++; return preferences; } };
  assert.equal((await invoke(handler({ store }), { method: 'PUT' })).code, 405); assert.equal(reads, 0);
  const denied = handler({ store, authorize(_req, res) { res.writeHead(403, {}); res.end(); return false; } });
  assert.equal((await invoke(denied)).code, 403); assert.equal(reads, 0);
});
test('concurrent preference replacement or process transition cannot upgrade old evidence', async () => {
  let reads = 0;
  const changing = handler({ store: { async read() { return reads++ ? { ...preferences, revision: 'b'.repeat(64) } : preferences; } } });
  const result = (await invoke(changing)).data; assert.equal(result.revision, 'b'.repeat(64)); assert.equal(result.status, 'unconfirmed');
  let runs = 0;
  assert.equal((await invoke(handler({ runtime: () => runs++ ? { ...runtime, active: false } : runtime }))).data.status, 'offline');
  runs = 0;
  assert.notEqual((await invoke(handler({ runtime: () => runs++ ? { ...runtime, runId: randomUUID() } : runtime }))).data.status, 'applied');
});
test('bounded receipt reader and real raw BOM revision preserve local bytes without writes', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'DshApplicationReceipt-'));
  try {
    const settings = join(root, 'settings.json'), applied = join(root, 'receipt.json');
    const bytes = Buffer.from('\uFEFF' + JSON.stringify({ ...DEFAULT_PREFERENCES, external: 'preserve', left: 321 }) + '\r\n');
    await fs.writeFile(settings, bytes); const store = new PreferencesStore(settings); const saved = await store.read();
    assert.equal(saved.revision, createHash('sha256').update(bytes).digest('hex'));
    await fs.writeFile(applied, '\uFEFF' + JSON.stringify(receipt({ revision: saved.revision })));
    const result = await invoke(handler({ store, receiptFile: applied, readReceipt: readApplicationReceipt }));
    assert.equal(result.data.status, 'applied'); assert.deepEqual(await fs.readFile(settings), bytes);
    for (const invalid of ['{broken', '[1]', ' '.repeat(32769)]) {
      await fs.writeFile(applied, invalid); assert.notEqual((await invoke(handler({ store, receiptFile: applied, readReceipt: readApplicationReceipt }))).data.status, 'applied');
    }
    assert.equal(await readApplicationReceipt(join(root, 'missing.json')), null);
    assert.equal(await readApplicationReceipt(root), null);
    await fs.writeFile(settings, '{broken'); assert.equal((await invoke(handler({ store }))).code, 503);
    assert.equal(await fs.readFile(settings, 'utf8'), '{broken');
  } finally {
    // This is the exact private directory returned by mkdtemp, never user data.
    assert.ok(root.startsWith(join(tmpdir(), 'DshApplicationReceipt-'))); await fs.rm(root, { recursive: true, force: true });
  }
});
test('launcher owns run nonce and requires spawn event, clears evidence on error exit and stop', () => {
  const child = new EventEmitter(); child.pid = 4321; child.exitCode = null; child.killed = false;
  child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {}; child.unref = () => {}; child.kill = () => { child.killed = true; };
  let args;
  const stop = launchPetProcess({ platform: 'win32', profile: 'desktop', runId,
    spawnProcess(_exe, argv) { args = argv; return child; } });
  assert.equal(args[args.indexOf('-PetRunId') + 1], runId);
  assert.equal(stop.applicationRuntime().active, false); child.emit('spawn'); assert.equal(stop.applicationRuntime().active, true);
  child.emit('error', new Error('fixture')); assert.equal(stop.applicationRuntime().active, false);
  child.emit('spawn'); assert.equal(stop.applicationRuntime().active, false, 'late spawn cannot revive failed child');
  child.emit('exit', 0); assert.equal(stop.applicationRuntime().active, false);
  child.emit('spawn'); stop(); assert.equal(stop.applicationRuntime().active, false); assert.equal(child.killed, true);
  assert.equal(launchPetProcess({ platform: 'linux' }).applicationRuntime, undefined);
  assert.equal(launchPetProcess({ platform: 'win32', profile: 'web' }).applicationRuntime, undefined);
});
test('real backend registers guarded receipt route and binds only its own launcher instance', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'DshApplicationBackend-'));
  const oldRoot = process.env.LOCALAPPDATA, oldProfile = process.env.DSH_PET_PROFILE;
  process.env.LOCALAPPDATA = root; process.env.DSH_PET_PROFILE = 'desktop';
  const disposers = [], routes = new Map(); let args, running = true, rejected;
  const services = { effect(fn) { disposers.push(fn()); }, connection: { requestRejection() { return rejected; } },
    webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path); } } };
  const ctx = { ...services, on() {}, inject(_names, callback) { callback(services); },
    settings: { describe() { return []; } }, get() { return null; },
    llm: { listConfigurableProviders() { return []; }, stream() { assert.fail('no model calls'); } },
    credentials: { resolve() { assert.fail('no credential reads'); } } };
  try {
    const data = join(root, 'DshSimpleDesktopPet'); await fs.mkdir(data, { recursive: true });
    const settings = join(data, 'settings.json'); await fs.writeFile(settings, JSON.stringify(DEFAULT_PREFERENCES));
    apply(ctx, { panelStarter: async () => ({ url: 'http://127.0.0.1:1/panel', token: 'a'.repeat(64), close() {} }), petLauncher(options) { args = options; const stop = () => { running = false; };
      stop.applicationRuntime = () => ({ active: running, pid: 4321, runId: options.runId }); return stop; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.match(args.runId, /^[a-f0-9-]{36}$/);
    const store = new PreferencesStore(settings), saved = await store.read(), time = Date.now();
    await fs.writeFile(join(data, 'settings-applied-desktop.json'), JSON.stringify(receipt({ runId: args.runId,
      revision: saved.revision, appliedAt: time - 100, heartbeatAt: time - 50 })));
    const route = routes.get('/api/dsh-plugin-simple-pet/application'); assert.equal(typeof route, 'function');
    assert.equal((await invoke(route)).data.status, 'applied');
    rejected = 401; assert.equal((await invoke(route)).code, 401); rejected = undefined;
    running = false; assert.equal((await invoke(route)).data.status, 'offline');
    assert.equal((await invoke(route, { method: 'POST' })).code, 405);
  } finally {
    for (const dispose of disposers.reverse()) await dispose?.();
    if (oldRoot === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = oldRoot;
    if (oldProfile === undefined) delete process.env.DSH_PET_PROFILE; else process.env.DSH_PET_PROFILE = oldProfile;
    assert.ok(root.startsWith(join(tmpdir(), 'DshApplicationBackend-'))); await fs.rm(root, { recursive: true, force: true });
  }
});

test('frontend wording never treats draft save, mismatched revision or expired lease as applied', () => {
  const valid = { revision: preferences.revision, status: 'applied', validForMs: 12000 };
  assert.match(applicationSummary(preferences.revision, valid), /最近确认桌宠已应用/);
  assert.match(applicationSummary(preferences.revision, valid, true), /草稿尚未应用/);
  for (const [revision, data, elapsed] of [['b'.repeat(64), valid, 0], ['missing', valid, 0],
    [preferences.revision, { ...valid, validForMs: 0 }, 0], [preferences.revision, valid, 12001],
    [preferences.revision, valid, -1], [preferences.revision, null, 0], [preferences.revision, { ...valid, status: 'saved' }, 0]]) {
    assert.doesNotMatch(applicationSummary(revision, data, false, elapsed), /最近确认桌宠已应用/);
    assert.notEqual(applicationStatus(revision, data, elapsed), 'applied');
  }
});

function uiHarness(send) {
  const cells = [], cleanups = []; let index = 0, tree;
  const React = { createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat().filter(x => x !== null && x !== undefined && x !== false) }; },
    useState(initial) { const i = index++; if (!(i in cells)) cells[i] = initial; return [cells[i], next => { cells[i] = typeof next === 'function' ? next(cells[i]) : next; }]; },
    useRef(initial) { const i = index++; return cells[i] ??= { current: initial }; },
    useEffect(fn) { const i = index++; if (!(i in cells)) { cells[i] = true; cleanups.push(fn()); } } };
  const plugin = createSimplePetClient(React, send);
  const render = () => { index = 0; return tree = plugin.SimplePetSettings(); };
  const nodes = (n = tree) => n && typeof n === 'object' ? [n, ...n.children.flatMap(nodes)] : [];
  const text = n => n && typeof n === 'object' ? n.children.map(text).join('') : String(n ?? '');
  render(); return { render, nodes, text, cleanup() { cleanups.forEach(fn => fn?.()); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('settings polls local receipt, clears save evidence and preserves drafts on unavailable old host', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let elapsed = 0; t.mock.method(performance, 'now', () => elapsed);
  const calls = []; let revision = preferences.revision, proof = 'applied', fail = false, stall = false;
  const ui = uiHarness(async (url, init) => {
    calls.push({ url, ...init });
    if (stall) return new Promise(() => {});
    if (url.endsWith('/application')) {
      if (fail) return Response.json({ error: 'old host' }, { status: 404 });
      return Response.json({ revision, status: proof, validForMs: 14000 });
    }
    if (url.endsWith('/state')) return Response.json({ stats: { days: {} } });
    if (init.method === 'PUT') revision = 'b'.repeat(64);
    return Response.json({ ...preferences, revision });
  });
  const status = () => ui.nodes().find(n => Object.hasOwn(n.props, 'data-application-status'));
  try {
    await settle(); ui.render(); assert.match(ui.text(status()), /最近确认桌宠已应用/);
    assert.deepEqual(calls.map(c => c.url).sort(), ['api/dsh-plugin-simple-pet/account','api/dsh-plugin-simple-pet/application','api/dsh-plugin-simple-pet/preferences','api/dsh-plugin-simple-pet/state']);
    ui.nodes().find(n => n.props.name === 'quietMode').props.onChange({ target: { checked: true } });
    ui.render(); assert.match(ui.text(status()), /草稿尚未应用/);
    ui.nodes().find(n => n.type === 'form').props.onSubmit({ preventDefault() {} });
    await settle(); ui.render(); assert.doesNotMatch(ui.text(status()), /最近确认桌宠已应用/);
    proof = 'pending'; t.mock.timers.tick(5000); await settle(); ui.render(); assert.match(ui.text(status()), /尚在应用/);
    fail = true; t.mock.timers.tick(5000); await settle(); ui.render(); assert.doesNotMatch(ui.text(status()), /最近确认桌宠已应用/);
    assert.equal(calls.filter(c => c.method === 'PUT').length, 1);
    assert.ok(!calls.some(c => /subscription|llm|stream|warmup/.test(c.url)));
    fail = false; proof = 'applied'; t.mock.timers.tick(5000); await settle(); ui.render();
    assert.equal(status().props['data-application-status'], 'applied');
    stall = true; t.mock.timers.tick(5000); await settle();
    const stalledCalls = calls.length; elapsed = 15000; t.mock.timers.tick(5000); ui.render();
    assert.equal(calls.length, stalledCalls, 'stalled local refresh does not overlap');
    assert.equal(status().props['data-application-status'], 'unconfirmed');
    assert.doesNotMatch(ui.text(status()), /最近确认桌宠已应用/);
  } finally { ui.cleanup(); }
});
test('native application receipt boundary and atomic writer checks', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', join(import.meta.dirname, 'preferences-applied.test.ps1')],
    { cwd: import.meta.dirname, stdio: 'inherit' });
  assert.ifError(result.error); assert.equal(result.status, 0);
});
