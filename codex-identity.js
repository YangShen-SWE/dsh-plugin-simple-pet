// Read-only presentation boundary: never forward raw account IDs, labels or email.
const LEASE_MS = 120_000;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);

export function selectedCodexAccount(status, provider) {
  if (!['openai-codex', 'codex'].includes(provider)) return null;
  const dedicated = provider === 'openai-codex';
  if (dedicated && status?.authenticated !== true) return null;
  const accounts = dedicated ? status?.accounts : status?.providers?.codex?.accounts;
  if (!Array.isArray(accounts) || accounts.length > 1000) return null;
  const key = dedicated ? 'id' : 'key', flag = dedicated ? 'active' : 'isDefault';
  if (accounts.some(row => !row || !validId(row[key]))) return null;
  if (new Set(accounts.map(row => row[key])).size !== accounts.length) return null;
  const selected = accounts.filter(row => row[flag] === true);
  return selected.length === 1 ? { row: selected[0], id: selected[0][key], count: accounts.length } : null;
}

export function maskCodexEmail(value) {
  // No guessing from labels or opaque IDs, no control/bidi characters or full local part.
  if (typeof value !== 'string' || value.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,24}$/.test(value)) return null;
  const [local, host] = value.split('@'), parts = host.split('.');
  if (parts.some(part => !part || part.startsWith('-') || part.endsWith('-'))) return null;
  return `${local[0]}***@${parts[0][0]}***.${parts.at(-1).toLowerCase()}`;
}

export function codexIdentity(selected, provider, accountKey, checkedAt) {
  const candidate = provider === 'codex' ? selected.row.account : selected.row.email;
  const identity = { provider, selection: provider === 'codex' ? 'default' : 'active', accountKey,
    maskedEmail: maskCodexEmail(candidate), checkedAt };
  // Full email is reachable only in-process by the opt-in capability channel.
  // Never enumerable: accidental JSON snapshots still cannot persist the full address.
  Object.defineProperty(identity, 'panelEmail', { value: identity.maskedEmail ? candidate : null });
  return Object.freeze(identity);
}

export function identityEvidence(quota, identity, now = Date.now()) {
  const unavailable = { status: 'unavailable' };
  if (!identity || !quota || !['ready', 'reported'].includes(quota.status)
    || quota.provider !== identity.provider || quota.selection !== identity.selection || quota.accountKey !== identity.accountKey
    || !['openai-codex', 'codex', 'codex-accounts'].includes(identity.provider) || !(typeof identity.accountKey === 'string' && identity.accountKey.length === 16 && /^[a-f0-9]{16}$/.test(identity.accountKey))
    || !Number.isSafeInteger(identity.checkedAt) || identity.checkedAt > now || now - identity.checkedAt >= LEASE_MS
    || (quota.status === 'ready' && (!Number.isSafeInteger(quota.observedAt) || quota.observedAt > now + 5000 || now - quota.observedAt > LEASE_MS))
    || [quota.fiveHour, quota.weekly].some(window => Number.isFinite(window?.resetAt) && window.resetAt <= now)) return unavailable;
  const deadlines = [identity.checkedAt + LEASE_MS,
    ...(quota.status === 'ready' ? [quota.observedAt + LEASE_MS] : []),
    ...[quota.fiveHour, quota.weekly].filter(window => Number.isFinite(window?.resetAt)).map(window => window.resetAt)];
  return { status: 'ready', provider: identity.provider, selection: identity.selection, accountKey: identity.accountKey,
    maskedEmail: identity.maskedEmail, validForMs: Math.min(...deadlines) - now };
}

// A recently confirmed status identity remains useful when usage is unavailable or
// a quota window expired. It is not evidence of fresh quota or a warm-up grant.
export function panelIdentityEvidence(quota, identity, now = Date.now()) {
  if (!identity || !quota || !['ready', 'reported', 'stale', 'unavailable'].includes(quota.status)
    || quota.provider !== identity.provider || quota.selection !== identity.selection || quota.accountKey !== identity.accountKey
    || !['openai-codex', 'codex', 'codex-accounts'].includes(identity.provider)
    || typeof identity.accountKey !== 'string' || identity.accountKey.length !== 16 || !/^[a-f0-9]{16}$/.test(identity.accountKey)
    || !Number.isSafeInteger(identity.checkedAt) || identity.checkedAt > now || now - identity.checkedAt >= LEASE_MS)
    return { status: 'unavailable' };
  return { status: 'ready', selection: identity.selection, accountKey: identity.accountKey,
    validForMs: LEASE_MS - (now - identity.checkedAt) };
}

export function accountIdentityHandler({ read, authorize }) {
  return function (req, res) {
    if (!authorize(req, res)) return;
    const method = req.method ?? 'GET';
    res.writeHead(method === 'GET' || method === 'HEAD' ? 200 : 405, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      ...(method !== 'GET' && method !== 'HEAD' ? { Allow: 'GET, HEAD' } : {}),
    });
    const body = method === 'GET' || method === 'HEAD' ? read() : { error: 'method not allowed' };
    res.end(method === 'HEAD' ? undefined : JSON.stringify(body));
  };
}
