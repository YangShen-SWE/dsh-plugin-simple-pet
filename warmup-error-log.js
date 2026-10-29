// Diagnostics only: no credentials, account data, raw errors or scheduler journals.
import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
const DETAILS = Object.freeze({
  unknown: '请求可能已发送并计入额度，结果未知；已停止，不会自动重试。',
  unsent: '未调用模型或无法安全保存去重记录，已停止；请检查登录、网络和记录权限。',
  journal: '原预热保护记录不可读，自动预热暂停；不要删除或清空保护记录。',
});
const valid = row => row && typeof row.id === 'string' && /^[a-zA-Z0-9:._-]{1,160}$/.test(row.id) && Object.hasOwn(DETAILS, row.kind) && Number.isSafeInteger(row.at) && row.at > 0 && row.at < 8640000000000000;
export class WarmupErrorLog {
  constructor(file, { clock = Date.now, warn = () => {} } = {}) {
    this.file = file; this.clock = clock; this.warn = warn; this.rows = [];
    try {
      if (statSync(file).size > 65536) throw Error('DIAGNOSTIC_LOG_TOO_LARGE');
      const data = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (!Array.isArray(data)) throw Error('DIAGNOSTIC_LOG_INVALID');
      this.rows = data.filter(valid).slice(-20).map(({id, kind, at}) => ({id, kind, at}));
    } catch (error) { if (error.code !== 'ENOENT') this.warn('simple-pet: warmup diagnostic log unavailable; scheduling safety records unchanged'); }
  }
  record(view) {
    if (view?.status !== 'failed') return;
    const kind = view.alertId === 'legacy-journal-unavailable' ? 'journal' : view.safetyHint === '未调用模型或无法安全保存去重记录，已停止；请检查后手动操作，勿连续重复预热。' ? 'unsent' : 'unknown';
    const row = { id: view.alertId, kind, at: this.clock() };
    if (!valid(row) || this.rows.some(previous => previous.id === row.id)) return;
    this.rows = [...this.rows, row].slice(-20);
    try {
      // Separate diagnostic file. Never modify the consumption/claim journals.
      writeFileSync(this.file + '.tmp', JSON.stringify(this.rows), { mode: 0o600 });
      renameSync(this.file + '.tmp', this.file);
    } catch { this.warn('simple-pet: could not save warmup diagnostic log; scheduling safety records unchanged'); }
  }
  view() { return this.rows.map(({kind, at}) => ({ at, detail: DETAILS[kind] })); }
}
