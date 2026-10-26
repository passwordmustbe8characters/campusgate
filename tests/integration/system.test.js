'use strict';

const request = require('supertest');
const {
  connectDb, connectRedis, buildRealApp, resetAndSeed, csrfAgent, captureLogs, FREE, REGISTERED, PASSWORDS,
} = require('./helpers');
const { createHasher } = require('../../app/src/services/passwordHasher');

describe('whole app against real PostgreSQL and Redis', () => {
  let db;
  let redis;

  beforeAll(async () => {
    db = connectDb();
    redis = connectRedis();
    await resetAndSeed(db);
  });
  afterAll(async () => {
    await db.destroy();
    redis.disconnect();
  });

  test('/health is 200 with both real dependencies up', async () => {
    const res = await request(buildRealApp({ db, redis })).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.checks).toMatchObject({ postgres: { status: 'ok' }, redis: { status: 'ok' } });
  });

  test('Redis test DB is reachable and isolated (index 15)', async () => {
    await redis.set('cg:test:probe', '1', 'EX', 10);
    expect(await redis.get('cg:test:probe')).toBe('1');
    expect(redis.options.db).toBe(15);
  });

  test('register and login pages render with escaped output and the live password rules', async () => {
    const app = buildRealApp({ db, redis });
    const register = await request(app).get('/register');
    expect(register.status).toBe(200);
    expect(register.text).toContain('At least 8 characters');
    expect(register.text).toContain('Privacy notice');
    const login = await request(app).get('/login?registered=1');
    expect(login.text).toContain('Account created');
  });

  test('POST without CSRF token is refused (403) and does not count as a failed login', async () => {
    const app = buildRealApp({ db, redis });
    const res = await request(app).post('/auth/login').send({ identifier: REGISTERED[0].matric_no, password: 'x' });
    expect(res.status).toBe(403);
    const row = await db('users').where({ matric_or_staff_id: REGISTERED[0].matric_no }).first();
    expect(row.failed_attempts).toBe(0);
  });

  test('SQL injection attempts in login fields are treated as plain text', async () => {
    const { post } = await csrfAgent(buildRealApp({ db, redis }));
    for (const identifier of ["' OR '1'='1", "SCI/2022/0001' --", "x'; DROP TABLE users; --", "a@b.co' OR 1=1 --"]) {
      expect((await post('/auth/login', { identifier, password: "' OR '1'='1" })).status).toBe(401);
    }
    expect(Number((await db('users').count('* as n'))[0].n)).toBeGreaterThan(0);
  });

  test('database error details (pg `detail` with a token hash) never reach the logs of the real app', async () => {
    // Get a GENUINE PostgreSQL unique-violation error whose `detail` contains a hash value.
    const user = await db('users').where({ matric_or_staff_id: REGISTERED[0].matric_no }).first('id');
    const leak = 'LEAK-CHECK-TOKEN-HASH-7f3a9c';
    const row = { user_id: user.id, token_hash: leak, expires_at: db.fn.now() };
    await db('password_reset_tokens').insert(row);
    const pgError = await db('password_reset_tokens').insert(row).catch((err) => err);
    await db('password_reset_tokens').where({ token_hash: leak }).del();
    expect(pgError.code).toBe('23505');
    expect(pgError.detail).toContain(leak); // the value really is in the pg error

    // Push it through the real app (pino-http request logger + error handler) by
    // making the injected hasher throw it during a login.
    const { lines, logger } = captureLogs();
    const hasher = { ...createHasher(4), compare: async () => { throw pgError; } };
    const { post } = await csrfAgent(buildRealApp({ db, redis, logger, hasher }));
    const res = await post('/auth/login', { identifier: REGISTERED[0].matric_no, password: PASSWORDS.student });

    expect(res.status).toBe(500);
    expect(res.text).not.toContain(leak);
    const output = lines.join('');
    expect(output).toContain('23505'); // the error was logged (code kept for debugging)...
    expect(output).not.toContain(leak); // ...but not the value from `detail`
  });

  test('passwords never appear in the logs (register, failed login, successful login)', async () => {
    const { lines, logger } = captureLogs();
    const { post } = await csrfAgent(buildRealApp({ db, redis, logger }));
    const newPassword = 'Unique-Log-Check-77!';

    expect((await post('/auth/register', { matricNo: FREE[0].matric_no, email: 'log@example.com', password: newPassword, consent: true })).status).toBe(201);
    await db('users').where({ matric_or_staff_id: FREE[0].matric_no }).update({ email_verified: true }); // FR-A2 step, tested in emailVerification.test.js
    expect((await post('/auth/login', { identifier: FREE[0].matric_no, password: 'Another-Wrong-55!' })).status).toBe(401);
    expect((await post('/auth/login', { identifier: FREE[0].matric_no, password: newPassword })).status).toBe(200);

    const output = lines.join('');
    expect(lines.length).toBeGreaterThan(3);
    for (const secret of [newPassword, 'Another-Wrong-55!', PASSWORDS.student]) {
      expect(output).not.toContain(secret);
    }
    expect(output).not.toMatch(/\$2b\$/); // no hashes either
    expect(output).toContain('[REDACTED]'); // cookie header redacted
  });
});
