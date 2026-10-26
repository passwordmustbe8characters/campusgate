'use strict';

// npm run calibrate   (inside Docker: docker compose run --rm -v "./docs:/usr/src/app/docs" app npm run calibrate)
//
// Measures the numbers the OMNeT++ model needs (NFR-7, FR-P7) and writes
// docs/calibration.json:
//   - bcrypt compare time at the configured cost (one sign-in's password check)
//   - database time of the sign-in lookup and of the policy read
//   - audit-chain write time (sync mode, inside a transaction that is rolled back)
//   - OTP step time: issue (DB + email send) and verify
//   - sign-in throughput, success rate and latency at 1, 2 and 4 worker processes
// Needs the seeded accounts (npm run seed) and Mailpit (or another SMTP server).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, loadEnvFile } = require('../app/src/config');
const { createLogger } = require('../app/src/logger');
const { createDb } = require('../app/src/db/knex');
const { createRedis } = require('../app/src/db/redis');
const { createHasher } = require('../app/src/services/passwordHasher');
const { createDelivery } = require('../app/src/services/delivery');
const { createOtpService } = require('../app/src/services/otpService');
const { appendEvents } = require('../app/src/audit/chain');
const { buildEvent } = require('../app/src/audit/events');
const { getPolicy } = require('../app/src/policies/policyRepo');
const { runRushHour, writeCsv, percentile } = require('./lib/generator');
const { startServer } = require('./lib/server');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'calibration.json');

async function timeIt(n, fn) {
  const ms = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = process.hrtime.bigint();
    await fn(i);
    ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const r = (v) => Math.round(v * 100) / 100;
  return { samples: n, medianMs: r(percentile(ms, 50)), p95Ms: r(percentile(ms, 95)), meanMs: r(ms.reduce((a, b) => a + b, 0) / n) };
}

async function main() {
  loadEnvFile();
  const config = loadConfig();
  const logger = createLogger({ level: 'warn' });
  const db = createDb(config, logger);
  const redis = createRedis(config, logger);
  const log = (msg) => process.stderr.write(`${msg}\n`);
  const result = {
    measuredAt: new Date().toISOString(),
    machine: { cpus: os.cpus().length, cpuModel: os.cpus()[0] && os.cpus()[0].model, totalMemGB: Math.round(os.totalmem() / 1e9), platform: `${os.platform()} ${os.release()}`, node: process.version },
    settings: { bcryptCost: config.bcryptCost, uvThreadpoolSize: Number(process.env.UV_THREADPOOL_SIZE || 4), auditMode: 'sync' },
  };

  try {
    const student = await db('users').join('roles', 'roles.id', 'users.role_id').where('roles.name', 'student')
      .orderBy('users.id').first('users.id', 'users.matric_or_staff_id', 'users.email', 'users.password_hash');
    if (!student) throw new Error('no seeded students: run npm run seed first');

    log('bcrypt compare (30 samples)...');
    const hasher = createHasher(config.bcryptCost);
    result.bcryptCompare = await timeIt(30, () => hasher.compare(process.env.SEED_STUDENT_PASSWORD || 'x', student.password_hash));

    log('database: sign-in lookup and policy read (100 samples each)...');
    result.dbSignInLookup = await timeIt(100, () => db('users').join('roles', 'roles.id', 'users.role_id')
      .where('users.matric_or_staff_id', student.matric_or_staff_id).first('users.id', 'users.password_hash', 'roles.name'));
    result.dbPolicyRead = await timeIt(100, () => getPolicy(db));

    log('audit-chain write, sync mode (50 samples, rolled back)...');
    result.auditWrite = await timeIt(50, async () => {
      const trx = await db.transaction();
      try {
        await appendEvents(trx, config.auditHmacKey, [buildEvent('login_success', { userId: student.id, success: true, details: { method: 'password' } }, { ip: '127.0.0.1' })]);
      } finally {
        await trx.rollback();
      }
    });

    log('OTP step: issue (DB + email) and verify (10 samples)...');
    const sent = [];
    const delivery = createDelivery(config, { redis });
    const capture = { name: delivery.name, send: async (m) => { sent.push(m); return delivery.send(m); } };
    const otp = createOtpService({ db, redis, delivery: capture, hmacKey: config.tokenHmacKey, cooldownSec: 1 });
    const issue = [];
    const verify = [];
    for (let i = 0; i < 10; i += 1) {
      await redis.del(`cg:cooldown:otp:calibrate:${student.id}`);
      let t0 = process.hrtime.bigint();
      await otp.issue(student, { purpose: 'calibrate', subject: 'CampusGate calibration code', intro: 'Calibration run (ignore).' });
      issue.push(Number(process.hrtime.bigint() - t0) / 1e6);
      const code = /code is: (\d{6})/.exec(sent[sent.length - 1].text)[1];
      t0 = process.hrtime.bigint();
      await otp.verify(student.id, code);
      verify.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const sum = (a) => ({ samples: a.length, medianMs: Math.round(percentile(a, 50) * 100) / 100, p95Ms: Math.round(percentile(a, 95) * 100) / 100 });
    result.otpIssueWithEmail = { ...sum(issue), deliveryDriver: delivery.name };
    result.otpVerify = sum(verify);
    if (delivery.close) await delivery.close();

    // Throughput: waiting room OFF, a burst that saturates the server, at 1, 2 and 4 worker processes.
    const policyBefore = await getPolicy(db);
    await db('policies').update({ queue_enabled: false });
    const users = Number(process.env.CALIBRATE_USERS || 200);
    result.throughput = [];
    try {
      for (const workers of [1, 2, 4]) {
        log(`throughput: ${workers} worker(s), ${users} students in 10 s...`);
        const server = await startServer({ port: 3200 + workers, workers });
        try {
          const { summary, rows } = await runRushHour({
            baseUrl: server.url, users, rampSec: 10, password: process.env.SEED_STUDENT_PASSWORD, timeoutMs: 30000, maxRetries: 2, giveUpMs: 5 * 60 * 1000,
          });
          writeCsv(path.join(ROOT, 'docs', 'loadtest', `calibrate-${workers}w.csv`), rows);
          result.throughput.push({ workers, ...summary });
        } finally {
          await server.stop();
        }
      }
    } finally {
      await db('policies').update({ queue_enabled: policyBefore.queue_enabled });
    }

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
    log(`written ${path.relative(ROOT, OUT)}`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await db.destroy();
    redis.disconnect();
  }
}

main().catch((err) => {
  console.error(`calibrate failed: ${err.message}`);
  process.exit(1);
});
