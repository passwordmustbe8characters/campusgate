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
  };

  if (config.csrfSecret && config.csrfSecret.length < 32) {
    errors.push('CSRF_SECRET must be at least 32 characters');
  }

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

module.exports = { loadConfig, loadSeedConfig, loadEnvFile, BCRYPT_MIN_COST };
