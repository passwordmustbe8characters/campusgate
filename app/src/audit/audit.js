'use strict';

const { appendEvents, updateAnchor } = require('./chain');
const { buildEvent, isCritical, AuditEventError } = require('./events');
const { safeError } = require('../services/metrics');

/** A fail-closed audit write failed, so the change was refused (503, never a 500). */
class AuditUnavailableError extends Error {
  constructor(cause) {
    super('critical audit event could not be written');
    this.name = 'AuditUnavailableError';
    this.status = 503;
    this.cause = cause;
    this.publicMessage = "This change can't be recorded in the audit log right now, so it was not made. Please try again later.";
  }
}

/**
 * Audit log service (FR-L1, FR-L3).
 *
 * record(type, fields, ctx)            high-volume events: FAIL OPEN.
 *   Never throws. If the event cannot be written, it is logged as a marked
 *   fallback line ({ auditFallback: true, auditEvent }) and counted
 *   (cg:metrics:audit_fallback), so the action still proceeds.
 *
 * recordCritical(trx, type, fields, ctx)  account-security changes and admin
 *   actions: FAIL CLOSED. Written into the chain inside the caller's
 *   transaction, so the change and its audit row commit together or not at
 *   all. If writing fails, it throws and the caller's change rolls back.
 *
 * Sync mode (this file): record() appends to the chain directly, so the login
 * path waits on the chain lock. Queue mode (Phase 3.3) replaces record() with a
 * Redis Stream append; recordCritical() stays synchronous in both modes.
 */
function createAudit({ db, redis, config, logger, metrics, writer }) {
  const key = config.auditHmacKey;
  const subjectKey = config.tokenHmacKey || config.auditHmacKey;

  const moveAnchor = (head) =>
    updateAnchor(redis, head).catch((err) =>
      logger.warn({ event: 'audit_anchor_failed', error: safeError(err) }, 'could not update audit anchor'));

  async function writeNow(events) {
    const result = await db.transaction((trx) => appendEvents(trx, key, events));
    await moveAnchor(result.head);
    return result;
  }

  /** Marked fallback line: `npm run audit -- import-fallback` can bring these into the chain later. */
  async function fallback(event, err, log) {
    log.error(
      { auditFallback: true, auditEvent: event, error: safeError(err) },
      'AUDIT_FALLBACK: audit event could not be queued or written',
    );
    await metrics.incr('audit_fallback');
  }

  // `writer` (queue mode) or direct chain append (sync mode).
  const deliver = writer ? (event) => writer.enqueue(event) : (event) => writeNow([event]);

  async function record(type, fields, ctx = {}) {
    const log = ctx.log || logger;
    if (isCritical(type)) {
      // Programming error: a critical event must go through recordCritical.
      throw new AuditEventError(`audit event "${type}" is critical; use recordCritical`);
    }
    let event;
    try {
      event = buildEvent(type, fields, ctx, subjectKey);
    } catch (err) {
      log.error({ event: 'audit_event_invalid', auditType: type, error: safeError(err) }, 'invalid audit event (bug)');
      await metrics.incr('audit_invalid');
      return null;
    }
    try {
      await deliver(event, log);
    } catch (err) {
      await fallback(event, err, log);
    }
    return event;
  }

  async function recordCritical(trx, type, fields, ctx = {}) {
    if (!isCritical(type)) throw new AuditEventError(`audit event "${type}" is not critical; use record`);
    const event = buildEvent(type, fields, ctx, subjectKey);
    let result;
    try {
      result = await appendEvents(trx, key, [event]);
    } catch (err) {
      (ctx.log || logger).error({ event: 'audit_critical_failed', auditType: type, error: safeError(err) }, 'critical audit write failed; change refused');
      await metrics.incr('audit_critical_failures');
      throw new AuditUnavailableError(err); // the caller's transaction rolls back: fail closed
    }
    // Move the outside anchor only once the change has really committed.
    trx.executionPromise.then(() => moveAnchor(result.head), () => {});
    return event;
  }

  /** For CLI tools that change one thing: run `change(trx)` and its critical audit event atomically. */
  async function withCritical(type, fields, ctx, change) {
    return db.transaction(async (trx) => {
      const result = await change(trx);
      const resolved = typeof fields === 'function' ? fields(result) : fields;
      if (resolved) await recordCritical(trx, type, resolved, ctx);
      return result;
    });
  }

  return { record, recordCritical, withCritical, writeNow, mode: writer ? 'queue' : 'sync' };
}

/** Request context for audit events (IP and user agent; the logger for fallbacks). */
function auditContext(req) {
  return { log: req.log, ip: req.ip, userAgent: req.get('user-agent') };
}

module.exports = { createAudit, auditContext, AuditUnavailableError };
