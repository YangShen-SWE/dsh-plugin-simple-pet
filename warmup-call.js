import { createHash } from 'node:crypto';
import { subscriptionRpc } from './codex.js';
const PROVIDER = 'openai-codex';
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export async function currentCodexAccountKey(bridge, signal) {
  const status = await subscriptionRpc(bridge, 'codex-subscription/status', {}, signal);
  const active = Array.isArray(status?.accounts) ? status.accounts.filter(account => account?.active === true) : [];
  if (!status?.authenticated || active.length !== 1 || typeof active[0].id !== 'string' || !active[0].id) return null;
  return createHash('sha256').update(active[0].id).digest('hex').slice(0, 16);
}

export async function chooseWarmupModel(llm, bridge, signal) {
  if (typeof llm?.stream !== 'function' || typeof llm?.listModels !== 'function') throw new Error('warm-up API unavailable');
  const catalog = await llm.listModels(PROVIDER); signal.throwIfAborted();
  const models = Array.isArray(catalog) ? catalog.filter(model => model?.provider === PROVIDER
    && MODEL_ID.test(model.id ?? '') && !/^gpt-image/i.test(model.id)) : [];
  if (!models.length) throw new Error('no available Codex model');
  let selected;
  try { selected = await subscriptionRpc(bridge, 'codex-subscription/default-model/status', {}, signal); }
  catch { signal.throwIfAborted(); }
  const model = selected?.managed === true && selected.provider === PROVIDER && models.some(item => item.id === selected.model)
    ? selected.model : models[0].id;
  let reasoningEffort;
  if (typeof llm.resolveModelInfo === 'function') {
    const info = await llm.resolveModelInfo(PROVIDER, model, signal); signal.throwIfAborted();
    const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts.map(item => item?.id) : [];
    reasoningEffort = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].find(id => efforts.includes(id));
  }
  return { model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

// One direct logical call: no session, conversation history, agent loop or tool execution.
// Existing provider middleware/transport may still retry internally; maxTokens is not an enforceable Codex cap.
export async function runCodexWarmup({ llm, bridge, quota, signal, onUsage = () => {} }) {
  const config = await chooseWarmupModel(llm, bridge, signal);
  if (await currentCodexAccountKey(bridge, signal) !== quota.accountKey) throw new Error('active account changed');
  signal.throwIfAborted();
  let usage = null, finish = null, hasText = false;
  try {
    for await (const chunk of llm.stream({ provider: PROVIDER, ...config,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply only OK.' }] }], tools: [], signal })) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') hasText ||= /\S/.test(chunk.text);
      if (chunk.type === 'usage') usage = chunk.usage;
      if (chunk.type === 'finish') finish = chunk.reason;
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    if (finish?.kind !== 'stop' || !hasText) throw new Error('warm-up did not complete');
    if (await currentCodexAccountKey(bridge, signal) !== quota.accountKey) throw new Error('active account changed');
    signal.throwIfAborted();
    return { model: config.model };
  } finally {
    // Terminal failure may still report billed usage. Count the final cumulative DTO once; never save response text.
    if (usage) onUsage(usage, config.model);
  }
}
