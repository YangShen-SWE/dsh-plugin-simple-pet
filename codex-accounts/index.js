import { join } from 'node:path';
import { homedir } from 'node:os';
import { AccountDirectory, createAccountService, PROVIDER, isAccountError } from './service.js';
import { createOfficialDriver, createBoundAdapter } from './official-driver.js';

export const name = 'codex-accounts';
export const inject = ['credentials', 'llm'];
export function accountServiceHandler(service, authorize) {
  return async (req, res) => {
    if (!authorize(req, res)) return;
    const method = req.method || 'GET';
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(method === 'HEAD' ? undefined : JSON.stringify(data)); };
    if (!['GET', 'HEAD', 'POST'].includes(method)) { reply(405, { error: 'METHOD_NOT_ALLOWED' }); return; }
    try {
      if (method === 'GET' || method === 'HEAD') { reply(200, await service.catalogue()); return; }
      const contentType = typeof req.headers?.get === 'function' ? req.headers.get('content-type') : req.headers?.['content-type'];
      if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(contentType || '')) { reply(415, { error: 'JSON_REQUIRED' }); return; }
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > 8192) { reply(413, { error: 'REQUEST_TOO_LARGE' }); return; } chunks.push(Buffer.from(chunk)); }
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { reply(400, { error: 'INVALID_JSON' }); return; }
      const schema = { 'login.start': ['label'], 'login.cancel': ['id'], 'login.respond': ['id', 'promptId', 'value'], 'account.remove': ['accountKey'], 'account.select': ['accountKey', 'expectedGeneration'], 'quota.read': ['accountKey'], bindings: [], 'warmup.run': ['accountKey', 'modelKey'] };
      const keys = schema[body?.action];
      if (!keys || !body || Array.isArray(body) || Object.keys(body).sort().join(',') !== ['action', ...keys].sort().join(',')) { reply(400, { error: 'INVALID_ACTION' }); return; }
      const disconnected = new AbortController();
      res.once?.('close', () => disconnected.abort());
      const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(body.action === 'warmup.run' ? 90000 : 20000)]);
      let result;
      switch (body.action) {
        case 'login.start': result = await service.beginLogin(body.label); break;
        case 'login.cancel': result = await service.cancelLogin(body.id); break;
        case 'login.respond': result = await service.respondLogin(body.id, body.promptId, body.value); break;
        case 'account.remove': result = await service.remove(body.accountKey); break;
        case 'account.select': result = await service.select(body.accountKey, body.expectedGeneration); break;
        case 'quota.read': result = await service.quota(body.accountKey, signal); break;
        case 'bindings': result = await service.bindings(); break;
        case 'warmup.run': result = await service.warmup(body.accountKey, body.modelKey, signal); break;
      }
      reply(200, result);
    } catch (error) {
      // No upstream exception, stack, token, account ID, headers or OAuth input.
      const known = isAccountError(error);
      reply(known && [400,409,410,503].includes(error.status) ? error.status : 503, { error: known ? error.code : 'ACCOUNT_SERVICE_UNAVAILABLE', requestNotSent: known && error.requestNotSent === true,
        ...(known && error.code === 'WARMUP_UNCONFIRMED' && error.usage ? { usage: error.usage, modelName: error.modelName } : {}) });
    }
  };
}
export async function apply(ctx, { directoryFile, driver = createOfficialDriver, fetchImpl } = {}) {
  const directory = new AccountDirectory(directoryFile || join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'DshCodexAccounts', 'accounts.json'));
  const service = createAccountService({ directory, credentials: ctx.credentials, driver, fetchImpl });
  await service.catalogue();
  const adapter = createBoundAdapter(service);
  ctx.llm.registerAdapter([PROVIDER], adapter);
  ctx.inject(['webServer', 'connection'], routeCtx => {
    const authorize = (req, res) => {
      let rejection = 403;
      try { rejection = routeCtx.connection.requestRejection(req); } catch { /* fail closed */ }
      if (rejection === undefined) return true;
      res.writeHead(rejection === 401 ? 401 : 403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: 'UNAUTHORIZED' })); return false;
    };
    routeCtx.effect(() => routeCtx.webServer.register({ kind: 'exact', path: '/api/dsh-plugin-codex-accounts', handler: accountServiceHandler(service, authorize) }), 'codex-accounts: authenticated service');
  });
  ctx.effect(() => () => service.dispose(), 'codex-accounts: lifetime');
  return service;
}
