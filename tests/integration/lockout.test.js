'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  connectDb, connectRedis, buildRealApp, resetAndSeed, csrfAgent, userRow, captureLogs, REGISTERED, PASSWORDS,
} = require('./helpers');
const { testUrls } = require('./testEnv');
const { createHasher } = require('../../app/src/services/passwordHasher');
const { unlockUser, listLockedUsers } = require('../../app/src/services/userService');

const run = promisify(execFile);
const ROOT = path.join(__dirname, '..', '..');
const WRONG = 'Wrong-Password-1!';

describe('temporary lockout (FR-A6, FR-P5) against real PostgreSQL', () => {
  let db;
  let redis;
  let app;
  const student = REGISTERED[0];
  const login = (post, password = WRONG) => post('/auth/login', { identifier: student.matric_no, password });

  beforeAll(() => {
    db = connectDb();
    redis = connectRedis();
    app = buildRealApp({ db, redis });
  });
  beforeEach(() => resetAndSeed(db));
  afterAll(async () => {
    await db.destroy();
    redis.disconnect();
  });

  test('5 wrong passwords lock the account for the policy lockout time', async () => {
    const { post } = await csrfAgent(app);
    for (let i = 1; i <= 4; i += 1) {
      await login(post);
      const row = await userRow(db, student.matric_no);
      expect(row.failed_attempts).toBe(i);
      expect(row.locked_until).toBeNull();
    }
    await login(post);

    const { rows } = await db.raw(
      `SELECT failed_attempts,
              EXTRACT(EPOCH FROM (locked_until - now())) / 60 AS minutes_left
       FROM users WHERE matric_or_staff_id = ?`,
      [student.matric_no],
    );
    expect(rows[0].failed_attempts).toBe(5);
    expect(Number(rows[0].minutes_left)).toBeGreaterThan(14.9);
    expect(Number(rows[0].minutes_left)).toBeLessThanOrEqual(15);
  });

  test('while locked, even the correct password is refused, and attempts neither count nor extend the lock', async () => {
    const { post } = await csrfAgent(app);
    for (let i = 0; i < 5; i += 1) await login(post);
    const locked = await userRow(db, student.matric_no);

    expect((await login(post, PASSWORDS.student)).status).toBe(401);
    for (let i = 0; i < 3; i += 1) await login(post);

    const after = await userRow(db, student.matric_no);
    expect(after.failed_attempts).toBe(5);
    expect(after.locked_until).toEqual(locked.locked_until);
  });

  test('after the lock expires the user can log in, and the counter starts fresh', async () => {
    const { post } = await csrfAgent(app);
    await db('users').where({ matric_or_staff_id: student.matric_no })
      .update({ failed_attempts: 5, locked_until: db.raw("now() - interval '1 second'") });

    expect((await login(post)).status).toBe(401);
    let row = await userRow(db, student.matric_no);
    expect(row.failed_attempts).toBe(1); // fresh count, not 6
    expect(row.locked_until).toBeNull();

    expect((await login(post, PASSWORDS.student)).status).toBe(200);
    row = await userRow(db, student.matric_no);
    expect(row.failed_attempts).toBe(0);
  });

  test('admin unlock (service) clears the lock and the user can log in again', async () => {
    const { post } = await csrfAgent(app);
    for (let i = 0; i < 5; i += 1) await login(post);
    expect((await listLockedUsers(db)).map((u) => u.matric_or_staff_id)).toEqual([student.matric_no]);

    const row = await unlockUser(db, student.matric_no.toLowerCase());
    expect(row).toMatchObject({ matric_or_staff_id: student.matric_no, failed_attempts: 0, locked_until: null });
    expect(await listLockedUsers(db)).toEqual([]);
    expect((await login(post, PASSWORDS.student)).status).toBe(200);
  });

  test('admin unlock (CLI: npm run admin -- unlock / locked / status) works end to end', async () => {
    const { post } = await csrfAgent(app);
    for (let i = 0; i < 5; i += 1) await login(post);
    const cli = (...args) => run(process.execPath, [path.join(ROOT, 'scripts', 'admin-cli.js'), ...args], {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: testUrls().databaseUrl, LOG_LEVEL: 'silent' },
    });

    expect((await cli('locked')).stdout).toContain(student.matric_no);
    expect((await cli('unlock', student.email)).stdout).toContain(`Unlocked ${student.matric_no}`);
    expect((await cli('locked')).stdout).toContain('No accounts are locked.');
    expect(JSON.parse((await cli('status', student.matric_no)).stdout)).toMatchObject({ failed_attempts: 0, is_locked: false });
    await expect(cli('unlock', 'NOBODY/0000')).rejects.toMatchObject({ code: 1 });
    expect((await login(post, PASSWORDS.student)).status).toBe(200);
  });

  test('10 simultaneous wrong logins: exact count of 5, locked once', async () => {
    const { lines, logger } = captureLogs();
    const loggedApp = buildRealApp({ db, redis, logger });
    const { post } = await csrfAgent(loggedApp);

    const results = await Promise.all(Array.from({ length: 10 }, () => login(post)));
    expect(results.every((r) => r.status === 401)).toBe(true);

    const row = await userRow(db, student.matric_no);
    expect(row.failed_attempts).toBe(5);
    expect(row.locked_until).not.toBeNull();
    const lockoutEvents = lines.map((l) => JSON.parse(l)).filter((l) => l.event === 'lockout');
    expect(lockoutEvents).toHaveLength(1);
  });

  test('lockout threshold follows the live policy row (max_attempts=3, no restart)', async () => {
    await db('policies').where({ id: 1 }).update({ max_attempts: 3, lockout_minutes: 2 });
    const { post } = await csrfAgent(app);
    for (let i = 0; i < 3; i += 1) await login(post);

    const row = await userRow(db, student.matric_no);
    expect(row.failed_attempts).toBe(3);
    expect(row.locked_until).not.toBeNull();
    const res = await login(post, PASSWORDS.student);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/paused for 2 minutes/);
  });

  describe('FR-P5: system failures never count toward lockout', () => {
    test('a bcrypt failure/timeout returns 500 and does not increment the counter', async () => {
      const real = createHasher(4);
      const failing = { ...real, compare: async () => { throw new Error('simulated hashing timeout'); } };
      const { post } = await csrfAgent(buildRealApp({ db, redis, hasher: failing }));

      for (let i = 0; i < 6; i += 1) expect((await login(post)).status).toBe(500);
      const row = await userRow(db, student.matric_no);
      expect(row.failed_attempts).toBe(0);
      expect(row.locked_until).toBeNull();
    });

    test('a DB connection timeout (pool exhausted) returns 503 and does not increment the counter', async () => {
      const tinyDb = connectDb({ pool: { min: 0, max: 1 }, acquireConnectionTimeout: 300 });
      const { post } = await csrfAgent(buildRealApp({ db: tinyDb, redis }));
      const trx = await tinyDb.transaction(); // hold the only connection
      try {
        for (let i = 0; i < 6; i += 1) expect((await login(post)).status).toBe(503);
      } finally {
        await trx.rollback();
        await tinyDb.destroy();
      }
      const row = await userRow(db, student.matric_no);
      expect(row.failed_attempts).toBe(0);
      expect(row.locked_until).toBeNull();
    });

    test('invalid input (400) does not count', async () => {
      const { post } = await csrfAgent(app);
      for (let i = 0; i < 6; i += 1) {
        expect((await post('/auth/login', { identifier: student.matric_no, password: '' })).status).toBe(400);
      }
      expect((await userRow(db, student.matric_no)).failed_attempts).toBe(0);
    });
  });
});
