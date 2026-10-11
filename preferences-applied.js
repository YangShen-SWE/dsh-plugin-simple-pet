import fs from 'node:fs/promises';
import { DEFAULT_PREFERENCES } from './preferences.js';

export const APPLICATION_LEASE_MS = 15_000;
const MAX_RECEIPT_BYTES = 32_768;
const KEYS = Object.keys(DEFAULT_PREFERENCES);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const timestamp = value => Number.isSafeInteger(value) && value > 0;
const owned = runtime => object(runtime) && runtime.active === true && uuid(runtime.runId)
  && Number.isSafeInteger(runtime.pid) && runtime.pid > 0;
const sameRun = (a, b) => owned(a) && owned(b) && a.pid === b.pid && a.runId === b.runId;

// Read bounded local bytes only. No process discovery, preference writes or upstream calls.
export async function readApplicationReceipt(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES) return null;
    const bytes = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_RECEIPT_BYTES) return null;
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, ''));
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}

export function applicationEvidence(preferences, receipt, runtime, profile, now) {
  const base = { revision: preferences.revision, status: 'unconfirmed', observedAt: now };
  if (!owned(runtime)) return { ...base, status: 'offline' };
  if (!object(receipt) || receipt.version !== 1 || receipt.profile !== profile
    || receipt.runId !== runtime.runId || receipt.pid !== runtime.pid
    || !timestamp(receipt.heartbeatAt) || receipt.heartbeatAt > now
    || now - receipt.heartbeatAt >= APPLICATION_LEASE_MS) return base;
  if (receipt.status === 'pending') return { ...base, status: 'pending' };
  if (receipt.status !== 'applied' || !timestamp(receipt.appliedAt)
    || receipt.appliedAt > receipt.heartbeatAt || preferences.revision === 'missing'
    || receipt.revision !== preferences.revision || !object(receipt.values)
    || Object.keys(receipt.values).length !== KEYS.length
    || KEYS.some(key => !Object.hasOwn(receipt.values, key)
      || receipt.values[key] !== preferences.values[key])) return base;
  return { ...base, status: 'applied', appliedAt: receipt.appliedAt, heartbeatAt: receipt.heartbeatAt,
    validForMs: APPLICATION_LEASE_MS - (now - receipt.heartbeatAt) };
}

export function applicationHandler({ store, receiptFile, profile, runtime, authorize,
  clock = Date.now, readReceipt = readApplicationReceipt }) {
  return async function handler(req, res) {
    if (!authorize(req, res)) return;
    const method = req.method ?? 'GET';
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(method === 'HEAD' ? undefined : JSON.stringify(body));
    };
    if (method !== 'GET' && method !== 'HEAD') return send(405, { error: '仅允许 GET、HEAD。' });
    try {
      const before = await store.read();
      const initialRun = runtime();
      const receipt = owned(initialRun) ? await readReceipt(receiptFile) : null;
      const current = await store.read();
      const now = clock(), latestRun = runtime();
      if (current.revision !== before.revision) return send(200, { revision: current.revision, status: 'unconfirmed', observedAt: now });
      const evidence = applicationEvidence(current, receipt, latestRun, profile, now);
      if (!sameRun(initialRun, latestRun) && evidence.status === 'applied') {
        return send(200, { revision: current.revision, status: 'unconfirmed', observedAt: now });
      }
      send(200, evidence);
    } catch {
      send(503, { error: '设置应用状态暂不可确认。' });
    }
  };
}
