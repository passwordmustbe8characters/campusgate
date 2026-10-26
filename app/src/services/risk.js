'use strict';

// FR-A11 thresholds: 2-3 points -> ask for an emailed code; 4 -> refuse.
const STEP_UP_AT = 2;
const BLOCK_AT = 4;
const HISTORY_DAYS = 30;
const LAGOS_UTC_OFFSET_H = 1; // West Africa Time, no daylight saving

/**
 * Risk score at sign-in (FR-A11), computed after a correct password.
 * One point each:
 *   new_ip       this IP has not signed in to the account in the last 30 days
 *   new_device   this browser (user agent) has not, either
 *   off_hours    between 00:00 and 05:00 Lagos time
 *   failures     3 or more failed sign-ins on the account in the last 15 minutes
 * An account with no sign-ins in the last 30 days has no baseline, so new_ip
 * and new_device are not counted for it (a first sign-in is not suspicious).
 */
function createRiskService({ db, now = () => new Date() }) {
  async function assess(userId, { ip, userAgent }) {
    const ua = typeof userAgent === 'string' ? userAgent.slice(0, 256) : null;
    const [history, failures] = await Promise.all([
      db('sessions').where({ user_id: userId })
        .where('created_at', '>', db.raw(`now() - interval '${HISTORY_DAYS} days'`))
        .select('ip', 'user_agent').limit(500),
      db('auth_logs').where({ user_id: userId, event_type: 'login_failure' })
        .where('occurred_at', '>', db.raw("now() - interval '15 minutes'"))
        .count({ n: '*' }).first(),
    ]);
    const signals = [];
    if (history.length > 0) {
      if (!history.some((h) => h.ip === ip)) signals.push('new_ip');
      if (!history.some((h) => h.user_agent === ua)) signals.push('new_device');
    }
    const lagosHour = (now().getUTCHours() + LAGOS_UTC_OFFSET_H) % 24;
    if (lagosHour < 5) signals.push('off_hours');
    if (Number(failures.n) >= 3) signals.push('failures');
    const score = signals.length;
    const decision = score >= BLOCK_AT ? 'block' : score >= STEP_UP_AT ? 'step_up' : 'allow';
    return { score, signals, decision };
  }

  return { assess };
}

module.exports = { createRiskService, STEP_UP_AT, BLOCK_AT };
