import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { AccountDirectory, createAccountService, hash, isAccountError } from './codex-accounts/service.js';
import { accountServiceFetchHandler } from './codex-accounts/index.js';
import { officialAccountRpc, officialAccountsProxy } from './official-accounts.js';

const ROUTE = 'http://localhost/api/dsh-plugin-codex-accounts';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function invoke(handler, body) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.method = body === undefined ? 'GET' : 'POST'; req.headers = { 'content-type': 'application/json' };
  let status, data;
  await handler(req, { writeHead(code) { status = code; }, end(value) { data = value ? JSON.parse(value) : undefined; } });
  return { status, data };
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'DshAccountRename-'));
  const directory = new AccountDirectory(path.join(root, 'directory.json'));
  const rows = ['工作', 'Personal'].map((label, index) => ({
    key: (index ? 'b' : 'a').repeat(16), epoch: index + 3, label, bound: true, revoked: false,
    identityHash: hash(`SYNTHETIC_RENAME_ACCOUNT_${index}`), createdAt: 1790000000000 + index,
    modelHints: ['codex-mini', 'gpt-6.1-sol'],
    modelSettings: { enabled: ['codex-mini'], defaultModel: 'codex-mini', reasoningEffort: null },
    models: [{ id: 'codex-mini', route: `fixed-${index}` }],
  }));
  await directory.update(data => { data.rows = structuredClone(rows); data.defaultKey = rows[0].key; });
  // Entirely synthetic, separate local grants/budget bytes. Rename must neither
  // inspect them through credentials nor touch these independent stores.
  const grantFile = path.join(root, 'synthetic-grants.json'), budgetFile = path.join(root, 'synthetic-budget.json');
  const grantBytes = JSON.stringify({ record: 'SYNTHETIC_PRIVATE_GRANT_DO_NOT_EXPOSE', expires: 1790003600000 });
  const budgetBytes = JSON.stringify({ claim: 'SYNTHETIC_ALREADY_CLAIMED', paused: true, attempts: 1, accounts: rows.map(row => row.identityHash.slice(0, 16)) });
  await fs.writeFile(grantFile, grantBytes); await fs.writeFile(budgetFile, budgetBytes);
  const calls = [], allowedCalls = []; let notifications = 0;
  const forbidden = name => async () => { calls.push(name); throw new Error(`SYNTHETIC_FORBIDDEN_${name}`); };
  const credentials = { readRecord: forbidden('credential.read'), modifyRecord: forbidden('credential.modify'), deleteRecord: forbidden('credential.delete') };
  const service = createAccountService({ directory, credentials,
    driver: forbidden('driver'), fetchImpl: forbidden('network'), hostModel: forbidden('host-model'),
    changed() { notifications++; },
  });
  const fetchHandler = accountServiceFetchHandler(service), bridge = { fetch: request => fetchHandler(request) };
  const proxy = officialAccountsProxy({ bridge: () => bridge, authorize: () => true });
  const key = index => rows[index].identityHash.slice(0, 16);
  const post = (payload, signal) => fetchHandler(new Request(ROUTE, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }));
  const rename = (label, generation = 1, accountKey = key(0)) => invoke(proxy, { action: 'account.rename', accountKey, label, expectedGeneration: generation });
  const independentStoresUnchanged = async () => {
    assert.equal(await fs.readFile(grantFile, 'utf8'), grantBytes);
    assert.equal(await fs.readFile(budgetFile, 'utf8'), budgetBytes);
  };
  t.after(async () => {
    await service.dispose();
    assert.deepEqual(calls, allowedCalls, 'rename must never call credentials, driver, network or host model');
    await independentStoresUnchanged();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('DshAccountRename-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, directory, rows, service, credentials, calls, allowedCalls, bridge, proxy, key, post, rename,
    notifications: () => notifications, independentStoresUnchanged };
}
const assertSafeFailure = (result, status, code) => {
  assert.equal(result.status, status); assert.equal(result.data.code, code);
  assert(!/SYNTHETIC_|identityHash|stack|token|cause|directory\.json/i.test(JSON.stringify(result)));
};

test('real proxy → Fetch RPC → service → atomic directory rename changes only label/generation', async t => {
  const f = await fixture(t), before = await f.directory.read();
  assert.notEqual(f.key(0), before.rows[0].key, 'use the public account key, not its credential-record key');
  const result = await f.rename('  研究 👩‍💻 · Århus العربية  ');
  assert.deepEqual(result, { status: 200, data: { ok: true } });
  const after = await f.directory.read(), expected = structuredClone(before);
  expected.generation++; expected.rows[0].label = '研究 👩‍💻 · Århus العربية';
  assert.deepEqual(after, expected);
  assert.equal(f.notifications(), 1); assert.deepEqual(f.calls, []);
  assert.equal(hash(`${after.rows[0].identityHash.slice(0, 16)}:codex-mini`), hash(`${f.key(0)}:codex-mini`));
  await f.independentStoresUnchanged();
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['directory.json', 'synthetic-budget.json', 'synthetic-grants.json']);
});

for (const label of ['界'.repeat(64), '🐈'.repeat(64), 'Cafe\u0301', '漢字 العربية עברית', '  Personal  ']) {
  test(`valid Unicode local label is preserved without identity normalization: ${JSON.stringify(label).slice(0, 48)}`, async t => {
    const f = await fixture(t);
    assert.deepEqual(await officialAccountRpc(f.bridge, 'account.rename', { accountKey: f.key(0), label, expectedGeneration: 1 }), { ok: true });
    const data = await f.directory.read(); assert.equal(data.rows[0].label, label.trim()); assert.equal(data.generation, 2);
  });
}

test('duplicate display names and explicitly saving the unchanged name are allowed', async t => {
  const f = await fixture(t), before = await f.directory.read();
  assert.equal((await f.rename(before.rows[1].label)).status, 200);
  assert.deepEqual((await f.directory.read()).rows.map(row => row.label), ['Personal', 'Personal']);
  assert.equal((await f.rename('Personal', 2)).status, 200);
  assert.equal((await f.directory.read()).generation, 3);
  assert.equal(f.notifications(), 2);
});

const invalidLabels = [
  null, false, 42, {}, [], '', '   ', '\u00a0\u3000', 'x'.repeat(65), '🐈'.repeat(65),
  '\u0000name', 'name\n', '\tname', 'name\u007f', 'name\u0085', 'name\u009f',
  'name\u061c', 'name\u200e', 'name\u200f', 'name\u202a', 'name\u202b', 'name\u202c',
  'name\u202d', 'name\u202e', 'name\u2066', 'name\u2067', 'name\u2068', 'name\u2069',
  'name\u2028', 'name\u2029', 'name\ud800',
];
for (const label of invalidLabels) test(`invalid label is a safe 400 with byte-identical directory: ${JSON.stringify(label).slice(0, 48)}`, async t => {
  const f = await fixture(t), before = await fs.readFile(f.directory.file, 'utf8');
  const result = await f.rename(label); assertSafeFailure(result, 400, 'INVALID_LABEL'); assert.equal(result.data.requestNotSent, true);
  assert.equal(await fs.readFile(f.directory.file, 'utf8'), before); assert.equal(f.notifications(), 0);
});

test('RPC schema rejects missing/extra rename properties before the service mutation', async t => {
  const f = await fixture(t), before = await fs.readFile(f.directory.file, 'utf8');
  for (const body of [
    { action: 'account.rename', accountKey: f.key(0), expectedGeneration: 1 },
    { action: 'account.rename', accountKey: f.key(0), label: 'new' },
    { action: 'account.rename', accountKey: f.key(0), label: 'new', expectedGeneration: 1, extra: 'SYNTHETIC_PRIVATE_EXTRA' },
  ]) assertSafeFailure(await invoke(f.proxy, body), 400, 'INVALID_ACTION');
  assert.equal(await fs.readFile(f.directory.file, 'utf8'), before); assert.equal(f.notifications(), 0);
});

for (const generation of [null, -1, 1.5, '1', 0, 2, Number.MAX_SAFE_INTEGER + 1]) test(`generation validation/CAS keeps the original bytes: ${JSON.stringify(generation)}`, async t => {
  const f = await fixture(t), before = await fs.readFile(f.directory.file, 'utf8');
  const result = await f.rename('new', generation); assertSafeFailure(result, 409, 'SOURCE_CHANGED');
  assert.equal(result.data.requestNotSent, true); assert.equal(await fs.readFile(f.directory.file, 'utf8'), before);
});

test('service itself requires a generation, independently of the RPC schema', async t => {
  const f = await fixture(t), before = await fs.readFile(f.directory.file, 'utf8');
  await assert.rejects(f.service.rename(f.key(0), 'new'), error => isAccountError(error) && error.status === 409 && error.code === 'SOURCE_CHANGED');
  assert.equal(await fs.readFile(f.directory.file, 'utf8'), before);
});

for (const [key, status, code] of [
  [null, 400, 'INVALID_ACCOUNT'], ['bad', 400, 'INVALID_ACCOUNT'], ['A'.repeat(16), 400, 'INVALID_ACCOUNT'],
  ['c'.repeat(16), 409, 'ACCOUNT_NOT_BOUND'], ['a'.repeat(16), 409, 'ACCOUNT_NOT_BOUND'],
]) test(`invalid/unknown/private account key never falls back to default: ${JSON.stringify(key)}`, async t => {
  const f = await fixture(t), before = await fs.readFile(f.directory.file, 'utf8');
  assertSafeFailure(await f.rename('new', 1, key), status, code);
  assert.equal(await fs.readFile(f.directory.file, 'utf8'), before);
});

test('independent directories serialize concurrent same-generation renames without lost updates', async t => {
  const f = await fixture(t), secondDirectory = new AccountDirectory(f.directory.file);
  const secondService = createAccountService({ directory: secondDirectory, credentials: f.credentials,
    driver: async () => { throw Error('SYNTHETIC_DRIVER_FORBIDDEN'); } });
  t.after(() => secondService.dispose());
  const secondBridge = { fetch: accountServiceFetchHandler(secondService) };
  const results = await Promise.allSettled([
    officialAccountRpc(f.bridge, 'account.rename', { accountKey: f.key(0), label: 'concurrent A', expectedGeneration: 1 }),
    officialAccountRpc(secondBridge, 'account.rename', { accountKey: f.key(1), label: 'concurrent B', expectedGeneration: 1 }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = results.find(result => result.status === 'rejected').reason;
  assert.equal(failure.status, 409); assert.equal(failure.code, 'SOURCE_CHANGED');
  const data = await f.directory.read(); assert.equal(data.generation, 2);
  assert.equal(data.rows.filter((row, i) => row.label !== f.rows[i].label).length, 1);
});

test('a concurrent unrelated directory change conflicts and cannot be overwritten', async t => {
  const f = await fixture(t);
  await new AccountDirectory(f.directory.file).update(data => { data.rows[1].label = 'newer external name'; });
  const before = await fs.readFile(f.directory.file, 'utf8');
  assertSafeFailure(await f.rename('stale draft'), 409, 'SOURCE_CHANGED');
  assert.equal(await fs.readFile(f.directory.file, 'utf8'), before);
});

test('revocation through the real service remains durable and cannot be renamed/rebound', async t => {
  const f = await fixture(t);
  f.credentials.deleteRecord = async () => { f.calls.push('credential.delete'); };
  f.allowedCalls.push('credential.delete');
  await officialAccountRpc(f.bridge, 'account.remove', { accountKey: f.key(0), expectedGeneration: 1 });
  const before = await fs.readFile(f.directory.file, 'utf8');
  assertSafeFailure(await f.rename('revive', 1), 409, 'SOURCE_CHANGED');
  assertSafeFailure(await f.rename('revive', 2), 409, 'ACCOUNT_NOT_BOUND');
  assert.equal(await fs.readFile(f.directory.file, 'utf8'), before);
  const data = await f.directory.read(); assert.equal(data.rows[0].revoked, true); assert.equal(data.rows[0].epoch, f.rows[0].epoch + 1); assert.equal(data.defaultKey, null);
});

test('an unbound provisional row is not a public rename target', async t => {
  const f = await fixture(t);
  await f.directory.update(data => { data.rows[1].bound = false; });
  const before = await fs.readFile(f.directory.file, 'utf8');
  assertSafeFailure(await f.rename('pending', 2, f.key(1)), 409, 'ACCOUNT_NOT_BOUND');
  assert.equal(await fs.readFile(f.directory.file, 'utf8'), before);
});

test('pre-aborted real Fetch request never dispatches a rename', async t => {
  const f = await fixture(t), before = await fs.readFile(f.directory.file, 'utf8'), controller = new AbortController();
  controller.abort(new Error('SYNTHETIC_PRIVATE_ABORT_REASON'));
  const response = await f.post({ action: 'account.rename', accountKey: f.key(0), label: 'cancelled', expectedGeneration: 1 }, controller.signal);
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'REQUEST_ABORTED', requestNotSent: true });
  assert.equal(await fs.readFile(f.directory.file, 'utf8'), before); assert.equal(f.notifications(), 0);
});

test('rename cancelled while waiting for the atomic transaction does not write', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), before = await fs.readFile(f.directory.file, 'utf8');
  const originalRead = f.directory.read.bind(f.directory);
  f.directory.read = async () => { entered.resolve(); await release.promise; return originalRead(); };
  const controller = new AbortController();
  const pending = f.post({ action: 'account.rename', accountKey: f.key(0), label: 'cancelled', expectedGeneration: 1 }, controller.signal);
  try { await entered.promise; controller.abort(new Error('SYNTHETIC_PRIVATE_ABORT_REASON')); }
  finally { release.resolve(); }
  const response = await pending; assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'REQUEST_ABORTED', requestNotSent: true });
  assert.equal(await fs.readFile(f.directory.file, 'utf8'), before); assert.equal(f.notifications(), 0);
});

for (const reason of ['cancel', 'dispose']) test(`pre-commit ${reason} rejects after temp write without replacing directory`, async t => {
  const f = await fixture(t), originalWrite = fs.writeFile, entered = deferred(), release = deferred();
  const before = await fs.readFile(f.directory.file, 'utf8'), controller = new AbortController();
  fs.writeFile = async (file, ...args) => {
    const result = await originalWrite(file, ...args);
    if (typeof file === 'string' && file.startsWith(`${f.directory.file}.`) && file.endsWith('.tmp')) { entered.resolve(); await release.promise; }
    return result;
  };
  let closing;
  try {
    const pending = f.post({ action: 'account.rename', accountKey: f.key(0), label: 'too late', expectedGeneration: 1 }, controller.signal);
    await entered.promise;
    if (reason === 'cancel') controller.abort(new Error('SYNTHETIC_PRIVATE_ABORT_REASON'));
    else closing = f.service.dispose();
    release.resolve();
    const response = await pending;
    assert.equal(response.status, reason === 'cancel' ? 503 : 410);
    assert.deepEqual(await response.json(), { error: reason === 'cancel' ? 'REQUEST_ABORTED' : 'SERVICE_CLOSED', requestNotSent: true });
    await closing;
  } finally { release.resolve(); fs.writeFile = originalWrite; }
  assert.equal(await fs.readFile(f.directory.file, 'utf8'), before); assert.equal(f.notifications(), 0);
  assert(!(await fs.readdir(f.root)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')));
});

test('cancellation after atomic commit never falsely reports an executed rename as unsent', async t => {
  const f = await fixture(t), originalRename = fs.rename, controller = new AbortController();
  fs.rename = async (...args) => {
    const result = await originalRename(...args);
    if (args[1] === f.directory.file) controller.abort(new Error('SYNTHETIC_PRIVATE_LATE_ABORT'));
    return result;
  };
  try {
    const response = await f.post({ action: 'account.rename', accountKey: f.key(0), label: 'committed', expectedGeneration: 1 }, controller.signal);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
  } finally { fs.rename = originalRename; }
  const after = await f.directory.read(); assert.equal(after.generation, 2); assert.equal(after.rows[0].label, 'committed');
  assert.equal(f.notifications(), 1);
});

test('disposed service fails closed through the proxy safe channel', async t => {
  const f = await fixture(t), before = await fs.readFile(f.directory.file, 'utf8');
  await f.service.dispose();
  assertSafeFailure(await f.rename('closed'), 410, 'SERVICE_CLOSED');
  assert.equal(await fs.readFile(f.directory.file, 'utf8'), before);
});

test('corrupt directory cannot be overwritten or disclose its original bytes', async t => {
  const f = await fixture(t), corrupt = '{SYNTHETIC_PRIVATE_CORRUPT_DIRECTORY';
  await fs.writeFile(f.directory.file, corrupt);
  assertSafeFailure(await f.rename('new'), 503, 'DIRECTORY_UNAVAILABLE');
  assert.equal(await fs.readFile(f.directory.file, 'utf8'), corrupt);
});

test('unbranded storage failure is redacted rather than trusting forged status/code', async t => {
  const f = await fixture(t), before = await fs.readFile(f.directory.file, 'utf8');
  f.directory.read = async () => { throw Object.assign(new Error('SYNTHETIC_PRIVATE_TOKEN raw@email.test stack-path'), { code: 'SOURCE_CHANGED', status: 409 }); };
  assertSafeFailure(await f.rename('new'), 503, 'OFFICIAL_SERVICE_UNAVAILABLE');
  assert.equal(await fs.readFile(f.directory.file, 'utf8'), before);
});

test('generation overflow fails closed instead of committing unreadable metadata', async t => {
  const f = await fixture(t), data = await f.directory.read(); data.generation = Number.MAX_SAFE_INTEGER;
  await fs.writeFile(f.directory.file, JSON.stringify(data));
  const before = await fs.readFile(f.directory.file, 'utf8');
  assertSafeFailure(await f.rename('new', Number.MAX_SAFE_INTEGER), 409, 'DIRECTORY_LIMIT');
  assert.equal(await fs.readFile(f.directory.file, 'utf8'), before);
});

test('a missing service route preserves safe 404 through RPC and proxy, without parsing its private body', async () => {
  const bridge = { fetch: async () => new Response('SYNTHETIC_PRIVATE_ROUTE_BODY', { status: 404 }) };
  const payload = { accountKey: 'a'.repeat(16), label: 'new', expectedGeneration: 1 };
  await assert.rejects(officialAccountRpc(bridge, 'account.rename', payload), error => error.status === 404 && error.code === 'OFFICIAL_ROUTE_MISSING' && !error.message.includes('SYNTHETIC_'));
  const proxy = officialAccountsProxy({ bridge: () => bridge, authorize: () => true });
  const result = await invoke(proxy, { action: 'account.rename', ...payload });
  assertSafeFailure(result, 404, 'OFFICIAL_ROUTE_MISSING'); assert.equal(result.data.requestNotSent, true);
});

test('proxy rejects a rename before reaching RPC when authorization fails', async () => {
  let fetched = 0;
  const proxy = officialAccountsProxy({ bridge: () => ({ fetch() { fetched++; throw Error('SYNTHETIC_MUST_NOT_FETCH'); } }),
    authorize(_req, res) { res.writeHead(403); res.end('{}'); return false; } });
  assert.deepEqual(await invoke(proxy, { action: 'account.rename', accountKey: 'a'.repeat(16), label: 'new', expectedGeneration: 1 }), { status: 403, data: {} });
  assert.equal(fetched, 0);
});
