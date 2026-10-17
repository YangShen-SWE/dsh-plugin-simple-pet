import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { AccountDirectory, createAccountService, hash, isAccountError } from './codex-accounts/service.js';
import { createBoundAdapter } from './codex-accounts/official-driver.js';
import { accountServiceFetchHandler } from './codex-accounts/index.js';
import { officialAccountRpc, officialAccountsProxy } from './official-accounts.js';
import { accountQuotaPresentation, accountCredentialSummary, createSimplePetClient } from './client-source.js';
import { DEFAULT_PREFERENCES } from './preferences.js';
import { setTimeout as pause } from 'node:timers/promises';

const NOW = 1_790_000_000_000;
const token = id => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: id } })).toString('base64url')}.MOCK_SIGNATURE`;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'DshAccountManagement-'));
  const directory = new AccountDirectory(path.join(root, 'directory.json')), records = new Map(), hooks = {}, calls = { network: 0, streams: 0, deleted: [], prepared: [] };
  const rows = ['A', 'B'].map((label, i) => ({ key: (i ? 'b' : 'a').repeat(16), label, epoch: 1, revoked: false, bound: true, identityHash: hash(`SYNTHETIC_${label}`) }));
  for (const row of rows) records.set(`codex-accounts/account-${row.key}`, { kind: 'grant', payload: { type: 'oauth', access: token(`SYNTHETIC_${row.label}`), refresh: 'MOCK_REFRESH_DO_NOT_EXPOSE', accountId: `SYNTHETIC_${row.label}`, expires: NOW + 3600000 } });
  await directory.update(data => { data.rows = rows; data.defaultKey = rows[0].key; });
  const credentials = {
    async readRecord(key) { if (hooks.read) await hooks.read(key); return structuredClone(records.get(key)); },
    async modifyRecord() { throw new Error('Unexpected grant mutation in management test'); },
    async deleteRecord(key) { if (hooks.delete) await hooks.delete(key); calls.deleted.push(key); records.delete(key); },
  };
  const service = createAccountService({ directory, credentials, clock: () => NOW,
    fetchImpl: async () => { calls.network++; throw new Error('REAL_NETWORK_FORBIDDEN'); },
    driver: async ({ credentials: store }) => {
      if (hooks.driver) return hooks.driver(store);
      const grant = await store.read('openai-codex'), identity = grant?.accountId;
      return {
        async refreshModels() { /* Synthetic catalogue; never fetches upstream. */ },
        async listModels() { if (hooks.models) await hooks.models(identity); return [{ id: 'codex-mini', name: 'Synthetic mini' }]; },
        async prepare(id) { calls.prepared.push(identity); return { model: { provider: 'openai-codex', id, name: 'Synthetic mini' }, stream: () => (async function* () { calls.streams++; throw new Error('No model invocation in management tests'); })() }; },
      };
    },
  });
  t.after(async () => {
    await service.dispose();
    assert.equal(calls.network, 0); assert.equal(calls.streams, 0);
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('DshAccountManagement-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, directory, records, rows, hooks, calls, service, key: i => rows[i].identityHash.slice(0, 16), record: i => `codex-accounts/account-${rows[i].key}` };
}
async function invoke(handler, body) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]); req.method = body === undefined ? 'GET' : 'POST'; req.headers = { 'content-type': 'application/json' };
  let status, data;
  await handler(req, { writeHead(code) { status = code; }, end(value) { data = value ? JSON.parse(value) : undefined; } });
  return { status, data };
}

for (const failed of [0, 1]) test(`account-local lost grant ${failed} preserves the other fixed picker and never changes default or routes`, async t => {
  const f = await fixture(t), before = await fs.readFile(f.directory.file, 'utf8');
  f.hooks.models = async identity => { if (identity === `SYNTHETIC_${f.rows[failed].label}`) f.records.delete(f.record(failed)); };
  const bindings = await f.service.bindings(), bad = bindings.accounts.find(row => row.accountKey === f.key(failed)), good = bindings.accounts.find(row => row.accountKey === f.key(1 - failed));
  assert.deepEqual(bad.models, []); assert.equal(bad.credentialStatus, 'missing'); assert.equal(bad.modelError, 'OAUTH_REQUIRED'); assert.equal(good.models.length, 1);
  assert.equal(await fs.readFile(f.directory.file, 'utf8'), before);
  const adapter = createBoundAdapter(f.service), routes = await adapter.listModels();
  assert(routes.some(row => row.id.startsWith(`${f.key(1 - failed)}:`))); assert(!routes.some(row => row.id.startsWith(`${f.key(failed)}:`)));
  if (failed === 0) assert(!routes.some(row => row.id.startsWith('default:')));
  await assert.rejects(f.service.prepareSlug(f.key(failed), 'codex-mini'), /OAUTH_REQUIRED/);
  await f.service.prepareSlug(f.key(1 - failed), 'codex-mini'); assert.deepEqual(f.calls.prepared, [`SYNTHETIC_${f.rows[1 - failed].label}`]);
});

for (const [kind, expected] of [['missing', 'missing'], ['bad-jwt', 'invalid'], ['other-identity', 'identity-mismatch']]) test(`catalogue exposes only local credential status: ${kind}`, async t => {
  const f = await fixture(t);
  if (kind === 'missing') f.records.delete(f.record(0));
  else {
    const record = f.records.get(f.record(0));
    if (kind === 'bad-jwt') record.payload.access = 'PRIVATE_ACCESS_INVALID';
    else { record.payload.accountId = 'OTHER_PRIVATE_ACCOUNT'; record.payload.access = token(record.payload.accountId); }
  }
  const data = await f.service.catalogue(), a = data.accounts.find(row => row.accountKey === f.key(0)), b = data.accounts.find(row => row.accountKey === f.key(1));
  assert.equal(a.bound, false); assert.equal(a.credentialStatus, expected); assert.equal(b.bound, true); assert.equal(b.credentialStatus, 'available');
  assert(!/PRIVATE_ACCESS|MOCK_REFRESH|OTHER_PRIVATE_ACCOUNT|SYNTHETIC_|identityHash|recordKey|stack/.test(JSON.stringify(data)));
});

test('shared credential failures are not converted into eight allegedly broken accounts', async t => {
  const f = await fixture(t), sentinel = new Error('PRIVATE_TOKEN user@example.test original-account-id');
  f.hooks.read = async () => { throw sentinel; };
  await assert.rejects(f.service.catalogue(), error => error === sentinel);
  const handler = accountServiceFetchHandler(f.service), response = await handler(new Request('http://localhost/api/dsh-plugin-codex-accounts'));
  assert.equal(response.status, 503); assert(!/PRIVATE_TOKEN|example|original-account/.test(await response.text()));
});

for (const message of ['OAUTH_REQUIRED', 'MODEL_CATALOG_UNAVAILABLE', 'SUBSCRIPTION_DRIVER_REQUIRED', 'MODULE_NOT_FOUND']) test(`unbranded driver failure remains global: ${message}`, async t => {
  const f = await fixture(t), sentinel = Object.assign(new Error(message), { code: message });
  f.hooks.driver = async () => { throw sentinel; };
  await assert.rejects(f.service.bindings(), error => error === sentinel && !isAccountError(error));
});

test('a corrupt directory fails globally, never reports an empty successful catalogue', async t => {
  const f = await fixture(t); await fs.writeFile(f.directory.file, '{broken synthetic JSON');
  await assert.rejects(f.service.catalogue(), /DIRECTORY_UNAVAILABLE/); await assert.rejects(f.service.bindings(), /DIRECTORY_UNAVAILABLE/);
});

test('late local credential read after disposal rejects instead of publishing missing bindings', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.hooks.read = async key => { if (key === f.record(0)) { entered.resolve(); await release.promise; } };
  const pending = f.service.catalogue(); await entered.promise; await f.service.dispose(); release.resolve();
  await assert.rejects(pending, /SERVICE_CLOSED/);
});

test('confirmed concurrent revocation skips only the revoked row; no stale default route revives', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.hooks.models = async identity => { if (identity === 'SYNTHETIC_A') { entered.resolve(); await release.promise; } };
  const pending = f.service.bindings(); await entered.promise; await f.service.remove(f.key(0)); release.resolve();
  const result = await pending; assert.equal(result.accounts.length, 1); assert.equal(result.accounts[0].accountKey, f.key(1)); assert.equal((await f.service.catalogue()).defaultKey, null);
});

test('disposal while model discovery is pending remains a global failure', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.hooks.models = async () => { entered.resolve(); await release.promise; };
  const pending = f.service.bindings(); await entered.promise; await f.service.dispose(); release.resolve();
  await assert.rejects(pending, /SERVICE_CLOSED/);
});

test('public removal requires current generation and does not reset identity or select another account', async t => {
  const f = await fixture(t), old = await f.service.catalogue();
  await f.directory.update(data => { data.rows[1].label = 'B newer'; });
  await assert.rejects(f.service.remove(f.key(0), old.generation), /SOURCE_CHANGED/); assert.deepEqual(f.calls.deleted, []);
  assert.equal((await f.directory.read()).rows[0].revoked, false);
  const fresh = await f.service.catalogue(); await f.service.remove(f.key(0), fresh.generation);
  const data = await f.directory.read(); assert.equal(data.defaultKey, null); assert.equal(data.rows[0].identityHash, f.rows[0].identityHash); assert.equal(data.rows[0].epoch, 2); assert.equal(data.rows[1].revoked, false); assert.deepEqual(f.calls.deleted, [f.record(0)]);
});

test('credential cleanup failure does not undo an already durable local revocation', async t => {
  const f = await fixture(t), data = await f.service.catalogue(); f.hooks.delete = async () => { throw new Error('PRIVATE_DELETE_ERROR'); };
  await assert.rejects(f.service.remove(f.key(0), data.generation), /PRIVATE_DELETE_ERROR/);
  const current = await f.service.catalogue(); assert.equal(current.defaultKey, null); assert(!current.accounts.some(row => row.accountKey === f.key(0)));
  assert.equal((await f.directory.read()).rows[0].revoked, true);
});

test('real service → Fetch RPC → proxy preserves SOURCE_CHANGED 409 and strips private errors', async t => {
  const f = await fixture(t), read = await f.service.models(f.key(0)), handler = accountServiceFetchHandler(f.service);
  const bridge = { fetch: request => handler(request) }, proxy = officialAccountsProxy({ bridge: () => bridge, authorize: () => true });
  const result = await invoke(proxy, { action: 'models.configure', accountKey: f.key(0), expectedGeneration: read.generation + 1, settings: read.settings });
  assert.equal(result.status, 409); assert.equal(result.data.code, 'SOURCE_CHANGED'); assert.equal(result.data.requestNotSent, true);
  await assert.rejects(officialAccountRpc(bridge, 'models.configure', { accountKey: f.key(0), expectedGeneration: read.generation + 1, settings: read.settings }), error => error.status === 409 && error.code === 'SOURCE_CHANGED');
  f.hooks.read = async () => { throw Object.assign(new Error('PRIVATE_TOKEN raw@email.test stack-path'), { code: 'SOURCE_CHANGED' }); };
  const unknown = await invoke(proxy); assert.equal(unknown.status, 503); assert.equal(unknown.data.code, 'OFFICIAL_SERVICE_UNAVAILABLE'); assert(!/PRIVATE_TOKEN|email|stack-path/.test(JSON.stringify(unknown)));
});

test('HTTP remove rejects a missing generation and checks it before deletion', async t => {
  const f = await fixture(t), handler = accountServiceFetchHandler(f.service);
  const send = body => handler(new Request('http://localhost/api/dsh-plugin-codex-accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  assert.equal((await send({ action: 'account.remove', accountKey: f.key(0) })).status, 400);
  assert.equal((await send({ action: 'account.remove', accountKey: f.key(0), expectedGeneration: null })).status, 409);
  assert.deepEqual(f.calls.deleted, []);
});

test('quota rendering preserves readings/receipt and downgrades at reset without refilling', () => {
  const value = { status: 'reported', clientObservedAt: NOW - 1000, serverSampledAt: null, fiveHour: { remainingPercent: 23, resetAt: NOW + 500 }, weekly: { remainingPercent: 0, resetAt: NOW + 50000 }, ordinaryUsageAllowed: false }, bytes = JSON.stringify(value);
  const before = accountQuotaPresentation(value, NOW), after = accountQuotaPresentation(value, NOW + 501), failed = accountQuotaPresentation({ ...value, status: 'stale', error: 'QUOTA_UNAVAILABLE' }, NOW);
  assert.equal(before.status, '最近报告 · 非实时'); assert.equal(before.restricted, true); assert.match(after.status, /已过重置/); assert.equal(after.stale, true);
  assert.deepEqual(before.windows.map(row => row.value), ['23%', '0%']); assert.deepEqual(after.windows, before.windows); assert.deepEqual(failed.windows, before.windows); assert.equal(failed.received, before.received); assert.match(failed.status, /刷新失败/); assert.equal(JSON.stringify(value), bytes);
});

test('quota rendering separates unqueried, failed, missing windows, invalid and future receipts', () => {
  assert.equal(accountQuotaPresentation(null, NOW).status, '尚未查询');
  assert.equal(accountQuotaPresentation({ status: 'unavailable' }, NOW).status, '尚未查询');
  assert.equal(accountQuotaPresentation({ status: 'stale' }, NOW).status, '查询失败 · 尚无读数');
  const weekly = { status: 'reported', clientObservedAt: NOW, weekly: { remainingPercent: 72, resetAt: NOW + 5000 } };
  assert.deepEqual(accountQuotaPresentation(weekly, NOW).windows.map(row => row.value), ['未报告', '72%']);
  assert.match(accountQuotaPresentation({ status: 'unavailable', clientObservedAt: NOW }, NOW).status, /未报告可识别窗口/);
  assert.equal(accountQuotaPresentation({ ...weekly, clientObservedAt: NOW + 6000 }, NOW).stale, true);
  assert.match(accountQuotaPresentation({ ...weekly, clientObservedAt: -1 }, NOW).status, /待核验/);
  assert.deepEqual(accountQuotaPresentation({ status: 'reported', clientObservedAt: NOW, fiveHour: { remainingPercent: -2 }, weekly: { remainingPercent: 101 } }, NOW).windows.map(row => row.value), ['未报告', '未报告']);
  assert.match(accountCredentialSummary({ credentialStatus: 'available', bound: true }), /未验证远端/);
  assert(!accountCredentialSummary({ credentialStatus: 'PRIVATE_TOKEN' }).includes('PRIVATE_TOKEN'));
});

test('actual service/RPC/proxy conflict reaches the settings component, retaining the draft and pausing resubmission', async t => {
  const f = await fixture(t), fetchHandler = accountServiceFetchHandler(f.service), bridge = { fetch: request => fetchHandler(request) };
  const proxy = officialAccountsProxy({ bridge: () => bridge, authorize: () => true }), posts = [], cells = [], cleanups = []; let cursor = 0, tree;
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat().filter(value => value !== false && value != null) }; },
    useState(initial) { const n = cursor++; if (!(n in cells)) cells[n] = initial; return [cells[n], value => { cells[n] = typeof value === 'function' ? value(cells[n]) : value; }]; },
    useRef(initial) { return cells[cursor++] ??= { current: initial }; },
    useEffect(fn) { const n = cursor++; if (!(n in cells)) { cells[n] = true; cleanups.push(fn()); } },
  };
  const client = createSimplePetClient(React, async (url, init = {}) => {
    if (url.endsWith('/preferences')) return Response.json({ values: { ...DEFAULT_PREFERENCES, billingMode: 'codex', codexAccountBackend: 'official' }, revision: 'r' });
    if (!url.endsWith('/official-accounts')) return Response.json({});
    const body = init.method === 'POST' ? JSON.parse(init.body) : undefined; if (body) posts.push(body);
    const result = await invoke(proxy, body); return Response.json(result.data, { status: result.status });
  });
  const render = () => { cursor = 0; tree = client.SimplePetSettings(); }, nodes = (node = tree) => node && typeof node === 'object' ? [node, ...node.children.flatMap(nodes)] : [];
  const find = (attribute, value) => nodes().find(node => node.props[attribute] !== undefined && (value === undefined || node.props[attribute] === value));
  const text = (node = tree) => node && typeof node === 'object' ? node.children.map(text).join('') : String(node ?? '');
  const until = async predicate => { for (let attempt = 0; attempt < 300; attempt++) { await pause(10); render(); if (predicate()) return; } assert.fail('Synthetic account UI did not settle'); };
  t.after(() => { for (const cleanup of cleanups) cleanup?.(); });
  render(); await until(() => find('data-official-read')?.props.disabled === false);
  find('data-official-read').props.onClick(); await until(() => !!find('data-official-account-row', f.key(0)));
  find('data-official-models-open').props.onClick(); await until(() => !!find('data-model-default'));
  find('data-model-default').props.onChange({ target: { value: 'codex-mini' } }); render();
  await f.directory.update(data => { data.rows[1].label = 'Changed elsewhere'; });
  find('data-model-save').props.onClick(); await until(() => /明确放弃草稿/.test(text(find('data-model-status'))));
  assert.equal(find('data-model-default').props.value, 'codex-mini'); assert.equal(find('data-model-save').props.disabled, true);
  assert(find('data-official-account-row', f.key(1))); assert(find('data-official-stale-directory'));
  find('data-model-save').props.onClick(); await pause(500); render();
  assert.equal(posts.filter(body => body.action === 'models.configure').length, 1); assert.equal(f.calls.streams, 0);
  assert(!posts.some(body => ['host-model.select', 'warmup.run'].includes(body.action)));
});
