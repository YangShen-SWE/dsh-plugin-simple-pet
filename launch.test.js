import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { join } from 'node:path';
import { launchPetProcess } from './index.js';

test('DSH desktop activation launches the Windows pet and disposal closes it', () => {
  const child = new EventEmitter();
  child.pid = 42;
  child.exitCode = null;
  child.killed = false;
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.unref = () => { child.unreferenced = true; };
  child.kill = () => { child.killed = true; };
  let launched;
  const stop = launchPetProcess({
    root: 'C:\\Program Files\\DSH Pet', profile: 'desktop', platform: 'win32',
    spawnProcess(command, args, options) {
      launched = { command, args, options };
      return child;
    },
  });
  assert.equal(launched.command, 'powershell.exe');
  assert.deepEqual(launched.args.slice(-4), ['-File', join('C:\\Program Files\\DSH Pet', 'pet.ps1'), '-DshProfile', 'desktop']);
  assert.equal(launched.options.windowsHide, true);
  assert.equal(launched.options.cwd, 'C:\\Program Files\\DSH Pet');
  assert.equal(child.unreferenced, true);
  stop();
  assert.equal(child.killed, true);
});

test('non-Windows profiles do not spawn a Windows window', () => {
  for (const [platform, profile] of [['linux', 'desktop'], ['win32', 'web']]) {
    launchPetProcess({ platform, profile, spawnProcess() { assert.fail('unexpected spawn'); } })();
  }
});
