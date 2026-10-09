import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preferencesHandler } from './preferences-route.js';
import { CARD_THEMES, CARD_THEME_IDS, cardPalette, cardCssVariables } from './card-themes.js';
import { DEFAULT_PREFERENCES, preferenceValues, PreferencesStore } from './preferences.js';
import { createSimplePetClient } from './client-source.js';

const skins = ['default','night','snow','mint','cherry','star'];
const settle = () => new Promise(resolve => setImmediate(resolve));
function uiHarness(mode = 'deepseek') {
  const cells = [], cleanups = [], calls = [];
  let cursor = 0, tree;
  const accepted = { values: { ...DEFAULT_PREFERENCES, billingMode: mode }, revision: 'a'.repeat(64) };
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat().filter(v => v != null && v !== false) }; },
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], v => { cells[i] = typeof v === 'function' ? v(cells[i]) : v; }]; },
    useRef(v) { const i = cursor++; return cells[i] ??= { current: v }; },
    useEffect(fn) { const i = cursor++; if (!(i in cells)) { cells[i] = true; cleanups.push(fn()); } },
  };
  const send = async (url, init = {}) => {
    calls.push({ url, ...init });
    if (url.endsWith('/state')) return Response.json({ stats: { days: {} } });
    if (init.method === 'PUT') {
      const { patch } = JSON.parse(init.body);
      accepted.values = { ...accepted.values, ...patch }; accepted.revision = 'b'.repeat(64);
    }
    return Response.json(accepted);
  };
  const plugin = createSimplePetClient(React, send);
  const render = () => { cursor = 0; tree = plugin.SimplePetSettings(); return tree; };
  const nodes = (node = tree) => typeof node !== 'object' || !node ? [] : [node, ...node.children.flatMap(nodes)];
  const text = node => typeof node === 'object' && node ? node.children.map(text).join('') : String(node ?? '');
  const find = predicate => { const n = nodes().find(predicate); assert.ok(n, 'requested UI node exists'); return n; };
  render();
  return { render, nodes, text, find, calls, accepted, cleanup() { cleanups.forEach(fn => fn?.()); } };
}

test('five card themes share the canonical bilingual-mode catalogue and immutable IDs', () => {
  assert.deepEqual(CARD_THEME_IDS, ['default','forest','amber','violet','paper']);
  assert(Object.isFrozen(CARD_THEMES)); assert(Object.isFrozen(CARD_THEME_IDS));
  const canonical = JSON.parse(readFileSync(new URL('./card-themes.json', import.meta.url)));
  assert.deepEqual(CARD_THEMES, canonical);
  for (const theme of CARD_THEMES) {
    assert(theme.name && theme.description); assert(Object.isFrozen(theme.deepseek)); assert(Object.isFrozen(theme.codex));
    for (const mode of ['deepseek','codex']) {
      assert.deepEqual(Object.keys(theme[mode]).sort(), ['start','end','border','text','muted','accent','secondary','track','badge','badgeText','divider','shadow','radius'].sort());
      for (const [key, value] of Object.entries(theme[mode])) if (key !== 'radius') assert.match(value, /^#(?:[A-F0-9]{6}|[A-F0-9]{8})$/);
      assert(theme[mode].radius >= 8 && theme[mode].radius <= 24);
    }
    assert.notDeepEqual(theme.deepseek, { ...theme.deepseek, ...theme.peak });
  }
});

test('card themes reject malformed preferences and default old saves to the original blue', () => {
  assert.equal(DEFAULT_PREFERENCES.cardTheme, 'default');
  for (const value of ['unknown','FOREST',' forest','forest ',null,[],['forest'],{},true,1]) assert.equal(preferenceValues({ cardTheme: value }).cardTheme, 'default');
  const raw = { skin: 'cherry', size: 'tiny', billingMode: 'codex', codexWarmupReset: true };
  const migrated = preferenceValues(raw);
  assert.equal(migrated.cardTheme, 'default'); assert.equal(migrated.skin, 'cherry'); assert.equal(migrated.size, 'tiny');
  assert.equal(migrated.billingMode, 'codex'); assert.equal(migrated.codexWarmupReset, true); assert.equal(migrated.codexWarmupDaily, false);
});

test('every skin combines independently with every card theme in both billing modes', () => {
  for (const skin of skins) for (const cardTheme of CARD_THEME_IDS) for (const billingMode of ['deepseek','codex']) {
    const values = preferenceValues({ skin, cardTheme, billingMode });
    assert.equal(values.skin, skin); assert.equal(values.cardTheme, cardTheme); assert.equal(values.billingMode, billingMode);
  }
});

test('each theme has independent DeepSeek peak styling and Codex never inherits peak pricing', () => {
  for (const id of CARD_THEME_IDS) {
    const theme = CARD_THEMES.find(t => t.id === id);
    assert.deepEqual(cardPalette(id, 'deepseek'), theme.deepseek);
    assert.deepEqual(cardPalette(id, 'deepseek', true), { ...theme.deepseek, ...theme.peak });
    assert.deepEqual(cardPalette(id, 'codex', true), theme.codex);
    assert.deepEqual(cardPalette(id, 'codex', false), theme.codex);
  }
  assert.deepEqual(cardPalette('missing'), cardPalette('default'));
});

test('settings CSS colours exactly match WPF ARGB and white theme uses dark text', () => {
  for (const theme of CARD_THEMES) for (const mode of ['deepseek','codex']) for (const peak of [false,true]) {
    const p = cardPalette(theme.id, mode, peak), css = cardCssVariables(theme.id, mode, peak);
    assert.equal(css['--pet-card-start'], '#' + p.start.slice(3) + p.start.slice(1,3));
    assert.equal(css['--pet-card-end'], '#' + p.end.slice(3) + p.end.slice(1,3));
    assert.equal(css['--pet-card-text'], p.text); assert.equal(css['--pet-card-radius'], `${p.radius}px`);
  }
  assert.equal(cardPalette('paper').text, '#253D35'); assert.equal(cardPalette('paper','codex').text, '#293C49');
});

test('new theme text and badge contrasts remain legible at both gradient ends', () => {
  const rgb = hex => [0,2,4].map(i => parseInt(hex.slice(-6).slice(i,i+2),16)/255);
  const lum = rgb => rgb.map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((s,v,i) => s+v*[.2126,.7152,.0722][i],0);
  const contrast = (a,b) => { const x=lum(a),y=lum(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
  const failures = [];
  for (const id of CARD_THEME_IDS.filter(id => id !== 'default')) for (const mode of ['deepseek','codex']) for (const peak of [false,true]) {
    const p = cardPalette(id, mode, peak);
    for (const end of ['start','end']) for (const desktop of [0,1]) {
      const alpha = parseInt(p[end].slice(1,3),16)/255, bg = rgb(p[end]).map(v => alpha*v+(1-alpha)*desktop);
      for (const ink of ['text','muted','accent','secondary']) if (contrast(rgb(p[ink]), bg) < 4.5) failures.push(`${id}/${mode}/${peak}/${end}/${desktop}: ${ink} contrast ${contrast(rgb(p[ink]), bg).toFixed(2)}`);
    }
    if (contrast(rgb(p.badgeText),rgb(p.badge)) < 4.5) failures.push(`${id}: badge contrast`);
  }
  assert.deepEqual(failures, [], 'new themes meet minimum 4.5:1 text contrast');
});

test('saving only a card theme is atomic, revision-checked and preserves character and coordinates', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-card-theme-'));
  t.after(async () => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert(path.basename(dir).startsWith('dsh-card-theme-')); await fs.rm(dir,{ recursive:true,force:true }); });
  const file = path.join(dir,'settings.json'), position = path.join(dir,'position.json');
  const raw = { skin:'star',size:'tiny',billingMode:'codex',codexWarmupReset:true,left:34,top:56,future:{ keep:true } };
  await fs.writeFile(file,JSON.stringify(raw)); await fs.writeFile(position,'{"left":120,"top":300}');
  const positionBytes = await fs.readFile(position), store = new PreferencesStore(file);
  let loaded = await store.read();
  for (const cardTheme of CARD_THEME_IDS) {
    loaded = await store.update({ cardTheme },loaded.revision);
    const saved = JSON.parse(await fs.readFile(file,'utf8'));
    assert.equal(saved.cardTheme,cardTheme); assert.equal(saved.skin,'star'); assert.equal(saved.size,'tiny');
    assert.equal(saved.codexWarmupReset,true); assert.equal(saved.codexWarmupDaily,false); assert.equal(saved.left,34); assert.deepEqual(saved.future,{keep:true});
  }
  const before = await fs.readFile(file);
  for (const invalid of ['missing',[],true]) await assert.rejects(store.update({ cardTheme:invalid },loaded.revision),e => e.status===400);
  await assert.rejects(store.update({ cardTheme:'forest' },'a'.repeat(64)),e => e.status===409);
  assert.deepEqual(await fs.readFile(file),before); assert.deepEqual(await fs.readFile(position),positionBytes);
  assert.deepEqual((await fs.readdir(dir)).sort(),['position.json','settings.json']);
});

for (const mode of ['deepseek','codex']) test(`native ${mode} page shows five paired themes and an independent combination preview`, async () => {
  const ui=uiHarness(mode);
  try {
    await settle(); ui.render();
    const choices=ui.nodes().filter(n => n.props['data-card-theme-choice']); assert.equal(choices.length,5);
    const preview=ui.find(n => n.props['aria-label']==='所选人物与信息框组合示意');
    assert.equal(ui.nodes(preview).filter(n => n.props['data-pet-mode']===mode).length,1);
    for (const choice of choices) {
      const cards=ui.nodes(choice).filter(n => n.props['data-pet-mode']); assert.equal(cards.length,2);
      assert.deepEqual(cards.map(n => n.props['data-pet-mode']),['deepseek','codex']);
      assert.equal(choice.props.type,'button'); choice.props.onClick(); ui.render();
      const combo=ui.find(n => n.props['aria-label']==='所选人物与信息框组合示意');
      assert.equal(ui.nodes(combo).find(n => n.props['data-pet-mode']).props['data-pet-theme'],choice.props['data-card-theme-choice']);
      assert(ui.nodes(combo).find(n => n.props.className==='pet-combination-sprite').props.style.backgroundImage.includes('/default-valley.png'));
    }
    ui.find(n => n.props.role==='radio' && ui.text(n).includes('星砂')).props.onClick(); ui.render();
    const selected=ui.find(n => n.props['data-card-theme-choice']==='paper'); assert.equal(selected.props['aria-checked'],true);
    const sprite=ui.find(n => n.props.className==='pet-combination-sprite'); assert(sprite.props.style.backgroundImage.includes('/star-valley.png'));
    assert.match(ui.text(ui.render()),/数字为示意/);
    assert.equal(ui.calls.length,2); assert(ui.calls.every(c => !c.method || c.method==='GET'));
    ui.find(n => n.type==='form').props.onSubmit({preventDefault(){}}); await settle(); ui.render();
    const writes=ui.calls.filter(c => c.method==='PUT'); assert.equal(writes.length,1);
    assert.deepEqual(JSON.parse(writes[0].body).patch,{ skin:'star', cardTheme:'paper' });
    assert.match(ui.text(ui.render()),/约 1 秒内应用/);
  } finally { ui.cleanup(); }
});

test('DeepSeek peak combination preview changes visual only and Codex switches to a fixed character', async () => {
  const ui=uiHarness();
  try {
    await settle(); ui.render(); ui.find(n => n.props['data-card-theme-choice']==='forest').props.onClick(); ui.render();
    ui.find(n => n.type==='button' && ui.text(n)==='峰时预览').props.onClick(); ui.render();
    assert(ui.find(n => n.props.className==='pet-combination-sprite').props.style.backgroundImage.includes('default-peak.png'));
    const combo=ui.find(n => n.props['aria-label']==='所选人物与信息框组合示意');
    assert.equal(ui.nodes(combo).find(n => n.props['data-pet-mode']).props.style['--pet-card-badge'],cardPalette('forest','deepseek',true).badge);
    ui.find(n => n.type==='select' && n.props.value==='deepseek').props.onChange({target:{value:'codex'}}); ui.render();
    assert(ui.find(n => n.props.className==='pet-combination-sprite').props.style.backgroundImage.includes('default-valley.png'));
    assert(!ui.nodes().some(n => n.type==='button' && ui.text(n)==='峰时预览'));
    const codex=ui.find(n => n.props['aria-label']==='所选人物与信息框组合示意'); assert.doesNotMatch(ui.text(codex),/峰|谷|¥/); assert.match(ui.text(codex),/5h|周/);
    assert.equal(ui.calls.length,2);
  } finally { ui.cleanup(); }
});

test('authenticated preference API persists a theme-only patch and rejects invalid themes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-card-theme-route-'));
  t.after(async () => { assert.equal(path.dirname(dir),path.resolve(os.tmpdir())); assert(path.basename(dir).startsWith('dsh-card-theme-route-')); await fs.rm(dir,{recursive:true,force:true}); });
  const file=path.join(dir,'settings.json'); await fs.writeFile(file,JSON.stringify({skin:'mint',billingMode:'codex'}));
  const store=new PreferencesStore(file);
  const route=preferencesHandler(store,() => true);
  async function request(method,body) {
    const req=Readable.from(body===undefined ? [] : [JSON.stringify(body)]); req.method=method; req.headers={'content-type':'application/json'};
    let status,data; const res={writeHead(s){status=s;},end(bytes){data=bytes ? JSON.parse(bytes) : null;}};
    await route(req,res); return {status,data};
  }
  const initial=await request('GET'); assert.equal(initial.data.values.cardTheme,'default');
  const saved=await request('PUT',{patch:{cardTheme:'forest'},revision:initial.data.revision});
  assert.equal(saved.status,200); assert.equal(saved.data.values.cardTheme,'forest'); assert.equal(saved.data.values.skin,'mint'); assert.equal(saved.data.values.billingMode,'codex');
  const invalid=await request('PUT',{patch:{cardTheme:['paper']},revision:saved.data.revision}); assert.equal(invalid.status,400);
  const after=await request('GET'); assert.equal(after.data.values.cardTheme,'forest'); assert.equal(after.data.revision,saved.data.revision);
  const bytes=await fs.readFile(file); await preferencesHandler(store,() => false)(Readable.from([]),{}); assert.deepEqual(await fs.readFile(file),bytes);
});

test('new native WPF theme rendering and hot-reload matrix', { skip: process.platform !== 'win32' }, () => {
  const root=fileURLToPath(new URL('.',import.meta.url));
  const result=spawnSync('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',path.join(root,'card-themes.test.ps1')],{cwd:root,stdio:'inherit'});
  assert.ifError(result.error); assert.equal(result.status,0);
});

test('built host client embeds the same five-theme catalogue without JSON or Node runtime imports', () => {
  let factory;
  const source=readFileSync(new URL('./lib/client.js',import.meta.url),'utf8');
  vm.runInNewContext(source,{window:{__ModuleLoader__:{load(v){factory=v.factory;}}}});
  assert.equal(typeof factory,'function'); assert.doesNotMatch(source,/^import /m); assert.doesNotMatch(source,/require\(['"]node:/);
  for (const theme of CARD_THEMES) { assert(source.includes(theme.name)); assert(source.includes(theme.codex.start)); }
  assert(source.includes('data-card-theme-choice')); assert(source.includes('pet-settings-theme-gallery'));
  const css=readFileSync(new URL('./client.css',import.meta.url),'utf8'); assert(css.includes('repeat(auto-fit,minmax(min(100%,260px),1fr))')); assert(css.includes('--pet-card-text'));
});
