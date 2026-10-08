import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { statBuckets, calendarDate, quotaStatus, quotaReset, createSimplePetClient } from './client-source.js';
import { DEFAULT_PREFERENCES } from './preferences.js';

function harness(send) {
  const cells = [], effects = [];
  let cursor = 0, tree;
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat().filter(v => v !== null && v !== undefined && v !== false) }; },
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], value => { cells[i] = typeof value === 'function' ? value(cells[i]) : value; }]; },
    useRef(value) { const i = cursor++; return cells[i] ??= { current: value }; },
    useEffect(fn) { const i = cursor++; if (!(i in cells)) { cells[i] = true; effects.push(fn()); } },
  };
  const plugin = createSimplePetClient(React, send);
  const render = () => { cursor = 0; tree = plugin.SimplePetSettings(); return tree; };
  function nodes(root = tree) { return typeof root !== 'object' || !root ? [] : [root, ...root.children.flatMap(nodes)]; }
  const text = node => typeof node === 'object' && node ? node.children.map(text).join('') : String(node ?? '');
  const find = predicate => { const node = nodes().find(predicate); assert.ok(node, 'node exists'); return node; };
  render();
  return { React, plugin, render, nodes, text, find, cleanup() { effects.forEach(fn => fn?.()); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function mockTransport() {
  const calls = [];
  const accepted = { values: { ...DEFAULT_PREFERENCES }, revision: 'a'.repeat(64), timeZone: 'Europe/Copenhagen' };
  let rejectSave = false;
  const send = async (url, init) => {
    calls.push({ url, ...init });
    if (url.endsWith('/state')) return Response.json({ stats: { days: {} }, codexWarmup: { detail: '自动预热已关闭' } });
    if (init.method === 'PUT') {
      if (rejectSave) return Response.json({ error: 'conflict' }, { status: 409 });
      const body = JSON.parse(init.body); accepted.values = { ...accepted.values, ...body.patch }; accepted.revision = 'b'.repeat(64);
    }
    return Response.json(accepted);
  };
  return { send, calls, accepted, conflict() { rejectSave = true; } };
}

test('chart buckets use local dates, Monday weeks, leap months and exact yearly sums', () => {
  const days = { '2024-02-29': { tokens: 48056876, cny: 3 }, '2024-03-01': { tokens: 20 }, '2023-12-31': { tokens: 9 }, '2024-01-01': { tokens: 12 } };
  assert.equal(statBuckets(days, 'month', 'tokens', new Date(2024,1,29)).length, 29);
  assert.equal(statBuckets(days, 'month', 'tokens', new Date(2024,1,29))[28].value, 48056876);
  assert.equal(statBuckets(days, 'year', 'tokens', new Date(2024,1,29))[1].value, 48056876);
  const week = statBuckets(days, 'week', 'tokens', new Date(2024,0,1));
  assert.equal(week[0].label, '一'); assert.equal(week[0].value, 12); assert.equal(week[6].value, 0);
  assert.equal(statBuckets(null, 'week', 'tokens').every(b => b.value === 0), true);
  assert.equal(statBuckets({ '2024-02-29': { tokens: -1 } }, 'month', 'tokens', new Date(2024,1,29))[28].value, 0);
});
test('host timezone determines statistics date even when browser is elsewhere', () => {
  const instant = new Date('2024-12-31T16:30:00Z');
  const host = calendarDate('Asia/Shanghai', instant);
  assert.deepEqual([host.getFullYear(),host.getMonth(),host.getDate()],[2025,0,1]);
  const browser = calendarDate('Europe/Copenhagen', instant);
  assert.deepEqual([browser.getFullYear(),browser.getMonth(),browser.getDate()],[2024,11,31]);
  assert.equal(calendarDate('invalid/timezone', instant),instant);
});
test('mount only reads local settings and state; defaults never enable warm-up', async () => {
  const transport = mockTransport(), ui = harness(transport.send);
  try {
    await settle(); ui.render();
    assert.equal(transport.calls.length, 2); assert(transport.calls.every(c => c.method !== 'PUT'));
    assert.deepEqual(transport.calls.map(c => c.url).sort(), ['api/dsh-plugin-simple-pet/preferences','api/dsh-plugin-simple-pet/state']);
    const checkboxes = ui.nodes().filter(n => n.type === 'input' && n.props.type === 'checkbox');
    assert.equal(checkboxes.length, 3); assert(checkboxes.every(n => n.props.checked === false));
    assert.equal(ui.nodes().filter(n => n.props.role === 'radio').length, 6);
    assert(ui.text(ui.render()).includes('Europe/Copenhagen'));
    assert(!transport.calls.some(c => /subscription|llm|stream|warmup/.test(c.url)));
  } finally { ui.cleanup(); }
});
test('edits remain drafts until explicit submit, and time plus daily toggle commit atomically', async () => {
  const transport = mockTransport(), ui = harness(transport.send);
  try {
    await settle(); ui.render();
    ui.find(n => n.type === 'input' && n.props.type === 'text').props.onChange({ target: { value: '08:15' } });
    ui.find(n => n.type === 'input' && n.props.type === 'checkbox').props.onChange({ target: { checked: true } });
    ui.render(); assert.equal(transport.calls.length, 2);
    const radio = ui.find(n => n.props.role === 'radio' && ui.text(n).includes('薄荷')); radio.props.onClick(); ui.render();
    ui.find(n => n.type === 'form').props.onSubmit({ preventDefault() {} });
    await settle(); ui.render();
    const writes = transport.calls.filter(c => c.method === 'PUT'); assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(writes[0].body), { patch: { skin: 'mint', codexWarmupDaily: true, codexWarmupTime: '08:15' }, revision: 'a'.repeat(64) });
    assert.match(ui.text(ui.render()), /已保存/);
  } finally { ui.cleanup(); }
});
test('optimistic conflict preserves draft and does not automatically retry or overwrite', async () => {
  const transport = mockTransport(), ui = harness(transport.send);
  try {
    await settle(); ui.render(); transport.conflict();
    ui.find(n => n.props.role === 'radio' && ui.text(n).includes('星砂')).props.onClick(); ui.render();
    ui.find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); await settle(); ui.render();
    assert.equal(transport.calls.filter(c => c.method === 'PUT').length, 1);
    assert.equal(ui.find(n => n.props.role === 'radio' && ui.text(n).includes('星砂')).props['aria-checked'], true);
    assert.match(ui.text(ui.render()), /当前草稿已保留/);
  } finally { ui.cleanup(); }
});
test('Codex selection shows percent option but chart is correctly locked to Token', async () => {
  const transport = mockTransport(); transport.accepted.values.billingMode = 'codex';
  const ui = harness(transport.send);
  try {
    await settle(); ui.render();
    assert(ui.nodes().some(n => n.type === 'option' && n.props.value === 'percent'));
    const previews = ui.nodes().filter(n => n.props.className === 'pet-settings-sprite');
    assert.equal(previews.length, 6);
    assert(previews.every(n => n.props.title === '形象预览'));
    ui.find(n => n.props.role === 'tab' && ui.text(n) === '统计').props.onClick(); ui.render();
    assert.equal(ui.find(n => n.type === 'select' && n.props.disabled === true).props.value, 'tokens');
    assert.match(ui.text(ui.render()), /5 小时额度剩余/);
    assert.equal(transport.calls.filter(c => c.method === 'PUT').length, 0);
  } finally { ui.cleanup(); }
});
test('unmount cancels requests and polling; errors expose retry without destroying existing prefs', async () => {
  let signal;
  const ui = harness(async (_url, init) => { signal = init.signal; return Response.json({ error:'设置文件不可用' }, { status:503 }); });
  await settle(); ui.render();
  assert.match(ui.text(ui.render()), /未修改原文件/); ui.find(n => n.type === 'button' && ui.text(n) === '重新读取');
  ui.cleanup(); assert.equal(signal.aborted, true);
});
test('native Codex status distinguishes stale, cached, missing and fresh quota reports', () => {
  const now = Date.parse('2024-12-31T16:30:00Z');
  const q = { status:'ready', observedAt:now, fiveHour:{resetAt:now+3600000}, weekly:{resetAt:now+86400000} };
  assert.equal(quotaStatus({codex:q},now),'当前账号 · 官方报告');
  for (const observedAt of [undefined, NaN, 0, now-120001, now+5001]) assert.equal(quotaStatus({codex:{...q,observedAt}},now),'上次额度 · 待更新');
  assert.equal(quotaStatus({codex:{...q,fiveHour:{resetAt:now}}},now),'上次额度 · 待更新');
  assert.equal(quotaStatus({codex:{...q,status:'reported',observedAt:undefined}},now),'默认账号 · 可能缓存');
  assert.equal(quotaStatus({codex:{...q,status:'reported',weekly:{resetAt:now-1}}},now),'上次额度 · 待更新');
  assert.equal(quotaStatus(null,now),'等待 DSH 数据');
  assert.equal(quotaStatus({},now),'请重启 DSH 更新桌宠');
  for (const [status,label] of [['signed-out','请在订阅插件登录'],['unsupported','未发现支持的订阅接口'],['switching','账号切换中…'],['stale','上次额度 · 待更新']]) assert.equal(quotaStatus({codex:{status}},now),label);
});
test('quota reset labels use the host timezone and reject invalid timestamps', () => {
  const resetAt = Date.parse('2024-12-31T16:30:00Z');
  assert.match(quotaReset({resetAt},'Asia/Shanghai'),/01.01.*00:30/);
  assert.match(quotaReset({resetAt},'Europe/Copenhagen'),/12.31.*17:30/);
  for (const window of [undefined,{}, {resetAt:NaN},{resetAt:Infinity},{resetAt:0},{resetAt:-1}]) assert.equal(quotaReset(window,'Asia/Shanghai'),'重置时间未知');
  assert.equal(quotaReset({resetAt},'invalid/timezone'),'重置时间未知');
});
test('built bundle follows the real host factory contract and owns native settings registration/CSS lifecycle', () => {
  let factory, added = 0, removed = 0, registration;
  const effects = [], React = { createElement() {}, useState() {}, useEffect() {}, useRef() {} };
  const document = { createElement() { return { dataset:{}, remove() { removed++; } }; }, head: { appendChild() { added++; } } };
  const sandbox = { window: { __ModuleLoader__: { load(row) { assert.equal(row.id,'dsh-plugin-simple-pet'); factory = row.factory; } } }, document };
  vm.runInNewContext(readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8'), sandbox);
  const plugin = factory(id => { assert.equal(id, 'react'); return React; });
  assert.deepEqual([...plugin.inject], ['slots']);
  plugin.apply({ effect(fn) { effects.push(fn()); }, slots: { inject(name, fn) { assert.equal(name, 'settings.section'); effects.push(fn()); }, register(options, Component) { registration = { options, Component }; return () => {}; } } });
  assert.equal(registration.options.id, 'simple-desktop-pet'); assert.equal(registration.options.label(), '桌宠');
  assert.equal(typeof registration.Component, 'function'); assert.equal(added,1);
  effects.reverse().forEach(fn => fn?.()); assert.equal(removed,1);
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.exports['./client'],'./lib/client.js'); assert.equal(pkg.dsh.client.platform,'web');
  assert(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings-general'));
  const css = readFileSync(new URL('./client.css', import.meta.url),'utf8');
  assert.match(css, /repeat\(auto-fit,minmax\(min\(100%,130px\),1fr\)\)/); assert.match(css, /background-size:400% 200%/);
});
