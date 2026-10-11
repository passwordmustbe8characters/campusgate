'use strict';

const Redis = require('ioredis');

/**
 * Shared Redis client. All cross-process state (waiting room, rate limits,
 * token denylist) lives here, never in process memory.
 */
function createRedis(config, logger) {
  const client = new Redis(config.redisUrl, {
    // Fail commands quickly while Redis is down instead of queueing forever,
    // so /health reports the outage rather than hanging.
    maxRetriesPerRequest: 1,
  });
  // ioredis retries forever; log the outage once and the recovery once, not every attempt.
  let down = false;
  client.on('error', (err) => {
    if (down) return;
    down = true;
    logger.warn({ err }, 'redis connection error (will keep retrying)');
  });
  client.on('ready', () => {
    if (down) logger.info('redis reconnected');
    down = false;
  });
  return client;
}

module.exports = { createRedis };
