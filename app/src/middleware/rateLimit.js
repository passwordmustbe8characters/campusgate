'use strict';

const { keyedHash } = require('../services/secrets');
const { normalizeId, normalizeEmail, looksLikeEmail } = require('../services/identity');

// Fixed window, atomic: the first hit in a window starts its expiry.
// Returns { count, msLeft } for this key.
const HIT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {n, ttl}`;

/** The account a request is about (identifier, email or matric number), normalized; null if none. */
function accountOf(req) {
  const b = req.body || {};
  const raw = [b.identifier, b.email, b.matricNo].find((v) => typeof v === 'string' && v.trim() !== '');
  if (!raw) return null;
  return looksLikeEmail(raw) ? normalizeEmail(raw) : normalizeId(raw);
}

/**
 * Rate limiting per IP and per account (FR-P4), shared by every app process
 * through Redis. Over the limit: 429 with Retry-After. The request never
 * reaches the sign-in logic, so it can never count toward lockout (FR-P5).
 *
 * Account keys are stored as a keyed hash, never the typed identifier.
 * If Redis is unreachable the limiter lets the request through (fail open)
 * and logs it: temporary lockout still stops password guessing, and a Redis
 * outage must not stop every sign-in.
 */
function createRateLimiter({ redis, hmacKey, perIpPerMin, perAccountPerMin, windowSec = 60, metrics, simulator = null }) {
  const windowMs = windowSec * 1000;

  async function hit(key) {
    const [count, msLeft] = await redis.eval(HIT_SCRIPT, 1, key, windowMs);
    return { count: Number(count), msLeft: Number(msLeft) };
  }

  /** Middleware for one route group ("scope"); `byAccount` adds the per-account limit. */
  function limit(scope, { byAccount = false } = {}) {
    const middleware = async (req, res, next) => {
      // The admin rush-hour simulation (non-production only) sends a one-time token: all its virtual
      // students share one IP, so its requests skip the per-IP limit. Per-account limits still apply.
      const simHeader = req.get('x-campusgate-simulation');
      const simulated = Boolean(simHeader && simulator && (await simulator.isRunToken(simHeader).catch(() => false)));
      const checks = simulated ? [] : [{ kind: 'ip', key: `cg:rl:${scope}:ip:${req.ip}`, max: perIpPerMin }];
      const account = byAccount ? accountOf(req) : null;
      if (account) {
        checks.push({ kind: 'account', key: `cg:rl:${scope}:acct:${keyedHash(hmacKey, 'ratelimit', account)}`, max: perAccountPerMin });
      }
      if (checks.length === 0) return next();
      let results;
      try {
        results = await Promise.all(checks.map((c) => hit(c.key)));
      } catch (err) {
        req.log.warn({ event: 'rate_limit_unavailable', scope, err }, 'rate limiter unavailable; request allowed');
        return next();
      }
      const over = checks.map((c, i) => ({ ...c, ...results[i] })).filter((c) => c.count > c.max);
      if (over.length === 0) return next();
      const retryAfterSec = Math.max(1, Math.ceil(Math.max(...over.map((c) => c.msLeft)) / 1000));
      req.log.info({ event: 'rate_limited', scope, by: over.map((c) => c.kind) }, 'rate limited');
      if (metrics) metrics.incr('rate_limited').catch(() => {});
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: `Too many attempts. Please wait ${retryAfterSec} s and try again.`, retryAfterSec });
    };
    middleware.rateLimitScope = scope;
    return middleware;
  }

  return { limit };
}

module.exports = { createRateLimiter, accountOf };
