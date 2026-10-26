'use strict';

const { buildTestApp } = require('./helpers');
const { ENROLMENT_ROUTES, SECURITY_CHANGE_ROUTES } = require('../../app/src/middleware/session');

/** Walk Express's router tree and list "METHOD /path" for every route whose handlers include fn(layer). */
function routesWhere(app, predicate) {
  const found = [];
  const walk = (stack) => {
    for (const layer of stack) {
      if (layer.route) {
        const handlers = layer.route.stack.map((l) => l.handle);
        for (const method of Object.keys(layer.route.methods)) {
          if (handlers.some(predicate)) found.push(`${method.toUpperCase()} ${layer.route.path}`);
        }
      } else if (layer.handle && layer.handle.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  walk(app.router.stack);
  return found.sort();
}

describe('session checks are on exactly the right routes', () => {
  test('enrolment-only sessions (admin without TOTP) are accepted ONLY by ENROLMENT_ROUTES', () => {
    const using = routesWhere(buildTestApp(), (fn) => fn.requiresSession === true && fn.allowsEnrolment === true);
    expect(using).toEqual([...ENROLMENT_ROUTES].sort());
  });

  test('every account-security change and every admin change needs a session AND a recent sign-in', () => {
    const app = buildTestApp();
    const ADMIN_CHANGES = [
      'GET /admin/logs/export', 'POST /admin/logs/verify', 'POST /admin/policies', 'POST /admin/users/reset-2fa',
      'POST /admin/users/role', 'POST /admin/users/status', 'POST /admin/users/unlock',
      'POST /admin/vouchers', 'POST /admin/vouchers/revoke', 'POST /admin/windows', 'POST /admin/windows/delete',
    ];
    expect(routesWhere(app, (fn) => fn.requiresRecentSignIn === true)).toEqual([...SECURITY_CHANGE_ROUTES, ...ADMIN_CHANGES].sort());
    const withSession = routesWhere(app, (fn) => fn.requiresSession === true);
    for (const route of SECURITY_CHANGE_ROUTES) expect(withSession).toContain(route);
  });

  test('sign-in, registration and recovery endpoints never require a session', () => {
    const withSession = routesWhere(buildTestApp(), (fn) => fn.requiresSession === true);
    for (const route of [
      'POST /auth/login', 'POST /auth/register', 'POST /auth/otp', 'POST /auth/otp/resend', 'POST /auth/totp/verify',
      'POST /auth/password/forgot', 'POST /auth/password/reset', 'GET /login', 'GET /register',
      'POST /auth/voucher', 'GET /voucher', 'POST /auth/verify-email', 'GET /verify-email',
    ]) {
      expect(withSession).not.toContain(route);
    }
  });

  test('sign-out routes require a session; only sign-out (not sign-out-everywhere) accepts an enrolment session', () => {
    const app = buildTestApp();
    expect(routesWhere(app, (fn) => fn.requiresSession === true)).toEqual(expect.arrayContaining(['POST /auth/logout', 'POST /auth/logout-all']));
    expect(routesWhere(app, (fn) => fn.allowsEnrolment === true)).not.toContain('POST /auth/logout-all');
  });

  test('every /admin route requires a session (no admin page or API is reachable without one)', () => {
    const app = buildTestApp();
    const adminRoutes = routesWhere(app, () => true).filter((r) => r.includes(' /admin'));
    expect(adminRoutes.length).toBeGreaterThanOrEqual(11);
    expect(routesWhere(app, (fn) => fn.requiresSession === true)).toEqual(expect.arrayContaining(adminRoutes));
  });

  test('no global (app-level) middleware requires a session', () => {
    const global = buildTestApp().router.stack.filter((layer) => !layer.route && layer.handle.requiresSession);
    expect(global).toHaveLength(0);
  });
});
