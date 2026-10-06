import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runCodexWarmup } from './warmup-call.js';

function fixture() {
  let streams = 0;
  const usage = [];
  const bridge = { async fetch(request) {
    const body = await request.json();
    const value = body.method === 'codex-subscription/status'
      ? { authenticated: true, accounts: [{ active: true, id: 'A' }] }
      : { managed: false };
    return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } });
  } };
  const llm = { async listModels() { return [{ provider: 'openai-codex', id: 'gpt-test' }]; },
    async *stream() {
      streams++;
      yield { type: 'text-delta', text: 'OK' };
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 1 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } };
  return { llm, bridge, quota: { accountKey: createHash('sha256').update('A').digest('hex').slice(0, 16) },
    signal: new AbortController().signal, onUsage: value => usage.push(value), usage,
    get streams() { return streams; } };
}

test('all pre-stream failures are explicitly proven unsent', async () => {
  for (const mode of ['catalog', 'info', 'account-rpc', 'aborted', 'missing-api']) {
    const f = fixture();
    if (mode === 'catalog') f.llm.listModels = async () => { throw new Error('catalog'); };
    if (mode === 'info') f.llm.resolveModelInfo = async () => { throw new Error('info'); };
    if (mode === 'account-rpc') f.bridge.fetch = async () => { throw new Error('RPC'); };
    if (mode === 'aborted') f.signal = AbortSignal.abort();
    if (mode === 'missing-api') delete f.llm.stream;
    await assert.rejects(runCodexWarmup(f), error => error.requestNotSent === true, mode);
    assert.equal(f.streams, 0, mode); assert.equal(f.usage.length, 0);
  }
});

test('pre-stream account switch carries both unsent and skip flags', async () => {
  const f = fixture(); f.quota.accountKey = '0123456789abcdef';
  await assert.rejects(runCodexWarmup(f), error => error.requestNotSent === true && error.accountChanged === true);
  assert.equal(f.streams, 0);
});

test('synchronous stream throws and iteration errors never advertise safe retry', async () => {
  for (const iteration of [false, true]) {
    const f = fixture(); let invoked = 0;
    const error = Object.assign(new Error('transport'), { requestNotSent: true });
    f.llm.stream = iteration ? async function* () { invoked++; throw error; }
      : () => { invoked++; throw error; };
    await assert.rejects(runCodexWarmup(f), error => error.requestNotSent === false);
    assert.equal(invoked, 1);
  }
});

test('aborted stream and failed accounting are post-send, with usage counted once', async () => {
  const f = fixture(), controller = new AbortController(); f.signal = controller.signal;
  f.llm.stream = async function* () {
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 1 } };
    controller.abort(); yield { type: 'text-delta', text: 'OK' };
  };
  await assert.rejects(runCodexWarmup(f), error => error.requestNotSent === false);
  assert.equal(f.usage.length, 1);
  const accounting = fixture(); let counted = 0;
  accounting.onUsage = () => { counted++; throw Object.assign(new Error('accounting'), { requestNotSent: true }); };
  await assert.rejects(runCodexWarmup(accounting), error => error.requestNotSent === false);
  assert.equal(counted, 1);
});
