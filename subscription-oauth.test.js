import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { oauthCredentialForResolution as project, createSubscriptionRequestAuth } from './subscription-oauth.js';
const jwt = claims => 'e30.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature';
const credential = (changes = {}) => ({ type: 'oauth', access: jwt({ exp: 1000 }), refresh: 'synthetic_refresh', expires: 2000000, accountId: 'synthetic-account', ...changes });

test('JWT expiry only shortens stored freshness, without altering canonical credentials', () => {
  const original = credential();
  assert.equal(project(original).expires, 940000);
  assert.equal(original.expires, 2000000);
  assert.equal(project(credential({ expires: 500000 })).expires, 440000);
  assert.equal(project(credential({ access: jwt({ exp: 0 }) })).expires, -60000);
});
test('opaque, malformed, invalid UTF8, invalid exp and oversized JWT keep stored expiry fallback', () => {
  for (const access of ['opaque', 'a.!broken.c', jwt({ exp: '1000' }), jwt({ exp: -1 }), jwt({ exp: 1e30 }), 'a._w.c', 'a.' + 'e'.repeat(65537) + '.c']) {
    assert.equal(project(credential({ access })).expires, 1940000);
  }
  assert.equal(project(undefined), undefined);
  assert.equal(project(credential(), 0).expires, 1000000);
});
function fixture(options = {}) {
  let clock = 0, key = 'account-a', value = credential(), calls = 0, serial = 0, resolveHook = null;
  const auth = createSubscriptionRequestAuth({ now: () => clock, nonce: () => String(++serial), readAccountKey: async () => key,
    readCredential: async ({ signal }) => { signal?.throwIfAborted(); return structuredClone(value); },
    resolveAuth: async input => { calls++; await resolveHook?.(input); return { auth: { apiKey: value.access }, source: 'OAuth' }; }, ...options });
  return { auth, get calls() { return calls; }, set key(next) { key = next; }, set credential(next) { value = next; }, set clock(next) { clock = next; }, set hook(next) { resolveHook = next; } };
}
test('adapter capture does not refresh or freeze bearer; lazy auth uses freshly rotated credential', async () => {
  const f = fixture(); const handle = await f.auth.capture();
  assert.match(handle, /^simple-pet-oauth-request:/); assert.equal(f.calls, 0);
  const fresh = credential({ access: jwt({ exp: 5000 }) }); f.credential = fresh;
  assert.equal((await f.auth.resolve(handle)).auth.apiKey, fresh.access); assert.equal(f.calls, 1);
  await assert.rejects(f.auth.resolve(handle), { code: 'SUBSCRIPTION_AUTH_REQUEST_EXPIRED' }); assert.equal(f.calls, 1);
});
test('refresh receives request abort signal and explicit post-refresh minimum validity', async () => {
  const f = fixture(), control = new AbortController();
  f.hook = options => { assert.equal(options.signal, control.signal); assert.equal(options.minOAuthValidityMs, 60000); };
  await f.auth.resolve(await f.auth.capture(), { signal: control.signal });
});
test('account change before lazy auth cannot silently redirect the request or refresh new account', async () => {
  const f = fixture(), handle = await f.auth.capture(); f.key = 'account-b';
  await assert.rejects(f.auth.resolve(handle), { code: 'SUBSCRIPTION_AUTH_ACCOUNT_CHANGED' }); assert.equal(f.calls, 0);
});
test('grant identity change within same vault row cannot redirect request', async () => {
  const f = fixture(), handle = await f.auth.capture(); f.credential = credential({ accountId: 'other-account' });
  await assert.rejects(f.auth.resolve(handle), { code: 'SUBSCRIPTION_AUTH_ACCOUNT_CHANGED' }); assert.equal(f.calls, 0);
});
test('binding or identity change during refresh aborts before model dispatch', async () => {
  for (const field of ['binding', 'identity']) {
    const f = fixture(), handle = await f.auth.capture();
    f.hook = () => { if (field === 'binding') f.key = 'account-b'; else f.credential = credential({ accountId: 'other' }); };
    await assert.rejects(f.auth.resolve(handle), { code: 'SUBSCRIPTION_AUTH_ACCOUNT_CHANGED' }); assert.equal(f.calls, 1);
  }
});
test('abort before or during resolution and unload cannot release a bearer', async () => {
  const f = fixture(), handle = await f.auth.capture(), control = new AbortController();
  control.abort(); await assert.rejects(f.auth.resolve(handle, { signal: control.signal }), { name: 'AbortError' }); assert.equal(f.calls, 0);
  const next = await f.auth.capture(), active = new AbortController(); f.hook = () => active.abort();
  await assert.rejects(f.auth.resolve(next, { signal: active.signal }), { name: 'AbortError' });
  f.auth.dispose(); await assert.rejects(f.auth.capture(), { code: 'SUBSCRIPTION_AUTH_CLOSED' });
  await assert.rejects(f.auth.resolve(handle), { code: 'SUBSCRIPTION_AUTH_CLOSED' });
});
test('pending handles bounded, expire, are single-use and do not accept arbitrary bearer strings', async () => {
  const f = fixture({ maxPending: 1, ttlMs: 10 }), handle = await f.auth.capture();
  await assert.rejects(f.auth.capture(), { code: 'SUBSCRIPTION_AUTH_BUSY' }); f.clock = 10;
  await assert.rejects(f.auth.resolve(handle), { code: 'SUBSCRIPTION_AUTH_REQUEST_EXPIRED' });
  await f.auth.resolve(await f.auth.capture());
  await assert.rejects(f.auth.resolve('synthetic-bearer'), { code: 'SUBSCRIPTION_AUTH_REQUEST_EXPIRED' });
});
test('legacy identity may be cross-checked from JWT but cannot conflict with stored account', async () => {
  const f = fixture(); f.credential = credential({ accountId: undefined, access: jwt({ exp: 5000, 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } }) });
  await f.auth.resolve(await f.auth.capture());
  f.credential = credential({ access: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'other' } }) });
  await assert.rejects(f.auth.capture(), { code: 'SUBSCRIPTION_AUTH_IDENTITY_UNVERIFIED' });
});
test('a resolved bearer cannot belong to an intervening account even after route ABA', async () => {
  const f = fixture({ resolveAuth: async () => ({ auth: { apiKey: 'intervening-account-token' } }) });
  await assert.rejects(f.auth.resolve(await f.auth.capture()), { code: 'SUBSCRIPTION_AUTH_ACCOUNT_CHANGED' });
});
test('one bound stream can revalidate original upstream review attempts but cannot bind twice or switch identity', async () => {
  const f = fixture(), handle = await f.auth.capture(), bound = f.auth.bind(handle);
  await bound.resolve(); await bound.resolve(); assert.equal(f.calls, 2);
  assert.throws(() => f.auth.bind(handle), { code: 'SUBSCRIPTION_AUTH_REQUEST_EXPIRED' });
  f.key = 'account-b'; await assert.rejects(bound.resolve(), { code: 'SUBSCRIPTION_AUTH_ACCOUNT_CHANGED' }); assert.equal(f.calls, 2);
});
test('refresh failure cannot release a bearer, silently switch accounts or replay the handle', async () => {
  let calls = 0;
  const f = fixture({ resolveAuth: async () => { calls++; throw Error('SYNTHETIC_REFRESH_DENIED'); } });
  const handle = await f.auth.capture();
  await assert.rejects(f.auth.resolve(handle), /SYNTHETIC_REFRESH_DENIED/);
  await assert.rejects(f.auth.resolve(handle), { code: 'SUBSCRIPTION_AUTH_REQUEST_EXPIRED' });
  assert.equal(calls, 1);
});
test('selection epoch survives the one-shot handle; unchanged account resolves, ABA never releases auth', async () => {
  let epoch = 0;
  const f = fixture({ readSelectionEpoch: () => epoch });
  const first = await f.auth.capture({ expectedSelectionEpoch: 0 });
  await f.auth.resolve(first);
  const captured = await f.auth.capture();
  epoch += 2; // Same row/identity after a switch away and back is still different.
  await assert.rejects(f.auth.resolve(captured), { code: 'SUBSCRIPTION_AUTH_ACCOUNT_CHANGED' });
  assert.equal(f.calls, 1);
  await assert.rejects(f.auth.capture({ expectedSelectionEpoch: 0 }), { code: 'SUBSCRIPTION_AUTH_ACCOUNT_CHANGED' });
  const during = await f.auth.capture(); f.hook = () => { epoch += 2; };
  await assert.rejects(f.auth.resolve(during), { code: 'SUBSCRIPTION_AUTH_ACCOUNT_CHANGED' });
});

test('upstream fork projects expiry at all store boundaries and scopes automatic refresh', () => {
  const source = readFileSync(new URL('./vendor/codex-subscription/lib/index.js', import.meta.url), 'utf8');
  assert.match(source, /resolveAuth = \(options\) => network\.run\("oauth", \(\) => authModels\.getAuth\(PROVIDER, options\)\)/);
  assert.match(source, /bindRequestAuth: \(handle, signal\) => requestAuth\.bind\(handle, signal\)/);
  assert.match(source, /return await requestAuth\.capture\(petCallScope\.getStore\(\)\)/);
  assert.match(source, /onSubscriptionAdapter\?\.\(Object\.freeze/);
  assert.equal((source.match(/oauthCredentialForResolution\(/g) ?? []).length, 5);
  assert.doesNotMatch(source, /expires: current\.expires - this\.expirySkewMs/);
});
