'use strict';

const { keyedHash, randomToken } = require('./secrets');

// Atomically: if the ticket exists, add one attempt and return the new count.
// An attempt beyond the limit deletes the ticket and returns -1, exactly like
// a ticket that is already gone.
const ATTEMPT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
local n = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
if n > tonumber(ARGV[1]) then
  redis.call('DEL', KEYS[1])
  return -1
end
return n`;

// Atomically read and delete (single use). Returns the hash fields, or empty when gone.
const CONSUME_SCRIPT = `
local data = redis.call('HGETALL', KEYS[1])
if #data > 0 then redis.call('DEL', KEYS[1]) end
return data`;

/**
 * Short-lived tickets in Redis (shared by every app process).
 * The client holds a 256-bit random value; Redis stores only its keyed hash,
 * so reading Redis gives nothing usable. Each user's tickets are indexed so
 * they can all be revoked (after a password reset or change).
 */
function createTicketStore({ redis, hmacKey, kind, ttlSec }) {
  const keyFor = (token) => `cg:${kind}:${keyedHash(hmacKey, `ticket:${kind}`, token)}`;
  const userIndex = (userId) => `cg:${kind}:user:${userId}`;
  const valid = (token) => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
  const toObject = (pairs) => {
    const out = {};
    for (let i = 0; i < pairs.length; i += 2) out[pairs[i]] = pairs[i + 1];
    return out;
  };

  return {
    kind,
    ttlSec,

    async issue(data) {
      const token = randomToken(32);
      const key = keyFor(token);
      await redis
        .multi()
        .hset(key, { ...data, attempts: 0 })
        .expire(key, ttlSec)
        .sadd(userIndex(data.userId), key)
        .expire(userIndex(data.userId), ttlSec)
        .exec();
      return token;
    },

    async get(token) {
      if (!valid(token)) return null;
      const data = await redis.hgetall(keyFor(token));
      return Object.keys(data).length > 0 ? data : null;
    },

    /** Count one attempt; returns the count, or -1 if the ticket is gone (expired, used, or over the limit). */
    async attempt(token, maxAttempts) {
      if (!valid(token)) return -1;
      return Number(await redis.eval(ATTEMPT_SCRIPT, 1, keyFor(token), maxAttempts));
    },

    /** Single use: returns the data exactly once, then the ticket is gone. */
    async consume(token) {
      if (!valid(token)) return null;
      const data = toObject(await redis.eval(CONSUME_SCRIPT, 1, keyFor(token)));
      return Object.keys(data).length > 0 ? data : null;
    },

    /** Revoke every ticket of this kind for a user. */
    async revokeUser(userId) {
      const index = userIndex(userId);
      const keys = await redis.smembers(index);
      await redis.del(index, ...keys);
      return keys.length;
    },
  };
}

module.exports = { createTicketStore };
