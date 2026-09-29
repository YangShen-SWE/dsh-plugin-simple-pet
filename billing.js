// Official DeepSeek CNY prices per million tokens, as published 2026-09-29.
// Keep this small table current when DeepSeek changes its public pricing page.
export const PRICES = Object.freeze({
  'deepseek-flash': { valley: [0.02, 1, 4], peak: [0.04, 2, 8] },
  'deepseek-v4-flash': { valley: [0.02, 1, 4], peak: [0.04, 2, 8] },
  'deepseek-v4-flash-vision-exp': { valley: [0.02, 1, 4], peak: [0.04, 2, 8] },
  'deepseek-v4-pro': { valley: [0.15, 4.5, 13.5], peak: [0.30, 9, 27] },
});

const shanghaiClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23',
});

export function isPeak(when = Date.now()) {
  const parts = Object.fromEntries(shanghaiClock.formatToParts(new Date(when)).map(p => [p.type, p.value]));
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return (minute >= 540 && minute < 720) || (minute >= 840 && minute < 1080);
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function priceUsage(model, usage, when = Date.now()) {
  const input = count(usage?.inputTokens);
  const hit = count(usage?.cacheReadTokens);
  const write = count(usage?.cacheWriteTokens);
  const output = count(usage?.outputTokens);
  const peak = isPeak(when);
  const rates = PRICES[model]?.[peak ? 'peak' : 'valley'];
  const items = [
    { kind: 'hit', tokens: hit, cny: rates ? hit * rates[0] / 1e6 : null },
    { kind: 'miss', tokens: input + write, cny: rates ? (input + write) * rates[1] / 1e6 : null },
    { kind: 'output', tokens: output, cny: rates ? output * rates[2] / 1e6 : null },
  ].filter(item => item.tokens > 0);
  return { items, peak, cacheHitRate: input + hit + write ? hit / (input + hit + write) : null };
}
