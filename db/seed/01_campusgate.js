'use strict';

const { loadEnvFile, loadSeedConfig } = require('../../app/src/config');
const { seedAll } = require('./lib/seedAll');

exports.seed = async (knex) => {
  loadEnvFile();
  const config = loadSeedConfig();
  console.log(
    `Seeding ${config.registeredStudents} registered + ${config.freeStudents} free students ` +
      `(bcrypt cost ${config.bcryptCost}, UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE || 4})...`,
  );
  await seedAll(knex, { ...config, log: (summary) => console.log(JSON.stringify(summary)) });
};
