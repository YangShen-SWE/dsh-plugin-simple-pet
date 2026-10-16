// Compatibility adapter for the quota GET used by the official Codex CLI.
// This is NOT a stable OpenAI Platform API and never buys/consumes reset credits.
export async function fetchQuota({ access, accountId, signal, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl('https://chatgpt.com/backend-api/wham/usage', {
    method: 'GET', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${access}`, 'ChatGPT-Account-Id': accountId, Accept: 'application/json' },
  });
  if (!response.ok || response.redirected) throw new Error('QUOTA_HTTP_UNAVAILABLE');
  if (Number(response.headers?.get?.('content-length')) > 262144) throw new Error('QUOTA_TOO_LARGE');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('QUOTA_BODY_UNAVAILABLE');
  const chunks = []; let size = 0;
  try {
    while (true) { signal?.throwIfAborted(); const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 262144) throw new Error('QUOTA_TOO_LARGE'); chunks.push(part.value); }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
export function parseQuota(raw, expectedAccount, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('QUOTA_INVALID');
  if (raw.account_id != null && raw.account_id !== expectedAccount) throw new Error('QUOTA_IDENTITY_MISMATCH');
  const rate = raw.rate_limit;
  const result = { status: 'reported', clientObservedAt: now, serverSampledAt: null, fullTriggerEligible: false,
    identityBinding: raw.account_id == null ? 'fixed-store-no-server-echo' : 'server-echo',
    ordinaryUsageAllowed: typeof raw.ordinary_usage_allowed === 'boolean' ? raw.ordinary_usage_allowed
      : typeof rate?.allowed === 'boolean' ? rate.allowed : null,
    fiveHour: null, weekly: null, additionalLimitCount: Array.isArray(raw.additional_rate_limits) ? raw.additional_rate_limits.length : 0 };
  if (rate?.allowed === false || rate?.limit_reached === true) result.ordinaryUsageAllowed = false;
  const windows = [rate?.primary_window, rate?.secondary_window];
  for (const [key, seconds] of [['fiveHour', 18000], ['weekly', 604800]]) {
    const matches = windows.filter(w => w?.limit_window_seconds === seconds);
    if (matches.length !== 1) continue;
    const w = matches[0];
    if (!Number.isFinite(w.used_percent) || w.used_percent < 0 || w.used_percent > 100) continue;
    result[key] = { remainingPercent: 100 - w.used_percent,
      resetAt: Number.isSafeInteger(w.reset_at) && w.reset_at > 0 && w.reset_at <= 8640000000000 ? w.reset_at * 1000 : null, windowSeconds: seconds };
    if (result[key].resetAt !== null && result[key].resetAt <= now) result.status = 'stale';
  }
  if (!result.fiveHour && !result.weekly) result.status = 'unavailable';
  return result;
}
