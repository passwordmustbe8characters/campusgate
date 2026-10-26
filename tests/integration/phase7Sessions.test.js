'use strict';

const {
  connectDb, connectRedis, buildRealApp, resetAndSeed, csrfAgent, userRow, captureDelivery, REGISTERED, PASSWORDS,
} = require('./helpers');

describe('Phase 7.2: concurrent-session limit (FR-Z3) and step-up code before payment (FR-M3)', () => {
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

  async function signedIn(app) {
    const agent = await csrfAgent(app);
    const res = await agent.post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
    expect(res.body.status).toBe('signed_in');
    return agent;
  }

  describe('session limit', () => {
    test('with max_sessions = 3, the 4th sign-in ends the OLDEST session; the other three keep working', async () => {
      const app = buildRealApp({ db, redis });
      const devices = [];
      for (let i = 0; i < 4; i += 1) devices.push(await signedIn(app));
      expect((await devices[0].agent.get('/home')).status).toBe(302); // the oldest was ended
      for (const d of devices.slice(1)) expect((await d.agent.get('/home')).status).toBe(200);
      const live = await db('sessions').whereNull('revoked_at');
      expect(live).toHaveLength(3);
      const [ended] = await db('sessions').whereNotNull('revoked_at');
      expect(ended.revoke_reason).toBe('session_limit');
      const [ev] = await db('auth_logs').where({ event_type: 'sessions_revoked' });
      expect(ev.details).toEqual({ reason: 'session_limit', count: 1 });
    });

    test('the limit comes from the live policy: max_sessions = 1 means only the newest device stays signed in', async () => {
      await db('policies').update({ max_sessions: 1 });
      const app = buildRealApp({ db, redis });
      const phone = await signedIn(app);
      const laptop = await signedIn(app);
      expect((await phone.agent.get('/home')).status).toBe(302);
      expect((await laptop.agent.get('/home')).status).toBe(200);
    });

    test('other users\' sessions are never affected', async () => {
      await db('policies').update({ max_sessions: 1 });
      const app = buildRealApp({ db, redis });
      const other = await csrfAgent(app);
      await other.post('/auth/login', { identifier: REGISTERED[1].matric_no, password: PASSWORDS.student });
      await signedIn(app);
      await signedIn(app);
      expect((await other.agent.get('/home')).status).toBe(200);
    });
  });

  describe('step-up before the mock fees payment', () => {
    async function withInvoice() {
      const delivery = captureDelivery();
      const app = buildRealApp({ db, redis, delivery });
      const agent = await signedIn(app);
      const inv = await agent.post('/portal/fees/invoice');
      return { ...agent, delivery, reference: inv.body.reference };
    }

    test('a fresh emailed code is required; the right code marks the invoice paid (demo), once', async () => {
      const { post, delivery, reference, agent } = await withInvoice();
      const start = await post('/portal/fees/pay/start', { reference });
      expect(start.status).toBe(200);
      expect(delivery.sent[0].subject).toBe('Your CampusGate payment confirmation code');
      expect(delivery.sent[0].text).toContain(reference);

      const ok = await post('/portal/fees/pay/confirm', { reference, code: delivery.lastCode() });
      expect(ok.status).toBe(200);
      expect(ok.body.message).toMatch(/no money was moved/);
      const row = await db('demo_invoices').where({ reference }).first();
      expect(row.paid_at).not.toBeNull();
      expect((await agent.get('/portal/fees')).text).toContain('PAID (demo)');
      expect((await post('/portal/fees/pay/start', { reference })).status).toBe(404); // nothing left to pay
      const types = await db('auth_logs').whereRaw("details->>'purpose' = 'payment'").pluck('event_type');
      expect(types).toEqual(['otp_sent', 'otp_verified']);
    });

    test('a wrong code is refused (3 attempts per code), and the invoice stays unpaid', async () => {
      const { post, delivery, reference } = await withInvoice();
      await post('/portal/fees/pay/start', { reference });
      const wrong = delivery.lastCode() === '000000' ? '111111' : '000000';
      for (let i = 0; i < 3; i += 1) expect((await post('/portal/fees/pay/confirm', { reference, code: wrong })).status).toBe(401);
      const used = await post('/portal/fees/pay/confirm', { reference, code: delivery.lastCode() });
      expect(used.status).toBe(401); // attempts used up: the right code no longer works
      expect((await db('demo_invoices').where({ reference }).first()).paid_at).toBeNull();
    });

    test('someone else\'s invoice, a made-up reference, no session or no CSRF token: refused', async () => {
      const { reference } = await withInvoice();
      const app = buildRealApp({ db, redis });
      const other = await csrfAgent(app);
      await other.post('/auth/login', { identifier: REGISTERED[1].matric_no, password: PASSWORDS.student });
      expect((await other.post('/portal/fees/pay/start', { reference })).status).toBe(404);
      expect((await other.post('/portal/fees/pay/start', { reference: 'CG-2026-AAAAAAAA' })).status).toBe(404);
      const anon = await csrfAgent(app);
      expect((await anon.post('/portal/fees/pay/start', { reference })).status).toBe(401);
      expect((await other.agent.post('/portal/fees/pay/start').send({ reference })).status).toBe(403);
    });

    test('a resend within 60 s is refused with Retry-After', async () => {
      const { post, reference } = await withInvoice();
      expect((await post('/portal/fees/pay/start', { reference })).status).toBe(200);
      const again = await post('/portal/fees/pay/start', { reference });
      expect(again.status).toBe(429);
      expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
      expect((await userRow(db, student.matric_no)).failed_attempts).toBe(0);
    });
  });
});
