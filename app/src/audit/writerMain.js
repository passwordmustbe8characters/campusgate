'use strict';

// Entry point of the `audit-writer` compose service (AUDIT_MODE=queue).
//   node app/src/audit/writerMain.js
// GET http://localhost:${AUDIT_WRITER_PORT}/health -> queue length, lag, last batch.

const http = require('node:http');
const Redis = require('ioredis');
const { loadEnvFile, loadAuditConfig } = require('../config');
const { createLogger } = require('../logger');
const { createDb } = require('../db/knex');
const { createAuditWriter } = require('./writer');

loadEnvFile();

const port = Number(process.env.AUDIT_WRITER_PORT || 3001);
const batchSize = Number(process.env.AUDIT_BATCH_SIZE || 500);
const drainTimeoutMs = Number(process.env.AUDIT_DRAIN_TIMEOUT_MS || 20000);
// Healthy only if the loop completed a pass recently (it blocks at most ~1 s per pass).
const STALE_MS = 15000;

async function main() {
  const config = loadAuditConfig();
  const logger = createLogger({ level: process.env.LOG_LEVEL || 'info' }).child({ component: 'audit-writer' });
  if (!config.redisUrl) throw new Error('REDIS_URL is required for the audit writer');
  const db = createDb({ databaseUrl: config.databaseUrl, dbPoolMax: 2 }, logger);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
  redis.on('error', (err) => logger.warn({ event: 'audit_writer_redis_error', err }, 'redis error'));

  const writer = createAuditWriter({ db, redis, key: config.auditHmacKey, logger, batchSize });
  writer.start();

  const server = http.createServer(async (req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    let metrics = {};
    try {
      metrics = await writer.publishMetrics();
    } catch (err) {
      metrics = { error: err.message };
    }
    const fresh = writer.status.lastTickAt && Date.now() - Date.parse(writer.status.lastTickAt) < STALE_MS;
    const healthy = Boolean(fresh && !metrics.error);
    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      status: healthy ? 'ok' : 'degraded',
      queueLength: metrics.length,
      queueLagMs: metrics.lag,
      lastBatchAt: writer.status.lastBatchAt,
      lastTickAt: writer.status.lastTickAt,
      writtenSinceStart: writer.status.written,
      lastError: writer.status.lastError,
    }));
  });
  server.listen(port, () => logger.info({ port, batchSize }, 'audit writer listening'));

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'audit writer draining');
    server.close();
    const { remaining } = await writer.stop({ drainTimeoutMs });
    await db.destroy();
    redis.disconnect();
    process.exit(remaining === 0 ? 0 : 1);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(`audit writer failed to start: ${err.message}`);
  process.exit(1);
});
