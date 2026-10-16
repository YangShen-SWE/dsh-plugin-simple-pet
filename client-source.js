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

export function companionSummary(prefs = {}) {
  if (prefs.compactMode === true) return '简洁模式：仅显示余额/额度面板，隐藏人物，全部视觉动效关闭；闪光/暴击关闭；用量飘字关闭。余额、额度与统计继续更新。';
  const quiet = prefs.quietMode === true, reduced = prefs.reduceMotion === true, gentle = prefs.feedbackStyle === 'gentle';
  const motion = quiet ? '安静模式：角色静止；保持到关闭并保存' : reduced ? '减少动态：保留静态待机/睡姿，不播放动态反馈' : gentle ? '温和反馈：中性姿态、轻量确认，连续事件合并展示' : '经典反馈：保留原有角色动作';
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
    if (!res.ok) { const e = new Error(data.error || `请求失败（${res.status}）`); e.status = res.status; throw e; }
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
    const officialAction = useRef({ busy: false, controller: null });
    const [multiLoaded, setMultiLoaded] = useState(null), [multiDraft, setMultiDraft] = useState(null), [boundAccounts, setBoundAccounts] = useState(null);
    const [multiBusy, setMultiBusy] = useState(false), [multiNote, setMultiNote] = useState('');
    const multiAction = useRef({ busy: false, controller: null }), multiDraftRef = useRef(null), multiLoadedRef = useRef(null);
    const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now();
    const alive = useRef(false), draftRef = useRef(null), editVersion = useRef(0), saving = useRef(false);
    useEffect(() => {
      alive.current = true;
      const controller = new AbortController();
      request('preferences', { signal: controller.signal }).then(data => { if (alive.current) { setLoaded(data); setDraft(data.values); draftRef.current = data.values; } }).catch(e => { if (alive.current && e.name !== 'AbortError') setError(e.message); });
      let pending = false;
      const refresh = async () => {
        // Re-evaluate the short lease even when a previous local request is stalled.
        if (alive.current) { setApplication(previous => previous ? { ...previous } : null); setAccount(previous => previous ? { ...previous } : null); }
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
      return () => { alive.current = false; officialAction.current.controller?.abort(); multiAction.current.controller?.abort(); controller.abort(); clearInterval(timer); };
    }, []);
    const officialRequest = async (action = null, payload = {}) => {
      if (!alive.current || officialAction.current.busy || loaded?.values?.codexAccountBackend !== 'official' || draftRef.current?.codexAccountBackend !== 'official') return;
      const controller = new AbortController(); officialAction.current = { busy: true, controller }; setOfficialBusy(true); setOfficialNote('');
      try {
        if (action) await request('official-accounts', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...payload }) });
        const data = await request('official-accounts', { signal: controller.signal });
        if (!alive.current) return;
        setOfficialCatalogue(data); setOfficialReply(''); setOfficialNote(action ? '操作已提交，请核对下方状态；未发送模型请求。' : '账号目录已读取；额度需逐项刷新。');
      } catch { if (alive.current) setOfficialNote('官方账号服务未就绪或操作未确认；请核对独立插件已安装启用及官方授权页面。不会回退旧账号或自动重试。'); }
      finally { officialAction.current.busy = false; if (alive.current) setOfficialBusy(false); }
    };
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
    const change = (key, value) => {
      editVersion.current++;
      const next = { ...draftRef.current, [key]: value };
      draftRef.current = next; setDraft(next); setNote('');
    };
    const reload = async () => {
      if (saving.current) return;
      saving.current = true; setBusy(true); setError('');
      const version = editVersion.current;
      try {
        const data = await request('preferences');
        if (alive.current) {
          setLoaded(data);
          if (editVersion.current === version) { draftRef.current = data.values; setDraft(data.values); setNote('已读取当前已保存设置。'); }
          else setNote('已刷新保存版本，保留当前编辑内容。');
        }
      } catch (e) { if (alive.current) setError(e.message); }
      finally { saving.current = false; if (alive.current) setBusy(false); }
    };
    const save = async () => {
      if (!loaded || saving.current) return;
      saving.current = true; setBusy(true); setError(''); setNote('');
      const version = editVersion.current;
      const patch = Object.fromEntries(Object.entries(draftRef.current).filter(([key, val]) => loaded.values[key] !== val));
      try {
        if (!Object.keys(patch).length) { setNote('没有待保存的更改。'); return; }
        const data = await request('preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch, revision: loaded.revision }) });
        if (alive.current) {
          setLoaded(data); setApplication(null);
          if (editVersion.current === version) { setDraft(data.values); draftRef.current = data.values; }
          setNote(editVersion.current === version ? '已保存；等待独立的桌宠应用回执。首次更新代码需完整退出并重启 DSH。' : '已保存提交的设置，后续编辑仍待保存。');
        }
      } catch (e) { if (alive.current) setError(e.status === 409 ? '设置已被其他页面修改，未覆盖。请重新读取后再编辑；当前草稿已保留。' : e.message); }
      finally { saving.current = false; if (alive.current) setBusy(false); }
    };
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
    const groupPages = { '官方订阅账号（独立插件）': 'accounts', '显示与休眠': 'settings', '陪伴与舒适': 'appearance', '形象': 'appearance', '信息框主题': 'appearance', '组合预览': 'appearance', '多账号管理（桌宠面板切换）': 'accounts', '多账号定时预热（独立保存，默认关闭）': 'warmup', 'Codex 配额与自动预热': 'warmup' };
    const group = (title, ...children) => {
      const page = groupPages[title] || 'appearance';
      return h('section', { className: 'pet-settings-group', hidden: tab !== page, 'data-pet-page': page, 'aria-label': title }, h('h3', null, title), ...children);
    };
    const codex = draft?.billingMode === 'codex';
    const today = calendarDate(loaded?.timeZone), key = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    const ledger = codex ? snapshot?.codexStats : snapshot?.stats;
    const day = ledger?.days?.[key];
    const fmt = (v, money = false) => typeof v === 'number' && Number.isFinite(v) ? (money ? `¥${v.toLocaleString('zh-CN', { maximumFractionDigits: v < 1 ? 8 : 2 })}` : v.toLocaleString('zh-CN', { maximumFractionDigits: 0 })) : '—';
    const quota = q => Number.isFinite(q?.remainingPercent) && q.remainingPercent >= 0 && q.remainingPercent <= 100 ? `${q.remainingPercent.toFixed(1)}%` : '—';
    const warmup = snapshot?.codexWarmup;
    const buckets = statBuckets(ledger?.days, range, codex ? 'tokens' : chartUnit, today);
    const max = Math.max(1, ...buckets.map(b => b.value)) * 1.18;
    const dirty = loaded && draft && Object.keys(draft).some(k => draft[k] !== loaded.values[k]);
    return h('div', { className: 'pet-settings', 'data-pet-settings': true },
      h('h2', null, '桌宠'), h('p', { className: 'pet-settings-hint' }, '设置与统计已集成到 DSH，沿用原来的偏好和历史。更改后点击保存，不会因打开此页发送模型请求。'),
      h('div', { className: 'pet-settings-tabs pet-settings-page-nav', role: 'tablist', 'aria-label': '桌宠子页面', onKeyDown: event => {
        const index = pages.findIndex(([id]) => id === tab);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? pages.length - 1 : event.key === 'ArrowRight' ? (index + 1) % pages.length : event.key === 'ArrowLeft' ? (index + pages.length - 1) % pages.length : -1;
        if (next < 0) return;
        event.preventDefault(); setTab(pages[next][0]); event.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus();
      } }, ...pages.map(([id, label]) => h('button', { type: 'button', role: 'tab', key: id, id: `pet-tab-${id}`, 'data-pet-tab': id, 'aria-controls': 'pet-settings-page-content', tabIndex: tab === id ? 0 : -1, 'aria-selected': tab === id, onClick: () => setTab(id) }, label))),
      h('p', { className: 'pet-settings-hint', 'data-page-save-hint': true }, '跨页切换保留草稿，不自动保存或发送预热。常规、外观和账号开关统一保存；多账号预热授权独立保存。'),
      h('div', { id: 'pet-settings-page-content', role: 'tabpanel', 'aria-labelledby': `pet-tab-${tab}` },
      tab === 'accounts' && !codex && h('p', { className: 'pet-settings-hint' }, '请先在「常规」将计费显示模式切换为 Codex，再配置多账号管理。'),
      error && h('p', { role: 'alert', className: 'pet-settings-error' }, error), note && h('p', { role: 'status', className: 'pet-settings-hint' }, note),
      codex && group('官方订阅账号（独立插件）',
        field('codexAccountBackend', '账号后端（保存后生效，不迁移授权）', [['legacy','保留原第三方订阅路径'],['official','本项目官方组件账号服务']]),
        h('p', { className: 'pet-settings-hint' }, '新账号服务是本项目独立插件，不是 DSH 官方出品；复用官方 Codex ChatGPT 订阅 OAuth 和适配器，不是 Platform API Key。先安装并启用同一 Release 附带的 dsh-plugin-codex-accounts.tgz，然后选择此后端并保存。不会读取旧插件授权，也不改 DSH 的 openai-codex 全局槽。'),
        draft?.codexAccountBackend === 'official' && h('div', null,
          h('p', { className: 'pet-settings-hint' }, '默认账号仅作用于 codex-accounts 路由的后续新请求；已创建的请求保持原账号。旧单账号预热在此后端暂停，逐账号每日计划需在自动预热页重新读取与明确授权。'),
          h('button', { type: 'button', 'data-official-read': true, disabled: officialBusy || loaded?.values?.codexAccountBackend !== 'official', onClick: () => void officialRequest() }, '读取账号 / 登录进度（不调用模型）'),
          h('label', { className: 'pet-settings-row' }, h('span', null, '新账号昵称（不必填写邮箱）'), h('input', { value: officialLabel, maxLength: 64, 'data-official-label': true, onChange: e => setOfficialLabel(e.target.value) })),
          h('button', { type: 'button', 'data-official-login': true, disabled: officialBusy || loaded?.values?.codexAccountBackend !== 'official' || ['running','prompt'].includes(officialCatalogue?.login?.status), onClick: () => void officialRequest('login.start', { label: officialLabel }) }, '添加 ChatGPT 订阅账号（官方 OAuth）'),
          officialCatalogue?.login && h('div', { role: 'status' },
            h('p', null, `登录状态：${officialCatalogue.login.status}。完成官方页面后，点击上方读取进度。`),
            officialCatalogue.login.event?.url && h('a', { href: officialCatalogue.login.event.url, target: '_blank', rel: 'noopener noreferrer' }, '打开官方授权页面'),
            officialCatalogue.login.event?.userCode && h('p', null, `官方设备验证码：${officialCatalogue.login.event.userCode}`),
            officialCatalogue.login.prompt && h('div', null,
              h('p', null, officialCatalogue.login.prompt.message),
              officialCatalogue.login.prompt.choices ? h('select', { value: officialReply, onChange: e => setOfficialReply(e.target.value) }, h('option', { value: '' }, '选择授权方式'), ...officialCatalogue.login.prompt.choices.map(value => h('option', { key: value, value }, value)))
                : h('input', { type: 'text', autoComplete: 'off', value: officialReply, maxLength: 4096, onChange: e => setOfficialReply(e.target.value), 'aria-label': '官方回调 URL（仅回调失败时）' }),
              h('button', { type: 'button', disabled: officialBusy || !officialReply, onClick: () => void officialRequest('login.respond', { id: officialCatalogue.login.id, promptId: officialCatalogue.login.prompt.id, value: officialReply }) }, '交给官方授权流程')),
            ['running','prompt'].includes(officialCatalogue.login.status) && h('button', { type: 'button', disabled: officialBusy, onClick: () => void officialRequest('login.cancel', { id: officialCatalogue.login.id }) }, '取消此次登录')),
          ...(officialCatalogue?.accounts || []).map(row => h('div', { key: row.accountKey, className: 'pet-settings-group' },
            h('strong', null, `${row.label} · #${row.accountKey.slice(0, 8)}${row.selected ? ' · 新请求默认账号' : ''}${row.bound !== true ? ' · 凭据不可用，请撤销后重新绑定' : ''}`),
            h('p', null, `额度：${row.quota?.status || 'unavailable'}；5h ${Number.isFinite(row.quota?.fiveHour?.remainingPercent) ? row.quota.fiveHour.remainingPercent + '%' : '未知'}；周 ${Number.isFinite(row.quota?.weekly?.remainingPercent) ? row.quota.weekly.remainingPercent + '%' : '未知'}。属于服务器报告，不保证精确满额。`),
            h('button', { type: 'button', disabled: officialBusy, 'data-official-quota': row.accountKey, onClick: () => void officialRequest('quota.read', { accountKey: row.accountKey }) }, '刷新此账号额度（不调用模型）'),
            h('button', { type: 'button', disabled: officialBusy || row.bound !== true || row.selected || officialCatalogue.busy, 'data-official-select': row.accountKey, onClick: () => void officialRequest('account.select', { accountKey: row.accountKey, expectedGeneration: officialCatalogue.generation }) }, '设为本服务新请求默认'),
            h('button', { type: 'button', disabled: officialBusy, 'data-official-remove': row.accountKey, onClick: () => void officialRequest('account.remove', { accountKey: row.accountKey }) }, '撤销本地绑定并取消在途请求'))),
          h('p', { role: 'status', 'data-official-status': true }, officialNote || '先保存后端选择，再显式读取或添加账号；不会自动登录。'))),
      codex && group('多账号管理（桌宠面板切换）',
        h('p', { className: 'pet-settings-hint', role: 'status', 'data-account-identity': true }, accountSummary(snapshot, account, account ? monotonicNow() - account.receivedAt : 0)),
        draft && toggle('multiAccountManagement', '开启多账号管理：在桌宠信息框显示邮箱与一键切号按钮'),
        h('p', { className: 'pet-settings-hint' }, '保存开启后，Codex 信息框新增邮箱与切换按钮。点击直接轮换至下一已绑定账号，不再二次确认；影响 DSH 共享激活／默认账号及其他会话，Pool 不保证实际请求身份。至少两个有效绑定账号、支持版本及空闲状态才可切换。完整邮箱会显示在桌面（过长可悬停查看），注意截图和共享屏幕隐私；不写入状态或统计文件。'),
        h('p', { className: 'pet-settings-hint' }, draft?.codexAccountBackend === 'official' ? '当前选择独立账号服务：无需旧订阅插件。桌面显示账号昵称；按钮只改变 codex-accounts 后续新请求默认，不改变旧请求或 openai-codex 全局账号。仍需至少两个有效绑定账号。' : '旧路径依赖任选其一：通用订阅 dsh-plugin-subscriptions 0.9.9，或专用订阅 dsh-codex-subscription 2.6.8。旧多账号独立预热仅支持前者的独立模型入口。'),
        draft?.codexAccountBackend !== 'official' && dependencyControls(),
        h('p', { className: 'pet-settings-hint' }, '切号入口已从设置移至桌宠。结果未知不会重试或自动切回，后续切号及自动预热暂停。多账号预热仍需下方另行授权。')),
      codex && group('多账号定时预热（独立保存，默认关闭）',
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
          h('button', { type: 'button', 'data-multi-save': true, disabled: multiBusy || !multiLoaded, onClick: () => void multiRequest(true) }, '单独保存多账号授权（不立即预热）')),
        h('p', { className: 'pet-settings-hint' }, '公共额度即使 force 刷新也可能是旧缓存：不据此推断新鲜额度或重置窗口，未勾额外授权的账号直接跳过。只做每日定时，不做开机补发或按重置补发；失败不自动重试，结果未知或崩溃遗留认领会持久暂停。底层插件可能同账号重试，其他中间件可能影响路由。'),
        h('p', { className: 'pet-settings-hint', role: 'status', 'data-multi-status': true }, (['paused','unknown','failed'].includes(snapshot?.codexMultiWarmup?.status) ? snapshot.codexMultiWarmup.detail : null) || multiNote || snapshot?.codexMultiWarmup?.detail || '多账号预热未授权；打开页面不会发送请求。'),
        (multiLoaded?.paused || ['paused','unknown'].includes(snapshot?.codexMultiWarmup?.status)) && h('p', { role: 'alert', className: 'pet-settings-error' }, '记录含未知结果/未完成认领；设置保存不能清除暂停。请先核验请求与持久记录，不要删除去重记录来重复预热。')),
      !draft ? h('div', null, h('p', null, error ? '设置不可用，未修改原文件。' : '正在读取桌宠设置…'), h('button', { type: 'button', disabled: busy, onClick: reload }, '重新读取')) :
      tab !== 'stats' ? h('form', { noValidate: true, onSubmit: e => { e.preventDefault(); void save(); } },
        group('陪伴与舒适',
          toggle('compactMode', '简洁模式：仅显示余额/额度面板（隐藏人物，关闭全部动效）'),
          draft.compactMode && h('p', { className: 'pet-settings-hint' }, '简洁模式覆盖下方所有视觉动效选项，退出后恢复原偏好；人物选择、信息框主题与预热开关不会被改写。'),
          h('p', { className: 'pet-settings-hint' }, '只改变桌宠视觉表现，不停止额度检测、统计或已开启的自动预热，也不屏蔽原有预热失败安全提醒。更改是草稿，保存后才应用。'),
          toggle('quietMode', '安静模式（关闭后保存，恢复下方偏好；不补播旧事件）'),
          field('feedbackStyle', '反馈风格', [['classic','经典：保留原有动作'],['gentle','温和：中性姿态与轻量确认']]),
          toggle('reduceMotion', '减少动态（静态角色，同时关闭动态飘字与闪光）'),
          toggle('disableFlashes', '关闭闪光与暴击标记'),
          toggle('disableFloats', '关闭用量飘字'),
          draft.quietMode && h('p', { className: 'pet-settings-hint' }, '安静期间下方偏好被临时覆盖，但不会被清空；仍可编辑，退出安静并保存后恢复。'),
          h('p', { className: 'pet-settings-hint', role: 'status', 'data-companion-summary': true }, '草稿表现（保存后应用）：' + companionSummary(draft)),
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
          h('p', { className: 'pet-settings-hint' }, '仅预览外观，数字为示意。切换人物不会更改主题；切换主题不会更改人物。点击保存后桌宠应用，两种模式自动使用对应样式。')),
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
          h('p', { className: 'pet-settings-hint' }, '预热会发送真实请求并消耗订阅额度；保存开启才生效，不改变账号或模型选择。电脑本地时区：' + (loaded?.timeZone || warmup?.timezone || '等待后端时区') + '。DSH 停止或电脑休眠时不唤醒、不补执行错过的每日任务。'),
          h('p', { className: 'pet-settings-hint' }, '同一已知窗口只尝试一次；100% 可能是四舍五入，仅依据新鲜 5h 报告。只在确认未发送时有限重试，最多 3 次、间隔 5 秒；发送后结果不明则停止。不保证固定 Token、窗口起点或调用期间账号锁定；底层传输仍可能重试。'),
          h('p', { className: 'pet-settings-hint', role: 'status' }, warmup ? `后端预热状态：${warmup.detail || warmup.status || '等待'}${warmup.lastSuccessAt ? ' · 最近成功：' + new Date(warmup.lastSuccessAt).toLocaleString() : ''}${warmup.nextDailyAt ? ' · 下次每日预热：' + new Date(warmup.nextDailyAt).toLocaleString() : ''}` : '等待后端状态。')),
        h('div', { className: 'pet-settings-actions pet-settings-savebar' }, h('button', { type: 'submit', disabled: busy || !dirty }, busy ? '保存中…' : '保存设置'), h('button', { type: 'button', disabled: busy, onClick: reload }, '重新读取（放弃草稿）')),
        h('p', { className: 'pet-settings-hint' }, '此处保存通用偏好及原单账号计划；多账号预热授权需在其分区单独保存。跨页草稿保持，后台严格校验输入。首次更新代码需完整退出并重启 DSH，之后保存等待应用回执。')) :
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
