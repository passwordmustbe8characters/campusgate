'use strict';

const { STATUS_CODES } = require('node:http');
const { safeError } = require('../services/metrics');

// Errors that mean "overloaded or a dependency is down", not "bug": answer 503.
//  - KnexTimeoutError: no free DB connection in time
//  - MaxRetriesPerRequestError / closed connection: Redis unreachable (2FA tickets need Redis)
//  - DeliveryError: the OTP/email driver failed or timed out
const UNAVAILABLE = new Set(['KnexTimeoutError', 'MaxRetriesPerRequestError', 'DeliveryError']);
const isUnavailable = (err) =>
  UNAVAILABLE.has(err.name) || err.message === 'Connection is closed.' || err.message === "Stream isn't writeable and enableOfflineQueue options is false";

/**
 * Last-resort error handler (NFR-8): logs the full error server-side and sends
 * the client only a generic message and a request id. Never a stack trace.
 * An error may carry `publicMessage` (written for users, no internals) and
 * `retryAfterSec` (sent as Retry-After).
 */
function errorHandler(logger) {
  // Express recognises error handlers by their four parameters, so `next` must stay.
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const raw = err.status || err.statusCode;
    let status = Number.isInteger(raw) && raw >= 400 && raw < 600 ? raw : 500;
    if (isUnavailable(err)) status = 503;
    const log = req.log || logger;

    // Delivery errors can quote the recipient's address: log the scrubbed form.
    const detail = err.name === 'DeliveryError' ? { error: safeError(err) } : { err };
    if (status >= 500) log.error(detail, 'unhandled error');
    else log.warn(detail, 'request error');

    if (res.headersSent) {
      res.end();
      return;
    }
    if (err.retryAfterSec) res.set('Retry-After', String(err.retryAfterSec));
    const message = err.publicMessage || STATUS_CODES[status] || 'Error';
    res.status(status).json({ error: message, requestId: req.id });
  };
}

module.exports = { errorHandler };
