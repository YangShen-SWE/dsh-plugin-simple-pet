import { randomUUID, createHash } from 'node:crypto';

export const CODEX_PROVIDERS = new Set(['openai-codex', 'codex']);
const WINDOWS = { fiveHour: 18_000, weekly: 604_800 };
const FRESH_MS = 120_000;

// Read only the subscription owner's public DTO, never its credential storage.
export async function subscriptionRpc(bridge, method, payload, signal) {
  const rpcId = randomUUID();
  const response = await bridge.fetch(new Request(`http://localhost/api/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  }));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('subscription transport unavailable');
  const envelope = await response.json();
  if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId || envelope.result?.ok !== true) {
    throw new Error('subscription quota unavailable');
  }
  return envelope.result.value;
}

export function normalizeCodexQuota(usage, accountKey, now = Date.now()) {
  const observedAt = Number.isSafeInteger(usage?.fetchedAt) && usage.fetchedAt > 0 && usage.fetchedAt <= now + 5000 ? usage.fetchedAt : null;
  const limits = Array.isArray(usage?.rateLimits) ? usage.rateLimits : [];
  // Code-review and additional/model-specific limits must not masquerade as the base Codex quota.
  const windows = limits.find(limit => limit?.id === 'codex')?.windows;
  const result = { status: observedAt === null || now - observedAt > FRESH_MS ? 'stale' : 'ready', observedAt,
    accountKey, fiveHour: null, weekly: null };
  for (const [kind, seconds] of Object.entries(WINDOWS)) {
    const item = Array.isArray(windows) ? windows.find(item => item?.windowSeconds === seconds) : null;
    if (!Number.isFinite(item?.remainingPercent) || item.remainingPercent < 0 || item.remainingPercent > 100) continue;
    const resetAt = Number.isSafeInteger(item.resetsAt) && item.resetsAt > 0 && item.resetsAt <= 8_640_000_000_000 ? item.resetsAt * 1000 : null;
    result[kind] = { remainingPercent: item.remainingPercent, resetAt };
    if (resetAt !== null && resetAt <= now) result.status = 'stale';
  }
  if (result.fiveHour === null && result.weekly === null) result.status = 'unavailable';
  return result;
}

export async function readCodexQuota(bridge, signal, now = Date.now(), provider = 'openai-codex', { force = false } = {}) {
  if (provider === 'codex') return readSubscriptionsQuota(bridge, signal, now);
  const before = await subscriptionRpc(bridge, 'codex-subscription/status', {}, signal);
  if (before === null) return readSubscriptionsQuota(bridge, signal, now);
  if (!before.authenticated) return { status: 'signed-out', fiveHour: null, weekly: null, observedAt: null };
  const identity = status => {
    const selected = status.accounts?.find(account => account.active === true);
    return selected?.id ?? 'current-account';
  };
  const accountKey = createHash('sha256').update(String(identity(before))).digest('hex').slice(0, 16);
  const usage = await subscriptionRpc(bridge, 'codex-subscription/usage', { force: force === true }, signal);
  const after = await subscriptionRpc(bridge, 'codex-subscription/status', {}, signal);
  if (!after?.authenticated || identity(before) !== identity(after)) {
    return { status: 'switching', fiveHour: null, weekly: null, observedAt: null };
  }
  return { ...normalizeCodexQuota(usage, accountKey, now), provider: 'openai-codex', selection: 'active', accountCount: Array.isArray(after.accounts) ? after.accounts.length : 0 };
}

async function readSubscriptionsQuota(bridge, signal, now) {
  const before = await subscriptionRpc(bridge, 'subscriptions-auth.status', {}, signal);
  if (before === null) return { status: 'unsupported', fiveHour: null, weekly: null, observedAt: null };
  const select = status => status?.providers?.codex?.accounts?.find(account => account.isDefault === true)?.key;
  const key = select(before);
  if (!key) return { status: 'signed-out', fiveHour: null, weekly: null, observedAt: null };
  const usage = await subscriptionRpc(bridge, 'subscriptions-auth.usage', { provider: 'codex', account: key, force: false }, signal);
  const after = await subscriptionRpc(bridge, 'subscriptions-auth.status', {}, signal);
  if (select(after) !== key) return { status: 'switching', fiveHour: null, weekly: null, observedAt: null };
  const result = { status: 'reported', provider: 'codex', selection: 'default', receivedAt: now, observedAt: null,
    accountKey: createHash('sha256').update(key).digest('hex').slice(0, 16),
    accountCount: after.providers.codex.accounts.length, fiveHour: null, weekly: null };
  for (const [kind, publicKind] of [['fiveHour', 'session'], ['weekly', 'weekly']]) {
    const window = usage?.supported === true && Array.isArray(usage.windows) ? usage.windows.find(window => window.kind === publicKind && !window.scope) : null;
    if (!Number.isFinite(window?.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) continue;
    result[kind] = { remainingPercent: 100 - window.usedPercent,
      resetAt: Number.isSafeInteger(window.resetsAt) && window.resetsAt > 0 && window.resetsAt <= 8_640_000_000_000_000 ? window.resetsAt : null };
    if (result[kind].resetAt !== null && result[kind].resetAt <= now) result.status = 'stale';
  }
  if (result.fiveHour === null && result.weekly === null) result.status = 'unavailable';
  return result;
}

export function quotaDeltas(previous, current) {
  if (previous?.status !== 'ready' || current?.status !== 'ready' || previous.accountKey !== current.accountKey || current.observedAt <= previous.observedAt) return [];
  const result = [];
  for (const kind of Object.keys(WINDOWS)) {
    const before = previous[kind], after = current[kind];
    // A reset, account change, or unknown window is not consumption.
    if (!before || !after || before.resetAt === null || before.resetAt !== after.resetAt) continue;
    const percent = Math.round((before.remainingPercent - after.remainingPercent) * 1000) / 1000;
    if (percent > 0) result.push({ kind: 'quota', window: kind, percent, accountKey: current.accountKey,
      tokens: 0, cny: null, billingMode: 'codex', at: current.observedAt });
  }
  return result;
}

export function codexTokenItems(usage) {
  const whole = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return [
    { kind: 'hit', tokens: whole(usage?.cacheReadTokens) },
    { kind: 'miss', tokens: whole(usage?.inputTokens) + whole(usage?.cacheWriteTokens) },
    { kind: 'output', tokens: whole(usage?.outputTokens) },
  ].filter(item => item.tokens > 0).map(item => ({ ...item, cny: null, billingMode: 'codex' }));
}
