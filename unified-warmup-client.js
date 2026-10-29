// Browser-only, explicit grants. The parent owns authentication and transport.
const KEY = /^[a-f0-9]{16}$/, HASH = /^[a-f0-9]{64}$/;
const isKey = value => typeof value === 'string' && KEY.test(value);
const isHash = value => typeof value === 'string' && HASH.test(value);
const emptyConfig = () => ({ enabled: false, daily: false, time: '09:30', timeZone: 'UTC', accounts: [] });
const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const copyConfig = config => ({ enabled: config.enabled, daily: config.daily, time: config.time, timeZone: config.timeZone,
  accounts: config.accounts.map(row => ({ accountKey: row.accountKey, accountGeneration: row.accountGeneration, modelKey: row.modelKey,
    manual: row.manual, daily: row.daily, allowUnknownQuota: row.allowUnknownQuota })) });
const validRow = row => row && isKey(row.accountKey) && isHash(row.accountGeneration) && isHash(row.modelKey)
  && ['manual', 'daily', 'allowUnknownQuota'].every(key => typeof row[key] === 'boolean');
function validConfig(config) {
  if (!config || typeof config.enabled !== 'boolean' || typeof config.daily !== 'boolean'
    || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config.time) || typeof config.timeZone !== 'string'
    || !config.timeZone || config.timeZone.length > 100 || !Array.isArray(config.accounts) || config.accounts.length > 8
    || !config.accounts.every(validRow) || new Set(config.accounts.map(row => row.accountKey)).size !== config.accounts.length) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: config.timeZone }).format(0); } catch { return false; }
  return !config.enabled || config.accounts.some(row => row.manual || (config.daily && row.daily));
}
function safeName(value, fallback, model = false) {
  return typeof value === 'string' && value.length <= 80 && (model ? /^[\p{L}\p{N} ._()（）#·+/:\-]+$/u : /^[\p{L}\p{N} ._()（）#·+\-]+$/u).test(value)
    && !/(?:https?:|file:|:\/\/|^[A-Za-z]:[\\/])/i.test(value)
    && !/(?:token|bearer|credential|secret|eyJ)[a-z0-9_-]{8,}|[a-f0-9]{32,}/i.test(value) ? value : fallback;
}
const STATUS_TEXT = Object.freeze({
  disabled: '未启用', ready: '已就绪', waiting: '等待未来定时机会', preparing: '准备中', running: '执行中',
  settled: '批次已结束；请逐行查看结果', succeeded: '请求已完成（可能已消耗额度）', skipped: '已跳过，未发模型请求',
  unauthorized: '未授权', not_authorized: '未授权', 'not-authorized': '未授权', restricted: '额度受限，禁止执行',
  unknown_quota: '额度未知已跳过', 'quota-unknown': '额度未知已跳过', claimed: '当日已认领，不再重试',
  unsent: '确认未发送，但当日不重试', unknown: '请求可能已消耗，已持久暂停', paused_unknown: '请求可能已消耗，已持久暂停',
  paused_storage: '存储状态不安全，已暂停', paused_clock: '时钟状态不安全，已暂停', cancelled: '已取消；已发送部分可能消耗额度',
  cancelling: '正在停止本批；已发送部分可能消耗额度', unsupported: '固定账号能力不可用', blocked: '安全准入未通过',
});
const statusCode = value => typeof value === 'string' && Object.hasOwn(STATUS_TEXT, value) ? value : 'unconfirmed';
const statusText = value => STATUS_TEXT[statusCode(value)] || '状态未确认；不会据此宣称成功';
const errorText = error => error?.status === 409 || error?.code === 'REVISION_CONFLICT'
  ? '计划已被其他页面修改，未覆盖；草稿已保留。请读取最新状态，再明确采用最新版本。'
  : error?.status === 401 || error?.status === 403 ? '请求未获授权；未确认执行，请检查宿主授权。'
    : '操作结果未确认，草稿已保留；不会自动重试或显示内部错误。';

export function createUnifiedWarmupSettings(React, { request }) {
  const h = React.createElement, { useEffect, useRef, useState } = React;
  if (typeof request !== 'function') throw new TypeError('Warmup request is required');
  return function UnifiedWarmupSettings() {
    const [, redraw] = useState(0), ref = useRef(null);
    if (!ref.current) ref.current = { alive: false, epoch: 0, draft: emptyConfig(), loaded: null, revision: null,
      latest: null, catalog: [], selected: [], conflict: false, error: '', note: '', confirm: null, op: null, cancel: null,
      paused: false, view: null, capabilities: null, runBlocked: false };
    const s = ref.current;
    const publish = () => { if (s.alive) redraw(n => n + 1); };
    const isDirty = () => !s.loaded || !same(s.draft, s.loaded);
    const dirty = isDirty();
    const capability = name => s.capabilities?.accountBound === true && s.capabilities?.[name] === true;
    const paused = !!s.paused || s.runBlocked;
    const rows = [...s.catalog];
    for (const row of s.draft.accounts) if (!rows.some(account => account.accountKey === row.accountKey)) rows.push({ ...row });
    const label = row => safeName(row.label, `匿名账号 #${row.accountKey.slice(0, 8)}`);
    const models = row => row.models?.verified === true && (typeof row.models.revision === 'string' || Number.isSafeInteger(row.models.revision))
      && Array.isArray(row.models.models) ? row.models.models.filter(model => isHash(model?.modelKey)) : [];
    const lookup = grant => s.catalog.find(row => row.accountKey === grant.accountKey && row.accountGeneration === grant.accountGeneration);
    const usable = grant => { const account = lookup(grant); return account && models(account).some(model => model.modelKey === grant.modelKey); };
    const canRunRow = grant => usable(grant) && grant.manual && lookup(grant).quota?.status !== 'restricted'
      && (lookup(grant).quota?.status === 'ready' || grant.allowUnknownQuota);
    function projectCatalog(accounts) {
      if (!Array.isArray(accounts)) throw new Error('INVALID_CATALOG');
      const seen = new Set();
      return accounts.filter(row => row && isKey(row.accountKey) && isHash(row.accountGeneration)
        && !seen.has(row.accountKey) && seen.add(row.accountKey)).map(row => ({
        accountKey: row.accountKey, accountGeneration: row.accountGeneration, active: row.active === true,
        label: safeName(row.label, `匿名账号 #${row.accountKey.slice(0, 8)}`),
        models: { verified: row.models?.verified === true, revision: row.models?.revision,
          models: Array.isArray(row.models?.models) ? row.models.models.filter(model => isHash(model?.modelKey)).map(model => ({ modelKey: model.modelKey, name: safeName(model.name, '匿名文本模型', true) })) : [] },
        quota: { status: ['ready', 'unknown', 'restricted'].includes(row.quota?.status) ? row.quota.status : 'unknown',
          fetchedAt: Number.isFinite(row.quota?.fetchedAt) ? row.quota.fetchedAt : undefined },
      }));
    }
    function status(data) {
      if (Object.hasOwn(data, 'paused')) { s.paused = !!data.paused; if (s.paused) s.runBlocked = true; }
      if (Object.hasOwn(data, 'view')) {
        s.view = data.view ? { status: statusCode(data.view.status), rows: (Array.isArray(data.view.rows) ? data.view.rows : []).slice(0, 8)
          .map(row => ({ accountKey: isKey(row?.accountKey) ? row.accountKey : null, status: statusCode(row?.status) })) } : null;
        if (['unknown', 'paused_unknown', 'unconfirmed'].includes(s.view?.status)
          || s.view?.rows.some(row => ['unknown', 'paused_unknown', 'unconfirmed'].includes(row.status))) s.runBlocked = true;
      }
      if (data.status === 'unknown' || data.status === 'paused_unknown') s.runBlocked = true;
      if (Object.hasOwn(data, 'capabilities')) s.capabilities = { accountBound: data.capabilities?.accountBound === true,
        manual: data.capabilities?.manual === true, daily: data.capabilities?.daily === true };
    }
    function snapshot(data, submitted) {
      if (!validConfig(data?.config) || !['string', 'number'].includes(typeof data.revision)) throw new Error('INVALID_CONFIG');
      status(data); s.latest = { config: copyConfig(data.config), revision: data.revision };
      if (!s.loaded || submitted) {
        if (!s.loaded || same(s.draft, submitted)) s.draft = copyConfig(data.config);
        s.loaded = copyConfig(data.config); s.revision = data.revision; s.conflict = false;
      } else if (same(s.draft, s.loaded)) {
        s.draft = copyConfig(data.config); s.loaded = copyConfig(data.config); s.revision = data.revision; s.conflict = false;
      } else if (s.revision !== data.revision) s.conflict = true;
    }
    async function operation(kind, body, complete) {
      if (!s.alive || s.op || s.cancel) return;
      const controller = new AbortController(), epoch = s.epoch;
      s.op = { kind, controller }; s.error = ''; s.confirm = null; publish();
      try {
        if (!s.alive || controller.signal.aborted) return;
        const data = await request('unified-warmup', { method: body ? kind === 'save' ? 'PUT' : 'POST' : 'GET',
          signal: controller.signal, cache: 'no-store', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
        if (!s.alive || controller.signal.aborted || epoch !== s.epoch) return;
        if (!data || typeof data !== 'object') throw new Error('INVALID_RESPONSE');
        complete(data);
      } catch (error) {
        if (s.alive && !controller.signal.aborted && epoch === s.epoch) {
          s.error = errorText(error);
          if (error?.status === 409 || error?.code === 'REVISION_CONFLICT') s.conflict = true;
          if (kind === 'run') { s.runBlocked = true; s.note = '执行结果未确认，可能已消耗额度；不会重试，请读取后台持久状态。'; }
        }
      } finally { if (s.op?.controller === controller) s.op = null; if (epoch === s.epoch) publish(); }
    }
    useEffect(() => {
      s.alive = true; ++s.epoch;
      void operation('read', null, data => snapshot(data));
      return () => { s.alive = false; ++s.epoch; s.op?.controller.abort(); s.cancel?.abort(); s.op = null; s.cancel = null; s.confirm = null; };
    }, []);
    function edit(change) {
      if (!s.alive || !s.loaded) return;
      s.draft = change(clone(s.draft)); s.confirm = null; s.note = ''; publish();
    }
    function editRow(key, changes) {
      edit(config => { config.accounts = config.accounts.map(row => row.accountKey === key ? { ...row, ...changes } : row); return config; });
    }
    function choose(row, checked) {
      if (checked && s.draft.accounts.some(grant => grant.accountKey === row.accountKey)) return;
      if (checked && s.draft.accounts.length >= 8) { s.error = '最多授权八个账号；没有自动替换其他账号。'; publish(); return; }
      edit(config => { config.accounts = checked ? [...config.accounts, { accountKey: row.accountKey, accountGeneration: row.accountGeneration,
        modelKey: '', manual: false, daily: false, allowUnknownQuota: false }] : config.accounts.filter(grant => grant.accountKey !== row.accountKey); return config; });
      s.selected = s.selected.filter(key => key !== row.accountKey);
    }
    const refresh = row => {
      if (!s.alive || s.op || s.cancel) return;
      s.confirm = { kind: 'refresh', row: { accountKey: row.accountKey, accountGeneration: row.accountGeneration }, title: `刷新：${label(row)}` }; publish();
    };
    const save = () => {
      if (!s.alive || s.op || s.cancel || !s.loaded || !isDirty() || s.conflict) return;
      const config = clone(s.draft);
      const onlyRevokes = !config.enabled && (!config.daily || s.loaded.daily) && config.accounts.every(grant => {
        const previous = s.loaded.accounts.find(row => row.accountKey === grant.accountKey);
        return previous && previous.accountGeneration === grant.accountGeneration && previous.modelKey === grant.modelKey
          && ['manual', 'daily', 'allowUnknownQuota'].every(key => !grant[key] || previous[key]);
      });
      if (!validConfig(config) || (!onlyRevokes && (config.accounts.some(grant => !usable(grant))
        || (config.enabled && !s.capabilities?.accountBound) || (config.daily && !capability('daily'))
        || config.accounts.some(grant => (grant.manual && !capability('manual')) || (grant.daily && !capability('daily')))))) {
        s.error = '草稿无效或能力未确认：请校验 HH:mm、IANA 时区、逐账号已验证模型及独立授权。'; publish(); return;
      }
      s.confirm = { kind: 'save', config, revision: s.revision }; publish();
    };
    const run = () => {
      if (!s.alive || s.op || s.cancel || isDirty() || s.conflict || s.paused || s.runBlocked || !s.loaded?.enabled || !capability('manual')) return;
      const grants = s.loaded.accounts.filter(row => s.selected.includes(row.accountKey));
      if (!grants.length || grants.some(row => !canRunRow(row))) { s.error = '请选择已保存且逐行允许手动的账号；模型待验证、额度受限或未同意未知额度时不能执行。'; publish(); return; }
      s.confirm = { kind: 'run', revision: s.revision, rows: grants.map(grant => { const row = lookup(grant); return { accountKey: grant.accountKey,
        label: label(row), modelKey: grant.modelKey, model: safeName(models(row).find(model => model.modelKey === grant.modelKey)?.name, '匿名文本模型', true) }; }) }; publish();
    };
    function confirm(expected) {
      if (!s.alive || s.op || s.cancel || !s.confirm || s.confirm !== expected) return;
      const intent = s.confirm; s.confirm = null;
      if (intent.kind === 'rebase') {
        if (s.latest) { s.loaded = clone(s.latest.config); s.revision = s.latest.revision; s.conflict = false; s.error = ''; s.note = '已采用最新版本基线；本地草稿保留，仍需确认保存。'; } publish();
      } else if (intent.kind === 'save') {
        void operation('save', { config: intent.config, revision: intent.revision, confirmed: true }, data => { snapshot(data, intent.config); s.note = '计划已保存；保存未执行模型请求。'; });
      } else if (intent.kind === 'refresh') {
        void operation('refresh', { action: 'refresh', ...intent.row, confirmed: true }, data => {
          const candidates = projectCatalog(data.accounts || (data.account ? [data.account] : []));
          const account = candidates.find(row => row.accountKey === intent.row.accountKey && row.accountGeneration === intent.row.accountGeneration);
          if (!account) throw new Error('INVALID_REFRESH');
          s.catalog = s.catalog.filter(row => row.accountKey !== account.accountKey).concat(account); s.note = '已读取该账号模型/额度结果；未执行模型请求。';
        });
      } else if (intent.kind === 'run') {
        // The immutable confirmation names every final account and model. Server
        // revalidates revision, permissions, quota, budget and account generation.
        void operation('run', { action: 'run', revision: intent.revision, accountKeys: intent.rows.map(row => row.accountKey), confirmed: true }, data => {
          status(data); s.note = statusText(data.view?.status || data.status);
          if (statusCode(data.view?.status || data.status) === 'unconfirmed') s.runBlocked = true;
        });
      }
    }
    async function cancel() {
      if (!s.alive || s.cancel) return;
      const controller = new AbortController(), epoch = s.epoch;
      s.cancel = controller; s.confirm = null; s.runBlocked = true;
      if (s.op?.kind === 'run') { s.op.controller.abort(); s.op = null; }
      s.note = '正在停止本批；已发送部分可能消耗额度，不能承诺撤销。'; publish();
      try {
        if (!s.alive || controller.signal.aborted) return;
        const data = await request('unified-warmup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cancel' }), signal: controller.signal });
        if (!s.alive || controller.signal.aborted || epoch !== s.epoch) return;
        status(data || {}); s.note = '已请求停止本批；已发送部分可能消耗额度，未知结果不会自动恢复。';
      } catch (error) { if (s.alive && !controller.signal.aborted && epoch === s.epoch) s.error = errorText(error); }
      finally { if (s.cancel === controller) s.cancel = null; if (epoch === s.epoch) publish(); }
    }
    const button = (name, text, onClick, disabled = false) => h('button', { type: 'button', 'aria-label': text,
      'data-warmup-action': name, disabled, onClick }, text);
    const toggle = (name, text, checked, onChange, disabled = false) => h('label', { className: 'pet-settings-toggle pet-settings-switch' },
      h('span', { className: 'pet-setting-copy' }, text), h('input', { type: 'checkbox', 'aria-label': text, 'data-warmup-field': name,
        checked, disabled, onChange: event => { if (!disabled && s.alive) onChange(event.target.checked); } }));
    const busy = !!s.op || !!s.cancel, displayedIntent = s.confirm;
    return h('section', { className: 'pet-settings', 'data-unified-warmup': true, 'aria-label': '多账号预热设置' },
      h('section', { className: 'pet-settings-group' }, h('h3', null, '多账号预热（实验性）'),
        h('p', { className: 'pet-settings-hint' }, '默认关闭，不预选当前账号。每账号每日最多一次逻辑请求，手动与每日共享预算；无自动重试、无错过补发，不影响全局当前账号。'),
        h('p', { role: 'status', 'data-warmup-status': paused ? 'paused' : s.op?.kind || (s.loaded ? 'loaded' : 'loading') },
          paused ? '已暂停：请求可能已消耗或安全状态未确认；保存、跨日或重新打开不会清除未知暂停。' : s.capabilities?.accountBound === true ? '固定账号能力已确认；实际执行仍由后台安全准入。' : '固定账号能力未确认，禁止执行。'),
        s.view && h('p', { className: 'pet-settings-hint', 'data-warmup-view': true }, statusText(s.view.status)),
        ...(Array.isArray(s.view?.rows) ? s.view.rows : []).slice(0, 8).map((row, index) => h('p', { key: index, 'data-warmup-result': row.status },
          `${label(s.catalog.find(account => account.accountKey === row.accountKey) || { accountKey: isKey(row.accountKey) ? row.accountKey : '0000000000000000' })}：${statusText(row.status)}`)),
        s.error && h('p', { role: 'alert', className: 'pet-settings-error' }, s.error),
        s.note && h('p', { role: 'status', 'data-warmup-note': true }, s.note),
        h('p', { className: 'pet-settings-hint', 'data-warmup-draft': dirty ? 'dirty' : 'saved' }, dirty ? '本地草稿未保存；与外观自动保存完全独立。' : '计划已保存；保存不会执行。'),
        h('div', { className: 'pet-settings-actions' },
          button('read', '读取最新状态（保留草稿）', () => void operation('read', null, data => snapshot(data)), busy),
          button('discover', '读取本地账号目录', () => void operation('discover', { action: 'discover' }, data => { s.catalog = projectCatalog(data.accounts); s.note = '已读取本地目录；没有自动选择账号或刷新模型/额度。'; }), busy),
          s.conflict && button('rebase', '保留草稿并采用最新版本', () => { if (s.alive && !busy && s.latest) { s.confirm = { kind: 'rebase' }; publish(); } }, busy || !s.latest || s.latest.revision === s.revision))),
      h('section', { className: 'pet-settings-group' }, h('h3', null, '独立授权草稿'),
        toggle('enabled', '启用多账号预热', s.draft.enabled, checked => edit(config => ({ ...config, enabled: checked })), !s.loaded || (!s.draft.enabled && s.capabilities?.accountBound !== true)),
        toggle('daily', '启用每日定时', s.draft.daily, checked => edit(config => ({ ...config, daily: checked })), !s.loaded || (!s.draft.daily && !capability('daily'))),
        h('label', { className: 'pet-settings-row' }, '每日时间（HH:mm）', h('input', { type: 'time', 'aria-label': '每日时间（HH:mm）', 'data-warmup-field': 'time', value: s.draft.time, disabled: !s.loaded, onChange: event => edit(config => ({ ...config, time: event.target.value })) })),
        h('label', { className: 'pet-settings-row' }, '计划时区（IANA）', h('input', { type: 'text', 'aria-label': '计划时区（IANA）', 'data-warmup-field': 'timeZone', value: s.draft.timeZone, disabled: !s.loaded, onChange: event => edit(config => ({ ...config, timeZone: event.target.value })) })),
        h('p', { className: 'pet-settings-hint' }, `明确计划时区：${/^[A-Za-z0-9_+\-/]{1,100}$/.test(s.draft.timeZone) ? s.draft.timeZone : '请填写有效 IANA 时区'}；系统时区改变不自动更改计划。最多八行，无任何自动勾选。`)),
      h('section', { className: 'pet-settings-group', 'aria-label': '逐账号授权' }, h('h3', null, '账号、模型与权限'),
        !rows.length && h('p', { className: 'pet-settings-hint' }, '尚无本地目录。请点击读取本地账号目录；不会自动刷新模型或额度。'),
        ...rows.map(row => {
          const grant = s.draft.accounts.find(item => item.accountKey === row.accountKey), available = models(row), generationMatches = grant?.accountGeneration === row.accountGeneration;
          const eligible = grant && canRunRow(grant), quota = row.quota?.status || 'unknown';
          return h('section', { key: row.accountKey, className: 'pet-settings-group', 'data-warmup-account': row.accountKey },
            h('h4', null, label(row), row.active ? ' · 普通当前账号（仅展示，不自动选择）' : ''),
            toggle(`include:${row.accountKey}`, `授权 ${label(row)}`, !!grant, checked => choose(row, checked), !s.loaded || (!grant && s.draft.accounts.length >= 8)),
            h('p', { className: 'pet-settings-hint', 'data-warmup-quota': quota }, quota === 'ready' ? '额度准入已就绪（后台仍会复核）' : quota === 'restricted' ? '额度受限：禁止执行，未知额度同意不可绕过。' : '额度未知：默认跳过；附加同意不绕过明确限制。'),
            (!available.length || (grant && !generationMatches)) && h('p', { className: 'pet-settings-hint' }, '目标模型目录未验证、缺模型或账号代次已改变；须用户点击刷新并重新选择，不自动回退。'),
            button(`refresh:${row.accountKey}`, `刷新 ${label(row)} 的模型/额度`, () => refresh(row), busy),
            grant && h('label', { className: 'pet-settings-row' }, '固定模型', h('select', { 'aria-label': `${label(row)} 固定模型`, 'data-warmup-field': `model:${row.accountKey}`,
              value: generationMatches ? grant.modelKey : '', disabled: !available.length, onChange: event => {
                const modelKey = event.target.value; if (!available.some(model => model.modelKey === modelKey)) return;
                editRow(row.accountKey, { modelKey, accountGeneration: row.accountGeneration, manual: false, daily: false, allowUnknownQuota: false });
              } }, h('option', { value: '' }, '请选择已验证的模型'),
              grant.modelKey && generationMatches && !available.some(model => model.modelKey === grant.modelKey) && h('option', { value: grant.modelKey }, '已保存模型（待验证）'),
              ...available.map(model => h('option', { key: model.modelKey, value: model.modelKey }, safeName(model.name, '匿名文本模型', true))))),
            grant && toggle(`manual:${row.accountKey}`, `${label(row)} 允许手动执行`, grant.manual, checked => editRow(row.accountKey, { manual: checked }), !capability('manual') || !usable(grant)),
            grant && toggle(`daily:${row.accountKey}`, `${label(row)} 允许每日执行`, grant.daily, checked => editRow(row.accountKey, { daily: checked }), !capability('daily') || !usable(grant)),
            grant && toggle(`unknown:${row.accountKey}`, `${label(row)} 额度未知时仍允许在每日一次预算内尝试`, grant.allowUnknownQuota, checked => editRow(row.accountKey, { allowUnknownQuota: checked })),
            grant && h('p', { className: 'pet-settings-hint', 'data-warmup-authorization': grant.manual ? 'manual' : 'unauthorized' }, grant.manual ? '已授予手动权限（仅保存后生效）' : '未授权手动：每日权限不能代替手动权限。'),
            grant && toggle(`run:${row.accountKey}`, `本批执行 ${label(row)}`, s.selected.includes(row.accountKey), checked => {
              if (!s.alive || busy) return; s.selected = checked ? [...new Set([...s.selected, row.accountKey])] : s.selected.filter(key => key !== row.accountKey); s.confirm = null; publish();
            }, !eligible || dirty || busy || paused));
        })),
      h('div', { className: 'pet-settings-actions' }, button('save', '检查并确认保存计划', save, busy || !s.loaded || !dirty || s.conflict),
        button('run', '检查并确认执行所选账号', run, busy || dirty || s.conflict || paused || !s.loaded?.enabled || !capability('manual') || !s.selected.length),
        button('cancel', '停止本批', () => void cancel(), !!s.cancel)),
      s.confirm && h('section', { className: 'pet-settings-group', role: 'dialog', 'aria-modal': true, 'aria-label': '预热操作最终确认', 'data-warmup-confirm': s.confirm.kind },
        h('h3', null, s.confirm.title || (s.confirm.kind === 'run' ? '最终账号与模型确认' : s.confirm.kind === 'save' ? '保存授权确认（不执行）' : '采用最新基线确认')),
        h('p', { className: 'pet-settings-hint' }, s.confirm.kind === 'refresh' ? '此操作可能联网查询模型/额度并刷新 OAuth 登录授权，但不发送模型请求。'
          : s.confirm.kind === 'rebase' ? '保留本地全部草稿，采用已读取最新版本作为保存基线；之后仍须单独确认保存，不会执行。'
            : '可能真实消耗订阅额度；默认不开启，无自动重试。每账号每日最多一次逻辑请求，手动与每日共享预算。未知结果持久暂停，不影响全局当前账号。保存只保存，不执行。'),
        s.confirm.kind === 'run' && h('div', { 'data-warmup-final-rows': true }, ...s.confirm.rows.map(row => h('p', { key: row.accountKey, 'data-warmup-final-account': row.accountKey }, `${row.label} → ${row.model}（匿名账号标识 ${row.accountKey}；模型标识 ${row.modelKey}）`))),
        s.confirm.kind === 'run' && h('p', null, '确认执行上述所有最终账号和模型，可能消耗额度；未授权、当日已认领或受限账号由后台拒绝，取消不能撤回已发送消耗。'),
        button('confirm', s.confirm.kind === 'run' ? '确认可能消费额度并执行' : '确认此操作', () => confirm(displayedIntent), busy),
        button('dismiss', '返回草稿，不执行', () => { if (s.alive) { s.confirm = null; publish(); } }, busy)));
  };
}
