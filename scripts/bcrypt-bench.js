'use strict';

// Measures bcrypt hash and compare time at several cost factors (FR-A4).
//   npm run bench:bcrypt                 # costs 10, 11, 12; 20 samples each
//   npm run bench:bcrypt -- 30           # 30 samples each
//   npm run bench:bcrypt -- 30 --json    # also print machine-readable JSON
//
// Runs one operation at a time, so the numbers are single-login latency, not
// throughput. Throughput under concurrency is measured in Phase 8 (calibrate).

const os = require('node:os');
const bcrypt = require('bcrypt');

const COSTS = [10, 11, 12];
const WARMUP = 2;
const PASSWORD = 'Bench-Password-2026!';

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  const round = (n) => Math.round(n * 10) / 10;
  return {
    median: round(at(0.5)),
    p95: round(at(0.95)),
    mean: round(samples.reduce((a, b) => a + b, 0) / samples.length),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
  };
}

async function time(fn) {
  const start = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

async function benchCost(cost, samples) {
  for (let i = 0; i < WARMUP; i += 1) await bcrypt.hash(PASSWORD, cost);
  const hashTimes = [];
  const compareTimes = [];
  let hash;
  for (let i = 0; i < samples; i += 1) {
    hashTimes.push(await time(async () => { hash = await bcrypt.hash(PASSWORD, cost); }));
  }
  for (let i = 0; i < samples; i += 1) {
    compareTimes.push(await time(() => bcrypt.compare(PASSWORD, hash)));
  }
  return { cost, samples, hashMs: stats(hashTimes), compareMs: stats(compareTimes) };
}

async function main() {
  const args = process.argv.slice(2);
  const samples = Number(args.find((a) => /^\d+$/.test(a)) || 20);
  const environment = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0] ? os.cpus()[0].model.trim() : 'unknown',
    logicalCpus: os.availableParallelism(),
    uvThreadpoolSize: Number(process.env.UV_THREADPOOL_SIZE || 4),
  };

  const results = [];
  for (const cost of COSTS) results.push(await benchCost(cost, samples));

  console.log(`bcrypt benchmark, ${samples} samples per cost, one operation at a time`);
  console.log(`${environment.node} | ${environment.platform} | ${environment.cpu} | ${environment.logicalCpus} logical CPUs | UV_THREADPOOL_SIZE=${environment.uvThreadpoolSize}`);
  console.log('');
  console.log('| Cost | hash median (ms) | hash p95 (ms) | compare median (ms) | compare p95 (ms) | compare min-max (ms) |');
  console.log('|---|---|---|---|---|---|');
  for (const r of results) {
    console.log(
      `| ${r.cost} | ${r.hashMs.median} | ${r.hashMs.p95} | ${r.compareMs.median} | ${r.compareMs.p95} | ${r.compareMs.min}-${r.compareMs.max} |`,
    );
  }
  if (args.includes('--json')) console.log(`\n${JSON.stringify({ environment, results }, null, 2)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
