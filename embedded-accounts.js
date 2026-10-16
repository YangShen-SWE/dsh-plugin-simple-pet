import { apply as applyAccounts } from './codex-accounts/index.js';

// Keep the original credential scope, directory and provider/model IDs. Merging
// packaging is not an account migration and must never copy OAuth grants.
export function createEmbeddedAccountsPlugin(options = {}) { return Object.freeze({
  name: 'simple-pet-accounts',
  inject: ['credentials', 'llm'],
  async apply(ctx) {
    // Old separately-selected bundles may still exist after an upgrade. Do not
    // steal or replace their provider (which could have requests in flight).
    // Disable that bundle on the next full restart to use the integrated owner.
    if (ctx.llm.listProviders?.().some(row => row.id === 'codex-accounts')) return;
    await applyAccounts(ctx, options);
  },
}); }
export const embeddedAccountsPlugin = createEmbeddedAccountsPlugin();
