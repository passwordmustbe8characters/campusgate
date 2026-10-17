'use strict';

/**
 * Simple shared counters in Redis (all app processes add to the same key).
 * The admin dashboard (Phase 6) will read these. Counting must never break
 * the request, so failures here are logged and ignored.
 */
function createMetrics({ redis, logger }) {
  const key = (name) => `cg:metrics:${name}`;
  return {
    async incr(name) {
      try {
        await redis.incr(key(name));
      } catch (err) {
        logger.warn({ event: 'metric_failed', metric: name, error: safeError(err) }, 'could not update metric');
      }
    },
    async get(name) {
      return Number((await redis.get(key(name))) || 0);
    },
  };
}

const EMAIL_PATTERN = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/g;

/** Error details safe to log: no email addresses (SMTP errors often quote the recipient). */
function safeError(err) {
  const scrub = (s) => (s ? String(s).replace(EMAIL_PATTERN, '[email]') : undefined);
  return {
    type: err && err.name,
    code: err && err.code,
    message: scrub(err && err.message),
    cause: err && err.cause ? { type: err.cause.name, code: err.cause.code, message: scrub(err.cause.message) } : undefined,
  };
}

module.exports = { createMetrics, safeError };
