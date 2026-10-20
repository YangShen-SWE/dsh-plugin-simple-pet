import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const CODES = new Set(['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed']);
const MAX_BODY = 65536, MAX_STORE = 524288, MAX_CLAIMS = 2048;
const hex = /^[a-f0-9]{64}$/, uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const hash = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const fail = (code, requestNotSent = true) => Object.assign(new Error(code), { code, requestNotSent });
const only = (x, keys) => Object.keys(x).every(k => keys.includes(k));
const text = (x, max) => typeof x === 'string' && x.length > 0 && x.length <= max && !/[\s\p{Cc}\p{Cs}]/u.test(x);

function capture(value) {
  if (!record(value) || !text(value.accountKey, 128) || !Number.isSafeInteger(value.epoch) || value.epoch < 1
    || !text(value.bindingInstance,128) || !text(value.accountId, 512) || !text(value.access, 65536)) throw fail('RESET_IDENTITY_INVALID');
  return Object.freeze({ accountKey: value.accountKey, epoch: value.epoch, bindingInstance:value.bindingInstance, accountId: value.accountId, access: value.access });
}
const binding = i => hash('binding', i.accountKey, i.epoch, i.bindingInstance, i.accountId);
const claimKey = (i, creditId) => hash('reset-credit-v1', i.accountId, creditId);
function expiration(value) {
  if (value === undefined || value === null) return undefined;
  const n = Number.isSafeInteger(value) && value > 0 ? value * 1000
    : typeof value === 'string' && value.length > 0 && value.length <= 64 ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw fail('RESET_RESPONSE_INVALID');
  return n;
}
function details(value, time) {
  if (!record(value) || !Number.isSafeInteger(value.available_count) || value.available_count < 0 || value.available_count > 128
    || !Array.isArray(value.credits) || value.credits.length > 128) throw fail('RESET_RESPONSE_INVALID');
  const seen = new Set(), credits = [];
  for (const c of value.credits) {
    if (!record(c) || !text(c.id, 256) || typeof c.status !== 'string' || c.status.length > 64 || seen.has(c.id)) throw fail('RESET_RESPONSE_INVALID');
    seen.add(c.id);
    const expiresAt = expiration(c.expires_at);
    if (c.status.toLowerCase() === 'available' && (expiresAt === undefined || expiresAt > time)) credits.push({ id: c.id, expiresAt });
  }
  if (value.available_count === 0) return { availableCount: 0, credits: [] };
  if (credits.length > value.available_count) throw fail('RESET_RESPONSE_INVALID');
  credits.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  return { availableCount: value.available_count, credits };
}
function resultOf(value) {
  if (!record(value) || !CODES.has(value.code)) throw fail('RESET_RESPONSE_INVALID');
  const n = Array.isArray(value.windows_reset) ? value.windows_reset.length : value.windows_reset;
  // Never forward upstream display strings or arbitrary response fields.
  return { code: value.code, ...(Number.isSafeInteger(n) && n >= 0 && n <= 16 ? { windowsResetCount: n } : {}) };
}

async function boundedFile(file, limit) {
  const fd = await fs.open(file, 'r');
  try {
    if ((await fd.stat()).size > limit) throw 0;
    const bytes = Buffer.alloc(limit + 1); let length = 0;
    while (length <= limit) {
      const { bytesRead } = await fd.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw 0;
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } finally { await fd.close(); }
}

// Same exclusive .lock + private temporary file + atomic rename pattern as
// AccountDirectory. Stale locks are NEVER stolen: a crash can only stop work.
class ClaimStore {
  constructor(file) { this.file = path.resolve(file); this.tail = Promise.resolve(); }
  async read() {
    try {
      const x = await boundedFile(this.file, MAX_STORE);
      if (!record(x) || !only(x, ['version', 'claims']) || x.version !== 1 || !Array.isArray(x.claims) || x.claims.length > MAX_CLAIMS) throw 0;
      const seen = new Set();
      for (const c of x.claims) {
        if (!record(c) || !only(c, ['key', 'requestId', 'state', 'at', 'result']) || typeof c.key !== 'string' || !hex.test(c.key) || typeof c.requestId !== 'string' || !uuid.test(c.requestId)
          || !['claimed', 'settled'].includes(c.state) || !Number.isSafeInteger(c.at) || c.at < 0 || seen.has(c.key)) throw 0;
        if (c.state === 'settled') {
          if (!record(c.result) || !only(c.result, ['code', 'windowsResetCount']) || !CODES.has(c.result.code)
            || (c.result.windowsResetCount !== undefined && (!Number.isSafeInteger(c.result.windowsResetCount) || c.result.windowsResetCount < 0 || c.result.windowsResetCount > 16))) throw 0;
        } else if (c.result !== undefined) throw 0;
        seen.add(c.key);
      }
      return x;
    } catch (e) { if (e?.code === 'ENOENT') return { version: 1, claims: [] }; throw fail('RESET_STORE_UNAVAILABLE'); }
  }
  update(fn) {
    const task = this.tail.then(async () => {
      let lock, tmp;
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        for (let i = 0; i < 80; i++) {
          try { lock = await fs.open(`${this.file}.lock`, 'wx', 0o600); break; }
          catch (e) { if (e.code !== 'EEXIST' || i === 79) throw fail('RESET_STORE_LOCKED'); await delay(25); }
        }
        const data = await this.read(), result = await fn(data);
        const serialized = JSON.stringify(data);
        if (Buffer.byteLength(serialized) > MAX_STORE) throw fail('RESET_STORE_FULL');
        tmp = `${this.file}.${randomUUID()}.tmp`;
        const fd = await fs.open(tmp, 'wx', 0o600);
        try { await fd.writeFile(serialized); await fd.sync(); } finally { await fd.close(); }
        for (let attempt = 0; ; attempt++) {
          try { await fs.rename(tmp, this.file); break; }
          catch (e) {
            if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 9) throw e;
            await delay(20 * (attempt + 1));
          }
        }
        if (process.platform !== 'win32') {
          const dir = await fs.open(path.dirname(this.file), 'r');
          try { await dir.sync(); } finally { await dir.close(); }
        }
        return result;
      } catch (e) {
        if (['RESET_CLAIM_PAUSED', 'RESET_STORE_FULL', 'RESET_STORE_LOCKED', 'RESET_STORE_UNAVAILABLE'].includes(e?.code)) throw e;
        throw fail('RESET_STORE_UNAVAILABLE');
      } finally {
        if (tmp) await fs.rm(tmp, { force: true }).catch(() => {});
        if (lock) { await lock.close().catch(() => {}); await fs.rm(`${this.file}.lock`, { force: true }).catch(() => {}); }
      }
    });
    this.tail = task.catch(() => {}); return task;
  }
}

async function boundedJSON(response, signal) {
  if (!response?.ok) throw fail('RESET_HTTP_FAILED');
  const type = response.headers?.get('content-type');
  const length = response.headers?.get('content-length');
  if (typeof type !== 'string' || !/^application\/json(?:\s*;|\s*$)/i.test(type)
    || (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY))) throw fail('RESET_RESPONSE_INVALID');
  const reader = response.body?.getReader?.();
  if (!reader) throw fail('RESET_RESPONSE_INVALID');
  const chunks = []; let size = 0, complete = false;
  const cancel = () => { Promise.resolve(reader.cancel()).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array) || (size += value.byteLength) > MAX_BODY) throw fail('RESET_RESPONSE_INVALID');
      chunks.push(value);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
    catch { throw fail('RESET_RESPONSE_INVALID'); }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

/**
 * Host-only protocol, not a credential resolver. No account fallback or token refresh.
 *
 * createResetCredits({storeFile, fetchImpl, now=Date.now, validate, revalidate,
 *                     timeoutMs=15000}) -> {inspect, prepare, consume, dispose}
 * Every operation takes {identity:{accountKey,epoch,accountId,access}, signal?}.
 * prepare also needs creditRef; consume needs challengeId and acknowledged:true.
 * validate(capture,{signal,phase}) may be async; revalidate(capture,{signal,phase})
 * MUST synchronously return true. Both receive {accountKey,epoch,accountId}, not
 * access. Host MUST check captured epoch/identity, disposal and revocation. They
 * cannot redirect identity. Signals must include host account/dispose cancellation.
 *
 * DTOs contain only opaque refs/challenges, timestamps/counts and fixed codes.
 * Error.message===code; requestNotSent refers to the consume POST, not a GET.
 * false means this claim may already have dispatched (including previous process).
 * A durable claim is never removed, even after a known result. Uncertain claims
 * have NO retry API; private store/lock loss is outside this module's guarantee.
 */
export function createResetCredits({ storeFile, fetchImpl, now = Date.now, validate, revalidate, timeoutMs = 15000 } = {}) {
  if (typeof storeFile !== 'string' || !storeFile || typeof fetchImpl !== 'function' || typeof now !== 'function'
    || typeof validate !== 'function' || typeof revalidate !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw fail('RESET_OPTIONS_INVALID');
  const store = new ClaimStore(storeFile), refs = new Map(), challenges = new Map(), lifetime = new AbortController();
  let closed = false;
  const time = () => { let n; try { n = now(); } catch { throw fail('RESET_CLOCK_INVALID'); } if (!Number.isSafeInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER - 60000) throw fail('RESET_CLOCK_INVALID'); return n; };
  const guard = signal => { if (closed) throw fail('RESET_CLOSED'); if (signal !== undefined && !(signal instanceof AbortSignal)) throw fail('RESET_SIGNAL_INVALID'); if (signal?.aborted) throw fail('RESET_CANCELLED'); };
  const context = (i, signal, phase) => [Object.freeze({ accountKey: i.accountKey, epoch: i.epoch,bindingInstance:i.bindingInstance, accountId: i.accountId }), { signal, phase }];
  const check = async (i, signal, phase) => {
    guard(signal);
    try { if (await validate(...context(i, signal, phase)) !== true) throw 0; }
    catch { guard(signal); throw fail('RESET_IDENTITY_CHANGED'); }
    guard(signal);
  };
  const finalCheck = (i, signal, phase) => {
    guard(signal);
    let ok;
    try { ok = revalidate(...context(i, signal, phase)); }
    catch { guard(signal); throw fail('RESET_IDENTITY_CHANGED'); }
    // Never accept a Promise (or truthy object) as a current-epoch decision.
    if (ok !== true) { if (ok?.catch) ok.catch(() => {}); throw fail('RESET_IDENTITY_CHANGED'); }
    guard(signal);
  };
  const prune = () => {
    const n = time();
    for (const [k, v] of refs) if (n >= v.until) refs.delete(k);
    for (const [k, v] of challenges) if (n >= v.expiresAt && v.state !== 'pending') challenges.delete(k);
  };
  const request = async (i, signal, phase, body, dispatched = () => {}) => {
    const timeout = new AbortController();
    const combined = AbortSignal.any([lifetime.signal, timeout.signal, ...(signal ? [signal] : [])]);
    let listener, timer, didDispatch = false;
    const aborted = new Promise((_, reject) => {
      listener = () => reject(fail(body && didDispatch ? 'RESET_UNCERTAIN' : closed ? 'RESET_CLOSED' : signal?.aborted ? 'RESET_CANCELLED' : 'RESET_TIMEOUT', !(body && didDispatch)));
      combined.addEventListener('abort', listener, { once: true });
      timer = setTimeout(() => timeout.abort(), timeoutMs);
    });
    try {
      return await Promise.race([aborted, (async () => {
        finalCheck(i, combined, phase);
        const init = { method: body ? 'POST' : 'GET', redirect: 'error', signal: combined,
          headers: { authorization: `Bearer ${i.access}`, 'chatgpt-account-id': i.accountId, accept: 'application/json', 'cache-control': 'no-store', ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}) };
        // No await between the synchronous epoch guard and invoking fetch.
        didDispatch = true; dispatched();
        const response = await fetchImpl(body ? `${URL}/consume` : URL, init);
        return await boundedJSON(response, combined);
      })()]);
    } catch (e) {
      if (body && didDispatch) throw fail('RESET_UNCERTAIN', false);
      if (['RESET_CLOSED', 'RESET_CANCELLED', 'RESET_TIMEOUT', 'RESET_IDENTITY_CHANGED', 'RESET_HTTP_FAILED', 'RESET_RESPONSE_INVALID'].includes(e?.code)) throw fail(e.code);
      throw fail('RESET_TRANSPORT_FAILED');
    } finally { clearTimeout(timer); combined.removeEventListener('abort', listener); }
  };
  const readDetails = async (i, signal, phase) => {
    await check(i, signal, phase);
    const value = details(await request(i, signal, phase), time());
    await check(i, signal, phase);
    return value;
  };
  const publicChallenge = c => ({ challengeId: c.id, creditRef: c.ref, readyAt: c.readyAt, expiresAt: c.expiresAt, ...(c.creditExpiresAt === undefined ? {} : { creditExpiresAt: c.creditExpiresAt }), acknowledgementRequired: true });
  return Object.freeze({
    async inspect({ identity, signal } = {}) {
      const i = capture(identity); guard(signal); prune();
      const d = await readDetails(i, signal, 'inspect');
      const saved = await store.read(); await check(i, signal, 'inspect');
      if (refs.size + d.credits.length > 256) refs.clear();
      const credits = d.credits.map(c => {
        const ref = randomUUID(), until = Math.min(time() + 60000, c.expiresAt ?? Infinity);
        refs.set(ref, { binding: binding(i), creditId: c.id, expiresAt: c.expiresAt, until });
        return { ref, ...(c.expiresAt === undefined ? {} : { expiresAt: c.expiresAt }), paused: saved.claims.some(x => x.key === claimKey(i, c.id)) };
      });
      return { availableCount: d.availableCount, credits };
    },
    async prepare({ identity, creditRef, signal } = {}) {
      const i = capture(identity); guard(signal); prune();
      const ref = refs.get(creditRef);
      if (!ref || ref.binding !== binding(i)) throw fail('RESET_CARD_INVALID');
      const d = await readDetails(i, signal, 'prepare');
      const c = d.credits.find(x => x.id === ref.creditId);
      if (!c || time() >= ref.until) throw fail('RESET_CARD_INVALID');
      const saved = await store.read(); await check(i, signal, 'prepare');
      if (time() >= ref.until) throw fail('RESET_CARD_INVALID');
      if (saved.claims.some(x => x.key === claimKey(i, c.id))) throw fail('RESET_CLAIM_PAUSED', false);
      for (const existing of challenges.values()) if (existing.binding === binding(i) && existing.ref === creditRef && existing.creditId === c.id && existing.state === 'prepared' && time() < existing.expiresAt) return publicChallenge(existing);
      if (challenges.size >= 128) throw fail('RESET_CAPACITY');
      const n = time(), expiresAt = Math.min(n + 60000, c.expiresAt ?? Infinity);
      if (expiresAt <= n + 5000) throw fail('RESET_CARD_EXPIRES_SOON');
      const challenge = { id: randomUUID(), ref: creditRef, binding: binding(i), creditId: c.id, requestId: randomUUID(), readyAt: n + 5000, expiresAt, creditExpiresAt: c.expiresAt, state: 'prepared' };
      challenges.set(challenge.id, challenge);
      return publicChallenge(challenge);
    },
    async consume({ identity, challengeId, acknowledged, signal } = {}) {
      const i = capture(identity); guard(signal);
      const c = challenges.get(challengeId);
      if (!c || c.binding !== binding(i)) throw fail('RESET_CHALLENGE_INVALID');
      if (c.state === 'pending') throw fail('RESET_IN_PROGRESS');
      if (c.state === 'blocked') throw fail('RESET_CLAIM_PAUSED', false);
      if (c.state === 'done') throw fail('RESET_ALREADY_USED');
      if (time() >= c.expiresAt) throw fail('RESET_CHALLENGE_EXPIRED');
      if (time() < c.readyAt) throw fail('RESET_WAIT_REQUIRED');
      if (acknowledged !== true) throw fail('RESET_ACK_REQUIRED');
      c.state = 'pending';
      let claimed = false, sent = false;
      try {
        await check(i, signal, 'consume');
        const key = claimKey(i, c.creditId);
        await store.update(data => {
          if (data.claims.some(x => x.key === key)) throw fail('RESET_CLAIM_PAUSED', false);
          if (data.claims.length >= MAX_CLAIMS) throw fail('RESET_STORE_FULL');
          data.claims.push({ key, requestId: c.requestId, state: 'claimed', at: time() });
        });
        claimed = true;
        await check(i, signal, 'consume-dispatch');
        if (time() >= c.expiresAt) throw fail('RESET_CHALLENGE_EXPIRED');
        const raw = await request(i, signal, 'consume-dispatch', { redeem_request_id: c.requestId, credit_id: c.creditId }, () => { sent = true; });
        const result = resultOf(raw);
        await store.update(data => {
          const row = data.claims.find(x => x.key === key);
          if (!row || row.requestId !== c.requestId || row.state !== 'claimed') throw fail('RESET_STORE_UNAVAILABLE');
          row.state = 'settled'; row.result = result;
        });
        // A disposed/revoked host must not receive a stale success DTO.
        await check(i, signal, 'consume-result');
        c.state = 'done'; return result;
      } catch (e) {
        c.state = claimed || sent || e?.code === 'RESET_CLAIM_PAUSED' ? 'blocked' : 'prepared';
        if (sent) throw fail('RESET_UNCERTAIN', false);
        if (typeof e?.code === 'string' && /^RESET_[A-Z_]+$/.test(e.code)) throw fail(e.code, e.requestNotSent !== false);
        throw fail('RESET_FAILED');
      }
    },
    dispose() { closed = true; lifetime.abort(); refs.clear(); challenges.clear(); },
  });
}
