import { createHash, randomUUID } from 'node:crypto';

// Audited against pi-ai 0.87.1: API SSE dispatch honors maxRetries:0 and
// per-call fetch; unexpected SDK builds remain non-executable.
export const WARMUP_SDK_SHA256 = '6e69310d77278231cfc87d7f03ee815d4a0f2ff273e6c43fcee6835e7df2b0c7';
export function verifyWarmupSdk({ version, source }) {
  return version === '0.87.1' && typeof source === 'string' && createHash('sha256').update(source).digest('hex') === WARMUP_SDK_SHA256;
}
const PROVIDER = 'openai-codex', POLICY = 'bound-standard-sse-v1';
const hash = text => createHash('sha256').update(text).digest('hex');
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE = /^[A-Z_]{1,64}$/;
const fail = (code, unsent = true, usage) => Object.assign(new Error(CODE.test(code) ? code : 'WARMUP_UNAVAILABLE'), { code, requestNotSent: unsent, ...(usage ? { usage } : {}) });
const identity = credential => {
  // Only the account id already saved by the managed OAuth lifecycle is used.
  // JWT decoding is deliberately not an account selector or authorization source.
  const id = credential?.accountId;
  if (credential?.type !== 'oauth' || typeof id !== 'string' || !id || id.length > 512) throw fail('WARMUP_IDENTITY_UNAVAILABLE');
  return id;
};
const generation = row => hash(`simple-pet-account-generation-v1\0${row.id}\0${identity(row.credential)}`);
// Reuse the pet's public row reference, so it can be compared with the
// subscription/current-account display without revealing the vault row id.
const reference = row => hash(row.id).slice(0, 16);
const subject = row => hash(`simple-pet-subscription-budget-v1\0${identity(row.credential)}`);
const usageDTO = usage => {
  if (!usage || typeof usage !== 'object') return undefined;
  const pairs = [['inputTokens', usage.input], ['outputTokens', usage.output], ['cacheReadTokens', usage.cacheRead], ['cacheWriteTokens', usage.cacheWrite]];
  return Object.fromEntries(pairs.filter(([, value]) => Number.isSafeInteger(value) && value >= 0));
};
function waitFor(operation, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(fail('WARMUP_CANCELLED', false));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

// Backend object capability delivered only by the embedded owner. There is no
// RPC for credential reads, arbitrary messages, provider selection or raw calls.
export function createSubscriptionWarmupService({ vault, createContext, sdkVerified, stream, modelFetch, now = Date.now, ownerEpoch = randomUUID() }) {
  let live = true, connected = false;
  const contexts = new Map(), lifetime = new AbortController();
  const supported = () => live && sdkVerified === true && typeof vault?.warmupSnapshot === 'function' && typeof vault?.forAccount === 'function';
  const capabilities = () => ({ contractVersion: 1, ownerEpoch, accountBound: supported(), maxAccounts: 8, manual: supported(), daily: supported(), startupFull: false, resetFull: false,
    ...supported() ? {} : { reason: live ? 'WARMUP_SDK_OR_OWNER_UNSUPPORTED' : 'WARMUP_OWNER_CLOSED' } });
  const check = signal => { if (!supported()) throw fail('WARMUP_SDK_OR_OWNER_UNSUPPORTED'); signal?.throwIfAborted(); };
  async function target(key, expectedGeneration, signal) {
    check(signal);
    const rows = await vault.warmupSnapshot(); check(signal);
    const matches = rows.filter(row => reference(row) === key);
    if (matches.length !== 1) throw fail('WARMUP_ACCOUNT_REVOKED');
    const row = matches[0];
    if (generation(row) !== expectedGeneration) throw fail('WARMUP_ACCOUNT_REVOKED');
    identity(row.credential);
    return row;
  }
  async function context(key, expectedGeneration, signal) {
    const row = await target(key, expectedGeneration, signal), cacheKey = `${key}:${expectedGeneration}`;
    let result = contexts.get(cacheKey);
    if (!result) {
      result = createContext(vault.forAccount(row.id, identity(row.credential)));
      result.verifiedAt = null;
      contexts.set(cacheKey, result);
    }
    return result;
  }
  const verified = ctx => Number.isSafeInteger(ctx.verifiedAt) && ctx.verifiedAt > 0 && now() >= ctx.verifiedAt && now() - ctx.verifiedAt < 86400000 && ctx.catalog.status().source === 'online' && ctx.catalog.status().refresh === 'ok';
  function models(ctx, key, gen) {
    if (!verified(ctx)) return [];
    return ctx.catalog.getModels().flatMap(model => {
      if (!MODEL_ID.test(model.id ?? '') || /^gpt-image/i.test(model.id) || !model.input?.includes('text') || model.baseUrl !== 'https://chatgpt.com/backend-api') return [];
      const meta = ctx.catalog.metadata(model.id);
      if (!meta || meta.retirement?.at <= now() || meta.unsupported?.reasoning?.length) return [];
      const map = meta.thinkingLevelMap;
      const effort = model.reasoning ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(level => map?.[level]).find(value => typeof value === 'string') : undefined;
      if (model.reasoning && !effort) return [];
      const modelKey = hash(`${POLICY}\0${key}\0${gen}\0${model.id}\0${effort ?? ''}`);
      return [{ modelKey, name: typeof model.name === 'string' && /^[\p{L}\p{N} ._():+\-]{1,120}$/u.test(model.name) ? model.name : model.id, model, effort }];
    });
  }
  async function listModels({ accountKey, accountGeneration, refresh = false, signal } = {}) {
    const ctx = await context(accountKey, accountGeneration, signal);
    if (refresh) {
      ctx.verifiedAt = null;
      try { await ctx.catalog.refresh({ signal }); check(signal); await target(accountKey, accountGeneration, signal); ctx.verifiedAt = now(); }
      catch { throw fail('WARMUP_CATALOG_UNAVAILABLE'); }
    }
    const entries = models(ctx, accountKey, accountGeneration);
    return { verified: verified(ctx), revision: hash(JSON.stringify(entries.map(({ modelKey }) => modelKey))), models: entries.map(({ modelKey, name }) => ({ modelKey, name })) };
  }
  async function readQuota({ accountKey, accountGeneration, refresh = false, signal } = {}) {
    const ctx = await context(accountKey, accountGeneration, signal);
    if (refresh) {
      try { const report = await ctx.quota.read({ force: true, signal }); check(signal); await target(accountKey, accountGeneration, signal); ctx.lastQuota = report; ctx.quotaFailed = false; }
      catch { ctx.quotaFailed = true; }
    }
    const q = ctx.lastQuota;
    // A known prohibition remains a prohibition, even after a later failed read.
    const windows = q?.rateLimits?.find(limit => limit.id === 'codex')?.windows;
    const restricted = q?.spendControlReached === true || q?.individualLimit?.remainingPercent === 0 || !!q?.rateLimitReachedType || windows?.some(window => window.remainingPercent <= 0);
    if (restricted) return { status: 'restricted', ...(q?.fetchedAt ? { fetchedAt: q.fetchedAt } : {}) };
    const fresh = !ctx.quotaFailed && q && Number.isSafeInteger(q.fetchedAt) && q.fetchedAt <= now() && now() - q.fetchedAt < 120000
      && Array.isArray(windows) && windows.length > 0 && windows.every(window => Number.isFinite(window.remainingPercent) && window.remainingPercent > 0 && window.windowSeconds > 0 && (!window.resetsAt || window.resetsAt * 1000 > now()));
    return { status: fresh ? 'ready' : 'unknown', ...(q?.fetchedAt ? { fetchedAt: q.fetchedAt } : {}) };
  }
  return Object.freeze({
    capabilities,
    connect(verifyReceipt) {
      if (connected || typeof verifyReceipt !== 'function') throw fail('WARMUP_COORDINATOR_ALREADY_BOUND');
      connected = true;
      return Object.freeze({
        capabilities,
        async listAccounts({ signal } = {}) {
          check(signal);
          const rows = await vault.warmupSnapshot(); check(signal);
          const accounts = [];
          for (const row of rows) {
            try {
              const accountKey = reference(row);
              accounts.push({ accountKey, accountGeneration: generation(row), budgetSubject: subject(row), active: row.active === true, label: `账号 #${accountKey.slice(0, 8)}` });
            } catch { /* An unverified identity is never an executable warmup row. */ }
          }
          if (new Set(accounts.map(row => row.accountKey)).size !== accounts.length) throw fail('WARMUP_ACCOUNT_COLLISION');
          return { accounts };
        },
        listModels, readQuota,
        async prepare(binding) {
          const { accountKey, accountGeneration, modelKey, signal, claimReceipt } = binding ?? {};
          if (binding?.ownerEpoch !== ownerEpoch || !claimReceipt || typeof claimReceipt !== 'object') throw fail('WARMUP_CLAIM_REQUIRED');
          const ctx = await context(accountKey, accountGeneration, signal);
          const selected = models(ctx, accountKey, accountGeneration).find(model => model.modelKey === modelKey);
          if (!selected) throw fail('WARMUP_MODEL_UNAVAILABLE');
          const expiresAt = now() + 60000;
          let used = false;
          return Object.freeze({ async execute({ signal: executionSignal } = {}) {
            if (used) throw fail('WARMUP_CAPABILITY_USED');
            used = true;
            const combined = AbortSignal.any([lifetime.signal, AbortSignal.timeout(60000), ...[signal, executionSignal].filter(Boolean)]);
            let crossed = false, usage, iterator;
            try {
              check(combined);
              if (now() >= expiresAt || await verifyReceipt(claimReceipt, binding) !== true) throw fail('WARMUP_CLAIM_REQUIRED');
              let row = await target(accountKey, accountGeneration, combined);
              const auth = await waitFor(() => ctx.resolveAuth({ signal: combined, minOAuthValidityMs: 60000 }), combined);
              row = await target(accountKey, accountGeneration, combined);
              if (auth?.auth?.apiKey !== row.credential.access || !auth.auth.apiKey) throw fail('WARMUP_AUTH_CHANGED');
              if (!models(ctx, accountKey, accountGeneration).some(model => model.modelKey === modelKey) || await verifyReceipt(claimReceipt, binding) !== true) throw fail('WARMUP_AUTHORIZATION_CHANGED');
              check(combined);
              let sends = 0;
              const access = row.credential.access, accountId = identity(row.credential);
              const guardedFetch = async (input, init) => {
                check(combined);
                if (++sends !== 1) throw fail('WARMUP_SECOND_DISPATCH_FORBIDDEN', false);
                const url = String(input);
                const headers = new Headers(init?.headers);
                if (url !== 'https://chatgpt.com/backend-api/codex/responses' || init?.method !== 'POST' || headers.get('authorization') !== `Bearer ${access}` || headers.get('chatgpt-account-id') !== accountId) throw fail('WARMUP_ROUTE_MISMATCH', false);
                const current = await target(accountKey, accountGeneration, combined);
                if (current.credential.access !== access || await verifyReceipt(claimReceipt, binding) !== true) throw fail('WARMUP_AUTHORIZATION_CHANGED', false);
                return modelFetch(input, { ...init, redirect: 'error', signal: combined });
              };
              // Direct audited SDK API: no PiAiAdapter, Models.stream, session,
              // review, compaction or global profile; one guarded SSE dispatch.
              crossed = true;
              const events = stream(selected.model, { messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply only OK.' }], timestamp: now() }], tools: [] }, {
                apiKey: access, signal: combined, transport: 'sse', maxRetries: 0, cacheRetention: 'none', timeoutMs: 60000,
                ...(selected.effort ? { reasoningEffort: selected.effort } : {}),
                fetch: guardedFetch,
                onPayload: payload => ({ model: selected.model.id, store: false, stream: true, instructions: 'Reply only OK.', input: payload.input,
                  text: { verbosity: 'low' }, tools: [], tool_choice: 'none', parallel_tool_calls: false,
                  ...(selected.effort ? { reasoning: { effort: selected.effort } } : {}) }),
              });
              iterator = events[Symbol.asyncIterator]();
              let done = false, text = false;
              for (;;) {
                const step = await waitFor(() => iterator.next(), combined);
                if (step.done) break;
                const event = step.value;
                if (event?.type === 'error') { usage = usageDTO(event.error?.usage); throw fail('WARMUP_MODEL_FAILED', false, usage); }
                if (event?.type === 'text_delta') text ||= /\S/.test(event.delta ?? '');
                if (event?.type === 'done') {
                  if (done || event.reason !== 'stop') throw fail('WARMUP_INCOMPLETE', false);
                  done = true; usage = usageDTO(event.message?.usage);
                  text ||= event.message?.content?.some(part => part.type === 'text' && /\S/.test(part.text ?? '')) === true;
                }
              }
              combined.throwIfAborted(); check(combined);
              if (!done || !text) throw fail('WARMUP_INCOMPLETE', false, usage);
              return { ...(usage ? { usage } : {}) };
            } catch (cause) {
              throw fail(CODE.test(cause?.code ?? '') ? cause.code : 'WARMUP_EXECUTION_FAILED', !crossed, usage);
            } finally {
              // Do not await a broken iterator forever. The coordinator latches
              // unknown and never starts a successor after a cancellation.
              try { Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* fail closed */ }
            }
          } });
        },
      });
    },
    dispose() { live = false; lifetime.abort(); for (const ctx of contexts.values()) ctx.catalog.clear(); contexts.clear(); },
  });
}
