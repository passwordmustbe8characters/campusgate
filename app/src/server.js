'use strict';

const { loadConfig, loadEnvFile } = require('./config');
const { createLogger } = require('./logger');
const { createDb } = require('./db/knex');
const { createRedis } = require('./db/redis');
const { createApp } = require('./app');

loadEnvFile();

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const logger = createLogger({ level: config.logLevel });
const db = createDb(config);
const redis = createRedis(config, logger);
const app = createApp({ config, logger, db, redis });

const server = app.listen(config.port, () => {
  logger.info(
    { port: config.port, nodeEnv: config.nodeEnv, uvThreadpoolSize: config.uvThreadpoolSize },
    'CampusGate listening',
  );
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  const forceExit = setTimeout(() => process.exit(1), 10000).unref();
  try {
    await new Promise((resolve) => server.close(resolve));
    await Promise.allSettled([db.destroy(), redis.quit()]);
    clearTimeout(forceExit);
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  logger.fatal({ err }, 'unhandled promise rejection');
  process.exit(1);
});
