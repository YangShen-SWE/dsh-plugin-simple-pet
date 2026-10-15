// Pure shared-plan safety rules. Keep local-calendar semantics and conservative latches.
import { localSchedule } from './warmup.js';

export function warmupAfterAccountSwitch(uncertain, evidence) {
  // A local timeout is not proof that an already sent shared-account write was cancelled.
  // Never silently discharge this latch on a fresh read or a subsequent confirmation.
  return uncertain === true || (evidence?.attempted === true && evidence?.confirmed !== true);
}

export function multiBlocksLegacy(data, now) {
  const day = localSchedule(now, '00:00').day;
  return data.paused || data.attempts.some(row => row.day >= day || row.attemptedAt > now || (row.finishedAt ?? 0) > now);
}
export function legacyBlocksMulti(journal, now) {
  return journal.lastAttemptAt > now || (journal.lastAttemptAt > 0
    && localSchedule(journal.lastAttemptAt, '00:00').day === localSchedule(now, '00:00').day)
    || journal.keys.includes(`daily:${localSchedule(now, '00:00').day}`);
}
