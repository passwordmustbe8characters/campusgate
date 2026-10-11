'use strict';

const request = require('supertest');
const { buildTestApp } = require('./helpers');

// A database stand-in that fails the test if anything touches it: input
// validation and CSRF checks must reject bad requests before any DB work.
const untouchableDb = () => {
  const db = () => {
    throw new Error('database must not be touched');
  };
  db.raw = async () => ({ rows: [] });
  return db;
};

/** Load /login with a fake policy-free route to get the CSRF cookie + token. */
async function csrfAgent(app) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const token = /name="csrf-token" content="([^"]+)"/.exec(page.text)[1];
  return { agent, token };
}

describe('CSRF protection (NFR-2)', () => {
  test('POST without a CSRF token is rejected with 403', async () => {
    const res = await request(buildTestApp({ db: untouchableDb() }))
      .post('/auth/login')
      .send({ identifier: 'SCI/2022/0001', password: 'whatever' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });

  test('a token from a different visitor is rejected', async () => {
    const app = buildTestApp({ db: untouchableDb() });
    const { token } = await csrfAgent(app);
    const other = request.agent(app);
    await other.get('/login');
    const res = await other.post('/auth/login').set('X-CSRF-Token', token).send({ identifier: 'x', password: 'y' });
    expect(res.status).toBe(403);
  });

  test('pre-session and CSRF cookies are HttpOnly and SameSite=Strict', async () => {
    const res = await request(buildTestApp({ db: untouchableDb() })).get('/login');
    const cookies = res.headers['set-cookie'];
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Strict/);
    }
  });

  test('cookies get the Secure flag and __Host- prefix when COOKIE_SECURE=true', async () => {
    const app = buildTestApp({ db: untouchableDb(), env: { COOKIE_SECURE: 'true' } });
    const cookies = (await request(app).get('/login')).headers['set-cookie'];
    for (const cookie of cookies) {
      expect(cookie).toMatch(/^__Host-/);
      expect(cookie).toMatch(/Secure/);
    }
  });
});

describe('input validation (NFR-1)', () => {
  test.each([
    [{}, ['identifier', 'password']],
    [{ identifier: '   ', password: 'x' }, ['identifier']],
    [{ identifier: 'a', password: 'x'.repeat(300) }, ['password']],
    [{ identifier: 'a', password: `${'é'.repeat(37)}` }, ['password']], // 74 bytes
    [{ identifier: ['a'], password: { $ne: 1 } }, ['identifier', 'password']],
  ])('login rejects %j before touching the database', async (payload, fields) => {
    const { agent, token } = await csrfAgent(buildTestApp({ db: untouchableDb() }));
    const res = await agent.post('/auth/login').set('X-CSRF-Token', token).send(payload);
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.fields).sort()).toEqual(fields);
  });

  test.each([
    [{ email: 'a@b.co', password: 'x', consent: true }, 'matricNo'],
    [{ matricNo: "SCI/2022/0001'; DROP TABLE users;--", email: 'a@b.co', password: 'x', consent: true }, 'matricNo'],
    [{ matricNo: 'SCI/2022/0001', email: 'not-an-email', password: 'x', consent: true }, 'email'],
    [{ matricNo: 'SCI/2022/0001', email: 'a@b.co', password: 'x', consent: false }, 'consent'],
  ])('register rejects %j', async (payload, field) => {
    const { agent, token } = await csrfAgent(buildTestApp({ db: untouchableDb() }));
    const res = await agent.post('/auth/register').set('X-CSRF-Token', token).send(payload);
    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty(field);
  });

  test('validation errors never echo the submitted password', async () => {
    const { agent, token } = await csrfAgent(buildTestApp({ db: untouchableDb() }));
    const secret = `Secret-${'z'.repeat(300)}`;
    const res = await agent.post('/auth/login').set('X-CSRF-Token', token).send({ identifier: 'a', password: secret });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('Secret-');
  });
});
