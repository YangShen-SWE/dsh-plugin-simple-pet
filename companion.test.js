import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PREFERENCES, preferenceValues, PreferencesStore } from './preferences.js';
import { createSimplePetClient, companionSummary } from './client-source.js';

const keys = ['quietMode', 'feedbackStyle', 'reduceMotion', 'disableFlashes', 'disableFloats'];
const explicitKeys = ['codexUnifiedControls', 'codexUnifiedWarmup', 'codexWarmupStartup', 'codexWarmupReset', 'codexWarmupDaily', 'codexWarmupTime'];
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(conflict = false, values = {}) {
  let cursor = 0, tree, writes = 0;
  const cells = [], effects = [], calls = [];
  const accepted = { values: { ...DEFAULT_PREFERENCES, ...values }, revision: 'a'.repeat(64) };
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat().filter(v => v != null && v !== false) }; },
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], v => { cells[i] = typeof v === 'function' ? v(cells[i]) : v; }]; },
    useRef(v) { const i = cursor++; return cells[i] ??= { current: v }; },
    useEffect(fn) { const i = cursor++; if (!(i in cells)) { cells[i] = true; effects.push(fn()); } },
  };
  const send = async (url, init = {}) => {
    calls.push({ url, ...init });
    if (url.endsWith('/state')) return Response.json({ stats: { days: {} } });
    if (url.endsWith('/application')) return Response.json({ revision: accepted.revision, status: 'unconfirmed' });
    if (url.endsWith('/account')) return Response.json({ status: 'unavailable' });
    assert.ok(url.endsWith('/preferences'), 'only local preferences may be written');
    if (init.method === 'PUT') {
      const { patch, revision } = JSON.parse(init.body);
      assert.equal(revision, accepted.revision, 'writes use the latest accepted raw-byte revision');
      if (conflict) return Response.json({ error: 'conflict' }, { status: 409 });
      accepted.values = { ...accepted.values, ...patch }; accepted.revision = (++writes).toString(16).padStart(64, '0');
    }
    return Response.json(accepted);
  };
  const plugin = createSimplePetClient(React, send);
  const render = () => { cursor = 0; return tree = plugin.SimplePetSettings(); };
  const nodes = (n = tree) => typeof n !== 'object' || !n ? [] : [n, ...n.children.flatMap(nodes)];
  const text = n => typeof n === 'object' && n ? n.children.map(text).join('') : String(n ?? '');
  const find = p => { const n = nodes().find(p); assert.ok(n, 'UI node exists'); return n; };
  render();
  return { render, nodes, text, find, calls, accepted, cleanup() { effects.forEach(f => f?.()); } };
}

test('companion defaults preserve classic feedback and reject ill-typed/near-match controls', () => {
  const expected = { quietMode: false, feedbackStyle: 'classic', reduceMotion: false, disableFlashes: false, disableFloats: false };
  for (const k of keys) assert.equal(DEFAULT_PREFERENCES[k], expected[k]);
  for (const k of keys.filter(k => k !== 'feedbackStyle')) for (const v of ['true', 1, [], [true], {}, null]) assert.equal(preferenceValues({ [k]: v })[k], false);
  for (const v of ['Gentle', 'gentle ', true, ['gentle'], null]) assert.equal(preferenceValues({ feedbackStyle: v }).feedbackStyle, 'classic');
  const values = preferenceValues({ ...expected, quietMode: true, feedbackStyle: 'gentle', reduceMotion: true });
  assert.equal(values.quietMode, true); assert.equal(values.feedbackStyle, 'gentle');
  for (const k of ['codexWarmupDaily', 'codexWarmupReset', 'codexWarmupStartup']) assert.equal(values[k], false);
});

test('32 effective summaries consistently explain override rules without modifying saved preferences', () => {
  for (let n = 0; n < 32; n++) {
    const p = { quietMode: !!(n & 1), reduceMotion: !!(n & 2), disableFlashes: !!(n & 4), disableFloats: !!(n & 8), feedbackStyle: n & 16 ? 'gentle' : 'classic' };
    const before = structuredClone(p), summary = companionSummary(p), stat = p.quietMode || p.reduceMotion;
    assert(summary.includes(`用量飘字${stat || p.disableFloats ? '关闭' : '开启'}`));
    assert(summary.includes(`闪光/暴击${stat || p.disableFlashes || p.feedbackStyle === 'gentle' ? '关闭' : '开启'}`));
    assert(summary.includes('余额、额度与统计继续更新')); assert.deepEqual(p, before);
  }
});

test('atomic saves preserve legacy coordinates/unknown fields and only change companion controls', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'DshCompanionStore-'));
  try {
    const file = path.join(dir, 'settings.json');
    await fs.writeFile(file, JSON.stringify({ skin: 'mint', cardTheme: 'forest', left: 123, top: 234, privateLegacy: 'keep', codexWarmupTime: '09:30' }));
    const store = new PreferencesStore(file), initial = await store.read();
    const patch = { quietMode: true, feedbackStyle: 'gentle', reduceMotion: true, disableFlashes: true, disableFloats: true };
    const saved = await store.update(patch, initial.revision);
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(raw.left, 123); assert.equal(raw.privateLegacy, 'keep'); assert.equal(saved.values.skin, 'mint'); assert.equal(saved.values.cardTheme, 'forest');
    for (const k of keys) assert.equal(saved.values[k], patch[k]);
    for (const k of ['codexWarmupDaily', 'codexWarmupReset', 'codexWarmupStartup']) assert.equal(saved.values[k], false);
    const bytes = await fs.readFile(file);
    await assert.rejects(store.update({ quietMode: 'true' }, saved.revision), e => e.status === 400);
    await assert.rejects(store.update({ quietMode: false }, initial.revision), e => e.status === 409);
    assert.deepEqual(await fs.readFile(file), bytes);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('comfort controls precede display settings, drafts stay local until the 450ms autosave, and only intended fields are patched', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const ui = harness();
  try {
    await settle(); ui.render();
    const groups = ui.nodes(ui.find(n => n.type === 'form')).filter(n => n.type === 'section' && n.props.className === 'pet-settings-group');
    assert.deepEqual(groups.slice(0, 3).map(n => ui.text(ui.nodes(n).find(child => child.type === 'h3'))), ['组合预览', '陪伴与舒适', '显示与休眠']);
    assert.deepEqual(ui.calls.map(c => c.url), ['api/dsh-plugin-simple-pet/preferences', 'api/dsh-plugin-simple-pet/state', 'api/dsh-plugin-simple-pet/application', 'api/dsh-plugin-simple-pet/account']);
    assert(ui.calls.every(c => (c.method ?? 'GET') === 'GET'));
    for (const key of keys) {
      const control = ui.find(n => n.props.name === key);
      control.props.onChange({ target: key === 'feedbackStyle' ? { value: 'gentle' } : { checked: true } }); ui.render();
    }
    assert.equal(ui.calls.filter(c => c.method === 'PUT').length, 0);
    assert.match(ui.text(ui.find(n => n.props['data-companion-summary'])), /安静模式.*用量飘字关闭/);
    assert.match(ui.text(ui.render()), /不停止额度显示与用量统计/);
    assert.match(ui.text(ui.render()), /不会自动启动桌宠或请求模型/);
    assert.match(ui.text(ui.render()), /静态外观示意，数字不是实时数据/);
    assert(ui.nodes().some(n => n.props['data-preview-only'] === true));
    let prevented = false;
    ui.find(n => n.type === 'form').props.onSubmit({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(ui.calls.filter(c => c.method === 'PUT').length, 0, 'form submit is not a manual save');
    t.mock.timers.tick(449); await settle(); assert.equal(ui.calls.filter(c => c.method === 'PUT').length, 0);
    t.mock.timers.tick(1); await settle(); ui.render();
    const writes = ui.calls.filter(c => c.method === 'PUT'); assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(writes[0].body).patch, { quietMode: true, feedbackStyle: 'gentle', reduceMotion: true, disableFlashes: true, disableFloats: true });
    assert(ui.calls.every(c => /\/preferences$|\/state$|\/application$|\/account$/.test(c.url)));
    assert(ui.calls.filter(c => !c.url.endsWith('/preferences')).every(c => (c.method ?? 'GET') === 'GET'));
    assert.doesNotMatch(ui.text(ui.find(n => Object.hasOwn(n.props, 'data-application-status'))), /最近确认桌宠已应用/);
    ui.find(n => n.props.name === 'quietMode').props.onChange({ target: { checked: false } }); ui.render();
    for (const key of ['reduceMotion', 'disableFlashes', 'disableFloats']) assert.equal(ui.find(n => n.props.name === key).props.checked, true);
    assert.equal(ui.find(n => n.props.name === 'feedbackStyle').props.value, 'gentle');
    t.mock.timers.tick(450); await settle();
    assert.deepEqual(JSON.parse(ui.calls.filter(c => c.method === 'PUT')[1].body).patch, { quietMode: false });
    for (const key of explicitKeys) assert.equal(ui.accepted.values[key], DEFAULT_PREFERENCES[key]);
  } finally { ui.cleanup(); }
});

test('all six account and warm-up fields remain local through appearance autosave until explicit confirmation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const ui = harness(false, { billingMode: 'codex' });
  const patch = Object.fromEntries(explicitKeys.map(key => [key, key === 'codexWarmupTime' ? '10:45' : true]));
  try {
    await settle(); ui.render();
    for (const [key, value] of Object.entries(patch)) {
      ui.find(n => n.props.name === key).props.onChange({ target: key === 'codexWarmupTime' ? { value } : { checked: value } }); ui.render();
    }
    t.mock.timers.tick(1000); await settle();
    assert.equal(ui.calls.filter(c => c.method === 'PUT').length, 0, 'authorization edits never autosave');
    ui.find(n => n.props.name === 'quietMode').props.onChange({ target: { checked: true } }); ui.render();
    t.mock.timers.tick(449); await settle(); assert.equal(ui.calls.filter(c => c.method === 'PUT').length, 0);
    t.mock.timers.tick(1); await settle(); ui.render();
    const writes = ui.calls.filter(c => c.method === 'PUT'); assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(writes[0].body).patch, { quietMode: true });
    for (const [key, value] of Object.entries(patch)) {
      assert.equal(Object.hasOwn(JSON.parse(writes[0].body).patch, key), false, `${key} must not piggyback on appearance autosave`);
      assert.equal(ui.accepted.values[key], DEFAULT_PREFERENCES[key]);
      assert.equal(ui.find(n => n.props.name === key).props[key === 'codexWarmupTime' ? 'value' : 'checked'], value, 'unsaved authorization draft survives autosave');
    }
    assert.match(ui.text(ui.render()), /外观自动保存不会顺带提交/);
    const confirm = ui.find(n => n.props['data-settings-save']); assert.equal(confirm.props.disabled, false); confirm.props.onClick();
    await settle(); ui.render();
    const confirmed = ui.calls.filter(c => c.method === 'PUT'); assert.equal(confirmed.length, 2);
    assert.deepEqual(JSON.parse(confirmed[1].body).patch, patch);
    assert.equal(JSON.parse(confirmed[1].body).revision, '1'.padStart(64, '0'));
    for (const [key, value] of Object.entries(patch)) assert.equal(ui.accepted.values[key], value);
    assert.equal(ui.find(n => n.props['data-settings-save']).props.disabled, true);
    t.mock.timers.tick(10000); await settle();
    assert.equal(ui.calls.filter(c => c.method === 'PUT').length, 2, 'confirmation does not repeat writes');
    assert(ui.calls.every(c => /\/preferences$|\/state$|\/application$|\/account$/.test(c.url)));
    assert(ui.calls.filter(c => !c.url.endsWith('/preferences')).every(c => (c.method ?? 'GET') === 'GET'));
  } finally { ui.cleanup(); }
});

test('conflict preserves the companion draft, never retries or claims native acknowledgement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const ui = harness(true);
  try {
    await settle(); ui.render(); ui.find(n => n.props.name === 'quietMode').props.onChange({ target: { checked: true } }); ui.render();
    t.mock.timers.tick(450); await settle(); ui.render();
    assert.equal(ui.calls.filter(c => c.method === 'PUT').length, 1); assert.equal(ui.find(n => n.props.name === 'quietMode').props.checked, true);
    assert.match(ui.text(ui.render()), /当前草稿已保留/); assert.equal(ui.accepted.values.quietMode, false);
    assert.doesNotMatch(ui.text(ui.find(n => Object.hasOwn(n.props, 'data-application-status'))), /最近确认桌宠已应用/);
    assert.equal(ui.nodes().some(n => n.props['data-settings-retry']), false, 'conflicts require an explicit reload, never retry');
    t.mock.timers.tick(60000); await settle(); ui.render();
    assert.equal(ui.calls.filter(c => c.method === 'PUT').length, 1, 'polls and timer advances never retry the stale revision');
    assert.equal(ui.find(n => n.props.name === 'quietMode').props.checked, true);
    assert.equal(ui.accepted.values.quietMode, false);
  } finally { ui.cleanup(); }
});

test('real WPF companion policies stop clocks, consume sequences and preserve data in isolated fixtures', { skip: process.platform !== 'win32' }, () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const result = spawnSync('powershell.exe', ['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',path.join(root,'companion.test.ps1'),'-ProjectRoot',root], { stdio: 'inherit', windowsHide: true });
  assert.ifError(result.error); assert.equal(result.status, 0);
});
