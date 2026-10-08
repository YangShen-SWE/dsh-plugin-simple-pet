import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_PREFERENCES = Object.freeze({
  skin: 'default', unit: 'cny', size: 'medium', billingMode: 'deepseek', codexUnit: 'token',
  codexQuotaRefreshSeconds: 5, codexWarmupDaily: false, codexWarmupTime: '09:30',
  codexWarmupReset: false, codexWarmupStartup: false, sleepMinutes: 10,
});

const enums = {
  skin: ['default', 'night', 'snow', 'mint', 'cherry', 'star'],
  unit: ['cny', 'token'], size: ['tiny', 'small', 'medium', 'large'],
  billingMode: ['deepseek', 'codex'], codexUnit: ['token', 'percent'],
};
const bounds = { codexQuotaRefreshSeconds: [1, 3600], sleepMinutes: [1, 240] };
const booleans = new Set(['codexWarmupDaily', 'codexWarmupReset', 'codexWarmupStartup']);
const validTime = value => typeof value === 'string' && value.length === 5
  && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validValue(key, value) {
  if (hasOwn(enums, key)) return typeof value === 'string' && enums[key].includes(value);
  if (hasOwn(bounds, key)) return Number.isInteger(value) && value >= bounds[key][0] && value <= bounds[key][1];
  if (booleans.has(key)) return typeof value === 'boolean';
  return key === 'codexWarmupTime' && validTime(value);
}

// Read only own data properties: inherited values/accessors never enable automation.
export function preferenceValues(raw) {
  const values = { ...DEFAULT_PREFERENCES };
  if (!record(raw)) return values;
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  for (const key of Object.keys(DEFAULT_PREFERENCES)) {
    const descriptor = hasOwn(descriptors, key) ? descriptors[key] : undefined;
    if (descriptor && hasOwn(descriptor, 'value') && validValue(key, descriptor.value)) values[key] = descriptor.value;
  }
  const time = hasOwn(descriptors, 'codexWarmupTime') ? descriptors.codexWarmupTime : undefined;
  if (!time || !hasOwn(time, 'value') || !validTime(time.value)) values.codexWarmupDaily = false;
  return values;
}

function failure(status, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.status = status;
  return error;
}
function validatedPatch(patch) {
  if (!record(patch) || ![Object.prototype, null].includes(Object.getPrototypeOf(patch))) {
    throw failure(400, 'Preferences patch must be a plain object.');
  }
  // Also reject inherited enumerable properties on a polluted Object.prototype.
  for (const key in patch) if (!hasOwn(patch, key)) throw failure(400, 'Inherited preference keys are not allowed.');
  const result = {};
  for (const key of Reflect.ownKeys(patch)) {
    const descriptor = Object.getOwnPropertyDescriptor(patch, key);
    if (typeof key !== 'string' || !hasOwn(DEFAULT_PREFERENCES, key) || !descriptor.enumerable
      || !hasOwn(descriptor, 'value') || !validValue(key, descriptor.value)) {
      throw failure(400, 'Preferences patch contains an invalid key or value.');
    }
    result[key] = descriptor.value;
  }
  return result;
}
const revisionOf = bytes => createHash('sha256').update(bytes).digest('hex');

// Share the queue by absolute file, not instance. A failed operation cannot poison it.
const queues = new Map();
function serialized(file, operation) {
  const key = process.platform === 'win32' ? file.toLowerCase() : file;
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.then(operation);
  const tail = current.then(() => {}, () => {});
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return current;
}

export class PreferencesStore {
  constructor(file) {
    this.file = path.resolve(file);
  }

  async read() {
    return serialized(this.file, async () => {
      const { raw, revision } = await this.#readFile();
      return { values: preferenceValues(raw), revision };
    });
  }

  async #readFile() {
    let bytes;
    try { bytes = await fs.readFile(this.file); }
    catch (error) {
      if (error.code === 'ENOENT') return { raw: {}, revision: 'missing' };
      throw failure(503, 'Preferences file could not be read.', error);
    }
    try {
      const raw = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
      if (!record(raw)) throw new Error('Preferences JSON must be an object.');
      return { raw, revision: revisionOf(bytes) };
    } catch (error) { throw failure(503, 'Preferences file contains malformed JSON.', error); }
  }

  async update(patch, expectedRevision) {
    const changes = validatedPatch(patch);
    if (typeof expectedRevision !== 'string' || (expectedRevision !== 'missing'
      && (expectedRevision.length !== 64 || !/^[a-f0-9]{64}$/.test(expectedRevision)))) {
      throw failure(400, 'A valid expected preference revision is required.');
    }
    return serialized(this.file, async () => {
      const { raw, revision } = await this.#readFile();
      if (revision !== expectedRevision) throw failure(409, 'Preferences changed; reload before saving.');
      const values = { ...preferenceValues(raw), ...changes };
      // Do not silently activate a default schedule in place of a malformed saved time.
      const time = hasOwn(changes, 'codexWarmupTime') ? changes.codexWarmupTime
        : hasOwn(raw, 'codexWarmupTime') ? raw.codexWarmupTime : DEFAULT_PREFERENCES.codexWarmupTime;
      if (values.codexWarmupDaily && !validTime(time)) {
        throw failure(400, 'Daily warm-up requires a valid HH:mm time.');
      }
      const bytes = Buffer.from(`${JSON.stringify({ ...raw, ...values }, null, 2)}\n`, 'utf8');
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      let created = false;
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        created = true;
        await fs.rename(temporary, this.file);
      } catch (error) {
        // writeFile can leave a partial file before rejecting. Never remove a collided file.
        if (created || error.code !== 'EEXIST') await fs.unlink(temporary).catch(() => {});
        throw failure(503, 'Preferences file could not be saved.', error);
      }
      return { values, revision: revisionOf(bytes) };
    });
  }
}
