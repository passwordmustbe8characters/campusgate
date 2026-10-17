'use strict';

const {
  connectDb, connectRedis, buildRealApp, resetAndSeed, csrfAgent, userRow, REGISTERED, PASSWORDS,
} = require('./helpers');
const { loginFailedMessage } = require('../../app/src/controllers/authController');
const { createHasher, costOf } = require('../../app/src/services/passwordHasher');

describe('login (FR-A4, FR-A5) against real PostgreSQL', () => {
  let db;
  let redis;
  let app;
  const student = REGISTERED[0];

  beforeAll(() => {
    db = connectDb();
    redis = connectRedis();
    app = buildRealApp({ db, redis });
  });
  beforeEach(() => resetAndSeed(db));
  afterAll(async () => {
    await db.destroy();
    redis.disconnect();
  });

  test('seeded student logs in by matric number (any case/spacing) and by email', async () => {
    const { post } = await csrfAgent(app);
    const byMatric = await post('/auth/login', { identifier: ` ${student.matric_no.toLowerCase()} `, password: PASSWORDS.student });
    expect(byMatric.status).toBe(200);
    expect(byMatric.body).toEqual({ status: 'signed_in', message: 'Signed in.', role: 'student' });

    const byEmail = await post('/auth/login', { identifier: student.email.toUpperCase(), password: PASSWORDS.student });
    expect(byEmail.status).toBe(200);
  });

  test.each([['STAFF0001', 'staff', PASSWORDS.staff], ['ADMIN0001', 'admin', PASSWORDS.admin]])(
    'seeded %s logs in with role %s',
    async (identifier, role, password) => {
      const { post } = await csrfAgent(app);
      const res = await post('/auth/login', { identifier, password });
      expect(res.status).toBe(200);
      expect(res.body.role).toBe(role);
    },
  );

  test('success records last_login and resets earlier failures', async () => {
    const { post } = await csrfAgent(app);
    await post('/auth/login', { identifier: student.matric_no, password: 'Wrong-Password-1!' });
    expect((await userRow(db, student.matric_no)).failed_attempts).toBe(1);

    await post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
    const row = await userRow(db, student.matric_no);
    expect(row.failed_attempts).toBe(0);
    expect(row.last_login).toBeInstanceOf(Date);
  });

  test('wrong password, unknown user, inactive account, and locked account give byte-identical 401s', async () => {
    const { post } = await csrfAgent(app);
    await db('users').where({ matric_or_staff_id: REGISTERED[1].matric_no }).update({ is_active: false });
    await db('users').where({ matric_or_staff_id: REGISTERED[2].matric_no })
      .update({ failed_attempts: 5, locked_until: db.raw("now() + interval '15 minutes'") });

    const cases = [
      { identifier: student.matric_no, password: 'Wrong-Password-1!' }, // wrong password
      { identifier: 'SCI/2019/9999', password: PASSWORDS.student }, // unknown matric
      { identifier: 'nobody@example.com', password: PASSWORDS.student }, // unknown email
      { identifier: REGISTERED[1].matric_no, password: PASSWORDS.student }, // inactive, correct password
      { identifier: REGISTERED[2].matric_no, password: PASSWORDS.student }, // locked, correct password
    ];
    const responses = [];
    for (const body of cases) responses.push(await post('/auth/login', body));

    for (const res of responses) expect(res.status).toBe(401);
    expect(new Set(responses.map((r) => r.text)).size).toBe(1);
    expect(responses[0].body).toEqual({ error: loginFailedMessage({ lockout_minutes: 15 }) });
  });

  test('unknown-user logins take about as long as wrong-password logins (same-cost dummy hash)', async () => {
    // Real cost (10) for this test only, so the timing difference would be visible if it existed.
    const hasher = createHasher(10);
    const timedApp = buildRealApp({ db, redis, hasher, env: { BCRYPT_COST: '10' } });
    await db('policies').where({ id: 1 }).update({ max_attempts: 20 });
    await db('users').where({ matric_or_staff_id: student.matric_no })
      .update({ password_hash: await hasher.hash(PASSWORDS.student) });
    expect(costOf(await hasher.dummyHash())).toBe(10);

    const { post } = await csrfAgent(timedApp);
    const median = async (body) => {
      const times = [];
      for (let i = 0; i < 7; i += 1) {
        const start = process.hrtime.bigint();
        expect((await post('/auth/login', body)).status).toBe(401);
        times.push(Number(process.hrtime.bigint() - start) / 1e6);
      }
      return times.sort((a, b) => a - b)[3];
    };
    const wrongPassword = await median({ identifier: student.matric_no, password: 'Wrong-Password-1!' });
    const unknownUser = await median({ identifier: 'SCI/2019/9999', password: 'Wrong-Password-1!' });

    // Loose bound: without the dummy hash, unknown users would be ~10x faster.
    const ratio = unknownUser / wrongPassword;
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });
});
