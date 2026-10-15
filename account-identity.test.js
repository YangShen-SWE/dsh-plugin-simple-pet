import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { selectedCodexAccount, maskCodexEmail, identityEvidence, accountIdentityHandler } from './codex-identity.js';
import { readCodexQuota } from './codex.js';
import { accountSummary, createSimplePetClient } from './client-source.js';
import { DEFAULT_PREFERENCES } from './preferences.js';
import { apply } from './index.js';
const NOW = Date.now(), KEY = 'a'.repeat(16);
const rawEmail = 'alice.private@example.com';
const dedicated = (id = 'secret-id') => ({ authenticated: true, accounts: [{ id, active: true, email: rawEmail, label: 'sensitive label' }, { id: 'second-id', active: false }] });
const general = account => ({ providers: { codex: { accounts: [{ key: 'first', isDefault: true, account }, { key: 'second' }] } } });
const usage = () => ({ fetchedAt: NOW, rateLimits: [{ id: 'codex', windows: [{ windowSeconds: 18000, remainingPercent: 82, resetsAt: Math.floor(NOW / 1000) + 2000 }] }] });
function bridge(values) {
  const calls = [];
  return { calls, async fetch(req) {
    const body = await req.json(); calls.push(body);
    const value = typeof values === 'function' ? await values(body, calls.length) : values[body.method];
    assert.match(body.method, /(?:\/status|\/usage|\.status|\.usage)$/);
    if (value === null) return new Response('', { status: 404 });
    return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } });
  } };
}
const signal = () => new AbortController().signal;
async function invoke(handler, req = {}) {
  let code, headers, body;
  await handler({ method: 'GET', ...req }, { writeHead(c, h) { code = c; headers = h; }, end(b) { body = b; } });
  return { code, headers, body, data: headers?.['Content-Type']?.includes('application/json') && body ? JSON.parse(body) : null };
}

test('identity mask rejects opaque IDs, raw labels, control characters and oversized inputs', () => {
  assert.equal(maskCodexEmail(rawEmail), 'a***@e***.com');
  assert.equal(maskCodexEmail('a@b.co'), 'a***@b***.co');
  for (const value of [null, {}, [], 3, 'opaque-id', 'Alice <a@b.com>', 'a@b.com\n', 'a\u202e@b.com', 'a@-b.com', 'a@b..com', 'x'.repeat(255) + '@b.com']) assert.equal(maskCodexEmail(value), null);
});
test('exactly one selected account, bounded valid unique rows and real source are required', () => {
  assert.equal(selectedCodexAccount(dedicated(), 'openai-codex').count, 2);
  const invalid = [ { authenticated: true }, { ...dedicated(), authenticated: false },
    { authenticated: true, accounts: [{ id: 'a', active: true }, { id: 'b', active: true }] },
    { authenticated: true, accounts: [{ id: 'a', active: true }, { id: 'a' }] },
    { authenticated: true, accounts: [{ active: true }] },
    { authenticated: true, accounts: [{ id: 'a\n', active: true }] } ];
  for (const value of invalid) assert.equal(selectedCodexAccount(value, 'openai-codex'), null);
  assert.equal(selectedCodexAccount(general('id-not-email'), 'codex').id, 'first');
});
test('quota and identity share one before/usage/after read; only masked email escapes callback', async () => {
  const fake = bridge({ 'codex-subscription/status': dedicated(), 'codex-subscription/usage': usage() });
  let identity; const q = await readCodexQuota(fake, signal(), NOW, 'openai-codex', { onIdentity(v) { identity = v; } });
  assert.equal(fake.calls.length, 3); assert.equal(q.accountCount, 2);
  assert.equal(q.selection, 'active'); assert.equal(identity.accountKey, q.accountKey);
  assert.equal(identity.maskedEmail, 'a***@e***.com');
  assert.doesNotMatch(JSON.stringify(q), /email|alice|sensitive|secret-id|a\*\*\*/);
  assert.doesNotMatch(JSON.stringify(identity), /alice|sensitive|secret-id/);
  assert.equal(identityEvidence(q, identity, NOW).status, 'ready');
});
test('fallback is explicitly default and opaque account IDs are not invented emails', async () => {
  for (const [account, maskedEmail] of [[rawEmail, 'a***@e***.com'], ['opaque-id', null], [undefined, null]]) {
    const fake = bridge({ 'codex-subscription/status': null, 'subscriptions-auth.status': general(account),
      'subscriptions-auth.usage': { supported: true, windows: [{ kind: 'session', usedPercent: 30, resetsAt: NOW + 30000 }] } });
    let identity; const q = await readCodexQuota(fake, signal(), NOW, 'openai-codex', { onIdentity(v) { identity = v; } });
    assert.equal(identity.maskedEmail, maskedEmail); assert.equal(q.selection, 'default');
    assert.equal(q.provider, 'codex'); assert.equal(q.observedAt, null); assert.equal(fake.calls.length, 4);
  }
});
test('mid-read switch, invalid selection, sign-out and missing interfaces publish no identity', async () => {
  for (const values of [(_body, n) => n === 2 ? usage() : dedicated(n === 1 ? 'a' : 'b'),
    { 'codex-subscription/status': { authenticated: false } }, { 'codex-subscription/status': { authenticated: true, accounts: [{ active: true }] } }, () => null]) {
    let identity = null; const q = await readCodexQuota(bridge(values), signal(), NOW, 'openai-codex', { onIdentity(v) { identity = v; } });
    assert.equal(identity, null); assert.equal(q.fiveHour, null);
  }
});
test('identity leases fail closed on mismatch, expiry, logout, unavailable or expired quota', () => {
  const q = { status: 'ready', provider: 'openai-codex', selection: 'active', accountKey: KEY, observedAt: NOW, fiveHour: { resetAt: NOW + 300000 } };
  const identity = { provider: q.provider, selection: q.selection, accountKey: KEY, maskedEmail: 'a***@e***.com', checkedAt: NOW };
  assert.equal(identityEvidence(q, identity, NOW + 119999).validForMs, 1);
  for (const [quota, id, now] of [[q, identity, NOW + 120000], [q, { ...identity, checkedAt: NOW + 1 }, NOW],
    [{ ...q, accountKey: 'b'.repeat(16) }, identity, NOW], [{ ...q, provider: 'codex' }, identity, NOW],
    [{ ...q, status: 'stale' }, identity, NOW], [{ ...q, fiveHour: { resetAt: NOW } }, identity, NOW], [q, null, NOW]]) {
    assert.deepEqual(identityEvidence(quota, id, now), { status: 'unavailable' });
  }
});
test('account route is authenticated, no-store, read-only and never triggers upstream', async () => {
  let reads = 0, allow = true;
  const handler = accountIdentityHandler({ authorize(req, res) { if (allow) return true; res.writeHead(403, {}); res.end(); return false; }, read() { reads++; return { status: 'unavailable' }; } });
  const get = await invoke(handler); assert.equal(get.code, 200); assert.equal(get.headers['Cache-Control'], 'no-store');
  assert.equal(get.headers['X-Content-Type-Options'], 'nosniff'); assert.equal((await invoke(handler, { method: 'HEAD' })).body, undefined);
  const before = reads;
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await invoke(handler, { method })).code, 405);
  assert.equal(reads, before); allow = false; assert.equal((await invoke(handler)).code, 403); assert.equal(reads, before);
});
test('frontend cannot confuse different sources/accounts or expose arbitrary upstream strings', () => {
  const q = { status: 'ready', provider: 'openai-codex', selection: 'active', accountKey: KEY };
  const id = { status: 'ready', ...q, maskedEmail: 'a***@e***.com', validForMs: 1000 };
  const good = accountSummary({ codex: q }, id); assert.match(good, /激活账号/); assert.match(good, /a\*\*\*@e\*\*\*.com/);
  assert.match(accountSummary({ codex: { ...q, provider: 'codex', selection: 'default' } }, { ...id, provider: 'codex', selection: 'default' }), /Pool/);
  assert.match(accountSummary({ codex: q }, { ...id, maskedEmail: rawEmail }), /邮箱未提供/);
  for (const [quota, identity, elapsed] of [[{ ...q, accountKey: 'b'.repeat(16) }, id, 0], [q, id, 1000], [q, id, -1], [q, { ...id, provider: 'codex' }, 0], [q, null, 0]]) assert.doesNotMatch(accountSummary({ codex: quota }, identity, elapsed), /a\*\*\*@/);
});

function harness(send) {
  const cells = [], cleanups = []; let index = 0, tree;
  const React = { createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat().filter(x => x !== null && x !== undefined && x !== false) }; },
    useState(initial) { const i = index++; if (!(i in cells)) cells[i] = initial; return [cells[i], next => { cells[i] = typeof next === 'function' ? next(cells[i]) : next; }]; },
    useRef(initial) { const i = index++; return cells[i] ??= { current: initial }; },
    useEffect(fn) { const i = index++; if (!(i in cells)) { cells[i] = true; cleanups.push(fn()); } } };
  const plugin = createSimplePetClient(React, send), render = () => { index = 0; return tree = plugin.SimplePetSettings(); };
  const nodes = (n = tree) => n && typeof n === 'object' ? [n, ...n.children.flatMap(nodes)] : [];
  const text = n => n && typeof n === 'object' ? n.children.map(text).join('') : String(n ?? '');
  render(); return { render, nodes, text, cleanup() { cleanups.forEach(fn => fn?.()); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('settings has a local-only independent account display, no fake switch action or new timer', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); let elapsed = 0; t.mock.method(performance, 'now', () => elapsed);
  const calls = [], q = { status: 'ready', provider: 'openai-codex', selection: 'active', accountKey: KEY };
  let stall = false;
  const ui = harness(async (url, init) => {
    calls.push({ url, ...init }); if (stall) return new Promise(() => {});
    if (url.endsWith('/preferences')) return Response.json({ values: { ...DEFAULT_PREFERENCES, billingMode: 'codex' }, revision: 'a'.repeat(64) });
    if (url.endsWith('/state')) return Response.json({ codex: q });
    if (url.endsWith('/account')) return Response.json({ ...q, status: 'ready', maskedEmail: 'a***@e***.com', validForMs: 1000 });
    return Response.json({ status: 'offline' });
  });
  try {
    await settle(); ui.render(); const row = () => ui.nodes().find(n => n.props['data-account-identity']);
    assert.match(ui.text(row()), /a\*\*\*@/); assert.match(ui.text(ui.render()), /至少两个有效 Codex 账号/);
    assert.equal(calls.length, 4); assert(calls.every(c => !c.method || c.method === 'GET'));
    assert(!ui.nodes().some(n => n.type === 'button' && /切换账号/.test(ui.text(n))));
    stall = true; elapsed = 1100; t.mock.timers.tick(5000); await settle(); ui.render(); assert.doesNotMatch(ui.text(row()), /a\*\*\*@/);
    const count = calls.length; t.mock.timers.tick(5000); await settle(); assert.equal(calls.length, count, 'no overlapping local polls');
  } finally { ui.cleanup(); }
});

test('actual backend keeps even masked email out of every persisted snapshot/ledger and state API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'DshAccountIdentity-'));
  const oldRoot = process.env.LOCALAPPDATA, oldProfile = process.env.DSH_PET_PROFILE;
  process.env.LOCALAPPDATA = root; process.env.DSH_PET_PROFILE = 'web';
  const routes = new Map(), cleanups = [], events = new Map(); let rejected;
  const fake = bridge({ 'codex-subscription/status': dedicated(), 'codex-subscription/usage': usage() });
  const services = { effect(fn) { cleanups.push(fn()); }, webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path); } },
    connection: { requestRejection() { return rejected; }, createSharedFetchHandler() { return fake; } } };
  const data = join(root, 'DshSimpleDesktopPet'); await mkdir(data); await writeFile(join(data, 'settings.json'), JSON.stringify(DEFAULT_PREFERENCES));
  try {
    apply({ ...services, on(name, fn) { events.set(name, fn); }, inject(_names, fn) { fn(services); }, settings: { describe() { return []; } }, get() { return null; },
      llm: { listConfigurableProviders() { return []; }, stream() { assert.fail('no model calls'); } }, credentials: { resolve() { assert.fail('no credentials'); } } }, { petLauncher() { return () => {}; } });
    for (let i = 0; i < 30 && fake.calls.length < 3; i++) await settle();
    const account = routes.get('/api/dsh-plugin-simple-pet/account'), state = routes.get('/api/dsh-plugin-simple-pet/state');
    const identity = await invoke(account); assert.equal(identity.data.maskedEmail, 'a***@e***.com');
    const count = fake.calls.length; for (let i = 0; i < 5; i++) await invoke(account); assert.equal(fake.calls.length, count);
    rejected = 401; assert.equal((await invoke(account)).code, 401); rejected = undefined;
    assert.equal((await invoke(account, { method: 'POST' })).code, 405);
    const stateBody = (await invoke(state)).body; assert.doesNotMatch(stateBody, /alice|sensitive|a\*\*\*|maskedEmail|secret-id/);
    // A provider transition immediately clears the memory-only identity before the new async read completes.
    events.get('session/event')({ id: 'test' }, { seq: 1, type: 'assistant/message', time: new Date().toISOString(), data: { message: { source: { kind: 'model', provider: 'codex', model: 'test' } } } });
    assert.equal((await invoke(account)).data.status, 'unavailable');
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup?.();
    for (const file of await readdir(data)) {
      const text = await readFile(join(data, file), 'utf8'); assert.doesNotMatch(text, /alice|sensitive|a\*\*\*|maskedEmail|secret-id/);
    }
    if (oldRoot === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = oldRoot;
    if (oldProfile === undefined) delete process.env.DSH_PET_PROFILE; else process.env.DSH_PET_PROFILE = oldProfile;
    assert(root.startsWith(join(tmpdir(), 'DshAccountIdentity-'))); await rm(root, { recursive: true, force: true });
  }
});

test('native account labels preserve real WPF layout in classic and compact modes', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', join(import.meta.dirname, 'account-identity.test.ps1')], { stdio: 'inherit' });
  assert.equal(result.status, 0);
});
