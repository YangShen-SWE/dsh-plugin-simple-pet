import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { preferencesHandler } from './preferences-route.js';

function invoke(handler, method = 'GET', body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
  req.method = method; req.headers = headers;
  const result = { status: 0, headers: null, data: undefined };
  const res = { writeHead(status, h) { result.status = status; result.headers = h; }, end(data) { result.data = data === undefined ? undefined : JSON.parse(data); } };
  return handler(req, res).then(() => result);
}
const revision = 'a'.repeat(64);
const values = { size: 'medium', codexWarmupDaily: false };
const json = { 'content-type': 'application/json; charset=utf-8' };

test('native settings reads and HEAD are no-store and do not write or invoke upstream APIs', async () => {
  let reads = 0;
  const handler = preferencesHandler({ async read() { reads++; return { values, revision }; }, update() { throw new Error('unexpected write'); } }, () => true);
  const result = await invoke(handler);
  assert.equal(result.status, 200); assert.deepEqual(result.data.values, values); assert.equal(result.data.revision, revision);
  assert.equal(typeof result.data.timeZone, 'string'); assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal((await invoke(handler, 'HEAD')).data, undefined); assert.equal(reads, 2);
});
test('authorization runs before reading any preferences or request body', async () => {
  const handler = preferencesHandler({ read() { throw new Error('unexpected read'); }, update() { throw new Error('unexpected write'); } }, (_req, res) => { res.writeHead(403, {}); res.end(JSON.stringify({ denied: true })); return false; });
  const result = await invoke(handler, 'PUT', '{not json', json);
  assert.equal(result.status, 403); assert.equal(result.data.denied, true);
});
test('strict PUT passes only validated envelope arguments to the store', async () => {
  let seen;
  const handler = preferencesHandler({ async update(patch, expected) { seen = [patch, expected]; return { values: { size: 'tiny' }, revision }; } }, () => true);
  const result = await invoke(handler, 'PUT', { patch: { size: 'tiny' }, revision }, json);
  assert.equal(result.status, 200); assert.deepEqual(seen, [{ size: 'tiny' }, revision]);
  assert.equal(result.data.values.size, 'tiny');
});
test('bad methods, MIME types, JSON and extra envelope fields cannot mutate settings', async () => {
  const handler = preferencesHandler({ update() { throw new Error('unexpected write'); } }, () => true);
  for (const [method, body, headers, status] of [
    ['POST', {}, json, 405], ['DELETE', {}, json, 405], ['OPTIONS', undefined, {}, 405],
    ['PUT', {}, {}, 415], ['PUT', {}, { 'content-type': 'text/plain' }, 415],
    ['PUT', '{broken', json, 400], ['PUT', null, json, 400], ['PUT', [], json, 400],
    ['PUT', { patch: {}, revision, credentials: {} }, json, 400],
  ]) assert.equal((await invoke(handler, method, body, headers)).status, status);
});
test('request body bounds reject both declared and chunked oversized payloads', async () => {
  const handler = preferencesHandler({ update() { throw new Error('unexpected write'); } }, () => true);
  assert.equal((await invoke(handler, 'PUT', '{}', { ...json, 'content-length': '8193' })).status, 413);
  assert.equal((await invoke(handler, 'PUT', '{}', { ...json, 'content-length': '-1' })).status, 413);
  assert.equal((await invoke(handler, 'PUT', 'x'.repeat(8193), json)).status, 413);
});
test('conflicts, validation and storage errors stay typed and never expose paths or secrets', async () => {
  for (const status of [400, 409, 503, undefined]) {
    const handler = preferencesHandler({ async update() { throw Object.assign(new Error('SECRET file C:/private-account'), { status }); } }, () => true);
    const result = await invoke(handler, 'PUT', { patch: {}, revision }, json);
    assert.equal(result.status, status ?? 503); assert.doesNotMatch(result.data.error, /SECRET|private-account/);
  }
});
