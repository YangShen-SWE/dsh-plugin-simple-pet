import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DETAILS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const CONSUME_URL = `${DETAILS_URL}/consume`;
const MAX_STORE = 524288, MAX_CLAIMS = 2048;
const CODES = new Set(['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed']);
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const only = (x, keys) => Object.keys(x).every(k => keys.includes(k));
const text = (x, max) => typeof x === 'string' && x.length > 0 && x.length <= max && !/[\s\p{Cc}\p{Cs}]/u.test(x);
const fail = (code, requestNotSent = true) => Object.assign(new Error(code), { code, requestNotSent });
// Deliberately identical to codex-accounts/reset-credits.js. A renamed account,
// refreshed token or a different runtime cannot reopen the same account/card.
const claimKey = (accountId, creditId) => createHash('sha256').update(JSON.stringify(['reset-credit-v1', accountId, creditId])).digest('hex');
const resultOf = result => {
  if (!record(result) || !CODES.has(result.code)) throw fail('RESET_UNCERTAIN', false);
  const n = result.windowsResetCount ?? (Array.isArray(result.windowsReset) ? result.windowsReset.length : undefined);
  return { code: result.code, ...(Number.isSafeInteger(n) && n >= 0 && n <= 16 ? { windowsResetCount: n } : {}) };
};

class ClaimStore {
  constructor(file) { this.file = file; }
  async read() {
    let handle;
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE) throw 0;
      handle = await fs.open(this.file, 'r');
      if (!(await handle.stat()).isFile()) throw 0;
      const bytes = Buffer.alloc(MAX_STORE + 1); let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_STORE) throw 0;
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
      if (!record(data) || !only(data, ['version', 'claims']) || data.version !== 1 || !Array.isArray(data.claims) || data.claims.length > MAX_CLAIMS) throw 0;
      const seen = new Set();
      for (const row of data.claims) {
        if (!record(row) || !only(row, ['key', 'requestId', 'state', 'at', 'result']) || typeof row.key !== 'string' || !HEX.test(row.key) || typeof row.requestId !== 'string' || !UUID.test(row.requestId)
          || !['claimed', 'settled'].includes(row.state) || !Number.isSafeInteger(row.at) || row.at < 0 || seen.has(row.key)) throw 0;
        if (row.state === 'settled') {
          if (!record(row.result) || !only(row.result, ['code', 'windowsResetCount']) || !CODES.has(row.result.code)
            || (row.result.windowsResetCount !== undefined && (!Number.isSafeInteger(row.result.windowsResetCount) || row.result.windowsResetCount < 0 || row.result.windowsResetCount > 16))) throw 0;
        } else if (row.result !== undefined) throw 0;
        seen.add(row.key);
      }
      return data;
    } catch (error) {
      if (error?.code === 'ENOENT' && !handle) return { version: 1, claims: [] };
      throw fail('RESET_STORE_UNAVAILABLE');
    } finally { await handle?.close(); }
  }
  async update(change) {
    let lock, temp;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      // Never steal a stale lock. A process crash may pause redemption, not replay it.
      try { lock = await fs.open(`${this.file}.lock`, 'wx', 0o600); }
      catch (error) { throw fail(error?.code === 'EEXIST' ? 'RESET_STORE_LOCKED' : 'RESET_STORE_UNAVAILABLE'); }
      const data = await this.read();
      change(data);
      const bytes = JSON.stringify(data);
      if (Buffer.byteLength(bytes) > MAX_STORE) throw fail('RESET_STORE_FULL');
      temp = `${this.file}.${randomUUID()}.tmp`;
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, this.file);
      // Windows cannot fsync directory handles. The data file is synced before
      // rename; on POSIX also sync the directory. Filesystem/power-loss rollback
      // and deliberate store deletion are outside this module's guarantee.
      if (process.platform !== 'win32') {
        const dir = await fs.open(path.dirname(this.file), 'r');
        try { await dir.sync(); } finally { await dir.close(); }
      }
    } catch (error) {
      if (['RESET_CLAIM_PAUSED', 'RESET_STORE_FULL', 'RESET_STORE_LOCKED', 'RESET_STORE_UNAVAILABLE'].includes(error?.code)) throw error;
      throw fail('RESET_STORE_UNAVAILABLE');
    } finally {
      if (temp) await fs.rm(temp, { force: true }).catch(() => {});
      if (lock) { await lock.close().catch(() => {}); await fs.rm(`${this.file}.lock`, { force: true }).catch(() => {}); }
    }
  }
  claim(key, requestId, at) {
    return this.update(data => {
      if (data.claims.some(row => row.key === key)) throw fail('RESET_CLAIM_PAUSED', false);
      if (data.claims.length >= MAX_CLAIMS) throw fail('RESET_STORE_FULL');
      data.claims.push({ key, requestId, state: 'claimed', at });
    });
  }
  settle(key, requestId, result) {
    return this.update(data => {
      const row = data.claims.find(item => item.key === key);
      if (!row || row.requestId !== requestId || row.state !== 'claimed') throw fail('RESET_STORE_UNAVAILABLE');
      row.state = 'settled'; row.result = result;
    });
  }
}

/**
 * Add durable no-replay protection to createCodexResetCreditService without
 * changing its inspect/prepare/consume/clear API. Host must supply its EXISTING
 * reset-credit-claims.json path and an explicit network fetch; no default fetch.
 *
 * createDurableSubscriptionResetService({ createService, storeFile, ...options })
 *   -> { inspect, prepare, consume, clear, dispose }
 *
 * options are forwarded to createService, except validateDispatch(accountId), an
 * optional synchronous final identity/revocation check. Truthy/Promise is not true.
 * clear() aborts/invalidate in-flight calls but NEVER clears durable protection.
 * Every claimed card remains blocked forever (including all HTTP failures,
 * malformed replies, crashes, expired challenges, successes, and clear/restarts).
 * There is intentionally NO retry/unpause/delete API. Results are not replayed.
 *
 * This wrapper does not invent account-epoch isolation or import credentials.
 * Keep the existing identity checks and call clear() on account changes. Host may
 * add validateDispatch if it has a synchronous account/revocation capability.
 * Existing provider prechecks/delay/acknowledgment remain authoritative. Pending
 * protection may also reject at consume time after a normal prepare response.
 * Only hashes, idempotency UUIDs, fixed result codes/counts and timestamps persist.
 * Private guard failures survive the wrapped service's generic uncertain catch.
 */
export function createDurableSubscriptionResetService({ createService, storeFile, validateDispatch, ...options } = {}) {
  if (typeof createService !== 'function' || typeof storeFile !== 'string' || !path.isAbsolute(storeFile)
    || typeof options.fetch !== 'function' || (validateDispatch !== undefined && typeof validateDispatch !== 'function')
    || (options.now !== undefined && typeof options.now !== 'function')) throw fail('RESET_OPTIONS_INVALID');
  const store = new ClaimStore(path.resolve(storeFile)), context = new AsyncLocalStorage();
  const transport = options.fetch, now = options.now ?? Date.now;
  let generation = 0, closed = false, lifetime = new AbortController();
  const guard = (state, signal) => {
    if (closed) throw fail('RESET_CLOSED');
    if (state.generation !== generation) throw fail('RESET_IDENTITY_CHANGED');
    if (signal?.aborted) throw fail('RESET_CANCELLED');
  };
  const service = createService({ ...options, fetch: async (input, init) => {
    const state = context.getStore();
    if (!state) throw fail('RESET_REQUEST_INVALID');
    if (input === DETAILS_URL && init?.method === 'GET') {
      guard(state, init.signal);
      return transport(input, init);
    }
    try {
      guard(state, init?.signal);
      if (state.operation !== 'consume' || state.claim || input !== CONSUME_URL || init?.method !== 'POST' || typeof init.body !== 'string' || init.body.length > 16384) throw fail('RESET_REQUEST_INVALID');
      const accountId = new Headers(init.headers).get('chatgpt-account-id');
      const body = JSON.parse(init.body);
      if (!text(accountId, 512) || !record(body) || !only(body, ['redeem_request_id', 'credit_id']) || !text(body.credit_id, 256)
        || typeof body.redeem_request_id !== 'string' || !UUID.test(body.redeem_request_id)) throw fail('RESET_REQUEST_INVALID');
      const at = now();
      if (!Number.isSafeInteger(at) || at < 0) throw fail('RESET_CLOCK_INVALID');
      const key = claimKey(accountId, body.credit_id);
      await store.claim(key, body.redeem_request_id, at);
      state.claim = { key, requestId: body.redeem_request_id };
      guard(state, init.signal);
      if (validateDispatch !== undefined) {
        let valid;
        try { valid = validateDispatch(accountId); } catch { throw fail('RESET_IDENTITY_CHANGED'); }
        if (valid !== true) { valid?.catch?.(() => {}); throw fail('RESET_IDENTITY_CHANGED'); }
      }
      // No await between the final synchronous guard and calling transport.
      guard(state, init.signal);
      state.dispatched = true;
      return await transport(input, init);
    } catch (error) {
      state.error = state.dispatched ? fail('RESET_UNCERTAIN', false)
        : /^RESET_[A-Z_]+$/.test(error?.code) ? error : fail('RESET_REQUEST_INVALID');
      throw state.error;
    }
  } });
  if (!service || ['inspect', 'prepare', 'consume', 'clear'].some(method => typeof service[method] !== 'function')) throw fail('RESET_OPTIONS_INVALID');
  const invoke = (operation, args = {}) => {
    const state = { operation, generation, claim: null, dispatched: false, error: null };
    return context.run(state, async () => {
      guard(state, args.signal);
      const signal = args.signal === undefined ? lifetime.signal : AbortSignal.any([args.signal, lifetime.signal]);
      try {
        const result = await service[operation]({ ...args, signal });
        if (state.claim) await store.settle(state.claim.key, state.claim.requestId, resultOf(result));
        guard(state, signal);
        return result;
      } catch (error) {
        if (state.error) throw state.error;
        if (state.dispatched) throw fail('RESET_UNCERTAIN', false);
        // Keep the upstream validation/delay/acknowledgement errors unchanged.
        throw error;
      }
    });
  };
  const clear = () => { generation++; lifetime.abort(); lifetime = new AbortController(); service.clear(); };
  return Object.freeze({
    inspect: args => invoke('inspect', args),
    prepare: args => invoke('prepare', args),
    consume: args => invoke('consume', args),
    clear,
    dispose() { closed = true; clear(); },
  });
}
