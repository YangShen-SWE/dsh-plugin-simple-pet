import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { localSchedule } from './warmup.js';

const MAX_ACCOUNTS = 8, MAX_BYTES = 256 * 1024, TIMEOUT_MS = 60_000;
const hash = (value, size) => typeof value === 'string' && value.length === size && /^[a-f0-9]+$/.test(value);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const validTime = value => typeof value === 'string' && value.length === 5 && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const dayOf = now => localSchedule(now, '00:00').day;
const revision = bytes => createHash('sha256').update(bytes).digest('hex');
const localErrors = new WeakSet();
function error(status, message) { const value = Object.assign(new Error(message), { status }); localErrors.add(value); return value; }
export const DEFAULT_MULTI_WARMUP = Object.freeze({ enabled: false, time: '09:30', accounts: Object.freeze([]) });
// subscriptions 0.9.9 may return lastSnapshot after a failed forced fetch. Receipt time,
// 100% and a changed resetAt cannot prove a fresh account-bound five-hour report.
export const MULTI_WARMUP_TRIGGERS = Object.freeze({ daily: true, startupFull: false, resetFull: false,
  quotaEvidence: 'unverifiable', reason: '当前通用订阅接口没有可核验的额度获取时间、5h 窗口时长及账号回显；force 失败仍可能返回旧缓存。启动满额与 5h 刷新自动预热暂不可用，额外额度授权也不能绕过此限制。' });
export function multiWarmupConfig(raw) {
  if (!record(raw) || Reflect.ownKeys(raw).some(key => !['enabled', 'time', 'accounts'].includes(key))
    || typeof raw.enabled !== 'boolean' || !validTime(raw.time) || !Array.isArray(raw.accounts) || raw.accounts.length > MAX_ACCOUNTS) {
    throw error(400, '多账号预热设置无效。');
  }
  const seen = new Set();
  const accounts = raw.accounts.map(row => {
    if (!record(row) || Object.keys(row).sort().join(',') !== 'accountKey,allowUnverifiedQuota,enabled,modelKey'
      || !hash(row.accountKey, 16) || !hash(row.modelKey, 64) || typeof row.enabled !== 'boolean'
      || typeof row.allowUnverifiedQuota !== 'boolean' || seen.has(row.accountKey)) throw error(400, '账号授权或绑定模型无效。');
    seen.add(row.accountKey);
    return { accountKey: row.accountKey, modelKey: row.modelKey, enabled: row.enabled, allowUnverifiedQuota: row.allowUnverifiedQuota };
  });
  if (raw.enabled && !accounts.some(row => row.enabled)) throw error(400, '开启前请至少明确授权一个账号。');
  return { enabled: raw.enabled, time: raw.time, accounts };
}
function decode(bytes) {
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')); }
  catch { throw error(503, '多账号预热文件不可用，未修改也未执行。'); }
  if (!record(data) || data.version !== 1 || !Array.isArray(data.attempts) || data.attempts.length > 512 || typeof data.paused !== 'boolean') {
    throw error(503, '多账号预热记录不可用，已停止。');
  }
  let config;
  try { config = multiWarmupConfig(data.config); } catch { throw error(503, '多账号预热设置不可用，已停止。'); }
  const seen = new Set();
  for (const item of data.attempts) {
    if (!record(item) || typeof item.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.day)
      || !hash(item.accountKey, 16) || !hash(item.modelKey, 64) || !['claimed','succeeded','unknown','unsent'].includes(item.status)
      || !Number.isSafeInteger(item.attemptedAt) || item.attemptedAt <= 0
      || Reflect.ownKeys(item).some(key => !['day','accountKey','modelKey','status','attemptedAt','finishedAt','backend'].includes(key))
      || (Object.hasOwn(item, 'backend') && !['legacy','official'].includes(item.backend))
      || (Object.hasOwn(item, 'finishedAt') && (!Number.isSafeInteger(item.finishedAt) || item.finishedAt < item.attemptedAt))
      || seen.has(`${item.day}:${item.accountKey}`)) throw error(503, '多账号预热去重记录不可用，已停止。');
    seen.add(`${item.day}:${item.accountKey}`);
  }
  // A crashed claim is not evidence of an unsent request. Keep the original durable claim.
  return { version: 1, config, attempts: data.attempts, paused: data.paused || data.attempts.some(row => ['claimed','unknown'].includes(row.status)) };
}
const queues = new Map();
function serialized(file, operation) {
  const key = path.resolve(file).toLowerCase(), previous = queues.get(key) ?? Promise.resolve();
  const task = previous.then(operation), tail = task.then(() => {}, () => {});
  queues.set(key, tail); void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return task;
}

// Separate from visual preferences and their native receipt: only hashes and attempt metadata persist.
export class MultiWarmupStore {
  constructor(file) { this.file = path.resolve(file); }
  async read() { return serialized(this.file, () => this._read()); }
  async _read() {
    let handle;
    try {
      handle = await fs.open(this.file, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw error(503, '多账号预热文件过大或无效。');
      const bytes = Buffer.alloc(MAX_BYTES + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_BYTES) throw error(503, '多账号预热文件过大。');
      const contents = bytes.subarray(0, bytesRead);
      return { data: decode(contents), revision: revision(contents) };
    } catch (cause) {
      if (cause.code === 'ENOENT') return { data: { version: 1, config: { ...DEFAULT_MULTI_WARMUP, accounts: [] }, attempts: [], paused: false }, revision: 'missing' };
      if (cause.status) throw cause;
      throw error(503, '无法读取多账号预热记录。');
    } finally { await handle?.close(); }
  }
  async transaction(change) {
    return serialized(this.file, async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const lock = `${this.file}.lock`, nonce = randomUUID();
      let handle, temporary;
      try {
        handle = await fs.open(lock, 'wx', 0o600); await handle.writeFile(nonce); await handle.sync();
        const current = await this._read(), next = await change(current);
        if (!next) return current;
        const bytes = Buffer.from(JSON.stringify(next) + '\n'); decode(bytes);
        if (bytes.length > MAX_BYTES) throw error(503, '多账号预热记录空间不足，已停止。');
        temporary = `${this.file}.${nonce}.tmp`;
        const output = await fs.open(temporary, 'wx', 0o600);
        try { await output.writeFile(bytes); await output.sync(); } finally { await output.close(); }
        await fs.rename(temporary, this.file); temporary = null;
        return { data: next, revision: revision(bytes) };
      } catch (cause) {
        if (cause.status) throw cause;
        throw error(503, '无法安全保存多账号预热记录；不会调用模型。');
      } finally {
        if (temporary) await fs.unlink(temporary).catch(() => {});
        if (handle) {
          await handle.close().catch(() => {});
          // Never unlink someone else's lock, even after external interference.
          if (await fs.readFile(lock, 'utf8').catch(() => null) === nonce) await fs.unlink(lock).catch(() => {});
        }
      }
    });
  }
  async configure(config, expectedRevision) {
    const valid = multiWarmupConfig(config);
    if (expectedRevision !== 'missing' && !hash(expectedRevision, 64)) throw error(400, '请先读取多账号预热设置版本。');
    return this.transaction(current => {
      if (current.revision !== expectedRevision) throw error(409, '多账号预热记录已变化，请重新读取；草稿未自动覆盖。');
      // Configuration edits cannot erase attempts or discharge an unknown-result pause.
      return { ...current.data, config: valid };
    });
  }
  async claim(account, day, now, expectedConfig, backend = 'legacy') {
    let claimed = false;
    await this.transaction(({ data }) => {
      if (!['legacy','official'].includes(backend) || data.attempts.some(row => row.day >= day && (row.backend ?? 'legacy') !== backend)
        || !Number.isSafeInteger(now) || now <= 0 || day !== dayOf(now)
        || data.attempts.some(row => row.day > day || row.attemptedAt > now || (row.finishedAt ?? 0) > now)
        || data.paused || JSON.stringify(data.config) !== JSON.stringify(expectedConfig)
        || !data.config.enabled || !data.config.accounts.some(row => row.enabled && row.accountKey === account.accountKey && row.modelKey === account.modelKey && row.allowUnverifiedQuota)
        || data.attempts.some(row => row.day === day && row.accountKey === account.accountKey)) return null;
      const attempts = data.attempts.filter(row => row.day >= day || ['claimed','unknown'].includes(row.status));
      if (attempts.length >= 512) throw error(503, '去重记录已满，已停止。');
      attempts.push({ day, accountKey: account.accountKey, modelKey: account.modelKey, status: 'claimed', attemptedAt: now, ...(backend === 'official' ? { backend } : {}) });
      claimed = true; return { ...data, attempts };
    });
    return claimed;
  }
  async finish(account, day, status, now) {
    if (!['succeeded','unknown','unsent'].includes(status)) throw new TypeError('invalid outcome');
    return this.transaction(({ data }) => {
      const item = data.attempts.find(row => row.day === day && row.accountKey === account.accountKey);
      if (!item || item.status !== 'claimed' || item.modelKey !== account.modelKey) throw error(503, '预热认领记录不匹配，已停止。');
      item.status = status; item.finishedAt = Math.max(item.attemptedAt, now);
      return { ...data, paused: status === 'unknown' || data.attempts.some(row => ['claimed','unknown'].includes(row.status)) };
    });
  }
}
function bounded(operation, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
export class MultiWarmupScheduler {
  constructor({ store, context, discover, run, signal, clock = Date.now, onChange = () => {}, claimLease = () => true }) {
    Object.assign(this, { store, context, discover, run, signal, clock, onChange, claimLease });
    this.active = null; this.busy = null; this.stopped = false; this.previous = null; this.expectedWake = null;
    this.config = { ...DEFAULT_MULTI_WARMUP, accounts: [] };
    this.missedDay = null; this.missedTimes = new Set();
    this.view = { status: 'disabled', detail: '多账号预热默认关闭', accountResults: [], nextDailyAt: null };
  }
  update(status, detail, extra = {}) { Object.assign(this.view, { status, detail }, extra); this.onChange(this.view); }
  nextDelay(now = this.clock()) {
    this.expectedWake = !this.stopped && this.config.enabled && !this.busy ? localSchedule(now, this.config.time).next : null;
    return this.expectedWake === null ? null : Math.max(1, this.expectedWake - now);
  }
  async tick(now = this.clock()) {
    if (this.stopped || this.signal?.aborted) return;
    let state;
    try { state = await this.store.read(); }
    catch { this.active?.abort(); this.config = { ...DEFAULT_MULTI_WARMUP, accounts: [] }; this.update('blocked', '多账号预热记录不可读，已停止；不会回退其他账号。'); return; }
    const config = state.data.config, changed = JSON.stringify(config) !== JSON.stringify(this.config);
    if (changed) this.active?.abort();
    const previous = this.previous;
    this.config = config; this.previous = previous === null ? now : Math.max(previous, now); this.expectedWake = null;
    const schedule = localSchedule(now, config.time); this.view.nextDailyAt = config.enabled ? schedule.next : null;
    if (this.busy) return;
    if (!config.enabled) { this.update('disabled', '多账号预热已关闭；不修改原有单账号开关'); return; }
    if (state.data.paused) { this.update('paused', '存在未完成认领或结果未知的请求，已持久暂停；不会自动重试。'); return; }
    if (this.missedDay === null || schedule.day > this.missedDay) { this.missedDay = schedule.day; this.missedTimes.clear(); }
    const interrupted = changed || previous === null || now < previous || now - previous >= 60_000;
    // Remember an ineligible occurrence, not just its first tick. Otherwise the
    // second tick in the same minute would turn a skipped startup into a send.
    if (interrupted && schedule.at !== null && now >= schedule.at) this.missedTimes.add(config.time);
    if (interrupted || this.missedTimes.has(config.time)
      || schedule.at === null || now < schedule.at || now - schedule.at >= 60_000) { this.update('waiting', '等待下一次本地定时；不在启动、休眠恢复或开启时补发'); return; }
    const context = this.context();
    if (!context) { this.update('unsupported', '缺少受支持的公共账号绑定入口，或其他预热/切号正在进行'); return; }
    const lifetime = new AbortController(); this.active = lifetime;
    const operation = AbortSignal.any([lifetime.signal, ...(this.signal ? [this.signal] : []), AbortSignal.timeout(TIMEOUT_MS)]);
    this.busy = this._run(state.data, context, schedule.day, operation).finally(() => { this.busy = null; if (this.active === lifetime) this.active = null; });
    await this.busy;
  }
  async _run(data, context, day, signal) {
    const same = () => { const value = this.context(); return value && value.bridge === context.bridge && value.generation === context.generation; };
    const results = [];
    this.update('preparing', '核验已授权账号的公开绑定模型，不切换全局账号', { accountResults: results });
    try {
      const catalogue = await bounded(() => this.discover({ ...context, signal }), signal);
      if (!same()) throw new Error('context changed');
      for (const row of data.config.accounts.filter(item => item.enabled)) {
        signal.throwIfAborted();
        if (!same()) throw new Error('context changed');
        if (!row.allowUnverifiedQuota) { results.push({ accountKey: row.accountKey, status: 'skipped', detail: '公共额度没有新鲜度证明，未授权按预算尝试' }); continue; }
        if (!catalogue.accounts?.some(account => account.accountKey === row.accountKey && account.models?.some(model => model.modelKey === row.modelKey))) {
          results.push({ accountKey: row.accountKey, status: 'skipped', detail: '绑定账号或模型入口已撤销' }); continue;
        }
        if (context.singleAttemptToday) { results.push({ accountKey: row.accountKey, status: 'skipped', detail: '今天已有旧单账号预热认领，保守避免重复' }); continue; }
        if (!this.claimLease()) throw new Error('another scheduler owns automation');
        if (!await this.store.claim(row, day, this.clock(), data.config, context.backend ?? 'legacy')) { results.push({ accountKey: row.accountKey, status: 'skipped', detail: '今天已认领、记录变化或已暂停' }); continue; }
        let status = 'unknown';
        try {
          signal.throwIfAborted(); if (!same()) throw Object.assign(new Error('context changed'), { requestNotSent: true });
          this.update('running', `正在预热 #${row.accountKey.slice(0, 8)}（每日一次逻辑请求预算）`);
          await bounded(() => this.run({ ...context, accountKey: row.accountKey, modelKey: row.modelKey, signal, isCurrent: same }), signal);
          signal.throwIfAborted(); if (!same()) throw new Error('context changed');
          status = 'succeeded';
        } catch (cause) { status = cause?.requestNotSent === true ? 'unsent' : 'unknown'; }
        try { await this.store.finish(row, day, status, this.clock()); }
        catch { this.update('paused', '无法保存终态，保留认领并停止后续账号；不会重试'); return; }
        results.push({ accountKey: row.accountKey, status, detail: status === 'succeeded' ? '已完成；不据此推算额度重置时间' : status === 'unsent' ? '未发送，不在同日自动重试' : '请求可能消耗额度，已持久暂停全部后续账号' });
        if (status === 'unknown') { this.update('paused', '预热结果未知，已停止后续账号；不会自动重试'); return; }
      }
      this.update('settled', '本次逐账号计划已结束；每账号每日最多一次逻辑请求，不是 HTTP/Token/费用硬上限', { accountResults: results });
    } catch { this.update('blocked', '能力核验、读取或取消失败；不会回退 Pool 或切换全局账号', { accountResults: results }); }
  }
  async stop() { this.stopped = true; this.active?.abort(); await this.busy; }
}
export function multiWarmupHandler({ store, discover, context, authorize, changed = () => {} }) {
  return async (req, res) => {
    if (!authorize(req, res)) return;
    const method = req.method ?? 'GET';
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(status === 405 ? { Allow: 'GET, HEAD, PUT, POST' } : {}) }); res.end(method === 'HEAD' ? undefined : JSON.stringify(data)); };
    if (!['GET','HEAD','PUT','POST'].includes(method)) { reply(405, { error: 'Method not allowed' }); return; }
    try {
      if (method === 'GET' || method === 'HEAD') { const current = await store.read(); reply(200, { config: current.data.config, revision: current.revision, paused: current.data.paused, triggers: MULTI_WARMUP_TRIGGERS }); return; }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] ?? req.headers?.get?.('content-type') ?? '')) throw error(415, '需要 JSON 请求。');
      let size = 0; const chunks = [];
      for await (const chunk of req) { const part = Buffer.from(chunk); size += part.length; if (size > 16_384) throw error(413, '请求过大。'); chunks.push(part); }
      let body; try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw error(400, '请求无效。'); }
      if (method === 'PUT') {
        if (!record(body) || Object.keys(body).sort().join(',') !== 'config,revision') throw error(400, '设置请求无效。');
        const result = await store.configure(body.config, body.revision); changed(); reply(200, { config: result.data.config, revision: result.revision, paused: result.data.paused, triggers: MULTI_WARMUP_TRIGGERS }); return;
      }
      if (!record(body) || Object.keys(body).join(',') !== 'action' || body.action !== 'discover') throw error(400, '只能明确读取公共绑定目录。');
      const current = context();
      if (!current) throw error(409, '当前宿主没有已验证的公共绑定能力。');
      const signal = AbortSignal.timeout(10_000), list = await bounded(() => discover({ ...current, signal }), signal);
      const after = context();
      if (!after || after.bridge !== current.bridge || after.generation !== current.generation) throw error(409, '来源已变化，请重新读取。');
      reply(200, list);
    } catch (cause) {
      const trusted = localErrors.has(cause);
      reply(trusted && [400,409,413,415,503].includes(cause.status) ? cause.status : 503,
        { error: trusted && [400,409,413,415].includes(cause.status) ? cause.message : '多账号预热暂不可用；未自动发送或切号。' });
    }
  };
}
