'use strict';

const { loadConfig } = require('../app/src/config');
const { TEST_ENV } = require('./helpers');

describe('loadConfig', () => {
  test('applies defaults when optional values are missing', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x' });
    expect(config).toMatchObject({
      nodeEnv: 'development',
      port: 3000,
      logLevel: 'info',
      dbPoolMax: 10,
      uvThreadpoolSize: 4,
    });
  });

  test('reads UV_THREADPOOL_SIZE so it can be reported', () => {
    expect(loadConfig({ ...TEST_ENV, UV_THREADPOOL_SIZE: '16' }).uvThreadpoolSize).toBe(16);
  });

  test('fails fast and lists every missing required variable', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL is required[\s\S]*REDIS_URL is required/);
  });

  test.each([
    ['PORT', '0'],
    ['PORT', 'abc'],
    ['UV_THREADPOOL_SIZE', '0'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'loud'],
  ])('rejects invalid %s=%s', (name, value) => {
    expect(() => loadConfig({ ...TEST_ENV, [name]: value })).toThrow(name);
  });

  test('returns a frozen object', () => {
    expect(Object.isFrozen(loadConfig(TEST_ENV))).toBe(true);
  });
});
