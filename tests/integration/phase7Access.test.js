'use strict';

const request = require('supertest');
const {
  connectDb, connectRedis, buildRealApp, resetAndSeed, csrfAgent, cookieFrom, userRow, listen, REGISTERED, PASSWORDS, TEST_KEYS,
} = require('./helpers');
const { createAccessWindows } = require('../../app/src/policies/accessWindows');
const { normalizeCode } = require('../../app/src/services/vouchers');
const { encryptForUser } = require('../../app/src/services/secrets');

const TOTP_KEY = Buffer.from(TEST_KEYS.totpEncKey, 'base64url');
// A clock fixed at a Lagos time (UTC+1): lagosAt(9, 30) = 09:30 Lagos.
const lagosAt = (h, m = 0) => ({ t: Date.UTC(2026, 9, 27, h - 1, m), now() { return this.t; } });

describe('Phase 7.3: access windows (FR-Z2), guest vouchers (FR-Z4), admin screens (FR-D4), suspicious activity (FR-D5)', () => {
  let db;
  let redis;
  let student; // REGISTERED[0]
  let level;

  beforeAll(() => {
    db = connectDb();
    redis = connectRedis();
  });
  beforeEach(async () => {
    await resetAndSeed(db);
    await redis.flushdb();
    student = await userRow(db, REGISTERED[0].matric_no);
    level = student.level;
  });
  afterAll(async () => {
    await db.destroy();
    redis.disconnect();
  });

  const addWindow = async (service, w) => {
    const s = await db('services').where({ key: service }).first('id');
    await db('access_windows').insert({ service_id: s.id, level: null, faculty: null, on_date: null, ...w });
  };
  const otherLevel = () => (level === 100 ? 200 : 100);

  describe('the window rule', () => {
    const check = (clock, account) => createAccessWindows({ db, redis, logger: console, now: () => new Date(clock.now()) })
      .check('fees', account);

    test('no windows: always open', async () => {
      expect(await check(lagosAt(3), { level: 100 })).toEqual({ open: true });
    });

    test('open inside your window; before it, told when it opens; after the last window, open to everyone (catch-up)', async () => {
      await addWindow('fees', { level: 100, start_time: '08:00', end_time: '10:00' });
      await addWindow('fees', { level: 200, start_time: '10:00', end_time: '12:00' });
      expect(await check(lagosAt(9), { level: 100 })).toEqual({ open: true });
      const early = await check(lagosAt(7, 30), { level: 200 });
      expect(early).toMatchObject({ open: false, opensAt: '10:00' });
      expect(early.message).toMatch(/Your window for this service opens at 10:00/);
      const missed = await check(lagosAt(11), { level: 100 }); // 100 level missed 08-10
      expect(missed).toMatchObject({ open: false, opensAt: '12:00' });
      expect(missed.message).toMatch(/opens to everyone at 12:00/);
      expect(await check(lagosAt(12), { level: 100 })).toEqual({ open: true });
      expect(await check(lagosAt(12), { level: 500 })).toEqual({ open: true });
    });

    test('faculty windows match the faculty (case-insensitive); a dated window applies only on that day', async () => {
      await addWindow('fees', { faculty: 'Engineering', start_time: '08:00', end_time: '10:00' });
      expect(await check(lagosAt(9), { level: 300, faculty: 'engineering' })).toEqual({ open: true });
      expect((await check(lagosAt(9), { level: 300, faculty: 'Arts' })).open).toBe(false);
      await db('access_windows').update({ on_date: '2026-10-28' }); // tomorrow
      expect(await check(lagosAt(9), { level: 300, faculty: 'Arts' })).toEqual({ open: true });
    });
  });

  describe('windows in the portal', () => {
    test('outside your window: the page explains when it opens; other services and sign-in still work', async () => {
      await addWindow('fees', { level: otherLevel(), start_time: '08:00', end_time: '10:00' });
      await addWindow('fees', { level, start_time: '10:00', end_time: '12:00' });
      const app = buildRealApp({ db, redis, clock: lagosAt(9) });
      const agent = await csrfAgent(app);
      expect((await agent.post('/auth/login', { identifier: student.matric_or_staff_id, password: PASSWORDS.student })).body.status).toBe('signed_in');
      const fees = await agent.agent.get('/portal/fees');
      expect(fees.status).toBe(403);
      expect(fees.text).toContain('opens at 10:00');
      expect((await agent.agent.get('/portal/hostel')).status).toBe(200);
      expect((await agent.post('/portal/fees/invoice')).status).toBe(403);
    });

    test('inside your window the page opens', async () => {
      await addWindow('fees', { level, start_time: '08:00', end_time: '10:00' });
      const app = buildRealApp({ db, redis, clock: lagosAt(9) });
      const agent = await csrfAgent(app);
      await agent.post('/auth/login', { identifier: student.matric_or_staff_id, password: PASSWORDS.student });
      expect((await agent.agent.get('/portal/fees')).status).toBe(200);
    });
  });

  async function adminClient(app, server) {
    const admin = await userRow(db, 'ADMIN0001');
    await db('users').where({ id: admin.id }).update({ two_factor_enabled: true, two_factor_method: 'totp', totp_secret_enc: encryptForUser(TOTP_KEY, admin.id, 'JBSWY3DPEHPK3PXP') });
    const page = await request(server).get('/login');
    const csrf = /name="csrf-token" content="([^"]+)"/.exec(page.text)[1];
    const { token } = await app.get('services').sessions.issue({ userId: admin.id, role: 'admin', ttlMin: 30 });
    const cookie = [...page.headers['set-cookie'].map((c) => c.split(';')[0]), `cg.session=${token}`].join('; ');
    return {
      get: (url) => request(server).get(url).set('Cookie', cookie),
      post: (url, body = {}) => request(server).post(url).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(body),
    };
  }

  describe('admin screens for windows (FR-D4)', () => {
    test('add and remove a window from the console; it applies at once and is audited', async () => {
      const app = buildRealApp({ db, redis, clock: lagosAt(9) });
      const server = await listen(app);
      const admin = await adminClient(app, server);
      expect((await admin.get('/admin/windows')).status).toBe(200);
      const added = await admin.post('/admin/windows', { service: 'fees', level: String(otherLevel()), start_time: '08:00', end_time: '10:00' });
      expect(added.status).toBe(201);
      await app.get('services').accessWindows.load(); // what the change notice triggers
      const agent = await csrfAgent(app);
      await agent.post('/auth/login', { identifier: student.matric_or_staff_id, password: PASSWORDS.student });
      expect((await agent.agent.get('/portal/fees')).status).toBe(403);

      const [w] = await db('access_windows');
      expect((await admin.post('/admin/windows/delete', { id: String(w.id) })).status).toBe(200);
      await app.get('services').accessWindows.load();
      expect((await agent.agent.get('/portal/fees')).status).toBe(200);
      expect((await db('auth_logs').where({ event_type: 'window_changed' })).map((r) => r.details.action)).toEqual(['add', 'remove']);
    });

    test('bad windows are refused', async () => {
      const app = buildRealApp({ db, redis });
      const admin = await adminClient(app, await listen(app));
      expect((await admin.post('/admin/windows', { service: 'fees', start_time: '10:00', end_time: '09:00' })).status).toBe(400);
      expect((await admin.post('/admin/windows', { service: 'admin_console', start_time: '08:00', end_time: '09:00' })).status).toBe(400);
      expect((await admin.post('/admin/windows', { service: 'fees', level: '700', start_time: '08:00', end_time: '09:00' })).status).toBe(400);
      expect(await db('access_windows')).toHaveLength(0);
    });
  });

  describe('guest vouchers', () => {
    async function voucher(app, body = { svc_hostel: true, hours: '24', label: 'External examiner' }) {
      const server = await listen(app);
      const admin = await adminClient(app, server);
      const res = await admin.post('/admin/vouchers', body);
      return { res, code: res.body.code, admin, server };
    }

    test('an admin creates a code (shown once, stored only as a hash); the guest redeems it once and gets only those services', async () => {
      const app = buildRealApp({ db, redis });
      const { res, code, admin } = await voucher(app);
      expect(res.status).toBe(201);
      expect(code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
      const [row] = await db('guest_vouchers');
      expect(row.code_hash).not.toContain(normalizeCode(code));
      expect((await admin.get('/admin/vouchers')).text).not.toContain(code);

      const guest = await csrfAgent(app);
      expect((await guest.agent.get('/voucher')).status).toBe(200);
      const ok = await guest.post('/auth/voucher', { code: code.toLowerCase().replace('-', ' ') });
      expect(ok.body.status).toBe('signed_in');
      expect(cookieFrom(ok, 'cg.session')).toBeDefined();
      expect((await guest.agent.get('/portal/hostel')).status).toBe(200);
      expect((await guest.agent.get('/portal/fees')).status).toBe(403);
      expect((await guest.agent.get('/home')).text).toContain('href="/portal/hostel"');

      const again = await csrfAgent(app);
      expect((await again.post('/auth/voucher', { code })).status).toBe(401); // single use
      expect(await db('auth_logs').where({ event_type: 'voucher_redeemed' })).toHaveLength(1);
      expect((await db('auth_logs').where({ event_type: 'voucher_created' }))[0].details).toMatchObject({ services: 'hostel', hours: 24 });
    });

    test('the guest account can never sign in with a password', async () => {
      const app = buildRealApp({ db, redis });
      await voucher(app);
      const guestUser = await db('users').join('roles', 'roles.id', 'users.role_id').where('roles.name', 'guest').first('users.matric_or_staff_id', 'users.is_active');
      expect(guestUser.is_active).toBe(false);
      const agent = await csrfAgent(app);
      expect((await agent.post('/auth/login', { identifier: guestUser.matric_or_staff_id, password: 'anything-At-all1!' })).status).toBe(401);
    });

    test('expired and cancelled codes are refused; cancelling ends a guest session already in use', async () => {
      const app = buildRealApp({ db, redis });
      const { code: c1 } = await voucher(app);
      await db('guest_vouchers').update({ expires_at: db.raw("now() - interval '1 second'"), created_at: db.raw("now() - interval '1 hour'") });
      expect((await (await csrfAgent(app)).post('/auth/voucher', { code: c1 })).status).toBe(401);

      const { code: c2, admin } = await voucher(app);
      const guest = await csrfAgent(app);
      await guest.post('/auth/voucher', { code: c2 });
      expect((await guest.agent.get('/portal/hostel')).status).toBe(200);
      const v = await db('guest_vouchers').orderBy('id', 'desc').first();
      expect((await admin.post('/admin/vouchers/revoke', { id: String(v.id) })).status).toBe(200);
      expect((await guest.agent.get('/portal/hostel')).status).toBe(302);
    });

    test('a voucher needs at least one service and a sane validity; guessing codes is rate limited', async () => {
      const app = buildRealApp({ db, redis, env: { RATE_LIMIT_IP_PER_MIN: '3' } });
      const { res } = await voucher(app, { hours: '24' });
      expect(res.status).toBe(400);
      const bad = await voucher(app, { svc_fees: true, hours: '0' });
      expect(bad.res.status).toBe(400);
      const g = await csrfAgent(app);
      for (let i = 0; i < 3; i += 1) await g.post('/auth/voucher', { code: 'AAAA-AAAA' });
      expect((await g.post('/auth/voucher', { code: 'AAAA-AAAA' })).status).toBe(429);
    });
  });

  test('suspicious-activity panel lists repeated failures, bursts per address and lockouts', async () => {
    const app = buildRealApp({ db, redis });
    const server = await listen(app);
    const s = await csrfAgent(app);
    for (let i = 0; i < 5; i += 1) await s.post('/auth/login', { identifier: student.matric_or_staff_id, password: 'Wrong-Password-1!' });
    await s.post('/auth/login', { identifier: 'NOBODY/1', password: 'x' });
    const admin = await adminClient(app, server);
    const page = await admin.get('/admin/suspicious');
    expect(page.status).toBe(200);
    expect(page.text).toContain(student.matric_or_staff_id);
    expect(page.text).toMatch(/127\.0\.0\.1/);
    expect(page.text).toContain('Lockouts');
  });
});
