import { createHash, randomBytes } from 'node:crypto';
import { subscriptionRpc } from './codex.js';
import { selectedCodexAccount, maskCodexEmail } from './codex-identity.js';

const LEASE_MS = 15_000, OPERATION_MS = 10_000, MAX_BODY = 8192;
const SOURCES = Object.freeze({
  'openai-codex': { status: 'codex-subscription/status', select: 'codex-subscription/account/select', selection: 'active' },
  codex: { status: 'subscriptions-auth.status', select: 'subscriptions-auth.setDefault', selection: 'default' },
});
const MULTI_WARMUP = Object.freeze({ available: false,
  reason: '缺少本机已验证的公共账号绑定模型及逐账号预算授权；未启用，不后台轮换账号。' });
const MESSAGES = Object.freeze({
  disposed: '账号控制已关闭。', busy: '账号或额度操作进行中，请稍后重新读取。',
  context: '宿主尚未确认当前来源的账号切换能力。', unsupported: '当前来源缺少公共账号状态接口。',
  login: '当前来源尚未登录。', empty: '当前来源没有已绑定账号。', single: '至少需要两个有效已绑定 Codex 账号。',
  invalid: '账号列表或唯一选中状态无效。', token: '确认已过期或无效，请重新读取账号。',
  confirm: '必须明确确认并选择非当前账号。', stale: '账号、来源或宿主代际已变化，请重新读取。',
  unavailable: '账号操作不可用，请重新读取状态；不会自动重试或切回。',
  unknown: '切换结果未知，请重新读取状态；不会自动重试或切回。',
});
class ControlError extends Error {
  constructor(code, status = 409) { super(MESSAGES[code]); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new ControlError(code, status); };
const opaque = () => randomBytes(12).toString('base64url');

function inspect(status, provider) {
  if (status === null) return { reason: 'unsupported' };
  if (provider === 'openai-codex' && status?.authenticated !== true) return { reason: 'login' };
  const rows = provider === 'codex' ? status?.providers?.codex?.accounts : status?.accounts;
  if (!Array.isArray(rows)) return { reason: provider === 'codex' && status?.providers?.codex == null ? 'login' : 'invalid' };
  if (rows.length === 0) return { reason: 'empty' };
  // This shared boundary validates every ID, duplicates, size and exactly one selection.
  const selected = selectedCodexAccount(status, provider);
  if (!selected) return { reason: 'invalid' };
  if (selected.count < 2) return { reason: 'single' };
  const key = provider === 'codex' ? 'key' : 'id';
  const members = rows.map(row => [row[key], row[key] === selected.id]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return { rows, key, selected: selected.id,
    digest: createHash('sha256').update(JSON.stringify(members)).digest('hex') };
}

// context() is a host capability attestation, NOT a provider inference: return null
// until this exact bridge/source has a verified public selection RPC. generation must
// change for bridge/config lifecycle changes. All callbacks are synchronous.
// begin() takes the host lease and invalidates quota identity; false means no lease.
export function createAccountControl({ context, blocked, begin, end, changed, clock = Date.now }) {
  if ([context, blocked, begin, end, changed, clock].some(fn => typeof fn !== 'function')) throw new TypeError('account control callbacks required');
  let disposed = false, busy = false, lease = null;
  const lifetime = new AbortController(), salt = randomBytes(16).toString('hex');
  const snapshot = () => {
    let ctx;
    try { ctx = context(); } catch { return null; }
    if (!ctx || !Object.hasOwn(SOURCES, ctx.provider) || typeof ctx.bridge?.fetch !== 'function'
      || !(typeof ctx.generation === 'string' || Number.isSafeInteger(ctx.generation))) return null;
    return { bridge: ctx.bridge, provider: ctx.provider, generation: ctx.generation };
  };
  const same = saved => {
    const now = snapshot();
    return now && now.bridge === saved.bridge && now.provider === saved.provider && now.generation === saved.generation;
  };
  const live = () => { if (disposed) fail('disposed', 410); };
  const isBlocked = () => { try { return blocked() !== false; } catch { return true; } };
  const guard = (saved, signal) => { live(); signal.throwIfAborted(); if (!same(saved)) fail('stale'); };
  // A bridge may ignore AbortSignal. Race the entire RPC, including body decoding,
  // so late results can never continue the operation or authorize a late write.
  async function rpc(saved, method, payload, signal) {
    guard(saved, signal);
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const value = await Promise.race([subscriptionRpc(saved.bridge, method, payload, signal), cancelled]);
      guard(saved, signal);
      return value;
    } finally { signal.removeEventListener('abort', abort); }
  }
  const signal = () => AbortSignal.any([AbortSignal.timeout(OPERATION_MS), lifetime.signal]);
  const refresh = evidence => { try { changed(evidence); } catch { /* Never expose host exceptions. */ } };
  const disabled = (reason, ctx = null) => ({ enabled: false, reason: MESSAGES[reason], token: null,
    validForMs: 0, provider: ctx?.provider ?? null, selection: ctx ? SOURCES[ctx.provider].selection : null, current: null, accounts: [] });

  return Object.freeze({
    view() { live(); return { busy, multiWarmup: { ...MULTI_WARMUP } }; },
    async list() {
      live();
      if (busy) fail('busy');
      lease = null; // Every explicit list revokes the previous confirmation, even if it fails.
      if (isBlocked()) fail('busy');
      const ctx = snapshot();
      if (!ctx) return disabled('context');
      busy = true;
      try {
        const operation = signal();
        const status = await rpc(ctx, SOURCES[ctx.provider].status, {}, operation);
        guard(ctx, operation);
        const state = inspect(status, ctx.provider);
        if (state.reason) return disabled(state.reason, ctx);
        const targets = new Map();
        const accounts = state.rows.map(row => {
          const id = row[state.key], target = opaque();
          targets.set(target, id);
          return { target, label: maskCodexEmail(ctx.provider === 'codex' ? row.account : row.email)
            ?? `匿名账号 ${createHash('sha256').update(salt).update(id).digest('hex').slice(0, 8)}`,
          current: id === state.selected };
        });
        const token = opaque(), issued = clock();
        if (!Number.isFinite(issued)) fail('unavailable', 503);
        lease = { ctx, token, issued, targets, digest: state.digest, selected: state.selected };
        return { enabled: true, reason: null, token, validForMs: LEASE_MS, provider: ctx.provider,
          selection: SOURCES[ctx.provider].selection, current: accounts.find(row => row.current).target, accounts };
      } catch (error) {
        lease = null;
        if (error instanceof ControlError) throw error;
        fail('unavailable', 503);
      } finally { busy = false; }
    },
    async switch(input) {
      live();
      let acquired = false, attempted = false, ownsBusy = false, verified = false;
      try {
        // Consume before *any* await, including invalid confirmation and busy rejection.
        const saved = lease; lease = null;
        if (busy || isBlocked()) fail('busy');
        const now = clock();
        if (!saved || input?.token !== saved.token || !Number.isFinite(now) || now < saved.issued || now - saved.issued >= LEASE_MS) fail('token');
        const target = input?.target, id = saved.targets.get(target);
        if (input?.confirm !== true || !id || id === saved.selected) fail('confirm', 400);
        if (!same(saved.ctx)) fail('stale');
        busy = true; ownsBusy = true;
        // No await can occur between checking blocked and taking the host lease.
        if (begin() === false) fail('busy');
        acquired = true;
        const operation = signal(), source = SOURCES[saved.ctx.provider];
        guard(saved.ctx, operation);
        const before = await rpc(saved.ctx, source.status, {}, operation);
        guard(saved.ctx, operation);
        const state = inspect(before, saved.ctx.provider);
        if (state.reason || state.digest !== saved.digest || state.selected !== saved.selected) fail('stale');
        guard(saved.ctx, operation);
        attempted = true;
        const result = await rpc(saved.ctx, source.select, saved.ctx.provider === 'codex' ? { provider: 'codex', account: id } : { id }, operation);
        guard(saved.ctx, operation);
        if (result === null) fail('unknown', 503);
        const after = await rpc(saved.ctx, source.status, {}, operation);
        guard(saved.ctx, operation);
        const confirmed = inspect(after, saved.ctx.provider);
        if (confirmed.reason || confirmed.selected !== id) fail('unknown', 503);
        verified = true;
        return { ok: true, provider: saved.ctx.provider, selection: source.selection, current: target };
      } catch (error) {
        if (error instanceof ControlError) throw error;
        fail(attempted ? 'unknown' : 'unavailable', 503);
      } finally {
        try { if (acquired) end(); }
        catch { verified = false; fail(attempted ? 'unknown' : 'unavailable', 503); }
        finally {
          if (ownsBusy) busy = false;
          refresh({ attempted, confirmed: verified }); // Also refresh on safe, pre-lease rejection.
        }
      }
    },
    dispose() { if (!disposed) { disposed = true; lease = null; lifetime.abort(); } },
  });
}

function header(req, name) {
  return typeof req.headers?.get === 'function' ? req.headers.get(name) : req.headers?.[name];
}
class BodyError extends Error { constructor(status) { super('invalid request'); this.status = status; } }
async function readBody(req) {
  if (typeof header(req, 'content-type') !== 'string' || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(header(req, 'content-type'))) throw new BodyError(415);
  const length = header(req, 'content-length');
  if (length != null && (!/^\d+$/.test(String(length)) || Number(length) > MAX_BODY)) throw new BodyError(413);
  const chunks = []; let size = 0;
  const stream = typeof req[Symbol.asyncIterator] === 'function' ? req : req.body;
  if (stream) for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY) throw new BodyError(413);
    chunks.push(bytes);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new BodyError(400); }
}
function validBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  if (body.action === 'list') return keys.length === 1;
  return body.action === 'switch' && keys.length === 4 && keys.every(key => ['action', 'token', 'target', 'confirm'].includes(key))
    && typeof body.token === 'string' && /^[A-Za-z0-9_-]{16}$/.test(body.token)
    && typeof body.target === 'string' && /^[A-Za-z0-9_-]{16}$/.test(body.target) && body.confirm === true;
}

// Supports Node IncomingMessage and WHATWG Request. authorize is synchronous and
// must return literal true; its rejection writes are captured, not forwarded.
export function accountControlHandler(control, authorize) {
  return async function handler(req, res) {
    const method = req.method ?? 'GET';
    const respond = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', ...(status === 405 ? { Allow: 'GET, HEAD, POST' } : {}) });
      res.end(method === 'HEAD' ? undefined : JSON.stringify(body));
    };
    try {
      let authStatus = 403, wrote = false;
      const authResponse = { statusCode: 403,
        writeHead(code) { wrote = true; authStatus = code === 401 ? 401 : 403; return this; },
        setHeader() { return this; }, end() { wrote = true; } };
      let authorized = false;
      try { authorized = authorize(req, authResponse) === true && !wrote; } catch { /* fail closed */ }
      if (!authorized) return respond(authStatus, { error: '账号操作未获授权。' });
      if (method === 'GET' || method === 'HEAD') return respond(200, control.view());
      if (method !== 'POST') return respond(405, { error: '仅允许 GET、HEAD、POST。' });
      const body = await readBody(req);
      if (!validBody(body)) throw new BodyError(400);
      const result = body.action === 'list' ? await control.list() : await control.switch(body);
      respond(200, result);
    } catch (error) {
      const status = error instanceof BodyError ? error.status : error instanceof ControlError ? error.status : 503;
      const message = error instanceof ControlError ? MESSAGES[error.code]
        : status === 413 ? '请求体超过 8KB 限制。' : status === 415 ? '仅接受 JSON 请求。'
          : status === 400 ? '账号操作请求格式无效。' : MESSAGES.unavailable;
      respond(status, { error: message });
    }
  };
}
