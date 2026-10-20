import test from 'node:test';
import assert from 'node:assert/strict';
import { withSpeedPreference, accountSpeedModes } from './codex-accounts/request-preferences.js';
import { validModelSettings } from './codex-accounts/model-catalogue.js';
for (const method of ['stream','streamSimple']) for (const mode of ['standard','fast']) {
  test(`${method} captures ${mode} after all payload callbacks`, async () => {
    let captured;
    const provider = {[method]: async (model, context, options) => { captured=options; return options.onPayload({reasoning:{effort:'high'}, service_tier:'ultrafast'},model); }};
    const wrapped=withSpeedPreference(provider,mode);
    const payload=await wrapped[method]({}, {}, {serviceTier:'ultrafast', onPayload:p=>({...p,service_tier:'untrusted',foo:true})});
    assert.equal(payload.service_tier,mode==='fast'?'priority':undefined);
    assert.equal(captured.serviceTier,mode==='fast'?'priority':undefined);
    assert.equal(payload.reasoning.effort,'high');assert.equal(payload.foo,true);
  });
}
test('speed is explicitly advertised, never inferred from slug or builtin',()=>{
  for(const row of [{},{id:'gpt-6.1-sol'},{service_tiers:['priority']},{additional_speed_tiers:['ultrafast']}])assert.deepEqual(accountSpeedModes(row),['standard']);
  assert.deepEqual(accountSpeedModes({service_tiers:[{id:'priority'}]}),['standard','fast']);
  assert.deepEqual(accountSpeedModes({additional_speed_tiers:['fast']}),['standard','fast']);
});
test('legacy model preferences remain accepted and arbitrary speed denied',()=>{
  const base={enabled:null,defaultModel:null,reasoningEffort:null};
  assert.ok(validModelSettings(base));assert.ok(validModelSettings({...base,speedMode:'standard'}));
  assert.equal(validModelSettings({...base,speedMode:'ultrafast'}),false);
  assert.throws(()=>withSpeedPreference({},'ultrafast'),/SPEED_UNAVAILABLE/);
});
test('concurrent prepared providers do not share speed state',async()=>{
  const provider={streamSimple:async(m,c,o)=>o.onPayload({model:m.id})};
  const a=withSpeedPreference(provider,'fast'), b=withSpeedPreference(provider,'standard');
  const [one,two]=await Promise.all([a.streamSimple({id:'a'},{}),b.streamSimple({id:'b'},{})]);
  assert.equal(one.service_tier,'priority');assert.equal(two.service_tier,undefined);
});
