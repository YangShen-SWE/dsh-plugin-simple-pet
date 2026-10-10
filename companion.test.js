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
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(conflict = false) {
  let cursor = 0, tree;
  const cells = [], effects = [], calls = [];
  const accepted = { values: { ...DEFAULT_PREFERENCES }, revision: 'a'.repeat(64) };
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat().filter(v => v != null && v !== false) }; },
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], v => { cells[i] = typeof v === 'function' ? v(cells[i]) : v; }]; },
    useRef(v) { const i = cursor++; return cells[i] ??= { current: v }; },
    useEffect(fn) { const i = cursor++; if (!(i in cells)) { cells[i] = true; effects.push(fn()); } },
  };
  const send = async (url, init = {}) => {
    calls.push({ url, ...init });
    if (url.endsWith('/state')) return Response.json({ stats: { days: {} } });
    if (init.method === 'PUT') {
      if (conflict) return Response.json({ error: 'conflict' }, { status: 409 });
      const { patch } = JSON.parse(init.body);
      accepted.values = { ...accepted.values, ...patch }; accepted.revision = 'b'.repeat(64);
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

test('comfort controls are first, drafts remain local, and explicit save only patches intended fields', async () => {
  const ui = harness();
  try {
    await settle(); ui.render();
    assert.equal(ui.text(ui.find(n => n.type === 'h3')), '陪伴与舒适');
    for (const key of keys) {
      const control = ui.find(n => n.props.name === key);
      control.props.onChange({ target: key === 'feedbackStyle' ? { value: 'gentle' } : { checked: true } }); ui.render();
    }
    assert.equal(ui.calls.filter(c => c.method === 'PUT').length, 0);
    assert.match(ui.text(ui.find(n => n.props['data-companion-summary'])), /草稿表现.*安静模式.*用量飘字关闭/);
    assert.match(ui.text(ui.render()), /不停止额度检测、统计或已开启的自动预热/);
    assert.match(ui.text(ui.render()), /不演示动作/);
    ui.find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); await settle(); ui.render();
    const writes = ui.calls.filter(c => c.method === 'PUT'); assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(writes[0].body).patch, { quietMode: true, feedbackStyle: 'gentle', reduceMotion: true, disableFlashes: true, disableFloats: true });
    assert(ui.calls.every(c => /\/preferences$|\/state$/.test(c.url)));
    ui.find(n => n.props.name === 'quietMode').props.onChange({ target: { checked: false } }); ui.render();
    for (const key of ['reduceMotion', 'disableFlashes', 'disableFloats']) assert.equal(ui.find(n => n.props.name === key).props.checked, true);
    assert.equal(ui.find(n => n.props.name === 'feedbackStyle').props.value, 'gentle');
  } finally { ui.cleanup(); }
});

test('conflict preserves the companion draft, never retries or claims native acknowledgement', async () => {
  const ui = harness(true);
  try {
    await settle(); ui.render(); ui.find(n => n.props.name === 'quietMode').props.onChange({ target: { checked: true } }); ui.render();
    ui.find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); await settle(); ui.render();
    assert.equal(ui.calls.filter(c => c.method === 'PUT').length, 1); assert.equal(ui.find(n => n.props.name === 'quietMode').props.checked, true);
    assert.match(ui.text(ui.render()), /当前草稿已保留/); assert.equal(ui.accepted.values.quietMode, false);
  } finally { ui.cleanup(); }
});

test('real WPF companion policies stop clocks, consume sequences and preserve data in isolated fixtures', { skip: process.platform !== 'win32' }, () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const result = spawnSync('powershell.exe', ['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',path.join(root,'companion.test.ps1'),'-ProjectRoot',root], { stdio: 'inherit', windowsHide: true });
  assert.ifError(result.error); assert.equal(result.status, 0);
});
