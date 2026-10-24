'use strict';

const path = require('node:path');
const knex = require('knex');
const Redis = require('ioredis');
const { testUrls, HOW_TO_START } = require('./testEnv');

// Connection refusals arrive as an AggregateError with an empty message.
const describe = (err) => [err.code, err.message].filter(Boolean).join(': ') || String(err);

// Runs once before the integration suite. Fails loudly (never skips) if the
// real PostgreSQL or Redis is not reachable.
module.exports = async () => {
  const { databaseUrl, adminUrl, dbName, redisUrl } = testUrls();

  // knex would print its own "Acquire connection error" for a refused connection;
  // the error thrown below already says what is wrong, so keep the console clean.
  const quiet = { warn: () => {} };
  const admin = knex({ client: 'pg', connection: adminUrl, pool: { min: 0, max: 1 }, log: quiet });
  try {
    await admin.raw('select 1');
  } catch (err) {
    await admin.destroy();
    throw new Error(`Cannot reach PostgreSQL (${describe(err)}).\n${HOW_TO_START}`);
  }
  try {
    await admin.raw('DROP DATABASE IF EXISTS ?? WITH (FORCE)', [dbName]);
    await admin.raw('CREATE DATABASE ??', [dbName]);
  } finally {
    await admin.destroy();
  }

  const db = knex({
    client: 'pg',
    connection: databaseUrl,
    migrations: { directory: path.join(__dirname, '..', '..', 'db', 'migrations') },
    log: quiet,
  });
  try {
    await db.migrate.latest();
  } finally {
    await db.destroy();
  }

  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  redis.on('error', () => {});
  try {
    await redis.connect();
    await redis.flushdb();
  } catch (err) {
    throw new Error(`Cannot reach Redis (${describe(err)}).\n${HOW_TO_START}`);
  } finally {
    redis.disconnect();
  }

  // Mailpit: "not running" (connection refused) fails at once; a slow answer on a
  // busy machine is retried. This checks reachability, it does not measure speed.
  const mailpitUrl = process.env.MAILPIT_URL || 'http://127.0.0.1:8025';
  const attempts = 4;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(`${mailpitUrl}/api/v1/info`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      break;
    } catch (err) {
      const slow = err.name === 'TimeoutError' || err.name === 'AbortError';
      if (!slow || attempt >= attempts) {
        throw new Error(`Cannot reach Mailpit at ${mailpitUrl} (${describe(err)}).\n${HOW_TO_START}`);
      }
    }
  }
};
