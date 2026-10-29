// Only opaque references and numeric outcomes enter this journal. No account store,
// network client, active-account setter, model provider or legacy scheduler is imported.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const LIMIT = 8 * 1024 * 1024, ACCOUNT_MS = 60_000, DIRECTORY_MS = 10_000;
const ownErrors = new WeakSet();
const object = x => !!x && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => object(x) && Reflect.ownKeys(x).every(k => keys.includes(k)) && keys.every(k => Object.hasOwn(x, k));
const hash = (x, n = 64) => typeof x === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(x);
const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const epoch = x => Number.isSafeInteger(x) && x > 0 && x <= 8_640_000_000_000_000;
const digest = x => createHash('sha256').update(x).digest('hex');
const clone = x => structuredClone(x);
function fail(code, status = 409) { const e = Object.assign(new Error(code), { code, status }); ownErrors.add(e); return e; }
function zone(x) { try { return typeof x === 'string' && x.length <= 100 && !!new Intl.DateTimeFormat('en', { timeZone: x }); } catch { return false; } }
function time(x) { return typeof x === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(x); }
export const DEFAULT_UNIFIED_WARMUP = Object.freeze({ enabled: false, daily: false, time: '09:30', timeZone: 'UTC', accounts: Object.freeze([]) });
export function unifiedWarmupConfig(raw) {
  if (!exact(raw, ['enabled', 'daily', 'time', 'timeZone', 'accounts']) || typeof raw.enabled !== 'boolean'
    || typeof raw.daily !== 'boolean' || !time(raw.time) || !zone(raw.timeZone) || !Array.isArray(raw.accounts) || raw.accounts.length > 8) throw fail('invalid_config', 400);
  const seen = new Set();
  const accounts = raw.accounts.map(row => {
    if (!exact(row, ['accountKey', 'accountGeneration', 'modelKey', 'manual', 'daily', 'allowUnknownQuota'])
      || !hash(row.accountKey, 16) || !hash(row.accountGeneration) || !hash(row.modelKey)
      || ['manual', 'daily', 'allowUnknownQuota'].some(k => typeof row[k] !== 'boolean') || seen.has(row.accountKey)) throw fail('invalid_config', 400);
    seen.add(row.accountKey); return { ...row };
  });
  if (raw.enabled && !accounts.some(a => a.manual || (raw.daily && a.daily))) throw fail('authorization_required', 400);
  return { enabled: raw.enabled, daily: raw.daily, time: raw.time, timeZone: raw.timeZone, accounts };
}
const formatters = new Map();
function calendar(now, timeZone) {
  if (!epoch(now)) throw fail('invalid_clock', 400);
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  const p = Object.fromEntries(formatters.get(timeZone).formatToParts(now).map(a => [a.type, a.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minute: `${p.hour}:${p.minute}` };
}
function initial() { return { version: 2, authorizationRevision: randomUUID(), config: clone(DEFAULT_UNIFIED_WARMUP), claims: [], highWater: 0, paused: null, legacyResumePaused: false, legacyDays: [], timeZoneHoldUntil: 0 }; }
function numericUsage(value) {
  if (!object(value) || Object.keys(value).length > 32) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(k) || !Number.isFinite(v) || v < 0) return undefined;
    out[k] = v;
  }
  return out;
}
function decode(bytes) {
  let d;
  try { d = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')); } catch { throw fail('storage_invalid', 503); }
  if (!exact(d, ['version', 'authorizationRevision', 'config', 'claims', 'highWater', 'paused', 'legacyResumePaused', 'legacyDays', 'timeZoneHoldUntil'])
    || d.version !== 2 || !uuid(d.authorizationRevision) || !Array.isArray(d.claims) || !Number.isSafeInteger(d.highWater) || d.highWater < 0
    || ![null, 'paused_unknown', 'paused_storage', 'paused_clock', 'paused_legacy'].includes(d.paused)
    || typeof d.legacyResumePaused !== 'boolean' || !Array.isArray(d.legacyDays) || !d.legacyDays.every(x => /^\d{4}-\d{2}-\d{2}$/.test(x))
    || !Number.isSafeInteger(d.timeZoneHoldUntil) || d.timeZoneHoldUntil < 0) throw fail('storage_invalid', 503);
  try { d.config = unifiedWarmupConfig(d.config); } catch { throw fail('storage_invalid', 503); }
  const ids = new Set(), budgets = new Set(), days = new Map();
  for (const c of d.claims) {
    const allowed = ['id', 'day', 'timeZone', 'source', 'ownerEpoch', 'authorizationRevision', 'accountKey', 'accountGeneration', 'modelKey', 'budgetSubject', 'status', 'claimedAt', 'finishedAt', 'usage'];
    if (!object(c) || Reflect.ownKeys(c).some(k => !allowed.includes(k)) || !uuid(c.id) || ids.has(c.id)
      || !/^\d{4}-\d{2}-\d{2}$/.test(c.day) || !zone(c.timeZone) || !['manual', 'daily', 'legacy'].includes(c.source)
      || !uuid(c.ownerEpoch) || !uuid(c.authorizationRevision) || !['claimed', 'dispatching', 'succeeded', 'unsent', 'unknown'].includes(c.status)
      || !epoch(c.claimedAt) || c.day !== calendar(c.claimedAt, c.timeZone).day
      || (Object.hasOwn(c, 'finishedAt') && (!epoch(c.finishedAt) || c.finishedAt < c.claimedAt))
      || (['succeeded', 'unsent', 'unknown'].includes(c.status) !== Object.hasOwn(c, 'finishedAt'))
      || (Object.hasOwn(c, 'usage') && (c.status !== 'succeeded' || !numericUsage(c.usage)))) throw fail('storage_invalid', 503);
    if (c.source === 'legacy') {
      if ([c.accountKey, c.accountGeneration, c.modelKey, c.budgetSubject].some(x => x !== null)) throw fail('storage_invalid', 503);
    } else {
      if (!hash(c.accountKey, 16) || !hash(c.accountGeneration) || !hash(c.modelKey) || !hash(c.budgetSubject)) throw fail('storage_invalid', 503);
      const k = `${c.day}:${c.budgetSubject}`;
      if (budgets.has(k)) throw fail('storage_invalid', 503);
      budgets.add(k); const subjects = days.get(c.day) ?? new Set(); subjects.add(c.budgetSubject); days.set(c.day, subjects);
      if (subjects.size > 8) throw fail('storage_invalid', 503);
    }
    ids.add(c.id);
  }
  return d;
}
function readBytes(file, missing = true, max = LIMIT) {
  let fd;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw fail('storage_invalid', 503);
    fd = fs.openSync(file, 'r'); const data = fs.readFileSync(fd);
    if (data.length > max) throw fail('storage_invalid', 503);
    return data;
  } catch (e) { if (e.code === 'ENOENT' && missing) return null; if (ownErrors.has(e)) throw e; throw fail('storage_unavailable', 503); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function syncDirectory(dir) {
  let fd;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); }
  catch (e) {
    // Windows commonly refuses directory fsync. File fsync + rename is NOT a
    // promise of power-loss durability on Windows (or an arbitrary filesystem).
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EISDIR'].includes(e.code)) throw e;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function lock(file, ownerEpoch) {
  const nonce = randomUUID(), text = JSON.stringify({ nonce, pid: process.pid, ownerEpoch });
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(fd, text); fs.fsyncSync(fd); }
  catch (e) { if (fd !== undefined) fs.closeSync(fd); throw fail(e.code === 'EEXIST' ? 'locked' : 'storage_unavailable', e.code === 'EEXIST' ? 409 : 503); }
  fs.closeSync(fd);
  return { release() {
    // Neither age, process liveness nor TTL grants authority to delete a lock.
    if (readBytes(file)?.toString() !== text) throw fail('lock_ownership_lost', 503);
    fs.unlinkSync(file); syncDirectory(path.dirname(file));
  } };
}
function bounded(operation, signal, milliseconds) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (f, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); f(value); };
    const abort = () => done(reject, fail('cancelled'));
    const timer = setTimeout(() => done(reject, fail('timeout')), milliseconds);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    // Both handlers remain attached to an adapter ignoring AbortSignal: late
    // failures are consumed, and late success cannot discharge an unknown latch.
    Promise.resolve().then(() => { signal?.throwIfAborted(); return operation(); }).then(x => done(resolve, x), e => done(reject, e));
  });
}
function safeText(value, fallback) {
  return typeof value === 'string' && value.length > 0 && value.length <= 80 && !/[\u0000-\u001f\u007f@:/\\]/.test(value) ? value : fallback;
}
function catalogue(raw) {
  if (!object(raw) || !Array.isArray(raw.accounts) || raw.accounts.length > 10_000) throw fail('service_invalid', 503);
  const seen = new Set();
  return raw.accounts.map((a, i) => {
    if (!object(a) || !hash(a.accountKey, 16) || !hash(a.accountGeneration) || !hash(a.budgetSubject) || typeof a.active !== 'boolean' || seen.has(a.accountKey)) throw fail('service_invalid', 503);
    seen.add(a.accountKey);
    return { accountKey: a.accountKey, accountGeneration: a.accountGeneration, budgetSubject: a.budgetSubject, active: a.active, label: safeText(a.label, `账号 ${i + 1}`) };
  });
}
function models(raw) {
  if (!object(raw) || typeof raw.verified !== 'boolean' || !hash(raw.revision) || !Array.isArray(raw.models) || raw.models.length > 2000) throw fail('service_invalid', 503);
  const seen = new Set();
  return { verified: raw.verified, revision: raw.revision, models: raw.models.map((m, i) => {
    if (!object(m) || !hash(m.modelKey) || seen.has(m.modelKey)) throw fail('service_invalid', 503);
    seen.add(m.modelKey); return { modelKey: m.modelKey, name: safeText(m.name, `模型 ${i + 1}`) };
  }) };
}
function quota(raw, now) {
  if (!object(raw) || !['ready', 'unknown', 'restricted'].includes(raw.status)) throw fail('service_invalid', 503);
  if (raw.fetchedAt !== undefined && (!epoch(raw.fetchedAt) || raw.fetchedAt > now)) throw fail('service_invalid', 503);
  return { status: raw.status, ...(raw.fetchedAt === undefined ? {} : { fetchedAt: raw.fetchedAt }) };
}

export class UnifiedWarmupCoordinator {
  constructor({ file, legacyFile, retiredMultiFile, clock = Date.now, onChange = () => {}, signal }) {
    if (typeof file !== 'string' || !file) throw fail('invalid_file', 400);
    this.file = path.resolve(file); this.legacyFile = legacyFile && path.resolve(legacyFile); this.retiredMultiFile = retiredMultiFile && path.resolve(retiredMultiFile);
    if ([this.legacyFile, this.retiredMultiFile].includes(this.file)) throw fail('invalid_file', 400);
    this.clock = clock; this.onChange = onChange; this.signal = signal; this.executor = null; this.service = null; this.epoch = null;
    this.seenServices = new WeakSet(); this.receipts = new WeakMap(); this.activeClaims = new Set(); this.busy = null; this.active = null; this.stopped = false;
    this.previousTick = null; this.tickAuthorization = null; this.dailySeen = new Set(); this.localPause = null;
    this.hasExecutionLease = false; this.directoryBusy = false; this.ownerChanged = false; this.hadOwner = false;
    this.view = { status: 'disabled', reason: 'default_disabled', counts: { succeeded: 0, unsent: 0, unknown: 0, skipped: 0 }, running: false, timeZone: 'UTC' };
    this.abortListener = () => { void this.cancel(); };
    signal?.addEventListener('abort', this.abortListener, { once: true });
  }
  _emit(status, reason) {
    this.view = { ...this.view, status, reason, running: !!this.busy };
    try { this.onChange(clone(this.view)); } catch { /* observers have no execution authority */ }
  }
  _read() { const bytes = readBytes(this.file); return { data: bytes === null ? initial() : decode(bytes), revision: bytes === null ? 'missing' : digest(bytes) }; }
  _sentinel() {
    this.localPause = 'paused_storage';
    // If terminal commit failed, the original durable pending claim remains.
    // A second, append-free marker additionally covers failed writes before claim.
    let fd;
    try { fd = fs.openSync(`${this.file}.paused-storage`, 'wx', 0o600); fs.writeFileSync(fd, 'paused_storage\n'); fs.fsyncSync(fd); }
    catch { /* Never delete or overwrite an existing marker. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  _transaction(change) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const lease = lock(`${this.file}.cas.lock`, this.epoch); let temp;
    try {
      const current = this._read(), result = change(current);
      if (!result) return current;
      const bytes = Buffer.from(JSON.stringify(result) + '\n'); decode(bytes);
      if (bytes.length > LIMIT) throw fail('storage_full', 503);
      temp = `${this.file}.${randomUUID()}.tmp`;
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.file); temp = null; syncDirectory(path.dirname(this.file));
      return { data: result, revision: digest(bytes) };
    } catch (e) {
      if (!ownErrors.has(e) || e.status === 503) this._sentinel();
      throw ownErrors.has(e) ? e : fail('storage_unavailable', 503);
    } finally {
      if (temp) { try { fs.unlinkSync(temp); } catch { /* only our random temporary file */ } }
      try { lease.release(); } catch { this._sentinel(); }
    }
  }
  _legacy(now, timeZone) {
    const day = calendar(now, timeZone).day, localDay = calendar(now, Intl.DateTimeFormat().resolvedOptions().timeZone).day;
    let today = false, pause = null;
    if (this.legacyFile) {
      const bytes = readBytes(this.legacyFile, true, 256 * 1024);
      if (bytes) {
        let d; try { d = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')); } catch { throw fail('legacy_invalid', 503); }
        const keys = ['version', 'keys', 'armed', 'missedDaily', 'lastAttemptAt', 'lastSuccessAt', 'unresolvedWindow'];
        if (!object(d) || Reflect.ownKeys(d).some(k => !keys.includes(k)) || d.version !== 1 || !Array.isArray(d.keys)
          || d.keys.length > 10000 || !d.keys.every(k => typeof k === 'string' && /^(?:daily:\d{4}-\d{2}-\d{2}|(?:reset|window):[a-f0-9]{16}:\d{10,16})$/.test(k))) throw fail('legacy_invalid', 503);
        for (const k of ['lastAttemptAt', 'lastSuccessAt']) if (d[k] != null && (!Number.isSafeInteger(d[k]) || d[k] < 0)) throw fail('legacy_invalid', 503);
        if ((d.lastAttemptAt ?? 0) > now || (d.lastSuccessAt ?? 0) > now || d.keys.some(k => k.startsWith('daily:') && k.slice(6) > localDay)) pause = 'paused_clock';
        if (d.unresolvedWindow != null) {
          if (!exact(d.unresolvedWindow, ['accountKey', 'attemptedAt']) || !hash(d.unresolvedWindow.accountKey, 16) || !epoch(d.unresolvedWindow.attemptedAt)) throw fail('legacy_invalid', 503);
          pause = 'paused_unknown';
        }
        if (d.armed != null && (!exact(d.armed, ['accountKey', 'resetAt']) || !hash(d.armed.accountKey, 16) || !epoch(d.armed.resetAt))) throw fail('legacy_invalid', 503);
        if (d.missedDaily != null && (!exact(d.missedDaily, ['day', 'time']) || !/^\d{4}-\d{2}-\d{2}$/.test(d.missedDaily.day) || !time(d.missedDaily.time))) throw fail('legacy_invalid', 503);
        today = d.keys.includes(`daily:${localDay}`) || (epoch(d.lastAttemptAt) && (calendar(d.lastAttemptAt, timeZone).day === day || calendar(d.lastAttemptAt, Intl.DateTimeFormat().resolvedOptions().timeZone).day === localDay));
      }
    }
    if (this.retiredMultiFile) {
      const bytes = readBytes(this.retiredMultiFile, true, 256 * 1024);
      if (bytes) {
        let d; try { d = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')); } catch { throw fail('retired_invalid', 503); }
        if (!exact(d, ['version', 'config', 'attempts', 'paused']) || d.version !== 1 || typeof d.paused !== 'boolean' || !Array.isArray(d.attempts)
          || !exact(d.config, ['enabled', 'time', 'accounts']) || typeof d.config.enabled !== 'boolean' || !time(d.config.time) || !Array.isArray(d.config.accounts) || d.config.accounts.length > 8) throw fail('retired_invalid', 503);
        for (const a of d.config.accounts) if (!exact(a, ['accountKey', 'modelKey', 'enabled', 'allowUnverifiedQuota']) || !hash(a.accountKey, 16) || !hash(a.modelKey) || typeof a.enabled !== 'boolean' || typeof a.allowUnverifiedQuota !== 'boolean') throw fail('retired_invalid', 503);
        if (d.config.enabled) pause = 'paused_legacy';
        if (d.paused) pause = 'paused_unknown';
        for (const a of d.attempts) {
          if (!object(a) || Reflect.ownKeys(a).some(k => !['day', 'accountKey', 'modelKey', 'status', 'attemptedAt', 'finishedAt', 'backend'].includes(k))
            || !/^\d{4}-\d{2}-\d{2}$/.test(a.day) || !hash(a.accountKey, 16) || !hash(a.modelKey) || !epoch(a.attemptedAt)
            || !['claimed', 'unknown', 'unsent', 'succeeded'].includes(a.status)
            || (a.finishedAt !== undefined && (!epoch(a.finishedAt) || a.finishedAt < a.attemptedAt))
            || (a.backend !== undefined && !['legacy', 'official'].includes(a.backend))) throw fail('retired_invalid', 503);
          if (['claimed', 'unknown'].includes(a.status)) pause = 'paused_unknown';
          if (a.attemptedAt > now || (a.finishedAt ?? 0) > now || a.day > localDay) pause = 'paused_clock';
          if (a.day === localDay || calendar(a.attemptedAt, timeZone).day === day) today = true;
        }
      }
    }
    return { today, pause, day };
  }
  _observe(now = this.clock()) {
    if (!epoch(now)) throw fail('invalid_clock', 400);
    return this._transaction(({ data }) => {
      const old = JSON.stringify(data), day = calendar(now, data.config.timeZone).day;
      if (now < data.highWater || data.claims.some(c => c.claimedAt > now || (c.finishedAt ?? 0) > now || c.day > calendar(now, c.timeZone).day)) data.paused ??= 'paused_clock';
      // Another live process can own a pending claim. Its nonce lock blocks us;
      // observing its in-flight journal must not revoke that owner's receipt.
      // If the lock is absent, or we acquired it and found a foreign pending
      // claim, the pending record is orphan evidence and is durably quarantined.
      const mayQuarantine = this.hasExecutionLease || !fs.existsSync(`${this.file}.execution.lock`);
      if (data.claims.some(c => c.status === 'unknown' || (mayQuarantine && ['claimed', 'dispatching'].includes(c.status) && !this.activeClaims.has(c.id)))) data.paused ??= 'paused_unknown';
      try {
        const oldEvidence = this._legacy(now, data.config.timeZone);
        data.paused ??= oldEvidence.pause;
        if (oldEvidence.today && !data.legacyDays.includes(day)) data.legacyDays.push(day);
      } catch { data.paused ??= 'paused_legacy'; }
      if (fs.existsSync(`${this.file}.paused-storage`) || this.localPause) data.paused ??= 'paused_storage';
      data.highWater = Math.max(data.highWater, now);
      return old === JSON.stringify(data) ? null : data;
    });
  }
  _allowed(data, source, now, authRevision) {
    if (this.stopped || this.signal?.aborted || this.localPause || data.paused || fs.existsSync(`${this.file}.paused-storage`)) throw fail(data.paused ?? 'paused_storage');
    if (data.claims.some(c => ['unknown', 'claimed', 'dispatching'].includes(c.status) && !this.activeClaims.has(c.id))) throw fail('paused_unknown');
    if (now < data.highWater || data.timeZoneHoldUntil > now) throw fail(now < data.highWater ? 'paused_clock' : 'timezone_hold');
    if (authRevision && data.authorizationRevision !== authRevision) throw fail('revision_conflict');
    const day = calendar(now, data.config.timeZone).day;
    if (source === 'legacy') {
      if (data.config.enabled || data.legacyResumePaused || data.claims.some(c => c.source !== 'legacy' && c.day === day)) throw fail('legacy_paused');
    } else {
      if (!data.config.enabled || !this.executor || this.ownerChanged) throw fail(!this.executor ? 'unsupported' : this.ownerChanged ? 'owner_reauthorization_required' : 'disabled');
      if (data.legacyDays.includes(day) || data.claims.some(c => c.source === 'legacy' && c.day === day)) throw fail('legacy_day_blocked');
    }
    return day;
  }
  setService(service) {
    if (service === this.service) return;
    if (this.hadOwner) this.ownerChanged = true;
    this.active?.abort(); this.executor = null; this.service = null; this.epoch = null;
    if (service === null) { this._emit('unsupported', 'owner_unavailable'); return; }
    try {
      if (!object(service) || typeof service.connect !== 'function' || this.seenServices.has(service)) throw fail('unsupported');
      this.seenServices.add(service);
      const executor = service.connect((receipt, binding) => this._verifyReceipt(receipt, binding));
      const c = executor?.capabilities();
      if (!object(c) || c.contractVersion !== 1 || !uuid(c.ownerEpoch) || c.accountBound !== true || c.maxAccounts !== 8 || c.startupFull !== false || c.resetFull !== false
        || ['listAccounts', 'listModels', 'readQuota', 'prepare'].some(k => typeof executor[k] !== 'function')) throw fail('unsupported');
      this.executor = executor; this.service = service; this.epoch = c.ownerEpoch; this.hadOwner = true;
      this._emit('ready', 'owner_ready');
    } catch { this._emit('unsupported', 'service_contract_rejected'); }
  }
  _verifyReceipt(receipt, binding) {
    try {
      const expected = this.receipts.get(receipt);
      if (!expected || !object(binding) || !this.executor || this.ownerChanged || this.epoch !== expected.ownerEpoch || this.active?.signal.aborted || this.stopped) return false;
      for (const k of ['accountKey', 'accountGeneration', 'modelKey', 'ownerEpoch']) if (binding[k] !== expected[k]) return false;
      if (binding.authorizationRevision !== undefined && binding.authorizationRevision !== expected.authorizationRevision) return false;
      if (binding.claimId !== undefined && binding.claimId !== expected.id) return false;
      const { data } = this._read(), c = data.claims.find(a => a.id === expected.id);
      if (!c || !['claimed', 'dispatching'].includes(c.status) || !this.activeClaims.has(c.id) || data.authorizationRevision !== expected.authorizationRevision || data.paused || this.localPause || fs.existsSync(`${this.file}.paused-storage`) || !data.config.enabled) return false;
      return ['accountKey', 'accountGeneration', 'modelKey', 'ownerEpoch', 'authorizationRevision', 'budgetSubject'].every(k => c[k] === expected[k]);
    } catch { return false; }
  }
  _summary(state) {
    const { data, revision } = state;
    if (!Array.isArray(this.view.rows)) {
      const seen = new Set(), day = calendar(this.clock(), data.config.timeZone).day;
      this.view.rows = [...data.claims].reverse().filter(c => c.source !== 'legacy' && c.day === day && !seen.has(c.accountKey) && seen.add(c.accountKey)).slice(0, 8)
        .map(c => ({ accountKey: c.accountKey, status: c.status === 'dispatching' ? 'unknown' : c.status }));
    }
    this.view = { ...this.view, timeZone: data.config.timeZone, running: !!this.busy };
    const unresolved = data.claims.some(c => c.status === 'unknown' || (['claimed', 'dispatching'].includes(c.status) && !this.activeClaims.has(c.id)));
    const reason = this.localPause || (fs.existsSync(`${this.file}.paused-storage`) ? 'paused_storage' : data.paused) || (unresolved ? 'paused_unknown' : null);
    if (reason) this._emit(reason, reason);
    else if (!this.busy) this._emit(!data.config.enabled ? 'disabled' : !this.executor || this.ownerChanged ? 'unsupported' : 'waiting', !data.config.enabled ? 'disabled' : !this.executor ? 'owner_unavailable' : this.ownerChanged ? 'owner_reauthorization_required' : 'future_triggers_only');
    return { config: clone(data.config), revision, paused: !!reason, view: clone(this.view), capabilities: { contractVersion: 1, maxAccounts: 8, accountBound: !!this.executor, manual: !!this.executor && !this.ownerChanged, daily: !!this.executor && !this.ownerChanged, startupFull: false, resetFull: false }, legacyResumePaused: data.legacyResumePaused };
  }
  async status() {
    try { return this._summary(this._read()); }
    catch { this._emit('paused_storage', 'storage_unavailable'); return { config: clone(DEFAULT_UNIFIED_WARMUP), revision: null, paused: true, view: clone(this.view), capabilities: { contractVersion: 1, maxAccounts: 8, accountBound: false, manual: false, daily: false, startupFull: false, resetFull: false }, legacyResumePaused: true }; }
  }
  async configure(raw, revision) {
    const config = unifiedWarmupConfig(raw);
    if (revision !== 'missing' && !hash(revision)) throw fail('invalid_revision', 400);
    const now = this.clock(); if (!epoch(now)) throw fail('invalid_clock', 400);
    const result = this._transaction(current => {
      if (current.revision !== revision) throw fail('revision_conflict');
      const d = current.data;
      if (now < d.highWater) d.paused ??= 'paused_clock';
      if (d.config.timeZone !== config.timeZone && (d.claims.length || d.legacyDays.length)) d.timeZoneHoldUntil = Math.max(d.timeZoneHoldUntil, now + 48 * 60 * 60_000);
      d.config = config; d.authorizationRevision = randomUUID(); d.highWater = Math.max(now, d.highWater);
      d.legacyResumePaused ||= config.enabled;
      return d;
    });
    this.active?.abort(); this.previousTick = null; this.tickAuthorization = null;
    if (this.executor) this.ownerChanged = false;
    return this._summary(result);
  }
  _context() {
    if (!this.executor || this.stopped || this.signal?.aborted) throw fail('unsupported');
    return { executor: this.executor, ownerEpoch: this.epoch };
  }
  _same(ctx) { if (ctx.executor !== this.executor || ctx.ownerEpoch !== this.epoch || this.stopped) throw fail('owner_changed'); }
  async _accountView(ctx, a, refresh, signal) {
    const binding = { accountKey: a.accountKey, accountGeneration: a.accountGeneration, refresh, signal };
    const m = models(await bounded(() => ctx.executor.listModels(binding), signal, DIRECTORY_MS)); this._same(ctx);
    const q = quota(await bounded(() => ctx.executor.readQuota(binding), signal, DIRECTORY_MS), this.clock()); this._same(ctx);
    return { accountKey: a.accountKey, accountGeneration: a.accountGeneration, active: a.active, label: a.label, models: m, quota: q };
  }
  async discover() {
    const ctx = this._context(), signal = this.signal;
    const list = catalogue(await bounded(() => ctx.executor.listAccounts({ signal }), signal, DIRECTORY_MS)); this._same(ctx);
    const accounts = [];
    for (const a of list) accounts.push(await this._accountView(ctx, a, false, signal));
    return { accounts };
  }
  async refreshAccount(raw) {
    if (!exact(raw, ['accountKey', 'accountGeneration']) || !hash(raw.accountKey, 16) || !hash(raw.accountGeneration)) throw fail('invalid_account', 400);
    if (this.busy || this.directoryBusy) throw fail('busy');
    this.directoryBusy = true;
    try {
      const ctx = this._context(), signal = this.signal;
      const list = catalogue(await bounded(() => ctx.executor.listAccounts({ signal }), signal, DIRECTORY_MS)); this._same(ctx);
      const a = list.find(a => a.accountKey === raw.accountKey && a.accountGeneration === raw.accountGeneration);
      if (!a) throw fail('account_unavailable');
      return await this._accountView(ctx, a, true, signal);
    } finally { this.directoryBusy = false; }
  }
  async _precheck(ctx, row, signal) {
    const list = catalogue(await bounded(() => ctx.executor.listAccounts({ signal }), signal, DIRECTORY_MS)); this._same(ctx);
    const a = list.find(a => a.accountKey === row.accountKey && a.accountGeneration === row.accountGeneration);
    if (!a) throw fail('account_unavailable');
    const v = await this._accountView(ctx, a, false, signal);
    if (!v.models.verified || !v.models.models.some(m => m.modelKey === row.modelKey)) throw fail('model_unverified');
    if (v.quota.status === 'restricted') throw fail('quota_restricted');
    const fresh = v.quota.status === 'ready' && epoch(v.quota.fetchedAt) && this.clock() - v.quota.fetchedAt <= 120_000;
    if (!fresh && !row.allowUnknownQuota) throw fail('quota_unknown');
    return a;
  }
  _claim(row, account, source, authRevision) {
    let claim;
    const now = this.clock();
    this._observe(now);
    this._transaction(({ data }) => {
      const day = this._allowed(data, source, now, authRevision);
      if (data.claims.some(c => c.day === day && c.budgetSubject === account.budgetSubject)) throw fail('already_claimed');
      if (new Set(data.claims.filter(c => c.day === day && c.source !== 'legacy').map(c => c.budgetSubject)).size >= 8) throw fail('daily_budget_exhausted');
      if (!data.config.accounts.some(a => a.accountKey === row.accountKey && JSON.stringify(a) === JSON.stringify(row) && (source === 'manual' ? a.manual : data.config.daily && a.daily))) throw fail('authorization_changed');
      claim = { id: randomUUID(), day, timeZone: data.config.timeZone, source, ownerEpoch: this.epoch, authorizationRevision: authRevision,
        accountKey: row.accountKey, accountGeneration: row.accountGeneration, modelKey: row.modelKey, budgetSubject: account.budgetSubject, status: 'claimed', claimedAt: now };
      data.claims.push(claim); data.highWater = now; return data;
    });
    this.activeClaims.add(claim.id);
    const receipt = Object.freeze({}); this.receipts.set(receipt, clone(claim));
    return { claim, receipt };
  }
  _finish(claim, status, usage) {
    const now = this.clock();
    this._transaction(({ data }) => {
      const c = data.claims.find(a => a.id === claim.id);
      if (!c || !['claimed', 'dispatching'].includes(c.status)) throw fail('claim_mismatch', 503);
      if (now < data.highWater || now < c.claimedAt) data.paused ??= 'paused_clock';
      c.status = status; c.finishedAt = Math.max(now, c.claimedAt);
      if (status === 'succeeded' && numericUsage(usage)) c.usage = numericUsage(usage);
      if (status === 'unknown') data.paused ??= 'paused_unknown';
      data.highWater = Math.max(data.highWater, now); return data;
    });
    this.activeClaims.delete(claim.id);
    this.view.counts[status]++;
    const row = this.view.rows?.find(row => row.accountKey === claim.accountKey);
    if (row) row.status = status;
  }
  async _row(ctx, row, source, authRevision, life) {
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), ACCOUNT_MS);
    const signal = AbortSignal.any([life, deadline.signal]);
    let claim, receipt, dispatching = false;
    try {
      const account = await this._precheck(ctx, row, signal); signal.throwIfAborted();
      ({ claim, receipt } = this._claim(row, account, source, authRevision));
      this._same(ctx); signal.throwIfAborted();
      let prepared;
      try {
        prepared = await bounded(() => ctx.executor.prepare({ accountKey: row.accountKey, accountGeneration: row.accountGeneration, modelKey: row.modelKey,
          ownerEpoch: ctx.ownerEpoch, claimReceipt: receipt, signal }), signal, ACCOUNT_MS);
      } catch (e) {
        // Only the trusted prepare boundary can assert requestNotSent. An
        // execute rejection carrying the same property is NEVER trusted.
        if (signal.aborted) { this._finish(claim, 'unsent'); throw fail('cancelled'); }
        if (e?.requestNotSent === true) { this._finish(claim, 'unsent'); return; }
        throw e;
      }
      if (!object(prepared) || typeof prepared.execute !== 'function') throw fail('service_invalid', 503);
      this._same(ctx); signal.throwIfAborted();
      this._observe();
      this._transaction(({ data }) => {
        this._allowed(data, source, this.clock(), authRevision);
        const c = data.claims.find(c => c.id === claim.id);
        if (!c || c.status !== 'claimed' || !this._verifyReceipt(receipt, { ...row, ownerEpoch: ctx.ownerEpoch })) throw fail('authorization_changed');
        c.status = 'dispatching'; return data;
      });
      this._same(ctx); signal.throwIfAborted();
      dispatching = true; this._emit('running', 'executing');
      const result = await bounded(() => prepared.execute({ signal }), signal, ACCOUNT_MS);
      this._same(ctx); signal.throwIfAborted();
      if (!object(result)) throw fail('service_invalid', 503);
      this._finish(claim, 'succeeded', result.usage);
    } catch (e) {
      if (claim && this.activeClaims.has(claim.id)) {
        try { this._finish(claim, dispatching || !ownErrors.has(e) ? 'unknown' : 'unsent'); }
        catch { this._sentinel(); }
      } else if (!claim) {
        if (ownErrors.has(e) && ['account_unavailable', 'model_unverified', 'quota_restricted', 'quota_unknown', 'already_claimed', 'daily_budget_exhausted'].includes(e.code)) { this.view.counts.skipped++; const outcome = this.view.rows?.find(a => a.accountKey === row.accountKey); if (outcome) outcome.status = ({ quota_restricted: 'restricted', quota_unknown: 'unknown_quota', already_claimed: 'claimed' })[e.code] ?? 'skipped'; return; }
      }
      throw ownErrors.has(e) ? e : fail(dispatching ? 'paused_unknown' : 'precheck_failed');
    } finally { clearTimeout(timer); if (receipt) this.receipts.delete(receipt); }
  }
  async _run(source, revision, keys) {
    if (this.busy) throw fail('busy');
    const ctx = this._context();
    // Set busy before any asynchronous work; double clicks never queue a batch.
    const controller = new AbortController(); this.active = controller;
    const life = AbortSignal.any([controller.signal, ...(this.signal ? [this.signal] : [])]);
    this.view.counts = { succeeded: 0, unsent: 0, unknown: 0, skipped: 0 };
    let lease, retain = false;
    const operation = async () => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        lease = lock(`${this.file}.execution.lock`, ctx.ownerEpoch); this.hasExecutionLease = true;
        const initialState = this._read();
        if (initialState.revision !== revision) throw fail('revision_conflict');
        const state = this._observe(); this._allowed(state.data, source, this.clock());
        const authRevision = state.data.authorizationRevision;
        const rows = state.data.config.accounts.filter(a => keys.includes(a.accountKey));
        if (rows.length !== keys.length || rows.some(a => source === 'manual' ? !a.manual : !a.daily || !state.data.config.daily)) throw fail('authorization_required');
        this.view.rows = rows.map(row => ({ accountKey: row.accountKey, status: 'waiting' }));
        this._emit('preparing', 'local_precheck');
        for (const row of rows) { life.throwIfAborted(); this._same(ctx); await this._row(ctx, row, source, authRevision, life); }
        this._emit('settled', 'batch_finished');
      } catch (e) {
        let paused = this.localPause;
        try {
          const current = this._read();
          retain = !!current.data.paused || current.data.claims.some(c => ['unknown', 'claimed', 'dispatching'].includes(c.status)) || !!this.localPause;
          paused ??= current.data.paused;
        } catch { retain = true; paused = 'paused_storage'; }
        this._emit(retain ? (paused ?? 'paused_unknown') : 'blocked', ownErrors.has(e) ? e.code : 'cancelled');
        throw ownErrors.has(e) ? e : fail('cancelled');
      } finally {
        if (lease && !retain) { try { lease.release(); } catch { this._sentinel(); } }
        this.hasExecutionLease = false;
      }
    };
    this.busy = Promise.resolve().then(operation);
    try { await this.busy; }
    finally { this.busy = null; if (this.active === controller) this.active = null; this._emit(this.view.status, this.view.reason); }
    return this.status();
  }
  async runManual(raw) {
    if (!exact(raw, ['revision', 'accountKeys', 'confirmed']) || raw.confirmed !== true || (raw.revision !== 'missing' && !hash(raw.revision))
      || !Array.isArray(raw.accountKeys) || raw.accountKeys.length < 1 || raw.accountKeys.length > 8 || !raw.accountKeys.every(k => hash(k, 16)) || new Set(raw.accountKeys).size !== raw.accountKeys.length) throw fail('invalid_run', 400);
    return this._run('manual', raw.revision, raw.accountKeys);
  }
  async tick(now = this.clock()) {
    if (this.stopped || this.signal?.aborted || this.busy) return;
    let state;
    try { state = this._observe(now); } catch { this._emit('paused_storage', 'storage_unavailable'); return; }
    const d = state.data, local = calendar(now, d.config.timeZone), previous = this.previousTick;
    const changed = this.tickAuthorization !== d.authorizationRevision;
    this.previousTick = now; this.tickAuthorization = d.authorizationRevision;
    this._summary(state);
    const occurrence = `${d.config.timeZone}:${local.day}:${d.config.time}`;
    const punctual = previous !== null && !changed && now > previous && now - previous < 60_000;
    // Require a crossing from before the target minute. Starting/resuming,
    // changing config or waking within that minute can never become a catch-up.
    const crossing = punctual && calendar(previous, d.config.timeZone).day === local.day
      && calendar(previous, d.config.timeZone).minute < d.config.time && local.minute === d.config.time;
    if (local.minute >= d.config.time && !crossing) this.dailySeen.add(occurrence);
    if (!d.config.enabled || !d.config.daily || d.paused || !crossing || this.dailySeen.has(occurrence)) return;
    this.dailySeen.add(occurrence);
    const keys = d.config.accounts.filter(a => a.daily).map(a => a.accountKey);
    if (keys.length) { try { await this._run('daily', state.revision, keys); } catch { /* view carries safe enum; no retry */ } }
  }
  async cancel() { this.active?.abort(); if (this.busy) { try { await this.busy; } catch { /* terminal journal decides outcome */ } } return this.status(); }
  async stop() { this.stopped = true; this.signal?.removeEventListener('abort', this.abortListener); return this.cancel(); }
  async withLegacy(operation) {
    if (typeof operation !== 'function') throw fail('invalid_operation', 400);
    if (this.busy || this.stopped || this.signal?.aborted) throw fail('busy');
    const controller = new AbortController(); this.active = controller;
    const signal = AbortSignal.any([controller.signal, ...(this.signal ? [this.signal] : [])]);
    let lease, claim, retain = false, crossed = false;
    const run = async () => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true }); lease = lock(`${this.file}.execution.lock`, this.epoch); this.hasExecutionLease = true;
        const { data } = this._observe(), now = this.clock(), day = this._allowed(data, 'legacy', now);
        if (data.claims.some(c => c.source === 'legacy' && c.day === day)) throw fail('already_claimed');
        this._transaction(({ data: d }) => {
          this._allowed(d, 'legacy', now);
          claim = { id: randomUUID(), day, timeZone: d.config.timeZone, source: 'legacy', ownerEpoch: this.epoch ?? randomUUID(), authorizationRevision: d.authorizationRevision,
            accountKey: null, accountGeneration: null, modelKey: null, budgetSubject: null, status: 'claimed', claimedAt: now };
          d.claims.push(claim); return d;
        });
        this.activeClaims.add(claim.id);
        this._transaction(({ data: d }) => { this._allowed(d, 'legacy', this.clock()); d.claims.find(c => c.id === claim.id).status = 'dispatching'; return d; });
        signal.throwIfAborted(); crossed = true;
        const result = await bounded(() => operation({ signal }), signal, ACCOUNT_MS);
        signal.throwIfAborted(); this._finish(claim, 'succeeded', result?.usage); return result;
      } catch (e) {
        if (claim && this.activeClaims.has(claim.id)) {
          // There is no trusted prepare boundary in this legacy callback API.
          // Once entered, even requestNotSent on an exception is not proof.
          const unsent = !crossed;
          try { this._finish(claim, unsent ? 'unsent' : 'unknown'); } catch { this._sentinel(); }
          retain = !unsent || !!this.localPause;
        }
        throw ownErrors.has(e) ? e : fail('legacy_failed');
      } finally { if (lease && !retain) { try { lease.release(); } catch { this._sentinel(); } } this.hasExecutionLease = false; }
    };
    this.busy = Promise.resolve().then(run);
    try { return await this.busy; } finally { this.busy = null; if (this.active === controller) this.active = null; this._emit(this.view.status, this.view.reason); }
  }
}

export function unifiedWarmupHandler({ coordinator, authorize }) {
  return async (req, res) => {
    if (!await authorize(req, res)) return;
    const method = req.method ?? 'GET';
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(status === 405 ? { Allow: 'GET, HEAD, PUT, POST' } : {}) }); res.end(method === 'HEAD' ? undefined : JSON.stringify(value)); };
    if (!['GET', 'HEAD', 'PUT', 'POST'].includes(method)) { reply(405, { error: 'method_not_allowed' }); return; }
    try {
      if (method === 'GET' || method === 'HEAD') { reply(200, await coordinator.status()); return; }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] ?? req.headers?.get?.('content-type') ?? '')) throw fail('json_required', 415);
      let length = 0; const chunks = [];
      for await (const chunk of req) { const b = Buffer.from(chunk); length += b.length; if (length > 16384) throw fail('payload_too_large', 413); chunks.push(b); }
      let body; try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw fail('invalid_payload', 400); }
      if (method === 'PUT') {
        if (!exact(body, ['config', 'revision', 'confirmed']) || body.confirmed !== true) throw fail('confirmation_required', 400);
        reply(200, await coordinator.configure(body.config, body.revision)); return;
      }
      if (!object(body)) throw fail('invalid_payload', 400);
      if (body.action === 'discover' && exact(body, ['action'])) reply(200, await coordinator.discover());
      else if (body.action === 'cancel' && exact(body, ['action'])) reply(200, await coordinator.cancel());
      else if (body.action === 'refresh' && exact(body, ['action', 'accountKey', 'accountGeneration', 'confirmed']) && body.confirmed === true) reply(200, { account: await coordinator.refreshAccount({ accountKey: body.accountKey, accountGeneration: body.accountGeneration }) });
      else if (body.action === 'run' && exact(body, ['action', 'revision', 'accountKeys', 'confirmed'])) reply(200, await coordinator.runManual({ revision: body.revision, accountKeys: body.accountKeys, confirmed: body.confirmed }));
      else throw fail('invalid_payload', 400);
    } catch (e) { reply(ownErrors.has(e) && [400, 409, 413, 415, 503].includes(e.status) ? e.status : 503, { error: ownErrors.has(e) ? e.code : 'unavailable' }); }
  };
}
