// Public packages only. This module never reads the host's global Codex slot,
// environment keys, ~/.codex, or an installation-private path.
export async function createOfficialDriver({ credentials }, load = async () => {
  const [{ createModels }, { openaiCodexProvider }, { PiAiAdapter }] = await Promise.all([
    import('@earendil-works/pi-ai'), import('@earendil-works/pi-ai/providers/openai-codex'), import('@deepseek-ai/dsh-llm-pi-ai'),
  ]);
  return { createModels, openaiCodexProvider, PiAiAdapter };
}) {
  const { createModels, openaiCodexProvider, PiAiAdapter } = await load();
  const authContext = Object.freeze({ env: async () => undefined, fileExists: async () => false });
  const auth = { credentials, authContext }, provider = openaiCodexProvider();
  if (provider.id !== 'openai-codex' || provider.auth?.oauth?.isSubscription !== true) throw new Error('SUBSCRIPTION_DRIVER_REQUIRED');
  const models = createModels(auth); models.setProvider(provider);
  const retryPolicy = Object.freeze({ mode: 'normal', maxRetries: 0, retryableCodes: ['TRANSPORT'], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0 });
  const profiles = new Map([['openai-codex', { provider: 'openai-codex', displayName: 'ChatGPT Codex OAuth',
    piProvider: provider, transport: 'sse', streamIdleTimeoutMs: 60000, maxRequestImageBytes: 10485760, requestImagePixelBudget: 16777216, requestImageMaxBytes: 10485760,
    retryPolicy, modelErrors: new Map(), configuredMaxTokens: new Map() }]]);
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => undefined, auth });
  return Object.freeze({
    login: interaction => models.login('openai-codex', 'oauth', interaction),
    async auth(signal) {
      const resolution = await models.getAuth('openai-codex', { signal });
      if (resolution?.source !== 'OAuth' || !resolution.auth?.apiKey) throw new Error('SUBSCRIPTION_OAUTH_REQUIRED');
      return resolution.auth;
    },
    listModels: () => adapter.listModels('openai-codex'),
    prepare: model => adapter.prepareCall('openai-codex', model),
  });
}

// The default is captured BEFORE the first await, not on first iterator.next().
// Bound model IDs use opaque local account/model hashes, never a real login ID.
export function createBoundAdapter(service) {
  const routes = async () => {
    const data = await service.bindings(), all = [];
    for (const row of data.accounts) for (const model of row.models) all.push({ provider: 'codex-accounts', id: `${row.accountKey}:${model.modelKey}`, name: `${row.label} · ${model.modelName}`, inputModalities: ['text'] });
    const first = data.accounts[0];
    if (first) for (const model of first.models) all.push({ provider: 'codex-accounts', id: `default:${model.baseId}`, name: `默认新请求账号 · ${model.modelName}`, inputModalities: ['text'] });
    return all;
  };
  const resolve = (model, data) => {
    if (typeof model !== 'string') throw new Error('BOUND_MODEL_REQUIRED');
    if (model.startsWith('default:')) return service.prepareDefault(model.slice(8));
    const parts = model.split(':');
    if (parts.length !== 2 || !/^[a-f0-9]{16}$/.test(parts[0]) || !/^[a-f0-9]{64}$/.test(parts[1]) || model.length !== 81) throw new Error('BOUND_MODEL_REQUIRED');
    return service.prepare(parts[0], parts[1]);
  };
  return {
    providerInfo: provider => ({ id: provider, name: 'Codex 订阅 · 独立账号（本项目）' }),
    providerRetryPolicy: () => ({ mode: 'normal', maxRetries: 0, retryableCodes: ['TRANSPORT'], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0 }),
    imageRequestPricing: () => undefined,
    listModels: () => routes(),
    async resolveModel(provider, model) { const p = await resolve(model); return { ...p.info, provider, id: model, name: p.modelName }; },
    prepareCall(provider, model) {
      // A bound selector is already immutable. A changing default never rewrites it.
      const captured = resolve(model);
      return captured.then(p => ({ model: { ...p.info, provider, id: model, name: p.modelName }, stream: options => p.stream(options) }));
    },
    stream(options) { const captured = resolve(options.model); return (async function* () { const p = await captured; yield* p.stream(options); })(); },
  };
}
