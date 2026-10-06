// Automatic warm-up has its own durable attempt journal, never conversation history.
const MINUTE = 60_000;
const GRACE = 90_000;
export const WARMUP_TIMEOUT = 60_000;
const validTime = value => typeof value === 'string' && value.length === 5 && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const epoch = value => Number.isSafeInteger(value) && value > 0;

export function warmupPreferences(raw) {
  return { daily: raw?.codexWarmupDaily === true && validTime(raw?.codexWarmupTime),
    time: validTime(raw?.codexWarmupTime) ? raw.codexWarmupTime : '09:30', reset: raw?.codexWarmupReset === true };
}
export function localSchedule(now, time) {
  const date = new Date(now), [hour, minute] = time.split(':').map(Number);
  const target = new Date(now); target.setHours(hour, minute, 0, 0);
  // A nonexistent spring-forward time is skipped, not shifted to another hour.
  const exists = target.getHours() === hour && target.getMinutes() === minute;
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  let next = target.getTime();
  if (!exists || next <= now) {
    for (let i = 1; i <= 3; i++) {
      const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + i); tomorrow.setHours(hour, minute, 0, 0);
      if (tomorrow.getHours() === hour && tomorrow.getMinutes() === minute) { next = tomorrow.getTime(); break; }
    }
  }
  return { day, at: exists ? target.getTime() : null, next };
}
export function warmupReportFresh(quota, now) {
  return quota?.provider === 'openai-codex' && quota.selection === 'active'
    && ['ready', 'stale'].includes(quota.status) && /^[a-f0-9]{16}$/.test(quota.accountKey ?? '')
    && epoch(quota.observedAt) && quota.observedAt <= now + 5000 && now - quota.observedAt <= 120_000;
}
function knownWindow(window) {
  return Number.isFinite(window?.remainingPercent) && window.remainingPercent >= 0 && window.remainingPercent <= 100;
}
function quotaBlocked(quota, now) {
  // A past reset may remain in an idle upstream report until the next real call.
  return [quota.fiveHour, quota.weekly].some(window => window?.remainingPercent === 0
    && (!epoch(window.resetAt) || window.resetAt > now));
}
export function loadWarmupJournal(raw) {
  const keys = Array.isArray(raw?.keys) ? raw.keys.filter(key => typeof key === 'string'
    && /^(?:daily:\d{4}-\d{2}-\d{2}|reset:[a-f0-9]{16}:\d{10,16})$/.test(key)).slice(-96) : [];
  const armed = /^[a-f0-9]{16}$/.test(raw?.armed?.accountKey ?? '') && epoch(raw?.armed?.resetAt)
    ? { accountKey: raw.armed.accountKey, resetAt: raw.armed.resetAt } : null;
  const missedDaily = typeof raw?.missedDaily?.day === 'string' && raw.missedDaily.day.length === 10
    && /^\d{4}-\d{2}-\d{2}$/.test(raw.missedDaily.day) && validTime(raw.missedDaily.time)
    ? { day: raw.missedDaily.day, time: raw.missedDaily.time } : null;
  return { version: 1, keys, armed, missedDaily, lastAttemptAt: epoch(raw?.lastAttemptAt) ? raw.lastAttemptAt : null,
    lastSuccessAt: epoch(raw?.lastSuccessAt) ? raw.lastSuccessAt : null };
}

export class CodexWarmupScheduler {
  constructor({ getQuota, run, save, journal, onChange = () => {}, signal, clock = Date.now }) {
    this.getQuota = getQuota; this.run = run; this.save = save; this.onChange = onChange;
    this.signal = signal; this.clock = clock; this.journal = loadWarmupJournal(journal);
    this.prefs = warmupPreferences(null); this.previousTick = null; this.busy = null; this.active = null; this.stopped = false;
    this.view = { status: 'disabled', detail: '自动预热已关闭', lastAttemptAt: this.journal.lastAttemptAt,
      lastSuccessAt: this.journal.lastSuccessAt, lastReason: null, nextDailyAt: null, timezone: '', model: null };
  }
  update(status, detail) { Object.assign(this.view, { status, detail }); this.onChange({ ...this.view }); }
  async tick(raw, now = this.clock()) {
    if (this.stopped || this.signal?.aborted) return;
    const prefs = warmupPreferences(raw), changed = JSON.stringify(prefs) !== JSON.stringify(this.prefs);
    const previousPrefs = this.prefs;
    this.prefs = prefs;
    if (changed) this.active?.abort();
    const schedule = localSchedule(now, prefs.time);
    this.view.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.view.nextDailyAt = prefs.daily ? schedule.next : null;
    const initial = this.previousTick === null;
    const gap = initial ? 0 : now - this.previousTick;
    this.previousTick = now;
    if (this.busy) return;
    if (!prefs.daily && !prefs.reset) {
      if (this.journal.armed) { this.journal.armed = null; await this.save(this.journal).catch(() => {}); }
      this.update('disabled', '自动预热已关闭'); return;
    }
    if (changed || this.view.status === 'disabled') this.update('idle', '等待每日时间或已确认的 5h 重置');
    const dailyKey = `daily:${schedule.day}`;
    let suppressed = false;
    if (prefs.daily && schedule.at !== null && now > schedule.at
      && (initial || gap < 0 || gap > GRACE || !previousPrefs.daily || previousPrefs.time !== prefs.time)
      && (this.journal.missedDaily?.day !== schedule.day || this.journal.missedDaily.time !== prefs.time)) {
      this.journal.missedDaily = { day: schedule.day, time: prefs.time }; suppressed = true;
    }
    if ((initial || gap < 0 || gap > GRACE) && this.journal.armed?.resetAt <= now) {
      const key = `reset:${this.journal.armed.accountKey}:${this.journal.armed.resetAt}`;
      if (!this.journal.keys.includes(key)) { this.journal.keys = [...this.journal.keys, key].slice(-96); suppressed = true; }
    }
    const missed = this.journal.missedDaily?.day === schedule.day && this.journal.missedDaily.time === prefs.time;
    const daily = prefs.daily && !missed && schedule.at !== null && now >= schedule.at && now - schedule.at < MINUTE
      && gap >= 0 && gap <= GRACE && !this.journal.keys.includes(dailyKey);
    this.busy = this.work({ prefs, daily, dailyKey, now, gap, suppressed });
    try { await this.busy; } finally { this.busy = null; }
  }
  async work({ prefs, daily, dailyKey, now, gap, suppressed }) {
    const lifetime = new AbortController(); this.active = lifetime;
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(WARMUP_TIMEOUT), ...(this.signal ? [this.signal] : [])]);
    let attempted = false;
    try {
      if (suppressed) { await this.save(this.journal); signal.throwIfAborted(); }
      const quota = await this.getQuota({ force: false, signal }); signal.throwIfAborted();
      const fresh = warmupReportFresh(quota, now);
      const armed = this.journal.armed;
      const resetKey = armed ? `reset:${armed.accountKey}:${armed.resetAt}` : null;
      const reset = prefs.reset && armed && fresh && quota.accountKey === armed.accountKey
        && now >= armed.resetAt && now - armed.resetAt <= GRACE && gap >= 0 && gap <= GRACE
        && !this.journal.keys.includes(resetKey);
      let nextArm = prefs.reset && fresh && epoch(quota.fiveHour?.resetAt) && quota.fiveHour.resetAt > now
        ? { accountKey: quota.accountKey, resetAt: quota.fiveHour.resetAt } : null;
      // Do not lose a known deadline merely because one quota poll failed.
      if (prefs.reset && !fresh && armed && now <= armed.resetAt + GRACE) nextArm = armed;
      if (JSON.stringify(nextArm) !== JSON.stringify(armed)) {
        this.journal.armed = nextArm; await this.save(this.journal); signal.throwIfAborted();
      }
      if (!daily && !reset) return;
      const keys = [...(daily ? [dailyKey] : []), ...(reset ? [resetKey] : [])];
      // Claim before any model call. Failures, timeouts and restarts never retry this occurrence.
      this.journal.keys = [...this.journal.keys, ...keys].slice(-96);
      this.journal.lastAttemptAt = now; this.view.lastAttemptAt = now;
      this.view.lastReason = reset ? 'reset' : 'daily';
      await this.save(this.journal); signal.throwIfAborted(); attempted = true;
      this.update('running', reset ? '5h 重置预热中…' : '每日预热中…');
      const current = await this.getQuota({ force: true, signal }); signal.throwIfAborted();
      const at = this.clock();
      if (!warmupReportFresh(current, at) || !knownWindow(current.fiveHour) || !knownWindow(current.weekly)) {
        this.update('skipped', '未取得当前账号的新鲜 5h / 周额度报告，本次未发送请求'); return;
      }
      if (fresh && current.accountKey !== quota.accountKey) {
        this.update('skipped', '账号发生切换，本次未发送请求'); return;
      }
      if (reset && (current.observedAt < armed.resetAt || at < armed.resetAt || at - armed.resetAt > GRACE)) {
        this.update('skipped', '尚未取得重置后的新鲜报告，本次未发送请求'); return;
      }
      if (quotaBlocked(current, at)) { this.update('skipped', '5h 或周额度已耗尽，本次未发送请求'); return; }
      if (reset && current.fiveHour.resetAt > armed.resetAt && current.fiveHour.remainingPercent < 100) {
        this.update('skipped', '新 5h 窗口已有调用，无需重复预热'); return;
      }
      const result = await this.run({ quota: current, signal }); signal.throwIfAborted();
      this.view.model = result.model;
      this.journal.lastSuccessAt = this.clock(); this.view.lastSuccessAt = this.journal.lastSuccessAt;
      await this.save(this.journal);
      this.update('succeeded', '极简请求已完成，窗口重置时间以订阅报告为准');
    } catch {
      if (!this.stopped && !this.signal?.aborted) this.update(attempted ? 'failed' : 'skipped',
        signal.aborted ? '请求已取消或超时；本次不自动重试，已发送部分可能计入额度' : '预热或去重记录保存失败；本次不自动重试');
    } finally { if (this.active === lifetime) this.active = null; }
  }
  async stop() { this.stopped = true; this.active?.abort(); await this.busy; }
}
