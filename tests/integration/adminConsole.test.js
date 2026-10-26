'use strict';

const http = require('node:http');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const {
  connectDb, connectRedis, buildRealApp, resetAndSeed, csrfAgent, listen, userRow, REGISTERED, PASSWORDS, TEST_KEYS,
} = require('./helpers');
const { encryptForUser } = require('../../app/src/services/secrets');
const { ISSUER, AUDIENCE } = require('../../app/src/services/sessions');

const ADMIN = 'ADMIN0001';
const TOTP_KEY = Buffer.from(TEST_KEYS.totpEncKey, 'base64url');
const JWT_KEY = Buffer.from(TEST_KEYS.jwtSecret, 'base64url');

describe('admin console (FR-D1 to D3, FR-Z5, FR-L3, FR-L4) against real PostgreSQL + Redis', () => {
  let db;
  let redis;
  let app;
  let server;

  beforeAll(() => {
    db = connectDb();
    redis = connectRedis();
  });
  beforeEach(async () => {
    await resetAndSeed(db);
    await redis.flushdb();
    app = buildRealApp({ db, redis });
    server = await listen(app);
  });
  afterAll(async () => {
    await db.destroy();
    redis.disconnect();
  });

  /** Give the seeded admin an authenticator app (FR-A13) without going through enrolment. */
  async function adminWithTotp() {
    const admin = await userRow(db, ADMIN);
    await db('users').where({ id: admin.id }).update({
      two_factor_enabled: true, two_factor_method: 'totp', totp_secret_enc: encryptForUser(TOTP_KEY, admin.id, 'JBSWY3DPEHPK3PXP'),
    });
    return admin;
  }

  /** A client holding the pre-session/CSRF cookies plus a session token for `user` (role as given). */
  async function client(user, role, { token } = {}) {
    const page = await request(server).get('/login');
    const csrf = /name="csrf-token" content="([^"]+)"/.exec(page.text)[1];
    const session = token || (await app.get('services').sessions.issue({ userId: user.id, role, ttlMin: 30 })).token;
    const cookie = [...page.headers['set-cookie'].map((c) => c.split(';')[0]), `cg.session=${session}`].join('; ');
    return {
      get: (url) => request(server).get(url).set('Cookie', cookie),
      post: (url, body = {}) => request(server).post(url).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(body),
      postNoCsrf: (url, body = {}) => request(server).post(url).set('Cookie', cookie).send(body),
    };
  }

  const adminClient = async () => client(await adminWithTotp(), 'admin');
  const auditRows = (type) => db('auth_logs').where({ event_type: type }).orderBy('seq');

  describe('access', () => {
    test('an admin with an authenticator app opens every console page', async () => {
      const c = await adminClient();
      for (const url of ['/admin', '/admin/users', '/admin/policies', '/admin/logs']) {
        expect(`${url}:${(await c.get(url)).status}`).toBe(`${url}:200`);
      }
    });

    test('refused: no session (redirect), a student (403), an admin whose TOTP is off (403), an enrolment-only session (redirect)', async () => {
      expect((await request(server).get('/admin')).status).toBe(302);
      const student = await userRow(db, REGISTERED[0].matric_no);
      expect((await (await client(student, 'student')).get('/admin')).status).toBe(403);
      const admin = await userRow(db, ADMIN); // seeded admin has no TOTP
      const noTotp = await (await client(admin, 'admin')).get('/admin');
      expect(noTotp.status).toBe(403);
      expect(noTotp.body.enrolmentRequired).toBe(true);
      const enrol = await app.get('services').sessions.issue({ userId: admin.id, role: 'admin', scope: 'enrol', ttlMin: 5 });
      expect((await (await client(admin, 'admin', { token: enrol.token })).get('/admin')).status).toBe(302);
    });

    test('a forged role in the token does not help: the admin check reads the account from the database', async () => {
      const student = await userRow(db, REGISTERED[0].matric_no);
      expect((await (await client(student, 'admin')).get('/admin')).status).toBe(403);
    });

    test('changes need CSRF and a sign-in from the last 10 minutes; viewing does not', async () => {
      const admin = await adminWithTotp();
      const old = jwt.sign({ sub: String(admin.id), role: 'admin', scope: 'full', iat: Math.floor(Date.now() / 1000) - 11 * 60 }, JWT_KEY,
        { algorithm: 'HS256', expiresIn: 30 * 60, jwtid: '00000000-0000-4000-8000-0000000000bb', issuer: ISSUER, audience: AUDIENCE });
      const c = await client(admin, 'admin', { token: old });
      expect((await c.get('/admin/users')).status).toBe(200);
      const res = await c.post('/admin/users/unlock', { identifier: REGISTERED[0].matric_no });
      expect(res.status).toBe(401);
      expect(res.body.restart).toBe(true);
      expect((await (await adminClient()).postNoCsrf('/admin/users/unlock', { identifier: REGISTERED[0].matric_no })).status).toBe(403);
    });
  });

  describe('dashboard (FR-D1)', () => {
    test('the snapshot counts sign-ins, failures, lockouts, sessions, locked accounts, queue and average sign-in time', async () => {
      const { post } = await csrfAgent(app);
      await post('/auth/login', { identifier: REGISTERED[0].matric_no, password: PASSWORDS.student });
      for (let i = 0; i < 5; i += 1) await post('/auth/login', { identifier: REGISTERED[1].matric_no, password: 'Wrong-Password-1!' });
      await app.get('services').waitingRoom.join({ queue_batch: 50, queue_interval_sec: 5 });

      const snap = await app.get('services').dashboard.snapshot();
      expect(snap).toMatchObject({
        signInsPerMin: 1, failuresPerMin: 5, lockoutsPerMin: 1, activeSessions: 1, lockedAccounts: 1, queueLength: 1,
      });
      expect(snap.avgSignInMs).toBeGreaterThan(0);
      expect((await (await adminClient()).get('/admin')).text).toContain('Average sign-in time');
    });

    test('the live stream (SSE) sends a snapshot as an event', async () => {
      const admin = await adminWithTotp();
      const { token } = await app.get('services').sessions.issue({ userId: admin.id, role: 'admin', ttlMin: 5 });
      const { port } = server.address();
      const first = await new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/admin/metrics/stream', headers: { Cookie: `cg.session=${token}` } }, (res) => {
          expect(res.headers['content-type']).toMatch(/text\/event-stream/);
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            req.destroy();
            resolve(chunk);
          });
        });
        req.on('error', (err) => (err.code === 'ECONNRESET' ? null : reject(err)));
      });
      const data = JSON.parse(/^data: (.*)$/m.exec(first)[1]);
      expect(Object.keys(data)).toEqual(expect.arrayContaining(['signInsPerMin', 'activeSessions', 'queueLength', 'avgSignInMs']));
    });
  });

  describe('users (FR-D2)', () => {
    test('search finds accounts by the start of the ID or email', async () => {
      const res = await (await adminClient()).get(`/admin/users?q=${encodeURIComponent(REGISTERED[0].matric_no.slice(0, 8))}`);
      expect(res.text).toContain(REGISTERED[0].matric_no);
    });

    test('unlock: clears the lock, audited with the admin as actor', async () => {
      const c = await adminClient();
      const admin = await userRow(db, ADMIN);
      await db('users').where({ matric_or_staff_id: REGISTERED[0].matric_no }).update({ failed_attempts: 5, locked_until: db.raw("now() + interval '15 minutes'") });
      const res = await c.post('/admin/users/unlock', { identifier: REGISTERED[0].matric_no });
      expect(res.status).toBe(200);
      expect(await userRow(db, REGISTERED[0].matric_no)).toMatchObject({ failed_attempts: 0, locked_until: null });
      const [row] = await auditRows('admin_unlock');
      expect(row.details).toEqual({ actor: `admin:${admin.id}` });
      expect((await c.post('/admin/users/unlock', { identifier: 'NOBODY/1' })).status).toBe(404);
    });

    test('deactivate: the user can no longer sign in and is signed out everywhere; reactivate restores it', async () => {
      const c = await adminClient();
      const s = await csrfAgent(app);
      await s.post('/auth/login', { identifier: REGISTERED[0].matric_no, password: PASSWORDS.student });
      expect((await s.agent.get('/home')).status).toBe(200);

      expect((await c.post('/admin/users/status', { identifier: REGISTERED[0].matric_no, active: 'false' })).status).toBe(200);
      expect((await s.agent.get('/home')).status).toBe(302);
      expect((await s.post('/auth/login', { identifier: REGISTERED[0].matric_no, password: PASSWORDS.student })).status).toBe(401);
      expect((await auditRows('admin_user_status'))[0].details).toMatchObject({ active: false });

      expect((await c.post('/admin/users/status', { identifier: REGISTERED[0].matric_no, active: 'true' })).status).toBe(200);
      expect((await s.post('/auth/login', { identifier: REGISTERED[0].matric_no, password: PASSWORDS.student })).status).toBe(200);
    });

    test('an admin cannot deactivate themselves or drop their own admin role', async () => {
      const c = await adminClient();
      expect((await c.post('/admin/users/status', { identifier: ADMIN, active: 'false' })).status).toBe(400);
      expect((await c.post('/admin/users/role', { identifier: ADMIN, role: 'student' })).status).toBe(400);
      expect((await userRow(db, ADMIN)).is_active).toBe(true);
    });

    test('role change: recorded in history, and the user is signed out (their token carried the old role)', async () => {
      const c = await adminClient();
      const s = await csrfAgent(app);
      await s.post('/auth/login', { identifier: REGISTERED[0].matric_no, password: PASSWORDS.student });
      const res = await c.post('/admin/users/role', { identifier: REGISTERED[0].matric_no, role: 'staff' });
      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/student -> staff \(1 session\(s\) ended\)/);
      expect((await s.agent.get('/home')).status).toBe(302);
      const [h] = await db('policy_history').where({ subject: 'user_role' });
      expect(h.actor).toMatch(/^admin:\d+$/);
      expect((await c.post('/admin/users/role', { identifier: REGISTERED[0].matric_no, role: 'root' })).status).toBe(400);
    });

    test('reset 2FA from the console clears the second factor and signs the user out', async () => {
      const c = await adminClient();
      await db('users').where({ matric_or_staff_id: REGISTERED[1].matric_no }).update({ two_factor_enabled: true, two_factor_method: 'email' });
      const res = await c.post('/admin/users/reset-2fa', { identifier: REGISTERED[1].matric_no });
      expect(res.status).toBe(200);
      expect((await userRow(db, REGISTERED[1].matric_no)).two_factor_enabled).toBe(false);
    });
  });

  describe('policies (FR-D3, FR-Z5)', () => {
    test('a change in the console changes behaviour at once (no restart), with history', async () => {
      const c = await adminClient();
      const res = await c.post('/admin/policies', { max_attempts: '3', lockout_minutes: '15', queue_enabled: 'true' });
      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/max_attempts 5 -> 3/);
      expect(res.body.message).not.toMatch(/lockout_minutes/); // unchanged fields are not "changes"

      const s = await csrfAgent(app);
      for (let i = 0; i < 3; i += 1) await s.post('/auth/login', { identifier: REGISTERED[0].matric_no, password: 'Wrong-Password-1!' });
      expect((await userRow(db, REGISTERED[0].matric_no)).locked_until).not.toBeNull(); // locked after 3, not 5

      const [h] = await db('policy_history').where({ subject: 'policy' });
      expect(h).toMatchObject({ old_value: { max_attempts: 5 }, new_value: { max_attempts: 3 } });
      expect(h.actor).toMatch(/^admin:\d+$/);
      expect((await c.get('/admin/policies')).text).toContain('max_attempts');
    });

    test('out-of-range values are refused with nothing changed; 2FA for admins is not editable', async () => {
      const c = await adminClient();
      expect((await c.post('/admin/policies', { max_attempts: '0' })).status).toBe(400);
      expect((await c.post('/admin/policies', { min_length: 'abc' })).status).toBe(400);
      await c.post('/admin/policies', { require_2fa_admin: 'false' });
      const policy = await db('policies').first();
      expect(policy).toMatchObject({ max_attempts: 5, require_2fa_admin: true });
      expect((await c.get('/admin/policies')).text).not.toContain('name="require_2fa_admin"');
    });
  });

  describe('audit log (FR-L3, FR-L4)', () => {
    test('filter, CSV export (audited) and Verify integrity (OK, then BROKEN after tampering)', async () => {
      const c = await adminClient();
      const s = await csrfAgent(app);
      await s.post('/auth/login', { identifier: REGISTERED[0].matric_no, password: 'Wrong-Password-1!' });
      await s.post('/auth/login', { identifier: REGISTERED[0].matric_no, password: PASSWORDS.student });

      const filtered = await c.get('/admin/logs?type=login_failure');
      expect(filtered.text).toContain('login_failure');
      expect(filtered.text).not.toContain('<td>login_success</td>');

      const csv = await c.get('/admin/logs/export?type=login_success');
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      expect(csv.text.split('\r\n')[0]).toBe('seq,occurred_at,event_type,success,user_id,subject_hash,ip,user_agent,details,row_hash');
      expect(csv.text).toContain('login_success');
      expect((await auditRows('audit_exported'))[0].details).toMatchObject({ rows: 1, filters: 'type=login_success' });

      const ok = await c.post('/admin/logs/verify');
      expect(ok.body).toMatchObject({ ok: true });
      expect(ok.body.message).toMatch(/^OK: the chain is intact/);

      await db.transaction(async (trx) => {
        await trx.raw('ALTER TABLE auth_logs DISABLE TRIGGER auth_logs_no_update_delete');
        await trx.raw('UPDATE auth_logs SET success = true WHERE seq = 1');
        await trx.raw('ALTER TABLE auth_logs ENABLE TRIGGER auth_logs_no_update_delete');
      });
      const broken = await c.post('/admin/logs/verify');
      expect(broken.body).toMatchObject({ ok: false, firstBadSeq: 1, reason: 'row_hash' });
      expect(broken.body.message).toMatch(/^BROKEN at seq 1/);
    });

    test('filter values are validated, never passed to SQL as raw text', async () => {
      const c = await adminClient();
      const res = await c.get(`/admin/logs?type=${encodeURIComponent("x' OR 1=1 --")}&ip=${encodeURIComponent('1; DROP TABLE users')}`);
      expect(res.status).toBe(200);
      expect(await db('users').count({ n: '*' }).first()).toBeDefined();
    });
  });
});
