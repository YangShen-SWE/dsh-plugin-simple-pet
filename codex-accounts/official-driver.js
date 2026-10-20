// Public packages only. This module never reads the host's global Codex slot,
// environment keys, ~/.codex, or an installation-private path.
import { withSpeedPreference } from './request-preferences.js';
import { inspectAccountModelCatalogue, fetchAccountModels, MODEL_CATALOGUE_CLIENT_VERSION, MODEL_CATALOGUE_PROFILE } from './model-catalogue.js';

export async function createOfficialDriver({ credentials, runtime = {} }, load = async () => {
  const [{ createModels }, { openaiCodexProvider }, { PiAiAdapter }, { resolveImageAttachmentAccess, LlmError }] = await Promise.all([
    import('@earendil-works/pi-ai'), import('@earendil-works/pi-ai/providers/openai-codex'), import('@deepseek-ai/dsh-llm-pi-ai'), import('@deepseek-ai/dsh-llm'),
  ]);
  return { createModels, openaiCodexProvider, PiAiAdapter, resolveImageAttachmentAccess, LlmError };
}) {
  const { createModels, openaiCodexProvider, PiAiAdapter, resolveImageAttachmentAccess, LlmError } = await load();
  const authContext = Object.freeze({ env: async () => undefined, fileExists: async () => false });
  const auth = { credentials, authContext }, provider = openaiCodexProvider();
  if (provider.id !== 'openai-codex' || provider.auth?.oauth?.isSubscription !== true) throw new Error('SUBSCRIPTION_DRIVER_REQUIRED');
  const models = createModels(auth); models.setProvider(provider);
  const retryPolicy = Object.freeze({ mode: 'normal', maxRetries: 0, retryableCodes: ['TRANSPORT'], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0 });
  let profiles = new Map([['openai-codex', { provider: 'openai-codex', displayName: 'ChatGPT Codex OAuth',
    piProvider: provider, transport: 'sse', streamIdleTimeoutMs: 600000, maxRequestImageBytes: 10485760, requestImagePixelBudget: 16777216, requestImageMaxBytes: 10485760,
    retryPolicy, modelErrors: new Map(), configuredMaxTokens: new Map() }]]);
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => undefined, auth,
    resolveAttachments: () => runtime.attachments?.(),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess?.(attachments, hostPath => runtime.filesystem?.()?.processPathFromHostPath(hostPath), ref),
  });
  const builtin = provider.getModels?.() ?? [];
  let speedCapabilities = new Map();
  let etag = null, revision = 0, refreshGeneration = 0, catalog = { source: 'builtin', status: 'not-refreshed', clientObservedAt: null, error: null, clientVersion: MODEL_CATALOGUE_CLIENT_VERSION, requestProfile: MODEL_CATALOGUE_PROFILE.id, requestMode: null };
  const safeAuth = async signal => {
    const resolution = await models.getAuth('openai-codex', { signal });
    if (resolution?.source !== 'OAuth' || !resolution.auth?.apiKey) throw new Error('SUBSCRIPTION_OAUTH_REQUIRED');
    return resolution.auth;
  };
  return Object.freeze({
    login: interaction => models.login('openai-codex', 'oauth', interaction),
    auth: safeAuth,
    catalogStatus: () => ({ ...catalog, revision }),
    isPreflightError: error => typeof LlmError === 'function' && error instanceof LlmError && ['UNSUPPORTED_CONTENT','UNSUPPORTED_OPTION','UNSUPPORTED_REASONING_EFFORT','IMAGE_OFFLOAD_REQUIRED'].includes(error.code),
    preflightFailure(error) {
      if (typeof LlmError !== 'function' || !(error instanceof LlmError) || error.code !== 'IMAGE_OFFLOAD_REQUIRED') return;
      const count = error.failure?.offloadImages;
      if (!Number.isSafeInteger(count) || count <= 0) return;
      // Preserve only the public host control protocol, never the SDK message,
      // cause, request ID, attachment references or upstream response body.
      return Object.assign(new LlmError('Request image budget requires offloading earlier images.', 'IMAGE_OFFLOAD_REQUIRED', { offloadImages: count }), { requestNotSent: true });
    },
    async refreshModels(signal, { force = false } = {}) {
      const generation = ++refreshGeneration;
      const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10000)]);
      try {
        const authValue = await safeAuth(combined), grant = await credentials.read('openai-codex');
        if (!grant || grant.access !== authValue.apiKey) throw new Error('MODEL_CATALOG_AUTH_REQUIRED');
        const response = await fetchAccountModels({ auth: authValue.apiKey, accountId: grant.accountId, signal: combined, etag: force ? null : etag, fetchImpl: runtime.fetchImpl });
        combined.throwIfAborted();
        if (generation !== refreshGeneration) throw new Error('MODEL_CATALOG_SUPERSEDED');
        if (response.notModified && force) throw new Error('MODEL_CATALOG_INVALID');
        if (!response.notModified) {
          const report = inspectAccountModelCatalogue(response.raw, builtin);
          catalog = { ...catalog, receivedCount: report.receivedCount, includedCount: report.models.length, omitted: report.omitted, capabilityGaps: report.capabilityGaps,
            targetModel: report.targetModel, requestMode: force ? 'full' : 'conditional' };
          const next = report.models;
          if (!next.length) throw new Error('MODEL_CATALOG_EMPTY');
          // pi-ai requires numeric costs internally; this placeholder is not a price quote.
          const sdkRows=next.map(row=>row.cost?row:{...row,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}});
          const piProvider = { ...provider, getModels: () => sdkRows };
          // PiAiAdapter snapshots by Map identity: replacing only the array is insufficient.
          profiles = new Map([['openai-codex', { ...profiles.get('openai-codex'), piProvider }]]);
          speedCapabilities = new Map(next.map(row => [row.id, row.speedModes]));
          etag = response.etag; revision++;
        } else if (!revision) throw new Error('MODEL_CATALOG_INVALID');
        catalog = { ...catalog, source: 'account-catalog', status: 'ready', clientObservedAt: Date.now(), error: null };
        return { ...catalog, revision };
      } catch (error) {
        const code = /^MODEL_CATALOG_(AUTH_REQUIRED|INVALID|TOO_LARGE|EMPTY|UNAVAILABLE|SUPERSEDED)$/.test(error?.message || '') ? error.message : 'MODEL_CATALOG_UNAVAILABLE';
        if (generation === refreshGeneration) catalog = { ...catalog, status: 'stale', error: code };
        throw new Error(code);
      }
    },
    async listModels() {
      const rows = await adapter.listModels('openai-codex');
      return Promise.all(rows.map(async row => ({ ...row, ...await adapter.resolveModel?.('openai-codex', row.id),
        speedModes: catalog.status === 'ready' ? speedCapabilities.get(row.id) ?? ['standard'] : ['standard'] })));
    },
    async prepare(model, { speedMode = 'standard' } = {}) {
      if (!['standard','fast'].includes(speedMode) || (speedMode === 'fast' && (catalog.status !== 'ready' || !speedCapabilities.get(model)?.includes('fast')))) throw new Error('SPEED_UNAVAILABLE');
      // A separate profile captures speed for this prepared request. Never mutate
      // a shared provider or read a changing setting during an in-flight stream.
      const profile = profiles.get('openai-codex');
      const localProfiles = new Map([['openai-codex', { ...profile, piProvider: withSpeedPreference(profile.piProvider, speedMode) }]]);
      const localAdapter = new PiAiAdapter({ profiles: () => localProfiles, resolveApiKey: async () => undefined, auth,
        resolveAttachments: () => runtime.attachments?.(),
        resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess?.(attachments, hostPath => runtime.filesystem?.()?.processPathFromHostPath(hostPath), ref) });
      const prepared = await localAdapter.prepareCall('openai-codex', model);
      return { ...prepared, stream(options) {
        // Codex subscription Responses does not support temperature. Do not leak
        // generic chat defaults into a request which otherwise has valid OAuth.
        const { temperature, ...supported } = options;
        if (Array.isArray(supported.stop) && supported.stop.length === 0) delete supported.stop;
        return prepared.stream(supported);
      } };
    },
  });
}

// The default is captured BEFORE the first await, not on first iterator.next().
// Bound model IDs use opaque local account/model hashes, never a real login ID.
export function createBoundAdapter(service) {
  const routes = async () => {
    const data = await service.bindings(), all = [];
    for (const row of data.accounts) for (const model of row.models) all.push({ provider: 'codex-accounts', id: `${row.accountKey}:${model.baseId}`, name: `${row.label} · ${model.modelName}`, inputModalities: model.inputModalities ?? ['text'], ...(model.reasoning ? {reasoning:model.reasoning} : {}) });
    const selected = data.accounts.find(row=>row.selected===true);
    if (selected) for (const model of selected.models) all.push({ provider: 'codex-accounts', id: `default:${model.baseId}`, name: `默认新请求账号 · ${model.modelName}`, inputModalities: model.inputModalities ?? ['text'], ...(model.reasoning ? {reasoning:model.reasoning} : {}) });
    return all;
  };
  const resolve = (model, data) => {
    if (typeof model !== 'string') throw new Error('BOUND_MODEL_REQUIRED');
    if (model.startsWith('default:')) return service.prepareDefault(model.slice(8));
    const parts = model.split(':');
    if (parts.length !== 2 || !/^[a-f0-9]{16}$/.test(parts[0]) || parts[0].length!==16) throw new Error('BOUND_MODEL_REQUIRED');
    // Old 64-hex routes remain accepted for existing conversations. New picker
    // entries use a readable official model slug, never a real account/login ID.
    if (/^[a-f0-9]{64}$/.test(parts[1]) && parts[1].length===64) return service.prepare(parts[0],parts[1]);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(parts[1]) || parts[1].trim()!==parts[1]) throw new Error('BOUND_MODEL_REQUIRED');
    return service.prepareSlug(parts[0],parts[1]);
  };
  return {
    providerInfo: provider => ({ id: provider, name: 'Codex 订阅 · 独立账号（本项目）' }),
    providerRetryPolicy: () => ({ mode: 'normal', maxRetries: 0, retryableCodes: ['TRANSPORT'], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0 }),
    imageRequestPricing: () => undefined,
    listModels: () => routes(),
    async resolveModel(provider, model) { if(provider!=='codex-accounts')throw new Error('BOUND_PROVIDER_REQUIRED');const p = await resolve(model); return { ...p.info, provider, id: model, name: p.modelName }; },
    prepareCall(provider, model) {
      if(provider!=='codex-accounts')throw new Error('BOUND_PROVIDER_REQUIRED');
      // A bound selector is already immutable. A changing default never rewrites it.
      const captured = resolve(model);
      return captured.then(p => ({ model: { ...p.info, provider, id: model, name: p.modelName }, stream: options => p.stream(options) }));
    },
    stream(options) { if(options.provider!=='codex-accounts')throw new Error('BOUND_PROVIDER_REQUIRED');const captured = resolve(options.model); return (async function* () { const p = await captured; yield* p.stream(options); })(); },
  };
}
