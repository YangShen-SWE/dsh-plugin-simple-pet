import { join } from 'node:path';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
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
    const disconnected = new AbortController();
    res.once?.('close', () => disconnected.abort());
    const sourceSignal = req.signal ? AbortSignal.any([req.signal, disconnected.signal]) : disconnected.signal;
    const cancelled = () => { if (!sourceSignal.aborted) return false; reply(503, { error: 'REQUEST_ABORTED', requestNotSent: true }); return true; };
    let dispatched = false;
    try {
      if (cancelled()) return;
      if (method === 'HEAD') { reply(200, { available: true }); return; }
      if (method === 'GET') { reply(200, await service.catalogue()); return; }
      const contentType = typeof req.headers?.get === 'function' ? req.headers.get('content-type') : req.headers?.['content-type'];
      if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(contentType || '')) { reply(415, { error: 'JSON_REQUIRED' }); return; }
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > 8192) { reply(413, { error: 'REQUEST_TOO_LARGE' }); return; } chunks.push(Buffer.from(chunk)); }
      if (cancelled()) return;
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { reply(400, { error: 'INVALID_JSON' }); return; }
      const schema = { 'login.start': ['label'], 'login.cancel': ['id'], 'login.respond': ['id', 'promptId', 'value'], 'account.rename': ['accountKey', 'label', 'expectedGeneration'], 'account.remove': ['accountKey', 'expectedGeneration'], 'account.select': ['accountKey', 'expectedGeneration'], 'quota.read': ['accountKey'], 'models.read':['accountKey'], 'models.refresh':['accountKey'], 'models.configure':['accountKey','expectedGeneration','settings'], 'host-model.select':['accountKey','modelKey'], bindings: [], 'warmup.run': ['accountKey', 'modelKey'] };
      const keys = schema[body?.action];
      if (!keys || !body || Array.isArray(body) || Object.keys(body).sort().join(',') !== ['action', ...keys].sort().join(',')) { reply(400, { error: 'INVALID_ACTION' }); return; }
      const signal = AbortSignal.any([sourceSignal, AbortSignal.timeout(body.action === 'warmup.run' ? 90000 : 20000)]);
      if (cancelled()) return;
      let result;
      dispatched = true;
      switch (body.action) {
        case 'login.start': result = await service.beginLogin(body.label); break;
        case 'login.cancel': result = await service.cancelLogin(body.id); break;
        case 'login.respond': result = await service.respondLogin(body.id, body.promptId, body.value); break;
        case 'account.rename': result = await service.rename(body.accountKey, body.label, body.expectedGeneration, signal); break;
        case 'account.remove': result = await service.remove(body.accountKey, body.expectedGeneration); break;
        case 'account.select': result = await service.select(body.accountKey, body.expectedGeneration, signal); break;
        case 'quota.read': result = await service.quota(body.accountKey, signal); break;
        case 'models.read': result=await service.models(body.accountKey,false,signal);break;
        case 'models.refresh': result=await service.models(body.accountKey,true,signal);break;
        case 'models.configure': result=await service.configureModels(body.accountKey,body.expectedGeneration,body.settings);break;
        case 'host-model.select': result=await service.selectHostModel(body.accountKey,body.modelKey);break;
        case 'bindings': result = await service.bindings(); break;
        case 'warmup.run': result = await service.warmup(body.accountKey, body.modelKey, signal); break;
      }
      reply(200, result);
    } catch (error) {
      if (!dispatched && cancelled()) return;
      // No upstream exception, stack, token, account ID, headers or OAuth input.
      const known = isAccountError(error);
      reply(known && [400,409,410,503].includes(error.status) ? error.status : 503, { error: known ? error.code : 'ACCOUNT_SERVICE_UNAVAILABLE', requestNotSent: known && error.requestNotSent === true,
        ...(known && error.code === 'WARMUP_UNCONFIRMED' && error.usage ? { usage: error.usage, modelName: error.modelName } : {}) });
    }
  };
}
// Shared Fetch is an operator-side channel, NOT the webServer HTTP registry.
// The host Connection /api bridge performs browser Host/Origin/auth admission.
// Direct HTTP retains its separate auth-first handler below. Do not re-check a
// browser cookie on an internal Request: there is no browser cookie to forward.
export function accountServiceFetchHandler(service) {
  const handler = accountServiceHandler(service, () => true);
  return async request => {
    const unavailable = () => Response.json({ error: 'REQUEST_ABORTED', requestNotSent: true }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    if (request.signal.aborted) return unavailable();
    const input = request.body ? Readable.fromWeb(request.body) : Readable.from([]);
    input.method = request.method; input.headers = Object.fromEntries(request.headers); input.signal = request.signal;
    const output = new EventEmitter(); let result, status = 200, headers = {};
    output.writeHead = (code, values = {}) => { status = code; headers = values; };
    output.end = body => { result = new Response(body ?? null, { status, headers }); };
    const abort = () => { output.emit('close'); input.destroy(); };
    request.signal.addEventListener('abort', abort, { once: true });
    try { await handler(input, output); return result || unavailable(); }
    finally { request.signal.removeEventListener('abort', abort); input.destroy(); }
  };
}
export async function apply(ctx, { directoryFile, driver, fetchImpl } = {}) {
  const get = name => {try{return ctx.get?.(name);}catch{return undefined;}};
  const accountDriver=driver ?? (options=>createOfficialDriver({...options,runtime:{attachments:()=>get('attachments'),filesystem:()=>get('fs'),fetchImpl}}));
  const directory = new AccountDirectory(directoryFile || join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'DshCodexAccounts', 'accounts.json'));
  const service = createAccountService({ directory, credentials: ctx.credentials, driver:accountDriver, fetchImpl, hostModel:()=>get('agentDefaultModel'), changed:()=>ctx.llm.emitAdaptersUpdated?.() });
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
    if (typeof routeCtx.connection.fetch?.register === 'function') {
      routeCtx.connection.fetch.register({ path: '/api/dsh-plugin-codex-accounts', methods: ['GET', 'HEAD', 'POST'], requestBody: 'buffered', fetch: accountServiceFetchHandler(service) });
    }
  });
  ctx.effect(() => () => service.dispose(), 'codex-accounts: lifetime');
  // Cordis collects the resolved apply() value as a lifecycle effect. A plain
  // service object is invalid and makes the host unload every registered route.
  // The service is already owned by the lifetime effect; do not return it.
}
