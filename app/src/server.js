'use strict';

const cluster = require('node:cluster');
const { loadConfig, loadEnvFile } = require('./config');
const { createLogger } = require('./logger');
const { createDb } = require('./db/knex');
const { createRedis } = require('./db/redis');
const { createHasher } = require('./services/passwordHasher');
const { createDelivery } = require('./services/delivery');
const { createApp } = require('./app');
const { getPolicy } = require('./policies/policyRepo');

loadEnvFile();

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const logger = createLogger({ level: config.logLevel });

async function main() {
  const db = createDb(config, logger);
  const redis = createRedis(config, logger);
  const hasher = createHasher(config.bcryptCost);
  // Compute the same-cost dummy hash before serving, so the first unknown-user
  // login is not slower than the rest.
  await hasher.dummyHash();

  const delivery = createDelivery(config, { redis });
  if (delivery.name === 'console') {
    logger.warn(
      { otpDeliveryDriver: 'console' },
      'OTP_DELIVERY_DRIVER=console: one-time codes and links are printed to stdout. Development/test only.',
    );
  }

  const app = createApp({ config, logger, db, redis, hasher, delivery });
  const { permissions, waitingRoom, accessWindows } = app.get('services');
  await permissions.start(); // load role -> service map, subscribe to change notices
  await accessWindows.start(); // same for access windows
  // Waiting-room admitter: every process runs it; exactly one admits per interval (Redis slot).
  const stopAdmitter = waitingRoom.startAdmitter({ getPolicy: () => getPolicy(db), logger });

  const server = app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        nodeEnv: config.nodeEnv,
        uvThreadpoolSize: config.uvThreadpoolSize,
        bcryptCost: config.bcryptCost,
        otpDeliveryDriver: delivery.name,
      },
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
      await app.get('background').idle(); // let queued reset/notification emails finish
      stopAdmitter();
      await permissions.stop();
      await accessWindows.stop();
      await Promise.allSettled([db.destroy(), redis.quit(), delivery.close && delivery.close()]);
      clearTimeout(forceExit);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => {
  logger.fatal({ err }, 'unhandled promise rejection');
  process.exit(1);
});

/**
 * Multi-process serving (FR-P7): with CLUSTER_WORKERS > 1 the primary process
 * forks that many workers sharing the port; each owns its own DB pool, Redis
 * connection and bcrypt thread pool (UV_THREADPOOL_SIZE each). Everything
 * shared (sessions denylist, rate limits, waiting room, tickets) is in Redis.
 * A worker that dies is replaced; on SIGTERM/SIGINT the primary stops them all.
 */
function runPrimary(workers) {
  let stopping = false;
  logger.info({ workers, uvThreadpoolSize: config.uvThreadpoolSize }, 'starting worker processes');
  for (let i = 0; i < workers; i += 1) cluster.fork();
  cluster.on('exit', (worker, code, signal) => {
    if (stopping) return;
    logger.error({ pid: worker.process.pid, code, signal }, 'worker exited; starting a replacement');
    cluster.fork();
  });
  const stopAll = () => {
    stopping = true;
    for (const w of Object.values(cluster.workers)) w.process.kill('SIGTERM');
    setTimeout(() => process.exit(0), 12000).unref();
    cluster.on('exit', () => { if (Object.keys(cluster.workers).length === 0) process.exit(0); });
  };
  process.on('SIGTERM', stopAll);
  process.on('SIGINT', stopAll);
}

if (config.clusterWorkers > 1 && cluster.isPrimary) {
  runPrimary(config.clusterWorkers);
} else {
  main().catch((err) => {
    logger.fatal({ err }, 'startup failed');
    process.exit(1);
  });
}
