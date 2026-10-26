'use strict';

const { loadConfig } = require('../../app/src/config');
const { createLogger } = require('../../app/src/logger');
const { createApp } = require('../../app/src/app');

const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  HEALTH_CHECK_TIMEOUT_MS: '100',
  CSRF_SECRET: 'unit-test-csrf-secret-0123456789abcdef',
  BCRYPT_COST: '4',
  TOKEN_HMAC_KEY: Buffer.alloc(32, 1).toString('base64url'),
  TOTP_ENC_KEY: Buffer.alloc(32, 2).toString('base64url'),
  AUDIT_HMAC_KEY: Buffer.alloc(32, 3).toString('base64url'),
  JWT_SECRET: Buffer.alloc(32, 4).toString('base64url'),
  OTP_DELIVERY_DRIVER: 'console',
};

const healthyDb = () => ({ raw: async () => ({ rows: [{ '?column?': 1 }] }) });
const healthyRedis = () => ({ ping: async () => 'PONG' });

/** App wired to in-memory fakes, so tests run without PostgreSQL or Redis. */
function buildTestApp({ db = healthyDb(), redis = healthyRedis(), env = {} } = {}) {
  const config = loadConfig({ ...TEST_ENV, ...env });
  const logger = createLogger({ level: 'silent' });
  return createApp({ config, logger, db, redis });
}

module.exports = { TEST_ENV, buildTestApp, healthyDb, healthyRedis };
