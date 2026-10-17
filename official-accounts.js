// Desktop-pet side: safe DTOs only; this module never sees a Codex grant.
export const OFFICIAL_PROVIDER = 'codex-accounts';
const messages = Object.freeze({
  OFFICIAL_ROUTE_MISSING: '内置账号服务未成功启动，或尚未注册宿主通道。请先查看插件运行错误，不要反复添加账号。修复后需重新加载插件。',
  OFFICIAL_ACCESS_DENIED: '宿主未授权本次读取。请刷新 DSH 页面后重试，不要重复添加账号。',
  DIRECTORY_UNAVAILABLE: '账号目录暂不可读。请检查本机目录权限或文件状态；不要删除授权或去重记录。',
  DIRECTORY_LOCKED: '账号目录正被另一操作占用，请稍后点击刷新。',
  DIRECTORY_WRITE_UNAVAILABLE: '账号目录暂时无法完成原子写入。请稍后重试；不会自动重复登录、额度或模型操作。',
  LOGIN_BUSY: '已有登录正在进行，请刷新查看进度或取消该次登录。',
  MODEL_CATALOG_UNAVAILABLE:'无法更新账号模型目录；保留上次目录，未发送模型请求。',
  MODEL_CATALOG_AUTH_REQUIRED:'账号模型目录拒绝访问，请检查该账号授权；没有回退其它账号。',
  MODEL_CATALOG_INVALID:'账号返回的模型目录不符合当前兼容契约，未采用。',
  MODEL_CATALOG_EMPTY:'该账号未返回当前适配器可用的模型；不会虚构 gpt-6.1-sol 权限。',
  MODEL_REVOKED:'所选模型已不在账号目录或已被隐藏，请刷新目录并重新选择。',
  INVALID_MODEL_SETTINGS:'模型设置不完整或格式不正确。',
  REASONING_UNAVAILABLE:'所选推理档位不受该模型支持。',
  HOST_MODEL_UNAVAILABLE:'当前宿主不支持保存新会话默认模型；可在会话顶部手动选择。',
  HOST_MODEL_NOT_SAVED:'宿主未保存所选模型，请在会话顶部手动选择。',
  DIRECTORY_LIMIT:'账号目录达到安全大小上限，未覆盖现有数据。',
  SOURCE_CHANGED: '账号列表已经变化，请刷新后重新选择。',
  OAUTH_REQUIRED: '该账号的本地授权不可读，请先刷新核验；需要重新绑定时，请核对移除提示，不要清空全部账号。',
  OAUTH_IDENTITY_INVALID: '该账号本地凭据格式无法验证，已暂停使用；请核验后再处理此账号。',
  OAUTH_IDENTITY_CHANGED: '该账号凭据身份与绑定记录不一致，已暂停使用；不会借用其它账号。',
  ACCOUNT_NOT_BOUND: '此账号绑定已变化，请重新读取账号列表。',
  ACCOUNT_REVOKED: '此账号绑定已撤销或代际已变化，请重新读取账号列表。',
  INVALID_ACCOUNT: '账号标识不正确，未执行账号操作。',
  OFFICIAL_SERVICE_UNAVAILABLE: '内置账号服务暂不可用。请检查插件运行状态；操作未自动重试。',
});
const localErrors = new WeakSet();
const conflictCodes = new Set(['SOURCE_CHANGED', 'DIRECTORY_LOCKED', 'DIRECTORY_LIMIT', 'OAUTH_REQUIRED', 'OAUTH_IDENTITY_INVALID', 'OAUTH_IDENTITY_CHANGED', 'ACCOUNT_NOT_BOUND', 'ACCOUNT_REVOKED', 'MODEL_REVOKED', 'REASONING_UNAVAILABLE', 'LOGIN_BUSY']);
const serviceError = (code, requestNotSent = false) => {
  const safe = typeof code === 'string' && Object.hasOwn(messages, code) ? code : 'OFFICIAL_SERVICE_UNAVAILABLE';
  const status = conflictCodes.has(safe) ? 409 : ['INVALID_ACCOUNT', 'INVALID_MODEL_SETTINGS'].includes(safe) ? 400 : safe === 'OFFICIAL_ACCESS_DENIED' ? 403 : 503;
  const error = Object.assign(new Error(messages[safe]), { code: safe, requestNotSent, status });
  localErrors.add(error); return error;
};
export async function officialAccountRpc(bridge, action, payload = {}, signal) {
  if (!bridge?.fetch) throw serviceError('OFFICIAL_SERVICE_UNAVAILABLE', true);
  const response = await bridge.fetch(new Request('http://localhost/api/dsh-plugin-codex-accounts', {
    method: action ? 'POST' : 'GET', signal, headers: action ? { 'Content-Type': 'application/json' } : undefined,
    ...(action ? { body: JSON.stringify({ action, ...payload }) } : {}),
  }));
  if (response.status === 404) throw serviceError('OFFICIAL_ROUTE_MISSING', true);
  if (response.status === 401 || response.status === 403) throw serviceError('OFFICIAL_ACCESS_DENIED', true);
  let data;
  try { data = await response.json(); } catch { throw serviceError('OFFICIAL_SERVICE_UNAVAILABLE'); }
  if (!response.ok) throw Object.assign(serviceError(data?.error, data?.requestNotSent === true),
    data?.error === 'WARMUP_UNCONFIRMED' && data.usage ? { usage: data.usage, modelName: data.modelName } : {});
  return data;
}
export async function readOfficialQuota(bridge, signal, onIdentity = () => {}) {
  const before = await officialAccountRpc(bridge, null, {}, signal);
  const row = before.accounts?.find(r => r.accountKey === before.defaultKey && r.bound === true);
  if (!row) return { status: 'signed-out', provider: OFFICIAL_PROVIDER, fiveHour: null, weekly: null, observedAt: null };
  const quota = await officialAccountRpc(bridge, 'quota.read', { accountKey: row.accountKey }, signal);
  const after = await officialAccountRpc(bridge, null, {}, signal);
  if (!Number.isSafeInteger(before.generation) || after.generation !== before.generation || after.defaultKey !== row.accountKey || !after.accounts?.some(r => r.accountKey === row.accountKey && r.epoch === row.epoch && r.bound === true)) return { status: 'switching', provider: OFFICIAL_PROVIDER, fiveHour: null, weekly: null, observedAt: null };
  onIdentity({ provider: OFFICIAL_PROVIDER, selection: 'default', accountKey: row.accountKey, checkedAt: Date.now(), maskedEmail: null });
  return { status: quota.status === 'reported' ? 'reported' : 'stale', provider: OFFICIAL_PROVIDER, selection: 'default',
    accountKey: row.accountKey, accountCount: after.accounts.filter(r => r.bound === true).length, observedAt: null, clientObservedAt: quota.clientObservedAt,
    serverSampledAt: null, fiveHour: quota.fiveHour ?? null, weekly: quota.weekly ?? null, ordinaryUsageAllowed: quota.ordinaryUsageAllowed };
}
export async function discoverOfficialAccounts({ bridge, signal }) {
  const result = await officialAccountRpc(bridge, 'bindings', {}, signal);
  if (result?.provider !== OFFICIAL_PROVIDER || result?.binding !== 'official-isolated' || !Array.isArray(result.accounts)) throw new Error('Official binding unavailable');
  return result;
}
export async function runOfficialWarmup({ bridge, accountKey, modelKey, signal, onUsage, isCurrent = () => true }) {
  if (!isCurrent()) throw Object.assign(new Error('Official source changed'), { requestNotSent: true });
  // Failure after this dispatch is unknown unless the account service proves unsent.
  let result;
  try { result = await officialAccountRpc(bridge, 'warmup.run', { accountKey, modelKey }, signal); }
  catch (error) { if (error.usage) await onUsage?.(error.usage, { modelName: error.modelName }); throw error; }
  // A later source change cannot erase usage already reported by the fixed account.
  if (result?.usage) await onUsage?.(result.usage, { modelName: result.modelName });
  if (!isCurrent() || result?.status !== 'completed' || result.accountKey !== accountKey || result.modelKey !== modelKey) throw new Error('Official request unconfirmed');
  return result;
}
export function officialAccountsProxy({ bridge, authorize }) {
  const permitted = new Set(['login.start', 'login.cancel', 'login.respond', 'account.remove', 'account.select', 'quota.read', 'models.read', 'models.refresh', 'models.configure', 'host-model.select']);
  return async (req, res) => {
    if (!authorize(req, res)) return;
    const method = req.method || 'GET';
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(method === 'HEAD' ? undefined : JSON.stringify(value)); };
    if (!['GET','HEAD','POST'].includes(method)) { reply(405, { error: 'Method not allowed' }); return; }
    try {
      let action = null, payload = {};
      if (method === 'POST') {
        const type = req.headers?.get?.('content-type') ?? req.headers?.['content-type'];
        if (!/^application\/json(?:\s*;|$)/i.test(type || '')) { reply(415, { error: 'JSON required' }); return; }
        let length = 0; const parts = [];
        for await (const part of req) { const bytes = Buffer.from(part); length += bytes.length; if (length > 8192) { reply(413, { error: 'Request too large' }); return; } parts.push(bytes); }
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
        if (!body || !permitted.has(body.action)) { reply(400, { error: 'Action unavailable' }); return; }
        ({ action, ...payload } = body);
      }
      const current = bridge();
      if (!current) { reply(503, { error: '内置账号服务尚不可用，请检查 simple-pet 运行状态；不会回退第三方账号。', code: 'OFFICIAL_SERVICE_UNAVAILABLE' }); return; }
      const result = await officialAccountRpc(current, action, payload, AbortSignal.timeout(20000));
      if (bridge() !== current) throw new Error('source changed');
      reply(200, result);
    } catch (error) {
      const known = localErrors.has(error) ? error : serviceError('OFFICIAL_SERVICE_UNAVAILABLE');
      reply(known.status, { error: known.message, code: known.code, requestNotSent: known.requestNotSent === true });
    }
  };
}
