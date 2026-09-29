const DAY_MS = 86_400_000;

export function localDay(at) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) throw new Error('invalid event time');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function whole(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function loadLedger(raw, now = Date.now()) {
  const days = {};
  if (raw?.version === 1 && raw.days && typeof raw.days === 'object') {
    const cutoff = localDay(now - 400 * DAY_MS);
    for (const [day, entry] of Object.entries(raw.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < cutoff || day > localDay(now)) continue;
      days[day] = {
        tokens: whole(entry?.tokens), inputTokens: whole(entry?.inputTokens),
        cacheReadTokens: whole(entry?.cacheReadTokens), outputTokens: whole(entry?.outputTokens),
        cny: Number.isFinite(entry?.cny) && entry.cny >= 0 ? entry.cny : 0,
        unpricedTokens: whole(entry?.unpricedTokens),
      };
    }
  }
  return { version: 1, activityAt: Number.isFinite(raw?.activityAt) ? raw.activityAt : now,
    partialSince: Number.isFinite(raw?.partialSince) ? raw.partialSince : null, days };
}

export function seedFromRecentEvents(ledger, events) {
  if (!Array.isArray(events)) return;
  let latest = null;
  for (const event of events) {
    if (!['hit', 'miss', 'output'].includes(event?.kind) || !Number.isFinite(event?.at)) continue;
    const tokens = whole(event.tokens);
    if (!tokens) continue;
    const day = localDay(event.at);
    const entry = ledger.days[day] ??= { tokens: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, cny: 0, unpricedTokens: 0 };
    entry.tokens += tokens;
    if (event.kind === 'hit') entry.cacheReadTokens += tokens;
    if (event.kind === 'miss') entry.inputTokens += tokens;
    if (event.kind === 'output') entry.outputTokens += tokens;
    if (Number.isFinite(event.cny) && event.cny >= 0) entry.cny += event.cny;
    else entry.unpricedTokens += tokens;
    latest = latest === null ? event.at : Math.max(latest, event.at);
    ledger.partialSince = ledger.partialSince === null ? event.at : Math.min(ledger.partialSince, event.at);
  }
  if (latest !== null) ledger.activityAt = latest;
}

export function addUsage(ledger, usage, priced, at) {
  const day = localDay(at);
  const entry = ledger.days[day] ??= { tokens: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, cny: 0, unpricedTokens: 0 };
  const input = whole(usage?.inputTokens) + whole(usage?.cacheWriteTokens);
  const hit = whole(usage?.cacheReadTokens);
  const output = whole(usage?.outputTokens);
  entry.inputTokens += input;
  entry.cacheReadTokens += hit;
  entry.outputTokens += output;
  entry.tokens += input + hit + output;
  for (const item of priced.items) {
    if (item.cny === null) entry.unpricedTokens += item.tokens;
    else entry.cny += item.cny;
  }
  ledger.activityAt = at;
  return entry;
}
