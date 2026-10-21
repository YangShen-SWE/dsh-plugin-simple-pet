import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const LIMIT = 256 * 1024;
const plain = x => x && typeof x === 'object' && !Array.isArray(x) && [Object.prototype, null].includes(Object.getPrototypeOf(x));
const failure = code => Object.assign(new Error(code), { code });
async function read(file) {
  let handle;
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > LIMIT) throw failure('SUBSCRIPTION_SETTINGS_INVALID');
    handle = await fs.open(file, 'r');
    const bytes = Buffer.alloc(LIMIT + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > LIMIT) throw failure('SUBSCRIPTION_SETTINGS_INVALID');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)));
    if (!plain(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !plain(value.values)) throw failure('SUBSCRIPTION_SETTINGS_INVALID');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw failure('SUBSCRIPTION_SETTINGS_INVALID'); }
  finally { await handle?.close(); }
}

// Independent subscription preference ownership, not the Desktop Pet Loader
// entry. Only the upstream schema's preferences are accepted here; account grants
// and reset records are never arguments to this store.
export async function createSubscriptionSettings({ file, schema, seed = {} }) {
  if (typeof schema !== 'function' || !plain(seed)) throw failure('SUBSCRIPTION_SETTINGS_INVALID');
  const validate = value => {
    if (!plain(value) || Object.keys(value).some(k => ['__proto__','prototype','constructor'].includes(k))) throw failure('SUBSCRIPTION_SETTINGS_INVALID');
    try {
      const result = schema(structuredClone(value));
      if (!plain(result)) throw new Error();
      // DSH volatile schema fields are public get() cells, not JSON values.
      // Match the upstream settings adapter's unwrapping before persistence.
      return structuredClone(Object.fromEntries(Object.entries(result).map(([key, value]) =>
        [key, typeof value?.get === 'function' ? value.get() : value])));
    } catch { throw failure('SUBSCRIPTION_SETTINGS_INVALID'); }
  };
  const loaded = await read(file);
  let state = { version: 1, revision: loaded?.revision ?? 0, values: validate(loaded?.values ?? seed) };
  let disposed = false, queue = Promise.resolve();
  const listeners = new Set();
  const assertAlive = () => { if (disposed) throw failure('SUBSCRIPTION_SETTINGS_CLOSED'); };
  return Object.freeze({
    get writable() { return !disposed; },
    get() { assertAlive(); return structuredClone(state.values); },
    watch(listener) { assertAlive(); if (typeof listener !== 'function') throw new TypeError('listener'); listeners.add(listener); return () => listeners.delete(listener); },
    update(patch) {
      const run = async () => {
        assertAlive();
        if (!plain(patch)) throw failure('SUBSCRIPTION_SETTINGS_INVALID');
        const previousValues = structuredClone(state.values);
        const nextValues = validate({ ...state.values, ...patch });
        await fs.mkdir(dirname(file), { recursive: true });
        let lock, temp, committed = false;
        try {
          try { lock = await fs.open(file + '.lock', 'wx', 0o600); }
          catch { throw failure('SUBSCRIPTION_SETTINGS_BUSY'); }
          const latest = await read(file);
          if ((latest?.revision ?? 0) !== state.revision || JSON.stringify(validate(latest?.values ?? seed)) !== JSON.stringify(state.values)) throw failure('SUBSCRIPTION_SETTINGS_CHANGED');
          const next = { version: 1, revision: state.revision + 1, values: nextValues };
          const body = JSON.stringify(next);
          if (Buffer.byteLength(body) > LIMIT) throw failure('SUBSCRIPTION_SETTINGS_INVALID');
          temp = file + '.' + randomUUID() + '.tmp';
          const output = await fs.open(temp, 'wx', 0o600);
          try { await output.writeFile(body); await output.sync(); } finally { await output.close(); }
          assertAlive();
          await fs.rename(temp, file); committed = true; state = next;
        } finally {
          if (temp && !committed) await fs.unlink(temp).catch(() => {});
          if (lock) { await lock.close(); await fs.unlink(file + '.lock').catch(() => {}); }
        }
        for (const listener of listeners) { try { listener(structuredClone(state.values), structuredClone(previousValues)); } catch { /* observer cannot undo committed preferences */ } }
        return structuredClone(state.values);
      };
      const result = queue.then(run); queue = result.catch(() => {}); return result;
    },
    dispose() { disposed = true; listeners.clear(); },
  });
}
