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
  'backupCodes',
  'totpSecret',
  'secret',
  'qrDataUrl',
  'otpauthUri',
  'resetToken',
  'resetUrl',
];

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...SECRET_FIELDS,
  ...SECRET_FIELDS.map((field) => `*.${field}`),
];

// PostgreSQL errors carry the offending values in `detail` (e.g. "Key (token_hash)=(...)
// already exists") and sometimes `where`; query bindings may appear as
// `parameters`/`bindings`. None of these are logged.
const DB_VALUE_FIELDS = ['detail', 'where', 'parameters', 'bindings', 'internalQuery'];

function errSerializer(err) {
  // pino-http passes custom serializers an already-serialized error object;
  // the base logger passes the Error itself. Handle both without re-wrapping.
  const out = err instanceof Error ? pino.stdSerializers.err(err) : err && typeof err === 'object' ? { ...err } : err;
  if (out && typeof out === 'object') for (const field of DB_VALUE_FIELDS) delete out[field];
  return out;
}

function createLogger({ level = 'info', destination } = {}) {
  return pino(
    {
      level,
      serializers: { err: errSerializer },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      base: { service: 'campusgate', pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}

module.exports = { createLogger, errSerializer, REDACT_PATHS };
