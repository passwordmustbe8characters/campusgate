'use strict';

const knex = require('knex');

/**
 * Route knex's own messages (pool acquire timeouts, deprecations) into the app
 * logger instead of console.log, so they are structured and redacted.
 * Query bindings are never logged: knex debug output (which includes them)
 * stays off, and these hooks only receive knex's warning/error text.
 */
function knexLog(logger) {
  const asText = (message) => (typeof message === 'string' ? message : String(message && message.message ? message.message : message));
  return {
    warn: (message) => logger.warn({ event: 'knex_warning', knexMessage: asText(message) }, 'knex warning'),
    error: (message) => logger.error({ event: 'knex_error', knexMessage: asText(message) }, 'knex error'),
    deprecate: (method, alternative) => logger.warn({ event: 'knex_deprecation', method, alternative }, 'knex deprecation'),
    debug: () => {}, // never log queries or bindings
  };
}

/** PostgreSQL connection pool. Knex uses parameterized queries for all builder calls. */
function createDb(config, logger) {
  return knex({
    client: 'pg',
    connection: config.databaseUrl,
    pool: { min: 0, max: config.dbPoolMax },
    acquireConnectionTimeout: config.dbAcquireTimeoutMs, // undefined = knex default (60 s)
    debug: false,
    log: logger ? knexLog(logger) : undefined,
  });
}

module.exports = { createDb, knexLog };
