'use strict';

const http = require('node:http');
const path = require('node:path');
const { Writable } = require('node:stream');
const knex = require('knex');
const Redis = require('ioredis');
const request = require('supertest');

const { loadConfig } = require('../../app/src/config');
const { createLogger } = require('../../app/src/logger');
const { createApp } = require('../../app/src/app');
const { createHasher } = require('../../app/src/services/passwordHasher');
const { DeliveryError } = require('../../app/src/services/delivery');
const { seedAll } = require('../../db/seed/lib/seedAll');
const { generateStudents, studentEmail } = require('../../db/seed/lib/studentData');
const { testUrls } = require('./testEnv');

const PASSWORDS = Object.freeze({
  student: 'Student-Seed-Pass1!',
  staff: 'Staff-Seed-Pass1!',
  admin: 'Admin-Seed-Pass1!',
});

const TEST_KEYS = Object.freeze({
  tokenHmacKey: Buffer.alloc(32, 11).toString('base64url'),
  totpEncKey: Buffer.alloc(32, 12).toString('base64url'),
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

/**
 * In-memory delivery driver: records every message so tests can read codes.
 * Registered as 'console' (an allowed otp_codes.channel); prints nothing.
 */
function captureDelivery({ fail = false, delayMs = 0, failMessage = 'simulated delivery failure' } = {}) {
  const sent = [];
  return {
    name: 'console',
    sent,
    async send(message) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (fail) throw new DeliveryError('console delivery failed', new Error(failMessage));
      sent.push(message);
    },
    lastCode() {
      const match = /code is: (\d{6})/.exec((sent[sent.length - 1] || {}).text || '');
      return match && match[1];
    },
  };
}

const MAILPIT_URL = process.env.MAILPIT_URL || 'http://127.0.0.1:8025';
const mailpit = {
  url: MAILPIT_URL,
  async clear() {
    await fetch(`${MAILPIT_URL}/api/v1/messages`, { method: 'DELETE' });
  },
  /** Wait for the newest message to an address and return its full body. */
  async latestTo(address, { timeoutMs = 10000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}&limit=1`);
      const { messages } = await res.json();
      if (messages && messages.length > 0) {
        return (await fetch(`${MAILPIT_URL}/api/v1/message/${messages[0].ID}`)).json();
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`no email to ${address} within ${timeoutMs} ms`);
  },
};

/** Poll until fn() returns something truthy (for background work such as emails). */
async function waitFor(fn, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Turn on email 2FA for a seeded user directly in the DB. */
const enableEmail2fa = (db, matric) =>
  db('users').where({ matric_or_staff_id: matric }).update({ two_factor_enabled: true, two_factor_method: 'email' });

/** Real app against the test PostgreSQL database and Redis DB 15. */
function buildRealApp({ db, redis, hasher, env = {}, logger, delivery = captureDelivery() } = {}) {
  const { databaseUrl, redisUrl } = testUrls();
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    CSRF_SECRET: 'integration-test-csrf-secret-0123456789',
    BCRYPT_COST: '4',
    TOKEN_HMAC_KEY: TEST_KEYS.tokenHmacKey,
    TOTP_ENC_KEY: TEST_KEYS.totpEncKey,
    ...env,
  });
  return createApp({
    config,
    logger: logger || createLogger({ level: 'silent' }),
    db,
    redis,
    hasher: hasher || createHasher(config.bcryptCost),
    delivery,
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

// Servers started by listen(); closed after every test by tests/integration/setup.js.
const openServers = new Set();

/**
 * Start the app on an ephemeral port. Passing a listening server to supertest
 * (instead of the bare app) means concurrent requests do not each attach
 * "listening"/"error" listeners while supertest starts its own server.
 */
async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  openServers.add(server);
  return server;
}

async function closeServers() {
  const servers = [...openServers];
  openServers.clear();
  await Promise.all(servers.map((server) => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  }));
}

/** Agent with the pre-session + CSRF cookies, and the token for the header. */
async function csrfAgent(app) {
  const agent = request.agent(await listen(app));
  const page = await agent.get('/login');
  const token = /name="csrf-token" content="([^"]+)"/.exec(page.text)[1];
  const post = (url, body = {}) => agent.post(url).set('X-CSRF-Token', token).send(body);
  return { agent, token, post };
}

/** Value of a cookie set by a response (or undefined). */
function cookieFrom(res, name) {
  const header = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  return header ? decodeURIComponent(header.split(';')[0].slice(name.length + 1)) : undefined;
}

const userRow = (db, matric) => db('users').where({ matric_or_staff_id: matric }).first();

module.exports = {
  PASSWORDS,
  TEST_KEYS,
  REGISTERED,
  FREE,
  connectDb,
  connectRedis,
  captureLogs,
  buildRealApp,
  resetData,
  resetAndSeed,
  listen,
  closeServers,
  csrfAgent,
  cookieFrom,
  captureDelivery,
  mailpit,
  enableEmail2fa,
  waitFor,
  userRow,
};
