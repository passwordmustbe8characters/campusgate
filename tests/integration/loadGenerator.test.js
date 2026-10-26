'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { connectDb, connectRedis, buildRealApp, resetAndSeed, listen, PASSWORDS } = require('./helpers');
const { runRushHour, writeCsv, summarize } = require('../../loadtest/lib/generator');

describe('rush-hour load generator (FR-P8) against the real app', () => {
  let db;
  let redis;

  beforeAll(() => {
    db = connectDb();
    redis = connectRedis();
  });
  beforeEach(async () => {
    await resetAndSeed(db);
    await redis.flushdb();
  });
  afterAll(async () => {
    await db.destroy();
    redis.disconnect();
  });

  test('waiting room off: every virtual student signs in once and opens the portal home', async () => {
    await db('policies').update({ queue_enabled: false });
    const server = await listen(buildRealApp({ db, redis }));
    const { summary, rows } = await runRushHour({
      baseUrl: `http://127.0.0.1:${server.address().port}`, users: 3, rampSec: 1, password: PASSWORDS.student,
    });
    expect(summary).toMatchObject({ users: 3, succeeded: 3, successRatePct: 100, timeouts: 0, queuedStudents: 0 });
    expect(rows.every((r) => r.outcome === 'success' && r.attempts === 1 && r.signInMs > 0)).toBe(true);
    expect(await db('sessions')).toHaveLength(3);
  });

  test('waiting room on with capacity 1: students are queued, admitted in order by the admitter, and all get in', async () => {
    await db('policies').update({ queue_enabled: true, queue_capacity: 1, queue_batch: 1, queue_interval_sec: 1 });
    const app = buildRealApp({ db, redis });
    const server = await listen(app);
    const policy = { queue_capacity: 1, queue_batch: 1, queue_interval_sec: 1 };
    const admitter = setInterval(() => app.get('services').waitingRoom.admitBatch(policy).catch(() => {}), 500);
    try {
      const { summary } = await runRushHour({
        baseUrl: `http://127.0.0.1:${server.address().port}`, users: 3, rampSec: 0, password: PASSWORDS.student,
      });
      expect(summary.succeeded).toBe(3);
      expect(summary.queuedStudents).toBeGreaterThanOrEqual(1);
      expect(summary.queueWaitMeanMs).toBeGreaterThan(0);
    } finally {
      clearInterval(admitter);
    }
  });

  test('wrong passwords are reported as failed, not retried forever', async () => {
    await db('policies').update({ queue_enabled: false });
    const server = await listen(buildRealApp({ db, redis }));
    const { summary } = await runRushHour({
      baseUrl: `http://127.0.0.1:${server.address().port}`, users: 2, rampSec: 0, password: 'Not-The-Password-1!',
    });
    expect(summary).toMatchObject({ succeeded: 0, failed: 2 });
  });

  describe('the admin "Simulate rush hour" runner', () => {
    const { createSimulator, SimulatorError } = require('../../app/src/services/simulator');
    const quiet = { info() {}, warn() {} };

    test('refused in production and for bad sizes', async () => {
      await expect(createSimulator({ redis, config: { nodeEnv: 'production', port: 1 }, logger: quiet }).start({ users: 10, rampSec: 1, actor: 'admin:1' }))
        .rejects.toBeInstanceOf(SimulatorError);
      const sim = createSimulator({ redis, config: { nodeEnv: 'test', port: 1 }, logger: quiet });
      await expect(sim.start({ users: 0, rampSec: 1, actor: 'admin:1' })).rejects.toThrow(/1 to 2000/);
      await expect(sim.start({ users: 5000, rampSec: 1, actor: 'admin:1' })).rejects.toThrow(/1 to 2000/);
    });

    test('runs the generator in a separate process against this server, one run at a time, and records the summary', async () => {
      await db('policies').update({ queue_enabled: false });
      const app = buildRealApp({ db, redis, env: { RATE_LIMIT_IP_PER_MIN: '2' } }); // would block a normal 3-student run
      const server = await listen(app);
      const previous = process.env.SEED_STUDENT_PASSWORD;
      process.env.SEED_STUDENT_PASSWORD = PASSWORDS.student;
      try {
        const sim = createSimulator({ redis, config: { nodeEnv: 'test', port: server.address().port }, logger: quiet });
        expect((await sim.start({ users: 3, rampSec: 0, actor: 'admin:1' })).state).toBe('running');
        await expect(sim.start({ users: 3, rampSec: 0, actor: 'admin:1' })).rejects.toThrow(/already running/);
        let s;
        for (let i = 0; i < 120; i += 1) {
          s = await sim.status();
          if (s.state !== 'running') break;
          await new Promise((r) => setTimeout(r, 500));
        }
        expect(s.state).toBe('finished');
        expect(s.summary).toMatchObject({ users: 3, succeeded: 3, rateLimited: 0 }); // the run token lifted the per-IP limit
        expect(await redis.get('cg:sim:token')).toBeNull(); // token gone after the run
        expect(await sim.isRunToken('anything')).toBe(false);
      } finally {
        process.env.SEED_STUDENT_PASSWORD = previous;
      }
    });

    test('without the run token, the same traffic IS limited per IP', async () => {
      await db('policies').update({ queue_enabled: false });
      const server = await listen(buildRealApp({ db, redis, env: { RATE_LIMIT_IP_PER_MIN: '2' } }));
      const { summary } = await runRushHour({
        baseUrl: `http://127.0.0.1:${server.address().port}`, users: 3, rampSec: 0, password: PASSWORDS.student, giveUpMs: 3000,
        extraHeaders: { 'X-CampusGate-Simulation': 'forged-token' },
      });
      expect(summary.rateLimited).toBeGreaterThan(0);
    });
  });

  test('summary statistics and CSV output', () => {
    const rows = [
      { identifier: 'A', arrivalMs: 0, outcome: 'success', signInMs: 100, attempts: 1, timeouts: 0, rateLimited: 0, queued: false, queueWaitMs: 0, httpErrors: 0, loginRequestMs: [90], finalStatus: 200 },
      { identifier: 'B', arrivalMs: 10, outcome: 'success', signInMs: 300, attempts: 2, timeouts: 1, rateLimited: 0, queued: true, queueWaitMs: 50, httpErrors: 0, loginRequestMs: [10000, 250], finalStatus: 200 },
      { identifier: 'C', arrivalMs: 20, outcome: 'gave_up', signInMs: null, attempts: 4, timeouts: 4, rateLimited: 0, queued: false, queueWaitMs: 0, httpErrors: 0, loginRequestMs: [], finalStatus: null },
    ];
    const s = summarize(rows, { users: 3, rampSec: 1, timeoutMs: 10000, maxRetries: 3, wallSec: 2 });
    expect(s).toMatchObject({ succeeded: 2, gaveUp: 1, successRatePct: 66.7, signInMeanMs: 200, signInP95Ms: 300, timeouts: 5, queuedStudents: 1, signInsPerSec: 1 });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-')), 'run.csv');
    writeCsv(file, rows);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines[0]).toBe('identifier,arrivalMs,outcome,signInMs,attempts,timeouts,rateLimited,queued,queueWaitMs,httpErrors,finalStatus');
    expect(lines[3]).toBe('C,20,gave_up,,4,4,0,false,0,0,');
  });
});
