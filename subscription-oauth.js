import { randomUUID, createHash } from 'node:crypto';

// JWT claims are NOT authentication proof. An unverified exp may only shorten
// local freshness, never extend it, choose an account or authorize a request.
function tokenClaims(access) {
  if (typeof access !== 'string' || access.length > 131072) return;
  const parts = access.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]{1,65536}$/.test(parts[1])) return;
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(parts[1], 'base64url'))); } catch { /* Opaque token. */ }
}
export function oauthCredentialForResolution(credential, skewMs = 60000) {
  if (!credential || credential.type !== 'oauth') return credential;
  if (!Number.isFinite(skewMs) || skewMs < 0) throw new TypeError('Invalid OAuth skew');
  let expiry = credential.expires;
  const exp = tokenClaims(credential.access)?.exp;
  if (typeof exp === 'number' && Number.isFinite(exp) && exp >= 0 && exp <= 8640000000000) expiry = Math.min(expiry, exp * 1000);
  return { ...credential, expires: expiry - skewMs };
}

const failure = code => Object.assign(new Error(code), { code });
// Resolve in the provider immediately before its first network iteration,
// AFTER the SDK's explicit apiKey override, context conversion and proxy setup.
// The adapter receives a short-lived, single-use in-memory handle, not a frozen
// bearer. Refresh is still owned by Models + the serialized credential store.
export function createSubscriptionRequestAuth({ readAccountKey, readCredential, resolveAuth, now = Date.now, nonce = randomUUID, maxPending = 256, ttlMs = 3600000 }) {
  const pending = new Map();
  let live = true;
  const check = signal => { if (!live) throw failure('SUBSCRIPTION_AUTH_CLOSED'); signal?.throwIfAborted(); };
  const identity = credential => {
    const claim = tokenClaims(credential?.access)?.['https://api.openai.com/auth']?.chatgpt_account_id;
    const id = credential?.accountId ?? claim;
    if (!credential || credential.type !== 'oauth' || typeof id !== 'string' || !id || id.length > 512 || (claim !== undefined && claim !== id)) throw failure('SUBSCRIPTION_AUTH_IDENTITY_UNVERIFIED');
    return id;
  };
  async function snapshot(signal) {
    check(signal);
    const key = await readAccountKey();
    const credential = await readCredential({ signal });
    check(signal);
    if (key == null || key !== await readAccountKey()) throw failure('SUBSCRIPTION_AUTH_ACCOUNT_CHANGED');
    return { key, identity: identity(credential), access: credential.access };
  }
  function same(first, second) {
    if (first.key !== second.key || first.identity !== second.identity) throw failure('SUBSCRIPTION_AUTH_ACCOUNT_CHANGED');
  }
  async function authorize(captured, { signal } = {}) {
    check(signal);
    if (now() >= captured.deadline) throw failure('SUBSCRIPTION_AUTH_REQUEST_EXPIRED');
    same(captured, await snapshot(signal));
    const resolved = await resolveAuth({ signal, minOAuthValidityMs: 60000 });
    check(signal);
    const current = await snapshot(signal);
    same(captured, current);
    if (typeof resolved?.auth?.apiKey !== 'string' || !resolved.auth.apiKey) throw failure('SUBSCRIPTION_AUTH_MISSING');
    if (resolved.auth.apiKey !== current.access) throw failure('SUBSCRIPTION_AUTH_ACCOUNT_CHANGED');
    return resolved;
  }
  function bind(handle, signal) {
    check(signal);
    const captured = pending.get(handle);
    pending.delete(handle);
    if (!captured || now() >= captured.deadline) throw failure('SUBSCRIPTION_AUTH_REQUEST_EXPIRED');
    return Object.freeze({ resolve: options => authorize(captured, options) });
  }
  return Object.freeze({
    async capture({ signal, expectedAccountKey } = {}) {
      const captured = await snapshot(signal);
      if (expectedAccountKey !== undefined && (typeof expectedAccountKey !== 'string' || !/^[a-f0-9]{16}$/.test(expectedAccountKey)
        || createHash('sha256').update(captured.key).digest('hex').slice(0, 16) !== expectedAccountKey)) throw failure('SUBSCRIPTION_AUTH_ACCOUNT_CHANGED');
      for (const [key, value] of pending) if (now() >= value.deadline) pending.delete(key);
      if (pending.size >= maxPending) throw failure('SUBSCRIPTION_AUTH_BUSY');
      const handle = 'simple-pet-oauth-request:' + nonce();
      if (pending.has(handle)) throw failure('SUBSCRIPTION_AUTH_BUSY');
      pending.set(handle, { key: captured.key, identity: captured.identity, deadline: now() + ttlMs });
      return handle;
    },
    bind,
    async resolve(handle, { signal } = {}) { return bind(handle, signal).resolve({ signal }); },
    dispose() { live = false; pending.clear(); },
  });
}
