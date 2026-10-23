import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createSubscriptionLegacyAdapter } from './subscription-legacy-route.js';

const legacy = 'codex-accounts';
const native = 'openai-codex';
const route = '0123456789abcdef:gpt-5.2-codex';
const history = () => [{ id: 'user-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'new user request' }] }];
const options = extra => ({ provider: legacy, model: route, messages: history(), ...extra });

function mockAdapter() {
  const state = { generation: 'selected-A', calls: [], dispatches: [], closed: 0 };
  const retry = Object.freeze({ mode: 'normal', maxRetries: 3 });
  const pricing = Object.freeze({ kind: 'mock-image-pricing' });
  const chunks = [
    { type: 'text-delta', index: 0, text: 'hello' },
    { type: 'usage', usage: { inputTokens: 7, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'error', error: { code: 'IMAGE_OFFLOAD_REQUIRED', message: 'offload', offloadImages: 2 } } },
  ];
  const modelInfo = (provider, model) => ({ provider, id: model, name: 'Subscription model', inputModalities: ['text', 'image'], context: { contextWindow: 200000 }, reasoning: { levels: [{ id: 'high' }], default: 'high' }, defaultMaxTokens: 1000, toolUpdate: 'in-history' });
  const adapter = {
    providerInfo(provider) { assert.equal(this, adapter); state.calls.push(['providerInfo', provider]); return { id: provider, name: 'Subscription' }; },
    providerRetryPolicy(provider) { assert.equal(this, adapter); state.calls.push(['retry', provider]); return retry; },
    imageRequestPricing(provider, model) { assert.equal(this, adapter); state.calls.push(['pricing', provider, model]); return pricing; },
    listModels() { throw new Error('Must not enumerate retired or subscription accounts'); },
    resolveModel(provider, model, signal) { assert.equal(this, adapter); state.calls.push(['resolve', provider, model, signal]); return Promise.resolve(modelInfo(provider, model)); },
    prepareCall(provider, model, signal) {
      assert.equal(this, adapter);
      const generation = state.generation;
      state.calls.push(['prepare', provider, model, signal, generation]);
      const prepared = {
        model: modelInfo(provider, model),
        stream(request) {
          assert.equal(this, prepared);
          state.dispatches.push({ request, generation });
          if (state.error) throw state.error;
          if (state.onStream) return state.onStream(request, generation);
          if (state.iterator) return state.iterator;
          return (async function* () {
            try { for (const chunk of chunks) { request.signal?.throwIfAborted(); yield chunk; } }
            finally { state.closed++; }
          })();
        },
      };
      return Promise.resolve(prepared);
    },
    stream() { throw new Error('Must use prepared dispatch, not adapter.stream'); },
  };
  for (const key of ['authContext', 'credentials', 'accounts', 'config']) {
    Object.defineProperty(adapter, key, { get() { throw new Error(`Forbidden adapter ${key} access`); } });
  }
  return { adapter, state, retry, pricing, chunks };
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function nativeReplay(content, response = {}) {
  return {
    response: { kind: 'pi-ai', version: 2, api: 'openai-codex-responses', provider: native, model: 'gpt-5.2-codex', stopReason: 'stop', responseId: 'response-offline', ...response },
    blocks: content.map(block => ({ type: block.type, ...({
      text: { textSignature: 'offline-text-signature' },
      reasoning: { thinkingSignature: 'offline-thinking-signature', redacted: false },
      'tool-call': { thoughtSignature: 'offline-tool-signature' },
    })[block.type] })),
  };
}

function assistant(id, source = {}, content = [{ type: 'text', text: 'durable answer' }]) {
  return { id, role: 'assistant', content, source: { kind: 'model', provider: legacy, model: route, replayState: nativeReplay(content), ...source } };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

// Execute the SHIPPED bridge, not a duplicate of its checkpoint acceptance
// logic. Only this isolated section is loaded: no plugin initialization,
// credential store, real histories, network fetch or model is available here.
const vendor = readFileSync(new URL('./vendor/codex-subscription/lib/index.js', import.meta.url), 'utf8');
const bridgeSection = /\/\/#region src\/subscription-compaction\.js\r?\n([\s\S]*?)\/\/#endregion/.exec(vendor);
assert.ok(bridgeSection, 'The shipped compaction bridge must be exercised');
const createCompactionBridge = vm.runInNewContext(`${bridgeSection[1]}\ncreateCompactionBridge`, {
  AsyncLocalStorage, createHash, TextDecoder, TransformStream, Response,
});

function compactionFixture(enabled = true) {
  const { adapter, state } = mockAdapter();
  const bridge = createCompactionBridge({ enabled: () => enabled, accountScope: async () => state.generation, now: () => 1792700000000 });
  const runs = [];
  state.finishReason = { kind: 'stop' };
  state.completed = true;
  state.onStream = (request, generation) => (async function* () {
    const turn = runs.length + 1;
    // Neutral input stands in for pi-ai's wire conversion; source/replay are
    // adapter-private, never serialized as user content. Assertions below also
    // verify the precise source/replay identities required by pi-ai v2.
    const payload = bridge.preparePayload({ input: request.messages.map(({ role, content }) => ({ role, content })) }, 200000);
    const items = [{ type: 'compaction', encrypted_content: `offline:${generation}:${turn}` }];
    const content = [{ type: 'text', text: `offline answer ${turn}` }];
    const events = [
      { type: 'response.output_item.done', item: items[0] },
      { type: 'response.completed', response: { status: state.completed ? 'completed' : 'failed' } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
    const response = new Response(events);
    const transform = bridge.networkOptions({}).transformResponse;
    await (transform ? transform(response, new URL('https://chatgpt.com/backend-api/codex/responses')) : response).text();
    const finish = { type: 'finish', reason: state.finishReason, replayState: nativeReplay(content, { model: request.model }) };
    const run = { request, payload, items, content, finish };
    runs.push(run);
    yield { type: 'block-end', index: 0, block: content[0] };
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 1 } };
    yield finish;
  })();
  const unified = bridge.wrapAdapter(adapter);
  return { state, bridge, runs, unified, wrapper: createSubscriptionLegacyAdapter(unified) };
}

async function turn(fixture, messages) {
  const chunks = await collect(fixture.wrapper.stream(options({ messages })));
  const run = fixture.runs.at(-1);
  // The host persists the EXTERNAL legacy route, not the request-local native
  // projection. JSON-round-trip to check that reuse does not rely on object ids.
  return JSON.parse(JSON.stringify(assistant(`answer-${fixture.runs.length}`, { replayState: chunks.at(-1).replayState }, run.content)));
}

for (const model of [route, 'default:gpt-5.2-codex', 'ABCDEF0123456789:gpt-5.2-codex']) {
  test(`route ${model} follows the current subscription adapter`, async () => {
    const { adapter, state, chunks } = mockAdapter();
    const wrapper = createSubscriptionLegacyAdapter(adapter);
    assert.equal(state.calls.length, 0); // Construction never sends or resolves anything.
    assert.deepEqual(await collect(wrapper.stream(options({ model }))), chunks);
    assert.equal(state.calls.length, 1);
    assert.deepEqual(state.calls[0].slice(0, 3), ['prepare', native, 'gpt-5.2-codex']);
    assert.equal(state.dispatches[0].request.provider, native);
    assert.equal(state.dispatches[0].request.model, 'gpt-5.2-codex');
    assert.equal(state.dispatches[0].generation, 'selected-A');
  });
}

test('empty discovery, outer identity, retry and image pricing delegate correctly', async () => {
  const { adapter, state, retry, pricing } = mockAdapter();
  const wrapper = createSubscriptionLegacyAdapter(adapter);
  assert.deepEqual(await wrapper.listModels(legacy), []);
  assert.equal(wrapper.providerInfo(legacy).id, legacy);
  assert.equal(wrapper.providerRetryPolicy(legacy), retry);
  assert.equal(wrapper.imageRequestPricing(legacy, route), pricing);
  const signal = new AbortController().signal;
  const info = await wrapper.resolveModel(legacy, route, signal);
  assert.equal(info.provider, legacy);
  assert.equal(info.id, route);
  assert.equal(info.context.contextWindow, 200000);
  assert.deepEqual(info.inputModalities, ['text', 'image']);
  assert.equal(info.defaultMaxTokens, 1000);
  assert.equal(info.toolUpdate, 'in-history');
  assert.deepEqual(state.calls.at(-1), ['resolve', native, 'gpt-5.2-codex', signal]);
  assert.deepEqual(state.calls.find(row => row[0] === 'pricing'), ['pricing', native, 'gpt-5.2-codex']);
});

test('prepared metadata and stream bind one generation before await', async () => {
  const { adapter, state } = mockAdapter();
  const wrapper = createSubscriptionLegacyAdapter(adapter);
  const controller = new AbortController();
  const pending = wrapper.prepareCall(legacy, route, controller.signal);
  assert.equal(state.calls.length, 1);
  state.generation = 'selected-B';
  const prepared = await pending;
  assert.equal(prepared.model.provider, legacy);
  assert.equal(prepared.model.id, route);
  assert.equal(prepared.model.context.contextWindow, 200000);
  await collect(prepared.stream(options({ signal: controller.signal })));
  assert.equal(state.dispatches[0].generation, 'selected-A');
  assert.equal(state.dispatches[0].request.signal, controller.signal);
  await collect(wrapper.stream(options()));
  assert.equal(state.dispatches[1].generation, 'selected-B');
  assert.equal(state.calls.filter(row => row[0] === 'resolve').length, 0);
});

test('direct stream captures now, never dispatches abandoned streams', async () => {
  const { adapter, state } = mockAdapter();
  const wrapper = createSubscriptionLegacyAdapter(adapter);
  const stream = wrapper.stream(options());
  state.generation = 'selected-B';
  assert.equal(state.calls.length, 1);
  assert.equal(state.dispatches.length, 0);
  await collect(stream);
  assert.equal(state.dispatches[0].generation, 'selected-A');
  const unused = wrapper.stream(options());
  await unused.return();
  assert.equal(state.dispatches.length, 1);
});

test('only public request controls pass; legacy auth and Fast/default overrides are never read', async () => {
  const { adapter, state } = mockAdapter();
  const wrapper = createSubscriptionLegacyAdapter(adapter);
  const request = options({ reasoningEffort: 'low', temperature: 0.3, maxTokens: 99, stop: ['stop'], system: 'system', tools: [], toolChoice: 'auto', toolHistory: { tools: [], updates: [] }, sessionId: 'session' });
  for (const key of ['authContext', 'apiKey', 'endpoint', 'accountKey', 'credentials', 'headers', 'reasoning', 'defaultReasoningEffort', 'speedMode', 'fast', 'serviceTier', 'providerOptions']) {
    Object.defineProperty(request, key, { enumerable: true, get() { throw new Error(`Forbidden legacy ${key} access`); } });
  }
  await collect(wrapper.stream(Object.freeze(request)));
  const forwarded = state.dispatches[0].request;
  for (const key of ['reasoningEffort', 'temperature', 'maxTokens', 'stop', 'system', 'tools', 'toolChoice', 'toolHistory', 'sessionId']) assert.equal(forwarded[key], request[key]);
  assert.equal(forwarded.reasoningEffort, 'low');
  assert.equal('authContext' in forwarded, false);
  assert.equal('speedMode' in forwarded, false);
  await collect(wrapper.stream(options()));
  assert.equal(Object.hasOwn(state.dispatches[1].request, 'reasoningEffort'), false);
});

test('retired account envelopes stay neutral under every historical provider without changing durable content', async () => {
  const { adapter, state } = mockAdapter();
  const wrapper = createSubscriptionLegacyAdapter(adapter);
  const messages = [
    ...history(),
    ...[legacy, native, 'other-provider'].map((provider, index) => ({
      id: `assistant-${index}`, role: 'assistant', content: [{ type: 'text', text: 'durable answer' }, { type: 'tool-call', id: 'call-1', name: 'tool', arguments: '{}' }],
      source: { kind: 'model', provider, model: route, replayState: { kind: 'simple-pet/codex-account-replay', version: 1, accountKey: '0123456789abcdef', model: 'gpt-5.2-codex', state: { response: { kind: 'pi-ai', version: 2, provider: native, model: 'gpt-5.2-codex' }, blocks: [] } } },
    })),
    { id: 'assistant-neutral', role: 'assistant', source: { kind: 'model', provider: legacy, model: route }, content: [] },
  ];
  const snapshot = structuredClone(messages);
  for (const message of messages) { Object.freeze(message.source); Object.freeze(message); }
  Object.freeze(messages);
  await collect(wrapper.stream(options({ messages })));
  const projected = state.dispatches[0].request.messages;
  assert.deepEqual(messages, snapshot);
  assert.equal(projected[0], messages[0]);
  assert.equal(projected.at(-1), messages.at(-1));
  for (let i = 1; i <= 3; i++) {
    assert.equal(projected[i].content, messages[i].content);
    assert.equal(projected[i].id, messages[i].id);
    assert.equal(projected[i].source.provider, messages[i].source.provider);
    assert.equal(projected[i].source.model, messages[i].source.model);
    assert.equal('replayState' in projected[i].source, false);
  }
  assert.equal(state.dispatches.length, 1); // History is only context for ONE explicit new call.
});

test('unscoped native signatures are neutralized with stable request-only sources and no durable changes', async () => {
  const { adapter, state } = mockAdapter();
  const content = [
    { type: 'text', text: 'native answer' },
    { type: 'reasoning', text: 'native reasoning' },
    { type: 'tool-call', id: 'offline-call', name: 'tool', arguments: '{}' },
  ];
  const messages = [
    ...history(),
    assistant('legacy-native', {}, content),
    assistant('default-native', { model: 'default:gpt-5.2-codex' }),
    assistant('already-native', { provider: native, model: 'gpt-5.2-codex' }),
    assistant('previous-model', { model: 'default:previous-model', replayState: nativeReplay(content, { model: 'previous-model' }) }, content),
    assistant('no-replay', { replayState: undefined }),
  ];
  const before = structuredClone(messages);
  deepFreeze(messages);
  await collect(createSubscriptionLegacyAdapter(adapter).stream(options({ messages })));
  const projected = state.dispatches[0].request.messages;
  assert.deepEqual(messages, before);
  for (let index = 1; index <= 4; index++) {
    assert.equal(projected[index].source.provider, native);
    assert.equal(projected[index].source.model, messages[index].source.replayState.response.model);
    assert.equal(projected[index].source.kind, messages[index].source.kind);
    assert.equal(projected[index].source.replayState, undefined);
    assert.equal(projected[index].content, messages[index].content);
    assert.equal(projected[index].id, messages[index].id);
  }
  assert.notEqual(projected[3], messages[3]);
  assert.equal(projected.at(-1), messages.at(-1));
  assert.equal(messages[1].source.provider, legacy);
  assert.equal(messages[1].source.model, route);
});

test('normal old-chat replies stay neutral on the next turn without mutating or wrapping finish', async () => {
  const { adapter, state } = mockAdapter();
  const wrapper = createSubscriptionLegacyAdapter(adapter);
  const output = assistant('turn-1');
  const finish = { type: 'finish', reason: { kind: 'stop' }, replayState: output.source.replayState };
  state.onStream = () => (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: output.content[0].text };
    yield { type: 'block-end', index: 0, block: output.content[0] };
    yield finish;
  })();
  const chunks = await collect(wrapper.stream(options()));
  assert.equal(chunks.at(-1), finish);
  const persisted = assistant('turn-1', { replayState: chunks.at(-1).replayState }, chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block));
  const messages = deepFreeze([...history(), JSON.parse(JSON.stringify(persisted)), { ...history()[0], id: 'user-2' }]);
  const before = structuredClone(messages);
  await collect(wrapper.stream(options({ messages })));
  const replayed = state.dispatches[1].request.messages[1];
  assert.equal(replayed.source.provider, native);
  assert.equal(replayed.source.model, 'gpt-5.2-codex');
  assert.equal(replayed.source.replayState, undefined);
  assert.deepEqual(messages, before);
  assert.equal(state.dispatches.length, 2);
});

test('real bridge reuses consecutive checkpoints across persisted legacy turns with stable prefix hashes', async () => {
  const fixture = compactionFixture();
  const messages = [
    { id: 'system', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'offline system' }] },
    ...history(),
    assistant('old-answer', { replayState: { kind: 'simple-pet/codex-account-replay', version: 1, accountKey: 'old', state: nativeReplay([]) } }),
    { ...history()[0], id: 'user-2' },
  ];
  for (let index = 0; index < 3; index++) {
    const before = structuredClone(messages);
    const answer = await turn(fixture, deepFreeze([...messages]));
    assert.deepEqual(messages, before);
    assert.equal(answer.source.provider, legacy);
    assert.equal(answer.source.model, route);
    const checkpoint = answer.source.replayState.response.codexCompactionV1;
    assert.ok(checkpoint);
    assert.equal(checkpoint.items[0].encrypted_content, `offline:selected-A:${index + 1}`);
    const run = fixture.runs[index];
    if (index === 0) assert.equal(run.payload.input.some(item => item.type === 'compaction'), false);
    else {
      assert.equal(run.payload.input[0].encrypted_content, `offline:selected-A:${index}`);
      assert.deepEqual(Array.from(run.request.messages, message => message.id), ['system', `user-${index + 2}`]);
    }
    assert.equal(fixture.bridge.snapshot().checkpointsSaved, index + 1);
    assert.equal(fixture.bridge.snapshot().checkpointsReused, index);
    messages.push(answer, { ...history()[0], id: `user-${index + 3}` });
  }
  // The third request verifies checkpoint #2: its prefix includes the normalized
  // source of answer #1, unlike checkpoint #1's prefix. No rehash is fabricated.
  assert.equal(fixture.state.dispatches.length, 3);
  assert.equal(messages.find(message => message.id === 'old-answer').source.replayState.kind, 'simple-pet/codex-account-replay');
});

test('pre-fix identity hashes fail closed without rewriting checkpoints, then new checkpoints recover', async () => {
  const fixture = compactionFixture();
  const prefix = [...history(), assistant('previous-native'), { ...history()[0], id: 'previous-user' }];
  // The former neutralHistory dropped replay but left legacy source identities
  // in the bridge's prefix hash. Generate that exact old hash with the real
  // bridge rather than rewriting an encrypted checkpoint to make it pass.
  const oldRequest = prefix.map(message => {
    if (message.role !== 'assistant') return message;
    const { replayState, ...source } = message.source;
    return { ...message, source };
  });
  const prepared = await fixture.unified.prepareCall(native, 'gpt-5.2-codex');
  const chunks = await collect(prepared.stream({ provider: native, model: 'gpt-5.2-codex', messages: oldRequest }));
  const answer = JSON.parse(JSON.stringify(assistant('pre-fix-answer', { replayState: chunks.at(-1).replayState }, fixture.runs[0].content)));
  const messages = deepFreeze([...prefix, answer, { ...history()[0], id: 'post-fix-user' }]);
  const before = structuredClone(messages);
  const next = await turn(fixture, messages);
  assert.equal(fixture.runs[1].payload.input.some(item => item.type === 'compaction'), false);
  assert.deepEqual(fixture.runs[1].request.messages.map(message => message.id), messages.map(message => message.id));
  assert.equal(fixture.bridge.snapshot().checkpointsReused, 0);
  assert.deepEqual(messages, before);
  await turn(fixture, [...messages, next, { ...history()[0], id: 'recovered-user' }]);
  assert.equal(fixture.runs[2].payload.input[0].encrypted_content, 'offline:selected-A:2');
  assert.equal(fixture.bridge.snapshot().checkpointsReused, 1);
});

test('foreign, retired and malformed replay cannot smuggle an otherwise valid compaction checkpoint', async () => {
  const fixture = compactionFixture();
  const prefix = history();
  const answer = await turn(fixture, prefix);
  const cases = [
    ['foreign source', message => { message.source.provider = 'other-provider'; }],
    ['wrong source model', message => { message.source.model = 'default:other-model'; }],
    ['opaque source model', message => { message.source.model = `0123456789abcdef:${'a'.repeat(64)}`; }],
    ['foreign response', message => { message.source.replayState.response.kind = 'other-adapter'; }],
    ['unsupported version', message => { message.source.replayState.response.version = 99; }],
    ['foreign native provider', message => { message.source.replayState.response.provider = 'other-provider'; }],
    ['missing api', message => { delete message.source.replayState.response.api; }],
    ['foreign api', message => { message.source.replayState.response.api = 'anthropic-messages'; }],
    ['unknown stop reason', message => { message.source.replayState.response.stopReason = 'unknown'; }],
    ['malformed optional response', message => { message.source.replayState.response.responseId = 42; }],
    ['missing blocks', message => { delete message.source.replayState.blocks; }],
    ['wrong block count', message => { message.source.replayState.blocks = []; }],
    ['mismatched block', message => { message.source.replayState.blocks[0].type = 'reasoning'; }],
    ['invalid signature', message => { message.source.replayState.blocks[0].textSignature = false; }],
    ['invalid redacted flag', message => { message.source.replayState.blocks[0].redacted = 'yes'; }],
    ['retired account envelope', message => {
      const replay = message.source.replayState;
      // Even a forged top-level native half must not rehabilitate an old account
      // envelope. Its nested state/accountKey are never consulted or unwrapped.
      message.source.replayState = { ...replay, kind: 'simple-pet/codex-account-replay', version: 1, accountKey: '0123456789abcdef', state: replay };
    }],
  ];
  for (const [name, change] of cases) {
    const message = structuredClone(answer);
    change(message);
    const messages = deepFreeze([...prefix, message, { ...history()[0], id: 'user-next' }]);
    const before = structuredClone(messages);
    await turn(fixture, messages);
    const run = fixture.runs.at(-1);
    assert.equal(run.payload.input.some(item => item.type === 'compaction'), false, name);
    assert.equal(run.request.messages[1].source.replayState, undefined, name);
    assert.equal(run.request.messages[1].source.provider, message.source.provider, name);
    assert.equal(run.request.messages[1].source.model, message.source.model, name);
    assert.deepEqual(messages, before, name);
  }
  assert.equal(fixture.bridge.snapshot().checkpointsReused, 0);
});

test('account changes reject old compaction while preserving history and allowing new scoped checkpoints', async () => {
  const fixture = compactionFixture();
  const prefix = history();
  const answerA = await turn(fixture, prefix);
  const messagesB = deepFreeze([...prefix, answerA, { ...history()[0], id: 'user-B' }]);
  const beforeB = structuredClone(messagesB);
  fixture.state.generation = 'selected-B';
  const answerB = await turn(fixture, messagesB);
  assert.equal(fixture.runs[1].payload.input.some(item => item.type === 'compaction'), false);
  const carrier = fixture.runs[1].request.messages[1].source.replayState;
  assert.deepEqual(Object.keys(carrier), ['response']);
  assert.deepEqual(Object.keys(carrier.response), ['codexCompactionV1']);
  assert.doesNotMatch(JSON.stringify(carrier), /offline-(?:text|thinking|tool)-signature|response-offline/);
  assert.deepEqual(fixture.runs[1].request.messages.map(message => message.id), messagesB.map(message => message.id));
  assert.notEqual(answerA.source.replayState.response.codexCompactionV1.scope, answerB.source.replayState.response.codexCompactionV1.scope);
  assert.deepEqual(messagesB, beforeB);
  assert.equal(fixture.bridge.snapshot().checkpointsReused, 0);
  const messagesNextB = deepFreeze([...messagesB, answerB, { ...history()[0], id: 'user-B-next' }]);
  await turn(fixture, messagesNextB);
  assert.equal(fixture.runs[2].payload.input[0].encrypted_content, 'offline:selected-B:2');
  assert.equal(fixture.bridge.snapshot().checkpointsReused, 1);
  fixture.state.generation = 'selected-A';
  await turn(fixture, messagesNextB);
  // The real bridge refuses the newest B checkpoint, not an arbitrary older A
  // checkpoint. The route never edits scope or falls back/retries on its behalf.
  assert.equal(fixture.runs[3].payload.input.some(item => item.type === 'compaction'), false);
  assert.equal(fixture.bridge.snapshot().checkpointsReused, 1);
  assert.equal(fixture.state.dispatches.length, 4);
});

test('native checkpoint verification still rejects changed prefix, content, model, scope, age and digest', async () => {
  const fixture = compactionFixture();
  const prefix = history();
  const answer = await turn(fixture, prefix);
  const cases = [
    ['prefix', messages => { messages[0].content[0].text = 'edited prefix'; }],
    ['source identity', messages => { messages[0].source.kind = 'other-user-kind'; }],
    ['content', messages => { messages[1].content[0].text = 'edited answer'; }],
    ['scope', messages => { messages[1].source.replayState.response.codexCompactionV1.scope = 'foreign-account'; }],
    ['prefix hash', messages => { messages[1].source.replayState.response.codexCompactionV1.prefix = 'forged'; }],
    ['content hash', messages => { messages[1].source.replayState.response.codexCompactionV1.content = 'forged'; }],
    ['future', messages => { messages[1].source.replayState.response.codexCompactionV1.createdAt += 1; }],
    ['expired', messages => { messages[1].source.replayState.response.codexCompactionV1.createdAt -= 10080 * 60 * 1000 + 1; }],
    ['digest', messages => { messages[1].source.replayState.response.codexCompactionV1.items[0].encrypted_content = 'tampered'; }],
    ['model', messages => {
      messages[1].source.model = 'default:another-model';
      messages[1].source.replayState.response.model = 'another-model';
    }],
  ];
  for (const [name, change] of cases) {
    const messages = structuredClone([...prefix, answer, { ...history()[0], id: 'user-next' }]);
    change(messages);
    const before = structuredClone(messages);
    // Changing only the historical replay/source model is not a request model
    // change; scope is keyed by the new request. Test actual model isolation too.
    const request = name === 'model' ? { model: 'default:another-model' } : {};
    await collect(fixture.wrapper.stream(options({ messages: deepFreeze(messages), ...request })));
    assert.equal(fixture.runs.at(-1).payload.input.some(item => item.type === 'compaction'), false, name);
    assert.deepEqual(messages, before, name);
  }
  assert.equal(fixture.bridge.snapshot().checkpointsReused, 0);
});

test('failed or incomplete responses never acquire a successful compaction checkpoint', async () => {
  for (const failure of ['finish-error', 'response-incomplete', 'compaction-disabled']) {
    const fixture = compactionFixture(failure !== 'compaction-disabled');
    if (failure === 'finish-error') fixture.state.finishReason = { kind: 'error', error: { code: 'OFFLINE', message: 'offline failure' } };
    if (failure === 'response-incomplete') fixture.state.completed = false;
    const chunks = await collect(fixture.wrapper.stream(options()));
    const finish = chunks.at(-1);
    assert.equal(finish, fixture.runs[0].finish);
    assert.equal(finish.replayState.response.codexCompactionV1, undefined);
    assert.equal(fixture.bridge.snapshot().checkpointsSaved, 0);
    assert.equal(fixture.bridge.snapshot().checkpointsReused, 0);
    assert.equal(fixture.state.dispatches.length, 1);
  }
});

test('prepared stream is route-bound and one-shot, returning original iterator', async () => {
  const { adapter, state } = mockAdapter();
  const wrapper = createSubscriptionLegacyAdapter(adapter);
  const iterator = { async next() { return { done: true }; }, [Symbol.asyncIterator]() { return this; } };
  state.iterator = iterator;
  const prepared = await wrapper.prepareCall(legacy, route);
  assert.throws(() => prepared.stream(options({ model: 'default:gpt-5.2-codex' })), { code: 'INVALID_PREPARED_CALL' });
  assert.equal(prepared.stream(options()), iterator);
  assert.throws(() => prepared.stream(options()), { code: 'INVALID_PREPARED_CALL' });
  assert.equal(state.dispatches.length, 1);
});

test('usage and terminal failure/offload chunks pass by identity without retries', async () => {
  const { adapter, state, chunks } = mockAdapter();
  const received = await collect(createSubscriptionLegacyAdapter(adapter).stream(options()));
  received.forEach((chunk, index) => assert.equal(chunk, chunks[index]));
  assert.equal(received.at(-1).reason.error.offloadImages, 2);
  assert.equal(state.dispatches.length, 1);
});

test('thrown adapter preflight/offload failure is preserved, never retried', async () => {
  const { adapter, state } = mockAdapter();
  state.error = Object.assign(new Error('mock offload required'), { code: 'IMAGE_OFFLOAD_REQUIRED', failure: { offloadImages: 3 } });
  await assert.rejects(collect(createSubscriptionLegacyAdapter(adapter).stream(options())), error => error === state.error);
  assert.equal(state.dispatches.length, 1);
});

test('caller abort reaches inner stream and closes it', async () => {
  const { adapter, state } = mockAdapter();
  const controller = new AbortController();
  const iterator = createSubscriptionLegacyAdapter(adapter).stream(options({ signal: controller.signal }));
  await iterator.next();
  const reason = new Error('mock caller abort');
  controller.abort(reason);
  await assert.rejects(iterator.next(), error => error === reason);
  assert.equal(state.closed, 1);
  assert.equal(state.dispatches.length, 1);
});

test('consumer return and throw reach original iterator cleanup', async () => {
  for (const action of ['return', 'throw']) {
    const { adapter, state } = mockAdapter();
    const iterator = createSubscriptionLegacyAdapter(adapter).stream(options());
    await iterator.next();
    if (action === 'return') await iterator.return();
    else { const reason = new Error('consumer'); await assert.rejects(iterator.throw(reason), error => error === reason); }
    assert.equal(state.closed, 1);
    assert.equal(state.dispatches.length, 1);
  }
});

test('opaque, malformed and wrong-provider routes safely fail without touching subscription adapter', async () => {
  const { adapter, state } = mockAdapter();
  const wrapper = createSubscriptionLegacyAdapter(adapter);
  for (const model of [undefined, '', 'gpt-5', `0123456789abcdef:${'a'.repeat(64)}`, `default:${'A'.repeat(64)}`, 'default:', 'default:../gpt', 'default:gpt:extra', 'unknown:gpt', 'default:gpt\n', `default:${'g'.repeat(129)}`]) {
    await assert.rejects(wrapper.resolveModel(legacy, model), error => error.code === 'LEGACY_MODEL_RESELECT_REQUIRED' && error.message.includes('原聊天'));
    await assert.rejects(wrapper.prepareCall(legacy, model), { code: 'LEGACY_MODEL_RESELECT_REQUIRED' });
    await assert.rejects(collect(wrapper.stream(options({ model }))), { code: 'LEGACY_MODEL_RESELECT_REQUIRED' });
    assert.throws(() => wrapper.imageRequestPricing(legacy, model), { code: 'LEGACY_MODEL_RESELECT_REQUIRED' });
  }
  await assert.rejects(wrapper.prepareCall(native, route), { code: 'NO_ADAPTER' });
  await assert.rejects(wrapper.listModels(native), { code: 'NO_ADAPTER' });
  assert.throws(() => wrapper.providerInfo(native), { code: 'NO_ADAPTER' });
  assert.throws(() => wrapper.providerRetryPolicy(native), { code: 'NO_ADAPTER' });
  assert.equal(state.calls.length, 0);
  assert.equal(state.dispatches.length, 0);
});

test('incomplete adapter is rejected instead of building a second engine', () => {
  assert.throws(() => createSubscriptionLegacyAdapter(null), TypeError);
  const { adapter, state } = mockAdapter();
  delete adapter.prepareCall;
  assert.throws(() => createSubscriptionLegacyAdapter(adapter), /complete initialized subscription LlmAdapter/);
  assert.equal(state.calls.length, 0);
});
