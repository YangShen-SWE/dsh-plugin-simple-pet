import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { ROTATION_STRATEGIES, normalizeRotationConfig, rotationUsageSummary, recommendRotation } from './subscription-rotation-policy.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
export function rotationBinding(row) {
  if (typeof row?.id !== 'string' || row.credential?.type !== 'oauth' || typeof row.credential.accountId !== 'string' || !row.credential.accountId) throw fail('ROTATION_IDENTITY_UNKNOWN');
  return { accountKey: hash(row.id).slice(0, 16), accountGeneration: hash(`simple-pet-account-generation-v1\0${row.id}\0${row.credential.accountId}`),
    budgetSubject: hash(`simple-pet-subscription-budget-v1\0${row.credential.accountId}`), active: row.active === true };
}
// Remove account-scoped native IDs/signatures on a request copy, including on
// subsequent turns. A bridge-owned checkpoint is validated again by the bridge.
export function rotationHistory(messages) {
  return messages.map(message => {
    if (message.role !== 'assistant' || !message.source?.replayState) return message;
    const { replayState, ...source } = message.source;
    const checkpoint = replayState.response?.codexCompactionV1;
    return { ...message, source: { ...source, ...(checkpoint ? { replayState: { response: { codexCompactionV1: checkpoint } } } : {}) } };
  });
}
async function quotaRejected(response) {
  if (response.status !== 429) return false;
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  let text = '', bytes = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16384) return false;
      text += decoder.decode(value, { stream: true });
    }
    const error = JSON.parse(text + decoder.decode())?.error;
    // A generic 429, IP throttle, network message or authentication rejection
    // cannot authorize cross-account continuation.
    return error?.type === 'usage_limit_reached' || error?.code === 'usage_limit_reached';
  } catch { return false; }
  finally { reader.cancel().catch(() => {}); }
}
const zeroUsage = usage => usage && typeof usage === 'object'
  && ['inputTokens', 'outputTokens', 'totalTokens'].every(key => Object.hasOwn(usage, key) && usage[key] === 0)
  && Object.entries(usage).every(([key, value]) =>
  ['inputTokens','outputTokens','cachedInputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens','totalTokens'].includes(key) && Number.isFinite(value) && value === 0);

/** Same-owner rotation; model dispatch stays in the original host step. */
export function createSubscriptionRotation({ vault, createContext, readConfig, writeConfig, onSelected, now = Date.now }) {
  const scope = new AsyncLocalStorage(), contexts = new Map(), reports = new Map(), failures = new Map(), attempts = new WeakMap(), lastUsed = new Map();
  const lifetime = new AbortController();
  let busy = false, lastEvent;
  const config = () => normalizeRotationConfig(readConfig());
  const fingerprint = () => JSON.stringify(config());
  const event = (code, from, to) => { lastEvent = { at: now(), code, ...(from ? { from: from.accountKey } : {}), ...(to ? { to: to.accountKey } : {}), strategy: config().strategy }; };
  async function rows() {
    if (lifetime.signal.aborted || !vault?.warmupSnapshot) return [];
    return (await vault.warmupSnapshot()).flatMap(row => {
      try { return [{ ...rotationBinding(row), id: row.id, identity: row.credential.accountId,
        label: typeof row.label === 'string' ? row.label.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48) : '' }]; } catch { return []; }
    }).slice(0, 32);
  }
  const authorized = (row, value = config()) => value.accounts.some(item => item.accountKey === row.accountKey && item.accountGeneration === row.accountGeneration);
  async function current() {
    const epoch = vault?.selectionEpoch?.();
    const row = (await rows()).find(row => row.active);
    if (!row || epoch !== vault.selectionEpoch()) throw fail('ROTATION_ACCOUNT_CHANGED');
    return { ...row, selectionEpoch: epoch };
  }
  function context(row) {
    const key = row.accountGeneration;
    if (!contexts.has(key)) contexts.set(key, createContext(vault.forAccount(row.id, row.identity)));
    return contexts.get(key);
  }
  async function refreshRow(row, signal) {
    try {
      const report = await context(row).quota.read({ force: true, signal });
      signal?.throwIfAborted();
      reports.set(row.accountGeneration, report);
    } catch { reports.delete(row.accountGeneration); }
    return { ...row, usage: rotationUsageSummary(reports.get(row.accountGeneration), now()) };
  }
  async function status() {
    const value = config();
    return { config: value, strategies: ROTATION_STRATEGIES, accounts: (await rows()).map(row => ({
      accountKey: row.accountKey, accountGeneration: row.accountGeneration, active: row.active, label: row.label ? `${row.label} (#${row.accountKey.slice(0, 8)})` : `账号 #${row.accountKey.slice(0, 8)}`,
      usage: rotationUsageSummary(reports.get(row.accountGeneration), now()),
    })), busy, ...(lastEvent ? { lastEvent } : {}) };
  }
  async function update(input) {
    const { acknowledged, ...raw } = input ?? {};
    const value = normalizeRotationConfig(raw);
    if (value.enabled && acknowledged !== true) throw fail('ROTATION_ACKNOWLEDGEMENT_REQUIRED');
    const available = await rows();
    if (value.accounts.some(item => !available.some(row => row.accountKey === item.accountKey && row.accountGeneration === item.accountGeneration))) throw fail('ROTATION_ACCOUNT_CHANGED');
    if (value.enabled && value.accounts.length < 2) throw fail('ROTATION_TWO_ACCOUNTS_REQUIRED');
    await writeConfig(value);
    event(value.enabled ? 'ROTATION_ENABLED' : 'ROTATION_DISABLED');
    return status();
  }
  async function refresh({ signal } = {}) {
    if (busy) throw fail('ROTATION_BUSY');
    busy = true;
    const combined = AbortSignal.any([lifetime.signal, AbortSignal.timeout(60000), ...[signal].filter(Boolean)]);
    try { for (const row of await rows()) { combined.throwIfAborted(); await refreshRow(row, combined); } return await status(); }
    finally { busy = false; }
  }
  function requestOptions(options) {
    const state = scope.getStore();
    if (!state?.enabled) return options;
    const base = options.fetch ?? globalThis.fetch;
    return { ...options, transport: 'sse', maxRetries: 0, fetch: async (input, init) => {
      lifetime.signal.throwIfAborted();
      state.signal?.throwIfAborted();
      if (fingerprint() !== state.config || vault.selectionEpoch() !== state.binding.selectionEpoch) throw fail('ROTATION_ACCOUNT_CHANGED');
      const url = String(input);
      if (url !== 'https://chatgpt.com/backend-api/codex/responses' || init?.method !== 'POST') throw fail('ROTATION_ROUTE_CHANGED');
      // One HTTP model dispatch per host attempt, even if a changed SDK retries.
      if (++state.dispatches !== 1) throw fail('ROTATION_SECOND_DISPATCH_FORBIDDEN');
      const response = await base(input, { ...init, redirect: 'error' });
      if (await quotaRejected(response)) state.quotaRejected = true;
      return response;
    } };
  }
  function wrapAdapter(adapter, runBound) {
    const prepare = async (provider, model, signal) => {
      signal = AbortSignal.any([lifetime.signal, ...[signal].filter(Boolean)]);
      signal.throwIfAborted();
      if (!vault?.warmupSnapshot) return adapter.prepareCall(provider, model, signal);
      const binding = await current();
      const state = { binding, model, enabled: config().enabled, config: fingerprint(), signal, dispatches: 0, quotaRejected: false };
      const run = operation => scope.run(state, () => runBound(binding, signal, operation));
      const call = await run(() => adapter.prepareCall(provider, model, signal));
      let used = false;
      return { ...call, stream(options) {
        if (used) throw fail('ROTATION_PREPARED_CALL_USED');
        used = true;
        signal = AbortSignal.any([signal, ...[options.signal].filter(Boolean)]);
        state.signal = signal;
        return (async function* () {
          signal.throwIfAborted();
          let unsafe = false, terminal = false, sawZeroUsage = false;
          const iterator = run(() => call.stream({ ...options, signal, messages: rotationHistory(options.messages) })[Symbol.asyncIterator]());
          try {
            for (;;) {
              signal.throwIfAborted();
              const item = await run(() => iterator.next());
              if (item.done) break;
              let chunk = item.value;
              if (chunk.type === 'usage') { const zero = zeroUsage(chunk.usage); unsafe ||= !zero; sawZeroUsage ||= zero; }
              else if (chunk.type !== 'finish') unsafe = true;
              if (chunk.type === 'finish') {
                if (terminal) unsafe = true;
                terminal = true;
                const failure = chunk.reason?.kind === 'error' ? chunk.reason.failure : null;
                if (state.enabled && failure && typeof failure === 'object') {
                  // The host detaches/normalizes failures. Object identity does
                  // not survive that boundary; only this opaque local marker does.
                  for (const [key, proof] of failures) if (now() - proof.at > 120000) failures.delete(key);
                  const requestId = `pet-rotation-${randomUUID()}`;
                  if (failures.size < 256) failures.set(requestId, { ...state, at: now(), safe: !unsafe && sawZeroUsage && state.dispatches === 1 && state.quotaRejected });
                  // Saturation still owns this failure; it must not drop into
                  // an older quota-wait/retry handler without output evidence.
                  chunk = { ...chunk, reason: { ...chunk.reason, failure: { ...failure, requestId } } };
                }
              }
              yield chunk;
            }
          } finally { await run(() => iterator.return?.()); }
        })();
      } };
    };
    return new Proxy(adapter, { get(target, key) {
      if (key === 'prepareCall') return prepare;
      if (key === 'stream') return options => (async function* () { const call = await prepare(options.provider, options.model, options.signal); yield* call.stream(options); })();
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
  async function handle(payload, next) {
    const proof = failures.get(payload.failure?.requestId);
    failures.delete(payload.failure?.requestId);
    if (!proof) return typeof payload.failure?.requestId === 'string' && payload.failure.requestId.startsWith('pet-rotation-') ? undefined : next();
    if (!config().enabled) return undefined;
    if (!proof.safe || now() - proof.at > 120000 || busy || !['openai-codex','codex-accounts'].includes(payload.provider) || payload.signal?.aborted || lifetime.signal.aborted) return undefined;
    const { agent, turn, step } = payload;
    if (!agent || !Number.isSafeInteger(turn) || !Number.isSafeInteger(step) || typeof agent.session?.append !== 'function') return undefined;
    let history = attempts.get(agent);
    if (!history || history.turn !== turn || history.step !== step) { history = { turn, step, subjects: new Set(), count: 0 }; attempts.set(agent, history); }
    // Count the original dispatch too: at most eight distinct subjects total.
    if (history.count >= 7) { event('ROTATION_ATTEMPT_LIMIT'); return undefined; }
    busy = true;
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(60000), ...[payload.signal].filter(Boolean)]);
    try {
      if (fingerprint() !== proof.config) throw fail('ROTATION_CONFIGURATION_CHANGED');
      const from = await current();
      if (from.accountGeneration !== proof.binding.accountGeneration || from.selectionEpoch !== proof.binding.selectionEpoch || !authorized(from)) throw fail('ROTATION_ACCOUNT_CHANGED');
      const value = config();
      history.subjects.add(from.budgetSubject);
      const candidates = [];
      for (const row of await rows()) {
        signal.throwIfAborted();
        if (!row.active && authorized(row, value) && !history.subjects.has(row.budgetSubject)) {
          const candidate = await refreshRow(row, signal);
          if (candidate.usage.status !== 'ready') continue;
          try {
            const catalog = context(row).catalog;
            await catalog.refresh({ signal });
            if (catalog.status().source === 'online' && catalog.status().refresh === 'ok' && catalog.getModels().some(model => model.id === proof.model)) candidates.push(candidate);
          } catch { /* Model support must be verified for this account, never guessed. */ }
        }
      }
      const to = recommendRotation(candidates, { strategy: value.strategy, reservePercent: value.reservePercent, excludeSubjects: [...history.subjects], lastUsed: Object.fromEntries(lastUsed) }, now());
      if (!to) { event('ROTATION_NO_ELIGIBLE_ACCOUNT', from); return undefined; }
      signal.throwIfAborted();
      if (fingerprint() !== proof.config) throw fail('ROTATION_CONFIGURATION_CHANGED');
      const retryId = `codex-rotation-${turn}-${step}-${history.count + 1}`;
      agent.session.append('llm/retry', { retryId, turn, step, provider: payload.provider, mode: 'normal', policyKey: retryId, retry: 1, maxRetries: 1, delayMs: 0,
        failure: { code: 'RATE_LIMIT', message: `Codex quota exhausted; rotating to approved account #${to.accountKey.slice(0, 8)} (${value.strategy}).` } });
      history.count++;
      history.subjects.add(to.budgetSubject);
      const selectedEpoch = await vault.selectRotation({ from, to, validate: () => {
        signal.throwIfAborted();
        if (fingerprint() !== proof.config) throw fail('ROTATION_CONFIGURATION_CHANGED');
        return true;
      } });
      lastUsed.set(to.budgetSubject, now());
      await onSelected({ signal });
      signal.throwIfAborted();
      const ready = await current();
      if (fingerprint() !== proof.config || ready.accountGeneration !== to.accountGeneration || ready.selectionEpoch !== selectedEpoch) throw fail('ROTATION_ACCOUNT_CHANGED');
      agent.session.append('llm/retry-started', { retryId, turn, step, retry: 1 });
      event('ROTATION_CONTINUING', from, to);
      return { kind: 'retry' };
    } catch (error) { event(error?.code === 'ROTATION_ACCOUNT_CHANGED' ? error.code : 'ROTATION_STOPPED'); return undefined; }
    finally { busy = false; }
  }
  return Object.freeze({ status, update, refresh, handle, requestOptions, wrapAdapter, binding: () => scope.getStore()?.binding, dispose() { lifetime.abort(); contexts.clear(); reports.clear(); failures.clear(); } });
}
