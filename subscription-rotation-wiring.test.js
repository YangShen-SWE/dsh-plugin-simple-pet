import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID, createHash } from 'node:crypto';
import { rotationBinding } from './subscription-rotation.js';

// Execute the shipped owner class and transport factory with in-memory host
// storage. No plugin startup, files, real credentials, processes or networking.
const source = readFileSync(new URL('./vendor/codex-subscription/lib/index.js', import.meta.url), 'utf8');
const section = (start, end) => { const i = source.indexOf(start), j = source.indexOf(end, i + start.length); assert.ok(i >= 0 && j > i); return source.slice(i, j); };
const vaultSource = section('var DshOAuthAccountVault = class', '//#endregion');
const helpers = section('function normalizeLabel(value)', 'var PendingOAuthCredentialStore');
function fixture() {
  let payload = { version: 1, activeId: 'synthetic-a', accounts: ['a','b','c'].map(id => ({ id: `synthetic-${id}`, label: `Synthetic ${id}`,
    credential: { type: 'oauth', accountId: `synthetic-subject-${id}`, access: `synthetic-token-${id}`, refresh: 'synthetic-refresh', expires: 9999999999999 } })) };
  let beforeUpdate;
  const credentials = {
    async readRecord() { return { kind: 'grant', payload: structuredClone(payload) }; },
    async modifyRecord(_key, update) { await beforeUpdate?.(); const result = await update({ kind: 'grant', payload: structuredClone(payload) }); payload = structuredClone(result.payload); return result; },
    async unset() {}, async set() {},
    async resolve() { throw Error('LEGACY_ACCESS_FORBIDDEN'); },
    async deleteRecord() { payload = undefined; },
  };
  const Vault = vm.runInNewContext(`${helpers}\n${vaultSource}\nDshOAuthAccountVault`, {
    clone$1: structuredClone, sanitizeOAuthCredential: structuredClone, VERSION: 1, rotationBinding, randomUUID,
  });
  const vault = new Vault(credentials, { key: 'synthetic-vault', legacyRef: 'synthetic-legacy' });
  return { vault, get payload() { return payload; }, set beforeUpdate(value) { beforeUpdate = value; } };
}
const refs = async vault => (await vault.warmupSnapshot()).map(row => ({ ...rotationBinding(row), selectionEpoch: vault.selectionEpoch() }));

test('real owner CAS selects only a matching generation and returns its new process epoch', async () => {
  const f = fixture(), [from, to] = await refs(f.vault);
  assert.equal(await f.vault.selectRotation({ from, to, validate: () => true }), 1);
  assert.equal(f.payload.activeId, 'synthetic-b');
  assert.equal(f.vault.selectionEpoch(), 1);
  await assert.rejects(f.vault.selectRotation({ from, to, validate: () => true }), { code: 'ROTATION_ACCOUNT_CHANGED' });
});

test('real owner rejects target rebind and same-subscription aliases before changing active', async () => {
  for (const alias of [false, true]) {
    const f = fixture(), [from, to] = await refs(f.vault);
    f.payload.accounts[1].credential.accountId = alias ? f.payload.accounts[0].credential.accountId : 'synthetic-rebound';
    if (alias) Object.assign(to, rotationBinding({ ...f.payload.accounts[1], active: false }));
    await assert.rejects(f.vault.selectRotation({ from, to, validate: () => true }), { code: 'ROTATION_ACCOUNT_CHANGED' });
    assert.equal(f.payload.activeId, 'synthetic-a');
  }
});

test('real owner epoch catches manual A-B-A even when row and OAuth identity match again', async () => {
  const f = fixture(), [from, to] = await refs(f.vault);
  await f.vault.select('synthetic-b'); await f.vault.select('synthetic-a');
  assert.equal(f.vault.selectionEpoch(), 2);
  await assert.rejects(f.vault.selectRotation({ from, to, validate: () => true }), { code: 'ROTATION_ACCOUNT_CHANGED' });
});

test('manual selection queued during storage wait invalidates automatic CAS without overriding user choice', async () => {
  const f = fixture(), [from, to] = await refs(f.vault);
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.beforeUpdate = async () => { f.beforeUpdate = null; entered(); await gate; };
  const pending = f.vault.selectRotation({ from, to, validate: () => true });
  await waiting;
  const manual = f.vault.select('synthetic-c');
  release();
  await assert.rejects(pending, { code: 'ROTATION_ACCOUNT_CHANGED' });
  await manual;
  assert.equal(f.payload.activeId, 'synthetic-c');
});

test('revocation or cancellation during storage wait is checked inside the real atomic owner callback', async () => {
  for (const reason of ['revoked', 'cancelled']) {
    const f = fixture(), [from, to] = await refs(f.vault);
    let allowed = true;
    f.beforeUpdate = async () => { allowed = false; };
    await assert.rejects(f.vault.selectRotation({ from, to, validate: () => {
      if (reason === 'cancelled' && !allowed) throw Object.assign(Error('cancelled'), { code: 'ABORT_ERR' });
      return allowed;
    } }), { code: reason === 'cancelled' ? 'ABORT_ERR' : 'ROTATION_CONFIGURATION_CHANGED' });
    assert.equal(f.payload.activeId, 'synthetic-a'); assert.equal(f.vault.selectionEpoch(), 0);
  }
});

test('real connection honors per-request SSE even when shared preferences select WebSocket', async () => {
  const code = section('function createSubscriptionConnection(', '//#endregion');
  let proxies = 0;
  const factory = vm.runInNewContext(`${code};createSubscriptionConnection`, { randomUUID, createHash, URL,
    closeOpenAICodexWebSocketSessions() { throw Error('CLOSE_NOT_EXPECTED'); },
  });
  const connection = factory({ resolveMode: () => 'websocket', resolveProxy: async () => { proxies++; return undefined; } });
  const fetch = () => { throw Error('NETWORK_NOT_EXPECTED'); };
  const result = await connection.prepare({ transport: 'sse', maxRetries: 0, fetch });
  assert.equal(result.options.transport, 'sse'); assert.equal(result.options.maxRetries, 0); assert.equal(result.options.fetch, fetch);
  assert.equal(result.network, undefined); assert.equal(proxies, 0);
});
