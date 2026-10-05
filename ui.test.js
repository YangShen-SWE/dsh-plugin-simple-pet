import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { normalizeCodexQuota, quotaDeltas } from './codex.js';

const root = dirname(fileURLToPath(import.meta.url));
const settingsSource = readFileSync(join(root, 'settings-window.ps1'), 'utf8');
const petSource = readFileSync(join(root, 'pet.ps1'), 'utf8');

// These source checks cover OS interactions that cannot reliably be synthesized:
// DragMove requires a physically held mouse button, and the real pet must not be
// dot-sourced because that would start timers, read preferences, and run its UI.
function assignedHandler(source, variable) {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assignment = new RegExp(`${escaped}\\s*=\\s*(?:\\[[\\w.]+\\]\\s*)?\\{`, 'i').exec(source);
  if (!assignment) return '';
  let depth = 1;
  const start = assignment.index + assignment[0].length;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i);
  }
  return '';
}

function callbackBodies(source, event) {
  const registration = new RegExp(`\\.Add_${event}\\s*\\(\\s*(?:\\[[\\w.]+\\]\\s*)?(\\{|\\$[\\w:]+)`, 'gi');
  return [...source.matchAll(registration)].map(match => {
    if (match[1] !== '{') return assignedHandler(source, match[1]);
    let depth = 1;
    const start = match.index + match[0].length;
    for (let i = start; i < source.length; i++) {
      if (source[i] === '{') depth++;
      if (source[i] === '}' && --depth === 0) return source.slice(start, i);
    }
    return '';
  });
}

test('settings expose a draggable header without dragging from every input', () => {
  assert.match(settingsSource, /<Grid\b[^>]*\bName="SettingsDragHandle"/);
  // Support either direct FindName(...).Add_* or a named variable assignment.
  const direct = /FindName\(['"]SettingsDragHandle['"]\)[\s)]*\.Add_MouseLeftButtonDown\s*\(/i.test(settingsSource);
  const assignment = /(\$[\w:]+)\s*=\s*[^\r\n]*FindName\(['"]SettingsDragHandle['"]\)/i.exec(settingsSource);
  const assigned = assignment && settingsSource.includes(`${assignment[1]}.Add_MouseLeftButtonDown`);
  assert.ok(direct || assigned, 'left-button drag must be bound to the named header');
  assert.ok(callbackBodies(settingsSource, 'MouseLeftButtonDown').some(body => /\$script:SettingsWindow\.DragMove\s*\(\s*\)/i.test(body)), 'header drag callback invokes settings DragMove');
});

test('right-click opens settings directly instead of constructing a context menu', () => {
  assert.doesNotMatch(petSource, /New-Object\s+(?:[\w.]*\.)?ContextMenu\b|\[\s*(?:[\w.]*\.)?ContextMenu\s*\]\s*::\s*new/i);
  assert.ok(callbackBodies(petSource, 'MouseRightButton(?:Up|Down)').some(body => /\bShow-PetSettings\b/.test(body)), 'right-button callback directly opens settings');
});

test('settings use an accessible local six-card gallery instead of a skin dropdown', () => {
  assert.doesNotMatch(settingsSource, /\bSkinChoice\b/);
  assert.match(settingsSource, /<UniformGrid\b[^>]*\bName="SkinGallery"[^>]*\bColumns="3"[^>]*\bRows="2"/);
  assert.match(settingsSource, /foreach\s*\(\$skin\s+in\s+\$script:SkinCatalog\)/);
  assert.match(settingsSource, /Name="SkinCard_\$id"\s+Tag="\$id"/);
  assert.match(settingsSource, /\$script:SkinButtons\[\$id\]\s*=\s*\$button/);
  assert.match(settingsSource, /AutomationProperties\.Name="\$name/);
  assert.match(settingsSource, /Focusable="True"\s+IsTabStop="True"/);
  assert.match(settingsSource, /Get-Frame\s+\$skin\s+\$mode\s+'idle'/);
  assert.match(settingsSource, /foreach\s*\(\$mode\s+in\s+@\('peak',\s*'valley'\)\)/);
  assert.match(settingsSource, /\$image\.Source\s*=\s*Get-SettingsSkinPreview\s+\$id\s+\$mode/);
  // XAML namespace identifiers are URLs, not fetches or remote image sources.
  const withoutNamespaces = settingsSource.replace(/xmlns(?::\w+)?="[^"]+"/g, '');
  assert.doesNotMatch(withoutNamespaces, /https?:\/\/|Invoke-(?:WebRequest|RestMethod)|Download(?:Data|File|String)/i);
  const handlers = callbackBodies(settingsSource, 'Click');
  const skinHandler = handlers.find(body => /\$id\s*=\s*\[string\]\$sender\.Tag/.test(body));
  assert.ok(skinHandler, 'skin click must read the sender Tag rather than a captured loop variable');
  assert.match(skinHandler, /if\s*\(\[string\]\$script:Prefs\.skin\s+-eq\s+\$id\)\s*\{\s*return\s*\}/);
  assert.equal((skinHandler.match(/\bSave-Prefs\b/g) ?? []).length, 1, 'skin click owns exactly one save');
  assert.ok(callbackBodies(settingsSource, 'PreviewKeyDown').some(body => /\[Windows\.Input\.Key\]::Enter/.test(body) && /ClickEvent/.test(body)), 'Enter activates the focused card');
});

test('settings and statistics remain reachable on smaller work areas', () => {
  assert.match(settingsSource, /<ScrollViewer\b[^>]*Name="SettingsScroll"[^>]*VerticalScrollBarVisibility="Auto"/);
  assert.match(settingsSource, /<ScrollViewer\b[^>]*Name="StatsScroll"[^>]*HorizontalScrollBarVisibility="Auto"/);
  assert.match(settingsSource, /<Canvas\b[^>]*Name="ChartCanvas"[^>]*Width="600"/);
  assert.match(settingsSource, /\$script:SettingsWindow\.Height\s*=\s*\[math\]::Min\(625,\s*\$workArea\.Height\s*-\s*20\)/);
});

test('Windows PowerShell scripts preserve UTF-8 BOM for Chinese UI text', () => {
  for (const name of ['pet.ps1', 'skin-catalog.ps1', 'skin-assets.test.ps1', 'settings-window.ps1', 'settings-window.test.ps1', 'usage-view.ps1', 'usage-view.test.ps1']) {
    assert.deepEqual([...readFileSync(join(root, name)).subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name} must have UTF-8 BOM`);
  }
});

test('native dual-mode quota presentation uses no real state', { skip: process.platform !== 'win32', timeout: 60_000 }, () => {
  const now = Date.now();
  const quota = (remainingPercent, fetchedAt) => normalizeCodexQuota({ fetchedAt, rateLimits: [{ id: 'codex', windows: [{ windowSeconds: 18000, remainingPercent, resetsAt: Math.floor(now / 1000) + 3600 }] }] }, 'fixture-a', now);
  const [delta] = quotaDeltas(quota(80, now - 1000), quota(79, now));
  assert.ok(delta);
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'usage-view.test.ps1'), '-DeltaJson', JSON.stringify(delta)], { cwd: root, stdio: 'inherit', windowsHide: true, timeout: 45_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
});

test('WPF settings interactions and cleanup', { skip: process.platform !== 'win32', timeout: 60_000 }, () => {
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
    '-File', join(root, 'settings-window.test.ps1'),
  ], {
    cwd: root,
    stdio: 'inherit', // Do not capture child stdio: the Windows sandbox forbids named pipes.
    windowsHide: true,
    timeout: 45_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'WPF test process was not terminated');
  assert.equal(result.status, 0, 'independent Windows PowerShell WPF regression test passes');
});
