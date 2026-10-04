import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(fileURLToPath(import.meta.url));
const newSkins = ['snow', 'mint', 'cherry', 'star'];
const hashes = [
  'f72612057927a2761129096257099e24cd8e4ca67f6bf383b8136a0e36be1ac1',
  '56439a3549190ed06aa045a0298b1647b7ff8ba46cd36e76631e8bd758882ea0',
  '6fe424763523986f143098bbdff345c494b7fb502b2a38c64d85e24ec8a04376',
  '163bc73217c8e20abdc21d88d0db30bc8ee9210bafd77afa3d7d68f474e659c5',
];
function chunks(bytes) {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const result = [];
  for (let pos = 8; pos < bytes.length;) {
    const length = bytes.readUInt32BE(pos);
    assert.ok(pos + length + 12 <= bytes.length);
    result.push({ type: bytes.toString('ascii', pos + 4, pos + 8), data: bytes.subarray(pos + 8, pos + 8 + length) });
    pos += length + 12;
  }
  return result;
}

test('six stable skin ids keep old preferences and all twelve atlases available', () => {
  const catalog = readFileSync(join(root, 'skin-catalog.ps1'), 'utf8');
  const ids = [...catalog.matchAll(/id = '([a-z]+)'/g)].map(m => m[1]);
  assert.deepEqual(ids, ['default', 'night', ...newSkins]);
  for (const id of ids) for (const mode of ['peak', 'valley']) {
    const bytes = readFileSync(join(root, 'assets', `${id}-${mode}.png`));
    assert.equal(chunks(bytes)[0].type, 'IHDR');
  }
  const pet = readFileSync(join(root, 'pet.ps1'), 'utf8');
  assert.match(pet, /\. \(Join-Path \$script:ProjectRoot 'skin-catalog\.ps1'\)/);
  assert.match(pet, /Prefs\.skin -notin @\(\$script:SkinCatalog/);
  assert.match(pet, /foreach \(\$entry in \$script:SkinCatalog\)/);
});

test('new runtime atlases have exact eight-cell RGBA layout and honest derivative credits', () => {
  const digests = new Set();
  for (const id of newSkins) for (const mode of ['peak', 'valley']) {
    const bytes = readFileSync(join(root, 'assets', `${id}-${mode}.png`));
    const parts = chunks(bytes);
    const header = parts[0].data;
    assert.equal(header.readUInt32BE(0), 1280);
    assert.equal(header.readUInt32BE(4), 640);
    assert.equal(header[9], 6, 'RGBA alpha channel is present');
    const metadata = parts.filter(p => ['tEXt', 'iTXt', 'zTXt', 'eXIf'].includes(p.type));
    const text = metadata.map(p => p.data.toString('utf8')).join('\n');
    assert.match(text, /AI-generated/);
    assert.match(text, new RegExp(`sources/${id}-source\\.png`));
    assert.doesNotMatch(text, /[A-Za-z]:\\Users\\|sk-[\w-]{20,}|gh[pousr]_[\w]{20,}/);
    assert.ok(!parts.some(p => p.type === 'caBX'), 'do not copy a signature onto edited pixels');
    digests.add(createHash('sha256').update(bytes).digest('hex'));
  }
  assert.equal(digests.size, 8, 'skins and peak/valley are distinct art files');
});

test('generated originals remain unchanged with their source provenance intact', () => {
  for (let i = 0; i < newSkins.length; i++) {
    const bytes = readFileSync(join(root, 'assets', 'sources', `${newSkins[i]}-source.png`));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hashes[i]);
    assert.ok(chunks(bytes).some(part => part.type === 'caBX'), 'preserve original AI provenance');
  }
});

test('actual local sprite loading and gallery integration', { skip: process.platform !== 'win32', timeout: 60_000 }, () => {
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'skin-assets.test.ps1')], {
    cwd: root, stdio: 'inherit', windowsHide: true, timeout: 45_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
});
