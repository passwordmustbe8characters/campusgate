'use strict';

const { loadConfig, loadSeedConfig } = require('../../app/src/config');
const { TEST_ENV } = require('./helpers');

const MINIMAL = {
  DATABASE_URL: 'postgres://x',
  REDIS_URL: 'redis://x',
  CSRF_SECRET: 'x'.repeat(32),
};

describe('loadConfig', () => {
  test('applies defaults when optional values are missing', () => {
    const config = loadConfig(MINIMAL);
    expect(config).toMatchObject({
      nodeEnv: 'development',
      port: 3000,
      logLevel: 'info',
      dbPoolMax: 10,
      uvThreadpoolSize: 4,
      bcryptCost: 10,
      cookieSecure: false,
    });
  });

  test('reads UV_THREADPOOL_SIZE so it can be reported', () => {
    expect(loadConfig({ ...TEST_ENV, UV_THREADPOOL_SIZE: '16' }).uvThreadpoolSize).toBe(16);
  });

  test('fails fast and lists every missing required variable', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL is required[\s\S]*REDIS_URL is required[\s\S]*CSRF_SECRET is required/);
  });

  test.each([
    ['PORT', '0'],
    ['PORT', 'abc'],
    ['UV_THREADPOOL_SIZE', '0'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'loud'],
    ['COOKIE_SECURE', 'yes'],
    ['CSRF_SECRET', 'too-short'],
  ])('rejects invalid %s=%s', (name, value) => {
    expect(() => loadConfig({ ...TEST_ENV, [name]: value })).toThrow(name);
  });

  test('returns a frozen object', () => {
    expect(Object.isFrozen(loadConfig(TEST_ENV))).toBe(true);
  });

  test('secure cookies default on in production', () => {
    expect(loadConfig({ ...MINIMAL, NODE_ENV: 'production' }).cookieSecure).toBe(true);
  });
});

describe('BCRYPT_COST (FR-A4)', () => {
  test.each(['development', 'production'])('refuses a cost below 10 when NODE_ENV=%s', (nodeEnv) => {
    expect(() => loadConfig({ ...MINIMAL, NODE_ENV: nodeEnv, BCRYPT_COST: '9' })).toThrow(/BCRYPT_COST/);
    expect(() => loadConfig({ ...MINIMAL, NODE_ENV: nodeEnv, BCRYPT_COST: '4' })).toThrow(/BCRYPT_COST/);
  });

  test('accepts 10 to 14 outside tests', () => {
    expect(loadConfig({ ...MINIMAL, BCRYPT_COST: '10' }).bcryptCost).toBe(10);
    expect(loadConfig({ ...MINIMAL, BCRYPT_COST: '14' }).bcryptCost).toBe(14);
    expect(() => loadConfig({ ...MINIMAL, BCRYPT_COST: '15' })).toThrow(/BCRYPT_COST/);
  });

  test('allows a low cost only when NODE_ENV=test', () => {
    expect(loadConfig({ ...MINIMAL, NODE_ENV: 'test', BCRYPT_COST: '4' }).bcryptCost).toBe(4);
  });
});

describe('loadSeedConfig', () => {
  const SEED = {
    SEED_STUDENT_PASSWORD: 'Student-Seed-Pass1!',
    SEED_STAFF_PASSWORD: 'Staff-Seed-Pass1!',
    SEED_ADMIN_PASSWORD: 'Admin-Seed-Pass1!',
  };

  test('defaults to 1,500 registered and 500 free students', () => {
    expect(loadSeedConfig(SEED)).toMatchObject({ registeredStudents: 1500, freeStudents: 500, bcryptCost: 10 });
  });

  test('both student counts are configurable', () => {
    const config = loadSeedConfig({ ...SEED, SEED_REGISTERED_STUDENTS: '40', SEED_FREE_STUDENTS: '10' });
    expect(config).toMatchObject({ registeredStudents: 40, freeStudents: 10 });
  });

  test('requires the seed passwords and does not need Redis or CSRF settings', () => {
    expect(() => loadSeedConfig({})).toThrow(/SEED_STUDENT_PASSWORD[\s\S]*SEED_STAFF_PASSWORD[\s\S]*SEED_ADMIN_PASSWORD/);
  });

  test('uses the same cost floor as the app', () => {
    expect(() => loadSeedConfig({ ...SEED, BCRYPT_COST: '4' })).toThrow(/BCRYPT_COST/);
  });
});
