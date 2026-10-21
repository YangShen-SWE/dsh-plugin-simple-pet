// Browser-only ownership gate. The complete upstream client activates only when
// the backend confirms the embedded owner; an external provider is not an RPC alias.
export async function activateEmbeddedSubscriptionClient(ctx, plugin, {
  fetchOwner = (...args) => fetch(...args),
  React,
  wait = (ms, signal) => new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(new Error('CLOSED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  }),
} = {}) {
  const lifetime = new AbortController();
  ctx.effect(() => () => lifetime.abort(), 'simple-pet: subscription client ownership');
  let owner = 'unavailable';
  try {
    for (let attempt = 0; attempt < 60 && !lifetime.signal.aborted; attempt++) {
      const response = await fetchOwner('/api/dsh-plugin-simple-pet/subscription-owner', {
        method: 'GET', credentials: 'same-origin', cache: 'no-store',
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok) break;
      const text = await response.text();
      if (text.length > 1024 || lifetime.signal.aborted) break;
      const value = JSON.parse(text);
      owner = value.version === '2.6.8' && ['loading','embedded','external','failed','closed'].includes(value.owner) ? value.owner : 'unavailable';
      if (owner !== 'loading') break;
      await wait(1000, lifetime.signal);
    }
  } catch { owner = 'unavailable'; }
  if (lifetime.signal.aborted) return;
  if (owner === 'embedded') { await plugin.apply(ctx); return; }
  // No image/quota/model/session contributions, preference reads or mutations
  // are mounted against an external or unknown subscription implementation.
  if (React && ctx.slots?.inject) ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'simple-pet-subscription-status', order: 15,
    label: '订阅管理（桌宠内置）',
    inject: () => ({ message: owner === 'external'
      ? '当前订阅连接由其他插件提供，桌宠内置订阅模块未接管。请使用该插件原设置；完成停用并完整重启 DSH 后再使用内置模块。'
      : '桌宠内置订阅模块尚未就绪。请完整退出 DSH（含托盘）后重开；不会改用其他账号或调用模型。' }),
  }, ({ message }) => React.createElement('p', { role: 'status' }, message)));
}
