'use strict';

const path = require('node:path');
const dotenv = require('dotenv');

const ENV_FILE = path.resolve(__dirname, '../../.env');

/** Load .env into process.env (if present). Real environment variables win. */
function loadEnvFile() {
  dotenv.config({ path: ENV_FILE, quiet: true });
}

const NODE_ENVS = ['development', 'test', 'production'];
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

// bcrypt cost floor for any real configuration. Lower costs exist only so the
// automated tests run fast; they are refused unless NODE_ENV=test.
const BCRYPT_MIN_COST = 10;
const BCRYPT_MAX_COST = 14;
const BCRYPT_TEST_MIN_COST = 4;
// Chosen by measurement (scripts/bcrypt-bench.js); see docs/PROGRESS.md, Phase 1.
const BCRYPT_DEFAULT_COST = 10;

function intInRange(env, name, fallback, min, max, errors) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${name} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return value;
}

function oneOf(env, name, fallback, allowed, errors) {
  const value = env[name] || fallback;
  if (!allowed.includes(value)) errors.push(`${name} must be one of: ${allowed.join(', ')}`);
  return value;
}

function required(env, name, errors) {
  const value = env[name];
  if (!value) errors.push(`${name} is required`);
  return value;
}

function bool(env, name, fallback, errors) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  errors.push(`${name} must be true or false`);
  return fallback;
}

/**
 * A binary key given as base64 or base64url (e.g. 32 random bytes:
 * node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))").
 */
function key(env, name, { exactBytes, minBytes }, errors) {
  const raw = env[name];
  if (!raw) {
    errors.push(`${name} is required`);
    return undefined;
  }
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) {
    errors.push(`${name} must be base64 or base64url`);
    return undefined;
  }
  const bytes = Buffer.from(raw, 'base64');
  if (exactBytes && bytes.length !== exactBytes) {
    errors.push(`${name} must decode to exactly ${exactBytes} bytes (got ${bytes.length})`);
  } else if (minBytes && bytes.length < minBytes) {
    errors.push(`${name} must decode to at least ${minBytes} bytes (got ${bytes.length})`);
  }
  return bytes;
}

function url(env, name, fallback, errors) {
  const value = env[name] || fallback;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol');
    return parsed.origin;
  } catch {
    errors.push(`${name} must be an http(s) URL`);
    return fallback;
  }
}

const DELIVERY_DRIVERS = ['console', 'email', 'sms-mock'];

function bcryptCost(env, nodeEnv, errors) {
  const min = nodeEnv === 'test' ? BCRYPT_TEST_MIN_COST : BCRYPT_MIN_COST;
  return intInRange(env, 'BCRYPT_COST', BCRYPT_DEFAULT_COST, min, BCRYPT_MAX_COST, errors);
}

function fail(errors) {
  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
}

/**
 * Build a validated, frozen config object from an environment map.
 * Throws one error listing every problem, so misconfiguration fails fast at startup.
 */
function loadConfig(env = process.env) {
  const errors = [];
  const nodeEnv = oneOf(env, 'NODE_ENV', 'development', NODE_ENVS, errors);

  const config = {
    nodeEnv,
    port: intInRange(env, 'PORT', 3000, 1, 65535, errors),
    logLevel: oneOf(env, 'LOG_LEVEL', 'info', LOG_LEVELS, errors),
    databaseUrl: required(env, 'DATABASE_URL', errors),
    dbPoolMax: intInRange(env, 'DB_POOL_MAX', 10, 1, 100, errors),
    redisUrl: required(env, 'REDIS_URL', errors),
    healthCheckTimeoutMs: intInRange(env, 'HEALTH_CHECK_TIMEOUT_MS', 2000, 50, 30000, errors),
    // Read by libuv when the thread pool first starts, so it must be set in the
    // environment before Node launches. Recorded here so logs and calibration can report it.
    uvThreadpoolSize: intInRange(env, 'UV_THREADPOOL_SIZE', 4, 1, 1024, errors),
    bcryptCost: bcryptCost(env, nodeEnv, errors),
    csrfSecret: required(env, 'CSRF_SECRET', errors),
    // Secure cookies need HTTPS (Phase 9). Default on in production only.
    cookieSecure: bool(env, 'COOKIE_SECURE', nodeEnv === 'production', errors),

    // --- Phase 2: second factors and recovery ---
    // HMAC key for OTPs, backup codes, reset tokens and ticket ids (domain-separated per use).
    tokenHmacKey: key(env, 'TOKEN_HMAC_KEY', { minBytes: 32 }, errors),
    // AES-256-GCM key for TOTP secrets at rest. Losing or changing it makes stored TOTP secrets unreadable.
    totpEncKey: key(env, 'TOTP_ENC_KEY', { exactBytes: 32 }, errors),
    appBaseUrl: url(env, 'APP_BASE_URL', 'http://localhost:3000', errors),
    otpDeliveryDriver: oneOf(env, 'OTP_DELIVERY_DRIVER', 'email', DELIVERY_DRIVERS, errors),
    deliveryTimeoutMs: intInRange(env, 'DELIVERY_TIMEOUT_MS', 10000, 100, 60000, errors),
    smtp: {
      host: env.SMTP_HOST || 'localhost',
      port: intInRange(env, 'SMTP_PORT', 1025, 1, 65535, errors),
      secure: bool(env, 'SMTP_SECURE', false, errors),
      user: env.SMTP_USER || undefined,
      pass: env.SMTP_PASS || undefined,
    },
    mailFrom: env.MAIL_FROM || 'CampusGate <no-reply@campusgate.test>',
    resetTokenTtlMin: intInRange(env, 'RESET_TOKEN_TTL_MIN', 30, 5, 1440, errors),
    otpResendCooldownSec: intInRange(env, 'OTP_RESEND_COOLDOWN_SEC', 60, 1, 3600, errors),
    resetCooldownSec: intInRange(env, 'RESET_COOLDOWN_SEC', 60, 1, 3600, errors),
    preauthTtlSec: intInRange(env, 'PREAUTH_TTL_SEC', 300, 30, 1800, errors),
    preauthMaxAttempts: intInRange(env, 'PREAUTH_MAX_ATTEMPTS', 5, 1, 20, errors),

    // --- Phase 3: audit log ---
    // Key for the tamper-evident chain (HMAC). Never stored in the database.
    // Losing or changing it makes existing chains unverifiable.
    auditHmacKey: key(env, 'AUDIT_HMAC_KEY', { minBytes: 32 }, errors),

    // --- Phase 4: login-once session ---
    // HS256 signing key for session tokens. Changing it signs everyone out.
    jwtSecret: key(env, 'JWT_SECRET', { minBytes: 32 }, errors),

    // --- Phase 5: rate limiting (FR-P4), per minute ---
    // Per IP is generous because a whole campus can share one public IP (NAT);
    // per account is tight. Lockout still stops password guessing.
    rateLimitIpPerMin: intInRange(env, 'RATE_LIMIT_IP_PER_MIN', 300, 1, 1000000, errors),
    rateLimitAccountPerMin: intInRange(env, 'RATE_LIMIT_ACCOUNT_PER_MIN', 10, 1, 1000000, errors),

    // --- Phase 5: waiting room (capacity, batch and interval are policies, set without restart) ---
    // A sign-in pass holds a place this long unless the sign-in completes sooner.
    queuePassTtlSec: intInRange(env, 'QUEUE_PASS_TTL_SEC', 120, 10, 3600, errors),
    // A queued ticket whose page stops polling is dropped after this long.
    queueTicketTimeoutSec: intInRange(env, 'QUEUE_TICKET_TIMEOUT_SEC', 30, 5, 600, errors),

    // --- Phase 7: risk score at sign-in (FR-A11). On by default. ---
    riskScoring: bool(env, 'RISK_SCORING', true, errors),

    // --- Phase 8: multi-process serving (FR-P7). 1 = a single process. ---
    clusterWorkers: intInRange(env, 'CLUSTER_WORKERS', 1, 1, 64, errors),
  };

  if (config.csrfSecret && config.csrfSecret.length < 32) {
    errors.push('CSRF_SECRET must be at least 32 characters');
  }
  if (config.otpDeliveryDriver === 'console' && nodeEnv === 'production') {
    errors.push('OTP_DELIVERY_DRIVER=console prints codes to stdout and is refused when NODE_ENV=production');
  }
  if (config.otpDeliveryDriver === 'sms-mock' && nodeEnv === 'production') {
    errors.push('OTP_DELIVERY_DRIVER=sms-mock keeps codes in a plain Redis list and is refused when NODE_ENV=production');
  }
  const secrets = [env.CSRF_SECRET, env.TOKEN_HMAC_KEY, env.TOTP_ENC_KEY, env.AUDIT_HMAC_KEY, env.JWT_SECRET].filter(Boolean);
  if (new Set(secrets).size !== secrets.length) {
    errors.push('CSRF_SECRET, TOKEN_HMAC_KEY, TOTP_ENC_KEY, AUDIT_HMAC_KEY and JWT_SECRET must all be different');
  }

  fail(errors);
  return Object.freeze(config);
}

/**
 * Settings for command-line tools that write audit events (admin CLI, audit
 * CLI) without loading the whole app config.
 */
function loadAuditConfig(env = process.env) {
  const errors = [];
  const config = {
    databaseUrl: required(env, 'DATABASE_URL', errors),
    redisUrl: env.REDIS_URL || undefined,
    auditHmacKey: key(env, 'AUDIT_HMAC_KEY', { minBytes: 32 }, errors),
  };
  fail(errors);
  return Object.freeze(config);
}

/**
 * Settings for the seed script only. Kept separate so seeding needs just
 * PostgreSQL. Seeded accounts are hashed at the real BCRYPT_COST, because load
 * tests and calibration log in as them.
 */
function loadSeedConfig(env = process.env) {
  const errors = [];
  const nodeEnv = oneOf(env, 'NODE_ENV', 'development', NODE_ENVS, errors);

  const config = {
    bcryptCost: bcryptCost(env, nodeEnv, errors),
    registeredStudents: intInRange(env, 'SEED_REGISTERED_STUDENTS', 1500, 0, 100000, errors),
    freeStudents: intInRange(env, 'SEED_FREE_STUDENTS', 500, 0, 100000, errors),
    studentPassword: required(env, 'SEED_STUDENT_PASSWORD', errors),
    staffPassword: required(env, 'SEED_STAFF_PASSWORD', errors),
    adminPassword: required(env, 'SEED_ADMIN_PASSWORD', errors),
  };

  fail(errors);
  return Object.freeze(config);
}

module.exports = { loadConfig, loadSeedConfig, loadAuditConfig, loadEnvFile, BCRYPT_MIN_COST, DELIVERY_DRIVERS };
