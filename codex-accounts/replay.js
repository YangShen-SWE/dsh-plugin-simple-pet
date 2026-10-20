import { createHash } from 'node:crypto';

// Persist the SDK's opaque JSON under the account that actually produced it.
// The host records the public route; pi-ai validates its own native route.
const kind = 'simple-pet/codex-account-replay';
const nativeState = (state, model) => state?.response?.kind === 'pi-ai'
  && state.response.version === 2 && state.response.provider === 'openai-codex'
  && state.response.model === model && Array.isArray(state.blocks);
const routeMatches = (route, accountKey, model) => route === `${accountKey}:${model}`
  || route === `${accountKey}:${createHash('sha256').update(`${accountKey}:${model}`).digest('hex')}`
  || route === `default:${model}`;

export function accountReplayMessages(messages, accountKey, model) {
  return messages?.map(message => {
    if (message.role !== 'assistant' || !['codex-accounts', 'openai-codex'].includes(message.source?.provider)) return message;
    const { replayState, ...source } = message.source;
    if (source.provider === 'codex-accounts' && replayState?.kind === kind && replayState.version === 1
      && replayState.accountKey === accountKey && replayState.model === model
      && routeMatches(source.model, accountKey, model) && nativeState(replayState.state, model)) {
      return { ...message, source: { ...source, provider: 'openai-codex', model, replayState: replayState.state } };
    }
    // Old unwrapped, cross-account/model or malformed state is NOT native replay.
    // Keep durable text/tool blocks intact; the SDK performs neutral conversion.
    return replayState === undefined ? message : { ...message, source };
  });
}

export function accountReplayEvent(event, accountKey, model) {
  if (event.type !== 'finish' || event.replayState === undefined) return event;
  const { replayState, ...rest } = event;
  if (!nativeState(replayState, model)) return rest;
  return { ...rest, replayState: { kind, version: 1, accountKey, model, state: replayState } };
}
