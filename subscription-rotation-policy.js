// Pure policy only: no credentials, I/O, switches, retries, or credit balances.
export const ROTATION_STRATEGIES = Object.freeze([
  { id: 'balanced', label: '均衡轮换', description: '优先使用最近未用的可用订阅。' },
  { id: 'most-remaining', label: '剩余额度最多', description: '优先使用最低窗口剩余百分比最高的订阅。' },
  { id: 'low-tier-first', label: '低档套餐优先', description: '仅在已知 Free、Go、Plus、Pro 中优先低档，再比较额度。' },
  { id: 'high-tier-first', label: '高档套餐优先', description: '仅在已知 Free、Go、Plus、Pro 中优先高档，再比较额度。' },
  { id: 'reset-soon', label: '即将重置优先', description: '优先使用已确认未来重置时间最近的订阅。' },
].map(Object.freeze));
const STRATEGIES = new Set(ROTATION_STRATEGIES.map(item => item.id));
const TIERS = new Map([['free', 0], ['go', 1], ['plus', 2], ['pro', 3]]);
const KEY = /^[a-f0-9]{16}$/i, GENERATION = /^[a-f0-9]{64}$/i;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && own(Object.getOwnPropertyDescriptor(value, key), 'value'));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const percent = value => finite(value) && value >= 0 && value <= 100;
const time = value => Number.isSafeInteger(value) && value >= 0;
const fresh = (value, now) => time(now) && time(value) && value <= now && now - value <= 120000;
const futureReset = (value, now) => Number.isSafeInteger(value) && value > 0 && Number.isSafeInteger(value * 1000) && value * 1000 > now;
const subject = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u0020\u007f]/u.test(value);
const exactKeys = (value, keys) => record(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => own(value, key));
const invalid = () => Object.assign(new Error('ROTATION_CONFIG_INVALID'), { code: 'ROTATION_CONFIG_INVALID' });

/** Undefined alone requests defaults. Persist only public account references. */
export function normalizeRotationConfig(value) {
  if (value === undefined) return { enabled: false, strategy: 'balanced', reservePercent: 10, accounts: [] };
  try {
    if (!exactKeys(value, ['enabled', 'strategy', 'reservePercent', 'accounts'])
      || typeof value.enabled !== 'boolean' || !STRATEGIES.has(value.strategy)
      || !Number.isInteger(value.reservePercent) || value.reservePercent < 0 || value.reservePercent > 90
      || !Array.isArray(value.accounts) || value.accounts.length > 32) throw invalid();
    const seen = new Set(), accounts = [];
    for (const row of value.accounts) {
      if (!exactKeys(row, ['accountKey', 'accountGeneration']) || typeof row.accountKey !== 'string' || !KEY.test(row.accountKey)
        || typeof row.accountGeneration !== 'string' || !GENERATION.test(row.accountGeneration)) throw invalid();
      const accountKey = row.accountKey.toLowerCase();
      if (seen.has(accountKey)) throw invalid();
      seen.add(accountKey);
      accounts.push({ accountKey, accountGeneration: row.accountGeneration.toLowerCase() });
    }
    return { enabled: value.enabled, strategy: value.strategy, reservePercent: value.reservePercent, accounts };
  } catch { throw invalid(); }
}

const decimal = value => typeof value === 'string' && value.length <= 64 && /^\d+(?:\.\d+)?$/u.test(value) && Number.isFinite(Number(value));
/** Report timestamps: fetchedAt milliseconds; resetsAt epoch seconds (unchanged). */
export function rotationUsageSummary(report, now = Date.now()) {
  try {
    if (!record(report)) return { status: 'unknown' };
    const meta = {
      ...(typeof report.planType === 'string' && /^[a-z][a-z_]{0,31}$/u.test(report.planType) ? { planType: report.planType } : {}),
      ...(time(report.fetchedAt) ? { fetchedAt: report.fetchedAt } : {}),
    };
    const limits = Array.isArray(report.rateLimits) ? report.rateLimits : [];
    const codex = limits.filter(item => record(item) && item.id === 'codex');
    const windows = codex.flatMap(item => Array.isArray(item.windows) ? item.windows : []);
    const individual = report.individualLimit;
    const restricted = report.spendControlReached === true
      || (typeof report.rateLimitReachedType === 'string' && report.rateLimitReachedType.length > 0)
      || windows.some(item => record(item) && finite(item.remainingPercent) && item.remainingPercent <= 0)
      || (record(individual) && finite(individual.remainingPercent) && individual.remainingPercent <= 0);
    if (restricted) return { status: 'restricted', ...meta };
    if (!fresh(report.fetchedAt, now) || codex.length !== 1 || windows.length === 0
      || (report.spendControlReached !== undefined && typeof report.spendControlReached !== 'boolean')
      || (report.rateLimitReachedType !== undefined && typeof report.rateLimitReachedType !== 'string')
      || !windows.every(item => record(item) && percent(item.remainingPercent)
        && Number.isSafeInteger(item.windowSeconds) && item.windowSeconds > 0
        && (item.resetsAt === undefined || futureReset(item.resetsAt, now)))) return { status: 'unknown', ...meta };
    if (individual !== undefined && (!record(individual) || !percent(individual.remainingPercent)
      || !decimal(individual.limit) || Number(individual.limit) <= 0 || !decimal(individual.used)
      || Number(individual.used) > Number(individual.limit)
      || (individual.resetsAt !== undefined && !futureReset(individual.resetsAt, now)))) return { status: 'unknown', ...meta };
    const constraints = [...windows, ...(individual === undefined ? [] : [individual])];
    // Missing reset times do not prevent use, but never invent a reset-soon rank.
    const resetsKnown = constraints.every(item => futureReset(item.resetsAt, now));
    return { status: 'ready', ...meta,
      remainingPercent: Math.min(...constraints.map(item => item.remainingPercent)),
      ...(resetsKnown ? { resetsAt: Math.min(...constraints.map(item => item.resetsAt)) } : {}),
    };
  } catch { return { status: 'unknown' }; }
}

/** Return the original row, never mutate input. Invalid recommendations fail closed.
 * lastUsed is a budgetSubject -> epoch-millisecond record, shared by aliases.
 */
export function recommendRotation(accounts, options, now = Date.now()) {
  try {
    if (!Array.isArray(accounts) || !record(options) || !STRATEGIES.has(options.strategy)
      || !Number.isInteger(options.reservePercent) || options.reservePercent < 0 || options.reservePercent > 90 || !time(now)) return null;
    const { strategy, reservePercent, excludeSubjects = [], lastUsed = {} } = options;
    if (!Array.isArray(excludeSubjects) || !excludeSubjects.every(subject) || !record(lastUsed)) return null;
    const excluded = new Set(excludeSubjects), counts = new Map();
    for (const row of accounts) {
      if (!record(row)) continue;
      if (row.active === true && subject(row.budgetSubject)) excluded.add(row.budgetSubject);
      if (typeof row.accountKey === 'string' && KEY.test(row.accountKey)) {
        const key = row.accountKey.toLowerCase(); counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const tiered = strategy === 'low-tier-first' || strategy === 'high-tier-first';
    const candidates = accounts.filter(row => {
      if (!record(row) || typeof row.accountKey !== 'string' || !KEY.test(row.accountKey)
        || typeof row.accountGeneration !== 'string' || !GENERATION.test(row.accountGeneration)
        || counts.get(row.accountKey.toLowerCase()) !== 1 || row.active !== false
        || !subject(row.budgetSubject) || excluded.has(row.budgetSubject)) return false;
      const usage = row.usage;
      return record(usage) && usage.status === 'ready' && fresh(usage.fetchedAt, now)
        && percent(usage.remainingPercent) && usage.remainingPercent > reservePercent
        && (usage.resetsAt === undefined || futureReset(usage.resetsAt, now))
        && (!tiered || TIERS.has(usage.planType))
        && (strategy !== 'reset-soon' || futureReset(usage.resetsAt, now));
    });
    const used = row => own(lastUsed, row.budgetSubject) && time(lastUsed[row.budgetSubject]) && lastUsed[row.budgetSubject] <= now ? lastUsed[row.budgetSubject] : -1;
    candidates.sort((a, b) => {
      let rank = 0;
      if (strategy === 'balanced') rank = used(a) - used(b);
      else if (strategy === 'reset-soon') rank = a.usage.resetsAt - b.usage.resetsAt;
      else if (tiered) rank = (TIERS.get(a.usage.planType) - TIERS.get(b.usage.planType)) * (strategy === 'low-tier-first' ? 1 : -1);
      if (rank === 0 && strategy !== 'balanced') rank = b.usage.remainingPercent - a.usage.remainingPercent;
      if (rank !== 0) return rank;
      const ak = a.accountKey.toLowerCase(), bk = b.accountKey.toLowerCase();
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
    return candidates[0] ?? null;
  } catch { return null; }
}
