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

/**
 * Build a validated, frozen config object from an environment map.
 * Throws one error listing every problem, so misconfiguration fails fast at startup.
 */
function loadConfig(env = process.env) {
  const errors = [];

  const config = {
    nodeEnv: oneOf(env, 'NODE_ENV', 'development', NODE_ENVS, errors),
    port: intInRange(env, 'PORT', 3000, 1, 65535, errors),
    logLevel: oneOf(env, 'LOG_LEVEL', 'info', LOG_LEVELS, errors),
    databaseUrl: required(env, 'DATABASE_URL', errors),
    dbPoolMax: intInRange(env, 'DB_POOL_MAX', 10, 1, 100, errors),
    redisUrl: required(env, 'REDIS_URL', errors),
    healthCheckTimeoutMs: intInRange(env, 'HEALTH_CHECK_TIMEOUT_MS', 2000, 50, 30000, errors),
    // Read by libuv when the thread pool first starts, so it must be set in the
    // environment before Node launches. Recorded here so logs and calibration can report it.
    uvThreadpoolSize: intInRange(env, 'UV_THREADPOOL_SIZE', 4, 1, 1024, errors),
  };

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
  return Object.freeze(config);
}

module.exports = { loadConfig, loadEnvFile };
