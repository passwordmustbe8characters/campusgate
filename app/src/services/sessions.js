'use strict';

const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');

const ISSUER = 'campusgate';
const AUDIENCE = 'campusgate';
const SCOPES = ['full', 'enrol'];
// A revoked jti stays on the denylist a little past the token's expiry (clock slack).
const DENYLIST_SLACK_MS = 5000;

const denylistKey = (jti) => `cg:revoked:${jti}`;
const truncate = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);

/**
 * Put sessions on the Redis denylist (until they would expire anyway), then
 * mark them revoked in PostgreSQL. Redis first: the token must stop working
 * even if the database update fails. Re-running is harmless.
 */
async function denyAll(db, redis, rows, reason) {
  if (rows.length === 0) return 0;
  const now = Date.now();
  const pipeline = redis.multi();
  for (const row of rows) {
    const ttlMs = Math.max(1000, new Date(row.expires_at).getTime() - now + DENYLIST_SLACK_MS);
    pipeline.set(denylistKey(row.jti), reason, 'PX', ttlMs);
  }
  const results = await pipeline.exec();
  const failed = results && results.find(([err]) => err);
  if (failed) throw failed[0];
  // Count only the sessions this call ended (already-revoked ones were just re-listed).
  return db('sessions')
    .whereIn('jti', rows.map((r) => r.jti))
    .whereNull('revoked_at')
    .update({ revoked_at: db.fn.now(), revoke_reason: reason });
}

/**
 * Revoke every live session of a user (sign out everywhere, password reset or
 * change, role change, 2FA reset). Needs no signing key, so CLI tools use it.
 * Returns the number of sessions revoked.
 */
async function revokeUserSessions({ db, redis }, userId, reason) {
  const rows = await db('sessions')
    .where({ user_id: userId })
    .where('expires_at', '>', db.fn.now())
    .select('jti', 'expires_at');
  // Already-revoked rows are re-added too, in case an earlier Redis write failed.
  return denyAll(db, redis, rows, reason);
}

/**
 * Login-once session (FR-P1): a short-lived HS256 JWT in an HttpOnly cookie.
 * Checking a request needs the signature, the expiry and ONE Redis lookup of
 * the jti denylist (FR-P6); no database read. Each token also gets a row in
 * `sessions` (FR-L2) so it can be listed and revoked.
 */
function createSessionService({ db, redis, jwtSecret }) {
  /** Issue a token; `ttlMin` comes from policies.session_timeout_min. */
  async function issue({ userId, role, scope = 'full', ttlMin, ip, userAgent, level = null, faculty = null, services = null }) {
    if (!SCOPES.includes(scope)) throw new Error(`unknown session scope ${scope}`);
    const jti = randomUUID();
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = new Date((issuedAt + ttlMin * 60) * 1000);
    await db('sessions').insert({
      user_id: userId,
      jti,
      scope,
      ip: truncate(ip, 64),
      user_agent: truncate(userAgent, 256),
      created_at: new Date(issuedAt * 1000),
      expires_at: expiresAt,
    });
    // lvl/fac: for access windows (FR-Z2); svc: a guest voucher's services (FR-Z4).
    // All checked without a database read.
    const extra = {};
    if (level !== null && level !== undefined) extra.lvl = Number(level);
    if (faculty) extra.fac = String(faculty);
    if (Array.isArray(services)) extra.svc = services.map(String);
    const token = jwt.sign(
      { sub: String(userId), role, scope, iat: issuedAt, ...extra },
      jwtSecret,
      { algorithm: 'HS256', expiresIn: ttlMin * 60, jwtid: jti, issuer: ISSUER, audience: AUDIENCE },
    );
    return { token, jti, expiresAt, maxAgeMs: ttlMin * 60 * 1000 };
  }

  /**
   * Check signature, algorithm, issuer, audience and expiry. Returns the
   * session claims, or null for any invalid, expired or malformed token.
   * Does not check revocation (see isRevoked).
   */
  function verify(token) {
    if (typeof token !== 'string' || token.length > 2048) return null;
    let claims;
    try {
      claims = jwt.verify(token, jwtSecret, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
    } catch {
      return null;
    }
    const userId = Number(claims.sub);
    if (!Number.isSafeInteger(userId) || userId <= 0) return null;
    if (typeof claims.role !== 'string' || !SCOPES.includes(claims.scope) || typeof claims.jti !== 'string') return null;
    return {
      userId,
      role: claims.role,
      scope: claims.scope,
      jti: claims.jti,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
      level: Number.isInteger(claims.lvl) ? claims.lvl : null,
      faculty: typeof claims.fac === 'string' ? claims.fac : null,
      services: Array.isArray(claims.svc) ? claims.svc.filter((s) => typeof s === 'string') : null,
    };
  }

  /** One Redis lookup. Throws if Redis is unreachable (callers fail closed). */
  async function isRevoked(jti) {
    return (await redis.exists(denylistKey(jti))) === 1;
  }

  /** Revoke one session (sign out). Returns true if it was live. */
  async function revoke(jti, reason) {
    const row = await db('sessions').where({ jti }).first('jti', 'expires_at');
    if (!row) return false;
    return (await denyAll(db, redis, [row], reason)) === 1;
  }

  /**
   * Concurrent-session limit (FR-Z3): before a new sign-in, end this user's
   * OLDEST live sessions so that, with the new one, at most `max` remain.
   * Returns how many were ended.
   */
  async function makeRoomFor(userId, max, reason = 'session_limit') {
    const live = await db('sessions').where({ user_id: userId }).whereNull('revoked_at')
      .where('expires_at', '>', db.fn.now()).orderBy('created_at').orderBy('id').select('jti', 'expires_at');
    const excess = live.length - (max - 1);
    if (excess <= 0) return 0;
    return denyAll(db, redis, live.slice(0, excess), reason);
  }

  return {
    issue,
    verify,
    isRevoked,
    revoke,
    makeRoomFor,
    revokeUser: (userId, reason) => revokeUserSessions({ db, redis }, userId, reason),
  };
}

module.exports = { createSessionService, revokeUserSessions, denylistKey, ISSUER, AUDIENCE };
