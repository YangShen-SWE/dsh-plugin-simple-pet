import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_PREFERENCES, preferenceValues, PreferencesStore } from './preferences.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const status = expected => error => { assert.equal(error.status, expected); return true; };
async function fixture(t, raw) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-preferences-test-'));
  const file = path.join(root, 'settings.json');
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('dsh-preferences-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  if (raw !== undefined) await fs.writeFile(file, typeof raw === 'string' || Buffer.isBuffer(raw) ? raw : JSON.stringify(raw));
  return { root, file, store: new PreferencesStore(file) };
}
async function unchanged(file, bytes, operation, expected = 400) {
  await assert.rejects(operation, status(expected));
  assert.deepEqual(await fs.readFile(file), bytes);
}

test('defaults are exact, frozen, fresh and do not expose unknown values', () => {
  assert.deepEqual(DEFAULT_PREFERENCES, {
    skin: 'default', cardTheme: 'default', unit: 'cny', size: 'medium', billingMode: 'deepseek', codexUnit: 'token',
    codexQuotaRefreshSeconds: 5, codexWarmupDaily: false, codexWarmupTime: '09:30',
    codexWarmupReset: false, codexWarmupStartup: false, sleepMinutes: 10,
  });
  assert.ok(Object.isFrozen(DEFAULT_PREFERENCES));
  for (const raw of [undefined, null, [], true, 5, 'night', { left: 1, top: 2, secret: 'private' }]) {
    assert.deepEqual(preferenceValues(raw), DEFAULT_PREFERENCES);
  }
  const values = preferenceValues(null); values.skin = 'night';
  assert.equal(preferenceValues(null).skin, 'default');
});

test('every exact enum is accepted and near matches fail closed', () => {
  const choices = { skin: ['default', 'night', 'snow', 'mint', 'cherry', 'star'], unit: ['cny', 'token'],
    size: ['tiny', 'small', 'medium', 'large'], billingMode: ['deepseek', 'codex'], codexUnit: ['token', 'percent'] };
  for (const [key, allowed] of Object.entries(choices)) {
    for (const value of allowed) assert.equal(preferenceValues({ [key]: value })[key], value);
    for (const value of [allowed[0].toUpperCase(), ` ${allowed[0]}`, `${allowed[0]} `, '', 'unknown', 0, {}, [], null]) {
      assert.equal(preferenceValues({ [key]: value })[key], DEFAULT_PREFERENCES[key]);
    }
  }
});

test('integer bounds are typed and inclusive with invalid values defaulted', () => {
  for (const [key, low, high] of [['codexQuotaRefreshSeconds', 1, 3600], ['sleepMinutes', 1, 240]]) {
    for (const value of [low, high, 42]) assert.equal(preferenceValues({ [key]: value })[key], value);
    for (const value of [low - 1, high + 1, 1.5, '1', NaN, Infinity, -Infinity, null, true, [], {}]) {
      assert.equal(preferenceValues({ [key]: value })[key], DEFAULT_PREFERENCES[key]);
    }
  }
});

test('strict booleans and exact HH:mm prevent accidental automatic warm-up', () => {
  for (const key of ['codexWarmupDaily', 'codexWarmupReset', 'codexWarmupStartup']) {
    for (const value of [true, false]) assert.equal(preferenceValues({ [key]: value, codexWarmupTime: '09:30' })[key], value);
    for (const value of ['true', 'false', 1, 0, null, {}, []]) assert.equal(preferenceValues({ [key]: value })[key], false);
  }
  for (const time of ['00:00', '09:30', '23:59']) {
    const values = preferenceValues({ codexWarmupTime: time, codexWarmupDaily: true });
    assert.equal(values.codexWarmupTime, time); assert.equal(values.codexWarmupDaily, true);
  }
  for (const time of [undefined, null, '9:30', '24:00', '09:60', '09:30\n', '09:30\r\n', ' 09:30', '09:30 ', '09:30:00', 930]) {
    const values = preferenceValues({ codexWarmupTime: time, codexWarmupDaily: true });
    assert.equal(values.codexWarmupTime, '09:30'); assert.equal(values.codexWarmupDaily, false);
  }
});

test('sanitization ignores inherited fields and does not invoke accessors', () => {
  const raw = Object.create({ skin: 'night', codexWarmupDaily: true, codexWarmupTime: '09:30' });
  Object.defineProperty(raw, 'codexWarmupReset', { get() { throw new Error('must not execute'); } });
  assert.deepEqual(preferenceValues(raw), DEFAULT_PREFERENCES);
});

test('missing reads do not create settings, directories or temp files', async t => {
  const f = await fixture(t);
  const store = new PreferencesStore(path.join(f.root, 'absent', 'settings.json'));
  assert.deepEqual(await store.read(), { values: DEFAULT_PREFERENCES, revision: 'missing' });
  assert.deepEqual(await store.read(), { values: DEFAULT_PREFERENCES, revision: 'missing' });
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('read returns only preferences and hashes exact original bytes', async t => {
  const text = '{ "skin": "night", "left": 99, "top": -2, "future": {"secret": true} }\n';
  const f = await fixture(t, text);
  assert.deepEqual(await f.store.read(), { values: { ...DEFAULT_PREFERENCES, skin: 'night' }, revision: hash(text) });
  assert.equal(await fs.readFile(f.file, 'utf8'), text);
  assert.deepEqual(await fs.readdir(f.root), ['settings.json']);
});

test('UTF-8 BOM is parsed but retained in the original byte revision', async t => {
  const bytes = Buffer.from('\uFEFF{ "skin": "snow", "codexWarmupTime": "23:59", "codexWarmupDaily": true }\r\n');
  const f = await fixture(t, bytes);
  const read = await f.store.read();
  assert.equal(read.values.skin, 'snow'); assert.equal(read.values.codexWarmupDaily, true);
  assert.equal(read.revision, hash(bytes));
  assert.notEqual(read.revision, hash(bytes.subarray(3)));
  const updated = await f.store.update({ size: 'large' }, read.revision);
  assert.equal(updated.values.skin, 'snow');
  assert.equal(updated.revision, hash(await fs.readFile(f.file)));
});

test('multi-field updates are atomic and preserve unknown fields and legacy position', async t => {
  const raw = JSON.parse('{"left":123,"top":-42,"future":{"nested":[1,2]},"__proto__":{"safe":true},"constructor":"legacy","skin":"night"}');
  const f = await fixture(t, raw);
  const before = await f.store.read();
  const patch = { skin: 'star', unit: 'token', size: 'tiny', billingMode: 'codex', codexUnit: 'percent',
    codexQuotaRefreshSeconds: 3600, codexWarmupDaily: true, codexWarmupTime: '00:00',
    codexWarmupReset: true, codexWarmupStartup: true, sleepMinutes: 240 };
  const after = await f.store.update(patch, before.revision);
  assert.deepEqual(after.values, patch);
  const saved = JSON.parse(await fs.readFile(f.file, 'utf8'));
  for (const key of ['left', 'top', 'future', '__proto__', 'constructor']) assert.deepEqual(saved[key], raw[key]);
  assert.equal(after.revision, hash(await fs.readFile(f.file)));
  assert.deepEqual(await f.store.read(), after);
  assert.deepEqual(await fs.readdir(f.root), ['settings.json']);
});

test('missing update creates defaults plus validated changes', async t => {
  const f = await fixture(t);
  const nested = path.join(f.root, 'nested', 'settings.json');
  const store = new PreferencesStore(nested);
  const result = await store.update({ skin: 'mint', codexWarmupDaily: true }, 'missing');
  assert.deepEqual(result.values, { ...DEFAULT_PREFERENCES, skin: 'mint', codexWarmupDaily: true });
  assert.deepEqual(await store.read(), result);
});

test('every enum and inclusive numeric endpoint is valid in patches', async t => {
  const f = await fixture(t);
  let revision = 'missing';
  const choices = { skin: ['default', 'night', 'snow', 'mint', 'cherry', 'star'], unit: ['cny', 'token'],
    size: ['tiny', 'small', 'medium', 'large'], billingMode: ['deepseek', 'codex'], codexUnit: ['token', 'percent'],
    codexQuotaRefreshSeconds: [1, 3600], sleepMinutes: [1, 240], codexWarmupReset: [true, false], codexWarmupStartup: [true, false] };
  for (const [key, values] of Object.entries(choices)) for (const value of values) {
    const result = await f.store.update({ [key]: value }, revision);
    assert.equal(result.values[key], value); revision = result.revision;
  }
});

test('invalid, unknown, prototype, inherited and accessor patches never write', async t => {
  const f = await fixture(t, { skin: 'night', left: 1 });
  const { revision } = await f.store.read(); const bytes = await fs.readFile(f.file);
  const invalid = [null, [], 'night', 2, true, { unknown: 1 }, { left: 2 }, { top: 2 },
    JSON.parse('{"__proto__":{"polluted":true}}'), { constructor: 'x' }, { prototype: {} },
    Object.create({ skin: 'snow' }), Object.assign(Object.create({ inherited: true }), { skin: 'snow' }),
    { [Symbol('skin')]: 'snow' }, Object.defineProperty({}, 'skin', { value: 'snow' }),
    Object.defineProperty({}, 'skin', { enumerable: true, get() { throw new Error('getter invoked'); } })];
  for (const key of Object.keys(DEFAULT_PREFERENCES)) for (const value of [null, [], {}, undefined]) invalid.push({ [key]: value });
  for (const key of ['codexQuotaRefreshSeconds', 'sleepMinutes']) {
    for (const value of ['5', 0, -1, 1.5, Infinity, NaN, key === 'sleepMinutes' ? 241 : 3601]) invalid.push({ [key]: value });
  }
  for (const key of ['codexWarmupDaily', 'codexWarmupReset', 'codexWarmupStartup']) {
    for (const value of [1, 0, 'true', 'false']) invalid.push({ [key]: value });
  }
  for (const time of ['9:30', '24:00', '09:60', '09:30\n', ' 09:30']) invalid.push({ codexWarmupTime: time });
  for (const key of ['skin', 'unit', 'size', 'billingMode', 'codexUnit']) invalid.push({ [key]: 'UNKNOWN' });
  for (const patch of invalid) await unchanged(f.file, bytes, f.store.update(patch, revision));
  assert.deepEqual(await fs.readdir(f.root), ['settings.json']);
  assert.equal({}.polluted, undefined);
});

test('null-prototype patches with own whitelisted fields are allowed', async t => {
  const f = await fixture(t);
  const patch = Object.assign(Object.create(null), { skin: 'snow' });
  assert.equal((await f.store.update(patch, 'missing')).values.skin, 'snow');
});

test('invalid multi-field and schedule changes cannot partially commit', async t => {
  const f = await fixture(t, { skin: 'night', codexWarmupDaily: true, codexWarmupTime: 'bad' });
  const { revision } = await f.store.read(); const bytes = await fs.readFile(f.file);
  await unchanged(f.file, bytes, f.store.update({ skin: 'star', sleepMinutes: '5' }, revision));
  await unchanged(f.file, bytes, f.store.update({ skin: 'star', codexWarmupDaily: true }, revision));
  await unchanged(f.file, bytes, f.store.update({ codexWarmupDaily: false, codexWarmupTime: 'bad' }, revision));
  const fixed = await f.store.update({ codexWarmupDaily: true, codexWarmupTime: '10:45' }, revision);
  assert.equal(fixed.values.codexWarmupDaily, true); assert.equal(fixed.values.codexWarmupTime, '10:45');
  const disabled = await f.store.update({ codexWarmupDaily: false }, fixed.revision);
  assert.equal(disabled.values.codexWarmupDaily, false);
});

test('missing or mistyped revision is rejected without creating directories', async t => {
  const f = await fixture(t);
  const store = new PreferencesStore(path.join(f.root, 'absent', 'settings.json'));
  for (const revision of [undefined, null, '', 1, {}, 'junk', 'A'.repeat(64), 'missing\n']) {
    await assert.rejects(store.update({ skin: 'star' }, revision), status(400));
  }
  await assert.rejects(store.update({ size: 'huge' }, 'missing'), status(400));
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('optimistic conflicts detect changes even across instances and raw-byte rewrites', async t => {
  const f = await fixture(t, { skin: 'night' });
  const second = new PreferencesStore(f.file);
  const original = await f.store.read();
  const next = await second.update({ unit: 'token' }, original.revision);
  const bytes = await fs.readFile(f.file);
  await unchanged(f.file, bytes, f.store.update({ skin: 'star' }, original.revision), 409);
  await unchanged(f.file, bytes, f.store.update({ skin: 'star' }, 'missing'), 409);
  await fs.writeFile(f.file, `${bytes.toString('utf8')} `);
  const reformatted = await fs.readFile(f.file);
  await unchanged(f.file, reformatted, second.update({ size: 'small' }, next.revision), 409);
  const current = await f.store.read();
  const deletedTarget = path.resolve(f.file);
  assert.equal(deletedTarget, path.join(f.root, 'settings.json'));
  await fs.unlink(deletedTarget);
  await assert.rejects(second.update({ size: 'large' }, current.revision), status(409));
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('concurrent stale writes share an absolute-file queue across instances', async t => {
  const f = await fixture(t);
  const alias = path.join(f.root, 'nested', '..', 'settings.json');
  const stores = [f.store, new PreferencesStore(alias), new PreferencesStore(f.file)];
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
    stores[index % stores.length].update({ sleepMinutes: index + 1 }, 'missing')));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results.filter(result => result.status === 'rejected')) assert.equal(result.reason.status, 409);
  const saved = await f.store.read(); assert.equal(saved.values.sleepMinutes, 1);
  const updated = await stores[1].update({ skin: 'star' }, saved.revision);
  assert.equal(updated.values.sleepMinutes, 1); assert.equal(updated.values.skin, 'star');
  assert.deepEqual(await fs.readdir(f.root), ['settings.json']);
});

test('malformed JSON and non-object roots are unavailable and never overwritten', async t => {
  const f = await fixture(t);
  for (const text of ['', '{broken', '\uFEFF{broken', 'null', '[]', 'true', '"string"', '42']) {
    await fs.writeFile(f.file, text); const bytes = await fs.readFile(f.file);
    await assert.rejects(f.store.read(), status(503));
    await unchanged(f.file, bytes, f.store.update({ skin: 'snow' }, hash(bytes)), 503);
    assert.deepEqual(await fs.readdir(f.root), ['settings.json']);
  }
  await fs.writeFile(f.file, '{}');
  assert.equal((await f.store.update({ skin: 'mint' }, hash('{}'))).values.skin, 'mint');
});

test('valid JSON with malformed fields is fail-closed and normalized safely on save', async t => {
  const raw = { skin: 'invalid', sleepMinutes: '10', codexWarmupDaily: true, codexWarmupTime: '24:00',
    codexWarmupReset: 'true', codexWarmupStartup: 1, left: 45, future: { enabled: true } };
  const f = await fixture(t, raw);
  const read = await f.store.read(); assert.deepEqual(read.values, DEFAULT_PREFERENCES);
  const saved = await f.store.update({ skin: 'cherry' }, read.revision);
  assert.equal(saved.values.codexWarmupDaily, false);
  const persisted = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.deepEqual(persisted.future, raw.future); assert.equal(persisted.left, 45);
  assert.equal(persisted.codexWarmupTime, '09:30');
});

test('atomic replacement writes UUID temp with 0600 and never truncates destination', async t => {
  const f = await fixture(t, { skin: 'night' });
  const before = await fs.readFile(f.file); const { revision } = await f.store.read();
  const writeFile = fs.writeFile.bind(fs), rename = fs.rename.bind(fs);
  let writes = 0, renames = 0;
  t.mock.method(fs, 'writeFile', async (temporary, bytes, options) => {
    writes++; assert.match(temporary, /\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/);
    assert.equal(path.dirname(temporary), f.root); assert.equal(options.mode, 0o600); assert.equal(options.flag, 'wx');
    assert.deepEqual(await fs.readFile(f.file), before);
    return writeFile(temporary, bytes, options);
  });
  t.mock.method(fs, 'rename', async (temporary, destination) => {
    renames++; assert.equal(destination, f.file); assert.deepEqual(await fs.readFile(destination), before);
    assert.equal(JSON.parse(await fs.readFile(temporary, 'utf8')).skin, 'snow');
    return rename(temporary, destination);
  });
  await f.store.update({ skin: 'snow' }, revision);
  assert.equal(writes, 1); assert.equal(renames, 1);
  assert.deepEqual(await fs.readdir(f.root), ['settings.json']);
});

test('rename failure cleans up temporary file and preserves destination', async t => {
  const f = await fixture(t, { skin: 'night' });
  const { revision } = await f.store.read(); const bytes = await fs.readFile(f.file);
  t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('simulated rename failure'), { code: 'EACCES' }); });
  await unchanged(f.file, bytes, f.store.update({ skin: 'snow' }, revision), 503);
  assert.deepEqual(await fs.readdir(f.root), ['settings.json']);
  t.mock.restoreAll();
  assert.equal((await f.store.update({ skin: 'snow' }, revision)).values.skin, 'snow');
});

test('partial write failure cleans up temporary file and preserves destination', async t => {
  const f = await fixture(t, { skin: 'night' });
  const { revision } = await f.store.read(); const bytes = await fs.readFile(f.file);
  const writeFile = fs.writeFile.bind(fs);
  t.mock.method(fs, 'writeFile', async (temporary, _bytes, options) => {
    await writeFile(temporary, 'partial', options);
    throw Object.assign(new Error('simulated partial write failure'), { code: 'ENOSPC' });
  });
  await unchanged(f.file, bytes, f.store.update({ skin: 'snow' }, revision), 503);
  assert.deepEqual(await fs.readdir(f.root), ['settings.json']);
});

test('polluted Object.prototype cannot supply preferences or inherited patch keys', async t => {
  const f = await fixture(t);
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'codexWarmupReset');
  try {
    Object.defineProperty(Object.prototype, 'codexWarmupReset', {
      value: { value: true }, enumerable: true, configurable: true, writable: true,
    });
    assert.deepEqual(preferenceValues({}), DEFAULT_PREFERENCES);
    await assert.rejects(f.store.update({ skin: 'night' }, 'missing'), status(400));
  } finally {
    if (previous) Object.defineProperty(Object.prototype, 'codexWarmupReset', previous);
    else delete Object.prototype.codexWarmupReset;
  }
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('I/O read failures are 503 and a failed queue operation does not poison later reads', async t => {
  const f = await fixture(t, { skin: 'night' });
  t.mock.method(fs, 'readFile', async () => { throw Object.assign(new Error('simulated private error'), { code: 'EACCES' }); });
  await assert.rejects(f.store.read(), status(503));
  await assert.rejects(f.store.update({ skin: 'snow' }, 'missing'), status(503));
  t.mock.restoreAll();
  assert.equal((await f.store.read()).values.skin, 'night');
});
