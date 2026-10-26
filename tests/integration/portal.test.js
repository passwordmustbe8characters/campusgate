'use strict';

const request = require('supertest');
const {
  connectDb, connectRedis, buildRealApp, resetAndSeed, csrfAgent, cookieFrom, listen, restoreSeedPermissions,
  REGISTERED, PASSWORDS,
} = require('./helpers');

const PAGES = ['/portal/fees', '/portal/hostel', '/portal/registration'];

describe('home page and mock portal: one sign-in opens every page (FR-P1, FR-M1, FR-M2)', () => {
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

  async function signedIn(identifier = student.matric_no, password = PASSWORDS.student) {
    const app = buildRealApp({ db, redis });
    const agent = await csrfAgent(app);
    const res = await agent.post('/auth/login', { identifier, password });
    expect(res.body.status).toBe('signed_in');
    return { ...agent, app, token: cookieFrom(res, 'cg.session') };
  }

  /** Count the SQL statements a request runs (knex 'query' events on the shared pool). */
  async function queriesDuring(fn) {
    const seen = [];
    const listener = (q) => seen.push(q.sql);
    db.on('query', listener);
    try {
      const res = await fn();
      return { res, seen };
    } finally {
      db.removeListener('query', listener);
    }
  }

  test('a student signs in once and opens Home, Fees, Hostel and Course registration with the same token', async () => {
    const { agent } = await signedIn();
    const home = await agent.get('/home');
    expect(home.status).toBe(200);
    for (const link of PAGES) expect(home.text).toContain(`href="${link}"`);
    for (const url of PAGES) {
      const page = await agent.get(url);
      expect(page.status).toBe(200);
      expect(page.text).toContain('DEMONSTRATION DATA');
    }
    // Still exactly one session: no second sign-in happened.
    expect(await db('sessions')).toHaveLength(1);
  });

  test('pages show the student\'s level data: fees with a total, and courses with total units', async () => {
    const { agent } = await signedIn();
    const level = (await db('users').where({ matric_or_staff_id: student.matric_no }).first()).level;
    const items = await db('demo_fees').where({ level });
    expect(items.length).toBeGreaterThan(0);
    const fees = await agent.get('/portal/fees');
    for (const item of items) expect(fees.text).toContain(item.item);
    const total = items.reduce((s, i) => s + i.amount_naira, 0);
    expect(fees.text).toContain(total.toLocaleString('en-NG'));
    const courses = await db('demo_courses').where({ level });
    const reg = await agent.get('/portal/registration');
    for (const c of courses) expect(reg.text).toContain(c.code);
  });

  test('the authentication check runs NO database query: a refused request touches the database zero times', async () => {
    // Admin role has no portal service: build a valid admin-role session directly and ask for Fees.
    const app = buildRealApp({ db, redis });
    const server = await listen(app);
    const sessions = app.get('services').sessions;
    const admin = await db('users').where({ matric_or_staff_id: 'ADMIN0001' }).first();
    const { token: adminToken } = await sessions.issue({ userId: admin.id, role: 'admin', ttlMin: 5 });
    await app.get('services').permissions.load(); // permission map already in memory, as after start-up

    const denied = await queriesDuring(() => request(server).get('/portal/fees').set('Cookie', `cg.session=${adminToken}`));
    expect(denied.res.status).toBe(403);
    expect(denied.seen).toEqual([]);

    const noSession = await queriesDuring(() => request(server).get('/portal/fees'));
    expect(noSession.res.status).toBe(302);
    expect(noSession.seen).toEqual([]);
  });

  test('an allowed page reads ONLY demonstration content tables, never users-for-auth, sessions or permissions', async () => {
    const { agent, app } = await signedIn();
    await app.get('services').permissions.load();
    const { res, seen } = await queriesDuring(() => agent.get('/portal/hostel'));
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/from "demo_hostels"/);
  });

  test('without a session every page redirects to /login; a revoked token is refused at once', async () => {
    const server = await listen(buildRealApp({ db, redis }));
    for (const url of ['/home', ...PAGES]) {
      const res = await request(server).get(url);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/login');
    }
    const { post, agent, token } = await signedIn();
    expect((await agent.get('/portal/fees')).status).toBe(200);
    await post('/auth/logout');
    const replay = await request(server).get('/portal/fees').set('Cookie', `cg.session=${token}`);
    expect(replay.status).toBe(302);
  });

  test('a revoked permission takes effect at once: the page is refused (403) with the same token', async () => {
    const { agent, app } = await signedIn();
    expect((await agent.get('/portal/hostel')).status).toBe(200);
    await db('role_permissions')
      .whereIn('role_id', db('roles').where({ name: 'student' }).select('id'))
      .whereIn('service_id', db('services').where({ key: 'hostel' }).select('id'))
      .del();
    await app.get('services').permissions.load(); // what the Redis change notice triggers in every process
    expect((await agent.get('/portal/hostel')).status).toBe(403);
    expect((await agent.get('/portal/fees')).status).toBe(200);
    const home = await agent.get('/home');
    expect(home.text).not.toContain('href="/portal/hostel"');
    await restoreSeedPermissions(db);
  });

  test('generate a demo invoice: unique reference, stored, shown on the page; CSRF and session required', async () => {
    const { post, agent } = await signedIn();
    const first = await post('/portal/fees/invoice');
    expect(first.status).toBe(201);
    expect(first.body.reference).toMatch(/^CG-\d{4}-[2-9A-HJKMNP-Z]{8}$/);
    expect(first.body.message).toMatch(/Demonstration only/);
    const second = await post('/portal/fees/invoice');
    expect(second.body.reference).not.toBe(first.body.reference);
    expect(await db('demo_invoices')).toHaveLength(2);
    expect((await agent.get('/portal/fees')).text).toContain(first.body.reference);

    expect((await agent.post('/portal/fees/invoice').send({})).status).toBe(403); // no CSRF token
    const { post: anonymous } = await csrfAgent(buildRealApp({ db, redis }));
    expect((await anonymous('/portal/fees/invoice')).status).toBe(401);
  });

  test('staff use the same three services; a guest-role session sees none', async () => {
    const staff = await signedIn('STAFF0001', PASSWORDS.staff);
    for (const url of PAGES) expect((await staff.agent.get(url)).status).toBe(200);

    const app = buildRealApp({ db, redis });
    const server = await listen(app);
    const guestUser = await db('users').where({ matric_or_staff_id: student.matric_no }).first();
    const { token } = await app.get('services').sessions.issue({ userId: guestUser.id, role: 'guest', ttlMin: 5 });
    const home = await request(server).get('/home').set('Cookie', `cg.session=${token}`);
    expect(home.status).toBe(200);
    expect(home.text).toContain('No portal services are available to your role.');
    expect((await request(server).get('/portal/fees').set('Cookie', `cg.session=${token}`)).status).toBe(403);
  });

  test('an admin enrolment-only session cannot open Home or the portal', async () => {
    const app = buildRealApp({ db, redis });
    const agent = await csrfAgent(app);
    const res = await agent.post('/auth/login', { identifier: 'ADMIN0001', password: PASSWORDS.admin });
    expect(res.body.status).toBe('enrolment_required');
    for (const url of ['/home', ...PAGES]) expect((await agent.agent.get(url)).status).toBe(302);
  });

  test('Redis down: portal pages fail closed (503)', async () => {
    const { token } = await signedIn();
    const broken = connectRedis('redis://127.0.0.1:1', { maxRetriesPerRequest: 0, enableOfflineQueue: false, lazyConnect: true });
    const server = await listen(buildRealApp({ db, redis: broken }));
    for (const url of ['/home', ...PAGES]) {
      expect((await request(server).get(url).set('Cookie', `cg.session=${token}`)).status).toBe(503);
    }
  });
});
