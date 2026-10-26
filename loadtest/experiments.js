'use strict';

// npm run loadtest:experiments   (inside Docker, like calibrate; run calibrate first)
//
// Baseline vs. proposed (FR-P2, NFR-7): the same rush-hour load with the
// waiting room OFF and ON, for several crowd sizes. Writes
//   docs/loadtest/results.csv            one line per run (the comparison table)
//   docs/loadtest/<mode>-<users>.csv     one line per virtual student
//   docs/loadtest/results.json           everything, with the settings used
// Waiting-room settings for the ON runs come from the measured throughput in
// docs/calibration.json: batch = throughput x interval, capacity = throughput x 3 s.
//
// Options (environment): EXP_USERS="200,500,1000"  EXP_WORKERS=2  EXP_RAMP_SEC=30  EXP_TIMEOUT_MS=10000

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, loadEnvFile } = require('../app/src/config');
const { createLogger } = require('../app/src/logger');
const { createDb } = require('../app/src/db/knex');
const { getPolicy } = require('../app/src/policies/policyRepo');
const { runRushHour, writeCsv } = require('./lib/generator');
const { startServer } = require('./lib/server');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'docs', 'loadtest');

async function main() {
  loadEnvFile();
  const config = loadConfig();
  const db = createDb(config, createLogger({ level: 'warn' }));
  const log = (m) => process.stderr.write(`${m}\n`);
  const crowd = (process.env.EXP_USERS || '200,500,1000').split(',').map(Number);
  const workers = Number(process.env.EXP_WORKERS || 2);
  const rampSec = Number(process.env.EXP_RAMP_SEC || 30);
  const timeoutMs = Number(process.env.EXP_TIMEOUT_MS || 10000);

  const calibration = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'calibration.json'), 'utf8'));
  const measured = calibration.throughput.find((t) => t.workers === workers) || calibration.throughput[0];
  const rate = Math.max(1, measured.signInsPerSec);
  const interval = 2;
  const queue = { queue_capacity: Math.max(2, Math.ceil(rate * 3)), queue_batch: Math.max(1, Math.ceil(rate * interval)), queue_interval_sec: interval };
  log(`workers=${workers}, measured ${rate} sign-ins/s -> waiting room ${JSON.stringify(queue)}`);

  const before = await getPolicy(db);
  const runs = [];
  try {
    for (const users of crowd) {
      for (const mode of ['off', 'on']) {
        await db('policies').update(mode === 'on' ? { queue_enabled: true, ...queue } : { queue_enabled: false });
        log(`run: waiting room ${mode.toUpperCase()}, ${users} students over ${rampSec} s...`);
        const server = await startServer({ port: 3300, workers });
        try {
          const { summary, rows } = await runRushHour({
            baseUrl: server.url, users, rampSec, timeoutMs, maxRetries: 3, giveUpMs: 10 * 60 * 1000,
            password: process.env.SEED_STUDENT_PASSWORD,
          });
          writeCsv(path.join(DIR, `${mode}-${users}.csv`), rows);
          runs.push({ waitingRoom: mode, workers, ...summary });
          log(`  success ${summary.successRatePct}%  mean ${summary.signInMeanMs} ms  p95 ${summary.signInP95Ms} ms  timeouts ${summary.timeouts}`);
        } finally {
          await server.stop();
        }
      }
    }
  } finally {
    await db('policies').update({
      queue_enabled: before.queue_enabled, queue_capacity: before.queue_capacity, queue_batch: before.queue_batch, queue_interval_sec: before.queue_interval_sec,
    });
    await db.destroy();
  }

  fs.mkdirSync(DIR, { recursive: true });
  const cols = ['waitingRoom', 'users', 'rampSec', 'workers', 'successRatePct', 'succeeded', 'gaveUp', 'failed', 'signInMeanMs', 'signInP95Ms',
    'loginRequestMeanMs', 'loginRequestP95Ms', 'timeouts', 'queuedStudents', 'queueWaitMeanMs', 'signInsPerSec', 'wallSec'];
  fs.writeFileSync(path.join(DIR, 'results.csv'), `${[cols.join(',')].concat(runs.map((r) => cols.map((c) => (r[c] ?? '')).join(','))).join('\n')}\n`);
  fs.writeFileSync(path.join(DIR, 'results.json'), `${JSON.stringify({ measuredAt: new Date().toISOString(), timeoutMs, rampSec, queue, runs }, null, 2)}\n`);
  console.log(JSON.stringify(runs, null, 2));
}

main().catch((err) => {
  console.error(`experiments failed: ${err.message}`);
  process.exit(1);
});
