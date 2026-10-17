import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimplePetClient } from './client-source.js';
import { DEFAULT_PREFERENCES } from './preferences.js';
const A = 'a'.repeat(16), B = 'b'.repeat(16), settle = () => new Promise(resolve => setImmediate(resolve));
function harness(send) {
  const cells = [], cleanups = []; let index = 0, tree;
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat().filter(value => value !== false && value != null) }; },
    useState(initial) { const n = index++; if (!(n in cells)) cells[n] = initial; return [cells[n], value => { cells[n] = typeof value === 'function' ? value(cells[n]) : value; }]; },
    useRef(initial) { return cells[index++] ??= { current: initial }; },
    useEffect(fn) { const n = index++; if (!(n in cells)) { cells[n] = true; cleanups.push(fn()); } },
  };
  const client = createSimplePetClient(React, send), render = () => { index = 0; return tree = client.SimplePetSettings(); };
  const nodes = (node = tree) => node && typeof node === 'object' ? [node, ...node.children.flatMap(nodes)] : [];
  const text = (node = tree) => node && typeof node === 'object' ? node.children.map(text).join('') : String(node ?? ''); render();
  return { render, nodes, text, find: (attribute, value) => nodes().find(node => node.props[attribute] !== undefined && (value === undefined || node.props[attribute] === value)), cleanup() { for (const fn of cleanups.splice(0)) fn?.(); } };
}
function fixture(t, hooks = {}) {
  const state = { gets: 0, catalogue: { generation: 1, defaultKey: A, busy: false, capabilities: { models: true }, accounts: [
    { accountKey: A, label: '合成工作账号', epoch: 1, bound: true, credentialStatus: 'available', selected: true },
    { accountKey: B, label: '合成备用账号', epoch: 1, bound: true, credentialStatus: 'available', selected: false },
  ] } }, calls = [];
  const ui = harness(async (url, init = {}) => {
    calls.push({ url, ...init });
    if (url.endsWith('/preferences')) return Response.json({ values: { ...DEFAULT_PREFERENCES, billingMode: 'codex', codexAccountBackend: 'official' }, revision: 'r' });
    if (!url.endsWith('/official-accounts')) return Response.json({});
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      if (hooks.post) { const response = await hooks.post(body, state); if (response) return response; }
      if (body.action === 'account.remove') {
        assert.equal(body.expectedGeneration, state.catalogue.generation);
        state.catalogue = { ...state.catalogue, generation: state.catalogue.generation + 1, defaultKey: state.catalogue.defaultKey === body.accountKey ? null : state.catalogue.defaultKey, accounts: state.catalogue.accounts.filter(row => row.accountKey !== body.accountKey) };
      }
      if (body.action === 'account.select') state.catalogue = { ...state.catalogue, generation: state.catalogue.generation + 1, defaultKey: body.accountKey, accounts: state.catalogue.accounts.map(row => ({ ...row, selected: row.accountKey === body.accountKey })) };
      return Response.json({ ok: true });
    }
    state.gets++;
    if (hooks.get) { const response = await hooks.get(state); if (response) return response; }
    return Response.json(state.catalogue);
  });
  t.after(() => ui.cleanup());
  const posts = () => calls.filter(call => call.url.endsWith('/official-accounts') && call.method === 'POST').map(call => JSON.parse(call.body));
  const click = async (attribute, value) => { const node = ui.find(attribute, value); assert(node, attribute); assert.notEqual(node.props.disabled, true, attribute + ' disabled'); node.props.onClick(); await settle(); await settle(); ui.render(); };
  const ready = async () => { await settle(); ui.render(); ui.nodes().find(node => node.props['data-pet-tab'] === 'accounts').props.onClick(); ui.render(); await click('data-official-read'); };
  return { ui, state, calls, posts, click, ready };
}

test('local account error preserves both rows and healthy account operations without an automatic retry', async t => {
  const f = fixture(t, { post: body => body.action === 'quota.read' ? Response.json({ error: '此账号的本地授权不可读。', code: 'OAUTH_REQUIRED' }, { status: 409 }) : undefined });
  await f.ready(); await f.click('data-official-quota', A);
  assert(f.ui.find('data-official-account-row', A)); assert(f.ui.find('data-official-account-row', B));
  assert(f.ui.find('data-official-row-error', A)); assert(!f.ui.find('data-official-stale-directory'));
  assert.equal(f.ui.find('data-official-select', B).props.disabled, false); assert.equal(f.state.gets, 1); assert.equal(f.posts().length, 1);
  await f.click('data-official-select', B); assert.equal(f.state.catalogue.defaultKey, B);
  assert(!f.posts().some(body => /warmup|stream|responses/.test(body.action)));
});

test('global directory failure retains only a clearly stale read-only snapshot and revokes captured writes', async t => {
  let broken = false;
  const f = fixture(t, { get: () => broken ? Response.json({ error: '账号目录暂不可读。', code: 'DIRECTORY_UNAVAILABLE' }, { status: 503 }) : undefined });
  await f.ready(); const oldSelect = f.ui.find('data-official-select', B).props.onClick;
  broken = true; await f.click('data-official-read');
  assert(f.ui.find('data-official-account-row', B)); assert(f.ui.find('data-official-stale-directory')); assert.match(f.ui.text(), /上次读取.*不代表重新验证/);
  for (const attribute of ['data-official-select', 'data-official-quota', 'data-official-remove', 'data-official-models-open']) assert.equal(f.ui.find(attribute, B).props.disabled, true);
  assert.equal(f.ui.find('data-official-add').props.disabled, true); oldSelect(); await settle(); assert.equal(f.posts().length, 0);
  broken = false; await f.click('data-official-read'); assert(!f.ui.find('data-official-stale-directory')); assert.equal(f.ui.find('data-official-select', B).props.disabled, false);
});

test('first remove click, cancel and Escape do not submit; cancellation restores focus to the target', async t => {
  const f = fixture(t); await f.ready(); let focused = 0;
  f.ui.find('data-official-remove', A).props.onClick({ currentTarget: { focus() { focused++; } } }); f.ui.render();
  assert.equal(f.posts().length, 0); assert(f.ui.find('data-official-remove-prompt', A));
  assert.match(f.ui.text(f.ui.find('data-official-remove-prompt')), /合成工作账号 #aaaaaaaa.*本服务默认/);
  assert.equal(f.ui.find('data-official-remove-cancel').props.autoFocus, true); assert.notEqual(f.ui.find('data-official-remove-confirm').props.autoFocus, true);
  await f.click('data-official-remove-cancel', A); assert.equal(f.posts().length, 0); assert.equal(focused, 1);
  await f.click('data-official-remove', B); let prevented = false;
  f.ui.find('data-official-remove-prompt', B).props.onKeyDown({ key: 'Escape', preventDefault() { prevented = true; } }); f.ui.render();
  assert(prevented); assert(!f.ui.find('data-official-remove-prompt')); assert.equal(f.posts().length, 0);
  assert.match(f.ui.find('data-official-remove', B).props['aria-label'], /合成备用账号 #bbbbbbbb/);
});

test('confirming removal twice dispatches exactly once with the captured generation and does not choose B', async t => {
  const f = fixture(t); await f.ready(); await f.click('data-official-remove', A);
  const confirm = f.ui.find('data-official-remove-confirm', A).props.onClick; confirm(); confirm(); await settle(); await settle(); f.ui.render();
  assert.deepEqual(f.posts(), [{ action: 'account.remove', accountKey: A, expectedGeneration: 1 }]);
  assert(!f.ui.find('data-official-account-row', A)); assert(f.ui.find('data-official-account-row', B)); assert.equal(f.state.catalogue.defaultKey, null); assert.match(f.ui.text(), /确认本地绑定移除/);
});

test('a refreshed generation or replaced target invalidates the old confirmation instead of retargeting it', async t => {
  const f = fixture(t); await f.ready(); await f.click('data-official-remove', A);
  const oldConfirm = f.ui.find('data-official-remove-confirm').props.onClick;
  f.state.catalogue = { ...f.state.catalogue, generation: 2, accounts: f.state.catalogue.accounts.map(row => row.accountKey === A ? { ...row, label: '新绑定', epoch: 2 } : row) };
  await f.click('data-official-read'); assert(!f.ui.find('data-official-remove-prompt'));
  oldConfirm(); await settle(); assert.equal(f.posts().length, 0);
});

for (const mode of ['backend-ABA', 'unmount']) test(`old confirmation cannot dispatch after ${mode}`, async t => {
  const f = fixture(t); await f.ready(); await f.click('data-official-remove', A); const old = f.ui.find('data-official-remove-confirm').props.onClick;
  if (mode === 'unmount') f.ui.cleanup(); else for (const value of ['legacy', 'official']) { f.ui.nodes().find(node => node.props.name === 'codexAccountBackend').props.onChange({ target: { value } }); f.ui.render(); }
  old(); await settle(); assert.equal(f.posts().length, 0);
});

test('an acknowledged remove followed by failed GET is not called a failed delete and is never replayed', async t => {
  let readBroken = false;
  const f = fixture(t, { post: body => { if (body.action === 'account.remove') readBroken = true; }, get: () => readBroken ? Response.json({ error: '目录暂不可读。', code: 'DIRECTORY_UNAVAILABLE' }, { status: 503 }) : undefined });
  await f.ready(); await f.click('data-official-remove', A); await f.click('data-official-remove-confirm', A);
  assert.equal(f.posts().length, 1); assert(f.ui.find('data-official-stale-directory')); assert.match(f.ui.text(), /移除操作已提交.*核验失败/); assert(!f.ui.find('data-official-remove-confirm'));
  assert.equal(f.ui.find('data-official-remove', B).props.disabled, true);
  readBroken = false; await f.click('data-official-read'); assert.equal(f.posts().length, 1); assert(!f.ui.find('data-official-account-row', A));
});

test('unknown removal failure does not imply the durable tombstone was undone', async t => {
  const f = fixture(t, { post(body, state) { if (body.action === 'account.remove') { state.catalogue = { ...state.catalogue, generation: 2, defaultKey: null, accounts: state.catalogue.accounts.filter(row => row.accountKey !== A) }; return Response.json({ error: '清理结果未确认。', code: 'OFFICIAL_SERVICE_UNAVAILABLE' }, { status: 503 }); } } });
  await f.ready(); await f.click('data-official-remove', A); await f.click('data-official-remove-confirm', A);
  assert.match(f.ui.text(), /移除结果未确认.*可能已在本机撤销/); assert.equal(f.posts().length, 1);
  await f.click('data-official-read'); assert(!f.ui.find('data-official-account-row', A)); assert.equal(f.posts().length, 1);
});

test('quota receipts remain visible and age past reset on local clock ticks without any new quota query', async t => {
  const base = 1_790_000_000_000; let now = base;
  t.mock.method(Date, 'now', () => now); t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t); f.state.catalogue.accounts[0].quota = { status: 'reported', clientObservedAt: base - 2000, fiveHour: { remainingPercent: 23, resetAt: base + 1000 }, weekly: null };
  await f.ready(); assert.match(f.ui.text(f.ui.find('data-official-quota-report', A)), /最近报告.*23%.*本机收到/s);
  now += 5001; t.mock.timers.tick(5000); await settle(); f.ui.render();
  const report = f.ui.text(f.ui.find('data-official-quota-report', A)); assert.match(report, /已过重置.*23%/s); assert.match(report, /不是服务器采样/);
  assert.equal(f.state.gets, 1); assert.equal(f.posts().length, 0); assert.match(f.ui.text(f.ui.find('data-official-quota-report', B)), /尚未查询/);
});

test('a new source or unmount drops a late quota response and never reintroduces old rows', async t => {
  for (const mode of ['backend', 'unmount']) {
    let release;
    const f = fixture(t, { post: async body => { if (body.action === 'quota.read') await new Promise(resolve => { release = resolve; }); } });
    await f.ready(); f.ui.find('data-official-quota', A).props.onClick(); await settle();
    if (mode === 'unmount') f.ui.cleanup(); else { f.ui.nodes().find(node => node.props.name === 'codexAccountBackend').props.onChange({ target: { value: 'legacy' } }); f.ui.render(); }
    release(); await settle(); await settle(); f.ui.render(); assert.equal(f.state.gets, 1);
    if (mode === 'backend') assert(!f.ui.find('data-official-account-row'));
  }
});
