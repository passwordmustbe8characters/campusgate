'use strict';

const { loadEnvFile } = require('../../app/src/config');

loadEnvFile();

const HOW_TO_START =
  'Integration tests need the PostgreSQL and Redis containers from docker compose.\n' +
  'Start them with:  docker compose up -d postgres redis\n' +
  'and make sure .env has DATABASE_URL and REDIS_URL pointing at localhost.';

/**
 * Test connection URLs, derived from .env so dev data is never touched:
 *  - PostgreSQL: same server, database "<name>_test" (dropped and recreated per run)
 *  - Redis: same server, DB index 15 (flushed per run)
 * TEST_DATABASE_URL / TEST_REDIS_URL override the derived values.
 */
function testUrls() {
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
    throw new Error(`DATABASE_URL and REDIS_URL must be set.\n${HOW_TO_START}`);
  }
  const pg = new URL(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
  if (!process.env.TEST_DATABASE_URL) pg.pathname = `/${pg.pathname.slice(1)}_test`;
  const dbName = pg.pathname.slice(1);

  const admin = new URL(pg);
  admin.pathname = '/postgres';

  const redis = new URL(process.env.TEST_REDIS_URL || process.env.REDIS_URL);
  if (!process.env.TEST_REDIS_URL) redis.pathname = '/15';

  return { databaseUrl: pg.toString(), adminUrl: admin.toString(), dbName, redisUrl: redis.toString() };
}

module.exports = { testUrls, HOW_TO_START };
