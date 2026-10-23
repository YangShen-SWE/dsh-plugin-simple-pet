import { join } from 'node:path';
import { homedir } from 'node:os';
import { createSubscriptionSettings } from './embedded-subscription-settings.js';

export const SUBSCRIPTION_SERVICES = ['llm','credentials','settings','web','loader','tools','attachments'];
export function createEmbeddedSubscription({
  load = () => import('./vendor/codex-subscription/lib/index.js'),
  settingsFile = join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'DshSimpleDesktopPet', 'subscription-preferences.json'),
  onOwner = () => {},
  onAdapter = () => {},
} = {}) {
  return {
    name: 'simple-pet-embedded-subscription',
    inject: SUBSCRIPTION_SERVICES,
    async apply(ctx) {
      const legacyConflict = () => ctx.llm.listProviders().some(row => row.id === 'codex-accounts');
      const reportLegacyConflict = () => { onOwner('failed'); ctx.logger?.warn?.('检测到已有 codex-accounts 提供者；统一订阅连接未启用。请停用旧独立账号插件并完整重启，不会覆盖其他所有者。'); };
      if (legacyConflict()) { reportLegacyConflict(); return; }
      // An independently active owner is never overwritten. The installer must
      // coordinate activation before replacing that owner; no hot account swap.
      if (ctx.llm.listProviders().some(row => row.id === 'openai-codex')) { onOwner('external'); return; }
      let live = true;
      ctx.effect(() => () => { live = false; onAdapter(null); }, 'simple-pet: embedded subscription lifetime');
      const upstream = await load();
      if (!live) return;
      if (legacyConflict()) { reportLegacyConflict(); return; }
      if (ctx.llm.listProviders().some(row => row.id === 'openai-codex')) { onOwner('external'); return; }
      let store;
      const seedEntry = [...ctx.loader.entries()].find(entry => (entry.options?.id ?? entry.id) === 'codex-subscription');
      const raw = seedEntry?.options?.config ?? {};
      const seed = Object.fromEntries(Object.entries(raw).map(([key,value]) => [key, typeof value?.get === 'function' ? value.get() : value]));
      try {
        await upstream.apply(ctx, {}, async schema => {
          store = await createSubscriptionSettings({ file: settingsFile, schema, seed });
          if (!live) { store.dispose(); throw new Error('SUBSCRIPTION_EMBEDDING_CLOSED'); }
          ctx.effect(() => () => store.dispose(), 'simple-pet: isolated subscription settings');
          const adapter = Object.create(store);
          adapter.onSubscriptionAdapter = value => { if (live) onAdapter(value); };
          adapter.assertEmbeddedOwner = () => {
            if (!live) throw new Error('SUBSCRIPTION_EMBEDDING_CLOSED');
            if (legacyConflict()) throw Object.assign(new Error('SUBSCRIPTION_LEGACY_OWNER_CONFLICT'), { code: 'SUBSCRIPTION_LEGACY_OWNER_CONFLICT' });
            if (ctx.llm.listProviders().some(row => row.id === 'openai-codex')) {
              throw Object.assign(new Error('SUBSCRIPTION_EXTERNAL_OWNER'), { code: 'SUBSCRIPTION_EXTERNAL_OWNER' });
            }
          };
          return adapter;
        });
        onOwner('embedded');
      } catch (error) {
        store?.dispose();
        if (error.code === 'SUBSCRIPTION_LEGACY_OWNER_CONFLICT') { reportLegacyConflict(); return; }
        if (error.code === 'SUBSCRIPTION_EXTERNAL_OWNER') { onOwner('external'); return; }
        onOwner('failed'); throw error;
      }
      // Cordis apply must resolve undefined, never a service/adapter object.
    },
  };
}
