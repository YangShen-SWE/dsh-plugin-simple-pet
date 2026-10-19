import { CARD_THEMES, cardCssVariables } from './card-themes.js';

// Browser-only UI. Host preferences remain in the original global JSON file.
export function statBuckets(days, range, unit, now = new Date()) {
  const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const value = d => { const n = days?.[dayKey(d)]?.[unit]; return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0; };
  if (range === 'year') return Array.from({ length: 12 }, (_, month) => {
    let total = 0;
    for (let i = 1; i <= new Date(now.getFullYear(), month + 1, 0).getDate(); i++) total += value(new Date(now.getFullYear(), month, i));
    return { label: `${month + 1}`, value: total };
  });
  if (range === 'month') return Array.from({ length: new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() }, (_, i) => ({ label: `${i + 1}`, value: value(new Date(now.getFullYear(), now.getMonth(), i + 1)) }));
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() + 6) % 7);
  return Array.from({ length: 7 }, (_, i) => ({ label: ['一','二','三','四','五','六','日'][i], value: value(new Date(first.getFullYear(), first.getMonth(), first.getDate() + i)) }));
}

export function calendarDate(timeZone, now = new Date()) {
  if (!timeZone) return now;
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now).map(p => [p.type, p.value]));
    return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  } catch { return now; }
}

export function quotaStatus(snapshot, now = Date.now()) {
  const q = snapshot?.codex;
  if (!q) return snapshot ? '请重启 DSH 更新桌宠' : '等待 DSH 数据';
  const expired = [q.fiveHour, q.weekly].some(w => Number.isFinite(w?.resetAt) && w.resetAt > 0 && w.resetAt <= now);
  if (q.status === 'ready' && (!Number.isFinite(q.observedAt) || q.observedAt <= 0 || q.observedAt > now + 5000 || now - q.observedAt > 120000 || expired)) return '上次额度 · 待更新';
  if (q.status === 'reported' && expired) return '上次额度 · 待更新';
  return ({ ready: '当前账号 · 官方报告', reported: '默认账号 · 可能缓存', loading: '查询额度中…', 'signed-out': '请在订阅插件登录', unsupported: '未发现支持的订阅接口', switching: '账号切换中…', stale: '上次额度 · 待更新' })[q.status] || '额度暂不可用';
}

export function accountSummary(snapshot, identity, elapsedMs = 0) {
  const q = snapshot?.codex;
  if (!identity || identity.status !== 'ready' || !q || !['ready', 'reported'].includes(q.status)
    || identity.provider !== q.provider || identity.selection !== q.selection || identity.accountKey !== q.accountKey
    || !(typeof identity.accountKey === 'string' && identity.accountKey.length === 16 && /^[a-f0-9]{16}$/.test(identity.accountKey)) || !Number.isFinite(elapsedMs) || elapsedMs < 0
    || !(identity.validForMs > 0 && identity.validForMs <= 120000 && elapsedMs < identity.validForMs)) return '账号身份待确认；不会根据旧额度猜测邮箱。';
  const source = identity.provider === 'openai-codex' && identity.selection === 'active' ? '激活账号（专用订阅插件）'
    : identity.provider === 'codex' && identity.selection === 'default' ? '默认账号（通用订阅插件，Pool 可能另选账号）'
    : identity.provider === 'codex-accounts' && identity.selection === 'default' ? '本项目官方组件服务 · 后续新请求默认账号' : null;
  if (!source) return '账号来源未确认';
  const email = typeof identity.maskedEmail === 'string' && /^[A-Za-z0-9]\*{3}@[A-Za-z0-9]\*{3}\.[a-z]{2,24}$/.test(identity.maskedEmail) ? identity.maskedEmail : '邮箱未提供';
  return `${source}：${email} · #${identity.accountKey.slice(0, 8)}。不代表每次模型请求的实际执行账号。`;
}

export function quotaReset(window, timeZone) {
  if (!Number.isFinite(window?.resetAt) || window.resetAt <= 0) return '重置时间未知';
  try { return '重置 ' + new Intl.DateTimeFormat('zh-CN', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(window.resetAt)); }
  catch { return '重置时间未知'; }
}

// A receipt is not a server sample. Rendering never refreshes data, infers a
// refilled window, or replaces the last successful observation timestamp.
export function accountQuotaPresentation(value, now = Date.now()) {
  const q = value ?? {}, validTime = time => Number.isFinite(time) && time > 0 && time <= 8640000000000000;
  const observed = validTime(q.clientObservedAt), future = observed && q.clientObservedAt > now + 5000;
  const validWindow = window => Number.isFinite(window?.remainingPercent) && window.remainingPercent >= 0 && window.remainingPercent <= 100;
  const windows = [['5h', q.fiveHour], ['每周', q.weekly]].map(([label, window]) => ({
    label, value: validWindow(window) ? `${Math.round(window.remainingPercent)}%` : '未报告',
    reset: quotaReset(window),
  }));
  const hasValues = [q.fiveHour, q.weekly].some(validWindow);
  const expired = [q.fiveHour, q.weekly].some(window => validTime(window?.resetAt) && window.resetAt <= now);
  let status = '尚未查询';
  if (future || (q.status === 'reported' && !observed)) status = '观察时间待核验';
  else if (expired) status = '已过重置时间 · 待更新';
  else if (q.status === 'stale') status = hasValues ? '刷新失败 · 上次报告' : '查询失败 · 尚无读数';
  else if (q.status === 'reported' && observed) status = hasValues ? '最近报告 · 非实时' : '未报告可识别窗口';
  else if (observed) status = '未报告可识别窗口';
  else if (hasValues) status = '观察时间待核验';
  let received = '尚无成功查询时间';
  if (observed) try { received = `本机收到：${new Date(q.clientObservedAt).toLocaleString('zh-CN', { hour12: false })}`; } catch { /* keep the explicit unknown */ }
  return { status, received, windows, restricted: q.ordinaryUsageAllowed === false, stale: q.status === 'stale' || expired || future || (q.status === 'reported' && !observed) };
}

export function accountCredentialSummary(row = {}) {
  return new Map([
    ['available', '本地凭据可读 · 未验证远端会话'], ['missing', '本地授权缺失 · 请先核验'],
    ['invalid', '本地凭据格式无法验证'], ['identity-mismatch', '凭据身份不一致 · 已暂停使用'],
  ]).get(row.credentialStatus) ?? (row.bound === true ? '本地绑定可读 · 未验证远端会话' : '本地授权待核验');
}

export function companionSummary(prefs = {}) {
  if (prefs.compactMode === true) return '简洁模式：仅显示余额/额度面板，隐藏人物，全部视觉动效关闭；闪光/暴击关闭；用量飘字关闭。余额、额度与统计继续更新。';
  const quiet = prefs.quietMode === true, reduced = prefs.reduceMotion === true, gentle = prefs.feedbackStyle === 'gentle';
  const motion = quiet ? '安静模式：角色静止；保持到关闭此模式' : reduced ? '减少动态：保留静态待机/睡姿，不播放动态反馈' : gentle ? '温和反馈：中性姿态、轻量确认，连续事件合并展示' : '经典反馈：保留原有角色动作';
  const flashes = !quiet && !reduced && !gentle && prefs.disableFlashes !== true;
  const floats = !quiet && !reduced && prefs.disableFloats !== true;
  return `${motion}；闪光/暴击${flashes ? '开启' : '关闭'}；用量飘字${floats ? '开启' : '关闭'}。余额、额度与统计继续更新。`;
}

export function applicationStatus(savedRevision, evidence, elapsedMs = 0) {
  if (!savedRevision || savedRevision === 'missing' || !evidence || evidence.revision !== savedRevision) return 'unconfirmed';
  if (evidence.status === 'applied') return Number.isFinite(evidence.validForMs) && evidence.validForMs > 0
    && evidence.validForMs <= 15000 && Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < evidence.validForMs ? 'applied' : 'unconfirmed';
  return ['offline', 'pending'].includes(evidence.status) ? evidence.status : 'unconfirmed';
}

export function applicationSummary(savedRevision, evidence, dirty = false, elapsedMs = 0) {
  const draft = dirty ? '存在未保存草稿，草稿尚未应用。' : '';
  if (!savedRevision || savedRevision === 'missing') return draft + '尚无已保存版本的应用确认。';
  if (!evidence || evidence.revision !== savedRevision) return draft + '已保存版本尚未获得桌宠应用确认。';
  const status = applicationStatus(savedRevision, evidence, elapsedMs);
  if (status === 'applied') {
    return draft + '已保存版本：最近确认桌宠已应用（偏好与视觉，不代表后台预热已执行）。';
  }
  if (evidence.status === 'offline') return draft + '已保存版本：未确认，当前宿主没有已验证的运行中桌宠。';
  if (evidence.status === 'pending') return draft + '已保存版本：桌宠尚在应用或重试，暂未确认。';
  return draft + '已保存版本：未获得有效回执。首次更新代码需完整退出并重启 DSH。';
}

export async function installPanelDependency(manager, authorized = () => true) {
  const name = 'dsh-plugin-subscriptions', version = '0.9.9', spec = `${name}@${version}`;
  if (!manager || ['listBundles', 'inspect', 'installBundle'].some(key => typeof manager[key] !== 'function')) return '本机宿主不支持应用内安装，请到 DSH 插件管理手动安装 ' + spec;
  const check = () => { if (!authorized()) throw new Error('cancelled'); };
  const present = rows => { if (!Array.isArray(rows) || rows.some(row => typeof row?.name !== 'string')) throw new Error('invalid'); return rows.some(row => row.name === name); };
  try {
    check(); if (present(await manager.listBundles())) return '已检测到同名插件：不会重复安装、升级、降级或自动启用；请到 DSH 插件管理核验版本与状态。';
    check(); const inspected = await manager.inspect(spec, {}); check();
    if (inspected?.status !== 'accepted' || inspected.kind !== 'registry' || inspected.name !== name || inspected.version !== version || inspected.bundle !== true) return '依赖检查未通过；未安装。请到 DSH 插件管理查看兼容性、网络或现有安装。';
    if (present(await manager.listBundles())) return '检测到并发安装，已停止本次操作；不会主动更改已有插件。';
    check(); const result = await manager.installBundle(spec, { enabled: true, approvedBuilds: [] }); check();
    if (result?.pendingBuilds?.length) return '依赖含待批准构建脚本，未自动批准。请到 DSH 插件管理核验；不要盲目重试。';
    if (result?.application === 'restart-required') return '宿主报告依赖已安装，需完整重启 DSH 才能加载；随后在订阅插件登录绑定账号。';
    if (result?.application !== 'applied') return '依赖未确认成功加载，请到 DSH 插件管理核验；不会自动重试或批准脚本。';
    const rows = await manager.listBundles(); check();
    const row = Array.isArray(rows) && rows.find(row => row.name === name);
    return row?.version === version && row.enabled === true && row.installed === true
      ? '依赖已安装并启用；这不代表已登录。请到订阅插件登录绑定至少两个 Codex 账号，再保存开启多账号管理。'
      : '宿主返回已应用，但依赖状态尚未确认；请到 DSH 插件管理核验，不会自动重试。';
  } catch { return '依赖安装状态未确认，请到 DSH 插件管理核验；不会自动重试、批准构建脚本或显示内部日志。'; }
}

// Deliberately positive allowlist: new settings cannot silently become spending grants.
export const AUTOSAVE_PREFERENCE_KEYS = Object.freeze(['skin', 'cardTheme', 'unit', 'size', 'billingMode', 'codexUnit', 'sleepMinutes', 'codexQuotaRefreshSeconds', 'compactMode', 'quietMode', 'feedbackStyle', 'reduceMotion', 'disableFlashes', 'disableFloats']);
const PREFERENCE_AUTHORIZATION_LABELS = Object.freeze({ codexWarmupDaily: '每日预热', codexWarmupReset: '5h 窗口预热', codexWarmupStartup: '启动预热', codexWarmupTime: '预热执行时间', codexAccountBackend: '账号来源', multiAccountManagement: '桌宠切号权限' });
export function createPreferenceAutosave({ write, onChange = () => {}, onSaved = () => {}, delay = 450, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let loaded = null, draft = null, timer = null, controller = null, disposed = false, failed = null;
  const safe = key => AUTOSAVE_PREFERENCE_KEYS.includes(key);
  const patch = (all = false) => Object.fromEntries(Object.entries(draft || {}).filter(([key, value]) => (all || safe(key)) && value !== loaded?.values[key]));
  const invalid = changes => Object.entries(changes).some(([key, value]) => key === 'sleepMinutes' ? !Number.isInteger(value) || value < 1 || value > 240 : key === 'codexQuotaRefreshSeconds' ? !Number.isInteger(value) || value < 1 || value > 3600 : key === 'codexWarmupTime' ? !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) : false);
  const state = () => ({ loaded, draft, inFlight: !!controller, safeDirty: !!Object.keys(patch()).length, explicitDirty: Object.keys(patch(true)).some(key => !safe(key)), status: !loaded ? 'loading' : failed ? 'error' : controller ? 'saving' : invalid(patch()) ? 'invalid' : Object.keys(patch()).length ? 'waiting' : 'saved', error: failed });
  const publish = () => { if (!disposed) onChange(state()); };
  const cancelTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const schedule = () => {
    cancelTimer();
    if (disposed || !loaded || failed || controller || !Object.keys(patch()).length || invalid(patch())) return;
    timer = setTimer(() => { timer = null; void flush(); }, delay);
  };
  async function flush(all = false) {
    cancelTimer();
    if (disposed || !loaded || controller || failed?.conflict || (failed && !all)) return;
    const changes = patch(all);
    if (!Object.keys(changes).length) return;
    if (invalid(changes)) { failed = { validation: true, conflict: false, message: '输入无效：请填写范围内的整数与有效 HH:mm 时间；草稿未保存。' }; publish(); return; }
    const submitted = { ...draft }, expected = loaded.revision;
    controller = new AbortController(); const active = controller; failed = null; publish();
    try {
      const data = await write(changes, expected, active.signal);
      if (disposed) return;
      // A response may normalize values, but must not erase edits made in flight.
      draft = Object.fromEntries(Object.entries(data.values).map(([key, value]) => [key, draft[key] === submitted[key] && (Object.hasOwn(changes, key) || submitted[key] === loaded.values[key]) ? value : draft[key]]));
      loaded = data; onSaved(data);
    } catch (error) {
      if (!disposed) failed = { conflict: error.status === 409, message: error.status === 409 ? '设置已被其他页面修改，未覆盖。当前草稿已保留；请明确放弃草稿并重新读取后再编辑。' : '保存失败，当前草稿已保留；自动保存已暂停，请核验后重试。' };
    } finally {
      controller = null;
      if (!disposed) { publish(); schedule(); }
    }
  }
  return {
    state,
    load(data) { if (disposed || controller) return; cancelTimer(); loaded = data; draft = { ...data.values }; failed = null; publish(); },
    edit(key, value) { if (disposed || !draft) return; draft = { ...draft, [key]: value }; if (failed?.validation) failed = null; publish(); schedule(); },
    flush,
    retry() { if (disposed || failed?.conflict) return; failed = null; publish(); return flush(); },
    pause() { if (disposed || controller) return; cancelTimer(); failed = { conflict: true, message: '自动保存已暂停，等待明确重新读取。' }; publish(); },
    dispose() { disposed = true; cancelTimer(); controller?.abort(); },
  };
}

export async function readAccountQuotaBatch({ accountKeys, read, signal, onResult }) {
  if (!Array.isArray(accountKeys) || !accountKeys.length || accountKeys.length > 8 || new Set(accountKeys).size !== accountKeys.length || accountKeys.some(key => typeof key !== 'string' || !/^[a-f0-9]{16}$/.test(key)) || typeof read !== 'function') throw new Error('INVALID_ACCOUNT_BATCH');
  const localCodes = new Set(['OAUTH_REQUIRED','OAUTH_IDENTITY_INVALID','OAUTH_IDENTITY_CHANGED','ACCOUNT_NOT_BOUND','ACCOUNT_REVOKED']);
  const controller = new AbortController(), abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const results = accountKeys.map(accountKey => ({ accountKey, status: 'queued' })); let cursor = 0, halted = false;
  const emit = result => { if (!signal?.aborted) { try { onResult?.({ ...result }); } catch { halted = true; controller.abort(); } } };
  const worker = async () => {
    while (!controller.signal.aborted && cursor < results.length) {
      const index = cursor++, result = results[index]; result.status = 'running'; emit(result);
      if (controller.signal.aborted) { result.status = 'cancelled'; break; }
      try { await read(result.accountKey, controller.signal); result.status = controller.signal.aborted ? 'cancelled' : 'success'; }
      catch (error) {
        if (controller.signal.aborted) result.status = 'cancelled';
        else { result.status = 'failed'; result.code = localCodes.has(error?.code) ? error.code : error?.code === 'SOURCE_CHANGED' ? 'SOURCE_CHANGED' : 'ACCOUNT_QUERY_FAILED'; if (!localCodes.has(error?.code)) { halted = true; controller.abort(); } }
      }
      emit(result);
    }
  };
  try { await Promise.all([worker(), worker()]); for (const result of results) if (result.status === 'queued') { result.status = 'cancelled'; emit(result); } return { results: results.map(row => ({ ...row })), halted, cancelled: !!signal?.aborted }; }
  finally { signal?.removeEventListener('abort', abort); }
}

export function safeAccountDiagnostics(catalogue, models, { directoryConfirmed = false } = {}) {
  const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000 ? value : null;
  const oneOf = (value, allowed) => allowed.includes(value) ? value : 'unknown';
  const rows = Array.isArray(catalogue?.accounts) ? catalogue.accounts.slice(0, 1000) : [], catalog = models?.catalog;
  const target = catalog?.targetModel, settings = models?.settings, modelRows = Array.isArray(models?.models) ? models.models.slice(0, 1000) : [];
  const bool = value => typeof value === 'boolean' ? value : null;
  return {
    schema: 'simple-pet-account-diagnostics/v1',
    scope: 'local-cached-whitelist-only',
    implementation: { owner: catalogue?.implementation?.owner === 'simple-pet' ? 'simple-pet' : 'unconfirmed', modelDiscovery: catalogue?.implementation?.modelDiscovery === 2 ? 2 : null },
    directory: { confirmed: directoryConfirmed === true, accountCount: rows.length, boundCount: rows.filter(row => row?.bound === true).length, selectedCount: rows.filter(row => row?.selected === true).length, readableCredentialCount: rows.filter(row => row?.credentialStatus === 'available').length },
    models: { source: oneOf(catalog?.source, ['account-catalog','builtin']), status: oneOf(catalog?.status, ['ready','stale','unavailable','not-refreshed']), receivedCount: count(catalog?.receivedCount), includedCount: count(catalog?.includedCount), enabledCount: modelRows.filter(row => settings?.enabled === null || Array.isArray(settings?.enabled) && settings.enabled.includes(row?.id)).length, clientVersion: ['0.153.4','0.163.0'].includes(catalog?.clientVersion) ? catalog.clientVersion : 'unknown', requestMode: oneOf(catalog?.requestMode, ['full','conditional','not-modified']), requestProfile: catalog?.requestProfile === 'codex-models-v0.163.0' ? 'codex-models-v0.163.0' : 'unknown', target: { id: 'gpt-6.1-sol', received: bool(target?.received), accepted: bool(target?.accepted), reason: oneOf(target?.reason, [null,'missing-context','not-visible','reserve-unsupported','unsupported-input']) } },
    exclusions: ['account-identifiers','labels','emails','credentials','callback-urls','paths','raw-errors','request-bodies','warmup-journals'],
  };
}

export function createSimplePetClient(React, send = (url, init) => (globalThis.__DSH_TRANSPORT__?.fetch ?? globalThis.fetch)(url, init), services = {}) {
  const h = React.createElement;
  const { useState, useEffect, useRef } = React;
  const base = 'api/dsh-plugin-simple-pet';
  const skins = [['default','海蓝鲸鱼娘'],['night','夜航科技娘'],['snow','雪绒鲸娘'],['mint','薄荷茶娘'],['cherry','樱桃汽水娘'],['star','星砂魔法娘']];
  const cardPreview = (theme, mode, { compact = false, peak = false } = {}) => {
    const codex = mode === 'codex';
    const bar = (label, value, secondary = false) => h('div', { className: 'pet-card-quota-row', key: label },
      h('div', { className: 'pet-card-quota-label' }, h('span', null, label), h('strong', { className: secondary ? 'secondary' : '' }, `${value}%`)),
      h('div', { className: `pet-card-bar${secondary ? ' secondary' : ''}`, 'aria-hidden': true }, h('span', { style: { width: `${value}%` } })),
      !compact && h('span', { className: 'pet-card-reset' }, secondary ? '重置 10-16 09:30' : '重置 10-09 14:30'));
    return h('div', { className: `pet-card-preview ${codex ? 'codex' : 'deepseek'}${compact ? ' compact' : ''}`, style: cardCssVariables(theme, mode, peak), 'data-pet-theme': theme, 'data-pet-mode': mode, 'data-preview-only': true },
      h('div', { className: 'pet-card-header' }, h('span', null, compact ? codex ? 'Codex' : 'DeepSeek' : codex ? 'CODEX · 订阅额度' : 'DEEPSEEK · API 余额'),
        !codex && h('span', { className: 'pet-card-badge' }, peak ? '☀ 峰值价' : '☾ 谷时价')),
      codex ? h('div', { className: 'pet-card-quota' }, h('span', { className: 'pet-card-status' }, '激活 #a1b2c3d4 · 合成示意'), bar('5h 剩余', 82), bar('周剩余', 64, true)) :
        h('div', { className: 'pet-card-balance-row' }, h('strong', { className: 'pet-card-balance' }, '¥128.60'), h('span', { className: 'pet-card-hit' }, compact ? '命中 84%' : '缓存命中 84%')));
  };
  async function request(path, init = {}) {
    const res = await send(`${base}/${path}`, { credentials: 'same-origin', ...init });
    const data = await res.json();
    if (!res.ok) { const e = new Error(data.error || `请求失败（${res.status}）`); e.status = res.status; e.code = typeof data.code === 'string' && /^[A-Z_]{1,64}$/.test(data.code) ? data.code : null; throw e; }
    return data;
  }
  function SimplePetSettings() {
    const [loaded, setLoaded] = useState(null), [draft, setDraft] = useState(null), [snapshot, setSnapshot] = useState(null);
    const [error, setError] = useState(''), [note, setNote] = useState(''), [busy, setBusy] = useState(false);
    const [tab, setTab] = useState('settings'), [range, setRange] = useState('week'), [chartUnit, setChartUnit] = useState('tokens');
    const [previewPeak, setPreviewPeak] = useState(false);
    const [application, setApplication] = useState(null);
    const [account, setAccount] = useState(null);
    const [dependencyNote, setDependencyNote] = useState(''), [dependencyBusy, setDependencyBusy] = useState(false);
    const dependencyAction = useRef(false);
    const [officialCatalogue, setOfficialCatalogue] = useState(null), [officialNote, setOfficialNote] = useState(''), [officialBusy, setOfficialBusy] = useState(false);
    const [officialLabel, setOfficialLabel] = useState(''), [officialReply, setOfficialReply] = useState('');
    const [officialAdding, setOfficialAdding] = useState(false), [officialError, setOfficialError] = useState(false);
    const [officialRowNotes, setOfficialRowNotes] = useState({}), [removeTarget, setRemoveTarget] = useState(null), [accountNow, setAccountNow] = useState(Date.now());
    const officialSnapshot = useRef(null), officialBlocked = useRef(false), removeConfirmation = useRef(null), removeTrigger = useRef(null), officialReadButton = useRef(null);
    const [renameTarget, setRenameTarget] = useState(null), renameEditor = useRef(null), renameTimer = useRef(null);
    const cancelRenameTimer = () => { if (renameTimer.current !== null) clearTimeout(renameTimer.current); renameTimer.current = null; };
    const closeRename = () => { cancelRenameTimer(); renameEditor.current = null; setRenameTarget(null); };
    const [batchKeys, setBatchKeys] = useState([]), [batchResults, setBatchResults] = useState({}), [batchNote, setBatchNote] = useState(''), [batchRunning, setBatchRunning] = useState(false);
    const [diagnosticText, setDiagnosticText] = useState(''), [diagnosticNote, setDiagnosticNote] = useState('');
    // Browsing is local presentation state, never the service's default account.
    const [viewAccountKey, setViewAccountKey] = useState(null);
    const accountRows = officialCatalogue?.accounts || [];
    const viewedAccount = accountRows.find(row => row.accountKey === viewAccountKey) || accountRows.find(row => row.selected) || accountRows[0] || null;
    const cancelRemove = (restoreFocus = false) => { removeConfirmation.current = null; setRemoveTarget(null); if (restoreFocus) removeTrigger.current?.focus?.(); };
    const [officialModels,setOfficialModels]=useState(null),[modelDraft,setModelDraft]=useState(null),[modelNote,setModelNote]=useState('');
    const modelEditor=useRef({data:null,draft:null}), modelSaveTimer=useRef(null), modelSaveFailure=useRef(null);
    const cancelModelSave=()=>{if(modelSaveTimer.current!==null)clearTimeout(modelSaveTimer.current);modelSaveTimer.current=null;};
    const officialAction = useRef({ busy: false, controller: null, generation: 0 }), officialPromptId = useRef(null);
    const [multiLoaded, setMultiLoaded] = useState(null), [multiDraft, setMultiDraft] = useState(null), [boundAccounts, setBoundAccounts] = useState(null);
    const [multiBusy, setMultiBusy] = useState(false), [multiNote, setMultiNote] = useState('');
    const multiAction = useRef({ busy: false, controller: null }), multiDraftRef = useRef(null), multiLoadedRef = useRef(null);
    const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now();
    const alive = useRef(false), draftRef = useRef(null), autosave = useRef(null), preferenceReadVersion = useRef(0);
    const [saveState, setSaveState] = useState({ status: 'loading' });
    useEffect(() => {
      alive.current = true;
      autosave.current = createPreferenceAutosave({
        write: (patch, revision, signal) => request('preferences', { method: 'PUT', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch, revision }) }),
        onChange: state => { if (!alive.current) return; setSaveState(state); setLoaded(state.loaded); setDraft(state.draft); draftRef.current = state.draft; },
        onSaved: () => { if (alive.current) { setApplication(null); setNote('已保存；等待独立的桌宠应用回执。'); } },
      });
      const controller = new AbortController(), readVersion = ++preferenceReadVersion.current;
      request('preferences', { signal: controller.signal }).then(data => { if (alive.current && !controller.signal.aborted && readVersion === preferenceReadVersion.current) autosave.current.load(data); }).catch(e => { if (alive.current && !controller.signal.aborted && readVersion === preferenceReadVersion.current && e.name !== 'AbortError') setError(e.message); });
      let pending = false;
      const refresh = async () => {
        // Re-evaluate the short lease even when a previous local request is stalled.
        if (alive.current) { setAccountNow(Date.now()); setApplication(previous => previous ? { ...previous } : null); setAccount(previous => previous ? { ...previous } : null); }
        if (pending) return;
        pending = true;
        const identity = request('account', { signal: controller.signal })
          .then(data => { if (alive.current) setAccount({ ...data, receivedAt: monotonicNow() }); })
          .catch(() => { if (alive.current) setAccount(null); });
        const receipt = request('application', { signal: controller.signal })
          .then(data => { if (alive.current) setApplication({ ...data, receivedAt: monotonicNow() }); })
          .catch(() => { if (alive.current) setApplication(null); });
        try { const data = await request('state', { signal: controller.signal }); if (alive.current) setSnapshot(data); }
        catch { /* A temporary state failure never writes preferences or requests upstream data. */ }
        finally { await Promise.all([receipt, identity]); pending = false; }
      };
      void refresh();
      const timer = setInterval(refresh, 5000);
      return () => { alive.current = false; cancelModelSave(); cancelRenameTimer(); autosave.current?.dispose(); officialAction.current.controller?.abort(); multiAction.current.controller?.abort(); controller.abort(); clearInterval(timer); };
    }, []);
    const invalidateOfficial = () => {
      cancelModelSave(); modelSaveFailure.current=null; closeRename(); setViewAccountKey(null); setBatchKeys([]); setBatchResults({}); setBatchNote(''); setBatchRunning(false); setDiagnosticText(''); setDiagnosticNote('');
      const previous = officialAction.current; previous.controller?.abort();
      officialAction.current = { busy: false, controller: null, generation: previous.generation + 1 };
      officialPromptId.current = null; officialSnapshot.current = null; officialBlocked.current = false; cancelRemove(); setOfficialRowNotes({}); setOfficialBusy(false); setOfficialCatalogue(null); setOfficialNote(''); setOfficialError(false); setOfficialReply(''); setOfficialAdding(false);
      modelEditor.current={data:null,draft:null};setOfficialModels(null);setModelDraft(null);setModelNote('');
    };
    const officialGeneration = officialAction.current.generation;
    const officialRequest = async (action = null, payload = {}) => {
      if (!alive.current || officialAction.current.generation !== officialGeneration || officialAction.current.busy || loaded?.values?.codexAccountBackend !== 'official' || draftRef.current?.codexAccountBackend !== 'official') return;
      if (action && officialBlocked.current && !['models.read', 'login.cancel'].includes(action)) { setOfficialNote('账号目录尚未重新核验；请先点击刷新。不会按旧目录重发操作。'); return; }
      if (action === 'account.select' && modelEditor.current.data && JSON.stringify(modelEditor.current.draft) !== JSON.stringify(modelEditor.current.data.settings)) { setModelNote('模型草稿未保存，请等待自动保存完成或明确放弃，再选择账号；没有发送切换请求。'); return; }
      const controller = new AbortController(), generation = officialGeneration;
      let actionCommitted = false, readingCatalogue = false;
      officialAction.current = { busy: true, controller, generation, action, accountKey: payload.accountKey ?? null }; setOfficialBusy(true); setOfficialNote('');
      if (action === 'account.remove') cancelRemove();
      if (action === 'account.rename' && renameEditor.current?.accountKey === payload.accountKey) { cancelRenameTimer(); renameEditor.current = { ...renameEditor.current, status: 'saving' }; setRenameTarget(renameEditor.current); }
      const current = () => alive.current && officialAction.current.generation === generation && draftRef.current?.codexAccountBackend === 'official';
      try {
        let actionResult;
        if (action) { actionResult=await request('official-accounts', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...payload }) }); actionCommitted = true; }
        if (!current()) return;
        readingCatalogue = true;
        const data = await request('official-accounts', { signal: controller.signal });
        if (!current()) return;
        if (action === 'account.remove' && data.accounts?.some(row => row.accountKey === payload.accountKey)) throw new Error('Removal not yet verified');
        if (action === 'account.rename' && !data.accounts?.some(row => row.accountKey === payload.accountKey && row.label === payload.label && row.epoch === renameEditor.current?.epoch)) throw new Error('Rename not yet verified');
        const renaming = renameEditor.current;
        if (action === 'account.rename') closeRename();
        else if (renaming && (renaming.generation !== data.generation || !data.accounts?.some(row => row.accountKey === renaming.accountKey && row.epoch === renaming.epoch))) { cancelRenameTimer(); renameEditor.current = { ...renaming, status: 'conflict' }; setRenameTarget(renameEditor.current); }
        setBatchKeys(previous => previous.filter(key => data.accounts?.some(row => row.accountKey === key && row.bound === true)));
        setDiagnosticText('');
        officialSnapshot.current = data; officialBlocked.current = false; setOfficialError(false); setOfficialRowNotes({}); setOfficialCatalogue(data);
        setViewAccountKey(previous => data.accounts?.some(row => row.accountKey === previous) ? previous : data.accounts?.find(row => row.selected)?.accountKey || data.accounts?.[0]?.accountKey || null);
        const target = removeConfirmation.current;
        if (target && (target.generation !== data.generation || !data.accounts?.some(row => row.accountKey === target.accountKey && row.epoch === target.epoch))) cancelRemove();
        const modelsResult = action === 'account.select' ? actionResult?.models : action?.startsWith('models.') ? actionResult : null;
        if(modelsResult?.accountKey){
          if (data.accounts?.some(row => row.accountKey === modelsResult.accountKey)) setViewAccountKey(modelsResult.accountKey);
          cancelModelSave(); modelSaveFailure.current=null;
          modelEditor.current={data:modelsResult,draft:structuredClone(modelsResult.settings)};
          setOfficialModels(modelsResult);setModelDraft(modelEditor.current.draft);setModelNote(action==='models.configure'?'模型设置已单独保存；没有发送模型请求。':action==='account.select'?'已选择账号并更新该账号模型目录；新模型会通知宿主选择器，没有发送模型请求。':action==='models.refresh'?'已更新该账号模型目录；没有调用模型。':'已读取模型设置。');
        }
        if(action==='account.select'&&!modelsResult){modelEditor.current={data:null,draft:null};setOfficialModels(null);setModelDraft(null);setModelNote('账号已选中，但目录更新失败；并非确认没有 gpt-6.1-sol，请重试更新目录。');}
        if(action==='host-model.select')setModelNote('已回读确认 DSH 默认模型。已有会话若固定了旧模型，请在会话顶部手动重选。');
        if(action==='account.remove'&&modelEditor.current.data?.accountKey===payload.accountKey){modelEditor.current={data:null,draft:null};setOfficialModels(null);setModelDraft(null);setModelNote('');}
        if (action === 'account.remove') officialReadButton.current?.focus?.();
        if (action === 'login.respond' || data.login?.prompt?.id !== officialPromptId.current) setOfficialReply('');
        officialPromptId.current = data.login?.prompt?.id ?? null;
        if (action === 'login.start') setOfficialAdding(false);
        setOfficialNote(action === 'account.remove' ? '已重新读取并确认本地绑定移除；未替你选择其它账号，也未删除每日预热账本。这不是官方远端撤销。' : action === 'account.rename' ? '本机昵称已自动保存并回读确认；未更换授权、默认账号、模型或预热预算。' : action === 'account.select' && actionResult?.modelError ? '本服务默认账号已保存，但模型目录未成功更新。请点击模型后重试；没有回退或调用模型。' : action ? '操作完成，请核对账号状态。' : '账号列表已重新读取；本地凭据可读不代表远端授权或额度已验证。');
      } catch (error) {
        if (current()) {
          if (action === 'models.refresh' && modelEditor.current.data?.accountKey === payload.accountKey) {
            const data = { ...modelEditor.current.data, catalog: { ...modelEditor.current.data.catalog, status: 'stale' } };
            modelEditor.current = { ...modelEditor.current, data }; setOfficialModels(data);
          }
          const message = error.status ? error.message : '无法连接账号服务，请检查插件运行错误；未自动重试操作。';
          const conflict = error.status === 409 && (!error.code || error.code === 'SOURCE_CHANGED');
          const local = payload.accountKey && !readingCatalogue && !actionCommitted && ['OAUTH_REQUIRED', 'OAUTH_IDENTITY_INVALID', 'OAUTH_IDENTITY_CHANGED', 'ACCOUNT_NOT_BOUND', 'ACCOUNT_REVOKED', 'MODEL_CATALOG_AUTH_REQUIRED', 'MODEL_CATALOG_INVALID', 'MODEL_CATALOG_TOO_LARGE', 'MODEL_CATALOG_EMPTY', 'MODEL_CATALOG_UNAVAILABLE', 'MODEL_REVOKED', 'REASONING_UNAVAILABLE', 'INVALID_MODEL_SETTINGS', 'INVALID_LABEL'].includes(error.code);
          if (action === 'account.rename' && renameEditor.current?.accountKey === payload.accountKey) { cancelRenameTimer(); renameEditor.current = { ...renameEditor.current, status: conflict ? 'conflict' : actionCommitted || !local ? 'unverified' : 'error' }; setRenameTarget(renameEditor.current); }
          if (!local) { cancelRenameTimer(); if (renameEditor.current?.status === 'waiting') { renameEditor.current = { ...renameEditor.current, status: 'conflict' }; setRenameTarget(renameEditor.current); } cancelModelSave(); officialBlocked.current = true; setOfficialError(true); cancelRemove(); }
          if (payload.accountKey) setOfficialRowNotes(previous => ({ ...previous, [payload.accountKey]: message }));
          if (action?.startsWith('models.') || action === 'host-model.select') {
            if (action === 'models.configure') modelSaveFailure.current = conflict ? 'conflict' : 'unknown';
            setModelNote(message + ' 当前模型草稿已保留；未自动重试。' + (actionCommitted ? '操作已提交，但列表未核验，请先刷新，不要重发。' : action === 'models.configure' ? (conflict ? '请明确放弃草稿并重新读取。' : '请先核验账号状态，再决定是否重试保存。') : ''));
          }
          const outcome = action === 'account.remove' ? (conflict ? '目录已变化，本次移除未执行；请刷新后重新核对目标。' : actionCommitted ? '移除操作已提交，但列表核验失败；请先刷新，勿重复移除。' : '移除结果未确认，可能已在本机撤销；请先刷新核验，勿重复移除。') : actionCommitted ? '操作已提交，但后续列表读取失败；请先刷新核验，不要重发。' : message;
          setOfficialNote(outcome + (!local && officialSnapshot.current ? ' 保留上次读取的目录，仅供参考；相关操作已暂停。' : local ? ' 其它账号保留，本账号未回退或自动重试。' : ''));
        }
      } finally { if (officialAction.current.generation === generation) { officialAction.current.busy = false; if (alive.current) setOfficialBusy(false); } }
    };
    const beginRename = row => {
      if (!alive.current || officialAction.current.generation !== officialGeneration || officialAction.current.busy || officialBlocked.current) return;
      if (modelDirty() || renameEditor.current) { setOfficialNote('请先等待当前草稿保存或关闭编辑，再改名；未发送请求。'); return; }
      const data = officialSnapshot.current, current = data?.accounts?.find(value => value.accountKey === row.accountKey && value.epoch === row.epoch && value.bound === true);
      if (!current || !Number.isSafeInteger(data.generation) || data.capabilities?.rename !== true) return;
      cancelRemove(); renameEditor.current = { accountKey: current.accountKey, epoch: current.epoch, generation: data.generation, label: current.label, original: current.label, status: 'saved' }; setRenameTarget(renameEditor.current);
    };
    const changeRename = label => {
      const previous = renameEditor.current;
      if (!alive.current || !previous || officialAction.current.busy || officialBlocked.current || ['conflict','unverified'].includes(previous.status)) return;
      cancelRenameTimer();
      const trimmed = label.trim(), invalid = !trimmed || [...trimmed].length > 64 || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(label);
      const captured = { ...previous, label, status: invalid ? 'invalid' : trimmed === previous.original ? 'saved' : 'waiting' };
      renameEditor.current = captured; setRenameTarget(captured);
      if (captured.status !== 'waiting') return;
      const submit = () => {
        renameTimer.current = null;
        if (!alive.current || renameEditor.current !== captured || officialAction.current.generation !== officialGeneration) return;
        const data = officialSnapshot.current;
        if (officialBlocked.current || data?.generation !== captured.generation || !data.accounts?.some(row => row.accountKey === captured.accountKey && row.epoch === captured.epoch && row.bound === true)) { renameEditor.current = { ...captured, status: 'conflict' }; setRenameTarget(renameEditor.current); return; }
        if (officialAction.current.busy || modelDirty()) { renameTimer.current = setTimeout(submit, 450); return; }
        void officialRequest('account.rename', { accountKey: captured.accountKey, label: trimmed, expectedGeneration: captured.generation });
      };
      renameTimer.current = setTimeout(submit, 450);
    };
    const batchQuota = async () => {
      if (!alive.current || officialAction.current.generation !== officialGeneration || officialAction.current.busy || officialBlocked.current || loaded?.values?.codexAccountBackend !== 'official' || draftRef.current?.codexAccountBackend !== 'official') return;
      if (modelDirty() || renameEditor.current) { setBatchNote('请先完成自动保存或关闭改名，再批量查询；未发送请求。'); return; }
      const keys = batchKeys.filter(key => officialSnapshot.current?.accounts?.some(row => row.accountKey === key && row.bound === true));
      if (!keys.length || keys.length > 8) { setBatchNote('请先选择 1–8 个本地可用账号。'); return; }
      cancelRemove(); const controller = new AbortController(), generation = officialGeneration;
      officialAction.current = { busy: true, controller, generation, action: 'quota.batch' }; setOfficialBusy(true); setBatchRunning(true); setBatchResults(Object.fromEntries(keys.map(key => [key, { status: 'queued' }]))); setBatchNote('仅刷新本次勾选账号的额度，最多同时查询两个；不会登录、切号、预热或调用模型。');
      const current = () => alive.current && officialAction.current.generation === generation && draftRef.current?.codexAccountBackend === 'official';
      try {
        const result = await readAccountQuotaBatch({ accountKeys: keys, signal: controller.signal, read: (accountKey, signal) => request('official-accounts', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'quota.read', accountKey }) }), onResult: value => { if (current()) setBatchResults(previous => ({ ...previous, [value.accountKey]: value })); } });
        if (!current()) return;
        if (result.cancelled) { setBatchNote('批量查询已取消；在途 GET 可能已发出，未自动重试或清除旧额度。'); return; }
        if (result.halted) { officialBlocked.current = true; setOfficialError(true); setBatchNote('遇到来源变化或未能确认的共享错误，已停止剩余查询；请先刷新账号目录，未重试。'); return; }
        const data = await request('official-accounts', { signal: controller.signal });
        if (!current() || controller.signal.aborted) return;
        officialSnapshot.current = data; setOfficialCatalogue(data); setOfficialError(false); officialBlocked.current = false; setDiagnosticText('');
        setBatchNote('批量查询已结束，已重新读取本地额度报告；逐账号结果见下方。没有模型调用或自动重试；本机收到时间不是服务器采样时间。');
      } catch {
        if (current() && !controller.signal.aborted) { officialBlocked.current = true; setOfficialError(true); setBatchNote('查询后目录未能重新核验，保留上次报告仅供参考；请刷新账号目录，不要重复发起。'); }
      } finally { if (officialAction.current.generation === generation) { officialAction.current.busy = false; if (alive.current) { setOfficialBusy(false); setBatchRunning(false); } } }
    };
    const cancelBatch = () => { if (officialAction.current.action !== 'quota.batch' || !officialAction.current.busy) return; officialAction.current.controller?.abort(); setBatchResults(previous => Object.fromEntries(Object.entries(previous).map(([key, value]) => [key, ['queued','running'].includes(value.status) ? { status: 'cancelled' } : value]))); setBatchNote('已要求取消剩余查询；在途 GET 可能已发送，未自动重试。'); };
    const generateDiagnostics = () => { setDiagnosticText(JSON.stringify(safeAccountDiagnostics(officialSnapshot.current, modelEditor.current.data, { directoryConfirmed: !officialBlocked.current && !officialError }), null, 2)); setDiagnosticNote('仅根据本机已缓存的白名单字段生成；未新增任何账号、额度或模型请求。导出前可核对下方内容。'); };
    const downloadDiagnostics = () => {
      if (!diagnosticText) return; let url;
      try { url = URL.createObjectURL(new Blob([diagnosticText], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'simple-pet-account-diagnostics.json'; document.body.appendChild(link); link.click(); link.remove(); setDiagnosticNote('已生成本地诊断下载；没有上传任何数据。'); }
      catch { setDiagnosticNote('当前环境不能直接下载，请从下方只读文本复制；没有上传或发送请求。'); }
      finally { if (url) URL.revokeObjectURL(url); }
    };
    const beginRemove = (row, event) => {
      if (!alive.current || officialAction.current.busy || officialBlocked.current) return;
      if (modelDirty() || renameEditor.current) { setModelNote('模型或昵称草稿尚未保存；请等待自动保存完成或关闭改名，再移除账号。'); return; }
      const data = officialSnapshot.current, current = data?.accounts?.find(account => account.accountKey === row.accountKey);
      if (!current || current.epoch !== row.epoch || !Number.isSafeInteger(data.generation)) return;
      cancelModelSave(); removeTrigger.current = event?.currentTarget ?? null;
      const target = { accountKey: current.accountKey, label: current.label, selected: current.selected, epoch: current.epoch, generation: data.generation };
      removeConfirmation.current = target; setRemoveTarget(target);
    };
    const confirmRemove = () => {
      const target = removeConfirmation.current, data = officialSnapshot.current;
      if (!target || officialAction.current.busy || officialBlocked.current) return;
      if (data?.generation !== target.generation || !data.accounts?.some(row => row.accountKey === target.accountKey && row.epoch === target.epoch)) {
        cancelRemove(true); setOfficialNote('账号目录或目标已变化，请刷新并重新确认；未执行移除。'); return;
      }
      void officialRequest('account.remove', { accountKey: target.accountKey, expectedGeneration: target.generation });
    };
    const modelDirty=()=>!!modelEditor.current.data&&JSON.stringify(modelEditor.current.draft)!==JSON.stringify(modelEditor.current.data.settings);
    const viewAccount = row => {
      if (!alive.current || officialAction.current.generation !== officialGeneration || officialAction.current.busy || draftRef.current?.codexAccountBackend !== 'official') return false;
      if (modelDirty() || renameEditor.current) { setOfficialNote('请先等待自动保存完成或关闭编辑，再查看其他账号；草稿保留，没有发送请求。'); return false; }
      if (!officialSnapshot.current?.accounts?.some(value => value.accountKey === row.accountKey && value.epoch === row.epoch)) return false;
      cancelRemove(); setViewAccountKey(row.accountKey); return true;
    };
    const openModels=(key,refresh=true,discard=false)=>{
      if(!alive.current||officialAction.current.busy)return;
      if(modelDirty()&&!discard){setModelNote('模型草稿尚未保存，请等待自动保存完成，或明确放弃；没有重新读取或改动账号。');return;}
      cancelModelSave();
      void officialRequest(refresh?'models.refresh':'models.read',{accountKey:key});
    };
    const changeModel=patch=>{
      if(!alive.current||officialAction.current.busy||!modelEditor.current.data)return;
      const next={...modelEditor.current.draft,...patch};modelEditor.current={...modelEditor.current,draft:next};setModelDraft(next);cancelModelSave();
      if(modelSaveFailure.current){setModelNote('模型自动保存已暂停；草稿保留，请核验后重试保存或明确放弃并重新读取。');return;}
      if(!modelDirty()){setModelNote('模型设置已保存；没有更改 DSH 默认或发送模型请求。');return;}
      setModelNote('等待自动保存模型偏好；不会更改 DSH 默认或发送模型请求。');
      const captured=modelEditor.current;
      const submitWhenIdle=()=>{
        modelSaveTimer.current=null;
        if(!alive.current||modelEditor.current!==captured||officialAction.current.generation!==officialGeneration||modelSaveFailure.current||officialBlocked.current)return;
        if(officialAction.current.busy){setModelNote('其他账号操作进行中；结束后将自动保存模型偏好。');modelSaveTimer.current=setTimeout(submitWhenIdle,450);return;}
        saveModels();
      };
      modelSaveTimer.current=setTimeout(submitWhenIdle,450);
    };
    const saveModels=()=>{
      cancelModelSave();
      const current=modelEditor.current;if(!current.data||current.data.accountKey!==officialModels?.accountKey||officialError||!modelDirty())return;
      if(modelSaveFailure.current==='conflict'){setModelNote('模型配置已变化；自动保存已暂停，请明确放弃草稿并重新读取。');return;}
      setModelNote('正在保存模型偏好；没有发送模型请求。');
      void officialRequest('models.configure',{accountKey:current.data.accountKey,expectedGeneration:current.data.generation,settings:structuredClone(current.draft)});
    };
    useEffect(() => {
      if (tab !== 'accounts' || loaded?.values?.codexAccountBackend !== 'official' || draft?.codexAccountBackend !== 'official' || !['running', 'prompt'].includes(officialCatalogue?.login?.status)) return;
      // Only an explicitly started/discovered active login is polled. No login,
      // quota fetch, mutation retry or account enumeration is started on mount.
      const timer = setInterval(() => { void officialRequest(); }, 2000);
      return () => clearInterval(timer);
    }, [tab, officialGeneration, loaded?.values?.codexAccountBackend, draft?.codexAccountBackend, officialCatalogue?.login?.id, officialCatalogue?.login?.status]);
    const changeMulti = (patch, accountKey = null) => {
      const previous = multiDraftRef.current;
      if (!previous || multiAction.current.busy) return;
      const next = accountKey ? { ...previous, accounts: previous.accounts.map(row => row.accountKey === accountKey ? { ...row, ...patch } : row) } : { ...previous, ...patch };
      multiDraftRef.current = next; setMultiDraft(next); setMultiNote('尚未保存多账号设置；不会因此发送请求。');
    };
    const multiRequest = async saveConfig => {
      if (!alive.current || multiAction.current.busy || (saveConfig && !multiLoadedRef.current)) return;
      if (!saveConfig && multiDraftRef.current && JSON.stringify(multiDraftRef.current) !== JSON.stringify(multiLoadedRef.current?.config)) {
        setMultiNote('存在未保存草稿，请先保存，或明确放弃草稿再重新读取；不会偷偷变更保存基线。'); return;
      }
      const controller = new AbortController(); multiAction.current = { busy: true, controller }; setMultiBusy(true); setMultiNote('');
      try {
        if (saveConfig) {
          const current = multiDraftRef.current, loaded = multiLoadedRef.current;
          const value = await request('multi-warmup', { method: 'PUT', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: current, revision: loaded.revision }) });
          if (!alive.current) return;
          multiLoadedRef.current = value; multiDraftRef.current = value.config;
          setMultiLoaded(value); setMultiDraft(value.config); setMultiNote('已保存。仅在以后准时触发且通过绑定/认领检查时发送；本次保存不执行预热。');
        } else {
          const value = await request('multi-warmup', { signal: controller.signal });
          if (!alive.current) return;
          multiLoadedRef.current = value; setMultiLoaded(value);
          // Dirty rereads are rejected above; a clean draft MUST follow the new
          // baseline, or saving could restore grants revoked by another editor.
          multiDraftRef.current = value.config; setMultiDraft(value.config);
          const catalogue = await request('multi-warmup', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'discover' }) });
          if (!alive.current) return;
          setBoundAccounts(catalogue.accounts || []); setMultiNote('已读取公共绑定目录；没有发送预热请求。已有草稿保留。');
        }
      } catch (cause) { if (alive.current) setMultiNote(cause.status === 409 ? '设置或能力已变化，请重新读取；草稿保留，不自动覆盖或重试。' : cause.message); }
      finally { multiAction.current.busy = false; if (alive.current) setMultiBusy(false); }
    };
    const selectMultiAccount = (account, enabled) => {
      const previous = multiDraftRef.current;
      if (!previous || multiAction.current.busy) return;
      if (previous.accounts.some(row => row.accountKey === account.accountKey)) { changeMulti({ enabled }, account.accountKey); return; }
      if (!enabled || !account.models?.length || previous.accounts.length >= 8) { setMultiNote('最多配置八个账号；新账号需要可用的绑定模型。'); return; }
      changeMulti({ accounts: [...previous.accounts, { accountKey: account.accountKey, modelKey: account.models[0].modelKey, enabled: true, allowUnverifiedQuota: false }] });
    };
    const reloadAction = useRef(null);
    const change = (key, value) => {
      if (!alive.current || reloadAction.current) return;
      if (key === 'codexAccountBackend') invalidateOfficial();
      autosave.current?.edit(key, value); setNote('');
    };
    const reload = async () => {
      if (!alive.current || reloadAction.current || autosave.current?.state().inFlight) return;
      // This button explicitly discards drafts. Suspend the debounce before GET,
      // so an old timer can never race a newly read revision.
      autosave.current?.pause();
      const controller = new AbortController(); reloadAction.current = controller; ++preferenceReadVersion.current;
      setBusy(true); setError('');
      try {
        const data = await request('preferences', { signal: controller.signal });
        if (alive.current && !controller.signal.aborted) {
          if (data.values.codexAccountBackend !== draftRef.current?.codexAccountBackend) invalidateOfficial();
          autosave.current.load(data); setNote('已放弃草稿并读取当前已保存设置。');
        }
      } catch (e) { if (alive.current && !controller.signal.aborted) setError('重新读取失败；草稿保留，自动保存暂停。请重试重新读取。'); }
      finally { reloadAction.current = null; if (alive.current) setBusy(false); }
    };
    useEffect(() => () => reloadAction.current?.abort(), []);
    const save = () => { if (alive.current && !reloadAction.current && !autosave.current?.state().error?.conflict) return autosave.current?.flush(true); };
    const field = (key, label, options) => h('label', { className: 'pet-settings-row', key }, h('span', null, label),
      h('select', { name: key, value: draft[key] ?? (key === 'feedbackStyle' ? 'classic' : ''), disabled: busy, onChange: e => change(key, e.target.value) }, ...options.map(([value, text]) => h('option', { key: value, value }, text))));
    const number = (key, label, min, max) => h('label', { className: 'pet-settings-row', key }, h('span', null, label),
      h('input', { type: 'number', min, max, step: 1, value: draft[key], disabled: busy, onChange: e => change(key, e.target.value === '' ? '' : Number(e.target.value)) }));
    const toggle = (key, label) => h('label', { className: 'pet-settings-toggle', key },
      h('input', { name: key, type: 'checkbox', checked: draft[key] === true, disabled: busy, onChange: e => change(key, e.target.checked) }), h('span', null, label));
    const dependencyControls = () => h('div', null,
      h('p', { className: 'pet-settings-hint' }, '点击下方按钮即授权宿主为当前配置安装并启用通用订阅 0.9.9（会执行插件代码）；不自动批准构建脚本、不登录、不请求模型、不主动替换已安装同名插件。请勿同时在其他页面安装同名依赖；宿主没有原子“仅不存在时安装”接口。'),
      h('button', { type: 'button', 'data-dependency-install': true, disabled: dependencyBusy, onClick: async () => {
        if (!alive.current || dependencyAction.current) return;
        dependencyAction.current = true; setDependencyBusy(true); setDependencyNote('正在检查依赖；不会登录或请求模型。');
        try { const message = await installPanelDependency(services.pluginManager, () => alive.current); if (alive.current) setDependencyNote(message); }
        finally { dependencyAction.current = false; if (alive.current) setDependencyBusy(false); }
      } }, dependencyBusy ? '依赖操作中…' : '一键安装并启用通用订阅 0.9.9'),
      h('p', { role: 'status', className: 'pet-settings-hint', 'data-dependency-status': true }, dependencyNote));
    const pages = [['settings', '常规'], ['appearance', '外观与动效'], ['accounts', '账号管理'], ['warmup', '自动预热'], ['stats', '用量统计']];
    const groupPages = { '订阅账号（内置管理）': 'accounts', '显示与休眠': 'settings', '陪伴与舒适': 'appearance', '形象': 'appearance', '信息框主题': 'appearance', '组合预览': 'appearance', '多账号管理（桌宠面板切换）': 'accounts', '多账号定时预热（单独授权，默认关闭）': 'warmup', 'Codex 配额与自动预热': 'warmup' };
    const group = (title, ...children) => {
      const page = groupPages[title] || 'appearance';
      const heading = title === '订阅账号（内置管理）' ? '账号与额度' : title === '多账号管理（桌宠面板切换）' ? '桌宠账号切换' : title;
      return h('section', { className: 'pet-settings-group', hidden: tab !== page, 'data-pet-page': page, 'aria-label': title }, h('h3', null, heading), ...children);
    };
    const codex = draft?.billingMode === 'codex';
    const today = calendarDate(loaded?.timeZone), key = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    const ledger = codex ? snapshot?.codexStats : snapshot?.stats;
    const day = ledger?.days?.[key];
    const fmt = (v, money = false) => typeof v === 'number' && Number.isFinite(v) ? (money ? `¥${v.toLocaleString('zh-CN', { maximumFractionDigits: v < 1 ? 8 : 2 })}` : v.toLocaleString('zh-CN', { maximumFractionDigits: 0 })) : '—';
    const modelControls=()=>{
      if(!officialModels||!modelDraft)return null;
      const rows=officialModels.models||[],owner=officialCatalogue?.accounts?.find(row=>row.accountKey===officialModels.accountKey);
      const enabled=id=>modelDraft.enabled===null||modelDraft.enabled.includes(id);
      const selected=rows.find(row=>row.id===modelDraft.defaultModel&&enabled(row.id));
      const dirty=modelDirty(),disabled=officialBusy||officialError||owner?.bound!==true;
      const host=officialCatalogue?.hostModel||officialModels.hostModel;
      const currentModel=host?.managed?(host.model?.split(':').slice(1).join(':')||''):'由 DSH 当前设置决定';
      const effortName={off:'关闭',minimal:'极低',low:'低',medium:'中',high:'高',xhigh:'超高',max:'最高'};
      return h('section',{className:'pet-model-panel','data-official-model-panel':officialModels.accountKey},
        h('div',{className:'pet-model-heading'},h('div',null,h('h4',null,`模型 · ${owner?.label||'#'+officialModels.accountKey.slice(0,8)}`),h('p',{className:'pet-settings-hint'},officialModels.catalog?.source==='account-catalog'?'来自该账号返回的模型目录。':'本地兼容目录；点「更新账号目录」读取当前账号提供的模型。')),
          h('button',{type:'button',disabled:officialBusy,'data-model-refresh':true,onClick:()=>openModels(officialModels.accountKey,true)},'更新账号目录')),
        h('details', { className: 'pet-settings-details pet-model-diagnostics', 'data-model-catalog-details': true }, h('summary', null, '目录来源与兼容详情'),
        h('p', { className: 'pet-settings-hint', 'data-model-catalog-diagnostic': true }, (() => {
          const catalog = officialModels.catalog || {}, count = n => Number.isSafeInteger(n) && n >= 0 && n <= 1000 ? n : '未知';
          const source = catalog.source === 'account-catalog' ? '账号在线目录' : '离线 SDK 列表（不是账号权限证明）';
          return `目录来源：${source}；状态：${catalog.status === 'ready' ? '已读取' : catalog.status === 'stale' ? '更新失败，上次结果仅供参考' : '尚未在线更新'}；服务端条目 ${count(catalog.receivedCount)}，解析可用 ${count(catalog.includedCount)}，本账号启用 ${rows.filter(row => enabled(row.id)).length}。` +
            (catalog.requestMode === 'full' ? '缓存记录的读取模式为完整 GET，未采用 ETag；本次是否成功以上述状态为准。' : '') +
            (typeof catalog.clientVersion === 'string' && /^[0-9.]{1,32}$/.test(catalog.clientVersion) ? `兼容查询版本 ${catalog.clientVersion}。` : '') +
            (catalog.requestProfile === 'codex-models-v0.163.0' ? '目录协议目标 Codex 0.163.0；保留本插件的 pi/UA 身份，非官方客户端或账号可用性证明。' : '');
        })())),
        officialCatalogue?.implementation?.modelDiscovery !== 2 && h('p', { className: 'pet-settings-error', 'data-model-owner-unconfirmed': true }, '当前账号服务实现尚未确认。旧独立插件或尚未退出的宿主进程可能仍占用路由；安装文件更新不代表运行中服务已切换。请自行完整退出并重开 DSH 后再更新目录，不要删除授权或预热记录。'),
        officialModels.catalog?.capabilityGaps?.some(row=>row.reason==='context-limit-unreported')&&h('p',{className:'pet-settings-hint','data-model-context-note':true},'部分新模型未报告上下文上限，已保留为可选模型并暂用本地 8192-token 请求预算；这不是服务端真实上限，也不保证该账号有使用权限。'),
        h('p',{className:'pet-settings-hint','data-host-model-state':true},`DSH 默认：${/^[a-f0-9]{64}$/.test(currentModel)?'旧版模型入口，请重新选择':currentModel}。已有会话若锁定旧模型，需在会话顶部手动重选。`),
        h('label',{className:'pet-settings-row'},h('span',null,'该账号首选模型'),h('select',{'data-model-default':true,value:modelDraft.defaultModel||'',disabled,onChange:e=>changeModel({defaultModel:e.target.value||null,reasoningEffort:null})},
          h('option',{value:''},'未指定'),
          modelDraft.defaultModel&&!selected&&h('option',{value:modelDraft.defaultModel},'已保存模型不可用，请重选'),
          ...rows.filter(row=>enabled(row.id)).map(row=>h('option',{key:row.id,value:row.id},`${row.name} · ${row.id}`)))),
        h('label',{className:'pet-settings-row'},h('span',null,'推理档位'),h('select',{'data-model-reasoning':true,value:modelDraft.reasoningEffort||'',disabled:disabled||!selected,onChange:e=>changeModel({reasoningEffort:e.target.value||null})},
          h('option',{value:''},'按模型默认'),...(selected?.reasoning?.efforts||[]).map(e=>h('option',{key:e.id,value:e.id},effortName[e.id]||e.id)))),
        h('details',{className:'pet-settings-details'},h('summary',null,`在模型选择器提供哪些模型（${rows.filter(row=>enabled(row.id)).length}/${rows.length}）`),
          h('label',{className:'pet-settings-toggle'},h('input',{type:'checkbox',checked:modelDraft.enabled===null,disabled,'data-model-follow':true,onChange:e=>changeModel({enabled:e.target.checked?null:rows.map(row=>row.id)})}),h('span',null,'跟随该账号目录，自动提供可用模型')),
          h('div',{className:'pet-model-list'},...rows.map(row=>h('label',{key:row.id,className:'pet-model-row'},
            h('input',{type:'checkbox',checked:enabled(row.id),disabled,'data-model-enabled':row.id,onChange:e=>{
              const ids=modelDraft.enabled===null?rows.map(item=>item.id):modelDraft.enabled;
              changeModel({enabled:e.target.checked?[...new Set([...ids,row.id])]:ids.filter(id=>id!==row.id),...(!e.target.checked&&modelDraft.defaultModel===row.id?{defaultModel:null,reasoningEffort:null}:{})});
            }}),h('span',null,h('strong',null,row.name),h('small',null,row.id)),h('span',{className:'pet-settings-hint'},row.inputModalities?.includes('image')?'文本 / 图片':'文本'))))),
        h('p',{className:'pet-settings-hint','data-model-sol-status':true},(()=>{
          const sol=rows.find(row=>row.id==='gpt-6.1-sol'),catalog=officialModels.catalog;
          if(catalog?.status==='stale')return '本次目录更新失败；保留的模型列表仅供参考，不能判断 gpt-6.1-sol 本次是否返回。请先核验账号服务再更新目录。';
          if(sol)return enabled(sol.id)?'gpt-6.1-sol 已在此账号目录中启用；模型偏好自动保存，已有会话需手动重选模型。':'已发现 gpt-6.1-sol，但被本账号可见模型筛选关闭。勾选该模型或启用「跟随目录」后会自动保存。';
          if(catalog?.status!=='ready'||catalog?.source!=='account-catalog')return '尚未成功更新此账号的在线目录；内置列表缺少 gpt-6.1-sol 不代表账号没有权限。请更新账号目录。';
          const omitted=catalog.targetModel?.received===true&&!catalog.targetModel.accepted?{reason:catalog.targetModel.reason}:catalog.omitted?.find(row=>row.id==='gpt-6.1-sol');
          if(omitted)return `目录返回了 gpt-6.1-sol，但当前不可提供：${({'missing-context':'未提供可验证的上下文上限','not-visible':'服务端标记为隐藏','reserve-unsupported':'不支持的储备模型','unsupported-input':'不支持的输入类型'})[omitted.reason]||'模型能力不完整'}。未假造授权或上下文。`;
          return catalog.targetModel?.received===false ? '本次完整解析未发现 gpt-6.1-sol 的 slug；这不是该账号无权限的证明。不会改用 API Key 或添加无法验证的假入口。' : '当前服务未提供 gpt-6.1-sol 的完整目标检查结果；不能把缺少显示诊断当成服务端未返回。请重开 DSH 后更新账号目录。';
        })()),
        h('div',{className:'pet-account-actions'},
          modelSaveFailure.current && modelSaveFailure.current!=='conflict' && h('button',{type:'button',disabled:disabled||!dirty,'data-model-save':true,'data-model-retry':true,onClick:saveModels},'重试自动保存模型偏好'),
          h('button',{type:'button',disabled:disabled||dirty||!selected||host?.available!==true,'data-model-use':true,onClick:()=>void officialRequest('host-model.select',{accountKey:officialModels.accountKey,modelKey:selected.modelKey})},'设为 DSH 默认（固定此账号）'),
          h('button',{type:'button',disabled:officialBusy,'data-model-discard':true,onClick:()=>openModels(officialModels.accountKey,false,true)},'放弃草稿并重载')),
        h('p',{className:'pet-settings-hint',role:'status','data-model-status':true},modelNote||'模型偏好自动保存；更改 DSH 默认仍需明确点击。目录读取和偏好保存都不会发送模型请求。'),
        h('p',{className:'pet-settings-hint'},'模型偏好自动保存；只影响本账号在 codex-accounts 中的模型选择，不更改 DSH 默认、其他插件、预热授权或已有去重记录。未知价格不会被当作免费承诺。'));
    };
    const accountTools = () => officialCatalogue && h('details', { className: 'pet-settings-details pet-account-tools', 'data-official-tools': true },
      h('summary', null, '批量查询与脱敏诊断'),
      h('p', { className: 'pet-settings-hint' }, '明确勾选后才查询；最多八个账号、并发两个。不会登录、切号、预热或调用模型；未确认的共享错误会停止队列。'),
      h('div', { className: 'pet-account-batch-list' }, ...accountRows.map(row => h('div', { key: row.accountKey },
        h('label', { className: 'pet-settings-toggle pet-account-batch-check' }, h('input', { type: 'checkbox', checked: batchKeys.includes(row.accountKey), disabled: officialBusy || officialError || row.bound !== true || !batchKeys.includes(row.accountKey) && batchKeys.length >= 8, 'data-official-batch-account': row.accountKey, onChange: event => { if (!alive.current || officialAction.current.busy || officialBlocked.current || officialAction.current.generation !== officialGeneration) return; const checked = event.target.checked; setBatchKeys(previous => checked ? previous.includes(row.accountKey) || previous.length >= 8 ? previous : [...previous, row.accountKey] : previous.filter(key => key !== row.accountKey)); } }), `批量查询：${row.label}`),
        batchResults[row.accountKey] && h('p', { role: 'status', className: 'pet-settings-hint', 'data-official-batch-result': row.accountKey }, ({ queued: '批量查询：排队中', running: '批量查询：查询中', success: '批量查询：已收到额度响应', failed: '批量查询：失败 · 未自动重试', cancelled: '批量查询：已取消或未执行 · 未重试' })[batchResults[row.accountKey].status])))),
      h('div', { className: 'pet-account-actions' },
        h('button', { type: 'button', disabled: officialBusy || officialError, 'data-official-batch-select': true, onClick: () => setBatchKeys((officialSnapshot.current?.accounts || []).filter(row => row.bound === true).slice(0, 8).map(row => row.accountKey)) }, '勾选可用账号（最多八个）'),
        h('button', { type: 'button', disabled: officialBusy || officialError || !batchKeys.length, 'data-official-batch-read': true, onClick: () => void batchQuota() }, `刷新所选额度（${batchKeys.length}）`),
        batchRunning && h('button', { type: 'button', 'data-official-batch-cancel': true, onClick: cancelBatch }, '取消剩余查询')),
      h('p', { role: 'status', className: 'pet-settings-hint', 'data-official-batch-status': true }, batchNote || '勾选或展开本区域不会发送查询。'),
      h('button', { type: 'button', 'data-official-diagnostics': true, onClick: generateDiagnostics }, '生成本地脱敏诊断'),
      h('p', { className: 'pet-settings-hint' }, '仅导出本地缓存的白名单统计与兼容状态，不含昵称、邮箱、账号标识、凭据、路径、回调、原始错误或预热账本。不会上传或新增请求。'),
      diagnosticText && h('div', null, h('textarea', { className: 'pet-account-diagnostic', readOnly: true, value: diagnosticText, rows: 9, 'aria-label': '可核对的脱敏诊断 JSON', 'data-official-diagnostic-json': true }), h('button', { type: 'button', 'data-official-diagnostics-download': true, onClick: downloadDiagnostics }, '下载这份诊断 JSON')),
      diagnosticNote && h('p', { role: 'status', className: 'pet-settings-hint' }, diagnosticNote));
    const quota = q => Number.isFinite(q?.remainingPercent) && q.remainingPercent >= 0 && q.remainingPercent <= 100 ? `${q.remainingPercent.toFixed(1)}%` : '—';
    const warmup = snapshot?.codexWarmup;
    const buckets = statBuckets(ledger?.days, range, codex ? 'tokens' : chartUnit, today);
    const max = Math.max(1, ...buckets.map(b => b.value)) * 1.18;
    const dirty = loaded && draft && Object.keys(draft).some(k => draft[k] !== loaded.values[k]);
    return h('div', { className: 'pet-settings', 'data-pet-settings': true },
      h('header', { className: 'pet-settings-toolbar', 'data-settings-toolbar': true },
      h('div', { className: 'pet-settings-heading' }, h('h2', null, '桌宠'),
        h('div', { className: 'pet-settings-actions pet-settings-savebar' },
          h('span', { className: 'pet-settings-save-state', role: 'status', 'aria-live': 'polite', 'data-autosave-status': saveState.status, 'aria-busy': saveState.inFlight || undefined }, error ? '设置读取失败' : ({ loading: '正在读取设置', waiting: '等待自动保存…', saving: '保存中…', invalid: '输入未完成或超出范围，尚未保存', error: '保存失败 · 草稿保留', saved: saveState.explicitDirty ? '普通偏好已保存 · 授权/来源待确认' : '设置已保存' })[saveState.status]),
          saveState.status === 'error' && !saveState.error?.conflict && saveState.safeDirty && h('button', { type: 'button', 'data-settings-save': true, 'data-autosave-retry': true, disabled: busy || saveState.inFlight || !!error, onClick: () => void autosave.current?.retry() }, '重试自动保存'),
          h('button', { type: 'button', disabled: busy || saveState.inFlight, onClick: reload }, dirty ? '放弃草稿并重新读取' : '重新读取'))),
      h('div', { className: 'pet-settings-tabs pet-settings-page-nav', role: 'tablist', 'aria-label': '桌宠子页面', onKeyDown: event => {
        const index = pages.findIndex(([id]) => id === tab);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? pages.length - 1 : event.key === 'ArrowRight' ? (index + 1) % pages.length : event.key === 'ArrowLeft' ? (index + pages.length - 1) % pages.length : -1;
        if (next < 0) return;
        event.preventDefault(); setTab(pages[next][0]); event.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus();
      } }, ...pages.map(([id, label]) => h('button', { type: 'button', role: 'tab', key: id, id: `pet-tab-${id}`, 'data-pet-tab': id, 'aria-controls': 'pet-settings-page-content', tabIndex: tab === id ? 0 : -1, 'aria-selected': tab === id, onClick: () => setTab(id) }, label))),
      h('details', { className: 'pet-settings-details pet-settings-save-help', 'data-save-explanation': true }, h('summary', null, '自动保存与授权'),
        h('p', { className: 'pet-settings-hint', 'data-page-save-hint': true }, '设置与模型偏好修改后自动保存，无需点击保存。预热授权、账号来源和桌宠切号权限是独立的确认操作，不随普通设置提交。')),
      saveState.explicitDirty && h('div', { className: 'pet-settings-group', 'data-authorization-confirm': true },
        h('p', { className: 'pet-settings-hint' }, '以下授权／来源修改尚未生效：' + Object.keys(draft || {}).filter(key => !AUTOSAVE_PREFERENCE_KEYS.includes(key) && draft[key] !== loaded?.values[key]).map(key => PREFERENCE_AUTHORIZATION_LABELS[key] || key).join('、') + '。确认可能改变后续请求或账号来源；不会清除预热暂停与去重记录。'),
        h('button', { type: 'button', 'data-settings-save': true, 'data-authorization-apply': true, disabled: busy || saveState.inFlight || saveState.error?.conflict || !!error, onClick: () => void save() }, '确认上述授权／来源修改'))),
      h('div', { id: 'pet-settings-page-content', role: 'tabpanel', 'aria-labelledby': `pet-tab-${tab}` },
      tab === 'accounts' && !codex && h('p', { className: 'pet-settings-hint' }, '可在此管理订阅账号；要在桌宠显示额度，再到「常规」选择 Codex。'),
      (error || saveState.error) && h('p', { role: 'alert', className: 'pet-settings-error' }, error || saveState.error.message), note && h('p', { role: 'status', className: 'pet-settings-hint' }, note),
      draft && group('订阅账号（内置管理）',
        h('details', { className: 'pet-settings-details pet-account-source', 'data-account-source-details': true }, h('summary', null, `账号来源 · ${draft.codexAccountBackend === 'official' ? '内置 ChatGPT OAuth' : '原订阅插件'}`),
          field('codexAccountBackend', '账号来源', [['legacy','原订阅插件'],['official','内置账号管理 · ChatGPT OAuth']]),
          h('p', { className: 'pet-settings-hint' }, '账号管理已内置 simple-pet，无需另外安装账号插件。复用官方 ChatGPT 订阅 OAuth，不是 Platform API Key，也不是 DSH 官方出品。已有本项目账号在原凭据命名空间直接复用，不复制令牌；不读取其他订阅插件授权。旧独立包请停用以避免重复路由。默认仅影响本服务后续新请求；旧单账号预热暂停，逐账号每日计划另行授权。')),
        draft?.codexAccountBackend === 'official' && h('div', { className: 'pet-account-panel', 'data-official-panel': true },
          h('div', { className: 'pet-account-toolbar' },
            h('div', null, h('strong', null, '订阅账号'), h('span', { className: `pet-account-state${officialError ? ' is-error' : ''}`, 'data-official-connection': true }, officialBusy ? '处理中…' : officialError ? officialCatalogue ? '上次目录 · 尚未重新核验' : '账号目录读取失败' : officialCatalogue ? `绑定记录 ${(officialCatalogue.accounts || []).length} · 本地可读 ${(officialCatalogue.accounts || []).filter(row => row.bound === true).length}` : '尚未读取')),
            h('div', { className: 'pet-account-actions' },
              h('button', { type: 'button', ref: officialReadButton, 'data-official-read': true, disabled: officialBusy || loaded?.values?.codexAccountBackend !== 'official', onClick: () => void officialRequest() }, '刷新账号目录'),
              h('button', { type: 'button', 'data-official-add': true, disabled: officialBusy || officialError || loaded?.values?.codexAccountBackend !== 'official' || ['running','prompt'].includes(officialCatalogue?.login?.status), onClick: () => setOfficialAdding(value => !value) }, '添加账号'))),
          loaded?.values?.codexAccountBackend !== 'official' && h('p', { className: 'pet-settings-hint', 'data-official-needs-save': true }, '请在上方单独确认「账号来源」修改，再添加或读取账号；这不是普通设置的保存按钮，选择来源不会自动登录。'),
          officialAdding && h('div', { className: 'pet-account-add' },
            h('label', { className: 'pet-settings-row' }, h('span', null, '账号昵称（选填）'), h('input', { value: officialLabel, maxLength: 64, 'data-official-label': true, onChange: e => setOfficialLabel(e.target.value), placeholder: '例如：工作账号' })),
            h('div', { className: 'pet-account-actions' },
              h('button', { type: 'button', 'data-official-login': true, disabled: officialBusy || officialError || loaded?.values?.codexAccountBackend !== 'official', onClick: () => void officialRequest('login.start', { label: officialLabel }) }, '开始官方授权'),
              h('button', { type: 'button', disabled: officialBusy, onClick: () => setOfficialAdding(false) }, '取消'))),
          officialCatalogue?.login && h('div', { className: 'pet-account-login', 'data-official-login-progress': true },
            h('p', { role: 'status' }, ({ running: '等待官方授权，进度会自动更新。', prompt: '请按下方提示完成官方授权。', completed: '账号绑定成功。', cancelled: '本次登录已取消。', failed: officialCatalogue.login.errorCode === 'DUPLICATE_ACCOUNT' ? '此订阅账号已经绑定，无需重复添加。' : '本次授权未完成。可重新添加并选择设备码登录。' })[officialCatalogue.login.status] || '正在确认登录状态。'),
            officialCatalogue.login.event?.url && h('a', { className: 'pet-account-auth-link', href: officialCatalogue.login.event.url, target: '_blank', rel: 'noopener noreferrer' }, '打开官方登录页面'),
            officialCatalogue.login.event?.userCode && h('p', null, `设备验证码：${officialCatalogue.login.event.userCode}`),
            officialCatalogue.login.prompt?.choices && h('div', { className: 'pet-account-actions' }, ...officialCatalogue.login.prompt.choices.map(value => h('button', { key: value, type: 'button', disabled: officialBusy, 'data-official-login-method': value, onClick: () => void officialRequest('login.respond', { id: officialCatalogue.login.id, promptId: officialCatalogue.login.prompt.id, value }) }, value === 'browser' ? '浏览器登录（推荐）' : value === 'device_code' ? '设备码登录' : '继续授权'))),
            officialCatalogue.login.prompt && !officialCatalogue.login.prompt.choices && h('details', { className: 'pet-settings-details' }, h('summary', null, '浏览器没有自动完成？手动提交回调'),
              h('input', { type: 'text', autoComplete: 'off', value: officialReply, maxLength: 4096, onChange: e => setOfficialReply(e.target.value), 'aria-label': '官方回调 URL（仅回调失败时）' }),
              h('button', { type: 'button', disabled: officialBusy || !officialReply, onClick: () => void officialRequest('login.respond', { id: officialCatalogue.login.id, promptId: officialCatalogue.login.prompt.id, value: officialReply }) }, '提交回调')),
            ['running','prompt'].includes(officialCatalogue.login.status) && h('button', { type: 'button', disabled: officialBusy, onClick: () => void officialRequest('login.cancel', { id: officialCatalogue.login.id }) }, '取消登录')),
          officialCatalogue && !(officialCatalogue.accounts || []).length && h('p', { className: 'pet-account-empty' }, '还没有绑定账号，点击「添加账号」开始。'),
          officialError && officialCatalogue && h('p', { role: 'alert', className: 'pet-settings-error', 'data-official-stale-directory': true }, '以下是上次读取的目录，不代表重新验证成功。操作已暂停；请先刷新核验，勿重复提交上次操作。'),
          officialCatalogue && accountRows.length > 0 && h('div', { className: 'pet-account-workspace', 'data-account-layout': 'split' },
            h('aside', { className: 'pet-account-rail', 'aria-label': '查看账号', 'data-official-rail': true },
              h('div', { className: 'pet-account-rail-title' }, h('strong', null, '账号'), h('span', { className: 'pet-account-state' }, String(accountRows.length))),
              h('p', { className: 'pet-settings-hint' }, '仅查看，不切号'),
              h('div', { className: 'pet-account-rail-list', onKeyDown: event => {
                const current = accountRows.findIndex(row => row.accountKey === viewedAccount?.accountKey);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? accountRows.length - 1 : event.key === 'ArrowDown' ? (current + 1) % accountRows.length : event.key === 'ArrowUp' ? (current - 1 + accountRows.length) % accountRows.length : -1;
                if (next < 0) return;
                event.preventDefault(); if (viewAccount(accountRows[next])) event.currentTarget.querySelectorAll('[data-official-view]')[next]?.focus();
              } }, ...accountRows.map(row => h('button', { key: row.accountKey, type: 'button', className: 'pet-account-view', 'data-official-view': row.accountKey, 'aria-pressed': viewedAccount?.accountKey === row.accountKey, 'aria-controls': 'pet-account-detail', disabled: officialBusy, onClick: () => viewAccount(row) },
                h('span', { className: 'pet-account-avatar', 'aria-hidden': true }, [...(row.label || '账号')][0]),
                h('span', { className: 'pet-account-view-text' }, h('strong', null, row.label), h('small', null, `#${row.accountKey.slice(0, 8)}${row.bound !== true ? ' · 待核验' : ''}`)),
                row.selected && h('span', { className: 'pet-account-default-badge' }, '默认'))))),
            h('div', { id: 'pet-account-detail', className: 'pet-account-detail', role: 'region', 'aria-label': '当前查看账号详情', 'data-official-viewed': viewedAccount?.accountKey },
          ...accountRows.map(row => {
            const report = accountQuotaPresentation(row.quota, accountNow), pending = officialBusy && (officialAction.current.action === 'quota.read' && officialAction.current.accountKey === row.accountKey || batchResults[row.accountKey]?.status === 'running');
            const target = `${row.label} #${row.accountKey.slice(0, 8)}`;
            return h('div', { key: row.accountKey, hidden: viewedAccount?.accountKey !== row.accountKey, className: `pet-account-row${officialError ? ' is-unverified' : ''}`, 'data-official-account-row': row.accountKey },
              h('div', { className: 'pet-account-info' }, h('strong', null, row.label),
                h('span', { className: 'pet-settings-hint' }, `#${row.accountKey.slice(0, 8)}${row.selected ? ' · 本服务默认' : ''}`),
                h('span', { className: 'pet-settings-hint', 'data-official-credential': row.accountKey }, accountCredentialSummary(row))),
              h('div', { className: 'pet-account-actions' },
                h('button', { type: 'button', disabled: officialBusy || officialError || row.bound !== true || row.selected || officialCatalogue.busy, 'aria-label': `设 ${target} 为本服务默认并更新模型目录`, 'data-official-select': row.accountKey, onClick: () => void officialRequest('account.select', { accountKey: row.accountKey, expectedGeneration: officialCatalogue.generation }) }, row.selected ? '本服务默认' : '设默认并更新目录'),
                h('button', { type: 'button', disabled: officialBusy || officialError || row.bound !== true || officialCatalogue.capabilities?.models !== true, 'aria-label': `${target} 的模型设置`, 'data-official-models-open': row.accountKey, onClick: () => openModels(row.accountKey) }, '模型设置')),
              h('details', { className: 'pet-settings-details pet-account-management', 'data-official-manage': row.accountKey }, h('summary', null, '账号管理'),
                h('div', { className: 'pet-account-actions' },
                h('button', { type: 'button', disabled: officialBusy || officialError || row.bound !== true || !!renameTarget || officialCatalogue.capabilities?.rename !== true, 'aria-label': `更改 ${target} 的本机昵称`, 'data-official-rename': row.accountKey, onClick: () => beginRename(row) }, '改本机昵称'),
                h('button', { type: 'button', disabled: officialBusy || officialError, 'aria-label': `移除 ${target} 的本地绑定`, 'data-official-remove': row.accountKey, onClick: event => beginRemove(row, event) }, '移除'))),
              renameTarget?.accountKey === row.accountKey && h('div', { className: 'pet-account-rename', 'data-official-rename-editor': row.accountKey },
                h('label', { className: 'pet-settings-row' }, h('span', null, '本机昵称 · 停笔自动保存'), h('input', { value: renameTarget.label, maxLength: 128, autoFocus: true, disabled: officialBusy || officialError || ['conflict','unverified'].includes(renameTarget.status), 'data-official-rename-input': row.accountKey, onChange: event => changeRename(event.target.value), onKeyDown: event => { if (event.key === 'Escape' && !officialAction.current.busy) { event.preventDefault?.(); closeRename(); } } })),
                h('p', { role: 'status', className: 'pet-settings-hint', 'data-official-rename-status': row.accountKey }, ({ saved: '仅更改本机昵称；授权、默认账号、模型和预算均不改变。', waiting: '等待自动保存昵称…', saving: '正在保存并回读昵称…', invalid: '昵称需为 1–64 个 Unicode 字符，不含控制字符；尚未保存。', conflict: '目录已变化，草稿保留但停止提交。请关闭编辑、刷新目录，再核对目标。', unverified: '改名结果尚未核验，可能已提交；请先刷新，不要重发。', error: '昵称未保存，草稿保留；没有自动重试。' })[renameTarget.status]),
                renameTarget.status === 'error' && h('button', { type: 'button', 'data-official-rename-retry': row.accountKey, onClick: () => changeRename(renameEditor.current.label) }, '重试自动保存昵称'),
                h('button', { type: 'button', disabled: officialBusy, 'data-official-rename-close': row.accountKey, onClick: closeRename }, '关闭改名')),
              removeTarget?.accountKey === row.accountKey && h('div', { role: 'group', className: 'pet-account-remove-confirm', 'aria-label': `确认移除 ${target}`, 'data-official-remove-prompt': row.accountKey, onKeyDown: event => { if (event.key === 'Escape') { event.preventDefault?.(); cancelRemove(true); } } },
                h('strong', null, `移除 ${removeTarget.label} #${removeTarget.accountKey.slice(0, 8)}${removeTarget.selected ? '（本服务默认）' : ''}？`),
                h('p', null, '仅移除本插件的本地绑定，会中止此账号在本服务的在途请求，并清除其默认选择；不是官方远端退出，不清每日预热账本，不自动选择其它账号。'),
                h('div', { className: 'pet-account-actions' },
                  h('button', { type: 'button', autoFocus: true, 'data-official-remove-cancel': row.accountKey, onClick: () => cancelRemove(true) }, '取消，保留绑定'),
                  h('button', { type: 'button', disabled: officialBusy || officialError, 'data-official-remove-confirm': row.accountKey, onClick: confirmRemove }, '确认移除此绑定'))),
              h('div', { className: `pet-account-row-quota${report.stale ? ' is-stale' : ''}`, 'data-official-quota-report': row.accountKey },
                h('div', { className: 'pet-account-quota-heading' }, h('div', null, h('strong', null, '订阅额度'), h('span', { role: 'status', className: 'pet-account-quota-state' }, pending ? '查询及核验中 · 原读数仅供参考' : report.status)),
                  h('button', { type: 'button', disabled: officialBusy || officialError || row.bound !== true, 'aria-label': `刷新 ${target} 的额度`, 'data-official-quota': row.accountKey, onClick: () => void officialRequest('quota.read', { accountKey: row.accountKey }) }, '刷新额度')),
                h('div', { className: 'pet-account-quota-windows' }, ...report.windows.map(window => {
                  const percent = Number.parseInt(window.value, 10);
                  return h('div', { key: window.label, className: `pet-account-quota-card${Number.isFinite(percent) && percent <= 20 ? ' is-low' : ''}` },
                    h('div', { className: 'pet-account-quota-value' }, h('span', null, window.label), h('strong', null, window.value)),
                    Number.isFinite(percent) && h('div', { className: 'pet-account-quota-bar', role: 'progressbar', 'aria-label': `${target} ${window.label}剩余额度`, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent }, h('span', { style: { width: `${percent}%` } })), h('small', null, window.reset));
                })),
                h('small', null, `${report.received}；不是服务器采样时间`),
                report.restricted && h('span', { className: 'pet-settings-error' }, '服务报告普通用量受限；不会据旧百分比推断可用。')),
              officialRowNotes[row.accountKey] && h('p', { role: 'alert', className: 'pet-settings-error', 'data-official-row-error': row.accountKey }, officialRowNotes[row.accountKey]));
          }),
          officialCatalogue?.capabilities?.models!==true&&officialCatalogue&&h('p',{className:'pet-settings-hint'},'当前账号服务尚未提供模型设置。若仍启用了旧独立账号包，请停用旧包并完整重启，以加载 simple-pet 内置服务。'),
          officialModels?.accountKey === viewedAccount?.accountKey ? modelControls() : viewedAccount && h('div', { className: 'pet-account-model-summary', 'data-official-model-summary': viewedAccount.accountKey },
            h('div', null, h('strong', null, '首选模型'), h('p', { className: 'pet-settings-hint' }, '点击「模型设置」读取当前账号目录。查看账号不会发起查询。')))
          )),
          accountTools(),
          h('details', { className: 'pet-settings-details', 'data-official-default-help': true }, h('summary', null, '查看、默认账号与模型的区别'), h('p', { className: 'pet-settings-hint' }, '左侧只改变当前查看的账号，不查询额度或切号。本服务默认只影响 default: 入口；固定账号模型和已有会话不会自动切换。DSH 默认模型需在模型设置中单独确认。')),
          !officialCatalogue && !officialError && h('p', { className: 'pet-account-empty' }, '点击「刷新」查看账号，或「添加账号」开始授权。'),
          h('p', { role: officialError ? 'alert' : 'status', className: officialError ? 'pet-settings-error' : 'pet-settings-hint', 'data-official-status': true }, officialNote || '刷新与添加账号不会调用模型。'))),
      codex && group('多账号管理（桌宠面板切换）',
        draft?.codexAccountBackend !== 'official' && h('p', { className: 'pet-settings-hint', role: 'status', 'data-account-identity': true }, accountSummary(snapshot, account, account ? monotonicNow() - account.receivedAt : 0)),
        draft && toggle('multiAccountManagement', '开启多账号管理：在桌宠显示账号与一键切换按钮'),
        h('details', { className: 'pet-settings-details' }, h('summary', null, '切换范围与隐私'), h('p', { className: 'pet-settings-hint' }, draft?.codexAccountBackend === 'official' ? '至少两个有效绑定账号才可轮换，点击直接切换，不再二次确认。桌宠显示昵称，按钮仅改变本服务后续新请求的默认账号，不影响进行中的请求。' : '点击直接切换，不再二次确认。旧路径会改变 DSH 共享激活／默认账号，可能影响其他会话；Pool 不保证实际请求身份。需至少两个有效绑定账号。完整邮箱可能显示在桌面，请注意截图隐私，不写入状态或统计文件。')),
        h('p', { className: 'pet-settings-hint' }, draft?.codexAccountBackend === 'official' ? '当前选择独立账号服务：无需旧订阅插件。桌面显示账号昵称；按钮只改变 codex-accounts 后续新请求默认，不改变旧请求或 openai-codex 全局账号。仍需至少两个有效绑定账号。' : '旧路径依赖任选其一：通用订阅 dsh-plugin-subscriptions 0.9.9，或专用订阅 dsh-codex-subscription 2.6.8。旧多账号独立预热仅支持前者的独立模型入口。'),
        draft?.codexAccountBackend !== 'official' && dependencyControls(),
        h('p', { className: 'pet-settings-hint' }, '切号入口已从设置移至桌宠。结果未知不会重试或自动切回，后续切号及自动预热暂停。多账号预热仍需下方另行授权。')),
      codex && group('多账号定时预热（单独授权，默认关闭）',
        h('p', { className: 'pet-settings-hint' }, `${draft?.codexAccountBackend === 'official' ? '当前使用独立官方组件账号服务，不依赖旧订阅插件；账号需已完成 OAuth 授权。' : '旧路径仅支持通用订阅插件 0.9.9 公共独立模型入口；不会代为开启或安装。'} 每账号每天最多一次逻辑请求，最多八个账号；不是 HTTP、Token 或费用硬上限。后端切换不迁移账号授权，同一天已有其他后端认领时保守拒绝新调用。`),
        h('div', { className: 'pet-settings-trigger-support', 'aria-label': '多账号自动预热触发能力' },
          h('p', { className: 'pet-settings-hint' }, '每日定时：已支持，需兼容依赖、独立模型入口及逐账号明确授权。以下两项与单账号开关独立，当前依赖不支持。'),
          h('label', { className: 'pet-settings-toggle' }, h('input', { type: 'checkbox', disabled: true, checked: false, 'data-multi-trigger': 'startup', 'aria-describedby': 'pet-multi-trigger-limit' }), '启动 DSH 时检测各账号 5h 满额并预热（暂不可用）'),
          h('label', { className: 'pet-settings-toggle' }, h('input', { type: 'checkbox', disabled: true, checked: false, 'data-multi-trigger': 'reset', 'aria-describedby': 'pet-multi-trigger-limit' }), '检测各账号 5h 额度刷新为满额时自动预热（暂不可用）'),
          h('p', { id: 'pet-multi-trigger-limit', className: 'pet-settings-hint', 'data-multi-trigger-limit': true }, '旧通用插件可能返回缓存；官方接口也可能缺失服务器采样时间，百分比及分钟窗口有舍入。收到时间、100% 或重置时间变化都不能证明精确的新鲜满额。额外额度授权只适用于每日次数预算，不能开启这两个触发器。')),
        h('button', { type: 'button', disabled: multiBusy, 'data-multi-read': true, onClick: () => void multiRequest(false) }, '读取设置与绑定账号（不预热）'),
        h('button', { type: 'button', disabled: multiBusy || !multiDraft, 'data-multi-discard': true, onClick: () => {
          if (!alive.current || multiAction.current.busy) return;
          multiDraftRef.current = null; multiLoadedRef.current = null; setMultiDraft(null); setMultiLoaded(null); void multiRequest(false);
        } }, '放弃多账号草稿并重新读取'),
        multiDraft && h('div', null,
          h('label', { className: 'pet-settings-toggle' }, h('input', { type: 'checkbox', 'data-multi-enabled': true, checked: multiDraft.enabled, disabled: multiBusy, onChange: e => changeMulti({ enabled: e.target.checked }) }), '开启多账号每日定时预热（暂停原单账号计划，原开关不改写）'),
          h('label', { className: 'pet-settings-row' }, h('span', null, '电脑本地时间 HH:mm'), h('input', { type: 'text', maxLength: 5, value: multiDraft.time, disabled: multiBusy, 'data-multi-time': true, onChange: e => changeMulti({ time: e.target.value }) })),
          ...(boundAccounts || []).map(account => {
            const row = multiDraft.accounts.find(item => item.accountKey === account.accountKey);
            return h('div', { key: account.accountKey, className: 'pet-settings-group' },
              h('label', { className: 'pet-settings-toggle' }, h('input', { type: 'checkbox', disabled: multiBusy, 'data-multi-account': account.accountKey, checked: row?.enabled === true, onChange: e => selectMultiAccount(account, e.target.checked) }), `${account.label || account.maskedEmail || '邮箱未提供'} · #${account.accountKey.slice(0, 8)}：授权每日一次逻辑请求`),
              row && h('label', { className: 'pet-settings-row' }, h('span', null, '固定账号模型'), h('select', { value: row.modelKey, disabled: multiBusy, 'data-multi-model': account.accountKey, onChange: e => changeMulti({ modelKey: e.target.value, allowUnverifiedQuota: false }, account.accountKey) },
                !account.models.some(model => model.modelKey === row.modelKey) && h('option', { value: row.modelKey }, '已保存模型已不可用，不会自动回退'),
                ...account.models.map(model => h('option', { key: model.modelKey, value: model.modelKey }, model.modelName)))),
              row && h('label', { className: 'pet-settings-toggle' }, h('input', { type: 'checkbox', disabled: multiBusy || !row.enabled, checked: row.allowUnverifiedQuota, 'data-multi-unverified': account.accountKey, onChange: e => changeMulti({ allowUnverifiedQuota: e.target.checked }, account.accountKey) }), '额外授权：额度新鲜度无法证明时，仍按上述每日次数预算尝试（可能失败或消耗额度）'));
          }),
          multiDraft.accounts.some(row => !(boundAccounts || []).some(account => account.accountKey === row.accountKey)) && h('p', { className: 'pet-settings-hint' }, '部分已保存账号未在当前目录提供，将被跳过；可放弃草稿后核验，或关闭整个多账号计划。'),
          h('button', { type: 'button', 'data-multi-save': true, disabled: multiBusy || !multiLoaded, onClick: () => void multiRequest(true) }, '确认多账号预热授权（不立即预热）')),
        h('p', { className: 'pet-settings-hint' }, '公共额度即使 force 刷新也可能是旧缓存：不据此推断新鲜额度或重置窗口，未勾额外授权的账号直接跳过。只做每日定时，不做开机补发或按重置补发；失败不自动重试，结果未知或崩溃遗留认领会持久暂停。底层插件可能同账号重试，其他中间件可能影响路由。'),
        h('p', { className: 'pet-settings-hint', role: 'status', 'data-multi-status': true }, (['paused','unknown','failed'].includes(snapshot?.codexMultiWarmup?.status) ? snapshot.codexMultiWarmup.detail : null) || multiNote || snapshot?.codexMultiWarmup?.detail || '多账号预热未授权；打开页面不会发送请求。'),
        (multiLoaded?.paused || ['paused','unknown'].includes(snapshot?.codexMultiWarmup?.status)) && h('p', { role: 'alert', className: 'pet-settings-error' }, '记录含未知结果/未完成认领；设置保存不能清除暂停。请先核验请求与持久记录，不要删除去重记录来重复预热。')),
      !draft ? h('div', null, h('p', null, error ? '设置不可用，未修改原文件。' : '正在读取桌宠设置…'), h('button', { type: 'button', disabled: busy, onClick: reload }, '重新读取')) :
      tab !== 'stats' ? h('form', { noValidate: true, onSubmit: e => { e.preventDefault(); if (alive.current && !reloadAction.current) void autosave.current?.flush(); } },
        group('陪伴与舒适',
          toggle('compactMode', '简洁模式：仅显示余额/额度面板（隐藏人物，关闭全部动效）'),
          draft.compactMode && h('p', { className: 'pet-settings-hint' }, '简洁模式覆盖下方所有视觉动效选项，退出后恢复原偏好；人物选择、信息框主题与预热开关不会被改写。'),
          h('p', { className: 'pet-settings-hint' }, '只改变桌宠视觉表现，不停止额度检测、统计或已开启的自动预热，也不屏蔽原有预热失败安全提醒。修改后自动保存，应用状态以桌宠回执为准。'),
          toggle('quietMode', '安静模式（关闭后自动保存并恢复下方偏好；不补播旧事件）'),
          field('feedbackStyle', '反馈风格', [['classic','经典：保留原有动作'],['gentle','温和：中性姿态与轻量确认']]),
          toggle('reduceMotion', '减少动态（静态角色，同时关闭动态飘字与闪光）'),
          toggle('disableFlashes', '关闭闪光与暴击标记'),
          toggle('disableFloats', '关闭用量飘字'),
          draft.quietMode && h('p', { className: 'pet-settings-hint' }, '安静期间下方偏好被临时覆盖，但不会被清空；仍可编辑，退出安静后自动保存并恢复。'),
          h('p', { className: 'pet-settings-hint', role: 'status', 'data-companion-summary': true }, '当前预览（自动保存，应用以回执为准）：' + companionSummary(draft)),
          h('p', { className: 'pet-settings-hint', role: 'status', 'aria-live': 'polite', 'data-application-status': applicationStatus(loaded?.revision, application, application ? monotonicNow() - application.receivedAt : 0) },
            applicationSummary(loaded?.revision, application, dirty, application ? monotonicNow() - application.receivedAt : 0)),
          h('p', { className: 'pet-settings-hint' }, '应用状态只读核验本机进程、保存版本与短期心跳；无法确认时不会自动保存、启动桌宠或发送模型请求。通过其他 profile 或独立手动启动的桌宠可能无法确认。'),
          h('p', { className: 'pet-settings-hint' }, '温和档复用中性待机帧，不播放受伤、暴击、喂养表情；连续反馈合并，真实用量仍完整统计。下面仅为静态外观示意，不演示动作。')),
        group('形象', h('div', { className: 'pet-settings-gallery', role: 'radiogroup', 'aria-label': '桌宠形象' }, ...skins.map(([id, name]) => h('button', { type: 'button', role: 'radio', key: id, 'aria-checked': draft.skin === id, disabled: busy, onClick: () => change('skin', id) },
          h('span', { className: 'pet-settings-previews', 'aria-hidden': true }, ...(codex ? ['valley'] : ['valley','peak']).map(mode => h('span', { className: 'pet-settings-sprite', key: mode, title: codex ? '形象预览' : mode === 'peak' ? '峰时' : '谷时', style: { backgroundImage: `url(${base}/asset/${id}-${mode}.png)` } }))), h('span', null, name))))),
        group('信息框主题',
          h('p', { className: 'pet-settings-hint' }, '文字信息框与 2D 人物独立选择，可自由搭配。每一版同时包含 DeepSeek 与 Codex 两种样式；卡片内数字为示意，不是实时数据。'),
          h('div', { className: 'pet-settings-theme-gallery', role: 'radiogroup', 'aria-label': '信息框主题' }, ...CARD_THEMES.map(theme => h('button', {
            type: 'button', role: 'radio', key: theme.id, 'aria-checked': (draft.cardTheme || 'default') === theme.id, 'aria-label': `${theme.name}，含 DeepSeek 与 Codex 两种样式`, disabled: busy,
            'data-card-theme-choice': theme.id, onClick: () => change('cardTheme', theme.id),
          }, h('span', { className: 'pet-theme-name' }, theme.name), h('span', { className: 'pet-theme-pair', 'aria-hidden': true }, cardPreview(theme.id, 'deepseek', { compact: true }), cardPreview(theme.id, 'codex', { compact: true })), h('span', { className: 'pet-theme-description' }, theme.description))))),
        group('组合预览',
          h('div', { className: 'pet-combination-caption' }, `${draft.compactMode ? '简洁面板' : skins.find(([id]) => id === draft.skin)?.[1] || skins[0][1]} × ${CARD_THEMES.find(theme => theme.id === (draft.cardTheme || 'default'))?.name || CARD_THEMES[0].name}`),
          !codex && h('div', { className: 'pet-settings-actions', 'aria-label': '组合预览峰谷姿态' }, ...[[false,'谷时预览'],[true,'峰时预览']].map(([peak, label]) => h('button', { type: 'button', key: label, 'aria-pressed': previewPeak === peak, onClick: () => setPreviewPeak(peak) }, label))),
          h('div', { className: `pet-combination-preview${draft.compactMode ? ' pet-combination-compact' : ''}`, 'aria-label': draft.compactMode ? '简洁面板示意（无人物与动效）' : '所选人物与信息框组合示意' },
            !draft.compactMode && h('div', { className: 'pet-combination-stage', 'aria-hidden': true }, h('div', { className: 'pet-combination-sprite', style: { backgroundImage: `url(${base}/asset/${draft.skin}-${!codex && previewPeak ? 'peak' : 'valley'}.png)` } })),
            cardPreview(draft.cardTheme || 'default', codex ? 'codex' : 'deepseek', { peak: !codex && previewPeak })),
          h('p', { className: 'pet-settings-hint' }, '仅预览外观，数字为示意。切换人物不会更改主题；切换主题不会更改人物。修改后自动保存，两种模式自动使用对应样式；是否已应用以桌宠回执为准。')),
        group('显示与休眠',
          field('billingMode', '计费显示模式', [['deepseek','DeepSeek'],['codex','Codex 订阅']]),
          field('size', '桌宠尺寸', [['tiny','超小'],['small','小'],['medium','中'],['large','大']]),
          codex ? field('codexUnit', 'Codex 飘字单位', [['token','Token'],['percent','额度百分比']]) : field('unit', 'DeepSeek 飘字单位', [['cny','人民币'],['token','Token']]),
          number('sleepMinutes','空闲休眠（分钟）',1,240)),
        group('Codex 配额与自动预热',
          h('p', { className: 'pet-settings-hint' }, '以下为原单账号计划：只针对旧后端可证明新鲜额度的当前激活账号。官方账号后端或启用上方多账号计划时本组暂停，原开关保留；不能用本组启动／5h 开关替代多账号授权。'),
          number('codexQuotaRefreshSeconds','额度检测间隔（秒）',1,3600),
          h('p', { className: 'pet-settings-hint' }, '需要已登录且兼容的 Codex 订阅插件与宿主接口。检测间隔为 1–3600 秒，默认 5 秒。以下三个开关独立、默认关闭，切换显示模式或退出桌宠不会停止已开启的后端计划。'),
          toggle('codexWarmupDaily','每天按电脑本地时间自动预热'),
          h('label', { className: 'pet-settings-row' }, h('span', null, '每日预热时间（HH:mm）'), h('input', { type: 'text', inputMode: 'numeric', pattern: '(?:[01][0-9]|2[0-3]):[0-5][0-9]', maxLength: 5, value: draft.codexWarmupTime, disabled: busy, onChange: e => change('codexWarmupTime', e.target.value) })),
          toggle('codexWarmupReset','检测到已知 5h 满额新窗口时预热'), toggle('codexWarmupStartup','启动 DSH 时，5h 额度为 100% 则预热一次'),
          h('p', { className: 'pet-settings-hint' }, '预热会发送真实请求并消耗订阅额度；明确确认授权后才生效，不改变账号或模型选择。电脑本地时区：' + (loaded?.timeZone || warmup?.timezone || '等待后端时区') + '。DSH 停止或电脑休眠时不唤醒、不补执行错过的每日任务。'),
          h('p', { className: 'pet-settings-hint' }, '同一已知窗口只尝试一次；100% 可能是四舍五入，仅依据新鲜 5h 报告。只在确认未发送时有限重试，最多 3 次、间隔 5 秒；发送后结果不明则停止。不保证固定 Token、窗口起点或调用期间账号锁定；底层传输仍可能重试。'),
          h('p', { className: 'pet-settings-hint', role: 'status' }, warmup ? `后端预热状态：${warmup.detail || warmup.status || '等待'}${warmup.lastSuccessAt ? ' · 最近成功：' + new Date(warmup.lastSuccessAt).toLocaleString() : ''}${warmup.nextDailyAt ? ' · 下次每日预热：' + new Date(warmup.nextDailyAt).toLocaleString() : ''}` : '等待后端状态。')),
        h('p', { className: 'pet-settings-hint' }, '普通设置跨页继续自动保存，无需保存按钮。预热授权及账号来源修改须在提示中明确确认；不会自动重试结果未知的预热。')) :
      h('section', { 'aria-label': '桌宠用量统计' },
        h('p', { className: 'pet-settings-hint' }, `当前显示 ${codex ? 'Codex' : 'DeepSeek'} 统计（按已选显示模式）。`),
        h('div', { className: 'pet-settings-cards' }, ...[
          ['今日 Token', ledger ? fmt(day?.tokens ?? 0) : '—'],
          [codex ? '5 小时额度剩余' : '今日人民币消耗', codex ? quota(snapshot?.codex?.fiveHour) : ledger ? fmt(day?.cny ?? 0, true) : '—'],
          [codex ? '周额度剩余' : '今日缓存命中率', codex ? quota(snapshot?.codex?.weekly) : day && (day.inputTokens + day.cacheReadTokens) > 0 ? `${(100 * day.cacheReadTokens / (day.inputTokens + day.cacheReadTokens)).toFixed(1)}%` : '—']
        ].map(([label, value]) => h('div', { key: label }, h('span', null, label), h('strong', null, value)))),
        h('div', { className: 'pet-settings-actions' }, h('label', null, '范围 ', h('select', { value: range, onChange: e => setRange(e.target.value) }, ...[['week','本周'],['month','本月'],['year','今年']].map(([v,t]) => h('option', { key:v, value:v }, t)))),
          h('label', null, '单位 ', h('select', { value: codex ? 'tokens' : chartUnit, disabled: codex, onChange: e => setChartUnit(e.target.value) }, h('option', { value: 'tokens' }, 'Token'), h('option', { value: 'cny' }, '人民币')))),
        h('div', { className: 'pet-settings-chart', role: 'img', 'aria-label': `${range}用量图表，${codex ? 'Token' : chartUnit}` },
          h('div', { className: 'pet-settings-axis' }, ...[1,2/3,1/3,0].map((n,i) => h('span', { key:i }, fmt(max * n, !codex && chartUnit === 'cny')))),
          h('div', { className: 'pet-settings-plot' }, ...buckets.map((b,i) => h('div', { className: 'pet-settings-column', key:i, title:`${b.label}: ${fmt(b.value, !codex && chartUnit === 'cny')}` }, h('div', { className: 'pet-settings-bar-area' }, h('div', { className:'pet-settings-bar', style: { height: `${100 * b.value / max}%` } })), h('span', null, buckets.length <= 12 || i === buckets.length-1 || i % Math.ceil(buckets.length/7) === 0 ? b.label : ''))))),
        codex && h('p', { className: 'pet-settings-hint', role: 'status' }, `${quotaStatus(snapshot)}；5h ${quotaReset(snapshot?.codex?.fiveHour, loaded?.timeZone)}；周 ${quotaReset(snapshot?.codex?.weekly, loaded?.timeZone)}。`),
        h('p', { className: 'pet-settings-hint' }, codex ? '额度由订阅插件报告，不按 Token 折算；图表仅统计 DSH 调用。配额可能过期或暂不可用，非实时保证。' : '人民币为用量估算，未知模型价格不计入；统计从插件启用后开始，升级前历史可能不完整。'),
        ledger?.partialSince && h('p', { className:'pet-settings-hint' }, '历史包含补录的最近事件，更早记录可能缺失。'),
        !ledger && h('p', { className:'pet-settings-hint' }, '等待后端统计；未读取到数据时不假设为零。'))));
  }
  return {
    inject: ['slots', 'remote'],
    apply(ctx) {
      services.pluginManager = ctx.remote?.pluginManager;
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'simple-desktop-pet', order: 75, label: () => '桌宠' }, SimplePetSettings));
    },
    SimplePetSettings,
  };
}
