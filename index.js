import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isPeak, priceUsage } from './billing.js';
import { addUsage, loadLedger, seedFromRecentEvents } from './stats.js';

export const name = 'dsh-plugin-simple-pet';
export const inject = ['sessions', 'credentials', 'settings', 'llm'];

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = '/api/dsh-plugin-simple-pet/state';
const ASSETS = new Set(['default-valley', 'default-peak', 'night-valley', 'night-peak']);
const MAX_EVENTS = 256;

function json(res, status, body, method = 'GET') {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(method === 'HEAD' ? undefined : JSON.stringify(body));
}

function guard(ctx, req, res) {
  let code = 403;
  try { code = ctx.connection?.requestRejection(req); } catch { /* fail closed */ }
  if (code === undefined) return true;
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(code === 401 ? 'unauthorized' : 'forbidden');
  return false;
}

function resolveKeyRef(ctx) {
  try {
    const descriptor = ctx.llm.listConfigurableProviders().find(p => p.provider === 'deepseek-official');
    if (!descriptor || descriptor.error || descriptor.settingsNs !== 'llm-deepseek') return null;
    let profile = ctx.settings.describe().find(p => p.ns === descriptor.settingsNs)?.value;
    for (const key of descriptor.settingsPath ?? []) profile = profile?.[key];
    const ref = typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv ? profile.apiKeyEnv : 'DEEPSEEK_API_KEY';
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref) ? ref : null;
  } catch { return null; }
}

async function fetchOfficialBalance(ctx, signal) {
  const ref = resolveKeyRef(ctx);
  if (!ref) return { status: 'unavailable', balance: null };
  // CredentialRef is a branded string at runtime; keep this bundle dependency-free.
  const resolved = await ctx.credentials.resolve(ref);
  if (!resolved?.value) return { status: 'unavailable', balance: null };
  const response = await fetch('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${resolved.value}` }, signal,
  });
  if (!response.ok) throw new Error(`balance HTTP ${response.status}`);
  const data = await response.json();
  const cny = data?.balance_infos?.find(item => item.currency === 'CNY')?.total_balance;
  const balance = Number(cny);
  if (!Number.isFinite(balance) || balance < 0) throw new Error('invalid CNY balance');
  return { status: 'ready', balance };
}

export function apply(ctx) {
  let live = true;
  const instance = randomUUID();
  const profile = (process.env.DSH_PET_PROFILE || process.env.DSH_PROFILE || 'desktop').replace(/[^a-zA-Z0-9_-]/g, '');
  const dataDir = join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || ROOT, 'AppData', 'Local'), 'DshSimpleDesktopPet');
  const stateFile = join(dataDir, `state-${profile}.json`);
  const statsFile = join(dataDir, `stats-${profile}.json`);
  let storedStats = null;
  try { storedStats = JSON.parse(readFileSync(statsFile, 'utf8')); } catch { /* first launch */ }
  const ledger = loadLedger(storedStats);
  if (storedStats === null) {
    try { seedFromRecentEvents(ledger, JSON.parse(readFileSync(stateFile, 'utf8')).events); } catch { /* no previous snapshot */ }
  }
  let sequence = 0;
  let events = [];
  let balance = null;
  let balanceStatus = 'loading';
  let lastOfficialBalance = null;
  let depletedShown = false;
  let cacheHitRate = null;
  let pollBusy = false;
  let lastCallAt = 0;
  let burstCount = 0;
  const seen = new Set();
  const seenQueue = [];
  const controller = new AbortController();
  let writeRequested = false;
  let writing = false;

  async function writeSnapshot() {
    if (writing || !live) return;
    writing = true;
    try {
      await mkdir(dataDir, { recursive: true });
      while (writeRequested && live) {
        writeRequested = false;
        const body = JSON.stringify({ instance, seq: sequence, events, balance, balanceStatus, cacheHitRate, peak: isPeak(), stats: ledger, updatedAt: Date.now() });
        const temporary = `${stateFile}.${instance}.tmp`;
        const statsTemporary = `${statsFile}.${instance}.tmp`;
        await writeFile(statsTemporary, JSON.stringify(ledger), { mode: 0o600 });
        await rename(statsTemporary, statsFile);
        await writeFile(temporary, body, { mode: 0o600 });
        await rename(temporary, stateFile);
      }
    } catch { /* Desktop window shows its last good snapshot until the next write. */ }
    finally { writing = false; }
  }
  function snapshot() { writeRequested = true; void writeSnapshot(); }

  function push(event) {
    events.push({ ...event, seq: ++sequence });
    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
    snapshot();
  }

  async function pollBalance() {
    if (!live || pollBusy) return;
    pollBusy = true;
    try {
      const result = await fetchOfficialBalance(ctx, controller.signal);
      if (!live) return;
      if (result.status === 'ready' && lastOfficialBalance !== null && result.balance > lastOfficialBalance + 0.000001) {
        push({ kind: 'recharge', tokens: 0, cny: null, peak: isPeak(), at: Date.now() });
      }
      balanceStatus = result.status;
      balance = result.balance;
      lastOfficialBalance = result.balance;
      if (balance > 0) depletedShown = false;
      if (balance === 0 && !depletedShown) {
        push({ kind: 'depleted', tokens: 0, cny: null, peak: isPeak(), at: Date.now() });
        depletedShown = true;
      }
      snapshot();
    } catch {
      if (live) balanceStatus = balance === null ? 'unavailable' : 'stale';
      snapshot();
    } finally { pollBusy = false; }
  }

  ctx.on('session/event', (session, event) => {
    if (!live || event.type !== 'assistant/message') return;
    if (typeof session.firstLiveSeq === 'number' && event.seq < session.firstLiveSeq) return;
    const source = event.data?.message?.source;
    if (source?.kind !== 'model' || source.provider !== 'deepseek-official') return;
    const key = `${session.id}:${event.seq}`;
    if (seen.has(key)) return;
    seen.add(key);
    seenQueue.push(key);
    if (seenQueue.length > 512) seen.delete(seenQueue.shift());
    const at = Number.isFinite(new Date(event.time).getTime()) ? new Date(event.time).getTime() : Date.now();
    const priced = priceUsage(source.model, event.data?.usage, at);
    if (!priced.items.length) return;
    cacheHitRate = priced.cacheHitRate;
    addUsage(ledger, event.data?.usage, priced, at);
    for (const item of priced.items) {
      push({ ...item, model: source.model, peak: priced.peak, at });
      if (item.cny !== null && balance !== null) balance = Math.max(0, balance - item.cny);
    }
    const now = Date.now();
    burstCount = now - lastCallAt <= 4000 ? burstCount + 1 : 1;
    lastCallAt = now;
    if (burstCount === 2) push({ kind: 'combo', tokens: 0, cny: null, peak: priced.peak, at });
    if (balance === 0 && !depletedShown) {
      push({ kind: 'depleted', tokens: 0, cny: null, peak: priced.peak, at });
      depletedShown = true;
    }
    snapshot();
  });

  ctx.inject(['webServer', 'connection'], routeCtx => {
    routeCtx.effect(() => routeCtx.webServer.register({ kind: 'exact', path: STATE_PATH, handler(req, res) {
      if (!guard(routeCtx, req, res)) return;
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') return json(res, 405, { error: 'method not allowed' }, method);
      const raw = new URL(req.url ?? STATE_PATH, 'http://localhost').searchParams.get('since');
      if (raw !== null && !/^(0|[1-9]\d*)$/.test(raw)) return json(res, 400, { error: 'invalid since' }, method);
      const since = raw === null ? sequence : Number(raw);
      if (!Number.isSafeInteger(since)) return json(res, 400, { error: 'invalid since' }, method);
      json(res, 200, { seq: sequence, events: events.filter(e => e.seq > since), balance, balanceStatus, cacheHitRate, peak: isPeak(), stats: ledger }, method);
    } }), 'deepseek-pet: state route');
    for (const asset of ASSETS) {
      const path = `/api/dsh-plugin-simple-pet/asset/${asset}.png`;
      routeCtx.effect(() => routeCtx.webServer.register({ kind: 'exact', path, async handler(req, res) {
        if (!guard(routeCtx, req, res)) return;
        const method = req.method ?? 'GET';
        if (method !== 'GET' && method !== 'HEAD') return json(res, 405, { error: 'method not allowed' }, method);
        try {
          const bytes = await readFile(join(ROOT, 'assets', `${asset}.png`));
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=86400', 'Content-Length': bytes.length });
          res.end(method === 'HEAD' ? undefined : bytes);
        } catch { json(res, 500, { error: 'asset unavailable' }, method); }
      } }), `deepseek-pet: ${asset} image`);
    }
  });

  const timer = setInterval(pollBalance, 60_000);
  const heartbeat = setInterval(snapshot, 30_000);
  snapshot();
  pollBalance();
  ctx.effect(() => () => { live = false; clearInterval(timer); clearInterval(heartbeat); controller.abort(); }, 'deepseek-pet: lifetime');
}
