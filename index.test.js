import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { apply } from './index.js';

test('only live official DeepSeek events enter the protected route', async () => {
  const previousDataDir = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = join(import.meta.dirname, 'work', `test-runtime-${process.pid}`);
  const handlers = new Map();
  const listeners = new Map();
  const disposers = [];
  const ctx = {
    on(name, fn) { listeners.set(name, fn); },
    effect(fn) { disposers.push(fn()); },
    inject(_services, fn) { fn({
      webServer: { register({ path, handler }) { handlers.set(path, handler); return () => handlers.delete(path); } },
      connection: { requestRejection(req) { return req.headers.authorization === 'test' ? undefined : 401; } },
      effect(fn) { disposers.push(fn()); },
    }); },
    llm: { listConfigurableProviders() { return []; } },
    settings: { describe() { return []; } },
  };
  let petStarted = false;
  let petStopped = false;
  apply(ctx, { petLauncher({ profile }) {
    assert.equal(profile, 'desktop');
    petStarted = true;
    return () => { petStopped = true; };
  } });
  assert.equal(petStarted, true);
  const emit = listeners.get('session/event');
  const makeEvent = (seq, provider) => ({ seq, type:'assistant/message', time:'2026-09-29T01:00:00Z', data:{
    message:{ source:{ kind:'model', provider, model:'deepseek-v4-flash' } },
    usage:{ inputTokens:100,cacheReadTokens:200,outputTokens:300 },
  } });
  const session = { id:'s1',firstLiveSeq:2 };
  emit(session,makeEvent(1,'deepseek-official'));
  emit(session,makeEvent(2,'other'));
  emit(session,makeEvent(3,'deepseek-official'));
  emit(session,makeEvent(3,'deepseek-official'));
  emit(session,makeEvent(4,'deepseek-official'));
  const handler = handlers.get('/api/dsh-plugin-simple-pet/state');
  function request(auth) {
    const result = { code:null, body:'' };
    const res = { writeHead(code) { result.code=code; }, end(body) { result.body=body ?? ''; } };
    handler({ method:'GET',url:'/api/dsh-plugin-simple-pet/state?since=0',headers:{authorization:auth} },res);
    return result;
  }
  assert.equal(request('').code,401);
  const response = request('test');
  assert.equal(response.code,200);
  const payload = JSON.parse(response.body);
  assert.deepEqual(payload.events.map(e=>e.kind),['hit','miss','output','hit','miss','output','combo']);
  assert.equal(payload.cacheHitRate,2/3);
  const today = new Date('2026-09-29T01:00:00Z');
  const dayKey = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  assert.equal(payload.stats.days[dayKey].tokens, 1200);
  for (const dispose of disposers.reverse()) dispose?.();
  assert.equal(petStopped, true);
  if (previousDataDir === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = previousDataDir;
});
