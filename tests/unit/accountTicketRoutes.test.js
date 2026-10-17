'use strict';

const { buildTestApp } = require('./helpers');
const { ACCOUNT_TICKET_ROUTES, ENROLMENT_ROUTES } = require('../../app/src/middleware/tickets');

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

describe('interim account ticket is accepted ONLY by the listed security-settings routes', () => {
  test('the set of routes using requireAccountTicket equals ACCOUNT_TICKET_ROUTES exactly', () => {
    const app = buildTestApp();
    const using = routesWhere(app, (fn) => fn.acceptsAccountTicket === true);
    expect(using).toEqual([...ACCOUNT_TICKET_ROUTES].sort());
  });

  test('enrolment-only tickets (admin without TOTP) are accepted ONLY by the TOTP enrolment routes and the page', () => {
    const app = buildTestApp();
    const using = routesWhere(app, (fn) => fn.acceptsAccountTicket === true && fn.allowsEnrolment === true);
    expect(using).toEqual([...ENROLMENT_ROUTES].sort());
  });

  test('no global (app-level) middleware accepts the account ticket', () => {
    const app = buildTestApp();
    const global = app.router.stack.filter((layer) => !layer.route && layer.handle.acceptsAccountTicket);
    expect(global).toHaveLength(0);
  });
});
