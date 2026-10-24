'use strict';

/**
 * Audit queue (AUDIT_MODE=queue): a Redis Stream between the login path and the
 * single audit writer.
 *
 * Why a Redis Stream: Redis is already on the 2FA login path, XADD costs about
 * a tenth of a millisecond, entries persist with AOF, and consumer groups give
 * exactly what the writer needs: a per-consumer pending list, so an entry is
 * only removed after the writer has committed it to PostgreSQL (XACK after
 * commit) and is re-read after a crash. A plain Redis list (LPUSH/BRPOP) would
 * lose the event if the writer crashed between popping and committing.
 */
const STREAM = 'cg:audit:stream';
const GROUP = 'audit-writers';

// Never block a login: if the queue is full, count the drop and return 0.
const ENQUEUE_SCRIPT = `
if redis.call('XLEN', KEYS[1]) >= tonumber(ARGV[1]) then
  redis.call('INCR', KEYS[2])
  return 0
end
redis.call('XADD', KEYS[1], '*', 'event', ARGV[2])
return 1`;

class AuditQueueFullError extends Error {
  constructor(max) {
    super(`audit queue is full (${max} events); event dropped`);
    this.name = 'AuditQueueFullError';
  }
}

function createAuditQueue({ redis, maxLength }) {
  return {
    name: 'queue',
    stream: STREAM,
    /** Add one event; throws AuditQueueFullError when the queue is full (the caller falls back). */
    async enqueue(event) {
      const added = await redis.eval(ENQUEUE_SCRIPT, 2, STREAM, 'cg:metrics:audit_dropped', maxLength, JSON.stringify(event));
      if (Number(added) !== 1) throw new AuditQueueFullError(maxLength);
    },
    length: () => redis.xlen(STREAM),
  };
}

module.exports = { createAuditQueue, AuditQueueFullError, STREAM, GROUP };
