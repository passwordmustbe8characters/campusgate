'use strict';

const { STATUS_CODES } = require('node:http');

/**
 * Last-resort error handler (NFR-8): logs the full error server-side and sends
 * the client only a generic message and a request id. Never a stack trace.
 */
function errorHandler(logger) {
  // Express recognises error handlers by their four parameters, so `next` must stay.
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const raw = err.status || err.statusCode;
    const status = Number.isInteger(raw) && raw >= 400 && raw < 600 ? raw : 500;
    const log = req.log || logger;

    if (status >= 500) log.error({ err }, 'unhandled error');
    else log.warn({ err }, 'request error');

    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(status).json({ error: STATUS_CODES[status] || 'Error', requestId: req.id });
  };
}

module.exports = { errorHandler };
