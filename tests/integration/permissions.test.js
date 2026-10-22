'use strict';

const express = require('express');
const pinoHttp = require('pino-http');
const request = require('supertest');
const {
  connectDb, connectRedis, resetAndSeed, restoreSeedPermissions, listen, waitFor, trackForTeardown,
} = require('./helpers');
const { createLogger } = require('../../app/src/logger');
const { createPermissions, requirePermission } = require('../../app/src/policies/permissions');

const logger = createLogger({ level: 'silent' });

describe('authorization: services, role_permissions, permission middleware (FR-Z1)', () => {
  let db;
  let redis;

  beforeAll(async () => {
    db = connectDb();
    redis = connectRedis();
    await resetAndSeed(db);
  });
  afterEach(() => restoreSeedPermissions(db));
  afterAll(async () => {
    await db.destroy();
    redis.disconnect();
  });

  function startedPermissions() {
    const p = createPermissions({ db, redis, logger });
    trackForTeardown(p, () => p.stop());
    return p.start().then(() => p);
  }

  test('seeded mapping: students and staff get the three portal services, admins only the console, guests nothing', async () => {
    const rows = await db('role_permissions')
      .join('roles', 'roles.id', 'role_permissions.role_id')
      .join('services', 'services.id', 'role_permissions.service_id')
      .select('roles.name as role', 'services.key as service')
      .orderBy(['role', 'service']);
    const byRole = {};
    for (const { role, service } of rows) (byRole[role] = byRole[role] || []).push(service);
    expect(byRole).toEqual({
      admin: ['admin_console'],
      staff: ['course_registration', 'fees', 'hostel'],
      student: ['course_registration', 'fees', 'hostel'],
    });
  });

  test('can() answers from memory for every role and service', async () => {
    const p = await startedPermissions();
    const expected = {
      student: { fees: true, hostel: true, course_registration: true, admin_console: false },
      staff: { fees: true, hostel: true, course_registration: true, admin_console: false },
      admin: { fees: false, hostel: false, course_registration: false, admin_console: true },
      guest: { fees: false, hostel: false, course_registration: false, admin_console: false },
    };
    for (const [role, services] of Object.entries(expected)) {
      for (const [service, allowed] of Object.entries(services)) {
        expect(`${role}:${service}:${await p.can(role, service)}`).toBe(`${role}:${service}:${allowed}`);
      }
    }
  });

  test('no database query per check once loaded', async () => {
    const p = await startedPermissions();
    let queries = 0;
    const onQuery = () => { queries += 1; };
    db.on('query', onQuery);
    try {
      for (let i = 0; i < 50; i += 1) await p.can('student', 'fees');
    } finally {
      db.removeListener('query', onQuery);
    }
    expect(queries).toBe(0);
  });

  describe('requirePermission middleware', () => {
    async function appFor(permissions) {
      const app = express();
      app.use(pinoHttp({ logger }));
      // Test-only stand-in for the session: the role comes from a header.
      app.use((req, res, next) => {
        const role = req.headers['x-test-role'];
        req.account = role ? { userId: 1, role } : undefined;
        next();
      });
      app.get('/fees', requirePermission(permissions, 'fees'), (req, res) => res.json({ ok: true }));
      app.get('/console', requirePermission(permissions, 'admin_console'), (req, res) => res.json({ ok: true }));
      app.get('/typo', requirePermission(permissions, 'feez'), (req, res) => res.json({ ok: true }));
      return request(await listen(app));
    }

    test.each([
      ['student', '/fees', 200],
      ['student', '/console', 403],
      ['staff', '/fees', 200],
      ['admin', '/fees', 403],
      ['admin', '/console', 200],
      ['guest', '/fees', 403],
      ['guest', '/console', 403],
    ])('%s -> %s = %i', async (role, path, status) => {
      const client = await appFor(await startedPermissions());
      expect((await client.get(path).set('x-test-role', role)).status).toBe(status);
    });

    test('no signed-in user -> 401; a route naming an unknown service -> 403 for everyone', async () => {
      const client = await appFor(await startedPermissions());
      expect((await client.get('/fees')).status).toBe(401);
      expect((await client.get('/typo').set('x-test-role', 'student')).status).toBe(403);
    });
  });

  test('a change announced by one app process reloads the map in another (Redis pub/sub)', async () => {
    const processA = await startedPermissions();
    const processB = await startedPermissions();
    expect(await processB.can('guest', 'fees')).toBe(false);

    await db.raw(`INSERT INTO role_permissions (role_id, service_id)
      SELECT r.id, s.id FROM roles r, services s WHERE r.name = 'guest' AND s.key = 'fees'`);
    await processA.announceChange();
    await waitFor(() => processB.can('guest', 'fees'), { timeoutMs: 30000 });

    await db.raw(`DELETE FROM role_permissions USING roles r, services s
      WHERE role_permissions.role_id = r.id AND role_permissions.service_id = s.id AND r.name = 'guest' AND s.key = 'fees'`);
    await processA.announceChange();
    await waitFor(async () => !(await processB.can('guest', 'fees')), { timeoutMs: 30000 });
  });
});
