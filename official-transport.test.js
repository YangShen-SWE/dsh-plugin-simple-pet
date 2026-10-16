import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { apply, accountServiceFetchHandler } from './codex-accounts/index.js';
import { officialAccountRpc } from './official-accounts.js';

// Match the installed public Connection contract: the shared Fetch registry is
// independent from webServer.register(). An HTTP handler is NOT a Fetch route.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'DshAccountTransport-'));
  const fetchRoutes = new Map(), httpRoutes = new Map(), cleanups = [];
  let denied = false;
  const connection = {
    requestRejection: () => denied ? 401 : undefined,
    fetch: { register(route) {
      assert.equal(route.requestBody, 'buffered');
      fetchRoutes.set(route.path, route);
      const dispose = () => fetchRoutes.delete(route.path); cleanups.push(dispose); return dispose;
    } },
    createSharedFetchHandler() { return { fetch(request) {
      const route = fetchRoutes.get(new URL(request.url).pathname);
      return route?.methods.includes(request.method) ? route.fetch(request) : Promise.resolve(new Response('not found', { status: 404 }));
    } }; },
  };
  const lifecycleEffect = await apply({
    credentials: { async readRecord() { throw Error('No account data in this test'); }, async modifyRecord() { throw Error('No OAuth in transport tests'); }, async deleteRecord() {} },
    llm: { registerAdapter() {} },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanups.push(dispose); },
    inject(_names, fn) { fn({ connection, webServer: { register(route) { httpRoutes.set(route.path, route.handler); return () => httpRoutes.delete(route.path); } }, effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanups.push(dispose); } }); },
  }, { directoryFile: path.join(root, 'directory.json'), driver: async () => { throw Error('No OAuth or model work'); } });
  // The real host feeds this resolved value to Cordis safeCollect, which rejects
  // plain objects. Mock transports must verify the lifecycle contract as well.
  assert.equal(lifecycleEffect, undefined);
  t.after(async () => { for (const dispose of cleanups.reverse()) await dispose?.(); await fs.rm(root, { recursive: true, force: true }); });
  return { connection, fetchRoutes, httpRoutes, disposeRoutes() { for (const dispose of cleanups.splice(0).reverse()) dispose?.(); }, setDenied(value) { denied = value; }, async http(method = 'GET') {
    const request = Readable.from([]); request.method = method; request.headers = {};
    const response = new EventEmitter(); let status, body;
    response.writeHead = value => { status = value; }; response.end = value => { body = value; };
    await httpRoutes.get('/api/dsh-plugin-codex-accounts')(request, response);
    return { status, body };
  } };
}

test('desktop account reader reaches the independent plugin through the real shared-route contract', async t => {
  const f = await fixture(t);
  const result = await officialAccountRpc(f.connection.createSharedFetchHandler('/api'), null);
  assert.deepEqual(result.accounts, []); assert.equal(result.defaultKey, null);
  assert(f.fetchRoutes.has('/api/dsh-plugin-codex-accounts'));
});
test('direct HTTP remains auth-first and shared route is removed at disposal', async t => {
  const f = await fixture(t); f.setDenied(true);
  assert.equal((await f.http()).status, 401);
  f.setDenied(false); assert.equal((await f.http()).status, 200);
  const route = f.fetchRoutes.get('/api/dsh-plugin-codex-accounts');
  assert.deepEqual(route.methods, ['GET', 'HEAD', 'POST']);
  f.disposeRoutes(); assert.equal(f.fetchRoutes.size, 0); assert.equal(f.httpRoutes.size, 0);
  const retired = await f.connection.createSharedFetchHandler('/api').fetch(new Request('http://localhost/api/dsh-plugin-codex-accounts'));
  assert.equal(retired.status, 404);
});
test('shared Fetch adapter handles HEAD, content type, bounded JSON and aborted requests without OAuth', async t => {
  const f = await fixture(t), bridge = f.connection.createSharedFetchHandler('/api');
  const head = await bridge.fetch(new Request('http://localhost/api/dsh-plugin-codex-accounts', { method: 'HEAD' }));
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const badType = await bridge.fetch(new Request('http://localhost/api/dsh-plugin-codex-accounts', { method: 'POST', body: '{}' }));
  assert.equal(badType.status, 415);
  const badAction = await bridge.fetch(new Request('http://localhost/api/dsh-plugin-codex-accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'steal.tokens' }) }));
  assert.equal(badAction.status, 400);
  const large = await bridge.fetch(new Request('http://localhost/api/dsh-plugin-codex-accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'login.start', label: 'x'.repeat(9000) }) }));
  assert.equal(large.status, 413);
  const controller = new AbortController(); controller.abort();
  const cancelled = await bridge.fetch(new Request('http://localhost/api/dsh-plugin-codex-accounts', { signal: controller.signal }));
  assert.equal(cancelled.status, 503); assert.equal((await cancelled.json()).requestNotSent, true);
});

for (const action of ['login.start', 'quota.read', 'warmup.run']) test(`abort while a valid ${action} body is buffered never dispatches work`, async () => {
  let calls = 0;
  const service = { beginLogin() { calls++; }, quota() { calls++; }, warmup() { calls++; } };
  const payload = action === 'login.start' ? { label: 'mock' } : action === 'quota.read' ? { accountKey: 'a'.repeat(16) } : { accountKey: 'a'.repeat(16), modelKey: 'b'.repeat(64) };
  const controller = new AbortController();
  const body = new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode(JSON.stringify({ action, ...payload }))); } });
  const request = new Request('http://localhost/api/dsh-plugin-codex-accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, duplex: 'half', signal: controller.signal });
  const pending = accountServiceFetchHandler(service)(request);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 0); controller.abort();
  const result = await pending; assert.equal(result.status, 503); assert.equal((await result.json()).requestNotSent, true); assert.equal(calls, 0);
});
test('abort after mutation dispatch cannot relabel an executed operation as unsent', async () => {
  const controller = new AbortController(); let release;
  const pending = accountServiceFetchHandler({ beginLogin: () => new Promise(resolve => { release = resolve; }) })(new Request('http://localhost/api/dsh-plugin-codex-accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'login.start', label: 'mock' }), signal: controller.signal }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(typeof release, 'function'); controller.abort(); release({ executed: true });
  const result = await pending; assert.equal(result.status, 200); assert.deepEqual(await result.json(), { executed: true });
});
test('safe error mapping exposes actionable route failure without raw upstream text', async () => {
  await assert.rejects(officialAccountRpc({ fetch: async () => new Response('not found', { status: 404 }) }, null), error => error.code === 'OFFICIAL_ROUTE_MISSING' && /宿主通道/.test(error.message));
  await assert.rejects(officialAccountRpc({ fetch: async () => Response.json({ error: 'PRIVATE_TOKEN_ERROR' }, { status: 503 }) }, null), error => error.code === 'OFFICIAL_SERVICE_UNAVAILABLE' && !error.message.includes('PRIVATE'));
});
