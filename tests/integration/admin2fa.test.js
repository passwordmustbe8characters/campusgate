'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { generate } = require('otplib');
const {
  connectDb, connectRedis, buildRealApp, resetAndSeed, csrfAgent, cookieFrom, userRow, captureLogs, listen,
  enableEmail2fa, trackForTeardown, holdOnlyConnection, cliEnv, TEST_KEYS, REGISTERED, PASSWORDS,
} = require('./helpers');
const { testUrls } = require('./testEnv');
const { createSessionService } = require('../../app/src/services/sessions');
const { sessionCookies, requireSession } = require('../../app/src/middleware/session');
const { requireAdmin2FA } = require('../../app/src/middleware/requireAdmin2FA');
const { createDb } = require('../../app/src/db/knex');
const { loadConfig } = require('../../app/src/config');

const run = promisify(execFile);
const ROOT = path.join(__dirname, '..', '..');
const ADMIN = 'ADMIN0001';
// Pinned clock: 15 s into a 30 s TOTP step, so generating a code and the server
// checking it can never straddle a step boundary, however slow the machine is.
const clock = { t: 1_800_000_015_000, now() { return this.t; } };
const totpNow = (secret, offset = 0) => generate({ secret, epoch: clock.t / 1000 + offset });

describe('admin 2FA (FR-A13), reset-2fa CLI, knex logging', () => {
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

  const adminLogin = async () => {
    const agent = await csrfAgent(buildRealApp({ db, redis, clock }));
    const res = await agent.post('/auth/login', { identifier: ADMIN, password: PASSWORDS.admin });
    return { ...agent, res };
  };

  /** Admin enrols TOTP through the enrolment-only session; returns the secret. */
  async function enrolAdmin() {
    const { post, res } = await adminLogin();
    expect(res.body.status).toBe('enrolment_required');
    const start = await post('/auth/totp/enrol');
    expect(start.status).toBe(200);
    const confirm = await post('/auth/totp/enrol/confirm', { code: await totpNow(start.body.secret) });
    expect(confirm.status).toBe(200);
    return { secret: start.body.secret, confirm };
  }

  /** Full admin sign-in with TOTP; returns the agent and the session cookie value. */
  async function adminSignedIn(secret) {
    const { post, res, agent } = await adminLogin();
    expect(res.body).toMatchObject({ status: 'second_factor_required', method: 'totp' });
    const ok = await post('/auth/totp/verify', { code: await totpNow(secret, 30) });
    expect(ok.body.status).toBe('signed_in');
    return { post, agent, ticket: cookieFrom(ok, 'cg.session') };
  }

  test('an admin without TOTP cannot sign in: enrolment_required, and the counter is not reset', async () => {
    await db('users').where({ matric_or_staff_id: ADMIN }).update({ failed_attempts: 2 });
    const { res } = await adminLogin();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('enrolment_required');
    expect(cookieFrom(res, 'cg.session')).toBeDefined();
    const row = await userRow(db, ADMIN);
    expect(row.failed_attempts).toBe(2);
    expect(row.last_login).toBeNull();
  });

  test('the enrolment-only session opens TOTP enrolment (and sign-out) and nothing else', async () => {
    const { post, agent } = await adminLogin();
    expect((await agent.get('/account/security')).status).toBe(200);
    expect((await post('/auth/totp/enrol')).status).toBe(200);
    expect((await post('/auth/password/change', { currentPassword: PASSWORDS.admin, newPassword: 'New-Admin-Pass-7' })).status).toBe(401);
    expect((await post('/auth/2fa/email/enable')).status).toBe(401);
    expect((await post('/auth/logout-all')).status).toBe(401);
  });

  test('an admin with email 2FA (forced in the DB) is still sent to TOTP enrolment, not email codes', async () => {
    await enableEmail2fa(db, ADMIN);
    const { res } = await adminLogin();
    expect(res.body.status).toBe('enrolment_required');
  });

  test('after enrolling, the enrolment session is revoked; the next sign-in needs the TOTP code', async () => {
    const { secret, confirm } = await enrolAdmin();
    expect(confirm.body.backupCodes).toHaveLength(8);
    expect(confirm.body.message).toMatch(/sign in again/);
    expect(await db('sessions').where({ scope: 'enrol' }).whereNull('revoked_at')).toHaveLength(0);
    expect(await db('sessions').where({ scope: 'enrol', revoke_reason: 'enrolment_complete' })).toHaveLength(1);
    expect(await userRow(db, ADMIN)).toMatchObject({ two_factor_enabled: true, two_factor_method: 'totp' });

    const { ticket } = await adminSignedIn(secret);
    expect(ticket).toBeDefined();
  });

  test('a signed-in admin still cannot choose email 2FA (TOTP only)', async () => {
    const { secret } = await enrolAdmin();
    const { post } = await adminSignedIn(secret);
    const res = await post('/auth/2fa/email/enable');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/authenticator app/);
  });

  describe('requireAdmin2FA middleware (for the admin console, Phases 3/4/6)', () => {
    async function probe(ticket) {
      const config = loadConfig({
        NODE_ENV: 'test', DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', CSRF_SECRET: 'x'.repeat(32),
        TOKEN_HMAC_KEY: TEST_KEYS.tokenHmacKey, TOTP_ENC_KEY: TEST_KEYS.totpEncKey, AUDIT_HMAC_KEY: TEST_KEYS.auditHmacKey,
        JWT_SECRET: TEST_KEYS.jwtSecret,
      });
      const sessions = createSessionService({ db, redis, jwtSecret: config.jwtSecret });
      const app = express();
      app.use(cookieParser());
      app.use((req, res, next) => { req.log = { info() {}, error() {} }; next(); });
      app.get('/admin-probe', requireSession({ sessions, cookies: sessionCookies(config) }), requireAdmin2FA({ db }),
        (req, res) => res.json({ ok: true }));
      const req = request(await listen(app)).get('/admin-probe');
      return ticket ? req.set('Cookie', `cg.session=${ticket}`) : req;
    }

    test('admin with TOTP passes', async () => {
      const { secret } = await enrolAdmin();
      const { ticket } = await adminSignedIn(secret);
      expect((await probe(ticket)).status).toBe(200);
    });

    test('a student with a valid session is refused (403)', async () => {
      const agent = await csrfAgent(buildRealApp({ db, redis, clock }));
      const res = await agent.post('/auth/login', { identifier: REGISTERED[0].matric_no, password: PASSWORDS.student });
      expect((await probe(cookieFrom(res, 'cg.session'))).status).toBe(403);
    });

    test('an admin whose TOTP was removed after sign-in is refused (403, enrolment required)', async () => {
      const { secret } = await enrolAdmin();
      const { ticket } = await adminSignedIn(secret);
      await db('users').where({ matric_or_staff_id: ADMIN })
        .update({ two_factor_enabled: false, two_factor_method: null, totp_secret_enc: null });
      const res = await probe(ticket);
      expect(res.status).toBe(403);
      expect(res.body.enrolmentRequired).toBe(true);
    });

    test('the enrolment-only session is refused, and no session means sign in again (GET redirects to /login)', async () => {
      const { res } = await adminLogin();
      for (const ticket of [cookieFrom(res, 'cg.session'), undefined]) {
        const probed = await probe(ticket);
        expect(probed.status).toBe(302);
        expect(probed.headers.location).toBe('/login');
      }
    });
  });

  describe('npm run admin -- reset-2fa', () => {
    const cli = (...args) => run(process.execPath, [path.join(ROOT, 'scripts', 'admin-cli.js'), ...args], {
      cwd: ROOT,
      env: cliEnv(),
    });

    test('refuses without --confirm and changes nothing', async () => {
      const { secret } = await enrolAdmin();
      await expect(cli('reset-2fa', ADMIN)).rejects.toMatchObject({ code: 2 });
      expect((await userRow(db, ADMIN)).two_factor_enabled).toBe(true);
      expect(secret).toBeDefined();
    });

    test('clears secret, backup codes and flag; revokes tickets and sessions; the admin must re-enrol at next sign-in', async () => {
      const { secret } = await enrolAdmin();
      const signedIn = await adminSignedIn(secret); // a live session
      const { post } = await adminLogin(); // pending pre-auth ticket
      expect((await redis.keys('cg:preauth:*')).length).toBeGreaterThan(0);
      expect((await signedIn.agent.get('/account/security')).status).toBe(200);

      const { stdout } = await cli('reset-2fa', ADMIN, '--confirm');
      expect(stdout).toContain(`Two-step sign-in reset for ${ADMIN}`);
      expect(stdout).toContain('backup codes removed: 8');
      expect(stdout).toMatch(/1 session\(s\) and \d+ pending sign-in\(s\) revoked/);
      expect((await signedIn.agent.get('/account/security')).status).toBe(302);
      const audit = await db('auth_logs').where({ event_type: 'sessions_revoked' }).first();
      expect(audit.details).toEqual({ reason: 'two_factor_reset', count: 1, actor: 'cli' });

      const row = await userRow(db, ADMIN);
      expect(row).toMatchObject({ two_factor_enabled: false, two_factor_method: null, totp_secret_enc: null, totp_last_step: null });
      expect(await db('totp_backup_codes').where({ user_id: row.id })).toHaveLength(0);
      expect(await redis.keys('cg:preauth:*')).toHaveLength(0);
      expect((await post('/auth/totp/verify', { code: await totpNow(secret) })).body.restart).toBe(true);

      expect((await adminLogin()).res.body.status).toBe('enrolment_required');
    });

    test('a student reset this way signs in with the password only until they set 2FA up again', async () => {
      await enableEmail2fa(db, REGISTERED[0].matric_no);
      await cli('reset-2fa', REGISTERED[0].email, '--confirm');
      const agent = await csrfAgent(buildRealApp({ db, redis, clock }));
      const res = await agent.post('/auth/login', { identifier: REGISTERED[0].matric_no, password: PASSWORDS.student });
      expect(res.body.status).toBe('signed_in');
    });

    test('unknown user: exit code 1', async () => {
      await expect(cli('reset-2fa', 'NOBODY/0000', '--confirm')).rejects.toMatchObject({ code: 1 });
    });
  });

  test('knex warnings (pool acquire timeout) go to pino as knex_warning, not console.log', async () => {
    const { lines, logger } = captureLogs();
    const tiny = trackForTeardown(
      createDb({ databaseUrl: testUrls().databaseUrl, dbPoolMax: 1, dbAcquireTimeoutMs: 200 }, logger),
      () => tiny.destroy(),
    );
    const consoleSpy = jest.spyOn(console, 'log');
    let trx;
    try {
      // Timing-independent: on a slow machine opening the first connection can
      // exceed 200 ms, so retry until it is held, then forget the warm-up warnings.
      trx = await holdOnlyConnection(tiny);
      lines.length = 0;
      consoleSpy.mockClear();

      // Pool of 1 with its only connection held: this acquire can only time out.
      await expect(tiny.raw('select 1')).rejects.toThrow(/Timeout acquiring a connection/);

      const warnings = lines.map((l) => JSON.parse(l)).filter((l) => l.event === 'knex_warning');
      expect(warnings).toHaveLength(1);
      expect(warnings[0].knexMessage).toMatch(/Acquire connection error/);
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      // Always runs: a failed assertion must never leave a connection, pool or spy behind.
      consoleSpy.mockRestore();
      if (trx) await trx.rollback().catch(() => {});
      await tiny.destroy();
    }
  });
});
