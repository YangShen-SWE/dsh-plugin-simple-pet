import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createSubscriptionWarmupService, verifyWarmupSdk } from './subscription-warmup-service.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const epoch = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function fixture(t, options = {}) {
  let now = 1800000000000, sends = 0, resolves = 0, active = 'other', valid = true, creates = 0, refreshes = 0;
  const rows = [{ id, active: false, credential: { type: 'oauth', accountId: 'synthetic-subscription-id', access: 'SYNTHETIC-NOT-A-TOKEN' } }];
  let quota = { fetchedAt: now, rateLimits: [{ id: 'codex', windows: [{ remainingPercent: 100, windowSeconds: 18000, resetsAt: now / 1000 + 18000 }] }] };
  let requestOptions, payload;
  const model = { id: 'test-model', name: 'Test Model', baseUrl: 'https://chatgpt.com/backend-api', input: ['text'], reasoning: true };
  const ctx = { catalog: { status: () => ({ source: 'online', refresh: 'ok' }), clear() {}, getModels: () => [model], metadata: () => ({ thinkingLevelMap: { off: null, low: 'low' } }), async refresh() { refreshes++; } }, quota: { read: async () => structuredClone(quota) }, async resolveAuth() { resolves++; return { auth: { apiKey: rows[0]?.credential.access } }; } };
  const service = createSubscriptionWarmupService({ ownerEpoch: epoch, now: () => now, sdkVerified: options.sdkVerified ?? true,
    vault: { warmupSnapshot: async () => structuredClone(rows), forAccount(rowId, identity) { assert.equal(rowId, id); assert.equal(identity, rows[0].credential.accountId); return {}; } },
    createContext() { creates++; return ctx; }, modelFetch: async () => { sends++; return {}; },
    stream: options.stream ?? ((_model, context, opts) => {
      requestOptions = opts; payload = opts.onPayload({ input: context.messages, service_tier: 'priority', prompt_cache_key: 'SHOULD-BE-REMOVED', tools: ['BAD'] });
      return (async function* () {
        await opts.fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', headers: { authorization: `Bearer ${rows[0].credential.access}`, 'chatgpt-account-id': rows[0].credential.accountId } });
        yield { type: 'done', reason: 'stop', message: { content: [{ type: 'text', text: 'OK' }], usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, secret: 'NO' } } };
      })();
    }),
  });
  t.after(() => service.dispose());
  const executor = service.connect(async () => valid);
  return { service, executor, rows, model, ctx, stats: () => ({ now, sends, resolves, active, valid, creates, refreshes, requestOptions, payload }), setValid: v => { valid = v; }, setNow: v => { now = v; }, setQuota: q => { quota = q; } };
}
async function selected(f) {
  const account = (await f.executor.listAccounts()).accounts[0];
  const binding = { ...account, ownerEpoch: epoch, claimReceipt: {} };
  const m = await f.executor.listModels({ ...binding, refresh: true });
  return { ...binding, modelKey: m.models[0].modelKey };
}
test('local discovery and unrefreshed model list never resolve auth or query a remote', async t => {
  const f = fixture(t), a = (await f.executor.listAccounts()).accounts[0];
  assert.match(a.accountKey, /^[a-f0-9]{16}$/); assert.match(a.accountGeneration, /^[a-f0-9]{64}$/); assert.match(a.budgetSubject, /^[a-f0-9]{64}$/);
  assert.equal(a.active, false); assert.doesNotMatch(JSON.stringify(a), /synthetic-subscription-id|SYNTHETIC-NOT-A-TOKEN/);
  assert.deepEqual((await f.executor.listModels(a)).models, []); assert.deepEqual(await f.executor.readQuota(a), { status: 'unknown' });
  assert.equal(f.stats().resolves, 0); assert.equal(f.stats().refreshes, 0); assert.equal(f.stats().sends, 0);
});
test('one explicit fixed-account execution uses a clean standard SSE profile and only numeric usage', async t => {
  const f = fixture(t), binding = await selected(f), prepared = await f.executor.prepare(binding);
  const result = await prepared.execute();
  assert.deepEqual(result, { usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  const s = f.stats(); assert.equal(s.sends, 1); assert.equal(s.active, 'other');
  assert.equal(s.requestOptions.maxRetries, 0); assert.equal(s.requestOptions.transport, 'sse'); assert.equal(s.requestOptions.cacheRetention, 'none');
  assert.equal(s.payload.service_tier, undefined); assert.equal(s.payload.prompt_cache_key, undefined); assert.equal(s.payload.tool_choice, 'none'); assert.deepEqual(s.payload.tools, []);
  assert.equal(s.payload.reasoning.effort, 'low'); assert.equal(s.payload.instructions, 'Reply only OK.');
  await assert.rejects(prepared.execute(), { code: 'WARMUP_CAPABILITY_USED' }); assert.equal(f.stats().sends, 1);
});
test('same subscription across account rows retains one budget subject; rebind changes row generation', async t => {
  const f = fixture(t), a = (await f.executor.listAccounts()).accounts[0];
  f.rows[0].id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const b = (await f.executor.listAccounts()).accounts[0]; assert.equal(a.budgetSubject, b.budgetSubject); assert.notEqual(a.accountKey, b.accountKey); assert.notEqual(a.accountGeneration, b.accountGeneration);
});
for (const mutation of ['delete', 'identity', 'receipt', 'dispose', 'expiry']) test(`prepared capability refuses ${mutation} without a dispatch`, async t => {
  const f = fixture(t), b = await selected(f), p = await f.executor.prepare(b);
  if (mutation === 'delete') f.rows.splice(0);
  if (mutation === 'identity') f.rows[0].credential.accountId = 'DIFFERENT';
  if (mutation === 'receipt') f.setValid(false);
  if (mutation === 'dispose') f.service.dispose();
  if (mutation === 'expiry') f.setNow(f.stats().now + 60001);
  await assert.rejects(p.execute()); assert.equal(f.stats().sends, 0);
});
test('SDK mismatch is non-executable and can never import an alternate engine', async t => {
  const f = fixture(t, { sdkVerified: false }); assert.equal(f.service.capabilities().accountBound, false);
  await assert.rejects(f.executor.listAccounts()); assert.equal(f.stats().creates, 0);
  assert.equal(verifyWarmupSdk({ version: '0.87.1', source: 'unknown build' }), false);
  assert.equal(verifyWarmupSdk({ version: '0.99.0', source: '' }), false);
});
test('receipt cannot be replaced by a JSON value or unrelated owner epoch', async t => {
  const f = fixture(t), b = await selected(f); delete b.claimReceipt;
  await assert.rejects(f.executor.prepare(b), { code: 'WARMUP_CLAIM_REQUIRED' });
  await assert.rejects(f.executor.prepare({ ...b, claimReceipt: {}, ownerEpoch: id }), { code: 'WARMUP_CLAIM_REQUIRED' });
  assert.throws(() => f.service.connect(() => true), { code: 'WARMUP_COORDINATOR_ALREADY_BOUND' });
});
test('known quota prohibition is never overridden by the unknown-quota option or a stale cache', async t => {
  const f = fixture(t), b = await selected(f);
  f.setQuota({ fetchedAt: f.stats().now, spendControlReached: true, rateLimits: [] });
  assert.equal((await f.executor.readQuota({ ...b, refresh: true })).status, 'restricted');
  f.ctx.quota.read = async () => { throw Error('private remote error'); };
  assert.equal((await f.executor.readQuota({ ...b, refresh: true })).status, 'restricted');
});
test('fresh known quota is ready, stale or incomplete reports remain unknown', async t => {
  const f = fixture(t), b = await selected(f);
  assert.equal((await f.executor.readQuota({ ...b, refresh: true })).status, 'ready');
  f.setNow(f.stats().now + 120001); assert.equal((await f.executor.readQuota(b)).status, 'unknown');
  f.setQuota({ fetchedAt: f.stats().now, rateLimits: [] }); assert.equal((await f.executor.readQuota({ ...b, refresh: true })).status, 'unknown');
});
test('hidden SDK retries cannot cross the model fetch boundary twice', async t => {
  let f;
  f = fixture(t, { stream: (_m, _c, options) => (async function* () {
    const init = { method: 'POST', headers: { authorization: 'Bearer SYNTHETIC-NOT-A-TOKEN', 'chatgpt-account-id': 'synthetic-subscription-id' } };
    await options.fetch('https://chatgpt.com/backend-api/codex/responses', init);
    await options.fetch('https://chatgpt.com/backend-api/codex/responses', init);
    yield { type: 'done', reason: 'stop', message: {} };
  })() });
  const b = await selected(f); await assert.rejects((await f.executor.prepare(b)).execute(), { requestNotSent: false }); assert.equal(f.stats().sends, 1);
});
for (const problem of ['wrong-route', 'wrong-auth', 'error', 'empty', 'truncated', 'abort']) test(`dispatch ${problem} is conservative unknown and never retried`, async t => {
  const ac = new AbortController(); let f;
  f = fixture(t, { stream: (_m, _c, options) => (async function* () {
    if (problem === 'wrong-route' || problem === 'wrong-auth') await options.fetch(problem === 'wrong-route' ? 'https://example.invalid' : 'https://chatgpt.com/backend-api/codex/responses', { method: 'POST', headers: { authorization: 'WRONG' } });
    if (problem === 'abort') ac.abort();
    if (problem === 'error') yield { type: 'error', error: { message: 'PRIVATE', usage: { input: 2 } } };
    if (problem !== 'truncated') yield { type: 'done', reason: 'stop', message: { content: [] } };
  })() });
  const b = await selected(f); await assert.rejects((await f.executor.prepare(b)).execute({ signal: ac.signal }), { requestNotSent: false }); assert.equal(f.stats().sends, 0);
});
test('account-bound vault refresh modifies only target row and preserves active without temporary selection', async () => {
  const source = await fs.readFile(new URL('./vendor/codex-subscription/lib/index.js', import.meta.url), 'utf8');
  const start = source.indexOf('\twarmupSnapshot() {'), end = source.indexOf('\tadd(label, credential)', start);
  const methods = source.slice(start, end).replaceAll('this.#enqueue', 'this.enqueue').replaceAll('this.#ensurePayload', 'this.ensure').replaceAll('this.#modifyPayload', 'this.modify');
  const Factory = vm.runInNewContext(`class BoundVault { constructor(data) { this.data=data; } enqueue(fn){return fn()} async ensure(){return this.data} async modify(fn){this.data=await fn(this.data)} ${methods} }; BoundVault`, { clone$1: structuredClone, sanitizeOAuthCredential: x => structuredClone(x) });
  const vault = new Factory({ activeId: 'active', accounts: [{ id: 'active', credential: { type: 'oauth', accountId: 'active-sub', access: 'active-token' } }, { id: 'target', credential: { type: 'oauth', accountId: 'target-sub', access: 'old' } }] });
  const bound = vault.forAccount('target', 'target-sub'); await bound.modifyActive(old => ({ ...old, access: 'refreshed' }));
  assert.equal(vault.data.activeId, 'active'); assert.equal(vault.data.accounts[0].credential.access, 'active-token'); assert.equal((await bound.readActive()).access, 'refreshed');
  await assert.rejects(bound.modifyActive(old => ({ ...old, accountId: 'changed' })), /WARMUP_ACCOUNT_REVOKED/);
  vault.data.accounts.splice(1); await assert.rejects(bound.readActive(), /WARMUP_ACCOUNT_REVOKED/);
});
