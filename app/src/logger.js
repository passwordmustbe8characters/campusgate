'use strict';

const pino = require('pino');

// Never let credentials, OTPs, tokens, or secrets reach the logs.
// Paths cover top-level fields and one level of nesting (e.g. { body: { password } }).
// Request fields carrying OTPs must use one of these names; a generic `code` is
// deliberately not redacted because it would hide error codes like ECONNREFUSED.
const SECRET_FIELDS = [
  'password',
  'newPassword',
  'currentPassword',
  'confirmPassword',
  'otp',
  'otpCode',
  'totpCode',
  'token',
  'backupCode',
  'totpSecret',
  'secret',
];

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...SECRET_FIELDS,
  ...SECRET_FIELDS.map((field) => `*.${field}`),
];

function createLogger({ level = 'info', destination } = {}) {
  return pino(
    {
      level,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      base: { service: 'campusgate', pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}

module.exports = { createLogger, REDACT_PATHS };
