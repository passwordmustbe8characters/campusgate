'use strict';

const express = require('express');

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function check(name, fn, timeoutMs, log) {
  const started = process.hrtime.bigint();
  try {
    await withTimeout(Promise.resolve().then(fn), timeoutMs);
    return { status: 'ok', latency_ms: Number(process.hrtime.bigint() - started) / 1e6 };
  } catch (err) {
    // Details go to the log only; the public response just says which dependency failed.
    log.warn({ err, dependency: name }, 'health check failed');
    return { status: 'error' };
  }
}

/** GET /health: 200 when PostgreSQL and Redis both answer, 503 otherwise (NFR-8). */
function healthRouter({ db, redis, timeoutMs }) {
  const router = express.Router();

  router.get('/health', async (req, res) => {
    const [postgres, redisCheck] = await Promise.all([
      check('postgres', () => db.raw('select 1'), timeoutMs, req.log),
      check('redis', () => redis.ping(), timeoutMs, req.log),
    ]);
    const healthy = postgres.status === 'ok' && redisCheck.status === 'ok';

    res.set('Cache-Control', 'no-store');
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      uptime_s: Math.round(process.uptime()),
      checks: { postgres, redis: redisCheck },
    });
  });

  return router;
}

module.exports = { healthRouter };
