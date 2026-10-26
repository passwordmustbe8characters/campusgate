'use strict';

const { loadConfig, loadSeedConfig } = require('../../app/src/config');
const { TEST_ENV } = require('./helpers');

const KEY_A = Buffer.alloc(32, 7).toString('base64url');
const KEY_B = Buffer.alloc(32, 9).toString('base64');
const KEY_C = Buffer.alloc(32, 5).toString('base64url');
const KEY_D = Buffer.alloc(32, 6).toString('base64url');

const MINIMAL = {
  DATABASE_URL: 'postgres://x',
  REDIS_URL: 'redis://x',
  CSRF_SECRET: 'x'.repeat(32),
  TOKEN_HMAC_KEY: KEY_A,
  TOTP_ENC_KEY: KEY_B,
  AUDIT_HMAC_KEY: KEY_C,
  JWT_SECRET: KEY_D,
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

describe('Phase 2 keys and delivery settings', () => {
  test('both keys are required', () => {
    const { TOKEN_HMAC_KEY, TOTP_ENC_KEY, ...rest } = MINIMAL;
    expect(() => loadConfig(rest)).toThrow(/TOKEN_HMAC_KEY is required[\s\S]*TOTP_ENC_KEY is required/);
  });

  test('keys are decoded from base64 or base64url', () => {
    const config = loadConfig(MINIMAL);
    expect(config.tokenHmacKey).toEqual(Buffer.alloc(32, 7));
    expect(config.totpEncKey).toEqual(Buffer.alloc(32, 9));
  });

  test.each([
    ['TOTP_ENC_KEY', Buffer.alloc(31).toString('base64'), /exactly 32 bytes/],
    ['TOTP_ENC_KEY', Buffer.alloc(33).toString('base64'), /exactly 32 bytes/],
    ['TOKEN_HMAC_KEY', Buffer.alloc(16).toString('base64'), /at least 32 bytes/],
    ['TOKEN_HMAC_KEY', 'not base64!!', /base64/],
  ])('rejects a bad %s', (name, value, message) => {
    expect(() => loadConfig({ ...MINIMAL, [name]: value })).toThrow(message);
  });

  test('all secrets must be different', () => {
    expect(() => loadConfig({ ...MINIMAL, TOTP_ENC_KEY: KEY_A })).toThrow(/must all be different/);
    expect(() => loadConfig({ ...MINIMAL, AUDIT_HMAC_KEY: KEY_A })).toThrow(/must all be different/);
  });

  test('AUDIT_HMAC_KEY is required at startup and must be at least 32 bytes', () => {
    const { AUDIT_HMAC_KEY, ...rest } = MINIMAL;
    expect(() => loadConfig(rest)).toThrow(/AUDIT_HMAC_KEY is required/);
    expect(() => loadConfig({ ...MINIMAL, AUDIT_HMAC_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/AUDIT_HMAC_KEY must decode to at least 32 bytes/);
  });

  test('JWT_SECRET (Phase 4) is required, at least 32 bytes, and distinct from every other key', () => {
    const { JWT_SECRET, ...rest } = MINIMAL;
    expect(() => loadConfig(rest)).toThrow(/JWT_SECRET is required/);
    expect(() => loadConfig({ ...MINIMAL, JWT_SECRET: Buffer.alloc(16).toString('base64') })).toThrow(/JWT_SECRET must decode to at least 32 bytes/);
    for (const other of [KEY_A, KEY_B, KEY_C, MINIMAL.CSRF_SECRET]) {
      expect(() => loadConfig({ ...MINIMAL, JWT_SECRET: other })).toThrow(/must all be different/);
    }
    expect(loadConfig(MINIMAL).jwtSecret).toEqual(Buffer.alloc(32, 6));
  });

  test('defaults: email driver, 30-minute reset tokens, 60 s cooldowns, 5 ticket attempts', () => {
    expect(loadConfig(MINIMAL)).toMatchObject({
      otpDeliveryDriver: 'email',
      resetTokenTtlMin: 30,
      otpResendCooldownSec: 60,
      resetCooldownSec: 60,
      preauthTtlSec: 300,
      preauthMaxAttempts: 5,
      appBaseUrl: 'http://localhost:3000',
    });
  });

  test('reset token lifetime is configurable', () => {
    expect(loadConfig({ ...MINIMAL, RESET_TOKEN_TTL_MIN: '45' }).resetTokenTtlMin).toBe(45);
  });

  test('console driver is refused in production but allowed in development', () => {
    expect(() => loadConfig({ ...MINIMAL, NODE_ENV: 'production', OTP_DELIVERY_DRIVER: 'console' }))
      .toThrow(/refused when NODE_ENV=production/);
    expect(loadConfig({ ...MINIMAL, OTP_DELIVERY_DRIVER: 'console' }).otpDeliveryDriver).toBe('console');
  });

  test('rejects an unknown driver and a non-http APP_BASE_URL', () => {
    expect(() => loadConfig({ ...MINIMAL, OTP_DELIVERY_DRIVER: 'pigeon' })).toThrow(/OTP_DELIVERY_DRIVER/);
    expect(() => loadConfig({ ...MINIMAL, APP_BASE_URL: 'javascript:alert(1)' })).toThrow(/APP_BASE_URL/);
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
