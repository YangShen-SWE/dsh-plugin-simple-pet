import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as safety from './warmup-safety.js';
import * as legacy from './index.js';
import { localSchedule } from './warmup.js';

const freeze = value => {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
};
const dayOf = now => localSchedule(now, '00:00').day;
const shiftDate = (now, days) => { const date = new Date(now); date.setDate(date.getDate() + days); return date.getTime(); };
const now = new Date(2026, 9, 16, 12).getTime();

test('old index exports preserve exact function identity', () => {
  for (const name of ['warmupAfterAccountSwitch', 'multiBlocksLegacy', 'legacyBlocksMulti']) assert.equal(legacy[name], safety[name]);
});

test('unknown shared-write latch is monotonic across all boolean evidence', () => {
  for (const uncertain of [false, true]) for (const attempted of [false, true]) for (const confirmed of [false, true]) {
    const evidence = freeze({ attempted, confirmed });
    assert.equal(safety.warmupAfterAccountSwitch(uncertain, evidence), uncertain || (attempted && !confirmed));
  }
  for (const evidence of [undefined, null, {}, { confirmed: true }, { attempted: true }, { attempted: 1, confirmed: false }]) {
    assert.equal(safety.warmupAfterAccountSwitch(true, evidence), true);
    assert.equal(safety.warmupAfterAccountSwitch(false, evidence), evidence?.attempted === true && evidence?.confirmed !== true);
  }
});

test('multi journal blocks on paused, today, future day or either future timestamp', () => {
  const yesterday = dayOf(shiftDate(now, -1)), today = dayOf(now), tomorrow = dayOf(shiftDate(now, 1));
  const cases = [
    [{ paused: true, attempts: [] }, true], [{ paused: false, attempts: [] }, false],
    [{ paused: false, attempts: [{ day: yesterday, attemptedAt: now - 1 }] }, false],
    [{ paused: false, attempts: [{ day: today, attemptedAt: now - 1 }] }, true],
    [{ paused: false, attempts: [{ day: tomorrow, attemptedAt: now - 1 }] }, true],
    [{ paused: false, attempts: [{ day: yesterday, attemptedAt: now + 1 }] }, true],
    [{ paused: false, attempts: [{ day: yesterday, attemptedAt: 1, finishedAt: now + 1 }] }, true],
    [{ paused: false, attempts: [{ day: yesterday, attemptedAt: 1, finishedAt: now }] }, false],
  ];
  for (const [data, expected] of cases) {
    const snapshot = JSON.stringify(data); freeze(data);
    for (let i = 0; i < 3; i++) assert.equal(safety.multiBlocksLegacy(data, now), expected);
    assert.equal(JSON.stringify(data), snapshot);
  }
});

test('legacy same-day attempt or daily key blocks; yesterday/null/zero keep old semantics', () => {
  const cases = [
    [{ keys: [], lastAttemptAt: null }, false], [{ keys: [], lastAttemptAt: 0 }, false],
    [{ keys: [], lastAttemptAt: shiftDate(now, -1) }, false],
    [{ keys: [], lastAttemptAt: now }, true], [{ keys: [], lastAttemptAt: now + 1 }, true],
    [{ keys: [`daily:${dayOf(now)}`], lastAttemptAt: null }, true],
    [{ keys: [`daily:${dayOf(shiftDate(now, -1))}`], lastAttemptAt: 0 }, false],
    [{ keys: [`daily:${dayOf(shiftDate(now, 1))}`], lastAttemptAt: 0 }, false],
  ];
  for (const [journal, expected] of cases) {
    const snapshot = JSON.stringify(journal); freeze(journal);
    for (let i = 0; i < 3; i++) assert.equal(safety.legacyBlocksMulti(journal, now), expected);
    assert.equal(JSON.stringify(journal), snapshot);
  }
});

test('extraction equals the pre-extraction formulas on validated journal inputs', () => {
  const oldMulti = (data, time) => data.paused || data.attempts.some(row => row.day >= dayOf(time) || row.attemptedAt > time || (row.finishedAt ?? 0) > time);
  const oldLegacy = (journal, time) => journal.lastAttemptAt > time || (journal.lastAttemptAt > 0 && dayOf(journal.lastAttemptAt) === dayOf(time)) || journal.keys.includes(`daily:${dayOf(time)}`);
  for (const time of [new Date(2026, 0, 1, 0, 0).getTime(), new Date(2026, 1, 1, 23, 59).getTime(), now]) {
    for (const paused of [false, true]) for (const delta of [-1, 0, 1]) for (const offset of [-1, 0, 1]) {
      const data = freeze({ paused, attempts: [{ day: dayOf(shiftDate(time, delta)), attemptedAt: time + offset, finishedAt: time + offset }] });
      const journal = freeze({ keys: [`daily:${dayOf(shiftDate(time, delta))}`], lastAttemptAt: offset === -1 ? null : time + offset });
      assert.equal(safety.multiBlocksLegacy(data, time), oldMulti(data, time));
      assert.equal(safety.legacyBlocksMulti(journal, time), oldLegacy(journal, time));
    }
  }
});

test('validated-input failures are not silently changed into permissive defaults', () => {
  assert.throws(() => safety.multiBlocksLegacy({ paused: false }, now), TypeError);
  assert.throws(() => safety.legacyBlocksMulti({ lastAttemptAt: null }, now), TypeError);
});

for (const zone of ['Europe/Copenhagen', 'America/New_York']) test(`local calendar boundaries and DST stay local in isolated ${zone} process`, () => {
  const moduleUrl = new URL('./warmup-safety.js', import.meta.url).href;
  const code = `import assert from 'node:assert/strict'; import {multiBlocksLegacy,legacyBlocksMulti} from ${JSON.stringify(moduleUrl)};
    for (const [year,month,day] of [[2026,0,1],[2026,2,29],[2026,9,25],[2026,2,8],[2026,10,1],[2027,0,1]]) {
      const midnight=new Date(year,month,day,0,0).getTime(), prior=midnight-1;
      const localDay=t=>{const d=new Date(t);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};
      assert.equal(legacyBlocksMulti({keys:[],lastAttemptAt:prior},midnight),false);
      assert.equal(legacyBlocksMulti({keys:[],lastAttemptAt:midnight},midnight),true);
      assert.equal(multiBlocksLegacy({paused:false,attempts:[{day:localDay(prior),attemptedAt:prior}]},midnight),false);
      for(const hour of [1,2,3,12,23]) {const t=new Date(year,month,day,hour,30).getTime(); assert.equal(legacyBlocksMulti({keys:[],lastAttemptAt:midnight},t),true);}
    }
    console.log('local calendar checks passed: '+process.env.TZ);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ: zone }, stdio: 'inherit', timeout: 15_000 });
  assert.ifError(result.error); assert.equal(result.status, 0);
});

test('new policy module has only the existing calendar dependency and no reverse import', () => {
  const source = readFileSync(new URL('./warmup-safety.js', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/^import .* from ['"](.+)['"];$/gm)].map(match => match[1]), ['./warmup.js']);
  assert(!/\b(?:setTimeout|setInterval|fetch|readFile|writeFile|process\.env)\b/.test(source));
  const entry = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert(!entry.includes('export function warmupAfterAccountSwitch('));
  assert(!entry.includes('export function multiBlocksLegacy('));
  assert(!entry.includes('export function legacyBlocksMulti('));
});
