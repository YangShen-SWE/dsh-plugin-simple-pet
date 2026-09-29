import assert from 'node:assert/strict';
import test from 'node:test';
import { isPeak, priceUsage } from './billing.js';

test('Beijing weekday peak windows and weekends', () => {
  assert.equal(isPeak('2026-09-29T00:59:00Z'), false);
  assert.equal(isPeak('2026-09-29T01:00:00Z'), true);
  assert.equal(isPeak('2026-09-29T04:00:00Z'), false);
  assert.equal(isPeak('2026-09-29T06:00:00Z'), true);
  assert.equal(isPeak('2026-09-29T10:00:00Z'), false);
  assert.equal(isPeak('2026-10-03T02:00:00Z'), false);
});

test('cache hit, miss including write, and output are distinct', () => {
  const result = priceUsage('deepseek-v4-flash', {
    inputTokens: 1_000_000, cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000, outputTokens: 1_000_000,
  }, '2026-09-29T01:00:00Z');
  assert.deepEqual(result.items.map(x => [x.kind,x.tokens,x.cny]), [
    ['hit',1_000_000,.04],['miss',2_000_000,4],['output',1_000_000,8],
  ]);
  assert.equal(result.cacheHitRate,1/3);
});

test('unknown models keep token feedback without inventing money', () => {
  const result = priceUsage('unknown', { inputTokens:12,outputTokens:3 }, '2026-09-29T01:00:00Z');
  assert.deepEqual(result.items.map(x=>x.cny),[null,null]);
});

test('current Flash name uses published prices', () => {
  const result = priceUsage('deepseek-flash',{inputTokens:1_000_000,outputTokens:1_000_000},'2026-09-29T00:00:00Z');
  assert.deepEqual(result.items.map(x=>x.cny),[1,4]);
});

test('a 7000-token prompt is charged once in its reported bucket', () => {
  const miss = priceUsage('deepseek-flash', {
    inputTokens: 7000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
  }, '2026-09-29T00:00:00Z');
  assert.deepEqual(miss.items, [{ kind: 'miss', tokens: 7000, cny: .007 }]);
  const hit = priceUsage('deepseek-flash', {
    inputTokens: 0, cacheReadTokens: 7000, cacheWriteTokens: 0, outputTokens: 0,
  }, '2026-09-29T00:00:00Z');
  assert.deepEqual(hit.items, [{ kind: 'hit', tokens: 7000, cny: .00014 }]);
});
