'use strict';

const { Writable } = require('node:stream');
const { withTimeout, consoleDriver, DeliveryError } = require('../../app/src/services/delivery');

describe('delivery interface (FR-A14)', () => {
  test('a driver that hangs fails as DeliveryError (503) after the timeout', async () => {
    const hanging = withTimeout({ name: 'email', send: () => new Promise(() => {}) }, 100);
    const started = Date.now();
    await expect(hanging.send({ email: 'a@b.co', subject: 's', text: 't' })).rejects.toBeInstanceOf(DeliveryError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('a driver error becomes DeliveryError with a safe public message and the cause kept', async () => {
    const failing = withTimeout({ name: 'email', send: async () => { throw new Error('ECONNREFUSED 127.0.0.1:1025'); } }, 1000);
    const err = await failing.send({}).catch((e) => e);
    expect(err).toBeInstanceOf(DeliveryError);
    expect(err.status).toBe(503);
    expect(err.publicMessage).not.toMatch(/ECONNREFUSED/);
    expect(err.cause.message).toMatch(/ECONNREFUSED/);
  });

  test('console driver writes the message to its stream (stdout), not to the app logger', async () => {
    let out = '';
    const stream = new Writable({ write(chunk, enc, cb) { out += chunk; cb(); } });
    await consoleDriver(stream).send({ email: 'a@b.co', subject: 'Code', text: 'Your code is 123456' });
    expect(out).toContain('[DEV ONLY] console delivery');
    expect(out).toContain('123456');
  });

  test('driver keeps its name through the timeout wrapper', () => {
    expect(withTimeout({ name: 'sms-mock', send: async () => {} }, 10).name).toBe('sms-mock');
  });
});
