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

  test('keeps error codes such as ECONNREFUSED readable', () => {
    const { logger, lines } = captureLogger();
    const err = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
    logger.warn({ err }, 'redis down');

    expect(lines.join('')).toContain('ECONNREFUSED');
  });
});
