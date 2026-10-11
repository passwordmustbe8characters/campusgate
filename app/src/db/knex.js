'use strict';

const knex = require('knex');

/** PostgreSQL connection pool. Knex uses parameterized queries for all builder calls. */
function createDb(config) {
  return knex({
    client: 'pg',
    connection: config.databaseUrl,
    pool: { min: 0, max: config.dbPoolMax },
  });
}

module.exports = { createDb };
