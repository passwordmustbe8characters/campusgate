'use strict';

const path = require('node:path');
const { loadEnvFile } = require('./app/src/config');

loadEnvFile();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run migrations or seeds (see .env.example)');
}

// Migrations only need PostgreSQL, so this does not require REDIS_URL.
module.exports = {
  client: 'pg',
  connection: process.env.DATABASE_URL,
  migrations: {
    directory: path.join(__dirname, 'db', 'migrations'),
    tableName: 'knex_migrations',
  },
  seeds: {
    directory: path.join(__dirname, 'db', 'seed'),
  },
};
