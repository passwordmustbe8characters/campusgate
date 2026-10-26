'use strict';

const request = require('supertest');
const {
  connectDb, connectRedis, buildRealApp, resetAndSeed, csrfAgent, userRow, listen, REGISTERED, PASSWORDS,
} = require('./helpers');

describe('rate limiting per IP and per account (FR-P4) against real Redis', () => {
  let db;
  let redis;
  const student = REGISTERED[0];

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

  const appWith = (ip, account) => buildRealApp({
    db, redis, env: { RATE_LIMIT_IP_PER_MIN: String(ip), RATE_LIMIT_ACCOUNT_PER_MIN: String(account) },
  });

  test('per account: the 4th sign-in attempt in a minute gets 429 + Retry-After, and is NOT counted toward lockout', async () => {
    const { post } = await csrfAgent(appWith(1000, 3));
    for (let i = 0; i < 3; i += 1) {
      expect((await post('/auth/login', { identifier: student.matric_no, password: 'Wrong-Password-1!' })).status).toBe(401);
    }
    const limited = await post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
    expect(limited.status).toBe(429);
    const retry = Number(limited.headers['retry-after']);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
    expect(limited.body.error).toMatch(/Too many attempts/);
    expect((await userRow(db, student.matric_no)).failed_attempts).toBe(3); // the limited attempt never reached the check
  });

  test('the account limit follows the account however it is typed (case, spaces, email vs. ID are separate accounts)', async () => {
    const { post } = await csrfAgent(appWith(1000, 2));
    await post('/auth/login', { identifier: student.matric_no.toLowerCase(), password: 'x' });
    await post('/auth/login', { identifier: `  ${student.matric_no}  `, password: 'x' });
    expect((await post('/auth/login', { identifier: student.matric_no, password: 'x' })).status).toBe(429);
    // A different account is not affected.
    expect((await post('/auth/login', { identifier: REGISTERED[1].matric_no, password: PASSWORDS.student })).status).toBe(200);
  });

  test('per IP: a flood across many accounts from one address is limited', async () => {
    const { post } = await csrfAgent(appWith(5, 1000));
    for (let i = 0; i < 5; i += 1) await post('/auth/login', { identifier: `NOBODY/${i}`, password: 'x' });
    expect((await post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student })).status).toBe(429);
  });

  test('Redis stores only a keyed hash of the account, never the identifier', async () => {
    const { post } = await csrfAgent(appWith(1000, 10));
    await post('/auth/login', { identifier: student.email, password: 'x' });
    const keys = await redis.keys('cg:rl:*');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.join(' ')).not.toContain(student.email);
    expect(keys.join(' ')).not.toContain(student.matric_no);
  });

  test('registration, forgot-password and second-factor endpoints are limited too', async () => {
    const { post } = await csrfAgent(appWith(2, 1000));
    for (const [url, body] of [
      ['/auth/password/forgot', { email: student.email }],
      ['/auth/register', { matricNo: 'SCI/2019/1', email: 'a@example.com', password: 'x', consent: true }],
      ['/auth/otp', { code: '123456' }],
    ]) {
      await post(url, body);
      await post(url, body);
      const res = await post(url, body);
      expect(`${url}:${res.status}`).toBe(`${url}:429`);
    }
  });

  test('the window resets: after it expires, sign-in works again', async () => {
    const { post } = await csrfAgent(appWith(1000, 1));
    await post('/auth/login', { identifier: student.matric_no, password: 'x' });
    expect((await post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student })).status).toBe(429);
    for (const key of await redis.keys('cg:rl:*')) await redis.del(key); // what the 60 s expiry does
    expect((await post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student })).status).toBe(200);
  });

  test('Redis down: the limiter lets sign-in through (fail open) and logs it', async () => {
    const broken = connectRedis('redis://127.0.0.1:1', { maxRetriesPerRequest: 0, enableOfflineQueue: false, lazyConnect: true });
    const app = buildRealApp({ db, redis: broken, env: { RATE_LIMIT_ACCOUNT_PER_MIN: '1' } });
    const server = await listen(app);
    const page = await request(server).get('/login');
    const csrf = /name="csrf-token" content="([^"]+)"/.exec(page.text)[1];
    const cookie = page.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
    for (let i = 0; i < 3; i += 1) {
      const res = await request(server).post('/auth/login').set('Cookie', cookie).set('X-CSRF-Token', csrf)
        .send({ identifier: student.matric_no, password: PASSWORDS.student });
      expect(res.status).toBe(200);
    }
  });
});
