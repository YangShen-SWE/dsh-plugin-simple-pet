// Desktop-pet side: safe DTOs only; this module never sees a Codex grant.
export const OFFICIAL_PROVIDER = 'codex-accounts';
export async function officialAccountRpc(bridge, action, payload = {}, signal) {
  if (!bridge?.fetch) throw Object.assign(new Error('Official account service unavailable'), { requestNotSent: true });
  const response = await bridge.fetch(new Request('http://localhost/api/dsh-plugin-codex-accounts', {
    method: action ? 'POST' : 'GET', signal, headers: action ? { 'Content-Type': 'application/json' } : undefined,
    ...(action ? { body: JSON.stringify({ action, ...payload }) } : {}),
  }));
  if (response.status === 404) throw Object.assign(new Error('Official account plugin is not enabled'), { requestNotSent: true });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error('Official account operation unavailable'), { requestNotSent: data?.requestNotSent === true,
    ...(data?.error === 'WARMUP_UNCONFIRMED' && data.usage ? { usage: data.usage, modelName: data.modelName } : {}) });
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
  const permitted = new Set(['login.start', 'login.cancel', 'login.respond', 'account.remove', 'account.select', 'quota.read']);
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
      if (!current) { reply(503, { error: '请安装并启用独立官方组件账号插件；不会回退第三方账号。' }); return; }
      const result = await officialAccountRpc(current, action, payload, AbortSignal.timeout(20000));
      if (bridge() !== current) throw new Error('source changed');
      reply(200, result);
    } catch { reply(503, { error: '账号服务不可用或授权已变化；未自动重试。' }); }
  };
}
