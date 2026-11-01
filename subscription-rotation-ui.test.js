import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Offline synthetic hook host executes the shipped component, not a copy.
const source = await fs.readFile(new URL('./vendor/codex-subscription/lib/client.js', import.meta.url), 'utf8');
const region = source.split('//#region src/client-rotation.jsx')[1]?.split('//#endregion')[0];
assert.ok(region);
const ids = ['balanced', 'most-remaining', 'low-tier-first', 'high-tier-first', 'reset-soon'];
const account = (key, generation = 1, usage = {}) => ({ accountKey: key, accountGeneration: generation, label: key, active: key === 'a', usage: { status: 'unknown', ...usage } });
const status = (patch = {}) => ({ config: { enabled: false, strategy: 'balanced', reservePercent: 0, accounts: [] }, strategies: ids.map(id => ({ id, label: id, description: id })), accounts: [account('a'), account('b')], busy: false, ...patch });
const ok = value => ({ ok: true, value });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(handler = async () => ok(status())) {
  let index = 0, dirty = false, tree, current, disposed = false, lateWrites = 0;
  const cells = [], effects = [], calls = [];
  const react = {
    useState(initial) { const i = index++; if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial; return [cells[i], next => { if (disposed) lateWrites++; const value = typeof next === 'function' ? next(cells[i]) : next; if (!Object.is(cells[i], value)) { cells[i] = value; dirty = true; } }]; },
    useRef(initial) { return cells[index++] ??= { current: initial }; },
    useEffect(run, deps) { const i = index++, old = cells[i]; if (!old || deps.some((value, j) => !Object.is(value, old.deps[j]))) effects.push(() => { old?.cleanup?.(); const entry = { deps }; cells[i] = entry; entry.cleanup = run(); }); }
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const sandbox = { react, react_jsx_runtime: { jsx, jsxs: jsx }, Button: 'button', CHANNEL: '/codex-subscription', percent: String,
    validDate: value => { const d = new Date(value); return Number.isFinite(d.getTime()) ? d : undefined; },
    unwrap: response => { if (!response?.ok) throw new Error('SYNTHETIC_RPC_FAILURE'); return response.value; },
    fetch() { throw new Error('NETWORK_FORBIDDEN'); }, setInterval() { throw new Error('POLLING_FORBIDDEN'); }, setTimeout() { throw new Error('TIMERS_FORBIDDEN'); }
  };
  const RotationSettings = vm.runInNewContext(`${region}\n;RotationSettings`, sandbox);
  current = { t: key => key, rpc: { call(channel, endpoint, payload) { calls.push({ channel, endpoint, payload: JSON.parse(JSON.stringify(payload)) }); return handler(endpoint, payload); } }, accountRevision: 0 };
  const render = (patch = {}) => { current = { ...current, ...patch }; let n = 0; do { dirty = false; index = 0; tree = RotationSettings(current); for (const effect of effects.splice(0)) effect(); assert.ok(++n < 30); } while (dirty); return tree; };
  render();
  return { render, calls, get tree() { return tree; }, get lateWrites() { return lateWrites; }, async settle() { await tick(); return render(); }, dispose() { for (const cell of cells) cell?.cleanup?.(); disposed = true; } };
}
function nodes(tree, predicate) { const found = []; function visit(value) { if (Array.isArray(value)) return value.forEach(visit); if (!value || typeof value !== 'object') return; if (predicate(value)) found.push(value); visit(value.props?.children); } visit(tree); return found; }
function text(tree) { if (Array.isArray(tree)) return tree.map(text).join(' '); if (tree == null || typeof tree === 'boolean') return ''; if (typeof tree !== 'object') return String(tree); return text(tree.props?.children); }
const inputs = f => nodes(f.tree, n => n.type === 'input');
const button = (f, label) => nodes(f.tree, n => n.type === 'button' && text(n) === label)[0];
const click = node => { assert.ok(node); assert.notEqual(node.props.disabled, true); return node.props.onClick(); };
const toggle = (f, label, checked) => { const node = nodes(f.tree, n => n.type === 'label' && text(n).includes(label))[0]; assert.ok(node); nodes(node, n => n.type === 'input')[0].props.onChange({ target: { checked } }); f.render(); };
function authorize(f) { toggle(f, 'rotationEnabled', true); toggle(f, 'a ', true); toggle(f, 'b ', true); toggle(f, 'rotationConsent', true); }

test('initial mount is local status only, defaults are off, five presets and mount exist', async () => {
  const f = fixture(); await f.settle();
  assert.deepEqual(f.calls, [{ channel: '/codex-subscription', endpoint: 'rotation/status', payload: {} }]);
  assert.equal(inputs(f)[0].props.checked, false);
  assert.equal(nodes(f.tree, n => n.type === 'select')[0].props.value, 'balanced');
  assert.deepEqual(nodes(f.tree, n => n.type === 'option').map(n => n.props.value), ids);
  assert.match(source, /jsx\)\(RotationSettings, \{ rpc, t, accountRevision: resetKey \}\)/);
  const contract = source.split('//#region src/rpc-contract.js')[1].split('//#endregion')[0];
  const client = vm.runInNewContext(`${contract};createSubscriptionRpcClient`, {});
  const routes = []; const rpc = client({ call(...args) { routes.push(args); } });
  for (const endpoint of ['rotation/status', 'rotation/refresh', 'rotation/update']) rpc.call('/codex-subscription', endpoint, {});
  assert.equal(routes.length, 3); assert.equal(routes[0][1], 'codex-subscription/rotation/status');
  assert.throws(() => rpc.call('/wrong', 'rotation/status', {}));
  f.dispose();
});

test('one selected account cannot authorize and real epoch-second reset dates are not shown as 1970', async () => {
  const reset = 1800000600;
  const f = fixture(async () => ok(status({ accounts: [account('a', 1, { status: 'ready', remainingPercent: 50, resetsAt: reset }), account('b')] })));
  await f.settle(); toggle(f, 'rotationEnabled', true); toggle(f, 'a ', true); toggle(f, 'rotationConsent', true);
  assert.equal(button(f, 'rotationSave').props.disabled, true);
  button(f, 'rotationSave').props.onClick(); await f.settle();
  assert.equal(f.calls.length, 1);
  assert.ok(text(f.tree).includes(new Date(reset * 1000).toLocaleString()));
  f.dispose();
});

test('all edits are local; explicit consent + save authorizes only exact account generations', async () => {
  const f = fixture(async endpoint => ok(status())); await f.settle(); authorize(f);
  assert.equal(f.calls.length, 1);
  click(button(f, 'rotationSave')); await f.settle();
  assert.deepEqual(f.calls[1].payload, { enabled: true, strategy: 'balanced', reservePercent: 0, accounts: [{ accountKey: 'a', accountGeneration: 1 }, { accountKey: 'b', accountGeneration: 1 }], acknowledged: true });
  assert.equal(f.calls[1].endpoint, 'rotation/update');
  assert.equal(inputs(f).at(-1).props.checked, false);
});

test('refresh is explicit, read-only, single-flight and preserves draft/consent', async () => {
  const wait = deferred(); const f = fixture(endpoint => endpoint === 'rotation/refresh' ? wait.promise : Promise.resolve(ok(status()))); await f.settle(); authorize(f);
  const refresh = button(f, 'rotationRefresh'); click(refresh); refresh.props.onClick(); button(f, 'rotationSave').props.onClick();
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[1].payload, {});
  wait.resolve(ok(status({ config: { enabled: false, strategy: 'high-tier-first', reservePercent: 90, accounts: [] } }))); await f.settle();
  assert.equal(inputs(f)[0].props.checked, true); assert.equal(inputs(f).at(-1).props.checked, true);
  assert.equal(nodes(f.tree, n => n.type === 'select')[0].props.value, 'balanced');
  assert.equal(f.calls.filter(c => c.endpoint === 'rotation/update').length, 0);
});

test('save single-flight and delayed success cannot replace a newer draft', async () => {
  const wait = deferred(); const f = fixture(endpoint => endpoint === 'rotation/update' ? wait.promise : Promise.resolve(ok(status()))); await f.settle(); authorize(f);
  const save = button(f, 'rotationSave'); click(save); save.props.onClick(); button(f, 'rotationRefresh').props.onClick();
  assert.equal(f.calls.length, 2);
  const reserve = inputs(f).find(n => n.props.type === 'number'); reserve.props.onChange({ target: { value: '45' } }); f.render();
  wait.resolve(ok(status({ config: { enabled: true, strategy: 'balanced', reservePercent: 0, accounts: [{ accountKey: 'a', accountGeneration: 1 }] } }))); await f.settle();
  assert.equal(inputs(f).find(n => n.props.type === 'number').props.value, '45');
  assert.equal(inputs(f).at(-1).props.checked, false);
});

test('rebound/new accounts are not automatically admitted; stale refs are omitted at save', async () => {
  const saved = { enabled: true, strategy: 'balanced', reservePercent: 10, accounts: [{ accountKey: 'a', accountGeneration: 1 }] };
  const f = fixture(async endpoint => ok(status({ config: saved, accounts: [account('a', endpoint === 'rotation/status' ? 1 : 2), account('new', 1)] }))); await f.settle();
  click(button(f, 'rotationRefresh')); await f.settle();
  const boxes = inputs(f).filter(n => n.props.type === 'checkbox'); assert.equal(boxes[1].props.checked, false); assert.equal(boxes[2].props.checked, false);
  assert.equal(button(f, 'rotationSave').props.disabled, true);
  toggle(f, 'a ', true); toggle(f, 'new ', true); toggle(f, 'rotationConsent', true); click(button(f, 'rotationSave')); await f.settle();
  assert.deepEqual(f.calls.at(-1).payload.accounts, [{ accountKey: 'a', accountGeneration: 2 }, { accountKey: 'new', accountGeneration: 1 }]);
});

test('disable and save revokes without requiring enabling consent', async () => {
  const f = fixture(async () => ok(status({ config: { enabled: true, strategy: 'balanced', reservePercent: 0, accounts: [{ accountKey: 'a', accountGeneration: 1 }] } }))); await f.settle();
  toggle(f, 'rotationEnabled', false); assert.equal(f.calls.length, 1);
  click(button(f, 'rotationRevoke')); await f.settle();
  assert.equal(f.calls[1].payload.enabled, false); assert.equal(f.calls[1].payload.acknowledged, true);
});

for (const value of ['', '-1', '91', 'NaN', '1.5']) test(`reserve rejects invalid value ${JSON.stringify(value)}`, async () => {
  const f = fixture(); await f.settle(); authorize(f);
  inputs(f).find(n => n.props.type === 'number').props.onChange({ target: { value } }); f.render(); toggle(f, 'rotationConsent', true);
  assert.equal(button(f, 'rotationSave').props.disabled, true); button(f, 'rotationSave').props.onClick();
  assert.equal(f.calls.length, 1);
});

test('actual plan, unknown plan, lowest remaining including zero, and freshness are distinct', async () => {
  const f = fixture(async () => ok(status({ accounts: [account('a', 1, { planType: 'team', remainingPercent: 0, fetchedAt: 1800000000000 }), account('b')] }))); await f.settle();
  assert.match(text(f.tree), /rotationPlan: team/); assert.match(text(f.tree), /rotationRemaining: 0%/);
  assert.match(text(f.tree), /rotationPlan: rotationUnknown/); assert.match(text(f.tree), /rotationFetched: rotationUnknown/);
  assert.doesNotMatch(text(f.tree), /Plus|Free/);
});

test('unmount ignores late responses and account revision invalidates old status', async () => {
  const old = deferred(), newer = deferred(); let n = 0;
  const f = fixture(() => ++n === 1 ? old.promise : newer.promise);
  f.render({ accountRevision: 1 }); newer.resolve(ok(status({ accounts: [account('new')] }))); await f.settle();
  old.resolve(ok(status({ accounts: [account('old')] }))); await f.settle();
  assert.match(text(f.tree), /new /); assert.doesNotMatch(text(f.tree), /old /);
  const pending = deferred(); const g = fixture(() => pending.promise); g.dispose(); pending.resolve(ok(status())); await tick();
  assert.equal(g.lateWrites, 0);
});

test('RPC errors are generic and retry remains possible without enabling rotation', async () => {
  let n = 0; const f = fixture(async () => { if (++n === 1) throw new Error('private detail never shown'); return ok(status()); }); await f.settle();
  assert.match(text(f.tree), /rotationFailed/); assert.doesNotMatch(text(f.tree), /private detail/);
  click(button(f, 'rotationRefresh')); await f.settle();
  assert.equal(inputs(f)[0].props.checked, false); assert.deepEqual(f.calls.map(c => c.endpoint), ['rotation/status', 'rotation/refresh']);
});

test('consent is required for every changed authorization and reserve 90 is accepted', async () => {
  const f = fixture(); await f.settle();
  toggle(f, 'rotationEnabled', true); toggle(f, 'a ', true); toggle(f, 'b ', true);
  assert.equal(button(f, 'rotationSave').props.disabled, true);
  button(f, 'rotationSave').props.onClick(); assert.equal(f.calls.length, 1);
  toggle(f, 'rotationConsent', true);
  inputs(f).find(n => n.props.type === 'number').props.onChange({ target: { value: '90' } }); f.render();
  assert.equal(inputs(f).at(-1).props.checked, false);
  toggle(f, 'rotationConsent', true); click(button(f, 'rotationSave')); await f.settle();
  assert.equal(f.calls[1].payload.reservePercent, 90);
});

test('entire shipped client remains syntactically valid without executing host code', () => {
  assert.doesNotThrow(() => new vm.Script(source));
});

test('both locale dictionaries contain every literal rotation key', () => {
  const locale = source.split('//#region src/client-locales.js')[1].split('//#endregion')[0];
  const dictionaries = vm.runInNewContext(`${locale};({zh,en})`, {});
  const keys = new Set([...region.matchAll(/\b(?:t\(|setMessage\()"(rotation[^"`]+)"/g)].map(m => m[1]));
  for (const id of ids) { keys.add(`rotationStrategy_${id}`); keys.add(`rotationDescription_${id}`); }
  for (const lang of ['zh', 'en']) for (const key of keys) assert.equal(typeof dictionaries[lang][key], 'string', `${lang}:${key}`);
});
