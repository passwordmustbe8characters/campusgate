'use strict';

const crypto = require('node:crypto');

// Redis keys (shared by every app process).
const K = {
  seq: 'cg:wr:seq', // ticket counter (FIFO order)
  queue: 'cg:wr:queue', // ZSET ticket id -> sequence number
  seen: 'cg:wr:seen', // ZSET ticket id -> last poll time (ms)
  active: 'cg:wr:active', // ZSET pass id -> expiry (ms): sign-ins in progress
  ready: (id) => `cg:wr:ready:${id}`, // admitted, not yet claimed by the browser
  tick: 'cg:wr:tick', // one batch per interval across all processes
};

// Drop expired passes and tickets whose browser stopped polling. Shared by every script.
const CLEAN = `
local now = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now)
local stale = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now - tonumber(ARGV[2]))
for _, id in ipairs(stale) do
  redis.call('ZREM', KEYS[2], id)
  redis.call('ZREM', KEYS[3], id)
end`;

// Enter directly if nobody is waiting and there is capacity (FIFO: never jump the queue).
const ENTER = `${CLEAN}
if redis.call('ZCARD', KEYS[2]) == 0 and redis.call('ZCARD', KEYS[4]) < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[4], now + tonumber(ARGV[4]), ARGV[5])
  return 1
end
return 0`;

// Admit up to `batch` tickets from the head of the queue, within capacity.
// An admitted ticket holds a place (counted as active) for the claim window.
const ADMIT = `${CLEAN}
local free = tonumber(ARGV[3]) - redis.call('ZCARD', KEYS[4])
local n = math.min(tonumber(ARGV[6]), free)
if n <= 0 then return 0 end
local ids = redis.call('ZRANGE', KEYS[2], 0, n - 1)
for _, id in ipairs(ids) do
  redis.call('ZREM', KEYS[2], id)
  redis.call('ZREM', KEYS[3], id)
  redis.call('ZADD', KEYS[4], now + tonumber(ARGV[7]), id)
  redis.call('SET', 'cg:wr:ready:' .. id, '1', 'PX', tonumber(ARGV[7]))
end
return #ids`;

// Browser polls: admitted -> turn the reserved place into a sign-in pass;
// waiting -> heartbeat and position; otherwise the ticket is gone (expired).
const STATUS = `${CLEAN}
local id = ARGV[5]
if redis.call('DEL', 'cg:wr:ready:' .. id) == 1 then
  redis.call('ZADD', KEYS[4], now + tonumber(ARGV[4]), id)
  return -1
end
local rank = redis.call('ZRANK', KEYS[2], id)
if not rank then return -2 end
redis.call('ZADD', KEYS[3], now, id)
return rank + 1`;

/**
 * Waiting room / admission control (FR-P2, FR-P3).
 *
 * "Sign-ins in progress" = live admission passes in cg:wr:active. A sign-in
 * may start only with a pass. While passes < queue_capacity and nobody is
 * waiting, a pass is given at once; otherwise the visitor gets a signed
 * ticket and joins a first-in, first-out queue. Every queue_interval_sec, one
 * process (whichever wins cg:wr:tick) admits up to queue_batch tickets. A
 * ticket that is not polled for ticketTimeoutSec is dropped; a pass ends when
 * the sign-in completes, or after passTtlSec.
 *
 * Tickets and passes are random ids, sent to the browser with an HMAC
 * signature, so they cannot be forged or guessed.
 */
function createWaitingRoom({ redis, hmacKey, passTtlSec = 120, ticketTimeoutSec = 30, claimSec = 30, now = () => Date.now() }) {
  const sign = (id) => `${id}.${crypto.createHmac('sha256', hmacKey).update(`waiting-room:${id}`).digest('base64url')}`;
  function unsign(value) {
    if (typeof value !== 'string' || value.length > 128) return null;
    const [id, sig] = value.split('.');
    if (!id || !sig || !/^[A-Za-z0-9_-]{22}$/.test(id)) return null;
    const expected = sign(id).split('.')[1];
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? id : null;
  }
  const newId = () => crypto.randomBytes(16).toString('base64url');
  const keys = [K.seq, K.queue, K.seen, K.active];
  const base = (capacity) => [now(), ticketTimeoutSec * 1000, capacity, passTtlSec * 1000];

  /** Take a sign-in pass at once if nobody is waiting and there is room. Returns the signed pass or null. */
  async function tryEnter(policy) {
    const id = newId();
    const ok = await redis.eval(ENTER, keys.length, ...keys, ...base(policy.queue_capacity), id);
    return Number(ok) === 1 ? sign(id) : null;
  }

  /** Join the queue; returns the signed ticket and its position. */
  async function join(policy) {
    const id = newId();
    const seq = await redis.incr(K.seq);
    await redis.multi().zadd(K.queue, seq, id).zadd(K.seen, now(), id).exec();
    const position = Number(await redis.zrank(K.queue, id)) + 1;
    return { ticket: sign(id), position, etaSec: eta(position, policy) };
  }

  /**
   * Poll a ticket. Returns { state: 'admitted', pass } | { state: 'waiting', position, etaSec }
   * | { state: 'expired' }. Invalid signatures are 'expired'.
   */
  async function status(ticket, policy) {
    const id = unsign(ticket);
    if (!id) return { state: 'expired' };
    const r = Number(await redis.eval(STATUS, keys.length, ...keys, ...base(policy.queue_capacity), id));
    if (r === -1) return { state: 'admitted', pass: sign(id) };
    if (r === -2) return { state: 'expired' };
    return { state: 'waiting', position: r, etaSec: eta(r, policy) };
  }

  /** Is this signed pass live (a sign-in in progress)? */
  async function hasPass(pass) {
    const id = unsign(pass);
    if (!id) return false;
    const expiry = await redis.zscore(K.active, id);
    return expiry !== null && Number(expiry) > now();
  }

  /** The sign-in finished: free its place. */
  async function release(pass) {
    const id = unsign(pass);
    if (id) await redis.zrem(K.active, id);
  }

  /** Admit the next batch (normally called by the admitter). Returns how many were admitted. */
  async function admitBatch(policy) {
    return Number(await redis.eval(ADMIT, keys.length, ...keys, ...base(policy.queue_capacity), '', policy.queue_batch, claimSec * 1000));
  }

  /**
   * Run the admitter in this process: every second, try to win this interval's
   * slot (SET NX PX interval); the winner admits one batch. With several app
   * processes, exactly one admits per interval.
   */
  function startAdmitter({ getPolicy, logger }) {
    const timer = setInterval(async () => {
      try {
        const policy = await getPolicy();
        if (!policy.queue_enabled) return;
        const won = await redis.set(K.tick, '1', 'PX', policy.queue_interval_sec * 1000, 'NX');
        if (won !== 'OK') return;
        const admitted = await admitBatch(policy);
        if (admitted > 0) logger.info({ event: 'waiting_room_admitted', admitted }, 'waiting room batch admitted');
      } catch (err) {
        logger.warn({ event: 'waiting_room_admitter_error', err }, 'waiting room admitter error');
      }
    }, 1000);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** Queue length and sign-ins in progress (for the dashboard, Phase 6). */
  async function stats() {
    const t = now();
    const [queued, inProgress] = await Promise.all([redis.zcard(K.queue), redis.zcount(K.active, t, '+inf')]);
    return { queued: Number(queued), inProgress: Number(inProgress) };
  }

  return { tryEnter, join, status, hasPass, release, admitBatch, startAdmitter, stats, sign, unsign };
}

/** Estimated wait: whole batches ahead of you, one interval each. */
function eta(position, policy) {
  return Math.ceil(position / policy.queue_batch) * policy.queue_interval_sec;
}

module.exports = { createWaitingRoom, eta, KEYS: K };
