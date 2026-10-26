'use strict';

const express = require('express');
const { requirePermission } = require('../policies/permissions');

/**
 * Home page and the mock school portal (FR-M1, FR-M2, FR-P1).
 * One sign-in opens every page: each request is checked by the session token
 * (signature, expiry, one Redis denylist lookup) and the role's permission
 * (in-memory map), with NO database read for authentication. The database is
 * read only for the demonstration content of each page.
 */
function portalRouter({ csrf, requireSignedIn, permissions, portalService }) {
  const router = express.Router();
  const page = (name, title, req, res, data) =>
    res.render(name, { title, csrfToken: csrf.generateCsrfToken(req, res), account: req.account, ...data });

  router.get('/home', csrf.ensurePreSession, requireSignedIn, async (req, res) => {
    const can = {};
    for (const service of ['fees', 'hostel', 'course_registration', 'admin_console']) {
      can[service] = await permissions.can(req.account.role, service);
    }
    page('home', 'Home', req, res, { can, expiresAt: new Date(req.account.expiresAt * 1000) });
  });

  router.get('/portal/fees', csrf.ensurePreSession, requireSignedIn, requirePermission(permissions, 'fees'),
    async (req, res) => page('portal-fees', 'Fees', req, res, await portalService.fees(req.account.userId)));

  router.post('/portal/fees/invoice', requireSignedIn, requirePermission(permissions, 'fees'), async (req, res) => {
    const { reference, total } = await portalService.generateInvoice(req.account.userId);
    req.log.info({ event: 'demo_invoice_generated', userId: req.account.userId }, 'demo invoice generated');
    res.status(201).json({
      message: `Invoice ${reference} generated for NGN ${total.toLocaleString('en-NG')}. Demonstration only: no payment can be made.`,
      reference,
      total,
    });
  });

  router.get('/portal/hostel', csrf.ensurePreSession, requireSignedIn, requirePermission(permissions, 'hostel'),
    async (req, res) => page('portal-hostel', 'Hostel', req, res, { halls: await portalService.hostels() }));

  router.get('/portal/registration', csrf.ensurePreSession, requireSignedIn, requirePermission(permissions, 'course_registration'),
    async (req, res) => page('portal-registration', 'Course registration', req, res, await portalService.courses(req.account.userId)));

  return router;
}

module.exports = { portalRouter };
