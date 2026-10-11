'use strict';

const {
  connectDb, connectRedis, buildRealApp, resetAndSeed, csrfAgent, userRow, REGISTERED, FREE,
} = require('./helpers');
const { REGISTRATION_REJECTED } = require('../../app/src/controllers/authController');
const { createHasher } = require('../../app/src/services/passwordHasher');

const GOOD_PASSWORD = 'Kettle-Mango-42';

describe('registration (FR-A1, FR-A3, FR-A4) against real PostgreSQL', () => {
  let db;
  let redis;
  let app;

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

  test('a student in the registry can register; the row is normalized and the password hashed', async () => {
    const { post } = await csrfAgent(app);
    const student = FREE[0];
    const res = await post('/auth/register', {
      matricNo: `  ${student.matric_no.toLowerCase()} `,
      email: '  New.Student@Example.COM ',
      password: GOOD_PASSWORD,
      consent: true,
    });

    expect(res.status).toBe(201);
    const row = await db('users').join('roles', 'roles.id', 'users.role_id')
      .where({ matric_or_staff_id: student.matric_no }).first('users.*', 'roles.name as role');
    expect(row).toMatchObject({
      matric_or_staff_id: student.matric_no,
      username: student.matric_no,
      email: 'new.student@example.com',
      role: 'student',
      level: student.level,
      faculty: student.faculty,
      is_active: true,
      email_verified: false,
      failed_attempts: 0,
    });
    expect(row.password_hash).toMatch(/^\$2b\$04\$/);
    expect(JSON.stringify(row)).not.toContain(GOOD_PASSWORD);
    await expect(createHasher(4).compare(GOOD_PASSWORD, row.password_hash)).resolves.toBe(true);
  });

  test('after registering, the student can log in with matric number or email', async () => {
    const { post } = await csrfAgent(app);
    await post('/auth/register', { matricNo: FREE[0].matric_no, email: 'me@example.com', password: GOOD_PASSWORD, consent: true });

    expect((await post('/auth/login', { identifier: FREE[0].matric_no, password: GOOD_PASSWORD })).status).toBe(200);
    expect((await post('/auth/login', { identifier: 'ME@example.com', password: GOOD_PASSWORD })).status).toBe(200);
  });

  test('unknown matric, already-registered matric, and taken email all get the same generic answer', async () => {
    const { post } = await csrfAgent(app);
    const attempts = [
      { matricNo: 'SCI/2019/9999', email: 'a@example.com' }, // not in the registry
      { matricNo: REGISTERED[0].matric_no, email: 'b@example.com' }, // already has an account
      { matricNo: FREE[1].matric_no, email: REGISTERED[1].email }, // email belongs to someone else
    ];
    const bodies = [];
    for (const attempt of attempts) {
      const res = await post('/auth/register', { ...attempt, password: GOOD_PASSWORD, consent: true });
      expect(res.status).toBe(400);
      bodies.push(res.text);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toEqual({ error: REGISTRATION_REJECTED });
    expect(await userRow(db, FREE[1].matric_no)).toBeUndefined();
  });

  test.each([
    ['too short', 'Ab!1', /at least 8 characters/],
    ['no uppercase', 'kettle-mango-42', /uppercase/],
    ['no special character', 'KettleMango42', /special character/],
    ['blocklisted', 'Password@123', /too common/],
  ])('weak password (%s) is rejected with the reason and nothing is stored', async (label, password, reason) => {
    const { post } = await csrfAgent(app);
    const res = await post('/auth/register', { matricNo: FREE[0].matric_no, email: 'w@example.com', password, consent: true });
    expect(res.status).toBe(400);
    expect(res.body.fields.password.join(' ')).toMatch(reason);
    expect(await userRow(db, FREE[0].matric_no)).toBeUndefined();
  });

  test('password rules come from the live policy row (no restart needed)', async () => {
    await db('policies').where({ id: 1 }).update({ min_length: 16 });
    const { post, agent } = await csrfAgent(app);

    const res = await post('/auth/register', { matricNo: FREE[0].matric_no, email: 'p@example.com', password: GOOD_PASSWORD, consent: true });
    expect(res.status).toBe(400);
    expect(res.body.fields.password).toContain('Use at least 16 characters.');
    expect((await agent.get('/register')).text).toContain('At least 16 characters');
  });

  test('two simultaneous registrations for the same matric create exactly one account', async () => {
    const { post } = await csrfAgent(app);
    const body = (email) => ({ matricNo: FREE[2].matric_no, email, password: GOOD_PASSWORD, consent: true });
    const results = await Promise.all([post('/auth/register', body('one@example.com')), post('/auth/register', body('two@example.com'))]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(Number((await db('users').where({ matric_or_staff_id: FREE[2].matric_no }).count('* as n'))[0].n)).toBe(1);
  });
});
