import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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
