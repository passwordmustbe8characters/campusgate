'use strict';

const request = require('supertest');
const {
  connectDb, connectRedis, buildRealApp, resetAndSeed, csrfAgent, cookieFrom, userRow, captureDelivery,
  enableEmail2fa, listen, REGISTERED, PASSWORDS,
} = require('./helpers');

describe('interim account ticket (Phase 2) against real PostgreSQL + Redis', () => {
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

  async function signedIn(identifier = student.matric_no, password = PASSWORDS.student) {
    const delivery = captureDelivery();
    const app = buildRealApp({ db, redis, delivery });
    const agent = await csrfAgent(app);
    const res = await agent.post('/auth/login', { identifier, password });
    expect(res.body.status).toBe('signed_in');
    return { ...agent, delivery, res, app };
  }

  test('a completed sign-in issues a short-lived account ticket (10 min TTL) in Redis', async () => {
    const { res } = await signedIn();
    expect(cookieFrom(res, 'cg.acct')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('cg.acct='));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Max-Age=600/);
    const [key] = (await redis.keys('cg:acct:*')).filter((k) => !k.includes(':user:'));
    expect(await redis.ttl(key)).toBeGreaterThan(590);
  });

  test('the security page needs the ticket: without it, GET redirects to /login', async () => {
    const app = buildRealApp({ db, redis });
    const res = await request(await listen(app)).get('/account/security');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');

    const { agent } = await signedIn();
    const page = await agent.get('/account/security');
    expect(page.status).toBe(200);
    expect(page.text).toContain(student.matric_no);
  });

  test('enable email 2FA with the account ticket: code sent, confirmed, next sign-in needs the code', async () => {
    const { post, delivery } = await signedIn();
    const start = await post('/auth/2fa/email/enable');
    expect(start.status).toBe(200);
    expect(delivery.sent).toHaveLength(1);

    expect((await post('/auth/2fa/email/confirm', { code: delivery.lastCode() === '000000' ? '111111' : '000000' })).status).toBe(400);
    const ok = await post('/auth/2fa/email/confirm', { code: delivery.lastCode() });
    expect(ok.status).toBe(200);
    expect(await userRow(db, student.matric_no)).toMatchObject({ two_factor_enabled: true, two_factor_method: 'email' });

    const again = await csrfAgent(buildRealApp({ db, redis }));
    const login = await again.post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
    expect(login.body).toMatchObject({ status: 'second_factor_required', method: 'email' });
  });

  test('the account ticket is NOT accepted by sign-in endpoints', async () => {
    const { post } = await signedIn();
    for (const url of ['/auth/otp', '/auth/otp/resend']) {
      const res = await post(url, { code: '123456' });
      expect(res.status).toBe(401);
      expect(res.body.restart).toBe(true);
    }
  });

  test('a pre-auth ticket is NOT accepted by the security-settings endpoints', async () => {
    await enableEmail2fa(db, student.matric_no);
    const app = buildRealApp({ db, redis });
    const { post, agent } = await csrfAgent(app);
    const login = await post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
    expect(cookieFrom(login, 'cg.preauth')).toBeDefined();

    expect((await post('/auth/2fa/email/enable')).status).toBe(401);
    expect((await post('/auth/2fa/email/confirm', { code: '123456' })).status).toBe(401);
    expect((await agent.get('/account/security')).status).toBe(302);
  });

  test('an expired (deleted) account ticket is rejected', async () => {
    const { post } = await signedIn();
    await redis.flushdb();
    const res = await post('/auth/2fa/email/enable');
    expect(res.status).toBe(401);
    expect(res.body.restart).toBe(true);
  });

  test('settings endpoints still require CSRF even with a valid account ticket', async () => {
    const { agent } = await signedIn();
    const res = await agent.post('/auth/2fa/email/enable').send({});
    expect(res.status).toBe(403);
  });
});
