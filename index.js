import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isPeak, priceUsage } from './billing.js';
import { addUsage, loadLedger, seedFromRecentEvents } from './stats.js';
import { CODEX_PROVIDERS, codexTokenItems, readCodexQuota, quotaDeltas } from './codex.js';
import { CodexWarmupScheduler } from './warmup.js';
import { runCodexWarmup } from './warmup-call.js';

export const name = 'dsh-plugin-simple-pet';
export const inject = ['sessions', 'credentials', 'settings', 'llm'];

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = '/api/dsh-plugin-simple-pet/state';
const ASSETS = new Set(['default', 'night', 'snow', 'mint', 'cherry', 'star']
  .flatMap(skin => ['valley', 'peak'].map(mode => `${skin}-${mode}`)));
const DEEPSEEK_PROVIDERS = new Set(['deepseek-official', 'deepseek-account']);
const MAX_EVENTS = 256;
// Shared preferences represent one local schedule even if multiple profile contexts mount in this host.
const WARMUP_OWNERS = new Map();

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

async function fetchAccountBalance(ctx) {
  const account = ctx.get?.('deepseekAccount');
  if (!account) return { status: 'unavailable', balance: null };
  const details = await account.getBalance({
    version: process.env.DSH_CLIENT_VERSION || '0.2.0-rc.2',
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  });
  if (details === null) return { status: 'unavailable', balance: null };
  if (details.status !== 'ready') throw new Error('account balance unavailable');
  const wallets = [...(details.value ?? []), ...(details.bonusWallets ?? [])].filter(item => item.currency === 'CNY');
  if (!wallets.length) return { status: 'unavailable', balance: null };
  const balance = wallets.reduce((sum, item) => sum + Number(item.balance), 0);
  if (!Number.isFinite(balance) || balance < 0) throw new Error('invalid account CNY balance');
  return { status: 'ready', balance };
}

export function launchPetProcess({ root = ROOT, profile = 'desktop', platform = process.platform, spawnProcess = spawn, logger } = {}) {
  if (platform !== 'win32' || profile !== 'desktop') return () => {};
  let stopped = false;
  let child;
  try {
    child = spawnProcess('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden',
      '-File', join(root, 'pet.ps1'), '-DshProfile', profile,
    ], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    logger?.warn?.('simple-pet: could not start the pet window: %o', error);
    return () => {};
  }
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-2048); });
  child.on('error', error => {
    if (!stopped) logger?.warn?.('simple-pet: could not start the pet window: %o', error);
  });
  child.on('exit', code => {
    if (!stopped && code !== 0) logger?.warn?.('simple-pet: pet window exited with code %s: %s', code, stderr.trim());
  });
  child.unref();
  return () => {
    stopped = true;
    if (child.pid && child.exitCode === null && !child.killed) child.kill();
  };
}

export function apply(ctx, { petLauncher = launchPetProcess, warmupClock = Date.now } = {}) {
  let live = true;
  const instance = randomUUID();
  const profile = (process.env.DSH_PET_PROFILE || process.env.DSH_PROFILE || 'desktop').replace(/[^a-zA-Z0-9_-]/g, '');
  const dataDir = join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || ROOT, 'AppData', 'Local'), 'DshSimpleDesktopPet');
  const stateFile = join(dataDir, `state-${profile}.json`);
  const statsFile = join(dataDir, `stats-${profile}.json`);
  const codexStatsFile = join(dataDir, `stats-codex-${profile}.json`);
  const prefsFile = join(dataDir, 'settings.json');
  const warmupFile = join(dataDir, 'warmup.json');
  let storedWarmup = null, warmupJournalReadable = true;
  try {
    storedWarmup = JSON.parse(readFileSync(warmupFile, 'utf8'));
    warmupJournalReadable = storedWarmup?.version === 1 && Array.isArray(storedWarmup.keys)
      && storedWarmup.keys.every(key => typeof key === 'string' && !/[\r\n]/.test(key)
        && /^(?:daily:\d{4}-\d{2}-\d{2}|reset:[a-f0-9]{16}:\d{10,16})$/.test(key));
  } catch (error) { warmupJournalReadable = error.code === 'ENOENT'; }
  let storedCodexStats = null;
  try { storedCodexStats = JSON.parse(readFileSync(codexStatsFile, 'utf8')); } catch { /* independent new ledger */ }
  const codexLedger = loadLedger(storedCodexStats);
  let codex = { status: 'unsupported', fiveHour: null, weekly: null, observedAt: null };
  let codexBridge = null;
  let codexBusy = false;
  let codexProvider = 'openai-codex';
  let codexRevision = 0;
  let bridgeRevision = 0;
  let quotaRefreshTimer = null;
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
  // Query the signed-in account wallet immediately, even before a model call.
  let balanceProvider = 'deepseek-account';
  let balanceRevision = 0;
  let lastConfirmedBalance = null;
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
  let snapshotTask = null;
  let warmupUsageDirty = false;
  let warmupQuota = null;
  let warmupPollAt = 0;
  const warmup = new CodexWarmupScheduler({ journal: storedWarmup, signal: controller.signal, clock: warmupClock,
    onChange() { if (live) snapshot(); },
    async save(journal) {
      if (!warmupJournalReadable) throw new Error('existing warm-up journal unavailable');
      if (!WARMUP_OWNERS.has(warmupFile)) WARMUP_OWNERS.set(warmupFile, instance);
      if (WARMUP_OWNERS.get(warmupFile) !== instance) throw new Error('another local warm-up scheduler owns the journal');
      await mkdir(dataDir, { recursive: true });
      const temporary = `${warmupFile}.${instance}.tmp`;
      await writeFile(temporary, JSON.stringify(journal), { mode: 0o600 });
      await rename(temporary, warmupFile);
    },
    async getQuota({ force, signal }) {
      if (!live || !codexBridge) throw new Error('subscription bridge unavailable');
      const bridge = codexBridge, generation = bridgeRevision;
      const now = warmupClock();
      if (!force && codex.provider === 'openai-codex' && codex.observedAt === warmupQuota?.observedAt) return warmupQuota;
      if (!force && codex.provider === 'openai-codex' && codex.observedAt > 0) return codex;
      if (!force && warmupQuota && now - warmupPollAt < 60_000) return warmupQuota;
      const current = await readCodexQuota(bridge, signal, now, 'openai-codex', { force });
      if (!live || generation !== bridgeRevision || bridge !== codexBridge) throw new Error('subscription bridge changed');
      warmupQuota = current; warmupPollAt = now;
      if (codexProvider === 'openai-codex') {
        for (const delta of quotaDeltas(codex, current)) push(delta);
        codex = current; snapshot();
      }
      return current;
    },
    async run({ quota, signal }) {
      const bridge = codexBridge, generation = bridgeRevision;
      if (!live || !bridge) throw new Error('subscription bridge unavailable');
      const result = await runCodexWarmup({ llm: ctx.llm, bridge, quota, signal,
        onUsage(usage, model) {
          const items = codexTokenItems(usage), at = warmupClock();
          if (!items.length) return;
          addUsage(codexLedger, usage, { items: [] }, at); warmupUsageDirty = true;
          if (live) {
            for (const item of items) push({ ...item, model, at, warmup: true });
            snapshot();
          }
        },
      });
      if (!live || generation !== bridgeRevision || bridge !== codexBridge) throw new Error('subscription bridge changed');
      warmupQuota = null; warmupPollAt = 0;
      // Refresh the real report after the call, without inferring a new deadline from tokens or completion.
      void pollCodex(true);
      return result;
    },
  });
  let prefsReading = false;
  async function pollWarmup() {
    if (!live || prefsReading || profile !== 'desktop' || process.platform !== 'win32') return;
    prefsReading = true;
    let raw;
    try { raw = JSON.parse((await readFile(prefsFile, 'utf8')).replace(/^\uFEFF/, '')); }
    catch { raw = null; }
    finally { prefsReading = false; }
    if (!live) return;
    const before = JSON.stringify(warmup.view);
    try { await warmup.tick(raw); } catch { /* scheduler never escalates an automatic request */ }
    if (live && before !== JSON.stringify(warmup.view)) snapshot();
  }

  async function writeSnapshot() {
    if (writing || !live) return;
    writing = true;
    try {
      await mkdir(dataDir, { recursive: true });
      while (writeRequested && live) {
        writeRequested = false;
        const body = JSON.stringify({ instance, seq: sequence, events, balance, balanceStatus, cacheHitRate, peak: isPeak(), stats: ledger, codex, codexStats: codexLedger, codexWarmup: warmup.view, updatedAt: Date.now() });
        const codexTemporary = `${codexStatsFile}.${instance}.tmp`;
        await writeFile(codexTemporary, JSON.stringify(codexLedger), { mode: 0o600 });
        await rename(codexTemporary, codexStatsFile);
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
  function snapshot() { writeRequested = true; if (!writing) snapshotTask = writeSnapshot(); }

  function push(event) {
    events.push({ billingMode: 'deepseek', ...event, seq: ++sequence });
    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
    snapshot();
  }

  async function pollBalance() {
    if (!live || pollBusy) return;
    pollBusy = true;
    const provider = balanceProvider;
    const revision = balanceRevision;
    try {
      const result = provider === 'deepseek-account'
        ? await fetchAccountBalance(ctx)
        : await fetchOfficialBalance(ctx, controller.signal);
      if (!live || revision !== balanceRevision) return;
      if (result.status === 'ready' && lastConfirmedBalance !== null && result.balance > lastConfirmedBalance + 0.000001) {
        push({ kind: 'recharge', tokens: 0, cny: null, peak: isPeak(), at: Date.now() });
      }
      balanceStatus = result.status;
      balance = result.balance;
      lastConfirmedBalance = result.balance;
      if (balance > 0) depletedShown = false;
      if (balance === 0 && !depletedShown) {
        push({ kind: 'depleted', tokens: 0, cny: null, peak: isPeak(), at: Date.now() });
        depletedShown = true;
      }
      snapshot();
    } catch {
      if (live && revision === balanceRevision) {
        balanceStatus = balance === null ? 'unavailable' : 'stale';
        snapshot();
      }
    } finally {
      pollBusy = false;
      if (live && revision !== balanceRevision) void pollBalance();
    }
  }

  async function pollCodex(force = false) {
    if (!live || codexBusy || !codexBridge) return;
    codexBusy = true;
    const revision = codexRevision, bridgeGeneration = bridgeRevision;
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
      const current = await readCodexQuota(codexBridge, signal, Date.now(), codexProvider, { force: force === true });
      if (!live || revision !== codexRevision || bridgeGeneration !== bridgeRevision) return;
      for (const delta of quotaDeltas(codex, current)) push(delta);
      codex = current;
    } catch {
      if (!live || revision !== codexRevision || bridgeGeneration !== bridgeRevision) return;
      codex = { ...codex, status: codex.fiveHour || codex.weekly ? 'stale' : 'unavailable' };
    } finally {
      codexBusy = false;
      if (live) snapshot();
      if (live && (revision !== codexRevision || bridgeGeneration !== bridgeRevision)) void pollCodex();
    }
  }
  ctx.inject(['connection'], quotaCtx => {
    if (typeof quotaCtx.connection.createSharedFetchHandler !== 'function') return;
    const bridge = quotaCtx.connection.createSharedFetchHandler('/api');
    bridgeRevision++;
    codexBridge = bridge;
    codex = { status: 'loading', fiveHour: null, weekly: null, observedAt: null };
    void pollCodex();
    const quotaTimer = setInterval(pollCodex, 60_000);
    quotaCtx.effect(() => () => {
      clearInterval(quotaTimer);
      if (codexBridge === bridge) {
        bridgeRevision++;
        codexBridge = null;
        warmup.active?.abort();
        warmupQuota = null; warmupPollAt = 0;
        codex = { status: 'unsupported', fiveHour: null, weekly: null, observedAt: null };
        snapshot();
      }
    }, 'simple-pet: read-only subscription bridge');
  });

  ctx.on('session/event', (session, event) => {
    if (!live || event.type !== 'assistant/message') return;
    if (typeof session.firstLiveSeq === 'number' && event.seq < session.firstLiveSeq) return;
    const source = event.data?.message?.source;
    if (source?.kind !== 'model' || (!DEEPSEEK_PROVIDERS.has(source.provider) && !CODEX_PROVIDERS.has(source.provider))) return;
    const key = `${session.id}:${event.seq}`;
    if (seen.has(key)) return;
    seen.add(key);
    seenQueue.push(key);
    if (seenQueue.length > 512) seen.delete(seenQueue.shift());
    const at = Number.isFinite(new Date(event.time).getTime()) ? new Date(event.time).getTime() : Date.now();
    if (CODEX_PROVIDERS.has(source.provider)) {
      if (codexProvider !== source.provider) {
        codexProvider = source.provider;
        codexRevision++;
        codex = { status: 'loading', fiveHour: null, weekly: null, observedAt: null };
        void pollCodex();
      }
      const items = codexTokenItems(event.data?.usage);
      if (!items.length) return;
      addUsage(codexLedger, event.data?.usage, { items: [] }, at);
      for (const item of items) push({ ...item, model: source.model, at });
      if (quotaRefreshTimer === null) quotaRefreshTimer = setTimeout(() => {
        quotaRefreshTimer = null;
        void pollCodex();
      }, 2000);
      snapshot();
      return;
    }
    const priced = priceUsage(source.model, event.data?.usage, at);
    if (!priced.items.length) return;
    if (balanceProvider !== source.provider) {
      balanceProvider = source.provider;
      balanceRevision++;
      balance = null;
      lastConfirmedBalance = null;
      balanceStatus = 'loading';
      depletedShown = false;
      void pollBalance();
    }
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
      json(res, 200, { seq: sequence, events: events.filter(e => e.seq > since), balance, balanceStatus, cacheHitRate, peak: isPeak(), stats: ledger, codex, codexStats: codexLedger, codexWarmup: warmup.view }, method);
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
  const warmupTimer = setInterval(pollWarmup, 5000);
  void pollWarmup();
  snapshot();
  pollBalance();
  ctx.effect(() => petLauncher({ root: ROOT, profile, logger: ctx.logger }), 'deepseek-pet: window');
  ctx.effect(() => async () => {
    live = false; clearInterval(timer); clearInterval(heartbeat); clearInterval(warmupTimer);
    clearTimeout(quotaRefreshTimer); controller.abort(); await warmup.stop(); await snapshotTask;
    if (warmupUsageDirty) {
      try {
        await mkdir(dataDir, { recursive: true });
        const temporary = `${codexStatsFile}.${instance}.drain.tmp`;
        await writeFile(temporary, JSON.stringify(codexLedger), { mode: 0o600 });
        await rename(temporary, codexStatsFile);
      } catch { ctx.logger?.warn?.('simple-pet: could not persist drained Codex usage'); }
    }
    if (WARMUP_OWNERS.get(warmupFile) === instance) WARMUP_OWNERS.delete(warmupFile);
  }, 'deepseek-pet: lifetime');
}
