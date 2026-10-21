import { join } from 'node:path';
import { homedir } from 'node:os';
import { createSubscriptionSettings } from './embedded-subscription-settings.js';

export const SUBSCRIPTION_SERVICES = ['llm','credentials','settings','web','loader','tools','attachments'];
export function createEmbeddedSubscription({
  load = () => import('./vendor/codex-subscription/lib/index.js'),
  settingsFile = join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'DshSimpleDesktopPet', 'subscription-preferences.json'),
  onOwner = () => {},
} = {}) {
  return {
    name: 'simple-pet-embedded-subscription',
    inject: SUBSCRIPTION_SERVICES,
    async apply(ctx) {
      // An independently active owner is never overwritten. The installer must
      // coordinate activation before replacing that owner; no hot account swap.
      if (ctx.llm.listProviders().some(row => row.id === 'openai-codex')) { onOwner('external'); return; }
      let live = true;
      ctx.effect(() => () => { live = false; }, 'simple-pet: embedded subscription lifetime');
      const upstream = await load();
      if (!live) return;
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
          adapter.assertEmbeddedOwner = () => {
            if (!live) throw new Error('SUBSCRIPTION_EMBEDDING_CLOSED');
            if (ctx.llm.listProviders().some(row => row.id === 'openai-codex')) {
              throw Object.assign(new Error('SUBSCRIPTION_EXTERNAL_OWNER'), { code: 'SUBSCRIPTION_EXTERNAL_OWNER' });
            }
          };
          return adapter;
        });
        onOwner('embedded');
      } catch (error) {
        store?.dispose();
        if (error.code === 'SUBSCRIPTION_EXTERNAL_OWNER') { onOwner('external'); return; }
        onOwner('failed'); throw error;
      }
      // Cordis apply must resolve undefined, never a service/adapter object.
    },
  };
}
