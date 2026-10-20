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

  test('seeded STAFF0001 logs in with role staff', async () => {
    const { post } = await csrfAgent(app);
    const res = await post('/auth/login', { identifier: 'STAFF0001', password: PASSWORDS.staff });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'signed_in', role: 'staff' });
  });

  test('seeded ADMIN0001 (no TOTP yet) gets past the password but must enrol TOTP (FR-A13, Phase 2)', async () => {
    const { post } = await csrfAgent(app);
    const res = await post('/auth/login', { identifier: 'ADMIN0001', password: PASSWORDS.admin });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('enrolment_required');
  });

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

  test('every failure path does the same bcrypt work as a wrong password (same-cost dummy hash)', async () => {
    // Response time is dominated by bcrypt. Instead of timing requests (which a
    // busy machine distorts), record every bcrypt compare and its cost factor:
    // equal work on every path means no timing difference to measure.
    const real = createHasher(10);
    const compares = [];
    const recording = {
      ...real,
      compare: async (password, hash) => {
        compares.push(costOf(hash));
        return real.compare(password, hash);
      },
    };
    const app10 = buildRealApp({ db, redis, hasher: recording, env: { BCRYPT_COST: '10' } });
    await db('policies').where({ id: 1 }).update({ max_attempts: 20 });
    await db('users').where({ matric_or_staff_id: student.matric_no })
      .update({ password_hash: await real.hash(PASSWORDS.student) });
    await db('users').where({ matric_or_staff_id: REGISTERED[1].matric_no })
      .update({ is_active: false, password_hash: await real.hash(PASSWORDS.student) });
    await db('users').where({ matric_or_staff_id: REGISTERED[2].matric_no })
      .update({ locked_until: db.raw("now() + interval '15 minutes'"), password_hash: await real.hash(PASSWORDS.student) });

    const { post } = await csrfAgent(app10);
    const cases = {
      wrongPassword: { identifier: student.matric_no, password: 'Wrong-Password-1!' },
      unknownMatric: { identifier: 'SCI/2019/9999', password: 'Wrong-Password-1!' },
      unknownEmail: { identifier: 'nobody@example.com', password: 'Wrong-Password-1!' },
      inactive: { identifier: REGISTERED[1].matric_no, password: PASSWORDS.student },
      locked: { identifier: REGISTERED[2].matric_no, password: PASSWORDS.student },
    };
    const work = {};
    for (const [name, body] of Object.entries(cases)) {
      compares.length = 0;
      expect((await post('/auth/login', body)).status).toBe(401);
      work[name] = [...compares];
    }
    // Exactly one bcrypt compare at cost 10 on every path.
    for (const name of Object.keys(cases)) expect(work[name]).toEqual([10]);
  });
});
