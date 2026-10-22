'use strict';

const { requirePermission } = require('../../app/src/policies/permissions');

const fakePermissions = (grants) => ({
  knownService: async (s) => ['fees', 'admin_console'].includes(s),
  can: async (role, s) => Boolean(grants[role] && grants[role].includes(s)),
});

function run(middleware, account) {
  return new Promise((resolve) => {
    const req = { account, log: { info() {}, error() {} } };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    middleware(req, res, () => resolve({ status: 'next' }));
  });
}

describe('requirePermission (FR-Z1)', () => {
  const perms = fakePermissions({ student: ['fees'], admin: ['admin_console'] });

  test('a granted role passes through', async () => {
    expect(await run(requirePermission(perms, 'fees'), { userId: 1, role: 'student' })).toEqual({ status: 'next' });
  });

  test('a role without the grant gets 403', async () => {
    expect((await run(requirePermission(perms, 'fees'), { userId: 2, role: 'admin' })).status).toBe(403);
  });

  test('no signed-in user gets 401', async () => {
    expect((await run(requirePermission(perms, 'fees'), undefined)).status).toBe(401);
  });

  test('a route naming an unknown service is denied even for a granted role', async () => {
    expect((await run(requirePermission(perms, 'feez'), { userId: 1, role: 'student' })).status).toBe(403);
  });

  test('the middleware records which service it protects (for route audits)', () => {
    expect(requirePermission(perms, 'fees').requiresService).toBe('fees');
  });
});
