import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isPeak, priceUsage } from './billing.js';
import { addUsage, loadLedger, seedFromRecentEvents } from './stats.js';
import { CODEX_PROVIDERS, codexTokenItems, readCodexQuota, quotaDeltas } from './codex.js';
import { CodexWarmupScheduler, loadWarmupJournal } from './warmup.js';
import { warmupAfterAccountSwitch, multiBlocksLegacy, legacyBlocksMulti } from './warmup-safety.js';
export { warmupAfterAccountSwitch, multiBlocksLegacy, legacyBlocksMulti };
import { runCodexWarmup } from './warmup-call.js';
import { PreferencesStore, preferenceValues } from './preferences.js';
import { startPanelAccounts, createPanelCycle } from './panel-accounts.js';
import { preferencesHandler } from './preferences-route.js';
import { applicationHandler } from './preferences-applied.js';
import { identityEvidence, panelIdentityEvidence, accountIdentityHandler } from './codex-identity.js';
import { createAccountControl } from './account-control.js';
import { MultiWarmupStore, MultiWarmupScheduler, multiWarmupHandler } from './multi-warmup.js';
import { discoverBoundAccounts, runBoundWarmup } from './multi-warmup-provider.js';
import { officialAccountRpc, readOfficialQuota, discoverOfficialAccounts, runOfficialWarmup, officialAccountsProxy } from './official-accounts.js';
import { createEmbeddedSubscription } from './embedded-subscription.js';
import { UnifiedWarmupCoordinator, unifiedWarmupHandler } from './unified-warmup.js';
import { loadExpertRoutePolicy, installExpertSessionCompatibility, loadExpertMessageFactory } from './expert-session-compat.js';

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
  try { if (typeof ctx.connection?.requestRejection === 'function') code = ctx.connection.requestRejection(req); } catch { /* fail closed */ }
  if (code === undefined) return true;
  if (code !== 401 && code !== 403) code = 403;
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

export function launchPetProcess({ root = ROOT, profile = 'desktop', platform = process.platform, spawnProcess = spawn, logger, runId = randomUUID(), panel = null } = {}) {
  if (platform !== 'win32' || profile !== 'desktop') return () => {};
  let stopped = false, active = false, finished = false;
  let child;
  try {
    child = spawnProcess('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden',
      '-File', join(root, 'pet.ps1'), '-DshProfile', profile, '-PetRunId', runId,
    ], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env,
      DSH_PET_PANEL_URL: panel?.url ?? '', DSH_PET_PANEL_TOKEN: panel?.token ?? '' } });
  } catch (error) {
    logger?.warn?.('simple-pet: could not start the pet window: %o', error);
    return () => {};
  }
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-2048); });
  child.on('spawn', () => { if (!stopped && !finished) active = true; });
  child.on('error', error => {
    active = false; finished = true;
    if (!stopped) logger?.warn?.('simple-pet: could not start the pet window: %o', error);
  });
  child.on('exit', code => {
    active = false; finished = true;
    if (!stopped && code !== 0) logger?.warn?.('simple-pet: pet window exited with code %s: %s', code, stderr.trim());
  });
  child.unref();
  const stop = () => {
    stopped = true; active = false;
    if (child.pid && child.exitCode === null && !child.killed) child.kill();
  };
  stop.applicationRuntime = () => ({ runId, pid: child.pid, active: active && !stopped && child.exitCode === null && !child.killed });
  return stop;
}

export function codexQuotaRefreshSeconds(raw) {
  const seconds = raw?.codexQuotaRefreshSeconds;
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 3600 ? seconds : 5;
}

// Read public manifests only, never tokens or account vaults. Unknown versions stay gated.
export function accountSwitchCapability(provider, root = ROOT) {
  const known = { 'openai-codex': ['dsh-codex-subscription', '2.6.8'], codex: ['dsh-plugin-subscriptions', '0.9.9'] }[provider];
  if (!known) return false;
  try {
    const manifest = JSON.parse(readFileSync(join(root, '..', known[0], 'package.json'), 'utf8'));
    return manifest.name === known[0] && manifest.version === known[1];
  } catch { return false; }
}

export function readLegacyWarmup(file) {
  try {
    const bytes = readFileSync(file);
    if (bytes.length > 256 * 1024) return { readable: false, journal: null };
    const journal = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''));
    const readable = journal?.version === 1 && Array.isArray(journal.keys)
      && journal.keys.every(key => typeof key === 'string' && !/[\r\n]/.test(key)
        && /^(?:daily:\d{4}-\d{2}-\d{2}|(?:reset|window):[a-f0-9]{16}:\d{10,16})$/.test(key))
      && (journal.lastAttemptAt == null || (Number.isSafeInteger(journal.lastAttemptAt) && journal.lastAttemptAt >= 0));
    return { readable, journal: readable ? journal : null };
  } catch (cause) { return { readable: cause.code === 'ENOENT', journal: null }; }
}

export function apply(ctx, { petLauncher = launchPetProcess, warmupClock = Date.now, switchSupported = accountSwitchCapability, panelStarter = startPanelAccounts, subscriptionFactory = createEmbeddedSubscription } = {}) {
  // A child fiber shares the host's public services and is disposed with simple-pet.
  // Mock-only contexts without plugin() never activate a real account engine.
  let subscriptionOwner = 'loading', subscriptionAdapter = null, subscriptionWarmupService = null, unifiedWarmup = null;
  const supportsAccountSwitch = provider => (provider === 'openai-codex' && subscriptionOwner === 'embedded') || switchSupported(provider);
  if (typeof ctx.plugin === 'function') {
    ctx.plugin(subscriptionFactory({ onOwner: owner => { subscriptionOwner = owner; }, onAdapter: adapter => { subscriptionAdapter = adapter; },
      onWarmupService: service => { subscriptionWarmupService = service; unifiedWarmup?.setService(service); } }));
  }
  let live = true;
  const instance = randomUUID();
  const profile = (process.env.DSH_PET_PROFILE || process.env.DSH_PROFILE || 'desktop').replace(/[^a-zA-Z0-9_-]/g, '');
  const dataDir = join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || ROOT, 'AppData', 'Local'), 'DshSimpleDesktopPet');
  const stateFile = join(dataDir, `state-${profile}.json`);
  const statsFile = join(dataDir, `stats-${profile}.json`);
  const codexStatsFile = join(dataDir, `stats-codex-${profile}.json`);
  const prefsFile = join(dataDir, 'settings.json');
  // Legacy routes now delegate to the embedded subscription; old expert policy is retained but not activated.
  const warmupFile = join(dataDir, 'warmup.json');
  const initialWarmup = readLegacyWarmup(warmupFile);
  let storedWarmup = initialWarmup.journal, warmupJournalReadable = initialWarmup.readable, warmupJournalAlert = null;
  let storedCodexStats = null;
  try { storedCodexStats = JSON.parse(readFileSync(codexStatsFile, 'utf8')); } catch { /* independent new ledger */ }
  const codexLedger = loadLedger(storedCodexStats);
  let codex = { status: 'unsupported', fiveHour: null, weekly: null, observedAt: null };
  let codexIdentity = null; // Memory only: never included in snapshots, ledgers or preferences.
  let codexBridge = null,officialRequests=new AbortController();
  const revokeOfficialRequests=()=>{officialRequests.abort();officialRequests=new AbortController();};
  let codexBusy = false;
  let codexProvider = 'openai-codex';
  // Subscription management is the sole connection/account owner. Retired preferences cannot re-enable the old service.
  const accountBackend = 'legacy';
  function configureAccountBackend() {}
  function refreshAccountBackend() { return accountBackend; }
  const discoverAccounts = options => options.backend === 'official' ? discoverOfficialAccounts(options) : discoverBoundAccounts(options);
  let codexRevision = 0;
  let bridgeRevision = 0;
  let accountSourceGeneration = 0;
  let quotaRefreshTimer = null;
  let quotaPollTimer = null;
  let quotaPollSeconds = 5;
  // Pet display polls the subscription owner's cache; retired account preferences cannot force its network refresh policy.
  function configureQuotaPolling(raw) {
    const seconds = codexQuotaRefreshSeconds(raw);
    if (seconds === quotaPollSeconds && quotaPollTimer !== null) return;
    quotaPollSeconds = seconds;
    clearInterval(quotaPollTimer); quotaPollTimer = null;
    if (live && codexBridge) quotaPollTimer = setInterval(() => void pollCodex(true), seconds * 1000);
  }
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
  unifiedWarmup = new UnifiedWarmupCoordinator({ file: join(dataDir, 'unified-warmup.json'), legacyFile: warmupFile,
    retiredMultiFile: join(dataDir, 'multi-warmup.json'), clock: warmupClock, signal: controller.signal });
  if (subscriptionWarmupService) unifiedWarmup.setService(subscriptionWarmupService);
  let unifiedLegacyPaused = true;
  const pollUnifiedWarmup = async () => {
    if (!live || profile !== 'desktop') return;
    await unifiedWarmup.tick();
    const state = await unifiedWarmup.status();
    unifiedLegacyPaused = state.config.enabled || state.legacyResumePaused || /^paused_/.test(state.view.status);
  };
  let writeRequested = false;
  let writing = false;
  let snapshotTask = null;
  let warmupUsageDirty = false;
  let warmupQuota = null;
  let warmupPollAt = 0;
  let accountChanging = false, warmupSwitchUncertain = false;
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
      if (!warmupAuthorized() || refreshAccountBackend() === 'official' || !codexBridge || accountChanging || warmupSwitchUncertain || warmupModeUncertain || multiEnabled || legacyResumePaused || legacyDayBlocked || !multiReadable || !warmupJournalReadable) throw new Error('subscription bridge unavailable');
      const bridge = codexBridge, generation = bridgeRevision, selectionGeneration = codexRevision;
      const now = warmupClock();
      if (!force && codex.provider === 'openai-codex' && codex.observedAt === warmupQuota?.observedAt) return warmupQuota;
      if (!force && codex.provider === 'openai-codex' && codex.observedAt > 0) return codex;
      if (!force && warmupQuota && now - warmupPollAt < quotaPollSeconds * 1000) return warmupQuota;
      let identity = null;
      const current = await readCodexQuota(bridge, signal, now, 'openai-codex', { force, allowFallback: false, onIdentity(value) { identity = value; } });
      if (!live || generation !== bridgeRevision || selectionGeneration !== codexRevision || bridge !== codexBridge) throw new Error('subscription bridge changed');
      warmupQuota = current; warmupPollAt = now;
      if (codexProvider === 'openai-codex') {
        for (const delta of quotaDeltas(codex, current)) push(delta);
        if (codex.provider !== current.provider) { accountSourceGeneration++; multiWarmup.active?.abort(); }
        codex = current; codexIdentity = identity; snapshot();
      }
      return current;
    },
    async run({ quota, signal }) {
      const bridge = codexBridge, generation = bridgeRevision;
      if (!warmupAuthorized() || refreshAccountBackend() === 'official' || !bridge || accountChanging || warmupSwitchUncertain || warmupModeUncertain || multiEnabled || legacyResumePaused || legacyDayBlocked || !multiReadable || !warmupJournalReadable) throw new Error('subscription bridge unavailable');
      const adapter = subscriptionAdapter;
      const result = await runCodexWarmup({ llm: ctx.llm, bridge, quota, signal,
        prepareCall: (...args) => adapter.prepareCall(...args, quota.accountKey),
        isCurrent: () => warmupAuthorized() && adapter === subscriptionAdapter && bridge === codexBridge && generation === bridgeRevision && !accountChanging,
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
  const multiStore = new MultiWarmupStore(join(dataDir, 'multi-warmup.json'));
  let multiEnabled = false, warmupModeUncertain = false, multiReadable = true, legacyResumePaused = false, legacyDayBlocked = false;
  const multiContext = () => {
    const backend = refreshAccountBackend();
    return live && warmupJournalReadable && codexBridge && !accountChanging && !warmupSwitchUncertain && !warmupModeUncertain && !warmup.active
      && (backend === 'official' || (typeof ctx.llm?.listModels === 'function' && typeof ctx.llm?.resolveModelInfo === 'function' && typeof ctx.llm?.stream === 'function' && switchSupported('codex')))
      && (!WARMUP_OWNERS.has(warmupFile) || WARMUP_OWNERS.get(warmupFile) === instance)
      ? { llm: ctx.llm, bridge: codexBridge, backend, generation: `${bridgeRevision}:${accountSourceGeneration}:${backend}`,
        singleAttemptToday: legacyBlocksMulti(warmup.journal, warmupClock()) } : null;
  };
  const multiWarmup = new MultiWarmupScheduler({ store: multiStore, context: multiContext, discover: discoverAccounts,
    signal: controller.signal, clock: warmupClock, onChange() { if (live) snapshot(); },
    claimLease() {
      if (!WARMUP_OWNERS.has(warmupFile)) WARMUP_OWNERS.set(warmupFile, instance);
      if (WARMUP_OWNERS.get(warmupFile) !== instance) return false;
      const legacy = readLegacyWarmup(warmupFile); warmupJournalReadable = legacy.readable;
      if (!legacy.readable) return false;
      warmup.journal = loadWarmupJournal(legacy.journal);
      return !legacyBlocksMulti(warmup.journal, warmupClock());
    },
    async run(options) {
      const run = options.backend === 'official' ? runOfficialWarmup : runBoundWarmup;
      return run({ ...options, llm: ctx.llm,
        onUsage(usage, model) {
          const items = codexTokenItems(usage), at = warmupClock();
          if (!items.length) return;
          addUsage(codexLedger, usage, { items: [] }, at); warmupUsageDirty = true;
          if (live) { for (const item of items) push({ ...item, model: model.modelName, accountKey: options.accountKey, at, warmup: true }); snapshot(); }
        },
      });
    },
  });
  const warmupView = () => warmupSwitchUncertain ? { ...warmup.view, detail: '共享账号切换结果不明，自动预热已暂停；请在订阅插件核验后完整重启 DSH。', accountSwitchPaused: true }
    : warmupModeUncertain ? { ...warmup.view, detail: '预热结果或执行中的授权变更未核验，所有自动预热已暂停；需核验持久记录，不能靠重启/切换开关绕过未知认领。', modeChangePaused: true }
      : !warmupJournalReadable ? { ...warmup.view, status: warmupJournalAlert === null ? 'disabled' : 'failed', detail: '原单账号预热日志不可读，无法排除已尝试请求；所有自动预热暂停，不覆盖原记录。', alertId: warmupJournalAlert ? 'legacy-journal-unavailable' : null }
        : unifiedLegacyPaused ? { ...warmup.view, status: 'disabled', detail: '同源多账号计划已启用、曾启用或保护状态待核验，旧单当前账号计划暂停；关闭计划不会自动恢复旧启动预热。' }
        : !multiReadable ? { ...warmup.view, detail: '多账号记录不可读，所有自动预热保守暂停。' }
        : accountBackend === 'official' ? { ...warmup.view, status: 'disabled', detail: '官方账号后端使用下方独立逐账号每日授权；旧单账号计划暂停，原开关保持不变。' }
        : multiEnabled ? { ...warmup.view, status: 'disabled', detail: '多账号计划已开启，原单账号计划暂停，原开关保持不变。' }
          : legacyResumePaused ? { ...warmup.view, status: 'disabled', detail: '刚退出多账号模式，旧单账号计划本进程保守暂停；核验后完整重启 DSH，不在保存时立即预热。' }
            : legacyDayBlocked ? { ...warmup.view, status: 'disabled', detail: '今天已有多账号认领，保守暂停旧单账号计划以避免重复。' } : warmup.view;
  let prefsReading = false;
  let warmupTimer = null;
  let prefsWatcher = null;
  let prefsChangeTimer = null;
  let warmupRefreshPending = false;
  function unifiedPermissions() {
    try { return preferenceValues(JSON.parse(readFileSync(prefsFile, 'utf8').replace(/^\uFEFF/, ''))); }
    catch { return preferenceValues(null); }
  }
  function warmupAuthorized() {
    return live && profile === 'desktop' && subscriptionOwner === 'embedded' && !!subscriptionAdapter && !unifiedLegacyPaused
      && unifiedPermissions().codexUnifiedWarmup === true;
  }
  function scheduleWarmup() {
    clearTimeout(warmupTimer); warmupTimer = null;
    if (!warmupAuthorized() || !codexBridge || warmupSwitchUncertain || warmupModeUncertain || !multiReadable || legacyDayBlocked || !warmupJournalReadable) return;
    const delay = warmup.nextDelay(warmupClock());
    if (delay !== null) { warmupTimer = setTimeout(() => void pollWarmup(), Math.max(1, delay)); warmupTimer.unref?.(); }
  }
  async function pollWarmup({ preferencesChanged = false } = {}) {
    // Old account/backend grants never authorize a different unified owner.
    if (prefsReading) { warmupRefreshPending = true; if (preferencesChanged) warmup.active?.abort(); return; }
    prefsReading = true; clearTimeout(warmupTimer); warmupTimer = null;
    try {
      const raw = JSON.parse((await readFile(prefsFile, 'utf8')).replace(/^\uFEFF/, ''));
      configureQuotaPolling(raw);
      if (!warmupAuthorized()) { warmup.active?.abort(); warmup.update('disabled', '统一订阅自动预热未授权；旧账号开关不会自动转为新授权。'); return; }
      const saved = await multiStore.read(); multiReadable = true;
      legacyDayBlocked = multiBlocksLegacy(saved.data, warmupClock());
      if (!codexBridge || accountChanging || warmupSwitchUncertain || warmupModeUncertain || legacyDayBlocked || !warmupJournalReadable) {
        warmup.active?.abort(); warmup.update('blocked', '账号、去重记录或切换结果尚未确认，自动预热暂停；不会补发。'); return;
      }
      await warmup.tick(raw, warmupClock());
    } catch {
      warmup.active?.abort(); warmup.update('disabled', '设置或预热记录不可读，自动预热暂停；原文件未覆盖。');
    } finally {
      prefsReading = false; scheduleWarmup();
      if (warmupRefreshPending && live) { warmupRefreshPending = false; queueMicrotask(() => void pollWarmup()); }
    }
  }

  async function writeSnapshot() {
    if (writing || !live) return;
    writing = true;
    try {
      await mkdir(dataDir, { recursive: true });
      while (writeRequested && live) {
        writeRequested = false;
        const body = JSON.stringify({ instance, seq: sequence, events, balance, balanceStatus, cacheHitRate, peak: isPeak(), stats: ledger, codex, codexStats: codexLedger, codexQuotaRefreshSeconds: quotaPollSeconds, codexWarmup: warmupView(), codexMultiWarmup: multiWarmup.view, updatedAt: Date.now() });
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
    if (!live || accountChanging || codexBusy || !codexBridge) return;
    codexBusy = true;
    const backend = refreshAccountBackend();
    const revision = codexRevision, bridgeGeneration = bridgeRevision;
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
      let identity = null;
      const current = backend === 'official' ? await readOfficialQuota(codexBridge, signal, value => { identity = value; })
        : await readCodexQuota(codexBridge, signal, Date.now(), codexProvider,
          { force: false, allowFallback: false, onIdentity(value) { identity = value; } });
      if (!live || revision !== codexRevision || bridgeGeneration !== bridgeRevision) return;
      for (const delta of quotaDeltas(codex, current)) push(delta);
      if (codex.provider !== current.provider) { accountSourceGeneration++; multiWarmup.active?.abort(); }
      codex = current; codexIdentity = identity;
    } catch {
      if (!live || revision !== codexRevision || bridgeGeneration !== bridgeRevision) return;
      codexIdentity = null;
      codex = { ...codex, status: codex.fiveHour || codex.weekly ? 'stale' : 'unavailable' };
    } finally {
      codexBusy = false;
      if (live) { snapshot(); void pollWarmup(); }
      if (live && (revision !== codexRevision || bridgeGeneration !== bridgeRevision)) void pollCodex();
    }
  }
  ctx.inject(['connection'], quotaCtx => {
    if (typeof quotaCtx.connection.createSharedFetchHandler !== 'function') return;
    const bridge = quotaCtx.connection.createSharedFetchHandler('/api');
    multiWarmup.active?.abort();
    bridgeRevision++;
    revokeOfficialRequests();codexBridge = bridge;
    codexIdentity = null;
    codex = { status: 'loading', fiveHour: null, weekly: null, observedAt: null };
    void pollCodex();
    clearInterval(quotaPollTimer);
    quotaPollTimer = setInterval(() => void pollCodex(true), quotaPollSeconds * 1000);
    quotaCtx.effect(() => () => {
      if (codexBridge === bridge) {
        clearInterval(quotaPollTimer); quotaPollTimer = null;
        bridgeRevision++;
        revokeOfficialRequests();codexBridge = null; codexIdentity = null;
        warmup.active?.abort(); multiWarmup.active?.abort();
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

  function panelGrant() {
    const prefs = unifiedPermissions();
    if (!live || subscriptionOwner !== 'embedded' || prefs.codexUnifiedControls !== true || prefs.billingMode !== 'codex') return null;
    return createHash('sha256').update(JSON.stringify([instance, subscriptionOwner, bridgeRevision, prefs.codexUnifiedControls, prefs.billingMode])).digest('hex');
  }
  const panelReady = () => live && petStop?.applicationRuntime?.()?.active === true && !!panelGrant() && !!codexBridge && (refreshAccountBackend() === 'official' || supportsAccountSwitch(codex.provider))
    && !accountChanging && !warmupSwitchUncertain && !warmupModeUncertain && !prefsReading && !warmup.active && !multiWarmup.active;
  const accountControl = createAccountControl({
    context: () => live && refreshAccountBackend() === 'legacy' && petStop?.applicationRuntime?.()?.active === true && panelGrant() && codexBridge && supportsAccountSwitch(codex.provider)
      ? { bridge: codexBridge, provider: codex.provider, generation: `${bridgeRevision}:${accountSourceGeneration}:${codexProvider}:${panelGrant()}` } : null,
    blocked: () => accountChanging || warmupSwitchUncertain || warmupModeUncertain || prefsReading || !!warmup.active || !!multiWarmup.active,
    begin() {
      if (!live || accountChanging || warmupSwitchUncertain || warmupModeUncertain || prefsReading || warmup.active || multiWarmup.active) return false;
      accountChanging = true; clearTimeout(warmupTimer);
      codexRevision++; codexIdentity = null; warmupQuota = null; warmupPollAt = 0;
      codex = { ...codex, status: 'switching', fiveHour: null, weekly: null, observedAt: null };
      snapshot();
      return true;
    },
    end() { accountChanging = false; },
    changed(evidence) {
      if (!live) return;
      warmupSwitchUncertain = warmupAfterAccountSwitch(warmupSwitchUncertain, evidence);
      codexRevision++; codexIdentity = null; warmupQuota = null; warmupPollAt = 0;
      codex = { ...codex, status: 'loading', fiveHour: null, weekly: null, observedAt: null };
      snapshot(); void pollCodex(true); scheduleWarmup();
    },
  });
  const preferencesStore = new PreferencesStore(prefsFile);
  const legacyPanelCycle = createPanelCycle({ control: accountControl, grant: panelGrant, ready: panelReady });
  const panelCycle = async expected => {
    if (refreshAccountBackend() !== 'official') return legacyPanelCycle(expected);
    if (!panelReady() || panelGrant() !== expected) throw new Error('Panel not ready');
    const grant = panelGrant(), bridge = codexBridge, generation = `${bridgeRevision}:${accountSourceGeneration}`;
    accountChanging = true; clearTimeout(warmupTimer); let attempted = false, confirmed = false;
    try {
      const list = await officialAccountRpc(bridge, null, {}, AbortSignal.timeout(10000));
      const rows = list.accounts?.filter(r => r.bound === true);
      if (!Array.isArray(rows) || rows.length < 2 || new Set(rows.map(r => r.accountKey)).size !== rows.length || !Number.isSafeInteger(list.generation)) throw new Error('Need two bound accounts');
      const current = rows.findIndex(r => r.accountKey === list.defaultKey);
      if (current < 0 || rows.filter(r => r.selected === true).length !== 1) throw new Error('Selected account unavailable');
      if (panelGrant() !== grant || refreshAccountBackend() !== 'official' || codexBridge !== bridge || `${bridgeRevision}:${accountSourceGeneration}` !== generation || !live) throw new Error('Authority changed');
      const target = rows[(current + 1) % rows.length].accountKey;
      attempted = true;
      await officialAccountRpc(bridge, 'account.select', { accountKey: target, expectedGeneration: list.generation }, AbortSignal.timeout(10000));
      const after = await officialAccountRpc(bridge, null, {}, AbortSignal.timeout(10000));
      confirmed = live && panelGrant() === grant && refreshAccountBackend() === 'official' && codexBridge === bridge && `${bridgeRevision}:${accountSourceGeneration}` === generation
        && after.defaultKey === target && after.accounts?.some(r => r.accountKey === target && r.selected);
      if (!confirmed) throw new Error('Switch unconfirmed');
      return { ok: true };
    } finally {
      accountChanging = false; warmupSwitchUncertain = warmupAfterAccountSwitch(warmupSwitchUncertain, { attempted, confirmed });
      codexRevision++; codexIdentity = null; warmupQuota = null; snapshot(); void pollCodex(true); scheduleWarmup();
    }
  };
  async function panelView() {
    if (refreshAccountBackend() === 'official') {
      const grant = panelGrant();
      if (!grant) return { enabled: false, canSwitch: false, email: '', selection: 'none', validForMs: 2000 };
      try {
        const list = await officialAccountRpc(codexBridge, null, {}, AbortSignal.timeout(5000));
        const bound = list.accounts?.filter(r => r.bound === true) ?? [];
        const row = bound.find(r => r.accountKey === list.defaultKey);
        if (panelGrant() !== grant || refreshAccountBackend() !== 'official') throw new Error('Authority changed');
        return { enabled: true, grant, canSwitch: !!row && bound.length >= 2 && panelReady(), email: row?.label ?? '', selection: row ? 'default' : 'none', validForMs: 2000, reason: row ? '仅改变本账号服务后续新请求默认账号' : '请先完成官方订阅 OAuth 登录' };
      } catch { return { enabled: true, grant, canSwitch: false, email: '', selection: 'none', validForMs: 2000, reason: '官方账号插件未就绪' }; }
    }
    const grant = panelGrant();
    const evidence = panelIdentityEvidence(codex, codexIdentity);
    const valid = evidence.status === 'ready';
    return { enabled: true, grant, canSwitch: valid && panelReady() && Number.isSafeInteger(codex.accountCount) && codex.accountCount >= 2,
      email: valid ? (grant ? codexIdentity.panelEmail : codexIdentity.maskedEmail) ?? '' : '', selection: valid ? evidence.selection : 'none',
      accountKey: valid ? evidence.accountKey : null, validForMs: valid ? Math.min(evidence.validForMs, 6000) : 2000,
      reason: !supportsAccountSwitch(codex.provider) ? '请安装并启用支持的订阅依赖版本' : !valid ? '等待账号状态' : codex.accountCount < 2 ? '至少绑定两个账号' : !panelReady() ? '预热或切换中，或结果待核验' : null };
  }
  let petStop = null, panelServer = null;
  const applicationRuntime = () => live ? petStop?.applicationRuntime?.() : null;
  ctx.inject(['webServer', 'connection'], routeCtx => {
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'exact', path: '/api/dsh-plugin-simple-pet/subscription-owner',
      handler(req, res) {
        if (!guard(routeCtx, req, res)) return;
        const method = req.method ?? 'GET';
        if (method !== 'GET' && method !== 'HEAD') return json(res, 405, { error: 'method not allowed' }, method);
        return json(res, 200, { owner: live ? subscriptionOwner : 'closed', version: '2.6.8' }, method);
      },
    }), 'simple-pet: read-only embedded subscription ownership');
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'exact', path: '/api/dsh-plugin-simple-pet/preferences',
      handler: preferencesHandler(preferencesStore, (req, res) => guard(routeCtx, req, res), { allowedKeys: ['skin','cardTheme','unit','size','billingMode','codexUnit','sleepMinutes','compactMode','quietMode','feedbackStyle','reduceMotion','disableFlashes','disableFloats','codexQuotaRefreshSeconds','codexUnifiedControls','codexUnifiedWarmup','codexWarmupDaily','codexWarmupTime','codexWarmupReset','codexWarmupStartup'] }),
    }), 'simple-pet: host settings preferences');
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'exact', path: '/api/dsh-plugin-simple-pet/application',
      handler: applicationHandler({ store: preferencesStore, receiptFile: join(dataDir, `settings-applied-${profile}.json`),
        profile, runtime: applicationRuntime, authorize: (req, res) => guard(routeCtx, req, res) }),
    }), 'simple-pet: local application receipt');
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'exact', path: '/api/dsh-plugin-simple-pet/account',
      handler: accountIdentityHandler({ authorize: (req, res) => guard(routeCtx, req, res),
        read: () => {
          const evidence = live ? panelIdentityEvidence(codex, codexIdentity) : { status: 'unavailable' };
          return evidence.status === 'ready' ? { ...evidence, provider: codexIdentity.provider, maskedEmail: codexIdentity.maskedEmail } : evidence;
        } }),
    }), 'simple-pet: private read-only account identity');
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'exact', path: '/api/dsh-plugin-simple-pet/accounts',
      handler: (req, res) => { if (guard(routeCtx, req, res)) json(res, 410, { error: '账号管理已统一至订阅管理；切号仅通过已授权的桌宠面板。' }, req.method ?? 'GET'); },
    }), 'simple-pet: retired web account management');
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'exact', path: '/api/dsh-plugin-simple-pet/unified-warmup',
      handler: unifiedWarmupHandler({ coordinator: unifiedWarmup, authorize: (req, res) => {
        if (!guard(routeCtx, req, res)) return false;
        if (!live || profile !== 'desktop' || subscriptionOwner !== 'embedded') { json(res, 503, { error: 'owner_unavailable' }, req.method ?? 'GET'); return false; }
        return true;
      } }),
    }), 'simple-pet: explicitly authorized unified-account warmup');
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'exact', path: '/api/dsh-plugin-simple-pet/multi-warmup',
      handler: (req,res) => { if (guard(routeCtx,req,res)) json(res,410,{error:'账号与连接配置已统一至订阅管理。'},req.method??'GET'); },
    }), 'simple-pet: retired account warmup');
    routeCtx.effect(() => routeCtx.webServer.register({ kind:'exact',path:'/api/dsh-plugin-simple-pet/official-accounts',
      handler:(req,res)=>{if(guard(routeCtx,req,res))json(res,410,{error:'账号与连接配置已统一至订阅管理。'},req.method??'GET');},
    }), 'simple-pet: retired duplicate account management');
    routeCtx.effect(() => routeCtx.webServer.register({ kind: 'exact', path: STATE_PATH, handler(req, res) {
      if (!guard(routeCtx, req, res)) return;
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') return json(res, 405, { error: 'method not allowed' }, method);
      const raw = new URL(req.url ?? STATE_PATH, 'http://localhost').searchParams.get('since');
      if (raw !== null && !/^(0|[1-9]\d*)$/.test(raw)) return json(res, 400, { error: 'invalid since' }, method);
      const since = raw === null ? sequence : Number(raw);
      if (!Number.isSafeInteger(since)) return json(res, 400, { error: 'invalid since' }, method);
      json(res, 200, { seq: sequence, events: events.filter(e => e.seq > since), balance, balanceStatus, cacheHitRate, peak: isPeak(), stats: ledger, codex, codexStats: codexLedger, codexQuotaRefreshSeconds: quotaPollSeconds, codexWarmup: warmupView(), codexMultiWarmup: multiWarmup.view }, method);
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
  // Continuous minute crossing only: no startup, resume or missed-run replay.
  const unifiedTimer = profile === 'desktop' ? setInterval(() => { void pollUnifiedWarmup().catch(() => { unifiedLegacyPaused = true; }); }, 15_000) : null;
  // Settings changes wake the scheduler; quota refresh remains a low-frequency safety net.
  if (profile === 'desktop' && process.platform === 'win32') {
    void mkdir(dataDir, { recursive: true }).then(() => {
      if (!live) return;
      prefsWatcher = watch(dataDir, (_event, filename) => {
        if (!filename || String(filename) === 'settings.json') {
          clearTimeout(prefsChangeTimer);
          prefsChangeTimer = setTimeout(() => void pollWarmup({ preferencesChanged: true }), 150);
        }
        if (!filename || String(filename) === 'multi-warmup.json') {
          // Claims/terminal writes share the file: never abort a request on its own journal write.
          void multiStore.read().then(saved => {
            if (!live || JSON.stringify(saved.data.config) === JSON.stringify(multiWarmup.config)) return;
            if (warmup.active || multiWarmup.active) { warmupModeUncertain = true; warmup.active?.abort(); multiWarmup.active?.abort(); }
            void pollWarmup();
          }).catch(() => { if (live) { multiReadable = false; warmup.active?.abort(); multiWarmup.active?.abort(); snapshot(); } });
        }
      });
      prefsWatcher.on('error', () => { prefsWatcher?.close(); prefsWatcher = null; });
    }).catch(() => { /* periodic quota refresh also reads settings */ });
  }
  void pollUnifiedWarmup().then(() => pollWarmup()).catch(() => { unifiedLegacyPaused = true; });
  snapshot();
  pollBalance();
  ctx.effect(() => {
    let cancelled = false;
    const launch = panel => { if (!cancelled && live) petStop = petLauncher({ root: ROOT, profile, logger: ctx.logger, runId: instance, panel }); };
    if (profile === 'desktop' && process.platform === 'win32') {
      void panelStarter({ read: panelView, cycle: panelCycle, runtime: () => applicationRuntime() }).then(server => {
        if (cancelled || !live) { server.close(); return; }
        panelServer = server; launch(server);
      }).catch(() => { if (!cancelled && live) { ctx.logger?.warn?.('simple-pet: panel channel unavailable; account controls remain disabled'); launch(null); } });
    } else launch(null);
    return () => { cancelled = true; panelServer?.close(); panelServer = null; const stop = petStop; petStop = null; stop?.(); };
  }, 'deepseek-pet: window');
  ctx.effect(() => async () => {
    live = false; accountControl.dispose(); clearInterval(timer); clearInterval(heartbeat); clearInterval(unifiedTimer); clearTimeout(warmupTimer); clearTimeout(prefsChangeTimer); prefsWatcher?.close();
    officialRequests.abort();clearTimeout(quotaRefreshTimer); clearInterval(quotaPollTimer); quotaPollTimer = null; controller.abort(); await Promise.all([warmup.stop(), multiWarmup.stop(), unifiedWarmup.stop()]); await snapshotTask;
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
