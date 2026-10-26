'use strict';

const express = require('express');
const { requirePermission } = require('../policies/permissions');
const { auditContext } = require('../audit/audit');
const { loadAccount } = require('../services/accountState');

/**
 * Home page and the mock school portal (FR-M1, FR-M2, FR-P1).
 * One sign-in opens every page: each request is checked by the session token
 * (signature, expiry, one Redis denylist lookup) and the role's permission
 * (in-memory map), with NO database read for authentication. The database is
 * read only for the demonstration content of each page.
 */
function portalRouter({ db, csrf, requireSignedIn, permissions, portalService, otp, audit }) {
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

  // FR-M3: step-up before the (mock) payment. A signed-in student must prove,
  // again and right now, that they hold their email account: a fresh 6-digit
  // code (5 min, 3 attempts, single use). DEMONSTRATION ONLY: nothing is paid.
  router.post('/portal/fees/pay/start', requireSignedIn, requirePermission(permissions, 'fees'), async (req, res) => {
    const invoice = await portalService.unpaidInvoice(req.account.userId, req.body.reference);
    if (!invoice) return res.status(404).json({ error: 'No unpaid invoice with that reference.' });
    const account = await loadAccount(db, req.account.userId);
    await otp.issue(account, {
      purpose: 'payment',
      subject: 'Your CampusGate payment confirmation code',
      intro: `Someone (hopefully you) is confirming the demo payment for invoice ${invoice.reference}.`,
    });
    await audit.record('otp_sent', { userId: account.id, success: true, details: { purpose: 'payment', channel: otp.channel } }, auditContext(req));
    return res.json({ message: `We sent a 6-digit code to your email. Enter it to confirm the payment for ${invoice.reference}.` });
  });

  router.post('/portal/fees/pay/confirm', requireSignedIn, requirePermission(permissions, 'fees'), async (req, res) => {
    const { reference, code } = req.body;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return res.status(400).json({ error: 'Enter the 6-digit code.' });
    if (!(await portalService.unpaidInvoice(req.account.userId, reference))) {
      return res.status(404).json({ error: 'No unpaid invoice with that reference.' });
    }
    const outcome = await otp.verify(req.account.userId, code.trim());
    const ctx = auditContext(req);
    if (outcome !== 'ok') {
      await audit.record('otp_failed', { userId: req.account.userId, success: false, details: { purpose: 'payment', reason: outcome } }, ctx);
      return res.status(401).json({ error: outcome === 'wrong' ? 'That code is not right.' : 'The code has expired or was used up. Send a new one.' });
    }
    await audit.record('otp_verified', { userId: req.account.userId, success: true, details: { purpose: 'payment' } }, ctx);
    if (!(await portalService.markPaid(req.account.userId, reference))) return res.status(409).json({ error: 'This invoice is already paid.' });
    return res.json({ message: `Payment for ${reference} confirmed (demonstration only: no money was moved).` });
  });

  router.get('/portal/hostel', csrf.ensurePreSession, requireSignedIn, requirePermission(permissions, 'hostel'),
    async (req, res) => page('portal-hostel', 'Hostel', req, res, { halls: await portalService.hostels() }));

  router.get('/portal/registration', csrf.ensurePreSession, requireSignedIn, requirePermission(permissions, 'course_registration'),
    async (req, res) => page('portal-registration', 'Course registration', req, res, await portalService.courses(req.account.userId)));

  return router;
}

module.exports = { portalRouter };
