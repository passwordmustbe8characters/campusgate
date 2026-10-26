'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { generate } = require('otplib');
const {
  connectDb, connectRedis, buildRealApp, resetAndSeed, csrfAgent, captureDelivery, captureLogs, userRow,
  enableEmail2fa, testAudit, cliEnv, TEST_KEYS, REGISTERED, FREE, PASSWORDS,
} = require('./helpers');
const { verifyChain, readAnchor, appendEvents } = require('../../app/src/audit/chain');
const { buildEvent } = require('../../app/src/audit/events');

const run = promisify(execFile);
const ROOT = path.join(__dirname, '..', '..');
const AUDIT_KEY = Buffer.from(TEST_KEYS.auditHmacKey, 'base64url');
const UA = 'jest-audit-test/1.0';
const clock = { t: 1_800_000_015_000, now() { return this.t; } };
const totpAt = (secret, offset = 0) => generate({ secret, epoch: clock.t / 1000 + offset });

const rows = (db) => db('auth_logs').orderBy('seq');
const types = async (db) => (await rows(db)).map((r) => r.event_type);

/** Make every auth_logs insert fail with a genuine PostgreSQL error, then undo it. */
async function withAuditWritesFailing(db, fn) {
  await db.raw('ALTER TABLE auth_logs ADD CONSTRAINT audit_test_reject CHECK (false) NOT VALID');
  try {
    return await fn();
  } finally {
    await db.raw('ALTER TABLE auth_logs DROP CONSTRAINT audit_test_reject');
  }
}

describe('audit log (FR-L1, FR-L3) in sync mode, against real PostgreSQL + Redis', () => {
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

  async function agentFor(options = {}) {
    const delivery = options.delivery || captureDelivery();
    const app = buildRealApp({ db, redis, clock, delivery, ...options });
    const agent = await csrfAgent(app);
    agent.agent.set('User-Agent', UA);
    return { ...agent, app, delivery };
  }

  test('every Phase 1 and 2 flow is recorded, with IP and user agent, and the chain verifies', async () => {
    const secrets = [PASSWORDS.student, PASSWORDS.admin, 'Wrong-Password-1!', 'Brand-New-Pass-42', 'Second-New-Pass-43'];
    const { post, delivery, app } = await agentFor();

    // Registration: one rejected, one accepted.
    await post('/auth/register', { matricNo: 'SCI/2019/9999', email: 'x@example.com', password: 'Kettle-Mango-42', consent: true });
    await post('/auth/register', { matricNo: FREE[0].matric_no, email: 'fresh.student@example.com', password: 'Kettle-Mango-42', consent: true });
    secrets.push('Kettle-Mango-42', 'fresh.student@example.com', 'x@example.com');

    // Password logins: unknown user, wrong password, success.
    await post('/auth/login', { identifier: 'nobody@example.com', password: 'Wrong-Password-1!' });
    await post('/auth/login', { identifier: student.matric_no, password: 'Wrong-Password-1!' });
    await post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });

    // TOTP enrolment (signed in) and a backup-code sign-in.
    const start = await post('/auth/totp/enrol');
    const confirm = await post('/auth/totp/enrol/confirm', { code: await totpAt(start.body.secret) });
    secrets.push(start.body.secret, ...confirm.body.backupCodes);
    const b = await agentFor({ delivery });
    await b.post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
    await b.post('/auth/totp/verify', { backupCode: confirm.body.backupCodes[0] });

    // Email 2FA on another student: wrong code, then right code.
    await enableEmail2fa(db, REGISTERED[1].matric_no);
    const c = await agentFor({ delivery });
    await c.post('/auth/login', { identifier: REGISTERED[1].matric_no, password: PASSWORDS.student });
    const code = c.delivery.lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    secrets.push(code, wrong);
    await c.post('/auth/otp', { code: wrong });
    await c.post('/auth/otp', { code });

    // Password reset and change.
    const d = await agentFor({ delivery });
    await d.post('/auth/password/forgot', { email: REGISTERED[2].email });
    await d.app.get('background').idle();
    const token = /#token=([A-Za-z0-9_-]{43})/.exec(delivery.sent.find((m) => /Reset/.test(m.subject)).text)[1];
    secrets.push(token, REGISTERED[2].email, student.email, REGISTERED[1].email);
    await d.post('/auth/password/reset', { token, newPassword: 'Brand-New-Pass-42' });
    const e = await agentFor({ delivery });
    await e.post('/auth/login', { identifier: REGISTERED[2].matric_no, password: 'Brand-New-Pass-42' });
    await e.post('/auth/password/change', { currentPassword: 'Wrong-Password-1!', newPassword: 'Second-New-Pass-43' });
    await e.post('/auth/password/change', { currentPassword: 'Brand-New-Pass-42', newPassword: 'Second-New-Pass-43' });
    await app.get('background').idle();

    // Admin CLI actions (written by a separate process).
    await run(process.execPath, [path.join(ROOT, 'scripts', 'admin-cli.js'), 'unlock', student.matric_no], { cwd: ROOT, env: cliEnv() });
    await run(process.execPath, [path.join(ROOT, 'scripts', 'admin-cli.js'), 'reset-2fa', student.matric_no, '--confirm'], { cwd: ROOT, env: cliEnv() });

    const seen = new Set(await types(db));
    for (const type of [
      'register', 'login_failure', 'login_success', 'totp_enrolment_started', 'two_factor_enabled',
      'second_factor_required', 'backup_code_used', 'otp_sent', 'otp_failed', 'otp_verified',
      'reset_requested', 'password_reset', 'password_change_failed', 'password_changed', 'admin_unlock', 'admin_reset_2fa',
    ]) {
      expect(`${type}:${seen.has(type)}`).toBe(`${type}:true`);
    }

    // HTTP events carry IP and user agent; CLI events say so.
    const all = await rows(db);
    // CLI rows: the admin actions, plus the session revocation that reset-2fa records.
    const fromCli = (r) => r.event_type.startsWith('admin_') || (r.event_type === 'sessions_revoked' && r.details.actor === 'cli');
    const httpRows = all.filter((r) => !fromCli(r));
    expect(httpRows.every((r) => r.user_agent === UA && /127\.0\.0\.1/.test(r.ip))).toBe(true);
    const cliRows = all.filter(fromCli);
    expect(cliRows.some((r) => r.event_type === 'sessions_revoked')).toBe(true);
    expect(cliRows.every((r) => r.user_agent === 'cli' && r.details.actor === 'cli')).toBe(true);

    // The unknown-user failure stores a keyed hash of what was typed, not the text.
    const unknown = all.find((r) => r.event_type === 'login_failure' && r.details.reason === 'unknown_user');
    expect(unknown.user_id).toBeNull();
    expect(unknown.subject_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // No secret, code, token or email address anywhere in any audit row.
    const dump = JSON.stringify(all);
    for (const secret of secrets) expect(`${secret.slice(0, 6)}...:${dump.includes(secret)}`).toBe(`${secret.slice(0, 6)}...:false`);
    expect(dump).not.toMatch(/@example\.com|@students\.campusgate\.test/);

    const result = await verifyChain(db, AUDIT_KEY, { anchor: await readAnchor(redis) });
    expect(result).toMatchObject({ ok: true, checked: all.length });
  }, 300000); // hang guard only: dozens of bcrypt hashes + two CLI processes on a busy machine

  test('lockout is recorded when the fifth wrong password locks the account', async () => {
    const { post } = await agentFor();
    for (let i = 0; i < 5; i += 1) await post('/auth/login', { identifier: student.matric_no, password: 'Wrong-Password-1!' });
    const lockouts = (await rows(db)).filter((r) => r.event_type === 'lockout');
    expect(lockouts).toHaveLength(1);
    expect(lockouts[0].details).toMatchObject({ failedAttempts: 5, stage: 'password' });
  });

  test('50 concurrent logins: every event written once, seq gap-free, chain intact', async () => {
    const agents = await Promise.all(Array.from({ length: 10 }, () => agentFor()));
    const attempts = [];
    for (let i = 0; i < 50; i += 1) {
      const a = agents[i % agents.length];
      const ok = i % 2 === 0;
      attempts.push(a.post('/auth/login', { identifier: REGISTERED[i % 3].matric_no, password: ok ? PASSWORDS.student : 'Wrong-Password-1!' }));
    }
    await Promise.all(attempts);

    const all = await rows(db);
    expect(all.length).toBeGreaterThanOrEqual(50);
    expect(all.map((r) => Number(r.seq))).toEqual(all.map((_, i) => i + 1));
    expect(new Set(all.map((r) => r.event_id)).size).toBe(all.length);
    expect(await verifyChain(db, AUDIT_KEY, { anchor: await readAnchor(redis) })).toMatchObject({ ok: true, checked: all.length });
  });

  test('append-only: UPDATE, DELETE and TRUNCATE are rejected by the database', async () => {
    const { post } = await agentFor();
    await post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
    await expect(db('auth_logs').update({ success: false })).rejects.toThrow(/append-only \(UPDATE rejected\)/);
    await expect(db('auth_logs').del()).rejects.toThrow(/append-only \(DELETE rejected\)/);
    await expect(db.raw('TRUNCATE auth_logs')).rejects.toThrow(/append-only \(TRUNCATE rejected\)/);
    expect((await rows(db)).length).toBeGreaterThan(0);
  });

  test('every event has a unique id: re-writing the same event is skipped, never duplicated', async () => {
    const event = buildEvent('login_success', { userId: 1, success: true, details: { method: 'password' } }, {});
    const first = await db.transaction((trx) => appendEvents(trx, AUDIT_KEY, [event]));
    const again = await db.transaction((trx) => appendEvents(trx, AUDIT_KEY, [event, event]));
    expect(first).toMatchObject({ written: 1, skipped: 0 });
    expect(again).toMatchObject({ written: 0, skipped: 2 });
    expect(await rows(db)).toHaveLength(1);
    await expect(db('auth_logs').insert({ ...(await rows(db))[0], seq: 99 })).rejects.toThrow(/unique/);
  });

  describe('when audit writes fail (genuine PostgreSQL error)', () => {
    test('FAIL OPEN: a login still succeeds; a marked fallback line and a counter record the event', async () => {
      const { lines, logger } = captureLogs();
      const { post } = await agentFor({ logger });
      const res = await withAuditWritesFailing(db, () =>
        post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student }));

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('signed_in');
      expect(await rows(db)).toHaveLength(0);
      const fallback = lines.map((l) => JSON.parse(l)).find((l) => l.auditFallback === true);
      expect(fallback.auditEvent).toMatchObject({ event_type: 'login_success', success: true });
      expect(fallback.msg).toMatch(/^AUDIT_FALLBACK/);
      expect(Number(await redis.get('cg:metrics:audit_fallback'))).toBeGreaterThanOrEqual(1);
    });

    test('FAIL CLOSED: a password change is refused (503) and the password is unchanged', async () => {
      const { post } = await agentFor();
      await post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
      const before = (await userRow(db, student.matric_no)).password_hash;
      const res = await withAuditWritesFailing(db, () =>
        post('/auth/password/change', { currentPassword: PASSWORDS.student, newPassword: 'Brand-New-Pass-42' }));

      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/can't be recorded in the audit log/);
      expect((await userRow(db, student.matric_no)).password_hash).toBe(before);
      expect(Number(await redis.get('cg:metrics:audit_critical_failures'))).toBe(1);
    });

    test('FAIL CLOSED: a password reset is refused and the token is NOT used up', async () => {
      const ctx = await agentFor();
      await ctx.post('/auth/password/forgot', { email: student.email });
      await ctx.app.get('background').idle();
      const token = /#token=([A-Za-z0-9_-]{43})/.exec(ctx.delivery.sent[0].text)[1];

      const refused = await withAuditWritesFailing(db, () =>
        ctx.post('/auth/password/reset', { token, newPassword: 'Brand-New-Pass-42' }));
      expect(refused.status).toBe(503);
      // Once the audit log works again, the same link still works.
      expect((await ctx.post('/auth/password/reset', { token, newPassword: 'Brand-New-Pass-42' })).status).toBe(200);
    });

    test('FAIL CLOSED: TOTP cannot be switched on and the CLI cannot unlock', async () => {
      const { post } = await agentFor();
      await post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
      const start = await post('/auth/totp/enrol');

      await withAuditWritesFailing(db, async () => {
        const res = await post('/auth/totp/enrol/confirm', { code: await totpAt(start.body.secret) });
        expect(res.status).toBe(503);
        // Lock the account only now (a locked account cannot use security settings at all).
        await db('users').where({ matric_or_staff_id: student.matric_no })
          .update({ failed_attempts: 5, locked_until: db.raw("now() + interval '15 minutes'") });
        await expect(run(process.execPath, [path.join(ROOT, 'scripts', 'admin-cli.js'), 'unlock', student.matric_no], { cwd: ROOT, env: cliEnv() }))
          .rejects.toMatchObject({ code: 1 });
      });
      const row = await userRow(db, student.matric_no);
      expect(row.two_factor_enabled).toBe(false);
      expect(row.locked_until).not.toBeNull();
    });

    test('the admin unlock function itself refuses to run without an audit service', async () => {
      const { unlockUser } = require('../../app/src/services/userService');
      await expect(unlockUser(db, student.matric_no)).rejects.toThrow(/must be audited/);
      expect(testAudit(db, redis).mode).toBe('sync');
    });
  });
});
