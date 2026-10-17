'use strict';

const { Writable } = require('node:stream');
const { createLogger } = require('../../app/src/logger');

function captureLogger() {
  const lines = [];
  const destination = new Writable({
    write(chunk, encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { logger: createLogger({ level: 'info', destination }), lines };
}

describe('logger redaction (never log secrets)', () => {
  test('redacts passwords, OTPs, tokens, and TOTP secrets at top level and nested', () => {
    const { logger, lines } = captureLogger();
    logger.info({
      password: 'Hunter2!pass',
      otp: '123456',
      otpCode: '654321',
      body: { newPassword: 'N3w!pass', token: 'reset-token-abc', totpSecret: 'JBSWY3DPEHPK3PXP' },
    }, 'test');

    const output = lines.join('');
    for (const secret of ['Hunter2!pass', '123456', '654321','N3w!pass', 'reset-token-abc', 'JBSWY3DPEHPK3PXP']) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('[REDACTED]');
  });

  test('redacts cookies and authorization headers on requests', () => {
    const { logger, lines } = captureLogger();
    logger.info({ req: { headers: { cookie: 'session=abc.def', authorization: 'Bearer xyz' } } }, 'req');

    const output = lines.join('');
    expect(output).not.toContain('abc.def');
    expect(output).not.toContain('Bearer xyz');
  });

  test('drops database values from errors (pg detail, bindings), on the app logger and on request loggers', async () => {
    const express = require('express');
    const request = require('supertest');
    const pinoHttp = require('pino-http');
    const { errSerializer } = require('../../app/src/logger');
    const { errorHandler } = require('../../app/src/middleware/errorHandler');

    const { logger, lines } = captureLogger();
    const pgError = () => Object.assign(new Error('insert into "password_reset_tokens" ... - duplicate key value'), {
      code: '23505',
      detail: 'Key (token_hash)=(SECRET-HASH-VALUE) already exists.',
      where: 'SQL function SECRET-WHERE',
      bindings: ['SECRET-BINDING'],
      parameters: ['SECRET-PARAM'],
    });
    logger.error({ err: pgError() }, 'direct');

    const app = express();
    app.use(pinoHttp({ logger, serializers: { err: errSerializer } }));
    app.get('/x', async () => { throw pgError(); });
    app.use(errorHandler(logger));
    await request(app).get('/x');

    const output = lines.join('');
    expect(output).toContain('23505'); // still useful for debugging
    // The error type survives both paths (pino-http hands serializers an already-serialized object).
    // (direct log, error handler, and pino-http's own "request errored" line)
    const types = lines.map((l) => JSON.parse(l)).filter((l) => l.err).map((l) => l.err.type);
    expect(types.length).toBeGreaterThanOrEqual(2);
    expect(types.every((t) => t === 'Error')).toBe(true);
    for (const secret of ['SECRET-HASH-VALUE', 'SECRET-WHERE', 'SECRET-BINDING', 'SECRET-PARAM']) {
      expect(output).not.toContain(secret);
    }
  });

  test('keeps error codes such as ECONNREFUSED readable', () => {
    const { logger, lines } = captureLogger();
    const err = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
    logger.warn({ err }, 'redis down');

    expect(lines.join('')).toContain('ECONNREFUSED');
  });
});
