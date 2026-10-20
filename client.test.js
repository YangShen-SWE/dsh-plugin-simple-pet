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
    assert.equal(transport.calls.length, 4); assert(transport.calls.every(c => c.method !== 'PUT'));
    assert.deepEqual(transport.calls.map(c => c.url).sort(), ['api/dsh-plugin-simple-pet/account','api/dsh-plugin-simple-pet/application','api/dsh-plugin-simple-pet/preferences','api/dsh-plugin-simple-pet/state']);
    const checkboxes = ui.nodes().filter(n => n.type === 'input' && n.props.type === 'checkbox');
    assert.equal(checkboxes.length, 8); assert(checkboxes.every(n => n.props.checked === false));
    assert.equal(checkboxes.find(n => n.props.name === 'compactMode').props.checked, false);
    assert.equal(checkboxes.filter(n => n.props.name?.startsWith('codexWarmup')).length, 3);
    assert.equal(ui.nodes().filter(n => n.props.role === 'radio' && !n.props['data-card-theme-choice']).length, 6);
    assert(ui.text(ui.render()).includes('Europe/Copenhagen'));
    assert(!transport.calls.some(c => /subscription|llm|stream|warmup/.test(c.url)));
  } finally { ui.cleanup(); }
});
test('ordinary settings have no manual save button and contradictory save instructions are absent',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const transport=mockTransport(),ui=harness(transport.send);
 try{
  await settle();ui.render();assert(!ui.nodes().some(n=>n.props['data-settings-save']));
  assert(!/跨页草稿保留，不自动保存|点击保存后桌宠应用|请使用顶部保存设置|立即保存普通偏好/.test(ui.text(ui.render())));
  ui.find(n=>n.props.name==='size').props.onChange({target:{value:'tiny'}});ui.render();
  assert(!ui.nodes().some(n=>n.props['data-settings-save']));t.mock.timers.tick(450);await settle();ui.render();
  assert.equal(transport.accepted.values.size,'tiny');assert.equal(transport.calls.filter(c=>c.method==='PUT').length,1);
  assert(!ui.nodes().some(n=>n.props['data-authorization-confirm']));
 }finally{ui.cleanup();}
});
test('spending authorization remains a draft until explicit confirmation, and time plus daily toggle commit atomically', async () => {
  const transport = mockTransport(), ui = harness(transport.send);
  try {
    await settle(); ui.render();
    ui.find(n => n.type === 'input' && n.props.type === 'text').props.onChange({ target: { value: '08:15' } });
    ui.find(n => n.type === 'input' && n.props.name === 'codexWarmupDaily').props.onChange({ target: { checked: true } });
    ui.render(); assert.equal(transport.calls.length, 4);
    const radio = ui.find(n => n.props.role === 'radio' && ui.text(n).includes('薄荷')); radio.props.onClick(); ui.render();
    ui.find(n => n.props['data-settings-save']).props.onClick();
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
    ui.find(n => n.props['data-pet-tab'] === 'appearance').props.onClick(); ui.render();
    ui.find(n => n.props['data-pet-tab'] === 'stats').props.onClick(); ui.render();
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
test('top navigation partitions all setting groups without extra requests or writes', async () => {
  const transport = mockTransport(); transport.accepted.values.billingMode = 'codex';
  const ui = harness(transport.send);
  try {
    await settle(); ui.render();
    const tabs = () => ui.nodes().filter(n => n.props.role === 'tab');
    assert.deepEqual(tabs().map(ui.text), ['账号与额度', '模型设置', '桌宠设置', '自动预热']);
    assert.equal(ui.find(n => n.props['data-pet-settings']).props['data-current-page'], 'accounts');
    for (const id of ['models','appearance','accounts','warmup','appearance','stats','accounts']) {
      ui.find(n => n.props['data-pet-tab'] === id).props.onClick(); ui.render();
      assert.equal(tabs().filter(n => n.props['aria-selected']).length, 1);
      assert.equal(tabs().filter(n => n.props.tabIndex === 0).length, 1);
      assert.equal(ui.find(n => n.props.role === 'tabpanel').props['aria-labelledby'], `pet-tab-${id === 'stats' ? 'appearance' : id}`);
      const visible = ui.nodes().filter(n => n.props['data-pet-page'] && !n.props.hidden);
      assert(visible.every(n => n.props['data-pet-page'] === id));
      if (id !== 'stats') assert(visible.length > 0, id);
      assert.equal(ui.nodes().some(n => n.type === 'form'), id !== 'stats');
    }
    assert.equal(transport.calls.length, 4);
  } finally { ui.cleanup(); }
});
test('navigation keeps cross-page drafts and commits a single explicit preference patch', async () => {
  const transport = mockTransport(), ui = harness(transport.send);
  try {
    await settle(); ui.render();
    ui.find(n => n.props.name === 'size').props.onChange({ target: { value: 'tiny' } });
    ui.find(n => n.props['data-pet-tab'] === 'appearance').props.onClick(); ui.render();
    ui.find(n => n.props.name === 'compactMode').props.onChange({ target: { checked: true } });
    ui.find(n => n.props['data-pet-tab'] === 'stats').props.onClick(); ui.render();
    ui.find(n => n.props['data-pet-tab'] === 'accounts').props.onClick(); ui.render();
    assert.equal(ui.find(n => n.props.name === 'compactMode').props.checked, true);
    assert.equal(ui.find(n => n.props.name === 'size').props.value, 'tiny');
    assert.equal(transport.calls.length, 4);
    const form = ui.find(n => n.type === 'form'); assert.equal(form.props.noValidate, true);
    form.props.onSubmit({ preventDefault() {} }); await settle(); ui.render();
    assert.deepEqual(JSON.parse(transport.calls.at(-1).body).patch, { size: 'tiny', compactMode: true });
    assert.equal(transport.calls.filter(c => c.method === 'PUT').length, 1);
    assert(!transport.calls.some(c => c.url.endsWith('/multi-warmup')));
  } finally { ui.cleanup(); }
});
test('navigation keyboard wraps arrows and Home/End with roving focus', async () => {
  const ui = harness(mockTransport().send);
  try {
    await settle(); ui.render(); let focused = -1, prevented = 0;
    const press = key => { ui.find(n => n.props.role === 'tablist').props.onKeyDown({ key, preventDefault() { prevented++; }, currentTarget: { querySelectorAll() { return Array.from({ length: 4 }, (_, i) => ({ focus() { focused = i; } })); } } }); ui.render(); };
    press('ArrowLeft'); assert.equal(focused, 3);
    press('ArrowRight'); assert.equal(focused, 0);
    press('End'); assert.equal(focused, 3);
    press('Home'); assert.equal(focused, 0);
    press('ArrowRight'); assert.equal(focused, 1);
    press('Escape'); assert.equal(prevented, 5);
  } finally { ui.cleanup(); }
});
test('DeepSeek account subpage permits account setup without installing or reading accounts', async () => {
  const transport = mockTransport(), ui = harness(transport.send);
  try { await settle(); ui.render(); ui.find(n => n.props['data-pet-tab'] === 'accounts').props.onClick(); ui.render(); assert.match(ui.text(ui.render()), /可在此管理订阅账号/); assert(ui.find(n => n.props.name === 'codexAccountBackend')); assert(!ui.nodes().some(n => n.props['data-dependency-install'])); assert.equal(transport.calls.length, 4); } finally { ui.cleanup(); }
});
test('built bundle follows the real host factory contract and owns native settings registration/CSS lifecycle', () => {
  let factory, added = 0, removed = 0, registration;
  const effects = [], React = { createElement() {}, useState() {}, useEffect() {}, useRef() {} };
  const document = { createElement() { return { dataset:{}, remove() { removed++; } }; }, head: { appendChild() { added++; } } };
  const sandbox = { window: { __ModuleLoader__: { load(row) { assert.equal(row.id,'dsh-plugin-simple-pet'); factory = row.factory; } } }, document };
  vm.runInNewContext(readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8'), sandbox);
  const plugin = factory(id => { assert.equal(id, 'react'); return React; });
  assert.deepEqual([...plugin.inject], ['slots', 'remote']);
  plugin.apply({ effect(fn) { effects.push(fn()); }, inject(names) { assert.deepEqual([...names], ['remote.pluginManager']); return () => {}; }, slots: { inject(name, fn) { assert.equal(name, 'settings.section'); effects.push(fn()); }, register(options, Component) { registration = { options, Component }; return () => {}; } } });
  assert.equal(registration.options.id, 'simple-desktop-pet'); assert.equal(registration.options.label(), '桌宠');
  assert.equal(typeof registration.Component, 'function'); assert.equal(added,1);
  effects.reverse().forEach(fn => fn?.()); assert.equal(removed,1);
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.exports['./client'],'./lib/client.js'); assert.equal(pkg.dsh.client.platform,'web');
  assert(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings-general'));
  const css = readFileSync(new URL('./client.css', import.meta.url),'utf8');
  assert.match(css, /repeat\(auto-fit,minmax\(min\(100%,130px\),1fr\)\)/); assert.match(css, /background-size:400% 200%/);
});

function visibleSettingsNodes(root) {
  if (!root || typeof root !== 'object' || root.props?.hidden) return [];
  const children = root.type === 'details' && !root.props.open ? root.children.filter(child => child?.type === 'summary') : root.children;
  return [root, ...children.flatMap(visibleSettingsNodes)];
}

test('B model page is independent, starts empty and never reads accounts or models on tab selection', async () => {
  const transport = mockTransport(); transport.accepted.values.codexAccountBackend = 'official';
  const ui = harness(transport.send);
  try {
    await settle(); ui.render();
    ui.find(n => n.props['data-pet-tab'] === 'models').props.onClick(); ui.render();
    const visible = visibleSettingsNodes(ui.render());
    assert.equal(ui.find(n => n.props['data-settings-design']).props['data-settings-design'], 'b-complete');
    assert(visible.some(n => n.props['data-model-workbench']));
    assert(!visible.some(n => n.props['data-official-panel']));
    assert.match(ui.text(ui.find(n => n.props['data-model-workbench'])), /正在后台读取账号/);
    assert(!ui.nodes().some(n => n.props['data-official-model-panel']));
    assert.equal(transport.calls.length, 4); assert(transport.calls.every(c => c.method === undefined || c.method === 'GET'));
  } finally { ui.cleanup(); }
});

test('B desktop page prioritizes preview and ordinary switches while appearance, motion and panel grants stay folded', async () => {
  const transport = mockTransport(); transport.accepted.values.billingMode = 'codex';
  const ui = harness(transport.send);
  try {
    await settle(); ui.render(); ui.find(n => n.props['data-pet-tab'] === 'appearance').props.onClick(); ui.render();
    const visible = visibleSettingsNodes(ui.render());
    assert(visible.some(n => n.props['data-desktop-intro']));
    assert(visible.some(n => n.props.className?.includes('pet-combination-preview')));
    assert.deepEqual(visible.filter(n => n.props.role === 'switch').map(n => n.props.name), ['compactMode','quietMode']);
    for (const attr of ['data-appearance-library','data-motion-settings','data-application-details','data-panel-switch-settings']) {
      const details = ui.find(n => n.props[attr]); assert.equal(details.type, 'details'); assert(!details.props.open);
    }
    assert(!visible.some(n => n.props['data-card-theme-choice']));
    assert.equal(ui.nodes().filter(n => n.props.role === 'radio').length, 11);
    assert(visible.some(n => n.props['data-stats-entry']));
    assert.equal(transport.calls.length, 4);
  } finally { ui.cleanup(); }
});

test('B statistics is a secondary desktop page with an explicit return and no extra reads', async () => {
  const transport = mockTransport(); transport.accepted.values.billingMode = 'codex';
  const ui = harness(transport.send);
  try {
    await settle(); ui.render(); ui.find(n => n.props['data-pet-tab'] === 'appearance').props.onClick(); ui.render();
    ui.find(n => n.props['data-pet-tab'] === 'stats').props.onClick(); ui.render();
    assert(ui.find(n => n.props['data-statistics-page']));
    assert.equal(ui.find(n => n.props.role === 'tab' && n.props['aria-selected']).props['data-pet-tab'], 'appearance');
    assert(!ui.nodes().some(n => n.props.role === 'tab' && n.props['data-pet-tab'] === 'stats'));
    assert.equal(ui.find(n => n.props['data-current-page']).props['data-current-page'], 'stats');
    ui.find(n => n.props['data-stats-back']).props.onClick(); ui.render();
    assert.equal(ui.find(n => n.props['data-current-page']).props['data-current-page'], 'appearance');
    assert.equal(transport.calls.length, 4);
  } finally { ui.cleanup(); }
});

test('B warmup keeps the spending warning and unknown-result pause visible while optional triggers remain disabled and folded', async () => {
  const transport = mockTransport(); transport.accepted.values.billingMode = 'codex'; transport.accepted.values.codexAccountBackend = 'official';
  const ui = harness(async (url, init) => {
    const response = await transport.send(url, init);
    return url.endsWith('/state') ? Response.json({codexMultiWarmup:{status:'unknown',detail:'请求可能已发送；结果未知，保持暂停'}}) : response;
  });
  try {
    await settle(); ui.render(); ui.find(n => n.props['data-pet-tab'] === 'warmup').props.onClick(); ui.render();
    const visible = visibleSettingsNodes(ui.render());
    assert(visible.some(n => n.props['data-warmup-warning']));
    assert.match(ui.text(ui.find(n => n.props['data-warmup-warning'])), /消耗额度.*不自动重试/);
    assert(!ui.find(n => n.props['data-multi-boundaries']).props.open);
    assert(!ui.find(n => n.props['data-legacy-warmup']).props.open);
    const triggers = ui.nodes().filter(n => n.props['data-multi-trigger']); assert.equal(triggers.length, 2);
    assert(triggers.every(n => n.props.disabled && n.props.checked === false));
    assert(!visible.some(n => n.props['data-multi-trigger']));
    assert(visible.some(n => n.props.role === 'alert' && /设置保存不能清除暂停/.test(ui.text(n))));
    assert(!ui.nodes().some(n => n.props['data-multi-save']));
    assert.equal(transport.calls.length, 4);
  } finally { ui.cleanup(); }
});

test('B header moves reload into closed maintenance without replacing automatic saves or implicit authorization', async () => {
  const transport = mockTransport(), ui = harness(transport.send);
  try {
    await settle(); ui.render(); const visible = visibleSettingsNodes(ui.render());
    assert.equal(ui.find(n => n.props['data-save-explanation']).type, 'details');
    assert(!ui.find(n => n.props['data-save-explanation']).props.open);
    assert(!visible.some(n => n.props['data-settings-reload']));
    assert(!ui.nodes().some(n => n.props['data-settings-save']));
    assert.equal(ui.find(n => n.props['data-autosave-status']).props['data-autosave-status'], 'saved');
    assert.equal(transport.calls.length, 4);
  } finally { ui.cleanup(); }
});

test('B switches expose stable accessible labels and keep explicit panel permission separate from ordinary preferences', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transport = mockTransport(); transport.accepted.values.billingMode = 'codex';
  const ui = harness(transport.send);
  try {
    await settle(); ui.render();
    for (const name of ['compactMode','quietMode','multiAccountManagement']) {
      const toggle = ui.find(n => n.props.name === name); assert.equal(toggle.props.role, 'switch'); assert(toggle.props['aria-label']);
    }
    ui.find(n => n.props.name === 'multiAccountManagement').props.onChange({target:{checked:true}});
    ui.find(n => n.props.name === 'quietMode').props.onChange({target:{checked:true}}); ui.render();
    t.mock.timers.tick(450); await settle(); ui.render();
    assert.deepEqual(JSON.parse(transport.calls.at(-1).body).patch, {quietMode:true});
    assert.equal(transport.accepted.values.multiAccountManagement, false);
    assert(ui.find(n => n.props['data-authorization-apply']));
  } finally { ui.cleanup(); }
});

function settingsRegistrationHarness() {
  const entries = new Map(), waiting = [], services = {}, effects = [];
  let unauthorizedReads = 0, requests = 0;
  const remote = Object.defineProperty({}, 'pluginManager', { get() { unauthorizedReads++; throw Error('cannot get property "remote.pluginManager" without inject'); } });
  const plugin = createSimplePetClient({ createElement() {} }, () => { requests++; throw Error('FORBIDDEN_REQUEST'); }, services);
  plugin.apply({ remote, inject(names, callback) {
    assert.deepEqual(names, ['remote.pluginManager']);
    const row = { active: true, callback, cleanup: null }; waiting.push(row);
    const stop = () => { row.active = false; row.cleanup?.(); row.cleanup = null; }; effects.push(stop); return stop;
  }, slots: { inject(name, callback) { assert.equal(name, 'settings.section'); effects.push(callback()); }, register(options, Component) {
    entries.set(options.id, { options, Component }); return () => entries.delete(options.id);
  } } });
  return { entries, services, get unauthorizedReads() { return unauthorizedReads; }, get requests() { return requests; },
    mount(manager) { const row = waiting[0]; if (!row.active) return null; row.cleanup = row.callback({ remote: { pluginManager: manager } }); return row.cleanup; },
    unmount() { const row = waiting[0]; row.cleanup?.(); row.cleanup = null; },
    dispose() { effects.reverse().forEach(fn => fn?.()); } };
}

test('settings menu registers without reading an undeclared optional remote namespace', () => {
  const host = settingsRegistrationHarness();
  try {
    assert.equal(host.entries.get('simple-desktop-pet').options.label(), '桌宠');
    assert.equal(host.unauthorizedReads, 0); assert.equal(host.requests, 0);
    assert.equal(host.services.pluginManager, undefined);
  } finally { host.dispose(); }
  assert.equal(host.entries.size, 0);
});

test('late or retired plugin-manager namespace cannot hide settings or leave a stale installer', () => {
  const host = settingsRegistrationHarness(), managerA = {}, managerB = {};
  try {
    const retireA = host.mount(managerA); assert.equal(host.services.pluginManager, managerA);
    host.unmount(); assert.equal(host.services.pluginManager, undefined); assert.equal(host.entries.size, 1);
    host.mount(managerB); retireA(); assert.equal(host.services.pluginManager, managerB);
    assert.equal(host.entries.size, 1); assert.equal(host.unauthorizedReads, 0); assert.equal(host.requests, 0);
  } finally { host.dispose(); }
  assert.equal(host.services.pluginManager, undefined); assert.equal(host.entries.size, 0);
});

test('disposing settings before optional service arrival revokes its waiting registration', () => {
  const host = settingsRegistrationHarness(); host.dispose();
  assert.equal(host.mount({}), null); assert.equal(host.services.pluginManager, undefined);
  assert.equal(host.entries.size, 0); assert.equal(host.requests, 0);
});

test('sticky settings toolbar flattens translucent host surfaces and ships its opaque fallback', () => {
  const css = readFileSync(new URL('./client.css', import.meta.url),'utf8');
  const toolbar = [...css.matchAll(/\.pet-settings-toolbar\{([^}]+)\}/g)].map(row => row[1]).join(';'); assert(toolbar);
  assert.match(toolbar, /position:sticky/); assert.match(toolbar, /isolation:isolate/);
  assert(toolbar.includes('background:linear-gradient(var(--dsw-alias-bg-layer-2,#202126),var(--dsw-alias-bg-layer-2,#202126)),#202126;'));
  const opaque = 'background:rgb(from var(--dsw-alias-bg-layer-2,#202126) r g b / 1);'; assert(toolbar.includes(opaque));
  assert(readFileSync(new URL('./lib/client.js', import.meta.url),'utf8').includes(opaque));
});

test('debounced ordinary changes persist across tabs without submitting spending drafts or implicit Enter grants', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transport = mockTransport(), ui = harness(transport.send);
  try {
    await settle(); ui.render(); t.mock.timers.tick(5000); await settle(); assert.equal(transport.calls.length, 4);
    ui.find(n => n.props.name === 'codexWarmupDaily').props.onChange({ target: { checked: true } });
    ui.find(n => n.props.name === 'size').props.onChange({ target: { value: 'tiny' } });
    ui.find(n => n.props['data-pet-tab'] === 'appearance').props.onClick(); ui.render();
    ui.find(n => n.props.name === 'compactMode').props.onChange({ target: { checked: true } }); ui.render();
    assert.equal(ui.find(n => n.props['data-autosave-status']).props['data-autosave-status'], 'waiting');
    t.mock.timers.tick(449); assert.equal(transport.calls.filter(c => c.method === 'PUT').length, 0);
    t.mock.timers.tick(1); ui.render(); assert.equal(ui.find(n => n.props['data-autosave-status']).props['data-autosave-status'], 'saving');
    await settle(); ui.render();
    assert.deepEqual(JSON.parse(transport.calls.at(-1).body).patch, { size: 'tiny', compactMode: true });
    assert.equal(ui.find(n => n.props.name === 'codexWarmupDaily').props.checked, true);
    assert.match(ui.text(ui.find(n => n.props['data-autosave-status'])), /授权待确认/);
    assert(ui.find(n => n.props['data-authorization-apply']));
    ui.find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); await settle();
    t.mock.timers.tick(10000); await settle(); assert.equal(transport.calls.filter(c => c.method === 'PUT').length, 1);
    assert.equal(transport.accepted.values.codexWarmupDaily, false);
    assert(!transport.calls.some(c => /oauth|warmup|subscription|llm/.test(c.url)));
    assert.match(ui.text(ui.render()), /等待独立的桌宠应用回执/);
  } finally { ui.cleanup(); }
});

test('autosave keeps controls editable during writes and serially persists the newer draft', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transport = mockTransport(), pending = [], writes = [];
  const ui = harness((url, init) => {
    if (init.method !== 'PUT') return transport.send(url, init);
    writes.push(JSON.parse(init.body)); return new Promise(resolve => pending.push(() => resolve(transport.send(url, init))));
  });
  try {
    await settle(); ui.render(); ui.find(n => n.props.name === 'size').props.onChange({ target: { value: 'tiny' } });
    t.mock.timers.tick(450); ui.render(); assert.equal(writes.length, 1);
    const size = ui.find(n => n.props.name === 'size'); assert.equal(size.props.disabled, false);
    size.props.onChange({ target: { value: 'large' } }); ui.render();
    t.mock.timers.tick(5000); assert.equal(writes.length, 1);
    pending.shift()(); await settle(); ui.render(); assert.equal(ui.find(n => n.props.name === 'size').props.value, 'large');
    t.mock.timers.tick(450); assert.equal(writes.length, 2); assert.deepEqual(writes[1].patch, { size: 'large' }); assert.equal(writes[1].revision, 'b'.repeat(64));
    pending.shift()(); await settle(); ui.render(); assert.equal(ui.find(n => n.props['data-autosave-status']).props['data-autosave-status'], 'saved');
  } finally { ui.cleanup(); }
});

test('unmount drops queued debounce and aborts autosave; late success cannot write again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transport = mockTransport(); let signal, finish, puts = 0;
  const ui = harness((url, init) => {
    if (init.method !== 'PUT') return transport.send(url, init);
    puts++; signal = init.signal; return new Promise(resolve => { finish = () => resolve(Response.json(transport.accepted)); });
  });
  await settle(); ui.render(); ui.find(n => n.props.name === 'size').props.onChange({ target: { value: 'tiny' } });
  t.mock.timers.tick(450); ui.render(); ui.find(n => n.props.name === 'size').props.onChange({ target: { value: 'large' } });
  ui.cleanup(); assert.equal(signal.aborted, true); finish(); await settle(); t.mock.timers.tick(5000); await settle(); assert.equal(puts, 1);
});

test('late initial preference read cannot overwrite a later explicit reload', async () => {
  const transport = mockTransport(); let first, reads = 0;
  const ui = harness((url, init) => {
    if (!url.endsWith('/preferences')) return transport.send(url, init);
    if (++reads === 1) return new Promise(resolve => { first = resolve; });
    return Response.json({ ...transport.accepted, revision: 'c'.repeat(64), values: { ...DEFAULT_PREFERENCES, size: 'large' } });
  });
  try {
    await settle(); ui.render(); ui.find(n => n.type === 'button' && ui.text(n) === '重新读取').props.onClick(); await settle(); ui.render();
    assert.equal(ui.find(n => n.props.name === 'size').props.value, 'large');
    first(Response.json(transport.accepted)); await settle(); ui.render();
    assert.equal(ui.find(n => n.props.name === 'size').props.value, 'large'); assert.equal(transport.calls.filter(c => c.method === 'PUT').length, 0);
  } finally { ui.cleanup(); }
});

test('autosave network error retains drafts and pauses until explicit safe retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transport = mockTransport(); let fail = true, puts = 0;
  const ui = harness((url, init) => {
    if (init.method === 'PUT') { puts++; if (fail) throw new Error('private network log'); }
    return transport.send(url, init);
  });
  try {
    await settle(); ui.render(); ui.find(n => n.props.name === 'size').props.onChange({ target: { value: 'tiny' } });
    t.mock.timers.tick(450); await settle(); ui.render(); assert.equal(ui.find(n => n.props['data-autosave-status']).props['data-autosave-status'], 'error');
    assert.equal(ui.find(n => n.props.name === 'size').props.value, 'tiny'); assert(!ui.text(ui.render()).includes('private network log'));
    ui.find(n => n.props.name === 'size').props.onChange({ target: { value: 'large' } }); t.mock.timers.tick(10000); await settle(); ui.render(); assert.equal(puts, 1);
    fail = false; ui.find(n => n.props['data-settings-save']).props.onClick(); await settle(); ui.render(); assert.equal(puts, 2);
    assert.equal(ui.find(n => n.props['data-autosave-status']).props['data-autosave-status'], 'saved'); assert.equal(transport.accepted.values.size, 'large');
  } finally { ui.cleanup(); }
});

test('explicit reload cancels pending auto-save and safely discards the draft before a new revision', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transport = mockTransport(), ui = harness(transport.send);
  try {
    await settle(); ui.render(); ui.find(n => n.props.name === 'size').props.onChange({ target: { value: 'tiny' } }); ui.render();
    const reload = ui.find(n => n.type === 'button' && ui.text(n) === '放弃草稿并重新读取');
    reload.props.onClick(); await settle(); ui.render(); t.mock.timers.tick(5000); await settle();
    assert.equal(transport.calls.filter(c => c.method === 'PUT').length, 0); assert.equal(ui.find(n => n.props.name === 'size').props.value, DEFAULT_PREFERENCES.size);
    assert.equal(ui.find(n => n.props['data-autosave-status']).props['data-autosave-status'], 'saved');
  } finally { ui.cleanup(); }
});
