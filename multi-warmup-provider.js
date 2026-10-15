import { createHash } from 'node:crypto';
import { subscriptionRpc } from './codex.js';
import { maskCodexEmail } from './codex-identity.js';

// Verified public protocol: V1ki/dsh-plugin-subscriptions 0.9.9,
// commit 9930c5ee5e3fa239db9031f47a0f6f30f7ffc443, account-preferences.ts/rpc.ts.
// This module supplies binding, NOT permission, quotas, scheduling or deduplication.
const PROVIDER = 'codex';
const PREFIX = '~account:';
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
const digest = value => createHash('sha256').update(value).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

class Rejected extends Error {
  constructor(code) { super(code); this.code = code; }
}
const reject = code => { throw new Rejected(code); };
const checkAbort = signal => { if (signal.aborted) reject('BOUND_ABORTED'); };

function publicError(cause, signal, requestNotSent, fallback) {
  // Never retain a provider error, abort reason, raw route or email in cause/stack.
  const code = signal instanceof AbortSignal && signal.aborted ? 'BOUND_ABORTED'
    : cause instanceof Rejected ? cause.code : fallback;
  const error = new Error(code);
  error.name = 'BoundWarmupError';
  error.code = code;
  error.requestNotSent = requestNotSent;
  return error;
}

function validateApi(llm, bridge, signal, run = false) {
  if (!(signal instanceof AbortSignal)) reject('BOUND_ARGUMENT_INVALID');
  checkAbort(signal);
  if (typeof bridge?.fetch !== 'function' || typeof llm?.listModels !== 'function'
    || (run && (typeof llm?.stream !== 'function' || typeof llm?.resolveModelInfo !== 'function'))) {
    reject('BOUND_API_UNAVAILABLE');
  }
}

// listModels has no signal parameter. Stop this caller's wait without inventing
// a new deadline or cancelling shared catalog work. Observe late rejections too.
function waitFor(work, signal) {
  checkAbort(signal);
  return new Promise((resolve, rejectPromise) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); rejectPromise(new Rejected('BOUND_ABORTED')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { checkAbort(signal); return work(); }).then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); rejectPromise(error); },
    );
  });
}

function validAccount(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.trim() !== value
    || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) return false;
  return true;
}

function parseEnumeratedId(id) {
  if (typeof id !== 'string' || id.length > 4096) reject('BOUND_CATALOG_INVALID');
  if (!id.startsWith(PREFIX)) return null;
  const parts = id.slice(PREFIX.length).split(':');
  if (parts.length !== 2) reject('BOUND_CATALOG_INVALID');
  let account, model;
  try { account = decodeURIComponent(parts[0]); model = decodeURIComponent(parts[1]); }
  catch { reject('BOUND_CATALOG_INVALID'); }
  // The reconstructed string is used ONLY for canonicality validation, never routing.
  if (!validAccount(account) || model.trim() !== model || !SAFE_MODEL.test(model)
    || `${PREFIX}${encodeURIComponent(account)}:${encodeURIComponent(model)}` !== id) reject('BOUND_CATALOG_INVALID');
  return { account, model };
}

function acceptsText(model) {
  if (model.inputModalities === undefined) return true;
  if (!Array.isArray(model.inputModalities) || !model.inputModalities.every(item => typeof item === 'string')) {
    reject('BOUND_CATALOG_INVALID');
  }
  return model.inputModalities.includes('text');
}

async function bindings({ llm, bridge, signal }) {
  validateApi(llm, bridge, signal);
  const status = await waitFor(() => subscriptionRpc(bridge, 'subscriptions-auth.status', {}, signal), signal);
  checkAbort(signal);
  if (status === null) reject('BOUND_STATUS_UNAVAILABLE');
  const accounts = status?.providers?.codex?.accounts;
  if (!Array.isArray(accounts) || accounts.length > 1000) reject('BOUND_STATUS_INVALID');
  const byRawKey = new Map(), byHash = new Set();
  for (const row of accounts) {
    if (!record(row) || !validAccount(row.key) || byRawKey.has(row.key)) reject('BOUND_STATUS_INVALID');
    const accountKey = digest(row.key).slice(0, 16);
    if (byHash.has(accountKey)) reject('BOUND_STATUS_INVALID');
    byHash.add(accountKey);
    byRawKey.set(row.key, { accountKey, maskedEmail: maskCodexEmail(row.account), routes: [] });
  }
  const catalog = await waitFor(() => llm.listModels(PROVIDER), signal);
  checkAbort(signal);
  if (!Array.isArray(catalog) || catalog.length > 10000) reject('BOUND_CATALOG_INVALID');
  const seen = new Set(), modelHashes = new Set();
  for (const entry of catalog) {
    if (!record(entry)) reject('BOUND_CATALOG_INVALID');
    if (entry.provider !== PROVIDER) continue;
    const parsed = parseEnumeratedId(entry.id);
    if (!parsed) continue;
    if (seen.has(entry.id)) reject('BOUND_CATALOG_INVALID');
    seen.add(entry.id);
    const owner = byRawKey.get(parsed.account);
    if (!owner || !acceptsText(entry) || /^(?:gpt-image|dall-e|sora)(?:-|$)/i.test(parsed.model)) continue;
    const modelKey = digest(entry.id);
    if (modelHashes.has(modelKey)) reject('BOUND_CATALOG_INVALID');
    modelHashes.add(modelKey);
    // Ignore catalog names/aliases entirely. Never echo an opaque account key as a model label.
    const modelName = [...byRawKey.keys()].some(key => parsed.model.includes(key)) ? 'Codex model' : parsed.model;
    owner.routes.push({ fullId: entry.id, accountKey: owner.accountKey, modelKey, modelName });
  }
  checkAbort(signal);
  return [...byRawKey.values()].filter(account => account.routes.length > 0);
}

/**
 * Read ONLY subscriptions-auth.status and llm.listModels('codex').
 * @param {{llm: object, bridge: object, signal: AbortSignal}} options Explicit caller cancellation/deadline required.
 * @returns {Promise<object>} Frozen {provider,binding,accounts:[{accountKey,maskedEmail,models:[{modelKey,modelName}]}]}.
 * accountKey = first 16 lowercase hex of SHA-256(raw key); modelKey = full
 * SHA-256(exact enumerated id). No raw keys/ids/emails or freshness timestamps.
 * An empty list grants no capability. Malformed/ambiguous DTOs reject closed.
 * Discovery is not authorization or proof of quota freshness; public usage has
 * no fetchedAt, and even force may return an old cached usage snapshot.
 */
export async function discoverBoundAccounts(options) {
  let signal;
  try {
    signal = options?.signal;
    const accounts = await bindings(options);
    return Object.freeze({ provider: PROVIDER, binding: 'independent-entry', accounts: Object.freeze(accounts.map(account =>
      Object.freeze({ accountKey: account.accountKey, maskedEmail: account.maskedEmail,
        models: Object.freeze(account.routes.map(({ modelKey, modelName }) => Object.freeze({ modelKey, modelName }))) }))) });
  } catch (cause) {
    throw publicError(cause, signal, true, 'BOUND_DISCOVERY_FAILED');
  }
}

function selectRoute(accounts, accountKey, modelKey) {
  const matches = accounts.flatMap(account => account.routes).filter(route => route.accountKey === accountKey && route.modelKey === modelKey);
  if (matches.length !== 1) reject('BOUND_ROUTE_UNAVAILABLE');
  return matches[0];
}

function minimumEffort(info, fullId) {
  if (!record(info) || info.provider !== PROVIDER || info.id !== fullId || !acceptsText(info)) reject('BOUND_REASONING_INVALID');
  if (info.reasoning === undefined) return undefined;
  const efforts = info.reasoning?.efforts;
  if (!Array.isArray(efforts) || efforts.length > EFFORTS.length
    || efforts.some(item => !record(item) || !EFFORTS.includes(item.id))
    || new Set(efforts.map(item => item.id)).size !== efforts.length
    || (info.reasoning.defaultEffort !== undefined && !efforts.some(item => item.id === info.reasoning.defaultEffort))) {
    reject('BOUND_REASONING_INVALID');
  }
  return EFFORTS.find(id => efforts.some(item => item.id === id));
}

function tokenUsage(value) {
  if (!record(value) || !Number.isSafeInteger(value.inputTokens) || value.inputTokens < 0
    || !Number.isSafeInteger(value.outputTokens) || value.outputTokens < 0) reject('BOUND_USAGE_INVALID');
  const result = {};
  for (const field of TOKEN_FIELDS) {
    if (value[field] === undefined) continue;
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) reject('BOUND_USAGE_INVALID');
    result[field] = value[field];
  }
  return Object.freeze(result);
}

/**
 * One direct logical call; callers own permission, serialized budgets and journaling.
 * @param {{llm: object, bridge: object, accountKey: string, modelKey: string, signal: AbortSignal, onUsage?: Function}} options
 * llm.resolveModelInfo is required: it must resolve the exact enumerated route.
 * onUsage(finalNumericUsage, {provider,accountKey,modelKey,modelName}) is called
 * once at termination iff valid usage was seen, including failures/cancellation.
 * It may be async; it must settle. No text, provider errors or raw identifiers escape.
 * @returns {Promise<object>} {status:'completed',provider,accountKey,modelKey,modelName}.
 * Errors expose only name/code/message/requestNotSent. requestNotSent is false
 * for EVERY error after invoking stream, including synchronous throws, abort,
 * usage accounting and malformed/incomplete streams. Never automatically retry
 * an uncertain result. Exactly one llm.stream invocation; host/provider middleware
 * may still retry internally, so this is not an exactly-once transport guarantee.
 */
export async function runBoundWarmup(options) {
  let crossedStream = false, usage = null, iterator, exhausted = false, metadata, failure, signal, onUsage;
  try {
    signal = options?.signal;
    const { llm, bridge, accountKey, modelKey, isCurrent } = options;
    onUsage = options.onUsage;
    validateApi(llm, bridge, signal, true);
    if (typeof accountKey !== 'string' || accountKey.length !== 16 || !/^[a-f0-9]{16}$/.test(accountKey)
      || typeof modelKey !== 'string' || modelKey.length !== 64 || !/^[a-f0-9]{64}$/.test(modelKey)
      || (isCurrent !== undefined && typeof isCurrent !== 'function')
      || (onUsage !== undefined && typeof onUsage !== 'function')) reject('BOUND_ARGUMENT_INVALID');
    const route = selectRoute(await bindings({ llm, bridge, signal }), accountKey, modelKey);
    const info = await waitFor(() => llm.resolveModelInfo(PROVIDER, route.fullId, signal), signal);
    checkAbort(signal);
    const reasoningEffort = minimumEffort(info, route.fullId);
    // Metadata resolution can await I/O. Re-read membership AFTER it, without
    // trusting previously returned public rows or ever synthesizing a target id.
    const confirmed = selectRoute(await bindings({ llm, bridge, signal }), accountKey, modelKey);
    if (confirmed.fullId !== route.fullId) reject('BOUND_ROUTE_UNAVAILABLE');
    metadata = Object.freeze({ provider: PROVIDER, accountKey, modelKey, modelName: confirmed.modelName });
    const request = { provider: PROVIDER, model: confirmed.fullId, tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply only OK.' }] }], signal,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
    checkAbort(signal);
    // Context can change during any async preflight; check the owner's live
    // generation at the irreversible boundary with no intervening await.
    if (isCurrent !== undefined && isCurrent() !== true) reject('BOUND_CONTEXT_CHANGED');
    crossedStream = true;
    const stream = llm.stream(request);
    iterator = stream[Symbol.asyncIterator]();
    let hasText = false, finished = false;
    while (true) {
      checkAbort(signal);
      const step = await waitFor(() => iterator.next(), signal);
      if (!record(step)) reject('BOUND_STREAM_INVALID');
      if (step.done === true) { exhausted = true; checkAbort(signal); break; }
      if (step.done !== false && step.done !== undefined) reject('BOUND_STREAM_INVALID');
      const chunk = step.value;
      if (!record(chunk)) reject('BOUND_STREAM_INVALID');
      // Capture delivered cumulative accounting before observing cancellation.
      if (chunk.type === 'usage') usage = tokenUsage(chunk.usage);
      checkAbort(signal);
      if (finished) reject('BOUND_STREAM_INVALID');
      if (chunk.type === 'text-delta') {
        if (typeof chunk.text !== 'string') reject('BOUND_STREAM_INVALID');
        hasText ||= /\S/u.test(chunk.text);
      } else if (chunk.type === 'finish') {
        if (chunk.reason?.kind !== 'stop') reject('BOUND_STREAM_INCOMPLETE');
        finished = true;
      } else if (!['usage', 'block-start', 'block-end', 'reasoning-delta'].includes(chunk.type)) {
        // tools:[] means even an unsolicited tool-call is never acceptable.
        reject('BOUND_STREAM_INVALID');
      }
    }
    if (!finished || !hasText) reject('BOUND_STREAM_INCOMPLETE');
    checkAbort(signal);
  } catch (cause) {
    failure = publicError(cause, signal, !crossedStream, crossedStream ? 'BOUND_STREAM_FAILED' : 'BOUND_PREFLIGHT_FAILED');
  } finally {
    if (iterator && !exhausted) {
      // A hung async generator may not settle return() until its pending next().
      // Do not let cleanup defeat the caller's deadline; contain late rejection.
      try { Promise.resolve(iterator.return?.()).catch(() => {}); }
      catch { /* No provider cleanup error may replace the safe public result. */ }
    }
    if (usage && typeof onUsage === 'function') {
      try {
        const pending = Promise.resolve(onUsage(usage, metadata));
        // Attach rejection handling even if the caller was already cancelled.
        pending.catch(() => {});
        await waitFor(() => pending, signal);
        checkAbort(signal);
      } catch (cause) {
        failure = publicError(cause, signal, false, 'BOUND_USAGE_ACCOUNTING_FAILED');
      }
    }
  }
  if (failure) throw failure;
  return Object.freeze({ status: 'completed', ...metadata });
}
