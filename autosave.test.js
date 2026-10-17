import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreferenceAutosave, AUTOSAVE_PREFERENCE_KEYS } from './client-source.js';
import { DEFAULT_PREFERENCES } from './preferences.js';

const initial = () => ({ revision: 'a'.repeat(64), values: { ...DEFAULT_PREFERENCES } });
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(write) {
  const timers = new Map(), writes = [], changes = [], receipts = [];
  let next = 0, saved = initial();
  const saver = createPreferenceAutosave({
    write: async (patch, revision, signal) => {
      writes.push({ patch, revision, signal });
      if (write) return write(patch, revision, signal);
      saved = { ...saved, revision: String(writes.length).repeat(64), values: { ...saved.values, ...patch } };
      return saved;
    },
    setTimer(fn, delay) { const id = ++next; timers.set(id, { fn, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    onChange(state) { changes.push(state); }, onSaved(data) { receipts.push(data); },
  });
  saver.load(saved);
  return { saver, writes, timers, changes, receipts, async tick() { const ready = [...timers.values()]; timers.clear(); ready.forEach(({ fn }) => fn()); await turn(); } };
}

test('loading is read-only; positive allowlist excludes spending/account authorization', () => {
  const f = fixture();
  assert.equal(f.saver.state().status, 'saved'); assert.equal(f.timers.size, 0); assert.equal(f.writes.length, 0);
  for (const key of ['codexWarmupDaily', 'codexWarmupReset', 'codexWarmupStartup', 'codexWarmupTime', 'codexAccountBackend', 'multiAccountManagement', 'futureSpendingGrant']) assert(!AUTOSAVE_PREFERENCE_KEYS.includes(key));
  f.saver.dispose();
});
test('debounce coalesces only the latest safe draft and no-op reversions cancel it', async () => {
  const f = fixture();
  f.saver.edit('skin', 'mint'); f.saver.edit('skin', 'star'); f.saver.edit('size', 'tiny');
  assert.equal(f.timers.size, 1); assert.equal([...f.timers.values()][0].delay, 450); assert.equal(f.writes.length, 0);
  await f.tick(); assert.deepEqual(f.writes[0].patch, { skin: 'star', size: 'tiny' }); assert.equal(f.saver.state().status, 'saved');
  f.saver.edit('skin', 'mint'); f.saver.edit('skin', 'star'); assert.equal(f.timers.size, 0);
  f.saver.dispose();
});
test('ordinary autosave never piggybacks spending or source drafts, including after success', async () => {
  const f = fixture();
  f.saver.edit('codexWarmupDaily', true); f.saver.edit('codexWarmupTime', '08:15'); f.saver.edit('codexAccountBackend', 'official'); f.saver.edit('multiAccountManagement', true);
  assert.equal(f.timers.size, 0);
  f.saver.edit('skin', 'mint'); await f.tick();
  assert.deepEqual(f.writes[0].patch, { skin: 'mint' }); assert.equal(f.saver.state().explicitDirty, true);
  assert.equal(f.saver.state().draft.codexWarmupDaily, true); assert.equal(f.saver.state().loaded.values.codexWarmupDaily, false);
  await f.saver.flush(); assert.equal(f.writes.length, 1);
  await f.saver.flush(true);
  assert.deepEqual(f.writes[1].patch, { codexAccountBackend: 'official', multiAccountManagement: true, codexWarmupDaily: true, codexWarmupTime: '08:15' });
  assert.equal(f.saver.state().explicitDirty, false); f.saver.dispose();
});
test('one in-flight write at a time; response reconciliation preserves same-key and cross-key edits', async () => {
  const pending = [];
  const f = fixture((patch, revision) => new Promise(resolve => pending.push({ patch, revision, resolve })));
  f.saver.edit('skin', 'mint'); await f.tick(); assert.equal(f.saver.state().status, 'saving');
  f.saver.edit('skin', 'star'); f.saver.edit('size', 'tiny');
  await f.saver.flush(true); assert.equal(f.writes.length, 1); assert.equal(f.timers.size, 0);
  pending[0].resolve({ revision: 'b'.repeat(64), values: { ...initial().values, skin: 'mint' } }); await turn();
  assert.equal(f.saver.state().draft.skin, 'star'); assert.equal(f.saver.state().draft.size, 'tiny'); assert.equal(f.timers.size, 1);
  await f.tick(); assert.equal(f.writes.length, 2); assert.deepEqual(f.writes[1].patch, { skin: 'star', size: 'tiny' }); assert.equal(f.writes[1].revision, 'b'.repeat(64));
  pending[1].resolve({ revision: 'c'.repeat(64), values: { ...initial().values, skin: 'star', size: 'tiny' } }); await turn();
  assert.equal(f.saver.state().status, 'saved'); assert.equal(f.receipts.length, 2); f.saver.dispose();
});
test('reverting to old baseline during a write is saved after that write, not erased', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.saver.edit('skin', 'mint'); await f.tick(); f.saver.edit('skin', initial().values.skin);
  finish({ revision: 'b'.repeat(64), values: { ...initial().values, skin: 'mint' } }); await turn();
  assert.equal(f.saver.state().draft.skin, initial().values.skin); assert.equal(f.timers.size, 1);
  f.saver.dispose();
});
test('explicit confirmation snapshots grants once; later authorization edits remain uncommitted', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.saver.edit('codexWarmupDaily', true); f.saver.edit('codexWarmupTime', '08:15');
  const save = f.saver.flush(true); f.saver.edit('codexWarmupTime', '09:30'); f.saver.edit('skin', 'mint');
  finish({ revision: 'b'.repeat(64), values: { ...initial().values, codexWarmupDaily: true, codexWarmupTime: '08:15' } }); await save;
  assert.equal(f.saver.state().draft.codexWarmupTime, '09:30'); assert.equal(f.saver.state().loaded.values.codexWarmupTime, '08:15');
  assert.equal(f.saver.state().explicitDirty, true); assert.equal(f.timers.size, 1); f.saver.dispose();
});
test('failure stops retries even after more edits; explicit retry sends only latest safe patch', async () => {
  let fail = true;
  const f = fixture(async patch => { if (fail) throw new Error('private backend details'); return { revision: 'b'.repeat(64), values: { ...initial().values, ...patch } }; });
  f.saver.edit('skin', 'mint'); await f.tick(); assert.equal(f.saver.state().status, 'error');
  assert(!f.saver.state().error.message.includes('private')); assert.equal(f.timers.size, 0);
  f.saver.edit('skin', 'star'); f.saver.edit('codexWarmupDaily', true); await f.tick();
  assert.equal(f.writes.length, 1); assert.equal(f.saver.state().draft.skin, 'star');
  fail = false; await f.saver.retry(); assert.deepEqual(f.writes[1].patch, { skin: 'star' });
  assert.equal(f.saver.state().explicitDirty, true); assert.equal(f.saver.state().status, 'saved'); f.saver.dispose();
});
test('409 requires explicit reload and cannot be bypassed by confirm/retry; load itself never writes', async () => {
  const f = fixture(async () => { const error = new Error('conflict'); error.status = 409; throw error; });
  f.saver.edit('skin', 'mint'); await f.tick(); assert.equal(f.saver.state().error.conflict, true);
  await f.saver.retry(); await f.saver.flush(true); f.saver.edit('skin', 'star'); await f.tick(); assert.equal(f.writes.length, 1);
  f.saver.load({ revision: 'b'.repeat(64), values: { ...initial().values, size: 'tiny' } });
  assert.equal(f.saver.state().status, 'saved'); assert.equal(f.saver.state().draft.skin, initial().values.skin); assert.equal(f.timers.size, 0); f.saver.dispose();
});
test('incomplete/out-of-range numeric fields stay local, then corrected input resumes debounce', async () => {
  const f = fixture();
  for (const value of ['', 0, 241, 1.5, NaN]) { f.saver.edit('sleepMinutes', value); assert.equal(f.saver.state().status, 'invalid'); await f.tick(); }
  assert.equal(f.writes.length, 0); f.saver.edit('sleepMinutes', 25); await f.tick(); assert.deepEqual(f.writes[0].patch, { sleepMinutes: 25 });
  f.saver.edit('codexQuotaRefreshSeconds', 3601); await f.tick(); assert.equal(f.writes.length, 1);
  f.saver.edit('codexWarmupTime', '99:99'); await f.saver.flush(true); assert.equal(f.writes.length, 1); f.saver.dispose();
});
test('discard/read pause cancels queued debounce; failed read remains paused until load', async () => {
  const f = fixture(); f.saver.edit('skin', 'mint'); f.saver.pause(); await f.tick(); assert.equal(f.writes.length, 0);
  f.saver.edit('skin', 'star'); await f.tick(); assert.equal(f.writes.length, 0); await f.saver.flush(true); assert.equal(f.writes.length, 0);
  f.saver.load(initial()); assert.equal(f.saver.state().status, 'saved'); f.saver.edit('skin', 'mint'); await f.tick(); assert.equal(f.writes.length, 1); f.saver.dispose();
});
test('fixing locally invalid input resumes debounce without resuming network/conflict failures',async()=>{
 const f=fixture();f.saver.edit('sleepMinutes','');await f.saver.flush(true);
 assert.equal(f.saver.state().status,'error');assert.equal(f.writes.length,0);
 f.saver.edit('sleepMinutes',25);assert.equal(f.saver.state().status,'waiting');assert.equal(f.timers.size,1);
 await f.tick();assert.deepEqual(f.writes[0].patch,{sleepMinutes:25});assert.equal(f.saver.state().status,'saved');f.saver.dispose();
});
test('unmount cancels timers and aborts in-flight request; late completion never publishes or queues', async () => {
  const idle = fixture(); idle.saver.edit('skin', 'mint'); idle.saver.dispose(); await idle.tick(); assert.equal(idle.writes.length, 0);
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; })); f.saver.edit('skin', 'mint'); await f.tick();
  f.saver.edit('skin', 'star'); f.saver.dispose(); assert.equal(f.writes[0].signal.aborted, true); const count = f.changes.length;
  finish({ revision: 'b'.repeat(64), values: { ...initial().values, skin: 'mint' } }); await turn();
  assert.equal(f.changes.length, count); assert.equal(f.receipts.length, 0); assert.equal(f.timers.size, 0); assert.equal(f.writes.length, 1);
});
