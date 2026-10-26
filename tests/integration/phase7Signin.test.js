'use strict';

const request = require('supertest');
const {
  connectDb, connectRedis, buildRealApp, resetAndSeed, csrfAgent, cookieFrom, userRow, captureDelivery, listen,
  REGISTERED, FREE, PASSWORDS,
} = require('./helpers');
const { createRiskService } = require('../../app/src/services/risk');
const { describeDevice } = require('../../app/src/services/deviceAlert');

const GOOD_PASSWORD = 'Kettle-Mango-42';
// 12:00 Lagos (11:00 UTC): not off-hours.
const NOON = { t: Date.UTC(2026, 9, 27, 11, 0, 0), now() { return this.t; } };

describe('Phase 7.1: email verification (FR-A2), risk score (FR-A11), new-device alert (FR-A12)', () => {
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

  const linkFrom = (delivery) => {
    const msg = [...delivery.sent].reverse().find((m) => /Confirm your CampusGate email/.test(m.subject));
    return msg && /#token=([A-Za-z0-9_-]{43})/.exec(msg.text)[1];
  };

  describe('email verification', () => {
    async function registered() {
      const delivery = captureDelivery();
      const app = buildRealApp({ db, redis, delivery });
      const agent = await csrfAgent(app);
      const res = await agent.post('/auth/register', { matricNo: FREE[0].matric_no, email: 'new.student@example.com', password: GOOD_PASSWORD, consent: true });
      expect(res.status).toBe(201);
      expect(res.body.message).toMatch(/open it to confirm/);
      await app.get('background').idle();
      return { ...agent, app, delivery };
    }

    test('registration emails a link (token after "#", stored only as a hash, 24 h); the new account starts unverified', async () => {
      const { delivery } = await registered();
      const token = linkFrom(delivery);
      expect(delivery.sent[0].text).toContain(`/verify-email#token=${token}`);
      const user = await userRow(db, FREE[0].matric_no);
      expect(user.email_verified).toBe(false);
      const [row] = await db('email_verifications').where({ user_id: user.id });
      expect(row.token_hash).not.toContain(token);
      const hours = (row.expires_at - row.created_at) / 3600000;
      expect(hours).toBeCloseTo(24, 1);
    });

    test('sign-in before confirming: told to verify (only after a correct password), a new link is sent, nothing counted', async () => {
      const { post, app, delivery } = await registered();
      await redis.flushdb(); // lift the 60 s re-send cooldown
      const wrong = await post('/auth/login', { identifier: FREE[0].matric_no, password: 'Wrong-Password-1!' });
      expect(wrong.body.unverified).toBeUndefined(); // a wrong password learns nothing
      const res = await post('/auth/login', { identifier: FREE[0].matric_no, password: GOOD_PASSWORD });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ unverified: true });
      expect(cookieFrom(res, 'cg.session')).toBeUndefined();
      await app.get('background').idle();
      expect(delivery.sent.filter((m) => /Confirm/.test(m.subject))).toHaveLength(2);
      expect((await userRow(db, FREE[0].matric_no)).failed_attempts).toBe(1); // only the wrong password counted
    });

    test('opening the link verifies once; then sign-in works; the link cannot be reused; old links stop working', async () => {
      const { post, app, delivery } = await registered();
      const first = linkFrom(delivery);
      await redis.flushdb();
      await post('/auth/login', { identifier: FREE[0].matric_no, password: GOOD_PASSWORD }); // sends a newer link
      await app.get('background').idle();
      const second = linkFrom(delivery);
      expect(second).not.toBe(first);

      expect((await post('/auth/verify-email', { token: first })).status).toBe(400); // replaced by the newer one
      expect((await post('/auth/verify-email', { token: second })).status).toBe(200);
      expect((await post('/auth/verify-email', { token: second })).status).toBe(400); // single use
      expect((await userRow(db, FREE[0].matric_no)).email_verified).toBe(true);
      expect((await post('/auth/login', { identifier: FREE[0].matric_no, password: GOOD_PASSWORD })).status).toBe(200);
      expect(await db('auth_logs').where({ event_type: 'email_verified' })).toHaveLength(1);
    });

    test('expired and malformed tokens are refused; the verify page renders', async () => {
      const { post, delivery, agent } = await registered();
      await db('email_verifications').update({ expires_at: db.raw("now() - interval '1 minute'") });
      expect((await post('/auth/verify-email', { token: linkFrom(delivery) })).status).toBe(400);
      expect((await post('/auth/verify-email', { token: 'short' })).status).toBe(400);
      expect((await post('/auth/verify-email', {})).status).toBe(400);
      expect((await agent.get('/verify-email')).status).toBe(200);
    });

    test('seeded demo accounts are already verified', async () => {
      expect((await userRow(db, REGISTERED[0].matric_no)).email_verified).toBe(true);
    });
  });

  describe('risk score', () => {
    const app = (clock = NOON) => buildRealApp({ db, redis, clock, env: { RISK_SCORING: 'true' } });
    const signIn = async (theApp, i = 0, ua = 'Browser-A') => {
      const { agent, token } = await csrfAgent(theApp);
      return agent.post('/auth/login').set('X-CSRF-Token', token).set('User-Agent', ua)
        .send({ identifier: REGISTERED[i].matric_no, password: PASSWORDS.student });
    };

    test('the service scores new IP, new device, off-hours and recent failures; no history = no new-IP/device points', async () => {
      const user = await userRow(db, REGISTERED[0].matric_no);
      const at = (h) => createRiskService({ db, now: () => new Date(Date.UTC(2026, 9, 27, h)) });
      expect(await at(11).assess(user.id, { ip: '10.0.0.1', userAgent: 'UA' })).toEqual({ score: 0, signals: [], decision: 'allow' });
      await db('sessions').insert({ user_id: user.id, jti: '00000000-0000-4000-8000-000000000001', scope: 'full', ip: '10.0.0.1', user_agent: 'UA', expires_at: db.raw("now() + interval '1 hour'") });
      expect((await at(11).assess(user.id, { ip: '10.0.0.2', userAgent: 'UA' })).signals).toEqual(['new_ip']);
      expect((await at(2).assess(user.id, { ip: '10.0.0.2', userAgent: 'Other' }))).toMatchObject({ score: 3, decision: 'step_up' }); // 03:00 Lagos
      for (let i = 0; i < 3; i += 1) {
        await db('auth_logs').insert({ seq: 1000 + i, event_id: `00000000-0000-4000-8000-00000000010${i}`, occurred_at: db.fn.now(), event_type: 'login_failure', user_id: user.id, success: false, prev_hash: 'x', row_hash: 'x' });
      }
      expect(await at(2).assess(user.id, { ip: '10.0.0.2', userAgent: 'Other' })).toMatchObject({ score: 4, decision: 'block' });
    });

    test('low risk: a known device signs in with the password only', async () => {
      const a = app();
      expect((await signIn(a)).body.status).toBe('signed_in');
      expect((await signIn(a)).body.status).toBe('signed_in');
    });

    test('medium risk (new IP + new device): an emailed code is required even without 2FA, and it works', async () => {
      const user = await userRow(db, REGISTERED[0].matric_no);
      await db('sessions').insert({ user_id: user.id, jti: '00000000-0000-4000-8000-000000000002', scope: 'full', ip: '10.9.9.9', user_agent: 'Old-Browser', expires_at: db.raw("now() + interval '1 hour'") });
      const delivery = captureDelivery();
      const theApp = buildRealApp({ db, redis, clock: NOON, delivery, env: { RISK_SCORING: 'true' } });
      const { agent, token } = await csrfAgent(theApp);
      const res = await agent.post('/auth/login').set('X-CSRF-Token', token).set('User-Agent', 'Browser-A')
        .send({ identifier: REGISTERED[0].matric_no, password: PASSWORDS.student });
      expect(res.body).toMatchObject({ status: 'second_factor_required', method: 'email' });
      const ok = await agent.post('/auth/otp').set('X-CSRF-Token', token).send({ code: delivery.lastCode() });
      expect(ok.body.status).toBe('signed_in');
      const [ev] = await db('auth_logs').where({ event_type: 'second_factor_required' });
      expect(ev.details).toMatchObject({ method: 'email', reason: 'risk', riskScore: 2, signals: 'new_ip,new_device' });
      expect((await userRow(db, REGISTERED[0].matric_no)).two_factor_enabled).toBe(false); // 2FA itself stays off
    });

    test('high risk is refused with the generic message and is NOT counted toward lockout', async () => {
      const user = await userRow(db, REGISTERED[0].matric_no);
      await db('sessions').insert({ user_id: user.id, jti: '00000000-0000-4000-8000-000000000003', scope: 'full', ip: '10.9.9.9', user_agent: 'Old-Browser', expires_at: db.raw("now() + interval '1 hour'") });
      const night = { t: Date.UTC(2026, 9, 27, 2, 0, 0), now() { return this.t; } }; // 03:00 Lagos
      const theApp = app(night);
      const { post } = await csrfAgent(theApp);
      for (let i = 0; i < 3; i += 1) await post('/auth/login', { identifier: REGISTERED[0].matric_no, password: 'Wrong-Password-1!' });
      const res = await signIn(theApp, 0, 'Browser-A');
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/^Invalid ID or password/);
      expect((await userRow(db, REGISTERED[0].matric_no)).failed_attempts).toBe(3);
      const [ev] = await db('auth_logs').where({ event_type: 'login_failure' }).whereRaw("details->>'reason' = 'risk_blocked'");
      expect(ev.details).toMatchObject({ riskScore: 4, stage: 'risk' });
    });
  });

  describe('new-device alert', () => {
    const signInAs = async (theApp, ua) => {
      const { agent, token } = await csrfAgent(theApp);
      return agent.post('/auth/login').set('X-CSRF-Token', token).set('User-Agent', ua)
        .send({ identifier: REGISTERED[0].matric_no, password: PASSWORDS.student });
    };
    const ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';

    test('first sign-in: no alert; same device again: no alert; a new device: one email with device, IP and time', async () => {
      const delivery = captureDelivery();
      const theApp = buildRealApp({ db, redis, delivery });
      await signInAs(theApp, 'Desktop-Browser');
      await signInAs(theApp, 'Desktop-Browser');
      await theApp.get('background').idle();
      expect(delivery.sent).toHaveLength(0);

      await signInAs(theApp, ANDROID);
      await theApp.get('background').idle();
      expect(delivery.sent).toHaveLength(1);
      expect(delivery.sent[0].subject).toBe('New sign-in to your CampusGate account');
      expect(delivery.sent[0].text).toContain('Chrome on Android');
      expect(delivery.sent[0].text).toMatch(/IP address: .*127\.0\.0\.1/);
      expect(await db('auth_logs').where({ event_type: 'new_device_alert' })).toHaveLength(1);
    });

    test('a failed alert email never affects the sign-in', async () => {
      const theApp = buildRealApp({ db, redis, delivery: captureDelivery({ fail: true }) });
      await signInAs(theApp, 'Desktop-Browser');
      expect((await signInAs(theApp, ANDROID)).body.status).toBe('signed_in');
      await theApp.get('background').idle();
    });

    test('device names are short and readable', () => {
      expect(describeDevice(ANDROID)).toBe('Chrome on Android');
      expect(describeDevice('Mozilla/5.0 (Windows NT 10.0) Firefox/131.0')).toBe('Firefox on Windows');
      expect(describeDevice(undefined)).toBe('a browser on an unknown system');
    });
  });

  test('Redis-free sanity: the verify page and sign-in page render', async () => {
    const server = await listen(buildRealApp({ db, redis }));
    expect((await request(server).get('/login?verified=1')).text).toContain('Email address confirmed');
  });
});
