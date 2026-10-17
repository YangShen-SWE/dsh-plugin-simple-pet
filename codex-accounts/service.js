import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseQuota, fetchQuota } from './quota.js';
import { modelIdOK, validModelSettings, defaultModelSettings, requestFailure } from './model-catalogue.js';

export const PROVIDER = 'codex-accounts';
export const hash = value => createHash('sha256').update(value).digest('hex');
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const idPattern = /^[a-f0-9]{16}$/;
const idOK = id => typeof id === 'string' && id.length === 16 && idPattern.test(id);
const localErrors = new WeakSet();
export const isAccountError = error => localErrors.has(error);
const fail = (code, status = 409, requestNotSent = true) => { const error = Object.assign(new Error(code), { code, status, requestNotSent }); localErrors.add(error); return error; };
const requestMessages = Object.freeze({
  BOUND_CANCELLED: '请求已取消。', BOUND_CONTENT_UNSUPPORTED: '无法处理该请求的输入或图片附件。',
  BOUND_OPTION_UNSUPPORTED: '所选模型不支持该请求选项或推理设置。', BOUND_MODEL_UNAVAILABLE: '该账号当前不可调用所选模型，请刷新账号模型目录。',
  BOUND_AUTH_REQUIRED: 'Codex 订阅账号授权不可用，请核验或重新登录该账号。', BOUND_QUOTA_LIMITED: 'Codex 账号额度或速率受限，请核验额度。',
  BOUND_TRANSPORT_FAILED: 'Codex 账号请求发生网络或超时错误。', BOUND_REQUEST_FAILED: 'Codex 账号请求未完成，请检查账号、模型与网络。',
});
const cleanLabel = v => typeof v === 'string' && v.length <= 64 && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(v);
const blank = () => ({ version: 1, defaultKey: null, rows: [] });
// Stable public budget identity survives revoke/rebind; credential scopes remain unique per login.
const publicKey = row => row.identityHash ? row.identityHash.slice(0, 16) : row.key;
function tokenAccount(access) {
  try { const parts = access.split('.'); if (parts.length !== 3 || access.length > 65536 || access.trim() !== access || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(access)) throw 0;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const id = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    if (typeof id !== 'string' || !id) throw 0; return id;
  } catch { throw fail('OAUTH_IDENTITY_INVALID'); }
}
export class AccountDirectory {
  constructor(file) { this.file = path.resolve(file); this.tail = Promise.resolve(); }
  async read() {
    let bytes;
    try { bytes = await fs.readFile(this.file); } catch (e) { if (e.code === 'ENOENT') return blank(); throw fail('DIRECTORY_UNAVAILABLE', 503); }
    try {
      if (bytes.length > 131072) throw 0;
      const x = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if ((x.generation !== undefined && (!Number.isSafeInteger(x.generation) || x.generation < 0)) || x.version !== 1 || !Array.isArray(x.rows) || x.rows.length > 256 || new Set(x.rows.map(r => r.key)).size !== x.rows.length
        || x.rows.some(r => (r.modelHints!==undefined&&(!Array.isArray(r.modelHints)||r.modelHints.length>128||new Set(r.modelHints).size!==r.modelHints.length||!r.modelHints.every(modelIdOK))) || (r.modelSettings !== undefined && !validModelSettings(r.modelSettings)) || !idOK(r.key) || !Number.isSafeInteger(r.epoch) || r.epoch < 1 || !cleanLabel(r.label) || typeof r.revoked !== 'boolean' || typeof r.bound !== 'boolean'
          || (r.identityHash !== null && !(typeof r.identityHash === 'string' && /^[a-f0-9]{64}$/.test(r.identityHash))))
        || !(x.defaultKey === null || x.rows.some(r => r.key === x.defaultKey && r.bound && !r.revoked))) throw 0;
      return x;
    } catch { throw fail('DIRECTORY_UNAVAILABLE', 503); }
  }
  update(fn) {
    const task = this.tail.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      let lock;
      for (let i = 0; i < 80; i++) {
        try { lock = await fs.open(`${this.file}.lock`, 'wx', 0o600); break; }
        catch (e) { if (e.code !== 'EEXIST' || i === 79) throw fail('DIRECTORY_LOCKED', 503); await delay(25); }
      }
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      try {
        const data = await this.read(), result = await fn(data);
        data.generation = (data.generation ?? 0) + 1;
        const serialized=JSON.stringify(data);if(Buffer.byteLength(serialized)>131072)throw fail('DIRECTORY_LIMIT');
        await fs.writeFile(tmp, serialized, { flag: 'wx', mode: 0o600 });
        // Windows readers/scanners may briefly retain the replace target.
        // Retry this same local atomic rename only: never OAuth/network/model work.
        for (let attempt = 0; ; attempt++) {
          try { await fs.rename(tmp, this.file); break; }
          catch (error) {
            if (process.platform !== 'win32' || !['EPERM','EACCES','EBUSY'].includes(error.code) || attempt >= 9) throw fail('DIRECTORY_WRITE_UNAVAILABLE', 503);
            await delay(20 * (attempt + 1));
          }
        }
        return result;
      } finally { await fs.rm(tmp, { force: true }).catch(() => {}); await lock.close(); await fs.rm(`${this.file}.lock`, { force: true }); }
    });
    this.tail = task.catch(() => {}); return task;
  }
}

// Own record namespace only. The host credentials service owns storage and the
// whole refresh mutation lock; storage protection is host-dependent (not an encryption guarantee).
// No refresh/access token is copied to our JSON.
export function fixedCredentialView(credentials, directory, captured, isCurrent = () => true) {
  const recordKey = `codex-accounts/account-${captured.key}`;
  const valid = async () => {
    const row = (await directory.read()).rows.find(r => r.key === captured.key);
    if (!isCurrent() || !row || row.revoked || row.epoch !== captured.epoch) throw fail('ACCOUNT_REVOKED');
    return row;
  };
  const boundIdentity = async grant => {
    const row = await valid();
    if (grant && row.bound && row.identityHash !== hash(grant.accountId)) throw fail('OAUTH_IDENTITY_CHANGED');
    return grant;
  };
  const provider = name => { if (name !== 'openai-codex') throw fail('PROVIDER_REJECTED'); };
  const unpack = record => {
    if (record == null) return undefined;
    if (record.kind !== 'grant' || record.payload?.type !== 'oauth') throw fail('OAUTH_REQUIRED');
    return pack(record.payload).payload;
  };
  const pack = value => {
    if (!value || value.type !== 'oauth' || typeof value.access !== 'string' || !value.access || typeof value.refresh !== 'string' || !value.refresh
      || !Number.isFinite(value.expires) || typeof value.accountId !== 'string' || !value.accountId || value.accountId.length > 512 || /[\x00-\x20\x7f]/u.test(value.accountId)) throw fail('OAUTH_REQUIRED');
    if (tokenAccount(value.access) !== value.accountId) throw fail('OAUTH_IDENTITY_CHANGED');
    return { kind: 'grant', payload: { type: 'oauth', access: value.access, refresh: value.refresh, expires: value.expires, accountId: value.accountId } };
  };
  return Object.freeze({
    async read(name) { provider(name); await valid(); const result = unpack(await credentials.readRecord(recordKey)); return boundIdentity(result); },
    async list() { await valid(); return (await this.read('openai-codex')) ? [{ providerId: 'openai-codex', type: 'oauth' }] : []; },
    async modify(name, mutate) {
      provider(name); await valid();
      const result = await credentials.modifyRecord(recordKey, async current => {
        await valid(); const previous = await boundIdentity(unpack(current));
        const next = await mutate(previous); await valid();
        if (next === undefined) return undefined; // preserve, NEVER delete
        const packed = pack(next); await boundIdentity(packed.payload); return packed;
      });
      return boundIdentity(unpack(result));
    },
    async delete(name) { provider(name); await valid(); await credentials.deleteRecord(recordKey); },
  });
}

export function createAccountService({ credentials, directory, driver, fetchImpl = globalThis.fetch, clock = Date.now, changed = () => {}, hostModel = () => undefined }) {
  if (!credentials?.modifyRecord || !credentials?.readRecord || !credentials?.deleteRecord) throw fail('CREDENTIALS_UNAVAILABLE', 503);
  const observations = new Map(), captures = new Map();
  let login = null, loginStarting = false, disposed = false, activeRequests = 0, defaultKey = null, defaultGeneration = 0;
  const ensure = () => { if (disposed) throw fail('SERVICE_CLOSED', 410); };
  // Only errors signed by this service may be attributed to one account. Shared
  // storage, imports, unknown exceptions and disposal must still fail globally.
  const accountProblem = async (error, row, capture) => {
    ensure();
    const local = isAccountError(error);
    if ((local && ['ACCOUNT_NOT_BOUND', 'ACCOUNT_REVOKED'].includes(error.code))
      || (capture?.controller.signal.aborted && error === capture.controller.signal.reason)) {
      const current = (await directory.read()).rows.find(r => publicKey(r) === (row.accountKey ?? publicKey(row)));
      ensure();
      if (!current || current.revoked || !current.bound || current.epoch !== row.epoch) return { changed: true };
      throw error;
    }
    if (!local) throw error;
    const credentialStatus = new Map([['OAUTH_REQUIRED', 'missing'], ['OAUTH_IDENTITY_INVALID', 'invalid'], ['OAUTH_IDENTITY_CHANGED', 'identity-mismatch']]).get(error.code);
    if (credentialStatus) return { credentialStatus, credentialErrorCode: error.code };
    if (/^MODEL_CATALOG_(AUTH_REQUIRED|INVALID|EMPTY|UNAVAILABLE)$/.test(error.code)) return { modelStatus: 'unavailable', modelError: error.code };
    throw error;
  };
  const notify = () => { if (!disposed) try { changed(); } catch { /* committed configuration remains committed */ } };
  const settingsFor = async c => (await directory.read()).rows.find(r => r.key === c.key && r.epoch === c.epoch && !r.revoked)?.modelSettings ?? defaultModelSettings();
  // Slugs are discovery hints only, not permission or a saved OAuth grant. They
  // let a previously selected new model be revalidated after process restart.
  const rememberModels=async(c,rows)=>{
    const ids=[...new Set(rows.map(row=>row.id).filter(modelIdOK))].slice(0,128);
    const old=(await directory.read()).rows.find(r=>r.key===c.key&&r.epoch===c.epoch&&!r.revoked);
    if(JSON.stringify(old?.modelHints)===JSON.stringify(ids))return;
    await directory.update(data=>{const row=data.rows.find(r=>r.key===c.key&&r.epoch===c.epoch&&!r.revoked&&r.bound);if(!row)throw fail('ACCOUNT_REVOKED');row.modelHints=ids;});
  };
  const modelsFor=async(c,engine,hint=null)=>{
    let rows=await engine.listModels();const meta=(await directory.read()).rows.find(r=>r.key===c.key&&r.epoch===c.epoch&&!r.revoked);
    const desired=[...(meta?.modelHints||[]),meta?.modelSettings?.defaultModel,hint].filter(modelIdOK);
    if(engine.catalogStatus?.().source==='builtin'&&desired.some(id=>!rows.some(row=>row.id===id))&&typeof engine.refreshModels==='function'){
      try{await engine.refreshModels(AbortSignal.any([c.controller.signal,AbortSignal.timeout(10000)]));}catch(error){throw fail(/^MODEL_CATALOG_(AUTH_REQUIRED|INVALID|EMPTY|UNAVAILABLE)$/.test(error?.message||'')?error.message:'MODEL_CATALOG_UNAVAILABLE',503);}
      await validCapture(c);rows=await engine.listModels();await rememberModels(c,rows);notify();
    }
    return rows;
  };
  const hostStatus = () => {
    try { const service = hostModel(), current = service?.currentSelection?.();
      return { available: typeof service?.saveSelection === 'function' && typeof service?.currentSelection === 'function', managed: current?.provider === PROVIDER,
        ...(current?.provider === PROVIDER && typeof current.model === 'string' && current.model.length <= 256 && !/[\x00-\x20\x7f]/.test(current.model) ? { model: current.model, reasoningEffort: current.reasoningEffort ?? null } : {}) };
    } catch { return { available: false, managed: false }; }
  };
  const capture = async key => {
    ensure(); const data = await directory.read(), row = data.rows.find(r => (key == null ? r.key === data.defaultKey : publicKey(r) === key) && r.bound && !r.revoked);
    if (!row) throw fail('ACCOUNT_NOT_BOUND');
    const stamp = `${row.key}:${row.epoch}`;
    if (!captures.has(stamp)) {
      const controller = new AbortController(), store = fixedCredentialView(credentials, directory, row, () => !disposed);
      captures.set(stamp, { key: row.key, accountKey: publicKey(row), epoch: row.epoch, controller, store, engine: null });
    }
    const result = captures.get(stamp);
    if (!result.engine) result.engine = Promise.resolve(driver({ credentials: result.store }));
    return result;
  };
  const validCapture = async c => { if (!await c.store.read('openai-codex')) throw fail('OAUTH_REQUIRED'); ensure(); c.controller.signal.throwIfAborted(); };
  const catalogue = async () => {
    ensure(); const generation = defaultGeneration;
    // Snapshot progress before I/O: never combine a newly completed login with
    // directory bytes read before that login committed its binding.
    const loginSummary = login ? { id: login.id, status: login.status, errorCode: login.errorCode ?? null, event: login.event, prompt: login.prompt ? { message: login.prompt.choices ? '选择官方授权方式' : '等待官方浏览器回调；仅回调失败时在此输入完整回调 URL。不要输入 API Key/密码/令牌。', id: login.prompt.id, choices: login.prompt.choices } : null } : null;
    const data = await directory.read();
    const selected = data.rows.find(r => r.key === data.defaultKey && !r.revoked && r.bound);
    const results = await Promise.all(data.rows.filter(r => !r.revoked && r.bound).map(async r => {
      let bound = false, status;
      try {
        bound = Boolean(await fixedCredentialView(credentials, directory, r, () => !disposed).read('openai-codex'));
        ensure();
        status = bound ? { credentialStatus: 'available', credentialErrorCode: null } : { credentialStatus: 'missing', credentialErrorCode: 'OAUTH_REQUIRED' };
      } catch (error) { status = await accountProblem(error, r); if (status.changed) return null; }
      return { accountKey: publicKey(r), label: r.label, selected: data.defaultKey === r.key, epoch: r.epoch, bound, ...status, modelSettings: r.modelSettings ?? defaultModelSettings(),
        quota: bound ? observations.get(r.key) ?? { status: 'unavailable', clientObservedAt: null, serverSampledAt: null, fiveHour: null, weekly: null }
          : { status: 'unavailable', clientObservedAt: null, serverSampledAt: null, fiveHour: null, weekly: null } };
    }));
    ensure();
    const accounts = results.filter(Boolean), selectedKey = selected && accounts.some(r => r.accountKey === publicKey(selected)) ? publicKey(selected) : null;
    if (generation === defaultGeneration) defaultKey = selectedKey;
    return { version: 1, provider: PROVIDER, capabilities:{models:true}, generation: data.generation ?? 0, defaultKey: selectedKey, busy: activeRequests > 0,
      accounts, hostModel: hostStatus(),
      login: loginSummary };
  };
  const api = {
    catalogue, capture,
    async beginLogin(label = '') {
      ensure(); if (!cleanLabel(label)) throw fail('INVALID_LABEL', 400);
      if (loginStarting || (login && ['running', 'prompt'].includes(login.status))) throw fail('LOGIN_BUSY');
      const row = { key: hash(`official:${randomUUID()}`).slice(0, 16), epoch: 1, label: label.trim() || 'ChatGPT 订阅账号', revoked: false, bound: false, identityHash: null };
      loginStarting = true;
      try { await directory.update(data => { if (data.rows.length >= 256 || data.rows.filter(r => !r.revoked).length >= 8) throw fail('ACCOUNT_LIMIT'); data.rows.push(row); }); }
      finally { loginStarting = false; }
      try { ensure(); } catch (error) { await api.remove(row.key).catch(() => {}); throw error; }
      const state = { id: randomUUID(), key: row.key, status: 'running', event: null, prompt: null, controller: new AbortController() };
      login = state;
      const timeout = AbortSignal.timeout(5 * 60_000), signal = AbortSignal.any([state.controller.signal, timeout]);
      state.task = (async () => {
        try {
          const store = fixedCredentialView(credentials, directory, row, () => !disposed), engine = await driver({ credentials: store });
          ensure(); signal.throwIfAborted();
          await engine.login({ signal, notify(event) {
            if (login !== state || signal.aborted) return;
            let url = event?.url ?? event?.verificationUri;
            try { const parsed = new URL(url); if (parsed.protocol !== 'https:' || !['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'].includes(parsed.hostname)) url = null; } catch { url = null; }
            state.event = url ? { url, ...(typeof event.userCode === 'string' && /^[A-Z0-9-]{4,32}$/.test(event.userCode) ? { userCode: event.userCode } : {}) } : { message: '请在官方授权页面完成登录。' };
          }, prompt(input) {
            return new Promise((resolve, reject) => {
              if (signal.aborted) { reject(fail('LOGIN_CANCELLED')); return; }
              const promptSignal = input?.signal ? AbortSignal.any([signal, input.signal]) : signal;
              const promptId = randomUUID();
              const cancel = () => { if (state.prompt?.id === promptId) state.prompt = null; reject(fail('LOGIN_CANCELLED')); };
              promptSignal.addEventListener('abort', cancel, { once: true });
              state.prompt = { id: promptId, choices: input?.type === 'select' ? ['browser', 'device_code'] : null,
                resolve(value) { promptSignal.removeEventListener('abort', cancel); state.prompt = null; resolve(value); } };
              if (promptSignal.aborted) cancel();
              state.status = 'prompt';
            });
          } });
          signal.throwIfAborted(); const grant = await store.read('openai-codex'); if (!grant) throw fail('OAUTH_REQUIRED');
          const identity = hash(grant.accountId);
          await directory.update(data => {
            const current = data.rows.find(r => r.key === row.key);
            if (signal.aborted || !current || current.revoked || current.epoch !== row.epoch) throw fail('LOGIN_CANCELLED');
            if (data.rows.some(r => r.key !== row.key && r.bound && !r.revoked && r.identityHash?.slice(0, 16) === identity.slice(0, 16))) throw fail('DUPLICATE_ACCOUNT');
            current.bound = true; current.identityHash = identity; if (!data.defaultKey) data.defaultKey = row.key;
          });
          state.status = 'completed'; state.event = null; notify();
        } catch (error) {
          state.status = signal.aborted ? 'cancelled' : 'failed'; state.event = null;
          state.errorCode = isAccountError(error) ? error.code : 'LOGIN_FAILED';
          const current = (await directory.read().catch(() => ({ rows: [] }))).rows.find(r => r.key === row.key);
          if (current && !current.revoked) await api.remove(row.key).catch(() => {});
        } finally { state.prompt = null; }
      })();
      void state.task.catch(() => {});
      return { id: state.id, status: 'running' };
    },
    async cancelLogin(id) { if (!login || login.id !== id || !['running','prompt'].includes(login.status)) throw fail('LOGIN_NOT_FOUND'); login.controller.abort(); await api.remove(login.key); return { ok: true }; },
    async respondLogin(id, promptId, value) {
      if (!login || login.id !== id || login.controller.signal.aborted || login.prompt?.id !== promptId) throw fail('LOGIN_NOT_FOUND');
      if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/u.test(value)) throw fail('INVALID_RESPONSE', 400);
      login.prompt.resolve(value); login.status = 'running'; return { ok: true };
    },
    async remove(key, expectedGeneration) {
      // Public removals carry a generation. Internal login cancellation must still
      // tombstone its own provisional row while disposal is cleaning up.
      if (expectedGeneration !== undefined) ensure();
      if (!idOK(key)) throw fail('INVALID_ACCOUNT', 400);
      if (expectedGeneration !== undefined && (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0)) throw fail('SOURCE_CHANGED');
      let privateKey;
      await directory.update(data => {
        if (expectedGeneration !== undefined) ensure();
        if (expectedGeneration !== undefined && (data.generation ?? 0) !== expectedGeneration) throw fail('SOURCE_CHANGED');
        const row = data.rows.find(r => r.key === key || (!r.revoked && publicKey(r) === key)); if (!row) throw fail('ACCOUNT_NOT_BOUND');
        privateKey = row.key; row.epoch++; row.revoked = true; row.bound = false; delete row.modelHints; if (data.defaultKey === privateKey) data.defaultKey = null;
      });
      defaultGeneration++; if (defaultKey === key) defaultKey = null;
      for (const c of captures.values()) if (c.key === privateKey) c.controller.abort();
      if (login?.key === privateKey) login.controller.abort(); observations.delete(privateKey);
      notify(); await credentials.deleteRecord(`codex-accounts/account-${privateKey}`); return { ok: true };
    },
    async select(key, expectedGeneration, signal) {
      if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw fail('SOURCE_CHANGED');
      await directory.update(async data => {
        if ((data.generation ?? 0) !== expectedGeneration) throw fail('SOURCE_CHANGED');
        const row = data.rows.find(r => publicKey(r) === key && r.bound && !r.revoked);
        if (!row) throw fail('ACCOUNT_NOT_BOUND');
        if (!await fixedCredentialView(credentials, directory, row, () => !disposed).read('openai-codex')) throw fail('OAUTH_REQUIRED');
        data.defaultKey = row.key;
      }); defaultGeneration++; defaultKey = key; notify();
      // Explicit selection also discovers that account's current models. A failed
      // catalogue refresh does not undo the already committed account selection.
      let models = null, modelError = null;
      try { models = await api.models(key, true, signal); }
      catch (error) { modelError = isAccountError(error) ? error.code : 'MODEL_CATALOG_UNAVAILABLE'; }
      return { ok: true, accountKey: key, models, modelError };
    },
    prepareDefault(baseModel) {
      const key = defaultKey;
      if (!key || !modelIdOK(baseModel)) throw fail('DEFAULT_ACCOUNT_REQUIRED');
      return api.prepare(key, hash(`${key}:${baseModel}`),baseModel);
    },
    async quota(key, signal) {
      const c = await capture(key), engine = await c.engine;
      const combined = AbortSignal.any([...(signal ? [signal] : []), c.controller.signal, AbortSignal.timeout(15_000)]);
      try {
        await validCapture(c); const auth = await engine.auth(combined); await validCapture(c);
        const grant = await c.store.read('openai-codex');
        if (!auth?.apiKey || auth.apiKey !== grant?.access) throw fail('AUTH_IDENTITY_CHANGED');
        const raw = await fetchQuota({ access: auth.apiKey, accountId: grant.accountId, signal: combined, fetchImpl });
        await validCapture(c); const result = parseQuota(raw, grant.accountId, clock());
        observations.set(c.key, result); return result;
      } catch {
        await validCapture(c);
        const old = observations.get(c.key), result = { ...(old ?? { fiveHour: null, weekly: null, clientObservedAt: null, serverSampledAt: null }), status: 'stale', error: 'QUOTA_UNAVAILABLE' };
        observations.set(c.key, result); return result;
      }
    },
    async models(key, refresh = false, signal) {
      const c = await capture(key), engine = await c.engine; await validCapture(c);
      if (refresh) {
        if (typeof engine.refreshModels !== 'function') throw fail('MODEL_CATALOG_UNAVAILABLE',503);
        try { await engine.refreshModels(AbortSignal.any([...(signal ? [signal] : []),c.controller.signal])); }
        catch (error) { throw fail(/^MODEL_CATALOG_(AUTH_REQUIRED|INVALID|EMPTY|UNAVAILABLE)$/.test(error?.message || '') ? error.message : 'MODEL_CATALOG_UNAVAILABLE',503); }
        await validCapture(c);await rememberModels(c,await engine.listModels());notify();
      }
      const rows = await modelsFor(c,engine), snapshot=await directory.read();
      const row=snapshot.rows.find(r=>r.key===c.key&&r.epoch===c.epoch&&!r.revoked&&r.bound);if(!row)throw fail('ACCOUNT_REVOKED');
      const settings=row.modelSettings??defaultModelSettings();await validCapture(c);
      if((await directory.read()).generation!==snapshot.generation)throw fail('SOURCE_CHANGED');
      return { accountKey:c.accountKey, generation:snapshot.generation ?? 0, settings, hostModel:hostStatus(),
        catalog:engine.catalogStatus?.() ?? {source:'builtin',status:'not-refreshed'},
        models:rows.filter(m=>modelIdOK(m.id)).map(m=>({id:m.id,modelKey:hash(`${c.accountKey}:${m.id}`),name:cleanLabel(m.name)?m.name:m.id,
          enabled:settings.enabled===null||settings.enabled.includes(m.id),inputModalities:m.inputModalities ?? ['text'],
          contextWindow:m.context?.contextWindow ?? null,reasoning:m.reasoning ?? null})) };
    },
    async configureModels(key, expectedGeneration, settings) {
      if (!validModelSettings(settings) || !Number.isSafeInteger(expectedGeneration)) throw fail('INVALID_MODEL_SETTINGS',400);
      const c=await capture(key), engine=await c.engine, rows=await engine.listModels();await validCapture(c);
      const enabled=rows.filter(m=>settings.enabled===null||settings.enabled.includes(m.id));
      if ((settings.enabled && settings.enabled.some(id=>!rows.some(m=>m.id===id))) || (settings.defaultModel && !enabled.some(m=>m.id===settings.defaultModel))) throw fail('MODEL_REVOKED');
      if (settings.reasoningEffort) {
        const model=enabled.find(m=>m.id===settings.defaultModel);
        if (!model?.reasoning?.efforts?.some(e=>e.id===settings.reasoningEffort)) throw fail('REASONING_UNAVAILABLE');
      }
      await directory.update(data=>{if((data.generation??0)!==expectedGeneration)throw fail('SOURCE_CHANGED');
        const row=data.rows.find(r=>r.key===c.key&&r.epoch===c.epoch&&!r.revoked&&r.bound);if(!row)throw fail('ACCOUNT_REVOKED');
        row.modelSettings={enabled:settings.enabled===null?null:[...settings.enabled],defaultModel:settings.defaultModel,reasoningEffort:settings.reasoningEffort};});
      notify();return api.models(key);
    },
    async selectHostModel(key, modelKey) {
      const prepared=await api.prepare(key,modelKey), route=`${prepared.accountKey}:${prepared.baseId}`;
      const current=hostModel();if(typeof current?.saveSelection!=='function'||typeof current?.currentSelection!=='function')throw fail('HOST_MODEL_UNAVAILABLE');
      if(prepared.defaultReasoning&&!prepared.info?.reasoning?.efforts?.some(e=>e.id===prepared.defaultReasoning))throw fail('REASONING_UNAVAILABLE');
      await current.saveSelection({provider:PROVIDER,model:route,...(prepared.defaultReasoning?{reasoningEffort:prepared.defaultReasoning}:{})});
      const read=current.currentSelection();if(read?.provider!==PROVIDER||read.model!==route||(read.reasoningEffort??null)!==(prepared.defaultReasoning??null))throw fail('HOST_MODEL_NOT_SAVED');
      return hostStatus();
    },
    async bindings() {
      const data = await catalogue(), accounts = [];
      for (const row of data.accounts.filter(row => row.bound === true)) {
        let c, engine, models, settings;
        try {
          c = await capture(row.accountKey); engine = await c.engine; models = await modelsFor(c,engine);
          settings = await settingsFor(c); await validCapture(c);
        } catch (error) {
          const problem = await accountProblem(error, row, c);
          if (problem.changed) continue;
          // This row has no verified models. Never borrow another account, expose
          // persisted hints as permissions, or hide a shared/unknown failure.
          accounts.push({ accountKey: row.accountKey, label: row.label, selected: row.selected, maskedEmail: null,
            ...problem, models: [], modelError: problem.modelError ?? problem.credentialErrorCode });
          continue;
        }
        accounts.push({ accountKey: c.accountKey, label: row.label, selected:row.selected, maskedEmail: null, credentialStatus: 'available', modelStatus: 'ready',
          models: models.filter(m => modelIdOK(m.id) && (settings.enabled===null||settings.enabled.includes(m.id))).map(m => ({ modelKey: hash(`${c.accountKey}:${m.id}`), modelName: m.name || m.id, baseId: m.id, inputModalities:m.inputModalities ?? ['text'] })) });
      }
      ensure();
      return { provider: PROVIDER, binding: 'official-isolated', accounts };
    },
    prepareSlug(key, model) { if(!modelIdOK(model))throw fail('MODEL_REVOKED');return api.prepare(key,hash(`${key}:${model}`),model); },
    async prepare(key, modelKey, hint=null) {
      const c = await capture(key), engine = await c.engine, models = await modelsFor(c,engine,modelIdOK(hint)&&hash(`${key}:${hint}`)===modelKey?hint:null); await validCapture(c);
      const settings=await settingsFor(c);
      const model = models.find(m => hash(`${c.accountKey}:${m.id}`) === modelKey && (settings.enabled===null||settings.enabled.includes(m.id)));
      if (!model) throw fail('MODEL_REVOKED');
      const prepared = await engine.prepare(model.id); await validCapture(c);
      const defaultReasoning=settings.defaultModel===model.id?settings.reasoningEffort:null;
      return { accountKey: c.accountKey, baseId:model.id, defaultReasoning, modelName: model.name || model.id, info: prepared.model,
        stream(options) {
          const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), c.controller.signal]);
          return (async function* () {
            await validCapture(c); activeRequests++;
            try { for await (const event of prepared.stream({ ...(defaultReasoning?{reasoningEffort:defaultReasoning}:{}), ...options, provider: 'openai-codex', model: model.id, signal })) {
              // The real SDK reports terminal usage even after abort. Preserve that
              // accounting, but never resume text/tool output or call it success.
              if (event.type === 'usage') { yield event; continue; }
              signal.throwIfAborted();
              if (event.type === 'finish' && event.reason?.kind === 'error') {
                const code = requestFailure(event.reason.failure, signal);
                // In-band SDK errors do not reach catch. Do not forward raw HTTP
                // bodies, arbitrary failure extensions, or upstream error text.
                yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: `[${code}] ${requestMessages[code] ?? requestMessages.BOUND_REQUEST_FAILED}` } } };
              } else yield event;
            } }
            catch (error) { throw fail(requestFailure(error,signal), signal.aborted?409:503, engine.isPreflightError?.(error)===true); }
            finally { activeRequests--; }
          })();
        } };
    },
    async warmup(key, modelKey, signal) {
      let crossed = false, usage = null, modelName = null;
      try {
        const quota = await api.quota(key, signal);
        if (quota.status !== 'reported' || quota.ordinaryUsageAllowed !== true || [quota.fiveHour, quota.weekly].some(w => w && w.remainingPercent <= 0)) throw fail('ORDINARY_QUOTA_NOT_ALLOWED');
        const prepared = await api.prepare(key, modelKey); signal.throwIfAborted();
        modelName = prepared.modelName;
        const efforts = prepared.info?.reasoning?.efforts;
        const effort = ['off','none','minimal','low','medium','high','xhigh','max'].find(id => Array.isArray(efforts) && efforts.some(row => row.id === id));
        if (prepared.info?.reasoning && !effort) throw fail('REASONING_UNAVAILABLE');
        let finished = false, text = false, invalidOutput = false; crossed = true;
        for await (const event of prepared.stream({ signal, tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply only OK.' }] }], ...(effort ? { reasoningEffort: effort } : {}) })) {
          if (['tool-call','tool-call-start','tool-call-end'].includes(event.type) || (event.type === 'block-start' && event.blockType === 'tool-call') || (event.type === 'block-end' && event.block?.type === 'tool-call')) invalidOutput = true;
          if (event.type === 'text-delta' && typeof event.text === 'string' && event.text.trim()) text = true;
          if (event.type === 'finish') finished = event.reason?.kind === 'stop';
          if (event.type === 'usage' && event.usage && typeof event.usage === 'object') { const result = {}; for (const k of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) if (Number.isSafeInteger(event.usage[k]) && event.usage[k] >= 0) result[k] = event.usage[k]; usage = result; }
        }
        signal.throwIfAborted(); if (!finished || !text || invalidOutput) throw fail('INCOMPLETE_REQUEST', 503, false);
        return { status: 'completed', provider: PROVIDER, accountKey: prepared.accountKey, modelKey, modelName: prepared.modelName, usage };
      } catch { throw Object.assign(fail('WARMUP_UNCONFIRMED', 503, !crossed), { usage, modelName }); }
    },
    async dispose() {
      disposed = true; login?.controller.abort(); for (const c of captures.values()) c.controller.abort();
      if (login && ['running','prompt'].includes(login.status)) await api.remove(login.key).catch(() => {});
      if (login?.task) await Promise.race([login.task.catch(() => {}), delay(2000, undefined, { ref: false })]);
      await directory.tail;
    },
  };
  return api;
}
