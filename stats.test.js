import assert from 'node:assert/strict';
import test from 'node:test';
import { addUsage, loadLedger, localDay, seedFromRecentEvents } from './stats.js';

test('daily totals count all billed buckets once and aggregate cache rate inputs', () => {
  const at = new Date(2026, 8, 29, 14).getTime();
  const ledger = loadLedger(null, at);
  addUsage(ledger, { inputTokens: 168, cacheReadTokens: 7808, cacheWriteTokens: 0, outputTokens: 9 },
    { items: [{ kind: 'hit', tokens: 7808, cny: .00015616 }, { kind: 'miss', tokens: 168, cny: .000168 }, { kind: 'output', tokens: 9, cny: .000036 }] }, at);
  assert.deepEqual(ledger.days[localDay(at)], {
    tokens: 7985, inputTokens: 168, cacheReadTokens: 7808, outputTokens: 9,
    cny: .00036016, unpricedTokens: 0,
  });
  assert.equal(ledger.activityAt, at);
});

test('unknown prices are disclosed and saved totals survive reload', () => {
  const at = new Date(2026, 8, 29, 14).getTime();
  const ledger = loadLedger(null, at);
  addUsage(ledger, { inputTokens: 50, outputTokens: 3 }, { items: [{ tokens: 50, cny: null }, { tokens: 3, cny: null }] }, at);
  const restored = loadLedger(JSON.parse(JSON.stringify(ledger)), at);
  assert.equal(restored.days[localDay(at)].unpricedTokens, 53);
  assert.equal(restored.days[localDay(at)].tokens, 53);
});

test('recent event migration uses the last real call as idle clock', () => {
  const at = new Date(2026, 8, 29, 14).getTime();
  const ledger = loadLedger(null, at + 60_000);
  seedFromRecentEvents(ledger, [
    { kind: 'hit', tokens: 7808, cny: .00015616, at },
    { kind: 'miss', tokens: 168, cny: .000168, at },
    { kind: 'output', tokens: 9, cny: .000036, at },
    { kind: 'combo', tokens: 0, cny: null, at },
  ]);
  assert.equal(ledger.activityAt, at);
  assert.equal(ledger.partialSince, at);
  assert.equal(ledger.days[localDay(at)].tokens, 7985);
});
