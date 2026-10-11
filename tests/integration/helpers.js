'use strict';

const path = require('node:path');
const { Writable } = require('node:stream');
const knex = require('knex');
const Redis = require('ioredis');
const request = require('supertest');

const { loadConfig } = require('../../app/src/config');
const { createLogger } = require('../../app/src/logger');
const { createApp } = require('../../app/src/app');
const { createHasher } = require('../../app/src/services/passwordHasher');
const { seedAll } = require('../../db/seed/lib/seedAll');
const { generateStudents, studentEmail } = require('../../db/seed/lib/studentData');
const { testUrls } = require('./testEnv');

const PASSWORDS = Object.freeze({
  student: 'Student-Seed-Pass1!',
  staff: 'Staff-Seed-Pass1!',
  admin: 'Admin-Seed-Pass1!',
});

// Small seed for most tests: 3 registered + 3 free students, plus staff and admin.
const SMALL_SEED = { registeredStudents: 3, freeStudents: 3 };
const STUDENTS = generateStudents(SMALL_SEED.registeredStudents + SMALL_SEED.freeStudents);
const REGISTERED = STUDENTS.slice(0, 3).map((s, i) => ({ ...s, email: studentEmail(s, i) }));
const FREE = STUDENTS.slice(3);

function connectDb(options = {}) {
  return knex({
    client: 'pg',
    connection: testUrls().databaseUrl,
    migrations: { directory: path.join(__dirname, '..', '..', 'db', 'migrations') },
    ...options,
  });
}

function connectRedis() {
  return new Redis(testUrls().redisUrl, { maxRetriesPerRequest: 1 });
}

function captureLogs() {
  const lines = [];
  const destination = new Writable({
    write(chunk, encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { lines, logger: createLogger({ level: 'info', destination }) };
}

/** Real app against the test PostgreSQL database and Redis DB 15. */
function buildRealApp({ db, redis, hasher, env = {}, logger } = {}) {
  const { databaseUrl, redisUrl } = testUrls();
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    CSRF_SECRET: 'integration-test-csrf-secret-0123456789',
    BCRYPT_COST: '4',
    ...env,
  });
  return createApp({
    config,
    logger: logger || createLogger({ level: 'silent' }),
    db,
    redis,
    hasher: hasher || createHasher(config.bcryptCost),
  });
}

/**
 * Empty all data and restore the default policy row. (TRUNCATE ... CASCADE on
 * users also empties policies, because policies.updated_by references users.)
 */
async function resetData(db) {
  await db.raw('TRUNCATE users, student_records RESTART IDENTITY CASCADE');
  await db.raw('DELETE FROM policies');
  await db.raw('INSERT INTO policies DEFAULT VALUES');
}

/** Reset, then seed a small known data set. */
async function resetAndSeed(db, seed = SMALL_SEED) {
  await resetData(db);
  return seedAll(db, {
    ...seed,
    studentPassword: PASSWORDS.student,
    staffPassword: PASSWORDS.staff,
    adminPassword: PASSWORDS.admin,
    bcryptCost: 4,
  });
}

/** Agent with the pre-session + CSRF cookies, and the token for the header. */
async function csrfAgent(app) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const token = /name="csrf-token" content="([^"]+)"/.exec(page.text)[1];
  const post = (url, body) => agent.post(url).set('X-CSRF-Token', token).send(body);
  return { agent, token, post };
}

const userRow = (db, matric) => db('users').where({ matric_or_staff_id: matric }).first();

module.exports = {
  PASSWORDS,
  REGISTERED,
  FREE,
  connectDb,
  connectRedis,
  captureLogs,
  buildRealApp,
  resetData,
  resetAndSeed,
  csrfAgent,
  userRow,
};
