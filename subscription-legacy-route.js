// Compatibility route only: the caller owns the initialized subscription adapter
// and its Cordis lifecycle. This module has no account/config/credential store.
const LEGACY_PROVIDER = 'codex-accounts';
const SUBSCRIPTION_PROVIDER = 'openai-codex';
const RESELECT = '旧 Codex 账号模型无法安全迁移；请在原聊天中重新选择内置订阅模型。历史记录未修改，也不会自动重发请求。';

function failure(message, code) {
  return Object.assign(new Error(message), { code });
}

function subscriptionModel(provider, model) {
  if (provider !== LEGACY_PROVIDER) {
    throw failure('Legacy subscription adapter only owns codex-accounts.', 'NO_ADAPTER');
  }
  if (typeof model !== 'string') throw failure(RESELECT, 'LEGACY_MODEL_RESELECT_REQUIRED');
  const match = /^(?:[a-fA-F0-9]{16}|default):([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/.exec(model);
  // The old SHA-256 suffix is an account-dependent lookup key, NOT a model slug.
  // Never consult the retired account registry or guess from a replay envelope.
  if (!match || match[0] !== model || /^[a-fA-F0-9]{64}$/.test(match[1])) {
    throw failure(RESELECT, 'LEGACY_MODEL_RESELECT_REQUIRED');
  }
  return match[1];
}

function externalModel(info, provider, model) {
  return { ...info, provider, id: model };
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function subscriptionReplay(message) {
  const { replayState, provider, model } = message.source;
  // Never unwrap the retired account envelope, even if its account key happens
  // to match a selector. Only the unified adapter's pi-ai v2 envelope is native.
  if (!record(replayState) || replayState.kind !== undefined || !record(replayState.response)) return false;
  const response = replayState.response;
  if (response.kind !== 'pi-ai' || response.version !== 2 || response.provider !== SUBSCRIPTION_PROVIDER
    || response.api !== 'openai-codex-responses' || typeof response.model !== 'string' || !response.model
    || !['stop', 'length', 'toolUse', 'error', 'aborted'].includes(response.stopReason)) return false;
  for (const key of ['responseModel', 'responseId', 'providerThinkingLevel']) {
    if (response[key] !== undefined && typeof response[key] !== 'string') return false;
  }
  if (provider === LEGACY_PROVIDER) {
    try { if (subscriptionModel(provider, model) !== response.model) return false; }
    catch { return false; } // Historical opaque selectors cannot establish a native model identity.
  } else if (provider !== SUBSCRIPTION_PROVIDER || model !== response.model) return false;
  return Array.isArray(replayState.blocks) && replayState.blocks.length === message.content.length
    && replayState.blocks.every((block, index) => record(block)
      && ['text', 'reasoning', 'tool-call'].includes(block.type) && block.type === message.content[index].type
      && ['textSignature', 'thinkingSignature', 'thoughtSignature'].every(key => block[key] === undefined || typeof block[key] === 'string')
      && (block.redacted === undefined || typeof block.redacted === 'boolean'));
}

function subscriptionHistory(messages) {
  return messages.map(message => {
    if (message.role !== 'assistant' || message.source?.replayState === undefined) return message;
    const { replayState, ...source } = message.source;
    if (!subscriptionReplay(message)) return { ...message, source };
    // A pi-ai envelope has no trusted account identity. Never forward native
    // response IDs or thinking/text/tool signatures through this legacy alias.
    // Only carry the bridge-owned checkpoint; the bridge validates its account,
    // model, age and hashes. Pi-ai degrades this carrier to neutral history.
    // Project source identically on EVERY turn so the bridge prefix is stable.
    const projected = { ...source, provider: SUBSCRIPTION_PROVIDER, model: replayState.response.model };
    if (record(replayState.response.codexCompactionV1)) {
      projected.replayState = { response: { codexCompactionV1: replayState.response.codexCompactionV1 } };
    }
    return { ...message, source: projected };
  });
}

function subscriptionOptions(options, model) {
  // Forward public request controls, not plugin-private account, credential,
  // endpoint, reasoning-default, or Fast/service-tier overrides. The initialized
  // subscription adapter is the sole authority for authentication and defaults.
  const forwarded = { provider: SUBSCRIPTION_PROVIDER, model };
  for (const key of [
    'system', 'tools', 'toolChoice', 'toolHistory', 'reasoningEffort',
    'temperature', 'maxTokens', 'stop', 'signal', 'sessionId',
  ]) {
    if (Object.hasOwn(options, key)) forwarded[key] = options[key];
  }
  forwarded.messages = subscriptionHistory(options.messages);
  return forwarded;
}

/**
 * Wrap an already initialized, complete public LlmAdapter.
 * Register in the SAME Cordis fork/lifecycle as that adapter:
 *   ctx.llm.registerAdapter(['codex-accounts'], createSubscriptionLegacyAdapter(adapter));
 * No migration, history submission, account engine, or ctx.llm.stream call occurs.
 * Native replay uses request-local source identities; durable history and all
 * checkpoint hashes remain untouched. Retired/foreign replay is never unwrapped.
 */
export function createSubscriptionLegacyAdapter(adapter) {
  for (const method of ['providerInfo', 'providerRetryPolicy', 'imageRequestPricing', 'listModels', 'resolveModel', 'prepareCall', 'stream']) {
    if (typeof adapter?.[method] !== 'function') {
      throw new TypeError(`A complete initialized subscription LlmAdapter is required (${method}).`);
    }
  }
  const wrapper = {
    providerInfo(provider) {
      if (provider !== LEGACY_PROVIDER) subscriptionModel(provider, '');
      return { ...adapter.providerInfo(SUBSCRIPTION_PROVIDER), id: provider, name: 'Codex 旧聊天 · 跟随当前内置订阅账号' };
    },
    providerRetryPolicy(provider) {
      if (provider !== LEGACY_PROVIDER) subscriptionModel(provider, '');
      return adapter.providerRetryPolicy(SUBSCRIPTION_PROVIDER);
    },
    imageRequestPricing(provider, model) {
      return adapter.imageRequestPricing(SUBSCRIPTION_PROVIDER, subscriptionModel(provider, model));
    },
    async listModels(provider) {
      if (provider !== LEGACY_PROVIDER) subscriptionModel(provider, '');
      return []; // Existing conversations only; never advertise retired selectors.
    },
    async resolveModel(provider, model, signal) {
      const bare = subscriptionModel(provider, model);
      return externalModel(await adapter.resolveModel(SUBSCRIPTION_PROVIDER, bare, signal), provider, model);
    },
    async prepareCall(provider, model, signal) {
      const bare = subscriptionModel(provider, model);
      // Capture before the first await. Do not separately resolve metadata or
      // later use adapter.stream: that could mix two subscription generations.
      const pending = adapter.prepareCall(SUBSCRIPTION_PROVIDER, bare, signal);
      const prepared = await pending;
      let dispatched = false;
      return {
        model: externalModel(prepared.model, provider, model),
        stream(options) {
          if (dispatched || options.provider !== provider || options.model !== model) {
            throw failure('Prepared legacy subscription call is one-shot and route-bound.', 'INVALID_PREPARED_CALL');
          }
          dispatched = true;
          // Return the original iterator directly, preserving return()/throw(),
          // abort signals and all usage/finish/error/offload chunks unchanged.
          return prepared.stream(subscriptionOptions(options, bare));
        },
      };
    },
    stream(options) {
      // Start preparation now, not at first iterator.next(). No history is sent
      // unless a caller explicitly consumes this new request's stream.
      const pending = wrapper.prepareCall(options.provider, options.model, options.signal);
      // Mark an early refusal handled even when a caller abandons the iterator.
      pending.catch(() => {});
      return (async function* () {
        const prepared = await pending;
        yield* prepared.stream(options);
      })();
    },
  };
  return Object.freeze(wrapper);
}
