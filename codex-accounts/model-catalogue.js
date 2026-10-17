// The account catalogue is a Codex subscription compatibility endpoint, not
// Platform API-key billing. Never infer account entitlement from a static name.
export const modelIdOK = id => typeof id === 'string' && id.trim() === id && id.length <= 128 && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);
const levels = ['off','minimal','low','medium','high','xhigh','max'];
const label = (v, fallback) => typeof v === 'string' && v.length <= 160 && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(v) ? v : fallback;
const positive = n => Number.isSafeInteger(n) && n > 0 && n <= 10_000_000;
export function inspectAccountModelCatalogue(raw, builtin) {
  if (!raw || !Array.isArray(raw.models) || raw.models.length > 1000) throw new Error('MODEL_CATALOG_INVALID');
  const template = builtin.find(m => !/spark|reserve/i.test(m.id));
  const result = [], omitted = [], capabilityGaps = [], seen = new Set();
  const omit = (row, reason) => { if (modelIdOK(row?.slug) && omitted.length < 128) omitted.push({ id: row.slug, reason }); };
  for (const row of raw.models) {
    if (!row || !modelIdOK(row.slug) || seen.has(row.slug)) continue;
    if (row.visibility !== 'list') { omit(row, 'not-visible'); continue; }
    if (/reserve/i.test(row.slug)) { omit(row, 'reserve-unsupported'); continue; }
    const original = builtin.find(m => m.id === row.slug), base = original || template;
    // Context metadata is optional in the compatibility catalogue (the reference
    // plugin also uses SDK defaults). Missing metadata must not erase an online
    // model. This is a conservative LOCAL budget, not its advertised context or
    // an account entitlement. Explicitly malformed limits still fail closed.
    const localContext = !original && row.context_window == null && row.max_context_window == null && positive(base?.contextWindow);
    const context = positive(row.context_window) ? row.context_window : positive(row.max_context_window) ? row.max_context_window : original?.contextWindow ?? (localContext ? Math.min(base.contextWindow, 8192) : undefined);
    if (!base || !positive(context)) { omit(row, 'missing-context'); continue; }
    if (localContext && capabilityGaps.length < 128) capabilityGaps.push({ id: row.slug, reason: 'context-limit-unreported', localContextLimit: context });
    const input = Array.isArray(row.input_modalities) ? row.input_modalities.filter(v => v === 'text' || v === 'image') : [...(original?.input ?? ['text'])];
    if (!input.includes('text')) { omit(row, 'unsupported-input'); continue; }
    const rawEfforts = Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels.map(v => v?.effort) : null;
    const supported = rawEfforts?.filter(v => ['none', ...levels].includes(v)) ?? null;
    if (rawEfforts?.some(v => !['none', ...levels].includes(v)) && capabilityGaps.length < 128) capabilityGaps.push({ id: row.slug, reason: 'unknown-reasoning' });
    const thinkingLevelMap = supported ? Object.fromEntries(levels.map(v => [v, supported.includes(v === 'off' ? 'none' : v) ? (v === 'off' ? 'none' : v) : null])) : base.thinkingLevelMap;
    seen.add(row.slug);
    const merged={ ...base, id: row.slug, name: label(row.display_name, row.slug), input: [...new Set(input)], contextWindow: context,
      reasoning: supported ? supported.length > 0 : (original?.reasoning ?? false), ...(thinkingLevelMap ? { thinkingLevelMap } : {}), pricingKnown:!!original };
    if (localContext) {
      merged.maxTokens = Math.min(positive(base.maxTokens) ? base.maxTokens : 4096, Math.floor(context / 2));
      delete merged.maxContextWindow; // Never advertise the template's extended context.
    }
    if(!original&&!supported)delete merged.thinkingLevelMap;
    if(!original)delete merged.cost; // Unknown subscription price is not a free model.
    result.push(merged);
  }
  return { models: result, omitted, capabilityGaps, receivedCount: raw.models.length };
}
export function mergeAccountModels(raw, builtin) {
  const report = inspectAccountModelCatalogue(raw, builtin);
  if (!report.models.length) throw new Error('MODEL_CATALOG_EMPTY');
  return report.models;
}
export async function fetchAccountModels({ auth, accountId, signal, fetchImpl = globalThis.fetch, etag = null }) {
  const combined=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(10000)]);
  const wait=async value=>{combined.throwIfAborted();let cancel;const interrupted=new Promise((_,reject)=>{cancel=()=>reject(new Error('MODEL_CATALOG_UNAVAILABLE'));combined.addEventListener('abort',cancel,{once:true});});try{const result=await Promise.race([Promise.resolve(value),interrupted]);combined.throwIfAborted();return result;}finally{combined.removeEventListener('abort',cancel);}};
  let reader;
  try {
    if(![auth,accountId].every(v=>typeof v==='string'&&v.length>0&&v.length<=65536&&!/[\x00-\x1f\x7f]/.test(v)))throw new Error('MODEL_CATALOG_AUTH_REQUIRED');
    const headers = { Authorization: `Bearer ${auth}`, 'chatgpt-account-id': accountId, Accept: 'application/json', originator: 'pi', 'User-Agent': 'dsh-plugin-simple-pet/1.0.1' };
    if (typeof etag==='string'&&etag.length<=256&&!/[\x00-\x1f\x7f]/.test(etag)) headers['If-None-Match'] = etag;
    combined.throwIfAborted();
    const response=await wait(fetchImpl('https://chatgpt.com/backend-api/codex/models?client_version=0.153.4',{method:'GET',headers,redirect:'error',signal:combined}));
    if(response.status===304)return {notModified:true};
    if(!response.ok)throw new Error(response.status===401||response.status===403?'MODEL_CATALOG_AUTH_REQUIRED':'MODEL_CATALOG_UNAVAILABLE');
    if(!response.body||Number(response.headers.get('content-length')||0)>524288)throw new Error('MODEL_CATALOG_INVALID');
    reader=response.body.getReader();const chunks=[];let size=0;
    for(;;){const part=await wait(reader.read());if(part.done)break;size+=part.value.byteLength;if(size>524288)throw new Error('MODEL_CATALOG_INVALID');chunks.push(part.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
    let raw;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('MODEL_CATALOG_INVALID');}
    const tag=response.headers.get('etag');
    return {raw,etag:typeof tag==='string'&&tag.length<=256&&!/[\x00-\x1f\x7f]/.test(tag)?tag:null};
  } catch(error) {
    const code=['MODEL_CATALOG_AUTH_REQUIRED','MODEL_CATALOG_INVALID'].includes(error?.message)?error.message:'MODEL_CATALOG_UNAVAILABLE';
    throw new Error(code); // No URL, token, abort reason, response body or cause escapes.
  } finally { if(reader){try{Promise.resolve(reader.cancel()).catch(()=>{});}catch{}try{reader.releaseLock();}catch{}} }
}
export function validModelSettings(x) {
  return x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).every(k => ['enabled','defaultModel','reasoningEffort'].includes(k))
    && (x.enabled === null || (Array.isArray(x.enabled) && x.enabled.length <= 128 && new Set(x.enabled).size === x.enabled.length && x.enabled.every(modelIdOK)))
    && (x.defaultModel === null || modelIdOK(x.defaultModel)) && (x.reasoningEffort === null || levels.includes(x.reasoningEffort));
}
export const defaultModelSettings = () => ({ enabled: null, defaultModel: null, reasoningEffort: null });
export function requestFailure(error, signal) {
  if (signal?.aborted || error?.name === 'AbortError') return 'BOUND_CANCELLED';
  const code = error?.code;
  if (code === 'UNSUPPORTED_CONTENT' || code === 'IMAGE_OFFLOAD_REQUIRED') return 'BOUND_CONTENT_UNSUPPORTED';
  if (['UNSUPPORTED_OPTION','INVALID_REASONING_EFFORT','UNSUPPORTED_REASONING_EFFORT'].includes(code)) return 'BOUND_OPTION_UNSUPPORTED';
  if (['UNKNOWN_MODEL','MODEL_NOT_FOUND'].includes(code)) return 'BOUND_MODEL_UNAVAILABLE';
  if (['AUTH','INVALID_CREDENTIAL','INVALID_API_KEY','UNAUTHORIZED','AUTHENTICATION'].includes(code)) return 'BOUND_AUTH_REQUIRED';
  if (['QUOTA_EXCEEDED','RATE_LIMITED','RATE_LIMIT'].includes(code)) return 'BOUND_QUOTA_LIMITED';
  if (['TRANSPORT','NETWORK','TIMEOUT','LLM_STREAM_IDLE_TIMEOUT'].includes(code)) return 'BOUND_TRANSPORT_FAILED';
  return 'BOUND_REQUEST_FAILED';
}
