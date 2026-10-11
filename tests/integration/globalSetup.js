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

  const admin = knex({ client: 'pg', connection: adminUrl, pool: { min: 0, max: 1 } });
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
};
