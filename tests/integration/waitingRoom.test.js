'use strict';

const request = require('supertest');
const {
  connectDb, connectRedis, buildRealApp, resetAndSeed, csrfAgent, cookieFrom, userRow, listen, REGISTERED, PASSWORDS, TEST_KEYS,
} = require('./helpers');
const { createWaitingRoom, eta, KEYS } = require('../../app/src/services/waitingRoom');

const HMAC = Buffer.from(TEST_KEYS.tokenHmacKey, 'base64url');

describe('waiting room / admission control (FR-P2, FR-P3) against real Redis', () => {
  let db;
  let redis;

  beforeAll(() => {
    db = connectDb();
    redis = connectRedis();
  });
  beforeEach(async () => {
    await resetAndSeed(db);
    await redis.flushdb();
    await db('policies').update({ queue_enabled: true, queue_capacity: 2, queue_batch: 2, queue_interval_sec: 5 });
  });
  afterAll(async () => {
    await db.destroy();
    redis.disconnect();
  });

  const policy = (over = {}) => ({ queue_enabled: true, queue_capacity: 2, queue_batch: 2, queue_interval_sec: 5, ...over });
  const room = (opts = {}) => createWaitingRoom({ redis, hmacKey: HMAC, passTtlSec: 120, ticketTimeoutSec: 30, ...opts });

  describe('the service', () => {
    test('passes are given at once while there is room; then visitors must queue', async () => {
      const wr = room();
      expect(await wr.tryEnter(policy())).toEqual(expect.any(String));
      expect(await wr.tryEnter(policy())).toEqual(expect.any(String));
      expect(await wr.tryEnter(policy())).toBeNull();
      expect(await wr.stats()).toEqual({ queued: 0, inProgress: 2 });
    });

    test('FIFO: tickets are admitted in the order they joined, in batches, within capacity', async () => {
      const wr = room();
      const p = policy({ queue_capacity: 3, queue_batch: 2 });
      const tickets = [];
      for (let i = 0; i < 5; i += 1) tickets.push((await wr.join(p)).ticket);
      expect((await wr.status(tickets[4], p))).toMatchObject({ state: 'waiting', position: 5 });

      expect(await wr.admitBatch(p)).toBe(2); // batch of 2
      expect(await wr.status(tickets[0], p)).toMatchObject({ state: 'admitted' });
      expect(await wr.status(tickets[1], p)).toMatchObject({ state: 'admitted' });
      expect(await wr.status(tickets[2], p)).toMatchObject({ state: 'waiting', position: 1 });

      expect(await wr.admitBatch(p)).toBe(1); // only 1 place left (capacity 3)
      expect(await wr.status(tickets[2], p)).toMatchObject({ state: 'admitted' });
      expect(await wr.admitBatch(p)).toBe(0); // full
      expect(await wr.status(tickets[3], p)).toMatchObject({ state: 'waiting', position: 1 });
      expect(await wr.status(tickets[4], p)).toMatchObject({ state: 'waiting', position: 2 });
    });

    test('nobody jumps the queue: while anyone waits, a newcomer cannot take a free place directly', async () => {
      const wr = room();
      const p = policy({ queue_capacity: 1 });
      const first = await wr.tryEnter(p);
      const { ticket } = await wr.join(p);
      await wr.release(first); // a place is free, but someone is waiting
      expect(await wr.tryEnter(p)).toBeNull();
      expect(await wr.admitBatch(p)).toBe(1);
      expect(await wr.status(ticket, p)).toMatchObject({ state: 'admitted' });
    });

    test('a ticket whose page stops polling expires and loses its place; others move up', async () => {
      let t = 1_000_000;
      const wr = room({ now: () => t, ticketTimeoutSec: 30 });
      const p = policy();
      const a = await wr.join(p);
      const b = await wr.join(p);
      t += 20_000;
      await wr.status(b.ticket, p); // b keeps polling, a does not
      t += 15_000; // a last seen 35 s ago, b 15 s ago
      expect(await wr.status(b.ticket, p)).toMatchObject({ state: 'waiting', position: 1 });
      expect(await wr.status(a.ticket, p)).toEqual({ state: 'expired' });
    });

    test('an admitted place that is never claimed is given back after the claim window', async () => {
      let t = 1_000_000;
      const wr = room({ now: () => t, claimSec: 30 });
      const p = policy({ queue_capacity: 1, queue_batch: 1 });
      await wr.join(p);
      const second = await wr.join(p);
      expect(await wr.admitBatch(p)).toBe(1);
      t += 20_000;
      await wr.status(second.ticket, p); // second keeps polling...
      t += 11_000; // ...while first never comes back for its pass (31 s > 30 s claim window)
      await wr.status(second.ticket, p);
      expect(await wr.admitBatch(p)).toBe(1);
      expect(await wr.status(second.ticket, p)).toMatchObject({ state: 'admitted' });
    });

    test('a pass expires after passTtlSec even if the sign-in is never finished', async () => {
      let t = 1_000_000;
      const wr = room({ now: () => t, passTtlSec: 120 });
      const pass = await wr.tryEnter(policy());
      expect(await wr.hasPass(pass)).toBe(true);
      t += 121_000;
      expect(await wr.hasPass(pass)).toBe(false);
    });

    test('tickets and passes are signed: forged or altered values are refused', async () => {
      const wr = room();
      const { ticket } = await wr.join(policy());
      const [id] = ticket.split('.');
      for (const bad of [`${id}.AAAA`, `${id}x.${ticket.split('.')[1]}`, 'nonsense', '', undefined, `${'A'.repeat(22)}.${'B'.repeat(43)}`]) {
        expect(await wr.status(bad, policy())).toEqual({ state: 'expired' });
        expect(await wr.hasPass(bad)).toBe(false);
      }
      const other = createWaitingRoom({ redis, hmacKey: Buffer.alloc(32, 99) });
      expect(await other.status(ticket, policy())).toEqual({ state: 'expired' });
    });

    test('estimated wait = whole batches ahead x interval', () => {
      const p = policy({ queue_batch: 50, queue_interval_sec: 5 });
      expect(eta(1, p)).toBe(5);
      expect(eta(50, p)).toBe(5);
      expect(eta(51, p)).toBe(10);
      expect(eta(500, p)).toBe(50);
    });

    test('Redis keeps no identity: queue entries are random ids only', async () => {
      const wr = room();
      await wr.join(policy());
      const members = await redis.zrange(KEYS.queue, 0, -1);
      expect(members[0]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    });
  });

  describe('through the app', () => {
    const student = (i) => REGISTERED[i];
    const login = (agent, i, password = PASSWORDS.student) => agent.post('/auth/login', { identifier: student(i).matric_no, password });

    test('when sign-ins in progress reach capacity, the next visitor is queued (503, queued, Retry-After) and nothing is counted', async () => {
      const app = buildRealApp({ db, redis });
      const a = await csrfAgent(app);
      const b = await csrfAgent(app);
      const c = await csrfAgent(app);
      // a and b take the two places with WRONG passwords: the sign-in is not finished, so the places stay taken.
      expect((await login(a, 0, 'Wrong-Password-1!')).status).toBe(401);
      expect((await login(b, 1, 'Wrong-Password-1!')).status).toBe(401);
      const queued = await login(c, 2);
      expect(queued.status).toBe(503);
      expect(queued.body).toMatchObject({ queued: true, redirect: '/waiting' });
      expect(queued.headers['retry-after']).toBe('5');
      expect((await userRow(db, student(2).matric_no)).failed_attempts).toBe(0);
      // a keeps its place for a retry (its pass cookie), and can now sign in.
      expect((await login(a, 0)).status).toBe(200);
    });

    test('a completed sign-in frees its place for the next person', async () => {
      const app = buildRealApp({ db, redis });
      const a = await csrfAgent(app);
      const b = await csrfAgent(app);
      const c = await csrfAgent(app);
      const ok = await login(a, 0);
      expect(ok.status).toBe(200);
      // The pass was taken and released in the same request: no place is held, and the browser's
      // last Set-Cookie for cg.admit clears it.
      expect(await redis.zcard(KEYS.active)).toBe(0);
      const admitHeaders = ok.headers['set-cookie'].filter((h) => h.startsWith('cg.admit='));
      expect(admitHeaders[admitHeaders.length - 1]).toMatch(/^cg\.admit=;/);
      expect((await login(b, 1, 'Wrong-Password-1!')).status).toBe(401);
      expect((await login(c, 2)).status).toBe(200); // a's place was given back
    });

    test('waiting room flow: join, see position, get admitted by the batch, then sign in', async () => {
      const app = buildRealApp({ db, redis });
      const blockers = [await csrfAgent(app), await csrfAgent(app)];
      await login(blockers[0], 0, 'Wrong-Password-1!');
      await login(blockers[1], 1, 'Wrong-Password-1!');

      const visitor = await csrfAgent(app);
      expect((await visitor.agent.get('/waiting')).status).toBe(200);
      const joined = await visitor.post('/queue/join');
      expect(joined.status).toBe(201);
      expect(joined.body).toMatchObject({ state: 'waiting', position: 1, etaSec: 5 });
      expect(cookieFrom(joined, 'cg.wr')).toBeDefined();
      expect((await visitor.agent.get('/queue/status')).body).toMatchObject({ state: 'waiting', position: 1 });

      // Free the places (pass TTL), then the admitter runs one batch.
      await redis.del(KEYS.active);
      expect(await app.get('services').waitingRoom.admitBatch(policy())).toBe(1);
      const admitted = await visitor.agent.get('/queue/status');
      expect(admitted.body).toEqual({ state: 'admitted' });
      expect(cookieFrom(admitted, 'cg.admit')).toBeDefined();
      expect((await login(visitor, 2)).status).toBe(200);
    });

    test('staff and administrators skip the queue', async () => {
      const app = buildRealApp({ db, redis });
      await login(await csrfAgent(app), 0, 'Wrong-Password-1!');
      await login(await csrfAgent(app), 1, 'Wrong-Password-1!');
      const staff = await csrfAgent(app);
      const res = await staff.post('/auth/login', { identifier: 'STAFF0001', password: PASSWORDS.staff });
      expect(res.status).toBe(200);
      const admin = await csrfAgent(app);
      expect((await admin.post('/auth/login', { identifier: 'ADMIN0001', password: PASSWORDS.admin })).body.status).toBe('enrolment_required');
    });

    test('queue_enabled = false (baseline): nobody is ever queued, even far over capacity', async () => {
      await db('policies').update({ queue_enabled: false, queue_capacity: 1 });
      const app = buildRealApp({ db, redis });
      for (let i = 0; i < 3; i += 1) {
        expect((await login(await csrfAgent(app), i, 'Wrong-Password-1!')).status).toBe(401);
      }
      expect(await redis.zcard(KEYS.active)).toBe(0);
    });

    test('capacity is read from the live policy: raising it lets people in without a restart', async () => {
      const app = buildRealApp({ db, redis });
      await login(await csrfAgent(app), 0, 'Wrong-Password-1!');
      await login(await csrfAgent(app), 1, 'Wrong-Password-1!');
      const c = await csrfAgent(app);
      expect((await login(c, 2)).status).toBe(503);
      await db('policies').update({ queue_capacity: 3 });
      expect((await login(c, 2)).status).toBe(200);
    });

    test('Redis down: the waiting room cannot work, so sign-in is let through (fail open)', async () => {
      const broken = connectRedis('redis://127.0.0.1:1', { maxRetriesPerRequest: 0, enableOfflineQueue: false, lazyConnect: true });
      const server = await listen(buildRealApp({ db, redis: broken }));
      const page = await request(server).get('/login');
      const csrf = /name="csrf-token" content="([^"]+)"/.exec(page.text)[1];
      const cookie = page.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
      const res = await request(server).post('/auth/login').set('Cookie', cookie).set('X-CSRF-Token', csrf)
        .send({ identifier: student(0).matric_no, password: PASSWORDS.student });
      expect(res.status).toBe(200);
    });
  });
});
