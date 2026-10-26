'use strict';

// Rush-hour load test against a running CampusGate (FR-P8).
//   npm run loadtest -- --url http://localhost:3000 --users 300 --ramp 30 [--timeout 10000] [--retries 3] [--out docs/loadtest/run.csv]
// Uses the seeded student accounts and SEED_STUDENT_PASSWORD from .env.
// The target's per-IP rate limit must allow this many sign-ins from one machine
// (all virtual students share this computer's IP): set RATE_LIMIT_IP_PER_MIN high for test runs.

const { loadEnvFile } = require('../app/src/config');
const { runRushHour, writeCsv } = require('./lib/generator');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

async function main() {
  loadEnvFile();
  const a = args(process.argv.slice(2));
  const password = process.env.SEED_STUDENT_PASSWORD;
  if (!password) throw new Error('SEED_STUDENT_PASSWORD is required (see .env.example)');
  const users = Number(a.users || 100);
  const { summary, rows } = await runRushHour({
    baseUrl: a.url || 'http://localhost:3000',
    users,
    rampSec: Number(a.ramp || 30),
    timeoutMs: Number(a.timeout || 10000),
    maxRetries: Number(a.retries || 3),
    password,
    // Set by the admin "Simulate rush hour" button: lets this run past the per-IP limit (non-production only).
    extraHeaders: a['sim-token'] ? { 'X-CampusGate-Simulation': a['sim-token'] } : {},
    onProgress: (done, total) => { if (done % Math.max(1, Math.round(total / 10)) === 0) process.stderr.write(`  ${done}/${total} done\n`); },
  });
  if (a.out) writeCsv(a.out, rows);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(`load test failed: ${err.message}`);
  process.exit(1);
});
