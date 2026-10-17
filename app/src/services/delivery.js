'use strict';

const nodemailer = require('nodemailer');

/**
 * Message delivery interface (FR-A14). Every driver has the same shape:
 *   driver.name                        'console' | 'email' | 'sms-mock'
 *   driver.send({ email, matric, subject, text })  -> Promise
 * `email` is used by the email driver, `matric` by sms-mock (no phone numbers
 * are stored: NFR-5 data minimisation). Callers never log message bodies.
 */

class DeliveryError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'DeliveryError';
    this.status = 503;
    this.cause = cause;
    this.publicMessage = "We couldn't send your code right now. Please try again.";
  }
}

/** Development/test only (refused in production by config). Writes to stdout, never through pino. */
function consoleDriver(stream = process.stdout) {
  return {
    name: 'console',
    async send({ email, matric, subject, text }) {
      stream.write(
        `\n----- [DEV ONLY] console delivery -----\nTo: ${email || matric}\nSubject: ${subject}\n\n${text}\n---------------------------------------\n`,
      );
    },
  };
}

function emailDriver(config) {
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    connectionTimeout: config.deliveryTimeoutMs,
    greetingTimeout: config.deliveryTimeoutMs,
    socketTimeout: config.deliveryTimeoutMs,
  });
  return {
    name: 'email',
    async send({ email, subject, text }) {
      await transport.sendMail({ from: config.mailFrom, to: email, subject, text });
    },
    close: () => transport.close(),
  };
}

/**
 * Pretend SMS gateway: appends the message to a capped Redis list keyed by
 * matric number, so demos and tests can read it. Mock only.
 */
function smsMockDriver(redis) {
  return {
    name: 'sms-mock',
    async send({ matric, text }) {
      await redis
        .multi()
        .lpush('cg:sms-mock:outbox', JSON.stringify({ to: matric, text, at: new Date().toISOString() }))
        .ltrim('cg:sms-mock:outbox', 0, 199)
        .exec();
    },
  };
}

/** Wrap a driver so every send has a timeout and fails as a DeliveryError (503, never counted). */
function withTimeout(driver, timeoutMs) {
  return {
    ...driver,
    async send(message) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`delivery timed out after ${timeoutMs} ms`)), timeoutMs);
      });
      try {
        await Promise.race([driver.send(message), timeout]);
      } catch (err) {
        throw new DeliveryError(`${driver.name} delivery failed`, err);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function createDelivery(config, { redis }) {
  const drivers = {
    console: () => consoleDriver(),
    email: () => emailDriver(config),
    'sms-mock': () => smsMockDriver(redis),
  };
  return withTimeout(drivers[config.otpDeliveryDriver](), config.deliveryTimeoutMs);
}

module.exports = { createDelivery, withTimeout, consoleDriver, emailDriver, smsMockDriver, DeliveryError };
