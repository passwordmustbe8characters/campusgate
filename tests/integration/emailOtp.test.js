'use strict';

const {
  connectDb, connectRedis, buildRealApp, resetAndSeed, csrfAgent, cookieFrom, userRow, captureDelivery,
  captureLogs, enableEmail2fa, REGISTERED, PASSWORDS,
} = require('./helpers');
const { RESTART_MESSAGE, INVALID_CODE_MESSAGE } = require('../../app/src/controllers/authController');


describe('email OTP second factor (FR-A7, FR-A14) against real PostgreSQL + Redis', () => {
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
    await enableEmail2fa(db, student.matric_no);
  });
  afterAll(async () => {
    await db.destroy();
    redis.disconnect();
  });

  /** Password step for the 2FA student; returns the agent helpers, delivery and response. */
  async function passwordStep({ env, delivery = captureDelivery(), logger } = {}) {
    const app = buildRealApp({ db, redis, env, delivery, logger });
    const agent = await csrfAgent(app);
    const res = await agent.post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
    return { ...agent, delivery, res };
  }

  const openCode = async () => db('otp_codes').where({ used: false }).orderBy('id', 'desc').first();

  /** End the resend cooldown now (deletes the key whose expiry ends it), instead of sleeping. */
  const expireLoginCooldown = async () => {
    const { id } = await userRow(db, student.matric_no);
    expect(await redis.del(`cg:cooldown:otp:login:${id}`)).toBe(1);
  };

  test('correct password on a 2FA account gives a pre-auth ticket and a code, not a sign-in', async () => {
    await db('users').where({ matric_or_staff_id: student.matric_no }).update({ failed_attempts: 2 });
    const { res, delivery } = await passwordStep();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'second_factor_required', method: 'email', codeSent: true });
    expect(cookieFrom(res, 'cg.preauth')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookieFrom(res, 'cg.acct')).toBeUndefined();
    expect(delivery.sent).toHaveLength(1);
    expect(delivery.sent[0].email).toBe(student.email);
    // A correct password alone does NOT reset the counter for a 2FA account.
    expect((await userRow(db, student.matric_no)).failed_attempts).toBe(2);
  });

  test('the code is stored as an HMAC, never in plain text; channel is recorded', async () => {
    const { delivery } = await passwordStep();
    const row = await openCode();
    expect(row.code_hash).not.toContain(delivery.lastCode());
    expect(row.code_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row.channel).toBe('console');
    const { rows } = await db.raw('SELECT EXTRACT(EPOCH FROM (expires_at - created_at)) AS ttl FROM otp_codes WHERE id = ?', [row.id]);
    expect(Number(rows[0].ttl)).toBe(300); // 5 minutes
  });

  test('correct code signs in, issues the account ticket, resets the counter, and the ticket is single-use', async () => {
    await db('users').where({ matric_or_staff_id: student.matric_no }).update({ failed_attempts: 2 });
    const { post, delivery } = await passwordStep();
    const code = delivery.lastCode();

    const ok = await post('/auth/otp', { code });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: 'signed_in', message: 'Signed in.', role: 'student' });
    expect(cookieFrom(ok, 'cg.acct')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await userRow(db, student.matric_no);
    expect(row.failed_attempts).toBe(0);
    expect(row.last_login).toBeInstanceOf(Date);

    const again = await post('/auth/otp', { code }); // same ticket cookie was cleared; replay the old value
    expect(again.status).toBe(401);
  });

  test('an expired code is rejected and does NOT count toward lockout', async () => {
    const { post, delivery } = await passwordStep();
    await db('otp_codes').update({ expires_at: db.raw("now() - interval '1 second'") });
    const res = await post('/auth/otp', { code: delivery.lastCode() });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(INVALID_CODE_MESSAGE);
    expect((await userRow(db, student.matric_no)).failed_attempts).toBe(0);
  });

  test('a code allows at most 3 attempts; the correct code after 3 wrong ones is refused', async () => {
    const { post, delivery } = await passwordStep();
    const code = delivery.lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 3; i += 1) expect((await post('/auth/otp', { code: wrong })).status).toBe(401);

    expect((await openCode()).attempts_used).toBe(3);
    const res = await post('/auth/otp', { code });
    expect(res.status).toBe(401);
    // the 3 compared wrong codes counted as credential failures; the 4th (no usable code) did not
    expect((await userRow(db, student.matric_no)).failed_attempts).toBe(3);
  });

  test('10 concurrent wrong codes: exactly 3 compared, exactly 3 failures counted', async () => {
    const { post, delivery } = await passwordStep({ env: { PREAUTH_MAX_ATTEMPTS: '20' } });
    const wrong = delivery.lastCode() === '000000' ? '111111' : '000000';
    const results = await Promise.all(Array.from({ length: 10 }, () => post('/auth/otp', { code: wrong })));

    expect(results.every((r) => r.status === 401)).toBe(true);
    expect((await db('otp_codes').first()).attempts_used).toBe(3);
    expect((await userRow(db, student.matric_no)).failed_attempts).toBe(3);
  });

  test('the pre-auth ticket has its own attempt limit (PREAUTH_MAX_ATTEMPTS)', async () => {
    const { post, delivery } = await passwordStep({ env: { PREAUTH_MAX_ATTEMPTS: '2' } });
    const code = delivery.lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await post('/auth/otp', { code: wrong })).status).toBe(401);
    expect((await post('/auth/otp', { code: wrong })).status).toBe(401);
    const third = await post('/auth/otp', { code }); // correct, but the ticket is used up
    expect(third.status).toBe(401);
    expect(third.body).toEqual({ error: RESTART_MESSAGE, restart: true });
  });

  test('second-factor failures lock the account like wrong passwords (5 in total)', async () => {
    const first = await passwordStep();
    const wrong1 = first.delivery.lastCode() === '000000' ? '111111' : '000000';
    for (let i = 0; i < 3; i += 1) await first.post('/auth/otp', { code: wrong1 });
    await expireLoginCooldown();
    expect((await first.post('/auth/otp/resend')).status).toBe(200);
    const wrong2 = first.delivery.lastCode() === '000000' ? '111111' : '000000';
    for (let i = 0; i < 2; i += 1) await first.post('/auth/otp', { code: wrong2 });

    const row = await userRow(db, student.matric_no);
    expect(row.failed_attempts).toBe(5);
    expect(row.locked_until).not.toBeNull();
    // Locked: even the correct password is refused now.
    const again = await csrfAgent(buildRealApp({ db, redis }));
    expect((await again.post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student })).status).toBe(401);
  });

  test('resend cancels the old code; immediate resend hits the cooldown (429 + Retry-After)', async () => {
    // Default 60 s cooldown: "immediately" can never take that long, however busy the machine.
    const { post, delivery } = await passwordStep();
    const oldCode = delivery.lastCode();

    const tooSoon = await post('/auth/otp/resend');
    expect(tooSoon.status).toBe(429);
    expect(Number(tooSoon.headers['retry-after'])).toBeGreaterThanOrEqual(1);

    await expireLoginCooldown(); // what the cooldown's expiry does, without waiting for it
    expect((await post('/auth/otp/resend')).status).toBe(200);
    const newCode = delivery.lastCode();
    expect(delivery.sent).toHaveLength(2);
    if (newCode !== oldCode) expect((await post('/auth/otp', { code: oldCode })).status).toBe(401);
    expect((await post('/auth/otp', { code: newCode })).status).toBe(200);
  });

  test('FR-P5: delivery failure does not fail the password step, returns 503 on resend, and never counts', async () => {
    const { lines, logger } = captureLogs();
    const failing = captureDelivery({ fail: true, failMessage: `550 no such mailbox <${student.email}>` });
    const { post, res } = await passwordStep({ delivery: failing, logger });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'second_factor_required', codeSent: false });

    const resend = await post('/auth/otp/resend');
    expect(resend.status).toBe(503);
    expect((await post('/auth/otp/resend')).status).toBe(503); // cooldown lifted after a failed send, not 429
    expect(await db('otp_codes').where({ used: false })).toHaveLength(0); // failed codes are cancelled
    expect((await userRow(db, student.matric_no)).failed_attempts).toBe(0);
    // Failures are logged, but the address quoted in the SMTP error is scrubbed.
    expect(lines.some((l) => l.includes('otp_delivery_failed'))).toBe(true);
    expect(lines.join('')).not.toContain(student.email);
  });

  test('2FA sign-in returns 503 when Redis is down, and nothing is counted', async () => {
    const deadRedis = connectRedis('redis://127.0.0.1:6390', { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0 });
    try {
      const app = buildRealApp({ db, redis: deadRedis });
      const { post } = await csrfAgent(app);
      const res = await post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
      expect(res.status).toBe(503);
      expect((await userRow(db, student.matric_no)).failed_attempts).toBe(0);

      // A password-only account still signs in without Redis (only settings are unavailable).
      const plain = await post('/auth/login', { identifier: REGISTERED[1].matric_no, password: PASSWORDS.student });
      expect(plain.status).toBe(200);
      expect(plain.body.status).toBe('signed_in');
      expect(cookieFrom(plain, 'cg.acct')).toBeUndefined();
    } finally {
      deadRedis.disconnect();
    }
  });

  test('sms-mock driver records the message in Redis by matric number', async () => {
    const { createDelivery } = require('../../app/src/services/delivery');
    const { loadConfig } = require('../../app/src/config');
    const config = loadConfig({
      NODE_ENV: 'test', DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', CSRF_SECRET: 'x'.repeat(32),
      TOKEN_HMAC_KEY: Buffer.alloc(32, 1).toString('base64'), TOTP_ENC_KEY: Buffer.alloc(32, 2).toString('base64'),
      AUDIT_HMAC_KEY: Buffer.alloc(32, 3).toString('base64'),
      OTP_DELIVERY_DRIVER: 'sms-mock',
    });
    const sms = createDelivery(config, { redis });
    const { res } = await passwordStep({ delivery: sms });
    expect(res.body.codeSent).toBe(true);
    const [latest] = await redis.lrange('cg:sms-mock:outbox', 0, 0);
    expect(JSON.parse(latest)).toMatchObject({ to: student.matric_no });
    expect(JSON.parse(latest).text).toMatch(/code is: \d{6}/);
    expect((await openCode()).channel).toBe('sms-mock');
  });

  test('no OTP code or ticket value appears in the logs', async () => {
    const { lines, logger } = captureLogs();
    const { post, delivery, res } = await passwordStep({ logger });
    const code = delivery.lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    await post('/auth/otp', { code: wrong });
    const ok = await post('/auth/otp', { code });

    const output = lines.join('');
    expect(lines.length).toBeGreaterThan(3);
    expect(output).not.toContain(code);
    expect(output).not.toContain(wrong);
    expect(output).not.toContain(cookieFrom(res, 'cg.preauth'));
    expect(output).not.toContain(cookieFrom(ok, 'cg.acct'));
  });
});
