'use strict';

const Redis = require('ioredis');
const { loadAuditConfig } = require('../config');
const { createDb } = require('../db/knex');
const { createMetrics } = require('../services/metrics');
const { createAudit } = require('./audit');

/**
 * Database + Redis + audit service for command-line tools (admin CLI, audit CLI).
 * Critical events (admin actions) are written straight into the chain, so the
 * CLI needs PostgreSQL and AUDIT_HMAC_KEY; Redis is used for the outside anchor
 * and counters when REDIS_URL is set.
 */
function createCliAudit({ logger, env = process.env }) {
  const config = loadAuditConfig(env);
  const db = createDb({ databaseUrl: config.databaseUrl, dbPoolMax: 2 }, logger);

  let redis;
  if (config.redisUrl) {
    redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, lazyConnect: false });
    redis.on('error', () => {}); // anchor/metrics are best-effort for CLI tools
  } else {
    // No Redis: anchor and counters become no-ops (verify will report no anchor).
    redis = { eval: async () => 0, incr: async () => 0, hgetall: async () => ({}), quit: async () => {}, disconnect() {} };
  }
  const metrics = createMetrics({ redis, logger });
  const audit = createAudit({ db, redis, config, logger, metrics });
  const ctx = { log: logger, ip: null, userAgent: 'cli', actor: 'cli' };

  async function close() {
    await db.destroy();
    await Promise.resolve(redis.quit()).catch(() => redis.disconnect());
  }

  return { config, db, redis, audit, metrics, ctx, close };
}

module.exports = { createCliAudit };
