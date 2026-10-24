'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  connectDb, connectRedis, buildRealApp, resetAndSeed, csrfAgent, captureLogs, captureDelivery, userRow,
  waitFor, trackForTeardown, cliEnv, TEST_KEYS, REGISTERED, PASSWORDS,
} = require('./helpers');
const { createLogger } = require('../../app/src/logger');
const { createAuditWriter } = require('../../app/src/audit/writer');
const { createAuditQueue, STREAM } = require('../../app/src/audit/queue');
const { verifyChain, readAnchor } = require('../../app/src/audit/chain');
const { buildEvent } = require('../../app/src/audit/events');

const ROOT = path.join(__dirname, '..', '..');
const AUDIT_KEY = Buffer.from(TEST_KEYS.auditHmacKey, 'base64url');
const quiet = createLogger({ level: 'silent' });
const QUEUE = { AUDIT_MODE: 'queue' };

async function withAuditWritesFailing(db, fn) {
  await db.raw('ALTER TABLE auth_logs ADD CONSTRAINT audit_test_reject CHECK (false) NOT VALID');
  try {
    return await fn();
  } finally {
    await db.raw('ALTER TABLE auth_logs DROP CONSTRAINT audit_test_reject');
  }
}

describe('audit queue mode: Redis Stream + single writer (FR-L3, Phase 3.3)', () => {
  let db;
  let redis;
  const student = REGISTERED[0];
  const countRows = async () => Number((await db('auth_logs').count('* as n'))[0].n);
  const writer = (opts = {}) => createAuditWriter({ db, redis, key: AUDIT_KEY, logger: quiet, blockMs: 0, ...opts });
  const drain = async (w = writer()) => { while ((await redis.xlen(STREAM)) > 0) await w.runOnce(); };

  beforeAll(() => {
    db = connectDb();
    redis = connectRedis();
  });
  beforeEach(async () => {
    await resetAndSeed(db);
    await redis.flushdb(); // also removes the stream and its consumer group
  });
  afterAll(async () => {
    await db.destroy();
    redis.disconnect();
  });

  async function login(env = QUEUE, { logger, identifier = student.matric_no, password = PASSWORDS.student, redisClient = redis } = {}) {
    const { post } = await csrfAgent(buildRealApp({ db, redis: redisClient, env, logger }));
    return post('/auth/login', { identifier, password });
  }

  test('a login only queues its event (no chain write on the login path); the writer commits it', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(await countRows()).toBe(0);
    expect(await redis.xlen(STREAM)).toBe(1);

    await writer().runOnce();
    expect(await redis.xlen(STREAM)).toBe(0);
    const [row] = await db('auth_logs');
    expect(row).toMatchObject({ event_type: 'login_success', success: true });
    expect(Number(await redis.get('cg:metrics:audit_written'))).toBe(1);
    expect(await verifyChain(db, AUDIT_KEY, { anchor: await readAnchor(redis) })).toMatchObject({ ok: true, checked: 1 });
  });

  test('writer crash after the DB commit but before XACK: restart re-reads, skips by event_id; no loss, no duplicate', async () => {
    for (let i = 0; i < 5; i += 1) expect((await login()).status).toBe(200);
    const crashing = writer({ hooks: { afterCommit: async () => { throw new Error('simulated crash before XACK'); } } });
    await expect(crashing.runOnce()).rejects.toThrow(/simulated crash/);
    expect(await countRows()).toBe(5); // committed...
    expect(await redis.xlen(STREAM)).toBe(5); // ...but not acknowledged

    await writer().runOnce(); // "restarted" writer
    expect(await countRows()).toBe(5);
    expect(await redis.xlen(STREAM)).toBe(0);
    const ids = (await db('auth_logs').pluck('event_id'));
    expect(new Set(ids).size).toBe(5);
    expect((await verifyChain(db, AUDIT_KEY)).ok).toBe(true);
  });

  test('database rejecting writes: the writer acknowledges nothing; once the DB recovers, everything is written', async () => {
    for (let i = 0; i < 3; i += 1) await login();
    await withAuditWritesFailing(db, async () => {
      await expect(writer().runOnce()).rejects.toThrow();
      expect(await countRows()).toBe(0);
      expect(await redis.xlen(STREAM)).toBe(3);
    });
    await writer().runOnce();
    expect(await countRows()).toBe(3);
    expect(await redis.xlen(STREAM)).toBe(0);
  });

  test('queue full (AUDIT_QUEUE_MAX=3): logins never block; extra events are dropped, counted and logged as fallback', async () => {
    const { lines, logger } = captureLogs();
    const statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await login({ ...QUEUE, AUDIT_QUEUE_MAX: '3' }, { logger })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200]);
    expect(await redis.xlen(STREAM)).toBe(3);
    expect(Number(await redis.get('cg:metrics:audit_dropped'))).toBe(2);
    const fallbacks = lines.map((l) => JSON.parse(l)).filter((l) => l.auditFallback === true);
    expect(fallbacks).toHaveLength(2);
    expect(fallbacks[0].error.type).toBe('AuditQueueFullError');
    expect(fallbacks[0].auditEvent.event_type).toBe('login_success');
  });

  test('Redis down in queue mode: a password-only login still succeeds (fail open, fallback line)', async () => {
    const { lines, logger } = captureLogs();
    const dead = connectRedis('redis://127.0.0.1:6390', { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0 });
    const res = await login(QUEUE, { logger, redisClient: dead });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('signed_in');
    expect(lines.some((l) => l.includes('AUDIT_FALLBACK'))).toBe(true);
  });

  test('50 concurrent logins in queue mode: all queued, then written once each, seq gap-free, chain intact', async () => {
    const agents = await Promise.all(Array.from({ length: 10 }, () => csrfAgent(buildRealApp({ db, redis, env: QUEUE }))));
    await Promise.all(Array.from({ length: 50 }, (_, i) =>
      agents[i % 10].post('/auth/login', { identifier: REGISTERED[i % 3].matric_no, password: i % 2 ? PASSWORDS.student : 'Wrong-Password-1!' })));
    expect(await countRows()).toBe(0);

    await drain();
    const all = await db('auth_logs').orderBy('seq');
    expect(all.length).toBeGreaterThanOrEqual(50);
    expect(all.map((r) => Number(r.seq))).toEqual(all.map((_, i) => i + 1));
    expect(new Set(all.map((r) => r.event_id)).size).toBe(all.length);
    expect(await verifyChain(db, AUDIT_KEY, { anchor: await readAnchor(redis) })).toMatchObject({ ok: true, checked: all.length });
  });

  test('graceful stop drains the queue: 2,000 queued events are all written before stop() returns', async () => {
    const queue = createAuditQueue({ redis, maxLength: 100000 });
    for (let i = 0; i < 2000; i += 1) {
      await queue.enqueue(buildEvent('login_success', { userId: 1, success: true, details: { method: 'password' } }, {}));
    }
    const w = writer({ batchSize: 300, blockMs: 50 });
    w.start();
    const { remaining } = await w.stop({ drainTimeoutMs: 60000 });
    expect(remaining).toBe(0);
    expect(await countRows()).toBe(2000);
    expect((await verifyChain(db, AUDIT_KEY)).ok).toBe(true);
  });

  test('fail-closed events stay synchronous in queue mode: a password change writes its row directly', async () => {
    const { post } = await csrfAgent(buildRealApp({ db, redis, env: QUEUE, delivery: captureDelivery() }));
    await post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
    const before = await redis.xlen(STREAM);
    const res = await post('/auth/password/change', { currentPassword: PASSWORDS.student, newPassword: 'Brand-New-Pass-42' });
    expect(res.status).toBe(200);
    expect(await db('auth_logs').where({ event_type: 'password_changed' })).toHaveLength(1); // already in the chain
    expect(await redis.xlen(STREAM)).toBe(before); // not queued

    const before2 = (await userRow(db, student.matric_no)).password_hash;
    const refused = await withAuditWritesFailing(db, async () => {
      const { post: post2 } = await csrfAgent(buildRealApp({ db, redis, env: QUEUE }));
      await post2('/auth/login', { identifier: student.matric_no, password: 'Brand-New-Pass-42' });
      return post2('/auth/password/change', { currentPassword: 'Brand-New-Pass-42', newPassword: 'Third-New-Pass-44' });
    });
    expect(refused.status).toBe(503);
    expect((await userRow(db, student.matric_no)).password_hash).toBe(before2);
  });

  test('queue length and lag are published as metrics', async () => {
    await login();
    const w = writer();
    await w.ensureGroup();
    const { length, lag } = await w.publishMetrics();
    expect(length).toBe(1);
    expect(lag).toBeGreaterThanOrEqual(0);
    expect(Number(await redis.get('cg:metrics:audit_queue_length'))).toBe(1);
  });

  test('AUDIT_MODE=sync writes on the login path (nothing queued)', async () => {
    expect((await login({ AUDIT_MODE: 'sync' })).status).toBe(200);
    expect(await countRows()).toBe(1);
    expect(await redis.xlen(STREAM)).toBe(0);
  });

  test('the writer service process: /health reports ok with queue length and lag, and it writes queued events', async () => {
    await login();
    const port = 3197;
    const child = spawn(process.execPath, [path.join(ROOT, 'app', 'src', 'audit', 'writerMain.js')], {
      cwd: ROOT,
      env: cliEnv({ AUDIT_WRITER_PORT: String(port) }),
      stdio: 'ignore',
    });
    trackForTeardown(child, async () => { if (child.exitCode === null) child.kill(); });
    try {
      const health = await waitFor(async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/health`);
          const body = await r.json();
          return r.status === 200 && body.queueLength === 0 ? body : null;
        } catch {
          return null;
        }
      }, { timeoutMs: 60000, intervalMs: 200 });
      expect(health).toMatchObject({ status: 'ok', queueLength: 0, queueLagMs: 0 });
      expect(await countRows()).toBe(1);
    } finally {
      child.kill();
    }
  });
});
