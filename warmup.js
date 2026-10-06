// Automatic warm-up has its own durable attempt journal, never conversation history.
const MINUTE = 60_000;
const GRACE = 90_000;
export const WARMUP_TIMEOUT = 60_000;
export const WARMUP_RETRY_DELAY = 5000;
export const WARMUP_MAX_ATTEMPTS = 3;
const validTime = value => typeof value === 'string' && value.length === 5 && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const epoch = value => Number.isSafeInteger(value) && value > 0;

export function warmupPreferences(raw) {
  return { daily: raw?.codexWarmupDaily === true && validTime(raw?.codexWarmupTime),
    time: validTime(raw?.codexWarmupTime) ? raw.codexWarmupTime : '09:30', reset: raw?.codexWarmupReset === true,
    startup: raw?.codexWarmupStartup === true };
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
    && /^(?:daily:\d{4}-\d{2}-\d{2}|(?:reset|window):[a-f0-9]{16}:\d{10,16})$/.test(key)).slice(-96) : [];
  const armed = /^[a-f0-9]{16}$/.test(raw?.armed?.accountKey ?? '') && epoch(raw?.armed?.resetAt)
    ? { accountKey: raw.armed.accountKey, resetAt: raw.armed.resetAt } : null;
  const missedDaily = typeof raw?.missedDaily?.day === 'string' && raw.missedDaily.day.length === 10
    && /^\d{4}-\d{2}-\d{2}$/.test(raw.missedDaily.day) && validTime(raw.missedDaily.time)
    ? { day: raw.missedDaily.day, time: raw.missedDaily.time } : null;
  return { version: 1, keys, armed, missedDaily, lastAttemptAt: epoch(raw?.lastAttemptAt) ? raw.lastAttemptAt : null,
    lastSuccessAt: epoch(raw?.lastSuccessAt) ? raw.lastSuccessAt : null,
    unresolvedWindow: /^[a-f0-9]{16}$/.test(raw?.unresolvedWindow?.accountKey ?? '') && epoch(raw?.unresolvedWindow?.attemptedAt)
      ? { accountKey: raw.unresolvedWindow.accountKey, attemptedAt: raw.unresolvedWindow.attemptedAt } : null };
}

// Race every external wait against cancellation, even when a supplied adapter ignores signal.
function cancellable(task, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return task(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); }
    signal.addEventListener('abort', abort, { once: true });
  });
}
const windowKey = (quota, now) => /^[a-f0-9]{16}$/.test(quota?.accountKey ?? '') && epoch(quota?.fiveHour?.resetAt)
  && quota.fiveHour.resetAt > now ? `window:${quota.accountKey}:${quota.fiveHour.resetAt}` : null;

export class CodexWarmupScheduler {
  constructor({ getQuota, run, save, journal, onChange = () => {}, signal, clock = Date.now, wait = delay }) {
    this.getQuota = getQuota; this.run = run; this.save = save; this.onChange = onChange; this.wait = wait;
    this.signal = signal; this.clock = clock; this.journal = loadWarmupJournal(journal);
    this.prefs = warmupPreferences(null); this.previousTick = null; this.busy = null; this.active = null; this.stopped = false;
    this.startupChecked = false; this.expectedWakeAt = null; this.alertSequence = 0;
    this.view = { status: 'disabled', detail: '自动预热已关闭', lastAttemptAt: this.journal.lastAttemptAt,
      lastSuccessAt: this.journal.lastSuccessAt, lastReason: null, nextDailyAt: null, timezone: '', model: null,
      alertId: null, safetyHint: null, attempt: 0 };
  }
  update(status, detail) { Object.assign(this.view, { status, detail }); this.onChange({ ...this.view }); }
  // Call after tick settles and after preferences/quota changes. No internal polling timer.
  nextWakeAt(now = this.clock()) {
    if (this.stopped || this.signal?.aborted || this.busy) return null;
    const candidates = [];
    if (this.prefs.daily) candidates.push(localSchedule(now, this.prefs.time).next);
    const armed = this.journal.armed;
    if (this.prefs.reset && armed && armed.resetAt > now
      && !this.journal.keys.includes(`reset:${armed.accountKey}:${armed.resetAt}`)) candidates.push(armed.resetAt);
    this.expectedWakeAt = candidates.length ? Math.min(...candidates) : null;
    return this.expectedWakeAt;
  }
  nextDelay(now = this.clock()) {
    const at = this.nextWakeAt(now); return at === null ? null : Math.max(0, at - now);
  }
  async tick(raw, now = this.clock()) {
    if (this.stopped || this.signal?.aborted) return;
    const prefs = warmupPreferences(raw), changed = JSON.stringify(prefs) !== JSON.stringify(this.prefs);
    const previousPrefs = this.prefs; this.prefs = prefs;
    if (changed) this.active?.abort();
    const schedule = localSchedule(now, prefs.time);
    this.view.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.view.nextDailyAt = prefs.daily ? schedule.next : null;
    const initial = this.previousTick === null;
    const gap = initial ? 0 : now - this.previousTick;
    // A long interval is intentional only if index armed this exact deadline and wakes promptly.
    const punctual = !initial && !changed && this.expectedWakeAt !== null
      && now >= this.expectedWakeAt && now - this.expectedWakeAt < MINUTE && gap >= 0;
    this.expectedWakeAt = null; this.previousTick = now;
    if (this.busy) return;
    if (!prefs.daily && !prefs.reset && !prefs.startup) {
      if (this.journal.armed) {
        const cancellation = new AbortController(); this.active = cancellation; this.journal.armed = null;
        const signal = AbortSignal.any([cancellation.signal, ...(this.signal ? [this.signal] : [])]);
        this.busy = cancellable(() => this.save(this.journal), signal).catch(() => {});
        try { await this.busy; } finally {
          this.busy = null; if (this.active === cancellation) this.active = null;
        }
      }
      this.update('disabled', '自动预热已关闭'); return;
    }
    if (changed || this.view.status === 'disabled') this.update('idle', '等待启动检查、每日时间或已确认的 5h 重置');
    const dailyKey = `daily:${schedule.day}`;
    const missedWake = initial || gap < 0 || (gap > GRACE && !punctual);
    let suppressed = false;
    if (prefs.daily && schedule.at !== null && now > schedule.at
      && (missedWake || !previousPrefs.daily || previousPrefs.time !== prefs.time)
      && (this.journal.missedDaily?.day !== schedule.day || this.journal.missedDaily.time !== prefs.time)) {
      this.journal.missedDaily = { day: schedule.day, time: prefs.time }; suppressed = true;
    }
    if (missedWake && this.journal.armed?.resetAt <= now) {
      const key = `reset:${this.journal.armed.accountKey}:${this.journal.armed.resetAt}`;
      if (!this.journal.keys.includes(key)) { this.journal.keys = [...this.journal.keys, key].slice(-96); suppressed = true; }
    }
    const missed = this.journal.missedDaily?.day === schedule.day && this.journal.missedDaily.time === prefs.time;
    const daily = prefs.daily && !missed && schedule.at !== null && now >= schedule.at && now - schedule.at < MINUTE
      && gap >= 0 && (gap <= GRACE || punctual) && !this.journal.keys.includes(dailyKey);
    const startup = prefs.startup && !this.startupChecked;
    if (startup) this.startupChecked = true;
    this.busy = this.work({ prefs, daily, dailyKey, startup, now, timely: !missedWake || punctual, suppressed });
    try { await this.busy; } finally { this.busy = null; }
  }
  async work({ prefs, daily, dailyKey, startup, now, timely, suppressed }) {
    const lifetime = new AbortController(); this.active = lifetime;
    const life = AbortSignal.any([lifetime.signal, ...(this.signal ? [this.signal] : [])]);
    let claimed = false, candidate = null;
    try {
      // Journal failures are never retried: durable dedup must precede stream.
      const dueArm = prefs.reset && timely && this.journal.armed && now >= this.journal.armed.resetAt
        && now - this.journal.armed.resetAt <= GRACE ? this.journal.armed : null;
      const ownResetKey = dueArm ? `reset:${dueArm.accountKey}:${dueArm.resetAt}` : null;
      const claimReset = ownResetKey && !this.journal.keys.includes(ownResetKey);
      if (daily || startup || claimReset) Object.assign(this.view, { alertId: null, safetyHint: null, attempt: 0 });
      if (daily || claimReset) {
        this.journal.keys = [...new Set([...this.journal.keys, ...(daily ? [dailyKey] : []),
          ...(claimReset ? [ownResetKey] : [])])].slice(-96);
        this.journal.lastAttemptAt = now; this.view.lastAttemptAt = now;
        this.view.lastReason = claimReset ? 'reset' : 'daily';
        await cancellable(() => this.save(this.journal), life); claimed = true;
      } else if (suppressed) await cancellable(() => this.save(this.journal), life);
      for (let attempt = 1; attempt <= WARMUP_MAX_ATTEMPTS; attempt++) {
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(new Error('warm-up timeout')), WARMUP_TIMEOUT);
        const signal = AbortSignal.any([life, timeout.signal]);
        let phase = 'precheck';
        try {
          this.view.attempt = attempt;
          if (!candidate) {
            const quota = await cancellable(() => this.getQuota({ force: startup, signal }), signal);
            const at = this.clock(), fresh = warmupReportFresh(quota, at), armed = this.journal.armed;
            const resetKey = armed ? `reset:${armed.accountKey}:${armed.resetAt}` : null;
            const reset = prefs.reset && armed && fresh && quota.accountKey === armed.accountKey && timely
              && now >= armed.resetAt && now - armed.resetAt <= GRACE
              && (!this.journal.keys.includes(resetKey) || (claimReset && resetKey === ownResetKey));
            let nextArm = prefs.reset && fresh && epoch(quota.fiveHour?.resetAt) && quota.fiveHour.resetAt > at
              ? { accountKey: quota.accountKey, resetAt: quota.fiveHour.resetAt } : null;
            if (prefs.reset && !fresh && armed && at <= armed.resetAt + GRACE) nextArm = armed;
            if (JSON.stringify(nextArm) !== JSON.stringify(armed)) {
              phase = 'journal'; this.journal.armed = nextArm;
              await cancellable(() => this.save(this.journal), signal); phase = 'precheck';
            }
            const boot = startup && fresh && knownWindow(quota.weekly) && quota.fiveHour?.remainingPercent === 100
              && epoch(quota.fiveHour.resetAt) && quota.fiveHour.resetAt > at && !quotaBlocked(quota, at);
            if (!daily && !reset && !boot) return;
            if (boot && this.journal.keys.includes(windowKey(quota, at))) {
              this.update('skipped', '此账号的 5h 窗口已尝试预热，不重复发送'); return;
            }
            candidate = { accountKey: fresh ? quota.accountKey : null, reset, armed, boot,
              keys: [...(daily ? [dailyKey] : []), ...(reset ? [resetKey] : []), ...(boot ? [windowKey(quota, at)] : [])],
              windowKey: boot ? windowKey(quota, at) : null };
          }
          if (!claimed) {
            // Claim the occurrence even if forced preflight fails; only this live task may safely retry.
            phase = 'journal';
            this.journal.keys = [...new Set([...this.journal.keys, ...candidate.keys])].slice(-96);
            this.journal.lastAttemptAt = now; this.view.lastAttemptAt = now;
            this.view.lastReason = candidate.reset ? 'reset' : daily ? 'daily' : 'startup';
            await cancellable(() => this.save(this.journal), signal); claimed = true; phase = 'precheck';
          }
          this.update('running', '正在检查额度并进行极简预热…');
          const current = await cancellable(() => this.getQuota({ force: true, signal }), signal);
          const at = this.clock();
          if (!warmupReportFresh(current, at) || !knownWindow(current.fiveHour) || !knownWindow(current.weekly)) {
            throw new Error('fresh quota unavailable');
          }
          if (candidate.accountKey && current.accountKey !== candidate.accountKey) {
            this.update('skipped', '账号发生切换，本次未发送请求'); return;
          }
          candidate.accountKey ??= current.accountKey;
          if (candidate.reset && (current.observedAt < candidate.armed.resetAt || at < candidate.armed.resetAt
            || at - candidate.armed.resetAt > GRACE)) {
            this.update('skipped', '尚未取得重置后的新鲜报告，本次未发送请求'); return;
          }
          if (quotaBlocked(current, at)) { this.update('skipped', '5h 或周额度已耗尽，本次未发送请求'); return; }
          if (candidate.reset && current.fiveHour.resetAt > candidate.armed.resetAt && current.fiveHour.remainingPercent < 100) {
            this.update('skipped', '新 5h 窗口已有调用，无需重复预热'); return;
          }
          if (candidate.boot && !daily && !candidate.reset && (current.fiveHour.remainingPercent !== 100
            || !epoch(current.fiveHour.resetAt) || current.fiveHour.resetAt <= at)) {
            this.update('skipped', '启动检查未确认新鲜 100% 的 5h 窗口，本次未发送请求'); return;
          }
          const key = windowKey(current, at);
          // Unknown post-call window: conservative same-account 5h suppression, NOT a reset deadline.
          const unresolved = this.journal.unresolvedWindow;
          if (unresolved && unresolved.accountKey === current.accountKey && !candidate.ownsUnresolved
            && at >= unresolved.attemptedAt && at - unresolved.attemptedAt < 18_000_000) {
            this.update('skipped', '上次预热的新窗口尚未确认，为避免重复消耗，本次不发送'); return;
          }
          if (key && this.journal.keys.includes(key) && candidate.windowKey !== key) {
            this.update('skipped', '此账号的 5h 窗口已尝试预热，不重复发送'); return;
          }
          if (key) {
            phase = 'journal'; this.journal.keys = [...this.journal.keys, key].slice(-96);
            await cancellable(() => this.save(this.journal), signal); phase = 'precheck';
          } else if (!candidate.ownsUnresolved) {
            phase = 'journal';
            this.journal.unresolvedWindow = { accountKey: current.accountKey, attemptedAt: at };
            await cancellable(() => this.save(this.journal), signal); phase = 'precheck';
            candidate.ownsUnresolved = true;
          }
          // Keep the window claim across retries, but permit this task's own proven-unsent retry.
          candidate.windowKey = key;
          phase = 'stream';
          const result = await cancellable(() => this.run({ quota: current, signal }), signal);
          signal.throwIfAborted(); this.view.model = result.model;
          // Idle upstream reports can keep an expired deadline until the first real call.
          // Best-effort refresh records the actual new window; never invent a reset time.
          if (!key) {
            try {
              const after = await cancellable(() => this.getQuota({ force: true, signal }), signal);
              const afterAt = this.clock(), afterKey = windowKey(after, afterAt);
              if (warmupReportFresh(after, afterAt) && after.accountKey === current.accountKey && afterKey) {
                this.journal.keys = [...new Set([...this.journal.keys, afterKey])].slice(-96);
                this.journal.unresolvedWindow = null;
                if (prefs.reset) this.journal.armed = { accountKey: after.accountKey, resetAt: after.fiveHour.resetAt };
              }
            } catch { /* A completed model call must never be retried for quota refresh failure. */ }
          }
          this.journal.lastSuccessAt = this.clock(); this.view.lastSuccessAt = this.journal.lastSuccessAt;
          phase = 'journal'; await cancellable(() => this.save(this.journal), signal);
          this.update('succeeded', '极简请求已完成，窗口重置时间以订阅报告为准'); return;
        } catch (error) {
          if (life.aborted) {
            this.update('skipped', '预热已取消；已发送部分可能计入额度，不会自动重试'); return;
          }
          if (error?.accountChanged === true) { this.update('skipped', '账号发生切换，本次未发送请求'); return; }
          if (phase === 'precheck' && !candidate && !daily && !startup && !claimReset) {
            this.update('skipped', '暂未取得额度报告，未发送预热请求'); return;
          }
          const safe = phase === 'precheck' || (phase === 'stream' && error?.requestNotSent === true && !signal.aborted);
          if (safe && attempt < WARMUP_MAX_ATTEMPTS) {
            this.update('retrying', `已确认请求尚未发送，5 秒后安全重试（${attempt + 1}/${WARMUP_MAX_ATTEMPTS}）`);
            clearTimeout(timer);
            await cancellable(() => this.wait(WARMUP_RETRY_DELAY, life), life);
            continue;
          }
          this.fail(safe); return;
        } finally { clearTimeout(timer); }
      }
    } catch {
      if (!life.aborted) this.fail(true);
      else if (!this.stopped) this.update('skipped', '预热已取消，不会自动重试');
    } finally { if (this.active === lifetime) this.active = null; }
  }
  fail(knownUnsent) {
    this.view.safetyHint = knownUnsent
      ? '未调用模型或无法安全保存去重记录，已停止；请检查后手动操作，勿连续重复预热。'
      : '请求可能已发送并计入额度，结果未知；为避免重复消耗，不会自动重试。';
    this.view.alertId = `warmup:${this.clock()}:${++this.alertSequence}`;
    this.update('failed', this.view.safetyHint);
  }
  async stop() { this.stopped = true; this.active?.abort(); await this.busy; }
}
