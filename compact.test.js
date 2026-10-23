import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PREFERENCES, preferenceValues, PreferencesStore } from './preferences.js';
import { companionSummary, createSimplePetClient } from './client-source.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(conflict = false) {
  let cursor = 0, tree;
  const cells = [], effects = [], calls = [];
  const accepted = { values: { ...DEFAULT_PREFERENCES, skin: 'night', cardTheme: 'forest' }, revision: 'a'.repeat(64) };
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat().filter(v => v != null && v !== false) }; },
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], v => { cells[i] = typeof v === 'function' ? v(cells[i]) : v; }]; },
    useRef(v) { const i = cursor++; return cells[i] ??= { current: v }; },
    useEffect(fn) { const i = cursor++; if (!(i in cells)) { cells[i] = true; effects.push(fn()); } },
  };
  const send = async (url, init = {}) => {
    calls.push({ url, ...init });
    if (url.endsWith('/state')) return Response.json({ stats: { days: {} } });
    if (url.endsWith('/application')) return Response.json({ status: 'offline' });
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

test('compact is opt-in, strict boolean and does not mutate other preferences', () => {
  assert.equal(DEFAULT_PREFERENCES.compactMode, false);
  for (const compactMode of [undefined, null, 'true', 1, [true], {}, []]) assert.equal(preferenceValues({ compactMode }).compactMode, false);
  const values = preferenceValues({ compactMode: true, skin: 'night', cardTheme: 'forest', quietMode: false, reduceMotion: false, codexWarmupTime: '08:15', codexWarmupDaily: true });
  assert.equal(values.compactMode, true); assert.equal(values.skin, 'night'); assert.equal(values.cardTheme, 'forest');
  assert.equal(values.quietMode, false); assert.equal(values.reduceMotion, false); assert.equal(values.codexWarmupDaily, true);
});

test('compact summary overrides all 32 comfort combinations without rewriting them', () => {
  for (let n = 0; n < 32; n++) {
    const prefs = { compactMode: true, quietMode: !!(n & 1), reduceMotion: !!(n & 2), disableFlashes: !!(n & 4), disableFloats: !!(n & 8), feedbackStyle: n & 16 ? 'gentle' : 'classic' };
    const copy = structuredClone(prefs), summary = companionSummary(prefs);
    assert.match(summary, /仅显示余额\/额度面板/); assert.match(summary, /隐藏人物/); assert.match(summary, /全部视觉动效关闭/);
    assert.match(summary, /闪光\/暴击关闭/); assert.match(summary, /用量飘字关闭/); assert.deepEqual(prefs, copy);
  }
});

test('compact-only atomic saves retain coordinates, unknown fields, automation and CAS protection', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'DshCompactPrefs-'));
  try {
    const file = path.join(dir, 'settings.json'), original = { ...DEFAULT_PREFERENCES, skin: 'night', cardTheme: 'paper', left: 123, top: 234, future: { retained: true }, codexWarmupDaily: true, codexWarmupTime: '08:15' };
    await fs.writeFile(file, JSON.stringify(original));
    const store = new PreferencesStore(file), before = await store.read();
    const saved = await store.update({ compactMode: true }, before.revision);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { ...original, compactMode: true });
    const bytes = await fs.readFile(file);
    await assert.rejects(store.update({ compactMode: false }, before.revision), e => e.status === 409);
    for (const compactMode of ['true', 1, [true], {}]) await assert.rejects(store.update({ compactMode }, saved.revision), e => e.status === 400);
    assert.deepEqual(await fs.readFile(file), bytes);
    await store.update({ compactMode: false }, saved.revision);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), original);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('native settings compact preview hides character immediately and debounced autosave patches only compactMode', async () => {
  const ui = harness();
  try {
    await settle(); ui.render();
    ui.find(n => n.props.name === 'compactMode').props.onChange({ target: { checked: true } }); ui.render();
    assert.equal(ui.calls.filter(c => c.method === 'PUT').length, 0);
    const preview = ui.find(n => n.props['aria-label'] === '简洁面板示意（无人物与动效）');
    assert.equal(ui.nodes(preview).some(n => n.props.className === 'pet-combination-stage'), false);
    assert.match(ui.text(ui.find(n => n.props['data-companion-summary'])), /全部视觉动效关闭/);
    await new Promise(resolve => setTimeout(resolve, 500)); ui.render();
    const saves = ui.calls.filter(c => c.method === 'PUT'); assert.equal(saves.length, 1);
    assert.deepEqual(JSON.parse(saves[0].body).patch, { compactMode: true });
    assert.equal(ui.accepted.values.skin, 'night'); assert.equal(ui.accepted.values.cardTheme, 'forest');
    assert.equal(ui.accepted.values.quietMode, false); assert.equal(ui.accepted.values.codexWarmupStartup, false);
    assert(ui.calls.every(c => ['/preferences', '/state', '/application', '/account'].some(p => c.url.endsWith(p))));
    ui.find(n => n.props.name === 'compactMode').props.onChange({ target: { checked: false } }); ui.render();
    const restored = ui.find(n => n.props['aria-label'] === '所选人物与信息框组合示意');
    assert.equal(ui.nodes(restored).some(n => n.props.className === 'pet-combination-stage'), true);
  } finally { ui.cleanup(); }
});

test('compact draft is retained on conflict, without retry or extra automation requests', async () => {
  const ui = harness(true);
  try {
    await settle(); ui.render();
    ui.find(n => n.props.name === 'compactMode').props.onChange({ target: { checked: true } }); ui.render();
    await new Promise(resolve => setTimeout(resolve, 500)); ui.render();
    assert.equal(ui.find(n => n.props.name === 'compactMode').props.checked, true);
    assert.equal(ui.accepted.values.compactMode, false); assert.match(ui.text(ui.render()), /当前草稿已保留/);
    assert.equal(ui.calls.filter(c => c.method === 'PUT').length, 1);
  } finally { ui.cleanup(); }
});

test('real WPF compact cards hide characters, stop motion and hot-reload in isolated fixtures', { skip: process.platform !== 'win32' }, () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const result = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'compact.test.ps1'), '-ProjectRoot', root], { stdio: 'inherit', windowsHide: true });
  assert.ifError(result.error); assert.equal(result.status, 0);
});
