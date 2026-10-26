'use strict';

const jwt = require('jsonwebtoken');
const request = require('supertest');
const {
  connectDb, connectRedis, buildRealApp, resetAndSeed, csrfAgent, cookieFrom, userRow, captureDelivery,
  enableEmail2fa, listen, waitFor, REGISTERED, PASSWORDS, TEST_KEYS,
} = require('./helpers');
const { ISSUER, AUDIENCE } = require('../../app/src/services/sessions');

const SECRET = Buffer.from(TEST_KEYS.jwtSecret, 'base64url');

describe('login-once session (Phase 4) against real PostgreSQL + Redis', () => {
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

  async function signedIn({ identifier = student.matric_no, password = PASSWORDS.student, app } = {}) {
    const delivery = captureDelivery();
    const theApp = app || buildRealApp({ db, redis, delivery });
    const agent = await csrfAgent(theApp);
    const res = await agent.post('/auth/login', { identifier, password });
    expect(res.body.status).toBe('signed_in');
    return { ...agent, delivery, res, app: theApp, token: cookieFrom(res, 'cg.session') };
  }

  const auditTypes = async () => (await db('auth_logs').orderBy('seq').pluck('event_type'));

  test('sign-in sets the session cookie: HttpOnly, SameSite=Strict, lifetime = policies.session_timeout_min', async () => {
    const { res, token } = await signedIn();
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('cg.session='));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Max-Age=1800/); // default policy: 30 minutes
    expect(cookie).not.toMatch(/Secure/); // COOKIE_SECURE is off in tests (no HTTPS until Phase 9)
    const claims = jwt.verify(token, SECRET, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
    expect(claims.exp - claims.iat).toBe(1800);
    expect(await db('sessions').where({ jti: claims.jti }).first()).toMatchObject({ scope: 'full', revoked_at: null });
    expect(cookieFrom(res, 'cg.acct')).toBeUndefined(); // the Phase 2 interim ticket is gone
  });

  test('a policy change to session_timeout_min applies to the next sign-in without a restart', async () => {
    const app = buildRealApp({ db, redis });
    await db('policies').update({ session_timeout_min: 45 });
    const { res } = await signedIn({ app });
    expect(res.headers['set-cookie'].find((c) => c.startsWith('cg.session='))).toMatch(/Max-Age=2700/);
  });

  test('the security page needs a session: without one, GET redirects to /login', async () => {
    const res = await request(await listen(buildRealApp({ db, redis }))).get('/account/security');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');

    const { agent } = await signedIn();
    const page = await agent.get('/account/security');
    expect(page.status).toBe(200);
    expect(page.text).toContain(student.matric_no);
  });

  test('enable email 2FA with a session: code sent, confirmed, next sign-in needs the code', async () => {
    const { post, delivery } = await signedIn();
    expect((await post('/auth/2fa/email/enable')).status).toBe(200);
    expect(delivery.sent).toHaveLength(1);
    expect((await post('/auth/2fa/email/confirm', { code: delivery.lastCode() })).status).toBe(200);
    expect(await userRow(db, student.matric_no)).toMatchObject({ two_factor_enabled: true, two_factor_method: 'email' });

    const again = await csrfAgent(buildRealApp({ db, redis }));
    const login = await again.post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
    expect(login.body).toMatchObject({ status: 'second_factor_required', method: 'email' });
  });

  test('security changes need a RECENT sign-in (10 min); an older but valid session can still view the page', async () => {
    const user = await userRow(db, student.matric_no);
    const server = await listen(buildRealApp({ db, redis }));
    const page = await request(server).get('/login');
    const csrf = /name="csrf-token" content="([^"]+)"/.exec(page.text)[1];
    const issuedAt = Math.floor(Date.now() / 1000) - 11 * 60;
    const old = jwt.sign({ sub: String(user.id), role: 'student', scope: 'full', iat: issuedAt }, SECRET,
      { algorithm: 'HS256', expiresIn: 30 * 60, jwtid: '00000000-0000-4000-8000-0000000000aa', issuer: ISSUER, audience: AUDIENCE });
    // Pre-session + CSRF cookies from the page, plus the 11-minute-old session token.
    const cookie = [...page.headers['set-cookie'].map((c) => c.split(';')[0]), `cg.session=${old}`].join('; ');

    expect((await request(server).get('/account/security').set('Cookie', cookie)).status).toBe(200);
    const res = await request(server).post('/auth/password/change').set('Cookie', cookie).set('X-CSRF-Token', csrf)
      .send({ currentPassword: PASSWORDS.student, newPassword: 'Another-Pass1!x' });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ restart: true });
    expect(res.body.error).toMatch(/sign in again/);
  });

  test('a pre-auth ticket is NOT accepted by the security-settings endpoints', async () => {
    await enableEmail2fa(db, student.matric_no);
    const { post, agent } = await csrfAgent(buildRealApp({ db, redis }));
    const login = await post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
    expect(cookieFrom(login, 'cg.preauth')).toBeDefined();
    expect(cookieFrom(login, 'cg.session')).toBeUndefined();
    expect((await post('/auth/2fa/email/enable')).status).toBe(401);
    expect((await agent.get('/account/security')).status).toBe(302);
  });

  test('a session is NOT accepted by the sign-in endpoints', async () => {
    const { post } = await signedIn();
    for (const url of ['/auth/otp', '/auth/otp/resend']) {
      const res = await post(url, { code: '123456' });
      expect(res.status).toBe(401);
      expect(res.body.restart).toBe(true);
    }
  });

  test('tampered and expired tokens are refused, and the bad cookie is cleared', async () => {
    const { agent, token } = await signedIn();
    const [h, , s] = token.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...jwt.decode(token), role: 'admin' })).toString('base64url')}.${s}`;
    const expired = jwt.sign({ sub: '1', role: 'student', scope: 'full', iat: 1000 }, SECRET,
      { algorithm: 'HS256', expiresIn: 60, jwtid: 'x', issuer: ISSUER, audience: AUDIENCE });
    for (const bad of [forged, expired]) {
      const res = await request(agent.app).get('/account/security').set('Cookie', `cg.session=${bad}`);
      expect(res.status).toBe(302);
      expect(res.headers['set-cookie'].join(';')).toMatch(/cg\.session=;/);
    }
  });

  test('sign out: the same token is refused afterwards, the record is closed, and it is audited', async () => {
    const { post, agent, token } = await signedIn();
    const res = await post('/auth/logout');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie'].join(';')).toMatch(/cg\.session=;/);

    // Replaying the old cookie (e.g. copied before sign-out) must not work.
    const replay = await request(agent.app).get('/account/security').set('Cookie', `cg.session=${token}`);
    expect(replay.status).toBe(302);
    const { jti } = jwt.decode(token);
    expect(await db('sessions').where({ jti }).first()).toMatchObject({ revoke_reason: 'logout' });
    expect(await auditTypes()).toEqual(expect.arrayContaining(['login_success', 'logout']));
  });

  test('sign out everywhere ends the sessions on every device, but not other users\' sessions', async () => {
    const phone = await signedIn();
    const laptop = await signedIn();
    const otherUser = await signedIn({ identifier: REGISTERED[1].matric_no });
    const res = await laptop.post('/auth/logout-all');
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/2 sessions ended/);

    expect((await phone.agent.get('/account/security')).status).toBe(302);
    expect((await otherUser.agent.get('/account/security')).status).toBe(200);
    const row = await db('auth_logs').where({ event_type: 'logout_all' }).first();
    expect(row.details).toEqual({ count: 2 });
  });

  test('password change signs the user out everywhere (FR-A10), including other devices', async () => {
    const phone = await signedIn();
    const laptop = await signedIn();
    const res = await laptop.post('/auth/password/change', { currentPassword: PASSWORDS.student, newPassword: 'Another-Pass1!x' });
    expect(res.status).toBe(200);
    expect((await phone.agent.get('/account/security')).status).toBe(302);
    expect((await laptop.agent.get('/account/security')).status).toBe(302);
    await waitFor(async () => db('auth_logs').where({ event_type: 'sessions_revoked' }).first());
    const row = await db('auth_logs').where({ event_type: 'sessions_revoked' }).first();
    expect(row.details).toEqual({ reason: 'password_changed', count: 2 });
  });

  test('Redis down: protected pages FAIL CLOSED with 503, never accepting an unchecked token', async () => {
    const { token } = await signedIn();
    const broken = connectRedis('redis://127.0.0.1:1', { maxRetriesPerRequest: 0, enableOfflineQueue: false, lazyConnect: true });
    const app = buildRealApp({ db, redis: broken });
    const res = await request(await listen(app)).get('/account/security').set('Cookie', `cg.session=${token}`);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unavailable/);
    expect(res.text).not.toContain(student.matric_no);
  });

  test('settings endpoints still require CSRF even with a valid session', async () => {
    const { agent } = await signedIn();
    expect((await agent.post('/auth/2fa/email/enable').send({})).status).toBe(403);
    expect((await agent.post('/auth/logout').send({})).status).toBe(403);
  });
});
