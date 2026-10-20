import { openSync, readSync, closeSync, lstatSync } from 'node:fs';
// The same public host peer API used by the official account driver. DSH's
// plugin loader supplies this peer; do not bypass it with private ASAR paths.
export async function loadExpertMessageFactory() {
  const {createUserMessage} = await import('@deepseek-ai/dsh-llm');
  if (typeof createUserMessage !== 'function') throw Error('EXPERT_MESSAGE_API_UNAVAILABLE');
  return createUserMessage;
}

const ID = /^(?:session-)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FIXED = /^[a-f0-9]{16}:([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const EFFORTS = new Set(['none','minimal','low','medium','high','xhigh']);
const record = x => x && typeof x === 'object' && !Array.isArray(x);
const same = (a,b) => a?.provider === b?.provider && a?.model === b?.model;
const fault = () => Object.assign(Error('Explicit expert route policy changed; no request was sent.'), {code:'EXPERT_ROUTE_POLICY_CHANGED',requestNotSent:true});

// This is an explicit, machine-local allowlist, never a provider alias or a
// rule that follows a changing default. Only session IDs and model routes live here.
export function validateExpertRoutePolicy(value) {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 16) throw Error('INVALID_EXPERT_ROUTE_POLICY');
  const seen = new Set();
  return Object.freeze(value.entries.map(row => {
    const match = typeof row?.target?.model === 'string' && FIXED.exec(row.target.model);
    if (!record(row) || !match || !ID.test(row.sessionId ?? '') || !ID.test(row.parentSessionId ?? '') || row.sessionId === row.parentSessionId || seen.has(row.sessionId)
      || row.source?.provider !== 'openai-codex' || row.source?.model !== match?.[1] || row.target?.provider !== 'codex-accounts'
      || (row.target.reasoningEffort !== undefined && !EFFORTS.has(row.target.reasoningEffort))) throw Error('INVALID_EXPERT_ROUTE_POLICY');
    seen.add(row.sessionId);
    return Object.freeze({sessionId:row.sessionId,parentSessionId:row.parentSessionId,
      source:Object.freeze({provider:'openai-codex',model:row.source.model}),
      target:Object.freeze({provider:'codex-accounts',model:row.target.model,...row.target.reasoningEffort === undefined ? {} : {reasoningEffort:row.target.reasoningEffort}})});
  }));
}
export function loadExpertRoutePolicy(file) {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw Error('INVALID_EXPERT_ROUTE_POLICY');
    const fd = openSync(file,'r'), bytes = Buffer.alloc(16385);
    let count = 0;
    try { let n; while (count < bytes.length && (n = readSync(fd,bytes,count,bytes.length-count,null)) > 0) count += n; }
    finally { closeSync(fd); }
    if (count > 16384) throw Error('INVALID_EXPERT_ROUTE_POLICY');
    return validateExpertRoutePolicy(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,count))));
  } catch (error) { if (error.code === 'ENOENT') return []; throw Error('INVALID_EXPERT_ROUTE_POLICY'); }
}

// Public Agent lifecycle + waterfall APIs. Never mutate AgentOptions, session
// files, private child descriptors, account grants, global defaults or adapters.
export function installExpertSessionCompatibility(ctx, { readPolicy, createUserMessage }) {
  let live = true;
  const attached = new Map();
  const detach = agent => { attached.get(agent)?.(); attached.delete(agent); };
  function attach(agent) {
    if (!live || attached.has(agent)) return;
    const header = agent.session?.header;
    if (header?.origin !== 'subagent' || !header.parentSession) return;
    let initial;
    try { initial = readPolicy().find(r => r.sessionId === agent.id && r.parentSessionId === header.parentSession); }
    catch { ctx.logger?.warn?.('simple-pet: invalid explicit expert route policy; no migration installed.'); return; }
    if (!initial) return;
    let assembled = null, noticePending = false, committed = false;
    function eligible() {
      if (!live) return null;
      let row;
      try { row = readPolicy().find(r => r.sessionId === agent.id && r.parentSessionId === header.parentSession); } catch { return null; }
      if (!row || JSON.stringify(row) !== JSON.stringify(initial)) return null;
      const providers = ctx.llm.listProviders();
      if (providers.some(p => p.id === row.source.provider) || !providers.some(p => p.id === row.target.provider)) return null;
      // A later explicit user selection wins. Never redirect another route.
      const pending = ctx.sessionProjections.stateOf(agent.session,'modelSelection')?.pending;
      const previous = agent.session.requestHeader()?.config;
      const options = agent.options;
      if ((same(pending,row.target) && pending.reasoningEffort !== row.target.reasoningEffort)
        || (pending && !same(pending,row.target))
        || (same(previous,row.target) && previous.reasoningEffort !== row.target.reasoningEffort)
        || (previous && !same(previous,row.source) && !same(previous,row.target))
        || (!same(options,row.source) && !same(options,row.target))) return null;
      return row;
    }
    const disposers = [];
    disposers.push(agent.ctx.on('system-prompt/assemble',async (_assembly,context,next) => {
      if (context?.scope !== agent) return next();
      const row = eligible();
      assembled = null;
      const result = await next();
      if (!row) return result;
      if (!eligible()) throw fault();
      const previous = agent.session.requestHeader()?.config;
      if (!committed) {
        agent.session.append('model/selection',{...row.target});
        committed = true;
      }
      assembled = row;
      noticePending = !same(previous,row.target);
      return {...result,variables:{...result.variables,provider:row.target.provider,model:row.target.model}};
    }));
    disposers.push(agent.ctx.on('agent/request',async (payload,next) => {
      if (payload?.agent !== agent) return next();
      const result = await next();
      if (!assembled) return result;
      if (!eligible()) throw fault();
      // The inner route may only still be the legacy route or the selected
      // target. Competing runtime selection cannot be overwritten.
      if (!same(result,assembled.source) && !same(result,assembled.target)) throw fault();
      const {reasoningEffort:_old,...rest} = result;
      return {...rest,...assembled.target};
    }));
    disposers.push(agent.ctx.on('agent/pre-step',async ({agent:subject,messages,signal,step},next) => {
      if (subject !== agent) return next();
      const decision = await next();
      if (!assembled || !noticePending || signal.aborted || decision.kind === 'reject') return decision;
      if (!eligible()) throw fault();
      if (decision.messages.length === 0 && (step === 1 || messages.length > 0)) return decision;
      const from = `${assembled.source.provider}/${assembled.source.model}`, to = `${assembled.target.provider}/${assembled.target.model}`;
      return {...decision,messages:[...decision.messages,createUserMessage({content:[{type:'text',text:`[explicit expert session route migration: ${from} → ${to}; history retained; no automatic task retry]`}],source:{kind:'model-selection',form:'notice',summary:'Explicit fixed-account expert route migration'}})]};
    },{prepend:true}));
    attached.set(agent,() => { for (const dispose of disposers) dispose(); assembled = null; });
  }
  const offCreated = ctx.on('agent/created',({agent}) => attach(agent));
  const offDisposed = ctx.on('agent/disposed',({agent}) => detach(agent));
  for (const agent of ctx.agents.list()) attach(agent);
  return () => { live = false; offCreated(); offDisposed(); for (const agent of [...attached.keys()]) detach(agent); };
}
