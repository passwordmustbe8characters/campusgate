'use strict';

const BUCKET_TTL_SEC = 180;
const bucketKey = (minute) => `cg:metrics:login_time:${minute}`;
const minuteOf = (ms) => Math.floor(ms / 60000);

/**
 * Sign-in timing (FR-D1 "average login time"): the server time of each
 * POST /auth/login (password check, lockout, audit), summed per minute in
 * Redis so every app process contributes. Never breaks the request.
 */
function createLoginTimer({ redis, logger, now = () => Date.now() }) {
  return async function record(ms) {
    const key = bucketKey(minuteOf(now()));
    try {
      await redis.multi().hincrby(key, 'count', 1).hincrbyfloat(key, 'ms', ms).expire(key, BUCKET_TTL_SEC).exec();
    } catch (err) {
      logger.warn({ event: 'metric_failed', metric: 'login_time', err }, 'could not record sign-in time');
    }
  };
}

/**
 * Live dashboard figures (FR-D1). Every number comes from data the system
 * already keeps: the audit log (sign-ins, failures, lockouts in the last
 * minute), the sessions table, the users table, the waiting room and the
 * sign-in timer. A handful of small queries, run every few seconds per open
 * dashboard.
 */
function createDashboard({ db, redis, waitingRoom, now = () => Date.now() }) {
  async function averageLoginMs() {
    // The last full minute plus the current one, so the figure does not drop to zero at :00.
    const m = minuteOf(now());
    const buckets = await Promise.all([bucketKey(m), bucketKey(m - 1)].map((k) => redis.hgetall(k)));
    const count = buckets.reduce((s, b) => s + Number(b.count || 0), 0);
    const ms = buckets.reduce((s, b) => s + Number(b.ms || 0), 0);
    return count ? Math.round(ms / count) : null;
  }

  async function snapshot() {
    const [events, sessions, locked, queue, avgMs] = await Promise.all([
      db('auth_logs')
        .where('occurred_at', '>', db.raw("now() - interval '60 seconds'"))
        .whereIn('event_type', ['login_success', 'login_failure', 'lockout'])
        .groupBy('event_type')
        .select('event_type', db.raw('count(*)::int AS n')),
      db('sessions').whereNull('revoked_at').where('expires_at', '>', db.fn.now()).count({ n: '*' }).first(),
      db('users').whereRaw('locked_until > now()').count({ n: '*' }).first(),
      waitingRoom.stats(),
      averageLoginMs(),
    ]);
    const perMinute = Object.fromEntries(events.map((e) => [e.event_type, Number(e.n)]));
    return {
      at: new Date(now()).toISOString(),
      signInsPerMin: perMinute.login_success || 0,
      failuresPerMin: perMinute.login_failure || 0,
      lockoutsPerMin: perMinute.lockout || 0,
      activeSessions: Number(sessions.n),
      lockedAccounts: Number(locked.n),
      queueLength: queue.queued,
      signInsInProgress: queue.inProgress,
      avgSignInMs: avgMs,
    };
  }

  return { snapshot, averageLoginMs };
}

module.exports = { createDashboard, createLoginTimer };
