'use strict';

const { appendEvents, updateAnchor } = require('./chain');
const { STREAM, GROUP } = require('./queue');
const { safeError } = require('../services/metrics');

const CONSUMER = 'writer'; // exactly one writer (its own compose service)

/** Redis stream entry [id, [field, value, ...]] -> { id, event } */
function parseEntry([id, fields]) {
  const i = fields.indexOf('event');
  return { id, event: JSON.parse(fields[i + 1]) };
}

/** Age in ms of the oldest entry still in the stream (stream ids start with a ms timestamp). */
async function queueLagMs(redis, now = Date.now()) {
  const [oldest] = await redis.xrange(STREAM, '-', '+', 'COUNT', 1);
  return oldest ? Math.max(0, now - Number(oldest[0].split('-')[0])) : 0;
}

/**
 * The single audit writer (AUDIT_MODE=queue).
 *
 * Loop: read a batch (own pending entries first, then new ones) -> append to
 * the chain in ONE database transaction -> commit -> only then XACK + XDEL.
 * - Crash after commit but before ack: the entries are still pending; on
 *   restart they are re-read and appendEvents skips them by event_id. No loss,
 *   no duplicate.
 * - Database down: nothing is acked; entries stay in the stream and are retried.
 * - stop(): finishes the current batch, then drains the queue (up to a deadline).
 */
function createAuditWriter({ db, redis, key, logger, batchSize = 500, blockMs = 1000, hooks = {} }) {
  let stopping = false;
  let loop = null;
  const status = { lastTickAt: null, lastBatchAt: null, written: 0, lastError: null };

  async function ensureGroup() {
    try {
      // Read from the very beginning: events queued before the writer first started are kept.
      await redis.xgroup('CREATE', STREAM, GROUP, '0', 'MKSTREAM');
    } catch (err) {
      if (!String(err.message).includes('BUSYGROUP')) throw err;
    }
  }

  async function read(id, block) {
    const args = ['GROUP', GROUP, CONSUMER, 'COUNT', batchSize];
    if (block) args.push('BLOCK', block);
    args.push('STREAMS', STREAM, id);
    const result = await redis.xreadgroup(...args);
    return result ? result[0][1].map(parseEntry) : [];
  }

  async function writeBatch(entries) {
    if (entries.length === 0) return 0;
    const result = await db.transaction((trx) => appendEvents(trx, key, entries.map((e) => e.event)));
    if (hooks.afterCommit) await hooks.afterCommit(entries); // tests: simulate a crash here
    const ids = entries.map((e) => e.id);
    await redis.multi().xack(STREAM, GROUP, ...ids).xdel(STREAM, ...ids).exec();
    await updateAnchor(redis, result.head).catch(() => {});
    status.written += result.written;
    status.lastBatchAt = new Date().toISOString();
    await redis.incrby('cg:metrics:audit_written', result.written);
    return entries.length;
  }

  async function publishMetrics() {
    const [length, lag] = await Promise.all([redis.xlen(STREAM), queueLagMs(redis)]);
    await redis.multi()
      .set('cg:metrics:audit_queue_length', length)
      .set('cg:metrics:audit_queue_lag_ms', lag)
      .exec();
    return { length, lag };
  }

  /** One pass: pending (crash leftovers) first, then new entries. Returns how many entries were handled. */
  async function runOnce({ block = 0 } = {}) {
    await ensureGroup();
    let handled = 0;
    for (;;) {
      const pending = await read('0', 0);
      if (pending.length === 0) break;
      handled += await writeBatch(pending);
    }
    handled += await writeBatch(await read('>', block));
    status.lastTickAt = new Date().toISOString();
    await publishMetrics();
    return handled;
  }

  /** Run until stop(). Errors (e.g. database down) are logged and retried with backoff. */
  function start() {
    let backoff = 250;
    loop = (async () => {
      while (!stopping) {
        try {
          await runOnce({ block: blockMs });
          status.lastError = null;
          backoff = 250;
        } catch (err) {
          status.lastError = err.message;
          logger.error({ event: 'audit_writer_error', error: safeError(err) }, 'audit writer batch failed; will retry (nothing was acknowledged)');
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 5000);
        }
      }
    })();
    return loop;
  }

  /** Graceful stop: finish the current batch, then drain what is left (until empty or the deadline). */
  async function stop({ drainTimeoutMs = 20000 } = {}) {
    stopping = true;
    if (loop) await loop;
    const deadline = Date.now() + drainTimeoutMs;
    let remaining = await redis.xlen(STREAM);
    while (remaining > 0 && Date.now() < deadline) {
      await runOnce();
      remaining = await redis.xlen(STREAM);
    }
    logger.info({ event: 'audit_writer_stopped', remaining, written: status.written }, 'audit writer stopped');
    return { remaining };
  }

  return { start, stop, runOnce, publishMetrics, status, ensureGroup };
}

module.exports = { createAuditWriter, queueLagMs, CONSUMER };
