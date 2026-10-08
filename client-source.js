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

export function quotaReset(window, timeZone) {
  if (!Number.isFinite(window?.resetAt) || window.resetAt <= 0) return '重置时间未知';
  try { return '重置 ' + new Intl.DateTimeFormat('zh-CN', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(window.resetAt)); }
  catch { return '重置时间未知'; }
}

export function createSimplePetClient(React, send = (url, init) => (globalThis.__DSH_TRANSPORT__?.fetch ?? globalThis.fetch)(url, init)) {
  const h = React.createElement;
  const { useState, useEffect, useRef } = React;
  const base = 'api/dsh-plugin-simple-pet';
  const skins = [['default','海蓝鲸鱼娘'],['night','夜航科技娘'],['snow','雪绒鲸娘'],['mint','薄荷茶娘'],['cherry','樱桃汽水娘'],['star','星砂魔法娘']];
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
    const alive = useRef(false), draftRef = useRef(null), editVersion = useRef(0), saving = useRef(false);
    useEffect(() => {
      alive.current = true;
      const controller = new AbortController();
      request('preferences', { signal: controller.signal }).then(data => { if (alive.current) { setLoaded(data); setDraft(data.values); draftRef.current = data.values; } }).catch(e => { if (alive.current && e.name !== 'AbortError') setError(e.message); });
      let pending = false;
      const refresh = async () => {
        if (pending) return;
        pending = true;
        try { const data = await request('state', { signal: controller.signal }); if (alive.current) setSnapshot(data); }
        catch { /* A temporary state failure never writes preferences or requests upstream data. */ }
        finally { pending = false; }
      };
      void refresh();
      const timer = setInterval(refresh, 5000);
      return () => { alive.current = false; controller.abort(); clearInterval(timer); };
    }, []);
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
          setLoaded(data);
          if (editVersion.current === version) { setDraft(data.values); draftRef.current = data.values; }
          setNote(editVersion.current === version ? '已保存。桌宠将在约 1 秒内应用；无需重启。' : '已保存提交的设置，后续编辑仍待保存。');
        }
      } catch (e) { if (alive.current) setError(e.status === 409 ? '设置已被其他页面修改，未覆盖。请重新读取后再编辑；当前草稿已保留。' : e.message); }
      finally { saving.current = false; if (alive.current) setBusy(false); }
    };
    const field = (key, label, options) => h('label', { className: 'pet-settings-row', key }, h('span', null, label),
      h('select', { value: draft[key], disabled: busy, onChange: e => change(key, e.target.value) }, ...options.map(([value, text]) => h('option', { key: value, value }, text))));
    const number = (key, label, min, max) => h('label', { className: 'pet-settings-row', key }, h('span', null, label),
      h('input', { type: 'number', min, max, step: 1, value: draft[key], disabled: busy, onChange: e => change(key, e.target.value === '' ? '' : Number(e.target.value)) }));
    const toggle = (key, label) => h('label', { className: 'pet-settings-toggle', key },
      h('input', { type: 'checkbox', checked: draft[key] === true, disabled: busy, onChange: e => change(key, e.target.checked) }), h('span', null, label));
    const group = (title, ...children) => h('section', { className: 'pet-settings-group' }, h('h3', null, title), ...children);
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
      h('div', { className: 'pet-settings-tabs', role: 'tablist', 'aria-label': '桌宠设置与统计' },
        ...[['settings','设置'],['stats','统计']].map(([id, label]) => h('button', { type: 'button', role: 'tab', key: id, 'aria-selected': tab === id, onClick: () => setTab(id) }, label))),
      error && h('p', { role: 'alert', className: 'pet-settings-error' }, error), note && h('p', { role: 'status', className: 'pet-settings-hint' }, note),
      !draft ? h('div', null, h('p', null, error ? '设置不可用，未修改原文件。' : '正在读取桌宠设置…'), h('button', { type: 'button', disabled: busy, onClick: reload }, '重新读取')) :
      tab === 'settings' ? h('form', { onSubmit: e => { e.preventDefault(); void save(); } },
        group('形象', h('div', { className: 'pet-settings-gallery', role: 'radiogroup', 'aria-label': '桌宠形象' }, ...skins.map(([id, name]) => h('button', { type: 'button', role: 'radio', key: id, 'aria-checked': draft.skin === id, disabled: busy, onClick: () => change('skin', id) },
          h('span', { className: 'pet-settings-previews', 'aria-hidden': true }, ...(codex ? ['valley'] : ['valley','peak']).map(mode => h('span', { className: 'pet-settings-sprite', key: mode, title: codex ? '形象预览' : mode === 'peak' ? '峰时' : '谷时', style: { backgroundImage: `url(${base}/asset/${id}-${mode}.png)` } }))), h('span', null, name))))),
        group('显示与休眠',
          field('billingMode', '计费显示模式', [['deepseek','DeepSeek'],['codex','Codex 订阅']]),
          field('size', '桌宠尺寸', [['tiny','超小'],['small','小'],['medium','中'],['large','大']]),
          codex ? field('codexUnit', 'Codex 飘字单位', [['token','Token'],['percent','额度百分比']]) : field('unit', 'DeepSeek 飘字单位', [['cny','人民币'],['token','Token']]),
          number('sleepMinutes','空闲休眠（分钟）',1,240)),
        group('Codex 配额与自动预热', number('codexQuotaRefreshSeconds','额度检测间隔（秒）',1,3600),
          h('p', { className: 'pet-settings-hint' }, '需要已登录且兼容的 Codex 订阅插件与宿主接口。检测间隔为 1–3600 秒，默认 5 秒。以下三个开关独立、默认关闭，切换显示模式或退出桌宠不会停止已开启的后端计划。'),
          toggle('codexWarmupDaily','每天按电脑本地时间自动预热'),
          h('label', { className: 'pet-settings-row' }, h('span', null, '每日预热时间（HH:mm）'), h('input', { type: 'text', inputMode: 'numeric', pattern: '(?:[01][0-9]|2[0-3]):[0-5][0-9]', maxLength: 5, value: draft.codexWarmupTime, disabled: busy, onChange: e => change('codexWarmupTime', e.target.value) })),
          toggle('codexWarmupReset','检测到已知 5h 满额新窗口时预热'), toggle('codexWarmupStartup','启动 DSH 时，5h 额度为 100% 则预热一次'),
          h('p', { className: 'pet-settings-hint' }, '预热会发送真实请求并消耗订阅额度；保存开启才生效，不改变账号或模型选择。电脑本地时区：' + (loaded?.timeZone || warmup?.timezone || '等待后端时区') + '。DSH 停止或电脑休眠时不唤醒、不补执行错过的每日任务。'),
          h('p', { className: 'pet-settings-hint' }, '同一已知窗口只尝试一次；100% 可能是四舍五入，仅依据新鲜 5h 报告。只在确认未发送时有限重试，最多 3 次、间隔 5 秒；发送后结果不明则停止。不保证固定 Token、窗口起点或调用期间账号锁定；底层传输仍可能重试。'),
          h('p', { className: 'pet-settings-hint', role: 'status' }, warmup ? `后端预热状态：${warmup.detail || warmup.status || '等待'}${warmup.lastSuccessAt ? ' · 最近成功：' + new Date(warmup.lastSuccessAt).toLocaleString() : ''}${warmup.nextDailyAt ? ' · 下次每日预热：' + new Date(warmup.nextDailyAt).toLocaleString() : ''}` : '等待后端状态。')),
        h('div', { className: 'pet-settings-actions' }, h('button', { type: 'submit', disabled: busy || !dirty }, busy ? '保存中…' : '保存设置'), h('button', { type: 'button', disabled: busy, onClick: reload }, '重新读取（放弃草稿）')),
        h('p', { className: 'pet-settings-hint' }, '首次安装本次集成需完整退出并重启 DSH，之后保存即时生效。预热时间与开关会在同一次保存中提交。')) :
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
        !ledger && h('p', { className:'pet-settings-hint' }, '等待后端统计；未读取到数据时不假设为零。')));
  }
  return {
    inject: ['slots'],
    apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'simple-desktop-pet', order: 75, label: () => '桌宠' }, SimplePetSettings));
    },
    SimplePetSettings,
  };
}
