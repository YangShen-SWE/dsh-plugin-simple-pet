import { CARD_THEMES, cardCssVariables } from './card-themes.js';
import { createUnifiedWarmupSettings } from './unified-warmup-client.js';

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
  if (!identity || identity.status !== 'ready' || !q || !['ready', 'reported', 'stale', 'unavailable'].includes(q.status)
    || identity.provider !== q.provider || identity.selection !== q.selection || identity.accountKey !== q.accountKey
    || !(typeof identity.accountKey === 'string' && identity.accountKey.length === 16 && /^[a-f0-9]{16}$/.test(identity.accountKey)) || !Number.isFinite(elapsedMs) || elapsedMs < 0
    || !(identity.validForMs > 0 && identity.validForMs <= 120000 && elapsedMs < identity.validForMs)) return '账号身份待确认；不会根据旧额度猜测邮箱。';
  const source = identity.provider === 'openai-codex' && identity.selection === 'active' ? '当前账号（统一订阅）'
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

export function resetCreditExpiry(value) {
  if (!Number.isFinite(value) || value <= 0 || value > 8640000000000000) return '到期时间未提供';
  return '到期时间：' + new Date(value).toLocaleString('zh-CN', {hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
}

export function accountCredentialSummary(row = {}) {
  return new Map([
    ['available', ''], ['missing', '本地授权缺失 · 请先核验'],
    ['invalid', '本地凭据格式无法验证'], ['identity-mismatch', '凭据身份不一致 · 已暂停使用'],
  ]).get(row.credentialStatus) ?? (row.bound === true ? '' : '本地授权待核验');
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
const EXPLICIT_PREFERENCE_KEYS = Object.freeze(['codexUnifiedControls', 'codexUnifiedWarmup', 'codexWarmupDaily', 'codexWarmupTime', 'codexWarmupReset', 'codexWarmupStartup']);
const PREFERENCE_AUTHORIZATION_LABELS = Object.freeze({ codexUnifiedControls: '统一订阅切号', codexUnifiedWarmup: '统一订阅预热授权', codexWarmupDaily: '每日预热', codexWarmupReset: '5h 窗口预热', codexWarmupStartup: '启动预热', codexWarmupTime: '预热执行时间', codexAccountBackend: '账号来源', multiAccountManagement: '桌宠切号权限' });
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
  const UnifiedWarmupSettings = createUnifiedWarmupSettings(React, { request });
  function SimplePetSettings() {
    const [loaded,setLoaded]=useState(null),[draft,setDraft]=useState(null),[snapshot,setSnapshot]=useState(null),[identity,setIdentity]=useState(null);
    const [error,setError]=useState(''),[tab,setTab]=useState('appearance'),[range,setRange]=useState('week'),[chartUnit,setChartUnit]=useState('tokens');
    const [previewPeak,setPreviewPeak]=useState(false),[application,setApplication]=useState(null),[saveState,setSaveState]=useState({status:'loading'});
    const alive=useRef(false),autosave=useRef(null),readVersion=useRef(0),reloadAction=useRef(null);
    const monotonicNow=()=>globalThis.performance?.now?.()??Date.now();
    useEffect(()=>{
      alive.current=true;
      autosave.current=createPreferenceAutosave({
        write:(patch,revision,signal)=>request('preferences',{method:'PUT',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({patch,revision})}),
        onChange:state=>{if(alive.current){setSaveState(state);setLoaded(state.loaded);setDraft(state.draft);}},
        onSaved:()=>{if(alive.current)setApplication(null);},
      });
      const controller=new AbortController(),version=++readVersion.current;
      request('preferences',{signal:controller.signal}).then(data=>{if(alive.current&&!controller.signal.aborted&&version===readVersion.current)autosave.current.load(data);}).catch(e=>{if(alive.current&&!controller.signal.aborted)setError(e.message);});
      let pending=false;
      const refresh=async()=>{if(pending)return;pending=true;try{
        const [state,receipt,account]=await Promise.allSettled([request('state',{signal:controller.signal}),request('application',{signal:controller.signal}),request('account',{signal:controller.signal})]);
        if(!alive.current||controller.signal.aborted)return;
        if(state.status==='fulfilled')setSnapshot(state.value);
        setIdentity(account.status==='fulfilled'?{...account.value,receivedAt:monotonicNow()}:null);
        setApplication(receipt.status==='fulfilled'?{...receipt.value,receivedAt:monotonicNow()}:null);
      }finally{pending=false;}};
      void refresh();const timer=setInterval(refresh,5000);
      return()=>{alive.current=false;++readVersion.current;controller.abort();reloadAction.current?.abort();autosave.current?.dispose();clearInterval(timer);};
    },[]);
    const busy=!!error||!!saveState.error?.conflict;
    const reload=async()=>{
      if(!alive.current||reloadAction.current||saveState.inFlight)return;
      const controller=new AbortController(),version=++readVersion.current;reloadAction.current=controller;autosave.current?.pause();
      try{const data=await request('preferences',{signal:controller.signal});if(alive.current&&!controller.signal.aborted&&version===readVersion.current){autosave.current.load(data);setError('');}}
      catch(e){if(alive.current&&!controller.signal.aborted)setError(e.message);}
      finally{if(reloadAction.current===controller)reloadAction.current=null;}
    };
    const change=(key,value)=>{if(alive.current&&!reloadAction.current&&(AUTOSAVE_PREFERENCE_KEYS.includes(key)||EXPLICIT_PREFERENCE_KEYS.includes(key)))autosave.current?.edit(key,value);};
    const field=(key,label,options)=>h('label',{className:'pet-settings-row',key},h('span',null,label),h('select',{name:key,value:draft[key]??'',disabled:busy,onChange:e=>change(key,e.target.value)},...options.map(([value,text])=>h('option',{key:value,value},text))));
    const number=(key,label,min,max)=>h('label',{className:'pet-settings-row',key},h('span',null,label),h('input',{name:key,type:'number',min,max,step:1,value:draft[key],disabled:busy,onChange:e=>change(key,e.target.value===''?'':Number(e.target.value))}));
    const toggle=(key,label,description)=>h('label',{className:'pet-settings-toggle pet-settings-switch',key},h('span',{className:'pet-setting-copy'},h('strong',null,label),description&&h('small',null,description)),h('input',{name:key,type:'checkbox',role:'switch','aria-label':label,checked:draft[key]===true,disabled:busy,onChange:e=>change(key,e.target.checked)}));
    const group=(title,...children)=>h('section',{className:'pet-settings-group'},h('h3',null,title),...children);
    const codex=draft?.billingMode==='codex',dirty=!!saveState.safeDirty;
    const fmt=(value,money=false)=>Number.isFinite(value)?(money?'¥'+value.toFixed(2):Math.round(value).toLocaleString('zh-CN')):'—';
    const quota=window=>Number.isFinite(window?.remainingPercent)?`${Math.round(window.remainingPercent)}%`:'—';
    const ledger=codex?snapshot?.codexStats:snapshot?.stats,today=calendarDate(loaded?.timeZone),key=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`,day=ledger?.days?.[key];
    const buckets=statBuckets(ledger?.days,range,codex?'tokens':chartUnit,today),max=Math.max(1,...buckets.map(b=>b.value))*1.18;
    const appearance=draft&&h('form',{noValidate:true,onSubmit:e=>e.preventDefault()},
        h('div', { className: 'pet-settings-page-intro', hidden: tab !== 'appearance', 'data-desktop-intro': true }, h('div', null, h('h3', null, '桌宠设置'), h('p', { className: 'pet-settings-hint' }, '常用偏好直接修改，外观和高级选项按需展开。')), h('span', { className: 'pet-settings-pill' }, '自动保存')),
        group('组合预览',
          h('div', { className: 'pet-combination-caption' }, `${draft.compactMode ? '简洁面板' : skins.find(([id]) => id === draft.skin)?.[1] || skins[0][1]} × ${CARD_THEMES.find(theme => theme.id === (draft.cardTheme || 'default'))?.name || CARD_THEMES[0].name}`),
          !codex && h('div', { className: 'pet-settings-actions', 'aria-label': '组合预览峰谷姿态' }, ...[[false,'谷时预览'],[true,'峰时预览']].map(([peak, label]) => h('button', { type: 'button', key: label, 'aria-pressed': previewPeak === peak, onClick: () => setPreviewPeak(peak) }, label))),
          h('div', { className: `pet-combination-preview${draft.compactMode ? ' pet-combination-compact' : ''}`, 'aria-label': draft.compactMode ? '简洁面板示意（无人物与动效）' : '所选人物与信息框组合示意' },
            !draft.compactMode && h('div', { className: 'pet-combination-stage', 'aria-hidden': true }, h('div', { className: 'pet-combination-sprite', style: { backgroundImage: `url(${base}/asset/${draft.skin}-${!codex && previewPeak ? 'peak' : 'valley'}.png)` } })),
            cardPreview(draft.cardTheme || 'default', codex ? 'codex' : 'deepseek', { peak: !codex && previewPeak })),
          h('p', { className: 'pet-settings-hint' }, '静态外观示意，数字不是实时数据；人物与面板主题可独立搭配。')),
        group('陪伴与舒适',
          toggle('compactMode', '简洁模式', '只保留余额／额度面板，隐藏人物并关闭全部视觉动效。'),
          toggle('quietMode', '安静模式', '减少互动反馈，关闭后恢复原偏好，不补播旧事件。'),
          h('details', { className: 'pet-settings-details pet-settings-advanced', 'data-motion-settings': true }, h('summary', null, '动效与反馈'),
            field('feedbackStyle', '反馈风格', [['classic','经典动作'],['gentle','温和反馈']]),
            toggle('reduceMotion', '减少动态', '保留静态角色，关闭动态飘字和闪光。'), toggle('disableFlashes', '关闭闪光与暴击标记'), toggle('disableFloats', '关闭用量飘字'),
            h('p', { className: 'pet-settings-hint', 'data-companion-summary': true }, companionSummary(draft)),
            h('p', { className: 'pet-settings-hint' }, '简洁／安静模式只覆盖视觉表现，不清空原偏好，不停止额度显示与用量统计。')),
          h('details', { className: 'pet-settings-details pet-settings-advanced', 'data-application-details': true }, h('summary', null, '应用状态与说明'),
            h('p', { className: 'pet-settings-hint', role: 'status', 'aria-live': 'polite', 'data-application-status': applicationStatus(loaded?.revision, application, application ? monotonicNow() - application.receivedAt : 0) }, applicationSummary(loaded?.revision, application, dirty, application ? monotonicNow() - application.receivedAt : 0)),
            h('p', { className: 'pet-settings-hint' }, '保存不等于桌宠已应用：以当前进程、版本和短期心跳回执为准。无法核验时不会自动启动桌宠或请求模型。'))),
        group('显示与休眠',
          field('billingMode', '显示模式', [['deepseek','DeepSeek 余额'],['codex','Codex 订阅额度']]), field('size', '桌宠尺寸', [['tiny','超小'],['small','小'],['medium','中'],['large','大']]),
          codex ? field('codexUnit', '用量飘字', [['token','Token'],['percent','额度百分比']]) : field('unit', '用量飘字', [['cny','人民币'],['token','Token']]), number('sleepMinutes','空闲休眠（分钟）',1,240)),
        codex && group('订阅协作 · 账号与预热',
           h('p', { className: 'pet-settings-hint', 'data-account-identity': true, role: 'status' }, accountSummary(snapshot, identity, identity ? monotonicNow() - identity.receivedAt : 0)),
           h('p', { className: 'pet-settings-hint' }, '登录、增删账号和模型选择仍只在订阅管理。经典桌宠与文字简洁面板共用当前账号；额度查询失败不等于退出登录。'),
           toggle('codexUnifiedControls', '允许桌宠点击切换统一订阅账号', '影响共享激活账号之后的新请求；不会重发或更改进行中的聊天。旧版授权不会自动沿用。'),
           number('codexQuotaRefreshSeconds', '额度显示检查间隔（秒）', 1, 3600),
           h('details', { className: 'pet-settings-details', 'data-warmup-settings': true }, h('summary', null, '自动预热（单当前账号）'),
             toggle('codexUnifiedWarmup', '授权统一订阅自动预热', '会真实消耗当前选中账号的订阅额度。仅发送无聊天历史、无工具的极简请求，不自动轮换账号。'),
             toggle('codexWarmupDaily', '每日定时预热'),
             h('label', { className: 'pet-settings-row' }, h('span', null, '本地执行时间'), h('input', { name: 'codexWarmupTime', type: 'time', value: draft.codexWarmupTime, disabled: busy, onChange: e => change('codexWarmupTime', e.target.value) })),
             toggle('codexWarmupStartup', '启动时满额窗口预热'), toggle('codexWarmupReset', '确认新的满额 5 小时窗口后预热'),
             h('p', { className: 'pet-settings-hint', 'data-warmup-status': true }, snapshot?.codexWarmup?.detail || '等待预热状态；设置保存本身不代表请求已执行。'),
              h('details', { 'data-warmup-error-log': true }, h('summary', null, '预热错误日志（不弹窗）'),
                h('p', { className: 'pet-settings-hint' }, '仅保存最近 20 条安全摘要，不包含账号、令牌或原始错误；结果未知仍暂停，不自动重试。'),
                ...(Array.isArray(snapshot?.codexWarmup?.errorLog) && snapshot.codexWarmup.errorLog.length
                  ? snapshot.codexWarmup.errorLog.map((row, i) => h('p', { key: i, className: 'pet-settings-hint' }, new Date(row.at).toLocaleString() + '  ' + row.detail))
                  : [h('p', { key: 'empty', className: 'pet-settings-hint' }, '暂无已记录的预热错误。')])),
             h('p', { className: 'pet-settings-hint' }, '同一窗口持久去重；休眠错过不补发，结果未知不自动重试。启用下方同源多账号计划后旧单账号路径停止；关闭后不会自动恢复。旧逐账号计划不迁移授权。')),
           saveState.explicitDirty && h('p', { className: 'pet-settings-hint', role: 'status' }, '账号与预热授权尚未保存；外观自动保存不会顺带提交这些更改。'),
           h('button', { type: 'button', 'data-settings-save': true, disabled: busy || saveState.inFlight || !saveState.explicitDirty, onClick: () => void autosave.current?.flush(true) }, '确认保存账号与预热授权')),
         codex && tab === 'appearance' && h(UnifiedWarmupSettings),
          h('details', { className: 'pet-settings-details pet-settings-advanced pet-appearance-library', hidden: tab !== 'appearance', 'data-appearance-library': true }, h('summary', null, '人物与面板主题'),
          group('形象', h('div', { className: 'pet-settings-gallery', role: 'radiogroup', 'aria-label': '桌宠形象' }, ...skins.map(([id, name]) => h('button', { type: 'button', role: 'radio', key: id, 'aria-checked': draft.skin === id, disabled: busy, onClick: () => change('skin', id) },
            h('span', { className: 'pet-settings-previews', 'aria-hidden': true }, ...(codex ? ['valley'] : ['valley','peak']).map(mode => h('span', { className: 'pet-settings-sprite', key: mode, title: codex ? '形象预览' : mode === 'peak' ? '峰时' : '谷时', style: { backgroundImage: `url(${base}/asset/${id}-${mode}.png)` } }))), h('span', null, name))))),
          group('信息框主题', h('p', { className: 'pet-settings-hint' }, '每款主题同时包含 DeepSeek 与 Codex 样式；示意数字不是实时余额。'),
            h('div', { className: 'pet-settings-theme-gallery', role: 'radiogroup', 'aria-label': '信息框主题' }, ...CARD_THEMES.map(theme => h('button', { type: 'button', role: 'radio', key: theme.id, 'aria-checked': (draft.cardTheme || 'default') === theme.id, 'aria-label': `${theme.name}，含 DeepSeek 与 Codex 两种样式`, disabled: busy, 'data-card-theme-choice': theme.id, onClick: () => change('cardTheme', theme.id) }, h('span', { className: 'pet-theme-name' }, theme.name), h('span', { className: 'pet-theme-pair', 'aria-hidden': true }, cardPreview(theme.id, 'deepseek', { compact: true }), cardPreview(theme.id, 'codex', { compact: true })), h('span', { className: 'pet-theme-description' }, theme.description)))))),

    );
    const statistics=h('section',{className:'pet-statistics-page','data-statistics-page':true},
      h('div',{className:'pet-settings-page-intro'},h('div',null,h('h3',null,'用量统计'),h('p',{className:'pet-settings-hint'},'查看本机用量记录，不代表完整账单。'))),
      h('div',{className:'pet-settings-cards'},...[
        ['今日 Token',ledger?fmt(day?.tokens??0):'—'],
        [codex?'5 小时额度剩余':'今日人民币消耗',codex?quota(snapshot?.codex?.fiveHour):ledger?fmt(day?.cny??0,true):'—'],
        [codex?'周额度剩余':'今日缓存命中率',codex?quota(snapshot?.codex?.weekly):day&&(day.inputTokens+day.cacheReadTokens)>0?`${(100*day.cacheReadTokens/(day.inputTokens+day.cacheReadTokens)).toFixed(1)}%`:'—']
      ].map(([label,value])=>h('div',{key:label},h('span',null,label),h('strong',null,value)))),
      h('div',{className:'pet-settings-actions'},h('label',null,'范围 ',h('select',{value:range,'data-stat-range':true,onChange:e=>setRange(e.target.value)},...[['week','本周'],['month','本月'],['year','今年']].map(([value,text])=>h('option',{key:value,value},text)))),h('label',null,'单位 ',h('select',{value:codex?'tokens':chartUnit,disabled:codex,onChange:e=>setChartUnit(e.target.value)},h('option',{value:'tokens'},'Token'),h('option',{value:'cny'},'人民币')))),
      h('div',{className:'pet-settings-chart',role:'img','aria-label':'本机用量图表'},h('div',{className:'pet-settings-axis'},...[1,2/3,1/3,0].map((n,i)=>h('span',{key:i},fmt(max*n,!codex&&chartUnit==='cny')))),h('div',{className:'pet-settings-plot'},...buckets.map((b,i)=>h('div',{className:'pet-settings-column',key:i,title:`${b.label}: ${fmt(b.value,!codex&&chartUnit==='cny')}`},h('div',{className:'pet-settings-bar-area'},h('div',{className:'pet-settings-bar',style:{height:`${100*b.value/max}%`}})),h('span',null,buckets.length<=12||i===buckets.length-1||i%Math.ceil(buckets.length/7)===0?b.label:''))))),
      !ledger&&h('p',{className:'pet-settings-hint'},'等待本机统计数据。'));
    return h('section',{className:'pet-settings pet-settings-workbench','data-pet-only-settings':true},
      h('header',{className:'pet-settings-toolbar'},h('div',{className:'pet-settings-heading'},h('div',{className:'pet-settings-brand'},h('h2',null,'桌宠')),h('div',{className:'pet-settings-savebar'},h('span',{className:'pet-settings-save-state',role:'status','data-autosave-status':saveState.status},saveState.error?'自动保存暂停':saveState.inFlight?'保存中…':saveState.safeDirty?'等待保存…':'设置已保存'),h('button',{type:'button',disabled:!!saveState.inFlight,'data-settings-reload':true,onClick:()=>void reload()},'重新读取'))),
        h('nav',{className:'pet-settings-page-nav',role:'tablist','aria-label':'桌宠设置页面'},...[['appearance','桌宠设置'],['stats','用量统计']].map(([id,label],index)=>h('button',{type:'button',key:id,role:'tab',tabIndex:tab===id?0:-1,'data-pet-tab':id,'aria-selected':tab===id,onClick:()=>setTab(id),onKeyDown:event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?1:1-index;setTab(next?'stats':'appearance');event.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[next]?.focus();}},label)))),
      (error||saveState.error)&&h('p',{role:'alert',className:'pet-settings-error'},error||saveState.error.message),
      saveState.error&&!saveState.error.conflict&&h('button',{type:'button','data-settings-retry':true,onClick:()=>void autosave.current?.retry()},'重试自动保存'),
      !draft?h('p',null,error?'设置暂不可用，原配置未更改。':'正在读取桌宠设置…'):tab==='stats'?statistics:appearance);
  }
  return {
    inject: ['slots', 'remote'],
    apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'simple-desktop-pet', order: 75, label: () => '桌宠' }, SimplePetSettings));
      // Remote namespaces are separately owned Cordis services. The optional
      // installer must not read an undeclared namespace or gate the settings menu.
      ctx.inject(['remote.pluginManager'], managerCtx => {
        const manager = managerCtx.remote.pluginManager;
        services.pluginManager = manager;
        return () => { if (services.pluginManager === manager) services.pluginManager = undefined; };
      });
    },
    SimplePetSettings,
  };
}
