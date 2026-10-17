'use strict';

const { generate } = require('otplib');
const {
  connectDb, connectRedis, buildRealApp, resetAndSeed, csrfAgent, userRow, captureLogs, TEST_KEYS, REGISTERED, PASSWORDS,
} = require('./helpers');
const { decryptForUser } = require('../../app/src/services/secrets');
const { RESTART_MESSAGE } = require('../../app/src/controllers/authController');

const now = () => Math.floor(Date.now() / 1000);
const totpAt = (secret, offsetSec = 0) => generate({ secret, epoch: now() + offsetSec });

describe('TOTP and backup codes (FR-A8) against real PostgreSQL + Redis', () => {
  let db;
  let redis;
  const student = REGISTERED[0];
  const encKey = Buffer.from(TEST_KEYS.totpEncKey, 'base64url');

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

  /** Sign in (password only), enrol TOTP through the API, return the secret and backup codes. */
  async function enrol({ logger } = {}) {
    const app = buildRealApp({ db, redis, logger });
    const agent = await csrfAgent(app);
    expect((await agent.post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student })).body.status).toBe('signed_in');
    const start = await agent.post('/auth/totp/enrol');
    expect(start.status).toBe(200);
    const confirm = await agent.post('/auth/totp/enrol/confirm', { code: await totpAt(start.body.secret) });
    expect(confirm.status).toBe(200);
    return { secret: start.body.secret, backupCodes: confirm.body.backupCodes, start, confirm, app };
  }

  /** Password step for an enrolled user; returns the agent helpers. */
  async function passwordStep(env) {
    const agent = await csrfAgent(buildRealApp({ db, redis, env }));
    const res = await agent.post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
    expect(res.body).toMatchObject({ status: 'second_factor_required', method: 'totp' });
    return agent;
  }

  test('enrolment returns a QR code and base32 secret; the pending secret is encrypted in Redis', async () => {
    const app = buildRealApp({ db, redis });
    const { post } = await csrfAgent(app);
    await post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
    const start = await post('/auth/totp/enrol');

    expect(start.status).toBe(200);
    expect(start.headers['cache-control']).toBe('no-store');
    expect(start.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(start.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    const pending = await redis.get(`cg:totp-pending:${(await userRow(db, student.matric_no)).id}`);
    expect(pending).toMatch(/^v1:/);
    expect(pending).not.toContain(start.body.secret);
  });

  test('confirm stores the secret encrypted (bound to the user), turns TOTP on, and returns 8 hashed backup codes', async () => {
    const { secret, backupCodes, confirm } = await enrol();
    expect(confirm.headers['cache-control']).toBe('no-store');
    expect(backupCodes).toHaveLength(8);
    expect(new Set(backupCodes).size).toBe(8);

    const row = await userRow(db, student.matric_no);
    expect(row).toMatchObject({ two_factor_enabled: true, two_factor_method: 'totp' });
    expect(row.totp_secret_enc).not.toContain(secret);
    expect(decryptForUser(encKey, row.id, row.totp_secret_enc)).toBe(secret);
    expect(() => decryptForUser(encKey, row.id + 1, row.totp_secret_enc)).toThrow();

    const stored = await db('totp_backup_codes').where({ user_id: row.id });
    expect(stored).toHaveLength(8);
    for (const code of backupCodes) {
      expect(stored.some((s) => s.code_hash.includes(code.replace('-', '')))).toBe(false);
    }
  });

  test('a wrong confirmation code does not turn TOTP on; enrolling twice is refused', async () => {
    const app = buildRealApp({ db, redis });
    const { post } = await csrfAgent(app);
    await post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
    const start = await post('/auth/totp/enrol');
    const good = await totpAt(start.body.secret);
    expect((await post('/auth/totp/enrol/confirm', { code: good === '000000' ? '111111' : '000000' })).status).toBe(400);
    expect((await userRow(db, student.matric_no)).two_factor_enabled).toBe(false);

    expect((await post('/auth/totp/enrol/confirm', { code: good })).status).toBe(200);
    expect((await post('/auth/totp/enrol')).status).toBe(409);
  });

  test('sign-in with the current authenticator code', async () => {
    const { secret } = await enrol();
    const { post } = await passwordStep();
    // The confirming code's step is already used, so wait for a fresh step if needed.
    const code = await totpAt(secret, 30);
    const res = await post('/auth/totp/verify', { code });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('signed_in');
  });

  test('clock drift: one step either side is accepted, two steps behind is refused', async () => {
    const { secret } = await enrol();
    const userId = (await userRow(db, student.matric_no)).id;

    // Reset the replay guard between checks so each code is judged on drift alone.
    const tryCode = async (offset) => {
      await db('users').where({ id: userId }).update({ totp_last_step: null, failed_attempts: 0 });
      const { post } = await passwordStep();
      return (await post('/auth/totp/verify', { code: await totpAt(secret, offset) })).status;
    };
    expect(await tryCode(-30)).toBe(200);
    expect(await tryCode(30)).toBe(200);
    expect(await tryCode(-60)).toBe(401); // step N-2 is always outside a +/-30 s window
  });

  test('replay: the same code cannot be used twice, and the replay counts as a failure', async () => {
    const { secret } = await enrol();
    const code = await totpAt(secret, 30);
    expect((await (await passwordStep()).post('/auth/totp/verify', { code })).status).toBe(200);

    const second = await (await passwordStep()).post('/auth/totp/verify', { code });
    expect(second.status).toBe(401);
    expect((await userRow(db, student.matric_no)).failed_attempts).toBe(1);
  });

  test('replay race: the same code on two tickets at once signs in exactly once', async () => {
    const { secret } = await enrol();
    const code = await totpAt(secret, 30);
    const [a, b] = [await passwordStep(), await passwordStep()];
    const results = await Promise.all([a.post('/auth/totp/verify', { code }), b.post('/auth/totp/verify', { code })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  test('backup codes: each works once (any case, with or without dash); reuse fails and counts', async () => {
    const { backupCodes } = await enrol();
    const [first, second] = backupCodes;

    expect((await (await passwordStep()).post('/auth/totp/verify', { backupCode: first })).status).toBe(200);
    expect((await (await passwordStep()).post('/auth/totp/verify', { backupCode: first })).status).toBe(401);
    expect((await userRow(db, student.matric_no)).failed_attempts).toBe(1);

    const relaxed = second.toLowerCase().replace('-', '');
    expect((await (await passwordStep()).post('/auth/totp/verify', { backupCode: relaxed })).status).toBe(200);
    expect(await db('totp_backup_codes').where({ used: true })).toHaveLength(2);
  });

  test('concurrent use of one backup code: exactly one succeeds', async () => {
    const { backupCodes } = await enrol();
    const tickets = await Promise.all([passwordStep(), passwordStep(), passwordStep()]);
    const results = await Promise.all(tickets.map((t) => t.post('/auth/totp/verify', { backupCode: backupCodes[0] })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  test('TOTP users cannot fall back to email codes', async () => {
    await enrol();
    const { post } = await passwordStep();
    const res = await post('/auth/otp', { code: '123456' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: RESTART_MESSAGE, restart: true });
  });

  test('if TOTP_ENC_KEY changes, stored secrets cannot be read: 500, and nothing is counted', async () => {
    const { secret } = await enrol();
    const otherKey = Buffer.alloc(32, 99).toString('base64url');
    const agent = await csrfAgent(buildRealApp({ db, redis, env: { TOTP_ENC_KEY: otherKey } }));
    await agent.post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
    const res = await agent.post('/auth/totp/verify', { code: await totpAt(secret, 30) });
    expect(res.status).toBe(500);
    expect((await userRow(db, student.matric_no)).failed_attempts).toBe(0);
  });

  test('malformed codes are rejected by validation (400), not by otplib throwing a 500', async () => {
    await enrol();
    const { post } = await passwordStep();
    for (const body of [{ code: '12345' }, { code: 'abcdef' }, {}, { code: '123456', backupCode: 'ABCDE-FGHJK' }]) {
      expect((await post('/auth/totp/verify', body)).status).toBe(400);
    }
  });

  test('no TOTP secret, otpauth URI, code or backup code appears in the logs', async () => {
    const { lines, logger } = captureLogs();
    const { secret, backupCodes } = await enrol({ logger });
    const output = lines.join('');
    expect(lines.length).toBeGreaterThan(3);
    expect(output).not.toContain(secret);
    expect(output).not.toContain('otpauth://');
    for (const code of backupCodes) expect(output).not.toContain(code);
  });
});
