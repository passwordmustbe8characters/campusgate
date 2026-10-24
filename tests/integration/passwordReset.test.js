'use strict';

const {
  connectDb, connectRedis, buildRealApp, resetAndSeed, csrfAgent, cookieFrom, userRow, captureDelivery, captureLogs,
  gatedDelivery, enableEmail2fa, REGISTERED, PASSWORDS,
} = require('./helpers');
const { FORGOT_RESPONSE } = require('../../app/src/controllers/passwordController');

const NEW_PASSWORD = 'Brand-New-Pass-42';
const tokenFrom = (message) => /#token=([A-Za-z0-9_-]{43})/.exec(message.text)[1];

describe('password reset and change (FR-A9, FR-A10) against real PostgreSQL + Redis', () => {
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

  async function requestReset({ env, delivery = captureDelivery(), logger, email = student.email } = {}) {
    const app = buildRealApp({ db, redis, env, delivery, logger });
    const agent = await csrfAgent(app);
    const res = await agent.post('/auth/password/forgot', { email });
    return { ...agent, app, delivery, res };
  }

  // Wait for the app's own background work (no polling deadline, no timing).
  const settled = (ctx) => ctx.app.get('background').idle();

  async function obtainToken(options) {
    const ctx = await requestReset(options);
    await settled(ctx);
    const message = ctx.delivery.sent.find((m) => /Reset your CampusGate password/.test(m.subject));
    return { ...ctx, token: tokenFrom(message) };
  }

  const login = async (password, identifier = student.matric_no) =>
    (await csrfAgent(buildRealApp({ db, redis }))).post('/auth/login', { identifier, password });

  test('forgot-password: byte-identical 202 for a known email, an unknown email, and a different-case email', async () => {
    const responses = [];
    for (const email of [student.email, 'nobody@example.com', student.email.toUpperCase()]) {
      await redis.flushdb();
      responses.push((await requestReset({ email })).res);
    }
    for (const res of responses) expect(res.status).toBe(202);
    expect(new Set(responses.map((r) => r.text)).size).toBe(1);
    expect(responses[0].body).toEqual(FORGOT_RESPONSE);
  });

  test('forgot-password answers before the email is sent, for known and unknown emails alike (gated driver)', async () => {
    // The driver cannot finish until release(). Both responses arriving while the
    // gate is still closed proves the mail server is not in the request path, so
    // a slow mail server cannot make known emails slower than unknown ones.
    const gated = gatedDelivery();
    const app = buildRealApp({ db, redis, delivery: gated });
    const { post } = await csrfAgent(app);

    const known = await post('/auth/password/forgot', { email: student.email });
    const unknown = await post('/auth/password/forgot', { email: 'nobody@example.com' });
    expect(known.status).toBe(202);
    expect(unknown.text).toBe(known.text);
    expect(gated.sent).toHaveLength(0); // nothing could have been sent yet

    gated.release();
    await app.get('background').idle();
    expect(gated.sent).toHaveLength(1); // only the known email gets a message
    expect(gated.sent[0].email).toBe(student.email);
  });

  test('the token is 32 random bytes, sent in the URL fragment, stored only as an HMAC, valid 30 minutes', async () => {
    const { token, delivery } = await obtainToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(delivery.sent[0].text).toContain(`http://localhost:3000/reset-password#token=${token}`);

    const row = await db('password_reset_tokens').first();
    expect(row.token_hash).not.toContain(token);
    const { rows } = await db.raw('SELECT EXTRACT(EPOCH FROM (expires_at - created_at)) AS ttl FROM password_reset_tokens');
    expect(Math.round(Number(rows[0].ttl))).toBe(1800);
  });

  test('reset sets the new password; the token works once', async () => {
    const { post, token } = await obtainToken();
    const res = await post('/auth/password/reset', { token, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect((await login(NEW_PASSWORD)).status).toBe(200);
    expect((await login(PASSWORDS.student)).status).toBe(401);

    const again = await post('/auth/password/reset', { token, newPassword: 'Another-New-Pass-43' });
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/invalid or has expired/);
  });

  test('an expired token is refused', async () => {
    const { post, token } = await obtainToken();
    await db('password_reset_tokens').update({ expires_at: db.raw("now() - interval '1 second'") });
    expect((await post('/auth/password/reset', { token, newPassword: NEW_PASSWORD })).status).toBe(400);
    expect((await login(PASSWORDS.student)).status).toBe(200);
  });

  test('a newer request invalidates older tokens', async () => {
    const first = await obtainToken();
    await redis.flushdb(); // end the reset cooldown now (no tickets are needed here), instead of sleeping
    const second = await obtainToken();
    expect((await first.post('/auth/password/reset', { token: first.token, newPassword: NEW_PASSWORD })).status).toBe(400);
    expect((await second.post('/auth/password/reset', { token: second.token, newPassword: NEW_PASSWORD })).status).toBe(200);
  });

  test('reset enforces the password policy, and a refused attempt does not use up the token', async () => {
    const { post, token } = await obtainToken();
    const weak = await post('/auth/password/reset', { token, newPassword: 'Password@123' });
    expect(weak.status).toBe(400);
    expect(weak.body.fields.newPassword.join(' ')).toMatch(/too common/);
    expect((await post('/auth/password/reset', { token, newPassword: NEW_PASSWORD })).status).toBe(200);
  });

  test('two concurrent resets with one token: exactly one succeeds', async () => {
    const { post, token } = await obtainToken();
    const results = await Promise.all([
      post('/auth/password/reset', { token, newPassword: 'First-Racer-Pass-1' }),
      post('/auth/password/reset', { token, newPassword: 'Second-Racer-Pass-2' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  test('a successful reset clears an existing lockout', async () => {
    for (let i = 0; i < 5; i += 1) await login('Wrong-Password-1!');
    expect((await userRow(db, student.matric_no)).locked_until).not.toBeNull();

    const { post, token } = await obtainToken();
    expect((await post('/auth/password/reset', { token, newPassword: NEW_PASSWORD })).status).toBe(200);
    expect(await userRow(db, student.matric_no)).toMatchObject({ failed_attempts: 0, locked_until: null });
    expect((await login(NEW_PASSWORD)).status).toBe(200);
  });

  test('a reset never bypasses 2FA: the next sign-in still asks for the second factor', async () => {
    await enableEmail2fa(db, student.matric_no);
    const { post, token } = await obtainToken();
    expect((await post('/auth/password/reset', { token, newPassword: NEW_PASSWORD })).status).toBe(200);
    expect(await userRow(db, student.matric_no)).toMatchObject({ two_factor_enabled: true, two_factor_method: 'email' });
    expect((await login(NEW_PASSWORD)).body.status).toBe('second_factor_required');
  });

  test('a reset revokes the user\'s pending pre-auth ticket and account ticket', async () => {
    // Account ticket from a signed-in session in another browser.
    const other = await csrfAgent(buildRealApp({ db, redis }));
    const signed = await other.post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
    expect(cookieFrom(signed, 'cg.acct')).toBeDefined();

    const { post, token } = await obtainToken();
    expect((await post('/auth/password/reset', { token, newPassword: NEW_PASSWORD })).status).toBe(200);

    const settings = await other.post('/auth/2fa/email/enable');
    expect(settings.status).toBe(401);
    expect(await redis.keys('cg:acct:*')).toHaveLength(0);
  });

  test('pre-auth tickets are revoked too (2FA user mid-sign-in)', async () => {
    await enableEmail2fa(db, student.matric_no);
    const pending = await csrfAgent(buildRealApp({ db, redis }));
    await pending.post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
    expect((await redis.keys('cg:preauth:*')).length).toBeGreaterThan(0);

    const { post, token } = await obtainToken();
    await post('/auth/password/reset', { token, newPassword: NEW_PASSWORD });
    expect(await redis.keys('cg:preauth:*')).toHaveLength(0);
    expect((await pending.post('/auth/otp', { code: '123456' })).body.restart).toBe(true);
  });

  test('a "password changed" email is sent after a reset, without blocking the response', async () => {
    const delivery = captureDelivery();
    const ctx = await obtainToken({ delivery });
    // From now on sends cannot finish until we open the gate.
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    const original = delivery.send;
    delivery.send = async (m) => { await gate; return original(m); };

    const res = await ctx.post('/auth/password/reset', { token: ctx.token, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200); // answered while the notification is still blocked
    const changed = () => delivery.sent.find((m) => /password was changed/.test(m.subject));
    expect(changed()).toBeUndefined();

    open();
    await settled(ctx);
    expect(changed().email).toBe(student.email);
  });

  test('forgot-password background failures are logged without the email address and counted', async () => {
    const { lines, logger } = captureLogs();
    const failing = captureDelivery({ fail: true, failMessage: `550 mailbox unavailable for <${student.email}>` });
    const ctx = await requestReset({ delivery: failing, logger });
    expect(ctx.res.status).toBe(202);
    expect(ctx.res.body).toEqual(FORGOT_RESPONSE);

    await settled(ctx);
    expect(Number(await redis.get('cg:metrics:reset_email_failures'))).toBe(1);
    const failure = lines.map((l) => JSON.parse(l)).find((l) => l.event === 'reset_email_failed');
    expect(failure.error.type).toBe('DeliveryError');
    expect(failure.error.cause.message).toContain('[email]');
    expect(lines.join('')).not.toContain(student.email);
  });

  test('cooldown: a second request within the cooldown sends nothing but answers identically', async () => {
    const delivery = captureDelivery();
    const app = buildRealApp({ db, redis, delivery });
    const { post } = await csrfAgent(app);
    const a = await post('/auth/password/forgot', { email: student.email });
    await app.get('background').idle();
    expect(delivery.sent).toHaveLength(1);
    const b = await post('/auth/password/forgot', { email: student.email });
    await app.get('background').idle();
    expect(b.text).toBe(a.text);
    expect(delivery.sent).toHaveLength(1);
  });

  describe('change password (account ticket)', () => {
    async function signedIn(delivery = captureDelivery()) {
      const app = buildRealApp({ db, redis, delivery });
      const agent = await csrfAgent(app);
      await agent.post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
      return { ...agent, app, delivery };
    }

    test('changes the password, revokes the tickets (sign in again), and sends a notice', async () => {
      const ctx = await signedIn();
      const res = await ctx.post('/auth/password/change', { currentPassword: PASSWORDS.student, newPassword: NEW_PASSWORD });
      expect(res.status).toBe(200);
      expect(await redis.keys('cg:acct:*')).toHaveLength(0);
      expect((await ctx.post('/auth/2fa/email/enable')).status).toBe(401);
      expect((await login(NEW_PASSWORD)).status).toBe(200);
      await settled(ctx);
      expect(ctx.delivery.sent.find((m) => /password was changed/.test(m.subject))).toBeDefined();
    });

    test('a wrong current password is refused and counts as a credential failure', async () => {
      const { post } = await signedIn();
      const res = await post('/auth/password/change', { currentPassword: 'Wrong-Password-1!', newPassword: NEW_PASSWORD });
      expect(res.status).toBe(400);
      expect(res.body.fields).toHaveProperty('currentPassword');
      expect((await userRow(db, student.matric_no)).failed_attempts).toBe(1);
    });

    test('the same password policy applies', async () => {
      const { post } = await signedIn();
      const res = await post('/auth/password/change', { currentPassword: PASSWORDS.student, newPassword: 'short' });
      expect(res.status).toBe(400);
      expect(res.body.fields.newPassword.join(' ')).toMatch(/at least 8/);
      expect((await login(PASSWORDS.student)).status).toBe(200);
    });

    test('needs the account ticket', async () => {
      const { post } = await csrfAgent(buildRealApp({ db, redis }));
      expect((await post('/auth/password/change', { currentPassword: PASSWORDS.student, newPassword: NEW_PASSWORD })).status).toBe(401);
    });
  });

  test('no reset token, password or email address appears in the logs', async () => {
    const { lines, logger } = captureLogs();
    const delivery = captureDelivery();
    const app = buildRealApp({ db, redis, delivery, logger });
    const { post } = await csrfAgent(app);
    await post('/auth/password/forgot', { email: student.email });
    await app.get('background').idle();
    const token = tokenFrom(delivery.sent[0]);
    await post('/auth/password/reset', { token, newPassword: NEW_PASSWORD });
    await app.get('background').idle();
    expect(delivery.sent).toHaveLength(2);

    const output = lines.join('');
    expect(lines.length).toBeGreaterThan(3);
    expect(output).not.toContain(token);
    expect(output).not.toContain(NEW_PASSWORD);
    expect(output).not.toContain(student.email);
  });
});
